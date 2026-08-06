from __future__ import annotations

import inspect
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .contracts import VideoTaskCancelled, VideoTaskContext


ProbeRunner = Callable[..., Any]
ProcessRunner = Callable[..., Any]


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


def _check_cancelled(context: VideoTaskContext | None) -> None:
    if context is not None:
        context.check_cancelled()


def _log(context: VideoTaskContext | None, message: Any) -> None:
    if context is not None:
        context.log(message)


def _invoke(callback: Callable[..., Any], **kwargs: Any) -> Any:
    """Invoke injected adapters without forcing one exact callback signature."""

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


def _run_process(
    command: list[str],
    *,
    run: ProcessRunner | None,
    context: VideoTaskContext | None,
    timeout_seconds: int,
) -> _ProcessResult:
    _check_cancelled(context)
    if callable(run):
        value = _invoke(
            run,
            command=command,
            args=command,
            context=context,
            timeout_seconds=timeout_seconds,
            timeout=timeout_seconds,
        )
        result = _normalize_process_result(value)
    else:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=max(int(timeout_seconds), 1),
            check=False,
        )
        result = _normalize_process_result(completed)
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
        # An injected runner may intentionally use a virtual executable name.
        return configured
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise RuntimeError("ffmpeg is required for digital-human segment cleanup") from exc


