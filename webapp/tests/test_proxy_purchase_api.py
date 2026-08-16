from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from decimal import Decimal

from cryptography.fernet import Fernet
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient

from webapp import commercial_billing
from webapp import db as app_db
from webapp import proxy_purchases
from webapp import proxy_purchase_api
from webapp import proxy_provider_credentials
from webapp.proxy_purchase_api import register_proxy_purchase_routes
from webapp.exchange_rates import ExchangeRateQuote


class ProxyPurchaseApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.env = mock.patch.dict(
            os.environ,
            {
                "APP_DB_PATH": str(Path(self.temp.name) / "app.db"),
                "PROXY_PURCHASE_PROVIDER": "mock",
                "PROXY_PURCHASE_MOCK_PRICE_USD": "4.00",
                "PASSWORD_VAULT_KEY": Fernet.generate_key().decode("ascii"),
            },
            clear=False,
        )
        self.env.start()
        app_db.init_db()
        with app_db.db() as conn:
            now = 1_700_000_000
            first = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at,updated_at) "
                "VALUES ('api-buyer','x',0,?,?)",
                (now, now),
            )
            second = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at,updated_at) "
                "VALUES ('api-other','x',0,?,?)",
                (now, now),
            )
            admin = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at,updated_at) "
                "VALUES ('api-admin','x',1,?,?)",
                (now, now),
            )
            self.user_id = int(first.lastrowid)
            self.other_id = int(second.lastrowid)
            self.admin_id = int(admin.lastrowid)
            for user_id in (self.user_id, self.other_id):
                commercial_billing.ensure_wallet(conn, user_id, now=now)
            conn.execute(
                "UPDATE billing_wallets SET credit_units=100000,cash_backed_credit_units=100000 "
                "WHERE user_id=?",
                (self.user_id,),
            )
            draft = proxy_purchases.save_config_draft(
                conn,
                {
                    "provider": "proxy-cheap",
                    "service_id": "static-residential-ipv4",
                    "plan_id": "standard",
                    "default_period": 1,
                    "quantity": 1,
                    "setup_defaults": {},
                    "points_per_usd": "25",
                    "fixed_fee_points": "0",
                    "max_vendor_cost_usd": "100",
                    "safety_buffer_usd": "0",
                    "minimum_profit_usd": "0",
                    "live_purchasing_enabled": True,
                },
                actor_user_id=self.admin_id,
                now=now,
            )
            proxy_purchases.publish_config(
                conn,
                draft["id"],
                actor_user_id=self.admin_id,
                now=now,
            )

        app = FastAPI()

        def current_user(x_test_user_id: int = Header(default=self.user_id)):
            user_id = int(x_test_user_id)
            return {"id": user_id, "is_admin": 1 if user_id == self.admin_id else 0}

        def require_admin():
            return {"id": self.admin_id, "is_admin": 1}

        self.step_up_calls = []
        self.audit_calls = []

        def step_up(_conn, _admin, *, admin_password: str, totp_code: str):
            self.step_up_calls.append((admin_password, totp_code))
            if admin_password != "test-password" or totp_code != "123456":
                raise AssertionError("unexpected step-up input")

        def audit_callback(_conn, **kwargs):
            self.audit_calls.append(kwargs)

        register_proxy_purchase_routes(
            app,
            current_user_dependency=current_user,
            admin_dependency=require_admin,
            admin_step_up=step_up,
            audit_callback=audit_callback,
        )
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.env.stop()
        self.temp.cleanup()

    def test_user_quote_purchase_poll_and_owner_boundary(self):
        options = self.client.get("/api/proxy-purchases/options")
        self.assertEqual(options.status_code, 200)
        self.assertTrue(options.json()["configured"])
        self.assertEqual(options.json()["cash_backed_points"], 1000)
        self.assertEqual(options.json()["service_id"], "static-residential-ipv4")
        self.assertEqual(options.json()["plan_id"], "standard")
        self.assertEqual(options.json()["quantity"], 1)
        self.assertEqual(options.json()["ip_version"], "IPv4")
        self.assertEqual(options.json()["authentication_type"], "USERNAME_PASSWORD")
        self.assertTrue(options.json()["isp_managed"])

        quote_response = self.client.post(
            "/api/proxy-purchases/quotes",
            json={"country": "US", "auto_renew": True},
        )
        self.assertEqual(quote_response.status_code, 200, quote_response.text)
        quote = quote_response.json()["quote"]

        order_response = self.client.post(
            "/api/proxy-purchases/orders",
            headers={"Idempotency-Key": "api-buy-once"},
            json={"quote_id": quote["id"], "idempotency_key": "api-buy-once"},
        )
        self.assertEqual(order_response.status_code, 200, order_response.text)
        order = order_response.json()["order"]
        self.assertEqual(order["status"], "active")
        reused_quote = self.client.post(
            "/api/proxy-purchases/orders",
            headers={"Idempotency-Key": "api-buy-second"},
            json={"quote_id": quote["id"], "idempotency_key": "api-buy-second"},
        )
        self.assertEqual(reused_quote.status_code, 409)
        self.assertEqual(
            self.client.get(f"/api/proxy-purchases/orders/{order['id']}").json()["order"]["id"],
            order["id"],
        )
        forbidden = self.client.get(
            f"/api/proxy-purchases/orders/{order['id']}",
            headers={"X-Test-User-ID": str(self.other_id)},
        )
        self.assertEqual(forbidden.status_code, 404)

        recovered = self.client.get(
            "/api/proxy-purchases/orders/recover",
            params={"idempotency_key": "api-buy-once"},
        )
        self.assertEqual(recovered.status_code, 200)
        self.assertEqual(recovered.json()["order"]["id"], order["id"])
        cross_user = self.client.get(
            "/api/proxy-purchases/orders/recover",
            params={"idempotency_key": "api-buy-once"},
            headers={"X-Test-User-ID": str(self.other_id)},
        )
        self.assertEqual(cross_user.status_code, 404)

        assets = self.client.get("/api/admin/proxy-purchases/assets")
        self.assertEqual(assets.status_code, 200, assets.text)
        self.assertEqual(len(assets.json()["items"]), 1)
        asset = assets.json()["items"][0]
        self.assertEqual(asset["order_id"], order["id"])
        self.assertEqual(asset["user_id"], self.user_id)
        self.assertEqual(asset["ownership_type"], "owned")
        self.assertEqual(asset["source"], "provider_purchase")
        self.assertEqual(asset["proxy_status"], "active")
        self.assertNotIn("username_ciphertext", assets.text)
        self.assertNotIn("password_ciphertext", assets.text)

    def test_monthly_free_supplier_proxy_uses_platform_funds_once(self):
        with app_db.db() as conn:
            before = int(conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id=?", (self.user_id,)
            ).fetchone()[0])

        response = self.client.post(
            "/api/proxy-purchases/monthly-free",
            json={
                "country": "US",
                "city": "",
                "period_months": 1,
                "auto_renew": True,
                "client_request_id": "monthly-free-test",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        order = response.json()["order"]
        self.assertEqual(order["status"], "active")
        self.assertTrue(order["social_proxy_id"])

        with app_db.db() as conn:
            after = int(conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id=?", (self.user_id,)
            ).fetchone()[0])
            reservation = conn.execute(
                "SELECT status,meta_json FROM billing_reservations WHERE id=("
                "SELECT reservation_id FROM proxy_purchase_orders WHERE id=?)",
                (order["id"],),
            ).fetchone()
        self.assertEqual(after, before)
        self.assertEqual(str(reservation["status"]), "waived")
        self.assertEqual(json.loads(str(reservation["meta_json"]))["waived_reason"], "monthly_free_proxy")

        repeated = self.client.post(
            "/api/proxy-purchases/monthly-free",
            json={
                "country": "US",
                "city": "",
                "period_months": 1,
                "auto_renew": False,
                "client_request_id": "monthly-free-repeat",
            },
        )
        self.assertEqual(repeated.status_code, 409)

    def test_paid_supplier_order_after_monthly_free_uses_provider_and_customer_funds(self):
        provider = proxy_purchases.MockProxyProvider(unit_price_usd="4.00")
        with mock.patch.object(proxy_purchases, "provider_from_environment", return_value=provider):
            with app_db.db() as conn:
                before = dict(conn.execute(
                    "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                    (self.user_id,),
                ).fetchone())

            free_response = self.client.post(
                "/api/proxy-purchases/monthly-free",
                json={
                    "country": "US",
                    "city": "",
                    "period_months": 1,
                    "auto_renew": False,
                    "client_request_id": "monthly-free-before-paid",
                },
            )
            self.assertEqual(free_response.status_code, 200, free_response.text)
            self.assertEqual(free_response.json()["order"]["status"], "active")
            self.assertEqual(provider.execute_calls, 1)

            exhausted = self.client.post(
                "/api/proxy-purchases/monthly-free",
                json={
                    "country": "US",
                    "city": "",
                    "period_months": 1,
                    "auto_renew": False,
                    "client_request_id": "monthly-free-exhausted",
                },
            )
            self.assertEqual(exhausted.status_code, 409)

            quote_response = self.client.post(
                "/api/proxy-purchases/quotes",
                json={"country": "US", "city": "", "period_months": 1, "auto_renew": True},
            )
            self.assertEqual(quote_response.status_code, 200, quote_response.text)
            quote = quote_response.json()["quote"]
            paid_response = self.client.post(
                "/api/proxy-purchases/orders",
                headers={"Idempotency-Key": "paid-after-monthly-free"},
                json={"quote_id": quote["id"], "idempotency_key": "paid-after-monthly-free"},
            )
            self.assertEqual(paid_response.status_code, 200, paid_response.text)
            paid_order = paid_response.json()["order"]

        self.assertEqual(paid_order["status"], "active")
        self.assertTrue(paid_order["social_proxy_id"])
        self.assertEqual(provider.execute_calls, 2)
        with app_db.db() as conn:
            after = dict(conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                (self.user_id,),
            ).fetchone())
            reservations = conn.execute(
                "SELECT status,meta_json FROM billing_reservations WHERE ref_type='proxy_purchase' "
                "AND user_id=? ORDER BY created_at,id",
                (self.user_id,),
            ).fetchall()
        self.assertEqual(int(after["credit_units"]), int(before["credit_units"]) - int(quote["charge_units"]))
        self.assertEqual(
            int(after["cash_backed_credit_units"]),
            int(before["cash_backed_credit_units"]) - int(quote["charge_units"]),
        )
        self.assertCountEqual([str(row["status"]) for row in reservations], ["waived", "settled"])
        waived_reservation = next(row for row in reservations if str(row["status"]) == "waived")
        self.assertEqual(json.loads(str(waived_reservation["meta_json"]))["waived_reason"], "monthly_free_proxy")

    def test_idempotency_header_must_match_body(self):
        quote = self.client.post(
            "/api/proxy-purchases/quotes",
            json={"country": "US", "auto_renew": False},
        ).json()["quote"]
        response = self.client.post(
            "/api/proxy-purchases/orders",
            headers={"Idempotency-Key": "header-key"},
            json={"quote_id": quote["id"], "idempotency_key": "different-key"},
        )
        self.assertEqual(response.status_code, 409)

    def test_admin_purchase_passes_balance_waiver_only_at_order_creation(self):
        with mock.patch.object(
            proxy_purchases,
            "create_order",
            return_value={"id": "proxy-order-admin", "status": "active"},
        ) as create:
            response = self.client.post(
                "/api/proxy-purchases/orders",
                headers={
                    "X-Test-User-ID": str(self.admin_id),
                    "Idempotency-Key": "admin-buy-once",
                },
                json={"quote_id": "quote-admin", "idempotency_key": "admin-buy-once"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(create.call_args.kwargs["admin_waived"])

    def test_admin_provider_options_passes_selected_service_and_plan(self):
        with mock.patch.object(proxy_purchases, "provider_options", return_value={"services": [], "setup": {}}) as options:
            response = self.client.get(
                "/api/admin/proxy-purchases/provider-options",
                params={"service_id": "static-residential-ipv4", "plan_id": "plan-a"},
            )
        self.assertEqual(response.status_code, 200)
        options.assert_called_once()
        self.assertEqual(options.call_args.kwargs["service_id"], "static-residential-ipv4")
        self.assertEqual(options.call_args.kwargs["plan_id"], "plan-a")

    def test_admin_can_refresh_server_side_usd_twd_rate(self):
        quote = ExchangeRateQuote("USD", "TWD", Decimal("32.217"), "Frankfurter", 1_700_000_100, "2026-08-13")
        with mock.patch.object(proxy_purchases.exchange_rates, "get_usd_twd_rate", return_value=quote) as rate:
            response = self.client.get("/api/admin/proxy-purchases/exchange-rate", params={"refresh": "true"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["rate"], "32.217")
        self.assertEqual(response.json()["quote"], "TWD")
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        rate.assert_called_once_with(force_refresh=True)

    def test_admin_provider_credentials_are_encrypted_write_only_and_audited(self):
        with (
            mock.patch.object(proxy_provider_credentials.ProxyCheapProvider, "list_services", return_value={"services": []}),
            mock.patch.object(proxy_provider_credentials.ProxyCheapProvider, "get_setup", return_value={"countries": []}),
            mock.patch.object(proxy_provider_credentials.ProxyCheapProvider, "get_balance", return_value={"balance": "10"}),
        ):
            response = self.client.put(
                "/api/admin/proxy-purchases/provider-credentials",
                json={
                    "api_key": "test-api-key",
                    "api_secret": "test-api-secret",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["configured"])
        self.assertNotIn("api_key", payload)
        self.assertNotIn("api_secret", payload)
        with app_db.db() as conn:
            row = conn.execute(
                "SELECT owner_user_id,api_key_ciphertext,api_secret_ciphertext "
                "FROM proxy_provider_credential_versions "
                "WHERE provider_key='proxycheap' AND status='active'"
            ).fetchone()
            self.assertEqual(int(row["owner_user_id"]), self.admin_id)
            self.assertNotIn("test-api-key", str(row["api_key_ciphertext"]))
            self.assertNotIn("test-api-secret", str(row["api_secret_ciphertext"]))
            self.assertEqual(
                proxy_provider_credentials.load_credentials(conn),
                ("test-api-key", "test-api-secret"),
            )
        self.assertEqual(self.step_up_calls, [])
        self.assertEqual(
            self.audit_calls[-1]["action"], "proxy_purchase.provider_credentials_update"
        )
        self.assertEqual(self.audit_calls[-1]["reason"], "管理员更新供应商凭据")

    def test_admin_provider_credentials_rejects_client_owned_provider_currency_and_status(self):
        response = self.client.put(
            "/api/admin/proxy-purchases/provider-credentials",
            json={
                "provider": "proxycheap",
                "account_currency": "USD",
                "status": "active",
                "api_key": "test-api-key",
                "api_secret": "test-api-secret",
                "reason": "attempt field override",
                "admin_password": "test-password",
                "totp_code": "123456",
            },
        )
        self.assertEqual(response.status_code, 422)
        rejected = {str(item["loc"][-1]) for item in response.json()["detail"]}
        self.assertTrue(
            {"provider", "account_currency", "status", "admin_password", "totp_code"}.issubset(rejected)
        )
        self.assertEqual(self.step_up_calls, [])

    def test_admin_provider_connection_test_uses_server_selected_provider_and_product(self):
        verified = {
            "ok": True,
            "provider": "proxycheap",
            "saved_credentials_verified": False,
            "service_count": 1,
            "selected_plan_id": "standard",
            "balance": {"currency": "USD", "balance": "10"},
            "setup": {},
            "verified_at": 1_700_000_100,
        }
        with mock.patch.object(
            proxy_provider_credentials,
            "verify_credentials",
            return_value=verified,
        ) as verify:
            response = self.client.post(
                "/api/admin/proxy-purchases/provider-credentials/test",
                json={"api_key": "test-api-key", "api_secret": "test-api-secret"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(verify.call_args.kwargs["service_id"], "static-residential-ipv4")
        self.assertEqual(verify.call_args.kwargs["plan_id"], "standard")
        self.assertNotIn("provider", verify.call_args.kwargs)
        self.assertEqual(self.step_up_calls, [])

    def test_admin_provider_credential_status_never_returns_secret_material(self):
        response = self.client.get("/api/admin/proxy-purchases/provider-credentials")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        serialized = response.text.lower()
        self.assertNotIn("ciphertext", serialized)
        self.assertNotIn("test-api-secret", serialized)

    def test_admin_config_publish_no_longer_requires_password_or_mfa(self):
        draft = self.client.put(
            "/api/admin/proxy-purchases/config",
            json={
                "provider": "proxy-cheap",
                "service_id": "static-residential-ipv4",
                "plan_id": "standard",
                "default_country": "US",
                "default_period": 1,
                "quantity": 1,
                "setup_defaults": {"country": "US"},
                "points_per_usd": "25",
                "usd_to_ntd_rate": "35",
                "payment_fee_rate": "0.05",
                "fixed_fee_points": "0",
                "max_vendor_cost_usd": "100",
                "safety_buffer_usd": "0",
                "minimum_profit_usd": "0",
                "live_purchasing_enabled": True,
            },
        )
        self.assertEqual(draft.status_code, 200, draft.text)
        published = self.client.post("/api/admin/proxy-purchases/config/publish", json={})
        self.assertEqual(published.status_code, 200, published.text)
        self.assertEqual(published.json()["config"]["default_period"], 1)
        self.assertFalse(self.step_up_calls)

    def test_admin_resolution_requires_mfa_and_records_audit(self):
        missing = self.client.post(
            "/api/admin/proxy-purchases/orders/order-missing/resolve",
            json={"action": "confirm_not_created", "provider_order_id": "", "reason": "manual check"},
        )
        self.assertEqual(missing.status_code, 422)

        resolved = {"id": "order-test", "status": "released"}
        with mock.patch.object(proxy_purchases, "admin_resolve_order", return_value=resolved) as action:
            response = self.client.post(
                "/api/admin/proxy-purchases/orders/order-test/resolve",
                json={
                    "action": "confirm_not_created",
                    "provider_order_id": "",
                    "reason": "supplier confirms no order",
                    "admin_password": "test-password",
                    "totp_code": "123456",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["order"]["status"], "released")
        self.assertEqual(self.step_up_calls[-1], ("test-password", "123456"))
        self.assertEqual(action.call_args.kwargs["actor_user_id"], self.admin_id)
        audit = self.audit_calls[-1]
        self.assertEqual(audit["actor_user_id"], self.admin_id)
        self.assertEqual(audit["action"], "proxy_purchase.order_confirm_not_created")
        self.assertEqual(audit["resource_id"], "order-test")
        self.assertEqual(audit["reason"], "supplier confirms no order")
        self.assertEqual(audit["after"]["status"], "released")
        self.assertEqual(audit["outcome"], "success")

    def test_admin_can_confirm_supplier_refund_with_mfa_and_audit(self):
        resolved = {"id": "order-refunded", "status": "failed", "error_code": "PROVIDER_REFUND_CONFIRMED"}
        with mock.patch.object(proxy_purchases, "admin_resolve_order", return_value=resolved) as action:
            response = self.client.post(
                "/api/admin/proxy-purchases/orders/order-refunded/resolve",
                json={
                    "action": "confirm_provider_refunded",
                    "provider_order_id": "",
                    "reason": "supplier balance credit verified",
                    "admin_password": "test-password",
                    "totp_code": "123456",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(action.call_args.kwargs["action"], "confirm_provider_refunded")
        self.assertEqual(self.step_up_calls[-1], ("test-password", "123456"))
        self.assertEqual(
            self.audit_calls[-1]["action"],
            "proxy_purchase.order_confirm_provider_refunded",
        )

    def test_admin_bind_requires_provider_order_id(self):
        response = self.client.post(
            "/api/admin/proxy-purchases/orders/order-test/resolve",
            json={
                "action": "bind",
                "provider_order_id": "",
                "reason": "bind recovered order",
                "admin_password": "test-password",
                "totp_code": "123456",
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertFalse(self.step_up_calls)

    def test_admin_unknown_renewal_resolution_requires_mfa_and_audits(self):
        resolved = {"id": "order-test", "status": "active", "renewal_status": "scheduled"}
        with mock.patch.object(proxy_purchases, "admin_resolve_renewal", return_value=resolved, create=True) as action:
            response = self.client.post(
                "/api/admin/proxy-purchases/orders/order-test/renewal/resolve",
                json={
                    "action": "confirm_not_extended",
                    "reason": "supplier expiry did not advance",
                    "admin_password": "test-password",
                    "totp_code": "123456",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["order"]["renewal_status"], "scheduled")
        self.assertEqual(action.call_args.kwargs["action"], "confirm_not_extended")
        audit = self.audit_calls[-1]
        self.assertEqual(audit["action"], "proxy_purchase.renewal_confirm_not_extended")
        self.assertEqual(audit["actor_user_id"], self.admin_id)
        self.assertEqual(audit["resource_id"], "order-test")
        self.assertEqual(audit["outcome"], "success")

    def test_worker_jobs_have_separate_exception_boundaries(self):
        calls = []

        def fail(_conn, *, limit):
            calls.append(("webhook", limit))
            raise RuntimeError("bad webhook")

        def mark(name):
            return lambda _conn, *, limit: calls.append((name, limit))

        with self.assertLogs("webapp.proxy_purchase_api", level="ERROR") as logs:
            with (
                mock.patch.object(proxy_purchases, "process_webhook_events", side_effect=fail, create=True),
                mock.patch.object(proxy_purchases, "reconcile_due_orders", side_effect=mark("reconcile")),
                mock.patch.object(proxy_purchases, "sync_active_assets", side_effect=mark("active"), create=True),
                mock.patch.object(proxy_purchases, "process_due_renewals", side_effect=mark("renewals")),
            ):
                proxy_purchase_api._run_worker_cycle()

        self.assertIn("webhook-consume", "\n".join(logs.output))
        self.assertEqual(
            calls,
            [("webhook", 50), ("reconcile", 20), ("active", 20), ("renewals", 20)],
        )


if __name__ == "__main__":
    unittest.main()
