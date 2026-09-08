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
_WEBHOOK_SECRET_PURPOSE = "social-provider:bundle-social:webhook-secret"
OFFICIAL_WEBHOOK_PATH = "/api/integrations/official-auth/webhook"
DEFAULT_HOMEPAGE_READ_INTERVAL_HOURS = 12
DEFAULT_COLLECT_OFFSET_HOURS = 12
MIN_HOMEPAGE_READ_INTERVAL_HOURS = 6
MAX_HOMEPAGE_READ_INTERVAL_HOURS = 24
MIN_COLLECT_OFFSET_HOURS = 8
MAX_COLLECT_OFFSET_HOURS = 18


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


def _decrypt_owned_secret(row: sqlite3.Row, purpose: str, ciphertext: str) -> str:
    owner_user_id = int(row["owner_user_id"] or 0)
    if owner_user_id <= 0:
        raise BundleSocialConfigError("BUNDLE_CONFIG_OWNER_INVALID", "平台授权配置所有者无效", 409)
    if not str(ciphertext or "").strip():
        return ""
    try:
        return decrypt_secret(owner_user_id, purpose, str(ciphertext or ""))
    except PasswordVaultError as exc:
        raise BundleSocialConfigError(
            "BUNDLE_CONFIG_VAULT_UNAVAILABLE",
            "平台授权密钥暂时无法解密，请检查服务器密钥库",
            503,
        ) from exc


def _decrypt_api_key(row: sqlite3.Row) -> str:
    return _decrypt_owned_secret(row, _API_KEY_PURPOSE, str(row["api_key_ciphertext"] or ""))


def _decrypt_webhook_secret(row: sqlite3.Row) -> str:
    return _decrypt_owned_secret(row, _WEBHOOK_SECRET_PURPOSE, str(row["webhook_secret_ciphertext"] or ""))


