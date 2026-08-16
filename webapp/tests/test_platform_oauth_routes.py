import hashlib
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp.auth import get_current_user
from webapp.db import db, init_db
from webapp.social_automation_api import register_social_automation_routes


class PlatformOauthRouteTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self._tmpdir.name) / "app.db")
        init_db()
        with db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users(username, password_hash, is_admin, approval_status, created_at, updated_at)
                VALUES ('oauth-owner', 'hash', 0, 'approved', 1, 1)
                """
            )
            self.user_id = int(cursor.lastrowid)
        self.app = FastAPI()
        register_social_automation_routes(self.app)
        self.app.dependency_overrides[get_current_user] = lambda: {
            "id": self.user_id,
            "_workspace_user_id": self.user_id,
            "_workspace_admin_user_id": 99,
        }
        self.client = TestClient(self.app)

    def tearDown(self):
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        self._tmpdir.cleanup()

    @patch("webapp.social_automation_api.threads_authorization_url", return_value="https://threads.example/authorize")
    @patch("webapp.social_automation_api.threads_api_settings")
    def test_admin_start_keeps_workspace_return_path(self, _settings, _authorization_url):
        response = self.client.get(
            f"/api/threads/oauth/start?admin_console=1&admin_workspace_user_id={self.user_id}",
            follow_redirects=False,
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "https://threads.example/authorize")
        with db() as conn:
            flow = conn.execute("SELECT * FROM social_oauth_flows WHERE platform = 'threads'").fetchone()
        self.assertIn("/admin-console.html?view=accounts", str(flow["return_path"]))
        self.assertIn("admin_console=1", str(flow["return_path"]))
        self.assertIn(f"admin_workspace_user_id={self.user_id}", str(flow["return_path"]))

    def test_callback_uses_state_owner_without_browser_session(self):
        state = "returned-state"
        digest = hashlib.sha256(state.encode("utf-8")).hexdigest()
        return_path = (
            "/admin-console.html?view=accounts&admin_console=1"
            f"&admin_workspace_user_id={self.user_id}"
        )
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_oauth_flows(
                  state_digest, user_id, platform, persona_id, return_path,
                  expires_at, consumed_at, created_at
                ) VALUES (?, ?, 'instagram', '', ?, ?, 0, ?)
                """,
                (digest, self.user_id, return_path, int(time.time()) + 600, int(time.time())),
            )

        anonymous = TestClient(self.app)
        response = anonymous.get(
            f"/api/instagram/oauth/callback?state={state}&error=access_denied",
            follow_redirects=False,
        )

        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin-console.html?view=accounts", response.headers["location"])
        self.assertIn("instagram_oauth=error", response.headers["location"])
        with db() as conn:
            flow = conn.execute(
                "SELECT consumed_at FROM social_oauth_flows WHERE state_digest = ?",
                (digest,),
            ).fetchone()
        self.assertGreater(int(flow["consumed_at"]), 0)


if __name__ == "__main__":
    unittest.main()
