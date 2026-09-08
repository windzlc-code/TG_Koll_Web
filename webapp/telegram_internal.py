from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from video_core import DEFAULT_SOURCE_BACKEND, VideoTaskContext
from video_core.ecommerce_animation_redraw import (
    _ecommerce_animation_redraw_prompt,
    _normalize_ecommerce_product_category,
)
from video_core.image_mode_prompts import (
    IMAGE_EDIT_DEFAULT_PROMPT,
    IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT,
    SUBJECT_REPLACE_DEFAULT_USER_PROMPT,
    SUBJECT_REPLACE_LEGACY_PROMPTS,
    TARGET_LANGUAGE_SPECS,
    THREE_VIEW_DEFAULT_PROMPT,
    build_subject_replace_prompt,
)

from .video_workbench import _server_payload_enricher, cancel_video_remote_tasks


TG_AGENT_PRODUCTION_TASK_TYPES = {
    "create_video",
    "ecommerce_short_video",
    "image_generate",
    "replace_model",
    "replace_product",
    "replace_productANDmodel",
}

_SUBJECT_REPLACE_DEFAULT_USER_PROMPT = SUBJECT_REPLACE_DEFAULT_USER_PROMPT
_SUBJECT_REPLACE_LEGACY_PROMPTS = SUBJECT_REPLACE_LEGACY_PROMPTS


class InternalTgDigitalHumanStepPayload(BaseModel):
    tg_chat_id: int
    step: str
    params: dict[str, Any] = Field(default_factory=dict)


class InternalTgSubmitPayload(BaseModel):
    task_type: str
    tg_chat_id: int
    params: dict[str, Any] = Field(default_factory=dict)


class InternalTgAgentFilePayload(BaseModel):
    name: str = ""
    path: str
    kind: str = ""


class InternalTgAgentSubmitPayload(BaseModel):
    message: str
    tg_chat_id: int
    files: list[InternalTgAgentFilePayload] = Field(default_factory=list)
    use_ai_copy: bool = True
    duration_seconds: int = 15


class InternalTgCancelPayload(BaseModel):
    tg_chat_id: int


class InternalTgRerunPayload(BaseModel):
    tg_chat_id: int


_SERVER = None


def _bind_server(server: Any) -> None:
    global _SERVER
    _SERVER = server


def _S() -> Any:
    if _SERVER is None:
        raise RuntimeError("telegram internal routes are not bound")
    return _SERVER


def _call(name: str, *args, default: Any = None, **kwargs):
    fn = getattr(_S(), name, None)
    if callable(fn):
        return fn(*args, **kwargs)
    if default is not None or "default" in kwargs:
        return default
    raise RuntimeError(f"missing server helper: {name}")


def _new_id(prefix: str) -> str:
    return _S()._new_id(prefix)


