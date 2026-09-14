from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import secrets
import sqlite3
import threading
import time
import uuid
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .auth import (
    ADMIN_SESSION_COOKIE,
    SESSION_COOKIE,
    get_current_user_for_session,
    session_storage_token,
)
from .db import db
from .telegram_admin import fetch_telegram_chat_profile, verify_bot_token
from .telegram_tweet_bot import TweetWorkbenchOps, ensure_native_bot_schema, run_native_tweet_bot

logger = logging.getLogger(__name__)

DEFAULT_PUBLIC_BASE_URL = "https://www.vecto-ai.cn"
TICKET_TTL_SECONDS = 180
# Telegram profile lookup is enrichment only.  Keep it out of the request's
# critical path when Telegram is slow/unavailable; the underlying helper has a
# longer network timeout and runs in a daemon thread after this bound expires.
PROFILE_LOOKUP_TIMEOUT_SECONDS = 2.0
PROFILE_BACKFILL_MAX_MEMBERS = 3
WEB_SESSION_REQUIRED_MESSAGE = "请先登录 VECTO 网页，再从 Telegram 绑定推文工作台"
WEBAPP_TARGET = "/console.html?view=persona_dashboard"
WEBAPP_ADMIN_TARGET = "/admin-console.html?view=persona_dashboard"

_BOT_LOCK = threading.RLock()
_BOT_STOP = threading.Event()
_BOT_THREAD: threading.Thread | None = None
_BOT_RELOAD_THREAD: threading.Thread | None = None
_BOT_OPS: TweetWorkbenchOps | None = None
_BOT_OWNER_ID = f"{uuid.uuid4().hex}:{threading.get_native_id()}"
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


class TweetTgMemberPayload(BaseModel):
    chat_id: int | str
    label: str = Field(default="", max_length=120)
    enabled: bool = True


class TweetTgMemberTogglePayload(BaseModel):
    enabled: bool = True


class TweetTgExchangePayload(BaseModel):
    ticket: str
    init_data: str


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
          linked_session_token_hash TEXT NOT NULL DEFAULT '',
          linked_at REAL NOT NULL DEFAULT 0,
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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_link_tickets (
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
        "CREATE INDEX IF NOT EXISTS idx_telegram_tweet_link_tickets_expiry "
        "ON telegram_tweet_link_tickets(expires_at, used_at)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_leases (
          name TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at REAL NOT NULL,
          updated_at REAL NOT NULL
        )
        """
    )
    ensure_native_bot_schema(conn)
    member_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(telegram_tweet_members)").fetchall()}

    def add_column_if_missing(column_name: str, statement: str, columns: set[str]) -> None:
        if column_name in columns:
            return
        try:
            conn.execute(statement)
        except sqlite3.OperationalError as exc:
            # Two app threads can initialize the schema at the same time.  A
            # concurrent migration winning the race is safe; any other SQL
            # error must still surface instead of masking a broken schema.
            if "duplicate column name" not in str(exc).lower():
                raise
        columns.add(column_name)

    add_column_if_missing(
        "linked_session_token_hash",
        "ALTER TABLE telegram_tweet_members ADD COLUMN linked_session_token_hash TEXT NOT NULL DEFAULT ''",
        member_columns,
    )
    add_column_if_missing(
        "linked_at",
        "ALTER TABLE telegram_tweet_members ADD COLUMN linked_at REAL NOT NULL DEFAULT 0",
        member_columns,
    )
    columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(telegram_tweet_tickets)").fetchall()}
    add_column_if_missing(
        "session_token_hash",
        "ALTER TABLE telegram_tweet_tickets ADD COLUMN session_token_hash TEXT NOT NULL DEFAULT ''",
        columns,
    )


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


def _resolve_chat_id(chat_ref: int | str) -> int:
    raw = str(chat_ref or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="请填写 Telegram Chat ID")
    try:
        chat_id = int(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Telegram Chat ID 必须是正整数") from None
    if chat_id <= 0:
        raise HTTPException(status_code=400, detail="推文工作台只允许绑定私聊用户的正数 Chat ID")
    return chat_id


def _lookup_tweet_member_profile(token: str, chat_ref: int | str) -> dict[str, Any] | None:
    clean = str(token or "").strip()
    if not clean:
        return None

    # ``fetch_telegram_chat_profile`` performs a network request with its own
    # timeout.  Run that best-effort enrichment in a daemon thread so a stalled
    # Telegram endpoint cannot block saving a member or loading settings.
    result: dict[str, Any] = {}
    error: list[Exception] = []

    def fetch_profile() -> None:
        try:
            result["profile"] = fetch_telegram_chat_profile(clean, chat_ref)
        except Exception as exc:
            error.append(exc)

    worker = threading.Thread(
        target=fetch_profile,
        name="vecto-tweet-telegram-profile",
        daemon=True,
    )
    worker.start()
    worker.join(timeout=PROFILE_LOOKUP_TIMEOUT_SECONDS)
    if worker.is_alive():
        logger.warning(
            "Timed out fetching Telegram tweet member profile for %s",
            chat_ref,
        )
        return None
    if error:
        exc = error[0]
        # Do not put Bot tokens (or an exception URL containing one) into
        # logs; the profile lookup is best-effort and the Chat ID remains
        # usable when Telegram is temporarily unavailable.
        logger.warning(
            "Failed to fetch Telegram tweet member profile for %s: %s",
            chat_ref,
            type(exc).__name__,
        )
        return None
    profile = result.get("profile")
    return profile if isinstance(profile, dict) else None


def _normalise_public_base_url(value: Any) -> str:
    """Return an HTTPS origin/path safe for one-time Telegram links."""
    text = str(value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(text)
        _ = parsed.port  # force validation of an optional numeric port
    except ValueError:
        return ""
    if (
        any(ord(character) < 32 for character in text)
        or parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return urlunsplit(("https", parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _member_payload(row) -> dict[str, Any]:
    return {
        "chat_id": int(row["chat_id"]),
        "web_user_id": int(row["web_user_id"]),
        "web_username": str(row["web_username"] or ""),
        "label": str(row["label"] or ""),
        "tg_username": str(row["tg_username"] or ""),
        "tg_display_name": str(row["tg_display_name"] or ""),
        "enabled": bool(row["enabled"]),
        "linked_at": float(row["linked_at"] or 0),
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


def _backfill_missing_member_profiles(token: str) -> None:
    clean = str(token or "").strip()
    if not clean:
        return
    checked = 0
    for member in _list_members():
        if member.get("tg_username") or member.get("tg_display_name"):
            continue
        if checked >= PROFILE_BACKFILL_MAX_MEMBERS:
            break
        checked += 1
        profile = _lookup_tweet_member_profile(clean, int(member["chat_id"]))
        if not profile or not (profile.get("username") or profile.get("display_name")):
            continue
        with db() as conn:
            ensure_tweet_telegram_schema(conn)
            conn.execute(
                """
                UPDATE telegram_tweet_members
                SET tg_username = ?, tg_display_name = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (
                    str(profile.get("username") or "").strip().lstrip("@"),
                    str(profile.get("display_name") or "").strip(),
                    time.time(),
                    int(member["chat_id"]),
                ),
            )


