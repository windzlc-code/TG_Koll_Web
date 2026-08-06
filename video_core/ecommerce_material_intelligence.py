from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

import requests

from .ecommerce_animation_redraw import _normalize_ecommerce_product_category


# These routines are copied from the original video platform's ecommerce
# prompt preparation path.  They remain backend-only and do not add controls to
# the workbench UI.
def build_ecommerce_material_analysis_system_prompt() -> str:
    return (
        "你是广告短视频素材预分析助手。请只输出严格 JSON，不要代码块，不要多余文字。"
        "你会收到多张产品/场景/资料图和可选人物图。你的任务不是写视频提示词，而是判断哪些图片对广告创作有有效信息。"
        "输出字段固定为："
        '{"product_category": string, "product_identity": object, "image_assessments": array, "search_query": string, "usable_image_indexes": array, "ignored_image_indexes": array, "visible_selling_points": array, "creative_notes": array}。'
        "product_category 必须从品类枚举中选择；product_identity 包含 brand、model、product_type、keywords，无法确认就留空。"
        "image_assessments 每项包含 index、role、usefulness、visible_info、reason；index 必须对应 @Image 编号。"
        "usable_image_indexes 只放最适合作为视频模型入参的少量产品相关图片，并按重要性重排序：主体/主图优先，其次关键细节、使用场景、包装型号；普通商品最多 3 张，房产空间最多 4 张。"
        "不要把用户上传的所有图片都放入 usable_image_indexes；重复图、弱相关图、信息页、氛围图和只提供辅助信息的图片，只写进 image_assessments 或 visible_selling_points。"
        "ignored_image_indexes 放模糊、重复、无关、只有装饰背景、信息价值低、不适合进入视频生成或只适合作为信息要素的图片。"
        "search_query 应该是适合联网检索的中文短查询，优先使用可见品牌、型号、品类和关键卖点；不要编造看不见的品牌型号。"
        "visible_selling_points 只写图片中可见或用户输入明确提供的信息；不要凭空写参数。"
    )


def ecommerce_creative_brief_schema_instruction() -> str:
    return (
        "你必须先做广告短视频内部创作推理，再生成最终执行提示词。"
        "输出 JSON 必须包含 creative_brief 对象、segments 数组和 execution_prompt 字符串。"
        "creative_brief 只给系统内部使用，不得把它的标题或分析过程写进 execution_prompt。"
        "creative_brief 结构为："
        "{"
        '"ontology": {"product_type": string, "core_essence": string, "primary_subject": string, "scene_objects": string[], "selling_points": string[], "human_role": string, "human_product_relationship": string, "recommended_scene_order": string[], "interaction_logic": string[], "avoid_focus": string[]}, '
        '"epistemology": {"visible_facts": string[], "reasonable_inferences": string[], "unknowns": string[], "forbidden_claims": string[]}, '
        '"world_model": {"typical_environments": string[], "reasonable_actions": string[], "unreasonable_actions": string[], "scene_progression": string[]}, '
        '"axiology": {"user_benefits": string[], "emotional_value": string, "conversion_points": string[]}, '
        '"narratology": {"opening": string, "progression": string[], "ending": string, "segment_logic": string}, '
        '"methodology": {"creation_steps": string[]}, '
        '"cinematic_language": {"shot_strategy": string[], "camera_motion": string[], "sound_rules": string[]}, '
        '"quality_control": {"checks": string[]}'
        "}。"
        "segments 是给后端确定性渲染的半结构化广告分镜，不要在其中写规则说明。"
        'segments 结构为：[{"duration": number, "shots": [{"seconds": number, "scene": string, "camera": string, "visual": string, "image_refs": number[], "has_person": boolean}], "narration": string}]。'
        "shots[].seconds 只表示镜头相对权重，不要自己写 0-30 秒时间轴；后端会重新分配每段时间。"
        "shots[].visual 只写画面，不写必须、不要、只做、作为辅助、规则、限制、模型注意事项等控制语言。"
        "image_refs 只填真实图片编号；如果该镜头没有人物出场，不要引用人物参考图。"
        "narration 是该片段尾部的一行短旁白；可以为空。人物说话内容要直接写进对应分镜；只有旁白才统一写在片段最后。"
        "creative_brief 必须根据图片内容和用户需求推导：先判断产品或项目本质，再判断可见事实、合理推断、不可编造内容、真实世界使用方式、用户价值、叙事推进、镜头语言和质量自查。"
        "segments 用于后端稳定拆分；execution_prompt 是最终给视频模型执行、也给用户确认的完整导演稿，绝不能只写摘要。"
        "execution_prompt 只允许包含时间轴、图片编号、景别运镜、人物或产品动作、对白或短旁白、产品卖点和必要限制。"
        "每个主要镜头都要对应具体卖点、使用结果或购买理由；每个 15 秒片段通常写 4 个镜头，时间轴只使用整数秒。"
        "每个 15 秒片段最多 1 行短旁白，统一放在该片段所有时间轴之后。"
        "execution_prompt 每个分镜只写一个明确画面，并交代主体或场景、构图重心、镜头运动、光线材质和动作结果。"
        "execution_prompt 严禁出现 creative_brief、ontology、epistemology、methodology 等分析标题或 JSON 内容。"
    )


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _truncate_text(value: Any, *, max_len: int) -> str:
    return str(value or "").strip()[:max_len]


