from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
import re
import tempfile

import pytest

import replace_productANDmodel as replace_union
import webapp.server as server


def test_normalize_runtime_config_maps_chain_to_legacy_fields():
    runtime = server._normalize_runtime_config(
        {
            "oral_digital_human_workflow_ids": ["1001", "1002", "1003"],
            "image_generate_workflow_ids": ["2001", "2002"],
            "replace_model_original_workflow_ids": ["3001", "3002"],
            "replace_product_workflow_ids": ["4001", "4002"],
        }
    )

    assert runtime["oral_digital_human_workflow_ids"] == ["1001", "1002", "1003"]
    assert runtime["create_audio_app_id"] == "1001"
    assert runtime["create_video_app_id"] == "1003"
    assert runtime["video_app_id"] == "1003"
    assert runtime["image_generate_workflow_ids"] == ["2001", "2002"]
    assert runtime["image_runninghub_workflow_id"] == "2002"
    assert runtime["replace_model_original_workflow_ids"] == ["3001", "3002"]
    assert runtime["replace_model_original_app_id"] == "3002"
    assert runtime["replace_product_workflow_ids"] == ["4001", "4002"]
    assert runtime["replace_product_app_id"] == "4002"


def test_normalize_runtime_config_removes_deprecated_replace_model_variants():
    runtime = server._normalize_runtime_config(
        {
            "replace_model_primary_workflow_ids": ["deprecated-primary"],
            "replace_model_slice_workflow_ids": ["deprecated-slice"],
            "replace_model_motion_transfer_workflow_ids": ["deprecated-motion"],
            "replace_model_primary_app_id": "deprecated-primary",
            "replace_model_slice_app_id": "deprecated-slice",
            "replace_model_motion_transfer_app_id": "deprecated-motion",
        }
    )

    assert "replace_model_primary_workflow_ids" not in runtime
    assert "replace_model_slice_workflow_ids" not in runtime
    assert "replace_model_motion_transfer_workflow_ids" not in runtime
    assert "replace_model_primary_app_id" not in runtime
    assert "replace_model_slice_app_id" not in runtime
    assert "replace_model_motion_transfer_app_id" not in runtime


def test_normalize_runtime_config_accepts_closed_llm_in_oral_chain():
    runtime = server._normalize_runtime_config(
        {
            "create_audio_app_id": "1000",
            "create_video_app_id": "1009",
            "oral_digital_human_workflow_ids": [
                {"type": "closed_llm_model", "value": "gpt-5.5"},
                "1001",
                "1002",
            ],
        }
    )

    assert runtime["oral_digital_human_workflow_ids"] == [
        "closed_llm_model:gpt-5.5",
        "1001",
        "1002",
    ]
    assert runtime["create_audio_app_id"] == "1001"
    assert runtime["create_video_app_id"] == "1002"
    assert runtime["video_app_id"] == "1002"


def test_build_workflow_meta_describes_comfy_image_chain():
    meta = server._build_workflow_meta(
        task_id="task-image",
        task_type="image_generate",
        input_payload={
            "image_generate_provider": "remote_comfy",
            "remote_comfy_workflow_mappings": {"image_generate": "wf-image"},
        },
        output_payload={},
        runninghub_task_id="",
    )

    assert meta["workflow_ids"] == ["wf-image"]
    assert meta["workflow_chain_summary"] == "ComfyUI 图像生成链 1 步"
    assert meta["workflow_step_count"] == 1


def test_build_workflow_meta_describes_comfy_image_edit_mapping_without_closed_model_pollution():
    meta = server._build_workflow_meta(
        task_id="task-edit",
        task_type="get_nano_banana",
        input_payload={
            "comfy_workflow_source": "remote",
            "remote_comfy_workflow_mappings": {"get_nano_banana": "__converted__/firered_api.json"},
        },
        output_payload={},
        runninghub_task_id="",
    )

    assert meta["workflow_name"] == "图片编辑"
    assert meta["workflow_ids"] == ["__converted__/firered_api.json"]
    assert meta["workflow_id"] == "__converted__/firered_api.json"
    assert meta["workflow_chain_summary"] == "ComfyUI 图片编辑链 1 步"
    assert meta["workflow_step_count"] == 1
    assert "闭源" not in meta["workflow_name"]
    assert "gemini-3-pro-image-preview" not in meta["workflow_id"]


def test_build_workflow_meta_prefers_image_edit_output_workflow_path():
    meta = server._build_workflow_meta(
        task_id="task-edit-output",
        task_type="get_nano_banana",
        input_payload={
            "comfy_workflow_source": "remote",
            "remote_comfy_workflow_mappings": {"get_nano_banana": "__converted__/old.api.json"},
        },
        output_payload={"remote_comfy_workflow_path": "firered_api.json"},
        runninghub_task_id="",
    )

    assert meta["workflow_name"] == "图片编辑"
    assert meta["workflow_ids"] == ["firered_api.json"]
    assert meta["workflow_chain_summary"] == "ComfyUI 图片编辑链 1 步"
    assert "gemini-3-pro-image-preview" not in meta["workflow_id"]


def test_normalize_runtime_config_splits_gemini_and_gpt_candidates():
    runtime = server._normalize_runtime_config(
        {
            "llm_default_model_gemini": "gemini-3.1-pro-preview, gemini-2.5-pro",
            "llm_default_model_gpt": "gpt-4.1, gpt-4o-mini",
        }
    )

    assert runtime["llm_default_model_gemini"] == "gemini-3.1-pro-preview, gemini-2.5-pro"
    assert runtime["llm_default_model_gpt"] == "gpt-4.1, gpt-4o-mini"
    assert runtime["llm_default_model"] == "gemini-3.1-pro-preview, gemini-2.5-pro"


