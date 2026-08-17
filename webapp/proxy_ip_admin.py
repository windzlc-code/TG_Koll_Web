from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import sqlite3
import threading
import time
import types
import uuid
from typing import Any
from urllib.parse import quote, urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
import requests
from requests.adapters import HTTPAdapter
from requests.exceptions import ProxyError
from urllib3 import ProxyManager
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
from urllib3.util import connection as urllib3_connection

from . import governance
from .auth import get_current_user, require_admin
from .db import db, get_admin_config, set_admin_config
from .password_vault import PasswordVaultError
from .proxy_market_credentials import (
    decrypt_market_credentials,
    encrypt_market_credentials,
)
from .social_automation_api import (
    _run_proxy_connection_check as _social_run_proxy_connection_check,
    _validate_proxy_credentials,
    _validate_proxy_endpoint,
    cancel_social_tasks_in_transaction,
    cleanup_cancelled_social_tasks_runtime,
)


MARKET_SETTINGS_KEY = "proxy_market_settings"
DEFAULT_CLAIM_LIMIT = 3
DEFAULT_HEALTH_MAX_AGE_SECONDS = 24 * 60 * 60
DEFAULT_HEALTH_MONITOR_POLL_SECONDS = 60
HEALTH_FAILURE_RECHECK_SECONDS = 5 * 60
ITEM_STATUSES = {"draft", "active", "allocated", "maintenance", "disabled", "archived"}
HEALTH_STATUSES = {"pending", "healthy", "failed"}
PROXY_TYPES = {"http", "https", "socks5"}

_HEALTH_MONITOR_THREAD: threading.Thread | None = None
_HEALTH_MONITOR_STOP = threading.Event()
_HEALTH_MONITOR_WAKE = threading.Event()
_HEALTH_MONITOR_LOCK = threading.Lock()


class ProxyMarketItemPayload(BaseModel):
    sku: str = Field(default="", max_length=80)
    display_name: str = Field(default="", max_length=120)
    provider_key: str = Field(default="", max_length=80)
    proxy_type: str = Field(default="socks5", max_length=20)
    host: str = Field(default="", max_length=255)
    port: int = Field(default=0, ge=0, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=512)
    country: str = Field(default="", max_length=80)
    region: str = Field(default="", max_length=100)
    city: str = Field(default="", max_length=100)
    isp: str = Field(default="", max_length=160)
    ip_type: str = Field(default="static_residential", max_length=40)
    description: str = Field(default="", max_length=1200)
    tags: list[str] = Field(default_factory=list)
    use_cases: list[str] = Field(default_factory=list)
    display_price_cents: int = Field(default=0, ge=0)
    currency: str = Field(default="TWD", max_length=10)
    billing_cycle: str = Field(default="month", max_length=20)
    expires_at: int = Field(default=0, ge=0)


class ProxyMarketItemPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    provider_key: str | None = Field(default=None, max_length=80)
    country: str | None = Field(default=None, max_length=80)
    region: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    isp: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=1200)
    tags: list[str] | None = None
    use_cases: list[str] | None = None
    display_price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, max_length=10)
    billing_cycle: str | None = Field(default=None, max_length=20)
    expires_at: int | None = Field(default=None, ge=0)
    status: str | None = Field(default=None, max_length=30)


class ProxyMarketPublishPayload(BaseModel):
    proxy_type: str | None = Field(default=None, max_length=20)
    host: str = Field(default="", max_length=255)
    port: int = Field(default=0, ge=1, le=65535)
    username: str | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, max_length=512)
    expires_at: int | None = Field(default=None, ge=0)


class ProxyMarketInspectPayload(BaseModel):
    item_id: str = Field(default="", max_length=80)
    proxy_type: str = Field(default="socks5", max_length=20)
    host: str = Field(default="", max_length=255)
    port: int = Field(default=0, ge=0, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=512)



class ProxyMarketReadPayload(BaseModel):
    scope: str = Field(default="catalog", max_length=30)


class ProxyMarketSettingsPayload(BaseModel):
    default_claim_limit: int = Field(default=DEFAULT_CLAIM_LIMIT, ge=0, le=100)
    health_max_age_seconds: int = Field(
        default=DEFAULT_HEALTH_MAX_AGE_SECONDS,
        ge=300,
        le=7 * 24 * 60 * 60,
    )


class ProxyMarketUserLimitPayload(BaseModel):
    claim_limit_override: int | None = Field(default=None, ge=0, le=100)


class ProxyMarketRevokePayload(BaseModel):
    confirm_impact: bool = False


class ProxyMarketPurgePayload(BaseModel):
    confirm_impact: bool = False


class ProxyMarketAssignPayload(BaseModel):
    user_id: int = Field(..., ge=1)
    confirm_impact: bool = False


class ProxyMarketSharePayload(BaseModel):
    user_ids: list[int] = Field(default_factory=list)
    confirm_impact: bool = False


def _now() -> int:
    return int(time.time())


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _owner_user_id(user: dict[str, Any]) -> int:
    return int(user.get("_workspace_user_id") or user.get("id") or 0)


def _actor_user_id(user: dict[str, Any]) -> int:
    return int(user.get("id") or 0)


def _settings(conn: sqlite3.Connection) -> dict[str, int]:
    raw = get_admin_config(conn, MARKET_SETTINGS_KEY, {})
    source = raw if isinstance(raw, dict) else {}
    claim_limit_value = source.get("default_claim_limit")
    return {
        "default_claim_limit": max(
            0,
            min(
                100,
                int(DEFAULT_CLAIM_LIMIT if claim_limit_value is None else claim_limit_value),
            ),
        ),
        "health_max_age_seconds": max(
            300,
            min(
                7 * 24 * 60 * 60,
                int(source.get("health_max_age_seconds") or DEFAULT_HEALTH_MAX_AGE_SECONDS),
            ),
        ),
    }


def _json_list(value: Any, *, limit: int = 16, item_limit: int = 80) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = []
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        clean = re.sub(r"\s+", " ", str(item or "").strip())[:item_limit]
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
        if len(result) >= limit:
            break
    return result


def _json_text_list(value: Any) -> str:
    return json.dumps(_json_list(value), ensure_ascii=False, separators=(",", ":"))


def _mask_host(host: str) -> str:
    value = str(host or "").strip()
    parts = value.split(".")
    if len(parts) == 4 and all(part.isdigit() for part in parts):
        return ".".join((*parts[:3], "***"))
    if len(value) <= 5:
        return "***"
    return f"{value[:3]}***{value[-2:]}"


def _encrypt_credentials(
    item_id: str,
    actor_user_id: int,
    username: str,
    password: str,
) -> tuple[str, str]:
    try:
        return encrypt_market_credentials(
            item_id,
            actor_user_id,
            username,
            password,
        )
    except PasswordVaultError as exc:
        raise HTTPException(status_code=503, detail="凭据保险库暂时不可用") from exc


def _decrypt_credentials(item: dict[str, Any]) -> tuple[str, str]:
    try:
        return decrypt_market_credentials(item)
    except PasswordVaultError as exc:
        raise HTTPException(status_code=503, detail="代理凭据暂时不可用") from exc


def _last_market_exit_ip(item: dict[str, Any]) -> str:
    result = _safe_check_result(item.get("last_check_result_json"))
    response = result.get("response") if isinstance(result.get("response"), dict) else {}
    return str(response.get("ip") or result.get("exit_ip") or result.get("ip") or "").strip()


