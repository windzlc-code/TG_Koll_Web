from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Sequence

from PIL import Image, ImageOps, ImageStat

from .contracts import VideoDependencyError, VideoTaskContext


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _probe_video(path: Path, *, ffprobe_path: str = "") -> dict[str, Any]:
    ffprobe = str(ffprobe_path or shutil.which("ffprobe") or "").strip()
    if not ffprobe:
        raise VideoDependencyError("reference video analysis requires ffprobe")
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate:format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"reference video probe failed: {completed.stderr[-600:]}")
    parsed = json.loads(completed.stdout or "{}")
    stream = (parsed.get("streams") or [{}])[0] if isinstance(parsed, dict) else {}
    format_value = parsed.get("format") if isinstance(parsed, dict) and isinstance(parsed.get("format"), dict) else {}
    return {
        "duration_seconds": max(_number(format_value.get("duration"), 0.0), 0.0),
        "width": int(_number(stream.get("width"), 0)),
        "height": int(_number(stream.get("height"), 0)),
        "frame_rate": str(stream.get("r_frame_rate") or ""),
    }


def extract_reference_frames(
    video_path: str | Path,
    output_dir: str | Path,
    *,
    duration_seconds: float,
    ffmpeg_path: str = "",
    max_frames: int = 6,
    context: VideoTaskContext | None = None,
    run_process: Callable[..., Any] = subprocess.run,
) -> list[Path]:
    ffmpeg = str(ffmpeg_path or shutil.which("ffmpeg") or "").strip()
    if not ffmpeg:
        raise VideoDependencyError("reference video analysis requires ffmpeg")
    source = Path(video_path).expanduser().resolve()
    target_dir = Path(output_dir).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    duration = max(float(duration_seconds or 0.0), 0.0)
    if duration <= 0:
        return []
    count = max(1, min(int(max_frames or 6), 6))
    interval = max(duration / float(count), 0.1)
    frames: list[Path] = []
    for index in range(count):
        if context is not None:
            context.check_cancelled()
        timestamp = min(index * interval, max(duration - 0.1, 0.0))
        frame_path = target_dir / f"frame_{index + 1}.jpg"
        completed = run_process(
            [ffmpeg, "-y", "-ss", f"{timestamp:.3f}", "-i", str(source), "-frames:v", "1", "-q:v", "2", str(frame_path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if int(getattr(completed, "returncode", 1)) == 0 and frame_path.exists():
            frames.append(frame_path)
    return frames


def _subtitle_overlay_score(gray: Image.Image) -> float:
    width, height = gray.size
    if width < 16 or height < 16:
        return 0.0
    band = gray.crop((int(width * 0.08), int(height * 0.58), int(width * 0.92), int(height * 0.94)))
    small = ImageOps.fit(band, (192, 64), method=Image.Resampling.LANCZOS)
    values = list(small.getdata())
    if not values:
        return 0.0
    bright = sum(1 for value in values if value >= 220) / len(values)
    dark = sum(1 for value in values if value <= 45) / len(values)
    contrast = ImageStat.Stat(small).stddev[0] / 64.0
    return round(float((bright + dark) * 2.0 + contrast), 3)


def summarize_reference_frames(
    frame_paths: Sequence[str | Path],
    *,
    width: int,
    height: int,
    duration_seconds: float,
) -> dict[str, Any]:
    frame_stats: list[dict[str, float]] = []
    deltas: list[float] = []
    subtitle_scores: list[float] = []
    previous_values: list[int] | None = None
    existing_paths: list[str] = []
    for value in frame_paths:
        frame_path = Path(value).expanduser().resolve()
        if not frame_path.exists() or not frame_path.is_file():
            continue
        with Image.open(frame_path) as image:
            gray = ImageOps.fit(image.convert("L"), (160, 160), method=Image.Resampling.LANCZOS)
            stat = ImageStat.Stat(gray)
            values = [int(item) for item in gray.getdata()]
            subtitle_scores.append(_subtitle_overlay_score(image.convert("L")))
        existing_paths.append(str(frame_path))
        frame_stats.append(
            {
                "mean_luma": round(float(stat.mean[0] if stat.mean else 0.0), 3),
                "stddev_luma": round(float(stat.stddev[0] if stat.stddev else 0.0), 3),
            }
        )
        if previous_values is not None and values:
            deltas.append(round(sum(abs(current - previous) for current, previous in zip(values, previous_values)) / len(values), 3))
        previous_values = values
    average_luma = sum(item["mean_luma"] for item in frame_stats) / max(len(frame_stats), 1) if frame_stats else 0.0
    average_stddev = sum(item["stddev_luma"] for item in frame_stats) / max(len(frame_stats), 1) if frame_stats else 0.0
    average_delta = sum(deltas) / max(len(deltas), 1) if deltas else 0.0
    orientation = "vertical" if height > width > 0 else ("horizontal" if width > height > 0 else ("square" if width and height else "unknown"))
    pace_hint = "fast_cut" if average_delta >= 20.0 else "steady_lifestyle"
    detail_hint = "macro_detail" if average_stddev >= 46.0 else "scene_anchor"
    has_subtitle = sum(1 for score in subtitle_scores if score >= 1.25) >= 2
    style_tags = [orientation + "_story" if orientation == "vertical" else orientation, pace_hint, detail_hint]
    if average_luma >= 150:
        style_tags.append("airy_daylight")
    elif average_luma <= 92:
        style_tags.append("moody_low_key")
    if has_subtitle:
        style_tags.append("subtitle_present")
    summary_parts = [
        "竖屏生活化构图" if orientation == "vertical" else ("横屏参考构图" if orientation == "horizontal" else "中性构图"),
        "节奏偏快" if pace_hint == "fast_cut" else "节奏平稳",
        "偏细节特写" if detail_hint == "macro_detail" else "偏场景体验",
        "画面较明亮" if average_luma >= 150 else ("画面偏暗" if average_luma <= 92 else "明暗中性"),
    ]
    if has_subtitle:
        summary_parts.append("参考视频带硬字幕，仅借鉴节奏与构图")
    return {
        "schema_version": "local_seeding_reference_video_audit/v1",
        "duration_seconds": round(float(duration_seconds or 0.0), 3),
        "width": int(width or 0),
        "height": int(height or 0),
        "orientation": orientation,
        "pace_hint": pace_hint,
        "detail_hint": detail_hint,
        "average_luma": round(average_luma, 3),
        "average_frame_delta": round(average_delta, 3),
        "style_tags": style_tags,
        "style_summary": "；".join(summary_parts),
        "frame_paths": existing_paths,
        "frame_stats": frame_stats,
        "subtitle_probe": {"has_subtitle": has_subtitle, "scores": subtitle_scores},
    }


def audit_ecommerce_reference_video(
    video_path: str | Path,
    *,
    workdir: str | Path,
    ffmpeg_path: str = "",
    ffprobe_path: str = "",
    context: VideoTaskContext | None = None,
) -> dict[str, Any]:
    source = Path(video_path).expanduser().resolve()
    if not source.exists() or not source.is_file():
        raise FileNotFoundError(f"reference video does not exist: {source}")
    if context is not None:
        context.check_cancelled()
    metadata = _probe_video(source, ffprobe_path=ffprobe_path)
    audit_dir = Path(workdir).expanduser().resolve()
    frames = extract_reference_frames(
        source,
        audit_dir / "frames",
        duration_seconds=metadata["duration_seconds"],
        ffmpeg_path=ffmpeg_path,
        context=context,
    )
    result = summarize_reference_frames(
        frames,
        width=metadata["width"],
        height=metadata["height"],
        duration_seconds=metadata["duration_seconds"],
    )
    result["video_path"] = str(source)
    result["contact_sheet_path"] = ""
    return result


__all__ = ["audit_ecommerce_reference_video", "extract_reference_frames", "summarize_reference_frames"]
