from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageStat

from .contracts import VideoTaskCancelled, VideoTaskContext


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "y"}:
        return True
    if text in {"0", "false", "no", "off", "n"}:
        return False
    return bool(default)


def _resolve_ffmpeg_exe(payload: dict[str, Any] | None = None) -> str:
    configured = str((payload or {}).get("ffmpeg_path") or "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.exists() and configured_path.is_file():
            return str(configured_path.resolve())
        resolved = shutil.which(configured)
        if resolved:
            return resolved
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise RuntimeError("缺少 ffmpeg，无法生成数字人视频封面") from exc


def _extract_video_frame_at(
    video_path: Path,
    output_path: Path,
    *,
    timestamp_seconds: float = 0.5,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
) -> Path:
    source = Path(video_path).expanduser().resolve()
    target = Path(output_path).expanduser().resolve()
    if not source.exists() or not source.is_file():
        raise RuntimeError(f"原视频不存在: {source}")
    if context is not None:
        context.check_cancelled()
    target.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _resolve_ffmpeg_exe(payload)
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-ss",
            f"{max(float(timestamp_seconds or 0.0), 0.0):.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(target),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if context is not None:
        context.check_cancelled()
    if proc.returncode != 0 or not target.exists():
        raise RuntimeError((proc.stderr or proc.stdout or "ffmpeg frame extract failed").strip()[:800])
    return target


@lru_cache(maxsize=128)
def _load_storyboard_font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    bold_candidates = [
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    regular_candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    candidates = [*bold_candidates, *regular_candidates] if bold else regular_candidates
    for candidate in candidates:
        try:
            path = Path(candidate)
            if path.exists():
                return ImageFont.truetype(str(path), size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _digital_human_video_cover_keyword(payload: dict[str, Any] | None, speech_text: str = "") -> str:
    source = payload or {}
    candidates = [
        source.get("video_cover_keywords"),
        source.get("cover_keywords"),
        source.get("product_name"),
        source.get("product_project_name"),
        source.get("project_name"),
        source.get("oral_topic"),
        source.get("topic"),
        source.get("title"),
    ]
    for candidate in candidates:
        text = re.sub(r"\s+", "", str(candidate or "").strip())
        if text and text not in {"商品", "产品", "项目", "房源", "口播主题"}:
            return text[:18]
    clean = re.sub(r"\[[^\]]+\]", "", str(speech_text or ""))
    clean = re.sub(r"\s+", "", clean)
    clean = re.split(r"[。！？!?；;\n]", clean, maxsplit=1)[0].strip()
    clean = re.sub(r"^[，,、：:]+", "", clean)
    return clean[:16] if clean else ""


def _split_digital_human_video_cover_lines(payload: dict[str, Any] | None, speech_text: str = "") -> list[str]:
    source = payload or {}
    explicit = str(source.get("video_cover_keywords") or source.get("cover_keywords") or "").strip()
    if explicit:
        parts = [
            re.sub(r"\s+", "", item).strip()
            for item in re.split(r"[\n\r，,。！？!?；;、|/]+", explicit)
            if re.sub(r"\s+", "", item).strip()
        ]
        if parts:
            return [item[:14] for item in parts[:3]]

    topic = _digital_human_video_cover_keyword(source, "")
    generic_topics = {"商品", "产品", "项目", "房源", "口播主题", "精彩看点", "重点看这里"}
    lines: list[str] = []
    if topic and topic not in generic_topics:
        lines.append(topic[:14])

    clean = re.sub(r"\[[^\]]+\]", "", str(speech_text or ""))
    clean = re.sub(r"[（）()【】]", "", clean)
    clauses = [
        re.sub(r"\s+", "", item).strip()
        for item in re.split(r"[。！？!?；;\n，,]", clean)
        if re.sub(r"\s+", "", item).strip()
    ]
    for clause in clauses:
        clause = re.sub(r"^(今天|大家好|你好|首先|然后|接下来|最后|那么|如果|我们|我想|让我们)", "", clause)
        clause = clause.strip("，,。！？!?；;：:")
        if not clause or clause in lines:
            continue
        lines.append(clause[:14])
        if len(lines) >= 3:
            break
    if not lines:
        lines = ["重点看这里"]
    if len(lines) == 1 and len(lines[0]) <= 6:
        lines.append("内容很关键")
    return lines[:3]


def _cover_text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, stroke_width: int) -> int:
    try:
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
        return max(0, bbox[2] - bbox[0])
    except Exception:
        return len(text) * 32


def _fit_cover_line_font(draw: ImageDraw.ImageDraw, text: str, *, max_width: int, base_size: int) -> ImageFont.ImageFont:
    size = max(34, int(base_size))
    while size > 30:
        font = _load_storyboard_font(size)
        if _cover_text_width(draw, text, font, max(4, size // 12)) <= max_width:
            return font
        size -= 4
    return _load_storyboard_font(size)


def _digital_human_cover_text_colors(image: Image.Image, lines: list[str]) -> list[tuple[int, int, int, int]]:
    try:
        sample = image.convert("L").resize((1, 1))
        brightness = int(ImageStat.Stat(sample).mean[0])
    except Exception:
        brightness = 128
    if brightness >= 172:
        palettes = [
            [(0, 102, 255, 255), (230, 0, 126, 255), (235, 54, 42, 255)],
            [(0, 148, 126, 255), (237, 92, 0, 255), (40, 82, 230, 255)],
            [(197, 76, 0, 255), (0, 126, 74, 255), (206, 0, 91, 255)],
        ]
    elif brightness <= 92:
        palettes = [
            [(255, 232, 40, 255), (44, 229, 255, 255), (255, 93, 184, 255)],
            [(91, 255, 112, 255), (255, 214, 61, 255), (255, 103, 67, 255)],
            [(255, 255, 255, 255), (96, 235, 255, 255), (255, 218, 58, 255)],
        ]
    else:
        palettes = [
            [(255, 232, 40, 255), (31, 238, 83, 255), (255, 45, 49, 255)],
            [(72, 220, 255, 255), (255, 224, 45, 255), (255, 82, 153, 255)],
            [(255, 143, 36, 255), (38, 231, 177, 255), (255, 54, 70, 255)],
            [(255, 235, 80, 255), (115, 190, 255, 255), (255, 107, 73, 255)],
        ]
    key = "|".join(lines) + f"|{brightness // 32}"
    digest = hashlib.sha1(key.encode("utf-8", errors="ignore")).hexdigest()
    palette = palettes[int(digest[:8], 16) % len(palettes)]
    if len(lines) <= len(palette):
        return palette[: len(lines)]
    return [palette[idx % len(palette)] for idx in range(len(lines))]


def _draw_poster_keyword_text(image: Image.Image, keyword: str | list[str], *, subtitle: str = "") -> Image.Image:
    base = image.convert("RGBA")
    width, height = base.size
    if width <= 0 or height <= 0:
        return base.convert("RGB")
    raw_lines = keyword if isinstance(keyword, list) else str(keyword or "").splitlines()
    lines = [re.sub(r"\s+", "", str(item or "")).strip() for item in raw_lines if str(item or "").strip()]
    if not lines:
        lines = ["重点看这里"]
    lines = lines[:3]
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    max_text_width = int(width * 0.88)
    base_size = max(44, min(132, int(min(width, height) * (0.145 if height >= width else 0.16))))
    line_fonts = [_fit_cover_line_font(draw, line, max_width=max_text_width, base_size=base_size) for line in lines]
    outer_strokes = [max(5, int(getattr(font, "size", base_size) * 0.12)) for font in line_fonts]
    line_bboxes = [
        draw.textbbox((0, 0), line, font=font, stroke_width=stroke)
        for line, font, stroke in zip(lines, line_fonts, outer_strokes)
    ]
    line_heights = [bbox[3] - bbox[1] for bbox in line_bboxes]
    gap = max(6, int(min(width, height) * 0.018))
    total_height = sum(line_heights) + gap * max(0, len(lines) - 1)
    text_y = max(int(height * 0.055), int(height * 0.11) - total_height // 4)
    if height > width:
        text_y = max(int(height * 0.055), min(int(height * 0.20), text_y))
    colors = _digital_human_cover_text_colors(base, lines)
    for idx, (line, font, bbox, line_height, outer_stroke) in enumerate(zip(lines, line_fonts, line_bboxes, line_heights, outer_strokes)):
        text_width = bbox[2] - bbox[0]
        text_x = max(10, (width - text_width) // 2)
        fill = colors[idx % len(colors)]
        # Draw twice for a TikTok-style title: thick black edge plus inner white rim.
        draw.text(
            (text_x, text_y),
            line,
            font=font,
            fill=fill,
            stroke_width=outer_stroke,
            stroke_fill=(0, 0, 0, 255),
        )
        draw.text(
            (text_x, text_y),
            line,
            font=font,
            fill=fill,
            stroke_width=max(2, outer_stroke // 2),
            stroke_fill=(255, 255, 255, 245),
        )
        text_y += line_height + gap
    if subtitle:
        subtitle_font = _load_storyboard_font(max(22, int(base_size * 0.32)))
        sub_box = draw.textbbox((0, 0), subtitle, font=subtitle_font)
        sub_x = max(10, (width - (sub_box[2] - sub_box[0])) // 2)
        draw.text(
            (sub_x, text_y + max(2, base_size // 12)),
            subtitle,
            font=subtitle_font,
            fill=(255, 255, 255, 235),
            stroke_width=max(2, base_size // 22),
            stroke_fill=(0, 0, 0, 220),
        )
    return Image.alpha_composite(base, overlay).convert("RGB")


def _create_digital_human_video_cover(
    video_path: Path,
    output_path: Path,
    *,
    payload: dict[str, Any] | None = None,
    speech_text: str = "",
    context: VideoTaskContext | None = None,
) -> dict[str, Any] | None:
    cover_lines = _split_digital_human_video_cover_lines(payload, speech_text)
    if not cover_lines:
        return None
    source = Path(video_path).expanduser().resolve()
    target = Path(output_path).expanduser().resolve()
    frame_path = target.with_suffix(".frame.jpg")
    _extract_video_frame_at(
        source,
        frame_path,
        timestamp_seconds=0.2,
        payload=payload,
        context=context,
    )
    try:
        with Image.open(frame_path) as image:
            cover = _draw_poster_keyword_text(image, cover_lines)
            target.parent.mkdir(parents=True, exist_ok=True)
            cover.save(target, format="JPEG", quality=92, optimize=True)
    finally:
        try:
            frame_path.unlink(missing_ok=True)
        except Exception:
            pass
    return {
        "path": str(target),
        "keyword": cover_lines[0],
        "lines": cover_lines,
        "source_video_path": str(source),
    }


def _maybe_create_digital_human_video_cover(
    video_path: Path,
    *,
    payload: dict[str, Any] | None,
    speech_text: str = "",
    warnings: list[str] | None = None,
    context: VideoTaskContext | None = None,
) -> dict[str, Any] | None:
    if _to_bool((payload or {}).get("digital_human_video_cover_enabled"), True) is False:
        return None
    try:
        source = Path(video_path).expanduser().resolve()
        return _create_digital_human_video_cover(
            source,
            source.with_name(f"{source.stem}_cover.jpg"),
            payload=payload,
            speech_text=speech_text,
            context=context,
        )
    except VideoTaskCancelled:
        raise
    except Exception as exc:
        if warnings is not None:
            warnings.append(f"video_cover_failed: {exc}")
        return None


__all__ = [
    "_create_digital_human_video_cover",
    "_draw_poster_keyword_text",
    "_maybe_create_digital_human_video_cover",
    "_split_digital_human_video_cover_lines",
]
