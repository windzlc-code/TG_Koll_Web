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
from . import exchange_rates
from . import proxy_provider_credentials
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
    "min_period_months": 1,
    "max_period_months": 1,
    "pricing_mode": "legacy_points_per_usd",
    "fx_rate_mode": "auto",
    "manual_usd_to_ntd_rate": "35.00",
    "profit_ntd": "0.00",
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
    "error_code",
}
_MOCK_PROVIDER_LOCK = threading.Lock()
_MOCK_PROVIDERS: dict[str, MockProxyProvider] = {}
_TERMINAL_FAILURES = {"failed", "canceled", "cancelled", "expired"}
_ACTIVE_STATUSES = {"active", "completed", "ready"}
_RECONCILE_BASE_DELAY_SECONDS = 60
_RECONCILE_MAX_DELAY_SECONDS = 3600

# Proxy-Cheap currently returns city labels in English. Keep the supplier ID
# untouched for ordering, while exposing a stable Chinese display label to the
# user and administrator interfaces.
_CITY_ZH_NAMES = {
    "Albany": "奥尔巴尼",
    "Algiers": "阿尔及尔",
    "Almaty": "阿拉木图",
    "Amsterdam": "阿姆斯特丹",
    "Ashburn": "阿什本",
    "Astana": "阿斯塔纳",
    "Athens": "雅典",
    "Bangkok": "曼谷",
    "Belgrade": "贝尔格莱德",
    "Berlin": "柏林",
    "Bogota": "波哥大",
    "Bratislava": "布拉迪斯拉发",
    "Brussels": "布鲁塞尔",
    "Bucharest": "布加勒斯特",
    "Budapest": "布达佩斯",
    "Buenos Aires": "布宜诺斯艾利斯",
    "Buffalo": "布法罗",
    "Cairo": "开罗",
    "Caracas": "加拉加斯",
    "Chisinau": "基希讷乌",
    "Colombo": "科伦坡",
    "Copenhagen": "哥本哈根",
    "Dhaka": "达卡",
    "Dover": "多佛",
    "Dubai": "迪拜",
    "Dublin": "都柏林",
    "Fair Lawn": "费尔劳恩",
    "Frankfurt am Main": "法兰克福",
    "Guatemala City": "危地马拉城",
    "Hanoi": "河内",
    "Helsinki": "赫尔辛基",
    "Ho Chi Minh City": "胡志明市",
    "Hong Kong": "中国香港",
    "Honolulu": "檀香山",
    "Hoofddorp": "霍夫多普",
    "Istanbul": "伊斯坦布尔",
    "Jakarta": "雅加达",
    "Johannesburg": "约翰内斯堡",
    "Kuala Lumpur": "吉隆坡",
    "Kyiv": "基辅",
    "Kyiv City": "基辅市",
    "Lagos": "拉各斯",
    "Lisbon": "里斯本",
    "London": "伦敦",
    "Los Angeles": "洛杉矶",
    "Madrid": "马德里",
    "Manila": "马尼拉",
    "Melbourne": "墨尔本",
    "Mesa": "梅萨",
    "Mexico City": "墨西哥城",
    "Miami": "迈阿密",
    "Milan": "米兰",
    "Montreal": "蒙特利尔",
    "Morocco": "摩洛哥",
    "Mount Vernon": "芒特弗农",
    "Mumbai": "孟买",
    "Nairobi": "内罗毕",
    "New Delhi": "新德里",
    "New Jersey": "新泽西",
    "New Rochelle": "新罗谢尔",
    "New York": "纽约",
    "New York City": "纽约市",
    "Newark": "纽瓦克",
    "Niagara Falls": "尼亚加拉瀑布城",
    "Nicosia": "尼科西亚",
    "Niteroi": "尼泰罗伊",
    "Nyiregyhaza": "尼赖吉哈佐",
    "Ontario": "安大略",
    "Osaka": "大阪",
    "Oslo": "奥斯陆",
    "Overland Park": "欧弗兰帕克",
    "Paris": "巴黎",
    "Philadelphia": "费城",
    "Phnom Penh": "金边",
    "Prague": "布拉格",
    "Queretaro": "克雷塔罗",
    "Redmond": "雷德蒙德",
    "Rehoboth Beach": "里霍博斯比奇",
    "Riga": "里加",
    "Riyadh": "利雅得",
    "Rochester": "罗切斯特",
    "Rome": "罗马",
    "Santiago": "圣地亚哥",
    "San Francisco": "旧金山",
    "Sao Paulo": "圣保罗",
    "Schenectady": "斯克内克塔迪",
    "Seattle": "西雅图",
    "Seoul": "首尔",
    "Singapore": "新加坡",
    "Sofia": "索菲亚",
    "Springfield": "斯普林菲尔德",
    "Stockholm": "斯德哥尔摩",
    "Sydney": "悉尼",
    "Syracuse": "锡拉丘兹",
    "Taichung": "台中",
    "Taipei": "台北",
    "Tallinn": "塔林",
    "Tbilisi": "第比利斯",
    "Tegucigalpa": "特古西加尔巴",
    "Tel Aviv": "特拉维夫",
    "Tokyo": "东京",
    "Troy": "特洛伊",
    "Utica": "尤蒂卡",
    "Valencia": "瓦伦西亚",
    "Valletta": "瓦莱塔",
    "Vancouver": "温哥华",
    "Vienna": "维也纳",
    "Vilnius": "维尔纽斯",
    "Warsaw": "华沙",
    "Washington": "华盛顿",
    "White Plains": "怀特普莱恩斯",
    "Wilmington": "威尔明顿",
    "Zagreb": "萨格勒布",
    "Zurich": "苏黎世",
}


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


