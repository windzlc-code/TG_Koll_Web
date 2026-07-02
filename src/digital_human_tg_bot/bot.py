from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import os
import re
import secrets
import urllib.request
from pathlib import Path
from typing import Any

from aiohttp import ClientError, ClientSession, TCPConnector
from aiohttp.resolver import ThreadedResolver
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, Message, ReplyKeyboardMarkup, ReplyKeyboardRemove

from .config import AppConfig
from .media import extract_video_first_frame
from .workbench import WorkspaceService
from .workflow import WorkflowRequest


logger = logging.getLogger(__name__)
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}
ZIP_EXTS = {".zip"}
AUTO_DURATION_TEXTS = {"跳過", "自動", "auto", "AUTO"}
TG_PROMPT_PREVIEW_TIMEOUT_SECONDS = int(os.getenv("TG_PROMPT_PREVIEW_TIMEOUT_SECONDS") or "240")
TG_PROMPT_DISPLAY_TIMEOUT_SECONDS = int(os.getenv("TG_PROMPT_DISPLAY_TIMEOUT_SECONDS") or "45")
TEXT_TO_IMAGE_MAX_SEED = 2147483647
TEXT_TO_IMAGE_REROLL_RUNTIME_KEYS = (
    "comfy_workflow_source",
    "remote_comfy_gateway_url",
    "remote_comfy_gateway_token",
    "remote_comfy_workflow_mappings",
    "local_comfy_gateway_url",
    "local_comfy_gateway_token",
    "local_comfy_workflow_mappings",
)

DIGITAL_HUMAN_VIDEO_BUTTON = "數字人視頻生成"
DIGITAL_HUMAN_REALISTIC_BUTTON = "寫實帶貨視頻"
DIGITAL_HUMAN_LIVE_BUTTON = "直播口播視頻"
DIGITAL_HUMAN_PRODUCT_BUTTON = "產品展示視頻"
DIGITAL_HUMAN_CUSTOM_BUTTON = "自定義數字人要求"
ORAL_UPLOAD_BUTTON = DIGITAL_HUMAN_VIDEO_BUTTON
LEGACY_ORAL_UPLOAD_BUTTON = "口播數字人：上傳素材"
WORKFLOW_CONFIG_BUTTON = "查看後臺工作流配置"
IMAGE_WORKFLOW_BUTTON = "圖像生成"
TEXT_TO_IMAGE_BUTTON = "文生圖"
TEXT_TO_IMAGE_REROLL_IMAGE_BUTTON = "重新生成圖片"
TEXT_TO_IMAGE_CONTINUE_IMAGE_BUTTON = "繼續生成圖片"
MULTI_IMAGE_BUTTON = "多圖生成"
SINGLE_IMAGE_EDIT_BUTTON = "單圖編輯"
IMAGE_EDIT_BUTTON = "圖片編輯"
IMAGE_EDIT_CONTINUE_RESULT_BUTTON = "繼續編輯結果圖"
IMAGE_EDIT_RERUN_BUTTON = "重新生成圖片編輯"
FACE_SWAP_BUTTON = "人物換臉"
FACE_SWAP_UPSCALE_BUTTON = "增加解析度 2 倍"
FACE_SWAP_RERUN_BUTTON = "重新生成人物換臉"
IMAGE_REPLACE_BUTTON = "圖片替換"
VIDEO_GENERAL_EDIT_BUTTON = "圖生視頻"
PERSON_T2I_DEFAULT_BATCH_SIZE = 4
PERSON_T2I_TELEGRAM_RETURN_COUNT = 4
PERSON_T2I_AUTO_QA_MAX_ATTEMPTS = 4
LEGACY_IMAGE_WORKFLOW_BUTTON = "圖像編輯工作流"
LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON = "圖片生成工作流"
VIDEO_EDIT_BUTTON = "視頻生成"
MAIN_MENU_BUTTON = "返回主選單"
REPLACE_MODEL_WORKFLOW_BUTTON = "視頻模特替換"
LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON = "模特替換工作流"
REPLACE_PRODUCT_WORKFLOW_BUTTON = "視頻商品替換"
LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON = "商品替換工作流"
REPLACE_UNION_WORKFLOW_BUTTON = "聯合替換工作流"

LEGACY_UPLOAD_BUTTON = "上傳素材建立任務"
STATUS_BUTTON = "查看工作臺狀態"
WORKBENCH_BUTTON = "工作臺網址"
SET_SCRIPT_BUTTON = "設定預設文案"
RERUN_BUTTON = "重跑最近任務"
STOP_BUTTON = "強制停止目前任務"
TOOL_R18_PERSONA_BUTTON = '👤 æ\x88\x91ç\x9a\x84äººè¨\xad'
TOOL_R18_STATUS_BUTTON = '📊 æ\x8e\x92ç¨\x8bç\x8b\x80æ\x85\x8b'
TOOL_R18_SCHEDULE_BUTTON = '⏰ å®\x9aæ\x99\x82ä»»å\x8b\x99'
TOOL_R18_CLOUD_BUTTON = '📱 é\x9b²æ©\x9fç®¡ç\x90\x86'
TOOL_R18_STOP_BUTTON = '🛑 å¼·å\x88¶ä¸\xadæ\xad¢ç\x9b®å\x89\x8dä»»å\x8b\x99'

BUTTON_ALIASES = {
    "重新生成图片": TEXT_TO_IMAGE_REROLL_IMAGE_BUTTON,
    "繼續生成圖片": TEXT_TO_IMAGE_CONTINUE_IMAGE_BUTTON,
    "继续生成图片": TEXT_TO_IMAGE_CONTINUE_IMAGE_BUTTON,
    "数字人视频生成": DIGITAL_HUMAN_VIDEO_BUTTON,
    "數字人視頻生成": DIGITAL_HUMAN_VIDEO_BUTTON,
    "写实带货视频": DIGITAL_HUMAN_REALISTIC_BUTTON,
    "寫實帶貨視頻": DIGITAL_HUMAN_REALISTIC_BUTTON,
    "直播口播视频": DIGITAL_HUMAN_LIVE_BUTTON,
    "直播口播視頻": DIGITAL_HUMAN_LIVE_BUTTON,
    "产品展示视频": DIGITAL_HUMAN_PRODUCT_BUTTON,
    "產品展示視頻": DIGITAL_HUMAN_PRODUCT_BUTTON,
    "自定义数字人要求": DIGITAL_HUMAN_CUSTOM_BUTTON,
    "自定義數字人要求": DIGITAL_HUMAN_CUSTOM_BUTTON,
    "口播数字人：上传素材": LEGACY_ORAL_UPLOAD_BUTTON,
    "口播數字人：上傳素材": LEGACY_ORAL_UPLOAD_BUTTON,
    "上传素材建立任务": LEGACY_UPLOAD_BUTTON,
    "上傳素材建立任務": LEGACY_UPLOAD_BUTTON,
    "查看后台工作流配置": WORKFLOW_CONFIG_BUTTON,
    "查看後台工作流配置": WORKFLOW_CONFIG_BUTTON,
    "图像生成": IMAGE_WORKFLOW_BUTTON,
    "圖像生成": IMAGE_WORKFLOW_BUTTON,
    "图片生成": IMAGE_WORKFLOW_BUTTON,
    "圖片生成": IMAGE_WORKFLOW_BUTTON,
    "图像编辑": IMAGE_WORKFLOW_BUTTON,
    "圖像編輯": IMAGE_WORKFLOW_BUTTON,
    "文生图片": TEXT_TO_IMAGE_BUTTON,
    "文生圖片": TEXT_TO_IMAGE_BUTTON,
    "多图生成": MULTI_IMAGE_BUTTON,
    "多圖生成": MULTI_IMAGE_BUTTON,
    "单图编辑": SINGLE_IMAGE_EDIT_BUTTON,
    "單圖編輯": SINGLE_IMAGE_EDIT_BUTTON,
    "图片编辑": IMAGE_EDIT_BUTTON,
    "圖片編輯": IMAGE_EDIT_BUTTON,
    "繼續編輯結果圖": IMAGE_EDIT_CONTINUE_RESULT_BUTTON,
    "重新生成圖片編輯": IMAGE_EDIT_RERUN_BUTTON,
    "人物换脸": FACE_SWAP_BUTTON,
    "人物換臉": FACE_SWAP_BUTTON,
    "增加分辨率 2 倍": FACE_SWAP_UPSCALE_BUTTON,
    "增加解析度 2 倍": FACE_SWAP_UPSCALE_BUTTON,
    "重新生成人物换脸": FACE_SWAP_RERUN_BUTTON,
    "重新生成人物換臉": FACE_SWAP_RERUN_BUTTON,
    "图片替换": IMAGE_REPLACE_BUTTON,
    "圖片替換": IMAGE_REPLACE_BUTTON,
    "图像编辑工作流": LEGACY_IMAGE_WORKFLOW_BUTTON,
    "圖像編輯工作流": LEGACY_IMAGE_WORKFLOW_BUTTON,
    "图片生成工作流": LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON,
    "圖片生成工作流": LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON,
    "视频编辑": VIDEO_EDIT_BUTTON,
    "視頻編輯": VIDEO_EDIT_BUTTON,
    "视频生成": VIDEO_EDIT_BUTTON,
    "視頻生成": VIDEO_EDIT_BUTTON,
    "视频编辑任务": VIDEO_GENERAL_EDIT_BUTTON,
    "視頻編輯任務": VIDEO_GENERAL_EDIT_BUTTON,
    "图生视频": VIDEO_GENERAL_EDIT_BUTTON,
    "圖生視頻": VIDEO_GENERAL_EDIT_BUTTON,
    "返回主菜单": MAIN_MENU_BUTTON,
    "返回主菜單": MAIN_MENU_BUTTON,
    "返回主選單": MAIN_MENU_BUTTON,
    "视频模特替换": REPLACE_MODEL_WORKFLOW_BUTTON,
    "視頻模特替換": REPLACE_MODEL_WORKFLOW_BUTTON,
    "模特替换工作流": LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON,
    "模特替換工作流": LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON,
    "视频商品替换": REPLACE_PRODUCT_WORKFLOW_BUTTON,
    "視頻商品替換": REPLACE_PRODUCT_WORKFLOW_BUTTON,
    "商品替换工作流": LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON,
    "商品替換工作流": LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON,
    "联合替换工作流": REPLACE_UNION_WORKFLOW_BUTTON,
    "聯合替換工作流": REPLACE_UNION_WORKFLOW_BUTTON,
    "查看工作台状态": STATUS_BUTTON,
    "查看工作台狀態": STATUS_BUTTON,
    "工作台网址": WORKBENCH_BUTTON,
    "工作台網址": WORKBENCH_BUTTON,
    "设置预设文案": SET_SCRIPT_BUTTON,
    "設置預設文案": SET_SCRIPT_BUTTON,
    "設定預設文案": SET_SCRIPT_BUTTON,
    "重跑最近任务": RERUN_BUTTON,
    "重跑最近任務": RERUN_BUTTON,
    "强制停止当前任务": STOP_BUTTON,
    "強制停止目前任務": STOP_BUTTON,
    "強制停止當前任務": STOP_BUTTON,
    '📱 é\x9b²æ©\x9fç®¡ç\x90\x86': WORKBENCH_BUTTON,
    '????': WORKBENCH_BUTTON,
    '????': WORKBENCH_BUTTON,
    '⏰ å®\x9aæ\x99\x82ä»»å\x8b\x99': WORKBENCH_BUTTON,
    '????': WORKBENCH_BUTTON,
    '????': WORKBENCH_BUTTON,
    '👤 æ\x88\x91ç\x9a\x84äººè¨\xad': IMAGE_WORKFLOW_BUTTON,
    '????': IMAGE_WORKFLOW_BUTTON,
    '????': IMAGE_WORKFLOW_BUTTON,
    '🛑 å¼·å\x88¶ä¸\xadæ\xad¢ç\x9b®å\x89\x8dä»»å\x8b\x99': STOP_BUTTON,
    '????????': STOP_BUTTON,
    '????????': STOP_BUTTON,
    '📊 æ\x8e\x92ç¨\x8bç\x8b\x80æ\x85\x8b': STATUS_BUTTON,
    '????': STATUS_BUTTON,
    '????': STATUS_BUTTON,
}


async def _answer(message: Message, text: Any = "", *args: Any, reply_markup: Any | None = None, **kwargs: Any) -> Message:
    return await Message.answer(
        message,
        str(text or ""),
        *args,
        reply_markup=reply_markup,
        **kwargs,
    )

WORKFLOW_REFERENCE_BUTTONS = {
    WORKFLOW_CONFIG_BUTTON,
    IMAGE_WORKFLOW_BUTTON,
    LEGACY_IMAGE_WORKFLOW_BUTTON,
    LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON,
    REPLACE_MODEL_WORKFLOW_BUTTON,
    LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON,
    REPLACE_PRODUCT_WORKFLOW_BUTTON,
    LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON,
    REPLACE_UNION_WORKFLOW_BUTTON,
}


def _canonical_button_text(text: str) -> str:
    raw = str(text or "").strip()
    return BUTTON_ALIASES.get(raw, raw)


class _ThreadedResolverConnector(TCPConnector):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("resolver", ThreadedResolver())
        super().__init__(*args, **kwargs)


class ScriptForm(StatesGroup):
    waiting_for_script = State()


class UploadFlowForm(StatesGroup):
    waiting_for_custom_requirement = State()
    waiting_for_video = State()
    waiting_for_script = State()
    waiting_for_portrait_prompt = State()
    waiting_for_duration = State()


class ProductionWorkflowForm(StatesGroup):
    text_to_image_waiting_for_ratio = State()
    text_to_image_waiting_for_resolution = State()
    text_to_image_waiting_for_persona = State()
    text_to_image_waiting_for_prompt_mode = State()
    text_to_image_waiting_for_prompt = State()
    text_to_image_waiting_for_revision = State()
    text_to_image_waiting_for_custom_prompt = State()
    image_waiting_for_product_image = State()
    image_waiting_for_model_image = State()
    image_waiting_for_prompt = State()
    image_edit_waiting_for_image = State()
    image_edit_waiting_for_reference_image = State()
    image_edit_waiting_for_prompt_mode = State()
    image_edit_waiting_for_prompt = State()
    image_edit_waiting_for_confirm = State()
    face_swap_waiting_for_target_image = State()
    face_swap_waiting_for_source_image = State()
    face_swap_waiting_for_prompt = State()
    face_swap_waiting_for_confirm = State()
    video_i2v_waiting_for_resolution = State()
    video_i2v_waiting_for_duration = State()
    video_i2v_waiting_for_audio = State()
    video_i2v_waiting_for_prompt_mode = State()
    video_i2v_waiting_for_image = State()
    video_i2v_waiting_for_prompt = State()
    replace_model_waiting_for_video = State()
    replace_model_waiting_for_image = State()
    replace_model_waiting_for_prompt = State()
    replace_model_waiting_for_duration = State()
    replace_product_waiting_for_video = State()
    replace_product_waiting_for_image = State()
    replace_product_waiting_for_name = State()
    replace_product_waiting_for_prompt = State()
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
    if not proxy:
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
            [KeyboardButton(text=TOOL_R18_PERSONA_BUTTON), KeyboardButton(text=TOOL_R18_STATUS_BUTTON)],
            [KeyboardButton(text=TOOL_R18_SCHEDULE_BUTTON), KeyboardButton(text=TOOL_R18_CLOUD_BUTTON)],
            [KeyboardButton(text=TOOL_R18_STOP_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _image_edit_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=TEXT_TO_IMAGE_BUTTON), KeyboardButton(text=SINGLE_IMAGE_EDIT_BUTTON)],
            [KeyboardButton(text=IMAGE_EDIT_BUTTON), KeyboardButton(text=FACE_SWAP_BUTTON)],
            [KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _image_task_confirm_keyboard(submit_text: str) -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=submit_text)],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _image_edit_prompt_review_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="使用這個提示詞提交")],
            [KeyboardButton(text="輸入自定義提示詞提交")],
            [KeyboardButton(text="繼續讓 Grok 調整"), KeyboardButton(text="重新生成提示詞")],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _image_edit_prompt_failure_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="重新生成提示詞")],
            [KeyboardButton(text="輸入自定義提示詞提交")],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _image_edit_prompt_mode_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="讓 Grok 生成提示詞")],
            [KeyboardButton(text="輸入自定義提示詞")],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


FACE_SWAP_NATURAL_PROMPT = "自然換臉，保持原圖姿態、服裝、光線和背景，只替換人物臉部身份。"
KEEP_CURRENT_RESOURCE_BUTTON = "沿用目前資源"


def _face_swap_prompt_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="自然換臉")],
            [KeyboardButton(text="輸入自定義換臉要求")],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _recorded_local_resource(value: Any) -> bool:
    path = str(value or "").strip()
    return bool(path and Path(path).exists())


def _image_task_step_keyboard(*, back: bool = True, keep_current: bool = False) -> ReplyKeyboardMarkup:
    rows: list[list[KeyboardButton]] = []
    if keep_current:
        rows.append([KeyboardButton(text=KEEP_CURRENT_RESOURCE_BUTTON)])
    if back:
        rows.append([KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)])
    else:
        rows.append([KeyboardButton(text=MAIN_MENU_BUTTON)])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


TEXT_TO_IMAGE_RATIO_OPTIONS: dict[str, dict[str, Any]] = {
    "2:3": {"label": "2:3 豎圖", "note": "基礎豎圖", "width": 640, "height": 960, "final": "2176 x 3264"},
    "3:4": {"label": "3:4 穩定豎圖", "note": "穩定豎圖", "width": 672, "height": 896, "final": "2285 x 3046"},
    "9:16": {"label": "9:16 手機豎屏", "note": "手機豎屏長圖", "width": 576, "height": 1024, "final": "1958 x 3482"},
    "3:2": {"label": "3:2 橫圖", "note": "橫圖基準", "width": 960, "height": 640, "final": "3264 x 2176"},
    "4:3": {"label": "4:3 平衡橫圖", "note": "平衡橫圖", "width": 896, "height": 672, "final": "3046 x 2285"},
    "16:9": {"label": "16:9 寬屏", "note": "寬屏視頻", "width": 1024, "height": 576, "final": "3482 x 1958"},
    "1:1": {"label": "1:1 正方形", "note": "正方形", "width": 768, "height": 768, "final": "2611 x 2611"},
}


TEXT_TO_IMAGE_PERSON_T2I_RATIO_OPTIONS: dict[str, dict[str, Any]] = {
    "8:15": {"label": "基本比例", "note": "人設_t2i 基本比例", "width": 1024, "height": 1920, "final": "關閉"},
    "2:3": {"label": "2:3 基礎豎圖", "note": "人設_t2i 基礎豎圖", "width": 1024, "height": 1536, "final": "關閉"},
    "3:4": {"label": "3:4 穩定豎圖", "note": "人設_t2i 穩定豎圖", "width": 1024, "height": 1365, "final": "關閉"},
    "9:16": {"label": "9:16 手機豎屏長圖", "note": "人設_t2i 手機豎屏長圖", "width": 1024, "height": 1820, "final": "關閉"},
    "3:2": {"label": "3:2 橫圖基準", "note": "人設_t2i 橫圖基準", "width": 1536, "height": 1024, "final": "關閉"},
    "4:3": {"label": "4:3 平衡橫圖", "note": "人設_t2i 平衡橫圖", "width": 1365, "height": 1024, "final": "關閉"},
    "16:9": {"label": "16:9 寬屏視頻", "note": "人設_t2i 寬屏視頻", "width": 1820, "height": 1024, "final": "關閉"},
    "1:1": {"label": "1:1 正方形", "note": "人設_t2i 正方形", "width": 1024, "height": 1024, "final": "關閉"},
}


TEXT_TO_IMAGE_PERSON_T2I_PERSONA_LORA_NODE_INPUTS: dict[str, dict[str, Any]] = {
    "184": {
        "lora_name": r"Character Setting\人设1捞女1金君雅.safetensors",
        "strength_model": 0.8,
        "strength_clip": 1.0,
    }
}


TEXT_TO_IMAGE_PERSONA_LORA_NODE_INPUTS: dict[str, dict[str, Any]] = {
    "821": {
        "lora_1": {
            "on": True,
            "lora": r"Character Setting\人设1捞女1金君雅.safetensors",
            "strength": 1.0,
            "strengthTwo": None,
        }
    },
    "822": {
        "lora_1": {
            "on": True,
            "lora": r"Character Setting\人设1捞女1金君雅.safetensors",
            "strength": 0.3,
            "strengthTwo": None,
        }
    },
}


def _text_to_image_workflow_profile_from_path(value: Any) -> str:
    text = str(value or "").replace("\\", "/").lower()
    if "person_t2i" in text or "人设_t2i" in text or "人設_t2i" in text:
        return "person_t2i"
    return "person_t2i" if "person_t2i" in text or "人设_t2i" in text or "人設_t2i" in text else "zit_final"


def _text_to_image_profile(data: dict[str, Any] | None = None) -> str:
    source = data or {}
    explicit = str(source.get("text_to_image_workflow_profile") or "").strip().lower()
    if explicit:
        if explicit in {"person_t2i", "persona_t2i", "人设_t2i", "人設_t2i"}:
            return "person_t2i"
        return "person_t2i" if explicit in {"person_t2i", "persona_t2i", "人设_t2i", "人設_t2i"} else "zit_final"
    for key in ("text_to_image_workflow_path", "remote_comfy_workflow_path", "local_comfy_workflow_path"):
        profile = _text_to_image_workflow_profile_from_path(source.get(key))
        if profile == "person_t2i":
            return profile
    return "zit_final"


def _text_to_image_ratio_options(profile: str = "zit_final") -> dict[str, dict[str, Any]]:
    return TEXT_TO_IMAGE_PERSON_T2I_RATIO_OPTIONS if profile == "person_t2i" else TEXT_TO_IMAGE_RATIO_OPTIONS


def _text_to_image_final_resolution_available(profile: str = "zit_final") -> bool:
    return profile != "person_t2i"


def _text_to_image_persona_available(profile: str = "zit_final") -> bool:
    return bool(_text_to_image_persona_options(profile=profile))


def _text_to_image_persona_options(*, profile: str = "zit_final") -> list[dict[str, str]]:
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    if profile == "person_t2i":
        source_values = [{"lora": values.get("lora_name")} for values in TEXT_TO_IMAGE_PERSON_T2I_PERSONA_LORA_NODE_INPUTS.values()]
    else:
        source_values = []
        for values in TEXT_TO_IMAGE_PERSONA_LORA_NODE_INPUTS.values():
            if isinstance(values, dict):
                source_values.extend(value for value in values.values() if isinstance(value, dict))
    for lora_value in source_values:
        if not isinstance(lora_value, dict):
            continue
        path = str(lora_value.get("lora") or "").strip()
        if not path or path in seen:
            continue
        seen.add(path)
        label = Path(path.replace("\\", "/")).stem or path
        options.append({"id": str(len(options)), "label": label, "path": path})
    return options


def _text_to_image_persona_label(path: str | None, *, profile: str = "zit_final") -> str:
    target = str(path or "").strip()
    for option in _text_to_image_persona_options(profile=profile):
        if option["path"] == target:
            return option["label"]
    return Path(target.replace("\\", "/")).stem if target else ""


def _text_to_image_default_persona_path(*, profile: str = "zit_final") -> str:
    options = _text_to_image_persona_options(profile=profile)
    return options[0]["path"] if options else ""


def _text_to_image_persona_node_inputs(*, enabled: bool, persona_lora: str = "", profile: str = "zit_final") -> dict[str, dict[str, Any]]:
    node_inputs: dict[str, dict[str, Any]] = {}
    selected_lora = str(persona_lora or _text_to_image_default_persona_path(profile=profile)).strip()
    if profile == "person_t2i":
        for node_id, values in TEXT_TO_IMAGE_PERSON_T2I_PERSONA_LORA_NODE_INPUTS.items():
            lora_name = str(selected_lora or values.get("lora_name") or "").strip()
            if enabled and lora_name:
                node_inputs[node_id] = {
                    "lora_name": lora_name,
                    "strength_model": float(values.get("strength_model") or 0.8),
                    "strength_clip": float(values.get("strength_clip") or 1.0),
                }
            else:
                node_inputs[node_id] = {
                    "lora_name": str(values.get("lora_name") or lora_name),
                    "strength_model": 0.0,
                    "strength_clip": 0.0,
                }
        return node_inputs
    for node_id, values in TEXT_TO_IMAGE_PERSONA_LORA_NODE_INPUTS.items():
        lora_value = dict(values.get("lora_1") or {})
        if enabled and selected_lora:
            lora_value["on"] = True
            lora_value["lora"] = selected_lora
            node_inputs[node_id] = {"lora_1": lora_value}
        else:
            lora_value["on"] = False
            lora_value["strength"] = 0.0
            node_inputs[node_id] = {"lora_1": lora_value}
    return node_inputs


def _text_to_image_params(data: dict[str, Any] | None = None) -> dict[str, Any]:
    source = data or {}
    profile = _text_to_image_profile(source)
    ratio_options = _text_to_image_ratio_options(profile)
    default_ratio = next(iter(ratio_options.keys()))
    ratio = str(source.get("aspect_ratio") or default_ratio).strip()
    if ratio not in ratio_options:
        ratio = default_ratio
    option = dict(ratio_options[ratio])
    final_resolution_available = _text_to_image_final_resolution_available(profile)
    final_resolution_enabled = bool(source.get("final_resolution_enabled", False)) if final_resolution_available else False
    persona_available = _text_to_image_persona_available(profile)
    persona_enabled = bool(source.get("persona_enabled", True if persona_available else False))
    persona_lora = str(source.get("persona_lora") or _text_to_image_default_persona_path(profile=profile)).strip() if persona_available else ""
    return {
        "text_to_image_workflow_profile": profile,
        "aspect_ratio": ratio,
        "width": int(option["width"]),
        "height": int(option["height"]),
        "final": str(option["final"]),
        "label": str(option["label"]),
        "note": str(option["note"]),
        "final_resolution_available": final_resolution_available,
        "final_resolution_enabled": final_resolution_enabled,
        "persona_available": persona_available,
        "persona_enabled": bool(persona_enabled and persona_available),
        "persona_lora": persona_lora,
        "persona_label": _text_to_image_persona_label(persona_lora, profile=profile),
        "ratio_selected": bool(source.get("ratio_selected", False)),
        "resolution_selected": bool(source.get("resolution_selected", False)),
        "persona_selected": bool(source.get("persona_selected", False)),
        "prompt_mode_selected": bool(source.get("prompt_mode_selected", False)),
        "prompt_mode_label": str(source.get("prompt_mode_label") or "").strip(),
        "text_to_image_auto_qa_enabled": bool(source.get("text_to_image_auto_qa_enabled", False)),
    }


def _text_to_image_remote_node_inputs(params: dict[str, Any]) -> dict[str, Any]:
    profile = _text_to_image_profile(params)
    if profile == "person_t2i":
        node_inputs: dict[str, Any] = {
            "160": {"width": int(params["width"]), "height": int(params["height"]), "batch_size": PERSON_T2I_DEFAULT_BATCH_SIZE},
            "167": {
                "steps": 10,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
            },
            "171": {"filename_prefix": "telegram/person_t2i"},
        }
        return node_inputs
    detailer_inputs = {
        "guide_size": 512.0,
        "guide_size_for": True,
        "max_size": 1440.0,
        "steps": 4,
        "cfg": 1.0,
        "sampler_name": "dpmpp_2m_sde",
        "scheduler": "sgm_uniform",
        "denoise": 0.45,
        "feather": 100,
        "noise_mask": True,
        "force_inpaint": True,
        "wildcard": "",
        "cycle": 1,
        "inpaint_model": False,
        "noise_mask_feather": 20,
        "tiled_encode": False,
        "tiled_decode": False,
    }
    safe_save_prefixes = {
        "698": {"width": int(params["width"]), "height": int(params["height"]), "batch_size": 1},
        "715": {"filename_prefix": "telegram/ZIT_upscale"},
        "732": {"filename_prefix": "telegram/ZIT_blend"},
    }
    if bool(params.get("final_resolution_enabled")):
        node_inputs = {
            "647": {"scale_by": 1.7},
            "637": {"value": 2.0},
            "663": {
                "steps": 3,
                "cfg": 1.0,
                "sampler_name": "dpmpp_2m_sde",
                "scheduler": "sgm_uniform",
                "denoise": 0.23,
                "mode_type": "Linear",
                "mask_blur": 64,
                "tile_padding": 96,
                "seam_fix_mode": "None",
                "seam_fix_denoise": 1.0,
                "seam_fix_width": 64,
                "seam_fix_mask_blur": 8,
                "seam_fix_padding": 16,
                "force_uniform_tiles": True,
                "tiled_decode": False,
                "batch_size": 1,
            },
            "713": {
                "resolution": 1080,
                "color_correction": "lab",
                "offload_device": "cpu",
                "temporal_overlap": 0,
            },
            "789": {"image": ["663", 0], **detailer_inputs},
            "790": {"image": ["663", 0]},
            **safe_save_prefixes,
        }
    else:
        node_inputs = {
            "647": {"scale_by": 1.0},
            "637": {"value": 1.0},
            "663": {
                "steps": 3,
                "cfg": 1.0,
                "sampler_name": "dpmpp_2m_sde",
                "scheduler": "sgm_uniform",
                "denoise": 0.23,
                "mode_type": "Linear",
                "mask_blur": 64,
                "tile_padding": 96,
                "seam_fix_mode": "None",
                "seam_fix_denoise": 1.0,
                "seam_fix_width": 64,
                "seam_fix_mask_blur": 8,
                "seam_fix_padding": 16,
                "force_uniform_tiles": True,
                "tiled_decode": False,
                "batch_size": 1,
            },
            "789": {"image": ["663", 0], **detailer_inputs},
            "790": {"image": ["663", 0]},
            **safe_save_prefixes,
        }
    if _text_to_image_persona_available(profile):
        node_inputs.update(
            _text_to_image_persona_node_inputs(
                enabled=bool(params.get("persona_enabled")),
                persona_lora=str(params.get("persona_lora") or ""),
                profile=profile,
            )
        )
    return node_inputs


