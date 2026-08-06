from __future__ import annotations

import inspect
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .contracts import VideoTaskCancelled, VideoTaskContext


ProbeCallback = Callable[..., Any]
RunCallback = Callable[..., Any]


@dataclass(frozen=True)
class _ProcessResult:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "y"}:
        return True
    if text in {"0", "false", "no", "off", "n"}:
        return False
    return bool(default)


def _invoke(callback: Callable[..., Any], **kwargs: Any) -> Any:
    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return callback(**kwargs)
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
        return callback(**kwargs)
    accepted = {key: value for key, value in kwargs.items() if key in signature.parameters}
    return callback(**accepted)


def _normalize_process_result(value: Any) -> _ProcessResult:
    if isinstance(value, _ProcessResult):
        return value
    if isinstance(value, dict):
        return _ProcessResult(
            returncode=int(value.get("returncode") or 0),
            stdout=str(value.get("stdout") or ""),
            stderr=str(value.get("stderr") or ""),
        )
    if isinstance(value, tuple):
        return _ProcessResult(
            returncode=int(value[0] if value else 0),
            stdout=str(value[1] if len(value) > 1 else ""),
            stderr=str(value[2] if len(value) > 2 else ""),
        )
    if hasattr(value, "returncode"):
        return _ProcessResult(
            returncode=int(getattr(value, "returncode", 0) or 0),
            stdout=str(getattr(value, "stdout", "") or ""),
            stderr=str(getattr(value, "stderr", "") or ""),
        )
    return _ProcessResult(returncode=int(value or 0))


def _check_cancelled(context: VideoTaskContext | None) -> None:
    if context is not None:
        context.check_cancelled()


def _run_process(
    command: list[str],
    *,
    payload: dict[str, Any] | None,
    context: VideoTaskContext | None,
    run: RunCallback | None,
    timeout_seconds: int,
) -> _ProcessResult:
    _check_cancelled(context)
    if callable(run):
        value = _invoke(
            run,
            command=command,
            args=command,
            payload=payload or {},
            context=context,
            timeout_seconds=timeout_seconds,
            timeout=timeout_seconds,
        )
        result = _normalize_process_result(value)
    else:
        result = _normalize_process_result(
            subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        )
    _check_cancelled(context)
    return result


