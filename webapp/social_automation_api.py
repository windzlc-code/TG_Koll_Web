from __future__ import annotations

import json
import os
import asyncio
import re
import sqlite3
import threading
import time
import uuid
import contextlib
import subprocess
from io import BytesIO
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from fastapi import Body, Depends, FastAPI, File, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

from .auth import SESSION_COOKIE, get_current_user, require_admin
from .db import db


SOCIAL_TASK_TYPES = {
    "check_login",
    "open_login",
    "browse_feed",
    "browse_profile",
    "threads_warmup",
    "threads_auto_reply",
    "publish_post",
    "comment_post",
    "reply_comment",
    "like_post",
    "share_post",
    "repost_post",
}
SOCIAL_ACCOUNT_STATUSES = {"pending_login", "ready", "need_verification", "cookie_expired", "disabled"}
SOCIAL_TASK_STATUSES = {"queued", "running", "success", "failed", "cancelled", "need_manual"}

_DATA_DIR = Path(os.getenv("WEBAPP_DATA_DIR", str(Path(__file__).resolve().parent.parent / "webapp_data"))).resolve()
_NEW_ID: Callable[[str], str] = lambda prefix: f"{prefix}_{uuid.uuid4().hex[:20]}"
_WORKER_THREAD: threading.Thread | None = None
_WORKER_STOP = threading.Event()
_WORKER_WAKE = threading.Event()
_WORKER_LOCK = threading.Lock()
_WORKER_TASK_THREADS: dict[str, threading.Thread] = {}
_WORKER_TASK_THREADS_LOCK = threading.Lock()
_WORKER_STATE: dict[str, Any] = {
    "enabled": False,
    "running": False,
    "last_started_at": 0,
    "last_tick_at": 0,
    "last_task_id": "",
    "last_error": "",
    "running_count": 0,
    "max_concurrency": 1,
}
_RUNNING_TASK_CONTROLS: dict[str, dict[str, Any]] = {}
_RUNNING_TASK_CONTROLS_LOCK = threading.Lock()


def _screenshot_thumbnail_bytes(path: Path) -> bytes:
    with Image.open(path) as source:
        image = source.convert("RGB")
        image.thumbnail((480, 270), Image.Resampling.LANCZOS)
        output = BytesIO()
        image.save(output, format="JPEG", quality=72, optimize=True)
    return output.getvalue()
_EPHEMERAL_TASK_SECRETS: dict[str, dict[str, str]] = {}
_EPHEMERAL_TASK_SECRETS_LOCK = threading.Lock()
_TASK_SECRETS_SCRUBBED = False
_ROOT_DIR = Path(__file__).resolve().parent.parent
_TOOL_R18_RUNTIME_DIR = Path(
    os.getenv("TOOL_R18_RUNTIME_DIR", str(_ROOT_DIR / "tool_r18" / ".runtime" / "automatic-script"))
).resolve()
_ARCHIVE_LOCK_TIMEOUT_SECONDS = 30


class SocialProxyPayload(BaseModel):
    name: str = ""
    proxy_type: str = "http"
    host: str = ""
    port: int = 0
    username: str = ""
    password: str = ""
    country: str = ""
    region: str = ""
    city: str = ""
    isp: str = ""
    source: str = "manual"
    ip_type: str = "static_residential"
    purchase_status: str = "owned"
    note: str = ""
    expires_at: int = Field(default=0, ge=0)
    status: str = "pending"


class SocialProxyPatchPayload(BaseModel):
    name: str | None = None
    proxy_type: str | None = None
    host: str | None = None
    port: int | None = None
    username: str | None = None
    password: str | None = None
    country: str | None = None
    region: str | None = None
    city: str | None = None
    isp: str | None = None
    source: str | None = None
    ip_type: str | None = None
    purchase_status: str | None = None
    note: str | None = None
    expires_at: int | None = Field(default=None, ge=0)
    status: str | None = None


class ResidentialProxyPayload(BaseModel):
    protocol: str = "http"
    host: str = ""
    port: int = 0
    username: str = ""
    password: str | None = None
    name: str = ""
    country: str = ""
    region: str = ""
    city: str = ""
    isp: str = ""
    source: str = "manual"
    ip_type: str = "static_residential"
    purchase_status: str = "owned"
    note: str = ""
    expires_at: int = Field(default=0, ge=0)
    status: str = "pending"


class SocialAccountPayload(BaseModel):
    persona_id: str = ""
    platform: str = "instagram"
    username: str = ""
    display_name: str = ""
    profile_dir: str = ""
    proxy_id: str = ""
    status: str = "pending_login"
    residential_proxy: ResidentialProxyPayload | None = None


class SocialTaskPayload(BaseModel):
    persona_id: str = ""
    account_id: str
    platform: str = "instagram"
    task_type: str
    priority: int = 50
    scheduled_at: int | str | None = 0
    payload: dict[str, Any] = Field(default_factory=dict)
    max_retries: int = 1


class SocialAccountPatchPayload(BaseModel):
    persona_id: str | None = None
    username: str | None = None
    display_name: str | None = None
    profile_dir: str | None = None
    proxy_id: str | None = None
    status: str | None = None
    login_username: str | None = None
    login_password: str | None = None
    clear_login_credentials: bool | None = None
    clear_residential_proxy: bool | None = None
    residential_proxy: ResidentialProxyPayload | None = None


class SocialTaskActionPayload(BaseModel):
    reason: str = ""


class LiveBrowserSettingsPayload(BaseModel):
    standby_seconds: int = Field(default=60, ge=0, le=3600)
    auto_close_seconds: int = Field(default=300, ge=10, le=86400)
    max_concurrency: int = Field(default=4, ge=1, le=12)
    text_input_mode: str = Field(default="paste", max_length=20)


class LiveBrowserTextPayload(BaseModel):
    text: str = Field(default="", max_length=2000)
    press_enter: bool = False


class LiveBrowserKeyPayload(BaseModel):
    key: str = Field(default="Enter", max_length=40)


def configure_social_automation(*, data_dir: Path, new_id: Callable[[str], str] | None = None) -> None:
    global _DATA_DIR, _NEW_ID
    _DATA_DIR = Path(data_dir).resolve()
    if new_id is not None:
        _NEW_ID = new_id


def register_social_automation_routes(app: FastAPI) -> None:
    @app.get("/api/persona_dashboard/automation/overview")
    def api_social_automation_overview(_user: dict[str, Any] = Depends(get_current_user)):
        return build_social_automation_overview()

    @app.get("/api/persona_dashboard/automation/browser_sessions")
    def api_social_browser_sessions(_user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "sessions": _live_browser_sessions()}

    @app.get("/api/persona_dashboard/automation/browser_settings")
    def api_social_browser_settings(_user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "settings": get_live_browser_settings()}

    @app.put("/api/persona_dashboard/automation/browser_settings")
    def api_social_browser_settings_save(payload: LiveBrowserSettingsPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "settings": set_live_browser_settings(payload)}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/close")
    def api_social_browser_session_close(session_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        close_live_browser_session(session_id)
        return {"ok": True, "closed": True}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/type")
    def api_social_browser_session_type(session_id: str, payload: LiveBrowserTextPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **type_live_browser_session_text(session_id, payload.text, press_enter=payload.press_enter)}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/key")
    def api_social_browser_session_key(session_id: str, payload: LiveBrowserKeyPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **press_live_browser_session_key(session_id, payload.key)}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/screenshot")
    def api_social_browser_session_screenshot(session_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **capture_live_browser_session_screenshot(session_id)}

    @app.websocket("/api/persona_dashboard/automation/browser_sessions/{session_id}/ws")
    async def api_social_browser_session_ws(websocket: WebSocket, session_id: str):
        if not _authenticate_live_browser_websocket(websocket):
            await websocket.close(code=1008)
            return
        await _proxy_live_browser_websocket(websocket, session_id)

    @app.get("/api/persona_dashboard/automation/browser_sessions/{session_id}/kasm")
    def api_social_browser_session_kasm_root(session_id: str, request: Request, _user: dict[str, Any] = Depends(get_current_user)):
        return _proxy_live_browser_http(session_id, "vnc.html", request)

    @app.get("/api/persona_dashboard/automation/browser_sessions/{session_id}/kasm/{path:path}")
    def api_social_browser_session_kasm_path(session_id: str, path: str, request: Request, _user: dict[str, Any] = Depends(get_current_user)):
        return _proxy_live_browser_http(session_id, path or "vnc.html", request)

    @app.get("/api/persona_dashboard/automation/accounts")
    def api_social_accounts(_user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM social_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
            accounts = _account_public_rows(conn, rows)
        return {"ok": True, "accounts": accounts}

    @app.post("/api/persona_dashboard/automation/accounts")
    def api_social_account_create(payload: SocialAccountPayload, _user: dict[str, Any] = Depends(get_current_user)):
        account = create_social_account(payload)
        return {"ok": True, "account": account}

    @app.patch("/api/persona_dashboard/automation/accounts/{account_id}")
    def api_social_account_patch(account_id: str, payload: SocialAccountPatchPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "account": update_social_account(account_id, payload)}

    @app.delete("/api/persona_dashboard/automation/accounts/{account_id}")
    def api_social_account_delete(account_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "deleted": delete_social_account(account_id)}

    @app.post("/api/persona_dashboard/automation/accounts/dedupe")
    def api_social_accounts_dedupe(_user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **dedupe_social_accounts()}

    @app.get("/api/persona_dashboard/automation/accounts/{account_id}/credentials")
    def api_social_account_credentials(account_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            row = conn.execute("SELECT id, login_username, login_password, login_credentials_updated_at FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
        return {
            "ok": True,
            "account_id": str(row["id"] or ""),
            "login_username": str(row["login_username"] or ""),
            "login_password": str(row["login_password"] or ""),
            "login_password_configured": bool(str(row["login_password"] or "")),
            "login_credentials_updated_at": int(row["login_credentials_updated_at"] or 0),
        }

    @app.post("/api/persona_dashboard/automation/accounts/{account_id}/check_login")
    def api_social_account_check_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _user: dict[str, Any] = Depends(get_current_user),
    ):
        body = payload if isinstance(payload, dict) else {}
        return {"ok": True, "task": create_account_task(account_id, "check_login", body.get("payload") if isinstance(body.get("payload"), dict) else body)}

    @app.post("/api/persona_dashboard/automation/accounts/{account_id}/open_login")
    def api_social_account_open_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _user: dict[str, Any] = Depends(get_current_user),
    ):
        wait_seconds = max(3600, int(os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "3600")))
        body = payload if isinstance(payload, dict) else {}
        task_payload = body.get("payload") if isinstance(body.get("payload"), dict) else body
        task_payload = dict(task_payload or {})
        _validate_open_login_payload(task_payload)
        task_payload.setdefault("login_wait_seconds", wait_seconds)
        return {"ok": True, "task": create_account_task(account_id, "open_login", task_payload)}

    @app.get("/api/persona_dashboard/automation/proxies")
    def api_social_proxies(_user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM social_proxies ORDER BY updated_at DESC, created_at DESC").fetchall()
            proxies = _proxy_public_rows(conn, rows)
        return {"ok": True, "proxies": proxies}

    @app.post("/api/persona_dashboard/automation/proxies")
    def api_social_proxy_create(payload: SocialProxyPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "proxy": create_social_proxy(payload)}

    @app.patch("/api/persona_dashboard/automation/proxies/{proxy_id}")
    def api_social_proxy_patch(proxy_id: str, payload: SocialProxyPatchPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "proxy": update_social_proxy(proxy_id, payload)}

    @app.delete("/api/persona_dashboard/automation/proxies/{proxy_id}")
    def api_social_proxy_delete(proxy_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "deleted": delete_social_proxy(proxy_id)}

    @app.post("/api/persona_dashboard/automation/proxies/{proxy_id}/check")
    def api_social_proxy_check(proxy_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "proxy": check_social_proxy(proxy_id)}

    @app.get("/api/persona_dashboard/automation/tasks")
    def api_social_tasks(status: str = "", account_id: str = "", limit: int = 60, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "tasks": list_social_tasks(status=status, account_id=account_id, limit=limit)}

    @app.post("/api/persona_dashboard/automation/tasks")
    def api_social_task_create(payload: SocialTaskPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "task": create_social_task(payload)}

    @app.post("/api/persona_dashboard/automation/tasks/cancel_all")
    def api_social_tasks_cancel_all(payload: SocialTaskActionPayload | None = None, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **cancel_all_social_tasks((payload.reason if payload else ""))}

    @app.get("/api/persona_dashboard/automation/tasks/{task_id}")
    def api_social_task_get(task_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "task": get_social_task(task_id)}

    @app.delete("/api/persona_dashboard/automation/tasks")
    def api_social_tasks_clear(persona_id: str = "", account_id: str = "", _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "cleared": clear_social_tasks(persona_id=persona_id, account_id=account_id)}

    @app.delete("/api/persona_dashboard/automation/tasks/{task_id}")
    def api_social_task_clear(task_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "cleared": clear_social_task(task_id)}

    @app.post("/api/persona_dashboard/automation/tasks/{task_id}/cancel")
    def api_social_task_cancel(task_id: str, payload: SocialTaskActionPayload | None = None, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "task": cancel_social_task(task_id, (payload.reason if payload else ""))}

    @app.post("/api/persona_dashboard/automation/tasks/{task_id}/retry")
    def api_social_task_retry(task_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "task": retry_social_task(task_id)}

    @app.get("/api/persona_dashboard/automation/tasks/{task_id}/logs")
    def api_social_task_logs(task_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            logs = conn.execute(
                "SELECT * FROM social_automation_logs WHERE task_id = ? ORDER BY created_at ASC, id ASC",
                (task_id,),
            ).fetchall()
        return {"ok": True, "logs": [_log_public(row) for row in logs]}

    @app.get("/api/persona_dashboard/automation/tasks/{task_id}/media/{index}")
    def api_social_task_media(task_id: str, index: int, _user: dict[str, Any] = Depends(get_current_user)):
        task = get_social_task(task_id)
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        media_paths = [str(item or "").strip() for item in (payload.get("media_paths") or []) if str(item or "").strip()]
        if index < 0 or index >= len(media_paths):
            raise HTTPException(status_code=404, detail="媒体文件不存在")
        path = Path(media_paths[index]).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="媒体文件不存在")
        return FileResponse(str(path), filename=path.name)

    @app.post("/api/persona_dashboard/automation/media")
    async def api_social_media_upload(files: list[UploadFile] = File(default=[]), _user: dict[str, Any] = Depends(get_current_user)):
        saved: list[dict[str, str]] = []
        upload_id = _NEW_ID("social_media")
        upload_dir = (_DATA_DIR / "social_automation" / "uploads" / upload_id).resolve()
        upload_dir.mkdir(parents=True, exist_ok=True)
        for index, upload in enumerate(files or [], start=1):
            filename = Path(str(upload.filename or f"media_{index}")).name
            suffix = Path(filename).suffix[:20]
            target = (upload_dir / f"media_{index}{suffix}").resolve()
            if upload_dir not in target.parents:
                raise HTTPException(status_code=400, detail="素材文件名不合法")
            with target.open("wb") as fh:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
            await upload.close()
            saved.append({"name": filename, "path": str(target)})
        if not saved:
            raise HTTPException(status_code=400, detail="请先选择要上传的素材")
        return {"ok": True, "files": saved}

    @app.post("/api/persona_dashboard/automation/worker/run_once")
    def api_social_worker_run_once(_admin: dict[str, Any] = Depends(require_admin)):
        return {"ok": True, "result": run_social_automation_once()}

    @app.get("/api/persona_dashboard/automation/screenshots/{filename}")
    def api_social_screenshot(filename: str, thumbnail: bool = False, _user: dict[str, Any] = Depends(get_current_user)):
        safe = Path(filename).name
        path = (_DATA_DIR / "social_automation" / "screenshots" / safe).resolve()
        root = (_DATA_DIR / "social_automation" / "screenshots").resolve()
        if root != path.parent or not path.exists():
            raise HTTPException(status_code=404, detail="截图不存在")
        if not thumbnail:
            return FileResponse(str(path))
        try:
            content = _screenshot_thumbnail_bytes(path)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="截图缩略图生成失败") from exc
        return Response(
            content=content,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=86400"},
        )


def _authenticate_live_browser_websocket(websocket: WebSocket) -> bool:
    token = str(websocket.cookies.get(SESSION_COOKIE) or "").strip()
    if not token:
        return False
    try:
        get_current_user(session_token=token)
        return True
    except Exception:
        return False


class _RfbClientMessageInspector:
    _FIXED_LENGTHS = {
        0: 20,
        3: 10,
        150: 10,
        178: 4,
        179: 12,
        185: 1,
        252: 5,
    }
    _INPUT_TYPES = {4, 5, 6, 180, 183, 188, 250, 255}

    def __init__(self, *, handshake_complete: bool = False) -> None:
        self._handshake_state = "messages" if handshake_complete else "protocol_version"

    def requires_input_permission(self, payload: bytes) -> bool:
        if not payload:
            return False
        if self._consume_handshake_payload(payload):
            return False
        return self._messages_require_input_permission(payload)

    def _consume_handshake_payload(self, payload: bytes) -> bool:
        if self._handshake_state == "protocol_version":
            if _is_rfb_protocol_version(payload):
                self._handshake_state = "security_or_client_init"
                return True
            self._handshake_state = "messages"
            return False
        if self._handshake_state == "security_or_client_init":
            if len(payload) == 1:
                self._handshake_state = "client_init_or_messages"
                return True
            self._handshake_state = "messages"
            return False
        if self._handshake_state == "client_init_or_messages":
            self._handshake_state = "messages"
            return len(payload) == 1 and payload[0] in {0, 1}
        return False

    def _messages_require_input_permission(self, payload: bytes) -> bool:
        offset = 0
        while offset < len(payload):
            message_type = payload[offset]
            if message_type in self._INPUT_TYPES:
                return True
            if message_type in self._FIXED_LENGTHS:
                message_length = self._FIXED_LENGTHS[message_type]
            elif message_type == 2:
                if len(payload) - offset < 4:
                    return True
                encoding_count = int.from_bytes(payload[offset + 2 : offset + 4], "big")
                message_length = 4 + encoding_count * 4
            elif message_type in {182, 248}:
                header_length = 2 if message_type == 182 else 9
                if len(payload) - offset < header_length:
                    return True
                length_offset = 1 if message_type == 182 else 8
                message_length = header_length + payload[offset + length_offset]
            elif message_type == 184:
                if len(payload) - offset < 2:
                    return True
                message_length = 2 + payload[offset + 1] * 4
            elif message_type == 251:
                if len(payload) - offset < 8:
                    return True
                message_length = 8 + payload[offset + 6] * 16
            else:
                return True
            if len(payload) - offset < message_length:
                return True
            offset += message_length
        return False


def _is_rfb_protocol_version(payload: bytes) -> bool:
    return (
        len(payload) == 12
        and payload[:4] == b"RFB "
        and payload[4:7].isdigit()
        and payload[7:8] == b"."
        and payload[8:11].isdigit()
        and payload[11:] == b"\n"
    )


def _live_browser_task_input_allowed(row: Any) -> bool:
    if row is None:
        return False
    task = dict(row)
    status = str(task.get("status") or "").strip().lower()
    if status == "need_manual":
        return True
    if status != "running" or str(task.get("task_type") or "").strip() != "open_login":
        return False
    payload = _load_task_payload_object(task.get("payload_json"))
    return payload is not None and _is_manual_open_login_task(task, payload)


def _query_live_browser_input_allowed(task_id: str) -> bool:
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT status, task_type, payload_json FROM social_automation_tasks WHERE id = ?",
                (str(task_id or ""),),
            ).fetchone()
        return _live_browser_task_input_allowed(row)
    except Exception:
        return False