def _resolve_ffprobe_exe(payload: dict[str, Any] | None = None) -> str:
    configured = str((payload or {}).get("ffprobe_path") or "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if configured_path.exists() and configured_path.is_file():
            return str(configured_path.resolve())
        return shutil.which(configured) or configured
    return shutil.which("ffprobe") or "ffprobe"


def _probe_video_duration_seconds(
    video_path: Path,
    default_seconds: float = 15.0,
    *,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> float:
    source = Path(video_path).expanduser().resolve()
    _check_cancelled(context)
    try:
        if callable(probe):
            value = _invoke(probe, path=source, media_path=source, payload=payload or {}, context=context)
            if isinstance(value, dict):
                value = value.get("duration_seconds", value.get("duration", value.get("value")))
            duration = _to_float(value, 0.0)
        else:
            result = _run_process(
                [
                    _resolve_ffprobe_exe(payload),
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(source),
                ],
                run=run,
                context=context,
                timeout_seconds=30,
            )
            duration = _to_float(result.stdout.strip(), 0.0) if result.returncode == 0 else 0.0
        return duration if duration > 0 else max(float(default_seconds or 0.0), 0.0)
    except VideoTaskCancelled:
        raise
    except Exception as exc:
        _log(context, f"digital-human duration probe failed for {source}: {exc}")
        return max(float(default_seconds or 0.0), 0.0)


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


def _detect_audio_silence_ranges(
    media_path: Path,
    *,
    duration_seconds: float,
    noise_db: str = "-34dB",
    min_silence: float = 0.12,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    run: ProcessRunner | None = None,
) -> list[tuple[float, float]]:
    if duration_seconds <= 0:
        return []
    proc = _run_process(
        [
            _resolve_ffmpeg_exe(payload),
            "-hide_banner",
            "-i",
            str(media_path),
            "-af",
            f"silencedetect=noise={noise_db}:d={max(float(min_silence or 0.0), 0.05):.3f}",
            "-f",
            "null",
            "-",
        ],
        run=run,
        context=context,
        timeout_seconds=120,
    )
    text = f"{proc.stdout or ''}\n{proc.stderr or ''}"
    if proc.returncode != 0 and not text.strip():
        return []
    ranges: list[tuple[float, float]] = []
    current_start: float | None = None
    for line in text.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            try:
                current_start = max(float(start_match.group(1)), 0.0)
            except Exception:
                current_start = None
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match and current_start is not None:
            try:
                end_value = min(max(float(end_match.group(1)), current_start), duration_seconds)
            except Exception:
                end_value = current_start
            if end_value - current_start >= min_silence:
                ranges.append((current_start, end_value))
            current_start = None
    if current_start is not None and duration_seconds - current_start >= min_silence:
        ranges.append((current_start, duration_seconds))
    return ranges


# The configuration and trim functions below retain the archived platform's
# defaults, clamps, ordering, output names, and failure-degradation behavior.
def _digital_human_segment_tail_cooldown_enabled(payload: dict[str, Any] | None = None) -> bool:
    source = payload or {}
    if "digital_human_segment_tail_cooldown_enabled" in source:
        return _to_bool(source.get("digital_human_segment_tail_cooldown_enabled"), True)
    return _to_bool(os.getenv("DIGITAL_HUMAN_SEGMENT_TAIL_COOLDOWN_ENABLED", "true"), True)


def _digital_human_segment_tail_cooldown_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    value = source.get("digital_human_segment_tail_cooldown_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_SEGMENT_TAIL_COOLDOWN_SECONDS", "0.35")
    return min(max(_to_float(value, 0.35), 0.12), 1.2)


def _digital_human_segment_tail_max_silence_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    target = _digital_human_segment_tail_cooldown_seconds(source)
    value = source.get("digital_human_segment_tail_max_silence_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_SEGMENT_TAIL_MAX_SILENCE_SECONDS", "0.65")
    return max(_to_float(value, 0.65), target + 0.08)


def _digital_human_segment_leading_silence_enabled(payload: dict[str, Any] | None = None) -> bool:
    source = payload or {}
    if "digital_human_segment_leading_silence_enabled" in source:
        return _to_bool(source.get("digital_human_segment_leading_silence_enabled"), True)
    return _to_bool(os.getenv("DIGITAL_HUMAN_SEGMENT_LEADING_SILENCE_ENABLED", "true"), True)


def _digital_human_segment_head_keep_silence_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    value = source.get("digital_human_segment_head_keep_silence_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_SEGMENT_HEAD_KEEP_SILENCE_SECONDS", "0.04")
    return min(max(_to_float(value, 0.04), 0.0), 0.18)


def _digital_human_segment_head_max_silence_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    keep_silence = _digital_human_segment_head_keep_silence_seconds(source)
    value = source.get("digital_human_segment_head_max_silence_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_SEGMENT_HEAD_MAX_SILENCE_SECONDS", "0.08")
    return max(_to_float(value, 0.08), keep_silence + 0.02)


def _digital_human_segment_join_gap_budget_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    value = source.get("digital_human_segment_join_gap_budget_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_SEGMENT_JOIN_GAP_BUDGET_SECONDS", "0.24")
    return min(max(_to_float(value, 0.24), 0.16), 0.8)


def _digital_human_segment_join_min_tail_quiet_seconds(payload: dict[str, Any] | None = None) -> float:
    source = payload or {}
    value = source.get("digital_human_segment_join_min_tail_quiet_seconds")
    if value is None:
        value = os.getenv("DIGITAL_HUMAN_SEGMENT_JOIN_MIN_TAIL_QUIET_SECONDS", "0.16")
    return min(max(_to_float(value, 0.16), 0.10), 0.5)


def _detect_digital_human_trailing_silence_seconds(
    media_path: Path,
    *,
    duration_seconds: float | None = None,
    min_silence_seconds: float = 0.06,
    tail_tolerance_seconds: float = 0.18,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> float:
    duration = float(duration_seconds or 0.0)
    if duration <= 0:
        duration = _probe_video_duration_seconds(
            media_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
    if duration <= 0:
        return 0.0
    try:
        silence_ranges = _detect_audio_silence_ranges(
            media_path,
            duration_seconds=duration,
            noise_db="-38dB",
            min_silence=min_silence_seconds,
            payload=payload,
            context=context,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception:
        return 0.0
    for silence_start, silence_end in reversed(silence_ranges):
        if duration - silence_end <= tail_tolerance_seconds:
            return max(duration - silence_start, 0.0)
    return 0.0


def _detect_digital_human_leading_silence_seconds(
    media_path: Path,
    *,
    duration_seconds: float | None = None,
    min_silence_seconds: float = 0.06,
    start_tolerance_seconds: float = 0.04,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> float:
    duration = float(duration_seconds or 0.0)
    if duration <= 0:
        duration = _probe_video_duration_seconds(
            media_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
    if duration <= 0:
        return 0.0
    try:
        silence_ranges = _detect_audio_silence_ranges(
            media_path,
            duration_seconds=duration,
            noise_db="-38dB",
            min_silence=min_silence_seconds,
            payload=payload,
            context=context,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception:
        return 0.0
    if not silence_ranges:
        return 0.0
    silence_start, silence_end = silence_ranges[0]
    if silence_start > start_tolerance_seconds:
        return 0.0
    return max(silence_end - max(silence_start, 0.0), 0.0)


def _digital_human_leading_silence_trim_seconds(
    media_path: Path,
    *,
    duration_seconds: float | None = None,
    keep_quiet_seconds: float = 0.04,
    max_quiet_seconds: float = 0.08,
    min_silence_seconds: float = 0.06,
    start_tolerance_seconds: float = 0.04,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> float | None:
    duration = float(duration_seconds or 0.0)
    if duration <= 0:
        duration = _probe_video_duration_seconds(
            media_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
    keep_quiet = min(max(float(keep_quiet_seconds or 0.0), 0.0), 0.18)
    max_quiet = max(float(max_quiet_seconds or 0.08), keep_quiet + 0.02)
    min_silence = min(max(float(min_silence_seconds or 0.06), 0.05), max_quiet)
    if duration <= 0.3:
        return None
    try:
        silence_ranges = _detect_audio_silence_ranges(
            media_path,
            duration_seconds=duration,
            noise_db="-38dB",
            min_silence=min_silence,
            payload=payload,
            context=context,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception:
        return None
    if not silence_ranges:
        return None
    silence_start, silence_end = silence_ranges[0]
    if silence_start > start_tolerance_seconds:
        return None
    leading_silence_seconds = max(silence_end - max(silence_start, 0.0), 0.0)
    if leading_silence_seconds <= max_quiet:
        return None
    trim_start = min(max(leading_silence_seconds - keep_quiet, 0.0), duration - 0.12)
    if trim_start < 0.02:
        return None
    return round(trim_start, 3)


def _digital_human_tail_cooldown_trim_seconds(
    media_path: Path,
    *,
    duration_seconds: float | None = None,
    target_quiet_seconds: float = 0.35,
    max_quiet_seconds: float = 0.65,
    min_silence_seconds: float = 0.12,
    tail_tolerance_seconds: float = 0.18,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> float | None:
    duration = float(duration_seconds or 0.0)
    if duration <= 0:
        duration = _probe_video_duration_seconds(
            media_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
    target_quiet = min(max(float(target_quiet_seconds or 0.35), 0.12), 1.2)
    max_quiet = max(float(max_quiet_seconds or 0.65), target_quiet + 0.08)
    min_silence = min(max(float(min_silence_seconds or 0.12), 0.06), max_quiet)
    if duration <= max(0.8, target_quiet + 0.3):
        return None
    try:
        silence_ranges = _detect_audio_silence_ranges(
            media_path,
            duration_seconds=duration,
            noise_db="-38dB",
            min_silence=min_silence,
            payload=payload,
            context=context,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception:
        return None
    for silence_start, silence_end in reversed(silence_ranges):
        if duration - silence_end > tail_tolerance_seconds:
            continue
        tail_silence_seconds = max(duration - silence_start, 0.0)
        if tail_silence_seconds <= max_quiet:
            return None
        trim_at = min(max(silence_start + target_quiet, 0.2), duration - 0.05)
        if duration - trim_at < 0.12:
            return None
        return round(trim_at, 3)
    return None


def _trim_video_tail_cooldown(
    input_path: Path,
    output_path: Path,
    *,
    target_quiet_seconds: float = 0.35,
    max_quiet_seconds: float = 0.65,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> Path:
    source = Path(input_path).expanduser().resolve()
    duration = _probe_video_duration_seconds(
        source, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
    )
    trim_at = _digital_human_tail_cooldown_trim_seconds(
        source,
        duration_seconds=duration,
        target_quiet_seconds=target_quiet_seconds,
        max_quiet_seconds=max_quiet_seconds,
        payload=payload,
        context=context,
        probe=probe,
        run=run,
    )
    if trim_at is None:
        return source
    ffmpeg = _resolve_ffmpeg_exe(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration_tolerance = max(0.08, min(float(max_quiet_seconds) - float(target_quiet_seconds), 0.18))
    copy_cmd = [
        ffmpeg,
        "-y",
        "-t",
        f"{trim_at:.3f}",
        "-i",
        str(source),
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        str(output_path),
    ]
    proc = _run_process(copy_cmd, run=run, context=context, timeout_seconds=180)
    copy_ok = proc.returncode == 0 and output_path.exists()
    if copy_ok:
        copied_duration = _probe_video_duration_seconds(
            output_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
        if copied_duration <= 0 or abs(copied_duration - trim_at) > duration_tolerance:
            copy_ok = False
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass
    if not copy_ok:
        reencode_cmd = [
            ffmpeg,
            "-y",
            "-t",
            f"{trim_at:.3f}",
            "-i",
            str(source),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        proc = _run_process(reencode_cmd, run=run, context=context, timeout_seconds=300)
        if proc.returncode != 0 or not output_path.exists():
            raise RuntimeError(
                _compact_ffmpeg_error(proc.stderr, proc.stdout, fallback="ffmpeg tail cooldown trim failed")
            )
    return output_path.resolve()


def _trim_video_tail_to_target_quiet_seconds(
    input_path: Path,
    output_path: Path,
    *,
    target_quiet_seconds: float = 0.24,
    min_silence_seconds: float = 0.06,
    tail_tolerance_seconds: float = 0.18,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> Path:
    source = Path(input_path).expanduser().resolve()
    duration = _probe_video_duration_seconds(
        source, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
    )
    if duration <= 0:
        return source
    target_quiet = min(max(float(target_quiet_seconds or 0.24), 0.10), 0.8)
    try:
        silence_ranges = _detect_audio_silence_ranges(
            source,
            duration_seconds=duration,
            noise_db="-38dB",
            min_silence=min_silence_seconds,
            payload=payload,
            context=context,
            run=run,
        )
    except VideoTaskCancelled:
        raise
    except Exception:
        return source
    trim_at: float | None = None
    for silence_start, silence_end in reversed(silence_ranges):
        if duration - silence_end > tail_tolerance_seconds:
            continue
        tail_silence_seconds = max(duration - silence_start, 0.0)
        if tail_silence_seconds <= target_quiet + 0.03:
            return source
        trim_at = min(max(silence_start + target_quiet, 0.2), duration - 0.05)
        break
    if trim_at is None:
        return source
    ffmpeg = _resolve_ffmpeg_exe(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    reencode_cmd = [
        ffmpeg,
        "-y",
        "-t",
        f"{trim_at:.3f}",
        "-i",
        str(source),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    proc = _run_process(reencode_cmd, run=run, context=context, timeout_seconds=300)
    if proc.returncode != 0 or not output_path.exists():
        raise RuntimeError(_compact_ffmpeg_error(proc.stderr, proc.stdout, fallback="ffmpeg target tail trim failed"))
    trimmed_duration = _probe_video_duration_seconds(
        output_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
    )
    if trimmed_duration <= 0 or abs(trimmed_duration - trim_at) > 0.08:
        raise RuntimeError(f"target tail trim duration drifted: expect={trim_at:.3f}, got={trimmed_duration:.3f}")
    return output_path.resolve()


def _trim_video_leading_silence(
    input_path: Path,
    output_path: Path,
    *,
    keep_quiet_seconds: float = 0.04,
    max_quiet_seconds: float = 0.08,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> Path:
    source = Path(input_path).expanduser().resolve()
    duration = _probe_video_duration_seconds(
        source, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
    )
    trim_start = _digital_human_leading_silence_trim_seconds(
        source,
        duration_seconds=duration,
        keep_quiet_seconds=keep_quiet_seconds,
        max_quiet_seconds=max_quiet_seconds,
        payload=payload,
        context=context,
        probe=probe,
        run=run,
    )
    if trim_start is None:
        return source
    ffmpeg = _resolve_ffmpeg_exe(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    expected_duration = max(duration - trim_start, 0.0)
    duration_tolerance = max(0.08, min(float(max_quiet_seconds), 0.18))
    copy_cmd = [
        ffmpeg,
        "-y",
        "-ss",
        f"{trim_start:.3f}",
        "-i",
        str(source),
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        str(output_path),
    ]
    proc = _run_process(copy_cmd, run=run, context=context, timeout_seconds=180)
    copy_ok = proc.returncode == 0 and output_path.exists()
    if copy_ok:
        copied_duration = _probe_video_duration_seconds(
            output_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
        if copied_duration <= 0 or abs(copied_duration - expected_duration) > duration_tolerance:
            copy_ok = False
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass
    if not copy_ok:
        reencode_cmd = [
            ffmpeg,
            "-y",
            "-ss",
            f"{trim_start:.3f}",
            "-i",
            str(source),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        proc = _run_process(reencode_cmd, run=run, context=context, timeout_seconds=300)
        if proc.returncode != 0 or not output_path.exists():
            raise RuntimeError(
                _compact_ffmpeg_error(proc.stderr, proc.stdout, fallback="ffmpeg leading silence trim failed")
            )
    return output_path.resolve()


def _tighten_digital_human_segment_join_gaps(
    segment_paths: list[Path],
    *,
    output_dir: Path,
    payload: dict[str, Any] | None = None,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> tuple[list[Path], list[dict[str, Any]]]:
    _check_cancelled(context)
    if len(segment_paths) <= 1:
        return [Path(path).expanduser().resolve() for path in segment_paths], []
    join_budget = _digital_human_segment_join_gap_budget_seconds(payload)
    min_tail_quiet = _digital_human_segment_join_min_tail_quiet_seconds(payload)
    output_dir.mkdir(parents=True, exist_ok=True)
    tightened_paths = [Path(path).expanduser().resolve() for path in segment_paths]
    trims: list[dict[str, Any]] = []
    for idx in range(len(tightened_paths) - 1):
        _check_cancelled(context)
        previous_path = tightened_paths[idx]
        next_path = tightened_paths[idx + 1]
        previous_duration = _probe_video_duration_seconds(
            previous_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
        next_duration = _probe_video_duration_seconds(
            next_path, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
        tail_silence_seconds = _detect_digital_human_trailing_silence_seconds(
            previous_path,
            duration_seconds=previous_duration,
            payload=payload,
            context=context,
            probe=probe,
            run=run,
        )
        leading_silence_seconds = _detect_digital_human_leading_silence_seconds(
            next_path,
            duration_seconds=next_duration,
            payload=payload,
            context=context,
            probe=probe,
            run=run,
        )
        total_gap_seconds = tail_silence_seconds + leading_silence_seconds
        if total_gap_seconds <= join_budget + 0.02 or tail_silence_seconds <= min_tail_quiet + 0.03:
            continue
        target_tail_quiet = max(min_tail_quiet, join_budget - leading_silence_seconds)
        if target_tail_quiet >= tail_silence_seconds - 0.03:
            continue
        target = output_dir / f"{idx + 1}_join_gap_tightened{previous_path.suffix or '.mp4'}"
        try:
            tightened = _trim_video_tail_to_target_quiet_seconds(
                previous_path,
                target,
                target_quiet_seconds=target_tail_quiet,
                payload=payload,
                context=context,
                probe=probe,
                run=run,
            )
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            trims.append({"index": idx + 1, "path": str(previous_path), "skipped": str(exc)[:240]})
            continue
        if tightened == previous_path:
            continue
        tightened_paths[idx] = tightened
        trims.append(
            {
                "index": idx + 1,
                "path": str(previous_path),
                "trimmed_path": str(tightened),
                "original_seconds": previous_duration,
                "trimmed_seconds": _probe_video_duration_seconds(
                    tightened, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
                ),
                "next_path": str(next_path),
                "tail_silence_seconds": round(float(tail_silence_seconds), 3),
                "leading_silence_seconds": round(float(leading_silence_seconds), 3),
                "original_join_gap_seconds": round(float(total_gap_seconds), 3),
                "target_join_gap_seconds": round(float(join_budget), 3),
                "target_tail_quiet_seconds": round(float(target_tail_quiet), 3),
                "reason": "join_gap_budget",
            }
        )
    return tightened_paths, trims


def _normalize_digital_human_segment_tail_cooldowns(
    segment_paths: list[Path],
    *,
    output_dir: Path,
    payload: dict[str, Any] | None = None,
    include_final: bool = False,
    context: VideoTaskContext | None = None,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
) -> tuple[list[Path], list[dict[str, Any]]]:
    _check_cancelled(context)
    if len(segment_paths) <= 1 or not _digital_human_segment_tail_cooldown_enabled(payload):
        return [Path(path).expanduser().resolve() for path in segment_paths], []
    target_quiet = _digital_human_segment_tail_cooldown_seconds(payload)
    max_quiet = _digital_human_segment_tail_max_silence_seconds(payload)
    trim_leading_silence = _digital_human_segment_leading_silence_enabled(payload)
    keep_head_quiet = _digital_human_segment_head_keep_silence_seconds(payload)
    max_head_quiet = _digital_human_segment_head_max_silence_seconds(payload)
    output_dir.mkdir(parents=True, exist_ok=True)
    normalized_paths: list[Path] = []
    trims: list[dict[str, Any]] = []
    last_index = len(segment_paths)
    for idx, path in enumerate(segment_paths, start=1):
        _check_cancelled(context)
        source = Path(path).expanduser().resolve()
        original_seconds = _probe_video_duration_seconds(
            source, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
        )
        normalized = source
        if idx != last_index or include_final:
            target = output_dir / f"{idx}_tail_cooldown{source.suffix or '.mp4'}"
            try:
                normalized = _trim_video_tail_cooldown(
                    source,
                    target,
                    target_quiet_seconds=target_quiet,
                    max_quiet_seconds=max_quiet,
                    payload=payload,
                    context=context,
                    probe=probe,
                    run=run,
                )
            except VideoTaskCancelled:
                raise
            except Exception as exc:
                trims.append({"index": idx, "path": str(source), "skipped": str(exc)[:240]})
                normalized = source
            if normalized != source:
                trims.append(
                    {
                        "index": idx,
                        "path": str(source),
                        "trimmed_path": str(normalized),
                        "original_seconds": original_seconds,
                        "trimmed_seconds": _probe_video_duration_seconds(
                            normalized, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
                        ),
                        "target_cooldown_seconds": round(float(target_quiet), 3),
                        "max_tail_silence_seconds": round(float(max_quiet), 3),
                        "reason": "tail_cooldown",
                    }
                )
        if trim_leading_silence and idx > 1:
            head_source = normalized
            head_target = output_dir / f"{idx}_leading_silence{source.suffix or '.mp4'}"
            try:
                head_normalized = _trim_video_leading_silence(
                    head_source,
                    head_target,
                    keep_quiet_seconds=keep_head_quiet,
                    max_quiet_seconds=max_head_quiet,
                    payload=payload,
                    context=context,
                    probe=probe,
                    run=run,
                )
            except VideoTaskCancelled:
                raise
            except Exception as exc:
                trims.append({"index": idx, "path": str(head_source), "skipped": str(exc)[:240]})
                head_normalized = head_source
            if head_normalized != head_source:
                trims.append(
                    {
                        "index": idx,
                        "path": str(head_source),
                        "trimmed_path": str(head_normalized),
                        "original_seconds": _probe_video_duration_seconds(
                            head_source, default_seconds=0.0, payload=payload, context=context, probe=probe, run=run
                        ),
                        "trimmed_seconds": _probe_video_duration_seconds(
                            head_normalized,
                            default_seconds=0.0,
                            payload=payload,
                            context=context,
                            probe=probe,
                            run=run,
                        ),
                        "keep_head_silence_seconds": round(float(keep_head_quiet), 3),
                        "max_head_silence_seconds": round(float(max_head_quiet), 3),
                        "reason": "leading_silence",
                    }
                )
                normalized = head_normalized
        normalized_paths.append(normalized)
    join_gap_paths, join_gap_trims = _tighten_digital_human_segment_join_gaps(
        normalized_paths,
        output_dir=output_dir / "join_gap_tightened",
        payload=payload,
        context=context,
        probe=probe,
        run=run,
    )
    trims.extend(join_gap_trims)
    return join_gap_paths, trims


def normalize_digital_human_segment_joins(
    segment_paths: Iterable[str | Path],
    *,
    output_dir: str | Path,
    payload: dict[str, Any] | None,
    context: VideoTaskContext,
    probe: ProbeRunner | None = None,
    run: ProcessRunner | None = None,
    include_final: bool = False,
) -> tuple[list[Path], list[dict[str, Any]]]:
    """Apply the archived platform's leading/tail silence and join-gap cleanup."""

    paths = [Path(path).expanduser().resolve() for path in segment_paths]
    target_dir = Path(output_dir).expanduser().resolve()
    return _normalize_digital_human_segment_tail_cooldowns(
        paths,
        output_dir=target_dir,
        payload=payload or {},
        include_final=include_final,
        context=context,
        probe=probe,
        run=run,
    )


__all__ = ["normalize_digital_human_segment_joins"]
