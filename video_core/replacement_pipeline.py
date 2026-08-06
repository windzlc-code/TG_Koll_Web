from __future__ import annotations

import inspect
import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any, Iterable

from .contracts import VideoDependencyError, VideoTaskCancelled, VideoTaskContext
from .source import replace_model as archived_replace_model
from .source import replace_product as archived_replace_product

try:
    from PIL import Image, ImageFilter, ImageStat
except ImportError:  # pragma: no cover - optional in minimal worker images
    Image = ImageFilter = ImageStat = None  # type: ignore[assignment]


REPLACE_MODEL_DEFAULT_APP_ID = "2028374986792116225"
REPLACE_PRODUCT_DEFAULT_APP_ID = "1977410328592031746"
REPLACE_SUBJECT_FALLBACK_DURATION_SECONDS = 20
REPLACE_SUBJECT_MAX_SEGMENT_SECONDS = 20
_CLOSED_IMAGE_STAGE = "closed_image_model"
_COMBINED_TASK_TYPES = {
    "replace_model_product",
    "replace_model_and_product",
    "replace_product_and_model",
    "replace_productANDmodel",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _invoke(callable_obj: Any, **values: Any) -> Any:
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return callable_obj(**values)
    accepts_kwargs = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
    kwargs = values if accepts_kwargs else {
        key: value for key, value in values.items() if key in signature.parameters
    }
    return callable_obj(**kwargs)


def _positive_int(value: Any, default: int) -> int:
    try:
        return max(int(float(value)), 1)
    except (TypeError, ValueError):
        return max(int(default), 1)


def _positive_float(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) and number > 0 else 0.0


def _explicit_duration(payload: dict[str, Any]) -> float:
    for key in ("duration_seconds", "duration"):
        value = payload.get(key)
        if value in (None, ""):
            continue
        duration = _positive_float(value)
        if duration > 0:
            return duration
    return 0.0


def _existing_local_video_path(reference: str) -> Path | None:
    text = _text(reference)
    if not text or text.startswith(("http://", "https://")):
        return None
    try:
        path = Path(text).expanduser().resolve()
    except (OSError, ValueError):
        return None
    return path if path.exists() and path.is_file() else None


def _probe_source_video_duration(
    *,
    backend: Any,
    payload: dict[str, Any],
    context: VideoTaskContext,
    source_reference: str,
) -> float:
    source_path = next(
        (
            path
            for path in (
                _existing_local_video_path(_text(payload.get("video_local_path"))),
                _existing_local_video_path(_text(payload.get("source_video_local_path"))),
                _existing_local_video_path(source_reference),
            )
            if path is not None
        ),
        None,
    )
    if source_path is None:
        return 0.0

    probes = [payload.get("_replacement_duration_probe"), getattr(backend, "_probe_duration", None)]
    for probe in probes:
        if not callable(probe):
            continue
        context.check_cancelled()
        try:
            duration = _positive_float(
                _invoke(
                    probe,
                    path=source_path,
                    payload=payload,
                    context=context,
                )
            )
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            context.log(f"replacement duration probe failed: {exc}")
            duration = 0.0
        context.check_cancelled()
        if duration > 0:
            return duration

    ffprobe = _text(payload.get("ffprobe_path")) or _text(shutil.which("ffprobe"))
    if not ffprobe:
        return 0.0
    context.check_cancelled()
    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(source_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        duration = _positive_float(completed.stdout) if completed.returncode == 0 else 0.0
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        context.log(f"ffprobe duration probe failed: {exc}")
        duration = 0.0
    context.check_cancelled()
    return duration


def _resolve_replacement_duration(
    *,
    backend: Any,
    payload: dict[str, Any],
    context: VideoTaskContext,
    source_reference: str,
) -> tuple[int, float, str]:
    explicit = _explicit_duration(payload)
    if explicit > 0:
        return max(int(math.ceil(explicit)), 1), 0.0, "payload"
    source_duration = _probe_source_video_duration(
        backend=backend,
        payload=payload,
        context=context,
        source_reference=source_reference,
    )
    if source_duration > 0:
        return max(int(math.ceil(source_duration)), 1), source_duration, "source_video"
    return REPLACE_SUBJECT_FALLBACK_DURATION_SECONDS, 0.0, "fallback"


def _replace_subject_segment_specs(
    total_seconds: float,
    *,
    max_segment_seconds: int = REPLACE_SUBJECT_MAX_SEGMENT_SECONDS,
) -> list[dict[str, float]]:
    """Copied from the archived server: split on the workflow duration limit."""

    total = max(float(total_seconds or 0.0), 0.0)
    segment_limit = max(int(max_segment_seconds or REPLACE_SUBJECT_MAX_SEGMENT_SECONDS), 1)
    if total <= 0:
        return []
    specs: list[dict[str, float]] = []
    start = 0.0
    index = 1
    while start < total - 0.05:
        duration = min(float(segment_limit), max(total - start, 0.0))
        if duration <= 0.05:
            break
        specs.append({"index": float(index), "start_seconds": start, "duration_seconds": duration})
        start += duration
        index += 1
    return specs


def _should_segment_replace_subject_video(
    payload: dict[str, Any],
    *,
    source_duration_seconds: float,
    target_duration_seconds: int,
) -> bool:
    """Copied from the archived server with the same opt-out payload keys."""

    if bool(payload.get("_replace_subject_disable_segmentation")):
        return False
    if bool(payload.get("replace_subject_disable_segmentation")):
        return False
    duration = max(float(source_duration_seconds or 0.0), float(target_duration_seconds or 0))
    return duration > float(REPLACE_SUBJECT_MAX_SEGMENT_SECONDS) + 0.2


def _replacement_ffmpeg(payload: dict[str, Any]) -> str:
    value = _text(payload.get("ffmpeg_path")) or _text(shutil.which("ffmpeg"))
    if not value:
        raise VideoDependencyError("ffmpeg is required for replacement preprocessing")
    return value


def _run_ffmpeg(
    command: list[str],
    *,
    payload: dict[str, Any],
    context: VideoTaskContext,
    timeout_seconds: int = 1800,
) -> None:
    context.check_cancelled()
    runner = payload.get("_replacement_local_process")
    if callable(runner):
        result = _invoke(
            runner,
            command=command,
            payload=payload,
            context=context,
            timeout_seconds=timeout_seconds,
        )
        if isinstance(result, tuple):
            returncode = int(result[0])
            stderr = _text(result[2] if len(result) > 2 else "")
        elif isinstance(result, dict):
            returncode = int(result.get("returncode") or 0)
            stderr = _text(result.get("stderr"))
        else:
            returncode = int(result or 0)
            stderr = ""
    else:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=max(int(timeout_seconds), 30),
            check=False,
        )
        returncode = completed.returncode
        stderr = completed.stderr or completed.stdout or ""
    context.check_cancelled()
    if returncode != 0:
        raise RuntimeError(f"ffmpeg replacement preprocessing failed: {stderr[-1000:]}")


def _cut_media_segment(
    source: Path,
    output: Path,
    *,
    start_seconds: float,
    duration_seconds: float,
    payload: dict[str, Any],
    context: VideoTaskContext,
) -> Path:
    cutter = payload.get("_replacement_segment_cutter")
    output.parent.mkdir(parents=True, exist_ok=True)
    if callable(cutter):
        result = _invoke(
            cutter,
            source_path=source,
            output_path=output,
            start_seconds=start_seconds,
            duration_seconds=duration_seconds,
            payload=payload,
            context=context,
        )
        candidate = Path(_text(result) or str(output)).expanduser().resolve()
    else:
        _run_ffmpeg(
            [
                _replacement_ffmpeg(payload), "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{start_seconds:.3f}", "-i", str(source), "-t", f"{duration_seconds:.3f}",
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output),
            ],
            payload=payload,
            context=context,
        )
        candidate = output.resolve()
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"replacement segment was not created: {candidate}")
    return candidate


