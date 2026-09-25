from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .auth import (
    ADMIN_SESSION_COOKIE,
    SESSION_COOKIE,
    get_current_user_for_session,
    session_storage_token,
)
from .db import db, get_db_path

logger = logging.getLogger(__name__)

TELEGRAM_API_ROOT = "https://api.telegram.org"
DEFAULT_VIDEO_ENTRY = "/video.html"
DEFAULT_PUBLIC_BASE_URL = "https://www.vecto-ai.cn"
_BOT_LOCK = threading.RLock()
_BOT_STOP = threading.Event()
_BOT_THREAD: threading.Thread | None = None
_BOT_OFFSET = 0
_BOT_STATUS: dict[str, Any] = {
    "running": False,
    "last_error": "",
    "bot_username": "",
    "updated_at": 0.0,
}

GetRuntime = Callable[[], dict[str, Any]]
SaveRuntime = Callable[[dict[str, Any]], None]
VideoChatLoginHandler = Callable[[int, str, str, dict[str, Any], dict[str, Any] | None], Any]

_VIDEO_CHAT_LOGIN: VideoChatLoginHandler | None = None


class TgEnvPayload(BaseModel):
    bot_token: str = ""
    allowed_chat_ids: str = ""
    bot_enabled: bool | None = None
    video_entry_url: str = ""


class TgTrustedUserPayload(BaseModel):
    chat_id: int | str
    label: str = Field(default="", max_length=120)
    enabled: bool = True
    notify_busy: bool = True
    notify_available: bool = True


class TgTrustedUserTogglePayload(BaseModel):
    enabled: bool = True


class VideoTgExchangePayload(BaseModel):
    ticket: str = Field(default="", max_length=256)
    init_data: str = Field(default="", max_length=8192)
    # URL buttons open the normal HTTPS browser instead of Telegram's WebApp
    # surface. The one-time ticket remains the browser hand-off credential.
    browser: bool = False
    # The bridge first previews the signed-in account, then asks the user to
    # explicitly authorize the Telegram workbench before consuming the ticket.
    # Keep the default false for older bridge clients that already completed
    # the one-click flow.
    preview: bool = False


def ensure_telegram_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_trusted_users (
          chat_id INTEGER PRIMARY KEY,
          web_user_id INTEGER NOT NULL DEFAULT 0,
          label TEXT NOT NULL DEFAULT '',
          tg_username TEXT NOT NULL DEFAULT '',
          tg_display_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          notify_busy INTEGER NOT NULL DEFAULT 1 CHECK(notify_busy IN (0, 1)),
          notify_available INTEGER NOT NULL DEFAULT 1 CHECK(notify_available IN (0, 1)),
          linked_session_token_hash TEXT NOT NULL DEFAULT '',
          linked_at REAL NOT NULL DEFAULT 0,
          created_at REAL NOT NULL DEFAULT 0,
          updated_at REAL NOT NULL DEFAULT 0
        )
        """
    )
    columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(telegram_trusted_users)").fetchall()}
    if "tg_username" not in columns:
        conn.execute("ALTER TABLE telegram_trusted_users ADD COLUMN tg_username TEXT NOT NULL DEFAULT ''")
    if "tg_display_name" not in columns:
        conn.execute("ALTER TABLE telegram_trusted_users ADD COLUMN tg_display_name TEXT NOT NULL DEFAULT ''")
    if "web_user_id" not in columns:
        conn.execute("ALTER TABLE telegram_trusted_users ADD COLUMN web_user_id INTEGER NOT NULL DEFAULT 0")
    if "linked_session_token_hash" not in columns:
        conn.execute(
            "ALTER TABLE telegram_trusted_users ADD COLUMN linked_session_token_hash TEXT NOT NULL DEFAULT ''"
        )
    if "linked_at" not in columns:
        conn.execute("ALTER TABLE telegram_trusted_users ADD COLUMN linked_at REAL NOT NULL DEFAULT 0")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_video_link_tickets (
          token_hash TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          route_key TEXT NOT NULL DEFAULT 'home',
          expires_at REAL NOT NULL,
          used_at REAL NOT NULL DEFAULT 0,
          linked_web_user_id INTEGER NOT NULL DEFAULT 0,
          session_token_hash TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_video_link_tickets_expiry "
        "ON telegram_video_link_tickets(expires_at, used_at)"
    )


def _parse_chat_ids(text: str) -> list[int]:
    values: list[int] = []
    for chunk in str(text or "").replace(";", ",").split(","):
        item = chunk.strip()
        if not item:
            continue
        try:
            chat_id = int(item)
        except ValueError:
            continue
        if chat_id != 0:
            values.append(chat_id)
    return list(dict.fromkeys(values))


def _mask_token(token: str) -> str:
    text = str(token or "").strip()
    if not text:
        return ""
    if len(text) <= 10:
        return "••••"
    return f"{text[:6]}••••{text[-4:]}"


def _telegram_api(token: str, method: str, payload: dict[str, Any] | None = None, timeout: int = 20) -> dict[str, Any]:
    clean = str(token or "").strip()
    if not clean:
        raise RuntimeError("尚未配置 Telegram Bot Token")
    url = f"{TELEGRAM_API_ROOT}/bot{urllib.parse.quote(clean, safe='')}/{method}"
    body = json.dumps(payload if payload is not None else {}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "vecto-telegram-admin/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = json.loads(response.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            raw = json.loads(detail or "{}")
        except Exception:
            raise RuntimeError(f"Telegram API {method} 失败：HTTP {exc.code}") from exc
    except Exception as exc:
        raise RuntimeError(f"无法连接 Telegram API：{exc}") from exc
    if not isinstance(raw, dict) or not raw.get("ok"):
        description = ""
        if isinstance(raw, dict):
            description = str(raw.get("description") or raw.get("error_code") or "").strip()
        raise RuntimeError(description or f"Telegram API {method} 未成功")
    result = raw.get("result")
    return result if isinstance(result, dict) or isinstance(result, list) else {}


def verify_bot_token(token: str) -> dict[str, Any]:
    result = _telegram_api(token, "getMe", timeout=12)
    if not isinstance(result, dict):
        raise RuntimeError("Telegram getMe 返回异常")
    username = str(result.get("username") or "").strip()
    return {
        "ok": True,
        "id": result.get("id"),
        "username": username,
        "first_name": str(result.get("first_name") or "").strip(),
    }


def _chat_ref_candidates(chat_ref: int | str) -> list[int | str]:
    if isinstance(chat_ref, int):
        return [chat_ref, str(chat_ref)]
    text = str(chat_ref or "").strip()
    if not text:
        return []
    if text.startswith("@"):
        return [text]
    try:
        chat_id = int(text)
    except ValueError:
        return [text if text.startswith("@") else f"@{text.lstrip('@')}"]
    return [chat_id, str(chat_id)]


def fetch_telegram_chat_profile(token: str, chat_ref: int | str) -> dict[str, Any]:
    last_error: Exception | None = None
    for ref in _chat_ref_candidates(chat_ref):
        try:
            result = _telegram_api(token, "getChat", {"chat_id": ref}, timeout=12)
        except Exception as exc:
            last_error = exc
            continue
        if not isinstance(result, dict):
            last_error = RuntimeError("Telegram getChat 返回异常")
            continue
        username = str(result.get("username") or "").strip().lstrip("@")
        first_name = str(result.get("first_name") or "").strip()
        last_name = str(result.get("last_name") or "").strip()
        title = str(result.get("title") or "").strip()
        display_name = " ".join(part for part in (first_name, last_name) if part).strip() or title
        try:
            resolved_id = int(result.get("id") or 0)
        except (TypeError, ValueError):
            resolved_id = 0
        if not resolved_id:
            last_error = RuntimeError("Telegram getChat 未返回用户 ID")
            continue
        return {"chat_id": resolved_id, "username": username, "display_name": display_name}
    raise last_error or RuntimeError("Telegram getChat 未成功")


def _lookup_member_profile(token: str, chat_ref: int | str) -> dict[str, Any] | None:
    clean = str(token or "").strip()
    if not clean:
        return None
    try:
        return fetch_telegram_chat_profile(clean, chat_ref)
    except Exception as exc:
        logger.warning("Failed to fetch Telegram profile for %s: %s", chat_ref, exc)
        return None


def remember_trusted_user_profile(chat_id: int, *, username: str = "", display_name: str = "") -> None:
    member_id = int(chat_id or 0)
    next_username = str(username or "").strip().lstrip("@")
    next_display = str(display_name or "").strip()
    if not member_id or not (next_username or next_display):
        return
    with db() as conn:
        ensure_telegram_schema(conn)
        row = conn.execute(
            "SELECT tg_username, tg_display_name FROM telegram_trusted_users WHERE chat_id = ?",
            (member_id,),
        ).fetchone()
        if not row:
            return
        current_username = str(row["tg_username"] or "").strip().lstrip("@")
        current_display = str(row["tg_display_name"] or "").strip()
        saved_username = next_username or current_username
        saved_display = next_display or current_display
        if saved_username == current_username and saved_display == current_display:
            return
        conn.execute(
            """
            UPDATE telegram_trusted_users
            SET tg_username = ?, tg_display_name = ?, updated_at = ?
            WHERE chat_id = ?
            """,
            (saved_username, saved_display, time.time(), member_id),
        )


def _member_payload(row) -> dict[str, Any]:
    return {
        "chat_id": int(row["chat_id"]),
        "web_user_id": int(row["web_user_id"] or 0),
        "label": str(row["label"] or ""),
        "tg_username": str(row["tg_username"] or "").strip().lstrip("@"),
        "tg_display_name": str(row["tg_display_name"] or "").strip(),
        "enabled": bool(int(row["enabled"] or 0)),
        "notify_busy": bool(int(row["notify_busy"] or 0)),
        "notify_available": bool(int(row["notify_available"] or 0)),
        "has_linked_session": bool(str(row["linked_session_token_hash"] or "").strip()),
        "linked_at": float(row["linked_at"] or 0),
        "created_at": float(row["created_at"] or 0),
        "updated_at": float(row["updated_at"] or 0),
    }


def _list_members() -> list[dict[str, Any]]:
    with db() as conn:
        ensure_telegram_schema(conn)
        rows = conn.execute(
            """
            SELECT chat_id, web_user_id, label, tg_username, tg_display_name, enabled,
                   notify_busy, notify_available, linked_session_token_hash, linked_at,
                   created_at, updated_at
            FROM telegram_trusted_users
            ORDER BY enabled DESC, chat_id ASC
            """
        ).fetchall()
    return [_member_payload(row) for row in rows]


def _backfill_missing_member_profiles(token: str) -> None:
    clean = str(token or "").strip()
    if not clean:
        return
    for member in _list_members():
        if member.get("tg_username") or member.get("tg_display_name"):
            continue
        profile = _lookup_member_profile(clean, int(member["chat_id"]))
        if not profile or not (profile.get("username") or profile.get("display_name")):
            continue
        with db() as conn:
            ensure_telegram_schema(conn)
            conn.execute(
                """
                UPDATE telegram_trusted_users
                SET tg_username = ?, tg_display_name = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (profile["username"], profile["display_name"], time.time(), int(member["chat_id"])),
            )


