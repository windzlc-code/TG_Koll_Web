import os
import tempfile
import threading
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import commercial_billing, db as db_module, social_automation_api
import webapp.server as server


class RedemptionCodeClosedLoopTests(unittest.TestCase):
    def setUp(self):
        social_automation_api.stop_social_automation_worker(timeout_seconds=1)
        self.old_env = {
            key: os.environ.get(key)
            for key in (
                "APP_DB_PATH",
                "APP_RUNTIME_CONFIG_PATH",
                "WEBAPP_DATA_DIR",
                "ADMIN_BOOTSTRAP_PASSWORD",
                "SESSION_COOKIE_SECURE",
                "COMMERCIAL_BILLING_ENABLED",
                "PASSWORD_VAULT_KEY",
            )
        }
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.data_dir = Path(self.tmpdir.name)
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "redemption-admin-12345"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["COMMERCIAL_BILLING_ENABLED"] = "1"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        self.app = server.create_app()
        self.user_id = self._insert_customer("redeem_user")
        self.other_user_id = self._insert_customer("redeem_other")
        self.customer = self._login_customer("redeem_user")
        self.other_customer = self._login_customer("redeem_other")
        self.admin = TestClient(self.app)
        login = self.admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "redemption-admin-12345"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.admin.headers["X-Admin-Console"] = "1"

    def tearDown(self):
        self.customer.close()
        self.other_customer.close()
        self.admin.close()
        social_automation_api.stop_social_automation_worker(timeout_seconds=1)
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    def _insert_customer(self, username: str) -> int:
        now = server._now_ts()
        password = f"{username}-password-123"
        with db_module.db() as conn:
            inserted = conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, is_admin, is_disabled, balance_cents,
                  account_type, approval_status, created_at, updated_at
                ) VALUES (?, ?, 0, 0, 0, 'managed', 'approved', ?, ?)
                """,
                (username, server.hash_password(password), now, now),
            )
            user_id = int(inserted.lastrowid)
            conn.execute(
                """
                INSERT INTO billing_wallets(
                  user_id, credit_units, cash_backed_credit_units, billing_mode,
                  migrated_legacy_balance, created_at, updated_at
                ) VALUES (?, 0, 0, 'enforced', 0, ?, ?)
                """,
                (user_id, now, now),
            )
        return user_id

    def _login_customer(self, username: str) -> TestClient:
        client = TestClient(self.app)
        response = client.post(
            "/api/auth/user-login",
            json={"username": username, "password": f"{username}-password-123"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return client

    def _create_code(self, points: float = 25.5) -> str:
        response = self.admin.post(
            "/api/admin/billing/redemption-codes",
            json={"points": points, "quantity": 1, "note": "成员奖励"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["items"][0]["code"]

    def test_create_stores_only_digest_and_lists_masked_code(self):
        code = self._create_code()
        self.assertTrue(code.startswith("VCTO-"))
        with db_module.db() as conn:
            row = conn.execute("SELECT * FROM billing_redemption_codes").fetchone()
            self.assertIsNotNone(row)
            self.assertNotEqual(row["code_digest"], code)
            self.assertNotIn(code, str(dict(row)))
        listed = self.admin.get("/api/admin/billing/redemption-codes")
        self.assertEqual(listed.status_code, 200, listed.text)
        item = listed.json()["items"][0]
        self.assertNotIn("code", item)
        self.assertNotIn("code_digest", item)
        self.assertIn("••••", item["code_masked"])
        self.assertEqual(listed.headers.get("cache-control"), "no-store")

    def test_redeem_is_atomic_one_time_and_not_cash_backed(self):
        code = self._create_code(25.5)
        first = self.customer.post(
            "/api/billing/redemption-codes/redeem",
            json={"code": f"  {code.lower()}  "},
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["redeemed_points"], 25.5)
        self.assertEqual(first.json()["points"], 25.5)
        self.assertFalse(first.json()["already_redeemed"])

        retry = self.customer.post(
            "/api/billing/redemption-codes/redeem",
            json={"code": code},
        )
        self.assertEqual(retry.status_code, 409, retry.text)
        self.assertIn("失效", retry.text)

        with db_module.db() as conn:
            wallet = conn.execute(
                "SELECT * FROM billing_wallets WHERE user_id = ?", (self.user_id,)
            ).fetchone()
            self.assertEqual(wallet["credit_units"], 2550)
            self.assertEqual(wallet["cash_backed_credit_units"], 0)
            ledger = conn.execute(
                "SELECT * FROM billing_ledger WHERE event_type = 'redemption_code_redeemed'"
            ).fetchall()
            self.assertEqual(len(ledger), 1)
            self.assertEqual(ledger[0]["amount_units"], 2550)
            self.assertEqual(ledger[0]["user_id"], self.user_id)

        conflict = self.other_customer.post(
            "/api/billing/redemption-codes/redeem", json={"code": code}
        )
        self.assertEqual(conflict.status_code, 409, conflict.text)
        with db_module.db() as conn:
            other_wallet = conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                (self.other_user_id,),
            ).fetchone()
            self.assertEqual(other_wallet["credit_units"], 0)

    def test_revoke_and_health_and_access_boundaries(self):
        code = self._create_code()
        listed = self.admin.get("/api/admin/billing/redemption-codes")
        code_id = listed.json()["items"][0]["id"]
        forbidden = self.customer.get("/api/admin/billing/redemption-codes")
        self.assertIn(forbidden.status_code, {401, 403}, forbidden.text)
        revoked = self.admin.post(
            f"/api/admin/billing/redemption-codes/{code_id}/revoke",
            json={"reason": "测试作废"},
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        failed = self.customer.post(
            "/api/billing/redemption-codes/redeem", json={"code": code}
        )
        self.assertEqual(failed.status_code, 409, failed.text)
        health = self.admin.get("/api/admin/billing/redemption-codes/health")
        self.assertEqual(health.status_code, 200, health.text)
        self.assertTrue(health.json()["ok"])
        self.assertEqual(health.json()["counts"]["revoked"], 1)

    def test_admin_can_reveal_copy_source_and_hide_code_records_without_reuse(self):
        codes = [self._create_code(points) for points in (11, 12, 13)]
        first_page = self.admin.get(
            "/api/admin/billing/redemption-codes?limit=2&offset=0"
        )
        self.assertEqual(first_page.status_code, 200, first_page.text)
        self.assertEqual(first_page.json()["total"], 3)
        self.assertEqual(len(first_page.json()["items"]), 2)
        self.assertEqual(first_page.json()["next_offset"], 2)
        second_page = self.admin.get(
            "/api/admin/billing/redemption-codes?limit=2&offset=2"
        )
        self.assertEqual(len(second_page.json()["items"]), 1)
        code_id = first_page.json()["items"][0]["id"]

        revealed = self.admin.post(
            f"/api/admin/billing/redemption-codes/{code_id}/reveal"
        )
        self.assertEqual(revealed.status_code, 200, revealed.text)
        self.assertIn(revealed.json()["item"]["code"], codes)
        self.assertEqual(revealed.headers.get("cache-control"), "no-store")

        removed = self.admin.post(
            f"/api/admin/billing/redemption-codes/{code_id}/delete"
        )
        self.assertEqual(removed.status_code, 200, removed.text)
        after_delete = self.admin.get("/api/admin/billing/redemption-codes?limit=10")
        self.assertEqual(after_delete.json()["total"], 2)
        self.assertNotIn(code_id, [item["id"] for item in after_delete.json()["items"]])
        redeem_deleted = self.customer.post(
            "/api/billing/redemption-codes/redeem",
            json={"code": revealed.json()["item"]["code"]},
        )
        self.assertEqual(redeem_deleted.status_code, 409, redeem_deleted.text)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT deleted_at, code_digest FROM billing_redemption_codes WHERE id = ?",
                (code_id,),
            ).fetchone()
        self.assertGreater(int(row["deleted_at"]), 0)
        self.assertNotEqual(str(row["code_digest"]), revealed.json()["item"]["code"])

    def test_health_accepts_anonymized_redeemed_receipt_after_user_purge(self):
        code = self._create_code(8)
        redeemed = self.customer.post(
            "/api/billing/redemption-codes/redeem", json={"code": code}
        )
        self.assertEqual(redeemed.status_code, 200, redeemed.text)
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_redemption_codes SET redeemed_by = 0 WHERE code_digest = ?",
                (commercial_billing._redemption_code_digest(code),),
            )
            conn.execute(
                "UPDATE billing_ledger SET user_id = 0 WHERE ref_type = 'redemption_code' AND event_type = 'redemption_code_redeemed'"
            )
            health = commercial_billing.redemption_code_health(conn)
        self.assertTrue(health["ok"], health)
        self.assertEqual(health["inconsistent"], 0)

    def test_concurrent_redeem_credits_exactly_one_wallet(self):
        code = self._create_code(12)
        barrier = threading.Barrier(2)
        outcomes = []
        lock = threading.Lock()

        def redeem(user_id):
            barrier.wait()
            try:
                with db_module.db() as conn:
                    commercial_billing.redeem_redemption_code(
                        conn, user_id=user_id, raw_code=code
                    )
                outcome = "ok"
            except commercial_billing.BillingError as exc:
                outcome = exc.code
            with lock:
                outcomes.append(outcome)

        threads = [
            threading.Thread(target=redeem, args=(self.user_id,)),
            threading.Thread(target=redeem, args=(self.other_user_id,)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive())

        self.assertEqual(outcomes.count("ok"), 1)
        self.assertEqual(outcomes.count("REDEMPTION_CODE_INVALID"), 1)
        with db_module.db() as conn:
            balances = conn.execute(
                "SELECT SUM(credit_units) AS total FROM billing_wallets WHERE user_id IN (?, ?)",
                (self.user_id, self.other_user_id),
            ).fetchone()
            self.assertEqual(balances["total"], 1200)
            ledger_count = conn.execute(
                "SELECT COUNT(*) AS count FROM billing_ledger WHERE event_type = 'redemption_code_redeemed'"
            ).fetchone()
            self.assertEqual(ledger_count["count"], 1)


if __name__ == "__main__":
    unittest.main()
