import base64
import hashlib
import hmac
import os
import secrets
import time
from typing import Any

from fastapi import Cookie, Depends, HTTPException

from .db import db

SESSION_COOKIE = "session_token"

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

def create_session(conn, user_id: int, *, ttl_seconds: int = 14 * 24 * 3600) -> str:
    token = secrets.token_urlsafe(32)
    now_ts = _now()
    expires_at = now_ts + int(ttl_seconds)
    conn.execute(
        "INSERT INTO sessions(token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (token, int(user_id), int(expires_at), int(now_ts)),
    )
    return token

def delete_session(conn, token: str) -> None:
    conn.execute("DELETE FROM sessions WHERE token = ?", (str(token),))

def _get_user_by_id(conn, user_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
    if row is None:
        return None
    return dict(row)

def get_user_allowing_password_change(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    token = str(session_token or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    now_ts = _now()
    with db() as conn:
        row = conn.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token = ?",
            (token,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="登录已过期")
        if int(row["expires_at"]) <= now_ts:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            raise HTTPException(status_code=401, detail="登录已过期")
        user = _get_user_by_id(conn, int(row["user_id"]))
        if user is None:
            raise HTTPException(status_code=401, detail="登录已失效")
        if int(user.get("is_disabled") or 0) == 1:
            raise HTTPException(status_code=403, detail="账号已禁用")
        return user

def get_current_user(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    user = get_user_allowing_password_change(session_token)
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
    return user


def require_admin(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if int(user.get("is_admin") or 0) != 1:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