def _apply_runtime_defaults(task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _S()._apply_runtime_defaults(task_type, payload)


def _enqueue_task(task_id: str, user_id: int, task_type: str, payload: dict[str, Any]) -> None:
    _S()._enqueue_task(task_id, user_id, task_type, payload)


def _validated_local_file(value: Any, *, label: str) -> str:
    return _S()._validated_local_file(value, label=label)


def _to_bool(value: Any, default: bool = False) -> bool:
    return _S()._to_bool(value, default)


def _to_int(value: Any, default: int = 0) -> int:
    return _S()._to_int(value, default)


def _json_loads(value: Any, default: Any = None) -> Any:
    return _S()._json_loads(value, default)


def _now_ts() -> int:
    return _S()._now_ts()


def _insert_task_event(conn, *, task_id: str, user_id: int, kind: str, message: str, data: Any) -> None:
    _S()._insert_task_event(conn, task_id=task_id, user_id=user_id, kind=kind, message=message, data=data)


def _enhance_tg_payload_with_llm_prompt(task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _S()._enhance_tg_payload_with_llm_prompt(task_type, payload)


def _revise_digital_human_short_script_with_llm(
    payload: dict[str, Any],
    *,
    current_script: str,
    revision_instruction: str,
    product_path: Path,
    model_path: Path,
) -> tuple[str, dict[str, Any]]:
    return _S()._revise_digital_human_short_script_with_llm(
        payload,
        current_script=current_script,
        revision_instruction=revision_instruction,
        product_path=product_path,
        model_path=model_path,
    )


def _guess_file_kind(path_or_name: Any) -> str:
    return _S()._guess_file_kind(path_or_name)


def _build_task_workdir(task_id: str, fallback_username: str | None = None) -> Path:
    return _S()._build_task_workdir(task_id, fallback_username=fallback_username)


def _generate_closed_image_with_fallback(**kwargs: Any) -> tuple[Any, Any, Any]:
    return _S()._generate_closed_image_with_fallback(**kwargs)


def db():
    return _S().db()


def _get_runtime_config(conn) -> dict[str, Any]:
    return _S()._get_runtime_config(conn)


def DEFAULT_RUNTIME_CONFIG() -> dict[str, Any]:
    return getattr(_S(), "DEFAULT_RUNTIME_CONFIG", {})


def _normalize_target_language(value: Any, *, default: str = "Chinese") -> str:
    text = str(value or "").strip()
    aliases = {
        "日本": "Japanese",
        "日语": "Japanese",
        "日本語": "Japanese",
        "japanese": "Japanese",
        "马来西亚": "Malay",
        "馬來西亞": "Malay",
        "马来语": "Malay",
        "馬來語": "Malay",
        "malay": "Malay",
        "bahasa malaysia": "Malay",
        "bahasa melayu": "Malay",
        "西班牙语": "Spanish",
        "español": "Spanish",
        "spanish": "Spanish",
        "泰语": "Thai",
        "thai": "Thai",
        "印尼语": "Indonesian",
        "印度尼西亚语": "Indonesian",
        "indonesian": "Indonesian",
        "中文": "Chinese",
        "汉语": "Chinese",
        "chinese": "Chinese",
        "英文": "English",
        "英语": "English",
        "english": "English",
    }
    if text in TARGET_LANGUAGE_SPECS:
        return text
    return aliases.get(text.lower(), aliases.get(text, default))


def _target_language_label(value: Any) -> str:
    language = _normalize_target_language(value)
    return str(TARGET_LANGUAGE_SPECS.get(language, TARGET_LANGUAGE_SPECS["Chinese"]).get("label") or "中文")


def _subject_replace_user_prompt(payload: dict[str, Any]) -> str:
    prompt = str(payload.get("prompt") or payload.get("prompt_text") or payload.get("message") or "").strip()
    if prompt in _SUBJECT_REPLACE_LEGACY_PROMPTS:
        return _SUBJECT_REPLACE_DEFAULT_USER_PROMPT
    return prompt or build_subject_replace_prompt(payload)


def _append_once(source: Any, extra: str) -> str:
    text = str(source or "").strip()
    clause = str(extra or "").strip()
    if not clause:
        return text
    if clause in text:
        return text
    return f"{text} {clause}".strip() if text else clause


def _enforce_image_generate_product_only_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    updated = dict(payload or {})
    if str(updated.get("mode") or "").strip() != "product_only":
        return updated
    updated.pop("model_image_local_path", None)
    updated.pop("model_image_local_paths", None)
    updated["ecommerce_model_reference_skipped"] = True
    updated["prompt"] = _append_once(
        updated.get("prompt") or updated.get("prompt_text") or updated.get("message"),
        IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT,
    )
    updated["prompt_text"] = updated["prompt"]
    updated["tg_user_instruction"] = _append_once(
        updated.get("tg_user_instruction") or updated.get("prompt") or updated.get("prompt_text"),
        IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT,
    )
    return updated


def _normalize_ecommerce_video_mode(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"seeding_video", "seeding", "种草", "种草视频"}:
        return "seeding_video"
    return "ad_video"


def _ecommerce_video_mode_label(mode: str) -> str:
    return "种草视频" if mode == "seeding_video" else "广告视频"


def _is_ecommerce_seeding_video_mode(payload: dict[str, Any] | None) -> bool:
    return _normalize_ecommerce_video_mode((payload or {}).get("ecommerce_video_mode")) == "seeding_video"


def _apply_ecommerce_video_mode_runtime_defaults(payload: dict[str, Any] | None) -> dict[str, Any]:
    updated = dict(payload or {})
    mode = _normalize_ecommerce_video_mode(updated.get("ecommerce_video_mode"))
    updated["ecommerce_video_mode"] = mode
    updated["ecommerce_video_mode_label"] = _ecommerce_video_mode_label(mode)
    if mode == "seeding_video":
        updated["ecommerce_short_video_model"] = ""
        updated["ecommerce_model"] = ""
        updated["seedance_model"] = ""
        updated["ecommerce_ad_style"] = ""
        updated["ecommerce_ad_style_label"] = ""
    else:
        chosen_model = str(
            updated.get("ecommerce_model") or updated.get("ecommerce_short_video_model") or updated.get("seedance_model") or "seedance2.0"
        ).strip() or "seedance2.0"
        updated["ecommerce_short_video_model"] = chosen_model
        updated["ecommerce_model"] = chosen_model
        updated["seedance_model"] = chosen_model
    return updated


def _voice_preset_preview_cache_path(*, target_language: str, preset: dict[str, str]) -> Path:
    from video_core.source import voice_presets

    filename = voice_presets.elevenlabs_preview_cache_name(target_language, preset)
    data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR") or "webapp_data")).expanduser()
    return (data_dir / "elevenlabs_voice_previews" / filename).resolve()


def _resolve_elevenlabs_voice_preset(payload: dict[str, Any]) -> dict[str, str] | None:
    from video_core.source import voice_presets

    source = payload if isinstance(payload, dict) else {}
    preset_key = str(source.get("elevenlabs_tts_preset_key") or source.get("preset_dry_voice_key") or "").strip()
    if preset_key:
        found = voice_presets.elevenlabs_voice_preset_by_key(preset_key)
        if found:
            return found
    voice_id = str(source.get("elevenlabs_tts_voice_id") or "").strip()
    if voice_id:
        for presets in voice_presets.ELEVENLABS_VOICE_PRESETS.values():
            for item in presets:
                if str(item.get("voice_id") or "").strip() == voice_id:
                    return item
    button = str(source.get("preset_dry_voice") or source.get("speaker") or "").strip()
    language = str(source.get("target_language") or source.get("language") or "Chinese").strip() or "Chinese"
    if button:
        found = voice_presets.elevenlabs_voice_preset_by_button(button, language)
        if found:
            return found
    return None


def _apply_elevenlabs_preset_audio_reference(payload: dict[str, Any]) -> dict[str, Any]:
    from video_core.source import voice_presets

    updated = dict(payload or {})
    audio_local = str(updated.get("audio_local_path") or updated.get("voice_audio_local_path") or "").strip()
    if audio_local:
        return updated
    preset = _resolve_elevenlabs_voice_preset(updated)
    if not preset:
        return updated
    target_language = str(updated.get("target_language") or updated.get("language") or "Chinese").strip() or "Chinese"
    preview_path = voice_presets.ensure_elevenlabs_preview_audio(
        preset=preset,
        output_path=_voice_preset_preview_cache_path(target_language=target_language, preset=preset),
    )
    updated["audio_local_path"] = str(preview_path)
    updated["preset_dry_voice"] = str(updated.get("preset_dry_voice") or voice_presets.elevenlabs_voice_preset_display_label(preset)).strip()
    updated["speaker"] = str(updated.get("speaker") or preset.get("voice_name") or "").strip()
    updated.setdefault("elevenlabs_tts_preset_key", str(preset.get("key") or "").strip())
    updated.setdefault("elevenlabs_tts_voice_id", str(preset.get("voice_id") or "").strip())
    return updated


def _apply_ecommerce_effective_image_selection(payload: dict[str, Any]) -> dict[str, Any]:
    fn = getattr(_S(), "_apply_ecommerce_effective_image_selection", None)
    if callable(fn):
        return fn(payload)
    return payload


def _ensure_ecommerce_prompt_segments_storyboard_reference(segments, payload=None):
    fn = getattr(_S(), "_ensure_ecommerce_prompt_segments_storyboard_reference", None)
    if callable(fn):
        return fn(segments, payload=payload)
    return segments


def _parse_ecommerce_seeding_display_prompt_segments(prompt, total_duration=None):
    fn = getattr(_S(), "_parse_ecommerce_seeding_display_prompt_segments", None)
    if callable(fn):
        return fn(prompt, total_duration=total_duration)
    return []


def _build_ecommerce_prompt_segments_for_preview(payload):
    fn = getattr(_S(), "_build_ecommerce_prompt_segments_for_preview", None)
    if callable(fn):
        return fn(payload)
    return []


def _finalize_ecommerce_prompt_segments(segments, style="", product_category=""):
    fn = getattr(_S(), "_finalize_ecommerce_prompt_segments", None)
    if callable(fn):
        return fn(segments, style=style, product_category=product_category)
    return segments


def _clean_ecommerce_prompt_segments_for_output(segments, product_category="", style=""):
    fn = getattr(_S(), "_clean_ecommerce_prompt_segments_for_output", None)
    if callable(fn):
        return fn(segments, product_category=product_category, style=style)
    return segments


def _format_ecommerce_seeding_segments_for_display(segments):
    fn = getattr(_S(), "_format_ecommerce_seeding_segments_for_display", None)
    if callable(fn):
        return fn(segments)
    return ""


def _format_ecommerce_prompt_segments_for_display(segments, product_category="", style=""):
    fn = getattr(_S(), "_format_ecommerce_prompt_segments_for_display", None)
    if callable(fn):
        return fn(segments, product_category=product_category, style=style)
    return ""


def _ecommerce_prompt_quality_issues(prompt_texts, *, segment_durations=None, image_count=0, product_category=""):
    fn = getattr(_S(), "_ecommerce_prompt_quality_issues", None)
    if callable(fn):
        return fn(prompt_texts, segment_durations=segment_durations, image_count=image_count, product_category=product_category)
    return []


def _normalize_replace_model_payload(payload):
    fn = getattr(_S(), "_normalize_replace_model_payload", None)
    if callable(fn):
        return fn(payload)
    return dict(payload or {})


def _copy_inputs_to_dir(src_paths: list[str], dest_dir: Path) -> list[str]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    for idx, p in enumerate(src_paths or [], start=1):
        src = Path(str(p)).resolve()
        if not src.exists() or not src.is_file():
            continue
        suffix = src.suffix.lower()
        name = src.name
        target = dest_dir / name
        if target.exists():
            target = dest_dir / f"{idx:04d}{suffix or src.suffix}"
        shutil.copy2(src, target)
        copied.append(str(target))
    return copied


def _is_digital_human_oral_broadcast_mode(payload: dict[str, Any] | None) -> bool:
    source = payload or {}
    mode = str(source.get("digital_human_content_mode") or source.get("digital_human_mode") or "").strip().lower()
    if mode in {"oral_broadcast", "oral", "speech", "talking_head"}:
        return True
    role = str(source.get("product_image_role") or "").strip().lower()
    return role == "scene"


def _require_internal_tg_request(request: Request) -> None:
    expected_token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    provided_token = str(request.headers.get("x-tg-internal-token") or "").strip()
    if expected_token:
        if provided_token != expected_token:
            raise HTTPException(status_code=403, detail="TG 内部提交 token 不正确")
        return
    client_host = ""
    try:
        client_host = str(request.client.host if request.client else "")
    except Exception:
        client_host = ""
    if client_host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="TG 内部提交接口仅允许本机调用")


def _internal_tg_submit_user_id() -> int:
    with db() as conn:
        row = conn.execute("SELECT id FROM users WHERE is_admin = 1 AND is_disabled = 0 ORDER BY id ASC LIMIT 1").fetchone()
        if row is None:
            row = conn.execute("SELECT id FROM users WHERE is_disabled = 0 ORDER BY id ASC LIMIT 1").fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="没有可用于 TG 内部提交的后台账号")
    return int(row["id"])


