from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp.auth import require_admin
from webapp.collector_api import create_collector_router


class _Pool:
    def list_accounts(self):
        return [
            {
                "id": "colacct_safe",
                "pool_id": "pool_primary",
                "platform": "threads",
                "username": "collector",
                "display_name": "Collector",
                "status": "ready",
                "health_status": "healthy",
                "capabilities": ["persona.hot_candidates.v1"],
                "leased": False,
                "profile_configured": True,
                "proxy_configured": False,
                "totp_configured": True,
                "cooldown_until": 0,
                "circuit_open_until": 0,
                "consecutive_failures": 0,
                "last_failure_at": 0,
                "last_success_at": 1,
                "last_selected_at": 1,
                "created_at": 1,
                "updated_at": 1,
            }
        ]

    def set_account_state(self, account_id, *, status, health_status):
        return {**self.list_accounts()[0], "id": account_id, "status": status, "health_status": health_status}


class CollectorApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(create_collector_router())
        app.dependency_overrides[require_admin] = lambda: {"id": 1, "is_admin": 1}
        self.client = TestClient(app)

    def test_overview_returns_only_safe_account_projection(self) -> None:
        with patch("webapp.collector_api._collector_pool", return_value=_Pool()):
            response = self.client.get("/api/admin/collector/overview")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["account_count"], 1)
        serialized = response.text.lower()
        for forbidden in ("profile_dir", "login_password", "ciphertext", "cookie", "totp_secret"):
            self.assertNotIn(forbidden, serialized)

    def test_state_update_uses_safe_projection(self) -> None:
        with patch("webapp.collector_api._collector_pool", return_value=_Pool()):
            response = self.client.patch(
                "/api/admin/collector/accounts/colacct_safe/state",
                json={"status": "disabled", "health_status": "operator_disabled"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["account"]["status"], "disabled")


if __name__ == "__main__":
    unittest.main()
