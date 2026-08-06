from __future__ import annotations

import math
import json
import inspect
import re
import subprocess
import tempfile
import threading
import html as html_lib
from datetime import datetime
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from fastapi import Depends, File, Form, HTTPException, UploadFile

from video_core import (
    DEFAULT_SOURCE_BACKEND,
    VIDEO_TASK_TYPES,
    VideoTaskCancelled,
    VideoTaskContext,
    run_video_task,
)
from video_core.source.voice_presets import ELEVENLABS_VOICE_PRESETS
from video_core.source import runninghub_common
from video_core import ecommerce_material_intelligence


DIGITAL_HUMAN_VIDEO_APP_ID = "2068273204367544322"
LEGACY_DIGITAL_HUMAN_VIDEO_APP_ID = "1958162038503649281"
ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID = "2034917373414539277"
ECOMMERCE_SHORT_VIDEO_FAST_APP_ID = "2034917373414539278"
REPLACE_MODEL_DEFAULT_APP_ID = "2028374986792116225"
REPLACE_MODEL_LEGACY_APP_ID = "1977634608437174274"
REPLACE_PRODUCT_DEFAULT_APP_ID = "1977410328592031746"
VIDEO_LANGUAGE_AUDIO_SEPARATION_APP_ID = "2054844989808619521"
_PROMPT_PREVIEW_RECOVERY: dict[str, dict[str, Any]] = {}
_PROMPT_PREVIEW_RECOVERY_LOCK = threading.RLock()


VIDEO_RUNTIME_CONFIG_DEFAULTS: dict[str, Any] = {
    "video_runninghub_base_url": "https://www.runninghub.ai",
    "video_runninghub_api_key": "",
    "video_create_audio_app_id": "",
    "video_create_video_app_id": "",
    "video_replace_model_app_id": "",
    "video_replace_product_app_id": "",
    "video_ecommerce_app_id": "",
    "video_ecommerce_fast_app_id": "",
    "video_tts_provider": "minimax",
    "video_tts_base_url": "https://api.minimaxi.com",
    "video_tts_api_key": "",
    "video_tts_model": "speech-2.8-hd",
    "video_default_voice_id": "male-qn-qingse",
    "minimax_api_key": "",
    "minimax_base_url": "https://api.minimaxi.com",
    "minimax_tts_model": "speech-2.8-hd",
    "minimax_tts_voice_id": "male-qn-qingse",
    "video_default_duration_seconds": 10,
    "video_default_ratio": "9:16",
    "video_default_resolution": "720p",
    "video_local_max_concurrency": 2,
    "runninghub_api_key": "",
    "runninghub_personal_api_key": "",
    "runninghub_enterprise_api_key": "",
    "digital_human_oral_hot_topic_mode": "strong",
    "video_image_model_priority_order": "gpt image 2, nano banana 2, nano banana pro",
    "upload_server_ip": "",
    "upload_file_api_key": "",
    "oral_digital_human_workflow_ids": [DIGITAL_HUMAN_VIDEO_APP_ID],
    "create_video_app_id": DIGITAL_HUMAN_VIDEO_APP_ID,
    "video_app_id": DIGITAL_HUMAN_VIDEO_APP_ID,
    "ecommerce_short_video_workflow_ids": [ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID],
    "ecommerce_short_video_app_id": ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID,
    "ecommerce_short_video_duration": 5,
    "ecommerce_short_video_ratio": "9:16",
    "ecommerce_short_video_resolution": "720p",
    "video_language_replace_workflow_ids": [],
    "video_language_replace_app_id": "",
    "video_language_audio_separation_app_id": VIDEO_LANGUAGE_AUDIO_SEPARATION_APP_ID,
    "replace_model_original_workflow_ids": [REPLACE_MODEL_LEGACY_APP_ID],
    "replace_model_app_id": REPLACE_MODEL_DEFAULT_APP_ID,
    "replace_model_original_app_id": REPLACE_MODEL_LEGACY_APP_ID,
    "replace_product_workflow_ids": [REPLACE_PRODUCT_DEFAULT_APP_ID],
    "replace_product_app_id": REPLACE_PRODUCT_DEFAULT_APP_ID,
}
RUNTIME_CONFIG_DEFAULTS = VIDEO_RUNTIME_CONFIG_DEFAULTS


VIDEO_RUNTIME_SECRET_KEYS = frozenset({
    "upload_file_api_key",
    "video_runninghub_api_key",
    "runninghub_api_key",
    "runninghub_personal_api_key",
    "runninghub_enterprise_api_key",
    "runninghub_shared_api_key",
    "video_tts_api_key",
    "minimax_api_key",
    "image_model_provider_api_key_gemini",
    "image_model_provider_api_key_gpt",
})

VIDEO_SERVER_MANAGED_KEYS = frozenset({
    *VIDEO_RUNTIME_SECRET_KEYS,
    "video_runninghub_base_url",
    "video_create_audio_app_id",
    "video_create_video_app_id",
    "video_replace_model_app_id",
    "video_replace_product_app_id",
    "video_ecommerce_app_id",
    "video_ecommerce_fast_app_id",
    "video_tts_provider",
    "video_tts_base_url",
    "video_tts_model",
    "video_default_voice_id",
    "minimax_base_url",
    "minimax_tts_model",
    "minimax_tts_voice_id",
    "video_local_max_concurrency",
    "upload_server_ip",
    "oral_digital_human_workflow_ids",
    "create_video_app_id",
    "video_app_id",
    "ecommerce_short_video_workflow_ids",
    "ecommerce_short_video_app_id",
    "video_language_replace_workflow_ids",
    "video_language_replace_app_id",
    "video_language_audio_separation_app_id",
    "replace_model_original_workflow_ids",
    "replace_model_app_id",
    "replace_model_original_app_id",
    "replace_product_workflow_ids",
    "replace_product_app_id",
    "image_generate_workflow_ids",
    "image_model_provider_base_url",
    "image_model_provider_api_key_gemini",
    "image_model_provider_api_key_gpt",
    "image_model_default_model",
    "image_model_priority_order",
    "ffmpeg_path",
    "video_submit_retries",
    "video_poll_interval_seconds",
    "video_task_timeout_seconds",
})

_VIDEO_LOCAL_CONCURRENCY_LOCK = threading.Lock()
_VIDEO_LOCAL_CONCURRENCY_LIMIT: int | None = None


def _server_managed_video_key(key: Any) -> bool:
    normalized = str(key or "").strip().lower()
    return (
        normalized in VIDEO_SERVER_MANAGED_KEYS
        or normalized.endswith("_workflow_ids")
        or normalized.endswith("_app_id")
    )


def _runtime_secret_key(key: Any) -> bool:
    normalized = str(key or "").strip().lower()
    return normalized in VIDEO_RUNTIME_SECRET_KEYS or any(
        marker in normalized for marker in ("api_key", "apikey", "token", "secret", "password")
    )


def video_task_payload_for_storage(task_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Return a restart-safe task payload without runtime credentials."""

    if str(task_type or "").strip() not in VIDEO_MODULE_METADATA:
        return dict(payload or {})

    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                str(key): clean(item)
                for key, item in value.items()
                if not _runtime_secret_key(key) and not callable(item)
            }
        if isinstance(value, list):
            return [clean(item) for item in value if not callable(item)]
        if isinstance(value, tuple):
            return [clean(item) for item in value if not callable(item)]
        return value

    cleaned = clean(dict(payload or {}))
    return cleaned if isinstance(cleaned, dict) else {}


def _runninghub_task_ids_from_values(*values: Any) -> list[str]:
    """Collect provider task ids without confusing them with local task ids."""

    found: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                normalized = str(key or "").strip().lower()
                if normalized == "runninghub_task_id":
                    provider_id = str(item or "").strip()
                    if provider_id and provider_id not in found:
                        found.append(provider_id)
                elif normalized == "runninghub_task_ids" and isinstance(item, (list, tuple, set)):
                    for candidate in item:
                        provider_id = str(candidate or "").strip()
                        if provider_id and provider_id not in found:
                            found.append(provider_id)
                else:
                    visit(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                visit(item)

    for value in values:
        visit(value)
    return found


def cancel_video_remote_tasks(
    task_type: str,
    *,
    input_payload: dict[str, Any] | None = None,
    output_payload: dict[str, Any] | None = None,
    runninghub_task_id: Any = "",
    runtime: dict[str, Any] | None = None,
    cancel_fn: Callable[..., dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Best-effort cancellation for every RunningHub task recorded by a video task."""

    typ = str(task_type or "").strip()
    if typ not in VIDEO_MODULE_METADATA:
        return []
    provider_ids = _runninghub_task_ids_from_values(
        {"runninghub_task_id": runninghub_task_id},
        input_payload or {},
        output_payload or {},
    )
    if not provider_ids:
        return []
    effective = apply_video_runtime_defaults(typ, {}, runtime)
    api_key = str(
        effective.get("video_runninghub_api_key")
        or effective.get("runninghub_api_key")
        or ""
    ).strip()
    base_url = str(effective.get("video_runninghub_base_url") or "https://www.runninghub.ai").strip()
    operation = cancel_fn or runninghub_common.cancel_task
    results: list[dict[str, Any]] = []
    for provider_id in provider_ids:
        try:
            result = operation(task_id=provider_id, api_key=api_key, base_url=base_url)
            item = dict(result) if isinstance(result, dict) else {"ok": bool(result)}
        except Exception as exc:  # Cancellation is best effort after local state is final.
            item = {"ok": False, "message": str(exc)}
        item["task_id"] = provider_id
        results.append(item)
    return results


VIDEO_MODULE_METADATA: dict[str, dict[str, Any]] = {
    "create_video": {
        "key": "create_video",
        "name": "数字人口播视频",
        "billing_basis": "input_audio_seconds",
        "billing_sku": "oral_video_second",
        "result_keys": ["video_path", "download_path", "runninghub_task_id", "runninghub_usage", "raw_result"],
    },
    "ecommerce_short_video": {
        "key": "ecommerce_short_video",
        "name": "电商广告短视频",
        "billing_basis": "output_video_seconds",
        "billing_sku": "seedance_<model>_<resolution>_second",
        "result_keys": ["video_path", "download_path", "seedance_model_used", "runninghub_task_ids", "raw_result"],
    },
    "video_language_replace": {
        "key": "video_language_replace",
        "name": "视频语种更换",
        "billing_basis": "input_video_seconds",
        "billing_sku": "video_language_replace_second",
        "result_keys": ["video_path", "download_path", "runninghub_task_ids", "raw_result"],
    },
    "replace_model": {
        "key": "replace_model",
        "name": "视频模特替换",
        "billing_basis": "input_video_seconds",
        "billing_sku": "video_model_replace_second",
        "result_keys": ["download_path", "duration_seconds", "mode", "runninghub_task_ids", "raw_result"],
    },
    "replace_product": {
        "key": "replace_product",
        "name": "视频商品替换",
        "billing_basis": "input_video_seconds",
        "billing_sku": "video_product_replace_second",
        "result_keys": ["download_path", "duration_seconds", "runninghub_task_ids", "raw_result"],
    },
    "image_generate": {
        "key": "image_generate",
        "name": "视频工作台图片生成",
        "billing_basis": "image_count",
        "billing_sku": "ai_image",
        "result_keys": ["image_path", "download_path", "image_count", "raw_result"],
    },
}
MODULE_METADATA = {
    "key": "video_workbench",
    "name": "模块化视频工作台",
    "version": 1,
    "queue_managed": False,
    "source_core_reused": True,
    "excluded_components": ["telegram", "legacy_auth", "legacy_db", "legacy_fastapi_app"],
    "task_types": list(VIDEO_TASK_TYPES),
    "modules": VIDEO_MODULE_METADATA,
}


_CANCEL_EVENTS: dict[str, Any] = {}
_CANCEL_EVENTS_LOCK = threading.RLock()
_SUBTITLE_RENDER_LOCKS = tuple(threading.Lock() for _ in range(32))


def bind_video_cancel_event(task_id: str, event: Any) -> Any:
    if not callable(getattr(event, "is_set", None)):
        raise TypeError("cancel event must expose is_set()")
    with _CANCEL_EVENTS_LOCK:
        _CANCEL_EVENTS[str(task_id)] = event
    return event


def release_video_cancel_event(task_id: str, event: Any = None) -> None:
    key = str(task_id)
    with _CANCEL_EVENTS_LOCK:
        if event is None or _CANCEL_EVENTS.get(key) is event:
            _CANCEL_EVENTS.pop(key, None)


def request_video_cancel(task_id: str) -> bool:
    with _CANCEL_EVENTS_LOCK:
        event = _CANCEL_EVENTS.get(str(task_id))
    setter = getattr(event, "set", None)
    if not callable(setter):
        return False
    setter()
    return True


@contextmanager
def video_cancel_scope(task_id: str, event: Any) -> Iterator[Any]:
    bind_video_cancel_event(task_id, event)
    try:
        yield event
    finally:
        release_video_cancel_event(task_id, event)


def _resolve_cancel_event(task_id: str, payload: dict[str, Any], resolver: Callable[[str], Any] | None = None) -> Any:
    direct = payload.get("_cancel_event") or payload.get("_video_cancel_event")
    if direct is not None:
        return direct
    if resolver is not None:
        resolved = resolver(str(task_id))
        if resolved is not None:
            return resolved
    with _CANCEL_EVENTS_LOCK:
        return _CANCEL_EVENTS.get(str(task_id))


def make_video_task_runners(
    backend: Any = DEFAULT_SOURCE_BACKEND,
    *,
    cancel_event_resolver: Callable[[str], Any] | None = None,
    payload_enricher: Callable[[str, str, dict[str, Any]], dict[str, Any] | None] | None = None,
) -> dict[str, Callable[[str, dict[str, Any]], dict[str, Any]]]:
    runners: dict[str, Callable[[str, dict[str, Any]], dict[str, Any]]] = {}
    for task_type in VIDEO_TASK_TYPES:
        def runner(task_id: str, payload: dict[str, Any], *, _task_type: str = task_type) -> dict[str, Any]:
            request = dict(payload or {})
            if payload_enricher is not None:
                enriched = payload_enricher(_task_type, str(task_id), request)
                if isinstance(enriched, dict):
                    request = enriched
            checkpoint = request.get("_checkpoint_video_progress")
            if callable(checkpoint):
                checkpoint(
                    task_id=str(task_id),
                    stage="video_task_started",
                    message=f"{_task_type} started",
                )
            event = _resolve_cancel_event(str(task_id), request, cancel_event_resolver)
            return run_video_task(_task_type, str(task_id), request, backend=backend, cancel_event=event)

        runner.__name__ = f"run_{task_type}"
        runner.__qualname__ = runner.__name__
        runners[task_type] = runner
    return runners


VIDEO_TASK_RUNNERS = make_video_task_runners(DEFAULT_SOURCE_BACKEND)


def _copy_default(value: Any) -> Any:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, dict):
        return dict(value)
    return value


