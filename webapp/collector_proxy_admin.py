from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import requests
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

try:
    from .auth import require_admin
except ImportError:  # collector worker runtime does not ship webapp.auth
    def require_admin(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("admin auth is unavailable on the collector worker")


CONFIG_PATH = Path(os.getenv("COLLECTOR_PROXY_CONFIG_PATH", "/collector-proxy/config.json"))
WEBHOOK_SECRET_PATH = Path(os.getenv("PROXYCHEAP_WEBHOOK_SECRET_PATH", str(CONFIG_PATH.with_name("webhook-secret"))))
WEBHOOK_EVENTS_PATH = Path(os.getenv("PROXYCHEAP_WEBHOOK_EVENTS_PATH", str(CONFIG_PATH.with_name("webhook-events.jsonl"))))
PROXYCHEAP_API_BASE = "https://api.proxy-cheap.com"
ALLOWED_PROTOCOLS = {"http", "https", "socks5"}
TRAFFIC_CACHE_SECONDS = 300
EXHAUSTED_REMAINING_GB = 0.05
LOW_REMAINING_GB = 0.5
MIN_SWITCH_REMAINING_GB = 0.2
_CONFIG_LOCK = threading.RLock()
_WEBHOOK_LOCK = threading.RLock()


class CollectorProxyInspectPayload(BaseModel):
    provider: str = "proxycheap"
    proxy_id: str = Field(default="", max_length=80)
    api_key: str = Field(default="", max_length=512)
    api_secret: str = Field(default="", max_length=512)


class CollectorProxySavePayload(CollectorProxyInspectPayload):
    reader_proxy_id: str = Field(default="", max_length=80)
    account_proxy_id: str = Field(default="", max_length=80)
    account_proxy_mode: str = Field(default="sticky", max_length=20)
    reader_connection: str = Field(default="", max_length=4096)
    account_connection: str = Field(default="", max_length=4096)
    connection: str = Field(default="", max_length=4096)
    host: str = Field(default="", max_length=512)
    port: int = Field(default=0, ge=0, le=65535)
    protocol: str = Field(default="http", max_length=20)
    username: str = Field(default="", max_length=1024)
    password: str = Field(default="", max_length=4096)
    public_reader_enabled: bool = True


class CollectorProxyManualProductPayload(BaseModel):
    proxy_id: str = Field(default="", max_length=80)


class CollectorProxyProductConnectionPayload(BaseModel):
    connection: str = Field(default="", max_length=4096)


class CollectorProxyReaderTogglePayload(BaseModel):
    enabled: bool = False


def _now() -> int:
    return int(time.time())


def _load_config() -> dict[str, Any]:
    try:
        value = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:
        raise HTTPException(status_code=500, detail="采集代理配置无法读取") from exc


def _write_config(value: dict[str, Any]) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(CONFIG_PATH.parent, 0o700)
    handle, temp_name = tempfile.mkstemp(prefix=".collector-proxy-", dir=str(CONFIG_PATH.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, CONFIG_PATH)
        os.chmod(CONFIG_PATH, 0o600)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _webhook_secret() -> str:
    try:
        value = WEBHOOK_SECRET_PATH.read_text(encoding="utf-8").strip()
    except Exception as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value):
        raise HTTPException(status_code=404, detail="not found")
    return value


def _webhook_event_metadata(payload: dict[str, Any], body: bytes, headers: Any) -> dict[str, Any]:
    event_id = str(
        headers.get("x-webhook-id")
        or headers.get("x-event-id")
        or payload.get("event_id")
        or payload.get("eventId")
        or payload.get("id")
        or ""
    ).strip()[:160]
    if not event_id:
        event_id = hashlib.sha256(body).hexdigest()
    event_type = str(payload.get("event") or payload.get("type") or payload.get("name") or "unknown").strip()[:120]
    resource = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    product_id = str(
        resource.get("proxy_id")
        or resource.get("proxyId")
        or resource.get("product_id")
        or resource.get("productId")
        or ""
    ).strip()[:80]
    return {
        "event_id": event_id,
        "event_type": event_type,
        "product_id": product_id,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "received_at": _now(),
    }


def _record_webhook_event(metadata: dict[str, Any]) -> bool:
    with _CONFIG_LOCK, _WEBHOOK_LOCK:
        config = _load_config()
        recent = config.get("webhook_recent_event_ids") if isinstance(config.get("webhook_recent_event_ids"), list) else []
        event_id = str(metadata.get("event_id") or "")
        if event_id in recent:
            return False
        WEBHOOK_EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(WEBHOOK_EVENTS_PATH.parent, 0o700)
        with WEBHOOK_EVENTS_PATH.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(WEBHOOK_EVENTS_PATH, 0o600)
        config["webhook_recent_event_ids"] = (recent + [event_id])[-200:]
        config["webhook_last_event"] = metadata
        _write_config(config)
    return True


def _refresh_proxycheap_after_webhook(metadata: dict[str, Any]) -> None:
    try:
        config = _load_config()
        api_key = str(config.get("provider_api_key") or "").strip()
        api_secret = str(config.get("provider_api_secret") or "").strip()
        if not api_key or not api_secret:
            raise RuntimeError("Proxy-Cheap API credentials are unavailable")
        supplier_products = _fetch_proxycheap_products(api_key, api_secret)
        traffic = _traffic_summary(supplier_products, config)
        with _CONFIG_LOCK:
            latest = _load_config()
            latest["traffic_cache"] = traffic
            products = _normalise_products(latest)
            known = {str(item.get("proxy_id") or "").strip() for item in products}
            ingested: list[str] = []
            for product in supplier_products:
                if not isinstance(product, dict):
                    continue
                proxy_id = str(product.get("id") or "").strip()
                if not proxy_id or proxy_id in known:
                    continue
                if not _is_rotating_residential(product):
                    continue
                if str(product.get("status") or "").strip().upper() != "ACTIVE":
                    continue
                if _is_summary_exhausted(_product_summary(product)):
                    continue
                _onboard_proxy_product(
                    latest,
                    products,
                    product,
                    api_key=api_key,
                    api_secret=api_secret,
                    is_new=True,
                )
                known.add(proxy_id)
                ingested.append(proxy_id)
            if ingested:
                latest = _apply_products(latest, products)
            latest = _maybe_switch_exhausted_reader(latest, traffic)
            latest["webhook_last_refresh"] = {
                "ok": True,
                "event_id": str(metadata.get("event_id") or ""),
                "synced_at": _now(),
                "ingested_ids": ingested,
            }
            _write_config(latest)
    except Exception as exc:
        with _CONFIG_LOCK:
            latest = _load_config()
            latest["webhook_last_refresh"] = {
                "ok": False,
                "event_id": str(metadata.get("event_id") or ""),
                "error": type(exc).__name__,
                "synced_at": _now(),
            }
            _write_config(latest)


def _provider(value: str) -> str:
    clean = str(value or "proxycheap").strip().lower().replace("-", "")
    if clean != "proxycheap":
        raise HTTPException(status_code=400, detail="当前仅支持 Proxy-Cheap API")
    return "proxycheap"


def _clean_proxy_id(value: str) -> str:
    clean = str(value or "").strip()
    if not clean.isdigit() or len(clean) > 20:
        raise HTTPException(status_code=400, detail="请填写有效的 Proxy-Cheap 代理 ID")
    return clean


def _manual_product_ids(config: dict[str, Any]) -> list[str]:
    raw = config.get("manual_product_ids")
    if not isinstance(raw, list):
        return []
    result: list[str] = []
    for value in raw:
        clean = str(value or "").strip()
        if clean.isdigit() and len(clean) <= 20 and clean not in result:
            result.append(clean)
    return result


def _connection_fingerprint(config: dict[str, Any]) -> str:
    import hashlib

    if not config.get("host") or not config.get("port"):
        return ""
    return hashlib.sha256(_proxy_url(config).encode("utf-8")).hexdigest()


def _normalise_products(config: dict[str, Any]) -> list[dict[str, Any]]:
    raw = config.get("products")
    source = raw if isinstance(raw, list) else (list(raw.values()) if isinstance(raw, dict) else [])
    products: list[dict[str, Any]] = []
    seen: set[str] = set()
    account_product_id = _account_product_id(config)
    for value in source:
        if not isinstance(value, dict):
            continue
        proxy_id = str(value.get("proxy_id") or value.get("product_id") or (value.get("product") or {}).get("id") or "").strip()
        if not proxy_id.isdigit() or proxy_id in seen:
            continue
        item = dict(value)
        item["proxy_id"] = proxy_id
        item["product_id"] = proxy_id
        item["product"] = item.get("product") if isinstance(item.get("product"), dict) else {"id": proxy_id}
        item["last_check"] = item.get("last_check") if isinstance(item.get("last_check"), dict) else {}
        item["public_reader_enabled"] = bool(item.get("public_reader_enabled"))
        item["user_set_reader"] = bool(item.get("user_set_reader"))
        item["user_set_traffic_role"] = bool(item.get("user_set_traffic_role"))
        role = str(item.get("traffic_role") or "").strip().lower()
        item["traffic_role"] = role if role in {"dynamic", "sticky"} else ("sticky" if proxy_id == account_product_id else "dynamic")
        item["mode"] = "sticky" if item["traffic_role"] == "sticky" else "rotating"
        products.append(item)
        seen.add(proxy_id)

    reader = _stored_proxy_profile(config, "reader")
    legacy_id = str(reader.get("product_id") or config.get("provider_proxy_id") or (reader.get("product") or {}).get("id") or "").strip()
    if legacy_id.isdigit() and legacy_id not in seen:
        item = {
            **reader,
            "proxy_id": legacy_id,
            "product_id": legacy_id,
            "product": reader.get("product") if isinstance(reader.get("product"), dict) else {"id": legacy_id},
            "last_check": reader.get("last_check") if isinstance(reader.get("last_check"), dict) else {},
            "public_reader_enabled": bool(config.get("public_reader_enabled")),
            "state": str(config.get("state") or "disabled"),
            "reader_rotation_epoch": int(config.get("reader_rotation_epoch") or 0),
            "last_rotation_at": int(config.get("last_rotation_at") or 0),
            "created_at": int(config.get("updated_at") or _now()),
            "updated_at": int(config.get("updated_at") or _now()),
        }
        item["connection_fingerprint"] = _connection_fingerprint(item)
        if item["last_check"].get("ok"):
            item["last_check"] = {**item["last_check"], "connection_fingerprint": item["connection_fingerprint"]}
        products.append(item)
        seen.add(legacy_id)

    for proxy_id in _manual_product_ids(config):
        if proxy_id not in seen:
            products.append({
                "proxy_id": proxy_id, "product_id": proxy_id, "product": {"id": proxy_id},
                "host": "", "port": 0, "protocol": "http", "username": "", "password": "",
                "last_check": {}, "public_reader_enabled": False, "user_set_reader": False,
                "user_set_traffic_role": False, "state": "needs_connection",
                "mode": "rotating", "traffic_role": "dynamic", "created_at": _now(), "updated_at": _now(),
            })
            seen.add(proxy_id)
    return products


def _apply_products(config: dict[str, Any], products: list[dict[str, Any]]) -> dict[str, Any]:
    value = dict(config)
    value["schema"] = "vecto-collector-proxy-v2"
    value["products"] = products
    value["manual_product_ids"] = [str(item.get("proxy_id") or "") for item in products]
    value["revision"] = int(value.get("revision") or 0) + 1
    value["reader_pool_revision"] = int(value.get("reader_pool_revision") or 0) + 1
    value["updated_at"] = _now()
    enabled = [item for item in products if item.get("public_reader_enabled") and item.get("state") == "active"]
    selected_id = str(value.get("selected_product_id") or "")
    primary = next((item for item in enabled if item.get("proxy_id") == selected_id), None)
    primary = primary or (enabled[0] if enabled else (products[0] if products else None))
    value["selected_product_id"] = str(primary.get("proxy_id") or "") if primary else ""
    value["public_reader_enabled"] = bool(enabled)
    if primary:
        profile = dict(primary)
        profile["product_id"] = str(primary.get("proxy_id") or "")
        profile["mode"] = "rotating"
        value["reader_proxy"] = profile
        value["provider_proxy_id"] = profile["product_id"]
        for key in ("host", "port", "protocol", "username", "password", "product", "last_check", "reader_rotation_epoch", "last_rotation_at"):
            value[key] = profile.get(key, {} if key in {"product", "last_check"} else "")
        value["state"] = "active" if enabled else str(primary.get("state") or "disabled")
    else:
        value["reader_proxy"] = {}
        value.update({
            "provider_proxy_id": "", "host": "", "port": 0, "protocol": "http",
            "username": "", "password": "", "product": {}, "last_check": {},
            "public_reader_enabled": False, "state": "disabled",
        })
    return value


def _find_product(products: list[dict[str, Any]], proxy_id: str) -> dict[str, Any]:
    product = next((item for item in products if str(item.get("proxy_id") or "") == proxy_id), None)
    if not product:
        raise HTTPException(status_code=404, detail="代理产品尚未添加")
    return product


def _public_product(item: dict[str, Any]) -> dict[str, Any]:
    fingerprint = _connection_fingerprint(item)
    check = item.get("last_check") if isinstance(item.get("last_check"), dict) else {}
    verified = bool(check.get("ok") and fingerprint and check.get("connection_fingerprint") == fingerprint)
    enabled = bool(item.get("public_reader_enabled") and verified and item.get("state") == "active")
    return {
        "proxy_id": str(item.get("proxy_id") or ""),
        "product": item.get("product") if isinstance(item.get("product"), dict) else {},
        "connection_configured": bool(item.get("host") and item.get("port")),
        "connection_masked": _mask_secret_exact_length(_proxy_url(item)) if item.get("host") and item.get("port") else "",
        "last_check": check,
        "can_enable": verified,
        "public_reader_enabled": enabled,
        "state": str(item.get("state") or "needs_connection"),
        "updated_at": int(item.get("updated_at") or 0),
    }


def _require_admin_console_request(request: Request) -> None:
    if str(request.headers.get("x-admin-console") or "").strip() != "1":
        raise HTTPException(status_code=403, detail="admin console request required")
    supplied = str(request.headers.get("origin") or request.headers.get("referer") or "").strip()
    if not supplied:
        raise HTTPException(status_code=403, detail="same-origin request required")
    parsed = urllib.parse.urlsplit(supplied)
    expected_host = str(request.headers.get("host") or "").strip().lower()
    if not expected_host or str(parsed.netloc or "").strip().lower() != expected_host:
        raise HTTPException(status_code=403, detail="cross-origin request rejected")


def _credentials(payload: CollectorProxyInspectPayload, existing: dict[str, Any]) -> tuple[str, str]:
    key = str(payload.api_key or "").strip() or str(existing.get("provider_api_key") or "").strip()
    secret = str(payload.api_secret or "").strip() or str(existing.get("provider_api_secret") or "").strip()
    if not key or not secret:
        raise HTTPException(status_code=400, detail="API Key 与 API Secret 必须同时填写")
    return key, secret


def _fetch_proxycheap_json(path: str, api_key: str, api_secret: str) -> Any:
    url = f"{PROXYCHEAP_API_BASE}{path}"
    try:
        response = requests.get(
            url,
            headers={
                "X-Api-Key": api_key,
                "X-Api-Secret": api_secret,
                "Accept": "application/json",
                "User-Agent": "Vecto-Collector/1.0",
            },
            timeout=(7, 20),
        )
        if response.status_code in {401, 403}:
            detail = "Proxy-Cheap API 凭据无效或无权读取该代理"
            raise HTTPException(status_code=400, detail=detail)
        if response.status_code == 404:
            detail = "Proxy-Cheap 中未找到该代理 ID"
            raise HTTPException(status_code=400, detail=detail)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Proxy-Cheap API 返回 HTTP {response.status_code}")
        return response.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="暂时无法连接 Proxy-Cheap API") from exc