def _concat_media_segments(
    paths: list[Path],
    output: Path,
    *,
    payload: dict[str, Any],
    context: VideoTaskContext,
) -> Path:
    concat = payload.get("_replacement_segment_concat")
    output.parent.mkdir(parents=True, exist_ok=True)
    if callable(concat):
        result = _invoke(
            concat,
            segment_paths=paths,
            output_path=output,
            payload=payload,
            context=context,
        )
        candidate = Path(_text(result) or str(output)).expanduser().resolve()
    else:
        concat_file = output.with_suffix(".ffconcat")
        concat_file.write_text(
            "ffconcat version 1.0\n"
            + "\n".join(f"file '{path.resolve().as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for path in paths)
            + "\n",
            encoding="utf-8",
        )
        _run_ffmpeg(
            [
                _replacement_ffmpeg(payload), "-hide_banner", "-loglevel", "error", "-y",
                "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(output),
            ],
            payload=payload,
            context=context,
        )
        candidate = output.resolve()
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"replacement concatenation output was not created: {candidate}")
    return candidate


def _extract_video_frame_at(
    source: Path,
    output: Path,
    *,
    timestamp_seconds: float,
    payload: dict[str, Any],
    context: VideoTaskContext,
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
            _replacement_ffmpeg(payload), "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{timestamp_seconds:.3f}", "-i", str(source), "-frames:v", "1", str(output),
        ],
        payload=payload,
        context=context,
        timeout_seconds=120,
    )
    if not output.exists():
        raise FileNotFoundError(f"subtitle probe frame was not created: {output}")
    return output.resolve()


def _replace_subject_subtitle_region_score(gray: Any, region: tuple[float, float, float, float], *, name: str) -> dict[str, Any]:
    """Direct copy of the archived hard-subtitle region heuristic."""

    width, height = gray.size
    left = max(min(int(width * region[0]), width - 1), 0)
    top = max(min(int(height * region[1]), height - 1), 0)
    right = max(min(int(width * region[2]), width), left + 1)
    bottom = max(min(int(height * region[3]), height), top + 1)
    band = gray.crop((left, top, right, bottom))
    small_w = 360
    small_h = max(int(band.height * small_w / max(band.width, 1)), 1)
    band = band.resize((small_w, small_h))
    pixels = list(getattr(band, "get_flattened_data", band.getdata)())
    total = max(len(pixels), 1)
    white_ratio = sum(1 for value in pixels if value >= 218) / total
    dark_ratio = sum(1 for value in pixels if value <= 38) / total
    stat = ImageStat.Stat(band)
    stddev = float(stat.stddev[0] if stat.stddev else 0.0)
    edges = band.filter(ImageFilter.FIND_EDGES)
    edge_pixels = list(getattr(edges, "get_flattened_data", edges.getdata)())
    edge_ratio = sum(1 for value in edge_pixels if value >= 55) / max(len(edge_pixels), 1)
    bw, bh = band.size
    row_counts: list[int] = []
    col_counts = [0 for _ in range(bw)]
    active_total = 0
    for y in range(bh):
        row_active = 0
        offset = y * bw
        for x in range(bw):
            if edge_pixels[offset + x] >= 55:
                row_active += 1
                col_counts[x] += 1
        active_total += row_active
        row_counts.append(row_active)
    row_peak = max(row_counts or [0]) / max(bw, 1)
    row_coverage = len([count for count in row_counts if count >= max(int(bw * 0.055), 6)]) / max(bh, 1)
    strong_row_coverage = len([count for count in row_counts if count >= max(int(bw * 0.12), 10)]) / max(bh, 1)
    active_ratio = active_total / max(total, 1)
    col_peak = max(col_counts or [0]) / max(bh, 1)
    horizontal_cluster_score = 0.0
    if row_peak >= 0.08:
        horizontal_cluster_score += min(row_peak / 0.26, 1.6)
    if 0.025 <= row_coverage <= 0.58:
        horizontal_cluster_score += min(row_coverage / 0.18, 1.4)
    if 0.008 <= strong_row_coverage <= 0.36:
        horizontal_cluster_score += min(strong_row_coverage / 0.08, 1.2)
    if col_peak >= 0.72 and row_coverage > 0.42:
        horizontal_cluster_score *= 0.65
    active_penalty = 0.35 if active_ratio > 0.62 and row_coverage > 0.52 else 0.0
    if white_ratio >= 0.08 and dark_ratio <= 0.012 and edge_ratio <= 0.06 and 0.08 <= row_coverage <= 0.32:
        active_penalty += 0.95
    score = (
        min(stddev / 44.0, 1.8) * 0.22
        + min(edge_ratio / 0.048, 1.8) * 0.26
        + min((white_ratio + dark_ratio) / 0.28, 1.5) * 0.18
        + horizontal_cluster_score * 0.34
        - active_penalty
    )
    return {"name": name, "score": round(max(score, 0.0), 3)}


