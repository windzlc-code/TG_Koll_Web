from __future__ import annotations

import asyncio
import html
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import time
import urllib.request
from pathlib import Path
from typing import Any

import requests
from aiohttp import ClientSession, TCPConnector
from aiohttp.resolver import ThreadedResolver
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import CallbackQuery, FSInputFile, InlineKeyboardButton, InlineKeyboardMarkup, InputMediaAudio, KeyboardButton, Message, ReplyKeyboardMarkup

import voice_presets
from .config import AppConfig
from .workbench import WorkspaceService
from .workflow import WorkflowRequest


logger = logging.getLogger(__name__)
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}
ZIP_EXTS = {".zip"}
AUTO_DURATION_TEXTS = {"跳过", "跳過", "自动", "自動", "auto", "AUTO"}
ECOMMERCE_SEEDANCE_FAST_BUTTON = "seedance2.0fast"
ECOMMERCE_SEEDANCE_STANDARD_BUTTON = "seedance2.0"
ECOMMERCE_MODEL_WORKFLOW_IDS = {
    ECOMMERCE_SEEDANCE_FAST_BUTTON: "2034917373414539278",
    ECOMMERCE_SEEDANCE_STANDARD_BUTTON: "2034917373414539277",
}
ECOMMERCE_STYLE_STORY_BUTTON = "剧情式广告"
ECOMMERCE_STYLE_DOCUMENTARY_BUTTON = "纪录片广告"
ECOMMERCE_STYLE_STANDARD_BUTTON = "标准电商广告"
ECOMMERCE_STYLE_ANIMATION_BUTTON = "动画广告"
ECOMMERCE_AD_STYLE_BUTTONS = {
    ECOMMERCE_STYLE_STORY_BUTTON: "story",
    ECOMMERCE_STYLE_DOCUMENTARY_BUTTON: "documentary",
    ECOMMERCE_STYLE_STANDARD_BUTTON: "standard_ecommerce",
    ECOMMERCE_STYLE_ANIMATION_BUTTON: "animation",
}
ECOMMERCE_SINGLE_VIDEO_BUTTON = "1 单条长视频"
ECOMMERCE_STORYBOARD_VIDEO_BUTTON = "2 多段分镜视频"
ECOMMERCE_SINGLE_VIDEO_TEXTS = {"1", ECOMMERCE_SINGLE_VIDEO_BUTTON}
ECOMMERCE_STORYBOARD_VIDEO_TEXTS = {"2", ECOMMERCE_STORYBOARD_VIDEO_BUTTON}
TARGET_LANGUAGE_BUTTONS = {
    "日语": ("Japanese", "日语"),
    "马来西亚": ("Malay", "马来语"),
    "马来语": ("Malay", "马来语"),
    "西班牙语": ("Spanish", "西班牙语"),
    "泰语": ("Thai", "泰语"),
    "中文": ("Chinese", "中文"),
    "英文": ("English", "英文"),
}
ELEVENLABS_OFFICIAL_VOICE_PRESETS: dict[str, list[dict[str, str]]] = voice_presets.ELEVENLABS_VOICE_PRESETS
ECOMMERCE_RATIO_BUTTONS = {
    "16:9": "16:9",
    "4:3": "4:3",
    "1:1": "1:1",
    "3:4": "3:4",
    "9:16": "9:16",
}
ECOMMERCE_RESOLUTION_BUTTONS = {
    "480p": "480p",
    "720p": "720p",
    "1080p": "1080p",
    "2k": "2k",
    "4k": "4k",
}
DIGITAL_HUMAN_CHARACTER_REGIONS = {
    "中国": "china",
    "欧美": "western",
    "印尼": "indonesia",
    "泰国": "thailand",
    "日本": "japan",
    "马来西亚": "malaysia",
}
DIGITAL_HUMAN_SINGLE_VIDEO_BUTTON = "單段口播視頻"
DIGITAL_HUMAN_STORYBOARD_VIDEO_BUTTON = "多分鏡口播視頻"
DIGITAL_HUMAN_STRUCTURE_TEXTS = {
    DIGITAL_HUMAN_SINGLE_VIDEO_BUTTON: "single",
    "单段口播视频": "single",
    "1": "single",
    DIGITAL_HUMAN_STORYBOARD_VIDEO_BUTTON: "storyboard",
    "多分镜口播视频": "storyboard",
    "2": "storyboard",
}
DIGITAL_HUMAN_MANUAL_SCRIPT_BUTTON = "手動輸入口播文稿"
DIGITAL_HUMAN_AI_SCRIPT_BUTTON = "AI 根據圖片生成文稿"
DIGITAL_HUMAN_CONFIRM_BUTTON = "確認生成數字人視頻"
DIGITAL_HUMAN_NEXT_BUTTON = "確認下一步"
DIGITAL_HUMAN_REGENERATE_BUTTON = "重新生成"
DIGITAL_HUMAN_GUIDED_REVISION_BUTTON = "引導修改提示詞"
DIGITAL_HUMAN_GUIDED_REVISION_TEXTS = {
    DIGITAL_HUMAN_GUIDED_REVISION_BUTTON,
    "引导修改提示词",
    "引導修改文稿",
    "引导修改文稿",
}
DIGITAL_HUMAN_FINAL_SUBMIT_BUTTON = "確認提交視頻生成"
DIGITAL_HUMAN_ORPHAN_STEP_BUTTONS = {
    DIGITAL_HUMAN_CONFIRM_BUTTON,
    DIGITAL_HUMAN_NEXT_BUTTON,
    DIGITAL_HUMAN_REGENERATE_BUTTON,
    DIGITAL_HUMAN_GUIDED_REVISION_BUTTON,
    DIGITAL_HUMAN_FINAL_SUBMIT_BUTTON,
}
IMAGE_EDIT_SIZE_BUTTONS = {
    "16:9": "16:9",
    "4:3": "4:3",
    "1:1": "1:1",
    "3:4": "3:4",
    "9:16": "9:16",
}
DIGITAL_HUMAN_RESOLUTION_BUTTONS = {
    "1600": 1600,
    "720": 720,
    "1280": 1280,
}
ECOMMERCE_CONFIRM_TEXTS = {"确认生成", "確認生成", "确认", "確認", "开始生成", "開始生成", "ok", "OK"}
ECOMMERCE_REGENERATE_TEXTS = {"重新生成提示词", "重新生成提示詞", "重写", "重寫", "重新生成", "再生成一次"}
ECOMMERCE_GUIDED_REVISION_BUTTON = "引导修改提示词"
ECOMMERCE_GUIDED_REVISION_TEXTS = {
    ECOMMERCE_GUIDED_REVISION_BUTTON,
    "引導修改提示詞",
    "引導修改文稿",
    "引导修改文稿",
}
ECOMMERCE_ANIMATION_REDRAW_CONFIRM_TEXTS = {"确认转绘", "確認轉繪", "确认转绘素材", "確認轉繪素材"}
ECOMMERCE_ANIMATION_REDRAW_SKIP_TEXTS = {"不转绘继续", "不轉繪繼續", "保留原图继续", "保留原圖繼續"}
ECOMMERCE_SUBTITLE_ENABLE_BUTTON = "添加字幕"
ECOMMERCE_SUBTITLE_DISABLE_BUTTON = "不添加字幕"
ECOMMERCE_SUBTITLE_ENABLE_TEXTS = {ECOMMERCE_SUBTITLE_ENABLE_BUTTON, "加字幕", "需要字幕", "是", "要"}
ECOMMERCE_SUBTITLE_DISABLE_TEXTS = {ECOMMERCE_SUBTITLE_DISABLE_BUTTON, "不要字幕", "无需字幕", "不需要字幕", "否", "不要"}
ECOMMERCE_PRODUCT_DONE_BUTTON = "完成上传，下一步"
BACK_STEP_BUTTON = "返回上一步"
ECOMMERCE_PRODUCT_DONE_TEXTS = {
    ECOMMERCE_PRODUCT_DONE_BUTTON,
    "完成",
    "完成上传",
    "完成上傳",
    "下一步",
    "确认下一步",
    "確認下一步",
}
BOT_OPERATIONAL_TEXT_MARKERS = (
    "若上游工作流已開始",
    "结果不会再覆盖任务状态",
    "結果不會再覆蓋任務狀態",
    "任務已取消",
    "任务已取消",
    "后台队列",
    "後台隊列",
    "可按「查看工作台狀態」",
    "任务编号",
    "任務編號",
)

DIGITAL_HUMAN_VIDEO_BUTTON = "數字人視頻生成"
ECOMMERCE_SHORT_VIDEO_BUTTON = "廣告短視頻"
ORAL_UPLOAD_BUTTON = DIGITAL_HUMAN_VIDEO_BUTTON
LEGACY_ORAL_UPLOAD_BUTTON = "口播數字人：上傳素材"
WORKFLOW_CONFIG_BUTTON = "查看後台工作流配置"
IMAGE_GENERATION_MENU_BUTTON = "圖片生成"
IMAGE_WORKFLOW_BUTTON = "電商廣告圖生產"
ECOMMERCE_POSTER_TRANSLATE_BUTTON = "电商图语种切换"
THREE_VIEW_IMAGE_BUTTON = "三視圖生成"
DIGITAL_HUMAN_CHARACTER_BUTTON = "生成数字人"
SUBJECT_REPLACE_IMAGE_BUTTON = "主体替换"
IMAGE_REGENERATE_BUTTON = "重新生成圖片"
LEGACY_IMAGE_WORKFLOW_BUTTON = "圖像編輯工作流"
LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON = "圖片生成工作流"
VIDEO_EDIT_BUTTON = "視頻編輯"
MAIN_MENU_BUTTON = "返回主菜單"
MAIN_MENU_TEXTS = {MAIN_MENU_BUTTON, "返回主菜单"}
REPLACE_MODEL_WORKFLOW_BUTTON = "視頻模特替換"
LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON = "模特替換工作流"
REPLACE_PRODUCT_WORKFLOW_BUTTON = "視頻商品替換"
LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON = "商品替換工作流"
REPLACE_UNION_WORKFLOW_BUTTON = "聯合替換工作流"

LEGACY_UPLOAD_BUTTON = "上傳素材建立任務"
STATUS_BUTTON = "查看工作台狀態"
STATUS_TEXTS = {STATUS_BUTTON, "查看工作台状态", "/status", "工作台状态", "工作台狀態"}
WORKBENCH_BUTTON = "工作台網址"
SET_SCRIPT_BUTTON = "設定預設文案"
RERUN_BUTTON = "重跑最近任務"
STOP_BUTTON = "強制停止目前任務"

WORKFLOW_REFERENCE_BUTTONS = {
    WORKFLOW_CONFIG_BUTTON,
    ECOMMERCE_SHORT_VIDEO_BUTTON,
    IMAGE_GENERATION_MENU_BUTTON,
    IMAGE_WORKFLOW_BUTTON,
    THREE_VIEW_IMAGE_BUTTON,
    DIGITAL_HUMAN_CHARACTER_BUTTON,
    SUBJECT_REPLACE_IMAGE_BUTTON,
    LEGACY_IMAGE_WORKFLOW_BUTTON,
    LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON,
    REPLACE_MODEL_WORKFLOW_BUTTON,
    LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON,
    REPLACE_PRODUCT_WORKFLOW_BUTTON,
    LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON,
    REPLACE_UNION_WORKFLOW_BUTTON,
}

_WEBAPP_FINISHED_STATUSES = {"success", "completed", "failed", "cancelled"}
_WEBAPP_SUCCESS_STATUSES = {"success", "completed"}
_WEBAPP_RESULT_WATCHERS: set[asyncio.Task] = set()


def _webapp_task_db_path() -> Path:
    explicit = str(os.getenv("WEBAPP_DB_PATH") or "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR") or "webapp_data")).expanduser()
    return (data_dir / "app.db").resolve()


def _status_label(status: Any) -> str:
    mapping = {
        "queued": "等待中",
        "running": "進行中",
        "processing": "進行中",
        "success": "已完成",
        "completed": "已完成",
        "failed": "失敗",
        "cancelled": "已取消",
    }
    key = str(status or "").strip().lower()
    return mapping.get(key, key or "未知")


def _task_type_label(task_type: Any) -> str:
    mapping = {
        "create_video": "數字人視頻生成",
        "commerce_video": "數字人視頻生成",
        "ecommerce_short_video": "廣告短視頻工作流",
        "image_generate": "電商廣告圖生產",
        "replace_model": "視頻模特替換",
        "replace_product": "視頻商品替換",
        "replace_productANDmodel": "聯合替換工作流",
        "create_audio": "音頻生成",
        "get_gemini": "文字模型",
        "get_nano_banana": "圖片模型",
    }
    key = str(task_type or "").strip()
    return mapping.get(key, key or "未知工作流")


def _json_dict(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _connect_webapp_task_db() -> sqlite3.Connection | None:
    path = _webapp_task_db_path()
    if not path.exists():
        return None
    uri = f"file:{path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _webapp_task_matches_chat(row: sqlite3.Row, chat_id: int) -> bool:
    payload = _json_dict(row["input_json"] if "input_json" in row.keys() else "")
    try:
        return int(payload.get("tg_chat_id") or 0) == int(chat_id)
    except Exception:
        return False


def _extract_runninghub_task_ids(task: dict[str, Any], events: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    raw = str(task.get("runninghub_task_id") or "").strip()
    if raw:
        ids.append(raw)
    for event in events:
        message = str(event.get("message") or "")
        ids.extend(re.findall(r"task\s*id[:：]\s*(\d{8,})", message, flags=re.I))
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        for key in ("runninghub_task_id", "runninghub_task_ids"):
            value = data.get(key)
            if isinstance(value, list):
                ids.extend(str(item).strip() for item in value if str(item).strip())
            elif str(value or "").strip():
                ids.append(str(value).strip())
    return list(dict.fromkeys(ids))


def _load_webapp_tg_status(chat_id: int) -> dict[str, Any] | None:
    conn = _connect_webapp_task_db()
    if conn is None:
        return None
    try:
        rows = conn.execute(
            """
            SELECT id, user_id, type, status, error, runninghub_task_id, input_json, output_json, created_at, updated_at
            FROM tasks
            ORDER BY created_at DESC
            LIMIT 300
            """,
        ).fetchall()
        tasks = [dict(row) for row in rows if _webapp_task_matches_chat(row, chat_id)]
        counts: dict[str, int] = {}
        for task in tasks:
            status = str(task.get("status") or "").strip().lower()
            counts[status] = counts.get(status, 0) + 1
        latest = tasks[0] if tasks else None
        active = next((task for task in tasks if str(task.get("status") or "").strip().lower() in {"queued", "running"}), None)
        events: list[dict[str, Any]] = []
        if latest:
            event_rows = conn.execute(
                """
                SELECT kind, message, data_json, created_at
                FROM task_events
                WHERE task_id = ?
                ORDER BY created_at DESC
                LIMIT 12
                """,
                (str(latest.get("id") or ""),),
            ).fetchall()
            for row in event_rows:
                data = _json_dict(row["data_json"])
                events.append(
                    {
                        "kind": str(row["kind"] or ""),
                        "message": str(row["message"] or ""),
                        "data": data,
                        "created_at": int(row["created_at"] or 0),
                    }
                )
        return {"tasks": tasks, "counts": counts, "latest": latest, "active": active, "events": events}
    finally:
        conn.close()


def _find_recent_active_tg_task(chat_id: int, task_type: str, *, max_age_seconds: int = 900) -> dict[str, Any] | None:
    status = _load_webapp_tg_status(chat_id)
    if not status:
        return None
    now = int(time.time())
    expected_type = str(task_type or "").strip()
    for task in status.get("tasks") or []:
        task_status = str(task.get("status") or "").strip().lower()
        if task_status not in {"queued", "running"}:
            continue
        if expected_type and str(task.get("type") or "").strip() != expected_type:
            continue
        try:
            created_at = int(task.get("created_at") or 0)
        except Exception:
            created_at = 0
        if created_at and now - created_at > int(max_age_seconds):
            continue
        return task
    return None


def _load_webapp_task_detail(task_id: str) -> dict[str, Any] | None:
    tid = str(task_id or "").strip()
    if not tid:
        return None
    conn = _connect_webapp_task_db()
    if conn is None:
        return None
    try:
        row = conn.execute(
            """
            SELECT id, user_id, type, status, error, runninghub_task_id, input_json, output_json, created_at, updated_at
            FROM tasks
            WHERE id = ?
            LIMIT 1
            """,
            (tid,),
        ).fetchone()
        if row is None:
            return None
        events: list[dict[str, Any]] = []
        event_rows = conn.execute(
            """
            SELECT kind, message, data_json, created_at
            FROM task_events
            WHERE task_id = ?
            ORDER BY created_at DESC
            LIMIT 20
            """,
            (tid,),
        ).fetchall()
        for event_row in event_rows:
            events.append(
                {
                    "kind": str(event_row["kind"] or ""),
                    "message": str(event_row["message"] or ""),
                    "data": _json_dict(event_row["data_json"]),
                    "created_at": int(event_row["created_at"] or 0),
                }
            )
        task = dict(row)
        task["input"] = _json_dict(task.get("input_json"))
        task["output"] = _json_dict(task.get("output_json"))
        task["events"] = events
        return task
    finally:
        conn.close()


def _iter_output_path_candidates(value: Any) -> list[str]:
    keys = (
        "download_path",
        "video_path",
        "final_video_path",
        "image_path",
        "scene_image_path",
        "audio_path",
        "result_zip",
        "result_path",
        "output_path",
        "file_path",
        "local_path",
    )
    candidates: list[str] = []
    seen: set[int] = set()

    def visit(item: Any) -> None:
        marker = id(item)
        if marker in seen:
            return
        seen.add(marker)
        if isinstance(item, dict):
            for key in keys:
                raw = str(item.get(key) or "").strip()
                if raw:
                    candidates.append(raw)
            for nested_key in ("items", "results", "raw_result", "result", "output"):
                nested = item.get(nested_key)
                if isinstance(nested, (dict, list)):
                    visit(nested)
        elif isinstance(item, list):
            for child in item:
                if isinstance(child, (dict, list)):
                    visit(child)

    visit(value)
    return list(dict.fromkeys(candidates))


def _resolve_webapp_output_file(output_payload: dict[str, Any]) -> Path | None:
    for raw in _iter_output_path_candidates(output_payload):
        if raw.startswith(("http://", "https://")):
            continue
        path = Path(raw).expanduser()
        if path.exists() and path.is_file():
            return path.resolve()
    return None


def _qa_report_lines(output_payload: dict[str, Any]) -> list[str]:
    report = output_payload.get("qa_report") if isinstance(output_payload, dict) else None
    if not isinstance(report, dict):
        return []
    status = str(report.get("status") or "").strip()
    label = str(report.get("status_label") or "").strip() or ("已淘汰" if status == "rejected" else "需人工確認" if status == "warning" else "通過")
    summary = str(report.get("summary") or "").strip()
    issues = report.get("issues") if isinstance(report.get("issues"), list) else []
    lines = [f"QA: {label}"]
    if summary:
        lines.append(f"QA 摘要: {summary}")
    if issues:
        first_issue = issues[0] if isinstance(issues[0], dict) else {}
        issue_message = str(first_issue.get("message") or "").strip()
        suggestion = str(first_issue.get("suggestion") or "").strip()
        if issue_message:
            lines.append(f"QA 問題: {issue_message}")
        if suggestion:
            lines.append(f"人工建議: {suggestion}")
    if status == "rejected":
        lines.append("注意: 成品已返回，但已被 QA 淘汰；請人工確認後再決定是否重跑。")
    elif status == "warning":
        lines.append("注意: QA 建議人工確認；系統不會自動重跑。")
    return lines


def _webapp_task_result_caption(service: WorkspaceService, detail: dict[str, Any]) -> str:
    output_payload = detail.get("output") if isinstance(detail.get("output"), dict) else {}
    input_payload = detail.get("input") if isinstance(detail.get("input"), dict) else {}
    events = detail.get("events") if isinstance(detail.get("events"), list) else []
    runninghub_ids = _extract_runninghub_task_ids(detail, list(reversed(events)))
    summary = (
        str(output_payload.get("message") or "").strip()
        or str(input_payload.get("workflow_chain_summary") or "").strip()
        or str(output_payload.get("workflow_chain_summary") or "").strip()
        or _task_type_label(detail.get("type"))
    )
    lines = [
        f"{service.get_app_title()} 任務已完成",
        f"工作流: {_task_type_label(detail.get('type'))}",
        f"任務編號: {detail.get('id')}",
    ]
    if summary:
        lines.append(f"結果: {summary}")
    lines.extend(_qa_report_lines(output_payload))
    if runninghub_ids:
        lines.append(f"生成任務: {', '.join(runninghub_ids[:3])}")
    return "\n".join(lines)


def _simple_failure_reason(error: str, status: str) -> str:
    text = str(error or "").strip()
    extracted_parts: list[str] = []
    for match in re.finditer(r"\{.*?\}", text):
        try:
            parsed = json.loads(match.group(0))
        except Exception:
            continue
        if isinstance(parsed, dict):
            for key in ("errorCode", "errorMessage", "message", "promptTips"):
                value = str(parsed.get(key) or "").strip()
                if value:
                    extracted_parts.append(value)
            failed_reason = parsed.get("failedReason")
            if isinstance(failed_reason, dict):
                for value in failed_reason.values():
                    value_text = str(value or "").strip()
                    if value_text:
                        extracted_parts.append(value_text)
    combined = " ".join([text, *extracted_parts])
    lowered = combined.lower()
    compact_lowered = re.sub(r"[\s_-]+", "", lowered)
    if not text:
        return f"任务状态为「{_status_label(status)}」，请到工作台查看详情。"
    if "content security audit" in lowered or "contentsafetyaudit" in compact_lowered or "内容安全审查" in combined or "安全审核" in combined:
        return "素材或提示词没有通过平台审核，请更换图片、视频，或把提示词写得更温和后重试。"
    if "余额不足" in combined or "餘額不足" in combined or "insufficient" in lowered or "not enough" in lowered or "notenoughbalance" in compact_lowered:
        return "账户余额不足，请充值或更换可用账号后重试。"
    if (
        "errorcode\": \"1014" in lowered
        or "errorcode': '1014" in lowered
        or re.search(r"\b1014\b", combined)
        or "standard model api is restricted" in lowered
        or "标准模型api仅限企业级" in combined.replace(" ", "")
        or "企业级-共享api key" in text.lower()
    ):
        return "当前服务密钥不能调用标准模型 API。广告短视频多图参考接口需要企业级共享 API Key，请更换对应 Key 后重试。"
    if (
        "runninghub_api_key" in lowered
        or "runninghub api key" in lowered
        or "缺少 runninghub" in lowered
        or "需要 runninghub" in lowered
    ):
        return "服务密钥没有传入任务。请在后台系统配置里保存对应的服务密钥，或重新启动服务后再提交。"
    if "outofmemory" in compact_lowered or "out of memory" in lowered or "显存" in combined or "vram" in lowered:
        return "工作流显存不足，请降低素材分辨率，或在后台把该工作流切换为 plus 模式后重试。"
    if "nodeinfo_mismatch" in lowered or "node_not_found" in lowered or "nodeid" in lowered:
        return "工作流参数和当前节点不匹配，请检查后台工作流配置或节点文档。"
    if "timeout" in lowered or "timed out" in lowered or "超时" in combined:
        return "上游服务响应超时，请稍后重试。"
    if "certificate" in lowered or "ssl" in lowered:
        return "服务器访问上游接口时证书校验失败，请检查服务器证书环境。"
    if "file" in lowered and ("not found" in lowered or "不存在" in combined):
        return "任务素材文件不存在，可能已被清理，请重新上传素材后再试。"
    return "任务执行失败，原始错误已保存在工作台任务详情中，请按任务编号查看。"


async def _send_webapp_task_result(bot: Bot, service: WorkspaceService, *, chat_id: int, detail: dict[str, Any]) -> None:
    status = str(detail.get("status") or "").strip().lower()
    task_id = str(detail.get("id") or "").strip()
    if status not in _WEBAPP_SUCCESS_STATUSES:
        error = str(detail.get("error") or "").strip()
        reason = _simple_failure_reason(error, status)
        await bot.send_message(
            chat_id=chat_id,
            text="\n".join(
                [
                    "任務執行失敗。",
                    f"工作流: {_task_type_label(detail.get('type'))}",
                    f"任務編號: {task_id}",
                    f"原因: {reason}",
                    "詳細記錄已保存在工作台任務詳情。",
                ]
            ),
        )
        return

    output_payload = detail.get("output") if isinstance(detail.get("output"), dict) else {}
    output_file = _resolve_webapp_output_file(output_payload)
    caption = _webapp_task_result_caption(service, detail)
    if output_file is None:
        await bot.send_message(chat_id=chat_id, text=f"{caption}\n成品文件未在服務器本地輸出目錄中找到，請到 Web 工作台任務詳情查看。")
        return

    suffix = output_file.suffix.lower()
    result_markup = _image_generation_result_keyboard() if str(detail.get("type") or "").strip() == "image_generate" else None
    try:
        if suffix in IMAGE_EXTS:
            try:
                await bot.send_photo(
                    chat_id=chat_id,
                    photo=FSInputFile(str(output_file)),
                    caption=caption,
                    reply_markup=result_markup,
                    request_timeout=180,
                )
                return
            except Exception:
                logger.exception("Failed to send webapp image result as photo; retrying as document: task_id=%s", task_id)
                await bot.send_document(
                    chat_id=chat_id,
                    document=FSInputFile(str(output_file)),
                    caption=caption,
                    reply_markup=result_markup,
                    request_timeout=180,
                )
                return
        if suffix in VIDEO_EXTS:
            try:
                await bot.send_video(
                    chat_id=chat_id,
                    video=FSInputFile(str(output_file)),
                    caption=caption,
                    reply_markup=result_markup,
                    request_timeout=300,
                )
                return
            except Exception:
                await bot.send_document(
                    chat_id=chat_id,
                    document=FSInputFile(str(output_file)),
                    caption=caption,
                    reply_markup=result_markup,
                    request_timeout=300,
                )
                return
        await bot.send_document(
            chat_id=chat_id,
            document=FSInputFile(str(output_file)),
            caption=caption,
            reply_markup=result_markup,
            request_timeout=180,
        )
    except Exception as exc:
        logger.exception("Failed to send webapp task result to Telegram: task_id=%s", task_id)
        await bot.send_message(
            chat_id=chat_id,
            text=f"{caption}\nTelegram 回传成品文件失败：{exc.__class__.__name__}。请到 Web 工作台下载结果。",
            reply_markup=result_markup,
        )


async def _watch_webapp_task_and_notify(
    bot: Bot,
    service: WorkspaceService,
    *,
    chat_id: int,
    task_id: str,
    poll_seconds: float = 8.0,
    timeout_seconds: float = 60 * 60 * 3,
) -> None:
    deadline = time.monotonic() + max(float(timeout_seconds), 30.0)
    tid = str(task_id or "").strip()
    if not tid:
        return
    while time.monotonic() < deadline:
        detail = _load_webapp_task_detail(tid)
        if detail is not None:
            status = str(detail.get("status") or "").strip().lower()
            if status in _WEBAPP_FINISHED_STATUSES:
                await _send_webapp_task_result(bot, service, chat_id=chat_id, detail=detail)
                return
        await asyncio.sleep(max(float(poll_seconds), 2.0))
    await bot.send_message(
        chat_id=chat_id,
        text="\n".join(
            [
                "任務仍在後台處理，暫未收到完成事件。",
                f"任務編號: {tid}",
                "可按「查看工作台狀態」或到 Web 工作台任務詳情繼續跟進。",
            ]
        ),
    )


def _schedule_webapp_task_notification(bot: Bot, service: WorkspaceService, *, chat_id: int, task_id: str) -> None:
    task = asyncio.create_task(
        _watch_webapp_task_and_notify(bot, service, chat_id=chat_id, task_id=task_id),
        name=f"tg-webapp-task-watch-{task_id}",
    )
    _WEBAPP_RESULT_WATCHERS.add(task)

    def _cleanup(done: asyncio.Task) -> None:
        _WEBAPP_RESULT_WATCHERS.discard(done)
        try:
            done.result()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Telegram webapp task watcher crashed: task_id=%s", task_id)

    task.add_done_callback(_cleanup)


def _format_seconds_ago(timestamp: Any) -> str:
    try:
        delta = max(int(time.time()) - int(timestamp or 0), 0)
    except Exception:
        return "未知"
    if delta < 60:
        return f"{delta} 秒前"
    if delta < 3600:
        return f"{delta // 60} 分 {delta % 60} 秒前"
    return f"{delta // 3600} 小時 {(delta % 3600) // 60} 分前"


def _webapp_status_text(service: WorkspaceService, *, chat_id: int, internal_step: dict[str, Any] | None = None) -> str:
    internal = internal_step if isinstance(internal_step, dict) else None
    status = _load_webapp_tg_status(chat_id)
    if not status or not status.get("tasks"):
        base_text = service.get_status_text(chat_id=chat_id)
        if not internal:
            return base_text
        return "\n".join(
            [
                base_text,
                "",
                f"TG 分步任务: {str(internal.get('workflow') or '数字人视频生成')}",
                f"分步状态: {str(internal.get('stage') or '处理中')}",
                f"开始时间: {_format_seconds_ago(int(internal.get('started_at') or 0))}",
                "说明: 这是确认流程中的内部生成步骤，未进入后台队列表。",
            ]
        )

    counts = status.get("counts") if isinstance(status.get("counts"), dict) else {}
    latest = status.get("latest") if isinstance(status.get("latest"), dict) else None
    active = status.get("active") if isinstance(status.get("active"), dict) else None
    events = status.get("events") if isinstance(status.get("events"), list) else []
    internal_running = 1 if internal else 0
    lines = [
        f"{service.get_app_title()} 狀態",
        f"等待中任務: {int(counts.get('queued') or 0)}",
        f"進行中任務: {int(counts.get('running') or 0) + int(counts.get('processing') or 0) + internal_running}",
        f"已完成任務: {int(counts.get('success') or 0) + int(counts.get('completed') or 0)}",
        f"失敗任務: {int(counts.get('failed') or 0)}",
    ]
    if active:
        lines.append(f"目前占用: {_task_type_label(active.get('type'))} / {active.get('id')}")
    elif internal:
        lines.append(f"目前占用: TG 分步任务 / {str(internal.get('workflow') or '数字人视频生成')}")
        lines.append(f"当前阶段: {str(internal.get('stage') or '处理中')}")
        lines.append(f"已运行: {_format_seconds_ago(int(internal.get('started_at') or 0))}")
    else:
        lines.append("目前占用: 無，工作台可立即使用")
    lines.append(f"你的 Chat ID: {chat_id}")

    if latest:
        input_payload = _json_dict(latest.get("input_json"))
        output_payload = _json_dict(latest.get("output_json"))
        latest_events = list(reversed(events))
        runninghub_ids = _extract_runninghub_task_ids(latest, latest_events)
        visible_event = next(
            (
                event
                for event in events
                if str(event.get("message") or "").strip()
                and bool((event.get("data") if isinstance(event.get("data"), dict) else {}).get("user_visible", True))
            ),
            events[0] if events else None,
        )
        summary = (
            str(input_payload.get("workflow_chain_summary") or "")
            or str(output_payload.get("workflow_chain_summary") or "")
            or _task_type_label(latest.get("type"))
        )
        lines.extend(
            [
                "",
                f"最近任務: {latest.get('id')}",
                f"工作流: {_task_type_label(latest.get('type'))}",
                f"任務狀態: {_status_label(latest.get('status'))}",
                f"任務摘要: {summary}",
                f"最後更新: {_format_seconds_ago(latest.get('updated_at'))}",
            ]
        )
        if runninghub_ids:
            lines.append(f"生成任務: {', '.join(runninghub_ids[:3])}")
        lines.extend(_qa_report_lines(output_payload))
        if visible_event:
            message = str(visible_event.get("message") or "").strip()
            if message:
                lines.append(f"最新記錄: {message}")
        error = str(latest.get("error") or "").strip()
        if error:
            lines.append(f"錯誤: {_simple_failure_reason(error, latest.get('status'))}")
        lines.append(f"工作台網址: {service.resolve_config().public_base_url}")
    return "\n".join(lines)


class _ThreadedResolverConnector(TCPConnector):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("resolver", ThreadedResolver())
        super().__init__(*args, **kwargs)


class ScriptForm(StatesGroup):
    waiting_for_script = State()


class UploadFlowForm(StatesGroup):
    waiting_for_video = State()
    waiting_for_video_structure = State()
    waiting_for_product_image = State()
    waiting_for_portrait_image = State()
    waiting_for_scene_images = State()
    waiting_for_target_language = State()
    waiting_for_script_mode = State()
    waiting_for_audio = State()
    waiting_for_script = State()
    waiting_for_ratio = State()
    waiting_for_resolution = State()
    waiting_for_portrait_prompt = State()
    waiting_for_duration = State()
    waiting_for_digital_human_confirm = State()
    waiting_for_digital_human_script_confirm = State()
    waiting_for_digital_human_script_revision = State()
    waiting_for_digital_human_script_guided_revision = State()
    waiting_for_digital_human_main_image_confirm = State()
    waiting_for_digital_human_view_images_confirm = State()
    waiting_for_digital_human_final_confirm = State()


class ProductionWorkflowForm(StatesGroup):
    ecommerce_waiting_for_model_version = State()
    ecommerce_waiting_for_ad_style = State()
    ecommerce_waiting_for_target_language = State()
    ecommerce_waiting_for_product_three_view_image = State()
    ecommerce_waiting_for_product_info_image = State()
    ecommerce_waiting_for_product_image = State()
    ecommerce_waiting_for_prompt_guided_revision = State()
    ecommerce_waiting_for_model_image = State()
    ecommerce_waiting_for_voice_audio = State()
    ecommerce_waiting_for_video_structure = State()
    ecommerce_waiting_for_ratio = State()
    ecommerce_waiting_for_resolution = State()
    ecommerce_waiting_for_duration = State()
    ecommerce_waiting_for_user_prompt = State()
    ecommerce_waiting_for_animation_redraw_confirm = State()
    ecommerce_waiting_for_subtitle_choice = State()
    ecommerce_waiting_for_confirm = State()
    image_waiting_for_product_image = State()
    image_waiting_for_model_image = State()
    image_waiting_for_size = State()
    image_waiting_for_prompt = State()
    poster_translate_waiting_for_image = State()
    poster_translate_waiting_for_target_language = State()
    image_three_view_waiting_for_image = State()
    digital_human_character_waiting_for_region = State()
    digital_human_character_waiting_for_prompt = State()
    subject_replace_waiting_for_source_image = State()
    subject_replace_waiting_for_replacement_image = State()
    replace_model_waiting_for_video = State()
    replace_model_waiting_for_image = State()
    replace_model_waiting_for_duration = State()
    replace_product_waiting_for_video = State()
    replace_product_waiting_for_image = State()
    replace_product_waiting_for_name = State()
    replace_product_waiting_for_duration = State()
    union_waiting_for_video = State()
    union_waiting_for_model_image = State()
    union_waiting_for_product_image = State()
    union_waiting_for_name = State()
    union_waiting_for_duration = State()


def _detect_proxy() -> str | None:
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    proxies = urllib.request.getproxies()
    return proxies.get("https") or proxies.get("http")


def _build_bot(config: AppConfig) -> Bot:
    proxy = _detect_proxy()
    session = AiohttpSession(proxy=proxy)
    # Prefer the system threaded resolver to avoid intermittent aiodns failures
    # that can leave Telegram polling stalled without processing updates.
    session._connector_type = _ThreadedResolverConnector
    return Bot(
        token=config.tg_bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
        session=session,
    )


def _menu_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=DIGITAL_HUMAN_VIDEO_BUTTON), KeyboardButton(text=ECOMMERCE_SHORT_VIDEO_BUTTON)],
            [KeyboardButton(text=VIDEO_EDIT_BUTTON), KeyboardButton(text=IMAGE_GENERATION_MENU_BUTTON)],
            [KeyboardButton(text=RERUN_BUTTON), *_task_control_keyboard_row()],
        ],
        resize_keyboard=True,
    )


