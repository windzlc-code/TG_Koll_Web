import base64
import hashlib
import hmac
import os
import secrets
import time
from typing import Any

from fastapi import Cookie, Depends, Header, HTTPException, Request

from .db import db
from .governance import token_digest

SESSION_COOKIE = "session_token"
ADMIN_SESSION_COOKIE = "admin_session_token"
ADMIN_WORKSPACE_HEADER = "X-Admin-Workspace-User-ID"
ADMIN_WORKSPACE_QUERY = "admin_workspace_user_id"
ADMIN_CONSOLE_HEADER = "X-Admin-Console"
ADMIN_CONSOLE_QUERY = "admin_console"


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def request_uses_admin_session(request: Request, admin_workspace_user_id: Any = None) -> bool:
    path = str(request.url.path or "")
    workspace_target = str(admin_workspace_user_id or "").strip()
    return bool(
        workspace_target
        or path.startswith("/api/admin/")
        or _truthy(request.headers.get(ADMIN_CONSOLE_HEADER))
        or _truthy(request.query_params.get(ADMIN_CONSOLE_QUERY))
    )


def session_token_for_request(
    request: Request,
    session_token: str | None,
    admin_session_token: str | None,
    *,
    admin_workspace_user_id: Any = None,
) -> str | None:
    # An explicitly selected admin console must never fall back to the regular
    # user cookie.  Both sessions can coexist in one browser; after the admin
    # session is logged out, the admin surface must be unauthorized rather
    # than silently becoming the regular-user session.
    if _truthy(request.headers.get(ADMIN_CONSOLE_HEADER)) or _truthy(request.query_params.get(ADMIN_CONSOLE_QUERY)):
        return str(admin_session_token or "").strip() or None
    if request_uses_admin_session(request, admin_workspace_user_id):
        return str(admin_session_token or "").strip() or None
    return str(session_token or "").strip() or None

def _now() -> int:
    return int(time.time())

def _pbkdf2_hash(password: str, *, salt: bytes, iterations: int = 200_000) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    return base64.b64encode(dk).decode("utf-8")

def hash_password(password: str) -> str:
    pwd = str(password or "")
    if len(pwd) < 6:
        raise ValueError("密码至少 6 位")
    salt = secrets.token_bytes(16)
    iterations = 200_000
    digest = _pbkdf2_hash(pwd, salt=salt, iterations=iterations)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode('utf-8')}${digest}"

def verify_password(password: str, stored: str) -> bool:
    try:
        algo, it_text, salt_b64, digest_b64 = str(stored or "").split("$", 3)
    except Exception:
        return False
    if algo != "pbkdf2_sha256":
        return False
    try:
        iterations = int(it_text)
        salt = base64.b64decode(salt_b64.encode("utf-8"))
    except Exception:
        return False
    computed = _pbkdf2_hash(str(password or ""), salt=salt, iterations=iterations)
    return hmac.compare_digest(computed, digest_b64)

def session_storage_token(token: str | None) -> str:
    return token_digest(str(token or ""))


def create_session(
    conn,
    user_id: int,
    *,
    ttl_seconds: int = 14 * 24 * 3600,
    request: Request | None = None,
    is_admin_session: bool = False,
    device_id: str = "",
) -> str:
    token = secrets.token_urlsafe(32)
    now_ts = _now()
    expires_at = now_ts + int(ttl_seconds)
    ip_address = str(request.client.host if request is not None and request.client else "")[:64]
    user_agent = str(request.headers.get("user-agent") if request is not None else "")[:500]
    clean_device_id = str(device_id or (request.headers.get("x-device-id") if request is not None else "") or "")[:128]
    conn.execute(
        """
        INSERT INTO sessions(
          token, user_id, expires_at, created_at, device_id, ip_address,
          user_agent, last_seen_at, revoked_at, revoke_reason, is_admin_session
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?)
        """,
        (
            session_storage_token(token), int(user_id), int(expires_at), int(now_ts),
            clean_device_id, ip_address, user_agent, int(now_ts), 1 if is_admin_session else 0,
        ),
    )
    return token

def delete_session(conn, token: str, *, reason: str = "logout") -> None:
    conn.execute(
        "UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE token = ?",
        (_now(), str(reason or "revoked")[:160], session_storage_token(token)),
    )