def remember_tweet_member_profile(chat_id: int, *, username: str = "", display_name: str = "") -> None:
    member_id = int(chat_id or 0)
    next_username = str(username or "").strip().lstrip("@")
    next_display = str(display_name or "").strip()
    if not member_id or not (next_username or next_display):
        return
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        row = conn.execute(
            "SELECT tg_username, tg_display_name FROM telegram_tweet_members WHERE chat_id = ?",
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
            UPDATE telegram_tweet_members
            SET tg_username = ?, tg_display_name = ?, updated_at = ?
            WHERE chat_id = ?
            """,
            (saved_username, saved_display, time.time(), member_id),
        )


def _create_link_ticket(chat_id: int, get_runtime: GetRuntime) -> str:
    """Create a short-lived Telegram WebApp ticket without requiring admin setup.

    The ticket identifies only the Telegram chat.  The VECTO account is resolved
    from the already authenticated browser session during exchange, so a chat
    message can never choose an arbitrary VECTO user.
    """
    member_id = int(chat_id or 0)
    if member_id <= 0:
        raise RuntimeError("Telegram Chat ID 无效")
    runtime = get_runtime() or {}
    public_base = _normalise_public_base_url(
        runtime.get("telegram_tweet_public_base_url") or DEFAULT_PUBLIC_BASE_URL
    )
    if not public_base:
        raise RuntimeError("Telegram WebApp 公网地址必须使用 https://")
    token = secrets.token_urlsafe(32)
    now = time.time()
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with db() as conn:
        # Serialize cleanup + insert so concurrent /bind requests for the
        # same Telegram chat cannot leave more than one live ticket behind.
        conn.execute("BEGIN IMMEDIATE")
        ensure_tweet_telegram_schema(conn)
        # Keep at most one live ticket per Telegram chat.  This prevents a
        # repeated /bind (or an unauthorized message burst) from growing the
        # table while still invalidating the previous link immediately.
        conn.execute(
            "DELETE FROM telegram_tweet_link_tickets "
            "WHERE (chat_id = ? AND used_at = 0) OR used_at > 0 OR expires_at < ?",
            (member_id, now - 3600),
        )
        conn.execute(
            """
            INSERT INTO telegram_tweet_link_tickets(
              token_hash, chat_id, route_key, expires_at, used_at,
              linked_web_user_id, session_token_hash, created_at
            ) VALUES (?, ?, 'home', ?, 0, 0, '', ?)
            """,
            (digest, member_id, now + TICKET_TTL_SECONDS, now),
        )
    return f"{public_base}/telegram/tweet/open?{urlencode({'ticket': token})}"


def _ticket_chat_id(token: str, *, conn=None) -> int:
    clean = str(token or "").strip()
    if not clean or len(clean) > 256:
        raise HTTPException(status_code=410, detail="Telegram 绑定入口已失效，请回到 Bot 重新打开")
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    if conn is None:
        with db() as owned_conn:
            ensure_tweet_telegram_schema(owned_conn)
            row = owned_conn.execute(
                "SELECT chat_id, expires_at, used_at FROM telegram_tweet_link_tickets WHERE token_hash = ?",
                (digest,),
            ).fetchone()
    else:
        ensure_tweet_telegram_schema(conn)
        row = conn.execute(
            "SELECT chat_id, expires_at, used_at FROM telegram_tweet_link_tickets WHERE token_hash = ?",
            (digest,),
        ).fetchone()
    if (
        row is None
        or float(row["used_at"] or 0) > 0
        or float(row["expires_at"] or 0) < time.time()
    ):
        raise HTTPException(status_code=410, detail="Telegram 绑定入口已失效，请回到 Bot 重新打开")
    return int(row["chat_id"])


def validate_tweet_webapp_login_context(
    ticket: str,
    init_data: str,
    runtime: dict[str, Any] | None = None,
    *,
    conn=None,
) -> int:
    """Validate the short-lived Telegram WebApp context used during login.

    The context is deliberately separate from the Bot chat: the Bot never
    receives a VECTO password.  A signed Telegram ``initData`` value and the
    one-time ticket must both be valid before the login endpoint may opt into
    an additional WebView session.  The ticket is consumed only by the later
    exchange endpoint after the VECTO credentials have succeeded.
    """
    config = runtime if isinstance(runtime, dict) else {}
    bot_token = str(config.get("telegram_tweet_bot_token") or "").strip()
    if not bool(config.get("telegram_tweet_bot_enabled")) or not bot_token:
        raise HTTPException(status_code=403, detail="推文 Bot 当前未启用")
    expected_chat_id = _ticket_chat_id(ticket, conn=conn)
    _validate_telegram_init_data(str(init_data or ""), bot_token, expected_chat_id)
    return expected_chat_id


def _validate_telegram_init_data(
    init_data: str,
    bot_token: str,
    expected_chat_id: int,
) -> dict[str, Any]:
    raw = str(init_data or "")
    if len(raw) > 8192:
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效")
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效") from exc
    if not pairs or len({key for key, _value in pairs}) != len(pairs):
        raise HTTPException(status_code=401, detail="Telegram 身份数据格式无效")
    values = dict(pairs)
    received_hash = str(values.pop("hash", "") or "").strip().lower()
    if len(received_hash) != 64 or any(char not in "0123456789abcdef" for char in received_hash):
        raise HTTPException(status_code=401, detail="缺少 Telegram 身份签名")
    data_check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    # Telegram Web Apps derive the validation key as HMAC(bot_token,
    # "WebAppData").  Keep the bot token as the HMAC key; reversing these
    # arguments would make every real Telegram initData signature fail.
    secret_key = hmac.new(
        str(bot_token or "").encode("utf-8"), b"WebAppData", hashlib.sha256
    ).digest()
    calculated = hmac.new(
        secret_key, data_check.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(calculated, received_hash):
        raise HTTPException(status_code=401, detail="Telegram 身份签名无效")
    try:
        auth_date = int(values.get("auth_date") or 0)
        tg_user = json.loads(values.get("user") or "{}")
    except (TypeError, ValueError, json.JSONDecodeError, OverflowError) as exc:
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效") from exc
    # json.loads accepts any JSON value, but Telegram's user field must be an
    # object.  Checking this before .get() prevents malformed signed initData
    # from raising AttributeError and leaking a 500 response.
    if not isinstance(tg_user, dict):
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效")
    raw_user_id = tg_user.get("id")
    if raw_user_id is None or isinstance(raw_user_id, bool):
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效")
    if isinstance(raw_user_id, float) and not raw_user_id.is_integer():
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效")
    try:
        user_id = int(raw_user_id)
    except (TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效") from exc
    if user_id <= 0:
        raise HTTPException(status_code=401, detail="Telegram 用户身份无效")
    now = int(time.time())
    if auth_date <= 0 or auth_date > now + 60 or now - auth_date > 600:
        raise HTTPException(status_code=401, detail="Telegram 身份数据已过期")
    if user_id != int(expected_chat_id):
        raise HTTPException(status_code=403, detail="Telegram 用户与绑定入口不一致")
    username = str(tg_user.get("username") or "").strip().lstrip("@")
    display_name = " ".join(
        part
        for part in (
            str(tg_user.get("first_name") or "").strip(),
            str(tg_user.get("last_name") or "").strip(),
        )
        if part
    ).strip()
    return {
        "id": user_id,
        "username": username,
        "display_name": display_name,
    }


def _authenticated_web_session(request: Request) -> tuple[dict[str, Any], str]:
    """Resolve the normal/admin browser session that initiated the link."""
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
            # A logged-in administrator whose MFA enrollment is required must
            # receive the original 428 challenge.  Do not turn it into the
            # generic 401 login redirect by trying the next cookie.
            if exc.status_code == 428:
                raise
            continue
        try:
            unavailable = (
                int(user.get("is_disabled") or 0) == 1
                or int(user.get("deleted_at") or 0) > 0
                or str(user.get("lifecycle_status") or "active") != "active"
                or (
                    int(user.get("is_admin") or 0) != 1
                    and str(user.get("approval_status") or "") != "approved"
                )
            )
        except (TypeError, ValueError):
            unavailable = True
        if unavailable:
            raise HTTPException(status_code=403, detail="当前 VECTO 账号不可用于 Telegram 推文工作台")
        return user, session_storage_token(raw_token)
    raise HTTPException(
        status_code=401,
        detail={"code": "web_login_required", "message": WEB_SESSION_REQUIRED_MESSAGE},
    )


def _member_has_active_web_session(member: Any) -> bool:
    """Require the browser session used for binding to remain active."""
    try:
        user_id = int(member["web_user_id"])
    except (KeyError, TypeError, ValueError):
        return False
    linked_hash = ""
    if member is not None:
        try:
            linked_hash = str(member["linked_session_token_hash"] or "").strip()
        except (KeyError, TypeError, IndexError):
            linked_hash = ""
    now = int(time.time())
    with db() as conn:
        if linked_hash:
            row = conn.execute(
                """
                SELECT 1 FROM sessions
                WHERE token = ? AND user_id = ? AND revoked_at = 0 AND expires_at > ?
                LIMIT 1
                """,
                (linked_hash, user_id, now),
            ).fetchone()
        else:
            # Legacy admin-created rows predate self-service linking.  They
            # remain usable only while the mapped VECTO account has a live web
            # session, preserving the new authentication boundary during the
            # migration.
            row = conn.execute(
                """
                SELECT 1 FROM sessions
                WHERE user_id = ? AND revoked_at = 0 AND expires_at > ?
                LIMIT 1
                """,
                (user_id, now),
            ).fetchone()
    return row is not None


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
    public_base = _normalise_public_base_url(
        runtime.get("telegram_tweet_public_base_url") or DEFAULT_PUBLIC_BASE_URL
    ) or DEFAULT_PUBLIC_BASE_URL
    with _BOT_LOCK:
        status = dict(_BOT_STATUS)
    _backfill_missing_member_profiles(token)
    return {
        "ok": True,
        "bot_token_configured": bool(token),
        "bot_token_masked": _mask_token(token),
        "bot_token_length": len(token),
        "bot_enabled": bool(runtime.get("telegram_tweet_bot_enabled")),
        "public_base_url": public_base,
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
    if payload.public_base_url is not None:
        public_base = _normalise_public_base_url(payload.public_base_url)
        if not public_base:
            raise HTTPException(status_code=400, detail="网页安全操作地址必须使用 https://")
        updates["telegram_tweet_public_base_url"] = public_base
    if not updates:
        raise HTTPException(status_code=400, detail="请至少填写一项需要更新的推文 Bot 配置")
    next_runtime = dict(runtime)
    next_runtime.update(updates)
    token = str(next_runtime.get("telegram_tweet_bot_token") or "").strip()
    if bool(next_runtime.get("telegram_tweet_bot_enabled")) and not token:
        raise HTTPException(status_code=400, detail="启用轮询前必须配置推文 Bot Token")
    video_token = str(next_runtime.get("telegram_bot_token") or "").strip()
    if (
        bool(next_runtime.get("telegram_tweet_bot_enabled"))
        and bool(next_runtime.get("telegram_bot_enabled"))
        and token
        and video_token
        and secrets.compare_digest(token, video_token)
    ):
        raise HTTPException(status_code=400, detail="推文 Bot 不能与视频工作台共用同一个 Token")
    if bool(next_runtime.get("telegram_tweet_bot_enabled")):
        verify_bot_token(token)
    save_runtime(updates)
    if {"telegram_tweet_bot_token", "telegram_tweet_bot_enabled"} & updates.keys():
        reload_tweet_telegram_bot_worker(get_runtime)
    return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime), "restart_required": False}


def upsert_tweet_member(
    payload: TweetTgMemberPayload,
    get_runtime: GetRuntime,
    *,
    default_web_user: int | str = "",
) -> None:
    runtime = get_runtime() or {}
    token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
    raw_ref = str(payload.chat_id or "").strip()
    profile: dict[str, Any] | None = None
    if raw_ref.startswith("@"):
        if not token:
            raise HTTPException(status_code=400, detail="通过 @用户名获取成员需要先配置推文 Bot Token")
        profile = _lookup_tweet_member_profile(token, raw_ref)
        try:
            chat_id = int((profile or {}).get("chat_id") or 0)
        except (TypeError, ValueError):
            chat_id = 0
        if chat_id <= 0:
            raise HTTPException(status_code=400, detail="无法通过 @用户名读取该 Telegram 用户，请改填 Chat ID，或确认用户名公开且 Bot Token 有效。")
    else:
        chat_id = _resolve_chat_id(payload.chat_id)
        if token:
            profile = _lookup_tweet_member_profile(token, chat_id)
    tg_username = str((profile or {}).get("username") or "").strip().lstrip("@")
    tg_display_name = str((profile or {}).get("display_name") or "").strip()
    now = time.time()
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        web_user = _resolve_web_user(conn, default_web_user)
        existing = conn.execute(
            "SELECT * FROM telegram_tweet_members WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        label = str(payload.label or "").strip()
        if not label and existing:
            label = str(existing["label"] or "").strip()
        current_username = str(existing["tg_username"] or "").strip().lstrip("@") if existing else ""
        current_display = str(existing["tg_display_name"] or "").strip() if existing else ""
        tg_username = tg_username or current_username
        tg_display_name = tg_display_name or current_display
        label = label or tg_display_name or (f"@{tg_username}" if tg_username else f"TG-{chat_id}")
        if existing:
            if int(existing["web_user_id"] or 0) != int(web_user["id"]) or not payload.enabled:
                reason = "telegram_tweet_member_rebound" if payload.enabled else "telegram_tweet_member_disabled"
                _revoke_member_sessions(conn, chat_id, reason)
                _clear_member_native_state(conn, chat_id)
                _invalidate_pending_link_tickets(conn, chat_id)
            conn.execute(
                """
                UPDATE telegram_tweet_members
                SET web_user_id = ?, label = ?, tg_username = ?, tg_display_name = ?, enabled = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (int(web_user["id"]), label, tg_username,
                 tg_display_name, 1 if payload.enabled else 0, now, chat_id),
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


def _revoke_member_sessions(conn, chat_id: int, reason: str) -> None:
    now = int(time.time())
    conn.execute(
        """
        UPDATE sessions
        SET revoked_at = ?, revoke_reason = ?
        WHERE revoked_at = 0 AND token IN (
          SELECT linked_session_token_hash FROM telegram_tweet_members
          WHERE chat_id = ? AND linked_session_token_hash != ''
          UNION
          SELECT session_token_hash FROM telegram_tweet_tickets
          WHERE chat_id = ? AND session_token_hash != ''
        )
        """,
        (
            now,
            str(reason or "telegram_tweet_member_revoked")[:160],
            int(chat_id),
            int(chat_id),
        ),
    )


def _clear_member_native_state(conn, chat_id: int) -> None:
    conn.execute("DELETE FROM telegram_tweet_bot_states WHERE chat_id = ?", (int(chat_id),))
    conn.execute("DELETE FROM telegram_tweet_bot_callbacks WHERE chat_id = ?", (int(chat_id),))
    conn.execute(
        "UPDATE telegram_tweet_members SET linked_session_token_hash = '', linked_at = 0 WHERE chat_id = ?",
        (int(chat_id),),
    )


def _invalidate_pending_link_tickets(
    conn,
    chat_id: int,
    *,
    preserve_token_hash: str = "",
) -> None:
    """Invalidate outstanding self-service links without deleting audit rows."""
    digest = str(preserve_token_hash or "").strip()
    now = time.time()
    if digest:
        conn.execute(
            "UPDATE telegram_tweet_link_tickets SET used_at = ? "
            "WHERE chat_id = ? AND used_at = 0 AND token_hash != ?",
            (now, int(chat_id), digest),
        )
    else:
        conn.execute(
            "UPDATE telegram_tweet_link_tickets SET used_at = ? "
            "WHERE chat_id = ? AND used_at = 0",
            (now, int(chat_id)),
        )


def _consume_link_ticket(
    token: str,
    tg_profile: dict[str, Any],
    web_user: dict[str, Any],
    session_hash: str,
) -> None:
    clean = str(token or "").strip()
    if not clean or len(clean) > 256:
        raise HTTPException(status_code=410, detail="Telegram 绑定入口已失效，请回到 Bot 重新打开")
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    chat_id = int(tg_profile.get("id") or 0)
    web_user_id = int(web_user.get("id") or 0)
    if chat_id <= 0 or web_user_id <= 0 or not session_hash:
        raise HTTPException(status_code=400, detail="Telegram 绑定参数无效")
    username = str(tg_profile.get("username") or "").strip().lstrip("@")
    display_name = str(tg_profile.get("display_name") or "").strip()
    now = time.time()
    with db() as conn:
        # Ticket consumption changes both the binding and the ticket state;
        # keep the read/validate/update sequence atomic for one-time use.
        conn.execute("BEGIN IMMEDIATE")
        ensure_tweet_telegram_schema(conn)
        ticket = conn.execute(
            "SELECT chat_id, expires_at, used_at FROM telegram_tweet_link_tickets WHERE token_hash = ?",
            (digest,),
        ).fetchone()
        if (
            ticket is None
            or int(ticket["chat_id"] or 0) != chat_id
            or float(ticket["used_at"] or 0) > 0
            or float(ticket["expires_at"] or 0) < now
        ):
            raise HTTPException(status_code=410, detail="Telegram 绑定入口已失效，请回到 Bot 重新打开")
        existing = conn.execute(
            "SELECT * FROM telegram_tweet_members WHERE chat_id = ?",
            (chat_id,),
        ).fetchone()
        if existing and not int(existing["enabled"] or 0):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "telegram_binding_disabled",
                    "message": "该 Telegram 绑定已被管理员停用，请联系管理员处理。",
                },
            )
        if existing and int(existing["web_user_id"] or 0) != web_user_id:
            linked_hash = str(existing["linked_session_token_hash"] or "").strip()
            if linked_hash:
                active_old_session = conn.execute(
                    "SELECT 1 FROM sessions WHERE token = ? AND revoked_at = 0 AND expires_at > ? LIMIT 1",
                    (linked_hash, int(now)),
                ).fetchone()
            else:
                active_old_session = conn.execute(
                    "SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at = 0 AND expires_at > ? LIMIT 1",
                    (int(existing["web_user_id"] or 0), int(now)),
                ).fetchone()
            if active_old_session is not None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "telegram_already_bound",
                        "message": "该 Telegram 账号已绑定其他 VECTO 账号，请先在原账号退出网页或解除绑定。",
                    },
                )
            # A stale binding can be reclaimed by the account that is now
            # signing in.  Active bindings still require an explicit logout,
            # preventing a second account from silently taking over a live Bot.
            _revoke_member_sessions(conn, chat_id, "telegram_tweet_member_rebound")
            _invalidate_pending_link_tickets(conn, chat_id, preserve_token_hash=digest)
            _clear_member_native_state(conn, chat_id)
        current_label = str(existing["label"] or "").strip() if existing else ""
        current_username = str(existing["tg_username"] or "").strip().lstrip("@") if existing else ""
        current_display = str(existing["tg_display_name"] or "").strip() if existing else ""
        label = current_label or display_name or (f"@{username}" if username else f"TG-{chat_id}")
        next_username = username or current_username
        next_display = display_name or current_display
        if existing:
            conn.execute(
                """
                UPDATE telegram_tweet_members
                SET web_user_id = ?, label = ?, tg_username = ?, tg_display_name = ?,
                    enabled = 1, linked_session_token_hash = ?, linked_at = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (
                    web_user_id,
                    label,
                    next_username,
                    next_display,
                    session_hash,
                    now,
                    now,
                    chat_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO telegram_tweet_members(
                  chat_id, web_user_id, label, tg_username, tg_display_name, enabled,
                  linked_session_token_hash, linked_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    web_user_id,
                    label,
                    next_username,
                    next_display,
                    session_hash,
                    now,
                    now,
                    now,
                ),
            )
        updated = conn.execute(
            "UPDATE telegram_tweet_link_tickets SET used_at = ?, linked_web_user_id = ?, session_token_hash = ? "
            "WHERE token_hash = ? AND used_at = 0",
            (now, web_user_id, session_hash, digest),
        )
        if int(updated.rowcount or 0) != 1:
            raise HTTPException(status_code=410, detail="Telegram 绑定入口已使用")


def _lease_name(token: str) -> str:
    return "tweet:" + hashlib.sha256(str(token).encode("utf-8")).hexdigest()[:20]


def _acquire_or_renew_bot_lease(token: str, *, ttl_seconds: int = 20) -> bool:
    now = time.time()
    name = _lease_name(token)
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT owner_id, expires_at FROM telegram_tweet_bot_leases WHERE name = ?",
            (name,),
        ).fetchone()
        if row and str(row["owner_id"] or "") != _BOT_OWNER_ID and float(row["expires_at"] or 0) > now:
            return False
        conn.execute(
            """
            INSERT INTO telegram_tweet_bot_leases(name, owner_id, expires_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              owner_id = excluded.owner_id,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at
            """,
            (name, _BOT_OWNER_ID, now + max(10, int(ttl_seconds)), now),
        )
    return True


def _release_bot_lease(token: str) -> None:
    with db() as conn:
        ensure_tweet_telegram_schema(conn)
        conn.execute(
            "DELETE FROM telegram_tweet_bot_leases WHERE name = ? AND owner_id = ?",
            (_lease_name(token), _BOT_OWNER_ID),
        )


def _update_bot_status(patch: dict[str, Any]) -> None:
    with _BOT_LOCK:
        _BOT_STATUS.update(patch)


async def _run_bot(get_runtime: GetRuntime) -> None:
    while not _BOT_STOP.is_set():
        runtime = get_runtime() or {}
        token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
        enabled = bool(runtime.get("telegram_tweet_bot_enabled"))
        video_token = str(runtime.get("telegram_bot_token") or "").strip()
        if not token or not enabled:
            _update_bot_status({"running": False, "last_error": "未启用或未配置 Token", "updated_at": time.time()})
            return
        if bool(runtime.get("telegram_bot_enabled")) and video_token and secrets.compare_digest(token, video_token):
            _update_bot_status({"running": False, "last_error": "推文 Bot 与视频 Bot Token 冲突，已拒绝启动推文 Bot", "updated_at": time.time()})
            return
        if _BOT_OPS is None:
            _update_bot_status({"running": False, "last_error": "推文 Bot 业务适配器尚未初始化", "updated_at": time.time()})
            return
        if not _acquire_or_renew_bot_lease(token):
            _update_bot_status({"running": False, "last_error": "另一个推文 Bot 实例正在轮询，本实例保持待命", "updated_at": time.time()})
            await asyncio.sleep(5)
            continue
        try:
            me = await asyncio.to_thread(verify_bot_token, token)
            _update_bot_status({"bot_username": str(me.get("username") or ""), "updated_at": time.time()})
            await run_native_tweet_bot(
                token=token,
                get_runtime=get_runtime,
                load_member=_load_enabled_member,
                remember_member_profile=remember_tweet_member_profile,
                create_webapp_url=lambda chat_id, route_key="home": _create_link_ticket(
                    int(chat_id), get_runtime
                ),
                has_active_web_session=_member_has_active_web_session,
                ops=_BOT_OPS,
                stop_event=_BOT_STOP,
                status_callback=_update_bot_status,
                heartbeat=lambda: _acquire_or_renew_bot_lease(token),
            )
        except Exception as exc:
            logger.exception("Tweet Telegram workbench bot stopped unexpectedly")
            _update_bot_status({"running": False, "last_error": str(exc)[:400], "updated_at": time.time()})
            await asyncio.sleep(5)
        finally:
            with contextlib.suppress(Exception):
                _release_bot_lease(token)
            _update_bot_status({"running": False, "updated_at": time.time()})


def _thread_main(get_runtime: GetRuntime) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_run_bot(get_runtime))
    finally:
        loop.close()


def start_tweet_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    global _BOT_THREAD
    runtime = get_runtime() or {}
    if (
        not bool(runtime.get("telegram_tweet_bot_enabled"))
        or not str(runtime.get("telegram_tweet_bot_token") or "").strip()
        or _BOT_OPS is None
    ):
        _update_bot_status({"running": False, "last_error": "未启用或未配置 Token", "updated_at": time.time()})
        return
    with _BOT_LOCK:
        if _BOT_THREAD and _BOT_THREAD.is_alive():
            return
        _BOT_STOP.clear()
        _BOT_THREAD = threading.Thread(target=_thread_main, args=(get_runtime,), name="vecto-tweet-telegram-bot", daemon=True)
        _BOT_THREAD.start()


def stop_tweet_telegram_bot_worker() -> bool:
    global _BOT_THREAD
    _BOT_STOP.set()
    with _BOT_LOCK:
        thread = _BOT_THREAD
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=15)
    with _BOT_LOCK:
        if _BOT_THREAD is not None and not _BOT_THREAD.is_alive():
            _BOT_THREAD = None
        return _BOT_THREAD is None


def _restart_after_old_poller(thread: threading.Thread, get_runtime: GetRuntime) -> None:
    global _BOT_THREAD, _BOT_RELOAD_THREAD
    thread.join()
    with _BOT_LOCK:
        if _BOT_THREAD is thread:
            _BOT_THREAD = None
        _BOT_RELOAD_THREAD = None
    start_tweet_telegram_bot_worker(get_runtime)


def reload_tweet_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    global _BOT_RELOAD_THREAD
    # Complete the old poller's shutdown before accepting a new token. This
    # also prevents a brief getUpdates overlap when configuration is rotated.
    if stop_tweet_telegram_bot_worker():
        start_tweet_telegram_bot_worker(get_runtime)
        return
    with _BOT_LOCK:
        old_thread = _BOT_THREAD
        if old_thread is None:
            start_tweet_telegram_bot_worker(get_runtime)
            return
        if _BOT_RELOAD_THREAD and _BOT_RELOAD_THREAD.is_alive():
            return
        _BOT_RELOAD_THREAD = threading.Thread(
            target=_restart_after_old_poller,
            args=(old_thread, get_runtime),
            name="vecto-tweet-telegram-bot-reloader",
            daemon=True,
        )
        _BOT_RELOAD_THREAD.start()


def inject_tweet_telegram_admin(
    app,
    *,
    require_admin: Callable,
    get_runtime: GetRuntime,
    save_runtime: SaveRuntime,
    workbench_ops: TweetWorkbenchOps,
) -> None:
    global _BOT_OPS
    _BOT_OPS = workbench_ops
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
        upsert_tweet_member(payload, get_runtime, default_web_user=int(_user["id"]))
        return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime)}

    @router.post("/api/admin/tg_tweet/members/{chat_id}/toggle")
    def toggle_member(chat_id: int, payload: TweetTgMemberTogglePayload, _user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            ensure_tweet_telegram_schema(conn)
            if not payload.enabled:
                _revoke_member_sessions(conn, chat_id, "telegram_tweet_member_disabled")
                _clear_member_native_state(conn, chat_id)
                _invalidate_pending_link_tickets(conn, chat_id)
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
            _clear_member_native_state(conn, chat_id)
            _invalidate_pending_link_tickets(conn, chat_id)
            conn.execute("DELETE FROM telegram_tweet_members WHERE chat_id = ?", (int(chat_id),))
        return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime)}

    @router.get("/telegram/tweet/open")
    def open_workbench(ticket: str = ""):
        _ticket_chat_id(ticket)
        encoded_ticket = json.dumps(str(ticket or ""), ensure_ascii=False)
        response = HTMLResponse(
            """<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>绑定 Telegram 推文工作台</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px;background:#f3f7fa;color:#193247}main{max-width:520px;margin:10vh auto;padding:28px;border:1px solid #cbd8e2;border-radius:16px;background:#fff;box-shadow:0 12px 32px #19324718}h1{font-size:22px;margin:0 0 12px}p{line-height:1.65;color:#52697a}#status{min-height:1.8em}</style></head>
<body><main><h1>正在绑定 Telegram 推文工作台</h1><p id="status">正在验证 Telegram 身份和网页登录状态，请稍候…</p></main>
<script>
(async () => {
  const status = document.getElementById("status");
  const ticket = TICKET;
  const loginContextKey = "vecto-telegram-tweet-login-context";
  const loginReturn = "/telegram/tweet/open?ticket=" + encodeURIComponent(ticket);
  const loginPage = "/console-login.html?return_url=" + encodeURIComponent(loginReturn) + "&telegram_tweet=1";
  try {
    const webApp = window.Telegram?.WebApp;
    const initData = webApp?.initData || "";
    if (!initData) throw new Error("请从 Telegram Bot 的绑定按钮打开此页面");
    webApp.ready();
    const response = await fetch("/telegram/tweet/exchange", {
      method: "POST", credentials: "same-origin",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ticket, init_data: initData}),
    });
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail;
    if (response.status === 401 && detail?.code === "web_login_required") {
      // Keep the signed Telegram context in this WebView's session storage
      // while the user completes the normal VECTO login form. It never travels
      // through the Bot chat or the URL; the server validates it again before
      // allowing the login to keep another browser session alive.
      try {
        sessionStorage.setItem(loginContextKey, JSON.stringify({
          ticket,
          initData,
          expiresAt: Date.now() + 150000,
        }));
      } catch (_) {
        throw new Error("当前 Telegram WebView 不支持安全登录续接，请重新打开绑定入口");
      }
      window.location.replace(loginPage);
      return;
    }
    if (!response.ok) throw new Error(detail?.message || detail || "绑定失败");
    try { sessionStorage.removeItem(loginContextKey); } catch (_) {}
    status.textContent = "绑定成功，正在打开推文工作台…";
    window.location.replace(payload.target || "/console.html?view=persona_dashboard");
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
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @router.post("/telegram/tweet/exchange")
    def exchange_workbench(payload: TweetTgExchangePayload, request: Request):
        runtime = get_runtime() or {}
        bot_token = str(runtime.get("telegram_tweet_bot_token") or "").strip()
        if not bool(runtime.get("telegram_tweet_bot_enabled")) or not bot_token:
            raise HTTPException(status_code=403, detail="推文 Bot 当前未启用")
        expected_chat_id = _ticket_chat_id(payload.ticket)
        # Check the normal VECTO session before processing Telegram identity
        # data so an unauthenticated WebApp is consistently sent to the login
        # page, even when its initData is missing or stale.
        web_user, session_hash = _authenticated_web_session(request)
        tg_profile = _validate_telegram_init_data(
            payload.init_data,
            bot_token,
            expected_chat_id,
        )
        _consume_link_ticket(payload.ticket, tg_profile, web_user, session_hash)
        target = (
            WEBAPP_ADMIN_TARGET
            if int(web_user.get("is_admin") or 0) == 1
            else WEBAPP_TARGET
        )
        response = JSONResponse({"ok": True, "target": target})
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    app.include_router(router)

__all__ = [
    "ensure_tweet_telegram_schema",
    "inject_tweet_telegram_admin",
    "load_tweet_tg_settings",
    "remember_tweet_member_profile",
    "validate_tweet_webapp_login_context",
    "start_tweet_telegram_bot_worker",
    "stop_tweet_telegram_bot_worker",
]
