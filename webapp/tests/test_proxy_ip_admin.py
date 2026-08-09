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


if __name__ == "__main__":
    unittest.main()
