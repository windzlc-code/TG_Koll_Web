from __future__ import annotations

import binascii
import json
import os
import asyncio
import ipaddress
import re
import sqlite3
import threading
import time
import uuid
import contextlib
import subprocess
import shutil
import tempfile
from io import BytesIO
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from fastapi import Body, Depends, FastAPI, File, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, Field

from .auth import (
    ADMIN_CONSOLE_QUERY,
    ADMIN_SESSION_COOKIE,
    ADMIN_WORKSPACE_QUERY,
    SESSION_COOKIE,
    get_current_user,
    get_current_user_for_session,
    require_admin,
)
from .db import db
from . import commercial_billing, governance
from .password_vault import (
    PasswordVaultError,
    decrypt_secret as decrypt_vault_secret,
    encrypt_secret as encrypt_vault_secret,
)


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
_ADMIN_BILLING_WAIVED_PAYLOAD_IDS: set[int] = set()
_ADMIN_BILLING_WAIVED_PAYLOAD_IDS_LOCK = threading.Lock()
_TRUSTED_BATCH_TASK_CONTEXTS: dict[int, dict[str, Any]] = {}
_TRUSTED_BATCH_TASK_CONTEXTS_LOCK = threading.Lock()


def mark_admin_billing_waived_payload(payload: Any) -> None:
    with _ADMIN_BILLING_WAIVED_PAYLOAD_IDS_LOCK:
        _ADMIN_BILLING_WAIVED_PAYLOAD_IDS.add(id(payload))


def clear_admin_billing_waived_payload(payload: Any) -> None:
    with _ADMIN_BILLING_WAIVED_PAYLOAD_IDS_LOCK:
        _ADMIN_BILLING_WAIVED_PAYLOAD_IDS.discard(id(payload))


def _consume_admin_billing_waiver(payload: Any) -> bool:
    with _ADMIN_BILLING_WAIVED_PAYLOAD_IDS_LOCK:
        marked = id(payload) in _ADMIN_BILLING_WAIVED_PAYLOAD_IDS
        _ADMIN_BILLING_WAIVED_PAYLOAD_IDS.discard(id(payload))
    return marked


def mark_trusted_batch_task(
    payload: Any,
    *,
    task_id: str,
    reservation_id: str = "",
    suppress_wake: bool = True,
) -> None:
    with _TRUSTED_BATCH_TASK_CONTEXTS_LOCK:
        _TRUSTED_BATCH_TASK_CONTEXTS[id(payload)] = {
            "task_id": str(task_id),
            "reservation_id": str(reservation_id),
            "suppress_wake": bool(suppress_wake),
        }


def clear_trusted_batch_task(payload: Any) -> None:
    with _TRUSTED_BATCH_TASK_CONTEXTS_LOCK:
        _TRUSTED_BATCH_TASK_CONTEXTS.pop(id(payload), None)


def _consume_trusted_batch_task(payload: Any) -> dict[str, Any]:
    with _TRUSTED_BATCH_TASK_CONTEXTS_LOCK:
        return dict(_TRUSTED_BATCH_TASK_CONTEXTS.pop(id(payload), {}) or {})
SOCIAL_ACCOUNT_STATUSES = {
    "pending_login",
    "ready",
    "account_confirmation_required",
    "need_verification",
    "cookie_expired",
    "transient_error",
    "disabled",
}
SOCIAL_ACCOUNT_HEALTH_STATUSES = {"unknown", "alive", "abnormal", "banned"}
SOCIAL_TASK_STATUSES = {"preparing", "queued", "running", "success", "failed", "cancelled", "need_manual"}
DAILY_PUBLISH_LIMIT = 15
DAILY_PUBLISH_LIMIT_MESSAGE = "每日最多发布 15 篇。超过 15 篇会有封号风险，系统已强制禁止继续发布。"
SOCIAL_ACCOUNT_TOTP_PERIOD_SECONDS = 30
SOCIAL_ACCOUNT_TOTP_MIN_VALIDITY_SECONDS = 15
SOCIAL_MEDIA_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
    ".mp4", ".mov", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".aac",
}
SOCIAL_MEDIA_CONTENT_PREFIXES = ("image/", "video/", "audio/")
SOCIAL_MEDIA_MAX_FILES = 10
SOCIAL_MEDIA_MAX_FILE_BYTES = 50 * 1024 * 1024
SOCIAL_MEDIA_MAX_TOTAL_BYTES = 100 * 1024 * 1024

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


class StrictProxyModel(BaseModel):
    class Config:
        extra = "forbid"


class SocialProxyPayload(StrictProxyModel):
    name: str = ""
    proxy_type: str = "http"
    connection_mode: str = "proxy"
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


class SocialProxyPatchPayload(StrictProxyModel):
    name: str | None = None
    proxy_type: str | None = None
    connection_mode: str | None = None
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


class ResidentialProxyPayload(StrictProxyModel):
    protocol: str = "http"
    connection_mode: str = "proxy"
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


class SocialProxyCheckPayload(StrictProxyModel):
    proxy_id: str = ""
    proxy_type: str = "socks5"
    connection_mode: str = "proxy"
    host: str = ""
    port: int = 0
    username: str | None = None
    password: str | None = None


class SocialAccountPayload(BaseModel):
    persona_id: str = ""
    platform: str = "instagram"
    username: str = ""
    display_name: str = ""
    profile_dir: str = ""
    proxy_id: str = ""
    status: str = "pending_login"
    login_username: str = ""
    login_password: str = ""
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
    replace_existing_binding: bool = False
    username: str | None = None
    display_name: str | None = None
    profile_dir: str | None = None
    proxy_id: str | None = None
    expected_proxy_id: str | None = None
    status: str | None = None
    login_username: str | None = None
    login_password: str | None = None
    clear_login_credentials: bool | None = None
    clear_residential_proxy: bool | None = None
    residential_proxy: ResidentialProxyPayload | None = None


class SocialAccountTotpPayload(BaseModel):
    secret_or_uri: str = Field(min_length=1, max_length=2048)


class SocialTaskActionPayload(BaseModel):
    reason: str = ""


class LiveBrowserSettingsPayload(BaseModel):
    standby_seconds: int = Field(default=60, ge=0, le=3600)
    auto_close_seconds: int = Field(default=300, ge=10, le=86400)
    max_concurrency: int = Field(default=2, ge=1, le=12)
    text_input_mode: str = Field(default="paste", max_length=20)


class BrowserPreferencesPayload(BaseModel):
    completion_policy: str = Field(default="immediate_close", max_length=30)
    review_hold_seconds: int = Field(default=30, ge=10, le=300)
    standby_seconds: int | None = Field(default=None, ge=0, le=3600)
    auto_close_seconds: int | None = Field(default=None, ge=10, le=86400)
    manual_timeout_seconds: int = Field(default=900, ge=300, le=1800)
    requested_concurrency: int = Field(default=1, ge=1, le=12)
    text_input_mode: str = Field(default="paste", max_length=20)


class LiveBrowserTextPayload(BaseModel):
    text: str = Field(default="", max_length=2000)
    press_enter: bool = False


class LiveBrowserKeyPayload(BaseModel):
    key: str = Field(default="Enter", max_length=40)


class LiveBrowserModePayload(BaseModel):
    mode: str = Field(default="manual", max_length=20)


def configure_social_automation(*, data_dir: Path, new_id: Callable[[str], str] | None = None) -> None:
    global _DATA_DIR, _NEW_ID
    _DATA_DIR = Path(data_dir).resolve()
    if new_id is not None:
        _NEW_ID = new_id


def _identity_user_id(user: dict[str, Any]) -> int:
    try:
        return int(user.get("_workspace_user_id") or user.get("id") or 0)
    except (TypeError, ValueError):
        return 0


def _require_owned_resource(table: str, resource_id: str, user: dict[str, Any], *, label: str) -> Any:
    if table not in {"social_accounts", "social_proxies", "social_automation_tasks"}:
        raise RuntimeError("unsupported ownership table")
    with db() as conn:
        row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (str(resource_id or "").strip(),)).fetchone()
    if not row or int(row["user_id"] or 0) != _identity_user_id(user):
        raise HTTPException(status_code=404, detail=f"{label}不存在")
    return row


def _require_account_access(account_id: str, user: dict[str, Any]) -> Any:
    return _require_owned_resource("social_accounts", account_id, user, label="账号")


def _social_account_totp_purpose(account_id: str) -> str:
    clean_id = str(account_id or "").strip()
    if not clean_id:
        raise ValueError("account_id is required")
    return f"social-account-totp:{clean_id}"


def _normalize_social_account_totp_secret(secret_or_uri: str) -> str:
    value = str(secret_or_uri or "").strip()
    if value.lower().startswith("otpauth://"):
        parsed = urlparse(value)
        if parsed.scheme.lower() != "otpauth" or parsed.netloc.lower() != "totp":
            raise HTTPException(status_code=400, detail="仅支持 TOTP 身份验证器密钥")
        params = parse_qs(parsed.query, keep_blank_values=True)
        algorithm = str((params.get("algorithm") or ["SHA1"])[0] or "SHA1").strip().upper()
        digits_text = str((params.get("digits") or ["6"])[0] or "6").strip()
        period_text = str((params.get("period") or ["30"])[0] or "30").strip()
        if algorithm != "SHA1" or digits_text != "6" or period_text != "30":
            raise HTTPException(status_code=400, detail="当前仅支持 SHA1、6 位、30 秒周期的 TOTP 密钥")
        value = str((params.get("secret") or [""])[0] or "")
    normalized = re.sub(r"[\s-]+", "", value).upper()
    if "=" in normalized.rstrip("="):
        raise HTTPException(status_code=400, detail="2FA 密钥格式不正确，请填写 Base32 密钥或 otpauth URI")
    normalized = normalized.rstrip("=")
    if len(normalized) < 16 or not re.fullmatch(r"[A-Z2-7]+", normalized):
        raise HTTPException(status_code=400, detail="2FA 密钥格式不正确，请填写 Base32 密钥或 otpauth URI")
    try:
        governance.totp_code(normalized)
    except (binascii.Error, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="2FA 密钥无法生成有效验证码") from exc
    return normalized


def _social_account_totp_public(row: Any | None) -> dict[str, Any]:
    if row is None:
        return {
            "configured": False,
            "status": "not_configured",
            "updated_at": 0,
            "last_verified_at": 0,
        }
    item = dict(row)
    return {
        "configured": bool(str(item.get("secret_ciphertext") or "")),
        "status": str(item.get("status") or "pending"),
        "updated_at": int(item.get("updated_at") or 0),
        "last_verified_at": int(item.get("last_verified_at") or 0),
    }


def _social_account_totp_row(conn: Any, account_id: str) -> Any | None:
    return conn.execute(
        "SELECT * FROM social_account_totp_secrets WHERE account_id = ?",
        (str(account_id or "").strip(),),
    ).fetchone()


def _decrypt_social_account_totp_secret(row: Any) -> str:
    item = dict(row)
    account_id = str(item.get("account_id") or "")
    user_id = int(item.get("user_id") or 0)
    ciphertext = str(item.get("secret_ciphertext") or "")
    try:
        return decrypt_vault_secret(user_id, _social_account_totp_purpose(account_id), ciphertext)
    except PasswordVaultError as exc:
        raise RuntimeError("账号 2FA 密钥暂时不可用") from exc


def _social_account_totp_code_payload(row: Any, *, at: int | float | None = None) -> dict[str, Any]:
    now_ms = int(float(at) * 1000) if at is not None else int(time.time() * 1000)
    now = now_ms // 1000
    secret = _decrypt_social_account_totp_secret(row)
    code = governance.totp_code(secret, at=now)
    expires_at = ((now // SOCIAL_ACCOUNT_TOTP_PERIOD_SECONDS) + 1) * SOCIAL_ACCOUNT_TOTP_PERIOD_SECONDS
    return {
        "code": code,
        "server_time": now,
        "server_time_ms": now_ms,
        "expires_at": expires_at,
        "expires_at_ms": expires_at * 1000,
        "period_seconds": SOCIAL_ACCOUNT_TOTP_PERIOD_SECONDS,
        "valid_for_seconds": max(0, expires_at - now),
    }


def _reserve_social_account_totp_code(account_id: str, user_id: int) -> dict[str, Any]:
    now = int(time.time())
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _social_account_totp_row(conn, account_id)
        if row is None or int(row["user_id"] or 0) != int(user_id or 0):
            return {"available": False, "reason": "not_configured"}
        counter = now // SOCIAL_ACCOUNT_TOTP_PERIOD_SECONDS
        expires_at = (counter + 1) * SOCIAL_ACCOUNT_TOTP_PERIOD_SECONDS
        valid_for = max(0, expires_at - now)
        if valid_for < SOCIAL_ACCOUNT_TOTP_MIN_VALIDITY_SECONDS:
            return {
                "available": False,
                "reason": "period_ending",
                "wait_seconds": valid_for + 1,
                "expires_at": expires_at,
            }
        last_used_counter = int(
            row["last_used_counter"] if row["last_used_counter"] is not None else -1
        )
        if last_used_counter >= counter:
            return {
                "available": False,
                "reason": "counter_already_used",
                "wait_seconds": valid_for + 1,
                "expires_at": expires_at,
            }
        try:
            payload = _social_account_totp_code_payload(row, at=now)
        except RuntimeError:
            return {"available": False, "reason": "vault_unavailable"}
        conn.execute(
            """
            UPDATE social_account_totp_secrets
            SET last_used_counter = ?, last_attempt_at = ?, updated_at = ?
            WHERE account_id = ? AND user_id = ?
            """,
            (counter, now, now, str(account_id), int(user_id)),
        )
    return {"available": True, "counter": counter, **payload}


def _record_social_account_totp_outcome(account_id: str, user_id: int, outcome: str) -> bool:
    clean_outcome = str(outcome or "").strip().lower()
    now = int(time.time())
    status: str | None = None
    last_verified_at = 0
    last_error: str | None = None
    if clean_outcome == "verified":
        status = "verified"
        last_verified_at = now
        last_error = ""
    elif clean_outcome in {"rejected", "invalid"}:
        status = "error"
        last_error = "code_rejected"
    elif clean_outcome == "expired":
        last_error = "code_expired"
    elif clean_outcome == "unavailable":
        status = "error"
        last_error = "automatic_submission_failed"
    elif clean_outcome == "failed":
        last_error = "verification_inconclusive"
    with db() as conn:
        updated = conn.execute(
            """
            UPDATE social_account_totp_secrets
            SET status = COALESCE(?, status),
                last_verified_at = CASE WHEN ? > 0 THEN ? ELSE last_verified_at END,
                last_error = COALESCE(?, last_error),
                updated_at = ?
            WHERE account_id = ? AND user_id = ?
            """,
            (
                status,
                last_verified_at,
                last_verified_at,
                last_error,
                now,
                str(account_id),
                int(user_id),
            ),
        ).rowcount
    return bool(updated)


def _require_proxy_access(proxy_id: str, user: dict[str, Any]) -> Any:
    return _require_owned_resource("social_proxies", proxy_id, user, label="代理")


def _require_task_access(task_id: str, user: dict[str, Any]) -> Any:
    return _require_owned_resource("social_automation_tasks", task_id, user, label="任务")


def _require_persona_reference_access(persona_id: str, user: dict[str, Any]) -> None:
    clean_id = str(persona_id or "").strip()
    if not clean_id:
        return
    with db() as conn:
        row = conn.execute(
            "SELECT 1 FROM persona_owners WHERE archive_id = ? AND user_id = ?",
            (clean_id, _identity_user_id(user)),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="人设不存在")


def _validate_user_task_media_paths(payload: dict[str, Any], user: dict[str, Any]) -> None:
    media_paths = payload.get("media_paths") if isinstance(payload, dict) else []
    root = (_DATA_DIR / "social_automation" / "uploads" / str(_identity_user_id(user))).resolve()
    for value in media_paths if isinstance(media_paths, list) else []:
        try:
            path = Path(str(value or "")).expanduser().resolve()
        except Exception as exc:
            raise HTTPException(status_code=404, detail="媒体文件不存在") from exc
        if root not in path.parents or not path.is_file() or path.suffix.lower() not in SOCIAL_MEDIA_EXTENSIONS:
            raise HTTPException(status_code=404, detail="媒体文件不存在")


def _require_active_owner_user(conn: Any, owner_user_id: int) -> None:
    user_id = int(owner_user_id or 0)
    if user_id <= 0:
        return
    row = conn.execute(
        "SELECT is_admin, is_disabled, approval_status FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if (
        not row
        or int(row["is_disabled"] or 0) == 1
        or (int(row["is_admin"] or 0) != 1 and str(row["approval_status"] or "") != "approved")
    ):
        raise HTTPException(status_code=403, detail="账号已停用或不存在")


def _daily_publish_timezone():
    timezone_name = str(os.getenv("WEBAPP_TIMEZONE") or "Asia/Shanghai").strip() or "Asia/Shanghai"
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=8))


def _daily_publish_window(target_at: int | float | None = None) -> tuple[int, int, str]:
    target_ts = int(target_at or _now())
    try:
        local_time = datetime.fromtimestamp(target_ts, tz=_daily_publish_timezone())
    except (OverflowError, OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="发布时间超出支持范围") from exc
    start = local_time.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp()), start.date().isoformat()


def _owner_is_admin(conn: Any, user_id: int) -> bool:
    row = conn.execute("SELECT is_admin FROM users WHERE id = ?", (int(user_id or 0),)).fetchone()
    return bool(row and int(row["is_admin"] or 0) == 1)


def _daily_publish_day(target_at: int | float | None = None) -> str:
    return _daily_publish_window(target_at)[2]


def _daily_publish_used_count(
    conn: Any,
    user_id: int,
    quota_day: str,
    *,
    include_active_carryover: bool = False,
) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS task_count
        FROM social_daily_publish_slots
        WHERE user_id = ?
          AND waived = 0
          AND (
            (quota_day = ? AND state NOT IN ('released', 'waived'))
            OR (? = 1 AND quota_day != ? AND state IN ('reserved', 'armed'))
          )
        """,
        (int(user_id), str(quota_day), 1 if include_active_carryover else 0, str(quota_day)),
    ).fetchone()
    return int(row["task_count"] or 0) if row else 0


def _daily_publish_execution_count(
    conn: Any,
    user_id: int,
    quota_day: str,
    *,
    exclude_task_id: str = "",
) -> int:
    exclude_clause = " AND task_id != ?" if exclude_task_id else ""
    params: list[Any] = [int(user_id), str(quota_day)]
    if exclude_task_id:
        params.append(str(exclude_task_id))
    row = conn.execute(
        f"""
        SELECT COUNT(*) AS task_count
        FROM social_daily_publish_slots
        WHERE user_id = ?
          AND waived = 0
          AND (
            state IN ('reserved', 'armed')
            OR (quota_day = ? AND state IN ('submitted', 'confirmed', 'unknown'))
          )
          {exclude_clause}
        """,
        tuple(params),
    ).fetchone()
    return int(row["task_count"] or 0) if row else 0


def _ensure_daily_publish_slot(conn: Any, task: Any, *, now: int | None = None) -> Any:
    task_id = str(task["id"] or "")
    slot = conn.execute("SELECT * FROM social_daily_publish_slots WHERE task_id = ?", (task_id,)).fetchone()
    if slot is not None:
        return slot
    current = int(now or _now())
    waived = bool(int(task["daily_publish_waived"] or 0) or _owner_is_admin(conn, int(task["user_id"] or 0)))
    committed = bool(int(task["daily_publish_committed"] or 0))
    quota_at = int(task["daily_publish_committed_at"] or 0) if committed else int(task["scheduled_at"] or task["created_at"] or current)
    state = "waived" if waived else (
        "confirmed" if committed and str(task["status"] or "") == "success"
        else ("submitted" if committed else ("reserved" if str(task["status"] or "") in {"running", "need_manual"} else "planned"))
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO social_daily_publish_slots(
          task_id, user_id, quota_day, state, waived, submitted_at,
          released_at, release_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?)
        """,
        (
            task_id,
            int(task["user_id"] or 0),
            _daily_publish_day(quota_at),
            state,
            1 if waived else 0,
            int(task["daily_publish_committed_at"] or 0),
            int(task["created_at"] or current),
            current,
        ),
    )
    return conn.execute("SELECT * FROM social_daily_publish_slots WHERE task_id = ?", (task_id,)).fetchone()


