from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .auth import SESSION_COOKIE, create_session, session_storage_token
from .db import db
from .telegram_admin import fetch_telegram_chat_profile, verify_bot_token

logger = logging.getLogger(__name__)

DEFAULT_PUBLIC_BASE_URL = "https://www.vecto-ai.cn"
TICKET_TTL_SECONDS = 180
SESSION_TTL_SECONDS = 60 * 60

_BOT_LOCK = threading.RLock()
_BOT_STOP = threading.Event()
_BOT_THREAD: threading.Thread | None = None
_BOT_STATUS: dict[str, Any] = {
    "running": False,
    "last_error": "",
    "bot_username": "",
    "updated_at": 0.0,
}

GetRuntime = Callable[[], dict[str, Any]]
SaveRuntime = Callable[[dict[str, Any]], None]


class TweetTgEnvPayload(BaseModel):
    bot_token: str | None = None
    bot_enabled: bool | None = None
    public_base_url: str | None = None
    content_settings_enabled: bool | None = None


class TweetTgMemberPayload(BaseModel):
    chat_id: int | str
    web_user: int | str
    label: str = Field(default="", max_length=120)
    enabled: bool = True


class TweetTgMemberTogglePayload(BaseModel):
    enabled: bool = True


class TweetTgExchangePayload(BaseModel):
    ticket: str
    init_data: str


_ROUTES: dict[str, tuple[str, str]] = {
    "home": ("完整推文工作台", "/console.html?view=persona_dashboard"),
    "personas": ("我的人设", "/console.html?view=workspace&module=personas"),
    "tweet_generation": ("推文生成", "/console.html?view=workspace&module=tweet_generation"),
    "publishing": ("发布与自动化", "/console.html?view=workspace&module=publishing"),
    "accounts": ("账号管理", "/console.html?view=accounts"),
    "browser_list": ("浏览器列表", "/console.html?view=accounts&browser_panel=browsers"),
    "tasks": ("任务与日志", "/console.html?view=tasks"),
    "content_settings": ("内容设置", "/console.html?view=workspace&module=personas&persona_group=settings"),
}

_SECTION_MENUS: dict[str, tuple[str, tuple[tuple[str, str], ...]]] = {
    "personas": ("我的人设", (("人设列表与分组", "personas"), ("人设资料、头像与账号绑定", "personas"))),
    "content": ("推文生成", (("新建与批量生成", "tweet_generation"), ("草稿、收藏与热点", "tweet_generation"), ("图片与媒体编辑", "tweet_generation"))),
    "publish": ("发布与自动化", (("普通发布与矩阵发布", "publishing"), ("自动化计划", "publishing"), ("发布历史与重试", "publishing"))),
    "accounts": ("账号与浏览器", (("Threads / Instagram 账号", "accounts"), ("授权、登录与代理", "accounts"), ("浏览器人工接管", "browser_list"))),
    "tasks": ("任务中心", (("任务、日志、截图与取消", "tasks"),)),
}


