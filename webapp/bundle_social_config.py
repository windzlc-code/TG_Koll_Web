from __future__ import annotations

import hashlib
import ipaddress
import os
import sqlite3
import time
from typing import Any
from urllib.parse import urlparse, urlunparse

from .password_vault import PasswordVaultError, decrypt_secret, encrypt_secret


DEFAULT_API_BASE_URL = "https://api.bundle.social/api/v1"
API_KEY_ENV = "BUNDLE_SOCIAL_API_KEY"
API_BASE_ENV = "BUNDLE_SOCIAL_API_BASE"
_API_KEY_PURPOSE = "social-provider:bundle-social:api-key"


class BundleSocialConfigError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _now() -> int:
    return int(time.time())


def _row(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM bundle_social_provider_config WHERE id = 1").fetchone()


def _is_local_hostname(hostname: str) -> bool:
    host = str(hostname or "").strip().strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_api_base_url(value: Any) -> str:
    text = str(value or "").strip().rstrip("/")
    if not text:
        return DEFAULT_API_BASE_URL
    if len(text) > 500:
        raise BundleSocialConfigError("BUNDLE_API_URL_INVALID", "API Base URL 长度无效", 422)
    parsed = urlparse(text)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BundleSocialConfigError("BUNDLE_API_URL_INVALID", "API Base URL 格式无效", 422)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and _is_local_hostname(parsed.hostname)):
        raise BundleSocialConfigError(
            "BUNDLE_API_URL_INSECURE",
            "API Base URL 必须使用 HTTPS；本机开发地址可使用 HTTP",
            422,
        )
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "", ""))


def _decrypt_api_key(row: sqlite3.Row) -> str:
    owner_user_id = int(row["owner_user_id"] or 0)
    if owner_user_id <= 0:
        raise BundleSocialConfigError("BUNDLE_CONFIG_OWNER_INVALID", "平台授权配置所有者无效", 409)
    try:
        return decrypt_secret(owner_user_id, _API_KEY_PURPOSE, str(row["api_key_ciphertext"] or ""))
    except PasswordVaultError as exc:
        raise BundleSocialConfigError(
            "BUNDLE_CONFIG_VAULT_UNAVAILABLE",
            "平台授权密钥暂时无法解密，请检查服务器密钥库",
            503,
        ) from exc


def resolve_configuration(conn: sqlite3.Connection) -> dict[str, Any]:
    row = _row(conn)
    if row is not None and str(row["api_key_ciphertext"] or ""):
        return {
            "api_base_url": normalize_api_base_url(row["api_base_url"]),
            "api_key": _decrypt_api_key(row),
            "source": "system_config",
            "verified_at": int(row["verified_at"] or 0),
        }
    return {
        "api_base_url": normalize_api_base_url(os.getenv(API_BASE_ENV) or DEFAULT_API_BASE_URL),
        "api_key": str(os.getenv(API_KEY_ENV) or "").strip(),
        "source": "environment" if str(os.getenv(API_KEY_ENV) or "").strip() else "unconfigured",
        "verified_at": 0,
    }


def configuration_status(conn: sqlite3.Connection) -> dict[str, Any]:
    row = _row(conn)
    if row is not None:
        return {
            "configured": bool(str(row["api_key_ciphertext"] or "")),
            "api_key_configured": bool(str(row["api_key_ciphertext"] or "")),
            "api_base_url": normalize_api_base_url(row["api_base_url"]),
            "source": "system_config",
            "verified": int(row["verified_at"] or 0) > 0,
            "verified_at": int(row["verified_at"] or 0),
            "last_checked_at": int(row["last_checked_at"] or 0),
            "last_error": str(row["last_error"] or ""),
            "updated_at": int(row["updated_at"] or 0),
            "api_key_fingerprint": str(row["api_key_fingerprint"] or ""),
        }
    env_key = str(os.getenv(API_KEY_ENV) or "").strip()
    return {
        "configured": bool(env_key),
        "api_key_configured": bool(env_key),
        "api_base_url": normalize_api_base_url(os.getenv(API_BASE_ENV) or DEFAULT_API_BASE_URL),
        "source": "environment" if env_key else "unconfigured",
        "verified": False,
        "verified_at": 0,
        "last_checked_at": 0,
        "last_error": "",
        "updated_at": 0,
        "api_key_fingerprint": hashlib.sha256(env_key.encode("utf-8")).hexdigest()[:12] if env_key else "",
    }


def candidate_configuration(
    conn: sqlite3.Connection,
    *,
    api_base_url: str,
    api_key: str,
) -> dict[str, str]:
    current = resolve_configuration(conn)
    clean_key = str(api_key or "").strip() or str(current.get("api_key") or "").strip()
    if not clean_key or len(clean_key) > 512:
        raise BundleSocialConfigError("BUNDLE_API_KEY_REQUIRED", "请填写有效的 API Key", 422)
    return {
        "api_base_url": normalize_api_base_url(api_base_url or current.get("api_base_url")),
        "api_key": clean_key,
    }


def save_configuration(
    conn: sqlite3.Connection,
    *,
    api_base_url: str,
    api_key: str,
    actor_user_id: int,
    verified_at: int | None = None,
) -> dict[str, Any]:
    owner_user_id = int(actor_user_id or 0)
    if owner_user_id <= 0:
        raise BundleSocialConfigError("BUNDLE_CONFIG_OWNER_INVALID", "管理员身份无效，配置未保存", 401)
    clean_base = normalize_api_base_url(api_base_url)
    clean_key = str(api_key or "").strip()
    if not clean_key or len(clean_key) > 512:
        raise BundleSocialConfigError("BUNDLE_API_KEY_REQUIRED", "请填写有效的 API Key", 422)
    try:
        ciphertext = encrypt_secret(owner_user_id, _API_KEY_PURPOSE, clean_key)
    except PasswordVaultError as exc:
        raise BundleSocialConfigError(
            "BUNDLE_CONFIG_VAULT_UNAVAILABLE",
            "服务器密钥库不可用，平台授权配置未保存",
            503,
        ) from exc
    current = _now()
    checked_at = int(verified_at or current)
    conn.execute(
        """
        INSERT INTO bundle_social_provider_config(
          id,owner_user_id,api_base_url,api_key_ciphertext,
          api_key_fingerprint,verified_at,last_checked_at,last_error,
          created_at,updated_at,updated_by
        ) VALUES (1,?,?,?,?,?,?,'',?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          owner_user_id=excluded.owner_user_id,
          api_base_url=excluded.api_base_url,
          api_key_ciphertext=excluded.api_key_ciphertext,
          api_key_fingerprint=excluded.api_key_fingerprint,
          verified_at=excluded.verified_at,
          last_checked_at=excluded.last_checked_at,
          last_error='',
          updated_at=excluded.updated_at,
          updated_by=excluded.updated_by
        """,
        (
            owner_user_id,
            clean_base,
            ciphertext,
            hashlib.sha256(clean_key.encode("utf-8")).hexdigest()[:12],
            checked_at,
            checked_at,
            current,
            current,
            owner_user_id,
        ),
    )
    return configuration_status(conn)
