from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from typing import Any, Mapping

from .password_vault import PasswordVaultError, decrypt_secret, encrypt_secret
from .proxy_providers import ProxyCheapProvider, ProxyProvider


PROVIDER_KEY = "proxycheap"
_KEY_PURPOSE = "proxy-provider:proxycheap:api-key"
_SECRET_PURPOSE = "proxy-provider:proxycheap:api-secret"
_WEBHOOK_PURPOSE = "proxy-provider:proxycheap:webhook-secret"


class ProviderCredentialError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _now() -> int:
    return int(time.time())


def _row(conn: sqlite3.Connection, status: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM proxy_provider_credential_versions WHERE provider_key=? AND status=? "
        "ORDER BY updated_at DESC LIMIT 1",
        (PROVIDER_KEY, str(status)),
    ).fetchone()


def credential_status(conn: sqlite3.Connection) -> dict[str, Any]:
    active = _row(conn, "active")
    staged = _row(conn, "staged")
    return {
        "provider": PROVIDER_KEY,
        "configured": bool(active and active["api_key_ciphertext"] and active["api_secret_ciphertext"]),
        "api_key_configured": bool(active and active["api_key_ciphertext"]),
        "api_secret_configured": bool(active and active["api_secret_ciphertext"]),
        "webhook_secret_configured": bool(active and active["webhook_secret_ciphertext"]),
        "account_currency": str(active["account_currency"] or "") if active else "",
        "verified": bool(active and int(active["verified_at"] or 0) > 0),
        "staged": bool(staged),
        "verified_at": int(active["verified_at"] or 0) if active else 0,
        "last_sync_at": int(active["last_sync_at"] or 0) if active else 0,
        "last_error_code": str((staged or active)["last_error_code"] or "") if (staged or active) else "",
        "updated_at": int((staged or active)["updated_at"] or 0) if (staged or active) else 0,
    }


def _decrypt(row: Mapping[str, Any]) -> tuple[str, str, str]:
    owner_user_id = int(row["owner_user_id"] or 0)
    if owner_user_id <= 0:
        raise ProviderCredentialError(
            "PROVIDER_CREDENTIAL_OWNER_INVALID", "供应商凭据所有者无效，请重新保存凭据", 409
        )
    try:
        webhook_ciphertext = str(row["webhook_secret_ciphertext"] or "")
        return (
            decrypt_secret(owner_user_id, _KEY_PURPOSE, str(row["api_key_ciphertext"] or "")),
            decrypt_secret(owner_user_id, _SECRET_PURPOSE, str(row["api_secret_ciphertext"] or "")),
            decrypt_secret(owner_user_id, _WEBHOOK_PURPOSE, webhook_ciphertext)
            if webhook_ciphertext
            else "",
        )
    except PasswordVaultError as exc:
        raise ProviderCredentialError(
            "PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE",
            "供应商凭据暂时无法解密，请检查服务器密钥库",
            503,
        ) from exc


def load_credentials(conn: sqlite3.Connection) -> tuple[str, str] | None:
    row = _row(conn, "active")
    if row is None or not row["api_key_ciphertext"] or not row["api_secret_ciphertext"]:
        return None
    api_key, api_secret, _ = _decrypt(row)
    return api_key, api_secret


def webhook_secrets(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT * FROM proxy_provider_credential_versions WHERE provider_key=? "
        "AND status IN ('active','retired') ORDER BY activated_at DESC LIMIT 2",
        (PROVIDER_KEY,),
    ).fetchall()
    values: list[str] = []
    for row in rows:
        _, _, secret = _decrypt(row)
        if secret and secret not in values:
            values.append(secret)
    return values


def provider(conn: sqlite3.Connection, *, require_verified: bool = True) -> ProxyProvider:
    row = _row(conn, "active")
    if row is not None and row["api_key_ciphertext"] and row["api_secret_ciphertext"]:
        if require_verified and int(row["verified_at"] or 0) <= 0:
            raise ProviderCredentialError(
                "PROVIDER_CREDENTIAL_NOT_VERIFIED", "供应商凭据尚未通过连接测试", 409
            )
        api_key, api_secret, _ = _decrypt(row)
        return ProxyCheapProvider(
            api_key=api_key,
            api_secret=api_secret,
            account_currency=str(row["account_currency"] or ""),
        )
    return ProxyCheapProvider()