async def _live_browser_input_allowed(task_id: str) -> bool:
    return bool(await asyncio.to_thread(_query_live_browser_input_allowed, task_id))


async def _proxy_live_browser_websocket(websocket: WebSocket, session_id: str) -> None:
    subprotocol = _requested_websocket_subprotocol(websocket)
    await websocket.accept(subprotocol=subprotocol)
    try:
        from social_automation.live_browser import get_live_browser_session

        session = get_live_browser_session(session_id)
        if not session:
            await websocket.close(code=1008)
            return
        import websockets

        target = await websockets.connect(
            f"ws://127.0.0.1:{int(session.web_port)}/websockify",
            max_size=None,
            max_queue=1,
            compression=None,
            subprotocols=[subprotocol or "binary"],
            origin=f"http://127.0.0.1:{int(session.web_port)}",
            ping_interval=None,
            close_timeout=1,
        )
    except Exception:
        with contextlib.suppress(Exception):
            await websocket.close(code=1011)
        return

    rfb_inspector = _RfbClientMessageInspector()

    async def browser_to_kasm() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                if rfb_inspector.requires_input_permission(data) and not await _live_browser_input_allowed(session.task_id):
                    continue
                await target.send(data)
                continue
            text = message.get("text")
            if text is not None:
                if rfb_inspector.requires_input_permission(text.encode("latin1", "ignore")) and not await _live_browser_input_allowed(session.task_id):
                    continue
                await target.send(text)

    async def kasm_to_browser() -> None:
        while True:
            data = await target.recv()
            if isinstance(data, bytes):
                await websocket.send_bytes(data)
            else:
                await websocket.send_text(str(data))

    tasks = [asyncio.create_task(browser_to_kasm()), asyncio.create_task(kasm_to_browser())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            with contextlib.suppress(Exception):
                task.result()
    finally:
        with contextlib.suppress(Exception):
            await target.close()
        with contextlib.suppress(Exception):
            await websocket.close()


def _requested_websocket_subprotocol(websocket: WebSocket) -> str | None:
    header = str(websocket.headers.get("sec-websocket-protocol") or "").strip()
    if not header:
        return None
    return header.split(",", 1)[0].strip() or None


def _proxy_live_browser_http(session_id: str, path: str, request: Request) -> Response:
    try:
        from social_automation.live_browser import get_live_browser_session

        session = get_live_browser_session(session_id)
    except Exception:
        session = None
    if not session:
        raise HTTPException(status_code=404, detail="实时浏览器会话不存在")
    clean_path = str(path or "vnc.html").lstrip("/")
    if ".." in Path(clean_path).parts:
        raise HTTPException(status_code=400, detail="路径不合法")
    url = f"http://127.0.0.1:{int(session.web_port)}/{clean_path}"
    try:
        upstream = requests.get(url, params=dict(request.query_params), timeout=8)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"KasmVNC 页面代理失败: {exc}") from exc
    headers = {}
    content_type = upstream.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    cache_control = upstream.headers.get("cache-control")
    if cache_control:
        headers["cache-control"] = cache_control
    return Response(content=upstream.content, status_code=upstream.status_code, headers=headers)


def ensure_social_automation_worker_started() -> None:
    global _WORKER_THREAD, _TASK_SECRETS_SCRUBBED
    enabled = str(os.getenv("SOCIAL_AUTOMATION_WORKER_ENABLED", "1")).strip().lower() not in {"0", "false", "no", "off"}
    _WORKER_STATE["enabled"] = enabled
    if not _TASK_SECRETS_SCRUBBED:
        with contextlib.suppress(Exception):
            scrub_social_automation_task_secrets()
        _TASK_SECRETS_SCRUBBED = True
    if not enabled:
        return
    if _WORKER_THREAD and _WORKER_THREAD.is_alive():
        return
    _WORKER_STOP.clear()
    _WORKER_THREAD = threading.Thread(target=_worker_loop, name="social-automation-worker", daemon=True)
    _WORKER_THREAD.start()


def wake_social_automation_worker() -> None:
    _WORKER_WAKE.set()


def scrub_social_automation_task_secrets() -> int:
    changed = 0
    with db() as conn:
        rows = conn.execute("SELECT id, payload_json FROM social_automation_tasks").fetchall()
        for row in rows:
            payload = _loads(row["payload_json"], {})
            clean = _strip_task_secrets(payload)
            if clean != payload:
                conn.execute(
                    "UPDATE social_automation_tasks SET payload_json = ? WHERE id = ?",
                    (json.dumps(clean, ensure_ascii=False), row["id"]),
                )
                changed += 1
    return changed


