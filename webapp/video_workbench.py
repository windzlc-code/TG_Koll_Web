from __future__ import annotations

import math
import json
import inspect
import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from fastapi import Depends, File, Form, HTTPException, UploadFile

from video_core import DEFAULT_SOURCE_BACKEND, VIDEO_TASK_TYPES, run_video_task
from video_core.source.voice_presets import ELEVENLABS_VOICE_PRESETS


DIGITAL_HUMAN_VIDEO_APP_ID = "2068273204367544322"
LEGACY_DIGITAL_HUMAN_VIDEO_APP_ID = "1958162038503649281"
ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID = "2034917373414539277"
ECOMMERCE_SHORT_VIDEO_FAST_APP_ID = "2034917373414539278"
REPLACE_MODEL_DEFAULT_APP_ID = "2028374986792116225"
REPLACE_MODEL_LEGACY_APP_ID = "1977634608437174274"
REPLACE_PRODUCT_DEFAULT_APP_ID = "1977410328592031746"
VIDEO_LANGUAGE_AUDIO_SEPARATION_APP_ID = "2054844989808619521"


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
    source = dict(VIDEO_RUNTIME_CONFIG_DEFAULTS)
    if isinstance(runtime, dict):
        source.update(runtime)

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
        current = merged.get(key)
        missing = current is None or (isinstance(current, str) and not current.strip())
        if missing and key in source:
            merged[key] = _copy_default(source[key])

    if typ == "ecommerce_short_video":
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
            or 1,
            1,
        )
        return "oral_video_second", max(quantity, 1), False
    if typ == "ecommerce_short_video":
        quantity = _positive_int(source.get("duration") or source.get("duration_seconds") or source.get("ecommerce_short_video_duration") or 5, 5)
        return _ecommerce_billing_sku(source), max(quantity, 1), False
    if typ == "video_language_replace":
        quantity = _positive_int(source.get("source_video_duration_seconds") or source.get("video_duration_seconds") or source.get("duration_seconds") or source.get("duration") or 1, 1)
        return "video_language_replace_second", max(quantity, 1), False
    if typ == "replace_model":
        quantity = _positive_int(source.get("source_video_duration_seconds") or source.get("video_duration_seconds") or source.get("duration_seconds") or source.get("duration") or 1, 1)
        return "video_model_replace_second", max(quantity, 1), False
    if typ == "replace_product":
        quantity = _positive_int(source.get("source_video_duration_seconds") or source.get("video_duration_seconds") or source.get("duration_seconds") or source.get("duration") or 1, 1)
        return "video_product_replace_second", max(quantity, 1), False
    return None


def video_billing_actual_quantity(task_type: str, task_output: dict[str, Any] | None, payload: dict[str, Any] | None) -> int:
    typ = str(task_type or "").strip()
    output = dict(task_output or {})
    request = dict(payload or {})
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
                provided_segments = request_source.get("source_segments")
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
                    if str(key) in {"completed_segment", "stage", "segment_index", "segment_count", "message"}
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
            merged = base_defaults(task_type, payload)
            runtime = None
            db_factory = getattr(server_module, "db", None)
            runtime_getter = getattr(server_module, "_get_runtime_config", None)
            if callable(db_factory) and callable(runtime_getter):
                try:
                    with db_factory() as conn:
                        runtime = runtime_getter(conn)
                except Exception:
                    runtime = None
            return apply_video_runtime_defaults(task_type, merged, runtime)

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
        image = next((item for item in images if item.get("role") in {"model", "avatar", "person"}), images[0] if images else None)
        products = [item for item in images if item is not image and item.get("role") in {"product", "scene", "goods"}]
        audio = next((item for item in audios if item.get("role") in {"audio", "voice", "speech"}), audios[0] if audios else None)
        if image:
            payload["model_image_local_path"] = path(image)
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
        if not audio and not any(_valid_http_url(payload.get(key)) for key in ("audio_url", "voice_audio_url")):
            if not str(payload.get("speech_text") or payload.get("script") or payload.get("copy_text") or payload.get("message") or "").strip():
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
            payload["target_audio_local_path"] = path(audios[0])
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
    elif isinstance(value, str) and any(marker in parent_key for marker in _PATH_KEY_MARKERS):
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
    candidates: list[Any] = [input_payload.get("storyboard"), input_payload.get("prompt_segments")]
    raw = output_payload.get("raw_result")
    candidates.extend([output_payload.get("storyboard"), output_payload.get("segments")])
    if isinstance(raw, dict):
        candidates.extend([raw.get("storyboard"), raw.get("segments"), raw.get("segment_prompts")])
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
        try:
            payload = build_video_submit_payload(typ, parsed, saved)
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        payload["source"] = "video_workbench_api"
        dependencies.enqueue_task(
            task_id,
            int(dependencies.workspace_user_id(user)),
            typ,
            payload,
            user,
        )
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
            user: dict[str, Any] = Depends(dependencies.get_current_user),
        ) -> dict[str, Any]:
            try:
                parsed = json.loads(str(params_json or "{}").strip() or "{}")
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"params_json 不是合法 JSON: {exc.msg}") from exc
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=400, detail="params_json 必须是 JSON 对象")
            task_type, normalized = resolve_video_ui_task(module, parsed)
            return {
                "module": module,
                "task_type": task_type,
                "speech_text": str(normalized.get("speech_text") or normalized.get("script") or "").strip(),
                "prompt_text": str(normalized.get("prompt_text") or normalized.get("prompt") or normalized.get("message") or "").strip(),
                "parameters": {key: value for key, value in normalized.items() if not str(key).startswith("_")},
                "requires_confirmation": True,
            }

        app.add_api_route("/api/video/prompt-preview", prompt_preview_endpoint, methods=["POST"], name="video_workbench_prompt_preview")
        registered.append("/api/video/prompt-preview")

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
                        "label": str(preset.get("label") or preset.get("button") or preset.get("voice_name") or ""),
                        "language": language,
                        "voice_id": str(preset.get("voice_id") or ""),
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
                },
            )

        app.add_api_route(
            segment_regenerate_path,
            segment_regenerate_endpoint,
            methods=["POST"],
            name="video_workbench_segment_regenerate",
        )
        registered.append(segment_regenerate_path)

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

    if "/api/video/tasks" not in existing_paths:
        async def tasks_get_endpoint(user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
            return {"items": [], "unified_tasks_url": "/api/tasks"}

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
