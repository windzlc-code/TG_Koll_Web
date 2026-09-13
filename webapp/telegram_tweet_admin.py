from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import secrets
import threading
import time
import uuid
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import db
from .telegram_admin import verify_bot_token
from .telegram_tweet_bot import TweetWorkbenchOps, ensure_native_bot_schema, run_native_tweet_bot

logger = logging.getLogger(__name__)

DEFAULT_PUBLIC_BASE_URL = "https://www.vecto-ai.cn"

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
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_leases (
          name TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at REAL NOT NULL,
          updated_at REAL NOT NULL
        )
        """
    )
    ensure_native_bot_schema(conn)
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
    if payload.public_base_url is not None:
        public_base = str(payload.public_base_url or "").strip().rstrip("/")
        if not public_base.startswith("https://"):
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
    del get_runtime
    chat_id = _resolve_chat_id(payload.chat_id)
    tg_username = ""
    tg_display_name = ""
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
        label = label or tg_display_name or (f"@{tg_username}" if tg_username else f"TG-{chat_id}")
        if existing:
            if int(existing["web_user_id"] or 0) != int(web_user["id"]) or not payload.enabled:
                reason = "telegram_tweet_member_rebound" if payload.enabled else "telegram_tweet_member_disabled"
                _revoke_member_sessions(conn, chat_id, reason)
                _clear_member_native_state(conn, chat_id)
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


def _clear_member_native_state(conn, chat_id: int) -> None:
    conn.execute("DELETE FROM telegram_tweet_bot_states WHERE chat_id = ?", (int(chat_id),))
    conn.execute("DELETE FROM telegram_tweet_bot_callbacks WHERE chat_id = ?", (int(chat_id),))


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
            conn.execute("DELETE FROM telegram_tweet_members WHERE chat_id = ?", (int(chat_id),))
        return {"ok": True, "tg_settings": load_tweet_tg_settings(get_runtime)}

    @router.get("/telegram/tweet/open")
    def open_workbench(ticket: str = ""):
        raise HTTPException(status_code=410, detail="网页自动登录入口已停用，请直接在推文 Bot 内操作")

    @router.post("/telegram/tweet/exchange")
    def exchange_workbench(_payload: TweetTgExchangePayload):
        raise HTTPException(status_code=410, detail="Telegram 不再签发网页会话")

    app.include_router(router)

__all__ = [
    "ensure_tweet_telegram_schema",
    "inject_tweet_telegram_admin",
    "load_tweet_tg_settings",
    "start_tweet_telegram_bot_worker",
    "stop_tweet_telegram_bot_worker",
]