def _release_daily_publish_slot(conn: Any, task_id: str, reason: str, *, now: int | None = None) -> None:
    current = int(now or _now())
    conn.execute(
        """
        UPDATE social_daily_publish_slots
        SET state = CASE
              WHEN state = 'armed' THEN 'unknown'
              WHEN state IN ('submitted', 'confirmed', 'unknown') THEN state
              WHEN state = 'waived' THEN 'waived'
              ELSE 'released'
            END,
            released_at = CASE WHEN state IN ('armed', 'submitted', 'confirmed', 'unknown', 'waived') THEN released_at ELSE ? END,
            release_reason = CASE WHEN state IN ('armed', 'submitted', 'confirmed', 'unknown', 'waived') THEN release_reason ELSE ? END,
            updated_at = ?
        WHERE task_id = ?
        """,
        (current, str(reason or "released"), current, str(task_id)),
    )


def _set_daily_publish_slot_state(
    conn: Any,
    task_id: str,
    state: str,
    *,
    now: int | None = None,
    quota_day: str = "",
) -> None:
    current = int(now or _now())
    submitted_at = current if state in {"submitted", "confirmed", "unknown"} else 0
    conn.execute(
        """
        UPDATE social_daily_publish_slots
        SET state = CASE WHEN waived = 1 THEN 'waived' ELSE ? END,
            quota_day = CASE WHEN ? != '' AND waived = 0 THEN ? ELSE quota_day END,
            submitted_at = CASE WHEN submitted_at > 0 THEN submitted_at WHEN ? > 0 THEN ? ELSE 0 END,
            updated_at = ?
        WHERE task_id = ?
        """,
        (state, quota_day, quota_day, submitted_at, submitted_at, current, str(task_id)),
    )


def _daily_publish_policy_in_transaction(
    conn: Any,
    user_id: int,
    *,
    scheduled_at: int | str | None = None,
    requested_count: int = 0,
    admin_waived: bool = False,
) -> dict[str, Any]:
    clean_user_id = int(user_id or 0)
    current = _now()
    target_at = _parse_schedule(scheduled_at)
    start_at, end_at, day = _daily_publish_window(target_at or current)
    waived = bool(admin_waived or _owner_is_admin(conn, clean_user_id))
    current_day = _daily_publish_day(current)
    used = 0 if waived else _daily_publish_used_count(
        conn,
        clean_user_id,
        day,
        include_active_carryover=day == current_day,
    )
    remaining = max(0, DAILY_PUBLISH_LIMIT - used)
    requested = max(0, int(requested_count or 0))
    locked = bool(not waived and used >= DAILY_PUBLISH_LIMIT)
    request_blocked = bool(not waived and requested > remaining)
    message = ""
    if locked:
        message = DAILY_PUBLISH_LIMIT_MESSAGE
    elif request_blocked:
        message = f"本次发布将超过每日 {DAILY_PUBLISH_LIMIT} 篇上限。超过 {DAILY_PUBLISH_LIMIT} 篇会有封号风险，系统已禁止提交。"
    return {
        "limit": DAILY_PUBLISH_LIMIT,
        "used": used,
        "remaining": remaining,
        "requested": requested,
        "locked": locked,
        "request_blocked": request_blocked,
        "can_publish": bool(waived or (not locked and not request_blocked)),
        "waived": waived,
        "day": day,
        "day_start": start_at,
        "day_end": end_at,
        "timezone": str(getattr(_daily_publish_timezone(), "key", "UTC+08:00")),
        "message": message,
    }


def get_daily_publish_policy(
    user_id: int,
    *,
    scheduled_at: int | str | None = None,
    requested_count: int = 0,
    admin_waived: bool = False,
) -> dict[str, Any]:
    with db() as conn:
        return _daily_publish_policy_in_transaction(
            conn,
            user_id,
            scheduled_at=scheduled_at,
            requested_count=requested_count,
            admin_waived=admin_waived,
        )


def require_daily_publish_capacity(
    user_id: int,
    *,
    requested_count: int = 1,
    scheduled_at: int | str | None = None,
    admin_waived: bool = False,
) -> dict[str, Any]:
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        policy = _daily_publish_policy_in_transaction(
            conn,
            user_id,
            scheduled_at=scheduled_at,
            requested_count=requested_count,
            admin_waived=admin_waived,
        )
        if not policy["can_publish"]:
            raise HTTPException(status_code=429, detail=policy["message"] or DAILY_PUBLISH_LIMIT_MESSAGE)
        return policy


def _billing_admin_waived(user: dict[str, Any]) -> bool:
    return bool(int(user.get("_workspace_admin_user_id") or 0) or int(user.get("is_admin") or 0))


def _create_social_task_for_user(payload: SocialTaskPayload, user: dict[str, Any]) -> dict[str, Any]:
    waived = _billing_admin_waived(user)
    if waived:
        mark_admin_billing_waived_payload(payload)
    try:
        return create_social_task(payload)
    finally:
        if waived:
            clear_admin_billing_waived_payload(payload)