def _fetch_proxycheap_product(proxy_id: str, api_key: str, api_secret: str) -> dict[str, Any]:
    value = _fetch_proxycheap_json(f"/proxies/{urllib.parse.quote(proxy_id, safe='')}", api_key, api_secret)
    if not isinstance(value, dict):
        raise HTTPException(status_code=502, detail="Proxy-Cheap API 返回格式无效")
    return value


def _fetch_proxycheap_products(api_key: str, api_secret: str) -> list[dict[str, Any]]:
    value = _fetch_proxycheap_json("/proxies", api_key, api_secret)
    products = value.get("proxies") if isinstance(value, dict) else value
    if not isinstance(products, list):
        raise HTTPException(status_code=502, detail="Proxy-Cheap 代理列表返回格式无效")
    return [item for item in products if isinstance(item, dict)]


def _product_summary(product: dict[str, Any]) -> dict[str, Any]:
    bandwidth = product.get("bandwidth") if isinstance(product.get("bandwidth"), dict) else {}
    return {
        "id": str(product.get("id") or ""),
        "status": str(product.get("status") or ""),
        "network_type": str(product.get("networkType") or ""),
        "proxy_type": str(product.get("proxyType") or ""),
        "country_code": str(product.get("countryCode") or ""),
        "created_at": str(product.get("createdAt") or ""),
        "expires_at": str(product.get("expiresAt") or ""),
        "bandwidth_total_gb": bandwidth.get("total"),
        "bandwidth_used_gb": bandwidth.get("used"),
    }


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return number if number >= 0 else default
    except (TypeError, ValueError):
        return default


def _traffic_summary(products: list[dict[str, Any]], config: dict[str, Any] | None = None) -> dict[str, Any]:
    total = 0.0
    used = 0.0
    missing_used = 0
    active = 0
    summaries: list[dict[str, Any]] = []
    for product in products:
        summary = _product_summary(product)
        bandwidth = product.get("bandwidth") if isinstance(product.get("bandwidth"), dict) else {}
        item_total = _number(bandwidth.get("total"))
        raw_used = bandwidth.get("used")
        if raw_used is None:
            missing_used += 1
        item_used = min(item_total, _number(raw_used)) if item_total else _number(raw_used)
        total += item_total
        used += item_used
        if str(product.get("status") or "").upper() == "ACTIVE":
            active += 1
        summary["bandwidth_total_gb"] = item_total
        summary["bandwidth_used_gb"] = item_used
        summary["bandwidth_remaining_gb"] = max(0.0, item_total - item_used)
        summary["usage_reported"] = raw_used is not None
        summaries.append(summary)
    remaining = max(0.0, total - used)
    result = {
        "provider": "proxycheap",
        "product_count": len(summaries),
        "active_product_count": active,
        "total_gb": round(total, 4),
        "used_gb": round(used, 4),
        "remaining_gb": round(remaining, 4),
        "remaining_percent": round((remaining / total * 100.0) if total else 0.0, 2),
        "usage_reported": missing_used == 0,
        "usage_pending_count": missing_used,
        "products": summaries,
        "synced_at": _now(),
    }
    return _attach_traffic_groups(result, config)


