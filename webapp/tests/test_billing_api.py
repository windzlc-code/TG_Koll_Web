import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from webapp import db as db_module
import webapp.server as server


class BillingApiClosedLoopTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {
            key: os.environ.get(key)
            for key in (
                "APP_DB_PATH",
                "APP_RUNTIME_CONFIG_PATH",
                "WEBAPP_DATA_DIR",
                "ADMIN_BOOTSTRAP_PASSWORD",
                "SESSION_COOKIE_SECURE",
                "COMMERCIAL_BILLING_ENABLED",
            )
        }
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.data_dir = Path(self.tmpdir.name)
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "billing-admin-12345"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["COMMERCIAL_BILLING_ENABLED"] = "1"
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        self.app = server.create_app()
        now = server._now_ts()
        with db_module.db() as conn:
            inserted = conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, is_admin, is_disabled, balance_cents,
                  account_type, approval_status, created_at, updated_at
                ) VALUES ('billing_user', ?, 0, 0, 0, 'managed', 'approved', ?, ?)
                """,
                (server.hash_password("billing-user-123"), now, now),
            )
            self.user_id = int(inserted.lastrowid)
            conn.execute(
                "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, 0, 'enforced', 0, ?, ?)",
                (self.user_id, now, now),
            )
        self.customer = TestClient(self.app)
        self.admin = TestClient(self.app)
        customer_login = self.customer.post(
            "/api/auth/user-login",
            json={"username": "billing_user", "password": "billing-user-123"},
        )
        admin_login = self.admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "billing-admin-12345"},
        )
        self.assertEqual(customer_login.status_code, 200, customer_login.text)
        self.assertEqual(admin_login.status_code, 200, admin_login.text)

    def tearDown(self):
        self.customer.close()
        self.admin.close()
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    def test_offline_order_approval_wallet_and_subscription_are_visible(self):
        catalog = self.customer.get("/api/billing/catalog")
        self.assertEqual(catalog.status_code, 200, catalog.text)
        self.assertEqual(catalog.json()["subscription"]["price_ntd"], 6000)

        blocked_write = self.customer.post("/api/tasks/get_gemini", data={"user_input": "billing gate"})
        self.assertEqual(blocked_write.status_code, 402, blocked_write.text)
        self.assertEqual(blocked_write.json()["code"], "SUBSCRIPTION_REQUIRED")

        body = {
            "sku": "credits_100",
            "quantity": 1,
            "payer_name": "Billing QA",
            "payment_reference": "BANK-12345",
            "paid_at": 1_789_430_400,
            "proof_path": "https://example.invalid/receipt/BANK-12345",
            "note": "QA receipt snapshot",
            "idempotency_key": "billing-api-order-0001",
        }
        created = self.customer.post("/api/billing/orders", json=body)
        duplicate = self.customer.post("/api/billing/orders", json=body)
        conflict = self.customer.post(
            "/api/billing/orders",
            json={**body, "payer_name": "Different payer"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(duplicate.status_code, 200, duplicate.text)
        self.assertEqual(conflict.status_code, 409, conflict.text)
        order_id = created.json()["order"]["id"]
        self.assertEqual(duplicate.json()["order"]["id"], order_id)
        self.assertEqual(created.json()["order"]["proof_path"], body["proof_path"])
        self.assertEqual(created.json()["order"]["paid_at"], body["paid_at"])

        approved = self.admin.post(
            f"/api/admin/billing/orders/{order_id}/approve",
            json={"note": "线下付款已核验"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["order"]["status"], "approved")

        subscription = self.admin.post(
            f"/api/admin/users/{self.user_id}/billing/subscriptions",
            json={"quantity": 1, "renewal_subscription_ids": [], "note": "测试人工开通"},
        )
        self.assertEqual(subscription.status_code, 200, subscription.text)

        summary = self.customer.get("/api/billing/summary")
        ledger = self.customer.get("/api/billing/ledger")
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(summary.json()["points"], 100)
        self.assertTrue(summary.json()["subscription_active"])
        self.assertEqual(summary.json()["threads_account_limit"], 3)
        self.assertEqual(summary.json()["free_images"]["monthly_remaining"], 10)
        self.assertTrue(any(item["event_type"] == "credit_pack_approved" for item in ledger.json()["items"]))

        recharged = self.admin.post(
            f"/api/admin/users/{self.user_id}/recharge",
            json={"amount_cents": 5, "note": "billing api regression"},
        )
        self.assertEqual(recharged.status_code, 200, recharged.text)
        self.assertEqual(recharged.json()["points"], 105)
        self.assertNotIn("balance_cents", recharged.json())

        archived = self.admin.delete(f"/api/admin/users/{self.user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)
        purged = self.admin.delete(
            f"/api/admin/users/{self.user_id}/purge",
            params={"confirm_username": "billing_user"},
        )
        self.assertEqual(purged.status_code, 200, purged.text)
        self.assertTrue(purged.json()["ok"], purged.text)
        with db_module.db() as conn:
            for table in (
                "billing_ledger",
                "billing_reservations",
                "billing_image_grants",
                "billing_subscription_periods",
                "billing_subscriptions",
                "billing_orders",
                "billing_wallets",
            ):
                count = conn.execute(
                    f"SELECT COUNT(*) AS count FROM {table} WHERE user_id = ?",
                    (self.user_id,),
                ).fetchone()["count"]
                self.assertEqual(count, 0, table)

    def test_public_pricing_is_independent_from_console_billing(self):
        with TestClient(self.app) as anonymous:
            pricing = anonymous.get("/pricing.html")
        console = self.customer.get("/console.html?view=billing")

        self.assertEqual(pricing.status_code, 200, pricing.text)
        self.assertIn('id="pricingSubscription"', pricing.text)
        self.assertIn('/assets/opc/pricing.js', pricing.text)
        self.assertEqual(console.status_code, 200, console.text)
        self.assertIn('href="/pricing.html"', console.text)
        self.assertNotIn('id="billingCatalog"', console.text)


if __name__ == "__main__":
    unittest.main()
