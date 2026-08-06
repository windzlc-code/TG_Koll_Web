from __future__ import annotations

import inspect
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import requests

from .contracts import VideoDependencyError, VideoTaskCancelled, VideoTaskContext
from . import digital_human_audio_postprocess, digital_human_image_quality, digital_human_join_cleanup, digital_human_pipeline, digital_human_subtitles, digital_human_views, ecommerce_ad_prompting, ecommerce_animation_redraw, ecommerce_material_intelligence, ecommerce_reference_video, ecommerce_seeding_dynamic, ecommerce_seeding_renderer, ecommerce_segment_audio, ecommerce_segment_continuity, image_generate_dispatch, image_mode_prompts, language_voice_pipeline, replacement_pipeline, runninghub_image_models
from .source import create_video as source_create_video
from .source import image_model_api, runninghub_common


DIGITAL_HUMAN_VIDEO_APP_ID = "2068273204367544322"
LEGACY_DIGITAL_HUMAN_VIDEO_APP_ID = "1958162038503649281"
ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID = "2034917373414539277"
ECOMMERCE_SHORT_VIDEO_FAST_APP_ID = "2034917373414539278"
REPLACE_MODEL_DEFAULT_APP_ID = "2028374986792116225"
REPLACE_MODEL_LEGACY_APP_ID = "1977634608437174274"
REPLACE_PRODUCT_DEFAULT_APP_ID = "1977410328592031746"
VIDEO_LANGUAGE_AUDIO_SEPARATION_APP_ID = "2054844989808619521"
_LOCAL_PROCESS_SEMAPHORES: dict[int, threading.BoundedSemaphore] = {}
_LOCAL_PROCESS_SEMAPHORES_LOCK = threading.RLock()
_IMAGE_GENERATE_MODES = {
    "product_only",
    "model_product",
    "subject_replace",
    "poster_translate",
    "digital_human_character",
    "three_view",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(math.ceil(float(value)))
    except (TypeError, ValueError):
        return int(default)


def _strict_positive_integer(value: Any, *, name: str, default: int, maximum: int) -> int:
    if value is None or (isinstance(value, str) and not value.strip()):
        return int(default)
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer between 1 and {maximum}")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer between 1 and {maximum}") from exc
    if not number.is_integer() or number < 1 or number > maximum:
        raise ValueError(f"{name} must be an integer between 1 and {maximum}")
    return int(number)