def build_social_automation_overview() -> dict[str, Any]:
    with db() as conn:
        accounts = conn.execute("SELECT * FROM social_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        proxies = conn.execute("SELECT * FROM social_proxies ORDER BY updated_at DESC, created_at DESC").fetchall()
        public_accounts = _account_public_rows(conn, accounts)
        public_proxies = _proxy_public_rows(conn, proxies)
        tasks = conn.execute(
            "SELECT * FROM social_automation_tasks ORDER BY created_at DESC LIMIT 80"
        ).fetchall()
        all_tasks = conn.execute("SELECT task_type, payload_json, status, finished_at FROM social_automation_tasks").fetchall()
    visible_tasks = [
        row for row in tasks
        if not _is_manual_open_login_task(dict(row), _load_task_payload_object(row["payload_json"]))
    ]
    counts: dict[str, int] = {}
    for row in all_tasks:
        if _is_manual_open_login_task(dict(row), _load_task_payload_object(row["payload_json"])):
            continue
        status = str(row["status"] or "")
        if status == "need_manual" and int(row["finished_at"] or 0) > 0:
            continue
        counts[status] = counts.get(status, 0) + 1
    return {
        "ok": True,
        "summary": {
            "account_count": len(accounts),
            "ready_account_count": sum(1 for row in accounts if str(row["status"]) == "ready"),
            "proxy_count": len(proxies),
            "queued_count": counts.get("queued", 0),
            "running_count": counts.get("running", 0),
            "need_manual_count": counts.get("need_manual", 0),
            "failed_count": counts.get("failed", 0),
            "success_count": counts.get("success", 0),
        },
        "accounts": public_accounts,
        "proxies": public_proxies,
        "tasks": [_task_public(row) for row in visible_tasks],
        "browser_sessions": _live_browser_sessions(),
        "worker": dict(_WORKER_STATE),
        "supported_task_types": sorted(SOCIAL_TASK_TYPES),
    }


def _live_browser_sessions() -> list[dict[str, Any]]:
    try:
        from social_automation.live_browser import list_live_browser_sessions

        sessions = list_live_browser_sessions()
    except Exception:
        return []
    task_ids = [str(session.get("task_id") or "").strip() for session in sessions if str(session.get("task_id") or "").strip()]
    if not task_ids:
        return sessions
    placeholders = ",".join("?" for _ in task_ids)
    try:
        with db() as conn:
            rows = conn.execute(
                f"SELECT id, status, task_type, payload_json, error, finished_at FROM social_automation_tasks WHERE id IN ({placeholders})",
                task_ids,
            ).fetchall()
        task_status = {str(row["id"]): row for row in rows}
    except Exception:
        return sessions
    for session in sessions:
        row = task_status.get(str(session.get("task_id") or ""))
        if not row:
            continue
        status = str(row["status"] or "").strip().lower()
        if status:
            session["task_status"] = status
        session["input_allowed"] = _live_browser_task_input_allowed(row)
        if str(row["error"] or "").strip():
            session["task_error"] = str(row["error"] or "")
        session["task_finished_at"] = int(row["finished_at"] or 0)
    return sessions


def _bounded_env_int(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except (TypeError, ValueError):
        value = fallback
    return max(minimum, min(value, maximum))


def _normalize_text_input_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in {"paste", "type"} else "paste"


def get_live_browser_settings() -> dict[str, Any]:
    defaults = {
        "standby_seconds": _bounded_env_int("SOCIAL_AUTOMATION_LIVE_BROWSER_STANDBY_SECONDS", 60, 0, 3600),
        "auto_close_seconds": _bounded_env_int("SOCIAL_AUTOMATION_LIVE_BROWSER_AUTO_CLOSE_SECONDS", 300, 10, 86400),
        "max_concurrency": _bounded_env_int("SOCIAL_AUTOMATION_WORKER_CONCURRENCY", 4, 1, 12),
        "text_input_mode": _normalize_text_input_mode(os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste")),
    }
    try:
        with db() as conn:
            row = conn.execute("SELECT value_json FROM admin_config WHERE key = ?", ("live_browser_settings",)).fetchone()
        if not row:
            return defaults
        raw = _loads(row["value_json"], {})
        return {
            "standby_seconds": max(0, min(int(raw.get("standby_seconds", defaults["standby_seconds"])), 3600)),
            "auto_close_seconds": max(10, min(int(raw.get("auto_close_seconds", defaults["auto_close_seconds"])), 86400)),
            "max_concurrency": max(1, min(int(raw.get("max_concurrency", defaults["max_concurrency"])), 12)),
            "text_input_mode": _normalize_text_input_mode(raw.get("text_input_mode", defaults["text_input_mode"])),
        }
    except Exception:
        return defaults


def set_live_browser_settings(payload: LiveBrowserSettingsPayload) -> dict[str, Any]:
    settings = {
        "standby_seconds": max(0, min(int(payload.standby_seconds), 3600)),
        "auto_close_seconds": max(10, min(int(payload.auto_close_seconds), 86400)),
        "max_concurrency": max(1, min(int(payload.max_concurrency), 12)),
        "text_input_mode": _normalize_text_input_mode(payload.text_input_mode),
    }
    now = _now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO admin_config(key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            """,
            ("live_browser_settings", json.dumps(settings, ensure_ascii=False), now),
        )
    with contextlib.suppress(Exception):
        _refresh_worker_state()
        wake_social_automation_worker()
    return settings


def close_live_browser_session(session_id: str, *, force: bool = False) -> None:
    try:
        from social_automation.live_browser import get_live_browser_session, stop_live_browser_session

        session = get_live_browser_session(str(session_id or ""))
        if session is not None and str(getattr(session, "status", "") or "").strip().lower() == "running" and not force:
            raise HTTPException(status_code=409, detail="自动化执行中的实时浏览器不能直接关闭，请使用停止进程。")
        stop_live_browser_session(str(session_id or ""))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"关闭实时浏览器失败: {exc}") from exc


def _require_live_browser_manual_session(session_id: str) -> str:
    clean_id = str(session_id or "").strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="缺少实时浏览器会话")
    task_id = ""
    with _RUNNING_TASK_CONTROLS_LOCK:
        for candidate_task_id, control in _RUNNING_TASK_CONTROLS.items():
            if str(control.get("live_browser_session_id") or "") == clean_id:
                task_id = str(candidate_task_id or "")
                break
    if not task_id:
        raise HTTPException(status_code=409, detail="当前浏览器会话未处于可人工操作状态")
    with db() as conn:
        row = conn.execute(
            "SELECT status, task_type, payload_json FROM social_automation_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
    if not _live_browser_task_input_allowed(row):
        raise HTTPException(status_code=409, detail="只有任务进入人工处理状态后才允许操作浏览器")
    return task_id


def type_live_browser_session_text(session_id: str, text: str, *, press_enter: bool = False) -> dict[str, Any]:
    clean_text = str(text or "")
    if not clean_text and not press_enter:
        raise HTTPException(status_code=400, detail="请输入要发送到浏览器的文本")
    _require_live_browser_manual_session(session_id)
    return _type_live_browser_session_text_via_display(session_id, clean_text, press_enter=press_enter)


def press_live_browser_session_key(session_id: str, key: str) -> dict[str, Any]:
    clean_key = _normalize_live_browser_key(key)
    _require_live_browser_manual_session(session_id)
    return _press_live_browser_session_key_via_display(session_id, clean_key)


def capture_live_browser_session_screenshot(session_id: str) -> dict[str, Any]:
    control = _running_control_for_live_browser_session(session_id)
    task_id = str(control.get("task", {}).get("id") or "") if control else str(session_id or "").replace("live_", "", 1)
    screenshot_dir = (_DATA_DIR / "social_automation" / "screenshots").resolve()
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    filename = f"screenshot_{task_id or 'live'}_manual_{_now()}.png"
    path = (screenshot_dir / filename).resolve()
    if screenshot_dir not in path.parents:
        raise HTTPException(status_code=400, detail="截图路径不合法")
    result = _capture_live_browser_session_screenshot_via_display(session_id, path)
    if task_id:
        with contextlib.suppress(Exception):
            with db() as conn:
                _insert_log(conn, task_id, "info", "manual_screenshot", "已从预览窗口手动截图", {"session_id": session_id}, str(path))
    return result


def _live_browser_session_display(session_id: str) -> str:
    try:
        from social_automation.live_browser import get_live_browser_session

        session = get_live_browser_session(session_id)
    except Exception:
        session = None
    display = str(getattr(session, "display", "") or "").strip()
    if not display:
        raise HTTPException(status_code=404, detail="浏览器会话没有可控制的显示窗口")
    return display


def _type_live_browser_session_text_via_display(session_id: str, text: str, *, press_enter: bool = False) -> dict[str, Any]:
    display = _live_browser_session_display(session_id)
    if text:
        _run_display_tool(["xdotool", "type", "--clearmodifiers", "--delay", "20", text], display, "发送文本")
    if press_enter:
        _run_display_tool(["xdotool", "key", "--clearmodifiers", "Return"], display, "发送回车")
    return {"sent": True, "length": len(text), "pressed_enter": bool(press_enter), "backend": "display"}


def _press_live_browser_session_key_via_display(session_id: str, key: str) -> dict[str, Any]:
    display = _live_browser_session_display(session_id)
    x_key = "Return" if key == "Enter" else key
    _run_display_tool(["xdotool", "key", "--clearmodifiers", x_key], display, "发送按键")
    return {"pressed": key, "backend": "display"}


def _capture_live_browser_session_screenshot_via_display(session_id: str, path: Path) -> dict[str, Any]:
    display = _live_browser_session_display(session_id)
    if _display_tool_available("import"):
        _run_display_tool(["import", "-window", "root", str(path)], display, "截图")
    elif _display_tool_available("scrot"):
        _run_display_tool(["scrot", str(path)], display, "截图")
    else:
        raise HTTPException(status_code=409, detail="当前浏览器会话已脱离任务上下文，且容器缺少 import/scrot 截图工具")
    return {"screenshot_path": str(path), "screenshot_url": f"/api/persona_dashboard/automation/screenshots/{path.name}", "backend": "display"}


def _display_tool_available(name: str) -> bool:
    try:
        result = subprocess.run(["/bin/sh", "-lc", f"command -v {name}"], capture_output=True, text=True, timeout=2)
        return result.returncode == 0
    except Exception:
        return False


def _run_display_tool(args: list[str], display: str, action: str) -> None:
    env = dict(os.environ)
    env["DISPLAY"] = display
    try:
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=f"{action}失败：容器缺少 {args[0]} 工具") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{action}失败：{exc}") from exc
    if result.returncode != 0:
        error = (result.stderr or result.stdout or "").strip()
        raise HTTPException(status_code=500, detail=f"{action}失败：{error or result.returncode}")


def _normalize_live_browser_key(key: str) -> str:
    clean = str(key or "Enter").strip()
    allowed = {
        "Enter": "Enter",
        "Tab": "Tab",
        "Escape": "Escape",
        "Backspace": "Backspace",
        "Delete": "Delete",
        "ArrowLeft": "ArrowLeft",
        "ArrowRight": "ArrowRight",
        "ArrowUp": "ArrowUp",
        "ArrowDown": "ArrowDown",
    }
    if clean in allowed:
        return allowed[clean]
    raise HTTPException(status_code=400, detail="不支持的按键")


def create_social_proxy(payload: SocialProxyPayload) -> dict[str, Any]:
    if str(payload.ip_type or "static_residential").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
    with db() as conn:
        row = _insert_social_proxy(
            conn,
            protocol=payload.proxy_type,
            host=payload.host,
            port=payload.port,
            username=payload.username,
            password=payload.password,
            name=payload.name,
            country=payload.country,
            region=payload.region,
            city=payload.city,
            isp=payload.isp,
            source=payload.source,
            ip_type="static_residential",
            purchase_status=payload.purchase_status,
            note=payload.note,
            expires_at=payload.expires_at,
            status=payload.status,
        )
    return _proxy_public(row)


def update_social_proxy(proxy_id: str, payload: SocialProxyPatchPayload) -> dict[str, Any]:
    clean_proxy_id = str(proxy_id or "").strip()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="代理不存在")

        effective_type = _normalize_proxy_type(payload.proxy_type if payload.proxy_type is not None else current["proxy_type"])
        effective_host = str(payload.host if payload.host is not None else current["host"] or "").strip()
        effective_port = int(payload.port if payload.port is not None else current["port"] or 0)
        if not effective_host or effective_port <= 0 or effective_port > 65535:
            raise HTTPException(status_code=400, detail="代理 host 和 port 必填，port 必须在 1-65535 之间")

        updates: dict[str, Any] = {}
        if payload.proxy_type is not None:
            updates["proxy_type"] = effective_type
        if payload.host is not None:
            updates["host"] = effective_host
        if payload.port is not None:
            updates["port"] = effective_port
        if payload.name is not None and str(payload.name or "").strip():
            updates["name"] = str(payload.name).strip()
        for field in ("username", "password"):
            value = getattr(payload, field)
            if value is not None and str(value).strip():
                updates[field] = str(value).strip() if field == "username" else str(value)
        for field in ("country", "region", "city", "isp", "note"):
            value = getattr(payload, field)
            if value is not None:
                updates[field] = str(value or "").strip()
        metadata_defaults = {
            "source": "manual",
            "purchase_status": "owned",
        }
        for field, default in metadata_defaults.items():
            value = getattr(payload, field)
            if value is not None:
                updates[field] = str(value or default).strip() or default
        if payload.ip_type is not None:
            clean_ip_type = str(payload.ip_type or "static_residential").strip().lower()
            if clean_ip_type != "static_residential":
                raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
            updates["ip_type"] = "static_residential"
        if payload.expires_at is not None:
            updates["expires_at"] = int(payload.expires_at)
        if payload.status is not None and str(payload.status or "").strip():
            updates["status"] = str(payload.status).strip()

        connection_fields = {"proxy_type", "host", "port", "username", "password"}
        if connection_fields.intersection(updates):
            updates["country"] = ""
            updates["region"] = ""
            updates["city"] = ""
            updates["isp"] = ""
            updates["last_check_at"] = 0
            updates["last_check_result"] = ""
        if updates:
            updates["updated_at"] = _now()
            assignments = ", ".join(f"{key} = ?" for key in updates)
            conn.execute(f"UPDATE social_proxies SET {assignments} WHERE id = ?", (*updates.values(), clean_proxy_id))
        row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone()
    return _proxy_public(row)


def delete_social_proxy(proxy_id: str) -> int:
    clean_proxy_id = str(proxy_id or "").strip()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT id FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="代理不存在")
        bound = conn.execute(
            "SELECT id FROM social_accounts WHERE proxy_id = ? ORDER BY created_at ASC, id ASC",
            (clean_proxy_id,),
        ).fetchall()
        if bound:
            raise HTTPException(status_code=409, detail="代理仍被账号绑定，不能删除")
        return int(conn.execute("DELETE FROM social_proxies WHERE id = ?", (clean_proxy_id,)).rowcount or 0)


def _insert_social_proxy(
    conn: Any,
    *,
    protocol: str,
    host: str,
    port: int,
    username: str = "",
    password: str | None = "",
    name: str = "",
    country: str = "",
    region: str = "",
    city: str = "",
    isp: str = "",
    source: str = "manual",
    ip_type: str = "static_residential",
    purchase_status: str = "owned",
    note: str = "",
    expires_at: int = 0,
    status: str = "pending",
) -> Any:
    proxy_type = _normalize_proxy_type(protocol)
    clean_host = str(host or "").strip()
    clean_port = int(port or 0)
    if str(ip_type or "static_residential").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
    if not clean_host or clean_port <= 0 or clean_port > 65535:
        raise HTTPException(status_code=400, detail="代理 host 和 port 必填，port 必须在 1-65535 之间")
    now = _now()
    proxy_id = _NEW_ID("social_proxy")
    conn.execute(
        """
        INSERT INTO social_proxies(
          id, name, proxy_type, host, port, username, password, country, region, city, isp,
          source, ip_type, purchase_status, note, expires_at, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            proxy_id,
            str(name or f"{proxy_type}://{clean_host}:{clean_port}").strip(),
            proxy_type,
            clean_host,
            clean_port,
            str(username or "").strip(),
            str(password or ""),
            str(country or "").strip(),
            str(region or "").strip(),
            str(city or "").strip(),
            str(isp or "").strip(),
            str(source or "manual").strip() or "manual",
            "static_residential",
            str(purchase_status or "owned").strip() or "owned",
            str(note or "").strip(),
            max(0, int(expires_at or 0)),
            str(status or "active").strip() or "active",
            now,
            now,
        ),
    )
    return conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()


def _save_account_residential_proxy(
    conn: Any,
    payload: ResidentialProxyPayload,
    *,
    current_proxy_id: str = "",
    account_id: str = "",
) -> Any:
    if str(payload.ip_type or "static_residential").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
    proxy_type = _normalize_proxy_type(payload.protocol)
    host = str(payload.host or "").strip()
    port = int(payload.port or 0)
    country = str(payload.country or "").strip()
    region = str(payload.region or "").strip()
    city = str(payload.city or "").strip()
    isp = str(payload.isp or "").strip()
    if not host or port <= 0 or port > 65535:
        raise HTTPException(status_code=400, detail="住宅代理 host 和 port 必填，port 必须在 1-65535 之间")

    clean_proxy_id = str(current_proxy_id or "").strip()
    current = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone() if clean_proxy_id else None
    if hasattr(payload, "model_fields_set"):
        fields_set = set(payload.model_fields_set)
    else:
        fields_set = set(payload.__fields_set__)
    metadata_defaults: dict[str, Any] = {
        "source": "manual",
        "purchase_status": "owned",
        "note": "",
        "expires_at": 0,
    }
    metadata: dict[str, Any] = {}
    for field, default in metadata_defaults.items():
        if current is not None and field not in fields_set:
            metadata[field] = current[field]
        else:
            metadata[field] = getattr(payload, field, default)
    shared = False
    if current is not None:
        shared = bool(
            conn.execute(
                "SELECT 1 FROM social_accounts WHERE proxy_id = ? AND id != ? LIMIT 1",
                (clean_proxy_id, str(account_id or "")),
            ).fetchone()
        )
    password = str(payload.password or "")
    username = str(payload.username or "").strip()
    if current is None or shared:
        return _insert_social_proxy(
            conn,
            protocol=proxy_type,
            host=host,
            port=port,
            username=username or (str(current["username"] or "") if current is not None else ""),
            password=password or (str(current["password"] or "") if current is not None else ""),
            name=str(payload.name or f"residential://{host}:{port}").strip(),
            country=country,
            region=region,
            city=city,
            isp=isp,
            source=str(metadata["source"] or "manual"),
            ip_type="static_residential",
            purchase_status=str(metadata["purchase_status"] or "owned"),
            note=str(metadata["note"] or ""),
            expires_at=int(metadata["expires_at"] or 0),
            status=payload.status,
        )

    updates: dict[str, Any] = {
        "proxy_type": proxy_type,
        "host": host,
        "port": port,
        "username": username or str(current["username"] or ""),
        "name": str(payload.name or current["name"] or f"residential://{host}:{port}").strip(),
        "country": country,
        "region": region,
        "city": city,
        "isp": isp,
        "source": str(metadata["source"] or "manual").strip() or "manual",
        "ip_type": "static_residential",
        "purchase_status": str(metadata["purchase_status"] or "owned").strip() or "owned",
        "note": str(metadata["note"] or "").strip(),
        "expires_at": max(0, int(metadata["expires_at"] or 0)),
        "status": str(payload.status or "active").strip() or "active",
        "last_check_at": 0,
        "last_check_result": "",
        "updated_at": _now(),
    }
    if password:
        updates["password"] = password
    assignments = ", ".join(f"{key} = ?" for key in updates)
    conn.execute(f"UPDATE social_proxies SET {assignments} WHERE id = ?", (*updates.values(), clean_proxy_id))
    return conn.execute("SELECT * FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone()


def check_social_proxy(proxy_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="代理不存在")
    proxy = dict(row)
    proxy_url = _proxy_url(proxy, include_password=True)
    result: dict[str, Any] = {"ok": False, "checked_at": _now(), "proxy": _proxy_url(proxy, include_password=False)}
    try:
        resp = requests.get(
            "https://ipwho.is/?fields=success,message,ip,country,country_code",
            proxies={"http": proxy_url, "https": proxy_url},
            timeout=20,
        )
        response = resp.json() if resp.ok else resp.text[:500]
        response_ok = isinstance(response, dict) and response.get("success") is not False and bool(response.get("ip"))
        result.update({"ok": bool(resp.ok and response_ok), "status_code": resp.status_code, "response": response})
    except Exception as exc:
        result.update({"ok": False, "error": str(exc)})
    safe_result = _redact_sensitive(
        result,
        secrets=(str(proxy.get("username") or ""), str(proxy.get("password") or "")),
    )
    status = "active" if result.get("ok") else "failed"
    response = result.get("response") if isinstance(result.get("response"), dict) else {}
    detected_country = str(response.get("country_code") or response.get("country") or "").strip()
    with db() as conn:
        checked_at = _now()
        cursor = conn.execute(
            """
            UPDATE social_proxies
            SET status = ?, country = CASE WHEN ? != '' THEN ? ELSE country END,
                last_check_at = ?, last_check_result = ?, updated_at = ?
            WHERE id = ? AND proxy_type = ? AND host = ? AND port = ?
              AND username = ? AND password = ?
              AND updated_at = ? AND status = ?
            """,
            (
                status,
                detected_country, detected_country,
                checked_at, json.dumps(safe_result, ensure_ascii=False), checked_at,
                proxy_id, proxy["proxy_type"], proxy["host"], proxy["port"], proxy["username"], proxy["password"],
                proxy["updated_at"], proxy["status"],
            ),
        )
        if not cursor.rowcount:
            raise HTTPException(status_code=409, detail="代理配置已变更，请重新检测")
        updated = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    return _proxy_public(updated)

def create_social_account(payload: SocialAccountPayload) -> dict[str, Any]:
    platform = _normalize_platform(payload.platform)
    username = str(payload.username or "").strip().lstrip("@")
    if not username:
        raise HTTPException(status_code=400, detail="账号 username 必填")
    persona_id = str(payload.persona_id or "").strip()
    status = str(payload.status or "pending_login").strip()
    if status not in SOCIAL_ACCOUNT_STATUSES:
        status = "pending_login"
    now = _now()
    if payload.residential_proxy is not None and str(payload.proxy_id or "").strip():
        raise HTTPException(status_code=400, detail="residential_proxy 与 proxy_id 不能同时提交")
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if payload.proxy_id:
            _require_proxy(conn, payload.proxy_id)
        if persona_id:
            bound = conn.execute(
                "SELECT id FROM social_accounts WHERE persona_id = ? AND platform = ? LIMIT 1",
                (persona_id, platform),
            ).fetchone()
            if bound:
                raise HTTPException(status_code=409, detail="同一人设在同一平台最多绑定一个账号")
        existing = conn.execute(
            """
            SELECT *
            FROM social_accounts
            WHERE persona_id = ?
              AND platform = ?
              AND lower(username) = lower(?)
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (persona_id, platform, username),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="同平台账号用户名已存在")
        account_id = _NEW_ID("social_account")
        profile_dir = str(payload.profile_dir or "").strip()
        if not profile_dir:
            profile_dir = str((_DATA_DIR / "social_automation" / "profiles" / platform / account_id).resolve())
        Path(profile_dir).mkdir(parents=True, exist_ok=True)
        proxy_row = None
        proxy_id = str(payload.proxy_id or "").strip()
        if payload.residential_proxy is not None:
            proxy_row = _save_account_residential_proxy(conn, payload.residential_proxy, account_id=account_id)
            proxy_id = str(proxy_row["id"] or "")
        conn.execute(
            """
            INSERT INTO social_accounts(id, persona_id, platform, username, display_name, profile_dir, proxy_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account_id,
                persona_id,
                platform,
                username,
                str(payload.display_name or "").strip(),
                profile_dir,
                proxy_id,
                status,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
        if proxy_row is None and proxy_id:
            proxy_row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    return _account_public(row, proxy_row)


def update_social_account(account_id: str, payload: SocialAccountPatchPayload) -> dict[str, Any]:
    if payload.clear_residential_proxy and (payload.residential_proxy is not None or payload.proxy_id is not None):
        raise HTTPException(status_code=400, detail="clear_residential_proxy 不能与 residential_proxy 或 proxy_id 同时提交")
    updates: dict[str, Any] = {}
    for field in ("persona_id", "username", "display_name", "profile_dir", "proxy_id", "status"):
        value = getattr(payload, field)
        if value is not None:
            updates[field] = str(value or "").strip()
    if payload.clear_login_credentials:
        updates["login_username"] = ""
        updates["login_password"] = ""
        updates["login_credentials_updated_at"] = 0
    else:
        if payload.login_username is not None:
            updates["login_username"] = str(payload.login_username or "").strip()
            updates["login_credentials_updated_at"] = _now()
        if payload.login_password is not None:
            password = str(payload.login_password or "")
            if _looks_like_non_password_text(password):
                raise HTTPException(status_code=400, detail="登录密码内容看起来像说明文字，请填写真实密码")
            updates["login_password"] = password
            updates["login_credentials_updated_at"] = _now()
    if payload.clear_residential_proxy:
        updates["proxy_id"] = ""
    if "status" in updates and updates["status"] not in SOCIAL_ACCOUNT_STATUSES:
        raise HTTPException(status_code=400, detail="账号状态不合法")
    if "username" in updates:
        updates["username"] = updates["username"].lstrip("@")
    if payload.residential_proxy is not None and updates.get("proxy_id"):
        raise HTTPException(status_code=400, detail="residential_proxy 与 proxy_id 不能同时提交")
    if not updates and payload.residential_proxy is None:
        return get_social_account(account_id)
    updates["updated_at"] = _now()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="账号不存在")
        target_persona_id = str(updates.get("persona_id", existing["persona_id"]) or "").strip()
        target_platform = str(existing["platform"] or "").strip()
        target_username = str(updates.get("username", existing["username"]) or "").strip().lstrip("@")
        if target_persona_id:
            duplicate = conn.execute(
                """
                SELECT id
                FROM social_accounts
                WHERE id != ?
                  AND persona_id = ?
                  AND platform = ?
                LIMIT 1
                """,
                (account_id, target_persona_id, target_platform),
            ).fetchone()
            if duplicate:
                raise HTTPException(status_code=409, detail="同一人设在同一平台最多绑定一个账号")
        else:
            duplicate = conn.execute(
                "SELECT id FROM social_accounts WHERE id != ? AND persona_id = '' AND platform = ? AND lower(username) = lower(?) LIMIT 1",
                (account_id, target_platform, target_username),
            ).fetchone()
            if duplicate:
                raise HTTPException(status_code=409, detail="同平台未绑定账号用户名重复")
        if updates.get("proxy_id"):
            _require_proxy(conn, updates["proxy_id"])
        proxy_row = None
        if payload.residential_proxy is not None:
            proxy_row = _save_account_residential_proxy(
                conn,
                payload.residential_proxy,
                current_proxy_id=str(existing["proxy_id"] or ""),
                account_id=account_id,
            )
            updates["proxy_id"] = str(proxy_row["id"] or "")
        if updates.get("profile_dir"):
            Path(updates["profile_dir"]).mkdir(parents=True, exist_ok=True)
        assignments = ", ".join(f"{key} = ?" for key in updates)
        try:
            conn.execute(f"UPDATE social_accounts SET {assignments} WHERE id = ?", (*updates.values(), account_id))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="账号绑定或用户名与现有账号冲突") from exc
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
        if proxy_row is None and str(row["proxy_id"] or ""):
            proxy_row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (row["proxy_id"],)).fetchone()
    return _account_public(row, proxy_row)


def _looks_like_non_password_text(value: str) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    chinese_chars = sum(1 for ch in text if 0x4E00 <= ord(ch) <= 0x9FFF)
    if chinese_chars >= 3:
        return True
    replacement_chars = sum(1 for ch in text if ch in {"?", "\ufffd"})
    if len(text) >= 6 and replacement_chars >= max(4, len(text) // 2):
        return True
    lower = text.lower()
    phrases = (
        "看不到",
        "消失",
        "不然",
        "怎么",
        "为什么",
        "should",
        "password here",
        "placeholder",
    )
    return any(phrase in lower for phrase in phrases)


def get_social_account(account_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    return _account_public(row)


def _deletable_account_ids(conn: Any, account_ids: list[str]) -> set[str]:
    clean_ids = [str(account_id or "").strip() for account_id in account_ids if str(account_id or "").strip()]
    if not clean_ids:
        return set()
    placeholders = ",".join("?" for _ in clean_ids)
    active_rows = conn.execute(
        f"""
        SELECT DISTINCT account_id
        FROM social_automation_tasks
        WHERE account_id IN ({placeholders})
          AND status IN ('queued', 'running', 'need_manual')
        """,
        tuple(clean_ids),
    ).fetchall()
    active_ids = {str(row["account_id"] or "") for row in active_rows}
    return {account_id for account_id in clean_ids if account_id not in active_ids}


def delete_social_account(account_id: str) -> int:
    clean_id = str(account_id or "").strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="account_id required")
    with db() as conn:
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (clean_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="account not found")
        task_rows = conn.execute("SELECT id, status FROM social_automation_tasks WHERE account_id = ?", (clean_id,)).fetchall()
        task_ids = [str(task["id"] or "") for task in task_rows if str(task["id"] or "")]
        active_task_ids = [
            str(task["id"] or "") for task in task_rows
            if str(task["id"] or "") and str(task["status"] or "") in {"running", "need_manual"}
        ]
    for task_id in active_task_ids:
        _force_stop_running_task(task_id)
    with db() as conn:
        for task_id in task_ids:
            conn.execute("DELETE FROM social_automation_logs WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM social_automation_tasks WHERE account_id = ?", (clean_id,))
        deleted = conn.execute("DELETE FROM social_accounts WHERE id = ?", (clean_id,)).rowcount
    wake_social_automation_worker()
    return int(deleted or 0)


def _account_dedupe_rank(row: Any) -> tuple[int, int]:
    status_rank = {
        "ready": 5,
        "need_verification": 4,
        "pending_login": 3,
        "cookie_expired": 2,
        "disabled": 1,
    }
    return (
        status_rank.get(str(row["status"] or "").strip().lower(), 0),
        int(row["updated_at"] or row["created_at"] or 0),
    )


def dedupe_social_accounts() -> dict[str, Any]:
    deleted_ids: list[str] = []
    kept_ids: list[str] = []
    skipped_ids: list[str] = []
    with db() as conn:
        rows = conn.execute("SELECT * FROM social_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        groups: dict[tuple[str, str], list[Any]] = {}
        for row in rows:
            username = str(row["username"] or "").strip().lower()
            platform = str(row["platform"] or "").strip().lower()
            if not username or not platform:
                continue
            groups.setdefault((platform, username), []).append(row)
        for group_rows in groups.values():
            if len(group_rows) <= 1:
                continue
            ranked = sorted(group_rows, key=_account_dedupe_rank, reverse=True)
            keep = ranked[0]
            kept_ids.append(str(keep["id"] or ""))
            candidates = [
                row for row in ranked[1:]
                if str(row["status"] or "").strip().lower() in {"cookie_expired", "disabled"}
            ]
            candidate_ids = [str(row["id"] or "") for row in candidates if str(row["id"] or "")]
            deletable = _deletable_account_ids(conn, candidate_ids)
            for row in candidates:
                account_id = str(row["id"] or "")
                if not account_id:
                    continue
                if account_id not in deletable:
                    skipped_ids.append(account_id)
                    continue
                task_rows = conn.execute("SELECT id FROM social_automation_tasks WHERE account_id = ?", (account_id,)).fetchall()
                for task in task_rows:
                    task_id = str(task["id"] or "")
                    if task_id:
                        conn.execute("DELETE FROM social_automation_logs WHERE task_id = ?", (task_id,))
                conn.execute("DELETE FROM social_automation_tasks WHERE account_id = ?", (account_id,))
                conn.execute("DELETE FROM social_accounts WHERE id = ?", (account_id,))
                deleted_ids.append(account_id)
    if deleted_ids:
        wake_social_automation_worker()
    return {
        "deleted_count": len(deleted_ids),
        "deleted_ids": deleted_ids,
        "kept_ids": kept_ids,
        "skipped_ids": skipped_ids,
    }


def create_account_task(account_id: str, task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        account = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    return create_social_task(
        SocialTaskPayload(
            persona_id=str(account["persona_id"] or ""),
            account_id=account_id,
            platform=str(account["platform"] or "instagram"),
            task_type=task_type,
            payload=payload,
            priority=20 if task_type in {"check_login", "open_login"} else 50,
            max_retries=0,
        )
    )


def create_social_task(payload: SocialTaskPayload) -> dict[str, Any]:
    platform = _normalize_platform(payload.platform)
    task_type = str(payload.task_type or "").strip()
    if task_type not in SOCIAL_TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"不支持的自动化任务类型: {task_type}")
    task_payload = dict(payload.payload or {})
    auto_submit = _validate_open_login_payload(task_payload) if task_type == "open_login" else False
    now = _now()
    scheduled_at = _parse_schedule(payload.scheduled_at)
    task_id = _NEW_ID("social_task")
    with db() as conn:
        account = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (payload.account_id,)).fetchone()
        if not account:
            raise HTTPException(status_code=404, detail="账号不存在")
        if str(account["status"] or "") == "disabled":
            raise HTTPException(status_code=409, detail="账号已停用，不能创建任务")
        if str(account["platform"] or "").strip().lower() != platform:
            raise HTTPException(status_code=400, detail="任务平台与执行账号平台不一致")
        proxy_id = str(account["proxy_id"] or "").strip()
        if proxy_id:
            proxy = conn.execute("SELECT status, ip_type FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
            if not proxy:
                raise HTTPException(status_code=409, detail="账号绑定的住宅代理不存在，不能创建任务")
            proxy_status = str(proxy["status"] or "").strip().lower()
            if str(proxy["ip_type"] or "").strip().lower() != "static_residential":
                raise HTTPException(status_code=409, detail="账号仅允许使用静态住宅 IP")
            if proxy_status != "active":
                raise HTTPException(status_code=409, detail="账号绑定的代理不可用，请先启用、修复或重新检测")
        persona_id = str(payload.persona_id or account["persona_id"] or "").strip()
        runtime_secrets: dict[str, str] = {}
        if task_type == "open_login" and auto_submit:
            submitted_password = str(task_payload.get("login_password") or "")
            if submitted_password and _looks_like_non_password_text(submitted_password):
                raise HTTPException(status_code=400, detail="登录密码内容看起来像说明文字，请填写真实密码")
            saved_username = str(account["login_username"] or "").strip() if "login_username" in account.keys() else ""
            task_payload["login_username"] = str(task_payload.get("login_username") or saved_username or account["username"] or "").strip()
        task_payload, runtime_secrets = _extract_runtime_secrets(task_payload)
        if platform == "threads" and task_type in {"threads_warmup", "threads_auto_reply"}:
            task_payload = _enrich_threads_task_payload(persona_id, task_type, task_payload)
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, persona_id, account_id, platform, task_type, priority, status, scheduled_at,
              payload_json, result_json, max_retries, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, '{}', ?, ?, ?)
            """,
            (
                task_id,
                persona_id,
                payload.account_id,
                platform,
                task_type,
                int(payload.priority or 50),
                scheduled_at,
                json.dumps(task_payload, ensure_ascii=False),
                max(0, min(int(payload.max_retries or 0), 5)),
                now,
                now,
            ),
        )
        _insert_log(conn, task_id, "info", "queued", "任务已加入自动化队列", {"task_type": task_type})
        if runtime_secrets:
            with _EPHEMERAL_TASK_SECRETS_LOCK:
                _EPHEMERAL_TASK_SECRETS[task_id] = runtime_secrets
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    wake_social_automation_worker()
    return _task_public(row)


def get_social_task(task_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _task_public(row)


def list_social_tasks(*, status: str = "", account_id: str = "", limit: int = 60) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if account_id:
        clauses.append("account_id = ?")
        params.append(account_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    limit = max(1, min(int(limit or 60), 200))
    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM social_automation_tasks {where} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
    return [_task_public(row) for row in rows]


def clear_social_task(task_id: str) -> int:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="任务不存在")
        status = str(row["status"] or "")
    if status in {"running", "need_manual"}:
        _force_stop_running_task(task_id)
    with db() as conn:
        conn.execute("DELETE FROM social_automation_logs WHERE task_id = ?", (task_id,))
        deleted = conn.execute("DELETE FROM social_automation_tasks WHERE id = ?", (task_id,)).rowcount
    wake_social_automation_worker()
    return int(deleted or 0)


def clear_social_tasks(*, persona_id: str = "", account_id: str = "") -> int:
    if not str(persona_id or "").strip() and not str(account_id or "").strip():
        raise HTTPException(status_code=400, detail="清除全部日志必须指定人设或账号")
    clauses: list[str] = []
    params: list[Any] = []
    if persona_id:
        clauses.append("persona_id = ?")
        params.append(persona_id)
    if account_id:
        clauses.append("account_id = ?")
        params.append(account_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db() as conn:
        rows = conn.execute(f"SELECT id, status FROM social_automation_tasks {where}", tuple(params)).fetchall()
    cleared = 0
    for row in rows:
        task_id = str(row["id"] or "")
        if not task_id:
            continue
        if str(row["status"] or "") in {"running", "need_manual"}:
            _force_stop_running_task(task_id)
        with db() as conn:
            conn.execute("DELETE FROM social_automation_logs WHERE task_id = ?", (task_id,))
            cleared += int(conn.execute("DELETE FROM social_automation_tasks WHERE id = ?", (task_id,)).rowcount or 0)
    wake_social_automation_worker()
    return cleared


def cancel_social_task(task_id: str, reason: str = "") -> dict[str, Any]:
    now = _now()
    clean_reason = reason or "用户取消"
    with db() as conn:
        cancelled = conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ?
            WHERE id = ? AND status IN ('queued', 'running', 'need_manual')
            """,
            (now, clean_reason, now, task_id),
        ).rowcount
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="任务不存在")
        if cancelled:
            _insert_log(conn, task_id, "warn", "cancel", "任务已取消，正在停止执行上下文", {"reason": clean_reason})
    _discard_ephemeral_task_secrets(task_id)
    if cancelled:
        _force_stop_running_task(task_id)
        wake_social_automation_worker()
    return _task_public(row)


def cancel_all_social_tasks(reason: str = "") -> dict[str, Any]:
    now = _now()
    clean_reason = reason or "用户停止全部自动化任务"
    with db() as conn:
        cancelled_rows = conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ?
            WHERE status IN ('queued', 'running', 'need_manual')
            RETURNING id
            """,
            (now, clean_reason, now),
        ).fetchall()
        task_ids = [str(row["id"] or "") for row in cancelled_rows if str(row["id"] or "")]
        if not task_ids:
            return {"cancelled_count": 0, "task_ids": [], "tasks": []}
        placeholders = ", ".join("?" for _ in task_ids)
        for task_id in task_ids:
            _insert_log(conn, task_id, "warn", "cancel_all", "已通过总控停止任务", {"reason": clean_reason})
        updated_rows = conn.execute(
            f"SELECT * FROM social_automation_tasks WHERE id IN ({placeholders})",
            tuple(task_ids),
        ).fetchall()

    _discard_ephemeral_task_secrets(*task_ids)
    # Mark every task cancelled before signalling browsers so queued work cannot be claimed mid-stop.
    for task_id in task_ids:
        _force_stop_running_task(task_id)
    wake_social_automation_worker()
    return {
        "cancelled_count": len(task_ids),
        "task_ids": task_ids,
        "tasks": [_task_public(row) for row in updated_rows],
    }


def retry_social_task(task_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return create_social_task(
        SocialTaskPayload(
            persona_id=str(row["persona_id"] or ""),
            account_id=str(row["account_id"] or ""),
            platform=str(row["platform"] or "instagram"),
            task_type=str(row["task_type"] or ""),
            priority=int(row["priority"] or 50),
            payload=_loads(row["payload_json"], {}),
            max_retries=int(row["max_retries"] or 0),
        )
    )


def run_social_automation_once() -> dict[str, Any] | None:
    with _WORKER_LOCK:
        _cleanup_worker_task_threads()
        if _active_worker_thread_count() >= _social_worker_max_concurrency():
            return None
        task = _claim_next_task()
        if not task:
            _refresh_worker_state()
            return None
        _start_claimed_task_thread(task)
        _refresh_worker_state()
        return {"task_id": task["id"], "status": "started"}


def _worker_loop() -> None:
    _WORKER_STATE["last_started_at"] = _now()
    while not _WORKER_STOP.is_set():
        try:
            _launch_available_social_tasks()
        except Exception as exc:
            _WORKER_STATE["last_error"] = str(exc)
        _WORKER_WAKE.wait(timeout=max(1, int(os.getenv("SOCIAL_AUTOMATION_WORKER_POLL_SECONDS", "5"))))
        _WORKER_WAKE.clear()


def _social_worker_max_concurrency() -> int:
    try:
        value = int(get_live_browser_settings().get("max_concurrency", 4))
    except Exception:
        value = _bounded_env_int("SOCIAL_AUTOMATION_WORKER_CONCURRENCY", 4, 1, 12)
    return max(1, min(value, 12))


def _cleanup_worker_task_threads() -> None:
    with _WORKER_TASK_THREADS_LOCK:
        for task_id, thread in list(_WORKER_TASK_THREADS.items()):
            if not thread.is_alive():
                _WORKER_TASK_THREADS.pop(task_id, None)


def _active_worker_thread_count() -> int:
    _cleanup_worker_task_threads()
    with _WORKER_TASK_THREADS_LOCK:
        return sum(1 for thread in _WORKER_TASK_THREADS.values() if thread.is_alive())


def _refresh_worker_state() -> None:
    running_count = _active_worker_thread_count()
    _WORKER_STATE.update({
        "running": running_count > 0,
        "running_count": running_count,
        "max_concurrency": _social_worker_max_concurrency(),
        "last_tick_at": _now(),
    })


def _launch_available_social_tasks() -> int:
    launched = 0
    with _WORKER_LOCK:
        while _active_worker_thread_count() < _social_worker_max_concurrency():
            task = _claim_next_task()
            if not task:
                break
            _start_claimed_task_thread(task)
            launched += 1
        _refresh_worker_state()
    return launched


def _start_claimed_task_thread(task: dict[str, Any]) -> None:
    task_id = str(task.get("id") or "")
    if not task_id:
        return

    def target() -> None:
        _WORKER_STATE.update({"last_tick_at": _now(), "last_task_id": task_id, "last_error": ""})
        try:
            _execute_claimed_task(task)
        except Exception as exc:
            _WORKER_STATE["last_error"] = str(exc)
            _fail_task_safely(task_id, exc)
        finally:
            with _WORKER_TASK_THREADS_LOCK:
                _WORKER_TASK_THREADS.pop(task_id, None)
            _refresh_worker_state()
            wake_social_automation_worker()

    thread = threading.Thread(target=target, name=f"social-automation-task-{task_id[:12]}", daemon=True)
    with _WORKER_TASK_THREADS_LOCK:
        _WORKER_TASK_THREADS[task_id] = thread
    thread.start()


def _publish_login_dependency_blocks_claim(conn: sqlite3.Connection, row: Any, now: int) -> bool:
    task_type = str(row["task_type"] or "").strip()
    if task_type != "publish_post":
        return False
    payload = _loads(row["payload_json"], {})
    if not payload.get("auto_login_before_publish"):
        return False
    login_task_id = str(payload.get("login_task_id") or "").strip()
    if not login_task_id:
        return False
    login_row = conn.execute("SELECT status, error FROM social_automation_tasks WHERE id = ?", (login_task_id,)).fetchone()
    if not login_row:
        return False
    login_status = str(login_row["status"] or "").strip()
    if login_status == "success":
        return False
    if login_status in {"failed", "cancelled"}:
        task_id = str(row["id"] or "")
        message = str(login_row["error"] or "发布前自动登录任务未成功，发布任务已停止。")
        conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'failed', finished_at = ?, error = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'
            """,
            (now, message, now, task_id),
        )
        _insert_log(conn, task_id, "error", "login_dependency_failed", message, {"login_task_id": login_task_id, "login_status": login_status})
    return True


def _claim_next_task() -> dict[str, Any] | None:
    now = _now()
    _recover_orphaned_manual_login_task(now)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT t.*
            FROM social_automation_tasks t
            WHERE t.status = 'queued'
              AND (t.scheduled_at = 0 OR t.scheduled_at <= ?)
              AND NOT EXISTS (
                SELECT 1
                FROM social_automation_tasks r
                WHERE r.account_id = t.account_id
                  AND r.status = 'running'
              )
            ORDER BY t.priority ASC, t.created_at ASC
            LIMIT 50
            """,
            (now,),
        ).fetchall()
        row = None
        for candidate in rows:
            if _publish_login_dependency_blocks_claim(conn, candidate, now):
                continue
            row = candidate
            break
        if not row:
            return None
        task_id = str(row["id"])
        conn.execute(
            "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
            (now, now, task_id),
        )
        _insert_log(conn, task_id, "info", "running", "后台执行器已领取任务", {})
        updated = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    public = _task_public(updated)
    public["payload"] = _loads(updated["payload_json"], {})
    return public


def _recover_orphaned_manual_login_task(now: int) -> None:
    with _RUNNING_TASK_CONTROLS_LOCK:
        running_ids = set(_RUNNING_TASK_CONTROLS.keys())
    recovery_window = max(60, int(os.getenv("SOCIAL_AUTOMATION_MANUAL_RECOVERY_SECONDS", "7200")))
    recent_cutoff = now - recovery_window
    with db() as conn:
        ready_rows = conn.execute(
            """
            SELECT t.id
            FROM social_automation_tasks t
            JOIN social_accounts a ON a.id = t.account_id
            WHERE t.status = 'need_manual'
              AND t.finished_at = 0
              AND t.task_type = 'open_login'
              AND a.status = 'ready'
            LIMIT 20
            """
        ).fetchall()
        for row in ready_rows:
            task_id = str(row["id"] or "")
            if not task_id or task_id in running_ids:
                continue
            result = json.dumps({"ok": True, "status": "ready", "recovered": True}, ensure_ascii=False)
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'success', result_json = ?, error = '', finished_at = ?, updated_at = ?
                WHERE id = ? AND status = 'need_manual' AND finished_at = 0
                """,
                (result, now, now, task_id),
            )
            _insert_log(
                conn,
                task_id,
                "info",
                "resume_manual_login",
                "已恢复登录任务：当前账号已经处于登录成功状态。",
                {},
            )
        rows = conn.execute(
            """
            SELECT *
            FROM social_automation_tasks
            WHERE status = 'need_manual'
              AND finished_at = 0
              AND task_type = 'open_login'
              AND updated_at >= ?
            ORDER BY account_id ASC, updated_at DESC, created_at DESC
            LIMIT 20
            """
            ,
            (recent_cutoff,),
        ).fetchall()
        seen_accounts: set[str] = set()
        for row in rows:
            task_id = str(row["id"] or "")
            account_id = str(row["account_id"] or "")
            if not task_id or task_id in running_ids or account_id in seen_accounts:
                continue
            seen_accounts.add(account_id)
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'queued', error = '', updated_at = ?
                WHERE id = ? AND status = 'need_manual' AND finished_at = 0
                """,
                (now, task_id),
            )
            _insert_log(
                conn,
                task_id,
                "info",
                "resume_manual_login",
                "登录任务的实时执行进程已断开，系统已重新排队检查当前浏览器登录状态。",
                {},
            )
            break


def _execute_claimed_task(task: dict[str, Any]) -> None:
    task_id = str(task.get("id") or "")
    if _is_task_cancelled(task_id):
        _discard_ephemeral_task_secrets(task_id)
        return
    with db() as conn:
        account_row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (task["account_id"],)).fetchone()
        if not account_row:
            raise RuntimeError("任务绑定账号不存在")
        proxy_id = str(account_row["proxy_id"] or "").strip()
        proxy_row = None
        if proxy_id:
            proxy_row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    account = dict(account_row)
    proxy = dict(proxy_row) if proxy_row else None
    if proxy is not None and str(proxy.get("ip_type") or "").strip().lower() != "static_residential":
        raise RuntimeError("账号代理不是静态住宅 IP，已阻止浏览器启动")
    if proxy_id and proxy is None:
        raise RuntimeError("账号绑定的住宅代理不存在，已阻止浏览器启动")
    if proxy is not None and str(proxy.get("status") or "").strip().lower() != "active":
        raise RuntimeError("账号代理不可用，已阻止浏览器启动")
    if _is_task_cancelled(task_id):
        _discard_ephemeral_task_secrets(task_id)
        return
    task = dict(task)
    task["payload"] = _runtime_task_payload(task, account)
    from social_automation.runner import AutoLoginFailedError, NeedManualError, UnsupportedActionError, run_social_task

    logger = _DbTaskLogger(task["id"])
    control = {"cancel_event": threading.Event(), "context": None, "manager": None, "task": dict(task), "live_browser_session_id": ""}
    with _RUNNING_TASK_CONTROLS_LOCK:
        _RUNNING_TASK_CONTROLS[str(task["id"])] = control
    try:
        if _is_task_cancelled(task_id):
            return
        result = _run_social_task_in_clean_thread(
            run_social_task,
            task=task,
            account=account,
            proxy=proxy,
            logger=logger,
            control=control,
        )
    except NeedManualError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "need_manual", {}, str(exc), account_status=str(getattr(exc, "status", "") or "need_verification"))
        return
    except AutoLoginFailedError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "failed", {"auto_login_failed": True, "screenshot_path": str(getattr(exc, "screenshot_path", "") or "")}, str(exc), account_status=str(getattr(exc, "status", "") or "cookie_expired"))
        return
    except UnsupportedActionError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "failed", {"unsupported": True}, str(exc))
        return
    finally:
        _discard_ephemeral_task_secrets(task_id)
        with _RUNNING_TASK_CONTROLS_LOCK:
            _RUNNING_TASK_CONTROLS.pop(str(task["id"]), None)
    if _is_task_cancelled(str(task["id"])):
        return
    status = "success" if result.get("ok") else "failed"
    account_status = ""
    if task.get("task_type") in {"check_login", "open_login"} and result.get("status") == "ready":
        account_status = "ready"
    _finish_task(task["id"], status, result, "" if status == "success" else str(result.get("error") or "执行失败"), account_status=account_status)


def _run_social_task_in_clean_thread(
    runner: Callable[..., dict[str, Any]],
    *,
    task: dict[str, Any],
    account: dict[str, Any],
    proxy: dict[str, Any] | None,
    logger: Any,
    control: dict[str, Any],
) -> dict[str, Any]:
    result_box: dict[str, Any] = {}
    error_box: dict[str, BaseException] = {}

    def target() -> None:
        try:
            result_box["result"] = runner(
                task=task,
                account=account,
                proxy=proxy,
                data_dir=_DATA_DIR,
                logger=logger,
                cancel_event=control["cancel_event"],
                context_control=control,
            )
        except BaseException as exc:
            error_box["error"] = exc

    thread = threading.Thread(target=target, name=f"social-task-runner-{str(task.get('id') or '')[:12]}", daemon=False)
    thread.start()
    thread.join()
    if error_box:
        raise error_box["error"]
    result = result_box.get("result")
    return result if isinstance(result, dict) else {}


def _is_task_cancelled(task_id: str) -> bool:
    try:
        with db() as conn:
            row = conn.execute("SELECT status FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        return bool(row and str(row["status"] or "") == "cancelled")
    except Exception:
        return False


def _discard_ephemeral_task_secrets(*task_ids: str) -> None:
    with _EPHEMERAL_TASK_SECRETS_LOCK:
        for task_id in task_ids:
            _EPHEMERAL_TASK_SECRETS.pop(str(task_id), None)


def _force_stop_running_task(task_id: str) -> None:
    with _RUNNING_TASK_CONTROLS_LOCK:
        control = _RUNNING_TASK_CONTROLS.get(str(task_id))
        cancel_event = control.get("cancel_event") if control else None
        context = control.get("context") if control else None
        session_id = str(control.get("live_browser_session_id") or "") if control else ""
    if cancel_event is not None:
        with contextlib.suppress(Exception):
            cancel_event.set()
    if context is not None:
        with contextlib.suppress(Exception):
            context.close()
    with contextlib.suppress(Exception):
        from social_automation.live_browser import stop_live_browser_session, stop_live_browser_sessions_for_task

        if session_id:
            stop_live_browser_session(session_id)
        stop_live_browser_sessions_for_task(task_id)
    with contextlib.suppress(Exception):
        with db() as conn:
            _insert_log(conn, task_id, "warn", "force_stop", "已发送强制停止信号并关闭浏览器上下文", {})


def _finish_task(task_id: str, status: str, result: dict[str, Any], error: str, account_status: str = "") -> bool:
    now = _now()
    with db() as conn:
        task = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not task:
            return False
        result_json = json.dumps(result or {}, ensure_ascii=False)
        if status == "need_manual":
            completed = conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'need_manual', finished_at = 0, result_json = ?, error = ?, updated_at = ?
                WHERE id = ? AND status IN ('running', 'need_manual')
                """,
                (result_json, error, now, task_id),
            ).rowcount
        else:
            completed = conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = ?, finished_at = ?, result_json = ?, error = ?, updated_at = ?
                WHERE id = ? AND status = 'running'
                """,
                (status, now, result_json, error, now, task_id),
            ).rowcount
        if not completed:
            return False
        _insert_log(conn, task_id, "info" if status == "success" else "error", status, "任务执行完成" if status == "success" else error, result)
        if account_status:
            conn.execute(
                "UPDATE social_accounts SET status = ?, last_login_check_at = ?, last_run_at = ?, last_error = '', updated_at = ? WHERE id = ?",
                (account_status, now, now, now, str(task["account_id"])),
            )
        else:
            conn.execute(
                "UPDATE social_accounts SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
                (now, error, now, str(task["account_id"])),
            )
    if completed and status == "success":
        _sync_successful_task_to_persona_archive(task_id, result)
    return True


def _iso_from_ts(value: Any) -> str:
    try:
        ts = int(value or 0)
    except Exception:
        ts = 0
    if ts <= 0:
        ts = _now()
    return datetime.utcfromtimestamp(ts).replace(microsecond=0).isoformat() + "Z"


def _read_json_file(path: Path) -> Any:
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def _extract_archive_list(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        for key in ("persona_archives_v2", "persona_archives", "archives", "items"):
            value = raw.get(key)
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except Exception:
                    parsed = []
                if isinstance(parsed, list):
                    return [item for item in parsed if isinstance(item, dict)]
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


@contextlib.contextmanager
def _archive_file_lock(timeout_seconds: int = _ARCHIVE_LOCK_TIMEOUT_SECONDS):
    lock_path = _TOOL_R18_RUNTIME_DIR / "persona_archives.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    fd: int | None = None
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"{os.getpid()} {time.time()}\n".encode("utf-8"))
            break
        except FileExistsError:
            if time.time() - started > timeout_seconds:
                raise RuntimeError("人设归档正在被占用，请稍后重试。")
            time.sleep(0.1)
    try:
        yield
    finally:
        if fd is not None:
            with contextlib.suppress(Exception):
                os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            lock_path.unlink()


def _write_archives_preserving_shape(path: Path, raw: Any, archives: list[dict[str, Any]]) -> None:
    if isinstance(raw, list):
        payload: Any = archives
    elif isinstance(raw, dict):
        payload = dict(raw)
        target_key = "persona_archives_v2"
        for key in ("persona_archives_v2", "persona_archives", "archives", "items"):
            if key in payload:
                target_key = key
                break
        if isinstance(payload.get(target_key), str):
            payload[target_key] = json.dumps(archives, ensure_ascii=False)
        else:
            payload[target_key] = archives
    else:
        payload = archives
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _archive_paths_for_sync() -> list[Path]:
    return [
        _TOOL_R18_RUNTIME_DIR / "persona_archives.json",
        _TOOL_R18_RUNTIME_DIR / "persona_archives_cache.json",
    ]


def _media_fields_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    media_paths = [str(item or "").strip() for item in (payload.get("media_paths") or []) if str(item or "").strip()]
    if not media_paths:
        return {}
    media_items = []
    for path in media_paths:
        suffix = Path(path).suffix.lower()
        media_type = "video" if suffix in {".mp4", ".mov", ".m4v", ".webm"} else "image"
        media_items.append({
            "url": path,
            "type": media_type,
            "label": Path(path).name or media_type,
        })
    first = media_paths[0]
    suffix = Path(first).suffix.lower()
    media_type = "video" if suffix in {".mp4", ".mov", ".m4v", ".webm"} else "image"
    if media_type == "video":
        return {"mediaType": "video", "videoUrl": first, "mediaUrl": first, "mediaItems": media_items}
    return {"mediaType": "image", "imageUrl": first, "mediaUrl": first, "mediaItems": media_items}


def _automation_action_label(task_type: str) -> str:
    return {
        "publish_post": "网页自动化发布",
        "comment_post": "网页自动化评论",
        "reply_comment": "网页自动化回复",
        "like_post": "网页自动化点赞",
        "share_post": "网页自动化分享",
        "repost_post": "网页自动化转发",
        "browse_feed": "网页自动化浏览首页",
        "browse_profile": "网页自动化浏览主页",
        "threads_warmup": "Threads 网页自动化养号",
        "threads_auto_reply": "Threads 网页自动化按人设自动回复",
        "check_login": "网页自动化登录检查",
        "open_login": "网页自动化登录窗口",
    }.get(task_type, f"网页自动化 {task_type}")


def _open_login_auto_submit_mode(payload: dict[str, Any] | None) -> bool | None:
    if not isinstance(payload, dict):
        return None
    if "auto_submit" not in payload:
        return False
    value = payload.get("auto_submit")
    return value if type(value) is bool else None


def _validate_open_login_payload(payload: dict[str, Any]) -> bool:
    mode = _open_login_auto_submit_mode(payload)
    if mode is None:
        raise HTTPException(status_code=422, detail="auto_submit must be a boolean when provided")
    return mode


def _load_task_payload_object(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _is_manual_open_login_task(task: dict[str, Any], payload: dict[str, Any] | None = None) -> bool:
    if str(task.get("task_type") or "") != "open_login":
        return False
    return _open_login_auto_submit_mode(payload) is False


def _load_persona_archive(persona_id: str) -> dict[str, Any] | None:
    key = str(persona_id or "").strip()
    if not key:
        return None
    for path in _archive_paths_for_sync():
        raw = _read_json_file(path)
        for archive in _extract_archive_list(raw):
            if str(archive.get("id") or "").strip() == key:
                return archive
    return None


def _collect_persona_reply_templates(archive: dict[str, Any] | None) -> list[str]:
    if not archive:
        return []
    candidates: list[str] = []
    posts = archive.get("posts") if isinstance(archive.get("posts"), list) else []
    for post in posts:
        if not isinstance(post, dict):
            continue
        text = str(post.get("content") or post.get("full_content") or post.get("title") or "").strip()
        if 4 <= len(text) <= 90:
            candidates.append(text)
        elif len(text) > 90:
            candidates.append(text[:90].rstrip())
        if len(candidates) >= 5:
            break
    name = str(archive.get("name") or "").strip()
    style = str(archive.get("personaStyle") or archive.get("style") or archive.get("tone") or "").strip()
    if style:
        candidates.append(style[:90])
    if not candidates and name:
        candidates.append(f"这个观点和{name}平时关注的方向很接近。")
    seen: set[str] = set()
    result: list[str] = []
    for item in candidates:
        text = " ".join(str(item or "").split())
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result[:8]


def _parse_archive_time(value: Any) -> int:
    if value in {None, ""}:
        return 0
    if isinstance(value, (int, float)):
        number = int(value)
        return number // 1000 if number > 10_000_000_000 else number
    text = str(value or "").strip()
    if not text:
        return 0
    if text.isdigit():
        number = int(text)
        return number // 1000 if number > 10_000_000_000 else number
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return int(datetime.fromisoformat(text).timestamp())
    except Exception:
        return 0


def _collect_threads_hot_reply_targets(archive: dict[str, Any] | None, *, max_age_days: int = 30, min_views: int = 0, limit: int = 5) -> list[dict[str, Any]]:
    if not archive:
        return []
    rows: list[dict[str, Any]] = []

    def add_row(item: Any, source: str = "") -> None:
        if not isinstance(item, dict):
            return
        meta = item.get("sourceMeta") if isinstance(item.get("sourceMeta"), dict) else {}
        published_meta = item.get("publishedMeta") if isinstance(item.get("publishedMeta"), dict) else {}
        platform = str(item.get("platform") or item.get("sourcePlatform") or item.get("publishPlatform") or "").strip().lower()
        url = str(
            item.get("publishedUrl")
            or item.get("published_url")
            or item.get("sourceUrl")
            or item.get("source_url")
            or item.get("postUrl")
            or item.get("post_url")
            or item.get("url")
            or item.get("target_url")
            or meta.get("publishedUrl")
            or meta.get("sourceUrl")
            or published_meta.get("publishedUrl")
            or published_meta.get("sourceUrl")
            or ""
        ).strip()
        if not url or "threads." not in url.lower():
            return
        if platform and platform not in {"threads", "thread"}:
            return
        view_count = int(float(item.get("view_count") or item.get("views") or item.get("post_views") or item.get("recent_views") or 0))
        if view_count < max(0, min_views):
            return
        published_ts = _parse_archive_time(item.get("published_at") or item.get("publishedAt") or item.get("captured_at") or item.get("createdAt") or item.get("created_at"))
        if max_age_days > 0 and published_ts > 0 and published_ts < _now() - max_age_days * 86400:
            return
        heat = view_count
        heat += int(float(item.get("like_count") or item.get("likes") or 0))
        heat += int(float(item.get("comment_count") or item.get("comments") or 0))
        heat += int(float(item.get("share_count") or item.get("shares") or 0))
        heat += int(float(item.get("repost_count") or item.get("reposts") or 0))
        rows.append({
            "url": url,
            "label": str(item.get("title") or item.get("content") or item.get("caption") or source or "Threads 热点推文")[:80],
            "view_count": view_count,
            "heat": heat,
            "published_at": published_ts,
            "source": source,
        })

    for post in archive.get("posts") if isinstance(archive.get("posts"), list) else []:
        add_row(post, "posts")
        if isinstance(post, dict):
            for target in post.get("publishedTargets") if isinstance(post.get("publishedTargets"), list) else []:
                add_row(target, "publishedTargets")
            if isinstance(post.get("sourceMeta"), dict):
                add_row(post.get("sourceMeta"), "posts.sourceMeta")
            if isinstance(post.get("publishedMeta"), dict):
                add_row(post.get("publishedMeta"), "posts.publishedMeta")
    platform_posts = archive.get("platformPosts") if isinstance(archive.get("platformPosts"), dict) else {}
    for post in platform_posts.get("threads") if isinstance(platform_posts.get("threads"), list) else []:
        add_row(post, "platformPosts.threads")
    setup = archive.get("setup") if isinstance(archive.get("setup"), dict) else {}
    for container_name in ("hotMetrics", "threadsHotMetrics"):
        container = setup.get(container_name) if isinstance(setup.get(container_name), dict) else {}
        candidate_containers = [container]
        threads_container = container.get("threads") if isinstance(container.get("threads"), dict) else {}
        if threads_container:
            candidate_containers.append(threads_container)
        for idx, candidate in enumerate(candidate_containers):
            source_prefix = f"setup.{container_name}"
            if idx == 1:
                source_prefix += ".threads"
            for key in ("postMetrics", "posts", "publishedTargets"):
                for item in candidate.get(key) if isinstance(candidate.get(key), list) else []:
                    add_row(item, f"{source_prefix}.{key}")
    for item in setup.get("publishHistory") if isinstance(setup.get("publishHistory"), list) else []:
        add_row(item, "setup.publishHistory")
    own_reply = ((archive.get("setup") if isinstance(archive.get("setup"), dict) else {}) or {}).get("threadsOwnPostAutoReply")
    if isinstance(own_reply, dict):
        for target in own_reply.get("knownPostTargets") if isinstance(own_reply.get("knownPostTargets"), list) else []:
            add_row(target, "knownPostTargets")

    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda item: (int(item.get("heat") or 0), int(item.get("published_at") or 0)), reverse=True):
        url = str(row.get("url") or "").rstrip("/")
        if not url or url in seen:
            continue
        seen.add(url)
        unique.append(row)
        if len(unique) >= max(1, limit):
            break
    return unique


def _enrich_threads_task_payload(persona_id: str, task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    archive = _load_persona_archive(persona_id)
    next_payload = dict(payload or {})
    if archive:
        next_payload.setdefault("persona_name", str(archive.get("name") or ""))
        setup = archive.get("setup") if isinstance(archive.get("setup"), dict) else {}
        account_management = setup.get("accountManagement") if isinstance(setup.get("accountManagement"), dict) else {}
        threads = account_management.get("threads") if isinstance(account_management.get("threads"), dict) else {}
        legacy_threads = archive.get("threads") if isinstance(archive.get("threads"), dict) else {}
        handle = str(
            threads.get("handle")
            or setup.get("threadsHandle")
            or legacy_threads.get("handle")
            or archive.get("threadsHandle")
            or ""
        ).strip().lstrip("@")
        if handle:
            next_payload.setdefault("threads_handle", handle)
        next_payload.setdefault("reply_templates", _collect_persona_reply_templates(archive))
    if task_type == "threads_warmup":
        strategy_id = str(next_payload.get("strategy_id") or "tg_default")
        next_payload.setdefault("strategy_id", strategy_id)
        if strategy_id == "browse_only":
            next_payload.setdefault("strategy_label", "保守养号：只浏览")
            next_payload.setdefault("browse_limit", 30)
            next_payload.setdefault("scroll_times", int(next_payload.get("browse_limit") or 30))
            next_payload.setdefault("like_limit", 0)
        elif strategy_id == "like_comment":
            next_payload.setdefault("strategy_label", "互动养号：点赞/留言")
            next_payload.setdefault("browse_limit", 30)
            next_payload.setdefault("scroll_times", int(next_payload.get("browse_limit") or 30))
            next_payload.setdefault("like_limit", 16)
            next_payload.setdefault("max_comments", 8)
            next_payload.setdefault("comment_chance", 100)
            next_payload.setdefault("require_persona_relevance", True)
        elif strategy_id == "warmup_custom":
            next_payload.setdefault("strategy_label", "自定义养号")
            next_payload.setdefault("browse_limit", 30)
            next_payload.setdefault("scroll_times", int(next_payload.get("browse_limit") or 30))
            next_payload.setdefault("like_limit", 0)
            next_payload.setdefault("max_comments", 0)
        else:
            next_payload.setdefault("strategy_label", "默认养号：滑动 + 随机点赞")
            next_payload.setdefault("browse_limit", 30)
            next_payload.setdefault("scroll_times", int(next_payload.get("browse_limit") or 30))
            next_payload.setdefault("like_limit", 16)
        next_payload.setdefault("browse_limit", int(next_payload.get("scroll_times") or 30))
        next_payload.setdefault("comment_chance", 0)
    if task_type == "threads_auto_reply":
        strategy_id = str(next_payload.get("strategy_id") or "tg_default")
        next_payload.setdefault("strategy_id", strategy_id)
        if strategy_id in {"safe_1d", "comment_recent_1d"}:
            next_payload.setdefault("strategy_label", "自动回复评论：最近 1 天")
            next_payload.setdefault("max_posts", 5)
            next_payload.setdefault("max_replies", 3)
            next_payload.setdefault("max_age_days", 1)
            next_payload.setdefault("reply_scope", "comments")
        elif strategy_id in {"coverage_7d", "comment_recent_7d"}:
            next_payload.setdefault("strategy_label", "自动回复评论：最近 7 天")
            next_payload.setdefault("max_posts", 5)
            next_payload.setdefault("max_replies", 3)
            next_payload.setdefault("max_age_days", 7)
            next_payload.setdefault("reply_scope", "comments")
        elif strategy_id == "comment_custom":
            next_payload.setdefault("strategy_label", "自定义评论回复")
            next_payload.setdefault("max_posts", 5)
            next_payload.setdefault("max_replies", 3)
            next_payload.setdefault("max_age_days", 2)
            next_payload.setdefault("reply_scope", "comments")
        elif strategy_id in {"hot_posts", "hot_recent_7d", "hot_views_1000", "hot_custom"}:
            if strategy_id == "hot_recent_7d":
                next_payload.setdefault("strategy_label", "热点推文：最近 7 天")
                next_payload.setdefault("max_age_days", 7)
            elif strategy_id == "hot_views_1000":
                next_payload.setdefault("strategy_label", "热点推文：千次浏览以上")
                next_payload.setdefault("min_views", 1000)
            elif strategy_id == "hot_custom":
                next_payload.setdefault("strategy_label", "自定义热点回复")
                next_payload.setdefault("max_age_days", 30)
            else:
                next_payload.setdefault("strategy_label", "自动回复热点推文")
                next_payload.setdefault("max_age_days", 30)
            next_payload.setdefault("max_posts", 5)
            next_payload.setdefault("max_replies", 3)
            next_payload.setdefault("min_views", 0)
            next_payload.setdefault("reply_scope", "hot_posts")
            targets = _collect_threads_hot_reply_targets(
                archive,
                max_age_days=int(next_payload.get("max_age_days") or 30),
                min_views=int(next_payload.get("min_views") or 0),
                limit=int(next_payload.get("max_posts") or 5),
            )
            next_payload.setdefault("target_urls", [str(item.get("url") or "") for item in targets if item.get("url")])
            next_payload.setdefault("target_summaries", targets)
        else:
            next_payload.setdefault("strategy_label", "自动回复评论：最近 2 天")
            next_payload.setdefault("max_posts", 5)
            next_payload.setdefault("max_replies", 3)
            next_payload.setdefault("max_age_days", 2)
            next_payload.setdefault("reply_scope", "comments")
        if str(next_payload.get("reply_scope") or "comments") == "comments":
            comment_targets = _collect_threads_hot_reply_targets(
                archive,
                max_age_days=int(next_payload.get("max_age_days") or 2),
                min_views=0,
                limit=int(next_payload.get("max_posts") or 5),
            )
            next_payload.setdefault("target_urls", [str(item.get("url") or "") for item in comment_targets if item.get("url")])
            next_payload.setdefault("target_summaries", comment_targets)
        next_payload.setdefault("require_persona_relevance", True)
    return next_payload


def _build_archive_sync_records(task: dict[str, Any], account: dict[str, Any], payload: dict[str, Any], result: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    task_id = str(task.get("id") or "")
    task_type = str(task.get("task_type") or "")
    platform = str(task.get("platform") or account.get("platform") or "instagram").strip().lower() or "instagram"
    published_at = _iso_from_ts(task.get("finished_at") or task.get("updated_at") or task.get("created_at"))
    caption = str(payload.get("caption") or payload.get("comment") or payload.get("reply") or payload.get("text") or "").strip()
    archive_post_id = str(payload.get("archive_post_id") or "").strip() or f"webauto-{task_id}"
    archive_post_title = str(payload.get("archive_post_title") or "").strip()
    target_url = str(payload.get("target_url") or payload.get("post_url") or result.get("url") or "").strip()
    result_url = str(result.get("url") or target_url or "").strip()
    source_meta = {
        "platform": platform,
        "source": "web_social_automation",
        "archivePostSource": str(payload.get("archive_post_source") or "posts").strip().lower() or "posts",
        "taskType": task_type,
        "taskId": task_id,
        "accountId": str(task.get("account_id") or ""),
        "username": str(account.get("username") or ""),
        "publishedAt": published_at,
        "capturedAt": published_at,
        "sourceUrl": target_url,
        "publishedUrl": result_url,
        "likeCount": 0,
        "commentCount": 0,
        "shareCount": 0,
        "repostCount": 0,
        "viewCount": 0,
    }
    media_fields = _media_fields_from_payload(payload)
    source_meta.update({key: value for key, value in media_fields.items() if key in {"imageUrl", "videoUrl", "mediaUrl", "mediaItems"}})
    title = _automation_action_label(task_type)
    publish_record = {
        "id": f"webauto-pub-{task_id}",
        "archivePostId": archive_post_id,
        "title": archive_post_title or title,
        "content": caption or target_url or title,
        "wordCount": len(caption),
        "publishedAt": published_at,
        "platform": platform,
        "status": "success",
        "publishedUrl": result_url,
        "sourceMeta": source_meta,
        "publishedMeta": source_meta,
        "publishedTargets": [{
            "platform": platform,
            "publishedUrl": result_url,
            "publishedMeta": source_meta,
        }],
        "automationTaskId": task_id,
        "automationTaskType": task_type,
    }
    post_record = None
    if task_type == "publish_post":
        post_record = {
            "id": archive_post_id,
            "title": archive_post_title or caption[:80] or title,
            "content": caption,
            "wordCount": len(caption),
            "createdAt": published_at,
            "updatedAt": published_at,
            "publishedAt": published_at,
            "platform": platform,
            "source": "web_social_automation",
            "sourceMeta": source_meta,
            "publishedMeta": source_meta,
            "publishedUrl": result_url,
            "automationTaskId": task_id,
            **media_fields,
        }
    return publish_record, post_record


def _sync_successful_task_to_persona_archive(task_id: str, result: dict[str, Any]) -> None:
    try:
        with db() as conn:
            task_row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
            if not task_row:
                return
            account_row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (str(task_row["account_id"]),)).fetchone()
        task = dict(task_row)
        account = dict(account_row) if account_row else {}
        if str(task.get("task_type") or "").strip().lower() != "publish_post":
            return
        persona_id = str(task.get("persona_id") or account.get("persona_id") or "").strip()
        if not persona_id:
            return
        payload = json.loads(str(task.get("payload_json") or "{}"))
        if not isinstance(payload, dict):
            payload = {}
        publish_record, post_record = _build_archive_sync_records(task, account, payload, result or {})
        archive_post_source = str(payload.get("archive_post_source") or "posts").strip().lower()
        is_favorite_post_source = archive_post_source == "favorites"
        with _archive_file_lock():
            for path in _archive_paths_for_sync():
                raw = _read_json_file(path)
                archives = _extract_archive_list(raw)
                if not archives:
                    continue
                changed = False
                for archive in archives:
                    if str(archive.get("id") or "").strip() != persona_id:
                        continue
                    history = archive.get("publishHistory") if isinstance(archive.get("publishHistory"), list) else []
                    if not any(isinstance(item, dict) and str(item.get("automationTaskId") or item.get("id") or "") in {task_id, publish_record["id"]} for item in history):
                        archive["publishHistory"] = [publish_record, *history]
                        changed = True
                    if post_record and is_favorite_post_source:
                        favorites = archive.get("favoritePosts") if isinstance(archive.get("favoritePosts"), list) else []
                        next_favorites: list[dict[str, Any] | Any] = []
                        favorites_changed = False
                        for item in favorites:
                            if not isinstance(item, dict):
                                next_favorites.append(item)
                                continue
                            if str(item.get("id") or "") == str(post_record["id"]) or str(item.get("automationTaskId") or "") == task_id:
                                next_favorites.append({**item, **post_record})
                                favorites_changed = True
                            else:
                                next_favorites.append(item)
                        if favorites_changed:
                            archive["favoritePosts"] = next_favorites
                            changed = True
                    elif post_record:
                        posts = archive.get("posts") if isinstance(archive.get("posts"), list) else []
                        matched_post = False
                        next_posts: list[dict[str, Any] | Any] = []
                        for item in posts:
                            if not isinstance(item, dict):
                                next_posts.append(item)
                                continue
                            if str(item.get("id") or "") == str(post_record["id"]) or str(item.get("automationTaskId") or "") == task_id:
                                matched_post = True
                                changed = True
                            else:
                                next_posts.append(item)
                        if matched_post:
                            archive["posts"] = next_posts
                        platform_posts = archive.get("platformPosts") if isinstance(archive.get("platformPosts"), dict) else {}
                        platform = str(task.get("platform") or "instagram").strip().lower() or "instagram"
                        platform_rows = platform_posts.get(platform) if isinstance(platform_posts.get(platform), list) else []
                        matched_platform_post = False
                        next_platform_rows: list[dict[str, Any] | Any] = []
                        for item in platform_rows:
                            if not isinstance(item, dict):
                                next_platform_rows.append(item)
                                continue
                            if str(item.get("id") or "") == str(post_record["id"]) or str(item.get("automationTaskId") or "") == task_id:
                                matched_platform_post = True
                                changed = True
                            else:
                                next_platform_rows.append(item)
                        if matched_platform_post:
                            platform_posts[platform] = next_platform_rows
                            archive["platformPosts"] = platform_posts
                    if changed:
                        archive["updatedAt"] = _iso_from_ts(task.get("finished_at") or task.get("updated_at"))
                    break
                if changed:
                    _write_archives_preserving_shape(path, raw, archives)
    except Exception as exc:
        with contextlib.suppress(Exception):
            with db() as conn:
                _insert_log(conn, task_id, "warn", "archive_sync", "自动化结果写入人设归档失败", {"error": str(exc)})


def _fail_task_safely(task_id: str, exc: Exception) -> None:
    try:
        if _is_task_cancelled(task_id):
            return
        row = get_social_task(task_id)
        retry_count = int(row.get("retry_count") or 0)
        max_retries = int(row.get("max_retries") or 0)
        if retry_count < max_retries:
            now = _now()
            with db() as conn:
                requeued = conn.execute(
                    """
                    UPDATE social_automation_tasks
                    SET status = 'queued', retry_count = ?, error = ?, updated_at = ?
                    WHERE id = ? AND status = 'running'
                    """,
                    (retry_count + 1, str(exc), now, task_id),
                ).rowcount
                if requeued:
                    _insert_log(conn, task_id, "warn", "retry", "任务失败，已重新排队", {"error": str(exc), "retry_count": retry_count + 1})
            if requeued:
                return
    except Exception:
        pass
    _finish_task(task_id, "failed", {}, str(exc))


class _DbTaskLogger:
    def __init__(self, task_id: str):
        self.task_id = task_id

    def log(
        self,
        level: str,
        stage: str,
        message: str,
        data: dict[str, Any] | None = None,
        screenshot_path: str = "",
    ) -> None:
        with db() as conn:
            if str(stage or "") == "need_manual":
                now = _now()
                conn.execute(
                    """
                    UPDATE social_automation_tasks
                    SET status = 'need_manual', error = ?, updated_at = ?
                    WHERE id = ? AND status IN ('queued', 'running', 'need_manual')
                    """,
                    (str(message or ""), now, self.task_id),
                )
            _insert_log(conn, self.task_id, level, stage, message, data or {}, screenshot_path)


def _insert_log(conn, task_id: str, level: str, stage: str, message: str, data: dict[str, Any] | None = None, screenshot_path: str = "") -> None:
    conn.execute(
        """
        INSERT INTO social_automation_logs(task_id, level, stage, message, data_json, screenshot_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            str(level or "info")[:20],
            str(stage or "log")[:80],
            str(message or "")[:2000],
            json.dumps(data or {}, ensure_ascii=False),
            str(screenshot_path or ""),
            _now(),
        ),
    )