def _build_internal_tg_task_payload(task_id: str, task_type: str, params: dict[str, Any]) -> dict[str, Any]:
    typ = str(task_type or "").strip()
    payload = dict(params or {})
    payload["source"] = "telegram"

    if typ == "image_generate":
        with db() as conn:
            runtime = _get_runtime_config(conn)
            _DEFAULT_RUNTIME = getattr(_S(), 'DEFAULT_RUNTIME_CONFIG', {})
        default_prompt = str(runtime.get("image_edit_default_prompt") or _DEFAULT_RUNTIME.get("image_edit_default_prompt") or IMAGE_EDIT_DEFAULT_PROMPT).strip()
        mode = str(payload.get("mode") or "").strip()
        prompt_value = str(payload.get("prompt") or payload.get("prompt_text") or payload.get("message") or "").strip()
        if mode == "three_view" and (not prompt_value or prompt_value in {default_prompt, IMAGE_EDIT_DEFAULT_PROMPT}):
            payload["prompt"] = THREE_VIEW_DEFAULT_PROMPT
        if mode == "three_view" and str(payload.get("tg_user_instruction") or "").strip() in {
            default_prompt,
            IMAGE_EDIT_DEFAULT_PROMPT,
        }:
            payload["tg_user_instruction"] = THREE_VIEW_DEFAULT_PROMPT
        elif not prompt_value and default_prompt and mode not in {"digital_human_character", "three_view", "subject_replace", "poster_translate", "scene_image"}:
            payload["prompt"] = default_prompt
        if _to_bool(payload.get("tg_use_llm_prompt"), False) and not str(payload.get("tg_user_instruction") or "").strip() and default_prompt and mode not in {"digital_human_character", "three_view", "subject_replace", "poster_translate", "scene_image"}:
            payload["tg_user_instruction"] = default_prompt
        if mode == "digital_human_character":
            reference_paths = [
                str(item or "").strip()
                for item in (payload.get("character_reference_image_local_paths") or [])
                if str(item or "").strip()
            ]
            reference_single = str(payload.get("character_reference_image_local_path") or "").strip()
            if reference_single and reference_single not in reference_paths:
                reference_paths.insert(0, reference_single)
            if reference_paths and not str(payload.get("product_image_local_path") or "").strip():
                payload["product_image_local_path"] = reference_paths[0]
            if reference_paths and not payload.get("product_image_local_paths"):
                payload["product_image_local_paths"] = reference_paths
        image_optional_modes = {"digital_human_character", "scene_image"}
        if mode == "scene_image":
            prompt_text = str(payload.get("prompt") or payload.get("prompt_text") or payload.get("message") or "").strip()
            if not prompt_text:
                raise HTTPException(status_code=400, detail="场景图生成需要填写场景描述")
            payload["prompt"] = prompt_text
            payload["prompt_text"] = prompt_text
        product_image = "" if mode in image_optional_modes else _validated_local_file(payload.get("product_image_local_path") or payload.get("image_local_path"), label="商品图")
        product_images: list[str] = []
        for item in payload.get("product_image_local_paths") or []:
            item_text = str(item or "").strip()
            if item_text:
                validated = _validated_local_file(item_text, label="商品图")
                if validated not in product_images:
                    product_images.append(validated)
        if product_image and product_image not in product_images:
            product_images.insert(0, product_image)
        model_image = str(payload.get("model_image_local_path") or "").strip()
        if mode == "scene_image":
            payload["mode"] = "scene_image"
            payload["tg_workflow_label"] = str(payload.get("tg_workflow_label") or "场景图生成")
            payload["image_generate_provider"] = "closed_model_api"
            payload["image_generate_mode_default"] = "closed_model_api"
            payload["tg_use_llm_prompt"] = False
            payload.pop("product_image_local_path", None)
            payload.pop("product_image_local_paths", None)
            payload.pop("model_image_local_path", None)
            payload.pop("model_image_local_paths", None)
        elif mode == "digital_human_character":
            payload["mode"] = "digital_human_character"
        elif mode == "subject_replace":
            payload["mode"] = "subject_replace"
            subject_replace_product = str(payload.get("subject_replace_product_image_local_path") or "").strip()
            subject_replace_model = str(payload.get("subject_replace_model_image_local_path") or "").strip()
            replacement_candidates: list[str] = []
            for raw_value, label in (
                (subject_replace_product, "商品图"),
                (subject_replace_model, "模特图"),
                (payload.get("replacement_image_local_path"), "替换图"),
            ):
                text = str(raw_value or "").strip()
                if not text:
                    continue
                validated = _validated_local_file(text, label=label)
                if validated not in replacement_candidates:
                    replacement_candidates.append(validated)
                if label == "商品图":
                    payload["subject_replace_product_image_local_path"] = validated
                elif label == "模特图":
                    payload["subject_replace_model_image_local_path"] = validated
            if not replacement_candidates:
                raise HTTPException(status_code=400, detail="主体替换需要上传商品图或模特图")
            payload["replacement_image_local_path"] = replacement_candidates[0]
            payload["prompt"] = _subject_replace_user_prompt(payload) or _SUBJECT_REPLACE_DEFAULT_USER_PROMPT
            payload.pop("prompt_text", None)
            payload.pop("message", None)
            payload.pop("tg_user_instruction", None)
            payload["tg_use_llm_prompt"] = False
        elif mode == "poster_translate":
            language = _normalize_target_language(payload.get("target_language") or payload.get("language"))
            payload["mode"] = "poster_translate"
            payload["target_language"] = language
            payload["target_language_label"] = _target_language_label(language)
            payload["language"] = language
            payload["prompt"] = ""
            payload.pop("prompt_text", None)
            payload.pop("message", None)
            payload.pop("tg_user_instruction", None)
            payload["tg_use_llm_prompt"] = False
        elif mode == "three_view":
            payload["mode"] = "three_view"
        elif model_image:
            payload["mode"] = "model_product"
            payload["model_image_local_path"] = _validated_local_file(model_image, label="模特图")
        else:
            payload["mode"] = "product_only"
            payload = _enforce_image_generate_product_only_prompt(payload)
        if product_image:
            payload["product_image_local_path"] = product_image
        if product_images:
            payload["product_image_local_paths"] = product_images
        payload["image_size"] = str(payload.get("image_size") or payload.get("size") or payload.get("output_size") or "1:1").strip() or "1:1"
        payload["size"] = payload["image_size"]
        resolved_mode = str(payload.get("mode") or mode or "product_only").strip() or "product_only"
        payload["video_image_mode"] = resolved_mode
        payload["mode"] = resolved_mode
        if mode not in {"subject_replace", "poster_translate", "scene_image"}:
            payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        return payload

    if typ == "ecommerce_short_video":
        language = _normalize_target_language(payload.get("target_language") or payload.get("language"))
        payload["target_language"] = language
        payload["target_language_label"] = _target_language_label(language)
        payload["language"] = language
        payload = _apply_ecommerce_video_mode_runtime_defaults(payload)
        reference_video_local = str(payload.get("reference_video_local_path") or payload.get("video_local_path") or "").strip()
        product_image = _validated_local_file(payload.get("product_image_local_path") or payload.get("image_local_path"), label="产品图片")
        product_images: list[str] = []
        for item in payload.get("product_image_local_paths") or []:
            item_text = str(item or "").strip()
            if item_text:
                product_images.append(_validated_local_file(item_text, label="产品图片"))
        if not product_images:
            product_images = [product_image]
        model_image = str(payload.get("model_image_local_path") or "").strip()
        if model_image:
            payload["model_image_local_path"] = _validated_local_file(model_image, label="模特图片")
        payload = _apply_elevenlabs_preset_audio_reference(payload)
        audio_local = str(payload.get("audio_local_path") or "").strip()
        if audio_local:
            payload["audio_local_path"] = _validated_local_file(audio_local, label="音色参考音频")
        if _is_ecommerce_seeding_video_mode(payload) and reference_video_local:
            payload["reference_video_local_path"] = _validated_local_file(reference_video_local, label="参考视频")
        payload["product_image_local_path"] = product_image
        payload["product_image_local_paths"] = product_images
        stale_keys = ["ecommerce_creative_brief"]
        if _to_bool(payload.get("tg_use_llm_prompt"), False):
            stale_keys.extend(["prompt_segments", "segments", "shot_plan"])
        for stale_key in stale_keys:
            payload.pop(stale_key, None)
        if _to_bool(payload.get("tg_use_llm_prompt"), False) and not str(payload.get("tg_user_instruction") or "").strip():
            if _is_ecommerce_seeding_video_mode(payload):
                payload["tg_user_instruction"] = "根据上传图片生成真实分享感更强的本地种草分镜脚本；输出适合本地生图和本地合成的镜头脚本，不要写广告视频模型提示词；让文字模型自主设计完整镜头推进、体验场景和生活化表达；不要写硬广口号，只有统一旁白时放在时间线最后一行。"
            else:
                payload["tg_user_instruction"] = "根据上传图片生成商业广告短视频提示词；让系统自主设计画面和镜头。人物说话内容可直接写进对应镜头；只有统一旁白放在时间线最后一行。"
        payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        payload = _apply_ecommerce_effective_image_selection(payload)
        segments = payload.get("prompt_segments") if isinstance(payload.get("prompt_segments"), list) else []
        if segments:
            segments = _ensure_ecommerce_prompt_segments_storyboard_reference(segments, payload=payload)
            payload["prompt_segments"] = segments
        if not segments and _is_ecommerce_seeding_video_mode(payload):
            segments = _parse_ecommerce_seeding_display_prompt_segments(
                payload.get("prompt") or payload.get("prompt_text"),
                total_duration=payload.get("duration") or payload.get("duration_seconds"),
            )
            if segments:
                payload["prompt_segments"] = segments
        if not segments:
            segments = _build_ecommerce_prompt_segments_for_preview(payload)
            if segments:
                payload["prompt_segments"] = segments
        if segments:
            display_style = "" if _is_ecommerce_seeding_video_mode(payload) else payload.get("ecommerce_ad_style")
            segments = _finalize_ecommerce_prompt_segments(
                segments,
                style=display_style,
                product_category=payload.get("product_category") or payload.get("category") or "",
            )
            cleaned_segments = _clean_ecommerce_prompt_segments_for_output(
                segments,
                product_category=payload.get("product_category") or payload.get("category") or "",
                style="" if _is_ecommerce_seeding_video_mode(payload) else payload.get("ecommerce_ad_style") or payload.get("ad_style") or "",
            )
            if cleaned_segments:
                segments = cleaned_segments
            ensured_cleaned_segments = _ensure_ecommerce_prompt_segments_storyboard_reference(segments, payload=payload)
            if ensured_cleaned_segments:
                segments = ensured_cleaned_segments
            payload["prompt_segments"] = segments
            if _is_ecommerce_seeding_video_mode(payload):
                display_prompt = _format_ecommerce_seeding_segments_for_display(segments)
            else:
                display_prompt = _format_ecommerce_prompt_segments_for_display(
                    segments,
                    product_category=payload.get("product_category") or payload.get("category") or "",
                    style=payload.get("ecommerce_ad_style") or payload.get("ad_style") or "",
                )
            if display_prompt:
                payload["prompt"] = display_prompt
                payload["prompt_text"] = display_prompt
            segment_durations = [_to_int(item.get("duration"), 0) for item in segments if isinstance(item, dict)]
            image_count = len(payload.get("ecommerce_effective_reference_paths") or [])
            if not image_count:
                image_count = len(payload.get("product_image_local_paths") or [])
                if str(payload.get("model_image_local_path") or "").strip():
                    image_count += 1
            payload["ecommerce_prompt_quality_issues"] = _ecommerce_prompt_quality_issues(
                [str(item.get("prompt") or "") for item in segments if isinstance(item, dict)],
                segment_durations=segment_durations,
                image_count=image_count,
                product_category=payload.get("product_category") or payload.get("category") or "",
            )
        return payload

    if typ == "replace_model":
        payload = _normalize_replace_model_payload(payload)
        payload["video_local_path"] = _validated_local_file(payload.get("video_local_path"), label="原视频")
        payload["image_local_path"] = _validated_local_file(payload.get("image_local_path"), label="模特图")
        payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        return payload

    if typ == "replace_product":
        payload["video_local_path"] = _validated_local_file(payload.get("video_local_path"), label="原视频")
        payload["image_local_path"] = _validated_local_file(payload.get("image_local_path"), label="商品图")
        payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        return payload

    if typ == "replace_productANDmodel":
        model_zip = str(payload.get("model_zip_path") or "").strip()
        product_zip = str(payload.get("product_zip_path") or "").strip()
        video_zip = str(payload.get("video_zip_path") or "").strip()
        if model_zip or product_zip or video_zip:
            payload["model_zip_path"] = _validated_local_file(model_zip, label="模特 zip")
            payload["product_zip_path"] = _validated_local_file(product_zip, label="商品 zip")
            payload["video_zip_path"] = _validated_local_file(video_zip, label="原视频 zip")
            payload.setdefault("match_mode", "cycle")
            payload.setdefault("fixed_index", 1)
            payload.setdefault("auto_rename", True)
            payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
            return payload

        mixed_image_paths = payload.get("mixed_image_paths") if isinstance(payload.get("mixed_image_paths"), list) else []
        video_paths = payload.get("video_paths") if isinstance(payload.get("video_paths"), list) else []
        if mixed_image_paths or video_paths:
            payload["mixed_image_paths"] = [_validated_local_file(item, label="模特/商品图") for item in mixed_image_paths]
            payload["video_paths"] = [_validated_local_file(item, label="原视频") for item in video_paths]
            payload.setdefault("match_mode", "cycle")
            payload.setdefault("fixed_index", 1)
            payload.setdefault("auto_rename", True)
            payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
            return payload

        video_path = _validated_local_file(payload.get("video_local_path"), label="原视频")
        model_image = _validated_local_file(payload.get("model_image_local_path"), label="模特图")
        product_image = _validated_local_file(payload.get("product_image_local_path"), label="商品图")
        workdir = _build_task_workdir(task_id, fallback_username="telegram")
        model_dir = workdir / "tg_input" / "model"
        product_dir = workdir / "tg_input" / "product"
        video_dir = workdir / "tg_input" / "video"
        _copy_inputs_to_dir([model_image], model_dir)
        _copy_inputs_to_dir([product_image], product_dir)
        _copy_inputs_to_dir([video_path], video_dir)
        payload["model_dir_path"] = str(model_dir)
        payload["product_dir_path"] = str(product_dir)
        payload["video_dir_path"] = str(video_dir)
        payload["model_image_local_path"] = model_image
        payload["product_image_local_path"] = product_image
        payload["video_local_path"] = video_path
        payload["image_local_path"] = model_image
        payload.setdefault("match_mode", "cycle")
        payload.setdefault("fixed_index", 1)
        payload.setdefault("auto_rename", True)
        payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        return payload

    if typ in {"create_video", "commerce_video"}:
        language = _normalize_target_language(payload.get("target_language") or payload.get("language"))
        payload["target_language"] = language
        payload["target_language_label"] = _target_language_label(language)
        payload["language"] = language
        if _is_digital_human_oral_broadcast_mode(payload):
            payload["digital_human_content_mode"] = "oral_broadcast"
            payload["digital_human_short_mode"] = "single"
            payload["product_image_role"] = "scene"
        raw_product_images = payload.get("product_image_local_paths") if isinstance(payload.get("product_image_local_paths"), list) else []
        model_image = payload.get("model_image_local_path") or payload.get("image_local_path")
        product_image = payload.get("product_image_local_path") or payload.get("scene_image_local_path") or model_image
        is_digital_short = bool(str(payload.get("digital_human_short_mode") or "").strip())
        payload["model_image_local_path"] = _validated_local_file(model_image, label="模特图")
        if is_digital_short:
            model_images: list[str] = []
            raw_model_images = payload.get("model_image_local_paths") if isinstance(payload.get("model_image_local_paths"), list) else []
            for item in [*raw_model_images, model_image, payload.get("image_local_path")]:
                item_text = str(item or "").strip()
                if not item_text:
                    continue
                validated = _validated_local_file(item_text, label="模特图")
                if validated not in model_images:
                    model_images.append(validated)
                if len(model_images) >= 2:
                    break
            if payload["model_image_local_path"] not in model_images:
                model_images.insert(0, payload["model_image_local_path"])
            payload["model_image_local_paths"] = model_images[:2]
            payload["dual_model_dialogue"] = _to_bool(payload.get("dual_model_dialogue"), False) or len(payload["model_image_local_paths"]) >= 2
        if is_digital_short and raw_product_images:
            product_images: list[str] = []
            for item in raw_product_images:
                item_text = str(item or "").strip()
                if not item_text:
                    continue
                validated = _validated_local_file(item_text, label="产品图")
                if validated not in product_images:
                    product_images.append(validated)
                if len(product_images) >= 4:
                    break
            if not product_images:
                raise HTTPException(status_code=400, detail="产品图不能为空")
            payload["product_image_local_path"] = product_images[0]
            payload["product_image_local_paths"] = product_images[:4]
        else:
            payload["product_image_local_path"] = _validated_local_file(product_image, label="产品图" if is_digital_short else "商品图")
        if is_digital_short:
            scene_values = payload.get("digital_human_scene_image_local_paths")
            if not isinstance(scene_values, list):
                scene_values = payload.get("scene_image_local_paths")
            scene_paths: list[str] = []
            for item in scene_values or []:
                item_text = str(item or "").strip()
                if not item_text:
                    continue
                scene_paths.append(_validated_local_file(item_text, label="场景图"))
                if len(scene_paths) >= 3:
                    break
            payload["digital_human_scene_image_local_paths"] = scene_paths

        camera_video = str(payload.get("camera_video_local_path") or "").strip()
        if camera_video:
            payload["camera_video_local_path"] = _validated_local_file(camera_video, label="运镜视频")

        payload = _apply_elevenlabs_preset_audio_reference(payload)
        audio_local = str(payload.get("audio_local_path") or "").strip()
        if audio_local:
            payload["audio_local_path"] = _validated_local_file(audio_local, label="音频")
            speech_text = str(payload.get("speech_text") or payload.get("word") or payload.get("message") or "").strip()
            if not speech_text and not (is_digital_short and (_to_bool(payload.get("use_ai_script"), False) or _to_bool(payload.get("use_ai_copy"), False))):
                raise HTTPException(status_code=400, detail="数字人视频生成上传克隆音频后必须填写口播文稿")
            if speech_text:
                payload["speech_text"] = speech_text

        scene_image = str(payload.get("generated_scene_image_local_path") or "").strip()
        if scene_image:
            payload["generated_scene_image_local_path"] = _validated_local_file(scene_image, label="场景图")

        payload["duration_seconds"] = max(_to_int(payload.get("duration_seconds"), 15), 1)
        if not is_digital_short:
            payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        return payload

    if typ == "create_audio":
        speech_text = str(payload.get("speech_text") or payload.get("word") or "").strip()
        if not speech_text:
            raise HTTPException(status_code=400, detail="create_audio 需要 speech_text")
        payload["speech_text"] = speech_text
        return payload

    if typ == "get_nano_banana":
        input_image = payload.get("input_image_local_path") or payload.get("image_local_path")
        payload["input_image_local_path"] = _validated_local_file(input_image, label="参考图")
        payload = _enhance_tg_payload_with_llm_prompt(typ, payload)
        return payload

    if typ == "get_gemini":
        image_paths: list[str] = []
        for item in payload.get("image_paths") if isinstance(payload.get("image_paths"), list) else []:
            image_paths.append(_validated_local_file(item, label="图片"))
        video_paths: list[str] = []
        for item in payload.get("video_paths") if isinstance(payload.get("video_paths"), list) else []:
            video_paths.append(_validated_local_file(item, label="视频"))
        payload["image_paths"] = image_paths
        payload["video_paths"] = video_paths
        payload["user_input"] = str(payload.get("user_input") or payload.get("message") or "").strip()
        if not payload["user_input"]:
            raise HTTPException(status_code=400, detail="get_gemini 需要 user_input")
        return payload

    raise HTTPException(status_code=400, detail=f"TG 暂不支持的任务类型: {typ}")