def _detect_video_hard_subtitle_overlay(
    video_path: Path,
    *,
    workdir: Path,
    payload: dict[str, Any],
    context: VideoTaskContext,
) -> dict[str, Any]:
    detector = payload.get("_replacement_subtitle_detector")
    if callable(detector):
        result = _invoke(detector, video_path=video_path, workdir=workdir, payload=payload, context=context)
        return dict(result) if isinstance(result, dict) else {"has_subtitle": bool(result)}
    if Image is None:
        return {"has_subtitle": False, "skipped": True, "reason": "pillow_not_installed"}
    duration = _positive_float(payload.get("_replacement_source_video_duration_seconds"))
    timestamps = [0.5]
    if duration > 2.0:
        timestamps.extend([duration * 0.25, duration * 0.5])
    if duration > 4.0:
        timestamps.extend([duration * 0.75, max(duration - 1.0, 0.5)])
    scores: list[float] = []
    best_regions: list[str] = []
    errors: list[str] = []
    regions = [
        ("top_overlay", (0.03, 0.04, 0.97, 0.28)),
        ("upper_mid_overlay", (0.03, 0.22, 0.97, 0.48)),
        ("center_overlay", (0.03, 0.38, 0.97, 0.68)),
        ("lower_mid_overlay", (0.03, 0.50, 0.97, 0.78)),
        ("bottom_subtitle", (0.03, 0.62, 0.97, 0.96)),
        ("stitched_lower_top", (0.03, 0.50, 0.97, 0.66)),
        ("stitched_lower_bottom", (0.03, 0.76, 0.97, 0.97)),
    ]
    frame_dir = workdir / "replace_subject_subtitle_probe"
    for index, timestamp in enumerate(dict.fromkeys(round(value, 3) for value in timestamps), start=1):
        try:
            frame = _extract_video_frame_at(
                video_path,
                frame_dir / f"subtitle_probe_{index}.jpg",
                timestamp_seconds=timestamp,
                payload=payload,
                context=context,
            )
            with Image.open(frame) as image:
                gray = image.convert("L")
                analyses = [_replace_subject_subtitle_region_score(gray, region, name=name) for name, region in regions]
            best = max(analyses, key=lambda item: float(item["score"]), default={"score": 0.0, "name": ""})
            scores.append(float(best["score"]))
            best_regions.append(str(best["name"]))
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            errors.append(str(exc)[:240])
    if not scores:
        return {"has_subtitle": False, "score": 0.0, "scores": [], "errors": errors}
    max_score = max(scores)
    average = sum(scores) / len(scores)
    region_hits: dict[str, int] = {}
    for region_name, score in zip(best_regions, scores):
        if score >= 0.95 and region_name:
            region_hits[region_name] = region_hits.get(region_name, 0) + 1
    has_subtitle = (
        (max_score >= 1.28 and average >= 0.72)
        or (sum(score >= 1.02 for score in scores) >= 2 and average >= 0.88)
        or (sum(score >= 1.22 for score in scores) >= 1 and max(region_hits.values() or [0]) >= 2)
    )
    return {
        "has_subtitle": bool(has_subtitle),
        "score": round(max_score, 3),
        "avg_score": round(average, 3),
        "scores": scores,
        "best_regions": best_regions,
        "region_hits": region_hits,
        "errors": errors,
    }


def _prepare_replace_subject_source_video(
    *,
    task_id: str,
    payload: dict[str, Any],
    source_video: str,
    workdir: Path,
    context: VideoTaskContext,
) -> tuple[str, dict[str, Any]]:
    """Adapt the archived preprocess metadata and wire its subtitle helpers."""

    source = _existing_local_video_path(source_video)
    metadata: dict[str, Any] = {
        "source_video_path": str(source or source_video or ""),
        "video_for_upload": str(source or source_video or ""),
        "subtitle_detected": False,
        "subtitle_removed": False,
        "subtitle_detection": {},
        "runninghub_task_ids": [],
    }
    if source is None or bool(payload.get("replace_subject_disable_subtitle_detection")):
        metadata["source_video_preprocess_skipped"] = source is None
        return source_video, metadata
    detection = _detect_video_hard_subtitle_overlay(
        source,
        workdir=workdir,
        payload=payload,
        context=context,
    )
    metadata["subtitle_detection"] = detection
    metadata["subtitle_detected"] = bool(detection.get("has_subtitle"))
    if not metadata["subtitle_detected"]:
        return str(source), metadata
    remover = payload.get("_replacement_subtitle_removal_provider")
    if not callable(remover):
        metadata["subtitle_removal_skipped"] = True
        metadata["subtitle_removal_skip_reason"] = "provider_not_configured"
        return str(source), metadata
    context.progress(stage="replacement_preprocess", status="running", message="Removing hard subtitles", progress=3)
    removed_output = workdir / "replace_subject_subtitle_removed.mp4"
    result = _invoke(
        remover,
        task_id=task_id,
        video_path=source,
        output_path=removed_output,
        payload=payload,
        context=context,
        workdir=workdir,
    )
    context.check_cancelled()
    if isinstance(result, dict):
        candidate_text = _text(result.get("video_path") or result.get("download_path") or result.get("output_path"))
        metadata["runninghub_task_ids"] = _extract_task_ids(result)
    else:
        candidate_text = _text(result)
    candidate = Path(candidate_text or str(removed_output)).expanduser().resolve()
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"subtitle removal output was not created: {candidate}")
    metadata["subtitle_removed"] = True
    metadata["video_for_upload"] = str(candidate)
    return str(candidate), metadata


def _normalize_stage(value: Any) -> str:
    if isinstance(value, dict):
        stage_type = _text(value.get("type") or value.get("provider")).lower()
        stage_value = _text(value.get("value") or value.get("model") or value.get("app_id"))
        if stage_type in {_CLOSED_IMAGE_STAGE, "closed_model_api", "closed_model", "image_model"}:
            return f"{_CLOSED_IMAGE_STAGE}:{stage_value}" if stage_value else _CLOSED_IMAGE_STAGE
        return stage_value
    return _text(value)


def _normalize_chain(value: Any) -> list[str]:
    values: Iterable[Any]
    if isinstance(value, str):
        values = value.replace("\n", ",").split(",")
    elif isinstance(value, (list, tuple)):
        values = value
    elif value is None:
        values = ()
    else:
        values = (value,)
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        stage = _normalize_stage(raw)
        if stage and stage not in seen:
            seen.add(stage)
            result.append(stage)
    return result


def _is_closed_image_stage(value: Any) -> bool:
    stage = _text(value)
    return stage == _CLOSED_IMAGE_STAGE or stage.startswith(f"{_CLOSED_IMAGE_STAGE}:")


def _closed_image_model(value: Any) -> str:
    stage = _text(value)
    return stage.split(":", 1)[1].strip() if ":" in stage else ""


def _model_chain_key(mode: Any) -> str:
    normalized = archived_replace_model.normalize_mode(_text(mode))
    if normalized == archived_replace_model.MODE_PRIMARY:
        return "replace_model_primary_workflow_ids"
    if normalized == archived_replace_model.MODE_SLICE:
        return "replace_model_slice_workflow_ids"
    if normalized == archived_replace_model.MODE_MOTION_TRANSFER:
        return "replace_model_motion_transfer_workflow_ids"
    return "replace_model_original_workflow_ids"