def _new_text_to_image_seed(excluded: set[int] | None = None) -> int:
    excluded = excluded or set()
    for _ in range(32):
        seed = secrets.randbelow(TEXT_TO_IMAGE_MAX_SEED) + 1
        if seed not in excluded:
            return seed
    seed = secrets.randbelow(TEXT_TO_IMAGE_MAX_SEED) + 1
    while seed in excluded:
        seed = 1 if seed >= TEXT_TO_IMAGE_MAX_SEED else seed + 1
    return seed


def _collect_text_to_image_seed_fields(value: Any) -> set[int]:
    seeds: set[int] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key) in {"seed", "noise_seed"}:
                try:
                    seeds.add(int(item))
                except Exception:
                    pass
            else:
                seeds.update(_collect_text_to_image_seed_fields(item))
    elif isinstance(value, list):
        for item in value:
            seeds.update(_collect_text_to_image_seed_fields(item))
    return seeds


def _replace_text_to_image_seed_fields(value: Any, seed: int) -> None:
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if str(key) in {"seed", "noise_seed"}:
                value[key] = int(seed)
            else:
                _replace_text_to_image_seed_fields(item, seed)
    elif isinstance(value, list):
        for item in value:
            _replace_text_to_image_seed_fields(item, seed)


def _text_to_image_reroll_payload(input_payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    payload = copy.deepcopy(input_payload if isinstance(input_payload, dict) else {})
    for key in TEXT_TO_IMAGE_REROLL_RUNTIME_KEYS:
        payload.pop(key, None)
    params = _text_to_image_params(payload)
    final_prompt = str(
        payload.get("prompt_text")
        or payload.get("prompt")
        or payload.get("message")
        or payload.get("tg_llm_rewritten_prompt")
        or ""
    ).strip()
    if not final_prompt:
        raise ValueError("上次任務沒有可複用的最終提示詞")

    node_inputs = payload.get("remote_comfy_node_inputs")
    if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i":
        node_inputs = _text_to_image_remote_node_inputs(params)
    elif not isinstance(node_inputs, dict) or not node_inputs:
        node_inputs = _text_to_image_remote_node_inputs(params)
    else:
        node_inputs = copy.deepcopy(node_inputs)

    excluded_seeds = _collect_text_to_image_seed_fields(node_inputs)
    try:
        excluded_seeds.add(int(payload.get("seed")))
    except Exception:
        pass
    seed = _new_text_to_image_seed(excluded_seeds)
    _replace_text_to_image_seed_fields(node_inputs, seed)
    payload.update(
        {
            "prompt": final_prompt,
            "prompt_text": final_prompt,
            "message": final_prompt,
            "width": params["width"],
            "height": params["height"],
            "aspect_ratio": params["aspect_ratio"],
            "batch_size": PERSON_T2I_DEFAULT_BATCH_SIZE if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "text_to_image_qa_target_count": PERSON_T2I_TELEGRAM_RETURN_COUNT if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "text_to_image_auto_qa_enabled": bool(params.get("text_to_image_auto_qa_enabled", False)),
            "text_to_image_auto_qa_max_attempts": PERSON_T2I_AUTO_QA_MAX_ATTEMPTS if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "final_resolution_enabled": bool(params["final_resolution_enabled"]),
            "persona_enabled": bool(params["persona_enabled"]),
            "persona_lora": str(params.get("persona_lora") or ""),
            "persona_label": str(params.get("persona_label") or ""),
            "tg_use_llm_prompt": False,
            "tg_llm_prompt_enhanced": True,
            "tg_llm_rewritten_prompt": final_prompt,
            "remote_comfy_node_inputs": node_inputs,
            "seed": seed,
        }
    )
    return payload, seed


def _text_to_image_continue_state_from_payload(input_payload: dict[str, Any]) -> dict[str, Any]:
    payload = copy.deepcopy(input_payload if isinstance(input_payload, dict) else {})
    params = _text_to_image_params(payload)
    final_prompt = str(
        payload.get("tg_llm_rewritten_prompt")
        or payload.get("prompt_text")
        or payload.get("prompt")
        or payload.get("message")
        or ""
    ).strip()
    original_request = str(
        payload.get("tg_original_prompt")
        or payload.get("tg_original_user_request")
        or payload.get("tg_user_instruction")
        or final_prompt
        or ""
    ).strip()
    reference_image = str(
        payload.get("prompt_reference_image_local_path")
        or payload.get("input_image_local_path")
        or payload.get("image_local_path")
        or ""
    ).strip()
    return {
        "aspect_ratio": params["aspect_ratio"],
        "width": params["width"],
        "height": params["height"],
        "final_resolution_enabled": bool(payload.get("final_resolution_enabled", params["final_resolution_enabled"])),
        "persona_available": bool(params["persona_available"]),
        "persona_enabled": bool(payload.get("persona_enabled", params["persona_enabled"])),
        "persona_lora": str(payload.get("persona_lora") or params.get("persona_lora") or ""),
        "persona_label": str(payload.get("persona_label") or params.get("persona_label") or ""),
        "text_to_image_workflow_profile": str(params.get("text_to_image_workflow_profile") or ""),
        "text_to_image_workflow_path": str(payload.get("text_to_image_workflow_path") or ""),
        "ratio_selected": True,
        "resolution_selected": True,
        "persona_selected": bool(params["persona_available"]),
        "prompt_mode_selected": False,
        "prompt_mode_label": "Grok 生成",
        "original_user_request": original_request,
        "last_grok_user_request": "",
        "last_grok_reference_image_path": reference_image,
        "prompt_reference_image_local_path": reference_image,
        "previous_final_prompt_text": final_prompt,
        "final_prompt_text": "",
        "selected_model": str(payload.get("tg_llm_selected_model") or "").strip(),
        "custom_prompt_used": bool(payload.get("custom_prompt_used")),
        "previous_prompt_display_text": str(payload.get("tg_prompt_display_text") or final_prompt).strip(),
        "prompt_display_text": "",
        "prompt_display_ready": False,
        "prompt_display_pending": False,
    }


def _text_to_image_status_text(*, step: str, params: dict[str, Any]) -> str:
    lines = ["文生圖設置", f"當前步驟：{step}"]
    if params.get("ratio_selected"):
        lines.append(f"畫面比例：{params['aspect_ratio']}（{params['note']}）")
        lines.append(f"基礎分辨率：{params['width']} x {params['height']}")
    if params.get("resolution_selected") and params.get("final_resolution_available"):
        final_resolution_text = "開啓，預計 " + params["final"] if params.get("final_resolution_enabled") else "關閉，使用基礎分辨率"
        lines.append(f"最終分辨率：{final_resolution_text}")
    if params.get("persona_selected"):
        if params.get("persona_enabled"):
            persona_text = params.get("persona_label") or "使用人設"
        elif params.get("persona_available"):
            persona_text = "不使用"
        else:
            persona_text = "當前工作流未檢測到可選人設"
        lines.append(f"人設 LoRA：{persona_text}")
    if params.get("prompt_mode_selected"):
        prompt_mode_text = str(params.get("prompt_mode_label") or "").strip()
        if prompt_mode_text:
            lines.append(f"提示詞方式：{prompt_mode_text}")
    return "\n".join(lines)


def _text_to_image_has_resolution_step(params: dict[str, Any]) -> bool:
    return bool(params.get("final_resolution_available"))


def _text_to_image_persona_step_text(params: dict[str, Any], *, prefix: str = "請選擇") -> str:
    return f"{'3/4' if _text_to_image_has_resolution_step(params) else '2/3'} {prefix}人設 LoRA"


def _text_to_image_prompt_mode_step_text(params: dict[str, Any], *, prefix: str = "請選擇") -> str:
    if params.get("persona_available"):
        step_no = "4/4" if _text_to_image_has_resolution_step(params) else "3/3"
    else:
        step_no = "3/3" if _text_to_image_has_resolution_step(params) else "2/2"
    return f"{step_no} {prefix}提示詞方式"


def _text_to_image_prompt_entry_step_text(params: dict[str, Any], *, custom: bool = False) -> str:
    if params.get("persona_available"):
        step_no = "4/4" if _text_to_image_has_resolution_step(params) else "3/3"
    else:
        step_no = "3/3" if _text_to_image_has_resolution_step(params) else "2/2"
    return f"{step_no} 請輸入{'自定義最終提示詞' if custom else '圖片需求或上傳參考圖'}"


def _text_to_image_ratio_keyboard(*, selected_ratio: str = "", profile: str = "zit_final", qa_enabled: bool = False) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    items = list(_text_to_image_ratio_options(profile).items())
    for idx in range(0, len(items), 2):
        row: list[InlineKeyboardButton] = []
        for ratio, option in items[idx : idx + 2]:
            prefix = "✓ " if ratio == selected_ratio else ""
            row.append(InlineKeyboardButton(text=f"{prefix}{option['label']}", callback_data=f"t2i:ratio:{ratio}"))
        rows.append(row)
    rows.append([InlineKeyboardButton(text="✅ QA 審查：開啟" if qa_enabled else "☑️ QA 審查：關閉", callback_data="t2i:qa:toggle")])
    rows.append([InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _text_to_image_resolution_keyboard(
    *,
    final_resolution_enabled: bool = False,
    selected: bool = False,
    final_resolution_available: bool = True,
) -> InlineKeyboardMarkup:
    rows = [
        [
            InlineKeyboardButton(
                text=f"{'✓ ' if selected and not final_resolution_enabled else ''}使用基礎分辨率",
                callback_data="t2i:final:off",
            )
        ],
    ]
    if final_resolution_available:
        rows.append(
            [
                InlineKeyboardButton(
                    text=f"{'✓ ' if selected and final_resolution_enabled else ''}開啓最終分辨率",
                    callback_data="t2i:final:on",
                )
            ]
        )
    rows.append([InlineKeyboardButton(text="上一步", callback_data="t2i:back:ratio")])
    rows.append([InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _text_to_image_persona_keyboard(*, persona_enabled: bool = True, persona_lora: str = "", selected: bool = False, profile: str = "zit_final") -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    selected_lora = str(persona_lora or "").strip()
    for option in _text_to_image_persona_options(profile=profile):
        prefix = "✓ " if selected and persona_enabled and option["path"] == selected_lora else ""
        rows.append([InlineKeyboardButton(text=f"{prefix}{option['label']}", callback_data=f"t2i:persona:{option['id']}")])
    rows.append([InlineKeyboardButton(text=f"{'✓ ' if selected and not persona_enabled else ''}不使用人設", callback_data="t2i:persona:off")])
    rows.append(
        [
            InlineKeyboardButton(text="上一步", callback_data="t2i:back:resolution"),
        ]
    )
    rows.append([InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _text_to_image_prompt_mode_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="讓 Grok 生成提示詞", callback_data="t2i:ready_prompt")],
            [InlineKeyboardButton(text="輸入自定義提示詞", callback_data="t2i:custom_prompt")],
            [InlineKeyboardButton(text="上一步", callback_data="t2i:back:persona")],
            [InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")],
        ]
    )


def _text_to_image_prompt_entry_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="上一步", callback_data="t2i:back:prompt_mode")],
            [InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")],
        ]
    )


def _text_to_image_prompt_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="使用這個提示詞生成", callback_data="t2i:submit")],
            [InlineKeyboardButton(text="輸入自定義提示詞提交", callback_data="t2i:custom_prompt")],
            [InlineKeyboardButton(text="繼續讓 Grok 調整", callback_data="t2i:adjust")],
            [InlineKeyboardButton(text="重新生成提示詞", callback_data="t2i:regen")],
            [InlineKeyboardButton(text="返回參數設定", callback_data="t2i:settings"), InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")],
        ]
    )


def _text_to_image_prompt_failure_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="重新生成提示詞", callback_data="t2i:regen")],
            [InlineKeyboardButton(text="輸入自定義提示詞", callback_data="t2i:custom_prompt")],
            [InlineKeyboardButton(text="上一步", callback_data="t2i:back:prompt_mode")],
            [InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")],
        ]
    )


def _text_to_image_prompt_display_retry_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="重新生成中文預覽", callback_data="t2i:retry_display")],
            [InlineKeyboardButton(text="重新生成提示詞", callback_data="t2i:regen")],
            [InlineKeyboardButton(text="輸入自定義提示詞", callback_data="t2i:custom_prompt")],
            [InlineKeyboardButton(text="返回主選單", callback_data="t2i:main_menu")],
        ]
    )


def _text_to_image_ratio_reply_keyboard(*, profile: str = "zit_final", qa_enabled: bool = False) -> ReplyKeyboardMarkup:
    items = [str(option["label"]) for option in _text_to_image_ratio_options(profile).values()]
    rows = [
        [KeyboardButton(text=items[idx]), KeyboardButton(text=items[idx + 1])]
        for idx in range(0, len(items) - 1, 2)
    ]
    if len(items) % 2:
        rows.append([KeyboardButton(text=items[-1])])
    rows.append([KeyboardButton(text="✅ QA 審查：開啟" if qa_enabled else "☑️ QA 審查：關閉")])
    rows.append([KeyboardButton(text=MAIN_MENU_BUTTON)])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def _text_to_image_resolution_reply_keyboard(*, final_resolution_available: bool = True) -> ReplyKeyboardMarkup:
    rows = [[KeyboardButton(text="使用基礎分辨率")]]
    if final_resolution_available:
        rows.append([KeyboardButton(text="開啓最終分辨率")])
    rows.append([KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def _text_to_image_persona_reply_keyboard(*, profile: str = "zit_final") -> ReplyKeyboardMarkup:
    rows = [[KeyboardButton(text=str(option["label"]))] for option in _text_to_image_persona_options(profile=profile)]
    rows.append([KeyboardButton(text="不使用人設")])
    rows.append([KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True)


def _text_to_image_prompt_mode_reply_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="讓 Grok 生成提示詞")],
            [KeyboardButton(text="輸入自定義提示詞")],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _text_to_image_prompt_entry_reply_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _text_to_image_prompt_reply_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="使用這個提示詞生成")],
            [KeyboardButton(text="輸入自定義提示詞提交")],
            [KeyboardButton(text="繼續讓 Grok 調整"), KeyboardButton(text="重新生成提示詞")],
            [KeyboardButton(text="返回參數設定"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _text_to_image_prompt_failure_reply_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="重新生成提示詞")],
            [KeyboardButton(text="輸入自定義提示詞")],
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _format_grok_preview_error(exc: Exception) -> str:
    if isinstance(exc, asyncio.TimeoutError):
        return f"Grok 響應超時（超過 {TG_PROMPT_PREVIEW_TIMEOUT_SECONDS} 秒）。可以點擊“重新生成提示詞”再試一次，或先輸入自定義提示詞。"
    text = str(exc or "").strip()
    lower_text = text.lower()
    if "read timed out" in lower_text or "read timeout" in lower_text or "timed out" in lower_text:
        return "Grok 模型響應超時，上游接口長時間沒有返回。可以點擊“重新生成提示詞”再試一次，或先輸入自定義提示詞。"
    if "http 502" in lower_text and ("全部候選模型調用失敗" in text or "connectionpool" in lower_text):
        return "Grok 模型服務暫時不可用或響應超時。可以點擊“重新生成提示詞”再試一次，或先輸入自定義提示詞。"
    if not text:
        return f"Grok 提示詞生成失敗（{type(exc).__name__}）。可以點擊“重新生成提示詞”再試一次。"
    return _format_tg_user_error(text)


def _format_tg_user_error(error: Any) -> str:
    text = str(error or "").strip()
    text = re.sub(r"工作臺[:：]\s*https?://\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bfor url:\s*https?://\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\burl:\s*https?://\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"https?://\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:/[^\s，。；;]*)?", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" ：:，,。；;") or "未知錯誤"


def _video_edit_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=VIDEO_GENERAL_EDIT_BUTTON)],
            [KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _video_i2v_prompt_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _video_i2v_prompt_review_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="使用這個提示詞生成")],
            [KeyboardButton(text="輸入自定義提示詞提交")],
            [KeyboardButton(text="繼續讓 Grok 調整"), KeyboardButton(text="重新生成提示詞")],
            [KeyboardButton(text="返回參數設定"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _video_i2v_prompt_failure_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="重新生成提示詞")],
            [KeyboardButton(text="輸入自定義提示詞提交")],
            [KeyboardButton(text="返回參數設定"), KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _video_i2v_audio_keyboard(*, keep_current: bool = False) -> ReplyKeyboardMarkup:
    rows: list[list[KeyboardButton]] = []
    if keep_current:
        rows.append([KeyboardButton(text=KEEP_CURRENT_RESOURCE_BUTTON)])
    rows.append([KeyboardButton(text="跳過音頻")])
    rows.append([KeyboardButton(text="上一步"), KeyboardButton(text=MAIN_MENU_BUTTON)])
    return ReplyKeyboardMarkup(
        keyboard=rows,
        resize_keyboard=True,
    )


def _digital_human_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=DIGITAL_HUMAN_REALISTIC_BUTTON), KeyboardButton(text=DIGITAL_HUMAN_LIVE_BUTTON)],
            [KeyboardButton(text=DIGITAL_HUMAN_PRODUCT_BUTTON), KeyboardButton(text=DIGITAL_HUMAN_CUSTOM_BUTTON)],
            [KeyboardButton(text=MAIN_MENU_BUTTON)],
        ],
        resize_keyboard=True,
    )


def _message_text(message: Message) -> str:
    return (message.text or message.caption or "").strip()


def _telegram_prompt_chinese_preview(prompt_text: str) -> str:
    text = str(prompt_text or "").strip()
    if not text:
        return ""
    phrase_map = [
        ("a half body portrait", "半身人像構圖"),
        ("a full body portrait", "全身人像構圖"),
        ("half body portrait", "半身人像構圖"),
        ("full body portrait", "全身人像構圖"),
        ("full body composition", "全身構圖"),
        ("half body composition", "半身構圖"),
        ("full body visible", "全身可見"),
        ("head and face clearly unobstructed", "頭部和臉部無遮擋、清晰可見"),
        ("face clearly visible", "臉部清晰可見"),
        ("head fully in frame", "頭部完整入鏡"),
        ("facing the viewer", "面向觀看者"),
        ("facing the camera", "面向鏡頭"),
        ("eyes looking at the camera", "視線看向鏡頭"),
        ("looking at the camera", "看向鏡頭"),
        ("direct eye contact", "直視鏡頭"),
        ("mouth slightly open", "嘴部微張"),
        ("natural expression", "自然表情"),
        ("neutral expression", "自然平靜的表情"),
        ("soft indoor light", "柔和室內光線"),
        ("soft warm bedroom lighting", "柔和暖色臥室光線"),
        ("soft side light", "柔和側光"),
        ("side lamps", "側邊檯燈"),
        ("warm bedside light", "暖色牀頭燈"),
        ("shallow depth of field", "淺景深"),
        ("realistic skin texture", "真實皮膚紋理"),
        ("natural fabric folds", "自然布料褶皺"),
        ("fabric folds", "布料褶皺"),
        ("body curves", "身體曲線"),
        ("subtle shadows on curves", "身體曲線帶有細膩陰影"),
        ("stable anatomy", "人體結構穩定"),
        ("high quality photography", "高質量攝影質感"),
        ("high resolution", "高分辨率"),
        ("intricate details", "細節豐富"),
        ("masterpiece", "高完成度畫面"),
        ("best quality", "最佳畫質"),
        ("cinematic lighting", "電影感光線"),
        ("photorealistic", "真實攝影風格"),
        ("realistic", "寫實風格"),
        ("luxurious bedroom", "豪華臥室"),
        ("bedroom", "臥室"),
        ("indoor", "室內"),
        ("studio", "棚拍空間"),
        ("camera", "鏡頭"),
        ("front facing", "正面朝向"),
        ("body facing the camera", "身體朝向鏡頭"),
        ("body slightly angled but fully framed", "身體輕微側向但完整入鏡"),
        ("wearing a", "穿着"),
        ("wearing", "穿着"),
        ("with", ""),
        ("from", "來自"),
        ("hands placed", "手部放置"),
        ("hands resting", "雙手自然放置"),
        ("one hand", "一隻手"),
        ("both hands", "雙手"),
        ("partially open", "半開狀態"),
        ("silk blouse", "絲質上衣"),
        ("short tight skirt", "短款緊身裙"),
        ("button undone", "紐扣解開"),
        ("buttons undone", "紐扣解開"),
        ("clothing naturally loosened", "服裝自然鬆開"),
        ("unbuttoned", "紐扣解開"),
        ("zipper loosened", "拉鍊鬆開"),
        ("hem lifted", "衣襬掀起"),
        ("skirt lifted", "裙襬上移"),
        ("skirt moved upward", "裙襬上移"),
        ("shoulder strap slipped", "肩帶滑落"),
        ("waistband pulled down", "腰頭下拉"),
        ("clear clothing state", "衣物狀態清晰"),
        ("detailed composition", "構圖細節清晰"),
        ("soft background", "柔和背景"),
        ("clean background", "乾淨背景"),
        ("natural pose", "自然姿態"),
        ("standing", "站立"),
        ("slightly parted", "輕微分開"),
        ("legs slightly parted", "雙腿輕微分開"),
        ("inner thighs", "大腿內側"),
        ("standing pose", "站立姿態"),
        ("sitting pose", "坐姿"),
        ("kneeling pose", "跪姿"),
        ("lying pose", "躺姿"),
    ]
    clauses = [part.strip(" ,.;:\n\t") for part in re.split(r"[,;]\s*", text) if part.strip(" ,.;:\n\t")]
    rendered: list[str] = []
    for clause in clauses:
        item = clause
        for source, target in phrase_map:
            item = re.sub(re.escape(source), target, item, flags=re.IGNORECASE)
        item = re.sub(r"^(?:a|an|the)\s+", "", item, flags=re.IGNORECASE)
        item = re.sub(r"\s{2,}", " ", item).strip(" ,.;:\n\t")
        rendered.append(item)
    return "，".join(rendered).strip("，。；、,.;\n\t ")


def _looks_like_clean_chinese_preview(prompt_text: str) -> bool:
    text = str(prompt_text or "")
    cjk_chars = re.findall(r"[一-鿿]", text)
    english_words = re.findall(r"[A-Za-z][A-Za-z'-]{1,}", text)
    return len(cjk_chars) >= 6 and not english_words


def _tg_prompt_preview_unavailable_text() -> str:
    return "提示詞預覽暫時不可用，實際提交到後臺的原提示詞已保存。"


def _format_prompt_display_fallback(exc: Exception | None = None) -> str:
    text = str(exc or "").strip().lower()
    if isinstance(exc, asyncio.TimeoutError) or "timed out" in text or "timeout" in text or "超時" in text or "504" in text:
        return "提示詞預覽生成超時，實際提交到後臺的提示詞已保存，可直接使用。"
    return _tg_prompt_preview_unavailable_text()


def _chat_identity_text(message: Message) -> str:
    user = message.from_user
    username = f"@{user.username}" if user and user.username else ""
    user_id = int(user.id) if user and getattr(user, "id", None) is not None else None
    full_name = " ".join(
        part for part in [getattr(user, "first_name", "") if user else "", getattr(user, "last_name", "") if user else ""] if part
    ).strip()
    lines = [
        "你的 Telegram 身份信息：",
        f"chat_id: {int(message.chat.id)}",
    ]
    if user_id is not None and user_id != int(message.chat.id):
        lines.append(f"user_id: {user_id}")
    if username:
        lines.append(f"username: {username}")
    if full_name:
        lines.append(f"name: {full_name}")
    lines.extend(
        [
            "",
            "私聊機器人時請添加 chat_id；在羣裏使用時可以添加 user_id 或羣 chat_id。不要填寫機器人 ID。",
        ]
    )
    return "\n".join(lines)


def _message_authorization_ids(message: Message) -> list[int]:
    ids: list[int] = []
    try:
        ids.append(int(message.chat.id))
    except (AttributeError, TypeError, ValueError):
        pass
    user = getattr(message, "from_user", None)
    try:
        user_id = int(user.id) if user and getattr(user, "id", None) is not None else None
    except (TypeError, ValueError):
        user_id = None
    if user_id is not None and user_id not in ids:
        ids.append(user_id)
    return ids


def _is_message_authorized(service: WorkspaceService, message: Message) -> bool:
    return any(service.is_chat_authorized(candidate) for candidate in _message_authorization_ids(message))


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


def _runtime_text_to_image_workflow_path(runtime: dict[str, Any] | None) -> str:
    source = str((runtime or {}).get("comfy_workflow_source") or "remote").strip().lower()
    mappings_key = "local_comfy_workflow_mappings" if source == "local" else "remote_comfy_workflow_mappings"
    mappings = (runtime or {}).get(mappings_key)
    if not isinstance(mappings, dict):
        mappings = {}
    value = mappings.get("text_to_image") or mappings.get("default") or ""
    return str(value or "").strip()


def _text_to_image_runtime_params(runtime: dict[str, Any] | None) -> dict[str, Any]:
    workflow_path = _runtime_text_to_image_workflow_path(runtime)
    workflow_profile = _text_to_image_workflow_profile_from_path(workflow_path)
    params = _text_to_image_params(
        {
            "text_to_image_workflow_profile": workflow_profile,
            "text_to_image_workflow_path": workflow_path,
        }
    )
    params["text_to_image_workflow_path"] = workflow_path
    return params


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


def _runtime_mapped_workflow(runtime: dict[str, Any], task_type: str) -> str:
    source = str((runtime or {}).get("comfy_workflow_source") or "remote").strip().lower()
    mappings_key = "local_comfy_workflow_mappings" if source == "local" else "remote_comfy_workflow_mappings"
    mappings = runtime.get(mappings_key)
    if not isinstance(mappings, dict):
        return ""
    value = mappings.get(task_type)
    if value is None and str(task_type or "").strip() == "single_image_edit":
        value = mappings.get("get_nano_banana")
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return str(value.get("workflow") or value.get("path") or value.get("value") or "").strip()
    return ""


def _format_mapping(label: str, workflow_path: str) -> str:
    text = str(workflow_path or "").strip()
    return f"{label}: {text or '未配置'}"


def _workflow_config_text(service: WorkspaceService, selected_button: str = "") -> str:
    selected_button = _canonical_button_text(selected_button)
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
    image_edit_workflow = _runtime_mapped_workflow(runtime, "get_nano_banana")
    face_swap_workflow = _runtime_mapped_workflow(runtime, "face_swap")
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
    selected_note = ""
    legacy_button_labels = {
        LEGACY_IMAGE_WORKFLOW_BUTTON: IMAGE_WORKFLOW_BUTTON,
        LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON: IMAGE_WORKFLOW_BUTTON,
        LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON: REPLACE_MODEL_WORKFLOW_BUTTON,
        LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON: REPLACE_PRODUCT_WORKFLOW_BUTTON,
    }
    display_selected_button = legacy_button_labels.get(selected_button, selected_button)
    if display_selected_button and display_selected_button != WORKFLOW_CONFIG_BUTTON:
        selected_note = f"你選擇的是「{display_selected_button}」。"

    if display_selected_button and display_selected_button != WORKFLOW_CONFIG_BUTTON:
        selected_map = {
            IMAGE_WORKFLOW_BUTTON: _format_chain("圖像生成", image_chain),
            REPLACE_MODEL_WORKFLOW_BUTTON: _format_chain("視頻模特替換", replace_model_original_chain),
            SINGLE_IMAGE_EDIT_BUTTON: _format_mapping("單圖編輯", image_edit_workflow),
            IMAGE_EDIT_BUTTON: _format_mapping("圖片編輯", image_edit_workflow),
            FACE_SWAP_BUTTON: _format_mapping("人物換臉", face_swap_workflow),
        }
        return "\n".join(
            [
                f"你選擇的是「{display_selected_button}」。",
                selected_map.get(display_selected_button, "").strip(),
                "",
                "這是生產工作流入口。",
                "請按面板提示依序上傳素材；提交後可按「查看工作臺狀態」跟進進度。",
                f"工作臺網址: {config.public_base_url}",
            ]
        ).strip()

    return "\n".join(
        [
            "後臺工作流配置：",
            _format_chain("口播數字人工作流", oral_chain),
            _format_chain("圖像生成", image_chain),
            _format_mapping("單圖編輯", image_edit_workflow),
            _format_mapping("圖片編輯", image_edit_workflow),
            _format_mapping("人物換臉", face_swap_workflow),
            _format_chain("視頻模特替換", replace_model_original_chain),
            "",
            selected_note,
            "TG 面板可直接建立任務：圖像生成、圖片編輯、人物換臉、視頻生成。",
            f"工作臺網址: {config.public_base_url}",
        ]
    ).strip()


