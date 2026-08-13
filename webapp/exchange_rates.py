from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any


USD_TWD_RATE_URL = "https://api.frankfurter.dev/v2/rate/USD/TWD"
_CACHE_TTL_SECONDS = 15 * 60
_STALE_TTL_SECONDS = 24 * 60 * 60
_MAX_RESPONSE_BYTES = 32 * 1024
_LOCK = threading.Lock()
_CACHE: "ExchangeRateQuote | None" = None


class ExchangeRateError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExchangeRateQuote:
    base: str
    quote: str
    rate: Decimal
    source: str
    fetched_at: int
    source_date: str = ""
    stale: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "base": self.base,
            "quote": self.quote,
            "rate": str(self.rate),
            "source": self.source,
            "fetched_at": self.fetched_at,
            "source_date": self.source_date,
            "stale": self.stale,
        }


def _parse_rate(payload: Any) -> tuple[Decimal, str]:
    if not isinstance(payload, dict):
        raise ExchangeRateError("Exchange-rate service returned an invalid response")
    try:
        rate = Decimal(str(payload.get("rate")))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ExchangeRateError("Exchange-rate service did not return USD/TWD") from exc
    if not rate.is_finite() or rate <= 0:
        raise ExchangeRateError("Exchange-rate service returned an invalid USD/TWD rate")
    return rate, str(payload.get("date") or "")[:32]


def _fetch_remote(now: int) -> ExchangeRateQuote:
    request = urllib.request.Request(
        USD_TWD_RATE_URL,
        headers={"Accept": "application/json", "User-Agent": "Vecto-Proxy-Purchase/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        raise ExchangeRateError("Unable to refresh the USD/TWD reference rate") from exc
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise ExchangeRateError("Exchange-rate response exceeded the safe size limit")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ExchangeRateError("Exchange-rate service returned malformed JSON") from exc
    rate, source_date = _parse_rate(payload)
    return ExchangeRateQuote("USD", "TWD", rate, "Frankfurter", now, source_date, False)


def get_usd_twd_rate(*, force_refresh: bool = False, now: int | None = None) -> ExchangeRateQuote:
    """Return a server-side USD/TWD reference rate with a short, bounded cache.

    PROXY_PURCHASE_TEST_USD_TWD_RATE exists only for deterministic test and local
    mock-provider runs. Production callers always use the fixed HTTPS endpoint.
    """

    current = int(now or time.time())
    override = str(os.getenv("PROXY_PURCHASE_TEST_USD_TWD_RATE", "")).strip()
    if override:
        rate, _ = _parse_rate({"rate": override})
        return ExchangeRateQuote("USD", "TWD", rate, "test-override", current, "", False)

    global _CACHE
    with _LOCK:
        cached = _CACHE
        if cached and not force_refresh and current - cached.fetched_at < _CACHE_TTL_SECONDS:
            return cached
        try:
            refreshed = _fetch_remote(current)
        except ExchangeRateError:
            if cached and current - cached.fetched_at < _STALE_TTL_SECONDS:
                return ExchangeRateQuote(
                    cached.base,
                    cached.quote,
                    cached.rate,
                    cached.source,
                    cached.fetched_at,
                    cached.source_date,
                    True,
                )
            raise
        _CACHE = refreshed
        return refreshed


def clear_cache() -> None:
    global _CACHE
    with _LOCK:
        _CACHE = None
