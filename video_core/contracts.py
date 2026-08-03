from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


VIDEO_TASK_TYPES: tuple[str, ...] = (
    "create_video",
    "ecommerce_short_video",
    "video_language_replace",
    "replace_model",
    "replace_product",
    "image_generate",
)


class VideoDependencyError(RuntimeError):
    """Raised when an optional generation backend has not been injected."""


class VideoTaskCancelled(RuntimeError):
    """Raised when a caller-provided cancellation event is set."""


@dataclass(frozen=True)
class VideoTaskContext:
    task_id: str
    task_type: str
    cancel_event: Any = None
    logger: Callable[[str], Any] | None = None
    progress_callback: Callable[[dict[str, Any]], Any] | None = None

    def cancelled(self) -> bool:
        event = self.cancel_event
        return bool(event is not None and callable(getattr(event, "is_set", None)) and event.is_set())

    def check_cancelled(self) -> None:
        if self.cancelled():
            raise VideoTaskCancelled(f"video task cancelled: {self.task_id}")

    def log(self, message: Any) -> None:
        if self.logger is None:
            return
        try:
            self.logger(str(message))
        except Exception:
            return

    def progress(self, *, stage: str, status: str, message: str, progress: float | int | None = None) -> None:
        callback = self.progress_callback
        if callback is None:
            return
        body: dict[str, Any] = {
            "stage": str(stage),
            "state": str(status),
            "status": str(message),
            "data": {
                "stage": str(stage),
                "status": str(status),
                "source": "video_workbench",
                "user_visible": True,
            },
        }
        if progress is not None:
            body["progress"] = progress
            body["data"]["progress"] = progress
        try:
            callback(body)
        except Exception:
            return


def _string(value: Any) -> str:
    return str(value or "").strip()


def _task_ids(result: dict[str, Any]) -> list[str]:
    values: list[Any] = []
    raw_ids = result.get("runninghub_task_ids")
    if isinstance(raw_ids, (list, tuple)):
        values.extend(raw_ids)
    values.extend(
        [
            result.get("runninghub_task_id"),
            result.get("task_id"),
            result.get("task id"),
            result.get("taskId"),
        ]
    )
    normalized: list[str] = []
    for value in values:
        text = _string(value)
        if text and text not in normalized:
            normalized.append(text)
    return normalized


def _existing_path(*values: Any) -> str:
    fallback = ""
    for value in values:
        text = _string(value)
        if not text:
            continue
        if not fallback:
            fallback = text
        try:
            if Path(text).expanduser().exists():
                return text
        except (OSError, ValueError):
            continue
    return fallback


def normalize_video_result(task_type: str, value: Any, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Normalize source-core output without discarding source-specific fields."""

    typ = _string(task_type)
    if typ not in VIDEO_TASK_TYPES:
        raise ValueError(f"unsupported video task type: {typ or '(empty)'}")
    source = dict(value) if isinstance(value, dict) else {"raw_result": value}
    merged = dict(source)
    status = _string(source.get("status")).lower()
    ok_value = source.get("ok")
    ok = bool(ok_value) if ok_value is not None else status in {"ok", "success", "succeeded", "completed"}
    task_ids = _task_ids(source)
    message = _string(source.get("message") or source.get("error"))
    if not message:
        message = "任务完成" if ok else "任务失败"

    merged["ok"] = ok
    merged["message"] = message
    merged["runninghub_task_id"] = task_ids[-1] if task_ids else ""
    merged["runninghub_task_ids"] = task_ids
    merged["runninghub_usage"] = source.get("runninghub_usage") if isinstance(source.get("runninghub_usage"), dict) else {}
    merged["raw_result"] = source.get("raw_result", source)

    download_path = _existing_path(
        source.get("download_path"),
        source.get("video_path"),
        source.get("image_path"),
        source.get("result_zip"),
        source.get("output_path"),
    )
    merged["download_path"] = download_path

    request = payload if isinstance(payload, dict) else {}
    if typ == "create_video":
        merged.setdefault("nano_images", 0)
        merged.setdefault("speech_text", _string(request.get("speech_text") or request.get("script") or request.get("copy_text")))
        merged.setdefault("prompt_text", _string(request.get("prompt_text") or request.get("prompt") or request.get("message")))
        merged["video_path"] = _existing_path(source.get("video_path"), download_path)
        merged.setdefault("cover_image_path", "")
        merged.setdefault("poster_image_path", merged.get("cover_image_path") or "")
        merged.setdefault("subtitle_path", "")
        merged.setdefault("subtitled", bool(merged.get("subtitle_path")))
        merged.setdefault("ai_copy", {})
        merged.setdefault("warnings", [])
    elif typ == "ecommerce_short_video":
        merged["video_path"] = _existing_path(source.get("video_path"), download_path)
        merged.setdefault(
            "seedance_model_used",
            _string(
                request.get("ecommerce_model")
                or request.get("ecommerce_short_video_model")
                or request.get("seedance_model")
                or "seedance2.0"
            ),
        )
    elif typ == "video_language_replace":
        merged["video_path"] = _existing_path(source.get("video_path"), download_path)
    elif typ in {"replace_model", "replace_product"}:
        merged.setdefault("duration_seconds", request.get("duration_seconds") or request.get("duration") or 0)
        if typ == "replace_model":
            merged.setdefault("mode", _string(request.get("mode") or "original"))
            merged.setdefault("mode_label", _string(request.get("mode_label") or merged.get("mode")))
    elif typ == "image_generate":
        image_path = _existing_path(source.get("image_path"), source.get("download_path"), source.get("output_path"))
        merged["image_path"] = image_path
        merged["download_path"] = image_path or download_path
        merged.setdefault("nano_images", 1 if image_path and ok else 0)
        merged.setdefault("image_count", int(merged.get("nano_images") or 0))

    return merged