def _account_public_rows(conn: Any, rows: list[Any]) -> list[dict[str, Any]]:
    proxy_ids = {str(row["proxy_id"] or "").strip() for row in rows if str(row["proxy_id"] or "").strip()}
    proxies: dict[str, Any] = {}
    if proxy_ids:
        placeholders = ",".join("?" for _ in proxy_ids)
        proxy_rows = conn.execute(f"SELECT * FROM social_proxies WHERE id IN ({placeholders})", tuple(proxy_ids)).fetchall()
        proxies = {str(row["id"] or ""): row for row in proxy_rows}
    return [_account_public(row, proxies.get(str(row["proxy_id"] or ""))) for row in rows]


def _proxy_public_rows(conn: Any, rows: list[Any]) -> list[dict[str, Any]]:
    proxy_ids = [str(row["id"] or "").strip() for row in rows if str(row["id"] or "").strip()]
    bound_accounts: dict[str, list[str]] = {proxy_id: [] for proxy_id in proxy_ids}
    if proxy_ids:
        placeholders = ",".join("?" for _ in proxy_ids)
        account_rows = conn.execute(
            f"""
            SELECT id, proxy_id
            FROM social_accounts
            WHERE proxy_id IN ({placeholders})
            ORDER BY proxy_id ASC, created_at ASC, id ASC
            """,
            tuple(proxy_ids),
        ).fetchall()
        for account in account_rows:
            bound_accounts.setdefault(str(account["proxy_id"] or ""), []).append(str(account["id"] or ""))
    return [
        _proxy_public(row, bound_account_ids=bound_accounts.get(str(row["id"] or ""), []))
        for row in rows
    ]