def test_normalize_runtime_config_backfills_split_candidates_from_legacy_fields():
    runtime = server._normalize_runtime_config(
        {
            "llm_default_model": "gemini-3.1-pro-preview, gemini-2.5-flash",
        }
    )

    assert runtime["llm_default_model_gemini"] == "gemini-3.1-pro-preview, gemini-2.5-flash"
    assert runtime["llm_default_model_gpt"] == ""


def test_normalize_runtime_config_backfills_split_llm_keys_from_legacy_field():
    runtime = server._normalize_runtime_config(
        {
            "llm_api_key": "legacy-llm-key",
        }
    )

    assert runtime["llm_api_key_gemini"] == "legacy-llm-key"
    assert runtime["llm_api_key_gpt"] == ""
    assert runtime["llm_api_key"] == "legacy-llm-key"


def test_normalize_runtime_config_keeps_gpt_only_candidates_separate():
    runtime = server._normalize_runtime_config(
        {
            "llm_default_model_gemini": "",
            "llm_default_model_gpt": "gpt-4.1, gpt-4o-mini",
        }
    )

    assert runtime["llm_default_model_gemini"] == ""
    assert runtime["llm_default_model_gpt"] == "gpt-4.1, gpt-4o-mini"
    assert runtime["llm_default_model"] == "gpt-4.1, gpt-4o-mini"


def test_resolve_llm_settings_uses_gpt_key_for_gpt_models():
    base_url, api_key, model = server._resolve_llm_settings(
        {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_api_key_gpt": "gpt-key",
            "llm_model": "gpt-4.1",
        },
        allow_builtin=False,
    )

    assert base_url == "http://llm.local"
    assert api_key == "gpt-key"
    assert model == "gpt-4.1"


def test_resolve_llm_settings_uses_gemini_key_by_default():
    base_url, api_key, model = server._resolve_llm_settings(
        {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_api_key_gpt": "gpt-key",
            "llm_model": "gemini-2.5-pro",
        },
        allow_builtin=False,
    )

    assert base_url == "http://llm.local"
    assert api_key == "gemini-key"
    assert model == "gemini-2.5-pro"


def test_normalize_runtime_config_respects_model_priority_order():
    runtime = server._normalize_runtime_config(
        {
            "llm_default_model_gemini": "gemini-3.1-pro-preview, gemini-3-flash-preview",
            "llm_default_model_gpt": "gpt-5.5",
            "llm_model_priority_order": "gpt-5.5, gemini-3-flash-preview",
        }
    )

    assert runtime["llm_model_priority_order"] == "gpt-5.5, gemini-3-flash-preview, gemini-3.1-pro-preview"


def test_request_llm_json_with_fallback_uses_next_model_on_failure(monkeypatch):
    calls: list[tuple[str, str]] = []

    def _fake_request(*, model: str, api_key: str, **kwargs):
        calls.append((model, api_key))
        if model == "gemini-3.1-pro-preview":
            return {"ok": False, "error": "gemini unavailable", "raw": {}}
        return {"ok": True, "parsed": {"prompt_text": "ok"}, "raw_text": "{}", "raw": {}}

    monkeypatch.setattr(server.get_gemini, "request_gemini3_pro_json", _fake_request)
    result, selected, attempts = server._request_llm_json_with_fallback(
        source={
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_api_key_gpt": "gpt-key",
            "llm_default_model_gemini": "gemini-3.1-pro-preview",
            "llm_default_model_gpt": "gpt-5.5",
            "llm_model_priority_order": "gemini-3.1-pro-preview, gpt-5.5",
        },
        user_input="hello",
        system_prompt="json only",
        allow_builtin=False,
    )

    assert result["ok"] is True
    assert selected["model"] == "gpt-5.5"
    assert calls == [("gemini-3.1-pro-preview", "gemini-key"), ("gpt-5.5", "gpt-key")]
    assert attempts[0]["ok"] is False
    assert attempts[1]["ok"] is True


def test_tg_prompt_enhancement_generates_image_prompt_without_production_request(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )

    calls: list[str] = []

    def _fake_request(*, model: str, **kwargs):
        calls.append(model)
        return {"ok": True, "parsed": {"prompt": "精修商品图，真实电商摄影，无文字水印"}}

    monkeypatch.setattr(server.get_gemini, "request_gemini3_pro_json", _fake_request)
    payload = server._enhance_tg_payload_with_llm_prompt(
        "image_generate",
        {
            "prompt": "帮我把这个商品图修好",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "帮我把这个商品图修好",
        },
    )

    assert calls == ["gemini-3-flash-preview"]
    assert payload["prompt"] == "精修商品图，真实电商摄影，无文字水印"
    assert payload["tg_llm_prompt_selected_model"] == "gemini-3-flash-preview"