def apply_video_runtime_defaults(
    task_type: str,
    payload: dict[str, Any] | None,
    runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    typ = str(task_type or "").strip()
    merged = dict(payload or {})
    if typ not in VIDEO_MODULE_METADATA:
        return merged
    # Provider endpoints, credentials, workflow identifiers, and local process
    # limits are server-owned. Never preserve values supplied by a web client.
    merged = {
        str(key): value
        for key, value in merged.items()
        if not _server_managed_video_key(key)
    }
    source = dict(VIDEO_RUNTIME_CONFIG_DEFAULTS)
    if isinstance(runtime, dict):
        source.update(runtime)
    workflow_runninghub_key = str(
        source.get("runninghub_personal_api_key")
        or source.get("video_runninghub_api_key")
        or source.get("runninghub_api_key")
        or source.get("runninghub_enterprise_api_key")
        or ""
    ).strip()
    enterprise_runninghub_key = str(
        source.get("runninghub_enterprise_api_key")
        or source.get("runninghub_shared_api_key")
        or workflow_runninghub_key
        or ""
    ).strip()
    source["video_runninghub_api_key"] = workflow_runninghub_key
    source["runninghub_api_key"] = workflow_runninghub_key
    source["video_tts_api_key"] = str(source.get("minimax_api_key") or source.get("video_tts_api_key") or "").strip()
    source["video_tts_base_url"] = "https://api.minimaxi.com"
    source["video_tts_model"] = str(source.get("minimax_tts_model") or "speech-2.8-hd").strip() or "speech-2.8-hd"
    source["video_default_voice_id"] = str(source.get("minimax_tts_voice_id") or "male-qn-qingse").strip() or "male-qn-qingse"
    if typ == "image_generate":
        video_image_models = [
            item.strip()
            for item in str(source.get("video_image_model_priority_order") or "").split(",")
            if item.strip()
        ]
        if not video_image_models:
            video_image_models = ["gpt image 2", "nano banana 2", "nano banana pro"]
        source["image_model_priority_order"] = ", ".join(video_image_models)
        source["image_model_default_model"] = video_image_models[0]
        source["image_model_provider_base_url"] = "https://www.runninghub.ai"
        source["image_model_provider_api_key_gemini"] = enterprise_runninghub_key
        source["image_model_provider_api_key_gpt"] = enterprise_runninghub_key

    common_keys = [
        "video_runninghub_base_url",
        "video_runninghub_api_key",
        "video_tts_provider",
        "video_tts_base_url",
        "video_tts_api_key",
        "video_tts_model",
        "video_default_voice_id",
        "minimax_api_key",
        "minimax_base_url",
        "minimax_tts_model",
        "minimax_tts_voice_id",
        "video_default_duration_seconds",
        "video_default_ratio",
        "video_default_resolution",
        "video_local_max_concurrency",
        "runninghub_api_key",
        "runninghub_personal_api_key",
        "runninghub_enterprise_api_key",
        "digital_human_oral_hot_topic_mode",
        "video_image_model_priority_order",
        "upload_server_ip",
        "upload_file_api_key",
    ]
    task_keys = {
        "create_video": ["video_create_audio_app_id", "video_create_video_app_id", "oral_digital_human_workflow_ids", "create_video_app_id", "video_app_id"],
        "ecommerce_short_video": [
            "ecommerce_short_video_workflow_ids",
            "video_ecommerce_app_id",
            "video_ecommerce_fast_app_id",
            "ecommerce_short_video_app_id",
            "ecommerce_short_video_duration",
            "ecommerce_short_video_ratio",
            "ecommerce_short_video_resolution",
        ],
        "video_language_replace": [
            "video_language_replace_workflow_ids",
            "video_language_replace_app_id",
            "video_language_audio_separation_app_id",
        ],
        "replace_model": ["video_replace_model_app_id", "replace_model_original_workflow_ids", "replace_model_app_id", "replace_model_original_app_id"],
        "replace_product": ["video_replace_product_app_id", "replace_product_workflow_ids", "replace_product_app_id"],
        "image_generate": [
            "image_generate_provider",
            "image_generate_mode_default",
            "image_model_provider_base_url",
            "image_model_provider_api_key_gemini",
            "image_model_provider_api_key_gpt",
            "image_model_default_model",
            "image_model_priority_order",
            "image_generate_workflow_ids",
        ],
    }
    for key in [*common_keys, *task_keys.get(typ, [])]:
        if key in source:
            merged[key] = _copy_default(source[key])

    global _VIDEO_LOCAL_CONCURRENCY_LIMIT
    try:
        configured_limit = min(max(int(source.get("video_local_max_concurrency") or 2), 1), 16)
    except (TypeError, ValueError):
        configured_limit = 2
    with _VIDEO_LOCAL_CONCURRENCY_LOCK:
        if _VIDEO_LOCAL_CONCURRENCY_LIMIT is None:
            _VIDEO_LOCAL_CONCURRENCY_LIMIT = configured_limit
        merged["video_local_max_concurrency"] = int(_VIDEO_LOCAL_CONCURRENCY_LIMIT)

    if typ == "create_video":
        # Original digital-human platform behavior: consistency views retry
        # twice. Keep this internal so it is not exposed as a new admin field.
        merged["_digital_human_view_retry_count"] = 2

    if typ == "ecommerce_short_video":
        merged.setdefault("_ecommerce_seeding_dynamic_enabled", True)
        try:
            merged["duration"] = min(max(int(float(merged.get("duration") or merged.get("duration_seconds") or merged.get("ecommerce_short_video_duration") or merged.get("video_default_duration_seconds") or 5)), 4), 120)
        except (TypeError, ValueError):
            merged["duration"] = 5
        ratio = str(merged.get("ratio") or merged.get("ecommerce_short_video_ratio") or merged.get("video_default_ratio") or "9:16").strip()
        merged["ratio"] = ratio if ratio in {"16:9", "4:3", "1:1", "3:4", "9:16", "21:9"} else "9:16"
        resolution = str(merged.get("resolution") or merged.get("ecommerce_short_video_resolution") or merged.get("video_default_resolution") or "720p").strip().lower()
        merged["resolution"] = resolution if resolution in {"480p", "720p", "1080p", "2k", "4k"} else "720p"
    return merged


def _positive_int(value: Any, default: int = 0) -> int:
    try:
        return max(int(math.ceil(float(value))), 0)
    except (TypeError, ValueError):
        return max(int(default), 0)


def _flag_enabled(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _nested_value(data: Any, *keys: str) -> Any:
    if not isinstance(data, dict):
        return None
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    raw = data.get("raw_result")
    if isinstance(raw, dict) and raw is not data:
        return _nested_value(raw, *keys)
    return None


def _ecommerce_billing_sku(payload: dict[str, Any]) -> str:
    model = str(
        payload.get("seedance_model_used")
        or payload.get("ecommerce_model")
        or payload.get("ecommerce_short_video_model")
        or payload.get("seedance_model")
        or "seedance2.0"
    ).strip().lower()
    resolution = str(payload.get("resolution") or payload.get("ecommerce_short_video_resolution") or "720p").strip().lower()
    if resolution not in {"480p", "720p", "1080p", "2k", "4k"}:
        resolution = "720p"
    return f"seedance_{'fast_' if 'fast' in model else ''}{resolution}_second"


def _probe_payload_media_duration(payload: dict[str, Any], *keys: str) -> float:
    for key in keys:
        value = str(payload.get(key) or "").strip()
        if not value or _valid_http_url(value):
            continue
        try:
            path = Path(value).expanduser().resolve()
            if not path.is_file():
                continue
            duration = float(DEFAULT_SOURCE_BACKEND._probe_duration(path, payload))
        except (OSError, TypeError, ValueError, subprocess.SubprocessError):
            continue
        if math.isfinite(duration) and duration > 0:
            return duration
    return 0.0


def _incremental_billing_quantity(payload: dict[str, Any], total_quantity: int) -> int | None:
    """Return a child task's remaining quantity; ``None`` means full task quantity."""

    source = payload if isinstance(payload, dict) else {}
    explicit = source.get("billing_quantity_override")
    if explicit not in (None, ""):
        try:
            return max(int(math.ceil(float(explicit))), 0)
        except (TypeError, ValueError):
            return None
    action = str(source.get("video_workbench_action") or "").strip()
    if action == "segment_regenerate" or source.get("regenerate_segment_index"):
        segment = source.get("segment") if isinstance(source.get("segment"), dict) else {}
        duration = (
            segment.get("duration_seconds")
            or segment.get("duration")
            or max(
                float(segment.get("end_seconds", segment.get("end", 0)) or 0)
                - float(segment.get("start_seconds", segment.get("start", 0)) or 0),
                0,
            )
        )
        return max(int(math.ceil(float(duration or 1))), 1)
    if action == "resume" or source.get("resume"):
        completed = source.get("completed_segments")
        completed_seconds = 0.0
        if isinstance(completed, list):
            for item in completed:
                if not isinstance(item, dict):
                    continue
                duration = item.get("duration_seconds") or item.get("duration")
                if duration in (None, ""):
                    duration = max(
                        float(item.get("end_seconds", item.get("end", 0)) or 0)
                        - float(item.get("start_seconds", item.get("start", 0)) or 0),
                        0,
                    )
                try:
                    completed_seconds += max(float(duration or 0), 0.0)
                except (TypeError, ValueError):
                    continue
        return max(int(math.ceil(float(total_quantity) - completed_seconds)), 0)
    return None


def video_task_billing_spec(task_type: str, payload: dict[str, Any] | None) -> tuple[str, int, bool] | None:
    typ = str(task_type or "").strip()
    source = dict(payload or {})
    if typ == "image_generate":
        count = _positive_int(source.get("image_count") or source.get("imageCount") or source.get("nano_images") or source.get("count") or 1, 1)
        mode = str(source.get("video_image_mode") or source.get("mode") or "product_only").strip()
        sku = {
            "product_only": "ecommerce_image",
            "model_product": "ecommerce_image",
            "subject_replace": "subject_replace_image",
            "poster_translate": "poster_translate_image",
            "digital_human_character": "subject_generate_image",
            "three_view": "subject_generate_image",
        }.get(mode, "ai_image")
        return sku, min(max(count, 1), 20), True
    if typ == "create_video":
        quantity = _positive_int(
            source.get("input_audio_duration_seconds")
            or source.get("audio_duration_seconds")
            or source.get("duration_seconds")
            or source.get("duration")
            or _probe_payload_media_duration(source, "audio_local_path", "voice_audio_local_path")
            or source.get("oral_target_duration_seconds")
            or source.get("video_default_duration_seconds")
            or 10,
            10,
        )
        incremental = _incremental_billing_quantity(source, max(quantity, 1))
        return None if incremental == 0 else ("oral_video_second", incremental if incremental is not None else max(quantity, 1), False)
    if typ == "ecommerce_short_video":
        video_mode = str(source.get("ecommerce_video_mode") or source.get("content_mode") or "").strip().lower()
        if video_mode in {"seeding_video", "seeding", "planting", "种草"}:
            operation = str(source.get("ecommerce_seeding_operation") or "").strip().lower()
            if operation in {"finalize_video", "video_only"} and source.get("confirmed_scene_image_paths"):
                return None
            if source.get("ecommerce_seeding_regenerate_scene_index"):
                return "ecommerce_seeding_image", 1, True
            storyboard = source.get("storyboard")
            if isinstance(storyboard, dict):
                storyboard = storyboard.get("items") or storyboard.get("segments") or storyboard.get("shots")
            scene_count = len(storyboard) if isinstance(storyboard, list) else 0
            scene_count = scene_count or _positive_int(source.get("ecommerce_seeding_scene_count") or 3, 3)
            return "ecommerce_seeding_image", min(max(scene_count, 1), 20), True
        quantity = _positive_int(source.get("duration") or source.get("duration_seconds") or source.get("ecommerce_short_video_duration") or 5, 5)
        incremental = _incremental_billing_quantity(source, max(quantity, 1))
        return None if incremental == 0 else (_ecommerce_billing_sku(source), incremental if incremental is not None else max(quantity, 1), False)
    if typ == "video_language_replace":
        quantity = _positive_int(
            source.get("source_video_duration_seconds")
            or source.get("video_duration_seconds")
            or source.get("duration_seconds")
            or source.get("duration")
            or _probe_payload_media_duration(source, "video_local_path", "source_video_local_path")
            or source.get("video_default_duration_seconds")
            or 10,
            10,
        )
        incremental = _incremental_billing_quantity(source, max(quantity, 1))
        return None if incremental == 0 else ("video_language_replace_second", incremental if incremental is not None else max(quantity, 1), False)
    if typ == "replace_model":
        quantity = _positive_int(
            source.get("source_video_duration_seconds")
            or source.get("video_duration_seconds")
            or source.get("duration_seconds")
            or source.get("duration")
            or _probe_payload_media_duration(source, "video_local_path", "source_video_local_path")
            or 20,
            20,
        )
        incremental = _incremental_billing_quantity(source, max(quantity, 1))
        return None if incremental == 0 else ("video_model_replace_second", incremental if incremental is not None else max(quantity, 1), False)
    if typ == "replace_product":
        quantity = _positive_int(
            source.get("source_video_duration_seconds")
            or source.get("video_duration_seconds")
            or source.get("duration_seconds")
            or source.get("duration")
            or _probe_payload_media_duration(source, "video_local_path", "source_video_local_path")
            or 20,
            20,
        )
        incremental = _incremental_billing_quantity(source, max(quantity, 1))
        return None if incremental == 0 else ("video_product_replace_second", incremental if incremental is not None else max(quantity, 1), False)
    return None


def video_billing_actual_quantity(task_type: str, task_output: dict[str, Any] | None, payload: dict[str, Any] | None) -> int:
    typ = str(task_type or "").strip()
    output = dict(task_output or {})
    request = dict(payload or {})
    raw_result = output.get("raw_result") if isinstance(output.get("raw_result"), dict) else {}
    incremental = _incremental_billing_quantity(request, 0)
    if incremental is not None:
        return incremental if bool(output.get("ok")) else 0
    if typ == "create_video" and str(raw_result.get("digital_human_stage") or "") == "visual_review":
        return 0
    if typ == "ecommerce_short_video" and str(raw_result.get("seeding_stage") or "") == "images_only":
        return 0
    if typ == "image_generate":
        paths = output.get("image_paths")
        urls = output.get("image_urls")
        return max(
            _positive_int(output.get("image_count") or output.get("nano_images")),
            len(paths) if isinstance(paths, list) else 0,
            len(urls) if isinstance(urls, list) else 0,
            1 if str(output.get("image_path") or output.get("image_url") or "").strip() else 0,
        )
    if typ not in VIDEO_MODULE_METADATA:
        return 0
    if not bool(output.get("ok")):
        return 0
    duration_keys = (
        "source_duration_seconds",
        "source_video_duration_seconds",
        "input_audio_duration_seconds",
        "audio_duration_seconds",
        "video_duration_seconds",
        "duration_seconds",
        "duration",
        "aligned_total_duration_seconds",
    )
    actual = _nested_value(output, *duration_keys)
    if actual in (None, ""):
        spec = video_task_billing_spec(typ, request)
        return int(spec[1]) if spec else 0
    return _positive_int(actual)


BILLING_SPEC = video_task_billing_spec
BILLING_ACTUAL_QUANTITY = video_billing_actual_quantity


def _server_cancel_resolver(server_module: Any) -> Callable[[str], Any]:
    def resolve(task_id: str) -> Any:
        controls = getattr(server_module, "_NORMAL_TASK_CONTROLS", None)
        lock = getattr(server_module, "_NORMAL_TASK_CONTROLS_LOCK", None)
        if not isinstance(controls, dict):
            return None
        if lock is None:
            return controls.get(str(task_id))
        try:
            with lock:
                return controls.get(str(task_id))
        except Exception:
            return controls.get(str(task_id))

    return resolve


def _digital_human_oral_hot_topic_research(
    topic_name: Any,
    copy_requirement: Any,
    *,
    mode: Any = "strong",
    http_get: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    normalized_mode = str(mode or "strong").strip().lower()
    if normalized_mode not in {"off", "soft", "strong"}:
        normalized_mode = "strong"
    topic = re.sub(r"\s+", " ", str(topic_name or "").strip())
    requirement = re.sub(r"\s+", " ", str(copy_requirement or "").strip())
    seed = topic if topic and topic not in {"口播主题", "商品", "产品", "项目", "房源"} else requirement
    seed = seed[:64].rstrip("，,、；;。 ")
    if normalized_mode == "off" or not seed:
        return {"query": "", "results": [], "summary_lines": [], "error": "", "attempted_queries": [], "mode": normalized_mode}
    category = "general"
    combined = f"{topic} {requirement}".lower()
    if re.search(r"理财|投资|基金|股票|债券|降息|加息|现金流", combined):
        category = "finance"
    elif re.search(r"\bai\b|人工智能|大模型|agent|智能体|工作流|自动化", combined):
        category = "ai"
    elif re.search(r"房产|楼市|买房|租房|公寓|住宅|通勤", combined):
        category = "real_estate"
    elif re.search(r"职场|求职|面试|沟通|汇报|简历|管理", combined):
        category = "career"
    suffixes = {
        "finance": ["本周 金融市场 讨论", "近7天 理财 趋势", "最近 财经 关注点"],
        "ai": ["本周 AI 行业 讨论", "近7天 大模型 趋势", "最近 工具 圈 热议"],
        "real_estate": ["本周 楼市 讨论", "近7天 买房租房 趋势", "最近 居住 关注点"],
        "career": ["本周 职场 讨论", "近7天 求职沟通 趋势", "最近 打工人 热议"],
        "general": ["本周 热点 讨论", "近7天 趋势", "最近 热议 话题"],
    }[category]
    date_mark = datetime.now().strftime("%Y年%m月")
    queries = [re.sub(r"\s+", " ", f"{seed} {suffix} {date_mark}").strip()[:120] for suffix in suffixes]
    if normalized_mode == "soft":
        queries = queries[:1]
    try:
        if http_get is None:
            import requests

            http_get = requests.get
        candidates: list[dict[str, str]] = []
        errors: list[str] = []
        for query in queries:
            try:
                response = http_get(
                    "https://duckduckgo.com/html/",
                    params={"q": query},
                    headers={"User-Agent": "Mozilla/5.0"},
                    timeout=8,
                )
                response.raise_for_status()
                pattern = re.compile(
                    r'<a[^>]+class="result__a"[^>]*href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>.*?'
                    r'<a[^>]+class="result__snippet"[^>]*>(?P<snippet>.*?)</a>',
                    re.S,
                )
                for match in pattern.finditer(str(response.text or "")):
                    title = html_lib.unescape(re.sub(r"<.*?>", "", match.group("title")))
                    snippet = html_lib.unescape(re.sub(r"<.*?>", "", match.group("snippet")))
                    title = re.sub(r"\s+", " ", title).strip()
                    snippet = re.sub(r"\s+", " ", snippet).strip()
                    if title:
                        candidates.append({"title": title[:120], "snippet": snippet[:220], "url": match.group("url")[:240]})
            except Exception as exc:
                errors.append(str(exc)[:160])
        terms = [item.lower() for item in re.split(r"[\s,，、；;。/|]+", f"{topic} {requirement}") if len(item.strip()) >= 2]
        unique: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for item in candidates:
            key = (item["title"], item["url"])
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        unique.sort(
            key=lambda item: sum(3 if term in item["title"].lower() else 1 for term in terms if term in f"{item['title']} {item['snippet']}".lower()),
            reverse=True,
        )
        results = unique[:4]
        return {
            "query": queries[0] if queries else "",
            "results": results,
            "summary_lines": [f"{index}. {item['title']}：{item['snippet']}"[:240] for index, item in enumerate(results, start=1)],
            "error": "；".join(errors)[:240] if not results else "",
            "category": category,
            "attempted_queries": queries,
            "mode": normalized_mode,
        }
    except Exception as exc:
        return {"query": queries[0] if queries else "", "results": [], "summary_lines": [], "error": str(exc)[:240], "category": category, "attempted_queries": queries, "mode": normalized_mode}


def _normalize_digital_human_oral_candidate_keywords(value: Any) -> list[str]:
    raw_items = value if isinstance(value, list) else []
    keywords: list[str] = []
    for item in raw_items:
        text = re.sub(r"\s+", " ", str(item or "").strip()).strip("，,、；;。:：")
        if len(text) > 18:
            text = text[:18].rstrip("，,、；;。:： ")
        if text and text not in keywords:
            keywords.append(text)
    return keywords[:6]


def _normalize_digital_human_oral_script_candidates(
    parsed: Any, *, fallback_text: str = ""
) -> tuple[list[dict[str, Any]], int]:
    """Directly adapted from the archived platform candidate normalizer."""

    source = parsed if isinstance(parsed, dict) else {}
    raw_candidates = source.get("candidates")
    if not isinstance(raw_candidates, list):
        for key in ("options", "variants", "drafts", "speech_candidates"):
            if isinstance(source.get(key), list):
                raw_candidates = source.get(key)
                break
    try:
        requested_index = max(int(source.get("selected_index") or source.get("default_index") or 1), 1)
    except (TypeError, ValueError):
        requested_index = 1
    candidates: list[dict[str, Any]] = []
    seen_speech_texts: set[str] = set()
    if isinstance(raw_candidates, list):
        for index, item in enumerate(raw_candidates, start=1):
            if not isinstance(item, dict):
                continue
            speech_text = re.sub(
                r"\s+", " ", str(item.get("speech_text") or item.get("content") or item.get("text") or "").strip()
            )
            speech_key = re.sub(r"\s+", "", speech_text).strip("，,、；;。.!?！？")
            if not speech_key or speech_key in seen_speech_texts:
                continue
            seen_speech_texts.add(speech_key)
            title = re.sub(r"\s+", " ", str(item.get("title") or item.get("headline") or item.get("name") or "").strip())
            angle = re.sub(r"\s+", " ", str(item.get("angle") or item.get("positioning") or item.get("strategy") or "").strip())
            summary = re.sub(r"\s+", " ", str(item.get("summary") or item.get("teaser") or item.get("preview") or "").strip())
            candidates.append({
                "title": title[:28] or f"方案 {index}",
                "angle": angle[:48],
                "summary": summary[:80],
                "speech_text": speech_text,
                "hook_keywords": _normalize_digital_human_oral_candidate_keywords(
                    item.get("hook_keywords") or item.get("keywords")
                ),
            })
            if len(candidates) >= 3:
                break
    if not candidates:
        single_text = re.sub(r"\s+", " ", str(source.get("speech_text") or fallback_text or "").strip())
        if single_text:
            candidates.append({
                "title": "方案 1",
                "angle": "",
                "summary": "",
                "speech_text": single_text,
                "hook_keywords": _normalize_digital_human_oral_candidate_keywords(
                    source.get("hook_keywords") or source.get("keywords")
                ),
            })
    if not candidates:
        return [], 0
    return candidates[:3], min(requested_index - 1, len(candidates) - 1)


def _server_payload_enricher(server_module: Any) -> Callable[[str, str, dict[str, Any]], dict[str, Any]]:
    def enrich(_task_type: str, _task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        updated = dict(payload or {})
        media_resolver = getattr(server_module, "_resolve_media_url", None)
        workdir_factory = getattr(server_module, "_build_task_workdir", None)
        db_factory = getattr(server_module, "db", None)
        json_loads = getattr(server_module, "_json_loads", None)
        json_dumps = getattr(server_module, "_json_dumps", None)
        now_ts = getattr(server_module, "_now_ts", None)
        if callable(media_resolver):
            updated.setdefault("_video_media_url_resolver", media_resolver)
        if callable(workdir_factory):
            updated.setdefault("_video_workdir_factory", workdir_factory)
        llm_json_request = getattr(server_module, "_request_llm_json_with_fallback", None)
        if callable(llm_json_request):
            updated.setdefault("_digital_human_visual_semantic_llm", llm_json_request)
            updated.setdefault("_digital_human_scene_marker_llm", llm_json_request)
            def generate_digital_human_copy(
                *,
                payload: dict[str, Any] | None = None,
                mode: str = "single",
                dual_presenter: bool = False,
                storyboard: list[Any] | None = None,
                model_references: list[Any] | None = None,
                product_references: list[Any] | None = None,
                **_kwargs: Any,
            ) -> dict[str, Any]:
                request_source = dict(updated)
                if isinstance(payload, dict):
                    request_source.update(payload)
                oral_mode = str(request_source.get("digital_human_content_mode") or "").strip() == "oral_broadcast"
                if oral_mode and not isinstance(request_source.get("oral_hot_topic_research"), dict):
                    request_source["oral_hot_topic_research"] = _digital_human_oral_hot_topic_research(
                        request_source.get("product_name"),
                        request_source.get("product_details") or request_source.get("copy_requirement"),
                        mode=request_source.get("digital_human_oral_hot_topic_mode") or "strong",
                    )
                supplied_references = [
                    *(model_references or []),
                    *(product_references or []),
                ]
                image_paths = [
                    str(value).strip()
                    for value in supplied_references
                    if str(value or "").strip()
                    and not _valid_http_url(value)
                    and Path(str(value)).expanduser().is_file()
                ]
                duration_instruction = ""
                try:
                    target_seconds = min(max(int(float(request_source.get("oral_target_duration_seconds") or 0)), 0), 180)
                except (TypeError, ValueError):
                    target_seconds = 0
                if target_seconds > 0:
                    language = str(request_source.get("target_language") or request_source.get("language") or "Chinese").strip().lower()
                    if language == "english":
                        minimum = max(int(round(target_seconds * 2.2)), 12)
                        maximum = max(int(round(target_seconds * 2.8)), minimum + 4)
                        unit = "English words"
                    elif language == "japanese":
                        minimum = max(int(round(target_seconds * 4.0)), 20)
                        maximum = max(int(round(target_seconds * 5.0)), minimum + 8)
                        unit = "Japanese characters"
                    elif language in {"spanish", "thai", "malay"}:
                        minimum = max(int(round(target_seconds * 2.3)), 14)
                        maximum = max(int(round(target_seconds * 3.0)), minimum + 4)
                        unit = "words"
                    else:
                        minimum = max(int(round(target_seconds * 4.0)), 18)
                        maximum = max(int(round(target_seconds * 5.0)), minimum + 8)
                        unit = "Chinese characters"
                    duration_instruction = (
                        f" Target spoken duration is {target_seconds} seconds; keep speech_text at approximately "
                        f"{minimum} to {maximum} {unit} with natural spoken pacing."
                    )
                public_source = {
                    str(key): value
                    for key, value in request_source.items()
                    if not str(key).startswith("_")
                    and not any(marker in str(key).lower() for marker in _SECRET_KEY_MARKERS)
                    and not any(marker in str(key) for marker in _LOCAL_PATH_PARAM_MARKERS)
                }
                result, selected, attempts = llm_json_request(
                    source=request_source,
                    user_input=json.dumps(
                        {
                            "mode": mode,
                            "dual_presenter": bool(dual_presenter),
                            "storyboard": storyboard or [],
                            "parameters": public_source,
                        },
                        ensure_ascii=False,
                    ),
                    system_prompt=(
                        (
                            "Create natural knowledge-sharing spoken copy for a digital-human oral broadcast. Product "
                            "references in this mode are scene/background references and must not be sold or described "
                            "as products. Use oral_hot_topic_research only when it is directly relevant, never invent a "
                            "latest event, and never expose sources or configuration. "
                        )
                        if oral_mode
                        else (
                            "Create the spoken copy for a digital-human ecommerce video. The supplied images are ordered "
                            "as presenter references followed by product references; analyze them and preserve visible "
                            "identity and product facts. Preserve product facts and do not invent product claims. "
                        )
                    ) + (
                        (
                            "Return JSON only with candidates and selected_index. candidates must contain exactly three "
                            "different complete scripts; each item uses title, angle, summary, speech_text, and "
                            "hook_keywords. selected_index is 1 to 3. Do not reveal configuration."
                        )
                        if oral_mode
                        else (
                            "Return JSON only with speech_text and segment_scripts; segment_scripts must follow the supplied "
                            "storyboard order. Preserve target language and requested opening/ending lines, and use two "
                            "distinct speakers when dual_presenter is true. Do not reveal configuration."
                        )
                    ) + duration_instruction,
                    image_paths=image_paths,
                    retry_count=2,
                    logger=request_source.get("_event_logger"),
                    request_label="digital human copy generation",
                )
                parsed = result.get("parsed") if isinstance(result, dict) else None
                if not isinstance(parsed, dict):
                    parsed = result if isinstance(result, dict) else {}
                speech_candidates: list[dict[str, Any]] = []
                selected_candidate_index = 0
                if oral_mode:
                    speech_candidates, selected_candidate_index = _normalize_digital_human_oral_script_candidates(
                        parsed,
                        fallback_text=str(parsed.get("speech_text") or parsed.get("script") or "").strip(),
                    )
                speech_text = (
                    str(speech_candidates[selected_candidate_index].get("speech_text") or "").strip()
                    if speech_candidates
                    else str(parsed.get("speech_text") or parsed.get("script") or "").strip()
                )
                if not speech_text:
                    raise RuntimeError("digital human copy generation returned no speech_text")
                segment_scripts = parsed.get("segment_scripts")
                if not isinstance(segment_scripts, list):
                    segment_scripts = []
                return {
                    "speech_text": speech_text,
                    "segment_scripts": [str(item).strip() for item in segment_scripts if str(item).strip()],
                    "speech_candidates": speech_candidates,
                    "selected_speech_candidate_index": selected_candidate_index,
                    "metadata": {
                        "provider": str(selected.get("provider") or "") if isinstance(selected, dict) else "",
                        "model": str(selected.get("model") or "") if isinstance(selected, dict) else "",
                        "attempt_count": len(attempts) if isinstance(attempts, list) else 0,
                        "speech_candidates": speech_candidates,
                        "selected_candidate_index": selected_candidate_index,
                    },
                }

            updated.setdefault("_digital_human_ai_copy_provider", generate_digital_human_copy)

            def transcribe_translate_video(
                *,
                video_path: Any,
                target_language: Any = "",
                source_language: Any = "Auto",
                source_duration: Any = 0,
                payload: dict[str, Any] | None = None,
                **_kwargs: Any,
            ) -> dict[str, Any]:
                target = str(target_language or "English").strip() or "English"
                source = str(source_language or "Auto").strip() or "Auto"
                duration = max(float(source_duration or 0), 0.0)
                request_source = dict(updated)
                if isinstance(payload, dict):
                    request_source.update(payload)
                system_prompt = (
                    "You transcribe and translate spoken video content. Return JSON only with keys "
                    "source_language, source_script, target_script, and segments. Each segments item must "
                    "contain start_seconds, end_seconds, source_text, and text, where text is the translation. "
                    "Preserve meaning, brand names, numbers, and natural speaking style. When a supplied source "
                    "script or source segments are present, keep that wording and only align timestamps before "
                    "translation. Include supplied opening and ending lines in natural positions. Do not add commentary."
                )
                user_parts = [
                    f"Transcribe the attached video's spoken audio (source language: {source}) and translate it "
                    f"to {target}. Keep timestamps aligned to the speech timeline."
                ]
                provided_script = str(request_source.get("script_text") or "").strip()
                provided_segments = (
                    request_source.get("source_segments")
                    or request_source.get("video_language_source_segments")
                )
                opening_text = str(request_source.get("opening_insert_text") or "").strip()
                ending_text = str(request_source.get("ending_insert_text") or "").strip()
                if provided_script:
                    user_parts.append(f"Use this supplied source transcript exactly:\n{provided_script}")
                if isinstance(provided_segments, list) and provided_segments:
                    user_parts.append("Use these supplied source time segments:\n" + json.dumps(provided_segments, ensure_ascii=False))
                if opening_text:
                    user_parts.append(f"Translate and insert this opening line before the original first line: {opening_text}")
                if ending_text:
                    user_parts.append(f"Translate and append this ending line after the original last line: {ending_text}")
                user_input = "\n\n".join(user_parts)
                result, selected, attempts = llm_json_request(
                    source=request_source,
                    user_input=user_input,
                    system_prompt=system_prompt,
                    video_paths=[str(Path(video_path).expanduser().resolve())],
                    retry_count=2,
                    logger=request_source.get("_event_logger"),
                    request_label="视频语种识别与翻译",
                )
                parsed = result.get("parsed") if isinstance(result, dict) else None
                if not isinstance(parsed, dict):
                    parsed = result if isinstance(result, dict) else {}
                raw_segments = parsed.get("segments")
                segments: list[dict[str, Any]] = []
                if isinstance(raw_segments, list):
                    for index, item in enumerate(raw_segments, start=1):
                        if not isinstance(item, dict):
                            continue
                        translated = str(
                            item.get("text")
                            or item.get("target_text")
                            or item.get("translated_text")
                            or ""
                        ).strip()
                        if not translated:
                            continue
                        start = float(item.get("start_seconds", item.get("start", 0)) or 0)
                        end = float(item.get("end_seconds", item.get("end", 0)) or 0)
                        if end <= start:
                            end = start + max(duration / max(len(raw_segments), 1), 1.0)
                        segments.append({
                            "index": index,
                            "start_seconds": max(start, 0.0),
                            "end_seconds": max(end, start + 0.1),
                            "text": translated,
                            "source_text": str(item.get("source_text") or item.get("original_text") or "").strip(),
                        })
                target_script = str(parsed.get("target_script") or parsed.get("translated_script") or "").strip()
                if not target_script and segments:
                    target_script = "\n".join(str(item["text"]) for item in segments)
                if not target_script:
                    raise RuntimeError("视频语种识别与翻译未返回可用的目标语言脚本")
                safe_selected = {
                    str(key): value
                    for key, value in (selected.items() if isinstance(selected, dict) else [])
                    if str(key).lower() not in {"api_key", "apikey", "token", "secret", "password"}
                }
                transcription_meta = {
                    "mode": "media_llm",
                    "selected": safe_selected,
                    "attempts": attempts,
                }
                return {
                    "target_script": target_script,
                    "segments": segments,
                    "source_script": str(parsed.get("source_script") or parsed.get("transcript") or "").strip(),
                    "source_language": str(parsed.get("source_language") or source).strip(),
                    "target_language": target,
                    "transcription": transcription_meta,
                    "meta": {"transcription": transcription_meta},
                }

            updated.setdefault("_video_language_transcribe_translate", transcribe_translate_video)
        if callable(db_factory) and callable(json_loads) and callable(json_dumps):
            def persist_checkpoint(owner_task_id: str, changes: dict[str, Any]) -> None:
                clean_task_id = str(owner_task_id or _task_id).strip()
                if not clean_task_id:
                    return
                with db_factory() as conn:
                    row = conn.execute("SELECT output_json FROM tasks WHERE id = ?", (clean_task_id,)).fetchone()
                    if row is None:
                        return
                    raw_output = row["output_json"] if hasattr(row, "keys") else row[0]
                    output = json_loads(raw_output, {})
                    if not isinstance(output, dict):
                        output = {}
                    checkpoint = output.get("video_checkpoint")
                    checkpoint = dict(checkpoint) if isinstance(checkpoint, dict) else {}
                    checkpoint.update({
                        "task_type": str(_task_type),
                        "recoverable": True,
                    })
                    completed_segment = changes.pop("completed_segment", None)
                    if isinstance(completed_segment, dict):
                        completed = checkpoint.get("completed_segments")
                        completed = [dict(item) for item in completed if isinstance(item, dict)] if isinstance(completed, list) else []
                        segment_index = int(completed_segment.get("index") or 0)
                        completed = [item for item in completed if int(item.get("index") or 0) != segment_index]
                        completed.append(dict(completed_segment))
                        completed.sort(key=lambda item: int(item.get("index") or 0))
                        checkpoint["completed_segments"] = completed
                        output["completed_segments"] = completed
                    checkpoint.update(changes)
                    output["video_checkpoint"] = checkpoint
                    updated_at = int(now_ts()) if callable(now_ts) else 0
                    conn.execute(
                        "UPDATE tasks SET output_json = ?, updated_at = CASE WHEN ? > 0 THEN ? ELSE updated_at END WHERE id = ?",
                        (json_dumps(output), updated_at, updated_at, clean_task_id),
                    )

            def register_runninghub_task(*, task_id: str, runninghub_task_id: str, **_kwargs: Any) -> None:
                provider_id = str(runninghub_task_id or "").strip()
                owner_task_id = str(task_id or _task_id).strip()
                if not provider_id or not owner_task_id:
                    return
                with db_factory() as conn:
                    row = conn.execute("SELECT output_json FROM tasks WHERE id = ?", (owner_task_id,)).fetchone()
                    raw_output = row["output_json"] if row is not None and hasattr(row, "keys") else (row[0] if row else "")
                    output = json_loads(raw_output, {})
                checkpoint = output.get("video_checkpoint") if isinstance(output, dict) else {}
                provider_ids = checkpoint.get("runninghub_task_ids") if isinstance(checkpoint, dict) else []
                provider_ids = [str(item) for item in provider_ids] if isinstance(provider_ids, list) else []
                if provider_id not in provider_ids:
                    provider_ids.append(provider_id)
                persist_checkpoint(owner_task_id, {
                    "runninghub_task_id": provider_id,
                    "runninghub_task_ids": provider_ids,
                })

            def checkpoint_video_progress(*, task_id: str = "", **changes: Any) -> None:
                safe_changes = {
                    str(key): value
                    for key, value in changes.items()
                    if str(key) in {
                        "completed_segment",
                        "stage",
                        "segment_index",
                        "segment_count",
                        "fusion_images",
                        "segment_scripts",
                        "view_sequence",
                        "message",
                        "replacement_checkpoint",
                        "completed_stages",
                        "runninghub_task_ids",
                        "runninghub_task_id",
                        "provider_model",
                        "provider_submission_key",
                        "provider_submit_attempt",
                        "final_output_path",
                    }
                }
                persist_checkpoint(str(task_id or _task_id), safe_changes)

            updated.setdefault("_register_runninghub_task", register_runninghub_task)
            updated.setdefault("_checkpoint_video_progress", checkpoint_video_progress)
        return updated

    return enrich


def inject_video_workbench(
    server_module: Any,
    *,
    backend: Any = None,
    replace_existing_runners: bool = False,
) -> dict[str, Any]:
    """Inject adapters into an imported server module without touching its queue."""

    task_runners = getattr(server_module, "TASK_RUNNERS", None)
    if not isinstance(task_runners, dict):
        raise TypeError("server module must expose a TASK_RUNNERS dict")
    defaults = getattr(server_module, "DEFAULT_RUNTIME_CONFIG", None)
    if not isinstance(defaults, dict):
        raise TypeError("server module must expose a DEFAULT_RUNTIME_CONFIG dict")

    installed: list[str] = []
    selected_backend = DEFAULT_SOURCE_BACKEND if backend is None else backend
    generated = make_video_task_runners(
        selected_backend,
        cancel_event_resolver=_server_cancel_resolver(server_module),
        payload_enricher=_server_payload_enricher(server_module),
    )
    for task_type, runner in generated.items():
        if task_type == "image_generate" and task_type in task_runners and not replace_existing_runners:
            existing_image_runner = task_runners[task_type]

            def image_generate_dispatch(task_id: str, payload: dict[str, Any], *, _existing=existing_image_runner, _video=runner):
                if str((payload or {}).get("source") or "").strip() == "video_workbench_api":
                    return _video(task_id, payload)
                return _existing(task_id, payload)

            task_runners[task_type] = image_generate_dispatch
            installed.append(task_type)
            continue
        if replace_existing_runners or task_type not in task_runners:
            task_runners[task_type] = runner
            installed.append(task_type)
    for key, value in VIDEO_RUNTIME_CONFIG_DEFAULTS.items():
        defaults.setdefault(key, _copy_default(value))

    base_defaults = getattr(server_module, "_apply_runtime_defaults", None)
    if callable(base_defaults) and not bool(getattr(base_defaults, "_video_workbench_wrapper", False)):
        def apply_defaults_wrapper(task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
            runtime = None
            db_factory = getattr(server_module, "db", None)
            runtime_getter = getattr(server_module, "_get_runtime_config", None)
            if callable(db_factory) and callable(runtime_getter):
                try:
                    with db_factory() as conn:
                        runtime = runtime_getter(conn)
                except Exception:
                    runtime = None
            merged = apply_video_runtime_defaults(task_type, payload, runtime)
            return base_defaults(task_type, merged)

        apply_defaults_wrapper._video_workbench_wrapper = True
        server_module._apply_runtime_defaults = apply_defaults_wrapper

    base_spec = getattr(server_module, "_normal_task_billing_spec", None)
    if callable(base_spec) and not bool(getattr(base_spec, "_video_workbench_wrapper", False)):
        def billing_spec_wrapper(task_type: str, payload: dict[str, Any]) -> tuple[str, int, bool] | None:
            video_spec = video_task_billing_spec(task_type, payload)
            return video_spec if video_spec is not None else base_spec(task_type, payload)

        billing_spec_wrapper._video_workbench_wrapper = True
        server_module._normal_task_billing_spec = billing_spec_wrapper

    base_actual = getattr(server_module, "_billing_actual_quantity", None)
    if callable(base_actual) and not bool(getattr(base_actual, "_video_workbench_wrapper", False)):
        def billing_actual_wrapper(task_type: str, task_output: dict[str, Any], payload: dict[str, Any]) -> int:
            existing = int(base_actual(task_type, task_output, payload) or 0)
            return existing if existing > 0 else video_billing_actual_quantity(task_type, task_output, payload)

        billing_actual_wrapper._video_workbench_wrapper = True
        server_module._billing_actual_quantity = billing_actual_wrapper

    return {
        "task_types": list(VIDEO_TASK_TYPES),
        "installed_task_types": installed,
        "preserved_task_types": [task_type for task_type in VIDEO_TASK_TYPES if task_type not in installed],
        "runtime_default_keys": list(VIDEO_RUNTIME_CONFIG_DEFAULTS),
        "queue_touched": False,
    }


_VIDEO_UPLOAD_SUFFIXES = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"},
    "video": {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"},
    "audio": {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"},
}
_LOCAL_PATH_PARAM_MARKERS = ("_local_path", "_local_paths", "_dir_path", "_zip_path")


@dataclass(frozen=True)
class VideoRouteDependencies:
    get_current_user: Callable[..., dict[str, Any]]
    enqueue_task: Callable[..., Any]
    save_upload_file: Callable[..., Any]
    new_task_id: Callable[..., str]
    workspace_username: Callable[[dict[str, Any]], str]
    workspace_user_id: Callable[[dict[str, Any]], int]
    max_upload_bytes: int | None = None
    db_factory: Callable[..., Any] | None = None
    ensure_task_access: Callable[[dict[str, Any], dict[str, Any]], Any] | None = None
    json_loads: Callable[[Any, Any], Any] | None = None
    json_dumps: Callable[[Any], str] | None = None
    now_ts: Callable[[], int] | None = None
    emit_task_event: Callable[..., Any] | None = None
    generate_prompt_preview: Callable[..., dict[str, Any]] | None = None
    build_task_detail: Callable[..., dict[str, Any]] | None = None
    enrich_video_payload: Callable[[str, str, dict[str, Any]], dict[str, Any]] | None = None
    reserve_video_step_charge: Callable[..., dict[str, Any]] | None = None
    settle_video_step_charge: Callable[..., dict[str, Any]] | None = None
    release_video_step_charge: Callable[..., dict[str, Any]] | None = None


def _upload_kind(filename: Any) -> str:
    suffix = Path(str(filename or "")).suffix.lower()
    for kind, suffixes in _VIDEO_UPLOAD_SUFFIXES.items():
        if suffix in suffixes:
            return kind
    return ""


def _valid_http_url(value: Any) -> bool:
    try:
        parsed = urlparse(str(value or "").strip())
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _sanitize_video_params(params: dict[str, Any] | None) -> dict[str, Any]:
    source = dict(params or {})
    if len(json.dumps(source, ensure_ascii=False, default=str)) > 256 * 1024:
        raise ValueError("params_json 过大")
    for key, value in source.items():
        key_text = str(key or "")
        if key_text.startswith("_"):
            raise ValueError(f"不允许提交内部参数: {key_text}")
        if any(marker in key_text for marker in _LOCAL_PATH_PARAM_MARKERS):
            raise ValueError(f"本地路径只能由上传接口生成: {key_text}")
        if key_text.endswith("_url") and value not in (None, "") and not _valid_http_url(value):
            raise ValueError(f"URL 不合法: {key_text}")
        if key_text.endswith("_urls") and value not in (None, ""):
            if not isinstance(value, list) or any(not _valid_http_url(item) for item in value):
                raise ValueError(f"URL 列表不合法: {key_text}")
    return source


def _file_role(params: dict[str, Any], file_info: dict[str, Any], index: int) -> str:
    roles = params.get("file_roles")
    role = ""
    if isinstance(roles, list) and index < len(roles):
        role = str(roles[index] or "").strip().lower()
    elif isinstance(roles, dict):
        role = str(roles.get(str(index)) or roles.get(file_info.get("name")) or "").strip().lower()
    return role


VIDEO_UI_MODULE_TASKS: dict[str, tuple[str, str | None]] = {
    "digital_human_video": ("create_video", None),
    "ecommerce_short_video": ("ecommerce_short_video", None),
    "video_language_replace": ("video_language_replace", None),
    "video_subject_replace": ("replace_model", None),
    "ecommerce_image": ("image_generate", "product_only"),
    "subject_replace": ("image_generate", "subject_replace"),
    "poster_translate": ("image_generate", "poster_translate"),
    "subject_generate": ("image_generate", "digital_human_character"),
}

VIDEO_UI_MODULE_METADATA: list[dict[str, Any]] = [
    {"id": "digital_human_video", "label": "数字人口播视频", "group": "视频生成", "task_type": "create_video"},
    {"id": "ecommerce_short_video", "label": "广告 / 种草视频", "group": "视频生成", "task_type": "ecommerce_short_video"},
    {"id": "video_language_replace", "label": "视频语种更换", "group": "视频生成", "task_type": "video_language_replace"},
    {"id": "video_subject_replace", "label": "视频模特 / 商品替换", "group": "视频生成", "task_type": "replace_model", "task_types": ["replace_model", "replace_product"]},
    {"id": "ecommerce_image", "label": "电商广告图", "group": "图片素材", "task_type": "image_generate", "modes": ["product_only", "model_product"]},
    {"id": "subject_replace", "label": "人物 / 商品替换", "group": "图片素材", "task_type": "image_generate", "modes": ["subject_replace"]},
    {"id": "poster_translate", "label": "电商图语种切换", "group": "图片素材", "task_type": "image_generate", "modes": ["poster_translate"]},
    {"id": "subject_generate", "label": "主体生成", "group": "图片素材", "task_type": "image_generate", "modes": ["digital_human_character", "three_view"]},
]


def video_ui_module_for_task(task_type: Any, input_payload: dict[str, Any] | None = None) -> str:
    """Map a persisted backend task back to its public video-workbench module."""

    typ = str(task_type or "").strip()
    source = input_payload if isinstance(input_payload, dict) else {}
    explicit = str(source.get("_video_module_id") or "").strip()
    if explicit in VIDEO_UI_MODULE_TASKS:
        return explicit
    if typ == "create_video":
        return "digital_human_video"
    if typ == "ecommerce_short_video":
        return "ecommerce_short_video"
    if typ == "video_language_replace":
        return "video_language_replace"
    if typ in {"replace_model", "replace_product", "replace_productANDmodel"}:
        return "video_subject_replace"
    if typ == "image_generate":
        mode = str(source.get("video_image_mode") or source.get("image_mode") or source.get("mode") or "").strip()
        if mode == "subject_replace":
            return "subject_replace"
        if mode == "poster_translate":
            return "poster_translate"
        if mode in {"digital_human_character", "three_view"}:
            return "subject_generate"
        if mode in {"product_only", "model_product", "single_reference", "dual_reference"}:
            return "ecommerce_image"
    return ""


def resolve_video_ui_task(module_key: Any, params: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
    key = str(module_key or "").strip()
    source = dict(params or {})
    if key in VIDEO_MODULE_METADATA:
        return key, source
    task_type, default_mode = VIDEO_UI_MODULE_TASKS.get(key, ("", None))
    if not task_type:
        raise ValueError(f"不支持的视频工作台模块: {key or '(empty)'}")
    if key == "video_subject_replace":
        subject_kind = str(source.get("subject_kind") or source.get("replace_kind") or "model").strip().lower()
        task_type = "replace_product" if subject_kind in {"product", "goods", "商品"} else "replace_model"
    if default_mode and not str(source.get("mode") or "").strip():
        source["mode"] = default_mode
    if task_type == "image_generate":
        source["video_image_mode"] = str(source.get("mode") or default_mode or "product_only").strip()
        source["mode"] = "dual_reference" if source["video_image_mode"] in {"model_product", "subject_replace"} else "single_reference"
    return task_type, source


def build_video_submit_payload(
    task_type: str,
    params: dict[str, Any] | None,
    saved_files: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Validate user input and map uploads to archived generator parameter names."""

    typ = str(task_type or "").strip()
    if typ not in VIDEO_MODULE_METADATA:
        raise ValueError(f"不支持的视频任务类型: {typ or '(empty)'}")
    payload = _sanitize_video_params(params)
    files = [dict(item) for item in (saved_files or []) if isinstance(item, dict)]
    images: list[dict[str, Any]] = []
    videos: list[dict[str, Any]] = []
    audios: list[dict[str, Any]] = []
    for index, item in enumerate(files):
        kind = str(item.get("kind") or _upload_kind(item.get("name") or item.get("path"))).strip().lower()
        if kind not in _VIDEO_UPLOAD_SUFFIXES:
            raise ValueError(f"不支持的上传文件: {item.get('name') or item.get('path')}")
        item["kind"] = kind
        item["role"] = _file_role(payload, item, index)
        {"image": images, "video": videos, "audio": audios}[kind].append(item)
    payload.pop("file_roles", None)
    payload["uploaded_files"] = [
        {"name": str(item.get("name") or ""), "path": str(item.get("path") or ""), "kind": str(item.get("kind") or "")}
        for item in files
    ]

    def path(item: dict[str, Any] | None) -> str:
        return str((item or {}).get("path") or "").strip()

    if typ == "create_video":
        model_images = [item for item in images if item.get("role") in {"model", "avatar", "person"}]
        if not model_images and images:
            model_images = [images[0]]
        image = model_images[0] if model_images else None
        products = [item for item in images if item not in model_images and item.get("role") in {"product", "scene", "goods"}]
        audio = next((item for item in audios if item.get("role") in {"audio", "voice", "speech"}), audios[0] if audios else None)
        if image:
            payload["model_image_local_path"] = path(image)
            payload["model_image_local_paths"] = [path(item) for item in model_images[:2]]
            payload.setdefault("image_local_path", path(image))
        if products:
            payload["product_image_local_path"] = path(products[0])
            payload["product_image_local_paths"] = [path(item) for item in products]
        if audio:
            payload["audio_local_path"] = path(audio)
        if videos:
            payload["camera_video_local_path"] = path(videos[0])
        if not image and not any(_valid_http_url(payload.get(key)) for key in ("model_image_url", "image_url")):
            raise ValueError("create_video 需要上传数字人图片")
        if not products and not _valid_http_url(payload.get("product_image_url")):
            raise ValueError("create_video 需要上传产品图片")
        if not audio and not any(_valid_http_url(payload.get(key)) for key in ("audio_url", "voice_audio_url")):
            has_script = bool(str(payload.get("speech_text") or payload.get("script") or payload.get("copy_text") or payload.get("message") or "").strip())
            ai_copy_enabled = _flag_enabled(payload.get("use_ai_copy")) or _flag_enabled(payload.get("use_ai_script"))
            if not has_script and not ai_copy_enabled:
                raise ValueError("create_video 需要音频或口播文本")
    elif typ == "ecommerce_short_video":
        model = next((item for item in images if item.get("role") in {"model", "model_image", "person", "avatar"}), None)
        products = [item for item in images if item is not model and item.get("role") in {"", "product", "product_image", "goods"}]
        if not products and model is not None:
            products = [model]
            model = None
        if products:
            payload["product_image_local_path"] = path(products[0])
            payload["product_image_local_paths"] = [path(item) for item in products]
        if model:
            payload["model_image_local_path"] = path(model)
        if audios:
            payload["audio_local_path"] = path(audios[0])
            payload["audio_local_paths"] = [path(item) for item in audios]
        if videos:
            payload["reference_video_local_path"] = path(videos[0])
        if not products and not payload.get("image_urls") and not _valid_http_url(payload.get("product_image_url")):
            raise ValueError("ecommerce_short_video 需要产品图片")
    elif typ == "video_language_replace":
        if videos:
            payload["video_local_path"] = path(videos[0])
        if audios:
            # The original platform treats an uploaded audio clip as a voice-clone
            # reference. target_audio_local_path is reserved for an already rendered
            # target-language track supplied by an internal recovery workflow.
            payload["voice_audio_local_path"] = path(audios[0])
            payload["audio_local_path"] = path(audios[0])
        if not videos:
            raise ValueError("video_language_replace 需要上传原视频")
        if not audios and not str(payload.get("target_script") or payload.get("translated_script") or payload.get("script") or "").strip():
            if not str(payload.get("target_language") or payload.get("language") or "").strip():
                raise ValueError("video_language_replace 自动识别翻译需要目标语言")
            payload["auto_transcribe_translate"] = True
    elif typ in {"replace_model", "replace_product"}:
        if videos:
            payload["video_local_path"] = path(videos[0])
        if images:
            payload["image_local_path"] = path(images[0])
            payload["model_image_local_path" if typ == "replace_model" else "product_image_local_path"] = path(images[0])
        if not videos or not images:
            raise ValueError(f"{typ} 需要上传 1 个视频和 1 张图片")
    elif typ == "image_generate":
        mode = str(payload.get("video_image_mode") or payload.get("mode") or "product_only").strip()
        supported_modes = {
            "product_only",
            "model_product",
            "subject_replace",
            "poster_translate",
            "digital_human_character",
            "three_view",
        }
        if mode not in supported_modes:
            raise ValueError(f"unsupported video image mode: {mode or '(empty)'}")

        def image_for_role(*roles: str) -> dict[str, Any] | None:
            role_set = {str(item).strip().lower() for item in roles}
            return next((item for item in images if str(item.get("role") or "").strip().lower() in role_set), None)

        def images_for_role(*roles: str) -> list[dict[str, Any]]:
            role_set = {str(item).strip().lower() for item in roles}
            return [item for item in images if str(item.get("role") or "").strip().lower() in role_set]

        if images:
            payload["product_image_local_paths"] = [path(item) for item in images]
            payload["primary_image_local_path"] = path(images[0])
            if len(images) > 1:
                payload["secondary_image_local_path"] = path(images[1])

        if mode == "product_only":
            products = images_for_role("product_image", "product", "goods") or images[:3]
            product = products[0] if products else None
            if not product:
                raise ValueError("product_only requires a product image")
            payload["product_image_local_path"] = path(product)
            payload["product_image_local_paths"] = [path(item) for item in products]
            payload["primary_image_local_path"] = path(product)
        elif mode == "model_product":
            products = images_for_role("product_image", "product", "goods")
            product = products[0] if products else None
            model = image_for_role("model_image", "model", "person", "avatar")
            if not product or not model:
                raise ValueError("model_product requires both product and model images")
            payload["product_image_local_path"] = path(product)
            payload["product_image_local_paths"] = [path(item) for item in products]
            payload["model_image_local_path"] = path(model)
            payload["primary_image_local_path"] = path(product)
            payload["secondary_image_local_path"] = path(model)
        elif mode == "subject_replace":
            source = image_for_role("source_image", "source", "original", "background")
            subject = image_for_role(
                "subject_image",
                "subject",
                "replacement",
                "replacement_product",
                "replacement_model",
                "model",
                "product",
            )
            if not source or not subject:
                raise ValueError("subject_replace requires both source and replacement images")
            payload["source_image_local_path"] = path(source)
            payload["subject_image_local_path"] = path(subject)
            replacement_product = image_for_role("replacement_product", "product")
            replacement_model = image_for_role("replacement_model", "model")
            if replacement_product:
                payload["replacement_product_image_local_path"] = path(replacement_product)
            if replacement_model:
                payload["replacement_model_image_local_path"] = path(replacement_model)
            payload["primary_image_local_path"] = path(source)
            payload["secondary_image_local_path"] = path(subject)
            payload.setdefault(
                "prompt",
                "Replace the main subject in the source image with the reference subject while preserving composition, lighting, perspective and background.",
            )
        elif mode == "poster_translate":
            poster = image_for_role("poster_image", "poster", "source_image", "source") or (images[0] if images else None)
            if not poster:
                raise ValueError("poster_translate requires a poster image")
            target_language = str(payload.get("target_language") or "").strip()
            if not target_language:
                raise ValueError("poster_translate requires target_language")
            payload["poster_image_local_path"] = path(poster)
            payload["primary_image_local_path"] = path(poster)
        else:
            reference = image_for_role("reference_image", "reference", "subject_image", "subject") or (images[0] if images else None)
            if reference:
                payload["reference_image_local_path"] = path(reference)
                payload["primary_image_local_path"] = path(reference)

        prompt_required = mode in {"product_only", "model_product", "digital_human_character", "three_view"}
        if prompt_required and not str(payload.get("prompt") or payload.get("prompt_text") or payload.get("message") or "").strip():
            raise ValueError(f"{mode} requires a prompt")
        try:
            count = int(payload.get("count") or 1)
        except (TypeError, ValueError) as exc:
            raise ValueError("image count must be an integer") from exc
        if count < 1 or count > 8:
            raise ValueError("image count must be between 1 and 8")
        payload["count"] = count
    return payload


_VIDEO_TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
_VIDEO_WORKBENCH_META_KEY = "video_workbench"
_VIDEO_TERMINAL_STATUSES = {"success", "failed", "cancelled"}
_VIDEO_RESUMABLE_STATUSES = {"failed", "cancelled"}
_TIMECODE_TOKEN = r"(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?"
_INLINE_TIMECODE_RE = re.compile(
    rf"^\s*\[?\s*(?P<start>{_TIMECODE_TOKEN})\s*(?:-->|[-\u2013\u2014])\s*"
    rf"(?P<end>{_TIMECODE_TOKEN})\s*\]?\s*(?P<text>.*)$"
)
_ARROW_TIMECODE_RE = re.compile(
    rf"^\s*(?P<start>{_TIMECODE_TOKEN})\s*-->\s*(?P<end>{_TIMECODE_TOKEN})(?:\s+.*)?$"
)
_PATH_KEY_MARKERS = ("path", "file", "directory", "dir")
_SECRET_KEY_MARKERS = ("api_key", "secret", "token", "password", "credential")


def _route_json_loads(dependencies: VideoRouteDependencies, value: Any, default: Any) -> Any:
    if callable(dependencies.json_loads):
        return dependencies.json_loads(value, default)
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value or ""))
    except (TypeError, ValueError):
        return default


def _route_json_dumps(dependencies: VideoRouteDependencies, value: Any) -> str:
    if callable(dependencies.json_dumps):
        return str(dependencies.json_dumps(value))
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _route_now(dependencies: VideoRouteDependencies) -> int:
    if callable(dependencies.now_ts):
        return int(dependencies.now_ts())
    import time

    return int(time.time())


def _require_video_task_id(task_id: Any) -> str:
    value = str(task_id or "").strip()
    if not _VIDEO_TASK_ID_PATTERN.fullmatch(value):
        raise HTTPException(status_code=400, detail="Invalid video task id")
    return value


def _load_owned_video_task(
    dependencies: VideoRouteDependencies,
    user: dict[str, Any],
    task_id: Any,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    tid = _require_video_task_id(task_id)
    if not callable(dependencies.db_factory) or not callable(dependencies.ensure_task_access):
        raise HTTPException(status_code=503, detail="Video task storage dependencies are unavailable")
    with dependencies.db_factory() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Video task not found")
    task = dict(row)
    dependencies.ensure_task_access(user, task)
    if str(task.get("type") or "") not in VIDEO_TASK_TYPES:
        raise HTTPException(status_code=400, detail="Task is not a video workbench task")
    input_payload = _route_json_loads(dependencies, task.get("input_json"), {})
    output_payload = _route_json_loads(dependencies, task.get("output_json"), {})
    return task, input_payload if isinstance(input_payload, dict) else {}, output_payload if isinstance(output_payload, dict) else {}


def _require_task_status(task: dict[str, Any], allowed: set[str], action: str) -> str:
    status = str(task.get("status") or "").strip().lower()
    if status not in allowed:
        raise HTTPException(status_code=409, detail=f"Task status '{status or 'unknown'}' does not allow {action}")
    return status


def _workbench_meta(input_payload: dict[str, Any]) -> dict[str, Any]:
    value = input_payload.get(_VIDEO_WORKBENCH_META_KEY)
    return dict(value) if isinstance(value, dict) else {}


def _walk_known_paths(value: Any, *, parent_key: str = "") -> Iterator[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _walk_known_paths(item, parent_key=str(key).lower())
    elif isinstance(value, list):
        for item in value:
            yield from _walk_known_paths(item, parent_key=parent_key)
    elif isinstance(value, str) and (
        any(marker in parent_key for marker in _PATH_KEY_MARKERS)
        or parent_key.endswith("_images")
    ):
        text = value.strip()
        if text and not _valid_http_url(text):
            yield text


def _resolved_path_text(value: str) -> str:
    path = Path(value)
    if ".." in path.parts:
        raise ValueError("Path traversal is not allowed")
    return str(path.resolve(strict=False)).casefold()


def _validate_metadata_paths(value: Any, known_paths: set[str], *, parent_key: str = "", depth: int = 0) -> None:
    if depth > 12:
        raise ValueError("Workflow metadata is nested too deeply")
    if isinstance(value, dict):
        for key, item in value.items():
            key_text = str(key).strip().lower()
            if key_text.startswith("_") or any(marker in key_text for marker in _SECRET_KEY_MARKERS):
                raise ValueError(f"Internal or secret field is not allowed: {key}")
            _validate_metadata_paths(item, known_paths, parent_key=key_text, depth=depth + 1)
        return
    if isinstance(value, list):
        for item in value:
            _validate_metadata_paths(item, known_paths, parent_key=parent_key, depth=depth + 1)
        return
    if not isinstance(value, str) or not any(marker in parent_key for marker in _PATH_KEY_MARKERS):
        return
    text = value.strip()
    if not text:
        return
    if parent_key.endswith("url") or parent_key.endswith("urls"):
        if not _valid_http_url(text):
            raise ValueError(f"Invalid URL in {parent_key}")
        return
    resolved = _resolved_path_text(text)
    if resolved not in known_paths:
        raise ValueError(f"Local path is not owned by this task: {parent_key}")


def _known_task_paths(input_payload: dict[str, Any], output_payload: dict[str, Any]) -> set[str]:
    paths: set[str] = set()
    for path_text in _walk_known_paths([input_payload, output_payload]):
        try:
            paths.add(_resolved_path_text(path_text))
        except ValueError:
            continue
    return paths


def _json_size_guard(value: Any, *, limit: int = 512 * 1024) -> None:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("Workflow metadata must be valid JSON") from exc
    if len(encoded.encode("utf-8")) > limit:
        raise ValueError("Workflow metadata is too large")


def _storyboard_candidate(input_payload: dict[str, Any], output_payload: dict[str, Any]) -> Any:
    meta = _workbench_meta(input_payload)
    if "storyboard" in meta:
        return meta["storyboard"]
    candidates: list[Any] = [
        input_payload.get("storyboard"),
        input_payload.get("prompt_segments"),
        input_payload.get("segment_scripts"),
    ]
    raw = output_payload.get("raw_result")
    candidates.extend([
        output_payload.get("storyboard"),
        output_payload.get("segments"),
        output_payload.get("segment_scripts"),
    ])
    if isinstance(raw, dict):
        candidates.extend([
            raw.get("storyboard"),
            raw.get("segments"),
            raw.get("segment_prompts"),
            raw.get("segment_scripts"),
        ])
    return next((item for item in candidates if isinstance(item, (dict, list)) and item), {"items": []})


def _storyboard_item_text(item: dict[str, Any]) -> str:
    return str(item.get("prompt") or item.get("text") or item.get("script") or item.get("description") or "").strip()


def _normalize_storyboard(
    value: Any,
    *,
    known_paths: set[str],
    allow_empty: bool = False,
) -> dict[str, Any]:
    if isinstance(value, dict):
        source = dict(value)
        items_value = source.get("items", source.get("segments", source.get("storyboard", [])))
    elif isinstance(value, list):
        source = {}
        items_value = value
    else:
        raise ValueError("Storyboard must be an object or array")
    if not isinstance(items_value, list):
        raise ValueError("Storyboard items must be an array")
    if len(items_value) > 120 or (not allow_empty and not items_value):
        raise ValueError("Storyboard must contain between 1 and 120 segments")
    items: list[dict[str, Any]] = []
    total_duration = 0.0
    for offset, raw_item in enumerate(items_value):
        if isinstance(raw_item, str):
            item: dict[str, Any] = {"prompt": raw_item}
        elif isinstance(raw_item, dict):
            item = dict(raw_item)
        else:
            raise ValueError(f"Storyboard segment {offset + 1} must be an object or string")
        expected = offset + 1
        supplied_index = item.get("segment_index", item.get("index", expected))
        if isinstance(supplied_index, bool) or int(supplied_index) != expected:
            raise ValueError("Storyboard segment indexes must be contiguous and 1-based")
        item.pop("index", None)
        item["segment_index"] = expected
        for field in ("prompt", "text", "script", "description"):
            if field in item:
                item[field] = str(item[field] or "").strip()
                if len(item[field]) > 12000:
                    raise ValueError(f"Storyboard segment {expected} {field} is too long")
        if not any(str(item.get(field) or "").strip() for field in ("prompt", "text", "script", "description")):
            raise ValueError(f"Storyboard segment {expected} has no prompt or text")
        if item.get("duration_seconds") not in (None, ""):
            duration = float(item["duration_seconds"])
            if not math.isfinite(duration) or duration <= 0 or duration > 120:
                raise ValueError(f"Storyboard segment {expected} duration is invalid")
            item["duration_seconds"] = round(duration, 3)
            total_duration += duration
        _validate_metadata_paths(item, known_paths)
        items.append(item)
    if total_duration > 3600:
        raise ValueError("Storyboard duration exceeds 3600 seconds")
    normalized = {key: val for key, val in source.items() if key not in {"items", "segments", "storyboard"}}
    normalized["items"] = items
    normalized["segment_count"] = len(items)
    if total_duration:
        normalized["duration_seconds"] = round(total_duration, 3)
    _json_size_guard(normalized)
    return normalized


def _subtitles_candidate(input_payload: dict[str, Any], output_payload: dict[str, Any]) -> Any:
    meta = _workbench_meta(input_payload)
    if "subtitles" in meta:
        return meta["subtitles"]
    candidates: list[Any] = [input_payload.get("subtitles"), input_payload.get("subtitle_config")]
    raw = output_payload.get("raw_result")
    candidates.extend([output_payload.get("subtitles"), output_payload.get("subtitle_config")])
    if isinstance(raw, dict):
        candidates.extend([raw.get("subtitles"), raw.get("subtitle_config")])
    return next((item for item in candidates if isinstance(item, (dict, list))), {"enabled": True, "items": []})


def _normalize_subtitles(value: Any, *, known_paths: set[str]) -> dict[str, Any]:
    if isinstance(value, list):
        source: dict[str, Any] = {}
        items_value = value
    elif isinstance(value, dict):
        source = dict(value)
        items_value = source.get("items", source.get("cues", source.get("subtitles", [])))
    else:
        raise ValueError("Subtitles must be an object or array")
    if not isinstance(items_value, list) or len(items_value) > 500:
        raise ValueError("Subtitles must contain at most 500 cues")
    items: list[dict[str, Any]] = []
    previous_start = -1.0
    for offset, raw_item in enumerate(items_value):
        if not isinstance(raw_item, dict):
            raise ValueError(f"Subtitle cue {offset + 1} must be an object")
        item = dict(raw_item)
        text = str(item.get("text") or "").strip()
        if not text or len(text) > 2000:
            raise ValueError(f"Subtitle cue {offset + 1} text is invalid")
        try:
            start = float(item.get("start_seconds", item.get("start")))
            end = float(item.get("end_seconds", item.get("end")))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Subtitle cue {offset + 1} needs numeric start/end") from exc
        if not all(math.isfinite(item_value) for item_value in (start, end)) or start < 0 or end <= start or end > 3600:
            raise ValueError(f"Subtitle cue {offset + 1} time range is invalid")
        if start < previous_start:
            raise ValueError("Subtitle cues must be ordered by start time")
        previous_start = start
        item.pop("start", None)
        item.pop("end", None)
        item["index"] = offset + 1
        item["text"] = text
        item["start_seconds"] = round(start, 3)
        item["end_seconds"] = round(end, 3)
        _validate_metadata_paths(item, known_paths)
        items.append(item)
    normalized = {key: val for key, val in source.items() if key not in {"items", "cues", "subtitles"}}
    normalized["enabled"] = bool(source.get("enabled", True))
    normalized["items"] = items
    normalized["cue_count"] = len(items)
    _validate_metadata_paths(normalized, known_paths)
    _json_size_guard(normalized)
    return normalized


_SUBTITLE_TEMPLATE_KEYS = frozenset({"split_hook", "handwritten_quote", "bilingual_dual", "keyword_focus"})
_VIDEO_OUTPUT_SUFFIXES = frozenset({".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"})


def _subtitle_template_key(value: Any) -> str:
    key = str(value or "").strip()
    return key if key in _SUBTITLE_TEMPLATE_KEYS else "split_hook"


def _subtitle_source_path(input_payload: dict[str, Any], output_payload: dict[str, Any]) -> Path:
    raw = output_payload.get("raw_result") if isinstance(output_payload.get("raw_result"), dict) else {}
    candidates = (
        output_payload.get("original_download_path"),
        output_payload.get("original_video_path"),
        output_payload.get("download_path"),
        output_payload.get("video_path"),
        output_payload.get("output_path"),
        output_payload.get("result_path"),
        raw.get("video_path"),
        raw.get("download_path"),
        raw.get("output_path"),
    )
    known_paths = _known_task_paths(input_payload, output_payload)
    saw_existing_non_video = False
    for candidate in candidates:
        text = str(candidate or "").strip()
        if not text or _valid_http_url(text):
            continue
        try:
            resolved_text = _resolved_path_text(text)
        except ValueError:
            continue
        if resolved_text not in known_paths:
            continue
        path = Path(text).expanduser().resolve(strict=False)
        if not path.exists() or not path.is_file():
            continue
        if path.suffix.lower() not in _VIDEO_OUTPUT_SUFFIXES:
            saw_existing_non_video = True
            continue
        return path
    if saw_existing_non_video:
        raise HTTPException(status_code=409, detail="Task output is not a video")
    raise HTTPException(status_code=404, detail="Task has no usable local video output")


def _subtitle_duration_seconds(source: Path, input_payload: dict[str, Any], output_payload: dict[str, Any]) -> float:
    raw = output_payload.get("raw_result") if isinstance(output_payload.get("raw_result"), dict) else {}
    candidates = (
        output_payload.get("duration_seconds"),
        output_payload.get("video_duration_seconds"),
        output_payload.get("source_duration_seconds"),
        output_payload.get("aligned_total_duration_seconds"),
        raw.get("duration_seconds"),
        raw.get("video_duration_seconds"),
        input_payload.get("duration_seconds"),
        input_payload.get("video_duration_seconds"),
    )
    for candidate in candidates:
        try:
            duration = float(candidate)
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration > 0:
            return duration
    try:
        duration = float(DEFAULT_SOURCE_BACKEND._probe_duration(source, {}))
    except Exception:
        duration = 0.0
    return duration if math.isfinite(duration) and duration > 0 else 15.0


def _subtitle_text_candidates(input_payload: dict[str, Any], output_payload: dict[str, Any]) -> Iterator[str]:
    raw = output_payload.get("raw_result") if isinstance(output_payload.get("raw_result"), dict) else {}
    keys = (
        "subtitle_text",
        "caption_text",
        "target_script",
        "translated_script",
        "speech_text",
        "script_text",
        "script",
        "copy_text",
        "message",
    )
    for source in (input_payload, output_payload, raw):
        for key in keys:
            text = str(source.get(key) or "").strip()
            if text:
                yield text


def _subtitle_cues_for_task(
    *,
    source: Path,
    input_payload: dict[str, Any],
    output_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    known_paths = _known_task_paths(input_payload, output_payload)
    try:
        stored = _normalize_subtitles(
            _subtitles_candidate(input_payload, output_payload),
            known_paths=known_paths,
        )
    except (TypeError, ValueError, OverflowError):
        stored = {"enabled": False, "items": []}
    if bool(stored.get("enabled")) and isinstance(stored.get("items"), list) and stored["items"]:
        return [dict(item) for item in stored["items"]]

    raw = output_payload.get("raw_result") if isinstance(output_payload.get("raw_result"), dict) else {}
    scripts_value = next(
        (
            value
            for value in (
                output_payload.get("segment_scripts"),
                raw.get("segment_scripts"),
                input_payload.get("segment_scripts"),
            )
            if isinstance(value, list) and value
        ),
        [],
    )
    scripts = [str(item or "").strip() for item in scripts_value if str(item or "").strip()]
    total_duration = _subtitle_duration_seconds(source, input_payload, output_payload)
    if scripts:
        durations_value = output_payload.get("segment_durations")
        if not isinstance(durations_value, list):
            durations_value = raw.get("segment_durations")
        durations: list[float] = []
        if isinstance(durations_value, list):
            for item in durations_value[: len(scripts)]:
                try:
                    duration = float(item)
                except (TypeError, ValueError):
                    duration = 0.0
                durations.append(duration if math.isfinite(duration) and duration > 0 else 0.0)
        if len(durations) < len(scripts) or any(value <= 0 for value in durations):
            completed = output_payload.get("completed_segments")
            if not isinstance(completed, list):
                completed = raw.get("completed_segments")
            by_index: dict[int, float] = {}
            if isinstance(completed, list):
                for item in completed:
                    if not isinstance(item, dict):
                        continue
                    try:
                        index = int(item.get("index") or item.get("segment_index") or 0)
                        duration = float(item.get("duration_seconds") or item.get("duration") or 0)
                    except (TypeError, ValueError):
                        continue
                    if index > 0 and math.isfinite(duration) and duration > 0:
                        by_index[index] = duration
            durations = [by_index.get(index, 0.0) for index in range(1, len(scripts) + 1)]
        if any(value <= 0 for value in durations) or len(durations) != len(scripts):
            durations = [total_duration / len(scripts)] * len(scripts)
        elif sum(durations) > total_duration > 0:
            scale = total_duration / sum(durations)
            durations = [value * scale for value in durations]
        cues: list[dict[str, Any]] = []
        cursor = 0.0
        for index, (text, duration) in enumerate(zip(scripts, durations), start=1):
            end = min(cursor + max(duration, 0.1), total_duration) if total_duration > 0 else cursor + max(duration, 0.1)
            if end <= cursor:
                end = cursor + 0.1
            cues.append({"index": index, "start_seconds": round(cursor, 3), "end_seconds": round(end, 3), "text": text})
            cursor = end
        return cues

    text = next(_subtitle_text_candidates(input_payload, output_payload), "")
    if not text:
        raise HTTPException(status_code=409, detail="Task has no script or subtitle text")
    return [{"index": 1, "start_seconds": 0.0, "end_seconds": round(max(total_duration, 0.1), 3), "text": text}]


def _persist_workbench_section(
    dependencies: VideoRouteDependencies,
    *,
    task: dict[str, Any],
    input_payload: dict[str, Any],
    section: str,
    value: dict[str, Any],
) -> int:
    if not callable(dependencies.db_factory):
        raise HTTPException(status_code=503, detail="Video task storage dependency is unavailable")
    meta = _workbench_meta(input_payload)
    revision = int(meta.get("revision") or 0) + 1
    meta[section] = value
    meta["revision"] = revision
    meta["updated_at"] = _route_now(dependencies)
    updated_input = dict(input_payload)
    updated_input[_VIDEO_WORKBENCH_META_KEY] = meta
    with dependencies.db_factory() as conn:
        cursor = conn.execute(
            "UPDATE tasks SET input_json = ?, updated_at = ? WHERE id = ? AND status = ? AND updated_at IS ?",
            (
                _route_json_dumps(dependencies, updated_input),
                meta["updated_at"],
                str(task["id"]),
                str(task.get("status") or ""),
                task.get("updated_at"),
            ),
        )
        if int(getattr(cursor, "rowcount", 0)) != 1:
            raise HTTPException(status_code=409, detail="Task changed while workflow metadata was being saved")
    if callable(dependencies.emit_task_event):
        dependencies.emit_task_event(
            task_id=str(task["id"]),
            user_id=int(task["user_id"]),
            kind="metadata_updated",
            message=f"Video {section} updated",
            data={"section": section, "revision": revision},
        )
    return revision


def _new_video_task_id(dependencies: VideoRouteDependencies) -> str:
    try:
        return str(dependencies.new_task_id())
    except TypeError:
        return str(dependencies.new_task_id("task"))


def _child_task_payload(input_payload: dict[str, Any]) -> dict[str, Any]:
    payload = {
        str(key): value
        for key, value in input_payload.items()
        if not str(key).startswith("_") and not any(marker in str(key).lower() for marker in _SECRET_KEY_MARKERS)
    }
    payload.pop("billing_reservation_id", None)
    workbench_meta = payload.get(_VIDEO_WORKBENCH_META_KEY)
    if isinstance(workbench_meta, dict):
        if isinstance(workbench_meta.get("storyboard"), dict):
            payload["storyboard"] = dict(workbench_meta["storyboard"])
            storyboard_items = payload["storyboard"].get("items")
            if isinstance(storyboard_items, list):
                payload["prompt_segments"] = [
                    _storyboard_item_text(item)
                    for item in storyboard_items
                    if isinstance(item, dict) and _storyboard_item_text(item)
                ]
        if isinstance(workbench_meta.get("subtitles"), dict):
            payload["subtitles"] = dict(workbench_meta["subtitles"])
            payload["subtitle_config"] = dict(workbench_meta["subtitles"])
    payload["source"] = "video_workbench_api"
    return json.loads(json.dumps(payload, ensure_ascii=False, allow_nan=False))


def _video_continuation_fields(task_type: Any, output_payload: dict[str, Any]) -> dict[str, Any]:
    if str(task_type or "").strip() != "create_video":
        return {}
    checkpoint = output_payload.get("video_checkpoint")
    checkpoint = checkpoint if isinstance(checkpoint, dict) else {}
    fields: dict[str, Any] = {}
    fusion_images = output_payload.get("fusion_images") or checkpoint.get("fusion_images")
    if isinstance(fusion_images, list) and fusion_images:
        fields["digital_human_fusion_image_paths"] = list(fusion_images)
    for key in ("segment_scripts", "view_sequence"):
        value = output_payload.get(key) or checkpoint.get(key)
        if isinstance(value, list) and value:
            fields[key] = list(value)
    return fields


def _output_raw_result(output_payload: dict[str, Any]) -> dict[str, Any]:
    raw = output_payload.get("raw_result")
    return dict(raw) if isinstance(raw, dict) else {}


def _video_language_timed_segments(
    input_payload: dict[str, Any],
    output_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    raw = _output_raw_result(output_payload)
    candidates = (
        input_payload.get("script_segments"),
        input_payload.get("subtitle_segments"),
        raw.get("timed_audio_segments"),
        input_payload.get("source_segments"),
        raw.get("source_segments"),
    )
    source = next((item for item in candidates if isinstance(item, list) and item), [])
    rows: list[dict[str, Any]] = []
    for offset, item in enumerate(source, start=1):
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start_seconds", item.get("start", 0)) or 0)
            end = float(item.get("end_seconds", item.get("end", 0)) or 0)
        except (TypeError, ValueError):
            continue
        text = str(
            item.get("target_text")
            or item.get("translated_text")
            or item.get("text")
            or item.get("source_text")
            or ""
        ).strip()
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or not text:
            continue
        rows.append({
            "index": offset,
            "start_seconds": round(start, 3),
            "end_seconds": round(end, 3),
            "text": text,
            "source_text": str(item.get("source_text") or text).strip(),
        })
    return rows


def _seeding_scene_paths(output_payload: dict[str, Any]) -> list[str]:
    raw = _output_raw_result(output_payload)
    candidates = (
        raw.get("generated_scene_image_paths"),
        output_payload.get("image_paths"),
    )
    for value in candidates:
        if isinstance(value, list) and value:
            return [str(item or "").strip() for item in value if str(item or "").strip()]
    return []


def _seeding_image_history(output_payload: dict[str, Any], scene_index: int) -> list[dict[str, Any]]:
    raw = _output_raw_result(output_payload)
    history_map = raw.get("seeding_image_history")
    values = history_map.get(str(scene_index), []) if isinstance(history_map, dict) else []
    items = [dict(item) for item in values if isinstance(item, dict) and str(item.get("path") or "").strip()]
    paths = _seeding_scene_paths(output_payload)
    if 1 <= scene_index <= len(paths):
        current = paths[scene_index - 1]
        if current and not any(str(item.get("path") or "") == current for item in items):
            items.insert(0, {"path": current, "source": "current"})
    return items[:50]


def _replace_seeding_scene_path(
    output_payload: dict[str, Any],
    *,
    scene_index: int,
    image_path: str,
    source: str,
    created_at: int,
) -> dict[str, Any]:
    output = dict(output_payload)
    raw = _output_raw_result(output)
    paths = _seeding_scene_paths(output)
    if scene_index < 1 or scene_index > len(paths):
        raise ValueError(f"scene_index must be between 1 and {len(paths)}")
    resolved = str(Path(str(image_path or "")).expanduser().resolve())
    if not Path(resolved).is_file():
        raise ValueError("Selected ecommerce seeding image does not exist")
    history_map = raw.get("seeding_image_history")
    history_map = dict(history_map) if isinstance(history_map, dict) else {}
    history = [dict(item) for item in history_map.get(str(scene_index), []) if isinstance(item, dict)]
    for path_value, path_source in ((paths[scene_index - 1], "previous"), (resolved, source)):
        if path_value and not any(str(item.get("path") or "") == path_value for item in history):
            history.insert(0, {"path": path_value, "source": path_source, "created_at": int(created_at)})
    history_map[str(scene_index)] = history[:50]
    paths[scene_index - 1] = resolved
    raw["generated_scene_image_paths"] = paths
    raw["seeding_image_history"] = history_map
    segments = raw.get("segments")
    if isinstance(segments, list):
        updated_segments: list[Any] = []
        for offset, item in enumerate(segments, start=1):
            if isinstance(item, dict) and int(item.get("index") or offset) == scene_index:
                item = {**item, "path": resolved, "image_path": resolved, "image_source": source}
            updated_segments.append(item)
        raw["segments"] = updated_segments
    output["raw_result"] = raw
    output["image_paths"] = paths
    output["image_path"] = paths[0]
    output["download_path"] = paths[0]
    return output


def _enqueue_video_child(
    dependencies: VideoRouteDependencies,
    *,
    user: dict[str, Any],
    source_task: dict[str, Any],
    input_payload: dict[str, Any],
    action: str,
    extra: dict[str, Any],
) -> dict[str, Any]:
    task_id = _new_video_task_id(dependencies)
    payload = _child_task_payload(input_payload)
    payload.update(extra)
    payload["source_task_id"] = str(source_task["id"])
    payload["video_workbench_action"] = action
    dependencies.enqueue_task(
        task_id,
        int(dependencies.workspace_user_id(user)),
        str(source_task["type"]),
        payload,
        user,
    )
    return {
        "id": task_id,
        "task_type": str(source_task["type"]),
        "status": "queued",
        "source_task_id": str(source_task["id"]),
        "action": action,
    }


def _voice_preview_for_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Voice preview payload must be an object")
    requested = str(payload.get("voice_id") or payload.get("preset_id") or payload.get("id") or "").strip()
    text = str(payload.get("text") or payload.get("script") or "").strip()
    if len(text) > 300:
        raise HTTPException(status_code=400, detail="Voice preview text must not exceed 300 characters")
    preset: dict[str, Any] | None = None
    language = ""
    for preset_language, presets in ELEVENLABS_VOICE_PRESETS.items():
        for item in presets:
            if isinstance(item, dict) and requested in {
                str(item.get("key") or ""),
                str(item.get("voice_id") or ""),
            }:
                preset = item
                language = str(preset_language)
                break
        if preset is not None:
            break
    if preset is None:
        raise HTTPException(status_code=404, detail="Voice preset not found")
    preview_asset = str(preset.get("preview_asset") or "").strip().replace("\\", "/").lstrip("/")
    preview_url = str(preset.get("preview_url") or "").strip()
    if preview_asset:
        asset_path = PurePosixPath(preview_asset)
        if ".." in asset_path.parts or asset_path.suffix.lower() not in {".mp3", ".wav", ".m4a", ".ogg"}:
            raise HTTPException(status_code=500, detail="Voice preset asset is invalid")
        preview_url = f"/assets/{asset_path.as_posix()}"
    elif not _valid_http_url(preview_url):
        raise HTTPException(status_code=404, detail="Voice preset has no fixed preview resource")
    return {
        "ok": True,
        "source": "fixed_preset_resource",
        "voice_id": str(preset.get("voice_id") or requested),
        "preset_id": str(preset.get("key") or requested),
        "label": str(preset.get("label") or preset.get("button") or preset.get("voice_name") or ""),
        "language": language,
        "preview_url": preview_url,
        "requested_text_synthesized": False,
        "cache_policy": "fixed_asset",
    }


def _timecode_seconds(value: str) -> float:
    parts = str(value).strip().replace(",", ".").split(":")
    if len(parts) not in {2, 3}:
        raise ValueError(f"Invalid timecode: {value}")
    try:
        seconds = float(parts[-1]) + int(parts[-2]) * 60
        if len(parts) == 3:
            seconds += int(parts[0]) * 3600
    except ValueError as exc:
        raise ValueError(f"Invalid timecode: {value}") from exc
    if not math.isfinite(seconds) or seconds < 0 or seconds > 3600:
        raise ValueError(f"Timecode out of range: {value}")
    return round(seconds, 3)


def parse_language_script(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Language script payload must be an object")
    script = str(payload.get("script") or payload.get("text") or "").replace("\r\n", "\n").strip()
    if not script:
        raise ValueError("Language script is empty")
    if len(script.encode("utf-8")) > 64 * 1024:
        raise ValueError("Language script is too large")
    lines = script.split("\n")
    segments: list[dict[str, Any]] = []
    untimed: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line:
            index += 1
            continue
        inline = _INLINE_TIMECODE_RE.match(line)
        arrow = _ARROW_TIMECODE_RE.match(line)
        if arrow:
            text_lines: list[str] = []
            cursor = index + 1
            while cursor < len(lines) and lines[cursor].strip():
                if _ARROW_TIMECODE_RE.match(lines[cursor].strip()) or _INLINE_TIMECODE_RE.match(lines[cursor].strip()):
                    break
                text_lines.append(lines[cursor].strip())
                cursor += 1
            text = " ".join(part for part in text_lines if part).strip()
            match = arrow
            index = cursor
        elif inline:
            match = inline
            text = str(inline.group("text") or "").strip()
            index += 1
        else:
            if not line.isdigit():
                untimed.append(line)
            index += 1
            continue
        start = _timecode_seconds(match.group("start"))
        end = _timecode_seconds(match.group("end"))
        if end <= start:
            raise ValueError("Language script segment end must be after start")
        if not text:
            raise ValueError("Language script segment text is empty")
        if len(text) > 4000:
            raise ValueError("Language script segment text is too long")
        if segments and start < float(segments[-1]["start_seconds"]):
            raise ValueError("Language script segments must be ordered")
        segments.append({
            "index": len(segments) + 1,
            "start_seconds": start,
            "end_seconds": end,
            "text": text,
        })
        if len(segments) > 500:
            raise ValueError("Language script contains more than 500 segments")
    warnings: list[str] = []
    if not segments:
        segments = [
            {"index": item_index, "start_seconds": None, "end_seconds": None, "text": text}
            for item_index, text in enumerate(untimed, start=1)
        ]
    elif untimed:
        warnings.append("Ignored untimed lines outside timestamped segments")
    if not segments:
        raise ValueError("Language script has no usable segments")
    return {
        "segments": segments,
        "segment_count": len(segments),
        "has_timecodes": segments[0]["start_seconds"] is not None,
        "duration_seconds": max((float(item["end_seconds"]) for item in segments if item["end_seconds"] is not None), default=0.0),
        "plain_text": "\n".join(str(item["text"]) for item in segments),
        "source_language": str(payload.get("source_language") or "").strip()[:40],
        "target_language": str(payload.get("target_language") or "").strip()[:40],
        "warnings": warnings,
    }


async def _save_video_upload(
    dependencies: VideoRouteDependencies,
    *,
    username: str,
    task_id: str,
    field_name: str,
    upload: UploadFile,
) -> str:
    values = {
        "username": username,
        "task_id": task_id,
        "field_name": field_name,
        "upload": upload,
        "max_bytes": dependencies.max_upload_bytes,
    }
    signature = inspect.signature(dependencies.save_upload_file)
    kwargs = {key: value for key, value in values.items() if key in signature.parameters and value is not None}
    result = dependencies.save_upload_file(**kwargs)
    if inspect.isawaitable(result):
        result = await result
    return str(result or "").strip()


_DIGITAL_HUMAN_STEP_NAMES = frozenset({"script", "fusion_main", "fusion_views", "fusion_view"})
_DIGITAL_HUMAN_STEP_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp"})


def _digital_human_step_task_id(payload: dict[str, Any], params: dict[str, Any]) -> str:
    task_id = (
        payload.get("task_id")
        or payload.get("web_session_task_id")
        or params.pop("task_id", None)
        or params.get("web_session_task_id")
        or params.get("source_task_id")
    )
    if not str(task_id or "").strip():
        raise HTTPException(status_code=400, detail="task_id is required for digital-human step correction")
    return _require_video_task_id(task_id)


def _digital_human_step_public_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _digital_human_step_public_value(item)
            for key, item in value.items()
            if not str(key).startswith("_")
            and not any(marker in str(key).lower() for marker in _SECRET_KEY_MARKERS)
            and not callable(item)
        }
    if isinstance(value, (list, tuple)):
        return [_digital_human_step_public_value(item) for item in value if not callable(item)]
    if isinstance(value, Path):
        return str(value)
    if callable(value):
        return None
    return value


def _digital_human_step_workdir(task_id: str, payload: dict[str, Any]) -> Path:
    factory = payload.get("_video_workdir_factory") or payload.get("_workdir_factory")
    if not callable(factory):
        raise HTTPException(status_code=503, detail="Digital-human task workdir dependency is unavailable")
    try:
        workdir = Path(factory(str(task_id))).expanduser().resolve(strict=False)
        workdir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Digital-human task workdir is unavailable") from exc
    return workdir


def _digital_human_step_image_path(
    value: Any,
    *,
    known_paths: set[str],
    workdir: Path,
) -> str:
    text = str(value or "").strip()
    if not text or _valid_http_url(text):
        raise ValueError("Digital-human image provider returned no local image")
    path = Path(text).expanduser().resolve(strict=False)
    if not path.is_file() or path.suffix.lower() not in _DIGITAL_HUMAN_STEP_IMAGE_SUFFIXES:
        raise ValueError("Digital-human image provider returned an invalid image")
    resolved = str(path).casefold()
    if resolved not in known_paths and path != workdir and workdir not in path.parents:
        raise ValueError("Digital-human image provider returned media outside the owned task directory")
    return str(path)


def _digital_human_step_result_path(result: Any) -> Any:
    if isinstance(result, dict):
        return result.get("image_path") or result.get("download_path") or result.get("output_path") or result.get("path")
    return result


def _digital_human_step_result_paths(result: Any) -> list[Any]:
    if isinstance(result, dict):
        for key in ("image_paths", "fusion_images", "paths", "output_paths"):
            value = result.get(key)
            if isinstance(value, (list, tuple)):
                return list(value)
        single = _digital_human_step_result_path(result)
        return [single] if single else []
    if isinstance(result, (list, tuple)):
        return list(result)
    return [result] if result else []


def _digital_human_step_references(payload: dict[str, Any], *, kind: str) -> list[str]:
    plural_key = f"{kind}_image_local_paths"
    singular_key = f"{kind}_image_local_path"
    raw = payload.get(plural_key)
    values = list(raw) if isinstance(raw, (list, tuple)) else []
    values.insert(0, payload.get(singular_key))
    if kind == "model":
        values.append(payload.get("secondary_image_local_path"))
    normalized: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in normalized:
            normalized.append(text)
    return normalized


def _digital_human_step_storyboard(payload: dict[str, Any]) -> list[Any]:
    value = payload.get("storyboard")
    if isinstance(value, dict):
        value = value.get("items") or value.get("segments") or []
    return list(value) if isinstance(value, (list, tuple)) else []


async def _invoke_digital_human_step_provider(provider: Callable[..., Any], **kwargs: Any) -> Any:
    try:
        signature = inspect.signature(provider)
        accepts_kwargs = any(item.kind == inspect.Parameter.VAR_KEYWORD for item in signature.parameters.values())
        call_kwargs = kwargs if accepts_kwargs else {key: value for key, value in kwargs.items() if key in signature.parameters}
    except (TypeError, ValueError):
        call_kwargs = kwargs
    result = provider(**call_kwargs)
    return await result if inspect.isawaitable(result) else result


def _persist_digital_human_step(
    dependencies: VideoRouteDependencies,
    *,
    task: dict[str, Any],
    step: str,
    input_updates: dict[str, Any],
    output_updates: dict[str, Any],
    checkpoint_updates: dict[str, Any],
    step_result: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], int]:
    if not callable(dependencies.db_factory):
        raise HTTPException(status_code=503, detail="Video task storage dependency is unavailable")
    task_id = str(task["id"])
    now = _route_now(dependencies)
    with dependencies.db_factory() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Video task not found")
        fresh = dict(row)
        if int(fresh.get("user_id") or 0) != int(task.get("user_id") or 0) or str(fresh.get("type") or "") != "create_video":
            raise HTTPException(status_code=409, detail="Digital-human task ownership changed while the step was running")
        if str(fresh.get("status") or "").strip().lower() not in {"success", "failed"}:
            raise HTTPException(status_code=409, detail="Digital-human task is no longer available for step correction")
        fresh_input = _route_json_loads(dependencies, fresh.get("input_json"), {})
        fresh_output = _route_json_loads(dependencies, fresh.get("output_json"), {})
        fresh_input = dict(fresh_input) if isinstance(fresh_input, dict) else {}
        fresh_output = dict(fresh_output) if isinstance(fresh_output, dict) else {}
        fresh_input.update(input_updates)
        fresh_input["web_session_task_id"] = task_id
        existing_fusion = fresh_output.get("digital_human_fusion_image_paths") or fresh_output.get("fusion_images")
        if not isinstance(existing_fusion, list):
            existing_raw = _output_raw_result(fresh_output)
            existing_fusion = existing_raw.get("fusion_images") if isinstance(existing_raw.get("fusion_images"), list) else []
        next_fusion = output_updates.get("digital_human_fusion_image_paths") or output_updates.get("fusion_images")
        if not isinstance(next_fusion, list):
            next_fusion = existing_fusion
        asset_history = fresh_output.get("digital_human_asset_history")
        asset_history = dict(asset_history) if isinstance(asset_history, dict) else {}
        for fusion_values in (existing_fusion, next_fusion):
            for slot, path_value in enumerate(fusion_values, start=1):
                path_text = str(path_value or "").strip()
                if not path_text:
                    continue
                key = "main" if slot == 1 else f"view_{slot}"
                rows = [dict(item) for item in asset_history.get(key, []) if isinstance(item, dict)]
                if not any(str(item.get("path") or "") == path_text for item in rows):
                    rows.insert(0, {"path": path_text, "created_at": now, "source": step})
                asset_history[key] = rows[:50]
        checkpoint = fresh_output.get("video_checkpoint")
        checkpoint = dict(checkpoint) if isinstance(checkpoint, dict) else {}
        completed_steps = checkpoint.get("digital_human_completed_steps")
        completed_steps = [str(item) for item in completed_steps] if isinstance(completed_steps, list) else []
        if step not in completed_steps:
            completed_steps.append(step)
        checkpoint.update({
            "task_type": "create_video",
            "recoverable": True,
            "stage": f"digital_human_{step}_ready",
            "digital_human_completed_steps": completed_steps,
            **checkpoint_updates,
        })
        fresh_output.update(output_updates)
        if asset_history:
            fresh_output["digital_human_asset_history"] = asset_history
        fresh_output["video_checkpoint"] = checkpoint
        step_results = fresh_output.get("digital_human_step_results")
        step_results = dict(step_results) if isinstance(step_results, dict) else {}
        step_results[step] = step_result
        fresh_output["digital_human_step_results"] = step_results
        cursor = conn.execute(
            "UPDATE tasks SET input_json = ?, output_json = ?, updated_at = ? "
            "WHERE id = ? AND user_id = ? AND type = 'create_video' AND updated_at IS ?",
            (
                _route_json_dumps(dependencies, fresh_input),
                _route_json_dumps(dependencies, fresh_output),
                now,
                task_id,
                int(task["user_id"]),
                fresh.get("updated_at"),
            ),
        )
        if int(getattr(cursor, "rowcount", 0)) != 1:
            raise HTTPException(status_code=409, detail="Task changed while the digital-human step was being saved")
    if callable(dependencies.emit_task_event):
        dependencies.emit_task_event(
            task_id=task_id,
            user_id=int(task["user_id"]),
            kind="checkpoint",
            message=f"Digital-human {step} step completed",
            data={
                "stage": f"digital_human_{step}_ready",
                "status": "success",
                "source": "video_workbench",
                "step": step,
                "user_visible": True,
            },
        )
    return fresh_input, fresh_output, now


def register_video_routes(app: Any, dependencies: VideoRouteDependencies) -> dict[str, Any]:
    """Register queue-backed /api/video routes on the existing FastAPI app."""

    existing_paths = {str(getattr(route, "path", "")) for route in getattr(getattr(app, "router", None), "routes", [])}
    registered: list[str] = []

    async def submit_impl(task_type: str, params_json: str, files: list[UploadFile], user: dict[str, Any]) -> dict[str, Any]:
        typ = str(task_type or "").strip()
        if typ not in VIDEO_MODULE_METADATA:
            raise HTTPException(status_code=404, detail="不支持的视频任务类型")
        try:
            parsed = json.loads(str(params_json or "{}").strip() or "{}")
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"params_json 不是合法 JSON: {exc.msg}") from exc
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=400, detail="params_json 必须是 JSON 对象")
        if len(files or []) > 20:
            raise HTTPException(status_code=400, detail="单任务最多上传 20 个文件")
        for upload in files or []:
            if not _upload_kind(upload.filename):
                raise HTTPException(status_code=400, detail=f"不支持的文件类型: {upload.filename or '(empty)'}")
        try:
            task_id = str(dependencies.new_task_id())
        except TypeError:
            task_id = str(dependencies.new_task_id("task"))
        username = str(dependencies.workspace_username(user))
        saved: list[dict[str, Any]] = []
        try:
            for index, upload in enumerate(files or [], start=1):
                saved_path = await _save_video_upload(
                    dependencies,
                    username=username,
                    task_id=task_id,
                    field_name=f"video_{index}",
                    upload=upload,
                )
                if saved_path:
                    saved.append({"name": str(upload.filename or ""), "path": saved_path, "kind": _upload_kind(upload.filename)})
            payload = build_video_submit_payload(typ, parsed, saved)
            payload["source"] = "video_workbench_api"
            dependencies.enqueue_task(
                task_id,
                int(dependencies.workspace_user_id(user)),
                typ,
                payload,
                user,
            )
        except Exception as exc:
            for item in reversed(saved):
                path = Path(str(item.get("path") or "")).expanduser()
                try:
                    if path.is_file():
                        path.unlink()
                    parent = path.parent
                    if parent.name == task_id and parent.is_dir() and not any(parent.iterdir()):
                        parent.rmdir()
                except OSError:
                    pass
            if isinstance(exc, (ValueError, TypeError)):
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            raise
        return {"id": task_id, "task_type": typ, "status": "queued"}

    async def modules_endpoint(user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        return {
            "module": MODULE_METADATA,
            "modules": VIDEO_UI_MODULE_METADATA,
            "runtime_defaults": {key: value for key, value in VIDEO_RUNTIME_CONFIG_DEFAULTS.items() if "api_key" not in key},
        }

    if "/api/video/modules" not in existing_paths:
        app.add_api_route("/api/video/modules", modules_endpoint, methods=["GET"], name="video_workbench_modules")
        registered.append("/api/video/modules")

    if "/api/video/prompt-preview" not in existing_paths:
        async def prompt_preview_endpoint(
            module: str = Form(""),
            params_json: str = Form("{}"),
            request_nonce: str = Form(""),
            files: list[UploadFile] | None = File(default=None),
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            nonce_source = request_nonce if isinstance(request_nonce, str) else ""
            nonce = re.sub(r"[^A-Za-z0-9._-]", "", nonce_source.strip())[:120]
            recovery_key = f"{int(dependencies.workspace_user_id(user))}:{nonce}" if nonce else ""
            if recovery_key:
                with _PROMPT_PREVIEW_RECOVERY_LOCK:
                    existing = _PROMPT_PREVIEW_RECOVERY.get(recovery_key)
                    if isinstance(existing, dict) and existing.get("status") == "complete" and isinstance(existing.get("result"), dict):
                        return dict(existing["result"])
                    _PROMPT_PREVIEW_RECOVERY[recovery_key] = {"status": "pending"}
            try:
                parsed = json.loads(str(params_json or "{}").strip() or "{}")
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"params_json 不是合法 JSON: {exc.msg}") from exc
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=400, detail="params_json 必须是 JSON 对象")
            if "_file_roles" in parsed and "file_roles" not in parsed:
                manifest = parsed.pop("_file_roles")
                if isinstance(manifest, list):
                    parsed["file_roles"] = [
                        str(item.get("field") or "") if isinstance(item, dict) else str(item or "")
                        for item in manifest
                    ]
            task_type, normalized = resolve_video_ui_task(module, parsed)
            generated: dict[str, Any] = {}
            if callable(dependencies.generate_prompt_preview):
                try:
                    uploads = files if isinstance(files, list) else []
                    image_uploads = [item for item in uploads if _upload_kind(item.filename) == "image"]
                    if len(image_uploads) > 8:
                        raise HTTPException(status_code=400, detail="Prompt preview accepts at most 8 images")
                    max_bytes = int(dependencies.max_upload_bytes or 20 * 1024 * 1024)
                    with tempfile.TemporaryDirectory(prefix="video-prompt-preview-") as tmpdir:
                        image_paths: list[str] = []
                        for index, upload in enumerate(image_uploads, start=1):
                            suffix = Path(str(upload.filename or "image.png")).suffix.lower() or ".png"
                            target = Path(tmpdir) / f"image_{index}{suffix}"
                            total = 0
                            with target.open("wb") as handle:
                                while True:
                                    chunk = await upload.read(1024 * 1024)
                                    if not chunk:
                                        break
                                    total += len(chunk)
                                    if total > max_bytes:
                                        raise HTTPException(status_code=413, detail=f"Prompt preview image is too large: {upload.filename or index}")
                                    handle.write(chunk)
                            if total:
                                image_paths.append(str(target.resolve()))
                        candidate = await _invoke_digital_human_step_provider(
                            dependencies.generate_prompt_preview,
                            module=str(module or ""),
                            task_type=task_type,
                            parameters=dict(normalized),
                            image_paths=image_paths,
                            user=user,
                        )
                    if isinstance(candidate, dict):
                        generated = candidate
                except HTTPException:
                    raise
                except Exception as exc:
                    if recovery_key:
                        with _PROMPT_PREVIEW_RECOVERY_LOCK:
                            _PROMPT_PREVIEW_RECOVERY[recovery_key] = {"status": "failed", "detail": str(exc)}
                    raise HTTPException(status_code=503, detail=f"Prompt preview generation failed: {exc}") from exc
            speech_text = str(
                generated.get("speech_text")
                or generated.get("script")
                or normalized.get("speech_text")
                or normalized.get("script")
                or ""
            ).strip()
            prompt_text = str(
                generated.get("prompt_text")
                or generated.get("prompt")
                or normalized.get("prompt_text")
                or normalized.get("prompt")
                or normalized.get("message")
                or ""
            ).strip()
            response_payload = {
                "module": module,
                "task_type": task_type,
                "speech_text": speech_text,
                "prompt_text": prompt_text,
                "storyboard": generated.get("storyboard") if isinstance(generated.get("storyboard"), (dict, list)) else None,
                "speech_candidates": generated.get("speech_candidates") if isinstance(generated.get("speech_candidates"), list) else [],
                "selected_speech_candidate_index": int(generated.get("selected_speech_candidate_index") or 0),
                "ecommerce_material_analysis": generated.get("ecommerce_material_analysis") if isinstance(generated.get("ecommerce_material_analysis"), dict) else {},
                "ecommerce_product_web_research": generated.get("ecommerce_product_web_research") if isinstance(generated.get("ecommerce_product_web_research"), dict) else {},
                "ecommerce_effective_selected_indexes": generated.get("ecommerce_effective_selected_indexes") if isinstance(generated.get("ecommerce_effective_selected_indexes"), list) else [],
                "ecommerce_effective_ignored_indexes": generated.get("ecommerce_effective_ignored_indexes") if isinstance(generated.get("ecommerce_effective_ignored_indexes"), list) else [],
                "ecommerce_effective_reference_order": generated.get("ecommerce_effective_reference_order") if isinstance(generated.get("ecommerce_effective_reference_order"), list) else [],
                "ecommerce_creative_brief": generated.get("ecommerce_creative_brief") if isinstance(generated.get("ecommerce_creative_brief"), dict) else {},
                "ecommerce_segments": generated.get("ecommerce_segments") if isinstance(generated.get("ecommerce_segments"), list) else [],
                "generated": bool(generated),
                "parameters": {key: value for key, value in normalized.items() if not str(key).startswith("_") and key != "file_roles"},
                "requires_confirmation": True,
            }
            if recovery_key:
                with _PROMPT_PREVIEW_RECOVERY_LOCK:
                    _PROMPT_PREVIEW_RECOVERY[recovery_key] = {"status": "complete", "result": dict(response_payload)}
                    while len(_PROMPT_PREVIEW_RECOVERY) > 200:
                        _PROMPT_PREVIEW_RECOVERY.pop(next(iter(_PROMPT_PREVIEW_RECOVERY)), None)
            return response_payload

        app.add_api_route("/api/video/prompt-preview", prompt_preview_endpoint, methods=["POST"], name="video_workbench_prompt_preview")
        registered.append("/api/video/prompt-preview")

    if "/api/video/prompt-preview/recover" not in existing_paths:
        async def prompt_preview_recover_endpoint(
            request_nonce: str,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            nonce = re.sub(r"[^A-Za-z0-9._-]", "", str(request_nonce or "").strip())[:120]
            if not nonce:
                raise HTTPException(status_code=400, detail="request_nonce is required")
            key = f"{int(dependencies.workspace_user_id(user))}:{nonce}"
            with _PROMPT_PREVIEW_RECOVERY_LOCK:
                item = dict(_PROMPT_PREVIEW_RECOVERY.get(key) or {})
            if not item:
                raise HTTPException(status_code=404, detail="Prompt preview recovery record not found")
            if item.get("status") == "complete" and isinstance(item.get("result"), dict):
                return dict(item["result"])
            if item.get("status") == "failed":
                raise HTTPException(status_code=503, detail=str(item.get("detail") or "Prompt preview failed"))
            return {"status": "pending", "request_nonce": nonce}

        app.add_api_route(
            "/api/video/prompt-preview/recover",
            prompt_preview_recover_endpoint,
            methods=["GET"],
            name="video_workbench_prompt_preview_recover",
        )
        registered.append("/api/video/prompt-preview/recover")

    digital_human_step_paths = (
        "/api/tasks/create_video/step",
        "/api/video/create-video/step",
    )
    if any(path not in existing_paths for path in digital_human_step_paths):
        async def digital_human_step_endpoint(
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            if not isinstance(payload, dict):
                raise HTTPException(status_code=400, detail="Digital-human step payload must be an object")
            step = str(payload.get("step") or "").strip().lower()
            if step not in _DIGITAL_HUMAN_STEP_NAMES:
                raise HTTPException(status_code=400, detail="Unsupported digital-human step")
            raw_params = payload.get("params", {})
            if not isinstance(raw_params, dict):
                raise HTTPException(status_code=400, detail="Digital-human step params must be an object")
            params = dict(raw_params)
            task_id = _digital_human_step_task_id(payload, params)
            params.pop("web_session_task_id", None)
            params.pop("source_task_id", None)
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "create_video":
                raise HTTPException(status_code=400, detail="Digital-human steps require a create_video task")
            _require_task_status(task, {"success", "failed"}, "digital-human step correction")
            known_paths = _known_task_paths(input_payload, output_payload)
            try:
                _validate_metadata_paths(params, known_paths)
                _json_size_guard(params, limit=128 * 1024)
            except (TypeError, ValueError, OverflowError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            checkpoint = output_payload.get("video_checkpoint")
            checkpoint = dict(checkpoint) if isinstance(checkpoint, dict) else {}
            effective = dict(input_payload)
            for key in (
                "speech_text",
                "segment_scripts",
                "digital_human_main_image_local_path",
                "digital_human_fusion_image_paths",
            ):
                if key not in effective and checkpoint.get(key) not in (None, "", []):
                    effective[key] = checkpoint[key]
            effective.update(params)
            effective["source"] = "video_workbench_api"
            if callable(dependencies.enrich_video_payload):
                enriched = dependencies.enrich_video_payload("create_video", task_id, effective)
                if isinstance(enriched, dict):
                    effective = enriched
            workdir = _digital_human_step_workdir(task_id, effective)
            context = VideoTaskContext(
                task_id=task_id,
                task_type="create_video",
                cancel_event=_resolve_cancel_event(task_id, effective),
            )
            speech_text_for_images = str(effective.get("speech_text") or effective.get("message") or "").strip()
            storyboard_for_images = _digital_human_step_storyboard(effective)
            model_references = _digital_human_step_references(effective, kind="model")
            product_references = _digital_human_step_references(effective, kind="product")
            step_billing: dict[str, Any] | None = None
            step_billing_actual_quantity = 0

            def reserve_step_images(quantity: int) -> None:
                nonlocal step_billing
                if not callable(dependencies.reserve_video_step_charge):
                    return
                reserved = dependencies.reserve_video_step_charge(
                    user=user,
                    task_id=task_id,
                    step=step,
                    sku="subject_generate_image",
                    quantity=max(int(quantity or 0), 1),
                    image=True,
                )
                step_billing = dict(reserved) if isinstance(reserved, dict) else {}

            def settle_step_images() -> dict[str, Any] | None:
                if step_billing is None or not callable(dependencies.settle_video_step_charge):
                    return None
                settled = dependencies.settle_video_step_charge(
                    reservation=step_billing,
                    actual_quantity=max(int(step_billing_actual_quantity or 0), 0),
                )
                return dict(settled) if isinstance(settled, dict) else None

            def release_step_images() -> None:
                if step_billing is None or not callable(dependencies.release_video_step_charge):
                    return
                try:
                    dependencies.release_video_step_charge(reservation=step_billing)
                except Exception:
                    pass
            try:
                context.check_cancelled()
                input_updates: dict[str, Any] = {}
                output_updates: dict[str, Any] = {}
                checkpoint_updates: dict[str, Any] = {}
                response: dict[str, Any] = {"ok": True, "task_id": task_id, "step": step}

                if step == "script":
                    speech_text = str(effective.get("speech_text") or effective.get("message") or "").strip()
                    segment_scripts = effective.get("segment_scripts")
                    segment_scripts = [str(item).strip() for item in segment_scripts if str(item).strip()] if isinstance(segment_scripts, list) else []
                    ai_copy: dict[str, Any] = {}
                    speech_candidates: list[dict[str, Any]] = []
                    selected_speech_candidate_index = 0
                    if not speech_text:
                        provider = effective.get("_digital_human_ai_copy_provider")
                        if not callable(provider):
                            raise HTTPException(status_code=503, detail="Digital-human AI copy provider is unavailable")
                        generated = await _invoke_digital_human_step_provider(
                            provider,
                            payload=effective,
                            mode=str(effective.get("digital_human_short_mode") or "single"),
                            dual_presenter=bool(effective.get("dual_presenter")),
                            storyboard=effective.get("storyboard") if isinstance(effective.get("storyboard"), list) else [],
                            context=context,
                            task_id=task_id,
                        )
                        generated = generated if isinstance(generated, dict) else {"speech_text": generated}
                        speech_text = str(generated.get("speech_text") or generated.get("script") or "").strip()
                        raw_segments = generated.get("segment_scripts")
                        if isinstance(raw_segments, list):
                            segment_scripts = [str(item).strip() for item in raw_segments if str(item).strip()]
                        speech_candidates, selected_speech_candidate_index = _normalize_digital_human_oral_script_candidates(
                            {"speech_candidates": generated.get("speech_candidates"), "selected_index": int(generated.get("selected_speech_candidate_index") or 0) + 1},
                            fallback_text=speech_text,
                        )
                        metadata = generated.get("metadata") or generated.get("ai_copy")
                        ai_copy = _digital_human_step_public_value(metadata) if isinstance(metadata, dict) else {}
                    if not speech_text:
                        raise ValueError("Digital-human script step produced no speech text")
                    input_updates = {"speech_text": speech_text, "message": speech_text}
                    output_updates = {"speech_text": speech_text}
                    checkpoint_updates = {"speech_text": speech_text}
                    if segment_scripts:
                        input_updates["segment_scripts"] = segment_scripts
                        output_updates["segment_scripts"] = segment_scripts
                        checkpoint_updates["segment_scripts"] = segment_scripts
                    if ai_copy:
                        output_updates["ai_copy"] = ai_copy
                    if speech_candidates:
                        input_updates["speech_candidates"] = speech_candidates
                        input_updates["selected_speech_candidate_index"] = selected_speech_candidate_index
                        output_updates["speech_candidates"] = speech_candidates
                        output_updates["selected_speech_candidate_index"] = selected_speech_candidate_index
                        checkpoint_updates["speech_candidates"] = speech_candidates
                        checkpoint_updates["selected_speech_candidate_index"] = selected_speech_candidate_index
                    response.update({
                        "speech_text": speech_text,
                        "segment_scripts": segment_scripts,
                        "speech_candidates": speech_candidates,
                        "selected_speech_candidate_index": selected_speech_candidate_index,
                        "ai_copy": ai_copy,
                    })

                elif step == "fusion_main":
                    if not str(effective.get("speech_text") or effective.get("message") or "").strip():
                        raise HTTPException(status_code=409, detail="Confirm the digital-human script before generating the main image")
                    provider = getattr(DEFAULT_SOURCE_BACKEND, "generate_digital_human_fusion_main", None)
                    if not callable(provider):
                        raise HTTPException(status_code=503, detail="Digital-human fusion-main provider is unavailable")
                    reserve_step_images(1)
                    generated = await _invoke_digital_human_step_provider(
                        provider,
                        task_id=task_id,
                        payload=effective,
                        context=context,
                        workdir=workdir,
                        speech_text=speech_text_for_images,
                        storyboard=storyboard_for_images,
                        model_references=model_references,
                        product_references=product_references,
                    )
                    try:
                        main_path = _digital_human_step_image_path(
                            _digital_human_step_result_path(generated), known_paths=known_paths, workdir=workdir
                        )
                    except ValueError as exc:
                        raise HTTPException(status_code=502, detail=str(exc)) from exc
                    input_updates = {
                        "digital_human_main_image_local_path": main_path,
                        "digital_human_fusion_image_paths": [main_path],
                    }
                    step_raw = _output_raw_result(output_payload)
                    step_raw.update({"digital_human_stage": "visual_review", "fusion_images": [main_path]})
                    output_updates = {
                        "digital_human_main_image_local_path": main_path,
                        "digital_human_fusion_image_paths": [main_path],
                        "fusion_images": [main_path],
                        "image_path": main_path,
                        "image_paths": [main_path],
                        "download_path": main_path,
                        "raw_result": step_raw,
                    }
                    checkpoint_updates = {
                        "digital_human_main_image_local_path": main_path,
                        "fusion_images": [main_path],
                    }
                    step_billing_actual_quantity = 1
                    response["image_path"] = main_path

                elif step == "fusion_views":
                    main_value = effective.get("digital_human_main_image_local_path")
                    try:
                        main_path = _digital_human_step_image_path(main_value, known_paths=known_paths, workdir=workdir)
                    except ValueError as exc:
                        raise HTTPException(status_code=409, detail="Confirm a valid fusion main image before generating views") from exc
                    provider = getattr(DEFAULT_SOURCE_BACKEND, "generate_digital_human_consistency_views", None)
                    if not callable(provider):
                        raise HTTPException(status_code=503, detail="Digital-human consistency-view provider is unavailable")
                    requested_view_count = min(
                        max(int(effective.get("digital_human_fusion_count") or 4) - 1, 1),
                        3,
                    )
                    reserve_step_images(requested_view_count)
                    generated = await _invoke_digital_human_step_provider(
                        provider,
                        task_id=task_id,
                        payload=effective,
                        main_image_path=main_path,
                        speech_text=speech_text_for_images,
                        storyboard=storyboard_for_images,
                        mode=str(effective.get("digital_human_short_mode") or "single"),
                        model_references=model_references,
                        existing_fusion_images=(
                            list(effective.get("digital_human_fusion_image_paths"))
                            if isinstance(effective.get("digital_human_fusion_image_paths"), list)
                            else []
                        ),
                        context=context,
                        workdir=workdir,
                    )
                    try:
                        image_paths = [
                            _digital_human_step_image_path(item, known_paths=known_paths, workdir=workdir)
                            for item in _digital_human_step_result_paths(generated)
                        ]
                    except ValueError as exc:
                        raise HTTPException(status_code=502, detail=str(exc)) from exc
                    if not image_paths:
                        raise HTTPException(status_code=502, detail="Digital-human consistency-view provider returned no images")
                    step_billing_actual_quantity = len(image_paths)
                    image_paths = [main_path, *[item for item in image_paths if Path(item).resolve() != Path(main_path).resolve()]]
                    input_updates = {"digital_human_fusion_image_paths": image_paths}
                    step_raw = _output_raw_result(output_payload)
                    step_raw.update({"digital_human_stage": "visual_review", "fusion_images": image_paths})
                    output_updates = {
                        "digital_human_fusion_image_paths": image_paths,
                        "fusion_images": image_paths,
                        "image_path": image_paths[0],
                        "image_paths": image_paths,
                        "download_path": image_paths[0],
                        "raw_result": step_raw,
                    }
                    checkpoint_updates = {"fusion_images": image_paths}
                    response["image_paths"] = image_paths

                else:
                    main_value = effective.get("digital_human_main_image_local_path")
                    try:
                        main_path = _digital_human_step_image_path(main_value, known_paths=known_paths, workdir=workdir)
                    except ValueError as exc:
                        raise HTTPException(status_code=409, detail="Confirm a valid fusion main image before regenerating a view") from exc
                    existing = effective.get("digital_human_fusion_image_paths")
                    existing = [str(item or "").strip() for item in existing] if isinstance(existing, list) else []
                    if not existing or Path(existing[0]).expanduser().resolve(strict=False) != Path(main_path).resolve(strict=False):
                        existing.insert(0, main_path)
                    try:
                        view_index = int(effective.get("digital_human_regenerate_view_index"))
                    except (TypeError, ValueError) as exc:
                        raise HTTPException(status_code=400, detail="digital_human_regenerate_view_index must be an integer") from exc
                    if view_index < 2 or view_index > len(existing):
                        raise HTTPException(
                            status_code=400,
                            detail=f"digital_human_regenerate_view_index must be between 2 and {len(existing)}",
                        )
                    for current in existing:
                        try:
                            _digital_human_step_image_path(current, known_paths=known_paths, workdir=workdir)
                        except ValueError as exc:
                            raise HTTPException(status_code=409, detail="Stored digital-human view media is invalid") from exc
                    provider = getattr(DEFAULT_SOURCE_BACKEND, "generate_digital_human_single_consistency_view", None)
                    if not callable(provider):
                        raise HTTPException(status_code=503, detail="Digital-human single-view provider is unavailable")
                    reserve_step_images(1)
                    generated = await _invoke_digital_human_step_provider(
                        provider,
                        task_id=task_id,
                        payload=effective,
                        main_image_path=main_path,
                        view_index=view_index,
                        speech_text=speech_text_for_images,
                        storyboard=storyboard_for_images,
                        model_references=model_references,
                        context=context,
                        workdir=workdir,
                    )
                    try:
                        image_path = _digital_human_step_image_path(
                            _digital_human_step_result_path(generated), known_paths=known_paths, workdir=workdir
                        )
                    except ValueError as exc:
                        raise HTTPException(status_code=502, detail=str(exc)) from exc
                    updated_views = list(existing)
                    updated_views[view_index - 1] = image_path
                    input_updates = {
                        "digital_human_fusion_image_paths": updated_views,
                        "digital_human_regenerate_view_index": view_index,
                    }
                    output_updates = {
                        "digital_human_fusion_image_paths": updated_views,
                        "fusion_images": updated_views,
                        "digital_human_latest_view_image_path": image_path,
                        "image_path": updated_views[0],
                        "image_paths": updated_views,
                        "download_path": updated_views[0],
                    }
                    step_raw = _output_raw_result(output_payload)
                    step_raw.update({"digital_human_stage": "visual_review", "fusion_images": updated_views})
                    output_updates["raw_result"] = step_raw
                    checkpoint_updates = {"fusion_images": updated_views}
                    step_billing_actual_quantity = 1
                    response.update({"image_path": image_path, "image_paths": updated_views, "view_index": view_index})

                context.check_cancelled()
                public_result = _digital_human_step_public_value(response)
                saved_input, _saved_output, _saved_at = _persist_digital_human_step(
                    dependencies,
                    task=task,
                    step=step,
                    input_updates=input_updates,
                    output_updates=output_updates,
                    checkpoint_updates=checkpoint_updates,
                    step_result=public_result,
                )
                response["params"] = _digital_human_step_public_value(saved_input)
                response["session_task_id"] = task_id
                billing_result = settle_step_images()
                if billing_result is not None:
                    response["billing"] = _digital_human_step_public_value(billing_result)
                return response
            except VideoTaskCancelled as exc:
                release_step_images()
                raise HTTPException(status_code=409, detail="Digital-human step was cancelled") from exc
            except HTTPException:
                release_step_images()
                raise
            except (TypeError, ValueError, OverflowError) as exc:
                release_step_images()
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                release_step_images()
                message = str(exc).strip()[-600:] or "unknown error"
                raise HTTPException(status_code=502, detail=f"Digital-human {step} step failed: {message}") from exc

        for path in digital_human_step_paths:
            if path in existing_paths:
                continue
            app.add_api_route(
                path,
                digital_human_step_endpoint,
                methods=["POST"],
                name="video_workbench_digital_human_step_legacy" if path.startswith("/api/tasks/") else "video_workbench_digital_human_step",
            )
            registered.append(path)

    if "/api/video/voice-presets" not in existing_paths:
        async def voice_presets_endpoint(user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
            items: list[dict[str, Any]] = []
            for language, presets in ELEVENLABS_VOICE_PRESETS.items():
                for preset in presets:
                    if not isinstance(preset, dict):
                        continue
                    preview_asset = str(preset.get("preview_asset") or "").strip().lstrip("/")
                    items.append({
                        "id": str(preset.get("key") or preset.get("voice_id") or ""),
                        "preset_id": str(preset.get("key") or ""),
                        "label": str(preset.get("label") or preset.get("button") or preset.get("voice_name") or ""),
                        "language": language,
                        "voice_id": str(preset.get("voice_id") or ""),
                        "voice_name": str(preset.get("voice_name") or ""),
                        "gender": str(preset.get("gender") or ""),
                        "preview_url": f"/assets/{preview_asset}" if preview_asset else str(preset.get("preview_url") or ""),
                    })
            return {
                "items": items,
                "bundled_assets": "/assets/voice_presets/",
            }

        app.add_api_route("/api/video/voice-presets", voice_presets_endpoint, methods=["GET"], name="video_workbench_voice_presets")
        registered.append("/api/video/voice-presets")

    if "/api/video/voice-preview" not in existing_paths:
        async def voice_preview_endpoint(
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            return _voice_preview_for_payload(payload)

        app.add_api_route("/api/video/voice-preview", voice_preview_endpoint, methods=["POST"], name="video_workbench_voice_preview")
        registered.append("/api/video/voice-preview")

    task_storyboard_path = "/api/video/tasks/{task_id}/storyboard"
    if task_storyboard_path not in existing_paths:
        async def storyboard_get_endpoint(
            task_id: str,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            try:
                storyboard = _normalize_storyboard(
                    _storyboard_candidate(input_payload, output_payload),
                    known_paths=_known_task_paths(input_payload, output_payload),
                    allow_empty=True,
                )
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=422, detail=f"Stored storyboard is invalid: {exc}") from exc
            return {
                "task_id": str(task["id"]),
                "task_type": str(task["type"]),
                "status": str(task.get("status") or ""),
                "revision": int(_workbench_meta(input_payload).get("revision") or 0),
                "storyboard": storyboard,
            }

        async def storyboard_put_endpoint(
            task_id: str,
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            _require_task_status(task, _VIDEO_TERMINAL_STATUSES, "storyboard editing")
            try:
                storyboard = _normalize_storyboard(
                    payload.get("storyboard", payload),
                    known_paths=_known_task_paths(input_payload, output_payload),
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            revision = _persist_workbench_section(
                dependencies,
                task=task,
                input_payload=input_payload,
                section="storyboard",
                value=storyboard,
            )
            return {"ok": True, "task_id": str(task["id"]), "revision": revision, "storyboard": storyboard}

        app.add_api_route(task_storyboard_path, storyboard_get_endpoint, methods=["GET"], name="video_workbench_storyboard_get")
        app.add_api_route(task_storyboard_path, storyboard_put_endpoint, methods=["PUT"], name="video_workbench_storyboard_put")
        registered.append(task_storyboard_path)

    storyboard_regenerate_path = "/api/video/tasks/{task_id}/storyboard/regenerate"
    if storyboard_regenerate_path not in existing_paths:
        async def storyboard_regenerate_endpoint(
            task_id: str,
            payload: dict[str, Any] | None = None,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            _require_task_status(task, _VIDEO_TERMINAL_STATUSES, "storyboard regeneration")
            try:
                source = (payload or {}).get("storyboard") if isinstance(payload, dict) else None
                storyboard = _normalize_storyboard(
                    source if source is not None else _storyboard_candidate(input_payload, output_payload),
                    known_paths=_known_task_paths(input_payload, output_payload),
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            prompts = [_storyboard_item_text(item) for item in storyboard["items"]]
            combined_prompt = "\n".join(prompts)
            return _enqueue_video_child(
                dependencies,
                user=user,
                source_task=task,
                input_payload=input_payload,
                action="storyboard_regenerate",
                extra={
                    "storyboard": storyboard,
                    "prompt_segments": prompts,
                    "prompt": combined_prompt,
                    "prompt_text": combined_prompt,
                    "force_regenerate": True,
                },
            )

        app.add_api_route(
            storyboard_regenerate_path,
            storyboard_regenerate_endpoint,
            methods=["POST"],
            name="video_workbench_storyboard_regenerate",
        )
        registered.append(storyboard_regenerate_path)

    task_subtitles_path = "/api/video/tasks/{task_id}/subtitles"
    if task_subtitles_path not in existing_paths:
        async def subtitles_get_endpoint(
            task_id: str,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            try:
                subtitles = _normalize_subtitles(
                    _subtitles_candidate(input_payload, output_payload),
                    known_paths=_known_task_paths(input_payload, output_payload),
                )
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=422, detail=f"Stored subtitles are invalid: {exc}") from exc
            return {
                "task_id": str(task["id"]),
                "task_type": str(task["type"]),
                "status": str(task.get("status") or ""),
                "revision": int(_workbench_meta(input_payload).get("revision") or 0),
                "subtitles": subtitles,
            }

        async def subtitles_put_endpoint(
            task_id: str,
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            _require_task_status(task, _VIDEO_TERMINAL_STATUSES, "subtitle editing")
            try:
                subtitles = _normalize_subtitles(
                    payload.get("subtitles", payload),
                    known_paths=_known_task_paths(input_payload, output_payload),
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            revision = _persist_workbench_section(
                dependencies,
                task=task,
                input_payload=input_payload,
                section="subtitles",
                value=subtitles,
            )
            return {"ok": True, "task_id": str(task["id"]), "revision": revision, "subtitles": subtitles}

        app.add_api_route(task_subtitles_path, subtitles_get_endpoint, methods=["GET"], name="video_workbench_subtitles_get")
        app.add_api_route(task_subtitles_path, subtitles_put_endpoint, methods=["PUT"], name="video_workbench_subtitles_put")
        registered.append(task_subtitles_path)

    task_subtitles_post_path = "/api/tasks/{task_id}/subtitles"
    if task_subtitles_post_path not in existing_paths:
        def subtitles_post_endpoint(
            task_id: str,
            body: dict[str, Any] | None = None,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            tid = _require_video_task_id(task_id)
            lock = _SUBTITLE_RENDER_LOCKS[hash(tid) % len(_SUBTITLE_RENDER_LOCKS)]
            with lock:
                task, input_payload, output_payload = _load_owned_video_task(dependencies, user, tid)
                _require_task_status(task, {"success"}, "subtitle rendering")
                source = _subtitle_source_path(input_payload, output_payload)
                template = _subtitle_template_key(
                    (body or {}).get("subtitle_template")
                    or input_payload.get("subtitle_template")
                    or output_payload.get("subtitle_template")
                )
                cues = _subtitle_cues_for_task(
                    source=source,
                    input_payload=input_payload,
                    output_payload=output_payload,
                )
                workdir = (source.parent / "video_subtitles" / tid).resolve()
                workdir.mkdir(parents=True, exist_ok=True)
                cancel_event = _resolve_cancel_event(tid, {})
                context = VideoTaskContext(
                    task_id=tid,
                    task_type=str(task.get("type") or "create_video"),
                    cancel_event=cancel_event,
                )
                render_payload = dict(input_payload)
                render_payload["subtitle_template"] = template
                render_payload["subtitles"] = {"enabled": True, "template": template, "items": cues}
                try:
                    rendered_path, cue_count = DEFAULT_SOURCE_BACKEND._burn_subtitles_if_requested(
                        video_path=source,
                        payload=render_payload,
                        context=context,
                        workdir=workdir,
                    )
                    context.check_cancelled()
                except VideoTaskCancelled as exc:
                    raise HTTPException(status_code=409, detail="Subtitle rendering was cancelled") from exc
                except HTTPException:
                    raise
                except Exception as exc:
                    message = str(exc).strip()[-600:] or "unknown error"
                    raise HTTPException(status_code=500, detail=f"Subtitle rendering failed: {message}") from exc

                rendered = Path(rendered_path).expanduser().resolve()
                subtitle_path = (workdir / f"{source.stem}.srt").resolve()
                if (
                    int(cue_count or 0) <= 0
                    or not rendered.is_file()
                    or rendered.suffix.lower() not in _VIDEO_OUTPUT_SUFFIXES
                    or rendered.parent != workdir
                    or not subtitle_path.is_file()
                    or subtitle_path.parent != workdir
                ):
                    raise HTTPException(status_code=500, detail="Subtitle renderer did not produce valid task media")

                updated_output = dict(output_payload)
                updated_output.setdefault("original_download_path", str(source))
                updated_output.setdefault("original_video_path", str(source))
                updated_output["download_path"] = str(rendered)
                updated_output["video_path"] = str(rendered)
                updated_output["subtitle_path"] = str(subtitle_path)
                updated_output["subtitled"] = True
                updated_output["subtitles_applied"] = True
                updated_output["subtitle_template"] = template
                updated_output["subtitle_cue_count"] = int(cue_count)

                if not callable(dependencies.db_factory):
                    raise HTTPException(status_code=503, detail="Video task storage dependency is unavailable")
                now = _route_now(dependencies)
                with dependencies.db_factory() as conn:
                    cursor = conn.execute(
                        "UPDATE tasks SET output_json = ?, updated_at = ? WHERE id = ? AND status = 'success' AND updated_at IS ?",
                        (
                            _route_json_dumps(dependencies, updated_output),
                            now,
                            tid,
                            task.get("updated_at"),
                        ),
                    )
                    if int(getattr(cursor, "rowcount", 0)) != 1:
                        raise HTTPException(status_code=409, detail="Task changed while subtitles were being rendered")
                    fresh_row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
                if callable(dependencies.emit_task_event):
                    dependencies.emit_task_event(
                        task_id=tid,
                        user_id=int(task["user_id"]),
                        kind="done",
                        message="Subtitles added",
                        data={
                            "stage": "subtitle",
                            "status": "success",
                            "source": "video_workbench",
                            "has_download": True,
                            "subtitle_path": str(subtitle_path),
                            "download_path": str(rendered),
                            "user_visible": True,
                        },
                    )
                fresh = dict(fresh_row) if fresh_row is not None else {**task, "output_json": _route_json_dumps(dependencies, updated_output), "updated_at": now}
                if callable(dependencies.build_task_detail):
                    return dependencies.build_task_detail(task=fresh, include_logs=True)
                return {
                    "id": tid,
                    "type": str(fresh.get("type") or ""),
                    "status": str(fresh.get("status") or ""),
                    "output": updated_output,
                    "has_download": True,
                }

        app.add_api_route(
            task_subtitles_post_path,
            subtitles_post_endpoint,
            methods=["POST"],
            name="video_workbench_task_add_subtitles",
        )
        registered.append(task_subtitles_post_path)

    segment_regenerate_path = "/api/video/tasks/{task_id}/segments/{segment_index}/regenerate"
    if segment_regenerate_path not in existing_paths:
        async def segment_regenerate_endpoint(
            task_id: str,
            segment_index: int,
            payload: dict[str, Any] | None = None,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            _require_task_status(task, _VIDEO_TERMINAL_STATUSES, "segment regeneration")
            if str(task.get("type") or "").strip() == "video_language_replace":
                segments = _video_language_timed_segments(input_payload, output_payload)
                if not segments:
                    raise HTTPException(status_code=409, detail="Task has no reusable timed language segments")
                if isinstance(segment_index, bool) or segment_index < 1 or segment_index > len(segments):
                    raise HTTPException(status_code=400, detail=f"segment_index must be between 1 and {len(segments)}")
                raw = _output_raw_result(output_payload)
                reusable = raw.get("timed_audio_segments")
                reusable = [dict(item) for item in reusable if isinstance(item, dict)] if isinstance(reusable, list) else []
                return _enqueue_video_child(
                    dependencies,
                    user=user,
                    source_task=task,
                    input_payload=input_payload,
                    action="segment_regenerate",
                    extra={
                        "script_segments": segments,
                        "source_segments": segments,
                        "target_script": "\n".join(item["text"] for item in segments),
                        "regenerate_segment_index": int(segment_index),
                        "_video_language_reuse_segments": reusable,
                        "force_regenerate": True,
                    },
                )
            try:
                storyboard = _normalize_storyboard(
                    _storyboard_candidate(input_payload, output_payload),
                    known_paths=_known_task_paths(input_payload, output_payload),
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise HTTPException(status_code=409, detail=f"Task has no usable storyboard: {exc}") from exc
            if isinstance(segment_index, bool) or segment_index < 1 or segment_index > len(storyboard["items"]):
                raise HTTPException(status_code=400, detail=f"segment_index must be between 1 and {len(storyboard['items'])}")
            selected_segment = dict(storyboard["items"][segment_index - 1])
            segment_text = _storyboard_item_text(selected_segment)
            overrides = dict(payload or {})
            if overrides:
                try:
                    _validate_metadata_paths(overrides, _known_task_paths(input_payload, output_payload))
                    _json_size_guard(overrides, limit=64 * 1024)
                except (TypeError, ValueError) as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
            return _enqueue_video_child(
                dependencies,
                user=user,
                source_task=task,
                input_payload=input_payload,
                action="segment_regenerate",
                extra={
                    "storyboard": storyboard,
                    "segment_index": int(segment_index),
                    "regenerate_segment_index": int(segment_index),
                    "segment": selected_segment,
                    "segment_overrides": overrides,
                    "prompt": segment_text,
                    "prompt_text": segment_text,
                    "speech_text": segment_text,
                    "script": segment_text,
                    "target_script": segment_text,
                    "force_regenerate": True,
                    "resume_checkpoint": (
                        dict(output_payload.get("video_checkpoint"))
                        if isinstance(output_payload.get("video_checkpoint"), dict)
                        else {}
                    ),
                    "completed_segments": (
                        list(output_payload.get("completed_segments"))
                        if isinstance(output_payload.get("completed_segments"), list)
                        else []
                    ),
                    **_video_continuation_fields(task.get("type"), output_payload),
                },
            )

        app.add_api_route(
            segment_regenerate_path,
            segment_regenerate_endpoint,
            methods=["POST"],
            name="video_workbench_segment_regenerate",
        )
        registered.append(segment_regenerate_path)

    digital_human_finalize_path = "/api/video/tasks/{task_id}/digital-human/finalize"
    if digital_human_finalize_path not in existing_paths:
        async def digital_human_finalize_endpoint(
            task_id: str,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "create_video":
                raise HTTPException(status_code=400, detail="Only digital-human tasks can be finalized")
            _require_task_status(task, {"success"}, "digital-human finalization")
            raw = _output_raw_result(output_payload)
            if str(raw.get("digital_human_stage") or "").strip() != "visual_review":
                raise HTTPException(status_code=409, detail="Task is not awaiting digital-human visual confirmation")
            fusion_images = output_payload.get("fusion_images") or raw.get("fusion_images")
            if not isinstance(fusion_images, list) or not fusion_images:
                raise HTTPException(status_code=409, detail="Task has no confirmed digital-human visual references")
            mode = str(input_payload.get("digital_human_short_mode") or "single").strip().lower()
            requested_count = input_payload.get("digital_human_fusion_count")
            try:
                expected_count = int(requested_count or (4 if mode == "storyboard" else 1))
            except (TypeError, ValueError):
                expected_count = 4 if mode == "storyboard" else 1
            expected_count = min(max(expected_count, 1), 4)
            if len(fusion_images) < expected_count:
                raise HTTPException(
                    status_code=409,
                    detail=f"Confirm all digital-human views before finalization ({len(fusion_images)}/{expected_count})",
                )
            known_paths = _known_task_paths(input_payload, output_payload)
            try:
                _validate_metadata_paths({"digital_human_fusion_image_paths": fusion_images}, known_paths)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            extra: dict[str, Any] = {
                "digital_human_operation": "final_video",
                "digital_human_fusion_image_paths": list(fusion_images),
                "digital_human_main_image_local_path": str(fusion_images[0]),
                "web_prompt_confirmed": True,
                "web_visuals_confirmed": True,
            }
            for key in ("speech_text", "segment_scripts", "prompt_text", "view_sequence"):
                value = output_payload.get(key)
                if value not in (None, "", []):
                    extra[key] = value
            return _enqueue_video_child(
                dependencies,
                user=user,
                source_task=task,
                input_payload=input_payload,
                action="digital_human_finalize",
                extra=extra,
            )

        app.add_api_route(
            digital_human_finalize_path,
            digital_human_finalize_endpoint,
            methods=["POST"],
            name="video_workbench_digital_human_finalize",
        )
        registered.append(digital_human_finalize_path)

    seeding_finalize_path = "/api/video/tasks/{task_id}/seeding/finalize"
    if seeding_finalize_path not in existing_paths:
        async def seeding_finalize_endpoint(
            task_id: str,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "ecommerce_short_video":
                raise HTTPException(status_code=400, detail="Only ecommerce seeding tasks can be finalized")
            _require_task_status(task, {"success"}, "ecommerce seeding finalization")
            raw = _output_raw_result(output_payload)
            if str(raw.get("seeding_stage") or "").strip() != "images_only":
                raise HTTPException(status_code=409, detail="Task is not awaiting ecommerce seeding image confirmation")
            if input_payload.get("ecommerce_seeding_regenerate_scene_index") not in (None, "", 0, "0"):
                raise HTTPException(status_code=409, detail="A regenerated single scene must be selected from the source task history")
            image_paths = _seeding_scene_paths(output_payload)
            if not image_paths:
                raise HTTPException(status_code=409, detail="Task has no confirmed ecommerce seeding images")
            try:
                _validate_metadata_paths(
                    {"ecommerce_seeding_confirmed_image_paths": image_paths},
                    _known_task_paths(input_payload, output_payload),
                )
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            return _enqueue_video_child(
                dependencies,
                user=user,
                source_task=task,
                input_payload=input_payload,
                action="ecommerce_seeding_finalize",
                extra={
                    "ecommerce_seeding_operation": "final_video",
                    "ecommerce_seeding_image_source_task_id": str(task["id"]),
                    "ecommerce_seeding_confirmed_image_paths": image_paths,
                    "web_visuals_confirmed": True,
                },
            )

        app.add_api_route(
            seeding_finalize_path,
            seeding_finalize_endpoint,
            methods=["POST"],
            name="video_workbench_ecommerce_seeding_finalize",
        )
        registered.append(seeding_finalize_path)

    seeding_regenerate_paths = (
        "/api/video/tasks/{task_id}/seeding-images/{scene_index}/regenerate",
        "/api/tasks/{task_id}/ecommerce_seeding_images/{scene_index}/regenerate",
    )
    if any(path not in existing_paths for path in seeding_regenerate_paths):
        async def seeding_regenerate_endpoint(
            task_id: str,
            scene_index: int,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "ecommerce_short_video":
                raise HTTPException(status_code=400, detail="Only ecommerce seeding tasks support scene regeneration")
            _require_task_status(task, {"success"}, "ecommerce seeding scene regeneration")
            raw = _output_raw_result(output_payload)
            if str(raw.get("seeding_stage") or "").strip() != "images_only":
                raise HTTPException(status_code=409, detail="Task has no editable ecommerce seeding images")
            scene_paths = _seeding_scene_paths(output_payload)
            if scene_index < 1 or scene_index > len(scene_paths):
                raise HTTPException(status_code=400, detail=f"scene_index must be between 1 and {len(scene_paths)}")
            return _enqueue_video_child(
                dependencies,
                user=user,
                source_task=task,
                input_payload=input_payload,
                action="ecommerce_seeding_image_regenerate",
                extra={
                    "ecommerce_seeding_operation": "images_only",
                    "ecommerce_seeding_regenerate_scene_index": int(scene_index),
                    "source_task_id": str(task["id"]),
                    "web_guided_partial": True,
                    "web_partial_step": "seeding_image_regeneration",
                    "web_partial_step_label": f"已重新生成视觉底图{scene_index}",
                    "count": 1,
                    "nano_images": 1,
                },
            )

        for route_path in seeding_regenerate_paths:
            if route_path in existing_paths:
                continue
            app.add_api_route(route_path, seeding_regenerate_endpoint, methods=["POST"], name="video_workbench_seeding_regenerate")
            registered.append(route_path)

    seeding_upload_paths = (
        "/api/video/tasks/{task_id}/seeding-images/{scene_index}/upload",
        "/api/tasks/{task_id}/ecommerce_seeding_images/{scene_index}/upload",
    )
    if any(path not in existing_paths for path in seeding_upload_paths):
        async def seeding_upload_endpoint(
            task_id: str,
            scene_index: int,
            image: UploadFile = File(...),
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, _input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "ecommerce_short_video" or _upload_kind(image.filename) != "image":
                raise HTTPException(status_code=400, detail="Only an image can replace an ecommerce seeding scene")
            _require_task_status(task, {"success"}, "ecommerce seeding scene upload")
            scene_paths = _seeding_scene_paths(output_payload)
            if scene_index < 1 or scene_index > len(scene_paths):
                raise HTTPException(status_code=400, detail=f"scene_index must be between 1 and {len(scene_paths)}")
            saved_path = await _save_video_upload(
                dependencies,
                username=str(dependencies.workspace_username(user)),
                task_id=str(task["id"]),
                field_name=f"ecommerce_seeding_visual_{scene_index}_{_new_video_task_id(dependencies)}",
                upload=image,
            )
            if not saved_path:
                raise HTTPException(status_code=400, detail="Uploaded ecommerce seeding image is empty")
            now = _route_now(dependencies)
            try:
                updated = _replace_seeding_scene_path(
                    output_payload,
                    scene_index=int(scene_index),
                    image_path=saved_path,
                    source="uploaded",
                    created_at=now,
                )
                with dependencies.db_factory() as conn:
                    conn.execute(
                        "UPDATE tasks SET output_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                        (_route_json_dumps(dependencies, updated), now, str(task["id"]), int(task["user_id"])),
                    )
            except Exception:
                try:
                    Path(saved_path).unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            if callable(dependencies.emit_task_event):
                dependencies.emit_task_event(
                    task_id=str(task["id"]),
                    user_id=int(task["user_id"]),
                    kind="log",
                    message=f"Ecommerce seeding scene {scene_index} was replaced by upload",
                    data={"stage": "seeding_image_upload", "status": "success", "scene_index": int(scene_index), "user_visible": True},
                )
            return {"ok": True, "task_id": str(task["id"]), "scene_index": int(scene_index), "path": saved_path}

        for route_path in seeding_upload_paths:
            if route_path in existing_paths:
                continue
            app.add_api_route(route_path, seeding_upload_endpoint, methods=["POST"], name="video_workbench_seeding_upload")
            registered.append(route_path)

    seeding_history_paths = (
        "/api/video/tasks/{task_id}/seeding-images/{scene_index}/history",
        "/api/tasks/{task_id}/ecommerce_seeding_images/{scene_index}/history",
    )
    if any(path not in existing_paths for path in seeding_history_paths):
        async def seeding_history_endpoint(
            task_id: str,
            scene_index: int,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, _input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "ecommerce_short_video" or scene_index < 1:
                raise HTTPException(status_code=400, detail="Invalid ecommerce seeding task or scene index")
            scene_paths = _seeding_scene_paths(output_payload)
            if scene_index > len(scene_paths):
                raise HTTPException(status_code=400, detail=f"scene_index must be between 1 and {len(scene_paths)}")
            items = _seeding_image_history(output_payload, int(scene_index))
            known = {_resolved_path_text(str(item["path"])) for item in items}
            with dependencies.db_factory() as conn:
                rows = conn.execute(
                    "SELECT id, input_json, output_json, updated_at FROM tasks "
                    "WHERE user_id = ? AND type = 'ecommerce_short_video' AND status = 'success' ORDER BY updated_at DESC LIMIT 300",
                    (int(task["user_id"]),),
                ).fetchall()
            for row in rows:
                record = dict(row)
                child_input = _route_json_loads(dependencies, record.get("input_json"), {})
                if not isinstance(child_input, dict) or str(child_input.get("source_task_id") or "") != str(task["id"]):
                    continue
                if int(child_input.get("ecommerce_seeding_regenerate_scene_index") or 0) != int(scene_index):
                    continue
                child_output = _route_json_loads(dependencies, record.get("output_json"), {})
                child_paths = _seeding_scene_paths(child_output if isinstance(child_output, dict) else {})
                candidate = child_paths[0] if child_paths else ""
                if not candidate or not Path(candidate).is_file() or _resolved_path_text(candidate) in known:
                    continue
                known.add(_resolved_path_text(candidate))
                items.append({
                    "path": candidate,
                    "source": "regenerated",
                    "source_task_id": str(record.get("id") or ""),
                    "created_at": int(record.get("updated_at") or 0),
                })
            return {"ok": True, "task_id": str(task["id"]), "scene_index": int(scene_index), "items": items[:50]}

        for route_path in seeding_history_paths:
            if route_path in existing_paths:
                continue
            app.add_api_route(route_path, seeding_history_endpoint, methods=["GET"], name="video_workbench_seeding_history")
            registered.append(route_path)

    seeding_use_paths = (
        "/api/video/tasks/{task_id}/seeding-images/{scene_index}/use",
        "/api/tasks/{task_id}/ecommerce_seeding_images/{scene_index}/use",
    )
    if any(path not in existing_paths for path in seeding_use_paths):
        async def seeding_use_endpoint(
            task_id: str,
            scene_index: int,
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, _input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            requested = str((payload or {}).get("path") or "").strip()
            if str(task.get("type") or "") != "ecommerce_short_video" or not requested:
                raise HTTPException(status_code=400, detail="Select an ecommerce seeding image history item")
            _require_task_status(task, {"success"}, "ecommerce seeding history restore")
            allowed = {_resolved_path_text(str(item["path"])) for item in _seeding_image_history(output_payload, int(scene_index))}
            with dependencies.db_factory() as conn:
                rows = conn.execute(
                    "SELECT input_json, output_json FROM tasks WHERE user_id = ? AND type = 'ecommerce_short_video' AND status = 'success'",
                    (int(task["user_id"]),),
                ).fetchall()
            for row in rows:
                record = dict(row)
                child_input = _route_json_loads(dependencies, record.get("input_json"), {})
                if not isinstance(child_input, dict) or str(child_input.get("source_task_id") or "") != str(task["id"]):
                    continue
                if int(child_input.get("ecommerce_seeding_regenerate_scene_index") or 0) != int(scene_index):
                    continue
                child_output = _route_json_loads(dependencies, record.get("output_json"), {})
                for item in _seeding_scene_paths(child_output if isinstance(child_output, dict) else {}):
                    if Path(item).is_file():
                        allowed.add(_resolved_path_text(item))
            if _resolved_path_text(requested) not in allowed:
                raise HTTPException(status_code=403, detail="Selected image does not belong to this scene history")
            now = _route_now(dependencies)
            updated = _replace_seeding_scene_path(
                output_payload,
                scene_index=int(scene_index),
                image_path=requested,
                source="history",
                created_at=now,
            )
            with dependencies.db_factory() as conn:
                conn.execute(
                    "UPDATE tasks SET output_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                    (_route_json_dumps(dependencies, updated), now, str(task["id"]), int(task["user_id"])),
                )
            return {"ok": True, "task_id": str(task["id"]), "scene_index": int(scene_index), "path": str(Path(requested).resolve())}

        for route_path in seeding_use_paths:
            if route_path in existing_paths:
                continue
            app.add_api_route(route_path, seeding_use_endpoint, methods=["POST"], name="video_workbench_seeding_use")
            registered.append(route_path)

    digital_human_asset_history_path = "/api/video/tasks/{task_id}/digital-human/assets/{asset_index}/history"
    if digital_human_asset_history_path not in existing_paths:
        async def digital_human_asset_history_endpoint(
            task_id: str,
            asset_index: int,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, _input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            if str(task.get("type") or "") != "create_video" or asset_index < 1 or asset_index > 4:
                raise HTTPException(status_code=400, detail="Invalid digital-human asset slot")
            key = "main" if asset_index == 1 else f"view_{asset_index}"
            history_map = output_payload.get("digital_human_asset_history")
            items = [dict(item) for item in history_map.get(key, []) if isinstance(item, dict)] if isinstance(history_map, dict) else []
            raw = _output_raw_result(output_payload)
            current = output_payload.get("digital_human_fusion_image_paths") or output_payload.get("fusion_images") or raw.get("fusion_images")
            current = current if isinstance(current, list) else []
            if asset_index <= len(current):
                current_path = str(current[asset_index - 1] or "").strip()
                if current_path and not any(str(item.get("path") or "") == current_path for item in items):
                    items.insert(0, {"path": current_path, "source": "current", "created_at": int(task.get("updated_at") or 0)})
            return {"ok": True, "task_id": str(task["id"]), "asset_index": asset_index, "items": items[:50]}

        app.add_api_route(
            digital_human_asset_history_path,
            digital_human_asset_history_endpoint,
            methods=["GET"],
            name="video_workbench_digital_human_asset_history",
        )
        registered.append(digital_human_asset_history_path)

    digital_human_asset_use_path = "/api/video/tasks/{task_id}/digital-human/assets/{asset_index}/use"
    if digital_human_asset_use_path not in existing_paths:
        async def digital_human_asset_use_endpoint(
            task_id: str,
            asset_index: int,
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            requested = str((payload or {}).get("path") or "").strip()
            if str(task.get("type") or "") != "create_video" or asset_index < 1 or asset_index > 4 or not requested:
                raise HTTPException(status_code=400, detail="Select a valid digital-human history asset")
            key = "main" if asset_index == 1 else f"view_{asset_index}"
            history_map = output_payload.get("digital_human_asset_history")
            allowed = {
                _resolved_path_text(str(item.get("path") or ""))
                for item in (history_map.get(key, []) if isinstance(history_map, dict) else [])
                if isinstance(item, dict) and str(item.get("path") or "").strip()
            }
            resolved = _resolved_path_text(requested)
            if resolved not in allowed or not Path(requested).is_file():
                raise HTTPException(status_code=403, detail="Selected asset does not belong to this history slot")
            raw = _output_raw_result(output_payload)
            fusion = output_payload.get("digital_human_fusion_image_paths") or output_payload.get("fusion_images") or raw.get("fusion_images")
            fusion = [str(item or "").strip() for item in fusion] if isinstance(fusion, list) else []
            if asset_index > len(fusion):
                raise HTTPException(status_code=409, detail="Digital-human asset slot is not initialized")
            fusion[asset_index - 1] = str(Path(requested).resolve())
            raw["fusion_images"] = fusion
            output_payload.update({
                "digital_human_fusion_image_paths": fusion,
                "fusion_images": fusion,
                "image_path": fusion[0],
                "image_paths": fusion,
                "download_path": fusion[0],
                "raw_result": raw,
            })
            input_payload["digital_human_fusion_image_paths"] = fusion
            input_payload["digital_human_main_image_local_path"] = fusion[0]
            now = _route_now(dependencies)
            with dependencies.db_factory() as conn:
                conn.execute(
                    "UPDATE tasks SET input_json = ?, output_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                    (
                        _route_json_dumps(dependencies, input_payload),
                        _route_json_dumps(dependencies, output_payload),
                        now,
                        str(task["id"]),
                        int(task["user_id"]),
                    ),
                )
            return {"ok": True, "task_id": str(task["id"]), "asset_index": asset_index, "path": fusion[asset_index - 1]}

        app.add_api_route(
            digital_human_asset_use_path,
            digital_human_asset_use_endpoint,
            methods=["POST"],
            name="video_workbench_digital_human_asset_use",
        )
        registered.append(digital_human_asset_use_path)

    task_resume_path = "/api/video/tasks/{task_id}/resume"
    if task_resume_path not in existing_paths:
        async def task_resume_endpoint(
            task_id: str,
            payload: dict[str, Any] | None = None,
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            task, input_payload, output_payload = _load_owned_video_task(dependencies, user, task_id)
            _require_task_status(task, _VIDEO_RESUMABLE_STATUSES, "resume")
            options = dict(payload or {})
            try:
                _validate_metadata_paths(options, _known_task_paths(input_payload, output_payload))
                _json_size_guard(options, limit=64 * 1024)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            return _enqueue_video_child(
                dependencies,
                user=user,
                source_task=task,
                input_payload=input_payload,
                action="resume",
                extra={
                    "resume": True,
                    "resume_from_task_id": str(task["id"]),
                    "resume_options": options,
                    "resume_checkpoint": (
                        dict(output_payload.get("video_checkpoint"))
                        if isinstance(output_payload.get("video_checkpoint"), dict)
                        else {}
                    ),
                    "completed_segments": (
                        list(output_payload.get("completed_segments"))
                        if isinstance(output_payload.get("completed_segments"), list)
                        else []
                    ),
                    **_video_continuation_fields(task.get("type"), output_payload),
                },
            )

        app.add_api_route(task_resume_path, task_resume_endpoint, methods=["POST"], name="video_workbench_task_resume")
        registered.append(task_resume_path)

    language_script_parse_path = "/api/video/language-script/parse"
    if language_script_parse_path not in existing_paths:
        async def language_script_parse_endpoint(
            payload: dict[str, Any],
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            try:
                return parse_language_script(payload)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        app.add_api_route(
            language_script_parse_path,
            language_script_parse_endpoint,
            methods=["POST"],
            name="video_workbench_language_script_parse",
        )
        registered.append(language_script_parse_path)

    language_script_analyze_paths = (
        "/api/video/language-script/analyze",
        "/api/tasks/video_language_replace/script",
    )
    if any(path not in existing_paths for path in language_script_analyze_paths):
        async def language_script_analyze_endpoint(
            params_json: str = Form("{}"),
            files: list[UploadFile] | None = File(default=None),
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            try:
                parsed = json.loads(str(params_json or "{}").strip() or "{}")
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"params_json 不是合法 JSON: {exc.msg}") from exc
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=400, detail="params_json 必须是 JSON 对象")
            uploads = list(files or [])
            videos = [item for item in uploads if _upload_kind(item.filename) == "video"]
            if len(videos) != 1:
                raise HTTPException(status_code=400, detail="视频语种更换需要上传 1 个原视频后再解析台词")
            max_bytes = int(dependencies.max_upload_bytes or 512 * 1024 * 1024)
            preview_id = _new_video_task_id(dependencies)
            with tempfile.TemporaryDirectory(prefix="video-language-script-") as tmpdir:
                upload = videos[0]
                suffix = Path(str(upload.filename or "source.mp4")).suffix.lower() or ".mp4"
                video_path = Path(tmpdir) / f"source{suffix}"
                total = 0
                with video_path.open("wb") as handle:
                    while True:
                        chunk = await upload.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_bytes:
                            raise HTTPException(status_code=413, detail="原视频超过上传大小限制")
                        handle.write(chunk)
                if not total:
                    raise HTTPException(status_code=400, detail="原视频为空文件")
                effective = dict(parsed)
                effective["video_local_path"] = str(video_path.resolve())
                effective["target_language"] = str(
                    effective.get("target_language") or effective.get("language") or "English"
                ).strip() or "English"
                effective["language"] = effective["target_language"]
                if callable(dependencies.enrich_video_payload):
                    enriched = dependencies.enrich_video_payload("video_language_replace", preview_id, effective)
                    if isinstance(enriched, dict):
                        effective = enriched
                provider = effective.get("_video_language_transcribe_translate")
                if not callable(provider):
                    raise HTTPException(status_code=503, detail="视频语种台词解析服务尚未配置")
                try:
                    analysis = await _invoke_digital_human_step_provider(
                        provider,
                        video_path=str(video_path.resolve()),
                        target_language=effective["target_language"],
                        source_language=effective.get("source_language") or "Auto",
                        source_duration=effective.get("duration_seconds") or 0,
                        payload=effective,
                    )
                except HTTPException:
                    raise
                except Exception as exc:
                    raise HTTPException(status_code=502, detail=f"视频台词解析失败: {exc}") from exc
            if not isinstance(analysis, dict):
                raise HTTPException(status_code=502, detail="视频台词解析服务返回格式无效")
            raw_segments = analysis.get("segments")
            segments: list[dict[str, Any]] = []
            if isinstance(raw_segments, list):
                for offset, item in enumerate(raw_segments, start=1):
                    if not isinstance(item, dict):
                        continue
                    source_text = str(item.get("source_text") or item.get("text") or "").strip()
                    if not source_text:
                        continue
                    start = max(float(item.get("start_seconds", item.get("start", 0)) or 0), 0.0)
                    end = float(item.get("end_seconds", item.get("end", 0)) or 0)
                    if end <= start:
                        end = start + 1.0
                    segments.append({
                        "index": offset,
                        "start_seconds": start,
                        "end_seconds": end,
                        "source_text": source_text,
                        "text": source_text,
                    })
            source_script = str(analysis.get("source_script") or "").strip()
            if not source_script and segments:
                source_script = "\n".join(item["source_text"] for item in segments)
            if not source_script:
                raise HTTPException(status_code=502, detail="视频台词解析未返回可编辑的原语言台词")
            response_params = {
                "script_text": source_script,
                "source_script": source_script,
                "video_language_source_segments": segments,
                "video_language_script_analyzed": True,
                "video_language_script_step": "parsed",
                "target_language": effective["target_language"],
                "language": effective["target_language"],
            }
            return {
                "ok": True,
                "task_type": "video_language_replace",
                "partial_step_label": "已解析原视频台词和时间戳",
                "params": response_params,
                "script_meta": {
                    "source_language": analysis.get("source_language"),
                    "transcription": analysis.get("transcription"),
                },
            }

        for route_path in language_script_analyze_paths:
            if route_path in existing_paths:
                continue
            app.add_api_route(
                route_path,
                language_script_analyze_endpoint,
                methods=["POST"],
                name="video_workbench_language_script_analyze_" + route_path.rsplit("/", 1)[-1].replace("-", "_"),
            )
            registered.append(route_path)

    if "/api/video/tasks" not in existing_paths:
        async def tasks_get_endpoint(user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
            if not callable(dependencies.db_factory):
                return {"items": [], "unified_tasks_url": "/api/tasks"}
            task_types = tuple(VIDEO_TASK_TYPES)
            placeholders = ",".join("?" for _ in task_types)
            with dependencies.db_factory() as conn:
                columns = {
                    str(row[1] if not hasattr(row, "keys") else row["name"])
                    for row in conn.execute("PRAGMA table_info(tasks)").fetchall()
                }
                order_column = "created_at" if "created_at" in columns else "updated_at" if "updated_at" in columns else "rowid"
                rows = conn.execute(
                    f"SELECT * FROM tasks WHERE user_id = ? AND type IN ({placeholders}) ORDER BY {order_column} DESC LIMIT 100",
                    (int(dependencies.workspace_user_id(user)), *task_types),
                ).fetchall()
            items: list[dict[str, Any]] = []
            for row in rows:
                record = dict(row)
                input_payload = _route_json_loads(dependencies, record.get("input_json"), {})
                output = _route_json_loads(dependencies, record.get("output_json"), {})
                raw_result = output.get("raw_result") if isinstance(output, dict) else {}
                task_item = {
                    key: record.get(key)
                    for key in ("id", "type", "status", "error", "runninghub_task_id", "cost_cents", "created_at", "updated_at")
                    if key in record
                }
                task_item["task_type"] = str(record.get("type") or "")
                task_item["video_module"] = video_ui_module_for_task(task_item["task_type"], input_payload)
                task_item["input"] = {
                    key: input_payload.get(key)
                    for key in ("video_image_mode", "mode", "subject_kind", "_video_module_id")
                    if isinstance(input_payload, dict) and key in input_payload
                }
                task_item["has_download"] = bool(
                    isinstance(output, dict)
                    and any(str(output.get(key) or "").strip() for key in ("download_path", "video_path", "image_path", "result_zip"))
                )
                if isinstance(output, dict):
                    task_item["completed_segments"] = output.get("completed_segments") if isinstance(output.get("completed_segments"), list) else []
                    if (
                        not task_item["completed_segments"]
                        and str(record.get("type") or "") == "video_language_replace"
                        and isinstance(raw_result, dict)
                        and isinstance(raw_result.get("timed_audio_segments"), list)
                    ):
                        task_item["completed_segments"] = [
                            dict(item)
                            for item in raw_result["timed_audio_segments"]
                            if isinstance(item, dict)
                        ]
                    task_item["storyboard"] = output.get("storyboard")
                    if task_item["storyboard"] is None and isinstance(raw_result, dict):
                        task_item["storyboard"] = raw_result.get("storyboard")
                items.append(task_item)
            return {"items": items, "unified_tasks_url": "/api/tasks"}

        async def tasks_post_endpoint(
            module: str = Form(""),
            module_id: str = Form(""),
            video_module: str = Form(""),
            task_type: str = Form(""),
            params_json: str = Form("{}"),
            files: list[UploadFile] = File(default=[]),
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            try:
                parsed = json.loads(str(params_json or "{}").strip() or "{}")
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"params_json 不是合法 JSON: {exc.msg}") from exc
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=400, detail="params_json 必须是 JSON 对象")
            if "_file_roles" in parsed and "file_roles" not in parsed:
                manifest = parsed.pop("_file_roles")
                if isinstance(manifest, list):
                    parsed["file_roles"] = [str(item.get("field") or "") if isinstance(item, dict) else str(item or "") for item in manifest]
            requested = module or module_id or video_module or task_type
            if requested in VIDEO_UI_MODULE_TASKS:
                parsed["_video_module_id"] = requested
            try:
                resolved_type, parsed = resolve_video_ui_task(requested, parsed)
            except ValueError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            return await submit_impl(resolved_type, json.dumps(parsed, ensure_ascii=False), files, user)

        app.add_api_route("/api/video/tasks", tasks_get_endpoint, methods=["GET"], name="video_workbench_tasks")
        app.add_api_route("/api/video/tasks", tasks_post_endpoint, methods=["POST"], name="video_workbench_submit")
        registered.append("/api/video/tasks")

    def endpoint_for(task_type: str) -> Callable[..., Any]:
        async def endpoint(
            params_json: str = Form("{}"),
            files: list[UploadFile] = File(default=[]),
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            return await submit_impl(task_type, params_json, files, user)

        endpoint.__name__ = f"api_video_{task_type}"
        return endpoint

    for task_type in VIDEO_TASK_TYPES:
        path = f"/api/video/{task_type}"
        if path in existing_paths:
            continue
        app.add_api_route(path, endpoint_for(task_type), methods=["POST"], name=f"video_workbench_{task_type}")
        registered.append(path)
    return {"registered_paths": registered, "task_types": list(VIDEO_TASK_TYPES)}


def server_video_route_dependencies(server_module: Any) -> VideoRouteDependencies:
    required = {
        "get_current_user": "get_current_user",
        "enqueue_task": "_enqueue_task_for_user",
        "save_upload_file": "_save_upload_file",
        "new_task_id": "_new_id",
        "workspace_username": "_workspace_username",
        "workspace_user_id": "_workspace_user_id",
        "db_factory": "db",
        "ensure_task_access": "_ensure_user_can_access_task",
        "json_loads": "_json_loads",
        "json_dumps": "_json_dumps",
        "now_ts": "_now_ts",
        "emit_task_event": "_emit_task_event",
    }
    values: dict[str, Any] = {}
    for field, attribute in required.items():
        value = getattr(server_module, attribute, None)
        if not callable(value):
            raise TypeError(f"server module missing callable {attribute}")
        values[field] = value
    original_new_id = values["new_task_id"]
    values["new_task_id"] = lambda: original_new_id("task")
    values["max_upload_bytes"] = getattr(server_module, "MAX_UPLOAD_BYTES", None)
    task_detail_builder = getattr(server_module, "_build_task_detail_payload", None)
    if callable(task_detail_builder):
        values["build_task_detail"] = task_detail_builder
    route_payload_enricher = _server_payload_enricher(server_module)
    runtime_applier = getattr(server_module, "_apply_runtime_defaults", None)

    def enrich_video_payload(task_type: str, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        prepared = dict(payload or {})
        if callable(runtime_applier):
            candidate = runtime_applier(str(task_type), prepared)
            if isinstance(candidate, dict):
                prepared = candidate
        return route_payload_enricher(str(task_type), str(task_id), prepared)

    values["enrich_video_payload"] = enrich_video_payload
    llm_json_request = getattr(server_module, "_request_llm_json_with_fallback", None)
    runtime_getter = getattr(server_module, "_get_runtime_config", None)
    if callable(llm_json_request):
        def generate_prompt_preview(
            *,
            module: str,
            task_type: str,
            parameters: dict[str, Any],
            image_paths: list[str] | None = None,
            user: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            source = dict(parameters or {})
            if callable(runtime_getter):
                try:
                    with values["db_factory"]() as conn:
                        runtime = runtime_getter(conn)
                    if isinstance(runtime, dict):
                        source = {**runtime, **source}
                except Exception:
                    pass
            oral_mode = (
                task_type == "create_video"
                and str(source.get("digital_human_content_mode") or "").strip() == "oral_broadcast"
            )
            if oral_mode and not isinstance(source.get("oral_hot_topic_research"), dict):
                source["oral_hot_topic_research"] = _digital_human_oral_hot_topic_research(
                    source.get("product_name"),
                    source.get("product_details") or source.get("copy_requirement"),
                    mode=source.get("digital_human_oral_hot_topic_mode") or "strong",
                )
            ecommerce_mode = task_type == "ecommerce_short_video"
            material_analysis: dict[str, Any] = {}
            effective_references: dict[str, Any] = {}
            preview_image_paths = list(image_paths or [])
            if ecommerce_mode and preview_image_paths:
                def request_material_json(**request_values: Any) -> dict[str, Any]:
                    material_result, _material_selected, _material_attempts = llm_json_request(
                        source=source,
                        user_input=json.dumps(request_values.get("user_input") or {}, ensure_ascii=False),
                        system_prompt=str(request_values.get("system_prompt") or ""),
                        parameters="",
                        image_paths=list(request_values.get("image_paths") or []),
                        allow_builtin=True,
                        retry_count=2,
                        request_label=str(request_values.get("request_label") or "广告素材分析"),
                    )
                    return material_result if isinstance(material_result, dict) else {}

                material_analysis = ecommerce_material_intelligence.analyze_ecommerce_materials(
                    source=source,
                    parameters=parameters,
                    image_paths=preview_image_paths,
                    request_json=request_material_json,
                )
                research_query = ecommerce_material_intelligence.ecommerce_material_search_query(
                    material_analysis,
                    user_instruction=str(parameters.get("prompt_text") or parameters.get("prompt") or ""),
                    product_name=str(parameters.get("product_name") or ""),
                    product_details=str(parameters.get("product_details") or ""),
                )
                source["ecommerce_product_web_research"] = ecommerce_material_intelligence.build_ecommerce_product_web_research_context(
                    ecommerce_material_intelligence.search_ecommerce_product_web_info(research_query, max_results=4)
                )
                roles = [str(item or "").strip().lower() for item in (parameters.get("file_roles") or [])]
                model_index = next((index for index, role in enumerate(roles) if role in {"model", "model_image", "person", "avatar"}), -1)
                product_paths = [path for index, path in enumerate(preview_image_paths) if index != model_index]
                model_path = preview_image_paths[model_index] if 0 <= model_index < len(preview_image_paths) else ""
                effective_references = ecommerce_material_intelligence.select_ecommerce_effective_references(
                    product_paths=product_paths,
                    model_path=model_path,
                    material_analysis=material_analysis,
                    max_images=9,
                )
                preview_image_paths = list(effective_references.get("reference_paths") or preview_image_paths)
                source["ecommerce_material_analysis"] = material_analysis
                source["ecommerce_effective_reference_order"] = list(effective_references.get("reference_order") or [])
            public_parameters = {
                str(key): value
                for key, value in source.items()
                if not str(key).startswith("_")
                and not any(marker in str(key).lower() for marker in _SECRET_KEY_MARKERS)
                and not any(marker in str(key) for marker in _LOCAL_PATH_PARAM_MARKERS)
            }
            digital_human_prompt = task_type == "create_video"
            result, selected, attempts = llm_json_request(
                source=source,
                user_input=json.dumps(
                    {"module": module, "task_type": task_type, "parameters": public_parameters},
                    ensure_ascii=False,
                ),
                system_prompt=(
                    "You prepare a generation preview for a digital-human video workbench. Return JSON only. "
                    + (
                        ecommerce_material_intelligence.ecommerce_creative_brief_schema_instruction()
                        if ecommerce_mode else ""
                    )
                    + (
                        "This is an oral knowledge-sharing broadcast: scene images are background context, not products. "
                        "Use oral_hot_topic_research only when directly relevant and never invent current events or sales claims. "
                        "Return exactly three different complete candidates using title, angle, summary, speech_text, and "
                        "hook_keywords, plus selected_index from 1 to 3. "
                        if oral_mode else ""
                    )
                    + (
                        "Analyze the supplied presenter and product images in their supplied order. Preserve visible "
                        "identity, product appearance, target language and factual product details; do not invent claims. "
                        if digital_human_prompt and image_paths else ""
                    )
                    + (
                        "Use keys candidates, selected_index, prompt_text, and storyboard. storyboard must be an object "
                        "with an items array. "
                        if oral_mode
                        else "Use keys speech_text, prompt_text, and storyboard. storyboard must be an object with an items array. "
                    )
                    + "Each storyboard item uses segment_index, prompt, text, and duration_seconds when a multi-shot plan "
                    "is useful. Preserve supplied product names, facts, language and user-authored copy. Do not expose "
                    "configuration, credentials, or implementation details."
                ),
                image_paths=preview_image_paths,
                retry_count=2,
                request_label="video workbench prompt preview",
            )
            parsed = result.get("parsed") if isinstance(result, dict) else None
            if not isinstance(parsed, dict):
                parsed = result if isinstance(result, dict) else {}
            if ecommerce_mode:
                if parsed.get("execution_prompt") and not parsed.get("prompt_text"):
                    parsed["prompt_text"] = parsed.get("execution_prompt")
                raw_segments = parsed.get("segments") if isinstance(parsed.get("segments"), list) else []
                if raw_segments and not isinstance(parsed.get("storyboard"), (dict, list)):
                    storyboard_items: list[dict[str, Any]] = []
                    for index, segment in enumerate(raw_segments, start=1):
                        if not isinstance(segment, dict):
                            continue
                        shot_lines: list[str] = []
                        for shot in segment.get("shots") or []:
                            if not isinstance(shot, dict):
                                continue
                            line = "；".join(
                                str(shot.get(key) or "").strip()
                                for key in ("scene", "camera", "visual")
                                if str(shot.get(key) or "").strip()
                            )
                            if line:
                                shot_lines.append(line)
                        narration = str(segment.get("narration") or "").strip()
                        prompt_line = "；".join([*shot_lines, narration] if narration else shot_lines)
                        if prompt_line:
                            storyboard_items.append(
                                {
                                    "segment_index": index,
                                    "prompt": prompt_line,
                                    "text": narration,
                                    "duration_seconds": segment.get("duration"),
                                    "shots": segment.get("shots") or [],
                                }
                            )
                    if storyboard_items:
                        parsed["storyboard"] = {"items": storyboard_items}
            preview = {
                key: parsed.get(key)
                for key in ("speech_text", "script", "prompt_text", "prompt", "storyboard")
                if parsed.get(key) not in (None, "")
            }
            if oral_mode:
                candidates, selected_index = _normalize_digital_human_oral_script_candidates(
                    parsed,
                    fallback_text=str(parsed.get("speech_text") or parsed.get("script") or "").strip(),
                )
                if candidates:
                    preview["speech_candidates"] = candidates
                    preview["selected_speech_candidate_index"] = selected_index
                    preview["speech_text"] = str(candidates[selected_index].get("speech_text") or "").strip()
            if ecommerce_mode:
                preview["ecommerce_material_analysis"] = material_analysis
                preview["ecommerce_product_web_research"] = source.get("ecommerce_product_web_research") or {}
                preview["ecommerce_effective_selected_indexes"] = list(effective_references.get("selected_original_indexes") or [])
                preview["ecommerce_effective_ignored_indexes"] = list(effective_references.get("ignored_original_indexes") or [])
                preview["ecommerce_effective_reference_order"] = list(effective_references.get("reference_order") or [])
                if isinstance(parsed.get("creative_brief"), dict):
                    preview["ecommerce_creative_brief"] = parsed["creative_brief"]
                if isinstance(parsed.get("segments"), list):
                    preview["ecommerce_segments"] = parsed["segments"]
            preview["model"] = {
                "provider": str(selected.get("provider") or "") if isinstance(selected, dict) else "",
                "model": str(selected.get("model") or "") if isinstance(selected, dict) else "",
                "attempt_count": len(attempts) if isinstance(attempts, list) else 0,
            }
            return preview

        values["generate_prompt_preview"] = generate_prompt_preview

    billing_module = getattr(server_module, "commercial_billing", None)
    is_admin = getattr(server_module, "_is_admin", None)
    is_admin_workspace = getattr(server_module, "_is_admin_workspace", None)
    if billing_module is not None and all(
        callable(getattr(billing_module, name, None))
        for name in ("reserve_charge", "settle_reservation", "release_reservation")
    ):
        def reserve_video_step_charge(
            *,
            user: dict[str, Any],
            task_id: str,
            step: str,
            sku: str,
            quantity: int,
            image: bool,
        ) -> dict[str, Any]:
            attempt_id = str(original_new_id("billing"))
            ref_id = f"{str(task_id)}:{str(step)}:{attempt_id}"
            admin_waived = bool(
                (callable(is_admin) and is_admin(user))
                or (callable(is_admin_workspace) and is_admin_workspace(user))
            )
            with values["db_factory"]() as conn:
                conn.execute("BEGIN IMMEDIATE")
                reservation = billing_module.reserve_charge(
                    conn,
                    user_id=int(values["workspace_user_id"](user)),
                    ref_type="video_step",
                    ref_id=ref_id,
                    sku=str(sku),
                    quantity=max(int(quantity or 0), 1),
                    image=bool(image),
                    admin_waived=admin_waived,
                    idempotency_key=f"reserve:video_step:{ref_id}:{str(sku)}",
                )
            return dict(reservation)

        def settle_video_step_charge(
            *, reservation: dict[str, Any], actual_quantity: int
        ) -> dict[str, Any]:
            reservation_id = str(reservation.get("id") or "").strip()
            if not reservation_id:
                return {}
            with values["db_factory"]() as conn:
                conn.execute("BEGIN IMMEDIATE")
                settled = billing_module.settle_reservation(
                    conn,
                    reservation_id,
                    actual_quantity=max(int(actual_quantity or 0), 0),
                )
            return dict(settled)

        def release_video_step_charge(*, reservation: dict[str, Any]) -> dict[str, Any]:
            reservation_id = str(reservation.get("id") or "").strip()
            if not reservation_id:
                return {}
            with values["db_factory"]() as conn:
                conn.execute("BEGIN IMMEDIATE")
                released = billing_module.release_reservation(conn, reservation_id)
            return dict(released)

        values["reserve_video_step_charge"] = reserve_video_step_charge
        values["settle_video_step_charge"] = settle_video_step_charge
        values["release_video_step_charge"] = release_video_step_charge
    return VideoRouteDependencies(**values)


__all__ = [
    "BILLING_ACTUAL_QUANTITY",
    "BILLING_SPEC",
    "MODULE_METADATA",
    "RUNTIME_CONFIG_DEFAULTS",
    "VIDEO_MODULE_METADATA",
    "VIDEO_UI_MODULE_TASKS",
    "VIDEO_UI_MODULE_METADATA",
    "VIDEO_RUNTIME_CONFIG_DEFAULTS",
    "VIDEO_TASK_RUNNERS",
    "VideoRouteDependencies",
    "apply_video_runtime_defaults",
    "bind_video_cancel_event",
    "inject_video_workbench",
    "build_video_submit_payload",
    "make_video_task_runners",
    "parse_language_script",
    "release_video_cancel_event",
    "request_video_cancel",
    "resolve_video_ui_task",
    "register_video_routes",
    "server_video_route_dependencies",
    "video_billing_actual_quantity",
    "video_cancel_scope",
    "video_task_billing_spec",
]