def _account_public(row: Any, proxy_row: Any | None = None) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": str(item.get("id") or ""),
        "persona_id": str(item.get("persona_id") or ""),
        "platform": str(item.get("platform") or ""),
        "username": str(item.get("username") or ""),
        "display_name": str(item.get("display_name") or ""),
        "profile_dir": str(item.get("profile_dir") or ""),
        "proxy_id": str(item.get("proxy_id") or ""),
        "residential_proxy": _residential_proxy_public(proxy_row) if proxy_row is not None else None,
        "status": str(item.get("status") or ""),
        "login_username": str(item.get("login_username") or "") or str(item.get("username") or ""),
        "login_password_configured": bool(str(item.get("login_password") or "")),
        "login_credentials_updated_at": int(item.get("login_credentials_updated_at") or 0),
        "last_login_check_at": int(item.get("last_login_check_at") or 0),
        "last_run_at": int(item.get("last_run_at") or 0),
        "last_error": str(item.get("last_error") or ""),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }


def _residential_proxy_public(row: Any) -> dict[str, Any]:
    item = dict(row)
    try:
        last_check_result = json.loads(str(item.get("last_check_result") or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        last_check_result = {}
    safe_result = _redact_sensitive(
        last_check_result if isinstance(last_check_result, dict) else {},
        secrets=(str(item.get("username") or ""), str(item.get("password") or "")),
    )
    response = safe_result.get("response") if isinstance(safe_result.get("response"), dict) else {}
    return {
        "protocol": str(item.get("proxy_type") or ""),
        "host": str(item.get("host") or ""),
        "port": int(item.get("port") or 0),
        "username_configured": bool(str(item.get("username") or "")),
        "password_configured": bool(str(item.get("password") or "")),
        "country": str(item.get("country") or ""),
        "region": str(item.get("region") or ""),
        "city": str(item.get("city") or ""),
        "isp": str(item.get("isp") or ""),
        "source": str(item.get("source") or "manual"),
        "ip_type": str(item.get("ip_type") or "static_residential"),
        "purchase_status": str(item.get("purchase_status") or "owned"),
        "note": str(item.get("note") or ""),
        "expires_at": int(item.get("expires_at") or 0),
        "status": str(item.get("status") or ""),
        "last_check_at": int(item.get("last_check_at") or 0),
        "last_check_result": safe_result,
        "exit_ip": str(response.get("ip") or safe_result.get("ip") or ""),
    }


def _redact_sensitive_text(value: str, secrets: tuple[str, ...] = ()) -> str:
    text = str(value or "")
    for secret in secrets:
        clean = str(secret or "")
        if not clean:
            continue
        text = text.replace(clean, "***")
        text = text.replace(quote(clean, safe=""), "***")
    return re.sub(
        r"(?i)\b((?:https?|socks5)://)[^/@\s]+@",
        r"\1***:***@",
        text,
    )


def _redact_sensitive(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            lower = str(key or "").lower()
            if any(token in lower for token in ("password", "passwd", "secret", "token", "cookie")):
                result[key] = "***" if str(item or "") else ""
            else:
                result[key] = _redact_sensitive(item, secrets)
        return result
    if isinstance(value, list):
        return [_redact_sensitive(item, secrets) for item in value]
    if isinstance(value, str):
        return _redact_sensitive_text(value, secrets)
    return value


def _strip_task_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            lower = str(key or "").lower()
            if lower in {"login_password", "password"}:
                continue
            result[str(key)] = _strip_task_secrets(item)
        return result
    if isinstance(value, list):
        return [_strip_task_secrets(item) for item in value]
    return value


def _extract_runtime_secrets(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    clean = dict(payload or {})
    secrets: dict[str, Any] = {}
    for key in ("login_password", "password"):
        value = str(clean.pop(key, "") or "")
        if value and not secrets.get("login_password"):
            secrets["login_password"] = value
    initial_cookies = clean.pop("initial_cookies", None)
    if initial_cookies is None:
        initial_cookies = clean.pop("initialCookies", None)
    if isinstance(initial_cookies, list) and initial_cookies:
        secrets["initial_cookies"] = initial_cookies
    return clean, secrets


def _runtime_task_payload(task: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
    payload = dict(task.get("payload") or {})
    settings = get_live_browser_settings()
    payload.setdefault("live_browser_standby_seconds", settings["standby_seconds"])
    payload.setdefault("live_browser_auto_close_seconds", settings["auto_close_seconds"])
    payload.setdefault("text_input_mode", settings.get("text_input_mode") or "paste")
    task_id = str(task.get("id") or "")
    with _EPHEMERAL_TASK_SECRETS_LOCK:
        secrets = dict(_EPHEMERAL_TASK_SECRETS.get(task_id) or {})
    if secrets.get("initial_cookies") and not payload.get("initial_cookies"):
        payload["initial_cookies"] = secrets["initial_cookies"]
    if str(task.get("task_type") or "") != "open_login" or _open_login_auto_submit_mode(payload) is not True:
        return payload
    saved_username = str(account.get("login_username") or "").strip()
    saved_password = str(account.get("login_password") or "")
    payload["login_username"] = str(payload.get("login_username") or saved_username or account.get("username") or "").strip()
    if not str(payload.get("login_password") or ""):
        runtime_password = str(secrets.get("login_password") or saved_password or "")
        if runtime_password:
            payload["login_password"] = runtime_password
    return payload


def _proxy_public(row: Any, *, bound_account_ids: list[str] | None = None) -> dict[str, Any]:
    item = dict(row)
    last_check_result = _redact_sensitive(
        _loads(item.get("last_check_result"), {}),
        secrets=(str(item.get("username") or ""), str(item.get("password") or "")),
    )
    response = last_check_result.get("response") if isinstance(last_check_result.get("response"), dict) else {}
    public = {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "proxy_type": str(item.get("proxy_type") or ""),
        "host": str(item.get("host") or ""),
        "port": int(item.get("port") or 0),
        "username_configured": bool(str(item.get("username") or "")),
        "password_configured": bool(str(item.get("password") or "")),
        "country": str(item.get("country") or ""),
        "region": str(item.get("region") or ""),
        "city": str(item.get("city") or ""),
        "isp": str(item.get("isp") or ""),
        "source": str(item.get("source") or "manual"),
        "ip_type": str(item.get("ip_type") or "static_residential"),
        "purchase_status": str(item.get("purchase_status") or "owned"),
        "note": str(item.get("note") or ""),
        "expires_at": int(item.get("expires_at") or 0),
        "status": str(item.get("status") or ""),
        "last_check_at": int(item.get("last_check_at") or 0),
        "last_check_result": last_check_result,
        "exit_ip": str(response.get("ip") or last_check_result.get("ip") or ""),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }
    if bound_account_ids is not None:
        public["bound_account_count"] = len(bound_account_ids)
        public["bound_account_ids"] = list(bound_account_ids)
    return public


def _task_public(row: Any) -> dict[str, Any]:
    item = dict(row)
    account_id = str(item.get("account_id") or "")
    account_username = str(item.get("account_username") or item.get("username") or "").strip()
    account_display_name = str(item.get("account_display_name") or item.get("display_name") or "").strip()
    if account_id and (not account_username or not account_display_name):
        try:
            account = get_social_account(account_id)
        except Exception:
            account = {}
        account_username = account_username or str(account.get("username") or "").strip()
        account_display_name = account_display_name or str(account.get("display_name") or "").strip()
    return {
        "id": str(item.get("id") or ""),
        "persona_id": str(item.get("persona_id") or ""),
        "account_id": account_id,
        "account_username": account_username,
        "account_display_name": account_display_name,
        "platform": str(item.get("platform") or ""),
        "task_type": str(item.get("task_type") or ""),
        "priority": int(item.get("priority") or 0),
        "status": str(item.get("status") or ""),
        "scheduled_at": int(item.get("scheduled_at") or 0),
        "started_at": int(item.get("started_at") or 0),
        "finished_at": int(item.get("finished_at") or 0),
        "payload": _redact_sensitive(_loads(item.get("payload_json"), {})),
        "result": _redact_sensitive(_loads(item.get("result_json"), {})),
        "error": str(item.get("error") or ""),
        "retry_count": int(item.get("retry_count") or 0),
        "max_retries": int(item.get("max_retries") or 0),
        "created_by": str(item.get("created_by") or ""),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }


def _log_public(row: Any) -> dict[str, Any]:
    item = dict(row)
    screenshot = str(item.get("screenshot_path") or "")
    return {
        "id": int(item.get("id") or 0),
        "task_id": str(item.get("task_id") or ""),
        "level": str(item.get("level") or ""),
        "stage": str(item.get("stage") or ""),
        "message": str(item.get("message") or ""),
        "data": _redact_sensitive(_loads(item.get("data_json"), {})),
        "screenshot_path": screenshot,
        "screenshot_url": f"/api/persona_dashboard/automation/screenshots/{Path(screenshot).name}" if screenshot else "",
        "created_at": int(item.get("created_at") or 0),
    }


def _require_proxy(conn, proxy_id: str) -> None:
    row = conn.execute("SELECT id, ip_type FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    if row and str(row["ip_type"] or "").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="账号仅允许绑定静态住宅 IP")
    if not row:
        raise HTTPException(status_code=404, detail="绑定代理不存在")


def _normalize_platform(platform: str) -> str:
    value = str(platform or "instagram").strip().lower()
    if value not in {"instagram", "threads"}:
        raise HTTPException(status_code=400, detail="当前自动化执行器仅支持 Instagram / Threads")
    return value


def _normalize_proxy_type(proxy_type: str) -> str:
    value = str(proxy_type or "http").strip().lower()
    if value not in {"http", "https", "socks5"}:
        raise HTTPException(status_code=400, detail="proxy_type 仅支持 http/https/socks5")
    return value


def _proxy_url(proxy: dict[str, Any], *, include_password: bool) -> str:
    scheme = _normalize_proxy_type(str(proxy.get("proxy_type") or "http"))
    host = str(proxy.get("host") or "").strip()
    port = int(proxy.get("port") or 0)
    username = str(proxy.get("username") or "").strip()
    raw_password = str(proxy.get("password") or "").strip()
    password = quote(raw_password, safe="") if include_password else ("***" if raw_password else "")
    auth = ""
    if username:
        encoded_username = quote(username, safe="")
        auth = encoded_username if not password else f"{encoded_username}:{password}"
        auth += "@"
    return f"{scheme}://{auth}{host}:{port}"


def _parse_schedule(value: int | str | None) -> int:
    if value in {None, "", 0, "0"}:
        return 0
    if isinstance(value, int):
        return max(0, value)
    text = str(value or "").strip()
    if text.isdigit():
        return int(text)
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            timezone_name = str(os.getenv("WEBAPP_TIMEZONE") or "Asia/Shanghai").strip() or "Asia/Shanghai"
            try:
                schedule_timezone = ZoneInfo(timezone_name)
            except ZoneInfoNotFoundError:
                schedule_timezone = timezone(timedelta(hours=8))
            parsed = parsed.replace(tzinfo=schedule_timezone)
        return int(parsed.timestamp())
    except Exception:
        raise HTTPException(status_code=400, detail="scheduled_at 必须是 Unix 秒或 ISO 时间")


def _loads(text: Any, default: Any) -> Any:
    try:
        if text in {None, ""}:
            return default
        return json.loads(str(text))
    except Exception:
        return default


def _now() -> int:
    return int(time.time())
