from __future__ import annotations

import json
import os
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping
from urllib.parse import quote

import requests

from .base import (
    JsonObject,
    ProviderQuote,
    ProxyProviderAuthenticationError,
    ProxyProviderConfigurationError,
    ProxyProviderOutcomeUnknown,
    ProxyProviderRejectedError,
    ProxyProviderResponseError,
    ProxyProviderUnavailableError,
)


API_BASE_URL = "https://api.proxy-cheap.com"
DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        return default
    return min(max(value, minimum), maximum)


def _safe_identifier(value: str, field: str) -> str:
    clean = str(value or "").strip()
    if not _SAFE_ID.fullmatch(clean):
        raise ProxyProviderRejectedError(f"Invalid {field}", status_code=400)
    return quote(clean, safe="")


def _decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() and result >= 0 else None


def _find_price(payload: Mapping[str, Any], *, trusted_currency: str = "") -> tuple[Decimal, str]:
    currency = str(payload.get("currency") or payload.get("currencyCode") or trusted_currency).upper()
    candidates: list[Any] = [
        payload.get("finalPriceInCurrency"),
        payload.get("finalPrice"),
        payload.get("total"),
        payload.get("totalPrice"),
        payload.get("price"),
        payload.get("amount"),
    ]
    data = payload.get("data")
    if isinstance(data, Mapping):
        currency = str(data.get("currency") or data.get("currencyCode") or currency).upper()
        candidates.extend(
            (
                data.get("finalPriceInCurrency"),
                data.get("finalPrice"),
                data.get("total"),
                data.get("totalPrice"),
                data.get("price"),
                data.get("amount"),
            )
        )
    for candidate in candidates:
        if isinstance(candidate, Mapping):
            currency = str(candidate.get("currency") or currency).upper()
            candidate = candidate.get("amount", candidate.get("value"))
        amount = _decimal(candidate)
        if amount is not None:
            if not currency:
                raise ProxyProviderResponseError("Provider price response did not declare its currency")
            return amount, currency
    raise ProxyProviderResponseError("Provider price response did not contain a valid total")


