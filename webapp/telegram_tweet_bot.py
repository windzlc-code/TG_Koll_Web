from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from .db import db


logger = logging.getLogger(__name__)

PAGE_SIZE = 6
MAX_TELEGRAM_MEDIA_BYTES = 20 * 1024 * 1024
PERSONA_CONTROL_BUTTON = "👤 我的人设"
TASK_CONTROL_BUTTON = "📊 排程状态"
LEGACY_TASK_CONTROL_BUTTON = "📋 任务中心"
ACCOUNT_CONTROL_BUTTON = "🔐 账号管理"
LEGACY_ACCOUNT_CONTROL_BUTTON = "🔐 账号与浏览器"
STOP_CONTROL_BUTTON = "🛑 停止当前任务"
CONTROL_BUTTONS = frozenset({
    PERSONA_CONTROL_BUTTON,
    TASK_CONTROL_BUTTON,
    LEGACY_TASK_CONTROL_BUTTON,
    ACCOUNT_CONTROL_BUTTON,
    LEGACY_ACCOUNT_CONTROL_BUTTON,
    STOP_CONTROL_BUTTON,
})
HELP_TEXT = (
    "使用提示\n\n"
    "• 首次使用请点击“在聊天中登录并绑定”，按提示在本私聊中完成登录。\n"
    "• 登录后会为该 Telegram 账号建立独立会话，不会退出其他浏览器设备。\n"
    "• 未绑定或会话失效时发送 /bind，可重新开始聊天内登录。\n"
    "• 人设、生成、草稿、收藏、媒体、热点和任务均可直接在 Telegram 内操作。\n"
    "• “我的人设”按人设管理、新建推文、推文内容、发布管理、人设设置分层。\n"
    "• 首次发布前需已有可用的 Threads 或 Instagram 账号；可从“账号管理”逐步完成授权、登录检测和人设绑定。\n"
    "• 在输入流程中点击任一总控按钮，会退出当前未提交的输入并切换模块。\n"
    "• 旧版网页绑定路径不接收账号密码；聊天内登录仅在私聊临时验证，密码不写入 Bot 状态或审计，请勿在群聊中发送。"
)
SUPPORTED_MEDIA_MIME_SUFFIXES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
}
PERSONA_CONTENT_PLATFORMS: tuple[tuple[str, str], ...] = (
    ("threads", "Threads"),
    ("instagram", "Instagram"),
)
PERSONA_WRITING_LOCALES: tuple[tuple[str, str], ...] = (
    ("zh-TW", "繁体中文（默认）"),
    ("zh-CN", "简体中文"),
    ("en-US", "英语"),
    ("ja-JP", "日语"),
    ("ko-KR", "韩语"),
    ("vi-VN", "越南语"),
    ("th-TH", "泰语"),
    ("id-ID", "印度尼西亚语"),
    ("ms-MY", "马来语"),
    ("es-ES", "西班牙语"),
    ("pt-BR", "葡萄牙语"),
    ("fr-FR", "法语"),
    ("de-DE", "德语"),
)
PERSONA_CONTENT_TIME_SLOTS: tuple[tuple[str, str], ...] = (
    ("", "不指定"),
    ("morning", "早上文案"),
    ("night", "晚上文案"),
)
# Keep the Telegram controls on the same canonical values used by the Web
# persona-image form.  Empty values mean “自动”; the backend deliberately
# omits them so untouched defaults still use the original R18 prompt path.
PERSONA_IMAGE_OPTION_DEFINITIONS: dict[str, tuple[str, tuple[tuple[str, str], ...]]] = {
    "digital_human_character_region": (
        "地区特征",
        (("china", "中国（默认）"), ("europe_america", "欧美"), ("indonesia", "印尼"),
         ("thailand", "泰国"), ("japan", "日本"), ("malaysia", "马来西亚")),
    ),
    "character_gender": (
        "性别",
        (("", "自动"), ("female", "女性"), ("male", "男性")),
    ),
    "character_age": (
        "年龄段",
        (("", "自动"), ("18_22", "18-22岁"), ("23_27", "23-27岁"), ("28_32", "28-32岁"),
         ("33_38", "33-38岁"), ("39_45", "39-45岁"), ("46_55", "46-55岁"), ("56_plus", "56岁以上")),
    ),
    "character_hairstyle": (
        "发型",
        (("", "自动"), ("short_clean", "利落短发"), ("side_part", "偏分短发"), ("bob", "波波头"),
         ("shoulder_length", "中长发"), ("long_straight", "长直发"), ("soft_wave", "微卷发"),
         ("ponytail", "马尾"), ("bun", "盘发"), ("air_bangs_long", "刘海长发"),
         ("crew_cut", "寸头"), ("textured_short", "纹理短发"), ("slick_back", "背头"),
         ("medium_layered", "中短层次发")),
    ),
    "character_temperament": (
        "气质风格",
        (("", "自动"), ("gentle", "亲和自然"), ("business", "商务干练"), ("elegant", "优雅知性"),
         ("lively", "活力外向"), ("sweet", "清新亲切"), ("cool", "高级冷感"), ("calm", "沉稳大气"),
         ("adult_glamour", "妩媚性感"), ("sunny", "阳光亲和"), ("elite", "精英专业"), ("street", "潮流自信")),
    ),
    "character_clothing": (
        "服装风格",
        (("", "自动"), ("formal_suit", "正式西装套装"), ("smart_casual_set", "通勤休闲套装"),
         ("soft_knit_set", "针织舒适套装"), ("casual_jacket_set", "休闲夹克套装"), ("sporty", "运动套装"),
         ("tailored_suit_female", "女士西装套装"), ("business_dress_female", "轻商务裙装套装"),
         ("elegant_commute_female", "优雅通勤套装"), ("soft_knit_set_female", "温柔针织套装"),
         ("sporty_female", "运动休闲套装"), ("intimate_glamour_female", "福利诱惑套装"),
         ("blazer_dress_female", "轻商务连衣裙套装"), ("shirt_skirt_female", "学院感半裙套装"),
         ("knit_jeans_female", "针织休闲套装"), ("sweet_female", "清新甜美裙装套装"),
         ("silk_blouse_trousers_female", "高级通勤套装"), ("elegant_female", "优雅知性裙装套装"),
         ("knit_cardigan_female", "温柔针织裙装套装"), ("daily_female", "简洁日常套装"),
         ("dark_suit_male", "男士西装套装"), ("smart_commute_male", "商务通勤套装"),
         ("polo_casual_male", "商务休闲套装"), ("casual_jacket_male", "成熟休闲套装"),
         ("sporty_male", "运动休闲套装"), ("shirt_chinos_male", "清爽通勤套装"),
         ("polo_chinos_male", "轻商务休闲套装"), ("street_male", "潮流街头套装"),
         ("knit_male", "简约针织套装"), ("knit_cardigan_male", "温和针织套装"),
         ("shirt_trousers_male", "稳重通勤套装"),
    ),
    ),
}

# The Web form narrows hairstyle/temperament/clothing choices when gender or
# age changes.  Keep the same dependency rules in Telegram so an old choice
# cannot silently override a newly selected profile bucket.
_PERSONA_IMAGE_DYNAMIC_KEYS: dict[str, dict[str, tuple[str, ...]]] = {
    "character_hairstyle": {
        "default": ("", "short_clean", "shoulder_length", "long_straight"),
        "female": ("", "bob", "shoulder_length", "long_straight", "soft_wave", "ponytail", "bun", "air_bangs_long"),
        "male": ("", "short_clean", "side_part", "crew_cut", "textured_short", "slick_back", "medium_layered"),
    },
    "character_temperament": {
        "default": ("", "gentle", "business", "elegant", "lively", "adult_glamour"),
        "female": ("", "elegant", "gentle", "sweet", "cool", "business", "adult_glamour"),
        "female_young": ("", "sweet", "lively", "gentle", "cool", "elegant", "adult_glamour"),
        "female_mature": ("", "elegant", "business", "gentle", "cool", "calm", "adult_glamour"),
        "male": ("", "business", "calm", "sunny", "elite", "elegant"),
        "male_young": ("", "lively", "business", "sunny", "cool", "street"),
        "male_mature": ("", "business", "calm", "gentle", "elite", "elegant"),
    },
    "character_clothing": {
        "default": ("", "formal_suit", "smart_casual_set", "soft_knit_set", "casual_jacket_set", "sporty", "intimate_glamour_female"),
        "female": ("", "tailored_suit_female", "business_dress_female", "elegant_commute_female", "soft_knit_set_female", "sporty_female", "intimate_glamour_female"),
        "female_young": ("", "blazer_dress_female", "shirt_skirt_female", "knit_jeans_female", "sweet_female", "sporty_female", "intimate_glamour_female"),
        "female_mature": ("", "tailored_suit_female", "silk_blouse_trousers_female", "elegant_female", "knit_cardigan_female", "daily_female", "intimate_glamour_female"),
        "male": ("", "dark_suit_male", "smart_commute_male", "polo_casual_male", "casual_jacket_male", "sporty_male"),
        "male_young": ("", "shirt_chinos_male", "polo_chinos_male", "street_male", "knit_male", "sporty_male"),
        "male_mature": ("", "dark_suit_male", "shirt_trousers_male", "polo_casual_male", "casual_jacket_male", "knit_cardigan_male"),
    },
}


def _persona_image_character_profile(options: dict[str, Any]) -> str:
    gender = str(options.get("character_gender") or "").strip()
    if gender not in {"female", "male"}:
        return "default"
    age = str(options.get("character_age") or "").strip()
    if age in {"18_22", "23_27", "28_32"}:
        return f"{gender}_young"
    if age:
        return f"{gender}_mature"
    return gender


def _persona_image_option_definition(
    field: str,
    options: dict[str, Any] | None = None,
) -> tuple[str, tuple[tuple[str, str], ...]] | None:
    definition = PERSONA_IMAGE_OPTION_DEFINITIONS.get(field)
    if not definition:
        return None
    allowed_by_profile = _PERSONA_IMAGE_DYNAMIC_KEYS.get(field)
    if not allowed_by_profile:
        return definition
    if field == "character_hairstyle":
        gender = str((options or {}).get("character_gender") or "").strip()
        profile = gender if gender in {"female", "male"} else "default"
    else:
        profile = _persona_image_character_profile(options or {})
    allowed = set(allowed_by_profile.get(profile) or allowed_by_profile["default"])
    return definition[0], tuple((key, caption) for key, caption in definition[1] if key in allowed)


def _reconcile_persona_image_options(options: dict[str, Any]) -> dict[str, Any]:
    next_options = dict(options or {})
    for field in _PERSONA_IMAGE_DYNAMIC_KEYS:
        definition = _persona_image_option_definition(field, next_options)
        allowed = {key for key, _caption in definition[1]} if definition else {""}
        if str(next_options.get(field) or "") not in allowed:
            next_options.pop(field, None)
    return next_options
try:
    BUSINESS_TIMEZONE = ZoneInfo("Asia/Shanghai")
except ZoneInfoNotFoundError:
    BUSINESS_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


Dispatch = Callable[[int, str, dict[str, Any]], Any]
AsyncDispatch = Callable[[int, str, dict[str, Any]], Awaitable[Any]]
WebAppUrlFactory = Callable[[int, str], str]
WebSessionChecker = Callable[[dict[str, Any]], bool]
ChatLoginHandler = Callable[[int, str, str, dict[str, Any], dict[str, Any] | None], Any]

CHAT_LOGIN_USERNAME_MODE = "chat_login_username"
CHAT_LOGIN_PASSWORD_MODE = "chat_login_password"
CHAT_LOGIN_VERIFICATION_MODE = "chat_login_verification"
CHAT_LOGIN_TTL_SECONDS = 180
CHAT_LOGIN_MAX_ATTEMPTS = 3
CHAT_LOGIN_CANCEL_BUTTON = "❌ 取消登录"
CHAT_LOGIN_BACK_BUTTON = "返回账号管理"


@dataclass(frozen=True)
class TweetWorkbenchOps:
    dispatch: Dispatch
    dispatch_async: AsyncDispatch


def _detect_telegram_proxy() -> str | None:
    """Return the same system proxy used by the other Telegram Bot worker.

    ``aiohttp`` (used by Aiogram) does not read ``HTTP(S)_PROXY`` by default,
    while ``urllib`` (used for the admin token check) does.  On hosts where
    Telegram is reachable only through the configured proxy this mismatch
    makes token verification succeed but polling fail immediately.  Keep the
    lookup opt-in and fail closed to a direct connection when no proxy is
    configured, preserving production environments that have direct egress.
    """
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    try:
        proxies = urllib.request.getproxies()
    except Exception:
        return None
    return str(proxies.get("https") or proxies.get("http") or "").strip() or None


def _json_loads(value: Any, default: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed


def ensure_native_bot_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_states (
          chat_id INTEGER PRIMARY KEY,
          selected_persona_id TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          web_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL DEFAULT '',
          resource_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_tweet_bot_audit_chat "
        "ON telegram_tweet_bot_audit(chat_id, created_at DESC)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_callbacks (
          token TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          expires_at REAL NOT NULL,
          created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_tweet_bot_callbacks_expiry "
        "ON telegram_tweet_bot_callbacks(chat_id, expires_at)"
    )


def callback_token(chat_id: int, action: str, payload: dict[str, Any], *, ttl_seconds: int = 900) -> str:
    token = secrets.token_urlsafe(8).rstrip("=")
    now = time.time()
    with db() as conn:
        ensure_native_bot_schema(conn)
        conn.execute("DELETE FROM telegram_tweet_bot_callbacks WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO telegram_tweet_bot_callbacks(token, chat_id, action, payload_json, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                token, int(chat_id), str(action)[:24],
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                now + max(60, int(ttl_seconds)), now,
            ),
        )
        conn.execute(
            "DELETE FROM telegram_tweet_bot_callbacks WHERE token IN ("
            "SELECT token FROM telegram_tweet_bot_callbacks WHERE chat_id = ? "
            "ORDER BY created_at DESC LIMIT -1 OFFSET 200)",
            (int(chat_id),),
        )
    return f"tt:{action}:{token}"


def resolve_callback_token(chat_id: int, action: str, token: str, *, consume: bool = False) -> dict[str, Any]:
    with db() as conn:
        ensure_native_bot_schema(conn)
        row = conn.execute(
            "SELECT payload_json, expires_at FROM telegram_tweet_bot_callbacks "
            "WHERE token = ? AND chat_id = ? AND action = ?",
            (str(token or ""), int(chat_id), str(action or "")),
        ).fetchone()
        if row is None or float(row["expires_at"] or 0) < time.time():
            raise HTTPException(status_code=410, detail="操作已过期，请返回菜单重新选择")
        payload = _json_loads(row["payload_json"], {})
        if consume:
            deleted = conn.execute(
                "DELETE FROM telegram_tweet_bot_callbacks WHERE token = ? AND chat_id = ? AND action = ?",
                (str(token or ""), int(chat_id), str(action or "")),
            )
            if int(deleted.rowcount or 0) != 1:
                raise HTTPException(status_code=410, detail="操作已执行，请返回菜单查看结果")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="操作参数无效")
    return payload


def load_state(chat_id: int) -> dict[str, Any]:
    with db() as conn:
        ensure_native_bot_schema(conn)
        row = conn.execute(
            "SELECT selected_persona_id, mode, payload_json, updated_at "
            "FROM telegram_tweet_bot_states WHERE chat_id = ?",
            (int(chat_id),),
        ).fetchone()
    if not row:
        return {"selected_persona_id": "", "mode": "", "payload": {}, "updated_at": 0.0}
    payload = _json_loads(row["payload_json"], {})
    return {
        "selected_persona_id": str(row["selected_persona_id"] or ""),
        "mode": str(row["mode"] or ""),
        "payload": payload if isinstance(payload, dict) else {},
        "updated_at": float(row["updated_at"] or 0),
    }


def save_state(
    chat_id: int,
    *,
    selected_persona_id: str | None = None,
    mode: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = load_state(chat_id)
    next_state = {
        "selected_persona_id": (
            str(selected_persona_id or "").strip()
            if selected_persona_id is not None
            else current["selected_persona_id"]
        ),
        "mode": str(mode or "").strip() if mode is not None else current["mode"],
        "payload": dict(payload) if payload is not None else current["payload"],
        "updated_at": time.time(),
    }
    with db() as conn:
        ensure_native_bot_schema(conn)
        conn.execute(
            """
            INSERT INTO telegram_tweet_bot_states(chat_id, selected_persona_id, mode, payload_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
              selected_persona_id = excluded.selected_persona_id,
              mode = excluded.mode,
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
            """,
            (
                int(chat_id),
                next_state["selected_persona_id"],
                next_state["mode"],
                json.dumps(next_state["payload"], ensure_ascii=False, separators=(",", ":")),
                next_state["updated_at"],
            ),
        )
    return next_state


def clear_pending_state(chat_id: int) -> dict[str, Any]:
    current = load_state(chat_id)
    retained = {
        key: value
        for key, value in current["payload"].items()
        if str(key).startswith("last_")
    }
    return save_state(chat_id, mode="", payload=retained)


def audit_action(
    chat_id: int,
    web_user_id: int,
    action: str,
    *,
    status: str,
    resource_type: str = "",
    resource_id: str = "",
    detail: str = "",
) -> None:
    with db() as conn:
        ensure_native_bot_schema(conn)
        conn.execute(
            """
            INSERT INTO telegram_tweet_bot_audit(
              chat_id, web_user_id, action, resource_type, resource_id, status, detail, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(chat_id), int(web_user_id), str(action)[:80], str(resource_type)[:40],
                str(resource_id)[:160], str(status)[:24], str(detail)[:1000], time.time(),
            ),
        )
        conn.execute(
            "DELETE FROM telegram_tweet_bot_audit WHERE id IN ("
            "SELECT id FROM telegram_tweet_bot_audit WHERE chat_id = ? "
            "ORDER BY created_at DESC LIMIT -1 OFFSET 1000)",
            (int(chat_id),),
        )


def parse_schedule_time(value: str) -> int:
    text = str(value or "").strip()
    for pattern in ("%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%m-%d %H:%M"):
        try:
            parsed = datetime.strptime(text, pattern)
        except ValueError:
            continue
        if pattern == "%m-%d %H:%M":
            parsed = parsed.replace(year=datetime.now(BUSINESS_TIMEZONE).year)
        scheduled = parsed.replace(tzinfo=BUSINESS_TIMEZONE)
        timestamp = int(scheduled.timestamp())
        if timestamp <= int(time.time()) + 60:
            raise ValueError("定时时间必须至少晚于当前时间 1 分钟")
        return timestamp
    raise ValueError("请输入 YYYY-MM-DD HH:MM，例如 2026-09-10 18:30")


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            return str(detail.get("message") or detail.get("detail") or detail)
        return str(detail)
    return str(exc) or exc.__class__.__name__


def _post_label(post: dict[str, Any], index: int) -> str:
    title = str(post.get("title") or "").strip()
    content = str(post.get("content") or "").strip().replace("\n", " ")
    return (title or content or f"推文 {index + 1}")[:28]


def _pagination_rows(
    types: Any,
    *,
    page: int,
    total_items: int,
    callback_for_page: Callable[[int], str],
    page_size: int = PAGE_SIZE,
) -> tuple[list[list[Any]], int, int]:
    """Build the R18-style first/previous/page/next/last controls.

    Every list in the Telegram workbench goes through this helper so a stale
    callback can never render an empty out-of-range page and all list views use
    the same navigation labels.  The returned rows mirror R18: first/previous,
    page indicator, and next/last are separate compact rows.
    """
    size = max(1, int(page_size or PAGE_SIZE))
    total = max(0, int(total_items or 0))
    total_pages = max(1, (total + size - 1) // size)
    safe_page = min(max(0, int(page or 0)), total_pages - 1)
    if total_pages <= 1:
        return [], safe_page, total_pages
    rows: list[list[Any]] = []
    if safe_page > 0:
        rows.append([
            types.InlineKeyboardButton(text="⏮ 首页", callback_data=callback_for_page(0)),
            types.InlineKeyboardButton(text="◀️ 上一页", callback_data=callback_for_page(safe_page - 1)),
        ])
    rows.append([
        types.InlineKeyboardButton(text=f"{safe_page + 1}/{total_pages}", callback_data=callback_for_page(safe_page)),
    ])
    if safe_page < total_pages - 1:
        rows.append([
            types.InlineKeyboardButton(text="下一页 ▶️", callback_data=callback_for_page(safe_page + 1)),
            types.InlineKeyboardButton(text="尾页 ⏭", callback_data=callback_for_page(total_pages - 1)),
        ])
    return rows, safe_page, total_pages


def _task_status(task: dict[str, Any]) -> str:
    return str(task.get("status") or task.get("state") or "unknown").strip().lower()


def _task_timestamp(value: Any) -> int:
    if isinstance(value, str):
        text = value.strip()
        if text:
            # The native API currently returns Unix seconds, while R18-style
            # queue projections may use ISO-8601.  Accept both so a task is
            # never silently downgraded from scheduled to immediate.
            try:
                value = float(text)
            except ValueError:
                try:
                    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=BUSINESS_TIMEZONE)
                    return max(0, int(parsed.timestamp()))
                except ValueError:
                    return 0
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _task_is_pending(task: dict[str, Any]) -> bool:
    return _task_status(task) in {"preparing", "pending", "queued", "scheduled"}


def _task_is_scheduled(task: dict[str, Any], *, now: int | None = None) -> bool:
    if not _task_is_pending(task):
        return False
    scheduled_at = _task_timestamp(task.get("scheduled_at"))
    if scheduled_at <= 0:
        return False
    created_at = _task_timestamp(task.get("created_at"))
    current = int(now if now is not None else time.time())
    # Match the R18 distinction: a task scheduled materially after creation
    # is a timed task; an immediate queue item is not.
    return scheduled_at > current + 60 or (created_at > 0 and scheduled_at - created_at > 60)


def _task_bucket(task: dict[str, Any], *, now: int | None = None) -> str:
    status = _task_status(task)
    manual_required = bool(task.get("manual_intervention_required"))
    if status == "paused":
        return "paused"
    if status == "need_manual" or manual_required:
        return "manual"
    if status in {"failed", "error"}:
        return "failed"
    if status in {"running", "publishing", "retrying"}:
        return "running"
    if _task_is_pending(task):
        return "scheduled" if _task_is_scheduled(task, now=now) else "immediate"
    if status in {"cancelled", "canceled"}:
        return "cancelled"
    if status in {"success", "succeeded", "done", "completed", "complete"}:
        return "completed"
    return "completed"


def _task_time_text(value: Any) -> str:
    timestamp = _task_timestamp(value)
    if timestamp <= 0:
        return "未安排"
    return datetime.fromtimestamp(timestamp, BUSINESS_TIMEZONE).strftime("%m-%d %H:%M")


def _task_display_name(task: dict[str, Any]) -> str:
    summary = task.get("task_summary") if isinstance(task.get("task_summary"), dict) else {}
    detail = str(summary.get("detail") or "").strip()
    if detail:
        return detail[:72]
    task_type = str(task.get("type") or task.get("task_type") or "任务").strip()
    platform = str(task.get("platform") or "").strip()
    return " · ".join(item for item in (platform, task_type) if item)[:72]


def _task_list_label(task: dict[str, Any], *, now: int | None = None) -> str:
    """Keep the list button useful without making Telegram rows too dense."""
    status = _task_status(task)
    platform = str(task.get("platform") or "").strip()
    account = str(
        task.get("account_display_name")
        or task.get("account_username")
        or ""
    ).strip()
    persona = str(task.get("persona_name") or task.get("persona_id") or "").strip()
    when = _task_timestamp(task.get("scheduled_at"))
    context = " / ".join(item for item in (platform, account or persona) if item)
    timing = _task_time_text(when) if when and _task_bucket(task, now=now) == "scheduled" else ""
    suffix = " · ".join(item for item in (context, timing) if item)
    return " · ".join(item for item in (status, suffix, _task_display_name(task)) if item)[:56]


class NativeTweetBotController:
    def __init__(
        self,
        *,
        ops: TweetWorkbenchOps,
        get_runtime: Callable[[], dict[str, Any]],
        load_member: Callable[[int], Any],
        remember_member_profile: Callable[..., None] | None = None,
        create_webapp_url: WebAppUrlFactory | None = None,
        has_active_web_session: WebSessionChecker | None = None,
        chat_login: ChatLoginHandler | None = None,
    ) -> None:
        self.ops = ops
        self.get_runtime = get_runtime
        self.load_member = load_member
        self.remember_member_profile = remember_member_profile
        self.create_webapp_url = create_webapp_url
        self.has_active_web_session = has_active_web_session
        self.chat_login = chat_login
        # Passwords are deliberately kept only in this process-local map while
        # a Telegram chat completes the login challenge.  The durable Bot state
        # stores the stage and username, never the password or verification
        # secret.  A restart therefore fails closed and asks the user to start
        # again rather than recovering credentials from disk.
        self._chat_login_lock = threading.RLock()
        self._chat_login_pending: dict[int, dict[str, Any]] = {}

    def _member(self, chat_id: int) -> dict[str, Any] | None:
        row = self.load_member(int(chat_id))
        return dict(row) if row is not None else None

    def _member_still_bound(self, chat_id: int, user_id: int) -> bool:
        member = self._member(chat_id)
        if member is None or int(member.get("web_user_id") or 0) != int(user_id):
            return False
        if self.has_active_web_session is None:
            return True
        try:
            return bool(self.has_active_web_session(member))
        except Exception:
            logger.debug("Failed to validate bound web session", exc_info=True)
            return False

    async def _call(self, user_id: int, action: str, payload: dict[str, Any] | None = None) -> Any:
        return await asyncio.to_thread(self.ops.dispatch, int(user_id), action, payload or {})

    async def _call_async(self, user_id: int, action: str, payload: dict[str, Any] | None = None) -> Any:
        return await self.ops.dispatch_async(int(user_id), action, payload or {})

    def _webapp_markup(self, types: Any, chat_id: int) -> Any | None:
        if self.create_webapp_url is None:
            return None
        try:
            try:
                url = str(self.create_webapp_url(int(chat_id), "home") or "").strip()
            except TypeError:
                # Keep compatibility with integrations that supplied the
                # original one-argument URL factory before route keys were
                # introduced.
                url = str(self.create_webapp_url(int(chat_id)) or "").strip()  # type: ignore[misc]
        except Exception:
            logger.debug("Failed to create Telegram WebApp binding ticket", exc_info=True)
            return None
        if not url:
            return None
        button = types.InlineKeyboardButton
        web_app_info_type = getattr(types, "WebAppInfo", None)
        if web_app_info_type is not None:
            return types.InlineKeyboardMarkup(inline_keyboard=[[
                button(text="🔐 一键登录并绑定", web_app=web_app_info_type(url=url)),
            ]])
        return types.InlineKeyboardMarkup(inline_keyboard=[[
            button(text="打开绑定页面", url=url),
        ]])

    def _binding_markup(self, types: Any, chat_id: int) -> Any | None:
        """Return the production binding action without opening a WebApp.

        The WebApp remains a compatibility fallback for isolated integrations
        that do not inject ``chat_login``.  The production worker always
        injects the chat-login callback, so users stay in the Telegram chat.
        """
        if self.chat_login is not None:
            return types.InlineKeyboardMarkup(inline_keyboard=[[
                types.InlineKeyboardButton(
                    text="🔐 在聊天中登录并绑定",
                    callback_data="tt:chatlogin",
                ),
            ]])
        return self._webapp_markup(types, chat_id)

    @staticmethod
    def _chat_login_keyboard(types: Any, placeholder: str) -> Any:
        """Keep login actions on the same inline callback page as Video Bot.

        ``placeholder`` is retained for API compatibility and documentation;
        credentials still arrive as private-chat messages and never travel in
        callback data.  The persistent four-button workbench keyboard remains
        the only total-control keyboard.
        """
        _ = placeholder
        return types.InlineKeyboardMarkup(inline_keyboard=[
            [types.InlineKeyboardButton(
                text=CHAT_LOGIN_CANCEL_BUTTON,
                callback_data="tt:login_cancel",
            )],
            [types.InlineKeyboardButton(
                text=CHAT_LOGIN_BACK_BUTTON,
                callback_data="tt:accountmenu",
            )],
        ])

    async def _finish_chat_login_cancel(
        self,
        message: Any,
        types: Any,
        *,
        return_to_account: bool = False,
    ) -> None:
        """Close the credential FSM and render the correct next surface.

        The action is intentionally button-driven.  If a member is already
        bound, return to the account-management page; for a first-time login,
        keep the self-service binding button available.  A transient backend
        failure must never leave the login keyboard/state hanging.
        """
        chat_id = int(getattr(getattr(message, "chat", None), "id", 0) or 0)
        self._clear_chat_login(chat_id)
        member = self._member(chat_id)
        if member:
            try:
                page_text, markup = await self._account_management_payload(types, member)
                prefix = "已返回账号管理。" if return_to_account else "已取消推文工作台登录。"
                await message.answer(f"{prefix}\n\n{page_text}", reply_markup=markup)
                return
            except Exception:
                logger.debug("Unable to render tweet account menu after login cancel", exc_info=True)
        markup = self._binding_markup(types, chat_id)
        prefix = "已返回账号管理。" if return_to_account else "已取消推文工作台登录。"
        await message.answer(
            f"{prefix}\n如需继续，请点击下方按钮重新开始。",
            **({"reply_markup": markup} if markup is not None else {}),
        )

    def _clear_chat_login(self, chat_id: int) -> None:
        with self._chat_login_lock:
            self._chat_login_pending.pop(int(chat_id), None)
        state = load_state(int(chat_id))
        if state["mode"] in {
            CHAT_LOGIN_USERNAME_MODE,
            CHAT_LOGIN_PASSWORD_MODE,
            CHAT_LOGIN_VERIFICATION_MODE,
        }:
            clear_pending_state(int(chat_id))

    @staticmethod
    async def _delete_sensitive_message(message: Any) -> None:
        delete = getattr(message, "delete", None)
        if delete is None:
            return
        try:
            await delete()
        except Exception:
            # Deletion is best-effort: Telegram clients/permissions can reject
            # it, but the password is still never written by this worker.
            logger.debug("Unable to delete Telegram login message", exc_info=True)

    @staticmethod
    def _chat_login_error_code(exc: BaseException) -> str:
        if isinstance(exc, HTTPException) and isinstance(exc.detail, dict):
            return str(exc.detail.get("code") or "").strip()
        return ""

    @staticmethod
    def _chat_login_verification_detail(exc: BaseException) -> dict[str, Any]:
        if not isinstance(exc, HTTPException) or not isinstance(exc.detail, dict):
            return {}
        detail = exc.detail.get("verification")
        return dict(detail) if isinstance(detail, dict) else {}

    async def _start_chat_login(self, message: Any, types: Any, *, from_user: Any | None = None) -> None:
        chat = getattr(message, "chat", None)
        actor = from_user or getattr(message, "from_user", None)
        chat_id = int(getattr(chat, "id", 0) or 0)
        if (
            chat is None
            or str(getattr(chat, "type", "") or "") != "private"
            or actor is None
            or int(getattr(actor, "id", 0) or 0) != chat_id
        ):
            await message.answer("聊天内登录绑定只支持与推文 Bot 私聊使用。")
            return
        if self.chat_login is None:
            markup = self._webapp_markup(types, chat_id)
            await message.answer(
                "当前版本暂未启用聊天内登录，请使用安全绑定入口。",
                **({"reply_markup": markup} if markup is not None else {}),
            )
            return
        self._clear_chat_login(chat_id)
        started_at = time.time()
        save_state(chat_id, mode=CHAT_LOGIN_USERNAME_MODE, payload={"started_at": started_at})
        await message.answer(
            "🔐 聊天内登录绑定\n"
            "请发送 VECTO 用户名或邮箱（仅限私聊）。收到后再输入密码；"
            "密码仅短暂用于验证，Bot 不保存密码。\n"
            "如需退出，请点击下方“❌ 取消登录”或“返回账号管理”。",
            reply_markup=self._chat_login_keyboard(types, "VECTO 用户名或邮箱"),
        )

    async def _handle_chat_login_text(self, message: Any, types: Any) -> bool:
        if self.chat_login is None:
            return False
        chat = getattr(message, "chat", None)
        actor = getattr(message, "from_user", None)
        chat_id = int(getattr(chat, "id", 0) or 0)
        if (
            chat is None
            or str(getattr(chat, "type", "") or "") != "private"
            or actor is None
            or int(getattr(actor, "id", 0) or 0) != chat_id
        ):
            return False
        state = load_state(chat_id)
        mode = str(state.get("mode") or "")
        if mode not in {
            CHAT_LOGIN_USERNAME_MODE,
            CHAT_LOGIN_PASSWORD_MODE,
            CHAT_LOGIN_VERIFICATION_MODE,
        }:
            return False
        raw_text = str(getattr(message, "text", "") or "")
        clean_text = raw_text.strip()
        if clean_text in {CHAT_LOGIN_CANCEL_BUTTON, "/cancel"}:
            await self._finish_chat_login_cancel(message, types)
            return True
        if clean_text in {
            CHAT_LOGIN_BACK_BUTTON,
            ACCOUNT_CONTROL_BUTTON,
            LEGACY_ACCOUNT_CONTROL_BUTTON,
        }:
            await self._finish_chat_login_cancel(message, types, return_to_account=True)
            return True
        if not clean_text:
            await message.answer(
                "输入不能为空，请重新发送，或点击下方“❌ 取消登录”退出。",
                reply_markup=self._chat_login_keyboard(types, "VECTO 用户名或邮箱"),
            )
            return True
        if time.time() - float(state.get("updated_at") or 0) > CHAT_LOGIN_TTL_SECONDS:
            self._clear_chat_login(chat_id)
            markup = self._binding_markup(types, chat_id)
            await message.answer(
                "登录绑定已超时，请重新点击“在聊天中登录并绑定”。",
                **({"reply_markup": markup} if markup is not None else {}),
            )
            return True
        if mode == CHAT_LOGIN_USERNAME_MODE:
            if clean_text.startswith("/") or len(clean_text) > 254:
                await message.answer(
                    "请输入有效的 VECTO 用户名或邮箱，不要发送命令。\n"
                    "如需退出，请点击下方“❌ 取消登录”。",
                    reply_markup=self._chat_login_keyboard(types, "VECTO 用户名或邮箱"),
                )
                return True
            started_at = float(state["payload"].get("started_at") or time.time())
            with self._chat_login_lock:
                self._chat_login_pending[chat_id] = {
                    "username": clean_text,
                    "password": "",
                    "attempts": 0,
                    "started_at": started_at,
                    "profile": {
                        "id": chat_id,
                        "username": str(getattr(actor, "username", "") or "").strip().lstrip("@"),
                        "display_name": " ".join(
                            part for part in (
                                str(getattr(actor, "first_name", "") or "").strip(),
                                str(getattr(actor, "last_name", "") or "").strip(),
                            ) if part
                        ).strip(),
                    },
                }
            save_state(chat_id, mode=CHAT_LOGIN_PASSWORD_MODE, payload={
                "username": clean_text,
                "started_at": started_at,
            })
            await self._delete_sensitive_message(message)
            await message.answer(
                "账号已收到。请发送密码（单独一条消息）；验证后会立即尝试删除该消息。\n"
                "如需退出，请点击下方“❌ 取消登录”或“返回账号管理”。",
                reply_markup=self._chat_login_keyboard(types, "VECTO 登录密码"),
            )
            return True

        with self._chat_login_lock:
            pending = dict(self._chat_login_pending.get(chat_id) or {})
        if not pending or not str(pending.get("username") or "").strip():
            self._clear_chat_login(chat_id)
            markup = self._binding_markup(types, chat_id)
            await message.answer(
                "登录状态已丢失，请重新点击“在聊天中登录并绑定”。",
                **({"reply_markup": markup} if markup is not None else {}),
            )
            return True
        password = raw_text if mode == CHAT_LOGIN_PASSWORD_MODE else str(pending.get("password") or "")
        verification: dict[str, Any] | None = None
        if mode == CHAT_LOGIN_PASSWORD_MODE:
            if len(password) > 256:
                await self._delete_sensitive_message(message)
                await message.answer(
                    "密码长度无效，请重新发送，或点击下方“❌ 取消登录”退出。",
                    reply_markup=self._chat_login_keyboard(types, "VECTO 登录密码"),
                )
                return True
            pending["password"] = password
            pending["attempts"] = int(pending.get("attempts") or 0) + 1
        else:
            verification = {
                "security_verification_method": str(pending.get("verification_method") or "").strip(),
                "security_challenge_id": str(pending.get("security_challenge_id") or "").strip(),
                "security_verification_code": clean_text,
            }
        await self._delete_sensitive_message(message)
        try:
            result = await asyncio.to_thread(
                self.chat_login,
                chat_id,
                str(pending["username"]),
                password,
                dict(pending.get("profile") or {}),
                verification,
            )
        except Exception as exc:
            code = self._chat_login_error_code(exc)
            verification_detail = self._chat_login_verification_detail(exc)
            if code == "SECURITY_VERIFICATION_REQUIRED" and verification_detail:
                method = str(
                    verification_detail.get("primary_method")
                    or ("email" if verification_detail.get("email_available") else "mfa")
                ).strip().lower()
                if method not in {"email", "mfa"}:
                    method = "mfa"
                pending["verification_method"] = method
                pending["security_challenge_id"] = str(verification_detail.get("challenge_id") or "")
                with self._chat_login_lock:
                    self._chat_login_pending[chat_id] = pending
                save_state(chat_id, mode=CHAT_LOGIN_VERIFICATION_MODE, payload={
                    "username": str(pending["username"]),
                    "started_at": float(pending.get("started_at") or time.time()),
                    "verification_method": method,
                })
                label = "邮箱验证码" if method == "email" else "动态验证码或恢复码"
                await message.answer(
                    f"账号密码已通过第一步校验，请发送{label}完成绑定。\n"
                    "如需退出，请点击下方“❌ 取消登录”或“返回账号管理”。",
                    reply_markup=self._chat_login_keyboard(types, label),
                )
                return True
            attempts = int(pending.get("attempts") or 0)
            with self._chat_login_lock:
                self._chat_login_pending.pop(chat_id, None)
            if attempts >= CHAT_LOGIN_MAX_ATTEMPTS or mode == CHAT_LOGIN_VERIFICATION_MODE:
                self._clear_chat_login(chat_id)
                markup = self._binding_markup(types, chat_id)
                await message.answer(
                    "登录失败次数过多或验证码无效，已结束本次绑定，请稍后重新开始。",
                    **({"reply_markup": markup} if markup is not None else {}),
                )
            else:
                with self._chat_login_lock:
                    pending["password"] = ""
                    self._chat_login_pending[chat_id] = pending
                save_state(chat_id, mode=CHAT_LOGIN_PASSWORD_MODE, payload={
                    "username": str(pending["username"]),
                    "started_at": float(pending.get("started_at") or time.time()),
                })
                await message.answer(
                    "登录失败，请检查账号或密码后重新发送。\n"
                    "如需退出，请点击下方“❌ 取消登录”或“返回账号管理”。",
                    reply_markup=self._chat_login_keyboard(types, "VECTO 登录密码"),
                )
            return True
        finally:
            # Drop the local reference as soon as the callback returns.  The
            # callback itself must never log or persist the password.
            password = ""
        with self._chat_login_lock:
            self._chat_login_pending.pop(chat_id, None)
        clear_pending_state(chat_id)
        await message.answer("✅ 登录并绑定成功，已进入推文工作台。")
        await self.send_main_menu(message, types)
        return True

    async def send_web_login_link(self, message: Any, types: Any) -> None:
        chat = getattr(message, "chat", None)
        from_user = getattr(message, "from_user", None)
        if (
            chat is None
            or str(getattr(chat, "type", "") or "") != "private"
            or from_user is None
            or int(getattr(from_user, "id", 0) or 0) != int(getattr(chat, "id", 0) or 0)
        ):
            await message.answer("绑定网页只支持与推文 Bot 私聊使用。")
            return
        if self.chat_login is not None:
            await self._start_chat_login(message, types)
            return
        markup = self._webapp_markup(types, int(chat.id))
        if markup is None:
            await message.answer("暂时无法生成绑定入口，请稍后重试。")
            return
        await message.answer(
            "请点击下方“一键登录并绑定”，在 Telegram 内安全登录 VECTO。登录后即可使用推文工作台。",
            reply_markup=markup,
        )

    async def _authorized(
        self,
        chat: Any,
        from_user: Any,
        reply: Callable[..., Awaitable[Any]],
        *,
        types: Any | None = None,
        show_webapp_link: bool = False,
    ) -> dict[str, Any] | None:
        chat_id = int(chat.id)
        if str(chat.type or "") != "private" or from_user is None or int(from_user.id) != chat_id:
            await reply("推文工作台仅支持与 Bot 私聊使用。")
            return None
        member = self._member(chat_id)
        if member is None:
            markup = self._binding_markup(types, chat_id) if show_webapp_link and types is not None else None
            await reply(
                "当前 Telegram 账号尚未绑定 VECTO 用户。请点击下方按钮，在聊天中依次输入账号和密码完成绑定。",
                **({"reply_markup": markup} if markup is not None else {}),
            )
            return None
        if self.has_active_web_session is not None:
            try:
                session_active = bool(self.has_active_web_session(member))
            except Exception:
                session_active = False
            if not session_active:
                markup = self._binding_markup(types, chat_id) if show_webapp_link and types is not None else None
                await reply(
                    "网页登录会话已失效。请点击下方按钮，在聊天中重新输入账号和密码完成绑定。",
                    **({"reply_markup": markup} if markup is not None else {}),
                )
                return None
        if self.remember_member_profile is not None:
            username = str(getattr(from_user, "username", "") or "").strip().lstrip("@")
            display_name = " ".join(
                part for part in (
                    str(getattr(from_user, "first_name", "") or "").strip(),
                    str(getattr(from_user, "last_name", "") or "").strip(),
                ) if part
            ).strip()
            if username or display_name:
                try:
                    self.remember_member_profile(
                        chat_id,
                        username=username,
                        display_name=display_name,
                    )
                except Exception:
                    logger.debug("Failed to remember Telegram tweet member profile", exc_info=True)
        return member

    @staticmethod
    def _main_keyboard(types: Any) -> Any:
        button = types.KeyboardButton
        return types.ReplyKeyboardMarkup(
            keyboard=[
                [button(text=PERSONA_CONTROL_BUTTON), button(text=TASK_CONTROL_BUTTON)],
                [button(text=ACCOUNT_CONTROL_BUTTON), button(text=STOP_CONTROL_BUTTON)],
            ],
            resize_keyboard=True,
            is_persistent=True,
            input_field_placeholder="请选择推文工作台功能",
        )

    @staticmethod
    def _return_keyboard(types: Any) -> Any:
        return types.InlineKeyboardMarkup(inline_keyboard=[[
            types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu"),
        ]])

    @staticmethod
    def _step_navigation_markup(
        types: Any,
        *,
        back_callback: str = "tt:menu",
        back_text: str = "返回上一步",
        primary_callback: str = "",
        primary_text: str = "",
    ) -> Any:
        """Render the R18-style controls for a text/media input step.

        Reply keyboards are useful for the persistent workbench controls, but
        they cannot be attached to an individual wizard message.  Every
        transient input step therefore gets an inline escape hatch as well:
        the first row returns to the owning module (or the workbench menu),
        and the second row clears the pending state without requiring command
        text.
        """
        button = types.InlineKeyboardButton
        rows: list[list[Any]] = []
        if str(primary_callback or "").strip():
            rows.append([button(
                text=str(primary_text or "继续"),
                callback_data=str(primary_callback),
            )])
        if str(back_callback or "").strip():
            rows.append([button(text=back_text, callback_data=str(back_callback))])
        rows.append([button(text="取消当前步骤", callback_data="tt:stepcancel")])
        return types.InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def _generation_count_keyboard(types: Any) -> Any:
        return types.InlineKeyboardMarkup(inline_keyboard=[[
            types.InlineKeyboardButton(text="1 篇", callback_data="tt:gcount:1"),
            types.InlineKeyboardButton(text="3 篇", callback_data="tt:gcount:3"),
            types.InlineKeyboardButton(text="5 篇", callback_data="tt:gcount:5"),
        ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]])

    @staticmethod
    def _task_filter_keyboard(types: Any) -> Any:
        button = types.InlineKeyboardButton
        return types.InlineKeyboardMarkup(inline_keyboard=[
            [button(text="📋 待发布", callback_data="tt:tasks:0:pending"), button(text="❌ 失败任务", callback_data="tt:tasks:0:failed")],
            [button(text="⏰ 定时任务", callback_data="tt:tasks:0:scheduled"), button(text="⚡ 立即任务", callback_data="tt:tasks:0:immediate")],
            [button(text="🔄 执行中", callback_data="tt:tasks:0:running"), button(text="🛠 待人工", callback_data="tt:tasks:0:manual")],
            [button(text="✅ 已完成", callback_data="tt:tasks:0:completed"), button(text="⏸ 已暂停", callback_data="tt:tasks:0:paused")],
            [button(text="🚫 已取消", callback_data="tt:tasks:0:cancelled"), button(text="📚 全部任务", callback_data="tt:tasks:0:all")],
            [button(text="🧵 按平台筛选", callback_data="tt:taskfilter:platform"), button(text="👤 按人设筛选", callback_data="tt:taskfilter:persona")],
            [button(text="返回总控菜单", callback_data="tt:menu")],
        ])

    async def send_main_menu(self, message: Any, types: Any) -> None:
        member = await self._authorized(
            message.chat,
            message.from_user,
            message.answer,
            types=types,
            show_webapp_link=True,
        )
        if not member:
            return
        state = load_state(int(message.chat.id))
        selected = ""
        if state["selected_persona_id"]:
            try:
                personas = await self._call(int(member["web_user_id"]), "personas.list")
                current = next((item for item in personas if str(item.get("id")) == state["selected_persona_id"]), None)
                if current:
                    selected = f"\n当前人设：{current.get('name') or '未命名人设'}"
            except Exception:
                selected = ""
        clear_pending_state(int(message.chat.id))
        await message.answer(
            f"当前 Telegram 已绑定且网页登录会话有效。{selected}",
            reply_markup=self._main_keyboard(types),
        )

    async def _handle_control_button(
        self,
        message: Any,
        types: Any,
        member: dict[str, Any],
        text: str,
    ) -> bool:
        if text not in CONTROL_BUTTONS:
            return False
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        if text != STOP_CONTROL_BUTTON:
            clear_pending_state(chat_id)
        try:
            if text == PERSONA_CONTROL_BUTTON:
                page_text, markup = await self._persona_list_payload(types, member, chat_id, 0)
                await message.answer(page_text, reply_markup=markup)
            elif text in {TASK_CONTROL_BUTTON, LEGACY_TASK_CONTROL_BUTTON}:
                status_text, status_markup = await self._task_status_payload(types, member)
                await message.answer(status_text, reply_markup=status_markup)
            elif text in {ACCOUNT_CONTROL_BUTTON, LEGACY_ACCOUNT_CONTROL_BUTTON}:
                page_text, markup = await self._account_management_payload(types, member)
                await message.answer(page_text, reply_markup=markup)
            else:
                await self._stop_current_tasks(message, types, member)
            audit_action(chat_id, user_id, "control.open", status="success", detail=text)
        except Exception as exc:
            logger.exception("Telegram tweet control action failed: %s", text)
            audit_action(chat_id, user_id, "control.open", status="failed", detail=f"{text}: {_error_text(exc)}")
            await message.answer(
                f"打开失败：{_error_text(exc)}",
                reply_markup=self._main_keyboard(types),
            )
        return True

    @staticmethod
    def _resume_payload(chat_id: int, action: str) -> dict[str, Any]:
        state = load_state(chat_id)
        payload = {
            key: value
            for key, value in state["payload"].items()
            if str(key).startswith("last_")
        }
        payload["resume_action"] = action
        return save_state(chat_id, mode="", payload=payload)

    async def _start_generation_setup(self, query: Any, types: Any) -> None:
        chat_id = int(query.message.chat.id)
        save_state(chat_id, mode="generate_count", payload={})
        await query.message.edit_text(
            "AI 生成推文 · 第 1/3 步\n"
            "请选择本次生成数量；数量只决定要创建几篇草稿，不会立即发布。\n"
            "下一步还会设置每篇字数，最后填写主题并进入统一确认页。",
            reply_markup=self._generation_count_keyboard(types),
        )

    async def _start_hot_input(self, query: Any, types: Any) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        last_hot_task_id = str(state["payload"].get("last_hot_task_id") or "")
        last_hot_persona_id = str(state["payload"].get("last_hot_persona_id") or state["selected_persona_id"])
        save_state(chat_id, mode="hot_prompt", payload={
            key: value for key, value in state["payload"].items() if str(key).startswith("last_")
        })
        rows = []
        if last_hot_task_id:
            rows.append([
                types.InlineKeyboardButton(
                    text="查看上次热点任务",
                    callback_data=callback_token(chat_id, "hotstatus", {
                        "task_id": last_hot_task_id, "persona_id": last_hot_persona_id,
                    }),
                ),
                types.InlineKeyboardButton(
                    text="取消上次热点任务",
                    callback_data=callback_token(chat_id, "hotcancel", {
                        "task_id": last_hot_task_id, "persona_id": last_hot_persona_id,
                    }),
                ),
            ])
        rows.append([types.InlineKeyboardButton(text="取消", callback_data="tt:menu")])
        await query.message.edit_text(
            "热点创作 · 第 1/2 步\n"
            "请发送热点主题或关键词；系统会结合当前人设生成可选候选。\n"
            "收到后先展示主题确认页，任务完成后再由你选择保存或改写，不会自动发布。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _persona_list_payload(
        self,
        types: Any,
        member: dict[str, Any],
        chat_id: int,
        page: int,
    ) -> tuple[str, Any]:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        page = max(0, int(page))
        total_pages = max(1, (len(personas) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, total_pages - 1)
        start = page * PAGE_SIZE
        # Keep the selector focused on selecting a persona.  Creation and
        # other global actions live behind the management page so a long
        # persona list never becomes a mixed action menu.
        management_callback = (
            "tt:personamanage"
            if page == 0
            else callback_token(chat_id, "personamanage", {"page": page})
        )
        rows = [[types.InlineKeyboardButton(text="🛠 人设管理", callback_data=management_callback)]]
        state = load_state(chat_id)
        for item in personas[start:start + PAGE_SIZE]:
            persona_id = str(item.get("id") or "")
            marker = "✅ " if persona_id == state["selected_persona_id"] else ""
            count = int((item.get("counts") or {}).get("posts") or 0)
            rows.append([types.InlineKeyboardButton(
                text=f"{marker}{str(item.get('name') or '未命名人设')[:24]}（{count}篇）",
                callback_data=callback_token(chat_id, "p", {
                    "persona_id": persona_id,
                    "page": page,
                }),
            )])
        nav, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(personas),
            callback_for_page=lambda target: f"tt:personas:{target}",
        )
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
        resume_action = str(state["payload"].get("resume_action") or "")
        resume_text = {
            "generate": "AI 生成推文",
            "hot": "热点创作",
            "draft_new": "手工新建草稿",
            "drafts": "查看草稿",
            "favorites": "查看收藏",
            "publish_one": "单篇发布",
        }.get(resume_action, "")
        if personas:
            text = (
                f"{resume_text} · 选择人设\n第 {page + 1}/{total_pages} 页"
                if resume_text
                else f"我的人设（{len(personas)}）\n第 {page + 1}/{total_pages} 页"
            )
        else:
            text = "我的人设\n暂无人设"
        return text, types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _persona_list(self, query: Any, types: Any, member: dict[str, Any], page: int) -> None:
        text, markup = await self._persona_list_payload(
            types, member, int(query.message.chat.id), page,
        )
        await query.message.edit_text(text, reply_markup=markup)

    async def _persona_management(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        page: int = 0,
    ) -> None:
        """Render global persona creation actions separately from selection.

        The Telegram surface follows the R18 pattern of a focused selector
        followed by a compact action page.  Group management is intentionally
        not exposed here; it is a Web-only organization feature.
        """
        button = types.InlineKeyboardButton
        rows = [
            [button(text="➕ 手工新建人设", callback_data="tt:persona_new")],
            [button(text="✨ AI 生成人设", callback_data="tt:persona_ai_new")],
            [button(text="🔗 复制公开人设", callback_data="tt:persona_copy_new")],
            [button(text="返回人设列表", callback_data=f"tt:personas:{max(0, int(page or 0))}")],
        ]
        await query.message.edit_text(
            "人设管理\n\n"
            "新建或复制人设资料；选择具体人设后，再进入推文生成、内容管理、发布和设置。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    @staticmethod
    def _persona_home_text(persona: dict[str, Any]) -> str:
        counts = persona.get("counts") if isinstance(persona.get("counts"), dict) else {}
        content = str(persona.get("content") or "").strip().replace("\n", " ")
        platform_accounts = counts.get("platform_accounts") if isinstance(counts.get("platform_accounts"), list) else []
        platform_text = "、".join(str(item).strip() for item in platform_accounts if str(item).strip()) or "未绑定"
        return (
            f"👤 {persona.get('name') or '未命名人设'}\n\n"
            f"简介：{content[:260] or '未填写'}\n"
            f"草稿：{counts.get('posts', 0)} 篇\n"
            f"收藏：{counts.get('favorites', 0)} 篇 · 已发布：{counts.get('published', 0)} 篇\n"
            f"人设图：{counts.get('images', 0)} 张 · 平台账号：{platform_text}"
        )

    @staticmethod
    def _persona_home_markup(types: Any, chat_id: int, persona_id: str, page: int = 0) -> Any:
        button = types.InlineKeyboardButton
        return types.InlineKeyboardMarkup(inline_keyboard=[
            [
                button(text="✍️ 新建推文", callback_data="tt:pmod:create"),
                button(text="📝 推文内容", callback_data="tt:pmod:content"),
            ],
            [
                button(text="🚀 发布管理", callback_data="tt:pmod:publish"),
                button(text="⚙️ 人设设置", callback_data="tt:pmod:settings"),
            ],
            [button(text="返回我的人设", callback_data=f"tt:personas:{max(0, int(page or 0))}")],
        ])

    @staticmethod
    def _persona_module_back_row(
        types: Any,
        chat_id: int,
        persona_id: str,
        module: str = "",
        page: int = 0,
    ) -> list[Any]:
        if module:
            return [types.InlineKeyboardButton(text="上一步", callback_data=f"tt:pmod:{module}")]
        return [types.InlineKeyboardButton(
            text="上一步",
            callback_data=callback_token(chat_id, "p", {
                "persona_id": persona_id,
                "page": max(0, int(page or 0)),
            }),
        )]

    def _persona_module_payload(
        self,
        types: Any,
        chat_id: int,
        persona_id: str,
        module: str,
        page: int = 0,
        persona: dict[str, Any] | None = None,
    ) -> tuple[str, Any]:
        button = types.InlineKeyboardButton
        # `generate` was the original label used by saved Telegram
        # callbacks.  Keep it as an alias while exposing the clearer
        # create/content/publish taxonomy to new users.
        module = {
            "generate": "create",
            "creation": "create",
            "creationmenu": "create",
            "contentmenu": "content",
            "publishmenu": "publish",
        }.get(str(module or "").strip().lower(), str(module or "").strip().lower())
        back = self._persona_module_back_row(types, chat_id, persona_id, page=page)
        persona_name = str((persona or {}).get("name") or "").strip()
        persona_context = f"当前人设：{persona_name}\n\n" if persona_name else ""
        if module == "settings":
            counts = persona.get("counts") if isinstance(persona, dict) and isinstance(persona.get("counts"), dict) else {}
            platform_accounts = counts.get("platform_accounts") if isinstance(counts.get("platform_accounts"), list) else []
            settings_context = (
                f"{persona_context}"
                f"平台账号：{'、'.join(str(item).strip() for item in platform_accounts if str(item).strip()) or '未绑定'}\n"
                f"待发布推文：{counts.get('posts', 0)} 篇\n"
                f"已发布：{counts.get('published', 0)} 篇\n"
                f"人设图：{counts.get('images', 0)} 张\n\n"
                if persona_name
                else ""
            )
            return (
                "⚙️ 人设设置\n\n" + settings_context
                + "请选择要设置的项目。",
                types.InlineKeyboardMarkup(inline_keyboard=[
                    [
                        button(text="⚙️ 基础资料", callback_data="tt:profile"),
                        button(text="🧑‍🎨 人设图与图库", callback_data="tt:personaimage"),
                    ],
                    [
                        button(text="🔗 平台账号绑定", callback_data="tt:persona_accounts"),
                        button(text="🔄 刷新数据", callback_data=callback_token(chat_id, "prefresh", {
                            "persona_id": persona_id,
                            "persona_page": max(0, int(page or 0)),
                        })),
                    ],
                    [
                        button(text="📄 复制当前人设", callback_data=callback_token(chat_id, "pduplicate", {
                            "persona_id": persona_id,
                            "persona_page": max(0, int(page or 0)),
                        })),
                        button(text="🗑 删除人设", callback_data=callback_token(chat_id, "pdeleteask", {
                            "persona_id": persona_id,
                            "persona_page": max(0, int(page or 0)),
                        })),
                    ],
                    back,
                ]),
            )
        if module == "create":
            return (
                "✍️ 新建推文\n\n" + persona_context
                + "为当前人设创建待发布内容：可用 AI 生成、热点创作，或直接手工保存草稿。",
                types.InlineKeyboardMarkup(inline_keyboard=[
                    [button(text="✨ AI 生成推文", callback_data="tt:generate")],
                    [button(text="🔥 热点创作", callback_data="tt:hot")],
                    [button(text="📝 手工新建草稿", callback_data="tt:draft_new")],
                    back,
                ]),
            )
        if module == "content":
            return (
                "📝 推文内容\n\n" + persona_context
                + "管理当前人设的草稿、收藏和推文配图；编辑只影响当前内容，不会覆盖人设资料。",
                types.InlineKeyboardMarkup(inline_keyboard=[
                    [
                        button(text="📝 草稿与推文", callback_data="tt:postsmenu"),
                        button(text="⭐ 收藏", callback_data="tt:favorites:0"),
                    ],
                    [button(text="🖼 推文配图", callback_data="tt:imageposts:0")],
                    back,
                ]),
            )
        if module == "publish":
            return (
                "🚀 发布管理\n\n" + persona_context
                + "选择内容和已授权平台账号，执行立即/定时发布、矩阵发布，并查看发布历史。",
                types.InlineKeyboardMarkup(inline_keyboard=[
                    [button(text="🚀 发布推文（立即/定时）", callback_data="tt:publish_one")],
                    [
                        button(text="🧩 矩阵发布", callback_data="tt:matrix"),
                        button(text="🕘 发布历史", callback_data="tt:persona_history:0"),
                    ],
                    back,
                ]),
            )
        raise HTTPException(status_code=400, detail="功能模块不存在")

    async def _render_persona_home(
        self,
        query: Any,
        types: Any,
        persona: dict[str, Any],
        chat_id: int,
        *,
        page: int = 0,
    ) -> None:
        persona_id = str(persona.get("id") or "")
        await query.message.edit_text(
            self._persona_home_text(persona),
            reply_markup=self._persona_home_markup(types, chat_id, persona_id, page),
        )

    async def _render_persona_module(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        module: str,
    ) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        persona_id = str(state["selected_persona_id"] or "")
        if not persona_id:
            await self._persona_list(query, types, member, 0)
            return
        page = max(0, int((state.get("payload") or {}).get("persona_list_page") or 0))
        persona = None
        try:
            personas = await self._call(int(member["web_user_id"]), "personas.list")
            persona = next(
                (item for item in (personas if isinstance(personas, list) else [])
                 if isinstance(item, dict) and str(item.get("id") or "") == persona_id),
                None,
            )
        except Exception:
            # Module navigation should still work when the summary refresh is
            # temporarily unavailable; action callbacks perform their own
            # authoritative checks.
            persona = None
        text, markup = self._persona_module_payload(
            types, chat_id, persona_id, module, page=page, persona=persona,
        )
        await query.message.edit_text(text, reply_markup=markup)

    async def _persona_groups(self, query: Any, types: Any, member: dict[str, Any], page: int = 0) -> None:
        """Render the same owner-scoped persona groups exposed by the Web UI."""
        chat_id = int(query.message.chat.id)
        result = await self._call(int(member["web_user_id"]), "persona.groups", {})
        groups = result.get("groups") if isinstance(result, dict) and isinstance(result.get("groups"), list) else []
        groups = [item for item in groups if isinstance(item, dict)]
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        persona_names = {
            str(item.get("id") or "").strip(): str(item.get("name") or "未命名人设")
            for item in (personas if isinstance(personas, list) else [])
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(groups),
            callback_for_page=lambda target: f"tt:personagroups:{target}",
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for group in groups[start:start + PAGE_SIZE]:
            group_id = str(group.get("id") or "").strip()
            if not group_id:
                continue
            members = [
                persona_names.get(str(persona_id or "").strip(), "未命名人设")
                for persona_id in (group.get("persona_ids") or [])
                if str(persona_id or "").strip()
            ]
            label = f"🗂 {str(group.get('name') or '未命名分组')[:24]}（{len(members)}）"
            rows.append([types.InlineKeyboardButton(
                text=label,
                callback_data=callback_token(chat_id, "group", {
                    "group_id": group_id,
                    "groups_page": safe_page,
                }),
            )])
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(text="➕ 新建分组", callback_data="tt:groupnew")])
        rows.append([types.InlineKeyboardButton(text="返回我的人设", callback_data="tt:personas:0")])
        text = (
            f"人设分组（{len(groups)}）\n第 {safe_page + 1}/{total_pages}\n"
            if groups else "人设分组\n暂无分组"
        )
        await query.message.edit_text(text, reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows))

    async def _persona_group_detail(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        group_id: str,
        page: int = 0,
        *,
        groups_page: int = 0,
    ) -> None:
        chat_id = int(query.message.chat.id)
        result = await self._call(int(member["web_user_id"]), "persona.groups", {})
        groups = result.get("groups") if isinstance(result, dict) and isinstance(result.get("groups"), list) else []
        group = next((item for item in groups if isinstance(item, dict) and str(item.get("id") or "") == group_id), None)
        if not group:
            raise HTTPException(status_code=404, detail="人设分组不存在")
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        persona_names = {
            str(item.get("id") or "").strip(): str(item.get("name") or "未命名人设")
            for item in (personas if isinstance(personas, list) else [])
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        member_ids = [
            str(persona_id or "").strip()
            for persona_id in (group.get("persona_ids") or [])
            if str(persona_id or "").strip()
        ]
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(member_ids),
            callback_for_page=lambda target: callback_token(
                chat_id, "group", {
                    "group_id": group_id,
                    "page": target,
                    "groups_page": max(0, int(groups_page or 0)),
                },
            ),
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for persona_id in member_ids[start:start + PAGE_SIZE]:
            clean_id = str(persona_id or "").strip()
            if not clean_id:
                continue
            rows.append([types.InlineKeyboardButton(
                text=f"👤 {persona_names.get(clean_id, '未命名人设')[:24]}",
                callback_data=callback_token(chat_id, "groupremove", {
                    "group_id": group_id,
                    "persona_id": clean_id,
                    "page": safe_page,
                    "groups_page": max(0, int(groups_page or 0)),
                }),
            )])
        rows.extend(nav)
        rows.extend([
            [types.InlineKeyboardButton(
                text="➕ 添加人设",
                callback_data=callback_token(chat_id, "groupadd", {
                    "group_id": group_id,
                    "page": 0,
                    "detail_page": safe_page,
                    "groups_page": max(0, int(groups_page or 0)),
                }),
            )],
            [types.InlineKeyboardButton(text="✏️ 重命名", callback_data=callback_token(chat_id, "grouprename", {
                "group_id": group_id,
                "detail_page": safe_page,
                "groups_page": max(0, int(groups_page or 0)),
            }))],
            [types.InlineKeyboardButton(text="🗑 删除分组", callback_data=callback_token(chat_id, "groupdeleteask", {
                "group_id": group_id,
                "detail_page": safe_page,
                "groups_page": max(0, int(groups_page or 0)),
            }))],
            [types.InlineKeyboardButton(text="返回人设分组", callback_data=f"tt:personagroups:{max(0, int(groups_page or 0))}")],
        ])
        visible_member_ids = member_ids[start:start + PAGE_SIZE]
        members_text = "、".join(
            persona_names.get(persona_id, "未命名人设")
            for persona_id in visible_member_ids
        ) or "暂无成员"
        await query.message.edit_text(
            f"人设分组：{str(group.get('name') or '未命名分组')}\n\n"
            f"成员（{len(member_ids)}，第 {safe_page + 1}/{total_pages} 页）：{members_text}\n\n"
            "点击成员可移出分组；“添加人设”只会调整分组关系，不会删除人设本身。\n"
            "底部导航用于翻页，返回可保留当前分组列表页。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _persona_group_add_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        group_id: str,
        page: int = 0,
        *,
        detail_page: int = 0,
        groups_page: int = 0,
    ) -> None:
        chat_id = int(query.message.chat.id)
        result = await self._call(int(member["web_user_id"]), "persona.groups", {})
        groups = result.get("groups") if isinstance(result, dict) and isinstance(result.get("groups"), list) else []
        group = next((item for item in groups if isinstance(item, dict) and str(item.get("id") or "") == group_id), None)
        if not group:
            raise HTTPException(status_code=404, detail="人设分组不存在")
        assigned = {str(item or "").strip() for item in (group.get("persona_ids") or []) if str(item or "").strip()}
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        candidates = [
            item for item in (personas if isinstance(personas, list) else [])
            if isinstance(item, dict) and str(item.get("id") or "").strip() not in assigned
        ]
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(candidates),
            callback_for_page=lambda target: callback_token(chat_id, "groupadd", {
                "group_id": group_id,
                "page": target,
                "detail_page": max(0, int(detail_page or 0)),
                "groups_page": max(0, int(groups_page or 0)),
            }),
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for persona in candidates[start:start + PAGE_SIZE]:
            persona_id = str(persona.get("id") or "").strip()
            rows.append([types.InlineKeyboardButton(
                text=f"👤 {str(persona.get('name') or '未命名人设')[:32]}",
                callback_data=callback_token(chat_id, "groupaddselect", {
                    "group_id": group_id,
                    "persona_id": persona_id,
                    "detail_page": max(0, int(detail_page or 0)),
                    "groups_page": max(0, int(groups_page or 0)),
                }),
            )])
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(text="返回分组", callback_data=callback_token(chat_id, "group", {
            "group_id": group_id,
            "page": max(0, int(detail_page or 0)),
            "groups_page": max(0, int(groups_page or 0)),
        }))])
        await query.message.edit_text(
            f"添加人设到分组（第 {safe_page + 1}/{total_pages} 页）\n"
            "请选择要加入当前分组的人设；选择后按 Web 端规则调整分组归属，不会删除人设资料。\n"
            "没有可选人设时，请先返回创建人设或检查已有分组关系。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _persona_group_assign_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        persona_id: str,
        page: int = 0,
    ) -> None:
        chat_id = int(query.message.chat.id)
        result = await self._call(int(member["web_user_id"]), "persona.groups", {})
        groups = result.get("groups") if isinstance(result, dict) and isinstance(result.get("groups"), list) else []
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(groups),
            callback_for_page=lambda target: callback_token(
                chat_id, "groupassign", {"persona_id": persona_id, "page": target},
            ),
        )
        start = safe_page * PAGE_SIZE
        rows = [
            [types.InlineKeyboardButton(
                text=f"🗂 {str(group.get('name') or '未命名分组')[:32]}",
                callback_data=callback_token(chat_id, "groupassignselect", {
                    "group_id": str(group.get("id") or ""),
                    "persona_id": persona_id,
                }),
            )]
            for group in groups[start:start + PAGE_SIZE]
            if isinstance(group, dict) and str(group.get("id") or "").strip()
        ]
        rows.extend(nav)
        rows.append(self._persona_module_back_row(types, chat_id, persona_id, "settings"))
        await query.message.edit_text(
            (
                f"请选择要加入的人设分组（第 {safe_page + 1}/{total_pages} 页，共 {len(groups)} 个）。\n"
                "选择后会更新当前人设的分组归属；若已有其他分组，后端按 Web 端规则处理关系。"
                if groups else "暂无分组，请先创建一个分组，再返回人设设置继续。"
            ),
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _accounts_payload(
        self,
        types: Any,
        member: dict[str, Any],
        *,
        return_callback: str,
        persona_id: str = "",
        operation: str = "",
        page: int = 0,
    ) -> tuple[str, Any]:
        chat_id = int(member.get("chat_id") or 0)
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        if persona_id:
            accounts = [
                item for item in accounts
                if str(item.get("persona_id") or "") == str(persona_id)
            ]
        persona_names: dict[str, str] = {}
        try:
            personas = await self._call(int(member["web_user_id"]), "personas.list")
            persona_names = {
                str(item.get("id") or ""): str(item.get("name") or "未命名人设")
                for item in personas if str(item.get("id") or "")
            }
        except Exception:
            # Account operations remain usable if a stale persona archive makes
            # the optional display-name lookup fail.
            logger.debug("Failed to load persona names for Telegram account list", exc_info=True)
        page_rows, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(accounts),
            callback_for_page=lambda target: callback_token(
                chat_id,
                "accountspage",
                {
                    "page": target,
                    "persona_id": persona_id,
                    "operation": operation,
                    "return_callback": return_callback,
                },
            ),
        )
        start = page * PAGE_SIZE
        rows = []
        operation_labels = {
            "switch": "选择并重新登录",
            "bind": "选择并绑定人设",
            "unbind": "选择并解绑人设",
        }
        for item in accounts[start:start + PAGE_SIZE]:
            account_id = str(item.get("id") or "").strip()
            if not account_id:
                continue
            platform = str(item.get("platform") or "未知平台").strip()
            username = str(item.get("username") or "未设置账号").strip().lstrip("@")
            status = str(item.get("status") or "unknown").strip()
            bound_persona_id = str(item.get("persona_id") or "").strip()
            bound_persona = persona_names.get(bound_persona_id, "未绑定人设") if bound_persona_id else "未绑定人设"
            label = f"{platform} · @{username} · {status} · {bound_persona}"
            token = callback_token(chat_id, "ac", {
                "account_id": account_id,
                "operation": operation,
                "page": page,
                "persona_id": persona_id,
                "persona_filter": persona_id,
                "return_callback": return_callback,
            })
            rows.append([types.InlineKeyboardButton(
                text=(operation_labels.get(operation) or "查看账号详情") + f"：{label[:42]}",
                callback_data=token,
            )])
        if not rows:
            text = "已绑定账号\n\n暂无平台账号。可先添加账号，再在账号详情中完成登录检测和人设绑定。"
        else:
            intro = operation_labels.get(operation, "查看账号详情")
            text = f"已绑定账号 · {intro}\n\n请选择一个账号继续操作。"
            text += f"\n第 {page + 1}/{total_pages} 页，共 {len(accounts)} 个账号。"
        rows.extend(page_rows)
        base = str((self.get_runtime() or {}).get("telegram_tweet_public_base_url") or "").rstrip("/")
        if base.startswith("https://"):
            text += "\n点击下方平台按钮会直接进入对应官方授权页；请确保打开的浏览器已有 VECTO 主站登录会话。"
            # Keep the platform choice explicit in Telegram.  The console
            # consumes ``authorize_platform`` after the existing VECTO web
            # session is loaded and starts the matching official OAuth flow;
            # no platform credentials ever pass through the bot.
            rows.append([types.InlineKeyboardButton(
                text="➕ 授权 Threads",
                url=f"{base}/console.html?view=accounts&authorize_platform=threads",
            ), types.InlineKeyboardButton(
                text="➕ 授权 Instagram",
                url=f"{base}/console.html?view=accounts&authorize_platform=instagram",
            )])
            rows.append([types.InlineKeyboardButton(
                text="📂 打开平台账号管理",
                url=f"{base}/console.html?view=accounts",
            )])
        rows.append([types.InlineKeyboardButton(text="返回", callback_data=return_callback)])
        return text, types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _persona_binding_payload(
        self,
        types: Any,
        member: dict[str, Any],
        persona_id: str,
        *,
        page: int = 0,
    ) -> tuple[str, Any]:
        """Show accounts detected for the selected persona and bind actions.

        R18 presents the current persona/account state first and then exposes
        the platform action buttons.  The Web account API is the source of
        truth here: Telegram does not ask users to type a platform handle and
        never receives credentials.  Accounts already owned by another
        persona get an explicit rebind confirmation instead of disappearing
        from the picker.
        """
        chat_id = int(member.get("chat_id") or 0)
        user_id = int(member["web_user_id"])
        persona_id = str(persona_id or "").strip()
        if not persona_id:
            raise HTTPException(status_code=400, detail="请先选择人设")
        accounts_raw = await self._call(user_id, "accounts.list")
        accounts = [item for item in (accounts_raw if isinstance(accounts_raw, list) else []) if isinstance(item, dict)]
        persona_name = "当前人设"
        persona_names: dict[str, str] = {}
        try:
            personas_raw = await self._call(user_id, "personas.list")
            personas = [item for item in (personas_raw if isinstance(personas_raw, list) else []) if isinstance(item, dict)]
            persona_names = {
                str(item.get("id") or "").strip(): str(item.get("name") or "未命名人设").strip()
                for item in personas if str(item.get("id") or "").strip()
            }
            persona_name = persona_names.get(persona_id, persona_name)
        except Exception:
            logger.debug("Failed to load persona names for binding picker", exc_info=True)

        blocked_statuses = {"disabled", "removed", "revoked", "expired", "error", "failed"}
        current_bindings: dict[str, list[str]] = {}
        platform_names: set[str] = set()
        for account in accounts:
            platform_raw = str(account.get("platform") or "未知平台").strip()
            platform = {"threads": "Threads", "instagram": "Instagram"}.get(
                platform_raw.lower(), platform_raw,
            )
            platform_names.add(platform)
            if str(account.get("persona_id") or "").strip() != persona_id:
                continue
            username = str(account.get("username") or "未设置账号").strip().lstrip("@")
            current_bindings.setdefault(platform, []).append(f"@{username}" if username else "未设置账号")
        platform_lines = []
        for platform in sorted(platform_names):
            values = current_bindings.get(platform) or []
            platform_lines.append(f"{platform}：{'、'.join(values) if values else '未绑定'}")
        bindable = []
        for item in accounts:
            status = str(item.get("status") or "").strip().lower()
            health = str(item.get("health_status") or "").strip().lower()
            if status in blocked_statuses or health in blocked_statuses:
                continue
            if str(item.get("id") or "").strip():
                bindable.append(item)
        page_rows, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(bindable),
            callback_for_page=lambda target: callback_token(
                chat_id, "pabindpage", {"persona_id": persona_id, "page": target},
            ),
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for account in bindable[start:start + PAGE_SIZE]:
            account_id = str(account.get("id") or "").strip()
            platform_raw = str(account.get("platform") or "未知平台").strip()
            platform = {"threads": "Threads", "instagram": "Instagram"}.get(
                platform_raw.lower(), platform_raw,
            )
            username = str(account.get("username") or "未设置账号").strip().lstrip("@")
            bound_persona_id = str(account.get("persona_id") or "").strip()
            display_name = f"{platform} · @{username}" if username else platform
            account_reference = callback_token(chat_id, "ac", {
                "account_id": account_id,
                "return_callback": "tt:persona_accounts",
                "persona_filter": persona_id,
                "operation": "",
                "page": safe_page,
            })
            if bound_persona_id == persona_id:
                rows.append([types.InlineKeyboardButton(
                    text=f"✅ {display_name[:42]}（当前）",
                    callback_data=account_reference,
                )])
            elif bound_persona_id:
                rebind_reference = callback_token(chat_id, "pabind", {
                    "account_id": account_id,
                    "persona_id": persona_id,
                    "page": safe_page,
                    "bound_persona_name": persona_names.get(bound_persona_id, "其他人设"),
                })
                rows.append([types.InlineKeyboardButton(
                    text=f"🔁 {display_name[:34]}（改绑）",
                    callback_data=rebind_reference,
                )])
            else:
                bind_reference = callback_token(chat_id, "pabind", {
                    "account_id": account_id,
                    "persona_id": persona_id,
                    "page": safe_page,
                })
                rows.append([types.InlineKeyboardButton(
                    text=f"🔗 {display_name[:38]}（绑定）",
                    callback_data=bind_reference,
                )])
        rows.extend(page_rows)
        rows.append([types.InlineKeyboardButton(text="📂 查看全部平台账号", callback_data="tt:platformaccounts")])
        rows.append([types.InlineKeyboardButton(text="上一步", callback_data="tt:pmod:settings")])
        text = (
            "🔗 人设账号绑定\n\n"
            f"人设：{persona_name}\n"
            + ("\n".join(platform_lines) if platform_lines else "平台账号：未绑定")
            + f"\n可绑定账号：{len(bindable)} 个\n\n"
            "请选择要绑定的已授权账号。"
        )
        if bindable and total_pages > 1:
            text += f"\n第 {safe_page + 1}/{total_pages} 页"
        return text, types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _vecto_session_payload(self, types: Any, member: dict[str, Any]) -> tuple[str, Any]:
        """Show VECTO web-session controls separately from platform accounts."""
        username = str(member.get("web_username") or member.get("username") or "").strip()
        rows = [
            [types.InlineKeyboardButton(text="🔁 登录/切换 VECTO 账号", callback_data="tt:chatlogin")],
            [types.InlineKeyboardButton(text="🚪 退出 VECTO 账号", callback_data="tt:aclogout")],
            [types.InlineKeyboardButton(text="返回账号管理", callback_data="tt:accountmenu")],
        ]
        return (
            "VECTO 网页账号\n\n"
            f"当前账号：{username or '已绑定账号'}\n"
            "当前 Telegram 推文工作台使用的是这次绑定的 VECTO 网页会话。\n"
            "网页端退出会撤销该会话，Telegram 将立即要求重新登录；Telegram 不会独立保持一份永久登录。\n"
            "退出网页或 Telegram 会撤销该 VECTO 账号的全部活动会话（包括其他设备）。\n"
            "这里的登录/退出只管理 VECTO 账号，不会登录或退出 Threads、Instagram 等平台账号。",
            types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _account_management_payload(self, types: Any, member: dict[str, Any]) -> tuple[str, Any]:
        """Build the account-management second level without exposing secrets.

        VECTO login is the existing private-chat flow.  Platform account
        credentials/OAuth remain in the secure web/browser automation path;
        Telegram only starts those jobs and reports their task state.
        """
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        rows = [
            [types.InlineKeyboardButton(text="🔐 VECTO 网页账号（登录/退出）", callback_data="tt:vectosession")],
            [types.InlineKeyboardButton(text=f"🌐 平台授权账号（{len(accounts)}）", callback_data="tt:platformaccounts")],
            [types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")],
        ]
        return (
            "账号管理\n\n"
            f"VECTO 网页账号：{str(member.get('web_username') or member.get('username') or '已绑定').strip()}\n"
            f"平台授权账号：{len(accounts)}",
            types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _account_detail_payload(
        self,
        types: Any,
        member: dict[str, Any],
        account_id: str,
        *,
        return_callback: str = "tt:platformaccounts",
        page: int = 0,
        persona_filter: str = "",
        operation: str = "",
    ) -> tuple[str, Any]:
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        account = next((item for item in accounts if str(item.get("id") or "") == str(account_id)), None)
        if not account:
            raise HTTPException(status_code=404, detail="账号不存在或已被移除")
        chat_id = int(member.get("chat_id") or 0)
        token_payload = {
            "account_id": str(account_id),
            # UI context carried by the short-lived callback token.  These
            # fields are not forwarded to account APIs.
            "page": max(0, int(page or 0)),
            "persona_filter": str(persona_filter or ""),
            "operation": str(operation or ""),
            "return_callback": str(return_callback or "tt:platformaccounts"),
        }
        platform = str(account.get("platform") or "未知平台")
        username = str(account.get("username") or "未设置账号").lstrip("@")
        persona_id = str(account.get("persona_id") or "").strip()
        persona_name = "未绑定人设"
        if persona_id:
            try:
                personas = await self._call(int(member["web_user_id"]), "personas.list")
                persona = next((item for item in personas if str(item.get("id") or "") == persona_id), None)
                persona_name = str((persona or {}).get("name") or "已绑定人设")
            except Exception:
                persona_name = "已绑定人设"
        provider = str(account.get("auth_provider") or "browser").strip().lower()
        provider_label = "平台授权" if provider == "bundle" else "安全浏览器"
        account_action_note = (
            "点击“重新授权”会打开对应平台官方授权页；"
            if provider == "bundle"
            else "重新登录会创建安全浏览器任务；"
        )
        rows = [
            [
                types.InlineKeyboardButton(
                    text="🔎 检测登录状态",
                    callback_data=callback_token(chat_id, "accheck", token_payload),
                ),
                types.InlineKeyboardButton(
                    text="🔁 重新登录",
                    callback_data=callback_token(chat_id, "aclogin", token_payload),
                ),
            ],
        ]
        if provider == "bundle":
            # Bundle accounts are OAuth-managed.  Do not expose the browser
            # login action that the backend intentionally rejects for them.
            rows[0] = rows[0][:1]
            base = str((self.get_runtime() or {}).get("telegram_tweet_public_base_url") or "").rstrip("/")
            if base.startswith("https://") and platform.lower() in {"threads", "instagram"}:
                rows.insert(1, [types.InlineKeyboardButton(
                    text="🔁 重新授权",
                    url=(
                        f"{base}/console.html?view=accounts"
                        f"&authorize_platform={quote(platform.lower(), safe='')}"
                        f"&authorize_account_id={quote(str(account_id), safe='')}"
                    ),
                )])
        if persona_id:
            rows.append([
                types.InlineKeyboardButton(
                    text="👤 更换绑定人设",
                    callback_data=callback_token(chat_id, "acbind", token_payload),
                ),
                types.InlineKeyboardButton(
                    text="↩️ 解绑人设",
                    callback_data=callback_token(chat_id, "acunbind", token_payload),
                ),
            ])
        else:
            rows.append([types.InlineKeyboardButton(
                text="👤 绑定到人设",
                callback_data=callback_token(chat_id, "acbind", token_payload),
            )])
        rows.append([types.InlineKeyboardButton(
            text="🗑️ 移除账号",
            callback_data=callback_token(chat_id, "acremove", token_payload),
        )])
        rows.append([types.InlineKeyboardButton(
            text="返回账号列表",
            callback_data=(
                callback_token(chat_id, "accountspage", {
                    "page": max(0, int(page or 0)),
                    "persona_id": str(persona_filter or ""),
                    "operation": str(operation or ""),
                    "return_callback": str(return_callback or "tt:platformaccounts"),
                })
                if (int(page or 0) > 0 or persona_filter or operation)
                else str(return_callback or "tt:platformaccounts")
            ),
        )])
        return (
            f"账号详情\n\n平台：{platform}\n账号：@{username}\n"
            f"登录方式：{provider_label}\n状态：{account.get('status') or 'unknown'}\n"
            f"健康：{account.get('health_status') or 'unknown'}\n人设：{persona_name}\n\n"
            f"{account_action_note}解绑只改变人设对应关系，不会删除账号。",
            types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _account_persona_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        account_id: str,
        page: int = 0,
        *,
        return_page: int = 0,
        persona_filter: str = "",
        operation: str = "",
        return_callback: str = "tt:platformaccounts",
    ) -> None:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        chat_id = int(query.message.chat.id)
        page_rows, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(personas),
            callback_for_page=lambda target: callback_token(
                chat_id,
                "acbindpage",
                {
                    "account_id": str(account_id),
                    "page": target,
                    "return_page": max(0, int(return_page or 0)),
                    "persona_filter": str(persona_filter or ""),
                    "operation": str(operation or ""),
                    "return_callback": str(return_callback or "tt:platformaccounts"),
                },
            ),
        )
        rows = []
        start = page * PAGE_SIZE
        for persona in personas[start:start + PAGE_SIZE]:
            persona_id = str(persona.get("id") or "").strip()
            if not persona_id:
                continue
            token = callback_token(chat_id, "acbindselect", {
                "account_id": str(account_id),
                "persona_id": persona_id,
                "return_page": max(0, int(return_page or 0)),
                "persona_filter": str(persona_filter or ""),
                "operation": str(operation or ""),
                "return_callback": str(return_callback or "tt:platformaccounts"),
            })
            counts = persona.get("counts") if isinstance(persona.get("counts"), dict) else {}
            rows.append([types.InlineKeyboardButton(
                text=f"👤 {str(persona.get('name') or '未命名人设')[:32]} · {int(counts.get('posts') or 0)}篇",
                callback_data=token,
            )])
        rows.extend(page_rows)
        rows.append([types.InlineKeyboardButton(
            text="返回账号详情",
            callback_data=callback_token(chat_id, "ac", {
                "account_id": str(account_id),
                "operation": str(operation or ""),
                "page": max(0, int(return_page or 0)),
                "persona_id": str(persona_filter or ""),
                "return_callback": str(return_callback or "tt:platformaccounts"),
            }),
        )])
        await query.message.edit_text(
            f"平台账号绑定人设 · 第 {page + 1}/{total_pages} 步\n"
            f"请选择要绑定的人设（共 {len(personas)} 个）。\n\n"
            "同一平台同一人设只保留一个账号；确认绑定后，原有同平台账号会按后端规则解绑。"
            "此操作只建立账号与人设关系，不会修改人设内容或平台授权状态。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _task_status_payload(self, types: Any, member: dict[str, Any]) -> tuple[str, Any]:
        """Render the R18-style schedule overview before opening a list.

        The overview intentionally uses the same task projection as the list
        and detail pages, so counts and drill-downs cannot disagree about
        ownership or status.  The list is bounded to the server-supported
        Telegram projection (currently 1000 rows); the note makes that
        boundary explicit instead of presenting a truncated list as an exact
        lifetime total.
        """
        try:
            summary = await self._call(int(member["web_user_id"]), "tasks.summary", {})
        except Exception:
            # Keep older workers usable during a rolling restart; the local
            # projection below still renders a bounded, honest fallback.
            summary = {}
        tasks = await self._call(int(member["web_user_id"]), "tasks.list", {"limit": 1000})
        tasks = [item for item in tasks if isinstance(item, dict)] if isinstance(tasks, list) else []
        now = int(time.time())
        local_counts = {
            "pending": sum(1 for item in tasks if _task_is_pending(item)),
            "scheduled": sum(1 for item in tasks if _task_bucket(item, now=now) == "scheduled"),
            "immediate": sum(1 for item in tasks if _task_bucket(item, now=now) == "immediate"),
            "running": sum(1 for item in tasks if _task_bucket(item, now=now) == "running"),
            "manual": sum(1 for item in tasks if _task_bucket(item, now=now) == "manual"),
            "paused": sum(1 for item in tasks if _task_bucket(item, now=now) == "paused"),
            "failed": sum(1 for item in tasks if _task_bucket(item, now=now) == "failed"),
            "completed": sum(1 for item in tasks if _task_bucket(item, now=now) == "completed"),
            "cancelled": sum(1 for item in tasks if _task_bucket(item, now=now) == "cancelled"),
        }
        counts = summary if isinstance(summary, dict) and isinstance(summary.get("counts"), dict) else local_counts
        def count(name: str, fallback: int) -> int:
            try:
                return max(0, int(counts.get(name, fallback) or 0))
            except (TypeError, ValueError):
                return max(0, int(fallback))
        pending = [item for item in tasks if _task_is_pending(item)]
        scheduled = [item for item in pending if _task_is_scheduled(item, now=now)]
        running = [item for item in tasks if _task_bucket(item, now=now) == "running"]
        failed = [item for item in tasks if _task_bucket(item, now=now) == "failed"]
        lines = [
            "📊 排程状态",
            "",
            f"⏳ 待发布：{count('pending', len(pending))}",
            f"⏰ 定时任务：{count('scheduled', len(scheduled))}",
            f"⚡ 立即任务：{count('immediate', local_counts['immediate'])}",
            f"🔄 执行中：{count('running', len(running))}",
            f"🛠 待人工：{count('manual', local_counts['manual'])}",
            f"⏸ 已暂停：{count('paused', local_counts['paused'])}",
            f"❌ 失败：{count('failed', len(failed))}",
            f"✅ 已完成：{count('completed', local_counts['completed'])}",
            f"🚫 已取消：{count('cancelled', local_counts['cancelled'])}",
        ]
        if running:
            lines.extend(["", "正在执行："])
            for item in running[:5]:
                lines.append(f"• {_task_display_name(item)}")
            if len(running) > 5:
                lines.append(f"• 其余 {len(running) - 5} 个执行中任务略过")
        if scheduled:
            lines.extend(["", "最近定时任务："])
            for item in sorted(
                scheduled,
                key=lambda row: _task_timestamp(row.get("scheduled_at")) or 2**31,
            )[:3]:
                lines.append(
                    f"• {_task_display_name(item)} · {_task_time_text(item.get('scheduled_at'))}"
                )
        summary_total = int(summary.get("total") or 0) if isinstance(summary, dict) else 0
        lines.extend([
            "",
            f"任务总数：{summary_total or len(tasks)}",
        ])
        button = types.InlineKeyboardButton
        rows = [
            [button(text="📋 查看待发布", callback_data="tt:tasks:0:pending"), button(text="❌ 查看失败", callback_data="tt:tasks:0:failed")],
            [button(text="⏰ 仅看定时任务", callback_data="tt:tasks:0:scheduled"), button(text="⚡ 查看立即任务", callback_data="tt:tasks:0:immediate")],
            [button(text="🔄 查看执行中", callback_data="tt:tasks:0:running")],
            [button(text="🛠 待人工", callback_data="tt:tasks:0:manual"), button(text="⏸ 已暂停", callback_data="tt:tasks:0:paused")],
            [button(text="✅ 已完成", callback_data="tt:tasks:0:completed"), button(text="🚫 已取消", callback_data="tt:tasks:0:cancelled")],
            [button(text="📚 查看全部任务", callback_data="tt:tasks:0:all")],
            [button(text="🧵 按平台筛选", callback_data="tt:taskfilter:platform"), button(text="👤 按人设筛选", callback_data="tt:taskfilter:persona")],
        ]
        queue_counts = summary.get("queue_counts") if isinstance(summary, dict) and isinstance(summary.get("queue_counts"), dict) else {}
        if queue_counts:
            rows.append([
                button(text=f"🧱 普通生成（{int(queue_counts.get('normal') or 0)}）", callback_data="tt:tasks:0:all:normal"),
                button(text=f"⚙️ 自动化队列（{int(queue_counts.get('automation') or 0)}）", callback_data="tt:tasks:0:all:automation"),
            ])
            rows.append([button(text="🗓 自动化计划", callback_data="tt:automationplans:0")])
        if failed or count("failed", 0):
            rows.append([button(text="🔄 处理失败任务", callback_data="tt:tasks:0:failed")])
        rows.append([button(text="返回总控菜单", callback_data="tt:menu")])
        return "\n".join(lines), types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _stop_current_tasks(self, message: Any, types: Any, member: dict[str, Any]) -> None:
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        state = load_state(chat_id)
        stopped_input = bool(state["mode"])
        save_state(chat_id, mode="", payload={})
        failures = []
        try:
            tasks = await self._call(user_id, "tasks.list", {"limit": 1000})
        except Exception as exc:
            tasks = []
            failures.append(f"读取当前任务失败：{_error_text(exc)}")
        active = [
            item for item in tasks
            if _task_status(item) in {
                "preparing", "queued", "pending", "scheduled", "running",
                "publishing", "need_manual", "retrying",
            }
        ]
        stopped_ids = []
        for item in active:
            task_id = str(item.get("id") or "")
            if not task_id:
                continue
            try:
                result = await self._call(user_id, "tasks.cancel", {"task_id": task_id})
                result_status = str(result.get("status") or result.get("state") or "").strip().lower() if isinstance(result, dict) else ""
                if result_status and result_status not in {"cancelled", "canceled"} and not bool(result.get("cancelled")):
                    failures.append(f"{task_id[:10]}：任务当前状态为 {result_status}，未取消")
                else:
                    stopped_ids.append(task_id)
            except Exception as exc:
                failures.append(f"{task_id[:10]}：{_error_text(exc)}")
        if not stopped_ids and not stopped_input and not failures:
            text = "当前没有正在执行或等待执行的推文任务。"
        else:
            lines = ["已停止当前操作。"]
            if stopped_input:
                lines.append("未提交的输入步骤已取消。")
            if stopped_ids:
                lines.append(f"已发送取消指令：{len(stopped_ids)} 个任务。")
            if failures:
                lines.append("以下任务未能取消：\n" + "\n".join(failures[:5]))
            text = "\n".join(lines)
        audit_action(
            chat_id, user_id, "tasks.force_stop",
            status="failed" if failures else "success",
            detail=f"stopped={len(stopped_ids)}; failures={len(failures)}",
        )
        await message.answer(text, reply_markup=self._main_keyboard(types))

    async def _post_list(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        source: str,
        page: int,
        intro: str = "",
        intent: str = "",
    ) -> None:
        state = load_state(int(query.message.chat.id))
        persona_id = state["selected_persona_id"]
        if not persona_id:
            await query.answer("请先选择人设", show_alert=True)
            await self._persona_list(query, types, member, 0)
            return
        posts = await self._call(int(member["web_user_id"]), "posts.list", {"persona_id": persona_id, "source": source})
        # Clamp a stale callback before slicing.  The final navigation rows
        # are generated below with the same target/source/intent callback so
        # the page indicator cannot point back to a different list.
        _page_rows, page, _total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(posts),
            callback_for_page=lambda target: f"tt:{'favorites' if source == 'favorites' else 'drafts'}:{target}",
        )
        start = page * PAGE_SIZE
        prefix = "f" if source == "favorites" else "d"
        rows = [[types.InlineKeyboardButton(
            text=_post_label(post, start + index),
            callback_data=callback_token(
                int(query.message.chat.id), prefix,
                {
                    "persona_id": persona_id,
                    "post_id": str(post.get("id") or ""),
                    "source": source,
                    "intent": intent,
                    "page": page,
                },
            ),
        )] for index, post in enumerate(posts[start:start + PAGE_SIZE])]
        target = "imageposts" if intent == "image" else ("publishposts" if intro and source == "posts" else ("favorites" if source == "favorites" else "drafts"))
        nav, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(posts),
            callback_for_page=lambda target_page: f"tt:{target}:{target_page}",
        )
        rows.extend(nav)
        # Creating a draft belongs to the dedicated “新建推文” module.  Keep
        # it on the plain draft list only; contextual publish/image pickers
        # should not grow a second, unrelated action.
        if source == "posts" and not intro:
            rows.append([types.InlineKeyboardButton(text="➕ 手工新建草稿", callback_data="tt:draft_new")])
        # Draft/favorite/image lists are part of the content module.  Only a
        # list opened from the publish flow returns to publish management.
        module = "publish" if intro and source == "posts" and "发布" in intro else "content"
        rows.append(self._persona_module_back_row(types, int(query.message.chat.id), persona_id, module))
        list_text = (
            f"{'收藏' if source == 'favorites' else '草稿'}（{len(posts)}，第 {page + 1}/{total_pages} 页）\n"
            if posts else f"当前人设暂无{'收藏' if source == 'favorites' else '草稿'}。"
        )
        await query.message.edit_text(
            f"{intro}\n\n{list_text}" if intro else list_text,
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _render_image_options(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        persona_id: str,
        post_id: str,
        source: str = "posts",
        page: int = 0,
        notice: str = "",
    ) -> None:
        chat_id = int(query.message.chat.id)
        posts = await self._call(int(member["web_user_id"]), "posts.list", {
            "persona_id": persona_id,
            "source": "favorites" if source == "favorites" else "posts",
        })
        post = next((item for item in posts if str(item.get("id") or "") == str(post_id)), None)
        if not post:
            raise HTTPException(status_code=404, detail="推文不存在或已删除")
        state = load_state(chat_id)
        current = state["payload"] if state["mode"] in {"image_options", "image_prompt"} else {}
        current_page = max(0, int(current.get("page") or page or 0))
        payload = {
            "persona_id": persona_id,
            "post_id": post_id,
            "source": "favorites" if source == "favorites" else "posts",
            "page": current_page,
            "intent": "image",
            "image_count": min(max(int(current.get("image_count") or 1), 1), 4),
            "aspect_ratio": str(current.get("aspect_ratio") or "auto"),
            "image_mode": str(current.get("image_mode") or "auto"),
            "image_render_style": str(current.get("image_render_style") or "original"),
            "image_composition_label": str(current.get("image_composition_label") or ""),
            "image_styles": current.get("image_styles") if isinstance(current.get("image_styles"), list) else [],
            "custom_prompt": str(current.get("custom_prompt") or ""),
        }
        save_state(chat_id, selected_persona_id=persona_id, mode="image_options", payload=payload)
        rows: list[list[Any]] = []
        def option_button(label: str, field: str, value: Any) -> Any:
            next_payload = dict(payload)
            next_payload["field"] = field
            next_payload["value"] = value
            return types.InlineKeyboardButton(
                text=("✅ " if str(payload.get(field)) == str(value) else "") + label,
                callback_data=callback_token(chat_id, "imgopt", next_payload),
            )
        rows.append([option_button(f"{count}张", "image_count", count) for count in (1, 2, 3, 4)])
        rows.append([option_button(ratio, "aspect_ratio", ratio) for ratio in ("auto", "1:1", "3:4", "4:3")])
        rows.append([option_button(ratio, "aspect_ratio", ratio) for ratio in ("9:16", "16:9")])
        rows.append([option_button(label, "image_mode", value) for value, label in (
            ("auto", "自动构图"), ("person", "人物"), ("pov", "第一人称"),
            ("scene", "场景"), ("object", "事物"), ("third_person", "第三人称"),
        )])
        style_labels = {
            "original": "原有风格（默认）", "photorealistic": "写实摄影", "cinematic_realism": "电影写实",
            "editorial_fashion": "时尚杂志", "cel_shading": "赛璐璐", "japanese_anime": "日系二次元",
            "anime_painterly": "厚涂动漫", "stylized_3d": "3D 卡通", "realistic_cg": "写实 3D",
            "cinematic_cg": "影视 CG", "three_render_two": "3 渲 2", "american_cartoon": "美式卡通",
            "comic_ink": "漫画线描", "storybook": "绘本插画",
        }
        style_items = list(style_labels.items())
        for index in range(0, len(style_items), 2):
            rows.append([option_button(label, "image_render_style", value) for value, label in style_items[index:index + 2]])
        if payload["image_styles"]:
            composition_buttons = []
            for item in payload["image_styles"][:4]:
                label = str(item.get("label") if isinstance(item, dict) else item)[:24]
                kind = str(item.get("kind") or "") if isinstance(item, dict) else ""
                composition_payload = dict(payload)
                composition_payload.update({
                    "field": "image_composition_label",
                    "value": label,
                    "composition_mode": kind,
                })
                composition_buttons.append(types.InlineKeyboardButton(
                    text=("✅ " if str(payload.get("image_composition_label") or "") == label else "") + label[:18],
                    callback_data=callback_token(chat_id, "imgopt", composition_payload),
                ))
            rows.append(composition_buttons)
        rows.extend([
            [types.InlineKeyboardButton(text="🧭 生成构图方向", callback_data=callback_token(chat_id, "imgstyles", payload))],
            [types.InlineKeyboardButton(text="✍️ 补充提示词", callback_data=callback_token(chat_id, "imgprompt", payload))],
            [types.InlineKeyboardButton(text="🚀 提交配图任务", callback_data=callback_token(chat_id, "imggenerate", payload))],
            [types.InlineKeyboardButton(text="返回推文详情", callback_data=callback_token(chat_id, "d", {
                "persona_id": persona_id, "post_id": post_id, "source": source,
                "page": current_page, "intent": "image",
            }))],
        ])
        selected = (
            f"数量 {payload['image_count']} · 比例 {payload['aspect_ratio']} · 构图 {payload['image_mode']} · "
            f"风格 {style_labels.get(payload['image_render_style'], payload['image_render_style'])}"
        )
        await query.message.edit_text(
            f"{notice.strip()}\n\n" if notice.strip() else ""
            f"推文配图设置\n"
            "先选择数量、比例、构图和渲染风格。自动比例会结合正文主体、人物/静物、动作和环境综合判断；手动比例会覆盖本次自动判断。\n"
            "自动构图会根据正文选择镜头方向；人物、第一人称、场景等按钮只影响构图类型。原有风格是默认人设风格，其他风格只改变本次配图风格。\n"
            "生成构图方向和补充提示词只会追加本次配图要求，不会改写原推文；提交后任务会出现在排程状态，完成后可回到推文详情管理媒体。\n\n"
            f"正文预览：{str(post.get('content') or '')[:600]}\n\n当前：{selected}"
            + (f"\n构图方向：{payload['image_composition_label']}" if payload["image_composition_label"] else ""),
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _render_persona_image_options(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        persona_id: str,
        page: int = 0,
        notice: str = "",
    ) -> None:
        """Render the Web-equivalent persona image form and image library.

        The Web console keeps the image options, prompt, generated library and
        current reference in one persona panel.  Telegram mirrors that state
        instead of creating a second generation path, so a generated/uploaded
        image can be applied, replaced or deleted without leaving the chat.
        """
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        current = state["payload"] if state["mode"] in {
            "persona_image_options", "persona_image_prompt", "persona_image_upload",
        } else {}
        image_options = current.get("persona_image_options") if isinstance(current.get("persona_image_options"), dict) else {}
        image_options = _reconcile_persona_image_options(image_options)
        supplement_prompt = str(current.get("supplement_prompt") or "")
        result = await self._call(int(member["web_user_id"]), "persona_image.list", {"persona_id": persona_id})
        items = result.get("items") if isinstance(result, dict) and isinstance(result.get("items"), list) else []
        items = [item for item in items if isinstance(item, dict)]
        total_items = len(items)
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=total_items,
            callback_for_page=lambda target: callback_token(chat_id, "pimgpage", {
                "persona_id": persona_id, "page": target,
            }),
        )
        save_state(
            chat_id,
            selected_persona_id=persona_id,
            mode="persona_image_options",
            payload={
                "persona_id": persona_id,
                "persona_image_options": image_options,
                "supplement_prompt": supplement_prompt,
                "page": safe_page,
            },
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for item in items[start:start + PAGE_SIZE]:
            image_id = str(item.get("id") or "").strip()
            if not image_id:
                continue
            marker = "✅ " if bool(item.get("is_reference")) else ""
            created = str(item.get("created_at") or "")[:16].replace("T", " ")
            source = str(item.get("source") or "生成")
            label = f"{marker}{source} · {created or '人设图'}"[:42]
            rows.append([types.InlineKeyboardButton(
                text=label,
                callback_data=callback_token(chat_id, "pimgnoop", {"persona_id": persona_id}),
            )])
            rows.append([
                types.InlineKeyboardButton(
                    text="设为当前" if not item.get("is_reference") else "当前使用中",
                    callback_data=callback_token(chat_id, "pimgapply", {
                        "persona_id": persona_id, "image_id": image_id, "page": safe_page,
                    }),
                ),
                types.InlineKeyboardButton(
                    text="替换",
                    callback_data=callback_token(chat_id, "pimgreplace", {
                        "persona_id": persona_id, "image_id": image_id, "page": safe_page,
                    }),
                ),
                types.InlineKeyboardButton(
                    text="删除",
                    callback_data=callback_token(chat_id, "pimgdeleteconfirm", {
                        "persona_id": persona_id, "image_id": image_id, "page": safe_page,
                    }),
                ),
                types.InlineKeyboardButton(
                    text="设为头像",
                    callback_data=callback_token(chat_id, "pimgavatar", {
                        "persona_id": persona_id, "image_id": image_id, "page": safe_page,
                    }),
                ),
            ])
        rows.extend(nav)
        for field in PERSONA_IMAGE_OPTION_DEFINITIONS:
            definition = _persona_image_option_definition(field, image_options)
            if not definition:
                continue
            label, values = definition
            value = str(
                image_options.get(field)
                or ("china" if field == "digital_human_character_region" else "")
            )
            value_label = next((caption for key, caption in values if key == value), "自动")
            rows.append([types.InlineKeyboardButton(
                text=f"{label}：{value_label}",
                callback_data=callback_token(chat_id, "pimgfield", {
                    "persona_id": persona_id, "field": field, "page": safe_page,
                }),
            )])
        rows.extend([
            [types.InlineKeyboardButton(
                text="✍️ 补充提示词" if not supplement_prompt else "✍️ 修改补充提示词",
                callback_data=callback_token(chat_id, "pimgprompt", {"persona_id": persona_id, "page": safe_page}),
            )],
            [
                types.InlineKeyboardButton(text="🚀 直接生成", callback_data=callback_token(chat_id, "personaimmediate", {
                    "persona_id": persona_id,
                    "page": safe_page,
                })),
                types.InlineKeyboardButton(text="⬆️ 上传自定义图", callback_data=callback_token(chat_id, "pimgupload", {
                    "persona_id": persona_id,
                    "page": safe_page,
                })),
            ],
            self._persona_module_back_row(types, chat_id, persona_id, "settings"),
        ])
        selected_labels: list[str] = []
        for field in PERSONA_IMAGE_OPTION_DEFINITIONS:
            definition = _persona_image_option_definition(field, image_options)
            if not definition:
                continue
            _label, values = definition
            selected_labels.extend(
                caption
                for key, caption in values
                if key == str(image_options.get(field) or ("china" if field == "digital_human_character_region" else ""))
                and key
                and not (field == "digital_human_character_region" and key == "china")
            )
        selected_options = "、".join(selected_labels)
        text = (
            f"{notice.strip()}\n\n" if notice.strip() else ""
        ) + (
            f"人设图与图库\n\n图库：{total_items} 张，第 {safe_page + 1}/{total_pages} 页\n"
            "先管理历史图片，再设置生成选项；默认地区为中国。未选择的字段继续沿用人设简介。\n"
            "“直接生成”创建新的图库素材；上传自定义图可作为素材；“设为当前”会更新后续生图参考，“替换/删除”只影响选中的图片，“设为头像”只更新头像。\n"
            "补充提示词和单项选项只影响本次生成，不会覆盖人设简介或其他未定义字段。\n"
            f"当前选项：{selected_options or '全部自动（保持原有人设生成链路）'}\n"
            f"补充提示词：{supplement_prompt[:220] if supplement_prompt else '未填写'}"
        )
        await query.message.edit_text(text, reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows))

    async def _render_persona_image_field(
        self,
        query: Any,
        types: Any,
        *,
        persona_id: str,
        field: str,
        page: int = 0,
    ) -> None:
        state = load_state(int(query.message.chat.id))
        state_options = state["payload"].get("persona_image_options") if isinstance(state.get("payload"), dict) else {}
        definition = _persona_image_option_definition(field, state_options if isinstance(state_options, dict) else {})
        if not definition:
            raise HTTPException(status_code=400, detail="人设图选项无效")
        chat_id = int(query.message.chat.id)
        payload = state["payload"] if isinstance(state.get("payload"), dict) else {}
        options = payload.get("persona_image_options") if isinstance(payload.get("persona_image_options"), dict) else {}
        current = str(
            options.get(field)
            or ("china" if field == "digital_human_character_region" else "")
        )
        label, values = definition
        rows: list[list[Any]] = []
        for index in range(0, len(values), 2):
            rows.append([
                types.InlineKeyboardButton(
                    text=("✅ " if key == current else "") + caption,
                    callback_data=callback_token(chat_id, "pimgopt", {
                        "persona_id": persona_id, "field": field, "value": key, "page": page,
                    }),
                )
                for key, caption in values[index:index + 2]
            ])
        rows.append([types.InlineKeyboardButton(text="返回人设图设置", callback_data=callback_token(chat_id, "personaimage", {"persona_id": persona_id, "page": page}))])
        await query.message.edit_text(
            f"人设图设置 · {label}\n"
            f"当前：{next((caption for key, caption in values if key == current), '自动')}\n"
            "请选择一个值；选择“自动”只影响这一项，其余未定义项保持原有人设简介。\n"
            "返回后可继续设置其他字段，确认生成时才会提交本次人设图任务。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _post_detail(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        post_id: str,
        source: str,
        *,
        page: int = 0,
        intent: str = "",
        notice: str = "",
    ) -> None:
        state = load_state(int(query.message.chat.id))
        posts = await self._call(int(member["web_user_id"]), "posts.list", {"persona_id": state["selected_persona_id"], "source": source})
        post = next((item for item in posts if str(item.get("id") or "") == post_id), None)
        if not post:
            await query.answer("推文不存在或已删除", show_alert=True)
            return
        media = post.get("media_items") if isinstance(post.get("media_items"), list) else post.get("mediaPaths") or post.get("media_paths") or []
        # Keep the originating list context in every action callback.  This
        # avoids the common Telegram UX trap where editing/deleting a post
        # from page N always returns to page 1 after the operation.
        context = {
            "persona_id": state["selected_persona_id"],
            "source": source,
            "post_id": post_id,
            "page": max(0, int(page or 0)),
            "intent": str(intent or ""),
        }
        rows = [
            [types.InlineKeyboardButton(text="✏️ 编辑", callback_data=callback_token(int(query.message.chat.id), "edit", context)),
             types.InlineKeyboardButton(text="📎 添加媒体", callback_data=callback_token(int(query.message.chat.id), "media", context))],
            [types.InlineKeyboardButton(text="🖼 生成推文配图", callback_data=callback_token(int(query.message.chat.id), "image", context))],
            [types.InlineKeyboardButton(text="立即发布", callback_data=callback_token(int(query.message.chat.id), "pub", context)),
             types.InlineKeyboardButton(text="定时发布", callback_data=callback_token(int(query.message.chat.id), "sched", context))],
        ]
        if media:
            rows.append([
                types.InlineKeyboardButton(text="♻️ 替换首个媒体", callback_data=callback_token(int(query.message.chat.id), "mediareplace", {**context, "index": 0})),
                types.InlineKeyboardButton(text="移除最后媒体", callback_data=callback_token(int(query.message.chat.id), "mediadel", {**context, "index": len(media) - 1})),
            ])
        if source == "posts":
            rows.append([types.InlineKeyboardButton(text="⭐ 加入收藏", callback_data=callback_token(int(query.message.chat.id), "favadd", context))])
        rows.extend([
            [types.InlineKeyboardButton(text="🗑 删除", callback_data=callback_token(int(query.message.chat.id), "delask", context))],
            [types.InlineKeyboardButton(
                text="返回列表",
                callback_data=(
                    "tt:imageposts:" + str(context["page"])
                    if context["intent"] == "image"
                    else (
                        "tt:publishposts:" + str(context["page"])
                        if context["intent"] == "publish"
                        else f"tt:{'favorites' if source == 'favorites' else 'drafts'}:{context['page']}"
                    )
                ),
            )],
        ])
        content = str(post.get("content") or "").strip()
        prefix = f"{notice.strip()}\n\n" if notice.strip() else ""
        await query.message.edit_text(
            f"{prefix}{str(post.get('title') or '推文')[:100]}\n\n{content[:3000]}\n\n"
            f"媒体：{len(media)} 项\n\n"
            "请选择下一步：编辑正文、管理媒体、生成配图，或选择账号后立即/定时发布。\n"
            "删除会先进入确认步骤；返回列表会保留当前分页和来源。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _publish_account_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        source: str,
        post_id: str,
        scheduled: bool,
        page: int = 0,
        intent: str = "",
    ) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        eligible = [
            account for account in accounts
            if str(account.get("persona_id") or "") == state["selected_persona_id"]
            and str(account.get("platform") or "").lower() in {"threads", "instagram"}
        ]
        if not eligible:
            raise HTTPException(status_code=409, detail="当前人设没有绑定 Threads 或 Instagram 账号，请先在网页端完成账号授权")
        page_rows, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(eligible),
            callback_for_page=lambda target: callback_token(
                chat_id,
                "papage",
                {
                    "persona_id": state["selected_persona_id"],
                    "source": source,
                    "post_id": post_id,
                    "scheduled": bool(scheduled),
                    "page": target,
                    "intent": str(intent or ""),
                },
            ),
        )
        rows = []
        start = page * PAGE_SIZE
        for account in eligible[start:start + PAGE_SIZE]:
            account_id = str(account.get("id") or "")
            label = str(account.get("display_name") or account.get("username") or account_id)[:32]
            platform = str(account.get("platform") or "threads").strip().lower()
            rows.append([types.InlineKeyboardButton(
                text=f"{platform.title()} · {label}"[:40],
                callback_data=callback_token(chat_id, "pa", {
                    "persona_id": state["selected_persona_id"],
                    "source": source,
                    "post_id": post_id,
                    "account_id": account_id,
                    "platform": platform,
                    "scheduled": bool(scheduled),
                    "page": page,
                    "intent": str(intent or ""),
                }),
            )])
        rows.extend(page_rows)
        rows.append([types.InlineKeyboardButton(
            text="取消",
            callback_data=(
                "tt:imageposts:" + str(page)
                if intent == "image"
                else (
                    "tt:publishposts:" + str(page)
                    if intent == "publish"
                    else f"tt:{'favorites' if source == 'favorites' else 'drafts'}:{page}"
                )
            ),
        )])
        await query.message.edit_text(
            f"{'定时' if scheduled else '立即'}发布 · 选择账号\n"
            f"当前人设已绑定 {len(eligible)} 个可用账号，第 {page + 1}/{total_pages} 页。\n"
            "账号选择后还会展示平台、正文和时间的最终确认；提交时后端会再次校验平台授权状态。没有账号请先完成平台授权和人设绑定。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _tasks(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        page: int,
        status_filter: str = "all",
        platform_filter: str = "",
        persona_filter: str = "",
        queue: str = "all",
    ) -> None:
        queue = str(queue or "all").strip().lower()
        if queue not in {"all", "normal", "automation"}:
            queue = "all"
        tasks = await self._call(int(member["web_user_id"]), "tasks.list", {"limit": 1000, "queue": queue})
        tasks = [item for item in tasks if isinstance(item, dict)] if isinstance(tasks, list) else []
        now = int(time.time())
        if status_filter == "active":
            tasks = [
                item for item in tasks
                if _task_is_pending(item) or _task_bucket(item, now=now) == "running"
            ]
        elif status_filter == "pending":
            tasks = [item for item in tasks if _task_is_pending(item)]
        elif status_filter == "failed":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "failed"]
        elif status_filter == "scheduled":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "scheduled"]
        elif status_filter == "immediate":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "immediate"]
        elif status_filter == "running":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "running"]
        elif status_filter == "manual":
            # R18 distinguishes a task waiting for human intervention from
            # one explicitly paused.  Keep the two filters mutually
            # exclusive so the overview counts and drill-down lists agree.
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "manual"]
        elif status_filter == "paused":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "paused"]
        elif status_filter == "completed":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "completed"]
        elif status_filter == "cancelled":
            tasks = [item for item in tasks if _task_bucket(item, now=now) == "cancelled"]
        else:
            status_filter = "all"
        platform_filter = str(platform_filter or "").strip().lower()
        persona_filter = str(persona_filter or "").strip()
        if platform_filter:
            tasks = [
                item for item in tasks
                if str(item.get("platform") or "").strip().lower() == platform_filter
            ]
        if persona_filter:
            tasks = [item for item in tasks if str(item.get("persona_id") or "").strip() == persona_filter]
        page = max(0, int(page))
        total_pages = max(1, (len(tasks) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, total_pages - 1)
        start = page * PAGE_SIZE
        rows = []
        for item in tasks[start:start + PAGE_SIZE]:
            task_id = str(item.get("id") or "")
            task_kind = str(item.get("_tg_task_kind") or "social")
            label = _task_list_label(item, now=now)
            rows.append([types.InlineKeyboardButton(
                text=label[:56],
                callback_data=callback_token(
                    int(query.message.chat.id), "t", {
                        "task_id": task_id,
                        "task_kind": task_kind,
                        "page": page,
                        "status_filter": status_filter,
                        "platform": platform_filter,
                        "persona_id": persona_filter,
                        "queue": queue,
                    },
                ),
            )])
        def _task_page_callback(target_page: int) -> str:
            payload = {
                "page": target_page,
                "status_filter": status_filter,
                "platform": platform_filter,
                "persona_id": persona_filter,
                "queue": queue,
            }
            return callback_token(int(query.message.chat.id), "taskview", payload)

        nav, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(tasks),
            callback_for_page=_task_page_callback,
        )
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(text="返回排程状态", callback_data="tt:taskmenu")])
        filter_label = {
            "active": "进行中",
            "pending": "待发布",
            "failed": "失败",
            "scheduled": "定时",
            "immediate": "立即",
            "running": "执行中",
            "manual": "待人工",
            "paused": "已暂停",
            "completed": "已完成",
            "cancelled": "已取消",
            "all": "全部",
        }[status_filter]
        filter_suffix = ""
        if queue != "all":
            filter_suffix += f" · {'普通生成' if queue == 'normal' else '自动化'}"
        if platform_filter:
            filter_suffix += f" · 平台 {platform_filter}"
        if persona_filter:
            filter_suffix += f" · 人设 {persona_filter[:18]}"
        await query.message.edit_text(
            (f"{filter_label}任务{filter_suffix}（{len(tasks)} 条）\n第 {page + 1}/{total_pages} 页\n"
             if tasks else f"暂无{filter_label}任务{filter_suffix}。\n"
             ),
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _task_filter_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        filter_kind: str,
        page: int = 0,
    ) -> None:
        chat_id = int(query.message.chat.id)
        user_id = int(member["web_user_id"])
        rows = []
        if filter_kind == "platform":
            tasks = await self._call(user_id, "tasks.list", {"limit": 1000})
            platforms = sorted({
                str(item.get("platform") or "").strip().lower()
                for item in (tasks if isinstance(tasks, list) else [])
                if isinstance(item, dict) and str(item.get("platform") or "").strip()
            })
            nav, page, total_pages = _pagination_rows(
                types,
                page=page,
                total_items=len(platforms),
                callback_for_page=lambda target: callback_token(chat_id, "taskfilterpage", {"kind": "platform", "page": target}),
            )
            start = page * PAGE_SIZE
            for platform in platforms[start:start + PAGE_SIZE]:
                rows.append([types.InlineKeyboardButton(
                    text=platform.title(),
                    callback_data=callback_token(chat_id, "taskview", {
                        "page": 0, "status_filter": "all", "platform": platform,
                    }),
                )])
            title = "按平台筛选任务"
            empty = "当前任务中暂无可筛选的平台。"
        else:
            tasks = await self._call(user_id, "tasks.list", {"limit": 1000})
            task_persona_ids = {
                str(item.get("persona_id") or "").strip()
                for item in (tasks if isinstance(tasks, list) else [])
                if isinstance(item, dict) and str(item.get("persona_id") or "").strip()
            }
            personas = await self._call(user_id, "personas.list")
            personas = [
                item for item in (personas if isinstance(personas, list) else [])
                if isinstance(item, dict) and str(item.get("id") or "").strip() in task_persona_ids
            ]
            nav, page, total_pages = _pagination_rows(
                types,
                page=page,
                total_items=len(personas),
                callback_for_page=lambda target: callback_token(chat_id, "taskfilterpage", {"kind": "persona", "page": target}),
            )
            start = page * PAGE_SIZE
            for persona in personas[start:start + PAGE_SIZE]:
                persona_id = str(persona.get("id") or "").strip()
                if not persona_id:
                    continue
                rows.append([types.InlineKeyboardButton(
                    text=f"👤 {str(persona.get('name') or '未命名人设')[:32]}",
                    callback_data=callback_token(chat_id, "taskview", {
                        "page": 0, "status_filter": "all", "persona_id": persona_id,
                    }),
                )])
            title = "按人设筛选任务"
            empty = "当前没有可筛选的人设。"
        rows.extend(nav)
        if not rows:
            text = empty
        else:
            text = title + f"\n第 {page + 1}/{total_pages} 页"
        rows.append([types.InlineKeyboardButton(text="返回排程状态", callback_data="tt:taskmenu")])
        await query.message.edit_text(
            text,
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _matrix_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        page: int = 0,
    ) -> None:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        eligible = [
            item for item in personas
            if int((item.get("counts") or {}).get("posts") or 0) > 0
            or int((item.get("counts") or {}).get("favorites") or 0) > 0
        ]
        if not eligible:
            raise HTTPException(status_code=409, detail="没有可用于矩阵发布的草稿或收藏")
        state = load_state(int(query.message.chat.id))
        selected = {
            str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)
        }
        page = max(0, int(page))
        total_pages = max(1, (len(eligible) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, total_pages - 1)
        state_payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
        state_payload["matrix_page"] = page
        if state["mode"] == "matrix_select" and state_payload != state["payload"]:
            save_state(chat_id=int(query.message.chat.id), mode="matrix_select", payload=state_payload)
        state = load_state(int(query.message.chat.id))
        selected = {
            str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)
        }
        start = page * PAGE_SIZE
        rows = []
        for persona in eligible[start:start + PAGE_SIZE]:
            persona_id = str(persona.get("id") or "")
            marker = "✅" if persona_id in selected else "⬜"
            rows.append([types.InlineKeyboardButton(
                text=f"{marker} {str(persona.get('name') or '未命名人设')[:28]}",
                callback_data=callback_token(
                    int(query.message.chat.id), "mx", {"persona_id": persona_id, "page": page},
                ),
            )])
        nav, page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(eligible),
            callback_for_page=lambda target: f"tt:matrixpage:{target}",
        )
        rows.extend(nav)
        if selected:
            rows.append([types.InlineKeyboardButton(
                text=f"下一步：确认 {len(selected)} 个人设",
                callback_data="tt:matrixnext",
            )])
        rows.append([types.InlineKeyboardButton(text="取消", callback_data="tt:personas:0")])
        await query.message.edit_text(
            "矩阵发布 · 第 1/4 步\n"
            "请选择要发布的人设；可多选，后续再选择内容来源和发布平台。\n"
            "只有拥有草稿或收藏的人设会显示；勾选不会立即提交。\n"
            f"已选择：{len(selected)} 个；第 {page + 1}/{total_pages} 页，共 {len(eligible)} 个人设",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _matrix_source_picker(self, query: Any, types: Any) -> None:
        state = load_state(int(query.message.chat.id))
        persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
        if not persona_ids:
            raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
        rows = [[
            types.InlineKeyboardButton(text="📝 草稿", callback_data="tt:mxsource:posts"),
            types.InlineKeyboardButton(text="⭐ 收藏", callback_data="tt:mxsource:favorites"),
        ], [types.InlineKeyboardButton(text="上一步", callback_data="tt:matrixback")]]
        await query.message.edit_text(
            "矩阵发布 · 第 2/4 步\n"
            f"已选择 {len(persona_ids)} 个人设，请选择每个人设要取用的内容来源。\n"
            "草稿是待发布内容；收藏是已保存的参考内容。系统会在下一步检查每个人设是否有可用条目。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _matrix_platform_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
    ) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        persona_ids = {str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)}
        source = str(state["payload"].get("matrix_source") or "")
        if not persona_ids or source not in {"posts", "favorites"}:
            raise HTTPException(status_code=409, detail="矩阵来源选择已失效，请重新开始")
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        platforms = {
            str(item.get("platform") or "").strip().lower()
            for item in accounts
            if str(item.get("persona_id") or "") in persona_ids
            and str(item.get("platform") or "").strip().lower() in {"threads", "instagram"}
        }
        rows = []
        if "threads" in platforms:
            rows.append([types.InlineKeyboardButton(text="Threads", callback_data="tt:mxplatform:threads")])
        if "instagram" in platforms:
            rows.append([types.InlineKeyboardButton(text="Instagram", callback_data="tt:mxplatform:instagram")])
        rows.append([types.InlineKeyboardButton(text="上一步", callback_data="tt:mxbacksource")])
        source_ready_count = int(state["payload"].get("matrix_source_ready_count") or len(persona_ids))
        source_skipped_count = max(0, len(persona_ids) - source_ready_count)
        source_note = (
            f"\n其中 {source_ready_count} 个人设有该来源内容，{source_skipped_count} 个将在提交时跳过。"
            if source_skipped_count
            else f"\n{source_ready_count} 个人设均有该来源内容。"
        )
        message = (
            f"矩阵发布 · 第 3/4 步\n请选择已授权的平台；提交时会按每个人设的绑定账号执行。{source_note}"
            if platforms
            else "矩阵发布 · 第 3/4 步\n所选人设尚未绑定 Threads 或 Instagram 账号，请先完成账号授权，再返回此步骤。"
        )
        await query.message.edit_text(
            message,
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _render_generation_directions(self, query: Any, types: Any, *, notice: str = "") -> None:
        """Render Web-compatible direction selection without bypassing confirmation."""
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        if state["mode"] not in {"generate_confirm", "generate_directions"}:
            raise HTTPException(status_code=409, detail="生成步骤已失效，请重新开始")
        payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
        directions = [
            str(item or "").strip()[:24]
            for item in (payload.get("direction_options") or [])
            if str(item or "").strip()
        ][:10]
        selected = {
            str(item or "").strip()
            for item in (payload.get("selected_directions") or [])
            if str(item or "").strip()
        }
        rows: list[list[Any]] = []
        for direction in directions:
            rows.append([types.InlineKeyboardButton(
                text=("✅ " if direction in selected else "▫️ ") + direction,
                callback_data=callback_token(chat_id, "gdirpick", {"direction": direction}),
            )])
        rows.append([
            types.InlineKeyboardButton(
                text=f"确认使用（{len(selected)}）",
                callback_data=callback_token(chat_id, "gdirconfirm", {}),
            ),
            types.InlineKeyboardButton(
                text="不使用方向",
                callback_data=callback_token(chat_id, "gdirclear", {}),
            ),
        ])
        rows.append([
            types.InlineKeyboardButton(text="换一批", callback_data=callback_token(chat_id, "gdir", {"refresh": True})),
            types.InlineKeyboardButton(text="返回确认", callback_data=callback_token(chat_id, "gdirback", {})),
        ])
        rows.append([types.InlineKeyboardButton(text="取消", callback_data="tt:menu")])
        await query.message.edit_text(
            (f"{notice.strip()}\n\n" if notice.strip() else "")
            + "AI 生成推文 · 选择推文方向\n"
            + "方向只作为生成链路的辅助约束；可多选，也可以明确不使用。\n"
            + f"当前已选：{len(selected)} 个。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    @staticmethod
    def _generation_confirmation_text(payload: dict[str, Any], *, notice: str = "") -> str:
        """Build the single confirmation view shared by all generation branches.

        Keeping this in one renderer is important: direction/memory pickers
        must return to the same state instead of silently dropping one of the
        selected context sources.
        """
        count = int(payload.get("count") or 3)
        target_words = int(payload.get("target_words") or 120)
        prompt = str(payload.get("prompt") or "")[:1200]
        platform = str(payload.get("platform") or "threads").strip().lower() or "threads"
        platform_label = dict(PERSONA_CONTENT_PLATFORMS).get(platform, platform.title())
        locale = str(payload.get("writing_locale") or "zh-TW").strip()
        locale_label = dict(PERSONA_WRITING_LOCALES).get(locale, locale)
        slot = str(payload.get("content_time_slot") or "").strip().lower()
        slot_label = dict(PERSONA_CONTENT_TIME_SLOTS).get(slot, "不指定")
        directions = [
            str(item or "").strip()
            for item in (payload.get("selected_directions") or [])
            if str(item or "").strip()
        ][:10]
        memories = [
            str(item or "").strip()
            for item in (payload.get("selected_memory_summaries") or [])
            if str(item or "").strip()
        ][:20]
        prefix = f"{notice.strip()}\n\n" if notice.strip() else ""
        return (
            prefix
            + "AI 生成推文 · 提交确认\n"
            + f"数量：{count} 篇 · 每篇约 {target_words} 字\n"
            + f"平台：{platform_label} · 语言：{locale_label} · 时段：{slot_label}\n"
            + f"主题：{prompt}\n"
            + f"方向：{', '.join(directions) or '未使用'}\n"
            + f"人设记忆：{', '.join(memories)[:900] or '未选择'}\n\n"
            + "下方按钮可逐项修改平台、语言、时段、方向和记忆；确认后才会提交生成任务，完成后草稿会回到推文内容列表。"
        )

    @staticmethod
    def _generation_confirmation_markup(types: Any, chat_id: int, payload: dict[str, Any]) -> Any:
        selected_directions = [
            str(item or "").strip()
            for item in (payload.get("selected_directions") or [])
            if str(item or "").strip()
        ]
        selected_memories = [
            str(item or "").strip()
            for item in (payload.get("selected_memory_ids") or [])
            if str(item or "").strip()
        ]
        rows = [[
            types.InlineKeyboardButton(
                text="确认生成",
                callback_data=callback_token(chat_id, "gsubmit", {}),
            ),
            types.InlineKeyboardButton(text="修改参数", callback_data="tt:generate"),
        ], [
            types.InlineKeyboardButton(
                text=f"🌐 平台：{dict(PERSONA_CONTENT_PLATFORMS).get(str(payload.get('platform') or 'threads').strip().lower(), 'Threads')}",
                callback_data=callback_token(chat_id, "gplatform", {}),
            ),
            types.InlineKeyboardButton(
                text=f"🗣 语言：{dict(PERSONA_WRITING_LOCALES).get(str(payload.get('writing_locale') or 'zh-TW').strip(), str(payload.get('writing_locale') or 'zh-TW'))}",
                callback_data=callback_token(chat_id, "glocale", {}),
            ),
        ], [
            types.InlineKeyboardButton(
                text=f"⏱ 时段：{dict(PERSONA_CONTENT_TIME_SLOTS).get(str(payload.get('content_time_slot') or '').strip().lower(), '不指定')}",
                callback_data=callback_token(chat_id, "gslot", {}),
            ),
        ], [
            types.InlineKeyboardButton(
                text=f"🧭 选择推文方向 ({len(selected_directions)})",
                callback_data=callback_token(chat_id, "gdir", {}),
            ),
        ], [
            types.InlineKeyboardButton(
                text=f"🧠 选择人设记忆 ({len(selected_memories)})",
                callback_data=callback_token(chat_id, "gmem", {"page": 0}),
            ),
        ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]]
        return types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _render_generation_confirmation(
        self,
        query: Any,
        types: Any,
        *,
        payload: dict[str, Any],
        notice: str = "",
    ) -> None:
        await query.message.edit_text(
            self._generation_confirmation_text(payload, notice=notice),
            reply_markup=self._generation_confirmation_markup(
                types, int(query.message.chat.id), payload,
            ),
        )

    async def _render_generation_memories(
        self,
        query: Any,
        types: Any,
        *,
        page: int = 0,
        notice: str = "",
    ) -> None:
        """Render selectable persona memories for the pending generation.

        The options are fetched from the canonical profile-memory endpoint on
        every render so deleted memories cannot be submitted from a stale
        Telegram callback.  Only the selected IDs and their current summaries
        are persisted in the short-lived chat state.
        """
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        if state["mode"] not in {"generate_confirm", "generate_memories"}:
            raise HTTPException(status_code=409, detail="生成确认已失效，请重新开始")
        persona_id = str(state["selected_persona_id"] or "").strip()
        if not persona_id:
            raise HTTPException(status_code=409, detail="请先选择人设")
        member = self._member(chat_id)
        if not member:
            raise HTTPException(status_code=401, detail="Telegram 会话未绑定")
        result = await self._call(
            int(member["web_user_id"]),
            "profile.memories",
            {"persona_id": persona_id},
        )
        memories = result.get("memories") if isinstance(result, dict) else []
        memories = [item for item in memories if isinstance(item, dict) and str(item.get("id") or "").strip()]
        payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
        available = {str(item.get("id") or "").strip(): item for item in memories}
        selected_ids = [
            str(item or "").strip()
            for item in (payload.get("selected_memory_ids") or [])
            if str(item or "").strip() in available
        ][:8]
        selected_summaries = [
            str(available[memory_id].get("summary") or "").strip()
            for memory_id in selected_ids
            if str(available[memory_id].get("summary") or "").strip()
        ]
        payload["selected_memory_ids"] = selected_ids
        payload["selected_memory_summaries"] = selected_summaries
        save_state(chat_id, mode="generate_memories", payload=payload)
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(memories),
            callback_for_page=lambda target: callback_token(chat_id, "gmem", {"page": target}),
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for item in memories[start:start + PAGE_SIZE]:
            memory_id = str(item.get("id") or "").strip()
            summary = str(item.get("summary") or "").strip().replace("\n", " ")[:58]
            marker = "✅ " if memory_id in selected_ids else "▫️ "
            rows.append([types.InlineKeyboardButton(
                text=f"{marker}{summary or '未命名记忆'}",
                callback_data=callback_token(chat_id, "gmempick", {
                    "memory_id": memory_id,
                    "page": safe_page,
                }),
            )])
        rows.append([
            types.InlineKeyboardButton(
                text=f"确认使用（{len(selected_ids)}）",
                callback_data=callback_token(chat_id, "gmemconfirm", {}),
            ),
            types.InlineKeyboardButton(
                text="清空选择",
                callback_data=callback_token(chat_id, "gmemclear", {}),
            ),
        ])
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(
            text="返回生成确认",
            callback_data=callback_token(chat_id, "gmemback", {}),
        )])
        await query.message.edit_text(
            (f"{notice.strip()}\n\n" if notice.strip() else "")
            + "AI 生成推文 · 选择人设记忆\n"
            + f"第 {safe_page + 1}/{total_pages} 页；最多选择 8 条。\n"
            + ("记忆会作为本次生成的上下文，不会覆盖人设简介。" if memories else "当前人设暂无可选记忆，可返回确认页继续生成。"),
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _render_profile_memories(self, query: Any, types: Any, *, page: int = 0) -> None:
        chat_id = int(query.message.chat.id)
        member = self._member(chat_id)
        if not member:
            raise HTTPException(status_code=401, detail="Telegram 会话未绑定")
        state = load_state(chat_id)
        persona_id = str(state["selected_persona_id"] or "").strip()
        if not persona_id:
            raise HTTPException(status_code=409, detail="请先选择人设")
        result = await self._call(int(member["web_user_id"]), "profile.memories", {"persona_id": persona_id})
        memories = result.get("memories") if isinstance(result, dict) and isinstance(result.get("memories"), list) else []
        memories = [item for item in memories if isinstance(item, dict)]
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(memories),
            callback_for_page=lambda target: callback_token(chat_id, "pmemories", {"page": target}),
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for item in memories[start:start + PAGE_SIZE]:
            memory_id = str(item.get("id") or "").strip()
            summary = str(item.get("summary") or "").strip().replace("\n", " ")[:48]
            if not memory_id:
                continue
            rows.append([types.InlineKeyboardButton(
                text=f"🧠 {summary or '未命名记忆'}",
                callback_data=callback_token(chat_id, "pmemnoop", {}),
            ), types.InlineKeyboardButton(
                text="删除",
                callback_data=callback_token(chat_id, "pmemdelete", {"memory_id": memory_id, "page": safe_page}),
            )])
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(
            text="➕ 新增记忆",
            callback_data=callback_token(chat_id, "pmemadd", {"page": safe_page}),
        )])
        rows.append([types.InlineKeyboardButton(text="返回基础资料", callback_data="tt:profile")])
        await query.message.edit_text(
            f"人设记忆（{len(memories)} 条）\n第 {safe_page + 1}/{total_pages}\n"
            "生成推文时可将选中的记忆作为上下文，删除只会隐藏该条记忆。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _render_profile_links(self, query: Any, types: Any, *, page: int = 0) -> None:
        chat_id = int(query.message.chat.id)
        member = self._member(chat_id)
        if not member:
            raise HTTPException(status_code=401, detail="Telegram 会话未绑定")
        state = load_state(chat_id)
        persona_id = str(state["selected_persona_id"] or "").strip()
        if not persona_id:
            raise HTTPException(status_code=409, detail="请先选择人设")
        profile = await self._call(int(member["web_user_id"]), "profile.get", {"persona_id": persona_id})
        presets = profile.get("link_presets") if isinstance(profile, dict) and isinstance(profile.get("link_presets"), list) else []
        active_id = str(profile.get("active_link_preset_id") or "")
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(presets),
            callback_for_page=lambda target: callback_token(chat_id, "plinks", {"page": target}),
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for item in presets[start:start + PAGE_SIZE]:
            if not isinstance(item, dict):
                continue
            preset_id = str(item.get("id") or "").strip()
            if not preset_id:
                continue
            marker = "✅ " if preset_id == active_id else ""
            rows.append([types.InlineKeyboardButton(
                text=f"{marker}{str(item.get('name') or '链接模板')[:26]}",
                callback_data=callback_token(chat_id, "plinkactivate", {"preset_id": preset_id, "page": safe_page}),
            ), types.InlineKeyboardButton(
                text="删除",
                callback_data=callback_token(chat_id, "plinkdelete", {"preset_id": preset_id, "page": safe_page}),
            )])
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(
            text="➕ 新增链接模板",
            callback_data=callback_token(chat_id, "plinkadd", {"page": safe_page}),
        )])
        rows.append([types.InlineKeyboardButton(text="返回基础资料", callback_data="tt:profile")])
        await query.message.edit_text(
            f"链接模板（{len(presets)} 条，第 {safe_page + 1}/{total_pages} 页）\n\n"
            + ("\n".join(
                f"• {str(item.get('name') or '链接模板')}：{str(item.get('link_url') or '')[:90]}"
                for item in presets[start:start + PAGE_SIZE] if isinstance(item, dict)
            ) or "暂无链接模板。"),
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _render_automation_plans(self, query: Any, types: Any, *, page: int = 0) -> None:
        chat_id = int(query.message.chat.id)
        member = self._member(chat_id)
        if not member:
            raise HTTPException(status_code=401, detail="Telegram 会话未绑定")
        result = await self._call(int(member["web_user_id"]), "automation.plans.list", {})
        plans = result.get("plans") if isinstance(result, dict) and isinstance(result.get("plans"), list) else []
        plans = [item for item in plans if isinstance(item, dict)]
        nav, safe_page, total_pages = _pagination_rows(
            types,
            page=page,
            total_items=len(plans),
            callback_for_page=lambda target: f"tt:automationplans:{target}",
        )
        rows: list[list[Any]] = []
        start = safe_page * PAGE_SIZE
        for plan in plans[start:start + PAGE_SIZE]:
            plan_id = str(plan.get("id") or "").strip()
            if not plan_id:
                continue
            status = str(plan.get("status") or "unknown").strip()
            platform = str(plan.get("platform") or "").strip()
            rows.append([types.InlineKeyboardButton(
                text=f"{status} · {platform or '平台'} · {int(plan.get('task_count') or 0)}步",
                callback_data=callback_token(chat_id, "automationplan", {
                    "plan_id": plan_id,
                    "page": safe_page,
                }),
            )])
        rows.extend(nav)
        rows.append([types.InlineKeyboardButton(
            text="➕ 新建自动化计划",
            callback_data=callback_token(chat_id, "automationplannew", {"page": safe_page}),
        )])
        rows.append([types.InlineKeyboardButton(text="返回排程状态", callback_data="tt:taskmenu")])
        await query.message.edit_text(
            f"自动化计划（{len(plans)} 条）\n第 {safe_page + 1}/{total_pages}\n"
            "计划会按平台账号和人设绑定执行；停止计划不会删除账号。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    @staticmethod
    def _persona_ai_keyword_values(value: Any, *, limit: int = 12) -> list[str]:
        """Normalize model keyword candidates before putting them in chat state.

        The Web flow displays at most twelve candidates per group and keeps the
        regular/hot groups separate.  Telegram callbacks only carry an index;
        the authoritative values therefore stay in the short-lived state and
        are revalidated on every click.
        """
        values: list[str] = []
        for item in value if isinstance(value, list) else []:
            text = str(item or "").strip()
            if text and text not in values:
                values.append(text[:80])
            if len(values) >= max(1, int(limit or 12)):
                break
        return values

    @classmethod
    def _persona_ai_keywords_markup(cls, types: Any, chat_id: int, payload: dict[str, Any]) -> Any:
        regular = cls._persona_ai_keyword_values(payload.get("ai_keywords"))
        hot = cls._persona_ai_keyword_values(payload.get("ai_hot_keywords"))
        selected_regular = cls._persona_ai_keyword_values(payload.get("ai_selected_regular_keywords"), limit=2)
        selected_hot = cls._persona_ai_keyword_values(payload.get("ai_selected_hot_keywords"), limit=2)
        selected = set(selected_regular) | set(selected_hot)
        rows: list[list[Any]] = []
        for kind, title, values, chosen in (
            ("regular", "普通关键词（长期方向）", regular, set(selected_regular)),
            ("hot", "热门关键词（可选热点方向）", hot, set(selected_hot)),
        ):
            if not values:
                continue
            rows.append([types.InlineKeyboardButton(text=title, callback_data="tt:persona_ai_noop")])
            for index in range(0, len(values), 2):
                row = []
                for offset in (0, 1):
                    candidate_index = index + offset
                    if candidate_index >= len(values):
                        continue
                    keyword = values[candidate_index]
                    row.append(types.InlineKeyboardButton(
                        text=("✅ " if keyword in chosen else "▫️ ") + keyword[:32],
                        callback_data=callback_token(chat_id, "persona_ai_keyword", {
                            "kind": kind,
                            "index": candidate_index,
                        }),
                    ))
                if row:
                    rows.append(row)
        rows.append([
            types.InlineKeyboardButton(
                text=f"确认生成人设（{len(selected)}）",
                callback_data=callback_token(chat_id, "persona_ai_confirm", {}),
            ),
            types.InlineKeyboardButton(
                text="清空选择",
                callback_data=callback_token(chat_id, "persona_ai_clear", {}),
            ),
        ])
        rows.append([
            types.InlineKeyboardButton(
                text="返回修改提示词",
                callback_data=callback_token(chat_id, "persona_ai_back", {}),
            ),
            types.InlineKeyboardButton(
                text="跳过关键词直接创建",
                callback_data=callback_token(chat_id, "persona_ai_direct", {}),
            ),
        ])
        rows.append([types.InlineKeyboardButton(text="取消", callback_data="tt:menu")])
        return types.InlineKeyboardMarkup(inline_keyboard=rows)

    @classmethod
    def _persona_ai_keywords_text(cls, payload: dict[str, Any], *, notice: str = "") -> str:
        regular = cls._persona_ai_keyword_values(payload.get("ai_keywords"))
        hot = cls._persona_ai_keyword_values(payload.get("ai_hot_keywords"))
        selected_regular = cls._persona_ai_keyword_values(payload.get("ai_selected_regular_keywords"), limit=2)
        selected_hot = cls._persona_ai_keyword_values(payload.get("ai_selected_hot_keywords"), limit=2)
        source = payload.get("ai_hot_keyword_source") if isinstance(payload.get("ai_hot_keyword_source"), dict) else {}
        if source.get("available"):
            source_text = f"热门候选参考 {int(source.get('candidate_count') or 0)} 条公开趋势内容。"
        elif source.get("fallback") == "persona_model":
            source_text = "未取得可核验实时热度，热门候选由模型按人设生成。"
        else:
            source_text = "热门候选为模型按人设生成的可选方向。"
        prefix = f"{notice.strip()}\n\n" if notice.strip() else ""
        return (
            prefix
            + "AI 生成人设 · 选择关键词\n"
            + f"名称：{str(payload.get('ai_name') or '')[:160]}\n"
            + f"提示词：{str(payload.get('ai_prompt') or '')[:800]}\n\n"
            + f"普通候选 {len(regular)} 个，热门候选 {len(hot)} 个。每列最多选 2 个，至少选 2 个；共最多 4 个。\n"
            + f"当前已选：普通 {len(selected_regular)} / 2，热门 {len(selected_hot)} / 2。\n"
            + source_text
        )

    async def _finish_persona_ai_create(
        self,
        *,
        user_id: int,
        chat_id: int,
        types: Any,
        name: str,
        prompt: str,
        selected_keywords: list[str],
        selected_regular_keywords: list[str],
        selected_hot_keywords: list[str],
        idempotency_key: str,
        reply: Callable[..., Awaitable[Any]],
    ) -> str:
        """Submit AI persona creation and render the same success surface.

        Both the direct-create fallback and the keyword-confirm path use this
        method, so they cannot drift in billing, idempotency, state cleanup or
        the follow-up persona actions.
        """
        result = await self._call(user_id, "personas.ai_create", {
            "name": name[:160],
            "prompt": prompt[:2000],
            "selected_keywords": list(selected_keywords)[:4],
            "selected_regular_keywords": list(selected_regular_keywords)[:2],
            "selected_hot_keywords": list(selected_hot_keywords)[:2],
            "idempotency_key": str(idempotency_key or "")[:240],
        })
        profile = result.get("profile") if isinstance(result, dict) and isinstance(result.get("profile"), dict) else {}
        new_id = str(profile.get("id") or (result.get("id") if isinstance(result, dict) else "") or "")
        if not new_id:
            raise HTTPException(status_code=502, detail="AI 未返回新建人设标识")
        created_name = str(profile.get("name") or (result.get("name") if isinstance(result, dict) else "") or name)
        clear_pending_state(chat_id)
        save_state(chat_id, selected_persona_id=new_id, payload={})
        audit_action(
            chat_id,
            user_id,
            "persona.ai_create",
            status="success",
            resource_type="persona",
            resource_id=new_id,
        )
        await reply(
            f"AI 生成人设 · 第 3/3 步\n已创建：{created_name}\n"
            "请选择下一步：先生成首张人设图，或打开基础资料继续完善。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                types.InlineKeyboardButton(
                    text="打开人设",
                    callback_data=callback_token(chat_id, "p", {"persona_id": new_id}),
                ),
                types.InlineKeyboardButton(text="查看我的人设", callback_data="tt:personas:0"),
            ], [
                types.InlineKeyboardButton(
                    text="进入人设图设置",
                    callback_data=callback_token(chat_id, "personaimage", {"persona_id": new_id, "page": 0}),
                ),
                types.InlineKeyboardButton(text="基础资料", callback_data="tt:profile"),
            ]]),
        )
        return new_id

    async def handle_callback(self, query: Any, types: Any) -> None:
        if query.message is None:
            await query.answer("消息已失效", show_alert=True)
            return
        data = str(query.data or "")
        chat_id = int(getattr(getattr(query.message, "chat", None), "id", 0) or 0)
        login_modes = {
            CHAT_LOGIN_USERNAME_MODE,
            CHAT_LOGIN_PASSWORD_MODE,
            CHAT_LOGIN_VERIFICATION_MODE,
        }
        if data in {"tt:login_cancel", "tt:accountmenu"}:
            # Login controls must remain usable before a member exists.  The
            # normal account page is protected by _authorized(), while this
            # short branch only clears the private-chat login FSM and renders
            # either the bound account page or the self-service entry point.
            login_active = data == "tt:login_cancel" or load_state(chat_id)["mode"] in login_modes
            if login_active:
                await query.answer()
                self._clear_chat_login(chat_id)
                member = self._member(chat_id)
                if member is not None:
                    try:
                        page_text, markup = await self._account_management_payload(types, member)
                        prefix = "已返回账号管理。" if data == "tt:accountmenu" else "已取消推文工作台登录。"
                        await query.message.edit_text(prefix + "\n\n" + page_text, reply_markup=markup)
                    except Exception:
                        logger.debug("Unable to render tweet account menu after login callback", exc_info=True)
                        await query.message.edit_text(
                            "已返回账号管理。\n如需继续，请点击下方按钮重新开始。",
                            reply_markup=self._binding_markup(types, chat_id),
                        )
                else:
                    prefix = "已返回账号管理。" if data == "tt:accountmenu" else "已取消推文工作台登录。"
                    await query.message.edit_text(
                        prefix + "\n当前 Telegram 尚未绑定 VECTO 用户，请点击下方按钮在聊天中登录。",
                        reply_markup=self._binding_markup(types, chat_id),
                    )
                return
        if data == "tt:stepcancel":
            # Cancelling an input step is deliberately safe even when the
            # web session has expired.  It only clears the Telegram-side
            # draft/FSM state and must never require a second login just to
            # escape a stale prompt.
            await query.answer()
            clear_pending_state(chat_id)
            await query.message.edit_text(
                "已取消当前步骤，未提交新的任务或修改。",
                reply_markup=self._binding_markup(types, chat_id),
            )
            return
        if data == "tt:chatlogin":
            # This action is intentionally available before _authorized(): the
            # whole point is to establish the first binding from a Telegram
            # private chat without opening a WebApp or external browser.
            await query.answer()
            await self._start_chat_login(
                query.message,
                types,
                from_user=getattr(query, "from_user", None),
            )
            return
        async def authorization_reply(text: str, **kwargs: Any) -> Any:
            # CallbackQuery.answer cannot carry reply_markup.  Send the
            # self-service binding button as a normal message when the
            # callback arrives after logout/expiry, while keeping ordinary
            # authorization errors as callback alerts.
            markup = kwargs.pop("reply_markup", None)
            if markup is not None:
                # Telegram keeps the callback spinner visible until the
                # callback is answered.  The binding prompt is sent as a
                # normal message because callback answers cannot carry a
                # reply markup, so acknowledge it before sending that
                # message.
                await query.answer()
                return await query.message.answer(text, reply_markup=markup, **kwargs)
            return await query.answer(text, **kwargs)

        member = await self._authorized(
            query.message.chat,
            query.from_user,
            authorization_reply,
            types=types,
            show_webapp_link=True,
        )
        if not member:
            return
        chat_id = int(query.message.chat.id)
        user_id = int(member["web_user_id"])
        parts = data.split(":")
        action = parts[1] if len(parts) > 1 else ""
        try:
            if action == "menu":
                clear_pending_state(chat_id)
                await query.message.edit_text("已返回推文工作台总控菜单。")
                await query.message.answer("请选择总控功能。", reply_markup=self._main_keyboard(types))
            elif action == "stepcancel":
                # Text/media wizard steps must be cancellable from the
                # message itself.  This is intentionally separate from the
                # task-stop control: it only clears the pending input state
                # and never touches an already submitted backend task.
                clear_pending_state(chat_id)
                await query.message.edit_text(
                    "已取消当前步骤，未提交新的任务或修改。",
                    reply_markup=self._return_keyboard(types),
                )
            elif action == "help":
                help_text = HELP_TEXT
                if self.chat_login is not None:
                    help_text = help_text.replace(
                        "旧版网页绑定路径不接收账号密码；聊天内登录仅在私聊临时验证，密码不写入 Bot 状态或审计，请勿在群聊中发送。",
                        "聊天内登录仅限私聊使用；密码只在验证期间短暂使用，不写入 Bot 状态或审计，请勿在群聊中发送。",
                    )
                await query.message.edit_text(
                    help_text,
                    reply_markup=self._return_keyboard(types),
                )
            elif action == "taskmenu":
                clear_pending_state(chat_id)
                status_text, status_markup = await self._task_status_payload(types, member)
                await query.message.edit_text(
                    status_text,
                    reply_markup=status_markup,
                )
            elif action == "accountmenu":
                clear_pending_state(chat_id)
                page_text, markup = await self._account_management_payload(types, member)
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "vectosession":
                page_text, markup = await self._vecto_session_payload(types, member)
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "platformaccounts":
                page_text, markup = await self._accounts_payload(
                    types, member, return_callback="tt:accountmenu",
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "accountspage" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "accountspage", parts[2])
                page_text, markup = await self._accounts_payload(
                    types,
                    member,
                    return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                    persona_id=str(reference.get("persona_id") or ""),
                    operation=str(reference.get("operation") or ""),
                    page=int(reference.get("page") or 0),
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "persona_accounts":
                state = load_state(chat_id)
                persona_id = str(state.get("selected_persona_id") or "").strip()
                page_text, markup = await self._persona_binding_payload(
                    types, member, persona_id, page=0,
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "pabindpage" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pabindpage", parts[2])
                page_text, markup = await self._persona_binding_payload(
                    types,
                    member,
                    str(reference.get("persona_id") or ""),
                    page=int(reference.get("page") or 0),
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "pabind" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pabind", parts[2])
                account_id = str(reference.get("account_id") or "").strip()
                persona_id = str(reference.get("persona_id") or "").strip()
                if not account_id or not persona_id:
                    raise HTTPException(status_code=410, detail="绑定选项已失效，请重新打开人设账号绑定")
                accounts = await self._call(user_id, "accounts.list")
                account = next(
                    (item for item in (accounts if isinstance(accounts, list) else [])
                     if isinstance(item, dict) and str(item.get("id") or "") == account_id),
                    None,
                )
                if not account:
                    raise HTTPException(status_code=404, detail="平台账号不存在或已被移除")
                if (
                    str(account.get("status") or "").strip().lower() in {"disabled", "removed", "revoked", "expired", "error", "failed"}
                    or str(account.get("health_status") or "").strip().lower() in {"disabled", "removed", "revoked", "expired", "error", "failed"}
                ):
                    raise HTTPException(status_code=409, detail="该平台账号当前不可绑定，请先恢复授权状态")
                bound_persona_id = str(account.get("persona_id") or "").strip()
                if bound_persona_id and bound_persona_id != persona_id:
                    confirm_token = callback_token(chat_id, "pabindconfirm", {
                        "account_id": account_id,
                        "persona_id": persona_id,
                        "page": max(0, int(reference.get("page") or 0)),
                        "bound_persona_name": str(reference.get("bound_persona_name") or "其他人设"),
                    })
                    platform = str(account.get("platform") or "未知平台").strip()
                    username = str(account.get("username") or "未设置账号").strip().lstrip("@")
                    await query.message.edit_text(
                        f"确认改绑账号？\n\n平台：{platform}\n账号：@{username}\n"
                        f"当前人设：{reference.get('bound_persona_name') or '其他人设'}\n"
                        "确认后该账号将改为绑定当前人设。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[
                            [types.InlineKeyboardButton(text="确认改绑", callback_data=confirm_token)],
                            [types.InlineKeyboardButton(text="取消", callback_data="tt:persona_accounts")],
                        ]),
                    )
                else:
                    await self._call(user_id, "accounts.bind_persona", {
                        "account_id": account_id,
                        "persona_id": persona_id,
                        "replace_existing_binding": True,
                    })
                    audit_action(chat_id, user_id, "accounts.bind_persona", status="success", resource_type="account", resource_id=account_id)
                    page_text, markup = await self._persona_binding_payload(
                        types, member, persona_id, page=int(reference.get("page") or 0),
                    )
                    await query.message.edit_text("账号已绑定当前人设。\n\n" + page_text, reply_markup=markup)
            elif action == "pabindconfirm" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pabindconfirm", parts[2], consume=True)
                account_id = str(reference.get("account_id") or "").strip()
                persona_id = str(reference.get("persona_id") or "").strip()
                if not account_id or not persona_id:
                    raise HTTPException(status_code=410, detail="绑定确认已失效，请重新打开人设账号绑定")
                accounts = await self._call(user_id, "accounts.list")
                account = next(
                    (item for item in (accounts if isinstance(accounts, list) else [])
                     if isinstance(item, dict) and str(item.get("id") or "") == account_id),
                    None,
                )
                if not account:
                    raise HTTPException(status_code=404, detail="平台账号不存在或已被移除")
                if (
                    str(account.get("status") or "").strip().lower() in {"disabled", "removed", "revoked", "expired", "error", "failed"}
                    or str(account.get("health_status") or "").strip().lower() in {"disabled", "removed", "revoked", "expired", "error", "failed"}
                ):
                    raise HTTPException(status_code=409, detail="该平台账号当前不可绑定，请先恢复授权状态")
                await self._call(user_id, "accounts.bind_persona", {
                    "account_id": account_id,
                    "persona_id": persona_id,
                    "replace_existing_binding": True,
                })
                audit_action(chat_id, user_id, "accounts.bind_persona", status="success", resource_type="account", resource_id=account_id)
                page_text, markup = await self._persona_binding_payload(
                    types, member, persona_id, page=int(reference.get("page") or 0),
                )
                await query.message.edit_text("账号已改绑当前人设。\n\n" + page_text, reply_markup=markup)
            elif action == "accounts":
                # Compatibility for older notifications/bookmarks that still
                # point at tt:accounts. Platform accounts now have their own
                # page and must not be mixed with VECTO session controls.
                page_text, markup = await self._accounts_payload(
                    types, member, return_callback="tt:accountmenu",
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "accountadd":
                base = str((self.get_runtime() or {}).get("telegram_tweet_public_base_url") or "").rstrip("/")
                rows = []
                if base.startswith("https://"):
                    rows.append([types.InlineKeyboardButton(
                        text="➕ 授权 Threads",
                        url=f"{base}/console.html?view=accounts&authorize_platform=threads",
                    ), types.InlineKeyboardButton(
                        text="➕ 授权 Instagram",
                        url=f"{base}/console.html?view=accounts&authorize_platform=instagram",
                    )])
                    rows.append([types.InlineKeyboardButton(
                        text="📂 打开平台账号管理",
                        url=f"{base}/console.html?view=accounts",
                    )])
                rows.extend([
                    [types.InlineKeyboardButton(text="📋 查看已授权账号", callback_data="tt:platformaccounts")],
                    [types.InlineKeyboardButton(text="返回账号管理", callback_data="tt:accountmenu")],
                ])
                await query.message.edit_text(
                    "添加平台账号\n\n"
                    "平台账号登录、OAuth 和验证码必须在已有的安全网页/浏览器会话中完成。\n"
                    "完成后返回 Telegram，点击“查看已绑定账号”，再进入账号详情检测登录状态并绑定人设。\n"
                    "Bot 不接收或保存平台账号密码。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"accountswitch", "accountbind", "accountunbind"}:
                operation = {
                    "accountswitch": "switch",
                    "accountbind": "bind",
                    "accountunbind": "unbind",
                }[action]
                page_text, markup = await self._accounts_payload(
                    types,
                    member,
                    return_callback="tt:platformaccounts",
                    operation=operation,
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            elif action == "ac" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "ac", parts[2])
                account_id = str(reference.get("account_id") or "").strip()
                if not account_id:
                    raise HTTPException(status_code=410, detail="账号操作已失效，请重新选择")
                operation = str(reference.get("operation") or "").strip()
                if operation == "bind":
                    await self._account_persona_picker(
                        query, types, member, account_id,
                        return_page=int(reference.get("page") or 0),
                        persona_filter=str(reference.get("persona_filter") or reference.get("persona_id") or ""),
                        operation=operation,
                        return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                    )
                else:
                    detail_text, detail_markup = await self._account_detail_payload(
                        types, member, account_id,
                        return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                        page=int(reference.get("page") or 0),
                        persona_filter=str(reference.get("persona_id") or ""),
                        operation=operation,
                    )
                    await query.message.edit_text(detail_text, reply_markup=detail_markup)
            elif action == "aclogout":
                result = await self._call(user_id, "auth.logout", {"chat_id": chat_id})
                self._clear_chat_login(chat_id)
                revoked = int(result.get("revoked_sessions") or 0) if isinstance(result, dict) else 0
                markup = self._binding_markup(types, chat_id)
                await query.message.edit_text(
                    "VECTO 网页账号已退出。\n"
                    f"已撤销 {revoked} 个登录会话；Telegram 推文工作台也已停止使用。\n"
                    "如需继续，请在本私聊中重新登录并绑定。",
                    reply_markup=markup,
                )
            elif action in {"accheck", "aclogin"} and len(parts) > 2:
                token_action = action
                reference = resolve_callback_token(chat_id, token_action, parts[2], consume=True)
                account_id = str(reference.get("account_id") or "").strip()
                dispatch_action = "accounts.check_login" if action == "accheck" else "accounts.open_login"
                result = await self._call(user_id, dispatch_action, {"account_id": account_id})
                if bool(result.get("authorized")):
                    message_text = "平台账号当前已授权，登录状态有效。"
                else:
                    task = result.get("task") if isinstance(result, dict) else {}
                    task_id = str((task or {}).get("id") or (task or {}).get("task_id") or "")
                    if action == "accheck" and not task_id:
                        message_text = str(result.get("message") or "平台授权状态无法确认，请点击重新授权。")
                    else:
                        message_text = (
                            ("已创建登录检测任务。" if action == "accheck" else "已创建重新登录任务，请在安全浏览器中完成登录。")
                            + (f"\n任务：{task_id}" if task_id else "")
                        )
                audit_action(chat_id, user_id, dispatch_action, status="success", resource_type="account", resource_id=account_id)
                detail_text, detail_markup = await self._account_detail_payload(
                    types, member, account_id,
                    return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                    page=int(reference.get("page") or 0),
                    persona_filter=str(reference.get("persona_filter") or ""),
                    operation=str(reference.get("operation") or ""),
                )
                await query.message.edit_text(message_text + "\n\n" + detail_text, reply_markup=detail_markup)
            elif action == "acbind" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "acbind", parts[2])
                account_id = str(reference.get("account_id") or "").strip()
                await self._account_persona_picker(
                    query, types, member, account_id,
                    return_page=int(reference.get("page") or 0),
                    persona_filter=str(reference.get("persona_filter") or reference.get("persona_id") or ""),
                    operation=str(reference.get("operation") or ""),
                    return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                )
            elif action == "acbindpage" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "acbindpage", parts[2])
                await self._account_persona_picker(
                    query,
                    types,
                    member,
                    str(reference.get("account_id") or "").strip(),
                    page=int(reference.get("page") or 0),
                    return_page=int(reference.get("return_page") or 0),
                    persona_filter=str(reference.get("persona_filter") or ""),
                    operation=str(reference.get("operation") or ""),
                    return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                )
            elif action == "papage" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "papage", parts[2])
                await self._publish_account_picker(
                    query,
                    types,
                    member,
                    source=str(reference.get("source") or "posts"),
                    post_id=str(reference.get("post_id") or ""),
                    scheduled=bool(reference.get("scheduled")),
                    page=int(reference.get("page") or 0),
                    intent=str(reference.get("intent") or ""),
                )
            elif action == "acbindselect" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "acbindselect", parts[2], consume=True)
                account_id = str(reference.get("account_id") or "").strip()
                persona_id = str(reference.get("persona_id") or "").strip()
                result = await self._call(user_id, "accounts.bind_persona", {
                    "account_id": account_id,
                    "persona_id": persona_id,
                    "replace_existing_binding": True,
                })
                audit_action(chat_id, user_id, "accounts.bind_persona", status="success", resource_type="account", resource_id=account_id)
                detail_text, detail_markup = await self._account_detail_payload(
                    types, member, account_id,
                    return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                    page=int(reference.get("return_page") or reference.get("page") or 0),
                    persona_filter=str(reference.get("persona_filter") or ""),
                    operation=str(reference.get("operation") or ""),
                )
                await query.message.edit_text("人设绑定已更新。\n\n" + detail_text, reply_markup=detail_markup)
            elif action == "acunbind" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "acunbind", parts[2], consume=True)
                account_id = str(reference.get("account_id") or "").strip()
                await self._call(user_id, "accounts.unbind_persona", {"account_id": account_id})
                audit_action(chat_id, user_id, "accounts.unbind_persona", status="success", resource_type="account", resource_id=account_id)
                page_text, markup = await self._accounts_payload(
                    types, member,
                    return_callback=str(reference.get("return_callback") or "tt:platformaccounts"),
                    persona_id=str(reference.get("persona_filter") or ""),
                    operation="unbind",
                    page=int(reference.get("page") or 0),
                )
                await query.message.edit_text("人设已解绑，账号资料仍保留。\n\n" + page_text, reply_markup=markup)
            elif action == "acremove" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "acremove", parts[2])
                account_id = str(reference.get("account_id") or "").strip()
                remove_context = {
                    "account_id": account_id,
                    "page": max(0, int(reference.get("page") or 0)),
                    "persona_filter": str(reference.get("persona_filter") or ""),
                    "operation": str(reference.get("operation") or ""),
                    "return_callback": str(reference.get("return_callback") or "tt:platformaccounts"),
                }
                confirm_token = callback_token(chat_id, "acremoveconfirm", remove_context)
                await query.message.edit_text(
                    "确认移除账号？\n\n这会停用账号、取消进行中的自动化任务并删除账号记录；如果只是更换人设，请选择“解绑人设”。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="确认移除", callback_data=confirm_token)
                    ], [
                        types.InlineKeyboardButton(
                            text="取消",
                            callback_data=callback_token(chat_id, "ac", remove_context),
                        )
                    ]]),
                )
            elif action == "acremoveconfirm" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "acremoveconfirm", parts[2], consume=True)
                account_id = str(reference.get("account_id") or "").strip()
                result = await self._call(user_id, "accounts.disable", {"account_id": account_id})
                deleted = int(result.get("deleted") or 0) if isinstance(result, dict) else 0
                audit_action(chat_id, user_id, "accounts.disable", status="success", resource_type="account", resource_id=account_id)
                await query.message.edit_text(
                    "账号已移除。" if deleted else "账号已停用或已不存在。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回账号列表",
                            callback_data=callback_token(chat_id, "accountspage", {
                                "page": max(0, int(reference.get("page") or 0)),
                                "persona_id": str(reference.get("persona_filter") or ""),
                                "operation": str(reference.get("operation") or ""),
                                "return_callback": str(reference.get("return_callback") or "tt:platformaccounts"),
                            }),
                        ),
                        types.InlineKeyboardButton(text="返回账号管理", callback_data="tt:accountmenu"),
                    ]]),
                )
            elif action == "personamanage":
                clear_pending_state(chat_id)
                reference = resolve_callback_token(chat_id, "personamanage", parts[2]) if len(parts) > 2 else {}
                await self._persona_management(
                    query, types, member,
                    page=max(0, int(reference.get("page") or 0)),
                )
            elif action == "personamenu":
                # Legacy callback: the old persona menu is now the explicit
                # management page, not a second copy of the selector.
                clear_pending_state(chat_id)
                await self._persona_management(query, types, member)
            elif action == "creationmenu":
                clear_pending_state(chat_id)
                await self._render_persona_module(query, types, member, "create")
            elif action == "contentmenu":
                clear_pending_state(chat_id)
                await self._render_persona_module(query, types, member, "content")
            elif action == "publishmenu":
                clear_pending_state(chat_id)
                await self._render_persona_module(query, types, member, "publish")
            elif action == "personas":
                await self._persona_list(query, types, member, int(parts[2]) if len(parts) > 2 else 0)
            elif action in {
                "personagroups",
                "group",
                "groupnew",
                "groupadd",
                "groupaddselect",
                "groupremove",
                "groupassign",
                "groupassignselect",
                "grouprename",
                "groupdeleteask",
                "groupdelete",
            }:
                # Group management remains a Web-only organization feature.
                # Keep stale Telegram callbacks harmless instead of allowing
                # old keyboards to reopen a feature removed from this Bot.
                clear_pending_state(chat_id)
                state = load_state(chat_id)
                return_callback = (
                    "tt:pmod:settings"
                    if state.get("selected_persona_id")
                    else "tt:personamanage"
                )
                await query.message.edit_text(
                    "Telegram 版已移除人设分组功能。\n"
                    "请返回人设设置继续管理资料、图库、平台账号或数据刷新。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="返回", callback_data=return_callback),
                    ]]),
                )
            elif action == "personagroups":
                await self._persona_groups(query, types, member, int(parts[2]) if len(parts) > 2 else 0)
            elif action == "group" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "group", parts[2])
                await self._persona_group_detail(
                    query,
                    types,
                    member,
                    str(reference.get("group_id") or ""),
                    page=int(reference.get("page") or 0),
                    groups_page=int(reference.get("groups_page") or 0),
                )
            elif action == "groupnew":
                save_state(chat_id, mode="persona_group_create", payload={})
                await query.message.edit_text(
                    "人设分组 · 新建\n"
                    "请发送分组名称；分组只用于整理人设、筛选和矩阵发布，不会复制或删除人设资料。\n"
                )
            elif action == "groupadd" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupadd", parts[2])
                await self._persona_group_add_picker(
                    query, types, member,
                    str(reference.get("group_id") or ""),
                    int(reference.get("page") or 0),
                    detail_page=int(reference.get("detail_page") or 0),
                    groups_page=int(reference.get("groups_page") or 0),
                )
            elif action == "groupaddselect" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupaddselect", parts[2], consume=True)
                await self._call(user_id, "persona.group.add", {
                    "group_id": str(reference.get("group_id") or ""),
                    "persona_id": str(reference.get("persona_id") or ""),
                })
                await self._persona_group_detail(
                    query, types, member, str(reference.get("group_id") or ""),
                    page=int(reference.get("page") or reference.get("detail_page") or 0),
                    groups_page=int(reference.get("groups_page") or 0),
                )
            elif action == "groupremove" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupremove", parts[2], consume=True)
                await self._call(user_id, "persona.group.remove", {
                    "group_id": str(reference.get("group_id") or ""),
                    "persona_id": str(reference.get("persona_id") or ""),
                })
                await self._persona_group_detail(
                    query, types, member, str(reference.get("group_id") or ""),
                    page=int(reference.get("page") or 0),
                    groups_page=int(reference.get("groups_page") or 0),
                )
            elif action == "groupassign" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupassign", parts[2])
                await self._persona_group_assign_picker(
                    query,
                    types,
                    member,
                    str(reference.get("persona_id") or ""),
                    page=int(reference.get("page") or 0),
                )
            elif action == "groupassignselect" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupassignselect", parts[2], consume=True)
                await self._call(user_id, "persona.group.add", {
                    "group_id": str(reference.get("group_id") or ""),
                    "persona_id": str(reference.get("persona_id") or ""),
                })
                await query.message.edit_text(
                    "人设已加入分组。\n"
                    "分组关系已更新，人设正文、图库、账号绑定和发布历史不受影响。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[
                        self._persona_module_back_row(types, chat_id, str(reference.get("persona_id") or ""), "settings"),
                    ]),
                )
            elif action == "grouprename" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "grouprename", parts[2])
                save_state(chat_id, mode="persona_group_rename", payload={
                    "group_id": str(reference.get("group_id") or ""),
                    "detail_page": int(reference.get("detail_page") or 0),
                    "groups_page": int(reference.get("groups_page") or 0),
                })
                await query.message.edit_text(
                    "人设分组 · 重命名\n"
                    "请发送新的分组名称；只修改分组标题，不会改变组内人设。\n"
                )
            elif action == "groupdeleteask" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupdeleteask", parts[2])
                await query.message.edit_text(
                    "确认删除这个人设分组？组内人设不会被删除，只会解除分组关系。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="确认删除分组",
                            callback_data=callback_token(chat_id, "groupdelete", {
                                "group_id": str(reference.get("group_id") or ""),
                                "groups_page": int(reference.get("groups_page") or 0),
                            }),
                        ),
                        types.InlineKeyboardButton(text="取消", callback_data=callback_token(chat_id, "group", {
                            "group_id": str(reference.get("group_id") or ""),
                            "page": int(reference.get("detail_page") or 0),
                            "groups_page": int(reference.get("groups_page") or 0),
                        })),
                    ]]),
                )
            elif action == "groupdelete" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "groupdelete", parts[2], consume=True)
                await self._call(user_id, "persona.group.delete", {"group_id": str(reference.get("group_id") or "")})
                await self._persona_groups(
                    query, types, member, int(reference.get("groups_page") or 0),
                )
            elif action == "pduplicate" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pduplicate", parts[2], consume=True)
                state_payload = load_state(chat_id)["payload"]
                persona_page = max(0, int(
                    reference.get("persona_page")
                    if reference.get("persona_page") is not None
                    else state_payload.get("persona_list_page") or 0
                ))
                result = await self._call(user_id, "persona.duplicate", {
                    "persona_id": str(reference.get("persona_id") or ""),
                })
                profile = result.get("profile") if isinstance(result, dict) and isinstance(result.get("profile"), dict) else {}
                duplicate_id = str(profile.get("id") or result.get("id") or "")
                await query.message.edit_text(
                    f"人设已复制：{str(profile.get('name') or '副本人设')}。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="打开副本人设", callback_data=callback_token(chat_id, "p", {
                            "persona_id": duplicate_id,
                            "page": persona_page,
                        })),
                        types.InlineKeyboardButton(text="返回我的人设", callback_data=f"tt:personas:{persona_page}"),
                    ]]),
                )
            elif action == "pdeleteask" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pdeleteask", parts[2])
                state_payload = load_state(chat_id)["payload"]
                persona_page = max(0, int(
                    reference.get("persona_page")
                    if reference.get("persona_page") is not None
                    else state_payload.get("persona_list_page") or 0
                ))
                await query.message.edit_text(
                    "确认删除该人设？草稿、收藏、发布历史、人设图库和绑定关系都会一并移除，无法恢复。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="确认删除人设", callback_data=callback_token(chat_id, "pdelete", {
                            "persona_id": str(reference.get("persona_id") or ""),
                            "page": persona_page,
                        })),
                        types.InlineKeyboardButton(text="取消", callback_data=callback_token(chat_id, "p", {
                            "persona_id": str(reference.get("persona_id") or ""),
                            "page": persona_page,
                        })),
                    ]]),
                )
            elif action == "pdelete" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pdelete", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or "")
                await self._call(user_id, "persona.delete", {"persona_id": persona_id})
                state = load_state(chat_id)
                persona_page = max(0, int(
                    reference.get("page")
                    if reference.get("page") is not None
                    else state["payload"].get("persona_list_page") or 0
                ))
                if state["selected_persona_id"] == persona_id:
                    save_state(chat_id, selected_persona_id="", mode="", payload={})
                await self._persona_list(query, types, member, persona_page)
            elif action == "prefresh" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "prefresh", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"] or "")
                task = await self._call(user_id, "persona.refresh", {
                    "persona_id": persona_id, "source": "http_first", "platform": "",
                })
                task_id = str(task.get("id") or task.get("task_id") or "") if isinstance(task, dict) else ""
                refresh_rows: list[list[Any]] = []
                if task_id:
                    refresh_rows.append([types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                        }),
                    )])
                refresh_rows.append([types.InlineKeyboardButton(
                    text="返回人设设置",
                    callback_data="tt:pmod:settings",
                )])
                await query.message.edit_text(
                    f"人设数据刷新已提交：{task_id or '已排队'}\n"
                    "后台会更新绑定平台的公开数据和热点指标，不会覆盖简介、图库或未定义字段。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=refresh_rows),
                )
            elif action == "p" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "p", parts[2])
                persona_id = str(reference.get("persona_id") or "")
                personas = await self._call(user_id, "personas.list")
                persona = next((item for item in personas if str(item.get("id") or "") == persona_id), None)
                if not persona:
                    raise HTTPException(status_code=404, detail="人设不存在")
                previous = load_state(chat_id)
                persona_page = max(0, int(
                    reference.get("page")
                    if reference.get("page") is not None
                    else previous["payload"].get("persona_list_page") or 0
                ))
                resume_action = str(previous["payload"].get("resume_action") or "")
                retained = {
                    key: value
                    for key, value in previous["payload"].items()
                    if str(key).startswith("last_")
                }
                retained["persona_list_page"] = persona_page
                save_state(chat_id, selected_persona_id=persona_id, mode="", payload=retained)
                if resume_action == "generate":
                    await self._start_generation_setup(query, types)
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                if resume_action == "hot":
                    await self._start_hot_input(query, types)
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                if resume_action == "draft_new":
                    save_state(chat_id, mode="draft_new", payload={})
                    await query.message.edit_text(
                        "手工新建草稿 · 输入正文\n请发送草稿正文。",
                        reply_markup=self._step_navigation_markup(
                            types, back_callback="tt:pmod:create", back_text="返回新建推文",
                        ),
                    )
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                if resume_action in {"drafts", "favorites", "publish_one"}:
                    source = "favorites" if resume_action == "favorites" else "posts"
                    await self._post_list(
                        query, types, member, source=source, page=0,
                        intro="单篇发布 · 请选择要发布的草稿。" if resume_action == "publish_one" else "",
                        intent="publish" if resume_action == "publish_one" else "",
                    )
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                await self._render_persona_home(query, types, persona, chat_id, page=persona_page)
            elif action == "pmod":
                module = str(parts[2] if len(parts) > 2 else "").strip().lower()
                await self._render_persona_module(query, types, member, module)
            elif action == "persona_new":
                state = load_state(chat_id)
                retained = {
                    key: value
                    for key, value in state["payload"].items()
                    if str(key).startswith("last_") or key == "resume_action"
                }
                save_state(chat_id, mode="persona_new", payload=retained)
                await query.message.edit_text(
                    "手工新建人设 · 第 1 步\n"
                    "请发送：人设名称｜简介\n"
                    "例如：科技观察员｜关注 AI 产品与创业趋势，语气克制专业。\n"
                    "简介会作为后续推文、配图和人设图的基础上下文；未填写的其他字段保持默认。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:personamanage", back_text="返回人设管理",
                    ),
                )
            elif action in {"persona_ai_new", "persona_ai_name"}:
                save_state(chat_id, mode="persona_ai_name", payload={})
                await query.message.edit_text(
                    "AI 生成人设 · 第 1/3 步\n"
                    "请单独发送人设名称。\n"
                    "例如：科技观察员\n"
                    "收到名称后，下一步会单独引导你发送人设提示词。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:personamanage", back_text="返回人设管理",
                    ),
                )
            elif action == "persona_ai_noop":
                await query.answer("请选择下方关键词，标题本身不可操作。")
                return
            elif action == "persona_ai_keyword" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "persona_ai_keyword", parts[2])
                state = load_state(chat_id)
                if state["mode"] != "persona_ai_keyword_select":
                    raise HTTPException(status_code=409, detail="关键词选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                kind = str(reference.get("kind") or "").strip().lower()
                if kind not in {"regular", "hot"}:
                    raise HTTPException(status_code=400, detail="关键词分组无效")
                try:
                    index = int(reference.get("index"))
                except (TypeError, ValueError) as exc:
                    raise HTTPException(status_code=400, detail="关键词索引无效") from exc
                field = "ai_keywords" if kind == "regular" else "ai_hot_keywords"
                selected_field = (
                    "ai_selected_regular_keywords"
                    if kind == "regular"
                    else "ai_selected_hot_keywords"
                )
                options = self._persona_ai_keyword_values(payload.get(field))
                if index < 0 or index >= len(options):
                    raise HTTPException(status_code=400, detail="关键词选项已失效，请重新提炼")
                keyword = options[index]
                selected = self._persona_ai_keyword_values(payload.get(selected_field), limit=2)
                if keyword in selected:
                    selected = [item for item in selected if item != keyword]
                else:
                    if len(selected) >= 2:
                        raise HTTPException(status_code=400, detail="每组最多选择 2 个关键词")
                    all_selected = set(
                        self._persona_ai_keyword_values(payload.get("ai_selected_regular_keywords"), limit=2)
                        + self._persona_ai_keyword_values(payload.get("ai_selected_hot_keywords"), limit=2)
                    )
                    if len(all_selected) >= 4:
                        raise HTTPException(status_code=400, detail="最多选择 4 个关键词")
                    selected.append(keyword)
                payload[selected_field] = selected
                payload["ai_selected_keywords"] = list(dict.fromkeys(
                    self._persona_ai_keyword_values(payload.get("ai_selected_regular_keywords"), limit=2)
                    + self._persona_ai_keyword_values(payload.get("ai_selected_hot_keywords"), limit=2)
                ))[:4]
                save_state(chat_id, mode="persona_ai_keyword_select", payload=payload)
                await query.message.edit_text(
                    self._persona_ai_keywords_text(payload),
                    reply_markup=self._persona_ai_keywords_markup(types, chat_id, payload),
                )
            elif action in {"persona_ai_clear", "persona_ai_back", "persona_ai_direct", "persona_ai_confirm"} and len(parts) > 2:
                # Do not consume the confirmation token before validation: a
                # user who clicked too early must be able to select another
                # keyword and confirm again.  The server-side idempotency key
                # keeps duplicate Telegram deliveries safe.
                reference = resolve_callback_token(chat_id, action, parts[2])
                state = load_state(chat_id)
                if state["mode"] != "persona_ai_keyword_select":
                    raise HTTPException(status_code=409, detail="关键词选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                name = str(payload.get("ai_name") or "").strip()
                prompt = str(payload.get("ai_prompt") or "").strip()
                if not name or not prompt:
                    raise HTTPException(status_code=409, detail="AI 人设输入已失效，请重新填写")
                if action == "persona_ai_clear":
                    payload["ai_selected_regular_keywords"] = []
                    payload["ai_selected_hot_keywords"] = []
                    payload["ai_selected_keywords"] = []
                    save_state(chat_id, mode="persona_ai_keyword_select", payload=payload)
                    await query.message.edit_text(
                        self._persona_ai_keywords_text(payload, notice="已清空关键词选择。"),
                        reply_markup=self._persona_ai_keywords_markup(types, chat_id, payload),
                    )
                elif action == "persona_ai_back":
                    save_state(chat_id, mode="persona_ai_prompt", payload={
                        "ai_name": name,
                    })
                    await query.message.edit_text(
                        "AI 生成人设 · 第 2/3 步\n"
                        f"名称：{name[:160]}\n"
                        "请单独重新发送人设提示词。\n"
                        "可描述身份、性格、内容方向、语气、受众和图片风格。",
                        reply_markup=self._step_navigation_markup(
                            types, back_callback="tt:persona_ai_name", back_text="返回重新输入名称",
                        ),
                    )
                else:
                    selected_regular = self._persona_ai_keyword_values(
                        payload.get("ai_selected_regular_keywords"), limit=2,
                    )
                    selected_hot = self._persona_ai_keyword_values(
                        payload.get("ai_selected_hot_keywords"), limit=2,
                    )
                    if action == "persona_ai_confirm":
                        if len(set(selected_regular) | set(selected_hot)) < 2:
                            raise HTTPException(status_code=400, detail="请至少选择 2 个人设关键词，或点击直接创建")
                        await self._finish_persona_ai_create(
                            user_id=user_id,
                            chat_id=chat_id,
                            types=types,
                            name=name,
                            prompt=prompt,
                            selected_keywords=list(dict.fromkeys(selected_regular + selected_hot)),
                            selected_regular_keywords=selected_regular,
                            selected_hot_keywords=selected_hot,
                            idempotency_key=str(payload.get("ai_create_idempotency_key") or f"tg:persona-ai-create:{chat_id}:{query.message.message_id}"),
                            reply=query.message.edit_text,
                        )
                    else:
                        await self._finish_persona_ai_create(
                            user_id=user_id,
                            chat_id=chat_id,
                            types=types,
                            name=name,
                            prompt=prompt,
                            selected_keywords=[],
                            selected_regular_keywords=[],
                            selected_hot_keywords=[],
                            idempotency_key=str(payload.get("ai_create_idempotency_key") or f"tg:persona-ai-create:{chat_id}:{query.message.message_id}"),
                            reply=query.message.edit_text,
                        )
            elif action == "persona_copy_new":
                save_state(chat_id, mode="persona_copy_analyze", payload={})
                await query.message.edit_text(
                    "复制公开人设\n请发送公开 Threads 或 Instagram 用户主页链接；\n"
                    "如需指定新名称，可发送：新名称｜公开主页链接。\n"
                    "系统会先分析公开资料，下一步展示结果供确认；不会修改原账号或原人设。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:personamanage", back_text="返回人设管理",
                    ),
                )
            elif action == "persona_copy_confirm":
                state = load_state(chat_id)
                if state["mode"] != "persona_copy_confirm":
                    raise HTTPException(status_code=409, detail="复制分析已失效，请重新开始")
                profile = state["payload"].get("copy_profile") if isinstance(state["payload"].get("copy_profile"), dict) else {}
                source = state["payload"].get("copy_source") if isinstance(state["payload"].get("copy_source"), dict) else {}
                name = str(profile.get("name") or "").strip()
                content = str(profile.get("content") or "").strip()
                if not name or not content:
                    raise HTTPException(status_code=409, detail="复制分析结果不完整，请重新分析")
                result = await self._call(user_id, "personas.create", {
                    "name": name[:160],
                    "content": content[:5000],
                    "setup": profile.get("setup") if isinstance(profile.get("setup"), dict) else {},
                    "copy_source": source,
                })
                persona = result.get("persona") if isinstance(result, dict) and isinstance(result.get("persona"), dict) else result
                new_id = str((persona or {}).get("id") or result.get("id") or "")
                created_name = str((persona or {}).get("name") or name)
                clear_pending_state(chat_id)
                save_state(chat_id, selected_persona_id=new_id, payload={})
                await query.message.edit_text(
                    f"复制人设已创建：{created_name}\n"
                    "已建立独立的人设资料；原公开人设不会被修改。\n"
                    "可以打开副本人设继续完善简介、图库、账号绑定和推文设置。\n"
                    "建议先进入人设图设置确认参考图，再开始生成内容。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="打开人设", callback_data=callback_token(chat_id, "p", {"persona_id": new_id})),
                        types.InlineKeyboardButton(text="查看我的人设", callback_data="tt:personas:0"),
                    ], [
                        types.InlineKeyboardButton(
                            text="进入人设图设置",
                            callback_data=callback_token(chat_id, "personaimage", {"persona_id": new_id, "page": 0}),
                        ),
                    ]]),
                )
            elif action == "generate":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "generate")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._start_generation_setup(query, types)
            elif action == "gagain" and len(parts) > 2:
                persona_id = str(resolve_callback_token(chat_id, "gagain", parts[2]).get("persona_id") or "")
                if not persona_id:
                    raise HTTPException(status_code=410, detail="生成人设入口已失效，请重新选择")
                save_state(chat_id, selected_persona_id=persona_id)
                await self._start_generation_setup(query, types)
            elif action == "postsmenu":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    await self._persona_list(query, types, member, 0)
                    return
                rows = [[
                    types.InlineKeyboardButton(text="📝 查看草稿", callback_data="tt:drafts:0"),
                    types.InlineKeyboardButton(text="⭐ 查看收藏", callback_data="tt:favorites:0"),
                ], self._persona_module_back_row(types, chat_id, state["selected_persona_id"], "content")]
                await query.message.edit_text(
                    "推文内容",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "imageposts":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(
                    query,
                    types,
                    member,
                    source="posts",
                    page=int(parts[2]) if len(parts) > 2 else 0,
                    intro="推文配图 · 请选择要生成图片的草稿。\n点击条目后可逐项设置数量、比例、构图、风格和提示词。",
                    intent="image",
                )
            elif action == "personaimage":
                state = load_state(chat_id)
                persona_id = str((state["selected_persona_id"] or "")).strip()
                page = 0
                if len(parts) > 2:
                    reference = resolve_callback_token(chat_id, "personaimage", parts[2])
                    persona_id = str(reference.get("persona_id") or persona_id).strip()
                    page = int(reference.get("page") or 0)
                if not persona_id:
                    await self._persona_list(query, types, member, 0)
                    return
                await self._render_persona_image_options(
                    query, types, member, persona_id=persona_id, page=page,
                )
            elif action == "personaimmediate":
                state = load_state(chat_id)
                reference = resolve_callback_token(chat_id, "personaimmediate", parts[2], consume=True) if len(parts) > 2 else {}
                persona_id = str(reference.get("persona_id") or state["selected_persona_id"] or "").strip()
                if not persona_id:
                    raise HTTPException(status_code=409, detail="请先选择人设")
                options = state["payload"].get("persona_image_options") if isinstance(state.get("payload"), dict) and isinstance(state["payload"].get("persona_image_options"), dict) else {}
                result = await self._call(user_id, "persona_image.generate", {
                    "persona_id": persona_id,
                    "supplement_prompt": str(state["payload"].get("supplement_prompt") or "") if isinstance(state.get("payload"), dict) else "",
                    "persona_image_options": options,
                    "aspect_ratio": "1:1",
                    "mode": "person",
                })
                task_id = str(result.get("task_id") or result.get("id") or "")
                clear_pending_state(chat_id)
                rows = []
                if task_id:
                    rows.append([types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(
                    text="返回人设图库",
                    callback_data=callback_token(chat_id, "personaimage", {
                        "persona_id": persona_id, "page": max(0, int(reference.get("page") or 0)),
                    }),
                )])
                await query.message.edit_text(
                    f"人设图任务已提交：{task_id}\n后台会生成新的图库素材，完成后 Bot 会发送结果；也可先查看任务状态。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
                asyncio.create_task(self._watch_image_generation(
                    query.message.bot, chat_id, user_id, persona_id, task_id, types,
                    page=max(0, int(reference.get("page") or 0)),
                    persona_task=True,
                ))
            elif action == "pimgnoop":
                await query.answer("请使用下方按钮管理这张人设图")
            elif action == "pimgpage" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgpage", parts[2])
                await self._render_persona_image_options(
                    query, types, member,
                    persona_id=str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    page=int(reference.get("page") or 0),
                )
            elif action == "pimgfield" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgfield", parts[2])
                await self._render_persona_image_field(
                    query, types,
                    persona_id=str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    field=str(reference.get("field") or ""),
                    page=int(reference.get("page") or 0),
                )
            elif action == "pimgopt" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgopt", parts[2])
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                field = str(reference.get("field") or "")
                state = load_state(chat_id)
                state_options = state["payload"].get("persona_image_options") if isinstance(state.get("payload"), dict) else {}
                definition = _persona_image_option_definition(field, state_options if isinstance(state_options, dict) else {})
                if not definition or str(reference.get("value") or "") not in {key for key, _caption in definition[1]}:
                    raise HTTPException(status_code=400, detail="人设图选项无效")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                options = dict(payload.get("persona_image_options") if isinstance(payload.get("persona_image_options"), dict) else {})
                value = str(reference.get("value") or "")
                if value:
                    options[field] = value
                else:
                    options.pop(field, None)
                options = _reconcile_persona_image_options(options)
                payload.update({"persona_id": persona_id, "persona_image_options": options})
                save_state(chat_id, selected_persona_id=persona_id, mode="persona_image_options", payload=payload)
                await self._render_persona_image_options(
                    query, types, member,
                    persona_id=persona_id,
                    page=int(reference.get("page") or 0),
                )
            elif action == "pimgprompt" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgprompt", parts[2])
                state = load_state(chat_id)
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                payload["persona_id"] = str(reference.get("persona_id") or state["selected_persona_id"])
                payload["page"] = int(reference.get("page") or 0)
                save_state(chat_id, selected_persona_id=payload["persona_id"], mode="persona_image_prompt", payload=payload)
                await query.message.edit_text(
                    "请发送人设图补充提示词。\n"
                    "未填写的选项将继续沿用原有人设简介。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "personaimage", {
                            "persona_id": payload["persona_id"],
                            "page": payload["page"],
                        }),
                        back_text="返回人设图库",
                    ),
                )
            elif action == "pimgupload" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgupload", parts[2])
                prior_state = load_state(chat_id)
                prior_payload = prior_state["payload"] if isinstance(prior_state.get("payload"), dict) else {}
                persona_id = str(reference.get("persona_id") or prior_state["selected_persona_id"])
                save_state(chat_id, selected_persona_id=persona_id, mode="persona_image_upload", payload={
                    "persona_id": persona_id,
                    "page": int(reference.get("page") or 0),
                    "persona_image_options": dict(prior_payload.get("persona_image_options") or {}) if isinstance(prior_payload.get("persona_image_options"), dict) else {},
                    "supplement_prompt": str(prior_payload.get("supplement_prompt") or ""),
                })
                await query.message.edit_text(
                    "人设图库 · 上传自定义图\n"
                    "请发送一张图片；支持 JPG、PNG、WebP、GIF。上传后会保存到当前人设图库，可再设置为参考图或头像。\n"
                    "不会覆盖现有图片。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "personaimage", {
                            "persona_id": persona_id, "page": int(reference.get("page") or 0),
                        }),
                        back_text="返回人设图库",
                    ),
                )
            elif action == "pimgreplace" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgreplace", parts[2])
                prior_state = load_state(chat_id)
                prior_payload = prior_state["payload"] if isinstance(prior_state.get("payload"), dict) else {}
                persona_id = str(reference.get("persona_id") or prior_state["selected_persona_id"])
                save_state(chat_id, selected_persona_id=persona_id, mode="persona_image_upload", payload={
                    "persona_id": persona_id,
                    "replace_image_id": str(reference.get("image_id") or ""),
                    "page": int(reference.get("page") or 0),
                    "persona_image_options": dict(prior_payload.get("persona_image_options") or {}) if isinstance(prior_payload.get("persona_image_options"), dict) else {},
                    "supplement_prompt": str(prior_payload.get("supplement_prompt") or ""),
                })
                await query.message.edit_text(
                    "人设图库 · 替换图片\n"
                    "请发送用于替换的 JPG、PNG、WebP 或 GIF 图片；只替换当前选中的图库记录，其他图片和人设简介保持不变。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "personaimage", {
                            "persona_id": persona_id, "page": int(reference.get("page") or 0),
                        }),
                        back_text="返回人设图库",
                    ),
                )
            elif action == "pimgapply" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgapply", parts[2], consume=True)
                result = await self._call(user_id, "persona_image.apply", {
                    "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    "image_id": str(reference.get("image_id") or ""),
                })
                await self._render_persona_image_options(
                    query, types, member,
                    persona_id=str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    page=int(reference.get("page") or 0),
                    notice="已设为当前人设参考图。",
                )
            elif action == "pimgavatar" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgavatar", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"] or "")
                await self._call(user_id, "profile.update", {
                    "persona_id": persona_id,
                    "avatar": {
                        "image_id": str(reference.get("image_id") or ""),
                        "crop_x": 50,
                        "crop_y": 50,
                        "zoom": 1,
                    },
                })
                await self._render_persona_image_options(
                    query, types, member, persona_id=persona_id,
                    page=int(reference.get("page") or 0), notice="已设为人设头像。",
                )
            elif action == "pimgdeleteconfirm" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgdeleteconfirm", parts[2])
                await query.message.edit_text(
                    "确认删除这张人设图？如果它是当前参考图，系统会自动切换到最近的剩余图片。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="确认删除", callback_data=callback_token(chat_id, "pimgdelete", reference)),
                        types.InlineKeyboardButton(text="取消", callback_data=callback_token(chat_id, "personaimage", {
                            "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                            "page": int(reference.get("page") or 0),
                        })),
                    ]]),
                )
            elif action == "pimgdelete" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pimgdelete", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                await self._call(user_id, "persona_image.delete", {
                    "persona_id": persona_id,
                    "image_id": str(reference.get("image_id") or ""),
                })
                await self._render_persona_image_options(
                    query, types, member, persona_id=persona_id,
                    page=int(reference.get("page") or 0), notice="人设图已删除。",
                )
            elif action == "createmenu":
                # Keep the legacy callback as a strict alias of the current
                # module renderer.  Previously this branch duplicated the
                # menu markup and could drift from `pmod:create`.
                clear_pending_state(chat_id)
                await self._render_persona_module(query, types, member, "create")
            elif action == "persona_history":
                state = load_state(chat_id)
                persona_id = state["selected_persona_id"]
                if not persona_id:
                    await self._persona_list(query, types, member, 0)
                    return
                history_result = await self._call(user_id, "profile.history", {"persona_id": persona_id})
                history = history_result.get("publish_history") if isinstance(history_result, dict) else []
                history = [item for item in history if isinstance(item, dict)]
                history_from_archive = (
                    isinstance(history_result, dict)
                    and isinstance(history_result.get("publish_history"), list)
                )
                # Compatibility with a rolling restart/older dispatch layer:
                # the canonical archive history is preferred, but a task
                # projection still keeps already-published records reachable.
                if not history and not history_from_archive:
                    tasks = await self._call(user_id, "tasks.list", {"limit": 1000})
                    history = [
                        item for item in tasks
                        if str(item.get("_tg_task_kind") or "") == "social"
                        and str(item.get("persona_id") or item.get("archive_id") or "") == persona_id
                        and _task_status(item) in {"success", "succeeded", "completed", "published"}
                    ]
                requested_page = int(parts[2]) if len(parts) > 2 else 0
                total_pages = max(1, (len(history) + PAGE_SIZE - 1) // PAGE_SIZE)
                page = min(max(0, requested_page), total_pages - 1)
                start = page * PAGE_SIZE
                rows = []
                for item in history[start:start + PAGE_SIZE]:
                    history_id = str(item.get("id") or item.get("history_id") or "").strip()
                    if not history_id:
                        continue
                    label = str(item.get("status") or item.get("platform") or item.get("task_type") or "发布").strip()
                    callback_data = (
                        callback_token(chat_id, "phistory", {
                            "history_id": history_id,
                            "persona_id": persona_id,
                            "page": page,
                        })
                        if history_from_archive
                        else callback_token(chat_id, "t", {
                            "task_id": history_id,
                            "task_kind": "social",
                            "status_filter": "all",
                            "page": page,
                            "persona_id": persona_id,
                            "return_callback": f"tt:persona_history:{page}",
                        })
                    )
                    rows.append([types.InlineKeyboardButton(
                        text=f"{label[:12]} · {str(item.get('title') or item.get('content') or '发布记录')[:24]}",
                        callback_data=callback_data,
                    )])
                nav, page, total_pages = _pagination_rows(
                    types,
                    page=page,
                    total_items=len(history),
                    callback_for_page=lambda target: f"tt:persona_history:{target}",
                )
                rows.extend(nav)
                if history_from_archive:
                    rows.append([
                        types.InlineKeyboardButton(
                            text="🔄 自动识别已发布内容",
                            callback_data=callback_token(chat_id, "phrecognizeauto", {
                                "persona_id": persona_id,
                                "page": page,
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="➕ 手动录入链接",
                            callback_data=callback_token(chat_id, "phrecognize", {
                                "persona_id": persona_id,
                                "page": page,
                            }),
                        ),
                    ])
                rows.append(self._persona_module_back_row(types, chat_id, persona_id, "publish"))
                await query.message.edit_text(
                    (f"发布历史（{len(history)} 条）\n第 {page + 1}/{total_pages} 页"
                     if history else "发布历史\n暂无记录"),
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "phistory" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "phistory", parts[2])
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"] or "")
                history_page = max(0, int(reference.get("page") or 0))
                history_result = await self._call(user_id, "profile.history", {"persona_id": persona_id})
                history = history_result.get("publish_history") if isinstance(history_result, dict) else []
                history_id = str(reference.get("history_id") or "")
                record = next((item for item in history if isinstance(item, dict) and str(item.get("id") or "") == history_id), None)
                if not record:
                    raise HTTPException(status_code=404, detail="发布记录不存在")
                content = str(record.get("content") or record.get("caption") or record.get("text") or "").strip()
                rows = [[
                    types.InlineKeyboardButton(text="重新加入草稿", callback_data=callback_token(chat_id, "phrequeue", {
                        "persona_id": persona_id, "history_id": history_id, "page": history_page,
                    })),
                    types.InlineKeyboardButton(text="删除记录", callback_data=callback_token(chat_id, "phdelete", {
                        "persona_id": persona_id, "history_id": history_id, "page": history_page,
                    })),
                ], [types.InlineKeyboardButton(text="返回发布历史", callback_data=f"tt:persona_history:{history_page}")]]
                await query.message.edit_text(
                    f"发布记录\n\n平台：{record.get('platform') or '—'}\n账号：{record.get('account_username') or record.get('username') or '—'}\n"
                    f"时间：{record.get('published_at') or record.get('captured_at') or '—'}\n\n"
                    f"{content[:2200] or '该记录没有可显示正文。'}\n\n"
                    "可重新加入草稿继续编辑，也可以删除这条历史记录。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "phrequeue" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "phrequeue", parts[2], consume=True)
                result = await self._call(user_id, "profile.history.requeue", {
                    "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    "history_id": str(reference.get("history_id") or ""),
                })
                await query.message.edit_text(
                    "发布记录已重新加入草稿。\n"
                    "现在可以打开草稿继续编辑正文、添加媒体、生成配图或重新发布。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看草稿",
                            callback_data=f"tt:drafts:{max(0, int(reference.get('page') or 0))}",
                        ),
                        types.InlineKeyboardButton(
                            text="返回发布历史",
                            callback_data=f"tt:persona_history:{max(0, int(reference.get('page') or 0))}",
                        ),
                    ]]),
                )
            elif action == "phdelete" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "phdelete", parts[2], consume=True)
                await self._call(user_id, "profile.history.delete", {
                    "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    "history_id": str(reference.get("history_id") or ""),
                })
                await query.message.edit_text(
                    "发布记录已删除。\n历史记录已从当前列表移除，不会影响原平台内容。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回发布历史",
                            callback_data=f"tt:persona_history:{max(0, int(reference.get('page') or 0))}",
                        ),
                    ]]),
                )
            elif action == "phrecognizeauto" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "phrecognizeauto", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"] or "")
                result = await self._call(user_id, "profile.history.recognize", {
                    "persona_id": persona_id,
                    "auto": True,
                })
                added = int(result.get("added_count") or 0) if isinstance(result, dict) else 0
                updated = int(result.get("updated_count") or 0) if isinstance(result, dict) else 0
                await query.message.edit_text(
                    f"已完成发布历史识别：新增 {added} 条，更新 {updated} 条。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看发布历史",
                            callback_data=f"tt:persona_history:{max(0, int(reference.get('page') or 0))}",
                        ),
                    ]]),
                )
            elif action == "phrecognize" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "phrecognize", parts[2])
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"] or "")
                save_state(chat_id, selected_persona_id=persona_id, mode="history_recognize", payload={
                    "persona_id": persona_id,
                    "page": max(0, int(reference.get("page") or 0)),
                })
                await query.message.edit_text(
                    "请发送已发布帖子链接；如需补充正文，可发送：链接｜正文。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=f"tt:persona_history:{max(0, int(reference.get('page') or 0))}",
                        back_text="返回发布历史",
                    ),
                )
            elif action == "gcount" and len(parts) > 2:
                state = load_state(chat_id)
                if state["mode"] != "generate_count":
                    raise HTTPException(status_code=409, detail="生成步骤已失效，请重新开始")
                count = int(parts[2])
                if count not in {1, 3, 5}:
                    raise HTTPException(status_code=400, detail="生成数量无效")
                save_state(chat_id, mode="generate_words", payload={"count": count})
                rows = [[
                    types.InlineKeyboardButton(text="精简 80 字", callback_data="tt:gwords:80"),
                    types.InlineKeyboardButton(text="标准 120 字", callback_data="tt:gwords:120"),
                ], [
                    types.InlineKeyboardButton(text="长文 200 字", callback_data="tt:gwords:200"),
                ], [
                    types.InlineKeyboardButton(text="上一步", callback_data="tt:generate"),
                    types.InlineKeyboardButton(text="取消", callback_data="tt:menu"),
                ]]
                await query.message.edit_text(
                    f"AI 生成推文 · 第 2/3 步\n数量：{count} 篇\n"
                    "请选择每篇目标字数；这只控制生成篇幅，之后仍可返回修改其他参数。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "gwords" and len(parts) > 2:
                state = load_state(chat_id)
                if state["mode"] != "generate_words":
                    raise HTTPException(status_code=409, detail="生成步骤已失效，请重新开始")
                target_words = int(parts[2])
                if target_words not in {80, 120, 200}:
                    raise HTTPException(status_code=400, detail="目标字数无效")
                save_state(
                    chat_id,
                    mode="generate_prompt",
                    payload={"count": int(state["payload"].get("count") or 3), "target_words": target_words},
                )
                await query.message.edit_text(
                    "AI 生成推文 · 第 3/3 步\n"
                    f"数量：{int(state['payload'].get('count') or 3)} 篇 · 每篇约 {target_words} 字\n"
                    "请发送本次主题或写作要求。\n"
                    "人设简介仍会作为基础上下文；收到后会先显示确认页，不会立即提交。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:generate", back_text="重新选择生成参数",
                    ),
                )
            elif action in {"gplatform", "glocale", "gslot"} and len(parts) > 2:
                resolve_callback_token(chat_id, action, parts[2])
                state = load_state(chat_id)
                if state["mode"] != "generate_confirm":
                    raise HTTPException(status_code=409, detail="生成确认已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                if action == "gplatform":
                    save_state(chat_id, mode="generate_platform", payload=payload)
                    rows = [[types.InlineKeyboardButton(
                        text=("✅ " if str(payload.get("platform") or "threads") == value else "") + label,
                        callback_data=callback_token(chat_id, "gplatformpick", {"platform": value}),
                    )] for value, label in PERSONA_CONTENT_PLATFORMS]
                    rows.append([types.InlineKeyboardButton(text="返回生成确认", callback_data=callback_token(chat_id, "gplatformback", {}))])
                    await query.message.edit_text(
                        "AI 生成推文 · 选择目标平台\n"
                        "平台会影响语气、互动方式和生成链路；这里只选择内容目标，不会执行发布。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
                elif action == "glocale":
                    save_state(chat_id, mode="generate_locale", payload=payload)
                    locale_rows = []
                    for index in range(0, len(PERSONA_WRITING_LOCALES), 2):
                        locale_rows.append([
                            types.InlineKeyboardButton(
                                text=("✅ " if str(payload.get("writing_locale") or "zh-TW") == value else "") + label,
                                callback_data=callback_token(chat_id, "glocalepick", {"locale": value}),
                            )
                            for value, label in PERSONA_WRITING_LOCALES[index:index + 2]
                        ])
                    locale_rows.append([types.InlineKeyboardButton(text="返回生成确认", callback_data=callback_token(chat_id, "glocaleback", {}))])
                    await query.message.edit_text(
                        "AI 生成推文 · 选择语言与地区口吻\n"
                        "生成内容会统一使用所选语言；未修改的人设资料和其他参数会继续保留。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=locale_rows),
                    )
                else:
                    save_state(chat_id, mode="generate_slot", payload=payload)
                    rows = [[types.InlineKeyboardButton(
                        text=("✅ " if str(payload.get("content_time_slot") or "") == value else "") + label,
                        callback_data=callback_token(chat_id, "gslotpick", {"slot": value}),
                    )] for value, label in PERSONA_CONTENT_TIME_SLOTS]
                    rows.append([types.InlineKeyboardButton(text="返回生成确认", callback_data=callback_token(chat_id, "gslotback", {}))])
                    await query.message.edit_text(
                        "AI 生成推文 · 选择文案时段\n"
                        "时段只作为内容语境提示，当前支持早上、晚上或不指定；不会改变发布时间。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
            elif action in {"gplatformpick", "glocalepick", "gslotpick"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                state = load_state(chat_id)
                expected_mode = {
                    "gplatformpick": "generate_platform",
                    "glocalepick": "generate_locale",
                    "gslotpick": "generate_slot",
                }[action]
                if state["mode"] != expected_mode:
                    raise HTTPException(status_code=409, detail="生成选项已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                if action == "gplatformpick":
                    platform = str(reference.get("platform") or "").strip().lower()
                    if platform not in dict(PERSONA_CONTENT_PLATFORMS):
                        raise HTTPException(status_code=400, detail="目标平台无效")
                    payload["platform"] = platform
                elif action == "glocalepick":
                    locale = str(reference.get("locale") or "").strip()
                    if locale not in dict(PERSONA_WRITING_LOCALES):
                        raise HTTPException(status_code=400, detail="写作语言无效")
                    payload["writing_locale"] = locale
                else:
                    slot = str(reference.get("slot") or "").strip().lower()
                    if slot not in dict(PERSONA_CONTENT_TIME_SLOTS):
                        raise HTTPException(status_code=400, detail="文案时段无效")
                    payload["content_time_slot"] = slot
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(query, types, payload=payload, notice="生成参数已更新。")
            elif action in {"gplatformback", "glocaleback", "gslotback"} and len(parts) > 2:
                resolve_callback_token(chat_id, action, parts[2])
                state = load_state(chat_id)
                if state["mode"] not in {"generate_platform", "generate_locale", "generate_slot"}:
                    raise HTTPException(status_code=409, detail="生成选项已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(query, types, payload=payload)
            elif action == "gdir" and len(parts) > 2:
                state = load_state(chat_id)
                # The direction picker keeps its own transient mode while it
                # is open.  Allow the same callback to request another batch
                # from that view; rejecting it here made the visible
                # “换一批” button a dead end after the first render.
                if state["mode"] not in {"generate_confirm", "generate_directions"}:
                    raise HTTPException(status_code=409, detail="生成确认已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                previous = payload.get("direction_options") if isinstance(payload.get("direction_options"), list) else []
                reference = resolve_callback_token(chat_id, "gdir", parts[2])
                refresh = bool(reference.get("refresh"))
                result = await self._call(user_id, "post_directions", {
                    "persona_id": state["selected_persona_id"],
                    "input_content": str(payload.get("prompt") or ""),
                    "platform": str(payload.get("platform") or "threads"),
                    "writing_locale": str(payload.get("writing_locale") or "zh-TW"),
                    "previous_keywords": previous if refresh else [],
                    # A refresh is a new billable suggestion request.  The
                    # opaque callback token makes each visible button unique
                    # while retaining idempotency for Telegram retries of the
                    # same click.
                    "idempotency_key": f"tg:directions:{chat_id}:{int(query.message.message_id)}:{parts[2]}",
                })
                keywords = result.get("keywords") if isinstance(result, dict) else []
                payload["direction_options"] = [str(item or "").strip() for item in keywords if str(item or "").strip()][:10]
                payload["selected_directions"] = []
                save_state(chat_id, mode="generate_directions", payload=payload)
                await self._render_generation_directions(query, types, notice="推文方向已生成")
            elif action == "gdirpick" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "gdirpick", parts[2])
                state = load_state(chat_id)
                if state["mode"] != "generate_directions":
                    raise HTTPException(status_code=409, detail="方向选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                direction = str(reference.get("direction") or "").strip()
                options = {str(item or "").strip() for item in (payload.get("direction_options") or []) if str(item or "").strip()}
                if direction not in options:
                    raise HTTPException(status_code=400, detail="方向选项无效")
                selected = [str(item or "").strip() for item in (payload.get("selected_directions") or []) if str(item or "").strip()]
                if direction in selected:
                    selected = [item for item in selected if item != direction]
                elif len(selected) < 5:
                    selected.append(direction)
                payload["selected_directions"] = selected
                save_state(chat_id, mode="generate_directions", payload=payload)
                await self._render_generation_directions(query, types)
            elif action == "gdirconfirm" and len(parts) > 2:
                resolve_callback_token(chat_id, "gdirconfirm", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "generate_directions":
                    raise HTTPException(status_code=409, detail="方向选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                if not payload.get("selected_directions"):
                    raise HTTPException(status_code=400, detail="请至少选择一个方向，或点击“不使用方向”")
                payload["selection_required"] = True
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(
                    query, types, payload=payload, notice="方向已选择，可返回确认页提交生成。",
                )
            elif action == "gdirclear" and len(parts) > 2:
                resolve_callback_token(chat_id, "gdirclear", parts[2], consume=True)
                state = load_state(chat_id)
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                payload["selected_directions"] = []
                payload["selection_required"] = False
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(
                    query,
                    types,
                    payload=payload,
                    notice="已选择不使用推文方向；其他人设上下文仍会保留。",
                )
            elif action == "gdirback" and len(parts) > 2:
                state = load_state(chat_id)
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(query, types, payload=payload)
            elif action == "gmem" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "gmem", parts[2])
                await self._render_generation_memories(
                    query, types, page=int(reference.get("page") or 0),
                )
            elif action == "gmempick" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "gmempick", parts[2])
                state = load_state(chat_id)
                if state["mode"] != "generate_memories":
                    raise HTTPException(status_code=409, detail="记忆选择已失效，请重新开始")
                persona_id = str(state["selected_persona_id"] or "").strip()
                memories_result = await self._call(user_id, "profile.memories", {"persona_id": persona_id})
                memories = memories_result.get("memories") if isinstance(memories_result, dict) else []
                available = {
                    str(item.get("id") or "").strip(): str(item.get("summary") or "").strip()
                    for item in memories if isinstance(item, dict) and str(item.get("id") or "").strip()
                }
                memory_id = str(reference.get("memory_id") or "").strip()
                if memory_id not in available:
                    raise HTTPException(status_code=404, detail="该人设记忆已不存在")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                selected = [
                    str(item or "").strip()
                    for item in (payload.get("selected_memory_ids") or [])
                    if str(item or "").strip() in available
                ]
                if memory_id in selected:
                    selected.remove(memory_id)
                elif len(selected) < 8:
                    selected.append(memory_id)
                else:
                    raise HTTPException(status_code=400, detail="最多选择 8 条人设记忆")
                payload["selected_memory_ids"] = selected
                payload["selected_memory_summaries"] = [available[item] for item in selected if available[item]]
                save_state(chat_id, mode="generate_memories", payload=payload)
                await self._render_generation_memories(
                    query, types, page=int(reference.get("page") or 0),
                )
            elif action == "gmemconfirm" and len(parts) > 2:
                resolve_callback_token(chat_id, "gmemconfirm", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "generate_memories":
                    raise HTTPException(status_code=409, detail="记忆选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(
                    query,
                    types,
                    payload=payload,
                    notice=f"已选择 {len(payload.get('selected_memory_ids') or [])} 条人设记忆。",
                )
            elif action == "gmemclear" and len(parts) > 2:
                resolve_callback_token(chat_id, "gmemclear", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "generate_memories":
                    raise HTTPException(status_code=409, detail="记忆选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                payload["selected_memory_ids"] = []
                payload["selected_memory_summaries"] = []
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(
                    query, types, payload=payload, notice="已清空本次生成的人设记忆选择。",
                )
            elif action == "gmemback" and len(parts) > 2:
                resolve_callback_token(chat_id, "gmemback", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "generate_memories":
                    raise HTTPException(status_code=409, detail="记忆选择已失效，请重新开始")
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                save_state(chat_id, mode="generate_confirm", payload=payload)
                await self._render_generation_confirmation(query, types, payload=payload)
            elif action == "gresolve" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "gresolve", parts[2], consume=True)
                selected_persona_id = str(load_state(chat_id)["selected_persona_id"] or "")
                await self._call(user_id, "generation.resolve", {
                    "persona_id": selected_persona_id,
                    "task_id": str(reference.get("task_id") or ""),
                    "selected_post_id": str(reference.get("post_id") or ""),
                    "title": str(reference.get("title") or ""),
                })
                await query.message.edit_text(
                    "已保留所选推文候选，其他候选已清理。\n现在可以在草稿列表中编辑、配图或发布。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="查看生成草稿", callback_data=callback_token(chat_id, "gendrafts", {
                            "persona_id": selected_persona_id,
                        })),
                        types.InlineKeyboardButton(text="查看任务", callback_data=callback_token(chat_id, "t", {
                            "task_id": str(reference.get("task_id") or ""), "task_kind": "normal", "status_filter": "completed",
                        })),
                    ]]),
                )
            elif action == "gsubmit" and len(parts) > 2:
                resolve_callback_token(chat_id, "gsubmit", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "generate_confirm":
                    raise HTTPException(status_code=409, detail="生成确认已失效，请重新开始")
                payload = state["payload"]
                try:
                    result = await self._call(user_id, "generation.start", {
                        "persona_id": state["selected_persona_id"],
                        "prompt": str(payload.get("prompt") or ""),
                        "count": int(payload.get("count") or 3),
                        "target_words": int(payload.get("target_words") or 120),
                        "platform": str(payload.get("platform") or "threads"),
                        "content_time_slot": str(payload.get("content_time_slot") or ""),
                        "writing_locale": str(payload.get("writing_locale") or "zh-TW"),
                        "selected_memory_ids": payload.get("selected_memory_ids") if isinstance(payload.get("selected_memory_ids"), list) else [],
                        "selected_memory_summaries": payload.get("selected_memory_summaries") if isinstance(payload.get("selected_memory_summaries"), list) else [],
                        "selected_directions": payload.get("selected_directions") if isinstance(payload.get("selected_directions"), list) else [],
                        "selection_required": bool(payload.get("selection_required")),
                        "rewrite_source_post_id": str(payload.get("rewrite_source_post_id") or ""),
                        "rewrite_source_title": str(payload.get("rewrite_source_title") or ""),
                        "rewrite_source_content": str(payload.get("rewrite_source_content") or ""),
                        "idempotency_key": f"tg:{chat_id}:{int(query.message.message_id)}",
                    })
                except Exception as exc:
                    await query.message.edit_text(
                        f"生成任务提交失败：{_error_text(exc)}\n参数仍已保留，可重试或修改。"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重试提交",
                                callback_data=callback_token(chat_id, "gsubmit", {}),
                            ),
                            types.InlineKeyboardButton(text="修改参数", callback_data="tt:generate"),
                        ]]),
                    )
                    raise
                task_id = str(result.get("task_id") or "")
                save_state(chat_id, mode="", payload={"last_task_id": task_id})
                audit_action(chat_id, user_id, "generation.start", status="success", resource_type="task", resource_id=task_id)
                await query.message.edit_text(
                    f"生成任务已提交：{task_id}\n"
                    "后台会按确认页中的数量、平台、语言、时段、方向和人设记忆生成草稿。\n"
                    "完成后 Bot 会返回结果；也可以先在排程状态查看进度。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="查看任务", callback_data="tt:tasks:0:active"),
                    ]]),
                )
                asyncio.create_task(self._watch_generation(
                    query.message.bot, chat_id, user_id, state["selected_persona_id"], task_id, types,
                ))
            elif action == "drafts":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "drafts")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(query, types, member, source="posts", page=int(parts[2]) if len(parts) > 2 else 0)
            elif action == "favorites":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "favorites")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(query, types, member, source="favorites", page=int(parts[2]) if len(parts) > 2 else 0)
            elif action == "publish_one":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "publish_one")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(
                    query, types, member, source="posts", page=0,
                    intro="单篇发布 · 请选择要发布的草稿。",
                    intent="publish",
                )
            elif action == "publishposts":
                await self._post_list(
                    query, types, member, source="posts",
                    page=int(parts[2]) if len(parts) > 2 else 0,
                    intro="单篇发布 · 请选择要发布的草稿。",
                    intent="publish",
                )
            elif action == "image" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "image", parts[2])
                reference_persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if reference_persona_id:
                    save_state(chat_id, selected_persona_id=reference_persona_id)
                await self._render_image_options(
                    query,
                    types,
                    member,
                    persona_id=reference_persona_id,
                    post_id=str(reference.get("post_id") or ""),
                    source=str(reference.get("source") or "posts"),
                    page=int(reference.get("page") or 0),
                )
            elif action == "imgopt" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "imgopt", parts[2])
                field = str(reference.get("field") or "").strip()
                if field not in {"image_count", "aspect_ratio", "image_mode", "image_render_style", "image_composition_label"}:
                    raise HTTPException(status_code=400, detail="配图选项无效")
                state = load_state(chat_id)
                payload = dict(state["payload"])
                value = reference.get("value")
                if field == "image_count":
                    value = min(max(int(value or 1), 1), 4)
                payload[field] = value
                if field == "image_composition_label":
                    composition_mode = str(reference.get("composition_mode") or "").strip()
                    if composition_mode in {"auto", "person", "pov", "scene", "object", "third_person"}:
                        payload["image_mode"] = composition_mode
                save_state(chat_id, selected_persona_id=str(reference.get("persona_id") or state["selected_persona_id"]), mode="image_options", payload=payload)
                await self._render_image_options(
                    query, types, member,
                    persona_id=str(payload.get("persona_id") or state["selected_persona_id"]),
                    post_id=str(payload.get("post_id") or ""),
                    source=str(payload.get("source") or "posts"),
                    page=int(payload.get("page") or 0),
                )
            elif action == "imgstyles" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "imgstyles", parts[2])
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                post_id = str(reference.get("post_id") or "")
                # Keep the user informed while the remote style/composition
                # model is running; the options page is rendered again only
                # after the result arrives, so a callback never looks stuck.
                await query.message.answer("正在生成构图方向，请稍候；完成后会回到配图设置。")
                result = await self._call(user_id, "image.styles", {
                    "persona_id": persona_id,
                    "post_id": post_id,
                    "previous_image_styles": [str(item.get("label") if isinstance(item, dict) else item) for item in (reference.get("image_styles") or []) if str(item.get("label") if isinstance(item, dict) else item)],
                    # The button can be double-clicked while the model request
                    # is in flight.  Scope the key to this callback instance;
                    # a freshly rendered options page gets a fresh token and
                    # can intentionally request another batch.
                    "idempotency_key": f"tg:image-styles:{chat_id}:{parts[2]}",
                })
                payload = dict(reference)
                payload.pop("field", None)
                payload.pop("value", None)
                payload["image_styles"] = result.get("image_styles") if isinstance(result, dict) else []
                save_state(chat_id, selected_persona_id=persona_id, mode="image_options", payload=payload)
                await self._render_image_options(
                    query, types, member, persona_id=persona_id, post_id=post_id,
                    source=str(payload.get("source") or "posts"), page=int(payload.get("page") or 0),
                    notice="构图方向已生成，可点击标签选择",
                )
            elif action == "imgprompt" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "imgprompt", parts[2])
                save_state(chat_id, selected_persona_id=str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]), mode="image_prompt", payload=reference)
                await query.message.edit_text(
                    "推文配图 · 补充提示词\n"
                    "请发送本次图片的局部要求，例如人物动作、镜头距离、背景物件或需要避免的元素。\n"
                    "提示词只追加到当前配图任务，不会修改推文正文或人设简介。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "image", {
                            "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                            "post_id": str(reference.get("post_id") or ""),
                            "source": str(reference.get("source") or "posts"),
                            "page": max(0, int(reference.get("page") or 0)),
                            "intent": "image",
                        }),
                        back_text="返回配图设置",
                    ),
                )
            elif action == "imggenerate" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "imggenerate", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                result = await self._call(user_id, "image.generate", {
                    "persona_id": persona_id,
                    "post_id": str(reference.get("post_id") or ""),
                    "source": str(reference.get("source") or "posts"),
                    "image_count": int(reference.get("image_count") or 1),
                    "aspect_ratio": str(reference.get("aspect_ratio") or "auto"),
                    "image_mode": str(reference.get("image_mode") or "auto"),
                    "image_render_style": str(reference.get("image_render_style") or "original"),
                    "image_composition_label": str(reference.get("image_composition_label") or ""),
                    "prompt": str(reference.get("custom_prompt") or ""),
                })
                task_id = str(result.get("task_id") or result.get("id") or "")
                clear_pending_state(chat_id)
                rows = []
                if task_id:
                    rows.append([types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(
                    text="返回推文详情",
                    callback_data=callback_token(chat_id, "d", {
                        "persona_id": persona_id,
                        "post_id": str(reference.get("post_id") or ""),
                        "source": str(reference.get("source") or "posts"),
                        "page": int(reference.get("page") or 0),
                        "intent": str(reference.get("intent") or "image"),
                    }),
                )])
                await query.message.edit_text(
                    f"推文配图任务已提交：{task_id}\n后台会生成图片预览；完成后可添加到当前推文，也可先查看任务状态。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
                asyncio.create_task(self._watch_image_generation(
                    query.message.bot,
                    chat_id,
                    user_id,
                    persona_id,
                    task_id,
                    types,
                    post_id=str(reference.get("post_id") or ""),
                    source=str(reference.get("source") or "posts"),
                    page=int(reference.get("page") or 0),
                    intent=str(reference.get("intent") or "image"),
                ))
            elif action == "imgattach" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "imgattach", parts[2], consume=True)
                result = await self._call(user_id, "image.attach", {
                    "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                    "post_id": str(reference.get("post_id") or ""),
                    "task_id": str(reference.get("task_id") or ""),
                    "replace_existing": bool(reference.get("replace_existing")),
                    "media_indexes": reference.get("media_indexes") if isinstance(reference.get("media_indexes"), list) else [],
                })
                await query.message.edit_text(
                    "已将生成图片添加到推文媒体。\n"
                    "当前推文已保留原正文；可以返回详情继续编辑、替换媒体或进入立即/定时发布。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[types.InlineKeyboardButton(
                        text="查看推文详情",
                        callback_data=callback_token(chat_id, "d", {
                            "persona_id": str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"]),
                            "post_id": str(reference.get("post_id") or ""),
                            "source": str(reference.get("source") or "posts"),
                            "page": max(0, int(reference.get("page") or 0)),
                            "intent": str(reference.get("intent") or "image"),
                        }),
                    )]]),
                )
            elif action in {"d", "f"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                reference_persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                # Returning from an input step must leave that step before
                # rendering the detail page; otherwise the next free-form
                # message can be consumed by a stale draft/media state.
                clear_pending_state(chat_id)
                if reference_persona_id:
                    save_state(chat_id, selected_persona_id=reference_persona_id)
                # The image-focused list uses the same compact post buttons as
                # drafts/favorites.  Preserve its intent when the user taps a
                # post, otherwise the click would drop into the generic detail
                # view and hide the image controls behind an extra step.
                if str(reference.get("intent") or "") == "image":
                    await self._render_image_options(
                        query,
                        types,
                        member,
                        persona_id=reference_persona_id,
                        post_id=str(reference.get("post_id") or ""),
                        source=str(reference.get("source") or "posts"),
                        page=int(reference.get("page") or 0),
                    )
                else:
                    await self._post_detail(
                        query, types, member, str(reference.get("post_id") or ""),
                        str(reference.get("source") or "posts"),
                        page=int(reference.get("page") or 0),
                        intent=str(reference.get("intent") or ""),
                    )
            elif action == "gendrafts" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "gendrafts", parts[2])
                reference_persona_id = str(reference.get("persona_id") or "")
                if not reference_persona_id:
                    raise HTTPException(status_code=410, detail="生成结果入口已失效，请重新选择人设")
                save_state(chat_id, selected_persona_id=reference_persona_id)
                await self._post_list(query, types, member, source="posts", page=0)
            elif action == "draft_new":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "draft_new")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                save_state(chat_id, mode="draft_new", payload={})
                await query.message.edit_text(
                    "手工新建草稿 · 第 1 步\n"
                    "请发送草稿正文；内容会保存到当前人设，不会自动发布。\n"
                    "提交后可继续添加媒体、生成配图、收藏或发布。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:pmod:create", back_text="返回新建推文",
                    ),
                )
            elif action in {"edit", "media", "mediareplace", "mediadel", "pub", "sched", "delask"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                source, post_id = str(reference.get("source") or "posts"), str(reference.get("post_id") or "")
                reference_persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if reference_persona_id:
                    save_state(chat_id, selected_persona_id=reference_persona_id)
                if action == "edit":
                    save_state(chat_id, mode="draft_edit", payload={
                        "source": source,
                        "post_id": post_id,
                        "page": max(0, int(reference.get("page") or 0)),
                        "intent": str(reference.get("intent") or ""),
                    })
                    await query.message.edit_text(
                        "编辑推文正文\n"
                        "请发送新的完整正文；本次只替换文字，不会删除已有媒体或改变收藏状态。",
                        reply_markup=self._step_navigation_markup(
                            types,
                            back_callback=callback_token(chat_id, "d", {
                                "persona_id": reference_persona_id,
                                "post_id": post_id,
                                "source": source,
                                "page": max(0, int(reference.get("page") or 0)),
                                "intent": str(reference.get("intent") or ""),
                            }),
                            back_text="返回推文详情",
                        ),
                    )
                elif action == "media":
                    save_state(chat_id, mode="media_upload", payload={
                        "source": source,
                        "post_id": post_id,
                        "page": max(0, int(reference.get("page") or 0)),
                        "intent": str(reference.get("intent") or ""),
                    })
                    await query.message.edit_text(
                        "添加推文媒体\n"
                        "请发送图片、视频或文件；上传成功后可继续添加多个素材。\n"
                        "上传完成后点击下方“完成并返回详情”。",
                        reply_markup=self._step_navigation_markup(
                            types,
                            back_callback=callback_token(chat_id, "d", {
                                "persona_id": reference_persona_id,
                                "post_id": post_id,
                                "source": source,
                                "page": max(0, int(reference.get("page") or 0)),
                                "intent": str(reference.get("intent") or ""),
                            }),
                            back_text="返回推文详情",
                            primary_callback=callback_token(chat_id, "d", {
                                "persona_id": reference_persona_id,
                                "post_id": post_id,
                                "source": source,
                                "page": max(0, int(reference.get("page") or 0)),
                                "intent": str(reference.get("intent") or ""),
                            }),
                            primary_text="完成并返回详情",
                        ),
                    )
                elif action == "mediareplace":
                    save_state(chat_id, mode="media_replace", payload={
                        "source": source,
                        "post_id": post_id,
                        "replace_index": int(reference.get("index") or 0),
                        "page": max(0, int(reference.get("page") or 0)),
                        "intent": str(reference.get("intent") or ""),
                    })
                    await query.message.edit_text(
                        "替换推文媒体\n"
                        "请发送新的图片、视频或文件；只替换当前选中的媒体位置，其他素材保持不变。",
                        reply_markup=self._step_navigation_markup(
                            types,
                            back_callback=callback_token(chat_id, "d", {
                                "persona_id": reference_persona_id,
                                "post_id": post_id,
                                "source": source,
                                "page": max(0, int(reference.get("page") or 0)),
                                "intent": str(reference.get("intent") or ""),
                            }),
                            back_text="返回推文详情",
                        ),
                    )
                elif action == "mediadel":
                    await self._call(user_id, "media.delete", {
                        "persona_id": load_state(chat_id)["selected_persona_id"],
                        "source": source,
                        "post_id": post_id,
                        "index": int(reference.get("index") or 0),
                    })
                    audit_action(chat_id, user_id, "media.delete", status="success", resource_type=source, resource_id=post_id)
                    await self._post_detail(
                        query, types, member, post_id, source,
                        page=int(reference.get("page") or 0),
                        intent=str(reference.get("intent") or ""),
                        notice="媒体已移除。",
                    )
                elif action == "pub":
                    await self._publish_account_picker(
                        query, types, member, source=source, post_id=post_id, scheduled=False,
                        page=int(reference.get("page") or 0), intent=str(reference.get("intent") or ""),
                    )
                elif action == "sched":
                    await self._publish_account_picker(
                        query, types, member, source=source, post_id=post_id, scheduled=True,
                        page=int(reference.get("page") or 0), intent=str(reference.get("intent") or ""),
                    )
                else:
                    rows = [[
                        types.InlineKeyboardButton(text="确认删除", callback_data=callback_token(chat_id, "delok", {
                            "persona_id": reference_persona_id,
                            "source": source,
                            "post_id": post_id,
                            "page": max(0, int(reference.get("page") or 0)),
                            "intent": str(reference.get("intent") or ""),
                        })),
                        types.InlineKeyboardButton(
                            text="取消",
                            callback_data=(
                                "tt:imageposts:" + str(max(0, int(reference.get("page") or 0)))
                                if str(reference.get("intent") or "") == "image"
                                else (
                                    "tt:publishposts:" + str(max(0, int(reference.get("page") or 0)))
                                    if str(reference.get("intent") or "") == "publish"
                                    else f"tt:{'favorites' if source == 'favorites' else 'drafts'}:{max(0, int(reference.get('page') or 0))}"
                                )
                            ),
                        ),
                    ]]
                    await query.message.edit_text(
                        "删除推文确认\n"
                        "删除后正文、媒体和收藏关系都无法恢复；发布历史不会被回写。\n"
                        "请确认是否继续。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
            elif action == "favadd" and len(parts) > 2:
                state = load_state(chat_id)
                reference = resolve_callback_token(chat_id, "favadd", parts[2], consume=True)
                post_id = str(reference.get("post_id") or "")
                persona_id = str(reference.get("persona_id") or state["selected_persona_id"])
                result = await self._call(user_id, "posts.favorite", {"persona_id": persona_id, "post_id": post_id})
                favorite = result.get("post") if isinstance(result, dict) and isinstance(result.get("post"), dict) else {}
                favorite_id = str(favorite.get("id") or "")
                audit_action(chat_id, user_id, "favorite.add", status="success", resource_type="post", resource_id=post_id)
                rows = []
                if favorite_id:
                    rows.append([types.InlineKeyboardButton(
                        text="查看收藏副本",
                        callback_data=callback_token(chat_id, "f", {
                            "persona_id": persona_id, "post_id": favorite_id, "source": "favorites",
                            "page": max(0, int(reference.get("page") or 0)),
                            "intent": str(reference.get("intent") or ""),
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(
                    text="返回原草稿",
                    callback_data=callback_token(chat_id, "d", {
                        "persona_id": persona_id, "post_id": post_id, "source": "posts",
                        "page": max(0, int(reference.get("page") or 0)),
                        "intent": str(reference.get("intent") or ""),
                    }),
                )])
                await query.message.edit_text(
                    "已加入收藏。" if not bool(result.get("exists") if isinstance(result, dict) else False) else "该推文已在收藏中。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "pa" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pa", parts[2], consume=True)
                source = str(reference.get("source") or "posts")
                post_id = str(reference.get("post_id") or "")
                account_id = str(reference.get("account_id") or "")
                platform = str(reference.get("platform") or "threads").strip().lower()
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if bool(reference.get("scheduled")):
                    save_state(chat_id, mode="schedule_time", payload={
                        "persona_id": persona_id,
                        "source": source, "post_id": post_id, "account_id": account_id,
                        "platform": platform,
                        "page": max(0, int(reference.get("page") or 0)),
                        "intent": str(reference.get("intent") or ""),
                    })
                    await query.message.edit_text(
                        "定时发布 · 设置时间\n"
                        "请输入北京时间 YYYY-MM-DD HH:MM。时间仅决定发布计划，不会修改正文。\n"
                        "下一步会展示平台、账号、正文和计划时间供最终确认。",
                        reply_markup=self._step_navigation_markup(
                            types,
                            back_callback=callback_token(chat_id, "d", {
                                "persona_id": persona_id,
                                "post_id": post_id,
                                "source": source,
                                "page": max(0, int(reference.get("page") or 0)),
                                "intent": str(reference.get("intent") or "publish"),
                            }),
                            back_text="返回推文详情",
                        ),
                    )
                else:
                    rows = [[
                        types.InlineKeyboardButton(
                            text="确认发布",
                            callback_data=callback_token(chat_id, "pubok", {
                                "persona_id": persona_id,
                                "source": source, "post_id": post_id, "account_id": account_id,
                                "platform": platform,
                                "page": max(0, int(reference.get("page") or 0)),
                                "intent": str(reference.get("intent") or ""),
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="取消",
                            callback_data=(
                                "tt:imageposts:" + str(max(0, int(reference.get("page") or 0)))
                                if str(reference.get("intent") or "") == "image"
                                else (
                                    "tt:publishposts:" + str(max(0, int(reference.get("page") or 0)))
                                    if str(reference.get("intent") or "") == "publish"
                                    else f"tt:{'favorites' if source == 'favorites' else 'drafts'}:{max(0, int(reference.get('page') or 0))}"
                                )
                            ),
                        ),
                    ]]
                    await query.message.edit_text(
                        f"立即发布 · 最终确认\n"
                        f"平台：{platform.title()}\n"
                        "确认后会将当前正文和媒体提交到该平台发布队列；取消不会修改草稿。\n"
                        "提交时系统会再次校验授权账号状态。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
            elif action in {"pubok", "schedok", "delok"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                source, post_id = str(reference.get("source") or "posts"), str(reference.get("post_id") or "")
                state = load_state(chat_id)
                persona_id = str(reference.get("persona_id") or state["selected_persona_id"])
                if action == "delok":
                    await self._call(user_id, "posts.delete", {"persona_id": persona_id, "source": source, "post_id": post_id})
                    save_state(chat_id, selected_persona_id=persona_id)
                    audit_action(chat_id, user_id, "post.delete", status="success", resource_type=source, resource_id=post_id)
                    await self._post_list(
                        query, types, member, source=source,
                        page=int(reference.get("page") or 0),
                        intent=str(reference.get("intent") or ""),
                        intro="已删除。",
                    )
                else:
                    scheduled_at = max(0, int(reference.get("scheduled_at") or 0))
                    publish_request = {
                        "persona_id": persona_id,
                        "source": source,
                        "post_id": post_id,
                        "account_id": str(reference.get("account_id") or ""),
                        "platform": str(reference.get("platform") or "threads").strip().lower(),
                        "scheduled_at": scheduled_at,
                    }
                    try:
                        result = await self._call(user_id, "publish.start", publish_request)
                    except Exception as exc:
                        await query.message.edit_text(
                            f"发布提交失败：{_error_text(exc)}"[:3500],
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                                types.InlineKeyboardButton(
                                    text="重试提交",
                                    callback_data=callback_token(chat_id, action, {
                                        "source": source,
                                        "post_id": post_id,
                                        "persona_id": persona_id,
                                        "account_id": publish_request["account_id"],
                                        "platform": publish_request["platform"],
                                        "scheduled_at": scheduled_at,
                                        "page": max(0, int(reference.get("page") or 0)),
                                        "intent": str(reference.get("intent") or ""),
                                    }),
                                ),
                                types.InlineKeyboardButton(
                                    text="返回推文",
                                    callback_data=callback_token(chat_id, "d" if source == "posts" else "f", {
                                        "persona_id": persona_id, "source": source, "post_id": post_id,
                                        "page": max(0, int(reference.get("page") or 0)),
                                        "intent": str(reference.get("intent") or ""),
                                    }),
                                ),
                            ]]),
                        )
                        raise
                    task = result.get("task") if isinstance(result, dict) else {}
                    task_id = str((task or {}).get("id") or "")
                    audit_action(
                        chat_id, user_id,
                        "publish.schedule" if scheduled_at else "publish.enqueue",
                        status="success", resource_type=source, resource_id=post_id, detail=task_id,
                    )
                    rows = []
                    if task_id:
                        rows.append([types.InlineKeyboardButton(
                            text="查看发布任务",
                            callback_data=callback_token(chat_id, "t", {
                                "task_id": task_id, "task_kind": "social", "status_filter": "active",
                                "page": max(0, int(reference.get("page") or 0)),
                                "platform": str(reference.get("platform") or ""),
                                "persona_id": persona_id,
                            }),
                        )])
                    rows.append([types.InlineKeyboardButton(text="继续发布", callback_data="tt:publish_one")])
                    await query.message.edit_text(
                        (
                            f"定时发布已入队。\n任务：{task_id or '已创建'}\n"
                            "到达计划时间后由后台执行；可在排程状态查看进度或取消。"
                            if scheduled_at
                            else f"已进入发布队列。\n任务：{task_id or '已创建'}\n"
                            "后台会按所选平台账号执行；可在排程状态查看结果。"
                        ),
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
                    if task_id and not scheduled_at:
                        asyncio.create_task(self._watch_publish(query.message.bot, chat_id, user_id, task_id, types))
            elif action == "hot":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "hot")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._start_hot_input(query, types)
            elif action == "hotagain" and len(parts) > 2:
                persona_id = str(resolve_callback_token(chat_id, "hotagain", parts[2]).get("persona_id") or "")
                if not persona_id:
                    raise HTTPException(status_code=410, detail="热点人设入口已失效，请重新选择")
                save_state(chat_id, selected_persona_id=persona_id)
                await self._start_hot_input(query, types)
            elif action == "hotsubmit" and len(parts) > 2:
                resolve_callback_token(chat_id, "hotsubmit", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "hot_confirm":
                    raise HTTPException(status_code=409, detail="热点确认已失效，请重新开始")
                persona_id = state["selected_persona_id"]
                try:
                    result = await self._call(user_id, "hot.start", {
                        "persona_id": persona_id,
                        "prompt": str(state["payload"].get("prompt") or ""),
                    })
                except Exception as exc:
                    await query.message.edit_text(
                        f"热点任务提交失败：{_error_text(exc)}\n主题仍已保留，可重试或修改。"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重试提交",
                                callback_data=callback_token(chat_id, "hotsubmit", {}),
                            ),
                            types.InlineKeyboardButton(text="修改主题", callback_data="tt:hot"),
                        ]]),
                    )
                    raise
                task_id = str(result.get("task_id") or result.get("id") or "")
                if not task_id:
                    raise HTTPException(status_code=502, detail="热点任务未返回任务 ID")
                save_state(chat_id, mode="", payload={
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                audit_action(chat_id, user_id, "hot.start", status="success", resource_type="task", resource_id=task_id)
                rows = [[
                    types.InlineKeyboardButton(
                        text="查看状态",
                        callback_data=callback_token(chat_id, "hotstatus", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                    types.InlineKeyboardButton(
                        text="取消任务",
                        callback_data=callback_token(chat_id, "hotcancel", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                ]]
                await query.message.edit_text(
                    f"热点任务已提交：{task_id}\n"
                    "后台会结合当前人设整理可用热点候选；完成后只返回候选，不会自动发布。\n"
                    "你可以刷新状态、取消任务，或在完成后选择保存/改写。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
                asyncio.create_task(self._watch_hot(
                    query.message.bot, chat_id, user_id, persona_id, task_id, types,
                ))
            elif action in {"hotstatus", "hotcancel"} and len(parts) > 2:
                reference = resolve_callback_token(
                    chat_id, action, parts[2], consume=(action == "hotcancel"),
                )
                task_id = str(reference.get("task_id") or "")
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if action == "hotcancel":
                    result = await self._call(user_id, "hot.cancel", {
                        "persona_id": persona_id, "task_id": task_id,
                    })
                    clear_pending_state(chat_id)
                    audit_action(
                        chat_id, user_id, "hot.cancel", status="success",
                        resource_type="task", resource_id=task_id,
                    )
                    await query.message.edit_text(
                        (
                            "热点任务已取消。\n未生成的候选不会写入草稿，可以返回新建推文重新输入主题。"
                            if result.get("cancelled")
                            else "热点任务已结束或无需取消。\n请返回新建推文查看已有草稿或重新开始热点创作。"
                        ),
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重新开始热点创作",
                                callback_data=callback_token(chat_id, "hotagain", {"persona_id": persona_id}),
                            ),
                            types.InlineKeyboardButton(
                                text="返回新建推文",
                                callback_data="tt:pmod:create",
                            ),
                        ]]),
                    )
                else:
                    task = await self._call(user_id, "hot.status", {
                        "persona_id": persona_id, "task_id": task_id,
                    })
                    status = _task_status(task)
                    if status == "success":
                        candidates = task.get("candidates") or (task.get("result") or {}).get("candidates") or []
                        candidates = [item for item in candidates if isinstance(item, dict)][:5]
                        save_state(
                            chat_id, selected_persona_id=persona_id, mode="hot_select",
                            payload={"hot_candidates": candidates, "last_hot_task_id": task_id,
                                     "last_hot_persona_id": persona_id},
                        )
                        rows = []
                        for index, item in enumerate(candidates):
                            title = str(item.get("title") or item.get("content") or item.get("text") or f"候选 {index + 1}")[:28]
                            rows.append([
                                types.InlineKeyboardButton(
                                    text=f"保存 {index + 1}. {title}",
                                    callback_data=callback_token(chat_id, "hotpick", {
                                        "index": index, "task_id": task_id, "persona_id": persona_id,
                                    }),
                                ),
                                types.InlineKeyboardButton(
                                    text="✍️ 改写",
                                    callback_data=callback_token(chat_id, "hotrewrite", {
                                        "index": index, "task_id": task_id, "persona_id": persona_id,
                                    }),
                                ),
                            ])
                        rows.append([types.InlineKeyboardButton(
                            text="返回新建推文",
                            callback_data="tt:pmod:create",
                        )])
                        await query.message.edit_text(
                            ("热点候选已完成。选择一条保存为草稿，或先改写后再保存；不会自动发布。"
                             if candidates else "热点任务已完成，但没有可导入候选；可以返回新建推文修改主题后重试。"),
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                        )
                    elif status in {"preparing", "queued", "pending", "scheduled", "running", "publishing", "retrying"}:
                        rows = [[
                            types.InlineKeyboardButton(
                                text="刷新状态",
                                callback_data=callback_token(chat_id, "hotstatus", {
                                    "task_id": task_id, "persona_id": persona_id,
                                }),
                            ),
                            types.InlineKeyboardButton(
                                text="取消任务",
                                callback_data=callback_token(chat_id, "hotcancel", {
                                    "task_id": task_id, "persona_id": persona_id,
                                }),
                            ),
                        ]]
                        await query.message.edit_text(
                            f"热点任务进行中：{task_id}\n后台正在整理候选内容；可刷新状态或取消任务。",
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                        )
                    else:
                        await query.message.edit_text(
                            f"热点任务 {status}：{str(task.get('error') or '')[:1200]}",
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                                types.InlineKeyboardButton(
                                    text="修改主题重试",
                                    callback_data=callback_token(chat_id, "hotagain", {"persona_id": persona_id}),
                                ),
                                types.InlineKeyboardButton(
                                    text="返回新建推文",
                                    callback_data="tt:pmod:create",
                                ),
                            ]]),
                        )
            elif action == "hotrewrite" and len(parts) > 2:
                state = load_state(chat_id)
                candidates = state["payload"].get("hot_candidates") if isinstance(state["payload"].get("hot_candidates"), list) else []
                reference = resolve_callback_token(chat_id, "hotrewrite", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or "")
                task_id = str(reference.get("task_id") or "")
                if (
                    state["mode"] != "hot_select"
                    or not persona_id
                    or persona_id != state["selected_persona_id"]
                    or task_id != str(state["payload"].get("last_hot_task_id") or "")
                ):
                    raise HTTPException(status_code=410, detail="热点候选已失效，请重新开始")
                index = int(reference.get("index") or 0)
                if index < 0 or index >= len(candidates):
                    raise HTTPException(status_code=404, detail="热点候选已过期")
                candidate = candidates[index] if isinstance(candidates[index], dict) else {}
                source_content = str(candidate.get("content") or candidate.get("text") or candidate.get("body") or "").strip()
                if not source_content:
                    raise HTTPException(status_code=400, detail="该热点候选没有可改写正文")
                save_state(chat_id, selected_persona_id=persona_id, mode="hot_rewrite", payload={
                    "hot_candidates": candidates,
                    "hot_candidate_index": index,
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                await query.message.edit_text(
                    "请发送改写要求；例如：改成更生活化的语气、保留数字但换一个开头。\n"
                    "如果只按当前人设正常改写，请发送 /auto。\n\n"
                    f"当前候选：{source_content[:1800]}",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "hotlist", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                        back_text="返回候选列表",
                    ),
                )
            elif action == "hotlist" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "hotlist", parts[2])
                state = load_state(chat_id)
                persona_id = str(reference.get("persona_id") or state["selected_persona_id"] or "")
                task_id = str(reference.get("task_id") or state["payload"].get("last_hot_task_id") or "")
                candidates = state["payload"].get("hot_candidates") if isinstance(state["payload"].get("hot_candidates"), list) else []
                if state["mode"] != "hot_select" or not persona_id or persona_id != state["selected_persona_id"] or not task_id:
                    raise HTTPException(status_code=410, detail="热点候选已失效，请重新开始")
                rows = []
                for index, item in enumerate(candidates):
                    if not isinstance(item, dict):
                        continue
                    title = str(item.get("title") or item.get("content") or item.get("text") or f"候选 {index + 1}")[:28]
                    rows.append([
                        types.InlineKeyboardButton(
                            text=f"保存 {index + 1}. {title}",
                            callback_data=callback_token(chat_id, "hotpick", {
                                "index": index, "task_id": task_id, "persona_id": persona_id,
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="✍️ 改写",
                            callback_data=callback_token(chat_id, "hotrewrite", {
                                "index": index, "task_id": task_id, "persona_id": persona_id,
                            }),
                        ),
                    ])
                rows.append([types.InlineKeyboardButton(
                    text="返回新建推文",
                    callback_data="tt:pmod:create",
                )])
                await query.message.edit_text(
                    ("热点候选已完成，选择保存为草稿或先改写；保存后会回到草稿详情。"
                     if candidates else "热点任务已完成，但没有可用候选；请返回新建推文重新输入主题。"),
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "hotpick" and len(parts) > 2:
                state = load_state(chat_id)
                candidates = state["payload"].get("hot_candidates") if isinstance(state["payload"].get("hot_candidates"), list) else []
                reference = resolve_callback_token(chat_id, "hotpick", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or "")
                task_id = str(reference.get("task_id") or "")
                if (
                    state["mode"] != "hot_select"
                    or not persona_id
                    or persona_id != state["selected_persona_id"]
                    or task_id != str(state["payload"].get("last_hot_task_id") or "")
                ):
                    raise HTTPException(status_code=410, detail="热点候选已失效，请重新开始")
                index = int(reference.get("index") or 0)
                if index < 0 or index >= len(candidates):
                    raise HTTPException(status_code=404, detail="热点候选已过期")
                result = await self._call(user_id, "hot.import", {"persona_id": persona_id, "candidates": [candidates[index]]})
                posts = result.get("posts") if isinstance(result, dict) and isinstance(result.get("posts"), list) else []
                imported_post_id = str((posts[0] if posts else {}).get("id") or "")
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "hot.import", status="success", resource_type="persona", resource_id=persona_id)
                rows = []
                if imported_post_id:
                    rows.append([types.InlineKeyboardButton(
                        text="查看此草稿",
                        callback_data=callback_token(chat_id, "d", {
                            "persona_id": persona_id, "post_id": imported_post_id, "source": "posts",
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(text="查看全部草稿", callback_data="tt:drafts:0")])
                await query.message.edit_text(
                    "热点内容已保存为草稿。\n"
                    "候选已转为当前人设的可编辑草稿，不会自动发布；可查看详情继续改写、配图或提交发布。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "matrix":
                save_state(chat_id, mode="matrix_select", payload={"matrix_persona_ids": []})
                await self._matrix_picker(query, types, member, 0)
            elif action == "matrixpage" and len(parts) > 2:
                if load_state(chat_id)["mode"] != "matrix_select":
                    raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
                await self._matrix_picker(query, types, member, int(parts[2]))
            elif action == "mx" and len(parts) > 2:
                state = load_state(chat_id)
                if state["mode"] != "matrix_select":
                    raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
                reference = resolve_callback_token(chat_id, "mx", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or "")
                selected = {
                    str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)
                }
                if persona_id in selected:
                    selected.remove(persona_id)
                elif persona_id:
                    selected.add(persona_id)
                save_state(chat_id, mode="matrix_select", payload={
                    "matrix_persona_ids": sorted(selected),
                    "matrix_page": max(0, int(reference.get("page") or 0)),
                })
                await self._matrix_picker(query, types, member, int(reference.get("page") or 0))
            elif action == "matrixnext":
                state = load_state(chat_id)
                if state["mode"] != "matrix_select":
                    raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if not persona_ids:
                    await query.answer("请至少选择一个人设", show_alert=True)
                    return
                save_state(chat_id, mode="matrix_source", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_page": max(0, int(state["payload"].get("matrix_page") or 0)),
                })
                await self._matrix_source_picker(query, types)
            elif action == "matrixback":
                state = load_state(chat_id)
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if state["mode"] != "matrix_source" or not persona_ids:
                    raise HTTPException(status_code=409, detail="矩阵来源选择已失效，请重新开始")
                matrix_page = max(0, int(state["payload"].get("matrix_page") or 0))
                save_state(chat_id, mode="matrix_select", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_page": matrix_page,
                })
                await self._matrix_picker(query, types, member, matrix_page)
            elif action == "mxsource" and len(parts) > 2:
                state = load_state(chat_id)
                source = str(parts[2] or "").strip().lower()
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if state["mode"] != "matrix_source" or source not in {"posts", "favorites"} or not persona_ids:
                    raise HTTPException(status_code=409, detail="矩阵来源选择已失效，请重新开始")
                personas = await self._call(user_id, "personas.list")
                count_key = "favorites" if source == "favorites" else "posts"
                ready_ids = {
                    str(item.get("id") or "")
                    for item in personas
                    if str(item.get("id") or "") in persona_ids
                    and int((item.get("counts") or {}).get(count_key) or 0) > 0
                }
                if not ready_ids:
                    raise HTTPException(
                        status_code=409,
                        detail=f"所选人设都没有可发布的{'收藏' if source == 'favorites' else '草稿'}，请返回重新选择",
                    )
                save_state(chat_id, mode="matrix_platform", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_source": source,
                    "matrix_source_ready_count": len(ready_ids),
                    "matrix_page": max(0, int(state["payload"].get("matrix_page") or 0)),
                })
                await self._matrix_platform_picker(query, types, member)
            elif action == "mxbacksource":
                state = load_state(chat_id)
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if state["mode"] != "matrix_platform" or not persona_ids:
                    raise HTTPException(status_code=409, detail="矩阵平台选择已失效，请重新开始")
                save_state(chat_id, mode="matrix_source", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_page": max(0, int(state["payload"].get("matrix_page") or 0)),
                })
                await self._matrix_source_picker(query, types)
            elif action == "mxplatform" and len(parts) > 2:
                state = load_state(chat_id)
                platform = str(parts[2] or "").strip().lower()
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                source = str(state["payload"].get("matrix_source") or "")
                if (
                    state["mode"] != "matrix_platform"
                    or platform not in {"threads", "instagram"}
                    or source not in {"posts", "favorites"}
                    or not persona_ids
                ):
                    raise HTTPException(status_code=409, detail="矩阵平台选择已失效，请重新开始")
                source_ready_count = int(state["payload"].get("matrix_source_ready_count") or len(persona_ids))
                source_skipped_count = max(0, len(persona_ids) - source_ready_count)
                save_state(chat_id, mode="matrix_confirm", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_source": source,
                    "matrix_platform": platform,
                    "matrix_source_ready_count": source_ready_count,
                    "matrix_page": max(0, int(state["payload"].get("matrix_page") or 0)),
                })
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认矩阵发布",
                        callback_data=callback_token(chat_id, "matrixok", {
                            "persona_ids": persona_ids,
                            "source": source,
                            "platform": platform,
                            "per_persona_count": 1,
                        }),
                    ),
                    types.InlineKeyboardButton(text="上一步", callback_data="tt:mxbackplatform"),
                ]]
                confirmation_text = (
                    "矩阵发布 · 第 4/4 步\n"
                    f"人设：{len(persona_ids)} 个\n"
                    f"来源：{'收藏' if source == 'favorites' else '草稿'}\n"
                    f"平台：{platform.title()}\n"
                    "数量：每个人设 1 篇\n\n确认后才会提交发布队列。"
                )
                if source_skipped_count:
                    confirmation_text += f"\n其中 {source_skipped_count} 个人设无该来源内容，将自动跳过。"
                confirmation_text += "\n请核对以上范围；提交后可在“排程状态”查看每个人设对应任务。"
                await query.message.edit_text(
                    confirmation_text,
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "mxbackplatform":
                state = load_state(chat_id)
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                source = str(state["payload"].get("matrix_source") or "")
                if state["mode"] != "matrix_confirm" or not persona_ids or source not in {"posts", "favorites"}:
                    raise HTTPException(status_code=409, detail="矩阵确认已失效，请重新开始")
                save_state(chat_id, mode="matrix_platform", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_source": source,
                    "matrix_source_ready_count": int(state["payload"].get("matrix_source_ready_count") or len(persona_ids)),
                    "matrix_page": max(0, int(state["payload"].get("matrix_page") or 0)),
                })
                await self._matrix_platform_picker(query, types, member)
            elif action == "matrixok" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "matrixok", parts[2], consume=True)
                persona_ids = reference.get("persona_ids") if isinstance(reference.get("persona_ids"), list) else []
                source = str(reference.get("source") or "posts").strip().lower()
                platform = str(reference.get("platform") or "threads").strip().lower()
                per_persona_count = max(1, int(reference.get("per_persona_count") or 1))
                try:
                    result = await self._call(user_id, "publish.matrix", {
                        "persona_ids": persona_ids,
                        "source": source,
                        "platform": platform,
                        "per_persona_count": per_persona_count,
                    })
                except Exception as exc:
                    save_state(chat_id, mode="matrix_confirm", payload={
                        "matrix_persona_ids": persona_ids,
                        "matrix_source": source,
                        "matrix_platform": platform,
                        "matrix_source_ready_count": len(persona_ids),
                        "matrix_page": max(0, int(load_state(chat_id)["payload"].get("matrix_page") or 0)),
                    })
                    await query.message.edit_text(
                        f"矩阵发布提交失败：{_error_text(exc)}"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重试提交",
                                callback_data=callback_token(chat_id, "matrixok", {
                                    "persona_ids": persona_ids,
                                    "source": source,
                                    "platform": platform,
                                    "per_persona_count": per_persona_count,
                                }),
                            ),
                            types.InlineKeyboardButton(text="修改平台", callback_data="tt:mxbackplatform"),
                        ]]),
                    )
                    raise
                clear_pending_state(chat_id)
                errors = result.get("errors") if isinstance(result.get("errors"), list) else []
                skipped = result.get("skipped") if isinstance(result.get("skipped"), list) else []
                created = result.get("created") if isinstance(result.get("created"), list) else []
                if not bool(result.get("ok")) or not created:
                    detail = "；".join(
                        str(item.get("message") or item.get("detail") or item.get("reason") or item)
                        for item in (errors + skipped)[:5]
                    )
                    audit_action(chat_id, user_id, "publish.matrix", status="failed", detail=detail)
                    await query.message.edit_text(
                        f"矩阵发布未入队。{detail or '没有符合条件的草稿或账号。'}"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(text="重新选择人设", callback_data="tt:matrix"),
                            types.InlineKeyboardButton(text="账号状态", callback_data="tt:accounts"),
                        ]]),
                    )
                else:
                    audit_action(chat_id, user_id, "publish.matrix", status="success", detail=str(result.get("batch_id") or ""))
                    await query.message.edit_text(
                        f"矩阵发布已入队：{result.get('batch_id') or '已创建'}\n"
                        f"已创建 {len(created)} 个任务。\n"
                        "每个人设会按相同来源和平台分别执行；可在排程状态查看单个任务，失败项可单独处理。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(text="查看进行中任务", callback_data="tt:tasks:0:active"),
                            types.InlineKeyboardButton(text="继续矩阵发布", callback_data="tt:matrix"),
                        ]]),
                    )
            elif action == "automationplans":
                await self._render_automation_plans(query, types, page=int(parts[2]) if len(parts) > 2 else 0)
            elif action == "automationplan" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "automationplan", parts[2])
                plan_id = str(reference.get("plan_id") or "")
                plan_page = max(0, int(reference.get("page") or 0))
                plans = await self._call(user_id, "automation.plans.list", {})
                plan_rows = plans.get("plans") if isinstance(plans, dict) else []
                plan = next((item for item in plan_rows if isinstance(item, dict) and str(item.get("id") or "") == plan_id), None)
                if not plan:
                    raise HTTPException(status_code=404, detail="自动化计划不存在")
                rows = [[
                    types.InlineKeyboardButton(text="停止计划", callback_data=callback_token(chat_id, "automationplanstop", {
                        "plan_id": plan_id,
                        "page": plan_page,
                    })),
                    types.InlineKeyboardButton(text="删除计划", callback_data=callback_token(chat_id, "automationplandelete", {
                        "plan_id": plan_id,
                        "page": plan_page,
                    })),
                ], [types.InlineKeyboardButton(text="返回自动化计划", callback_data=f"tt:automationplans:{plan_page}")]]
                await query.message.edit_text(
                    f"自动化计划详情\n\nID：{plan_id}\n"
                    f"平台：{plan.get('platform') or '—'}\n状态：{plan.get('status') or '—'}\n"
                    f"步骤：{int(plan.get('task_count') or 0)}\n下次执行：{plan.get('next_run_at') or '—'}\n\n"
                    "停止计划会保留历史记录但不再继续排程；删除计划会移除计划本身，已创建的任务按任务中心状态处理。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"automationplanstop", "automationplandelete"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                plan_id = str(reference.get("plan_id") or "")
                plan_page = max(0, int(reference.get("page") or 0))
                if action == "automationplanstop":
                    await self._call(user_id, "automation.plans.cancel", {"plan_id": plan_id})
                    notice = "自动化计划已停止。\n后续不会再生成新的排程，历史任务和账号绑定保持不变。"
                else:
                    await self._call(user_id, "automation.plans.delete", {"plan_id": plan_id})
                    notice = "自动化计划已删除。\n计划配置已移除，已经入队的任务不会被这一步自动删除。"
                await query.message.edit_text(notice, reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(text="返回自动化计划", callback_data=f"tt:automationplans:{plan_page}"),
                ]]))
            elif action == "automationplannew":
                reference = resolve_callback_token(chat_id, "automationplannew", parts[2]) if len(parts) > 2 else {}
                save_state(chat_id, mode="automation_plan_create", payload={
                    "page": max(0, int(reference.get("page") or 0)),
                })
                await query.message.edit_text(
                    "请发送自动化计划 JSON：\n"
                    '{"account_id":"账号ID","platform":"instagram","mode":"list",'
                    '"items":[{"task_type":"instagram_warmup","payload":{},"reservation_minutes":0}]}\n'
                    "账号必须已授权并绑定人设。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=f"tt:automationplans:{max(0, int(reference.get('page') or 0))}",
                        back_text="返回自动化计划",
                    ),
                )
            elif action == "taskfilter" and len(parts) > 2:
                await self._task_filter_picker(query, types, member, str(parts[2] or "platform"))
            elif action == "taskfilterpage" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "taskfilterpage", parts[2])
                await self._task_filter_picker(
                    query,
                    types,
                    member,
                    str(reference.get("kind") or "platform"),
                    page=int(reference.get("page") or 0),
                )
            elif action == "taskview" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "taskview", parts[2])
                await self._tasks(
                    query,
                    types,
                    member,
                    int(reference.get("page") or 0),
                    str(reference.get("status_filter") or "pending"),
                    str(reference.get("platform") or ""),
                    str(reference.get("persona_id") or ""),
                    str(reference.get("queue") or "all"),
                )
            elif action == "tasks":
                await self._tasks(
                    query,
                    types,
                    member,
                    int(parts[2]) if len(parts) > 2 else 0,
                    str(parts[3]) if len(parts) > 3 else "all",
                    queue=(str(parts[4]) if len(parts) > 4 else "all"),
                )
            elif action == "t" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "t", parts[2])
                task_id = str(reference.get("task_id") or "")
                task_kind = str(reference.get("task_kind") or "social")
                task = await self._call(user_id, "tasks.get", {"task_id": task_id})
                task_kind = str(task.get("_tg_task_kind") or task_kind)
                status = _task_status(task)
                rows = []
                if status in {"preparing", "queued", "running", "scheduled", "pending", "publishing", "need_manual", "retrying"}:
                    rows.append([types.InlineKeyboardButton(text="取消任务", callback_data=callback_token(chat_id, "tcancel", {
                        "task_id": task_id, "task_kind": task_kind,
                        "page": max(0, int(reference.get("page") or 0)),
                        "status_filter": str(reference.get("status_filter") or "active"),
                        "platform": str(reference.get("platform") or ""),
                        "persona_id": str(reference.get("persona_id") or ""),
                        "queue": str(reference.get("queue") or "all"),
                        "return_callback": str(reference.get("return_callback") or ""),
                    }))])
                if status == "failed" and task_kind == "social":
                    rows.append([types.InlineKeyboardButton(text="重试任务", callback_data=callback_token(chat_id, "tretry", {
                        "task_id": task_id, "task_kind": task_kind,
                        "page": max(0, int(reference.get("page") or 0)),
                        "status_filter": str(reference.get("status_filter") or "failed"),
                        "platform": str(reference.get("platform") or ""),
                        "persona_id": str(reference.get("persona_id") or ""),
                        "queue": str(reference.get("queue") or "all"),
                        "return_callback": str(reference.get("return_callback") or ""),
                    }))])
                elif status == "failed" and task_kind == "normal":
                    rows.append([types.InlineKeyboardButton(text="重新生成", callback_data="tt:generate")])
                status_filter = str(reference.get("status_filter") or "all")
                platform_filter = str(reference.get("platform") or "")
                persona_filter = str(reference.get("persona_id") or "")
                queue_filter = str(reference.get("queue") or "all")
                page = max(0, int(reference.get("page") or 0))
                return_callback = str(reference.get("return_callback") or "").strip()
                if re.fullmatch(r"tt:persona_history:\d+", return_callback):
                    back_data = return_callback
                else:
                    back_data = callback_token(chat_id, "taskview", {
                        "page": page,
                        "status_filter": status_filter,
                        "platform": platform_filter,
                        "persona_id": persona_filter,
                        "queue": queue_filter,
                    }) if (platform_filter or persona_filter or queue_filter != "all") else f"tt:tasks:{page}:{status_filter}"
                rows.append([types.InlineKeyboardButton(text="返回任务", callback_data=back_data)])
                scheduled_at = _task_timestamp(task.get("scheduled_at"))
                summary = _task_display_name(task)
                account = str(
                    task.get("account_display_name")
                    or task.get("account_username")
                    or task.get("account_id")
                    or "—"
                ).strip()
                detail_lines = [
                    f"任务：{task_id}",
                    f"类型：{task.get('type') or task.get('task_type')}",
                    f"状态：{status}",
                    f"平台：{task.get('platform') or '—'}",
                    f"账号：{account}",
                    f"人设：{task.get('persona_id') or '—'}",
                    f"计划时间：{_task_time_text(scheduled_at) if scheduled_at else '立即'}",
                    f"摘要：{summary}",
                ]
                if task.get("failure_step"):
                    detail_lines.append(f"失败步骤：{str(task.get('failure_step'))[:240]}")
                if status in {"need_manual", "paused"} or bool(task.get("manual_intervention_required")):
                    detail_lines.append("人工处理：是（任务已暂停，需完成处理后再继续）")
                if task.get("retry_count") is not None:
                    detail_lines.append(f"重试：{int(task.get('retry_count') or 0)}/{int(task.get('max_retries') or 0)}")
                error_text = str(task.get("error") or task.get("message") or "").strip()
                if error_text:
                    detail_lines.append(error_text[:1500])
                await query.message.edit_text(
                    "\n".join(detail_lines),
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"tcancel", "tretry"} and len(parts) > 2:
                task_action = "tasks.cancel" if action == "tcancel" else "tasks.retry"
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                task_id = str(reference.get("task_id") or "")
                if action == "tretry" and str(reference.get("task_kind") or "") != "social":
                    raise HTTPException(status_code=409, detail="生成任务请从推文生成重新提交")
                result = await self._call(user_id, task_action, {"task_id": task_id})
                audit_action(chat_id, user_id, task_action, status="success", resource_type="task", resource_id=task_id)
                status_filter = str(reference.get("status_filter") or "all")
                platform_filter = str(reference.get("platform") or "")
                persona_filter = str(reference.get("persona_id") or "")
                queue_filter = str(reference.get("queue") or "all")
                page = max(0, int(reference.get("page") or 0))
                return_callback = str(reference.get("return_callback") or "").strip()
                if re.fullmatch(r"tt:persona_history:\d+", return_callback):
                    back_data = return_callback
                else:
                    back_data = callback_token(chat_id, "taskview", {
                        "page": page,
                        "status_filter": status_filter,
                        "platform": platform_filter,
                        "persona_id": persona_filter,
                        "queue": queue_filter,
                    }) if (platform_filter or persona_filter or queue_filter != "all") else f"tt:tasks:{page}:{status_filter}"
                await query.message.edit_text(
                    str(result.get("message") or "操作已提交"),
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="返回任务", callback_data=back_data),
                    ]]),
                )
            elif action == "profile":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    raise HTTPException(status_code=400, detail="请先选择人设")
                profile = await self._call(user_id, "profile.get", {"persona_id": state["selected_persona_id"]})
                rows = [[
                    types.InlineKeyboardButton(text="编辑简介", callback_data="tt:bio"),
                    types.InlineKeyboardButton(text="编辑推文风格", callback_data="tt:style"),
                ], [types.InlineKeyboardButton(
                    text="✏️ 修改人设名称",
                    callback_data="tt:profilename",
                ), types.InlineKeyboardButton(
                    text="🤖 AI 重写简介",
                    callback_data="tt:profileai",
                )], [types.InlineKeyboardButton(
                    text="🧠 人设记忆",
                    callback_data="tt:pmemories:0",
                ), types.InlineKeyboardButton(
                    text="🔗 链接模板",
                    callback_data="tt:plinks",
                )], [types.InlineKeyboardButton(
                    text="🧵 Threads 人设绑定",
                    callback_data="tt:pthreads",
                )], self._persona_module_back_row(
                    types, chat_id, state["selected_persona_id"], "settings",
                )]
                await query.message.edit_text(
                    f"基础资料\n\n"
                    f"简介：{str(profile.get('content') or '')[:1200]}\n\n"
                    f"推文风格：{str(profile.get('tweet_style_sample') or '')[:1200]}\n\n"
                    "可分别修改简介、推文风格和名称；AI 重写只更新简介。\n"
                    "人设记忆用于生成时按需选择，链接模板用于正文结尾，Threads 绑定只影响对应平台字段。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"bio", "style"}:
                save_state(chat_id, mode="profile_content" if action == "bio" else "profile_style", payload={})
                await query.message.edit_text(
                    "人设设置 · " + ("修改简介" if action == "bio" else "修改推文风格") + "\n"
                    "请发送新的完整内容；只更新当前字段，名称、记忆、链接模板、图库和账号绑定保持不变。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:profile", back_text="返回基础资料",
                    ),
                )
            elif action == "profilename":
                save_state(chat_id, mode="profile_name", payload={})
                await query.message.edit_text(
                    "人设设置 · 修改名称\n"
                    "请发送新的人设名称；只修改显示名称，不会影响简介、推文、图库或绑定账号。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:profile", back_text="返回基础资料",
                    ),
                )
            elif action == "profileai":
                profile = await self._call(user_id, "profile.get", {"persona_id": load_state(chat_id)["selected_persona_id"]})
                save_state(chat_id, mode="profile_ai", payload={"name": str(profile.get("name") or "")})
                await query.message.edit_text(
                    "请发送希望 AI 优化的人设方向或补充要求。\n"
                    "AI 只会更新简介字段，不会覆盖名称、链接模板或图库。",
                    reply_markup=self._step_navigation_markup(
                        types, back_callback="tt:profile", back_text="返回基础资料",
                    ),
                )
            elif action == "pmemories":
                reference = resolve_callback_token(chat_id, "pmemories", parts[2]) if len(parts) > 2 else {}
                await self._render_profile_memories(query, types, page=int(reference.get("page") or 0))
            elif action == "pmemnoop":
                await query.answer("请使用删除按钮管理记忆")
            elif action == "pmemadd":
                reference = resolve_callback_token(chat_id, "pmemadd", parts[2]) if len(parts) > 2 else {}
                save_state(chat_id, mode="profile_memory_create", payload={
                    "page": max(0, int(reference.get("page") or 0)),
                })
                await query.message.edit_text(
                    "人设记忆 · 新增\n"
                    "请发送一条可复用的事实、偏好或表达约束；生成推文时可按需勾选，不会自动覆盖简介。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "pmemories", {"page": max(0, int(reference.get("page") or 0))}),
                        back_text="返回人设记忆",
                    ),
                )
            elif action == "pmemdelete" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pmemdelete", parts[2], consume=True)
                await self._call(user_id, "profile.memory.delete", {
                    "persona_id": load_state(chat_id)["selected_persona_id"],
                    "memory_id": str(reference.get("memory_id") or ""),
                })
                await self._render_profile_memories(query, types, page=int(reference.get("page") or 0))
            elif action == "plinks":
                reference = resolve_callback_token(chat_id, "plinks", parts[2]) if len(parts) > 2 else {}
                await self._render_profile_links(query, types, page=int(reference.get("page") or 0))
            elif action == "plinkadd":
                reference = resolve_callback_token(chat_id, "plinkadd", parts[2]) if len(parts) > 2 else {}
                save_state(chat_id, mode="profile_link_create", payload={
                    "page": max(0, int(reference.get("page") or 0)),
                })
                await query.message.edit_text(
                    "链接模板 · 新增\n"
                    "请发送：模板名称｜链接｜结尾文案\n"
                    "例如：官网｜https://example.com｜了解更多。\n"
                     "保存后可在正文生成时启用；只影响链接模板，不会修改现有推文。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback=callback_token(chat_id, "plinks", {"page": max(0, int(reference.get("page") or 0))}),
                        back_text="返回链接模板",
                    ),
                )
            elif action in {"plinkactivate", "plinkdelete"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                profile = await self._call(user_id, "profile.get", {"persona_id": load_state(chat_id)["selected_persona_id"]})
                presets = [dict(item) for item in (profile.get("link_presets") or []) if isinstance(item, dict)]
                preset_id = str(reference.get("preset_id") or "")
                if action == "plinkdelete":
                    presets = [item for item in presets if str(item.get("id") or "") != preset_id]
                    active = str(profile.get("active_link_preset_id") or "")
                    if active == preset_id:
                        active = str(presets[0].get("id") or "") if presets else ""
                else:
                    active = preset_id
                await self._call(user_id, "profile.update", {
                    "persona_id": load_state(chat_id)["selected_persona_id"],
                    "link_presets": presets,
                    "active_link_preset_id": active,
                })
                await self._render_profile_links(
                    query,
                    types,
                    page=int(reference.get("page") or 0),
                )
            elif action == "pthreads":
                profile = await self._call(user_id, "profile.get", {"persona_id": load_state(chat_id)["selected_persona_id"]})
                current = str(profile.get("threads_handle") or "").strip()
                save_state(chat_id, mode="profile_threads", payload={})
                await query.message.edit_text(
                    f"Threads 人设绑定\n当前绑定：@{current}\n"
                    "请发送新的 Threads 用户名；只更新当前人设的平台字段。\n"
                     "发送 /unbind 解除绑定。",
                    reply_markup=self._step_navigation_markup(
                        types,
                        back_callback="tt:profile", back_text="返回基础资料",
                    ),
                )
            elif action == "accounts":
                state = load_state(chat_id)
                page_text, markup = await self._accounts_payload(
                    types, member, return_callback="tt:menu",
                )
                await query.message.edit_text(page_text, reply_markup=markup)
            else:
                await query.answer("操作已过期，请返回总控菜单", show_alert=True)
                return
            await query.answer()
        except Exception as exc:
            logger.exception("Telegram tweet callback failed: %s", data)
            audit_action(chat_id, user_id, action or "callback", status="failed", detail=_error_text(exc))
            await query.answer(_error_text(exc)[:180], show_alert=True)

    async def handle_text(self, message: Any, types: Any) -> None:
        if await self._handle_chat_login_text(message, types):
            return
        member = await self._authorized(
            message.chat,
            message.from_user,
            message.answer,
            types=types,
            show_webapp_link=True,
        )
        if not member:
            return
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        text = str(message.text or "").strip()
        if text in {"/cancel", "/done"}:
            state = load_state(chat_id)
            if text == "/done" and state["mode"] == "media_upload":
                payload = state["payload"]
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                clear_pending_state(chat_id)
                await message.answer(
                    "媒体添加完成。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回推文详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": state["selected_persona_id"],
                                "post_id": str(payload.get("post_id") or ""), "source": source,
                                "page": max(0, int(payload.get("page") or 0)),
                                "intent": str(payload.get("intent") or ""),
                            }),
                        ),
                    ]]),
                )
                return
            clear_pending_state(chat_id)
            await message.answer("已结束当前操作。", reply_markup=self._main_keyboard(types))
            return
        if await self._handle_control_button(message, types, member, text):
            return
        state = load_state(chat_id)
        mode = state["mode"]
        persona_id = state["selected_persona_id"]
        if not mode:
            await self.send_main_menu(message, types)
            return
        try:
            if mode == "persona_new":
                name, _, content = text.partition("｜")
                if not content:
                    name, _, content = text.partition("|")
                result = await self._call(user_id, "personas.create", {"name": name.strip(), "content": content.strip()})
                persona = result.get("persona") if isinstance(result, dict) else result
                new_id = str((persona or {}).get("id") or result.get("id") or "")
                resume_action = str(state["payload"].get("resume_action") or "")
                audit_action(chat_id, user_id, "persona.create", status="success", resource_type="persona", resource_id=new_id)
                created_name = str((persona or {}).get("name") or name.strip())
                if resume_action == "generate":
                    save_state(chat_id, selected_persona_id=new_id, mode="generate_count", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n\nAI 生成推文 · 第 1/3 步\n请选择本次生成数量。",
                        reply_markup=self._generation_count_keyboard(types),
                    )
                elif resume_action == "hot":
                    save_state(chat_id, selected_persona_id=new_id, mode="hot_prompt", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n\n热点创作 · 第 1/2 步\n"
                        "请发送热点主题或关键词。收到后会先显示确认页。",
                        reply_markup=self._step_navigation_markup(
                            types, back_callback="tt:pmod:create", back_text="返回新建推文",
                        ),
                    )
                elif resume_action == "draft_new":
                    save_state(chat_id, selected_persona_id=new_id, mode="draft_new", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n\n手工新建草稿 · 输入正文\n请发送草稿正文。",
                        reply_markup=self._step_navigation_markup(
                            types, back_callback="tt:pmod:create", back_text="返回新建推文",
                        ),
                    )
                elif resume_action in {"drafts", "favorites", "publish_one"}:
                    save_state(chat_id, selected_persona_id=new_id, mode="", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n当前还没有可操作内容，可先新建草稿。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(text="新建草稿", callback_data="tt:draft_new"),
                        ]]),
                    )
                else:
                    save_state(chat_id, selected_persona_id=new_id, mode="", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n"
                        "可继续完善基础资料，或进入人设图设置生成首张参考图。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="打开人设",
                                callback_data=callback_token(chat_id, "p", {"persona_id": new_id}),
                            ),
                            types.InlineKeyboardButton(
                                text="进入人设图设置",
                                callback_data=callback_token(chat_id, "personaimage", {"persona_id": new_id, "page": 0}),
                            ),
                        ], [
                            types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu"),
                        ]]),
                    )
            elif mode in {"persona_ai_name", "persona_ai_prompt", "persona_ai_create"}:
                value = text.strip()
                name = ""
                prompt = ""
                if mode == "persona_ai_name":
                    if "｜" in value or "|" in value:
                        await message.answer(
                            "AI 生成人设 · 第 1/3 步\n"
                            "这一步只接收人设名称，请不要同时发送提示词。\n"
                            "请重新单独发送名称，例如：科技观察员。",
                            reply_markup=self._step_navigation_markup(
                                types,
                                back_callback="tt:personamanage",
                                back_text="返回人设管理",
                            ),
                        )
                        return
                    if len(value) < 2:
                        raise HTTPException(status_code=400, detail="人设名称至少需要 2 个字，请重新发送名称")
                    save_state(chat_id, mode="persona_ai_prompt", payload={"ai_name": value[:160]})
                    await message.answer(
                        "AI 生成人设 · 第 2/3 步\n"
                        f"名称：{value[:160]}\n"
                        "请单独发送人设提示词。\n"
                        "可描述身份、性格、内容方向、语气、受众和图片风格。",
                        reply_markup=self._step_navigation_markup(
                            types,
                            back_callback="tt:persona_ai_name",
                            back_text="返回重新输入名称",
                        ),
                    )
                    return
                elif mode == "persona_ai_prompt":
                    name = str(state["payload"].get("ai_name") or "").strip()
                    prompt = value
                else:
                    # Keep one-message input compatible with old pending states,
                    # but never advertise it in the new step-by-step UI.
                    name, separator, prompt = value.partition("｜")
                    if not separator:
                        name, separator, prompt = value.partition("|")
                    name, prompt = name.strip(), prompt.strip()
                if len(name) < 2 or not prompt:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "请先发送人设名称，再单独发送人设提示词。"
                            if mode == "persona_ai_prompt"
                            else "请发送有效的人设名称和提示词。"
                        ),
                    )
                keyword_key = f"tg:persona-ai-keywords:{chat_id}:{int(message.message_id)}"
                create_key = f"tg:persona-ai-create:{chat_id}:{int(message.message_id)}"
                try:
                    keyword_result = await self._call(user_id, "personas.ai_keywords", {
                        "name": name[:160],
                        "prompt": prompt[:2000],
                        "include_hot_keywords": True,
                        "idempotency_key": keyword_key,
                    })
                except HTTPException as exc:
                    # A rolling worker that predates the keyword action can
                    # still complete the original direct-create flow.  Do
                    # not mask billing/model failures from a current worker.
                    if exc.status_code not in {404, 405, 501}:
                        raise
                    keyword_result = None
                regular = self._persona_ai_keyword_values(
                    keyword_result.get("keywords") if isinstance(keyword_result, dict) else [],
                )
                hot = self._persona_ai_keyword_values(
                    keyword_result.get("hot_keywords") if isinstance(keyword_result, dict) else [],
                )
                if regular or hot:
                    payload = {
                        "ai_name": name[:160],
                        "ai_prompt": prompt[:2000],
                        "ai_keywords": regular,
                        "ai_hot_keywords": hot,
                        "ai_hot_keyword_source": (
                            keyword_result.get("hot_keyword_source")
                            if isinstance(keyword_result, dict)
                            and isinstance(keyword_result.get("hot_keyword_source"), dict)
                            else {}
                        ),
                        "ai_selected_keywords": [],
                        "ai_selected_regular_keywords": [],
                        "ai_selected_hot_keywords": [],
                        "ai_keyword_idempotency_key": keyword_key,
                        "ai_create_idempotency_key": create_key,
                    }
                    save_state(chat_id, mode="persona_ai_keyword_select", payload=payload)
                    await message.answer(
                        self._persona_ai_keywords_text(payload),
                        reply_markup=self._persona_ai_keywords_markup(types, chat_id, payload),
                    )
                else:
                    await self._finish_persona_ai_create(
                        user_id=user_id,
                        chat_id=chat_id,
                        types=types,
                        name=name,
                        prompt=prompt,
                        selected_keywords=[],
                        selected_regular_keywords=[],
                        selected_hot_keywords=[],
                        idempotency_key=create_key,
                        reply=message.answer,
                    )
            elif mode == "persona_copy_analyze":
                first, separator, second = text.partition("｜")
                if not separator:
                    first, separator, second = text.partition("|")
                first, second = first.strip(), second.strip()
                if separator and first.startswith(("http://", "https://")):
                    url, name = first, second
                elif separator and second.startswith(("http://", "https://")):
                    name, url = first, second
                else:
                    url, name = text.strip(), ""
                if not url.startswith(("http://", "https://")):
                    raise HTTPException(status_code=400, detail="请发送 Threads 或 Instagram 公开主页链接")
                result = await self._call(user_id, "personas.copy_analyze", {
                    "url": url[:500],
                    "name": name[:160],
                    "idempotency_key": f"tg:persona-copy-analyze:{chat_id}:{int(message.message_id)}",
                })
                profile = result.get("profile") if isinstance(result, dict) and isinstance(result.get("profile"), dict) else {}
                source = result.get("source") if isinstance(result, dict) and isinstance(result.get("source"), dict) else {}
                if not str(profile.get("name") or "").strip() or not str(profile.get("content") or "").strip():
                    raise HTTPException(status_code=502, detail="公开资料分析未返回完整人设内容")
                save_state(chat_id, mode="persona_copy_confirm", payload={
                    "copy_profile": profile,
                    "copy_source": source,
                })
                await message.answer(
                    "公开资料分析完成，请确认后创建人设。\n\n"
                    f"名称：{str(profile.get('name') or '')[:160]}\n\n"
                    f"简介：{str(profile.get('content') or '')[:2200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="确认并创建", callback_data="tt:persona_copy_confirm"),
                        types.InlineKeyboardButton(text="重新分析", callback_data="tt:persona_copy_new"),
                    ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]]),
                )
            elif mode in {"persona_group_create", "persona_group_rename"}:
                # A pre-upgrade chat may still have a pending group input
                # state.  Clear it without calling the Web group API.
                clear_pending_state(chat_id)
                await message.answer(
                    "Telegram 版已移除人设分组功能；本次输入已取消。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[types.InlineKeyboardButton(
                        text="返回人设", callback_data="tt:personas:0",
                    )]]),
                )
            elif mode == "generate_prompt":
                if not text:
                    raise HTTPException(status_code=400, detail="主题或写作要求不能为空")
                count = int(state["payload"].get("count") or 3)
                target_words = int(state["payload"].get("target_words") or 120)
                save_state(chat_id, mode="generate_confirm", payload={
                    "count": count,
                    "target_words": target_words,
                    "prompt": text,
                    "platform": "threads",
                    "writing_locale": "zh-TW",
                    "selected_memory_ids": [],
                    "selected_memory_summaries": [],
                    "selected_directions": [],
                    "selection_required": False,
                })
                confirmation_payload = load_state(chat_id)["payload"]
                await message.answer(
                    self._generation_confirmation_text(confirmation_payload),
                    reply_markup=self._generation_confirmation_markup(types, chat_id, confirmation_payload),
                )
            elif mode == "persona_image_prompt":
                payload = dict(state["payload"] if isinstance(state.get("payload"), dict) else {})
                options = payload.get("persona_image_options") if isinstance(payload.get("persona_image_options"), dict) else {}
                page = max(0, int(payload.get("page") or 0))
                result = await self._call(user_id, "persona_image.generate", {
                    "persona_id": persona_id,
                    "supplement_prompt": text,
                    "persona_image_options": options,
                    "aspect_ratio": "1:1",
                    "mode": "person",
                })
                task_id = str(result.get("task_id") or result.get("id") or "")
                clear_pending_state(chat_id)
                await message.answer(
                    f"人设图任务已提交：{task_id}\n"
                    "正在后台生成，完成后会发送结果；也可以先查看任务状态。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看任务",
                            callback_data=callback_token(chat_id, "t", {
                                "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="返回人设图库",
                            callback_data=callback_token(chat_id, "personaimage", {
                                "persona_id": persona_id, "page": page,
                            }),
                        ),
                    ]]),
                )
                asyncio.create_task(self._watch_image_generation(
                    message.bot, chat_id, user_id, persona_id, task_id, types,
                    page=page, persona_task=True,
                ))
            elif mode == "image_prompt":
                payload = dict(state["payload"])
                payload["custom_prompt"] = text[:1200]
                save_state(chat_id, selected_persona_id=persona_id, mode="image_options", payload=payload)
                await message.answer(
                    "配图补充提示词已保存。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回配图设置",
                            callback_data=callback_token(chat_id, "image", {
                                "persona_id": persona_id,
                                "post_id": str(payload.get("post_id") or ""),
                                "source": str(payload.get("source") or "posts"),
                                "page": max(0, int(payload.get("page") or 0)),
                                "intent": "image",
                            }),
                        ),
                    ]]),
                )
            elif mode == "draft_new":
                result = await self._call(user_id, "posts.create", {"persona_id": persona_id, "content": text})
                post = result.get("post") if isinstance(result, dict) else result
                post_id = str((post or {}).get("id") or result.get("id") or "")
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "post.create", status="success", resource_type="post", resource_id=post_id)
                await message.answer(
                    "草稿已保存，可继续编辑、添加媒体或发布。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看此草稿",
                            callback_data=callback_token(chat_id, "d", {
                                "persona_id": persona_id, "post_id": post_id, "source": "posts",
                            }),
                        ),
                    ]]),
                )
            elif mode == "draft_edit":
                payload = state["payload"]
                await self._call(user_id, "posts.update", {"persona_id": persona_id, "source": payload.get("source"), "post_id": payload.get("post_id"), "content": text})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "post.update", status="success", resource_type=str(payload.get("source")), resource_id=str(payload.get("post_id")))
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                await message.answer(
                    "推文已更新。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回推文详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": persona_id,
                                "post_id": str(payload.get("post_id") or ""), "source": source,
                                "page": max(0, int(payload.get("page") or 0)),
                                "intent": str(payload.get("intent") or ""),
                            }),
                        ),
                    ]]),
                )
            elif mode == "schedule_time":
                scheduled_at = parse_schedule_time(text)
                payload = state["payload"]
                next_payload = {
                    "persona_id": str(payload.get("persona_id") or persona_id),
                    "source": str(payload.get("source") or "posts"),
                    "post_id": str(payload.get("post_id") or ""),
                    "account_id": str(payload.get("account_id") or ""),
                    "platform": str(payload.get("platform") or "threads").strip().lower(),
                    "scheduled_at": scheduled_at,
                    "page": max(0, int(payload.get("page") or 0)),
                    "intent": str(payload.get("intent") or ""),
                }
                save_state(chat_id, mode="schedule_confirm", payload=next_payload)
                scheduled_text = datetime.fromtimestamp(scheduled_at, BUSINESS_TIMEZONE).strftime("%Y-%m-%d %H:%M")
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认定时发布",
                        callback_data=callback_token(chat_id, "schedok", next_payload),
                    ),
                    types.InlineKeyboardButton(text="修改时间", callback_data=callback_token(chat_id, "pa", {
                        "source": next_payload["source"],
                        "post_id": next_payload["post_id"],
                        "persona_id": next_payload["persona_id"],
                        "account_id": next_payload["account_id"],
                        "platform": next_payload["platform"],
                        "scheduled": True,
                        "page": next_payload["page"],
                        "intent": next_payload["intent"],
                    })),
                ], [types.InlineKeyboardButton(
                    text="取消",
                    callback_data=(
                        "tt:imageposts:" + str(next_payload["page"])
                        if next_payload["intent"] == "image"
                        else (
                            "tt:publishposts:" + str(next_payload["page"])
                            if next_payload["intent"] == "publish"
                            else f"tt:{'favorites' if next_payload['source'] == 'favorites' else 'drafts'}:{next_payload['page']}"
                        )
                    ),
                )]]
                await message.answer(
                    "定时发布 · 最终确认\n"
                    f"平台：{next_payload['platform'].title()}\n"
                    f"北京时间：{scheduled_text}\n\n确认后才会提交发布队列。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif mode == "history_recognize":
                url, separator, caption = text.partition("｜")
                if not separator:
                    url, separator, caption = text.partition("|")
                url = url.strip()
                if not url:
                    raise HTTPException(status_code=400, detail="帖子链接不能为空")
                history_persona_id = str(state["payload"].get("persona_id") or persona_id).strip()
                result = await self._call(user_id, "profile.history.recognize", {
                    "persona_id": history_persona_id,
                    "url": url,
                    "caption": caption.strip(),
                })
                clear_pending_state(chat_id)
                reused = bool(result.get("reused")) if isinstance(result, dict) else False
                history_page = max(0, int(state["payload"].get("page") or 0))
                await message.answer(
                    "发布记录已识别并保存。" + ("（已存在记录已复用）" if reused else ""),
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看发布历史",
                            callback_data=f"tt:persona_history:{history_page}",
                        ),
                    ]]),
                )
            elif mode in {"profile_content", "profile_style"}:
                key = "content" if mode == "profile_content" else "tweet_style_sample"
                await self._call(user_id, "profile.update", {"persona_id": persona_id, key: text})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "profile.update", status="success", resource_type="persona", resource_id=persona_id, detail=key)
                await message.answer(
                    "基础资料已保存。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="返回基础资料", callback_data="tt:profile"),
                    ]]),
                )
            elif mode == "profile_name":
                await self._call(user_id, "profile.update", {"persona_id": persona_id, "name": text[:120]})
                clear_pending_state(chat_id)
                await message.answer("人设名称已更新。", reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(text="返回基础资料", callback_data="tt:profile"),
                ]]))
            elif mode == "profile_ai":
                name = str(state["payload"].get("name") or "")
                result = await self._call(user_id, "profile.ai", {
                    "persona_id": persona_id,
                    "name": name,
                    "prompt": text[:1200],
                    "idempotency_key": f"tg:profile-ai:{chat_id}:{int(message.message_id)}",
                })
                content = str(result.get("content") or "").strip() if isinstance(result, dict) else ""
                if not content:
                    raise HTTPException(status_code=502, detail="AI 未返回有效人设简介")
                await self._call(user_id, "profile.update", {"persona_id": persona_id, "content": content})
                clear_pending_state(chat_id)
                await message.answer(
                    "AI 已重写人设简介并保存。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="返回基础资料", callback_data="tt:profile"),
                    ]]),
                )
            elif mode == "profile_memory_create":
                await self._call(user_id, "profile.memory.create", {"persona_id": persona_id, "summary": text[:1000]})
                memory_page = max(0, int(state["payload"].get("page") or 0))
                clear_pending_state(chat_id)
                await message.answer("人设记忆已保存。", reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看人设记忆",
                        callback_data=callback_token(chat_id, "pmemories", {"page": memory_page}),
                    ),
                ]]))
            elif mode == "profile_link_create":
                parts = [part.strip() for part in re.split(r"[｜|]", text, maxsplit=2)]
                if len(parts) < 2 or not parts[0] or not parts[1]:
                    raise HTTPException(status_code=400, detail="格式应为：模板名称｜链接｜结尾文案")
                profile = await self._call(user_id, "profile.get", {"persona_id": persona_id})
                presets = [dict(item) for item in (profile.get("link_presets") or []) if isinstance(item, dict)]
                preset = {
                    "id": f"tg-link-{int(time.time() * 1000)}",
                    "name": parts[0][:80],
                    "link_url": parts[1][:500],
                    "ending_text": (parts[2] if len(parts) > 2 else "")[:300],
                    "enabled": True,
                }
                presets.append(preset)
                await self._call(user_id, "profile.update", {
                    "persona_id": persona_id,
                    "link_presets": presets,
                    "active_link_preset_id": str(profile.get("active_link_preset_id") or preset["id"]),
                })
                links_page = max(0, int(state["payload"].get("page") or 0))
                clear_pending_state(chat_id)
                await message.answer("链接模板已保存。", reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看链接模板",
                        callback_data=callback_token(chat_id, "plinks", {"page": links_page}),
                    ),
                ]]))
            elif mode == "profile_threads":
                if text == "/unbind":
                    await self._call(user_id, "profile.threads.unbind", {"persona_id": persona_id})
                    notice = "Threads 人设绑定已解除。"
                else:
                    await self._call(user_id, "profile.threads.bind", {"persona_id": persona_id, "username": text})
                    notice = "Threads 人设绑定已更新。"
                clear_pending_state(chat_id)
                await message.answer(notice, reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(text="返回基础资料", callback_data="tt:profile"),
                ]]))
            elif mode == "automation_plan_create":
                try:
                    plan_payload = json.loads(text)
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise HTTPException(status_code=400, detail="计划 JSON 格式无效") from exc
                if not isinstance(plan_payload, dict):
                    raise HTTPException(status_code=400, detail="计划 JSON 必须是对象")
                result = await self._call(user_id, "automation.plans.create", plan_payload)
                automation_page = max(0, int(state["payload"].get("page") or 0))
                clear_pending_state(chat_id)
                plan = result.get("plan") if isinstance(result, dict) and isinstance(result.get("plan"), dict) else {}
                await message.answer(
                    f"自动化计划已创建：{str(plan.get('id') or '已提交')}。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看自动化计划",
                            callback_data=f"tt:automationplans:{automation_page}",
                        ),
                    ]]),
                )
            elif mode == "hot_rewrite":
                candidates = state["payload"].get("hot_candidates") if isinstance(state["payload"].get("hot_candidates"), list) else []
                index = int(state["payload"].get("hot_candidate_index") or 0)
                if index < 0 or index >= len(candidates) or not isinstance(candidates[index], dict):
                    raise HTTPException(status_code=410, detail="热点候选已失效，请重新开始热点创作")
                candidate = dict(candidates[index])
                source_content = str(candidate.get("content") or candidate.get("text") or candidate.get("body") or "").strip()
                if not source_content:
                    raise HTTPException(status_code=400, detail="该热点候选没有可改写正文")
                instruction = "" if text.strip().lower() in {"/auto", "auto", "按人设改写"} else text[:1200]
                result = await self._call(user_id, "hot.rewrite", {
                    "persona_id": persona_id,
                    "source_content": source_content,
                    "instruction": instruction,
                    "platform": str(candidate.get("platform") or "threads").strip() or "threads",
                    "writing_locale": str(state["payload"].get("writing_locale") or "zh-TW").strip() or "zh-TW",
                    "idempotency_key": f"tg:hot-rewrite:{chat_id}:{int(message.message_id)}",
                })
                rewritten = str(result.get("content") or "").strip() if isinstance(result, dict) else ""
                if not rewritten:
                    raise HTTPException(status_code=502, detail="模型没有返回可用改写正文")
                candidate["content"] = rewritten
                candidate["text"] = rewritten
                candidates[index] = candidate
                task_id = str(state["payload"].get("last_hot_task_id") or "")
                save_state(chat_id, selected_persona_id=persona_id, mode="hot_select", payload={
                    "hot_candidates": candidates,
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                title = str(candidate.get("title") or rewritten)[:28]
                rows = [[
                    types.InlineKeyboardButton(
                        text=f"保存 {index + 1}. {title}",
                        callback_data=callback_token(chat_id, "hotpick", {
                            "index": index, "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                    types.InlineKeyboardButton(
                        text="✍️ 再次改写",
                        callback_data=callback_token(chat_id, "hotrewrite", {
                            "index": index, "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                ], [types.InlineKeyboardButton(
                    text="返回候选列表",
                    callback_data=callback_token(chat_id, "hotlist", {
                        "task_id": task_id, "persona_id": persona_id,
                    }),
                )]]
                await message.answer(
                    "热点候选已按人设改写，可保存为草稿或继续调整。\n\n"
                    + rewritten[:3000],
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif mode == "hot_prompt":
                if not text:
                    raise HTTPException(status_code=400, detail="热点主题不能为空")
                retained = {
                    key: value
                    for key, value in state["payload"].items()
                    if str(key).startswith("last_")
                }
                save_state(chat_id, mode="hot_confirm", payload={**retained, "prompt": text})
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认开始热点任务",
                        callback_data=callback_token(chat_id, "hotsubmit", {}),
                    ),
                    types.InlineKeyboardButton(text="修改主题", callback_data="tt:hot"),
                ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]]
                await message.answer(
                    "热点创作 · 第 2/2 步\n"
                    f"主题：{text[:1200]}\n\n确认后才会提交热点任务。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            else:
                await message.answer("当前操作状态已失效，请重新选择。", reply_markup=self._main_keyboard(types))
                clear_pending_state(chat_id)
        except Exception as exc:
            logger.exception("Telegram tweet text action failed: %s", mode)
            audit_action(chat_id, user_id, mode, status="failed", detail=_error_text(exc))
            await message.answer(
                f"操作失败：{_error_text(exc)}\n"
                "状态已保留，可修正后重试；也可以点击下方返回或取消，不必输入命令。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu"),
                    types.InlineKeyboardButton(text="取消当前步骤", callback_data="tt:stepcancel"),
                ]]),
            )

    async def handle_media(self, message: Any, types: Any) -> None:
        member = await self._authorized(
            message.chat,
            message.from_user,
            message.answer,
            types=types,
            show_webapp_link=True,
        )
        if not member:
            return
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        state = load_state(chat_id)
        if state["mode"] not in {"media_upload", "media_replace", "persona_image_upload"}:
            await message.answer("请先从草稿详情或人设图设置选择上传入口。", reply_markup=self._main_keyboard(types))
            return
        state_payload = state["payload"] if isinstance(state.get("payload"), dict) else {}

        def media_input_navigation_markup() -> Any:
            """Keep invalid media replies inside the current wizard.

            Telegram users may send an unsupported or oversized file before we
            can download it.  The pending state is intentionally retained so
            they can retry, but the error message must still expose the same
            detail/menu/cancel exits as a successful upload step.
            """
            button = types.InlineKeyboardButton
            rows: list[list[Any]] = []
            if state["mode"] == "persona_image_upload":
                persona_id = str(state.get("selected_persona_id") or "").strip()
                if persona_id:
                    try:
                        page = max(0, int(state_payload.get("page") or 0))
                    except (TypeError, ValueError):
                        page = 0
                    rows.append([button(
                        text="返回人设图设置",
                        callback_data=callback_token(chat_id, "personaimage", {
                            "persona_id": persona_id,
                            "page": page,
                        }),
                    )])
            else:
                source = "favorites" if str(state_payload.get("source")) == "favorites" else "posts"
                post_id = str(state_payload.get("post_id") or "").strip()
                if post_id:
                    try:
                        page = max(0, int(state_payload.get("page") or 0))
                    except (TypeError, ValueError):
                        page = 0
                    rows.append([button(
                        text="返回推文详情",
                        callback_data=callback_token(chat_id, "f" if source == "favorites" else "d", {
                            "persona_id": str(state.get("selected_persona_id") or ""),
                            "post_id": post_id,
                            "source": source,
                            "page": page,
                            "intent": str(state_payload.get("intent") or ""),
                        }),
                    )])
            rows.append([
                button(text="返回总控菜单", callback_data="tt:menu"),
                button(text="取消当前步骤", callback_data="tt:stepcancel"),
            ])
            return types.InlineKeyboardMarkup(inline_keyboard=rows)

        media = None
        filename = "telegram-media"
        mime_type = "application/octet-stream"
        if getattr(message, "photo", None):
            media = message.photo[-1]
            filename = f"telegram-{media.file_unique_id}.jpg"
            mime_type = "image/jpeg"
        elif getattr(message, "video", None):
            media = message.video
            filename = str(message.video.file_name or f"telegram-{message.video.file_unique_id}.mp4")
            mime_type = str(message.video.mime_type or "video/mp4")
        elif getattr(message, "document", None):
            media = message.document
            filename = str(message.document.file_name or f"telegram-{message.document.file_unique_id}")
            mime_type = str(message.document.mime_type or mime_type)
        if media is None:
            await message.answer(
                "未识别到支持的媒体，请重新发送文件，或选择下方操作。",
                reply_markup=media_input_navigation_markup(),
            )
            return
        if int(getattr(media, "file_size", 0) or 0) > MAX_TELEGRAM_MEDIA_BYTES:
            await message.answer(
                "文件超过 Telegram Bot 20MB 下载限制，请压缩后重试，或选择下方操作。",
                reply_markup=media_input_navigation_markup(),
            )
            return
        canonical_suffix = SUPPORTED_MEDIA_MIME_SUFFIXES.get(mime_type.lower())
        if not canonical_suffix:
            await message.answer(
                "仅支持 JPG、PNG、WebP、GIF、MP4、MOV 或 WebM 媒体，请重新发送，或选择下方操作。",
                reply_markup=media_input_navigation_markup(),
            )
            return
        filename = f"{filename.rsplit('.', 1)[0]}{canonical_suffix}"
        try:
            target = BytesIO()
            await message.bot.download(media, destination=target)
            content = target.getvalue()
            payload = state_payload
            if state["mode"] == "persona_image_upload":
                if not mime_type.lower().startswith("image/"):
                    await message.answer(
                        "人设图只支持 JPG、PNG、WebP 或 GIF 图片，请重新发送，或选择下方操作。",
                        reply_markup=media_input_navigation_markup(),
                    )
                    return
                result = await self._call_async(user_id, "persona_image.upload", {
                    "persona_id": state["selected_persona_id"],
                    "filename": filename,
                    "mime_type": mime_type,
                    "content": content,
                    "replace_image_id": str(payload.get("replace_image_id") or ""),
                })
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "persona_image.upload", status="success", resource_type="persona", resource_id=state["selected_persona_id"])
                await message.answer(
                    "人设图已上传并保存到图库。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[types.InlineKeyboardButton(
                        text="返回人设图设置",
                        callback_data=callback_token(chat_id, "personaimage", {
                            "persona_id": state["selected_persona_id"], "page": int(payload.get("page") or 0),
                        }),
                    )]]),
                )
                return
            await self._call_async(user_id, "media.add", {
                "persona_id": state["selected_persona_id"],
                "source": payload.get("source"),
                "post_id": payload.get("post_id"),
                "filename": filename,
                "mime_type": mime_type,
                "content": content,
                "replace_index": state["payload"].get("replace_index") if state["mode"] == "media_replace" else None,
            })
            audit_action(chat_id, user_id, "media.add", status="success", resource_type=str(payload.get("source")), resource_id=str(payload.get("post_id")))
            if state["mode"] == "media_replace":
                clear_pending_state(chat_id)
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                await message.answer(
                    "媒体已替换。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回推文详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": state["selected_persona_id"],
                                "post_id": str(payload.get("post_id") or ""), "source": source,
                                "page": max(0, int(payload.get("page") or 0)),
                                "intent": str(payload.get("intent") or ""),
                            }),
                        ),
                    ]]),
                )
            else:
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                await message.answer(
                    "媒体已添加。可继续发送多个素材，或点击完成返回推文详情。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="完成并返回详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": state["selected_persona_id"],
                                "post_id": str(payload.get("post_id") or ""),
                                "source": source,
                                "page": max(0, int(payload.get("page") or 0)),
                                "intent": str(payload.get("intent") or ""),
                            }),
                        ),
                        types.InlineKeyboardButton(text="取消当前步骤", callback_data="tt:stepcancel"),
                    ]]),
                )
        except Exception as exc:
            logger.exception("Telegram media upload failed")
            audit_action(
                chat_id,
                user_id,
                "persona_image.upload" if state["mode"] == "persona_image_upload" else "media.add",
                status="failed",
                detail=_error_text(exc),
            )
            await message.answer(
                f"媒体上传失败：{_error_text(exc)}\n"
                "可重新发送支持的媒体，也可以点击下方取消当前步骤。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(text="取消当前步骤", callback_data="tt:stepcancel"),
                    types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu"),
                ]]),
            )

    async def _watch_generation(self, bot: Any, chat_id: int, user_id: int, persona_id: str, task_id: str, types: Any) -> None:
        for _ in range(180):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "generation.status", {"persona_id": persona_id, "task_id": task_id})
            except Exception:
                return
            status = _task_status(task)
            if status in {"preparing", "queued", "pending", "running", "publishing", "retrying", "scheduled"}:
                continue
            if status == "success":
                output = task.get("output") if isinstance(task.get("output"), dict) else {}
                posts = output.get("posts") if isinstance(output.get("posts"), list) else []
                posts = [post for post in posts if isinstance(post, dict)]
                task_input = task.get("input") if isinstance(task.get("input"), dict) else {}
                if bool(task_input.get("selection_required")) and posts:
                    candidate_rows = [
                        post for post in posts
                        if bool(post.get("generation_candidate", post.get("generationCandidate", True)))
                    ] or posts
                    candidate_buttons = []
                    for index, post in enumerate(candidate_rows[:10], start=1):
                        post_id = str(post.get("id") or "").strip()
                        if not post_id:
                            continue
                        title = str(post.get("title") or f"候选 {index}").strip()[:40]
                        candidate_buttons.append([types.InlineKeyboardButton(
                            text=f"{index}. {title}",
                            callback_data=callback_token(chat_id, "gresolve", {
                                "task_id": task_id,
                                "post_id": post_id,
                                "title": title,
                            }),
                        )])
                    candidate_buttons.append([types.InlineKeyboardButton(
                        text="查看任务详情",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "normal", "status_filter": "completed",
                        }),
                    )])
                    if not self._member_still_bound(chat_id, user_id):
                        return
                    await bot.send_message(
                        chat_id,
                        "推文生成完成。该任务要求保留一个候选，请点击要保留的内容。\n\n"
                        + "\n\n".join(
                            f"{index}. {str(post.get('content') or '')[:260]}"
                            for index, post in enumerate(candidate_rows[:5], start=1)
                        ),
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=candidate_buttons),
                    )
                    return
                post_ids = [str(item or "") for item in output.get("post_ids") or [] if str(item or "")]
                if not posts and post_ids:
                    all_posts = await self._call(user_id, "posts.list", {"persona_id": persona_id, "source": "posts"})
                    by_id = {str(post.get("id") or ""): post for post in all_posts if isinstance(post, dict)}
                    posts = [by_id[post_id] for post_id in post_ids if post_id in by_id]
                preview = "\n\n".join(f"{index + 1}. {str(post.get('content') or '')[:600]}" for index, post in enumerate(posts[:3]))
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    (f"推文生成完成。\n\n{preview}" if preview else "推文生成完成，可进入草稿列表查看结果。")[:4000],
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看生成草稿",
                            callback_data=callback_token(chat_id, "gendrafts", {"persona_id": persona_id}),
                        ),
                        types.InlineKeyboardButton(
                            text="继续生成",
                            callback_data=callback_token(chat_id, "gagain", {"persona_id": persona_id}),
                        ),
                    ]]),
                )
            else:
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    f"推文生成{status}：{str(task.get('error') or '')[:1200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="修改参数重新生成",
                            callback_data=callback_token(chat_id, "gagain", {"persona_id": persona_id}),
                        ),
                        types.InlineKeyboardButton(
                            text="查看任务",
                            callback_data=callback_token(chat_id, "t", {
                                "task_id": task_id, "task_kind": "normal", "status_filter": "failed",
                            }),
                        ),
                    ]]),
                )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "推文生成仍在后台执行，可从任务中心继续查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                        }),
                    ),
                ]]),
            )

    async def _watch_image_generation(
        self,
        bot: Any,
        chat_id: int,
        user_id: int,
        persona_id: str,
        task_id: str,
        types: Any,
        *,
        post_id: str = "",
        source: str = "posts",
        page: int = 0,
        intent: str = "image",
        persona_task: bool = False,
    ) -> None:
        """Poll the canonical Web image task and deliver local media previews."""
        for _ in range(240):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "image.status", {
                    "persona_id": persona_id,
                    "task_id": task_id,
                })
            except Exception:
                return
            status = _task_status(task)
            if status in {"queued", "pending", "running", "preparing", "publishing", "retrying", "scheduled"}:
                continue
            if status in {"success", "succeeded", "completed"}:
                raw_paths = task.get("media_paths") if isinstance(task.get("media_paths"), list) else []
                paths = [str(item or "").strip() for item in raw_paths if str(item or "").strip()]
                sent = 0
                try:
                    from aiogram.types import FSInputFile
                except Exception:
                    FSInputFile = None  # type: ignore[assignment]
                for raw_path in paths[:4]:
                    path = Path(raw_path).expanduser()
                    if not path.is_file() or FSInputFile is None:
                        continue
                    if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
                        await bot.send_photo(chat_id, photo=FSInputFile(str(path)))
                    else:
                        await bot.send_document(chat_id, document=FSInputFile(str(path)))
                    sent += 1
                if not sent and persona_task:
                    library = task.get("output", {}).get("library") if isinstance(task.get("output"), dict) else {}
                    items = library.get("items") if isinstance(library, dict) and isinstance(library.get("items"), list) else []
                    if items:
                        fallback_path = str(items[0].get("image_url") or "") if isinstance(items[0], dict) else ""
                        if fallback_path and Path(fallback_path).is_file() and FSInputFile is not None:
                            await bot.send_photo(chat_id, photo=FSInputFile(fallback_path))
                            sent = 1
                rows: list[list[Any]] = []
                if post_id and not persona_task:
                    rows.append([types.InlineKeyboardButton(
                        text="➕ 添加到当前推文",
                        callback_data=callback_token(chat_id, "imgattach", {
                            "persona_id": persona_id,
                            "post_id": post_id,
                            "source": source,
                            "task_id": task_id,
                            "media_indexes": list(range(min(len(paths), 4))),
                            "page": max(0, int(page or 0)),
                            "intent": str(intent or "image"),
                        }),
                    )])
                if persona_task:
                    rows.append([types.InlineKeyboardButton(
                        text="查看人设图库",
                        callback_data=callback_token(chat_id, "personaimage", {
                            "persona_id": persona_id,
                            "page": max(0, int(page or 0)),
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(
                    text="查看任务",
                    callback_data=callback_token(chat_id, "t", {
                        "task_id": task_id, "task_kind": "normal", "status_filter": "completed",
                    }),
                )])
                if self._member_still_bound(chat_id, user_id):
                    await bot.send_message(
                        chat_id,
                        ("人设图生成完成。" if persona_task else "推文配图生成完成。")
                        + (f" 已发送 {sent} 张图片。" if sent else " 结果已保存，可从任务详情查看。"),
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
            else:
                if self._member_still_bound(chat_id, user_id):
                    await bot.send_message(
                        chat_id,
                        f"{'人设图' if persona_task else '推文配图'}任务{status}：{str(task.get('error') or '')[:1200]}",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[types.InlineKeyboardButton(
                            text="返回人设设置" if persona_task else "返回推文内容",
                            callback_data=(callback_token(chat_id, "personaimage", {
                                "persona_id": persona_id,
                                "page": max(0, int(page or 0)),
                            }) if persona_task else "tt:pmod:content"),
                        )]]),
                    )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "配图任务仍在后台执行，可从排程状态查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[types.InlineKeyboardButton(
                    text="查看任务",
                    callback_data=callback_token(chat_id, "t", {
                        "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                    }),
                )]]),
            )

    async def _watch_publish(self, bot: Any, chat_id: int, user_id: int, task_id: str, types: Any) -> None:
        for _ in range(240):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "tasks.get", {"task_id": task_id})
            except Exception:
                return
            status = _task_status(task)
            if status in {"preparing", "queued", "pending", "running", "publishing", "retrying", "scheduled"}:
                continue
            result = task.get("result") if isinstance(task.get("result"), dict) else {}
            url = str(
                task.get("published_url")
                or task.get("post_url")
                or task.get("result_url")
                or result.get("published_url")
                or result.get("post_url")
                or result.get("url")
                or ""
            ).strip()
            suffix = f"\n{url}" if url.startswith(("https://", "http://")) else ""
            if not self._member_still_bound(chat_id, user_id):
                return
            await bot.send_message(
                chat_id,
                f"发布任务 {status}：{task_id}{suffix}"[:4000],
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "social",
                            "status_filter": "failed" if status == "failed" else "all",
                        }),
                    ),
                    types.InlineKeyboardButton(text="继续发布", callback_data="tt:publish_one"),
                ]]),
            )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "发布任务仍在后台执行，可从任务中心继续查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "social", "status_filter": "active",
                        }),
                    ),
                ]]),
            )

    async def _watch_hot(self, bot: Any, chat_id: int, user_id: int, persona_id: str, task_id: str, types: Any) -> None:
        for _ in range(180):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "hot.status", {"persona_id": persona_id, "task_id": task_id})
            except Exception:
                return
            status = _task_status(task)
            if status in {"queued", "running"}:
                continue
            if status == "success":
                candidates = task.get("candidates") or (task.get("result") or {}).get("candidates") or []
                candidates = [item for item in candidates if isinstance(item, dict)][:5]
                if not self._member_still_bound(chat_id, user_id):
                    return
                save_state(chat_id, selected_persona_id=persona_id, mode="hot_select", payload={
                    "hot_candidates": candidates,
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                rows = []
                for index, item in enumerate(candidates):
                    title = str(item.get("title") or item.get("content") or item.get("text") or f"候选 {index + 1}")[:28]
                    rows.append([
                        types.InlineKeyboardButton(
                            text=f"保存 {index + 1}. {title}",
                            callback_data=callback_token(chat_id, "hotpick", {
                                "index": index, "task_id": task_id, "persona_id": persona_id,
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="✍️ 改写",
                            callback_data=callback_token(chat_id, "hotrewrite", {
                                "index": index, "task_id": task_id, "persona_id": persona_id,
                            }),
                        ),
                    ])
                rows.append([types.InlineKeyboardButton(
                    text="返回新建推文",
                    callback_data="tt:pmod:create",
                )])
                # State/keyboard construction can yield to a rebind or
                # logout.  Re-check immediately before delivering candidates
                # so a stale watcher cannot notify the newly bound account.
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    "热点候选已完成，选择一条保存为草稿。" if candidates else "热点任务已完成，但没有可导入候选。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            else:
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    f"热点任务{status}：{str(task.get('error') or '')[:1200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="修改主题重试",
                            callback_data=callback_token(chat_id, "hotagain", {"persona_id": persona_id}),
                        ),
                        types.InlineKeyboardButton(
                            text="返回新建推文",
                            callback_data="tt:pmod:create",
                        ),
                    ]]),
                )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "热点任务仍在后台执行，可稍后返回当前人设继续查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看热点状态",
                        callback_data=callback_token(chat_id, "hotstatus", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                    types.InlineKeyboardButton(
                        text="返回新建推文",
                        callback_data="tt:pmod:create",
                    ),
                ]]),
            )


async def run_native_tweet_bot(
    *,
    token: str,
    get_runtime: Callable[[], dict[str, Any]],
    load_member: Callable[[int], Any],
    remember_member_profile: Callable[..., None] | None = None,
    create_webapp_url: WebAppUrlFactory | None = None,
    has_active_web_session: WebSessionChecker | None = None,
    chat_login: ChatLoginHandler | None = None,
    ops: TweetWorkbenchOps,
    stop_event: Any,
    status_callback: Callable[[dict[str, Any]], None],
    heartbeat: Callable[[], bool] | None = None,
) -> None:
    from aiogram import Bot, Dispatcher, F
    from aiogram.client.session.aiohttp import AiohttpSession
    from aiogram.filters import Command
    from aiogram import types

    # Aiogram's aiohttp session does not consume HTTP(S)_PROXY from the
    # environment by default.  Reuse the system proxy when present so the
    # polling worker uses the same egress path as the admin token check.
    bot = Bot(token=token, session=AiohttpSession(proxy=_detect_telegram_proxy()))
    dispatcher = Dispatcher()
    # A running production Bot must always have the session gate.  Keep the
    # controller's optional callback for isolated unit tests and integrations,
    # but fail closed if the worker wiring ever omits it.
    session_checker = has_active_web_session or (lambda _member: False)
    controller = NativeTweetBotController(
        ops=ops,
        get_runtime=get_runtime,
        load_member=load_member,
        remember_member_profile=remember_member_profile,
        create_webapp_url=create_webapp_url,
        has_active_web_session=session_checker,
        chat_login=chat_login,
    )

    async def command_menu(message: types.Message) -> None:
        await controller.send_main_menu(message, types)

    async def command_bind(message: types.Message) -> None:
        await controller.send_web_login_link(message, types)

    async def callback(query: types.CallbackQuery) -> None:
        await controller.handle_callback(query, types)

    async def media(message: types.Message) -> None:
        await controller.handle_media(message, types)

    async def text(message: types.Message) -> None:
        await controller.handle_text(message, types)

    dispatcher.message.register(command_menu, Command("start", "menu", "workbench"))
    dispatcher.message.register(command_bind, Command("bind", "login"))
    dispatcher.message.register(media, F.photo | F.video | F.document)
    dispatcher.message.register(text, F.text)
    dispatcher.callback_query.register(callback, F.data.startswith("tt:"))
    await bot.set_my_commands([
        types.BotCommand(command="menu", description="打开推文工作台"),
        types.BotCommand(command="bind", description="聊天内登录并绑定"),
        types.BotCommand(command="cancel", description="取消当前操作"),
    ])
    polling = asyncio.create_task(dispatcher.start_polling(bot, handle_signals=False))
    status_callback({"running": True, "starting": False, "last_error": "", "updated_at": time.time()})
    try:
        while not stop_event.is_set() and not polling.done():
            if heartbeat is not None and not heartbeat():
                break
            latest = get_runtime() or {}
            if not bool(latest.get("telegram_tweet_bot_enabled")) or str(latest.get("telegram_tweet_bot_token") or "").strip() != token:
                break
            await asyncio.sleep(2)
        cancelled_before_start = False
        if not polling.done():
            try:
                await dispatcher.stop_polling()
            except RuntimeError as exc:
                # ``start_polling`` acquires its running lock only after the
                # task gets its first event-loop turn.  A config reload can
                # therefore ask us to stop during that small startup window,
                # when aiogram quite correctly reports "Polling is not
                # started".  This is a normal shutdown, not a Bot failure;
                # cancel the not-yet-started task and let the gather below
                # drain it without poisoning the status shown in the admin UI.
                if str(exc) != "Polling is not started":
                    raise
                cancelled_before_start = True
                polling.cancel()
        results = await asyncio.gather(polling, return_exceptions=True)
        if results and isinstance(results[0], BaseException):
            result = results[0]
            if not (cancelled_before_start and isinstance(result, asyncio.CancelledError)):
                raise result
    finally:
        await bot.session.close()


__all__ = [
    "ChatLoginHandler",
    "NativeTweetBotController",
    "TweetWorkbenchOps",
    "audit_action",
    "clear_pending_state",
    "ensure_native_bot_schema",
    "load_state",
    "parse_schedule_time",
    "run_native_tweet_bot",
    "save_state",
]
