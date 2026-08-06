from __future__ import annotations

from copy import deepcopy

from video_core import ecommerce_ad_prompting as prompting


def test_model_workflow_normalization_matches_standard_runner_and_is_pure() -> None:
    payload = {
        "ecommerce_model": " Seedance-2.0 Fast ",
        "app_id": "legacy",
        "ecommerce_short_video_workflow_ids": ["legacy", "legacy"],
        "custom": {"keep": True},
    }
    original = deepcopy(payload)

    result = prompting.normalize_ecommerce_model_workflow(payload)

    assert payload == original
    assert result["workflow_id"] == prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID
    assert result["workflow_ids"] == [prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID]
    assert result["model"] == "seedance2.0fast"
    assert result["model_slug"] == "sparkvideo-2.0-fast"
    assert result["payload"]["app_id"] == prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID
    assert result["payload"]["ecommerce_short_video_app_id"] == prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID
    assert result["payload"]["workflow_chain_ids"] == [prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID]
    assert result["payload"]["custom"] == {"keep": True}


def test_model_workflow_falls_back_to_last_chain_value_then_standard_id() -> None:
    result = prompting.normalize_ecommerce_model_workflow(
        {"ecommerce_short_video_workflow_ids": "bad -> 2034917373414539278"}
    )
    assert result["workflow_ids"] == ["bad", prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID]
    assert result["workflow_id"] == prompting.ECOMMERCE_SHORT_VIDEO_FAST_APP_ID
    assert result["model"] == "seedance2.0fast"

    fallback = prompting.normalize_ecommerce_model_workflow({"app_id": "unsupported"})
    assert fallback["workflow_id"] == prompting.ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID
    assert fallback["model"] == "seedance2.0"


def test_product_category_preserves_runner_corrections_and_negative_clauses() -> None:
    assert prompting.normalize_ecommerce_product_category(
        "electronics", prompt="18L 燃气热水器，恒温大水量"
    ) == "sanitary_kitchen"
    assert prompting.normalize_ecommerce_product_category(
        "real_estate", prompt="核心商圈购物中心与中庭动线"
    ) == "commercial_space"
    assert prompting.normalize_ecommerce_product_category(
        "generic", prompt="不要写成宠物用品。厨房清洁喷雾，一擦即净"
    ) == "home_living"
    assert prompting.normalize_ecommerce_product_category("服装鞋包") == "apparel"


def test_creative_brief_normalization_fills_sections_and_formats_execution_guidance() -> None:
    raw = {
        "ontology": {
            "primary_subject": "  城市商业综合体  ",
            "selling_points": ["核心区位", "交通可达", "核心区位"],
            "recommended_scene_order": "建筑远景、中庭、餐饮休闲",
        },
        "quality_control": {"checks": ["不编造不可见信息", "产品不被人物抢焦点"]},
    }

    brief = prompting.normalize_ecommerce_creative_brief(
        raw,
        category="real_estate",
        prompt="购物中心商业综合体",
        image_count=3,
        has_model=True,
    )

    assert brief["ontology"]["product_type"] == "商业综合体/商场项目"
    assert brief["ontology"]["primary_subject"] == "城市商业综合体"
    assert brief["ontology"]["selling_points"] == ["核心区位", "交通可达"]
    assert brief["world_model"]["typical_environments"]
    assert brief["epistemology"]["forbidden_claims"]
    guidance = prompting.format_ecommerce_creative_brief_execution_guidance(brief)
    assert guidance.startswith("围绕城市商业综合体展开；突出核心区位、交通可达")
    assert "不得编造不可见信息" in guidance
    assert "产品不能被人物抢焦点" in guidance
    assert "ontology" not in guidance


def test_prompt_analysis_stripping_and_cleaning_match_runner_transformations() -> None:
    source = """# 本体分析：这是内部推理
0-5 seconds: 标准电商开场，产品英雄镜头，无背景音乐
5-10秒: 画面稳定承接前段尾帧，人物看向镜头自然总结说：真实好用
7.5 秒：模型说明
声音约束：只保留人物口播和必要环境声，无背景音。"""

    stripped = prompting.strip_ecommerce_analysis_from_execution_prompt(source)
    assert "本体分析" not in stripped
    cleaned = prompting.clean_ecommerce_video_prompt_text(stripped, product_category="generic")
    assert "0-5秒：" in cleaned
    assert "@Image 1产品完整清晰入镜" in cleaned
    assert "无背景音乐" not in cleaned
    assert "承接前段尾帧" not in cleaned
    assert "7.5 秒" not in cleaned
    assert "旁白：真实好用" in cleaned
    assert cleaned.count("无背景音。") == 1


