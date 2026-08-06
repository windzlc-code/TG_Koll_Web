from __future__ import annotations

import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageStat

from .contracts import VideoDependencyError, VideoTaskContext


TEMPLATE_LAYOUTS = {
    "template_b": "webinar_spine",
    "template_d": "story_column",
    "template_f": "closeup_sidebar",
}

MOTION_TEMPLATES = (
    "hero_push",
    "drift_right",
    "macro_push_arc",
    "hold_breathe",
    "orbit_sweep",
)


@dataclass(frozen=True)
class EcommerceSeedingCallbacks:
    """All effectful dependencies used by the dynamic seeding closure.

    Every callback is keyword-only from the caller's point of view.  This keeps
    the core independent from provider SDKs, ffmpeg discovery, databases, and
    queue implementations, while still making each boundary observable in tests.
    """

    generate_image: Callable[..., Any]
    inspect_image: Callable[..., Any]
    synthesize_tts: Callable[..., Any]
    probe_duration: Callable[..., float]
    encode_frames: Callable[..., Any]
    concat_videos: Callable[..., Any]
    mux_audio: Callable[..., Any]
    checkpoint_segment: Callable[..., Any] | None = None


def _number(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _integer(value: Any, default: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return int(default)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _resolve_file(value: Any, *, label: str) -> Path:
    path = Path(str(value or "")).expanduser().resolve()
    if not str(value or "").strip() or not path.exists() or not path.is_file():
        raise RuntimeError(f"{label} did not create a file: {path}")
    return path


def _callback_path(value: Any, *, fallback: Path, label: str) -> Path:
    candidate: Any = value
    if isinstance(value, Mapping):
        candidate = (
            value.get("path")
            or value.get("output_path")
            or value.get("image_path")
            or value.get("audio_path")
            or value.get("video_path")
            or fallback
        )
    elif value is None:
        candidate = fallback
    return _resolve_file(candidate, label=label)


def normalize_template(value: Any) -> str:
    template = _text(value).lower()
    if template not in TEMPLATE_LAYOUTS:
        supported = ", ".join(TEMPLATE_LAYOUTS)
        raise ValueError(f"ecommerce_seeding_template must be one of: {supported}")
    return template


def canvas_size(ratio: Any, resolution: Any) -> tuple[int, int]:
    ratio_text = _text(ratio) or "9:16"
    resolution_text = (_text(resolution) or "720p").lower()
    long_edge = 1920 if resolution_text in {"1080p", "2k"} else 1280
    short_edge = 1080 if resolution_text in {"1080p", "2k"} else 720
    if ratio_text == "16:9":
        return long_edge, short_edge
    if ratio_text == "1:1":
        return short_edge, short_edge
    return short_edge, long_edge


def _ease_out(value: float) -> float:
    x = max(0.0, min(float(value or 0.0), 1.0))
    return 1.0 - pow(1.0 - x, 3)


def _ease_in_out(value: float) -> float:
    x = max(0.0, min(float(value or 0.0), 1.0))
    if x < 0.5:
        return 4.0 * x * x * x
    return 1.0 - pow(-2.0 * x + 2.0, 3) / 2.0


def _progress(progress: float, start: float, duration: float) -> float:
    if duration <= 0:
        return 1.0 if progress >= start else 0.0
    return max(0.0, min((progress - start) / duration, 1.0))


def _copy_transition(progress: float, *, animate_in: bool, animate_out: bool) -> tuple[int, int]:
    """Original title/feature entrance and final-shot exit timing."""

    normalized = max(0.0, min(float(progress or 0.0), 1.0))
    entrance = _ease_out(_progress(normalized, 0.05, 0.2)) if animate_in else 1.0
    exit_progress = _progress(normalized, 0.86, 0.14) if animate_out else 0.0
    exit_visibility = 1.0 - _ease_in_out(exit_progress)
    visibility = max(0.0, min(entrance * exit_visibility, 1.0))
    entrance_offset = (1.0 - entrance) * 28.0
    exit_offset = _ease_out(exit_progress) * 22.0
    return int(round(255 * visibility)), int(round(entrance_offset - exit_offset))


def normalize_motion_template(value: Any, *, fallback_index: int = 0) -> str:
    motion = _text(value).lower()
    # The source renderer retired drift_left at the render boundary to avoid a
    # direction reversal when older cached shot plans are resumed.
    if motion == "drift_left":
        motion = "drift_right"
    if motion not in MOTION_TEMPLATES:
        motion = MOTION_TEMPLATES[fallback_index % len(MOTION_TEMPLATES)]
    return motion


def _motion_coordinates(progress: float, motion_template: str, *, animated: bool) -> tuple[float, float, float]:
    eased = _ease_in_out(progress) if animated else 1.0
    if not animated:
        return 1.0, 0.5, 0.5
    if motion_template == "drift_right":
        return 1.024 + 0.066 * eased, 0.10 + 0.76 * eased, 0.34 - 0.12 * eased
    if motion_template == "macro_push_arc":
        return 1.018 + 0.086 * eased, 0.13 + 0.52 * eased, 0.11 + 0.24 * eased
    if motion_template == "hold_breathe":
        return 1.028 + 0.032 * eased, 0.42 + 0.18 * eased, 0.31 + 0.12 * eased
    if motion_template == "orbit_sweep":
        return 1.022 + 0.070 * eased, 0.08 + 0.78 * eased, 0.20 + 0.28 * eased
    return 1.016 + 0.078 * eased, 0.38 + 0.22 * eased, 0.18 + 0.20 * eased


def _motion_canvas(
    scene: Image.Image,
    *,
    output_size: tuple[int, int],
    progress: float,
    motion_template: str,
    animated: bool,
) -> Image.Image:
    """Port of the source overscan + sub-pixel affine camera movement."""

    width, height = output_size
    overscan = 1.12
    fitted = ImageOps.fit(
        scene.convert("RGB"),
        (max(int(math.ceil(width * overscan)), width), max(int(math.ceil(height * overscan)), height)),
        method=Image.Resampling.LANCZOS,
    )
    zoom, x_ratio, y_ratio = _motion_coordinates(progress, motion_template, animated=animated)
    crop_width = fitted.width / max(zoom, 1.0)
    crop_height = fitted.height / max(zoom, 1.0)
    crop_x = max(0.0, min(x_ratio, 1.0)) * max(fitted.width - crop_width, 0.0)
    crop_y = max(0.0, min(y_ratio, 1.0)) * max(fitted.height - crop_height, 0.0)
    return fitted.transform(
        (width, height),
        Image.Transform.AFFINE,
        (crop_width / width, 0.0, crop_x, 0.0, crop_height / height, crop_y),
        resample=Image.Resampling.BICUBIC,
    ).convert("RGBA")


def _load_font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), max(int(size), 10))
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    normalized = " ".join(_text(text).split())
    if not normalized:
        return []
    tokens = normalized.split(" ") if " " in normalized else list(normalized)
    separator = " " if " " in normalized else ""
    lines: list[str] = []
    current = ""
    for token in tokens:
        candidate = token if not current else f"{current}{separator}{token}"
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = token
    if current:
        lines.append(current)
    return lines