def _run_ecommerce_animation_redraw_step(params: dict[str, Any]) -> dict[str, Any]:
    payload = _apply_runtime_defaults("image_generate", dict(params or {}))
    style = str(payload.get("ecommerce_ad_style") or "").strip().lower()
    if style != "animation":
        raise RuntimeError("只有动画广告风格需要执行素材转绘")
    prompt = str(payload.get("prompt") or payload.get("prompt_text") or "").strip()
    product_category = _normalize_ecommerce_product_category(payload.get("product_category") or payload.get("category"), prompt=prompt)
    product_values = [
        str(item or "").strip()
        for item in (payload.get("ecommerce_effective_product_image_local_paths") or payload.get("product_image_local_paths") or [])
        if str(item or "").strip()
    ]
    if not product_values:
        product_value = str(payload.get("product_image_local_path") or payload.get("image_local_path") or "").strip()
        if product_value:
            product_values = [product_value]
    model_value = str(payload.get("model_image_local_path") or "").strip()
    model_skipped = _to_bool(payload.get("ecommerce_model_reference_skipped") or payload.get("model_reference_skipped"), False) or not model_value
    redraw_items: list[tuple[str, str, str]] = []
    for idx, value in enumerate(product_values, start=1):
        path = Path(value).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"待转绘产品图不存在: {path}")
        redraw_items.append(("product", str(path), f"产品/场景有效图{idx}"))
    if not model_skipped and model_value:
        model_path = Path(model_value).expanduser().resolve()
        if not model_path.exists() or not model_path.is_file():
            raise FileNotFoundError(f"待转绘人物图不存在: {model_path}")
        redraw_items.append(("model", str(model_path), "人物/模特参考图"))
    if not redraw_items:
        raise RuntimeError("动画转绘缺少可处理图片")

    task_id = _new_id("ecom_anim_redraw")
    workdir = _build_task_workdir(task_id)
    redrawn_products: list[str] = []
    redrawn_model = ""
    redrawn_all: list[str] = []
    attempts_by_item: list[dict[str, Any]] = []
    for idx, (kind, source_path_text, role) in enumerate(redraw_items, start=1):
        source_path = Path(source_path_text).resolve()
        out_path = workdir / f"animation_redraw_{idx:02d}{source_path.suffix.lower() or '.png'}"
        redraw_payload = dict(payload)
        redraw_payload.update(
            {
                "mode": "product_only" if kind == "product" else "model_product",
                "prompt": _ecommerce_animation_redraw_prompt(
                    source_prompt=prompt,
                    product_category=product_category,
                    index=idx,
                    role=role,
                ),
                "product_image_local_path": str(source_path),
                "output_dir": str(workdir),
            }
        )
        result = DEFAULT_SOURCE_BACKEND.image_generate(
            task_id=f"{task_id}_redraw_{idx}",
            payload=redraw_payload,
            context=VideoTaskContext(task_id=f"{task_id}_redraw_{idx}", task_type="image_generate"),
        )
        selected = {"model": str((result or {}).get("model") or "")}
        attempts = (result or {}).get("attempts") or []
        image_path = Path(str((result or {}).get("image_path") or (result or {}).get("download_path") or out_path)).resolve()
        if not image_path.exists() or not image_path.is_file():
            raise RuntimeError(f"动画素材转绘成功但未找到输出图: {image_path}")
        redrawn_all.append(str(image_path))
        if kind == "model":
            redrawn_model = str(image_path)
        else:
            redrawn_products.append(str(image_path))
        attempts_by_item.append(
            {
                "index": idx,
                "kind": kind,
                "source_path": str(source_path),
                "output_path": str(image_path),
                "model": str((selected or {}).get("model") or ""),
                "attempts": attempts,
            }
        )

    updated = dict(payload)
    if redrawn_products:
        updated["product_image_local_path"] = redrawn_products[0]
        updated["product_image_local_paths"] = redrawn_products
        updated["ecommerce_effective_product_image_local_paths"] = redrawn_products
    if redrawn_model:
        updated["model_image_local_path"] = redrawn_model
        updated["ecommerce_model_reference_skipped"] = False
    updated["ecommerce_animation_redraw_done"] = True
    updated["ecommerce_animation_redraw_skipped"] = False
    updated["ecommerce_animation_original_reference_paths"] = [item[1] for item in redraw_items]
    updated["ecommerce_animation_redrawn_reference_paths"] = redrawn_all
    updated["ecommerce_animation_redraw_result"] = {
        "task_id": task_id,
        "product_category": product_category,
        "items": attempts_by_item,
    }
    return {"ok": True, "params": updated, "image_paths": redrawn_all}




