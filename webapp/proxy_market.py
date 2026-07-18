from __future__ import annotations

import ipaddress
import json
import re
import socket
import sqlite3
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
ITEM_STATUSES = {"draft", "active", "allocated", "maintenance", "disabled", "archived"}
HEALTH_STATUSES = {"pending", "healthy", "failed"}
PROXY_TYPES = {"http", "https", "socks5"}


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


class ProxyMarketCheckedPublishPayload(BaseModel):
    check_id: str = Field(default="", max_length=80)


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
        raise HTTPException(status_code=503, detail="商城代理凭据暂时不可用") from exc


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


def _prune_proxy_market_checks(
    conn: sqlite3.Connection,
    *,
    now: int,
    max_age_seconds: int,
) -> None:
    conn.execute(
        """
        UPDATE proxy_market_item_checks
        SET username_ciphertext = '', password_ciphertext = ''
        WHERE consumed_at > 0
          AND (username_ciphertext != '' OR password_ciphertext != '')
        """
    )
    conn.execute(
        """
        DELETE FROM proxy_market_item_checks
        WHERE consumed_at = 0 AND checked_at < ?
        """,
        (int(now) - int(max_age_seconds),),
    )


def _market_public(
    item: dict[str, Any],
    *,
    now: int,
    health_max_age_seconds: int,
    last_seen_at: int = 0,
) -> dict[str, Any]:
    available = (
        str(item.get("status") or "") == "active"
        and _fresh_and_healthy(item, now=now, max_age_seconds=health_max_age_seconds)
    )
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
        "health_status": str(item.get("health_status") or "pending"),
        "latency_ms": int(item.get("latency_ms") or 0),
        "last_check_at": int(item.get("last_check_at") or 0),
        "expires_at": int(item.get("expires_at") or 0),
        "published_at": int(item.get("published_at") or 0),
        "available": available,
        "is_new": int(item.get("published_at") or 0) > int(last_seen_at or 0),
    }


