from __future__ import annotations

import inspect
import json
import math
import os
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import requests

from .contracts import VideoDependencyError, VideoTaskCancelled, VideoTaskContext
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
            while process.poll() is None:
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
                time.sleep(0.2)
            stdout, stderr = process.communicate()
            return int(process.returncode or 0), stdout or "", stderr or ""
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
    ) -> tuple[Path, int]:
        cues = _subtitle_cues(payload)
        if not cues:
            return video_path, 0
        if not video_path.exists() or not video_path.is_file():
            raise FileNotFoundError(f"cannot burn subtitles because video output is missing: {video_path}")
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("subtitle rendering requires ffmpeg")
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
        rendered_path = workdir / f"{video_path.stem}_subtitled.mp4"
        font_size = min(max(_integer(payload.get("subtitle_font_size"), 18), 10), 72)
        margin = min(max(_integer(payload.get("subtitle_margin_vertical"), 36), 0), 400)
        subtitle_config = payload.get("subtitles") if isinstance(payload.get("subtitles"), dict) else {}
        template = _text(payload.get("subtitle_template") or subtitle_config.get("template") or "keyword_focus")
        template_styles = {
            "keyword_focus": "Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00111111",
            "bilingual_dual": "Bold=0,Spacing=0.5",
            "handwritten_quote": "Italic=1,MarginV=60",
            "split_hook": "Bold=1,MarginV=80",
        }
        template_style = template_styles.get(template, template_styles["keyword_focus"])
        force_style = f"FontSize={font_size},Outline=2,Shadow=0,Alignment=2,MarginV={margin},{template_style}"
        subtitle_filter = f"subtitles=filename='{_ffmpeg_filter_path(subtitle_path)}':force_style='{force_style}'"
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
        return rendered_path, len(cues)

    def _apply_optional_subtitles(
        self,
        *,
        video_path: Path,
        payload: dict[str, Any],
        context: VideoTaskContext,
        workdir: Path,
    ) -> tuple[Path, int, str]:
        try:
            rendered, count = self._burn_subtitles_if_requested(
                video_path=video_path,
                payload=payload,
                context=context,
                workdir=workdir,
            )
            return rendered, count, ""
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
        source_audio = self._extract_source_audio_for_separation(
            source_video=source_video,
            payload=payload,
            context=context,
            workdir=workdir,
        )
        audio_reference = self._upload_runninghub_audio(path=source_audio, payload=payload, context=context)
        app_id = _text(payload.get("video_language_audio_separation_app_id")) or VIDEO_LANGUAGE_AUDIO_SEPARATION_APP_ID
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
        api_key = self._api_key(payload)
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
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
    ) -> tuple[Path, list[dict[str, Any]], float]:
        cues = _subtitle_cues({"subtitles": {"enabled": True, "items": segments}})
        if not cues:
            raise ValueError("script_segments has no usable timed lines")
        ffmpeg = _text(payload.get("ffmpeg_path")) or shutil.which("ffmpeg") or ""
        if not ffmpeg:
            raise VideoDependencyError("timed language replacement requires ffmpeg")
        generated: list[dict[str, Any]] = []
        for cue in cues:
            context.check_cancelled()
            audio_path = self._generate_minimax_tts(
                speech_text=str(cue["text"]),
                output_path=workdir / f"video_language_segment_{int(cue['index']):03d}.mp3",
                payload=payload,
                context=context,
            )
            generated.append({**cue, "audio_path": str(audio_path)})
        total_seconds = max(
            float(source_duration or 0),
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

    def create_video(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
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
            )
        return {
            "ok": ok,
            "message": "视频流程完成" if ok else _text(result.get("message") or "视频生成失败"),
            "runninghub_task_id": _text(result.get("runninghub_task_id")),
            "runninghub_task_ids": [_text(result.get("runninghub_task_id"))] if _text(result.get("runninghub_task_id")) else [],
            "runninghub_usage": {},
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
            "runninghub_usage": {},
            "download_path": str(output_path) if output_path.exists() else "",
            "duration_seconds": duration,
            "raw_result": result,
            **({"mode": _text(payload.get("mode") or "original"), "mode_label": _text(payload.get("mode_label") or payload.get("mode") or "original")} if task_type == "replace_model" else {}),
        }

    def replace_model(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        return self._run_replace(task_type="replace_model", task_id=task_id, payload=payload, context=context)

    def replace_product(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        return self._run_replace(task_type="replace_product", task_id=task_id, payload=payload, context=context)

    @staticmethod
    def _ecommerce_duration_text(value: float) -> str:
        duration = float(value)
        if duration.is_integer():
            return str(int(duration))
        return f"{duration:.3f}".rstrip("0").rstrip(".")

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

    def ecommerce_short_video(self, *, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
        workdir = self._workdir(task_id, payload)
        product_image_paths = payload.get("product_image_local_paths")
        if product_image_paths is not None and not isinstance(product_image_paths, list):
            raise ValueError("product_image_local_paths must be a list")
        image_values = _unique_text_values(
            [
                payload.get("model_image_local_path"),
                payload.get("product_image_local_path") or payload.get("image_local_path"),
                *(product_image_paths or []),
            ]
        )
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
        reference_audio_local = _text(payload.get("audio_local_path"))
        reference_audio_remote = _text(payload.get("audio_url"))
        if reference_audio_local or reference_audio_remote:
            audio_urls.append(self._resolve_media(
                task_id=task_id,
                payload=payload,
                context=context,
                media_kind="ecommerce_reference_audio",
                local_values=(reference_audio_local,),
                remote_values=(reference_audio_remote,),
            ))
        model = _text(payload.get("ecommerce_model") or payload.get("ecommerce_short_video_model") or payload.get("seedance_model") or "seedance2.0").lower()
        fast = "fast" in model
        model_slug = "sparkvideo-2.0-fast" if fast else "sparkvideo-2.0"
        ratio = _text(payload.get("ratio") or payload.get("video_default_ratio") or "9:16")
        resolution = _text(payload.get("resolution") or payload.get("video_default_resolution") or "720p")
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
        common_prompt_parts = [base_prompt or "真实自然的产品广告短视频，无字幕，无水印。"]
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
        for segment in segment_plan:
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
                continue

            segment_output_path = workdir / f"ecommerce_short_video_segment_{segment_index:03d}.mp4"
            submit_payload = {
                "prompt": str(segment["prompt"]),
                "resolution": resolution,
                "duration": self._ecommerce_duration_text(float(segment["duration_seconds"])),
                "imageUrls": image_urls[:9],
                "videoUrls": video_urls,
                "audioUrls": audio_urls,
                "generateAudio": True,
                "ratio": ratio,
                "realPersonMode": _text(payload.get("real_person_mode") or "allow"),
                "conversionSlots": ["all"],
                "returnLastFrame": False,
                "seed": _integer(payload.get("seed"), -1),
            }
            segment_payload = dict(payload)
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

        output_path = workdir / "ecommerce_short_video.mp4"
        final_path = output_path
        subtitle_count = 0
        subtitle_warning = ""
        if ok:
            self._concat_ecommerce_segments(
                segment_paths=[Path(item["path"]) for item in segment_results],
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
            )
        task_ids = [
            _text(item.get("runninghub_task_id"))
            for item in segment_results
            if _text(item.get("runninghub_task_id"))
        ]
        task_id_value = task_ids[-1] if task_ids else ""
        submit_payloads = [item["submit_payload"] for item in segment_results if isinstance(item.get("submit_payload"), dict)]
        declared_segment_count = len(storyboard_lines) + len(prompt_segment_lines)
        return {
            "ok": ok,
            "message": "广告短视频生成完成" if ok else (failure_message or "广告短视频生成失败"),
            "runninghub_task_id": task_id_value,
            "runninghub_task_ids": task_ids,
            "runninghub_usage": {},
            "seedance_model_used": "seedance2.0fast" if fast else "seedance2.0",
            "download_path": str(final_path) if ok and final_path.exists() else "",
            "video_path": str(final_path) if ok and final_path.exists() else "",
            "subtitle_count": subtitle_count,
            "subtitles_applied": subtitle_count > 0,
            "subtitle_warning": subtitle_warning,
            "completed_segments": completed_output,
            "raw_result": {
                "duration": duration,
                "ratio": ratio,
                "resolution": resolution,
                "content_mode": content_mode,
                "image_urls": image_urls,
                "storyboard": storyboard,
                "prompt_segments": prompt_segments,
                "aggregated_prompt": prompt,
                "segment_count": declared_segment_count or len(segment_plan),
                "segments": segment_results,
                "submit_payload": submit_payloads[0] if submit_payloads else {},
                "submit_payloads": submit_payloads,
                "query": provider_results[-1] if provider_results else {},
                "queries": provider_results,
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
        source_language = _text(payload.get("source_language"))
        source_segments: Any = payload.get("source_segments") or []
        transcribe_translate_meta: dict[str, Any] = {}
        transcribe_translate_mode = "provided"
        audio_value = _text(payload.get("target_audio_local_path") or payload.get("audio_local_path"))
        if audio_value:
            target_audio = Path(audio_value).expanduser().resolve()
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
                target_audio, timed_audio_segments, aligned_total_seconds = self._generate_timed_tts_audio(
                    segments=script_segments,
                    source_duration=source_duration,
                    payload=payload,
                    context=context,
                    workdir=workdir,
                )
            else:
                target_audio = self._generate_minimax_tts(
                    speech_text=target_script,
                    output_path=workdir / "video_language_target.mp3",
                    payload=payload,
                    context=context,
                )
        preserve_background = _boolean(
            payload.get("preserve_background_audio"),
            name="preserve_background_audio",
            default=False,
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
                "source_script": source_script,
                "source_language": source_language,
                "source_segments": source_segments,
                "transcribe_translate_mode": transcribe_translate_mode,
                "transcribe_translate_meta": transcribe_translate_meta,
                "target_audio_path": str(target_audio),
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
    def _image_generate_prompt(payload: dict[str, Any], mode: str) -> str:
        user_prompt = _text(payload.get("prompt") or payload.get("prompt_text") or payload.get("message"))
        if not user_prompt and mode == "poster_translate":
            user_prompt = "Translate all readable poster text accurately and keep the original visual design coherent."
        if not user_prompt:
            raise ValueError("image_generate requires prompt/prompt_text/message")
        product_name = _text(payload.get("product_name")) or "the referenced product"
        style_hint = _text(payload.get("style_hint"))
        negative_prompt = _text(payload.get("negative_prompt"))
        if mode == "product_only":
            instruction = (
                f"Create a product-only ecommerce image for {product_name}. Use the single reference as the exact product; "
                "preserve its shape, materials, colors, branding, and proportions. Do not add a model or unrelated products."
            )
        elif mode == "model_product":
            instruction = (
                f"Create a model-and-product ecommerce image for {product_name}. The first reference is the product and the "
                "second reference is the model; preserve both identities and show a physically plausible interaction."
            )
        elif mode == "subject_replace":
            subject_kind = _text(payload.get("subject_kind") or payload.get("replace_kind") or "subject")
            instruction = (
                f"Perform subject replacement for the {subject_kind}. The first reference is the source composition and the "
                "second reference is the replacement subject. Preserve source framing, pose, lighting, shadows, and background."
            )
        elif mode == "poster_translate":
            target_language = _text(payload.get("target_language"))
            if not target_language:
                raise ValueError("poster_translate requires target_language")
            source_language = _text(payload.get("source_language")) or "auto-detected language"
            preserve_layout = _boolean(payload.get("preserve_layout"), name="preserve_layout", default=True)
            layout_text = "Preserve the original layout, hierarchy, typography, and branding." if preserve_layout else "Adjust the layout only where required for readable translated text."
            notes = _text(payload.get("translation_notes"))
            instruction = (
                f"Perform poster translation from {source_language} to {target_language}. Translate every readable marketing "
                f"text element while leaving non-text artwork unchanged. {layout_text}"
            )
            if notes:
                instruction += f" Translation notes: {notes}."
        elif mode == "digital_human_character":
            instruction = (
                "Create a digital human character suitable for consistent downstream image and video generation. Produce one "
                "clear full-body character with a recognizable face, coherent anatomy, neutral presentation, and clean background."
            )
        else:
            instruction = (
                "Create a three-view turnaround sheet of one consistent subject: front view, side view, and back view. Use a "
                "neutral pose, matching scale, consistent identity and materials, even lighting, and a clean background."
            )
        parts = [instruction, f"Creative direction: {user_prompt}"]
        if style_hint:
            parts.append(f"Visual style: {style_hint}")
        if negative_prompt:
            parts.append(f"Exclude: {negative_prompt}")
        return "\n".join(parts)

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
        generate = getattr(image_model_api, "generate_image", None)
        if not callable(generate):
            raise VideoDependencyError(
                "当前 image_model_api 未暴露 archive generate_image；在现有 server 注入时会保留其原生 image_generate runner"
            )
        mode = self._image_generate_mode(payload)
        count = self._image_generate_count(payload)
        input_paths = self._image_generate_inputs(payload, mode)
        prompt = self._image_generate_prompt(payload, mode)
        size = self._image_generate_size(payload)
        workdir = self._workdir(task_id, payload)
        generations: list[dict[str, Any]] = []
        image_paths: list[str] = []
        for index in range(1, count + 1):
            context.check_cancelled()
            output_path = workdir / ("image_generate.png" if count == 1 else f"image_generate_{index:03d}.png")
            result = generate(
                base_url=_text(payload.get("image_model_provider_base_url")),
                model=_text(payload.get("image_generate_model") or payload.get("image_model_priority_order") or payload.get("image_model_default_model")),
                prompt=prompt,
                output_image_path=str(output_path),
                gemini_api_key=_text(payload.get("image_model_provider_api_key_gemini")),
                gpt_api_key=_text(payload.get("image_model_provider_api_key_gpt")),
                input_image_path=input_paths[0] if input_paths else None,
                input_image_paths=input_paths,
                size=size,
                logger=context.logger,
            )
            context.check_cancelled()
            returned_path = _text(result.get("image_path") if isinstance(result, dict) else "")
            image_path = Path(returned_path).expanduser().resolve() if returned_path else output_path.resolve()
            if not image_path.exists() or not image_path.is_file():
                raise RuntimeError(f"image model did not create output {index}/{count}: {image_path}")
            image_paths.append(str(image_path))
            generations.append({"index": index, "image_path": str(image_path), "result": result})
            context.progress(
                stage="image_generate",
                status="running" if index < count else "success",
                message=f"图片生成 {index}/{count}",
                progress=round(index * 100 / count, 2),
            )
        first_image = image_paths[0]
        return {
            "ok": True,
            "message": "图片生成完成",
            "runninghub_task_id": "",
            "runninghub_task_ids": [],
            "runninghub_usage": {},
            "nano_images": len(image_paths),
            "image_count": len(image_paths),
            "image_path": first_image,
            "image_paths": image_paths,
            "download_path": first_image,
            "download_paths": image_paths,
            "raw_result": {
                "mode": mode,
                "prompt": prompt,
                "input_image_paths": input_paths,
                "size": size,
                "requested_count": count,
                "generations": generations,
            },
        }


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
