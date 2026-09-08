from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from video_core.image_mode_prompts import IMAGE_EDIT_DEFAULT_PROMPT
from video_core.source import voice_presets


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

_SERVER = None


def bind_server(server: Any) -> None:
    global _SERVER
    _SERVER = server


def _S() -> Any:
    if _SERVER is None:
        from . import server as server_module
        return server_module
    return _SERVER


def _to_int(value: Any, default: int = 0) -> int:
    return _S()._to_int(value, default)


def _to_bool(value: Any, default: bool = False) -> bool:
    return _S()._to_bool(value, default)


def db():
    return _S().db()


def _get_runtime_config(conn) -> dict[str, Any]:
    return _S()._get_runtime_config(conn)


def _resolve_llm_fallback_candidates(runtime, allow_builtin: bool = True):
    return _S()._resolve_llm_fallback_candidates(runtime, allow_builtin=allow_builtin)


def _request_llm_json_with_fallback(**kwargs: Any):
    result, selected, attempts = _S()._request_llm_json_with_fallback(**kwargs)
    if isinstance(result, dict) and not isinstance(result.get("parsed"), dict):
        raw = str(result.get("raw_text") or "").strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
            raw = re.sub(r"\s*```$", "", raw)
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            result = dict(result)
            result["parsed"] = parsed
    return result, selected, attempts


TG_AGENT_PRODUCTION_TASK_TYPES = {
    "create_video",
    "ecommerce_short_video",
    "image_generate",
    "replace_model",
    "replace_product",
    "replace_productANDmodel",
}

TG_AGENT_WORKFLOW_SKILLS: tuple[dict[str, Any], ...] = (
    {
        "skill": "digital_human_video",
        "task_type": "create_video",
        "label": "数字人视频生成",
        "intent": "把素材生成口播数字人视频，包含文案/提示词/人像/最终视频链路。",
        "required_materials": ["至少 1 张人物/商品参考图；如果用户提供口播视频或人像图，也可作为补充素材"],
        "payload_schema": "model_image_index, product_image_index?, style_hint, duration_seconds, use_ai_copy",
        "aliases": ["数字人", "口播", "视频生成", "带货视频", "生成视频"],
    },
    {
        "skill": "image_edit",
        "task_type": "image_generate",
        "label": "电商广告图生产",
        "intent": "根据商品图、人物图、场景图或参考图生成电商宣传海报/广告图。",
        "required_materials": ["1 张参考图或商品图", "图片修改说明"],
        "payload_schema": "input_image_index, prompt, image_generate_model?",
        "aliases": ["电商广告图生产", "电商广告图", "广告图生产", "宣传海报", "海报图", "图片融合", "图片编辑", "图像编辑", "修图", "生图", "改图", "商品图"],
    },
    {
        "skill": "ecommerce_short_video",
        "task_type": "ecommerce_short_video",
        "label": "广告短视频工作流",
        "intent": "根据产品图、可选模特图和可选补充要求，生成带镜头台词的电商图生视频；人物说话内容要写进对应镜头，旁白才放在片段末尾。",
        "required_materials": ["1 张产品图片", "可选 1 张模特图片", "可选补充要求"],
        "payload_schema": "product_image_index, model_image_index?, user_prompt",
        "aliases": ["广告短视频", "广告片", "电商短视频", "商品短视频", "产品短视频", "图生视频", "短视频工作流"],
    },
    {
        "skill": "video_model_replace",
        "task_type": "replace_model",
        "label": "视频模特替换",
        "intent": "把原视频中的人物/模特替换成用户上传的人像。",
        "required_materials": ["1 个原视频", "1 张模特/人物图", "可选替换说明"],
        "payload_schema": "video_index, image_index, prompt, duration_seconds",
        "aliases": ["模特替换", "视频模特", "换模特", "换脸", "人物替换"],
    },
    {
        "skill": "video_product_replace",
        "task_type": "replace_product",
        "label": "视频商品替换",
        "intent": "把原视频中的商品替换成用户上传的新商品图。",
        "required_materials": ["1 个原视频", "1 张商品图", "商品名或替换说明"],
        "payload_schema": "video_index, image_index, product_name, prompt_text, duration_seconds",
        "aliases": ["商品替换", "视频商品", "换商品", "替换商品"],
    },
    {
        "skill": "video_union_replace",
        "task_type": "replace_productANDmodel",
        "label": "联合替换",
        "intent": "批量或同时执行视频模特替换与视频商品替换。",
        "required_materials": ["3 个 zip（model/product/video）", "或混传多张人物/商品图加原视频"],
        "payload_schema": "model_zip_index/product_zip_index/video_zip_index 或 mixed_image_indices + video_indices",
        "aliases": ["联合替换", "批量替换", "模特商品一起换", "人物商品一起换"],
    },
)

TG_AGENT_WORKFLOW_SKILL_LABELS = {
    str(item["task_type"]): str(item["label"]) for item in TG_AGENT_WORKFLOW_SKILLS
}
TG_AGENT_WORKFLOW_SKILL_TASK_TYPES = {
    str(item["skill"]): str(item["task_type"]) for item in TG_AGENT_WORKFLOW_SKILLS
}

