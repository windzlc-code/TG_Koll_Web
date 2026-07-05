from __future__ import annotations

import json
import os
import threading
import time
import uuid
import contextlib
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import requests
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .auth import get_current_user, require_admin
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
_WORKER_STATE: dict[str, Any] = {
    "enabled": False,
    "running": False,
    "last_started_at": 0,
    "last_tick_at": 0,
    "last_task_id": "",
    "last_error": "",
}
_RUNNING_TASK_CONTROLS: dict[str, dict[str, Any]] = {}
_RUNNING_TASK_CONTROLS_LOCK = threading.Lock()
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
    isp: str = ""
    status: str = "active"


class SocialAccountPayload(BaseModel):
    persona_id: str = ""
    platform: str = "instagram"
    username: str = ""
    display_name: str = ""
    profile_dir: str = ""
    proxy_id: str = ""
    status: str = "pending_login"


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


class SocialTaskActionPayload(BaseModel):
    reason: str = ""


def configure_social_automation(*, data_dir: Path, new_id: Callable[[str], str] | None = None) -> None:
    global _DATA_DIR, _NEW_ID
    _DATA_DIR = Path(data_dir).resolve()
    if new_id is not None:
        _NEW_ID = new_id


def register_social_automation_routes(app: FastAPI) -> None:
    @app.get("/api/persona_dashboard/automation/overview")
    def api_social_automation_overview(_user: dict[str, Any] = Depends(get_current_user)):
        return build_social_automation_overview()

    @app.get("/api/persona_dashboard/automation/accounts")
    def api_social_accounts(_user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM social_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        return {"ok": True, "accounts": [_account_public(row) for row in rows]}

    @app.post("/api/persona_dashboard/automation/accounts")
    def api_social_account_create(payload: SocialAccountPayload, _user: dict[str, Any] = Depends(get_current_user)):
        account = create_social_account(payload)
        return {"ok": True, "account": account}

    @app.patch("/api/persona_dashboard/automation/accounts/{account_id}")
    def api_social_account_patch(account_id: str, payload: SocialAccountPatchPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "account": update_social_account(account_id, payload)}

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
    def api_social_account_check_login(account_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "task": create_account_task(account_id, "check_login", {})}

    @app.post("/api/persona_dashboard/automation/accounts/{account_id}/open_login")
    def api_social_account_open_login(account_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        wait_seconds = int(os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "600"))
        return {"ok": True, "task": create_account_task(account_id, "open_login", {"login_wait_seconds": wait_seconds})}

    @app.get("/api/persona_dashboard/automation/proxies")
    def api_social_proxies(_user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            rows = conn.execute("SELECT * FROM social_proxies ORDER BY updated_at DESC, created_at DESC").fetchall()
        return {"ok": True, "proxies": [_proxy_public(row) for row in rows]}

    @app.post("/api/persona_dashboard/automation/proxies")
    def api_social_proxy_create(payload: SocialProxyPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "proxy": create_social_proxy(payload)}

    @app.post("/api/persona_dashboard/automation/proxies/{proxy_id}/check")
    def api_social_proxy_check(proxy_id: str, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "proxy": check_social_proxy(proxy_id)}

    @app.get("/api/persona_dashboard/automation/tasks")
    def api_social_tasks(status: str = "", account_id: str = "", limit: int = 60, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "tasks": list_social_tasks(status=status, account_id=account_id, limit=limit)}

    @app.post("/api/persona_dashboard/automation/tasks")
    def api_social_task_create(payload: SocialTaskPayload, _user: dict[str, Any] = Depends(get_current_user)):
        return {"ok": True, "task": create_social_task(payload)}

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
    def api_social_screenshot(filename: str, _user: dict[str, Any] = Depends(get_current_user)):
        safe = Path(filename).name
        path = (_DATA_DIR / "social_automation" / "screenshots" / safe).resolve()
        root = (_DATA_DIR / "social_automation" / "screenshots").resolve()
        if root != path.parent or not path.exists():
            raise HTTPException(status_code=404, detail="截图不存在")
        return FileResponse(str(path))


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
        tasks = conn.execute(
            "SELECT * FROM social_automation_tasks ORDER BY created_at DESC LIMIT 80"
        ).fetchall()
        all_tasks = conn.execute("SELECT task_type, payload_json, status FROM social_automation_tasks").fetchall()
    visible_tasks = [
        row for row in tasks
        if not _is_manual_open_login_task(dict(row), _loads(row["payload_json"], {}))
    ]
    counts: dict[str, int] = {}
    for row in all_tasks:
        if _is_manual_open_login_task(dict(row), _loads(row["payload_json"], {})):
            continue
        status = str(row["status"] or "")
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
        "accounts": [_account_public(row) for row in accounts],
        "proxies": [_proxy_public(row) for row in proxies],
        "tasks": [_task_public(row) for row in visible_tasks],
        "worker": dict(_WORKER_STATE),
        "supported_task_types": sorted(SOCIAL_TASK_TYPES),
    }


def create_social_proxy(payload: SocialProxyPayload) -> dict[str, Any]:
    proxy_type = _normalize_proxy_type(payload.proxy_type)
    host = str(payload.host or "").strip()
    port = int(payload.port or 0)
    if not host or port <= 0:
        raise HTTPException(status_code=400, detail="代理 host 和 port 必填")
    now = _now()
    proxy_id = _NEW_ID("social_proxy")
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_proxies(id, name, proxy_type, host, port, username, password, country, isp, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                proxy_id,
                str(payload.name or f"{proxy_type}://{host}:{port}").strip(),
                proxy_type,
                host,
                port,
                str(payload.username or "").strip(),
                str(payload.password or ""),
                str(payload.country or "").strip(),
                str(payload.isp or "").strip(),
                str(payload.status or "active").strip() or "active",
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    return _proxy_public(row)


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
            "https://api.ipify.org?format=json",
            proxies={"http": proxy_url, "https": proxy_url},
            timeout=20,
        )
        result.update({"ok": resp.ok, "status_code": resp.status_code, "response": resp.json() if resp.ok else resp.text[:500]})
    except Exception as exc:
        result.update({"ok": False, "error": str(exc)})
    status = "active" if result.get("ok") else "failed"
    with db() as conn:
        conn.execute(
            "UPDATE social_proxies SET status = ?, last_check_at = ?, last_check_result = ?, updated_at = ? WHERE id = ?",
            (status, _now(), json.dumps(result, ensure_ascii=False), _now(), proxy_id),
        )
        updated = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
    return _proxy_public(updated)


def create_social_account(payload: SocialAccountPayload) -> dict[str, Any]:
    platform = _normalize_platform(payload.platform)
    username = str(payload.username or "").strip().lstrip("@")
    if not username:
        raise HTTPException(status_code=400, detail="账号 username 必填")
    persona_id = str(payload.persona_id or "").strip()
    if not persona_id:
        raise HTTPException(status_code=400, detail="persona_id 必填")
    status = str(payload.status or "pending_login").strip()
    if status not in SOCIAL_ACCOUNT_STATUSES:
        status = "pending_login"
    account_id = _NEW_ID("social_account")
    profile_dir = str(payload.profile_dir or "").strip()
    if not profile_dir:
        profile_dir = str((_DATA_DIR / "social_automation" / "profiles" / platform / account_id).resolve())
    Path(profile_dir).mkdir(parents=True, exist_ok=True)
    now = _now()
    with db() as conn:
        if payload.proxy_id:
            _require_proxy(conn, payload.proxy_id)
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
                str(payload.proxy_id or "").strip(),
                status,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
    return _account_public(row)


def update_social_account(account_id: str, payload: SocialAccountPatchPayload) -> dict[str, Any]:
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
    if "status" in updates and updates["status"] not in SOCIAL_ACCOUNT_STATUSES:
        raise HTTPException(status_code=400, detail="账号状态不合法")
    if "username" in updates:
        updates["username"] = updates["username"].lstrip("@")
    if not updates:
        return get_social_account(account_id)
    updates["updated_at"] = _now()
    with db() as conn:
        existing = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="账号不存在")
        if updates.get("proxy_id"):
            _require_proxy(conn, updates["proxy_id"])
        if updates.get("profile_dir"):
            Path(updates["profile_dir"]).mkdir(parents=True, exist_ok=True)
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"UPDATE social_accounts SET {assignments} WHERE id = ?", (*updates.values(), account_id))
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (account_id,)).fetchone()
    return _account_public(row)


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
        persona_id = str(payload.persona_id or account["persona_id"] or "").strip()
        runtime_secrets: dict[str, str] = {}
        if task_type == "open_login" and task_payload.get("auto_submit"):
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
        row = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="任务不存在")
        status = str(row["status"] or "")
        if status in {"success", "failed", "cancelled"}:
            return _task_public(row)
        if status == "running":
            conn.execute(
                "UPDATE social_automation_tasks SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ? WHERE id = ?",
                (now, clean_reason, now, task_id),
            )
            _insert_log(conn, task_id, "warn", "cancel", "任务已取消，正在强制关闭浏览器上下文", {"reason": clean_reason})
        else:
            conn.execute(
                "UPDATE social_automation_tasks SET status = 'cancelled', finished_at = ?, error = ?, updated_at = ? WHERE id = ?",
                (now, clean_reason, now, task_id),
            )
            _insert_log(conn, task_id, "warn", "cancel", "任务已取消", {"reason": clean_reason})
        updated = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    if status in {"running", "need_manual"}:
        _force_stop_running_task(task_id)
    wake_social_automation_worker()
    return _task_public(updated)


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
        task = _claim_next_task()
        if not task:
            return None
        _WORKER_STATE.update({"running": True, "last_tick_at": _now(), "last_task_id": task["id"], "last_error": ""})
        try:
            _execute_claimed_task(task)
            return {"task_id": task["id"], "status": "finished"}
        except Exception as exc:
            _WORKER_STATE["last_error"] = str(exc)
            _fail_task_safely(task["id"], exc)
            return {"task_id": task["id"], "status": "failed", "error": str(exc)}
        finally:
            _WORKER_STATE["running"] = False
            _WORKER_STATE["last_tick_at"] = _now()


