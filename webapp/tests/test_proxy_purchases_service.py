from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock

from cryptography.fernet import Fernet

from webapp import db as app_db
from webapp import commercial_billing
from webapp.proxy_providers import MockProxyProvider, ProxyProviderOutcomeUnknown
from webapp.proxy_purchases import (
    ProxyPurchaseError,
    create_order,
    create_quote,
    process_due_renewals,
    publish_config,
    reconcile_order,
    record_webhook,
    save_config_draft,
    admin_resolve_order,
    set_order_renewal,
    process_webhook_events,
    purchase_options,
    sync_active_assets,
)
from webapp.proxy_market_credentials import resolve_market_proxy_credentials
from webapp.system_proxy_pool import list_system_proxy_pool_options


class _UnknownProvider(MockProxyProvider):
    def execute(self, service_id, configuration):
        self.execute_calls += 1
        raise ProxyProviderOutcomeUnknown("unknown")


class ProxyPurchaseServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(
            os.environ,
            {
                "APP_DB_PATH": os.path.join(self.temp.name, "app.db"),
                "PASSWORD_VAULT_KEY": Fernet.generate_key().decode(),
            },
            clear=False,
        )
        self.env.start()
        app_db.init_db()
        with app_db.db() as conn:
            now = 1_700_000_000
            conn.execute(
                "INSERT INTO users(username,password_hash,created_at,updated_at) VALUES ('buyer','x',?,?)", (now, now)
            )
            self.user_id = int(conn.execute("SELECT id FROM users WHERE username='buyer'").fetchone()[0])
            commercial_billing.ensure_wallet(conn, self.user_id, now=now)
            conn.execute(
                "UPDATE billing_wallets SET credit_units=100000,cash_backed_credit_units=100000 WHERE user_id=?",
                (self.user_id,),
            )
            draft = save_config_draft(
                conn,
                {
                    "provider": "proxy-cheap",
                    "live_purchasing_enabled": True,
                    "service_id": "static-residential-ipv4",
                    "plan_id": "standard",
                    "points_per_usd": "25",
                    "fixed_fee_points": "0",
                    "max_vendor_cost_usd": "100",
                    "safety_buffer_usd": "0",
                    "minimum_profit_usd": "0",
                    "default_period": {"unit": "months", "value": 1},
                },
                actor_user_id=self.user_id,
                now=now,
            )
            publish_config(conn, draft["id"], actor_user_id=self.user_id, now=now)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def _quote(self, provider):
        with app_db.db() as conn:
            return create_quote(
                conn,
                user_id=self.user_id,
                country="US",
                auto_renew=True,
                provider=provider,
                now=1_700_000_100,
            )

    def test_quote_is_server_priced_and_order_is_idempotent(self):
        provider = MockProxyProvider(unit_price_usd="4.00")
        quote = self._quote(provider)
        self.assertEqual(quote["charge_units"], 10000)
        self.assertEqual(quote["quantity"], 1)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="buy-once",
                provider=provider,
                now=1_700_000_101,
            )
        self.assertEqual(order["status"], "active")
        self.assertEqual(provider.execute_calls, 1)
        with app_db.db() as conn:
            replay = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="buy-once",
                provider=provider,
                now=1_700_000_102,
            )
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?", (self.user_id,)
            ).fetchone()
            item = conn.execute(
                "SELECT ownership_type,owner_user_id FROM proxy_market_items WHERE provider_purchase_order_id=?",
                (order["id"],),
            ).fetchone()
            social = conn.execute(
                "SELECT source,purchase_status,market_allocation_id FROM social_proxies WHERE market_item_id IN "
                "(SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)",
                (order["id"],),
            ).fetchone()
            stored = conn.execute(
                "SELECT * FROM social_proxies WHERE market_item_id IN "
                "(SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)",
                (order["id"],),
            ).fetchone()
            resolved = resolve_market_proxy_credentials(
                conn,
                stored,
                owner_user_id=self.user_id,
            )
        self.assertEqual(replay["id"], order["id"])
        self.assertEqual(provider.execute_calls, 1)
        self.assertEqual(tuple(wallet), (90000, 90000))
        self.assertEqual(tuple(item), ("owned", self.user_id))
        self.assertEqual(tuple(social), ("provider_purchase", "owned", ""))
        self.assertEqual(resolved["username"], "mock-user")
        self.assertEqual(resolved["password"], "mock-password")
        with app_db.db() as conn:
            selectable = list_system_proxy_pool_options(conn, owner_user_id=self.user_id)
        owned = [row for row in selectable if row["ownership_type"] == "owned"]
        self.assertEqual(len(owned), 1)
        self.assertEqual(owned[0]["social_proxy_id"], stored["id"])
        self.assertTrue(owned[0]["available"])

    def test_unknown_execute_holds_points_and_never_retries(self):
        provider = _UnknownProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            first = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="unknown-once",
                provider=provider,
                now=1_700_000_101,
            )
        self.assertEqual(first["status"], "provider_unknown")
        with app_db.db() as conn:
            replay = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="unknown-once",
                provider=provider,
                now=1_700_000_102,
            )
            held = conn.execute(
                "SELECT status FROM billing_reservations WHERE id=(SELECT reservation_id FROM proxy_purchase_orders WHERE id=?)",
                (first["id"],),
            ).fetchone()[0]
        self.assertEqual(replay["status"], "provider_unknown")
        self.assertEqual(provider.execute_calls, 1)
        self.assertEqual(held, "held")

    def test_unknown_order_can_be_manually_released_idempotently(self):
        provider = _UnknownProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(conn, user_id=self.user_id, quote_id=quote["id"], idempotency_key="unknown-release", provider=provider, now=1_700_000_101)
        with app_db.db() as conn:
            released = admin_resolve_order(conn, order["id"], "confirm_not_ordered", actor_user_id=1)
            replay = admin_resolve_order(conn, order["id"], "confirm_not_ordered", actor_user_id=1)
            wallet = conn.execute("SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?", (self.user_id,)).fetchone()
        self.assertEqual(released["status"], "failed")
        self.assertEqual(replay["status"], "failed")
        self.assertEqual(tuple(wallet), (100000, 100000))

    def test_same_client_idempotency_key_is_scoped_per_user(self):
        provider = MockProxyProvider()
        with app_db.db() as conn:
            now = 1_700_000_000
            conn.execute("INSERT INTO users(username,password_hash,created_at,updated_at) VALUES ('buyer2','x',?,?)", (now, now))
            user2 = int(conn.execute("SELECT id FROM users WHERE username='buyer2'").fetchone()[0])
            commercial_billing.ensure_wallet(conn, user2, now=now)
            conn.execute("UPDATE billing_wallets SET credit_units=100000,cash_backed_credit_units=100000 WHERE user_id=?", (user2,))
        quote1 = self._quote(provider)
        with app_db.db() as conn:
            quote2 = create_quote(conn, user_id=user2, country="US", auto_renew=False, provider=provider, now=1_700_000_100)
        with app_db.db() as conn:
            first = create_order(conn, user_id=self.user_id, quote_id=quote1["id"], idempotency_key="shared-browser-key", provider=provider, now=1_700_000_101)
        with app_db.db() as conn:
            second = create_order(conn, user_id=user2, quote_id=quote2["id"], idempotency_key="shared-browser-key", provider=provider, now=1_700_000_102)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(provider.execute_calls, 2)

    def test_active_order_enable_renewal_upserts_schedule(self):
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(conn, user_id=self.user_id, quote_id=quote["id"], idempotency_key="late-renew", provider=provider, now=1_700_000_101)
            conn.execute("DELETE FROM proxy_renewal_schedules WHERE order_id=?", (order["id"],))
            set_order_renewal(conn, user_id=self.user_id, order_id=order["id"], enabled=True, now=1_700_000_102)
            schedule = conn.execute("SELECT status,enabled FROM proxy_renewal_schedules WHERE order_id=?", (order["id"],)).fetchone()
        self.assertEqual(tuple(schedule), ("scheduled", 1))

    def test_publish_validates_provider_service_and_plan(self):
        with app_db.db() as conn:
            draft = save_config_draft(
                conn,
                {"provider": "proxy-cheap", "service_id": "static-residential-ipv4", "plan_id": "missing", "points_per_usd": "25", "fixed_fee_points": "0", "max_vendor_cost_usd": "100", "safety_buffer_usd": "0", "minimum_profit_usd": "0", "usd_to_ntd_rate": "35", "payment_fee_rate": "0.05"},
                actor_user_id=self.user_id,
            )
            with self.assertRaises(ProxyPurchaseError) as caught:
                publish_config(conn, draft["id"], actor_user_id=self.user_id, provider=MockProxyProvider())
        self.assertEqual(caught.exception.code, "PROVIDER_PLAN_UNAVAILABLE")

    def test_publish_validates_country_scoped_isp(self):
        class CountryIspProvider(MockProxyProvider):
            def get_setup(self, service_id, *, plan_id=""):
                return {"countries": [{"code": "US", "name": "United States"}], "isps": {"US": [{"id": "isp-good"}]}}
        with app_db.db() as conn:
            draft = save_config_draft(conn, {"provider": "proxy-cheap", "service_id": "static-residential-ipv4", "plan_id": "standard", "setup_defaults": {"country": "US", "isp": "isp-bad"}, "points_per_usd": "25", "fixed_fee_points": "0", "max_vendor_cost_usd": "100", "safety_buffer_usd": "0", "minimum_profit_usd": "0", "usd_to_ntd_rate": "35", "payment_fee_rate": "0.05"}, actor_user_id=self.user_id)
            with self.assertRaises(ProxyPurchaseError) as caught:
                publish_config(conn, draft["id"], actor_user_id=self.user_id, provider=CountryIspProvider())
        self.assertEqual(caught.exception.code, "PROVIDER_ISP_UNAVAILABLE")

    def test_user_country_resolves_a_compatible_isp_and_hides_empty_inventory(self):
        class CountryIspProvider(MockProxyProvider):
            def __init__(self):
                super().__init__()
                self.last_configuration = None

            def get_setup(self, service_id, *, plan_id=""):
                return {
                    "countries": [
                        {"code": "US", "name": "United States"},
                        {"code": "GB", "name": "United Kingdom"},
                    ],
                    "isps": {"US": [{"id": "isp-us", "label": "US Carrier"}], "GB": []},
                    "periods": [{"unit": "months", "value": 1}],
                }

            def quote(self, service_id, configuration):
                self.last_configuration = dict(configuration)
                return super().quote(service_id, configuration)

        provider = CountryIspProvider()
        with app_db.db() as conn:
            options = purchase_options(conn, user_id=self.user_id, provider=provider)
            quote = create_quote(
                conn,
                user_id=self.user_id,
                country="US",
                auto_renew=False,
                provider=provider,
                now=1_700_000_100,
            )
            with self.assertRaises(ProxyPurchaseError) as caught:
                create_quote(
                    conn,
                    user_id=self.user_id,
                    country="GB",
                    auto_renew=False,
                    provider=provider,
                    now=1_700_000_101,
                )
        self.assertEqual([item["code"] for item in options["regions"]], ["US"])
        self.assertTrue(options["isp_managed"])
        self.assertEqual(provider.last_configuration["ispId"], "isp-us")
        self.assertEqual(quote["country"], "US")
        self.assertEqual(caught.exception.code, "INVALID_COUNTRY")

    def test_supplier_order_id_survives_local_settlement_crash_and_reconciles(self):
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with mock.patch("webapp.proxy_purchases._deliver_owned_proxy", side_effect=RuntimeError("simulated local crash")):
            with app_db.db() as conn:
                create_order(
                    conn, user_id=self.user_id, quote_id=quote["id"],
                    idempotency_key="crash-after-execute", provider=provider, now=1_700_000_101,
                )
        with app_db.db() as conn:
            row = conn.execute(
                "SELECT id,provider_order_id,reservation_id,status FROM proxy_purchase_orders "
                "WHERE idempotency_key='crash-after-execute'"
            ).fetchone()
            held = conn.execute(
                "SELECT status FROM billing_reservations WHERE id=?",
                (row["reservation_id"],),
            ).fetchone()[0]
            recovered = reconcile_order(
                conn,
                order_id=row["id"],
                provider=provider,
                now=1_700_000_102,
            )
            settled = conn.execute(
                "SELECT status FROM billing_reservations WHERE id=?",
                (row["reservation_id"],),
            ).fetchone()[0]
        self.assertTrue(row["provider_order_id"])
        self.assertEqual(row["status"], "provisioning")
        self.assertEqual(held, "held")
        self.assertEqual(recovered["status"], "active")
        self.assertEqual(settled, "settled")
        self.assertEqual(provider.execute_calls, 1)

    def test_renewal_mutation_is_not_repeated_after_local_settlement_crash(self):
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="renew-crash-boundary",
                provider=provider,
                now=1_700_000_101,
            )
            conn.execute(
                "UPDATE proxy_renewal_schedules SET next_attempt_at=? WHERE order_id=?",
                (1_700_000_102, order["id"]),
            )
        with mock.patch(
            "webapp.proxy_purchases.commercial_billing.settle_reservation",
            side_effect=RuntimeError("simulated renewal settlement crash"),
        ):
            with app_db.db() as conn:
                process_due_renewals(conn, provider=provider, now=1_700_000_103)
        with app_db.db() as conn:
            status = conn.execute(
                "SELECT status FROM proxy_renewal_schedules WHERE order_id=?",
                (order["id"],),
            ).fetchone()[0]
            second = process_due_renewals(conn, provider=provider, now=1_700_000_104)
        self.assertEqual(status, "provider_unknown")
        self.assertEqual(second, [])
        self.assertEqual(provider.extend_calls, 1)

    def test_webhook_deduplicates_verified_event(self):
        import hashlib
        import hmac

        body = json.dumps({"proxyId": "p-1"}, separators=(",", ":")).encode()
        signature = hmac.new(b"hook", b"proxy.status.changed" + b"evt-1" + body, hashlib.sha256).hexdigest()
        with app_db.db() as conn:
            first = record_webhook(
                conn,
                raw_body=body,
                event_name="proxy.status.changed",
                event_id="evt-1",
                signature=signature,
                secret="hook",
            )
            second = record_webhook(
                conn,
                raw_body=body,
                event_name="proxy.status.changed",
                event_id="evt-1",
                signature=signature,
                secret="hook",
            )
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])

    def test_webhook_consumer_marks_event_processed(self):
        import hashlib
        import hmac
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(conn, user_id=self.user_id, quote_id=quote["id"], idempotency_key="webhook-order", provider=provider, now=1_700_000_101)
            body = json.dumps({"proxyId": f"proxy-{order['provider_order_id']}"}, separators=(",", ":")).encode()
            signature = hmac.new(b"hook", b"proxy.status.changed" + b"evt-process" + body, hashlib.sha256).hexdigest()
            record_webhook(conn, raw_body=body, event_name="proxy.status.changed", event_id="evt-process", signature=signature, secret="hook", now=1_700_000_102)
        with app_db.db() as conn:
            processed = process_webhook_events(conn, provider=provider, now=1_700_000_103)
            state = conn.execute("SELECT processing_status FROM proxy_purchase_events WHERE event_id='evt-process'").fetchone()[0]
        self.assertTrue(processed)
        self.assertEqual(state, "processed")

    def test_active_sync_applies_provider_canceled_status(self):
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(conn, user_id=self.user_id, quote_id=quote["id"], idempotency_key="active-sync", provider=provider, now=1_700_000_101)
            conn.execute("UPDATE proxy_purchase_orders SET last_synced_at=0 WHERE id=?", (order["id"],))
        original = provider.get_proxy
        provider.get_proxy = lambda proxy_id: {**original(proxy_id), "status": "CANCELED"}
        with app_db.db() as conn:
            synced = sync_active_assets(conn, provider=provider, now=1_700_010_000)
            status = conn.execute("SELECT status FROM proxy_purchase_orders WHERE id=?", (order["id"],)).fetchone()[0]
        self.assertEqual(synced, [order["id"]])
        self.assertEqual(status, "canceled")

    def test_delivered_order_terminal_reconcile_does_not_refund_purchase(self):
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(conn, user_id=self.user_id, quote_id=quote["id"], idempotency_key="used-then-expired", provider=provider, now=1_700_000_101)
        provider.get_order_proxies = lambda order_id: {"data": [{"id": f"proxy-{order_id}", "status": "EXPIRED"}]}
        with app_db.db() as conn:
            reconciled = reconcile_order(conn, order_id=order["id"], provider=provider, now=1_700_100_000)
            wallet = conn.execute("SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?", (self.user_id,)).fetchone()
            reservation = conn.execute("SELECT status FROM billing_reservations WHERE id=(SELECT reservation_id FROM proxy_purchase_orders WHERE id=?)", (order["id"],)).fetchone()[0]
        self.assertEqual(reconciled["status"], "expired")
        self.assertEqual(tuple(wallet), (90000, 90000))
        self.assertEqual(reservation, "settled")

    def test_unmatched_webhook_is_terminally_marked(self):
        import hashlib
        import hmac
        body = b'{"proxyId":"missing"}'
        signature = hmac.new(b"hook", b"proxy.status.changed" + b"evt-unmatched" + body, hashlib.sha256).hexdigest()
        with app_db.db() as conn:
            record_webhook(conn, raw_body=body, event_name="proxy.status.changed", event_id="evt-unmatched", signature=signature, secret="hook", now=1_700_000_100)
        with app_db.db() as conn:
            process_webhook_events(conn, provider=MockProxyProvider(), now=1_700_000_101)
            event = conn.execute("SELECT processing_status,last_error FROM proxy_purchase_events WHERE event_id='evt-unmatched'").fetchone()
        self.assertEqual(tuple(event), ("unmatched", "local order not found"))


if __name__ == "__main__":
    unittest.main()