def test_prompt_cleaning_drops_cross_category_dialogue_without_touching_valid_sentence() -> None:
    cleaned = prompting.clean_ecommerce_video_prompt_text(
        "0-5秒：客厅采光展示\n旁白：18升恒温大水量。南向采光让空间更通透。",
        product_category="real_estate",
    )

    assert "18升恒温大水量" not in cleaned
    assert "南向采光让空间更通透" in cleaned


def test_reference_constraints_cap_images_number_refs_and_leave_inputs_untouched() -> None:
    products = [f"product-{index}.png" for index in range(1, 11)]
    original = list(products)
    result = prompting.build_ecommerce_reference_constraints(
        product_paths=products,
        model_path="model.png",
        model_reference_skipped=False,
    )

    assert products == original
    assert result["reference_paths"] == products[:8] + ["model.png"]
    assert result["product_refs"] == [f"@Image {index}" for index in range(1, 9)]
    assert result["model_ref"] == "@Image 9"
    assert "@Image 9=模特/人物参考图" in result["reference_note"]
    assert "超过接口上限的产品图未提交给视频模型" in result["reference_note"]


def test_submission_constraints_keep_material_and_story_dialogue_rules_deterministic() -> None:
    payload = {
        "product_name": "City Mall",
        "product_details": "核心商圈，餐饮休闲配套集中",
        "copy_text": "周末来这里一次逛够",
        "ecommerce_ad_style": "story",
        "target_language": "English",
    }
    reference = prompting.build_ecommerce_reference_constraints(
        product_paths=["mall-1.png", "mall-2.png"],
        model_path="presenter.png",
    )

    result = prompting.build_ecommerce_submission_constraints(
        payload,
        reference_constraints=reference,
        has_audio=True,
    )

    assert result["model_performance_constraint"].startswith("人物规则：已上传人物参考图时")
    assert result["model_identity_constraint"].startswith("人物形象参考 @Image 3")
    assert result["copy_text_constraint"].startswith("用户补充的产品相关简介：")
    assert result["product_context_constraint"].startswith("商品名称：City Mall")
    assert result["audio_output_constraint"].startswith("如有旁白，使用上传的音色参考音频")
    assert "剧情模式声音" in result["audio_output_constraint"]
    assert "英文" in result["target_language_constraint"]
    assert result["sound_constraint"] == "无字幕，无背景音乐。"
    assert result["segment_constraints"][-1] == "禁止生成字幕、水印、海报文字或无关品牌标识。"


def test_compose_segment_prompt_deduplicates_constraints_and_preserves_dialogue_tail() -> None:
    prompt = "0-5秒：产品特写\n5-10秒：人物展示\n旁白：轻松解决日常问题"
    result = prompting.compose_ecommerce_segment_prompt(
        prompt=prompt,
        constraints=["主体规则。", "主体规则。", ""],
        sound_constraint="无字幕，无背景音乐。",
        preserve_dialogue=True,
    )

    assert result.count("主体规则。") == 1
    assert result.count("旁白：轻松解决日常问题") == 1
    assert result.endswith("无字幕，无背景音乐。")


def test_all_exports_are_deterministic_helpers_without_supplier_entrypoints() -> None:
    assert set(prompting.__all__) == {
        "ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID",
        "ECOMMERCE_SHORT_VIDEO_FAST_APP_ID",
        "build_ecommerce_reference_constraints",
        "build_ecommerce_submission_constraints",
        "clean_ecommerce_video_prompt_text",
        "compose_ecommerce_segment_prompt",
        "format_ecommerce_creative_brief_execution_guidance",
        "normalize_ecommerce_creative_brief",
        "normalize_ecommerce_model",
        "normalize_ecommerce_model_workflow",
        "normalize_ecommerce_product_category",
        "normalize_ecommerce_workflow_chain",
        "normalize_ecommerce_workflow_id",
        "strip_ecommerce_analysis_from_execution_prompt",
        "workflow_id_for_ecommerce_model",
    }