def _worker_loop() -> None:
    _WORKER_STATE["last_started_at"] = _now()
    while not _WORKER_STOP.is_set():
        try:
            run_social_automation_once()
        except Exception as exc:
            _WORKER_STATE["last_error"] = str(exc)
        _WORKER_WAKE.wait(timeout=max(1, int(os.getenv("SOCIAL_AUTOMATION_WORKER_POLL_SECONDS", "5"))))
        _WORKER_WAKE.clear()


def _claim_next_task() -> dict[str, Any] | None:
    now = _now()
    with db() as conn:
        row = conn.execute(
            """
            SELECT * FROM social_automation_tasks
            WHERE status = 'queued' AND (scheduled_at = 0 OR scheduled_at <= ?)
            ORDER BY priority ASC, created_at ASC
            LIMIT 1
            """,
            (now,),
        ).fetchone()
        if not row:
            return None
        task_id = str(row["id"])
        conn.execute(
            "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
            (now, now, task_id),
        )
        _insert_log(conn, task_id, "info", "running", "Worker 已领取任务", {})
        updated = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
    public = _task_public(updated)
    public["payload"] = _loads(updated["payload_json"], {})
    return public


def _execute_claimed_task(task: dict[str, Any]) -> None:
    with db() as conn:
        account_row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (task["account_id"],)).fetchone()
        if not account_row:
            raise RuntimeError("任务绑定账号不存在")
        proxy_row = None
        if str(account_row["proxy_id"] or "").strip():
            proxy_row = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (account_row["proxy_id"],)).fetchone()
    account = dict(account_row)
    proxy = dict(proxy_row) if proxy_row else None
    task = dict(task)
    task["payload"] = _runtime_task_payload(task, account)
    from social_automation.runner import NeedManualError, UnsupportedActionError, run_social_task

    logger = _DbTaskLogger(task["id"])
    control = {"cancel_event": threading.Event(), "context": None, "manager": None}
    with _RUNNING_TASK_CONTROLS_LOCK:
        _RUNNING_TASK_CONTROLS[str(task["id"])] = control
    try:
        result = run_social_task(
            task=task,
            account=account,
            proxy=proxy,
            data_dir=_DATA_DIR,
            logger=logger,
            cancel_event=control["cancel_event"],
            context_control=control,
        )
    except NeedManualError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "need_manual", {}, str(exc), account_status=str(getattr(exc, "status", "") or "need_verification"))
        return
    except UnsupportedActionError as exc:
        if not _is_task_cancelled(str(task["id"])):
            _finish_task(task["id"], "failed", {"unsupported": True}, str(exc))
        return
    finally:
        with _EPHEMERAL_TASK_SECRETS_LOCK:
            _EPHEMERAL_TASK_SECRETS.pop(str(task["id"]), None)
        with _RUNNING_TASK_CONTROLS_LOCK:
            _RUNNING_TASK_CONTROLS.pop(str(task["id"]), None)
    if _is_task_cancelled(str(task["id"])):
        return
    status = "success" if result.get("ok") else "failed"
    account_status = ""
    if task.get("task_type") in {"check_login", "open_login"} and result.get("status") == "ready":
        account_status = "ready"
    _finish_task(task["id"], status, result, "" if status == "success" else str(result.get("error") or "执行失败"), account_status=account_status)