def _storyboard_items_to_segments(storyboard: Any) -> list[dict[str, Any]]:
    items: list[Any] = []
    if isinstance(storyboard, dict):
        raw = storyboard.get("items")
        items = list(raw) if isinstance(raw, list) else []
    elif isinstance(storyboard, list):
        items = storyboard
    segments: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or item.get("text") or "").strip()
        if not prompt:
            continue
        segments.append(
            {
                "segment_index": item.get("segment_index") or index,
                "prompt": prompt,
                "text": str(item.get("text") or "").strip(),
                "duration": item.get("duration_seconds") or item.get("duration") or 0,
            }
        )
    return segments


def _fill_preview_from_video_workbench(payload: dict[str, Any]) -> dict[str, Any]:
    deps = getattr(_S(), "server_video_route_dependencies", None)
    if not callable(deps):
        from .video_workbench import server_video_route_dependencies as deps
    try:
        bound = deps(_S())
    except Exception:
        return payload
    generate = getattr(bound, "generate_prompt_preview", None)
    if not callable(generate):
        return payload
    image_paths: list[str] = []
    for key in ("product_image_local_paths", "ecommerce_effective_product_image_local_paths"):
        values = payload.get(key)
        if isinstance(values, list):
            image_paths.extend(str(item).strip() for item in values if str(item).strip())
    model = str(payload.get("model_image_local_path") or "").strip()
    if model:
        image_paths.append(model)
    image_paths = list(dict.fromkeys(image_paths))
    preview = generate(
        module="ecommerce_short_video",
        task_type="ecommerce_short_video",
        parameters=dict(payload),
        image_paths=image_paths,
        user=None,
    )
    if not isinstance(preview, dict):
        return payload
    prompt_text = str(preview.get("prompt_text") or preview.get("prompt") or "").strip()
    if prompt_text:
        payload["prompt"] = prompt_text
        payload["prompt_text"] = prompt_text
    segments = _storyboard_items_to_segments(preview.get("storyboard"))
    if segments:
        payload["prompt_segments"] = segments
    for key in (
        "speech_text",
        "ecommerce_material_analysis",
        "ecommerce_product_web_research",
        "ecommerce_effective_reference_order",
        "ecommerce_creative_brief",
    ):
        if preview.get(key) not in (None, "", [], {}):
            payload[key] = preview.get(key)
    return payload