def save_credentials(
    conn: sqlite3.Connection,
    *,
    api_key: str = "",
    api_secret: str = "",
    webhook_secret: str = "",
    account_currency: str = "USD",
    actor_user_id: int,
    now: int | None = None,
) -> dict[str, Any]:
    current = _now() if now is None else int(now)
    owner_user_id = int(actor_user_id or 0)
    if owner_user_id <= 0:
        raise ProviderCredentialError(
            "PROVIDER_CREDENTIAL_OWNER_INVALID", "管理员身份无效，凭据未保存", 401
        )
    previous = _row(conn, "staged") or _row(conn, "active")
    old_key = old_secret = old_webhook = ""
    if previous is not None:
        old_key, old_secret, old_webhook = _decrypt(previous)
    clean_key = str(api_key or "").strip() or old_key
    clean_secret = str(api_secret or "").strip() or old_secret
    clean_webhook = str(webhook_secret or "").strip() or old_webhook
    clean_currency = str(account_currency or "").strip().upper()
    if clean_currency != "USD":
        raise ProviderCredentialError(
            "PROVIDER_CURRENCY_UNCONFIRMED", "当前仅支持已确认以 USD 结算的供应商账户", 422
        )
    if not clean_key or not clean_secret:
        raise ProviderCredentialError(
            "PROVIDER_CREDENTIAL_INCOMPLETE", "API Key 和 API Secret 必须同时配置", 422
        )
    if max(len(clean_key), len(clean_secret), len(clean_webhook)) > 512:
        raise ProviderCredentialError("PROVIDER_CREDENTIAL_INVALID", "供应商凭据长度无效", 422)
    try:
        key_ciphertext = encrypt_secret(owner_user_id, _KEY_PURPOSE, clean_key)
        secret_ciphertext = encrypt_secret(owner_user_id, _SECRET_PURPOSE, clean_secret)
        webhook_ciphertext = (
            encrypt_secret(owner_user_id, _WEBHOOK_PURPOSE, clean_webhook) if clean_webhook else ""
        )
    except PasswordVaultError as exc:
        raise ProviderCredentialError(
            "PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE", "服务器密钥库不可用，凭据未保存", 503
        ) from exc
    conn.execute(
        "UPDATE proxy_provider_credential_versions SET status='retired',retired_at=?,updated_at=? "
        "WHERE provider_key=? AND status='staged'",
        (current, current, PROVIDER_KEY),
    )
    conn.execute(
        """
        INSERT INTO proxy_provider_credential_versions(
          id,provider_key,owner_user_id,api_key_ciphertext,api_secret_ciphertext,
          webhook_secret_ciphertext,account_currency,api_key_fingerprint,status,verified_at,activated_at,
          retired_at,last_sync_at,last_error_code,created_at,updated_at,updated_by
        ) VALUES (?,?,?,?,?,?,?,?,'staged',0,0,0,0,'',?,?,?)
        """,
        (
            f"proxycred_{uuid.uuid4().hex}",
            PROVIDER_KEY,
            owner_user_id,
            key_ciphertext,
            secret_ciphertext,
            webhook_ciphertext,
            clean_currency,
            hashlib.sha256(clean_key.encode("utf-8")).hexdigest()[:16],
            current,
            current,
            owner_user_id,
        ),
    )
    return credential_status(conn)