def _first_chain(payload: dict[str, Any], keys: Iterable[str], fallback: Any) -> list[str]:
    for key in keys:
        chain = _normalize_chain(payload.get(key))
        if chain:
            return chain
    return _normalize_chain(fallback)


def _replacement_chains(task_type: str, payload: dict[str, Any]) -> dict[str, list[str]]:
    mode_key = _model_chain_key(payload.get("mode"))
    mode = archived_replace_model.normalize_mode(_text(payload.get("mode")))
    mode_app_ids = {
        archived_replace_model.MODE_PRIMARY: (
            "replace_model_primary_app_id",
            archived_replace_model.PRIMARY_APP_ID,
        ),
        archived_replace_model.MODE_SLICE: (
            "replace_model_slice_app_id",
            archived_replace_model.SLICE_APP_ID,
        ),
        archived_replace_model.MODE_MOTION_TRANSFER: (
            "replace_model_motion_transfer_app_id",
            archived_replace_model.MOTION_TRANSFER_APP_ID,
        ),
        archived_replace_model.MODE_ORIGINAL: (
            "replace_model_original_app_id",
            REPLACE_MODEL_DEFAULT_APP_ID,
        ),
    }
    mode_app_key, mode_default_app_id = mode_app_ids[mode]
    model_fallback = (
        payload.get("model_app_id")
        or payload.get("video_replace_model_app_id")
        or payload.get(mode_app_key)
        or payload.get("replace_model_app_id")
        or mode_default_app_id
    )
    product_fallback = (
        payload.get("product_app_id")
        or payload.get("video_replace_product_app_id")
        or payload.get("replace_product_app_id")
        or REPLACE_PRODUCT_DEFAULT_APP_ID
    )
    if task_type == "replace_model":
        return {
            "model": _first_chain(
                payload,
                (mode_key, "workflow_chain_ids", "model_workflow_chain_ids"),
                model_fallback,
            )
        }
    if task_type == "replace_product":
        return {
            "product": _first_chain(
                payload,
                ("replace_product_workflow_ids", "workflow_chain_ids", "product_workflow_chain_ids"),
                product_fallback,
            )
        }
    return {
        "model": _first_chain(
            payload,
            ("model_workflow_chain_ids", mode_key),
            model_fallback,
        ),
        "product": _first_chain(
            payload,
            ("product_workflow_chain_ids", "replace_product_workflow_ids"),
            product_fallback,
        ),
    }


def _split_chain(chain: list[str]) -> tuple[list[str], list[str]]:
    # This follows the archived server: closed-image stages preprocess the
    # reference image before any RunningHub video workflow is submitted.
    return (
        [stage for stage in chain if _is_closed_image_stage(stage)],
        [stage for stage in chain if not _is_closed_image_stage(stage)],
    )


def _extract_task_ids(result: Any) -> list[str]:
    if not isinstance(result, dict):
        return []
    values: list[Any] = []
    if isinstance(result.get("runninghub_task_ids"), (list, tuple)):
        values.extend(result["runninghub_task_ids"])
    values.extend(
        result.get(key)
        for key in ("runninghub_task_id", "provider_task_id", "task_id", "task id", "taskId")
    )
    task_ids: list[str] = []
    for value in values:
        task_id = _text(value)
        if task_id and task_id not in task_ids:
            task_ids.append(task_id)
    return task_ids


def _result_succeeded(result: Any) -> bool:
    if not isinstance(result, dict):
        return bool(result)
    if result.get("ok") is not None:
        return bool(result.get("ok"))
    status = _text(result.get("status")).lower()
    if status:
        return status in {"ok", "success", "succeeded", "completed"}
    return any(
        _text(result.get(key))
        for key in ("image_path", "video_path", "download_path", "output_path", "output_url")
    )


def _result_message(result: Any, default: str) -> str:
    if isinstance(result, dict):
        return _text(result.get("message") or result.get("error")) or default
    return default


def _merge_usage(target: dict[str, Any], result: Any) -> None:
    if not isinstance(result, dict):
        return
    usage = result.get("runninghub_usage")
    if not isinstance(usage, dict):
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    for key, value in usage.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            target[key] = float(target.get(key) or 0) + float(value)
        elif key not in target:
            target[key] = value


