from __future__ import annotations

import pytest

from video_core.image_mode_prompts import (
    IMAGE_EDIT_DEFAULT_PROMPT,
    IMAGE_EDIT_ENVIRONMENT_INTEGRATION_PROMPT,
    IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT,
    SUBJECT_REPLACE_DEFAULT_USER_PROMPT,
    THREE_VIEW_DEFAULT_PROMPT,
    apply_product_only_prompt_constraints,
    build_image_mode_prompt,
    build_subject_replace_prompt,
    build_three_view_prompt,
    normalize_target_language,
    subject_replace_user_prompt,
)


def test_product_only_keeps_original_no_person_and_payload_semantics() -> None:
    payload = {
        "mode": "product_only",
        "prompt": "为咖啡机制作高级电商图",
        "model_image_local_path": "model.png",
        "model_image_local_paths": ["model.png"],
    }

    updated = apply_product_only_prompt_constraints(payload)
    prompt = build_image_mode_prompt(payload)

    assert "model_image_local_path" not in updated
    assert "model_image_local_paths" not in updated
    assert updated["ecommerce_model_reference_skipped"] is True
    assert updated["prompt"] == updated["prompt_text"]
    assert IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT in updated["tg_user_instruction"]
    assert "严禁新增任何真人、数字人、模特、销售顾问、导购、讲解员" in prompt
    assert "不要把图2人物直接裁切贴到图1上" in prompt
    assert payload["model_image_local_path"] == "model.png"


def test_model_product_absorbs_product_details_and_environment_constraints() -> None:
    prompt = build_image_mode_prompt(
        {
            "mode": "model_product",
            "prompt": "生成高端品牌海报",
            "product_description": "低噪运行，适合小户型",
        }
    )

    assert "用户填写的产品相关简介：低噪运行，适合小户型" in prompt
    assert "不要编造简介之外的价格、参数或承诺" in prompt
    assert IMAGE_EDIT_ENVIRONMENT_INTEGRATION_PROMPT in prompt
    assert IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT not in prompt


def test_digital_human_reference_has_priority_over_region_and_user_text() -> None:
    prompt = build_image_mode_prompt(
        {
            "mode": "digital_human_character",
            "prompt": "改成红色短发和西装",
            "digital_human_character_region": "japan",
            "character_reference_image_local_paths": ["front.png", "side.png"],
        }
    )

    assert "日本地区特征" in prompt
    assert "不得被表单预设、地区特征或补充文字覆盖" in prompt
    assert "必须综合所有参考图保持同一人物身份、发型、服装结构、正侧背一致性和体型比例" in prompt
    assert "不得用这些文字改变参考人物身份、性别、年龄段或核心气质" in prompt
    assert "正面、左侧面、背面并排展示" in prompt
    assert "不要出现文字、标签、箭头、尺寸线、Logo、水印" in prompt


def test_three_view_replaces_generic_poster_prompt_and_keeps_structure_rules() -> None:
    prompt = build_three_view_prompt(IMAGE_EDIT_DEFAULT_PROMPT)

    assert prompt.startswith(THREE_VIEW_DEFAULT_PROMPT)
    assert "这是同一产品的结构参考三视图，不是电商海报或广告图" in prompt
    assert "三个角度大小和比例一致" in prompt
    assert "禁止标题、卖点、参数、百分比、CTA、按钮" in prompt
    assert "不要生成商品详情页或促销海报" in prompt
    assert build_three_view_prompt(prompt) == prompt


@pytest.mark.parametrize(
    ("reference_fields", "required_text"),
    [
        (
            {
                "subject_replace_product_image_local_path": "product.png",
                "subject_replace_model_image_local_path": "model.png",
            },
            "绝不同时替换商品和人物",
        ),
        (
            {"subject_replace_product_image_local_path": "product.png"},
            "所有同类商品/同品类物体实例，并全部替换",
        ),
        (
            {"subject_replace_model_image_local_path": "model.png"},
            "不要替换商品、包装、道具、家具、背景或其他物体",
        ),
        ({}, "先判断 @Image 2 的主体类型"),
    ],
)
def test_subject_replace_preserves_reference_role_branches_and_source_text(
    reference_fields: dict[str, str],
    required_text: str,
) -> None:
    prompt = build_subject_replace_prompt({**reference_fields, "prompt": "只替换指定目标"})

    assert required_text in prompt
    assert "原位置、原语种、原内容、原字体风格保留" in prompt
    assert "不得删除、翻译、改写、重排、模糊化或用伪文字替换" in prompt
    assert "用户补充要求：只替换指定目标" in prompt
    assert "严禁生成广告海报版式" in prompt


def test_subject_replace_legacy_prompt_maps_to_original_safe_default() -> None:
    legacy = "主体替换局部编辑，不生成广告海报、标题、卖点文字、图标或Logo。"

    assert subject_replace_user_prompt({"prompt": legacy}) == SUBJECT_REPLACE_DEFAULT_USER_PROMPT


@pytest.mark.parametrize(
    ("language", "normalized", "label"),
    [
        ("英语", "English", "英文"),
        ("bahasa melayu", "Malay", "马来语"),
        ("日本語", "Japanese", "日语"),
        ("", "Chinese", "中文"),
    ],
)
def test_poster_translate_preserves_language_aliases_and_original_constraints(
    language: str,
    normalized: str,
    label: str,
) -> None:
    prompt = build_image_mode_prompt({"mode": "poster_translate", "target_language": language})

    assert normalize_target_language(language) == normalized
    assert f"都改写为自然准确的{label}" in prompt
    assert f"都要替换成{label}" in prompt
    assert "排版层级、文字区域位置、字体大小关系、颜色风格" in prompt
    assert "不要重新设计海报，不要改变产品外观，不要替换人物" in prompt
    assert "避免乱码、伪文字、拼写错误、混合语言和过长段落" in prompt


def test_dispatch_rejects_non_dedicated_mode_and_model_product_requires_prompt() -> None:
    with pytest.raises(ValueError, match="unsupported image_generate prompt mode"):
        build_image_mode_prompt({"mode": "scene_image", "prompt": "room"})
    with pytest.raises(RuntimeError, match="图片生成需要填写提示词"):
        build_image_mode_prompt({"mode": "model_product"})
