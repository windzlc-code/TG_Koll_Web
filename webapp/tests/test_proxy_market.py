import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import webapp.server as server
from webapp import social_automation_api
from webapp.db import db


class ProxyMarketTests(unittest.TestCase):
    ENV_KEYS = (
        "APP_DB_PATH",
        "APP_RUNTIME_CONFIG_PATH",
        "WEBAPP_DATA_DIR",
        "TOOL_R18_RUNTIME_DIR",
        "ADMIN_BOOTSTRAP_PASSWORD",
        "SESSION_COOKIE_SECURE",
        "ALLOW_PUBLIC_REGISTER",
        "PASSWORD_VAULT_KEY",
        "PASSWORD_VAULT_KEY_FILE",
        "COMMERCIAL_BILLING_ENABLED",
    )
    ADMIN_PASSWORD = "proxy-market-admin-secret"
    CUSTOMER_PASSWORD = "customer123"

    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.old_sentiment_config_path = server.SENTIMENT_CONFIG_PATH
        self.old_tool_upload_root = server.TOOL_R18_UPLOAD_ROOT
        self.old_tool_runtime_dir = server.TOOL_R18_RUNTIME_DIR
        self.old_data_dir = server.DATA_DIR
        self.old_upload_root = server.UPLOAD_ROOT
        self.old_output_root = server.OUTPUT_ROOT
        self.old_social_data_dir = social_automation_api._DATA_DIR

        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.data_dir = Path(self.tmpdir.name)
        self.tool_runtime_dir = self.data_dir / "tool_r18_runtime"
        self.tool_runtime_dir.mkdir(parents=True, exist_ok=True)

        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["TOOL_R18_RUNTIME_DIR"] = str(self.tool_runtime_dir)
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = self.ADMIN_PASSWORD
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["ALLOW_PUBLIC_REGISTER"] = "1"
        os.environ["COMMERCIAL_BILLING_ENABLED"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)

        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        server.SENTIMENT_CONFIG_PATH = self.data_dir / "sentiment-config.json"
        server.SENTIMENT_CONFIG_PATH.write_text("{}", encoding="utf-8")
        server.DATA_DIR = self.data_dir
        server.UPLOAD_ROOT = self.data_dir / "uploads"
        server.OUTPUT_ROOT = self.data_dir / "outputs"
        server.TOOL_R18_UPLOAD_ROOT = self.data_dir / "tool_r18_uploads"
        server.TOOL_R18_UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
        server.TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        social_automation_api.configure_social_automation(data_dir=self.data_dir)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()

        self.app = server.create_app()
        self.admin = TestClient(self.app)
        login = self.admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.admin.headers["X-Admin-Console"] = "1"
        self.origin = {"Origin": "http://testserver"}

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        server.SENTIMENT_CONFIG_PATH = self.old_sentiment_config_path
        server.TOOL_R18_UPLOAD_ROOT = self.old_tool_upload_root
        server.TOOL_R18_RUNTIME_DIR = self.old_tool_runtime_dir
        server.DATA_DIR = self.old_data_dir
        server.UPLOAD_ROOT = self.old_upload_root
        server.OUTPUT_ROOT = self.old_output_root
        social_automation_api.configure_social_automation(data_dir=self.old_social_data_dir)
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    def _customer(self, username: str) -> tuple[TestClient, int]:
        applicant = TestClient(self.app)
        applied = applicant.post(
            "/api/auth/apply",
            json={
                "username": username,
                "password": self.CUSTOMER_PASSWORD,
                "full_name": f"{username} customer",
                "email": f"{username}@example.com",
                "phone": "0912345678",
                "company": "Proxy Market QA",
                "use_case": "Proxy allocation",
            },
        )
        self.assertEqual(applied.status_code, 200, applied.text)
        user_id = int(applied.json()["id"])
        approved = self.admin.post(
            f"/api/admin/users/{user_id}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
            headers=self.origin,
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        client = TestClient(self.app)
        login = client.post(
            "/api/auth/user-login",
            json={"username": username, "password": self.CUSTOMER_PASSWORD},
        )
        self.assertEqual(login.status_code, 200, login.text)
        return client, user_id

    def _market_item(self, sku: str = "TW-TPE-001") -> dict:
        created = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": sku,
                "display_name": "台北静态住宅 IP",
                "provider_key": "qa-provider",
                "proxy_type": "socks5",
                "host": "203.0.113.10",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
                "country": "台湾",
                "region": "台北",
                "city": "台北",
                "isp": "QA ISP",
                "tags": ["住宅", "稳定"],
                "use_cases": ["Threads"],
                "display_price_cents": 99000,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]
        now = int(time.time())
        with db() as conn:
            conn.execute(
                """
                UPDATE proxy_market_items
                SET status = 'active', health_status = 'healthy',
                    last_check_at = ?, published_at = ?, last_check_result_json = '{}'
                WHERE id = ?
                """,
                (now, now, item["id"]),
            )
        return item

    def test_public_catalog_masks_connection_credentials(self):
        self._market_item()
        response = TestClient(self.app).get("/api/proxy-market/catalog")
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["items"][0]
        self.assertEqual(item["masked_host"], "203.0.113.***")
        self.assertNotIn("host", item)
        self.assertNotIn("port", item)
        self.assertNotIn("username", item)
        self.assertNotIn("password", item)

    def test_claim_is_exclusive_idempotent_and_release_returns_inventory(self):
        item = self._market_item()
        customer, _ = self._customer("proxy_buyer")
        other, _ = self._customer("proxy_other")

        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "claim-once"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        replay = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "claim-once"},
        )
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["replayed"])
        conflict = other.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "other-claim"},
        )
        self.assertEqual(conflict.status_code, 409, conflict.text)

        proxy = customer.get("/api/persona_dashboard/automation/proxies").json()["proxies"][0]
        self.assertEqual(proxy["source"], "marketplace")
        self.assertTrue(proxy["marketplace"]["is_new"])
        blocked_edit = customer.patch(
            f"/api/persona_dashboard/automation/proxies/{proxy['id']}",
            json={"host": "203.0.113.99"},
            headers=self.origin,
        )
        self.assertEqual(blocked_edit.status_code, 409, blocked_edit.text)
        released = customer.delete(
            f"/api/persona_dashboard/automation/proxies/{proxy['id']}",
            headers=self.origin,
        )
        self.assertEqual(released.status_code, 200, released.text)
        catalog = other.get("/api/proxy-market/catalog").json()
        self.assertEqual(catalog["total"], 1)
        self.assertTrue(catalog["items"][0]["available"])

    def test_claim_limit_and_server_backed_read_state(self):
        first = self._market_item("TW-TPE-101")
        second = self._market_item("TW-TPE-102")
        customer, user_id = self._customer("limited_buyer")
        limited = self.admin.patch(
            f"/api/admin/users/{user_id}/proxy-market-limit",
            json={"claim_limit_override": 1},
            headers=self.origin,
        )
        self.assertEqual(limited.status_code, 200, limited.text)
        self.assertEqual(limited.json()["claim_limit"], 1)

        claim = customer.post(
            f"/api/proxy-market/items/{first['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "limited-first"},
        )
        self.assertEqual(claim.status_code, 200, claim.text)
        rejected = customer.post(
            f"/api/proxy-market/items/{second['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "limited-second"},
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)
        self.assertGreater(customer.get("/api/proxy-market/me").json()["unread_catalog_count"], 0)
        read = customer.post(
            "/api/proxy-market/read",
            json={"scope": "catalog"},
            headers=self.origin,
        )
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(customer.get("/api/proxy-market/me").json()["unread_catalog_count"], 0)

    def test_global_zero_claim_limit_is_preserved(self):
        item = self._market_item("TW-TPE-ZERO")
        saved = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={"default_claim_limit": 0, "health_max_age_seconds": 86400},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["settings"]["default_claim_limit"], 0)
        customer, _ = self._customer("zero_limit_buyer")
        summary = customer.get("/api/proxy-market/me")
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(summary.json()["claim_limit"], 0)
        rejected = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "zero-limit"},
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)

    def test_admin_test_publish_syncs_claimed_proxy(self):
        item = self._market_item()
        customer, _ = self._customer("sync_buyer")
        claim = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "sync-claim"},
        )
        self.assertEqual(claim.status_code, 200, claim.text)
        check_result = {
            "ok": True,
            "latency_ms": 82,
            "response": {
                "country": "台湾",
                "region": "新北",
                "city": "板桥",
                "connection": {"isp": "Synced ISP"},
            },
        }
        with patch("webapp.proxy_market._run_proxy_connection_check", return_value=check_result):
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={
                    "proxy_type": "https",
                    "host": "198.51.100.20",
                    "port": 8443,
                    "username": "updated-user",
                    "password": "updated-password",
                },
            )
        self.assertEqual(published.status_code, 200, published.text)
        proxy = customer.get("/api/persona_dashboard/automation/proxies").json()["proxies"][0]
        self.assertEqual(proxy["proxy_type"], "https")
        self.assertEqual(proxy["host"], "198.51.100.20")
        self.assertEqual(proxy["city"], "板桥")
        self.assertEqual(proxy["isp"], "Synced ISP")

    def test_draft_cannot_be_published_without_a_fresh_health_check(self):
        created = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": "TW-TPE-DRAFT",
                "display_name": "待检测代理",
                "proxy_type": "socks5",
                "host": "203.0.113.90",
                "port": 1080,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        item_id = created.json()["item"]["id"]
        activated = self.admin.patch(
            f"/api/admin/proxy-market/items/{item_id}",
            headers=self.origin,
            json={"status": "active"},
        )
        self.assertEqual(activated.status_code, 409, activated.text)
        catalog = TestClient(self.app).get("/api/proxy-market/catalog").json()
        self.assertEqual(catalog["total"], 0)

    def test_failed_candidate_check_keeps_the_live_claimed_proxy(self):
        item = self._market_item("TW-TPE-STABLE")
        customer, _ = self._customer("stable_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "stable-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)

        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value={"ok": False, "error": "candidate unavailable"},
        ):
            failed = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={
                    "proxy_type": "https",
                    "host": "198.51.100.90",
                    "port": 8443,
                    "username": "candidate-user",
                    "password": "candidate-password",
                },
            )
        self.assertEqual(failed.status_code, 409, failed.text)
        proxy = customer.get("/api/persona_dashboard/automation/proxies").json()["proxies"][0]
        self.assertEqual(proxy["proxy_type"], "socks5")
        self.assertEqual(proxy["host"], "203.0.113.10")
        with db() as conn:
            live = conn.execute(
                "SELECT status, health_status, host, port FROM proxy_market_items WHERE id = ?",
                (item["id"],),
            ).fetchone()
        self.assertEqual(live["status"], "allocated")
        self.assertEqual(live["health_status"], "healthy")
        self.assertEqual(live["host"], "203.0.113.10")
        self.assertEqual(int(live["port"]), 1080)

    def test_admin_revoke_requires_impact_confirmation_and_unbinds_accounts(self):
        item = self._market_item("TW-TPE-REVOKE")
        customer, user_id = self._customer("revoke_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "revoke-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        allocation = claimed.json()["allocation"]
        proxy_id = allocation["social_proxy_id"]
        now = int(time.time())
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir,
                  proxy_id, status, created_at, updated_at
                ) VALUES (?, ?, '', 'threads', ?, ?, ?, 'ready', ?, ?)
                """,
                ("account-revoke", user_id, "revoke_handle", "profiles/revoke", proxy_id, now, now),
            )

        preview = self.admin.post(
            f"/api/admin/proxy-market/allocations/{allocation['id']}/revoke",
            headers=self.origin,
            json={"confirm_impact": False},
        )
        self.assertEqual(preview.status_code, 409, preview.text)
        self.assertEqual(
            preview.json()["detail"]["code"],
            "proxy_market_revoke_confirmation_required",
        )
        self.assertEqual(len(preview.json()["detail"]["impact"]["bound_accounts"]), 1)

        revoked = self.admin.post(
            f"/api/admin/proxy-market/allocations/{allocation['id']}/revoke",
            headers=self.origin,
            json={"confirm_impact": True},
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        with db() as conn:
            account = conn.execute(
                "SELECT proxy_id FROM social_accounts WHERE id = 'account-revoke'"
            ).fetchone()
            proxy = conn.execute(
                "SELECT id FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(account["proxy_id"], "")
        self.assertIsNone(proxy)


if __name__ == "__main__":
    unittest.main()
