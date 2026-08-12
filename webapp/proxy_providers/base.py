from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Protocol, runtime_checkable


JsonObject = dict[str, Any]


class ProxyProviderError(RuntimeError):
    """Base error whose message is safe to expose or record."""

    code = "PROVIDER_ERROR"
    definitive = True

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = int(status_code)


class ProxyProviderConfigurationError(ProxyProviderError):
    code = "PROVIDER_NOT_CONFIGURED"


class ProxyProviderAuthenticationError(ProxyProviderError):
    code = "PROVIDER_AUTHENTICATION_FAILED"


class ProxyProviderRejectedError(ProxyProviderError):
    code = "PROVIDER_REQUEST_REJECTED"


class ProxyProviderUnavailableError(ProxyProviderError):
    code = "PROVIDER_UNAVAILABLE"
    definitive = False


class ProxyProviderOutcomeUnknown(ProxyProviderUnavailableError):
    """A mutating call may have reached the provider and must not be retried."""

    code = "PROVIDER_OUTCOME_UNKNOWN"


class ProxyProviderResponseError(ProxyProviderError):
    code = "PROVIDER_INVALID_RESPONSE"
    definitive = False


@dataclass(frozen=True)
class ProviderQuote:
    amount: Decimal
    currency: str
    raw: JsonObject


@runtime_checkable
class ProxyProvider(Protocol):
    key: str

    def list_services(self) -> JsonObject: ...

    def get_setup(self, service_id: str, *, plan_id: str = "") -> JsonObject: ...

    def quote(self, service_id: str, configuration: Mapping[str, Any]) -> ProviderQuote: ...

    def execute(self, service_id: str, configuration: Mapping[str, Any]) -> JsonObject: ...

    def get_order(self, order_id: str) -> JsonObject: ...

    def get_order_proxies(self, order_id: str) -> JsonObject: ...

    def get_proxy(self, proxy_id: str) -> JsonObject: ...

    def get_balance(self) -> JsonObject: ...

    def extension_quote(self, proxy_id: str, *, period_months: int) -> ProviderQuote: ...

    def extend_period(self, proxy_id: str, *, period_months: int) -> JsonObject: ...