def _traffic_product_kind(item: dict[str, Any], account_id: str = "") -> str:
    network = str(item.get("network_type") or item.get("networkType") or "").strip().upper()
    proxy_id = str(item.get("id") or item.get("proxy_id") or "").strip()
    if network == "RESIDENTIAL_STATIC":
        return "sticky"
    if account_id and proxy_id == str(account_id).strip():
        return "sticky"
    if network == "RESIDENTIAL":
        return "rotating"
    return "other"


def _summarize_traffic_group(items: list[dict[str, Any]], *, key: str, label: str) -> dict[str, Any]:
    total = 0.0
    used = 0.0
    remaining = 0.0
    missing_used = 0
    active = 0
    for item in items:
        item_total = _number(item.get("bandwidth_total_gb"))
        raw_used = item.get("bandwidth_used_gb")
        if item.get("usage_reported") is False or raw_used is None:
            missing_used += 1
        item_used = min(item_total, _number(raw_used)) if item_total else _number(raw_used)
        item_remaining = _number(item.get("bandwidth_remaining_gb"), default=-1.0)
        if item_remaining < 0:
            item_remaining = max(0.0, item_total - item_used)
        total += item_total
        used += item_used
        remaining += item_remaining
        if str(item.get("status") or "").upper() == "ACTIVE":
            active += 1
    return {
        "key": key,
        "label": label,
        "product_count": len(items),
        "active_product_count": active,
        "total_gb": round(total, 4),
        "used_gb": round(used, 4),
        "remaining_gb": round(remaining, 4),
        "remaining_percent": round((remaining / total * 100.0) if total else 0.0, 2),
        "usage_pending_count": missing_used,
    }


def _traffic_chart_groups(traffic: dict[str, Any] | None = None, config: dict[str, Any] | None = None) -> dict[str, Any]:
    account_id = _account_product_id(config or {})
    buckets: dict[str, list[dict[str, Any]]] = {"rotating": [], "sticky": []}
    for item in (traffic or {}).get("products") or []:
        if not isinstance(item, dict):
            continue
        kind = _traffic_product_kind(item, account_id)
        if kind == "rotating":
            buckets["rotating"].append(item)
        else:
            buckets["sticky"].append(item)
    return {
        "rotating": _summarize_traffic_group(buckets["rotating"], key="rotating", label="动态 IP"),
        "sticky": _summarize_traffic_group(buckets["sticky"], key="sticky", label="粘性 IP"),
    }


def _attach_traffic_groups(traffic: dict[str, Any] | None, config: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(traffic or {})
    payload["groups"] = _traffic_chart_groups(payload, config)
    return payload


def _is_rotating_residential(value: dict[str, Any]) -> bool:
    network = str(value.get("network_type") or value.get("networkType") or "").strip().upper()
    return network == "RESIDENTIAL"


def _traffic_remaining_gb(traffic: dict[str, Any], proxy_id: str) -> float | None:
    target = str(proxy_id or "").strip()
    if not target:
        return None
    for item in traffic.get("products") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("id") or "") != target:
            continue
        if item.get("bandwidth_remaining_gb") is not None:
            return round(_number(item.get("bandwidth_remaining_gb")), 4)
        total = _number(item.get("bandwidth_total_gb"))
        used = _number(item.get("bandwidth_used_gb"))
        return round(max(0.0, total - used), 4)
    return None


def _is_summary_exhausted(item: dict[str, Any] | None) -> bool:
    if not isinstance(item, dict):
        return False
    total = _number(item.get("bandwidth_total_gb"))
    if total <= 0:
        return False
    remaining = item.get("bandwidth_remaining_gb")
    if remaining is None:
        remaining = max(0.0, total - _number(item.get("bandwidth_used_gb")))
    return float(remaining) <= EXHAUSTED_REMAINING_GB


def _is_metered_traffic_exhausted(traffic: dict[str, Any], proxy_id: str) -> bool:
    remaining = _traffic_remaining_gb(traffic, proxy_id)
    if remaining is None:
        return False
    for item in traffic.get("products") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("id") or "") != str(proxy_id or "").strip():
            continue
        return _is_summary_exhausted(item)
    return False