def _clamp_hours(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        hours = int(value)
    except (TypeError, ValueError):
        hours = default
    return max(minimum, min(maximum, hours))


def official_webhook_public_url() -> str:
    origin = str(os.getenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn") or "").strip().rstrip("/")
    return f"{origin}{OFFICIAL_WEBHOOK_PATH}"


def _sync_settings_from_row(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {
            "homepage_overlay_enabled": True,
            "allow_force_refresh": False,
            "homepage_read_interval_hours": DEFAULT_HOMEPAGE_READ_INTERVAL_HOURS,
            "collect_offset_hours": DEFAULT_COLLECT_OFFSET_HOURS,
            "webhook_secret_configured": False,
            "webhook_url": official_webhook_public_url(),
            "webhook_last_event_type": "",
            "webhook_last_event_at": 0,
            "webhook_last_error": "",
            "homepage_last_sync_at": 0,
            "homepage_last_sync_message": "",
        }
    keys = set(row.keys())
    return {
        "homepage_overlay_enabled": bool(int(row["homepage_overlay_enabled"] or 0)) if "homepage_overlay_enabled" in keys else True,
        "allow_force_refresh": False,
        "homepage_read_interval_hours": _clamp_hours(
            row["homepage_read_interval_hours"] if "homepage_read_interval_hours" in keys else DEFAULT_HOMEPAGE_READ_INTERVAL_HOURS,
            DEFAULT_HOMEPAGE_READ_INTERVAL_HOURS,
            MIN_HOMEPAGE_READ_INTERVAL_HOURS,
            MAX_HOMEPAGE_READ_INTERVAL_HOURS,
        ),
        "collect_offset_hours": _clamp_hours(
            row["collect_offset_hours"] if "collect_offset_hours" in keys else DEFAULT_COLLECT_OFFSET_HOURS,
            DEFAULT_COLLECT_OFFSET_HOURS,
            MIN_COLLECT_OFFSET_HOURS,
            MAX_COLLECT_OFFSET_HOURS,
        ),
        "webhook_secret_configured": bool(str(row["webhook_secret_ciphertext"] or "").strip()) if "webhook_secret_ciphertext" in keys else False,
        "webhook_url": official_webhook_public_url(),
        "webhook_last_event_type": str(row["webhook_last_event_type"] or "") if "webhook_last_event_type" in keys else "",
        "webhook_last_event_at": int(row["webhook_last_event_at"] or 0) if "webhook_last_event_at" in keys else 0,
        "webhook_last_error": str(row["webhook_last_error"] or "") if "webhook_last_error" in keys else "",
        "homepage_last_sync_at": int(row["homepage_last_sync_at"] or 0) if "homepage_last_sync_at" in keys else 0,
        "homepage_last_sync_message": str(row["homepage_last_sync_message"] or "") if "homepage_last_sync_message" in keys else "",
    }


def resolve_configuration(conn: sqlite3.Connection) -> dict[str, Any]:
    row = _row(conn)
    settings = _sync_settings_from_row(row)
    if row is not None and str(row["api_key_ciphertext"] or ""):
        return {
            "api_base_url": normalize_api_base_url(row["api_base_url"]),
            "api_key": _decrypt_api_key(row),
            "webhook_secret": _decrypt_webhook_secret(row),
            "source": "system_config",
            "verified_at": int(row["verified_at"] or 0),
            **settings,
        }
    return {
        "api_base_url": normalize_api_base_url(os.getenv(API_BASE_ENV) or DEFAULT_API_BASE_URL),
        "api_key": str(os.getenv(API_KEY_ENV) or "").strip(),
        "webhook_secret": "",
        "source": "environment" if str(os.getenv(API_KEY_ENV) or "").strip() else "unconfigured",
        "verified_at": 0,
        **settings,
    }


def configuration_status(conn: sqlite3.Connection) -> dict[str, Any]:
    row = _row(conn)
    settings = _sync_settings_from_row(row)
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
            **settings,
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
        **settings,
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
    webhook_secret: str = "",
    homepage_overlay_enabled: bool | None = None,
    homepage_read_interval_hours: int | None = None,
    collect_offset_hours: int | None = None,
) -> dict[str, Any]:
    owner_user_id = int(actor_user_id or 0)
    if owner_user_id <= 0:
        raise BundleSocialConfigError("BUNDLE_CONFIG_OWNER_INVALID", "管理员身份无效，配置未保存", 401)
    clean_base = normalize_api_base_url(api_base_url)
    clean_key = str(api_key or "").strip()
    if not clean_key or len(clean_key) > 512:
        raise BundleSocialConfigError("BUNDLE_API_KEY_REQUIRED", "请填写有效的 API Key", 422)
    existing = _row(conn)
    clean_webhook_secret = str(webhook_secret or "").strip()
    if not clean_webhook_secret and existing is not None:
        clean_webhook_secret = _decrypt_webhook_secret(existing)
    if clean_webhook_secret and len(clean_webhook_secret) > 512:
        raise BundleSocialConfigError("BUNDLE_WEBHOOK_SECRET_INVALID", "Webhook 签名密钥长度无效", 422)
    try:
        ciphertext = encrypt_secret(owner_user_id, _API_KEY_PURPOSE, clean_key)
        webhook_ciphertext = encrypt_secret(owner_user_id, _WEBHOOK_SECRET_PURPOSE, clean_webhook_secret) if clean_webhook_secret else ""
    except PasswordVaultError as exc:
        raise BundleSocialConfigError(
            "BUNDLE_CONFIG_VAULT_UNAVAILABLE",
            "服务器密钥库不可用，平台授权配置未保存",
            503,
        ) from exc
    current = _now()
    checked_at = int(verified_at or current)
    overlay_enabled = 1 if (True if homepage_overlay_enabled is None else bool(homepage_overlay_enabled)) else 0
    if homepage_overlay_enabled is None and existing is not None and "homepage_overlay_enabled" in existing.keys():
        overlay_enabled = 1 if int(existing["homepage_overlay_enabled"] or 0) else 0
    read_hours = _clamp_hours(
        homepage_read_interval_hours,
        DEFAULT_HOMEPAGE_READ_INTERVAL_HOURS,
        MIN_HOMEPAGE_READ_INTERVAL_HOURS,
        MAX_HOMEPAGE_READ_INTERVAL_HOURS,
    )
    if homepage_read_interval_hours is None and existing is not None and "homepage_read_interval_hours" in existing.keys():
        read_hours = _clamp_hours(
            existing["homepage_read_interval_hours"],
            DEFAULT_HOMEPAGE_READ_INTERVAL_HOURS,
            MIN_HOMEPAGE_READ_INTERVAL_HOURS,
            MAX_HOMEPAGE_READ_INTERVAL_HOURS,
        )
    offset_hours = _clamp_hours(
        collect_offset_hours,
        DEFAULT_COLLECT_OFFSET_HOURS,
        MIN_COLLECT_OFFSET_HOURS,
        MAX_COLLECT_OFFSET_HOURS,
    )
    if collect_offset_hours is None and existing is not None and "collect_offset_hours" in existing.keys():
        offset_hours = _clamp_hours(
            existing["collect_offset_hours"],
            DEFAULT_COLLECT_OFFSET_HOURS,
            MIN_COLLECT_OFFSET_HOURS,
            MAX_COLLECT_OFFSET_HOURS,
        )
    conn.execute(
        """
        INSERT INTO bundle_social_provider_config(
          id,owner_user_id,api_base_url,api_key_ciphertext,
          api_key_fingerprint,verified_at,last_checked_at,last_error,
          created_at,updated_at,updated_by,
          webhook_secret_ciphertext,webhook_secret_fingerprint,
          homepage_overlay_enabled,allow_force_refresh,
          homepage_read_interval_hours,collect_offset_hours
        ) VALUES (1,?,?,?,?,?,?,'',?,?,?,?,?,?,0,?,?)
        ON CONFLICT(id) DO UPDATE SET
          owner_user_id=excluded.owner_user_id,
          api_base_url=excluded.api_base_url,
          api_key_ciphertext=excluded.api_key_ciphertext,
          api_key_fingerprint=excluded.api_key_fingerprint,
          verified_at=excluded.verified_at,
          last_checked_at=excluded.last_checked_at,
          last_error='',
          updated_at=excluded.updated_at,
          updated_by=excluded.updated_by,
          webhook_secret_ciphertext=excluded.webhook_secret_ciphertext,
          webhook_secret_fingerprint=excluded.webhook_secret_fingerprint,
          homepage_overlay_enabled=excluded.homepage_overlay_enabled,
          allow_force_refresh=0,
          homepage_read_interval_hours=excluded.homepage_read_interval_hours,
          collect_offset_hours=excluded.collect_offset_hours
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
            webhook_ciphertext,
            hashlib.sha256(clean_webhook_secret.encode("utf-8")).hexdigest()[:12] if clean_webhook_secret else "",
            overlay_enabled,
            read_hours,
            offset_hours,
        ),
    )
    return configuration_status(conn)


def record_webhook_delivery(conn: sqlite3.Connection, *, event_type: str, error: str = "") -> None:
    conn.execute(
        """
        UPDATE bundle_social_provider_config
        SET webhook_last_event_type = ?,
            webhook_last_event_at = ?,
            webhook_last_error = ?
        WHERE id = 1
        """,
        (str(event_type or "")[:80], _now(), str(error or "")[:300]),
    )


def record_homepage_sync(conn: sqlite3.Connection, message: str) -> None:
    conn.execute(
        """
        UPDATE bundle_social_provider_config
        SET homepage_last_sync_at = ?,
            homepage_last_sync_message = ?
        WHERE id = 1
        """,
        (_now(), str(message or "")[:300]),
    )


def remember_webhook_event(conn: sqlite3.Connection, event_key: str, event_type: str) -> bool:
    key = str(event_key or "").strip()[:180]
    if not key:
        return True
    existing = conn.execute(
        "SELECT event_key FROM bundle_social_webhook_events WHERE event_key = ?",
        (key,),
    ).fetchone()
    if existing:
        return False
    conn.execute(
        "INSERT INTO bundle_social_webhook_events(event_key, event_type, received_at) VALUES (?, ?, ?)",
        (key, str(event_type or "")[:80], _now()),
    )
    conn.execute(
        """
        DELETE FROM bundle_social_webhook_events
        WHERE received_at < ?
        """,
        (_now() - 14 * 24 * 3600,),
    )
    return True