def _service_items(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    for key in ("services", "items", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [dict(item) for item in value if isinstance(item, Mapping)]
    return []


def resolve_plan_id(services: list[dict[str, Any]], service_id: str, plan_id: str) -> str:
    requested = str(plan_id or "").strip()
    if requested:
        return requested
    for service in services:
        current_id = str(service.get("id") or service.get("serviceId") or "")
        if current_id != str(service_id):
            continue
        plans = service.get("plans") if isinstance(service.get("plans"), list) else []
        for plan in plans:
            if not isinstance(plan, Mapping):
                continue
            resolved = str(plan.get("id") or plan.get("planId") or plan.get("value") or "")
            if resolved:
                return resolved
    return ""


def verify_credentials(
    conn: sqlite3.Connection,
    *,
    api_key: str = "",
    api_secret: str = "",
    service_id: str = "static-residential-ipv4",
    plan_id: str = "",
    activate_staged: bool = False,
    now: int | None = None,
) -> dict[str, Any]:
    row = _row(conn, "staged" if activate_staged else "active")
    saved_key = saved_secret = ""
    if row is not None:
        saved_key, saved_secret, _ = _decrypt(row)
    clean_key = str(api_key or "").strip() or saved_key
    clean_secret = str(api_secret or "").strip() or saved_secret
    if not clean_key or not clean_secret:
        raise ProviderCredentialError(
            "PROVIDER_CREDENTIAL_INCOMPLETE", "请先填写并保存完整的 API Key 和 API Secret", 422
        )
    account_currency = str(row["account_currency"] or "") if row is not None else "USD"
    client = ProxyCheapProvider(
        api_key=clean_key,
        api_secret=clean_secret,
        account_currency=account_currency,
    )
    services_payload = client.list_services()
    services = _service_items(services_payload)
    selected_plan_id = resolve_plan_id(services, str(service_id), str(plan_id or ""))
    setup = client.get_setup(str(service_id), plan_id=selected_plan_id)
    balance = client.get_balance()
    current = _now() if now is None else int(now)
    saved_matches = row is not None and clean_key == saved_key and clean_secret == saved_secret
    if activate_staged and saved_matches:
        conn.execute(
            "UPDATE proxy_provider_credential_versions SET status='retired',retired_at=?,updated_at=? "
            "WHERE provider_key=? AND status='active'",
            (current, current, PROVIDER_KEY),
        )
        conn.execute(
            "UPDATE proxy_provider_credential_versions SET status='active',verified_at=?,activated_at=?,"
            "last_error_code='',updated_at=? WHERE id=? AND status='staged'",
            (current, current, current, str(row["id"])),
        )
    return {
        "ok": True,
        "provider": PROVIDER_KEY,
        "saved_credentials_verified": bool(activate_staged and saved_matches),
        "service_count": len(services),
        "selected_plan_id": selected_plan_id,
        "balance": balance,
        "setup": setup,
        "verified_at": current,
    }


def store_option_snapshot(
    conn: sqlite3.Connection,
    *,
    service_id: str,
    plan_id: str,
    payload: Mapping[str, Any],
    synced_at: int | None = None,
) -> str:
    current = _now() if synced_at is None else int(synced_at)
    body = json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    revision = hashlib.sha256(body.encode("utf-8")).hexdigest()[:24]
    conn.execute(
        """
        INSERT INTO proxy_provider_option_snapshots(provider_key,service_id,plan_id,revision,payload_json,synced_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(provider_key,service_id,plan_id) DO UPDATE SET
          revision=excluded.revision,payload_json=excluded.payload_json,synced_at=excluded.synced_at
        """,
        (PROVIDER_KEY, str(service_id), str(plan_id or ""), revision, body, current),
    )
    conn.execute(
        "UPDATE proxy_provider_credential_versions SET last_sync_at=?,last_error_code='' "
        "WHERE provider_key=? AND status='active'",
        (current, PROVIDER_KEY),
    )
    return revision


def load_option_snapshot(
    conn: sqlite3.Connection, *, service_id: str, plan_id: str = ""
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM proxy_provider_option_snapshots WHERE provider_key=? AND service_id=? AND plan_id=?",
        (PROVIDER_KEY, str(service_id), str(plan_id or "")),
    ).fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(str(row["payload_json"] or "{}"))
    except json.JSONDecodeError:
        payload = {}
    return {
        **(payload if isinstance(payload, dict) else {}),
        "revision": str(row["revision"] or ""),
        "last_sync_at": int(row["synced_at"] or 0),
    }