def load_tg_settings(get_runtime: GetRuntime) -> dict[str, Any]:
    runtime = get_runtime() or {}
    token = str(runtime.get("telegram_bot_token") or "").strip()
    allowed = _parse_chat_ids(str(runtime.get("telegram_allowed_chat_ids") or ""))
    enabled = bool(runtime.get("telegram_bot_enabled"))
    entry = str(runtime.get("telegram_video_entry_url") or DEFAULT_VIDEO_ENTRY).strip() or DEFAULT_VIDEO_ENTRY
    with _BOT_LOCK:
        status = dict(_BOT_STATUS)
    _backfill_missing_member_profiles(token)
    return {
        "ok": True,
        "bot_token_configured": bool(token),
        "bot_token_masked": _mask_token(token),
        "bot_token_length": len(token),
        "bot_enabled": enabled,
        "bot_running": bool(status.get("running")),
        "bot_username": str(status.get("bot_username") or ""),
        "bot_last_error": str(status.get("last_error") or ""),
        "allowed_chat_ids_env": allowed,
        "video_entry_url": entry,
        "trusted_users": _list_members(),
    }


def save_tg_env(payload: TgEnvPayload, get_runtime: GetRuntime, save_runtime: SaveRuntime) -> dict[str, Any]:
    runtime = dict(get_runtime() or {})
    updates: dict[str, Any] = {}
    if "bot_token" in payload.model_fields_set:
        token = str(payload.bot_token or "").strip()
        if token:
            if "***" in token or "•" in token:
                raise HTTPException(status_code=400, detail="请填写完整的 Telegram Bot Token，不要提交掩码。")
            verify_bot_token(token)
            updates["telegram_bot_token"] = token
        else:
            updates["telegram_bot_token"] = ""
            if payload.bot_enabled is None:
                updates["telegram_bot_enabled"] = False
    if str(payload.allowed_chat_ids or "").strip() or "allowed_chat_ids" in payload.model_fields_set:
        updates["telegram_allowed_chat_ids"] = ",".join(str(item) for item in _parse_chat_ids(payload.allowed_chat_ids))
    if payload.bot_enabled is not None:
        updates["telegram_bot_enabled"] = bool(payload.bot_enabled)
    entry = str(payload.video_entry_url or "").strip()
    if entry:
        if not entry.startswith("/"):
            raise HTTPException(status_code=400, detail="视频工作台入口必须是站内路径，例如 /video.html")
        updates["telegram_video_entry_url"] = entry
    if not updates:
        raise HTTPException(status_code=400, detail="请至少填写一项需要更新的 Telegram 配置")
    next_runtime = dict(runtime)
    next_runtime.update(updates)
    next_token = str(next_runtime.get("telegram_bot_token") or "").strip()
    if not next_token:
        next_runtime["telegram_bot_enabled"] = False
        updates["telegram_bot_enabled"] = False
    if next_runtime.get("telegram_bot_enabled") and next_token:
        verify_bot_token(next_token)
    save_runtime(next_runtime)
    reload_telegram_bot_worker(get_runtime)
    settings = load_tg_settings(get_runtime)
    settings["restart_required"] = False
    return {"ok": True, "tg_settings": settings}