def _truncate_string_list(value: Any, *, max_items: int = 24, max_string: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item or "").strip()[:max_string] for item in value[:max_items] if str(item or "").strip()]


def normalize_ecommerce_material_analysis(raw: Any, *, image_count: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    usable: list[int] = []
    ignored: list[int] = []
    for item in raw.get("usable_image_indexes") or []:
        idx = _to_int(item, 0)
        if 1 <= idx <= image_count and idx not in usable:
            usable.append(idx)
    for item in raw.get("ignored_image_indexes") or []:
        idx = _to_int(item, 0)
        if 1 <= idx <= image_count and idx not in ignored and idx not in usable:
            ignored.append(idx)
    if not usable and image_count > 0:
        usable = list(range(1, image_count + 1))
    assessments: list[dict[str, Any]] = []
    for item in raw.get("image_assessments") or []:
        if not isinstance(item, dict):
            continue
        idx = _to_int(item.get("index"), 0)
        if not (1 <= idx <= image_count):
            continue
        assessments.append(
            {
                "index": idx,
                "role": _truncate_text(item.get("role"), max_len=80),
                "usefulness": _truncate_text(item.get("usefulness"), max_len=80),
                "visible_info": _truncate_string_list(item.get("visible_info"), max_string=120),
                "reason": _truncate_text(item.get("reason"), max_len=160),
            }
        )
    identity = raw.get("product_identity") if isinstance(raw.get("product_identity"), dict) else {}
    return {
        "product_category": _normalize_ecommerce_product_category(raw.get("product_category")),
        "product_identity": {
            "brand": _truncate_text(identity.get("brand"), max_len=80),
            "model": _truncate_text(identity.get("model"), max_len=80),
            "product_type": _truncate_text(identity.get("product_type"), max_len=100),
            "keywords": _truncate_string_list(identity.get("keywords"), max_string=80),
        },
        "image_assessments": assessments,
        "search_query": _truncate_text(raw.get("search_query"), max_len=160),
        "usable_image_indexes": usable,
        "ignored_image_indexes": ignored,
        "visible_selling_points": _truncate_string_list(raw.get("visible_selling_points"), max_string=160),
        "creative_notes": _truncate_string_list(raw.get("creative_notes"), max_string=160),
    }


def _unique_path_texts(paths: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in paths or []:
        text = str(item or "").strip()
        if not text:
            continue
        key = str(Path(text).expanduser().resolve()) if not re.match(r"^https?://", text, re.I) else text
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def select_ecommerce_effective_references(
    *,
    product_paths: list[str],
    model_path: str = "",
    material_analysis: Any = None,
    max_images: int = 9,
    priority_product_paths: list[str] | None = None,
) -> dict[str, Any]:
    products = _unique_path_texts(product_paths)
    priority_products = [item for item in _unique_path_texts(priority_product_paths or []) if item in products]
    model_text = str(model_path or "").strip()
    original_refs = list(products)
    model_original_index = 0
    if model_text and model_text not in original_refs:
        original_refs.append(model_text)
        model_original_index = len(original_refs)
    elif model_text:
        model_original_index = original_refs.index(model_text) + 1

    analysis = material_analysis if isinstance(material_analysis, dict) else {}
    usable_indexes = [
        _to_int(item, 0)
        for item in analysis.get("usable_image_indexes") or []
        if 1 <= _to_int(item, 0) <= len(original_refs)
    ]
    ignored_indexes = {
        _to_int(item, 0)
        for item in analysis.get("ignored_image_indexes") or []
        if 1 <= _to_int(item, 0) <= len(original_refs)
    }

    selected_products: list[str] = []
    selected_original_indexes: list[int] = []
    for path_text in priority_products:
        if path_text not in selected_products:
            selected_products.append(path_text)
            selected_original_indexes.append(products.index(path_text) + 1)
    if usable_indexes:
        for idx in usable_indexes:
            if idx == model_original_index or idx > len(products):
                continue
            path_text = products[idx - 1]
            if path_text not in selected_products:
                selected_products.append(path_text)
                selected_original_indexes.append(idx)
    else:
        for idx, path_text in enumerate(products, start=1):
            if idx not in ignored_indexes:
                selected_products.append(path_text)
                selected_original_indexes.append(idx)
    if not selected_products and products:
        selected_products = [products[0]]
        selected_original_indexes = [1]

    category = _normalize_ecommerce_product_category(analysis.get("product_category"))
    product_selection_cap = 4 if category == "real_estate" else 3
    product_limit = max(min(max_images - (1 if model_text else 0), product_selection_cap), 1)
    selected_products = selected_products[:product_limit]
    selected_original_indexes = selected_original_indexes[:product_limit]
    reference_paths = list(selected_products)
    model_index = 0
    if model_text and len(reference_paths) < max_images:
        reference_paths.append(model_text)
        model_index = len(reference_paths)

    reference_order: list[str] = []
    for idx, _path_text in enumerate(reference_paths, start=1):
        if model_index and idx == model_index:
            reference_order.append(f"@Image {idx}=模特/人物参考图")
        else:
            original_index = selected_original_indexes[idx - 1] if idx - 1 < len(selected_original_indexes) else idx
            reference_order.append(f"@Image {idx}=产品/场景有效图，来自原上传图{original_index}")
    return {
        "product_image_local_paths": selected_products,
        "reference_paths": reference_paths,
        "reference_order": reference_order,
        "selected_original_indexes": selected_original_indexes,
        "ignored_original_indexes": sorted(ignored_indexes),
        "model_image_index": model_index,
        "original_reference_count": len(original_refs),
    }


def analyze_ecommerce_materials(
    *,
    source: dict[str, Any],
    parameters: dict[str, Any],
    image_paths: list[str],
    request_json: Callable[..., Any],
) -> dict[str, Any]:
    if not image_paths:
        return {}
    analysis_context = {
        "task_type": "ecommerce_material_analysis",
        "user_instruction": parameters.get("prompt_text") or parameters.get("prompt") or "",
        "duration_seconds": parameters.get("duration") or parameters.get("duration_seconds") or 15,
        "current_fields": {
            "image_reference_order": [f"@Image {index}=上传素材" for index in range(1, len(image_paths) + 1)],
            "user_prompt": parameters.get("prompt_text") or parameters.get("prompt") or "",
            "product_name": parameters.get("product_name") or "",
        },
    }
    result = request_json(
        source=source,
        user_input=analysis_context,
        system_prompt=build_ecommerce_material_analysis_system_prompt(),
        image_paths=image_paths,
        request_label="广告素材分析",
    )
    parsed = result.get("parsed") if isinstance(result, dict) else None
    return normalize_ecommerce_material_analysis(parsed, image_count=len(image_paths))


def ecommerce_material_search_query(
    analysis: dict[str, Any],
    *,
    user_instruction: str = "",
    product_name: str = "",
    product_details: str = "",
) -> str:
    query = str((analysis or {}).get("search_query") or "").strip()
    if query:
        return query[:160]
    identity = (analysis or {}).get("product_identity") if isinstance((analysis or {}).get("product_identity"), dict) else {}
    parts = [
        str(identity.get("brand") or "").strip(),
        str(identity.get("model") or "").strip(),
        str(identity.get("product_type") or "").strip(),
    ]
    if not any(parts):
        generic_names = {"商品", "产品", "產品"}
        product_text = str(product_name or "").strip()
        details_text = str(product_details or "").strip()
        instruction_text = str(user_instruction or "").strip()
        if product_text in generic_names and not details_text and len(instruction_text) > 80:
            return ""
        parts = [product_text]
        if details_text:
            parts.append(details_text[:60])
        elif product_text in generic_names or not product_text:
            parts.append(instruction_text)
    query = re.sub(r"\s+", " ", " ".join(part for part in parts if part)).strip()
    if query and "卖点" not in query:
        query = f"{query} 卖点 参数 介绍"
    return query[:160]


def search_ecommerce_product_web_info(
    query: str,
    *,
    max_results: int = 4,
    http_get: Callable[..., Any] = requests.get,
) -> dict[str, Any]:
    query = str(query or "").strip()
    if not query:
        return {"query": "", "results": [], "error": ""}
    try:
        response = http_get(
            "https://duckduckgo.com/html/",
            params={"q": query},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8,
        )
        response.raise_for_status()
        html_text = response.text
    except Exception as exc:
        return {"query": query, "results": [], "error": str(exc)[:240]}
    results: list[dict[str, str]] = []
    pattern = re.compile(
        r'<a[^>]+class="result__a"[^>]*href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>.*?'
        r'<a[^>]+class="result__snippet"[^>]*>(?P<snippet>.*?)</a>',
        re.S,
    )
    for match in pattern.finditer(html_text):
        title = re.sub(r"<.*?>", "", match.group("title"))
        snippet = re.sub(r"<.*?>", "", match.group("snippet"))
        url = match.group("url")
        title = re.sub(r"\s+", " ", title).strip()
        snippet = re.sub(r"\s+", " ", snippet).strip()
        if title:
            results.append({"title": title[:120], "snippet": snippet[:220], "url": url[:240]})
        if len(results) >= max_results:
            break
    return {"query": query, "results": results, "error": "" if results else "未检索到可用结果"}


def build_ecommerce_product_web_research_context(research: Any) -> dict[str, Any]:
    if not isinstance(research, dict):
        return {"query": "", "results": [], "summary_lines": [], "error": ""}
    results = research.get("results") if isinstance(research.get("results"), list) else []
    compact_results: list[dict[str, str]] = []
    summary_lines: list[str] = []
    for index, item in enumerate(results[:4], start=1):
        if not isinstance(item, dict):
            continue
        title = re.sub(r"\s+", " ", str(item.get("title") or "").strip())
        snippet = re.sub(r"\s+", " ", str(item.get("snippet") or "").strip())
        url = re.sub(r"\s+", " ", str(item.get("url") or "").strip())
        if not title and not snippet:
            continue
        compact_results.append({"title": title[:120], "snippet": snippet[:220], "url": url[:240]})
        line = f"{index}. {title}" if title else f"{index}."
        if snippet:
            line = f"{line}：{snippet}"
        summary_lines.append(line[:240])
    return {
        "query": _truncate_text(research.get("query"), max_len=160),
        "results": compact_results,
        "summary_lines": summary_lines,
        "error": _truncate_text(research.get("error"), max_len=240),
    }