def ensure_tweet_telegram_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_members (
          chat_id INTEGER PRIMARY KEY,
          web_user_id INTEGER NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          tg_username TEXT NOT NULL DEFAULT '',
          tg_display_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          created_at REAL NOT NULL DEFAULT 0,
          updated_at REAL NOT NULL DEFAULT 0,
          FOREIGN KEY(web_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_tickets (
          token_hash TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          web_user_id INTEGER NOT NULL,
          route_key TEXT NOT NULL,
          expires_at REAL NOT NULL,
          used_at REAL NOT NULL DEFAULT 0,
          session_token_hash TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          FOREIGN KEY(chat_id) REFERENCES telegram_tweet_members(chat_id) ON DELETE CASCADE,
          FOREIGN KEY(web_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_tweet_tickets_expiry "
        "ON telegram_tweet_tickets(expires_at, used_at)"
    )
    columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(telegram_tweet_tickets)").fetchall()}
    if "session_token_hash" not in columns:
        conn.execute("ALTER TABLE telegram_tweet_tickets ADD COLUMN session_token_hash TEXT NOT NULL DEFAULT ''")


def _mask_token(token: str) -> str:
    clean = str(token or "").strip()
    if not clean:
        return ""
    return "••••" if len(clean) <= 10 else f"{clean[:6]}••••{clean[-4:]}"


def _resolve_web_user(conn, value: int | str):
    raw = str(value or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="请填写 VECTO 用户 ID 或用户名")
    if raw.isdigit():
        row = conn.execute("SELECT * FROM users WHERE id = ?", (int(raw),)).fetchone()
    else:
        row = conn.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (raw,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="找不到对应的 VECTO 用户")
    if int(row["is_disabled"] or 0) or int(row["deleted_at"] or 0):
        raise HTTPException(status_code=400, detail="该 VECTO 用户已停用或删除")
    if not int(row["is_admin"] or 0) and str(row["approval_status"] or "") != "approved":
        raise HTTPException(status_code=400, detail="该 VECTO 用户尚未通过审核")
    if str(row["lifecycle_status"] or "active") != "active":
        raise HTTPException(status_code=400, detail="该 VECTO 用户当前不可用")
    return row


def _resolve_chat_id(token: str, chat_ref: int | str) -> tuple[int, str, str]:
    raw = str(chat_ref or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="请填写 Telegram Chat ID 或 @用户名")
    profile: dict[str, Any] | None = None
    try:
        numeric_id = int(raw)
    except ValueError:
        numeric_id = 0
    if token:
        try:
            profile = fetch_telegram_chat_profile(token, numeric_id or raw)
        except Exception as exc:
            if not numeric_id:
                raise HTTPException(status_code=400, detail=f"无法读取该 Telegram 用户：{exc}") from exc
            logger.info("Telegram tweet member profile lookup deferred for %s: %s", raw, exc)
    chat_id = int((profile or {}).get("chat_id") or numeric_id or 0)
    if chat_id <= 0:
        raise HTTPException(status_code=400, detail="推文工作台只允许绑定私聊用户的正数 Chat ID")
    return (
        chat_id,
        str((profile or {}).get("username") or "").strip().lstrip("@"),
        str((profile or {}).get("display_name") or "").strip(),
    )


def _member_payload(row) -> dict[str, Any]:
    return {
        "chat_id": int(row["chat_id"]),
        "web_user_id": int(row["web_user_id"]),
        "web_username": str(row["web_username"] or ""),
        "label": str(row["label"] or ""),
        "tg_username": str(row["tg_username"] or ""),
        "tg_display_name": str(row["tg_display_name"] or ""),
        "enabled": bool(row["enabled"]),
        "created_at": float(row["created_at"] or 0),
        "updated_at": float(row["updated_at"] or 0),
    }


def _list_members() -> list[dict[str, Any]]:
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        rows = conn.execute(
            """
            SELECT m.*, u.username AS web_username
            FROM telegram_tweet_members AS m
            JOIN users AS u ON u.id = m.web_user_id
            ORDER BY m.enabled DESC, m.chat_id ASC
            """
        ).fetchall()
    return [_member_payload(row) for row in rows]


def _load_enabled_member(chat_id: int):
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        row = conn.execute(
            """
            SELECT m.*, u.username AS web_username, u.is_admin, u.is_disabled,
                   u.approval_status, u.lifecycle_status, u.deleted_at
            FROM telegram_tweet_members AS m
            JOIN users AS u ON u.id = m.web_user_id
            WHERE m.chat_id = ? AND m.enabled = 1
            """,
            (int(chat_id),),
        ).fetchone()
    if not row:
        return None
    if int(row["is_disabled"] or 0) or int(row["deleted_at"] or 0):
        return None
    if str(row["lifecycle_status"] or "active") != "active":
        return None
    if not int(row["is_admin"] or 0) and str(row["approval_status"] or "") != "approved":
        return None
    return row


def load_tweet_tg_settings(get_runtime: GetRuntime) -> dict[str, Any]:
    runtime = get_runtime() or {}
    token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
    with _BOT_LOCK:
        status = dict(_BOT_STATUS)
    return {
        "ok": True,
        "bot_token_configured": bool(token),
        "bot_token_masked": _mask_token(token),
        "bot_token_length": len(token),
        "bot_enabled": bool(runtime.get("telegram_tweet_bot_enabled")),
        "content_settings_enabled": bool(runtime.get("telegram_tweet_content_settings_enabled")),
        "public_base_url": str(runtime.get("telegram_tweet_public_base_url") or DEFAULT_PUBLIC_BASE_URL).rstrip("/"),
        "bot_running": bool(status.get("running")),
        "bot_username": str(status.get("bot_username") or ""),
        "bot_last_error": str(status.get("last_error") or ""),
        "trusted_users": _list_members(),
    }


def save_tweet_tg_env(payload: TweetTgEnvPayload, get_runtime: GetRuntime, save_runtime: SaveRuntime) -> dict[str, Any]:
    runtime = dict(get_runtime() or {})
    updates: dict[str, Any] = {}
    if payload.bot_token is not None:
        token = str(payload.bot_token or "").strip()
        if "•" in token or "***" in token:
            raise HTTPException(status_code=400, detail="请提交完整的推文 Bot Token，不要提交掩码")
        if token:
            verify_bot_token(token)
        updates["telegram_tweet_bot_token"] = token
        if not token and payload.bot_enabled is None:
            updates["telegram_tweet_bot_enabled"] = False
    if payload.bot_enabled is not None:
        updates["telegram_tweet_bot_enabled"] = bool(payload.bot_enabled)
    if payload.content_settings_enabled is not None:
        updates["telegram_tweet_content_settings_enabled"] = bool(payload.content_settings_enabled)
    if payload.public_base_url is not None:
        public_base = str(payload.public_base_url or "").strip().rstrip("/")
        if not public_base.startswith("https://"):
            raise HTTPException(status_code=400, detail="Telegram WebApp 公网地址必须使用 https://")
        updates["telegram_tweet_public_base_url"] = public_base
    if not updates:
        raise HTTPException(status_code=400, detail="请至少填写一项需要更新的推文 Bot 配置")
    next_runtime = dict(runtime)
    next_runtime.update(updates)
    token = str(next_runtime.get("telegram_tweet_bot_token") or "").strip()
    if bool(next_runtime.get("telegram_tweet_bot_enabled")) and not token:
        raise HTTPException(status_code=400, detail="启用轮询前必须配置推文 Bot Token")
    video_token = str(next_runtime.get("telegram_bot_token") or "").strip()
    if token and video_token and secrets.compare_digest(token, video_token):
        raise HTTPException(status_code=400, detail="推文 Bot 不能与视频工作台共用同一个 Token")
    if bool(next_runtime.get("telegram_tweet_bot_enabled")):
        verify_bot_token(token)
    save_runtime(next_runtime)
    reload_tweet_telegram_bot_worker(get_runtime)
    return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime), "restart_required": False}


def upsert_tweet_member(payload: TweetTgMemberPayload, get_runtime: GetRuntime) -> None:
    runtime = get_runtime() or {}
    token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
    chat_id, tg_username, tg_display_name = _resolve_chat_id(token, payload.chat_id)
    now = time.time()
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        web_user = _resolve_web_user(conn, payload.web_user)
        existing = conn.execute(
            "SELECT * FROM telegram_tweet_members WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        label = str(payload.label or "").strip()
        if not label and existing:
            label = str(existing["label"] or "").strip()
        label = label or tg_display_name or (f"@{tg_username}" if tg_username else f"TG-{chat_id}")
        if existing:
            if int(existing["web_user_id"] or 0) != int(web_user["id"]) or not payload.enabled:
                reason = "telegram_tweet_member_rebound" if payload.enabled else "telegram_tweet_member_disabled"
                _revoke_member_sessions(conn, chat_id, reason)
            conn.execute(
                """
                UPDATE telegram_tweet_members
                SET web_user_id = ?, label = ?, tg_username = ?, tg_display_name = ?, enabled = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (int(web_user["id"]), label, tg_username or str(existing["tg_username"] or ""),
                 tg_display_name or str(existing["tg_display_name"] or ""), 1 if payload.enabled else 0, now, chat_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO telegram_tweet_members(
                  chat_id, web_user_id, label, tg_username, tg_display_name, enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (chat_id, int(web_user["id"]), label, tg_username, tg_display_name,
                 1 if payload.enabled else 0, now, now),
            )


def _create_ticket(chat_id: int, route_key: str, get_runtime: GetRuntime) -> str:
    if route_key not in _ROUTES:
        raise RuntimeError("unsupported Telegram workbench route")
    runtime = get_runtime() or {}
    if route_key == "content_settings" and not bool(runtime.get("telegram_tweet_content_settings_enabled")):
        raise RuntimeError("内容设置尚未开放")
    member = _load_enabled_member(chat_id)
    if not member:
        raise RuntimeError("该 Telegram 用户未获授权或绑定账号不可用")
    token = secrets.token_urlsafe(32)
    now = time.time()
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        conn.execute(
            """
            DELETE FROM telegram_tweet_tickets
            WHERE (used_at = 0 AND expires_at < ?)
               OR (used_at > 0 AND used_at < ?)
            """,
            (now - 3600, now - SESSION_TTL_SECONDS - 3600),
        )
        conn.execute(
            """
            INSERT INTO telegram_tweet_tickets(token_hash, chat_id, web_user_id, route_key, expires_at, used_at, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            """,
            (digest, int(chat_id), int(member["web_user_id"]), route_key, now + TICKET_TTL_SECONDS, now),
        )
    public_base = str(runtime.get("telegram_tweet_public_base_url") or DEFAULT_PUBLIC_BASE_URL).strip().rstrip("/")
    if not public_base.startswith("https://"):
        raise RuntimeError("Telegram WebApp 公网地址必须使用 https://")
    return f"{public_base}/telegram/tweet/open?{urlencode({'ticket': token})}"


def _revoke_member_sessions(conn, chat_id: int, reason: str) -> None:
    now = int(time.time())
    conn.execute(
        """
        UPDATE sessions
        SET revoked_at = ?, revoke_reason = ?
        WHERE revoked_at = 0 AND token IN (
          SELECT session_token_hash FROM telegram_tweet_tickets
          WHERE chat_id = ? AND session_token_hash != ''
        )
        """,
        (now, str(reason or "telegram_tweet_member_revoked")[:160], int(chat_id)),
    )


def _ticket_chat_id(token: str) -> int:
    clean = str(token or "").strip()
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        row = conn.execute(
            "SELECT chat_id, expires_at, used_at FROM telegram_tweet_tickets WHERE token_hash = ?",
            (digest,),
        ).fetchone()
    if not row or float(row["used_at"] or 0) > 0 or float(row["expires_at"] or 0) < time.time():
        raise HTTPException(status_code=410, detail="Telegram 工作台入口已失效，请回到 Bot 重新打开")
    return int(row["chat_id"])


def _validate_telegram_init_data(init_data: str, bot_token: str, expected_chat_id: int) -> None:
    try:
        values = dict(parse_qsl(str(init_data or ""), keep_blank_values=True, strict_parsing=True))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效") from exc
    received_hash = str(values.pop("hash", "") or "").strip().lower()
    if not received_hash:
        raise HTTPException(status_code=401, detail="缺少 Telegram 身份签名")
    data_check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret_key = hmac.new(b"WebAppData", str(bot_token or "").encode("utf-8"), hashlib.sha256).digest()
    calculated = hmac.new(secret_key, data_check.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated, received_hash):
        raise HTTPException(status_code=401, detail="Telegram 身份签名无效")
    try:
        auth_date = int(values.get("auth_date") or 0)
        user = json.loads(values.get("user") or "{}")
        user_id = int(user.get("id") or 0)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效") from exc
    if auth_date <= 0 or abs(int(time.time()) - auth_date) > 600:
        raise HTTPException(status_code=401, detail="Telegram 身份数据已过期")
    if user_id != int(expected_chat_id):
        raise HTTPException(status_code=403, detail="Telegram 用户与授权成员不一致")


def _is_tweet_web_session(raw_token: str) -> bool:
    clean = str(raw_token or "").strip()
    if not clean:
        return False
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        row = conn.execute(
            """
            SELECT 1 FROM telegram_tweet_tickets AS t
            JOIN sessions AS s ON s.token = t.session_token_hash
            WHERE t.session_token_hash = ? AND s.revoked_at = 0 AND s.expires_at > ?
            LIMIT 1
            """,
            (session_storage_token(clean), int(time.time())),
        ).fetchone()
    return row is not None


def _consume_ticket(
    token: str,
    get_runtime: GetRuntime,
    *,
    request: Request | None = None,
) -> tuple[int, str] | tuple[int, str, str]:
    clean = str(token or "").strip()
    if not clean:
        raise HTTPException(status_code=400, detail="缺少 Telegram 工作台凭证")
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    now = time.time()
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        row = conn.execute(
            """
            SELECT t.*, m.enabled AS member_enabled, u.is_admin, u.is_disabled,
                   u.approval_status, u.lifecycle_status, u.deleted_at
            FROM telegram_tweet_tickets AS t
            JOIN telegram_tweet_members AS m ON m.chat_id = t.chat_id AND m.web_user_id = t.web_user_id
            JOIN users AS u ON u.id = t.web_user_id
            WHERE t.token_hash = ?
            """,
            (digest,),
        ).fetchone()
        if not row or float(row["used_at"] or 0) > 0 or float(row["expires_at"] or 0) < now:
            raise HTTPException(status_code=410, detail="Telegram 工作台入口已失效，请回到 Bot 重新打开")
        if not int(row["member_enabled"] or 0) or int(row["is_disabled"] or 0) or int(row["deleted_at"] or 0):
            raise HTTPException(status_code=403, detail="该 Telegram 成员或 VECTO 账号已停用")
        if str(row["lifecycle_status"] or "active") != "active":
            raise HTTPException(status_code=403, detail="该 VECTO 账号当前不可用")
        if not int(row["is_admin"] or 0) and str(row["approval_status"] or "") != "approved":
            raise HTTPException(status_code=403, detail="该 VECTO 账号尚未通过审核")
        route_key = str(row["route_key"] or "")
        route = _ROUTES.get(route_key)
        if not route:
            raise HTTPException(status_code=400, detail="Telegram 工作台入口无效")
        if route_key == "content_settings" and not bool((get_runtime() or {}).get("telegram_tweet_content_settings_enabled")):
            raise HTTPException(status_code=403, detail="内容设置尚未开放")
        updated = conn.execute(
            "UPDATE telegram_tweet_tickets SET used_at = ? WHERE token_hash = ? AND used_at = 0",
            (now, digest),
        )
        if int(updated.rowcount or 0) != 1:
            raise HTTPException(status_code=410, detail="Telegram 工作台入口已使用")
        session_token = (
            create_session(
                conn,
                int(row["web_user_id"]),
                ttl_seconds=SESSION_TTL_SECONDS,
                request=request,
            )
            if request is not None
            else ""
        )
        if session_token:
            conn.execute(
                "UPDATE telegram_tweet_tickets SET session_token_hash = ? WHERE token_hash = ?",
                (session_storage_token(session_token), digest),
            )
    result = (int(row["web_user_id"]), route[1])
    return (*result, session_token) if request is not None else result


async def _run_bot(get_runtime: GetRuntime) -> None:
    from aiogram import Bot, Dispatcher, F
    from aiogram.filters import Command
    from aiogram.types import BotCommand, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

    current_bot: Bot | None = None
    dispatcher: Dispatcher | None = None
    while not _BOT_STOP.is_set():
        runtime = get_runtime() or {}
        token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
        enabled = bool(runtime.get("telegram_tweet_bot_enabled"))
        if not token or not enabled:
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": False, "last_error": "未启用或未配置 Token", "updated_at": time.time()})
            await asyncio.sleep(3)
            continue
        try:
            me = verify_bot_token(token)
            current_bot = Bot(token=token)
            dispatcher = Dispatcher()

            async def authorized_member(chat, from_user, reply) -> Any:
                chat_id = int(chat.id)
                if str(chat.type or "") != "private" or from_user is None or int(from_user.id) != chat_id:
                    await reply("推文工作台仅支持与 Bot 私聊使用，请不要在群组或频道中打开。")
                    return None
                member = _load_enabled_member(chat_id)
                if not member:
                    await reply(f"当前 Chat ID：{chat_id}\n该账号尚未由管理员绑定到 VECTO 用户。")
                    return None
                return member

            def main_keyboard(chat_id: int) -> InlineKeyboardMarkup:
                return InlineKeyboardMarkup(inline_keyboard=[
                    [InlineKeyboardButton(text="我的人设", callback_data="tw:personas"),
                     InlineKeyboardButton(text="推文生成", callback_data="tw:content")],
                    [InlineKeyboardButton(text="发布与自动化", callback_data="tw:publish"),
                     InlineKeyboardButton(text="账号与浏览器", callback_data="tw:accounts")],
                    [InlineKeyboardButton(text="任务中心", callback_data="tw:tasks")],
                    [InlineKeyboardButton(text="打开完整工作台", web_app=WebAppInfo(url=_create_ticket(chat_id, "home", get_runtime)))],
                ])

            def section_keyboard(chat_id: int, section: str) -> InlineKeyboardMarkup:
                _title, entries = _SECTION_MENUS[section]
                rows = [
                    [InlineKeyboardButton(text=label, web_app=WebAppInfo(url=_create_ticket(chat_id, route_key, get_runtime)))]
                    for label, route_key in entries
                ]
                if section == "personas" and bool((get_runtime() or {}).get("telegram_tweet_content_settings_enabled")):
                    rows.append([InlineKeyboardButton(
                        text="内容设置",
                        web_app=WebAppInfo(url=_create_ticket(chat_id, "content_settings", get_runtime)),
                    )])
                rows.append([InlineKeyboardButton(text="返回主菜单", callback_data="tw:menu")])
                return InlineKeyboardMarkup(inline_keyboard=rows)

            async def send_menu(message: Message) -> None:
                chat_id = int(message.chat.id)
                member = await authorized_member(message.chat, message.from_user, message.answer)
                if not member:
                    return
                username = str(message.from_user.username or "") if message.from_user else ""
                display = " ".join(
                    value for value in (
                        str(message.from_user.first_name or "") if message.from_user else "",
                        str(message.from_user.last_name or "") if message.from_user else "",
                    ) if value
                ).strip()
                if username or display:
                    with db() as conn:
                        ensure_tweet_telegram_schema(conn)
                        conn.execute(
                            "UPDATE telegram_tweet_members SET tg_username = ?, tg_display_name = ?, updated_at = ? WHERE chat_id = ?",
                            (username, display, time.time(), chat_id),
                        )
                await message.answer(
                    f"已绑定 VECTO 用户：{member['web_username']}\n请选择功能分类。每个工作台入口 3 分钟内有效且仅可使用一次。",
                    reply_markup=main_keyboard(chat_id),
                )

            async def handle_navigation(query: CallbackQuery) -> None:
                if query.message is None:
                    await query.answer("消息已失效", show_alert=True)
                    return
                member = await authorized_member(query.message.chat, query.from_user, query.answer)
                if not member:
                    return
                section = str(query.data or "").removeprefix("tw:")
                if section == "menu":
                    await query.message.edit_text(
                        f"已绑定 VECTO 用户：{member['web_username']}\n请选择功能分类。",
                        reply_markup=main_keyboard(int(query.message.chat.id)),
                    )
                    await query.answer()
                    return
                if section not in _SECTION_MENUS:
                    await query.answer("未知菜单", show_alert=True)
                    return
                title, _entries = _SECTION_MENUS[section]
                await query.message.edit_text(
                    f"{title}\n所有操作继续使用网页端同一份数据、权限、额度和任务队列。",
                    reply_markup=section_keyboard(int(query.message.chat.id), section),
                )
                await query.answer()

            dispatcher.message.register(send_menu, Command("start", "menu", "workbench"))
            dispatcher.message.register(send_menu, F.text)
            dispatcher.callback_query.register(handle_navigation, F.data.startswith("tw:"))
            await current_bot.set_my_commands([
                BotCommand(command="menu", description="打开推文工作台菜单"),
                BotCommand(command="workbench", description="打开完整推文工作台"),
            ])
            polling = asyncio.create_task(dispatcher.start_polling(current_bot, handle_signals=False))
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": True, "last_error": "", "bot_username": str(me.get("username") or ""), "updated_at": time.time()})
            while not _BOT_STOP.is_set() and not polling.done():
                latest = get_runtime() or {}
                if not bool(latest.get("telegram_tweet_bot_enabled")) or str(latest.get("telegram_tweet_bot_token") or "").strip() != token:
                    break
                await asyncio.sleep(2)
            if not polling.done():
                await dispatcher.stop_polling()
            results = await asyncio.gather(polling, return_exceptions=True)
            if results and isinstance(results[0], BaseException):
                raise results[0]
        except Exception as exc:
            logger.exception("Tweet Telegram workbench bot stopped unexpectedly")
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": False, "last_error": str(exc)[:400], "updated_at": time.time()})
            await asyncio.sleep(5)
        finally:
            if current_bot is not None:
                await current_bot.session.close()
            current_bot = None
            dispatcher = None
            with _BOT_LOCK:
                _BOT_STATUS["running"] = False


def _thread_main(get_runtime: GetRuntime) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_run_bot(get_runtime))
    finally:
        loop.close()


def start_tweet_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    global _BOT_THREAD
    with _BOT_LOCK:
        if _BOT_THREAD and _BOT_THREAD.is_alive():
            return
        _BOT_STOP.clear()
        _BOT_THREAD = threading.Thread(target=_thread_main, args=(get_runtime,), name="vecto-tweet-telegram-bot", daemon=True)
        _BOT_THREAD.start()


def stop_tweet_telegram_bot_worker() -> None:
    global _BOT_THREAD
    _BOT_STOP.set()
    with _BOT_LOCK:
        thread = _BOT_THREAD
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=15)
    with _BOT_LOCK:
        if _BOT_THREAD is not None and not _BOT_THREAD.is_alive():
            _BOT_THREAD = None


def reload_tweet_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    # The live worker observes token/enabled changes every two seconds and
    # restarts its dispatcher in the same thread. Avoid a stop/start race when
    # Telegram or DNS is temporarily slower than the admin request.
    start_tweet_telegram_bot_worker(get_runtime)


def inject_tweet_telegram_admin(
    app,
    *,
    require_admin: Callable,
    get_runtime: GetRuntime,
    save_runtime: SaveRuntime,
    session_cookie_secure: Callable[[Request | None], bool],
) -> None:
    router = APIRouter()

    @router.get("/api/admin/tg_tweet/settings")
    def settings(_user: dict[str, Any] = Depends(require_admin)):
        return load_tweet_tg_settings(get_runtime)

    @router.put("/api/admin/tg_tweet/env")
    def save_env(payload: TweetTgEnvPayload, _user: dict[str, Any] = Depends(require_admin)):
        return save_tweet_tg_env(payload, get_runtime, save_runtime)

    @router.post("/api/admin/tg_tweet/env/test")
    def test_env(payload: TweetTgEnvPayload, _user: dict[str, Any] = Depends(require_admin)):
        runtime = get_runtime() or {}
        token = str(payload.bot_token or runtime.get("telegram_tweet_bot_token") or "").strip()
        if not token or "•" in token or "***" in token:
            raise HTTPException(status_code=400, detail="请填写完整 Token，或先保存后再检测")
        return {"ok": True, **verify_bot_token(token)}

    @router.post("/api/admin/tg_tweet/members")
    def save_member(payload: TweetTgMemberPayload, _user: dict[str, Any] = Depends(require_admin)):
        upsert_tweet_member(payload, get_runtime)
        return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime)}

    @router.post("/api/admin/tg_tweet/members/{chat_id}/toggle")
    def toggle_member(chat_id: int, payload: TweetTgMemberTogglePayload, _user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            ensure_tweet_telegram_schema(conn)
            if not payload.enabled:
                _revoke_member_sessions(conn, chat_id, "telegram_tweet_member_disabled")
            updated = conn.execute(
                "UPDATE telegram_tweet_members SET enabled = ?, updated_at = ? WHERE chat_id = ?",
                (1 if payload.enabled else 0, time.time(), int(chat_id)),
            )
            if int(updated.rowcount or 0) != 1:
                raise HTTPException(status_code=404, detail="找不到该推文 Bot 成员")
        return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime)}

    @router.delete("/api/admin/tg_tweet/members/{chat_id}")
    def delete_member(chat_id: int, _user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            ensure_tweet_telegram_schema(conn)
            _revoke_member_sessions(conn, chat_id, "telegram_tweet_member_deleted")
            conn.execute("DELETE FROM telegram_tweet_members WHERE chat_id = ?", (int(chat_id),))
        return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime)}

    @router.get("/telegram/tweet/open")
    def open_workbench(ticket: str):
        _ticket_chat_id(ticket)
        encoded_ticket = json.dumps(str(ticket or ""))
        response = HTMLResponse(
            """<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在验证 Telegram 身份</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script></head>
<body><main><h1>正在打开推文工作台</h1><p id="status">正在验证 Telegram 身份，请稍候…</p></main>
<script>
(async () => {
  const status = document.getElementById("status");
  try {
    const initData = window.Telegram?.WebApp?.initData || "";
    if (!initData) throw new Error("未读取到 Telegram 身份，请从 Bot 菜单重新打开");
    window.Telegram.WebApp.ready();
    const response = await fetch("/telegram/tweet/exchange", {
      method: "POST", credentials: "same-origin",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ticket: TICKET, init_data: initData}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "入口验证失败");
    window.location.replace(payload.target);
  } catch (error) {
    status.textContent = error?.message || String(error);
  }
})();
</script></body></html>""".replace("TICKET", encoded_ticket),
            status_code=200,
        )
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @router.post("/telegram/tweet/exchange")
    def exchange_workbench(payload: TweetTgExchangePayload, request: Request):
        runtime = get_runtime() or {}
        bot_token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
        if not bool(runtime.get("telegram_tweet_bot_enabled")) or not bot_token:
            raise HTTPException(status_code=403, detail="推文 Bot 当前未启用")
        expected_chat_id = _ticket_chat_id(payload.ticket)
        _validate_telegram_init_data(payload.init_data, bot_token, expected_chat_id)
        _user_id, target, session_token = _consume_ticket(payload.ticket, get_runtime, request=request)
        response = JSONResponse({"ok": True, "target": target})
        response.set_cookie(
            SESSION_COOKIE,
            session_token,
            max_age=SESSION_TTL_SECONDS,
            httponly=True,
            secure=bool(session_cookie_secure(request)),
            samesite="lax",
            path="/",
        )
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    app.include_router(router)

    @app.middleware("http")
    async def enforce_tweet_content_settings(request: Request, call_next):
        path = str(request.url.path or "")
        is_profile_write = (
            request.method.upper() == "PATCH"
            and path.startswith("/api/persona_dashboard/personas/")
            and path.endswith("/profile")
        )
        if (
            is_profile_write
            and not bool((get_runtime() or {}).get("telegram_tweet_content_settings_enabled"))
            and _is_tweet_web_session(str(request.cookies.get(SESSION_COOKIE) or ""))
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "管理员尚未为推文 Bot 开放内容设置", "code": "tg_tweet_content_settings_disabled"},
            )
        return await call_next(request)

__all__ = [
    "ensure_tweet_telegram_schema",
    "inject_tweet_telegram_admin",
    "load_tweet_tg_settings",
    "start_tweet_telegram_bot_worker",
    "stop_tweet_telegram_bot_worker",
]