def _is_task_cancelled(task_id: str) -> bool:
    try:
        with db() as conn:
            row = conn.execute("SELECT status FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        return bool(row and str(row["status"] or "") == "cancelled")
    except Exception:
        return False


def _force_stop_running_task(task_id: str) -> None:
    with _RUNNING_TASK_CONTROLS_LOCK:
        control = _RUNNING_TASK_CONTROLS.get(str(task_id))
        if not control:
            return
        cancel_event = control.get("cancel_event")
        context = control.get("context")
    if cancel_event is not None:
        with contextlib.suppress(Exception):
            cancel_event.set()
    if context is not None:
        with contextlib.suppress(Exception):
            context.close()
    with contextlib.suppress(Exception):
        with db() as conn:
            _insert_log(conn, task_id, "warn", "force_stop", "已发送强制停止信号并关闭浏览器上下文", {})


def _finish_task(task_id: str, status: str, result: dict[str, Any], error: str, account_status: str = "") -> None:
    now = _now()
    with db() as conn:
        task = conn.execute("SELECT * FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()
        if not task:
            return
        conn.execute(
            """
            UPDATE social_automation_tasks
            SET status = ?, finished_at = ?, result_json = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, now, json.dumps(result or {}, ensure_ascii=False), error, now, task_id),
        )
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
    if status == "success":
        _sync_successful_task_to_persona_archive(task_id, result)


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
                raise RuntimeError("Persona archive is locked; try again later")
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
        "publish_post": "网页自动化发帖",
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


def _is_manual_open_login_task(task: dict[str, Any], payload: dict[str, Any] | None = None) -> bool:
    if str(task.get("task_type") or "") != "open_login":
        return False
    data = payload if isinstance(payload, dict) else {}
    return data.get("auto_submit") is not True


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
    screenshot_path = str(result.get("screenshot_path") or "").strip()
    source_meta = {
        "platform": platform,
        "source": "web_social_automation",
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
        "screenshotUrl": screenshot_path,
        "sourceMeta": source_meta,
        "publishedMeta": source_meta,
        "publishedTargets": [{
            "platform": platform,
            "publishedUrl": result_url,
            "screenshotUrl": screenshot_path,
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
            "screenshotUrl": screenshot_path,
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
        persona_id = str(task.get("persona_id") or account.get("persona_id") or "").strip()
        if not persona_id:
            return
        payload = json.loads(str(task.get("payload_json") or "{}"))
        if not isinstance(payload, dict):
            payload = {}
        if _is_manual_open_login_task(task, payload):
            return
        publish_record, post_record = _build_archive_sync_records(task, account, payload, result or {})
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
                    if post_record:
                        posts = archive.get("posts") if isinstance(archive.get("posts"), list) else []
                        matched_post = False
                        next_posts: list[dict[str, Any] | Any] = []
                        for item in posts:
                            if not isinstance(item, dict):
                                next_posts.append(item)
                                continue
                            if str(item.get("id") or "") == str(post_record["id"]) or str(item.get("automationTaskId") or "") == task_id:
                                next_posts.append({**item, **post_record})
                                matched_post = True
                                changed = True
                            else:
                                next_posts.append(item)
                        if matched_post:
                            archive["posts"] = next_posts
                        else:
                            archive["posts"] = [*posts, post_record]
                            changed = True
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
                                next_platform_rows.append({**item, **post_record})
                                matched_platform_post = True
                                changed = True
                            else:
                                next_platform_rows.append(item)
                        platform_posts[platform] = next_platform_rows if matched_platform_post else [*platform_rows, post_record]
                        if not matched_platform_post:
                            changed = True
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
                conn.execute(
                    """
                    UPDATE social_automation_tasks
                    SET status = 'queued', retry_count = ?, error = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (retry_count + 1, str(exc), now, task_id),
                )
                _insert_log(conn, task_id, "warn", "retry", "任务失败，已重新排队", {"error": str(exc), "retry_count": retry_count + 1})
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


def _account_public(row: Any) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": str(item.get("id") or ""),
        "persona_id": str(item.get("persona_id") or ""),
        "platform": str(item.get("platform") or ""),
        "username": str(item.get("username") or ""),
        "display_name": str(item.get("display_name") or ""),
        "profile_dir": str(item.get("profile_dir") or ""),
        "proxy_id": str(item.get("proxy_id") or ""),
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


def _redact_sensitive(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            lower = str(key or "").lower()
            if any(token in lower for token in ("password", "passwd", "secret", "token", "cookie")):
                result[key] = "***" if str(item or "") else ""
            else:
                result[key] = _redact_sensitive(item)
        return result
    if isinstance(value, list):
        return [_redact_sensitive(item) for item in value]
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


def _extract_runtime_secrets(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    clean = dict(payload or {})
    secrets: dict[str, str] = {}
    for key in ("login_password", "password"):
        value = str(clean.pop(key, "") or "")
        if value and not secrets.get("login_password"):
            secrets["login_password"] = value
    return clean, secrets


def _runtime_task_payload(task: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
    payload = dict(task.get("payload") or {})
    if str(task.get("task_type") or "") != "open_login" or not payload.get("auto_submit"):
        return payload
    task_id = str(task.get("id") or "")
    with _EPHEMERAL_TASK_SECRETS_LOCK:
        secrets = dict(_EPHEMERAL_TASK_SECRETS.get(task_id) or {})
    saved_username = str(account.get("login_username") or "").strip()
    saved_password = str(account.get("login_password") or "")
    payload["login_username"] = str(payload.get("login_username") or saved_username or account.get("username") or "").strip()
    if not str(payload.get("login_password") or ""):
        runtime_password = str(secrets.get("login_password") or saved_password or "")
        if runtime_password:
            payload["login_password"] = runtime_password
    return payload


def _proxy_public(row: Any) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "proxy_type": str(item.get("proxy_type") or ""),
        "host": str(item.get("host") or ""),
        "port": int(item.get("port") or 0),
        "username": str(item.get("username") or ""),
        "password_configured": bool(str(item.get("password") or "")),
        "country": str(item.get("country") or ""),
        "isp": str(item.get("isp") or ""),
        "status": str(item.get("status") or ""),
        "last_check_at": int(item.get("last_check_at") or 0),
        "last_check_result": _loads(item.get("last_check_result"), {}),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }


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
    row = conn.execute("SELECT id FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
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
    password = str(proxy.get("password") or "").strip() if include_password else ("***" if str(proxy.get("password") or "") else "")
    auth = ""
    if username:
        auth = username if not password else f"{username}:{password}"
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
        return int(datetime.fromisoformat(text).timestamp())
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