def _points_units(
    provider_amount_usd: Decimal,
    config: Mapping[str, Any],
    *,
    cash_per_point_ntd: Decimal | None = None,
    fx_rate: Decimal | None = None,
) -> int:
    if str(config.get("pricing_mode") or "") == "supplier_plus_profit_ntd":
        if cash_per_point_ntd is None or cash_per_point_ntd <= 0 or fx_rate is None or fx_rate <= 0:
            raise ProxyPurchaseError("INVALID_CONFIG", "NTD pricing requires a cash point rate and USD/TWD rate")
        profit_ntd = _decimal(config.get("profit_ntd", 0), "profit_ntd")
        customer_total_ntd = (provider_amount_usd * fx_rate) + profit_ntd
        return int(
            ((customer_total_ntd / cash_per_point_ntd) * POINT_SCALE).quantize(
                Decimal("1"), rounding=ROUND_CEILING
            )
        )
    per_usd = _decimal(config.get("points_per_usd"), "points_per_usd", minimum="0.01")
    fixed = _decimal(config.get("fixed_fee_points", 0), "fixed_fee_points")
    safety = _decimal(config.get("safety_buffer_usd", 0), "safety_buffer_usd")
    profit = _decimal(config.get("minimum_profit_usd", 0), "minimum_profit_usd")
    return int(
        (((provider_amount_usd + safety + profit) * per_usd + fixed) * POINT_SCALE).quantize(
            Decimal("1"), rounding=ROUND_CEILING
        )
    )


def _required_revenue_ntd(
    provider_amount_usd: Decimal,
    config: Mapping[str, Any],
    *,
    fx_rate: Decimal | None = None,
) -> Decimal:
    if str(config.get("pricing_mode") or "") == "supplier_plus_profit_ntd":
        effective_fx = fx_rate or _decimal(
            config.get("manual_usd_to_ntd_rate") or config.get("usd_to_ntd_rate"),
            "manual_usd_to_ntd_rate",
            minimum="0.000001",
        )
        return (provider_amount_usd * effective_fx) + _decimal(config.get("profit_ntd", 0), "profit_ntd")
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
    *,
    fx_rate: Decimal | None = None,
) -> None:
    revenue_ntd = (Decimal(int(credit_units)) / POINT_SCALE) * cash_per_point_ntd
    required_ntd = _required_revenue_ntd(provider_amount_usd, config, fx_rate=fx_rate)
    if revenue_ntd < required_ntd:
        raise ProxyPurchaseError(
            "UNPROFITABLE_PRICE",
            "Point price does not cover the converted provider cost and configured profit",
            409,
        )


def _effective_usd_twd_rate(
    config: Mapping[str, Any], *, force_refresh: bool = False
) -> tuple[Decimal, dict[str, Any]]:
    try:
        reference = exchange_rates.get_usd_twd_rate(force_refresh=force_refresh)
    except exchange_rates.ExchangeRateError as exc:
        if str(config.get("fx_rate_mode") or "auto") == "manual":
            manual = _decimal(
                config.get("manual_usd_to_ntd_rate"),
                "manual_usd_to_ntd_rate",
                minimum="0.000001",
            )
            return manual, {
                "base": "USD",
                "quote": "TWD",
                "rate": str(manual),
                "reference_rate": "",
                "mode": "manual",
                "source": "manual-fallback",
                "fetched_at": _now(),
                "stale": True,
            }
        raise ProxyPurchaseError("FX_RATE_UNAVAILABLE", str(exc), 503) from exc
    mode = str(config.get("fx_rate_mode") or "auto")
    effective = reference.rate
    if mode == "manual":
        manual = _decimal(
            config.get("manual_usd_to_ntd_rate"),
            "manual_usd_to_ntd_rate",
            minimum="0.000001",
        )
        # Manual adjustment may raise the conversion rate, but never undercut
        # the live reference and silently sell below the supplier cost.
        effective = max(reference.rate, manual)
    public = reference.public()
    public.update({"rate": str(effective), "reference_rate": str(reference.rate), "mode": mode})
    return effective, public


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
    min_months = int(config.get("min_period_months") or months)
    max_months = int(config.get("max_period_months") or months)
    if min_months < 1 or max_months > 36 or min_months > max_months:
        raise ProxyPurchaseError("INVALID_CONFIG", "purchase duration range must be between 1 and 36 months")
    if months < min_months or months > max_months:
        months = min_months
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
    pricing_mode = str(merged.get("pricing_mode") or "legacy_points_per_usd")
    if pricing_mode not in {"legacy_points_per_usd", "supplier_plus_profit_ntd"}:
        raise ProxyPurchaseError("INVALID_CONFIG", "pricing_mode is invalid")
    fx_rate_mode = str(merged.get("fx_rate_mode") or "auto")
    if fx_rate_mode not in {"auto", "manual"}:
        raise ProxyPurchaseError("INVALID_CONFIG", "fx_rate_mode must be auto or manual")
    manual_fx = _decimal(
        merged.get("manual_usd_to_ntd_rate") or merged.get("usd_to_ntd_rate"),
        "manual_usd_to_ntd_rate",
        minimum="0.000001",
    )
    profit_ntd = _decimal(merged.get("profit_ntd", 0), "profit_ntd")
    if merged.get("lowest_cash_per_point") not in (None, ""):
        cash_per_point = _decimal(
            merged.get("lowest_cash_per_point"), "lowest_cash_per_point", minimum="0.000001"
        )
        if pricing_mode == "legacy_points_per_usd":
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
        "min_period_months": min_months,
        "max_period_months": max_months,
        "pricing_mode": pricing_mode,
        "fx_rate_mode": fx_rate_mode,
        "manual_usd_to_ntd_rate": str(manual_fx),
        "profit_ntd": str(profit_ntd),
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


