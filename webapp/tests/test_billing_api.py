import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module, governance, social_automation_api
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
                "PASSWORD_VAULT_KEY",
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
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
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
        self.admin.headers["X-Admin-Console"] = "1"

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

    def _create_customer(self, username: str) -> tuple[int, TestClient]:
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
                "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, 0, 'enforced', 0, ?, ?)",
                (user_id, now, now),
            )
        client = TestClient(self.app)
        login = client.post(
            "/api/auth/user-login",
            json={"username": username, "password": password},
        )
        self.assertEqual(login.status_code, 200, login.text)
        return user_id, client

    def test_admin_can_toggle_unlimited_compute_from_both_adjustment_endpoints(self):
        enabled = self.admin.post(
            f"/api/admin/users/{self.user_id}/billing/adjustments",
            json={
                "delta_points": 0,
                "unlimited": True,
                "reason": "enterprise unlimited account",
            },
        )
        self.assertEqual(enabled.status_code, 200, enabled.text)
        self.assertTrue(enabled.json()["unlimited_compute"])

        summary = self.customer.get("/api/billing/summary")
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertTrue(summary.json()["unlimited_compute"])

        disabled = self.admin.post(
            f"/api/admin/users/{self.user_id}/recharge",
            json={
                "amount_cents": 0,
                "unlimited": False,
                "note": "restore metered billing",
            },
        )
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertFalse(disabled.json()["unlimited_compute"])

        with db_module.db() as conn:
            events = conn.execute(
                """
                SELECT event_type
                FROM billing_ledger
                WHERE user_id = ? AND event_type IN ('unlimited_compute_enabled', 'unlimited_compute_disabled')
                ORDER BY created_at ASC
                """,
                (self.user_id,),
            ).fetchall()
        self.assertEqual(
            {str(row["event_type"]) for row in events},
            {"unlimited_compute_enabled", "unlimited_compute_disabled"},
        )

    def test_admin_summary_reports_effective_waiver_without_overriding_customer_workspace_wallet(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET credit_units = ?, unlimited_compute = 0 WHERE user_id = ?",
                (321 * server.commercial_billing.POINT_SCALE, self.user_id),
            )

        admin_summary = self.admin.get("/api/billing/summary")
        self.assertEqual(admin_summary.status_code, 200, admin_summary.text)
        self.assertFalse(admin_summary.json()["unlimited_compute"])
        self.assertTrue(admin_summary.json()["admin_waived"])
        self.assertTrue(admin_summary.json()["effective_unlimited"])

        workspace_summary = self.admin.get(
            "/api/billing/summary",
            headers={"X-Admin-Workspace-User-ID": str(self.user_id)},
        )
        self.assertEqual(workspace_summary.status_code, 200, workspace_summary.text)
        self.assertEqual(workspace_summary.json()["points"], 321)
        self.assertFalse(workspace_summary.json()["unlimited_compute"])
        self.assertFalse(workspace_summary.json()["admin_waived"])
        self.assertFalse(workspace_summary.json()["effective_unlimited"])

    def test_admin_billing_mutations_invalidate_dashboard_cache(self):
        mutations = (
            (
                f"/api/admin/users/{self.user_id}/recharge",
                {"amount_cents": 1, "note": "recharge cache invalidation"},
            ),
            (
                f"/api/admin/users/{self.user_id}/billing/adjustments",
                {"delta_points": 1, "reason": "adjustment cache invalidation"},
            ),
            (
                f"/api/admin/users/{self.user_id}/billing/adjustments",
                {"unlimited": True, "reason": "unlimited cache invalidation"},
            ),
        )
        for index, (path, payload) in enumerate(mutations):
            with self.subTest(path=path, payload=payload):
                with server._ADMIN_DASHBOARD_CACHE_LOCK:
                    server._ADMIN_DASHBOARD_CACHE[f"sentinel-{index}"] = (
                        0.0,
                        {"summary": {"wallet_points": -1}},
                    )
                response = self.admin.post(path, json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                with server._ADMIN_DASHBOARD_CACHE_LOCK:
                    self.assertEqual(server._ADMIN_DASHBOARD_CACHE, {})

    def test_all_available_task_types_map_to_published_billing_skus(self):
        self.assertEqual(server._normal_task_billing_spec("get_gemini", {}), ("basic_text_post", 1, False))
        self.assertEqual(
            server._normal_task_billing_spec("video_i2v", {"resolution": "720p", "duration_seconds": 6}),
            ("ad_video_720p_second", 6, False),
        )
        self.assertEqual(
            server._normal_task_billing_spec("video_i2v", {"resolution": "1080p", "duration_seconds": 15}),
            ("ad_video_1080p_second", 15, False),
        )
        self.assertEqual(social_automation_api.social_task_billing_sku("threads", "publish_post"), "threads_text_publish")
        self.assertEqual(social_automation_api.social_task_billing_sku("instagram", "publish_post"), "instagram_publish")
        self.assertEqual(social_automation_api.social_task_billing_sku("threads", "threads_auto_reply"), "threads_auto_reply_batch")
        self.assertEqual(social_automation_api.social_task_billing_sku("instagram", "like_post"), "social_interaction")

    def test_user_facing_ai_operation_deducts_catalog_price(self):
        subscription = self.admin.post(
            f"/api/admin/users/{self.user_id}/billing/subscriptions",
            json={"quantity": 1, "renewal_subscription_ids": [], "note": "billing deduction test"},
        )
        self.assertEqual(subscription.status_code, 200, subscription.text)
        credit = self.admin.post(
            f"/api/admin/users/{self.user_id}/billing/adjustments",
            json={"delta_points": 1, "reason": "billing deduction test"},
        )
        self.assertEqual(credit.status_code, 200, credit.text)

        before = self.customer.get("/api/billing/summary").json()
        with mock.patch.object(
            server,
            "_run_persona_create_cli",
            return_value={"keywords": ["one", "two", "three", "four", "five"]},
        ):
            response = self.customer.post(
                "/api/persona_dashboard/personas/ai_keywords",
                json={"name": "Billing Persona", "prompt": "Create relevant keywords"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["billing"]["status"], "settled")
        self.assertEqual(response.json()["billing"]["charged_points"], 0.3)

        after = self.customer.get("/api/billing/summary").json()
        self.assertEqual(before["points"], 1)
        self.assertEqual(after["points"], 0.7)

    def test_online_application_stays_pending_until_admin_approval(self):
        catalog = self.customer.get("/api/billing/catalog")
        self.assertEqual(catalog.status_code, 200, catalog.text)
        self.assertEqual(catalog.json()["subscription"]["price_ntd"], 6000)

        blocked_write = self.customer.post("/api/tasks/get_gemini", data={"user_input": "billing gate"})
        self.assertEqual(blocked_write.status_code, 402, blocked_write.text)
        self.assertEqual(blocked_write.json()["code"], "SUBSCRIPTION_REQUIRED")

        body = {
            "sku": "credits_100",
            "quantity": 1,
            "note": "线上方案申请",
            "idempotency_key": "billing-api-order-0001",
        }
        created = self.customer.post("/api/billing/orders", json=body)
        duplicate = self.customer.post("/api/billing/orders", json=body)
        conflict = self.customer.post(
            "/api/billing/orders",
            json={**body, "note": "different application"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(duplicate.status_code, 200, duplicate.text)
        self.assertEqual(conflict.status_code, 409, conflict.text)
        order_id = created.json()["order"]["id"]
        self.assertEqual(duplicate.json()["order"]["id"], order_id)
        self.assertEqual(created.json()["order"]["status"], "pending")
        self.assertEqual(created.json()["order"]["payer_name"], "")
        self.assertEqual(created.json()["order"]["payment_reference"], "")

        customer_orders = self.customer.get("/api/billing/orders")
        self.assertEqual(customer_orders.status_code, 200, customer_orders.text)
        self.assertEqual(customer_orders.json()["pending_count"], 1)

        before_approval = self.customer.get("/api/billing/summary")
        pending_orders = self.admin.get("/api/admin/billing/orders?status=pending")
        self.assertEqual(before_approval.status_code, 200, before_approval.text)
        self.assertEqual(before_approval.json()["points"], 0)
        self.assertEqual(pending_orders.status_code, 200, pending_orders.text)
        pending_payload = pending_orders.json()
        pending_order = next(item for item in pending_payload["items"] if item["id"] == order_id)
        self.assertEqual(pending_order["username"], "billing_user")
        self.assertEqual(pending_payload["pending_count"], 1)

        approved = self.admin.post(
            f"/api/admin/billing/orders/{order_id}/approve",
            json={"note": "线上方案申请已批准"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["order"]["status"], "approved")

        customer_orders = self.customer.get("/api/billing/orders")
        admin_orders = self.admin.get("/api/admin/billing/orders?status=pending")
        self.assertEqual(customer_orders.status_code, 200, customer_orders.text)
        self.assertEqual(customer_orders.json()["pending_count"], 0)
        self.assertEqual(admin_orders.status_code, 200, admin_orders.text)
        self.assertEqual(admin_orders.json()["global_pending_count"], 0)
        self.assertEqual(admin_orders.json()["pending_count"], 0)

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
        setup = self.admin.post(
            "/api/auth/mfa/setup",
            headers={"Origin": "http://testserver"},
            json={"current_password": "billing-admin-12345"},
        )
        self.assertEqual(setup.status_code, 200, setup.text)
        secret = str(setup.json()["secret"])
        verified = self.admin.post(
            "/api/auth/mfa/verify-setup",
            headers={"Origin": "http://testserver"},
            json={"code": governance.totp_code(secret)},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        purged = self.admin.request(
            "DELETE",
            f"/api/admin/users/{self.user_id}/purge",
            headers={"Origin": "http://testserver"},
            json={
                "confirm_username": "billing_user",
                "admin_password": "billing-admin-12345",
                "totp_code": governance.totp_code(secret),
                "reason": "billing cleanup regression",
            },
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

    def test_admin_order_filters_usernames_and_paginates_with_global_pending_count(self):
        second_user_id, second_customer = self._create_customer("billing_second")
        try:
            first_ids = []
            second_ids = []
            for index in range(2):
                created = self.customer.post(
                    "/api/billing/orders",
                    json={
                        "sku": "credits_100",
                        "quantity": 1,
                        "note": f"first user {index}",
                        "idempotency_key": f"first-user-order-{index}",
                    },
                )
                self.assertEqual(created.status_code, 200, created.text)
                first_ids.append(created.json()["order"]["id"])
            for index in range(2):
                created = second_customer.post(
                    "/api/billing/orders",
                    json={
                        "sku": "credits_100",
                        "quantity": 1,
                        "note": f"second user {index}",
                        "idempotency_key": f"second-user-order-{index}",
                    },
                )
                self.assertEqual(created.status_code, 200, created.text)
                second_ids.append(created.json()["order"]["id"])

            approved = self.admin.post(
                f"/api/admin/billing/orders/{first_ids[0]}/approve",
                json={"note": "approved for pagination test"},
            )
            rejected = self.admin.post(
                f"/api/admin/billing/orders/{second_ids[0]}/reject",
                json={"note": "rejected for pagination test"},
            )
            self.assertEqual(approved.status_code, 200, approved.text)
            self.assertEqual(rejected.status_code, 200, rejected.text)

            first_page = self.admin.get("/api/admin/billing/orders?status=pending&limit=1&offset=0")
            self.assertEqual(first_page.status_code, 200, first_page.text)
            first_payload = first_page.json()
            self.assertEqual(first_payload["global_pending_count"], 2)
            self.assertEqual(first_payload["pending_count"], 2)
            self.assertEqual(first_payload["total"], 2)
            self.assertEqual(first_payload["limit"], 1)
            self.assertEqual(first_payload["offset"], 0)
            self.assertTrue(first_payload["has_more"])
            self.assertEqual(first_payload["next_offset"], 1)
            self.assertEqual(len(first_payload["items"]), 1)

            second_page = self.admin.get(
                f"/api/admin/billing/orders?status=pending&limit=1&offset={first_payload['next_offset']}"
            )
            self.assertEqual(second_page.status_code, 200, second_page.text)
            second_payload = second_page.json()
            self.assertEqual(second_payload["global_pending_count"], 2)
            self.assertEqual(second_payload["total"], 2)
            self.assertFalse(second_payload["has_more"])
            self.assertIsNone(second_payload["next_offset"])
            self.assertEqual(len(second_payload["items"]), 1)
            self.assertNotEqual(first_payload["items"][0]["id"], second_payload["items"][0]["id"])
            self.assertEqual(
                {first_payload["items"][0]["username"], second_payload["items"][0]["username"]},
                {"billing_user", "billing_second"},
            )

            filtered = self.admin.get(
                f"/api/admin/billing/orders?status=pending&user_id={second_user_id}&limit=10&offset=0"
            )
            self.assertEqual(filtered.status_code, 200, filtered.text)
            filtered_payload = filtered.json()
            self.assertEqual(filtered_payload["global_pending_count"], 2)
            self.assertEqual(filtered_payload["total"], 1)
            self.assertEqual([item["id"] for item in filtered_payload["items"]], [second_ids[1]])
            self.assertEqual(filtered_payload["items"][0]["username"], "billing_second")

            approved_filter = self.admin.get(
                f"/api/admin/billing/orders?status=approved&user_id={self.user_id}&limit=10&offset=0"
            )
            self.assertEqual(approved_filter.status_code, 200, approved_filter.text)
            approved_payload = approved_filter.json()
            self.assertEqual(approved_payload["total"], 1)
            self.assertEqual(approved_payload["items"][0]["id"], first_ids[0])
            self.assertEqual(approved_payload["items"][0]["username"], "billing_user")
        finally:
            second_customer.close()

    def test_admin_order_permissions_and_rejection_state_transitions(self):
        created = self.customer.post(
            "/api/billing/orders",
            json={
                "sku": "credits_100",
                "quantity": 1,
                "note": "reject this application",
                "idempotency_key": "reject-order-permission-test",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        order_id = created.json()["order"]["id"]

        with TestClient(self.app) as anonymous:
            anonymous_list = anonymous.get("/api/admin/billing/orders")
            anonymous_approve = anonymous.post(
                f"/api/admin/billing/orders/{order_id}/approve",
                json={"note": "must not approve"},
            )
            anonymous_reject = anonymous.post(
                f"/api/admin/billing/orders/{order_id}/reject",
                json={"note": "must not reject"},
            )
        self.assertEqual(anonymous_list.status_code, 401, anonymous_list.text)
        self.assertEqual(anonymous_approve.status_code, 401, anonymous_approve.text)
        self.assertEqual(anonymous_reject.status_code, 401, anonymous_reject.text)

        customer_list = self.customer.get("/api/admin/billing/orders")
        customer_approve = self.customer.post(
            f"/api/admin/billing/orders/{order_id}/approve",
            json={"note": "must not approve"},
        )
        customer_reject = self.customer.post(
            f"/api/admin/billing/orders/{order_id}/reject",
            json={"note": "must not reject"},
        )
        self.assertEqual(customer_list.status_code, 401, customer_list.text)
        self.assertEqual(customer_approve.status_code, 401, customer_approve.text)
        self.assertEqual(customer_reject.status_code, 401, customer_reject.text)

        rejected = self.admin.post(
            f"/api/admin/billing/orders/{order_id}/reject",
            json={"note": "not eligible"},
        )
        repeated = self.admin.post(
            f"/api/admin/billing/orders/{order_id}/reject",
            json={"note": "repeated rejection"},
        )
        approve_rejected = self.admin.post(
            f"/api/admin/billing/orders/{order_id}/approve",
            json={"note": "too late"},
        )
        self.assertEqual(rejected.status_code, 200, rejected.text)
        self.assertEqual(rejected.json()["order"]["status"], "rejected")
        self.assertEqual(rejected.json()["order"]["review_note"], "not eligible")
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["order"]["status"], "rejected")
        self.assertEqual(repeated.json()["order"]["review_note"], "not eligible")
        self.assertEqual(approve_rejected.status_code, 409, approve_rejected.text)

        customer_orders = self.customer.get("/api/billing/orders")
        admin_orders = self.admin.get("/api/admin/billing/orders?status=rejected")
        self.assertEqual(customer_orders.status_code, 200, customer_orders.text)
        self.assertEqual(customer_orders.json()["pending_count"], 0)
        self.assertEqual(admin_orders.status_code, 200, admin_orders.text)
        self.assertEqual(admin_orders.json()["global_pending_count"], 0)
        self.assertEqual(admin_orders.json()["pending_count"], 0)
        self.assertEqual(admin_orders.json()["items"][0]["id"], order_id)

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

    def test_pricing_uses_online_application_copy_without_offline_payment_form(self):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        pricing = (static_dir / "pricing.html").read_text(encoding="utf-8")
        pricing_script = (static_dir / "assets" / "opc" / "pricing.js").read_text(encoding="utf-8")
        admin = (static_dir / "admin.html").read_text(encoding="utf-8")
        console = (static_dir / "console.html").read_text(encoding="utf-8")
        console_script = (static_dir / "assets" / "console.js").read_text(encoding="utf-8")

        self.assertIn("線上方案申請", pricing)
        self.assertIn("管理員批准後才會生效", pricing)
        self.assertIn("提交申請", pricing)
        self.assertNotIn("線下付款申請", pricing)
        for field_name in ("payer_name", "payment_reference", "paid_at", "proof_path"):
            self.assertNotIn(f'name="{field_name}"', pricing)
            self.assertNotIn(f"form.elements.{field_name}", pricing_script)

        self.assertIn("申請已提交，等待管理員批准", pricing_script)
        self.assertNotIn("付款申請", pricing_script)
        self.assertIn("审核线上方案申请", admin)
        self.assertNotIn("審核線下付款訂單", admin)
        self.assertIn("方案申请记录", console)
        self.assertIn("等待管理员审批", console_script)
        self.assertNotIn("线下付款", console)
        self.assertNotIn("线下付款", console_script)


if __name__ == "__main__":
    unittest.main()
