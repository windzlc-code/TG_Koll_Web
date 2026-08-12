from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient

from webapp import commercial_billing
from webapp import db as app_db
from webapp import proxy_purchases
from webapp import proxy_purchase_api
from webapp.proxy_purchase_api import register_proxy_purchase_routes


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
            return {"id": int(x_test_user_id), "is_admin": 0}

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