def _build_internal_tg_ecommerce_prompt_preview_payload(
    params: dict[str, Any],
    *,
    tg_chat_id: int = 0,
    source: str = "telegram-preview",
) -> dict[str, Any]:
    preview_params = dict(params) if isinstance(params, dict) else {}
    revision_instruction = str(preview_params.pop("ecommerce_revision_instruction") or "").strip()
    current_prompt = str(preview_params.pop("ecommerce_current_prompt") or "").strip()
    current_prompt_segments = preview_params.pop("ecommerce_current_prompt_segments", None)
    if revision_instruction:
        current_context = current_prompt
        if not current_context and isinstance(current_prompt_segments, list):
            current_context = json.dumps(current_prompt_segments, ensure_ascii=False)
        if not current_context:
            raise RuntimeError("缺少待修改的广告短视频提示词")
        base_instruction = str(
            preview_params.get("tg_user_instruction")
            or preview_params.get("user_prompt")
            or ""
        ).strip()
        preview_params["tg_user_instruction"] = "\n".join(
            [
                base_instruction,
                "这是当前已经生成的广告短视频提示词底稿，请保留没有被要求修改的有效内容，并直接在此基础上输出修改后的完整提示词。",
                f"当前提示词底稿：\n{current_context}",
                f"用户本次修改要求：{revision_instruction}",
            ]
        ).strip()
    preview_params["tg_use_llm_prompt"] = True
    for stale_key in (
        "prompt",
        "prompt_text",
        "prompt_segments",
        "copy_text",
        "ecommerce_creative_brief",
        "tg_llm_prompt_error",
        "ecommerce_prompt_quality_issues",
    ):
        preview_params.pop(stale_key, None)
    preview_payload = _build_internal_tg_task_payload(_new_id("preview"), "ecommerce_short_video", preview_params)
    preview_payload = _apply_runtime_defaults("ecommerce_short_video", preview_payload)
    if not str(preview_payload.get("prompt") or "").strip():
        preview_payload = _fill_preview_from_video_workbench(preview_payload)
    if not str(preview_payload.get("prompt") or "").strip():
        detail = str(preview_payload.get("tg_llm_prompt_error") or "AI 未生成可用提示词").strip()
        raise RuntimeError(detail)
    preview_payload["tg_chat_id"] = int(tg_chat_id)
    preview_payload["source"] = source
    return preview_payload


def _path_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").strip()
    return [text] if text else []