def _scene_palette(scene: Image.Image) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    sample = ImageOps.fit(scene.convert("RGB"), (32, 32), method=Image.Resampling.BILINEAR)
    colors = sample.quantize(colors=5).convert("RGB").getcolors(32 * 32) or []
    ranked = [color for _count, color in sorted(colors, reverse=True)]
    base = ranked[0] if ranked else (235, 239, 243)
    accent = ranked[-1] if len(ranked) > 1 else (47, 143, 222)
    tint = tuple(min(255, int(channel * 0.18 + 215)) for channel in base)
    if max(accent) - min(accent) < 24:
        accent = (47, 143, 222)
    return tint, accent


def _draw_scrim(canvas: Image.Image, layout_variant: str) -> None:
    width, height = canvas.size
    scrim = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(scrim)
    if layout_variant in {"story_column", "closeup_sidebar"}:
        for x in range(width):
            ratio = x / max(width - 1, 1)
            alpha = int(148 * (1.0 - 0.94 * ratio)) if layout_variant == "story_column" else int(142 * (0.08 + 0.92 * ratio))
            draw.line((x, 0, x, height), fill=(7, 14, 24, max(alpha, 5)))
    else:
        for y in range(height):
            top = max(0.0, 1.0 - y / max(height * 0.43, 1.0))
            bottom = max(0.0, (y - height * 0.48) / max(height * 0.52, 1.0))
            alpha = int(min(116.0, 72.0 * top + 106.0 * bottom))
            draw.line((0, y, width, y), fill=(7, 14, 24, alpha))
    canvas.alpha_composite(scrim)


def _title_geometry(output_size: tuple[int, int], layout_variant: str) -> tuple[tuple[int, int, int, int], str]:
    width, height = output_size
    portrait = height / max(width, 1) >= 1.45
    if layout_variant == "webinar_spine":
        left = 0.11 if portrait else 0.15
        return (int(width * left), int(height * 0.085), int(width * (1.0 - left)), int(height * (0.315 if portrait else 0.375))), "center"
    if layout_variant == "story_column":
        return (int(width * 0.05), int(height * 0.12), int(width * (0.89 if portrait else 0.66)), int(height * (0.32 if portrait else 0.38))), "left"
    return (int(width * (0.11 if portrait else 0.36)), int(height * 0.12), int(width * (0.95 if portrait else 0.95)), int(height * (0.32 if portrait else 0.38))), "right"