def exchange_rate_status(
    conn: sqlite3.Connection, *, force_refresh: bool = False, include_draft: bool = True
) -> dict[str, Any]:
    config = get_config(conn, include_draft=include_draft)
    rate, status = _effective_usd_twd_rate(config, force_refresh=force_refresh)
    return {
        **status,
        "rate": str(rate),
        "manual_rate": str(config.get("manual_usd_to_ntd_rate") or ""),
        "mode": str(config.get("fx_rate_mode") or "auto"),
    }


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
    supplier_periods = _supported_month_periods(setup)
    if supplier_periods:
        requested_periods = set(
            range(int(config.get("min_period_months") or 1), int(config.get("max_period_months") or 1) + 1)
        )
        if not requested_periods.issubset(set(supplier_periods)):
            raise ProxyPurchaseError(
                "PROVIDER_PERIOD_UNAVAILABLE",
                "Configured purchase duration range is not fully supported by the supplier",
                409,
            )
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


def provider_from_environment(conn: sqlite3.Connection | None = None) -> ProxyProvider:
    if str(os.getenv("PROXY_PURCHASE_PROVIDER", "proxycheap")).strip().lower() == "mock":
        unit_price = str(os.getenv("PROXY_PURCHASE_MOCK_PRICE_USD", "4.00"))
        with _MOCK_PROVIDER_LOCK:
            provider = _MOCK_PROVIDERS.get(unit_price)
            if provider is None:
                provider = MockProxyProvider(unit_price_usd=unit_price)
                _MOCK_PROVIDERS[unit_price] = provider
            return provider
    if conn is not None:
        return proxy_provider_credentials.provider(conn)
    return ProxyCheapProvider()


def _provider_ready(provider: ProxyProvider) -> tuple[bool, bool]:
    configured = bool(getattr(provider, "configured", True))
    purchasing = bool(
        getattr(provider, "purchases_enabled", isinstance(provider, MockProxyProvider))
        and getattr(provider, "safe_reconciliation_enabled", isinstance(provider, MockProxyProvider))
    )
    return configured, purchasing


def _setup_data(setup: Mapping[str, Any]) -> Mapping[str, Any]:
    data = setup.get("data")
    return data if isinstance(data, Mapping) else setup


def _country_isp_items(setup: Mapping[str, Any], country: str) -> list[dict[str, Any]]:
    raw_isps = _setup_data(setup).get("isps")
    if not isinstance(raw_isps, Mapping):
        return []
    items = raw_isps.get(str(country or "").strip().upper(), [])
    return [dict(item) for item in items if isinstance(item, Mapping)] if isinstance(items, list) else []


def _city_items(setup: Mapping[str, Any], country: str) -> list[dict[str, str]]:
    raw_cities = _setup_data(setup).get("cities")
    if not isinstance(raw_cities, Mapping):
        return []
    items = raw_cities.get(str(country or "").strip().upper(), [])
    if not isinstance(items, list):
        return []
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, Mapping):
            continue
        city_id = str(item.get("id") or item.get("value") or item.get("code") or item.get("name") or "").strip()
        if not city_id or city_id in seen:
            continue
        seen.add(city_id)
        name = str(item.get("name") or item.get("label") or city_id)
        result.append(
            {
                "id": city_id,
                "name": name,
                "name_zh": _CITY_ZH_NAMES.get(name, name),
                "region": str(item.get("region") or item.get("state") or ""),
            }
        )
    return result


def _city_raw_item(setup: Mapping[str, Any], country: str, city_id: str) -> Mapping[str, Any] | None:
    raw_cities = _setup_data(setup).get("cities")
    items = raw_cities.get(str(country or "").strip().upper(), []) if isinstance(raw_cities, Mapping) else []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, Mapping):
            continue
        candidate = str(item.get("id") or item.get("value") or item.get("code") or item.get("name") or "").strip()
        if candidate == str(city_id or "").strip():
            return item
    return None


def _supported_month_periods(setup: Mapping[str, Any]) -> list[int]:
    raw = _setup_data(setup).get("periods")
    values: list[Any]
    if isinstance(raw, Mapping):
        values = list(raw.get("months") or [])
    elif isinstance(raw, list):
        values = raw
    else:
        values = []
    result: set[int] = set()
    for item in values:
        if isinstance(item, Mapping):
            unit = str(item.get("unit") or "months").lower()
            value = item.get("value") or item.get("months")
            if unit not in {"month", "months"}:
                continue
        else:
            value = item
        try:
            months = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= months <= 36:
            result.add(months)
    return sorted(result)