def _run_digital_human_tg_step(step: str, params: dict[str, Any]) -> dict[str, Any]:
    task_id = _new_id("dh_step")
    payload = _build_internal_tg_task_payload(task_id, "create_video", dict(params or {}))
    payload = _apply_runtime_defaults("create_video", payload)
    enrich = _server_payload_enricher(_S())
    payload = enrich("create_video", task_id, payload)
    mode = str(payload.get("digital_human_short_mode") or "single").strip().lower()
    if mode not in {"single", "storyboard"}:
        mode = "single"
    normalized_step = str(step or "").strip().lower()
    workdir = _build_task_workdir(task_id, fallback_username="telegram")
    context = VideoTaskContext(task_id=task_id, task_type="create_video")
    speech_text = str(payload.get("speech_text") or payload.get("message") or "").strip()
    model_references = _path_list(payload.get("model_image_local_paths") or payload.get("model_image_local_path"))
    product_references = _path_list(payload.get("product_image_local_paths") or payload.get("product_image_local_path"))
    storyboard = payload.get("storyboard") if isinstance(payload.get("storyboard"), list) else []

    if normalized_step == "script":
        if speech_text:
            payload["speech_text"] = speech_text
            payload["message"] = speech_text
            return {"ok": True, "step": "script", "params": payload, "speech_text": speech_text, "ai_copy": {}}
        provider = payload.get("_digital_human_ai_copy_provider")
        if not callable(provider):
            raise RuntimeError("数字人脚本生成接口不可用")
        generated = provider(
            payload=payload,
            mode=mode,
            dual_presenter=bool(payload.get("dual_presenter") or payload.get("dual_model_dialogue")),
            storyboard=storyboard,
            model_references=model_references,
            product_references=product_references,
            task_id=task_id,
            context=context,
        )
        generated = generated if isinstance(generated, dict) else {"speech_text": generated}
        speech_text = str(generated.get("speech_text") or generated.get("script") or "").strip()
        if not speech_text:
            raise RuntimeError("数字人口播短视频缺少口播文稿")
        payload["speech_text"] = speech_text
        payload["message"] = speech_text
        return {
            "ok": True,
            "step": "script",
            "params": payload,
            "speech_text": speech_text,
            "ai_copy": generated.get("metadata") or generated.get("ai_copy") or {},
        }
    if normalized_step == "script_guided_revision":
        revision_instruction = str(payload.get("revision_instruction") or "").strip()
        if not speech_text:
            raise RuntimeError("引導修改前必须先有已生成的口播文稿")
        if not revision_instruction:
            raise RuntimeError("引導修改口播文稿缺少用户修改要求")
        model_path = Path(model_references[0] if model_references else payload.get("model_image_local_path") or "").expanduser().resolve()
        product_path = Path(product_references[0] if product_references else payload.get("product_image_local_path") or "").expanduser().resolve()
        speech_text, revision_meta = _revise_digital_human_short_script_with_llm(
            payload,
            current_script=speech_text,
            revision_instruction=revision_instruction,
            product_path=product_path,
            model_path=model_path,
        )
        payload["speech_text"] = speech_text
        payload["message"] = speech_text
        payload["revision_instruction"] = revision_instruction
        return {
            "ok": True,
            "step": "script_guided_revision",
            "params": payload,
            "speech_text": speech_text,
            "revision": revision_meta,
        }

    if normalized_step == "fusion_main":
        if not speech_text:
            raise RuntimeError("生成融合主图前必须先确认口播文稿")
        result = DEFAULT_SOURCE_BACKEND.generate_digital_human_fusion_main(
            task_id=task_id,
            payload=payload,
            context=context,
            workdir=workdir,
            speech_text=speech_text,
            storyboard=storyboard,
            model_references=model_references,
            product_references=product_references,
        )
        image_path = str((result or {}).get("image_path") or (result or {}).get("fusion_main_image") or "").strip()
        if not image_path:
            raise RuntimeError("数字人融合主图未返回文件")
        payload["digital_human_main_image_local_path"] = image_path
        return {"ok": True, "step": "fusion_main", "params": payload, "image_path": image_path}

    if normalized_step == "fusion_views":
        main_path = Path(str(payload.get("digital_human_main_image_local_path") or "")).expanduser().resolve()
        if not main_path.exists() or not main_path.is_file():
            raise RuntimeError("生成视角图前必须先确认融合主图")
        result = DEFAULT_SOURCE_BACKEND.generate_digital_human_consistency_views(
            task_id=task_id,
            payload=payload,
            main_image_path=str(main_path),
            speech_text=speech_text,
            storyboard=storyboard,
            mode=mode,
            model_references=model_references,
            existing_fusion_images=_path_list(payload.get("digital_human_fusion_image_paths")),
            context=context,
            workdir=workdir,
        )
        image_paths = _path_list((result or {}).get("image_paths") or (result or {}).get("fusion_images"))
        if not image_paths:
            raise RuntimeError("数字人视角图未返回文件")
        payload["digital_human_fusion_image_paths"] = image_paths
        return {"ok": True, "step": "fusion_views", "params": payload, "image_paths": image_paths}

    if normalized_step == "fusion_view":
        main_path = Path(str(payload.get("digital_human_main_image_local_path") or "")).expanduser().resolve()
        if not main_path.exists() or not main_path.is_file():
            raise RuntimeError("重新生成视角图前必须先确认融合主图")
        view_index = max(_to_int(payload.get("digital_human_regenerate_view_index"), 0), 2)
        result = DEFAULT_SOURCE_BACKEND.generate_digital_human_single_consistency_view(
            task_id=task_id,
            payload=payload,
            main_image_path=str(main_path),
            view_index=view_index,
            speech_text=speech_text,
            storyboard=storyboard,
            context=context,
            workdir=workdir,
        )
        image_path = str((result or {}).get("image_path") or "").strip()
        existing = _path_list(payload.get("digital_human_fusion_image_paths"))
        if image_path:
            while len(existing) < view_index:
                existing.append("")
            existing[view_index - 1] = image_path
            payload["digital_human_fusion_image_paths"] = [item for item in existing if item]
        return {"ok": True, "step": "fusion_view", "params": payload, "image_path": image_path, "view_index": view_index}

    raise RuntimeError(f"未知数字人确认步骤: {step}")


def _cancel_latest_tg_webapp_task(chat_id: int, *, requested_by: str = "TG") -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, user_id, type, status, input_json, output_json, runninghub_task_id, created_at
            FROM tasks
            WHERE status IN ('queued', 'running')
            ORDER BY created_at DESC
            LIMIT 300
            """,
        ).fetchall()
        for row in rows:
            task = dict(row)
            payload = _json_loads(task.get("input_json"), {})
            if not isinstance(payload, dict):
                continue
            try:
                if int(payload.get("tg_chat_id") or 0) != int(chat_id):
                    continue
            except Exception:
                continue
            cancel_user = getattr(_S(), "_cancel_task_record_for_user", None)
            if callable(cancel_user):
                result = cancel_user(
                    task_id=str(task.get("id") or ""),
                    user_id=int(task.get("user_id") or 0),
                    requested_by=requested_by,
                )
            else:
                raise HTTPException(status_code=500, detail="任务取消接口不可用")
            try:
                remote = cancel_video_remote_tasks(
                    str(task.get("type") or ""),
                    input_payload=payload,
                    output_payload=_json_loads(task.get("output_json"), {}),
                    runninghub_task_id=task.get("runninghub_task_id"),
                )
            except Exception:
                remote = []
            if isinstance(result, dict):
                result["runninghub_cancel_results"] = remote
            return result
    return {"ok": True, "cancelled": False, "message": "目前没有可取消的后台队列任务"}


def _rerun_latest_tg_webapp_task(chat_id: int, *, requested_by: str = "TG") -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, user_id, type, status, input_json, created_at
            FROM tasks
            ORDER BY created_at DESC
            LIMIT 300
            """,
        ).fetchall()
        for row in rows:
            task = dict(row)
            payload = _json_loads(task.get("input_json"), {})
            if not isinstance(payload, dict):
                continue
            try:
                if int(payload.get("tg_chat_id") or 0) != int(chat_id):
                    continue
            except Exception:
                continue
            old_status = str(task.get("status") or "").strip().lower()
            old_task_id = str(task.get("id") or "").strip()
            if old_status in {"queued", "running"}:
                return {
                    "ok": True,
                    "found": True,
                    "rerun": False,
                    "id": old_task_id,
                    "status": old_status,
                    "message": "最近任务仍在排队或执行中，不能重复提交；如需重来，请先强制停止当前任务。",
                }
            task_type = str(task.get("type") or "").strip()
            if not task_type:
                return {"ok": True, "found": True, "rerun": False, "id": old_task_id, "message": "最近任务类型缺失，无法重跑"}
            new_task_id = _new_id("task")
            new_payload = dict(payload)
            if task_type == "image_generate":
                for runtime_key in (
                    "image_model_provider_api_key_gemini",
                    "image_model_provider_api_key_gpt",
                    "llm_api_key",
                    "llm_api_key_gemini",
                    "llm_api_key_gpt",
                ):
                    new_payload.pop(runtime_key, None)
                new_payload["tg_use_llm_prompt"] = False
            new_payload["tg_chat_id"] = int(chat_id)
            new_payload["source"] = "telegram_rerun"
            new_payload["rerun_from_task_id"] = old_task_id
            _enqueue_task(new_task_id, int(task.get("user_id") or 0), task_type, new_payload)
            return {
                "ok": True,
                "found": True,
                "rerun": True,
                "id": new_task_id,
                "source_task_id": old_task_id,
                "task_type": task_type,
                "ai_prompt_refreshed": False,
                "message": "最近任务已重新提交到后台队列",
            }
    return {"ok": True, "found": False, "rerun": False, "message": "你目前还没有可重跑的 Web 历史任务"}


