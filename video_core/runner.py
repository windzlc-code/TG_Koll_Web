from __future__ import annotations

import inspect
import threading
from collections.abc import Mapping
from typing import Any, Callable

from .contracts import (
    VIDEO_TASK_TYPES,
    VideoDependencyError,
    VideoTaskContext,
    normalize_video_result,
)


VideoBackend = Callable[..., Any]
_BACKENDS: dict[str, VideoBackend] = {}
_BACKENDS_LOCK = threading.RLock()


def configure_video_backend(task_type: str, backend: VideoBackend) -> None:
    typ = str(task_type or "").strip()
    if typ not in VIDEO_TASK_TYPES:
        raise ValueError(f"unsupported video task type: {typ or '(empty)'}")
    if not callable(backend):
        raise TypeError("video backend must be callable")
    with _BACKENDS_LOCK:
        _BACKENDS[typ] = backend


def clear_video_backend(task_type: str | None = None) -> None:
    with _BACKENDS_LOCK:
        if task_type is None:
            _BACKENDS.clear()
            return
        _BACKENDS.pop(str(task_type or "").strip(), None)


def _registered_backend(task_type: str) -> VideoBackend | None:
    with _BACKENDS_LOCK:
        return _BACKENDS.get(task_type)


def _select_backend(task_type: str, payload: dict[str, Any], backend: Any = None) -> VideoBackend:
    candidate = backend
    if candidate is None:
        candidate = payload.get("_video_task_backend") or payload.get("_video_core_runner")
    if candidate is None:
        candidate = _registered_backend(task_type)
    if isinstance(candidate, Mapping):
        candidate = candidate.get(task_type)
    elif candidate is not None and not callable(candidate):
        run_task = getattr(candidate, "run_task", None)
        candidate = run_task if callable(run_task) else getattr(candidate, task_type, None)
    if not callable(candidate):
        raise VideoDependencyError(
            f"video backend is not configured for {task_type}; inject a source-core runner "
            "with make_video_task_runners(...), configure_video_backend(...), or payload['_video_task_backend']"
        )
    return candidate


def _invoke_backend(backend: VideoBackend, *, task_type: str, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> Any:
    keyword_values: dict[str, Any] = {
        "task_type": task_type,
        "task_id": task_id,
        "payload": payload,
        "context": context,
        "cancel_event": context.cancel_event,
        "stop_requested": context.cancelled,
        "logger": context.logger,
        "progress_callback": context.progress_callback,
    }
    try:
        signature = inspect.signature(backend)
    except (TypeError, ValueError):
        return backend(task_id, payload)

    parameters = signature.parameters
    accepts_kwargs = any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values())
    kwargs = keyword_values if accepts_kwargs else {key: value for key, value in keyword_values.items() if key in parameters}
    required_positional = [
        item
        for item in parameters.values()
        if item.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
        and item.default is inspect.Parameter.empty
        and item.name not in kwargs
    ]
    if required_positional:
        return backend(task_id, payload, **{key: value for key, value in kwargs.items() if key not in {"task_id", "payload"}})
    return backend(**kwargs)


def run_video_task(
    task_type: str,
    task_id: str,
    payload: dict[str, Any] | None,
    *,
    backend: Any = None,
    cancel_event: Any = None,
) -> dict[str, Any]:
    typ = str(task_type or "").strip()
    if typ not in VIDEO_TASK_TYPES:
        raise ValueError(f"unsupported video task type: {typ or '(empty)'}")
    request = dict(payload or {})
    event = cancel_event or request.get("_cancel_event") or request.get("_video_cancel_event")
    context = VideoTaskContext(
        task_id=str(task_id),
        task_type=typ,
        cancel_event=event,
        logger=request.get("_event_logger") if callable(request.get("_event_logger")) else None,
        progress_callback=request.get("_event_progress") if callable(request.get("_event_progress")) else None,
    )
    context.check_cancelled()
    context.progress(stage="video_adapter", status="running", message="视频模块已接手任务", progress=1)
    selected = _select_backend(typ, request, backend)
    result = _invoke_backend(selected, task_type=typ, task_id=str(task_id), payload=request, context=context)
    context.check_cancelled()
    normalized = normalize_video_result(typ, result, request)
    context.progress(
        stage="video_adapter",
        status="success" if normalized.get("ok") else "failed",
        message=str(normalized.get("message") or "视频任务结束"),
        progress=100,
    )
    return normalized