def _extract_duration_seconds(text: str, default_seconds: int = 15) -> int:
    m = re.search(r"(\d{1,3})\s*秒", str(text or ""))
    if m:
        return max(min(_to_int(m.group(1), default_seconds), 120), 1)
    return max(min(int(default_seconds), 120), 1)

def _extract_product_name(text: str, default_name: str = "商品") -> str:
    source = str(text or "")
    m = re.search(r"(?:商品名|商品名称|商品)[:： ]*([^\s，。,；;]{1,20})", source)
    if m:
        return str(m.group(1) or "").strip() or default_name
    return default_name

def _extract_url_by_suffix(text: str, suffixes: set[str]) -> str:
    source = str(text or "")
    for m in re.finditer(r"https?://[^\s]+", source):
        cand = str(m.group(0) or "").strip().strip(",，。)")
        low = cand.lower()
        if any(low.endswith(ext) for ext in suffixes):
            return cand
    return ""

def _normalize_audio_emotion(value: Any, default: str = "neutral") -> str:
    text = str(value or "").strip().lower()
    aliases = {
        "中性": "neutral",
        "自然": "neutral",
        "平稳": "neutral",
        "平穩": "neutral",
        "冷静": "calm",
        "冷靜": "calm",
        "沉稳": "calm",
        "沉穩": "calm",
        "开心": "happy",
        "開心": "happy",
        "高兴": "happy",
        "高興": "happy",
        "愉快": "happy",
        "兴奋": "excited",
        "興奮": "excited",
        "激动": "excited",
        "激動": "excited",
        "悲伤": "sad",
        "悲傷": "sad",
        "难过": "sad",
        "難過": "sad",
        "严肃": "serious",
        "嚴肅": "serious",
        "认真": "serious",
        "認真": "serious",
    }
    allowed = {"neutral", "calm", "happy", "excited", "sad", "serious"}
    normalized = aliases.get(text, text)
    if normalized in allowed:
        return normalized
    return str(default or "neutral").strip().lower() if str(default or "").strip() else "neutral"

def _tg_agent_workflow_skill_catalog_text() -> str:
    rows: list[dict[str, Any]] = []
    for item in TG_AGENT_WORKFLOW_SKILLS:
        rows.append(
            {
                "skill": item["skill"],
                "task_type": item["task_type"],
                "label": item["label"],
                "intent": item["intent"],
                "required_materials": item["required_materials"],
                "payload_schema": item["payload_schema"],
                "aliases": item["aliases"],
            }
        )
    return json.dumps(rows, ensure_ascii=False, indent=2)

def _tg_agent_missing_material_reply(task_type: str, reason: str = "") -> str:
    label = TG_AGENT_WORKFLOW_SKILL_LABELS.get(str(task_type or "").strip(), "这个工作流")
    required = ""
    for item in TG_AGENT_WORKFLOW_SKILLS:
        if item.get("task_type") == task_type:
            required = "、".join(str(x) for x in item.get("required_materials", []))
            break
    if not required:
        required = "对应素材和具体任务说明"
    suffix = f"当前缺少：{reason}。" if str(reason or "").strip() else ""
    return f"可以走「{label}」工作流。{suffix}请补充{required}，我收到后会继续帮你创建任务。"

def _agent_chat_payload(reply: str = "", summary: str = "") -> tuple[str, dict[str, Any], str]:
    text = str(reply or "").strip() or (
        "我可以帮你建立生产任务：数字人视频生成、广告短视频、电商广告图生产、视频商品替换、视频模特替换或联合替换。"
        "请上传对应素材，并说明你要做哪一种任务。"
    )
    return "chat", {"reply": text}, str(summary or "未创建生产任务").strip() or "未创建生产任务"

