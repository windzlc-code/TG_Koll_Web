from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

import requests
from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .auth import require_admin
from .db import db

COLLECTOR_LOGIN_PLATFORMS = {"threads", "instagram"}
OAUTH_PROVIDERS = {"bundle", "oauth", "threads_oauth", "instagram_oauth", "meta"}


def _now() -> int:
    return int(time.time())


def _account_row(account_id: str) -> dict[str, Any]:
    clean_id = str(account_id or "").strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="账号 ID 无效")
    with db() as conn:
        row = conn.execute("SELECT * FROM social_accounts WHERE id = ?", (clean_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    return dict(row)


def _admin_user_ids(conn) -> set[int]:
    try:
        rows = conn.execute("SELECT id FROM users WHERE IFNULL(is_admin,0)=1 AND IFNULL(is_disabled,0)=0").fetchall()
    except Exception:
        return set()
    return {int(item["id"] or 0) for item in rows if int(item["id"] or 0) > 0}


def _owner_map(user_ids: list[int]) -> dict[int, str]:
    ids = sorted({int(item) for item in user_ids if int(item or 0) > 0})
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    labels: dict[int, str] = {}
    with db() as conn:
        tables = {
            str(item[0])
            for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        if "users" not in tables:
            return {}
        columns = {str(item[1]) for item in conn.execute("PRAGMA table_info(users)").fetchall()}
        name_col = "email" if "email" in columns else ("username" if "username" in columns else "")
        extra = ", username" if name_col == "email" and "username" in columns else ""
        query = f"SELECT id{', ' + name_col if name_col else ''}{extra} FROM users WHERE id IN ({placeholders})"
        for row in conn.execute(query, ids):
            item = dict(row)
            label = str(item.get(name_col) or item.get("username") or "").strip()
            labels[int(item["id"])] = label or f"用户 {item['id']}"
    return labels


def _proxy_map(conn, proxy_ids: list[str]) -> dict[str, dict[str, Any]]:
    ids = [str(item or "").strip() for item in proxy_ids if str(item or "").strip()]
    if not ids:
        return {}
    tables = {str(item[0]) for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "social_proxies" not in tables:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(f"SELECT * FROM social_proxies WHERE id IN ({placeholders})", ids).fetchall()
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = dict(row)
        host = str(item.get("host") or "").strip()
        port = int(item.get("port") or 0)
        exit_ip = ""
        expires_at = 0
        raw = item.get("last_check_result")
        parsed: dict[str, Any] = {}
        if isinstance(raw, dict):
            parsed = raw
        elif isinstance(raw, str) and raw.strip():
            try:
                loaded = json.loads(raw)
                if isinstance(loaded, dict):
                    parsed = loaded
            except Exception:
                parsed = {}
        exit_ip = str(parsed.get("exit_ip") or "").strip()
        try:
            expires_at = int(parsed.get("session_expires_at") or 0)
        except Exception:
            expires_at = 0
        label = exit_ip or host or str(item.get("name") or item.get("id") or "")
        result[str(item.get("id") or "")] = {
            "id": str(item.get("id") or ""),
            "label": label,
            "host": host,
            "port": port,
            "exit_ip": exit_ip,
            "source": str(item.get("source") or ""),
            "expires_at": expires_at,
            "ip_type": str(item.get("ip_type") or item.get("proxy_type") or ""),
            "region": str(item.get("region") or item.get("country") or ""),
        }
    return result


def _totp_map(conn) -> dict[str, str]:
    tables = {str(item[0]) for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "social_account_totp_secrets" not in tables:
        return {}
    columns = {str(item[1]) for item in conn.execute("PRAGMA table_info(social_account_totp_secrets)").fetchall()}
    status_col = "status" if "status" in columns else ""
    query = "SELECT account_id" + (f", {status_col}" if status_col else "") + " FROM social_account_totp_secrets"
    result: dict[str, str] = {}
    for item in conn.execute(query).fetchall():
        row = dict(item)
        account_id = str(row.get("account_id") or "").strip()
        if account_id:
            result[account_id] = str(row.get("status") or "verified").strip().lower() or "verified"
    return result


def _is_collector_login_account(row: dict[str, Any], admin_ids: set[int]) -> bool:
    platform = str(row.get("platform") or "").strip().lower()
    if platform not in COLLECTOR_LOGIN_PLATFORMS:
        return False
    if int(row.get("user_id") or 0) not in admin_ids:
        return False
    provider = str(row.get("auth_provider") or "browser").strip().lower() or "browser"
    if provider in OAUTH_PROVIDERS:
        return False
    return True


def _require_collector_login_account(account_id: str) -> dict[str, Any]:
    account = _account_row(account_id)
    with db() as conn:
        admin_ids = _admin_user_ids(conn)
    if not _is_collector_login_account(account, admin_ids):
        raise HTTPException(status_code=409, detail="该账号不是采集登录账号，平台 API 授权号请走产品账号卡")
    return account


def _public_account(
    row: dict[str, Any],
    owners: dict[int, str],
    proxies: dict[str, dict[str, Any]],
    totp_map: dict[str, str],
    admin_ids: set[int],
) -> dict[str, Any]:
    user_id = int(row.get("user_id") or 0)
    password = str(row.get("login_password") or "").strip()
    proxy_id = str(row.get("proxy_id") or "").strip()
    proxy = proxies.get(proxy_id) or {}
    status = str(row.get("status") or "").strip().lower()
    totp_status = str(totp_map.get(str(row.get("id") or "")) or "").strip().lower()
    return {
        "id": str(row.get("id") or ""),
        "platform": str(row.get("platform") or "threads").strip().lower() or "threads",
        "username": str(row.get("username") or ""),
        "display_name": str(row.get("display_name") or ""),
        "login_username": str(row.get("login_username") or ""),
        "status": status,
        "health_status": str(row.get("health_status") or ""),
        "auth_provider": str(row.get("auth_provider") or "browser"),
        "persona_id": str(row.get("persona_id") or ""),
        "user_id": user_id,
        "is_admin_owned": user_id in admin_ids,
        "owner_label": owners.get(user_id) or (f"用户 {user_id}" if user_id else "未归属"),
        "login_password_configured": bool(password),
        "totp_configured": bool(totp_status),
        "totp_status": totp_status or "",
        "proxy_id": proxy_id,
        "proxy_label": str(proxy.get("label") or ""),
        "proxy_host": str(proxy.get("host") or ""),
        "proxy_exit_ip": str(proxy.get("exit_ip") or ""),
        "proxy_source": str(proxy.get("source") or ""),
        "proxy_expires_at": int(proxy.get("expires_at") or 0),
        "last_login_check_at": int(row.get("last_login_check_at") or 0),
        "last_error": str(row.get("last_error") or ""),
        "updated_at": int(row.get("updated_at") or 0),
    }


def _upsert_totp(conn, account_id: str, secret: str, now: int) -> None:
    tables = {str(item[0]) for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "social_account_totp_secrets" not in tables:
        return
    columns = {str(item[1]) for item in conn.execute("PRAGMA table_info(social_account_totp_secrets)").fetchall()}
    secret_col = "secret" if "secret" in columns else ("totp_secret" if "totp_secret" in columns else "")
    if not secret_col or "account_id" not in columns:
        return
    assignments = [f"{secret_col}=?"]
    values: list[Any] = [secret]
    if "updated_at" in columns:
        assignments.append("updated_at=?")
        values.append(now)
    exists = conn.execute(
        "SELECT account_id FROM social_account_totp_secrets WHERE account_id=?",
        (account_id,),
    ).fetchone()
    if exists:
        values.append(account_id)
        conn.execute(
            f"UPDATE social_account_totp_secrets SET {', '.join(assignments)} WHERE account_id=?",
            values,
        )
        return
    insert_cols = ["account_id", secret_col]
    insert_vals: list[Any] = [account_id, secret]
    if "updated_at" in columns:
        insert_cols.append("updated_at")
        insert_vals.append(now)
    if "created_at" in columns:
        insert_cols.append("created_at")
        insert_vals.append(now)
    placeholders = ",".join("?" for _ in insert_cols)
    conn.execute(
        f"INSERT INTO social_account_totp_secrets({', '.join(insert_cols)}) VALUES ({placeholders})",
        insert_vals,
    )


def _signed_worker(method: str, path: str, body: bytes = b"") -> dict[str, Any]:
    from .remote_fetch_protocol import signed_headers

    keys_path = Path(os.getenv("TG_FETCH_WORKER_KEYS_FILE", "/data/internal/remote-fetch-keys.json"))
    keys = json.loads(keys_path.read_text(encoding="utf-8"))
    key_id = sorted(keys)[0]
    secret = str(keys[key_id])
    headers = signed_headers(
        secret=secret,
        key_id=key_id,
        method=method,
        path=path,
        body=body,
        timestamp=_now(),
        nonce=secrets.token_urlsafe(24),
    )
    base = str(os.getenv("TG_FETCH_WORKER_INTERNAL_URL") or "http://tg-koll-capture-worker:8092").rstrip("/")
    response = requests.request(method, base + path, headers=headers, data=body or None, timeout=20)
    if response.status_code >= 400:
        detail = "采集代理分配失败"
        try:
            payload = response.json()
            if isinstance(payload, dict) and payload.get("detail"):
                detail = str(payload.get("detail"))
        except Exception:
            detail = response.text[:200] or detail
        raise HTTPException(status_code=response.status_code if response.status_code in {400, 404, 409, 422} else 502, detail=detail)
    payload = response.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="采集代理返回无效")
    return payload


def register_fingerprint_login_admin_routes(app: FastAPI) -> None:
    from .social_automation_api import close_live_browser_session, create_account_task, _live_browser_sessions

    @app.get("/api/admin/fingerprint-login/accounts")
    def api_admin_fingerprint_login_accounts(_admin: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            rows = [dict(item) for item in conn.execute(
                "SELECT * FROM social_accounts ORDER BY updated_at DESC, id DESC"
            ).fetchall()]
            admin_ids = _admin_user_ids(conn)
            rows = [item for item in rows if _is_collector_login_account(item, admin_ids)]
            totp_map = _totp_map(conn)
            proxies = _proxy_map(conn, [str(item.get("proxy_id") or "") for item in rows])
        owners = _owner_map([int(item.get("user_id") or 0) for item in rows])
        return {
            "ok": True,
            "admin_user_ids": sorted(admin_ids),
            "accounts": [_public_account(item, owners, proxies, totp_map, admin_ids) for item in rows],
        }

    def _start_account_task(account_id: str, task_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        account = _require_collector_login_account(account_id)
        if str(account.get("auth_provider") or "browser").strip().lower() in OAUTH_PROVIDERS:
            raise HTTPException(status_code=409, detail="该账号使用平台授权，请从账号卡重新授权")
        body = payload if isinstance(payload, dict) else {}
        task_payload = body.get("payload") if isinstance(body.get("payload"), dict) else body
        task_payload = dict(task_payload or {})
        task_payload["auto_submit"] = True
        task_payload.setdefault("login_wait_seconds", 3600)
        return {
            "ok": True,
            "task": create_account_task(
                str(account["id"]),
                task_type,
                task_payload,
                billing_admin_waived=True,
            ),
        }

    @app.post("/api/admin/fingerprint-login/accounts/{account_id}/open_login")
    def api_admin_fingerprint_open_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        return _start_account_task(account_id, "open_login", payload)

    @app.post("/api/admin/fingerprint-login/accounts/{account_id}/check_login")
    def api_admin_fingerprint_check_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        return _start_account_task(account_id, "check_login", payload)

    @app.post("/api/admin/fingerprint-login/accounts/{account_id}/sticky-proxy")
    def api_admin_fingerprint_sticky_proxy(
        account_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        account = _require_collector_login_account(account_id)
        body = json.dumps({"account_id": str(account["id"])}).encode("utf-8")
        payload = _signed_worker("POST", "/internal/worker/v1/account-proxy/allocate", body)
        proxy = payload.get("proxy") if isinstance(payload.get("proxy"), dict) else {}
        server = str(proxy.get("server") or "").strip()
        rest = server.split("://", 1)[-1]
        host = rest.rsplit(":", 1)[0].strip() if ":" in rest else rest.strip()
        try:
            port = int(rest.rsplit(":", 1)[-1]) if ":" in rest else 0
        except Exception:
            port = 0
        product_id = str(proxy.get("product_id") or "").strip()
        owner_id = int(account.get("user_id") or 0) or 1
        now = _now()
        existing_id = str(account.get("proxy_id") or "").strip()
        host_value = host or str(proxy.get("exit_ip") or "")
        port_value = port or 8080
        username = str(proxy.get("username") or "")
        password = str(proxy.get("password") or "")
        note = f"collector-sticky:{product_id}"
        exit_ip = str(proxy.get("exit_ip") or "").strip()
        check_json = json.dumps(
            {
                "ok": True,
                "checked_at": now,
                "exit_ip": exit_ip,
                "session_expires_at": int(proxy.get("expires_at") or 0),
                "source": "collector_sticky",
            },
            ensure_ascii=False,
        )
        try:
            with db() as conn:
                owned = None
                if existing_id:
                    owned = conn.execute(
                        "SELECT id FROM social_proxies WHERE id=? AND user_id=?",
                        (existing_id, owner_id),
                    ).fetchone()
                if owned:
                    proxy_id = existing_id
                    conn.execute(
                        "UPDATE social_proxies SET host=?, port=?, username=?, password=?, ip_type=?, note=?, updated_at=?, status=?, source=?, last_check_result=? WHERE id=?",
                        (
                            host_value, port_value, username, password,
                            "residential", note, now, "active", "collector_sticky", check_json, proxy_id,
                        ),
                    )
                else:
                    proxy_id = f"social_proxy_{uuid.uuid4().hex}"
                    conn.execute(
                        "INSERT INTO social_proxies(id, name, proxy_type, host, port, username, password, ip_type, status, source, note, created_at, updated_at, user_id, last_check_result) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            proxy_id, f"采集粘性 {product_id or host_value}", "http",
                            host_value, port_value, username, password,
                            "residential", "active", "collector_sticky", note, now, now, owner_id, check_json,
                        ),
                    )
                conn.execute(
                    "UPDATE social_accounts SET proxy_id=?, updated_at=? WHERE id=?",
                    (proxy_id, now, str(account["id"])),
                )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail=f"粘性代理绑定失败：{exc}") from exc
        return {
            "ok": True,
            "proxy_id": proxy_id,
            "exit_ip": str(proxy.get("exit_ip") or host_value or ""),
            "product_id": product_id,
            "proxy": proxy,
        }

    @app.post("/api/admin/fingerprint-login/accounts")
    def api_admin_fingerprint_create_account(
        payload: dict[str, Any] | None = Body(default=None),
        admin: dict[str, Any] = Depends(require_admin),
    ):
        body = payload if isinstance(payload, dict) else {}
        platform = str(body.get("platform") or "threads").strip().lower()
        if platform not in {"threads", "instagram"}:
            raise HTTPException(status_code=400, detail="平台只支持 Threads 或 Instagram")
        username = str(body.get("username") or "").strip()
        if not username:
            raise HTTPException(status_code=400, detail="请填写账号")
        login_username = str(body.get("login_username") or username).strip()
        login_password = str(body.get("login_password") or "").strip()
        totp_secret = str(body.get("totp_secret") or "").strip()
        account_id = "social_account_" + uuid.uuid4().hex[:16]
        now = _now()
        admin_id = int(admin.get("id") or 1)
        with db() as conn:
            exists = conn.execute(
                "SELECT id FROM social_accounts WHERE platform=? AND username=? LIMIT 1",
                (platform, username),
            ).fetchone()
            if exists:
                raise HTTPException(status_code=409, detail="该平台账号已存在")
            conn.execute(
                """
                INSERT INTO social_accounts(
                    id, persona_id, platform, username, display_name, profile_dir, proxy_id, status,
                    last_login_check_at, last_run_at, last_error, created_at, updated_at,
                    login_username, login_password, login_credentials_updated_at, user_id
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    account_id, "", platform, username, "", "", "", "pending_login",
                    0, 0, "", now, now, login_username, login_password, now if login_password else 0, admin_id,
                ),
            )
            if totp_secret:
                _upsert_totp(conn, account_id, totp_secret, now)
        return {"ok": True, "id": account_id}

    @app.patch("/api/admin/fingerprint-login/accounts/{account_id}")
    def api_admin_fingerprint_patch_account(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        account = _require_collector_login_account(account_id)
        body = payload if isinstance(payload, dict) else {}
        updates: list[str] = []
        values: list[Any] = []
        if "username" in body:
            updates.append("username=?")
            values.append(str(body.get("username") or "").strip())
        if "login_username" in body:
            updates.append("login_username=?")
            values.append(str(body.get("login_username") or "").strip())
        if "login_password" in body and str(body.get("login_password") or "").strip():
            updates.append("login_password=?")
            values.append(str(body.get("login_password") or "").strip())
            updates.append("login_credentials_updated_at=?")
            values.append(_now())
        if "display_name" in body:
            updates.append("display_name=?")
            values.append(str(body.get("display_name") or "").strip())
        if not updates:
            return {"ok": True, "id": account_id}
        updates.append("updated_at=?")
        values.append(_now())
        values.append(str(account["id"]))
        with db() as conn:
            conn.execute(f"UPDATE social_accounts SET {', '.join(updates)} WHERE id=?", values)
            totp_secret = str(body.get("totp_secret") or "").strip()
            if totp_secret:
                _upsert_totp(conn, str(account["id"]), totp_secret, _now())
        return {"ok": True, "id": account_id}

    @app.delete("/api/admin/fingerprint-login/accounts/{account_id}")
    def api_admin_fingerprint_delete_account(
        account_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        account = _require_collector_login_account(account_id)
        try:
            with db() as conn:
                conn.execute("DELETE FROM social_accounts WHERE id=?", (str(account["id"]),))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="该账号仍有任务记录，无法删除") from exc
        return {"ok": True, "deleted": True}

    @app.post("/api/admin/fingerprint-login/accounts/{account_id}/proxy")
    def api_admin_fingerprint_set_proxy(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        choice = str((payload or {}).get("choice") or "none").strip().lower()
        if choice == "sticky":
            return api_admin_fingerprint_sticky_proxy(account_id, _admin)
        account = _require_collector_login_account(account_id)
        with db() as conn:
            conn.execute(
                "UPDATE social_accounts SET proxy_id=?, updated_at=? WHERE id=?",
                ("", _now(), str(account["id"])),
            )
        return {"ok": True, "choice": "none", "proxy_id": ""}

    @app.get("/api/admin/fingerprint-login/accounts/{account_id}/credentials")
    def api_admin_fingerprint_credentials(
        account_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        account = _require_collector_login_account(account_id)
        return {
            "ok": True,
            "username": str(account.get("username") or ""),
            "login_username": str(account.get("login_username") or ""),
            "login_password": str(account.get("login_password") or ""),
        }

    @app.get("/api/admin/fingerprint-login/accounts/{account_id}/totp/code")
    def api_admin_fingerprint_totp_code(
        account_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        from .social_automation_api import (
            _social_account_totp_code_payload,
            _social_account_totp_public,
            _social_account_totp_row,
        )
        account = _require_collector_login_account(account_id)
        with db() as conn:
            row = _social_account_totp_row(conn, str(account["id"]))
        if row is None:
            raise HTTPException(status_code=404, detail="该账号尚未配置 2FA 密钥")
        try:
            current_code = _social_account_totp_code_payload(row)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        response = JSONResponse(
            content={"ok": True, "totp": _social_account_totp_public(row), "current_code": current_code},
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.put("/api/admin/fingerprint-login/accounts/{account_id}/totp")
    def api_admin_fingerprint_totp_set(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        from .social_automation_api import (
            _encrypt_social_account_totp_for_account,
            _social_account_totp_code_payload,
            _social_account_totp_public,
            _social_account_totp_row,
            _write_social_account_totp,
        )
        account = _require_collector_login_account(account_id)
        secret = str((payload or {}).get("secret_or_uri") or (payload or {}).get("totp_secret") or "").strip()
        if not secret:
            raise HTTPException(status_code=400, detail="请填写 2FA 密钥")
        clean_id = str(account["id"])
        owner_user_id = int(account.get("user_id") or 0)
        ciphertext = _encrypt_social_account_totp_for_account(clean_id, owner_user_id, secret)
        now = _now()
        with db() as conn:
            _write_social_account_totp(conn, account_id=clean_id, user_id=owner_user_id, ciphertext=ciphertext, now=now)
            row = _social_account_totp_row(conn, clean_id)
        return {"ok": True, "totp": _social_account_totp_public(row), "current_code": _social_account_totp_code_payload(row, at=now)}

    @app.delete("/api/admin/fingerprint-login/accounts/{account_id}/totp")
    def api_admin_fingerprint_totp_delete(
        account_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        from .social_automation_api import _social_account_totp_public
        account = _require_collector_login_account(account_id)
        with db() as conn:
            deleted = conn.execute(
                "DELETE FROM social_account_totp_secrets WHERE account_id=?",
                (str(account["id"]),),
            ).rowcount
        return {"ok": True, "deleted": int(deleted), "totp": _social_account_totp_public(None)}

    @app.get("/api/admin/fingerprint-login/sessions")
    def api_admin_fingerprint_sessions(_admin: dict[str, Any] = Depends(require_admin)):
        return {"ok": True, "sessions": _live_browser_sessions(user_id=None, raise_on_error=False)}

    @app.post("/api/admin/fingerprint-login/sessions/{session_id}/close")
    def api_admin_fingerprint_session_close(
        session_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        close_live_browser_session(str(session_id or "").strip(), force=True)
        return {"ok": True, "closed": True}
