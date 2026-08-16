import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

from webapp import threads_api
from webapp.db import db, init_db


class ThreadsApiTests(unittest.TestCase):
    def setUp(self):
        self._old_env = {
            key: os.environ.get(key)
            for key in (
                "APP_DB_PATH",
                "PASSWORD_VAULT_KEY",
                "THREADS_APP_ID",
                "THREADS_APP_SECRET",
                "THREADS_REDIRECT_URI",
                "HTTPS_CANONICAL_ORIGIN",
            )
        }
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self._tmpdir.name) / "app.db")
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        init_db()
        with db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users(username, password_hash, is_admin, approval_status, created_at, updated_at)
                VALUES ('threads-owner', 'hash', 0, 'approved', 1, 1)
                """
            )
            self.user_id = int(cursor.lastrowid)
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, display_name,
                  profile_dir, status, created_at, updated_at
                ) VALUES ('threads-account', ?, '', 'threads', 'threader', '',
                  'profiles/threads-account', 'ready', 1, 1)
                """,
                (self.user_id,),
            )

    def tearDown(self):
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmpdir.cleanup()

    def test_authorization_url_uses_threads_oauth_and_scopes(self):
        os.environ["THREADS_APP_ID"] = "app-id"
        os.environ["THREADS_APP_SECRET"] = "app-secret"
        os.environ["THREADS_REDIRECT_URI"] = "https://console.example/api/threads/oauth/callback"

        url = threads_api.authorization_url("state-value")

        self.assertTrue(url.startswith("https://threads.net/oauth/authorize?"))
        self.assertIn("client_id=app-id", url)
        self.assertIn("threads_basic", url)
        self.assertIn("threads_profile_discovery", url)
        self.assertIn("state=state-value", url)

    @patch("webapp.threads_api.paginated_get")
    @patch("webapp.threads_api.api_get")
    @patch("webapp.threads_api.fetch_profile")
    def test_collect_account_data_normalizes_official_api_results(self, profile, api_get, paginated_get):
        profile.return_value = {"id": "user-1", "username": "threader"}
        paginated_get.side_effect = lambda path, *_args, **_kwargs: (
            [{"id": "post-1", "username": "threader", "text": "hello", "permalink": "https://threads.net/t/post-1"}]
            if path == "/me/threads"
            else []
        )

        def api_result(path, _token, params=None):
            if path == "/me/threads_insights" and (params or {}).get("metric") == "follower_demographics":
                return {"data": []}
            if path == "/me/threads_insights":
                return {"data": [
                    {"name": "followers_count", "total_value": {"value": 12}},
                    {"name": "clicks", "total_value": {"value": 3}},
                ]}
            if path == "/me/threads_publishing_limit":
                return {"data": [{"quota_usage": 1}]}
            if path == "/post-1/insights":
                return {"data": [
                    {"name": "views", "values": [{"value": 20}]},
                    {"name": "likes", "values": [{"value": 4}]},
                ]}
            raise AssertionError(path)

        api_get.side_effect = api_result
        result = threads_api.collect_account_data("token")

        self.assertEqual(result["normalized"]["username"], "threader")
        self.assertEqual(result["normalized"]["followers"], 12)
        self.assertEqual(result["normalized"]["clicks"], 3)
        self.assertEqual(result["normalized"]["views"], 20)
        self.assertEqual(result["normalized"]["likes"], 4)
        self.assertIn("country", result["follower_demographics"])

    @patch("webapp.threads_api.collect_account_data")
    def test_credentials_are_encrypted_and_snapshot_is_saved(self, collect_account_data):
        collect_account_data.return_value = {
            "normalized": {"platform": "threads", "postMetrics": [], "refreshedAt": "2026-08-16T00:00:00Z"}
        }
        threads_api.save_credential(
            account_id="threads-account",
            user_id=self.user_id,
            platform_user_id="platform-user",
            access_token="secret-token",
            scopes=("threads_basic",),
            expires_in=30 * 86400,
        )

        result = threads_api.sync_account("threads-account", self.user_id)

        with db() as conn:
            credential = conn.execute(
                "SELECT * FROM social_account_api_credentials WHERE account_id = 'threads-account'"
            ).fetchone()
            snapshot = conn.execute(
                "SELECT * FROM social_account_api_snapshots WHERE account_id = 'threads-account'"
            ).fetchone()
            public = threads_api.account_api_public_rows(conn, {"threads-account"})
        self.assertNotIn("secret-token", str(credential["access_token_ciphertext"]))
        self.assertIsNotNone(snapshot)
        self.assertEqual(result["normalized"]["accountId"], "threads-account")
        self.assertTrue(public["threads-account"]["api_connected"])


if __name__ == "__main__":
    unittest.main()