def _health_recheck_after_seconds(health_max_age_seconds: int) -> int:
    window = max(300, int(health_max_age_seconds or DEFAULT_HEALTH_MAX_AGE_SECONDS))
    lead_seconds = min(300, max(30, window // 10))
    return max(0, window - lead_seconds)


def _health_monitor_poll_seconds() -> int:
    try:
        requested = int(os.getenv("PROXY_MARKET_HEALTH_MONITOR_POLL_SECONDS", str(DEFAULT_HEALTH_MONITOR_POLL_SECONDS)))
    except (TypeError, ValueError):
        requested = DEFAULT_HEALTH_MONITOR_POLL_SECONDS
    return max(15, min(3600, requested))


def run_proxy_market_health_maintenance_once(*, now: int | None = None, limit: int = 8) -> dict[str, int]:
    """Refresh marketplace health before it expires without changing lease expiry or pricing."""
    checked_at = int(now if now is not None else _now())
    batch_limit = max(1, min(int(limit or 1), 32))
    with db() as conn:
        settings = _settings(conn)
        recheck_after = _health_recheck_after_seconds(settings["health_max_age_seconds"])
        rows = conn.execute(
            """
            SELECT item.*
            FROM proxy_market_items AS item
            WHERE (item.expires_at = 0 OR item.expires_at > ?)
              AND (
                (item.status IN ('active', 'allocated') AND item.last_check_at <= ?)
                OR (
                  item.status = 'maintenance'
                  AND item.health_status = 'failed'
                  AND item.last_check_at <= ?
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM social_automation_tasks AS task
                JOIN social_accounts AS account ON account.id = task.account_id
                JOIN social_proxies AS proxy ON proxy.id = account.proxy_id
                WHERE proxy.market_item_id = item.id
                  AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
              )
            ORDER BY item.last_check_at ASC, item.updated_at ASC
            LIMIT ?
            """,
            (checked_at, checked_at - recheck_after, checked_at - HEALTH_FAILURE_RECHECK_SECONDS, batch_limit),
        ).fetchall()

    summary = {"checked": 0, "healthy": 0, "failed": 0, "skipped": 0}
    for row in rows:
        item = dict(row)
        try:
            username, password = _decrypt_credentials(item)
        except HTTPException:
            summary["skipped"] += 1
            continue
        candidate = {
            "proxy_type": str(item.get("proxy_type") or "socks5").strip().lower(),
            "host": str(item.get("host") or "").strip(),
            "port": int(item.get("port") or 0),
            "username": username,
            "password": password,
        }
        result = _run_proxy_connection_check(candidate, previous_exit_ip=_last_market_exit_ip(item))
        is_healthy = bool(result.get("ok"))
        response = result.get("response") if isinstance(result.get("response"), dict) else {}
        connection = response.get("connection") if isinstance(response.get("connection"), dict) else {}
        result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        next_status = str(item.get("status") or "active")
        if is_healthy and next_status == "maintenance":
            next_status = "active"
        elif not is_healthy and next_status == "active":
            next_status = "maintenance"
        with db() as conn:
            updated = conn.execute(
                """
                UPDATE proxy_market_items
                SET status = ?, health_status = ?, latency_ms = ?, last_check_at = ?,
                    last_check_result_json = ?, country = CASE WHEN ? != '' THEN ? ELSE country END,
                    region = CASE WHEN ? != '' THEN ? ELSE region END,
                    city = CASE WHEN ? != '' THEN ? ELSE city END,
                    isp = CASE WHEN ? != '' THEN ? ELSE isp END,
                    updated_at = ?
                WHERE id = ? AND version = ?
                  AND (
                    status IN ('active', 'allocated')
                    OR (status = 'maintenance' AND health_status = 'failed')
                  )
                """,
                (
                    next_status,
                    "healthy" if is_healthy else "failed",
                    int(result.get("latency_ms") or 0),
                    checked_at,
                    result_json,
                    str(response.get("country") or ""),
                    str(response.get("country") or ""),
                    str(response.get("region") or ""),
                    str(response.get("region") or ""),
                    str(response.get("city") or ""),
                    str(response.get("city") or ""),
                    str(connection.get("isp") or connection.get("org") or ""),
                    str(connection.get("isp") or connection.get("org") or ""),
                    checked_at,
                    str(item["id"]),
                    int(item.get("version") or 1),
                ),
            ).rowcount
            if updated and str(item.get("ownership_type") or "").strip().lower() == "owned":
                conn.execute(
                    """
                    UPDATE social_proxies
                    SET country = CASE WHEN ? != '' THEN ? ELSE country END,
                        region = CASE WHEN ? != '' THEN ? ELSE region END,
                        city = CASE WHEN ? != '' THEN ? ELSE city END,
                        isp = CASE WHEN ? != '' THEN ? ELSE isp END,
                        last_check_at = ?, last_check_result = ?, updated_at = ?
                    WHERE market_item_id = ? AND user_id = ?
                    """,
                    (
                        str(response.get("country") or ""),
                        str(response.get("country") or ""),
                        str(response.get("region") or ""),
                        str(response.get("region") or ""),
                        str(response.get("city") or ""),
                        str(response.get("city") or ""),
                        str(connection.get("isp") or connection.get("org") or ""),
                        str(connection.get("isp") or connection.get("org") or ""),
                        checked_at,
                        result_json,
                        checked_at,
                        str(item["id"]),
                        int(item.get("owner_user_id") or 0),
                    ),
                )
        if not updated:
            summary["skipped"] += 1
            continue
        summary["checked"] += 1
        summary["healthy" if is_healthy else "failed"] += 1
    return summary


def _health_monitor_loop() -> None:
    while not _HEALTH_MONITOR_STOP.is_set():
        try:
            run_proxy_market_health_maintenance_once()
        except Exception:
            pass
        _HEALTH_MONITOR_WAKE.wait(timeout=_health_monitor_poll_seconds())
        _HEALTH_MONITOR_WAKE.clear()


def ensure_proxy_market_health_monitor_started() -> None:
    global _HEALTH_MONITOR_THREAD
    if str(os.getenv("PROXY_MARKET_HEALTH_MONITOR_ENABLED", "1")).strip().lower() in {"0", "false", "no", "off"}:
        return
    with _HEALTH_MONITOR_LOCK:
        if _HEALTH_MONITOR_THREAD and _HEALTH_MONITOR_THREAD.is_alive():
            return
        _HEALTH_MONITOR_STOP.clear()
        _HEALTH_MONITOR_THREAD = threading.Thread(
            target=_health_monitor_loop,
            name="proxy-market-health-monitor",
            daemon=True,
        )
        _HEALTH_MONITOR_THREAD.start()


def stop_proxy_market_health_monitor(*, timeout_seconds: float = 5.0) -> None:
    global _HEALTH_MONITOR_THREAD
    _HEALTH_MONITOR_STOP.set()
    _HEALTH_MONITOR_WAKE.set()
    worker = _HEALTH_MONITOR_THREAD
    if worker and worker.is_alive() and worker is not threading.current_thread():
        worker.join(timeout=max(0.0, float(timeout_seconds)))
    if worker is None or not worker.is_alive():
        _HEALTH_MONITOR_THREAD = None


def _is_purchased_item(item: dict[str, Any]) -> bool:
    ownership_type = str(item.get("ownership_type") or "shared").strip().lower()
    return ownership_type == "owned" or bool(str(item.get("provider_purchase_order_id") or "").strip())


def _proxy_usage_impact(conn: sqlite3.Connection, proxy_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    clean_ids = [str(proxy_id or "").strip() for proxy_id in proxy_ids if str(proxy_id or "").strip()]
    if not clean_ids:
        return {"bound_accounts": [], "running_tasks": []}
    placeholders = ",".join("?" for _ in clean_ids)
    accounts = conn.execute(
        f"""
        SELECT id, username, platform, proxy_id
        FROM social_accounts
        WHERE proxy_id IN ({placeholders})
        ORDER BY username
        """,
        tuple(clean_ids),
    ).fetchall()
    tasks = conn.execute(
        f"""
        SELECT task.*, account.username
        FROM social_automation_tasks task
        JOIN social_accounts account ON account.id = task.account_id
        WHERE account.proxy_id IN ({placeholders})
          AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
        ORDER BY task.created_at
        """,
        tuple(clean_ids),
    ).fetchall()
    return {
        "bound_accounts": [
            {
                "id": str(row["id"] or ""),
                "username": str(row["username"] or ""),
                "platform": str(row["platform"] or ""),
                "proxy_id": str(row["proxy_id"] or ""),
            }
            for row in accounts
        ],
        "running_tasks": [
            {
                "id": str(row["id"] or ""),
                "task_type": str(row["task_type"] or ""),
                "status": str(row["status"] or ""),
                "username": str(row["username"] or ""),
            }
            for row in tasks
        ],
    }


def _require_enabled_user(conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    item = dict(row)
    if int(item.get("deleted_at") or 0) > 0 or int(item.get("is_disabled") or 0) == 1:
        raise HTTPException(status_code=403, detail="账号当前不可领取代理")
    if int(item.get("is_admin") or 0) != 1 and str(item.get("approval_status") or "") != "approved":
        raise HTTPException(status_code=403, detail="账号审核通过后才能领取代理")
    return item


def _user_state(conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM proxy_market_user_state WHERE user_id = ?",
        (int(user_id),),
    ).fetchone()
    if row is not None:
        return dict(row)
    return {
        "user_id": int(user_id),
        "last_catalog_seen_at": 0,
        "last_proxy_pool_seen_at": 0,
        "claim_limit_override": None,
        "updated_at": 0,
    }


def _claim_limit(conn: sqlite3.Connection, user_id: int) -> int:
    state = _user_state(conn, user_id)
    override = state.get("claim_limit_override")
    return int(override) if override is not None else int(_settings(conn)["default_claim_limit"])


def _fresh_and_healthy(
    item: dict[str, Any],
    *,
    now: int,
    max_age_seconds: int,
) -> bool:
    return bool(
        str(item.get("health_status") or "") == "healthy"
        and int(item.get("last_check_at") or 0) >= now - max_age_seconds
        and (int(item.get("expires_at") or 0) <= 0 or int(item.get("expires_at") or 0) > now)
    )


def _market_public(
    item: dict[str, Any],
    *,
    now: int,
    health_max_age_seconds: int,
    last_seen_at: int = 0,
) -> dict[str, Any]:
    status = str(item.get("status") or "")
    health_status = str(item.get("health_status") or "")
    last_check_at = int(item.get("last_check_at") or 0)
    expires_at = int(item.get("expires_at") or 0)
    available = status == "active" and _fresh_and_healthy(
        item,
        now=now,
        max_age_seconds=health_max_age_seconds,
    )
    availability_reason = ""
    if not available:
        if status != "active":
            availability_reason = f"status_{status or 'draft'}"
        elif health_status != "healthy":
            availability_reason = "health_failed" if health_status == "failed" else "health_pending"
        elif last_check_at < now - health_max_age_seconds:
            availability_reason = "health_stale"
        elif expires_at > 0 and expires_at <= now:
            availability_reason = "expired"
        else:
            availability_reason = "unavailable"
    return {
        "id": str(item.get("id") or ""),
        "sku": str(item.get("sku") or ""),
        "display_name": str(item.get("display_name") or ""),
        "provider_key": str(item.get("provider_key") or ""),
        "proxy_type": str(item.get("proxy_type") or ""),
        "masked_host": _mask_host(str(item.get("host") or "")),
        "country": str(item.get("country") or ""),
        "region": str(item.get("region") or ""),
        "city": str(item.get("city") or ""),
        "isp": str(item.get("isp") or ""),
        "ip_type": str(item.get("ip_type") or "static_residential"),
        "description": str(item.get("description") or ""),
        "tags": _json_list(item.get("tags_json")),
        "use_cases": _json_list(item.get("use_cases_json")),
        "display_price_cents": int(item.get("display_price_cents") or 0),
        "currency": str(item.get("currency") or "TWD"),
        "billing_cycle": str(item.get("billing_cycle") or "month"),
        "health_status": health_status or "pending",
        "latency_ms": int(item.get("latency_ms") or 0),
        "last_check_at": last_check_at,
        "health_valid_until": last_check_at + health_max_age_seconds if last_check_at > 0 else 0,
        "expires_at": expires_at,
        "published_at": int(item.get("published_at") or 0),
        "available": available,
        "availability_reason": availability_reason,
        "is_new": int(item.get("published_at") or 0) > int(last_seen_at or 0),
    }


def _admin_public(item: dict[str, Any]) -> dict[str, Any]:
    result = _market_public(
        item,
        now=_now(),
        health_max_age_seconds=_settings_for_item_admin(),
    )
    ownership_type = str(item.get("ownership_type") or "shared").strip().lower() or "shared"
    purchased = _is_purchased_item(item)
    result.update(
        {
            "host": str(item.get("host") or ""),
            "port": int(item.get("port") or 0),
            "username_configured": bool(str(item.get("username_ciphertext") or "")),
            "password_configured": bool(str(item.get("password_ciphertext") or "")),
            "status": str(item.get("status") or "draft"),
            "ownership_type": ownership_type,
            "owner_user_id": int(item.get("owner_user_id") or 0),
            "provider_purchase_order_id": str(item.get("provider_purchase_order_id") or ""),
            "can_purge": not purchased,
            "can_assign": purchased,
            "can_share": purchased,
            "last_check_result": _safe_check_result(item.get("last_check_result_json")),
            "version": int(item.get("version") or 1),
            "created_at": int(item.get("created_at") or 0),
            "updated_at": int(item.get("updated_at") or 0),
        }
    )
    return result


def _settings_for_item_admin() -> int:
    with db() as conn:
        return int(_settings(conn)["health_max_age_seconds"])


def _safe_check_result(value: Any) -> dict[str, Any]:
    try:
        data = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        return {}
    return governance.redact(data)


def _proxy_inspection_response(result: dict[str, Any]) -> dict[str, Any]:
    response = result.get("response") if isinstance(result.get("response"), dict) else {}
    connection = response.get("connection") if isinstance(response.get("connection"), dict) else {}
    return {
        "ok": bool(result.get("ok")),
        "checked_at": int(result.get("checked_at") or _now()),
        "exit_ip": str(result.get("exit_ip") or response.get("ip") or "").strip(),
        "latency_ms": max(0, int(result.get("latency_ms") or 0)),
        "route_verified": bool(result.get("route_verified")),
        "static_consistent": bool(result.get("static_consistent")),
        "residential_status": str(result.get("residential_status") or "").strip(),
        "residential_reason": str(result.get("residential_reason") or "").strip(),
        "error_code": str(result.get("error_code") or "").strip(),
        "error": str(result.get("error") or "").strip(),
        "detected": {
            "country": str(response.get("country_code") or response.get("country") or "").strip(),
            "country_name": str(response.get("country") or "").strip(),
            "region": str(response.get("region") or "").strip(),
            "city": str(response.get("city") or "").strip(),
            "isp": str(connection.get("isp") or connection.get("org") or "").strip(),
        },
    }


def _scrub_inspection_secrets(result: dict[str, Any], *secrets: str) -> dict[str, Any]:
    clean = dict(result)
    for field in ("error", "residential_reason"):
        value = str(clean.get(field) or "")
        for secret in secrets:
            if secret:
                variants = {secret, quote(secret, safe="")}
                for variant in sorted(variants, key=len, reverse=True):
                    value = value.replace(variant, "***")
        clean[field] = value
    return clean


class _PinnedConnectionMixin:
    def __init__(self, *args: Any, pinned_proxy_ip: str, **kwargs: Any) -> None:
        self._pinned_proxy_ip = pinned_proxy_ip
        super().__init__(*args, **kwargs)

    def _new_conn(self):
        try:
            return urllib3_connection.create_connection(
                (self._pinned_proxy_ip, self.port),
                self.timeout,
                source_address=self.source_address,
                socket_options=self.socket_options,
            )
        except socket.timeout as exc:
            raise ConnectTimeoutError(
                self,
                f"Connection to {self.host} timed out. (connect timeout={self.timeout})",
            ) from exc
        except OSError as exc:
            raise NewConnectionError(
                self,
                f"Failed to establish a new connection: {exc}",
            ) from exc


class _PinnedHTTPConnection(_PinnedConnectionMixin, HTTPConnection):
    pass


class _PinnedHTTPSConnection(_PinnedConnectionMixin, HTTPSConnection):
    pass


class _PinnedHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _PinnedHTTPConnection


class _PinnedHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _PinnedHTTPSConnection


class _PinnedProxyManager(ProxyManager):
    def __init__(self, proxy_url: str, *, pinned_proxy_ip: str, **kwargs: Any) -> None:
        self._pinned_proxy_ip = pinned_proxy_ip
        super().__init__(proxy_url, **kwargs)
        self.pool_classes_by_scheme = {
            "http": _PinnedHTTPConnectionPool,
            "https": _PinnedHTTPSConnectionPool,
        }

    def _new_pool(
        self,
        scheme: str,
        host: str,
        port: int,
        request_context: dict[str, Any] | None = None,
    ):
        context = dict(request_context or self.connection_pool_kw)
        context["pinned_proxy_ip"] = self._pinned_proxy_ip
        return super()._new_pool(scheme, host, port, context)


class _PinnedProxyAdapter(HTTPAdapter):
    def __init__(
        self,
        *,
        original_host: str,
        original_port: int,
        pinned_ip: str,
    ) -> None:
        self._original_host = original_host.rstrip(".").lower()
        self._original_port = int(original_port)
        self._pinned_ip = str(ipaddress.ip_address(pinned_ip))
        super().__init__()

    def proxy_manager_for(self, proxy: str, **proxy_kwargs: Any):
        if proxy in self.proxy_manager:
            return self.proxy_manager[proxy]

        parsed = urlsplit(proxy)
        try:
            parsed_port = parsed.port
        except ValueError as exc:
            raise ProxyError("Pinned proxy endpoint is malformed") from exc
        if (
            str(parsed.hostname or "").rstrip(".").lower() != self._original_host
            or int(parsed_port or 0) != self._original_port
        ):
            raise ProxyError("Pinned proxy endpoint does not match the validated endpoint")

        if parsed.scheme.lower().startswith("socks"):
            manager = super().proxy_manager_for(proxy, **proxy_kwargs)
            socks_options = dict(manager.connection_pool_kw["_socks_options"])
            socks_options["proxy_host"] = self._pinned_ip
            manager.connection_pool_kw["_socks_options"] = socks_options
        else:
            manager = _PinnedProxyManager(
                proxy,
                pinned_proxy_ip=self._pinned_ip,
                proxy_headers=self.proxy_headers(proxy),
                num_pools=self._pool_connections,
                maxsize=self._pool_maxsize,
                block=self._pool_block,
                **proxy_kwargs,
            )
            self.proxy_manager[proxy] = manager
        return manager


class _PinnedRequests:
    def __init__(self, pinned_session: requests.Session) -> None:
        self._pinned_session = pinned_session

    def get(self, url: str, **kwargs: Any):
        if kwargs.get("proxies"):
            return self._pinned_session.get(url, **kwargs)
        return requests.get(url, **kwargs)


def _validate_public_proxy_host(host: str, port: int) -> str:
    try:
        literal = ipaddress.ip_address(str(host or "").strip())
    except ValueError:
        literal = None
    if literal is not None:
        if not literal.is_global:
            raise HTTPException(status_code=400, detail="真实检测仅允许公网代理地址")
        return str(literal)
    try:
        resolved = [
            str(entry[4][0])
            for entry in socket.getaddrinfo(
                str(host or "").strip(),
                int(port),
                type=socket.SOCK_STREAM,
            )
            if entry and len(entry) >= 5 and entry[4]
        ]
    except OSError as exc:
        raise HTTPException(status_code=400, detail="代理主机无法解析") from exc
    if not resolved:
        raise HTTPException(status_code=400, detail="代理主机无法解析")
    pinned_ip = ""
    for address in resolved:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="代理主机解析结果无效") from exc
        if not parsed.is_global:
            raise HTTPException(status_code=400, detail="真实检测不允许连接内网、回环或保留地址")
        if not pinned_ip:
            pinned_ip = str(parsed)
    return pinned_ip


def _run_proxy_connection_check(
    proxy: dict[str, Any],
    *,
    previous_exit_ip: str = "",
) -> dict[str, Any]:
    _, host, port = _validate_proxy_endpoint(
        proxy.get("proxy_type") or "http",
        proxy.get("host") or "",
        proxy.get("port") or 0,
    )
    pinned_ip = _validate_public_proxy_host(host, port)
    session = requests.Session()
    adapter = _PinnedProxyAdapter(
        original_host=host,
        original_port=port,
        pinned_ip=pinned_ip,
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    check_globals = dict(_social_run_proxy_connection_check.__globals__)
    check_globals["requests"] = _PinnedRequests(session)
    pinned_check = types.FunctionType(
        _social_run_proxy_connection_check.__code__,
        check_globals,
        _social_run_proxy_connection_check.__name__,
        _social_run_proxy_connection_check.__defaults__,
        _social_run_proxy_connection_check.__closure__,
    )
    pinned_check.__kwdefaults__ = _social_run_proxy_connection_check.__kwdefaults__
    try:
        return pinned_check(proxy, previous_exit_ip=previous_exit_ip)
    finally:
        session.close()



def _record_audit(
    conn: sqlite3.Connection,
    request: Request,
    *,
    actor_user_id: int,
    target_user_id: int = 0,
    action: str,
    resource_type: str,
    resource_id: str,
    after: dict[str, Any],
    risk_level: str = "low",
    outcome: str = "success",
    error_code: str = "",
) -> None:
    governance.record_audit(
        conn,
        actor_user_id=actor_user_id,
        target_user_id=target_user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        after=after,
        risk_level=risk_level,
        outcome=outcome,
        error_code=error_code,
        **governance.request_context(request),
    )


def release_market_proxy(
    proxy_id: str,
    *,
    owner_user_id: int,
    actor_user_id: int,
    request: Request | None = None,
    revoked: bool = False,
) -> dict[str, Any]:
    clean_proxy_id = str(proxy_id or "").strip()
    now = _now()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        proxy = conn.execute(
            "SELECT * FROM social_proxies WHERE id = ? AND user_id = ?",
            (clean_proxy_id, int(owner_user_id)),
        ).fetchone()
        if proxy is None:
            raise HTTPException(status_code=404, detail="代理不存在")
        proxy_item = dict(proxy)
        allocation_id = str(proxy_item.get("market_allocation_id") or "")
        if not allocation_id or str(proxy_item.get("source") or "") != "marketplace":
            raise HTTPException(status_code=409, detail="该代理不是公共代理池代理")
        bound = conn.execute(
            "SELECT id FROM social_accounts WHERE proxy_id = ? LIMIT 1",
            (clean_proxy_id,),
        ).fetchone()
        if bound is not None:
            raise HTTPException(status_code=409, detail="代理仍被账号绑定，请先解绑")
        active_task = conn.execute(
            """
            SELECT task.id
            FROM social_automation_tasks task
            JOIN social_accounts account ON account.id = task.account_id
            WHERE account.proxy_id = ?
              AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
            LIMIT 1
            """,
            (clean_proxy_id,),
        ).fetchone()
        if active_task is not None:
            raise HTTPException(status_code=409, detail="代理仍有执行中的任务，暂时不能释放")
        allocation = conn.execute(
            "SELECT * FROM proxy_market_allocations WHERE id = ? AND status = 'active'",
            (allocation_id,),
        ).fetchone()
        if allocation is None:
            raise HTTPException(status_code=409, detail="代理领取记录已失效")
        item_id = str(allocation["item_id"])
        conn.execute("DELETE FROM social_proxies WHERE id = ?", (clean_proxy_id,))
        next_status = "revoked" if revoked else "released"
        conn.execute(
            """
            UPDATE proxy_market_allocations
            SET status = ?, released_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (next_status, now, now, allocation_id),
        )
        item = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (item_id,)).fetchone()
        if item is not None:
            item_data = dict(item)
            can_return = _fresh_and_healthy(
                item_data,
                now=now,
                max_age_seconds=_settings(conn)["health_max_age_seconds"],
            )
            current_status = str(item_data.get("status") or "")
            if current_status == "allocated":
                conn.execute(
                    "UPDATE proxy_market_items SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?",
                    ("active" if can_return else "maintenance", now, item_id),
                )
        if request is not None:
            _record_audit(
                conn,
                request,
                actor_user_id=actor_user_id,
                target_user_id=owner_user_id,
                action="proxy_market.allocation.revoke" if revoked else "proxy_market.allocation.release",
                resource_type="proxy_market_allocation",
                resource_id=allocation_id,
                after={"item_id": item_id, "social_proxy_id": clean_proxy_id, "status": next_status},
                risk_level="medium" if revoked else "low",
            )
    return {"released": True, "allocation_id": allocation_id, "item_id": item_id}


def _ensure_owned_social_proxy(
    conn: sqlite3.Connection,
    *,
    item: dict[str, Any],
    owner_user_id: int,
    now: int,
    purchase_status: str = "owned",
) -> str:
    item_id = str(item.get("id") or "")
    existing = conn.execute(
        "SELECT id FROM social_proxies WHERE market_item_id = ? AND user_id = ? LIMIT 1",
        (item_id, int(owner_user_id)),
    ).fetchone()
    if existing is not None:
        return str(existing["id"])
    proxy_id = _new_id("social_proxy")
    status_label = "shared" if str(purchase_status or "") == "shared" else "owned"
    conn.execute(
        """
        INSERT INTO social_proxies(
          id, user_id, name, proxy_type, host, port, username, password,
          country, region, city, isp, source, ip_type, purchase_status,
          note, expires_at, status, last_check_at, last_check_result,
          client_request_id, market_item_id, market_allocation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, 'provider_purchase',
                  ?, ?, ?, ?, 'active', ?, ?, '', ?, '', ?, ?)
        """,
        (
            proxy_id,
            int(owner_user_id),
            str(item.get("display_name") or item.get("sku") or "已购代理"),
            str(item.get("proxy_type") or "http"),
            str(item.get("host") or ""),
            int(item.get("port") or 0),
            str(item.get("country") or ""),
            str(item.get("region") or ""),
            str(item.get("city") or ""),
            str(item.get("isp") or ""),
            str(item.get("ip_type") or "static_residential"),
            status_label,
            str(item.get("description") or item.get("provider_purchase_order_id") or "管理员共享的已购代理"),
            int(item.get("expires_at") or 0),
            int(item.get("last_check_at") or 0),
            str(item.get("last_check_result_json") or "{}"),
            item_id,
            now,
            now,
        ),
    )
    return proxy_id


def purge_shared_market_item(
    item_id: str,
    *,
    actor_user_id: int,
    request: Request | None = None,
    confirm_impact: bool = False,
) -> dict[str, Any]:
    clean_item_id = str(item_id or "").strip()
    now = _now()
    cancelled_task_ids: list[str] = []
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (clean_item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="代理不存在")
        item = dict(row)
        if _is_purchased_item(item):
            raise HTTPException(status_code=409, detail="已购代理不能从共享库存彻底删除")
        proxy_rows = conn.execute(
            "SELECT id FROM social_proxies WHERE market_item_id = ?",
            (clean_item_id,),
        ).fetchall()
        proxy_ids = [str(proxy_row["id"] or "") for proxy_row in proxy_rows if str(proxy_row["id"] or "")]
        impact = _proxy_usage_impact(conn, proxy_ids)
        if (impact["bound_accounts"] or impact["running_tasks"]) and not confirm_impact:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "proxy_market_purge_confirmation_required",
                    "message": "该代理仍有关联账号或运行任务，确认影响后才能彻底删除",
                    "impact": impact,
                },
            )
        tasks = conn.execute(
            """
            SELECT task.*
            FROM social_automation_tasks task
            JOIN social_accounts account ON account.id = task.account_id
            WHERE account.proxy_id IN ({placeholders})
              AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
            """.format(placeholders=",".join("?" for _ in proxy_ids) or "''"),
            tuple(proxy_ids),
        ).fetchall() if proxy_ids else []
        cancelled_task_ids = cancel_social_tasks_in_transaction(
            conn,
            list(tasks),
            reason="管理员彻底删除共享代理",
            now=now,
        )
        if proxy_ids:
            placeholders = ",".join("?" for _ in proxy_ids)
            conn.execute(
                f"UPDATE social_accounts SET proxy_id = '', updated_at = ? WHERE proxy_id IN ({placeholders})",
                (now, *proxy_ids),
            )
            conn.execute(
                f"DELETE FROM social_proxies WHERE id IN ({placeholders})",
                tuple(proxy_ids),
            )
        conn.execute(
            """
            UPDATE proxy_market_allocations
            SET status = 'revoked', released_at = ?, updated_at = ?
            WHERE item_id = ? AND status = 'active'
            """,
            (now, now, clean_item_id),
        )
        conn.execute("DELETE FROM proxy_market_allocations WHERE item_id = ?", (clean_item_id,))
        conn.execute("DELETE FROM proxy_market_shares WHERE item_id = ?", (clean_item_id,))
        conn.execute("DELETE FROM proxy_market_item_checks WHERE item_id = ?", (clean_item_id,))
        conn.execute("DELETE FROM proxy_market_publish_receipts WHERE item_id = ?", (clean_item_id,))
        deleted = conn.execute("DELETE FROM proxy_market_items WHERE id = ?", (clean_item_id,)).rowcount
        if deleted != 1:
            raise HTTPException(status_code=409, detail="代理库存已发生变化，请刷新后重试")
        if request is not None:
            _record_audit(
                conn,
                request,
                actor_user_id=actor_user_id,
                action="proxy_market.item.purge",
                resource_type="proxy_market_item",
                resource_id=clean_item_id,
                after={
                    "sku": str(item.get("sku") or ""),
                    "host": str(item.get("host") or ""),
                    "deleted_proxy_count": len(proxy_ids),
                    "revoked_allocation": True,
                },
                risk_level="high",
            )
    cleanup_cancelled_social_tasks_runtime(cancelled_task_ids)
    return {"ok": True, "deleted": True, "item_id": clean_item_id, "impact": impact}


def list_owned_market_shares(item_id: str) -> dict[str, Any]:
    clean_item_id = str(item_id or "").strip()
    with db() as conn:
        row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (clean_item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="代理不存在")
        item = dict(row)
        if not _is_purchased_item(item):
            raise HTTPException(status_code=409, detail="只能共享已购代理")
        shares = conn.execute(
            """
            SELECT share.user_id, share.social_proxy_id, share.updated_at,
                   user.username, user.full_name, user.is_admin
            FROM proxy_market_shares share
            JOIN users user ON user.id = share.user_id
            WHERE share.item_id = ? AND share.status = 'active'
            ORDER BY share.updated_at DESC, share.user_id ASC
            """,
            (clean_item_id,),
        ).fetchall()
    users = [
        {
            "user_id": int(share["user_id"] or 0),
            "username": str(share["username"] or ""),
            "full_name": str(share["full_name"] or ""),
            "social_proxy_id": str(share["social_proxy_id"] or ""),
            "updated_at": int(share["updated_at"] or 0),
        }
        for share in shares
    ]
    return {
        "ok": True,
        "item_id": clean_item_id,
        "owner_user_id": int(item.get("owner_user_id") or 0),
        "users": users,
        "user_ids": [int(user["user_id"]) for user in users],
    }


def set_owned_market_shares(
    item_id: str,
    *,
    user_ids: list[int],
    actor_user_id: int,
    request: Request | None = None,
    confirm_impact: bool = False,
) -> dict[str, Any]:
    clean_item_id = str(item_id or "").strip()
    now = _now()
    cancelled_task_ids: list[str] = []
    desired_ids: list[int] = []
    seen: set[int] = set()
    for raw_id in user_ids or []:
        user_id = int(raw_id or 0)
        if user_id > 0 and user_id not in seen:
            seen.add(user_id)
            desired_ids.append(user_id)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (clean_item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="代理不存在")
        item = dict(row)
        if not _is_purchased_item(item):
            raise HTTPException(status_code=409, detail="只能共享已购代理")
        owner_user_id = int(item.get("owner_user_id") or 0)
        desired_ids = [user_id for user_id in desired_ids if user_id != owner_user_id]
        current_rows = conn.execute(
            "SELECT * FROM proxy_market_shares WHERE item_id = ? AND status = 'active'",
            (clean_item_id,),
        ).fetchall()
        current_ids = {int(share["user_id"] or 0) for share in current_rows}
        add_ids = [user_id for user_id in desired_ids if user_id not in current_ids]
        remove_ids = [int(share["user_id"] or 0) for share in current_rows if int(share["user_id"] or 0) not in set(desired_ids)]
        remove_proxy_ids = [
            str(share["social_proxy_id"] or "")
            for share in current_rows
            if int(share["user_id"] or 0) in set(remove_ids) and str(share["social_proxy_id"] or "")
        ]
        impact = _proxy_usage_impact(conn, remove_proxy_ids)
        if (impact["bound_accounts"] or impact["running_tasks"]) and not confirm_impact:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "proxy_market_share_confirmation_required",
                    "message": "取消共享会影响已绑定账号或运行任务，确认后才能保存",
                    "impact": impact,
                },
            )
        for user_id in add_ids:
            target = _require_enabled_user(conn, user_id)
            if int(target.get("is_admin") or 0) == 1:
                continue
            proxy_id = _ensure_owned_social_proxy(
                conn,
                item=item,
                owner_user_id=int(target["id"]),
                now=now,
                purchase_status="shared",
            )
            existing = conn.execute(
                "SELECT id FROM proxy_market_shares WHERE item_id = ? AND user_id = ?",
                (clean_item_id, int(target["id"])),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO proxy_market_shares(
                      id, item_id, user_id, social_proxy_id, status, created_by, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
                    """,
                    (_new_id("proxy_share"), clean_item_id, int(target["id"]), proxy_id, int(actor_user_id), now, now),
                )
            else:
                conn.execute(
                    """
                    UPDATE proxy_market_shares
                    SET social_proxy_id = ?, status = 'active', created_by = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (proxy_id, int(actor_user_id), now, str(existing["id"])),
                )
        if remove_ids:
            tasks = conn.execute(
                f"""
                SELECT task.*
                FROM social_automation_tasks task
                JOIN social_accounts account ON account.id = task.account_id
                WHERE account.proxy_id IN ({",".join("?" for _ in remove_proxy_ids) or "''"})
                  AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
                """,
                tuple(remove_proxy_ids),
            ).fetchall() if remove_proxy_ids else []
            cancelled_task_ids = cancel_social_tasks_in_transaction(
                conn,
                list(tasks),
                reason="管理员取消已购代理共享",
                now=now,
            )
            if remove_proxy_ids:
                placeholders = ",".join("?" for _ in remove_proxy_ids)
                conn.execute(
                    f"UPDATE social_accounts SET proxy_id = '', updated_at = ? WHERE proxy_id IN ({placeholders})",
                    (now, *remove_proxy_ids),
                )
                conn.execute(
                    f"DELETE FROM social_proxies WHERE id IN ({placeholders})",
                    tuple(remove_proxy_ids),
                )
            conn.execute(
                f"""
                UPDATE proxy_market_shares
                SET status = 'revoked', updated_at = ?
                WHERE item_id = ? AND user_id IN ({",".join("?" for _ in remove_ids)}) AND status = 'active'
                """,
                (now, clean_item_id, *remove_ids),
            )
        if request is not None:
            _record_audit(
                conn,
                request,
                actor_user_id=actor_user_id,
                action="proxy_market.item.share",
                resource_type="proxy_market_item",
                resource_id=clean_item_id,
                after={"user_ids": desired_ids, "added": add_ids, "removed": remove_ids},
                risk_level="high",
            )
    cleanup_cancelled_social_tasks_runtime(cancelled_task_ids)
    result = list_owned_market_shares(clean_item_id)
    result.update({"saved": True, "added": add_ids, "removed": remove_ids, "impact": impact})
    return result


def _scrub_legacy_market_proxy_plaintext() -> None:
    with db() as conn:
        conn.execute(
            """
            UPDATE social_proxies
            SET username = '', password = ''
            WHERE market_item_id != ''
              AND (username != '' OR password != '')
            """
        )



def register_proxy_ip_admin_routes(app: FastAPI) -> None:
    """Register only the administrator proxy inventory routes."""
    _scrub_legacy_market_proxy_plaintext()

    @app.get("/api/admin/proxy-market/items")
    def api_admin_proxy_market_items(
        status: str = "",
        health_status: str = "",
        query: str = "",
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        filters = ["1 = 1"]
        params: list[Any] = []
        if str(status or "").strip():
            filters.append("status = ?")
            params.append(str(status).strip())
        if str(health_status or "").strip():
            filters.append("health_status = ?")
            params.append(str(health_status).strip())
        if str(query or "").strip():
            filters.append("(sku LIKE ? OR display_name LIKE ? OR host LIKE ? OR isp LIKE ?)")
            like = f"%{str(query).strip()}%"
            params.extend([like, like, like, like])
        with db() as conn:
            total = int(conn.execute("SELECT COUNT(*) FROM proxy_market_items").fetchone()[0] or 0)
            rows = conn.execute(
                f"SELECT * FROM proxy_market_items WHERE {' AND '.join(filters)} ORDER BY updated_at DESC",
                tuple(params),
            ).fetchall()
        return {"ok": True, "items": [_admin_public(dict(row)) for row in rows], "total": total}

    @app.post("/api/admin/proxy-market/items")
    def api_admin_proxy_market_create(
        payload: ProxyMarketItemPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        actor_id = _actor_user_id(admin)
        item_id = _new_id("proxy_market")
        sku = str(payload.sku or "").strip()
        if not sku or not re.fullmatch(r"[A-Za-z0-9._-]{2,80}", sku):
            raise HTTPException(status_code=400, detail="SKU 仅支持字母、数字、点、下划线和短横线")
        proxy_type = str(payload.proxy_type or "").strip().lower()
        if proxy_type not in PROXY_TYPES or not str(payload.host or "").strip() or not 1 <= int(payload.port or 0) <= 65535:
            raise HTTPException(status_code=400, detail="请填写有效的代理协议、地址和端口")
        if str(payload.ip_type or "").strip() != "static_residential":
            raise HTTPException(status_code=400, detail="公共代理池当前仅支持静态住宅代理")
        username_ciphertext, password_ciphertext = _encrypt_credentials(
            item_id,
            actor_id,
            str(payload.username or ""),
            str(payload.password or ""),
        )
        now = _now()
        with db() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO proxy_market_items(
                      id, sku, display_name, provider_key, proxy_type, host, port,
                      credential_owner_user_id, username_ciphertext, password_ciphertext,
                      country, region, city, isp, ip_type, description, tags_json,
                      use_cases_json, display_price_cents, currency, billing_cycle,
                      status, health_status, expires_at, created_by, updated_by,
                      created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                              'draft', 'pending', ?, ?, ?, ?, ?)
                    """,
                    (
                        item_id,
                        sku,
                        str(payload.display_name or sku).strip(),
                        str(payload.provider_key or "").strip(),
                        proxy_type,
                        str(payload.host or "").strip(),
                        int(payload.port),
                        actor_id,
                        username_ciphertext,
                        password_ciphertext,
                        str(payload.country or "").strip(),
                        str(payload.region or "").strip(),
                        str(payload.city or "").strip(),
                        str(payload.isp or "").strip(),
                        "static_residential",
                        str(payload.description or "").strip(),
                        _json_text_list(payload.tags),
                        _json_text_list(payload.use_cases),
                        int(payload.display_price_cents or 0),
                        str(payload.currency or "TWD").strip().upper(),
                        str(payload.billing_cycle or "month").strip(),
                        int(payload.expires_at or 0),
                        actor_id,
                        actor_id,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="SKU 已存在") from exc
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                action="proxy_market.item.create",
                resource_type="proxy_market_item",
                resource_id=item_id,
                after={"sku": sku, "status": "draft"},
                risk_level="medium",
            )
            row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (item_id,)).fetchone()
        return {"ok": True, "item": _admin_public(dict(row))}

    @app.patch("/api/admin/proxy-market/items/{item_id}")
    def api_admin_proxy_market_patch(
        item_id: str,
        payload: ProxyMarketItemPatch,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        now = _now()
        actor_id = _actor_user_id(admin)
        updates: dict[str, Any] = {}
        fields_set = payload.model_fields_set if hasattr(payload, "model_fields_set") else payload.__fields_set__
        for field in (
            "display_name",
            "provider_key",
            "country",
            "region",
            "city",
            "isp",
            "description",
            "display_price_cents",
            "currency",
            "billing_cycle",
            "expires_at",
        ):
            if field in fields_set:
                value = getattr(payload, field)
                updates[field] = value.strip() if isinstance(value, str) else value
        if "tags" in fields_set:
            updates["tags_json"] = _json_text_list(payload.tags or [])
        if "use_cases" in fields_set:
            updates["use_cases_json"] = _json_text_list(payload.use_cases or [])
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (str(item_id),)).fetchone()
            if current is None:
                raise HTTPException(status_code=404, detail="代理不存在")
            current_data = dict(current)
            active_allocation = conn.execute(
                """
                SELECT 1
                FROM proxy_market_allocations
                WHERE item_id = ? AND status = 'active'
                LIMIT 1
                """,
                (str(item_id),),
            ).fetchone()
            if "status" in fields_set and payload.status is not None:
                requested = str(payload.status).strip().lower()
                if requested not in ITEM_STATUSES:
                    raise HTTPException(status_code=400, detail="未知的代理状态")
                if requested == "allocated":
                    raise HTTPException(
                        status_code=409,
                        detail="allocated 状态只能由有效领取记录产生",
                    )
                if requested == "draft" and active_allocation is not None:
                    raise HTTPException(
                        status_code=409,
                        detail="已有有效领取的代理不能转为 draft",
                    )
                if requested == "active":
                    if not _fresh_and_healthy(
                        current_data,
                        now=now,
                        max_age_seconds=_settings(conn)["health_max_age_seconds"],
                    ):
                        raise HTTPException(
                            status_code=409,
                            detail="代理必须先通过有效的真实检测才能设为可领取",
                        )
                    requested = "allocated" if active_allocation is not None else "active"
                updates["status"] = requested
            requested_expiry = int(
                updates.get("expires_at", current_data.get("expires_at") or 0) or 0
            )
            if requested_expiry and requested_expiry <= now:
                if updates.get("status") in {"active", "allocated"}:
                    raise HTTPException(
                        status_code=409,
                        detail="已过期的代理不能设为可领取",
                    )
                if str(current_data.get("status") or "") in {"active", "allocated"}:
                    updates["status"] = "maintenance"
            if updates:
                updates["updated_by"] = actor_id
                updates["updated_at"] = now
                assignments = ", ".join(f"{field} = ?" for field in updates)
                conn.execute(
                    f"UPDATE proxy_market_items SET {assignments}, version = version + 1 WHERE id = ?",
                    (*updates.values(), str(item_id)),
                )
            proxy_field_map = {
                "display_name": "name",
                "country": "country",
                "region": "region",
                "city": "city",
                "isp": "isp",
                "description": "note",
                "expires_at": "expires_at",
            }
            proxy_updates = {
                target: updates[source]
                for source, target in proxy_field_map.items()
                if source in updates
            }
            if proxy_updates:
                proxy_updates["updated_at"] = now
                proxy_assignments = ", ".join(
                    f"{field} = ?" for field in proxy_updates
                )
                conn.execute(
                    f"""
                    UPDATE social_proxies
                    SET {proxy_assignments}
                    WHERE market_item_id = ?
                    """,
                    (*proxy_updates.values(), str(item_id)),
                )
            if updates.get("status") in {"maintenance", "disabled", "archived"}:
                conn.execute(
                    "UPDATE social_proxies SET status = ?, updated_at = ? WHERE market_item_id = ?",
                    ("disabled" if updates["status"] in {"disabled", "archived"} else "maintenance", now, str(item_id)),
                )
            elif updates.get("status") in {"active", "allocated"}:
                conn.execute(
                    "UPDATE social_proxies SET status = 'active', updated_at = ? WHERE market_item_id = ?",
                    (now, str(item_id)),
                )
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                action="proxy_market.item.update",
                resource_type="proxy_market_item",
                resource_id=str(item_id),
                after={key: value for key, value in updates.items() if key not in {"updated_by", "updated_at"}},
                risk_level="medium",
            )
            row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (str(item_id),)).fetchone()
        return {"ok": True, "item": _admin_public(dict(row))}

    @app.post("/api/admin/proxy-market/inspect")
    def api_admin_proxy_market_inspect(
        payload: ProxyMarketInspectPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        username = str(payload.username or "")
        password = str(payload.password or "")
        resource_id = str(payload.item_id or "").strip() or "candidate"
        item: dict[str, Any] | None = None
        if resource_id != "candidate":
            with db() as conn:
                item_row = conn.execute(
                    "SELECT * FROM proxy_market_items WHERE id = ?",
                    (resource_id,),
                ).fetchone()
            if item_row is None:
                raise HTTPException(status_code=404, detail="代理不存在")
            item = dict(item_row)
        proxy_type, host, port = _validate_proxy_endpoint(
            payload.proxy_type,
            payload.host,
            payload.port,
        )
        if item is not None:
            current_proxy_type, current_host, current_port = _validate_proxy_endpoint(
                item.get("proxy_type"),
                item.get("host"),
                item.get("port"),
            )
            endpoint_unchanged = (
                proxy_type == current_proxy_type
                and host == current_host
                and port == current_port
            )
            if endpoint_unchanged:
                saved_username, saved_password = _decrypt_credentials(item)
                if not username:
                    username = saved_username
                if not password:
                    password = saved_password
        _validate_proxy_credentials(username, password)
        result = _run_proxy_connection_check(
            {
                "proxy_type": proxy_type,
                "host": host,
                "port": port,
                "username": username,
                "password": password,
            }
        )
        safe_result = _scrub_inspection_secrets(
            _proxy_inspection_response(result),
            username,
            password,
        )
        actor_id = _actor_user_id(admin)
        with db() as conn:
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                action="proxy_market.item.inspect",
                resource_type="proxy_market_item",
                resource_id=resource_id,
                after={
                    "proxy_type": proxy_type,
                    "port": port,
                    "country": safe_result["detected"]["country"],
                },
                risk_level="low" if safe_result["ok"] else "medium",
                outcome="success" if safe_result["ok"] else "failed",
                error_code=safe_result["error_code"],
            )
        if not safe_result["ok"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": safe_result["error"] or "代理检测失败，请检查连接信息后重试",
                    "check": safe_result,
                },
            )
        return {"ok": True, "check": safe_result}


    @app.post("/api/admin/proxy-market/items/{item_id}/test-and-publish")
    def api_admin_proxy_market_test_publish(
        item_id: str,
        payload: ProxyMarketPublishPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        actor_id = _actor_user_id(admin)
        with db() as conn:
            row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (str(item_id),)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="代理不存在")
            current = dict(row)
            if str(current.get("status") or "") == "archived":
                raise HTTPException(
                    status_code=409,
                    detail="已归档的代理不能重新检测发布",
                )
            expected_version = int(current.get("version") or 1)
            active_task = conn.execute(
                """
                SELECT task.id
                FROM social_automation_tasks task
                JOIN social_accounts account ON account.id = task.account_id
                JOIN social_proxies proxy ON proxy.id = account.proxy_id
                WHERE proxy.market_item_id = ?
                  AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
                LIMIT 1
                """,
                (str(item_id),),
            ).fetchone()
            if active_task is not None:
                raise HTTPException(status_code=409, detail="该代理正在执行任务，请停止任务后再发布连接配置")
        old_username, old_password = _decrypt_credentials(current)
        username = old_username if payload.username is None else str(payload.username)
        password = old_password if payload.password is None else str(payload.password)
        candidate = {
            "proxy_type": str(payload.proxy_type or current.get("proxy_type") or "socks5").strip().lower(),
            "host": str(payload.host or current.get("host") or "").strip(),
            "port": int(payload.port or current.get("port") or 0),
            "username": username,
            "password": password,
        }
        if candidate["proxy_type"] not in PROXY_TYPES or not candidate["host"]:
            raise HTTPException(status_code=400, detail="代理连接配置无效")
        candidate_expires_at = (
            int(current.get("expires_at") or 0)
            if payload.expires_at is None
            else int(payload.expires_at)
        )
        if candidate_expires_at and candidate_expires_at <= _now():
            raise HTTPException(status_code=409, detail="已过期的代理不能检测发布")
        result = _run_proxy_connection_check(candidate)
        if not bool(result.get("ok")):
            with db() as conn:
                _record_audit(
                    conn,
                    request,
                    actor_user_id=actor_id,
                    action="proxy_market.item.test_publish",
                    resource_type="proxy_market_item",
                    resource_id=str(item_id),
                    after={"candidate_check": "failed", "error_code": str(result.get("error_code") or "")},
                    risk_level="medium",
                )
            raise HTTPException(status_code=409, detail={"message": "代理检测失败，现有线上配置未被替换", "check": governance.redact(result)})
        username_ciphertext, password_ciphertext = _encrypt_credentials(
            str(item_id),
            actor_id,
            username,
            password,
        )
        now = _now()
        response = result.get("response") if isinstance(result.get("response"), dict) else {}
        detected_ip_type = str(result.get("network_type") or "").strip().lower()
        if detected_ip_type not in {"static_residential", "datacenter"}:
            detected_ip_type = str(current.get("ip_type") or "static_residential").strip().lower()
        if detected_ip_type not in {"static_residential", "datacenter"}:
            detected_ip_type = "static_residential"
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            status_row = conn.execute(
                "SELECT * FROM proxy_market_items WHERE id = ?",
                (str(item_id),),
            ).fetchone()
            if status_row is None:
                raise HTTPException(status_code=404, detail="代理不存在")
            if int(status_row["version"] or 1) != expected_version:
                raise HTTPException(
                    status_code=409,
                    detail="代理已被其他管理员修改，请重新检测后发布",
                )
            active_task = conn.execute(
                """
                SELECT task.id
                FROM social_automation_tasks task
                JOIN social_accounts account ON account.id = task.account_id
                JOIN social_proxies proxy ON proxy.id = account.proxy_id
                WHERE proxy.market_item_id = ?
                  AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
                LIMIT 1
                """,
                (str(item_id),),
            ).fetchone()
            if active_task is not None:
                raise HTTPException(
                    status_code=409,
                    detail="代理检测期间出现执行中任务，请停止任务后重新发布",
                )
            active_allocation = conn.execute(
                """
                SELECT 1
                FROM proxy_market_allocations
                WHERE item_id = ? AND status = 'active'
                LIMIT 1
                """,
                (str(item_id),),
            ).fetchone()
            next_status = "allocated" if active_allocation is not None else "active"
            published_at = int(status_row["published_at"] or 0) or now
            expires_at = candidate_expires_at
            updated_count = conn.execute(
                """
                UPDATE proxy_market_items
                SET proxy_type = ?, host = ?, port = ?, ip_type = ?, credential_owner_user_id = ?,
                    username_ciphertext = ?, password_ciphertext = ?,
                    country = CASE WHEN ? != '' THEN ? ELSE country END,
                    region = CASE WHEN ? != '' THEN ? ELSE region END,
                    city = CASE WHEN ? != '' THEN ? ELSE city END,
                    isp = CASE WHEN ? != '' THEN ? ELSE isp END,
                    status = ?, health_status = 'healthy', latency_ms = ?,
                    last_check_at = ?, last_check_result_json = ?, expires_at = ?,
                    published_at = ?, updated_by = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND version = ?
                """,
                (
                    candidate["proxy_type"],
                    candidate["host"],
                    candidate["port"],
                    detected_ip_type,
                    actor_id,
                    username_ciphertext,
                    password_ciphertext,
                    str(response.get("country") or ""),
                    str(response.get("country") or ""),
                    str(response.get("region") or ""),
                    str(response.get("region") or ""),
                    str(response.get("city") or ""),
                    str(response.get("city") or ""),
                    str((response.get("connection") or {}).get("isp") or ""),
                    str((response.get("connection") or {}).get("isp") or ""),
                    next_status,
                    int(result.get("latency_ms") or 0),
                    now,
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    expires_at,
                    published_at,
                    actor_id,
                    now,
                    str(item_id),
                    expected_version,
                ),
            ).rowcount
            if updated_count != 1:
                raise HTTPException(
                    status_code=409,
                    detail="代理已被其他管理员修改，请重新检测后发布",
                )
            conn.execute(
                """
                UPDATE social_proxies
                SET proxy_type = ?, host = ?, port = ?, ip_type = ?, username = '', password = '',
                    country = ?, region = ?, city = ?, isp = ?, expires_at = ?,
                    status = 'active', last_check_at = ?, last_check_result = ?, updated_at = ?
                WHERE market_item_id = ?
                """,
                (
                    candidate["proxy_type"],
                    candidate["host"],
                    candidate["port"],
                    detected_ip_type,
                    str(response.get("country") or current.get("country") or ""),
                    str(response.get("region") or current.get("region") or ""),
                    str(response.get("city") or current.get("city") or ""),
                    str((response.get("connection") or {}).get("isp") or current.get("isp") or ""),
                    expires_at,
                    now,
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    now,
                    str(item_id),
                ),
            )
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                action="proxy_market.item.test_publish",
                resource_type="proxy_market_item",
                resource_id=str(item_id),
                after={"status": next_status, "health_status": "healthy", "latency_ms": int(result.get("latency_ms") or 0)},
                risk_level="high",
            )
            updated = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (str(item_id),)).fetchone()
        return {"ok": True, "item": _admin_public(dict(updated)), "check": governance.redact(result)}

    @app.post("/api/admin/proxy-market/items/{item_id}/archive")
    def api_admin_proxy_market_archive(
        item_id: str,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        payload = ProxyMarketItemPatch(status="archived")
        return api_admin_proxy_market_patch(item_id, payload, request, admin)

    @app.post("/api/admin/proxy-market/items/{item_id}/purge")
    def api_admin_proxy_market_purge(
        item_id: str,
        request: Request,
        payload: ProxyMarketPurgePayload | None = None,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        return purge_shared_market_item(
            item_id,
            actor_user_id=_actor_user_id(admin),
            request=request,
            confirm_impact=bool(payload and payload.confirm_impact),
        )

    @app.get("/api/admin/proxy-market/items/{item_id}/shares")
    def api_admin_proxy_market_shares(
        item_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        return list_owned_market_shares(item_id)

    @app.put("/api/admin/proxy-market/items/{item_id}/shares")
    def api_admin_proxy_market_shares_save(
        item_id: str,
        payload: ProxyMarketSharePayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        return set_owned_market_shares(
            item_id,
            user_ids=list(payload.user_ids or []),
            actor_user_id=_actor_user_id(admin),
            request=request,
            confirm_impact=bool(payload.confirm_impact),
        )

    @app.get("/api/admin/proxy-market/allocations")
    def api_admin_proxy_market_allocations(
        status: str = "",
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        filters = ["1 = 1"]
        params: list[Any] = []
        if str(status or "").strip():
            filters.append("allocation.status = ?")
            params.append(str(status).strip())
        with db() as conn:
            rows = conn.execute(
                f"""
                SELECT allocation.*, item.sku, item.display_name, user.username,
                       proxy.name AS proxy_name,
                       (SELECT COUNT(*) FROM social_accounts account WHERE account.proxy_id = allocation.social_proxy_id) AS bound_account_count,
                       (
                         SELECT COUNT(*)
                         FROM social_automation_tasks task
                         JOIN social_accounts account ON account.id = task.account_id
                         WHERE account.proxy_id = allocation.social_proxy_id
                           AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
                       ) AS running_task_count
                FROM proxy_market_allocations allocation
                JOIN proxy_market_items item ON item.id = allocation.item_id
                JOIN users user ON user.id = allocation.user_id
                LEFT JOIN social_proxies proxy ON proxy.id = allocation.social_proxy_id
                WHERE {' AND '.join(filters)}
                ORDER BY allocation.claimed_at DESC
                """,
                tuple(params),
            ).fetchall()
            total = int(conn.execute("SELECT COUNT(*) FROM proxy_market_allocations").fetchone()[0] or 0)
        return {"ok": True, "items": [dict(row) for row in rows], "total": total}

    @app.post("/api/admin/proxy-market/allocations/{allocation_id}/revoke")
    def api_admin_proxy_market_revoke(
        allocation_id: str,
        request: Request,
        payload: ProxyMarketRevokePayload | None = None,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        now = _now()
        cancelled_task_ids: list[str] = []
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            allocation = conn.execute(
                "SELECT * FROM proxy_market_allocations WHERE id = ? AND status = 'active'",
                (str(allocation_id),),
            ).fetchone()
            if allocation is None:
                raise HTTPException(status_code=404, detail="有效领取记录不存在")
            proxy_id = str(allocation["social_proxy_id"] or "")
            accounts = conn.execute(
                """
                SELECT id, username, platform
                FROM social_accounts
                WHERE proxy_id = ?
                ORDER BY username
                """,
                (proxy_id,),
            ).fetchall()
            tasks = conn.execute(
                """
                SELECT task.*, account.username
                FROM social_automation_tasks task
                JOIN social_accounts account ON account.id = task.account_id
                WHERE account.proxy_id = ?
                  AND task.status IN ('preparing', 'queued', 'running', 'need_manual')
                ORDER BY task.created_at
                """,
                (proxy_id,),
            ).fetchall()
            impact = {
                "bound_accounts": [
                    {
                        "id": str(row["id"] or ""),
                        "username": str(row["username"] or ""),
                        "platform": str(row["platform"] or ""),
                    }
                    for row in accounts
                ],
                "running_tasks": [
                    {
                        "id": str(row["id"] or ""),
                        "task_type": str(row["task_type"] or ""),
                        "status": str(row["status"] or ""),
                        "username": str(row["username"] or ""),
                    }
                    for row in tasks
                ],
            }
            if (accounts or tasks) and not bool(payload and payload.confirm_impact):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "proxy_market_revoke_confirmation_required",
                        "message": "该代理仍有关联账号或运行任务，确认影响后才能强制回收",
                        "impact": impact,
                    },
                )
            cancelled_task_ids = cancel_social_tasks_in_transaction(
                conn,
                list(tasks),
                reason="管理员强制回收公共代理池代理",
                now=now,
            )
            conn.execute(
                "UPDATE social_accounts SET proxy_id = '', updated_at = ? WHERE proxy_id = ?",
                (now, proxy_id),
            )
            deleted = conn.execute(
                "DELETE FROM social_proxies WHERE id = ? AND user_id = ?",
                (proxy_id, int(allocation["user_id"] or 0)),
            ).rowcount
            if deleted != 1:
                raise HTTPException(
                    status_code=409,
                    detail="代理运行记录已发生变化，请刷新后重试",
                )
            conn.execute(
                """
                UPDATE proxy_market_allocations
                SET status = 'revoked', released_at = ?, updated_at = ?
                WHERE id = ? AND status = 'active'
                """,
                (now, now, str(allocation_id)),
            )
            item_id = str(allocation["item_id"] or "")
            item = conn.execute(
                "SELECT * FROM proxy_market_items WHERE id = ?",
                (item_id,),
            ).fetchone()
            if item is not None and str(item["status"] or "") == "allocated":
                can_return = _fresh_and_healthy(
                    dict(item),
                    now=now,
                    max_age_seconds=_settings(conn)["health_max_age_seconds"],
                )
                conn.execute(
                    """
                    UPDATE proxy_market_items
                    SET status = ?, updated_at = ?, version = version + 1
                    WHERE id = ? AND status = 'allocated'
                    """,
                    ("active" if can_return else "maintenance", now, item_id),
                )
            _record_audit(
                conn,
                request,
                actor_user_id=_actor_user_id(admin),
                target_user_id=int(allocation["user_id"] or 0),
                action="proxy_market.allocation.revoke",
                resource_type="proxy_market_allocation",
                resource_id=str(allocation_id),
                after={
                    "item_id": item_id,
                    "social_proxy_id": proxy_id,
                    "status": "revoked",
                },
                risk_level="medium",
            )
        cleanup_cancelled_social_tasks_runtime(cancelled_task_ids)
        return {
            "ok": True,
            "impact": impact,
            "released": True,
            "allocation_id": str(allocation_id),
            "item_id": item_id,
        }

    @app.get("/api/admin/proxy-market/settings")
    def api_admin_proxy_market_settings(_admin: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            return {"ok": True, "settings": _settings(conn)}

    @app.patch("/api/admin/proxy-market/settings")
    def api_admin_proxy_market_settings_patch(
        payload: ProxyMarketSettingsPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        data = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        now = _now()
        with db() as conn:
            set_admin_config(conn, MARKET_SETTINGS_KEY, data, now)
            _record_audit(
                conn,
                request,
                actor_user_id=_actor_user_id(admin),
                action="proxy_market.settings.update",
                resource_type="admin_config",
                resource_id=MARKET_SETTINGS_KEY,
                after=data,
                risk_level="medium",
            )
        return {"ok": True, "settings": data}

    @app.patch("/api/admin/users/{user_id}/proxy-market-limit")
    def api_admin_proxy_market_user_limit(
        user_id: int,
        payload: ProxyMarketUserLimitPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        now = _now()
        override = payload.claim_limit_override
        with db() as conn:
            _require_enabled_user(conn, int(user_id))
            conn.execute(
                """
                INSERT INTO proxy_market_user_state(user_id, claim_limit_override, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                  claim_limit_override = excluded.claim_limit_override,
                  updated_at = excluded.updated_at
                """,
                (int(user_id), override, now),
            )
            _record_audit(
                conn,
                request,
                actor_user_id=_actor_user_id(admin),
                target_user_id=int(user_id),
                action="proxy_market.user_limit.update",
                resource_type="user",
                resource_id=str(user_id),
                after={"claim_limit_override": override},
                risk_level="medium",
            )
            limit = _claim_limit(conn, int(user_id))
        return {"ok": True, "user_id": int(user_id), "claim_limit": limit, "claim_limit_override": override}

def _claim_limit_from_state(state: dict[str, Any], settings: dict[str, int]) -> int:
    override = state.get("claim_limit_override")
    return int(override) if override is not None else int(settings["default_claim_limit"])
