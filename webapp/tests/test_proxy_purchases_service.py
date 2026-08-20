from __future__ import annotations

import json
import os
import tempfile
import unittest
from decimal import Decimal, ROUND_CEILING
from unittest import mock

from cryptography.fernet import Fernet

from webapp import db as app_db
from webapp import commercial_billing
from webapp import proxy_ip_admin
from webapp import proxy_purchases
from webapp.exchange_rates import ExchangeRateQuote
from webapp.proxy_providers import MockProxyProvider, ProxyProviderOutcomeUnknown
from webapp.proxy_purchases import (
    ProxyPurchaseError,
    create_order,
    create_quote,
    get_order,
    process_due_renewals,
    publish_config,
    reconcile_due_orders,
    reconcile_order,
    record_webhook,
    save_config_draft,
    admin_resolve_order,
    set_order_renewal,
    process_webhook_events,
    purchase_options,
    sync_active_assets,
)
from webapp.proxy_market_credentials import (
    ProxyMarketCredentialAuthorizationError,
    resolve_market_proxy_credentials,
)
from webapp.system_proxy_pool import list_system_proxy_pool_options


class _UnknownProvider(MockProxyProvider):
    def execute(self, service_id, configuration):
        self.execute_calls += 1
        raise ProxyProviderOutcomeUnknown("unknown")


class _PendingProvider(MockProxyProvider):
    def get_order(self, order_id):
        return {"id": order_id, "status": "PROCESSING"}

    def get_order_proxies(self, order_id):
        return {"data": [{"id": f"proxy-{order_id}", "status": "PENDING"}]}


class _TerminalBeforeDeliveryProvider(MockProxyProvider):
    def get_order(self, order_id):
        return {"id": order_id, "status": "FAILED"}

    def get_order_proxies(self, order_id):
        return {"data": []}