def _resolve_ffmpeg_exe(payload: dict[str, Any] | None = None) -> str:
    configured = str((payload or {}).get("ffmpeg_path") or "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.exists() and configured_path.is_file():
            return str(configured_path.resolve())
        resolved = shutil.which(configured)
        if resolved:
            return resolved
        return configured
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise RuntimeError("缺少 ffmpeg，无法执行数字人音频后处理") from exc


def _probe_video_duration_seconds(
    video_path: Path,
    default_seconds: float = 15.0,
    *,
    payload: dict[str, Any] | None,
    context: VideoTaskContext | None,
    probe: ProbeCallback | None,
) -> float:
    source = Path(video_path).expanduser().resolve()
    _check_cancelled(context)
    if not callable(probe):
        return max(float(default_seconds or 0.0), 0.0)
    value = _invoke(
        probe,
        path=source,
        video_path=source,
        media_path=source,
        default_seconds=default_seconds,
        payload=payload or {},
        context=context,
    )
    _check_cancelled(context)
    if isinstance(value, dict):
        value = value.get("duration_seconds", value.get("duration", value.get("value")))
    duration = _to_float(value, 0.0)
    return duration if duration > 0 else max(float(default_seconds or 0.0), 0.0)


def _compact_ffmpeg_error(
    stderr: Any,
    stdout: Any = "",
    *,
    fallback: str = "ffmpeg failed",
    limit: int = 1000,
) -> str:
    text = f"{stderr or ''}\n{stdout or ''}".strip()
    if not text:
        return fallback
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return " | ".join(lines[-8:])[-max(int(limit), 1) :] or fallback


def _delay_video_audio_track(
    input_path: Path,
    output_path: Path,
    *,
    delay_seconds: float = 0.8,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> Path:
    source = Path(input_path).expanduser().resolve()
    delay_ms = max(int(round(float(delay_seconds or 0.0) * 1000)), 0)
    if delay_ms <= 0:
        return source
    duration = _probe_video_duration_seconds(
        source,
        default_seconds=0.0,
        payload=payload,
        context=context,
        probe=probe,
    )
    if duration <= 0:
        duration = _probe_video_duration_seconds(
            source,
            payload=payload,
            context=context,
            probe=probe,
        )
    ffmpeg = _resolve_ffmpeg_exe(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_duration = max(float(duration or 0.0) + float(delay_seconds or 0.0), 0.1)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-filter_complex",
        f"[0:v]tpad=stop_mode=clone:stop_duration={float(delay_seconds or 0.0):.3f}[v];[0:a]adelay={delay_ms}:all=1[a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        f"{output_duration:.3f}",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    proc = _run_process(
        cmd,
        payload=payload,
        context=context,
        run=run,
        timeout_seconds=300,
    )
    if proc.returncode != 0 or not output_path.exists():
        raise RuntimeError((proc.stderr or proc.stdout or "ffmpeg audio delay failed").strip()[:800])
    return output_path.resolve()


def _digital_human_audio_delay_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    value = source.get("digital_human_audio_delay_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_AUDIO_DELAY_SECONDS", "0")
    return max(_to_float(value, 0.0), 0.0)


def _apply_digital_human_audio_delay(
    video_path: Path,
    *,
    output_path: Path | None = None,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> tuple[Path, dict[str, Any] | None]:
    _check_cancelled(context)
    delay_seconds = _digital_human_audio_delay_seconds(payload)
    source = Path(video_path).expanduser().resolve()
    if delay_seconds <= 0:
        return source, None
    target = output_path or source.with_name(
        f"{source.stem}_audio_delay_{int(round(delay_seconds * 1000))}ms{source.suffix or '.mp4'}"
    )
    delayed = _delay_video_audio_track(
        source,
        target,
        delay_seconds=delay_seconds,
        payload=payload,
        context=context,
        probe=probe,
        run=run,
    )
    return delayed, {
        "input_path": str(source),
        "output_path": str(delayed),
        "delay_seconds": delay_seconds,
    }


def _digital_human_video_end_padding_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    value = source.get("digital_human_video_end_padding_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_VIDEO_END_PADDING_SECONDS", "0")
    return max(_to_float(value, 0.0), 0.0)


def _pad_video_audio_tail(
    input_path: Path,
    output_path: Path,
    *,
    padding_seconds: float,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> Path:
    source = Path(input_path).expanduser().resolve()
    pad_seconds = max(float(padding_seconds or 0.0), 0.0)
    if pad_seconds <= 0:
        return source
    duration = _probe_video_duration_seconds(
        source,
        default_seconds=0.0,
        payload=payload,
        context=context,
        probe=probe,
    )
    if duration <= 0:
        return source
    ffmpeg = _resolve_ffmpeg_exe(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_duration = max(float(duration) + pad_seconds, 0.1)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-filter_complex",
        f"[0:v]tpad=stop_mode=clone:stop_duration={pad_seconds:.3f}[v];"
        f"[0:a]apad=pad_dur={pad_seconds:.3f}[a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        f"{output_duration:.3f}",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    proc = _run_process(
        cmd,
        payload=payload,
        context=context,
        run=run,
        timeout_seconds=600,
    )
    if proc.returncode != 0 or not output_path.exists():
        raise RuntimeError(_compact_ffmpeg_error(proc.stderr, proc.stdout, fallback="ffmpeg tail padding failed"))
    return output_path.resolve()


def _apply_digital_human_video_end_padding(
    video_path: Path,
    *,
    output_path: Path | None = None,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> tuple[Path, dict[str, Any] | None]:
    _check_cancelled(context)
    padding_seconds = _digital_human_video_end_padding_seconds(payload)
    source = Path(video_path).expanduser().resolve()
    if padding_seconds <= 0:
        return source, None
    target = output_path or source.with_name(f"{source.stem}_tail_pad{source.suffix or '.mp4'}")
    padded = _pad_video_audio_tail(
        source,
        target,
        padding_seconds=padding_seconds,
        payload=payload,
        context=context,
        probe=probe,
        run=run,
    )
    return padded, {
        "input_path": str(source),
        "output_path": str(padded),
        "padding_seconds": round(float(padding_seconds), 3),
    }


def _segment_durations_with_final_tail_padding(
    segment_durations: list[float],
    tail_padding_meta: dict[str, Any] | None,
    expected_count: int,
) -> list[float] | None:
    if len(segment_durations) != int(expected_count or 0):
        return None
    durations = [float(item or 0.0) for item in segment_durations]
    if durations and tail_padding_meta:
        durations[-1] += max(float(tail_padding_meta.get("padding_seconds") or 0.0), 0.0)
    return durations


def _segment_durations_with_join_crossfade(
    segment_durations: list[float],
    *,
    crossfade_seconds: float,
    expected_count: int,
) -> list[float] | None:
    if len(segment_durations) != int(expected_count or 0):
        return None
    durations = [max(float(item or 0.0), 0.0) for item in segment_durations]
    overlap = max(float(crossfade_seconds or 0.0), 0.0)
    if overlap <= 0 or len(durations) <= 1:
        return durations
    for index in range(len(durations) - 1):
        durations[index] = max(durations[index] - overlap, 0.01)
    return durations


def _build_digital_human_segment_preview_videos(
    segment_paths: list[Path],
    *,
    output_dir: Path,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> tuple[list[Path], list[dict[str, Any]]]:
    padding_seconds = _digital_human_video_end_padding_seconds(payload)
    output_dir.mkdir(parents=True, exist_ok=True)
    preview_paths: list[Path] = []
    meta: list[dict[str, Any]] = []
    for idx, path in enumerate(segment_paths, start=1):
        _check_cancelled(context)
        source = Path(path).expanduser().resolve()
        if padding_seconds <= 0 or not source.exists():
            preview_paths.append(source)
            meta.append({"index": idx, "input_path": str(source), "output_path": str(source), "padding_seconds": 0.0})
            continue
        target = output_dir / f"{idx}_preview_tail_pad{source.suffix or '.mp4'}"
        try:
            padded = _pad_video_audio_tail(
                source,
                target,
                padding_seconds=padding_seconds,
                payload=payload,
                context=context,
                probe=probe,
                run=run,
            )
            preview_paths.append(padded)
            meta.append(
                {
                    "index": idx,
                    "input_path": str(source),
                    "output_path": str(padded),
                    "padding_seconds": round(float(padding_seconds), 3),
                }
            )
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            preview_paths.append(source)
            meta.append(
                {
                    "index": idx,
                    "input_path": str(source),
                    "output_path": str(source),
                    "padding_seconds": 0.0,
                    "error": str(exc)[:240],
                }
            )
    return preview_paths, meta


_DIGITAL_HUMAN_AMBIENT_OUTDOOR_RE = re.compile(
    r"室外|户外|戶外|外景|外观|外觀|外立面|街道|街景|道路|马路|馬路|人行道|路边|路邊|停车场|停車場|"
    r"建筑|建築|楼盘|樓盤|公寓|住宅|小区|社區|社区|入口|门头|門頭|庭院|花园|花園|阳台|陽台|露台|"
    r"outdoor|exterior|facade|street|road|sidewalk|building|apartment|garden|parking|entrance",
    re.I,
)
_DIGITAL_HUMAN_AMBIENT_NATURE_RE = re.compile(
    r"自然|树林|樹林|树木|樹木|绿植|綠植|草地|公园|公園|河边|河邊|海边|海邊|湖边|湖邊|山景|风声|風聲|"
    r"nature|park|tree|garden|river|sea|lake|wind",
    re.I,
)
_DIGITAL_HUMAN_AMBIENT_INDOOR_RE = re.compile(
    r"室内|室內|内景|內景|房间|房間|客厅|客廳|卧室|臥室|厨房|廚房|卫浴|衛浴|浴室|玄关|玄關|走廊|"
    r"办公室|辦公室|大堂|店内|店內|展厅|展廳|indoor|interior|room|kitchen|living|bedroom|office|lobby",
    re.I,
)


def _digital_human_ambient_audio_enabled(payload: dict[str, Any] | None = None) -> bool:
    source = payload or {}
    for key in ("digital_human_ambient_audio_enabled", "ambient_audio_enabled", "scene_ambient_audio_enabled"):
        if key in source:
            return _to_bool(source.get(key), True)
    return _to_bool(os.getenv("DIGITAL_HUMAN_AMBIENT_AUDIO_ENABLED", "true"), True)


def _digital_human_ambient_context_text(payload: dict[str, Any] | None) -> str:
    source = payload or {}
    parts: list[str] = []
    for key in (
        "product_category",
        "category",
        "industry",
        "product_name",
        "product_project_name",
        "project_name",
        "product_details",
        "product_description",
        "product_intro",
        "speech_text",
        "prompt_text",
        "copy_text",
        "digital_human_ambient_scene_hint",
    ):
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    analysis = source.get("digital_human_product_reference_analysis")
    if isinstance(analysis, dict):
        parts.append(json.dumps(analysis, ensure_ascii=False))
    for key in ("digital_human_scene_image_local_paths", "scene_image_local_paths", "product_image_local_paths"):
        value = source.get(key)
        if isinstance(value, list):
            parts.extend(Path(str(item or "")).name for item in value if str(item or "").strip())
        elif isinstance(value, str) and value.strip():
            parts.append(Path(value).name)
    return "\n".join(parts)[:8000]


def _digital_human_ambient_scene_kind(payload: dict[str, Any] | None = None) -> str:
    source = payload or {}
    explicit = str(source.get("digital_human_ambient_scene") or source.get("ambient_scene") or "").strip().lower()
    if explicit in {"none", "off", "disable", "disabled", "false", "no", "无", "关闭"}:
        return "none"
    if explicit in {"street", "urban", "city", "outdoor", "室外", "街道", "户外", "戶外"}:
        return "street"
    if explicit in {"nature", "park", "garden", "自然", "花园", "花園"}:
        return "nature"
    if explicit in {"indoor", "room", "interior", "室内", "室內"}:
        return "indoor"

    context = _digital_human_ambient_context_text(source)
    if not context.strip():
        return "none"
    if _DIGITAL_HUMAN_AMBIENT_NATURE_RE.search(context):
        return "nature"
    if _DIGITAL_HUMAN_AMBIENT_OUTDOOR_RE.search(context):
        return "street"
    if _DIGITAL_HUMAN_AMBIENT_INDOOR_RE.search(context):
        return "indoor"
    return "none"


def _digital_human_ambient_filter_for_scene(scene_kind: str, duration_seconds: float) -> tuple[str, str, str]:
    scene = str(scene_kind or "").strip().lower()
    duration = max(float(duration_seconds or 0.0), 0.1)
    if scene == "nature":
        source = "anoisesrc=color=brown:amplitude=0.032:sample_rate=48000"
        filters = "highpass=f=70,lowpass=f=2400,volume=0.85"
        label = "自然白噪音"
    elif scene == "indoor":
        source = "anoisesrc=color=pink:amplitude=0.020:sample_rate=48000"
        filters = "highpass=f=120,lowpass=f=3200,volume=0.65"
        label = "室内空间底噪"
    else:
        source = "anoisesrc=color=pink:amplitude=0.030:sample_rate=48000"
        filters = "highpass=f=90,lowpass=f=4200,volume=0.80"
        label = "街道环境白噪音"
    if duration >= 3.0:
        filters = f"{filters},afade=t=in:st=0:d=0.8,afade=t=out:st={max(duration - 0.8, 0.0):.3f}:d=0.8"
    return source, filters, label


def _apply_digital_human_ambient_audio(
    video_path: Path,
    *,
    output_path: Path | None = None,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> tuple[Path, dict[str, Any] | None]:
    _check_cancelled(context)
    source = Path(video_path).expanduser().resolve()
    if not source.exists():
        return source, None
    if not _digital_human_ambient_audio_enabled(payload):
        return source, None
    scene_kind = _digital_human_ambient_scene_kind(payload)
    if scene_kind == "none":
        return source, None

    duration = _probe_video_duration_seconds(
        source,
        default_seconds=0.0,
        payload=payload,
        context=context,
        probe=probe,
    )
    if duration <= 0:
        return source, None
    ambient_source, ambient_filters, label = _digital_human_ambient_filter_for_scene(scene_kind, duration)
    target = output_path or source.with_name(f"{source.stem}_ambient_{scene_kind}{source.suffix or '.mp4'}")
    ffmpeg = _resolve_ffmpeg_exe(payload)
    target.parent.mkdir(parents=True, exist_ok=True)
    filter_complex = (
        "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,"
        "aecho=0.98:1.0:70|145:0.055|0.03[voice];"
        f"[1:a]{ambient_filters},aformat=sample_rates=48000:channel_layouts=stereo[amb];"
        "[voice][amb]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
        "volume=1.35,alimiter=limit=0.988553[a]"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-f",
        "lavfi",
        "-t",
        f"{duration:.3f}",
        "-i",
        ambient_source,
        "-filter_complex",
        filter_complex,
        "-map",
        "0:v:0",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(target),
    ]
    proc = _run_process(
        cmd,
        payload=payload,
        context=context,
        run=run,
        timeout_seconds=600,
    )
    if proc.returncode != 0 or not target.exists():
        raise RuntimeError(_compact_ffmpeg_error(proc.stderr, proc.stdout, fallback="ffmpeg ambient audio mix failed"))
    return target.resolve(), {
        "input_path": str(source),
        "output_path": str(target.resolve()),
        "enabled": True,
        "scene": scene_kind,
        "label": label,
        "duration_seconds": round(float(duration), 3),
        "ambient_source": ambient_source,
        "ambient_filters": ambient_filters,
    }


def postprocess_digital_human_audio(
    video_path: str | Path,
    *,
    payload: dict[str, Any] | None,
    context: VideoTaskContext,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> tuple[Path, dict[str, Any]]:
    """Apply archived delay, ambient mix, and tail padding with stage-local fallback."""

    current = Path(video_path).expanduser().resolve()
    warnings: list[str] = []
    audio_delay_meta: dict[str, Any] | None = None
    ambient_audio_meta: dict[str, Any] | None = None
    tail_padding_meta: dict[str, Any] | None = None
    _check_cancelled(context)

    try:
        current, audio_delay_meta = _apply_digital_human_audio_delay(
            current,
            output_path=current.with_name(f"{current.stem}_audio_delay.mp4"),
            payload=payload,
            context=context,
            probe=probe,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception as exc:
        warnings.append(f"audio_delay_failed: {exc}")
    try:
        current, ambient_audio_meta = _apply_digital_human_ambient_audio(
            current,
            output_path=current.with_name(f"{current.stem}_ambient.mp4"),
            payload=payload,
            context=context,
            probe=probe,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception as exc:
        warnings.append(f"ambient_audio_failed: {exc}")
    try:
        current, tail_padding_meta = _apply_digital_human_video_end_padding(
            current,
            output_path=current.with_name(f"{current.stem}_tail_pad.mp4"),
            payload=payload,
            context=context,
            probe=probe,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception as exc:
        warnings.append(f"tail_padding_failed: {exc}")
    return current, {
        "audio_delay": audio_delay_meta,
        "ambient_audio": ambient_audio_meta,
        "tail_padding": tail_padding_meta,
        "warnings": warnings,
    }


def build_digital_human_segment_previews(
    segment_paths: Iterable[str | Path],
    *,
    output_dir: str | Path,
    payload: dict[str, Any] | None,
    context: VideoTaskContext,
    probe: ProbeCallback | None = None,
    run: RunCallback | None = None,
) -> tuple[list[Path], list[dict[str, Any]]]:
    """Build independently padded preview segments, falling back per failed segment."""

    return _build_digital_human_segment_preview_videos(
        [Path(path) for path in segment_paths],
        output_dir=Path(output_dir).expanduser().resolve(),
        payload=payload,
        context=context,
        probe=probe,
        run=run,
    )


def adjust_digital_human_segment_durations(
    segment_durations: Iterable[float],
    *,
    expected_count: int,
    crossfade_seconds: float = 0.0,
    tail_padding_meta: dict[str, Any] | None = None,
) -> list[float] | None:
    """Apply archived join-overlap and final-tail timing adjustments."""

    adjusted = _segment_durations_with_join_crossfade(
        list(segment_durations),
        crossfade_seconds=crossfade_seconds,
        expected_count=expected_count,
    )
    if adjusted is None:
        return None
    return _segment_durations_with_final_tail_padding(adjusted, tail_padding_meta, expected_count)


__all__ = [
    "adjust_digital_human_segment_durations",
    "build_digital_human_segment_previews",
    "postprocess_digital_human_audio",
]
