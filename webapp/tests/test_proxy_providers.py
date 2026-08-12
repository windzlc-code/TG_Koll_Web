from __future__ import annotations

import hashlib
import hmac
import json
import unittest
from unittest import mock

import requests

from webapp.proxy_providers import (
    API_BASE_URL,
    ProxyCheapProvider,
    ProxyProviderConfigurationError,
    ProxyProviderOutcomeUnknown,
    ProxyProviderResponseError,
)
from webapp.proxy_purchases import verify_webhook_signature


class _Response:
    def __init__(self, payload, *, status=200, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._raw = json.dumps(payload).encode()
        self.closed = False

    def iter_content(self, chunk_size=16384):
        yield self._raw

    def close(self):
        self.closed = True


class _Session:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.error:
            raise self.error
        return self.response


class ProxyCheapProviderTests(unittest.TestCase):
    def test_requires_both_credentials_and_pins_origin(self):
        provider = ProxyCheapProvider(api_key="only-key", api_secret="", session=_Session())
        with self.assertRaises(ProxyProviderConfigurationError):
            provider.list_services()

        session = _Session(_Response({"data": []}))
        provider = ProxyCheapProvider(api_key="key", api_secret="secret", session=session)
        provider.list_services()
        method, url, kwargs = session.calls[0]
        self.assertEqual((method, url), ("GET", f"{API_BASE_URL}/v2/order"))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertTrue(kwargs["stream"])
        self.assertEqual(kwargs["headers"]["X-Api-Secret"], "secret")

    def test_quote_prefers_final_price_and_forces_quantity_one(self):
        response = {"finalPriceInCurrency": "4.25", "priceNoDiscounts": "9", "currency": "USD"}
        session = _Session(_Response(response))
        provider = ProxyCheapProvider(api_key="key", api_secret="secret", session=session)
        quote = provider.quote(
            "static-residential-ipv4",
            {"quantity": 99, "country": "US", "period": {"unit": "months", "value": 1}},
        )
        self.assertEqual(str(quote.amount), "4.25")
        self.assertEqual(session.calls[0][2]["json"]["quantity"], 1)

    def test_mutation_invalid_json_is_unknown(self):
        response = _Response({"id": "created"})
        response._raw = b"not-json"
        with mock.patch.dict("os.environ", {"PROXYCHEAP_EXECUTE_SAFE_RECONCILIATION": "true"}):
            provider = ProxyCheapProvider(
                api_key="key", api_secret="secret", session=_Session(response), purchases_enabled=True
            )
            with self.assertRaises(ProxyProviderOutcomeUnknown):
                provider.execute("static-residential-ipv4", {})

    def test_mutation_redirect_is_unknown(self):
        with mock.patch.dict("os.environ", {"PROXYCHEAP_EXECUTE_SAFE_RECONCILIATION": "true"}):
            provider = ProxyCheapProvider(api_key="key", api_secret="secret", session=_Session(_Response({}, status=302)), purchases_enabled=True)
            with self.assertRaises(ProxyProviderOutcomeUnknown):
                provider.execute("static-residential-ipv4", {})

    def test_price_without_currency_fails_closed(self):
        provider = ProxyCheapProvider(
            api_key="key", api_secret="secret", session=_Session(_Response({"finalPrice": "4.25"}))
        )
        with self.assertRaises(ProxyProviderResponseError):
            provider.quote("static-residential-ipv4", {})

    def test_real_execute_is_off_by_default_and_timeout_is_unknown(self):
        provider = ProxyCheapProvider(
            api_key="key", api_secret="secret", session=_Session(_Response({"id": "no"})), purchases_enabled=False
        )
        with self.assertRaises(ProxyProviderConfigurationError):
            provider.execute("service", {})

        with mock.patch.dict("os.environ", {"PROXYCHEAP_EXECUTE_SAFE_RECONCILIATION": "true"}):
            provider = ProxyCheapProvider(
                api_key="key",
                api_secret="secret",
                session=_Session(error=requests.Timeout("secret must not leak")),
                purchases_enabled=True,
            )
            with self.assertRaises(ProxyProviderOutcomeUnknown) as caught:
                provider.execute("service", {})
        self.assertNotIn("secret must not leak", str(caught.exception))

    def test_response_size_is_bounded(self):
        session = _Session(_Response({"data": "x" * 1000}, headers={"Content-Length": "99999"}))
        provider = ProxyCheapProvider(
            api_key="key", api_secret="secret", session=session, max_response_bytes=64
        )
        with self.assertRaises(ProxyProviderResponseError):
            provider.list_services()

    def test_webhook_hmac_uses_event_name_id_and_raw_body(self):
        body = b'{"proxyId":"p-1"}'
        expected = hmac.new(b"hook", b"proxy.status.changed" + b"evt-1" + body, hashlib.sha256).hexdigest()
        self.assertTrue(
            verify_webhook_signature(
                body,
                event_name="proxy.status.changed",
                event_id="evt-1",
                signature=f"sha256={expected}",
                secret="hook",
            )
        )
        self.assertFalse(
            verify_webhook_signature(
                body + b" ", event_name="proxy.status.changed", event_id="evt-1", signature=expected, secret="hook"
            )
        )


if __name__ == "__main__":
    unittest.main()