def _boolean(value: Any, *, name: str, default: bool) -> bool:
    if value is None or value == "":
        return bool(default)
    if isinstance(value, bool):
        return value
    normalized = _text(value).lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _unique_text_values(values: list[Any] | tuple[Any, ...]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _text(value)
        if not item:
            continue
        normalized = str(Path(item).expanduser().resolve())
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _unique_provider_ids(values: Any) -> list[str]:
    """Deduplicate opaque provider IDs without treating them as filesystem paths."""

    result: list[str] = []
    seen: set[str] = set()

    def append(value: Any) -> None:
        if isinstance(value, (list, tuple, set)):
            for item in value:
                append(item)
            return
        item = _text(value)
        if not item or item in seen:
            return
        seen.add(item)
        result.append(item)

    append(values)
    return result


def _collect_runninghub_task_ids(value: Any) -> list[str]:
    collected: list[str] = []

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            for key in ("runninghub_task_id", "provider_task_id"):
                if key in item:
                    candidate = _text(item.get(key))
                    if candidate and candidate not in collected:
                        collected.append(candidate)
            for key, child in item.items():
                if key in {"runninghub_task_id", "provider_task_id"}:
                    continue
                if key == "runninghub_task_ids":
                    for candidate in _unique_provider_ids(child):
                        if candidate not in collected:
                            collected.append(candidate)
                elif isinstance(child, (dict, list, tuple)):
                    visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                visit(child)

    visit(value)
    return collected


def _iter_runninghub_usage(value: Any):
    if isinstance(value, dict):
        preferred = value.get("runninghub_usage")
        if isinstance(preferred, dict) and preferred:
            yield from _iter_runninghub_usage(preferred)
            return
        preferred = value.get("usage")
        if isinstance(preferred, dict) and preferred:
            yield from _iter_runninghub_usage(preferred)
            return
        if any(key in value for key in ("consumeCoins", "consumeMoney", "thirdPartyConsumeMoney")):
            yield value
            return
        for child in value.values():
            yield from _iter_runninghub_usage(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _iter_runninghub_usage(child)


def _merge_runninghub_usage(*values: Any) -> dict[str, float]:
    totals = {
        "consumeCoins": 0.0,
        "consumeMoney": 0.0,
        "thirdPartyConsumeMoney": 0.0,
    }
    found = False
    for value in values:
        for usage in _iter_runninghub_usage(value):
            found = True
            for key in totals:
                totals[key] += _number(usage.get(key), 0.0)
    if not found:
        return {}
    return {key: round(value, 6) for key, value in totals.items()}


def _segment_prompt_lines(value: Any, *, name: str) -> list[str]:
    if value is None:
        return []
    items = value
    if name == "storyboard" and isinstance(value, dict):
        items = next((value.get(key) for key in ("items", "segments", "shots") if isinstance(value.get(key), list)), None)
        if items is None:
            raise ValueError("storyboard must be a list or contain an items/segments/shots list")
    if not isinstance(items, list):
        raise ValueError(f"{name} must be a list")
    if len(items) > 50:
        raise ValueError(f"{name} may contain at most 50 segments")
    lines: list[str] = []
    for index, item in enumerate(items, start=1):
        if isinstance(item, str):
            parts = [_text(item)]
        elif isinstance(item, dict):
            parts = []
            for key in ("visual_prompt", "prompt", "text", "shot", "dialogue", "copy"):
                text = _text(item.get(key))
                if text and text not in parts:
                    parts.append(text)
        else:
            raise ValueError(f"{name}[{index}] must be text or an object")
        parts = [part for part in parts if part]
        if not parts:
            raise ValueError(f"{name}[{index}] has no usable prompt text")
        line = "; ".join(parts)
        if len(line) > 4000:
            raise ValueError(f"{name}[{index}] is too long")
        lines.append(line)
    return lines


def _subtitle_cues(payload: dict[str, Any]) -> list[dict[str, Any]]:
    source = payload.get("subtitles")
    if source is None:
        source = payload.get("subtitle_config")
    if source is None:
        source = payload.get("subtitle_segments") or payload.get("script_segments")
    if source is None:
        return []
    if isinstance(source, dict):
        if not _boolean(source.get("enabled"), name="subtitles.enabled", default=True):
            return []
        source = source.get("items", source.get("cues", source.get("subtitles", [])))
    if not isinstance(source, list):
        raise ValueError("subtitles must be a list or an object containing items")
    if len(source) > 500:
        raise ValueError("subtitles may contain at most 500 cues")
    cues: list[dict[str, Any]] = []
    previous_start = -1.0
    for index, raw in enumerate(source, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"subtitle cue {index} must be an object")
        text = _text(raw.get("text"))
        if not text:
            raise ValueError(f"subtitle cue {index} has no text")
        start = _number(raw.get("start_seconds", raw.get("start")), -1)
        end = _number(raw.get("end_seconds", raw.get("end")), -1)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError(f"subtitle cue {index} has an invalid time range")
        if start < previous_start:
            raise ValueError("subtitle cues must be ordered by start time")
        previous_start = start
        cues.append({"index": index, "start_seconds": start, "end_seconds": end, "text": text})
    return cues


def _srt_timestamp(seconds: float) -> str:
    milliseconds = max(int(round(float(seconds) * 1000)), 0)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{milliseconds:03d}"


def _ffmpeg_filter_path(path: Path) -> str:
    value = path.resolve().as_posix()
    return value.replace("\\", "/").replace(":", "\\:").replace("'", "\\'").replace(",", "\\,")


def _safe_task_id(value: Any) -> str:
    text = _text(value)
    cleaned = "".join(char if char.isalnum() or char in "-_." else "_" for char in text)
    return cleaned.strip("._") or "video_task"


def _is_url(value: Any) -> bool:
    text = _text(value).lower()
    return text.startswith("https://") or text.startswith("http://")


def _invoke_compatible(callable_obj: Any, **values: Any) -> Any:
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return callable_obj(**values)
    accepts_kwargs = any(item.kind == inspect.Parameter.VAR_KEYWORD for item in signature.parameters.values())
    kwargs = values if accepts_kwargs else {key: value for key, value in values.items() if key in signature.parameters}
    return callable_obj(**kwargs)


@contextmanager
def _local_process_slot(payload: dict[str, Any], context: VideoTaskContext):
    limit = min(max(_integer(payload.get("video_local_max_concurrency"), 2), 1), 16)
    with _LOCAL_PROCESS_SEMAPHORES_LOCK:
        semaphore = _LOCAL_PROCESS_SEMAPHORES.setdefault(limit, threading.BoundedSemaphore(limit))
    while not semaphore.acquire(timeout=0.25):
        context.check_cancelled()
    try:
        yield
    finally:
        semaphore.release()


def _run_local_process(command: list[str], *, timeout_seconds: int, payload: dict[str, Any], context: VideoTaskContext) -> tuple[int, str, str]:
    with _local_process_slot(payload, context):
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + max(int(timeout_seconds), 1)
        try:
            while True:
                if context.cancelled():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    context.check_cancelled()
                if time.monotonic() >= deadline:
                    process.kill()
                    raise TimeoutError("本地视频处理超时")
                try:
                    stdout, stderr = process.communicate(
                        timeout=min(max(deadline - time.monotonic(), 0.01), 0.25)
                    )
                    return int(process.returncode or 0), stdout or "", stderr or ""
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                process.kill()


class ArchivedSourceBackend:
    """White-listed backend adapted from the archived generator modules.

    It contains no Telegram, auth, database, FastAPI app, or queue code. Existing
    server helpers may be injected in payload private keys for media upload and
    task workdir allocation.
    """

    def __init__(self, *, http_session: Any = requests) -> None:
        self.http = http_session

    def run_task(
        self,
        task_type: str,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> dict[str, Any]:
        runners = {
            "create_video": self.create_video,
            "ecommerce_short_video": self.ecommerce_short_video,
            "video_language_replace": self.video_language_replace,
            "replace_model": self.replace_model,
            "replace_product": self.replace_product,
            "replace_product_and_model": self.replace_product_and_model,
            "replace_productANDmodel": self.replace_product_and_model,
            "image_generate": self.image_generate,
        }
        runner = runners.get(_text(task_type))
        if runner is None:
            raise ValueError(f"unsupported archived video task: {task_type}")
        context.check_cancelled()
        return runner(task_id=str(task_id), payload=dict(payload or {}), context=context)

    @staticmethod
    def _base_url(payload: dict[str, Any]) -> str:
        return _text(payload.get("video_runninghub_base_url") or payload.get("runninghub_base_url") or "https://www.runninghub.ai").rstrip("/")

    @staticmethod
    def _api_key(payload: dict[str, Any]) -> str:
        value = _text(
            payload.get("video_runninghub_api_key")
            or payload.get("runninghub_api_key")
            or payload.get("runninghub_personal_api_key")
            or payload.get("runninghub_enterprise_api_key")
        )
        if not value:
            raise VideoDependencyError("缺少 video_runninghub_api_key")
        return value

    @staticmethod
    def _workdir(task_id: str, payload: dict[str, Any]) -> Path:
        factory = payload.get("_video_workdir_factory") or payload.get("_workdir_factory")
        if callable(factory):
            path = Path(factory(str(task_id))).expanduser().resolve()
        else:
            configured = _text(payload.get("output_dir") or payload.get("workdir"))
            path = Path(configured).expanduser().resolve() if configured else (Path("webapp_data") / "task_runs" / _safe_task_id(task_id)).resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _burn_subtitles_if_requested(
        self,
        *,
        video_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        speech_text: str = "",
        segment_texts: list[str] | None = None,
        segment_durations: list[float] | None = None,
    ) -> tuple[Path, int]:
        cues = _subtitle_cues(payload)
        prepared_segment_texts = [str(item or "").strip() for item in (segment_texts or []) if str(item or "").strip()]
        prepared_segment_durations = [max(_number(item, 0.0), 0.1) for item in (segment_durations or [])]
        use_original_ass = bool(
            prepared_segment_texts
            and len(prepared_segment_texts) == len(prepared_segment_durations)
        )
        if not cues and not use_original_ass:
            return video_path, 0
        if not video_path.exists() or not video_path.is_file():
            raise FileNotFoundError(f"cannot burn subtitles because video output is missing: {video_path}")
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("subtitle rendering requires ffmpeg")
        rendered_path = workdir / f"{video_path.stem}_subtitled.mp4"
        subtitle_config = payload.get("subtitles") if isinstance(payload.get("subtitles"), dict) else {}
        template = _text(payload.get("subtitle_template") or subtitle_config.get("template") or "split_hook")
        if use_original_ass:
            raw_keyword_lines = payload.get("subtitle_keyword_lines") or payload.get("video_cover_keywords") or []
            if isinstance(raw_keyword_lines, str):
                raw_keyword_lines = [item for item in re.split(r"[\n，,。；;、|/]+", raw_keyword_lines) if item.strip()]
            keyword_lines = [str(item or "").strip()[:14] for item in raw_keyword_lines] if isinstance(raw_keyword_lines, list) else []
            subtitle_path, subtitle_filter = digital_human_subtitles.write_ass_subtitles(
                output_path=workdir / f"{video_path.stem}.ass",
                segment_texts=prepared_segment_texts,
                segment_durations=prepared_segment_durations,
                media_path=video_path,
                timing_shift_seconds=_number(payload.get("subtitle_timing_shift_seconds"), 0.0),
                template_key=template,
                keyword_lines=keyword_lines,
                include_fixed_overlays=_boolean(
                    payload.get("subtitle_fixed_overlays_enabled"),
                    name="subtitle_fixed_overlays_enabled",
                    default=True,
                ),
            )
            subtitle_count = len(prepared_segment_texts)
        else:
            subtitle_path = workdir / f"{video_path.stem}.srt"
            subtitle_text = "\n\n".join(
                "\n".join(
                    [
                        str(cue["index"]),
                        f"{_srt_timestamp(cue['start_seconds'])} --> {_srt_timestamp(cue['end_seconds'])}",
                        str(cue["text"]).replace("\r", " ").strip(),
                    ]
                )
                for cue in cues
            ) + "\n"
            subtitle_path.write_text(subtitle_text, encoding="utf-8-sig")
            font_size = min(max(_integer(payload.get("subtitle_font_size"), 18), 10), 72)
            margin = min(max(_integer(payload.get("subtitle_margin_vertical"), 36), 0), 400)
            template_styles = {
                "keyword_focus": "Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00111111",
                "bilingual_dual": "Bold=0,Spacing=0.5",
                "handwritten_quote": "Italic=1,MarginV=60",
                "split_hook": "Bold=1,MarginV=80",
            }
            template_style = template_styles.get(template, template_styles["keyword_focus"])
            force_style = f"FontSize={font_size},Outline=2,Shadow=0,Alignment=2,MarginV={margin},{template_style}"
            subtitle_filter = f"subtitles=filename='{_ffmpeg_filter_path(subtitle_path)}':force_style='{force_style}'"
            subtitle_count = len(cues)
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-vf",
            subtitle_filter,
            "-c:v",
            _text(payload.get("subtitle_video_codec")) or "libx264",
            "-preset",
            _text(payload.get("subtitle_encode_preset")) or "medium",
            "-crf",
            str(min(max(_integer(payload.get("subtitle_crf"), 18), 0), 51)),
            "-c:a",
            "copy",
            str(rendered_path),
        ]
        context.check_cancelled()
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not rendered_path.exists():
            raise RuntimeError(f"ffmpeg subtitle rendering failed: {_text(stderr)[-1000:]}")
        return rendered_path, subtitle_count

    def _apply_optional_subtitles(
        self,
        *,
        video_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        speech_text: str = "",
        segment_texts: list[str] | None = None,
        segment_durations: list[float] | None = None,
    ) -> tuple[Path, int, str]:
        try:
            rendered, count = self._burn_subtitles_if_requested(
                video_path=video_path,
                payload=payload,
                context=context,
                workdir=workdir,
                speech_text=speech_text,
                segment_texts=segment_texts,
                segment_durations=segment_durations,
            )
            return rendered, count, ""
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            return video_path, 0, f"subtitle rendering skipped: {str(exc).strip()}"

    def _fit_audio_to_duration(
        self,
        *,
        audio_path: Path,
        target_seconds: float,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> Path:
        duration = max(float(target_seconds or 0), 0.0)
        if duration <= 0:
            return audio_path
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("audio duration fitting requires ffmpeg")
        output_path = workdir / "video_language_fitted_audio.m4a"
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(audio_path),
            "-af",
            f"apad,atrim=0:{duration:.3f},asetpts=N/SR/TB",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            str(output_path),
        ]
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        if returncode != 0 or not output_path.exists():
            raise RuntimeError(f"ffmpeg audio duration fitting failed: {_text(stderr)[-1000:]}")
        return output_path

    def _replace_video_audio_track(
        self,
        *,
        source_video: Path,
        audio_path: Path,
        source_seconds: float,
        target_seconds: float,
        output_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> None:
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("video language replacement requires ffmpeg")
        duration = max(float(target_seconds or source_seconds or 0), 0.0)
        extension = max(duration - max(float(source_seconds or 0), 0.0), 0.0)
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_video),
            "-i",
            str(audio_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
        ]
        if extension > 0.01:
            command.extend(
                [
                    "-vf",
                    f"tpad=stop_mode=clone:stop_duration={extension:.3f}",
                    "-c:v",
                    _text(payload.get("language_video_codec")) or "libx264",
                    "-preset",
                    _text(payload.get("language_encode_preset")) or "medium",
                    "-crf",
                    str(min(max(_integer(payload.get("language_crf"), 18), 0), 51)),
                ]
            )
        else:
            command.extend(["-c:v", "copy"])
        command.extend(["-c:a", "aac"])
        if duration > 0:
            command.extend(["-t", f"{duration:.3f}"])
        else:
            command.append("-shortest")
        command.append(str(output_path))
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        if returncode != 0 or not output_path.exists():
            raise RuntimeError(f"ffmpeg audio track replacement failed: {_text(stderr)[-1000:]}")

    def _mix_background_audio(
        self,
        *,
        background_path: Path,
        speech_audio: Path,
        target_seconds: float,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> Path:
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("background audio preservation requires ffmpeg")
        duration = max(float(target_seconds or 0), 0.1)
        mixed_path = workdir / "video_language_mix_audio.m4a"
        filter_complex = (
            f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.55,apad,atrim=0:{duration:.3f},asetpts=N/SR/TB[bg0];"
            f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.15,apad,atrim=0:{duration:.3f},asetpts=N/SR/TB,asplit=2[ttsduck][ttsmix];"
            "[bg0][ttsduck]sidechaincompress=threshold=0.035:ratio=10:attack=15:release=300[duck0];"
            "[duck0][ttsmix]amix=inputs=2:weights='1 1':normalize=0[mixout]"
        )
        mix_command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(background_path),
            "-i",
            str(speech_audio),
            "-filter_complex",
            filter_complex,
            "-map",
            "[mixout]",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(mixed_path),
        ]
        returncode, _stdout, stderr = _run_local_process(
            mix_command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        if returncode != 0 or not mixed_path.exists():
            raise RuntimeError(f"ffmpeg background mix failed: {_text(stderr)[-1000:]}")
        return mixed_path

    def _preserve_background_audio(
        self,
        *,
        source_video: Path,
        speech_audio: Path,
        target_seconds: float,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> tuple[Path, str]:
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("background audio preservation requires ffmpeg")
        duration = max(float(target_seconds or 0), 0.1)
        background_path = workdir / "video_language_background_bed.m4a"
        extract_command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_video),
            "-vn",
            "-af",
            f"highpass=f=140,lowpass=f=9000,afftdn=nf=-20,volume=0.18,apad,atrim=0:{duration:.3f},asetpts=N/SR/TB",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            str(background_path),
        ]
        returncode, _stdout, stderr = _run_local_process(
            extract_command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        if returncode != 0 or not background_path.exists():
            raise RuntimeError(f"ffmpeg background extraction failed: {_text(stderr)[-1000:]}")
        mixed_path = self._mix_background_audio(
            background_path=background_path,
            speech_audio=speech_audio,
            target_seconds=target_seconds,
            payload=payload,
            context=context,
            workdir=workdir,
        )
        return mixed_path, str(background_path)

    def _extract_source_audio_for_separation(
        self,
        *,
        source_video: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> Path:
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("RunningHub background separation requires ffmpeg")
        output_path = workdir / "video_language_source_audio.wav"
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_video),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not output_path.exists():
            raise RuntimeError(f"ffmpeg source audio extraction failed: {_text(stderr)[-1000:]}")
        return output_path

    def _upload_runninghub_audio(self, *, path: Path, payload: dict[str, Any], context: VideoTaskContext) -> str:
        context.check_cancelled()
        url = f"{self._base_url(payload)}/openapi/v2/media/upload/binary"
        headers = {"Authorization": f"Bearer {self._api_key(payload)}"}
        with path.open("rb") as handle:
            response = self.http.post(url, headers=headers, files={"file": handle}, timeout=120)
        response.raise_for_status()
        context.check_cancelled()
        body = response.json()
        if not isinstance(body, dict) or int(body.get("code", -1)) != 0:
            raise RuntimeError(f"RunningHub audio upload failed: {json.dumps(body, ensure_ascii=False)[:600]}")
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        result = _text(data.get("download_url") or data.get("downloadUrl") or data.get("fileName") or data.get("url"))
        if not result:
            raise RuntimeError("RunningHub audio upload succeeded without a usable file reference")
        return result

    @staticmethod
    def _runninghub_query_payload(body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            return {}
        data = body.get("data")
        return data if isinstance(data, dict) and not body.get("status") else body

    @staticmethod
    def _select_runninghub_background_result(body: Any) -> dict[str, Any]:
        entries: list[dict[str, Any]] = []

        def collect(value: Any) -> None:
            if isinstance(value, dict):
                if any(_text(value.get(key)) for key in ("url", "fileUrl", "downloadUrl", "download_url")):
                    entries.append(value)
                for nested in value.values():
                    if isinstance(nested, (dict, list)):
                        collect(nested)
            elif isinstance(value, list):
                for nested in value:
                    collect(nested)

        collect(body)
        audio_formats = {"aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"}
        non_audio_formats = {"avi", "bmp", "gif", "jpeg", "jpg", "mkv", "mov", "mp4", "png", "webm", "webp"}
        scored: list[tuple[int, int, dict[str, Any]]] = []
        for index, entry in enumerate(entries):
            url = _text(entry.get("url") or entry.get("fileUrl") or entry.get("downloadUrl") or entry.get("download_url"))
            output_type = _text(entry.get("outputType") or entry.get("format") or entry.get("fileType")).lower().lstrip(".")
            suffix = Path(url.split("?", 1)[0]).suffix.lower().lstrip(".")
            descriptor = " ".join(_text(value).lower() for value in entry.values() if isinstance(value, (str, int, float)))
            semantic = any(term in descriptor for term in ("background", "accompaniment", "instrumental", "伴奏", "背景", "bgm", "music only", "no vocal", "no_vocal"))
            node_id = _text(entry.get("nodeId") or entry.get("node_id") or entry.get("nodeID"))
            if output_type in non_audio_formats or suffix in non_audio_formats:
                continue
            if output_type not in audio_formats and suffix not in audio_formats and node_id != "5" and not semantic:
                continue
            score = (100 if node_id == "5" else 0) + (80 if semantic else 0)
            if any(term in descriptor for term in ("vocal", "vocals", "人声")) and not semantic:
                score -= 100
            scored.append((score, -index, {**entry, "selected_url": url}))
        if not scored:
            return {}
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return scored[0][2]

    def _download_runninghub_audio(
        self,
        *,
        url: str,
        output_path: Path,
        context: VideoTaskContext,
    ) -> Path:
        context.check_cancelled()
        response = self.http.get(url, stream=True, timeout=(10, 180))
        response.raise_for_status()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("wb") as handle:
            iterator = getattr(response, "iter_content", None)
            if callable(iterator):
                for chunk in iterator(chunk_size=8192):
                    context.check_cancelled()
                    if chunk:
                        handle.write(chunk)
            else:
                context.check_cancelled()
                handle.write(bytes(getattr(response, "content", b"") or b""))
        context.check_cancelled()
        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise RuntimeError("RunningHub background audio download produced an empty file")
        return output_path

    def _separate_background_audio_runninghub(
        self,
        *,
        task_id: str,
        source_video: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        provider_state: dict[str, Any],
    ) -> dict[str, Any]:
        app_id = _text(payload.get("video_language_audio_separation_app_id")) or VIDEO_LANGUAGE_AUDIO_SEPARATION_APP_ID
        api_key = self._api_key(payload)
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        provider_task_id = _text(payload.get("resume_runninghub_task_id"))
        submit_body: dict[str, Any] = {}
        if not provider_task_id:
            source_audio = self._extract_source_audio_for_separation(
                source_video=source_video,
                payload=payload,
                context=context,
                workdir=workdir,
            )
            audio_reference = self._upload_runninghub_audio(path=source_audio, payload=payload, context=context)
            submit_payload = {
                "nodeInfoList": [
                    {
                        "nodeId": "3",
                        "fieldName": "audio",
                        "fieldValue": audio_reference,
                        "description": "source video audio",
                    }
                ],
                "instanceType": _text(payload.get("video_language_audio_separation_instance_type") or payload.get("instance_type") or "default"),
                "usePersonalQueue": False,
            }
            context.progress(stage="provider_submitting", status="running", message="submitting background audio separation")
            context.check_cancelled()
            response = self.http.post(
                self._workflow_submit_url(payload, app_id),
                headers=headers,
                data=json.dumps(submit_payload, ensure_ascii=False),
                timeout=120,
            )
            response.raise_for_status()
            submit_body = response.json()
            normalized = runninghub_common._normalize_submit_result(submit_body)
            provider_task_id = _text(normalized.get("task_id") or normalized.get("task id"))
            if not provider_task_id:
                raise RuntimeError(f"RunningHub background separation submit failed: {json.dumps(submit_body, ensure_ascii=False)[:800]}")
        provider_state["task_id"] = provider_task_id
        register = payload.get("_register_runninghub_task")
        if callable(register):
            _invoke_compatible(register, task_id=str(task_id), runninghub_task_id=provider_task_id)
        context.progress(
            stage="provider_running",
            status="running",
            message="background audio separation running",
        )
        timeout_seconds = max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30)
        poll_seconds = max(_number(payload.get("video_poll_interval_seconds"), 3.0), 0.25)
        started = time.monotonic()
        last_body: dict[str, Any] = {}
        while time.monotonic() - started <= timeout_seconds:
            context.check_cancelled()
            query_response = self.http.post(
                f"{self._base_url(payload)}/openapi/v2/query",
                headers=headers,
                data=json.dumps({"taskId": provider_task_id}),
                timeout=(10, 120),
            )
            query_response.raise_for_status()
            body = query_response.json()
            if not isinstance(body, dict):
                raise RuntimeError("RunningHub background separation query returned invalid JSON")
            if "code" in body and int(body.get("code") or 0) != 0:
                raise RuntimeError(f"RunningHub background separation query failed: {json.dumps(body, ensure_ascii=False)[:800]}")
            last_body = body
            query_payload = self._runninghub_query_payload(body)
            status = _text(
                query_payload.get("status")
                or query_payload.get("taskStatus")
                or query_payload.get("task_status")
                or query_payload.get("state")
            ).upper()
            context.progress(stage="runninghub", status="running", message="background audio separation", progress=query_payload.get("progress"))
            if status == "SUCCESS":
                selected = self._select_runninghub_background_result(query_payload)
                if selected:
                    background_path = self._download_runninghub_audio(
                        url=_text(selected.get("selected_url")),
                        output_path=workdir / "video_language_runninghub_background.wav",
                        context=context,
                    )
                    usage = query_payload.get("usage") if isinstance(query_payload.get("usage"), dict) else {}
                    provider_state["usage"] = usage
                    return {
                        "background_path": str(background_path),
                        "runninghub_task_id": provider_task_id,
                        "usage": usage,
                        "selected_result": selected,
                        "submit": submit_body,
                        "query": body,
                    }
            elif status == "FAILED":
                raise RuntimeError(
                    "RunningHub background separation failed: "
                    + _text(query_payload.get("errorMessage") or query_payload.get("message") or json.dumps(query_payload, ensure_ascii=False)[:800])
                )
            self._interruptible_wait(context, poll_seconds)
        raise TimeoutError(
            f"RunningHub background separation timed out: {provider_task_id}; last={json.dumps(last_body, ensure_ascii=False)[:500]}"
        )

    def _generate_timed_tts_audio(
        self,
        *,
        segments: Any,
        source_duration: float,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        opening_insert_text: str = "",
        ending_insert_text: str = "",
    ) -> tuple[Path, list[dict[str, Any]], float]:
        cues = _subtitle_cues({"subtitles": {"enabled": True, "items": segments}})
        if not cues:
            raise ValueError("script_segments has no usable timed lines")
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("timed language replacement requires ffmpeg")
        regenerate_index = _integer(payload.get("regenerate_segment_index"), 0)
        if regenerate_index and not 1 <= regenerate_index <= len(cues):
            raise ValueError(f"regenerate_segment_index must be between 1 and {len(cues)}")
        reusable_values = payload.get("_video_language_reuse_segments")
        reusable: dict[int, Path] = {}
        if regenerate_index and isinstance(reusable_values, list):
            for offset, item in enumerate(reusable_values, start=1):
                if not isinstance(item, dict):
                    continue
                index = _integer(item.get("index") or item.get("segment_index"), offset)
                candidate_text = _text(item.get("audio_path"))
                if not candidate_text:
                    continue
                candidate = Path(candidate_text).expanduser().resolve()
                if candidate.is_file():
                    reusable[index] = candidate
        plan: list[dict[str, Any]] = [{**cue, "role": "source", "segment_index": int(cue["index"])} for cue in cues]
        if _text(opening_insert_text):
            plan.insert(0, {
                "index": 0,
                "segment_index": 0,
                "role": "opening",
                "start_seconds": 0.0,
                "end_seconds": max(float(cues[0]["start_seconds"]), 0.001),
                "text": _text(opening_insert_text),
            })
        if _text(ending_insert_text):
            ending_start = max(float(cues[-1]["end_seconds"]), float(source_duration or 0))
            plan.append({
                "index": len(cues) + 1,
                "segment_index": len(cues) + 1,
                "role": "ending",
                "start_seconds": ending_start,
                "end_seconds": ending_start + 0.001,
                "text": _text(ending_insert_text),
            })
        generated: list[dict[str, Any]] = []
        for cue in plan:
            context.check_cancelled()
            cue_index = int(cue["segment_index"])
            is_source = cue.get("role") == "source"
            audio_path = reusable.get(cue_index) if is_source and cue_index != regenerate_index else None
            reused = audio_path is not None
            if audio_path is None:
                audio_path = self._generate_minimax_tts(
                    speech_text=str(cue["text"]),
                    output_path=workdir / f"video_language_{cue.get('role', 'source')}_{cue_index:03d}.mp3",
                    payload=payload,
                    context=context,
                )
            generated.append({**cue, "audio_path": str(audio_path), "reused": reused})
        opening = next((item for item in generated if item.get("role") == "opening"), None)
        timeline_shift = 0.0
        if opening is not None:
            opening_duration = self._probe_media_duration_seconds(Path(opening["audio_path"]), payload)
            first_source_start = float(cues[0]["start_seconds"])
            timeline_shift = max(opening_duration - first_source_start, 0.0)
            opening["audio_duration_seconds"] = opening_duration
            opening["start_seconds"] = max(first_source_start - opening_duration, 0.0)
            opening["end_seconds"] = first_source_start + timeline_shift
        for item in generated:
            if item.get("role") == "source" and timeline_shift:
                item["start_seconds"] = float(item["start_seconds"]) + timeline_shift
                item["end_seconds"] = float(item["end_seconds"]) + timeline_shift
        ending = next((item for item in generated if item.get("role") == "ending"), None)
        ending_duration = 0.0
        if ending is not None:
            last_source_end = max(float(item["end_seconds"]) for item in generated if item.get("role") == "source")
            ending_duration = self._probe_media_duration_seconds(Path(ending["audio_path"]), payload)
            ending["audio_duration_seconds"] = ending_duration
            ending["start_seconds"] = last_source_end
            ending["end_seconds"] = last_source_end + ending_duration
        total_seconds = max(
            float(source_duration or 0) + timeline_shift,
            max(float(item["end_seconds"]) for item in generated),
            0.1,
        )
        output_path = workdir / "video_language_timed_audio.m4a"
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=stereo",
        ]
        for item in generated:
            command.extend(["-i", str(item["audio_path"])])
        filters = [f"[0:a]atrim=0:{total_seconds:.3f},asetpts=N/SR/TB[base]"]
        labels = ["[base]"]
        for index, item in enumerate(generated, start=1):
            delay_ms = max(int(round(float(item["start_seconds"]) * 1000)), 0)
            filters.append(
                f"[{index}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={delay_ms}:all=1,"
                f"apad,atrim=0:{total_seconds:.3f},asetpts=N/SR/TB[a{index}]"
            )
            labels.append(f"[a{index}]")
        filters.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0[mixout]")
        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[mixout]",
                "-t",
                f"{total_seconds:.3f}",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                str(output_path),
            ]
        )
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not output_path.exists():
            raise RuntimeError(f"ffmpeg timed language audio composition failed: {_text(stderr)[-1000:]}")
        return output_path, generated, total_seconds

    @staticmethod
    def _probe_media_duration_seconds(path: Path, payload: dict[str, Any]) -> float:
        ffprobe = _text(payload.get("ffprobe_path")) or shutil.which("ffprobe") or ""
        if not ffprobe:
            return 0.0
        completed = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        return max(_number(completed.stdout, 0.0), 0.0) if completed.returncode == 0 else 0.0

    def _resolve_media(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        media_kind: str,
        local_values: tuple[Any, ...],
        remote_values: tuple[Any, ...],
    ) -> str:
        context.check_cancelled()
        for value in remote_values:
            if _is_url(value):
                return _text(value)
        local = next((_text(value) for value in local_values if _text(value)), "")
        if not local:
            raise RuntimeError(f"{media_kind} 缺少本地文件或 URL")
        path = Path(local).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"{media_kind} 文件不存在: {path}")
        resolver = payload.get("_video_media_url_resolver") or payload.get("_media_url_resolver")
        if callable(resolver):
            return _text(
                _invoke_compatible(
                    resolver,
                    task_id=str(task_id),
                    media_kind=str(media_kind),
                    api_key=self._api_key(payload),
                    local_path=str(path),
                    remote_url="",
                    upload_server_ip=payload.get("upload_server_ip"),
                    upload_server_port=payload.get("upload_server_port"),
                    upload_file_api_key=payload.get("upload_file_api_key"),
                )
            )
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
            return self._upload_runninghub_image(path=path, payload=payload)
        raise VideoDependencyError(
            f"{media_kind} 是本地音视频文件；请由 server 注入 _video_media_url_resolver 以复用现有上传链"
        )

    def _upload_runninghub_image(self, *, path: Path, payload: dict[str, Any]) -> str:
        url = f"{self._base_url(payload)}/openapi/v2/media/upload/binary"
        headers = {"Authorization": f"Bearer {self._api_key(payload)}"}
        with path.open("rb") as handle:
            response = self.http.post(url, headers=headers, files={"file": handle}, timeout=120)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or int(body.get("code", -1)) != 0:
            raise RuntimeError(f"RunningHub 图片上传失败: {json.dumps(body, ensure_ascii=False)[:600]}")
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        result = _text(data.get("download_url") or data.get("downloadUrl") or data.get("fileName") or data.get("url"))
        if not result:
            raise RuntimeError("RunningHub 图片上传成功但未返回可用地址")
        return result

    def _submit_and_poll(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        submit_url: str,
        submit_payload: dict[str, Any],
        output_path: Path,
        label: str,
    ) -> dict[str, Any]:
        api_key = self._api_key(payload)
        runninghub_task_id = _text(payload.get("resume_runninghub_task_id"))
        resumed = bool(runninghub_task_id)
        submit_body: Any = None
        common = runninghub_common
        if not resumed:
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
            max_submit_attempts = max(_integer(payload.get("video_submit_retries"), 8), 1)
            normalized: dict[str, Any] = {}
            for attempt in range(1, max_submit_attempts + 1):
                context.check_cancelled()
                checkpoint = payload.get("_checkpoint_video_progress")
                if callable(checkpoint):
                    _invoke_compatible(
                        checkpoint,
                        task_id=str(task_id),
                        stage="provider_submitting",
                        provider_submission_key=(
                            f"{task_id}:{label}:{_integer(payload.get('_segment_index'), 0)}:{attempt}"
                        ),
                        provider_submit_attempt=attempt,
                        segment_index=_integer(payload.get("_segment_index"), 0),
                        message=f"{label} provider submission is in flight",
                    )
                response = self.http.post(submit_url, headers=headers, data=json.dumps(submit_payload, ensure_ascii=False), timeout=120)
                response.raise_for_status()
                submit_body = response.json()
                normalized = common._normalize_submit_result(submit_body)
                runninghub_task_id = _text(normalized.get("task_id") or normalized.get("task id"))
                if runninghub_task_id:
                    break
                if not common.is_queue_limit_error(submit_body) or attempt >= max_submit_attempts:
                    raise RuntimeError(f"{label}提交失败: {json.dumps(submit_body, ensure_ascii=False)[:800]}")
                self._interruptible_wait(context, min(2.0 * (1.35 ** (attempt - 1)), 20.0))
            else:
                raise RuntimeError(f"{label}提交失败")

        register = payload.get("_register_runninghub_task")
        if callable(register):
            _invoke_compatible(register, task_id=str(task_id), runninghub_task_id=runninghub_task_id)
        checkpoint = payload.get("_checkpoint_video_progress")
        if callable(checkpoint):
            _invoke_compatible(
                checkpoint,
                task_id=str(task_id),
                stage="provider_running",
                segment_index=_integer(payload.get("_segment_index"), 0),
                message=f"{label} provider task is running",
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        timeout_seconds = max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30)
        poll_seconds = max(_number(payload.get("video_poll_interval_seconds"), 3.0), 0.25)
        started = time.monotonic()
        last: dict[str, Any] = {}
        while time.monotonic() - started <= timeout_seconds:
            context.check_cancelled()
            last = common.query_task(
                task_id=runninghub_task_id,
                api_key=api_key,
                video_output_path=str(output_path),
                base_url=self._base_url(payload),
            )
            status = _text(last.get("status")).lower()
            progress = last.get("progress")
            context.progress(stage="runninghub", status="running", message=f"{label}执行中", progress=progress)
            if status == "success":
                if callable(checkpoint):
                    _invoke_compatible(
                        checkpoint,
                        task_id=str(task_id),
                        stage="provider_success",
                        segment_index=_integer(payload.get("_segment_index"), 0),
                        message=f"{label} provider task completed",
                    )
                return {
                    **last,
                    "status": "success",
                    "task_id": runninghub_task_id,
                    "runninghub_task_id": runninghub_task_id,
                    "provider_task_id": runninghub_task_id,
                    "resumed": resumed,
                    "submit": submit_body,
                }
            if status == "failed":
                if callable(checkpoint):
                    _invoke_compatible(
                        checkpoint,
                        task_id=str(task_id),
                        stage="provider_failed",
                        segment_index=_integer(payload.get("_segment_index"), 0),
                        message=f"{label} provider task failed",
                    )
                return {
                    **last,
                    "status": "failed",
                    "task_id": runninghub_task_id,
                    "runninghub_task_id": runninghub_task_id,
                    "provider_task_id": runninghub_task_id,
                    "resumed": resumed,
                    "submit": submit_body,
                }
            self._interruptible_wait(context, poll_seconds)
        raise TimeoutError(f"{label}等待超时: {runninghub_task_id}")

    @staticmethod
    def _interruptible_wait(context: VideoTaskContext, seconds: float) -> None:
        event = context.cancel_event
        waiter = getattr(event, "wait", None)
        if callable(waiter):
            waiter(max(float(seconds), 0.0))
        else:
            time.sleep(max(float(seconds), 0.0))
        context.check_cancelled()

    @staticmethod
    def _workflow_submit_url(payload: dict[str, Any], app_id: str) -> str:
        base = ArchivedSourceBackend._base_url(payload)
        return f"{base}/openapi/v2/run/ai-app/{app_id}"

    @staticmethod
    def _digital_human_fusion_count(payload: dict[str, Any], mode: str) -> int:
        requested = _integer(payload.get("digital_human_fusion_count"), 0)
        count = requested or (4 if str(mode or "").strip().lower() == "storyboard" else 1)
        return min(max(count, 1), 4)

    @staticmethod
    def _digital_human_main_fusion_prompt(payload: dict[str, Any], speech_text: str, storyboard: list[Any]) -> str:
        explicit = _text(payload.get("fusion_main_prompt"))
        if explicit:
            return explicit
        ratio = _text(payload.get("ratio") or payload.get("ratio_label") or payload.get("image_size")) or "9:16"
        storyboard_text = "; ".join(
            _text(item.get("description") or item.get("scene") or item.get("visual_prompt") or item.get("prompt"))
            for item in storyboard
            if isinstance(item, dict)
        )
        context_text = "; ".join(value for value in (speech_text, storyboard_text) if value)
        return (
            f"Create one photorealistic {ratio} digital-human presenter and product fusion master image. "
            "@Image 1 is the exact product reference and @Image 2 is the exact presenter identity reference. "
            "Preserve the presenter's face, hair, body proportions and clothing, and preserve the product's shape, "
            "materials, colors, branding and proportions. Integrate both in one physically plausible scene with "
            "consistent perspective, contact, occlusion, lighting and shadows. Use a natural eye-level talking-video "
            "composition, no split screen, no collage, no readable text, no watermark and no white border. "
            f"Content context: {context_text or 'present the referenced product naturally'}."
        )

    @staticmethod
    def _digital_human_consistency_view_prompt(
        payload: dict[str, Any],
        *,
        view_index: int,
        speech_text: str,
        storyboard: list[Any],
    ) -> str:
        configured = payload.get("digital_human_view_prompts")
        if isinstance(configured, (list, tuple)) and 0 <= view_index - 2 < len(configured):
            explicit = _text(configured[view_index - 2])
            if explicit:
                return explicit
        plans = {
            2: "Move to a three-quarter left, eye-level medium close-up while keeping the presenter facing the camera.",
            3: "Move to a three-quarter right or side-front eye-level medium shot with a different natural gesture.",
            4: "Use a new eye-level medium close-up with changed framing and presenter position for the closing view.",
        }
        storyboard_prompt = ""
        storyboard_offset = view_index - 1
        if 0 <= storyboard_offset < len(storyboard) and isinstance(storyboard[storyboard_offset], dict):
            storyboard_prompt = _text(
                storyboard[storyboard_offset].get("visual_prompt")
                or storyboard[storyboard_offset].get("prompt")
                or storyboard[storyboard_offset].get("description")
                or storyboard[storyboard_offset].get("scene")
            )
        return (
            "Generate one new consistency view for the same digital-human talking video. "
            "@Image 1 is the confirmed fusion master image and is the authoritative reference for the complete scene, "
            "presenter identity and exact product appearance. @Image 2 is the original presenter identity reference. "
            f"{plans.get(view_index, 'Use a clearly different eye-level camera position and natural presenter gesture.')} "
            "Keep the same person, product, clothing, environment, lighting logic and visual style; change only camera "
            "position, framing, pose and gesture. Do not replace the scene or redesign the product. Keep the face clear, "
            "the product recognizable, and produce one continuous photorealistic frame without text, watermark or border. "
            f"Shot direction: {storyboard_prompt or speech_text or 'continue the same product presentation'}."
        )

    def generate_digital_human_fusion_main(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        speech_text: str,
        storyboard: list[Any],
        model_references: list[str],
        product_references: list[str],
        **_kwargs: Any,
    ) -> dict[str, Any]:
        context.check_cancelled()
        local_models = [value for value in model_references if not value.lower().startswith(("http://", "https://"))]
        local_products = [value for value in product_references if not value.lower().startswith(("http://", "https://"))]
        if not local_models or not local_products:
            raise ValueError("digital human image fusion requires local model and product references")
        main_payload = dict(payload)
        for key in ("mode", "image_count", "imageCount", "nano_images", "count", "resume_checkpoint"):
            main_payload.pop(key, None)
        main_payload.update(
            {
                "output_dir": str((Path(workdir) / "digital_human_fusion" / "main").resolve()),
                "video_image_mode": "model_product",
                "product_image_local_path": local_products[0],
                "model_image_local_path": local_models[0],
                "secondary_image_local_path": local_models[1] if len(local_models) > 1 else None,
                "product_image_local_paths": local_products[1:2],
                "prompt": self._digital_human_main_fusion_prompt(payload, speech_text, storyboard),
                "count": 1,
            }
        )
        result = digital_human_image_quality.run_digital_human_image_generate_with_quality_gate(
            f"{task_id}-fusion-main",
            main_payload,
            product_category=payload.get("product_category") or payload.get("category"),
            generate_image=lambda image_task_id, image_payload: self.image_generate(
                task_id=image_task_id,
                payload=image_payload,
                context=context,
            ),
            visual_semantic_llm=(
                payload.get("_digital_human_visual_semantic_llm")
                if callable(payload.get("_digital_human_visual_semantic_llm"))
                else None
            ),
            context=context,
        )
        context.check_cancelled()
        main_path = _text(result.get("image_path") or result.get("download_path")) if isinstance(result, dict) else ""
        if not main_path or not Path(main_path).is_file():
            raise RuntimeError("digital human fusion main image generation returned no local image")
        normalized = dict(result) if isinstance(result, dict) else {}
        normalized.update(
            {
                "ok": True,
                "image_path": str(Path(main_path).resolve()),
                "fusion_main_image": str(Path(main_path).resolve()),
                "fusion_images": [str(Path(main_path).resolve())],
            }
        )
        return normalized

    def generate_digital_human_single_consistency_view(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        main_image_path: str,
        view_index: int,
        speech_text: str,
        storyboard: list[Any],
        model_references: list[str],
        image_task_id: str = "",
        **_kwargs: Any,
    ) -> dict[str, Any]:
        context.check_cancelled()
        index = max(_integer(view_index, 2), 2)
        main_path = Path(main_image_path).expanduser().resolve()
        if not main_path.is_file():
            raise FileNotFoundError(f"digital human fusion main image does not exist: {main_path}")
        local_models = [value for value in model_references if not value.lower().startswith(("http://", "https://"))]
        if not local_models:
            raise ValueError("digital human consistency view requires a local model reference")
        view_payload = dict(payload)
        for key in ("mode", "image_count", "imageCount", "nano_images", "count", "resume_checkpoint"):
            view_payload.pop(key, None)
        view_payload.update(
            {
                "output_dir": str((Path(workdir) / "digital_human_fusion" / f"view_{index}").resolve()),
                "video_image_mode": "model_product",
                "product_image_local_path": str(main_path),
                "model_image_local_path": local_models[0],
                "secondary_image_local_path": local_models[1] if len(local_models) > 1 else None,
                "product_image_local_paths": [],
                "prompt": self._digital_human_consistency_view_prompt(
                    payload,
                    view_index=index,
                    speech_text=speech_text,
                    storyboard=storyboard,
                ),
                "count": 1,
            }
        )
        result = digital_human_image_quality.run_digital_human_image_generate_with_quality_gate(
            _text(image_task_id) or f"{task_id}-fusion-view-{index}",
            view_payload,
            product_category=payload.get("product_category") or payload.get("category"),
            generate_image=lambda view_task_id, view_generation_payload: self.image_generate(
                task_id=view_task_id,
                payload=view_generation_payload,
                context=context,
            ),
            visual_semantic_llm=(
                payload.get("_digital_human_visual_semantic_llm")
                if callable(payload.get("_digital_human_visual_semantic_llm"))
                else None
            ),
            context=context,
        )
        context.check_cancelled()
        view_path = _text(result.get("image_path") or result.get("download_path")) if isinstance(result, dict) else ""
        if not view_path or not Path(view_path).is_file():
            raise RuntimeError(f"digital human consistency view {index} returned no local image")
        normalized = dict(result) if isinstance(result, dict) else {}
        normalized.update(
            {
                "ok": True,
                "view_index": index,
                "image_path": str(Path(view_path).resolve()),
                "fusion_images": [str(Path(view_path).resolve())],
            }
        )
        return normalized

    def generate_digital_human_consistency_views(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        main_image_path: str,
        speech_text: str,
        storyboard: list[Any],
        mode: str,
        model_references: list[str],
        existing_fusion_images: list[str] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        context.check_cancelled()
        main_path = str(Path(main_image_path).expanduser().resolve())
        paths = _unique_text_values([main_path, *(existing_fusion_images or [])])
        if not paths or paths[0] != main_path:
            paths.insert(0, main_path)
        desired_count = self._digital_human_fusion_count(payload, mode)
        checkpoint = payload.get("resume_checkpoint") if isinstance(payload.get("resume_checkpoint"), dict) else {}
        task_ids = _unique_provider_ids(
            [
                payload.get("_digital_human_fusion_runninghub_task_ids"),
                checkpoint.get("runninghub_task_ids"),
                checkpoint.get("runninghub_task_id"),
            ]
        )
        results: list[dict[str, Any]] = []
        resume_task_id = _text(payload.get("resume_runninghub_task_id"))
        missing_view_indexes = [
            view_index
            for view_index in range(2, desired_count + 1)
            if len(paths) <= view_index - 1 or not Path(paths[view_index - 1]).is_file()
        ]
        first_resume_index = missing_view_indexes[0] if resume_task_id and missing_view_indexes else 0
        late_view_indexes: dict[str, int] = {}

        def generate_one_view(view_index: int, attempt: int, attempt_task_id: str) -> dict[str, Any]:
            view_payload = dict(payload)
            late_view_indexes[attempt_task_id] = view_index
            if resume_task_id and view_index == first_resume_index and attempt == 1:
                view_payload["resume_runninghub_task_id"] = resume_task_id
            else:
                view_payload.pop("resume_runninghub_task_id", None)
            return self.generate_digital_human_single_consistency_view(
                task_id=attempt_task_id,
                payload=view_payload,
                context=context,
                workdir=workdir,
                main_image_path=main_path,
                view_index=view_index,
                speech_text=speech_text,
                storyboard=storyboard,
                model_references=model_references,
                image_task_id=(
                    f"{task_id}-fusion-view-{view_index}"
                    if attempt == 1
                    else f"{task_id}-fusion-view-{view_index}-retry-{attempt}"
                ),
            )

        def late_view_output(attempt_task_id: str, _error: Exception) -> dict[str, Any] | None:
            view_index = late_view_indexes.get(attempt_task_id)
            if not view_index:
                return None
            output_dir = Path(workdir) / "digital_human_fusion" / f"view_{view_index}"
            candidates = sorted(
                (
                    path for path in output_dir.rglob("*")
                    if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                ),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            ) if output_dir.exists() else []
            if not candidates:
                return None
            return {"ok": True, "view_index": view_index, "image_path": str(candidates[0].resolve()), "late_output": True}

        if missing_view_indexes:
            view_retry_count = min(
                max(
                    _integer(
                        payload.get("_digital_human_view_retry_count", payload.get("digital_human_view_retry_count")),
                        0,
                    ),
                    0,
                ),
                2,
            )
            if view_retry_count <= 0:
                generated_views = []
                view_attempts = {}
                for view_index in missing_view_indexes:
                    result = generate_one_view(
                        view_index,
                        1,
                        f"{context.task_id}_fusion-view_{view_index}_try1",
                    )
                    generated_views.append(result)
                    view_attempts[view_index] = 1
                    slot = view_index - 1
                    while len(paths) <= slot:
                        paths.append("")
                    paths[slot] = _text(result.get("image_path"))
                    task_ids = _unique_provider_ids(
                        [task_ids, result.get("runninghub_task_ids"), result.get("runninghub_task_id")]
                    )
                    checkpoint_callback = payload.get("_checkpoint_video_progress")
                    if callable(checkpoint_callback):
                        _invoke_compatible(
                            checkpoint_callback,
                            task_id=str(task_id),
                            stage="digital_human_fusion_views_partial",
                            fusion_images=list(paths),
                            runninghub_task_id=task_ids[-1] if task_ids else "",
                            runninghub_task_ids=task_ids,
                            message=f"Digital-human consistency view {view_index}/{desired_count} complete",
                        )
            else:
                generated_views, view_attempts = digital_human_views.run_digital_human_view_images_parallel(
                    view_indexes=missing_view_indexes,
                    generate_one=generate_one_view,
                    late_output=late_view_output,
                    context=context,
                    max_workers=min(max(_integer(payload.get("digital_human_view_parallelism"), 3), 1), 3),
                    retries=view_retry_count,
                    task_suffix="fusion-view",
                    stage_message="Generating digital-human consistency views",
                )
        else:
            generated_views, view_attempts = [], {}

        for result in generated_views:
            view_index = max(_integer(result.get("view_index"), 0), 0)
            if view_index <= 1:
                raise RuntimeError("digital human consistency view returned an invalid view index")
            slot = view_index - 1
            view_path = _text(result.get("image_path"))
            while len(paths) <= slot:
                paths.append("")
            paths[slot] = view_path
            results.append(result)
            task_ids = _unique_provider_ids([task_ids, result.get("runninghub_task_ids"), result.get("runninghub_task_id")])
            checkpoint = payload.get("_checkpoint_video_progress")
            if callable(checkpoint):
                _invoke_compatible(
                    checkpoint,
                    task_id=str(task_id),
                    stage="digital_human_fusion_views_partial",
                    fusion_images=list(paths),
                    runninghub_task_id=task_ids[-1] if task_ids else "",
                    runninghub_task_ids=task_ids,
                    message=f"Digital-human consistency view {view_index}/{desired_count} complete",
                )
        if len(paths) < desired_count or any(not _text(path) or not Path(path).is_file() for path in paths[:desired_count]):
            raise RuntimeError("digital human consistency view generation did not complete every required view")
        return {
            "ok": True,
            "image_path": paths[0],
            "image_paths": paths[:desired_count],
            "fusion_main_image": paths[0],
            "fusion_images": paths[:desired_count],
            "runninghub_task_id": task_ids[-1] if task_ids else "",
            "runninghub_task_ids": task_ids,
            "runninghub_usage": _merge_runninghub_usage(results),
            "raw_result": {"view_results": results, "view_attempts": view_attempts},
        }

    def generate_digital_human_fusion_views(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        speech_text: str,
        storyboard: list[Any],
        mode: str,
        model_references: list[str],
        product_references: list[str],
        **_kwargs: Any,
    ) -> dict[str, Any]:
        resume_checkpoint = payload.get("resume_checkpoint") if isinstance(payload.get("resume_checkpoint"), dict) else {}
        existing = payload.get("digital_human_fusion_image_paths") or resume_checkpoint.get("fusion_images") or []
        if isinstance(existing, (str, Path)):
            existing = [str(existing)]
        existing = [value for value in _unique_text_values(list(existing)) if Path(value).is_file()]
        main_result: dict[str, Any] = {}
        if not existing:
            main_result = self.generate_digital_human_fusion_main(
                task_id=task_id,
                payload=payload,
                context=context,
                workdir=workdir,
                speech_text=speech_text,
                storyboard=storyboard,
                model_references=model_references,
                product_references=product_references,
            )
            existing = [str(main_result["image_path"])]
        views_result = self.generate_digital_human_consistency_views(
            task_id=task_id,
            payload=payload,
            context=context,
            workdir=workdir,
            main_image_path=existing[0],
            speech_text=speech_text,
            storyboard=storyboard,
            mode=mode,
            model_references=model_references,
            existing_fusion_images=existing,
        )
        task_ids = _unique_provider_ids(
            [
                main_result.get("runninghub_task_ids"),
                main_result.get("runninghub_task_id"),
                views_result.get("runninghub_task_ids"),
                views_result.get("runninghub_task_id"),
            ]
        )
        views_result["runninghub_task_id"] = task_ids[-1] if task_ids else ""
        views_result["runninghub_task_ids"] = task_ids
        views_result["runninghub_usage"] = _merge_runninghub_usage(main_result, views_result)
        return views_result

    @staticmethod
    def _digital_human_workflow_ids(payload: dict[str, Any]) -> list[str]:
        raw = payload.get("oral_digital_human_workflow_ids")
        values = raw if isinstance(raw, (list, tuple)) else str(raw or "").split(",")
        workflow_ids = _unique_provider_ids(list(values))
        if not workflow_ids:
            workflow_ids = _unique_provider_ids(
                [payload.get("video_create_video_app_id"), payload.get("create_video_app_id"), payload.get("video_app_id")]
            )
        return workflow_ids or [DIGITAL_HUMAN_VIDEO_APP_ID]

    def _split_digital_human_audio(
        self,
        *,
        audio_path: Path,
        duration_seconds: float,
        segment_index: int,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> list[tuple[Path, float]]:
        total = max(float(duration_seconds or 0), 0.0)
        max_seconds = 15.0
        if total <= max_seconds + 0.25:
            return [(audio_path, max(total, 1.0))]
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("digital human audio longer than 15 seconds requires ffmpeg splitting")
        split_dir = Path(workdir) / "digital_human_short_out" / "audio" / f"{segment_index}_parts"
        split_dir.mkdir(parents=True, exist_ok=True)
        parts: list[tuple[Path, float]] = []
        part_count = int(math.ceil(total / max_seconds))
        for part_index in range(part_count):
            context.check_cancelled()
            start = part_index * max_seconds
            length = min(max_seconds, total - start)
            part_path = split_dir / f"{part_index + 1:02d}.m4a"
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-t",
                f"{length:.3f}",
                "-i",
                str(audio_path),
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                str(part_path),
            ]
            returncode, _stdout, stderr = _run_local_process(
                command,
                timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
                payload=payload,
                context=context,
            )
            if returncode != 0 or not part_path.exists():
                raise RuntimeError(f"ffmpeg digital human audio split failed: {_text(stderr)[-1000:]}")
            parts.append((part_path, max(length, 1.0)))
        return parts

    def generate_digital_human_segment(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        output_path: Path,
        segment_index: int,
        script_text: str,
        prompt_text: str,
        source_image_path: str,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        segment_payload = dict(payload)
        resume_runninghub_task_id = _text(segment_payload.pop("resume_runninghub_task_id", ""))
        segment_payload.setdefault("audio_speed", 1.08)
        cached_voice_id = _text(payload.get("_digital_human_cloned_voice_id"))
        if not cached_voice_id and _text(payload.get("audio_local_path") or payload.get("voice_audio_local_path")):
            prepared = language_voice_pipeline.prepare_language_voice_settings(payload, context, workdir)
            cached_voice_id = _text(prepared.get("cloned_voice_id"))
            if cached_voice_id:
                payload["_digital_human_cloned_voice_id"] = cached_voice_id
        if cached_voice_id:
            segment_payload["video_default_voice_id"] = cached_voice_id
            segment_payload["minimax_tts_voice_id"] = cached_voice_id
        audio_path = self._generate_minimax_tts(
            speech_text=script_text,
            output_path=(Path(workdir) / "digital_human_short_out" / "audio" / f"{segment_index}.mp3").resolve(),
            payload=segment_payload,
            context=context,
        )
        image_url = self._resolve_media(
            task_id=task_id,
            payload=segment_payload,
            context=context,
            media_kind=f"digital_human_segment_{segment_index}_image",
            local_values=(source_image_path,),
            remote_values=(),
        )
        precise_duration = max(float(self._probe_duration(audio_path, segment_payload) or 0), 1.0)
        audio_parts = self._split_digital_human_audio(
            audio_path=audio_path,
            duration_seconds=precise_duration,
            segment_index=segment_index,
            payload=segment_payload,
            context=context,
            workdir=Path(workdir),
        )
        provider_ids: list[str] = []
        workflow_ids = self._digital_human_workflow_ids(segment_payload)
        video_parts: list[Path] = []
        for audio_part_index, (audio_part_path, audio_part_duration) in enumerate(audio_parts, start=1):
            audio_url = self._resolve_media(
                task_id=task_id,
                payload=segment_payload,
                context=context,
                media_kind=f"digital_human_segment_{segment_index}_audio_{audio_part_index}",
                local_values=(str(audio_part_path),),
                remote_values=(),
            )
            current_video_url = ""
            part_output = (
                Path(output_path)
                if len(audio_parts) == 1
                else Path(workdir) / "digital_human_short_out" / "videos" / f"{segment_index}_audio_{audio_part_index}.mp4"
            )
            for step_index, app_id in enumerate(workflow_ids, start=1):
                context.check_cancelled()
                step_output = part_output if step_index == len(workflow_ids) else (
                    Path(workdir) / "digital_human_short_out" / "videos" / f"{segment_index}_audio_{audio_part_index}_step_{step_index}.mp4"
                )
                nodes = source_create_video._build_node_info_list(
                    app_id=app_id,
                    image_url=image_url,
                    audio_url=audio_url,
                    duration_seconds=max(_integer(audio_part_duration, 1), 1),
                    prompt_text=prompt_text,
                    camera_video_url=current_video_url or None,
                    max_resolution=source_create_video.CURRENT_VIDEO_MAX_RESOLUTION,
                )
                step_payload = {**segment_payload, "_segment_index": segment_index}
                if resume_runninghub_task_id:
                    step_payload["resume_runninghub_task_id"] = resume_runninghub_task_id
                    resume_runninghub_task_id = ""
                result = self._submit_and_poll(
                    task_id=task_id,
                    payload=step_payload,
                    context=context,
                    submit_url=self._workflow_submit_url(step_payload, app_id),
                    submit_payload={
                        "nodeInfoList": nodes,
                        "instanceType": source_create_video.resolve_instance_type_for_workflow(
                            app_id, _text(step_payload.get("instance_type") or "default")
                        ),
                        "usePersonalQueue": _boolean(
                            step_payload.get("use_personal_queue"), name="use_personal_queue", default=False
                        ),
                    },
                    output_path=step_output,
                    label=f"digital human segment {segment_index} audio {audio_part_index} step {step_index}",
                )
                if _text(result.get("status")).lower() != "success":
                    raise RuntimeError(_text(result.get("message")) or f"digital human workflow {app_id} failed")
                provider_id = _text(result.get("runninghub_task_id"))
                if provider_id:
                    provider_ids.append(provider_id)
                if step_index < len(workflow_ids):
                    current_video_url = self._resolve_media(
                        task_id=task_id,
                        payload=step_payload,
                        context=context,
                        media_kind=f"digital_human_segment_{segment_index}_audio_{audio_part_index}_step_{step_index}_video",
                        local_values=(str(step_output),),
                        remote_values=(),
                    )
            video_parts.append(part_output)
        if len(video_parts) > 1:
            self._concat_ecommerce_segments(
                segment_paths=video_parts,
                output_path=Path(output_path),
                payload=segment_payload,
                context=context,
                workdir=Path(workdir),
            )
        return {
            "ok": True,
            "status": "success",
            "video_path": str(Path(output_path).resolve()),
            "duration_seconds": precise_duration,
            "runninghub_task_id": provider_ids[-1] if provider_ids else "",
            "runninghub_task_ids": provider_ids,
        }

    def concat_digital_human_segments(
        self,
        *,
        video_paths: list[Path],
        output_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        context.check_cancelled()
        segment_paths = [Path(value).expanduser().resolve() for value in video_paths]
        tail_noise_trims: list[dict[str, Any]] = []
        if self._digital_human_segment_tail_audio_cleanup_enabled(payload):
            segment_paths, tail_noise_trims = self._clean_video_segments_tail_audio_noise(
                segment_paths,
                output_dir=Path(workdir) / "tail_audio_noise_trimmed_segments",
                payload=payload,
                context=context,
            )
        context.check_cancelled()
        join_cleanup_trims: list[dict[str, Any]] = []

        def probe_segment(path: Path, **_values: Any) -> float:
            return self._postprocess_duration(Path(path), payload)

        def run_cleanup_process(command: list[str], timeout_seconds: int = 300, **_values: Any) -> tuple[int, str, str]:
            return _run_local_process(
                list(command),
                timeout_seconds=max(int(timeout_seconds or 300), 1),
                payload=payload,
                context=context,
            )

        segment_paths, join_cleanup_trims = digital_human_join_cleanup.normalize_digital_human_segment_joins(
            segment_paths,
            output_dir=Path(workdir) / "segment_join_cleanup",
            payload=payload,
            context=context,
            probe=probe_segment,
            run=run_cleanup_process,
        )
        context.check_cancelled()
        requested_crossfade_seconds = self._digital_human_effective_micro_crossfade_seconds(
            segment_paths,
            payload=payload,
            context=context,
        )
        crossfade_applied = self._concat_digital_human_video_segments(
            segment_paths,
            Path(output_path),
            payload=payload,
            context=context,
            workdir=Path(workdir),
            crossfade_seconds=requested_crossfade_seconds,
        )
        context.check_cancelled()
        return {
            "ok": True,
            "video_path": str(Path(output_path).resolve()),
            "tail_audio_noise_trims": tail_noise_trims,
            "segment_join_cleanup_trims": join_cleanup_trims,
            "segment_join_crossfade_seconds": requested_crossfade_seconds if crossfade_applied else 0.0,
        }

    def build_digital_human_segment_previews(
        self,
        *,
        video_paths: list[Path],
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        def probe_segment(path: Path, **_values: Any) -> float:
            return self._postprocess_duration(Path(path), payload)

        def run_preview_process(command: list[str], timeout_seconds: int = 600, **_values: Any) -> tuple[int, str, str]:
            return _run_local_process(
                list(command),
                timeout_seconds=max(int(timeout_seconds or 600), 1),
                payload=payload,
                context=context,
            )

        paths, metadata = digital_human_audio_postprocess.build_digital_human_segment_previews(
            video_paths,
            output_dir=Path(workdir) / "segment_preview_tail_padded",
            payload=payload,
            context=context,
            probe=probe_segment,
            run=run_preview_process,
        )
        return {"paths": [str(path) for path in paths], "metadata": metadata}

    def postprocess_digital_human_audio(
        self,
        *,
        video_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        def probe_video(path: Path, **_values: Any) -> float:
            return self._postprocess_duration(Path(path), payload)

        def run_audio_process(command: list[str], timeout_seconds: int = 600, **_values: Any) -> tuple[int, str, str]:
            return _run_local_process(
                list(command),
                timeout_seconds=max(int(timeout_seconds or 600), 1),
                payload=payload,
                context=context,
            )

        output, metadata = digital_human_audio_postprocess.postprocess_digital_human_audio(
            video_path,
            payload=payload,
            context=context,
            probe=probe_video,
            run=run_audio_process,
        )
        return {"video_path": str(output), **metadata}

    @staticmethod
    def _digital_human_segment_tail_audio_cleanup_enabled(payload: dict[str, Any] | None = None) -> bool:
        source = payload or {}
        for key in (
            "digital_human_segment_tail_audio_cleanup_enabled",
            "digital_human_clean_segment_tail_audio_noise",
        ):
            if key in source:
                return _boolean(source.get(key), name=key, default=False)
        return _boolean(
            os.getenv("DIGITAL_HUMAN_SEGMENT_TAIL_AUDIO_CLEANUP_ENABLED", "false"),
            name="DIGITAL_HUMAN_SEGMENT_TAIL_AUDIO_CLEANUP_ENABLED",
            default=False,
        )

    @staticmethod
    def _digital_human_audio_micro_crossfade_seconds(payload: dict[str, Any] | None = None) -> float:
        source = payload or {}
        value = source.get("digital_human_audio_micro_crossfade_seconds")
        if value is None:
            value = os.getenv("DIGITAL_HUMAN_AUDIO_MICRO_CROSSFADE_SECONDS", "0.04")
        return min(max(_number(value, 0.04), 0.0), 0.12)

    def _postprocess_duration(self, path: Path, payload: dict[str, Any]) -> float:
        probe_payload = dict(payload or {})
        probe_payload.pop("source_video_duration_seconds", None)
        probe_payload.pop("duration_seconds", None)
        return self._probe_duration(Path(path), probe_payload)

    def _detect_audio_silence_ranges(
        self,
        media_path: Path,
        *,
        duration_seconds: float,
        payload: dict[str, Any],
        context: VideoTaskContext,
        noise_db: str = "-34dB",
        min_silence: float = 0.12,
    ) -> list[tuple[float, float]]:
        if duration_seconds <= 0:
            return []
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("digital human audio silence detection requires ffmpeg")
        context.check_cancelled()
        returncode, stdout, stderr = _run_local_process(
            [
                ffmpeg,
                "-hide_banner",
                "-i",
                str(media_path),
                "-af",
                f"silencedetect=noise={noise_db}:d={max(float(min_silence or 0.0), 0.05):.3f}",
                "-f",
                "null",
                "-",
            ],
            timeout_seconds=min(max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30), 120),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        text = f"{stdout or ''}\n{stderr or ''}"
        if returncode != 0 and not text.strip():
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

    def _tail_audio_noise_trim_seconds(
        self,
        media_path: Path,
        *,
        payload: dict[str, Any],
        context: VideoTaskContext,
        duration_seconds: float | None = None,
        max_noise_seconds: float = 0.9,
        min_noise_seconds: float = 0.08,
        min_preceding_silence: float = 0.12,
        keep_quiet_tail_seconds: float = 0.08,
    ) -> float | None:
        duration = float(duration_seconds or 0.0)
        if duration <= 0:
            duration = self._postprocess_duration(media_path, payload)
        if duration <= 0.5:
            return None
        try:
            silence_ranges = self._detect_audio_silence_ranges(
                media_path,
                duration_seconds=duration,
                payload=payload,
                context=context,
                min_silence=min_preceding_silence,
            )
        except VideoTaskCancelled:
            raise
        except Exception:
            return None
        for silence_start, silence_end in reversed(silence_ranges):
            tail_noise_seconds = duration - silence_end
            if tail_noise_seconds < min_noise_seconds or tail_noise_seconds > max_noise_seconds:
                continue
            if silence_end - silence_start < min_preceding_silence:
                continue
            if duration - silence_start > max_noise_seconds + 1.4:
                continue
            trim_at = min(max(silence_start + keep_quiet_tail_seconds, 0.2), silence_end)
            if duration - trim_at >= min_noise_seconds + min_preceding_silence:
                return trim_at
        return None

    def _trim_video_tail_audio_noise(
        self,
        input_path: Path,
        output_path: Path,
        *,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> Path:
        source = Path(input_path).expanduser().resolve()
        duration = self._postprocess_duration(source, payload)
        trim_at = self._tail_audio_noise_trim_seconds(
            source,
            duration_seconds=duration,
            payload=payload,
            context=context,
        )
        if trim_at is None:
            return source
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("digital human tail audio cleanup requires ffmpeg")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        timeout_seconds = max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30)
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
        context.check_cancelled()
        returncode, stdout, stderr = _run_local_process(
            copy_cmd,
            timeout_seconds=min(timeout_seconds, 180),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        copy_ok = returncode == 0 and output_path.exists()
        if copy_ok:
            copied_duration = self._postprocess_duration(output_path, payload)
            if copied_duration <= 0 or copied_duration > trim_at + 0.18 or copied_duration < trim_at - 0.18:
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
                str(output_path),
            ]
            context.check_cancelled()
            returncode, stdout, stderr = _run_local_process(
                reencode_cmd,
                timeout_seconds=min(timeout_seconds, 300),
                payload=payload,
                context=context,
            )
            context.check_cancelled()
            if returncode != 0 or not output_path.exists():
                raise RuntimeError((_text(stderr) or _text(stdout) or "ffmpeg tail noise trim failed")[-1000:])
        return output_path.resolve()

    def _clean_video_segments_tail_audio_noise(
        self,
        segment_paths: list[Path],
        *,
        output_dir: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> tuple[list[Path], list[dict[str, Any]]]:
        cleaned_paths: list[Path] = []
        trims: list[dict[str, Any]] = []
        output_dir.mkdir(parents=True, exist_ok=True)
        for idx, path in enumerate(segment_paths, start=1):
            context.check_cancelled()
            source = Path(path).expanduser().resolve()
            target = output_dir / f"{source.stem}_tail_noise_trimmed{source.suffix or '.mp4'}"
            try:
                cleaned = self._trim_video_tail_audio_noise(
                    source,
                    target,
                    payload=payload,
                    context=context,
                )
            except VideoTaskCancelled:
                raise
            except Exception as exc:
                cleaned_paths.append(source)
                trims.append({"index": idx, "path": str(source), "skipped": str(exc)[:240]})
                continue
            cleaned_paths.append(cleaned)
            if cleaned != source:
                trims.append(
                    {
                        "index": idx,
                        "path": str(source),
                        "trimmed_path": str(cleaned),
                        "original_seconds": self._postprocess_duration(source, payload),
                        "trimmed_seconds": self._postprocess_duration(cleaned, payload),
                        "reason": "tail_audio_noise",
                    }
                )
        return cleaned_paths, trims

    def _digital_human_effective_micro_crossfade_seconds(
        self,
        segment_paths: list[Path],
        *,
        payload: dict[str, Any] | None = None,
        context: VideoTaskContext,
    ) -> float:
        resolved_paths = [
            Path(path).expanduser().resolve()
            for path in segment_paths
            if Path(path).expanduser().exists()
        ]
        if len(resolved_paths) <= 1:
            return 0.0
        crossfade_seconds = self._digital_human_audio_micro_crossfade_seconds(payload)
        if crossfade_seconds <= 0:
            return 0.0
        durations: list[float] = []
        for path in resolved_paths:
            context.check_cancelled()
            durations.append(self._postprocess_duration(path, payload or {}))
        if any(duration <= crossfade_seconds + 0.1 for duration in durations):
            return 0.0
        return crossfade_seconds

    def _concat_digital_human_video_segments(
        self,
        segment_paths: list[Path],
        output_path: Path,
        *,
        payload: dict[str, Any] | None,
        context: VideoTaskContext,
        workdir: Path,
        crossfade_seconds: float | None = None,
    ) -> bool:
        source_payload = payload or {}
        resolved_paths = [
            Path(path).expanduser().resolve()
            for path in segment_paths
            if Path(path).expanduser().exists()
        ]
        if len(resolved_paths) <= 1:
            self._concat_ecommerce_segments(
                segment_paths=resolved_paths,
                output_path=output_path,
                payload=source_payload,
                context=context,
                workdir=workdir,
            )
            return False
        if crossfade_seconds is None:
            crossfade_seconds = self._digital_human_effective_micro_crossfade_seconds(
                resolved_paths,
                payload=source_payload,
                context=context,
            )
        if crossfade_seconds <= 0:
            self._concat_ecommerce_segments(
                segment_paths=resolved_paths,
                output_path=output_path,
                payload=source_payload,
                context=context,
                workdir=workdir,
            )
            return False
        durations = [self._postprocess_duration(path, source_payload) for path in resolved_paths]
        ffmpeg = _text(source_payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("digital human video segment concatenation requires ffmpeg")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        inputs: list[str] = []
        for path in resolved_paths:
            inputs.extend(["-i", str(path)])
        filter_parts: list[str] = []
        video_label = "[0:v:0]"
        audio_label = "[0:a:0]"
        elapsed = float(durations[0])
        for idx in range(1, len(resolved_paths)):
            context.check_cancelled()
            next_video_label = f"[{idx}:v:0]"
            next_audio_label = f"[{idx}:a:0]"
            video_out = f"[vxf{idx}]"
            audio_out = f"[axf{idx}]"
            offset = max(elapsed - crossfade_seconds, 0.0)
            filter_parts.append(
                f"{video_label}{next_video_label}xfade=transition=fade:duration={crossfade_seconds:.3f}:offset={offset:.3f}{video_out}"
            )
            filter_parts.append(
                f"{audio_label}{next_audio_label}acrossfade=d={crossfade_seconds:.3f}:c1=tri:c2=tri{audio_out}"
            )
            video_label = video_out
            audio_label = audio_out
            elapsed += float(durations[idx]) - crossfade_seconds
        command = [
            ffmpeg,
            "-y",
            *inputs,
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            video_label,
            "-map",
            audio_label,
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
        context.check_cancelled()
        returncode, _stdout, _stderr = _run_local_process(
            command,
            timeout_seconds=min(max(_integer(source_payload.get("video_task_timeout_seconds"), 3600), 30), 600),
            payload=source_payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not output_path.exists():
            self._concat_ecommerce_segments(
                segment_paths=resolved_paths,
                output_path=output_path,
                payload=source_payload,
                context=context,
                workdir=workdir,
            )
            return False
        return True

    def create_video(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        return digital_human_pipeline.run_digital_human_pipeline(self, task_id, payload, context)

    def _create_video_single_workflow(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        workdir = self._workdir(task_id, payload)
        image_url = self._resolve_media(
            task_id=task_id,
            payload=payload,
            context=context,
            media_kind="digital_human_image",
            local_values=(payload.get("model_image_local_path"), payload.get("image_local_path"), payload.get("product_image_local_path")),
            remote_values=(payload.get("model_image_url"), payload.get("image_url"), payload.get("product_image_url")),
        )
        audio_local = _text(payload.get("audio_local_path") or payload.get("voice_audio_local_path"))
        audio_remote = _text(payload.get("audio_url") or payload.get("voice_audio_url"))
        if not audio_local and not audio_remote:
            speech_text = _text(payload.get("speech_text") or payload.get("script") or payload.get("copy_text") or payload.get("message"))
            audio_local = str(self._generate_minimax_tts(speech_text=speech_text, output_path=workdir / "speech.mp3", payload=payload, context=context))
        audio_url = self._resolve_media(
            task_id=task_id,
            payload=payload,
            context=context,
            media_kind="digital_human_audio",
            local_values=(audio_local,),
            remote_values=(audio_remote,),
        )
        duration = max(
            _integer(
                payload.get("duration_seconds")
                or payload.get("audio_duration_seconds")
                or payload.get("video_default_duration_seconds")
                or 10,
                10,
            ),
            1,
        )
        app_id = _text(payload.get("video_create_video_app_id") or payload.get("create_video_app_id") or payload.get("video_app_id")) or DIGITAL_HUMAN_VIDEO_APP_ID
        if app_id == DIGITAL_HUMAN_VIDEO_APP_ID:
            nodes = [
                {"nodeId": "269", "fieldName": "image", "fieldValue": image_url, "description": "上传数字人图片"},
                {"nodeId": "332", "fieldName": "audio", "fieldValue": audio_url, "description": "上传口播音频"},
                {"nodeId": "331", "fieldName": "duration", "fieldValue": str(duration), "description": "视频时长（秒）"},
                {"nodeId": "394", "fieldName": "duration", "fieldValue": str(duration), "description": "视频时长（秒）"},
            ]
        else:
            nodes = [
                {"nodeId": "133", "fieldName": "image", "fieldValue": image_url, "description": "上传图像"},
                {"nodeId": "218", "fieldName": "audio", "fieldValue": audio_url, "description": "上传音频"},
                {"nodeId": "230", "fieldName": "value", "fieldValue": "0", "description": "音频开始时间"},
                {"nodeId": "231", "fieldName": "value", "fieldValue": str(duration), "description": "音频结束时间"},
            ]
        output_path = workdir / "digital_human.mp4"
        result = self._submit_and_poll(
            task_id=task_id,
            payload=payload,
            context=context,
            submit_url=self._workflow_submit_url(payload, app_id),
            submit_payload={"nodeInfoList": nodes, "instanceType": "plus", "usePersonalQueue": False},
            output_path=output_path,
            label="数字人口播视频",
        )
        ok = _text(result.get("status")).lower() == "success"
        final_path = output_path
        subtitle_count = 0
        subtitle_warning = ""
        if ok and output_path.exists():
            final_path, subtitle_count, subtitle_warning = self._apply_optional_subtitles(
                video_path=output_path,
                payload=payload,
                context=context,
                workdir=workdir,
                speech_text=_text(payload.get("speech_text") or payload.get("script") or payload.get("copy_text")),
            )
        return {
            "ok": ok,
            "message": "视频流程完成" if ok else _text(result.get("message") or "视频生成失败"),
            "runninghub_task_id": _text(result.get("runninghub_task_id")),
            "runninghub_task_ids": [_text(result.get("runninghub_task_id"))] if _text(result.get("runninghub_task_id")) else [],
            "runninghub_usage": _merge_runninghub_usage(result),
            "speech_text": _text(payload.get("speech_text") or payload.get("script") or payload.get("copy_text")),
            "prompt_text": _text(payload.get("prompt_text") or payload.get("prompt")),
            "video_path": str(final_path) if final_path.exists() else "",
            "download_path": str(final_path) if final_path.exists() else "",
            "subtitle_count": subtitle_count,
            "subtitles_applied": subtitle_count > 0,
            "subtitle_warning": subtitle_warning,
            "raw_result": result,
        }

    def _replace_nodes(self, *, task_type: str, payload: dict[str, Any], video_url: str, image_url: str, app_id: str) -> list[dict[str, Any]]:
        duration = max(_integer(payload.get("duration_seconds") or payload.get("duration") or 10, 10), 1)
        frame = max(_integer(payload.get("frame") or payload.get("frame_rate") or 30, 30), 1)
        width = max(_integer(payload.get("width") or 576, 576), 1)
        height = max(_integer(payload.get("height") or 1024, 1024), 1)
        prompt = _text(payload.get("prompt") or payload.get("prompt_text") or payload.get("message"))
        if task_type == "replace_product":
            return [
                {"nodeId": "188", "fieldName": "video", "fieldValue": video_url, "description": "请导入视频"},
                {"nodeId": "57", "fieldName": "image", "fieldValue": image_url, "description": "请导入产品图片"},
                {"nodeId": "197", "fieldName": "text", "fieldValue": prompt, "description": "提示词"},
                {"nodeId": "304", "fieldName": "value", "fieldValue": _text(payload.get("product_name")), "description": "被替换商品名称"},
                {"nodeId": "297", "fieldName": "int", "fieldValue": str(duration), "description": "视频时长"},
                {"nodeId": "191", "fieldName": "int", "fieldValue": str(frame), "description": "视频帧率"},
                {"nodeId": "311", "fieldName": "int", "fieldValue": str(width), "description": "视频宽度"},
                {"nodeId": "312", "fieldName": "int", "fieldValue": str(height), "description": "视频高度"},
            ]
        if app_id == REPLACE_MODEL_DEFAULT_APP_ID:
            return [
                {"nodeId": "172", "fieldName": "video", "fieldValue": video_url, "description": "video"},
                {"nodeId": "149", "fieldName": "image", "fieldValue": image_url, "description": "image"},
                {"nodeId": "135", "fieldName": "value", "fieldValue": str(frame), "description": "frame"},
                {"nodeId": "154", "fieldName": "value", "fieldValue": str(duration), "description": "duration"},
                {"nodeId": "145", "fieldName": "value", "fieldValue": str(max(width, height)), "description": "resolution"},
                {"nodeId": "192", "fieldName": "text", "fieldValue": prompt, "description": "prompt"},
            ]
        return [
            {"nodeId": "63", "fieldName": "video", "fieldValue": video_url, "description": "请导入视频"},
            {"nodeId": "193", "fieldName": "image", "fieldValue": image_url, "description": "请导入图片"},
            {"nodeId": "214", "fieldName": "value", "fieldValue": str(duration), "description": "生成时长"},
            {"nodeId": "217", "fieldName": "text", "fieldValue": prompt, "description": "动作提示词"},
            {"nodeId": "274", "fieldName": "int", "fieldValue": str(frame), "description": "帧率"},
            {"nodeId": "215", "fieldName": "value", "fieldValue": str(width), "description": "宽度"},
            {"nodeId": "216", "fieldName": "value", "fieldValue": str(height), "description": "高度"},
        ]

    def _run_replace(self, *, task_type: str, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        workdir = self._workdir(task_id, payload)
        video_url = self._resolve_media(
            task_id=task_id,
            payload=payload,
            context=context,
            media_kind=f"{task_type}_video",
            local_values=(payload.get("video_local_path"), payload.get("source_video_local_path")),
            remote_values=(payload.get("video_url"), payload.get("source_video_url")),
        )
        image_url = self._resolve_media(
            task_id=task_id,
            payload=payload,
            context=context,
            media_kind=f"{task_type}_image",
            local_values=(payload.get("image_local_path"), payload.get("model_image_local_path"), payload.get("product_image_local_path")),
            remote_values=(payload.get("image_url"), payload.get("model_image_url"), payload.get("product_image_url")),
        )
        if task_type == "replace_model":
            app_id = _text(payload.get("video_replace_model_app_id") or payload.get("replace_model_app_id")) or REPLACE_MODEL_DEFAULT_APP_ID
        else:
            app_id = _text(payload.get("video_replace_product_app_id") or payload.get("replace_product_app_id")) or REPLACE_PRODUCT_DEFAULT_APP_ID
        nodes = self._replace_nodes(task_type=task_type, payload=payload, video_url=video_url, image_url=image_url, app_id=app_id)
        output_path = workdir / f"{task_type}.mp4"
        result = self._submit_and_poll(
            task_id=task_id,
            payload=payload,
            context=context,
            submit_url=self._workflow_submit_url(payload, app_id),
            submit_payload={"nodeInfoList": nodes, "instanceType": _text(payload.get("instance_type") or "default"), "usePersonalQueue": False},
            output_path=output_path,
            label="视频模特替换" if task_type == "replace_model" else "视频商品替换",
        )
        ok = _text(result.get("status")).lower() == "success"
        duration = max(_integer(payload.get("duration_seconds") or payload.get("duration") or 0), 0)
        return {
            "ok": ok,
            "message": ("替换完成" if ok else _text(result.get("message") or "替换失败")),
            "runninghub_task_id": _text(result.get("runninghub_task_id")),
            "runninghub_task_ids": [_text(result.get("runninghub_task_id"))] if _text(result.get("runninghub_task_id")) else [],
            "runninghub_usage": _merge_runninghub_usage(result),
            "download_path": str(output_path) if output_path.exists() else "",
            "duration_seconds": duration,
            "raw_result": result,
            **({"mode": _text(payload.get("mode") or "original"), "mode_label": _text(payload.get("mode_label") or payload.get("mode") or "original")} if task_type == "replace_model" else {}),
        }

    def replace_model(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        return replacement_pipeline.run_replacement_pipeline(
            self,
            "replace_model",
            task_id,
            payload,
            context,
        )

    def replace_product(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        return replacement_pipeline.run_replacement_pipeline(
            self,
            "replace_product",
            task_id,
            payload,
            context,
        )

    def replace_product_and_model(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> dict[str, Any]:
        """Retain the archived hidden combined replacement capability.

        It intentionally stays outside ``VIDEO_TASK_TYPES`` and the public
        navigation, but internal callers can execute the original two-subject
        chain through ``ArchivedSourceBackend.run_task``.
        """

        return replacement_pipeline.run_replacement_pipeline(
            self,
            "replace_product_and_model",
            task_id,
            payload,
            context,
        )

    @staticmethod
    def _ecommerce_duration_text(value: float) -> str:
        duration = float(value)
        if duration.is_integer():
            return str(int(duration))
        return f"{duration:.3f}".rstrip("0").rstrip(".")

    @staticmethod
    def _cut_ecommerce_audio_segment(
        source_path: Path,
        output_path: Path,
        start_seconds: float,
        duration_seconds: float,
        *,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        command = [
            _text(payload.get("ffmpeg_path")) or "ffmpeg",
            "-y",
            "-ss",
            f"{max(float(start_seconds), 0.0):.3f}",
            "-i",
            str(source_path),
            "-t",
            f"{max(float(duration_seconds), 0.1):.3f}",
            "-vn",
            "-acodec",
            "libmp3lame",
            "-q:a",
            "4",
            str(output_path),
        ]
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not output_path.is_file():
            raise RuntimeError(f"ffmpeg ecommerce audio segment failed: {_text(stderr)[-1000:]}")
        return output_path.resolve()

    @staticmethod
    def _ecommerce_storyboard_items(storyboard: Any) -> list[Any]:
        items = storyboard
        if isinstance(storyboard, dict):
            items = next(
                (storyboard.get(key) for key in ("items", "segments", "shots") if isinstance(storyboard.get(key), list)),
                None,
            )
        return list(items) if isinstance(items, list) else []

    def _ecommerce_segment_plan(
        self,
        *,
        payload: dict[str, Any],
        content_mode: str,
        common_prompt_parts: list[str],
        aggregated_prompt: str,
        storyboard: Any,
        storyboard_lines: list[str],
        prompt_segment_lines: list[str],
    ) -> tuple[list[dict[str, Any]], float]:
        requested_duration = max(
            _integer(
                payload.get("duration")
                or payload.get("duration_seconds")
                or payload.get("video_default_duration_seconds")
                or 5,
                5,
            ),
            1,
        )
        if content_mode != "planting":
            segments: list[dict[str, Any]] = []
            remaining = requested_duration
            while remaining > 0:
                duration = float(min(remaining, 15))
                segments.append(
                    {
                        "index": len(segments) + 1,
                        "prompt": aggregated_prompt,
                        "duration_seconds": duration,
                        "storyboard": None,
                    }
                )
                remaining -= int(duration)
            return segments, float(requested_duration)

        storyboard_items = self._ecommerce_storyboard_items(storyboard)
        if not storyboard_items:
            raise ValueError("planting mode requires a storyboard with timed segments")
        segments = []
        for offset, (item, line) in enumerate(zip(storyboard_items, storyboard_lines), start=1):
            if not isinstance(item, dict):
                raise ValueError(f"storyboard[{offset}] must provide start/end or duration")
            start = _number(item.get("start_seconds", item.get("start")), float("nan"))
            end = _number(item.get("end_seconds", item.get("end")), float("nan"))
            if math.isfinite(start) and math.isfinite(end) and start >= 0 and end > start:
                duration = end - start
            else:
                duration = _number(item.get("duration_seconds", item.get("duration")), float("nan"))
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError(f"storyboard[{offset}] must provide a positive start/end range or duration")
            if duration > 15:
                raise ValueError(f"storyboard[{offset}] duration may not exceed 15 seconds")
            segment_parts = [*common_prompt_parts, f"Storyboard segment {offset}: {line}"]
            if offset <= len(prompt_segment_lines):
                segment_parts.append(f"Prompt segment {offset}: {prompt_segment_lines[offset - 1]}")
            segments.append(
                {
                    "index": offset,
                    "prompt": "\n\n".join(segment_parts),
                    "duration_seconds": float(duration),
                    "storyboard": item,
                }
            )
        return segments, sum(float(item["duration_seconds"]) for item in segments)

    @staticmethod
    def _ecommerce_completed_segments(payload: dict[str, Any]) -> dict[int, dict[str, Any]]:
        source = payload.get("completed_segments")
        if source is None and isinstance(payload.get("resume_checkpoint"), dict):
            source = payload["resume_checkpoint"].get("completed_segments")
        if source is None:
            return {}
        if not isinstance(source, list):
            raise ValueError("completed_segments must be a list")
        completed: dict[int, dict[str, Any]] = {}
        for item in source:
            if not isinstance(item, dict):
                continue
            index = _integer(item.get("index"), 0)
            path_text = _text(item.get("path"))
            if index < 1 or not path_text:
                continue
            path = Path(path_text).expanduser().resolve()
            if path.exists() and path.is_file():
                completed[index] = {**item, "index": index, "path": str(path)}
        return completed

    def _concat_ecommerce_segments(
        self,
        *,
        segment_paths: list[Path],
        output_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> None:
        if not segment_paths:
            raise RuntimeError("no ecommerce video segments are available for concatenation")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if len(segment_paths) == 1:
            if segment_paths[0].resolve() != output_path.resolve():
                shutil.copyfile(segment_paths[0], output_path)
            return
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("ecommerce video segment concatenation requires ffmpeg")
        concat_path = workdir / "ecommerce_short_video_segments.ffconcat"
        concat_lines = []
        for path in segment_paths:
            escaped = path.resolve().as_posix().replace("'", "'\\''")
            concat_lines.append(f"file '{escaped}'")
        concat_path.write_text("ffconcat version 1.0\n" + "\n".join(concat_lines) + "\n", encoding="utf-8")
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-c",
            "copy",
            str(output_path),
        ]
        context.check_cancelled()
        returncode, _stdout, stderr = _run_local_process(
            command,
            timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not output_path.exists():
            raise RuntimeError(f"ffmpeg ecommerce segment concatenation failed: {_text(stderr)[-1000:]}")

    @staticmethod
    def _checkpoint_ecommerce_segment(
        *,
        task_id: str,
        payload: dict[str, Any],
        segment: dict[str, Any],
    ) -> None:
        callback = payload.get("_checkpoint_video_progress")
        if not callable(callback):
            return
        _invoke_compatible(
            callback,
            task_id=str(task_id),
            completed_segment={
                "index": int(segment["index"]),
                "path": str(segment["path"]),
                "duration_seconds": segment["duration_seconds"],
                "runninghub_task_id": _text(segment.get("runninghub_task_id")),
            },
        )

    def _run_local_ecommerce_seeding(
        self,
        *,
        task_id: str,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> dict[str, Any]:
        workdir = self._workdir(task_id, payload)
        reference_video_value = _text(payload.get("reference_video_local_path") or payload.get("video_local_path"))
        if reference_video_value and not isinstance(payload.get("ecommerce_reference_video_audit"), dict):
            try:
                payload["ecommerce_reference_video_audit"] = ecommerce_reference_video.audit_ecommerce_reference_video(
                    reference_video_value,
                    workdir=workdir / "reference_video_audit",
                    ffmpeg_path=_text(payload.get("ffmpeg_path")),
                    ffprobe_path=_text(payload.get("ffprobe_path")),
                    context=context,
                )
            except VideoTaskCancelled:
                raise
            except Exception as exc:
                payload["ecommerce_reference_video_audit"] = {
                    "video_path": reference_video_value,
                    "error": _text(exc)[:240],
                    "style_tags": [],
                }
        product_values = payload.get("product_image_local_paths")
        if product_values is not None and not isinstance(product_values, list):
            raise ValueError("product_image_local_paths must be a list")
        product_paths = _unique_text_values(
            [payload.get("product_image_local_path") or payload.get("image_local_path"), *(product_values or [])]
        )
        if not product_paths:
            raise ValueError("ecommerce seeding video requires at least one local product image")
        for value in product_paths:
            path = Path(value)
            if not path.exists() or not path.is_file():
                raise FileNotFoundError(f"ecommerce seeding product image does not exist: {path}")
        model_path = _text(payload.get("model_image_local_path"))
        if model_path:
            resolved_model = Path(model_path).expanduser().resolve()
            if not resolved_model.exists() or not resolved_model.is_file():
                raise FileNotFoundError(f"ecommerce seeding model image does not exist: {resolved_model}")
            model_path = str(resolved_model)

        workbench = payload.get("video_workbench") if isinstance(payload.get("video_workbench"), dict) else {}
        storyboard = payload.get("storyboard")
        if storyboard is None:
            storyboard = workbench.get("storyboard")
        prompt_segments = payload.get("prompt_segments")
        if prompt_segments is None:
            prompt_segments = workbench.get("prompt_segments")
        storyboard_lines = _segment_prompt_lines(storyboard, name="storyboard")
        prompt_segment_lines = _segment_prompt_lines(prompt_segments, name="prompt_segments")
        base_prompt = _text(payload.get("prompt") or payload.get("prompt_text") or payload.get("message"))
        common_prompt_parts = [base_prompt or "Natural ecommerce recommendation video with authentic product details."]
        product_name = _text(payload.get("product_name") or payload.get("product_project_name"))
        speech_text = _text(payload.get("speech_text") or payload.get("script") or payload.get("copy_text"))
        if product_name:
            common_prompt_parts.append(f"Product: {product_name}")
        if speech_text:
            common_prompt_parts.append(f"Spoken copy: {speech_text}")
        aggregate_parts = list(common_prompt_parts)
        reference_video_audit = payload.get("ecommerce_reference_video_audit")
        if isinstance(reference_video_audit, dict) and _text(reference_video_audit.get("style_summary")):
            aggregate_parts.append(
                "Reference video rhythm and composition: " + _text(reference_video_audit.get("style_summary"))
            )
        if storyboard_lines:
            aggregate_parts.append("Storyboard:\n" + "\n".join(f"{index}. {line}" for index, line in enumerate(storyboard_lines, start=1)))
        if prompt_segment_lines:
            aggregate_parts.append("Prompt segments:\n" + "\n".join(f"{index}. {line}" for index, line in enumerate(prompt_segment_lines, start=1)))
        aggregated_prompt = "\n\n".join(aggregate_parts)
        segment_plan, duration = self._ecommerce_segment_plan(
            payload=payload,
            content_mode="planting",
            common_prompt_parts=common_prompt_parts,
            aggregated_prompt=aggregated_prompt,
            storyboard=storyboard,
            storyboard_lines=storyboard_lines,
            prompt_segment_lines=prompt_segment_lines,
        )
        regenerate_value = payload.get("regenerate_segment_index")
        if regenerate_value is None:
            regenerate_value = payload.get("ecommerce_seeding_regenerate_scene_index")
        if regenerate_value is not None:
            if isinstance(regenerate_value, bool):
                raise ValueError("regenerate_segment_index must be a valid 1-based segment index")
            regenerate_number = _number(regenerate_value, float("nan"))
            regenerate_index = int(regenerate_number) if math.isfinite(regenerate_number) else 0
            if regenerate_number != regenerate_index or regenerate_index < 1 or regenerate_index > len(segment_plan):
                raise ValueError(f"regenerate_segment_index must be between 1 and {len(segment_plan)}")
            segment_plan = [segment_plan[regenerate_index - 1]]
            duration = float(segment_plan[0]["duration_seconds"])

        completed = {} if regenerate_value is not None else self._ecommerce_completed_segments(payload)
        resume_available = bool(_text(payload.get("resume_runninghub_task_id")))

        def generate_scene(*, segment: dict[str, Any], segment_index: int, output_dir: Path) -> dict[str, Any]:
            nonlocal resume_available
            scene_payload = dict(payload)
            for key in ("image_count", "imageCount", "nano_images", "count"):
                scene_payload.pop(key, None)
            scene_payload["count"] = 1
            scene_payload["output_dir"] = str(output_dir)
            scene_payload["product_image_local_path"] = product_paths[0]
            scene_payload["product_image_local_paths"] = product_paths[:3]
            scene_payload["prompt"] = (
                f"{_text(segment.get('prompt'))}\n"
                f"Use ecommerce seeding layout {ecommerce_seeding_renderer.normalize_template(payload.get('ecommerce_seeding_template'))}. "
                "Create a clean scene plate without baked-in captions or watermarks."
            )
            if model_path:
                scene_payload["video_image_mode"] = "model_product"
                scene_payload["model_image_local_path"] = model_path
            else:
                scene_payload["video_image_mode"] = "product_only"
                scene_payload.pop("model_image_local_path", None)
            if resume_available:
                resume_available = False
            else:
                scene_payload.pop("resume_runninghub_task_id", None)
            return self.image_generate(
                task_id=f"{task_id}_seeding_scene_{segment_index}",
                payload=scene_payload,
                context=context,
            )

        operation = _text(payload.get("ecommerce_seeding_operation") or "final_video").lower()
        tts_configured = bool(_text(payload.get("video_tts_api_key") or payload.get("minimax_api_key")))
        dynamic_enabled_value = payload.get("_ecommerce_seeding_dynamic_enabled")
        if dynamic_enabled_value is None:
            dynamic_enabled_value = payload.get("ecommerce_seeding_dynamic_enabled")
        dynamic_enabled = _boolean(
            dynamic_enabled_value,
            name="ecommerce_seeding_dynamic_enabled",
            default=False,
        )
        dynamic_rendered = False
        if operation != "images_only" and dynamic_enabled and (tts_configured or not speech_text):
            dynamic_rendered = True
            timeout_seconds = max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30)

            def dynamic_generate_image(**values: Any) -> dict[str, Any]:
                segment = dict(values.get("segment") or {})
                segment["prompt"] = _text(values.get("prompt") or segment.get("prompt"))
                output_dir = Path(values.get("output_path") or workdir).expanduser().resolve().parent
                return generate_scene(
                    segment=segment,
                    segment_index=_integer(values.get("segment_index"), 1),
                    output_dir=output_dir,
                )

            def dynamic_synthesize_tts(**values: Any) -> Path:
                return self._generate_minimax_tts(
                    speech_text=_text(values.get("text")),
                    output_path=Path(values.get("output_path")).expanduser().resolve(),
                    payload=dict(values.get("payload") or payload),
                    context=context,
                )

            def dynamic_probe_duration(**values: Any) -> float:
                probe_payload = dict(payload)
                probe_payload.pop("source_video_duration_seconds", None)
                probe_payload.pop("duration_seconds", None)
                return self._probe_duration(Path(values.get("path")).expanduser().resolve(), probe_payload)

            def dynamic_encode_frames(**values: Any) -> Path:
                ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
                if not ffmpeg:
                    raise VideoDependencyError("dynamic ecommerce seeding frame encoding requires ffmpeg")
                output_path = Path(values.get("output_path")).expanduser().resolve()
                output_path.parent.mkdir(parents=True, exist_ok=True)
                command = [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-framerate",
                    str(max(_integer(values.get("fps"), 25), 1)),
                    "-i",
                    str(values.get("frame_pattern")),
                    "-c:v",
                    "libx264",
                    "-preset",
                    _text(payload.get("language_encode_preset") or "medium"),
                    "-crf",
                    str(min(max(_integer(payload.get("language_crf"), 18), 0), 51)),
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(output_path),
                ]
                returncode, _stdout, stderr = _run_local_process(
                    command,
                    timeout_seconds=timeout_seconds,
                    payload=payload,
                    context=context,
                )
                if returncode != 0 or not output_path.exists():
                    raise RuntimeError(f"dynamic ecommerce seeding frame encoding failed: {_text(stderr)[-1000:]}")
                return output_path

            def dynamic_concat_videos(**values: Any) -> Path:
                output_path = Path(values.get("output_path")).expanduser().resolve()
                self._concat_ecommerce_segments(
                    segment_paths=[Path(item).expanduser().resolve() for item in values.get("segment_paths") or []],
                    output_path=output_path,
                    payload=payload,
                    context=context,
                    workdir=workdir,
                )
                return output_path

            def dynamic_mux_audio(**values: Any) -> Path:
                video_path = Path(values.get("video_path")).expanduser().resolve()
                audio_path = Path(values.get("audio_path")).expanduser().resolve()
                output_path = Path(values.get("output_path")).expanduser().resolve()
                source_seconds = dynamic_probe_duration(path=video_path)
                self._replace_video_audio_track(
                    source_video=video_path,
                    audio_path=audio_path,
                    source_seconds=source_seconds,
                    target_seconds=max(_number(values.get("target_duration_seconds"), source_seconds), 0.1),
                    output_path=output_path,
                    payload=payload,
                    context=context,
                )
                return output_path

            rendered = ecommerce_seeding_dynamic.render_ecommerce_seeding_dynamic(
                task_id=task_id,
                payload=payload,
                context=context,
                workdir=workdir,
                segments=segment_plan,
                completed_segments=completed,
                callbacks=ecommerce_seeding_dynamic.EcommerceSeedingCallbacks(
                    generate_image=dynamic_generate_image,
                    inspect_image=ecommerce_seeding_dynamic.inspect_ecommerce_seeding_generated_frame,
                    synthesize_tts=dynamic_synthesize_tts,
                    probe_duration=dynamic_probe_duration,
                    encode_frames=dynamic_encode_frames,
                    concat_videos=dynamic_concat_videos,
                    mux_audio=dynamic_mux_audio,
                    checkpoint_segment=lambda **values: self._checkpoint_ecommerce_segment(
                        task_id=_text(values.get("task_id") or task_id),
                        payload=payload,
                        segment=dict(values.get("segment") or values.get("completed_segment") or {}),
                    ),
                ),
            )
            rendered["scene_results"] = rendered.get("image_generation_qa") or []
            rendered["image_paths"] = rendered.get("generated_scene_image_paths") or []
            rendered["template"] = rendered.get("template") or ecommerce_seeding_renderer.normalize_template(payload.get("ecommerce_seeding_template"))
        else:
            rendered = ecommerce_seeding_renderer.render_ecommerce_seeding(
                task_id=task_id,
                payload=payload,
                context=context,
                workdir=workdir,
                segments=segment_plan,
                completed_segments=completed,
                generate_scene=generate_scene,
                run_local_process=_run_local_process,
                concat_segments=lambda *, segment_paths, output_path: self._concat_ecommerce_segments(
                    segment_paths=segment_paths,
                    output_path=output_path,
                    payload=payload,
                    context=context,
                    workdir=workdir,
                ),
                checkpoint_segment=self._checkpoint_ecommerce_segment,
            )
        scene_results = rendered.get("scene_results") if isinstance(rendered.get("scene_results"), list) else []
        runninghub_task_ids: list[str] = []
        for item in scene_results:
            if not isinstance(item, dict):
                continue
            for provider_id in item.get("runninghub_task_ids") or [item.get("runninghub_task_id")]:
                provider_text = _text(provider_id)
                if provider_text and provider_text not in runninghub_task_ids:
                    runninghub_task_ids.append(provider_text)
        for provider_text in _collect_runninghub_task_ids(scene_results):
            if provider_text not in runninghub_task_ids:
                runninghub_task_ids.append(provider_text)
        runninghub_usage = _merge_runninghub_usage(scene_results)

        if rendered.get("images_only"):
            return {
                "ok": True,
                "message": "Ecommerce seeding storyboard images generated",
                "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
                "runninghub_task_ids": runninghub_task_ids,
                "runninghub_usage": runninghub_usage,
                "download_path": _text(rendered.get("download_path")),
                "image_path": _text(rendered.get("image_path")),
                "image_paths": rendered.get("image_paths") or [],
                "completed_segments": rendered.get("completed_segments") or [],
                "raw_result": {
                    "local_renderer": "ffmpeg_programmatic_seeding_v1",
                    "seeding_stage": "images_only",
                    "ecommerce_seeding_template": rendered["template"],
                    "layout_variant": rendered["layout_variant"],
                    "segments": rendered.get("segments") or [],
                    "generated_scene_image_paths": rendered.get("image_paths") or [],
                    "duration": duration,
                    "ratio": rendered["ratio"],
                    "resolution": rendered["resolution"],
                },
            }

        final_path = Path(str(rendered["video_path"])).resolve()
        audio_path_text = _text(payload.get("audio_local_path") or payload.get("voice_audio_local_path"))
        if not dynamic_rendered and not audio_path_text and speech_text and _text(payload.get("video_tts_api_key") or payload.get("minimax_api_key")):
            audio_path_text = str(
                self._generate_minimax_tts(
                    speech_text=speech_text,
                    output_path=workdir / "ecommerce_seeding_speech.mp3",
                    payload=payload,
                    context=context,
                )
            )
        if not dynamic_rendered and audio_path_text:
            audio_path = Path(audio_path_text).expanduser().resolve()
            if not audio_path.exists() or not audio_path.is_file():
                raise FileNotFoundError(f"ecommerce seeding audio does not exist: {audio_path}")
            narrated_path = workdir / "ecommerce_short_video_local_narrated.mp4"
            self._replace_video_audio_track(
                source_video=final_path,
                audio_path=audio_path,
                source_seconds=duration,
                target_seconds=duration,
                output_path=narrated_path,
                payload=payload,
                context=context,
            )
            final_path = narrated_path.resolve()
        final_path, subtitle_count, subtitle_warning = self._apply_optional_subtitles(
            video_path=final_path,
            payload=payload,
            context=context,
            workdir=workdir,
            speech_text=speech_text,
            segment_texts=[
                _text(item.get("speech_text") or item.get("copy") or item.get("text") or item.get("prompt"))
                for item in (storyboard if isinstance(storyboard, list) else [])
                if isinstance(item, dict)
            ],
            segment_durations=[
                _number(item.get("duration_seconds") or item.get("duration"), 0.0)
                for item in (storyboard if isinstance(storyboard, list) else [])
                if isinstance(item, dict)
            ],
        )
        return {
            "ok": True,
            "message": "Ecommerce seeding video generated",
            "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
            "runninghub_task_ids": runninghub_task_ids,
            "runninghub_usage": runninghub_usage,
            "seedance_model_used": "",
            "download_path": str(final_path),
            "video_path": str(final_path),
            "subtitle_count": subtitle_count,
            "subtitles_applied": subtitle_count > 0,
            "subtitle_warning": subtitle_warning,
            "completed_segments": rendered.get("completed_segments") or [],
            "raw_result": {
                "local_renderer": _text(rendered.get("local_renderer") or "ffmpeg_programmatic_seeding_v1"),
                "seeding_stage": "final_video",
                "ecommerce_seeding_template": rendered["template"],
                "layout_variant": rendered["layout_variant"],
                "duration": duration,
                "ratio": rendered["ratio"],
                "resolution": rendered["resolution"],
                "content_mode": "planting",
                "storyboard": storyboard,
                "prompt_segments": prompt_segments,
                "aggregated_prompt": aggregated_prompt,
                "segments": rendered.get("segments") or [],
                "generated_scene_image_paths": rendered.get("image_paths") or [],
                "scene_results": scene_results,
            },
        }

    def ecommerce_short_video(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        payload = dict(payload or {})
        product_values = [
            _text(item)
            for item in (payload.get("product_image_local_paths") or [])
            if _text(item)
        ]
        primary_product = _text(payload.get("product_image_local_path") or payload.get("image_local_path"))
        if primary_product and primary_product not in product_values:
            product_values.insert(0, primary_product)
        material_analysis = payload.get("ecommerce_material_analysis")
        if product_values and isinstance(material_analysis, dict):
            effective = ecommerce_material_intelligence.select_ecommerce_effective_references(
                product_paths=product_values,
                model_path=_text(payload.get("model_image_local_path")),
                material_analysis=material_analysis,
                max_images=9,
                priority_product_paths=[
                    _text(item)
                    for item in (payload.get("ecommerce_product_three_view_image_local_paths") or [])
                    if _text(item)
                ],
            )
            selected_products = list(effective.get("product_image_local_paths") or [])
            if selected_products:
                payload["product_image_local_paths"] = selected_products
                payload["product_image_local_path"] = selected_products[0]
                payload["ecommerce_effective_reference_order"] = list(effective.get("reference_order") or [])
                payload["ecommerce_effective_selected_indexes"] = list(effective.get("selected_original_indexes") or [])
        if _text(payload.get("ecommerce_video_mode")).lower() == "seeding_video":
            return self._run_local_ecommerce_seeding(task_id=task_id, payload=payload, context=context)
        model_config = ecommerce_ad_prompting.normalize_ecommerce_model_workflow(payload)
        payload = dict(model_config["payload"])
        workdir = self._workdir(task_id, payload)
        animation_redraw_meta: dict[str, Any] = {}
        animation_redraw_provider_results: list[dict[str, Any]] = []
        if (
            _text(payload.get("ecommerce_ad_style")).lower() == "animation"
            and not _boolean(
                payload.get("ecommerce_animation_redraw_done"),
                name="ecommerce_animation_redraw_done",
                default=False,
            )
        ):
            def generate_animation_image(**values: Any) -> tuple[dict[str, Any], dict[str, Any], list[Any]]:
                source = dict(values.get("source") or payload)
                prompt = _text(values.get("prompt"))
                output_image_path = Path(_text(values.get("output_image_path"))).expanduser().resolve()
                input_image_path = Path(_text(values.get("input_image_path"))).expanduser().resolve()
                if runninghub_image_models.resolve_api_key(source):
                    result = runninghub_image_models.generate_image_with_fallback(
                        source,
                        prompt,
                        [input_image_path],
                        output_image_path,
                        context,
                        logger=context.logger,
                        poll_interval_seconds=max(_number(source.get("video_poll_interval_seconds"), 2.0), 0.0),
                        max_poll_attempts=max(_integer(source.get("video_image_max_poll_attempts"), 180), 1),
                    )
                    attempts = list(result.get("image_model_attempts") or [])
                    selected_model = _text(result.get("selected_model"))
                    if not selected_model:
                        selected_model = next(
                            (_text(item.get("model")) for item in reversed(attempts) if isinstance(item, dict) and item.get("ok")),
                            "",
                        )
                else:
                    legacy_generate = getattr(image_model_api, "generate_image", None)
                    if not callable(legacy_generate):
                        raise VideoDependencyError("animation reference redraw image provider is not configured")
                    result = legacy_generate(
                        base_url=_text(source.get("image_model_provider_base_url")),
                        model=_text(
                            source.get("image_generate_model")
                            or source.get("image_model_priority_order")
                            or source.get("image_model_default_model")
                        ),
                        prompt=prompt,
                        output_image_path=str(output_image_path),
                        gemini_api_key=_text(source.get("image_model_provider_api_key_gemini")),
                        gpt_api_key=_text(source.get("image_model_provider_api_key_gpt")),
                        input_image_path=str(input_image_path),
                        input_image_paths=[str(input_image_path)],
                        size=_text(source.get("image_size") or source.get("size") or "1:1"),
                        logger=context.logger,
                    )
                    attempts = list(result.get("attempts") or []) if isinstance(result, dict) else []
                    selected_model = _text(result.get("selected_model")) if isinstance(result, dict) else ""
                animation_redraw_provider_results.append(dict(result or {}))
                return dict(result or {}), {"model": selected_model}, attempts

            redraw_result = ecommerce_animation_redraw.redraw_animation_references(
                payload,
                task_id=str(task_id),
                workdir=workdir / "animation_redraw",
                context=context,
                generate_image=generate_animation_image,
            )
            payload = dict(redraw_result.get("params") or payload)
            animation_redraw_meta = dict(payload.get("ecommerce_animation_redraw_result") or {})
        product_image_paths = payload.get("product_image_local_paths")
        if product_image_paths is not None and not isinstance(product_image_paths, list):
            raise ValueError("product_image_local_paths must be a list")
        product_image_values = _unique_text_values(
            [payload.get("product_image_local_path") or payload.get("image_local_path"), *(product_image_paths or [])]
        )
        model_image_value = _text(payload.get("model_image_local_path"))
        model_reference_skipped = _boolean(
            payload.get("ecommerce_model_reference_skipped") or payload.get("model_reference_skipped"),
            name="ecommerce_model_reference_skipped",
            default=not bool(model_image_value),
        )
        reference_constraints = ecommerce_ad_prompting.build_ecommerce_reference_constraints(
            product_paths=product_image_values,
            model_path=model_image_value,
            model_reference_skipped=model_reference_skipped,
            max_images=9,
        )
        image_values = list(reference_constraints["reference_paths"])
        image_urls: list[str] = []
        remote_values = payload.get("image_urls")
        if remote_values is not None and not isinstance(remote_values, list):
            raise ValueError("image_urls must be a list")
        for index, value in enumerate(image_values[:9], start=1):
            if not _text(value):
                continue
            image_urls.append(
                self._resolve_media(
                    task_id=task_id,
                    payload=payload,
                    context=context,
                    media_kind=f"ecommerce_reference_image_{index}",
                    local_values=(value,),
                    remote_values=(),
                )
            )
        remote_values = [
            payload.get("model_image_url"),
            payload.get("product_image_url"),
            payload.get("image_url"),
            *(remote_values or []),
        ]
        for value in remote_values:
            if not _text(value):
                continue
            if not _is_url(value):
                raise ValueError("ecommerce image URL parameters must contain http(s) URLs")
            if _text(value) not in image_urls:
                image_urls.append(_text(value))
        if not image_urls:
            raise RuntimeError("电商短视频至少需要一张产品图片")
        video_urls: list[str] = []
        reference_video_local = _text(payload.get("reference_video_local_path"))
        reference_video_remote = _text(payload.get("reference_video_url"))
        if reference_video_local or reference_video_remote:
            video_urls.append(self._resolve_media(
                task_id=task_id,
                payload=payload,
                context=context,
                media_kind="ecommerce_reference_video",
                local_values=(reference_video_local,),
                remote_values=(reference_video_remote,),
            ))
        audio_urls: list[str] = []
        listed_audio_values = payload.get("audio_local_paths") or payload.get("voice_audio_local_paths") or []
        if not isinstance(listed_audio_values, list):
            raise ValueError("audio_local_paths must be a list")
        audio_local_values = _unique_text_values([
            payload.get("audio_local_path") or payload.get("voice_audio_local_path"),
            *listed_audio_values,
        ])
        reference_audio_remote = _text(payload.get("audio_url"))
        model = _text(model_config["model"])
        model_slug = _text(model_config["model_slug"])
        ratio = _text(model_config["ratio"])
        resolution = _text(model_config["resolution"])
        workbench = payload.get("video_workbench") if isinstance(payload.get("video_workbench"), dict) else {}
        storyboard = payload.get("storyboard")
        if storyboard is None:
            storyboard = workbench.get("storyboard")
        prompt_segments = payload.get("prompt_segments")
        if prompt_segments is None:
            prompt_segments = workbench.get("prompt_segments")
        storyboard_lines = _segment_prompt_lines(storyboard, name="storyboard")
        prompt_segment_lines = _segment_prompt_lines(prompt_segments, name="prompt_segments")
        base_prompt = _text(payload.get("prompt") or payload.get("prompt_text") or payload.get("message"))
        product_category = ecommerce_ad_prompting.normalize_ecommerce_product_category(
            payload.get("product_category") or payload.get("category"),
            prompt=base_prompt,
        )
        payload["product_category"] = product_category
        common_prompt_parts = [base_prompt or "真实自然的产品广告短视频，无字幕，无水印。"]
        common_prompt_parts[0] = ecommerce_ad_prompting.clean_ecommerce_video_prompt_text(
            common_prompt_parts[0],
            product_category=product_category,
        )
        creative_brief = ecommerce_ad_prompting.normalize_ecommerce_creative_brief(
            payload.get("ecommerce_creative_brief") or payload.get("creative_brief"),
            category=product_category,
            prompt=common_prompt_parts[0],
            image_count=len(image_values),
            has_model=bool(reference_constraints.get("model_ref")),
        )
        payload["ecommerce_creative_brief"] = creative_brief
        reference_note = _text(reference_constraints.get("reference_note"))
        creative_guidance = ecommerce_ad_prompting.format_ecommerce_creative_brief_execution_guidance(creative_brief)
        common_prompt_parts = [
            item
            for item in (reference_note, creative_guidance, *common_prompt_parts)
            if _text(item)
        ]
        product_name = _text(payload.get("product_name"))
        style_hint = _text(payload.get("style_hint"))
        nano_prompt = _text(payload.get("nano_prompt"))
        speech_text = _text(payload.get("speech_text") or payload.get("script") or payload.get("copy_text"))
        if product_name:
            common_prompt_parts.append(f"Product: {product_name}")
        if style_hint:
            common_prompt_parts.append(f"Visual style: {style_hint}")
        if nano_prompt:
            common_prompt_parts.append(f"Scene direction: {nano_prompt}")
        if speech_text:
            common_prompt_parts.append(f"Spoken copy: {speech_text}")
        aggregate_parts = list(common_prompt_parts)
        if storyboard_lines:
            aggregate_parts.append("Storyboard:\n" + "\n".join(f"{index}. {line}" for index, line in enumerate(storyboard_lines, start=1)))
        if prompt_segment_lines:
            aggregate_parts.append("Prompt segments:\n" + "\n".join(f"{index}. {line}" for index, line in enumerate(prompt_segment_lines, start=1)))
        prompt = "\n\n".join(aggregate_parts)
        content_mode = _text(payload.get("content_mode") or workbench.get("content_mode") or "advertising").lower()
        if content_mode not in {"advertising", "planting"}:
            raise ValueError("content_mode must be advertising or planting")
        segment_plan, duration = self._ecommerce_segment_plan(
            payload=payload,
            content_mode=content_mode,
            common_prompt_parts=common_prompt_parts,
            aggregated_prompt=prompt,
            storyboard=storyboard,
            storyboard_lines=storyboard_lines,
            prompt_segment_lines=prompt_segment_lines,
        )
        submission_constraints = ecommerce_ad_prompting.build_ecommerce_submission_constraints(
            payload,
            reference_constraints=reference_constraints,
            has_audio=bool(audio_local_values or reference_audio_remote),
        )
        for segment in segment_plan:
            cleaned_segment_prompt = ecommerce_ad_prompting.clean_ecommerce_video_prompt_text(
                segment.get("prompt"),
                product_category=product_category,
            )
            segment["prompt"] = ecommerce_ad_prompting.clean_ecommerce_video_prompt_text(
                ecommerce_ad_prompting.compose_ecommerce_segment_prompt(
                    prompt=cleaned_segment_prompt,
                    constraints=submission_constraints.get("segment_constraints") or [],
                    sound_constraint=submission_constraints.get("sound_constraint") or "",
                    product_category=product_category,
                    preserve_dialogue=True,
                ),
                product_category=product_category,
            )
        segment_audio_paths = ecommerce_segment_audio.prepare_ecommerce_segment_audio_paths(
            audio_inputs=[Path(item) for item in audio_local_values],
            segment_durations=[float(item["duration_seconds"]) for item in segment_plan],
            workdir=workdir / "segment_audio",
            segment_dialogues=[str(item.get("prompt") or "") for item in segment_plan],
            probe_duration=lambda path: self._probe_media_duration_seconds(path, payload),
            cut_segment=lambda source, target, start, length: self._cut_ecommerce_audio_segment(
                source,
                target,
                start,
                length,
                payload=payload,
                context=context,
            ),
            check_cancelled=context.check_cancelled,
        )
        segment_audio_by_index = {
            int(segment["index"]): segment_audio_paths[offset]
            for offset, segment in enumerate(segment_plan)
            if offset < len(segment_audio_paths)
        }
        regenerate_value = payload.get("regenerate_segment_index")
        if regenerate_value is not None:
            if isinstance(regenerate_value, bool):
                raise ValueError("regenerate_segment_index must be a valid 1-based segment index")
            regenerate_number = _number(regenerate_value, float("nan"))
            regenerate_index = int(regenerate_number) if math.isfinite(regenerate_number) else 0
            if regenerate_number != regenerate_index or regenerate_index < 1 or regenerate_index > len(segment_plan):
                raise ValueError(f"regenerate_segment_index must be between 1 and {len(segment_plan)}")
            segment_plan = [segment_plan[regenerate_index - 1]]
            duration = sum(float(item["duration_seconds"]) for item in segment_plan)

        completed = self._ecommerce_completed_segments(payload)
        if regenerate_value is not None:
            completed = {}
        segment_results: list[dict[str, Any]] = []
        provider_results: list[dict[str, Any]] = []
        completed_output: list[dict[str, Any]] = []
        resume_runninghub_task_id = _text(payload.get("resume_runninghub_task_id")) if regenerate_value is None else ""
        resume_consumed = False
        ok = True
        failure_message = ""
        submit_url = f"{self._base_url(payload)}/openapi/v2/rhart-video/{model_slug}/multimodal-video"
        previous_storyboard_url = ""
        storyboard_local_paths: list[str] = []
        storyboard_urls: list[str] = []

        def build_continuity_sheet(segment: dict[str, Any], video_path: Path) -> None:
            nonlocal previous_storyboard_url
            summary = ecommerce_segment_continuity._ecommerce_storyboard_recap_from_prompt(
                segment_prompt=str(segment.get("prompt") or ""),
                segment_index=int(segment["index"]),
                segment_duration=max(_integer(segment.get("duration_seconds"), 1), 1),
            )

            def run_storyboard_process(command: list[str], **_kwargs: Any) -> SimpleNamespace:
                returncode, stdout, stderr = _run_local_process(
                    command,
                    timeout_seconds=max(_integer(payload.get("video_task_timeout_seconds"), 3600), 30),
                    payload=payload,
                    context=context,
                )
                return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

            storyboard_path = ecommerce_segment_continuity._build_ecommerce_storyboard_sheet(
                video_path=video_path,
                output_path=workdir / f"ecommerce_storyboard_segment_{int(segment['index'])}.jpg",
                segment_index=int(segment["index"]),
                segment_duration=max(_integer(segment.get("duration_seconds"), 1), 1),
                summary=summary,
                ratio=ratio,
                include_annotations=True,
                context=context,
                ffmpeg_path=_text(payload.get("ffmpeg_path")),
                run_process=run_storyboard_process,
                probe_duration=lambda path: self._probe_media_duration_seconds(path, payload),
            )
            storyboard_local_paths.append(str(storyboard_path))
            previous_storyboard_url = self._resolve_media(
                task_id=task_id,
                payload=payload,
                context=context,
                media_kind=f"ecommerce_storyboard_segment_{int(segment['index'])}",
                local_values=(str(storyboard_path),),
                remote_values=(),
            )
            storyboard_urls.append(previous_storyboard_url)

        for segment_position, segment in enumerate(segment_plan):
            context.check_cancelled()
            segment_index = int(segment["index"])
            existing = completed.get(segment_index)
            if existing is not None:
                existing_duration = _number(existing.get("duration_seconds"), float(segment["duration_seconds"]))
                record = {
                    **segment,
                    "path": str(existing["path"]),
                    "duration_seconds": existing_duration if existing_duration > 0 else float(segment["duration_seconds"]),
                    "runninghub_task_id": _text(existing.get("runninghub_task_id") or existing.get("provider_task_id")),
                    "provider_task_id": _text(existing.get("provider_task_id") or existing.get("runninghub_task_id")),
                    "status": "success",
                    "skipped": True,
                }
                segment_results.append(record)
                completed_output.append(
                    {
                        "index": segment_index,
                        "path": record["path"],
                        "duration_seconds": record["duration_seconds"],
                        "runninghub_task_id": record["runninghub_task_id"],
                    }
                )
                if segment_position < len(segment_plan) - 1:
                    build_continuity_sheet(segment, Path(record["path"]))
                continue

            segment_output_path = workdir / f"ecommerce_short_video_segment_{segment_index:03d}.mp4"
            segment_audio_urls: list[str] = []
            segment_audio_path = segment_audio_by_index.get(segment_index)
            if segment_audio_path is not None or reference_audio_remote:
                resolved_audio = self._resolve_media(
                    task_id=task_id,
                    payload=payload,
                    context=context,
                    media_kind=(
                        "ecommerce_voice_audio"
                        if len(segment_plan) == 1
                        else f"ecommerce_voice_audio_segment_{segment_index}"
                    ),
                    local_values=(str(segment_audio_path) if segment_audio_path is not None else "",),
                    remote_values=(reference_audio_remote,),
                )
                segment_audio_urls.append(resolved_audio)
                if resolved_audio not in audio_urls:
                    audio_urls.append(resolved_audio)
            segment_image_urls = list(image_urls[:9])
            segment_prompt = str(segment["prompt"])
            if previous_storyboard_url:
                segment_image_urls = segment_image_urls[:8]
                segment_image_urls.append(previous_storyboard_url)
                storyboard_image_index = len(segment_image_urls)
                segment_prompt = (
                    f"@Image {storyboard_image_index}为上一段视频的前情六宫格提要，延续其人物身份、商品外观、"
                    f"空间方向、光线和镜头运动。\n{segment_prompt}"
                )
            submit_payload = {
                "prompt": segment_prompt,
                "resolution": resolution,
                "duration": self._ecommerce_duration_text(float(segment["duration_seconds"])),
                "imageUrls": segment_image_urls,
                "videoUrls": video_urls,
                "audioUrls": segment_audio_urls,
                "generateAudio": True,
                "ratio": ratio,
                "realPersonMode": bool(model_config["real_person_mode"]),
                "conversionSlots": ["all"],
                "returnLastFrame": False,
                "seed": _integer(payload.get("seed"), -1),
            }
            segment_payload = dict(payload)
            segment_payload["_segment_index"] = segment_index
            if resume_runninghub_task_id and not resume_consumed:
                segment_payload["resume_runninghub_task_id"] = resume_runninghub_task_id
                resume_consumed = True
            else:
                segment_payload.pop("resume_runninghub_task_id", None)
            result = self._submit_and_poll(
                task_id=task_id,
                payload=segment_payload,
                context=context,
                submit_url=submit_url,
                submit_payload=submit_payload,
                output_path=segment_output_path,
                label=f"电商短视频分段 {segment_index}/{len(segment_plan)}",
            )
            provider_results.append(result)
            segment_ok = _text(result.get("status")).lower() == "success"
            provider_id = _text(result.get("runninghub_task_id") or result.get("provider_task_id"))
            record = {
                **segment,
                "prompt": segment_prompt,
                "path": str(segment_output_path) if segment_output_path.exists() else "",
                "runninghub_task_id": provider_id,
                "provider_task_id": _text(result.get("provider_task_id") or provider_id),
                "status": "success" if segment_ok else "failed",
                "skipped": False,
                "query": result,
                "submit_payload": submit_payload,
            }
            segment_results.append(record)
            if not segment_ok:
                ok = False
                failure_message = _text(result.get("message") or f"电商短视频分段 {segment_index} 生成失败")
                break
            if not segment_output_path.exists() or not segment_output_path.is_file():
                raise RuntimeError(f"ecommerce video segment {segment_index} completed without a local output file")
            checkpoint_segment = {
                "index": segment_index,
                "path": str(segment_output_path.resolve()),
                "duration_seconds": float(segment["duration_seconds"]),
                "runninghub_task_id": provider_id,
            }
            completed_output.append(checkpoint_segment)
            self._checkpoint_ecommerce_segment(task_id=task_id, payload=payload, segment=checkpoint_segment)
            if segment_position < len(segment_plan) - 1:
                build_continuity_sheet(segment, segment_output_path)

        output_path = workdir / "ecommerce_short_video.mp4"
        final_path = output_path
        subtitle_count = 0
        subtitle_warning = ""
        tail_audio_noise_trims: list[dict[str, Any]] = []
        if ok:
            cleaned_segment_paths, tail_audio_noise_trims = self._clean_video_segments_tail_audio_noise(
                [Path(item["path"]) for item in segment_results],
                output_dir=workdir / "tail_audio_noise_trimmed_segments",
                payload=payload,
                context=context,
            )
            self._concat_ecommerce_segments(
                segment_paths=cleaned_segment_paths,
                output_path=output_path,
                payload=payload,
                context=context,
                workdir=workdir,
            )
            final_path, subtitle_count, subtitle_warning = self._apply_optional_subtitles(
                video_path=output_path,
                payload=payload,
                context=context,
                workdir=workdir,
                speech_text=speech_text,
                segment_texts=[_text(item.get("text") or item.get("prompt")) for item in segment_plan],
                segment_durations=[_number(item.get("duration_seconds"), 0.0) for item in segment_plan],
            )
        task_ids = _unique_provider_ids([
            [
                result.get("runninghub_task_ids") or result.get("runninghub_task_id")
                for result in animation_redraw_provider_results
            ],
            [
            _text(item.get("runninghub_task_id"))
            for item in segment_results
            if _text(item.get("runninghub_task_id"))
            ],
        ])
        task_id_value = task_ids[-1] if task_ids else ""
        submit_payloads = [item["submit_payload"] for item in segment_results if isinstance(item.get("submit_payload"), dict)]
        declared_segment_count = len(storyboard_lines) + len(prompt_segment_lines)
        return {
            "ok": ok,
            "message": "广告短视频生成完成" if ok else (failure_message or "广告短视频生成失败"),
            "runninghub_task_id": task_id_value,
            "runninghub_task_ids": task_ids,
            "runninghub_usage": _merge_runninghub_usage(animation_redraw_provider_results, provider_results),
            "seedance_model_used": model,
            "download_path": str(final_path) if ok and final_path.exists() else "",
            "video_path": str(final_path) if ok and final_path.exists() else "",
            "subtitle_count": subtitle_count,
            "subtitles_applied": subtitle_count > 0,
            "subtitle_warning": subtitle_warning,
            "completed_segments": completed_output,
            "raw_result": {
                "workflow_id": _text(model_config.get("workflow_id")),
                "seedance_model_used": model,
                "seedance_submit_slug": model_slug,
                "segment_durations": [
                    _number(item.get("duration_seconds"), 0.0)
                    for item in segment_plan
                ],
                "duration": duration,
                "ratio": ratio,
                "resolution": resolution,
                "content_mode": content_mode,
                "image_urls": image_urls,
                "reference_image_paths": image_values,
                "reference_image_count": len(image_values),
                "model_reference_skipped": model_reference_skipped,
                "product_category": product_category,
                "ecommerce_creative_brief": creative_brief,
                "animation_redraw": animation_redraw_meta,
                "storyboard": storyboard,
                "prompt_segments": prompt_segments,
                "prompt": prompt,
                "aggregated_prompt": prompt,
                "segment_prompts": [str(item.get("prompt") or "") for item in segment_results],
                "copy_text": speech_text,
                "product_image_local_paths": product_image_values,
                "audio_path": audio_local_values[0] if audio_local_values else "",
                "audio_paths": audio_local_values,
                "audio_url_count": len(audio_urls),
                "audio_urls": audio_urls,
                "tail_audio_noise_trims": tail_audio_noise_trims,
                "storyboard_local_paths": storyboard_local_paths,
                "storyboard_urls": storyboard_urls,
                "segment_count": declared_segment_count or len(segment_plan),
                "segments": segment_results,
                "submits": submit_payloads,
                "submit_payload": submit_payloads[0] if submit_payloads else {},
                "submit_payloads": submit_payloads,
                "query": provider_results[-1] if provider_results else {},
                "queries": provider_results,
                "submit_url": submit_url,
                "subtitled": subtitle_count > 0,
                "warnings": [subtitle_warning] if subtitle_warning else [],
            },
        }

    def _generate_minimax_tts(
        self,
        *,
        speech_text: str,
        output_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
    ) -> Path:
        text = _text(speech_text)
        if not text:
            raise RuntimeError("缺少 TTS 文本")
        api_key = _text(payload.get("video_tts_api_key") or payload.get("minimax_api_key"))
        if not api_key:
            raise VideoDependencyError("缺少 video_tts_api_key，且未上传音频")
        base_url = _text(payload.get("video_tts_base_url") or payload.get("minimax_base_url") or "https://api.minimaxi.com").rstrip("/")
        model = _text(payload.get("video_tts_model") or payload.get("minimax_tts_model") or "speech-2.8-hd")
        voice_id = _text(
            payload.get("voice_id")
            or payload.get("video_default_voice_id")
            or payload.get("minimax_tts_voice_id")
            or "male-qn-qingse"
        )
        body = {
            "model": model,
            "text": text,
            "stream": False,
            "voice_setting": {
                "voice_id": voice_id,
                "speed": _number(payload.get("audio_speed"), 1.0),
                "vol": _number(payload.get("audio_volume"), 1.0),
                "pitch": _integer(payload.get("audio_pitch"), 0),
                "emotion": _text(payload.get("emotion") or "neutral"),
            },
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
            "language_boost": _text(payload.get("target_language") or payload.get("language") or "auto"),
        }
        context.check_cancelled()
        response = self.http.post(
            f"{base_url}/v1/t2a_v2",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
            timeout=180,
        )
        response.raise_for_status()
        data = response.json()
        base_resp = data.get("base_resp") if isinstance(data, dict) else None
        if isinstance(base_resp, dict) and int(base_resp.get("status_code") or 0) != 0:
            raise RuntimeError(f"MiniMax TTS 返回错误: {json.dumps(base_resp, ensure_ascii=False)[:600]}")
        audio_hex = _text((data.get("data") or {}).get("audio") if isinstance(data, dict) and isinstance(data.get("data"), dict) else "")
        if not audio_hex:
            raise RuntimeError("MiniMax TTS 未返回 audio")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(bytes.fromhex(audio_hex))
        return output_path

    def video_language_replace(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        payload = dict(payload or {})
        source_video = Path(_text(payload.get("video_local_path") or payload.get("source_video_local_path"))).expanduser().resolve()
        if not source_video.exists() or not source_video.is_file():
            raise FileNotFoundError(f"原视频不存在: {source_video}")
        workdir = self._workdir(task_id, payload)
        source_duration = self._probe_duration(source_video, payload)
        timed_audio_segments: list[dict[str, Any]] = []
        aligned_total_seconds = source_duration
        target_script = _text(payload.get("target_script") or payload.get("translated_script") or payload.get("script") or payload.get("speech_text"))
        script_segments = payload.get("script_segments") or payload.get("subtitle_segments")
        source_script = _text(payload.get("source_script"))
        opening_insert_text = _text(payload.get("opening_insert_text"))
        ending_insert_text = _text(payload.get("ending_insert_text"))
        source_language = _text(payload.get("source_language"))
        source_segments: Any = (
            payload.get("source_segments")
            or payload.get("video_language_source_segments")
            or []
        )
        transcribe_translate_meta: dict[str, Any] = {}
        transcribe_translate_mode = "provided"
        voice_preparation: dict[str, Any] = {}
        provided_target_audio = _text(payload.get("target_audio_local_path"))
        if provided_target_audio:
            target_audio = Path(provided_target_audio).expanduser().resolve()
            if not target_audio.exists() or not target_audio.is_file():
                raise FileNotFoundError(f"目标音频不存在: {target_audio}")
        else:
            if not target_script and not (isinstance(script_segments, list) and script_segments):
                callback = payload.get("_video_language_transcribe_translate")
                if callable(callback):
                    context.check_cancelled()
                    callback_result = _invoke_compatible(
                        callback,
                        task_id=str(task_id),
                        source_video_path=str(source_video),
                        video_path=str(source_video),
                        source_duration=source_duration,
                        source_language=_text(payload.get("source_language") or "Auto"),
                        target_language=_text(payload.get("target_language") or payload.get("language")),
                        payload=payload,
                        context=context,
                        workdir=str(workdir),
                    )
                    context.check_cancelled()
                    if not isinstance(callback_result, dict):
                        raise RuntimeError("video language transcribe/translate callback must return an object")
                    target_script = _text(callback_result.get("target_script") or callback_result.get("translated_script"))
                    script_segments = callback_result.get("segments") or callback_result.get("source_segments")
                    source_segments = callback_result.get("source_segments") or []
                    source_script = _text(callback_result.get("source_script"))
                    source_language = _text(callback_result.get("source_language"))
                    transcribe_translate_meta = callback_result.get("meta") if isinstance(callback_result.get("meta"), dict) else {}
                    if not transcribe_translate_meta and isinstance(callback_result.get("transcription"), dict):
                        transcribe_translate_meta = {"transcription": callback_result.get("transcription")}
                    transcribe_translate_mode = "callback"
                    if target_script:
                        payload["target_script"] = target_script
                    if isinstance(script_segments, list) and script_segments:
                        payload["script_segments"] = script_segments
            if isinstance(script_segments, list) and script_segments:
                voice_preparation = language_voice_pipeline.prepare_language_voice_settings(
                    payload,
                    context,
                    workdir,
                )
                voice_settings = voice_preparation["settings"]
                payload["video_default_voice_id"] = voice_settings.minimax_voice_id
                payload["minimax_tts_voice_id"] = voice_settings.minimax_voice_id
                target_audio, timed_audio_segments, aligned_total_seconds = self._generate_timed_tts_audio(
                    segments=script_segments,
                    source_duration=source_duration,
                    payload=payload,
                    context=context,
                    workdir=workdir,
                    opening_insert_text=opening_insert_text,
                    ending_insert_text=ending_insert_text,
                )
            else:
                final_tts_script = "\n".join(
                    item for item in (opening_insert_text, target_script, ending_insert_text) if _text(item)
                )
                voice_preparation = language_voice_pipeline.prepare_language_voice(
                    {**payload, "target_script": final_tts_script},
                    context,
                    workdir,
                )
                target_audio = Path(voice_preparation["target_audio_path"])
        preserve_background = _boolean(
            payload.get("preserve_background_audio"),
            name="preserve_background_audio",
            default=True,
        )
        mux_audio = target_audio
        background_bed_path = ""
        background_audio_error = ""
        background_audio_mode = "tts_only"
        background_audio_provider_mode = ""
        background_audio_provider_error = ""
        background_audio_provider_task_id = ""
        background_audio_provider_result: dict[str, Any] = {}
        runninghub_usage: dict[str, Any] = {}
        if preserve_background:
            separator = payload.get("_video_language_background_separator")
            configured_runninghub_key = _text(
                payload.get("video_runninghub_api_key")
                or payload.get("runninghub_api_key")
                or payload.get("runninghub_personal_api_key")
                or payload.get("runninghub_enterprise_api_key")
            )
            provider_attempted = False
            provider_succeeded = False
            if callable(separator):
                provider_attempted = True
                background_audio_provider_mode = "injected_separator"
                try:
                    context.check_cancelled()
                    separator_result = _invoke_compatible(
                        separator,
                        task_id=str(task_id),
                        source_video_path=str(source_video),
                        video_path=str(source_video),
                        speech_audio_path=str(target_audio),
                        target_seconds=aligned_total_seconds,
                        payload=payload,
                        context=context,
                        workdir=str(workdir),
                    )
                    context.check_cancelled()
                    if not isinstance(separator_result, dict):
                        raise RuntimeError("video language background separator callback must return an object")
                    background_audio_provider_result = separator_result
                    background_audio_provider_task_id = _text(
                        separator_result.get("runninghub_task_id") or separator_result.get("provider_task_id") or separator_result.get("task_id")
                    )
                    runninghub_usage = (
                        separator_result.get("runninghub_usage")
                        if isinstance(separator_result.get("runninghub_usage"), dict)
                        else separator_result.get("usage") if isinstance(separator_result.get("usage"), dict) else {}
                    )
                    candidate = Path(_text(separator_result.get("background_path"))).expanduser().resolve()
                    if not candidate.exists() or not candidate.is_file():
                        raise FileNotFoundError(f"background separator output does not exist: {candidate}")
                    background_bed_path = str(candidate)
                    mux_audio = self._mix_background_audio(
                        background_path=candidate,
                        speech_audio=target_audio,
                        target_seconds=aligned_total_seconds,
                        payload=payload,
                        context=context,
                        workdir=workdir,
                    )
                    background_audio_mode = "injected_separator"
                    provider_succeeded = True
                except VideoTaskCancelled:
                    raise
                except Exception as exc:
                    background_audio_provider_error = str(exc).strip()
            elif configured_runninghub_key:
                provider_attempted = True
                background_audio_provider_mode = "runninghub_separator"
                provider_state: dict[str, Any] = {}
                try:
                    separator_result = self._separate_background_audio_runninghub(
                        task_id=task_id,
                        source_video=source_video,
                        payload=payload,
                        context=context,
                        workdir=workdir,
                        provider_state=provider_state,
                    )
                    background_audio_provider_result = separator_result
                    background_audio_provider_task_id = _text(separator_result.get("runninghub_task_id"))
                    runninghub_usage = separator_result.get("usage") if isinstance(separator_result.get("usage"), dict) else {}
                    candidate = Path(_text(separator_result.get("background_path"))).expanduser().resolve()
                    if not candidate.exists() or not candidate.is_file():
                        raise FileNotFoundError(f"RunningHub background separator output does not exist: {candidate}")
                    background_bed_path = str(candidate)
                    mux_audio = self._mix_background_audio(
                        background_path=candidate,
                        speech_audio=target_audio,
                        target_seconds=aligned_total_seconds,
                        payload=payload,
                        context=context,
                        workdir=workdir,
                    )
                    background_audio_mode = "runninghub_separator"
                    provider_succeeded = True
                except VideoTaskCancelled:
                    raise
                except Exception as exc:
                    background_audio_provider_task_id = background_audio_provider_task_id or _text(provider_state.get("task_id"))
                    runninghub_usage = runninghub_usage or (provider_state.get("usage") if isinstance(provider_state.get("usage"), dict) else {})
                    background_audio_provider_error = str(exc).strip()
            if background_audio_provider_task_id and background_audio_provider_mode == "injected_separator":
                register = payload.get("_register_runninghub_task")
                if callable(register):
                    _invoke_compatible(register, task_id=str(task_id), runninghub_task_id=background_audio_provider_task_id)
            if not provider_succeeded:
                try:
                    mux_audio, background_bed_path = self._preserve_background_audio(
                        source_video=source_video,
                        speech_audio=target_audio,
                        target_seconds=aligned_total_seconds,
                        payload=payload,
                        context=context,
                        workdir=workdir,
                    )
                    background_audio_mode = "ffmpeg_side_bed_fallback" if provider_attempted else "ffmpeg_side_bed"
                except VideoTaskCancelled:
                    raise
                except Exception as exc:
                    local_error = str(exc).strip()
                    background_audio_error = "; ".join(value for value in (background_audio_provider_error, local_error) if value)
                    mux_audio = target_audio
                    background_audio_mode = "tts_only_fallback"
            if background_audio_provider_error and not background_audio_error:
                background_audio_error = background_audio_provider_error
        if mux_audio == target_audio and aligned_total_seconds > 0 and not timed_audio_segments:
            mux_audio = self._fit_audio_to_duration(
                audio_path=target_audio,
                target_seconds=aligned_total_seconds,
                payload=payload,
                context=context,
                workdir=workdir,
            )
        output_path = workdir / "video_language_replaced.mp4"
        context.check_cancelled()
        self._replace_video_audio_track(
            source_video=source_video,
            audio_path=mux_audio,
            source_seconds=source_duration,
            target_seconds=aligned_total_seconds,
            output_path=output_path,
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        final_path, subtitle_count, subtitle_warning = self._apply_optional_subtitles(
            video_path=output_path,
            payload=payload,
            context=context,
            workdir=workdir,
            speech_text="\n".join(_text(item.get("text")) for item in timed_audio_segments if _text(item.get("text"))) or target_script,
            segment_texts=[_text(item.get("text")) for item in timed_audio_segments],
            segment_durations=[
                max(_number(item.get("end_seconds"), 0.0) - _number(item.get("start_seconds"), 0.0), 0.0)
                for item in timed_audio_segments
            ],
        )
        return {
            "ok": True,
            "message": "视频语种更换完成",
            "runninghub_task_id": background_audio_provider_task_id,
            "runninghub_task_ids": [background_audio_provider_task_id] if background_audio_provider_task_id else [],
            "runninghub_usage": runninghub_usage,
            "download_path": str(final_path),
            "video_path": str(final_path),
            "subtitle_count": subtitle_count,
            "subtitles_applied": subtitle_count > 0,
            "subtitle_warning": subtitle_warning,
            "raw_result": {
                "mode": "replace_audio_track",
                "source_duration_seconds": source_duration,
                "aligned_total_duration_seconds": aligned_total_seconds,
                "timed_audio_segments": timed_audio_segments,
                "target_language": _text(payload.get("target_language") or payload.get("language")),
                "target_script": target_script,
                "opening_insert_text": opening_insert_text,
                "ending_insert_text": ending_insert_text,
                "source_script": source_script,
                "source_language": source_language,
                "source_segments": source_segments,
                "transcribe_translate_mode": transcribe_translate_mode,
                "transcribe_translate_meta": transcribe_translate_meta,
                "target_audio_path": str(target_audio),
                "voice_preparation": {
                    key: value
                    for key, value in voice_preparation.items()
                    if key != "settings"
                },
                "mux_audio_path": str(mux_audio),
                "background_bed_path": background_bed_path,
                "background_audio_preserved": background_audio_mode not in {"tts_only", "tts_only_fallback"},
                "background_audio_mode": background_audio_mode,
                "background_audio_error": background_audio_error,
                "background_audio_provider_mode": background_audio_provider_mode,
                "background_audio_provider_task_id": background_audio_provider_task_id,
                "background_audio_provider_error": background_audio_provider_error,
                "background_audio_provider_result": background_audio_provider_result,
            },
        }

    @staticmethod
    def _probe_duration(path: Path, payload: dict[str, Any]) -> float:
        explicit = _number(payload.get("source_video_duration_seconds") or payload.get("duration_seconds"), 0.0)
        if explicit > 0:
            return explicit
        ffprobe = _text(payload.get("ffprobe_path")) or shutil.which("ffprobe") or ""
        if not ffprobe:
            return 0.0
        completed = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return max(_number(completed.stdout, 0.0), 0.0) if completed.returncode == 0 else 0.0

    @staticmethod
    def _image_generate_mode(payload: dict[str, Any]) -> str:
        explicit = _text(payload.get("video_image_mode"))
        legacy = _text(payload.get("mode"))
        if explicit and legacy in _IMAGE_GENERATE_MODES and explicit != legacy:
            raise ValueError("video_image_mode conflicts with mode")
        mode = (explicit or legacy or "product_only").lower()
        if mode not in _IMAGE_GENERATE_MODES:
            supported = ", ".join(sorted(_IMAGE_GENERATE_MODES))
            raise ValueError(f"unsupported video_image_mode: {mode}; supported values: {supported}")
        return mode

    @staticmethod
    def _image_generate_count(payload: dict[str, Any]) -> int:
        specified: dict[str, int] = {}
        for key in ("image_count", "imageCount", "nano_images", "count"):
            if key in payload and payload.get(key) is not None:
                specified[key] = _strict_positive_integer(payload.get(key), name=key, default=1, maximum=20)
        if len(set(specified.values())) > 1:
            raise ValueError("conflicting image count parameters")
        return next(iter(specified.values()), 1)

    @staticmethod
    def _image_generate_inputs(payload: dict[str, Any], mode: str) -> list[str]:
        listed = payload.get("product_image_local_paths")
        if listed is not None and not isinstance(listed, list):
            raise ValueError("product_image_local_paths must be a list")
        listed = listed or []
        remote_keys = (
            "image_url",
            "image_urls",
            "product_image_url",
            "model_image_url",
            "source_image_url",
            "subject_image_url",
            "poster_image_url",
            "reference_image_url",
        )
        if any(payload.get(key) for key in remote_keys):
            raise ValueError("image_generate currently accepts local input images only; URL input is not supported")
        common_primary = payload.get("primary_image_local_path")
        common_secondary = payload.get("secondary_image_local_path")
        if mode == "product_only":
            candidates = [payload.get("product_image_local_path"), payload.get("image_local_path"), common_primary, *listed]
            minimum, maximum = 1, 3
        elif mode == "model_product":
            candidates = [
                payload.get("product_image_local_path"),
                common_primary,
                payload.get("model_image_local_path"),
                common_secondary,
                *listed,
            ]
            minimum, maximum = 2, 4
        elif mode == "subject_replace":
            candidates = [
                payload.get("source_image_local_path"),
                common_primary,
                payload.get("image_local_path"),
                payload.get("subject_image_local_path"),
                payload.get("replacement_product_image_local_path"),
                payload.get("replacement_model_image_local_path"),
                common_secondary,
                *listed,
            ]
            minimum, maximum = 2, 3
        elif mode == "poster_translate":
            candidates = [
                payload.get("poster_image_local_path"),
                common_primary,
                payload.get("product_image_local_path"),
                payload.get("image_local_path"),
                *listed,
            ]
            minimum, maximum = 1, 1
        elif mode == "digital_human_character":
            candidates = [
                payload.get("reference_image_local_path"),
                common_primary,
                payload.get("image_local_path"),
                payload.get("product_image_local_path"),
                *listed,
            ]
            minimum, maximum = 0, 3
        else:
            candidates = [
                payload.get("reference_image_local_path"),
                common_primary,
                payload.get("image_local_path"),
                payload.get("product_image_local_path"),
                *listed,
            ]
            minimum, maximum = 1, 3
        paths = _unique_text_values(candidates)
        if len(paths) < minimum or len(paths) > maximum:
            if minimum == maximum == 1:
                raise ValueError(f"{mode} requires exactly one local input image")
            if minimum == maximum:
                raise ValueError(f"{mode} requires exactly {minimum} local input images")
            raise ValueError(f"{mode} requires {minimum}-{maximum} local input images")
        for path_text in paths:
            path = Path(path_text)
            if not path.exists() or not path.is_file():
                raise ValueError(f"image_generate local input image does not exist: {path}")
        return paths

    @staticmethod
    def _image_generate_size(payload: dict[str, Any]) -> str:
        width_value = payload.get("width")
        height_value = payload.get("height")
        if width_value is not None or height_value is not None:
            if width_value is None or height_value is None:
                raise ValueError("width and height must be provided together")
            width = _strict_positive_integer(width_value, name="width", default=1024, maximum=8192)
            height = _strict_positive_integer(height_value, name="height", default=1024, maximum=8192)
            return f"{width}x{height}"
        return _text(payload.get("image_size") or payload.get("size") or "1:1")

    def image_generate(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        """Run the original provider/workflow dispatcher after mode-specific normalization."""

        legacy_generate = getattr(image_model_api, "generate_image", None)
        use_runninghub_standard = bool(runninghub_image_models.resolve_api_key(payload))
        workflow_ids = payload.get("image_generate_workflow_ids") or payload.get("image_runninghub_workflow_id")
        if not use_runninghub_standard and not callable(legacy_generate) and not workflow_ids:
            raise VideoDependencyError("image generation provider is not configured")
        mode = self._image_generate_mode(payload)
        if mode == "product_only":
            payload = image_mode_prompts.apply_product_only_prompt_constraints({**payload, "mode": mode})
        count = self._image_generate_count(payload)
        input_paths = self._image_generate_inputs(payload, mode)
        prompt = image_mode_prompts.build_image_generate_prompt(payload, mode)
        size = self._image_generate_size(payload)
        workdir = self._workdir(task_id, payload)

        def standard_api_callback(**values: Any) -> dict[str, Any]:
            generation_payload = dict(values.get("payload") or payload)
            generation_payload["_task_id"] = str(values.get("task_id") or task_id)
            value_paths = [Path(str(item)).expanduser().resolve() for item in (values.get("input_image_paths") or input_paths)]
            return runninghub_image_models.generate_image_with_fallback(
                generation_payload,
                _text(values.get("prompt") or prompt),
                value_paths,
                Path(_text(values.get("output_path"))).expanduser().resolve(),
                context,
                logger=context.logger,
                poll_interval_seconds=max(_number(payload.get("video_poll_interval_seconds"), 2.0), 0.0),
                max_poll_attempts=max(_integer(payload.get("video_image_max_poll_attempts"), 180), 1),
            )

        def closed_model_callback(**values: Any) -> dict[str, Any]:
            if not callable(legacy_generate):
                return standard_api_callback(**values)
            value_paths = [_text(item) for item in (values.get("input_image_paths") or input_paths) if _text(item)]
            return legacy_generate(
                base_url=_text(payload.get("image_model_provider_base_url")),
                model=_text(values.get("model") or payload.get("image_generate_model") or payload.get("image_model_default_model")),
                prompt=_text(values.get("prompt") or prompt),
                output_image_path=_text(values.get("output_path")),
                gemini_api_key=_text(payload.get("image_model_provider_api_key_gemini")),
                gpt_api_key=_text(payload.get("image_model_provider_api_key_gpt")),
                input_image_path=value_paths[0] if value_paths else None,
                input_image_paths=value_paths,
                size=_text(values.get("size") or size),
                logger=context.logger,
            )

        def workflow_callback(**values: Any) -> dict[str, Any]:
            workflow_id = _text(values.get("workflow_id"))
            if not workflow_id:
                raise ValueError("image workflow callback requires workflow_id")
            value_paths = [_text(item) for item in (values.get("input_image_paths") or []) if _text(item)]
            product_input = Path(_text(values.get("product_input") or (value_paths[0] if value_paths else ""))).expanduser().resolve()
            model_input = Path(_text(values.get("model_input") or (value_paths[1] if len(value_paths) > 1 else product_input))).expanduser().resolve()
            workflow_payload = dict(values.get("payload") or payload)
            product_url = self._upload_runninghub_image(path=product_input, payload=workflow_payload)
            model_url = self._upload_runninghub_image(path=model_input, payload=workflow_payload)
            product_name = _text(workflow_payload.get("product_name") or "商品")
            output_path = Path(_text(values.get("output_path"))).expanduser().resolve()
            result = self._submit_and_poll(
                task_id=_text(values.get("task_id") or task_id),
                payload=workflow_payload,
                context=context,
                submit_url=self._workflow_submit_url(workflow_payload, workflow_id),
                submit_payload={
                    "nodeInfoList": [
                        {"nodeId": "16", "fieldName": "image", "fieldValue": product_url, "description": "产品图片"},
                        {"nodeId": "142", "fieldName": "string", "fieldValue": product_name, "description": "目标描述（可以是单个或者多个）"},
                        {"nodeId": "12", "fieldName": "image", "fieldValue": model_url, "description": "背景或模特图"},
                        {"nodeId": "141", "fieldName": "string", "fieldValue": _text(workflow_payload.get("replace_target_name") or product_name), "description": "被替换区域描述（可以单个可以多个）"},
                        {"nodeId": "143", "fieldName": "value", "fieldValue": str(max(_integer(workflow_payload.get("output_height_limit"), 1980), 256)), "description": "输出高度限制"},
                        {"nodeId": "215", "fieldName": "string", "fieldValue": _text(workflow_payload.get("style_hint") or values.get("prompt")), "description": "提示词（可不填，可以增加被替换后的约束）"},
                    ],
                    "instanceType": runninghub_common.instance_type_for_workflow(
                        workflow_id,
                        workflow_payload.get("instance_type") or workflow_payload.get("runninghub_instance_type"),
                    ),
                    "usePersonalQueue": False,
                },
                output_path=output_path,
                label=f"image generate workflow {workflow_id}",
            )
            if _text(result.get("status")).lower() != "success":
                raise RuntimeError(f"image generate workflow failed: {_text(result.get('error') or result.get('message'))}")
            result["image_path"] = str(output_path)
            return result

        return image_generate_dispatch.dispatch_image_generate(
            task_id=task_id,
            payload=payload,
            mode=mode,
            prompt=prompt,
            input_image_paths=input_paths,
            output_dir=workdir,
            count=count,
            size=size,
            context=context,
            workflow_callback=workflow_callback,
            standard_api_callback=standard_api_callback if use_runninghub_standard else None,
            closed_model_callback=closed_model_callback if callable(legacy_generate) or use_runninghub_standard else None,
        )


DEFAULT_SOURCE_BACKEND = ArchivedSourceBackend()


__all__ = [
    "ArchivedSourceBackend",
    "DEFAULT_SOURCE_BACKEND",
    "DIGITAL_HUMAN_VIDEO_APP_ID",
    "ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID",
    "ECOMMERCE_SHORT_VIDEO_FAST_APP_ID",
    "REPLACE_MODEL_DEFAULT_APP_ID",
    "REPLACE_PRODUCT_DEFAULT_APP_ID",
]
