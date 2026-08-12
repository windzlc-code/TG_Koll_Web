from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from typing import Any, Mapping

from . import commercial_billing
from .proxy_market_credentials import encrypt_market_credentials
from .proxy_providers import (
    MockProxyProvider,
    ProviderQuote,
    ProxyCheapProvider,
    ProxyProvider,
    ProxyProviderConfigurationError,
    ProxyProviderError,
    ProxyProviderOutcomeUnknown,
)


POINT_SCALE = 100
DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "provider": "proxycheap",
    "service_id": "static-residential-ipv4",
    "plan_id": "",
    "default_period_months": 1,
    "points_per_usd": "25.00",
    "fixed_fee_points": "0.00",
    "max_vendor_cost_usd": "100.00",
    "safety_buffer_usd": "0.00",
    "minimum_profit_usd": "0.00",
    "usd_to_ntd_rate": "35.00",
    "payment_fee_rate": "0.05",
    "quote_ttl_seconds": 180,
    "default_parameters": {},
}
_ORDER_PUBLIC_FIELDS = {
    "id",
    "status",
    "provider_order_id",
    "renewal_enabled",
    "created_at",
    "updated_at",
    "completed_at",
    "credit_units",
    "provider_currency",
}
_MOCK_PROVIDER_LOCK = threading.Lock()
_MOCK_PROVIDERS: dict[str, MockProxyProvider] = {}
_TERMINAL_FAILURES = {"failed", "canceled", "cancelled", "expired"}
_ACTIVE_STATUSES = {"active", "completed", "ready"}


class ProxyPurchaseError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = str(code)
        self.status_code = int(status_code)


def _now() -> int:
    return int(time.time())


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _loads(value: Any, default: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed


def _decimal(value: Any, field: str, *, minimum: str = "0") -> Decimal:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ProxyPurchaseError("INVALID_CONFIG", f"{field} must be numeric") from exc
    if not number.is_finite() or number < Decimal(minimum):
        raise ProxyPurchaseError("INVALID_CONFIG", f"{field} is outside the allowed range")
    return number


def _minor_units(amount: Decimal) -> int:
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_CEILING))


def _points_units(provider_amount_usd: Decimal, config: Mapping[str, Any]) -> int:
    per_usd = _decimal(config.get("points_per_usd"), "points_per_usd", minimum="0.01")
    fixed = _decimal(config.get("fixed_fee_points", 0), "fixed_fee_points")
    safety = _decimal(config.get("safety_buffer_usd", 0), "safety_buffer_usd")
    profit = _decimal(config.get("minimum_profit_usd", 0), "minimum_profit_usd")
    return int(
        (((provider_amount_usd + safety + profit) * per_usd + fixed) * POINT_SCALE).quantize(
            Decimal("1"), rounding=ROUND_CEILING
        )
    )


def _required_revenue_ntd(provider_amount_usd: Decimal, config: Mapping[str, Any]) -> Decimal:
    fx = _decimal(config.get("usd_to_ntd_rate"), "usd_to_ntd_rate", minimum="0.000001")
    fee = _decimal(config.get("payment_fee_rate", 0), "payment_fee_rate")
    if fee > Decimal("1"):
        raise ProxyPurchaseError("INVALID_CONFIG", "payment_fee_rate must not exceed 1")
    safety = _decimal(config.get("safety_buffer_usd", 0), "safety_buffer_usd")
    profit = _decimal(config.get("minimum_profit_usd", 0), "minimum_profit_usd")
    return ((provider_amount_usd + safety) * fx * (Decimal("1") + fee)) + (profit * fx)


def _assert_profitable(
    provider_amount_usd: Decimal,
    credit_units: int,
    config: Mapping[str, Any],
    cash_per_point_ntd: Decimal,
) -> None:
    revenue_ntd = (Decimal(int(credit_units)) / POINT_SCALE) * cash_per_point_ntd
    required_ntd = _required_revenue_ntd(provider_amount_usd, config)
    if revenue_ntd < required_ntd:
        raise ProxyPurchaseError(
            "UNPROFITABLE_PRICE",
            "Point price does not cover provider cost, payment fee, safety buffer and minimum profit",
            409,
        )


def validate_config(config: Mapping[str, Any]) -> dict[str, Any]:
    merged = {**DEFAULT_CONFIG, **dict(config)}
    provider_key = str(merged.get("provider") or "").strip().lower().replace("-", "")
    if provider_key != "proxycheap":
        raise ProxyPurchaseError("INVALID_CONFIG", "Only the Proxy-Cheap provider is supported")
    merged["provider"] = "proxycheap"
    if "default_period" in config and "default_period_months" not in config:
        raw_period = config.get("default_period")
        merged["default_period_months"] = (
            raw_period.get("value", 1) if isinstance(raw_period, Mapping) else raw_period
        )
    if "setup_defaults" in config and "default_parameters" not in config:
        merged["default_parameters"] = config.get("setup_defaults")
    if "live_purchasing_enabled" in config and "enabled" not in config:
        merged["enabled"] = bool(config.get("live_purchasing_enabled"))
    service_id = str(merged.get("service_id") or "").strip()
    if not service_id or len(service_id) > 160:
        raise ProxyPurchaseError("INVALID_CONFIG", "service_id is required")
    if service_id != "static-residential-ipv4":
        raise ProxyPurchaseError(
            "UNSUPPORTED_SERVICE", "The first release supports only static-residential-ipv4", 409
        )
    months = int(merged.get("default_period_months") or 1)
    if months < 1 or months > 36:
        raise ProxyPurchaseError("INVALID_CONFIG", "default_period_months must be between 1 and 36")
    ttl = int(merged.get("quote_ttl_seconds") or 180)
    if ttl < 120 or ttl > 300:
        raise ProxyPurchaseError("INVALID_CONFIG", "quote_ttl_seconds must be between 120 and 300")
    _decimal(merged.get("points_per_usd"), "points_per_usd", minimum="0.01")
    _decimal(merged.get("fixed_fee_points"), "fixed_fee_points")
    max_cost = _decimal(merged.get("max_vendor_cost_usd"), "max_vendor_cost_usd", minimum="0.01")
    safety = _decimal(merged.get("safety_buffer_usd"), "safety_buffer_usd")
    profit = _decimal(merged.get("minimum_profit_usd"), "minimum_profit_usd")
    fx = _decimal(merged.get("usd_to_ntd_rate"), "usd_to_ntd_rate", minimum="0.000001")
    payment_fee = _decimal(merged.get("payment_fee_rate", 0), "payment_fee_rate")
    if payment_fee > Decimal("1"):
        raise ProxyPurchaseError("INVALID_CONFIG", "payment_fee_rate must not exceed 1")
    if merged.get("lowest_cash_per_point") not in (None, ""):
        cash_per_point = _decimal(
            merged.get("lowest_cash_per_point"), "lowest_cash_per_point", minimum="0.000001"
        )
        max_units = _points_units(max_cost, merged)
        _assert_profitable(max_cost, max_units, merged, cash_per_point)
    merged["service_id"] = service_id
    merged["plan_id"] = str(merged.get("plan_id") or "")[:160]
    merged["default_period_months"] = months
    merged["quote_ttl_seconds"] = ttl
    if not isinstance(merged.get("default_parameters"), dict):
        merged["default_parameters"] = {}
    parameters = dict(merged.get("default_parameters") or {})
    if parameters.get("authentication") and not parameters.get("authenticationType"):
        parameters["authenticationType"] = parameters.pop("authentication")
    parameters = {key: value for key, value in parameters.items() if value not in (None, "")}
    clean = {
        "enabled": bool(merged.get("enabled")),
        "provider": "proxycheap",
        "service_id": service_id,
        "plan_id": str(merged.get("plan_id") or "")[:160],
        "default_period_months": months,
        "points_per_usd": str(_decimal(merged.get("points_per_usd"), "points_per_usd", minimum="0.01")),
        "fixed_fee_points": str(_decimal(merged.get("fixed_fee_points", 0), "fixed_fee_points")),
        "max_vendor_cost_usd": str(max_cost),
        "safety_buffer_usd": str(safety),
        "minimum_profit_usd": str(profit),
        "usd_to_ntd_rate": str(fx),
        "payment_fee_rate": str(payment_fee),
        "quote_ttl_seconds": ttl,
        "default_parameters": parameters,
    }
    if merged.get("lowest_cash_per_point") not in (None, ""):
        clean["lowest_cash_per_point"] = str(
            _decimal(merged.get("lowest_cash_per_point"), "lowest_cash_per_point", minimum="0.000001")
        )
    return clean


def _lowest_cash_per_point(conn: sqlite3.Connection) -> Decimal:
    catalog = commercial_billing.get_active_catalog(conn)
    values: list[Decimal] = []
    for package in catalog.get("packages") or []:
        if not isinstance(package, Mapping):
            continue
        total_points = _decimal(package.get("total_points", 0), "package total_points")
        price = _decimal(package.get("price_ntd", 0), "package price_ntd")
        if total_points > 0 and price > 0:
            values.append(price / total_points)
    if not values:
        raise ProxyPurchaseError("NO_PAID_POINT_RATE", "Active billing catalog has no paid point package", 409)
    return min(values)