def register_social_automation_routes(app: FastAPI) -> None:
    @app.get("/api/persona_dashboard/automation/overview")
    def api_social_automation_overview(user: dict[str, Any] = Depends(get_current_user)):
        return build_social_automation_overview(
            user_id=_identity_user_id(user),
            admin_waived=_billing_admin_waived(user),
        )

    @app.get("/api/persona_dashboard/automation/browser_sessions")
    def api_social_browser_sessions(user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "sessions": _live_browser_sessions(user_id=_identity_user_id(user), raise_on_error=True)}

    @app.get("/api/persona_dashboard/automation/browser_settings")
    def api_social_browser_settings(_user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "settings": get_live_browser_settings()}

    @app.put("/api/persona_dashboard/automation/browser_settings")
    def api_social_browser_settings_save(payload: LiveBrowserSettingsPayload, _user: dict[str, Any] = Depends(require_admin)):
        return {"ok": True, "settings": set_live_browser_settings(payload)}

    @app.get("/api/persona_dashboard/automation/browser_preferences")
    def api_browser_preferences(user: dict[str, Any] = Depends(get_current_user)):
        return browser_preferences_response(_identity_user_id(user))

    @app.put("/api/persona_dashboard/automation/browser_preferences")
    def api_browser_preferences_save(payload: BrowserPreferencesPayload, user: dict[str, Any] = Depends(get_current_user)):
        user_id = _identity_user_id(user)
        preferences = set_user_browser_preferences(user_id, payload, auto_configured=False)
        return browser_preferences_response(user_id, preferences=preferences)

    @app.get("/api/persona_dashboard/automation/browser_recommendation")
    def api_browser_recommendation(user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **browser_environment_recommendation(_identity_user_id(user))}

    @app.post("/api/persona_dashboard/automation/browser_preferences/auto_configure")
    def api_browser_preferences_auto_configure(user: dict[str, Any] = Depends(get_current_user)):
        user_id = _identity_user_id(user)
        recommendation = browser_environment_recommendation(user_id)
        recommended = recommendation["recommended"]
        preferences = set_user_browser_preferences(
            user_id,
            BrowserPreferencesPayload(**recommended),
            auto_configured=True,
        )
        return browser_preferences_response(user_id, preferences=preferences, recommendation=recommendation)

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/close")
    def api_social_browser_session_close(session_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_live_browser_session_access(session_id, user)
        close_live_browser_session(session_id)
        return {"ok": True, "closed": True}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/mode")
    def api_social_browser_session_mode(
        session_id: str,
        payload: LiveBrowserModePayload,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        _require_live_browser_session_access(session_id, user)
        mode = str(payload.mode or "").strip().lower()
        if mode != "manual":
            raise HTTPException(status_code=409, detail="人工接管后不能在同一登录任务中恢复自动模式，请重新发起登录任务")
        return {"ok": True, **request_live_browser_manual_takeover(session_id)}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/type")
    def api_social_browser_session_type(session_id: str, payload: LiveBrowserTextPayload, user: dict[str, Any] = Depends(get_current_user)):
        _require_live_browser_session_access(session_id, user)
        return {"ok": True, **type_live_browser_session_text(session_id, payload.text, press_enter=payload.press_enter)}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/key")
    def api_social_browser_session_key(session_id: str, payload: LiveBrowserKeyPayload, user: dict[str, Any] = Depends(get_current_user)):
        _require_live_browser_session_access(session_id, user)
        return {"ok": True, **press_live_browser_session_key(session_id, payload.key)}

    @app.post("/api/persona_dashboard/automation/browser_sessions/{session_id}/screenshot")
    def api_social_browser_session_screenshot(session_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_live_browser_session_access(session_id, user)
        return {"ok": True, **capture_live_browser_session_screenshot(session_id)}

    @app.websocket("/api/persona_dashboard/automation/browser_sessions/{session_id}/ws")
    async def api_social_browser_session_ws(websocket: WebSocket, session_id: str):
        user = _authenticate_live_browser_websocket(websocket, session_id)
        if not user:
            await websocket.close(code=1008)
            return
        _audit_admin_live_browser_action(user, "workspace.browser_session.connect", session_id)
        try:
            await _proxy_live_browser_websocket(websocket, session_id, user=user)
        finally:
            _audit_admin_live_browser_action(user, "workspace.browser_session.disconnect", session_id)

    @app.get("/api/persona_dashboard/automation/browser_sessions/{session_id}/kasm")
    def api_social_browser_session_kasm_root(session_id: str, request: Request):
        _authenticate_live_browser_http_request(request, session_id)
        return _proxy_live_browser_http(session_id, "vnc.html", request)

    @app.get("/api/persona_dashboard/automation/browser_sessions/{session_id}/kasm/{path:path}")
    def api_social_browser_session_kasm_path(session_id: str, path: str, request: Request):
        _authenticate_live_browser_http_request(request, session_id)
        return _proxy_live_browser_http(session_id, path or "vnc.html", request)

    @app.get("/api/persona_dashboard/automation/accounts")
    def api_social_accounts(user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM social_accounts WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC", (_identity_user_id(user),)).fetchall()
            accounts = _account_public_rows(conn, rows)
        return {"ok": True, "accounts": accounts}

    @app.post("/api/persona_dashboard/automation/accounts")
    def api_social_account_create(payload: SocialAccountPayload, user: dict[str, Any] = Depends(get_current_user)):
        _require_persona_reference_access(payload.persona_id, user)
        if payload.profile_dir:
            raise HTTPException(status_code=400, detail="普通用户不能指定浏览器配置目录")
        waived = _billing_admin_waived(user)
        if waived:
            mark_admin_billing_waived_payload(payload)
        try:
            account = create_social_account(payload, owner_user_id=_identity_user_id(user))
        finally:
            if waived:
                clear_admin_billing_waived_payload(payload)
        return {"ok": True, "account": account}

    @app.patch("/api/persona_dashboard/automation/accounts/{account_id}")
    def api_social_account_patch(account_id: str, payload: SocialAccountPatchPayload, user: dict[str, Any] = Depends(get_current_user)):
        _require_account_access(account_id, user)
        if payload.persona_id is not None:
            _require_persona_reference_access(payload.persona_id, user)
        if payload.profile_dir:
            raise HTTPException(status_code=400, detail="普通用户不能指定浏览器配置目录")
        if payload.proxy_id:
            proxy = _require_proxy_access(payload.proxy_id, user)
            if int(proxy["user_id"] or 0) != int(_require_account_access(account_id, user)["user_id"] or 0):
                raise HTTPException(status_code=404, detail="代理不存在")
        return {"ok": True, "account": update_social_account(account_id, payload)}

    @app.delete("/api/persona_dashboard/automation/accounts/{account_id}")
    def api_social_account_delete(account_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_account_access(account_id, user)
        return {"ok": True, "deleted": delete_social_account(account_id)}

    @app.post("/api/persona_dashboard/automation/accounts/dedupe")
    def api_social_accounts_dedupe(user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **dedupe_social_accounts(user_id=_identity_user_id(user))}

    @app.get("/api/persona_dashboard/automation/accounts/{account_id}/credentials")
    def api_social_account_credentials(account_id: str, user: dict[str, Any] = Depends(get_current_user)):
        account = _require_account_access(account_id, user)
        response = JSONResponse(
            content={
                "ok": True,
                "login_username": str(account["login_username"] or account["username"] or ""),
                "login_password": str(account["login_password"] or ""),
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.put("/api/persona_dashboard/automation/accounts/{account_id}/totp")
    def api_social_account_totp_set(
        account_id: str,
        payload: SocialAccountTotpPayload,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        account = _require_account_access(account_id, user)
        clean_id = str(account["id"] or "")
        owner_user_id = int(account["user_id"] or 0)
        secret = _normalize_social_account_totp_secret(payload.secret_or_uri)
        try:
            ciphertext = encrypt_vault_secret(
                owner_user_id,
                _social_account_totp_purpose(clean_id),
                secret,
            )
        except PasswordVaultError as exc:
            raise HTTPException(
                status_code=503,
                detail="密码保险库不可用，暂时无法保存 2FA 密钥",
            ) from exc
        now = int(time.time())
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO social_account_totp_secrets(
                  account_id, user_id, secret_ciphertext, status,
                  last_used_counter, last_attempt_at, last_verified_at,
                  last_error, created_at, updated_at
                )
                VALUES (?, ?, ?, 'pending', -1, 0, 0, '', ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                  user_id = excluded.user_id,
                  secret_ciphertext = excluded.secret_ciphertext,
                  status = 'pending',
                  last_used_counter = -1,
                  last_attempt_at = 0,
                  last_verified_at = 0,
                  last_error = '',
                  updated_at = excluded.updated_at
                """,
                (clean_id, owner_user_id, ciphertext, now, now),
            )
            row = _social_account_totp_row(conn, clean_id)
        response = JSONResponse(
            content={
                "ok": True,
                "totp": _social_account_totp_public(row),
                "current_code": _social_account_totp_code_payload(row, at=now),
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/persona_dashboard/automation/accounts/{account_id}/totp/code")
    def api_social_account_totp_code(account_id: str, user: dict[str, Any] = Depends(get_current_user)):
        account = _require_account_access(account_id, user)
        with db() as conn:
            row = _social_account_totp_row(conn, str(account["id"] or ""))
        if row is None:
            raise HTTPException(status_code=404, detail="该账号尚未配置 2FA 密钥")
        try:
            current_code = _social_account_totp_code_payload(row)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        response = JSONResponse(
            content={
                "ok": True,
                "totp": _social_account_totp_public(row),
                "current_code": current_code,
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.delete("/api/persona_dashboard/automation/accounts/{account_id}/totp")
    def api_social_account_totp_delete(account_id: str, user: dict[str, Any] = Depends(get_current_user)):
        account = _require_account_access(account_id, user)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            deleted = conn.execute(
                "DELETE FROM social_account_totp_secrets WHERE account_id = ? AND user_id = ?",
                (str(account["id"] or ""), int(account["user_id"] or 0)),
            ).rowcount
        response = JSONResponse(
            content={
                "ok": True,
                "deleted": int(deleted),
                "totp": _social_account_totp_public(None),
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/api/persona_dashboard/automation/accounts/{account_id}/check_login")
    def api_social_account_check_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        _require_account_access(account_id, user)
        body = payload if isinstance(payload, dict) else {}
        task_payload = body.get("payload") if isinstance(body.get("payload"), dict) else body
        _validate_user_task_media_paths(task_payload, user)
        return {
            "ok": True,
            "task": create_account_task(
                account_id,
                "check_login",
                task_payload,
                billing_admin_waived=_billing_admin_waived(user),
            ),
        }

    @app.post("/api/persona_dashboard/automation/accounts/{account_id}/open_login")
    def api_social_account_open_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        account = _require_account_access(account_id, user)
        wait_seconds = max(3600, int(os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "3600")))
        body = payload if isinstance(payload, dict) else {}
        task_payload = body.get("payload") if isinstance(body.get("payload"), dict) else body
        task_payload = dict(task_payload or {})
        _validate_user_task_media_paths(task_payload, user)
        requested_mode = _open_login_auto_submit_mode(task_payload)
        if requested_mode is False and "auto_submit" in task_payload:
            raise HTTPException(status_code=409, detail="打开登录默认使用自动模式；需要人工操作时请在浏览器窗口中切换人工接管")
        if requested_mode is None:
            raise HTTPException(status_code=422, detail="auto_submit must be a boolean when provided")
        if not str(account["login_username"] or account["username"] or "").strip() or not str(account["login_password"] or ""):
            raise HTTPException(status_code=409, detail="请先保存登录账号和密码，再打开自动登录")
        task_payload["auto_submit"] = True
        task_payload.setdefault("login_wait_seconds", wait_seconds)
        return {
            "ok": True,
            "task": create_account_task(
                account_id,
                "open_login",
                task_payload,
                billing_admin_waived=_billing_admin_waived(user),
            ),
        }

    @app.get("/api/persona_dashboard/automation/proxies")
    def api_social_proxies(user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM social_proxies WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC", (_identity_user_id(user),)).fetchall()
            proxies = _proxy_public_rows(conn, rows)
        return {"ok": True, "proxies": proxies}

    @app.post("/api/persona_dashboard/automation/proxies")
    def api_social_proxy_create(
        payload: SocialProxyPayload,
        request: Request,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        return {
            "ok": True,
            "proxy": create_social_proxy(
                payload,
                owner_user_id=_identity_user_id(user),
                idempotency_key=str(request.headers.get("Idempotency-Key") or ""),
            ),
        }

    @app.post("/api/persona_dashboard/automation/proxies/test")
    def api_social_proxy_test(payload: SocialProxyCheckPayload, user: dict[str, Any] = Depends(get_current_user)):
        if str(payload.proxy_id or "").strip():
            _require_proxy_access(payload.proxy_id, user)
        result = test_social_proxy(payload, owner_user_id=_identity_user_id(user))
        return {"ok": True, "check_ok": bool(result.get("ok")), "result": result}

    @app.patch("/api/persona_dashboard/automation/proxies/{proxy_id}")
    def api_social_proxy_patch(proxy_id: str, payload: SocialProxyPatchPayload, user: dict[str, Any] = Depends(get_current_user)):
        _require_proxy_access(proxy_id, user)
        return {"ok": True, "proxy": update_social_proxy(proxy_id, payload)}

    @app.delete("/api/persona_dashboard/automation/proxies/{proxy_id}")
    def api_social_proxy_delete(proxy_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_proxy_access(proxy_id, user)
        return {"ok": True, "deleted": delete_social_proxy(proxy_id)}

    @app.post("/api/persona_dashboard/automation/proxies/{proxy_id}/check")
    def api_social_proxy_check(proxy_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_proxy_access(proxy_id, user)
        proxy = check_social_proxy(proxy_id)
        return {"ok": True, "check_ok": bool(proxy.get("last_check_result", {}).get("ok")), "proxy": proxy}

    @app.get("/api/persona_dashboard/automation/tasks")
    def api_social_tasks(status: str = "", account_id: str = "", limit: int = 60, user: dict[str, Any] = Depends(get_current_user)):
        user_id = _identity_user_id(user)
        return {
            "ok": True,
            "tasks": list_social_tasks(status=status, account_id=account_id, limit=limit, user_id=user_id),
            "publish_policy": get_daily_publish_policy(user_id, admin_waived=_billing_admin_waived(user)),
        }

    @app.get("/api/persona_dashboard/automation/publish_policy")
    def api_social_publish_policy(
        scheduled_at: str = "",
        requested_count: int = 0,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        return {
            "ok": True,
            "publish_policy": get_daily_publish_policy(
                _identity_user_id(user),
                scheduled_at=scheduled_at,
                requested_count=max(0, min(int(requested_count or 0), 100)),
                admin_waived=_billing_admin_waived(user),
            ),
        }

    @app.post("/api/persona_dashboard/automation/tasks")
    def api_social_task_create(payload: SocialTaskPayload, user: dict[str, Any] = Depends(get_current_user)):
        account = _require_account_access(payload.account_id, user)
        _validate_user_task_media_paths(payload.payload, user)
        if str(payload.task_type or "").strip() == "open_login":
            if _open_login_auto_submit_mode(payload.payload) is not True:
                raise HTTPException(status_code=409, detail="登录任务必须从自动模式启动；运行后可随时切换人工接管")
            task_payload = payload.payload if isinstance(payload.payload, dict) else {}
            effective_username = str(task_payload.get("login_username") or account["login_username"] or account["username"] or "").strip()
            effective_password = str(task_payload.get("login_password") or account["login_password"] or "")
            if not effective_username or not effective_password:
                raise HTTPException(status_code=409, detail="请先提供或保存登录账号和密码，再创建自动登录任务")
        return {
            "ok": True,
            "task": _create_social_task_for_user(payload, user),
        }

    @app.post("/api/persona_dashboard/automation/tasks/cancel_all")
    def api_social_tasks_cancel_all(payload: SocialTaskActionPayload | None = None, user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, **cancel_all_social_tasks((payload.reason if payload else ""), user_id=_identity_user_id(user))}

    @app.get("/api/persona_dashboard/automation/tasks/{task_id}")
    def api_social_task_get(task_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_task_access(task_id, user)
        return {"ok": True, "task": get_social_task(task_id)}

    @app.delete("/api/persona_dashboard/automation/tasks")
    def api_social_tasks_clear(persona_id: str = "", account_id: str = "", user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "cleared": clear_social_tasks(persona_id=persona_id, account_id=account_id, user_id=_identity_user_id(user))}

    @app.delete("/api/persona_dashboard/automation/tasks/{task_id}")
    def api_social_task_clear(task_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_task_access(task_id, user)
        return {"ok": True, "cleared": clear_social_task(task_id)}

    @app.post("/api/persona_dashboard/automation/tasks/{task_id}/cancel")
    def api_social_task_cancel(task_id: str, payload: SocialTaskActionPayload | None = None, user: dict[str, Any] = Depends(get_current_user)):
        _require_task_access(task_id, user)
        return {"ok": True, "task": cancel_social_task(task_id, (payload.reason if payload else ""))}

    @app.post("/api/persona_dashboard/automation/tasks/{task_id}/retry")
    def api_social_task_retry(task_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_task_access(task_id, user)
        return {
            "ok": True,
            "task": retry_social_task(task_id, billing_admin_waived=True) if _billing_admin_waived(user) else retry_social_task(task_id),
        }

    @app.get("/api/persona_dashboard/automation/tasks/{task_id}/logs")
    def api_social_task_logs(task_id: str, user: dict[str, Any] = Depends(get_current_user)):
        _require_task_access(task_id, user)
        with db() as conn:
            logs = conn.execute(
                "SELECT * FROM social_automation_logs WHERE task_id = ? ORDER BY created_at ASC, id ASC",
                (task_id,),
            ).fetchall()
        return {"ok": True, "logs": [_log_public(row) for row in logs]}

    @app.get("/api/persona_dashboard/automation/tasks/{task_id}/media/{index}")
    def api_social_task_media(task_id: str, index: int, user: dict[str, Any] = Depends(get_current_user)):
        _require_task_access(task_id, user)
        task = get_social_task(task_id)
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        media_paths = [str(item or "").strip() for item in (payload.get("media_paths") or []) if str(item or "").strip()]
        if index < 0 or index >= len(media_paths):
            raise HTTPException(status_code=404, detail="媒体文件不存在")
        path = Path(media_paths[index]).expanduser().resolve()
        allowed_root = (_DATA_DIR / "social_automation" / "uploads" / str(_identity_user_id(user))).resolve()
        if (
            not path.exists()
            or not path.is_file()
            or path.suffix.lower() not in SOCIAL_MEDIA_EXTENSIONS
            or allowed_root not in path.parents
        ):
            raise HTTPException(status_code=404, detail="媒体文件不存在")
        return FileResponse(str(path), filename=path.name)

    @app.post("/api/persona_dashboard/automation/media")
    async def api_social_media_upload(files: list[UploadFile] = File(default=[]), user: dict[str, Any] = Depends(get_current_user)):
        uploads = list(files or [])
        if len(uploads) > SOCIAL_MEDIA_MAX_FILES:
            raise HTTPException(status_code=413, detail=f"单次最多上传 {SOCIAL_MEDIA_MAX_FILES} 个媒体文件")
        saved: list[dict[str, str]] = []
        upload_id = _NEW_ID("social_media")
        upload_dir = (_DATA_DIR / "social_automation" / "uploads" / str(_identity_user_id(user)) / upload_id).resolve()
        upload_dir.mkdir(parents=True, exist_ok=True)
        total_bytes = 0
        try:
            for index, upload in enumerate(uploads, start=1):
                filename = Path(str(upload.filename or f"media_{index}")).name
                suffix = Path(filename).suffix.lower()[:20]
                content_type = str(upload.content_type or "").lower()
                if suffix not in SOCIAL_MEDIA_EXTENSIONS or not content_type.startswith(SOCIAL_MEDIA_CONTENT_PREFIXES):
                    raise HTTPException(status_code=415, detail=f"不支持的媒体文件：{filename}")
                target = (upload_dir / f"media_{index}{suffix}").resolve()
                if upload_dir not in target.parents:
                    raise HTTPException(status_code=400, detail="素材文件名不合法")
                file_bytes = 0
                with target.open("wb") as fh:
                    while True:
                        chunk = await upload.read(1024 * 1024)
                        if not chunk:
                            break
                        file_bytes += len(chunk)
                        total_bytes += len(chunk)
                        if file_bytes > SOCIAL_MEDIA_MAX_FILE_BYTES or total_bytes > SOCIAL_MEDIA_MAX_TOTAL_BYTES:
                            raise HTTPException(status_code=413, detail="媒体文件超过上传大小限制")
                        fh.write(chunk)
                await upload.close()
                if file_bytes == 0:
                    raise HTTPException(status_code=400, detail=f"媒体文件为空：{filename}")
                saved.append({"name": filename, "path": str(target)})
        except Exception:
            for upload in uploads:
                with contextlib.suppress(Exception):
                    await upload.close()
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise
        if not saved:
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail="请先选择要上传的素材")
        return {"ok": True, "files": saved}

    @app.post("/api/persona_dashboard/automation/worker/run_once")
    def api_social_worker_run_once(_admin: dict[str, Any] = Depends(require_admin)):
        return {"ok": True, "result": run_social_automation_once()}

    @app.get("/api/persona_dashboard/automation/screenshots/{filename}")
    def api_social_screenshot(filename: str, thumbnail: bool = False, user: dict[str, Any] = Depends(get_current_user)):
        safe = Path(filename).name
        with db() as conn:
            rows = conn.execute(
                "SELECT l.screenshot_path FROM social_automation_logs l JOIN social_automation_tasks t ON t.id = l.task_id WHERE t.user_id = ? AND l.screenshot_path != ''",
                (_identity_user_id(user),),
            ).fetchall()
        if not any(Path(str(row["screenshot_path"] or "")).name == safe for row in rows):
            raise HTTPException(status_code=404, detail="截图不存在")
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


def _authenticate_live_browser_websocket(websocket: WebSocket, session_id: str = "") -> dict[str, Any] | None:
    query_params = getattr(websocket, "query_params", None)
    workspace_user_id = query_params.get(ADMIN_WORKSPACE_QUERY) if query_params is not None else None
    admin_console = query_params.get(ADMIN_CONSOLE_QUERY) if query_params is not None else None
    use_admin_session = bool(workspace_user_id) or str(admin_console or "").strip().lower() in {"1", "true", "yes", "on"}
    tokens = _live_browser_auth_tokens(
        session_token=websocket.cookies.get(SESSION_COOKIE),
        admin_session_token=websocket.cookies.get(ADMIN_SESSION_COOKIE),
        use_admin_session=use_admin_session,
    )
    return _first_live_browser_user_for_tokens(
        tokens,
        admin_workspace_user_id=workspace_user_id,
        session_id=session_id,
    )


def _authenticate_live_browser_http_request(request: Request, session_id: str = "") -> dict[str, Any]:
    workspace_user_id = request.query_params.get(ADMIN_WORKSPACE_QUERY)
    admin_console = request.query_params.get(ADMIN_CONSOLE_QUERY)
    use_admin_session = bool(workspace_user_id) or str(admin_console or "").strip().lower() in {"1", "true", "yes", "on"}
    tokens = _live_browser_auth_tokens(
        session_token=request.cookies.get(SESSION_COOKIE),
        admin_session_token=request.cookies.get(ADMIN_SESSION_COOKIE),
        use_admin_session=use_admin_session,
    )
    user = _first_live_browser_user_for_tokens(
        tokens,
        admin_workspace_user_id=workspace_user_id,
        request=request,
        session_id=session_id,
    )
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def _live_browser_auth_tokens(
    *,
    session_token: str | None,
    admin_session_token: str | None,
    use_admin_session: bool,
) -> list[str]:
    session = str(session_token or "").strip()
    admin = str(admin_session_token or "").strip()
    ordered = [admin, session] if use_admin_session else [session, admin]
    tokens: list[str] = []
    for token in ordered:
        if token and token not in tokens:
            tokens.append(token)
    return tokens


def _first_live_browser_user_for_tokens(
    tokens: list[str],
    *,
    admin_workspace_user_id: Any = None,
    request: Request | None = None,
    session_id: str = "",
) -> dict[str, Any] | None:
    first_user: dict[str, Any] | None = None
    for token in tokens:
        try:
            user = get_current_user_for_session(token, admin_workspace_user_id=admin_workspace_user_id, request=request)
        except Exception:
            continue
        if not first_user:
            first_user = user
        if session_id and _live_browser_session_accessible(session_id, user):
            return user
        if not session_id:
            return user
    if session_id and first_user is not None:
        raise HTTPException(status_code=404, detail="浏览器会话不存在")
    return None


def _live_browser_session_accessible(session_id: str, user: dict[str, Any]) -> bool:
    if int(user.get("is_admin") or 0) == 1 and not user.get("_workspace_user_id"):
        sessions = _live_browser_sessions(user_id=None)
    else:
        sessions = _live_browser_sessions(user_id=_identity_user_id(user))
    return any(
        str(item.get("id") or item.get("session_id") or "") == str(session_id or "")
        for item in sessions
    )


def _require_live_browser_session_access(session_id: str, user: dict[str, Any]) -> None:
    if not _live_browser_session_accessible(session_id, user):
        raise HTTPException(status_code=404, detail="浏览器会话不存在")


def _audit_admin_live_browser_action(
    user: dict[str, Any] | None,
    action: str,
    session_id: str,
) -> None:
    if not user:
        return
    admin_user_id = int(user.get("_workspace_admin_user_id") or 0)
    target_user_id = int(user.get("_workspace_user_id") or 0)
    if admin_user_id <= 0 or target_user_id <= 0:
        return
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO admin_audit_log(admin_user_id, action, target_user_id, metadata_json, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    admin_user_id,
                    str(action or "workspace.browser_session.control"),
                    target_user_id,
                    json.dumps({"session_id": str(session_id or "")}, ensure_ascii=True),
                    int(time.time()),
                ),
            )
    except Exception:
        return


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
    running_mode = _running_task_login_mode(str(task.get("id") or ""))
    if running_mode == "manual":
        return True
    if running_mode in {"switching", "takeover_timeout"}:
        return False
    payload = _load_task_payload_object(task.get("payload_json"))
    return bool(
        payload is not None
        and payload.get("manual_takeover") is True
        and _open_login_auto_submit_mode(payload) is False
    )


def _query_live_browser_input_allowed(task_id: str) -> bool:
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT id, status, task_type, payload_json FROM social_automation_tasks WHERE id = ?",
                (str(task_id or ""),),
            ).fetchone()
        return _live_browser_task_input_allowed(row)
    except Exception:
        return False


async def _live_browser_input_allowed(task_id: str) -> bool:
    return bool(await asyncio.to_thread(_query_live_browser_input_allowed, task_id))


def _query_live_browser_write_access(task_id: str, user: dict[str, Any] | None) -> bool:
    if _billing_admin_waived(user or {}):
        return True
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT user_id FROM social_automation_tasks WHERE id = ?",
                (str(task_id or ""),),
            ).fetchone()
            if row is None:
                return False
            owner_user_id = int(row["user_id"] or 0)
            if owner_user_id <= 0:
                return True
            commercial_billing.require_write_access(conn, owner_user_id)
        return True
    except Exception:
        return False


async def _live_browser_write_access(task_id: str, user: dict[str, Any] | None) -> bool:
    return bool(await asyncio.to_thread(_query_live_browser_write_access, task_id, user))


async def _proxy_live_browser_websocket(
    websocket: WebSocket,
    session_id: str,
    *,
    user: dict[str, Any] | None = None,
) -> None:
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
    control_audited = False

    async def forward_client_message(payload: bytes | str) -> bool:
        nonlocal control_audited
        inspection_payload = payload if isinstance(payload, bytes) else payload.encode("latin1", "ignore")
        requires_input = rfb_inspector.requires_input_permission(inspection_payload)
        if requires_input and not await _live_browser_input_allowed(session.task_id):
            return False
        if requires_input and not await _live_browser_write_access(session.task_id, user):
            return False
        if requires_input and not control_audited:
            _audit_admin_live_browser_action(user, "workspace.browser_session.control", session_id)
            control_audited = True
        await target.send(payload)
        return True

    async def browser_to_kasm() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                await forward_client_message(data)
                continue
            text = message.get("text")
            if text is not None:
                await forward_client_message(text)

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
    if upstream.status_code == 404 and clean_path.startswith("assets/"):
        static_response = _local_kasm_static_response(clean_path)
        if static_response is not None:
            return static_response
    headers = {}
    content_type = upstream.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    cache_control = upstream.headers.get("cache-control")
    if cache_control:
        headers["cache-control"] = cache_control
    return Response(content=upstream.content, status_code=upstream.status_code, headers=headers)


def _local_kasm_static_response(clean_path: str) -> FileResponse | None:
    asset_root = Path("/usr/share/kasmvnc/www/assets").resolve()
    relative_path = str(clean_path or "").removeprefix("assets/").lstrip("/")
    if not relative_path or ".." in Path(relative_path).parts:
        return None
    asset_path = (asset_root / relative_path).resolve()
    if asset_root not in asset_path.parents or not asset_path.is_file():
        return None
    return FileResponse(
        str(asset_path),
        headers={"Cache-Control": "public, max-age=86400"},
    )


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


def stop_social_automation_worker(*, timeout_seconds: float = 5.0) -> None:
    global _WORKER_THREAD
    _WORKER_STOP.set()
    _WORKER_WAKE.set()
    worker = _WORKER_THREAD
    if worker and worker.is_alive() and worker is not threading.current_thread():
        worker.join(timeout=max(float(timeout_seconds), 0.0))
    if worker is None or not worker.is_alive():
        _WORKER_THREAD = None
    _WORKER_STATE["enabled"] = False


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


def build_social_automation_overview(*, user_id: int | None = None, admin_waived: bool = False) -> dict[str, Any]:
    scope = "" if user_id is None else " WHERE user_id = ?"
    params: tuple[Any, ...] = () if user_id is None else (int(user_id),)
    with db() as conn:
        accounts = conn.execute(f"SELECT * FROM social_accounts{scope} ORDER BY updated_at DESC, created_at DESC", params).fetchall()
        proxies = conn.execute(f"SELECT * FROM social_proxies{scope} ORDER BY updated_at DESC, created_at DESC", params).fetchall()
        public_accounts = _account_public_rows(conn, accounts)
        public_proxies = _proxy_public_rows(conn, proxies)
        tasks = conn.execute(
            f"SELECT * FROM social_automation_tasks{scope} ORDER BY created_at DESC LIMIT 80",
            params,
        ).fetchall()
        task_billing_statuses = _billing_reservation_statuses(conn, list(tasks))
        all_tasks = conn.execute(f"SELECT task_type, payload_json, status, finished_at FROM social_automation_tasks{scope}", params).fetchall()
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
        "tasks": [
            _task_public(
                row,
                billing_reservation_status=task_billing_statuses.get(str(row["billing_reservation_id"] or ""), ""),
            )
            for row in visible_tasks
        ],
        "browser_sessions": _live_browser_sessions(user_id=user_id),
        "worker": (
            dict(_WORKER_STATE)
            if user_id is None
            else {
                "status": str(_WORKER_STATE.get("status") or "idle"),
                "running_count": counts.get("running", 0),
            }
        ),
        "supported_task_types": sorted(SOCIAL_TASK_TYPES),
        "publish_policy": (
            get_daily_publish_policy(int(user_id), admin_waived=admin_waived)
            if user_id is not None
            else {"limit": DAILY_PUBLISH_LIMIT, "used": 0, "remaining": DAILY_PUBLISH_LIMIT, "locked": False, "waived": True}
        ),
    }


def _live_browser_sessions(*, user_id: int | None = None, raise_on_error: bool = False) -> list[dict[str, Any]]:
    try:
        from social_automation.live_browser import list_live_browser_sessions

        sessions = list_live_browser_sessions()
    except Exception as exc:
        if raise_on_error:
            raise HTTPException(status_code=503, detail="实时浏览器会话暂时不可用") from exc
        return []
    task_ids = [str(session.get("task_id") or "").strip() for session in sessions if str(session.get("task_id") or "").strip()]
    if not task_ids:
        return sessions if user_id is None else []
    placeholders = ",".join("?" for _ in task_ids)
    try:
        with db() as conn:
            owner_clause = "" if user_id is None else " AND user_id = ?"
            owner_params: list[Any] = [] if user_id is None else [int(user_id)]
            rows = conn.execute(
                f"SELECT id, status, task_type, payload_json, error, finished_at FROM social_automation_tasks WHERE id IN ({placeholders}){owner_clause}",
                [*task_ids, *owner_params],
            ).fetchall()
        task_status = {str(row["id"]): row for row in rows}
    except Exception as exc:
        if raise_on_error:
            raise HTTPException(status_code=503, detail="实时浏览器会话暂时不可用") from exc
        return sessions if user_id is None else []
    visible_sessions: list[dict[str, Any]] = []
    for session in sessions:
        row = task_status.get(str(session.get("task_id") or ""))
        if not row:
            continue
        visible_sessions.append(session)
        status = str(row["status"] or "").strip().lower()
        if status:
            session["task_status"] = status
        session["input_allowed"] = bool(session.get("browser_ready")) and _live_browser_task_input_allowed(row)
        if str(row["task_type"] or "").strip() == "open_login":
            session["login_mode"] = _live_browser_open_login_mode(row)
        if str(row["error"] or "").strip():
            session["task_error"] = str(row["error"] or "")
        session["task_finished_at"] = int(row["finished_at"] or 0)
    return visible_sessions


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
        "max_concurrency": _bounded_env_int("SOCIAL_AUTOMATION_WORKER_CONCURRENCY", 2, 1, 12),
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


def _normalize_completion_policy(value: Any) -> str:
    policy = str(value or "").strip().lower()
    return policy if policy in {"immediate_close", "review_hold"} else "immediate_close"


def _default_user_browser_preferences() -> dict[str, Any]:
    global_limit = int(get_live_browser_settings().get("max_concurrency") or 2)
    return {
        "completion_policy": "immediate_close",
        "review_hold_seconds": 30,
        "standby_seconds": 0,
        "auto_close_seconds": 30,
        "manual_timeout_seconds": 900,
        "requested_concurrency": max(1, min(2, global_limit)),
        "text_input_mode": "paste",
        "auto_configured": False,
        "updated_at": 0,
    }


def get_user_browser_preferences(user_id: int) -> dict[str, Any]:
    defaults = _default_user_browser_preferences()
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM user_browser_settings WHERE user_id = ?",
                (int(user_id),),
            ).fetchone()
        if not row:
            return defaults
        return {
            "completion_policy": _normalize_completion_policy(row["completion_policy"]),
            "review_hold_seconds": max(10, min(int(row["review_hold_seconds"] or 30), 300)),
            "standby_seconds": max(0, min(int(row["standby_seconds"] or 0), 3600)),
            "auto_close_seconds": max(10, min(int(row["auto_close_seconds"] or 30), 86400)),
            "manual_timeout_seconds": max(300, min(int(row["manual_timeout_seconds"] or 900), 1800)),
            "requested_concurrency": max(1, min(int(row["requested_concurrency"] or 1), 12)),
            "text_input_mode": _normalize_text_input_mode(row["text_input_mode"]),
            "auto_configured": bool(row["auto_configured"]),
            "updated_at": int(row["updated_at"] or 0),
        }
    except Exception:
        return defaults


def effective_user_browser_preferences(preferences: dict[str, Any]) -> dict[str, Any]:
    global_settings = get_live_browser_settings()
    global_limit = max(1, min(int(global_settings.get("max_concurrency") or 2), 12))
    policy = _normalize_completion_policy(preferences.get("completion_policy"))
    hold_seconds = max(10, min(int(preferences.get("review_hold_seconds") or 30), 300))
    standby_seconds = max(0, min(int(preferences.get("standby_seconds") or 0), 3600))
    auto_close_seconds = max(10, min(int(preferences.get("auto_close_seconds") or hold_seconds), 86400))
    return {
        "completion_policy": policy,
        "review_hold_seconds": hold_seconds if policy == "review_hold" else 0,
        "standby_seconds": standby_seconds if policy == "review_hold" else 0,
        "auto_close_seconds": auto_close_seconds if policy == "review_hold" else 10,
        "manual_timeout_seconds": max(300, min(int(preferences.get("manual_timeout_seconds") or 900), 1800)),
        "requested_concurrency": max(1, min(int(preferences.get("requested_concurrency") or 1), global_limit)),
        "text_input_mode": _normalize_text_input_mode(preferences.get("text_input_mode")),
        "global_max_concurrency": global_limit,
    }


def set_user_browser_preferences(
    user_id: int,
    payload: BrowserPreferencesPayload,
    *,
    auto_configured: bool,
) -> dict[str, Any]:
    clean_user_id = int(user_id or 0)
    if clean_user_id <= 0:
        raise HTTPException(status_code=401, detail="登录状态无效")
    current_preferences = get_user_browser_preferences(clean_user_id)
    standby_seconds = (
        int(current_preferences.get("standby_seconds") or 0)
        if payload.standby_seconds is None
        else int(payload.standby_seconds)
    )
    auto_close_seconds = (
        int(current_preferences.get("auto_close_seconds") or 30)
        if payload.auto_close_seconds is None
        else int(payload.auto_close_seconds)
    )
    preferences = {
        "completion_policy": _normalize_completion_policy(payload.completion_policy),
        "review_hold_seconds": max(10, min(auto_close_seconds, 300)),
        "standby_seconds": max(0, min(standby_seconds, 3600)),
        "auto_close_seconds": max(10, min(auto_close_seconds, 86400)),
        "manual_timeout_seconds": max(300, min(int(payload.manual_timeout_seconds), 1800)),
        "requested_concurrency": max(1, min(int(payload.requested_concurrency), 12)),
        "text_input_mode": _normalize_text_input_mode(payload.text_input_mode),
        "auto_configured": bool(auto_configured),
        "updated_at": _now(),
    }
    with db() as conn:
        owner = conn.execute("SELECT 1 FROM users WHERE id = ? AND deleted_at = 0", (clean_user_id,)).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="用户不存在")
        conn.execute(
            """
            INSERT INTO user_browser_settings(
              user_id, completion_policy, review_hold_seconds, manual_timeout_seconds,
              requested_concurrency, text_input_mode, auto_configured, updated_at,
              standby_seconds, auto_close_seconds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              completion_policy = excluded.completion_policy,
              review_hold_seconds = excluded.review_hold_seconds,
              standby_seconds = excluded.standby_seconds,
              auto_close_seconds = excluded.auto_close_seconds,
              manual_timeout_seconds = excluded.manual_timeout_seconds,
              requested_concurrency = excluded.requested_concurrency,
              text_input_mode = excluded.text_input_mode,
              auto_configured = excluded.auto_configured,
              updated_at = excluded.updated_at
            """,
            (
                clean_user_id,
                preferences["completion_policy"],
                preferences["review_hold_seconds"],
                preferences["manual_timeout_seconds"],
                preferences["requested_concurrency"],
                preferences["text_input_mode"],
                int(preferences["auto_configured"]),
                preferences["updated_at"],
                preferences["standby_seconds"],
                preferences["auto_close_seconds"],
            ),
        )
    wake_social_automation_worker()
    return preferences


def _memory_environment() -> dict[str, int]:
    values: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            name, _, raw = line.partition(":")
            if name in {"MemTotal", "MemAvailable", "SwapTotal"}:
                values[name] = int(raw.strip().split()[0]) // 1024
    except Exception:
        pass
    return {
        "memory_total_mb": int(values.get("MemTotal") or 0),
        "memory_available_mb": int(values.get("MemAvailable") or 0),
        "swap_total_mb": int(values.get("SwapTotal") or 0),
    }


def _recent_user_task_continuity(user_id: int) -> dict[str, int]:
    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT account_id, started_at
                FROM social_automation_tasks
                WHERE user_id = ? AND started_at > 0
                ORDER BY started_at DESC
                LIMIT 100
                """,
                (int(user_id),),
            ).fetchall()
    except Exception:
        rows = []
    previous: dict[str, int] = {}
    compared = 0
    within_30_seconds = 0
    for row in rows:
        account_id = str(row["account_id"] or "")
        started_at = int(row["started_at"] or 0)
        if account_id in previous:
            compared += 1
            if 0 <= previous[account_id] - started_at <= 30:
                within_30_seconds += 1
        previous[account_id] = started_at
    return {"compared": compared, "within_30_seconds": within_30_seconds}


def browser_environment_recommendation(user_id: int) -> dict[str, Any]:
    memory = _memory_environment()
    cpu_cores = max(1, int(os.cpu_count() or 1))
    total_mb = int(memory["memory_total_mb"] or 0)
    available_mb = int(memory["memory_available_mb"] or 0)
    swap_mb = int(memory["swap_total_mb"] or 0)
    global_limit = max(1, min(int(get_live_browser_settings().get("max_concurrency") or 2), 12))
    if cpu_cores <= 2 or (total_mb and total_mb <= 4096) or (available_mb and available_mb < 1024):
        resource_level = "limited"
        resource_label = "资源紧凑"
    elif cpu_cores <= 4 or (total_mb and total_mb <= 8192):
        resource_level = "balanced"
        resource_label = "资源均衡"
    else:
        resource_level = "ample"
        resource_label = "资源充足"
    try:
        active_browsers = len(_live_browser_sessions(user_id=int(user_id)))
    except Exception:
        active_browsers = 0
    try:
        with db() as conn:
            running_tasks = int(conn.execute(
                "SELECT COUNT(*) FROM social_automation_tasks WHERE user_id = ? AND status IN ('running', 'need_manual')",
                (int(user_id),),
            ).fetchone()[0])
    except Exception:
        running_tasks = 0
    continuity = _recent_user_task_continuity(user_id)
    recommended_concurrency = max(1, min(2 if resource_level != "ample" else 3, global_limit))
    reasons = [
        f"当前运行环境为{resource_label}，个人并发建议设为 {recommended_concurrency}。",
        "任务结束后立即关闭浏览器，可释放 Camoufox 与实时画面占用的内存。",
        "人工处理保留 15 分钟，兼顾验证码操作时间与并发槽回收。",
    ]
    if swap_mb <= 0:
        reasons.append("当前环境未启用 Swap，不建议长期保留已完成的浏览器窗口。")
    if continuity["compared"] and continuity["within_30_seconds"] * 4 < continuity["compared"]:
        reasons.append("近期同账号连续任务较少，保留完成窗口不会明显缩短下一任务等待。")
    summary_bits = [f"{cpu_cores} 核 CPU"]
    if total_mb:
        summary_bits.append(f"{round(total_mb / 1024, 1)} GB 内存")
    summary_bits.append("无 Swap" if swap_mb <= 0 else "已启用 Swap")
    return {
        "environment": {
            "resource_level": resource_level,
            "resource_label": resource_label,
            "summary": " · ".join(summary_bits),
            "cpu_cores": cpu_cores,
            "memory_total_mb": total_mb,
            "memory_available_mb": available_mb,
            "swap_enabled": swap_mb > 0,
            "active_browsers": active_browsers,
            "running_tasks": running_tasks,
            "detected_at": _now(),
        },
        "recommended": {
            "completion_policy": "immediate_close",
            "review_hold_seconds": 30,
            "standby_seconds": 0,
            "auto_close_seconds": 30,
            "manual_timeout_seconds": 900,
            "requested_concurrency": recommended_concurrency,
            "text_input_mode": "paste",
        },
        "reasons": reasons,
        "limits": {
            "global_max_concurrency": global_limit,
            "max_review_hold_seconds": 300,
            "max_standby_seconds": 3600,
            "max_auto_close_seconds": 86400,
            "manual_timeout_min_seconds": 300,
            "manual_timeout_max_seconds": 1800,
        },
    }


def browser_preferences_response(
    user_id: int,
    *,
    preferences: dict[str, Any] | None = None,
    recommendation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = preferences or get_user_browser_preferences(user_id)
    result = recommendation or browser_environment_recommendation(user_id)
    return {
        "ok": True,
        "preferences": current,
        "effective": effective_user_browser_preferences(current),
        "environment": result["environment"],
        "recommended": result["recommended"],
        "reasons": result["reasons"],
        "limits": result["limits"],
    }


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


def _running_task_manual_mode(task_id: str) -> bool:
    clean_task_id = str(task_id or "").strip()
    if not clean_task_id:
        return False
    with _RUNNING_TASK_CONTROLS_LOCK:
        control = _RUNNING_TASK_CONTROLS.get(clean_task_id)
        event = control.get("manual_takeover_ack_event") if control else None
    return bool(event is not None and getattr(event, "is_set", lambda: False)())


def _running_task_login_mode(task_id: str) -> str:
    clean_task_id = str(task_id or "").strip()
    if not clean_task_id:
        return "automatic"
    with _RUNNING_TASK_CONTROLS_LOCK:
        control = _RUNNING_TASK_CONTROLS.get(clean_task_id)
        request_event = control.get("manual_takeover_event") if control else None
        ack_event = control.get("manual_takeover_ack_event") if control else None
        timeout_event = control.get("manual_takeover_timeout_event") if control else None
    if ack_event is not None and getattr(ack_event, "is_set", lambda: False)():
        return "manual"
    if timeout_event is not None and getattr(timeout_event, "is_set", lambda: False)():
        return "takeover_timeout"
    if request_event is not None and getattr(request_event, "is_set", lambda: False)():
        return "switching"
    return "automatic"


def _live_browser_open_login_mode(row: Any) -> str:
    if str(row["status"] or "").strip().lower() == "need_manual":
        return "manual"
    running_mode = _running_task_login_mode(str(row["id"] or ""))
    if running_mode in {"switching", "takeover_timeout"}:
        return running_mode
    return "manual" if _live_browser_task_input_allowed(row) else "automatic"


def _persist_manual_takeover_ack(task_id: str, session_id: str) -> bool:
    with db() as conn:
        row = conn.execute(
            "SELECT status, task_type, payload_json FROM social_automation_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if not row or str(row["status"] or "") not in {"running", "need_manual"}:
            return False
        task_type = str(row["task_type"] or "")
        status_changed = str(row["status"] or "") != "need_manual"
        task_payload = _loads(row["payload_json"], {})
        payload_changed = task_type == "open_login" and (
            task_payload.get("auto_submit") is not False or not bool(task_payload.get("manual_takeover"))
        )
        if payload_changed:
            task_payload["auto_submit"] = False
            task_payload["manual_takeover"] = True
        conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'need_manual', payload_json = ?, updated_at = ?
            WHERE id = ? AND status IN ('running', 'need_manual')
            """,
            (json.dumps(task_payload, ensure_ascii=False), _now(), task_id),
        )
        if not status_changed and not payload_changed:
            return True
        _insert_log(
            conn,
            task_id,
            "warn",
            "manual_takeover_requested",
            "用户已切换为人工接管，自动登录操作已停止。",
            {"session_id": session_id},
        )
    return True


def _persist_manual_takeover_resolved(task_id: str, session_id: str) -> bool:
    now = _now()
    with db() as conn:
        resumed = conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'running', updated_at = ?
            WHERE id = ? AND status = 'need_manual'
            """,
            (now, task_id),
        ).rowcount
        if resumed:
            _insert_log(
                conn,
                task_id,
                "info",
                "manual_takeover_resolved",
                "人工验证已完成，自动化任务继续执行。",
                {"session_id": session_id},
            )
            return True
        row = conn.execute("SELECT status FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        return bool(row and str(row["status"] or "") == "running")


def _await_and_persist_manual_takeover_ack(task_id: str, session_id: str, ack_event: Any) -> None:
    wait_seconds = max(5.0, min(float(os.getenv("SOCIAL_AUTOMATION_TAKEOVER_ACK_SECONDS", "30")), 120.0))
    if bool(ack_event.wait(timeout=wait_seconds)):
        with contextlib.suppress(Exception):
            _persist_manual_takeover_ack(task_id, session_id)
        return
    with _RUNNING_TASK_CONTROLS_LOCK:
        control = _RUNNING_TASK_CONTROLS.get(task_id)
        if control is None or control.get("manual_takeover_ack_event") is not ack_event:
            return
        timeout_event = control.get("manual_takeover_timeout_event")
        if timeout_event is not None:
            timeout_event.set()
        control["manual_takeover_ack_watcher_started"] = False


def request_live_browser_manual_takeover(session_id: str) -> dict[str, Any]:
    clean_id = str(session_id or "").strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="缺少实时浏览器会话")
    task_id = ""
    event = None
    ack_event = None
    timeout_event = None
    matched_control: dict[str, Any] | None = None
    with _RUNNING_TASK_CONTROLS_LOCK:
        for candidate_task_id, control in _RUNNING_TASK_CONTROLS.items():
            if str(control.get("live_browser_session_id") or "") != clean_id:
                continue
            task_id = str(candidate_task_id or "")
            event = control.get("manual_takeover_event")
            ack_event = control.get("manual_takeover_ack_event")
            timeout_event = control.get("manual_takeover_timeout_event")
            matched_control = control
            break
    if not task_id or event is None or ack_event is None or timeout_event is None:
        raise HTTPException(status_code=409, detail="当前登录任务尚未进入可接管的浏览器会话")
    with db() as conn:
        row = conn.execute(
            "SELECT id, status, task_type FROM social_automation_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
    status = str(row["status"] or "").strip().lower() if row else ""
    if not row or status not in {"running", "need_manual"} or str(row["task_type"] or "") != "open_login":
        raise HTTPException(status_code=409, detail="当前浏览器不是正在运行的登录任务")
    already_manual = status == "need_manual" or bool(getattr(ack_event, "is_set", lambda: False)())
    timeout_event.clear()
    event.set()
    if status == "need_manual":
        ack_event.set()
    acknowledged = status == "need_manual" or bool(getattr(ack_event, "is_set", lambda: False)())
    if acknowledged:
        _persist_manual_takeover_ack(task_id, clean_id)
    elif matched_control is not None:
        start_watcher = False
        with _RUNNING_TASK_CONTROLS_LOCK:
            if not matched_control.get("manual_takeover_ack_watcher_started"):
                matched_control["manual_takeover_ack_watcher_started"] = True
                start_watcher = True
        if start_watcher:
            threading.Thread(
                target=_await_and_persist_manual_takeover_ack,
                args=(task_id, clean_id, ack_event),
                name=f"manual-takeover-ack-{task_id[:12]}",
                daemon=True,
            ).start()
    return {
        "task_id": task_id,
        "session_id": clean_id,
        "mode": "manual" if acknowledged else "switching",
        "acknowledged": acknowledged,
        "already_manual": already_manual,
    }


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
            "SELECT id, status, task_type, payload_json FROM social_automation_tasks WHERE id = ?",
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


def _running_control_for_live_browser_session(session_id: str) -> dict[str, Any] | None:
    clean_id = str(session_id or "").strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="浏览器会话不能为空")
    with _RUNNING_TASK_CONTROLS_LOCK:
        for control in _RUNNING_TASK_CONTROLS.values():
            if str(control.get("live_browser_session_id") or "") == clean_id:
                return control
    return None


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


def create_social_proxy(
    payload: SocialProxyPayload,
    *,
    owner_user_id: int = 0,
    idempotency_key: str = "",
) -> dict[str, Any]:
    _normalize_proxy_connection_mode(payload.connection_mode)
    request_id = str(idempotency_key or "").strip()
    if request_id and not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_id):
        raise HTTPException(status_code=400, detail="Idempotency-Key 格式无效")
    if str(payload.ip_type or "static_residential").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _require_active_owner_user(conn, owner_user_id)
        if request_id:
            existing = conn.execute(
                "SELECT * FROM social_proxies WHERE user_id = ? AND client_request_id = ?",
                (max(0, int(owner_user_id or 0)), request_id),
            ).fetchone()
            if existing:
                return _proxy_public(existing)
        row = _insert_social_proxy(
            conn,
            protocol=payload.proxy_type,
            host=payload.host,
            port=payload.port,
            username=payload.username,
            password=payload.password,
            name=payload.name,
            country="",
            region="",
            city="",
            isp="",
            source=payload.source,
            ip_type="static_residential",
            purchase_status=payload.purchase_status,
            note=payload.note,
            expires_at=payload.expires_at,
            status="pending",
            owner_user_id=owner_user_id,
            client_request_id=request_id,
        )
    return _proxy_public(row)


def update_social_proxy(proxy_id: str, payload: SocialProxyPatchPayload) -> dict[str, Any]:
    clean_proxy_id = str(proxy_id or "").strip()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="代理不存在")

        if payload.connection_mode is not None:
            _normalize_proxy_connection_mode(payload.connection_mode)
        effective_type, effective_host, effective_port = _validate_proxy_endpoint(
            payload.proxy_type if payload.proxy_type is not None else current["proxy_type"],
            payload.host if payload.host is not None else current["host"],
            payload.port if payload.port is not None else current["port"],
        )
        effective_username = str(payload.username).strip() if payload.username is not None else str(current["username"] or "").strip()
        effective_password = str(payload.password) if payload.password is not None else str(current["password"] or "")
        _validate_proxy_credentials(effective_username, effective_password)

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
            if value is not None:
                updates[field] = str(value).strip() if field == "username" else str(value)
        for field in ("note",):
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
                normalizer = _normalize_proxy_source if field == "source" else _normalize_proxy_purchase_status
                updates[field] = normalizer(value or default)
        if payload.ip_type is not None:
            clean_ip_type = str(payload.ip_type or "static_residential").strip().lower()
            if clean_ip_type != "static_residential":
                raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
            updates["ip_type"] = "static_residential"
        if payload.expires_at is not None:
            updates["expires_at"] = int(payload.expires_at)
        connection_fields = {"proxy_type", "host", "port", "username", "password"}
        changed_connection_fields = {
            field
            for field in connection_fields.intersection(updates)
            if updates[field] != current[field]
        }
        execution_fields = connection_fields | {"ip_type", "expires_at"}
        changed_execution_fields = {
            field
            for field in execution_fields.intersection(updates)
            if updates[field] != current[field]
        }
        requested_status_change = (
            payload.status is not None
            and str(payload.status or "").strip().lower() != str(current["status"] or "").strip().lower()
        )
        if changed_execution_fields or requested_status_change:
            active_task = conn.execute(
                """
                SELECT task.id
                FROM social_automation_tasks AS task
                INNER JOIN social_accounts AS account ON account.id = task.account_id
                WHERE account.proxy_id = ?
                  AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
                LIMIT 1
                """,
                (clean_proxy_id,),
            ).fetchone()
            if active_task:
                raise HTTPException(
                    status_code=409,
                    detail="代理正在被自动化任务使用，请停止任务后再修改执行配置",
                )
        if changed_connection_fields:
            updates["country"] = ""
            updates["region"] = ""
            updates["city"] = ""
            updates["isp"] = ""
            updates["last_check_at"] = 0
            updates["last_check_result"] = ""
            updates["status"] = "pending"
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
    owner_user_id: int = 0,
    client_request_id: str = "",
) -> Any:
    proxy_type, clean_host, clean_port = _validate_proxy_endpoint(protocol, host, port)
    clean_username = str(username or "").strip()
    clean_password = str(password or "")
    _validate_proxy_credentials(clean_username, clean_password)
    if str(ip_type or "static_residential").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
    now = _now()
    proxy_id = _NEW_ID("social_proxy")
    conn.execute(
        """
        INSERT INTO social_proxies(
          id, user_id, name, proxy_type, host, port, username, password, country, region, city, isp,
          source, ip_type, purchase_status, note, expires_at, status, client_request_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            proxy_id,
            max(0, int(owner_user_id or 0)),
            str(name or f"{proxy_type}://{clean_host}:{clean_port}").strip(),
            proxy_type,
            clean_host,
            clean_port,
            clean_username,
            clean_password,
            str(country or "").strip(),
            str(region or "").strip(),
            str(city or "").strip(),
            str(isp or "").strip(),
            _normalize_proxy_source(source),
            "static_residential",
            _normalize_proxy_purchase_status(purchase_status),
            str(note or "").strip(),
            max(0, int(expires_at or 0)),
            "pending",
            str(client_request_id or "").strip(),
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
    owner_user_id: int = 0,
) -> Any:
    _normalize_proxy_connection_mode(payload.connection_mode)
    if str(payload.ip_type or "static_residential").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="仅支持静态住宅 IP")
    proxy_type, host, port = _validate_proxy_endpoint(payload.protocol, payload.host, payload.port)
    country = ""
    region = ""
    city = ""
    isp = ""

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
    effective_username = username or (str(current["username"] or "") if current is not None else "")
    effective_password = password or (str(current["password"] or "") if current is not None else "")
    _validate_proxy_credentials(effective_username, effective_password)
    if current is None or shared:
        return _insert_social_proxy(
            conn,
            protocol=proxy_type,
            host=host,
            port=port,
            username=effective_username,
            password=effective_password,
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
            status="pending",
            owner_user_id=owner_user_id,
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
        "source": _normalize_proxy_source(metadata["source"] or "manual"),
        "ip_type": "static_residential",
        "purchase_status": _normalize_proxy_purchase_status(metadata["purchase_status"] or "owned"),
        "note": str(metadata["note"] or "").strip(),
        "expires_at": max(0, int(metadata["expires_at"] or 0)),
        "status": "pending",
        "last_check_at": 0,
        "last_check_result": "",
        "updated_at": _now(),
    }
    if password:
        updates["password"] = password
    assignments = ", ".join(f"{key} = ?" for key in updates)
    conn.execute(f"UPDATE social_proxies SET {assignments} WHERE id = ?", (*updates.values(), clean_proxy_id))
    return conn.execute("SELECT * FROM social_proxies WHERE id = ?", (clean_proxy_id,)).fetchone()


def _last_proxy_exit_ip(proxy: dict[str, Any]) -> str:
    previous = _loads(proxy.get("last_check_result"), {})
    response = previous.get("response") if isinstance(previous, dict) and isinstance(previous.get("response"), dict) else {}
    return str(response.get("ip") or previous.get("exit_ip") or previous.get("ip") or "").strip()


def _run_proxy_connection_check(proxy: dict[str, Any], *, previous_exit_ip: str = "") -> dict[str, Any]:
    proxy_url = _proxy_url(proxy, include_password=True)
    result: dict[str, Any] = {
        "ok": False,
        "checked_at": _now(),
        "proxy": _proxy_url(proxy, include_password=False),
        "connection_mode": "proxy",
    }
    try:
        direct_data = _response_json(
            requests.get("https://api.ipify.org?format=json", timeout=(5, 10)),
            label="服务器直连出口检测",
        )
        direct_ip = _public_ip(direct_data.get("ip"), label="服务器直连出口检测")
        proxy_map = {"http": proxy_url, "https": proxy_url}
        started_at = time.monotonic()
        exit_data = _response_json(
            requests.get("https://api.ipify.org?format=json", proxies=proxy_map, timeout=(5, 12)),
            label="代理出口检测",
        )
        latency_ms = max(0, int(round((time.monotonic() - started_at) * 1000)))
        exit_ip = _public_ip(exit_data.get("ip"), label="代理出口检测")
        result.update(
            {
                "direct_ip": direct_ip,
                "exit_ip": exit_ip,
                "latency_ms": latency_ms,
                "route_verified": direct_ip != exit_ip,
            }
        )
        who = _response_json(
            requests.get(
                f"https://ipwho.is/{quote(exit_ip, safe='')}?fields=success,message,ip,country,country_code,region,city,type,connection",
                timeout=(5, 12),
            ),
            label="代理地理信息检测",
        )
        if who.get("success") is False:
            raise RuntimeError(str(who.get("message") or "代理地理信息检测失败"))
        who_ip = _public_ip(who.get("ip"), label="代理地理信息检测")
        reputation = _response_json(
            requests.get(f"https://api.ipapi.is/?q={quote(exit_ip, safe='')}", timeout=(5, 12)),
            label="住宅网络属性检测",
        )
        reputation_ip = _public_ip(reputation.get("ip"), label="住宅网络属性检测")
        if reputation_ip != exit_ip:
            raise RuntimeError("住宅网络属性检测返回的 IP 与代理出口不一致")

        route_verified = direct_ip != exit_ip
        ip_consistent = who_ip == exit_ip
        previous_ip = ""
        if previous_exit_ip:
            previous_ip = _public_ip(previous_exit_ip, label="上次代理出口记录")
        static_consistent = bool(ip_consistent and (not previous_ip or previous_ip == exit_ip))
        negative_flags = {
            "bogon": bool(reputation.get("is_bogon")),
            "datacenter": bool(reputation.get("is_datacenter")),
            "tor": bool(reputation.get("is_tor")),
            "vpn": bool(reputation.get("is_vpn")),
        }
        company = reputation.get("company") if isinstance(reputation.get("company"), dict) else {}
        company_type = str(company.get("type") or "").strip().lower()
        if any(negative_flags.values()):
            residential_status = "rejected"
            residential_reason = "IP 信誉数据标记为机房、VPN、Tor 或异常地址"
        elif company_type in {"isp", "business", "education"}:
            residential_status = "verified"
            residential_reason = "IP 信誉数据未标记机房/VPN/Tor，网络归属为 ISP"
        else:
            residential_status = "unknown"
            residential_reason = "网络可连接，但公开信誉数据不足以确认住宅属性"
        connection = who.get("connection") if isinstance(who.get("connection"), dict) else {}
        normalized_response = {
            "success": True,
            "ip": exit_ip,
            "country": str(who.get("country") or "").strip(),
            "country_code": str(who.get("country_code") or "").strip(),
            "region": str(who.get("region") or "").strip(),
            "city": str(who.get("city") or "").strip(),
            "type": str(who.get("type") or "").strip(),
            "connection": {
                "asn": connection.get("asn"),
                "org": str(connection.get("org") or "").strip(),
                "isp": str(connection.get("isp") or "").strip(),
                "domain": str(connection.get("domain") or "").strip(),
            },
        }
        result.update(
            {
                "direct_ip": direct_ip,
                "exit_ip": exit_ip,
                "latency_ms": latency_ms,
                "route_verified": route_verified,
                "ip_consistent": ip_consistent,
                "static_consistent": static_consistent,
                "previous_exit_ip": previous_ip,
                "residential_status": residential_status,
                "residential_reason": residential_reason,
                "response": normalized_response,
                "reputation": {
                    **negative_flags,
                    "company_name": str(company.get("name") or "").strip(),
                    "company_type": company_type,
                },
                "ok": bool(route_verified and static_consistent and residential_status == "verified"),
            }
        )
        if not route_verified:
            result["error"] = "代理出口与服务器直连出口相同，未确认流量经过代理"
        elif not static_consistent:
            result["error"] = "本次出口 IP 与重复检测或历史出口不一致，不符合静态 IP 要求"
        elif residential_status != "verified":
            result["error"] = residential_reason
    except Exception as exc:
        result.update({"ok": False, "error_code": type(exc).__name__, "error": _proxy_check_error_message(exc)})
    return _redact_sensitive(
        result,
        secrets=(str(proxy.get("username") or ""), str(proxy.get("password") or "")),
    )


def test_social_proxy(payload: SocialProxyCheckPayload, *, owner_user_id: int = 0) -> dict[str, Any]:
    _normalize_proxy_connection_mode(payload.connection_mode)
    current: dict[str, Any] = {}
    clean_proxy_id = str(payload.proxy_id or "").strip()
    if clean_proxy_id:
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM social_proxies WHERE id = ? AND user_id = ?",
                (clean_proxy_id, max(0, int(owner_user_id or 0))),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="代理不存在")
        current = dict(row)
    proxy_type, host, port = _validate_proxy_endpoint(payload.proxy_type, payload.host, payload.port)
    username = str(payload.username).strip() if payload.username is not None else str(current.get("username") or "").strip()
    password = str(payload.password) if payload.password is not None else str(current.get("password") or "")
    _validate_proxy_credentials(username, password)
    candidate = {
        "proxy_type": proxy_type,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
    }
    return _run_proxy_connection_check(candidate, previous_exit_ip=_last_proxy_exit_ip(current))


def check_social_proxy(proxy_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="代理不存在")
    proxy = dict(row)
    safe_result = _run_proxy_connection_check(proxy, previous_exit_ip=_last_proxy_exit_ip(proxy))
    status = "active" if safe_result.get("ok") else "failed"
    response = safe_result.get("response") if isinstance(safe_result.get("response"), dict) else {}
    connection = response.get("connection") if isinstance(response.get("connection"), dict) else {}
    detected_country = str(response.get("country_code") or response.get("country") or "").strip() if status == "active" else ""
    detected_region = str(response.get("region") or "").strip() if status == "active" else ""
    detected_city = str(response.get("city") or "").strip() if status == "active" else ""
    detected_isp = str(connection.get("isp") or connection.get("org") or "").strip() if status == "active" else ""
    with db() as conn:
        checked_at = _now()
        cursor = conn.execute(
            """
            UPDATE social_proxies
            SET status = ?, country = ?, region = ?, city = ?, isp = ?,
                last_check_at = ?, last_check_result = ?, updated_at = ?
            WHERE id = ? AND proxy_type = ? AND host = ? AND port = ?
              AND username = ? AND password = ?
              AND updated_at = ? AND status = ?
            """,
            (
                status, detected_country, detected_region, detected_city, detected_isp,
                checked_at, json.dumps(safe_result, ensure_ascii=False), checked_at,
                proxy_id, proxy["proxy_type"], proxy["host"], proxy["port"], proxy["username"], proxy["password"],
                proxy["updated_at"], proxy["status"],
            ),
        )
        if not cursor.rowcount:
            raise HTTPException(status_code=409, detail="代理配置已变更，请重新检测")
        updated = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    return _proxy_public(updated)

def create_social_account(
    payload: SocialAccountPayload,
    *,
    owner_user_id: int = 0,
    billing_admin_waived: bool = False,
) -> dict[str, Any]:
    billing_admin_waived = bool(billing_admin_waived or _consume_admin_billing_waiver(payload))
    platform = _normalize_platform(payload.platform)
    username = str(payload.username or "").strip().lstrip("@")
    if not username:
        raise HTTPException(status_code=400, detail="账号 username 必填")
    login_username = str(payload.login_username or "").strip() or username
    login_password = str(payload.login_password or "")
    if login_password and _looks_like_non_password_text(login_password):
        raise HTTPException(status_code=400, detail="登录密码内容看起来像说明文字，请填写真实密码")
    persona_id = str(payload.persona_id or "").strip()
    status = str(payload.status or "pending_login").strip()
    if status not in SOCIAL_ACCOUNT_STATUSES:
        status = "pending_login"
    now = _now()
    if payload.residential_proxy is not None and str(payload.proxy_id or "").strip():
        raise HTTPException(status_code=400, detail="residential_proxy 与 proxy_id 不能同时提交")
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _require_active_owner_user(conn, owner_user_id)
        if int(owner_user_id) > 0:
            commercial_billing.require_write_access(
                conn,
                int(owner_user_id),
                admin_waived=bool(billing_admin_waived),
            )
        if platform == "threads" and int(owner_user_id) > 0 and not billing_admin_waived:
            account_limit = commercial_billing.threads_account_limit(conn, int(owner_user_id), now=now)
            if account_limit is not None:
                current_count = int(
                    conn.execute(
                        "SELECT COUNT(*) AS c FROM social_accounts WHERE user_id = ? AND lower(platform) = 'threads'",
                        (int(owner_user_id),),
                    ).fetchone()["c"]
                )
                if current_count >= int(account_limit):
                    raise commercial_billing.BillingError(
                        "THREADS_ACCOUNT_LIMIT",
                        f"当前订阅最多允许 {int(account_limit)} 个 Threads 账号，请增加订阅后再创建",
                        409,
                    )
        if payload.proxy_id:
            _require_proxy(conn, payload.proxy_id, owner_user_id=owner_user_id)
        if persona_id:
            bound = conn.execute(
                "SELECT id FROM social_accounts WHERE user_id = ? AND persona_id = ? AND platform = ? LIMIT 1",
                (owner_user_id, persona_id, platform),
            ).fetchone()
            if bound:
                raise HTTPException(status_code=409, detail="同一人设在同一平台最多绑定一个账号")
        existing = conn.execute(
            """
            SELECT *
            FROM social_accounts
            WHERE persona_id = ?
              AND user_id = ?
              AND platform = ?
              AND lower(username) = lower(?)
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (persona_id, owner_user_id, platform, username),
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
            proxy_row = _save_account_residential_proxy(
                conn,
                payload.residential_proxy,
                account_id=account_id,
                owner_user_id=owner_user_id,
            )
            proxy_id = str(proxy_row["id"] or "")
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir, proxy_id, status,
              login_username, login_password, login_credentials_updated_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account_id,
                max(0, int(owner_user_id or 0)),
                persona_id,
                platform,
                username,
                str(payload.display_name or "").strip(),
                profile_dir,
                proxy_id,
                status,
                login_username,
                login_password,
                now if login_username or login_password else 0,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
        if proxy_row is None and proxy_id:
            proxy_row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
        totp_row = _social_account_totp_row(conn, account_id)
    return _account_public(row, proxy_row, totp_row)


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
        owner_user_id = int(existing["user_id"] or 0)
        current_proxy_id = str(existing["proxy_id"] or "").strip()
        target_proxy_id = str(updates.get("proxy_id", current_proxy_id) or "").strip()
        proxy_binding_requested = (
            payload.proxy_id is not None
            or bool(payload.clear_residential_proxy)
            or payload.residential_proxy is not None
        )
        if proxy_binding_requested and payload.expected_proxy_id is not None:
            expected_proxy_id = str(payload.expected_proxy_id or "").strip()
            if current_proxy_id != expected_proxy_id:
                raise HTTPException(status_code=409, detail="账号代理绑定已变更，请刷新后重试")
        proxy_binding_changes = target_proxy_id != current_proxy_id or payload.residential_proxy is not None
        if proxy_binding_changes:
            active_proxy_task = conn.execute(
                """
                SELECT id
                FROM social_automation_tasks
                WHERE account_id = ?
                  AND status IN ('preparing', 'queued', 'running', 'need_manual')
                LIMIT 1
                """,
                (account_id,),
            ).fetchone()
            if active_proxy_task:
                raise HTTPException(status_code=409, detail="账号有进行中的自动化任务，请停止任务后再切换代理 IP")
        if target_persona_id:
            if owner_user_id > 0:
                persona_owner = conn.execute(
                    "SELECT 1 FROM persona_owners WHERE archive_id = ? AND user_id = ? LIMIT 1",
                    (target_persona_id, owner_user_id),
                ).fetchone()
                if not persona_owner:
                    raise HTTPException(status_code=404, detail="人设不存在")
            duplicates = conn.execute(
                """
                SELECT id
                FROM social_accounts
                WHERE id != ?
                  AND user_id = ?
                  AND persona_id = ?
                  AND platform = ?
                """,
                (account_id, owner_user_id, target_persona_id, target_platform),
            ).fetchall()
            if duplicates:
                if not payload.replace_existing_binding:
                    raise HTTPException(status_code=409, detail="同一人设在同一平台最多绑定一个账号")
            if target_persona_id != str(existing["persona_id"] or "").strip() or duplicates:
                affected_account_ids = [account_id, *(str(row["id"] or "") for row in duplicates)]
                placeholders = ",".join("?" for _ in affected_account_ids)
                active_task = conn.execute(
                    f"""
                    SELECT id
                    FROM social_automation_tasks
                    WHERE user_id = ?
                      AND account_id IN ({placeholders})
                      AND status IN ('preparing', 'queued', 'running', 'need_manual')
                    LIMIT 1
                    """,
                    (owner_user_id, *affected_account_ids),
                ).fetchone()
                if active_task:
                    raise HTTPException(status_code=409, detail="账号有进行中的自动化任务，请停止任务后再切换绑定")
            if duplicates:
                try:
                    conn.execute(
                        """
                        UPDATE social_accounts
                        SET persona_id = '', updated_at = ?
                        WHERE id != ? AND user_id = ? AND persona_id = ? AND platform = ?
                        """,
                        (_now(), account_id, owner_user_id, target_persona_id, target_platform),
                    )
                except sqlite3.IntegrityError as exc:
                    raise HTTPException(status_code=409, detail="原绑定账号与未绑定账号重复，无法自动切换") from exc
        else:
            duplicate = conn.execute(
                "SELECT id FROM social_accounts WHERE id != ? AND user_id = ? AND persona_id = '' AND platform = ? AND lower(username) = lower(?) LIMIT 1",
                (account_id, owner_user_id, target_platform, target_username),
            ).fetchone()
            if duplicate:
                raise HTTPException(status_code=409, detail="同平台未绑定账号用户名重复")
        if target_proxy_id and proxy_binding_changes and payload.residential_proxy is None:
            proxy = _require_proxy(conn, target_proxy_id, owner_user_id=owner_user_id)
            if _proxy_is_expired(proxy):
                raise HTTPException(status_code=409, detail="静态住宅代理已过期，请续费或更换后再绑定")
            if str(proxy["status"] or "").strip().lower() != "active":
                raise HTTPException(status_code=409, detail="代理不可用，请先启用、修复或重新检测")
            if not _proxy_has_verified_check(proxy):
                raise HTTPException(status_code=409, detail="代理尚未通过真实网络检测，请先检测后再绑定")
        proxy_row = None
        if payload.residential_proxy is not None:
            proxy_row = _save_account_residential_proxy(
                conn,
                payload.residential_proxy,
                current_proxy_id=str(existing["proxy_id"] or ""),
                account_id=account_id,
                owner_user_id=owner_user_id,
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
        totp_row = _social_account_totp_row(conn, account_id)
    return _account_public(row, proxy_row, totp_row)


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
        totp_row = _social_account_totp_row(conn, account_id) if row else None
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    return _account_public(row, None, totp_row)


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


def _release_task_billing_reservation(conn: sqlite3.Connection, task: Any, *, now: int | None = None) -> bool:
    if task is None or "billing_reservation_id" not in task.keys():
        return False
    reservation_id = str(task["billing_reservation_id"] or "").strip()
    if not reservation_id:
        return False
    if conn.execute("SELECT 1 FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone() is None:
        return False
    commercial_billing.release_reservation(conn, reservation_id, now=now)
    return True


def _release_terminal_task_billing_reservations(conn: sqlite3.Connection, now: int) -> None:
    stale_preparing = conn.execute(
        "SELECT * FROM social_automation_tasks WHERE status = 'preparing' AND updated_at < ?",
        (int(now) - 600,),
    ).fetchall()
    conn.execute(
        """
        UPDATE social_automation_tasks
        SET status = 'cancelled', finished_at = ?, error = 'stale batch preparation', updated_at = ?
        WHERE status = 'preparing' AND updated_at < ?
        """,
        (int(now), int(now), int(now) - 600),
    )
    for task in stale_preparing:
        if str(task["task_type"] or "") == "publish_post":
            _ensure_daily_publish_slot(conn, task, now=now)
            _release_daily_publish_slot(conn, str(task["id"] or ""), "stale_batch_preparation", now=now)
    rows = conn.execute(
        """
        SELECT t.billing_reservation_id
        FROM social_automation_tasks t
        JOIN billing_reservations r ON r.id = t.billing_reservation_id
        WHERE (
            t.status IN ('failed', 'cancelled')
            OR (
                t.status = 'need_manual'
                AND t.finished_at != 0
                AND t.task_type IN ('publish_post', 'threads_auto_reply')
            )
          )
          AND r.status = 'held'
        """
    ).fetchall()
    for row in rows:
        _release_task_billing_reservation(conn, row, now=now)


def delete_social_account(account_id: str) -> int:
    clean_id = str(account_id or "").strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="account_id required")
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (clean_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="account not found")
        task_rows = conn.execute("SELECT * FROM social_automation_tasks WHERE account_id = ?", (clean_id,)).fetchall()
        active_task_ids = [
            str(task["id"] or "") for task in task_rows
            if str(task["id"] or "") and str(task["status"] or "") in {"running", "need_manual"}
        ]
        now = _now()
        conn.execute(
            "UPDATE social_accounts SET status = 'disabled', updated_at = ? WHERE id = ?",
            (now, clean_id),
        )
        conn.execute(
            "UPDATE social_automation_tasks SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ? WHERE account_id = ? AND status IN ('preparing', 'queued', 'running', 'need_manual')",
            (now, "account deleted", now, clean_id),
        )
        for task in task_rows:
            if str(task["task_type"] or "") == "publish_post":
                _ensure_daily_publish_slot(conn, task, now=now)
                _release_daily_publish_slot(conn, str(task["id"] or ""), "account_deleted", now=now)
    for task_id in active_task_ids:
        _force_stop_running_task(task_id)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute("SELECT 1 FROM social_accounts WHERE id = ?", (clean_id,)).fetchone():
            return 0
        deletion_task_rows = conn.execute(
            "SELECT id, billing_reservation_id FROM social_automation_tasks WHERE account_id = ?",
            (clean_id,),
        ).fetchall()
        for task in deletion_task_rows:
            _release_task_billing_reservation(conn, task)
            task_id = str(task["id"] or "")
            conn.execute("DELETE FROM social_automation_logs WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM social_automation_tasks WHERE account_id = ?", (clean_id,))
        deleted = conn.execute("DELETE FROM social_accounts WHERE id = ?", (clean_id,)).rowcount
    wake_social_automation_worker()
    return int(deleted or 0)


def _account_dedupe_rank(row: Any) -> tuple[int, int]:
    status_rank = {
        "ready": 5,
        "account_confirmation_required": 4,
        "need_verification": 4,
        "pending_login": 3,
        "cookie_expired": 2,
        "transient_error": 2,
        "disabled": 1,
    }
    return (
        status_rank.get(str(row["status"] or "").strip().lower(), 0),
        int(row["updated_at"] or row["created_at"] or 0),
    )


def dedupe_social_accounts(*, user_id: int | None = None) -> dict[str, Any]:
    deleted_ids: list[str] = []
    kept_ids: list[str] = []
    skipped_ids: list[str] = []
    with db() as conn:
        if user_id is None:
            rows = conn.execute("SELECT * FROM social_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM social_accounts WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC",
                (int(user_id),),
            ).fetchall()
        groups: dict[tuple[int, str, str], list[Any]] = {}
        for row in rows:
            username = str(row["username"] or "").strip().lower()
            platform = str(row["platform"] or "").strip().lower()
            if not username or not platform:
                continue
            groups.setdefault((int(row["user_id"] or 0), platform, username), []).append(row)
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


def create_account_task(
    account_id: str,
    task_type: str,
    payload: dict[str, Any],
    *,
    billing_admin_waived: bool = False,
) -> dict[str, Any]:
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
        ),
        billing_admin_waived=bool(billing_admin_waived),
    )


def create_social_task(payload: SocialTaskPayload, *, billing_admin_waived: bool = False) -> dict[str, Any]:
    billing_admin_waived = bool(billing_admin_waived or _consume_admin_billing_waiver(payload))
    batch_context = _consume_trusted_batch_task(payload)
    platform = _normalize_platform(payload.platform)
    task_type = str(payload.task_type or "").strip()
    if task_type not in SOCIAL_TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"不支持的自动化任务类型: {task_type}")
    task_payload = dict(payload.payload or {})
    if task_type == "open_login":
        _validate_open_login_payload(task_payload)
        task_payload["wait_for_manual"] = True
    auto_submit = _validate_open_login_payload(task_payload) if task_type == "open_login" else False
    now = _now()
    scheduled_at = _parse_schedule(payload.scheduled_at)
    task_id = str(batch_context.get("task_id") or _NEW_ID("social_task"))
    superseded_login_task_ids: list[str] = []
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        account = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (payload.account_id,)).fetchone()
        if not account:
            raise HTTPException(status_code=404, detail="账号不存在")
        if str(account["status"] or "") == "disabled":
            raise HTTPException(status_code=409, detail="账号已停用，不能创建任务")
        if (
            str(account["health_status"] or "").strip().lower() == "banned"
            and task_type not in {"check_login", "open_login"}
        ):
            raise HTTPException(status_code=409, detail="平台账号已被封禁，只能重新检测或打开登录处理。")
        if str(account["platform"] or "").strip().lower() != platform:
            raise HTTPException(status_code=400, detail="任务平台与执行账号平台不一致")
        proxy_id = str(account["proxy_id"] or "").strip()
        if proxy_id:
            proxy = conn.execute(
                "SELECT status, ip_type, expires_at, last_check_at, last_check_result FROM social_proxies WHERE id = ? AND user_id = ?",
                (proxy_id, int(account["user_id"] or 0)),
            ).fetchone()
            if not proxy:
                raise HTTPException(status_code=409, detail="账号绑定的住宅代理不存在，不能创建任务")
            proxy_status = str(proxy["status"] or "").strip().lower()
            if str(proxy["ip_type"] or "").strip().lower() != "static_residential":
                raise HTTPException(status_code=409, detail="账号仅允许使用静态住宅 IP")
            if _proxy_is_expired(proxy):
                raise HTTPException(status_code=409, detail="账号绑定的静态住宅代理已过期，请续费或更换后再执行任务")
            if proxy_status != "active":
                raise HTTPException(status_code=409, detail="账号绑定的代理不可用，请先启用、修复或重新检测")
            if not _proxy_has_verified_check(proxy):
                raise HTTPException(status_code=409, detail="账号绑定的代理尚未通过真实网络检测，请先检测")
        owner_user_id = int(account["user_id"] or 0)
        _require_active_owner_user(conn, owner_user_id)
        account_persona_id = str(account["persona_id"] or "").strip()
        requested_persona_id = str(payload.persona_id or "").strip()
        if requested_persona_id and requested_persona_id != account_persona_id:
            raise HTTPException(status_code=400, detail="任务人设必须与执行账号绑定的人设一致")
        persona_id = account_persona_id
        if persona_id:
            owner = conn.execute(
                "SELECT 1 FROM persona_owners WHERE archive_id = ? AND user_id = ?",
                (persona_id, owner_user_id),
            ).fetchone()
            if not owner:
                raise HTTPException(status_code=409, detail="执行账号绑定的人设不属于当前账号")
        if platform == "threads" and task_type == "publish_post":
            archive_post_id = str(task_payload.get("archive_post_id") or "").strip()
            archive_post_source = str(task_payload.get("archive_post_source") or "").strip()
            if archive_post_id:
                active_rows = conn.execute(
                    """
                    SELECT * FROM social_automation_tasks
                    WHERE user_id = ? AND account_id = ? AND platform = 'threads'
                      AND task_type = 'publish_post'
                      AND status IN ('preparing', 'queued', 'running', 'need_manual')
                    ORDER BY created_at DESC
                    """,
                    (owner_user_id, str(payload.account_id)),
                ).fetchall()
                for active_row in active_rows:
                    active_payload = _loads(active_row["payload_json"], {})
                    if (
                        str(active_payload.get("archive_post_id") or "").strip() == archive_post_id
                        and str(active_payload.get("archive_post_source") or "").strip() == archive_post_source
                    ):
                        if batch_context.get("task_id"):
                            raise HTTPException(status_code=409, detail="已有相同推文的发布任务")
                        reused_statuses = _billing_reservation_statuses(conn, [active_row])
                        reused = _task_public(
                            active_row,
                            billing_reservation_status=reused_statuses.get(str(active_row["billing_reservation_id"] or ""), ""),
                        )
                        reused["reused"] = True
                        return reused
        daily_publish_waived = bool(billing_admin_waived or _owner_is_admin(conn, owner_user_id))
        if task_type == "publish_post" and not daily_publish_waived:
            publish_policy = _daily_publish_policy_in_transaction(
                conn,
                owner_user_id,
                scheduled_at=scheduled_at,
                requested_count=1,
            )
            if not publish_policy["can_publish"]:
                raise HTTPException(status_code=429, detail=publish_policy["message"] or DAILY_PUBLISH_LIMIT_MESSAGE)
        billing_reservation: dict[str, Any] | None = None
        billing_sku = ""
        if platform == "threads" and task_type == "publish_post":
            billing_sku = "threads_text_publish"
        elif platform == "threads" and task_type == "threads_auto_reply":
            billing_sku = "threads_auto_reply_batch"
        if billing_sku and owner_user_id > 0:
            pre_reserved_id = str(batch_context.get("reservation_id") or "")
            if pre_reserved_id:
                billing_reservation = commercial_billing.claim_reservation(
                    conn,
                    reservation_id=pre_reserved_id,
                    user_id=owner_user_id,
                    ref_type="social_task",
                    ref_id=task_id,
                    sku=billing_sku,
                )
            else:
                billing_reservation = commercial_billing.reserve_charge(
                    conn,
                    user_id=owner_user_id,
                    ref_type="social_task",
                    ref_id=task_id,
                    sku=billing_sku,
                    quantity=1,
                    admin_waived=bool(billing_admin_waived),
                )
        elif owner_user_id > 0:
            commercial_billing.require_write_access(
                conn,
                owner_user_id,
                admin_waived=bool(billing_admin_waived),
            )
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
        if task_type == "open_login":
            active_login_rows = conn.execute(
                """
                SELECT id, billing_reservation_id
                FROM social_automation_tasks
                WHERE account_id = ?
                  AND task_type = 'open_login'
                  AND status IN ('preparing', 'queued', 'running', 'need_manual')
                ORDER BY created_at ASC
                """,
                (str(payload.account_id),),
            ).fetchall()
            for active_login_row in active_login_rows:
                active_task_id = str(active_login_row["id"] or "")
                if not active_task_id:
                    continue
                cancelled = conn.execute(
                    """
                    UPDATE social_automation_tasks
                    SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ?
                    WHERE id = ? AND status IN ('preparing', 'queued', 'running', 'need_manual')
                    """,
                    (now, "新的自动登录任务已替换旧登录会话", now, active_task_id),
                ).rowcount
                if not cancelled:
                    continue
                _release_task_billing_reservation(conn, active_login_row, now=now)
                _insert_log(
                    conn,
                    active_task_id,
                    "warn",
                    "login_superseded",
                    "用户重新打开登录，旧登录会话已停止。",
                    {"replacement_task_id": task_id},
                )
                superseded_login_task_ids.append(active_task_id)
        initial_status = "preparing" if bool(batch_context.get("suppress_wake")) else "queued"
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, user_id, persona_id, account_id, platform, task_type, priority, status, scheduled_at,
              payload_json, result_json, max_retries, billing_reservation_id, daily_publish_waived, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                owner_user_id,
                persona_id,
                payload.account_id,
                platform,
                task_type,
                int(payload.priority or 50),
                initial_status,
                scheduled_at,
                json.dumps(task_payload, ensure_ascii=False),
                0 if task_type == "open_login" else max(0, min(int(payload.max_retries or 0), 5)),
                str((billing_reservation or {}).get("id") or ""),
                1 if daily_publish_waived else 0,
                now,
                now,
            ),
        )
        _insert_log(conn, task_id, "info", "queued", "任务已加入自动化队列", {"task_type": task_type})
        if task_type == "publish_post":
            quota_day = _daily_publish_day(scheduled_at or now)
            conn.execute(
                """
                INSERT INTO social_daily_publish_slots(
                  task_id, user_id, quota_day, state, waived, submitted_at,
                  released_at, release_reason, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, 0, '', ?, ?)
                """,
                (
                    task_id,
                    owner_user_id,
                    quota_day,
                    "waived" if daily_publish_waived else "planned",
                    1 if daily_publish_waived else 0,
                    now,
                    now,
                ),
            )
        if runtime_secrets:
            with _EPHEMERAL_TASK_SECRETS_LOCK:
                _EPHEMERAL_TASK_SECRETS[task_id] = runtime_secrets
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        row_billing_statuses = _billing_reservation_statuses(conn, [row])
    if superseded_login_task_ids:
        _discard_ephemeral_task_secrets(*superseded_login_task_ids)
        for superseded_task_id in superseded_login_task_ids:
            _force_stop_running_task(superseded_task_id)
    if not bool(batch_context.get("suppress_wake")):
        wake_social_automation_worker()
    return _task_public(
        row,
        billing_reservation_status=row_billing_statuses.get(str(row["billing_reservation_id"] or ""), ""),
    )


def get_social_task(task_id: str) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        billing_statuses = _billing_reservation_statuses(conn, [row] if row else [])
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _task_public(
        row,
        billing_reservation_status=billing_statuses.get(str(row["billing_reservation_id"] or ""), ""),
    )


def list_social_tasks(*, status: str = "", account_id: str = "", limit: int = 60, user_id: int | None = None) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if account_id:
        clauses.append("account_id = ?")
        params.append(account_id)
    if user_id is not None:
        clauses.append("user_id = ?")
        params.append(int(user_id))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    limit = max(1, min(int(limit or 60), 200))
    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM social_automation_tasks {where} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        billing_statuses = _billing_reservation_statuses(conn, list(rows))
    return [
        _task_public(row, billing_reservation_status=billing_statuses.get(str(row["billing_reservation_id"] or ""), ""))
        for row in rows
    ]


def clear_social_task(task_id: str) -> int:
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="任务不存在")
        status = str(row["status"] or "")
        now = _now()
        conn.execute(
            "UPDATE social_automation_tasks SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('preparing', 'queued', 'running', 'need_manual')",
            (now, "task cleared", now, task_id),
        )
        if str(row["task_type"] or "") == "publish_post":
            _ensure_daily_publish_slot(conn, row, now=now)
            _release_daily_publish_slot(conn, task_id, "task_cleared", now=now)
    if status in {"running", "need_manual"}:
        _force_stop_running_task(task_id)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not current:
            return 0
        _release_task_billing_reservation(conn, current)
        conn.execute("DELETE FROM social_automation_logs WHERE task_id = ?", (task_id,))
        deleted = conn.execute("DELETE FROM social_automation_tasks WHERE id = ?", (task_id,)).rowcount
    wake_social_automation_worker()
    return int(deleted or 0)


def clear_social_tasks(*, persona_id: str = "", account_id: str = "", user_id: int | None = None) -> int:
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
    if user_id is not None:
        clauses.append("user_id = ?")
        params.append(int(user_id))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(f"SELECT * FROM social_automation_tasks {where}", tuple(params)).fetchall()
        task_ids = [str(row["id"] or "") for row in rows if str(row["id"] or "")]
        if task_ids:
            placeholders = ",".join("?" for _ in task_ids)
            now = _now()
            conn.execute(
                f"UPDATE social_automation_tasks SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ? WHERE id IN ({placeholders}) AND status IN ('preparing', 'queued', 'running', 'need_manual')",
                (now, "tasks cleared", now, *task_ids),
            )
            for row in rows:
                if str(row["task_type"] or "") == "publish_post":
                    _ensure_daily_publish_slot(conn, row, now=now)
                    _release_daily_publish_slot(conn, str(row["id"] or ""), "tasks_cleared", now=now)
    for row in rows:
        task_id = str(row["id"] or "")
        if str(row["status"] or "") in {"running", "need_manual"}:
            _force_stop_running_task(task_id)
    cleared = 0
    if task_ids:
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            placeholders = ",".join("?" for _ in task_ids)
            current_rows = conn.execute(f"SELECT * FROM social_automation_tasks WHERE id IN ({placeholders})", tuple(task_ids)).fetchall()
            for current in current_rows:
                _release_task_billing_reservation(conn, current)
            conn.execute(f"DELETE FROM social_automation_logs WHERE task_id IN ({placeholders})", tuple(task_ids))
            cleared = int(conn.execute(f"DELETE FROM social_automation_tasks WHERE id IN ({placeholders})", tuple(task_ids)).rowcount or 0)
    wake_social_automation_worker()
    return cleared


def cancel_social_task(task_id: str, reason: str = "") -> dict[str, Any]:
    now = _now()
    clean_reason = reason or "用户取消"
    with db() as conn:
        original = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
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
        if cancelled and original is not None and str(original["task_type"] or "") == "publish_post":
            _ensure_daily_publish_slot(conn, original, now=now)
            _release_daily_publish_slot(conn, task_id, clean_reason, now=now)
        if cancelled or str(row["status"] or "") in {"failed", "cancelled"}:
            _release_task_billing_reservation(conn, row, now=now)
        if cancelled:
            _insert_log(conn, task_id, "warn", "cancel", "任务已取消，正在停止执行上下文", {"reason": clean_reason})
        billing_statuses = _billing_reservation_statuses(conn, [row])
    _discard_ephemeral_task_secrets(task_id)
    if cancelled:
        _force_stop_running_task(task_id)
        wake_social_automation_worker()
    return _task_public(
        row,
        billing_reservation_status=billing_statuses.get(str(row["billing_reservation_id"] or ""), ""),
    )


def cancel_all_social_tasks(
    reason: str = "",
    *,
    user_id: int | None = None,
    account_ids: list[str] | None = None,
) -> dict[str, Any]:
    now = _now()
    clean_reason = reason or "用户停止全部自动化任务"
    clean_account_ids = list(
        dict.fromkeys(
            str(account_id or "").strip()
            for account_id in (account_ids or [])
            if str(account_id or "").strip()
        )
    )
    scope_clauses: list[str] = []
    scope_params: list[Any] = []
    if user_id is not None:
        scope_clauses.append("user_id = ?")
        scope_params.append(int(user_id))
    if clean_account_ids:
        account_placeholders = ", ".join("?" for _ in clean_account_ids)
        scope_clauses.append(f"account_id IN ({account_placeholders})")
        scope_params.extend(clean_account_ids)
    scope_clause = f" AND ({' OR '.join(scope_clauses)})" if scope_clauses else ""
    with db() as conn:
        cancelled_rows = conn.execute(
            f"""
            UPDATE social_automation_tasks
            SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ?
            WHERE status IN ('queued', 'running', 'need_manual'){scope_clause}
            RETURNING id
            """,
            (now, clean_reason, now, *scope_params),
        ).fetchall()
        task_ids = [str(row["id"] or "") for row in cancelled_rows if str(row["id"] or "")]
        if not task_ids:
            return {"cancelled_count": 0, "task_ids": [], "tasks": []}
        placeholders = ", ".join("?" for _ in task_ids)
        reservation_rows = conn.execute(
            f"SELECT id, billing_reservation_id FROM social_automation_tasks WHERE id IN ({placeholders})",
            tuple(task_ids),
        ).fetchall()
        for reservation_row in reservation_rows:
            _release_task_billing_reservation(conn, reservation_row, now=now)
        for task_id in task_ids:
            _insert_log(conn, task_id, "warn", "cancel_all", "已通过总控停止任务", {"reason": clean_reason})
        updated_rows = conn.execute(
            f"SELECT * FROM social_automation_tasks WHERE id IN ({placeholders})",
            tuple(task_ids),
        ).fetchall()
        for updated_row in updated_rows:
            if str(updated_row["task_type"] or "") == "publish_post":
                _ensure_daily_publish_slot(conn, updated_row, now=now)
                _release_daily_publish_slot(conn, str(updated_row["id"] or ""), clean_reason, now=now)
        billing_statuses = _billing_reservation_statuses(conn, list(updated_rows))

    _discard_ephemeral_task_secrets(*task_ids)
    # Mark every task cancelled before signalling browsers so queued work cannot be claimed mid-stop.
    for task_id in task_ids:
        _force_stop_running_task(task_id)
    wake_social_automation_worker()
    return {
        "cancelled_count": len(task_ids),
        "task_ids": task_ids,
        "tasks": [
            _task_public(
                row,
                billing_reservation_status=billing_statuses.get(str(row["billing_reservation_id"] or ""), ""),
            )
            for row in updated_rows
        ],
    }


def retry_social_task(task_id: str, *, billing_admin_waived: bool = False) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    if str(row["task_type"] or "") == "open_login":
        raise HTTPException(status_code=409, detail="登录任务不能重试，请重新点击打开登录")
    if str(row["status"] or "") != "failed":
        raise HTTPException(status_code=409, detail="仅失败任务可以重试")
    previous_result = _loads(row["result_json"], {})
    if isinstance(previous_result, dict) and previous_result.get("retryable") is False:
        raise HTTPException(status_code=409, detail="该任务的发布结果无法安全确认，为避免重复发布，禁止自动重试。")
    payload = SocialTaskPayload(
            persona_id=str(row["persona_id"] or ""),
            account_id=str(row["account_id"] or ""),
            platform=str(row["platform"] or "instagram"),
            task_type=str(row["task_type"] or ""),
            priority=int(row["priority"] or 50),
            payload=_loads(row["payload_json"], {}),
            max_retries=int(row["max_retries"] or 0),
    )
    if billing_admin_waived:
        mark_admin_billing_waived_payload(payload)
    return create_social_task(payload)


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
        value = int(get_live_browser_settings().get("max_concurrency", 2))
    except Exception:
        value = _bounded_env_int("SOCIAL_AUTOMATION_WORKER_CONCURRENCY", 2, 1, 12)
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
    login_row = conn.execute(
        "SELECT task_type, status, result_json, error FROM social_automation_tasks WHERE id = ?",
        (login_task_id,),
    ).fetchone()
    if not login_row:
        return False
    login_status = str(login_row["status"] or "").strip()
    if login_status == "success":
        login_result = _loads(login_row["result_json"], {})
        diagnostic_outcome = str(login_result.get("diagnostic_outcome") or "").strip().lower()
        detected_status = str(login_result.get("status") or "").strip().lower()
        if diagnostic_outcome == "ready" or detected_status == "ready":
            return False
        login_status = diagnostic_outcome or detected_status or "not_ready"
    if login_status in {"failed", "cancelled", "not_ready", "banned", "cookie_expired", "need_verification"}:
        task_id = str(row["id"] or "")
        message = str(login_row["error"] or "发布前账号状态未达到正常可用，发布任务已停止。")
        conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'failed', finished_at = ?, error = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'
            """,
            (now, message, now, task_id),
        )
        if str(row["task_type"] or "") == "publish_post":
            _ensure_daily_publish_slot(conn, row, now=now)
            _release_daily_publish_slot(conn, task_id, "login_dependency_failed", now=now)
        _release_task_billing_reservation(conn, row, now=now)
        _insert_log(conn, task_id, "error", "login_dependency_failed", message, {"login_task_id": login_task_id, "login_status": login_status})
    return True


def _claim_next_task() -> dict[str, Any] | None:
    now = _now()
    _recover_orphaned_publish_confirmation_tasks(now)
    _recover_orphaned_manual_task(now)
    global_concurrency = _social_worker_max_concurrency()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _release_terminal_task_billing_reservations(conn, now)
        with _RUNNING_TASK_CONTROLS_LOCK:
            active_account_ids = {
                str((control.get("task") or {}).get("account_id") or "")
                for control in _RUNNING_TASK_CONTROLS.values()
                if isinstance(control.get("task"), dict)
            }
        running_by_user = {
            int(item["user_id"] or 0): int(item["running_count"] or 0)
            for item in conn.execute(
                """
                SELECT user_id, COUNT(*) AS running_count
                FROM social_automation_tasks
                WHERE status IN ('running', 'need_manual')
                GROUP BY user_id
                """
            ).fetchall()
        }
        requested_by_user = {
            int(item["user_id"] or 0): max(1, min(int(item["requested_concurrency"] or 1), global_concurrency))
            for item in conn.execute(
                "SELECT user_id, requested_concurrency FROM user_browser_settings"
            ).fetchall()
        }
        row = None
        publish_day = _daily_publish_day(now)
        admin_by_user: dict[int, bool] = {}
        publish_count_by_user: dict[int, int] = {}
        cursor: tuple[int, int, str] | None = None
        while row is None:
            cursor_clause = ""
            query_params: list[Any] = [now]
            if cursor is not None:
                cursor_clause = """
                  AND (
                    t.priority > ?
                    OR (t.priority = ? AND t.created_at > ?)
                    OR (t.priority = ? AND t.created_at = ? AND t.id > ?)
                  )
                """
                query_params.extend([cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2]])
            rows = conn.execute(
                f"""
                SELECT t.*
                FROM social_automation_tasks t
                WHERE t.status = 'queued'
                  AND (t.scheduled_at = 0 OR t.scheduled_at <= ?)
                  AND NOT EXISTS (
                    SELECT 1
                    FROM social_automation_tasks r
                    WHERE r.account_id = t.account_id
                      AND r.status IN ('running', 'need_manual')
                  )
                  {cursor_clause}
                ORDER BY t.priority ASC, t.created_at ASC, t.id ASC
                LIMIT 50
                """,
                tuple(query_params),
            ).fetchall()
            if not rows:
                break
            for candidate in rows:
                if str(candidate["account_id"] or "") in active_account_ids:
                    continue
                candidate_user_id = int(candidate["user_id"] or 0)
                user_limit = requested_by_user.get(candidate_user_id, max(1, min(2, global_concurrency)))
                if running_by_user.get(candidate_user_id, 0) >= user_limit:
                    continue
                slot = None
                if str(candidate["task_type"] or "") == "publish_post":
                    slot = _ensure_daily_publish_slot(conn, candidate, now=now)
                    slot_state = str(slot["state"] or "") if slot is not None else ""
                    slot_waived = bool(slot is not None and int(slot["waived"] or 0))
                    confirmation_only = slot_state in {"armed", "submitted", "confirmed", "unknown"}
                    if not slot_waived and not confirmation_only:
                        if candidate_user_id not in admin_by_user:
                            admin_by_user[candidate_user_id] = _owner_is_admin(conn, candidate_user_id)
                        if not admin_by_user[candidate_user_id]:
                            if candidate_user_id not in publish_count_by_user:
                                publish_count_by_user[candidate_user_id] = _daily_publish_execution_count(
                                    conn,
                                    candidate_user_id,
                                    publish_day,
                                )
                            if publish_count_by_user[candidate_user_id] >= DAILY_PUBLISH_LIMIT:
                                continue
                if _publish_login_dependency_blocks_claim(conn, candidate, now):
                    continue
                if slot is not None and not bool(int(slot["waived"] or 0)):
                    slot_state = str(slot["state"] or "")
                    if slot_state not in {"armed", "submitted", "confirmed", "unknown"}:
                        _set_daily_publish_slot_state(conn, str(candidate["id"] or ""), "reserved", now=now, quota_day=publish_day)
                row = candidate
                break
            last = rows[-1]
            cursor = (int(last["priority"] or 0), int(last["created_at"] or 0), str(last["id"] or ""))
        if not row:
            return None
        task_id = str(row["id"])
        claimed = conn.execute(
            "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
            (now, now, task_id),
        ).rowcount
        if not claimed:
            return None
        _insert_log(conn, task_id, "info", "running", "后台执行器已领取任务", {})
        updated = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        billing_statuses = _billing_reservation_statuses(conn, [updated])
    public = _task_public(
        updated,
        billing_reservation_status=billing_statuses.get(str(updated["billing_reservation_id"] or ""), ""),
    )
    public["payload"] = _loads(updated["payload_json"], {})
    return public


def _recover_orphaned_publish_confirmation_tasks(now: int) -> None:
    with _RUNNING_TASK_CONTROLS_LOCK:
        running_ids = set(_RUNNING_TASK_CONTROLS.keys())
    try:
        recovery_seconds = int(os.getenv("SOCIAL_AUTOMATION_CONFIRMATION_RECOVERY_SECONDS", "600") or 600)
    except (TypeError, ValueError):
        recovery_seconds = 600
    stale_cutoff = now - max(60, min(recovery_seconds, 3600))
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        stale_rows = conn.execute(
            "SELECT * FROM social_automation_tasks WHERE status = 'running' AND task_type = 'publish_post' AND updated_at < ? ORDER BY updated_at ASC LIMIT 50",
            (stale_cutoff,),
        ).fetchall()
        for row in stale_rows:
            task_id = str(row["id"] or "")
            if not task_id or task_id in running_ids:
                continue
            payload = _loads(row["payload_json"], {})
            confirmation = payload.get("_publish_confirmation") if isinstance(payload, dict) else None
            if not isinstance(confirmation, dict) or confirmation.get("phase") != "confirm_only":
                continue
            recovered = conn.execute(
                "UPDATE social_automation_tasks SET status = 'queued', scheduled_at = ?, started_at = 0, finished_at = 0, error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
                (now, "confirmation worker restarted; confirmation-only check requeued", now, task_id),
            ).rowcount
            if recovered:
                _insert_log(
                    conn,
                    task_id,
                    "warn",
                    "threads_publish_confirmation_recovered",
                    "确认进程中断，已恢复为仅检查发布结果的任务，不会重复发布。",
                    {},
                )


def _recover_orphaned_manual_task(now: int) -> None:
    with _RUNNING_TASK_CONTROLS_LOCK:
        running_ids = set(_RUNNING_TASK_CONTROLS.keys())
    recovery_window = max(60, int(os.getenv("SOCIAL_AUTOMATION_MANUAL_RECOVERY_SECONDS", "7200")))
    recent_cutoff = now - recovery_window
    with db() as conn:
        stale_rows = conn.execute(
            """
            SELECT *
            FROM social_automation_tasks
            WHERE status = 'need_manual'
              AND updated_at < ?
            ORDER BY updated_at ASC
            LIMIT 50
            """,
            (recent_cutoff,),
        ).fetchall()
        for row in stale_rows:
            task_id = str(row["id"] or "")
            if not task_id or task_id in running_ids:
                continue
            task_type = str(row["task_type"] or "")
            message = (
                "登录任务的执行进程已断开且超过恢复时限，请重新打开登录。"
                if task_type == "open_login"
                else "等待人工处理的任务执行进程已断开且超过恢复时限，请重新提交任务。"
            )
            failed = conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'failed', finished_at = ?, error = ?, updated_at = ?
                WHERE id = ? AND status = 'need_manual'
                """,
                (now, message, now, task_id),
            ).rowcount
            if failed:
                if task_type == "publish_post":
                    _ensure_daily_publish_slot(conn, row, now=now)
                    _release_daily_publish_slot(conn, task_id, "manual_recovery_expired", now=now)
                _release_task_billing_reservation(conn, row, now=now)
                _insert_log(conn, task_id, "error", "manual_recovery_expired", message, {"task_type": task_type})


def _execute_claimed_task(task: dict[str, Any]) -> None:
    task_id = str(task.get("id") or "")
    task = dict(task)
    control = {
        "cancel_event": threading.Event(),
        "manual_takeover_event": threading.Event(),
        "manual_takeover_ack_event": threading.Event(),
        "manual_takeover_timeout_event": threading.Event(),
        "context": None,
        "manager": None,
        "task": dict(task),
        "live_browser_session_id": "",
    }
    control["account_login_status_callback"] = lambda status: _persist_running_account_login_status(
        task_id,
        str(task.get("account_id") or ""),
        status,
    )
    control["publish_confirmation_callback"] = lambda confirmation: _persist_publish_confirmation_context(
        task_id,
        confirmation,
    )
    control["manual_takeover_callback"] = lambda: _persist_manual_takeover_ack(
        task_id,
        str(control.get("live_browser_session_id") or ""),
    )
    control["manual_takeover_resolved_callback"] = lambda: _persist_manual_takeover_resolved(
        task_id,
        str(control.get("live_browser_session_id") or ""),
    )
    with _RUNNING_TASK_CONTROLS_LOCK:
        _RUNNING_TASK_CONTROLS[task_id] = control
    try:
        _execute_claimed_task_with_control(task, control)
    finally:
        _discard_ephemeral_task_secrets(task_id)
        with _RUNNING_TASK_CONTROLS_LOCK:
            _RUNNING_TASK_CONTROLS.pop(task_id, None)


def _requeue_publish_confirmation(task_id: str, exc: BaseException) -> bool:
    now = _now()
    try:
        configured_max = int(os.getenv("SOCIAL_AUTOMATION_THREADS_CONFIRM_ATTEMPTS", "3") or 3)
    except (TypeError, ValueError):
        configured_max = 3
    max_attempts = max(1, min(configured_max, 6))
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None or str(row["status"] or "") != "running":
            return False
        payload = _loads(row["payload_json"], {})
        if not isinstance(payload, dict):
            payload = {}
        previous = payload.get("_publish_confirmation")
        previous = previous if isinstance(previous, dict) else {}
        supplied = getattr(exc, "confirmation", {})
        supplied = supplied if isinstance(supplied, dict) else {}
        confirmation = {**previous, **supplied}
        try:
            attempt = int(previous.get("attempt") or 0) + 1
        except (TypeError, ValueError):
            attempt = 1
        confirmation.update({"phase": "confirm_only", "attempt": attempt, "max_attempts": max_attempts})
        if attempt >= max_attempts:
            payload["_publish_confirmation"] = confirmation
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET payload_json = ?, daily_publish_committed = 1,
                    daily_publish_committed_at = CASE WHEN daily_publish_committed_at > 0 THEN daily_publish_committed_at ELSE ? END,
                    updated_at = ?
                WHERE id = ? AND status = 'running'
                """,
                (json.dumps(payload, ensure_ascii=False), now, now, task_id),
            )
            with contextlib.suppress(Exception):
                setattr(exc, "confirmation", confirmation)
            return False
        delay_seconds = min(300, 30 * (3 ** max(0, attempt - 1)))
        payload["_publish_confirmation"] = confirmation
        pending_result = {
            "publish_submitted": True,
            "confirmation_pending": True,
            "retryable": False,
            "confirmation_attempt": attempt,
            "confirmation_max_attempts": max_attempts,
            "next_confirmation_at": now + delay_seconds,
            "screenshot_path": str(getattr(exc, "screenshot_path", "") or ""),
        }
        updated = conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = 'queued', scheduled_at = ?, started_at = 0, finished_at = 0,
                payload_json = ?, result_json = ?, error = ?, daily_publish_committed = 1,
                daily_publish_committed_at = CASE WHEN daily_publish_committed_at > 0 THEN daily_publish_committed_at ELSE ? END,
                updated_at = ?
            WHERE id = ? AND status = 'running'
            """,
            (
                now + delay_seconds,
                json.dumps(payload, ensure_ascii=False),
                json.dumps(pending_result, ensure_ascii=False),
                str(exc),
                now,
                now,
                task_id,
            ),
        ).rowcount
        if updated:
            _set_daily_publish_slot_state(conn, task_id, "submitted", now=now)
            conn.execute(
                "UPDATE social_accounts SET status = 'ready', last_login_check_at = ?, last_run_at = ?, last_error = '', updated_at = ? WHERE id = ?",
                (now, now, now, str(row["account_id"] or "")),
            )
            _insert_log(
                conn,
                task_id,
                "warn",
                "threads_publish_confirmation_retry",
                "发布已提交，稍后仅重新检查发布结果，不会重复点击发布。",
                {"attempt": attempt, "max_attempts": max_attempts, "delay_seconds": delay_seconds},
            )
    if updated:
        wake_social_automation_worker()
    return bool(updated)