def test_tg_image_edit_prompt_rules_require_figure_roles():
    system_prompt, prompt_chain = server._build_tg_prompt_system_prompt("get_nano_banana", "image editing")

    assert prompt_chain == "image"
    assert "MUST include 图1 and 图2" in system_prompt
    assert "do not explain that 图1 is the main image or 图2 is the reference image" in system_prompt
    assert "older natural image-editing style" in system_prompt
    assert "将图1脸部和头发替换为图2的脸部与双马尾发型" in system_prompt
    assert "保持原姿势、身体、裸露状态、卧室、背景、光线与构图不变" in system_prompt
    assert "自然融合，无瑕疵，真实纹理" in system_prompt
    assert "never use a raw command phrase as the visual object" in system_prompt
    assert "Do not collapse the prompt into a rigid category-only sentence like 只有服装改变" in system_prompt
    assert "Do not output generic prefixes such as 只替换用户要求的部分" in system_prompt
    assert "only replace the user-requested area" in system_prompt
    assert "图1作为主图" not in system_prompt


def test_tg_image_edit_prompt_normalizes_two_image_roles(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "grok-test",
        },
    )

    def _fake_request(**kwargs):
        return {
            "ok": True,
            "raw_text": "將第一張圖片中女子換上粉色短款針織上衣與白色百褶短裙，保留原有坐姿、櫻花背景、雙馬尾髮型、面部特徵、燈光與構圖，自然貼合無變形",
        }

    monkeypatch.setattr(server.get_gemini, "request_gemini3_pro_raw_text", _fake_request)

    payload = server._enhance_tg_payload_with_llm_prompt(
        "get_nano_banana",
        {
            "prompt": "換衣服",
            "prompt_text": "換衣服",
            "message": "換衣服",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "User image editing request: 換衣服",
            "tg_original_user_request": "換衣服",
            "input_image_local_path": "data/main.jpg",
            "reference_image_local_path": "data/ref.jpg",
        },
    )

    final_prompt = payload["prompt"]
    assert final_prompt == "将图1人物身上的服装换成图2人物的服装，保持图1人物的五官、发型、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"
    assert "服装" in final_prompt
    assert "粉色" not in final_prompt
    assert "针织" not in final_prompt
    assert "百褶" not in final_prompt
    assert "只有服装改变" not in final_prompt
    assert "只替换用户要求的部分" not in final_prompt
    assert "将图1作为图1" not in final_prompt
    assert "图1作为主图" not in final_prompt
    assert "图2作为参考" not in final_prompt
    assert "將" not in final_prompt
    assert "換" not in final_prompt
    assert "無" not in final_prompt
    assert "雙" not in final_prompt
    assert "第一張圖片" not in final_prompt
    assert payload["prompt_text"] == final_prompt
    assert payload["message"] == final_prompt


def test_tg_image_edit_finalize_keeps_roles_for_custom_prompt():
    final_prompt = server._finalize_tg_image_generation_prompt_constraints(
        "get_nano_banana",
        {"tg_original_user_request": "换衣服"},
        "把主图人物换成参考图的服装，其他保持不变",
    )

    assert final_prompt == "把图1人物换成图2的服装，其他保持不变"
    assert "图1" in final_prompt
    assert "图2" in final_prompt
    assert "图1作为主图" not in final_prompt
    assert "图2作为参考" not in final_prompt
    assert "参考图" not in final_prompt


def test_tg_image_edit_prompt_format_supports_other_categories():
    hair_prompt = server._ensure_tg_image_edit_image_roles("换发型", "换发型", "get_nano_banana")

    assert hair_prompt == "将图1人物的发型换成图2人物的发型，保持图1人物的五官、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"
    assert "发型不变" not in hair_prompt


def test_tg_image_edit_prompt_keeps_clothing_word_for_simplified_and_traditional_requests():
    expected = "将图1人物身上的服装换成图2人物的服装，保持图1人物的五官、发型、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"

    assert server._ensure_tg_image_edit_image_roles("换衣服", "换衣服", "get_nano_banana") == expected
    assert server._ensure_tg_image_edit_image_roles("換衣服", "換衣服", "get_nano_banana") == expected


def test_tg_image_edit_prompt_keeps_outfit_word_for_outfit_requests():
    expected = "将图1人物的穿搭换成图2人物的穿搭，保持图1人物的五官、发型、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"

    assert server._ensure_tg_image_edit_image_roles("换衣服", "换穿搭", "get_nano_banana") == expected
    assert server._ensure_tg_image_edit_image_roles("换服装", "换搭配", "get_nano_banana") == expected


def test_tg_image_edit_prompt_preserves_natural_grok_prompt_with_figure_roles():
    raw_prompt = (
        "将图1脸部和头发替换为图2的脸部与双马尾发型，保持原姿势、身体、裸露状态、"
        "卧室、背景、光线与构图不变，自然融合，无瑕疵，真实纹理"
    )

    assert server._ensure_tg_image_edit_image_roles(raw_prompt, "换脸，换头发", "get_nano_banana") == raw_prompt


def test_tg_image_edit_prompt_formats_face_and_hair_like_old_version():
    expected = "将图1人物的脸部和头发换成图2人物的脸部和头发，保持图1人物的姿势、身体、构图、背景和光线不变，自然融合，质感真实"

    assert server._ensure_tg_image_edit_image_roles("换脸，换头发", "换脸，换头发", "get_nano_banana") == expected


def test_tg_image_edit_prompt_repairs_mechanical_command_noun_output():
    bad_prompt = (
        "将图1人物的换衣服替换为图2的换衣服，保持图1五官、发型、脸型、姿势、身体、"
        "构图、背景、光线和材质关系不变，自然融合，无瑕疵，真实纹理"
    )
    expected = "将图1人物身上的服装换成图2人物的服装，保持图1人物的五官、发型、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"

    assert server._ensure_tg_image_edit_image_roles(bad_prompt, "换衣服", "get_nano_banana") == expected