def _published_config_row(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM proxy_purchase_config_versions WHERE status='active' ORDER BY version_number DESC LIMIT 1"
    ).fetchone()


def _config_public(config: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(config)
    defaults = dict(result.get("default_parameters") or {})
    result["setup_defaults"] = defaults
    result["default_period"] = int(result.get("default_period_months") or 1)
    result["default_country"] = str(defaults.get("country") or "")
    result["live_purchasing_enabled"] = bool(result.get("enabled"))
    return result


def get_config(conn: sqlite3.Connection, *, include_draft: bool = False) -> dict[str, Any]:
    states = "('draft','active')" if include_draft else "('active')"
    row = conn.execute(
        f"SELECT * FROM proxy_purchase_config_versions WHERE status IN {states} "
        "ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, version_number DESC LIMIT 1"
    ).fetchone()
    config = validate_config(_loads(row["config_json"], {}) if row else DEFAULT_CONFIG)
    config.update(
        {
            "id": str(row["id"]) if row else "",
            "version_number": int(row["version_number"] or 0) if row else 0,
            "status": str(row["status"]) if row else "unconfigured",
        }
    )
    return _config_public(config)


def save_config_draft(
    conn: sqlite3.Connection, config: Mapping[str, Any], *, actor_user_id: int, now: int | None = None
) -> dict[str, Any]:
    clean = validate_config({key: value for key, value in config.items() if key != "lowest_cash_per_point"})
    current = int(now or _now())
    version = int(
        conn.execute("SELECT COALESCE(MAX(version_number),0)+1 FROM proxy_purchase_config_versions").fetchone()[0]
    )
    config_id = _id("proxy_cfg")
    conn.execute(
        "INSERT INTO proxy_purchase_config_versions(id,version_number,status,config_json,created_by,created_at,published_at) "
        "VALUES (?,?,'draft',?,?,?,0)",
        (config_id, version, _json(clean), int(actor_user_id), current),
    )
    return _config_public({**clean, "id": config_id, "version_number": version, "status": "draft"})


def publish_config(
    conn: sqlite3.Connection, config_id: str, *, actor_user_id: int,
    provider: ProxyProvider | None = None, now: int | None = None
) -> dict[str, Any]:
    current = int(now or _now())
    row = conn.execute(
        "SELECT * FROM proxy_purchase_config_versions WHERE id=? AND status='draft'", (str(config_id),)
    ).fetchone()
    if row is None:
        raise ProxyPurchaseError("CONFIG_NOT_FOUND", "Draft configuration was not found", 404)
    clean = validate_config(_loads(row["config_json"], {}))
    if provider is not None:
        _validate_provider_config(provider, clean)
    # This value is derived from the active billing catalog, never trusted from admin input.
    clean["lowest_cash_per_point"] = str(_lowest_cash_per_point(conn))
    clean = validate_config(clean)
    conn.execute("UPDATE proxy_purchase_config_versions SET status='retired' WHERE status='active'")
    conn.execute(
        "UPDATE proxy_purchase_config_versions SET status='active', published_at=?, config_json=? WHERE id=?",
        (current, _json(clean), str(config_id)),
    )
    return _config_public({
        **clean,
        "id": str(config_id),
        "version_number": int(row["version_number"]),
        "status": "active",
        "published_at": current,
        "published_by": int(actor_user_id),
    })


def _validate_provider_config(provider: ProxyProvider, config: Mapping[str, Any]) -> None:
    service_id = str(config["service_id"])
    services = _list_values(provider.list_services(), ("services", "items", "data"))
    service = next(
        (item for item in services if str(item.get("id") or item.get("serviceId") or "") == service_id),
        None,
    )
    if service is None:
        raise ProxyPurchaseError("PROVIDER_SERVICE_UNAVAILABLE", "Configured provider service is unavailable", 409)
    plan_id = str(config.get("plan_id") or "")
    plans = service.get("plans") if isinstance(service.get("plans"), list) else []
    if plan_id and not any(str(item.get("id") or item.get("planId") or "") == plan_id for item in plans if isinstance(item, Mapping)):
        raise ProxyPurchaseError("PROVIDER_PLAN_UNAVAILABLE", "Configured provider plan is unavailable", 409)
    setup = provider.get_setup(service_id, plan_id=plan_id)
    countries = {item["code"] for item in _region_items(setup)}
    defaults = dict(config.get("default_parameters") or {})
    country = str(defaults.get("country") or "").upper()
    if country and country not in countries:
        raise ProxyPurchaseError("PROVIDER_COUNTRY_UNAVAILABLE", "Configured default country is unavailable", 409)
    isp = str(defaults.get("isp") or defaults.get("ispId") or "")
    if isp:
        setup_data = setup.get("data") if isinstance(setup.get("data"), Mapping) else setup
        raw_isps = setup_data.get("isps") if isinstance(setup_data, Mapping) else None
        country_isps = raw_isps.get(country, []) if isinstance(raw_isps, Mapping) else raw_isps
        available_isps = {
            str(item.get("id") or item.get("value") or item.get("code") or item.get("name") or "")
            for item in (country_isps or []) if isinstance(item, Mapping)
        }
        if isp not in available_isps:
            raise ProxyPurchaseError("PROVIDER_ISP_UNAVAILABLE", "Configured ISP is unavailable", 409)


def provider_from_environment() -> ProxyProvider:
    if str(os.getenv("PROXY_PURCHASE_PROVIDER", "proxycheap")).strip().lower() == "mock":
        unit_price = str(os.getenv("PROXY_PURCHASE_MOCK_PRICE_USD", "4.00"))
        with _MOCK_PROVIDER_LOCK:
            provider = _MOCK_PROVIDERS.get(unit_price)
            if provider is None:
                provider = MockProxyProvider(unit_price_usd=unit_price)
                _MOCK_PROVIDERS[unit_price] = provider
            return provider
    return ProxyCheapProvider()


def _provider_ready(provider: ProxyProvider) -> tuple[bool, bool]:
    configured = bool(getattr(provider, "configured", True))
    purchasing = bool(
        getattr(provider, "purchases_enabled", isinstance(provider, MockProxyProvider))
        and getattr(provider, "safe_reconciliation_enabled", isinstance(provider, MockProxyProvider))
    )
    return configured, purchasing


def _configuration(config: Mapping[str, Any], country: str, period_months: int) -> dict[str, Any]:
    result = dict(config.get("default_parameters") or {})
    result.update(
        {
            "planId": str(config.get("plan_id") or ""),
            "country": str(country or "").strip().upper(),
            "quantity": 1,
            "period": {"unit": "months", "value": int(period_months)},
        }
    )
    return result


def _list_values(payload: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    queue = [payload]
    while queue:
        current = queue.pop(0)
        if isinstance(current, Mapping):
            for key in keys:
                candidate = current.get(key)
                if isinstance(candidate, list):
                    return [dict(item) if isinstance(item, Mapping) else {"value": item} for item in candidate]
            queue.extend(value for value in current.values() if isinstance(value, (dict, list)))
        elif isinstance(current, list):
            queue.extend(current)
    return []


def _region_items(setup: Mapping[str, Any]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in _list_values(setup, ("countries", "locations", "regions")):
        code = str(item.get("code") or item.get("id") or item.get("value") or item.get("countryCode") or "").upper()
        if not code or code in seen:
            continue
        seen.add(code)
        result.append(
            {
                "code": code,
                "name": str(item.get("name") or item.get("label") or item.get("country") or code),
            }
        )
    return result


def purchase_options(
    conn: sqlite3.Connection, *, user_id: int, provider: ProxyProvider | None = None
) -> dict[str, Any]:
    provider = provider or provider_from_environment()
    config = get_config(conn)
    configured, purchasing = _provider_ready(provider)
    regions: list[dict[str, str]] = []
    if bool(config.get("enabled")) and configured:
        regions = _region_items(
            provider.get_setup(str(config["service_id"]), plan_id=str(config.get("plan_id") or ""))
        )
    wallet = commercial_billing.ensure_wallet(conn, int(user_id))
    cash_units = int(wallet.get("cash_backed_credit_units") or 0)
    return {
        "provider": "proxycheap",
        "configured": configured and config.get("status") == "active" and bool(config.get("enabled")),
        "live_purchasing_enabled": bool(
            purchasing and config.get("status") == "active" and config.get("enabled")
        ),
        "regions": regions,
        "cash_backed_credit_units": cash_units,
        "cash_backed_points": cash_units / POINT_SCALE,
        "currency": "USD",
        "default_period": {"unit": "months", "value": int(config["default_period_months"])},
    }


def create_quote(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    country: str,
    auto_renew: bool,
    period_months: int | None = None,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    current = int(now or _now())
    provider = provider or provider_from_environment()
    config = get_config(conn)
    if config.get("status") != "active" or not bool(config.get("enabled")):
        raise ProxyPurchaseError("PURCHASES_DISABLED", "Proxy purchases are not configured", 503)
    clean_country = str(country or "").strip().upper()
    months = int(period_months or config["default_period_months"])
    setup = provider.get_setup(str(config["service_id"]), plan_id=str(config.get("plan_id") or ""))
    countries = {item["code"]: item["name"] for item in _region_items(setup)}
    if clean_country not in countries:
        raise ProxyPurchaseError("INVALID_COUNTRY", "The selected region is not currently orderable", 422)
    request = _configuration(config, clean_country, months)
    quoted = provider.quote(str(config["service_id"]), request)
    if quoted.currency != "USD":
        raise ProxyPurchaseError("UNSUPPORTED_CURRENCY", "Only USD provider quotes are supported", 409)
    max_cost = _decimal(config["max_vendor_cost_usd"], "max_vendor_cost_usd")
    if quoted.amount > max_cost:
        raise ProxyPurchaseError("COST_LIMIT_EXCEEDED", "Provider cost exceeds the configured ceiling", 409)
    charge_units = _points_units(quoted.amount, config)
    _assert_profitable(quoted.amount, charge_units, config, _lowest_cash_per_point(conn))
    request_record = {**request, "autoRenew": bool(auto_renew), "countryName": countries[clean_country]}
    request_hash = hashlib.sha256(_json(request_record).encode()).hexdigest()
    quote_id = _id("proxy_quote")
    expires_at = current + int(config["quote_ttl_seconds"])
    conn.execute(
        "INSERT INTO proxy_purchase_quotes(id,user_id,provider_key,service_id,request_hash,request_json,"
        "provider_price_minor,provider_currency,credit_units,config_version_id,status,expires_at,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?)",
        (
            quote_id,
            int(user_id),
            "proxycheap",
            str(config["service_id"]),
            request_hash,
            _json(request_record),
            _minor_units(quoted.amount),
            quoted.currency,
            charge_units,
            str(config["id"]),
            expires_at,
            current,
            current,
        ),
    )
    return {
        "id": quote_id,
        "country": clean_country,
        "country_name": countries[clean_country],
        "period": {"unit": "months", "value": months},
        "quantity": 1,
        "auto_renew": bool(auto_renew),
        "charge_units": charge_units,
        "charge_points": charge_units / POINT_SCALE,
        "expires_at": expires_at,
    }


def _provider_order_id(payload: Mapping[str, Any]) -> str:
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else {}
    return str(payload.get("orderId") or payload.get("id") or data.get("orderId") or data.get("id") or "")


def _status(payload: Mapping[str, Any]) -> str:
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else {}
    return str(payload.get("status") or data.get("status") or "pending").strip().lower()


def _safe_provider_summary(payload: Mapping[str, Any]) -> str:
    allowed = {key: payload.get(key) for key in ("id", "orderId", "status", "createdAt", "expiresAt") if key in payload}
    data = payload.get("data")
    if isinstance(data, Mapping):
        allowed["data"] = {
            key: data.get(key) for key in ("id", "orderId", "status", "createdAt", "expiresAt") if key in data
        }
    return _json(allowed)


def _balance_usd(payload: Mapping[str, Any]) -> Decimal | None:
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    currency = str(data.get("currency") or payload.get("currency") or "").upper()
    if currency != "USD":
        return None
    for key in ("balance", "amount", "availableBalance", "available"):
        try:
            value = Decimal(str(data.get(key)))
        except (InvalidOperation, TypeError, ValueError):
            continue
        if value.is_finite() and value >= 0:
            return value
    return None


def _public_order(row: Mapping[str, Any]) -> dict[str, Any]:
    result = {key: row[key] for key in _ORDER_PUBLIC_FIELDS if key in row.keys()}
    status = str(result.get("status") or "")
    messages = {
        "reserved": "订单已创建，正在提交供应商",
        "provider_unknown": "供应商结果待确认，系统正在自动对账",
        "provisioning": "订单已受理，正在配置代理",
        "active": "购买成功，代理已加入你的列表",
        "failed": "购买失败，预占点数已释放",
    }
    result["message"] = messages.get(status, "订单正在处理")
    result["charge_points"] = int(result.get("credit_units") or 0) / POINT_SCALE
    result["auto_renew"] = bool(result.get("renewal_enabled"))
    return result


def create_order(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    quote_id: str,
    idempotency_key: str,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    current = int(now or _now())
    idem = str(idempotency_key or "").strip()[:160]
    if not idem:
        raise ProxyPurchaseError("IDEMPOTENCY_REQUIRED", "An idempotency key is required", 400)
    existing = conn.execute(
        "SELECT * FROM proxy_purchase_orders WHERE idempotency_key=? AND user_id=?", (idem, int(user_id))
    ).fetchone()
    if existing is not None:
        if str(existing["quote_id"]) != str(quote_id):
            raise ProxyPurchaseError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another request", 409)
        return _public_order(existing)
    quote_row = conn.execute(
        "SELECT * FROM proxy_purchase_quotes WHERE id=? AND user_id=?", (str(quote_id), int(user_id))
    ).fetchone()
    if quote_row is None:
        raise ProxyPurchaseError("QUOTE_NOT_FOUND", "Quote was not found", 404)
    if str(quote_row["status"]) != "open" or int(quote_row["expires_at"]) <= current:
        raise ProxyPurchaseError("QUOTE_EXPIRED", "Quote has expired; request a new quote", 409)
    provider = provider or provider_from_environment()
    if not bool(getattr(provider, "safe_reconciliation_enabled", isinstance(provider, MockProxyProvider))):
        raise ProxyPurchaseError(
            "SAFE_RECONCILIATION_NOT_CONFIRMED",
            "Real purchasing requires PROXYCHEAP_EXECUTE_SAFE_RECONCILIATION=true after provider confirmation",
            503,
        )
    config_row = conn.execute(
        "SELECT * FROM proxy_purchase_config_versions WHERE id=? AND status='active'",
        (str(quote_row["config_version_id"]),),
    ).fetchone()
    if config_row is None:
        raise ProxyPurchaseError("QUOTE_CONFIG_RETIRED", "Pricing configuration changed; request a new quote", 409)
    config = validate_config(_loads(config_row["config_json"], {}))
    request_record = _loads(quote_row["request_json"], {})
    request = {key: value for key, value in request_record.items() if key not in {"autoRenew", "countryName"}}
    fresh = provider.quote(str(quote_row["service_id"]), request)
    fresh_minor = _minor_units(fresh.amount)
    if fresh.currency != "USD" or fresh_minor > int(quote_row["provider_price_minor"]):
        conn.execute("UPDATE proxy_purchase_quotes SET status='repriced',updated_at=? WHERE id=?", (current, quote_id))
        raise ProxyPurchaseError("PRICE_CHANGED", "Provider price increased; confirm a new quote", 409)
    if fresh.amount > _decimal(config["max_vendor_cost_usd"], "max_vendor_cost_usd"):
        raise ProxyPurchaseError("COST_LIMIT_EXCEEDED", "Provider cost exceeds the configured ceiling", 409)
    _assert_profitable(
        fresh.amount,
        int(quote_row["credit_units"]),
        config,
        _lowest_cash_per_point(conn),
    )
    balance = _balance_usd(provider.get_balance())
    if balance is None or balance < fresh.amount:
        raise ProxyPurchaseError("PROVIDER_BALANCE_INSUFFICIENT", "Provider account balance is insufficient", 503)

    conn.execute("BEGIN IMMEDIATE")
    concurrent = conn.execute(
        "SELECT * FROM proxy_purchase_orders WHERE idempotency_key=? AND user_id=?", (idem, int(user_id))
    ).fetchone()
    if concurrent is not None:
        if str(concurrent["quote_id"]) != str(quote_id):
            conn.rollback()
            raise ProxyPurchaseError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another request", 409)
        conn.commit()
        return _public_order(concurrent)
    locked_quote = conn.execute(
        "SELECT status,expires_at FROM proxy_purchase_quotes WHERE id=? AND user_id=?",
        (str(quote_id), int(user_id)),
    ).fetchone()
    if (
        locked_quote is None
        or str(locked_quote["status"]) != "open"
        or int(locked_quote["expires_at"]) <= current
    ):
        conn.rollback()
        raise ProxyPurchaseError("QUOTE_ALREADY_USED", "Quote has expired or was already used", 409)
    order_id = _id("proxy_order")
    client_reference = f"vecto-{order_id}"
    reservation = commercial_billing.reserve_exact_cash_charge(
        conn,
        user_id=int(user_id),
        ref_type="proxy_purchase",
        ref_id=order_id,
        sku="proxycheap_owned_proxy",
        credit_units=int(quote_row["credit_units"]),
        idempotency_key=f"proxy-purchase:{int(user_id)}:{idem}",
        meta={"quote_id": str(quote_id), "provider": "proxycheap"},
        now=current,
    )
    reservation_id = str(reservation["id"])
    conn.execute(
        "INSERT INTO proxy_purchase_orders(id,user_id,quote_id,reservation_id,provider_key,provider_order_id,"
        "provider_proxy_id,request_hash,request_json,provider_cost_minor,provider_currency,credit_units,"
        "config_version_id,status,renewal_enabled,idempotency_key,error_code,error_detail,provider_response_json,"
        "last_synced_at,completed_at,created_at,updated_at,next_attempt_at,reconcile_attempts,client_reference) "
        "VALUES (?,?,?,?,?,'','',?,?,?,?,?,?,'reserved',?,?,'','','{}',0,0,?,?,?,0,?)",
        (
            order_id,
            int(user_id),
            str(quote_id),
            reservation_id,
            "proxycheap",
            str(quote_row["request_hash"]),
            str(quote_row["request_json"]),
            fresh_minor,
            "USD",
            int(quote_row["credit_units"]),
            str(quote_row["config_version_id"]),
            1 if bool(request_record.get("autoRenew")) else 0,
            idem,
            current,
            current,
            current + 60,
            client_reference,
        ),
    )
    conn.execute("UPDATE proxy_purchase_quotes SET status='accepted',updated_at=? WHERE id=?", (current, quote_id))
    # Persist the hold and unique order before the one-shot external mutation.
    conn.commit()
    try:
        result = provider.execute(str(quote_row["service_id"]), request)
    except ProxyProviderOutcomeUnknown as exc:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='provider_unknown',error_code=?,error_detail=?,next_attempt_at=?,"
            "reconcile_attempts=reconcile_attempts+1,updated_at=? WHERE id=?",
            (exc.code, str(exc), current + 300, current, order_id),
        )
        conn.commit()
        return _public_order(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())
    except ProxyProviderError as exc:
        conn.execute("BEGIN IMMEDIATE")
        commercial_billing.release_reservation(conn, reservation_id, now=current)
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='failed',error_code=?,error_detail=?,updated_at=? WHERE id=?",
            (exc.code, str(exc), current, order_id),
        )
        conn.commit()
        if isinstance(exc, ProxyProviderConfigurationError):
            raise
        return _public_order(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())

    provider_order_id = _provider_order_id(result)
    if not provider_order_id:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='provider_unknown',error_code='MISSING_PROVIDER_ORDER_ID',"
            "error_detail='Provider accepted the request without a reconcilable order id',next_attempt_at=?,"
            "reconcile_attempts=reconcile_attempts+1,updated_at=? WHERE id=?",
            (current + 300, current, order_id),
        )
        conn.commit()
    else:
        # Persist the only supplier-side reconciliation key before touching the
        # local settlement. If the process stops after this commit, the worker
        # can safely resume delivery without issuing Execute again.
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE proxy_purchase_orders SET provider_order_id=?,status='provisioning',provider_response_json=?,"
            "last_synced_at=?,updated_at=? WHERE id=?",
            (provider_order_id, _safe_provider_summary(result), current, current, order_id),
        )
        conn.commit()
        try:
            reconcile_order(conn, order_id=order_id, provider=provider)
        except Exception as exc:
            # Execute already succeeded. Preserve the committed order for compensation;
            # never release points or let a delivery write failure cause a second purchase.
            conn.rollback()
            conn.execute(
                "UPDATE proxy_purchase_orders SET error_code='DELIVERY_PENDING',error_detail=?,updated_at=? WHERE id=?",
                (type(exc).__name__, current, order_id),
            )
            conn.commit()
    return _public_order(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())


def _parse_timestamp(value: Any) -> int:
    if isinstance(value, (int, float)):
        return max(int(value), 0)
    clean = str(value or "").strip()
    if not clean:
        return 0
    try:
        return int(datetime.fromisoformat(clean.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def _proxy_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [dict(item) for item in payload if isinstance(item, Mapping)]
    if isinstance(payload, Mapping):
        for key in ("data", "proxies", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return [dict(item) for item in value if isinstance(item, Mapping)]
            if isinstance(value, Mapping):
                nested = _proxy_list(value)
                if nested:
                    return nested
    return []


def _proxy_field(proxy: Mapping[str, Any], *keys: str) -> Any:
    containers: list[Mapping[str, Any]] = [proxy]
    for container_key in ("connection", "credentials", "authentication", "location", "proxy", "data"):
        nested = proxy.get(container_key)
        if isinstance(nested, Mapping):
            containers.append(nested)
    for container in containers:
        for key in keys:
            value = container.get(key)
            if value not in (None, ""):
                return value
    return ""


def _deliver_owned_proxy(
    conn: sqlite3.Connection, *, order: Mapping[str, Any], proxy: Mapping[str, Any], now: int
) -> str:
    provider_proxy_id = str(_proxy_field(proxy, "id", "proxyId")).strip()
    if not provider_proxy_id:
        raise ProxyPurchaseError("INVALID_PROVIDER_PROXY", "Provider proxy has no id", 502)
    existing = conn.execute(
        "SELECT id,owner_user_id,provider_purchase_order_id FROM proxy_market_items "
        "WHERE provider_key='proxycheap' AND provider_proxy_id=?",
        (provider_proxy_id,),
    ).fetchone()
    if existing is not None:
        if (
            int(existing["owner_user_id"] or 0) != int(order["user_id"])
            or str(existing["provider_purchase_order_id"] or "") != str(order["id"])
        ):
            raise ProxyPurchaseError(
                "PROVIDER_PROXY_OWNERSHIP_CONFLICT",
                "Provider proxy id is already bound to another owner or purchase",
                409,
            )
        return str(existing["id"])
    host = str(_proxy_field(proxy, "host", "hostname", "connectIp", "ip", "address")).strip()
    user_id = int(order["user_id"])
    item_id = _id("owned_proxy_item")
    social_id = _id("social_proxy")
    username_cipher, password_cipher = encrypt_market_credentials(
        item_id,
        user_id,
        str(_proxy_field(proxy, "username", "user", "login")),
        str(_proxy_field(proxy, "password", "pass")),
    )
    country = str(_proxy_field(proxy, "country", "countryCode")).upper()
    expires_at = _parse_timestamp(_proxy_field(proxy, "expiresAt", "expires_at", "expirationDate"))
    explicit_protocol = str(_proxy_field(proxy, "protocol", "proxyType", "type") or "").lower()
    if "socks" in explicit_protocol:
        explicit_protocol = "socks5"
    elif "https" in explicit_protocol:
        explicit_protocol = "https"
    elif "http" in explicit_protocol:
        explicit_protocol = "http"
    if explicit_protocol:
        protocol = explicit_protocol
    elif _proxy_field(proxy, "httpPort"):
        protocol = "http"
    elif _proxy_field(proxy, "httpsPort"):
        protocol = "https"
    else:
        protocol = "socks5"
    if protocol not in {"http", "https", "socks5"}:
        protocol = "http"
    port_keys = {
        "http": ("httpPort", "port", "httpsPort", "socks5Port"),
        "https": ("httpsPort", "port", "httpPort", "socks5Port"),
        "socks5": ("socks5Port", "port", "httpsPort", "httpPort"),
    }[protocol]
    port = int(_proxy_field(proxy, *port_keys) or 0)
    if not host or port < 1 or port > 65535:
        raise ProxyPurchaseError("INVALID_PROVIDER_PROXY", "Provider proxy endpoint is incomplete", 502)
    conn.execute(
        "INSERT INTO proxy_market_items(id,sku,display_name,provider_key,proxy_type,host,port,credential_owner_user_id,"
        "username_ciphertext,password_ciphertext,country,region,city,isp,ip_type,description,tags_json,use_cases_json,"
        "display_price_cents,currency,billing_cycle,status,health_status,latency_ms,last_check_at,last_check_result_json,"
        "expires_at,published_at,created_by,updated_by,version,created_at,updated_at,ownership_type,owner_user_id,"
        "provider_purchase_order_id,provider_proxy_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            item_id,
            f"proxycheap-{provider_proxy_id}",
            f"Proxy-Cheap {country or 'Proxy'}",
            "proxycheap",
            protocol,
            host,
            port,
            user_id,
            username_cipher,
            password_cipher,
            country,
            str(_proxy_field(proxy, "region", "state")),
            str(_proxy_field(proxy, "city")),
            str(_proxy_field(proxy, "isp")),
            "static_residential",
            "Owned provider purchase",
            "[]",
            "[]",
            0,
            "USD",
            "month",
            "allocated",
            "pending",
            0,
            0,
            "{}",
            expires_at,
            now,
            user_id,
            user_id,
            1,
            now,
            now,
            "owned",
            user_id,
            str(order["id"]),
            provider_proxy_id,
        ),
    )
    conn.execute(
        "INSERT INTO social_proxies(id,user_id,name,proxy_type,host,port,username,password,country,region,city,isp,"
        "source,ip_type,purchase_status,note,expires_at,status,last_check_at,last_check_result,client_request_id,"
        "market_item_id,market_allocation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            social_id,
            user_id,
            f"Proxy-Cheap {country or 'Proxy'}",
            protocol,
            host,
            port,
            "",
            "",
            country,
            str(_proxy_field(proxy, "region", "state")),
            str(_proxy_field(proxy, "city")),
            str(_proxy_field(proxy, "isp")),
            "provider_purchase",
            "static_residential",
            "owned",
            f"Provider order {str(order['id'])}",
            expires_at,
            "active",
            0,
            "",
            "",
            item_id,
            "",
            now,
            now,
        ),
    )
    return item_id


def _refund_or_release_failed_order(
    conn: sqlite3.Connection, *, reservation_id: str, reason: str, now: int
) -> None:
    reservation = conn.execute(
        "SELECT status FROM billing_reservations WHERE id=?", (str(reservation_id),)
    ).fetchone()
    if reservation is None:
        return
    status = str(reservation["status"])
    if status == "held":
        commercial_billing.release_reservation(conn, str(reservation_id), now=now)
    elif status == "settled":
        commercial_billing.refund_settled_exact_cash_charge(
            conn, str(reservation_id), reason=str(reason), now=now
        )


def reconcile_order(
    conn: sqlite3.Connection,
    *,
    order_id: str,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    current = int(now or _now())
    row = conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (str(order_id),)).fetchone()
    if row is None:
        raise ProxyPurchaseError("ORDER_NOT_FOUND", "Purchase order was not found", 404)
    order = dict(row)
    provider_order_id = str(order.get("provider_order_id") or "")
    if not provider_order_id:
        # There is no safe provider-side lookup key after an unknown Execute outcome.
        return _public_order(row)
    provider = provider or provider_from_environment()
    details = provider.get_order(provider_order_id)
    proxies = _proxy_list(provider.get_order_proxies(provider_order_id))
    active = next((item for item in proxies if _status(item) in _ACTIVE_STATUSES), None)
    proxy_statuses = {_status(item) for item in proxies}
    order_status = _status(details)
    terminal = bool(proxies and proxy_statuses.issubset(_TERMINAL_FAILURES)) or (
        not proxies and order_status in _TERMINAL_FAILURES
    )
    if terminal:
        conn.execute("BEGIN IMMEDIATE")
        owned = conn.execute(
            "SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=? AND ownership_type='owned' "
            "AND owner_user_id=? LIMIT 1",
            (str(order_id), int(order["user_id"])),
        ).fetchone()
        was_delivered = bool(int(order.get("completed_at") or 0) > 0 or owned is not None)
        terminal_status = next(iter(proxy_statuses & _TERMINAL_FAILURES), "expired")
        if not was_delivered:
            _refund_or_release_failed_order(
                conn,
                reservation_id=str(order["reservation_id"]),
                reason="provider_terminal_failure_before_delivery",
                now=current,
            )
            conn.execute(
                "UPDATE proxy_purchase_orders SET status='failed',error_code='PROVIDER_TERMINAL_FAILURE',"
                "provider_response_json=?,last_synced_at=?,updated_at=? WHERE id=?",
                (_safe_provider_summary(details), current, current, str(order_id)),
            )
        else:
            conn.execute(
                "UPDATE proxy_purchase_orders SET status=?,error_code='',provider_response_json=?,last_synced_at=?,updated_at=? WHERE id=?",
                (terminal_status, _safe_provider_summary(details), current, current, str(order_id)),
            )
            conn.execute(
                "UPDATE proxy_market_items SET status='retired',updated_at=? WHERE provider_purchase_order_id=?",
                (current, str(order_id)),
            )
            conn.execute(
                "UPDATE social_proxies SET status='inactive',updated_at=? WHERE market_item_id IN "
                "(SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)",
                (current, str(order_id)),
            )
            conn.execute(
                "UPDATE proxy_renewal_schedules SET enabled=0,status=?,lease_token='',lease_expires_at=0,"
                "last_error='provider proxy reached terminal state',updated_at=? WHERE order_id=?",
                (terminal_status, current, str(order_id)),
            )
        conn.commit()
    elif active is not None:
        conn.execute("BEGIN IMMEDIATE")
        refreshed = dict(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())
        reservation = conn.execute(
            "SELECT status FROM billing_reservations WHERE id=?",
            (str(refreshed["reservation_id"]),),
        ).fetchone()
        # Settlement intentionally happens only after owned delivery succeeds,
        # inside this same transaction.
        _deliver_owned_proxy(conn, order=refreshed, proxy=active, now=current)
        if reservation is not None and str(reservation["status"]) == "held":
            commercial_billing.settle_reservation(conn, str(refreshed["reservation_id"]), now=current)
        proxy_id = str(_proxy_field(active, "id", "proxyId"))
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='active',provider_proxy_id=?,provider_response_json=?,"
            "last_synced_at=?,completed_at=?,updated_at=? WHERE id=?",
            (proxy_id, _safe_provider_summary(details), current, current, current, order_id),
        )
        if int(refreshed.get("renewal_enabled") or 0):
            expires_at = _parse_timestamp(
                _proxy_field(active, "expiresAt", "expires_at", "expirationDate")
            )
            renewal_status = "scheduled" if expires_at > current + 300 else "missing_expiry"
            conn.execute(
                "INSERT INTO proxy_renewal_schedules(id,order_id,user_id,provider_proxy_id,enabled,status,"
                "next_attempt_at,expires_at,last_error,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,1,?,"
                "?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET provider_proxy_id=excluded.provider_proxy_id,"
                "enabled=1,status=excluded.status,next_attempt_at=excluded.next_attempt_at,expires_at=excluded.expires_at,"
                "last_error=excluded.last_error,updated_at=excluded.updated_at",
                (
                    _id("proxy_renew"),
                    order_id,
                    int(refreshed["user_id"]),
                    proxy_id,
                    renewal_status,
                    max(expires_at - 3 * 86400, current) if renewal_status == "scheduled" else current + 300,
                    expires_at,
                    "" if renewal_status == "scheduled" else "provider expiry is unavailable",
                    f"renew:{order_id}:{expires_at}",
                    current,
                    current,
                ),
            )
        conn.commit()
    else:
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='provisioning',provider_response_json=?,last_synced_at=?,updated_at=? WHERE id=?",
            (_safe_provider_summary(details), current, current, order_id),
        )
        conn.commit()
    return _public_order(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())