def inject_telegram_internal_routes(app, server) -> None:
    os.environ.setdefault("TG_INTERNAL_API_TOKEN", "vecto-local-tg-internal")
    _bind_server(server)
    try:
        from .telegram_agent import bind_server as bind_agent_server
        bind_agent_server(server)
    except Exception:
        pass
    router = APIRouter()

    @router.post("/api/internal/tg/submit")
    def api_internal_tg_submit(payload: InternalTgSubmitPayload, request: Request):
        _require_internal_tg_request(request)
        typ = str(payload.task_type or "").strip()
        if not typ:
            raise HTTPException(status_code=400, detail="task_type 不能为空")
        task_id = _new_id("task")
        params = payload.params if isinstance(payload.params, dict) else {}
        task_payload = _build_internal_tg_task_payload(task_id, typ, params)
        task_payload = _apply_runtime_defaults(typ, task_payload)
        task_payload["tg_chat_id"] = int(payload.tg_chat_id)
        task_payload["source"] = "telegram"
        user_id = _internal_tg_submit_user_id()
        _enqueue_task(task_id, user_id, typ, task_payload)
        return {"ok": True, "id": task_id, "task_type": typ}

    @router.post("/api/internal/tg/digital_human_step")
    def api_internal_tg_digital_human_step(payload: InternalTgDigitalHumanStepPayload, request: Request):
        _require_internal_tg_request(request)
        params = payload.params if isinstance(payload.params, dict) else {}
        try:
            result = _run_digital_human_tg_step(str(payload.step or ""), params)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc) or exc.__class__.__name__) from exc
        result["tg_chat_id"] = int(payload.tg_chat_id)
        return result

    @router.post("/api/internal/tg/ecommerce_prompt_preview")
    def api_internal_tg_ecommerce_prompt_preview(payload: InternalTgSubmitPayload, request: Request):
        _require_internal_tg_request(request)
        typ = str(payload.task_type or "").strip() or "ecommerce_short_video"
        if typ != "ecommerce_short_video":
            raise HTTPException(status_code=400, detail="仅支持 ecommerce_short_video")
        params = dict(payload.params) if isinstance(payload.params, dict) else {}
        try:
            preview_payload = _build_internal_tg_ecommerce_prompt_preview_payload(
                params,
                tg_chat_id=int(payload.tg_chat_id),
                source="telegram-preview",
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc) or exc.__class__.__name__) from exc
        return {
            "ok": True,
            "task_type": typ,
            "params": {
                key: preview_payload.get(key)
                for key in (
                    "product_image_local_path",
                    "product_image_local_paths",
                    "model_image_local_path",
                    "ecommerce_model",
                    "ecommerce_short_video_model",
                    "ecommerce_ad_style",
                    "ecommerce_ad_style_label",
                    "ecommerce_video_mode",
                    "ecommerce_video_mode_label",
                    "app_id",
                    "ecommerce_short_video_app_id",
                    "ecommerce_short_video_workflow_ids",
                    "target_language",
                    "target_language_label",
                    "language",
                    "video_structure",
                    "ratio",
                    "ratio_label",
                    "resolution",
                    "user_prompt",
                    "duration_seconds",
                    "duration",
                    "prompt",
                    "prompt_segments",
                    "copy_text",
                    "speech_text",
                    "speech_candidates",
                    "selected_speech_candidate_index",
                    "audio_local_path",
                    "ecommerce_creative_brief",
                    "ecommerce_material_analysis",
                    "ecommerce_product_web_research",
                    "ecommerce_original_product_image_local_paths",
                    "ecommerce_effective_reference_paths",
                    "ecommerce_effective_product_image_local_paths",
                    "ecommerce_effective_reference_order",
                    "ecommerce_prompt_quality_issues",
                    "tg_llm_prompt_error",
                    "tg_llm_prompt_warning",
                )
                if preview_payload.get(key) not in (None, "", [], {})
            },
        }

    @router.post("/api/internal/tg/ecommerce_animation_redraw")
    def api_internal_tg_ecommerce_animation_redraw(payload: InternalTgSubmitPayload, request: Request):
        _require_internal_tg_request(request)
        typ = str(payload.task_type or "").strip() or "ecommerce_short_video"
        if typ != "ecommerce_short_video":
            raise HTTPException(status_code=400, detail="仅支持 ecommerce_short_video")
        params = dict(payload.params) if isinstance(payload.params, dict) else {}
        try:
            result = _run_ecommerce_animation_redraw_step(params)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc) or exc.__class__.__name__) from exc
        result["tg_chat_id"] = int(payload.tg_chat_id)
        return result

    @router.post("/api/internal/tg/agent_submit")
    def api_internal_tg_agent_submit(payload: InternalTgAgentSubmitPayload, request: Request):
        _require_internal_tg_request(request)
        text = str(payload.message or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="message 不能为空")
        file_infos: list[dict[str, str]] = []
        for item in payload.files or []:
            path_text = _validated_local_file(item.path, label="TG 附件")
            kind = str(item.kind or "").strip() or _guess_file_kind(path_text)
            file_infos.append(
                {
                    "name": str(item.name or Path(path_text).name),
                    "path": path_text,
                    "kind": kind,
                }
            )
        build_agent = getattr(_S(), "_build_agent_task_payload", None)
        agent_chat = getattr(_S(), "_agent_chat_payload", None)
        try:
            if not callable(build_agent):
                raise RuntimeError("智能提交接口不可用")
            typ, planned_payload, summary = build_agent(
                message=text,
                file_infos=file_infos,
                use_ai_copy=bool(payload.use_ai_copy),
                default_duration=max(_to_int(payload.duration_seconds, 15), 1),
                production_only=True,
            )
        except Exception as exc:
            if callable(agent_chat):
                typ, planned_payload, summary = agent_chat(
                    reply=f"我还不能创建生产任务：{exc}。请补充具体任务类型和必要素材，或点击面板里的工作流入口按步骤提交。",
                    summary="未创建生产任务",
                )
            else:
                return {"ok": True, "submitted": False, "summary": "未创建生产任务", "reply": str(exc)}

        if typ not in TG_AGENT_PRODUCTION_TASK_TYPES:
            reply = str((planned_payload or {}).get("reply") or summary or "").strip()
            if not reply:
                reply = "请补充具体生产任务和必要素材，或点击面板里的工作流入口按步骤提交。"
            return {"ok": True, "submitted": False, "task_type": typ, "summary": summary, "reply": reply}

        task_id = _new_id("task")
        planned_payload = dict(planned_payload or {})
        planned_payload["message"] = text
        planned_payload["tg_chat_id"] = int(payload.tg_chat_id)
        planned_payload["source"] = "telegram_agent"
        planned_payload.setdefault("tg_use_llm_prompt", True)
        planned_payload.setdefault("tg_user_instruction", text)
        task_payload = _build_internal_tg_task_payload(task_id, typ, planned_payload)
        task_payload["tg_chat_id"] = int(payload.tg_chat_id)
        task_payload["source"] = "telegram_agent"
        user_id = _internal_tg_submit_user_id()
        _enqueue_task(task_id, user_id, typ, task_payload)
        return {"ok": True, "id": task_id, "task_type": typ, "summary": summary}

    @router.post("/api/internal/tg/cancel_active")
    def api_internal_tg_cancel_active(payload: InternalTgCancelPayload, request: Request):
        _require_internal_tg_request(request)
        return _cancel_latest_tg_webapp_task(
            int(payload.tg_chat_id),
            requested_by=f"TG-{int(payload.tg_chat_id)}",
        )

    @router.post("/api/internal/tg/rerun_latest")
    def api_internal_tg_rerun_latest(payload: InternalTgRerunPayload, request: Request):
        _require_internal_tg_request(request)
        return _rerun_latest_tg_webapp_task(
            int(payload.tg_chat_id),
            requested_by=f"TG-{int(payload.tg_chat_id)}",
        )

    app.include_router(router)