def upsert_trusted_user(payload: TgTrustedUserPayload, get_runtime: GetRuntime | None = None) -> None:
    raw_ref = payload.chat_id
    chat_id = 0
    username_ref = ""
    if isinstance(raw_ref, int):
        chat_id = raw_ref
    else:
        text = str(raw_ref or "").strip()
        if text.startswith("@"):
            username_ref = text.lstrip("@")
        else:
            try:
                chat_id = int(text)
            except ValueError:
                username_ref = text.lstrip("@")
    token = ""
    if get_runtime is not None:
        token = str((get_runtime() or {}).get("telegram_bot_token") or "").strip()
    profile = None
    if token and username_ref:
        profile = _lookup_member_profile(token, f"@{username_ref}")
        if not profile or not int(profile.get("chat_id") or 0):
            raise HTTPException(status_code=400, detail="无法通过 @用户名读取该 Telegram 用户，请改填 Chat ID，或确认用户名公开且 Bot Token 有效。")
        chat_id = int(profile["chat_id"])
    elif token and chat_id:
        profile = _lookup_member_profile(token, chat_id)
    if chat_id == 0:
        raise HTTPException(status_code=400, detail="请填写有效的 Chat ID 或 @用户名")
    profile_username = str((profile or {}).get("username") or username_ref or "").strip().lstrip("@")
    profile_display = str((profile or {}).get("display_name") or "").strip()
    now = time.time()
    with db() as conn:
        ensure_telegram_schema(conn)
        existing = conn.execute(
            """
            SELECT chat_id, label, tg_username, tg_display_name
            FROM telegram_trusted_users
            WHERE chat_id = ?
            """,
            (chat_id,),
        ).fetchone()
        if existing and not (profile_username or profile_display):
            profile_username = str(existing["tg_username"] or "").strip().lstrip("@")
            profile_display = str(existing["tg_display_name"] or "").strip()
        label = str(payload.label or "").strip()
        if not label:
            if existing and str(existing["label"] or "").strip():
                label = str(existing["label"] or "").strip()
            else:
                label = profile_display or (f"@{profile_username}" if profile_username else f"TG-{chat_id}")
        values = (
            label,
            profile_username,
            profile_display,
            1 if payload.enabled else 0,
            1 if payload.notify_busy else 0,
            1 if payload.notify_available else 0,
            now,
            chat_id,
        )
        if existing:
            conn.execute(
                """
                UPDATE telegram_trusted_users
                SET label = ?, tg_username = ?, tg_display_name = ?, enabled = ?, notify_busy = ?, notify_available = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                values,
            )
        else:
            conn.execute(
                """
                INSERT INTO telegram_trusted_users(
                  chat_id, label, tg_username, tg_display_name, enabled, notify_busy, notify_available, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    label,
                    profile_username,
                    profile_display,
                    1 if payload.enabled else 0,
                    1 if payload.notify_busy else 0,
                    1 if payload.notify_available else 0,
                    now,
                    now,
                ),
            )


def toggle_trusted_user(chat_id: int, enabled: bool) -> None:
    with db() as conn:
        ensure_telegram_schema(conn)
        row = conn.execute("SELECT chat_id FROM telegram_trusted_users WHERE chat_id = ?", (int(chat_id),)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="找不到该 TG 用户 ID")
        conn.execute(
            "UPDATE telegram_trusted_users SET enabled = ?, updated_at = ? WHERE chat_id = ?",
            (1 if enabled else 0, time.time(), int(chat_id)),
        )


def delete_trusted_user(chat_id: int) -> None:
    with db() as conn:
        ensure_telegram_schema(conn)
        conn.execute("DELETE FROM telegram_trusted_users WHERE chat_id = ?", (int(chat_id),))


def _authorized_chat_ids(runtime: dict[str, Any]) -> set[int]:
    allowed = set(_parse_chat_ids(str(runtime.get("telegram_allowed_chat_ids") or "")))
    for member in _list_members():
        if member.get("enabled"):
            allowed.add(int(member["chat_id"]))
    return allowed


def is_video_chat_authorized(chat_id: int, runtime: dict[str, Any] | None = None) -> bool:
    """Read the live video-Bot allow-list without relying on worker cache."""
    member_id = int(chat_id or 0)
    if member_id <= 0:
        return False
    with db() as conn:
        ensure_telegram_schema(conn)
        row = conn.execute(
            "SELECT enabled FROM telegram_trusted_users WHERE chat_id = ?",
            (member_id,),
        ).fetchone()
    # An explicit admin row wins, including a disabled row.  The legacy
    # comma-separated setting remains supported for existing deployments.
    if row is not None:
        return bool(int(row["enabled"] or 0))
    config = runtime if isinstance(runtime, dict) else {}
    return member_id in set(_parse_chat_ids(str(config.get("telegram_allowed_chat_ids") or "")))


VIDEO_LINK_TTL_SECONDS = 180


def configure_video_chat_login(handler: VideoChatLoginHandler | None) -> None:
    """Install the server's normal password-login adapter for the video Bot.

    The video worker lives in its own thread and must not duplicate the web
    authentication policy.  The server registers this callback after its
    ``_login_response`` closure is ready; until then the Bot fails closed.
    """
    global _VIDEO_CHAT_LOGIN
    _VIDEO_CHAT_LOGIN = handler


def get_video_chat_login() -> VideoChatLoginHandler | None:
    return _VIDEO_CHAT_LOGIN


def _video_chat_login_proxy(
    chat_id: int,
    username: str,
    password: str,
    profile: dict[str, Any],
    verification: dict[str, Any] | None = None,
) -> Any:
    handler = get_video_chat_login()
    if handler is None:
        raise RuntimeError("视频 Bot 登录服务尚未就绪，请稍后重试")
    return handler(chat_id, username, password, profile, verification)