def _execute_claimed_task_with_control(task: dict[str, Any], control: dict[str, Any]) -> None:
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
    if proxy is not None and _proxy_is_expired(proxy):
        raise RuntimeError("账号绑定的静态住宅代理已过期，已阻止浏览器启动")
    if proxy is not None and str(proxy.get("status") or "").strip().lower() != "active":
        raise RuntimeError("账号代理不可用，已阻止浏览器启动")
    if proxy is not None and not _proxy_has_verified_check(proxy):
        raise RuntimeError("账号代理尚未通过真实网络检测，已阻止浏览器启动")
    if _is_task_cancelled(task_id):
        _discard_ephemeral_task_secrets(task_id)
        return
    account_id = str(account.get("id") or task.get("account_id") or "")
    owner_user_id = int(account.get("user_id") or task.get("user_id") or 0)
    control["totp_code_provider"] = lambda: _reserve_social_account_totp_code(
        account_id,
        owner_user_id,
    )
    control["totp_outcome_callback"] = lambda outcome: _record_social_account_totp_outcome(
        account_id,
        owner_user_id,
        str(outcome or ""),
    )
    task = _apply_runtime_task_preferences(task, account, control)
    from social_automation.runner import AutoLoginFailedError, NeedManualError, PublishConfirmationPendingError, UnsupportedActionError, run_social_task

    logger = _DbTaskLogger(task["id"])
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
            detected_status = str(getattr(exc, "status", "") or "need_verification")
            manual_result = {"screenshot_path": str(getattr(exc, "screenshot_path", "") or "")}
            if detected_status == "publish_submitted_unconfirmed":
                manual_result.update({
                    "publish_submitted": True,
                    "publish_outcome_unknown": True,
                    "retryable": False,
                })
            _finish_task(
                task["id"],
                "need_manual",
                manual_result,
                str(exc),
                account_status="ready" if detected_status == "publish_submitted_unconfirmed" else detected_status,
            )
        return
    except AutoLoginFailedError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "failed", {"auto_login_failed": True, "screenshot_path": str(getattr(exc, "screenshot_path", "") or "")}, str(exc), account_status=str(getattr(exc, "status", "") or "cookie_expired"))
        return
    except PublishConfirmationPendingError as exc:
        if not _is_task_cancelled(str(task["id"])):
            if _requeue_publish_confirmation(str(task["id"]), exc):
                return
            _finish_task(
                task["id"],
                "failed",
                {
                    "publish_submitted": True,
                    "confirmation_failed": True,
                    "confirmation_exhausted": True,
                    "publish_outcome_unknown": True,
                    "retryable": False,
                    "confirmation_attempt": int((getattr(exc, "confirmation", {}) or {}).get("attempt") or 0),
                    "confirmation_max_attempts": int((getattr(exc, "confirmation", {}) or {}).get("max_attempts") or 0),
                    "screenshot_path": str(getattr(exc, "screenshot_path", "") or ""),
                },
                str(exc),
                account_status="ready",
            )
        return
    except UnsupportedActionError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "failed", {"unsupported": True}, str(exc))
        return
    if _is_task_cancelled(str(task["id"])):
        return
    status = "success" if result.get("ok") else "failed"
    detected_account_status = str(result.get("status") or "").strip().lower()
    if str(task.get("task_type") or "") == "check_login" and detected_account_status:
        account_status = "cookie_expired" if detected_account_status == "invalid_credentials" else detected_account_status
        if account_status not in SOCIAL_ACCOUNT_STATUSES:
            account_status = ""
    else:
        account_status = "ready" if status == "success" else ""
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
        return row is None or str(row["status"] or "") == "cancelled"
    except Exception:
        return True


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