def _resume_checkpoint(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = [payload.get("replacement_checkpoint")]
    resume = payload.get("resume_checkpoint")
    if isinstance(resume, dict):
        candidates.extend((resume.get("replacement_checkpoint"), resume))
    for candidate in candidates:
        if isinstance(candidate, dict) and isinstance(candidate.get("completed_stages"), list):
            return dict(candidate)
    return {}


def _checkpoint_stage_map(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    checkpoint = _resume_checkpoint(payload)
    result: dict[str, dict[str, Any]] = {}
    for item in checkpoint.get("completed_stages") or []:
        if not isinstance(item, dict):
            continue
        stage_id = _text(item.get("stage_id"))
        if stage_id:
            result[stage_id] = dict(item)
    return result


def _usable_stage_output(stage: dict[str, Any]) -> str:
    remote = _text(stage.get("output_url") or stage.get("video_url") or stage.get("image_url"))
    if remote.startswith(("http://", "https://")):
        return remote
    local = _text(stage.get("output_path") or stage.get("download_path"))
    if local:
        try:
            path = Path(local).expanduser().resolve()
            if path.exists() and path.is_file():
                return str(path)
        except (OSError, ValueError):
            return ""
    return ""


def _checkpoint_callback(
    *,
    task_id: str,
    payload: dict[str, Any],
    task_type: str,
    completed_stages: list[dict[str, Any]],
    runninghub_task_ids: list[str],
    final_output_path: str = "",
) -> dict[str, Any]:
    safe_stages = json.loads(json.dumps(completed_stages, ensure_ascii=False, default=str))
    checkpoint = {
        "version": 1,
        "task_type": task_type,
        "recoverable": True,
        "stage": "replacement_complete" if final_output_path else "replacement_stage",
        "completed_stages": safe_stages,
        "runninghub_task_ids": list(runninghub_task_ids),
        "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
        "final_output_path": final_output_path,
    }
    callback = payload.get("_checkpoint_video_progress") or payload.get("_replacement_checkpoint_callback")
    if callable(callback):
        _invoke(
            callback,
            task_id=task_id,
            replacement_checkpoint=checkpoint,
            completed_stages=checkpoint["completed_stages"],
            runninghub_task_ids=checkpoint["runninghub_task_ids"],
            runninghub_task_id=checkpoint["runninghub_task_id"],
            final_output_path=final_output_path,
            stage=checkpoint["stage"],
        )
    return checkpoint


def _workdir(backend: Any, task_id: str, payload: dict[str, Any]) -> Path:
    method = getattr(backend, "_workdir", None)
    if callable(method):
        return Path(_invoke(method, task_id=task_id, payload=payload)).expanduser().resolve()
    configured = _text(payload.get("output_dir") or payload.get("workdir"))
    path = Path(configured).expanduser().resolve() if configured else (
        Path("webapp_data") / "task_runs" / task_id
    ).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _initial_reference(payload: dict[str, Any], subject: str) -> str:
    if subject == "video":
        keys = ("video_url", "source_video_url", "video_local_path", "source_video_local_path")
    elif subject == "model":
        keys = (
            "model_image_url",
            "image_url",
            "replacement_image_url",
            "model_image_local_path",
            "image_local_path",
            "replacement_image_local_path",
        )
    else:
        keys = (
            "product_image_url",
            "image_url",
            "replacement_image_url",
            "product_image_local_path",
            "image_local_path",
            "replacement_image_local_path",
        )
    return next((_text(payload.get(key)) for key in keys if _text(payload.get(key))), "")


def _resolve_media_reference(
    *,
    backend: Any,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
    media_kind: str,
    value: str,
) -> str:
    context.check_cancelled()
    text = _text(value)
    if text.startswith(("http://", "https://")):
        return text
    resolver = payload.get("_replacement_media_resolver")
    if callable(resolver):
        resolved = _invoke(
            resolver,
            task_id=task_id,
            media_kind=media_kind,
            local_path=text,
            remote_url="",
            payload=payload,
            context=context,
        )
        resolved_text = _text(resolved)
        if resolved_text:
            return resolved_text
    method = getattr(backend, "_resolve_media", None)
    if not callable(method):
        raise VideoDependencyError(f"replacement media resolver is unavailable for {media_kind}")
    return _text(
        _invoke(
            method,
            task_id=task_id,
            payload=payload,
            context=context,
            media_kind=media_kind,
            local_values=(text,),
            remote_values=(),
        )
    )


def _localize_image(
    *,
    backend: Any,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
    subject: str,
    reference: str,
    output_path: Path,
) -> Path:
    try:
        local = Path(reference).expanduser().resolve()
        if local.exists() and local.is_file():
            return local
    except (OSError, ValueError):
        pass
    localizer = payload.get("_replacement_image_localizer")
    if callable(localizer):
        result = _invoke(
            localizer,
            task_id=task_id,
            subject=subject,
            reference=reference,
            output_path=str(output_path),
            payload=payload,
            context=context,
        )
        localized = _text(result.get("image_path") if isinstance(result, dict) else result)
        path = Path(localized or output_path).expanduser().resolve()
        if path.exists() and path.is_file():
            return path
    raise VideoDependencyError(
        f"closed-image stage for {subject} needs a local image or _replacement_image_localizer"
    )


def _closed_image_prompt(payload: dict[str, Any], subject: str) -> str:
    params = payload.get(f"{subject}_params")
    params = params if isinstance(params, dict) else {}
    explicit = _text(
        params.get("image_prompt")
        or payload.get(f"{subject}_image_prompt")
        or payload.get("image_prompt")
    )
    if explicit:
        return explicit
    if subject == "model":
        return "Optimize the model reference image while preserving identity, face and clothing; use a clean background without text or watermark."
    return "Optimize the product reference image while preserving shape, material and color; use a clean background without text or watermark."


def _run_closed_image_stage(
    *,
    backend: Any,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
    subject: str,
    stage_id: str,
    stage_index: int,
    stage_value: str,
    input_reference: str,
    workdir: Path,
) -> tuple[str, dict[str, Any]]:
    stage_dir = workdir / "closed_image_preprocess"
    stage_dir.mkdir(parents=True, exist_ok=True)
    source_path = _localize_image(
        backend=backend,
        task_id=task_id,
        payload=payload,
        context=context,
        subject=subject,
        reference=input_reference,
        output_path=stage_dir / f"{subject}_source_{stage_index:02d}.png",
    )
    output_path = stage_dir / f"{subject}_closed_stage_{stage_index:02d}.png"
    model = _closed_image_model(stage_value)
    prompt = _closed_image_prompt(payload, subject)
    provider = (
        payload.get("_replacement_closed_image_provider")
        or payload.get("_closed_image_generator")
        or payload.get("_closed_image_provider")
    )
    if callable(provider):
        result = _invoke(
            provider,
            backend=backend,
            task_id=task_id,
            stage_id=stage_id,
            stage_index=stage_index,
            subject=subject,
            model=model,
            input_path=str(source_path),
            input_reference=input_reference,
            output_path=str(output_path),
            prompt=prompt,
            payload=payload,
            context=context,
            stop_requested=context.cancelled,
        )
    else:
        generate = getattr(backend, "image_generate", None)
        if not callable(generate):
            raise VideoDependencyError("closed-image provider is unavailable")
        child_payload = dict(payload)
        for key in ("image_count", "imageCount", "nano_images", "count"):
            child_payload.pop(key, None)
        child_payload.update(
            {
                "mode": "product_only",
                "video_image_mode": "product_only",
                "prompt": prompt,
                "product_image_local_path": str(source_path),
                "primary_image_local_path": str(source_path),
                "image_local_path": str(source_path),
                "count": 1,
                "output_dir": str(stage_dir / f"{subject}_stage_{stage_index:02d}"),
            }
        )
        result = _invoke(
            generate,
            task_id=f"{task_id}_{subject}_closed_{stage_index:02d}",
            payload=child_payload,
            context=context,
        )
    context.check_cancelled()
    returned = ""
    if isinstance(result, dict):
        returned = _text(
            result.get("image_path")
            or result.get("download_path")
            or result.get("output_path")
        )
    elif isinstance(result, (str, Path)):
        returned = _text(result)
    final_path = Path(returned or output_path).expanduser().resolve()
    if not _result_succeeded(result) or not final_path.exists() or not final_path.is_file():
        raise RuntimeError(
            _result_message(result, f"closed-image stage did not create output: {final_path}")
        )
    record = {
        "stage_id": stage_id,
        "stage_index": stage_index,
        "subject": subject,
        "provider": _CLOSED_IMAGE_STAGE,
        "model": model,
        "status": "success",
        "input_reference": input_reference,
        "output_path": str(final_path),
        "runninghub_task_ids": _extract_task_ids(result),
        "result": result,
    }
    return str(final_path), record


def _workflow_nodes(
    *,
    subject: str,
    app_id: str,
    payload: dict[str, Any],
    video_url: str,
    image_url: str,
) -> list[dict[str, Any]]:
    width = _positive_int(payload.get("width"), 576)
    height = _positive_int(payload.get("height"), 1024)
    frame = _positive_int(payload.get("frame") or payload.get("frame_rate"), 30)
    duration = _positive_int(payload.get("duration_seconds") or payload.get("duration"), 10)
    if subject == "model":
        return archived_replace_model._build_node_info_list(
            mode=payload.get("mode"),
            app_id=app_id,
            video_path=video_url,
            image_path=image_url,
            prompt=_text(payload.get("prompt") or payload.get("prompt_text") or payload.get("message")),
            width=width,
            height=height,
            frame=frame,
            duration_seconds=duration,
            start_seconds=max(int(float(payload.get("start_seconds") or 0)), 0),
        )
    return archived_replace_product._build_node_info_list(
        video_path=video_url,
        image_path=image_url,
        product_name=_text(payload.get("product_name")),
        prompt_text=_text(payload.get("prompt_text") or payload.get("prompt") or payload.get("message")),
        duration_seconds=duration,
        frame_rate=frame,
        width=width,
        height=height,
    )


def _run_workflow_stage(
    *,
    backend: Any,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
    subject: str,
    stage_id: str,
    stage_index: int,
    app_id: str,
    input_video: str,
    image_reference: str,
    output_path: Path,
    resume_runninghub_task_id: str,
) -> tuple[str, dict[str, Any], bool]:
    provider = payload.get("_replacement_workflow_provider") or payload.get("_runninghub_workflow_provider")
    stage_payload = dict(payload)
    if resume_runninghub_task_id:
        stage_payload["resume_runninghub_task_id"] = resume_runninghub_task_id
    else:
        stage_payload.pop("resume_runninghub_task_id", None)
    if callable(provider):
        result = _invoke(
            provider,
            backend=backend,
            task_id=task_id,
            stage_id=stage_id,
            stage_index=stage_index,
            subject=subject,
            app_id=app_id,
            input_video=input_video,
            image_reference=image_reference,
            output_path=str(output_path),
            payload=stage_payload,
            context=context,
            resume_runninghub_task_id=resume_runninghub_task_id,
            stop_requested=context.cancelled,
        )
    else:
        submit_and_poll = getattr(backend, "_submit_and_poll", None)
        workflow_submit_url = getattr(backend, "_workflow_submit_url", None)
        if not callable(submit_and_poll) or not callable(workflow_submit_url):
            raise VideoDependencyError("replacement workflow provider is unavailable")
        video_url = _resolve_media_reference(
            backend=backend,
            task_id=task_id,
            payload=stage_payload,
            context=context,
            media_kind=f"replace_{subject}_video_stage_{stage_index}",
            value=input_video,
        )
        image_url = _resolve_media_reference(
            backend=backend,
            task_id=task_id,
            payload=stage_payload,
            context=context,
            media_kind=f"replace_{subject}_image_stage_{stage_index}",
            value=image_reference,
        )
        nodes = _workflow_nodes(
            subject=subject,
            app_id=app_id,
            payload=stage_payload,
            video_url=video_url,
            image_url=image_url,
        )
        result = _invoke(
            submit_and_poll,
            task_id=task_id,
            payload=stage_payload,
            context=context,
            submit_url=_invoke(workflow_submit_url, payload=stage_payload, app_id=app_id),
            submit_payload={
                "nodeInfoList": nodes,
                "instanceType": _text(
                    stage_payload.get("instance_type")
                    or stage_payload.get("runninghub_instance_type")
                    or "default"
                ),
                "usePersonalQueue": False,
            },
            output_path=output_path,
            label="model replacement" if subject == "model" else "product replacement",
        )
    context.check_cancelled()
    succeeded = _result_succeeded(result)
    returned_path = _text(
        result.get("download_path")
        or result.get("video_path")
        or result.get("output_path")
        if isinstance(result, dict)
        else ""
    )
    final_path = Path(returned_path or output_path).expanduser().resolve()
    output_url = _text(result.get("output_url") if isinstance(result, dict) else "")
    if succeeded and not final_path.exists() and not output_url.startswith(("http://", "https://")):
        succeeded = False
        if isinstance(result, dict):
            result = dict(result)
            result["message"] = _result_message(
                result,
                f"replacement workflow succeeded without output: {final_path}",
            )
    output_reference = output_url if output_url.startswith(("http://", "https://")) else str(final_path)
    task_ids = _extract_task_ids(result)
    record = {
        "stage_id": stage_id,
        "stage_index": stage_index,
        "subject": subject,
        "provider": "runninghub_workflow",
        "app_id": app_id,
        "status": "success" if succeeded else "failed",
        "input_video": input_video,
        "image_reference": image_reference,
        "output_path": str(final_path) if final_path.exists() else "",
        "output_url": output_url,
        "runninghub_task_id": task_ids[-1] if task_ids else "",
        "runninghub_task_ids": task_ids,
        "result": result,
    }
    return output_reference, record, succeeded


def _normalized_result(
    *,
    task_type: str,
    payload: dict[str, Any],
    ok: bool,
    message: str,
    final_reference: str,
    completed_stages: list[dict[str, Any]],
    runninghub_task_ids: list[str],
    usage: dict[str, Any],
    chains: dict[str, list[str]],
    checkpoint: dict[str, Any],
) -> dict[str, Any]:
    download_path = ""
    try:
        path = Path(final_reference).expanduser().resolve()
        if path.exists() and path.is_file():
            download_path = str(path)
    except (OSError, ValueError):
        pass
    duration_seconds = _positive_int(
        payload.get("duration_seconds") or payload.get("duration"),
        REPLACE_SUBJECT_FALLBACK_DURATION_SECONDS,
    )
    source_video_duration = _positive_float(
        payload.get("_replacement_source_video_duration_seconds")
    )
    duration_source = _text(payload.get("_replacement_duration_source")) or "payload"
    result = {
        "ok": bool(ok),
        "message": message,
        "task_type": task_type,
        "replacement_type": task_type,
        "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
        "runninghub_task_ids": list(runninghub_task_ids),
        "runninghub_usage": dict(usage),
        "download_path": download_path,
        "video_path": download_path,
        "output_url": final_reference if final_reference.startswith(("http://", "https://")) else "",
        "duration_seconds": duration_seconds,
        "duration_source": duration_source,
        "workflow_chains": {key: list(value) for key, value in chains.items()},
        "replacement_checkpoint": checkpoint,
        "video_checkpoint": {
            "replacement_checkpoint": checkpoint,
            "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
            "runninghub_task_ids": list(runninghub_task_ids),
        },
        "raw_result": {
            "steps": [dict(stage) for stage in completed_stages],
            "workflow_chains": {key: list(value) for key, value in chains.items()},
            "final_reference": final_reference,
            "duration_seconds": duration_seconds,
            "duration_source": duration_source,
            "source_video_duration_seconds": source_video_duration,
        },
    }
    if source_video_duration > 0:
        result["source_video_duration_seconds"] = source_video_duration
    if task_type == "replace_model":
        result["mode"] = archived_replace_model.normalize_mode(_text(payload.get("mode")))
        result["mode_label"] = _text(payload.get("mode_label") or result["mode"])
    return result


def run_replacement_pipeline(
    backend: Any,
    task_type: str,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
) -> dict[str, Any]:
    """Run a resumable model/product replacement workflow chain.

    Providers are injectable through ``_replacement_closed_image_provider`` and
    ``_replacement_workflow_provider``. Without injections, the pipeline uses
    the current archived backend's media resolver, image generator, and
    RunningHub submit/poll implementation.
    """

    normalized_type = _text(task_type)
    if normalized_type in _COMBINED_TASK_TYPES:
        normalized_type = "replace_product_and_model"
    if normalized_type not in {"replace_model", "replace_product", "replace_product_and_model"}:
        raise ValueError(f"unsupported replacement task type: {task_type}")
    request = dict(payload or {})
    context.check_cancelled()
    workdir = _workdir(backend, _text(task_id), request)
    chains = _replacement_chains(normalized_type, request)
    split_chains = {subject: _split_chain(chain) for subject, chain in chains.items()}
    for subject, (_closed, workflows) in split_chains.items():
        if not workflows:
            raise ValueError(
                f"{subject} replacement chain requires at least one RunningHub workflow"
            )

    initial_video = _initial_reference(request, "video")
    if not initial_video:
        raise ValueError("replacement requires a source video")
    duration_seconds, source_video_duration, duration_source = _resolve_replacement_duration(
        backend=backend,
        payload=request,
        context=context,
        source_reference=initial_video,
    )
    if source_video_duration <= 0 and _existing_local_video_path(initial_video) is not None:
        source_video_duration = _probe_source_video_duration(
            backend=backend,
            payload={key: value for key, value in request.items() if key not in {"duration", "duration_seconds"}},
            context=context,
            source_reference=initial_video,
        )
    request["duration_seconds"] = duration_seconds
    request["_replacement_source_video_duration_seconds"] = source_video_duration
    request["_replacement_duration_source"] = duration_source
    initial_video, preprocess = _prepare_replace_subject_source_video(
        task_id=_text(task_id),
        payload=request,
        source_video=initial_video,
        workdir=workdir,
        context=context,
    )
    request["video_local_path"] = initial_video
    request["source_video_local_path"] = initial_video
    request["_replacement_preprocess"] = preprocess
    image_references = {subject: _initial_reference(request, subject) for subject in chains}
    missing = [subject for subject, reference in image_references.items() if not reference]
    if missing:
        raise ValueError(f"replacement requires {' and '.join(missing)} reference image(s)")

    local_video = _existing_local_video_path(initial_video)
    if local_video is not None and _should_segment_replace_subject_video(
        request,
        source_duration_seconds=source_video_duration,
        target_duration_seconds=duration_seconds,
    ):
        total_duration = min(
            float(duration_seconds),
            float(source_video_duration or duration_seconds),
        )
        specs = _replace_subject_segment_specs(total_duration)
        if not specs:
            raise RuntimeError("long-video replacement could not calculate valid segments")
        context.progress(
            stage="replacement_segment",
            status="running",
            message=f"Splitting source video into {len(specs)} replacement segments",
            progress=5,
        )
        segment_results: list[dict[str, Any]] = []
        segment_paths: list[Path] = []
        runninghub_task_ids: list[str] = list(preprocess.get("runninghub_task_ids") or [])
        usage: dict[str, Any] = {}
        for offset, spec in enumerate(specs, start=1):
            context.check_cancelled()
            index = int(spec["index"])
            segment_source = workdir / f"replacement_segment_{index:03d}_source.mp4"
            cut_path = _cut_media_segment(
                local_video,
                segment_source,
                start_seconds=float(spec["start_seconds"]),
                duration_seconds=float(spec["duration_seconds"]),
                payload=request,
                context=context,
            )
            segment_payload = dict(request)
            segment_payload.update(
                {
                    "video_local_path": str(cut_path),
                    "source_video_local_path": str(cut_path),
                    "video_url": "",
                    "source_video_url": "",
                    "duration_seconds": max(int(math.ceil(float(spec["duration_seconds"]))), 1),
                    "_replace_subject_disable_segmentation": True,
                    "replace_subject_disable_subtitle_detection": True,
                    "resume_runninghub_task_id": "",
                }
            )
            context.progress(
                stage="replacement_segment",
                status="running",
                message=f"Replacing segment {offset}/{len(specs)}",
                progress=round(8 + 82 * (offset - 1) / max(len(specs), 1), 2),
            )
            result = run_replacement_pipeline(
                backend,
                normalized_type,
                f"{task_id}_segment_{index:03d}",
                segment_payload,
                context,
            )
            record = {
                "index": index,
                "start_seconds": float(spec["start_seconds"]),
                "duration_seconds": float(spec["duration_seconds"]),
                "result": result,
            }
            segment_results.append(record)
            for provider_task_id in _extract_task_ids(result):
                if provider_task_id not in runninghub_task_ids:
                    runninghub_task_ids.append(provider_task_id)
            _merge_usage(usage, result)
            if not bool(result.get("ok")):
                return {
                    "ok": False,
                    "status": "failed",
                    "message": _result_message(result, f"replacement segment {index} failed"),
                    "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
                    "runninghub_task_ids": runninghub_task_ids,
                    "runninghub_usage": usage,
                    "download_path": "",
                    "video_path": "",
                    "duration_seconds": duration_seconds,
                    "duration_source": f"{duration_source}_segmented",
                    "source_video_duration_seconds": source_video_duration,
                    "source_video_segmented": True,
                    "source_video_segments": segment_results,
                    "subject_preprocess": preprocess,
                    "raw_result": {"segments": segment_results, "subject_preprocess": preprocess},
                }
            output_text = _text(result.get("download_path") or result.get("video_path"))
            output = Path(output_text).expanduser().resolve() if output_text else Path()
            if not output_text or not output.exists() or not output.is_file():
                raise FileNotFoundError(f"replacement segment {index} completed without an output file")
            segment_paths.append(output)
        final_output = workdir / (
            "replace_model.mp4"
            if normalized_type == "replace_model"
            else "replace_product.mp4"
            if normalized_type == "replace_product"
            else "replace_product_and_model.mp4"
        )
        context.progress(
            stage="replacement_segment_concat",
            status="running",
            message="Concatenating replacement segments",
            progress=94,
        )
        final_path = _concat_media_segments(
            segment_paths,
            final_output,
            payload=request,
            context=context,
        )
        context.progress(stage="replacement", status="success", message="replacement completed", progress=100)
        result = {
            "ok": True,
            "status": "success",
            "message": "replacement completed",
            "task_type": normalized_type,
            "replacement_type": normalized_type,
            "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
            "runninghub_task_ids": runninghub_task_ids,
            "runninghub_usage": usage,
            "download_path": str(final_path),
            "video_path": str(final_path),
            "duration_seconds": duration_seconds,
            "duration_source": f"{duration_source}_segmented",
            "source_video_duration_seconds": source_video_duration,
            "source_video_segmented": True,
            "source_video_segments": segment_results,
            "subject_preprocess": preprocess,
            "raw_result": {"segments": segment_results, "subject_preprocess": preprocess},
        }
        if normalized_type == "replace_model":
            result["mode"] = archived_replace_model.normalize_mode(_text(request.get("mode")))
            result["mode_label"] = _text(request.get("mode_label") or result["mode"])
        return result

    resume_stages = _checkpoint_stage_map(request)
    completed_stages: list[dict[str, Any]] = []
    runninghub_task_ids: list[str] = []
    usage: dict[str, Any] = {}
    current_video = initial_video
    final_output = workdir / (
        "replace_model.mp4"
        if normalized_type == "replace_model"
        else "replace_product.mp4"
        if normalized_type == "replace_product"
        else "replace_product_and_model.mp4"
    )

    closed_sequence: list[tuple[str, int, str]] = []
    workflow_sequence: list[tuple[str, int, str]] = []
    for subject in ("model", "product"):
        if subject not in split_chains:
            continue
        closed, workflows = split_chains[subject]
        closed_sequence.extend((subject, index, value) for index, value in enumerate(closed, start=1))
        workflow_sequence.extend((subject, index, value) for index, value in enumerate(workflows, start=1))

    total_stages = len(closed_sequence) + len(workflow_sequence)
    progress_index = 0
    for subject, stage_index, stage_value in closed_sequence:
        context.check_cancelled()
        progress_index += 1
        stage_id = f"{subject}:closed:{stage_index:02d}"
        resumed = resume_stages.get(stage_id)
        resumed_output = _usable_stage_output(resumed or {})
        if resumed and resumed_output:
            record = dict(resumed)
            record["resumed"] = True
            image_references[subject] = resumed_output
        else:
            context.progress(
                stage="replacement",
                status="running",
                message=f"{subject} closed-image stage {stage_index}",
                progress=round((progress_index - 1) * 100 / max(total_stages, 1), 2),
            )
            image_references[subject], record = _run_closed_image_stage(
                backend=backend,
                task_id=_text(task_id),
                payload=request,
                context=context,
                subject=subject,
                stage_id=stage_id,
                stage_index=stage_index,
                stage_value=stage_value,
                input_reference=image_references[subject],
                workdir=workdir,
            )
        completed_stages.append(record)
        for provider_task_id in _extract_task_ids(record):
            if provider_task_id not in runninghub_task_ids:
                runninghub_task_ids.append(provider_task_id)
        _merge_usage(usage, record.get("result"))
        _checkpoint_callback(
            task_id=_text(task_id),
            payload=request,
            task_type=normalized_type,
            completed_stages=completed_stages,
            runninghub_task_ids=runninghub_task_ids,
        )

    first_pending_workflow = True
    for sequence_index, (subject, stage_index, app_id) in enumerate(workflow_sequence, start=1):
        context.check_cancelled()
        progress_index += 1
        stage_id = f"{subject}:workflow:{stage_index:02d}:{app_id}"
        resumed = resume_stages.get(stage_id)
        resumed_output = _usable_stage_output(resumed or {})
        if resumed and resumed_output:
            record = dict(resumed)
            record["resumed"] = True
            current_video = resumed_output
        else:
            is_last = sequence_index == len(workflow_sequence)
            output_path = final_output if is_last else (
                workdir / "replacement_stages" / f"{subject}_workflow_{stage_index:02d}.mp4"
            )
            output_path.parent.mkdir(parents=True, exist_ok=True)
            context.progress(
                stage="replacement",
                status="running",
                message=f"{subject} workflow {stage_index}/{len(split_chains[subject][1])}",
                progress=round((progress_index - 1) * 100 / max(total_stages, 1), 2),
            )
            current_video, record, succeeded = _run_workflow_stage(
                backend=backend,
                task_id=_text(task_id),
                payload=request,
                context=context,
                subject=subject,
                stage_id=stage_id,
                stage_index=stage_index,
                app_id=app_id,
                input_video=current_video,
                image_reference=image_references[subject],
                output_path=output_path,
                resume_runninghub_task_id=(
                    _text(request.get("resume_runninghub_task_id"))
                    if first_pending_workflow
                    else ""
                ),
            )
            first_pending_workflow = False
            if not succeeded:
                all_steps = [*completed_stages, record]
                for provider_task_id in _extract_task_ids(record):
                    if provider_task_id not in runninghub_task_ids:
                        runninghub_task_ids.append(provider_task_id)
                _merge_usage(usage, record.get("result"))
                checkpoint = _checkpoint_callback(
                    task_id=_text(task_id),
                    payload=request,
                    task_type=normalized_type,
                    completed_stages=completed_stages,
                    runninghub_task_ids=runninghub_task_ids,
                )
                failed = _normalized_result(
                    task_type=normalized_type,
                    payload=request,
                    ok=False,
                    message=_result_message(record.get("result"), "replacement workflow failed"),
                    final_reference="",
                    completed_stages=all_steps,
                    runninghub_task_ids=runninghub_task_ids,
                    usage=usage,
                    chains=chains,
                    checkpoint=checkpoint,
                )
                failed["raw_result"]["failed_stage"] = record
                return failed
        completed_stages.append(record)
        for provider_task_id in _extract_task_ids(record):
            if provider_task_id not in runninghub_task_ids:
                runninghub_task_ids.append(provider_task_id)
        _merge_usage(usage, record.get("result"))
        _checkpoint_callback(
            task_id=_text(task_id),
            payload=request,
            task_type=normalized_type,
            completed_stages=completed_stages,
            runninghub_task_ids=runninghub_task_ids,
            final_output_path=current_video if sequence_index == len(workflow_sequence) else "",
        )

    context.check_cancelled()
    checkpoint = _checkpoint_callback(
        task_id=_text(task_id),
        payload=request,
        task_type=normalized_type,
        completed_stages=completed_stages,
        runninghub_task_ids=runninghub_task_ids,
        final_output_path=current_video,
    )
    context.progress(
        stage="replacement",
        status="success",
        message="replacement completed",
        progress=100,
    )
    return _normalized_result(
        task_type=normalized_type,
        payload=request,
        ok=True,
        message="replacement completed",
        final_reference=current_video,
        completed_stages=completed_stages,
        runninghub_task_ids=runninghub_task_ids,
        usage=usage,
        chains=chains,
        checkpoint=checkpoint,
    ) | {"subject_preprocess": preprocess}


__all__ = ["run_replacement_pipeline"]
