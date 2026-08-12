from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping

from .base import JsonObject, ProviderQuote, ProxyProviderRejectedError


class MockProxyProvider:
    """Deterministic no-network provider for development and integration tests."""

    key = "mock"
    configured = True
    purchases_enabled = True
    safe_reconciliation_enabled = True

    def __init__(self, *, unit_price_usd: str = "4.00") -> None:
        self.unit_price_usd = Decimal(unit_price_usd)
        self.orders: dict[str, JsonObject] = {}
        self.execute_calls = 0
        self.extend_calls = 0

    def list_services(self) -> JsonObject:
        return {
            "data": [
                {
                    "id": "static-residential-ipv4",
                    "name": "Static Residential IPv4",
                    "plans": [{"id": "standard", "name": "Standard"}],
                }
            ]
        }

    def get_setup(self, service_id: str, *, plan_id: str = "") -> JsonObject:
        if service_id != "static-residential-ipv4":
            raise ProxyProviderRejectedError("Unknown mock service", status_code=404)
        return {
            "countries": [
                {"code": "US", "name": "United States"},
                {"code": "GB", "name": "United Kingdom"},
            ],
            "isps": [],
            "periods": [{"unit": "months", "value": 1}],
            "planId": plan_id,
        }

    def quote(self, service_id: str, configuration: Mapping[str, Any]) -> ProviderQuote:
        if service_id != "static-residential-ipv4":
            raise ProxyProviderRejectedError("Unknown mock service", status_code=404)
        months = int((configuration.get("period") or {}).get("value") or 1)
        amount = self.unit_price_usd * months
        return ProviderQuote(amount=amount, currency="USD", raw={"total": str(amount), "currency": "USD"})

    def execute(self, service_id: str, configuration: Mapping[str, Any]) -> JsonObject:
        self.execute_calls += 1
        order_id = f"mock-order-{self.execute_calls}"
        order = {
            "id": order_id,
            "status": "ACTIVE",
            "serviceId": service_id,
            "configuration": dict(configuration),
        }
        self.orders[order_id] = order
        return dict(order)

    def get_order(self, order_id: str) -> JsonObject:
        if order_id not in self.orders:
            raise ProxyProviderRejectedError("Mock order not found", status_code=404)
        return dict(self.orders[order_id])

    def get_order_proxies(self, order_id: str) -> JsonObject:
        self.get_order(order_id)
        return {
            "data": [
                {
                    "id": f"proxy-{order_id}",
                    "status": "ACTIVE",
                    "connection": {
                        "connectIp": "192.0.2.10",
                        "publicIp": "198.51.100.10",
                        "httpPort": 8000,
                        "httpsPort": 8443,
                        "socks5Port": 1080,
                    },
                    "authentication": {"username": "mock-user", "password": "mock-password"},
                    "proxyType": "RESIDENTIAL_STATIC",
                    "countryCode": "US",
                    "expiresAt": "2099-01-01T00:00:00Z",
                }
            ]
        }

    def get_proxy(self, proxy_id: str) -> JsonObject:
        for order_id in self.orders:
            if proxy_id == f"proxy-{order_id}":
                return self.get_order_proxies(order_id)["data"][0]
        raise ProxyProviderRejectedError("Mock proxy not found", status_code=404)

    def get_balance(self) -> JsonObject:
        return {"balance": "1000.00", "currency": "USD"}

    def extension_quote(self, proxy_id: str, *, period_months: int) -> ProviderQuote:
        amount = self.unit_price_usd * int(period_months)
        return ProviderQuote(amount=amount, currency="USD", raw={"total": str(amount), "currency": "USD"})

    def extend_period(self, proxy_id: str, *, period_months: int) -> JsonObject:
        self.extend_calls += 1
        return {"id": proxy_id, "status": "ACTIVE", "periodInMonths": int(period_months)}