def _orderable_regions(setup: Mapping[str, Any], service_id: str) -> list[dict[str, str]]:
    regions = _region_items(setup)
    raw_isps = _setup_data(setup).get("isps")
    if str(service_id or "") == "static-residential-ipv4" and isinstance(raw_isps, Mapping):
        return [item for item in regions if _country_isp_items(setup, item["code"])]
    return regions


def _configuration(
    config: Mapping[str, Any],
    country: str,
    period_months: int,
    *,
    city: str = "",
    setup: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    result = dict(config.get("default_parameters") or {})
    clean_country = str(country or "").strip().upper()
    configured_country = str(result.get("country") or "").strip().upper()
    result.update(
        {
            "planId": str(config.get("plan_id") or ""),
            "country": clean_country,
            "quantity": 1,
            "period": {"unit": "months", "value": int(period_months)},
        }
    )
    service_id = str(config.get("service_id") or "")
    if setup is not None and service_id == "static-residential-ipv4":
        if configured_country != clean_country:
            result.pop("region", None)
            result.pop("city", None)
        isps = _country_isp_items(setup, clean_country)
        clean_city = str(city or "").strip()
        city_item = _city_raw_item(setup, clean_country, clean_city) if clean_city else None
        if clean_city:
            result["city"] = clean_city
            city_region = str(city_item.get("region") or city_item.get("state") or "") if city_item else ""
            if city_region:
                result["region"] = city_region
        if isps:
            available = {
                str(item.get("id") or item.get("value") or item.get("code") or ""): item
                for item in isps
            }
            per_country = result.pop("isp_by_country", {})
            mapped_isp = per_country.get(clean_country) if isinstance(per_country, Mapping) else ""
            configured_isp = str(result.get("isp") or result.get("ispId") or "")
            preferred = str(mapped_isp or (configured_isp if configured_country == clean_country else ""))
            city_isps = city_item.get("isps") if city_item else []
            city_isp_ids = [str(value) for value in city_isps] if isinstance(city_isps, list) else []
            city_preferred = next((value for value in city_isp_ids if value in available), "")
            result["ispId"] = city_preferred or (preferred if preferred in available else next(iter(available)))
            result.pop("isp", None)
        else:
            result.pop("isp", None)
            result.pop("ispId", None)
            result.pop("isp_by_country", None)
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
    provider = provider or provider_from_environment(conn)
    config = get_config(conn)
    configured, purchasing = _provider_ready(provider)
    regions: list[dict[str, str]] = []
    setup: Mapping[str, Any] = {}
    if bool(config.get("enabled")) and configured:
        setup = provider.get_setup(str(config["service_id"]), plan_id=str(config.get("plan_id") or ""))
        regions = _orderable_regions(setup, str(config.get("service_id") or ""))
    wallet = commercial_billing.ensure_wallet(conn, int(user_id))
    cash_units = int(wallet.get("cash_backed_credit_units") or 0)
    defaults = dict(config.get("default_parameters") or {})
    cities = {
        region["code"]: _city_items(setup, region["code"])
        for region in regions
        if _city_items(setup, region["code"])
    }
    fixed_period = int(config["default_period_months"])
    return {
        "provider": "proxycheap",
        "configured": configured and config.get("status") == "active" and bool(config.get("enabled")),
        "live_purchasing_enabled": bool(
            purchasing and config.get("status") == "active" and config.get("enabled")
        ),
        "regions": regions,
        "cities": cities,
        "periods": [{"unit": "months", "value": fixed_period, "label": f"{fixed_period} 个月"}],
        "cash_backed_credit_units": cash_units,
        "cash_backed_points": cash_units / POINT_SCALE,
        "currency": "USD",
        "service_id": str(config.get("service_id") or ""),
        "plan_id": str(config.get("plan_id") or ""),
        "quantity": 1,
        "ip_version": str(defaults.get("ipVersion") or "IPv4"),
        "proxy_protocol": str(defaults.get("proxyProtocol") or defaults.get("protocol") or "HTTP"),
        "authentication_type": str(
            defaults.get("authenticationType") or defaults.get("authentication") or "USERNAME_PASSWORD"
        ),
        "is_unused_proxy": bool(defaults.get("isUnusedProxy", False)),
        "isp_managed": bool(
            str(config.get("service_id") or "") == "static-residential-ipv4"
            and isinstance(_setup_data(setup).get("isps"), Mapping)
        ),
        "default_period": {"unit": "months", "value": int(config["default_period_months"])},
    }


def create_quote(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    country: str,
    auto_renew: bool,
    city: str = "",
    period_months: int | None = None,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    current = int(now or _now())
    provider = provider or provider_from_environment(conn)
    config = get_config(conn)
    if config.get("status") != "active" or not bool(config.get("enabled")):
        raise ProxyPurchaseError("PURCHASES_DISABLED", "Proxy purchases are not configured", 503)
    clean_country = str(country or "").strip().upper()
    fixed_months = int(config["default_period_months"])
    months = int(period_months or fixed_months)
    setup = provider.get_setup(str(config["service_id"]), plan_id=str(config.get("plan_id") or ""))
    countries = {
        item["code"]: item["name"]
        for item in _orderable_regions(setup, str(config.get("service_id") or ""))
    }
    if clean_country not in countries:
        raise ProxyPurchaseError("INVALID_COUNTRY", "The selected region is not currently orderable", 422)
    supported_periods = _supported_month_periods(setup)
    if months != fixed_months or (supported_periods and fixed_months not in supported_periods):
        raise ProxyPurchaseError("INVALID_PERIOD", "The purchase duration is fixed by the administrator", 422)
    clean_city = str(city or "").strip()
    city_options = {item["id"]: item for item in _city_items(setup, clean_country)}
    if clean_city and clean_city not in city_options:
        raise ProxyPurchaseError("INVALID_CITY", "The selected city is not currently orderable", 422)
    request = _configuration(config, clean_country, months, city=clean_city, setup=setup)
    quoted = provider.quote(str(config["service_id"]), request)
    if quoted.currency != "USD":
        raise ProxyPurchaseError("UNSUPPORTED_CURRENCY", "Only USD provider quotes are supported", 409)
    max_cost = _decimal(config["max_vendor_cost_usd"], "max_vendor_cost_usd")
    if quoted.amount > max_cost:
        raise ProxyPurchaseError("COST_LIMIT_EXCEEDED", "Provider cost exceeds the configured ceiling", 409)
    cash_per_point = _lowest_cash_per_point(conn)
    fx_rate: Decimal | None = None
    fx_public: dict[str, Any] = {}
    if str(config.get("pricing_mode") or "") == "supplier_plus_profit_ntd":
        fx_rate, fx_public = _effective_usd_twd_rate(config)
    charge_units = _points_units(
        quoted.amount,
        config,
        cash_per_point_ntd=cash_per_point,
        fx_rate=fx_rate,
    )
    _assert_profitable(quoted.amount, charge_units, config, cash_per_point, fx_rate=fx_rate)
    request_record = {
        **request,
        "autoRenew": bool(auto_renew),
        "countryName": countries[clean_country],
        "cityName": city_options.get(clean_city, {}).get("name", clean_city),
        "_pricing": {
            "mode": str(config.get("pricing_mode") or "legacy_points_per_usd"),
            "fxRate": str(fx_rate or ""),
            "profitNtd": str(config.get("profit_ntd") or "0"),
            "supplierCostNtd": str((quoted.amount * fx_rate) if fx_rate else ""),
            "customerTotalNtd": str(_required_revenue_ntd(quoted.amount, config, fx_rate=fx_rate)),
            "cashPerPointNtd": str(cash_per_point),
            "fxSource": str(fx_public.get("source") or ""),
            "fxFetchedAt": int(fx_public.get("fetched_at") or 0),
        },
    }
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
        "city": clean_city,
        "city_name": city_options.get(clean_city, {}).get("name", clean_city),
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


def _reconcile_delay_seconds(attempts: int) -> int:
    exponent = min(max(int(attempts), 0), 10)
    return min(_RECONCILE_BASE_DELAY_SECONDS * (2**exponent), _RECONCILE_MAX_DELAY_SECONDS)


def _public_order(
    row: Mapping[str, Any], *, conn: sqlite3.Connection | None = None
) -> dict[str, Any]:
    result = {key: row[key] for key in _ORDER_PUBLIC_FIELDS if key in row.keys()}
    result["market_item_id"] = ""
    result["social_proxy_id"] = ""
    if conn is not None:
        asset = conn.execute(
            "SELECT item.id AS market_item_id,proxy.id AS social_proxy_id "
            "FROM proxy_market_items item JOIN social_proxies proxy ON proxy.market_item_id=item.id "
            "WHERE item.provider_purchase_order_id=? AND item.ownership_type='owned' "
            "AND item.owner_user_id=? AND proxy.user_id=? ORDER BY proxy.created_at LIMIT 1",
            (str(row["id"]), int(row["user_id"]), int(row["user_id"])),
        ).fetchone()
        if asset is not None:
            result["market_item_id"] = str(asset["market_item_id"] or "")
            result["social_proxy_id"] = str(asset["social_proxy_id"] or "")
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
        return _public_order(existing, conn=conn)
    quote_row = conn.execute(
        "SELECT * FROM proxy_purchase_quotes WHERE id=? AND user_id=?", (str(quote_id), int(user_id))
    ).fetchone()
    if quote_row is None:
        raise ProxyPurchaseError("QUOTE_NOT_FOUND", "Quote was not found", 404)
    if str(quote_row["status"]) != "open" or int(quote_row["expires_at"]) <= current:
        raise ProxyPurchaseError("QUOTE_EXPIRED", "Quote has expired; request a new quote", 409)
    provider = provider or provider_from_environment(conn)
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
    request = {
        key: value
        for key, value in request_record.items()
        if key not in {"autoRenew", "countryName", "cityName", "_pricing"}
    }
    fresh = provider.quote(str(quote_row["service_id"]), request)
    fresh_minor = _minor_units(fresh.amount)
    if fresh.currency != "USD" or fresh_minor > int(quote_row["provider_price_minor"]):
        conn.execute("UPDATE proxy_purchase_quotes SET status='repriced',updated_at=? WHERE id=?", (current, quote_id))
        raise ProxyPurchaseError("PRICE_CHANGED", "Provider price increased; confirm a new quote", 409)
    if fresh.amount > _decimal(config["max_vendor_cost_usd"], "max_vendor_cost_usd"):
        raise ProxyPurchaseError("COST_LIMIT_EXCEEDED", "Provider cost exceeds the configured ceiling", 409)
    pricing = request_record.get("_pricing") if isinstance(request_record.get("_pricing"), Mapping) else {}
    recorded_fx = None
    if pricing.get("fxRate") not in (None, ""):
        recorded_fx = _decimal(pricing.get("fxRate"), "quote fxRate", minimum="0.000001")
    _assert_profitable(
        fresh.amount,
        int(quote_row["credit_units"]),
        config,
        _lowest_cash_per_point(conn),
        fx_rate=recorded_fx,
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
        return _public_order(concurrent, conn=conn)
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
        return _public_order(
            conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
            conn=conn,
        )
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
        return _public_order(
            conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
            conn=conn,
        )

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
            reconcile_order(conn, order_id=order_id, provider=provider, now=current)
        except Exception as exc:
            # Execute already succeeded. Preserve the committed order for compensation;
            # never release points or let a delivery write failure cause a second purchase.
            conn.rollback()
            conn.execute(
                "UPDATE proxy_purchase_orders SET error_code='DELIVERY_PENDING',error_detail=?,updated_at=? WHERE id=?",
                (type(exc).__name__, current, order_id),
            )
            conn.commit()
    return _public_order(
        conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
        conn=conn,
    )


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
    for container_key in (
        "connection", "credentials", "authentication", "location", "metadata", "proxy", "data"
    ):
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
    request_record = _loads(order.get("request_json"), {})
    country = str(
        _proxy_field(proxy, "country", "countryCode") or request_record.get("country") or ""
    ).upper()
    isp_name = str(_proxy_field(proxy, "isp", "ispName"))
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
            isp_name,
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
            isp_name,
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
        return _public_order(row, conn=conn)
    provider = provider or provider_from_environment(conn)
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
            attempts = int(order.get("reconcile_attempts") or 0) + 1
            conn.execute(
                "UPDATE proxy_purchase_orders SET status='provider_unknown',"
                "error_code='PROVIDER_REFUND_UNCONFIRMED',"
                "error_detail='Provider reached a terminal state before delivery; supplier refund must be confirmed',"
                "provider_response_json=?,last_synced_at=?,next_attempt_at=?,"
                "reconcile_attempts=?,updated_at=? WHERE id=?",
                (
                    _safe_provider_summary(details),
                    current,
                    current + _RECONCILE_MAX_DELAY_SECONDS,
                    attempts,
                    current,
                    str(order_id),
                ),
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
        attempts = int(order.get("reconcile_attempts") or 0) + 1
        next_attempt_at = current + _reconcile_delay_seconds(int(order.get("reconcile_attempts") or 0))
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='provisioning',provider_response_json=?,"
            "last_synced_at=?,next_attempt_at=?,reconcile_attempts=?,updated_at=? WHERE id=?",
            (_safe_provider_summary(details), current, next_attempt_at, attempts, current, order_id),
        )
        conn.commit()
    return _public_order(
        conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
        conn=conn,
    )


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
        in_use = conn.execute(
            "SELECT id FROM proxy_purchase_orders WHERE provider_key=? AND provider_order_id=? AND id<>? LIMIT 1",
            (str(row["provider_key"] or "proxycheap"), clean_provider_id, str(order_id)),
        ).fetchone()
        if in_use is not None:
            conn.rollback()
            raise ProxyPurchaseError(
                "PROVIDER_ORDER_IN_USE",
                "Provider order id is already bound to another purchase",
                409,
            )
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
            return _public_order(row, conn=conn)
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
        return _public_order(
            conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
            conn=conn,
        )
    if clean_resolution == "confirm_provider_refunded":
        if (
            str(row["status"]) == "failed"
            and str(row["error_code"]) == "MANUAL_CONFIRMED_PROVIDER_REFUNDED"
        ):
            conn.commit()
            return _public_order(row, conn=conn)
        if (
            str(row["error_code"]) != "PROVIDER_REFUND_UNCONFIRMED"
            or not str(row["provider_order_id"] or "").strip()
        ):
            conn.rollback()
            raise ProxyPurchaseError(
                "PROVIDER_REFUND_CONFIRMATION_NOT_ALLOWED",
                "Only a provider-bound order awaiting supplier refund confirmation can be refunded",
                409,
            )
        _refund_or_release_failed_order(
            conn,
            reservation_id=str(row["reservation_id"]),
            reason=f"manual_provider_refund_confirmed:{int(actor_user_id)}",
            now=current,
        )
        conn.execute(
            "UPDATE proxy_purchase_orders SET status='failed',"
            "error_code='MANUAL_CONFIRMED_PROVIDER_REFUNDED',error_detail='',"
            "next_attempt_at=0,updated_at=? WHERE id=?",
            (current, str(order_id)),
        )
        conn.commit()
        return _public_order(
            conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
            conn=conn,
        )
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
        "confirm_provider_refunded": "confirm_provider_refunded",
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
    return _public_order(
        conn.execute("SELECT * FROM proxy_purchase_orders WHERE id=?", (order_id,)).fetchone(),
        conn=conn,
    )


def get_order(conn: sqlite3.Connection, *, user_id: int, order_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM proxy_purchase_orders WHERE id=? AND user_id=?", (str(order_id), int(user_id))
    ).fetchone()
    if row is None:
        raise ProxyPurchaseError("ORDER_NOT_FOUND", "Purchase order was not found", 404)
    return _public_order(row, conn=conn)


def process_due_renewals(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> list[dict[str, Any]]:
    current = int(now or _now())
    provider = provider or provider_from_environment(conn)
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
                "SELECT schedule.*,orders.config_version_id,orders.request_json AS order_request_json "
                "FROM proxy_renewal_schedules schedule "
                "JOIN proxy_purchase_orders orders ON orders.id=schedule.order_id WHERE schedule.id=? AND schedule.lease_token=?",
                (str(candidate["id"]), lease),
            ).fetchone()
            if schedule_row is None:
                continue
            schedule = dict(schedule_row)
            order_request = _loads(schedule.get("order_request_json"), {})
            renewal_period = order_request.get("period") if isinstance(order_request.get("period"), Mapping) else {}
            renewal_months = max(1, min(int(renewal_period.get("value") or 1), 36))
            if not bool(getattr(provider, "safe_reconciliation_enabled", isinstance(provider, MockProxyProvider))):
                conn.execute(
                    "UPDATE proxy_renewal_schedules SET status='config_blocked',lease_token='',lease_expires_at=0,"
                    "last_error='safe reconciliation is not enabled',updated_at=? WHERE id=? AND lease_token=?",
                    (current, str(schedule["id"]), lease),
                )
                conn.commit()
                continue
            quote = provider.extension_quote(
                str(schedule["provider_proxy_id"]), period_months=renewal_months
            )
            cfg_row = conn.execute("SELECT config_json FROM proxy_purchase_config_versions WHERE id=?", (str(schedule["config_version_id"]),)).fetchone()
            if quote.currency != "USD" or cfg_row is None:
                raise ProxyPurchaseError("RENEWAL_CONFIG_INVALID", "Renewal pricing configuration is invalid", 409)
            config = validate_config(_loads(cfg_row["config_json"], {}))
            cash_per_point = _lowest_cash_per_point(conn)
            renewal_fx = None
            if str(config.get("pricing_mode") or "") == "supplier_plus_profit_ntd":
                renewal_fx, _ = _effective_usd_twd_rate(config)
            units = _points_units(
                quote.amount,
                config,
                cash_per_point_ntd=cash_per_point,
                fx_rate=renewal_fx,
            )
            _assert_profitable(quote.amount, units, config, cash_per_point, fx_rate=renewal_fx)
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
            response = provider.extend_period(
                str(schedule["provider_proxy_id"]), period_months=renewal_months
            )
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
    provider = provider or provider_from_environment(conn)
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
    candidate_secrets = [str(secret)] if secret is not None else proxy_provider_credentials.webhook_secrets(conn)
    if not candidate_secrets:
        candidate_secrets = [str(os.getenv("PROXYCHEAP_WEBHOOK_SECRET", ""))]
    if not any(
        verify_webhook_signature(
            raw_body,
            event_name=event_name,
            event_id=event_id,
            signature=signature,
            secret=candidate,
        )
        for candidate in candidate_secrets
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
            result: dict[str, Any] = {}
            for key, item in value.items():
                normalized = "".join(char for char in str(key).lower() if char.isalnum())
                sensitive = any(
                    marker in normalized
                    for marker in ("password", "secret", "token", "apikey", "username", "credential")
                )
                result[str(key)] = "[REDACTED]" if sensitive else redact(item)
            return result
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
    provider = provider or provider_from_environment(conn)
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
            provider_order_id = str(event["order_id"] or "") if event else ""
            order_id = ""
            if provider_order_id:
                order = conn.execute(
                    "SELECT id FROM proxy_purchase_orders WHERE id=? OR provider_order_id=? "
                    "ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
                    (provider_order_id, provider_order_id, provider_order_id),
                ).fetchone()
                order_id = str(order["id"]) if order else ""
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
    provider = provider or provider_from_environment(conn)
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
                    "city": str(request.get("city") or ""),
                    "city_name": str(request.get("cityName") or request.get("city") or ""),
                    "vendor_price": str(Decimal(int(row["provider_cost_minor"] or 0)) / 100),
                    "currency": str(row["provider_currency"] or "USD"),
                }
            )
        result.append(item)
    return result


def list_owned_assets(
    conn: sqlite3.Connection,
    *,
    query: str = "",
    status: str = "",
    limit: int = 200,
) -> list[dict[str, Any]]:
    conditions = [
        "item.ownership_type = 'owned'",
        "item.provider_purchase_order_id <> ''",
    ]
    params: list[Any] = []
    clean_query = str(query or "").strip()
    if clean_query:
        pattern = f"%{clean_query}%"
        conditions.append(
            "(user.username LIKE ? OR user.full_name LIKE ? OR item.host LIKE ? "
            "OR item.country LIKE ? OR item.region LIKE ? OR item.city LIKE ? "
            "OR orders.id LIKE ? OR item.provider_proxy_id LIKE ?)"
        )
        params.extend([pattern] * 8)
    clean_status = str(status or "").strip().lower()
    if clean_status:
        conditions.append("COALESCE(proxy.status, item.status) = ?")
        params.append(clean_status)
    params.append(min(max(int(limit), 1), 500))
    rows = conn.execute(
        f"""
        SELECT item.id AS market_item_id,
               proxy.id AS social_proxy_id,
               orders.id AS order_id,
               item.owner_user_id AS user_id,
               user.username,
               user.full_name,
               item.display_name,
               item.provider_key,
               item.provider_proxy_id,
               item.proxy_type,
               item.host,
               item.port,
               item.country,
               item.region,
               item.city,
               item.isp,
               item.ownership_type,
               COALESCE(proxy.source, 'provider_purchase') AS source,
               COALESCE(proxy.status, item.status) AS proxy_status,
               item.health_status,
               COALESCE(orders.status, '') AS order_status,
               COALESCE(renewal.enabled, orders.renewal_enabled, 0) AS renewal_enabled,
               COALESCE(renewal.status, '') AS renewal_status,
               (
                 SELECT COUNT(*) FROM social_accounts account
                 WHERE account.user_id = item.owner_user_id AND account.proxy_id = proxy.id
               ) AS bound_account_count,
               item.expires_at,
               item.created_at,
               item.updated_at
        FROM proxy_market_items item
        LEFT JOIN proxy_purchase_orders orders
          ON orders.id = item.provider_purchase_order_id
        LEFT JOIN users user
          ON user.id = item.owner_user_id
        LEFT JOIN social_proxies proxy
          ON proxy.market_item_id = item.id AND proxy.user_id = item.owner_user_id
        LEFT JOIN proxy_renewal_schedules renewal
          ON renewal.order_id = orders.id
        WHERE {' AND '.join(conditions)}
        ORDER BY item.updated_at DESC, item.created_at DESC
        LIMIT ?
        """,
        tuple(params),
    ).fetchall()
    return [
        {
            "market_item_id": str(row["market_item_id"] or ""),
            "social_proxy_id": str(row["social_proxy_id"] or ""),
            "order_id": str(row["order_id"] or ""),
            "user_id": int(row["user_id"] or 0),
            "username": str(row["username"] or ""),
            "full_name": str(row["full_name"] or ""),
            "display_name": str(row["display_name"] or ""),
            "provider_key": str(row["provider_key"] or ""),
            "provider_proxy_id": str(row["provider_proxy_id"] or ""),
            "proxy_type": str(row["proxy_type"] or ""),
            "host": str(row["host"] or ""),
            "port": int(row["port"] or 0),
            "country": str(row["country"] or ""),
            "region": str(row["region"] or ""),
            "city": str(row["city"] or ""),
            "isp": str(row["isp"] or ""),
            "ownership_type": str(row["ownership_type"] or ""),
            "source": str(row["source"] or ""),
            "proxy_status": str(row["proxy_status"] or ""),
            "health_status": str(row["health_status"] or ""),
            "order_status": str(row["order_status"] or ""),
            "renewal_enabled": bool(row["renewal_enabled"]),
            "renewal_status": str(row["renewal_status"] or ""),
            "bound_account_count": int(row["bound_account_count"] or 0),
            "expires_at": int(row["expires_at"] or 0),
            "created_at": int(row["created_at"] or 0),
            "updated_at": int(row["updated_at"] or 0),
        }
        for row in rows
    ]


def provider_options(
    conn: sqlite3.Connection, *, provider: ProxyProvider | None = None,
    service_id: str = "", plan_id: str = ""
) -> dict[str, Any]:
    provider = provider or provider_from_environment(conn)
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
        selected_plan = proxy_provider_credentials.resolve_plan_id(
            result["services"], selected_service, str(plan_id or config.get("plan_id") or "")
        )
        setup = provider.get_setup(selected_service, plan_id=selected_plan)
        result["selected_plan_id"] = selected_plan
        result["setup"] = (
            dict(setup["data"]) if isinstance(setup.get("data"), Mapping) else setup
        )
        balance_payload = provider.get_balance()
        balance = _balance_usd(balance_payload)
        result["balance"] = str(balance) if balance is not None else None
        result["last_sync_at"] = current
    return result


def sync_provider_options(
    conn: sqlite3.Connection,
    *,
    service_id: str = "",
    plan_id: str = "",
) -> dict[str, Any]:
    provider = proxy_provider_credentials.provider(conn, require_verified=True)
    result = provider_options(
        conn,
        provider=provider,
        service_id=str(service_id or ""),
        plan_id=str(plan_id or ""),
    )
    selected_service = str(service_id or get_config(conn)["service_id"])
    selected_plan = str(result.get("selected_plan_id") or plan_id or get_config(conn).get("plan_id") or "")
    revision = proxy_provider_credentials.store_option_snapshot(
        conn,
        service_id=selected_service,
        plan_id=selected_plan,
        payload=result,
        synced_at=int(result.get("last_sync_at") or _now()),
    )
    result["revision"] = revision
    return result


def reconcile_due_orders(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
    provider: ProxyProvider | None = None,
    now: int | None = None,
) -> list[dict[str, Any]]:
    provider = provider or provider_from_environment(conn)
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