def _navigation_keyboard_row(*, include_back: bool = False) -> list[KeyboardButton]:
    row: list[KeyboardButton] = []
    if include_back:
        row.append(KeyboardButton(text=BACK_STEP_BUTTON))
    row.append(KeyboardButton(text=MAIN_MENU_BUTTON))
    return row


def _task_control_keyboard_row() -> list[KeyboardButton]:
    return [KeyboardButton(text=STATUS_BUTTON), KeyboardButton(text=STOP_BUTTON)]


def _image_generation_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=IMAGE_WORKFLOW_BUTTON), KeyboardButton(text=ECOMMERCE_POSTER_TRANSLATE_BUTTON)],
            [KeyboardButton(text=THREE_VIEW_IMAGE_BUTTON), KeyboardButton(text=DIGITAL_HUMAN_CHARACTER_BUTTON)],
            [KeyboardButton(text=SUBJECT_REPLACE_IMAGE_BUTTON)],
            _navigation_keyboard_row(),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _image_generation_result_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=IMAGE_REGENERATE_BUTTON)],
            [KeyboardButton(text=IMAGE_WORKFLOW_BUTTON), KeyboardButton(text=ECOMMERCE_POSTER_TRANSLATE_BUTTON)],
            [KeyboardButton(text=THREE_VIEW_IMAGE_BUTTON), KeyboardButton(text=DIGITAL_HUMAN_CHARACTER_BUTTON)],
            [KeyboardButton(text=SUBJECT_REPLACE_IMAGE_BUTTON)],
            _navigation_keyboard_row(),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_character_region_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="中国"), KeyboardButton(text="欧美")],
            [KeyboardButton(text="印尼"), KeyboardButton(text="泰国")],
            [KeyboardButton(text="日本"), KeyboardButton(text="马来西亚")],
            _navigation_keyboard_row(),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_structure_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_SINGLE_VIDEO_BUTTON), KeyboardButton(text=ECOMMERCE_STORYBOARD_VIDEO_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_model_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_SEEDANCE_FAST_BUTTON), KeyboardButton(text=ECOMMERCE_SEEDANCE_STANDARD_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_ad_style_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_STYLE_STORY_BUTTON), KeyboardButton(text=ECOMMERCE_STYLE_DOCUMENTARY_BUTTON)],
            [KeyboardButton(text=ECOMMERCE_STYLE_STANDARD_BUTTON), KeyboardButton(text=ECOMMERCE_STYLE_ANIMATION_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _target_language_keyboard(*, include_back: bool = True) -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="中文"), KeyboardButton(text="英文")],
            [KeyboardButton(text="马来西亚"), KeyboardButton(text="日语")],
            [KeyboardButton(text="西班牙语"), KeyboardButton(text="泰语")],
            _navigation_keyboard_row(include_back=include_back),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_product_upload_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_PRODUCT_DONE_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _image_generate_model_upload_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="跳过")],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_confirm_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="确认生成"), KeyboardButton(text="重新生成提示词")],
              [KeyboardButton(text=ECOMMERCE_GUIDED_REVISION_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_subtitle_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_SUBTITLE_ENABLE_BUTTON), KeyboardButton(text=ECOMMERCE_SUBTITLE_DISABLE_BUTTON)],
            [KeyboardButton(text="重新生成提示词")],
              [KeyboardButton(text=ECOMMERCE_GUIDED_REVISION_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_animation_redraw_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="确认转绘"), KeyboardButton(text="不转绘继续")],
            [KeyboardButton(text="重新生成提示词")],
              [KeyboardButton(text=ECOMMERCE_GUIDED_REVISION_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_ratio_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="16:9"), KeyboardButton(text="4:3"), KeyboardButton(text="1:1")],
            [KeyboardButton(text="3:4"), KeyboardButton(text="9:16")],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_resolution_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="480p"), KeyboardButton(text="720p")],
            [KeyboardButton(text="1080p"), KeyboardButton(text="2k"), KeyboardButton(text="4k")],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _ecommerce_step_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _target_language_code_from_data(data: dict[str, Any] | None) -> str:
    language = str((data or {}).get("target_language") or (data or {}).get("language") or "Chinese").strip() or "Chinese"
    return voice_presets.normalize_voice_preset_language(language)


def _elevenlabs_voice_presets_for_language(language: str) -> list[dict[str, str]]:
    return list(ELEVENLABS_OFFICIAL_VOICE_PRESETS.get(language) or ELEVENLABS_OFFICIAL_VOICE_PRESETS["Chinese"])


def _elevenlabs_voice_preset_by_button(text: str, language: str) -> dict[str, str] | None:
    return voice_presets.elevenlabs_voice_preset_by_button(text, language)


def _elevenlabs_voice_preset_display_label(preset: dict[str, str]) -> str:
    label = voice_presets.elevenlabs_voice_preset_display_label(preset)
    voice_name = str(preset.get("voice_name") or "").strip()
    if label and voice_name and voice_name not in label:
        return f"{label}（{voice_name}）"
    return label or voice_name


def _preset_dry_voice_keyboard(*, include_skip: bool = False, target_language: str = "Chinese") -> ReplyKeyboardMarkup:
    presets = _elevenlabs_voice_presets_for_language(target_language)
    keyboard: list[list[KeyboardButton]] = []
    row: list[KeyboardButton] = []
    for item in presets:
        row.append(KeyboardButton(text=str(item["button"])))
        if len(row) == 2:
            keyboard.append(row)
            row = []
    if row:
        keyboard.append(row)
    if include_skip:
        keyboard.append([KeyboardButton(text="跳过")])
    keyboard.append(_navigation_keyboard_row(include_back=True))
    keyboard.append(_task_control_keyboard_row())
    return ReplyKeyboardMarkup(keyboard=keyboard, resize_keyboard=True)


def _preset_dry_voice_asset_path(config: AppConfig, *, target_language: str, preset: dict[str, str]) -> Path:
    return _ensure_elevenlabs_preview_audio(config, target_language=target_language, preset=preset)


def _copy_preset_dry_voice_to_work_dir(
    config: AppConfig,
    *,
    target_language: str,
    preset: dict[str, str],
    work_dir: Path,
    prefix: str,
) -> tuple[Path, str]:
    source_path = _preset_dry_voice_asset_path(config, target_language=target_language, preset=preset)
    label = voice_presets.elevenlabs_voice_preset_display_label(preset)
    preset_key = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(preset.get("key") or preset.get("voice_name") or "voice")).strip("_")
    target_path = work_dir.resolve() / f"{prefix}_{preset_key}{source_path.suffix.lower() or '.mp3'}"
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, target_path)
    return target_path, label


def _elevenlabs_preview_audio_path(config: AppConfig, *, target_language: str, preset: dict[str, str]) -> Path:
    filename = voice_presets.elevenlabs_preview_cache_name(target_language, preset)
    return (config.project_root / "runtime" / "assets" / "elevenlabs_voice_previews" / filename).resolve()


def _ensure_elevenlabs_preview_audio(config: AppConfig, *, target_language: str, preset: dict[str, str]) -> Path:
    output_path = _elevenlabs_preview_audio_path(config, target_language=target_language, preset=preset)
    return voice_presets.ensure_elevenlabs_preview_audio(preset=preset, output_path=output_path)


async def _send_preset_dry_voice_previews(message: Message, config: AppConfig, *, target_language: str = "Chinese") -> None:
    presets = _elevenlabs_voice_presets_for_language(target_language)
    await message.answer(
        "可试听以下预设音色，试听后点击下方对应按钮使用；也可以直接上传自己的干音进行克隆。"
    )
    if presets:
        media_group: list[InputMediaAudio] = []
        failed_labels: list[str] = []
        for preset in presets:
            label = _elevenlabs_voice_preset_display_label(preset)
            try:
                preview_path = await asyncio.to_thread(
                    _ensure_elevenlabs_preview_audio,
                    config,
                    target_language=target_language,
                    preset=preset,
                )
            except Exception:
                logger.exception("Failed to prepare preset voice preview.")
                failed_labels.append(label)
                continue
            media_group.append(InputMediaAudio(media=FSInputFile(preview_path), caption=f"试听官方音色：{label}"))
        if media_group:
            try:
                await message.answer_media_group(media=media_group)
            except Exception:
                logger.exception("Failed to send preset voice previews as media group; falling back to individual messages.")
                for item in media_group:
                    try:
                        await message.answer_audio(audio=item.media, caption=str(item.caption or ""))
                    except Exception:
                        logger.exception("Failed to send preset voice preview audio.")
                        await message.answer_document(document=item.media, caption=str(item.caption or ""))
        labels = "、".join(_elevenlabs_voice_preset_display_label(item) for item in presets)
        suffix = f"\n以下音色试听生成失败，可稍后重试：{'、'.join(failed_labels)}" if failed_labels else ""
        await message.answer(f"当前语言可选：{labels}{suffix}")
        return


def _ecommerce_keyboard_for_state_name(state_name: str) -> ReplyKeyboardMarkup:
    text = str(state_name or "")
    if text.endswith("ecommerce_waiting_for_model_version"):
        return _ecommerce_model_keyboard()
    if text.endswith("ecommerce_waiting_for_ad_style"):
        return _ecommerce_ad_style_keyboard()
    if text.endswith("ecommerce_waiting_for_target_language"):
        return _target_language_keyboard()
    if text.endswith("ecommerce_waiting_for_product_three_view_image") or text.endswith("ecommerce_waiting_for_product_info_image"):
        return _ecommerce_product_upload_keyboard()
    if text.endswith("ecommerce_waiting_for_voice_audio"):
        return _preset_dry_voice_keyboard(include_skip=True)
    if text.endswith("ecommerce_waiting_for_video_structure"):
        return _ecommerce_structure_keyboard()
    if text.endswith("ecommerce_waiting_for_ratio"):
        return _ecommerce_ratio_keyboard()
    if text.endswith("ecommerce_waiting_for_resolution"):
        return _ecommerce_resolution_keyboard()
    if text.endswith("ecommerce_waiting_for_prompt_guided_revision"):
        return _ecommerce_step_keyboard()
    if text.endswith("ecommerce_waiting_for_animation_redraw_confirm"):
        return _ecommerce_animation_redraw_keyboard()
    if text.endswith("ecommerce_waiting_for_subtitle_choice"):
        return _ecommerce_subtitle_keyboard()
    if text.endswith("ecommerce_waiting_for_confirm"):
        return _ecommerce_confirm_keyboard()
    return _ecommerce_step_keyboard()


def _digital_human_structure_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=DIGITAL_HUMAN_SINGLE_VIDEO_BUTTON), KeyboardButton(text=DIGITAL_HUMAN_STORYBOARD_VIDEO_BUTTON)],
            _navigation_keyboard_row(),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_script_mode_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=DIGITAL_HUMAN_MANUAL_SCRIPT_BUTTON), KeyboardButton(text=DIGITAL_HUMAN_AI_SCRIPT_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_scene_upload_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_PRODUCT_DONE_BUTTON), KeyboardButton(text="跳过")],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_product_upload_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=ECOMMERCE_PRODUCT_DONE_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_confirm_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=DIGITAL_HUMAN_CONFIRM_BUTTON)],
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_step_keyboard(
    *, final: bool = False, include_guided_revision: bool = False
) -> ReplyKeyboardMarkup:
    primary = DIGITAL_HUMAN_FINAL_SUBMIT_BUTTON if final else DIGITAL_HUMAN_NEXT_BUTTON
    rows = [
        [KeyboardButton(text=primary), KeyboardButton(text=DIGITAL_HUMAN_REGENERATE_BUTTON)],
    ]
    if include_guided_revision:
        rows.append([KeyboardButton(text=DIGITAL_HUMAN_GUIDED_REVISION_BUTTON)])
    rows.extend(
        [
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ]
    )
    return ReplyKeyboardMarkup(
        keyboard=rows,
        resize_keyboard=True,
    )


def _digital_human_nav_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            _navigation_keyboard_row(include_back=True),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_single_view_regenerate_keyboard(view_index: int) -> InlineKeyboardMarkup:
    idx = max(int(view_index or 1), 1)
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=f"重新生成視角圖 {idx}", callback_data=f"dh_view_regen:{idx}")],
        ]
    )


def _image_edit_size_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="16:9"), KeyboardButton(text="4:3"), KeyboardButton(text="1:1")],
            [KeyboardButton(text="3:4"), KeyboardButton(text="9:16")],
            _navigation_keyboard_row(),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _digital_human_resolution_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="720"), KeyboardButton(text="1280"), KeyboardButton(text="1600")],
            _navigation_keyboard_row(),
            _task_control_keyboard_row(),
        ],
        resize_keyboard=True,
    )