def _admin_public(
    item: dict[str, Any],
    *,
    health_max_age_seconds: int | None = None,
) -> dict[str, Any]:
    result = _market_public(
        item,
        now=_now(),
        health_max_age_seconds=(
            int(health_max_age_seconds)
            if health_max_age_seconds is not None
            else _settings_for_item_admin()
        ),
    )
    result.update(
        {
            "host": str(item.get("host") or ""),
            "port": int(item.get("port") or 0),
            "username_configured": bool(str(item.get("username_ciphertext") or "")),
            "password_configured": bool(str(item.get("password_ciphertext") or "")),
            "status": str(item.get("status") or "draft"),
            "last_check_result": _safe_check_result(item.get("last_check_result_json")),
            "pending_check_id": str(item.get("pending_check_id") or ""),
            "pending_check_status": str(item.get("pending_check_status") or ""),
            "pending_checked_at": int(item.get("pending_checked_at") or 0),
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
            raise HTTPException(status_code=409, detail="该代理不是商城代理")
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
            raise HTTPException(status_code=409, detail="商城领取记录已失效")
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


def register_proxy_market_routes(app: FastAPI) -> None:
    _scrub_legacy_market_proxy_plaintext()

    @app.get("/api/proxy-market/catalog")
    def api_proxy_market_catalog(
        country: str = "",
        region: str = "",
        city: str = "",
        isp: str = "",
        proxy_type: str = "",
        ip_type: str = "",
        health_status: str = "",
        use_case: str = "",
        tag: str = "",
        availability: str = "available",
        min_price_cents: int = Query(default=0, ge=0),
        max_price_cents: int = Query(default=0, ge=0),
        valid_for_days: int = Query(default=0, ge=0, le=3650),
        sort: str = "recommended",
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=24, ge=1, le=100),
    ):
        now = _now()
        with db() as conn:
            settings = _settings(conn)
        filters = ["status IN ('active', 'allocated')"]
        params: list[Any] = []
        for field, value in (
            ("country", country),
            ("region", region),
            ("city", city),
            ("isp", isp),
            ("proxy_type", proxy_type),
            ("ip_type", ip_type),
            ("health_status", health_status),
        ):
            clean = str(value or "").strip()
            if clean:
                filters.append(f"{field} = ? COLLATE NOCASE")
                params.append(clean)
        clean_use_case = str(use_case or "").strip()
        if clean_use_case:
            filters.append("use_cases_json LIKE ?")
            params.append(f'%"{clean_use_case}"%')
        clean_tag = str(tag or "").strip()
        if clean_tag:
            filters.append("tags_json LIKE ?")
            params.append(f'%"{clean_tag}"%')
        if min_price_cents:
            filters.append("display_price_cents >= ?")
            params.append(int(min_price_cents))
        if max_price_cents:
            if min_price_cents and max_price_cents < min_price_cents:
                raise HTTPException(status_code=400, detail="最高价格不能低于最低价格")
            filters.append("display_price_cents <= ?")
            params.append(int(max_price_cents))
        if valid_for_days:
            filters.append("(expires_at = 0 OR expires_at >= ?)")
            params.append(now + int(valid_for_days) * 24 * 60 * 60)
        availability_value = str(availability or "available").strip().lower()
        if availability_value == "available":
            filters.append("status = 'active'")
            filters.append("health_status = 'healthy'")
            filters.append("last_check_at >= ?")
            params.append(now - settings["health_max_age_seconds"])
            filters.append("(expires_at = 0 OR expires_at > ?)")
            params.append(now)
        elif availability_value == "unavailable":
            filters.append(
                "(status != 'active' OR health_status != 'healthy' OR last_check_at < ? OR (expires_at > 0 AND expires_at <= ?))"
            )
            params.extend([now - settings["health_max_age_seconds"], now])
        order_by = {
            "latency": "latency_ms ASC, published_at DESC",
            "newest": "published_at DESC, updated_at DESC",
            "price_asc": "display_price_cents ASC, published_at DESC",
            "price_desc": "display_price_cents DESC, published_at DESC",
        }.get(str(sort or "").strip().lower(), "health_status DESC, published_at DESC, latency_ms ASC")
        where = " AND ".join(filters)
        offset = (page - 1) * page_size
        with db() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) FROM proxy_market_items WHERE {where}", tuple(params)).fetchone()[0])
            rows = conn.execute(
                f"SELECT * FROM proxy_market_items WHERE {where} ORDER BY {order_by} LIMIT ? OFFSET ?",
                (*params, page_size, offset),
            ).fetchall()
            facets = {
                "countries": [str(row[0]) for row in conn.execute("SELECT DISTINCT country FROM proxy_market_items WHERE status = 'active' AND country != '' ORDER BY country").fetchall()],
                "regions": [str(row[0]) for row in conn.execute("SELECT DISTINCT region FROM proxy_market_items WHERE status = 'active' AND region != '' ORDER BY region").fetchall()],
                "cities": [str(row[0]) for row in conn.execute("SELECT DISTINCT city FROM proxy_market_items WHERE status = 'active' AND city != '' ORDER BY city").fetchall()],
                "isps": [str(row[0]) for row in conn.execute("SELECT DISTINCT isp FROM proxy_market_items WHERE status = 'active' AND isp != '' ORDER BY isp").fetchall()],
                "use_cases": sorted({case for row in conn.execute("SELECT use_cases_json FROM proxy_market_items WHERE status = 'active'").fetchall() for case in _json_list(row[0])}),
                "tags": sorted({tag_value for row in conn.execute("SELECT tags_json FROM proxy_market_items WHERE status = 'active'").fetchall() for tag_value in _json_list(row[0])}),
            }
        items = [
            _market_public(
                dict(row),
                now=now,
                health_max_age_seconds=settings["health_max_age_seconds"],
            )
            for row in rows
        ]
        return {
            "ok": True,
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "facets": facets,
            "stats": {
                "available": sum(1 for item in items if item["available"]),
                "regions": len(facets["regions"]),
                "healthy": sum(1 for item in items if item["health_status"] == "healthy"),
                "best_latency_ms": min((item["latency_ms"] for item in items if item["latency_ms"] > 0), default=0),
            },
        }

    @app.get("/api/proxy-market/me")
    def api_proxy_market_me(user: dict[str, Any] = Depends(get_current_user)):
        user_id = _owner_user_id(user)
        now = _now()
        with db() as conn:
            account = _require_enabled_user(conn, user_id)
            state = _user_state(conn, user_id)
            settings = _settings(conn)
            used = int(
                conn.execute(
                    "SELECT COUNT(*) FROM proxy_market_allocations WHERE user_id = ? AND status = 'active'",
                    (user_id,),
                ).fetchone()[0]
            )
            unread_catalog = int(
                conn.execute(
                    "SELECT COUNT(*) FROM proxy_market_items WHERE status = 'active' AND published_at > ?",
                    (int(state["last_catalog_seen_at"] or 0),),
                ).fetchone()[0]
            )
            unread_proxy = int(
                conn.execute(
                    "SELECT COUNT(*) FROM proxy_market_allocations WHERE user_id = ? AND status = 'active' AND seen_at = 0",
                    (user_id,),
                ).fetchone()[0]
            )
        return {
            "ok": True,
            "user_id": user_id,
            "user": {
                "id": user_id,
                "username": str(account.get("username") or ""),
                "full_name": str(account.get("full_name") or ""),
                "is_admin": bool(int(account.get("is_admin") or 0)),
                "managed_by_admin": bool(user.get("_workspace_user_id")),
            },
            "claim_limit": _claim_limit_from_state(state, settings),
            "claimed_count": used,
            "remaining": max(0, _claim_limit_from_state(state, settings) - used),
            "unread_catalog_count": unread_catalog,
            "unread_proxy_count": unread_proxy,
            "server_time": now,
        }

    @app.post("/api/proxy-market/items/{item_id}/claim")
    def api_proxy_market_claim(
        item_id: str,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        owner_id = _owner_user_id(user)
        actor_id = _actor_user_id(user)
        clean_key = str(idempotency_key or request.headers.get("X-Idempotency-Key") or "")[:128]
        now = _now()
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            _require_enabled_user(conn, owner_id)
            if clean_key:
                replay = conn.execute(
                    "SELECT * FROM proxy_market_allocations WHERE user_id = ? AND idempotency_key = ?",
                    (owner_id, clean_key),
                ).fetchone()
                if replay is not None:
                    if str(replay["item_id"] or "") != str(item_id):
                        raise HTTPException(
                            status_code=409,
                            detail="Idempotency-Key 已绑定到其他商城代理",
                        )
                    return {"ok": True, "replayed": True, "allocation": dict(replay)}
            used = int(
                conn.execute(
                    "SELECT COUNT(*) FROM proxy_market_allocations WHERE user_id = ? AND status = 'active'",
                    (owner_id,),
                ).fetchone()[0]
            )
            limit = _claim_limit(conn, owner_id)
            if used >= limit:
                raise HTTPException(status_code=409, detail=f"商城代理领取数量已达到上限（{limit} 个）")
            row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (str(item_id),)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="商城代理不存在")
            item = dict(row)
            if str(item.get("status") or "") != "active":
                raise HTTPException(status_code=409, detail="该代理已被领取或暂不可用")
            settings = _settings(conn)
            if not _fresh_and_healthy(item, now=now, max_age_seconds=settings["health_max_age_seconds"]):
                raise HTTPException(status_code=409, detail="该代理需要管理员重新检测后才能领取")
            proxy_id = _new_id("social_proxy")
            allocation_id = _new_id("proxy_alloc")
            conn.execute(
                """
                INSERT INTO social_proxies(
                  id, user_id, name, proxy_type, host, port, username, password,
                  country, region, city, isp, source, ip_type, purchase_status,
                  note, expires_at, status, last_check_at, last_check_result,
                  client_request_id, market_item_id, market_allocation_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'marketplace',
                          ?, 'leased', ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    proxy_id,
                    owner_id,
                    str(item.get("display_name") or item.get("sku") or "商城代理"),
                    str(item.get("proxy_type") or "socks5"),
                    str(item.get("host") or ""),
                    int(item.get("port") or 0),
                    "",
                    "",
                    str(item.get("country") or ""),
                    str(item.get("region") or ""),
                    str(item.get("city") or ""),
                    str(item.get("isp") or ""),
                    str(item.get("ip_type") or "static_residential"),
                    str(item.get("description") or "").strip()
                    or f"商城 SKU: {str(item.get('sku') or '')}",
                    int(item.get("expires_at") or 0),
                    int(item.get("last_check_at") or 0),
                    str(item.get("last_check_result_json") or "{}"),
                    clean_key,
                    str(item["id"]),
                    allocation_id,
                    now,
                    now,
                ),
            )
            try:
                conn.execute(
                    """
                    INSERT INTO proxy_market_allocations(
                      id, item_id, user_id, social_proxy_id, status, claim_mode,
                      display_price_cents_snapshot, currency, idempotency_key,
                      claimed_at, released_at, seen_at, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'active', 'free_add', ?, ?, ?, ?, 0, 0, ?, ?)
                    """,
                    (
                        allocation_id,
                        str(item["id"]),
                        owner_id,
                        proxy_id,
                        int(item.get("display_price_cents") or 0),
                        str(item.get("currency") or "TWD"),
                        clean_key,
                        now,
                        now,
                        now,
                    ),
                )
                updated = conn.execute(
                    "UPDATE proxy_market_items SET status = 'allocated', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'active'",
                    (now, str(item["id"])),
                ).rowcount
                if not updated:
                    raise sqlite3.IntegrityError("market item already allocated")
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="该代理刚刚已被其他用户领取") from exc
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                target_user_id=owner_id,
                action="proxy_market.item.claim",
                resource_type="proxy_market_allocation",
                resource_id=allocation_id,
                after={"item_id": str(item["id"]), "social_proxy_id": proxy_id, "claim_mode": "free_add"},
            )
        return {
            "ok": True,
            "allocation": {
                "id": allocation_id,
                "item_id": str(item["id"]),
                "social_proxy_id": proxy_id,
                "status": "active",
                "claimed_at": now,
            },
            "proxy_list_url": "/console.html?view=accounts&browser_panel=proxies",
            "account_binding_url": "/console.html?view=accounts",
        }

    @app.post("/api/proxy-market/allocations/{allocation_id}/release")
    def api_proxy_market_release(
        allocation_id: str,
        request: Request,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        owner_id = _owner_user_id(user)
        with db() as conn:
            allocation = conn.execute(
                "SELECT social_proxy_id FROM proxy_market_allocations WHERE id = ? AND user_id = ? AND status = 'active'",
                (str(allocation_id), owner_id),
            ).fetchone()
        if allocation is None:
            raise HTTPException(status_code=404, detail="商城领取记录不存在")
        result = release_market_proxy(
            str(allocation["social_proxy_id"]),
            owner_user_id=owner_id,
            actor_user_id=_actor_user_id(user),
            request=request,
        )
        return {"ok": True, **result}

    @app.post("/api/proxy-market/read")
    def api_proxy_market_read(
        payload: ProxyMarketReadPayload,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        scope = str(payload.scope or "").strip().lower()
        if scope not in {"catalog", "proxy_pool"}:
            raise HTTPException(status_code=400, detail="未知的已读范围")
        user_id = _owner_user_id(user)
        now = _now()
        with db() as conn:
            conn.execute(
                """
                INSERT INTO proxy_market_user_state(
                  user_id, last_catalog_seen_at, last_proxy_pool_seen_at, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                  last_catalog_seen_at = CASE WHEN ? = 'catalog' THEN excluded.last_catalog_seen_at ELSE last_catalog_seen_at END,
                  last_proxy_pool_seen_at = CASE WHEN ? = 'proxy_pool' THEN excluded.last_proxy_pool_seen_at ELSE last_proxy_pool_seen_at END,
                  updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    now if scope == "catalog" else 0,
                    now if scope == "proxy_pool" else 0,
                    now,
                    scope,
                    scope,
                ),
            )
            if scope == "proxy_pool":
                conn.execute(
                    "UPDATE proxy_market_allocations SET seen_at = ?, updated_at = ? WHERE user_id = ? AND status = 'active' AND seen_at = 0",
                    (now, now, user_id),
                )
        return {"ok": True, "scope": scope, "read_at": now}

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
            filters.append("item.status = ?")
            params.append(str(status).strip())
        if str(health_status or "").strip():
            filters.append("item.health_status = ?")
            params.append(str(health_status).strip())
        if str(query or "").strip():
            filters.append(
                "(item.sku LIKE ? OR item.display_name LIKE ? OR item.host LIKE ? OR item.isp LIKE ?)"
            )
            like = f"%{str(query).strip()}%"
            params.extend([like, like, like, like])
        now = _now()
        with db() as conn:
            health_max_age_seconds = int(_settings(conn)["health_max_age_seconds"])
            _prune_proxy_market_checks(
                conn,
                now=now,
                max_age_seconds=health_max_age_seconds,
            )
            rows = conn.execute(
                f"""
                SELECT item.*,
                       candidate.check_id AS pending_check_id,
                       candidate.health_status AS pending_check_status,
                       candidate.checked_at AS pending_checked_at
                FROM proxy_market_items item
                LEFT JOIN proxy_market_item_checks candidate
                  ON candidate.item_id = item.id
                 AND candidate.consumed_at = 0
                 AND candidate.base_version = item.version
                 AND candidate.checked_at >= ?
                WHERE {' AND '.join(filters)}
                ORDER BY item.updated_at DESC
                """,
                (now - health_max_age_seconds, *params),
            ).fetchall()
        return {"ok": True, "items": [_admin_public(dict(row)) for row in rows]}

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
            raise HTTPException(status_code=400, detail="商城当前仅支持静态住宅代理")
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
                raise HTTPException(status_code=404, detail="商城代理不存在")
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
                    raise HTTPException(status_code=400, detail="未知的商城代理状态")
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
                    raise HTTPException(
                        status_code=409,
                        detail="代理只能通过“真实检测”后使用“发布”进入可领取状态",
                    )
                updates["status"] = requested
            requested_expiry = int(
                updates.get("expires_at", current_data.get("expires_at") or 0) or 0
            )
            if requested_expiry and requested_expiry <= now:
                if updates.get("status") in {"active", "allocated"}:
                    raise HTTPException(
                        status_code=409,
                        detail="已过期的商城代理不能设为可领取",
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
                conn.execute(
                    "DELETE FROM proxy_market_item_checks WHERE item_id = ?",
                    (str(item_id),),
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
                raise HTTPException(status_code=404, detail="商城代理不存在")
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

    @app.post("/api/admin/proxy-market/items/{item_id}/test")
    def api_admin_proxy_market_test(
        item_id: str,
        payload: ProxyMarketPublishPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        actor_id = _actor_user_id(admin)
        with db() as conn:
            row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (str(item_id),)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="商城代理不存在")
            current = dict(row)
            if str(current.get("status") or "") in {"disabled", "archived"}:
                raise HTTPException(
                    status_code=409,
                    detail="已停用或归档的商城代理不能执行真实检测",
                )
            expected_version = int(current.get("version") or 1)
            health_max_age_seconds = int(_settings(conn)["health_max_age_seconds"])
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
            raise HTTPException(status_code=409, detail="已过期的商城代理不能执行真实检测")
        result = _run_proxy_connection_check(candidate)
        safe_result = _scrub_inspection_secrets(
            _proxy_inspection_response(result),
            username,
            password,
        )
        check_ok = bool(safe_result.get("ok"))
        username_ciphertext = ""
        password_ciphertext = ""
        if check_ok:
            username_ciphertext, password_ciphertext = _encrypt_credentials(
                str(item_id),
                actor_id,
                username,
                password,
            )
        check_id = _new_id("proxy_check")
        now = _now()
        detected = safe_result.get("detected") if isinstance(safe_result.get("detected"), dict) else {}
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            status_row = conn.execute(
                "SELECT * FROM proxy_market_items WHERE id = ?",
                (str(item_id),),
            ).fetchone()
            if status_row is None:
                raise HTTPException(status_code=404, detail="商城代理不存在")
            if int(status_row["version"] or 1) != expected_version:
                raise HTTPException(
                    status_code=409,
                    detail="商城代理已被其他管理员修改，请重新检测后发布",
                )
            conn.execute(
                """
                INSERT INTO proxy_market_item_checks(
                  item_id, check_id, base_version, proxy_type, host, port,
                  credential_owner_user_id, username_ciphertext, password_ciphertext,
                  country, region, city, isp, expires_at, health_status, latency_ms,
                  checked_at, result_json, created_by, created_at, consumed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(item_id) DO UPDATE SET
                  check_id = excluded.check_id,
                  base_version = excluded.base_version,
                  proxy_type = excluded.proxy_type,
                  host = excluded.host,
                  port = excluded.port,
                  credential_owner_user_id = excluded.credential_owner_user_id,
                  username_ciphertext = excluded.username_ciphertext,
                  password_ciphertext = excluded.password_ciphertext,
                  country = excluded.country,
                  region = excluded.region,
                  city = excluded.city,
                  isp = excluded.isp,
                  expires_at = excluded.expires_at,
                  health_status = excluded.health_status,
                  latency_ms = excluded.latency_ms,
                  checked_at = excluded.checked_at,
                  result_json = excluded.result_json,
                  created_by = excluded.created_by,
                  created_at = excluded.created_at,
                  consumed_at = 0
                """,
                (
                    str(item_id),
                    check_id,
                    expected_version,
                    candidate["proxy_type"],
                    candidate["host"],
                    candidate["port"],
                    actor_id,
                    username_ciphertext,
                    password_ciphertext,
                    str(detected.get("country") or current.get("country") or ""),
                    str(detected.get("region") or current.get("region") or ""),
                    str(detected.get("city") or current.get("city") or ""),
                    str(detected.get("isp") or current.get("isp") or ""),
                    candidate_expires_at,
                    "healthy" if check_ok else "failed",
                    int(safe_result.get("latency_ms") or 0),
                    int(safe_result.get("checked_at") or now),
                    json.dumps(safe_result, ensure_ascii=False, separators=(",", ":")),
                    actor_id,
                    now,
                ),
            )
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                action="proxy_market.item.test",
                resource_type="proxy_market_item",
                resource_id=str(item_id),
                after={
                    "check_id": check_id,
                    "candidate_check": "healthy" if check_ok else "failed",
                    "latency_ms": int(safe_result.get("latency_ms") or 0),
                    "error_code": str(safe_result.get("error_code") or ""),
                },
                risk_level="medium",
                outcome="success" if check_ok else "failed",
                error_code=str(safe_result.get("error_code") or ""),
            )
        response_payload = {
            "ok": check_ok,
            "check_id": check_id,
            "base_version": expected_version,
            "publishable_until": now + health_max_age_seconds,
            "check": safe_result,
        }
        if not check_ok:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "代理检测失败，现有线上配置未被替换",
                    **response_payload,
                },
            )
        return response_payload

    @app.post("/api/admin/proxy-market/items/{item_id}/publish")
    def api_admin_proxy_market_publish(
        item_id: str,
        request: Request,
        payload: ProxyMarketCheckedPublishPayload | None = None,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        actor_id = _actor_user_id(admin)
        now = _now()
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM proxy_market_items WHERE id = ?",
                (str(item_id),),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="商城代理不存在")
            current = dict(row)
            check_id = str(payload.check_id if payload is not None else "").strip()
            if not check_id:
                raise HTTPException(status_code=409, detail="请先完成真实检测后再发布")
            check_row = conn.execute(
                """
                SELECT *
                FROM proxy_market_item_checks
                WHERE item_id = ? AND check_id = ?
                """,
                (str(item_id), check_id),
            ).fetchone()
            if check_row is None:
                raise HTTPException(status_code=409, detail="检测记录不存在或已被更新，请重新检测")
            candidate = dict(check_row)
            settings = _settings(conn)
            if int(candidate.get("consumed_at") or 0) > 0:
                try:
                    receipt = json.loads(str(candidate.get("publish_result_json") or "{}"))
                except json.JSONDecodeError:
                    receipt = {}
                if isinstance(receipt, dict) and isinstance(receipt.get("item"), dict):
                    return {
                        "ok": True,
                        "replayed": True,
                        "item": receipt["item"],
                    }
                raise HTTPException(
                    status_code=409,
                    detail="检测结果已使用且缺少发布回执，请刷新库存状态",
                )
            if str(current.get("status") or "") in {"disabled", "archived"}:
                raise HTTPException(status_code=409, detail="已停用或归档的商城代理不能发布")
            if (
                str(candidate.get("health_status") or "") != "healthy"
                or int(candidate.get("checked_at") or 0)
                < now - int(settings["health_max_age_seconds"])
            ):
                raise HTTPException(
                    status_code=409,
                    detail="检测结果已失败、过期或已使用，请重新检测",
                )
            if int(candidate.get("base_version") or 0) != int(current.get("version") or 1):
                raise HTTPException(
                    status_code=409,
                    detail="检测后库存已发生修改，请重新检测",
                )
            if int(candidate.get("expires_at") or 0) and int(candidate["expires_at"]) <= now:
                raise HTTPException(status_code=409, detail="已过期的商城代理不能发布")
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
                    detail="该代理正在执行任务，请停止任务后再发布连接配置",
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
            published_at = int(current.get("published_at") or 0) or now
            updated_count = conn.execute(
                """
                UPDATE proxy_market_items
                SET proxy_type = ?, host = ?, port = ?, credential_owner_user_id = ?,
                    username_ciphertext = ?, password_ciphertext = ?,
                    country = ?, region = ?, city = ?, isp = ?, expires_at = ?,
                    status = ?, health_status = 'healthy', latency_ms = ?,
                    last_check_at = ?, last_check_result_json = ?, published_at = ?,
                    updated_by = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND version = ?
                """,
                (
                    str(candidate.get("proxy_type") or "socks5"),
                    str(candidate.get("host") or ""),
                    int(candidate.get("port") or 0),
                    int(candidate.get("credential_owner_user_id") or 0),
                    str(candidate.get("username_ciphertext") or ""),
                    str(candidate.get("password_ciphertext") or ""),
                    str(candidate.get("country") or ""),
                    str(candidate.get("region") or ""),
                    str(candidate.get("city") or ""),
                    str(candidate.get("isp") or ""),
                    int(candidate.get("expires_at") or 0),
                    next_status,
                    int(candidate.get("latency_ms") or 0),
                    int(candidate.get("checked_at") or 0),
                    str(candidate.get("result_json") or "{}"),
                    published_at,
                    actor_id,
                    now,
                    str(item_id),
                    int(current.get("version") or 1),
                ),
            ).rowcount
            if updated_count != 1:
                raise HTTPException(
                    status_code=409,
                    detail="商城代理已被其他管理员修改，请刷新后重试",
                )
            conn.execute(
                """
                UPDATE social_proxies
                SET proxy_type = ?, host = ?, port = ?, username = '', password = '',
                    country = ?, region = ?, city = ?, isp = ?, expires_at = ?,
                    status = 'active', last_check_at = ?, last_check_result = ?, updated_at = ?
                WHERE market_item_id = ?
                """,
                (
                    str(candidate.get("proxy_type") or "socks5"),
                    str(candidate.get("host") or ""),
                    int(candidate.get("port") or 0),
                    str(candidate.get("country") or ""),
                    str(candidate.get("region") or ""),
                    str(candidate.get("city") or ""),
                    str(candidate.get("isp") or ""),
                    int(candidate.get("expires_at") or 0),
                    int(candidate.get("checked_at") or 0),
                    str(candidate.get("result_json") or "{}"),
                    now,
                    str(item_id),
                ),
            )
            updated = conn.execute(
                "SELECT * FROM proxy_market_items WHERE id = ?",
                (str(item_id),),
            ).fetchone()
            published_item = _admin_public(
                dict(updated),
                health_max_age_seconds=int(settings["health_max_age_seconds"]),
            )
            conn.execute(
                """
                UPDATE proxy_market_item_checks
                SET consumed_at = ?,
                    username_ciphertext = '',
                    password_ciphertext = '',
                    published_item_version = ?,
                    publish_result_json = ?
                WHERE item_id = ? AND check_id = ? AND consumed_at = 0
                """,
                (
                    now,
                    int(published_item.get("version") or 0),
                    json.dumps(
                        {"item": published_item},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    str(item_id),
                    check_id,
                ),
            )
            _record_audit(
                conn,
                request,
                actor_user_id=actor_id,
                action="proxy_market.item.publish",
                resource_type="proxy_market_item",
                resource_id=str(item_id),
                after={"status": next_status, "health_status": "healthy", "check_id": check_id},
                risk_level="high",
            )
        return {"ok": True, "item": published_item}

    @app.post("/api/admin/proxy-market/items/{item_id}/test-and-publish")
    def api_admin_proxy_market_test_publish(
        item_id: str,
        payload: ProxyMarketPublishPayload,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        tested = api_admin_proxy_market_test(item_id, payload, request, admin)
        published = api_admin_proxy_market_publish(
            item_id,
            request,
            ProxyMarketCheckedPublishPayload(check_id=str(tested.get("check_id") or "")),
            admin,
        )
        published["check"] = tested.get("check")
        return published

    @app.post("/api/admin/proxy-market/items/{item_id}/archive")
    def api_admin_proxy_market_archive(
        item_id: str,
        request: Request,
        admin: dict[str, Any] = Depends(require_admin),
    ):
        payload = ProxyMarketItemPatch(status="archived")
        return api_admin_proxy_market_patch(item_id, payload, request, admin)

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
        return {"ok": True, "items": [dict(row) for row in rows]}

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
                reason="管理员强制回收商城代理",
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
                    detail="商城代理运行记录已发生变化，请刷新后重试",
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