class _MislabeledCityProvider(MockProxyProvider):
    def get_order_proxies(self, order_id):
        payload = super().get_order_proxies(order_id)
        payload["data"][0]["city"] = "Taichung"
        payload["data"][0]["region"] = "Taichung"
        return payload


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
            fetched = get_order(conn, user_id=self.user_id, order_id=order["id"])
            resolved = resolve_market_proxy_credentials(
                conn,
                stored,
                owner_user_id=self.user_id,
            )
        self.assertEqual(replay["id"], order["id"])
        self.assertEqual(order["market_item_id"], stored["market_item_id"])
        self.assertEqual(order["social_proxy_id"], stored["id"])
        self.assertEqual(fetched["market_item_id"], stored["market_item_id"])
        self.assertEqual(fetched["social_proxy_id"], stored["id"])
        self.assertEqual(provider.execute_calls, 1)
        self.assertEqual(tuple(wallet), (90000, 90000))
        self.assertEqual(tuple(item), ("owned", self.user_id))
        self.assertEqual(tuple(social), ("provider_purchase", "owned", ""))
        self.assertEqual(resolved["username"], "mock-user")
        self.assertEqual(resolved["password"], "mock-password")
        health_result = {
            "ok": True,
            "exit_ip": "198.51.100.10",
            "latency_ms": 42,
            "response": {
                "country": "Portugal",
                "country_code": "PT",
                "region": "Distrito de Lisboa",
                "city": "Lisbon",
                "connection": {"isp": "Mock ISP"},
            },
        }
        with app_db.db() as conn:
            conn.execute(
                "UPDATE proxy_market_items SET last_check_at=0 WHERE provider_purchase_order_id=?",
                (order["id"],),
            )
        with mock.patch.object(proxy_ip_admin, "_run_proxy_connection_check", return_value=health_result):
            maintenance = proxy_ip_admin.run_proxy_market_health_maintenance_once(now=1_700_000_103)
        self.assertEqual(maintenance["healthy"], 1)
        with app_db.db() as conn:
            selectable = list_system_proxy_pool_options(conn, owner_user_id=self.user_id)
            synchronized = conn.execute(
                "SELECT country,region,city,isp,last_check_result FROM social_proxies WHERE id=?",
                (stored["id"],),
            ).fetchone()
        owned = [row for row in selectable if row["ownership_type"] == "owned"]
        self.assertEqual(len(owned), 1)
        self.assertEqual(owned[0]["social_proxy_id"], stored["id"])
        self.assertTrue(owned[0]["available"])
        self.assertEqual(owned[0]["country"], "Portugal")
        self.assertEqual(owned[0]["country_code"], "PT")
        self.assertEqual(owned[0]["region"], "Distrito de Lisboa")
        self.assertEqual(owned[0]["city"], "Lisbon")
        self.assertEqual(owned[0]["exit_ip"], "198.51.100.10")
        self.assertEqual(tuple(synchronized)[:4], ("Portugal", "Distrito de Lisboa", "Lisbon", "Mock ISP"))
        self.assertTrue(json.loads(str(synchronized["last_check_result"]))["ok"])

    def test_admin_shared_purchased_proxy_credentials_require_active_share(self):
        provider = MockProxyProvider(unit_price_usd="4.00")
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="admin-share-credentials",
                provider=provider,
                now=1_700_000_101,
            )
            conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at,updated_at) "
                "VALUES ('share-admin','x',1,?,?)",
                (1_700_000_102, 1_700_000_102),
            )
            admin_id = int(
                conn.execute("SELECT id FROM users WHERE username='share-admin'").fetchone()[0]
            )
            conn.execute(
                "INSERT INTO users(username,password_hash,created_at,updated_at) "
                "VALUES ('share-recipient','x',?,?)",
                (1_700_000_102, 1_700_000_102),
            )
            recipient_id = int(
                conn.execute("SELECT id FROM users WHERE username='share-recipient'").fetchone()[0]
            )
            item = conn.execute(
                "SELECT * FROM proxy_market_items WHERE provider_purchase_order_id=?",
                (order["id"],),
            ).fetchone()
            shared_proxy_id = "social_proxy_admin_shared"
            conn.execute(
                "INSERT INTO social_proxies("
                "id,user_id,name,proxy_type,host,port,source,purchase_status,status,"
                "market_item_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    shared_proxy_id,
                    recipient_id,
                    "管理员共享代理",
                    str(item["proxy_type"]),
                    str(item["host"]),
                    int(item["port"]),
                    "provider_purchase",
                    "shared",
                    "active",
                    str(item["id"]),
                    1_700_000_102,
                    1_700_000_102,
                ),
            )
            conn.execute(
                "INSERT INTO proxy_market_shares("
                "id,item_id,user_id,social_proxy_id,status,created_by,created_at,updated_at) "
                "VALUES ('proxy_share_test',?,?,?,'active',?,?,?)",
                (
                    str(item["id"]),
                    recipient_id,
                    shared_proxy_id,
                    admin_id,
                    1_700_000_102,
                    1_700_000_102,
                ),
            )
            shared_proxy = conn.execute(
                "SELECT * FROM social_proxies WHERE id=?", (shared_proxy_id,)
            ).fetchone()

            resolved = resolve_market_proxy_credentials(
                conn, shared_proxy, owner_user_id=recipient_id
            )
            self.assertEqual(resolved["username"], "mock-user")
            self.assertEqual(resolved["password"], "mock-password")

            conn.execute(
                "UPDATE proxy_market_shares SET status='revoked' WHERE id='proxy_share_test'"
            )
            with self.assertRaises(ProxyMarketCredentialAuthorizationError):
                resolve_market_proxy_credentials(
                    conn, shared_proxy, owner_user_id=recipient_id
                )

            conn.execute(
                "UPDATE proxy_market_shares SET status='active',created_by=? "
                "WHERE id='proxy_share_test'",
                (recipient_id,),
            )
            with self.assertRaises(ProxyMarketCredentialAuthorizationError):
                resolve_market_proxy_credentials(
                    conn, shared_proxy, owner_user_id=recipient_id
                )

    def test_owned_proxy_keeps_selected_city_when_provider_and_geo_differ(self):
        provider = _MislabeledCityProvider(unit_price_usd="4.00")
        with app_db.db() as conn:
            quote = create_quote(
                conn,
                user_id=self.user_id,
                country="US",
                city="New York",
                auto_renew=False,
                provider=provider,
                now=1_700_000_200,
            )
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="buy-selected-city",
                provider=provider,
                now=1_700_000_201,
            )
            item = conn.execute(
                "SELECT city,region FROM proxy_market_items WHERE provider_purchase_order_id=?",
                (order["id"],),
            ).fetchone()
            social = conn.execute(
                "SELECT id,city,region,source FROM social_proxies WHERE market_item_id IN "
                "(SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)",
                (order["id"],),
            ).fetchone()
            request = json.loads(
                conn.execute(
                    "SELECT request_json FROM proxy_purchase_orders WHERE id=?",
                    (order["id"],),
                ).fetchone()[0]
            )
        self.assertEqual(request["city"], "New York")
        self.assertEqual(request["cityName"], "New York")
        self.assertEqual(tuple(item), ("New York", "New York"))
        self.assertEqual(tuple(social)[1:4], ("New York", "New York", "provider_purchase"))
        self.assertEqual(provider.orders[next(iter(provider.orders))]["configuration"]["city"], "New York")

        health_result = {
            "ok": True,
            "exit_ip": "198.51.100.10",
            "latency_ms": 18,
            "response": {
                "country": "Taiwan",
                "country_code": "TW",
                "region": "Taichung",
                "city": "Taichung",
                "connection": {"isp": "Lumina broadband UAB"},
            },
        }
        with app_db.db() as conn:
            conn.execute(
                "UPDATE proxy_market_items SET last_check_at=0 WHERE provider_purchase_order_id=?",
                (order["id"],),
            )
        with mock.patch.object(proxy_ip_admin, "_run_proxy_connection_check", return_value=health_result):
            maintenance = proxy_ip_admin.run_proxy_market_health_maintenance_once(now=1_700_000_202)
        self.assertEqual(maintenance["healthy"], 1)
        with app_db.db() as conn:
            after_item = conn.execute(
                "SELECT city,region FROM proxy_market_items WHERE provider_purchase_order_id=?",
                (order["id"],),
            ).fetchone()
            after_social = conn.execute(
                "SELECT city,region FROM social_proxies WHERE id=?",
                (social["id"],),
            ).fetchone()
            selectable = list_system_proxy_pool_options(conn, owner_user_id=self.user_id)
        owned = [row for row in selectable if row["ownership_type"] == "owned"]
        self.assertEqual(tuple(after_item), ("New York", "New York"))
        self.assertEqual(tuple(after_social), ("New York", "New York"))
        self.assertEqual(owned[0]["city"], "New York")
        self.assertEqual(owned[0]["region"], "New York")

    def test_order_list_distinguishes_legacy_actual_city_from_selected_city(self):
        provider = _MislabeledCityProvider(unit_price_usd="4.00")
        with app_db.db() as conn:
            quote = create_quote(
                conn,
                user_id=self.user_id,
                country="GB",
                city="London",
                auto_renew=False,
                provider=provider,
                now=1_700_000_210,
            )
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="legacy-city-backfill",
                provider=provider,
                now=1_700_000_211,
            )
            conn.execute(
                "UPDATE proxy_market_items SET city='Taichung',region='Taichung' "
                "WHERE provider_purchase_order_id=?",
                (order["id"],),
            )
            conn.execute(
                "UPDATE social_proxies SET city='Taichung',region='Taichung' "
                "WHERE market_item_id IN (SELECT id FROM proxy_market_items WHERE provider_purchase_order_id=?)",
                (order["id"],),
            )

        with app_db.db() as conn:
            listed = proxy_purchases.list_orders(conn, limit=20)
        listed_order = next(item for item in listed if item["id"] == order["id"])
        self.assertEqual(listed_order["city"], "Taichung")
        self.assertEqual(listed_order["city_name"], "Taichung")
        self.assertEqual(listed_order["selected_city"], "London")
        self.assertEqual(listed_order["selected_city_name"], "London")
        self.assertTrue(listed_order["city_mismatch"])

    def test_admin_order_executes_without_user_point_balance(self):
        provider = MockProxyProvider(unit_price_usd="4.00")
        with app_db.db() as conn:
            conn.execute("UPDATE users SET is_admin=1 WHERE id=?", (self.user_id,))
            conn.execute(
                "UPDATE billing_wallets SET credit_units=0,cash_backed_credit_units=0 WHERE user_id=?",
                (self.user_id,),
            )
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="admin-buy-without-points",
                admin_waived=True,
                provider=provider,
                now=1_700_000_101,
            )
            order_row = conn.execute(
                "SELECT reservation_id FROM proxy_purchase_orders WHERE id=?",
                (order["id"],),
            ).fetchone()
            reservation = conn.execute(
                "SELECT status,reserved_credit_units,reserved_cash_backed_credit_units "
                "FROM billing_reservations WHERE id=?",
                (order_row["reservation_id"],),
            ).fetchone()
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                (self.user_id,),
            ).fetchone()

        self.assertEqual(order["status"], "active")
        self.assertEqual(provider.execute_calls, 1)
        self.assertEqual(tuple(reservation), ("waived", 0, 0))
        self.assertEqual(tuple(wallet), (0, 0))

    def test_optional_city_fixed_duration_and_live_ntd_profit_pricing(self):
        provider = MockProxyProvider(unit_price_usd="4.00")
        with app_db.db() as conn:
            draft = save_config_draft(
                conn,
                {
                    "provider": "proxy-cheap",
                    "live_purchasing_enabled": True,
                    "service_id": "static-residential-ipv4",
                    "plan_id": "standard",
                    "default_period": 1,
                    "min_period_months": 1,
                    "max_period_months": 2,
                    "pricing_mode": "supplier_plus_profit_ntd",
                    "fx_rate_mode": "auto",
                    "manual_usd_to_ntd_rate": "35",
                    "profit_ntd": "30",
                    "max_vendor_cost_usd": "100",
                },
                actor_user_id=self.user_id,
                now=1_700_000_050,
            )
            publish_config(conn, draft["id"], actor_user_id=self.user_id, provider=provider, now=1_700_000_051)
            options = purchase_options(conn, user_id=self.user_id, provider=provider)
        self.assertEqual(options["cities"]["US"][0]["id"], "New York")
        self.assertEqual(options["cities"]["US"][0]["name_zh"], "纽约")
        self.assertEqual([item["value"] for item in options["periods"]], [1])

        reference = ExchangeRateQuote("USD", "TWD", Decimal("32"), "test", 1_700_000_100)
        with mock.patch.object(proxy_purchases.exchange_rates, "get_usd_twd_rate", return_value=reference):
            with app_db.db() as conn:
                cash_per_point = proxy_purchases._lowest_cash_per_point(conn)
                quote = create_quote(
                    conn,
                    user_id=self.user_id,
                    country="US",
                    city="New York",
                    period_months=1,
                    auto_renew=False,
                    provider=provider,
                    now=1_700_000_100,
                )
                stored = json.loads(conn.execute(
                    "SELECT request_json FROM proxy_purchase_quotes WHERE id=?", (quote["id"],)
                ).fetchone()[0])
        expected_units = int(
            ((Decimal("158") / cash_per_point) * 100).quantize(Decimal("1"), rounding=ROUND_CEILING)
        )
        self.assertEqual(quote["charge_units"], expected_units)
        self.assertEqual(quote["city"], "New York")
        self.assertEqual(stored["city"], "New York")
        self.assertEqual(stored["region"], "New York")
        self.assertEqual(stored["ispId"], "mock-us-isp")
        self.assertEqual(stored["_pricing"]["supplierCostNtd"], "128.00")
        self.assertEqual(stored["_pricing"]["customerTotalNtd"], "158.00")

        with mock.patch.object(proxy_purchases.exchange_rates, "get_usd_twd_rate", return_value=reference):
            with app_db.db() as conn:
                country_quote = create_quote(conn, user_id=self.user_id, country="US", city="", period_months=1, auto_renew=False, provider=provider)
                self.assertEqual(country_quote["city"], "")
                with self.assertRaisesRegex(ProxyPurchaseError, "时长"):
                    create_quote(conn, user_id=self.user_id, country="US", city="New York", period_months=2, auto_renew=False, provider=provider)
        with mock.patch.object(proxy_purchases.exchange_rates, "get_usd_twd_rate", return_value=reference):
            with app_db.db() as conn:
                alias_quote = create_quote(
                    conn,
                    user_id=self.user_id,
                    country="US",
                    city="纽约",
                    period_months=1,
                    auto_renew=False,
                    provider=provider,
                    now=1_700_000_121,
                )
        self.assertEqual(alias_quote["city"], "New York")

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

    def test_manual_bind_rejects_supplier_order_already_owned_by_another_purchase(self):
        provider = _UnknownProvider()
        first_quote = self._quote(provider)
        second_quote = self._quote(provider)
        with app_db.db() as conn:
            first = create_order(
                conn,
                user_id=self.user_id,
                quote_id=first_quote["id"],
                idempotency_key="bind-conflict-first",
                provider=provider,
                now=1_700_000_101,
            )
            second = create_order(
                conn,
                user_id=self.user_id,
                quote_id=second_quote["id"],
                idempotency_key="bind-conflict-second",
                provider=provider,
                now=1_700_000_102,
            )
            conn.execute(
                "UPDATE proxy_purchase_orders SET provider_order_id='supplier-owned' WHERE id=?",
                (first["id"],),
            )
            conn.commit()
            with self.assertRaises(ProxyPurchaseError) as caught:
                admin_resolve_order(
                    conn,
                    second["id"],
                    "bind",
                    provider_order_id="supplier-owned",
                    actor_user_id=1,
                    provider=provider,
                )
        self.assertEqual(caught.exception.code, "PROVIDER_ORDER_IN_USE")

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

    def test_renewal_uses_original_purchase_duration(self):
        provider = MockProxyProvider()
        with app_db.db() as conn:
            draft = save_config_draft(
                conn,
                {
                    "provider": "proxy-cheap",
                    "live_purchasing_enabled": True,
                    "service_id": "static-residential-ipv4",
                    "plan_id": "standard",
                    "default_period": 2,
                    "min_period_months": 1,
                    "max_period_months": 2,
                    "points_per_usd": "25",
                    "max_vendor_cost_usd": "100",
                },
                actor_user_id=self.user_id,
            )
            publish_config(conn, draft["id"], actor_user_id=self.user_id, provider=provider)
            quote = create_quote(
                conn,
                user_id=self.user_id,
                country="US",
                city="New York",
                period_months=2,
                auto_renew=True,
                provider=provider,
                now=1_700_000_100,
            )
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="renew-original-period",
                provider=provider,
                now=1_700_000_101,
            )
            conn.execute(
                "UPDATE proxy_renewal_schedules SET next_attempt_at=? WHERE order_id=?",
                (1_700_000_102, order["id"]),
            )
        with app_db.db() as conn:
            process_due_renewals(conn, provider=provider, now=1_700_000_103)
        self.assertEqual(provider.extension_quote_periods, [2])
        self.assertEqual(provider.extend_periods, [2])

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

    def test_webhook_provider_order_id_maps_to_local_purchase_order(self):
        import hashlib
        import hmac

        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="webhook-provider-order-id",
                provider=provider,
                now=1_700_000_101,
            )
            body = json.dumps(
                {"orderId": order["provider_order_id"]}, separators=(",", ":")
            ).encode()
            signature = hmac.new(
                b"hook",
                b"proxy.status.changed" + b"evt-provider-order-id" + body,
                hashlib.sha256,
            ).hexdigest()
            record_webhook(
                conn,
                raw_body=body,
                event_name="proxy.status.changed",
                event_id="evt-provider-order-id",
                signature=signature,
                secret="hook",
                now=1_700_000_102,
            )
        with app_db.db() as conn:
            process_webhook_events(conn, provider=provider, now=1_700_000_103)
            event = conn.execute(
                "SELECT processing_status,last_error FROM proxy_purchase_events "
                "WHERE event_id='evt-provider-order-id'"
            ).fetchone()
        self.assertEqual(tuple(event), ("processed", ""))

    def test_successful_pending_reconcile_uses_capped_exponential_backoff(self):
        provider = _PendingProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="pending-backoff",
                provider=provider,
                now=1_700_000_101,
            )
            first = conn.execute(
                "SELECT status,next_attempt_at,reconcile_attempts FROM proxy_purchase_orders WHERE id=?",
                (order["id"],),
            ).fetchone()
            reconcile_order(conn, order_id=order["id"], provider=provider, now=1_700_000_161)
            second = conn.execute(
                "SELECT next_attempt_at,reconcile_attempts FROM proxy_purchase_orders WHERE id=?",
                (order["id"],),
            ).fetchone()
            conn.execute(
                "UPDATE proxy_purchase_orders SET reconcile_attempts=20,next_attempt_at=? WHERE id=?",
                (1_700_000_281, order["id"]),
            )
            reconcile_order(conn, order_id=order["id"], provider=provider, now=1_700_000_281)
            capped = conn.execute(
                "SELECT next_attempt_at,reconcile_attempts FROM proxy_purchase_orders WHERE id=?",
                (order["id"],),
            ).fetchone()
        self.assertEqual(tuple(first), ("provisioning", 1_700_000_161, 1))
        self.assertEqual(tuple(second), (1_700_000_281, 2))
        self.assertEqual(tuple(capped), (1_700_003_881, 21))

    def test_terminal_before_delivery_holds_points_until_provider_refund_is_confirmed(self):
        provider = _TerminalBeforeDeliveryProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="terminal-refund-unconfirmed",
                provider=provider,
                now=1_700_000_101,
            )
            stored = conn.execute(
                "SELECT status,error_code,next_attempt_at FROM proxy_purchase_orders WHERE id=?",
                (order["id"],),
            ).fetchone()
            reservation = conn.execute(
                "SELECT status FROM billing_reservations WHERE id=(SELECT reservation_id FROM proxy_purchase_orders WHERE id=?)",
                (order["id"],),
            ).fetchone()[0]
            due_before_backoff = reconcile_due_orders(
                conn,
                provider=provider,
                now=1_700_000_101 + 3599,
            )
        self.assertEqual(stored["status"], "provider_unknown")
        self.assertEqual(stored["error_code"], "PROVIDER_REFUND_UNCONFIRMED")
        self.assertEqual(stored["next_attempt_at"], 1_700_003_701)
        self.assertEqual(reservation, "held")
        self.assertEqual(due_before_backoff, [])

        with app_db.db() as conn:
            resolved = admin_resolve_order(
                conn,
                order["id"],
                "confirm_provider_refunded",
                actor_user_id=1,
            )
            replay = admin_resolve_order(
                conn,
                order["id"],
                "confirm_provider_refunded",
                actor_user_id=1,
            )
            final = conn.execute(
                "SELECT status,error_code FROM proxy_purchase_orders WHERE id=?",
                (order["id"],),
            ).fetchone()
            reservation = conn.execute(
                "SELECT status FROM billing_reservations WHERE id=(SELECT reservation_id FROM proxy_purchase_orders WHERE id=?)",
                (order["id"],),
            ).fetchone()[0]
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                (self.user_id,),
            ).fetchone()
        self.assertEqual(resolved["status"], "failed")
        self.assertEqual(replay["status"], "failed")
        self.assertEqual(tuple(final), ("failed", "MANUAL_CONFIRMED_PROVIDER_REFUNDED"))
        self.assertEqual(reservation, "released")
        self.assertEqual(tuple(wallet), (100000, 100000))

    def test_provider_refund_confirmation_rejects_order_without_refund_pending_state(self):
        provider = MockProxyProvider()
        quote = self._quote(provider)
        with app_db.db() as conn:
            order = create_order(
                conn,
                user_id=self.user_id,
                quote_id=quote["id"],
                idempotency_key="refund-confirmation-rejected",
                provider=provider,
                now=1_700_000_101,
            )
            with self.assertRaises(ProxyPurchaseError) as caught:
                admin_resolve_order(
                    conn,
                    order["id"],
                    "confirm_provider_refunded",
                    actor_user_id=1,
                )
        self.assertEqual(caught.exception.code, "PROVIDER_REFUND_CONFIRMATION_NOT_ALLOWED")

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