def _video_ticket_digest(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def create_video_link_ticket(chat_id: int) -> str:
    member_id = int(chat_id or 0)
    if member_id <= 0:
        raise RuntimeError("Telegram Chat ID 无效")
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        ensure_telegram_schema(conn)
        conn.execute(
            "UPDATE telegram_video_link_tickets SET used_at = ? "
            "WHERE chat_id = ? AND used_at = 0",
            (now, member_id),
        )
        conn.execute(
            "DELETE FROM telegram_video_link_tickets WHERE used_at > 0 OR expires_at < ?",
            (now - 3600,),
        )
        conn.execute(
            """
            INSERT INTO telegram_video_link_tickets(
              token_hash, chat_id, route_key, expires_at, used_at,
              linked_web_user_id, session_token_hash, created_at
            ) VALUES (?, ?, 'home', ?, 0, 0, '', ?)
            """,
            (_video_ticket_digest(token), member_id, now + VIDEO_LINK_TTL_SECONDS, now),
        )
    return token


def _video_ticket_chat_id(token: str, *, conn=None) -> int:
    clean = str(token or "").strip()
    if not clean or len(clean) > 256:
        raise HTTPException(status_code=410, detail="Telegram 视频工作台登录已失效，请回到 Bot 重新开始")
    digest = _video_ticket_digest(clean)
    if conn is None:
        with db() as owned:
            ensure_telegram_schema(owned)
            row = owned.execute(
                "SELECT chat_id, expires_at, used_at FROM telegram_video_link_tickets WHERE token_hash = ?",
                (digest,),
            ).fetchone()
    else:
        ensure_telegram_schema(conn)
        row = conn.execute(
            "SELECT chat_id, expires_at, used_at FROM telegram_video_link_tickets WHERE token_hash = ?",
            (digest,),
        ).fetchone()
    if (
        row is None
        or float(row["used_at"] or 0) > 0
        or float(row["expires_at"] or 0) < time.time()
    ):
        raise HTTPException(status_code=410, detail="Telegram 视频工作台登录已失效，请回到 Bot 重新开始")
    return int(row["chat_id"] or 0)


def _validate_video_init_data(init_data: str, bot_token: str, expected_chat_id: int) -> dict[str, Any]:
    raw = str(init_data or "")
    if len(raw) > 8192:
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效")
    try:
        pairs = urllib.parse.parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效") from exc
    if not pairs or len({key for key, _value in pairs}) != len(pairs):
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效")
    values = dict(pairs)
    received_hash = str(values.pop("hash", "") or "").strip().lower()
    if len(received_hash) != 64 or any(char not in "0123456789abcdef" for char in received_hash):
        raise HTTPException(status_code=401, detail="缺少 Telegram 身份签名")
    data_check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret_key = hmac.new(str(bot_token).encode("utf-8"), b"WebAppData", hashlib.sha256).digest()
    calculated = hmac.new(secret_key, data_check.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated, received_hash):
        raise HTTPException(status_code=401, detail="Telegram 身份签名无效")
    try:
        auth_date = int(values.get("auth_date") or 0)
        tg_user = json.loads(values.get("user") or "{}")
    except (TypeError, ValueError, json.JSONDecodeError, OverflowError) as exc:
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效") from exc
    if not isinstance(tg_user, dict):
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效")
    try:
        user_id = int(tg_user.get("id") or 0)
    except (TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效") from exc
    now = int(time.time())
    if user_id <= 0 or user_id != int(expected_chat_id):
        raise HTTPException(status_code=403, detail="Telegram 用户与绑定入口不一致")
    if auth_date <= 0 or auth_date > now + 60 or now - auth_date > 600:
        raise HTTPException(status_code=401, detail="Telegram 身份数据已过期")
    return {
        "id": user_id,
        "username": str(tg_user.get("username") or "").strip().lstrip("@"),
        "display_name": " ".join(
            part
            for part in (
                str(tg_user.get("first_name") or "").strip(),
                str(tg_user.get("last_name") or "").strip(),
            )
            if part
        ).strip(),
    }


def validate_video_webapp_login_context(
    ticket: str,
    init_data: str,
    runtime: dict[str, Any] | None = None,
    *,
    conn=None,
) -> int:
    config = runtime if isinstance(runtime, dict) else {}
    bot_token = str(config.get("telegram_bot_token") or "").strip()
    if not bool(config.get("telegram_bot_enabled")) or not bot_token:
        raise HTTPException(status_code=403, detail="视频工作台 Bot 当前未启用")
    expected_chat_id = _video_ticket_chat_id(ticket, conn=conn)
    _validate_video_init_data(str(init_data or ""), bot_token, expected_chat_id)
    return expected_chat_id


def validate_video_browser_login_context(
    ticket: str,
    runtime: dict[str, Any] | None = None,
    *,
    conn=None,
) -> int:
    """Validate the one-time ticket used by the external HTTPS browser flow.

    A normal URL button cannot provide Telegram WebApp ``initData``. The
    ticket is still random, short-lived, single-use, and issued only after a
    live allow-list check; re-check the allow-list here so disabling a member
    immediately invalidates an outstanding browser link.
    """
    config = runtime if isinstance(runtime, dict) else {}
    if not bool(config.get("telegram_bot_enabled")) or not str(config.get("telegram_bot_token") or "").strip():
        raise HTTPException(status_code=403, detail="视频工作台 Bot 当前未启用")
    expected_chat_id = _video_ticket_chat_id(ticket, conn=conn)
    if not is_video_chat_authorized(expected_chat_id, config):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "telegram_binding_not_authorized",
                "message": "该 Telegram Chat ID 已不在视频工作台授权列表中，请重新联系管理员。",
            },
        )
    return expected_chat_id


def _video_public_base_url(runtime: dict[str, Any] | None) -> str:
    config = runtime if isinstance(runtime, dict) else {}
    raw = str(
        os.getenv("PUBLIC_BASE_URL")
        or os.getenv("VECTO_PUBLIC_BASE_URL")
        or config.get("telegram_video_public_base_url")
        or DEFAULT_PUBLIC_BASE_URL
    ).strip().rstrip("/")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment:
        raise RuntimeError("Telegram 视频网页登录地址必须使用 https:// 公网地址")
    return raw


def create_video_webapp_url(chat_id: int, get_runtime: GetRuntime) -> str:
    """Create a short-lived HTTPS browser URL for the video account flow.

    The URL contains only a hashed-at-rest, one-time ticket. The Bot sends it
    as a regular URL button so Telegram opens the Vecto HTTPS page in its
    browser surface rather than an embedded WebApp login form.
    """
    runtime = get_runtime() or {}
    if not is_video_chat_authorized(int(chat_id), runtime):
        raise RuntimeError("Telegram Chat ID 尚未加入视频工作台授权列表")
    # Resolve the public origin before creating the one-time ticket, so a bad
    # deployment URL cannot leave an apparently valid ticket behind.
    base = _video_public_base_url(runtime)
    token = create_video_link_ticket(int(chat_id))
    return f"{base}/telegram/video/open?{urllib.parse.urlencode({'ticket': token})}"


