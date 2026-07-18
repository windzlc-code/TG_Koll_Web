import os
import socket
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import webapp.server as server
from webapp import proxy_market, social_automation_api
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

    def test_claim_is_exclusive_under_concurrent_requests(self):
        item = self._market_item("TW-TPE-CONCURRENT")
        first, _ = self._customer("concurrent_first")
        second, _ = self._customer("concurrent_second")
        barrier = threading.Barrier(2)

        def claim(client: TestClient, key: str):
            barrier.wait(timeout=5)
            return client.post(
                f"/api/proxy-market/items/{item['id']}/claim",
                headers={**self.origin, "Idempotency-Key": key},
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(claim, first, "concurrent-first"),
                pool.submit(claim, second, "concurrent-second"),
            ]
            responses = [future.result(timeout=15) for future in futures]

        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        with db() as conn:
            active_count = int(
                conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM proxy_market_allocations
                    WHERE item_id = ? AND status = 'active'
                    """,
                    (item["id"],),
                ).fetchone()[0]
            )
        self.assertEqual(active_count, 1)

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

    def test_inventory_capacity_is_admin_configurable_and_archive_releases_capacity(self):
        saved = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={
                "default_claim_limit": 250,
                "health_max_age_seconds": 86400,
                "inventory_capacity": 1,
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["settings"]["default_claim_limit"], 250)
        self.assertEqual(saved.json()["settings"]["inventory_capacity"], 1)
        capacity_only_update = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={"inventory_capacity": 1},
        )
        self.assertEqual(capacity_only_update.status_code, 200, capacity_only_update.text)
        self.assertEqual(capacity_only_update.json()["settings"]["default_claim_limit"], 250)
        self.assertEqual(capacity_only_update.json()["settings"]["health_max_age_seconds"], 86400)
        legacy_update = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={"default_claim_limit": 250, "health_max_age_seconds": 86400},
        )
        self.assertEqual(legacy_update.status_code, 200, legacy_update.text)
        self.assertEqual(legacy_update.json()["settings"]["inventory_capacity"], 1)

        first = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": "CAPACITY-001",
                "display_name": "Capacity one",
                "provider_key": "qa-provider",
                "proxy_type": "socks5",
                "host": "203.0.113.21",
                "port": 1080,
                "ip_type": "static_residential",
            },
        )
        self.assertEqual(first.status_code, 200, first.text)
        blocked = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": "CAPACITY-002",
                "display_name": "Capacity two",
                "provider_key": "qa-provider",
                "proxy_type": "socks5",
                "host": "203.0.113.22",
                "port": 1080,
                "ip_type": "static_residential",
            },
        )
        self.assertEqual(blocked.status_code, 409, blocked.text)

        archived = self.admin.post(
            f"/api/admin/proxy-market/items/{first.json()['item']['id']}/archive",
            headers=self.origin,
        )
        self.assertEqual(archived.status_code, 200, archived.text)
        replacement = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": "CAPACITY-003",
                "display_name": "Capacity replacement",
                "provider_key": "qa-provider",
                "proxy_type": "socks5",
                "host": "203.0.113.23",
                "port": 1080,
                "ip_type": "static_residential",
            },
        )
        self.assertEqual(replacement.status_code, 200, replacement.text)

        listed = self.admin.get("/api/admin/proxy-market/items")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["inventory"]["count"], 1)
        self.assertEqual(listed.json()["inventory"]["capacity"], 1)

    def test_zero_inventory_capacity_means_unlimited(self):
        saved = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={
                "default_claim_limit": 3,
                "health_max_age_seconds": 86400,
                "inventory_capacity": 0,
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["settings"]["inventory_capacity"], 0)
        self.assertEqual(self._market_item("UNLIMITED-001")["sku"], "UNLIMITED-001")
        self.assertEqual(self._market_item("UNLIMITED-002")["sku"], "UNLIMITED-002")

    def test_lowering_inventory_capacity_preserves_existing_items_and_blocks_new_items(self):
        self._market_item("LOWER-CAPACITY-001")
        self._market_item("LOWER-CAPACITY-002")
        saved = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={"inventory_capacity": 1},
        )
        self.assertEqual(saved.status_code, 200, saved.text)

        listed = self.admin.get("/api/admin/proxy-market/items")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["inventory"]["count"], 2)
        self.assertEqual(listed.json()["inventory"]["capacity"], 1)
        self.assertEqual(listed.json()["inventory"]["remaining"], 0)
        blocked = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": "LOWER-CAPACITY-003",
                "display_name": "Blocked by lower capacity",
                "provider_key": "qa-provider",
                "proxy_type": "socks5",
                "host": "203.0.113.33",
                "port": 1080,
                "ip_type": "static_residential",
            },
        )
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertEqual(len(self.admin.get("/api/admin/proxy-market/items").json()["items"]), 2)

    def test_inventory_capacity_serializes_concurrent_creates(self):
        saved = self.admin.patch(
            "/api/admin/proxy-market/settings",
            headers=self.origin,
            json={"inventory_capacity": 1},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        clients = [TestClient(self.app), TestClient(self.app)]
        for client in clients:
            login = client.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": self.ADMIN_PASSWORD},
            )
            self.assertEqual(login.status_code, 200, login.text)
            client.headers["X-Admin-Console"] = "1"
        barrier = threading.Barrier(2)

        def create_item(client: TestClient, suffix: int):
            barrier.wait(timeout=5)
            return client.post(
                "/api/admin/proxy-market/items",
                headers=self.origin,
                json={
                    "sku": f"CONCURRENT-CAPACITY-{suffix}",
                    "display_name": f"Concurrent capacity {suffix}",
                    "provider_key": "qa-provider",
                    "proxy_type": "socks5",
                    "host": f"203.0.113.{40 + suffix}",
                    "port": 1080,
                    "ip_type": "static_residential",
                },
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(create_item, clients[0], 1),
                pool.submit(create_item, clients[1], 2),
            ]
            responses = [future.result(timeout=15) for future in futures]

        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        listed = self.admin.get("/api/admin/proxy-market/items")
        self.assertEqual(listed.json()["inventory"]["count"], 1)

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
                "country_code": "TW",
                "region": "新北",
                "city": "板桥",
                "connection": {"isp": "", "org": "Synced ISP"},
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
        self.assertEqual(proxy["country"], "TW")
        self.assertEqual(proxy["city"], "板桥")
        self.assertEqual(proxy["isp"], "Synced ISP")

    def test_admin_test_and_publish_are_independent_steps(self):
        created = self.admin.post(
            "/api/admin/proxy-market/items",
            headers=self.origin,
            json={
                "sku": "TW-TPE-SPLIT",
                "display_name": "Split workflow",
                "proxy_type": "socks5",
                "host": "203.0.113.80",
                "port": 1080,
                "username": "split-user",
                "password": "split-password",
                "country": "TW",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]

        before_test = self.admin.post(
            f"/api/admin/proxy-market/items/{item['id']}/publish",
            headers=self.origin,
        )
        self.assertEqual(before_test.status_code, 409, before_test.text)

        check_result = {
            "ok": True,
            "latency_ms": 31,
            "response": {
                "country_code": "TW",
                "region": "Taipei",
                "city": "Taipei",
                "connection": {"isp": "Split ISP"},
            },
        }
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value=check_result,
        ) as connection_check:
            tested = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test",
                headers=self.origin,
                json={
                    "proxy_type": "socks5",
                    "host": "198.51.100.27",
                    "port": 8022,
                    "username": "fixture-user",
                    "password": "fixture-password",
                },
            )
        self.assertEqual(tested.status_code, 200, tested.text)
        connection_check.assert_called_once()
        self.assertTrue(tested.json()["check_id"])
        with db() as conn:
            stored_after_test = dict(
                conn.execute(
                    "SELECT * FROM proxy_market_items WHERE id = ?",
                    (item["id"],),
                ).fetchone()
            )
        self.assertEqual(stored_after_test["status"], "draft")
        self.assertEqual(stored_after_test["health_status"], "pending")
        self.assertEqual(stored_after_test["host"], "203.0.113.80")
        self.assertEqual(int(stored_after_test["published_at"]), 0)

        with patch("webapp.proxy_market._run_proxy_connection_check") as connection_check:
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/publish",
                headers=self.origin,
                json={"check_id": tested.json()["check_id"]},
            )
        self.assertEqual(published.status_code, 200, published.text)
        connection_check.assert_not_called()
        self.assertEqual(published.json()["item"]["status"], "active")
        self.assertGreater(int(published.json()["item"]["published_at"]), 0)
        replayed = self.admin.post(
            f"/api/admin/proxy-market/items/{item['id']}/publish",
            headers=self.origin,
            json={"check_id": tested.json()["check_id"]},
        )
        self.assertEqual(replayed.status_code, 200, replayed.text)
        self.assertTrue(replayed.json()["replayed"])
        self.assertEqual(
            replayed.json()["item"]["version"],
            published.json()["item"]["version"],
        )
        with db() as conn:
            candidate_after_publish = conn.execute(
                "SELECT * FROM proxy_market_item_checks WHERE item_id = ?",
                (item["id"],),
            ).fetchone()
            receipt = dict(
                conn.execute(
                    "SELECT * FROM proxy_market_publish_receipts WHERE check_id = ?",
                    (tested.json()["check_id"],),
                ).fetchone()
            )
        self.assertIsNone(candidate_after_publish)
        self.assertGreater(int(receipt["published_at"]), 0)
        self.assertNotIn("split-password", receipt["result_json"])

        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value=check_result,
        ):
            next_test = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test",
                headers=self.origin,
                json={
                    "proxy_type": "socks5",
                    "host": "198.51.100.28",
                    "port": 8022,
                },
            )
        self.assertEqual(next_test.status_code, 200, next_test.text)
        replayed_after_next_test = self.admin.post(
            f"/api/admin/proxy-market/items/{item['id']}/publish",
            headers=self.origin,
            json={"check_id": tested.json()["check_id"]},
        )
        self.assertEqual(
            replayed_after_next_test.status_code,
            200,
            replayed_after_next_test.text,
        )
        self.assertTrue(replayed_after_next_test.json()["replayed"])

    def test_tested_candidate_does_not_change_claimed_proxy_before_publish(self):
        item = self._market_item("TW-TPE-CANDIDATE")
        customer, _ = self._customer("candidate_isolation_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "candidate-isolation"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        proxy_id = claimed.json()["allocation"]["social_proxy_id"]
        check_result = {
            "ok": True,
            "latency_ms": 24,
            "response": {
                "country_code": "TW",
                "region": "Taipei",
                "city": "Taipei",
                "connection": {"isp": "Candidate ISP"},
            },
        }
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value=check_result,
        ):
            tested = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test",
                headers=self.origin,
                json={
                    "proxy_type": "https",
                    "host": "198.51.100.27",
                    "port": 8022,
                    "username": "candidate-user",
                    "password": "candidate-password",
                },
            )
        self.assertEqual(tested.status_code, 200, tested.text)
        with db() as conn:
            stored_item = dict(
                conn.execute(
                    "SELECT * FROM proxy_market_items WHERE id = ?",
                    (item["id"],),
                ).fetchone()
            )
            stored_proxy = dict(
                conn.execute(
                    "SELECT * FROM social_proxies WHERE id = ?",
                    (proxy_id,),
                ).fetchone()
            )
            candidate = dict(
                conn.execute(
                    "SELECT * FROM proxy_market_item_checks WHERE item_id = ?",
                    (item["id"],),
                ).fetchone()
            )
        self.assertEqual(stored_item["host"], "203.0.113.10")
        self.assertEqual(stored_proxy["host"], "203.0.113.10")
        self.assertEqual(proxy_market._decrypt_credentials(stored_item), ("proxy-user", "proxy-password"))
        self.assertEqual(candidate["host"], "198.51.100.27")
        self.assertEqual(
            proxy_market._decrypt_credentials({**candidate, "id": candidate["item_id"]}),
            ("candidate-user", "candidate-password"),
        )

        published = self.admin.post(
            f"/api/admin/proxy-market/items/{item['id']}/publish",
            headers=self.origin,
            json={"check_id": tested.json()["check_id"]},
        )
        self.assertEqual(published.status_code, 200, published.text)
        with db() as conn:
            live_item = dict(
                conn.execute(
                    "SELECT * FROM proxy_market_items WHERE id = ?",
                    (item["id"],),
                ).fetchone()
            )
            live_proxy = dict(
                conn.execute(
                    "SELECT * FROM social_proxies WHERE id = ?",
                    (proxy_id,),
                ).fetchone()
            )
        self.assertEqual(live_item["host"], "198.51.100.27")
        self.assertEqual(live_proxy["host"], "198.51.100.27")
        self.assertEqual(
            proxy_market._decrypt_credentials(live_item),
            ("candidate-user", "candidate-password"),
        )

    def test_inventory_edit_invalidates_pending_test(self):
        item = self._market_item("TW-TPE-INVALIDATE")
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value={"ok": True, "latency_ms": 18, "response": {"connection": {}}},
        ):
            tested = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test",
                headers=self.origin,
                json={"host": "198.51.100.27", "port": 8022},
            )
        self.assertEqual(tested.status_code, 200, tested.text)
        changed = self.admin.patch(
            f"/api/admin/proxy-market/items/{item['id']}",
            headers=self.origin,
            json={"display_name": "Edited after test"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        rejected = self.admin.post(
            f"/api/admin/proxy-market/items/{item['id']}/publish",
            headers=self.origin,
            json={"check_id": tested.json()["check_id"]},
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)
        with db() as conn:
            pending = conn.execute(
                "SELECT 1 FROM proxy_market_item_checks WHERE item_id = ?",
                (item["id"],),
            ).fetchone()
        self.assertIsNone(pending)

    def test_allocation_version_change_hides_stale_pending_check(self):
        item = self._market_item("TW-TPE-STALE-CHECK")
        customer, _ = self._customer("stale_check_buyer")
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value={"ok": True, "latency_ms": 18, "response": {"connection": {}}},
        ):
            tested = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test",
                headers=self.origin,
                json={"host": "198.51.100.27", "port": 8022},
            )
        self.assertEqual(tested.status_code, 200, tested.text)
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "stale-check-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)

        listed = self.admin.get("/api/admin/proxy-market/items")
        self.assertEqual(listed.status_code, 200, listed.text)
        listed_item = next(
            row for row in listed.json()["items"] if row["id"] == item["id"]
        )
        self.assertEqual(listed_item["pending_check_id"], "")
        self.assertEqual(listed_item["pending_check_status"], "")
        with db() as conn:
            stale_candidate = conn.execute(
                "SELECT 1 FROM proxy_market_item_checks WHERE item_id = ?",
                (item["id"],),
            ).fetchone()
        self.assertIsNone(stale_candidate)

        rejected = self.admin.post(
            f"/api/admin/proxy-market/items/{item['id']}/publish",
            headers=self.origin,
            json={"check_id": tested.json()["check_id"]},
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)

    def test_proxy_check_pins_validated_ip_across_dns_rebinding(self):
        dns_answers = [
            [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    ("93.184.216.34", 8443),
                )
            ],
            [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    ("127.0.0.1", 8443),
                )
            ],
        ]

        with patch(
            "webapp.proxy_market.socket.getaddrinfo",
            side_effect=dns_answers,
        ) as resolver:
            pinned_ip = proxy_market._validate_public_proxy_host(
                "proxy-rebind.example",
                8443,
            )
            adapter = proxy_market._PinnedProxyAdapter(
                original_host="proxy-rebind.example",
                original_port=8443,
                pinned_ip=pinned_ip,
            )
            manager = adapter.proxy_manager_for(
                "https://proxy-user:proxy-password@proxy-rebind.example:8443"
            )
            pool = manager.connection_from_host(
                "api.ipify.org",
                port=443,
                scheme="https",
            )
            https_connection = pool._new_conn()
            http_manager = adapter.proxy_manager_for(
                "http://proxy-user:proxy-password@proxy-rebind.example:8443"
            )
            http_pool = http_manager.connection_from_host(
                "api.ipify.org",
                port=80,
                scheme="http",
            )
            http_connection = http_pool._new_conn()
            sentinel_socket = object()
            with patch(
                "webapp.proxy_market.urllib3_connection.create_connection",
                return_value=sentinel_socket,
            ) as create_connection:
                https_connected = https_connection._new_conn()
                http_connected = http_connection._new_conn()

        self.assertIs(https_connected, sentinel_socket)
        self.assertIs(http_connected, sentinel_socket)
        self.assertEqual(resolver.call_count, 1)
        self.assertEqual(manager.proxy.host, "proxy-rebind.example")
        self.assertEqual(https_connection.host, "proxy-rebind.example")
        self.assertEqual(http_connection.host, "proxy-rebind.example")
        self.assertEqual(
            [call.args[0] for call in create_connection.call_args_list],
            [("93.184.216.34", 8443), ("93.184.216.34", 8443)],
        )

        socks_manager = adapter.proxy_manager_for(
            "socks5://proxy-user:proxy-password@proxy-rebind.example:8443"
        )
        self.assertIn("proxy-rebind.example", socks_manager.proxy_url)
        self.assertEqual(
            socks_manager.connection_pool_kw["_socks_options"]["proxy_host"],
            "93.184.216.34",
        )

    def test_admin_can_inspect_candidate_without_saving_or_exposing_credentials(self):
        check_result = {
            "ok": True,
            "checked_at": int(time.time()),
            "exit_ip": "8.8.8.8",
            "latency_ms": 41,
            "route_verified": True,
            "static_consistent": True,
            "residential_status": "verified",
            "response": {
                "country": "Taiwan",
                "country_code": "TW",
                "region": "Taipei",
                "city": "Taipei",
                "connection": {"isp": "", "org": "Detected ISP"},
            },
        }
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value=check_result,
        ) as connection_check:
            inspected = self.admin.post(
                "/api/admin/proxy-market/inspect",
                headers=self.origin,
                json={
                    "proxy_type": "SOCKS5",
                    "host": "8.8.8.8",
                    "port": 1080,
                    "username": "candidate-user",
                    "password": "candidate-password",
                },
            )
        self.assertEqual(inspected.status_code, 200, inspected.text)
        candidate = connection_check.call_args.args[0]
        self.assertEqual(candidate["proxy_type"], "socks5")
        self.assertEqual(candidate["username"], "candidate-user")
        self.assertEqual(candidate["password"], "candidate-password")
        payload = inspected.json()
        self.assertEqual(payload["check"]["detected"]["country"], "TW")
        self.assertEqual(payload["check"]["detected"]["isp"], "Detected ISP")
        self.assertNotIn("candidate-user", inspected.text)
        self.assertNotIn("candidate-password", inspected.text)
        with db() as conn:
            self.assertEqual(
                int(conn.execute("SELECT COUNT(*) FROM proxy_market_items").fetchone()[0]),
                0,
            )
            audit = conn.execute(
                "SELECT after_json FROM audit_events WHERE action = 'proxy_market.item.inspect' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        self.assertIsNotNone(audit)
        self.assertNotIn("candidate-user", str(audit["after_json"]))
        self.assertNotIn("candidate-password", str(audit["after_json"]))

    def test_proxy_market_inspection_requires_admin_and_redacts_failed_check(self):
        customer, _ = self._customer("inspect_customer")
        denied = customer.post(
            "/api/admin/proxy-market/inspect",
            headers=self.origin,
            json={"proxy_type": "http", "host": "1.1.1.1", "port": 8080},
        )
        self.assertEqual(denied.status_code, 401, denied.text)
        blocked = self.admin.post(
            "/api/admin/proxy-market/inspect",
            headers=self.origin,
            json={"proxy_type": "http", "host": "127.0.0.1", "port": 8080},
        )
        self.assertEqual(blocked.status_code, 400, blocked.text)
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value={
                "ok": False,
                "error_code": "ProxyError",
                "error": "candidate%2Buser:candidate%2Fpassword%3F was rejected",
            },
        ):
            failed = self.admin.post(
                "/api/admin/proxy-market/inspect",
                headers=self.origin,
                json={
                    "proxy_type": "http",
                    "host": "1.1.1.1",
                    "port": 8080,
                    "username": "candidate+user",
                    "password": "candidate/password?",
                },
            )
        self.assertEqual(failed.status_code, 409, failed.text)
        self.assertNotIn("candidate+user", failed.text)
        self.assertNotIn("candidate/password?", failed.text)
        self.assertNotIn("candidate%2Buser", failed.text)
        self.assertNotIn("candidate%2Fpassword%3F", failed.text)
        with db() as conn:
            audit = conn.execute(
                """
                SELECT outcome, error_code, after_json
                FROM audit_events
                WHERE action = 'proxy_market.item.inspect'
                ORDER BY created_at DESC
                LIMIT 1
                """
            ).fetchone()
        self.assertEqual(audit["outcome"], "failed")
        self.assertEqual(audit["error_code"], "ProxyError")
        self.assertNotIn("candidate+user", str(audit["after_json"]))
        self.assertNotIn("candidate/password?", str(audit["after_json"]))
        self.assertNotIn("candidate%2Buser", str(audit["after_json"]))
        self.assertNotIn("candidate%2Fpassword%3F", str(audit["after_json"]))

    def test_inspection_reuses_saved_credentials_only_for_unchanged_endpoint(self):
        item = self._market_item("TW-TPE-INSPECT-CREDENTIALS")
        with db() as conn:
            before = dict(
                conn.execute(
                    """
                    SELECT username_ciphertext, password_ciphertext, version, status,
                           health_status, updated_at
                    FROM proxy_market_items
                    WHERE id = ?
                    """,
                    (item["id"],),
                ).fetchone()
            )
        check_result = {
            "ok": True,
            "response": {"country_code": "TW", "connection": {}},
        }
        with (
            patch(
                "webapp.proxy_market._run_proxy_connection_check",
                return_value=check_result,
            ) as connection_check,
            patch("webapp.proxy_market._validate_public_proxy_host"),
        ):
            unchanged = self.admin.post(
                "/api/admin/proxy-market/inspect",
                headers=self.origin,
                json={
                    "item_id": item["id"],
                    "proxy_type": "socks5",
                    "host": "203.0.113.10",
                    "port": 1080,
                },
            )
            changed = self.admin.post(
                "/api/admin/proxy-market/inspect",
                headers=self.origin,
                json={
                    "item_id": item["id"],
                    "proxy_type": "socks5",
                    "host": "203.0.113.11",
                    "port": 1080,
                },
            )
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        self.assertEqual(changed.status_code, 200, changed.text)
        first_candidate = connection_check.call_args_list[0].args[0]
        second_candidate = connection_check.call_args_list[1].args[0]
        self.assertEqual(first_candidate["username"], "proxy-user")
        self.assertEqual(first_candidate["password"], "proxy-password")
        self.assertEqual(second_candidate["username"], "")
        self.assertEqual(second_candidate["password"], "")
        with db() as conn:
            after = dict(
                conn.execute(
                    """
                    SELECT username_ciphertext, password_ciphertext, version, status,
                           health_status, updated_at
                    FROM proxy_market_items
                    WHERE id = ?
                    """,
                    (item["id"],),
                ).fetchone()
            )
        self.assertEqual(after, before)

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

    def test_fresh_published_item_can_resume_after_status_pause(self):
        item = self._market_item("TW-TPE-RESUME")
        for paused_status in ("maintenance", "disabled"):
            paused = self.admin.patch(
                f"/api/admin/proxy-market/items/{item['id']}",
                headers=self.origin,
                json={"status": paused_status},
            )
            self.assertEqual(paused.status_code, 200, paused.text)
            self.assertEqual(paused.json()["item"]["status"], paused_status)

            resumed = self.admin.patch(
                f"/api/admin/proxy-market/items/{item['id']}",
                headers=self.origin,
                json={"status": "active"},
            )
            self.assertEqual(resumed.status_code, 200, resumed.text)
            self.assertEqual(resumed.json()["item"]["status"], "active")
            self.assertTrue(resumed.json()["item"]["available"])

    def test_claimed_item_resumes_to_allocated_and_reenables_proxy(self):
        item = self._market_item("TW-TPE-RESUME-ALLOCATED")
        customer, _ = self._customer("resume_allocated_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "resume-allocated-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        proxy_id = claimed.json()["allocation"]["social_proxy_id"]

        paused = self.admin.patch(
            f"/api/admin/proxy-market/items/{item['id']}",
            headers=self.origin,
            json={"status": "maintenance"},
        )
        self.assertEqual(paused.status_code, 200, paused.text)
        with db() as conn:
            proxy = conn.execute(
                "SELECT status FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(proxy["status"], "maintenance")

        resumed = self.admin.patch(
            f"/api/admin/proxy-market/items/{item['id']}",
            headers=self.origin,
            json={"status": "active"},
        )
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertEqual(resumed.json()["item"]["status"], "allocated")
        with db() as conn:
            proxy = conn.execute(
                "SELECT status FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(proxy["status"], "active")

    def test_resume_requires_current_health_and_rejects_archived_items(self):
        stale = self._market_item("TW-TPE-RESUME-STALE")
        paused = self.admin.patch(
            f"/api/admin/proxy-market/items/{stale['id']}",
            headers=self.origin,
            json={"status": "maintenance"},
        )
        self.assertEqual(paused.status_code, 200, paused.text)
        with db() as conn:
            conn.execute(
                "UPDATE proxy_market_items SET last_check_at = ? WHERE id = ?",
                (int(time.time()) - 8 * 24 * 60 * 60, stale["id"]),
            )
        rejected = self.admin.patch(
            f"/api/admin/proxy-market/items/{stale['id']}",
            headers=self.origin,
            json={"status": "active"},
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)

        archived = self._market_item("TW-TPE-RESUME-ARCHIVED")
        archived_response = self.admin.patch(
            f"/api/admin/proxy-market/items/{archived['id']}",
            headers=self.origin,
            json={"status": "archived"},
        )
        self.assertEqual(archived_response.status_code, 200, archived_response.text)
        restore_archived = self.admin.patch(
            f"/api/admin/proxy-market/items/{archived['id']}",
            headers=self.origin,
            json={"status": "active"},
        )
        self.assertEqual(restore_archived.status_code, 409, restore_archived.text)

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

    def test_market_credentials_stay_out_of_social_proxies_and_resolve_for_check(self):
        item = self._market_item("TW-TPE-VAULT")
        customer, _ = self._customer("vault_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "vault-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        proxy_id = claimed.json()["allocation"]["social_proxy_id"]
        with db() as conn:
            stored = conn.execute(
                "SELECT username, password FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(stored["username"], "")
        self.assertEqual(stored["password"], "")

        check_result = {
            "ok": True,
            "latency_ms": 25,
            "response": {
                "country": "TW",
                "region": "Taipei",
                "city": "Taipei",
                "connection": {"isp": "Vault ISP"},
            },
        }
        with patch(
            "webapp.social_automation_api._run_proxy_connection_check",
            return_value=check_result,
        ) as connection_check:
            checked = customer.post(
                f"/api/persona_dashboard/automation/proxies/{proxy_id}/check",
                headers=self.origin,
            )
        self.assertEqual(checked.status_code, 200, checked.text)
        runtime_proxy = connection_check.call_args.args[0]
        self.assertEqual(runtime_proxy["username"], "proxy-user")
        self.assertEqual(runtime_proxy["password"], "proxy-password")
        with db() as conn:
            stored_after = conn.execute(
                "SELECT username, password FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(stored_after["username"], "")
        self.assertEqual(stored_after["password"], "")
        with db() as conn:
            conn.execute(
                """
                UPDATE social_proxies
                SET username = 'legacy-user', password = 'legacy-password'
                WHERE id = ?
                """,
                (proxy_id,),
            )
        proxy_market._scrub_legacy_market_proxy_plaintext()
        with db() as conn:
            scrubbed = conn.execute(
                "SELECT username, password FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(scrubbed["username"], "")
        self.assertEqual(scrubbed["password"], "")

    def test_market_proxy_test_ignores_request_endpoint_overrides(self):
        item = self._market_item("TW-TPE-VAULT-ENDPOINT")
        customer, _ = self._customer("vault_endpoint_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "vault-endpoint-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        proxy_id = claimed.json()["allocation"]["social_proxy_id"]

        with patch(
            "webapp.social_automation_api._run_proxy_connection_check",
            return_value={"ok": True, "response": {}},
        ) as connection_check:
            checked = customer.post(
                "/api/persona_dashboard/automation/proxies/test",
                headers=self.origin,
                json={
                    "proxy_id": proxy_id,
                    "proxy_type": "http",
                    "host": "attacker.example",
                    "port": 8080,
                    "username": "attacker",
                    "password": "attacker-password",
                },
            )
        self.assertEqual(checked.status_code, 200, checked.text)
        candidate = connection_check.call_args.args[0]
        self.assertEqual(candidate["proxy_type"], "socks5")
        self.assertEqual(candidate["host"], "203.0.113.10")
        self.assertEqual(candidate["port"], 1080)
        self.assertEqual(candidate["username"], "proxy-user")
        self.assertEqual(candidate["password"], "proxy-password")

    def test_claim_idempotency_key_is_bound_to_market_item(self):
        first = self._market_item("TW-TPE-IDEM-1")
        second = self._market_item("TW-TPE-IDEM-2")
        customer, _ = self._customer("idempotency_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{first['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "same-key"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        conflict = customer.post(
            f"/api/proxy-market/items/{second['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "same-key"},
        )
        self.assertEqual(conflict.status_code, 409, conflict.text)

    def test_market_state_machine_and_claimed_proxy_display_sync(self):
        active = self._market_item("TW-TPE-STATE-ACTIVE")
        forged = self.admin.patch(
            f"/api/admin/proxy-market/items/{active['id']}",
            headers=self.origin,
            json={"status": "allocated"},
        )
        self.assertEqual(forged.status_code, 409, forged.text)

        customer, _ = self._customer("state_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{active['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "state-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        proxy_id = claimed.json()["allocation"]["social_proxy_id"]
        rejected_draft = self.admin.patch(
            f"/api/admin/proxy-market/items/{active['id']}",
            headers=self.origin,
            json={"status": "draft"},
        )
        self.assertEqual(rejected_draft.status_code, 409, rejected_draft.text)

        expires_at = int(time.time()) + 86400
        synced = self.admin.patch(
            f"/api/admin/proxy-market/items/{active['id']}",
            headers=self.origin,
            json={
                "display_name": "Updated marketplace proxy",
                "country": "TW",
                "region": "New Taipei",
                "city": "Banqiao",
                "isp": "Updated ISP",
                "expires_at": expires_at,
            },
        )
        self.assertEqual(synced.status_code, 200, synced.text)
        with db() as conn:
            proxy = conn.execute(
                """
                SELECT name, country, region, city, isp, expires_at
                FROM social_proxies
                WHERE id = ?
                """,
                (proxy_id,),
            ).fetchone()
        self.assertEqual(proxy["name"], "Updated marketplace proxy")
        self.assertEqual(proxy["country"], "TW")
        self.assertEqual(proxy["region"], "New Taipei")
        self.assertEqual(proxy["city"], "Banqiao")
        self.assertEqual(proxy["isp"], "Updated ISP")
        self.assertEqual(int(proxy["expires_at"]), expires_at)

        expired = self.admin.patch(
            f"/api/admin/proxy-market/items/{active['id']}",
            headers=self.origin,
            json={"expires_at": int(time.time()) - 1},
        )
        self.assertEqual(expired.status_code, 200, expired.text)
        self.assertEqual(expired.json()["item"]["status"], "maintenance")
        with db() as conn:
            expired_proxy = conn.execute(
                "SELECT status FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
        self.assertEqual(expired_proxy["status"], "maintenance")

    def test_archived_item_cannot_be_republished(self):
        item = self._market_item("TW-TPE-ARCHIVED")
        changed = self.admin.patch(
            f"/api/admin/proxy-market/items/{item['id']}",
            headers=self.origin,
            json={"status": "archived"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value={"ok": True, "latency_ms": 20, "response": {}},
        ) as connection_check:
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={"host": "198.51.100.44", "port": 1081},
            )
        self.assertEqual(published.status_code, 409, published.text)
        connection_check.assert_not_called()

    def test_stale_disabled_item_can_be_retested_and_published(self):
        item = self._market_item("TW-TPE-DISABLED-RETEST")
        changed = self.admin.patch(
            f"/api/admin/proxy-market/items/{item['id']}",
            headers=self.origin,
            json={"status": "disabled"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        with db() as conn:
            conn.execute(
                "UPDATE proxy_market_items SET last_check_at = ? WHERE id = ?",
                (int(time.time()) - 8 * 24 * 60 * 60, item["id"]),
            )
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value={"ok": True, "latency_ms": 20, "response": {}},
        ) as connection_check:
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={"host": "198.51.100.44", "port": 1081},
            )
        self.assertEqual(published.status_code, 200, published.text)
        self.assertEqual(published.json()["item"]["status"], "active")
        self.assertTrue(published.json()["item"]["available"])
        connection_check.assert_called_once()

    def test_publish_omitted_protocol_preserves_existing_protocol(self):
        item = self._market_item("TW-TPE-PROTOCOL")
        with db() as conn:
            conn.execute(
                "UPDATE proxy_market_items SET proxy_type = 'https' WHERE id = ?",
                (item["id"],),
            )
        check_result = {
            "ok": True,
            "latency_ms": 20,
            "response": {"connection": {}},
        }
        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            return_value=check_result,
        ):
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={"host": "198.51.100.44", "port": 1081},
            )
        self.assertEqual(published.status_code, 200, published.text)
        self.assertEqual(published.json()["item"]["proxy_type"], "https")

    def test_publish_rejects_version_change_during_connection_check(self):
        item = self._market_item("TW-TPE-VERSION")

        def mutate_item(_candidate):
            with db() as conn:
                conn.execute(
                    """
                    UPDATE proxy_market_items
                    SET display_name = 'Concurrent edit', version = version + 1
                    WHERE id = ?
                    """,
                    (item["id"],),
                )
            return {"ok": True, "latency_ms": 20, "response": {"connection": {}}}

        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            side_effect=mutate_item,
        ):
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={"host": "198.51.100.55", "port": 1081},
            )
        self.assertEqual(published.status_code, 409, published.text)
        with db() as conn:
            stored = conn.execute(
                "SELECT host FROM proxy_market_items WHERE id = ?",
                (item["id"],),
            ).fetchone()
        self.assertEqual(stored["host"], "203.0.113.10")

    def test_publish_rechecks_active_tasks_in_final_transaction(self):
        item = self._market_item("TW-TPE-TASK-RACE")
        customer, user_id = self._customer("task_race_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "task-race-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        proxy_id = claimed.json()["allocation"]["social_proxy_id"]

        def create_task(_candidate):
            now = int(time.time())
            with db() as conn:
                conn.execute(
                    """
                    INSERT INTO social_accounts(
                      id, user_id, persona_id, platform, username, profile_dir,
                      proxy_id, status, created_at, updated_at
                    ) VALUES ('account-task-race', ?, '', 'threads', 'task_race',
                              'profiles/task-race', ?, 'ready', ?, ?)
                    """,
                    (user_id, proxy_id, now, now),
                )
                conn.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id, user_id, persona_id, account_id, platform, task_type,
                      status, payload_json, created_at, updated_at
                    ) VALUES ('task-race', ?, '', 'account-task-race', 'threads',
                              'check_login', 'queued', '{}', ?, ?)
                    """,
                    (user_id, now, now),
                )
            return {"ok": True, "latency_ms": 20, "response": {"connection": {}}}

        with patch(
            "webapp.proxy_market._run_proxy_connection_check",
            side_effect=create_task,
        ):
            published = self.admin.post(
                f"/api/admin/proxy-market/items/{item['id']}/test-and-publish",
                headers=self.origin,
                json={"host": "198.51.100.66", "port": 1081},
            )
        self.assertEqual(published.status_code, 409, published.text)
        with db() as conn:
            stored = conn.execute(
                "SELECT host FROM proxy_market_items WHERE id = ?",
                (item["id"],),
            ).fetchone()
        self.assertEqual(stored["host"], "203.0.113.10")

    def test_force_revoke_cancels_all_active_states_before_runtime_cleanup(self):
        item = self._market_item("TW-TPE-FORCE-TX")
        customer, user_id = self._customer("force_tx_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "force-tx-claim"},
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        allocation = claimed.json()["allocation"]
        proxy_id = allocation["social_proxy_id"]
        now = int(time.time())
        task_ids = [
            "force-preparing",
            "force-queued",
            "force-running",
            "force-manual",
        ]
        statuses = ["preparing", "queued", "running", "need_manual"]
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir,
                  proxy_id, status, created_at, updated_at
                ) VALUES ('account-force-tx', ?, '', 'threads', 'force_tx',
                          'profiles/force-tx', ?, 'ready', ?, ?)
                """,
                (user_id, proxy_id, now, now),
            )
            for task_id, status in zip(task_ids, statuses):
                conn.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id, user_id, persona_id, account_id, platform, task_type,
                      status, payload_json, created_at, updated_at
                    ) VALUES (?, ?, '', 'account-force-tx', 'threads',
                              'check_login', ?, '{}', ?, ?)
                    """,
                    (task_id, user_id, status, now, now),
                )

        cleanup_observations = []

        def observe_cleanup(cancelled_task_ids):
            with db() as conn:
                cleanup_observations.append(
                    {
                        "task_ids": list(cancelled_task_ids),
                        "statuses": [
                            row["status"]
                            for row in conn.execute(
                                """
                                SELECT status
                                FROM social_automation_tasks
                                WHERE id IN (?, ?, ?, ?)
                                ORDER BY id
                                """,
                                tuple(task_ids),
                            ).fetchall()
                        ],
                        "proxy": conn.execute(
                            "SELECT id FROM social_proxies WHERE id = ?",
                            (proxy_id,),
                        ).fetchone(),
                        "allocation_status": conn.execute(
                            "SELECT status FROM proxy_market_allocations WHERE id = ?",
                            (allocation["id"],),
                        ).fetchone()["status"],
                    }
                )

        with patch(
            "webapp.proxy_market.cleanup_cancelled_social_tasks_runtime",
            side_effect=observe_cleanup,
        ):
            revoked = self.admin.post(
                f"/api/admin/proxy-market/allocations/{allocation['id']}/revoke",
                headers=self.origin,
                json={"confirm_impact": True},
            )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        self.assertEqual(len(cleanup_observations), 1)
        observation = cleanup_observations[0]
        self.assertCountEqual(observation["task_ids"], task_ids)
        self.assertEqual(observation["statuses"], ["cancelled"] * 4)
        self.assertIsNone(observation["proxy"])
        self.assertEqual(observation["allocation_status"], "revoked")

    def test_force_revoke_rolls_back_all_database_changes_on_failure(self):
        item = self._market_item("TW-TPE-FORCE-ROLLBACK")
        customer, user_id = self._customer("force_rollback_buyer")
        claimed = customer.post(
            f"/api/proxy-market/items/{item['id']}/claim",
            headers={**self.origin, "Idempotency-Key": "force-rollback-claim"},
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
                ) VALUES ('account-force-rollback', ?, '', 'threads',
                          'force_rollback', 'profiles/force-rollback', ?,
                          'ready', ?, ?)
                """,
                (user_id, proxy_id, now, now),
            )
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type,
                  status, payload_json, created_at, updated_at
                ) VALUES ('task-force-rollback', ?, '',
                          'account-force-rollback', 'threads', 'check_login',
                          'queued', '{}', ?, ?)
                """,
                (user_id, now, now),
            )

        with patch(
            "webapp.proxy_market._record_audit",
            side_effect=RuntimeError("audit failure"),
        ):
            with self.assertRaises(RuntimeError):
                self.admin.post(
                    f"/api/admin/proxy-market/allocations/{allocation['id']}/revoke",
                    headers=self.origin,
                    json={"confirm_impact": True},
                )

        with db() as conn:
            account = conn.execute(
                "SELECT proxy_id FROM social_accounts WHERE id = 'account-force-rollback'"
            ).fetchone()
            task = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = 'task-force-rollback'"
            ).fetchone()
            proxy = conn.execute(
                "SELECT id FROM social_proxies WHERE id = ?",
                (proxy_id,),
            ).fetchone()
            allocation_status = conn.execute(
                "SELECT status FROM proxy_market_allocations WHERE id = ?",
                (allocation["id"],),
            ).fetchone()
            item_status = conn.execute(
                "SELECT status FROM proxy_market_items WHERE id = ?",
                (item["id"],),
            ).fetchone()
        self.assertEqual(account["proxy_id"], proxy_id)
        self.assertEqual(task["status"], "queued")
        self.assertIsNotNone(proxy)
        self.assertEqual(allocation_status["status"], "active")
        self.assertEqual(item_status["status"], "allocated")


if __name__ == "__main__":
    unittest.main()