def _video_edit_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=REPLACE_PRODUCT_WORKFLOW_BUTTON), KeyboardButton(text=REPLACE_MODEL_WORKFLOW_BUTTON)],
            [KeyboardButton(text=REPLACE_UNION_WORKFLOW_BUTTON), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _message_text(message: Message) -> str:
    return (message.text or message.caption or "").strip()


def _is_main_menu_text(text: str) -> bool:
    return str(text or "").strip() in MAIN_MENU_TEXTS


def _is_orphan_digital_human_step_text(text: str) -> bool:
    return str(text or "").strip() in DIGITAL_HUMAN_ORPHAN_STEP_BUTTONS


def _is_status_text(text: str) -> bool:
    return str(text or "").strip() in STATUS_TEXTS


def _looks_like_bot_operational_text(text: str) -> bool:
    source = str(text or "").strip()
    if not source:
        return False
    return any(marker in source for marker in BOT_OPERATIONAL_TEXT_MARKERS)


def _is_text(message: Message, *values: str) -> bool:
    return _message_text(message) in set(values)


def _load_runtime_config(config: AppConfig) -> dict[str, Any]:
    path = config.runtime_config_path
    try:
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to read runtime workflow config: %s", path)
        return {}
    return data if isinstance(data, dict) else {}


def _normalize_workflow_chain(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        parts = value
    else:
        text = str(value or "")
        for needle in ("->", ">", "，", "\n", "\r", ";"):
            text = text.replace(needle, ",")
        parts = text.split(",")
    result: list[str] = []
    for part in parts:
        workflow_id = str(part or "").strip()
        if workflow_id and workflow_id not in result:
            result.append(workflow_id)
    return result


def _workflow_chain(runtime: dict[str, Any], key: str, fallback: list[Any]) -> list[str]:
    chain = _normalize_workflow_chain(runtime.get(key))
    if chain:
        return chain
    return _normalize_workflow_chain(fallback)


def _format_chain(label: str, workflow_ids: list[str]) -> str:
    if not workflow_ids:
        return f"{label}: 未配置"
    return f"{label}: {' > '.join(workflow_ids)}"


def _format_image_edit_provider() -> str:
    return "電商廣告圖生產: 閉源圖片模型"


def _workflow_config_text(service: WorkspaceService, selected_button: str = "") -> str:
    config = service.resolve_config()
    runtime = _load_runtime_config(config)
    oral_chain = _workflow_chain(
        runtime,
        "oral_digital_human_workflow_ids",
        [config.audio_workflow_id, config.video_workflow_id],
    )
    image_chain = _workflow_chain(
        runtime,
        "image_generate_workflow_ids",
        [runtime.get("image_runninghub_workflow_id")],
    )
    ecommerce_chain = _workflow_chain(
        runtime,
        "ecommerce_short_video_workflow_ids",
        [runtime.get("ecommerce_short_video_app_id") or "2034917373414539277"],
    )
    replace_model_original_chain = _workflow_chain(
        runtime,
        "replace_model_original_workflow_ids",
        [runtime.get("replace_model_original_app_id") or runtime.get("replace_model_app_id")],
    )
    replace_model_primary_chain = _workflow_chain(
        runtime,
        "replace_model_primary_workflow_ids",
        [runtime.get("replace_model_primary_app_id")],
    )
    replace_model_slice_chain = _workflow_chain(
        runtime,
        "replace_model_slice_workflow_ids",
        [runtime.get("replace_model_slice_app_id")],
    )
    replace_model_motion_chain = _workflow_chain(
        runtime,
        "replace_model_motion_transfer_workflow_ids",
        [runtime.get("replace_model_motion_transfer_app_id")],
    )
    replace_product_chain = _workflow_chain(
        runtime,
        "replace_product_workflow_ids",
        [runtime.get("replace_product_app_id")],
    )
    replace_union_model_chain = _workflow_chain(
        runtime,
        "replace_union_model_workflow_ids",
        replace_model_original_chain,
    )
    replace_union_product_chain = _workflow_chain(
        runtime,
        "replace_union_product_workflow_ids",
        replace_product_chain,
    )

    selected_note = ""
    legacy_button_labels = {
        LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON: IMAGE_GENERATION_MENU_BUTTON,
        LEGACY_IMAGE_WORKFLOW_BUTTON: IMAGE_WORKFLOW_BUTTON,
        LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON: REPLACE_MODEL_WORKFLOW_BUTTON,
        LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON: REPLACE_PRODUCT_WORKFLOW_BUTTON,
    }
    display_selected_button = legacy_button_labels.get(selected_button, selected_button)
    if display_selected_button and display_selected_button != WORKFLOW_CONFIG_BUTTON:
        selected_note = f"你選擇的是「{display_selected_button}」。"

    if display_selected_button and display_selected_button != WORKFLOW_CONFIG_BUTTON:
        selected_map = {
            IMAGE_GENERATION_MENU_BUTTON: "圖片生成包含：電商廣告圖生產、电商图语种切换、三視圖生成、生成数字人、主体替换。",
            IMAGE_WORKFLOW_BUTTON: _format_image_edit_provider(),
            ECOMMERCE_POSTER_TRANSLATE_BUTTON: "电商图语种切换: 上传原始电商海报图，选择目标市场后，将海报内文字改成对应语言。",
            THREE_VIEW_IMAGE_BUTTON: "三視圖生成: 閉源圖片模型，固定輸出 4:3 比例。",
            DIGITAL_HUMAN_CHARACTER_BUTTON: "生成数字人: 可选择中国、欧美、印尼、泰国、日本、马来西亚地区特征，输出数字人人设三视图。",
            SUBJECT_REPLACE_IMAGE_BUTTON: "主体替换: 先上传原图，再上传替换图；系统判断替换图是模特还是商品，商品会替换原图中所有同类产品。",
            ECOMMERCE_SHORT_VIDEO_BUTTON: _format_chain("廣告短視頻工作流", ecommerce_chain),
            REPLACE_MODEL_WORKFLOW_BUTTON: _format_chain("視頻模特替換", replace_model_original_chain),
            REPLACE_PRODUCT_WORKFLOW_BUTTON: _format_chain("視頻商品替換", replace_product_chain),
            REPLACE_UNION_WORKFLOW_BUTTON: "\n".join(
                [
                    _format_chain("聯合替換·視頻模特鏈", replace_union_model_chain),
                    _format_chain("聯合替換·視頻商品鏈", replace_union_product_chain),
                ]
            ),
        }
        return "\n".join(
            [
                f"你選擇的是「{display_selected_button}」。",
                selected_map.get(display_selected_button, "").strip(),
                "",
                "這是生產工作流入口。",
                "請按面板提示依序上傳素材；提交後可按「查看工作台狀態」跟進進度。",
                f"工作台網址: {config.public_base_url}",
            ]
        ).strip()

    return "\n".join(
        [
            "後台工作流配置：",
            _format_chain("口播數字人工作流", oral_chain),
            _format_chain("廣告短視頻工作流", ecommerce_chain),
            _format_image_edit_provider(),
            _format_chain("視頻模特替換", replace_model_original_chain),
            _format_chain("視頻商品替換", replace_product_chain),
            _format_chain("聯合替換·視頻模特鏈", replace_union_model_chain),
            _format_chain("聯合替換·視頻商品鏈", replace_union_product_chain),
            "",
            selected_note,
            "TG 面板可直接建立任務：口播數字人、廣告短視頻、圖片生成、視頻編輯。",
            f"工作台網址: {config.public_base_url}",
        ]
    ).strip()


def _quick_start_text(service: WorkspaceService) -> str:
    return "\n".join(
        [
            f"🌟 {service.get_app_title()} 已啟動",
            "",
            "🌟 可用工作流",
            f"1. {DIGITAL_HUMAN_VIDEO_BUTTON}",
            "   依序上傳人像圖、克隆參考音頻，再輸入口播文稿（必填）。",
            f"2. {ECOMMERCE_SHORT_VIDEO_BUTTON}",
            "   先上傳產品/場景圖，再可選上傳講解人圖與音色；AI 會生成廣告片分鏡與台詞。",
            f"3. {IMAGE_GENERATION_MENU_BUTTON}",
            "   進入子菜單後，可選電商廣告圖生產或三視圖生成。",
            f"4. {VIDEO_EDIT_BUTTON}",
            "   進入子菜單後，可選視頻商品替換、視頻模特替換、聯合替換。",
            "",
            "🌟 直接對話",
            "你也可以直接描述任務並附上素材。",
            "Bot 會先用後台文字模型理解需求，再引導或建立對應工作流。",
            "",
            "🌟 常用操作",
            f"- {RERUN_BUTTON}：重跑最近一次任務。",
            f"- {STATUS_BUTTON}：查看任務進度。",
            f"- {STOP_BUTTON} 或 /stop：強制停止目前任務。",
            "",
            "✨ 詳細執行紀錄請到工作台任務詳情查看。",
        ]
    )


def _video_ext_from_message(message: Message) -> str | None:
    if message.video:
        file_name = (message.video.file_name or "").strip()
        suffix = Path(file_name).suffix.lower() if file_name else ".mp4"
        return suffix if suffix in VIDEO_EXTS else ".mp4"
    if message.document:
        suffix = Path(message.document.file_name or "").suffix.lower()
        if suffix in VIDEO_EXTS:
            return suffix
    return None


def _image_ext_from_message(message: Message) -> str | None:
    if message.photo:
        return ".jpg"
    if message.document:
        suffix = Path(message.document.file_name or "").suffix.lower()
        if suffix in IMAGE_EXTS:
            return suffix
    return None


def _audio_ext_from_message(message: Message) -> str | None:
    if message.audio:
        suffix = Path(message.audio.file_name or "").suffix.lower()
        return suffix if suffix in AUDIO_EXTS else ".mp3"
    if message.voice:
        return ".ogg"
    if message.document:
        suffix = Path(message.document.file_name or "").suffix.lower()
        if suffix in AUDIO_EXTS:
            return suffix
    return None


def _agent_file_ext_from_message(message: Message) -> tuple[str, str] | None:
    video_suffix = _video_ext_from_message(message)
    if video_suffix:
        return video_suffix, "video"
    image_suffix = _image_ext_from_message(message)
    if image_suffix:
        return image_suffix, "image"
    audio_suffix = _audio_ext_from_message(message)
    if audio_suffix:
        return audio_suffix, "audio"
    if message.document:
        suffix = Path(message.document.file_name or "").suffix.lower()
        if suffix in ZIP_EXTS:
            return suffix, "zip"
    return None


def _parse_duration_seconds(text: str) -> int | None:
    value = str(text or "").strip()
    if not value:
        raise ValueError("秒數不能為空")
    if value in AUTO_DURATION_TEXTS:
        return None
    seconds = math.ceil(float(value))
    if seconds <= 0:
        raise ValueError("秒數必須大於 0")
    return seconds


def _parse_ecommerce_duration_seconds(text: str) -> int:
    value = str(text or "").strip()
    if not re.fullmatch(r"\d{1,3}", value):
        raise ValueError("请直接输入 4 到 120 之间的数字")
    duration = int(value)
    if duration < 4 or duration > 120:
        raise ValueError("广告短视频总时长只能设置为 4 到 120 秒；超过 15 秒会自动拆成多段拼接")
    return duration


def _estimate_digital_human_duration_from_script(script: str) -> int:
    text = re.sub(r"\s+", "", str(script or ""))
    if not text:
        return 8
    seconds = int(math.ceil(len(text) / 4.5))
    return max(4, min(seconds, 35))


def _digital_human_submit_plan_text(params: dict[str, Any]) -> str:
    mode = str(params.get("digital_human_short_mode") or "single").strip()
    mode_label = "多分鏡口播視頻" if mode == "storyboard" else "單段口播視頻"
    script_text = str(params.get("speech_text") or "").strip()
    script_label = "AI 根據產品圖與模特圖生成" if _to_bool_like(params.get("use_ai_script")) else "使用你手動輸入的口播文稿"
    if script_text:
        compact_script = re.sub(r"\s+", " ", script_text)
        script_label = f"手動文稿：約 {len(compact_script)} 字"
    estimated_seconds = int(params.get("duration_seconds") or 0)
    ratio = str(params.get("ratio") or params.get("image_size") or "9:16").strip() or "9:16"
    resolution = int(params.get("max_resolution") or 1600)
    product_count = len(params.get("product_image_local_paths") or []) if isinstance(params.get("product_image_local_paths"), list) else 1
    image_plan = "生成 1 張人物與產品融合圖" if mode != "storyboard" else f"根據 {max(product_count, 1)} 張產品圖生成 4 張主/副分鏡圖，視頻固定 5 段"
    scene_count = len(params.get("digital_human_scene_image_local_paths") or []) if isinstance(params.get("digital_human_scene_image_local_paths"), list) else 0
    if scene_count:
        image_plan = f"使用 {scene_count} 張場景圖作為背景/空間分鏡參考"
    language_label = str(params.get("target_language_label") or "中文").strip() or "中文"
    expected_segments = 1 if mode != "storyboard" else 5
    return "\n".join(
        [
            "🌟 數字人視頻生成執行計劃",
            "",
            f"模式：{mode_label}",
            f"文稿：{script_label}",
            f"語言：{language_label}",
            f"畫面：{image_plan}",
            f"比例：{ratio}，分辨率：{resolution}",
            f"預估時長：約 {estimated_seconds or 15} 秒，預估分段：{expected_segments} 段",
            "",
            "確認後才會提交到後台隊列。",
            "後台會依次回報：文稿確認 → 圖像融合 → 視角/分段 → 口播音頻與視頻 → 合併完成。",
            "如需重新開始，請點「返回主菜單」後重新建立任務。",
        ]
    )


def _to_bool_like(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


async def _download_message_media(message: Message, target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    downloadable = None
    if message.video:
        downloadable = message.video
    elif message.audio:
        downloadable = message.audio
    elif message.voice:
        downloadable = message.voice
    elif message.photo:
        downloadable = message.photo[-1]
    elif message.document:
        downloadable = message.document
    else:
        raise RuntimeError("這則訊息沒有可下載的媒體檔案")
    await message.bot.download(downloadable, destination=target_path)
    return target_path


async def _download_agent_message_file(message: Message, work_dir: Path) -> dict[str, str] | None:
    detected = _agent_file_ext_from_message(message)
    if detected is None:
        return None
    suffix, kind = detected
    if message.document and message.document.file_name:
        raw_name = Path(message.document.file_name).name
    elif message.video and message.video.file_name:
        raw_name = Path(message.video.file_name).name
    else:
        raw_name = f"telegram_{kind}{suffix}"
    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", raw_name).strip("._-") or f"telegram_{kind}{suffix}"
    if not Path(safe_name).suffix:
        safe_name = f"{safe_name}{suffix}"
    target = work_dir / safe_name
    await _download_message_media(message, target)
    return {"name": safe_name, "path": str(target.resolve()), "kind": kind}


def _internal_webapp_base_url() -> str:
    return str(os.getenv("TG_INTERNAL_WEBAPP_BASE_URL") or "http://127.0.0.1:8091").strip().rstrip("/")


async def _submit_internal_webapp_task(
    *,
    chat_id: int,
    task_type: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/submit"
    try:
        async with ClientSession() as session:
            async with session.post(
                url,
                json={"task_type": str(task_type), "tg_chat_id": int(chat_id), "params": dict(params or {})},
                headers=headers,
                timeout=180,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    raise RuntimeError(f"后台任务提交失败 HTTP {response.status}: {body[:500]}")
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"后台任务提交返回非 JSON: {body[:300]}") from exc
    except asyncio.TimeoutError as exc:
        raise RuntimeError("后台任务提交响应超时，无法确认本次任务是否已进入队列，请查看工作台状态后再决定是否重试。") from exc
    if not isinstance(data, dict) or not data.get("id"):
        raise RuntimeError(f"后台任务提交返回缺少任务 ID: {data}")
    return data


async def _preview_internal_ecommerce_prompt(
    *,
    chat_id: int,
    params: dict[str, Any],
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/ecommerce_prompt_preview"
    try:
        async with ClientSession() as session:
            async with session.post(
                url,
                json={"task_type": "ecommerce_short_video", "tg_chat_id": int(chat_id), "params": dict(params or {})},
                headers=headers,
                timeout=300,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    detail = ""
                    try:
                        parsed = json.loads(body)
                        if isinstance(parsed, dict):
                            detail = str(parsed.get("detail") or parsed.get("message") or "").strip()
                    except Exception:
                        detail = ""
                    raise RuntimeError(detail or f"后台返回 HTTP {response.status}")
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"AI 提示词生成返回非 JSON: {body[:300]}") from exc
    except asyncio.TimeoutError as exc:
        raise RuntimeError("AI 生成提示词超时，素材已保留；请稍后点击「重新生成提示词」再试。") from exc
    if not isinstance(data, dict) or not isinstance(data.get("params"), dict):
        raise RuntimeError(f"AI 提示词生成返回格式不正确: {data}")
    return data


async def _run_internal_digital_human_step(
    *,
    chat_id: int,
    step: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/digital_human_step"
    try:
        async with ClientSession() as session:
            async with session.post(
                url,
                json={"step": str(step), "tg_chat_id": int(chat_id), "params": dict(params or {})},
                headers=headers,
                timeout=600,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    detail = ""
                    try:
                        parsed = json.loads(body)
                        if isinstance(parsed, dict):
                            detail = str(parsed.get("detail") or parsed.get("message") or "").strip()
                    except Exception:
                        detail = ""
                    raise RuntimeError(detail or f"后台返回 HTTP {response.status}: {body[:300]}")
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"数字人步骤返回非 JSON: {body[:300]}") from exc
    except asyncio.TimeoutError as exc:
        raise RuntimeError("数字人步骤生成超时，请稍后点击「重新生成」再试。") from exc
    if not isinstance(data, dict) or not data.get("ok"):
        raise RuntimeError(f"数字人步骤生成失败: {data}")
    return data


async def _run_internal_ecommerce_animation_redraw(
    *,
    chat_id: int,
    params: dict[str, Any],
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/ecommerce_animation_redraw"
    try:
        async with ClientSession() as session:
            async with session.post(
                url,
                json={"task_type": "ecommerce_short_video", "tg_chat_id": int(chat_id), "params": dict(params or {})},
                headers=headers,
                timeout=900,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    detail = ""
                    try:
                        parsed = json.loads(body)
                        if isinstance(parsed, dict):
                            detail = str(parsed.get("detail") or parsed.get("message") or "").strip()
                    except Exception:
                        detail = ""
                    raise RuntimeError(detail or f"后台返回 HTTP {response.status}: {body[:300]}")
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"动画转绘返回非 JSON: {body[:300]}") from exc
    except asyncio.TimeoutError as exc:
        raise RuntimeError("动画转绘超时，素材已保留；请稍后点击「确认转绘」再试。") from exc
    if not isinstance(data, dict) or not data.get("ok") or not isinstance(data.get("params"), dict):
        raise RuntimeError(f"动画转绘返回格式不正确: {data}")
    return data


async def _submit_internal_webapp_agent_task(
    *,
    chat_id: int,
    message_text: str,
    files: list[dict[str, str]],
    duration_seconds: int = 15,
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/agent_submit"
    async with ClientSession() as session:
        async with session.post(
            url,
            json={
                "message": str(message_text or "").strip(),
                "tg_chat_id": int(chat_id),
                "files": list(files or []),
                "use_ai_copy": True,
                "duration_seconds": int(duration_seconds or 15),
            },
            headers=headers,
            timeout=45,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"后台智能提交失败 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"后台智能提交返回非 JSON: {body[:300]}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"后台智能提交返回格式异常: {data}")
    if data.get("submitted") is False:
        return data
    if not data.get("id"):
        raise RuntimeError(f"后台智能提交返回缺少任务 ID: {data}")
    return data


async def _cancel_internal_webapp_active_task(*, chat_id: int) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/cancel_active"
    async with ClientSession() as session:
        async with session.post(url, json={"tg_chat_id": int(chat_id)}, headers=headers, timeout=15) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"后台取消任务失败 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"后台取消任务返回非 JSON: {body[:300]}") from exc
    return data if isinstance(data, dict) else {"ok": False, "message": "后台取消任务返回格式异常"}


async def _rerun_internal_webapp_latest_task(*, chat_id: int) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/rerun_latest"
    async with ClientSession() as session:
        async with session.post(url, json={"tg_chat_id": int(chat_id)}, headers=headers, timeout=15) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"后台重跑任务失败 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"后台重跑任务返回非 JSON: {body[:300]}") from exc
    return data if isinstance(data, dict) else {"ok": False, "message": "后台重跑任务返回格式异常"}


def build_dispatcher(config: AppConfig, service: WorkspaceService) -> Dispatcher:
    dispatcher = Dispatcher(storage=MemoryStorage())
    router = Router(name="workspace-bot")
    dispatcher.include_router(router)
    chat_script_drafts: dict[int, str] = {}
    ecommerce_product_album_buffers: dict[str, dict[str, Any]] = {}
    digital_human_product_album_buffers: dict[str, dict[str, Any]] = {}
    digital_human_scene_album_buffers: dict[str, dict[str, Any]] = {}
    digital_human_internal_steps: dict[int, dict[str, Any]] = {}

    async def ensure_authorized(message: Message) -> bool:
        try:
            user = message.from_user
            if user is not None:
                from ..telegram_admin import remember_trusted_user_profile
                remember_trusted_user_profile(
                    int(message.chat.id),
                    username=str(user.username or ""),
                    display_name=" ".join(part for part in (user.first_name, user.last_name) if part),
                )
        except Exception:
            logger.exception("Failed to remember Telegram member profile")
        if service.is_chat_authorized(int(message.chat.id)):
            return True
        await message.answer("你的 TG 帳號尚未加入工作台名單，請先到 Web 工作台設定成員。")
        return False

    async def start_upload_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg")
        await state.clear()
        await state.set_state(UploadFlowForm.waiting_for_video_structure)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 數字人視頻生成",
                    "步驟 1/8：請選擇生成模式",
                    "",
                    f"1. {DIGITAL_HUMAN_SINGLE_VIDEO_BUTTON}：適合短文稿，融合 1 張主圖後生成完整口播視頻。",
                    f"2. {DIGITAL_HUMAN_STORYBOARD_VIDEO_BUTTON}：適合長文稿，生成多張一致視角圖後分段合成。",
                ]
            ),
            reply_markup=_digital_human_structure_keyboard(),
        )

    async def handle_entry_keyword(message: Message, state: FSMContext) -> bool:
        text = _message_text(message)
        if _is_main_menu_text(text):
            if not await ensure_authorized(message):
                return True
            await state.clear()
            await message.answer("已返回主菜單。", reply_markup=_menu_keyboard())
            return True
        if _is_status_text(text):
            if not await ensure_authorized(message):
                return True
            current_state = str(await state.get_state() or "")
            if "waiting_for_digital_human_" in current_state:
                markup = _digital_human_step_keyboard(
                    final=current_state.endswith("final_confirm"),
                    include_guided_revision=current_state.endswith(
                        "waiting_for_digital_human_script_confirm"
                    ),
                )
            elif "ecommerce_waiting_for_" in current_state:
                markup = _ecommerce_keyboard_for_state_name(current_state)
            else:
                markup = _menu_keyboard()
            chat_id = int(message.chat.id)
            await message.answer("正在读取工作台状态...", reply_markup=markup)
            await message.answer(
                _webapp_status_text(service, chat_id=chat_id, internal_step=digital_human_internal_steps.get(chat_id)),
                reply_markup=markup,
            )
            return True
        if text != "多智能體數字人":
            return False
        if not await ensure_authorized(message):
            return True
        await state.clear()
        await message.answer(_quick_start_text(service), reply_markup=_menu_keyboard())
        return True

    async def handle_workflow_reference_request(message: Message, state: FSMContext | None = None) -> bool:
        text = _message_text(message)
        if text not in WORKFLOW_REFERENCE_BUTTONS:
            return False
        if not await ensure_authorized(message):
            return True
        if state is not None:
            await state.clear()
        await message.answer(_workflow_config_text(service, selected_button=text), reply_markup=_menu_keyboard())
        return True

    async def handle_stop_request(message: Message, state: FSMContext) -> bool:
        text = _message_text(message)
        if text != STOP_BUTTON and not text.startswith("/stop"):
            return False
        if not await ensure_authorized(message):
            return True
        await state.clear()
        await message.answer("已收到停止请求，正在取消后台任务...", reply_markup=_menu_keyboard())

        try:
            webapp_cancel = await _cancel_internal_webapp_active_task(chat_id=int(message.chat.id))
        except Exception:
            logger.exception("Failed to cancel active Web task from Telegram.")
            webapp_cancel = {}
        if bool(webapp_cancel.get("cancelled")):
            task_id = str(webapp_cancel.get("id") or "").strip()
            previous_status = str(webapp_cancel.get("previous_status") or "").strip()
            note = "已從後台隊列取消任務。"
            if previous_status == "running":
                cancel_results = webapp_cancel.get("runninghub_cancel_results")
                if isinstance(cancel_results, list) and cancel_results:
                    ok_count = sum(1 for item in cancel_results if isinstance(item, dict) and bool(item.get("ok")))
                    note = f"已標記後台任務取消，並嘗試停止 生成任務（成功 {ok_count}/{len(cancel_results)}）。"
                else:
                    note = "已標記後台任務取消；若 生成任務尚未登記，後續本地流程會在下一個檢查點中止。"
            await message.answer(
                "\n".join(
                    [
                        note,
                        f"任務編號: {task_id}" if task_id else "",
                    ]
                ).strip(),
                reply_markup=_menu_keyboard(),
            )
            return True

        active_task = service.store.get_active_task()
        target_task = active_task or service.get_latest_open_task_for_submitter(int(message.chat.id))
        if target_task is None:
            message_text = str(webapp_cancel.get("message") or "目前沒有可強制停止的任務。").strip()
            await message.answer(message_text, reply_markup=_menu_keyboard())
            return True

        result = await service.cancel_task(target_task.id, requested_by=f"TG-{int(message.chat.id)}")
        await message.answer(result.message, reply_markup=_menu_keyboard())
        return True

    async def handle_ecommerce_back_request(message: Message, state: FSMContext) -> bool:
        if _message_text(message) != BACK_STEP_BUTTON:
            return False
        current_state = str(await state.get_state() or "")
        data = await state.get_data()

        async def go(target: State, text: str, markup: ReplyKeyboardMarkup, updates: dict[str, Any] | None = None) -> bool:
            if updates:
                await state.update_data(**updates)
            await state.set_state(target)
            await message.answer(text, reply_markup=markup)
            return True

        if current_state.endswith("ecommerce_waiting_for_model_version"):
            await state.clear()
            await message.answer("已返回广告短视频入口。", reply_markup=_menu_keyboard())
            return True
        if current_state.endswith("ecommerce_waiting_for_ad_style"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_model_version,
                "已返回上一步。步驟 1/13：請選擇視頻模型。",
                _ecommerce_model_keyboard(),
                {
                    "ecommerce_model": "",
                    "ecommerce_workflow_id": "",
                    "ecommerce_short_video_workflow_ids": [],
                    "ecommerce_short_video_app_id": "",
                    "app_id": "",
                },
            )
        if current_state.endswith("ecommerce_waiting_for_product_three_view_image"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_target_language,
                "已返回上一步。步驟 3/13：請選擇目標地區語言。",
                _target_language_keyboard(),
                {"target_language": "", "target_language_label": "", "language": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_target_language"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_ad_style,
                "已返回上一步。步驟 2/13：請選擇廣告視頻的風格傾向。",
                _ecommerce_ad_style_keyboard(),
                {"ecommerce_ad_style": "", "ecommerce_ad_style_label": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_product_info_image"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_product_three_view_image,
                "\n".join(
                    [
                        "已返回上一步。步驟 4/13：請重新上傳產品三視圖或主體標準圖。",
                        "這一步只上傳 1 張最能代表產品本體的正面、側面、背面、多角度三視圖或最清晰主圖。",
                    ]
                ),
                _ecommerce_product_upload_keyboard(),
                {
                    "product_image_local_path": "",
                    "product_image_local_paths": [],
                    "ecommerce_product_three_view_image_local_paths": [],
                    "ecommerce_product_info_image_local_paths": [],
                },
            )
        if current_state.endswith("ecommerce_waiting_for_model_image"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_product_info_image,
                "已返回上一步。步驟 5/13：請上傳產品介紹相關圖片；如果沒有介紹圖，可輸入「跳過」。",
                _ecommerce_product_upload_keyboard(),
                {"model_image_local_path": "", "ecommerce_model_reference_skipped": False, "ecommerce_person_weight_mode": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_voice_audio"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_model_image,
                "已返回上一步。步驟 6/13：請上傳講解人/模特或背景圖；如果不需要模特/背景參考，請輸入「跳過」。",
                _ecommerce_step_keyboard(),
                {"audio_local_path": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_video_structure"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_voice_audio,
                "已返回上一步。步驟 7/13：請上傳音色參考音頻；如果不需要指定音色，請輸入「跳過」。",
                _ecommerce_step_keyboard(),
                {"video_structure": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_ratio"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_video_structure,
                "已返回上一步。步驟 8/13：請選擇成片形式。",
                _ecommerce_structure_keyboard(),
                {"ratio": "", "ratio_label": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_resolution"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_ratio,
                "已返回上一步。步驟 9/13：請選擇視頻比例。",
                _ecommerce_ratio_keyboard(),
                {"resolution": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_duration"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_resolution,
                "已返回上一步。步驟 10/13：請選擇分辨率。",
                _ecommerce_resolution_keyboard(),
                {"duration_seconds": 0},
            )
        if current_state.endswith("ecommerce_waiting_for_user_prompt"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_duration,
                "已返回上一步。步驟 11/13：請輸入視頻總時長，只能輸入 4 到 120 之間的數字。",
                _ecommerce_step_keyboard(),
                {"user_prompt": "", "ecommerce_generated_params": {}},
            )
        if current_state.endswith("ecommerce_waiting_for_prompt_guided_revision"):
            origin = str(
                data.get("ecommerce_guided_revision_return_state") or "subtitle"
            ).strip().lower()
            if origin == "animation":
                target_state = ProductionWorkflowForm.ecommerce_waiting_for_animation_redraw_confirm
                target_markup = _ecommerce_animation_redraw_keyboard()
                target_text = "已返回提示词确认。請選擇「确认转绘」或「不转绘继续」。"
            elif origin == "confirm":
                target_state = ProductionWorkflowForm.ecommerce_waiting_for_confirm
                target_markup = _ecommerce_confirm_keyboard()
                target_text = "已返回提示词确认。确认无误后点击「确认生成」。"
            else:
                target_state = ProductionWorkflowForm.ecommerce_waiting_for_subtitle_choice
                target_markup = _ecommerce_subtitle_keyboard()
                target_text = "已返回提示词确认。请选择是否添加字幕。"
            return await go(
                target_state,
                target_text,
                target_markup,
                {"ecommerce_guided_revision_return_state": ""},
            )
        if current_state.endswith("ecommerce_waiting_for_animation_redraw_confirm"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_user_prompt,
                "已返回上一步。步驟 12/13：可以輸入一段提示詞或文案；如果不想輸入，請點擊或輸入「跳過」。",
                _ecommerce_step_keyboard(),
                {"ecommerce_generated_params": {}},
            )
        if current_state.endswith("ecommerce_waiting_for_subtitle_choice"):
            target_state = ProductionWorkflowForm.ecommerce_waiting_for_animation_redraw_confirm if str(data.get("ecommerce_ad_style") or "") == "animation" else ProductionWorkflowForm.ecommerce_waiting_for_user_prompt
            target_text = (
                "已返回上一步。請選擇「确认转绘」或「不转绘继续」。"
                if target_state == ProductionWorkflowForm.ecommerce_waiting_for_animation_redraw_confirm
                else "已返回上一步。步驟 12/13：可以輸入一段提示詞或文案；如果不想輸入，請點擊或輸入「跳過」。"
            )
            return await go(
                target_state,
                target_text,
                _ecommerce_animation_redraw_keyboard() if target_state == ProductionWorkflowForm.ecommerce_waiting_for_animation_redraw_confirm else _ecommerce_step_keyboard(),
                {"ecommerce_generated_params": {}},
            )
        if current_state.endswith("ecommerce_waiting_for_confirm"):
            return await go(
                ProductionWorkflowForm.ecommerce_waiting_for_subtitle_choice,
                "已返回上一步。请选择生成视频后是否添加字幕。",
                _ecommerce_subtitle_keyboard(),
            )

        await message.answer("當前步驟暫不支持返回上一步。", reply_markup=_menu_keyboard())
        return True

    async def handle_digital_human_back_request(message: Message, state: FSMContext) -> bool:
        if _message_text(message) != BACK_STEP_BUTTON:
            return False
        current_state = str(await state.get_state() or "")
        data = await state.get_data()

        async def go(target: State, text: str, markup: ReplyKeyboardMarkup, updates: dict[str, Any] | None = None) -> bool:
            if updates:
                await state.update_data(**updates)
            await state.set_state(target)
            await message.answer(text, reply_markup=markup)
            return True

        if current_state.endswith("waiting_for_video_structure"):
            await state.clear()
            await message.answer("已返回主菜單。", reply_markup=_menu_keyboard())
            return True
        if current_state.endswith("waiting_for_product_image"):
            return await go(
                UploadFlowForm.waiting_for_video_structure,
                "已返回上一步。步驟 1/8：請選擇生成模式。",
                _digital_human_structure_keyboard(),
                {"digital_human_short_mode": ""},
            )
        if current_state.endswith("waiting_for_portrait_image"):
            return await go(
                UploadFlowForm.waiting_for_product_image,
                "已返回上一步。步驟 2/8：請重新上傳 1-4 張產品圖；上傳完後點「完成上传，下一步」。",
                _digital_human_product_upload_keyboard(),
                {"product_image_local_path": "", "product_image_local_paths": [], "portrait_image_local_path": ""},
            )
        if current_state.endswith("waiting_for_scene_images"):
            return await go(
                UploadFlowForm.waiting_for_portrait_image,
                "已返回上一步。步驟 3/8：請重新上傳模特圖 / 數字人形象圖。",
                _digital_human_nav_keyboard(),
                {"portrait_image_local_path": "", "digital_human_scene_image_local_paths": []},
            )
        if current_state.endswith("waiting_for_target_language"):
            scene_count = len([item for item in (data.get("digital_human_scene_image_local_paths") or []) if str(item or "").strip()])
            return await go(
                UploadFlowForm.waiting_for_scene_images,
                f"已返回上一步。步驟 4/8：可繼續上傳場景圖，已收到 {scene_count} 張；不需要可點「跳过」。",
                _digital_human_scene_upload_keyboard(),
                {"target_language": "", "target_language_label": "", "language": ""},
            )
        if current_state.endswith("waiting_for_script_mode"):
            return await go(
                UploadFlowForm.waiting_for_target_language,
                "已返回上一步。步驟 5/8：請選擇目標地區語言。",
                _target_language_keyboard(),
                {"use_ai_script": False, "script_text": ""},
            )
        if current_state.endswith("waiting_for_script"):
            return await go(
                UploadFlowForm.waiting_for_script_mode,
                "已返回上一步。步驟 6/8：請選擇口播文稿來源。",
                _digital_human_script_mode_keyboard(),
                {"script_text": ""},
            )
        if current_state.endswith("waiting_for_ratio"):
            if bool(data.get("use_ai_script")):
                return await go(
                    UploadFlowForm.waiting_for_script_mode,
                    "已返回上一步。步驟 6/8：請選擇口播文稿來源。",
                    _digital_human_script_mode_keyboard(),
                    {"ratio": "", "image_size": ""},
                )
            return await go(
                UploadFlowForm.waiting_for_script,
                "已返回上一步。請重新貼上這次的口播文稿。",
                _digital_human_nav_keyboard(),
                {"ratio": "", "image_size": ""},
            )
        if current_state.endswith("waiting_for_audio"):
            return await go(
                UploadFlowForm.waiting_for_ratio,
                "已返回上一步。步驟 7/8：請選擇圖像比例，圖像按 2K 質感生成。",
                _ecommerce_ratio_keyboard(),
                {
                    "audio_local_path": "",
                    "preset_dry_voice": "",
                    "minimax_tts_voice_id": "",
                    "elevenlabs_tts_preset_key": "",
                    "elevenlabs_tts_voice_id": "",
                    "tts_provider": "",
                    "speaker": "",
                },
            )
        if current_state.endswith("waiting_for_digital_human_confirm"):
            current_data = await state.get_data()
            target_language = _target_language_code_from_data(current_data)
            await _send_preset_dry_voice_previews(message, config, target_language=target_language)
            return await go(
                UploadFlowForm.waiting_for_audio,
                "已返回上一步。步驟 8/8：請上傳需要克隆的參考音頻，或選擇預設音色。",
                _preset_dry_voice_keyboard(target_language=target_language),
                {"digital_human_pending_params": {}},
            )
        if current_state.endswith("waiting_for_digital_human_script_confirm"):
            return await go(
                UploadFlowForm.waiting_for_digital_human_confirm,
                "已返回上一步。請確認本次任務計劃。",
                _digital_human_confirm_keyboard(),
            )
        if current_state.endswith("waiting_for_digital_human_script_revision"):
            return await go(
                UploadFlowForm.waiting_for_digital_human_script_confirm,
                "已返回上一步。請確認口播文稿，或點「重新生成」再次修改。",
                _digital_human_step_keyboard(include_guided_revision=True),
            )
        if current_state.endswith("waiting_for_digital_human_script_guided_revision"):
            return await go(
                UploadFlowForm.waiting_for_digital_human_script_confirm,
                "已返回上一步。請確認口播文稿，或重新點「引導修改提示詞」。",
                _digital_human_step_keyboard(include_guided_revision=True),
            )

        if current_state.endswith("waiting_for_digital_human_main_image_confirm"):
            return await go(
                UploadFlowForm.waiting_for_digital_human_script_confirm,
                "已返回上一步。請確認口播文稿。",
                _digital_human_step_keyboard(),
            )
        if current_state.endswith("waiting_for_digital_human_view_images_confirm"):
            return await go(
                UploadFlowForm.waiting_for_digital_human_main_image_confirm,
                "已返回上一步。請確認融合主圖。",
                _digital_human_step_keyboard(),
            )
        if current_state.endswith("waiting_for_digital_human_final_confirm"):
            fusion_paths = data.get("digital_human_fusion_image_paths")
            target_state = UploadFlowForm.waiting_for_digital_human_view_images_confirm if isinstance(fusion_paths, list) and len(fusion_paths) > 1 else UploadFlowForm.waiting_for_digital_human_main_image_confirm
            return await go(
                target_state,
                "已返回上一步。請確認分鏡視角圖。" if target_state == UploadFlowForm.waiting_for_digital_human_view_images_confirm else "已返回上一步。請確認融合主圖。",
                _digital_human_step_keyboard(),
            )

        await message.answer("當前步驟暫不支持返回上一步。", reply_markup=_menu_keyboard())
        return True

    async def enqueue_request(
        message: Message,
        request: WorkflowRequest,
        *,
        source: str,
        is_default_assets: bool,
    ) -> None:
        service.submit_task(
            request=request,
            submitter_chat_id=int(message.chat.id),
            source=source,
            is_default_assets=is_default_assets,
        )

    async def submit_webapp_task_and_reply(message: Message, task_type: str, params: dict[str, Any]) -> None:
        workflow_label = str(params.get("tg_workflow_label") or _task_type_label(task_type)).strip()
        await message.answer(
            "\n".join(
                [
                    "已收到生成请求，正在提交后台队列...",
                    f"工作流: {workflow_label}",
                ]
            ),
            reply_markup=_menu_keyboard(),
        )
        result = await _submit_internal_webapp_task(
            chat_id=int(message.chat.id),
            task_type=task_type,
            params=params,
        )
        _schedule_webapp_task_notification(
            message.bot,
            service,
            chat_id=int(message.chat.id),
            task_id=str(result.get("id") or ""),
        )
        await message.answer(
            "\n".join(
                [
                    "任務已提交到後台隊列。",
                    f"工作流: {workflow_label}",
                    f"任務編號: {result.get('id')}",
                    "可按「查看工作台狀態」跟進進度。",
                ]
            ),
            reply_markup=_menu_keyboard(),
        )

    async def run_digital_human_step_and_update(
        message: Message,
        state: FSMContext,
        *,
        step: str,
        running_text: str,
    ) -> dict[str, Any] | None:
        data = await state.get_data()
        params = data.get("digital_human_pending_params")
        if not isinstance(params, dict) or not params:
            await state.clear()
            await message.answer(f"任務計劃已失效，請重新點擊「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立任務。", reply_markup=_menu_keyboard())
            return None
        await message.answer(running_text, reply_markup=_digital_human_step_keyboard())
        chat_id = int(message.chat.id)
        digital_human_internal_steps[chat_id] = {
            "workflow": DIGITAL_HUMAN_VIDEO_BUTTON,
            "step": str(step),
            "stage": str(running_text or "处理中").replace("，請稍候。", "").replace("，请稍候。", ""),
            "started_at": int(time.time()),
        }
        try:
            result = await _run_internal_digital_human_step(chat_id=chat_id, step=step, params=params)
        except Exception as exc:
            await message.answer(f"這一步生成失敗：{exc}\n可點「重新生成」再試，或返回主菜單重新建立任務。", reply_markup=_digital_human_step_keyboard())
            return None
        finally:
            current = digital_human_internal_steps.get(chat_id)
            if isinstance(current, dict) and str(current.get("step") or "") == str(step):
                digital_human_internal_steps.pop(chat_id, None)
        next_params = result.get("params")
        if isinstance(next_params, dict):
            await state.update_data(digital_human_pending_params=next_params)
        return result

    async def show_digital_human_script_step(message: Message, state: FSMContext, *, regenerate: bool = False) -> None:
        if regenerate:
            data = await state.get_data()
            params = data.get("digital_human_pending_params")
            if isinstance(params, dict):
                params = dict(params)
                params.pop("speech_text", None)
                params.pop("message", None)
                params.pop("revision_instruction", None)
                await state.update_data(digital_human_pending_params=params)
        result = await run_digital_human_step_and_update(
            message,
            state,
            step="script",
            running_text="正在生成口播文稿，請稍候。" if regenerate else "正在準備口播文稿，請稍候。",
        )
        if result is None:
            return
        script = str(result.get("speech_text") or "").strip()
        await state.set_state(UploadFlowForm.waiting_for_digital_human_script_confirm)
        await message.answer(
            "\n".join(
                [
                    "🌟 步驟 1/5：口播文稿已準備",
                    "",
                    script or "（空）",
                    "",
                    "確認後才會進入圖像融合；如需調整可點「引導修改提示詞」，或點「重新生成」。",
                ]
            ),
            reply_markup=_digital_human_step_keyboard(include_guided_revision=True),
        )

    async def show_digital_human_main_image_step(message: Message, state: FSMContext, *, regenerate: bool = False) -> None:
        result = await run_digital_human_step_and_update(
            message,
            state,
            step="fusion_main",
            running_text="正在重新生成人物與產品融合主圖，請稍候。" if regenerate else "正在生成人物與產品融合主圖，請稍候。",
        )
        if result is None:
            return
        image_path = str(result.get("image_path") or "").strip()
        await state.set_state(UploadFlowForm.waiting_for_digital_human_main_image_confirm)
        if image_path and Path(image_path).exists():
            await message.answer_photo(
                FSInputFile(image_path),
                caption="🌟 步驟 2/5：融合主圖已生成。確認後才會生成多分鏡視角圖；如不滿意可點「重新生成」。",
                reply_markup=_digital_human_step_keyboard(),
            )
        else:
            await message.answer("融合主圖已生成，但本地文件不可讀。請點「重新生成」再試。", reply_markup=_digital_human_step_keyboard())

    async def show_digital_human_view_images_step(message: Message, state: FSMContext, *, regenerate: bool = False) -> None:
        data = await state.get_data()
        params = data.get("digital_human_pending_params") if isinstance(data.get("digital_human_pending_params"), dict) else {}
        mode = str((params or {}).get("digital_human_short_mode") or "single").strip()
        if mode != "storyboard":
            await state.set_state(UploadFlowForm.waiting_for_digital_human_final_confirm)
            await message.answer(
                "🌟 步驟 3/5：單段模式無需額外視角圖。\n確認後將提交最終口播視頻生成。",
                reply_markup=_digital_human_step_keyboard(final=True),
            )
            return
        await state.set_state(UploadFlowForm.waiting_for_digital_human_view_images_confirm)
        result = await run_digital_human_step_and_update(
            message,
            state,
            step="fusion_views",
            running_text="正在重新生成多分鏡一致性視角圖，請稍候。" if regenerate else "正在生成多分鏡一致性視角圖，請稍候。",
        )
        if result is None:
            return
        image_paths = [str(item or "").strip() for item in (result.get("image_paths") if isinstance(result.get("image_paths"), list) else []) if str(item or "").strip()]
        await state.set_state(UploadFlowForm.waiting_for_digital_human_view_images_confirm)
        await message.answer(
            f"🌟 步驟 3/5：已生成 {len(image_paths)} 張視角圖。下面會逐張發出，確認後才會提交視頻生成。",
            reply_markup=_digital_human_step_keyboard(),
        )
        for idx, image_path in enumerate(image_paths, start=1):
            if Path(image_path).exists():
                await message.answer_photo(
                    FSInputFile(image_path),
                    caption=f"視角圖 {idx}/{len(image_paths)}",
                    reply_markup=_digital_human_single_view_regenerate_keyboard(idx),
                )
        await message.answer("請確認這組視角圖是否可用；如某張不滿意，請點該圖下方的「重新生成視角圖」。", reply_markup=_digital_human_step_keyboard())

    async def show_digital_human_final_step(message: Message, state: FSMContext) -> None:
        data = await state.get_data()
        params = data.get("digital_human_pending_params") if isinstance(data.get("digital_human_pending_params"), dict) else {}
        script = str((params or {}).get("speech_text") or "").strip()
        fusion_paths = (params or {}).get("digital_human_fusion_image_paths")
        fusion_count = len(fusion_paths) if isinstance(fusion_paths, list) else (1 if str((params or {}).get("digital_human_main_image_local_path") or "").strip() else 0)
        await state.set_state(UploadFlowForm.waiting_for_digital_human_final_confirm)
        await message.answer(
            "\n".join(
                [
                    "🌟 步驟 4/5：視頻生成提交前確認",
                    f"已確認文稿：約 {len(script)} 字",
                    f"已確認畫面：{fusion_count} 張",
                    "確認後才會提交音頻與視頻生成任務，完成後自動合併輸出。",
                ]
            ),
            reply_markup=_digital_human_step_keyboard(final=True),
        )

    def _build_ecommerce_tg_user_instruction(data: dict[str, Any], *, duration: int, structure_label: str) -> str:
        parts = [
            "根据上传素材生成高级商业片质感的商业广告短视频提示词。",
            "先判断广告主体和有效参考图，低价值或重复图片不必强行使用。",
            "让系统自主设计画面和镜头，不要套固定模板。",
            "输出连续时间轴，时间只能用整数秒；可写色彩矩阵、模特形象、分镜剧情和镜头类型，让画面更有大片创意和广告记忆点；台词可以有，也可以没有。",
            "如果需要人物说话内容，直接写进对应镜头；只有统一旁白才放在时间线最后一行。",
        ]
        language_label = str(data.get("target_language_label") or "中文").strip() or "中文"
        parts.append(f"目标地区语言：{language_label}。所有台词、旁白和后续字幕文本都必须使用{language_label}。")
        if bool(data.get("ecommerce_model_reference_skipped")):
            parts.append("用户已跳过模特/背景参考图：人物弱化，只允许手部、背影、侧身、远景或虚焦，不要正面人脸。")
        parts.extend(
            [
                "硬规则由后端处理，这里不要堆限制；不要输出分析标题。",
                "只使用真实 @Image 编号；不要 @Model/@Product；不要字幕水印；不要编造品牌参数。",
                "无字幕，无背景音乐。",
                f"视频结构：{structure_label}。画面比例：{str(data.get('ratio_label') or data.get('ratio') or '16:9')}。分辨率：{str(data.get('resolution') or '720p')}。视频时长：{duration} 秒。",
            ]
        )
        user_prompt = str(data.get("user_prompt") or "").strip()
        if user_prompt:
            parts.append(f"用户原始提示词：{user_prompt}。请在此基础上优化。")
        ad_style_label = str(data.get("ecommerce_ad_style_label") or "").strip()
        if ad_style_label:
            if str(data.get("ecommerce_ad_style") or "").strip() == "animation":
                parts.append("生成动画广告风格的视频提示词。")
            elif str(data.get("ecommerce_ad_style") or "").strip() == "documentary":
                parts.append("生成纪录片广告风格的视频提示词。")
            elif str(data.get("ecommerce_ad_style") or "").strip() == "story":
                parts.append("生成剧情式广告短片风格的视频提示词。")
            else:
                parts.append("生成大片质感商业广告视频提示词。")
        return "".join(parts)

    def _build_ecommerce_preview_params(data: dict[str, Any]) -> dict[str, Any]:
        video_structure = str(data.get("video_structure") or "single")
        duration = int(data.get("duration_seconds") or 8)
        max_dialogue_chars = max(duration * 4, 16)
        structure_label = "多段分镜视频" if video_structure == "storyboard" else "单条长视频"
        product_paths = [
            str(item or "").strip()
            for item in (data.get("product_image_local_paths") or [])
            if str(item or "").strip()
        ]
        three_view_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_three_view_image_local_paths") or [])
            if str(item or "").strip()
        ]
        info_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_info_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if three_view_paths:
            merged_paths = [*three_view_paths, *[item for item in info_paths if item not in three_view_paths]]
            product_paths = merged_paths
        product_main = str(data.get("product_image_local_path") or (product_paths[0] if product_paths else "")).strip()
        return {
            "product_image_local_path": product_main,
            "product_image_local_paths": product_paths or ([product_main] if product_main else []),
            "ecommerce_product_three_view_image_local_paths": three_view_paths,
            "ecommerce_product_info_image_local_paths": info_paths,
            "model_image_local_path": str(data.get("model_image_local_path") or ""),
            "ecommerce_model_reference_skipped": bool(data.get("ecommerce_model_reference_skipped")),
            "ecommerce_person_weight_mode": str(data.get("ecommerce_person_weight_mode") or ""),
            "audio_local_path": str(data.get("audio_local_path") or ""),
            "preset_dry_voice": str(data.get("preset_dry_voice") or ""),
            "minimax_tts_voice_id": str(data.get("minimax_tts_voice_id") or ""),
            "elevenlabs_tts_preset_key": str(data.get("elevenlabs_tts_preset_key") or ""),
            "elevenlabs_tts_voice_id": str(data.get("elevenlabs_tts_voice_id") or ""),
            "tts_provider": str(data.get("tts_provider") or ""),
            "speaker": str(data.get("speaker") or ""),
            "ecommerce_model": str(data.get("ecommerce_model") or ECOMMERCE_SEEDANCE_FAST_BUTTON),
            "ecommerce_short_video_model": str(data.get("ecommerce_model") or ECOMMERCE_SEEDANCE_FAST_BUTTON),
            "ecommerce_ad_style": str(data.get("ecommerce_ad_style") or "standard_ecommerce"),
            "ecommerce_ad_style_label": str(data.get("ecommerce_ad_style_label") or ECOMMERCE_STYLE_STANDARD_BUTTON),
            "app_id": str(data.get("ecommerce_workflow_id") or ECOMMERCE_MODEL_WORKFLOW_IDS[ECOMMERCE_SEEDANCE_FAST_BUTTON]),
            "ecommerce_short_video_app_id": str(data.get("ecommerce_workflow_id") or ECOMMERCE_MODEL_WORKFLOW_IDS[ECOMMERCE_SEEDANCE_FAST_BUTTON]),
            "ecommerce_short_video_workflow_ids": [str(data.get("ecommerce_workflow_id") or ECOMMERCE_MODEL_WORKFLOW_IDS[ECOMMERCE_SEEDANCE_FAST_BUTTON])],
            "video_structure": video_structure,
            "ratio": str(data.get("ratio") or "16:9"),
            "ratio_label": str(data.get("ratio_label") or data.get("ratio") or "16:9"),
            "resolution": str(data.get("resolution") or "720p"),
            "user_prompt": str(data.get("user_prompt") or ""),
            "duration_seconds": duration,
            "duration": duration,
            "target_language": str(data.get("target_language") or "Chinese"),
            "target_language_label": str(data.get("target_language_label") or "中文"),
            "language": str(data.get("target_language") or "Chinese"),
            "prompt": "",
            "copy_text": "",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": _build_ecommerce_tg_user_instruction(
                data,
                duration=duration,
                structure_label=structure_label,
            ),
        }

    def _ecommerce_animation_redraw_needed(params: dict[str, Any]) -> bool:
        style = str(params.get("ecommerce_ad_style") or "").strip().lower()
        if style != "animation":
            return False
        if params.get("ecommerce_animation_redraw_done") or params.get("ecommerce_animation_redraw_skipped"):
            return False
        material = params.get("ecommerce_material_analysis") if isinstance(params.get("ecommerce_material_analysis"), dict) else {}
        assessments = material.get("image_assessments") if isinstance(material.get("image_assessments"), list) else []
        style_text = " ".join(
            str(item.get("role") or "") + " " + str(item.get("usefulness") or "") + " " + str(item.get("reason") or "")
            for item in assessments
            if isinstance(item, dict)
        ).lower()
        already_animated = any(word in style_text for word in ("动画", "動漫", "卡通", "插画", "插畫", "3d", "cg"))
        return not already_animated

    def _format_ecommerce_prompt_preview_text(generated: dict[str, Any]) -> str:
        prompt = str(generated.get("prompt") or "").strip()
        prompt_segments = generated.get("prompt_segments") if isinstance(generated.get("prompt_segments"), list) else []
        prompt_lines: list[str] = []
        if prompt:
            prompt_lines.append(html.escape(prompt))
        elif prompt_segments:
            for item in prompt_segments:
                if not isinstance(item, dict):
                    continue
                index = str(item.get("index") or "").strip()
                total = str(item.get("total") or "").strip()
                duration = str(item.get("duration") or "").strip()
                segment_prompt = str(item.get("prompt") or "").strip()
                if not segment_prompt:
                    continue
                title = f"片段 {index}/{total}" if index and total else "片段"
                if duration:
                    title = f"{title}（{duration}秒）"
                prompt_lines.extend([f"【{title}】", html.escape(segment_prompt), ""])
        else:
            prompt_lines.append("未生成提示词")
        lines = [
            "✨ AI 已生成广告短视频提示词",
            "",
            "🌟 提示词（含可选台词）",
            "\n".join(prompt_lines).strip(),
        ]
        return "\n".join(lines)

    async def _ask_ecommerce_subtitle_choice(message: Message, state: FSMContext, *, prefix_text: str = "") -> None:
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_subtitle_choice)
        lines = []
        if prefix_text.strip():
            lines.extend([prefix_text.strip(), ""])
        lines.extend(
            [
                "字幕设置",
                "请选择生成视频后是否自动添加字幕。",
                "选择后会进入最终确认；点击「确认生成」才会提交视频任务。",
            ]
        )
        await message.answer("\n".join(lines), reply_markup=_ecommerce_subtitle_keyboard())

    async def _start_ecommerce_prompt_guided_revision(
        message: Message,
        state: FSMContext,
        *,
        return_state: str,
    ) -> None:
        await state.update_data(
            ecommerce_guided_revision_return_state=str(return_state or "subtitle")
        )
        await state.set_state(
            ProductionWorkflowForm.ecommerce_waiting_for_prompt_guided_revision
        )
        await message.answer(
            "請輸入你希望如何修改广告短视频提示词，例如：开场更抓人、突出材质和使用场景、删除价格信息。",
            reply_markup=_ecommerce_step_keyboard(),
        )
    async def _consume_ecommerce_product_album_buffer(key: str, *, delay_seconds: float = 0.0) -> bool:
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        buffer = ecommerce_product_album_buffers.pop(key, None)
        if not buffer:
            return False
        paths = [str(item.get("path") or "") for item in sorted(buffer.get("items") or [], key=lambda item: int(item.get("message_id") or 0)) if str(item.get("path") or "").strip()]
        if not paths:
            return False
        state: FSMContext = buffer["state"]
        message: Message = buffer["message"]
        phase = str(buffer.get("phase") or "info").strip()
        data = await state.get_data()
        if phase == "three_view":
            existing_three_view_paths = [
                str(item or "").strip()
                for item in (data.get("ecommerce_product_three_view_image_local_paths") or [])
                if str(item or "").strip()
            ]
            merged_three_view_paths = [*existing_three_view_paths, *[item for item in paths if item not in existing_three_view_paths]]
            await state.update_data(
                ecommerce_product_three_view_image_local_paths=merged_three_view_paths,
                product_image_local_path=merged_three_view_paths[0],
                product_image_local_paths=merged_three_view_paths,
            )
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_product_info_image)
            count_text = f"{len(merged_three_view_paths)} 張產品三視圖" if len(merged_three_view_paths) > 1 else "產品三視圖"
            await message.answer(
                f"{count_text}已收到。步驟 5/13：請上傳產品介紹相關圖片，例如包裝圖、賣點圖、細節圖、安裝/使用場景圖或參數資料圖。上傳完後點「完成上传，下一步」。",
                reply_markup=_ecommerce_product_upload_keyboard(),
            )
            return True
        if phase == "image_generate_product":
            existing_paths = [
                str(item or "").strip()
                for item in (data.get("product_image_local_paths") or [])
                if str(item or "").strip()
            ]
            merged_paths = [*existing_paths, *[item for item in paths if item not in existing_paths]]
            await state.update_data(
                product_image_local_path=merged_paths[0],
                product_image_local_paths=merged_paths,
            )
            await message.answer(
                f"已收到 {len(merged_paths)} 張產品圖。可繼續上傳，或點「完成上传，下一步」。",
                reply_markup=_ecommerce_product_upload_keyboard(),
            )
            return True
        three_view_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_three_view_image_local_paths") or [])
            if str(item or "").strip()
        ]
        existing_info_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_info_image_local_paths") or [])
            if str(item or "").strip()
        ]
        merged_info_paths = [*existing_info_paths, *[item for item in paths if item not in existing_info_paths]]
        merged_paths = [*three_view_paths, *[item for item in merged_info_paths if item not in three_view_paths]]
        await state.update_data(
            ecommerce_product_info_image_local_paths=merged_info_paths,
            product_image_local_path=merged_paths[0],
            product_image_local_paths=merged_paths,
        )
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_model_image)
        await message.answer(
            f"已收到 {len(merged_info_paths)} 張產品介紹相關圖片。後續會優先使用產品三視圖，再從介紹圖中提取賣點信息。步驟 6/13：請上傳講解人/模特或背景圖；如果不需要模特/背景參考，請輸入「跳過」。",
            reply_markup=_menu_keyboard(),
        )
        return True

    async def _finalize_ecommerce_product_album(key: str) -> None:
        await _consume_ecommerce_product_album_buffer(key, delay_seconds=1.5)

    async def _flush_pending_ecommerce_product_album(message: Message, *, phase: str) -> bool:
        prefix = f"{int(message.chat.id)}:"
        pending_keys = [
            key
            for key, buffer in ecommerce_product_album_buffers.items()
            if key.startswith(prefix) and str(buffer.get("phase") or "").strip() == phase
        ]
        if not pending_keys:
            return False
        for key in pending_keys:
            buffer = ecommerce_product_album_buffers.get(key) or {}
            task = buffer.get("task")
            if isinstance(task, asyncio.Task) and not task.done():
                await task
            else:
                await _consume_ecommerce_product_album_buffer(key)
        return True

    async def _finalize_digital_human_product_album(key: str) -> None:
        await asyncio.sleep(1.5)
        buffer = digital_human_product_album_buffers.pop(key, None)
        if not buffer:
            return
        paths = [
            str(item.get("path") or "")
            for item in sorted(buffer.get("items") or [], key=lambda item: int(item.get("message_id") or 0))
            if str(item.get("path") or "").strip()
        ]
        if not paths:
            return
        state: FSMContext = buffer["state"]
        message: Message = buffer["message"]
        data = await state.get_data()
        existing_paths = [
            str(item or "").strip()
            for item in (data.get("product_image_local_paths") or [])
            if str(item or "").strip()
        ]
        merged_paths = [*existing_paths, *[item for item in paths if item not in existing_paths]]
        if len(merged_paths) > 4:
            await state.update_data(product_image_local_path="", product_image_local_paths=[])
            await message.answer(
                "一次最多只能上傳 4 張產品圖。已清空本次產品圖，請重新上傳不超過 4 張。",
                reply_markup=_digital_human_product_upload_keyboard(),
            )
            return
        selected_paths = merged_paths[:4]
        await state.update_data(
            product_image_local_path=selected_paths[0],
            product_image_local_paths=selected_paths,
        )
        suffix = "，已達上限" if len(selected_paths) >= 4 else ""
        await message.answer(
            f"已收到 {len(selected_paths)} 張產品圖{suffix}。可繼續上傳，或點「完成上传，下一步」。",
            reply_markup=_digital_human_product_upload_keyboard(),
        )

    async def _flush_pending_digital_human_product_album(message: Message) -> bool:
        prefix = f"{int(message.chat.id)}:"
        pending_keys = [key for key in digital_human_product_album_buffers if key.startswith(prefix)]
        if not pending_keys:
            return False
        for key in pending_keys:
            buffer = digital_human_product_album_buffers.get(key) or {}
            task = buffer.get("task")
            if isinstance(task, asyncio.Task) and not task.done():
                await task
            else:
                await _finalize_digital_human_product_album(key)
        return True

    async def _finalize_digital_human_scene_album(key: str) -> None:
        await asyncio.sleep(1.5)
        buffer = digital_human_scene_album_buffers.pop(key, None)
        if not buffer:
            return
        paths = [
            str(item.get("path") or "")
            for item in sorted(buffer.get("items") or [], key=lambda item: int(item.get("message_id") or 0))
            if str(item.get("path") or "").strip()
        ]
        if not paths:
            return
        state: FSMContext = buffer["state"]
        message: Message = buffer["message"]
        data = await state.get_data()
        existing_paths = [
            str(item or "").strip()
            for item in (data.get("digital_human_scene_image_local_paths") or [])
            if str(item or "").strip()
        ]
        merged_paths = [*existing_paths, *[item for item in paths if item not in existing_paths]]
        if len(merged_paths) > 3:
            await state.update_data(digital_human_scene_image_local_paths=[])
            await message.answer(
                "一次最多只能上傳 3 張場景圖。已清空本次場景圖，請重新上傳不超過 3 張，或點「跳过」。",
                reply_markup=_digital_human_scene_upload_keyboard(),
            )
            return
        await state.update_data(digital_human_scene_image_local_paths=merged_paths)
        if len(merged_paths) >= 3:
            await message.answer(
                "已收到 3 張場景圖。已達上限，請點「完成上传，下一步」繼續。",
                reply_markup=_digital_human_scene_upload_keyboard(),
            )
            return
        await message.answer(
            f"已收到 {len(merged_paths)} 張場景圖。可繼續上傳，或點「完成上传，下一步」。",
            reply_markup=_digital_human_scene_upload_keyboard(),
        )

    async def _show_ecommerce_generated_preview(
        message: Message,
        state: FSMContext,
        generated: dict[str, Any],
    ) -> None:
        generated = dict(generated or {})
        await state.update_data(ecommerce_generated_params=generated)
        preview_text = _format_ecommerce_prompt_preview_text(generated)
        if _ecommerce_animation_redraw_needed(generated):
            await state.set_state(
                ProductionWorkflowForm.ecommerce_waiting_for_animation_redraw_confirm
            )
            await message.answer(
                "\n".join(
                    [
                        preview_text,
                        "",
                        "🌟 动画广告素材检查",
                        "当前上传图片更像普通实拍/参考素材，和动画广告提示词的视觉风格不完全一致。",
                        "如需统一动画广告质感，请先点击「确认转绘」；转绘会调用图片模型生成新的动画风格参考图。",
                        "如果要直接使用原图，也可以点击「不转绘继续」。",
                    ]
                ),
                reply_markup=_ecommerce_animation_redraw_keyboard(),
            )
            return
        await _ask_ecommerce_subtitle_choice(message, state, prefix_text=preview_text)
    async def generate_and_show_ecommerce_preview(message: Message, state: FSMContext, *, regenerate: bool = False) -> None:
        data = await state.get_data()
        params = _build_ecommerce_preview_params(data)
        if regenerate:
            params["tg_user_instruction"] = f"{params['tg_user_instruction']} 请换一个表达方式重新生成。"
        await message.answer("正在根据图片内容生成带台词的提示词，请稍等。", reply_markup=_menu_keyboard())
        preview = await _preview_internal_ecommerce_prompt(chat_id=int(message.chat.id), params=params)
        generated = dict(preview.get("params") or {})
        await _show_ecommerce_generated_preview(message, state, generated)

    async def start_image_generate_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_image")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.image_waiting_for_product_image)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 電商廣告圖生產",
                    "步驟 1/4：上傳商品圖",
                    "",
                    "可上傳 1 張或多張商品、空間或服務場景圖。AI 會自行判斷選用一張或多張有效圖片，並提取圖中可見信息生成海報。",
                    "上傳完後點「完成上传，下一步」。",
                ]
            ),
            reply_markup=_ecommerce_product_upload_keyboard(),
        )

    async def start_image_generation_menu(message: Message, state: FSMContext) -> None:
        await state.clear()
        await message.answer(
            "圖片生成：請選擇要建立的任務。",
            reply_markup=_image_generation_keyboard(),
        )

    async def start_three_view_image_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_three_view")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.image_three_view_waiting_for_image)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 三視圖生成",
                    "請上傳 1 張產品圖或模特圖。",
                    "",
                    "系統會使用閉源圖片模型生成 4:3 比例的正面、側面、背面三視圖。",
                ]
            ),
            reply_markup=_image_generation_keyboard(),
        )

    async def start_digital_human_character_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_digital_human_character")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.digital_human_character_waiting_for_region)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 生成数字人",
                    "步驟 1/2：請選擇人設地區特徵。",
                    "",
                    "可選：中国、欧美、印尼、泰国、日本、马来西亚。",
                ]
            ),
            reply_markup=_digital_human_character_region_keyboard(),
        )

    async def start_subject_replace_image_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_subject_replace")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.subject_replace_waiting_for_source_image)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 主体替换",
                    "步驟 1/2：請上傳需要被替換的原圖。",
                    "",
                    "下一步再上傳用來替換的圖片，可以是商品，也可以是模特/人物。",
                ]
            ),
            reply_markup=_image_generation_keyboard(),
        )

    async def start_poster_translate_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_poster_translate")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.poster_translate_waiting_for_image)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 电商图语种切换",
                    "步骤 1/2：请上传原始电商海报图。",
                    "",
                    "系统会保留海报主体和版式，并把图中的文字改成目标市场语言。",
                ]
            ),
            reply_markup=_image_generation_keyboard(),
        )

    async def start_ecommerce_short_video_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_ecommerce_short_video")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_model_version)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "\n".join(
                [
                    "🌟 廣告短視頻工作流",
                    "步驟 1/13：選擇視頻模型",
                    "",
                    "請先選擇本次要使用的模型：",
                    f"{ECOMMERCE_SEEDANCE_FAST_BUTTON}：速度更快，走工作流 {ECOMMERCE_MODEL_WORKFLOW_IDS[ECOMMERCE_SEEDANCE_FAST_BUTTON]}",
                    f"{ECOMMERCE_SEEDANCE_STANDARD_BUTTON}：標準版本，走工作流 {ECOMMERCE_MODEL_WORKFLOW_IDS[ECOMMERCE_SEEDANCE_STANDARD_BUTTON]}",
                ]
            ),
            reply_markup=_ecommerce_model_keyboard(),
        )

    async def start_replace_model_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_replace_model")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.replace_model_waiting_for_video)
        await state.update_data(work_dir=str(work_dir))
        await message.answer(
            "🌟 視頻模特替換\n"
            "步驟 1/3：請上傳原視頻。\n\n"
            "✨ 建議使用無水印原視頻，源視頻已有水印通常會被保留。",
            reply_markup=_menu_keyboard(),
        )

    async def start_replace_product_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_replace_product")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.replace_product_waiting_for_video)
        await state.update_data(work_dir=str(work_dir))
        await message.answer("🌟 視頻商品替換\n步驟 1/4：請上傳原視頻。", reply_markup=_menu_keyboard())

    async def start_union_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_union")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.union_waiting_for_video)
        await state.update_data(work_dir=str(work_dir))
        await message.answer("🌟 聯合替換工作流\n步驟 1/5：請上傳原視頻。", reply_markup=_menu_keyboard())

    @router.message(CommandStart())
    async def cmd_start(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer(_quick_start_text(service), reply_markup=_menu_keyboard())

    @router.message(F.text == "多智能體數字人")
    async def on_keyword_entry(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await message.answer(_quick_start_text(service), reply_markup=_menu_keyboard())

    @router.message(Command("status"))
    async def cmd_status(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer(_webapp_status_text(service, chat_id=int(message.chat.id)), reply_markup=_menu_keyboard())

    @router.message(Command("workflow"))
    async def cmd_workflow(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer(_workflow_config_text(service), reply_markup=_menu_keyboard())

    @router.message(Command("stop"))
    async def cmd_stop(message: Message, state: FSMContext) -> None:
        if await handle_stop_request(message, state):
            return

    @router.message(Command("workbench"))
    async def cmd_workbench(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer(
            f"工作台網址: {service.resolve_config().public_base_url}",
            reply_markup=_menu_keyboard(),
        )

    @router.message(Command("setscript"))
    async def cmd_setscript(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await state.set_state(ScriptForm.waiting_for_script)
        await message.answer("請直接貼上你想作為預設的文案內容。", reply_markup=_menu_keyboard())

    @router.message(Command("cancel"))
    async def cmd_cancel(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await message.answer("本次素材上傳流程已取消。", reply_markup=_menu_keyboard())

    @router.message(Command("custom"))
    async def cmd_custom(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_upload_flow(message, state)

    @router.message(Command("run"))
    async def cmd_run(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await message.answer(f"預設素材功能已移除。請使用「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立數字人視頻。", reply_markup=_menu_keyboard())

    @router.message(Command("rerun"))
    async def cmd_rerun(message: Message) -> None:
        await rerun_latest_webapp_or_local_task(message)

    @router.message(ScriptForm.waiting_for_script)
    async def on_default_script_input(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        script = _message_text(message)
        if not script:
            await message.answer("文案不能為空，請重新輸入。", reply_markup=_menu_keyboard())
            return
        if _looks_like_bot_operational_text(script):
            await message.answer("這段內容像系統提示，不適合作為口播文稿。請重新輸入真正要數字人朗讀的文稿。", reply_markup=_menu_keyboard())
            return
        chat_script_drafts[int(message.chat.id)] = script
        await state.clear()
        await message.answer("你的預設文案已更新。", reply_markup=_menu_keyboard())

    @router.message(UploadFlowForm.waiting_for_video_structure)
    async def on_upload_video_structure(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        mode = DIGITAL_HUMAN_STRUCTURE_TEXTS.get(text)
        if not mode:
            await message.answer(
                f"選擇無效。請直接點擊「{DIGITAL_HUMAN_SINGLE_VIDEO_BUTTON}」或「{DIGITAL_HUMAN_STORYBOARD_VIDEO_BUTTON}」。",
                reply_markup=_digital_human_structure_keyboard(),
            )
            return
        await state.update_data(digital_human_short_mode=mode)
        await state.set_state(UploadFlowForm.waiting_for_product_image)
        await message.answer(
            "已選擇單段口播視頻。步驟 2/8：請上傳 1-4 張產品圖；上傳完後點「完成上传，下一步」。"
            if mode == "single"
            else "已選擇多分鏡口播視頻。步驟 2/8：請上傳 1-4 張產品圖；系統會自動識別主圖和副圖。上傳完後點「完成上传，下一步」。",
            reply_markup=_digital_human_product_upload_keyboard(),
        )

    @router.message(UploadFlowForm.waiting_for_product_image)
    async def on_upload_product_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text in ECOMMERCE_PRODUCT_DONE_TEXTS:
            await _flush_pending_digital_human_product_album(message)
            data = await state.get_data()
            product_paths = [
                str(item or "").strip()
                for item in (data.get("product_image_local_paths") or [])
                if str(item or "").strip()
            ]
            product_main = str(data.get("product_image_local_path") or (product_paths[0] if product_paths else "")).strip()
            if product_main and product_main not in product_paths:
                product_paths.insert(0, product_main)
            product_paths = product_paths[:4]
            if not product_paths:
                await message.answer("請先上傳至少 1 張產品圖，再點「完成上传，下一步」。", reply_markup=_digital_human_product_upload_keyboard())
                return
            await state.update_data(product_image_local_path=product_paths[0], product_image_local_paths=product_paths)
            await state.set_state(UploadFlowForm.waiting_for_portrait_image)
            suffix = "後續會自動識別主圖和副圖。" if len(product_paths) > 1 else ""
            await message.answer(
                f"已完成產品圖上傳，共 {len(product_paths)} 張。{suffix}步驟 3/8：請上傳模特圖 / 數字人形象圖。",
                reply_markup=_digital_human_nav_keyboard(),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳產品圖片，或把圖片當成 document 傳送；上傳完後點「完成上传，下一步」。", reply_markup=_digital_human_product_upload_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        media_group_id = str(getattr(message, "media_group_id", "") or "").strip()
        if media_group_id:
            key = f"{int(message.chat.id)}:{media_group_id}"
            image_path = work_dir / f"product_image_{int(message.message_id)}{suffix}"
            await _download_message_media(message, image_path)
            buffer = digital_human_product_album_buffers.setdefault(
                key,
                {"items": [], "state": state, "message": message, "task": None},
            )
            buffer["items"].append({"message_id": int(message.message_id), "path": str(image_path)})
            buffer["state"] = state
            buffer["message"] = message
            if buffer.get("task") is None:
                buffer["task"] = asyncio.create_task(_finalize_digital_human_product_album(key))
            return
        existing_paths = [
            str(item or "").strip()
            for item in (data.get("product_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if len(existing_paths) >= 4:
            await message.answer("最多只能上傳 4 張產品圖。請點「完成上传，下一步」繼續，或返回上一步重新上傳。", reply_markup=_digital_human_product_upload_keyboard())
            return
        image_path = work_dir / f"product_image_{len(existing_paths) + 1}{suffix}"
        await _download_message_media(message, image_path)
        product_paths = [*existing_paths, str(image_path)]
        await state.update_data(product_image_local_path=product_paths[0], product_image_local_paths=product_paths)
        suffix_text = "已達上限，請點「完成上传，下一步」繼續。" if len(product_paths) >= 4 else "可繼續上傳，或點「完成上传，下一步」。"
        await message.answer(
            f"第 {len(product_paths)} 張產品圖已收到。{suffix_text}",
            reply_markup=_digital_human_product_upload_keyboard(),
        )

    @router.message(UploadFlowForm.waiting_for_portrait_image)
    async def on_upload_portrait_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳模特圖 / 數字人形象圖，或把圖片當成 document 傳送。", reply_markup=_digital_human_nav_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"portrait_image{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(portrait_image_local_path=str(image_path))
        await state.set_state(UploadFlowForm.waiting_for_scene_images)
        await message.answer(
            "\n".join(
                [
                    "模特圖已收到。步驟 4/8：可上傳場景圖，最多 3 張。",
                    "場景圖只作為環境/背景參考；不需要可點「跳过」。",
                    "上傳完後點「完成上传，下一步」。",
                ]
            ),
            reply_markup=_digital_human_scene_upload_keyboard(),
        )

    @router.message(UploadFlowForm.waiting_for_scene_images)
    async def on_upload_scene_images(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        data = await state.get_data()
        scene_paths = [str(item or "").strip() for item in (data.get("digital_human_scene_image_local_paths") or []) if str(item or "").strip()]
        if text in AUTO_DURATION_TEXTS or text in ECOMMERCE_PRODUCT_DONE_TEXTS:
            await state.update_data(digital_human_scene_image_local_paths=scene_paths[:3])
            await state.set_state(UploadFlowForm.waiting_for_target_language)
            if scene_paths:
                await message.answer(
                    f"已收到 {len(scene_paths[:3])} 張場景圖。步驟 5/8：請選擇目標地區語言。",
                    reply_markup=_target_language_keyboard(),
                )
            else:
                await message.answer(
                    "已跳過場景圖。步驟 5/8：請選擇目標地區語言。",
                    reply_markup=_target_language_keyboard(),
                )
            return
        if len(scene_paths) >= 3:
            await message.answer("最多只能上傳 3 張場景圖。請點「完成上传，下一步」繼續。", reply_markup=_digital_human_scene_upload_keyboard())
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳場景圖片，或點「跳过」/「完成上传，下一步」。", reply_markup=_digital_human_scene_upload_keyboard())
            return
        work_dir = Path(str(data["work_dir"]))
        media_group_id = str(getattr(message, "media_group_id", "") or "").strip()
        if media_group_id:
            key = f"{int(message.chat.id)}:{media_group_id}"
            image_path = work_dir / f"scene_image_{int(message.message_id)}{suffix}"
            await _download_message_media(message, image_path)
            buffer = digital_human_scene_album_buffers.setdefault(
                key,
                {"items": [], "state": state, "message": message, "task": None},
            )
            buffer["items"].append({"message_id": int(message.message_id), "path": str(image_path)})
            buffer["state"] = state
            buffer["message"] = message
            if buffer.get("task") is None:
                buffer["task"] = asyncio.create_task(_finalize_digital_human_scene_album(key))
            return
        image_path = work_dir / f"scene_image_{len(scene_paths) + 1}{suffix}"
        await _download_message_media(message, image_path)
        scene_paths.append(str(image_path))
        if len(scene_paths) > 3:
            await state.update_data(digital_human_scene_image_local_paths=[])
            await message.answer(
                "一次最多只能上傳 3 張場景圖。已清空本次場景圖，請重新上傳不超過 3 張，或點「跳过」。",
                reply_markup=_digital_human_scene_upload_keyboard(),
            )
            return
        await state.update_data(digital_human_scene_image_local_paths=scene_paths[:3])
        if len(scene_paths) >= 3:
            await message.answer("第 3 張場景圖已收到。已達上限，請點「完成上传，下一步」繼續。", reply_markup=_digital_human_scene_upload_keyboard())
        else:
            await message.answer(
                f"第 {len(scene_paths)} 張場景圖已收到。可繼續上傳，或點「完成上传，下一步」。",
                reply_markup=_digital_human_scene_upload_keyboard(),
            )

    @router.message(UploadFlowForm.waiting_for_target_language)
    async def on_upload_target_language(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        language = TARGET_LANGUAGE_BUTTONS.get(text)
        if not language:
            await message.answer("請直接點擊目標語言按鈕：马来西亚、日语、西班牙语、泰语、中文、英文。", reply_markup=_target_language_keyboard())
            return
        language_code, language_label = language
        await state.update_data(target_language=language_code, target_language_label=language_label, language=language_code)
        await state.set_state(UploadFlowForm.waiting_for_script_mode)
        await message.answer(
            f"已選擇目標語言：{language_label}。步驟 6/8：請選擇口播文稿來源。",
            reply_markup=_digital_human_script_mode_keyboard(),
        )

    @router.message(UploadFlowForm.waiting_for_script_mode)
    async def on_upload_script_mode(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text == DIGITAL_HUMAN_AI_SCRIPT_BUTTON:
            await state.update_data(use_ai_script=True)
            await state.set_state(UploadFlowForm.waiting_for_ratio)
            await message.answer(
                "已選擇 AI 根據圖片生成口播文稿。步驟 7/8：請選擇圖像比例，圖像按 2K 質感生成。",
                reply_markup=_ecommerce_ratio_keyboard(),
            )
            return
        if text != DIGITAL_HUMAN_MANUAL_SCRIPT_BUTTON:
            await message.answer("請直接點擊文稿來源按鈕。", reply_markup=_digital_human_script_mode_keyboard())
            return
        await state.update_data(use_ai_script=False)
        await state.set_state(UploadFlowForm.waiting_for_script)
        await message.answer("請貼上這次的口播文稿。", reply_markup=_digital_human_nav_keyboard())

    @router.message(UploadFlowForm.waiting_for_script)
    async def on_upload_script(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        script = _message_text(message)
        if not script:
            await message.answer("文案不能為空，請重新輸入。", reply_markup=_digital_human_nav_keyboard())
            return
        await state.update_data(script_text=script)
        await state.set_state(UploadFlowForm.waiting_for_ratio)
        await message.answer(
            "口播文稿已收到。步驟 7/8：請選擇圖像比例，圖像按 2K 質感生成。",
            reply_markup=_ecommerce_ratio_keyboard(),
        )

    @router.message(UploadFlowForm.waiting_for_ratio)
    async def on_upload_ratio(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        ratio_text = _message_text(message)
        ratio_value = ECOMMERCE_RATIO_BUTTONS.get(ratio_text)
        if ratio_value is None:
            await message.answer(
                "比例選擇無效。請直接點擊下方比例按鈕：16:9、4:3、1:1、3:4、9:16。",
                reply_markup=_ecommerce_ratio_keyboard(),
            )
            return
        await state.update_data(ratio=ratio_value, image_size=ratio_value, image_resolution="2k")
        await state.set_state(UploadFlowForm.waiting_for_audio)
        data = await state.get_data()
        target_language = _target_language_code_from_data(data)
        await _send_preset_dry_voice_previews(message, config, target_language=target_language)
        await message.answer(
            f"已選擇 {ratio_value}，圖像按 2K 質感生成。步驟 8/8：請上傳需要克隆的參考音頻，或選擇預設音色。",
            reply_markup=_preset_dry_voice_keyboard(target_language=target_language),
        )

    @router.message(UploadFlowForm.waiting_for_audio)
    async def on_upload_audio(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        data = await state.get_data()
        target_language = _target_language_code_from_data(data)
        preset = _elevenlabs_voice_preset_by_button(text, target_language)
        work_dir = Path(str(data["work_dir"])).resolve()
        minimax_tts_voice_id = ""
        elevenlabs_tts_preset_key = ""
        elevenlabs_tts_voice_id = ""
        speaker = ""
        if preset:
            try:
                audio_path, preset_label = await asyncio.to_thread(
                    _copy_preset_dry_voice_to_work_dir,
                    config,
                    target_language=target_language,
                    preset=preset,
                    work_dir=work_dir,
                    prefix="preset_voice",
                )
            except Exception as exc:
                logger.exception("Failed to prepare preset dry voice.")
                await message.answer(f"预设音色下载失败：{exc}。请稍后重试，或直接上传自己的干音。", reply_markup=_preset_dry_voice_keyboard(target_language=target_language))
                return
            elevenlabs_tts_preset_key = str(preset.get("key") or "").strip()
            elevenlabs_tts_voice_id = str(preset.get("voice_id") or "").strip()
            speaker = str(preset.get("voice_name") or "").strip()
        else:
            suffix = _audio_ext_from_message(message)
            if suffix is None:
                await message.answer("請上傳需要克隆的參考音頻，或點選預設音色。支持 mp3、wav、m4a、aac、flac、ogg。", reply_markup=_preset_dry_voice_keyboard(target_language=target_language))
                return
            audio_path = work_dir / f"cloned_audio{suffix}"
            preset_label = ""
            try:
                await _download_message_media(message, audio_path)
            except Exception as exc:
                logger.exception("Failed to download Telegram audio.")
                await message.answer(f"音頻下載失敗：{exc}。請重新上傳 mp3、wav、m4a、aac、flac 或 ogg。", reply_markup=_preset_dry_voice_keyboard(target_language=target_language))
                return
        portrait_image_local = str(data.get("portrait_image_local_path") or "").strip()
        product_image_local = str(data.get("product_image_local_path") or "").strip()
        product_image_paths = [
            str(item or "").strip()
            for item in (data.get("product_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if product_image_local and product_image_local not in product_image_paths:
            product_image_paths.insert(0, product_image_local)
        product_image_paths = product_image_paths[:4]
        scene_image_paths = [
            str(item or "").strip()
            for item in (data.get("digital_human_scene_image_local_paths") or [])
            if str(item or "").strip()
        ][:3]
        target_language = str(data.get("target_language") or "Chinese").strip() or "Chinese"
        target_language_label = str(data.get("target_language_label") or "中文").strip() or "中文"
        script = str(data.get("script_text") or "").strip()
        use_ai_script = bool(data.get("use_ai_script"))
        if not portrait_image_local or not product_image_local:
            await state.clear()
            await message.answer(f"素材不完整，請重新點擊「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立任務。", reply_markup=_menu_keyboard())
            return
        if not script and not use_ai_script:
            await state.clear()
            await message.answer("文稿缺失，請重新建立任務。", reply_markup=_menu_keyboard())
            return
        portrait_path = Path(portrait_image_local).resolve()
        product_path = Path(product_image_local).resolve()
        duration_seconds = _estimate_digital_human_duration_from_script(script) if script else 15
        params = {
            "digital_human_short_mode": str(data.get("digital_human_short_mode") or "single"),
            "digital_human_image_fusion": True,
            "speech_text": script,
            "message": script,
            "prompt_text": "",
            "style_hint": "數字人口播短視頻，先融合產品與人物畫面，再生成自然口播視頻",
            "duration_mode": "audio",
            "duration_seconds": duration_seconds,
            "audio_speed": 1.08,
            "audio_volume_gain_db": 6.0,
            "max_resolution": 1600,
            "use_ai_copy": use_ai_script,
            "use_ai_script": use_ai_script,
            "digital_human_script_source_ai": use_ai_script,
            "tg_use_llm_prompt": False,
            "ratio": str(data.get("ratio") or "9:16"),
            "ratio_label": str(data.get("ratio") or "9:16"),
            "image_size": str(data.get("image_size") or data.get("ratio") or "9:16"),
            "image_resolution": "2k",
            "target_language": target_language,
            "target_language_label": target_language_label,
            "language": target_language,
            "audio_local_path": str(audio_path) if audio_path is not None else "",
            "preset_dry_voice": preset_label,
            "minimax_tts_voice_id": minimax_tts_voice_id,
            "elevenlabs_tts_preset_key": elevenlabs_tts_preset_key,
            "elevenlabs_tts_voice_id": elevenlabs_tts_voice_id,
            "tts_provider": "",
            "speaker": speaker,
            "model_image_local_path": str(portrait_path),
            "product_image_local_path": str(product_path),
            "product_image_local_paths": product_image_paths or [str(product_path)],
            "digital_human_scene_image_local_paths": scene_image_paths,
        }
        await state.update_data(digital_human_pending_params=params)
        await state.set_state(UploadFlowForm.waiting_for_digital_human_confirm)
        await message.answer(
            f"已選擇官方音色：{preset_label}。請確認本次任務計劃：" if preset_label else "參考音頻已收到。請確認本次任務計劃：",
            reply_markup=_digital_human_confirm_keyboard(),
        )
        await message.answer(
            _digital_human_submit_plan_text(params),
            reply_markup=_digital_human_confirm_keyboard(),
        )

    @router.message(UploadFlowForm.waiting_for_digital_human_confirm)
    async def on_digital_human_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text != DIGITAL_HUMAN_CONFIRM_BUTTON:
            await message.answer(
                "請先確認是否提交本次數字人視頻任務。點擊「確認生成數字人視頻」後才會進入後台隊列。",
                reply_markup=_digital_human_confirm_keyboard(),
            )
            return
        data = await state.get_data()
        params = data.get("digital_human_pending_params")
        if not isinstance(params, dict) or not params:
            await state.clear()
            await message.answer(f"任務計劃已失效，請重新點擊「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立任務。", reply_markup=_menu_keyboard())
            return
        await show_digital_human_script_step(message, state)

    @router.message(UploadFlowForm.waiting_for_digital_human_script_confirm)
    async def on_digital_human_script_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text in DIGITAL_HUMAN_GUIDED_REVISION_TEXTS:
            await state.set_state(UploadFlowForm.waiting_for_digital_human_script_guided_revision)
            await message.answer(
                "請輸入你希望如何修改文稿，例如：更口語、突出材質與使用場景、控制在 30 秒內。",
                reply_markup=_digital_human_nav_keyboard(),
            )
            return
        if text == DIGITAL_HUMAN_REGENERATE_BUTTON:
            data = await state.get_data()
            params = data.get("digital_human_pending_params") if isinstance(data.get("digital_human_pending_params"), dict) else {}
            if bool((params or {}).get("digital_human_script_source_ai") or (params or {}).get("use_ai_script")):
                await show_digital_human_script_step(message, state, regenerate=True)
            else:
                await state.set_state(UploadFlowForm.waiting_for_digital_human_script_revision)
                await message.answer("請重新貼上口播文稿。", reply_markup=_digital_human_nav_keyboard())
            return
        if text != DIGITAL_HUMAN_NEXT_BUTTON:
            await message.answer("請點「確認下一步」或「重新生成」。", reply_markup=_digital_human_step_keyboard(include_guided_revision=True))
            return
        await show_digital_human_main_image_step(message, state)

    @router.message(UploadFlowForm.waiting_for_digital_human_script_revision)
    async def on_digital_human_script_revision(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        script = _message_text(message)
        if not script:
            await message.answer("文案不能為空，請重新輸入。", reply_markup=_digital_human_nav_keyboard())
            return
        data = await state.get_data()
        params = data.get("digital_human_pending_params") if isinstance(data.get("digital_human_pending_params"), dict) else {}
        params = dict(params or {})
        params.update({"speech_text": script, "message": script, "use_ai_script": False, "use_ai_copy": False})
        await state.update_data(digital_human_pending_params=params)
        await state.set_state(UploadFlowForm.waiting_for_digital_human_script_confirm)
        await message.answer(
            "\n".join(["🌟 步驟 1/5：口播文稿已更新", "", script, "", "確認後才會進入圖像融合。"]),
            reply_markup=_digital_human_step_keyboard(include_guided_revision=True),
        )

    @router.message(UploadFlowForm.waiting_for_digital_human_script_guided_revision)
    async def on_digital_human_script_guided_revision(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        instruction = _message_text(message)
        if not instruction:
            await message.answer(
                "修改要求不能為空，請重新輸入。",
                reply_markup=_digital_human_nav_keyboard(),
            )
            return
        data = await state.get_data()
        params = data.get("digital_human_pending_params") if isinstance(
            data.get("digital_human_pending_params"), dict
        ) else {}
        params = dict(params or {})
        current_script = str(
            params.get("speech_text") or params.get("message") or ""
        ).strip()
        if not current_script:
            await state.set_state(UploadFlowForm.waiting_for_digital_human_script_confirm)
            await message.answer(
                "目前沒有可修改的口播文稿，請先重新生成。",
                reply_markup=_digital_human_step_keyboard(include_guided_revision=True),
            )
            return
        request_params = dict(params)
        request_params["speech_text"] = current_script
        request_params["message"] = current_script
        request_params["revision_instruction"] = instruction
        await message.answer(
            "正在根據你的要求修改口播文稿，請稍候。",
            reply_markup=_digital_human_nav_keyboard(),
        )
        try:
            result = await _run_internal_digital_human_step(
                chat_id=int(message.chat.id),
                step="script_guided_revision",
                params=request_params,
            )
        except Exception as exc:
            await message.answer(
                f"引導修改失敗：{exc}\n請重新輸入修改要求，或點「返回上一步」。",
                reply_markup=_digital_human_nav_keyboard(),
            )
            return
        next_params = result.get("params")
        if not isinstance(next_params, dict):
            await message.answer(
                "引導修改返回格式不正確，請重新輸入修改要求。",
                reply_markup=_digital_human_nav_keyboard(),
            )
            return
        revised_script = str(
            result.get("speech_text") or next_params.get("speech_text") or ""
        ).strip()
        if not revised_script:
            await message.answer(
                "引導修改後文稿為空，請重新輸入修改要求。",
                reply_markup=_digital_human_nav_keyboard(),
            )
            return
        next_params = dict(next_params)
        next_params["speech_text"] = revised_script
        next_params["message"] = revised_script
        await state.update_data(digital_human_pending_params=next_params)
        await state.set_state(UploadFlowForm.waiting_for_digital_human_script_confirm)
        await message.answer(
            "\n".join(
                [
                    "🌟 步驟 1/5：口播文稿已按要求更新",
                    "",
                    revised_script,
                    "",
                    "確認後才會進入圖像融合；如需調整可點「引導修改提示詞」，或點「確認下一步」。",
                ]
            ),
            reply_markup=_digital_human_step_keyboard(include_guided_revision=True),
        )
    @router.message(UploadFlowForm.waiting_for_digital_human_main_image_confirm)
    async def on_digital_human_main_image_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text == DIGITAL_HUMAN_REGENERATE_BUTTON:
            data = await state.get_data()
            params = data.get("digital_human_pending_params") if isinstance(data.get("digital_human_pending_params"), dict) else {}
            if str((params or {}).get("digital_human_short_mode") or "").strip() == "storyboard" and str((params or {}).get("digital_human_main_image_local_path") or "").strip():
                await show_digital_human_view_images_step(message, state, regenerate=True)
            else:
                await show_digital_human_main_image_step(message, state, regenerate=True)
            return
        if text != DIGITAL_HUMAN_NEXT_BUTTON:
            await message.answer("請點「確認下一步」或「重新生成」。", reply_markup=_digital_human_step_keyboard())
            return
        await show_digital_human_view_images_step(message, state)

    @router.message(UploadFlowForm.waiting_for_digital_human_view_images_confirm)
    async def on_digital_human_view_images_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text == DIGITAL_HUMAN_REGENERATE_BUTTON:
            await show_digital_human_view_images_step(message, state, regenerate=True)
            return
        if text != DIGITAL_HUMAN_NEXT_BUTTON:
            await message.answer("請點「確認下一步」或「重新生成」。", reply_markup=_digital_human_step_keyboard())
            return
        await show_digital_human_final_step(message, state)

    @router.callback_query(UploadFlowForm.waiting_for_digital_human_view_images_confirm, F.data.startswith("dh_view_regen:"))
    async def on_digital_human_single_view_regenerate(callback: CallbackQuery, state: FSMContext) -> None:
        data_text = str(callback.data or "")
        match = re.fullmatch(r"dh_view_regen:(\d+)", data_text)
        if not match:
            await callback.answer("無效的視角圖編號。", show_alert=True)
            return
        view_index = max(int(match.group(1)), 1)
        message = callback.message
        if message is None:
            await callback.answer("無法回覆目前訊息。", show_alert=True)
            return
        await callback.answer(f"正在重新生成視角圖 {view_index}...")
        state_data = await state.get_data()
        params = state_data.get("digital_human_pending_params")
        if not isinstance(params, dict) or not params:
            await state.clear()
            await message.answer(f"任務計劃已失效，請重新點擊「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立任務。", reply_markup=_menu_keyboard())
            return
        updated_params = dict(params)
        updated_params["digital_human_regenerate_view_index"] = view_index
        await message.answer(f"正在重新生成視角圖 {view_index}，其他視角圖會保留。", reply_markup=_digital_human_step_keyboard())
        chat_id = int(callback.message.chat.id)
        digital_human_internal_steps[chat_id] = {
            "workflow": DIGITAL_HUMAN_VIDEO_BUTTON,
            "step": "fusion_view",
            "stage": f"正在重新生成視角圖 {view_index}",
            "started_at": int(time.time()),
        }
        try:
            result = await _run_internal_digital_human_step(chat_id=chat_id, step="fusion_view", params=updated_params)
        except Exception as exc:
            await message.answer(f"視角圖 {view_index} 重新生成失敗：{exc}", reply_markup=_digital_human_step_keyboard())
            return
        finally:
            current = digital_human_internal_steps.get(chat_id)
            if isinstance(current, dict) and str(current.get("step") or "") == "fusion_view":
                digital_human_internal_steps.pop(chat_id, None)
        next_params = result.get("params")
        if isinstance(next_params, dict):
            next_params.pop("digital_human_regenerate_view_index", None)
            await state.update_data(digital_human_pending_params=next_params)
        image_path = str(result.get("image_path") or "").strip()
        if image_path and Path(image_path).exists():
            await message.answer_photo(
                FSInputFile(image_path),
                caption=f"視角圖 {view_index} 已重新生成。",
                reply_markup=_digital_human_single_view_regenerate_keyboard(view_index),
            )
        else:
            await message.answer(f"視角圖 {view_index} 已重新生成，但本地文件不可讀。", reply_markup=_digital_human_step_keyboard())

    @router.message(UploadFlowForm.waiting_for_digital_human_final_confirm)
    async def on_digital_human_final_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_digital_human_back_request(message, state):
            return
        text = _message_text(message)
        if text == DIGITAL_HUMAN_REGENERATE_BUTTON:
            await show_digital_human_main_image_step(message, state, regenerate=True)
            return
        if text != DIGITAL_HUMAN_FINAL_SUBMIT_BUTTON:
            await message.answer("請點「確認提交視頻生成」或「重新生成」。", reply_markup=_digital_human_step_keyboard(final=True))
            return
        data = await state.get_data()
        params = data.get("digital_human_pending_params")
        if not isinstance(params, dict) or not params:
            await state.clear()
            await message.answer(f"任務計劃已失效，請重新點擊「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立任務。", reply_markup=_menu_keyboard())
            return
        params = dict(params)
        if not isinstance(params.get("digital_human_fusion_image_paths"), list):
            main_path = str(params.get("digital_human_main_image_local_path") or "").strip()
            if main_path:
                params["digital_human_fusion_image_paths"] = [main_path]
        params["use_ai_script"] = False
        params["use_ai_copy"] = False
        await state.clear()
        await message.answer("已確認，正在提交最終視頻生成任務。", reply_markup=_menu_keyboard())
        try:
            await submit_webapp_task_and_reply(message, "create_video", params)
        except Exception as exc:
            reason = str(exc).strip() or exc.__class__.__name__
            await message.answer(f"口播任務提交失敗：{reason}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_model_version)
    async def on_ecommerce_model_version(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        workflow_id = ECOMMERCE_MODEL_WORKFLOW_IDS.get(text)
        if not workflow_id:
            await message.answer(
                "選擇無效。請直接點擊下方模型按鈕：seedance2.0fast 或 seedance2.0。",
                reply_markup=_ecommerce_model_keyboard(),
            )
            return
        await state.update_data(
            ecommerce_model=text,
            ecommerce_workflow_id=workflow_id,
            ecommerce_short_video_workflow_ids=[workflow_id],
            ecommerce_short_video_app_id=workflow_id,
            app_id=workflow_id,
        )
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_ad_style)
        await message.answer(
            "\n".join(
                [
                    f"已選擇：{text}。",
                    "步驟 2/13：請選擇廣告視頻的風格傾向。",
                    "不同風格會影響提示詞的鏡頭語言、節奏、旁白和畫面表現。",
                ]
            ),
            reply_markup=_ecommerce_ad_style_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_ad_style)
    async def on_ecommerce_ad_style(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        style = ECOMMERCE_AD_STYLE_BUTTONS.get(text)
        if not style:
            await message.answer(
                "選擇無效。請直接點擊下方風格按鈕：剧情式广告、纪录片广告、标准电商广告、动画广告。",
                reply_markup=_ecommerce_ad_style_keyboard(),
            )
            return
        await state.update_data(ecommerce_ad_style=style, ecommerce_ad_style_label=text)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_target_language)
        await message.answer(
            "\n".join(
                [
                    f"已選擇風格：{text}。",
                    "步驟 3/13：請選擇目標地區語言。",
                    "後續提示詞中的台詞/旁白以及字幕會使用該語言。",
                ]
            ),
            reply_markup=_target_language_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_target_language)
    async def on_ecommerce_target_language(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        language = TARGET_LANGUAGE_BUTTONS.get(text)
        if not language:
            await message.answer("請直接點擊目標語言按鈕：马来西亚、日语、西班牙语、泰语、中文、英文。", reply_markup=_target_language_keyboard())
            return
        language_code, language_label = language
        await state.update_data(target_language=language_code, target_language_label=language_label, language=language_code)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_product_three_view_image)
        await message.answer(
            "\n".join(
                [
                    f"已選擇目標語言：{language_label}。",
                    "步驟 4/13：請先上傳產品三視圖或主體標準圖。",
                    "這一步只上傳 1 張最能代表產品本體的正面、側面、背面、多角度三視圖或最清晰主圖；不要混入賣點海報、參數圖或場景資料圖。",
                    "收到後會自動進入下一步。",
                ]
            ),
            reply_markup=_ecommerce_product_upload_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_product_three_view_image)
    async def on_ecommerce_product_three_view_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        data = await state.get_data()
        existing_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_three_view_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if text in ECOMMERCE_PRODUCT_DONE_TEXTS:
            if await _flush_pending_ecommerce_product_album(message, phase="three_view"):
                return
            if not existing_paths:
                await message.answer("請先上傳至少 1 張產品三視圖或主體標準圖。", reply_markup=_ecommerce_product_upload_keyboard())
                return
            await state.update_data(
                ecommerce_product_three_view_image_local_paths=existing_paths,
                product_image_local_path=existing_paths[0],
                product_image_local_paths=existing_paths,
            )
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_product_info_image)
            await message.answer(
                f"已收到 {len(existing_paths)} 張產品三視圖/主體圖。步驟 5/13：請上傳產品介紹相關圖片，例如包裝圖、賣點圖、細節圖、安裝/使用場景圖或參數資料圖；如果沒有介紹圖，可輸入「跳過」。",
                reply_markup=_ecommerce_product_upload_keyboard(),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳 1 張產品三視圖/主體標準圖，或把圖片當成 document 傳送。收到後會自動進入下一步。", reply_markup=_ecommerce_product_upload_keyboard())
            return
        work_dir = Path(str(data["work_dir"]))
        media_group_id = str(getattr(message, "media_group_id", "") or "").strip()
        if media_group_id:
            key = f"{int(message.chat.id)}:{media_group_id}"
            image_path = work_dir / f"product_three_view_{int(message.message_id)}{suffix}"
            await _download_message_media(message, image_path)
            buffer = ecommerce_product_album_buffers.setdefault(
                key,
                {"items": [], "state": state, "message": message, "task": None, "phase": "three_view"},
            )
            buffer["items"].append({"message_id": int(message.message_id), "path": str(image_path)})
            buffer["state"] = state
            buffer["message"] = message
            buffer["phase"] = "three_view"
            if buffer.get("task") is None:
                buffer["task"] = asyncio.create_task(_finalize_ecommerce_product_album(key))
            return
        image_path = work_dir / f"product_three_view_{len(existing_paths) + 1}{suffix}"
        await _download_message_media(message, image_path)
        product_paths = existing_paths + [str(image_path)]
        await state.update_data(
            ecommerce_product_three_view_image_local_paths=product_paths,
            product_image_local_path=product_paths[0],
            product_image_local_paths=product_paths,
        )
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_product_info_image)
        await message.answer(
            f"產品主圖已收到。步驟 5/13：請上傳產品介紹相關圖片，例如包裝圖、賣點圖、細節圖、安裝/使用場景圖或參數資料圖；如果沒有介紹圖，可輸入「跳過」。",
            reply_markup=_ecommerce_product_upload_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_product_info_image)
    async def on_ecommerce_product_info_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        three_view_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_three_view_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if not three_view_paths:
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_product_three_view_image)
            await message.answer("未找到產品三視圖，請先上傳產品三視圖或主體標準圖。", reply_markup=_ecommerce_product_upload_keyboard())
            return
        info_paths = [
            str(item or "").strip()
            for item in (data.get("ecommerce_product_info_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if text in ECOMMERCE_PRODUCT_DONE_TEXTS or text in AUTO_DURATION_TEXTS:
            if await _flush_pending_ecommerce_product_album(message, phase="info"):
                return
            merged_paths = [*three_view_paths, *info_paths]
            await state.update_data(
                product_image_local_path=merged_paths[0],
                product_image_local_paths=merged_paths,
                ecommerce_product_info_image_local_paths=info_paths,
            )
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_model_image)
            info_text = f"已收到 {len(info_paths)} 張產品介紹相關圖片。" if info_paths else "已跳過產品介紹相關圖片。"
            await message.answer(
                f"{info_text} 後續會優先使用產品三視圖，再從介紹圖中提取賣點信息。步驟 6/13：請上傳講解人/模特或背景圖；如果不需要模特/背景參考，請輸入「跳過」。",
                reply_markup=_ecommerce_step_keyboard(),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳產品介紹相關圖片，或輸入「跳過」；上傳完後點「完成上传，下一步」。", reply_markup=_ecommerce_product_upload_keyboard())
            return
        media_group_id = str(getattr(message, "media_group_id", "") or "").strip()
        if media_group_id:
            key = f"{int(message.chat.id)}:{media_group_id}"
            image_path = work_dir / f"product_info_{int(message.message_id)}{suffix}"
            await _download_message_media(message, image_path)
            buffer = ecommerce_product_album_buffers.setdefault(
                key,
                {"items": [], "state": state, "message": message, "task": None, "phase": "info"},
            )
            buffer["items"].append({"message_id": int(message.message_id), "path": str(image_path)})
            buffer["state"] = state
            buffer["message"] = message
            buffer["phase"] = "info"
            if buffer.get("task") is None:
                buffer["task"] = asyncio.create_task(_finalize_ecommerce_product_album(key))
            return
        image_path = work_dir / f"product_info_{len(info_paths) + 1}{suffix}"
        await _download_message_media(message, image_path)
        info_paths = info_paths + [str(image_path)]
        merged_paths = [*three_view_paths, *info_paths]
        await state.update_data(
            ecommerce_product_info_image_local_paths=info_paths,
            product_image_local_path=merged_paths[0],
            product_image_local_paths=merged_paths,
        )
        await message.answer(
            f"已收到第 {len(info_paths)} 張產品介紹相關圖片。可以繼續上傳，或點「完成上传，下一步」。",
            reply_markup=_ecommerce_product_upload_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_model_image)
    async def on_ecommerce_model_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        if text in AUTO_DURATION_TEXTS:
            await state.update_data(
                model_image_local_path="",
                ecommerce_model_reference_skipped=True,
                ecommerce_person_weight_mode="low_no_front_face",
            )
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_voice_audio)
            data = await state.get_data()
            target_language = _target_language_code_from_data(data)
            await _send_preset_dry_voice_previews(message, config, target_language=target_language)
            await message.answer(
                "\n".join(
                    [
                        "已跳過模特/背景參考。後續提示詞會降低人物權重，避免正面人臉。",
                        "步驟 7/13：請上傳音色參考音頻、選擇 預設音色；如果不需要指定音色，請輸入「跳過」。",
                        "支持 mp3、wav、m4a、aac、flac、ogg，也可以直接發語音。",
                    ]
                ),
                reply_markup=_preset_dry_voice_keyboard(include_skip=True, target_language=target_language),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳講解人/模特或背景圖，或輸入「跳過」。", reply_markup=_ecommerce_step_keyboard())
            return
        image_path = work_dir / f"model_image{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(
            model_image_local_path=str(image_path),
            ecommerce_model_reference_skipped=False,
            ecommerce_person_weight_mode="",
        )
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_voice_audio)
        data = await state.get_data()
        target_language = _target_language_code_from_data(data)
        await _send_preset_dry_voice_previews(message, config, target_language=target_language)
        await message.answer(
            "\n".join(
                [
                    "講解人/模特或背景圖已收到。步驟 7/13：請上傳音色參考音頻、選擇 預設音色；如果不需要指定音色，請輸入「跳過」。",
                    "支持 mp3、wav、m4a、aac、flac、ogg，也可以直接發語音。",
                ]
            ),
            reply_markup=_preset_dry_voice_keyboard(include_skip=True, target_language=target_language),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_voice_audio)
    async def on_ecommerce_voice_audio(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        data = await state.get_data()
        target_language = _target_language_code_from_data(data)
        work_dir = Path(str(data["work_dir"]))
        if text in AUTO_DURATION_TEXTS:
            await state.update_data(
                audio_local_path="",
                preset_dry_voice="",
                minimax_tts_voice_id="",
                elevenlabs_tts_preset_key="",
                elevenlabs_tts_voice_id="",
                tts_provider="",
                speaker="",
            )
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_video_structure)
            await message.answer(
                "\n".join(
                    [
                        "已跳過音色。步驟 8/13：請選擇成片形式。",
                        "",
                        "點擊「1 单条长视频」：適合連續廣告展示。",
                        "點擊「2 多段分镜视频」：適合多鏡頭、場景切換或劇情式廣告。",
                    ]
                ),
                reply_markup=_ecommerce_structure_keyboard(),
            )
            return
        preset = _elevenlabs_voice_preset_by_button(text, target_language)
        if preset:
            try:
                audio_path, preset_label = await asyncio.to_thread(
                    _copy_preset_dry_voice_to_work_dir,
                    config,
                    target_language=target_language,
                    preset=preset,
                    work_dir=work_dir,
                    prefix="preset_voice",
                )
            except Exception as exc:
                logger.exception("Failed to prepare preset dry voice.")
                await message.answer(f"预设音色下载失败：{exc}。请稍后重试，或直接上传自己的干音。", reply_markup=_preset_dry_voice_keyboard(include_skip=True, target_language=target_language))
                return
            await state.update_data(
                audio_local_path=str(audio_path),
                preset_dry_voice=preset_label,
                minimax_tts_voice_id="",
                elevenlabs_tts_preset_key=str(preset.get("key") or "").strip(),
                elevenlabs_tts_voice_id=str(preset.get("voice_id") or "").strip(),
                tts_provider="",
                speaker=str(preset.get("voice_name") or "").strip(),
            )
            await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_video_structure)
            await message.answer(
                "\n".join(
                    [
                        f"已選擇官方音色：{preset_label}。步驟 8/13：請選擇成片形式。",
                        "",
                        "點擊「1 单条长视频」：適合連續廣告展示。",
                        "點擊「2 多段分镜视频」：適合多鏡頭、場景切換或劇情式廣告。",
                    ]
                ),
                reply_markup=_ecommerce_structure_keyboard(),
            )
            return
        suffix = _audio_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳音色參考音頻，或點選預設音色；如果不需要，請輸入「跳過」。支持 mp3、wav、m4a、aac、flac、ogg。", reply_markup=_preset_dry_voice_keyboard(include_skip=True, target_language=target_language))
            return
        audio_path = work_dir / f"voice_audio{suffix}"
        await _download_message_media(message, audio_path)
        await state.update_data(
            audio_local_path=str(audio_path),
            preset_dry_voice="",
            minimax_tts_voice_id="",
            elevenlabs_tts_preset_key="",
            elevenlabs_tts_voice_id="",
            tts_provider="",
            speaker="",
        )
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_video_structure)
        await message.answer(
            "\n".join(
                [
                    "音色參考音頻已收到。步驟 8/13：請選擇成片形式。",
                    "",
                    "點擊「1 单条长视频」：適合連續廣告展示。",
                    "點擊「2 多段分镜视频」：適合多鏡頭、場景切換或劇情式廣告。",
                ]
            ),
            reply_markup=_ecommerce_structure_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_video_structure)
    async def on_ecommerce_video_structure(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        if text in ECOMMERCE_SINGLE_VIDEO_TEXTS:
            video_structure = "single"
            label = "单条长视频"
        elif text in ECOMMERCE_STORYBOARD_VIDEO_TEXTS:
            video_structure = "storyboard"
            label = "多段分镜视频"
        else:
            await message.answer(
                "選擇無效。請直接點擊下方按鈕：\n1 单条长视频\n2 多段分镜视频",
                reply_markup=_ecommerce_structure_keyboard(),
            )
            return
        await state.update_data(video_structure=video_structure)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_ratio)
        await message.answer(
            f"已選擇：{label}。\n步驟 9/13：請選擇視頻比例。",
            reply_markup=_ecommerce_ratio_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_ratio)
    async def on_ecommerce_ratio(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        ratio = ECOMMERCE_RATIO_BUTTONS.get(text)
        if not ratio:
            await message.answer("選擇無效。請直接點擊下方比例按鈕：16:9、4:3、1:1、3:4、9:16。", reply_markup=_ecommerce_ratio_keyboard())
            return
        await state.update_data(ratio=ratio, ratio_label=text)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_resolution)
        await message.answer(
            f"已選擇比例：{text}。\n步驟 10/13：請選擇分辨率。",
            reply_markup=_ecommerce_resolution_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_resolution)
    async def on_ecommerce_resolution(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        resolution = ECOMMERCE_RESOLUTION_BUTTONS.get(text)
        if not resolution:
            await message.answer("選擇無效。請直接點擊下方分辨率按鈕：480p、720p、1080p、2k、4k。", reply_markup=_ecommerce_resolution_keyboard())
            return
        await state.update_data(resolution=resolution)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_duration)
        await message.answer(
            f"已選擇分辨率：{resolution}。\n步驟 11/13：請輸入視頻總時長，只能輸入 4 到 120 之間的數字；超過 15 秒會自動分段生成並拼接。",
            reply_markup=_ecommerce_step_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_duration)
    async def on_ecommerce_duration(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        try:
            duration = _parse_ecommerce_duration_seconds(text)
        except Exception as exc:
            await message.answer(f"秒數格式不正確：{exc}，請重新輸入。", reply_markup=_ecommerce_step_keyboard())
            return
        await state.update_data(duration_seconds=duration)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_user_prompt)
        await message.answer(
            "步驟 12/13：可以輸入一段提示詞或文案，AI 會在此基礎上優化。\n如果不想輸入，請點擊或輸入「跳過」，由 AI 根據圖片自動生成。",
            reply_markup=_ecommerce_step_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_user_prompt)
    async def on_ecommerce_user_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        await state.update_data(user_prompt="" if text in AUTO_DURATION_TEXTS else text)
        try:
            await generate_and_show_ecommerce_preview(message, state)
        except Exception as exc:
            logger.exception("Failed to generate ecommerce short video prompt preview.")
            await message.answer(f"AI 提示詞生成失敗：{exc}。請重新輸入提示詞或點擊「跳過」再試一次。", reply_markup=_ecommerce_step_keyboard())

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_prompt_guided_revision)
    async def on_ecommerce_prompt_guided_revision(
        message: Message, state: FSMContext
    ) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        instruction = _message_text(message)
        if not instruction:
            await message.answer(
                "修改要求不能為空，請重新輸入。",
                reply_markup=_ecommerce_step_keyboard(),
            )
            return
        data = await state.get_data()
        generated = data.get("ecommerce_generated_params")
        generated = dict(generated) if isinstance(generated, dict) else {}
        current_prompt = str(
            generated.get("prompt") or generated.get("prompt_text") or ""
        ).strip()
        current_segments = (
            generated.get("prompt_segments")
            if isinstance(generated.get("prompt_segments"), list)
            else []
        )
        if not current_prompt and not current_segments:
            await message.answer(
                "目前沒有可修改的廣告短視頻提示詞，請先重新生成提示詞。",
                reply_markup=_ecommerce_confirm_keyboard(),
            )
            return
        params = dict(generated)
        params["ecommerce_current_prompt"] = current_prompt
        if current_segments:
            params["ecommerce_current_prompt_segments"] = current_segments
        params["ecommerce_revision_instruction"] = instruction
        await message.answer(
            "正在根據你的要求修改廣告短視頻提示詞，請稍候。",
            reply_markup=_ecommerce_step_keyboard(),
        )
        try:
            preview = await _preview_internal_ecommerce_prompt(
                chat_id=int(message.chat.id),
                params=params,
            )
        except Exception as exc:
            logger.exception("Failed to revise ecommerce short video prompt.")
            await message.answer(
                f"引導修改失敗：{exc}\n請重新輸入修改要求，或點「返回上一步」。",
                reply_markup=_ecommerce_step_keyboard(),
            )
            return
        revised = dict(preview.get("params") or {})
        if not revised or not str(revised.get("prompt") or "").strip():
            await message.answer(
                "引導修改後沒有返回可用提示詞，請重新輸入修改要求。",
                reply_markup=_ecommerce_step_keyboard(),
            )
            return
        for key in (
            "add_subtitles",
            "subtitle_enabled",
            "ecommerce_model_reference_skipped",
            "ecommerce_animation_redraw_done",
            "ecommerce_animation_redraw_skipped",
            "ecommerce_animation_original_reference_paths",
            "ecommerce_animation_redrawn_reference_paths",
            "ecommerce_animation_redraw_result",
        ):
            value = generated.get(key)
            if value not in (None, "", [], {}):
                revised.setdefault(key, value)
        await _show_ecommerce_generated_preview(message, state, revised)
    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_animation_redraw_confirm)
    async def on_ecommerce_animation_redraw_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        if text in ECOMMERCE_GUIDED_REVISION_TEXTS:
            await _start_ecommerce_prompt_guided_revision(
                message, state, return_state="animation"
            )
            return
        if text in ECOMMERCE_REGENERATE_TEXTS:
            try:
                await generate_and_show_ecommerce_preview(message, state, regenerate=True)
            except Exception as exc:
                logger.exception("Failed to regenerate ecommerce short video prompt preview.")
                await message.answer(f"重新生成失敗：{exc}", reply_markup=_ecommerce_animation_redraw_keyboard())
            return
        data = await state.get_data()
        params = dict(data.get("ecommerce_generated_params") or {})
        if not params:
            await message.answer("未找到已生成的提示詞，請點擊「重新生成提示词」。", reply_markup=_ecommerce_animation_redraw_keyboard())
            return
        if text in ECOMMERCE_ANIMATION_REDRAW_SKIP_TEXTS:
            params["ecommerce_animation_redraw_skipped"] = True
            await state.update_data(ecommerce_generated_params=params)
            await _ask_ecommerce_subtitle_choice(message, state, prefix_text="已选择保留原图继续。")
            return
        if text not in ECOMMERCE_ANIMATION_REDRAW_CONFIRM_TEXTS:
            await message.answer("請點擊「确认转绘」或「不转绘继续」。", reply_markup=_ecommerce_animation_redraw_keyboard())
            return
        await message.answer("正在转绘动画广告参考图，请稍候。", reply_markup=_ecommerce_animation_redraw_keyboard())
        try:
            result = await _run_internal_ecommerce_animation_redraw(chat_id=int(message.chat.id), params=params)
        except Exception as exc:
            logger.exception("Failed to redraw ecommerce animation references.")
            await message.answer(f"动画转绘失败：{exc}\n可点「确认转绘」重试，或点「不转绘继续」。", reply_markup=_ecommerce_animation_redraw_keyboard())
            return
        redrawn_params = dict(result.get("params") or {})
        await state.update_data(ecommerce_generated_params=redrawn_params)
        preview_paths = [
            str(item or "").strip()
            for item in (redrawn_params.get("ecommerce_animation_redrawn_reference_paths") if isinstance(redrawn_params.get("ecommerce_animation_redrawn_reference_paths"), list) else [])
            if str(item or "").strip()
        ]
        for idx, path_text in enumerate(preview_paths[:3], start=1):
            path = Path(path_text)
            if path.exists() and path.is_file():
                await message.answer_photo(FSInputFile(path), caption=f"动画转绘参考图 {idx}/{len(preview_paths)}")
        await _ask_ecommerce_subtitle_choice(message, state, prefix_text="动画广告参考图已转绘完成，后续视频生成会使用转绘后的素材。")

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_subtitle_choice)
    async def on_ecommerce_subtitle_choice(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        if text in ECOMMERCE_GUIDED_REVISION_TEXTS:
            await _start_ecommerce_prompt_guided_revision(
                message, state, return_state="subtitle"
            )
            return
        if text in ECOMMERCE_REGENERATE_TEXTS:
            try:
                await generate_and_show_ecommerce_preview(message, state, regenerate=True)
            except Exception as exc:
                logger.exception("Failed to regenerate ecommerce short video prompt preview.")
                await message.answer(f"重新生成失敗：{exc}", reply_markup=_ecommerce_subtitle_keyboard())
            return
        if text not in ECOMMERCE_SUBTITLE_ENABLE_TEXTS and text not in ECOMMERCE_SUBTITLE_DISABLE_TEXTS:
            await message.answer("请选择「添加字幕」或「不添加字幕」。", reply_markup=_ecommerce_subtitle_keyboard())
            return
        data = await state.get_data()
        params = dict(data.get("ecommerce_generated_params") or {})
        if not params:
            await message.answer("未找到已生成的提示詞，請點擊「重新生成提示词」。", reply_markup=_ecommerce_subtitle_keyboard())
            return
        add_subtitles = text in ECOMMERCE_SUBTITLE_ENABLE_TEXTS
        params["add_subtitles"] = add_subtitles
        params["subtitle_enabled"] = add_subtitles
        await state.update_data(ecommerce_generated_params=params)
        await state.set_state(ProductionWorkflowForm.ecommerce_waiting_for_confirm)
        await message.answer(
            f"字幕设置：{'添加字幕' if add_subtitles else '不添加字幕'}。\n确认无误后点击「确认生成」。如不满意，可点击「重新生成提示词」。",
            reply_markup=_ecommerce_confirm_keyboard(),
        )

    @router.message(ProductionWorkflowForm.ecommerce_waiting_for_confirm)
    async def on_ecommerce_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        if await handle_ecommerce_back_request(message, state):
            return
        text = _message_text(message)
        if text in ECOMMERCE_GUIDED_REVISION_TEXTS:
            await _start_ecommerce_prompt_guided_revision(
                message, state, return_state="confirm"
            )
            return
        if text in ECOMMERCE_REGENERATE_TEXTS:
            try:
                await generate_and_show_ecommerce_preview(message, state, regenerate=True)
            except Exception as exc:
                logger.exception("Failed to regenerate ecommerce short video prompt preview.")
                await message.answer(f"重新生成失敗：{exc}", reply_markup=_ecommerce_confirm_keyboard())
            return
        if text not in ECOMMERCE_CONFIRM_TEXTS:
            await message.answer("請點擊「确认生成」開始生成視頻，或點擊「重新生成提示词」。", reply_markup=_ecommerce_confirm_keyboard())
            return
        data = await state.get_data()
        params = dict(data.get("ecommerce_generated_params") or {})
        if not params:
            await message.answer("未找到已生成的提示詞，請點擊「重新生成提示词」。", reply_markup=_ecommerce_confirm_keyboard())
            return
        params["tg_use_llm_prompt"] = False
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "ecommerce_short_video", params)
        except Exception as exc:
            await message.answer(f"廣告短視頻任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.image_waiting_for_product_image)
    async def on_image_generate_product_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        data = await state.get_data()
        text = _message_text(message)
        existing_paths = [
            str(item or "").strip()
            for item in (data.get("product_image_local_paths") or [])
            if str(item or "").strip()
        ]
        if text in ECOMMERCE_PRODUCT_DONE_TEXTS:
            if await _flush_pending_ecommerce_product_album(message, phase="image_generate_product"):
                data = await state.get_data()
                existing_paths = [
                    str(item or "").strip()
                    for item in (data.get("product_image_local_paths") or [])
                    if str(item or "").strip()
                ]
            if not existing_paths:
                await message.answer("請先上傳至少 1 張產品圖，再點「完成上传，下一步」。", reply_markup=_ecommerce_product_upload_keyboard())
                return
            await state.update_data(product_image_local_path=existing_paths[0], product_image_local_paths=existing_paths)
            await state.set_state(ProductionWorkflowForm.image_waiting_for_model_image)
            await message.answer(
                f"已收到 {len(existing_paths)} 張產品圖。步驟 2/4：請上傳模特圖、背景圖或品牌參考圖；不需要可點「跳过」。",
                reply_markup=_image_generate_model_upload_keyboard(),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳商品圖片，或點「完成上传，下一步」。", reply_markup=_ecommerce_product_upload_keyboard())
            return
        work_dir = Path(str(data["work_dir"]))
        media_group_id = str(getattr(message, "media_group_id", "") or "").strip()
        if media_group_id:
            key = f"{int(message.chat.id)}:{media_group_id}"
            image_path = work_dir / f"image_generate_product_{int(message.message_id)}{suffix}"
            await _download_message_media(message, image_path)
            buffer = ecommerce_product_album_buffers.setdefault(
                key,
                {"items": [], "state": state, "message": message, "task": None, "phase": "image_generate_product"},
            )
            buffer["items"].append({"message_id": int(message.message_id), "path": str(image_path)})
            buffer["state"] = state
            buffer["message"] = message
            buffer["phase"] = "image_generate_product"
            if buffer.get("task") is None:
                buffer["task"] = asyncio.create_task(_finalize_ecommerce_product_album(key))
            return
        image_path = work_dir / f"product_image_{len(existing_paths) + 1}{suffix}"
        await _download_message_media(message, image_path)
        product_paths = [*existing_paths, str(image_path)]
        await state.update_data(product_image_local_path=product_paths[0], product_image_local_paths=product_paths)
        await message.answer(
            f"已收到第 {len(product_paths)} 張產品圖。可繼續上傳，或點「完成上传，下一步」。",
            reply_markup=_ecommerce_product_upload_keyboard(),
        )

    @router.message(ProductionWorkflowForm.image_waiting_for_model_image)
    async def on_image_generate_model_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        if text in {"跳过", "跳過", "skip", "Skip", "SKIP"}:
            await state.update_data(model_image_local_path="", ecommerce_model_reference_skipped=True)
            await state.set_state(ProductionWorkflowForm.image_waiting_for_size)
            await message.answer(
                "已跳過模特/背景參考圖。步驟 3/4：請選擇圖片比例（16:9 / 4:3 / 1:1 / 3:4 / 9:16）。",
                reply_markup=_image_edit_size_keyboard(),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳模特圖、背景圖或品牌參考圖，或點「跳过」。", reply_markup=_image_generate_model_upload_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"model_image{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(model_image_local_path=str(image_path))
        await state.set_state(ProductionWorkflowForm.image_waiting_for_size)
        await message.answer(
            "模特圖/背景圖已收到。步驟 3/4：請選擇圖片比例（16:9 / 4:3 / 1:1 / 3:4 / 9:16）。",
            reply_markup=_image_edit_size_keyboard(),
        )

    @router.message(ProductionWorkflowForm.image_waiting_for_size)
    async def on_image_generate_size(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        size_text = _message_text(message)
        image_size = IMAGE_EDIT_SIZE_BUTTONS.get(size_text)
        if image_size is None:
            await message.answer(
                "比例選擇無效。請直接點擊下方按鈕：16:9、4:3、1:1、3:4、9:16。",
                reply_markup=_image_edit_size_keyboard(),
            )
            return
        await state.update_data(image_size=image_size)
        await state.set_state(ProductionWorkflowForm.image_waiting_for_prompt)
        await message.answer(
            f"已選擇圖片比例：{image_size}。\n步驟 4/4：請輸入電商海報提示詞；如果需要 AI 自動生成海報文案和版式，請輸入「跳過」。",
            reply_markup=_menu_keyboard(),
        )

    @router.message(ProductionWorkflowForm.image_waiting_for_prompt)
    async def on_image_generate_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        prompt = _message_text(message)
        use_ai_prompt = prompt in AUTO_DURATION_TEXTS or not prompt
        data = await state.get_data()
        product_paths = [
            str(item or "").strip()
            for item in (data.get("product_image_local_paths") or [])
            if str(item or "").strip()
        ]
        product_main = str(data.get("product_image_local_path") or (product_paths[0] if product_paths else "")).strip()
        model_image = str(data.get("model_image_local_path") or "").strip()
        params = {
            "product_image_local_path": product_main,
            "product_image_local_paths": product_paths or ([product_main] if product_main else []),
            "model_image_local_path": model_image,
            "prompt": "" if use_ai_prompt else prompt,
            "mode": "model_product" if model_image else "product_only",
            "image_size": str(data.get("image_size") or "1:1"),
            "size": str(data.get("image_size") or "1:1"),
            "image_generate_provider": "closed_model_api",
            "image_generate_mode_default": "closed_model_api",
            "tg_use_llm_prompt": use_ai_prompt,
            "tg_workflow_label": "電商廣告圖生產",
        }
        if use_ai_prompt:
            params["tg_user_instruction"] = (
                "根据上传的多张产品/空间/服务参考图生成电商宣传海报提示词；"
                "先判断每张图的有效信息，自行选择一张或多张最适合的图片作为商品主体、细节、卖点或场景参考。"
            )
            await message.answer(
                "已收到「跳過」。正在由 AI 生成電商宣傳海報提示詞並提交任務，請稍候。",
                reply_markup=_menu_keyboard(),
            )
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "image_generate", params)
        except Exception as exc:
            await message.answer(f"電商廣告圖生產任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.poster_translate_waiting_for_image)
    async def on_poster_translate_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("请上传原始电商海报图，或把图片当成 document 发送。", reply_markup=_image_generation_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"poster_translate_source{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(poster_translate_image_local_path=str(image_path))
        await state.set_state(ProductionWorkflowForm.poster_translate_waiting_for_target_language)
        await message.answer(
            "海报图已收到。步骤 2/2：请选择目标市场语言。",
            reply_markup=_target_language_keyboard(),
        )

    @router.message(ProductionWorkflowForm.poster_translate_waiting_for_target_language)
    async def on_poster_translate_target_language(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        language = TARGET_LANGUAGE_BUTTONS.get(text)
        if language is None:
            await message.answer("请直接点击目标语言按钮：马来西亚、日语、西班牙语、泰语、中文、英文。", reply_markup=_target_language_keyboard())
            return
        language_code, language_label = language
        data = await state.get_data()
        image_path = str(data.get("poster_translate_image_local_path") or "").strip()
        if not image_path:
            await state.set_state(ProductionWorkflowForm.poster_translate_waiting_for_image)
            await message.answer("未找到海报图，请重新上传原始电商海报图。", reply_markup=_image_generation_keyboard())
            return
        params = {
            "product_image_local_path": image_path,
            "prompt": "",
            "mode": "poster_translate",
            "target_language": language_code,
            "target_language_label": language_label,
            "language": language_code,
            "image_size": "auto",
            "size": "auto",
            "image_generate_provider": "closed_model_api",
            "image_generate_mode_default": "closed_model_api",
            "tg_use_llm_prompt": False,
            "tg_workflow_label": "电商图语种切换",
        }
        await state.clear()
        await message.answer(f"正在将电商海报文字切换为{language_label}，请稍候。", reply_markup=_menu_keyboard())
        try:
            await submit_webapp_task_and_reply(message, "image_generate", params)
        except Exception as exc:
            await message.answer(f"电商图语种切换任务提交失败：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.image_three_view_waiting_for_image)
    async def on_three_view_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳產品圖或模特圖，或把圖片當成 document 傳送。", reply_markup=_image_generation_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"three_view_input{suffix}"
        await _download_message_media(message, image_path)
        params = {
            "product_image_local_path": str(image_path),
            "prompt": "根据图片内容生成三视图。",
            "mode": "three_view",
            "image_size": "4:3",
            "size": "4:3",
            "image_generate_provider": "closed_model_api",
            "image_generate_mode_default": "closed_model_api",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "根据图片内容判断主体类型，只输出极简三视图提示词。",
            "tg_workflow_label": "三視圖生成",
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "image_generate", params)
        except Exception as exc:
            await message.answer(f"三視圖生成任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.digital_human_character_waiting_for_region)
    async def on_digital_human_character_region(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        region = DIGITAL_HUMAN_CHARACTER_REGIONS.get(text)
        if not region:
            await message.answer("請直接點擊下方按鈕選擇地區特徵：中国、欧美、印尼、泰国、日本、马来西亚。", reply_markup=_digital_human_character_region_keyboard())
            return
        await state.update_data(digital_human_character_region=region, digital_human_character_region_label=text)
        await state.set_state(ProductionWorkflowForm.digital_human_character_waiting_for_prompt)
        await message.answer(
            "\n".join(
                [
                    f"已選擇：{text}",
                    "步驟 2/2：請輸入你希望的人設特徵，例如年齡、性別、職業、氣質、髮型、服裝、用途。",
                    "如果不想指定，請輸入「跳過」，由 AI 自動生成。",
                ]
            ),
            reply_markup=_image_generation_keyboard(),
        )

    @router.message(ProductionWorkflowForm.digital_human_character_waiting_for_prompt)
    async def on_digital_human_character_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        user_prompt = "" if text in AUTO_DURATION_TEXTS else text
        data = await state.get_data()
        region = str(data.get("digital_human_character_region") or "").strip()
        region_label = str(data.get("digital_human_character_region_label") or "").strip()
        if not region:
            await state.set_state(ProductionWorkflowForm.digital_human_character_waiting_for_region)
            await message.answer("未找到地區選擇，請重新選擇。", reply_markup=_digital_human_character_region_keyboard())
            return
        params = {
            "prompt": user_prompt,
            "mode": "digital_human_character",
            "digital_human_character_region": region,
            "digital_human_character_region_label": region_label,
            "image_size": "4:3",
            "size": "4:3",
            "image_generate_provider": "closed_model_api",
            "image_generate_mode_default": "closed_model_api",
            "tg_use_llm_prompt": False,
            "tg_user_instruction": (
                f"生成{region_label}地区特征的数字人人设三视图。"
                + (f"用户指定特征：{user_prompt}。" if user_prompt else "用户未指定特征，请自动生成完整人设。")
            ),
            "tg_workflow_label": "数字人人设三视图",
        }
        await state.clear()
        await message.answer("正在生成数字人人设三视图，请稍候。", reply_markup=_menu_keyboard())
        try:
            await submit_webapp_task_and_reply(message, "image_generate", params)
        except Exception as exc:
            await message.answer(f"数字人人设三视图任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.subject_replace_waiting_for_source_image)
    async def on_subject_replace_source_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳需要被替換的原圖，或把圖片當成 document 傳送。", reply_markup=_image_generation_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"subject_replace_source{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(subject_replace_source_image_local_path=str(image_path))
        await state.set_state(ProductionWorkflowForm.subject_replace_waiting_for_replacement_image)
        await message.answer(
            "原圖已收到。步驟 2/2：請上傳用來替換的圖片，可以是商品，也可以是模特/人物。",
            reply_markup=_image_generation_keyboard(),
        )

    @router.message(ProductionWorkflowForm.subject_replace_waiting_for_replacement_image)
    async def on_subject_replace_replacement_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳用來替換的商品圖或模特/人物圖，或把圖片當成 document 傳送。", reply_markup=_image_generation_keyboard())
            return
        data = await state.get_data()
        source_path = str(data.get("subject_replace_source_image_local_path") or "").strip()
        if not source_path:
            await state.set_state(ProductionWorkflowForm.subject_replace_waiting_for_source_image)
            await message.answer("未找到原圖，請重新上傳需要被替換的原圖。", reply_markup=_image_generation_keyboard())
            return
        work_dir = Path(str(data["work_dir"]))
        replacement_path = work_dir / f"subject_replace_replacement{suffix}"
        await _download_message_media(message, replacement_path)
        params = {
            "product_image_local_path": source_path,
            "replacement_image_local_path": str(replacement_path),
            "prompt": "纯局部主体替换：根据第二张图片判断替换主体类型；如果是商品，替换第一张图中的所有同类产品，不生成广告海报、标题、卖点文字、图标或Logo；如果是人物，替换对应人物主体。",
            "mode": "subject_replace",
            "image_size": "auto",
            "size": "auto",
            "image_generate_provider": "closed_model_api",
            "image_generate_mode_default": "closed_model_api",
            "tg_use_llm_prompt": False,
            "tg_workflow_label": "主体替换",
        }
        await state.clear()
        await message.answer("正在进行主体替换，请稍候。", reply_markup=_menu_keyboard())
        try:
            await submit_webapp_task_and_reply(message, "image_generate", params)
        except Exception as exc:
            await message.answer(f"主体替换任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.replace_model_waiting_for_video)
    async def on_replace_model_video(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _video_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳原視頻，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        video_path = work_dir / f"source_video{suffix}"
        await _download_message_media(message, video_path)
        await state.update_data(video_local_path=str(video_path))
        await state.set_state(ProductionWorkflowForm.replace_model_waiting_for_image)
        await message.answer(
            "步驟 2/3：原視頻已收到。\n請上傳人像/模特圖片，系統會把視頻中的人物替換成這張圖的人物。",
            reply_markup=_menu_keyboard(),
        )

    @router.message(ProductionWorkflowForm.replace_model_waiting_for_image)
    async def on_replace_model_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳人像/模特圖片，或把人像圖片當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"model_image{suffix}"
        await _download_message_media(message, image_path)
        data = await state.get_data()
        params = {
            "video_local_path": str(data["video_local_path"]),
            "image_local_path": str(image_path),
            "prompt": "",
            "mode": "original",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "只替换人物身份和外观，保留原视频动作、姿态、构图、镜头运动、背景光线和视频比例，人物比例匹配原视频。",
        }
        await state.clear()
        await message.answer("步驟 3/3：模特圖已收到。正在按原視頻時長提交視頻模特替換任務。", reply_markup=_menu_keyboard())
        try:
            await submit_webapp_task_and_reply(message, "replace_model", params)
        except Exception as exc:
            await message.answer(f"視頻模特替換任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.replace_model_waiting_for_duration)
    async def on_replace_model_duration(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        data = await state.get_data()
        params = {
            "video_local_path": str(data["video_local_path"]),
            "image_local_path": str(data["image_local_path"]),
            "prompt": str(data.get("prompt") or ""),
            "mode": "original",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": str(
                data.get("prompt")
                or "只替换人物身份和外观，保留原视频动作、姿态、构图、镜头运动、背景光线和视频比例，人物比例匹配原视频。"
            ),
        }
        await state.clear()
        await message.answer("已收到，正在按原視頻時長提交視頻模特替換任務。", reply_markup=_menu_keyboard())
        try:
            await submit_webapp_task_and_reply(message, "replace_model", params)
        except Exception as exc:
            await message.answer(f"視頻模特替換任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.replace_product_waiting_for_video)
    async def on_replace_product_video(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _video_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳原視頻，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        video_path = work_dir / f"source_video{suffix}"
        await _download_message_media(message, video_path)
        await state.update_data(video_local_path=str(video_path))
        await state.set_state(ProductionWorkflowForm.replace_product_waiting_for_image)
        await message.answer(
            "步驟 2/4：原視頻已收到。\n請上傳商品圖片，系統會把視頻中的商品替換成這張圖的商品。",
            reply_markup=_menu_keyboard(),
        )

    @router.message(ProductionWorkflowForm.replace_product_waiting_for_image)
    async def on_replace_product_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳商品圖片，或把商品圖片當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"product_image{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(image_local_path=str(image_path))
        await state.set_state(ProductionWorkflowForm.replace_product_waiting_for_name)
        await message.answer("步驟 3/4：商品圖已收到。請輸入商品名稱；若使用默認名稱，輸入「跳過」。", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.replace_product_waiting_for_name)
    async def on_replace_product_name(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        name = _message_text(message)
        if name in AUTO_DURATION_TEXTS:
            name = "商品"
        await state.update_data(product_name=name or "商品", prompt_text="")
        await state.set_state(ProductionWorkflowForm.replace_product_waiting_for_duration)
        await message.answer(
            "步驟 4/4：商品名稱已收到。提示詞將由後台文字模型自動生成，請輸入視頻秒數；若使用默認 15 秒，輸入「跳過」。",
            reply_markup=_menu_keyboard(),
        )

    @router.message(ProductionWorkflowForm.replace_product_waiting_for_duration)
    async def on_replace_product_duration(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        try:
            duration = 15 if text in AUTO_DURATION_TEXTS else _parse_duration_seconds(text)
        except ValueError as exc:
            await message.answer(f"秒數格式不正確: {exc}", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        params = {
            "video_local_path": str(data["video_local_path"]),
            "image_local_path": str(data["image_local_path"]),
            "product_name": str(data.get("product_name") or "商品"),
            "prompt_text": str(data.get("prompt_text") or ""),
            "duration_seconds": duration,
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "\n".join(
                [
                    f"商品名称：{str(data.get('product_name') or '商品')}",
                    str(data.get("prompt_text") or "保持原视频镜头和人物动作，自然替换成上传商品图。"),
                ]
            ),
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "replace_product", params)
        except Exception as exc:
            await message.answer(f"視頻商品替換任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.union_waiting_for_video)
    async def on_union_video(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _video_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳原視頻，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        video_path = work_dir / f"source_video{suffix}"
        await _download_message_media(message, video_path)
        await state.update_data(video_local_path=str(video_path))
        await state.set_state(ProductionWorkflowForm.union_waiting_for_model_image)
        await message.answer(
            "步驟 2/5：原視頻已收到。\n請先上傳人像/模特圖片，系統會先替換視頻中的人物。",
            reply_markup=_menu_keyboard(),
        )

    @router.message(ProductionWorkflowForm.union_waiting_for_model_image)
    async def on_union_model_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳人像/模特圖片，或把人像圖片當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"model_image{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(model_image_local_path=str(image_path))
        await state.set_state(ProductionWorkflowForm.union_waiting_for_product_image)
        await message.answer(
            "步驟 3/5：人像/模特圖已收到。\n請上傳商品圖片，系統會再替換視頻中的商品。",
            reply_markup=_menu_keyboard(),
        )

    @router.message(ProductionWorkflowForm.union_waiting_for_product_image)
    async def on_union_product_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await message.answer("請上傳商品圖片，或把商品圖片當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        work_dir = Path(str(data["work_dir"]))
        image_path = work_dir / f"product_image{suffix}"
        await _download_message_media(message, image_path)
        await state.update_data(product_image_local_path=str(image_path))
        await state.set_state(ProductionWorkflowForm.union_waiting_for_name)
        await message.answer("步驟 4/5：商品圖已收到。請輸入商品名稱；若使用默認名稱，輸入「跳過」。", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.union_waiting_for_name)
    async def on_union_name(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        name = _message_text(message)
        if name in AUTO_DURATION_TEXTS:
            name = "商品"
        await state.update_data(product_name=name or "商品")
        await state.set_state(ProductionWorkflowForm.union_waiting_for_duration)
        await message.answer("步驟 5/5：請輸入視頻秒數；若使用默認 15 秒，輸入「跳過」。", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.union_waiting_for_duration)
    async def on_union_duration(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        try:
            duration = 15 if text in AUTO_DURATION_TEXTS else _parse_duration_seconds(text)
        except ValueError as exc:
            await message.answer(f"秒數格式不正確: {exc}", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        params = {
            "video_local_path": str(data["video_local_path"]),
            "model_image_local_path": str(data["model_image_local_path"]),
            "product_image_local_path": str(data["product_image_local_path"]),
            "product_name": str(data.get("product_name") or "商品"),
            "model_params": {"duration_seconds": duration},
            "product_params": {"product_name": str(data.get("product_name") or "商品"), "duration_seconds": duration},
            "tg_use_llm_prompt": True,
            "tg_user_instruction": f"联合替换：自然替换视频模特和商品。商品名称：{str(data.get('product_name') or '商品')}",
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "replace_productANDmodel", params)
        except Exception as exc:
            await message.answer(f"聯合替換任務提交失敗：{exc}", reply_markup=_menu_keyboard())

    @router.message(F.text == DIGITAL_HUMAN_VIDEO_BUTTON)
    @router.message(F.text == LEGACY_ORAL_UPLOAD_BUTTON)
    @router.message(F.text == LEGACY_UPLOAD_BUTTON)
    async def on_upload_task_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_upload_flow(message, state)

    @router.message(F.text == IMAGE_GENERATION_MENU_BUTTON)
    @router.message(F.text == LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON)
    async def on_image_generation_menu_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_image_generation_menu(message, state)

    @router.message(F.text == IMAGE_WORKFLOW_BUTTON)
    @router.message(F.text == LEGACY_IMAGE_WORKFLOW_BUTTON)
    async def on_image_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_image_generate_flow(message, state)

    @router.message(F.text == ECOMMERCE_POSTER_TRANSLATE_BUTTON)
    async def on_poster_translate_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_poster_translate_flow(message, state)

    @router.message(F.text == THREE_VIEW_IMAGE_BUTTON)
    async def on_three_view_image_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_three_view_image_flow(message, state)

    @router.message(F.text == DIGITAL_HUMAN_CHARACTER_BUTTON)
    async def on_digital_human_character_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_digital_human_character_flow(message, state)

    @router.message(F.text == SUBJECT_REPLACE_IMAGE_BUTTON)
    async def on_subject_replace_image_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_subject_replace_image_flow(message, state)

    @router.message(F.text == ECOMMERCE_SHORT_VIDEO_BUTTON)
    async def on_ecommerce_short_video_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_ecommerce_short_video_flow(message, state)

    @router.message(F.text == VIDEO_EDIT_BUTTON)
    async def on_video_edit_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await message.answer(
            "視頻編輯：請選擇要建立的任務。",
            reply_markup=_video_edit_keyboard(),
        )

    @router.message(F.text.in_(MAIN_MENU_TEXTS))
    async def on_main_menu_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await message.answer("已返回主菜單。", reply_markup=_menu_keyboard())

    @router.message(F.text == REPLACE_MODEL_WORKFLOW_BUTTON)
    @router.message(F.text == LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON)
    async def on_replace_model_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_replace_model_flow(message, state)

    @router.message(F.text == REPLACE_PRODUCT_WORKFLOW_BUTTON)
    @router.message(F.text == LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON)
    async def on_replace_product_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_replace_product_flow(message, state)

    @router.message(F.text == REPLACE_UNION_WORKFLOW_BUTTON)
    async def on_replace_union_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_union_flow(message, state)

    @router.message(F.text == WORKFLOW_CONFIG_BUTTON)
    async def on_workflow_config_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer(_workflow_config_text(service, selected_button=_message_text(message)), reply_markup=_menu_keyboard())

    @router.message(F.text == STATUS_BUTTON)
    async def on_status_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        chat_id = int(message.chat.id)
        await message.answer("正在读取工作台状态...", reply_markup=_menu_keyboard())
        await message.answer(
            _webapp_status_text(service, chat_id=chat_id, internal_step=digital_human_internal_steps.get(chat_id)),
            reply_markup=_menu_keyboard(),
        )

    @router.message(F.text == WORKBENCH_BUTTON)
    async def on_workbench_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer(
            f"工作台網址: {service.resolve_config().public_base_url}",
            reply_markup=_menu_keyboard(),
        )

    @router.message(F.text == SET_SCRIPT_BUTTON)
    async def on_setscript_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await state.set_state(ScriptForm.waiting_for_script)
        await message.answer("請直接貼上你想作為預設的文案內容。", reply_markup=_menu_keyboard())

    async def rerun_latest_webapp_or_local_task(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await message.answer("已收到重跑请求，正在查找最近任务...", reply_markup=_menu_keyboard())
        try:
            webapp_rerun = await _rerun_internal_webapp_latest_task(chat_id=int(message.chat.id))
        except Exception:
            logger.exception("Failed to rerun latest Web task from Telegram.")
            webapp_rerun = {}
        if bool(webapp_rerun.get("rerun")):
            task_id = str(webapp_rerun.get("id") or "").strip()
            _schedule_webapp_task_notification(
                message.bot,
                service,
                chat_id=int(message.chat.id),
                task_id=task_id,
            )
            await message.answer(
                "\n".join(
                    [
                        "最近任務已重新提交到後台隊列。",
                        f"原任務: {webapp_rerun.get('source_task_id')}",
                        f"新任務: {task_id}",
                        *(
                            ["圖片提示詞會重新由 AI 生成。"]
                            if bool(webapp_rerun.get("ai_prompt_refreshed"))
                            else []
                        ),
                        "可按「查看工作台狀態」跟進進度。",
                    ]
                ),
                reply_markup=_menu_keyboard(),
            )
            return
        await message.answer(str(webapp_rerun.get("message") or "你目前還沒有可重跑的歷史任務。"), reply_markup=_menu_keyboard())

    @router.message(F.text == IMAGE_REGENERATE_BUTTON)
    async def on_image_regenerate_button(message: Message) -> None:
        await rerun_latest_webapp_or_local_task(message)

    @router.message(F.text == RERUN_BUTTON)
    async def on_rerun_button(message: Message) -> None:
        await rerun_latest_webapp_or_local_task(message)

    @router.message(F.text == STOP_BUTTON)
    async def on_stop_button(message: Message, state: FSMContext) -> None:
        if await handle_stop_request(message, state):
            return

    @router.message()
    async def on_natural_language_message(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _message_text(message)
        if _is_orphan_digital_human_step_text(text):
            await state.clear()
            await message.answer(
                "\n".join(
                    [
                        "当前数字人视频流程状态已失效，不能继续使用旧按钮。",
                        "这通常发生在服务重启、会话中断或任务已被清理之后。",
                        f"请重新点击「{DIGITAL_HUMAN_VIDEO_BUTTON}」，再按步骤上传素材。",
                    ]
                ),
                reply_markup=_menu_keyboard(),
            )
            return
        if text in DIGITAL_HUMAN_RESOLUTION_BUTTONS:
            await message.answer(
                "\n".join(
                    [
                        "已收到分辨率，但当前数字人任务状态已失效。",
                        "这通常发生在服务重启或会话中断后。",
                        f"请重新点击「{DIGITAL_HUMAN_VIDEO_BUTTON}」，再依序上传人像图、克隆音频和口播文稿。",
                    ]
                ),
                reply_markup=_menu_keyboard(),
            )
            return
        work_dir = service.create_job_dir(prefix="tg_agent")
        files: list[dict[str, str]] = []
        try:
            downloaded = await _download_agent_message_file(message, work_dir)
            if downloaded:
                files.append(downloaded)
        except Exception as exc:
            await message.answer(f"素材下載失敗：{exc}", reply_markup=_menu_keyboard())
            return
        if not text and not files:
            await message.answer("請用文字描述你要建立的生產任務，或按面板入口依序提交素材。", reply_markup=_menu_keyboard())
            return
        if not text:
            text = "根据我上传的素材判断最合适的生产工作流，并生成需要的提示词。"
        await state.clear()
        try:
            result = await _submit_internal_webapp_agent_task(
                chat_id=int(message.chat.id),
                message_text=text,
                files=files,
            )
        except Exception as exc:
            await message.answer(
                f"智能任務提交失敗：{exc}\n\n你也可以按面板中的具體工作流入口，依序上傳素材。",
                reply_markup=_menu_keyboard(),
            )
            return
        summary = str(result.get("summary") or "已通過文字模型識別任務").strip()
        if result.get("submitted") is False:
            reply = str(result.get("reply") or summary or "").strip()
            if not reply:
                reply = "請補充具體生產任務和必要素材，或按面板入口依序提交。"
            await message.answer(reply, reply_markup=_menu_keyboard())
            return
        _schedule_webapp_task_notification(
            message.bot,
            service,
            chat_id=int(message.chat.id),
            task_id=str(result.get("id") or ""),
        )
        await message.answer(
            "\n".join(
                [
                    "已通過文字模型理解你的會話，並生成工作流提示詞。",
                    summary,
                    f"工作流: {result.get('task_type')}",
                    f"任務編號: {result.get('id')}",
                    "可按「查看工作台狀態」跟進進度。",
                ]
            ),
            reply_markup=_menu_keyboard(),
        )

    return dispatcher


class TelegramWorkbenchBot:
    def __init__(self, config: AppConfig, service: WorkspaceService) -> None:
        self.config = config
        self.service = service
        self.bot = _build_bot(config)
        self.dispatcher = build_dispatcher(config, service)
        self.polling_task: asyncio.Task | None = None

    async def _polling_loop(self) -> None:
        while True:
            try:
                logger.info("Telegram polling is starting.")
                await self.dispatcher.start_polling(self.bot, handle_signals=False)
                logger.info("Telegram polling stopped normally.")
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Telegram polling stopped unexpectedly; retrying in 5 seconds.")
                await asyncio.sleep(5)

    async def start(self) -> None:
        self.service.attach_bot(self.bot)
        await self.bot.delete_webhook(drop_pending_updates=False)
        logger.info(
            "Telegram bot startup complete; members=%s enabled=%s",
            len(self.service.list_members()),
            sum(1 for member in self.service.list_members() if member.enabled),
        )
        self.polling_task = asyncio.create_task(self._polling_loop(), name="workspace-bot-polling")
        for member in self.service.list_members():
            if member.enabled:
                try:
                    await self.bot.send_message(
                        member.chat_id,
                        "\n".join(
                            [
                                f"{self.service.get_app_title()} 已上線。",
                                f"首次使用可按「{DIGITAL_HUMAN_VIDEO_BUTTON}」，再依序傳人像圖、克隆音頻和口播文稿（必填）。",
                                f"廣告短視頻按「{ECOMMERCE_SHORT_VIDEO_BUTTON}」；圖片任務按「{IMAGE_GENERATION_MENU_BUTTON}」後選擇子工作流；視頻替換任務按「{VIDEO_EDIT_BUTTON}」。",
                                "也可以直接描述任務並附上素材，Bot 會用後台文字模型理解需求並生成提示詞。",
                                "提交後任務會進入後台隊列；可按「查看工作台狀態」，並在 Web 任務詳情查看進度與成品。",
                            ]
                        ),
                        reply_markup=_menu_keyboard(),
                    )
                except (asyncio.CancelledError, Exception):
                    continue

    async def stop(self) -> None:
        if self.polling_task is not None:
            self.polling_task.cancel()
            await asyncio.gather(self.polling_task, return_exceptions=True)
            self.polling_task = None
        await self.bot.session.close()