def resolve_unknown_order(
    conn: sqlite3.Connection,
    *,
    order_id: str,
    resolution: str,
    provider_order_id: str = "",
    actor_user_id: int = 0,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Resolve an unknown Execute outcome without ever replaying Execute."""
    current = int(now or _now())
    clean_resolution = str(resolution or "").strip().lower()
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (str(order_id),)).fetchone()
    if row is None:
        conn.rollback()
        raise ProxyPurchaseError("ORDER_NOT_FOUND", "Purchase order was not found", 404)
    if str(row["status"]) not in {"provider_unknown", "provisioning", "failed", "active"}:
        conn.rollback()
        raise ProxyPurchaseError("ORDER_NOT_RESOLVABLE", "Purchase order is not in a resolvable state", 409)
    if clean_resolution == "bind_provider_order":
        clean_provider_id = str(provider_order_id or "").strip()
        if not clean_provider_id:
            conn.rollback()
            raise ProxyPurchaseError("PROVIDER_ORDER_REQUIRED", "Provider order id is required", 400)
        existing = str(row["provider_order_id"] or "")
        if existing and existing != clean_provider_id:
            conn.rollback()
            raise ProxyPurchaseError("PROVIDER_ORDER_CONFLICT", "A different provider order is already bound", 409)
        conn.execute(
            "UPDATE proxy_purchase_orders SET provider_order_id=?,status='provisioning',error_code='',error_detail='',"
            "next_attempt_at=?,updated_at=? WHERE id=?",
            (clean_provider_id, current, current, str(order_id)),
        )
        conn.commit()
        return reconcile_order(conn, order_id=str(order_id), provider=provider, now=current)
    if clean_resolution == "confirm_not_ordered":
        if str(row["status"]) == "failed" and str(row["error_code"]) == "MANUAL_CONFIRMED_NOT_ORDERED":
            conn.commit()
            return _public_order(row)
        if str(row["provider_order_id"] or ""):
            conn.rollback()
            raise ProxyPurchaseError(
                "PROVIDER_ORDER_ALREADY_BOUND", "Cannot release an order with a provider order id", 409
            )
        _refund_or_release_failed_order(
            conn,
            reservation_id=str(row["reservation_id"]),
            reason=f"manual_not_ordered:{int(actor_user_id)}",
            now=current,
        )
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='failed',error_code='MANUAL_CONFIRMED_NOT_ORDERED',"
            "error_detail='',updated_at=? WHERE id=?",
            (current, str(order_id)),
        )
        conn.commit()
        return _public_order(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())
    conn.rollback()
    raise ProxyPurchaseError("INVALID_RESOLUTION", "Unknown order resolution action", 400)


def admin_resolve_order(
    conn: sqlite3.Connection,
    order_id: str,
    action: str,
    provider_order_id: str = "",
    actor_user_id: int = 0,
    provider: ProxyProvider | None = None,
) -> dict[str, Any]:
    action_aliases = {
        "bind": "bind_provider_order",
        "bind_provider_order": "bind_provider_order",
        "confirm_not_created": "confirm_not_ordered",
        "confirm_not_ordered": "confirm_not_ordered",
    }
    return resolve_unknown_order(
        conn,
        order_id=str(order_id),
        resolution=action_aliases.get(str(action).strip().lower(), str(action)),
        provider_order_id=str(provider_order_id),
        actor_user_id=int(actor_user_id),
        provider=provider,
    )


def set_order_renewal(
    conn: sqlite3.Connection, *, user_id: int, order_id: str, enabled: bool, now: int | None = None
) -> dict[str, Any]:
    current = int(now or _now())
    row = conn.execute(
        "SELECT * FROM proxy_purchase_orders WHERE id=? AND user_id=?", (str(order_id), int(user_id))
    ).fetchone()
    if row is None:
        raise ProxyPurchaseError("ORDER_NOT_FOUND", "Purchase order was not found", 404)
    conn.execute(
        "UPDATE proxy_purchase_orders SET renewal_enabled=?,updated_at=? WHERE id=?",
        (1 if enabled else 0, current, str(order_id)),
    )
    conn.execute(
        "UPDATE proxy_renewal_schedules SET enabled=?,status=?,updated_at=? WHERE order_id=?",
        (1 if enabled else 0, "scheduled" if enabled else "disabled", current, str(order_id)),
    )
    if enabled and str(row["status"]) == "active":
        asset = conn.execute(
            "SELECT expires_at FROM proxy_market_items WHERE provider_purchase_order_id=? "
            "AND provider_proxy_id=? AND ownership_type='owned' AND owner_user_id=?",
            (str(order_id), str(row["provider_proxy_id"]), int(user_id)),
        ).fetchone()
        expires_at = int(asset["expires_at"] or 0) if asset else 0
        status = "scheduled" if expires_at > current else "missing_expiry"
        conn.execute(
            "INSERT INTO proxy_renewal_schedules(id,order_id,user_id,provider_proxy_id,enabled,status,next_attempt_at,"
            "expires_at,last_error,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,?,?,?) "
            "ON CONFLICT(order_id) DO UPDATE SET enabled=1,status=excluded.status,next_attempt_at=excluded.next_attempt_at,"
            "expires_at=excluded.expires_at,last_error=excluded.last_error,updated_at=excluded.updated_at",
            (
                _id("proxy_renew"), str(order_id), int(user_id), str(row["provider_proxy_id"]), status,
                max(expires_at - 3 * 86400, current) if expires_at else 0,
                expires_at, "" if expires_at else "provider expiry is unavailable",
                f"renew:{order_id}:{expires_at}", current, current,
            ),
        )
    return _public_order(conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone())


def get_order(conn: sqlite3.Connection, *, user_id: int, order_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM proxy_purchase_orders WHERE id=? AND user_id=?", (str(order_id), int(user_id))
    ).fetchone()
    if row is None:
        raise ProxyPurchaseError("ORDER_NOT_FOUND", "Purchase order was not found", 404)
    return _public_order(row)


def process_due_renewals(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> list[dict[str, Any]]:
    current = int(now or _now())
    provider = provider or provider_from_environment()
    results: list[dict[str, Any]] = []
    missing = conn.execute(
        "SELECT * FROM proxy_renewal_schedules WHERE enabled=1 AND status='missing_expiry' AND next_attempt_at<=? "
        "ORDER BY next_attempt_at LIMIT ?", (current, min(max(int(limit), 1), 100))
    ).fetchall()
    for raw in missing:
        schedule = dict(raw)
        try:
            proxy = provider.get_proxy(str(schedule["provider_proxy_id"]))
            expires_at = _parse_timestamp(_proxy_field(proxy, "expiresAt", "expires_at", "expirationDate"))
            if expires_at <= current + 300:
                conn.execute("UPDATE proxy_renewal_schedules SET next_attempt_at=?,last_error='provider expiry is unavailable',updated_at=? WHERE id=?", (current + 300, current, str(schedule["id"])))
            else:
                conn.execute("UPDATE proxy_renewal_schedules SET status='scheduled',next_attempt_at=?,expires_at=?,last_error='',updated_at=? WHERE id=?", (max(expires_at - 3 * 86400, current), expires_at, current, str(schedule["id"])))
            conn.commit()
        except Exception:
            conn.rollback()
            conn.execute("UPDATE proxy_renewal_schedules SET next_attempt_at=?,last_error='expiry sync failed',updated_at=? WHERE id=?", (current + 300, current, str(schedule["id"])))
            conn.commit()
    uncertain = conn.execute(
        "SELECT * FROM proxy_renewal_schedules WHERE enabled=1 AND status IN ('extending','provider_unknown') "
        "ORDER BY updated_at LIMIT ?", (min(max(int(limit), 1), 100),)
    ).fetchall()
    for raw in uncertain:
        schedule = dict(raw)
        try:
            proxy = provider.get_proxy(str(schedule["provider_proxy_id"]))
            actual_expiry = _parse_timestamp(_proxy_field(proxy, "expiresAt", "expires_at", "expirationDate"))
            baseline = int(schedule["baseline_expires_at"] or schedule["expires_at"] or 0)
            if actual_expiry <= baseline:
                conn.execute(
                    "UPDATE proxy_renewal_schedules SET status='provider_unknown',lease_token='',lease_expires_at=0,"
                    "last_error='renewal outcome still unconfirmed',updated_at=? WHERE id=?",
                    (current, str(schedule["id"])),
                )
                conn.commit()
                continue
            conn.execute("BEGIN IMMEDIATE")
            commercial_billing.settle_reservation(conn, str(schedule["reservation_id"]), now=current)
            _complete_renewal(conn, schedule=schedule, expires_at=actual_expiry, now=current)
            conn.commit()
            results.append({"order_id": str(schedule["order_id"]), "status": "renewed"})
        except ProxyProviderError:
            conn.rollback()
            continue

    due = conn.execute(
        "SELECT id FROM proxy_renewal_schedules WHERE enabled=1 AND status IN ('scheduled','provider_balance_low') "
        "AND next_attempt_at<=? AND lease_expires_at<=? ORDER BY next_attempt_at LIMIT ?",
        (current, current, min(max(int(limit), 1), 100)),
    ).fetchall()
    for candidate in due:
        lease = uuid.uuid4().hex
        try:
            conn.execute("BEGIN IMMEDIATE")
            claimed = conn.execute(
                "UPDATE proxy_renewal_schedules SET status='quoting',lease_token=?,lease_expires_at=?,updated_at=? "
                "WHERE id=? AND enabled=1 AND status IN ('scheduled','provider_balance_low') AND next_attempt_at<=? "
                "AND lease_expires_at<=?",
                (lease, current + 300, current, str(candidate["id"]), current, current),
            ).rowcount
            conn.commit()
            if claimed != 1:
                continue
            schedule_row = conn.execute(
                "SELECT schedule.*,orders.config_version_id FROM proxy_renewal_schedules schedule "
                "JOIN proxy_purchase_orders orders ON orders.id=schedule.order_id WHERE schedule.id=? AND schedule.lease_token=?",
                (str(candidate["id"]), lease),
            ).fetchone()
            if schedule_row is None:
                continue
            schedule = dict(schedule_row)
            if not bool(getattr(provider, "safe_reconciliation_enabled", isinstance(provider, MockProxyProvider))):
                conn.execute(
                    "UPDATE proxy_renewal_schedules SET status='config_blocked',lease_token='',lease_expires_at=0,"
                    "last_error='safe reconciliation is not enabled',updated_at=? WHERE id=? AND lease_token=?",
                    (current, str(schedule["id"]), lease),
                )
                conn.commit()
                continue
            quote = provider.extension_quote(str(schedule["provider_proxy_id"]), period_months=1)
            cfg_row = conn.execute("SELECT config_json FROM proxy_purchase_config_versions WHERE id=?", (str(schedule["config_version_id"]),)).fetchone()
            if quote.currency != "USD" or cfg_row is None:
                raise ProxyPurchaseError("RENEWAL_CONFIG_INVALID", "Renewal pricing configuration is invalid", 409)
            config = validate_config(_loads(cfg_row["config_json"], {}))
            units = _points_units(quote.amount, config)
            _assert_profitable(quote.amount, units, config, _lowest_cash_per_point(conn))
            if quote.amount > _decimal(config["max_vendor_cost_usd"], "max_vendor_cost_usd"):
                _disable_renewal(conn, schedule, "cost_limit", "cost ceiling exceeded", current)
                continue
            provider_balance = _balance_usd(provider.get_balance())
            if provider_balance is None or provider_balance < quote.amount:
                conn.execute(
                    "UPDATE proxy_renewal_schedules SET status='provider_balance_low',next_attempt_at=?,lease_token='',"
                    "lease_expires_at=0,last_error='provider balance insufficient',updated_at=? WHERE id=? AND lease_token=?",
                    (current + 3600, current, str(schedule["id"]), lease),
                )
                conn.commit()
                continue
            conn.execute("BEGIN IMMEDIATE")
            reservation = commercial_billing.reserve_exact_cash_charge(
                conn, user_id=int(schedule["user_id"]), ref_type="proxy_renewal", ref_id=str(schedule["id"]),
                sku="proxycheap_owned_proxy_renewal", credit_units=units,
                idempotency_key=str(schedule["idempotency_key"]),
                meta={"order_id": str(schedule["order_id"]), "provider_proxy_id": str(schedule["provider_proxy_id"])}, now=current,
            )
            conn.execute(
                "UPDATE proxy_renewal_schedules SET status='extending',reservation_id=?,provider_started_at=?,"
                "baseline_expires_at=expires_at,updated_at=? WHERE id=? AND lease_token=?",
                (str(reservation["id"]), current, current, str(schedule["id"]), lease),
            )
            conn.commit()
            response = provider.extend_period(str(schedule["provider_proxy_id"]), period_months=1)
            actual_expiry = _parse_timestamp(_proxy_field(response, "expiresAt", "expires_at", "expirationDate"))
            if actual_expiry <= int(schedule["expires_at"] or 0):
                actual = provider.get_proxy(str(schedule["provider_proxy_id"]))
                actual_expiry = _parse_timestamp(_proxy_field(actual, "expiresAt", "expires_at", "expirationDate"))
            if actual_expiry <= int(schedule["expires_at"] or 0):
                raise ProxyProviderOutcomeUnknown("Provider returned no confirmed extended expiry")
            conn.execute("BEGIN IMMEDIATE")
            commercial_billing.settle_reservation(conn, str(reservation["id"]), now=current)
            _complete_renewal(conn, schedule=schedule, expires_at=actual_expiry, now=current)
            conn.commit()
            results.append({"order_id": str(schedule["order_id"]), "status": "renewed"})
        except ProxyProviderOutcomeUnknown as exc:
            conn.rollback()
            conn.execute(
                "UPDATE proxy_renewal_schedules SET status='provider_unknown',lease_token='',lease_expires_at=0,"
                "last_error=?,updated_at=? WHERE id=?", (str(exc), current, str(candidate["id"])),
            )
            conn.commit()
        except ProxyProviderError as exc:
            conn.rollback()
            row = conn.execute("SELECT reservation_id FROM proxy_renewal_schedules WHERE id=?", (str(candidate["id"]),)).fetchone()
            if bool(getattr(exc, "definitive", False)) and row is not None and str(row["reservation_id"] or ""):
                conn.execute("BEGIN IMMEDIATE")
                commercial_billing.release_reservation(conn, str(row["reservation_id"]), now=current)
                conn.execute("UPDATE proxy_renewal_schedules SET enabled=0,status='failed',lease_token='',lease_expires_at=0,last_error=?,updated_at=? WHERE id=?", (str(exc), current, str(candidate["id"])))
                conn.commit()
            else:
                conn.execute("UPDATE proxy_renewal_schedules SET status='provider_unknown',lease_token='',lease_expires_at=0,last_error=?,updated_at=? WHERE id=?", (str(exc), current, str(candidate["id"])))
                conn.commit()
        except commercial_billing.BillingError as exc:
            conn.rollback()
            conn.execute(
                "UPDATE proxy_renewal_schedules SET enabled=0,status='insufficient_points',lease_token='',"
                "lease_expires_at=0,last_error=?,updated_at=? WHERE id=?", (str(exc), current, str(candidate["id"])),
            )
            conn.commit()
        except Exception as exc:
            conn.rollback()
            row = conn.execute("SELECT reservation_id,status FROM proxy_renewal_schedules WHERE id=?", (str(candidate["id"]),)).fetchone()
            if row is not None and str(row["status"]) == "extending":
                conn.execute("UPDATE proxy_renewal_schedules SET status='provider_unknown',lease_token='',lease_expires_at=0,last_error=?,updated_at=? WHERE id=?", (type(exc).__name__, current, str(candidate["id"])))
            else:
                conn.execute("UPDATE proxy_renewal_schedules SET status='scheduled',next_attempt_at=?,lease_token='',lease_expires_at=0,last_error=?,updated_at=? WHERE id=?", (current + 300, type(exc).__name__, current, str(candidate["id"])))
            conn.commit()
    return results


def _complete_renewal(conn: sqlite3.Connection, *, schedule: Mapping[str, Any], expires_at: int, now: int) -> None:
    conn.execute(
        "UPDATE proxy_renewal_schedules SET status='scheduled',next_attempt_at=?,expires_at=?,last_error='',"
        "idempotency_key=?,reservation_id='',lease_token='',lease_expires_at=0,provider_started_at=0,"
        "baseline_expires_at=0,updated_at=? WHERE id=?",
        (max(int(expires_at) - 3 * 86400, now), int(expires_at), f"renew:{schedule['order_id']}:{expires_at}", now, str(schedule["id"])),
    )
    conn.execute("UPDATE proxy_market_items SET expires_at=?,updated_at=? WHERE provider_purchase_order_id=?", (int(expires_at), now, str(schedule["order_id"])))
    conn.execute("UPDATE social_proxies SET expires_at=?,updated_at=? WHERE market_item_id IN (SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)", (int(expires_at), now, str(schedule["order_id"])))


def _disable_renewal(conn: sqlite3.Connection, schedule: Mapping[str, Any], status: str, error: str, now: int) -> None:
    conn.execute("UPDATE proxy_renewal_schedules SET enabled=0,status=?,lease_token='',lease_expires_at=0,last_error=?,updated_at=? WHERE id=?", (status, error, now, str(schedule["id"])))
    conn.commit()


def admin_resolve_renewal(
    conn: sqlite3.Connection,
    order_id: str,
    action: str,
    actor_user_id: int,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    current = int(now or _now())
    provider = provider or provider_from_environment()
    schedule_row = conn.execute("SELECT * FROM proxy_renewal_schedules WHERE order_id=?", (str(order_id),)).fetchone()
    if schedule_row is None:
        raise ProxyPurchaseError("RENEWAL_NOT_FOUND", "Renewal schedule was not found", 404)
    schedule = dict(schedule_row)
    clean_action = str(action or "").strip().lower()
    if clean_action not in {"reconcile", "confirm_extended", "confirm_not_extended"}:
        raise ProxyPurchaseError("INVALID_RENEWAL_RESOLUTION", "Unknown renewal resolution action", 400)
    if clean_action in {"reconcile", "confirm_extended"}:
        proxy = provider.get_proxy(str(schedule["provider_proxy_id"]))
        actual_expiry = _parse_timestamp(_proxy_field(proxy, "expiresAt", "expires_at", "expirationDate"))
        baseline = int(schedule["baseline_expires_at"] or schedule["expires_at"] or 0)
        if actual_expiry <= baseline:
            if clean_action == "confirm_extended":
                raise ProxyPurchaseError("RENEWAL_NOT_PROVEN", "Provider expiry does not prove an extension", 409)
            return {"order_id": str(order_id), "status": str(schedule["status"]), "expires_at": int(schedule["expires_at"] or 0)}
        conn.execute("BEGIN IMMEDIATE")
        if str(schedule["reservation_id"] or ""):
            commercial_billing.settle_reservation(conn, str(schedule["reservation_id"]), now=current)
        _complete_renewal(conn, schedule=schedule, expires_at=actual_expiry, now=current)
        conn.commit()
        return {"order_id": str(order_id), "status": "renewed", "expires_at": actual_expiry}
    if str(schedule["status"]) in {"failed", "not_extended"}:
        return {"order_id": str(order_id), "status": str(schedule["status"]), "expires_at": int(schedule["expires_at"] or 0)}
    if str(schedule["status"]) not in {"provider_unknown", "extending"}:
        raise ProxyPurchaseError("RENEWAL_NOT_RESOLVABLE", "Renewal is not awaiting manual resolution", 409)
    conn.execute("BEGIN IMMEDIATE")
    if str(schedule["reservation_id"] or ""):
        commercial_billing.release_reservation(conn, str(schedule["reservation_id"]), now=current)
    conn.execute(
        "UPDATE proxy_renewal_schedules SET enabled=0,status='not_extended',reservation_id='',lease_token='',"
        "lease_expires_at=0,last_error=?,updated_at=? WHERE id=?",
        (f"manual confirmation by admin {int(actor_user_id)}", current, str(schedule["id"])),
    )
    conn.commit()
    return {"order_id": str(order_id), "status": "not_extended", "expires_at": int(schedule["expires_at"] or 0)}


def verify_webhook_signature(
    raw_body: bytes, *, event_name: str, event_id: str, signature: str, secret: str | None = None
) -> bool:
    webhook_secret = str(secret if secret is not None else os.getenv("PROXYCHEAP_WEBHOOK_SECRET", "")).strip()
    if not webhook_secret or not event_name or not event_id or not signature:
        return False
    expected = hmac.new(
        webhook_secret.encode("utf-8"),
        str(event_name).encode("utf-8") + str(event_id).encode("utf-8") + bytes(raw_body),
        hashlib.sha256,
    ).hexdigest()
    received = str(signature).strip()
    if received.lower().startswith("sha256="):
        received = received[7:]
    return hmac.compare_digest(expected.lower(), received.lower())


def record_webhook(
    conn: sqlite3.Connection,
    *,
    raw_body: bytes,
    event_name: str,
    event_id: str,
    signature: str,
    secret: str | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    if (
        not str(event_name).strip()
        or len(str(event_name)) > 128
        or not str(event_id).strip()
        or len(str(event_id)) > 200
        or len(str(signature)) > 256
    ):
        raise ProxyPurchaseError("INVALID_WEBHOOK_HEADERS", "Webhook headers are invalid", 400)
    if not verify_webhook_signature(
        raw_body, event_name=event_name, event_id=event_id, signature=signature, secret=secret
    ):
        raise ProxyPurchaseError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid", 401)
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProxyPurchaseError("INVALID_WEBHOOK_BODY", "Webhook body must be valid JSON", 400) from exc
    if not isinstance(payload, dict):
        raise ProxyPurchaseError("INVALID_WEBHOOK_BODY", "Webhook body must be an object", 400)
    current = int(now or _now())
    proxy_id = str(payload.get("proxyId") or (payload.get("data") or {}).get("proxyId") or "")
    order_id = str(payload.get("orderId") or (payload.get("data") or {}).get("orderId") or "")
    def redact(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {
                str(key): ("[REDACTED]" if str(key).lower() in {"password", "secret", "token", "username"} else redact(item))
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    inserted = conn.execute(
        "INSERT OR IGNORE INTO proxy_purchase_events(id,event_id,order_id,provider_proxy_id,event_type,payload_json,"
        "signature_verified,processed_at,processing_status,attempt_count,next_attempt_at,last_error,created_at) "
        "VALUES (?,?,?,?,?,?,1,0,'pending',0,?,'',?)",
        (_id("proxy_event"), str(event_id), order_id, proxy_id, str(event_name), _json(redact(payload)), current, current),
    ).rowcount
    return {"accepted": True, "duplicate": inserted != 1, "event_id": str(event_id)}


def process_webhook_events(
    conn: sqlite3.Connection, *, limit: int = 50, provider: ProxyProvider | None = None, now: int | None = None
) -> list[str]:
    current = int(now or _now())
    provider = provider or provider_from_environment()
    ids = conn.execute(
        "SELECT id FROM proxy_purchase_events WHERE processing_status IN ('pending','retry') AND next_attempt_at<=? "
        "ORDER BY created_at LIMIT ?", (current, min(max(int(limit), 1), 200))
    ).fetchall()
    processed: list[str] = []
    for candidate in ids:
        event_id = str(candidate["id"])
        try:
            conn.execute("BEGIN IMMEDIATE")
            claimed = conn.execute(
                "UPDATE proxy_purchase_events SET processing_status='processing',attempt_count=attempt_count+1 "
                "WHERE id=? AND processing_status IN ('pending','retry') AND next_attempt_at<=?",
                (event_id, current),
            ).rowcount
            conn.commit()
            if claimed != 1:
                continue
            event = conn.execute("SELECT * FROM proxy_purchase_events WHERE id=?", (event_id,)).fetchone()
            order_id = str(event["order_id"] or "") if event else ""
            if not order_id and event and str(event["provider_proxy_id"] or ""):
                order = conn.execute(
                    "SELECT id FROM proxy_purchase_orders WHERE provider_proxy_id=?",
                    (str(event["provider_proxy_id"]),),
                ).fetchone()
                order_id = str(order["id"]) if order else ""
            if order_id:
                reconcile_order(conn, order_id=order_id, provider=provider, now=current)
                conn.execute("UPDATE proxy_purchase_events SET processing_status='processed',processed_at=?,last_error='' WHERE id=?", (current, event_id))
            else:
                conn.execute(
                    "UPDATE proxy_purchase_events SET processing_status='unmatched',processed_at=?,"
                    "last_error='local order not found' WHERE id=?", (current, event_id)
                )
            conn.commit()
            processed.append(event_id)
        except Exception as exc:
            conn.rollback()
            conn.execute(
                "UPDATE proxy_purchase_events SET processing_status='retry',next_attempt_at=?,last_error=? WHERE id=?",
                (current + 300, type(exc).__name__, event_id),
            )
            conn.commit()
    return processed


def sync_active_assets(
    conn: sqlite3.Connection, *, limit: int = 20, provider: ProxyProvider | None = None, now: int | None = None
) -> list[str]:
    current = int(now or _now())
    provider = provider or provider_from_environment()
    rows = conn.execute(
        "SELECT * FROM proxy_purchase_orders WHERE status='active' AND provider_proxy_id<>'' "
        "AND last_synced_at<=? ORDER BY last_synced_at LIMIT ?",
        (current - 3600, min(max(int(limit), 1), 100)),
    ).fetchall()
    synced: list[str] = []
    for raw in rows:
        order = dict(raw)
        try:
            proxy = provider.get_proxy(str(order["provider_proxy_id"]))
            status = _status(proxy)
            expires_at = _parse_timestamp(_proxy_field(proxy, "expiresAt", "expires_at", "expirationDate"))
            conn.execute("BEGIN IMMEDIATE")
            if status in _TERMINAL_FAILURES:
                conn.execute("UPDATE proxy_purchase_orders SET status=?,last_synced_at=?,updated_at=? WHERE id=?", (status, current, current, str(order["id"])))
                conn.execute("UPDATE proxy_market_items SET status='retired',expires_at=?,updated_at=? WHERE provider_purchase_order_id=?", (expires_at, current, str(order["id"])))
                conn.execute("UPDATE social_proxies SET status='inactive',expires_at=?,updated_at=? WHERE market_item_id IN (SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)", (expires_at, current, str(order["id"])))
                conn.execute("UPDATE proxy_renewal_schedules SET enabled=0,status=?,lease_token='',lease_expires_at=0,last_error='provider proxy reached terminal state',updated_at=? WHERE order_id=?", (status, current, str(order["id"])))
            else:
                conn.execute("UPDATE proxy_purchase_orders SET last_synced_at=?,updated_at=? WHERE id=?", (current, current, str(order["id"])))
                if expires_at:
                    conn.execute("UPDATE proxy_market_items SET expires_at=?,updated_at=? WHERE provider_purchase_order_id=?", (expires_at, current, str(order["id"])))
                    conn.execute("UPDATE social_proxies SET expires_at=?,updated_at=? WHERE market_item_id IN (SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)", (expires_at, current, str(order["id"])))
            conn.commit()
            synced.append(str(order["id"]))
        except Exception:
            conn.rollback()
            continue
    return synced


def list_orders(
    conn: sqlite3.Connection, *, user_id: int | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    if user_id is None:
        rows = conn.execute(
            "SELECT * FROM proxy_purchase_orders ORDER BY created_at DESC LIMIT ?", (min(max(limit, 1), 500),)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM proxy_purchase_orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (int(user_id), min(max(limit, 1), 100)),
        ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = _public_order(row)
        renewal = conn.execute(
            "SELECT status,last_error FROM proxy_renewal_schedules WHERE order_id=?", (str(row["id"]),)
        ).fetchone()
        item["renewal_status"] = str(renewal["status"] or "") if renewal else ""
        item["renewal_last_error"] = str(renewal["last_error"] or "") if renewal else ""
        if user_id is None:
            request = _loads(row["request_json"], {})
            item.update(
                {
                    "user_id": int(row["user_id"]),
                    "country": str(request.get("country") or ""),
                    "country_name": str(request.get("countryName") or request.get("country") or ""),
                    "vendor_price": str(Decimal(int(row["provider_cost_minor"] or 0)) / 100),
                    "currency": str(row["provider_currency"] or "USD"),
                }
            )
        result.append(item)
    return result


def provider_options(
    conn: sqlite3.Connection, *, provider: ProxyProvider | None = None,
    service_id: str = "", plan_id: str = ""
) -> dict[str, Any]:
    provider = provider or provider_from_environment()
    configured, purchasing = _provider_ready(provider)
    current = _now()
    config = get_config(conn)
    result: dict[str, Any] = {
        "provider": "proxycheap",
        "configured": configured,
        "live_purchasing_enabled": purchasing,
        "services": [],
        "setup": {},
        "balance": None,
        "last_sync_at": 0,
    }
    if configured:
        raw_services = provider.list_services()
        result["services"] = _list_values(raw_services, ("services", "items", "data"))
        selected_service = str(service_id or config["service_id"])
        if selected_service != "static-residential-ipv4":
            raise ProxyPurchaseError("UNSUPPORTED_SERVICE", "Only static-residential-ipv4 is supported", 409)
        setup = provider.get_setup(selected_service, plan_id=str(plan_id or config.get("plan_id") or ""))
        result["setup"] = (
            dict(setup["data"]) if isinstance(setup.get("data"), Mapping) else setup
        )
        balance_payload = provider.get_balance()
        balance = _balance_usd(balance_payload)
        result["balance"] = str(balance) if balance is not None else None
        result["last_sync_at"] = current
    return result


def reconcile_due_orders(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> list[dict[str, Any]]:
    provider = provider or provider_from_environment()
    rows = conn.execute(
        "SELECT id FROM proxy_purchase_orders WHERE provider_order_id<>'' AND status IN ('provisioning','provider_unknown') "
        "AND next_attempt_at<=? ORDER BY last_synced_at ASC LIMIT ?",
        (int(now or _now()), min(max(int(limit), 1), 100)),
    ).fetchall()
    results: list[dict[str, Any]] = []
    for row in rows:
        try:
            results.append(reconcile_order(conn, order_id=str(row["id"]), provider=provider, now=now))
        except Exception:
            conn.rollback()
            conn.execute(
                "UPDATE proxy_purchase_orders SET next_attempt_at=?,reconcile_attempts=reconcile_attempts+1,updated_at=? WHERE id=?",
                (int(now or _now()) + 300, int(now or _now()), str(row["id"])),
            )
            conn.commit()
            continue
    return results
