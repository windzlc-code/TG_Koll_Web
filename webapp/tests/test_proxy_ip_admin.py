import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import proxy_ip_admin
from webapp.auth import require_admin
from webapp.db import init_db


class ProxyIpAdminTests(unittest.TestCase):
    def setUp(self):
        self.old_db_path = os.environ.get("APP_DB_PATH")
        self.old_vault_key = os.environ.get("PASSWORD_VAULT_KEY")
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        init_db()

        app = FastAPI()
        proxy_ip_admin.register_proxy_ip_admin_routes(app)
        app.dependency_overrides[require_admin] = lambda: {"id": 1, "is_admin": 1}
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db_path
        if self.old_vault_key is None:
            os.environ.pop("PASSWORD_VAULT_KEY", None)
        else:
            os.environ["PASSWORD_VAULT_KEY"] = self.old_vault_key
        self.tmpdir.cleanup()

    def test_inventory_create_list_and_inspect_are_available_without_public_market_routes(self):
        created = self.client.post(
            "/api/admin/proxy-market/items",
            json={
                "sku": "TW-TPE-ADMIN-1",
                "display_name": "台北静态住宅代理",
                "proxy_type": "socks5",
                "host": "203.0.113.10",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
                "country": "Taiwan",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]

        listed = self.client.get("/api/admin/proxy-market/items")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual([row["id"] for row in listed.json()["items"]], [item["id"]])

        check_result = {
            "ok": True,
            "checked_at": 1,
            "exit_ip": "203.0.113.10",
            "latency_ms": 25,
            "route_verified": True,
            "static_consistent": True,
            "residential_status": "residential",
            "response": {
                "ip": "203.0.113.10",
                "country_code": "TW",
                "country": "Taiwan",
                "region": "Taipei",
                "city": "Taipei",
                "connection": {"isp": "Example ISP"},
            },
        }
        with patch.object(proxy_ip_admin, "_run_proxy_connection_check", return_value=check_result):
            inspected = self.client.post(
                "/api/admin/proxy-market/inspect",
                json={
                    "item_id": item["id"],
                    "proxy_type": "socks5",
                    "host": "203.0.113.10",
                    "port": 1080,
                },
            )
        self.assertEqual(inspected.status_code, 200, inspected.text)
        self.assertEqual(inspected.json()["check"]["detected"]["country"], "TW")

        route_paths = {route.path for route in self.app.routes}
        self.assertNotIn("/api/proxy-market/catalog", route_paths)
        self.assertNotIn("/api/proxy-market/me", route_paths)
        self.assertIn("/api/admin/proxy-market/items/{item_id}/purge", route_paths)
        self.assertIn("/api/admin/proxy-market/items/{item_id}/shares", route_paths)

    def _create_user(self, username: str, *, is_admin: int = 0) -> int:
        from webapp.db import db

        with db() as conn:
            conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, created_at, updated_at) VALUES (?, 'x', ?, 1, 1)",
                (username, int(is_admin)),
            )
            return int(conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()[0])

    def test_shared_inventory_can_be_purged_but_purchased_item_cannot(self):
        created = self.client.post(
            "/api/admin/proxy-market/items",
            json={
                "sku": "TW-TPE-PURGE-1",
                "display_name": "待删除共享代理",
                "proxy_type": "socks5",
                "host": "203.0.113.20",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]
        self.assertTrue(item["can_purge"])
        self.assertFalse(item["can_assign"])

        purged = self.client.post(f"/api/admin/proxy-market/items/{item['id']}/purge", json={"confirm_impact": True})
        self.assertEqual(purged.status_code, 200, purged.text)
        self.assertTrue(purged.json()["deleted"])

        listed = self.client.get("/api/admin/proxy-market/items")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["items"], [])

        from webapp.db import db

        owner_id = self._create_user("purchase-owner")
        with db() as conn:
            conn.execute(
                """
                INSERT INTO proxy_market_items(
                  id, sku, display_name, provider_key, proxy_type, host, port,
                  credential_owner_user_id, status, health_status, ownership_type,
                  owner_user_id, provider_purchase_order_id, provider_proxy_id,
                  created_at, updated_at
                ) VALUES (
                  'owned_proxy_item_test1', 'owned-1', '已购代理', 'proxycheap', 'http',
                  '198.51.100.10', 8000, ?, 'allocated', 'healthy', 'owned', ?,
                  'proxy_order_test1', '2311533', 1, 1
                )
                """,
                (owner_id, owner_id),
            )
        refused = self.client.post("/api/admin/proxy-market/items/owned_proxy_item_test1/purge", json={"confirm_impact": True})
        self.assertEqual(refused.status_code, 409, refused.text)
        self.assertIn("已购代理", refused.json()["detail"])

    def test_admin_can_share_purchased_proxy_with_multiple_customers(self):
        from webapp.db import db
        from webapp.system_proxy_pool import list_system_proxy_pool_options

        owner_id = self._create_user("proxy-buyer", is_admin=1)
        first_id = self._create_user("proxy-receiver-a")
        second_id = self._create_user("proxy-receiver-b")
        with db() as conn:
            conn.execute(
                """
                INSERT INTO proxy_market_items(
                  id, sku, display_name, provider_key, proxy_type, host, port,
                  credential_owner_user_id, status, health_status, last_check_at,
                  last_check_result_json, ownership_type, owner_user_id,
                  provider_purchase_order_id, provider_proxy_id, created_at, updated_at
                ) VALUES (
                  'owned_proxy_item_share1', 'owned-share-1', '已购葡萄牙代理', 'proxycheap',
                  'http', '198.51.100.21', 48859, ?, 'allocated', 'healthy', 1,
                  '{"ok":true,"exit_ip":"198.51.100.21"}', 'owned', ?,
                  'proxy_order_share1', '2311999', 1, 1
                )
                """,
                (owner_id, owner_id),
            )
            conn.execute(
                """
                INSERT INTO social_proxies(
                  id, user_id, name, proxy_type, host, port, source, purchase_status,
                  status, market_item_id, created_at, updated_at
                ) VALUES (
                  'social_proxy_share_owner', ?, '已购葡萄牙代理', 'http', '198.51.100.21', 48859,
                  'provider_purchase', 'owned', 'active', 'owned_proxy_item_share1', 1, 1
                )
                """,
                (owner_id,),
            )

        saved = self.client.put(
            "/api/admin/proxy-market/items/owned_proxy_item_share1/shares",
            json={"user_ids": [first_id, second_id], "confirm_impact": True},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        payload = saved.json()
        self.assertEqual(sorted(payload["user_ids"]), sorted([first_id, second_id]))

        with db() as conn:
            item = conn.execute(
                "SELECT owner_user_id FROM proxy_market_items WHERE id = ?",
                ("owned_proxy_item_share1",),
            ).fetchone()
            owner_proxy = conn.execute(
                "SELECT user_id, purchase_status FROM social_proxies WHERE id = ?",
                ("social_proxy_share_owner",),
            ).fetchone()
            copies = conn.execute(
                "SELECT user_id, purchase_status FROM social_proxies WHERE market_item_id = ? ORDER BY user_id",
                ("owned_proxy_item_share1",),
            ).fetchall()
            first_options = list_system_proxy_pool_options(conn, owner_user_id=first_id)
            second_options = list_system_proxy_pool_options(conn, owner_user_id=second_id)
            owner_options = list_system_proxy_pool_options(conn, owner_user_id=owner_id)
        self.assertEqual(int(item["owner_user_id"]), owner_id)
        self.assertEqual(int(owner_proxy["user_id"]), owner_id)
        self.assertEqual(str(owner_proxy["purchase_status"]), "owned")
        self.assertEqual([int(row["user_id"]) for row in copies], sorted([owner_id, first_id, second_id]))
        self.assertEqual(
            [row["market_item_id"] for row in first_options if row["ownership_type"] == "owned"],
            ["owned_proxy_item_share1"],
        )
        self.assertEqual(
            [row["market_item_id"] for row in second_options if row["ownership_type"] == "owned"],
            ["owned_proxy_item_share1"],
        )
        self.assertEqual(
            [row["market_item_id"] for row in owner_options if row["ownership_type"] == "owned"],
            ["owned_proxy_item_share1"],
        )

        shared = self.client.post(
            "/api/admin/proxy-market/items",
            json={
                "sku": "SHARED-NO-SHARE",
                "display_name": "共享库存不可再共享",
                "proxy_type": "socks5",
                "host": "203.0.113.30",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
            },
        )
        self.assertEqual(shared.status_code, 200, shared.text)
        refused = self.client.put(
            f"/api/admin/proxy-market/items/{shared.json()['item']['id']}/shares",
            json={"user_ids": [first_id], "confirm_impact": True},
        )
        self.assertEqual(refused.status_code, 409, refused.text)


if __name__ == "__main__":
    unittest.main()