def _draw_dynamic_overlay(
    canvas: Image.Image,
    *,
    layout_variant: str,
    title: str,
    product_name: str,
    bullets: Sequence[str],
    progress: float,
    animate_in: bool,
    animate_out: bool,
    scene_palette: tuple[tuple[int, int, int], tuple[int, int, int]],
) -> None:
    width, height = canvas.size
    panel_tint, accent = scene_palette
    alpha, offset = _copy_transition(progress, animate_in=animate_in, animate_out=animate_out)
    panel_box, align = _title_geometry(canvas.size, layout_variant)
    panel_box = (panel_box[0], panel_box[1] + offset, panel_box[2], panel_box[3] + offset)
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    radius = max(int(min(width, height) * 0.025), 14)
    draw.rounded_rectangle(panel_box, radius=radius, fill=(*panel_tint, min(alpha, 205)), outline=(*accent, min(alpha, 130)), width=2)

    title_font = _load_font(max(int(width * 0.052), 30), bold=True)
    product_font = _load_font(max(int(width * 0.029), 18), bold=False)
    feature_font = _load_font(max(int(width * 0.031), 20), bold=True)
    padding = max(int(width * 0.035), 20)
    text_width = max(panel_box[2] - panel_box[0] - padding * 2, 40)
    title_lines = _wrap(draw, title, title_font, text_width)[:2]
    line_height = max(int(getattr(title_font, "size", 30) * 1.12), 28)
    y = panel_box[1] + padding
    for line in title_lines:
        line_width = draw.textbbox((0, 0), line, font=title_font)[2]
        x = panel_box[0] + padding
        if align == "center":
            x = panel_box[0] + (panel_box[2] - panel_box[0] - line_width) // 2
        elif align == "right":
            x = panel_box[2] - padding - line_width
        draw.text((x, y), line, font=title_font, fill=(22, 36, 53, alpha))
        y += line_height
    if product_name:
        label = _text(product_name)[:48]
        label_width = draw.textbbox((0, 0), label, font=product_font)[2]
        x = panel_box[0] + padding if align != "right" else panel_box[2] - padding - label_width
        draw.text((x, min(y + 4, panel_box[3] - 32)), label, font=product_font, fill=(72, 86, 101, min(alpha, 230)))

    feature_top = int(height * 0.45)
    feature_width = int(width * (0.56 if width > height else 0.80))
    feature_x = int(width * 0.07) if layout_variant != "closeup_sidebar" or width <= height else int(width * 0.38)
    for index, bullet in enumerate([_text(item) for item in bullets if _text(item)][:3]):
        local = _ease_out(_progress(progress, 0.20 + index * 0.08, 0.18)) if animate_in else 1.0
        item_alpha = int(alpha * local)
        item_y = feature_top + index * max(int(height * 0.09), 62) + int((1.0 - local) * 22) + offset
        box = (feature_x, item_y, min(feature_x + feature_width, width - 20), item_y + max(int(height * 0.065), 48))
        draw.rounded_rectangle(box, radius=max((box[3] - box[1]) // 2, 12), fill=(12, 24, 38, min(item_alpha, 164)), outline=(*accent, min(item_alpha, 180)), width=2)
        marker = f"{index + 1:02d}"
        draw.text((box[0] + 18, box[1] + 10), marker, font=feature_font, fill=(*accent, item_alpha))
        copy_x = box[0] + max(int(width * 0.09), 64)
        draw.text((copy_x, box[1] + 10), bullet[:36], font=feature_font, fill=(255, 255, 255, item_alpha))
    canvas.alpha_composite(overlay)


def draw_storyboard_frame(
    *,
    scene_image: Image.Image,
    output_size: tuple[int, int],
    title: str,
    product_name: str,
    bullets: Sequence[str],
    motion_template: str,
    layout_variant: str,
    progress: float,
    copy_animate_in: bool = True,
    copy_animate_out: bool = False,
) -> Image.Image:
    motion = normalize_motion_template(motion_template)
    canvas = _motion_canvas(
        scene_image,
        output_size=output_size,
        progress=max(0.0, min(progress, 1.0)),
        motion_template=motion,
        animated=True,
    )
    _draw_scrim(canvas, layout_variant)
    _draw_dynamic_overlay(
        canvas,
        layout_variant=layout_variant,
        title=title,
        product_name=product_name,
        bullets=bullets,
        progress=progress,
        animate_in=copy_animate_in,
        animate_out=copy_animate_out,
        scene_palette=_scene_palette(scene_image),
    )
    return canvas.convert("RGB")


def render_storyboard_frames(
    *,
    scene_image_path: Path,
    frame_dir: Path,
    duration_seconds: float,
    output_size: tuple[int, int],
    title: str,
    product_name: str,
    bullets: Sequence[str],
    motion_template: str,
    layout_variant: str,
    context: VideoTaskContext,
    fps: int = 25,
    copy_animate_in: bool = True,
    copy_animate_out: bool = False,
) -> dict[str, Any]:
    """Render a true frame sequence; no static image loop is used."""

    context.check_cancelled()
    scene_path = _resolve_file(scene_image_path, label="scene image")
    frame_dir.mkdir(parents=True, exist_ok=True)
    duration = max(_number(duration_seconds, 1.0), 1.0)
    frame_rate = max(_integer(fps, 25), 1)
    total_frames = max(int(round(duration * frame_rate)), 1)
    motion = normalize_motion_template(motion_template)
    with Image.open(scene_path) as source:
        scene = source.convert("RGB")
    for frame_index in range(total_frames):
        context.check_cancelled()
        progress = frame_index / max(total_frames - 1, 1)
        frame = draw_storyboard_frame(
            scene_image=scene,
            output_size=output_size,
            title=title,
            product_name=product_name,
            bullets=bullets,
            motion_template=motion,
            layout_variant=layout_variant,
            progress=progress,
            copy_animate_in=copy_animate_in,
            copy_animate_out=copy_animate_out,
        )
        frame.save(frame_dir / f"frame_{frame_index + 1:05d}.png", format="PNG", optimize=True)
    return {
        "frame_dir": str(frame_dir.resolve()),
        "frame_pattern": str((frame_dir / "frame_%05d.png").resolve()),
        "frame_count": total_frames,
        "fps": frame_rate,
        "duration_seconds": duration,
        "motion_template": motion,
        "layout_variant": layout_variant,
    }


def render_local_ecommerce_storyboard_video(
    *,
    scene_image_path: Path,
    output_path: Path,
    duration_seconds: float,
    canvas_size: tuple[int, int],
    motion_template: str,
    storyboard_template: Any,
    encode_frames: Callable[..., Any],
    context: VideoTaskContext,
    segment_index: int = 1,
    segment_count: int = 1,
    shot_index: int = 1,
    shot_count: int = 1,
    prompt: str = "",
    dialogue: str = "",
    product_name: str = "",
    product_details: str = "",
    visual_carrier: str = "",
    visual_carrier_reason: str = "",
    feature_hints: Sequence[str] | None = None,
    headline_hint: str = "",
    copy_animate_in: bool = True,
    copy_animate_out: bool = False,
    include_static_dialogue: bool = True,
    fps: int = 25,
    payload: dict[str, Any] | None = None,
    keep_frames: bool = False,
) -> Path:
    """Source-shaped dynamic storyboard renderer with injected encoding.

    The original closure writes a PNG sequence and then invokes ffmpeg.  This
    port keeps the sequence renderer local and moves only the ffmpeg boundary
    behind ``encode_frames``.
    """

    template_value = _text(storyboard_template).lower()
    layout_variant = TEMPLATE_LAYOUTS.get(template_value, template_value)
    if layout_variant not in set(TEMPLATE_LAYOUTS.values()):
        raise ValueError("storyboard_template must be template_b, template_d, or template_f")
    points = [_text(item) for item in (feature_hints or []) if _text(item)]
    if not points:
        fallback = product_details or (dialogue if include_static_dialogue else "")
        points = [item.strip() for item in _text(fallback).replace("；", ";").replace("。", ";").split(";") if item.strip()]
    points = points[:3] or ["Real-life use", "Product detail", "Recommendation"]
    frame_dir = output_path.parent / f"{output_path.stem}_frames"
    if frame_dir.exists():
        shutil.rmtree(frame_dir)
    frame_info = render_storyboard_frames(
        scene_image_path=scene_image_path,
        frame_dir=frame_dir,
        duration_seconds=duration_seconds,
        output_size=canvas_size,
        title=_text(headline_hint or prompt or product_name),
        product_name=_text(product_name),
        bullets=points,
        motion_template=motion_template,
        layout_variant=layout_variant,
        context=context,
        fps=fps,
        copy_animate_in=copy_animate_in,
        copy_animate_out=copy_animate_out,
    )
    try:
        result = encode_frames(
            frame_pattern=Path(frame_info["frame_pattern"]),
            frame_dir=frame_dir,
            frame_count=frame_info["frame_count"],
            fps=frame_info["fps"],
            duration_seconds=duration_seconds,
            canvas_size=canvas_size,
            motion_template=frame_info["motion_template"],
            layout_variant=layout_variant,
            segment_index=segment_index,
            segment_count=segment_count,
            shot_index=shot_index,
            shot_count=shot_count,
            visual_carrier=visual_carrier,
            visual_carrier_reason=visual_carrier_reason,
            payload=payload or {},
            context=context,
            output_path=output_path,
        )
        return _callback_path(result, fallback=output_path, label="dynamic storyboard encoder")
    finally:
        if not keep_frames and frame_dir.exists():
            shutil.rmtree(frame_dir)


def _quality_issues(report: Any) -> list[dict[str, Any]]:
    if not isinstance(report, Mapping):
        return []
    values = report.get("issues")
    return [dict(item) for item in values if isinstance(item, Mapping)] if isinstance(values, Sequence) else []


def _quality_passed(report: Any) -> bool:
    if isinstance(report, bool):
        return report
    if not isinstance(report, Mapping):
        return bool(report)
    if "passed" in report:
        return bool(report.get("passed"))
    status = _text(report.get("status")).lower()
    if status in {"passed", "pass", "success", "ok", "warning"}:
        return True
    if status in {"rejected", "reject", "failed", "failure", "error", "critical"}:
        return False
    return not any(_text(item.get("severity")).lower() in {"high", "critical"} for item in _quality_issues(report))


def _quality_retry_suffix(report: Any) -> str:
    codes = {_text(item.get("code")) for item in _quality_issues(report)}
    notes = [
        "Retry requirement: render one clean photographic scene with no readable text, subtitles, poster layout, watermark, or UI overlay."
    ]
    if "generated_text_overlay" in codes:
        notes.append("Avoid a front-facing readable package label; show natural handling or use in context.")
    if {"image_nearly_blank", "image_luma_extreme"} & codes:
        notes.append("Increase subject clarity, material detail, environmental context, and tonal contrast.")
    messages = [_text(item.get("message")) for item in _quality_issues(report) if _text(item.get("message"))]
    if messages:
        notes.append("Previous QA: " + "; ".join(messages[:3]))
    return "\n".join(notes)


def inspect_ecommerce_seeding_generated_frame(*, image_path: str | Path, **_values: Any) -> dict[str, Any]:
    """Source-compatible local file QA used before accepting a generated shot."""

    path = Path(image_path).expanduser().resolve()
    issues: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {"path": str(path)}
    if not path.exists() or not path.is_file():
        issues.append({"code": "output_missing", "severity": "high", "message": "种草分镜图文件不存在"})
    else:
        metrics["file_size"] = int(path.stat().st_size)
        if metrics["file_size"] < 1024:
            issues.append({"code": "output_too_small", "severity": "high", "message": "种草分镜图文件过小，可能生成失败"})
        try:
            with Image.open(path) as image:
                rgb = image.convert("RGB")
                gray = rgb.convert("L")
                gray_stat = ImageStat.Stat(gray)
                rgb_stat = ImageStat.Stat(rgb)
                metrics.update(
                    {
                        "width": int(rgb.width),
                        "height": int(rgb.height),
                        "mean_luma": float(gray_stat.mean[0] if gray_stat.mean else 0.0),
                        "std_luma": float(gray_stat.stddev[0] if gray_stat.stddev else 0.0),
                        "mean_rgb": [float(item) for item in (rgb_stat.mean or [0.0, 0.0, 0.0])[:3]],
                    }
                )
            if metrics["width"] < 256 or metrics["height"] < 256:
                issues.append({"code": "image_resolution_low", "severity": "medium", "message": "种草分镜图分辨率偏低"})
            if metrics["mean_luma"] < 8 or metrics["mean_luma"] > 247:
                severity = "high" if metrics["std_luma"] < 8 else "medium"
                issues.append({"code": "image_luma_extreme", "severity": severity, "message": "种草分镜图整体亮度接近极端值"})
            if metrics["std_luma"] < 4:
                issues.append({"code": "image_nearly_blank", "severity": "high", "message": "种草分镜图画面变化很少，疑似空白图"})
        except Exception as exc:
            issues.append({"code": "image_unreadable", "severity": "high", "message": f"种草分镜图无法读取：{exc}"})
    rejected = any(str(item.get("severity") or "").lower() in {"high", "critical"} for item in issues)
    return {"passed": not rejected, "status": "rejected" if rejected else ("warning" if issues else "passed"), "issues": issues, "metrics": metrics}


def generate_scene_with_quality_gate(
    *,
    task_id: str,
    payload: dict[str, Any],
    segment: dict[str, Any],
    shot: dict[str, Any],
    segment_index: int,
    shot_index: int,
    workdir: Path,
    callbacks: EcommerceSeedingCallbacks,
    context: VideoTaskContext,
) -> dict[str, Any]:
    """Generate and redraw one shot until source-compatible QA passes."""

    max_attempts = min(max(_integer(payload.get("local_seeding_image_qa_max_attempts"), 2), 1), 4)
    base_prompt = _text(shot.get("prompt") or segment.get("prompt") or payload.get("prompt"))
    last_report: Any = {"status": "rejected", "issues": []}
    attempts: list[dict[str, Any]] = []
    for attempt in range(1, max_attempts + 1):
        context.check_cancelled()
        retry = _quality_retry_suffix(last_report) if attempt > 1 else ""
        prompt = base_prompt if not retry else f"{base_prompt}\n{retry}"
        output_path = workdir / f"scene_{segment_index:03d}_{shot_index:03d}_attempt_{attempt}.png"
        generated = callbacks.generate_image(
            task_id=task_id if attempt == 1 else f"{task_id}_qa_retry{attempt}",
            payload=payload,
            segment=segment,
            shot=shot,
            segment_index=segment_index,
            shot_index=shot_index,
            attempt=attempt,
            prompt=prompt,
            output_path=output_path,
        )
        context.check_cancelled()
        image_path = _callback_path(generated, fallback=output_path, label="image generator")
        report = callbacks.inspect_image(
            image_path=image_path,
            payload=payload,
            segment=segment,
            shot=shot,
            segment_index=segment_index,
            shot_index=shot_index,
            attempt=attempt,
        )
        context.check_cancelled()
        normalized_report = dict(report) if isinstance(report, Mapping) else {"passed": bool(report)}
        attempts.append(
            {
                "attempt": attempt,
                "image_path": str(image_path),
                "prompt": prompt,
                "report": normalized_report,
                "provider_result": dict(generated) if isinstance(generated, Mapping) else generated,
            }
        )
        if _quality_passed(report):
            return {"image_path": image_path, "qa_report": normalized_report, "attempts": attempts}
        last_report = report
    messages = [_text(item.get("message") or item.get("code")) for item in _quality_issues(last_report)]
    detail = "; ".join(item for item in messages if item) or "scene image QA rejected"
    raise RuntimeError(f"scene image QA failed after {max_attempts} attempts: {detail}")


def _completed_map(values: Any) -> dict[int, dict[str, Any]]:
    if isinstance(values, Mapping):
        items: Iterable[tuple[Any, Any]] = values.items()
    elif isinstance(values, Sequence) and not isinstance(values, (str, bytes, bytearray)):
        items = ((item.get("index"), item) for item in values if isinstance(item, Mapping))
    else:
        items = ()
    completed: dict[int, dict[str, Any]] = {}
    for raw_index, raw_record in items:
        if not isinstance(raw_record, Mapping):
            continue
        index = _integer(raw_index, 0)
        path_value = raw_record.get("path") or raw_record.get("video_path")
        if index > 0 and _text(path_value):
            path = Path(str(path_value)).expanduser().resolve()
            if path.exists() and path.is_file():
                completed[index] = {**dict(raw_record), "index": index, "path": str(path)}
    return completed


def prepare_ecommerce_seeding_segment_audio_paths(
    *,
    payload: dict[str, Any],
    segments: Sequence[dict[str, Any]],
    workdir: Path,
    callbacks: EcommerceSeedingCallbacks,
    context: VideoTaskContext,
    completed_segments: Mapping[int, dict[str, Any]] | None = None,
    reference_audio_paths: Sequence[Path] = (),
) -> list[Path | None]:
    """Port of per-segment TTS preparation, with resumable provider boundaries."""

    reusable = payload.get("ecommerce_seeding_reuse_audio_paths")
    reusable_values = list(reusable) if isinstance(reusable, Sequence) and not isinstance(reusable, (str, bytes, bytearray)) else []
    reusable_valid = len(reusable_values) == len(segments)
    reusable_paths: list[Path | None] = []
    if reusable_valid:
        for value in reusable_values:
            if not _text(value):
                reusable_paths.append(None)
                continue
            path = Path(str(value)).expanduser().resolve()
            if not path.exists() or not path.is_file():
                reusable_valid = False
                break
            reusable_paths.append(path)
    completed = completed_segments or {}
    prepared: list[Path | None] = []
    for offset, segment in enumerate(segments, start=1):
        context.check_cancelled()
        index = _integer(segment.get("index"), offset)
        existing = completed.get(index)
        existing_audio = Path(_text(existing.get("audio_path"))).expanduser().resolve() if existing and _text(existing.get("audio_path")) else None
        if existing is not None:
            prepared.append(existing_audio if existing_audio and existing_audio.exists() else None)
            continue
        if reusable_valid:
            prepared.append(reusable_paths[offset - 1])
            continue
        dialogue = _text(segment.get("dialogue") or segment.get("speech_text") or segment.get("copy_text"))
        if not dialogue:
            prepared.append(None)
            continue
        output_path = workdir / f"ecommerce_voice_audio_segment_{index:03d}.mp3"
        result = callbacks.synthesize_tts(
            text=dialogue,
            output_path=output_path,
            segment=segment,
            segment_index=index,
            payload=payload,
            reference_audio_paths=[str(path.resolve()) for path in reference_audio_paths],
        )
        context.check_cancelled()
        prepared.append(_callback_path(result, fallback=output_path, label="segment TTS"))
    return prepared


def _normalize_segments(payload: Mapping[str, Any], segments: Sequence[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    source = segments if segments is not None else payload.get("segments") or payload.get("storyboard") or payload.get("prompt_segments")
    if not isinstance(source, Sequence) or isinstance(source, (str, bytes, bytearray)):
        source = []
    normalized: list[dict[str, Any]] = []
    for offset, raw in enumerate(source, start=1):
        if not isinstance(raw, Mapping):
            continue
        segment = dict(raw)
        segment["index"] = _integer(segment.get("index"), offset)
        segment["duration_seconds"] = max(_number(segment.get("duration_seconds") or segment.get("duration"), 1.0), 1.0)
        segment["prompt"] = _text(segment.get("prompt") or segment.get("visual_prompt") or payload.get("prompt"))
        segment["dialogue"] = _text(segment.get("dialogue") or segment.get("speech_text") or segment.get("copy_text"))
        normalized.append(segment)
    if not normalized:
        raise ValueError("ecommerce seeding dynamic renderer requires at least one segment")
    indexes = [item["index"] for item in normalized]
    if len(indexes) != len(set(indexes)) or any(index <= 0 for index in indexes):
        raise ValueError("ecommerce seeding segment indexes must be unique positive integers")
    return normalized


def _shot_plan(segment: Mapping[str, Any], *, target_duration: float) -> list[dict[str, Any]]:
    raw_shots = segment.get("shots") or segment.get("shot_plan")
    shots = [dict(item) for item in raw_shots if isinstance(item, Mapping)] if isinstance(raw_shots, Sequence) else []
    if not shots:
        shots = [{"prompt": segment.get("prompt"), "duration_seconds": target_duration}]
    weights = [max(_number(item.get("duration_seconds") or item.get("duration"), 1.0), 0.1) for item in shots]
    scale = target_duration / max(sum(weights), 0.1)
    durations = [weight * scale for weight in weights]
    # Keep the sum stable despite float formatting at callback boundaries.
    durations[-1] += target_duration - sum(durations)
    return [
        {
            **shot,
            "index": offset,
            "prompt": _text(shot.get("prompt") or segment.get("prompt")),
            "duration_seconds": max(durations[offset - 1], 0.1),
        }
        for offset, shot in enumerate(shots, start=1)
    ]


def _selling_points(payload: Mapping[str, Any], segment: Mapping[str, Any], shot: Mapping[str, Any]) -> list[str]:
    for value in (shot.get("selling_points"), segment.get("selling_points"), payload.get("selling_points"), payload.get("feature_hints")):
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            points = [_text(item) for item in value if _text(item)]
            if points:
                return points[:3]
    fallback = _text(segment.get("product_details") or payload.get("product_details") or segment.get("dialogue"))
    points = [item.strip() for item in fallback.replace("；", ";").replace("。", ";").split(";") if item.strip()]
    return points[:3] or ["Real-life use", "Product detail", "Recommendation"]


def _invoke_media_callback(callback: Callable[..., Any], *, fallback: Path, label: str, **kwargs: Any) -> Path:
    result = callback(output_path=fallback, **kwargs)
    return _callback_path(result, fallback=fallback, label=label)


def render_ecommerce_seeding_dynamic(
    *,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
    workdir: Path,
    callbacks: EcommerceSeedingCallbacks,
    segments: Sequence[Mapping[str, Any]] | None = None,
    completed_segments: Mapping[int, dict[str, Any]] | Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Render the complete dynamic ecommerce-seeding chain.

    The closure preserves the source sequence: per-segment TTS, audio-driven
    duration, shot image QA/redraw, frame-by-frame motion/copy rendering, shot
    concat, segment audio replacement, resumable checkpoint, and final concat.
    """

    required = {
        "generate_image": callbacks.generate_image,
        "inspect_image": callbacks.inspect_image,
        "synthesize_tts": callbacks.synthesize_tts,
        "probe_duration": callbacks.probe_duration,
        "encode_frames": callbacks.encode_frames,
        "concat_videos": callbacks.concat_videos,
        "mux_audio": callbacks.mux_audio,
    }
    missing = [name for name, callback in required.items() if not callable(callback)]
    if missing:
        raise VideoDependencyError("missing ecommerce seeding callbacks: " + ", ".join(missing))

    context.check_cancelled()
    workdir = Path(workdir).expanduser().resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    normalized_segments = _normalize_segments(payload, segments)
    completed = _completed_map(completed_segments if completed_segments is not None else payload.get("completed_segments"))
    template = normalize_template(payload.get("ecommerce_seeding_template"))
    layout_variant = TEMPLATE_LAYOUTS[template]
    ratio = _text(payload.get("ratio")) or "9:16"
    resolution = _text(payload.get("resolution")) or "720p"
    output_size = canvas_size(ratio, resolution)
    fps = max(_integer(payload.get("fps"), 25), 1)
    keep_frames = bool(payload.get("keep_render_frames"))
    confirmed_values = payload.get("ecommerce_seeding_confirmed_image_paths")
    if confirmed_values is not None and (
        not isinstance(confirmed_values, Sequence) or isinstance(confirmed_values, (str, bytes, bytearray))
    ):
        raise ValueError("ecommerce_seeding_confirmed_image_paths must be a list")
    confirmed_paths = [
        _resolve_file(value, label="confirmed ecommerce seeding image")
        for value in (confirmed_values or [])
        if _text(value)
    ]
    if confirmed_paths and len(confirmed_paths) != len(normalized_segments):
        raise ValueError("confirmed ecommerce seeding image count must match storyboard segment count")
    reference_audio_values = payload.get("audio_local_paths") or payload.get("voice_audio_local_paths") or []
    if isinstance(reference_audio_values, Sequence) and not isinstance(reference_audio_values, (str, bytes, bytearray)):
        reference_audio_paths = [Path(str(item)).expanduser().resolve() for item in reference_audio_values if _text(item)]
    else:
        reference_audio_paths = []
    single_audio_value = _text(payload.get("audio_local_path") or payload.get("voice_audio_local_path"))
    if single_audio_value:
        single_audio_path = Path(single_audio_value).expanduser().resolve()
        if single_audio_path not in reference_audio_paths:
            reference_audio_paths.insert(0, single_audio_path)
    for audio in reference_audio_paths:
        _resolve_file(audio, label="reference audio")

    context.progress(stage="seeding_audio", status="running", message="Preparing per-segment narration", progress=5)
    audio_paths = prepare_ecommerce_seeding_segment_audio_paths(
        payload=payload,
        segments=normalized_segments,
        workdir=workdir,
        callbacks=callbacks,
        context=context,
        completed_segments=completed,
        reference_audio_paths=reference_audio_paths,
    )

    output_records: list[dict[str, Any]] = []
    completed_output: list[dict[str, Any]] = []
    segment_video_paths: list[Path] = []
    generated_audio_paths: list[str] = []
    generated_image_paths: list[str] = []
    shot_video_paths: list[str] = []
    motion_templates: list[str] = []
    qa_records: list[dict[str, Any]] = []
    product_name = _text(payload.get("product_name") or payload.get("product_project_name") or payload.get("project_name"))

    for offset, segment in enumerate(normalized_segments, start=1):
        context.check_cancelled()
        index = _integer(segment.get("index"), offset)
        existing = completed.get(index)
        if existing is not None:
            existing_path = _resolve_file(existing.get("path"), label=f"completed segment {index}")
            checkpoint = {**existing, "index": index, "path": str(existing_path), "skipped": True}
            completed_output.append(checkpoint)
            output_records.append(checkpoint)
            segment_video_paths.append(existing_path)
            generated_audio_paths.append(_text(existing.get("audio_path")))
            continue

        requested_duration = max(_number(segment.get("duration_seconds"), 1.0), 1.0)
        audio_path = audio_paths[offset - 1]
        audio_duration = max(_number(callbacks.probe_duration(path=audio_path, kind="audio", segment_index=index), 0.0), 0.0) if audio_path else 0.0
        render_duration = max(requested_duration, audio_duration, 1.0)
        generated_audio_paths.append(str(audio_path) if audio_path else "")
        shots = _shot_plan(segment, target_duration=render_duration)
        shot_paths: list[Path] = []
        shot_records: list[dict[str, Any]] = []
        context.progress(
            stage="seeding_segment",
            status="running",
            message=f"Rendering ecommerce seeding segment {offset}/{len(normalized_segments)}",
            progress=round(10 + 78 * (offset - 1) / max(len(normalized_segments), 1), 2),
        )
        for shot_offset, shot in enumerate(shots, start=1):
            context.check_cancelled()
            if confirmed_paths:
                confirmed_image = confirmed_paths[offset - 1]
                generated = {
                    "image_path": confirmed_image,
                    "qa_report": {"status": "confirmed", "passed": True, "issues": []},
                    "attempts": [{"attempt": 0, "image_path": str(confirmed_image), "source": "confirmed"}],
                }
            else:
                generated = generate_scene_with_quality_gate(
                    task_id=f"{task_id}_segment_{index}_shot_{shot_offset}",
                    payload=payload,
                    segment=segment,
                    shot=shot,
                    segment_index=index,
                    shot_index=shot_offset,
                    workdir=workdir,
                    callbacks=callbacks,
                    context=context,
                )
            image_path = Path(generated["image_path"]).resolve()
            generated_image_paths.append(str(image_path))
            qa_records.append({"segment_index": index, "shot_index": shot_offset, **generated})
            configured_motion = shot.get("motion_template")
            reference_audit = payload.get("ecommerce_reference_video_audit") if isinstance(payload.get("ecommerce_reference_video_audit"), Mapping) else {}
            if not _text(configured_motion) and _text(reference_audit.get("pace_hint")) == "fast_cut":
                configured_motion = ("hero_push", "drift_right", "macro_push_arc", "orbit_sweep")[
                    len(motion_templates) % 4
                ]
            motion = normalize_motion_template(configured_motion, fallback_index=len(motion_templates))
            motion_templates.append(motion)
            frame_dir = workdir / f"segment_{index:03d}_shot_{shot_offset:03d}_frames"
            if frame_dir.exists():
                shutil.rmtree(frame_dir)
            frame_info = render_storyboard_frames(
                scene_image_path=image_path,
                frame_dir=frame_dir,
                duration_seconds=shot["duration_seconds"],
                output_size=output_size,
                title=_text(shot.get("title") or segment.get("title") or payload.get("seeding_title") or segment.get("prompt") or product_name),
                product_name=product_name,
                bullets=_selling_points(payload, segment, shot),
                motion_template=motion,
                layout_variant=layout_variant,
                context=context,
                fps=fps,
                copy_animate_in=bool(shot.get("copy_animate_in", True)),
                copy_animate_out=bool(shot.get("copy_animate_out", shot_offset == len(shots))),
            )
            shot_path = workdir / f"ecommerce_local_seeding_segment_{index:03d}_shot_{shot_offset:03d}.mp4"
            try:
                encoded = _invoke_media_callback(
                    callbacks.encode_frames,
                    fallback=shot_path,
                    label="dynamic frame encoder",
                    frame_pattern=Path(frame_info["frame_pattern"]),
                    frame_dir=frame_dir,
                    frame_count=frame_info["frame_count"],
                    fps=fps,
                    duration_seconds=shot["duration_seconds"],
                    canvas_size=output_size,
                    motion_template=motion,
                    layout_variant=layout_variant,
                    segment_index=index,
                    shot_index=shot_offset,
                    payload=payload,
                    context=context,
                )
            finally:
                if not keep_frames and frame_dir.exists():
                    shutil.rmtree(frame_dir)
            context.check_cancelled()
            shot_paths.append(encoded)
            shot_video_paths.append(str(encoded))
            shot_records.append(
                {
                    **shot,
                    "image_path": str(image_path),
                    "video_path": str(encoded),
                    "motion_template": motion,
                    "qa_attempts": len(generated["attempts"]),
                    "frame_count": frame_info["frame_count"],
                }
            )

        base_path = workdir / f"ecommerce_local_seeding_segment_{index:03d}_base.mp4"
        base_video = _invoke_media_callback(
            callbacks.concat_videos,
            fallback=base_path,
            label="shot concat",
            segment_paths=shot_paths,
            kind="shots",
            segment_index=index,
            payload=payload,
            context=context,
        )
        segment_path = workdir / f"ecommerce_local_seeding_segment_{index:03d}.mp4"
        if audio_path is not None:
            segment_video = _invoke_media_callback(
                callbacks.mux_audio,
                fallback=segment_path,
                label="segment audio mux",
                video_path=base_video,
                audio_path=audio_path,
                target_duration_seconds=render_duration,
                pad_audio_to_duration=audio_duration < render_duration,
                trim_to_duration=True,
                segment_index=index,
                payload=payload,
                context=context,
            )
        else:
            shutil.copy2(base_video, segment_path)
            segment_video = segment_path.resolve()
        context.check_cancelled()
        actual_duration = max(
            _number(callbacks.probe_duration(path=segment_video, kind="video", segment_index=index), render_duration),
            0.0,
        )
        checkpoint = {
            "index": index,
            "path": str(segment_video),
            "audio_path": str(audio_path) if audio_path else "",
            "requested_duration_seconds": requested_duration,
            "audio_duration_seconds": audio_duration,
            "duration_seconds": actual_duration or render_duration,
            "shots": shot_records,
            "skipped": False,
        }
        if callbacks.checkpoint_segment is not None:
            callbacks.checkpoint_segment(task_id=task_id, payload=payload, segment=checkpoint, completed_segment=checkpoint)
        completed_output.append(checkpoint)
        output_records.append(checkpoint)
        segment_video_paths.append(segment_video)

    context.check_cancelled()
    final_path = workdir / "ecommerce_short_video_dynamic.mp4"
    final_video = _invoke_media_callback(
        callbacks.concat_videos,
        fallback=final_path,
        label="final segment concat",
        segment_paths=segment_video_paths,
        kind="segments",
        payload=payload,
        context=context,
    )
    context.check_cancelled()
    context.progress(stage="seeding_finalize", status="success", message="Dynamic ecommerce seeding video rendered", progress=100)
    return {
        "ok": True,
        "message": "Dynamic ecommerce seeding video rendered",
        "video_path": str(final_video),
        "download_path": str(final_video),
        "segments": output_records,
        "completed_segments": completed_output,
        "generated_audio_paths": generated_audio_paths,
        "generated_scene_image_paths": generated_image_paths,
        "shot_video_paths": shot_video_paths,
        "motion_templates": motion_templates,
        "image_generation_qa": qa_records,
        "template": template,
        "layout_variant": layout_variant,
        "ratio": ratio,
        "resolution": resolution,
        "canvas_size": output_size,
        "local_renderer": "pillow_storyboard_dynamic_v1",
    }


# Explicit aliases retain the source function vocabulary for adapters migrating
# one closure at a time without importing private functions from webapp.server.
prepare_segment_audio_paths = prepare_ecommerce_seeding_segment_audio_paths
run_local_ecommerce_seeding_video = render_ecommerce_seeding_dynamic


__all__ = [
    "EcommerceSeedingCallbacks",
    "MOTION_TEMPLATES",
    "TEMPLATE_LAYOUTS",
    "canvas_size",
    "draw_storyboard_frame",
    "generate_scene_with_quality_gate",
    "normalize_motion_template",
    "normalize_template",
    "prepare_ecommerce_seeding_segment_audio_paths",
    "prepare_segment_audio_paths",
    "render_ecommerce_seeding_dynamic",
    "inspect_ecommerce_seeding_generated_frame",
    "render_local_ecommerce_storyboard_video",
    "render_storyboard_frames",
    "run_local_ecommerce_seeding_video",
]