def test_tg_image_edit_prompt_handles_no_clothing_request_as_state_not_clothing():
    expected = "将图1人物的服装状态调整为图2人物的未穿衣物状态，保持图1人物的五官、发型、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"

    assert server._ensure_tg_image_edit_image_roles("没穿衣服", "没穿衣服", "get_nano_banana") == expected
    assert server._ensure_tg_image_edit_image_roles("裸體", "裸體", "get_nano_banana") == expected


def test_tg_image_edit_prompt_uses_grok_detected_no_clothing_reference_state():
    prompt = (
        "将图1人物身上的服装换成图2人物的未穿衣物状态，保持图1人物五官、发型、"
        "脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"
    )
    expected = "将图1人物的服装状态调整为图2人物的未穿衣物状态，保持图1人物的五官、发型、脸型、姿势、身体、构图、背景和光线不变，自然融合，质感真实"

    assert server._ensure_tg_image_edit_image_roles(prompt, "换衣服", "get_nano_banana") == expected


def test_tg_text_to_image_prompt_uses_automatic_script_person_contract_and_dedupes(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )

    captured: dict[str, str] = {}

    def _fake_request(*, model: str, **kwargs):
        captured["system_prompt"] = str(kwargs.get("system_prompt") or "")
        return {
            "ok": True,
            "parsed": {
                "prompt": (
                    "真实手机随手拍社交照片，事件优先叙事，像真实动态照片一样自然不完美的构图，"
                    "外观一致，同一个人，同一个人，不要文字，不要水印，不要水印，真实肢体语言，自然现场光"
                )
            },
        }

    monkeypatch.setattr(server.get_gemini, "request_gemini3_pro_json", _fake_request)
    payload = server._enhance_tg_payload_with_llm_prompt(
        "text_to_image",
        {
            "prompt": "生成室内人像",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "生成室内人像",
            "aspect_ratio": "2:3",
            "persona_label": "人设1捞女1金君雅",
        },
    )

    assert "Automatic-script" in captured["system_prompt"]
    assert "真实手机随手拍社交照片" in captured["system_prompt"]
    assert "最终必须写成中文" in captured["system_prompt"]
    assert "不要重复同一要求" in captured["system_prompt"]
    assert "同一个人" not in payload["prompt"]
    assert "外观一致" not in payload["prompt"]
    assert "外观保持一致" not in payload["prompt"]
    assert payload["prompt"].count("不要水印") == 1
    assert re.search(r"[A-Za-z][A-Za-z'-]{1,}", payload["prompt"]) is None
    assert payload["prompt_text"] == payload["prompt"]


def test_legacy_tg_image_prompt_builder_uses_automatic_script_contract():
    system_prompt, prompt_chain = server._build_tg_prompt_system_prompt("text_to_image", "text-to-image")

    assert prompt_chain == "image"
    assert "Automatic-script workflow girl/persona image" in system_prompt
    assert "真实手机随手拍社交照片" in system_prompt
    assert "LoRA controls appearance" in system_prompt
    assert "Final output must be Chinese only" in system_prompt


def test_automatic_person_prompt_rejects_english_fallback_text():
    assert server._normalize_tg_automatic_person_prompt("photorealistic candid smartphone social photo, same person, no watermark") == ""