class ProxyCheapProvider:
    """Server-only adapter for the fixed Proxy-Cheap REST API origin."""

    key = "proxycheap"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        api_secret: str | None = None,
        account_currency: str | None = None,
        session: requests.Session | None = None,
        purchases_enabled: bool | None = None,
        timeout: tuple[float, float] | None = None,
        max_response_bytes: int | None = None,
    ) -> None:
        self._api_key = str(api_key if api_key is not None else os.getenv("PROXYCHEAP_API_KEY", "")).strip()
        self._api_secret = str(api_secret if api_secret is not None else os.getenv("PROXYCHEAP_API_SECRET", "")).strip()
        self._configured_account_currency = str(account_currency or "").strip().upper()
        self._session = session or requests.Session()
        self._purchases_enabled = (
            _truthy(os.getenv("PROXYCHEAP_PURCHASES_ENABLED"))
            if purchases_enabled is None
            else bool(purchases_enabled)
        )
        self._timeout = timeout or (
            float(_bounded_int("PROXYCHEAP_CONNECT_TIMEOUT_SECONDS", 5, 1, 15)),
            float(_bounded_int("PROXYCHEAP_READ_TIMEOUT_SECONDS", 20, 2, 60)),
        )
        self._max_response_bytes = max_response_bytes or _bounded_int(
            "PROXYCHEAP_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES, 16_384, 4_194_304
        )

    @property
    def configured(self) -> bool:
        return bool(self._api_key and self._api_secret)

    @property
    def purchases_enabled(self) -> bool:
        return self._purchases_enabled

    @property
    def safe_reconciliation_enabled(self) -> bool:
        return _truthy(os.getenv("PROXYCHEAP_EXECUTE_SAFE_RECONCILIATION"))

    def _account_currency(self) -> str:
        currency = self._configured_account_currency or str(
            os.getenv("PROXYCHEAP_ACCOUNT_CURRENCY", "")
        ).strip().upper()
        if currency != "USD":
            raise ProxyProviderConfigurationError(
                "PROXYCHEAP_ACCOUNT_CURRENCY must be explicitly configured as USD"
            )
        return currency

    def _headers(self) -> dict[str, str]:
        if not self.configured:
            raise ProxyProviderConfigurationError(
                "Proxy-Cheap requires both PROXYCHEAP_API_KEY and PROXYCHEAP_API_SECRET"
            )
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Api-Key": self._api_key,
            "X-Api-Secret": self._api_secret,
            "User-Agent": "Vecto-Proxy-Purchases/1.0",
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        mutation: bool = False,
    ) -> JsonObject:
        clean_method = str(method).upper()
        if clean_method not in {"GET", "POST"}:
            raise ValueError("Unsupported provider HTTP method")
        if not path.startswith("/") or path.startswith("//") or ".." in path or "://" in path:
            raise ValueError("Provider path must be relative to the pinned API origin")
        try:
            response = self._session.request(
                clean_method,
                f"{API_BASE_URL}{path}",
                headers=self._headers(),
                json=dict(body) if body is not None else None,
                timeout=self._timeout,
                allow_redirects=False,
                stream=True,
            )
        except requests.RequestException as exc:
            if mutation:
                raise ProxyProviderOutcomeUnknown(
                    "Provider operation outcome is unknown; reconcile before any retry"
                ) from exc
            raise ProxyProviderUnavailableError("Provider is temporarily unavailable") from exc

        status = int(response.status_code)
        if status in {401, 403}:
            response.close()
            raise ProxyProviderAuthenticationError("Provider authentication failed", status_code=502)
        if 300 <= status < 400:
            response.close()
            if mutation:
                raise ProxyProviderOutcomeUnknown(
                    "Provider mutation returned a redirect; outcome is unknown"
                )
            raise ProxyProviderResponseError("Provider returned an unexpected redirect")

        try:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > self._max_response_bytes:
                        raise ProxyProviderResponseError("Provider response exceeded the configured limit")
                except ValueError:
                    pass
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_content(chunk_size=16_384):
                if not chunk:
                    continue
                size += len(chunk)
                if size > self._max_response_bytes:
                    raise ProxyProviderResponseError("Provider response exceeded the configured limit")
                chunks.append(chunk)
            raw = b"".join(chunks)
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ProxyProviderResponseError("Provider returned invalid JSON") from exc
            if not isinstance(payload, dict):
                payload = {"data": payload}
        except (requests.RequestException, ProxyProviderResponseError) as exc:
            if mutation:
                raise ProxyProviderOutcomeUnknown(
                    "Provider operation outcome is unknown; reconcile before any retry"
                ) from exc
            if isinstance(exc, ProxyProviderResponseError):
                raise
            raise ProxyProviderUnavailableError("Provider response could not be read") from exc
        finally:
            response.close()

        if status >= 400:
            if status >= 500 or status in {408, 429}:
                if mutation:
                    raise ProxyProviderOutcomeUnknown(
                        "Provider operation outcome is unknown; reconcile before any retry"
                    )
                raise ProxyProviderUnavailableError("Provider is temporarily unavailable")
            provider_code = str(payload.get("code") or payload.get("errorCode") or "").strip()
            suffix = f" ({provider_code})" if provider_code else ""
            raise ProxyProviderRejectedError(f"Provider rejected the request{suffix}", status_code=422)
        return payload

    @staticmethod
    def _order_body(configuration: Mapping[str, Any], *, execute: bool) -> JsonObject:
        allowed = {
            "planId",
            "country",
            "region",
            "city",
            "ispId",
            "package",
            "protocol",
            "proxyProtocol",
            "authenticationType",
            "traffic",
            "couponCode",
            "period",
        }
        body = {
            key: value
            for key, value in configuration.items()
            if key in allowed and value is not None and value != ""
        }
        body["planId"] = str(configuration.get("planId") or "")
        body["quantity"] = 1
        period = body.get("period")
        if not isinstance(period, Mapping):
            body["period"] = {"unit": "months", "value": 1}
        else:
            months = int(period.get("value") or 1)
            if str(period.get("unit") or "months") != "months" or months < 1 or months > 36:
                raise ProxyProviderRejectedError("Invalid order period", status_code=400)
            body["period"] = {"unit": "months", "value": months}
        if execute:
            # Renewals are platform-managed so the vendor must never debit asynchronously.
            body["autoExtend"] = {"isEnabled": False}
        return body

    def list_services(self) -> JsonObject:
        return self._request("GET", "/v2/order")

    def get_setup(self, service_id: str, *, plan_id: str = "") -> JsonObject:
        service = _safe_identifier(service_id, "service id")
        return self._request("POST", f"/v2/order/{service}", body={"planId": str(plan_id or "")})

    def quote(self, service_id: str, configuration: Mapping[str, Any]) -> ProviderQuote:
        service = _safe_identifier(service_id, "service id")
        raw = self._request("POST", f"/v2/order/{service}/price", body=self._order_body(configuration, execute=False))
        amount, currency = _find_price(raw)
        return ProviderQuote(amount=amount, currency=currency, raw=raw)

    def execute(self, service_id: str, configuration: Mapping[str, Any]) -> JsonObject:
        if not self._purchases_enabled or not self.safe_reconciliation_enabled:
            raise ProxyProviderConfigurationError(
                "Real Proxy-Cheap purchases require both purchase enablement and confirmed safe reconciliation"
            )
        service = _safe_identifier(service_id, "service id")
        return self._request(
            "POST",
            f"/v2/order/{service}/execute",
            body=self._order_body(configuration, execute=True),
            mutation=True,
        )

    def get_order(self, order_id: str) -> JsonObject:
        return self._request("GET", f"/orders/{_safe_identifier(order_id, 'order id')}")

    def get_order_proxies(self, order_id: str) -> JsonObject:
        return self._request("GET", f"/orders/{_safe_identifier(order_id, 'order id')}/proxies")

    def get_proxy(self, proxy_id: str) -> JsonObject:
        return self._request("GET", f"/proxies/{_safe_identifier(proxy_id, 'proxy id')}")

    def get_balance(self) -> JsonObject:
        payload = self._request("GET", "/account/balance")
        payload.setdefault("currency", self._account_currency())
        return payload

    def extension_quote(self, proxy_id: str, *, period_months: int) -> ProviderQuote:
        months = int(period_months)
        if months < 1 or months > 36:
            raise ProxyProviderRejectedError("Invalid extension period", status_code=400)
        raw = self._request(
            "POST",
            f"/proxies/{_safe_identifier(proxy_id, 'proxy id')}/period-extension-price",
            body={"periodInMonths": months},
        )
        amount, currency = _find_price(raw, trusted_currency=self._account_currency())
        return ProviderQuote(amount=amount, currency=currency, raw=raw)

    def extend_period(self, proxy_id: str, *, period_months: int) -> JsonObject:
        if not self._purchases_enabled or not self.safe_reconciliation_enabled:
            raise ProxyProviderConfigurationError(
                "Real Proxy-Cheap renewals require both purchase enablement and confirmed safe reconciliation"
            )
        months = int(period_months)
        if months < 1 or months > 36:
            raise ProxyProviderRejectedError("Invalid extension period", status_code=400)
        return self._request(
            "POST",
            f"/proxies/{_safe_identifier(proxy_id, 'proxy id')}/extend-period",
            body={"periodInMonths": months, "couponCode": ""},
            mutation=True,
        )