def _send_video_authorization_notice(
    runtime: dict[str, Any] | None,
    chat_id: int,
    web_user: dict[str, Any],
) -> None:
    """Send a best-effort authorization receipt to the video Bot chat.

    The browser exchange is the source of truth; this message is deliberately
    out-of-band and must never make a successful binding fail if Telegram is
    temporarily unavailable.  It uses the already-running video Bot token for
    ``sendMessage`` only and does not start another polling worker.
    """
    config = runtime if isinstance(runtime, dict) else {}
    token = str(config.get("telegram_bot_token") or "").strip()
    if not bool(config.get("telegram_bot_enabled")) or not token or int(chat_id or 0) <= 0:
        return
    username = str(web_user.get("username") or "").strip()
    display_name = str(web_user.get("display_name") or "").strip()
    account = username or display_name or f"用户 {int(web_user.get('id') or 0)}"
    payload = {
        "chat_id": int(chat_id),
        "text": (
            "✅ Telegram 视频工作台授权成功\n\n"
            f"VECTO 网页账号：{account}\n"
            "当前 Telegram 账号已完成绑定，网页工作台已打开。\n"
            "如需切换账号，请再次点击「🔐 账号管理」。"
        ),
        "disable_web_page_preview": True,
    }
    request = urllib.request.Request(
        f"{TELEGRAM_API_ROOT}/bot{token}/sendMessage",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read(256)
    except Exception:
        # Telegram acknowledgement is helpful but not part of the binding
        # transaction.  Never turn a successful browser authorization into a
        # visible error because the Bot API is briefly unreachable.
        logger.warning("Unable to send video Telegram authorization receipt", exc_info=True)


def _authenticated_video_web_session(request: Request) -> tuple[dict[str, Any], str]:
    """Resolve the existing normal/admin browser session for video binding."""
    candidates = (
        (SESSION_COOKIE, False),
        (ADMIN_SESSION_COOKIE, True),
    )
    for cookie_name, expected_admin in candidates:
        raw_token = str(request.cookies.get(cookie_name) or "").strip()
        if not raw_token:
            continue
        try:
            user = get_current_user_for_session(
                raw_token,
                expected_admin_session=expected_admin,
                request=request,
            )
        except HTTPException as exc:
            if exc.status_code == 428:
                raise
            continue
        unavailable = (
            int(user.get("is_disabled") or 0) == 1
            or int(user.get("deleted_at") or 0) > 0
            or str(user.get("lifecycle_status") or "active") != "active"
            or (
                int(user.get("is_admin") or 0) != 1
                and str(user.get("approval_status") or "") != "approved"
            )
        )
        if unavailable:
            raise HTTPException(status_code=403, detail="当前 VECTO 账号不可用于 Telegram 视频工作台")
        return user, session_storage_token(raw_token)
    raise HTTPException(
        status_code=401,
        detail={"code": "web_login_required", "message": "请先在此网页完成 VECTO 登录，再返回 Telegram。"},
    )


def invalidate_video_link_ticket(token: str) -> None:
    digest = _video_ticket_digest(token)
    if not digest:
        return
    with db() as conn:
        ensure_telegram_schema(conn)
        conn.execute(
            "UPDATE telegram_video_link_tickets SET used_at = ? WHERE token_hash = ? AND used_at = 0",
            (time.time(), digest),
        )


def consume_video_link_ticket(
    token: str,
    tg_profile: dict[str, Any],
    web_user: dict[str, Any],
    session_hash: str,
    runtime: dict[str, Any] | None = None,
) -> None:
    clean = str(token or "").strip()
    digest = _video_ticket_digest(clean)
    chat_id = int(tg_profile.get("id") or 0)
    web_user_id = int(web_user.get("id") or 0)
    if not clean or len(clean) > 256 or chat_id <= 0 or web_user_id <= 0 or not session_hash:
        raise HTTPException(status_code=400, detail="Telegram 视频绑定参数无效")
    username = str(tg_profile.get("username") or "").strip().lstrip("@")
    display_name = str(tg_profile.get("display_name") or "").strip()
    now = time.time()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        ensure_telegram_schema(conn)
        ticket = conn.execute(
            "SELECT chat_id, expires_at, used_at FROM telegram_video_link_tickets WHERE token_hash = ?",
            (digest,),
        ).fetchone()
        if (
            ticket is None
            or int(ticket["chat_id"] or 0) != chat_id
            or float(ticket["used_at"] or 0) > 0
            or float(ticket["expires_at"] or 0) < now
        ):
            raise HTTPException(status_code=410, detail="Telegram 视频工作台登录已失效，请回到 Bot 重新开始")
        existing = conn.execute(
            "SELECT * FROM telegram_trusted_users WHERE chat_id = ?",
            (chat_id,),
        ).fetchone()
        if existing and not int(existing["enabled"] or 0):
            raise HTTPException(
                status_code=403,
                detail={"code": "telegram_binding_disabled", "message": "该 Telegram 绑定已被管理员停用，请联系管理员处理。"},
            )
        if existing is None:
            legacy_allowed = chat_id in set(
                _parse_chat_ids(str((runtime or {}).get("telegram_allowed_chat_ids") or ""))
            )
            if not legacy_allowed:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "telegram_binding_not_authorized",
                        "message": "该 Telegram Chat ID 尚未加入视频工作台授权列表，请联系管理员处理。",
                    },
                )
        old_user_id = int(existing["web_user_id"] or 0) if existing else 0
        if existing and old_user_id and old_user_id != web_user_id:
            linked_hash = str(existing["linked_session_token_hash"] or "").strip()
            active_old = conn.execute(
                "SELECT 1 FROM sessions WHERE token = ? AND revoked_at = 0 AND expires_at > ? LIMIT 1",
                (linked_hash, int(now)),
            ).fetchone() if linked_hash else conn.execute(
                "SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at = 0 AND expires_at > ? LIMIT 1",
                (old_user_id, int(now)),
            ).fetchone()
            if active_old is not None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "telegram_already_bound",
                        "message": "该 Telegram 账号已绑定其他 VECTO 账号，请先退出原账号后再切换。",
                    },
                )
            if linked_hash:
                conn.execute(
                    "UPDATE sessions SET revoked_at = ?, revoke_reason = 'telegram_video_member_rebound' "
                    "WHERE token = ? AND revoked_at = 0",
                    (int(now), linked_hash),
                )
        conn.execute(
            "UPDATE telegram_video_link_tickets SET used_at = ? WHERE chat_id = ? AND used_at = 0 AND token_hash != ?",
            (now, chat_id, digest),
        )
        current_label = str(existing["label"] or "").strip() if existing else ""
        current_username = str(existing["tg_username"] or "").strip().lstrip("@") if existing else ""
        current_display = str(existing["tg_display_name"] or "").strip() if existing else ""
        label = current_label or display_name or (f"@{username}" if username else f"TG-{chat_id}")
        next_username = username or current_username
        next_display = display_name or current_display
        if existing:
            conn.execute(
                """
                UPDATE telegram_trusted_users
                SET web_user_id = ?, label = ?, tg_username = ?, tg_display_name = ?,
                    enabled = 1, linked_session_token_hash = ?, linked_at = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (web_user_id, label, next_username, next_display, session_hash, now, now, chat_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO telegram_trusted_users(
                  chat_id, web_user_id, label, tg_username, tg_display_name, enabled,
                  linked_session_token_hash, linked_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (chat_id, web_user_id, label, next_username, next_display, session_hash, now, now, now),
            )
        updated = conn.execute(
            "UPDATE telegram_video_link_tickets SET used_at = ?, linked_web_user_id = ?, session_token_hash = ? "
            "WHERE token_hash = ? AND used_at = 0",
            (now, web_user_id, session_hash, digest),
        )
        if int(updated.rowcount or 0) != 1:
            raise HTTPException(status_code=410, detail="Telegram 视频工作台登录已使用")


def load_video_member(chat_id: int):
    with db() as conn:
        ensure_telegram_schema(conn)
        row = conn.execute(
            """
            SELECT m.*, u.username AS web_username, u.is_admin, u.is_disabled,
                   u.approval_status, u.lifecycle_status, u.deleted_at
            FROM telegram_trusted_users AS m
            LEFT JOIN users AS u ON u.id = m.web_user_id
            WHERE m.chat_id = ? AND m.enabled = 1
            """,
            (int(chat_id),),
        ).fetchone()
    if row is None:
        return None
    if int(row["web_user_id"] or 0) and row["web_username"] is not None:
        if int(row["is_disabled"] or 0) or int(row["deleted_at"] or 0):
            return None
        if str(row["lifecycle_status"] or "active") != "active":
            return None
        if not int(row["is_admin"] or 0) and str(row["approval_status"] or "") != "approved":
            return None
    return row


def video_member_has_active_web_session(member: Any) -> bool:
    try:
        user_id = int(member["web_user_id"] or 0)
    except (KeyError, TypeError, ValueError):
        return False
    if user_id <= 0:
        # Legacy administrator whitelist rows are migration metadata only; a
        # real VECTO web user/session is required to unlock the video Bot.
        return False
    linked_hash = str(member["linked_session_token_hash"] or "").strip()
    now = int(time.time())
    with db() as conn:
        if linked_hash:
            row = conn.execute(
                "SELECT 1 FROM sessions WHERE token = ? AND user_id = ? AND revoked_at = 0 AND expires_at > ? LIMIT 1",
                (linked_hash, user_id, now),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at = 0 AND expires_at > ? LIMIT 1",
                (user_id, now),
            ).fetchone()
    return row is not None


def logout_video_member(chat_id: int) -> dict[str, Any]:
    member_id = int(chat_id or 0)
    if member_id <= 0:
        return {"ok": False, "message": "Telegram Chat ID 无效"}
    now = time.time()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        ensure_telegram_schema(conn)
        row = conn.execute(
            "SELECT web_user_id, linked_session_token_hash, enabled FROM telegram_trusted_users WHERE chat_id = ?",
            (member_id,),
        ).fetchone()
        if row is None:
            return {"ok": True, "bound": False}
        web_user_id = int(row["web_user_id"] or 0)
        if web_user_id <= 0:
            return {"ok": True, "bound": False, "legacy_authorized": bool(int(row["enabled"] or 0))}
        # Match the Tweet workbench: leaving the VECTO account revokes all
        # active sessions for that user, so browser and Telegram state cannot
        # drift apart.  The Telegram member row stays as a re-login marker.
        conn.execute(
            "UPDATE sessions SET revoked_at = ?, revoke_reason = 'telegram_video_logout' "
            "WHERE user_id = ? AND revoked_at = 0",
            (int(now), web_user_id),
        )
        conn.execute(
            "UPDATE telegram_video_link_tickets SET used_at = ? WHERE chat_id = ? AND used_at = 0",
            (now, member_id),
        )
        conn.execute(
            "UPDATE telegram_trusted_users "
            "SET linked_session_token_hash = '', linked_at = 0, updated_at = ? "
            "WHERE chat_id = ?",
            (now, member_id),
        )
    return {"ok": True, "bound": True, "web_user_id": web_user_id}


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _prepare_bot_env() -> None:
    data_dir = str(os.getenv("WEBAPP_DATA_DIR") or "").strip() or str((_project_root() / "webapp_data").resolve())
    os.environ.setdefault("WEBAPP_DATA_DIR", data_dir)
    os.environ["WEBAPP_DB_PATH"] = get_db_path()
    port = str(os.getenv("WEBAPP_PORT") or "8001").strip() or "8001"
    os.environ.setdefault("TG_INTERNAL_WEBAPP_BASE_URL", f"http://127.0.0.1:{port}")
    os.environ.setdefault("TG_INTERNAL_API_TOKEN", "vecto-local-tg-internal")


def _build_original_app_config(runtime: dict[str, Any]):
    from .digital_human_tg_bot.config import AppConfig, DEFAULT_SCRIPT_TEXT, DEFAULT_ASSET_ROOT

    token = str(runtime.get("telegram_bot_token") or "").strip()
    seed_ids = tuple(_authorized_chat_ids(runtime))
    root = _project_root()
    data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR") or (root / "webapp_data"))).expanduser().resolve()
    jobs_dir = (data_dir / "tg_jobs").resolve()
    database_path = Path(str(os.getenv("TG_WORKBENCH_DB_PATH") or (data_dir / "workbench.db"))).expanduser().resolve()
    jobs_dir.mkdir(parents=True, exist_ok=True)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    public_base = str(runtime.get("telegram_video_entry_url") or DEFAULT_VIDEO_ENTRY).strip() or DEFAULT_VIDEO_ENTRY
    if public_base.startswith("/"):
        site = str(os.getenv("PUBLIC_BASE_URL") or os.getenv("VECTO_PUBLIC_BASE_URL") or "https://www.vecto-ai.cn").strip().rstrip("/")
        public_base = f"{site}{public_base}"
    runninghub_key = str(
        runtime.get("video_runninghub_api_key")
        or runtime.get("runninghub_api_key")
        or os.getenv("ENGINE_API_KEY")
        or os.getenv("RUNNINGHUB_API_KEY")
        or ""
    ).strip()
    return AppConfig(
        project_root=root,
        data_dir=data_dir,
        jobs_dir=jobs_dir,
        database_path=database_path,
        templates_dir=(root / "templates").resolve(),
        static_dir=(root / "webapp" / "static").resolve(),
        app_title=str(runtime.get("app_title") or "视频工作台").strip() or "视频工作台",
        web_host="127.0.0.1",
        web_port=int(str(os.getenv("WEBAPP_PORT") or "8001").strip() or "8001"),
        public_base_url=public_base,
        runtime_config_path=Path(str(os.getenv("APP_RUNTIME_CONFIG_PATH") or (data_dir / "runtime_config.json"))).expanduser().resolve(),
        tg_bot_token=token,
        tg_seed_chat_ids=seed_ids,
        runninghub_api_key=runninghub_key or "unset",
        audio_workflow_id=str(runtime.get("video_create_audio_app_id") or runtime.get("create_audio_app_id") or "").strip(),
        video_workflow_id=str(runtime.get("video_create_video_app_id") or runtime.get("create_video_app_id") or "").strip(),
        source_video_path=Path(DEFAULT_ASSET_ROOT) / "擷取視頻.mp4",
        extracted_audio_path=Path(DEFAULT_ASSET_ROOT) / "擷取音頻.mp4",
        avatar_image_path=Path(DEFAULT_ASSET_ROOT) / "數字人照片.jpg",
        cloned_audio_path=Path(DEFAULT_ASSET_ROOT) / "口播文案音頻1.flac",
        final_video_path=Path(DEFAULT_ASSET_ROOT) / "結果1.mp4",
        default_script_text=DEFAULT_SCRIPT_TEXT,
        poll_interval_seconds=5.0,
    )


def _sync_store_members(service, runtime: dict[str, Any]) -> None:
    service.store.init_db()
    seed = tuple(_authorized_chat_ids(runtime))
    if seed:
        service.store.seed_members(seed)
    for member in _list_members():
        service.upsert_member(
            chat_id=int(member["chat_id"]),
            label=str(member.get("label") or f"TG-{member['chat_id']}"),
            enabled=bool(member.get("enabled")),
            notify_busy=bool(member.get("notify_busy")),
            notify_available=bool(member.get("notify_available")),
        )


async def _run_original_bot(get_runtime: GetRuntime) -> None:
    from .digital_human_tg_bot.bot import TelegramWorkbenchBot
    from .digital_human_tg_bot.storage import WorkspaceStore
    from .digital_human_tg_bot.workbench import WorkspaceService

    _prepare_bot_env()
    current: Any = None
    while not _BOT_STOP.is_set():
        runtime = get_runtime() or {}
        token = str(runtime.get("telegram_bot_token") or "").strip()
        enabled = bool(runtime.get("telegram_bot_enabled"))
        if not token or not enabled:
            if current is not None:
                try:
                    await current.stop()
                except Exception:
                    logger.exception("Failed to stop Telegram bot while disabled")
                current = None
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": False, "last_error": "未启用或未配置 Token", "updated_at": time.time()})
            await asyncio.sleep(5)
            continue
        try:
            me = verify_bot_token(token)
            config = _build_original_app_config(runtime)
            store = WorkspaceStore(config.database_path)
            service = WorkspaceService(config, store)
            _sync_store_members(service, runtime)
            bot = TelegramWorkbenchBot(
                config,
                service,
                load_member=load_video_member,
                has_active_web_session=video_member_has_active_web_session,
                logout_member=logout_video_member,
                web_login_url=lambda chat_id: create_video_webapp_url(int(chat_id), get_runtime),
                chat_authorized=lambda chat_id: is_video_chat_authorized(int(chat_id), get_runtime()),
            )
            await bot.start()
            current = bot
            with _BOT_LOCK:
                _BOT_STATUS.update({
                    "running": True,
                    "last_error": "",
                    "bot_username": str(me.get("username") or ""),
                    "updated_at": time.time(),
                })
            while not _BOT_STOP.is_set():
                latest = get_runtime() or {}
                latest_token = str(latest.get("telegram_bot_token") or "").strip()
                latest_enabled = bool(latest.get("telegram_bot_enabled"))
                if latest_token != token or (not latest_enabled):
                    break
                await asyncio.sleep(2)
        except Exception as exc:
            logger.exception("Original Telegram workbench bot stopped unexpectedly")
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": False, "last_error": str(exc)[:400], "updated_at": time.time()})
            await asyncio.sleep(8)
        finally:
            if current is not None:
                try:
                    await current.stop()
                except Exception:
                    logger.exception("Failed to stop Telegram workbench bot")
                current = None


def _bot_thread_main(get_runtime: GetRuntime) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_run_original_bot(get_runtime))
    finally:
        loop.close()


def start_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    global _BOT_THREAD
    with _BOT_LOCK:
        if _BOT_THREAD and _BOT_THREAD.is_alive():
            return
        _BOT_STOP.clear()
        _BOT_THREAD = threading.Thread(target=_bot_thread_main, args=(get_runtime,), name="vecto-telegram-bot", daemon=True)
        _BOT_THREAD.start()


def stop_telegram_bot_worker() -> None:
    _BOT_STOP.set()


def reload_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    stop_telegram_bot_worker()
    thread = None
    with _BOT_LOCK:
        thread = _BOT_THREAD
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=8)
    start_telegram_bot_worker(get_runtime)


def inject_telegram_admin(
    app,
    *,
    require_admin: Callable,
    get_runtime: GetRuntime,
    save_runtime: SaveRuntime,
) -> None:
    router = APIRouter()

    @router.get("/api/admin/tg_settings")
    def api_admin_tg_settings(_user: dict[str, Any] = Depends(require_admin)):
        return load_tg_settings(get_runtime)

    @router.put("/api/admin/tg_env")
    def api_admin_set_tg_env(payload: TgEnvPayload, _user: dict[str, Any] = Depends(require_admin)):
        return save_tg_env(payload, get_runtime, save_runtime)

    @router.post("/api/admin/tg_env/test")
    def api_admin_test_tg_env(payload: TgEnvPayload, _user: dict[str, Any] = Depends(require_admin)):
        runtime = get_runtime() or {}
        token = str(payload.bot_token or "").strip() or str(runtime.get("telegram_bot_token") or "").strip()
        if not token or "***" in token or "•" in token:
            raise HTTPException(status_code=400, detail="请填写完整 Token，或先保存后再检测。")
        info = verify_bot_token(token)
        return {"ok": True, "username": info.get("username") or "", "id": info.get("id")}

    @router.post("/api/admin/tg_trusted_users")
    def api_admin_upsert_tg_trusted_user(payload: TgTrustedUserPayload, _user: dict[str, Any] = Depends(require_admin)):
        upsert_trusted_user(payload, get_runtime)
        return {"ok": True, "tg_settings": load_tg_settings(get_runtime)}

    @router.post("/api/admin/tg_trusted_users/{chat_id}/toggle")
    def api_admin_toggle_tg_trusted_user(
        chat_id: int,
        payload: TgTrustedUserTogglePayload,
        _user: dict[str, Any] = Depends(require_admin),
    ):
        toggle_trusted_user(chat_id, payload.enabled)
        return {"ok": True, "tg_settings": load_tg_settings(get_runtime)}

    @router.delete("/api/admin/tg_trusted_users/{chat_id}")
    def api_admin_delete_tg_trusted_user(chat_id: int, _user: dict[str, Any] = Depends(require_admin)):
        delete_trusted_user(chat_id)
        return {"ok": True, "tg_settings": load_tg_settings(get_runtime)}

    @router.get("/telegram/video/open")
    def open_video_workbench(ticket: str = ""):
        """Bridge the Telegram browser ticket into the normal video login page."""
        _video_ticket_chat_id(ticket)
        encoded_ticket = json.dumps(str(ticket or ""), ensure_ascii=False)
        response = HTMLResponse(
            """<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>绑定 Telegram 视频工作台</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px;background:#f3f7fa;color:#193247}main{max-width:520px;margin:10vh auto;padding:28px;border:1px solid #cbd8e2;border-radius:16px;background:#fff;box-shadow:0 12px 32px #19324718}h1{font-size:22px;margin:0 0 12px}p{line-height:1.65;color:#52697a}#status{min-height:1.8em}.account{padding:14px 16px;border-radius:10px;background:#eef5f8;color:#193247;font-weight:600}.authorize{width:100%;border:0;border-radius:10px;padding:13px 16px;background:#193247;color:#fff;font-size:16px;font-weight:700;cursor:pointer}.authorize:disabled{opacity:.6;cursor:wait}</style></head>
<body><main><h1>Telegram 视频工作台授权</h1><p id="status">正在验证 Telegram 身份和网页登录状态，请稍候…</p><div id="actions"></div></main>
<script>
(async () => {
  const status = document.getElementById("status");
  const actions = document.getElementById("actions");
  const ticket = TICKET;
  const loginContextKey = "vecto-telegram-video-login-context";
  const loginReturn = "/telegram/video/open?ticket=" + encodeURIComponent(ticket);
  const loginPage = "/video-login.html?return_url=" + encodeURIComponent(loginReturn) + "&telegram_video=1";
  const webApp = window.Telegram?.WebApp;
  const initData = webApp?.initData || "";
  const browser = !initData;
  if (!browser) webApp.ready();

  function showAuthorizationPrompt(payload, authorize) {
    const account = payload?.web_user || {};
    const username = String(account.username || account.display_name || "当前 VECTO 账号");
    status.textContent = "已检测到网页登录状态，请确认将此账号授权给当前 Telegram 视频工作台。";
    actions.replaceChildren();
    const accountLine = document.createElement("p");
    accountLine.className = "account";
    accountLine.textContent = "VECTO 网页账号：" + username;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "authorize";
    button.textContent = "✅ 确认授权并打开视频工作台";
    button.addEventListener("click", () => {
      button.disabled = true;
      authorize(true);
    });
    actions.append(accountLine, button);
  }

  async function exchange(confirm) {
    try {
      status.textContent = confirm ? "正在确认授权，请稍候…" : "正在检查网页登录状态…";
      const response = await fetch("/telegram/video/exchange", {
        method: "POST", credentials: "same-origin",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ticket, init_data: initData, browser, preview: !confirm}),
      });
      const payload = await response.json().catch(() => ({}));
      const detail = payload?.detail;
      if (response.status === 401 && detail?.code === "web_login_required") {
        try {
          sessionStorage.setItem(loginContextKey, JSON.stringify({
            ticket,
            initData,
            browser,
            expiresAt: Date.now() + 150000,
          }));
        } catch (_) {
          throw new Error("当前浏览器不支持安全登录续接，请重新打开授权入口");
        }
        window.location.replace(loginPage);
        return;
      }
      if (!response.ok) throw new Error(detail?.message || detail || "绑定失败");
      if (!confirm && payload.authorization_required) {
        showAuthorizationPrompt(payload, exchange);
        return;
      }
      try { sessionStorage.removeItem(loginContextKey); } catch (_) {}
      status.textContent = "授权成功，正在打开视频工作台…";
      window.location.replace(payload.target || "/video.html");
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  }

  exchange(false);
})();
</script></body></html>""".replace("TICKET", encoded_ticket),
            status_code=200,
        )
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @router.post("/telegram/video/exchange")
    def exchange_video_workbench(
        payload: VideoTgExchangePayload,
        request: Request,
        background_tasks: BackgroundTasks,
    ):
        runtime = get_runtime() or {}
        bot_token = str(runtime.get("telegram_bot_token") or "").strip()
        if not bool(runtime.get("telegram_bot_enabled")) or not bot_token:
            raise HTTPException(status_code=403, detail="视频工作台 Bot 当前未启用")
        expected_chat_id = _video_ticket_chat_id(payload.ticket)
        # Resolve the normal browser session first. An unauthenticated browser
        # is redirected to the standard website login page, including Google
        # OAuth, rather than receiving a second credential flow in Telegram.
        web_user, session_hash = _authenticated_video_web_session(request)
        init_data = str(payload.init_data or "").strip()
        if init_data:
            tg_profile = _validate_video_init_data(init_data, bot_token, expected_chat_id)
        else:
            if not payload.browser:
                raise HTTPException(status_code=401, detail="缺少 Telegram 浏览器授权上下文，请回到 Bot 重新打开入口")
            validate_video_browser_login_context(payload.ticket, runtime)
            tg_profile = {"id": expected_chat_id, "username": "", "display_name": ""}
        if payload.preview:
            return JSONResponse(
                {
                    "ok": True,
                    "authorization_required": True,
                    "web_user": {
                        "id": int(web_user.get("id") or 0),
                        "username": str(web_user.get("username") or ""),
                        "display_name": str(web_user.get("display_name") or ""),
                    },
                }
            )
        consume_video_link_ticket(payload.ticket, tg_profile, web_user, session_hash, runtime)
        background_tasks.add_task(
            _send_video_authorization_notice,
            runtime,
            expected_chat_id,
            web_user,
        )
        target = "/admin-video.html" if int(web_user.get("is_admin") or 0) == 1 else DEFAULT_VIDEO_ENTRY
        response = JSONResponse({"ok": True, "target": target})
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    app.include_router(router)
    start_telegram_bot_worker(get_runtime)