def _persist_running_account_login_status(task_id: str, account_id: str, status: str) -> bool:
    clean_task_id = str(task_id or "").strip()
    clean_account_id = str(account_id or "").strip()
    clean_status = str(status or "").strip().lower()
    if not clean_task_id or not clean_account_id or clean_status not in SOCIAL_ACCOUNT_STATUSES:
        return False
    now = _now()
    with db() as conn:
        task = conn.execute(
            "SELECT account_id, status FROM social_automation_tasks WHERE id = ?",
            (clean_task_id,),
        ).fetchone()
        if (
            task is None
            or str(task["account_id"] or "") != clean_account_id
            or str(task["status"] or "") not in {"running", "need_manual"}
        ):
            return False
        updated = conn.execute(
            """
            UPDATE social_accounts
            SET status = ?, last_login_check_at = ?, last_error = '', updated_at = ?
            WHERE id = ?
            """,
            (clean_status, now, now, clean_account_id),
        ).rowcount
    return bool(updated)


def _persist_publish_confirmation_context(task_id: str, confirmation: dict[str, Any]) -> bool:
    clean_task_id = str(task_id or "").strip()
    clean_confirmation = dict(confirmation or {})
    if (
        not clean_task_id
        or clean_confirmation.get("phase") != "confirm_only"
        or not str(clean_confirmation.get("profile_url") or "").strip()
        or not isinstance(clean_confirmation.get("baseline_permalinks"), list)
    ):
        return False
    now = _now()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM social_automation_tasks WHERE id = ? AND status = 'running'",
            (clean_task_id,),
        ).fetchone()
        if row is None:
            return False
        slot = _ensure_daily_publish_slot(conn, row, now=now)
        publish_day = _daily_publish_day(now)
        if slot is not None and not bool(int(slot["waived"] or 0)):
            slot_state = str(slot["state"] or "")
            needs_capacity = str(slot["quota_day"] or "") != publish_day or slot_state == "released"
            if needs_capacity and _daily_publish_execution_count(
                conn,
                int(row["user_id"] or 0),
                publish_day,
                exclude_task_id=clean_task_id,
            ) >= DAILY_PUBLISH_LIMIT:
                return False
        payload = _loads(row["payload_json"], {})
        if not isinstance(payload, dict):
            payload = {}
        existing = payload.get("_publish_confirmation")
        existing = existing if isinstance(existing, dict) else {}
        payload["_publish_confirmation"] = {**existing, **clean_confirmation}
        updated = conn.execute(
            """
            UPDATE social_automation_tasks
            SET payload_json = ?, daily_publish_committed = 1,
                daily_publish_committed_at = CASE WHEN daily_publish_committed_at > 0 THEN daily_publish_committed_at ELSE ? END,
                updated_at = ?
            WHERE id = ? AND status = 'running'
            """,
            (json.dumps(payload, ensure_ascii=False), now, now, clean_task_id),
        ).rowcount
        if updated:
            _set_daily_publish_slot_state(conn, clean_task_id, "armed", now=now, quota_day=publish_day)
            _insert_log(
                conn,
                clean_task_id,
                "info",
                "threads_publish_confirmation_persisted",
                "发布前已保存仅确认上下文，后续恢复不会重复发布。",
                {},
            )
    return bool(updated)