def _prune_exhausted_products(config: dict[str, Any], traffic: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    products = _normalise_products(config)
    kept: list[dict[str, Any]] = []
    removed: list[str] = []
    for item in products:
        proxy_id = str(item.get("proxy_id") or "")
        if proxy_id and _is_metered_traffic_exhausted(traffic, proxy_id):
            removed.append(proxy_id)
            continue
        kept.append(item)
    if not removed:
        return config, []
    return _apply_products(config, kept), removed


def _account_product_id(config: dict[str, Any]) -> str:
    account = _stored_proxy_profile(config, "account")
    return str(account.get("product_id") or config.get("account_product_id") or "").strip()


def _gateway_from_rotating_products(products: list[dict[str, Any]], config: dict[str, Any]) -> tuple[str, int, str]:
    reader = _stored_proxy_profile(config, "reader")
    if reader.get("host") and int(reader.get("port") or 0) > 0:
        return str(reader.get("host") or ""), int(reader.get("port") or 0), str(reader.get("protocol") or "http")
    for item in products:
        if not item.get("host") or int(item.get("port") or 0) <= 0:
            continue
        product = item.get("product") if isinstance(item.get("product"), dict) else {}
        if _is_rotating_residential(product) or _is_rotating_residential(item):
            return str(item.get("host") or ""), int(item.get("port") or 0), str(item.get("protocol") or "http")
    return "", 0, "http"


def _pick_reader_switch_candidate(
    config: dict[str, Any],
    traffic: dict[str, Any],
    *,
    exclude_ids: set[str],
) -> dict[str, Any] | None:
    products = _normalise_products(config)
    ranked: list[tuple[int, float, dict[str, Any]]] = []
    for item in traffic.get("products") or []:
        if not isinstance(item, dict):
            continue
        proxy_id = str(item.get("id") or "").strip()
        if not proxy_id or proxy_id in exclude_ids:
            continue
        if not _is_rotating_residential(item):
            continue
        if str(item.get("status") or "").upper() != "ACTIVE":
            continue
        remaining = _traffic_remaining_gb(traffic, proxy_id)
        if remaining is None or remaining < MIN_SWITCH_REMAINING_GB:
            continue
        local = next((row for row in products if str(row.get("proxy_id") or "") == proxy_id), None)
        verified = False
        configured = False
        if local is not None:
            fingerprint = _connection_fingerprint(local)
            check = local.get("last_check") if isinstance(local.get("last_check"), dict) else {}
            verified = bool(check.get("ok") and fingerprint and check.get("connection_fingerprint") == fingerprint)
            configured = bool(local.get("host") and local.get("port") and local.get("username"))
        score = 0
        if verified:
            score += 3
        if configured:
            score += 2
        if local is not None:
            score += 1
        ranked.append((score, remaining, item))
    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return ranked[0][2] if ranked else None


def _product_verified(item: dict[str, Any]) -> bool:
    fingerprint = _connection_fingerprint(item)
    check = item.get("last_check") if isinstance(item.get("last_check"), dict) else {}
    return bool(check.get("ok") and fingerprint and check.get("connection_fingerprint") == fingerprint)


def _healthy_active_reader_ids(products: list[dict[str, Any]], *, exclude_id: str = "") -> list[str]:
    exclude = str(exclude_id or "").strip()
    ids: list[str] = []
    for item in products:
        proxy_id = str(item.get("proxy_id") or "").strip()
        if not proxy_id or proxy_id == exclude:
            continue
        if not item.get("public_reader_enabled"):
            continue
        if str(item.get("state") or "") != "active":
            continue
        if str(item.get("traffic_role") or "dynamic") != "dynamic":
            continue
        if _product_verified(item):
            ids.append(proxy_id)
    return ids


def _blank_product_entry(proxy_id: str, summary: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "proxy_id": proxy_id,
        "product_id": proxy_id,
        "product": summary if isinstance(summary, dict) else {"id": proxy_id},
        "host": "",
        "port": 0,
        "protocol": "http",
        "username": "",
        "password": "",
        "last_check": {},
        "connection_fingerprint": "",
        "public_reader_enabled": False,
        "user_set_reader": False,
        "user_set_traffic_role": False,
        "state": "needs_connection",
        "mode": "rotating",
        "traffic_role": "dynamic",
        "created_at": _now(),
        "updated_at": _now(),
    }


def _fill_and_test_product_connection(
    entry: dict[str, Any],
    supplier: dict[str, Any] | None,
    products: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    supplier = supplier if isinstance(supplier, dict) else {}
    authentication = supplier.get("authentication") if isinstance(supplier.get("authentication"), dict) else {}
    host, port, protocol = _product_endpoint(supplier) if supplier else ("", 0, "http")
    if not host or int(port or 0) <= 0:
        host, port, protocol = _gateway_from_rotating_products(products, config)
    if host and int(port or 0) > 0:
        entry["host"] = host
        entry["port"] = int(port)
        entry["protocol"] = protocol or "http"
    if authentication.get("username"):
        entry["username"] = str(authentication.get("username") or "")
        entry["password"] = str(authentication.get("password") or "")
    if not entry.get("host") or int(entry.get("port") or 0) <= 0 or not entry.get("username"):
        entry["last_check"] = {}
        entry["connection_fingerprint"] = ""
        entry["state"] = "needs_connection"
        entry["updated_at"] = _now()
        return {}
    result: dict[str, Any] = {"ok": False}
    for _attempt in range(2):
        try:
            result = _test_connection(entry)
        except HTTPException as exc:
            result = {"ok": False, "error": str(exc.detail), "checked_at": _now()}
        except Exception as exc:
            result = {"ok": False, "error": type(exc).__name__, "checked_at": _now()}
        if result.get("ok"):
            break
    fingerprint = _connection_fingerprint(entry)
    result["connection_fingerprint"] = fingerprint
    entry["connection_fingerprint"] = fingerprint
    entry["last_check"] = result
    entry["updated_at"] = _now()
    return result


def _apply_auto_onboard_defaults(
    entry: dict[str, Any],
    products: list[dict[str, Any]],
    *,
    is_new: bool,
    restore_reader: bool = False,
    config: dict[str, Any] | None = None,
) -> None:
    if not bool(entry.get("user_set_traffic_role")):
        existing_role = str(entry.get("traffic_role") or "").strip().lower()
        if existing_role not in {"dynamic", "sticky"}:
            account_id = _account_product_id(config or {})
            if account_id and str(entry.get("proxy_id") or "") == account_id:
                entry["traffic_role"] = "sticky"
            else:
                entry["traffic_role"] = "dynamic"
    role = str(entry.get("traffic_role") or "dynamic")
    entry["mode"] = "sticky" if role == "sticky" else "rotating"
    verified = _product_verified(entry)
    if not verified:
        entry["public_reader_enabled"] = False
        entry["state"] = "check_failed" if entry.get("last_check") else "needs_connection"
        return
    if role != "dynamic":
        if not bool(entry.get("user_set_reader")):
            entry["public_reader_enabled"] = False
        elif entry.get("public_reader_enabled"):
            entry["public_reader_enabled"] = False
        entry["state"] = "ready"
        return
    if bool(entry.get("user_set_reader")):
        entry["state"] = "active" if entry.get("public_reader_enabled") else "ready"
        return
    others = _healthy_active_reader_ids(products, exclude_id=str(entry.get("proxy_id") or ""))
    if restore_reader or (is_new and not others):
        entry["public_reader_enabled"] = True
        entry["state"] = "active"
        return
    entry["public_reader_enabled"] = False
    entry["state"] = "ready"


def _onboard_proxy_product(
    config: dict[str, Any],
    products: list[dict[str, Any]],
    candidate: dict[str, Any],
    *,
    api_key: str = "",
    api_secret: str = "",
    supplier: dict[str, Any] | None = None,
    is_new: bool | None = None,
    restore_reader: bool = False,
) -> dict[str, Any]:
    proxy_id = str(
        (candidate or {}).get("id")
        or (candidate or {}).get("proxy_id")
        or (supplier or {}).get("id")
        or ""
    ).strip()
    if not proxy_id:
        raise ValueError("proxy id required")
    entry = next((item for item in products if str(item.get("proxy_id") or "") == proxy_id), None)
    created = entry is None
    summary_source = supplier if isinstance(supplier, dict) else candidate
    if entry is None:
        entry = _blank_product_entry(proxy_id, _product_summary(summary_source if isinstance(summary_source, dict) else {}))
        products.append(entry)
    if is_new is None:
        is_new = created
    detail = supplier if isinstance(supplier, dict) else None
    if detail is None and api_key and api_secret:
        try:
            detail = _fetch_proxycheap_product(proxy_id, api_key, api_secret)
        except Exception:
            detail = candidate if isinstance(candidate, dict) else {}
    if not isinstance(detail, dict):
        detail = candidate if isinstance(candidate, dict) else {}
    entry["product"] = _product_summary(detail)
    _fill_and_test_product_connection(entry, detail, products, config)
    _apply_auto_onboard_defaults(
        entry,
        products,
        is_new=bool(is_new),
        restore_reader=restore_reader,
        config=config,
    )
    return entry


def _prepare_reader_product_entry(
    config: dict[str, Any],
    products: list[dict[str, Any]],
    candidate: dict[str, Any],
    *,
    api_key: str,
    api_secret: str,
) -> dict[str, Any] | None:
    proxy_id = str(candidate.get("id") or "").strip()
    if not proxy_id:
        return None
    entry = next((item for item in products if str(item.get("proxy_id") or "") == proxy_id), None)
    supplier = None
    if api_key and api_secret:
        try:
            supplier = _fetch_proxycheap_product(proxy_id, api_key, api_secret)
        except Exception:
            supplier = None
    summary = _product_summary(supplier or candidate)
    if entry is None:
        entry = _blank_product_entry(proxy_id, summary)
        products.append(entry)
    entry["product"] = summary
    entry["mode"] = "rotating"
    result = _fill_and_test_product_connection(entry, supplier or candidate, products, config)
    if not result.get("ok"):
        entry["state"] = "check_failed"
        return None
    return entry


def _maybe_switch_exhausted_reader(config: dict[str, Any], traffic: dict[str, Any]) -> dict[str, Any]:
    value = dict(config)
    value["traffic_cache"] = traffic
    selected_id = str(value.get("selected_product_id") or value.get("provider_proxy_id") or "").strip()
    remaining = _traffic_remaining_gb(traffic, selected_id) if selected_id else None
    account_id = _account_product_id(value)
    warning: dict[str, Any] | None = None
    if remaining is not None and remaining <= EXHAUSTED_REMAINING_GB:
        candidate = _pick_reader_switch_candidate(
            value,
            traffic,
            exclude_ids={item for item in (selected_id, account_id) if item},
        )
        switched_id = ""
        if candidate is not None:
            api_key = str(value.get("provider_api_key") or "").strip()
            api_secret = str(value.get("provider_api_secret") or "").strip()
            products = _normalise_products(value)
            entry = _prepare_reader_product_entry(
                value, products, candidate, api_key=api_key, api_secret=api_secret,
            )
            if entry is not None:
                switched_id = str(entry.get("proxy_id") or "")
                for item in products:
                    proxy_id = str(item.get("proxy_id") or "")
                    if proxy_id == switched_id:
                        item["public_reader_enabled"] = True
                        item["state"] = "active"
                        item["reader_rotation_epoch"] = int(item.get("reader_rotation_epoch") or 0) + 1
                        item["last_rotation_at"] = _now()
                    elif item.get("public_reader_enabled") and _is_rotating_residential(item.get("product") or {}):
                        item["public_reader_enabled"] = False
                        item["state"] = "ready"
                value = _apply_products(value, products)
                value["selected_product_id"] = switched_id
                value["reader_rotation_epoch"] = int(value.get("reader_rotation_epoch") or 0) + 1
                value["last_rotation_at"] = _now()
        if switched_id:
            warning = {
                "level": "error",
                "code": "reader_traffic_switched",
                "message": (
                    f"动态 IP 产品 {selected_id} 流量已耗尽（剩余 {remaining:.2f} GB），"
                    f"已自动切换到可用产品 {switched_id}。"
                ),
                "from_product_id": selected_id,
                "to_product_id": switched_id,
                "remaining_gb": remaining,
                "at": _now(),
            }
        else:
            warning = {
                "level": "error",
                "code": "reader_traffic_exhausted",
                "message": (
                    f"动态 IP 产品 {selected_id or '当前公开抓取'} 流量已耗尽"
                    f"{f'（剩余 {remaining:.2f} GB）' if remaining is not None else ''}，"
                    "没有可自动切换的可用产品。"
                ),
                "from_product_id": selected_id,
                "to_product_id": "",
                "remaining_gb": remaining,
                "at": _now(),
            }
    elif remaining is not None and remaining < LOW_REMAINING_GB:
        warning = {
            "level": "warning",
            "code": "reader_traffic_low",
            "message": f"当前公开抓取动态 IP {selected_id} 剩余 {remaining:.2f} GB，请及时补充流量。",
            "from_product_id": selected_id,
            "to_product_id": "",
            "remaining_gb": remaining,
            "at": _now(),
        }
    else:
        previous = value.get("traffic_warning") if isinstance(value.get("traffic_warning"), dict) else None
        if (
            previous
            and previous.get("code") == "reader_traffic_switched"
            and _now() - int(previous.get("at") or 0) < 6 * 3600
        ):
            warning = previous
    value["traffic_warning"] = warning
    return value


def _product_endpoint(product: dict[str, Any]) -> tuple[str, int, str]:
    connection = product.get("connection") if isinstance(product.get("connection"), dict) else {}
    proxy_type = str(product.get("proxyType") or "HTTP").strip().lower()
    protocol = proxy_type if proxy_type in ALLOWED_PROTOCOLS else "http"
    host = ""
    hostnames = connection.get("hostnames")
    if isinstance(hostnames, list):
        for item in hostnames:
            candidate = item if isinstance(item, str) else str((item or {}).get("hostname") or (item or {}).get("host") or "")
            if candidate.strip():
                host = candidate.strip()
                break
    if not host:
        host = str(connection.get("connectIp") or "").strip()
    port_map = {
        "http": connection.get("httpPort"),
        "https": connection.get("httpsPort"),
        "socks5": connection.get("socks5Port"),
    }
    port = int(port_map.get(protocol) or 0)
    if not port:
        for fallback_protocol in ("http", "https", "socks5"):
            fallback_port = int(port_map.get(fallback_protocol) or 0)
            if fallback_port:
                protocol, port = fallback_protocol, fallback_port
                break
    return host, port, protocol


def _parse_connection(value: str) -> dict[str, Any]:
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        if "://" in text:
            parsed = urllib.parse.urlsplit(text)
            if parsed.scheme.lower() not in ALLOWED_PROTOCOLS or not parsed.hostname or not parsed.port:
                raise ValueError
            return {
                "protocol": parsed.scheme.lower(),
                "host": parsed.hostname,
                "port": parsed.port,
                "username": urllib.parse.unquote(parsed.username or ""),
                "password": urllib.parse.unquote(parsed.password or ""),
            }
        if "@" in text:
            auth, endpoint = text.rsplit("@", 1)
            username, password = auth.split(":", 1)
            host, port = endpoint.rsplit(":", 1)
            return {"protocol": "http", "host": host, "port": int(port), "username": username, "password": password}
        parts = text.split(":")
        if len(parts) >= 4:
            return {"protocol": "http", "host": parts[0], "port": int(parts[1]), "username": parts[2], "password": ":".join(parts[3:])}
        if len(parts) == 2:
            return {"protocol": "http", "host": parts[0], "port": int(parts[1])}
    except (TypeError, ValueError, OverflowError):
        pass
    raise HTTPException(status_code=400, detail="连接串格式无效")


def _validate_endpoint(host: str, port: int, protocol: str) -> tuple[str, int, str]:
    clean_host = str(host or "").strip().strip("[]")
    clean_protocol = str(protocol or "http").strip().lower()
    if clean_protocol not in ALLOWED_PROTOCOLS:
        raise HTTPException(status_code=400, detail="代理协议仅支持 HTTP、HTTPS 或 SOCKS5")
    if not clean_host or int(port or 0) < 1 or int(port) > 65535:
        raise HTTPException(status_code=400, detail="请填写有效的代理主机与端口")
    if any(mark in clean_host for mark in ("/", "@", "?", "#")):
        raise HTTPException(status_code=400, detail="代理主机只能填写域名或 IP")
    try:
        infos = socket.getaddrinfo(clean_host, int(port), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="代理主机无法解析") from exc
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if not address.is_global:
            raise HTTPException(status_code=400, detail="代理地址必须解析到公网 IP")
    return clean_host, int(port), clean_protocol


def _proxy_url(config: dict[str, Any]) -> str:
    username = str(config.get("username") or "")
    password = str(config.get("password") or "")
    auth = ""
    if username or password:
        auth = f"{urllib.parse.quote(username, safe='')}:{urllib.parse.quote(password, safe='')}@"
    return f"{config.get('protocol') or 'http'}://{auth}{config.get('host')}:{int(config.get('port') or 0)}"


def _mask_secret_exact_length(value: Any) -> str:
    return "•" * len(str(value or ""))


def _test_connection(config: dict[str, Any]) -> dict[str, Any]:
    host, port, protocol = _validate_endpoint(config.get("host"), int(config.get("port") or 0), config.get("protocol"))
    test_config = {**config, "host": host, "port": port, "protocol": protocol}
    proxy_url = _proxy_url(test_config)
    started = time.monotonic()
    try:
        response = requests.get(
            "https://api.ipify.org?format=json",
            proxies={"http": proxy_url, "https": proxy_url},
            headers={"User-Agent": "Vecto-Proxy-Probe/1.0"},
            timeout=(7, 18),
        )
        response.raise_for_status()
        exit_ip = str(response.json().get("ip") or "").strip()
        ipaddress.ip_address(exit_ip)
        return {"ok": True, "exit_ip": exit_ip, "latency_ms": int((time.monotonic() - started) * 1000), "checked_at": _now()}
    except Exception as exc:
        text = str(exc or "连接失败")
        for sensitive in (str(config.get("username") or ""), str(config.get("password") or "")):
            if sensitive:
                text = text.replace(sensitive, "***")
        return {"ok": False, "error": text[:240], "checked_at": _now()}


_STICKY_SESSION_PATTERN = re.compile(
    r".*(?:_session-|-session-)[A-Za-z0-9]+(?:_(?:ttl|time|lifetime)-[A-Za-z0-9]+)*$",
    re.IGNORECASE,
)


def _sticky_template_field(config: dict[str, Any]) -> str:
    for field in ("password", "username"):
        if _STICKY_SESSION_PATTERN.fullmatch(str(config.get(field) or "")):
            return field
    return ""


_STICKY_SESSION_TOKEN = re.compile(
    r"((?:_session-|-session-))([A-Za-z0-9]+)((?:_(?:ttl|time|lifetime)-[A-Za-z0-9]+)*)",
    re.IGNORECASE,
)


def _pin_sticky_identity(value: str, account_id: str) -> str:
    text = str(value or "")
    account = str(account_id or "").strip()
    if not text or not account or not _STICKY_SESSION_TOKEN.search(text):
        return text
    token = hashlib.sha256(f"collector-sticky:{account}".encode("utf-8")).hexdigest()[:16]
    return _STICKY_SESSION_TOKEN.sub(lambda match: f"{match.group(1)}{token}{match.group(3)}", text, count=1)


def _proxy_profile_for_account(config: dict[str, Any], proxy_id: str) -> dict[str, Any]:
    clean_id = str(proxy_id or "").strip()
    if not clean_id:
        return {}
    account = _stored_proxy_profile(config, "account")
    if str(account.get("product_id") or "") == clean_id and account.get("host") and account.get("port"):
        return dict(account)
    for item in _normalise_products(config):
        item_id = str(item.get("proxy_id") or item.get("product_id") or "").strip()
        if item_id != clean_id:
            continue
        if item.get("host") and item.get("port"):
            return dict(item)
    if str(config.get("account_product_id") or "") == clean_id and account.get("host") and account.get("port"):
        return dict(account)
    return {}


def _account_sticky_profile(config: dict[str, Any]) -> dict[str, Any]:
    profile = _stored_proxy_profile(config, "account")
    mode = str(profile.get("mode") or config.get("account_proxy_mode") or "sticky").strip().lower()
    if profile.get("host") and int(profile.get("port") or 0) and mode != "static":
        return dict(profile)
    for item in _normalise_products(config):
        item_mode = str(item.get("mode") or "").strip().lower()
        if item_mode == "sticky" and item.get("host") and int(item.get("port") or 0):
            return dict(item)
    return {}


def _record_sticky_session(account_id: str, exit_ip: str, expires_at: int) -> None:
    path = CONFIG_PATH.with_name("account-sessions.json")
    with _CONFIG_LOCK:
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            state = {}
        if not isinstance(state, dict):
            state = {}
        accounts = state.get("accounts") if isinstance(state.get("accounts"), dict) else {}
        now = _now()
        accounts[str(account_id)] = {
            "exit_ip": str(exit_ip or ""),
            "started_at": now,
            "rotated_at": now,
            "expires_at": int(expires_at or 0),
        }
        state["accounts"] = accounts
        handle, temp_name = tempfile.mkstemp(prefix=".collector-sticky-sessions-", dir=str(path.parent))
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)


def allocate_runtime_account_proxy(account_id: str) -> dict[str, Any]:
    account = str(account_id or "").strip()
    if not account:
        raise RuntimeError("collector sticky proxy account_id is required")
    try:
        config = _load_config()
    except Exception as exc:
        raise RuntimeError("collector sticky proxy configuration is unavailable") from exc
    profile = _account_sticky_profile(config)
    if not profile.get("host") or not int(profile.get("port") or 0):
        raise RuntimeError("collector sticky proxy is not configured")
    profile = dict(profile)
    profile["username"] = _pin_sticky_identity(str(profile.get("username") or ""), account)
    profile["password"] = _pin_sticky_identity(str(profile.get("password") or ""), account)
    try:
        check = _test_connection(profile)
    except HTTPException as exc:
        raise RuntimeError(str(getattr(exc, "detail", "") or "collector sticky proxy probe failed")) from exc
    if not check.get("ok"):
        raise RuntimeError(str(check.get("error") or "collector sticky proxy probe failed"))
    session_seconds = max(300, min(int(config.get("sticky_session_seconds") or 1800), 3600))
    expires_at = _now() + session_seconds
    exit_ip = str(check.get("exit_ip") or "").strip()
    _record_sticky_session(account, exit_ip, expires_at)
    protocol = str(profile.get("protocol") or "http").strip().lower() or "http"
    return {
        "server": f"{protocol}://{profile.get('host')}:{int(profile.get('port') or 0)}",
        "username": str(profile.get("username") or ""),
        "password": str(profile.get("password") or ""),
        "product_id": str(profile.get("product_id") or profile.get("proxy_id") or ""),
        "exit_ip": exit_ip,
        "expires_at": expires_at,
    }


def runtime_account_proxy_url(account_id: str, proxy_id: str) -> str:
    clean_proxy = str(proxy_id or "").strip()
    if not clean_proxy:
        return ""
    try:
        config = _load_config()
    except Exception as exc:
        raise RuntimeError("collector sticky proxy configuration is unavailable") from exc
    profile = _proxy_profile_for_account(config, clean_proxy)
    if not profile.get("host") or not int(profile.get("port") or 0):
        raise RuntimeError("collector sticky proxy is configured but the matching product is unavailable")
    mode = str(profile.get("mode") or config.get("account_proxy_mode") or "sticky").strip().lower()
    if mode != "static":
        profile["username"] = _pin_sticky_identity(str(profile.get("username") or ""), account_id)
        profile["password"] = _pin_sticky_identity(str(profile.get("password") or ""), account_id)
    return _proxy_url(profile)


def _sticky_session_stats() -> dict[str, Any]:
    path = CONFIG_PATH.with_name("account-sessions.json")
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    accounts = state.get("accounts") if isinstance(state, dict) and isinstance(state.get("accounts"), dict) else {}
    now = _now()
    active = [value for value in accounts.values() if isinstance(value, dict) and int(value.get("expires_at") or 0) > now]
    return {
        "managed_accounts": len(accounts),
        "active_sessions": len(active),
        "unique_exit_ips": len({str(value.get("exit_ip") or "") for value in active if str(value.get("exit_ip") or "")}),
        "next_expiry_at": min((int(value.get("expires_at") or 0) for value in active), default=0),
        "last_rotation_at": max((int(value.get("rotated_at") or value.get("started_at") or 0) for value in accounts.values() if isinstance(value, dict)), default=0),
    }


def _stored_proxy_profile(config: dict[str, Any], role: str) -> dict[str, Any]:
    value = config.get(f"{role}_proxy")
    if isinstance(value, dict):
        return dict(value)
    if role == "reader" and config.get("host") and config.get("port"):
        return {
            "product_id": str(config.get("provider_proxy_id") or ""),
            "host": str(config.get("host") or ""),
            "port": int(config.get("port") or 0),
            "protocol": str(config.get("protocol") or "http"),
            "username": str(config.get("username") or ""),
            "password": str(config.get("password") or ""),
            "mode": "rotating",
        }
    return {}


def _public_proxy_profile(profile: dict[str, Any]) -> dict[str, Any]:
    configured = bool(profile.get("host") and profile.get("port"))
    return {
        "product_id": str(profile.get("product_id") or ""),
        "mode": str(profile.get("mode") or ""),
        "configured": configured,
        "host": str(profile.get("host") or ""),
        "port": int(profile.get("port") or 0),
        "protocol": str(profile.get("protocol") or "http"),
        "connection_masked": _mask_secret_exact_length(_proxy_url(profile)) if configured else "",
        "sticky_template_configured": bool(_sticky_template_field(profile)),
        "last_check": profile.get("last_check") if isinstance(profile.get("last_check"), dict) else {},
    }


def _build_proxy_profile(
    *,
    product_id: str,
    product: dict[str, Any],
    connection: str,
    existing: dict[str, Any],
    mode: str,
) -> dict[str, Any]:
    parsed = _parse_connection(connection) if str(connection or "").strip() else {}
    product_host, product_port, product_protocol = _product_endpoint(product)
    authentication = product.get("authentication") if isinstance(product.get("authentication"), dict) else {}
    host = str(parsed.get("host") or existing.get("host") or product_host or "").strip()
    port = int(parsed.get("port") or existing.get("port") or product_port or 0)
    protocol = str(parsed.get("protocol") or existing.get("protocol") or product_protocol or "http").strip().lower()
    username = str(parsed.get("username") or existing.get("username") or authentication.get("username") or "").strip()
    password = str(parsed.get("password") or existing.get("password") or authentication.get("password") or "")
    profile = {
        "product_id": product_id,
        "mode": mode,
        "host": "",
        "port": 0,
        "protocol": protocol,
        "username": username,
        "password": password,
        "product": _product_summary(product),
    }
    if host and port:
        host, port, protocol = _validate_endpoint(host, port, protocol)
        profile.update({"host": host, "port": port, "protocol": protocol})
        profile["last_check"] = _test_connection(profile)
    return profile


def _public_config(config: dict[str, Any]) -> dict[str, Any]:
    reader = _stored_proxy_profile(config, "reader")
    account = _stored_proxy_profile(config, "account")
    products = _normalise_products(config)
    account_mode = str(account.get("mode") or config.get("account_proxy_mode") or "sticky")
    sticky_configured = account_mode == "sticky" and bool(_sticky_template_field(account))
    static_configured = account_mode == "static" and bool(account.get("host") and account.get("port"))
    return {
        "configured": bool(config),
        "provider": str(config.get("provider") or "proxycheap"),
        "provider_proxy_id": str(reader.get("product_id") or config.get("provider_proxy_id") or ""),
        "reader_product_id": str(reader.get("product_id") or ""),
        "account_product_id": str(account.get("product_id") or ""),
        "account_proxy_mode": account_mode,
        "reader_proxy": _public_proxy_profile(reader),
        "account_proxy": _public_proxy_profile(account),
        "manual_product_ids": [str(item.get("proxy_id") or "") for item in products],
        "products": [_public_product(item) for item in products],
        "enabled_product_count": sum(1 for item in products if _public_product(item)["public_reader_enabled"]),
        "api_key_configured": bool(str(config.get("provider_api_key") or "")),
        "api_secret_configured": bool(str(config.get("provider_api_secret") or "")),
        "api_key_masked": _mask_secret_exact_length(config.get("provider_api_key")),
        "api_secret_masked": _mask_secret_exact_length(config.get("provider_api_secret")),
        "proxy_credentials_configured": bool(reader.get("username") or reader.get("password")),
        "connection_masked": _mask_secret_exact_length(_proxy_url(reader)) if reader.get("host") and reader.get("port") else "",
        "host": str(reader.get("host") or ""),
        "port": int(reader.get("port") or 0),
        "protocol": str(reader.get("protocol") or "http"),
        "public_reader_enabled": bool(config.get("public_reader_enabled") and reader.get("host") and reader.get("port")),
        "sticky_template_configured": sticky_configured,
        "sticky_template_field": _sticky_template_field(account),
        "sticky_session_seconds": max(300, min(int(config.get("sticky_session_seconds") or 1800), 3600)),
        "auth_account_proxy_enabled": bool(config.get("auth_account_proxy_enabled") and (sticky_configured or static_configured)),
        "sticky_session_stats": _sticky_session_stats(),
        "state": str(config.get("state") or "disabled"),
        "product": reader.get("product") if isinstance(reader.get("product"), dict) else {},
        "last_check": reader.get("last_check") if isinstance(reader.get("last_check"), dict) else {},
        "reader_rotation_epoch": int(config.get("reader_rotation_epoch") or 0),
        "last_rotation_at": int(config.get("last_rotation_at") or 0),
        "updated_at": int(config.get("updated_at") or 0),
        "traffic_warning": config.get("traffic_warning") if isinstance(config.get("traffic_warning"), dict) else None,
        "traffic_cache": _attach_traffic_groups(
            config.get("traffic_cache") if isinstance(config.get("traffic_cache"), dict) else {},
            config,
        ),
    }


def register_collector_proxy_admin_routes(app: FastAPI) -> None:
    @app.post("/api/integrations/proxy-cheap/webhook/{token}", status_code=202)
    async def receive_proxycheap_webhook(token: str, request: Request):
        if not hmac.compare_digest(str(token or ""), _webhook_secret()):
            raise HTTPException(status_code=404, detail="not found")
        content_type = str(request.headers.get("content-type") or "").lower()
        if "application/json" not in content_type:
            raise HTTPException(status_code=415, detail="JSON body required")
        body = await request.body()
        if not body or len(body) > 256 * 1024:
            raise HTTPException(status_code=413 if body else 400, detail="invalid webhook body")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail="invalid JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="JSON object required")
        metadata = _webhook_event_metadata(payload, body, request.headers)
        created = _record_webhook_event(metadata)
        if created:
            threading.Thread(
                target=_refresh_proxycheap_after_webhook,
                args=(metadata,),
                name="proxycheap-webhook-refresh",
                daemon=True,
            ).start()
        return {"ok": True, "accepted": created, "duplicate": not created}

    @app.get("/api/admin/collector-proxy/config")
    def get_collector_proxy_config(_admin: dict[str, Any] = Depends(require_admin)):
        config = _load_config()
        traffic = config.get("traffic_cache") if isinstance(config.get("traffic_cache"), dict) else {}
        if traffic.get("products"):
            with _CONFIG_LOCK:
                latest = _load_config()
                cache = latest.get("traffic_cache") if isinstance(latest.get("traffic_cache"), dict) else traffic
                latest, removed = _prune_exhausted_products(latest, cache)
                if removed:
                    _write_config(latest)
                    config = latest
        return _public_config(config)

    @app.post("/api/admin/collector-proxy/secrets/{secret_name}")
    def reveal_collector_proxy_secret(
        secret_name: str,
        request: Request,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        _require_admin_console_request(request)
        config = _load_config()
        clean_name = str(secret_name or "").strip()
        if clean_name == "api_key":
            value = str(config.get("provider_api_key") or "")
        elif clean_name == "api_secret":
            value = str(config.get("provider_api_secret") or "")
        elif clean_name in {"connection", "reader_connection"}:
            profile = _stored_proxy_profile(config, "reader")
            value = _proxy_url(profile) if profile.get("host") and profile.get("port") else ""
        elif clean_name == "account_connection":
            profile = _stored_proxy_profile(config, "account")
            value = _proxy_url(profile) if profile.get("host") and profile.get("port") else ""
        else:
            raise HTTPException(status_code=404, detail="该代理密钥不允许查看")
        if not value:
            raise HTTPException(status_code=404, detail="对应内容尚未配置")
        return JSONResponse(
            content={"key": clean_name, "value": value},
            headers={
                "Cache-Control": "no-store, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )

    @app.post("/api/admin/collector-proxy/products/{proxy_id}/secrets/connection")
    def reveal_collector_proxy_product_connection(
        proxy_id: str,
        request: Request,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        _require_admin_console_request(request)
        clean_id = _clean_proxy_id(proxy_id)
        item = _find_product(_normalise_products(_load_config()), clean_id)
        value = _proxy_url(item) if item.get("host") and item.get("port") else ""
        if not value:
            raise HTTPException(status_code=404, detail="该产品连接串尚未配置")
        return JSONResponse(
            content={"key": "connection", "proxy_id": clean_id, "value": value},
            headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache", "Expires": "0"},
        )

    @app.post("/api/admin/collector-proxy/manual-products")
    def add_collector_proxy_manual_product(
        payload: CollectorProxyManualProductPayload,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        proxy_id = _clean_proxy_id(payload.proxy_id)
        config = _load_config()
        api_key = str(config.get("provider_api_key") or "").strip()
        api_secret = str(config.get("provider_api_secret") or "").strip()
        if not api_key or not api_secret:
            raise HTTPException(status_code=409, detail="请先识别产品并保存有效 API 凭据")
        supplier_product = _fetch_proxycheap_product(proxy_id, api_key, api_secret)
        with _CONFIG_LOCK:
            config = _load_config()
            products = _normalise_products(config)
            if any(item.get("proxy_id") == proxy_id for item in products):
                return {"ok": True, "exists": True, "config": _public_config(config)}
            _onboard_proxy_product(
                config,
                products,
                supplier_product,
                supplier=supplier_product,
                is_new=True,
            )
            config = _apply_products(config, products)
            _write_config(config)
        return {"ok": True, "added_id": proxy_id, "config": _public_config(config)}

    @app.delete("/api/admin/collector-proxy/manual-products/{proxy_id}")
    def delete_collector_proxy_manual_product(
        proxy_id: str,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        clean_id = _clean_proxy_id(proxy_id)
        with _CONFIG_LOCK:
            config = _load_config()
            products = _normalise_products(config)
            item = _find_product(products, clean_id)
            if item.get("public_reader_enabled"):
                raise HTTPException(status_code=409, detail="请先停用该产品的公开 Reader，再删除产品")
            products = [value for value in products if value.get("proxy_id") != clean_id]
            config = _apply_products(config, products)
            _write_config(config)
        return {"ok": True, "deleted_id": clean_id, "config": _public_config(config)}

    @app.post("/api/admin/collector-proxy/products")
    def list_collector_proxy_products(payload: CollectorProxyInspectPayload, _admin: dict[str, Any] = Depends(require_admin)):
        _provider(payload.provider)
        existing = _load_config()
        api_key, api_secret = _credentials(payload, existing)
        products = _fetch_proxycheap_products(api_key, api_secret)
        traffic = _traffic_summary(products, existing)
        with _CONFIG_LOCK:
            latest = _load_config()
            latest["provider"] = "proxycheap"
            latest["provider_api_key"] = api_key
            latest["provider_api_secret"] = api_secret
            latest["traffic_cache"] = traffic
            configured = _normalise_products(latest)
            known = {str(item.get("proxy_id") or "").strip() for item in configured}
            ingested = False
            for product in products:
                if not isinstance(product, dict):
                    continue
                proxy_id = str(product.get("id") or "").strip()
                if not proxy_id or proxy_id in known:
                    continue
                if not _is_rotating_residential(product):
                    continue
                if str(product.get("status") or "").strip().upper() != "ACTIVE":
                    continue
                if _is_summary_exhausted(_product_summary(product)):
                    continue
                _onboard_proxy_product(
                    latest,
                    configured,
                    product,
                    api_key=api_key,
                    api_secret=api_secret,
                    is_new=True,
                )
                known.add(proxy_id)
                ingested = True
            if ingested:
                latest = _apply_products(latest, configured)
            latest = _maybe_switch_exhausted_reader(latest, traffic)
            latest, removed = _prune_exhausted_products(latest, traffic)
            latest["updated_at"] = _now()
            _write_config(latest)
        live_products = [item for item in traffic["products"] if not _is_summary_exhausted(item)]
        return {
            "ok": True,
            "products": live_products,
            "removed_ids": removed,
            "traffic": traffic,
            "warning": latest.get("traffic_warning"),
            "config": _public_config(latest),
        }

    @app.post("/api/admin/collector-proxy/products/{proxy_id}/test")
    def test_collector_proxy_product(
        proxy_id: str,
        payload: CollectorProxyProductConnectionPayload,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        clean_id = _clean_proxy_id(proxy_id)
        with _CONFIG_LOCK:
            config = _load_config()
            item = _find_product(_normalise_products(config), clean_id)
            candidate = dict(item)
            parsed = _parse_connection(payload.connection) if str(payload.connection or "").strip() else {}
            if parsed:
                candidate.update(parsed)
            if not candidate.get("host") or not candidate.get("port"):
                raise HTTPException(status_code=409, detail="请先填写该产品的连接串")
            host, port, protocol = _validate_endpoint(candidate.get("host"), int(candidate.get("port") or 0), candidate.get("protocol"))
            candidate.update({"host": host, "port": port, "protocol": protocol})

        result = _test_connection(candidate)
        fingerprint = _connection_fingerprint(candidate)
        result["connection_fingerprint"] = fingerprint
        with _CONFIG_LOCK:
            config = _load_config()
            products = _normalise_products(config)
            item = _find_product(products, clean_id)
            item.update({
                "host": candidate.get("host"), "port": candidate.get("port"), "protocol": candidate.get("protocol"),
                "username": candidate.get("username", ""), "password": candidate.get("password", ""),
                "connection_fingerprint": fingerprint, "last_check": result, "updated_at": _now(),
            })
            if result.get("ok"):
                item["state"] = "active" if item.get("public_reader_enabled") else "ready"
            else:
                item["public_reader_enabled"] = False
                item["state"] = "check_failed"
            config = _apply_products(config, products)
            _write_config(config)
        return {"ok": bool(result.get("ok")), "result": result, "config": _public_config(config)}

    @app.patch("/api/admin/collector-proxy/products/{proxy_id}/reader")
    def toggle_collector_proxy_product_reader(
        proxy_id: str,
        payload: CollectorProxyReaderTogglePayload,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        clean_id = _clean_proxy_id(proxy_id)
        with _CONFIG_LOCK:
            config = _load_config()
            products = _normalise_products(config)
            item = _find_product(products, clean_id)
            fingerprint = _connection_fingerprint(item)
            check = item.get("last_check") if isinstance(item.get("last_check"), dict) else {}
            verified = bool(check.get("ok") and fingerprint and check.get("connection_fingerprint") == fingerprint)
            if payload.enabled and not verified:
                raise HTTPException(status_code=409, detail="该产品必须先自动检测通过，才能启用公开 Reader")
            if payload.enabled and str(item.get("protocol") or "http") not in {"http", "https"}:
                raise HTTPException(status_code=409, detail="公开 Reader 当前仅支持 HTTP 或 HTTPS 代理")
            item["public_reader_enabled"] = bool(payload.enabled)
            item["user_set_reader"] = True
            item["state"] = "active" if payload.enabled else ("ready" if verified else "disabled")
            item["reader_rotation_epoch"] = int(item.get("reader_rotation_epoch") or 0) + 1
            item["last_rotation_at"] = _now()
            item["updated_at"] = _now()
            config = _apply_products(config, products)
            _write_config(config)
        return {"ok": True, "config": _public_config(config)}

    @app.get("/api/admin/collector-proxy/traffic")
    def get_collector_proxy_traffic(force: bool = False, _admin: dict[str, Any] = Depends(require_admin)):
        config = _load_config()
        cached = config.get("traffic_cache") if isinstance(config.get("traffic_cache"), dict) else {}
        cached_at = int(cached.get("synced_at") or 0)
        if cached and not force and (_now() - cached_at) < TRAFFIC_CACHE_SECONDS:
            with _CONFIG_LOCK:
                latest = _load_config()
                latest, removed = _prune_exhausted_products(latest, cached)
                if removed:
                    _write_config(latest)
                    config = latest
            traffic = _attach_traffic_groups(cached, config)
            return {
                "ok": True,
                "cached": True,
                "removed_ids": removed,
                "traffic": traffic,
                "warning": config.get("traffic_warning") if isinstance(config.get("traffic_warning"), dict) else None,
                "config": _public_config(config),
            }
        api_key = str(config.get("provider_api_key") or "").strip()
        api_secret = str(config.get("provider_api_secret") or "").strip()
        if not api_key or not api_secret:
            raise HTTPException(status_code=409, detail="请先在系统配置中保存代理 API 凭据")
        traffic = _traffic_summary(_fetch_proxycheap_products(api_key, api_secret), config)
        with _CONFIG_LOCK:
            latest = _load_config()
            latest["traffic_cache"] = traffic
            latest = _maybe_switch_exhausted_reader(latest, traffic)
            latest, removed = _prune_exhausted_products(latest, traffic)
            _write_config(latest)
        return {
            "ok": True,
            "cached": False,
            "removed_ids": removed,
            "traffic": _attach_traffic_groups(traffic, latest),
            "warning": latest.get("traffic_warning"),
            "config": _public_config(latest),
        }

    @app.post("/api/admin/collector-proxy/inspect")
    def inspect_collector_proxy(payload: CollectorProxyInspectPayload, _admin: dict[str, Any] = Depends(require_admin)):
        _provider(payload.provider)
        existing = _load_config()
        proxy_id = _clean_proxy_id(payload.proxy_id or existing.get("provider_proxy_id"))
        api_key, api_secret = _credentials(payload, existing)
        product = _fetch_proxycheap_product(proxy_id, api_key, api_secret)
        host, port, protocol = _product_endpoint(product)
        return {
            "ok": True,
            "product": _product_summary(product),
            "endpoint": {"host": host, "port": port, "protocol": protocol} if host and port else None,
            "needs_connection": not bool(host and port),
            "proxy_credentials_available": bool((product.get("authentication") or {}).get("username")),
        }

    @app.post("/api/admin/collector-proxy/save")
    def save_collector_proxy(payload: CollectorProxySavePayload, _admin: dict[str, Any] = Depends(require_admin)):
        provider = _provider(payload.provider)
        existing = _load_config()
        api_key, api_secret = _credentials(payload, existing)
        products = _normalise_products(existing)
        existing_reader = _stored_proxy_profile(existing, "reader")
        existing_account = _stored_proxy_profile(existing, "account")
        reader_id = _clean_proxy_id(
            payload.reader_proxy_id
            or payload.proxy_id
            or existing_reader.get("product_id")
            or existing.get("provider_proxy_id")
        )
        account_id = _clean_proxy_id(
            payload.account_proxy_id
            or existing_account.get("product_id")
        )
        if reader_id == account_id:
            raise HTTPException(
                status_code=400,
                detail="Reader \u4ea7\u54c1\u548c\u767b\u5f55\u8d26\u53f7\u4ea7\u54c1\u5fc5\u987b\u9009\u62e9\u4e0d\u540c\u4ea7\u54c1",
            )
        account_mode = str(payload.account_proxy_mode or "sticky").strip().lower()
        if account_mode not in {"sticky", "static"}:
            raise HTTPException(
                status_code=400,
                detail="\u8d26\u53f7\u4ee3\u7406\u65b9\u5f0f\u53ea\u80fd\u9009\u62e9\u9759\u6001 IP \u6216\u7c98\u6027 Session",
            )

        reader_product = _fetch_proxycheap_product(reader_id, api_key, api_secret)
        account_product = _fetch_proxycheap_product(account_id, api_key, api_secret)

        def ensure_product_entry(proxy_id: str, supplier_product: dict[str, Any]) -> dict[str, Any]:
            entry = next((item for item in products if str(item.get("proxy_id") or "") == proxy_id), None)
            if entry is not None:
                entry["product"] = _product_summary(supplier_product)
                return entry
            entry = {
                "proxy_id": proxy_id,
                "product_id": proxy_id,
                "product": _product_summary(supplier_product),
                "host": "",
                "port": 0,
                "protocol": "http",
                "username": "",
                "password": "",
                "last_check": {},
                "public_reader_enabled": False,
                "state": "needs_connection",
                "mode": "rotating",
                "created_at": _now(),
                "updated_at": _now(),
            }
            products.append(entry)
            return entry

        reader_entry = ensure_product_entry(reader_id, reader_product)
        account_entry = ensure_product_entry(account_id, account_product)

        def role_profile(
            entry: dict[str, Any],
            supplier_product: dict[str, Any],
            connection: str,
            mode: str,
        ) -> dict[str, Any]:
            proxy_id = str(entry.get("proxy_id") or "")
            if str(connection or "").strip():
                return _build_proxy_profile(
                    product_id=proxy_id,
                    product=supplier_product,
                    connection=connection,
                    existing=entry,
                    mode=mode,
                )
            profile = dict(entry)
            profile["product_id"] = proxy_id
            profile["mode"] = mode
            profile["product"] = _product_summary(supplier_product)
            return profile

        reader_connection = payload.reader_connection or payload.connection
        reader = role_profile(reader_entry, reader_product, reader_connection, "rotating")
        account = role_profile(account_entry, account_product, payload.account_connection, account_mode)

        def profile_verified(profile: dict[str, Any]) -> bool:
            fingerprint = _connection_fingerprint(profile)
            check = profile.get("last_check") if isinstance(profile.get("last_check"), dict) else {}
            return bool(
                check.get("ok")
                and fingerprint
                and check.get("connection_fingerprint") == fingerprint
            )

        reader_ok = profile_verified(reader)
        account_ok = profile_verified(account)
        sticky_ok = account_mode != "sticky" or bool(_sticky_template_field(account))

        # Keep the two roles exclusive: the account product is never a Reader exit.
        account_entry["public_reader_enabled"] = False
        account_entry["state"] = "ready" if account_ok else str(account_entry.get("state") or "needs_connection")
        account_entry["mode"] = account_mode
        reader_entry["mode"] = "rotating"

        config: dict[str, Any] = {
            **existing,
            "schema": "vecto-collector-proxy-v2",
            "provider": provider,
            "provider_api_key": api_key,
            "provider_api_secret": api_secret,
            "provider_proxy_id": reader_id,
            "selected_product_id": reader_id,
            "reader_proxy": reader,
            "account_proxy": account,
            "account_proxy_mode": account_mode,
            "public_reader_enabled": bool(reader_entry.get("public_reader_enabled") and reader_ok),
            "auth_account_proxy_enabled": bool(account_ok and sticky_ok),
            "sticky_session_seconds": 1800,
            "updated_at": _now(),
        }
        config = _apply_products(config, products)
        config["account_proxy"] = account
        config["account_proxy_mode"] = account_mode
        config["auth_account_proxy_enabled"] = bool(account_ok and sticky_ok)
        config["sticky_session_seconds"] = 1800
        _write_config(config)
        return {"ok": True, "config": _public_config(config)}

    @app.post("/api/admin/collector-proxy/rotate-reader")
    def rotate_collector_reader_proxy(_admin: dict[str, Any] = Depends(require_admin)):
        config = _load_config()
        if not config.get("public_reader_enabled") or config.get("state") != "active":
            raise HTTPException(status_code=409, detail="\u8bf7\u5148\u542f\u7528\u533f\u540d Reader \u4ee3\u7406")
        if not config.get("host") or not config.get("port"):
            raise HTTPException(status_code=409, detail="\u533f\u540d Reader \u4ee3\u7406\u8fde\u63a5\u5c1a\u672a\u914d\u7f6e")
        reader = _stored_proxy_profile(config, "reader")
        result = _test_connection(reader)
        reader["last_check"] = result
        config["reader_proxy"] = reader
        config["last_check"] = result
        config["reader_rotation_epoch"] = int(config.get("reader_rotation_epoch") or 0) + 1
        config["last_rotation_at"] = _now()
        config["updated_at"] = _now()
        if not result.get("ok"):
            config["public_reader_enabled"] = False
            config["state"] = "check_failed"
        _write_config(config)
        return {"ok": bool(result.get("ok")), "result": result, "config": _public_config(config)}

    @app.post("/api/admin/collector-proxy/test")
    def test_collector_proxy(_admin: dict[str, Any] = Depends(require_admin)):
        config = _load_config()
        if not config.get("host") or not config.get("port"):
            raise HTTPException(status_code=409, detail="请先补充代理连接串")
        reader = _stored_proxy_profile(config, "reader")
        result = _test_connection(reader)
        reader["last_check"] = result
        config["reader_proxy"] = reader
        config["last_check"] = result
        if not result.get("ok"):
            config["public_reader_enabled"] = False
            config["state"] = "check_failed"
        elif config.get("public_reader_enabled"):
            config["state"] = "active"
        config["updated_at"] = _now()
        _write_config(config)
        return {"ok": bool(result.get("ok")), "result": result, "config": _public_config(config)}