def test_agent_task_payload_uses_llm_fallback_to_plan_replace_product(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    monkeypatch.setattr(
        server.get_gemini,
        "request_gemini3_pro_json",
        lambda **_kwargs: {
            "ok": True,
            "parsed": {
                "task_type": "replace_product",
                "summary": "识别为视频商品替换",
                "payload": {
                    "video_index": 0,
                    "image_index": 1,
                    "product_name": "测试商品",
                    "prompt_text": "自然替换商品，保持原视频镜头",
                    "duration_seconds": 12,
                },
            },
        },
    )

    typ, payload, summary = server._build_agent_task_payload(
        message="把视频里的商品换成这张图",
        file_infos=[
            {"name": "source.mp4", "path": "C:/tmp/source.mp4", "kind": "video"},
            {"name": "product.png", "path": "C:/tmp/product.png", "kind": "image"},
        ],
        use_ai_copy=True,
        default_duration=15,
    )

    assert typ == "replace_product"
    assert summary == "识别为视频商品替换"
    assert payload["video_local_path"] == "C:/tmp/source.mp4"
    assert payload["image_local_path"] == "C:/tmp/product.png"
    assert payload["prompt_text"] == "自然替换商品，保持原视频镜头"


def test_tg_agent_production_only_chat_does_not_create_task_payload(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    monkeypatch.setattr(
        server.get_gemini,
        "request_gemini3_pro_json",
        lambda **_kwargs: {
            "ok": True,
            "parsed": {
                "task_type": "chat",
                "summary": "用户只是问候",
                "payload": {"reply": "你好，请选择要创建的生产任务，或上传素材并说明需求。"},
            },
        },
    )

    typ, payload, summary = server._build_agent_task_payload(
        message="你好",
        file_infos=[],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "chat"
    assert summary == "用户只是问候"
    assert "生产任务" in payload["reply"]


def test_tg_agent_prompt_uses_workflow_skill_catalog(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    captured: dict[str, str] = {}

    def fake_request(**kwargs):
        captured["system_prompt"] = str(kwargs.get("system_prompt") or "")
        return {
            "ok": True,
            "parsed": {
                "skill": "chat",
                "task_type": "chat",
                "summary": "用户咨询能力",
                "payload": {"reply": "可以调用数字人视频生成、图片编辑和视频编辑工作流。"},
            },
        }

    monkeypatch.setattr(server.get_gemini, "request_gemini3_pro_json", fake_request)
    typ, payload, _summary = server._build_agent_task_payload(
        message="你能做什么",
        file_infos=[],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "chat"
    assert "workflow skills" in captured["system_prompt"]
    assert "digital_human_video" in captured["system_prompt"]
    assert "video_product_replace" in captured["system_prompt"]
    assert "不要选择未列出的 task_type" in captured["system_prompt"]
    assert "数字人视频生成" in payload["reply"]


def test_tg_agent_skill_field_is_authoritative_for_task_type(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    monkeypatch.setattr(
        server.get_gemini,
        "request_gemini3_pro_json",
        lambda **_kwargs: {
            "ok": True,
            "parsed": {
                "skill": "image_edit",
                "task_type": "get_gemini",
                "summary": "识别为图片编辑",
                "payload": {"input_image_index": 0, "prompt": "精修商品图"},
            },
        },
    )

    typ, payload, _summary = server._build_agent_task_payload(
        message="帮我把这张图修好",
        file_infos=[{"name": "product.png", "path": "C:/tmp/product.png", "kind": "image"}],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "image_generate"
    assert payload["product_image_local_path"] == "C:/tmp/product.png"


def test_tg_agent_guides_missing_materials_for_workflow_without_llm(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(server, "_get_runtime_config", lambda _conn: {})
    monkeypatch.setattr(server, "_resolve_llm_fallback_candidates", lambda *_args, **_kwargs: ("", []))

    typ, payload, summary = server._build_agent_task_payload(
        message="我要做视频商品替换",
        file_infos=[],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "chat"
    assert summary == "视频商品替换缺少原视频"
    assert "视频商品替换" in payload["reply"]
    assert "原视频" in payload["reply"]


def test_tg_agent_production_only_rejects_analysis_task_from_llm(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    monkeypatch.setattr(
        server.get_gemini,
        "request_gemini3_pro_json",
        lambda **_kwargs: {
            "ok": True,
            "parsed": {
                "task_type": "get_gemini",
                "summary": "分析用户问候",
                "payload": {"user_input": "你好"},
            },
        },
    )

    typ, payload, summary = server._build_agent_task_payload(
        message="你好",
        file_infos=[],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "chat"
    assert summary == "分析用户问候"
    assert payload["reply"]


def test_tg_agent_production_only_plans_image_generate(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    monkeypatch.setattr(
        server.get_gemini,
        "request_gemini3_pro_json",
        lambda **_kwargs: {
            "ok": True,
            "parsed": {
                "task_type": "image_generate",
                "summary": "识别为图片编辑",
                "payload": {"input_image_index": 0, "prompt": "精修商品图，真实电商摄影"},
            },
        },
    )

    typ, payload, summary = server._build_agent_task_payload(
        message="帮我把这张商品图修好",
        file_infos=[{"name": "product.png", "path": "C:/tmp/product.png", "kind": "image"}],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "image_generate"
    assert summary == "识别为图片编辑"
    assert payload["product_image_local_path"] == "C:/tmp/product.png"
    assert payload["image_generate_provider"] == "remote_comfy"


def test_tg_agent_union_skill_plans_menu_compatible_payload(monkeypatch):
    class DummyDb:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(server, "db", lambda: DummyDb())
    monkeypatch.setattr(
        server,
        "_get_runtime_config",
        lambda _conn: {
            "llm_base_url": "http://llm.local",
            "llm_api_key_gemini": "gemini-key",
            "llm_default_model_gemini": "gemini-3-flash-preview",
        },
    )
    monkeypatch.setattr(
        server.get_gemini,
        "request_gemini3_pro_json",
        lambda **_kwargs: {
            "ok": True,
            "parsed": {
                "skill": "video_union_replace",
                "task_type": "replace_productANDmodel",
                "summary": "识别为联合替换",
                "payload": {
                    "video_index": 0,
                    "model_image_index": 1,
                    "product_image_index": 2,
                    "product_name": "测试商品",
                },
            },
        },
    )

    typ, payload, summary = server._build_agent_task_payload(
        message="把视频里的模特和商品都换掉",
        file_infos=[
            {"name": "source.mp4", "path": "C:/tmp/source.mp4", "kind": "video"},
            {"name": "model.png", "path": "C:/tmp/model.png", "kind": "image"},
            {"name": "product.png", "path": "C:/tmp/product.png", "kind": "image"},
        ],
        use_ai_copy=True,
        default_duration=15,
        production_only=True,
    )

    assert typ == "replace_productANDmodel"
    assert summary == "识别为联合替换"
    assert payload["video_local_path"] == "C:/tmp/source.mp4"
    assert payload["model_image_local_path"] == "C:/tmp/model.png"
    assert payload["product_image_local_path"] == "C:/tmp/product.png"
    assert payload["product_params"]["product_name"] == "测试商品"


def test_tg_task_finish_notification_sends_output_file(monkeypatch, tmp_path):
    out_file = tmp_path / "result.png"
    out_file.write_bytes(b"image")
    calls: list[dict[str, object]] = []

    class Resp:
        status_code = 200
        text = "{}"

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return Resp()

    monkeypatch.setenv("TG_BOT_TOKEN", "tg-token")
    monkeypatch.setattr(server.requests, "post", fake_post)

    server._notify_tg_task_finished(
        task_id="task-tg",
        task_type="image_generate",
        payload={"tg_chat_id": 123456},
        status="success",
        error="",
        output_data={"ok": True, "image_path": str(out_file)},
    )

    assert calls
    assert str(calls[0]["url"]).endswith("/sendPhoto")
    assert calls[0]["data"]["chat_id"] == 123456
    assert "files" in calls[0]


def test_tg_task_finish_notification_sends_failure_message(monkeypatch):
    calls: list[dict[str, object]] = []

    class Resp:
        status_code = 200
        text = "{}"

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return Resp()

    monkeypatch.setenv("TG_BOT_TOKEN", "tg-token")
    monkeypatch.setattr(server.requests, "post", fake_post)

    server._notify_tg_task_finished(
        task_id="task-tg",
        task_type="replace_model",
        payload={"tg_chat_id": 123456},
        status="failed",
        error="boom",
        output_data={},
    )

    assert calls
    assert str(calls[0]["url"]).endswith("/sendMessage")
    assert calls[0]["data"]["chat_id"] == 123456
    assert "boom" in calls[0]["data"]["text"]


def test_internal_tg_union_accepts_agent_mixed_payload(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        model = root / "model.png"
        product = root / "product.png"
        video = root / "source.mp4"
        model.write_bytes(b"model")
        product.write_bytes(b"product")
        video.write_bytes(b"video")

        monkeypatch.setattr(server, "_enhance_tg_payload_with_llm_prompt", lambda task_type, payload: dict(payload))
        payload = server._build_internal_tg_task_payload(
            "task-union-agent",
            "replace_productANDmodel",
            {
                "mixed_image_paths": [str(model), str(product)],
                "video_paths": [str(video)],
                "product_name": "测试商品",
                "model_params": {"duration_seconds": 1},
                "product_params": {"duration_seconds": 1, "product_name": "测试商品"},
            },
        )

    assert payload["mixed_image_paths"] == [str(model), str(product)]
    assert payload["video_paths"] == [str(video)]
    assert payload["match_mode"] == "cycle"
    assert payload["fixed_index"] == 1
    assert payload["auto_rename"] is True


def test_apply_runtime_defaults_uses_runtime_chains_for_union(monkeypatch):
    runtime = {
        "runninghub_api_key": "rh-key",
        "replace_model_original_app_id": "3101",
        "replace_product_app_id": "4101",
    }

    monkeypatch.setattr(server, "db", lambda: nullcontext(object()))
    monkeypatch.setattr(server, "_get_runtime_config", lambda conn: runtime)

    payload = {
        "model_workflow_chain_ids": ["3101", "3102"],
        "product_workflow_chain_ids": ["4101", "4102"],
    }
    merged = server._apply_runtime_defaults("replace_productANDmodel", payload)

    assert merged["model_workflow_chain_ids"] == ["3101", "3102"]
    assert merged["product_workflow_chain_ids"] == ["4101", "4102"]
    assert merged["model_app_id"] == "3102"
    assert merged["product_app_id"] == "4102"
    assert merged["workflow_ids"] == ["3101", "3102", "4101", "4102"]
    assert merged["workflow_name"] == "联合替换商品和模特"


def test_apply_runtime_defaults_uses_dedicated_union_runtime_chains(monkeypatch):
    runtime = {
        "runninghub_api_key": "rh-key",
        "replace_model_original_app_id": "3101",
        "replace_product_app_id": "4101",
        "replace_union_model_workflow_ids": ["5101", "5102"],
        "replace_union_product_workflow_ids": ["6101", "6102"],
    }

    monkeypatch.setattr(server, "db", lambda: nullcontext(object()))
    monkeypatch.setattr(server, "_get_runtime_config", lambda conn: runtime)

    merged = server._apply_runtime_defaults("replace_productANDmodel", {})

    assert merged["model_workflow_chain_ids"] == ["5101", "5102"]
    assert merged["product_workflow_chain_ids"] == ["6101", "6102"]
    assert merged["model_app_id"] == "5102"
    assert merged["product_app_id"] == "6102"
    assert merged["workflow_ids"] == ["5101", "5102", "6101", "6102"]


def test_build_workflow_meta_uses_chain_ids_for_union():
    meta = server._build_workflow_meta(
        task_id="task-1",
        task_type="replace_productANDmodel",
        input_payload={
            "model_workflow_chain_ids": ["3101", "3102"],
            "product_workflow_chain_ids": ["4101", "4102"],
        },
        output_payload={"runninghub_task_ids": ["rt-1", "rt-2", "rt-3"]},
        runninghub_task_id="rt-0",
    )

    assert meta["workflow_name"] == "联合替换商品和模特"
    assert meta["workflow_ids"] == ["3101", "3102", "4101", "4102"]
    assert meta["workflow_chain_summary"] == "联合链 模特 2 步 + 商品 2 步"
    assert meta["workflow_step_count"] == 4
    assert meta["runninghub_task_ids"] == ["rt-0", "rt-1", "rt-2", "rt-3"]


def test_build_workflow_meta_uses_chain_summary_for_oral_chain():
    meta = server._build_workflow_meta(
        task_id="task-2",
        task_type="create_video",
        input_payload={
            "oral_digital_human_workflow_ids": ["1001", "1002", "1003"],
        },
        output_payload={},
        runninghub_task_id="",
    )

    assert meta["workflow_ids"] == ["1001", "1002", "1003"]
    assert meta["workflow_chain_summary"] == "口播链 3 步（音频 1 + 视频 2）"
    assert meta["workflow_step_count"] == 3


def test_build_workflow_meta_describes_mixed_oral_chain():
    meta = server._build_workflow_meta(
        task_id="task-oral-mixed",
        task_type="create_video",
        input_payload={
            "oral_digital_human_workflow_ids": [
                "closed_llm_model:gpt-5.5",
                "1001",
                "1002",
            ],
        },
        output_payload={},
        runninghub_task_id="",
    )

    assert meta["workflow_ids"] == ["闭源文字模型:gpt-5.5", "1001", "1002"]
    assert meta["workflow_chain_summary"] == "口播链 3 步（闭源文字 1 + RunningHub 2）"
    assert meta["workflow_step_count"] == 3


def test_create_video_uses_closed_llm_from_oral_chain_without_network(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        model_image = root / "model.png"
        product_image = root / "product.png"
        workdir = root / "work"
        scene_image = root / "scene.png"
        model_image.write_bytes(b"model")
        product_image.write_bytes(b"product")
        scene_image.write_bytes(b"scene")

        captured: dict[str, object] = {}

        monkeypatch.setattr(server, "_build_task_workdir", lambda task_id, fallback_username=None: workdir)
        def fake_request_gemini_json(**kwargs):
            captured["llm_model"] = kwargs.get("model")
            return {"ok": True, "parsed": {"speech_text": "口播文案", "prompt_text": "视频提示词"}}

        monkeypatch.setattr(server.get_gemini, "request_gemini3_pro_json", fake_request_gemini_json)

        def fake_generate_commerce_videos(**kwargs):
            captured["audio_app_id"] = kwargs["audio_settings"].app_id
            captured["video_app_ids"] = kwargs["video_workflow"].app_ids
            captured["scene_provider"] = kwargs["image_path_provider"](1, model_image, product_image)
            output_dir = Path(kwargs["output_dir"]).resolve()
            video_dir = output_dir / "videos"
            video_dir.mkdir(parents=True, exist_ok=True)
            (video_dir / "1.mp4").write_bytes(b"video")
            return {"output_dir": str(output_dir), "success": 1, "runninghub_task_ids": ["rh-video"]}

        monkeypatch.setattr(server.commerce_video_generator, "generate_commerce_videos", fake_generate_commerce_videos)

        result = server._run_create_video_with_doubao(
            "task-oral-closed",
            {
                "runninghub_api_key": "rh-key",
                "model_image_local_path": str(model_image),
                "product_image_local_path": str(product_image),
                "use_ai_copy": True,
                "product_name": "测试商品",
                "oral_digital_human_workflow_ids": [
                    "closed_llm_model:gpt-5.5",
                    "1001",
                    "1002",
                ],
                "llm_base_url": "http://llm.local",
                "llm_api_key_gpt": "gpt-key",
                "generated_scene_local_path": str(scene_image),
            },
        )

        assert result["ok"] is True
        assert captured["llm_model"] == "gpt-5.5"
        assert captured["audio_app_id"] == "1001"
        assert captured["video_app_ids"] == ["1002"]
        assert captured["scene_provider"] == str(scene_image)


def test_image_generate_without_comfy_mapping_refuses_closed_model_fallback(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        product = root / "product.png"
        product.write_bytes(b"product")
        out_root = root / "out"
        out_root.mkdir()

        with pytest.raises(RuntimeError, match="ComfyUI 网关未配置 image_generate 工作流映射"):
            server._run_image_generate(
                "task-image-closed",
                {
                    "image_generate_provider": "remote_comfy",
                    "product_image_local_path": str(product),
                    "prompt": "生成商品图",
                },
            )


def test_replace_union_executes_model_and_product_chains_without_network(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        model_dir = root / "models"
        product_dir = root / "products"
        video_dir = root / "videos"
        out_dir = root / "out"
        model_dir.mkdir()
        product_dir.mkdir()
        video_dir.mkdir()
        (model_dir / "1.png").write_bytes(b"model")
        (product_dir / "1.png").write_bytes(b"product")
        (video_dir / "1.mp4").write_bytes(b"video")

        calls: list[tuple[str, str, str]] = []
        submit_counter = {"value": 0}

        monkeypatch.setattr(replace_union, "upload_binary", lambda **kwargs: f"url://{Path(kwargs['file_path']).name}")
        monkeypatch.setattr(replace_union, "_probe_video_duration_seconds", lambda path: 5.0)
        monkeypatch.setattr(
            replace_union.replace_model,
            "_build_node_info_list",
            lambda **kwargs: [{"app_id": kwargs["app_id"], "video_path": kwargs["video_path"]}],
        )

        def fake_submit(*, api_key, app_id, node_info_list):
            submit_counter["value"] += 1
            calls.append(("submit", app_id, str(node_info_list[0].get("video_path") or "")))
            return {"task id": f"task-{submit_counter['value']}-{app_id}"}

        def fake_poll(*, task_id, api_key, output_path, poll_interval_seconds):
            Path(output_path).write_bytes(f"data:{task_id}".encode())
            return {"status": "success", "task_id": task_id}

        def fake_product_requests_api(**kwargs):
            calls.append(("product", kwargs["app_id"], str(kwargs["video_path"])))
            Path(kwargs["video_output_path"]).write_bytes(f"product:{kwargs['app_id']}".encode())
            return {"status": "success"}

        monkeypatch.setattr(replace_union, "_submit_task", fake_submit)
        monkeypatch.setattr(replace_union, "_poll_until_done", fake_poll)
        monkeypatch.setattr(replace_union.replace_product, "requests_api", fake_product_requests_api)

        result = replace_union.run_product_and_model_replace(
            rh_api_key="rh-key",
            model_dir=str(model_dir),
            product_dir=str(product_dir),
            video_dir=str(video_dir),
            output_dir=str(out_dir),
            model_app_ids=["m1", "m2"],
            product_app_ids=["p1", "p2"],
        )

        assert result["success"] == 1
        assert result["runninghub_task_ids"] == ["task-1-m1", "task-2-m2"]
        assert (Path(result["output_dir"]) / "final" / "1.mp4").exists()

        submit_paths = [item[2] for item in calls if item[0] == "submit"]
        product_paths = [item[2] for item in calls if item[0] == "product"]
        assert submit_paths == ["url://1.mp4", "url://1_step01.mp4"]
        assert product_paths == ["url://1.mp4", "url://1_step01.mp4"]


def test_run_replace_product_and_model_passes_chain_ids(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        model_dir = root / "models"
        product_dir = root / "products"
        video_dir = root / "videos"
        model_dir.mkdir()
        product_dir.mkdir()
        video_dir.mkdir()

        captured: dict[str, object] = {}

        monkeypatch.setattr(server, "_emit_stage", lambda *args, **kwargs: None)
        monkeypatch.setattr(server, "_build_task_workdir", lambda task_id, fallback_username=None: root / "task")
        monkeypatch.setattr(server, "_collect_batch_usage", lambda output_dir: {"ok": True})

        def fake_union_runner(**kwargs):
            captured.update(kwargs)
            out_dir = Path(str(kwargs["output_dir"]))
            out_dir.mkdir(parents=True, exist_ok=True)
            return {
                "output_dir": str(out_dir),
                "success": 1,
                "result_zip": "",
                "runninghub_task_ids": ["u1", "u2", "u3"],
            }

        monkeypatch.setattr(server.replace_productANDmodel, "run_product_and_model_replace", fake_union_runner)

        result = server._run_replace_product_and_model(
            "task-123",
            {
                "runninghub_api_key": "rh-key",
                "model_dir_path": str(model_dir),
                "product_dir_path": str(product_dir),
                "video_dir_path": str(video_dir),
                "model_workflow_chain_ids": ["mA", "mB"],
                "product_workflow_chain_ids": ["pA", "pB"],
            },
        )

        assert captured["model_app_ids"] == ["mA", "mB"]
        assert captured["product_app_ids"] == ["pA", "pB"]
        assert result["runninghub_task_id"] == "u3"
        assert result["runninghub_task_ids"] == ["u1", "u2", "u3"]


def test_build_task_execution_trace_for_replace_model_steps():
    trace = server._build_task_execution_trace(
        task_type="replace_model",
        output_data={
            "ok": True,
            "message": "done",
            "download_path": "/tmp/final.mp4",
            "raw_result": {
                "steps": [
                    {
                        "step": 1,
                        "app_id": "m1",
                        "output_path": "/tmp/step1.mp4",
                        "result": {"status": "success", "task_id": "rt-1", "message": "ok"},
                    },
                    {
                        "step": 2,
                        "app_id": "m2",
                        "output_path": "/tmp/final.mp4",
                        "result": {"status": "success", "task_id": "rt-2", "message": "ok"},
                    },
                ],
            },
        },
    )

    assert len(trace) == 1
    assert trace[0]["title"] == "视频模特替换链"
    assert trace[0]["final_output_path"] == "/tmp/final.mp4"
    assert [step["workflow_id"] for step in trace[0]["steps"]] == ["m1", "m2"]
    assert [step["runninghub_task_id"] for step in trace[0]["steps"]] == ["rt-1", "rt-2"]


def test_build_task_execution_trace_for_union_logs():
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        logs_path = out_dir / "logs.jsonl"
        logs_path.write_text(
            '{"job":1,"status":"success","final":"/tmp/final.mp4","stage_model":{"parts":[{"part":1,"steps":[{"step":1,"app_id":"m1","output_path":"/tmp/m1.mp4","done":{"status":"success","task_id":"rt-m1"}}]}]},"stage_product":{"parts":[{"part":1,"steps":[{"step":1,"app_id":"p1","output_path":"/tmp/p1.mp4","done":{"status":"success","task_id":"rt-p1"}}]}]}}\n',
            encoding="utf-8",
        )

        trace = server._build_task_execution_trace(
            task_type="replace_productANDmodel",
            output_data={"raw_result": {"output_dir": str(out_dir)}},
        )

        assert len(trace) == 2
        assert trace[0]["title"] == "联合替换·模特链 Job 1 / Part 1"
        assert trace[0]["steps"][0]["workflow_id"] == "m1"
        assert trace[0]["steps"][0]["runninghub_task_id"] == "rt-m1"
        assert trace[1]["title"] == "联合替换·商品链 Job 1 / Part 1"
        assert trace[1]["steps"][0]["workflow_id"] == "p1"
        assert trace[1]["steps"][0]["runninghub_task_id"] == "rt-p1"