def _quick_start_text(service: WorkspaceService) -> str:
    return "\n".join(
        [
            f"🌟 {service.get_app_title()} 已啓動",
            "",
            "🌟 可用工作流",
            f"1. {IMAGE_WORKFLOW_BUTTON}",
            "   點擊後選擇文生圖、圖片編輯或人物換臉。",
            f"2. {VIDEO_EDIT_BUTTON}",
            "   點擊後選擇圖生視頻，可用按鈕設置分辨率、時長、音頻和提示詞。",
            "",
            "🌟 直接對話",
            "也可以傳送 /status 查看後臺任務進度，傳送 /stop 停止當前任務。",
            "",
            "🌟 常用操作",
            f"- {RERUN_BUTTON}：重跑最近一次任務。",
            f"- {STATUS_BUTTON}：查看任務進度。",
            f"- {STOP_BUTTON} 或 /stop：強制停止目前任務。",
            "",
            "✨ 詳細執行紀錄請到工作臺任務詳情查看。",
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
    if message.document:
        suffix = Path(message.document.file_name or "").suffix.lower()
        if suffix in ZIP_EXTS:
            return suffix, "zip"
    return None


def _parse_duration_seconds(text: str) -> int | None:
    value = str(text or "").strip()
    if not value:
        raise ValueError("秒數不能爲空")
    if value in AUTO_DURATION_TEXTS:
        return None
    seconds = math.ceil(float(value))
    if seconds <= 0:
        raise ValueError("秒數必須大於 0")
    return seconds


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
        raise RuntimeError("這則訊息沒有可下載的媒體文件")
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


def _fetch_webapp_runtime_config() -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/runtime_config"
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read().decode("utf-8", errors="replace")
    data = json.loads(body)
    if not isinstance(data, dict):
        return {}
    runtime = data.get("runtime_config")
    return runtime if isinstance(runtime, dict) else {}


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
    async with ClientSession() as session:
        async with session.post(
            url,
            json={"task_type": str(task_type), "tg_chat_id": int(chat_id), "params": dict(params or {})},
            headers=headers,
            timeout=30,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"後臺任務提交失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺任務提交返回非 JSON: {body[:300]}") from exc
    if not isinstance(data, dict) or not data.get("id"):
        raise RuntimeError(f"後臺任務提交返回缺少任務 ID: {data}")
    return data


async def _preview_internal_webapp_prompt(
    *,
    chat_id: int,
    task_type: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/prompt_preview"
    data: dict[str, Any] | None = None
    last_client_error: ClientError | None = None
    for attempt in range(1, 4):
        try:
            async with ClientSession() as session:
                async with session.post(
                    url,
                    json={"task_type": str(task_type), "tg_chat_id": int(chat_id), "params": dict(params or {})},
                    headers=headers,
                    timeout=TG_PROMPT_PREVIEW_TIMEOUT_SECONDS,
                ) as response:
                    body = await response.text()
                    if response.status >= 400:
                        detail = ""
                        try:
                            error_data = json.loads(body)
                            if isinstance(error_data, dict):
                                detail = str(
                                    error_data.get("detail")
                                    or error_data.get("message")
                                    or error_data.get("error")
                                    or ""
                                ).strip()
                        except json.JSONDecodeError:
                            detail = ""
                        raise RuntimeError(
                            f"後臺 Grok 提示詞生成失敗 HTTP {response.status}: {(detail or body)[:500]}"
                        )
                    try:
                        data = json.loads(body)
                    except json.JSONDecodeError as exc:
                        raise RuntimeError(f"後臺 Grok 提示詞生成返回非 JSON: {body[:300]}") from exc
                    break
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"後臺 Grok 提示詞生成超時（超過 {TG_PROMPT_PREVIEW_TIMEOUT_SECONDS} 秒）。"
                "通常是 Grok 響應慢、供應商排隊，或提示詞被二次校驗重試拖長。"
            ) from exc
        except ClientError as exc:
            last_client_error = exc
            if attempt >= 3:
                raise RuntimeError(f"連接後臺 Grok 提示詞服務失敗：{exc}") from exc
            await asyncio.sleep(0.8 * attempt)
    if data is None:
        raise RuntimeError(f"連接後臺 Grok 提示詞服務失敗：{last_client_error}")
    if not isinstance(data, dict):
        raise RuntimeError(f"後臺 Grok 提示詞生成返回格式異常: {data}")
    prompt_text = str(data.get("prompt_text") or "").strip()
    if not prompt_text:
        raise RuntimeError("Grok 未返回可用提示詞")
    return data


async def _display_internal_webapp_prompt(
    *,
    chat_id: int,
    task_type: str,
    prompt_text: str,
) -> str:
    prompt_text = str(prompt_text or "").strip()
    if not prompt_text:
        return ""
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/prompt_display"
    async with ClientSession() as session:
        async with session.post(
            url,
            json={"task_type": str(task_type), "tg_chat_id": int(chat_id), "prompt_text": prompt_text},
            headers=headers,
            timeout=TG_PROMPT_DISPLAY_TIMEOUT_SECONDS,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"後臺提示詞中文預覽失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺提示詞中文預覽返回非 JSON: {body[:300]}") from exc
    if not isinstance(data, dict):
        return ""
    display_text = str(data.get("display_text") or "").strip()
    if display_text and not _looks_like_clean_chinese_preview(display_text):
        raise RuntimeError("後臺提示詞中文預覽包含英文殘留")
    return display_text


async def _send_long_text(message: Message, text: str, *, reply_markup: Any | None = None) -> None:
    body = str(text or "")
    if len(body) <= 3900:
        await _answer(message, body, reply_markup=reply_markup)
        return
    chunks = [body[idx : idx + 3900] for idx in range(0, len(body), 3900)]
    for idx, chunk in enumerate(chunks):
        await _answer(message, chunk, reply_markup=reply_markup if idx == len(chunks) - 1 else None)


async def _send_transient_status(message: Message, text: str) -> Message | None:
    try:
        return await _answer(message, text)
    except Exception:
        return None


async def _delete_message_silently(message: Message | None) -> None:
    if message is None:
        return
    try:
        await message.delete()
    except Exception:
        pass


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
                raise RuntimeError(f"後臺智能提交失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺智能提交返回非 JSON: {body[:300]}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"後臺智能提交返回格式異常: {data}")
    if data.get("submitted") is False:
        return data
    if not data.get("id"):
        raise RuntimeError(f"後臺智能提交返回缺少任務 ID: {data}")
    return data


async def _fetch_internal_webapp_tg_tasks(*, chat_id: int, limit: int = 5) -> list[dict[str, Any]]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/tasks"
    async with ClientSession() as session:
        async with session.get(
            url,
            params={"chat_id": int(chat_id), "limit": int(limit or 5)},
            headers=headers,
            timeout=20,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"後臺 TG 任務查詢失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺 TG 任務查詢返回非 JSON: {body[:300]}") from exc
    tasks = data.get("tasks") if isinstance(data, dict) else None
    return [item for item in tasks if isinstance(item, dict)] if isinstance(tasks, list) else []


async def _fetch_internal_webapp_tg_status(*, chat_id: int) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/status"
    async with ClientSession() as session:
        async with session.get(
            url,
            params={"chat_id": int(chat_id)},
            headers=headers,
            timeout=20,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"後臺 TG 狀態查詢失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺 TG 狀態查詢返回非 JSON: {body[:300]}") from exc
    return data if isinstance(data, dict) else {}


async def _cancel_latest_internal_webapp_tg_task(*, chat_id: int) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    url = f"{_internal_webapp_base_url()}/api/internal/tg/tasks/cancel_latest"
    async with ClientSession() as session:
        async with session.post(
            url,
            params={"chat_id": int(chat_id)},
            headers=headers,
            timeout=20,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"後臺 TG 任務停止失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺 TG 任務停止返回非 JSON: {body[:300]}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"後臺 TG 任務停止格式異常: {data}")
    return data


async def _fetch_internal_webapp_tg_task_detail(*, chat_id: int, task_id: str) -> dict[str, Any]:
    headers: dict[str, str] = {}
    token = str(os.getenv("TG_INTERNAL_API_TOKEN") or "").strip()
    if token:
        headers["x-tg-internal-token"] = token
    tid = str(task_id or "").strip()
    url = f"{_internal_webapp_base_url()}/api/internal/tg/tasks/{tid}"
    async with ClientSession() as session:
        async with session.get(
            url,
            params={"chat_id": int(chat_id)},
            headers=headers,
            timeout=20,
        ) as response:
            body = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"後臺 TG 任務詳情查詢失敗 HTTP {response.status}: {body[:500]}")
            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"後臺 TG 任務詳情返回非 JSON: {body[:300]}") from exc
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict):
        raise RuntimeError(f"後臺 TG 任務詳情格式異常: {data}")
    return task


def _format_internal_webapp_tg_tasks(tasks: list[dict[str, Any]]) -> str:
    if not tasks:
        return "後臺生成任務：暫無記錄。"
    status_labels = {
        "queued": "排隊中",
        "running": "生成中",
        "success": "已完成",
        "failed": "失敗",
        "cancelled": "已取消",
    }
    lines = ["後臺生成任務："]
    for item in tasks[:5]:
        status = str(item.get("status") or "").strip()
        label = status_labels.get(status, status or "unknown")
        download = "，有結果文件" if item.get("has_download") else ""
        error = _format_tg_user_error(item.get("error") or "")
        if len(error) > 80:
            error = f"{error[:80]}..."
        event = item.get("latest_event") if isinstance(item.get("latest_event"), dict) else {}
        event_message = str(event.get("message") or "").strip()
        event_data = event.get("data") if isinstance(event.get("data"), dict) else {}
        queue_parts: list[str] = []
        if isinstance(event_data, dict):
            if event_data.get("queue_position"):
                queue_parts.append(f"位置{event_data.get('queue_position')}")
            if event_data.get("waiting") is not None:
                queue_parts.append(f"等待{event_data.get('waiting')}")
            if event_data.get("running") is not None:
                queue_parts.append(f"執行{event_data.get('running')}")
            if event_data.get("max_concurrency") is not None:
                queue_parts.append(f"上限{event_data.get('max_concurrency')}")
        progress = ""
        if event_message and status in {"queued", "running"}:
            progress = f"，{event_message}"
        if queue_parts and status in {"queued", "running"}:
            progress += f"（{'，'.join(queue_parts)}）"
        suffix = f"，{error}" if status == "failed" and error else (download or progress)
        lines.append(f"- {item.get('type')}: {label}{suffix}（{item.get('id')}）")
        workflow_line = _format_internal_webapp_tg_workflow_line(item)
        if workflow_line:
            lines.append(f"  {workflow_line}")
    return "\n".join(lines)


def _clean_internal_webapp_tg_workflow_id(value: Any) -> str:
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return ""
    text = text.removeprefix("__converted__/")
    if text.lower().endswith(".api.json"):
        text = text[:-9]
    elif text.lower().endswith(".json"):
        text = text[:-5]
    return text


def _format_internal_webapp_tg_workflow_line(item: dict[str, Any]) -> str:
    workflow_name = str(item.get("current_workflow_name") or item.get("workflow_name") or "").strip()
    raw_ids = item.get("current_workflow_ids")
    if not isinstance(raw_ids, list):
        raw_ids = item.get("workflow_ids")
    workflow_ids: list[str] = []
    if isinstance(raw_ids, list):
        workflow_ids = [_clean_internal_webapp_tg_workflow_id(value) for value in raw_ids]
    if not workflow_ids:
        workflow_id_value = item.get("current_workflow_id") or item.get("workflow_id")
        workflow_ids = [
            _clean_internal_webapp_tg_workflow_id(value)
            for value in str(workflow_id_value or "").split(",")
        ]
    workflow_ids = [value for value in workflow_ids if value]
    workflow_chain = " > ".join(workflow_ids)
    if workflow_name and workflow_chain:
        return f"工作流：{workflow_name} / {workflow_chain}"
    if workflow_name:
        return f"工作流：{workflow_name}"
    if workflow_chain:
        return f"工作流：{workflow_chain}"
    return ""


def _format_internal_webapp_tg_status(status: dict[str, Any], *, chat_id: int) -> str:
    counts = status.get("counts") if isinstance(status.get("counts"), dict) else {}
    active = status.get("active_task") if isinstance(status.get("active_task"), dict) else None
    latest = status.get("latest_task") if isinstance(status.get("latest_task"), dict) else None
    lines = [
        "後臺生成工作臺狀態",
        f"等待中任務: {int(counts.get('queued') or 0)}",
        f"進行中任務: {int(counts.get('running') or 0)}",
        f"已完成任務: {int(counts.get('success') or 0)}",
        f"失敗任務: {int(counts.get('failed') or 0)}",
    ]
    if active:
        lines.append(f"目前占用: {active.get('type') or 'unknown'} / {active.get('id') or '-'}")
        workflow_line = _format_internal_webapp_tg_workflow_line(active)
        if workflow_line:
            lines.append(workflow_line)
        event = active.get("latest_event") if isinstance(active.get("latest_event"), dict) else {}
        event_message = str(event.get("message") or "").strip()
        if event_message:
            lines.append(f"當前進度: {event_message}")
    else:
        lines.append("目前占用: 無，工作臺可立即使用")
    if latest:
        lines.extend(
            [
                f"最近任務: {latest.get('id') or '-'}",
                f"最近狀態: {latest.get('status_label') or latest.get('status') or '-'}",
            ]
        )
    lines.append(f"你的 Chat ID: {chat_id}")
    return "\n".join(lines)


def build_dispatcher(config: AppConfig, service: WorkspaceService) -> Dispatcher:
    dispatcher = Dispatcher(storage=MemoryStorage())
    router = Router(name="workspace-bot")
    dispatcher.include_router(router)
    chat_script_drafts: dict[int, str] = {}

    async def ensure_authorized(message: Message) -> bool:
        if _is_message_authorized(service, message):
            return True
        await _answer(message,
            "\n".join(
                [
                    "你的 Telegram 賬號還沒有加入後臺可信用戶。",
                    "",
                    _chat_identity_text(message),
                ]
            )
        )
        return False

    async def start_upload_flow(message: Message, state: FSMContext, requirement: str = "") -> None:
        work_dir = service.create_job_dir(prefix="tg")
        await state.clear()
        await state.set_state(UploadFlowForm.waiting_for_video)
        await state.update_data(work_dir=str(work_dir), digital_human_requirement=str(requirement or "").strip())
        await _answer(message,
            "\n".join(
                [
                    "🌟 數字人視頻生成",
                    f"已選擇：{requirement}" if requirement else "請先上傳素材，後續會交給 Grok 生成提示詞。",
                    "步驟 1/4：上傳原視頻",
                    "",
                    "✨ 用途：運鏡與首幀參考。",
                    "可以直接傳視頻，也可以當成 document 傳送。",
                ]
            ),
            reply_markup=_menu_keyboard(),
        )

    async def handle_entry_keyword(message: Message, state: FSMContext) -> bool:
        text = _canonical_button_text(_message_text(message))
        if text not in {
            "多智能體數字人",
            IMAGE_WORKFLOW_BUTTON,
            TEXT_TO_IMAGE_BUTTON,
            SINGLE_IMAGE_EDIT_BUTTON,
            IMAGE_EDIT_BUTTON,
            IMAGE_EDIT_CONTINUE_RESULT_BUTTON,
            IMAGE_EDIT_RERUN_BUTTON,
            FACE_SWAP_BUTTON,
            FACE_SWAP_UPSCALE_BUTTON,
            FACE_SWAP_RERUN_BUTTON,
            MULTI_IMAGE_BUTTON,
            IMAGE_REPLACE_BUTTON,
            VIDEO_EDIT_BUTTON,
            VIDEO_GENERAL_EDIT_BUTTON,
            TEXT_TO_IMAGE_REROLL_IMAGE_BUTTON,
            TEXT_TO_IMAGE_CONTINUE_IMAGE_BUTTON,
            MAIN_MENU_BUTTON,
        }:
            return False
        if not await ensure_authorized(message):
            return True
        if text == TEXT_TO_IMAGE_REROLL_IMAGE_BUTTON:
            try:
                await _reroll_latest_text_to_image(message, state)
            except Exception as exc:
                await _answer(message, f"重新生成圖片失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
            return True
        if text == TEXT_TO_IMAGE_CONTINUE_IMAGE_BUTTON:
            try:
                await _continue_latest_text_to_image(message, state)
            except Exception as exc:
                await _answer(message, f"繼續生成圖片失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
            return True
        await state.clear()
        if text == MAIN_MENU_BUTTON:
            await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())
        elif text == IMAGE_WORKFLOW_BUTTON:
            await start_image_generate_flow(message, state)
        elif text == TEXT_TO_IMAGE_BUTTON:
            await start_text_to_image_flow(message, state)
        elif text == SINGLE_IMAGE_EDIT_BUTTON:
            await start_single_image_edit_flow(message, state, single_input=True)
        elif text == IMAGE_EDIT_BUTTON:
            await start_single_image_edit_flow(message, state, single_input=False)
        elif text == IMAGE_EDIT_CONTINUE_RESULT_BUTTON:
            try:
                await _continue_latest_image_edit_result(message, state)
            except Exception as exc:
                await _answer(message, f"繼續編輯結果圖失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
        elif text == IMAGE_EDIT_RERUN_BUTTON:
            try:
                await _rerun_latest_image_edit(message, state)
            except Exception as exc:
                await _answer(message, f"重新生成圖片編輯失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
        elif text == FACE_SWAP_BUTTON:
            await start_face_swap_flow(message, state)
        elif text == FACE_SWAP_UPSCALE_BUTTON:
            try:
                task = await _latest_face_swap_task(int(message.chat.id))
                await _resubmit_face_swap_from_task(
                    message,
                    state,
                    task_id=str(task.get("id") or ""),
                    seedvr_upscale=True,
                )
            except Exception as exc:
                await _answer(message, f"增加解析度 2 倍提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
        elif text == FACE_SWAP_RERUN_BUTTON:
            try:
                task = await _latest_face_swap_task(int(message.chat.id))
                await _resubmit_face_swap_from_task(
                    message,
                    state,
                    task_id=str(task.get("id") or ""),
                    seedvr_upscale=False,
                )
            except Exception as exc:
                await _answer(message, f"重新生成人物換臉失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
        elif text == MULTI_IMAGE_BUTTON:
            await start_image_reference_flow(message, state, mode="multi_image")
        elif text == IMAGE_REPLACE_BUTTON:
            await start_image_reference_flow(message, state, mode="image_replace")
        elif text == VIDEO_EDIT_BUTTON:
            await _answer(message, "視頻生成：請選擇要建立的任務。", reply_markup=_video_edit_keyboard())
        elif text == VIDEO_GENERAL_EDIT_BUTTON:
            await start_video_i2v_flow(message, state)
        else:
            await _answer(message, _quick_start_text(service), reply_markup=_menu_keyboard())
        return True

    async def handle_workflow_reference_request(message: Message, state: FSMContext | None = None) -> bool:
        text = _canonical_button_text(_message_text(message))
        if text not in WORKFLOW_REFERENCE_BUTTONS:
            return False
        if not await ensure_authorized(message):
            return True
        if state is not None:
            await state.clear()
        await _answer(message, _workflow_config_text(service, selected_button=text), reply_markup=_menu_keyboard())
        return True

    async def handle_stop_request(message: Message, state: FSMContext) -> bool:
        text = _canonical_button_text(_message_text(message))
        if text != STOP_BUTTON and not text.startswith("/stop"):
            return False
        if not await ensure_authorized(message):
            return True
        await state.clear()

        try:
            webapp_cancel = await _cancel_latest_internal_webapp_tg_task(chat_id=int(message.chat.id))
        except Exception as exc:
            webapp_cancel = {
                "cancelled": False,
                "state": "error",
                "message": f"後臺生成任務停止查詢失敗：{_format_tg_user_error(exc)}",
            }
        if webapp_cancel.get("cancelled") is True:
            task_label = {
                "text_to_image": "文生圖",
                "image_generate": "圖像生成",
                "get_nano_banana": "圖片編輯",
                "single_image_edit": "單圖編輯",
                "face_swap": "人物換臉",
                "video_i2v": "圖生視頻",
            }.get(str(webapp_cancel.get("type") or ""), str(webapp_cancel.get("type") or "後臺生成"))
            await _answer(
                message,
                "\n".join(
                    [
                        "已強制停止後臺生成任務。",
                        f"工作流: {task_label}",
                        f"任務編號: {webapp_cancel.get('id')}",
                        "如果 4090 已經開始推理，遠端可能仍會跑完，但本地不會再把結果當作完成任務推送。",
                    ]
                ),
                reply_markup=_menu_keyboard(),
            )
            return True
        if str(webapp_cancel.get("state") or "") == "error":
            await _answer(message, str(webapp_cancel.get("message") or "後臺生成任務停止失敗。"), reply_markup=_menu_keyboard())
            return True
        webapp_no_active_message = ""
        if str(webapp_cancel.get("state") or "") == "none":
            webapp_no_active_message = str(webapp_cancel.get("message") or "").strip()

        active_task = service.store.get_active_task()
        target_task = active_task or service.get_latest_open_task_for_submitter(int(message.chat.id))
        if target_task is None:
            await _answer(message, webapp_no_active_message or "目前沒有可強制停止的任務。", reply_markup=_menu_keyboard())
            return True

        result = await service.cancel_task(target_task.id, requested_by=f"TG-{int(message.chat.id)}")
        await _answer(message, result.message, reply_markup=_menu_keyboard())
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
        result = await _submit_internal_webapp_task(
            chat_id=int(message.chat.id),
            task_type=task_type,
            params=params,
        )
        task_label = {
            "text_to_image": "文生圖",
            "image_generate": "圖像生成",
            "get_nano_banana": "圖片編輯",
            "single_image_edit": "單圖編輯",
            "face_swap": "人物換臉",
            "video_i2v": "圖生視頻",
        }.get(str(task_type), str(task_type))
        task_id = str(result.get("id") or "").strip()
        sent = await _answer(
            message,
            _format_webapp_task_live_status(
                task_id=task_id,
                task_label=task_label,
                status="queued",
                latest_event={"message": "任務已提交到後臺隊列。"},
            ),
            reply_markup=_menu_keyboard(),
        )
        if task_id:
            asyncio.create_task(
                _monitor_webapp_task_status_message(
                    message=sent,
                    chat_id=int(message.chat.id),
                    task_id=task_id,
                    task_label=task_label,
                )
            )

    def _format_webapp_task_live_status(
        *,
        task_id: str,
        task_label: str,
        status: str,
        latest_event: dict[str, Any] | None = None,
    ) -> str:
        status_labels = {
            "queued": "排隊中",
            "running": "生成中",
            "success": "已完成",
            "failed": "失敗",
            "cancelled": "已取消",
        }
        event = latest_event if isinstance(latest_event, dict) else {}
        event_message = str(event.get("message") or "").strip()
        event_data = event.get("data") if isinstance(event.get("data"), dict) else {}
        queue_line = ""
        if isinstance(event_data, dict):
            queue_position = event_data.get("queue_position")
            waiting = event_data.get("waiting")
            running = event_data.get("running")
            max_concurrency = event_data.get("max_concurrency")
            reason = str(event_data.get("reason") or "").strip()
            if queue_position or waiting is not None or running is not None:
                parts = []
                if queue_position:
                    parts.append(f"位置: {queue_position}")
                if waiting is not None:
                    parts.append(f"等待: {waiting}")
                if running is not None:
                    parts.append(f"執行中: {running}")
                if max_concurrency is not None:
                    parts.append(f"上限: {max_concurrency}")
                queue_line = "隊列: " + "，".join(str(part) for part in parts)
            elif reason:
                queue_line = f"隊列: {reason}"
        lines = [
            "後臺任務狀態更新",
            f"工作流: {task_label}",
            f"任務編號: {task_id}",
            f"狀態: {status_labels.get(str(status), str(status) or 'unknown')}",
        ]
        if event_message:
            lines.append(f"進度: {event_message}")
        if queue_line:
            lines.append(queue_line)
        if str(status) in {"queued", "running"}:
            lines.append("此消息會自動更新；也可按「查看工作臺狀態」。")
        elif str(status) == "success":
            lines.append("生成完成，結果會自動返回；也可到工作臺查看。")
        return "\n".join(lines)

    async def _monitor_webapp_task_status_message(
        *,
        message: Message,
        chat_id: int,
        task_id: str,
        task_label: str,
    ) -> None:
        last_text = ""
        for _ in range(720):
            await asyncio.sleep(5)
            try:
                task = await _fetch_internal_webapp_tg_task_detail(chat_id=int(chat_id), task_id=task_id)
            except Exception:
                continue
            status = str(task.get("status") or "").strip().lower()
            text = _format_webapp_task_live_status(
                task_id=task_id,
                task_label=task_label,
                status=status,
                latest_event=task.get("latest_event") if isinstance(task.get("latest_event"), dict) else {},
            )
            if status == "failed":
                error = _format_tg_user_error(task.get("error") or "")
                if error:
                    text = f"{text}\n原因: {error[:600]}"
            if text != last_text:
                try:
                    await message.edit_text(text)
                    last_text = text
                except Exception:
                    pass
            if status in {"success", "failed", "cancelled"}:
                return

    async def answer_status(message: Message) -> None:
        parts: list[str] = []
        chat_id = int(message.chat.id)
        try:
            tasks = await _fetch_internal_webapp_tg_tasks(chat_id=chat_id, limit=5)
            parts.append(_format_internal_webapp_tg_tasks(tasks))
        except Exception as exc:
            parts.append(f"後臺生成任務：查詢失敗（{_format_tg_user_error(exc)}）")
        try:
            webapp_status = await _fetch_internal_webapp_tg_status(chat_id=chat_id)
            parts.append(_format_internal_webapp_tg_status(webapp_status, chat_id=chat_id))
        except Exception as exc:
            parts.append(f"後臺生成工作臺狀態：查詢失敗（{_format_tg_user_error(exc)}）")
        await _answer(message, "\n\n".join(parts), reply_markup=_menu_keyboard())

    async def start_image_generate_flow(message: Message, state: FSMContext) -> None:
        await state.clear()
        await _answer(message,
            "圖像生成：請選擇要執行的圖片模式。",
            reply_markup=_image_edit_keyboard(),
        )

    def _image_mode_title(mode: str) -> str:
        return "圖片替換" if mode == "image_replace" else "多圖生成"

    def _tg_workflow_display_name(workflow_path: str) -> str:
        text = str(workflow_path or "").strip().replace("\\", "/")
        if not text:
            return ""
        text = text.removeprefix("__converted__/")
        name = Path(text).stem or text
        if name.endswith(".api"):
            name = name[:-4]
        parent = str(Path(text).parent).replace("\\", "/")
        if parent and parent not in {".", "__converted__"}:
            return f"{parent}/{name}"
        return name

    def _tg_mapped_workflow_line(task_type: str) -> str:
        runtime = _load_runtime_config(service.resolve_config())
        workflow_path = _runtime_mapped_workflow(runtime, task_type)
        if not workflow_path:
            return "可用工作流：未配置，請先在後臺映射工作流。"
        return f"可用工作流：{_tg_workflow_display_name(workflow_path)}"

    async def start_image_reference_flow(message: Message, state: FSMContext, *, mode: str) -> None:
        mode = "image_replace" if mode == "image_replace" else "multi_image"
        title = _image_mode_title(mode)
        await state.clear()
        await state.set_state(ProductionWorkflowForm.image_waiting_for_product_image)
        await state.update_data(image_mode=mode, work_dir=str(service.create_job_dir(prefix=f"tg_{mode}")))
        first_step = "請上傳原圖。" if mode == "image_replace" else "請上傳第一張參考圖。"
        await _answer(message,
            f"{title}\n步驟 1/3：{first_step}",
            reply_markup=_image_task_step_keyboard(back=False),
        )

    def _image_reference_first_step_text(mode: str, *, has_current: bool = False) -> str:
        title = _image_mode_title(mode)
        if has_current:
            label = "原圖" if mode == "image_replace" else "第一張參考圖"
            return f"{title}\n已記錄目前{label}。可以上傳新圖片替換，或點擊“{KEEP_CURRENT_RESOURCE_BUTTON}”繼續。"
        first_step = "請上傳原圖。" if mode == "image_replace" else "請上傳第一張參考圖。"
        return f"{title}\n步驟 1/3：{first_step}"

    def _image_reference_second_step_text(mode: str, *, has_current: bool = False) -> str:
        title = _image_mode_title(mode)
        if has_current:
            label = "要替換成的參考圖" if mode == "image_replace" else "第二張參考圖"
            return f"{title}\n已記錄目前{label}。可以上傳新圖片替換，或點擊“{KEEP_CURRENT_RESOURCE_BUTTON}”繼續。"
        second_step = "請上傳要替換成的參考圖。" if mode == "image_replace" else "請上傳第二張參考圖。"
        return f"{title}\n步驟 2/3：{second_step}"

    async def start_single_image_edit_flow(message: Message, state: FSMContext, *, single_input: bool = False) -> None:
        await state.clear()
        await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_image)
        mode = "single" if single_input else "two"
        title = "單圖編輯" if single_input else "圖片編輯"
        total_steps = "3" if single_input else "4"
        await state.update_data(work_dir=str(service.create_job_dir(prefix="tg_image_edit")), image_edit_mode=mode)
        await _answer(message,
            "\n".join(
                [
                    title,
                    f"步驟 1/{total_steps}：請上傳需要編輯的原圖。",
                ]
            ),
            reply_markup=_image_task_step_keyboard(back=False),
        )

    def _image_edit_flow_meta(data: dict[str, Any]) -> tuple[bool, str, int, str]:
        single_input = str(data.get("image_edit_mode") or "").strip() == "single"
        return (
            single_input,
            "單圖編輯" if single_input else "圖片編輯",
            3 if single_input else 4,
            "single_image_edit" if single_input else "get_nano_banana",
        )

    async def _show_image_edit_prompt_mode(message: Message, state: FSMContext, *, prefix: str = "") -> None:
        data = await state.get_data()
        _, title, total_steps, _ = _image_edit_flow_meta(data)
        step = total_steps - 1
        await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_prompt_mode)
        await _answer(
            message,
            (
                f"{prefix}\n" if prefix else ""
            )
            + f"{title}\n步驟 {step}/{total_steps}：請選擇提示詞方式。\n\n"
            "可以讓 Grok 根據你的要求生成圖片編輯提示詞，也可以直接輸入自定義最終提示詞。",
            reply_markup=_image_edit_prompt_mode_keyboard(),
        )

    async def _show_image_edit_prompt_entry(
        message: Message,
        state: FSMContext,
        *,
        custom_prompt: bool = False,
    ) -> None:
        data = await state.get_data()
        _, title, total_steps, _ = _image_edit_flow_meta(data)
        if custom_prompt:
            await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_confirm)
            await state.update_data(image_edit_waiting_for_custom_prompt=True, image_edit_waiting_for_adjustment=False)
            await _answer(
                message,
                f"{title}\n步驟 {total_steps}/{total_steps}：請輸入自定義最終圖片編輯提示詞。下一條消息會跳過 Grok，直接提交編輯任務。",
                reply_markup=_image_task_step_keyboard(),
            )
            return
        await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_prompt)
        await state.update_data(image_edit_waiting_for_custom_prompt=False, image_edit_waiting_for_adjustment=False)
        await _answer(
            message,
            f"{title}\n步驟 {total_steps}/{total_steps}：請輸入這次圖片編輯要求，Grok 會先生成提示詞供你確認。",
            reply_markup=_image_task_step_keyboard(),
        )

    def _clear_image_edit_prompt_fields() -> dict[str, Any]:
        return {
            "image_edit_prompt": "",
            "image_edit_generated_prompt": "",
            "image_edit_selected_model": "",
            "image_edit_user_request": "",
            "image_edit_prompt_ready": False,
            "image_edit_waiting_for_adjustment": False,
            "image_edit_waiting_for_custom_prompt": False,
        }

    def _build_image_edit_payload(data: dict[str, Any], final_prompt: str, *, user_request: str = "", use_grok: bool) -> dict[str, Any]:
        prompt_text = str(final_prompt or "").strip()
        request_text = str(user_request or prompt_text).strip()
        return {
            "input_image_local_path": str(data.get("input_image_local_path") or ""),
            "reference_image_local_path": str(data.get("reference_image_local_path") or ""),
            "prompt": prompt_text,
            "prompt_text": prompt_text,
            "message": prompt_text,
            "tg_use_llm_prompt": bool(use_grok),
            "tg_original_user_request": request_text,
            "tg_user_instruction": f"User image editing request: {request_text}",
        }

    async def _preview_image_edit_prompt(message: Message, state: FSMContext, user_request: str) -> None:
        data = await state.get_data()
        _, title, total_steps, task_type = _image_edit_flow_meta(data)
        request_text = str(user_request or "").strip()
        if not request_text:
            await _answer(message, f"{title}\n步驟 {total_steps}/{total_steps}：請輸入這次圖片編輯要求，Grok 會先生成提示詞供你確認。", reply_markup=_image_task_step_keyboard())
            return
        await state.update_data(
            image_edit_user_request=request_text,
            image_edit_prompt_ready=False,
            image_edit_waiting_for_adjustment=False,
            image_edit_waiting_for_custom_prompt=False,
        )
        status_message = await _send_transient_status(message, "正在讓 Grok 生成圖片編輯提示詞...")
        try:
            preview_payload = _build_image_edit_payload(data, request_text, user_request=request_text, use_grok=True)
            preview = await _preview_internal_webapp_prompt(
                chat_id=int(message.chat.id),
                task_type=task_type,
                params=preview_payload,
            )
            generated_prompt = str(preview.get("prompt_text") or "").strip()
            selected_model = str(preview.get("selected_model") or "").strip()
            if not generated_prompt:
                raise RuntimeError("Grok 未返回可用的圖片編輯提示詞")
            await state.update_data(
                image_edit_prompt=generated_prompt,
                image_edit_generated_prompt=generated_prompt,
                image_edit_user_request=request_text,
                image_edit_selected_model=selected_model,
                image_edit_prompt_ready=True,
                image_edit_waiting_for_adjustment=False,
                image_edit_waiting_for_custom_prompt=False,
            )
            await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_confirm)
            model_line = f"\n\n模型：{selected_model}" if selected_model else ""
            await _send_long_text(
                message,
                f"{title}\nGrok 已生成圖片編輯提示詞：\n\n{generated_prompt}{model_line}\n\n請確認提示詞是否合適，確認後再提交編輯任務。",
                reply_markup=_image_edit_prompt_review_keyboard(),
            )
        finally:
            await _delete_message_silently(status_message)

    async def _submit_image_edit_from_state(message: Message, state: FSMContext, final_prompt: str) -> None:
        data = await state.get_data()
        _, title, _, task_type = _image_edit_flow_meta(data)
        prompt = str(final_prompt or "").strip()
        if not prompt:
            await _answer(message, "還沒有可用的圖片編輯提示詞，請先輸入要求讓 Grok 生成。", reply_markup=_image_edit_prompt_failure_keyboard())
            return
        payload = _build_image_edit_payload(
            data,
            prompt,
            user_request=str(data.get("image_edit_user_request") or prompt),
            use_grok=False,
        )
        payload.update(
            {
                "tg_llm_rewritten_prompt": prompt,
                "tg_prompt_confirmed": True,
            }
        )
        try:
            await submit_webapp_task_and_reply(message, task_type, payload)
            await state.clear()
        except Exception as exc:
            await _answer(message, f"{title}任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_image_edit_prompt_review_keyboard())

    async def start_face_swap_flow(message: Message, state: FSMContext) -> None:
        await state.clear()
        await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_target_image)
        await state.update_data(work_dir=str(service.create_job_dir(prefix="tg_face_swap")))
        await _answer(message,
            "\n".join(
                [
                    "人物換臉",
                    _tg_mapped_workflow_line("face_swap"),
                    "步驟 1/4：請上傳原圖，也就是需要被換臉的圖片。",
                ]
            ),
            reply_markup=_image_task_step_keyboard(back=False),
        )

    def _clear_face_swap_prompt_fields() -> dict[str, Any]:
        return {
            "face_swap_prompt": "",
            "face_swap_generated_prompt": "",
            "face_swap_selected_model": "",
            "face_swap_user_request": "",
            "face_swap_prompt_ready": False,
            "face_swap_waiting_for_adjustment": False,
            "face_swap_waiting_for_custom_prompt": False,
        }

    def _build_face_swap_payload(data: dict[str, Any], final_prompt: str, *, user_request: str = "", use_grok: bool) -> dict[str, Any]:
        prompt_text = str(final_prompt or "").strip()
        request_text = str(user_request or prompt_text or FACE_SWAP_NATURAL_PROMPT).strip()
        seed_value = int(data.get("face_swap_random_seed") or 0)
        if seed_value <= 0:
            seed_value = secrets.randbelow(TEXT_TO_IMAGE_MAX_SEED) + 1
        return {
            "target_image_local_path": str(data.get("target_image_local_path") or ""),
            "source_image_local_path": str(data.get("source_image_local_path") or ""),
            "prompt": prompt_text,
            "prompt_text": prompt_text,
            "message": prompt_text,
            "seed": seed_value,
            "face_swap_random_seed": seed_value,
            "tg_use_llm_prompt": bool(use_grok),
            "tg_original_user_request": request_text,
            "tg_user_instruction": f"User face swap request: {request_text}",
        }

    async def _preview_face_swap_prompt(message: Message, state: FSMContext, user_request: str) -> None:
        data = await state.get_data()
        request_text = str(user_request or FACE_SWAP_NATURAL_PROMPT).strip()
        seed_value = int(data.get("face_swap_random_seed") or 0)
        if seed_value <= 0:
            seed_value = secrets.randbelow(TEXT_TO_IMAGE_MAX_SEED) + 1
        await state.update_data(
            face_swap_user_request=request_text,
            face_swap_prompt_ready=False,
            face_swap_waiting_for_adjustment=False,
            face_swap_waiting_for_custom_prompt=False,
            face_swap_random_seed=seed_value,
        )
        status_message = await _send_transient_status(message, "正在讓 Grok 生成人物換臉提示詞...")
        try:
            preview_payload = _build_face_swap_payload(
                {**data, "face_swap_random_seed": seed_value},
                request_text,
                user_request=request_text,
                use_grok=True,
            )
            preview = await _preview_internal_webapp_prompt(
                chat_id=int(message.chat.id),
                task_type="face_swap",
                params=preview_payload,
            )
            generated_prompt = str(preview.get("prompt_text") or "").strip()
            selected_model = str(preview.get("selected_model") or "").strip()
            if not generated_prompt:
                raise RuntimeError("Grok 未返回可用的人物換臉提示詞")
            await state.update_data(
                face_swap_prompt=generated_prompt,
                face_swap_generated_prompt=generated_prompt,
                face_swap_user_request=request_text,
                face_swap_selected_model=selected_model,
                face_swap_prompt_ready=True,
                face_swap_waiting_for_adjustment=False,
                face_swap_waiting_for_custom_prompt=False,
                face_swap_random_seed=seed_value,
            )
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_confirm)
            model_line = f"\n\n模型：{selected_model}" if selected_model else ""
            await _send_long_text(
                message,
                f"人物換臉\nGrok 已生成換臉提示詞：\n\n{generated_prompt}{model_line}\n\n請確認提示詞是否合適，確認後點擊「使用這個提示詞提交」。",
                reply_markup=_image_edit_prompt_review_keyboard(),
            )
        finally:
            await _delete_message_silently(status_message)

    async def _submit_face_swap_from_state(message: Message, state: FSMContext, final_prompt: str) -> None:
        data = await state.get_data()
        prompt = str(final_prompt or "").strip()
        if not prompt:
            await _answer(message, "還沒有可用的人物換臉提示詞，請先選擇“自然換臉”或輸入自定義要求。", reply_markup=_image_edit_prompt_failure_keyboard())
            return
        payload = _build_face_swap_payload(
            data,
            prompt,
            user_request=str(data.get("face_swap_user_request") or prompt),
            use_grok=False,
        )
        payload.update(
            {
                "tg_llm_rewritten_prompt": prompt,
                "tg_prompt_confirmed": True,
            }
        )
        try:
            await submit_webapp_task_and_reply(message, "face_swap", payload)
            await state.clear()
        except Exception as exc:
            await _answer(message, f"人物換臉任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_image_edit_prompt_review_keyboard())

    def _video_i2v_defaults() -> dict[str, Any]:
        return {
            "resolution": "720p",
            "duration": 2,
            "use_grok": True,
            "prompt_extend": False,
            "safety_filter": False,
            "seed": "1024",
            "negative_prompt": "",
            "resolution_selected": False,
            "duration_selected": False,
            "image_local_path": "",
            "audio_selected": False,
            "audio_local_path": "",
            "prompt_mode_selected": False,
            "prompt_extend_selected": False,
        "prompt_mode_label": "Grok 生成",
        }

    async def _video_i2v_runtime_defaults() -> dict[str, Any]:
        defaults = _video_i2v_defaults()
        try:
            runtime = await asyncio.to_thread(_fetch_webapp_runtime_config)
        except Exception:
            runtime = {}
        defaults["negative_prompt"] = str(
            runtime.get("mulerouter_wan_i2v_negative_prompt")
            or "low quality, blurry, distorted, watermark, text, logo"
        ).strip()
        seed_value = str(runtime.get("mulerouter_wan_i2v_seed") or defaults["seed"]).strip()
        defaults["seed"] = seed_value if seed_value.isdigit() else "1024"
        return defaults

    def _video_i2v_state_params(data: dict[str, Any]) -> dict[str, Any]:
        params = _video_i2v_defaults()
        params.update({k: data.get(k) for k in params.keys() if k in data})
        params["resolution"] = "1080p" if str(params.get("resolution") or "").strip() == "1080p" else "720p"
        params["duration"] = min(max(int(params.get("duration") or 2), 2), 15)
        params["use_grok"] = bool(params.get("use_grok"))
        params["prompt_extend"] = bool(params.get("prompt_extend"))
        params["safety_filter"] = False
        params["resolution_selected"] = bool(params.get("resolution_selected"))
        params["duration_selected"] = bool(params.get("duration_selected"))
        params["image_local_path"] = str(params.get("image_local_path") or "").strip()
        params["audio_selected"] = bool(params.get("audio_selected"))
        params["audio_local_path"] = str(params.get("audio_local_path") or "").strip()
        params["prompt_mode_selected"] = bool(params.get("prompt_mode_selected"))
        params["prompt_extend"] = False
        params["prompt_extend_selected"] = False
        params["prompt_mode_label"] = str(params.get("prompt_mode_label") or "").strip()
        seed_text = str(params.get("seed") or "1024").strip()
        params["seed"] = seed_text if seed_text.isdigit() else "1024"
        params["negative_prompt"] = str(params.get("negative_prompt") or "").strip()
        return params

    def _video_i2v_status_text(*, step: str, params: dict[str, Any]) -> str:
        lines = ["視頻生成設置", f"當前步驟：{step}"]
        if params.get("resolution_selected"):
            lines.append(f"分辨率：{params['resolution']}")
        if params.get("duration_selected"):
            lines.append(f"時長：{params['duration']}秒")
        if params.get("audio_selected"):
            lines.append("音頻：已上傳" if params.get("audio_local_path") else "音頻：跳過")
        if params.get("prompt_mode_selected"):
            label = str(params.get("prompt_mode_label") or "").strip()
            prompt_mode_text = label or ("Grok 生成" if params["use_grok"] else "自定義提交")
            lines.append(f"提示詞方式：{prompt_mode_text}")
        return "\n".join(lines)

    def _clear_video_i2v_prompt_fields() -> dict[str, Any]:
        return {
            "video_i2v_user_request": "",
            "video_i2v_generated_prompt": "",
            "video_i2v_prompt_ready": False,
            "video_i2v_waiting_for_adjustment": False,
        }

    def _video_i2v_step_keyboard(step: str, params: dict[str, Any]) -> ReplyKeyboardMarkup:
        if step == "resolution":
            return ReplyKeyboardMarkup(
                keyboard=[
                    [
                        KeyboardButton(text="720p（最小資源）"),
                        KeyboardButton(text="1080p"),
                    ],
                    [KeyboardButton(text="返回主菜單")],
                ],
                resize_keyboard=True,
            )
        if step == "duration":
            return ReplyKeyboardMarkup(
                keyboard=[
                    [KeyboardButton(text="上一步"), KeyboardButton(text="返回主菜單")],
                ],
                resize_keyboard=True,
            )
        if step == "prompt_mode":
            return ReplyKeyboardMarkup(
                keyboard=[
                    [KeyboardButton(text="讓 Grok 生成提示詞")],
                    [KeyboardButton(text="輸入自定義提示詞提交")],
                    [KeyboardButton(text="上一步"), KeyboardButton(text="返回主菜單")],
                ],
                resize_keyboard=True,
            )
        if step == "audio":
            return _video_i2v_audio_keyboard(keep_current=_recorded_local_resource(params.get("audio_local_path")))
        if step == "image":
            return _image_task_step_keyboard(keep_current=_recorded_local_resource(params.get("image_local_path")))
        return ReplyKeyboardMarkup(
            keyboard=[
                [KeyboardButton(text="上一步"), KeyboardButton(text="返回主菜單")],
            ],
            resize_keyboard=True,
        )

    async def _show_video_i2v_step(message: Message, state: FSMContext, *, step: str) -> None:
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        state_map = {
            "resolution": ProductionWorkflowForm.video_i2v_waiting_for_resolution,
            "duration": ProductionWorkflowForm.video_i2v_waiting_for_duration,
            "audio": ProductionWorkflowForm.video_i2v_waiting_for_audio,
            "prompt_mode": ProductionWorkflowForm.video_i2v_waiting_for_prompt_mode,
            "image": ProductionWorkflowForm.video_i2v_waiting_for_image,
            "prompt": ProductionWorkflowForm.video_i2v_waiting_for_prompt,
        }
        await state.set_state(state_map.get(step, ProductionWorkflowForm.video_i2v_waiting_for_resolution))
        labels = {
            "resolution": "1/5 選擇分辨率",
            "duration": "2/5 輸入視頻時長",
            "image": "3/5 上傳參考圖",
            "audio": "4/5 上傳音頻（可選）",
            "prompt_mode": "5/5 選擇提示詞方式",
            "prompt": "已收到參考圖，請輸入視頻需求",
        }
        text = _video_i2v_status_text(step=labels.get(step, step), params=params)
        if step == "duration":
            text += "\n\n請直接輸入視頻時長，範圍 2 到 15 秒，例如：5。"
        elif step == "audio":
            if _recorded_local_resource(params.get("audio_local_path")):
                text += "\n\n已記錄當前音頻。可以上傳新音頻替換，點擊“沿用目前資源”繼續，或點擊“跳過音頻”讓本次不使用音頻。"
            else:
                text += "\n\n可以上傳音頻文件（mp3/wav/m4a/ogg 等），或點擊“跳過音頻”。"
        elif step == "image":
            if _recorded_local_resource(params.get("image_local_path")):
                text += "\n\n已記錄當前參考圖。可以上傳新圖片替換，或點擊“沿用目前資源”繼續。"
            else:
                text += "\n\n請上傳一張參考圖片。下一步再選擇是否上傳音頻。"
        elif step == "prompt_mode":
            text += "\n\n請選擇讓 Grok 生成提示詞，或輸入自定義提示詞提交。"
        elif step == "prompt":
            if params.get("use_grok"):
                text += "\n\n請輸入視頻需求。Grok 會在最後生成完整提示詞，並在聊天中完整顯示後再提交。"
            else:
                text += "\n\n請輸入自定義最終提示詞。下一條消息會跳過 Grok 直接提交。"
        markup = _video_i2v_step_keyboard(step, params)
        await _answer(message, text, reply_markup=markup)

    async def _show_video_i2v_step_from_callback(callback: CallbackQuery, state: FSMContext, *, step: str) -> None:
        if callback.message is None:
            return
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        state_map = {
            "resolution": ProductionWorkflowForm.video_i2v_waiting_for_resolution,
            "duration": ProductionWorkflowForm.video_i2v_waiting_for_duration,
            "audio": ProductionWorkflowForm.video_i2v_waiting_for_audio,
            "prompt_mode": ProductionWorkflowForm.video_i2v_waiting_for_prompt_mode,
            "image": ProductionWorkflowForm.video_i2v_waiting_for_image,
            "prompt": ProductionWorkflowForm.video_i2v_waiting_for_prompt,
        }
        await state.set_state(state_map.get(step, ProductionWorkflowForm.video_i2v_waiting_for_resolution))
        labels = {
            "resolution": "1/5 選擇分辨率",
            "duration": "2/5 輸入視頻時長",
            "image": "3/5 上傳參考圖",
            "audio": "4/5 上傳音頻（可選）",
            "prompt_mode": "5/5 選擇提示詞方式",
            "prompt": "已收到參考圖，請輸入視頻需求",
        }
        text = _video_i2v_status_text(step=labels.get(step, step), params=params)
        if step == "duration":
            text += "\n\n請直接輸入視頻時長，範圍 2 到 15 秒，例如：5。"
        elif step == "audio":
            if _recorded_local_resource(params.get("audio_local_path")):
                text += "\n\n已記錄當前音頻。可以上傳新音頻替換，點擊“沿用目前資源”繼續，或點擊“跳過音頻”讓本次不使用音頻。"
            else:
                text += "\n\n可以上傳音頻文件（mp3/wav/m4a/ogg 等），或點擊“跳過音頻”。"
        elif step == "image":
            if _recorded_local_resource(params.get("image_local_path")):
                text += "\n\n已記錄當前參考圖。可以上傳新圖片替換，或點擊“沿用目前資源”繼續。"
            else:
                text += "\n\n請上傳一張參考圖片。下一步再選擇是否上傳音頻。"
        elif step == "prompt_mode":
            text += "\n\n請選擇讓 Grok 生成提示詞，或輸入自定義提示詞提交。"
        elif step == "prompt":
            if params.get("use_grok"):
                text += "\n\n請輸入視頻需求。Grok 會在最後生成完整提示詞，並在聊天中完整顯示後再提交。"
            else:
                text += "\n\n請輸入自定義最終提示詞。下一條消息會跳過 Grok 直接提交。"
        await _answer(callback.message, text, reply_markup=_video_i2v_step_keyboard(step, params))

    async def _remove_reply_keyboard(message: Message, *, text: str = "請使用上方按鈕繼續。") -> None:
        try:
            sent = await _answer(message, text, reply_markup=ReplyKeyboardRemove())
            await sent.delete()
        except Exception:
            pass

    async def start_video_i2v_flow(message: Message, state: FSMContext) -> None:
        await state.clear()
        defaults = await _video_i2v_runtime_defaults()
        defaults.update(
            {
                "use_grok": True,
                "prompt_extend": False,
                "resolution_selected": False,
                "duration_selected": False,
                "audio_selected": False,
                "audio_local_path": "",
                "prompt_mode_selected": False,
                "prompt_extend_selected": False,
                "prompt_mode_label": "Grok 生成",
                "work_dir": str(service.create_job_dir(prefix="tg_video_i2v")),
            }
        )
        await state.update_data(**defaults)
        await _show_video_i2v_step(message, state, step="resolution")

    def _build_video_i2v_payload(data: dict[str, Any], params: dict[str, Any], prompt: str) -> dict[str, Any] | None:
        image_path = str(data.get("image_local_path") or "").strip()
        if not image_path:
            return None
        payload = {
            "image_local_path": image_path,
            "prompt": prompt,
            "prompt_text": prompt,
            "message": prompt,
            "resolution": str(params["resolution"]),
            "duration_seconds": int(params["duration"]),
            "mulerouter_wan_i2v_resolution": str(params["resolution"]),
            "mulerouter_wan_i2v_duration": int(params["duration"]),
            "mulerouter_wan_i2v_prompt_extend": False,
            "mulerouter_wan_i2v_safety_filter": False,
            "mulerouter_wan_i2v_negative_prompt": str(params["negative_prompt"]),
            "negative_prompt": str(params["negative_prompt"]),
            "prompt_extend": False,
            "safety_filter": False,
            "tg_use_llm_prompt": bool(params["use_grok"]),
            "tg_user_instruction": (
                "User image-to-video request: "
                f"{prompt}. Treat the reference image as the first frame and opening state; "
                "preserve its subject, pose, composition, scene, lighting, clothing/body state, and camera framing while animating the requested process."
            ),
            "tg_original_user_request": prompt,
        }
        if str(params.get("audio_local_path") or "").strip():
            payload["audio_local_path"] = str(params["audio_local_path"]).strip()
        if str(params.get("seed") or "").isdigit():
            payload["seed"] = int(str(params["seed"]))
            payload["mulerouter_wan_i2v_seed"] = int(str(params["seed"]))
        return payload

    async def _submit_video_i2v_payload(message: Message, state: FSMContext, payload: dict[str, Any], params: dict[str, Any]) -> None:
        await state.clear()
        result = await _submit_internal_webapp_task(chat_id=int(message.chat.id), task_type="video_i2v", params=payload)
        prompt_mode_text = str(params.get("prompt_mode_label") or "").strip() or ("Grok 生成" if params["use_grok"] else "自定義提交")
        reply = "\n".join(
            part for part in [
                "圖生視頻任務已提交。",
                f"任務編號：{result.get('id')}",
                f"分辨率：{params['resolution']}，時長：{params['duration']}秒，提示詞方式：{prompt_mode_text}",
                "生成完成後會自動把視頻傳回這裏。",
            ] if part
        )
        await _answer(message, reply, reply_markup=_menu_keyboard())

    async def _submit_video_i2v_from_state(message: Message, state: FSMContext, prompt: str) -> None:
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        payload = _build_video_i2v_payload(data, params, prompt)
        if payload is None:
            await _answer(message, "請先上傳一張參考圖。")
            await _show_video_i2v_step(message, state, step="image")
            return
        try:
            if params["use_grok"]:
                status_message = await _send_transient_status(message, "正在讓 Grok 生成視頻提示詞...")
                try:
                    preview = await _preview_internal_webapp_prompt(
                        chat_id=int(message.chat.id),
                        task_type="video_i2v",
                        params=payload,
                    )
                    generated_prompt = str(preview.get("prompt_text") or "").strip()
                    if not generated_prompt:
                        raise RuntimeError("Grok 未返回可用的視頻提示詞")
                    await state.update_data(
                        video_i2v_user_request=prompt,
                        video_i2v_generated_prompt=generated_prompt,
                        video_i2v_prompt_ready=True,
                    )
                    await state.set_state(ProductionWorkflowForm.video_i2v_waiting_for_prompt)
                    await _send_long_text(
                        message,
                        "視頻 Grok 生成提示詞：\n\n" + generated_prompt + "\n\n請確認後再提交。",
                        reply_markup=_video_i2v_prompt_review_keyboard(),
                    )
                finally:
                    await _delete_message_silently(status_message)
                return
            await _submit_video_i2v_payload(message, state, payload, params)
        except Exception as exc:
            if params.get("use_grok"):
                await state.update_data(
                    **params,
                    video_i2v_user_request=prompt,
                    video_i2v_prompt_ready=False,
                    video_i2v_generated_prompt="",
                )
                await state.set_state(ProductionWorkflowForm.video_i2v_waiting_for_prompt)
                await _answer(message,
                    "Grok 視頻提示詞生成失敗："
                    f"{_format_grok_preview_error(exc)}\n\n"
                    "任務還沒有提交，當前圖生視頻參數已保留。可以點擊“重新生成提示詞”再試一次，"
                    "或點擊“輸入自定義提示詞提交”跳過 Grok。",
                    reply_markup=_video_i2v_prompt_failure_keyboard(),
                )
                return
            await _answer(message, f"圖生視頻任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.callback_query(F.data.startswith("video_i2v:"))
    async def on_video_i2v_callback(callback: CallbackQuery, state: FSMContext) -> None:
        if callback.message is None:
            await callback.answer()
            return
        if not _is_message_authorized(service, callback.message):
            await callback.answer("當前賬號未授權", show_alert=True)
            return
        action = str(callback.data or "")
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        if action.endswith(":main_menu"):
            await state.clear()
            try:
                await callback.message.edit_text("已返回主菜單。")
            except Exception:
                pass
            await _answer(callback.message, "請選擇任務類型。", reply_markup=_menu_keyboard())
            await callback.answer()
            return
        if action == "video_i2v:back:resolution":
            params.update(
                {
                    "resolution_selected": False,
                    "duration_selected": False,
                    "prompt_mode_selected": False,
                    "prompt_extend_selected": False,
                }
            )
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="resolution")
            await callback.answer()
            return
        if action == "video_i2v:back:duration":
            params.update({"duration_selected": False, "prompt_mode_selected": False, "prompt_extend_selected": False})
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="duration")
            await callback.answer()
            return
        if action == "video_i2v:back:prompt_mode":
            params.update({"prompt_mode_selected": False, "prompt_extend_selected": False})
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="audio")
            await callback.answer()
            return
        if action == "video_i2v:back:extend":
            params.update({"prompt_extend": False, "prompt_extend_selected": False})
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="audio")
            await callback.answer()
            return
        if action == "video_i2v:next:duration":
            params["resolution_selected"] = True
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="duration")
            await callback.answer()
            return
        if action == "video_i2v:next:prompt_mode":
            if not params.get("audio_selected"):
                await callback.answer("請先選擇音頻步驟", show_alert=True)
                return
            await _show_video_i2v_step_from_callback(callback, state, step="prompt_mode")
            await callback.answer()
            return
        if action == "video_i2v:next:prompt_extend":
            if not params.get("prompt_mode_selected"):
                params["prompt_mode_selected"] = True
                params["prompt_mode_label"] = "Grok 生成" if params.get("use_grok") else "自定義提交"
                await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="prompt")
            await callback.answer()
            return
        if action == "video_i2v:next:image":
            params["prompt_extend"] = False
            params["prompt_extend_selected"] = True
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="image")
            await callback.answer()
            return
        if action.startswith("video_i2v:resolution:"):
            params["resolution"] = action.rsplit(":", 1)[-1]
            params["resolution_selected"] = True
            params.update({"duration_selected": False, "prompt_mode_selected": False, "prompt_extend_selected": False})
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="duration")
            await callback.answer("已選擇分辨率")
            return
        if action.startswith("video_i2v:duration:"):
            value = action.rsplit(":", 1)[-1]
            try:
                duration = int(value)
            except ValueError:
                duration = 2
            if duration not in {2, 5, 8, 15}:
                await callback.answer("請選擇可用的視頻時長", show_alert=True)
                return
            params["duration"] = duration
            params["duration_selected"] = True
            params.update({"prompt_mode_selected": False, "prompt_extend_selected": False})
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="image")
            await callback.answer("已選擇視頻時長")
            return
        if action.startswith("video_i2v:prompt_mode:"):
            params["use_grok"] = action.endswith(":grok")
            params["prompt_mode_selected"] = True
            params["prompt_mode_label"] = "Grok 生成" if params["use_grok"] else "自定義提交"
            params["prompt_extend"] = False
            params["prompt_extend_selected"] = True
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="prompt")
            await callback.answer("已選擇提示詞方式")
            return
        if action.startswith("video_i2v:extend:"):
            params["prompt_extend"] = False
            params["prompt_extend_selected"] = True
            await state.update_data(**params)
            await _show_video_i2v_step_from_callback(callback, state, step="image")
            await callback.answer()
            return
        await callback.answer()

    async def start_replace_model_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_replace_model")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.replace_model_waiting_for_video)
        await state.update_data(work_dir=str(work_dir))
        await _answer(message, "🌟 視頻模特替換\n步驟 1/4：請上傳原視頻。", reply_markup=_menu_keyboard())

    async def start_replace_product_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_replace_product")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.replace_product_waiting_for_video)
        await state.update_data(work_dir=str(work_dir))
        await _answer(message, "🌟 視頻商品替換\n步驟 1/5：請上傳原視頻。", reply_markup=_menu_keyboard())

    async def start_union_flow(message: Message, state: FSMContext) -> None:
        work_dir = service.create_job_dir(prefix="tg_union")
        await state.clear()
        await state.set_state(ProductionWorkflowForm.union_waiting_for_video)
        await state.update_data(work_dir=str(work_dir))
        await _answer(message, "🌟 聯合替換工作流\n步驟 1/5：請上傳原視頻。", reply_markup=_menu_keyboard())

    async def _current_text_to_image_runtime_params() -> dict[str, Any]:
        try:
            runtime = await asyncio.to_thread(_fetch_webapp_runtime_config)
        except Exception:
            logger.exception("Failed to fetch runtime config from webapp API; falling back to runtime file")
            runtime = _load_runtime_config(config)
        return _text_to_image_runtime_params(runtime)

    async def _set_text_to_image_runtime_state(state: FSMContext, params: dict[str, Any]) -> None:
        await state.update_data(
            text_to_image_workflow_profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
            text_to_image_workflow_path=str(params.get("text_to_image_workflow_path") or ""),
            aspect_ratio=params["aspect_ratio"],
            width=params["width"],
            height=params["height"],
            final_resolution_enabled=bool(params["final_resolution_enabled"]),
            persona_available=bool(params["persona_available"]),
            persona_enabled=bool(params["persona_enabled"]),
            persona_lora=str(params["persona_lora"] or ""),
            ratio_selected=False,
            resolution_selected=False,
            persona_selected=False,
            prompt_mode_selected=False,
            prompt_mode_label="",
            text_to_image_auto_qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
        )

    async def _refresh_text_to_image_runtime_state(state: FSMContext) -> tuple[dict[str, Any], bool]:
        data = await state.get_data()
        current_path = str(data.get("text_to_image_workflow_path") or "").strip()
        current_profile = str(data.get("text_to_image_workflow_profile") or "").strip()
        params = await _current_text_to_image_runtime_params()
        latest_path = str(params.get("text_to_image_workflow_path") or "").strip()
        latest_profile = str(params.get("text_to_image_workflow_profile") or "").strip()
        changed = latest_path != current_path or latest_profile != current_profile
        if changed:
            await _set_text_to_image_runtime_state(state, params)
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
        else:
            params = _text_to_image_params(data)
            params["text_to_image_workflow_path"] = current_path
        return params, changed

    def _text_to_image_prompt_clothing_family(prompt_text: str) -> str:
        text = str(prompt_text or "")
        if re.search(r"空乘|空姐|空服|制服", text):
            return "uniform"
        if re.search(r"护士|護理|护理", text):
            return "nurse"
        if re.search(r"睡裙|吊带裙|吊帶裙|连衣裙|連衣裙|裙装|裙裝", text):
            return "dress"
        if re.search(r"浴袍|睡袍|袍", text):
            return "robe"
        if re.search(r"开衫|開衫|针织|針織", text):
            return "cardigan"
        if re.search(r"吊带|吊帶|背心", text):
            return "camisole"
        if re.search(r"衬衫|襯衫", text):
            return "shirt"
        if re.search(r"短裙|窄裙|包臀|裙", text):
            return "skirt"
        if re.search(r"T恤|上衣", text, re.IGNORECASE):
            return "top"
        return ""

    async def start_text_to_image_flow(message: Message, state: FSMContext) -> None:
        await state.clear()
        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
        runtime = _load_runtime_config(config)
        source = str(runtime.get("comfy_workflow_source") or "remote").strip().lower()
        mappings = runtime.get("local_comfy_workflow_mappings") if source == "local" else runtime.get("remote_comfy_workflow_mappings")
        mappings = mappings if isinstance(mappings, dict) else {}
        workflow_path = str(mappings.get("text_to_image") or "").strip()
        workflow_profile = _text_to_image_workflow_profile_from_path(workflow_path)
        params = _text_to_image_params(
            {
                "text_to_image_workflow_profile": workflow_profile,
                "text_to_image_workflow_path": workflow_path,
            }
        )
        await state.update_data(
            text_to_image_workflow_profile=workflow_profile,
            text_to_image_workflow_path=workflow_path,
            aspect_ratio=params["aspect_ratio"],
            width=params["width"],
            height=params["height"],
            final_resolution_enabled=bool(params["final_resolution_enabled"]),
            persona_available=bool(params["persona_available"]),
            persona_enabled=bool(params["persona_enabled"]),
            persona_lora=str(params["persona_lora"] or ""),
            ratio_selected=False,
            resolution_selected=False,
            persona_selected=False,
            prompt_mode_selected=False,
            prompt_mode_label="",
            text_to_image_auto_qa_enabled=False,
        )
        params = await _current_text_to_image_runtime_params()
        workflow_profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
        await _set_text_to_image_runtime_state(state, params)
        await _answer(message,
            _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
            reply_markup=_text_to_image_ratio_reply_keyboard(profile=workflow_profile, qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
        )

    async def _show_text_to_image_prompt_review(message: Message, state: FSMContext, *, prompt_text: str, selected_model: str = "") -> None:
        data = await state.get_data()
        params = _text_to_image_params(data)
        display_prompt_text = str(prompt_text or "").strip()
        if not display_prompt_text:
            raise RuntimeError("Grok 未返回可用提示詞，請重新生成提示詞。")
        await state.update_data(
            prompt_display_text=display_prompt_text,
            prompt_display_ready=True,
            prompt_display_pending=False,
        )
        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_revision)
        text = "\n\n".join(
            [
                "文生圖 3/3：Grok 已生成最終提示詞。",
                f"畫面比例：{params['aspect_ratio']}，基礎分辨率：{params['width']} x {params['height']}，最終分辨率：{'開啓，預計 ' + params['final'] if params.get('final_resolution_enabled') else '關閉'}",
                f"人設 LoRA：{params.get('persona_label') or '使用人設'}" if params.get("persona_enabled") else ("人設 LoRA：不使用" if params.get("persona_available") else ""),
                f"模型：{selected_model or 'Grok'}",
                "最終提示詞：",
                display_prompt_text,
                "你可以直接使用，也可以繼續告訴 Grok 如何調整。",
            ]
        )
        await _answer(message, text, reply_markup=_text_to_image_prompt_reply_keyboard())

    async def _show_text_to_image_display_pending(message: Message, state: FSMContext, *, exc: Exception | None = None) -> None:
        await state.update_data(prompt_display_ready=False, prompt_display_pending=True)
        await _answer(message,
            "\n".join(
                [
                    "Grok 生成的提示詞還沒有通過中文校驗。",
                    "暫不提交到隊列。請重新生成提示詞，或輸入自定義提示詞。",
                    _format_prompt_display_fallback(exc),
                ]
            ),
            reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
        )

    async def _preview_text_to_image_prompt(
        message: Message,
        state: FSMContext,
        *,
        user_request: str,
        original_user_request: str | None = None,
        reference_image_path: str | None = None,
        latest_only: bool = True,
    ) -> None:
        data = await state.get_data()
        params = _text_to_image_params(data)
        original_for_state = str(original_user_request or data.get("original_user_request") or user_request).strip()
        reference_image = str(reference_image_path or data.get("prompt_reference_image_local_path") or "").strip()
        await state.update_data(
            original_user_request=original_for_state,
            last_grok_user_request=str(user_request or "").strip(),
            last_grok_reference_image_path=reference_image,
            final_prompt_text="",
            selected_model="",
            custom_prompt_used=False,
            prompt_display_text="",
            prompt_display_ready=False,
            prompt_display_pending=False,
        )
        generation_context = (
            f"Aspect ratio: {params['aspect_ratio']}; base resolution: {params['width']} x {params['height']}; "
            f"final resolution: {'enabled, estimated ' + params['final'] if params.get('final_resolution_enabled') else 'disabled, use base resolution'}; "
            f"persona LoRA: {'enabled' if params.get('persona_enabled') else 'disabled'}."
        )
        if reference_image:
            generation_context += " The user uploaded a reference image. First identify the subject, composition, scene, clothing, pose, style, and visible details, then combine them with the text request to write the final prompt."
        payload = {
            "prompt": user_request,
            "prompt_text": user_request,
            "message": user_request,
            "width": params["width"],
            "height": params["height"],
            "aspect_ratio": params["aspect_ratio"],
            "batch_size": PERSON_T2I_DEFAULT_BATCH_SIZE if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "text_to_image_qa_target_count": PERSON_T2I_TELEGRAM_RETURN_COUNT if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "text_to_image_auto_qa_enabled": bool(params.get("text_to_image_auto_qa_enabled", False)),
            "text_to_image_auto_qa_max_attempts": PERSON_T2I_AUTO_QA_MAX_ATTEMPTS if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "final_resolution_enabled": bool(params["final_resolution_enabled"]),
            "persona_enabled": bool(params["persona_enabled"]),
            "persona_lora": str(params.get("persona_lora") or ""),
            "persona_label": str(params.get("persona_label") or ""),
            "tg_use_llm_prompt": True,
            "tg_latest_prompt_only": bool(latest_only),
            "tg_preserve_original_prompt": False,
            "tg_original_user_request": original_for_state,
            "tg_generation_context": generation_context,
            "tg_user_instruction": user_request,
        }
        recent_clothing_families = data.get("tg_recent_clothing_families")
        if isinstance(recent_clothing_families, list):
            payload["tg_recent_clothing_families"] = [str(item or "").strip() for item in recent_clothing_families[-4:] if str(item or "").strip()]
        if reference_image:
            payload["input_image_local_path"] = reference_image
            payload["image_local_path"] = reference_image
        status_message = await _send_transient_status(message, "正在讓 Grok 生成最終提示詞...")
        try:
            result = await _preview_internal_webapp_prompt(chat_id=int(message.chat.id), task_type="text_to_image", params=payload)
            prompt_text = str(result.get("prompt_text") or "").strip()
            selected_model = str(result.get("selected_model") or "").strip()
            if not prompt_text:
                raise RuntimeError("Grok 未返回可用提示詞，請重新生成提示詞。")
            clothing_family = _text_to_image_prompt_clothing_family(prompt_text)
            updated_clothing_families = list(payload.get("tg_recent_clothing_families") or [])
            if clothing_family:
                updated_clothing_families.append(clothing_family)
            updated_clothing_families = updated_clothing_families[-4:]
            await state.update_data(
                original_user_request=original_for_state,
                final_prompt_text=prompt_text,
                selected_model=selected_model,
                prompt_display_text=prompt_text,
                prompt_display_ready=True,
                prompt_display_pending=False,
                tg_recent_clothing_families=updated_clothing_families,
            )
            await _show_text_to_image_prompt_review(message, state, prompt_text=prompt_text, selected_model=selected_model)
        finally:
            await _delete_message_silently(status_message)

    async def _submit_text_to_image_from_state(message: Message, state: FSMContext) -> None:
        params, runtime_changed = await _refresh_text_to_image_runtime_state(state)
        if runtime_changed:
            profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
            await _answer(message,
                "後臺文生圖工作流已更新，"
                "本次未提交到隊列。請按最新參數重新選擇。",
                reply_markup=_text_to_image_ratio_reply_keyboard(profile=profile, qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
            )
            return
        data = await state.get_data()
        params = _text_to_image_params(data)
        final_prompt = str(data.get("final_prompt_text") or "").strip()
        if not final_prompt:
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt)
            await _answer(message, "還沒有可用的 Grok 提示詞，請先輸入圖片需求。")
            return
        if (not bool(data.get("custom_prompt_used"))) and not bool(data.get("prompt_display_ready")):
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_revision)
            await _answer(message,
                "當前提示詞還沒有通過中文校驗，暫不提交到隊列。請重新生成提示詞，或輸入自定義提示詞。",
                reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
            )
            return
        payload = {
            "prompt": final_prompt,
            "prompt_text": final_prompt,
            "message": final_prompt,
            "text_to_image_workflow_profile": str(params.get("text_to_image_workflow_profile") or ""),
            "text_to_image_workflow_path": str(data.get("text_to_image_workflow_path") or ""),
            "width": params["width"],
            "height": params["height"],
            "aspect_ratio": params["aspect_ratio"],
            "batch_size": PERSON_T2I_DEFAULT_BATCH_SIZE if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "text_to_image_qa_target_count": PERSON_T2I_TELEGRAM_RETURN_COUNT if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "text_to_image_auto_qa_enabled": bool(params.get("text_to_image_auto_qa_enabled", False)),
            "text_to_image_auto_qa_max_attempts": PERSON_T2I_AUTO_QA_MAX_ATTEMPTS if str(params.get("text_to_image_workflow_profile") or "") == "person_t2i" else 1,
            "final_resolution_enabled": bool(params["final_resolution_enabled"]),
            "persona_enabled": bool(params["persona_enabled"]),
            "persona_lora": str(params.get("persona_lora") or ""),
            "persona_label": str(params.get("persona_label") or ""),
            "tg_use_llm_prompt": False,
            "tg_llm_prompt_enhanced": True,
            "tg_original_prompt": str(data.get("original_user_request") or "").strip(),
            "tg_llm_rewritten_prompt": final_prompt,
            "tg_llm_selected_model": str(data.get("selected_model") or "").strip(),
            "tg_prompt_display_text": str(data.get("prompt_display_text") or "").strip(),
            "custom_prompt_used": bool(data.get("custom_prompt_used")),
        }
        payload["remote_comfy_node_inputs"] = _text_to_image_remote_node_inputs(params)
        await submit_webapp_task_and_reply(message, "text_to_image", payload)
        await state.clear()

    async def _show_text_to_image_prompt_entry(message: Message, state: FSMContext) -> None:
        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt)
        params = _text_to_image_params(await state.get_data())
        step = _text_to_image_prompt_entry_step_text(params).replace("請輸入", "輸入", 1)
        await _answer(message,
            _text_to_image_status_text(step=step, params=params)
            + "\n\n可以直接輸入圖片需求，也可以上傳參考圖片；上傳圖片時可在圖片說明裏補充要求。Grok 會識別圖片內容，並結合你的文字生成最終提示詞供你確認。",
            reply_markup=_text_to_image_prompt_entry_reply_keyboard(),
        )

    async def _show_text_to_image_prompt_mode(message: Message, state: FSMContext) -> None:
        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
        params = _text_to_image_params(await state.get_data())
        step = _text_to_image_prompt_mode_step_text(params)
        await _answer(message,
            _text_to_image_status_text(step=step, params=params)
            + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。",
            reply_markup=_text_to_image_prompt_mode_reply_keyboard(),
        )

    async def _latest_text_to_image_task(chat_id: int) -> dict[str, Any]:
        tasks = await _fetch_internal_webapp_tg_tasks(chat_id=int(chat_id), limit=20)
        selected = next(
            (
                item
                for item in tasks
                if str(item.get("type") or "").strip() == "text_to_image"
                and str(item.get("status") or "").strip() == "success"
            ),
            None,
        )
        if selected is None:
            selected = next((item for item in tasks if str(item.get("type") or "").strip() == "text_to_image"), None)
        if not isinstance(selected, dict):
            raise RuntimeError("沒有找到最近的文生圖任務")
        task_id = str(selected.get("id") or "").strip()
        if not task_id:
            raise RuntimeError("最近的文生圖任務缺少任務編號")
        return await _fetch_internal_webapp_tg_task_detail(chat_id=int(chat_id), task_id=task_id)

    async def _reroll_latest_text_to_image(message: Message, state: FSMContext) -> None:
        task = await _latest_text_to_image_task(int(message.chat.id))
        if str(task.get("type") or "").strip() != "text_to_image":
            raise RuntimeError("最近任務不是文生圖任務")
        input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
        payload, seed = _text_to_image_reroll_payload(input_payload)
        payload["tg_reroll_from_task_id"] = str(task.get("id") or "").strip()
        await state.clear()
        await _answer(message, f"已切換 seed，重新提交生成。Seed: {seed}", reply_markup=_menu_keyboard())
        await submit_webapp_task_and_reply(message, "text_to_image", payload)
        logger.info("Submitted text_to_image reroll from latest task %s with seed %s", task.get("id"), seed)

    async def _continue_latest_text_to_image(message: Message, state: FSMContext) -> None:
        task = await _latest_text_to_image_task(int(message.chat.id))
        if str(task.get("type") or "").strip() != "text_to_image":
            raise RuntimeError("最近任務不是文生圖任務")
        input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
        restored = _text_to_image_continue_state_from_payload(input_payload)
        await state.clear()
        await state.update_data(**restored)
        await _answer(message, "繼續生成圖片：已載入上次參數，請重新選擇提示詞方式。")
        await _show_text_to_image_prompt_mode(message, state)

    async def _latest_image_edit_task(chat_id: int) -> dict[str, Any]:
        tasks = await _fetch_internal_webapp_tg_tasks(chat_id=int(chat_id), limit=20)
        edit_types = {"single_image_edit", "get_nano_banana"}
        selected = next(
            (
                item
                for item in tasks
                if str(item.get("type") or "").strip() in edit_types
                and str(item.get("status") or "").strip() == "success"
                and item.get("has_download")
            ),
            None,
        )
        if selected is None:
            selected = next(
                (
                    item
                    for item in tasks
                    if str(item.get("type") or "").strip() in edit_types
                    and str(item.get("status") or "").strip() == "success"
                ),
                None,
            )
        if selected is None:
            selected = next((item for item in tasks if str(item.get("type") or "").strip() in edit_types), None)
        if not isinstance(selected, dict):
            raise RuntimeError("沒有找到最近的圖片編輯任務")
        task_id = str(selected.get("id") or "").strip()
        if not task_id:
            raise RuntimeError("最近的圖片編輯任務缺少任務編號")
        return await _fetch_internal_webapp_tg_task_detail(chat_id=int(chat_id), task_id=task_id)

    def _image_edit_resubmit_payload(input_payload: dict[str, Any], task_type: str) -> dict[str, Any]:
        typ = str(task_type or "").strip()
        input_image = str(input_payload.get("input_image_local_path") or input_payload.get("image_local_path") or "").strip()
        reference_image = str(
            input_payload.get("reference_image_local_path")
            or input_payload.get("second_image_local_path")
            or input_payload.get("image2_local_path")
            or ""
        ).strip()
        prompt = str(
            input_payload.get("tg_llm_rewritten_prompt")
            or input_payload.get("prompt_text")
            or input_payload.get("prompt")
            or input_payload.get("message")
            or ""
        ).strip()
        if typ == "single_image_edit":
            reference_image = reference_image or input_image
        if not input_image:
            raise RuntimeError("上次圖片編輯任務缺少原圖，無法重新提交。")
        if typ == "get_nano_banana" and not reference_image:
            raise RuntimeError("上次圖片編輯任務缺少參考圖，無法重新提交。")
        if not prompt:
            raise RuntimeError("上次圖片編輯任務缺少提示詞，無法重新提交。")
        return {
            "input_image_local_path": input_image,
            "reference_image_local_path": reference_image,
            "prompt": prompt,
            "prompt_text": prompt,
            "message": prompt,
            "tg_use_llm_prompt": False,
            "tg_llm_prompt_enhanced": True,
            "tg_original_prompt": str(input_payload.get("tg_original_prompt") or input_payload.get("tg_original_user_request") or prompt).strip(),
            "tg_llm_rewritten_prompt": prompt,
            "tg_rerun_from_task_id": str(input_payload.get("tg_rerun_from_task_id") or "").strip(),
        }

    async def _rerun_latest_image_edit(message: Message, state: FSMContext) -> None:
        task = await _latest_image_edit_task(int(message.chat.id))
        task_type = str(task.get("type") or "").strip()
        if task_type not in {"single_image_edit", "get_nano_banana"}:
            raise RuntimeError("最近任務不是圖片編輯任務")
        input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
        payload = _image_edit_resubmit_payload(input_payload, task_type)
        payload["tg_rerun_from_task_id"] = str(task.get("id") or "").strip()
        await state.clear()
        await submit_webapp_task_and_reply(message, task_type, payload)

    async def _continue_latest_image_edit_result(message: Message, state: FSMContext) -> None:
        task = await _latest_image_edit_task(int(message.chat.id))
        if str(task.get("status") or "").strip() != "success":
            raise RuntimeError("最近的圖片編輯任務尚未成功完成，無法沿用結果圖。")
        result_image = str(task.get("download_path") or "").strip()
        if not result_image or not Path(result_image).exists():
            raise RuntimeError("最近的圖片編輯任務缺少可用結果圖。")
        await state.clear()
        await state.update_data(
            work_dir=str(service.create_job_dir(prefix="tg_image_edit_continue")),
            image_edit_mode="single",
            input_image_local_path=result_image,
            reference_image_local_path=result_image,
            continued_from_task_id=str(task.get("id") or "").strip(),
            **_clear_image_edit_prompt_fields(),
        )
        await _show_image_edit_prompt_mode(message, state, prefix="繼續編輯結果圖\n已把最近生成的圖片設為新原圖。")

    def _face_swap_resubmit_payload(input_payload: dict[str, Any], *, seedvr_upscale: bool = False) -> dict[str, Any]:
        target_image = str(input_payload.get("target_image_local_path") or input_payload.get("image_local_path") or "").strip()
        source_image = str(
            input_payload.get("source_image_local_path")
            or input_payload.get("reference_image_local_path")
            or input_payload.get("face_image_local_path")
            or ""
        ).strip()
        prompt = str(
            input_payload.get("prompt_text")
            or input_payload.get("prompt")
            or input_payload.get("message")
            or "自然換臉，保持目標圖姿態、服裝、光線和背景，只替換臉部身份"
        ).strip()
        if not target_image or not source_image:
            raise RuntimeError("上次人物換臉任務缺少原圖或人臉參考圖，無法重新提交。")
        payload = {
            "target_image_local_path": target_image,
            "source_image_local_path": source_image,
            "prompt": prompt,
            "prompt_text": prompt,
            "message": prompt,
            "tg_use_llm_prompt": False,
            "tg_llm_prompt_enhanced": True,
            "tg_original_prompt": str(input_payload.get("tg_original_prompt") or input_payload.get("tg_user_instruction") or prompt).strip(),
            "tg_llm_rewritten_prompt": prompt,
        }
        if seedvr_upscale:
            seed_value = 0
            try:
                seed_value = int(input_payload.get("face_swap_random_seed") or input_payload.get("seed") or 0)
            except Exception:
                seed_value = 0
            if seed_value > 0:
                payload["seed"] = seed_value
                payload["face_swap_random_seed"] = seed_value
            payload["face_swap_seedvr_upscale"] = True
            payload["remote_comfy_timeout_seconds"] = max(int(input_payload.get("remote_comfy_timeout_seconds") or 900), 900)
        else:
            seed_value = secrets.randbelow(TEXT_TO_IMAGE_MAX_SEED) + 1
            payload["seed"] = seed_value
            payload["face_swap_random_seed"] = seed_value
        return payload

    async def _latest_face_swap_task(chat_id: int) -> dict[str, Any]:
        tasks = await _fetch_internal_webapp_tg_tasks(chat_id=int(chat_id), limit=20)
        selected = next(
            (
                item
                for item in tasks
                if str(item.get("type") or "").strip() == "face_swap"
                and str(item.get("status") or "").strip() == "success"
            ),
            None,
        )
        if selected is None:
            selected = next((item for item in tasks if str(item.get("type") or "").strip() == "face_swap"), None)
        if not isinstance(selected, dict):
            raise RuntimeError("沒有找到最近的人物換臉任務")
        task_id = str(selected.get("id") or "").strip()
        if not task_id:
            raise RuntimeError("最近的人物換臉任務缺少任務編號")
        return await _fetch_internal_webapp_tg_task_detail(chat_id=int(chat_id), task_id=task_id)

    async def _resubmit_face_swap_from_task(
        message: Message,
        state: FSMContext,
        *,
        task_id: str,
        seedvr_upscale: bool = False,
    ) -> None:
        task = await _fetch_internal_webapp_tg_task_detail(chat_id=int(message.chat.id), task_id=str(task_id))
        if str(task.get("type") or "").strip() != "face_swap":
            raise RuntimeError("這條記錄不是人物換臉任務，無法繼續操作。")
        input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
        payload = _face_swap_resubmit_payload(input_payload, seedvr_upscale=seedvr_upscale)
        if seedvr_upscale:
            payload["tg_seedvr_from_task_id"] = str(task_id)
        else:
            payload["tg_rerun_from_task_id"] = str(task_id)
        await state.clear()
        await submit_webapp_task_and_reply(message, "face_swap", payload)

    @router.callback_query(F.data.startswith("face_swap:"))
    async def on_face_swap_callback(callback: CallbackQuery, state: FSMContext) -> None:
        if callback.message is None:
            await callback.answer()
            return
        if not _is_message_authorized(service, callback.message):
            await callback.answer("當前賬號未授權", show_alert=True)
            return
        action = str(callback.data or "")
        if action == "face_swap:main_menu":
            await state.clear()
            try:
                await callback.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
            await _answer(callback.message, "已返回主選單。", reply_markup=_menu_keyboard())
            await callback.answer()
            return
        if action.startswith("face_swap:seedvr:") or action.startswith("face_swap:rerun:"):
            parts = action.split(":", 2)
            task_id = parts[2].strip() if len(parts) >= 3 else ""
            seedvr_upscale = parts[1] == "seedvr"
            if not task_id:
                await callback.answer("缺少任務編號", show_alert=True)
                return
            try:
                await _resubmit_face_swap_from_task(
                    callback.message,
                    state,
                    task_id=task_id,
                    seedvr_upscale=seedvr_upscale,
                )
            except Exception as exc:
                label = "增加解析度 2 倍" if seedvr_upscale else "重新生成"
                await callback.answer(f"{label}提交失敗：{_format_tg_user_error(exc)}", show_alert=True)
                return
            try:
                await callback.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
            await callback.answer("已提交增加解析度 2 倍任務" if seedvr_upscale else "已提交重新生成任務")
            return
        await callback.answer("未知操作", show_alert=True)

    @router.callback_query(F.data.startswith("t2i:"))
    async def on_text_to_image_callback(callback: CallbackQuery, state: FSMContext) -> None:
        if callback.message is None:
            await callback.answer()
            return
        if not _is_message_authorized(service, callback.message):
            await callback.answer("當前賬號未授權", show_alert=True)
            return
        action = str(callback.data or "")
        data = await state.get_data()
        if action == "t2i:main_menu":
            await state.clear()
            try:
                await callback.message.edit_text("已返回主選單。")
            except Exception:
                pass
            await _answer(callback.message, "請選擇任務類型。", reply_markup=_menu_keyboard())
            await callback.answer()
            return
        if action.startswith("t2i:reroll:"):
            task_id = action.rsplit(":", 1)[-1].strip()
            try:
                task = await _fetch_internal_webapp_tg_task_detail(chat_id=int(callback.message.chat.id), task_id=task_id)
            except Exception as exc:
                await callback.answer(f"讀取上次任務失敗：{_format_tg_user_error(exc)}", show_alert=True)
                return
            if str(task.get("type") or "").strip() != "text_to_image":
                await callback.answer("這個任務不是文生圖任務", show_alert=True)
                return
            input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
            try:
                payload, seed = _text_to_image_reroll_payload(input_payload)
            except Exception as exc:
                await callback.answer(f"重新生成圖片失敗：{_format_tg_user_error(exc)}", show_alert=True)
                return
            payload["tg_reroll_from_task_id"] = task_id
            await state.clear()
            await callback.answer("已切換 seed，重新提交生成")
            await submit_webapp_task_and_reply(callback.message, "text_to_image", payload)
            logger.info("Submitted text_to_image reroll from task %s with seed %s", task_id, seed)
            return
        if action.startswith("t2i:continue:"):
            task_id = action.rsplit(":", 1)[-1].strip()
            try:
                task = await _fetch_internal_webapp_tg_task_detail(chat_id=int(callback.message.chat.id), task_id=task_id)
            except Exception as exc:
                await callback.answer(f"讀取上次任務失敗：{_format_tg_user_error(exc)}", show_alert=True)
                return
            if str(task.get("type") or "").strip() != "text_to_image":
                await callback.answer("這個任務不是文生圖任務", show_alert=True)
                return
            input_payload = task.get("input") if isinstance(task.get("input"), dict) else {}
            restored = _text_to_image_continue_state_from_payload(input_payload)
            await state.clear()
            await state.update_data(**restored)
            await _answer(callback.message, "繼續生成圖片：已載入上次參數，請重新選擇提示詞方式。")
            await _show_text_to_image_prompt_mode(callback.message, state)
            await callback.answer("請選擇提示詞方式")
            return
        params, runtime_changed = await _refresh_text_to_image_runtime_state(state)
        if runtime_changed:
            profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
            text = (
                "後臺文生圖工作流已更新，"
                "已同步最新可選參數。\n\n"
                + _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params)
            )
            try:
                await callback.message.edit_text(text, reply_markup=_text_to_image_ratio_keyboard(profile=profile, qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))))
            except Exception:
                await _answer(callback.message, text, reply_markup=_text_to_image_ratio_reply_keyboard(profile=profile, qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))))
            await callback.answer("已同步後臺工作流")
            return
        data = await state.get_data()
        if action == "t2i:qa:toggle":
            current_params = _text_to_image_params(data)
            next_enabled = not bool(current_params.get("text_to_image_auto_qa_enabled", False))
            await state.update_data(text_to_image_auto_qa_enabled=next_enabled)
            params = _text_to_image_params({**data, "text_to_image_auto_qa_enabled": next_enabled})
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
            text = _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params)
            try:
                await callback.message.edit_text(
                    text,
                    reply_markup=_text_to_image_ratio_keyboard(
                        selected_ratio=params["aspect_ratio"] if params.get("ratio_selected") else "",
                        profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                        qa_enabled=next_enabled,
                    ),
                )
            except Exception:
                await _answer(
                    callback.message,
                    text,
                    reply_markup=_text_to_image_ratio_reply_keyboard(
                        profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                        qa_enabled=next_enabled,
                    ),
                )
            await callback.answer("QA 審查已開啟" if next_enabled else "QA 審查已關閉")
            return
        if action.startswith("t2i:ratio:"):
            ratio = action.split(":", 2)[-1]
            if ratio in _text_to_image_ratio_options(str(_text_to_image_params(data).get("text_to_image_workflow_profile") or "zit_final")):
                option = _text_to_image_params({**data, "aspect_ratio": ratio})
                current_params = _text_to_image_params(data)
                final_enabled = bool(current_params["final_resolution_enabled"])
                option["final_resolution_enabled"] = final_enabled
                option["persona_enabled"] = bool(current_params["persona_enabled"])
                option["text_to_image_auto_qa_enabled"] = bool(current_params.get("text_to_image_auto_qa_enabled", False))
                await state.update_data(
                    aspect_ratio=ratio,
                    width=option["width"],
                    height=option["height"],
                    final_resolution_enabled=final_enabled if bool(option.get("final_resolution_available")) else False,
                    persona_available=bool(option["persona_available"]),
                    persona_enabled=bool(option["persona_enabled"]),
                    persona_lora=str(option.get("persona_lora") or ""),
                    ratio_selected=True,
                    resolution_selected=not bool(option.get("final_resolution_available")),
                    persona_selected=False,
                    prompt_mode_selected=False,
                    prompt_mode_label="",
                    text_to_image_auto_qa_enabled=bool(current_params.get("text_to_image_auto_qa_enabled", False)),
                )
                option["ratio_selected"] = True
                option["final_resolution_enabled"] = final_enabled if bool(option.get("final_resolution_available")) else False
                option["resolution_selected"] = not bool(option.get("final_resolution_available"))
                option["persona_selected"] = False
                option["prompt_mode_selected"] = False
                option["prompt_mode_label"] = ""
                if not bool(option.get("final_resolution_available")):
                    if option.get("persona_available"):
                        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                        text = _text_to_image_status_text(step=_text_to_image_persona_step_text(option), params=option)
                        markup = _text_to_image_persona_keyboard(
                            persona_enabled=bool(option["persona_enabled"]),
                            persona_lora=str(option.get("persona_lora") or ""),
                            selected=False,
                            profile=str(option.get("text_to_image_workflow_profile") or "zit_final"),
                        )
                    else:
                        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
                        text = _text_to_image_status_text(step=_text_to_image_prompt_mode_step_text(option), params=option) + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。"
                        markup = _text_to_image_prompt_mode_keyboard()
                    try:
                        await callback.message.edit_text(text, reply_markup=markup)
                    except Exception:
                        await _answer(callback.message, text, reply_markup=markup)
                    await callback.answer("已使用基礎分辨率")
                    return
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
                try:
                    await callback.message.edit_text(
                        _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=option),
                        reply_markup=_text_to_image_resolution_keyboard(
                            final_resolution_enabled=final_enabled,
                            final_resolution_available=bool(option.get("final_resolution_available")),
                        ),
                    )
                except Exception:
                    await _answer(callback.message,
                        _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=option),
                        reply_markup=_text_to_image_resolution_keyboard(
                            final_resolution_enabled=final_enabled,
                            final_resolution_available=bool(option.get("final_resolution_available")),
                        ),
                    )
                await callback.answer("請選擇分辨率")
                return
            await callback.answer("無效比例", show_alert=True)
            return
        if action == "t2i:next:resolution":
            params = _text_to_image_params(data)
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
            try:
                await callback.message.edit_text(
                    _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=params),
                    reply_markup=_text_to_image_resolution_keyboard(
                        final_resolution_enabled=bool(params["final_resolution_enabled"]),
                        selected=bool(params.get("resolution_selected")),
                        final_resolution_available=bool(params.get("final_resolution_available")),
                    ),
                )
            except Exception:
                await _answer(callback.message,
                    _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=params),
                    reply_markup=_text_to_image_resolution_keyboard(
                        final_resolution_enabled=bool(params["final_resolution_enabled"]),
                        selected=bool(params.get("resolution_selected")),
                        final_resolution_available=bool(params.get("final_resolution_available")),
                    ),
                )
            await callback.answer("請選擇分辨率")
            return
        if action == "t2i:back:ratio":
            params = _text_to_image_params(data)
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
            try:
                await callback.message.edit_text(
                    _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
                    reply_markup=_text_to_image_ratio_keyboard(
                        selected_ratio=params["aspect_ratio"] if params.get("ratio_selected") else "",
                        profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                        qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
                    ),
                )
            except Exception:
                await _answer(callback.message,
                    _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
                    reply_markup=_text_to_image_ratio_keyboard(
                        selected_ratio=params["aspect_ratio"] if params.get("ratio_selected") else "",
                        profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                        qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
                    ),
                )
            await callback.answer("已返回比例")
            return
        if action == "t2i:choose_prompt_mode":
            await _show_text_to_image_prompt_mode(callback.message, state)
            await callback.answer("請選擇提示詞方式")
            return
        if action == "t2i:ready_prompt":
            await state.update_data(prompt_mode_selected=True, prompt_mode_label="Grok 生成")
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt)
            params = _text_to_image_params({**data, "prompt_mode_selected": True, "prompt_mode_label": "Grok 生成"})
            text = (
                _text_to_image_status_text(
                    step=_text_to_image_prompt_entry_step_text(params),
                    params=params,
                )
                + "\n\n可以直接輸入圖片需求，也可以上傳參考圖片；上傳圖片時可在圖片說明裏補充要求。Grok 會識別圖片內容，並結合你的文字生成最終提示詞供你確認。"
            )
            try:
                await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_entry_keyboard())
            except Exception:
                await _answer(callback.message, text, reply_markup=_text_to_image_prompt_entry_keyboard())
            await callback.answer("請輸入需求或上傳參考圖")
            return
        if action.startswith("t2i:final:") or action == "t2i:toggle_final":
            params = _text_to_image_params(data)
            if action == "t2i:toggle_final":
                final_enabled = not bool(params["final_resolution_enabled"])
            else:
                final_enabled = action.endswith(":on")
            if final_enabled and not bool(params.get("final_resolution_available")):
                await callback.answer("當前工作流不支持最終分辨率，請選擇使用基礎分辨率。", show_alert=True)
                return
            await state.update_data(
                final_resolution_enabled=final_enabled,
                resolution_selected=True,
                persona_selected=False,
                prompt_mode_selected=False,
                prompt_mode_label="",
            )
            params = _text_to_image_params(
                {
                    **data,
                    "final_resolution_enabled": final_enabled,
                    "resolution_selected": True,
                    "persona_selected": False,
                    "prompt_mode_selected": False,
                    "prompt_mode_label": "",
                }
            )
            if params.get("persona_available"):
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                text = _text_to_image_status_text(step=_text_to_image_persona_step_text(params), params=params)
                markup = _text_to_image_persona_keyboard(
                    persona_enabled=bool(params["persona_enabled"]),
                    persona_lora=str(params.get("persona_lora") or ""),
                    selected=bool(params.get("persona_selected")),
                    profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                )
                try:
                    await callback.message.edit_text(text, reply_markup=markup)
                except Exception:
                    await _answer(callback.message, text, reply_markup=markup)
                await callback.answer("請選擇人設")
            else:
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
                step = _text_to_image_prompt_mode_step_text(params)
                text = _text_to_image_status_text(step=step, params=params) + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。"
                try:
                    await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_mode_keyboard())
                except Exception:
                    await _answer(callback.message, text, reply_markup=_text_to_image_prompt_mode_keyboard())
                await callback.answer("請選擇提示詞方式")
            return
        if action == "t2i:next:persona":
            params = _text_to_image_params(data)
            if params.get("persona_available"):
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                text = _text_to_image_status_text(step=_text_to_image_persona_step_text(params), params=params)
                markup = _text_to_image_persona_keyboard(
                    persona_enabled=bool(params["persona_enabled"]),
                    persona_lora=str(params.get("persona_lora") or ""),
                    selected=bool(params.get("persona_selected")),
                    profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                )
                try:
                    await callback.message.edit_text(text, reply_markup=markup)
                except Exception:
                    await _answer(callback.message, text, reply_markup=markup)
                await callback.answer("請選擇人設")
            else:
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
                text = _text_to_image_status_text(step=_text_to_image_prompt_mode_step_text(params), params=params) + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。"
                try:
                    await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_mode_keyboard())
                except Exception:
                    await _answer(callback.message, text, reply_markup=_text_to_image_prompt_mode_keyboard())
                await callback.answer("請選擇提示詞方式")
            return
        if action == "t2i:back:resolution":
            params = _text_to_image_params(data)
            await state.update_data(persona_selected=False, prompt_mode_selected=False, prompt_mode_label="")
            if not _text_to_image_has_resolution_step(params):
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
                try:
                    await callback.message.edit_text(
                        _text_to_image_status_text(step="1/3 請選擇圖像比例", params=params),
                        reply_markup=_text_to_image_ratio_keyboard(
                            selected_ratio=params["aspect_ratio"] if params.get("ratio_selected") else "",
                            profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                            qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
                        ),
                    )
                except Exception:
                    await _answer(callback.message,
                        _text_to_image_status_text(step="1/3 請選擇圖像比例", params=params),
                        reply_markup=_text_to_image_ratio_keyboard(
                            selected_ratio=params["aspect_ratio"] if params.get("ratio_selected") else "",
                            profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                            qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
                        ),
                    )
                await callback.answer("已返回比例")
                return
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
            params = _text_to_image_params(
                {
                    **data,
                    "persona_selected": False,
                    "prompt_mode_selected": False,
                    "prompt_mode_label": "",
                }
            )
            try:
                await callback.message.edit_text(
                    _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=params),
                    reply_markup=_text_to_image_resolution_keyboard(
                        final_resolution_enabled=bool(params["final_resolution_enabled"]),
                        selected=bool(params.get("resolution_selected")),
                        final_resolution_available=bool(params.get("final_resolution_available")),
                    ),
                )
            except Exception:
                await _answer(callback.message,
                    _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=params),
                    reply_markup=_text_to_image_resolution_keyboard(
                        final_resolution_enabled=bool(params["final_resolution_enabled"]),
                        selected=bool(params.get("resolution_selected")),
                        final_resolution_available=bool(params.get("final_resolution_available")),
                    ),
                )
            await callback.answer("已返回分辨率")
            return
        if action.startswith("t2i:persona:"):
            persona_key = action.rsplit(":", 1)[-1]
            params = _text_to_image_params(data)
            profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
            options = _text_to_image_persona_options(profile=profile)
            persona_enabled = persona_key != "off"
            selected_lora = ""
            if persona_enabled:
                for option in options:
                    if option["id"] == persona_key:
                        selected_lora = option["path"]
                        break
                if not selected_lora:
                    await callback.answer("沒有找到這個人設", show_alert=True)
                    return
            await state.update_data(
                persona_enabled=persona_enabled,
                persona_lora=selected_lora or _text_to_image_default_persona_path(profile=profile),
                persona_selected=True,
                prompt_mode_selected=False,
                prompt_mode_label="",
            )
            params = _text_to_image_params(
                {
                    **data,
                    "persona_enabled": persona_enabled,
                    "persona_lora": selected_lora,
                    "persona_selected": True,
                    "prompt_mode_selected": False,
                    "prompt_mode_label": "",
                }
            )
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
            text = (
                _text_to_image_status_text(step=_text_to_image_prompt_mode_step_text(params), params=params)
                + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。"
            )
            try:
                await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_mode_keyboard())
            except Exception:
                await _answer(callback.message, text, reply_markup=_text_to_image_prompt_mode_keyboard())
            await callback.answer("請選擇提示詞方式")
            return
        if action == "t2i:next:prompt":
            params = _text_to_image_params(data)
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
            text = (
                _text_to_image_status_text(step=_text_to_image_prompt_mode_step_text(params), params=params)
                + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。"
            )
            try:
                await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_mode_keyboard())
            except Exception:
                await _answer(callback.message, text, reply_markup=_text_to_image_prompt_mode_keyboard())
            await callback.answer("請選擇提示詞方式")
            return
        if action == "t2i:back:prompt_mode":
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
            params = _text_to_image_params(data)
            step = _text_to_image_prompt_mode_step_text(params)
            text = _text_to_image_status_text(step=step, params=params) + "\n\n請選擇讓 Grok 根據你的需求生成提示詞，或直接輸入自定義最終提示詞。"
            try:
                await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_mode_keyboard())
            except Exception:
                await _answer(callback.message, text, reply_markup=_text_to_image_prompt_mode_keyboard())
            await callback.answer("已返回提示詞方式")
            return
        if action == "t2i:back:persona":
            params = _text_to_image_params(data)
            await state.update_data(prompt_mode_selected=False, prompt_mode_label="")
            params = _text_to_image_params({**data, "prompt_mode_selected": False, "prompt_mode_label": ""})
            if params.get("persona_available"):
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                text = _text_to_image_status_text(step=_text_to_image_persona_step_text(params), params=params)
                markup = _text_to_image_persona_keyboard(
                    persona_enabled=bool(params["persona_enabled"]),
                    persona_lora=str(params.get("persona_lora") or ""),
                    selected=bool(params.get("persona_selected")),
                    profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                )
                try:
                    await callback.message.edit_text(text, reply_markup=markup)
                except Exception:
                    await _answer(callback.message, text, reply_markup=markup)
            else:
                if not _text_to_image_has_resolution_step(params):
                    await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
                    text = _text_to_image_status_text(step="1/2 請選擇圖像比例", params=params)
                    markup = _text_to_image_ratio_keyboard(
                        selected_ratio=params["aspect_ratio"] if params.get("ratio_selected") else "",
                        profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                        qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
                    )
                    try:
                        await callback.message.edit_text(text, reply_markup=markup)
                    except Exception:
                        await _answer(callback.message, text, reply_markup=markup)
                    await callback.answer("已返回比例")
                    return
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
                text = _text_to_image_status_text(step="2/3 請選擇最終分辨率", params=params)
                markup = _text_to_image_resolution_keyboard(
                    final_resolution_enabled=bool(params["final_resolution_enabled"]),
                    selected=bool(params.get("resolution_selected")),
                    final_resolution_available=bool(params.get("final_resolution_available")),
                )
                try:
                    await callback.message.edit_text(text, reply_markup=markup)
                except Exception:
                    await _answer(callback.message, text, reply_markup=markup)
            await callback.answer("已返回上一步")
            return
        if action == "t2i:settings":
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
            params = _text_to_image_params(data)
            await state.update_data(
                ratio_selected=False,
                resolution_selected=False,
                persona_selected=False,
                prompt_mode_selected=False,
                prompt_mode_label="",
            )
            params = _text_to_image_params(
                {
                    **data,
                    "ratio_selected": False,
                    "resolution_selected": False,
                    "persona_selected": False,
                    "prompt_mode_selected": False,
                    "prompt_mode_label": "",
                }
            )
            await _answer(callback.message,
                _text_to_image_status_text(step="1/4 請重新選擇圖像比例", params=params),
                reply_markup=_text_to_image_ratio_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final"), qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
            )
            await callback.answer()
            return
        if action == "t2i:adjust":
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_revision)
            await _answer(callback.message, "請直接輸入你希望 Grok 如何調整提示詞，例如：更寫實、換成夜景、保留人物姿勢但改變服裝。")
            await callback.answer()
            return
        if action == "t2i:custom_prompt":
            await state.update_data(prompt_mode_selected=True, prompt_mode_label="自定義輸入")
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_custom_prompt)
            params = _text_to_image_params({**data, "prompt_mode_selected": True, "prompt_mode_label": "自定義輸入"})
            text = (
                _text_to_image_status_text(
                    step=_text_to_image_prompt_entry_step_text(params, custom=True),
                    params=params,
                )
                + "\n\n請輸入自定義最終提示詞。下一條消息會跳過 Grok，直接提交到 ComfyUI 工作流生成。"
            )
            try:
                await callback.message.edit_text(text, reply_markup=_text_to_image_prompt_entry_keyboard())
            except Exception:
                await _answer(callback.message, text, reply_markup=_text_to_image_prompt_entry_keyboard())
            await callback.answer()
            return
        if action == "t2i:regen":
            original = str(data.get("last_grok_user_request") or data.get("original_user_request") or data.get("final_prompt_text") or "").strip()
            if not original:
                await callback.answer("沒有原始需求，請重新輸入", show_alert=True)
                return
            try:
                await _preview_text_to_image_prompt(
                    callback.message,
                    state,
                    user_request=original,
                    reference_image_path=str(data.get("last_grok_reference_image_path") or data.get("prompt_reference_image_local_path") or ""),
                )
            except Exception as exc:
                await _answer(callback.message,
                    f"Grok 提示詞生成失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
                )
            await callback.answer()
            return
        if action == "t2i:retry_display":
            final_prompt = _strip_prompt_char_count_note(str(data.get("final_prompt_text") or "").strip(), preserve_english=True)
            if not final_prompt:
                await callback.answer("沒有已保存的提示詞，請重新生成", show_alert=True)
                return
            try:
                await _show_text_to_image_prompt_review(
                    callback.message,
                    state,
                    prompt_text=final_prompt,
                    selected_model=str(data.get("selected_model") or "").strip(),
                )
                await callback.answer("中文預覽已通過")
            except Exception as exc:
                await _show_text_to_image_display_pending(callback.message, state, exc=exc)
                await callback.answer("中文預覽未通過", show_alert=True)
            return
        if action == "t2i:submit":
            try:
                await _submit_text_to_image_from_state(callback.message, state)
                await callback.answer("已提交生成")
            except Exception as exc:
                await _answer(callback.message, f"文生圖任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
                await callback.answer()
            return

    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_persona)
    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
    async def on_text_to_image_step_message(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        params, runtime_changed = await _refresh_text_to_image_runtime_state(state)
        if runtime_changed:
            profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
            await _answer(message,
                "後臺文生圖工作流已更新，"
                "已同步最新可選參數。\n\n"
                + _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
                reply_markup=_text_to_image_ratio_reply_keyboard(profile=profile, qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
            )
            return
        data = await state.get_data()
        params = _text_to_image_params(data)
        current_state = await state.get_state()
        text = _message_text(message)

        if current_state == ProductionWorkflowForm.text_to_image_waiting_for_ratio.state:
            if text in {"✅ QA 審查：開啟", "☑️ QA 審查：關閉"}:
                next_enabled = not bool(params.get("text_to_image_auto_qa_enabled", False))
                await state.update_data(text_to_image_auto_qa_enabled=next_enabled)
                params = _text_to_image_params({**data, "text_to_image_auto_qa_enabled": next_enabled})
                await _answer(message,
                    _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
                    reply_markup=_text_to_image_ratio_reply_keyboard(
                        profile=str(params.get("text_to_image_workflow_profile") or "zit_final"),
                        qa_enabled=next_enabled,
                    ),
                )
                return
            selected_ratio = ""
            profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
            for ratio, option in _text_to_image_ratio_options(profile).items():
                if text == str(option.get("label") or ""):
                    selected_ratio = ratio
                    break
            if selected_ratio:
                option = _text_to_image_params({**data, "aspect_ratio": selected_ratio})
                option["ratio_selected"] = True
                option["resolution_selected"] = False
                option["persona_selected"] = False
                option["prompt_mode_selected"] = False
                option["text_to_image_auto_qa_enabled"] = bool(params.get("text_to_image_auto_qa_enabled", False))
                await state.update_data(
                    aspect_ratio=selected_ratio,
                    width=option["width"],
                    height=option["height"],
                    final_resolution_enabled=bool(option["final_resolution_enabled"]) if bool(option.get("final_resolution_available")) else False,
                    ratio_selected=True,
                    resolution_selected=not bool(option.get("final_resolution_available")),
                    persona_selected=False,
                    prompt_mode_selected=False,
                    prompt_mode_label="",
                    text_to_image_auto_qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False)),
                )
                option["final_resolution_enabled"] = bool(option["final_resolution_enabled"]) if bool(option.get("final_resolution_available")) else False
                option["resolution_selected"] = not bool(option.get("final_resolution_available"))
                if not bool(option.get("final_resolution_available")):
                    if option.get("persona_available"):
                        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                        await _answer(message,
                            _text_to_image_status_text(step=_text_to_image_persona_step_text(option), params=option),
                            reply_markup=_text_to_image_persona_reply_keyboard(profile=str(option.get("text_to_image_workflow_profile") or "zit_final")),
                        )
                    else:
                        await _show_text_to_image_prompt_mode(message, state)
                    return
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
                await _answer(message,
                    _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=option),
                    reply_markup=_text_to_image_resolution_reply_keyboard(
                        final_resolution_available=bool(option.get("final_resolution_available"))
                    ),
                )
                return
            await _answer(message,
                _text_to_image_status_text(step="1/4 請先選擇圖像比例", params=params),
                reply_markup=_text_to_image_ratio_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final"), qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
            )
            return

        if current_state == ProductionWorkflowForm.text_to_image_waiting_for_resolution.state:
            if text == "上一步":
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
                await _answer(message,
                    _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
                    reply_markup=_text_to_image_ratio_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final"), qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
                )
                return
            if text in {"使用基礎分辨率", "開啓最終分辨率"}:
                if text == "開啓最終分辨率" and not bool(params.get("final_resolution_available")):
                    await _answer(message,
                        "當前工作流不支持最終分辨率，請選擇“使用基礎分辨率”。",
                        reply_markup=_text_to_image_resolution_reply_keyboard(final_resolution_available=False),
                    )
                    return
                final_enabled = text == "開啓最終分辨率"
                await state.update_data(
                    final_resolution_enabled=final_enabled,
                    resolution_selected=True,
                    persona_selected=False,
                    prompt_mode_selected=False,
                    prompt_mode_label="",
                )
                params = _text_to_image_params(
                    {
                        **data,
                        "final_resolution_enabled": final_enabled,
                        "resolution_selected": True,
                        "persona_selected": False,
                        "prompt_mode_selected": False,
                        "prompt_mode_label": "",
                    }
                )
                if params.get("persona_available"):
                    await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                    await _answer(message,
                        _text_to_image_status_text(step=_text_to_image_persona_step_text(params), params=params),
                        reply_markup=_text_to_image_persona_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final")),
                    )
                else:
                    await _show_text_to_image_prompt_mode(message, state)
                return
                await _answer(message,
                    _text_to_image_status_text(step="2/4 請先選擇最終分辨率", params=params),
                    reply_markup=_text_to_image_resolution_reply_keyboard(
                        final_resolution_available=bool(params.get("final_resolution_available"))
                    ),
            )
            return

        if current_state == ProductionWorkflowForm.text_to_image_waiting_for_persona.state:
            if text == "上一步":
                await state.update_data(persona_selected=False, prompt_mode_selected=False, prompt_mode_label="")
                if not _text_to_image_has_resolution_step(params):
                    await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
                    await _answer(message,
                        _text_to_image_status_text(step="1/3 請選擇圖像比例", params=params),
                        reply_markup=_text_to_image_ratio_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final"), qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
                    )
                    return
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
                await _answer(message,
                    _text_to_image_status_text(step="2/4 請選擇最終分辨率", params=params),
                    reply_markup=_text_to_image_resolution_reply_keyboard(
                        final_resolution_available=bool(params.get("final_resolution_available"))
                    ),
                )
                return
            persona_enabled = text != "不使用人設"
            selected_lora = ""
            if persona_enabled:
                for option in _text_to_image_persona_options(profile=str(params.get("text_to_image_workflow_profile") or "zit_final")):
                    if text == str(option.get("label") or ""):
                        selected_lora = str(option.get("path") or "")
                        break
                if not selected_lora:
                    await _answer(message,
                        _text_to_image_status_text(step=_text_to_image_persona_step_text(params, prefix="請先選擇"), params=params),
                        reply_markup=_text_to_image_persona_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final")),
                    )
                    return
            await state.update_data(
                persona_enabled=persona_enabled,
                persona_lora=selected_lora or _text_to_image_default_persona_path(profile=str(params.get("text_to_image_workflow_profile") or "zit_final")),
                persona_selected=True,
                prompt_mode_selected=False,
                prompt_mode_label="",
            )
            params = _text_to_image_params(
                {
                    **data,
                    "persona_enabled": persona_enabled,
                    "persona_lora": selected_lora,
                    "persona_selected": True,
                    "prompt_mode_selected": False,
                    "prompt_mode_label": "",
                }
            )
            await _show_text_to_image_prompt_mode(message, state)
            return

        if current_state == ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode.state:
            if text == "上一步":
                if params.get("persona_available"):
                    await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_persona)
                    await _answer(message,
                        _text_to_image_status_text(step=_text_to_image_persona_step_text(params), params=params),
                        reply_markup=_text_to_image_persona_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final")),
                    )
                else:
                    if not _text_to_image_has_resolution_step(params):
                        await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
                        await _answer(message,
                            _text_to_image_status_text(step="1/2 請選擇圖像比例", params=params),
                            reply_markup=_text_to_image_ratio_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final"), qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
                        )
                        return
                    await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_resolution)
                    await _answer(message,
                        _text_to_image_status_text(step="2/3 請選擇最終分辨率", params=params),
                        reply_markup=_text_to_image_resolution_reply_keyboard(
                            final_resolution_available=bool(params.get("final_resolution_available"))
                        ),
                    )
                return
            if text == "讓 Grok 生成提示詞":
                await state.update_data(prompt_mode_selected=True, prompt_mode_label="Grok 生成")
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt)
                await _answer(message,
                    _text_to_image_status_text(
                        step=_text_to_image_prompt_entry_step_text(params),
                        params={**params, "prompt_mode_selected": True, "prompt_mode_label": "Grok 生成"},
                    )
                    + "\n\n可以直接輸入圖片需求，也可以上傳參考圖片；上傳圖片時可在圖片說明裏補充要求。Grok 會識別圖片內容，並結合你的文字生成最終提示詞供你確認。",
                    reply_markup=_text_to_image_prompt_entry_reply_keyboard(),
                )
                return
            if text == "輸入自定義提示詞":
                await state.update_data(prompt_mode_selected=True, prompt_mode_label="自定義提示詞", custom_prompt_used=True)
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_custom_prompt)
                await _answer(message,
                    _text_to_image_status_text(
                        step=_text_to_image_prompt_entry_step_text(params, custom=True),
                        params={**params, "prompt_mode_selected": True, "prompt_mode_label": "自定義提示詞"},
                    )
                    + "\n\n請輸入自定義最終提示詞。",
                    reply_markup=_text_to_image_prompt_entry_reply_keyboard(),
                )
                return
            step = _text_to_image_prompt_mode_step_text(params, prefix="請先選擇")
            await _answer(message,
                _text_to_image_status_text(step=step, params=params),
                reply_markup=_text_to_image_prompt_mode_reply_keyboard(),
            )

    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_prompt)
    async def on_text_to_image_prompt_v2(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        params, runtime_changed = await _refresh_text_to_image_runtime_state(state)
        if runtime_changed:
            profile = str(params.get("text_to_image_workflow_profile") or "zit_final")
            await _answer(message,
                "後臺文生圖工作流已更新，"
                "已同步最新可選參數。\n\n"
                + _text_to_image_status_text(step="1/4 請選擇圖像比例", params=params),
                reply_markup=_text_to_image_ratio_reply_keyboard(profile=profile, qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
            )
            return
        prompt = _message_text(message)
        data = await state.get_data()
        if prompt == "使用這個提示詞生成" and not _image_ext_from_message(message):
            if str(data.get("final_prompt_text") or "").strip():
                try:
                    await _submit_text_to_image_from_state(message, state)
                except Exception as exc:
                    await _answer(message, f"文生圖任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_text_to_image_prompt_reply_keyboard())
                return
            await _answer(message, "還沒有可用的最終提示詞，請先輸入圖片需求。", reply_markup=_text_to_image_prompt_entry_reply_keyboard())
            return
        if prompt == "上一步" and not _image_ext_from_message(message):
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
            await _show_text_to_image_prompt_mode(message, state)
            return
        if prompt == "輸入自定義提示詞" and not _image_ext_from_message(message):
            await state.update_data(prompt_mode_selected=True, prompt_mode_label="自定義輸入")
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_custom_prompt)
            params = _text_to_image_params({**data, "prompt_mode_selected": True, "prompt_mode_label": "自定義輸入"})
            await _answer(message,
                _text_to_image_status_text(
                    step=_text_to_image_prompt_entry_step_text(params, custom=True),
                    params=params,
                )
                + "\n\n請輸入自定義最終提示詞。下一條消息會跳過 Grok，直接提交到 ComfyUI 工作流生成。",
                reply_markup=_text_to_image_prompt_entry_reply_keyboard(),
            )
            return
        if prompt == "重新生成提示詞" and not _image_ext_from_message(message):
            original = str(data.get("last_grok_user_request") or data.get("original_user_request") or "").strip()
            if not original:
                await _answer(message, "沒有原始需求，請先輸入圖片需求。", reply_markup=_text_to_image_prompt_entry_reply_keyboard())
                return
            try:
                await _preview_text_to_image_prompt(
                    message,
                    state,
                    user_request=original,
                    reference_image_path=str(data.get("last_grok_reference_image_path") or data.get("prompt_reference_image_local_path") or ""),
                )
            except Exception as exc:
                await _answer(message,
                    f"Grok 提示詞生成失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
                )
            return
        reference_image_path = ""
        image_suffix = _image_ext_from_message(message)
        if image_suffix:
            work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_text_to_image_ref")))
            target = work_dir / f"prompt_reference_{int(message.message_id)}{image_suffix}"
            await _download_message_media(message, target)
            reference_image_path = str(target.resolve())
            await state.update_data(
                work_dir=str(work_dir),
                prompt_reference_image_local_path=reference_image_path,
            )
            await _answer(message, "已更新參考圖。")
            if not prompt:
                prompt = "CRITICAL FORMAT RULE - COPY THIS EXACT PATTERN: The prompt MUST be ONE continuous Chinese sentence with EXACTLY these 9 segments separated by commas (，): 1.[人物+全身姿態+場景] 2.穿着[服裝] 3.[暴露器官] 4.她的[左手動作]而[右手動作] 5.她的身體[朝向] 6.她的頭[轉向+眼神] 7.[背景] 8.[光線] 9.[技術參數]。 You MUST include segment 4, 5, and 6 exactly as shown. DO NOT skip them. DO NOT change their order. Example: 一位美麗女郎全身站立在豪華臥室中，穿着優雅的黑色絲綢睡裙，薄薄的意大利麪條肩帶，低領部部分解開露出深深的乳溝和側乳，她的左手放在臀部上而右手觸摸着裸露的大腿，她的身體微微側向一邊朝向鏡頭，她的頭轉向直視鏡頭帶着誘惑的眼神，臥室背景有大大的特大號牀鋪，白色牀單凌亂不堪，柔和的臥室燈投射出溫柔的陰影，淺景深讓主體清晰而背景微微模糊，真實皮膚紋理，細節的織物褶皺，自然的身體曲線，高細節，寫實攝影風格，電影攝影。 This is the ONLY acceptable format."
        if not prompt:
            params = _text_to_image_params(data)
            await _answer(message,
                _text_to_image_status_text(step=_text_to_image_prompt_entry_step_text(params), params=params)
                + "\n\n可以傳送文字需求，也可以上傳一張參考圖片；上傳圖片時可在圖片說明裏補充要求。",
                reply_markup=_text_to_image_prompt_entry_reply_keyboard(),
            )
            return
        try:
            await _preview_text_to_image_prompt(
                message,
                state,
                user_request=prompt,
                reference_image_path=reference_image_path or str(data.get("prompt_reference_image_local_path") or ""),
            )
        except Exception as exc:
            params = _text_to_image_params(await state.get_data())
            await _answer(message,
                f"Grok 提示詞生成失敗：{_format_grok_preview_error(exc)}",
                reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
            )

    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_revision)
    async def on_text_to_image_revision(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        revision = _message_text(message)
        if not revision:
            await _answer(message, "請直接輸入調整要求，或點擊“使用這個提示詞生成”。", reply_markup=_text_to_image_prompt_reply_keyboard())
            return
        data = await state.get_data()
        if revision == "使用這個提示詞生成":
            try:
                await _submit_text_to_image_from_state(message, state)
            except Exception as exc:
                await _answer(message, f"文生圖任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_text_to_image_prompt_reply_keyboard())
            return
        if revision in {"輸入自定義提示詞提交", "輸入自定義提示詞"}:
            await state.update_data(prompt_mode_selected=True, prompt_mode_label="自定義輸入")
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_custom_prompt)
            await _answer(message, "請輸入自定義最終提示詞。下一條消息會跳過 Grok，直接提交到 ComfyUI 工作流生成。", reply_markup=_text_to_image_prompt_entry_reply_keyboard())
            return
        if revision == "上一步":
            await _show_text_to_image_prompt_mode(message, state)
            return
        if revision == "繼續讓 Grok 調整":
            await _answer(message, "請直接輸入你希望 Grok 如何調整提示詞，例如：更寫實、換成夜景、保留人物姿勢但改變服裝。", reply_markup=_text_to_image_prompt_reply_keyboard())
            return
        if revision == "重新生成提示詞":
            original = str(data.get("last_grok_user_request") or data.get("original_user_request") or data.get("final_prompt_text") or "").strip()
            if not original:
                await _answer(message, "沒有原始需求，請重新輸入。", reply_markup=_text_to_image_prompt_entry_reply_keyboard())
                await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt)
                return
            try:
                await _preview_text_to_image_prompt(
                    message,
                    state,
                    user_request=original,
                    reference_image_path=str(data.get("last_grok_reference_image_path") or data.get("prompt_reference_image_local_path") or ""),
                )
            except Exception as exc:
                await _answer(message,
                    f"Grok 提示詞生成失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
                )
            return
        if revision == "返回參數設定":
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_ratio)
            params = _text_to_image_params(
                {
                    **data,
                    "ratio_selected": False,
                    "resolution_selected": False,
                    "persona_selected": False,
                    "prompt_mode_selected": False,
                    "prompt_mode_label": "",
                }
            )
            await state.update_data(
                ratio_selected=False,
                resolution_selected=False,
                persona_selected=False,
                prompt_mode_selected=False,
                prompt_mode_label="",
            )
            await _answer(message,
                _text_to_image_status_text(step="1/4 請重新選擇圖像比例", params=params),
                reply_markup=_text_to_image_ratio_reply_keyboard(profile=str(params.get("text_to_image_workflow_profile") or "zit_final"), qa_enabled=bool(params.get("text_to_image_auto_qa_enabled", False))),
            )
            return
        original = str(data.get("original_user_request") or "").strip()
        current = str(data.get("final_prompt_text") or "").strip()
        combined = "\n".join(
            part
            for part in [
                f"Original request: {original}" if original else "",
                f"Current prompt: {current}" if current else "",
                f"Revision request: {revision}",
                "Rewrite the current prompt according to the revision request, preserve explicit user requirements, and output only the latest final prompt.",
                "Do not output labels such as Original request, Current prompt, or Revision request. Do not repeat the old prompt as a separate block, and do not paste the context text into the result.",
            ]
            if part
        )
        try:
            await _preview_text_to_image_prompt(
                message,
                state,
                user_request=combined,
                original_user_request=original or revision,
                latest_only=True,
            )
        except Exception as exc:
            await _answer(message,
                f"Grok 提示詞調整失敗：{_format_grok_preview_error(exc)}",
                reply_markup=_text_to_image_prompt_failure_reply_keyboard(),
            )

    @router.message(ProductionWorkflowForm.text_to_image_waiting_for_custom_prompt)
    async def on_text_to_image_custom_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        custom_prompt = _message_text(message)
        if custom_prompt == "上一步":
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_prompt_mode)
            await _show_text_to_image_prompt_mode(message, state)
            return
        if not custom_prompt:
            await _answer(message, "請輸入自定義最終提示詞。", reply_markup=_text_to_image_prompt_entry_reply_keyboard())
            return
        data = await state.get_data()
        await state.update_data(
            final_prompt_text=custom_prompt,
            selected_model="自定義提示詞",
            original_user_request=str(data.get("original_user_request") or custom_prompt).strip(),
            custom_prompt_used=True,
            prompt_display_ready=True,
            prompt_display_pending=False,
        )
        try:
            await _answer(message, "已收到自定義提示詞，正在提交生成。")
            await _submit_text_to_image_from_state(message, state)
        except Exception as exc:
            await state.set_state(ProductionWorkflowForm.text_to_image_waiting_for_custom_prompt)
            await _answer(message,
                f"自定義提示詞提交失敗：{_format_tg_user_error(exc)}\n\n請重新輸入提示詞，或返回上一步。",
                reply_markup=_text_to_image_prompt_entry_reply_keyboard(),
            )

    @router.message(Command("whoami"))
    @router.message(Command("id"))
    async def cmd_whoami(message: Message) -> None:
        await _answer(message, _chat_identity_text(message))

    @router.message(CommandStart())
    async def cmd_start(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await _answer(message, _quick_start_text(service), reply_markup=_menu_keyboard())

    @router.message(F.text == "多智能體數字人")
    @router.message(F.text == "多智能體數字人")
    async def on_keyword_entry(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await _answer(message, _quick_start_text(service), reply_markup=_menu_keyboard())

    @router.message(Command("status"))
    async def cmd_status(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await answer_status(message)

    @router.message(Command("workflow"))
    async def cmd_workflow(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await _answer(message, _workflow_config_text(service), reply_markup=_menu_keyboard())

    @router.message(Command("stop"))
    async def cmd_stop(message: Message, state: FSMContext) -> None:
        if await handle_stop_request(message, state):
            return

    @router.message(Command("workbench"))
    async def cmd_workbench(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await _answer(message,
            f"工作臺網址: {service.resolve_config().public_base_url}",
            reply_markup=_menu_keyboard(),
        )

    @router.message(Command("setscript"))
    async def cmd_setscript(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await state.set_state(ScriptForm.waiting_for_script)
        await _answer(message, "請直接貼上你想作爲預設的文案內容。", reply_markup=_menu_keyboard())

    @router.message(Command("cancel"))
    async def cmd_cancel(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await _answer(message, "本次素材上傳流程已取消。", reply_markup=_menu_keyboard())

    @router.message(Command("custom"))
    async def cmd_custom(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_upload_flow(message, state)

    @router.message(UploadFlowForm.waiting_for_custom_requirement)
    async def on_digital_human_custom_requirement(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if _canonical_button_text(_message_text(message)) == MAIN_MENU_BUTTON:
            await state.clear()
            await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())
            return
        if not await ensure_authorized(message):
            return
        requirement = _message_text(message)
        if not requirement:
            await _answer(message, "請用一句話寫出這次數字人視頻的風格或要求。", reply_markup=_digital_human_keyboard())
            return
        await start_upload_flow(message, state, requirement=requirement)

    @router.message(Command("run"))
    async def cmd_run(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await _answer(message, f"預設素材功能已移除。請使用「{DIGITAL_HUMAN_VIDEO_BUTTON}」建立數字人視頻。", reply_markup=_menu_keyboard())

    @router.message(Command("rerun"))
    async def cmd_rerun(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        latest_task = service.get_latest_task_for_submitter(int(message.chat.id))
        if latest_task is None:
            await _answer(message, "你目前還沒有可重跑的歷史任務。", reply_markup=_menu_keyboard())
            return
        request = service.clone_task_request(latest_task.id)
        await enqueue_request(message, request, source="telegram-rerun", is_default_assets=request.publish_to_default_paths)

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
            await _answer(message, "文案不能爲空，請重新輸入。", reply_markup=_menu_keyboard())
            return
        chat_script_drafts[int(message.chat.id)] = script
        await state.clear()
        await _answer(message, "你的預設文案已更新。", reply_markup=_menu_keyboard())

    @router.message(UploadFlowForm.waiting_for_video)
    async def on_upload_video(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_workflow_reference_request(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        suffix = _video_ext_from_message(message)
        if suffix is None:
            await _answer(message, "請上傳視頻文件，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        params = {
            "speech_text": str(data["script_text"]),
            "prompt_text": prompt_text,
            "style_hint": portrait_prompt or "口播數字人寫實人像",
            "duration_seconds": int(duration or 15),
            "use_ai_copy": False,
            "tg_use_llm_prompt": True,
            "tg_user_instruction": f"User text-to-image request: {prompt}",
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "text_to_image", params)
        except Exception as exc:
            await _answer(message, f"文生圖任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.image_waiting_for_product_image)
    async def on_image_first_reference(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        data = await state.get_data()
        mode = str(data.get("image_mode") or "multi_image")
        title = _image_mode_title(mode)
        if text == "上一步":
            await start_image_generate_flow(message, state)
            return
        has_product_image = _recorded_local_resource(data.get("product_image_local_path"))
        if text == KEEP_CURRENT_RESOURCE_BUTTON and has_product_image:
            await state.set_state(ProductionWorkflowForm.image_waiting_for_model_image)
            second_text = _image_reference_second_step_text(
                mode,
                has_current=_recorded_local_resource(data.get("model_image_local_path")),
            )
            await _answer(
                message,
                second_text.replace(
                    f"{title}\n",
                    f"{title}\n已沿用目前{'原圖' if mode == 'image_replace' else '第一張參考圖'}。\n",
                    1,
                ),
                reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("model_image_local_path"))),
            )
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await _answer(
                message,
                _image_reference_first_step_text(mode, has_current=has_product_image),
                reply_markup=_image_task_step_keyboard(back=False, keep_current=has_product_image),
            )
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix=f"tg_{mode}")))
        target = work_dir / f"primary{suffix}"
        await _download_message_media(message, target)
        await state.update_data(work_dir=str(work_dir), product_image_local_path=str(target.resolve()))
        await state.set_state(ProductionWorkflowForm.image_waiting_for_model_image)
        await _answer(
            message,
            _image_reference_second_step_text(mode, has_current=_recorded_local_resource(data.get("model_image_local_path"))),
            reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("model_image_local_path"))),
        )

    @router.message(ProductionWorkflowForm.image_waiting_for_model_image)
    async def on_image_second_reference(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        data = await state.get_data()
        mode = str(data.get("image_mode") or "multi_image")
        title = _image_mode_title(mode)
        if text == "上一步":
            await state.set_state(ProductionWorkflowForm.image_waiting_for_product_image)
            await _answer(
                message,
                _image_reference_first_step_text(mode, has_current=_recorded_local_resource(data.get("product_image_local_path"))),
                reply_markup=_image_task_step_keyboard(back=False, keep_current=_recorded_local_resource(data.get("product_image_local_path"))),
            )
            return
        has_model_image = _recorded_local_resource(data.get("model_image_local_path"))
        if text == KEEP_CURRENT_RESOURCE_BUTTON and has_model_image:
            await state.set_state(ProductionWorkflowForm.image_waiting_for_prompt)
            await _answer(message, f"{title}\n已沿用目前{'要替換成的參考圖' if mode == 'image_replace' else '第二張參考圖'}。\n步驟 3/3：請輸入這次圖片生成需求。", reply_markup=_image_task_step_keyboard())
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            await _answer(
                message,
                _image_reference_second_step_text(mode, has_current=has_model_image),
                reply_markup=_image_task_step_keyboard(keep_current=has_model_image),
            )
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix=f"tg_{mode}")))
        target = work_dir / f"secondary{suffix}"
        await _download_message_media(message, target)
        await state.update_data(work_dir=str(work_dir), model_image_local_path=str(target.resolve()))
        await state.set_state(ProductionWorkflowForm.image_waiting_for_prompt)
        await _answer(message, f"{title}\n已更新{'要替換成的參考圖' if mode == 'image_replace' else '第二張參考圖'}。\n步驟 3/3：請輸入這次圖片生成需求。", reply_markup=_image_task_step_keyboard())

    @router.message(ProductionWorkflowForm.image_waiting_for_prompt)
    async def on_image_reference_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        prompt = _message_text(message)
        data = await state.get_data()
        mode = str(data.get("image_mode") or "multi_image")
        title = _image_mode_title(mode)
        text = _canonical_button_text(prompt)
        if text == "上一步":
            await state.set_state(ProductionWorkflowForm.image_waiting_for_model_image)
            await _answer(
                message,
                _image_reference_second_step_text(mode, has_current=_recorded_local_resource(data.get("model_image_local_path"))),
                reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("model_image_local_path"))),
            )
            return
        if not prompt:
            await _answer(message, f"{title}\n步驟 3/3：請直接輸入這次圖片生成需求。", reply_markup=_image_task_step_keyboard())
            return
        params = {
            "product_image_local_path": str(data.get("product_image_local_path") or ""),
            "model_image_local_path": str(data.get("model_image_local_path") or ""),
            "prompt": prompt,
            "prompt_text": prompt,
            "message": prompt,
            "tg_use_llm_prompt": True,
            "tg_user_instruction": f"User {mode} request: {prompt}",
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "image_generate", params)
        except Exception as exc:
            await _answer(message, f"{title}任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(ProductionWorkflowForm.image_edit_waiting_for_image)
    async def on_image_edit_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await start_image_generate_flow(message, state)
            return
        suffix = _image_ext_from_message(message)
        data = await state.get_data()
        single_input = str(data.get("image_edit_mode") or "").strip() == "single"
        title = "單圖編輯" if single_input else "圖片編輯"
        total_steps = "3" if single_input else "4"
        has_input_image = _recorded_local_resource(data.get("input_image_local_path"))
        if text == KEEP_CURRENT_RESOURCE_BUTTON and has_input_image:
            if single_input:
                await state.update_data(reference_image_local_path=str(data.get("reference_image_local_path") or data.get("input_image_local_path") or ""))
                await _show_image_edit_prompt_mode(message, state, prefix="已沿用當前原圖。")
                return
            await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_reference_image)
            await _answer(message,
                "圖片編輯\n已沿用當前原圖。\n步驟 2/4：請上傳參考圖或素材圖；如果要繼續使用已記錄的參考圖，請點擊“沿用目前資源”。",
                reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("reference_image_local_path"))),
            )
            return
        if suffix is None:
            if has_input_image:
                await _answer(message,
                    f"{title}\n已記錄當前原圖。可以上傳新原圖替換，或點擊“沿用目前資源”繼續。",
                    reply_markup=_image_task_step_keyboard(back=False, keep_current=True),
                )
                return
            await _answer(message, f"{title}\n步驟 1/{total_steps}：請上傳需要編輯的原圖。", reply_markup=_image_task_step_keyboard(back=False))
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_image_edit")))
        target = work_dir / f"input_{int(message.message_id)}{suffix}"
        await _download_message_media(message, target)
        update_payload: dict[str, Any] = {
            "work_dir": str(work_dir),
            "input_image_local_path": str(target.resolve()),
            **_clear_image_edit_prompt_fields(),
        }
        if single_input:
            update_payload["reference_image_local_path"] = str(target.resolve())
            await state.update_data(**update_payload)
            await _show_image_edit_prompt_mode(message, state, prefix="已更新原圖。")
            return
        await state.update_data(**update_payload)
        await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_reference_image)
        await _answer(message,
            "圖片編輯\n已更新原圖。\n步驟 2/4：請上傳參考圖或素材圖。",
            reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("reference_image_local_path"))),
        )

    @router.message(ProductionWorkflowForm.image_edit_waiting_for_reference_image)
    async def on_image_edit_reference_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_image)
            data = await state.get_data()
            await _answer(message,
                "圖片編輯\n步驟 1/4：如需替換原圖，請上傳新圖片；否則點擊“沿用目前資源”。",
                reply_markup=_image_task_step_keyboard(back=False, keep_current=_recorded_local_resource(data.get("input_image_local_path"))),
            )
            return
        suffix = _image_ext_from_message(message)
        data = await state.get_data()
        has_reference_image = _recorded_local_resource(data.get("reference_image_local_path"))
        if text == KEEP_CURRENT_RESOURCE_BUTTON and has_reference_image:
            await _show_image_edit_prompt_mode(message, state, prefix="已沿用當前參考圖。")
            return
        if suffix is None:
            if has_reference_image:
                await _answer(message,
                    "圖片編輯\n已記錄當前參考圖。可以上傳新參考圖替換，或點擊“沿用目前資源”繼續。",
                    reply_markup=_image_task_step_keyboard(keep_current=True),
                )
                return
            await _answer(message, "圖片編輯\n步驟 2/4：請上傳參考圖或素材圖。", reply_markup=_image_task_step_keyboard())
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_image_edit")))
        target = work_dir / f"reference_{int(message.message_id)}{suffix}"
        await _download_message_media(message, target)
        await state.update_data(
            work_dir=str(work_dir),
            reference_image_local_path=str(target.resolve()),
            **_clear_image_edit_prompt_fields(),
        )
        await _show_image_edit_prompt_mode(message, state, prefix="已更新參考圖。")

    @router.message(ProductionWorkflowForm.image_edit_waiting_for_prompt_mode)
    async def on_image_edit_prompt_mode(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        data = await state.get_data()
        single_input, title, total_steps, _ = _image_edit_flow_meta(data)
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.update_data(**_clear_image_edit_prompt_fields())
            if single_input:
                await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_image)
                await _answer(
                    message,
                    "單圖編輯\n步驟 1/3：如需替換原圖，請上傳新圖片；否則點擊“沿用目前資源”。",
                    reply_markup=_image_task_step_keyboard(back=False, keep_current=_recorded_local_resource(data.get("input_image_local_path"))),
                )
            else:
                await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_reference_image)
                await _answer(
                    message,
                    "圖片編輯\n步驟 2/4：如需替換參考圖，請上傳新圖片；否則點擊“沿用目前資源”。",
                    reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("reference_image_local_path"))),
                )
            return
        if text == MAIN_MENU_BUTTON:
            await state.clear()
            await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())
            return
        if text == "讓 Grok 生成提示詞":
            await state.update_data(image_edit_prompt_mode_label="Grok 生成")
            await _show_image_edit_prompt_entry(message, state, custom_prompt=False)
            return
        if text in {"輸入自定義提示詞", "輸入自定義提示詞提交"}:
            await state.update_data(image_edit_prompt_mode_label="自定義提示詞")
            await _show_image_edit_prompt_entry(message, state, custom_prompt=True)
            return
        await _answer(
            message,
            f"{title}\n步驟 {total_steps - 1}/{total_steps}：請先選擇提示詞方式。",
            reply_markup=_image_edit_prompt_mode_keyboard(),
        )

    @router.message(ProductionWorkflowForm.image_edit_waiting_for_prompt)
    async def on_image_edit_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        data = await state.get_data()
        single_input, title, total_steps, _ = _image_edit_flow_meta(data)
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.update_data(**_clear_image_edit_prompt_fields())
            await _show_image_edit_prompt_mode(message, state)
            return
        prompt = _message_text(message)
        if not prompt:
            await _answer(message, f"{title}\n步驟 {total_steps}/{total_steps}：請輸入這次圖片編輯要求，Grok 會先生成提示詞供你確認。", reply_markup=_image_task_step_keyboard())
            return
        try:
            await _preview_image_edit_prompt(message, state, prompt)
        except Exception as exc:
            await state.update_data(
                image_edit_user_request=prompt,
                image_edit_prompt_ready=False,
                image_edit_generated_prompt="",
                image_edit_waiting_for_custom_prompt=False,
                image_edit_waiting_for_adjustment=False,
            )
            await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_confirm)
            await _answer(message,
                "Grok 圖片編輯提示詞生成失敗："
                f"{_format_grok_preview_error(exc)}\n\n"
                "任務還沒有提交，已保留當前素材。可以重新生成提示詞，或輸入自定義提示詞提交。",
                reply_markup=_image_edit_prompt_failure_keyboard(),
            )

    @router.message(ProductionWorkflowForm.image_edit_waiting_for_confirm)
    async def on_image_edit_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        data = await state.get_data()
        _, title, total_steps, _ = _image_edit_flow_meta(data)
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.update_data(**_clear_image_edit_prompt_fields())
            await _show_image_edit_prompt_mode(message, state)
            return
        if text == MAIN_MENU_BUTTON:
            await state.clear()
            await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())
            return
        if text == "輸入自定義提示詞提交":
            await state.update_data(image_edit_prompt_mode_label="自定義提示詞")
            await _show_image_edit_prompt_entry(message, state, custom_prompt=True)
            return
        if text == "重新生成提示詞":
            original_request = str(data.get("image_edit_user_request") or data.get("image_edit_prompt") or "").strip()
            if not original_request:
                await state.update_data(image_edit_prompt_mode_label="Grok 生成")
                await _show_image_edit_prompt_entry(message, state, custom_prompt=False)
                return
            try:
                await _preview_image_edit_prompt(message, state, original_request)
            except Exception as exc:
                await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_confirm)
                await _answer(message,
                    f"Grok 圖片編輯提示詞生成失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_image_edit_prompt_failure_keyboard(),
                )
            return
        if text == "繼續讓 Grok 調整":
            await state.update_data(image_edit_waiting_for_adjustment=True, image_edit_waiting_for_custom_prompt=False)
            await _answer(message, "請直接輸入調整要求，例如：只換衣服、保留人物姿勢、背景不要變。", reply_markup=_image_edit_prompt_review_keyboard())
            return
        if bool(data.get("image_edit_waiting_for_adjustment")):
            adjustment = _message_text(message)
            if not adjustment:
                await _answer(message, "請直接輸入調整要求。", reply_markup=_image_edit_prompt_review_keyboard())
                return
            base_prompt = str(data.get("image_edit_generated_prompt") or data.get("image_edit_prompt") or "").strip()
            original_request = str(data.get("image_edit_user_request") or "").strip()
            adjusted_request = "\n".join(
                part
                for part in [
                    f"Original image edit request: {original_request}" if original_request else "",
                    f"Current image edit prompt: {base_prompt}" if base_prompt else "",
                    f"Revision request: {adjustment}",
                    "Rewrite the current image editing prompt according to the revision request. Output only the latest final prompt.",
                ]
                if part
            )
            try:
                await _preview_image_edit_prompt(message, state, adjusted_request)
            except Exception as exc:
                await state.set_state(ProductionWorkflowForm.image_edit_waiting_for_confirm)
                await _answer(message,
                    f"Grok 圖片編輯提示詞調整失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_image_edit_prompt_failure_keyboard(),
                )
            return
        if bool(data.get("image_edit_waiting_for_custom_prompt")):
            custom_prompt = _message_text(message)
            if not custom_prompt:
                await _answer(message, "請輸入自定義最終圖片編輯提示詞。", reply_markup=_image_task_step_keyboard())
                return
            await state.update_data(
                image_edit_prompt=custom_prompt,
                image_edit_generated_prompt=custom_prompt,
                image_edit_prompt_ready=True,
                image_edit_waiting_for_custom_prompt=False,
                image_edit_user_request=str(data.get("image_edit_user_request") or custom_prompt),
            )
            await _submit_image_edit_from_state(message, state, custom_prompt)
            return
        if text != "使用這個提示詞提交":
            await _answer(message, f"{title}\n請先查看 Grok 生成的提示詞，確認合適後點擊「使用這個提示詞提交」。", reply_markup=_image_edit_prompt_review_keyboard())
            return
        prompt = str(data.get("image_edit_generated_prompt") or data.get("image_edit_prompt") or "").strip()
        if not prompt:
            await state.update_data(image_edit_prompt_mode_label="Grok 生成")
            await _show_image_edit_prompt_entry(message, state, custom_prompt=False)
            return
        await _submit_image_edit_from_state(message, state, prompt)

    @router.message(ProductionWorkflowForm.face_swap_waiting_for_target_image)
    async def on_face_swap_target_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await start_image_generate_flow(message, state)
            return
        suffix = _image_ext_from_message(message)
        data = await state.get_data()
        has_target_image = _recorded_local_resource(data.get("target_image_local_path"))
        if text == KEEP_CURRENT_RESOURCE_BUTTON and has_target_image:
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_source_image)
            await _answer(message,
                "人物換臉\n已沿用當前原圖。\n步驟 2/4：請上傳人臉參考圖；如果要繼續使用已記錄的人臉參考圖，請點擊“沿用目前資源”。",
                reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("source_image_local_path"))),
            )
            return
        if suffix is None:
            if has_target_image:
                await _answer(message,
                    "人物換臉\n已記錄當前原圖。可以上傳新原圖替換，或點擊“沿用目前資源”繼續。",
                    reply_markup=_image_task_step_keyboard(back=False, keep_current=True),
                )
                return
            await _answer(message, "人物換臉\n步驟 1/4：請上傳原圖。", reply_markup=_image_task_step_keyboard(back=False))
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_face_swap")))
        target = work_dir / f"target_{int(message.message_id)}{suffix}"
        await _download_message_media(message, target)
        await state.update_data(
            work_dir=str(work_dir),
            target_image_local_path=str(target.resolve()),
            **_clear_face_swap_prompt_fields(),
        )
        await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_source_image)
        await _answer(message,
            "人物換臉\n已更新原圖。\n步驟 2/4：請上傳人臉參考圖。",
            reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("source_image_local_path"))),
        )

    @router.message(ProductionWorkflowForm.face_swap_waiting_for_source_image)
    async def on_face_swap_source_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_target_image)
            data = await state.get_data()
            await _answer(message,
                "人物換臉\n步驟 1/4：如需替換原圖，請上傳新圖片；否則點擊“沿用目前資源”。",
                reply_markup=_image_task_step_keyboard(back=False, keep_current=_recorded_local_resource(data.get("target_image_local_path"))),
            )
            return
        suffix = _image_ext_from_message(message)
        data = await state.get_data()
        has_source_image = _recorded_local_resource(data.get("source_image_local_path"))
        if text == KEEP_CURRENT_RESOURCE_BUTTON and has_source_image:
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_prompt)
            await _answer(message, "人物換臉\n已沿用當前人臉參考圖。\n步驟 3/4：請選擇默認自然換臉，或輸入自定義換臉要求。", reply_markup=_face_swap_prompt_keyboard())
            return
        if suffix is None:
            if has_source_image:
                await _answer(message,
                    "人物換臉\n已記錄當前人臉參考圖。可以上傳新參考圖替換，或點擊“沿用目前資源”繼續。",
                    reply_markup=_image_task_step_keyboard(keep_current=True),
                )
                return
            await _answer(message, "人物換臉\n步驟 2/4：請上傳人臉參考圖。", reply_markup=_image_task_step_keyboard())
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_face_swap")))
        target = work_dir / f"source_face_{int(message.message_id)}{suffix}"
        await _download_message_media(message, target)
        await state.update_data(
            work_dir=str(work_dir),
            source_image_local_path=str(target.resolve()),
            **_clear_face_swap_prompt_fields(),
        )
        await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_prompt)
        await _answer(message, "人物換臉\n已更新人臉參考圖。\n步驟 3/4：請選擇默認自然換臉，或輸入自定義換臉要求。", reply_markup=_face_swap_prompt_keyboard())

    @router.message(ProductionWorkflowForm.face_swap_waiting_for_prompt)
    async def on_face_swap_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.update_data(**_clear_face_swap_prompt_fields())
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_source_image)
            data = await state.get_data()
            await _answer(message,
                "人物換臉\n步驟 2/4：如需替換人臉參考圖，請上傳新圖片；否則點擊“沿用目前資源”。",
                reply_markup=_image_task_step_keyboard(keep_current=_recorded_local_resource(data.get("source_image_local_path"))),
            )
            return
        if text == MAIN_MENU_BUTTON:
            await state.clear()
            await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())
            return
        prompt = _message_text(message)
        if text == "自然換臉":
            prompt = FACE_SWAP_NATURAL_PROMPT
        elif text == "輸入自定義換臉要求":
            await _answer(message, "請直接輸入這次人物換臉要求。", reply_markup=_image_task_step_keyboard())
            return
        if not prompt:
            await _answer(message, "人物換臉\n步驟 3/4：請選擇默認自然換臉，或輸入自定義換臉要求。", reply_markup=_face_swap_prompt_keyboard())
            return
        try:
            await _preview_face_swap_prompt(message, state, prompt)
        except Exception as exc:
            await state.update_data(
                face_swap_user_request=prompt,
                face_swap_prompt_ready=False,
                face_swap_generated_prompt="",
                face_swap_waiting_for_custom_prompt=False,
                face_swap_waiting_for_adjustment=False,
            )
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_confirm)
            await _answer(message,
                "Grok 人物換臉提示詞生成失敗："
                f"{_format_grok_preview_error(exc)}\n\n"
                "任務還沒有提交，已保留當前素材。可以重新生成提示詞，或輸入自定義提示詞提交。",
                reply_markup=_image_edit_prompt_failure_keyboard(),
            )

    @router.message(ProductionWorkflowForm.face_swap_waiting_for_confirm)
    async def on_face_swap_confirm(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        text = _canonical_button_text(_message_text(message))
        if text == "上一步":
            await state.update_data(**_clear_face_swap_prompt_fields())
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_prompt)
            await _answer(message, "人物換臉\n步驟 3/4：請選擇默認自然換臉，或輸入自定義換臉要求。", reply_markup=_face_swap_prompt_keyboard())
            return
        if text == MAIN_MENU_BUTTON:
            await state.clear()
            await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())
            return
        data = await state.get_data()
        if text == "輸入自定義提示詞提交":
            await state.update_data(face_swap_waiting_for_custom_prompt=True, face_swap_waiting_for_adjustment=False)
            await _answer(message, "請輸入自定義最終人物換臉提示詞。下一條消息會跳過 Grok，直接提交換臉任務。", reply_markup=_image_task_step_keyboard())
            return
        if text == "重新生成提示詞":
            original_request = str(data.get("face_swap_user_request") or data.get("face_swap_prompt") or FACE_SWAP_NATURAL_PROMPT).strip()
            try:
                await _preview_face_swap_prompt(message, state, original_request)
            except Exception as exc:
                await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_confirm)
                await _answer(message,
                    f"Grok 人物換臉提示詞生成失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_image_edit_prompt_failure_keyboard(),
                )
            return
        if text == "繼續讓 Grok 調整":
            await state.update_data(face_swap_waiting_for_adjustment=True, face_swap_waiting_for_custom_prompt=False)
            await _answer(message, "請直接輸入調整要求，例如：更自然、保留原圖表情、臉部融合更柔和。", reply_markup=_image_edit_prompt_review_keyboard())
            return
        if bool(data.get("face_swap_waiting_for_adjustment")):
            adjustment = _message_text(message)
            if not adjustment:
                await _answer(message, "請直接輸入調整要求。", reply_markup=_image_edit_prompt_review_keyboard())
                return
            base_prompt = str(data.get("face_swap_generated_prompt") or data.get("face_swap_prompt") or "").strip()
            original_request = str(data.get("face_swap_user_request") or "").strip()
            adjusted_request = "\n".join(
                part
                for part in [
                    f"Original face swap request: {original_request}" if original_request else "",
                    f"Current face swap prompt: {base_prompt}" if base_prompt else "",
                    f"Revision request: {adjustment}",
                    "Rewrite the current face swap prompt according to the revision request. Output only the latest final prompt.",
                ]
                if part
            )
            try:
                await _preview_face_swap_prompt(message, state, adjusted_request)
            except Exception as exc:
                await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_confirm)
                await _answer(message,
                    f"Grok 人物換臉提示詞調整失敗：{_format_grok_preview_error(exc)}",
                    reply_markup=_image_edit_prompt_failure_keyboard(),
                )
            return
        if bool(data.get("face_swap_waiting_for_custom_prompt")):
            custom_prompt = _message_text(message)
            if not custom_prompt:
                await _answer(message, "請輸入自定義最終人物換臉提示詞。", reply_markup=_image_task_step_keyboard())
                return
            await state.update_data(
                face_swap_prompt=custom_prompt,
                face_swap_generated_prompt=custom_prompt,
                face_swap_prompt_ready=True,
                face_swap_waiting_for_custom_prompt=False,
                face_swap_user_request=str(data.get("face_swap_user_request") or custom_prompt),
            )
            await _submit_face_swap_from_state(message, state, custom_prompt)
            return
        if text != "使用這個提示詞提交":
            await _answer(message, "人物換臉\n請先查看 Grok 生成的提示詞，確認合適後點擊「使用這個提示詞提交」。", reply_markup=_image_edit_prompt_review_keyboard())
            return
        prompt = str(data.get("face_swap_generated_prompt") or data.get("face_swap_prompt") or "").strip()
        if not prompt:
            await state.set_state(ProductionWorkflowForm.face_swap_waiting_for_prompt)
            await _answer(message, "人物換臉\n步驟 3/4：請選擇默認自然換臉，或輸入自定義換臉要求。", reply_markup=_face_swap_prompt_keyboard())
            return
        await _submit_face_swap_from_state(message, state, prompt)

    @router.message(ProductionWorkflowForm.video_i2v_waiting_for_resolution)
    @router.message(ProductionWorkflowForm.video_i2v_waiting_for_duration)
    @router.message(ProductionWorkflowForm.video_i2v_waiting_for_audio)
    @router.message(ProductionWorkflowForm.video_i2v_waiting_for_prompt_mode)
    async def on_video_i2v_param_text(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        current_state = await state.get_state()
        text = _message_text(message).strip()
        button_text = _canonical_button_text(text).replace("✓", "").strip()
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        if button_text == "上一步":
            if current_state == ProductionWorkflowForm.video_i2v_waiting_for_duration.state:
                params.update(
                    {
                        "resolution_selected": False,
                        "duration_selected": False,
                        "prompt_mode_selected": False,
                        "prompt_extend_selected": False,
                    }
                )
                await state.update_data(**params)
                await _show_video_i2v_step(message, state, step="resolution")
                return
            if current_state == ProductionWorkflowForm.video_i2v_waiting_for_prompt_mode.state:
                params.update({"prompt_mode_selected": False})
                await state.update_data(**params)
                await _show_video_i2v_step(message, state, step="audio")
                return
            if current_state == ProductionWorkflowForm.video_i2v_waiting_for_audio.state:
                params.update({"prompt_mode_selected": False})
                await state.update_data(**params)
                await _show_video_i2v_step(message, state, step="image")
                return
        if current_state == ProductionWorkflowForm.video_i2v_waiting_for_resolution.state:
            if button_text.startswith("720p"):
                params["resolution"] = "720p"
            elif button_text.startswith("1080p"):
                params["resolution"] = "1080p"
            else:
                await _answer(message, "請點擊下方按鈕選擇分辨率。")
                await _show_video_i2v_step(message, state, step="resolution")
                return
            params["resolution_selected"] = True
            params.update({"duration_selected": False, "prompt_mode_selected": False, "prompt_extend_selected": False})
            await state.update_data(**params)
            await _show_video_i2v_step(message, state, step="duration")
            return
        if current_state == ProductionWorkflowForm.video_i2v_waiting_for_audio.state:
            if button_text == KEEP_CURRENT_RESOURCE_BUTTON and _recorded_local_resource(params.get("audio_local_path")):
                params["audio_selected"] = True
                await state.update_data(**params)
                await _show_video_i2v_step(message, state, step="prompt_mode")
                return
            if button_text == "跳過音頻":
                params["audio_selected"] = True
                params["audio_local_path"] = ""
                await state.update_data(**params, **_clear_video_i2v_prompt_fields())
                await _answer(message, "已跳過音頻，本次不會使用之前記錄的音頻。")
                await _show_video_i2v_step(message, state, step="prompt_mode")
                return
            audio_suffix = _audio_ext_from_message(message)
            if audio_suffix is None:
                if _recorded_local_resource(params.get("audio_local_path")):
                    await _answer(message,
                        "已記錄當前音頻。可以上傳新音頻替換，點擊“沿用目前資源”繼續，或點擊“跳過音頻”讓本次不使用音頻。",
                        reply_markup=_video_i2v_audio_keyboard(keep_current=True),
                    )
                    return
                await _answer(message, "請上傳音頻文件，或點擊“跳過音頻”。", reply_markup=_video_i2v_audio_keyboard())
                return
            work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_video_i2v")))
            target = work_dir / f"audio_{int(message.message_id)}{audio_suffix}"
            await _download_message_media(message, target)
            params["audio_selected"] = True
            params["audio_local_path"] = str(target.resolve())
            await state.update_data(**params, work_dir=str(work_dir), **_clear_video_i2v_prompt_fields())
            await _answer(message, "已更新音頻。")
            await _show_video_i2v_step(message, state, step="prompt_mode")
            return
        if current_state == ProductionWorkflowForm.video_i2v_waiting_for_duration.state:
            if button_text != text:
                text = button_text
        if current_state == ProductionWorkflowForm.video_i2v_waiting_for_prompt_mode.state:
            if button_text == "讓 Grok 生成提示詞":
                params["use_grok"] = True
                params["prompt_mode_label"] = "Grok 生成"
            elif button_text == "輸入自定義提示詞提交":
                params["use_grok"] = False
                params["prompt_mode_label"] = "自定義提交"
            else:
                await _answer(message, "請點擊下方按鈕選擇提示詞方式。")
                await _show_video_i2v_step(message, state, step="prompt_mode")
                return
            params["prompt_mode_selected"] = True
            params["prompt_extend_selected"] = False
            await state.update_data(**params)
            await _show_video_i2v_step(message, state, step="prompt")
            return
        if current_state == ProductionWorkflowForm.video_i2v_waiting_for_duration.state:
            if not text.isdigit():
                await _answer(message, "請輸入 2 到 15 秒之間的整數，例如：5。")
                await _show_video_i2v_step(message, state, step="duration")
                return
            duration = int(text)
            if duration < 2 or duration > 15:
                await _answer(message, "時長範圍是 2 到 15 秒，請重新輸入。")
                await _show_video_i2v_step(message, state, step="duration")
                return
            await state.update_data(duration=duration, duration_selected=True, prompt_mode_selected=False, prompt_extend_selected=False)
            await _show_video_i2v_step(message, state, step="image")
            return
        step = "resolution"
        if current_state == ProductionWorkflowForm.video_i2v_waiting_for_prompt_mode.state:
            step = "prompt_mode"
        await _answer(message, "請點擊上方按鈕選擇當前參數。")
        await _show_video_i2v_step(message, state, step=step)

    @router.message(ProductionWorkflowForm.video_i2v_waiting_for_image)
    async def on_video_i2v_image(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        button_text = _canonical_button_text(_message_text(message)).strip()
        if button_text == "上一步":
            data = await state.get_data()
            params = _video_i2v_state_params(data)
            params["duration_selected"] = False
            await state.update_data(**params)
            await _show_video_i2v_step(message, state, step="duration")
            return
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        if button_text == KEEP_CURRENT_RESOURCE_BUTTON and _recorded_local_resource(params.get("image_local_path")):
            await _show_video_i2v_step(message, state, step="audio")
            return
        suffix = _image_ext_from_message(message)
        if suffix is None:
            if _recorded_local_resource(params.get("image_local_path")):
                await _answer(message, "已記錄當前參考圖。可以上傳新圖片替換，或點擊“沿用目前資源”繼續。")
            else:
                await _answer(message, "請上傳一張參考圖片。")
            await _show_video_i2v_step(message, state, step="image")
            return
        work_dir = Path(str(data.get("work_dir") or service.create_job_dir(prefix="tg_video_i2v")))
        target = work_dir / f"reference_{int(message.message_id)}{suffix}"
        await _download_message_media(message, target)
        caption = _message_text(message)
        await state.update_data(
            work_dir=str(work_dir),
            image_local_path=str(target.resolve()),
            video_i2v_initial_prompt=caption,
            **_clear_video_i2v_prompt_fields(),
        )
        await _answer(message, "已更新參考圖。")
        await _show_video_i2v_step(message, state, step="audio")
        return

    @router.message(ProductionWorkflowForm.video_i2v_waiting_for_prompt)
    async def on_video_i2v_prompt(message: Message, state: FSMContext) -> None:
        if await handle_entry_keyword(message, state):
            return
        if await handle_stop_request(message, state):
            return
        if not await ensure_authorized(message):
            return
        prompt = _message_text(message)
        button_text = _canonical_button_text(prompt).replace("✓", "").strip()
        if button_text == "上一步":
            await _show_video_i2v_step(message, state, step="prompt_mode")
            return
        data = await state.get_data()
        params = _video_i2v_state_params(data)
        if button_text == "使用這個提示詞生成":
            final_prompt = str(data.get("video_i2v_generated_prompt") or "").strip()
            if not final_prompt:
                await _answer(message, "還沒有可用的視頻提示詞，請先輸入需求讓 Grok 生成。", reply_markup=_video_i2v_prompt_failure_keyboard())
                return
            submit_params = dict(params)
            submit_params["use_grok"] = False
            submit_params["prompt_mode_label"] = "Grok 生成"
            payload = _build_video_i2v_payload(data, submit_params, final_prompt)
            if payload is None:
                await _answer(message, "請先上傳一張參考圖。")
                await _show_video_i2v_step(message, state, step="image")
                return
            payload.update(
                {
                    "tg_use_llm_prompt": False,
                    "tg_llm_rewritten_prompt": final_prompt,
                    "tg_user_instruction": str(data.get("video_i2v_user_request") or final_prompt),
                }
            )
            try:
                await _submit_video_i2v_payload(message, state, payload, submit_params)
            except Exception as exc:
                await _answer(message, f"圖生視頻任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_video_i2v_prompt_review_keyboard())
            return
        if button_text == "輸入自定義提示詞提交":
            params["use_grok"] = False
            params["prompt_mode_label"] = "自定義提交"
            await state.update_data(**params, video_i2v_prompt_ready=False)
            await _answer(message, "請輸入自定義最終視頻提示詞。下一條消息會跳過 Grok，直接提交。", reply_markup=_video_i2v_prompt_keyboard())
            return
        if button_text == "返回參數設定":
            params["prompt_mode_selected"] = False
            await state.update_data(**params)
            await _show_video_i2v_step(message, state, step="prompt_mode")
            return
        if button_text == "重新生成提示詞":
            original_request = str(data.get("video_i2v_user_request") or data.get("video_i2v_initial_prompt") or "").strip()
            if not original_request:
                await _answer(message, "沒有原始視頻需求，請重新輸入。", reply_markup=_video_i2v_prompt_keyboard())
                return
            params["use_grok"] = True
            params["prompt_mode_label"] = "Grok 生成"
            await state.update_data(**params)
            await _submit_video_i2v_from_state(message, state, original_request)
            return
        if button_text == "繼續讓 Grok 調整":
            await _answer(message, "請直接輸入調整要求，例如：動作更慢、鏡頭更近、保持原圖姿態。", reply_markup=_video_i2v_prompt_review_keyboard())
            await state.update_data(video_i2v_waiting_for_adjustment=True)
            return
        if bool(data.get("video_i2v_waiting_for_adjustment")):
            base_prompt = str(data.get("video_i2v_generated_prompt") or "").strip()
            original_request = str(data.get("video_i2v_user_request") or "").strip()
            adjusted_request = "\n".join(
                part for part in [
                    f"Original request: {original_request}" if original_request else "",
                    f"Current video prompt: {base_prompt}" if base_prompt else "",
                    f"Revision request: {prompt}",
                    "Return one revised final video prompt only.",
                ] if part
            )
            params["use_grok"] = True
            params["prompt_mode_label"] = "Grok 生成"
            await state.update_data(**params, video_i2v_waiting_for_adjustment=False)
            await _submit_video_i2v_from_state(message, state, adjusted_request)
            return
        if not prompt:
            await _answer(message, "請直接輸入這次圖生視頻的畫面和動作需求。", reply_markup=_video_i2v_prompt_keyboard())
            return
        await _submit_video_i2v_from_state(message, state, prompt)

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
            await _answer(message, "請上傳原視頻，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        params = {
            "video_local_path": str(data["video_local_path"]),
            "image_local_path": str(data["image_local_path"]),
            "prompt": str(data.get("prompt") or ""),
            "duration_seconds": duration,
            "mode": "original",
            "tg_use_llm_prompt": True,
            "tg_user_instruction": str(data.get("prompt") or "Preserve the original video action, camera, and environment, and naturally replace the subject with the uploaded model image."),
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "replace_model", params)
        except Exception as exc:
            await _answer(message, f"視頻模特替換任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

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
            await _answer(message, "請上傳原視頻，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        params = {
            "video_local_path": str(data["video_local_path"]),
            "image_local_path": str(data["image_local_path"]),
            "product_name": str(data.get("product_name") or "商品"),
            "prompt_text": str(data.get("prompt_text") or ""),
            "duration_seconds": duration,
            "tg_use_llm_prompt": True,
            "tg_user_instruction": "\n".join(
                [
                    f"Product name: {str(data.get('product_name') or 'product')}",
                    str(data.get("prompt_text") or "Preserve the original video camera and character action, and naturally replace the product with the uploaded product image."),
                ]
            ),
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "replace_product", params)
        except Exception as exc:
            await _answer(message, f"視頻商品替換任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

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
            await _answer(message, "請上傳原視頻，或把視頻當成 document 傳送。", reply_markup=_menu_keyboard())
            return
        params = {
            "video_local_path": str(data["video_local_path"]),
            "model_image_local_path": str(data["model_image_local_path"]),
            "product_image_local_path": str(data["product_image_local_path"]),
            "product_name": str(data.get("product_name") or "商品"),
            "model_params": {"duration_seconds": duration},
            "product_params": {"product_name": str(data.get("product_name") or "商品"), "duration_seconds": duration},
            "tg_use_llm_prompt": True,
            "tg_user_instruction": f"Combined replacement: naturally replace the video model and product. Product name: {str(data.get('product_name') or 'product')}",
        }
        await state.clear()
        try:
            await submit_webapp_task_and_reply(message, "replace_productANDmodel", params)
        except Exception as exc:
            await _answer(message, f"聯合替換任務提交失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(F.text == DIGITAL_HUMAN_VIDEO_BUTTON)
    @router.message(F.text == "數字人視頻生成")
    @router.message(F.text == "數字人視頻生成")
    @router.message(F.text == LEGACY_ORAL_UPLOAD_BUTTON)
    @router.message(F.text == "口播數字人：上傳素材")
    @router.message(F.text == LEGACY_UPLOAD_BUTTON)
    @router.message(F.text == "上傳素材建立任務")
    async def on_upload_task_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await _answer(message,
            "請選擇這次數字人視頻的方向；選擇後繼續上傳素材，Grok 會根據你的選項和文字生成提示詞。",
            reply_markup=_digital_human_keyboard(),
        )

    @router.message(F.text == DIGITAL_HUMAN_REALISTIC_BUTTON)
    @router.message(F.text == "寫實帶貨視頻")
    async def on_digital_human_realistic(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_upload_flow(message, state, requirement="寫實電商帶貨視頻，人物自然展示商品，鏡頭乾淨，真實質感，無文字水印。")

    @router.message(F.text == DIGITAL_HUMAN_LIVE_BUTTON)
    @router.message(F.text == "直播口播視頻")
    async def on_digital_human_live(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_upload_flow(message, state, requirement="直播間口播風格，人物正面自然講解商品，光線柔和，節奏清晰，適合短視頻帶貨。")

    @router.message(F.text == DIGITAL_HUMAN_PRODUCT_BUTTON)
    @router.message(F.text == "產品展示視頻")
    async def on_digital_human_product(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_upload_flow(message, state, requirement="產品展示型數字人視頻，突出商品細節和使用場景，人物動作自然，畫面高級乾淨。")

    @router.message(F.text == DIGITAL_HUMAN_CUSTOM_BUTTON)
    @router.message(F.text == "自定義數字人要求")
    async def on_digital_human_custom_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await state.set_state(UploadFlowForm.waiting_for_custom_requirement)
        await _answer(message, "請直接輸入這次數字人視頻的客製化要求；收到後我會繼續讓你上傳素材。", reply_markup=_digital_human_keyboard())

    @router.message(F.text == TEXT_TO_IMAGE_BUTTON)
    @router.message(F.text == "文生圖")
    @router.message(F.text == "文生圖片")
    @router.message(F.text == "文生圖")
    @router.message(F.text == "文生圖片")
    async def on_text_to_image_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_text_to_image_flow(message, state)

    @router.message(F.text == TEXT_TO_IMAGE_REROLL_IMAGE_BUTTON)
    @router.message(F.text == "重新生成图片")
    async def on_text_to_image_reroll_image_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        try:
            await _reroll_latest_text_to_image(message, state)
        except Exception as exc:
            await _answer(message, f"重新生成圖片失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(F.text == TEXT_TO_IMAGE_CONTINUE_IMAGE_BUTTON)
    @router.message(F.text == "繼續生成圖片")
    @router.message(F.text == "继续生成图片")
    async def on_text_to_image_continue_image_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        try:
            await _continue_latest_text_to_image(message, state)
        except Exception as exc:
            await _answer(message, f"繼續生成圖片失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(F.text == MULTI_IMAGE_BUTTON)
    @router.message(F.text == "多圖生成")
    async def on_multi_image_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_image_reference_flow(message, state, mode="multi_image")

    @router.message(F.text == SINGLE_IMAGE_EDIT_BUTTON)
    @router.message(F.text == "單圖編輯")
    async def on_single_image_edit_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_single_image_edit_flow(message, state, single_input=True)

    @router.message(F.text == IMAGE_EDIT_BUTTON)
    @router.message(F.text == "圖片編輯")
    @router.message(F.text == "圖片編輯")
    async def on_image_edit_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_single_image_edit_flow(message, state, single_input=False)

    @router.message(F.text == IMAGE_EDIT_CONTINUE_RESULT_BUTTON)
    async def on_image_edit_continue_result_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        try:
            await _continue_latest_image_edit_result(message, state)
        except Exception as exc:
            await _answer(message, f"繼續編輯結果圖失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(F.text == IMAGE_EDIT_RERUN_BUTTON)
    async def on_image_edit_rerun_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        try:
            await _rerun_latest_image_edit(message, state)
        except Exception as exc:
            await _answer(message, f"重新生成圖片編輯失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())

    @router.message(F.text == FACE_SWAP_BUTTON)
    @router.message(F.text == "人物換臉")
    async def on_face_swap_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_face_swap_flow(message, state)

    @router.message(F.text == IMAGE_REPLACE_BUTTON)
    @router.message(F.text == "圖片替換")
    async def on_image_replace_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_image_reference_flow(message, state, mode="image_replace")

    @router.message(F.text == TOOL_R18_PERSONA_BUTTON)
    @router.message(F.text == IMAGE_WORKFLOW_BUTTON)
    @router.message(F.text == "圖像編輯")
    @router.message(F.text == LEGACY_IMAGE_WORKFLOW_BUTTON)
    @router.message(F.text == "圖像編輯工作流")
    @router.message(F.text == LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON)
    @router.message(F.text == "圖片生成工作流")
    async def on_image_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_image_generate_flow(message, state)

    @router.message(F.text == VIDEO_EDIT_BUTTON)
    @router.message(F.text == "視頻編輯")
    @router.message(F.text == "視頻編輯")
    async def on_video_edit_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await _answer(message,
            "視頻生成：請選擇要建立的任務。",
            reply_markup=_video_edit_keyboard(),
        )

    @router.message(F.text == VIDEO_GENERAL_EDIT_BUTTON)
    @router.message(F.text == "視頻編輯任務")
    @router.message(F.text == "圖生視頻")
    @router.message(F.text == "視頻編輯任務")
    async def on_video_general_edit_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_video_i2v_flow(message, state)

    @router.message(F.text == MAIN_MENU_BUTTON)
    @router.message(F.text == "返回主選單")
    @router.message(F.text == "返回主菜單")
    async def on_main_menu_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await _answer(message, "已返回主選單。", reply_markup=_menu_keyboard())

    @router.message(F.text == REPLACE_MODEL_WORKFLOW_BUTTON)
    @router.message(F.text == "視頻模特替換")
    @router.message(F.text == "視頻模特替換")
    @router.message(F.text == LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON)
    @router.message(F.text == "模特替換工作流")
    async def on_replace_model_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_replace_model_flow(message, state)

    @router.message(F.text == REPLACE_PRODUCT_WORKFLOW_BUTTON)
    @router.message(F.text == "視頻商品替換")
    @router.message(F.text == "視頻商品替換")
    @router.message(F.text == LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON)
    @router.message(F.text == "商品替換工作流")
    async def on_replace_product_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_replace_product_flow(message, state)

    @router.message(F.text == REPLACE_UNION_WORKFLOW_BUTTON)
    @router.message(F.text == "聯合替換工作流")
    @router.message(F.text == "聯合替換工作流")
    async def on_replace_union_workflow_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await start_union_flow(message, state)

    @router.message(F.text == WORKFLOW_CONFIG_BUTTON)
    @router.message(F.text == "查看後臺工作流配置")
    async def on_workflow_config_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await _answer(message, _workflow_config_text(service, selected_button=_message_text(message)), reply_markup=_menu_keyboard())

    @router.message(F.text == TOOL_R18_STATUS_BUTTON)
    @router.message(F.text == STATUS_BUTTON)
    @router.message(F.text == "查看工作臺狀態")
    @router.message(F.text == "查看工作臺狀態")
    async def on_status_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await answer_status(message)

    @router.message(F.text == TOOL_R18_SCHEDULE_BUTTON)
    @router.message(F.text == TOOL_R18_CLOUD_BUTTON)
    @router.message(F.text == WORKBENCH_BUTTON)
    @router.message(F.text == "工作臺網址")
    async def on_workbench_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        await _answer(message,
            f"工作臺網址: {service.resolve_config().public_base_url}",
            reply_markup=_menu_keyboard(),
        )

    @router.message(F.text == SET_SCRIPT_BUTTON)
    @router.message(F.text == "設置預設文案")
    @router.message(F.text == "設定預設文案")
    async def on_setscript_button(message: Message, state: FSMContext) -> None:
        if not await ensure_authorized(message):
            return
        await state.clear()
        await state.set_state(ScriptForm.waiting_for_script)
        await _answer(message, "請直接貼上你想作爲預設的文案內容。", reply_markup=_menu_keyboard())

    @router.message(F.text == RERUN_BUTTON)
    @router.message(F.text == "重跑最近任務")
    @router.message(F.text == "重跑最近任務")
    async def on_rerun_button(message: Message) -> None:
        if not await ensure_authorized(message):
            return
        latest_task = service.get_latest_task_for_submitter(int(message.chat.id))
        if latest_task is None:
            await _answer(message, "你目前還沒有可重跑的歷史任務。", reply_markup=_menu_keyboard())
            return
        request = service.clone_task_request(latest_task.id)
        await enqueue_request(message, request, source="telegram-rerun", is_default_assets=request.publish_to_default_paths)

    @router.message(F.text == TOOL_R18_STOP_BUTTON)
    @router.message(F.text == STOP_BUTTON)
    @router.message(F.text == "強制停止目前任務")
    @router.message(F.text == "強制停止目前任務")
    @router.message(F.text == "強制停止當前任務")
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
        work_dir = service.create_job_dir(prefix="tg_agent")
        files: list[dict[str, str]] = []
        try:
            downloaded = await _download_agent_message_file(message, work_dir)
            if downloaded:
                files.append(downloaded)
        except Exception as exc:
            await _answer(message, f"素材下載失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
            return
        if not text and not files:
            await _answer(message, "請用文字描述你要建立的生產任務，或按面板入口依序提交素材。", reply_markup=_menu_keyboard())
            return
        if not text:
            text = "根據我上傳的素材判斷最合適的生產工作流，並生成需要的提示詞。"
        await state.clear()
        if text and not files:
            try:
                params = _text_to_image_params()
                await state.update_data(aspect_ratio=params["aspect_ratio"], width=params["width"], height=params["height"])
                await _preview_text_to_image_prompt(message, state, user_request=text)
            except Exception as exc:
                await _answer(message, f"Grok 提示詞生成失敗：{_format_tg_user_error(exc)}", reply_markup=_menu_keyboard())
            return
        try:
            result = await _submit_internal_webapp_agent_task(
                chat_id=int(message.chat.id),
                message_text=text,
                files=files,
            )
        except Exception as exc:
            await _answer(message,
                f"智能任務提交失敗：{_format_tg_user_error(exc)}\n\n你也可以按面板中的具體工作流入口，依序上傳素材。",
                reply_markup=_menu_keyboard(),
            )
            return
        summary = str(result.get("summary") or "已通過文字模型識別任務").strip()
        if result.get("submitted") is False:
            reply = str(result.get("reply") or summary or "").strip()
            if not reply:
                reply = "請補充具體生產任務和必要素材，或按面板入口依序提交。"
            await _answer(message, reply, reply_markup=_menu_keyboard())
            return
        await _answer(message,
            "\n".join(
                part
                for part in [
                    "已通過文字模型理解你的會話，並生成工作流提示詞。",
                    summary,
                    f"工作流: {result.get('task_type')}",
                    f"任務編號: {result.get('id')}",
                    "可按「查看工作臺狀態」跟進進度。",
                ]
                if part
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
                await self.dispatcher.start_polling(self.bot, handle_signals=False)
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Telegram polling stopped unexpectedly; retrying in 5 seconds.")
                await asyncio.sleep(5)

    async def start(self) -> None:
        self.service.attach_bot(self.bot)
        self.polling_task = asyncio.create_task(self._polling_loop(), name="workspace-bot-polling")
        for member in self.service.list_members():
            if member.enabled:
                try:
                    await self.bot.send_message(
                        member.chat_id,
                        "\n".join(
                            [
                                f"{self.service.get_app_title()} 已上線。",
                                f"圖像任務按「{IMAGE_WORKFLOW_BUTTON}」後選擇「{TEXT_TO_IMAGE_BUTTON}」。",
                                f"視頻任務按「{VIDEO_EDIT_BUTTON}」後選擇「{VIDEO_GENERAL_EDIT_BUTTON}」。",
                                "提交後任務會進入後臺隊列；可按「查看工作臺狀態」，並在 Web 任務詳情查看進度與成品。",
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