def _build_agent_task_payload(
    *,
    message: str,
    file_infos: list[dict[str, str]],
    use_ai_copy: bool,
    default_duration: int,
    production_only: bool = False,
) -> tuple[str, dict[str, Any], str]:
    text = str(message or "").strip()
    low = text.lower()
    images = [f for f in file_infos if f.get("kind") == "image"]
    videos = [f for f in file_infos if f.get("kind") == "video"]
    zips = [f for f in file_infos if f.get("kind") == "zip"]
    duration_seconds = _extract_duration_seconds(text, default_duration)
    product_name = _extract_product_name(text, "商品")

    with db() as conn:
        runtime = _get_runtime_config(conn)
    llm_base_url, llm_candidates = _resolve_llm_fallback_candidates(runtime, allow_builtin=True)
    if llm_base_url and llm_candidates:
        file_brief = [
            {"index": i, "name": str(f.get("name") or ""), "kind": str(f.get("kind") or ""), "path": str(f.get("path") or "")}
            for i, f in enumerate(file_infos or [])
        ]
        if production_only:
            planner_prompt = (
                "你是 Telegram 工作流调度助手，只负责引导用户使用工作流，以及在素材齐全时创建工作流任务。"
                "请根据用户消息与附件，从下面的 workflow skills 中选择一个 skill，或选择 chat 继续追问。"
                "不要回答与工作流无关的内容，不要发散创作，不要选择未列出的 task_type，不要创建分析型任务。\n"
                "workflow skills：\n"
                f"{_tg_agent_workflow_skill_catalog_text()}\n"
                "重要规则：\n"
                "- 用户只是问候、闲聊、咨询能力、需求不完整或缺少必要素材时，必须选择 chat，并用 reply 引导用户补充某个具体工作流需要的素材。\n"
                "- 用户意图明确且素材齐全时，才选择对应生产 task_type。\n"
                "- 如果用户上传素材但未说明任务，选择 chat 询问要使用哪个 workflow skill。\n"
                "输出 JSON 结构：\n"
                "{\n"
                '  "skill": "chat|digital_human_video|ecommerce_short_video|image_edit|video_model_replace|video_product_replace|video_union_replace",\n'
                '  "task_type": "chat|create_video|ecommerce_short_video|image_generate|replace_model|replace_product|replace_productANDmodel",\n'
                '  "summary": "一句话说明判断结果",\n'
                '  "payload": { ... }\n'
                "}\n"
                "payload 约束（只填需要的字段）：\n"
                "- chat：reply（str，回复用户并引导其补充具体任务和素材）\n"
                "- create_video：model_image_index（int），product_image_index（int，可缺省），style_hint（str），duration_seconds（int），use_ai_copy（bool）\n"
                "- ecommerce_short_video：product_image_index（int），model_image_index（int，可缺省），user_prompt（str，可空；用户补充要求，文案必须交给后续提示词生成，并在每个片段所有时间轴之后统一写一行“旁白：...”，不要单独输出文案字段）\n"
                "- image_generate：input_image_index（int），prompt（str），可选 image_generate_model（str）\n"
                "- replace_model：video_index（int），image_index（int），prompt（str，可空），duration_seconds（int）\n"
                "- replace_product：video_index（int），image_index（int），product_name（str），prompt_text（str），duration_seconds（int）\n"
                "- replace_productANDmodel：优先使用 video_index + model_image_index + product_image_index；也可使用 model_zip_index/product_zip_index/video_zip_index，或 mixed_image_indices + video_indices\n"
                f"默认参数：duration_seconds={duration_seconds}，product_name={product_name}。\n"
                "附件列表：\n"
                f"{json.dumps(file_brief, ensure_ascii=False)}\n"
                f"用户消息：{text}\n"
            )
        else:
            planner_prompt = (
                "你是一个任务编排器。请根据用户消息与附件，选择最合适的任务类型，并输出严格 JSON（不要代码块、不要多余文字）。\n"
                "可选 task_type：\n"
                "- create_video（带货视频，默认主流程）\n"
                "- image_generate（电商广告图生产）\n"
                "- ecommerce_short_video（广告短视频图生视频）\n"
                "- replace_model（换模特）\n"
                "- replace_product（换商品）\n"
                "- replace_productANDmodel（联合替换：可 3 个 zip（model/product/video），或混传图片+视频自动分拣）\n"
                "- create_audio（配音/音频）\n"
                "- get_nano_banana（闭源图像编辑兼容入口）\n"
                "- get_gemini（纯分析/生成结构化参数）\n"
                "输出 JSON 结构：\n"
                "{\n"
                '  "task_type": "create_video|ecommerce_short_video|image_generate|replace_model|replace_product|replace_productANDmodel|create_audio|get_nano_banana|get_gemini",\n'
                '  "summary": "一句话说明你要做什么",\n'
                '  "payload": { ... }\n'
                "}\n"
                "payload 约束（只填需要的字段）：\n"
                "- create_video：\n"
                "  - model_image_index（int）模特图在附件列表的 index\n"
                "  - product_image_index（int）商品图在附件列表的 index，可缺省则等于 model_image_index\n"
                "  - style_hint（str）风格提示；duration_seconds（int）；use_ai_copy（bool）\n"
                "- image_generate：input_image_index（int），prompt（str），可选 image_generate_model（str）\n"
                "- ecommerce_short_video：product_image_index（int），model_image_index（int，可缺省），user_prompt（str，可空；用户补充要求，文案必须交给后续提示词生成，并在每个片段所有时间轴之后统一写一行“旁白：...”，不要单独输出文案字段）\n"
                "- replace_model：video_index（int），image_index（int），prompt（str，可空），duration_seconds（int）\n"
                "- replace_product：video_index（int），image_index（int），product_name（str），prompt_text（str），duration_seconds（int）\n"
                "- replace_productANDmodel：\n"
                "  - 方案A：model_zip_index/product_zip_index/video_zip_index（int），match_mode（str），fixed_index（int）\n"
                "  - 方案B：mixed_image_indices（list[int]，模特+商品混传）+ video_indices（list[int] 或 video_zip_index）\n"
                "- create_audio：speech_text（str），emotion/language/model_choice/speaker（str）\n"
                "- get_nano_banana：input_image_index（int），prompt（str），可选 image_generate_model（str）\n"
                "- get_gemini：user_input（str），system_prompt（str，可空）\n"
                f"默认参数：duration_seconds={duration_seconds}，product_name={product_name}。\n"
                "附件列表：\n"
                f"{json.dumps(file_brief, ensure_ascii=False)}\n"
                f"用户消息：{text}\n"
            )
        plan: dict[str, Any] = {}
        try:
            plan, _selected, _attempts = _request_llm_json_with_fallback(
                source=runtime,
                user_input=text,
                system_prompt=planner_prompt,
                parameters="",
                allow_builtin=True,
                request_label="TG会话理解",
            )
        except Exception:
            plan = {}
        if isinstance(plan, dict) and plan.get("ok") is True:
            parsed = plan.get("parsed")
            if isinstance(parsed, dict):
                task_type = str(parsed.get("task_type") or "").strip()
                skill = str(parsed.get("skill") or "").strip()
                if production_only:
                    if skill == "chat":
                        task_type = "chat"
                    elif skill in TG_AGENT_WORKFLOW_SKILL_TASK_TYPES:
                        task_type = TG_AGENT_WORKFLOW_SKILL_TASK_TYPES[skill]
                payload = parsed.get("payload") if isinstance(parsed.get("payload"), dict) else {}
                summary = str(parsed.get("summary") or "已完成素材识别").strip() or "已完成素材识别"
                allowed = {
                    "chat",
                    "none",
                    "create_video",
                    "ecommerce_short_video",
                    "image_generate",
                    "replace_model",
                    "replace_product",
                    "replace_productANDmodel",
                    "create_audio",
                    "get_nano_banana",
                    "get_gemini",
                }
                if production_only and task_type not in (TG_AGENT_PRODUCTION_TASK_TYPES | {"chat", "none"}):
                    reply = str(payload.get("reply") or parsed.get("reply") or summary or "").strip()
                    return _agent_chat_payload(reply=reply, summary=summary)
                if task_type in {"chat", "none"}:
                    return _agent_chat_payload(reply=str(payload.get("reply") or parsed.get("reply") or summary), summary=summary)
                if task_type in allowed and isinstance(payload, dict):
                    def _idx_path(key: str) -> str:
                        idx = payload.get(key)
                        try:
                            i = int(idx)
                        except Exception:
                            return ""
                        if i < 0 or i >= len(file_infos):
                            return ""
                        return str(file_infos[i].get("path") or "").strip()

                    if task_type == "create_video":
                        model_path = _idx_path("model_image_index")
                        product_path = _idx_path("product_image_index") or model_path
                        if not model_path:
                            if production_only:
                                return _agent_chat_payload(
                                    reply=_tg_agent_missing_material_reply("create_video", "人物/商品参考图"),
                                    summary="数字人视频生成缺少素材",
                                )
                            raise RuntimeError("任务规划缺少 model_image_index 或附件不足")
                        return (
                            "create_video",
                            {
                                "model_image_local_path": model_path,
                                "product_image_local_path": product_path,
                                "product_name": str(payload.get("product_name") or product_name),
                                "style_hint": str(payload.get("style_hint") or text or "自然口播，真实电商场景"),
                                "duration_seconds": max(_to_int(payload.get("duration_seconds"), duration_seconds), 1),
                                "use_ai_copy": bool(payload.get("use_ai_copy")) if "use_ai_copy" in payload else bool(use_ai_copy),
                            },
                            summary,
                        )
                    if task_type == "image_generate":
                        image_path = _idx_path("input_image_index") or _idx_path("product_image_index") or _idx_path("image_index")
                        if not image_path:
                            if production_only:
                                return _agent_chat_payload(
                                    reply=_tg_agent_missing_material_reply("image_generate", "参考图或商品图"),
                                    summary="电商广告图生产缺少素材",
                                )
                            raise RuntimeError("任务规划缺少 input_image_index 或附件不足")
                        return (
                            "image_generate",
                            {
                                "prompt": str(payload.get("prompt") or text or IMAGE_EDIT_DEFAULT_PROMPT),
                                "product_image_local_path": image_path,
                                "mode": "product_only",
                                "image_generate_model": str(payload.get("image_generate_model") or ""),
                            },
                            summary,
                        )
                    if task_type == "ecommerce_short_video":
                        product_path = _idx_path("product_image_index") or _idx_path("input_image_index") or _idx_path("image_index")
                        model_path = _idx_path("model_image_index")
                        if not product_path:
                            if production_only:
                                return _agent_chat_payload(
                                    reply=_tg_agent_missing_material_reply("ecommerce_short_video", "产品图片"),
                                    summary="广告短视频缺少产品图片",
                                )
                            raise RuntimeError("任务规划缺少 product_image_index 或附件不足")
                        built = {
                            "product_image_local_path": product_path,
                            "prompt": "",
                            "user_prompt": str(payload.get("user_prompt") or payload.get("prompt") or payload.get("prompt_text") or payload.get("copy_text") or text),
                            "tg_use_llm_prompt": True,
                            "tg_user_instruction": "根据用户补充要求和上传图片生成商业广告短视频提示词；让系统自主设计画面和镜头。人物说话内容可直接写进对应镜头；只有统一旁白放在时间线最后一行。",
                        }
                        if model_path:
                            built["model_image_local_path"] = model_path
                        return ("ecommerce_short_video", built, summary)
                    if task_type == "replace_model":
                        video_path = _idx_path("video_index")
                        image_path = _idx_path("image_index")
                        if not video_path or not image_path:
                            if production_only:
                                missing = "原视频和模特图"
                                if video_path and not image_path:
                                    missing = "模特图"
                                elif image_path and not video_path:
                                    missing = "原视频"
                                return _agent_chat_payload(
                                    reply=_tg_agent_missing_material_reply("replace_model", missing),
                                    summary="视频模特替换缺少素材",
                                )
                            raise RuntimeError("任务规划缺少 video_index/image_index 或附件不足")
                        return (
                            "replace_model",
                            {
                                "prompt": str(payload.get("prompt") or text),
                                "duration_seconds": max(_to_int(payload.get("duration_seconds"), duration_seconds), 1),
                                "width": 576,
                                "height": 1024,
                                "frame": 30,
                                "video_local_path": video_path,
                                "image_local_path": image_path,
                                "video_url": "",
                                "image_url": "",
                            },
                            summary,
                        )
                    if task_type == "replace_product":
                        video_path = _idx_path("video_index")
                        image_path = _idx_path("image_index")
                        if not video_path or not image_path:
                            if production_only:
                                missing = "原视频和商品图"
                                if video_path and not image_path:
                                    missing = "商品图"
                                elif image_path and not video_path:
                                    missing = "原视频"
                                return _agent_chat_payload(
                                    reply=_tg_agent_missing_material_reply("replace_product", missing),
                                    summary="视频商品替换缺少素材",
                                )
                            raise RuntimeError("任务规划缺少 video_index/image_index 或附件不足")
                        return (
                            "replace_product",
                            {
                                "product_name": str(payload.get("product_name") or product_name),
                                "prompt_text": str(payload.get("prompt_text") or text),
                                "duration_seconds": max(_to_int(payload.get("duration_seconds"), duration_seconds), 1),
                                "frame_rate": 30,
                                "width": 576,
                                "height": 1024,
                                "video_local_path": video_path,
                                "image_local_path": image_path,
                                "video_url": "",
                                "image_url": "",
                            },
                            summary,
                        )
                    if task_type == "replace_productANDmodel":
                        simple_video_path = _idx_path("video_index")
                        simple_model_path = _idx_path("model_image_index")
                        simple_product_path = _idx_path("product_image_index")
                        if simple_video_path and simple_model_path and simple_product_path:
                            return (
                                "replace_productANDmodel",
                                {
                                    "video_local_path": simple_video_path,
                                    "model_image_local_path": simple_model_path,
                                    "product_image_local_path": simple_product_path,
                                    "product_name": str(payload.get("product_name") or product_name),
                                    "match_mode": str(payload.get("match_mode") or "cycle"),
                                    "fixed_index": max(_to_int(payload.get("fixed_index"), 1), 1),
                                    "auto_rename": _to_bool(payload.get("auto_rename"), True),
                                    "model_params": {
                                        "prompt": str(payload.get("model_prompt") or text),
                                        "duration_seconds": duration_seconds,
                                    },
                                    "product_params": {
                                        "product_name": str(payload.get("product_name") or product_name),
                                        "prompt_text": str(payload.get("product_prompt_text") or payload.get("prompt_text") or text),
                                        "duration_seconds": duration_seconds,
                                    },
                                },
                                summary,
                            )
                        model_zip_path = _idx_path("model_zip_index")
                        product_zip_path = _idx_path("product_zip_index")
                        video_zip_path = _idx_path("video_zip_index")

                        mixed_indices = payload.get("mixed_image_indices") if isinstance(payload.get("mixed_image_indices"), list) else []
                        mixed_paths: list[str] = []
                        for idx in mixed_indices:
                            try:
                                i = int(idx)
                            except Exception:
                                continue
                            if 0 <= i < len(file_infos):
                                p = str(file_infos[i].get("path") or "").strip()
                                if p and (file_infos[i].get("kind") == "image"):
                                    mixed_paths.append(p)

                        video_indices = payload.get("video_indices") if isinstance(payload.get("video_indices"), list) else []
                        video_paths: list[str] = []
                        for idx in video_indices:
                            try:
                                i = int(idx)
                            except Exception:
                                continue
                            if 0 <= i < len(file_infos):
                                p = str(file_infos[i].get("path") or "").strip()
                                if p and (file_infos[i].get("kind") == "video"):
                                    video_paths.append(p)
                        if not video_zip_path:
                            video_zip_path = _idx_path("video_zip_index")

                        built: dict[str, Any] = {
                            "match_mode": str(payload.get("match_mode") or "cycle"),
                            "fixed_index": max(_to_int(payload.get("fixed_index"), 1), 1),
                            "auto_rename": _to_bool(payload.get("auto_rename"), True),
                            "model_params": {"prompt": text, "duration_seconds": duration_seconds},
                            "product_params": {"product_name": product_name, "prompt_text": text, "duration_seconds": duration_seconds},
                        }
                        if model_zip_path:
                            built["model_zip_path"] = model_zip_path
                        if product_zip_path:
                            built["product_zip_path"] = product_zip_path
                        if video_zip_path:
                            built["video_zip_path"] = video_zip_path
                        if mixed_paths and (not built.get("model_zip_path")) and (not built.get("product_zip_path")):
                            built["mixed_image_paths"] = mixed_paths
                        if video_paths and (not built.get("video_zip_path")):
                            built["video_paths"] = video_paths

                        has_model = bool(built.get("model_zip_path")) or bool(built.get("mixed_image_paths"))
                        has_product = bool(built.get("product_zip_path")) or bool(built.get("mixed_image_paths"))
                        has_video = bool(built.get("video_zip_path")) or bool(built.get("video_paths"))
                        if not (has_model and has_product and has_video):
                            if production_only:
                                return _agent_chat_payload(
                                    reply=_tg_agent_missing_material_reply("replace_productANDmodel", "联合替换所需的 model/product/video 素材"),
                                    summary="联合替换缺少素材",
                                )
                            raise RuntimeError("任务规划缺少有效的联合替换附件（zip 或 图片+视频）")
                        return ("replace_productANDmodel", built, summary)
                    if task_type == "create_audio":
                        speech_text = str(payload.get("speech_text") or text).strip()
                        if not speech_text:
                            raise RuntimeError("任务规划缺少 speech_text")
                        return (
                            "create_audio",
                            {
                                "speech_text": speech_text,
                                "emotion": _normalize_audio_emotion(payload.get("emotion"), default="neutral"),
                                "language": str(payload.get("language") or "Chinese"),
                                "model_choice": str(payload.get("model_choice") or "1.7B"),
                                "speaker": str(payload.get("speaker") or "Ryan"),
                            },
                            summary,
                        )
                    if task_type == "get_nano_banana":
                        image_path = _idx_path("input_image_index")
                        if not image_path:
                            raise RuntimeError("任务规划缺少 input_image_index 或附件不足")
                        return (
                            "get_nano_banana",
                            {"prompt": str(payload.get("prompt") or text), "input_image_local_path": image_path},
                            summary,
                        )
                    if task_type == "get_gemini":
                        return (
                            "get_gemini",
                            {
                                "user_input": str(payload.get("user_input") or text),
                                "system_prompt": str(payload.get("system_prompt") or ""),
                                "parameters": payload.get("parameters") if isinstance(payload.get("parameters"), dict) else "",
                                "image_paths": [str(i.get("path") or "") for i in images if str(i.get("path") or "").strip()],
                                "video_paths": [str(v.get("path") or "") for v in videos if str(v.get("path") or "").strip()],
                            },
                            summary,
                        )

    if ("replace_productandmodel" in low) or ("联合替换" in text) or ("批量" in text) or len(zips) >= 3:
        model_zip = ""
        product_zip = ""
        video_zip = ""
        for z in zips:
            name_low = str(z.get("name") or "").lower()
            if (not model_zip) and ("model" in name_low or "模特" in name_low):
                model_zip = z["path"]
            elif (not product_zip) and ("product" in name_low or "商品" in name_low):
                product_zip = z["path"]
            elif (not video_zip) and ("video" in name_low or "视频" in name_low):
                video_zip = z["path"]
        ordered = [z["path"] for z in zips]
        if len(ordered) >= 1 and not model_zip:
            model_zip = ordered[0]
        if len(ordered) >= 2 and not product_zip:
            product_zip = ordered[1]
        if len(ordered) >= 3 and not video_zip:
            video_zip = ordered[2]
        payload: dict[str, Any] = {
            "match_mode": "cycle",
            "fixed_index": 1,
            "auto_rename": True,
            "model_params": {"prompt": text, "duration_seconds": duration_seconds},
            "product_params": {"product_name": product_name, "prompt_text": text, "duration_seconds": duration_seconds},
        }
        if model_zip and product_zip and video_zip:
            payload["model_zip_path"] = model_zip
            payload["product_zip_path"] = product_zip
            payload["video_zip_path"] = video_zip
        else:
            if images and (not model_zip) and (not product_zip):
                payload["mixed_image_paths"] = [str(i.get("path") or "") for i in images if str(i.get("path") or "").strip()]
            elif model_zip and product_zip:
                payload["model_zip_path"] = model_zip
                payload["product_zip_path"] = product_zip
            if video_zip:
                payload["video_zip_path"] = video_zip
            elif videos:
                payload["video_paths"] = [str(v.get("path") or "") for v in videos if str(v.get("path") or "").strip()]

        has_model = bool(payload.get("model_zip_path")) or bool(payload.get("mixed_image_paths"))
        has_product = bool(payload.get("product_zip_path")) or bool(payload.get("mixed_image_paths"))
        has_video = bool(payload.get("video_zip_path")) or bool(payload.get("video_paths"))
        if not (has_model and has_product and has_video):
            if production_only:
                return _agent_chat_payload(
                    reply=_tg_agent_missing_material_reply("replace_productANDmodel", "联合替换所需的 model/product/video 素材"),
                    summary="联合替换缺少素材",
                )
            raise RuntimeError("联合替换需要：3 个 zip（model/product/video），或混传图片 + 原视频（zip 或视频文件）")
        if production_only and images and len(images) >= 2 and videos and not payload.get("model_zip_path") and not payload.get("product_zip_path") and not payload.get("video_zip_path"):
            return (
                "replace_productANDmodel",
                {
                    "video_local_path": str(videos[0].get("path") or "").strip(),
                    "model_image_local_path": str(images[0].get("path") or "").strip(),
                    "product_image_local_path": str(images[1].get("path") or "").strip(),
                    "product_name": product_name,
                    "match_mode": "cycle",
                    "fixed_index": 1,
                    "auto_rename": True,
                    "model_params": {"prompt": text, "duration_seconds": duration_seconds},
                    "product_params": {"product_name": product_name, "prompt_text": text, "duration_seconds": duration_seconds},
                },
                "已识别为联合替换任务",
            )
        return "replace_productANDmodel", payload, "已识别为批量替换任务"

    if ("replace_model" in low) or ("换模特" in text) or ("换脸" in text) or ("模特替换" in text):
        if not videos:
            url = _extract_url_by_suffix(text, VIDEO_EXTS)
            if not url:
                if production_only:
                    return _agent_chat_payload(
                        reply=_tg_agent_missing_material_reply("replace_model", "原视频"),
                        summary="视频模特替换缺少原视频",
                    )
                raise RuntimeError("replace_model 需要视频文件或视频 URL")
            videos = [{"path": "", "name": "", "kind": "video", "url": url}]
        if not images:
            url = _extract_url_by_suffix(text, IMAGE_EXTS)
            if not url:
                if production_only:
                    return _agent_chat_payload(
                        reply=_tg_agent_missing_material_reply("replace_model", "模特图"),
                        summary="视频模特替换缺少模特图",
                    )
                raise RuntimeError("replace_model 需要图片文件或图片 URL")
            images = [{"path": "", "name": "", "kind": "image", "url": url}]
        payload = {
            "prompt": text,
            "duration_seconds": duration_seconds,
            "width": 576,
            "height": 1024,
            "frame": 30,
            "video_local_path": str(videos[0].get("path") or "").strip(),
            "image_local_path": str(images[0].get("path") or "").strip(),
            "video_url": str(videos[0].get("url") or "").strip(),
            "image_url": str(images[0].get("url") or "").strip(),
        }
        return "replace_model", payload, "已识别为 replace_model 任务"

    if ("replace_product" in low) or ("换商品" in text) or ("商品替换" in text):
        if not videos:
            url = _extract_url_by_suffix(text, VIDEO_EXTS)
            if not url:
                if production_only:
                    return _agent_chat_payload(
                        reply=_tg_agent_missing_material_reply("replace_product", "原视频"),
                        summary="视频商品替换缺少原视频",
                    )
                raise RuntimeError("replace_product 需要视频文件或视频 URL")
            videos = [{"path": "", "name": "", "kind": "video", "url": url}]
        if not images:
            url = _extract_url_by_suffix(text, IMAGE_EXTS)
            if not url:
                if production_only:
                    return _agent_chat_payload(
                        reply=_tg_agent_missing_material_reply("replace_product", "商品图"),
                        summary="视频商品替换缺少商品图",
                    )
                raise RuntimeError("replace_product 需要图片文件或图片 URL")
            images = [{"path": "", "name": "", "kind": "image", "url": url}]
        payload = {
            "product_name": product_name,
            "prompt_text": text,
            "duration_seconds": duration_seconds,
            "frame_rate": 30,
            "width": 576,
            "height": 1024,
            "video_local_path": str(videos[0].get("path") or "").strip(),
            "image_local_path": str(images[0].get("path") or "").strip(),
            "video_url": str(videos[0].get("url") or "").strip(),
            "image_url": str(images[0].get("url") or "").strip(),
        }
        return "replace_product", payload, "已识别为 replace_product 任务"

    if ("create_audio" in low) or ("配音" in text) or ("语音" in text) or ("朗读" in text) or ("音频" in text):
        if production_only:
            return _agent_chat_payload(
                reply="我可以理解配音需求，但 Telegram 直接对话入口不会单独创建音频任务。请使用「数字人视频生成」并提供素材，系统会按数字人视频链路处理音频和视频。",
                summary="识别为非独立生产入口",
            )
        payload = {
            "speech_text": text,
            "emotion": "neutral",
            "language": "Chinese",
            "model_choice": "1.7B",
            "speaker": "Ryan",
        }
        return "create_audio", payload, "已识别为 create_audio 任务"

    if ("ecommerce_short_video" in low) or ("广告短视频" in text) or ("廣告短視頻" in text) or ("广告片" in text) or ("電商短視頻" in text) or ("电商短视频" in text) or ("商品短视频" in text) or ("商品短視頻" in text) or ("产品短视频" in text) or ("產品短視頻" in text) or ("图生视频" in text) or ("圖生視頻" in text):
        if not images:
            if production_only:
                return _agent_chat_payload(
                    reply=_tg_agent_missing_material_reply("ecommerce_short_video", "产品图片"),
                    summary="广告短视频缺少产品图片",
                )
            raise RuntimeError("广告短视频需要至少上传 1 张产品/场景图片")
        payload = {
            "product_image_local_path": str(images[0].get("path") or ""),
            "prompt": "",
            "user_prompt": text,
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "根据用户补充要求和上传图片生成商业广告短视频提示词；让系统自主设计画面和镜头。人物说话内容可直接写进对应镜头；只有统一旁白放在时间线最后一行。",
        }
        if len(images) >= 2:
            payload["model_image_local_path"] = str(images[1].get("path") or "")
        return "ecommerce_short_video", payload, "已识别为广告短视频任务"

    if ("image_generate" in low) or ("电商广告图" in text) or ("電商廣告圖" in text) or ("广告图" in text) or ("廣告圖" in text) or ("宣传海报" in text) or ("宣傳海報" in text) or ("图片融合" in text) or ("圖片融合" in text) or ("图片编辑" in text) or ("圖片編輯" in text) or ("图像编辑" in text) or ("圖像編輯" in text) or ("生图" in text) or ("畫圖" in text) or ("画图" in text):
        if not images:
            if production_only:
                return _agent_chat_payload(reply="电商广告图生产需要先上传 1 张商品、空间或服务场景图，然后告诉我要做成什么海报效果。", summary="电商广告图生产缺少参考图")
            raise RuntimeError("电商广告图生产任务至少需要上传 1 张参考图")
        payload = {
            "prompt": text,
            "product_image_local_path": str(images[0].get("path") or ""),
            "mode": "product_only",
        }
        return "image_generate", payload, "已识别为电商广告图生产任务"

    if ("nano" in low) or ("banana" in low):
        if production_only:
            return _agent_chat_payload(reply="请用「电商广告图生产」描述要生成的海报效果，并上传 1 张商品、空间或服务场景图。", summary="识别为旧图片模型入口")
        if not images:
            raise RuntimeError("生图任务至少需要上传 1 张参考图")
        payload = {
            "prompt": text,
            "input_image_local_path": str(images[0].get("path") or ""),
        }
        return "get_nano_banana", payload, "已识别为 图片服务任务"

    if ("gemini" in low) or ("分析" in text) or ("理解" in text):
        if production_only:
            return _agent_chat_payload(reply="我可以先理解你的需求，但还不会为纯分析内容创建生产任务。请说明要生成数字人视频、电商广告图，还是做视频替换，并上传对应素材。", summary="识别为非生产对话")
        payload = {
            "user_input": text,
            "system_prompt": "",
            "parameters": "",
            "image_paths": [str(i.get("path") or "") for i in images if str(i.get("path") or "").strip()],
            "video_paths": [str(v.get("path") or "") for v in videos if str(v.get("path") or "").strip()],
        }
        return "get_gemini", payload, "已识别为素材分析任务"

    if len(images) < 1:
        if production_only:
            return _agent_chat_payload(
                reply="我可以帮你调用工作流，但需要先确定任务类型并收到素材。可用工作流：数字人视频生成、广告短视频、电商广告图生产、视频商品替换、视频模特替换、联合替换。请直接说要做哪一种，并上传对应素材。",
                summary="缺少工作流素材",
            )
        raise RuntimeError("默认流程是视频生成，请至少上传 1 张图片（建议 2 张：模特图+商品图）")
    model_img = str(images[0].get("path") or "")
    product_img = str((images[1] if len(images) > 1 else images[0]).get("path") or model_img)
    payload = {
        "model_image_local_path": model_img,
        "product_image_local_path": product_img,
        "product_name": product_name,
        "style_hint": text or "自然口播，真实电商场景",
        "duration_seconds": duration_seconds,
        "language": "Chinese",
        "emotion": "neutral",
        "model_choice": "1.7B",
        "speaker": "Ryan",
        "nano_prompt": "电商口播视频场景截图风格：真实人物在室内/直播间展示商品，手持商品或放在手掌上讲解；写实摄影、柔和补光、干净背景；9:16；画面不要文字/水印/海报排版。",
        "use_ai_copy": bool(use_ai_copy),
        "camera_video_local_path": str(videos[0].get("path") or "").strip() if videos else "",
        "camera_video_url": str(videos[0].get("url") or "").strip() if videos else "",
    }
    if not use_ai_copy:
        payload["speech_text"] = text
        payload["prompt_text"] = text
    return "create_video", payload, "已识别为视频生成任务"

def build_agent_task_payload(
    *,
    message: str,
    file_infos: list[dict[str, Any]],
    use_ai_copy: bool = True,
    default_duration: int = 15,
    production_only: bool = False,
) -> tuple[str, dict[str, Any], str]:
    return _build_agent_task_payload(
        message=message,
        file_infos=list(file_infos or []),
        use_ai_copy=use_ai_copy,
        default_duration=default_duration,
        production_only=production_only,
    )