def _get_user_by_id(conn, user_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
    if row is None:
        return None
    return dict(row)

def get_user_allowing_password_change(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    *,
    expected_admin_session: bool | None = None,
) -> dict[str, Any]:
    token = str(session_token or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    now_ts = _now()
    with db() as conn:
        stored_token = session_storage_token(token)
        row = conn.execute(
            "SELECT user_id, expires_at, revoked_at, is_admin_session FROM sessions WHERE token = ?",
            (stored_token,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="登录已过期")
        if int(row["expires_at"]) <= now_ts or int(row["revoked_at"] or 0) > 0:
            conn.execute("DELETE FROM sessions WHERE token = ?", (stored_token,))
            raise HTTPException(status_code=401, detail="登录已过期")
        if (
            expected_admin_session is not None
            and bool(int(row["is_admin_session"] or 0)) is not bool(expected_admin_session)
        ):
            raise HTTPException(status_code=401, detail="登录已过期")
        conn.execute(
            "UPDATE sessions SET last_seen_at = ? WHERE token = ? AND last_seen_at < ?",
            (now_ts, stored_token, now_ts - 30),
        )
        user = _get_user_by_id(conn, int(row["user_id"]))
        if user is None:
            raise HTTPException(status_code=401, detail="登录已失效")
        if int(user.get("is_disabled") or 0) == 1:
            raise HTTPException(status_code=403, detail="账号已禁用")
        return user


def resolve_admin_workspace_user(
    user: dict[str, Any],
    target_user_id: Any = None,
    *,
    request: Request | None = None,
) -> dict[str, Any]:
    if not isinstance(target_user_id, (str, int)):
        return user
    clean_target = str(target_user_id or "").strip()
    if not clean_target:
        return user
    if int(user.get("is_admin") or 0) != 1:
        raise HTTPException(status_code=403, detail="administrator workspace access required")
    try:
        target_id = int(clean_target)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid admin workspace user id") from exc
    if target_id <= 0:
        raise HTTPException(status_code=400, detail="invalid admin workspace user id")
    with db() as conn:
        row = conn.execute(
            "SELECT id, username, is_admin, is_disabled, approval_status, deleted_at FROM users WHERE id = ?",
            (target_id,),
        ).fetchone()
    if row is None or int(row["is_admin"] or 0) == 1:
        raise HTTPException(status_code=404, detail="customer workspace not found")
    resolved = dict(user)
    resolved["_workspace_user_id"] = target_id
    resolved["_workspace_username"] = str(row["username"] or "")
    resolved["_workspace_is_disabled"] = int(row["is_disabled"] or 0)
    resolved["_workspace_approval_status"] = str(row["approval_status"] or "")
    resolved["_workspace_deleted_at"] = int(row["deleted_at"] or 0)
    resolved["_workspace_admin_user_id"] = int(user.get("id") or 0)
    if request is not None:
        request.state.admin_workspace_context = {
            "admin_user_id": int(user.get("id") or 0),
            "target_user_id": target_id,
        }
    return resolved


def admin_workspace_target_from_request(
    request: Request,
    header_value: Any = None,
) -> Any:
    header_target = str(header_value or "").strip()
    query_target = str(request.query_params.get(ADMIN_WORKSPACE_QUERY) or "").strip()
    if header_target and query_target and header_target != query_target:
        raise HTTPException(status_code=400, detail="conflicting admin workspace user ids")
    return header_target or query_target

def get_current_user_for_session(
    session_token: str | None,
    *,
    expected_admin_session: bool | None = None,
    admin_workspace_user_id: Any = None,
    request: Request | None = None,
) -> dict[str, Any]:
    if expected_admin_session is None and request is not None:
        clean_token = str(session_token or "").strip()
        regular_cookie = str(request.cookies.get(SESSION_COOKIE) or "").strip()
        admin_cookie = str(request.cookies.get(ADMIN_SESSION_COOKIE) or "").strip()
        if clean_token and clean_token == admin_cookie and clean_token != regular_cookie:
            expected_admin_session = True
        elif clean_token and clean_token == regular_cookie and clean_token != admin_cookie:
            expected_admin_session = False
        elif clean_token and clean_token == regular_cookie and clean_token == admin_cookie:
            expected_admin_session = request_uses_admin_session(
                request,
                admin_workspace_user_id,
            )
    user = get_user_allowing_password_change(
        session_token,
        expected_admin_session=expected_admin_session,
    )
    if int(user.get("must_change_password") or 0) == 1:
        try:
            expires_at = int(user.get("password_expires_at") or 0)
        except (TypeError, ValueError):
            expires_at = 0
        code = "temporary_password_expired" if expires_at <= _now() else "password_change_required"
        if code == "temporary_password_expired" and session_token:
            with db() as conn:
                delete_session(conn, str(session_token))
        raise HTTPException(
            status_code=428,
            detail={
                "code": code,
                "message": "temporary password expired" if code == "temporary_password_expired" else "password change required",
                "password_expires_at": expires_at,
            },
        )
    if request is not None and int(user.get("is_admin") or 0) == 1:
        allowed_paths = {
            "/api/me",
            "/api/auth/me",
            "/api/auth/mfa",
            "/api/auth/mfa/setup",
            "/api/auth/mfa/verify-setup",
            "/api/auth/logout",
        }
        with db() as conn:
            mfa = conn.execute(
                "SELECT enabled_at, required_after FROM user_mfa WHERE user_id = ?",
                (int(user.get("id") or 0),),
            ).fetchone()
        if (
            mfa is not None
            and int(mfa["required_after"] or 0) > 0
            and int(mfa["required_after"] or 0) <= _now()
            and int(mfa["enabled_at"] or 0) <= 0
            and str(request.url.path or "") not in allowed_paths
        ):
            raise HTTPException(
                status_code=428,
                detail={"code": "mfa_setup_required", "message": "administrator MFA enrollment is required"},
            )
    return resolve_admin_workspace_user(user, admin_workspace_user_id, request=request)


def get_current_user(
    request: Request,
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    admin_session_token: str | None = Cookie(default=None, alias=ADMIN_SESSION_COOKIE),
    admin_workspace_user_id: str | None = Header(default=None, alias=ADMIN_WORKSPACE_HEADER),
) -> dict[str, Any]:
    workspace_target = admin_workspace_target_from_request(request, admin_workspace_user_id)
    uses_admin_session = request_uses_admin_session(request, workspace_target)
    return get_current_user_for_session(
        session_token_for_request(
            request,
            session_token,
            admin_session_token,
            admin_workspace_user_id=workspace_target,
        ),
        expected_admin_session=uses_admin_session,
        admin_workspace_user_id=workspace_target,
        request=request,
    )


def require_admin(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if int(user.get("is_admin") or 0) != 1:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