def _finish_task(
    task_id: str,
    status: str,
    result: dict[str, Any],
    error: str,
    account_status: str = "",
) -> bool:
    now = _now()
    with db() as conn:
        task = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not task:
            return False
        result_json = json.dumps(result or {}, ensure_ascii=False)
        existing_committed = bool(int(task["daily_publish_committed"] or 0))
        publish_committed = bool(
            existing_committed
            or (
                str(task["task_type"] or "") == "publish_post"
                and (status == "success" or bool((result or {}).get("publish_submitted")))
            )
        )
        committed_at = int(task["daily_publish_committed_at"] or 0) if existing_committed else 0
        if publish_committed and committed_at <= 0:
            committed_at = now
        if status == "need_manual":
            completed = conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'need_manual', finished_at = 0, result_json = ?, error = ?,
                    daily_publish_committed = ?, daily_publish_committed_at = ?, updated_at = ?
                WHERE id = ? AND status IN ('running', 'need_manual')
                """,
                (result_json, error, 1 if publish_committed else 0, committed_at, now, task_id),
            ).rowcount
        else:
            completed = conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = ?, finished_at = ?, result_json = ?, error = ?,
                    daily_publish_committed = ?, daily_publish_committed_at = ?, updated_at = ?
                WHERE id = ? AND status IN ('running', 'need_manual')
                """,
                (status, now, result_json, error, 1 if publish_committed else 0, committed_at, now, task_id),
            ).rowcount
        if not completed:
            current = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
            if current is not None and str(current["status"] or "") in {"failed", "cancelled"}:
                _release_task_billing_reservation(conn, current, now=now)
            return False
        if str(task["task_type"] or "") == "publish_post":
            _ensure_daily_publish_slot(conn, task, now=now)
            if status == "success":
                _set_daily_publish_slot_state(
                    conn,
                    task_id,
                    "confirmed",
                    now=now,
                    quota_day="" if existing_committed else _daily_publish_day(now),
                )
            elif bool((result or {}).get("publish_outcome_unknown")) or existing_committed:
                _set_daily_publish_slot_state(conn, task_id, "unknown", now=now)
            elif bool((result or {}).get("publish_submitted")):
                _set_daily_publish_slot_state(conn, task_id, "submitted", now=now, quota_day=_daily_publish_day(now))
            elif status in {"failed", "cancelled"}:
                _release_daily_publish_slot(conn, task_id, error or status, now=now)
            elif status == "need_manual":
                _set_daily_publish_slot_state(conn, task_id, "reserved", now=now)
        if status == "success":
            clean_payload = _loads(task["payload_json"], {})
            if isinstance(clean_payload, dict) and clean_payload.pop("_publish_confirmation", None) is not None:
                conn.execute(
                    "UPDATE social_automation_tasks SET payload_json = ? WHERE id = ?",
                    (json.dumps(clean_payload, ensure_ascii=False), task_id),
                )
        reservation_id = str(task["billing_reservation_id"] or "") if "billing_reservation_id" in task.keys() else ""
        credit_cost_units = 0
        free_image_count = 0
        if reservation_id and status != "need_manual":
            if status == "success":
                commercial_billing.settle_reservation(conn, reservation_id, actual_quantity=1, success=True, now=now)
            else:
                _release_task_billing_reservation(conn, task, now=now)
            billing_row = conn.execute(
                "SELECT settled_credit_units, settled_image_count FROM billing_reservations WHERE id = ?",
                (reservation_id,),
            ).fetchone()
            if billing_row is not None:
                credit_cost_units = int(billing_row["settled_credit_units"] or 0)
                free_image_count = int(billing_row["settled_image_count"] or 0)
            conn.execute(
                "UPDATE social_automation_tasks SET credit_cost_units = ?, free_image_count = ? WHERE id = ?",
                (credit_cost_units, free_image_count, task_id),
            )
        _insert_log(conn, task_id, "info" if status == "success" else "error", status, "任务执行完成" if status == "success" else error, result)
        normalized_account_status = str(account_status or "").strip().lower()
        if normalized_account_status in SOCIAL_ACCOUNT_STATUSES:
            account_error = "" if status == "success" else str(error or "")
            conn.execute(
                "UPDATE social_accounts SET status = ?, last_login_check_at = ?, last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
                (normalized_account_status, now, now, account_error, now, str(task["account_id"])),
            )
        else:
            conn.execute(
                "UPDATE social_accounts SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
                (now, error, now, str(task["account_id"])),
            )
        task_type = str(task["task_type"] or "")
        if task_type in {"check_login", "open_login"}:
            conn.execute(
                """
                UPDATE social_accounts
                SET status_attempted_at = ?, status_attempt_error = ?, status_source_task_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    now,
                    "" if status == "success" else str(error or "状态检测执行失败")[:1000],
                    str(task["id"] or ""),
                    now,
                    str(task["account_id"]),
                ),
            )
        if task_type == "check_login" and status != "need_manual":
            health_status = str((result or {}).get("health_status") or "").strip().lower()
            if health_status not in SOCIAL_ACCOUNT_HEALTH_STATUSES and status == "success":
                if normalized_account_status == "ready":
                    health_status = "alive"
                elif normalized_account_status == "disabled":
                    health_status = "banned"
                elif normalized_account_status == "transient_error":
                    health_status = "abnormal"
                else:
                    health_status = "unknown"
            if health_status in SOCIAL_ACCOUNT_HEALTH_STATUSES:
                details = (result or {}).get("details")
                health_detail = str(
                    (result or {}).get("health_reason")
                    or (details.get("reason") if isinstance(details, dict) else "")
                    or error
                    or health_status
                )[:1000]
                conn.execute(
                    """
                    UPDATE social_accounts
                    SET health_status = ?, health_checked_at = ?, health_detail = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (health_status, now, health_detail, now, str(task["account_id"])),
                )
        elif status == "success" and normalized_account_status == "ready":
            conn.execute(
                """
                UPDATE social_accounts
                SET health_status = 'alive', health_checked_at = ?, health_detail = ?,
                    status_attempted_at = ?, status_attempt_error = '', status_source_task_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    now,
                    "登录成功，平台账号正常可用。",
                    now,
                    str(task["id"] or ""),
                    now,
                    str(task["account_id"]),
                ),
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
            if _remove_stale_archive_lock(lock_path):
                continue
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


def _remove_stale_archive_lock(lock_path: Path, *, max_age_seconds: int = 300) -> bool:
    try:
        raw = lock_path.read_text(encoding="utf-8").strip().split()
        pid = int(raw[0]) if raw else 0
        created_at = float(raw[1]) if len(raw) > 1 else float(lock_path.stat().st_mtime)
    except Exception:
        pid = 0
        try:
            created_at = float(lock_path.stat().st_mtime)
        except Exception:
            return False
    stale = time.time() - created_at > max_age_seconds
    if not stale and os.name != "nt" and pid > 0:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            stale = True
        except (PermissionError, OSError):
            pass
    if not stale:
        return False
    try:
        lock_path.unlink()
        return True
    except FileNotFoundError:
        return True
    except Exception:
        return False


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        if os.name != "nt":
            directory_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except Exception:
        with contextlib.suppress(FileNotFoundError):
            temp_path.unlink()
        raise


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
    _atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


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
    return _open_login_auto_submit_mode(payload) is False and not bool((payload or {}).get("manual_takeover"))


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
            owner_row = conn.execute(
                "SELECT 1 FROM persona_owners WHERE archive_id = ? AND user_id = ?",
                (str(task_row["persona_id"] or "").strip(), int(task_row["user_id"] or 0)),
            ).fetchone()
        task = dict(task_row)
        account = dict(account_row) if account_row else {}
        if str(task.get("task_type") or "").strip().lower() != "publish_post":
            return
        persona_id = str(task.get("persona_id") or account.get("persona_id") or "").strip()
        if (
            not persona_id
            or not owner_row
            or int(account.get("user_id") or 0) != int(task.get("user_id") or 0)
            or str(account.get("persona_id") or "").strip() != persona_id
        ):
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
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        confirmation = payload.get("_publish_confirmation") if isinstance(payload, dict) else None
        if isinstance(confirmation, dict) and confirmation.get("phase") == "confirm_only":
            from social_automation.runner import PublishConfirmationPendingError

            pending = PublishConfirmationPendingError(str(exc), "", confirmation)
            if _requeue_publish_confirmation(task_id, pending):
                return
            _finish_task(
                task_id,
                "failed",
                {
                    "publish_submitted": True,
                    "confirmation_failed": True,
                    "confirmation_exhausted": True,
                    "publish_outcome_unknown": True,
                    "retryable": False,
                    "confirmation_attempt": int((pending.confirmation or {}).get("attempt") or 0),
                    "confirmation_max_attempts": int((pending.confirmation or {}).get("max_attempts") or 0),
                },
                str(exc),
                account_status="ready",
            )
            return
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
    account_ids = {str(row["id"] or "").strip() for row in rows if str(row["id"] or "").strip()}
    proxies: dict[str, Any] = {}
    totp_rows: dict[str, Any] = {}
    if proxy_ids:
        placeholders = ",".join("?" for _ in proxy_ids)
        proxy_rows = conn.execute(f"SELECT * FROM social_proxies WHERE id IN ({placeholders})", tuple(proxy_ids)).fetchall()
        proxies = {str(row["id"] or ""): row for row in proxy_rows}
    if account_ids:
        placeholders = ",".join("?" for _ in account_ids)
        secret_rows = conn.execute(
            f"SELECT * FROM social_account_totp_secrets WHERE account_id IN ({placeholders})",
            tuple(account_ids),
        ).fetchall()
        totp_rows = {str(row["account_id"] or ""): row for row in secret_rows}
    return [
        _account_public(
            row,
            proxies.get(str(row["proxy_id"] or "")),
            totp_rows.get(str(row["id"] or "")),
        )
        for row in rows
    ]


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


def _account_effective_status(row: Any) -> str:
    item = dict(row)
    raw_status = str(item.get("status") or "unknown").strip().lower()
    health_status = str(item.get("health_status") or "unknown").strip().lower()
    observed_at = max(
        int(item.get("last_login_check_at") or 0),
        int(item.get("health_checked_at") or 0),
    )
    attempted_at = int(item.get("status_attempted_at") or 0)
    attempt_error = str(item.get("status_attempt_error") or "").strip()
    if raw_status == "disabled":
        return "disabled"
    if health_status == "banned":
        return "banned"
    if raw_status != "ready":
        return raw_status or "unknown"
    if attempt_error and attempted_at >= observed_at:
        return "check_failed"
    if health_status == "abnormal":
        return "abnormal"
    if health_status == "unknown":
        return "ready_unverified"
    return "ready"


def _account_public(row: Any, proxy_row: Any | None = None, totp_row: Any | None = None) -> dict[str, Any]:
    item = dict(row)
    totp = _social_account_totp_public(totp_row)
    raw_status = str(item.get("status") or "unknown").strip().lower()
    health_status = str(item.get("health_status") or "unknown").strip().lower()
    effective_status = _account_effective_status(item)
    status_checked_at = max(
        int(item.get("last_login_check_at") or 0),
        int(item.get("health_checked_at") or 0),
        int(item.get("status_attempted_at") or 0),
    )
    status_detail = str(
        item.get("status_attempt_error")
        or item.get("health_detail")
        or item.get("last_error")
        or ""
    )
    return {
        "id": str(item.get("id") or ""),
        "persona_id": str(item.get("persona_id") or ""),
        "platform": str(item.get("platform") or ""),
        "username": str(item.get("username") or ""),
        "display_name": str(item.get("display_name") or ""),
        "profile_dir": str(item.get("profile_dir") or ""),
        "proxy_id": str(item.get("proxy_id") or ""),
        "residential_proxy": _residential_proxy_public(proxy_row) if proxy_row is not None else None,
        "status": raw_status,
        "effective_status": effective_status,
        "status_checked_at": status_checked_at,
        "status_detail": status_detail,
        "status_attempted_at": int(item.get("status_attempted_at") or 0),
        "status_attempt_error": str(item.get("status_attempt_error") or ""),
        "status_source_task_id": str(item.get("status_source_task_id") or ""),
        "health_status": health_status,
        "health_checked_at": int(item.get("health_checked_at") or 0),
        "health_detail": str(item.get("health_detail") or ""),
        "login_username": str(item.get("login_username") or "") or str(item.get("username") or ""),
        "login_password_configured": bool(str(item.get("login_password") or "")),
        "login_credentials_updated_at": int(item.get("login_credentials_updated_at") or 0),
        "totp_configured": bool(totp["configured"]),
        "totp_status": str(totp["status"]),
        "totp_updated_at": int(totp["updated_at"]),
        "totp_last_verified_at": int(totp["last_verified_at"]),
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
        "connection_mode": "proxy",
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
        "exit_ip": str(response.get("ip") or safe_result.get("exit_ip") or safe_result.get("ip") or ""),
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
    owner_user_id = int(account.get("user_id") or task.get("user_id") or 0)
    preferences = effective_user_browser_preferences(get_user_browser_preferences(owner_user_id))
    review_hold = preferences["completion_policy"] == "review_hold"
    # These are internal runtime controls. Always overwrite client payload
    # values so a task cannot bypass its tenant or global resource limits.
    payload["retain_live_browser_after_finish"] = review_hold
    payload["live_browser_standby_seconds"] = preferences["standby_seconds"] if review_hold else 0
    payload["live_browser_auto_close_seconds"] = preferences["auto_close_seconds"] if review_hold else 10
    payload["manual_login_timeout_seconds"] = preferences["manual_timeout_seconds"]
    payload["text_input_mode"] = preferences["text_input_mode"]
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


def _apply_runtime_task_preferences(
    task: dict[str, Any],
    account: dict[str, Any],
    context_control: dict[str, Any],
) -> dict[str, Any]:
    runtime_task = dict(task)
    runtime_task["payload"] = _runtime_task_payload(runtime_task, account)
    # Browser cleanup reads the task stored on context_control. Keep that copy
    # synchronized with the server-owned runtime payload before the runner starts.
    context_control["task"] = dict(runtime_task)
    return runtime_task


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
        "connection_mode": "proxy",
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
        "exit_ip": str(response.get("ip") or last_check_result.get("exit_ip") or last_check_result.get("ip") or ""),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }
    if bound_account_ids is not None:
        public["bound_account_count"] = len(bound_account_ids)
        public["bound_account_ids"] = list(bound_account_ids)
    return public


def _billing_reservation_statuses(conn: sqlite3.Connection, rows: list[Any]) -> dict[str, str]:
    reservation_ids = list(
        dict.fromkeys(
            str(dict(row).get("billing_reservation_id") or "").strip()
            for row in rows
            if str(dict(row).get("billing_reservation_id") or "").strip()
        )
    )
    if not reservation_ids:
        return {}
    placeholders = ",".join("?" for _ in reservation_ids)
    status_rows = conn.execute(
        f"SELECT id, status FROM billing_reservations WHERE id IN ({placeholders})",
        tuple(reservation_ids),
    ).fetchall()
    return {str(item["id"] or ""): str(item["status"] or "") for item in status_rows}


def _task_public(row: Any, *, billing_reservation_status: str = "") -> dict[str, Any]:
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
    reservation_id = str(item.get("billing_reservation_id") or "")
    task_result = _loads(item.get("result_json"), {})
    billing_status = "unbilled"
    if reservation_id:
        exact_status = str(billing_reservation_status or item.get("billing_reservation_status") or "").strip().lower()
        if not exact_status:
            try:
                with db() as conn:
                    status_row = conn.execute("SELECT status FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone()
                exact_status = str(status_row["status"] or "").strip().lower() if status_row else ""
            except Exception:
                exact_status = ""
        billing_status = exact_status if exact_status in {"held", "settled", "released", "waived"} else "unknown"
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
        "result": _redact_sensitive(task_result),
        "error": str(item.get("error") or ""),
        "retry_count": int(item.get("retry_count") or 0),
        "max_retries": int(item.get("max_retries") or 0),
        "created_by": str(item.get("created_by") or ""),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
        "billing": {
            "reservation_id": reservation_id,
            "status": billing_status,
            "charged_points": commercial_billing.points_from_units(int(item.get("credit_cost_units") or 0)),
            "free_images_used": int(item.get("free_image_count") or 0),
        },
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


def _require_proxy(conn, proxy_id: str, *, owner_user_id: int | None = None) -> Any:
    if owner_user_id is None:
        row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM social_proxies WHERE id = ? AND user_id = ?",
            (proxy_id, int(owner_user_id)),
        ).fetchone()
    if row and str(row["ip_type"] or "").strip().lower() != "static_residential":
        raise HTTPException(status_code=400, detail="账号仅允许绑定静态住宅 IP")
    if not row:
        raise HTTPException(status_code=404, detail="绑定代理不存在")
    return row


def _proxy_is_expired(proxy: Any) -> bool:
    expires_at = int(proxy["expires_at"] or 0) if proxy else 0
    return bool(expires_at and expires_at <= _now())


def _proxy_has_verified_check(proxy: Any) -> bool:
    if not proxy or int(proxy["last_check_at"] or 0) <= 0:
        return False
    result = _loads(proxy["last_check_result"], {})
    return bool(isinstance(result, dict) and result.get("ok") is True)


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


def _normalize_proxy_connection_mode(value: str | None) -> str:
    clean = str(value or "proxy").strip().lower()
    if clean != "proxy":
        raise HTTPException(status_code=400, detail="代理方式仅支持 Proxy（代理服务器）")
    return "proxy"


def _normalize_proxy_source(value: Any) -> str:
    raw = str(value or "manual").strip()
    clean = raw.lower()
    aliases = {"owlproxy": "owlproxy", "owl proxy": "owlproxy"}
    if clean in {"manual", "provider", "self_owned"} or clean in aliases:
        return aliases.get(clean, clean)
    if len(raw) > 80 or not re.fullmatch(r"[\w .&()\-/]+", raw, flags=re.UNICODE):
        raise HTTPException(status_code=400, detail="代理来源格式无效")
    return raw


def _normalize_proxy_purchase_status(value: Any) -> str:
    clean = str(value or "owned").strip().lower()
    if clean not in {"owned", "leased"}:
        raise HTTPException(status_code=400, detail="持有方式仅支持自有或租用")
    return clean


def _validate_proxy_endpoint(proxy_type: Any, host: Any, port: Any) -> tuple[str, str, int]:
    scheme = _normalize_proxy_type(str(proxy_type or "http"))
    clean_host = str(host or "").strip()
    try:
        clean_port = int(port or 0)
    except (TypeError, ValueError):
        clean_port = 0
    if not clean_host or not 1 <= clean_port <= 65535:
        raise HTTPException(status_code=400, detail="服务器地址和端口必填，端口必须在 1-65535 之间")
    if any(token in clean_host for token in ("://", "/", "?", "#", "@")) or any(char.isspace() for char in clean_host):
        raise HTTPException(status_code=400, detail="服务器地址只能填写裸 IP 或域名，不能包含协议、端口、路径或账号")
    if clean_host.startswith("[") and clean_host.endswith("]"):
        clean_host = clean_host[1:-1]
    try:
        parsed_ip = ipaddress.ip_address(clean_host)
        clean_host = parsed_ip.compressed
    except ValueError:
        if ":" in clean_host:
            raise HTTPException(status_code=400, detail="IPv6 地址格式无效")
        try:
            ascii_host = clean_host.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise HTTPException(status_code=400, detail="服务器域名格式无效")
        labels = ascii_host.split(".")
        if (
            len(ascii_host) > 253
            or not labels
            or any(not label or len(label) > 63 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) for label in labels)
            or (all(label.isdigit() for label in labels) and len(labels) == 4)
        ):
            raise HTTPException(status_code=400, detail="服务器域名或 IP 格式无效")
        clean_host = ascii_host
    return scheme, clean_host, clean_port


def _validate_proxy_credentials(username: Any, password: Any) -> None:
    clean_username = str(username or "").strip()
    raw_password = str(password or "")
    if raw_password and not clean_username:
        raise HTTPException(status_code=400, detail="填写代理密码时必须同时填写认证账号")


def _public_ip(value: Any, *, label: str) -> str:
    clean = str(value or "").strip()
    try:
        parsed = ipaddress.ip_address(clean)
    except ValueError:
        raise RuntimeError(f"{label}返回了无效 IP")
    if not parsed.is_global:
        raise RuntimeError(f"{label}返回的不是公网 IP")
    return parsed.compressed


def _response_json(response: Any, *, label: str) -> dict[str, Any]:
    if not bool(getattr(response, "ok", False)):
        raise RuntimeError(f"{label}请求失败（HTTP {int(getattr(response, 'status_code', 0) or 0)}）")
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"{label}返回格式无效")
    return data


def _proxy_check_error_message(exc: Exception) -> str:
    text = str(exc or "").lower()
    if "timed out" in text or "timeout" in text:
        return "代理检测超时，请确认代理服务在线后重试。"
    if "name or service not known" in text or "getaddrinfo" in text or "failed to resolve" in text:
        return "服务器地址无法解析，请检查 IP 或域名是否填写正确。"
    if "connection refused" in text or "0x05" in text or "proxyerror" in text or "socks" in text:
        return "代理服务器拒绝连接，请核对服务器地址、端口、代理类型和认证信息。"
    if isinstance(exc, RuntimeError) and len(str(exc)) <= 160:
        return str(exc)
    return "代理网络检测失败，请检查连接参数后重试。"


def _proxy_url(proxy: dict[str, Any], *, include_password: bool) -> str:
    scheme, host, port = _validate_proxy_endpoint(
        proxy.get("proxy_type") or "http",
        proxy.get("host") or "",
        proxy.get("port") or 0,
    )
    display_host = f"[{host}]" if ":" in host else host
    username = str(proxy.get("username") or "").strip()
    raw_password = str(proxy.get("password") or "")
    _validate_proxy_credentials(username, raw_password)
    password = quote(raw_password, safe="") if include_password else ("***" if raw_password else "")
    auth = ""
    if username:
        encoded_username = quote(username, safe="")
        auth = encoded_username if not password else f"{encoded_username}:{password}"
        auth += "@"
    return f"{scheme}://{auth}{display_host}:{port}"


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
