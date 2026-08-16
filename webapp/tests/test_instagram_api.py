import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

from webapp import instagram_api
from webapp.db import db, init_db


class InstagramApiTests(unittest.TestCase):
    def setUp(self):
        self._old_env = {
            key: os.environ.get(key)
            for key in (
                "APP_DB_PATH",
                "PASSWORD_VAULT_KEY",
                "INSTAGRAM_APP_ID",
                "INSTAGRAM_APP_SECRET",
                "INSTAGRAM_REDIRECT_URI",
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
                VALUES ('instagram-owner', 'hash', 0, 'approved', 1, 1)
                """
            )
            self.user_id = int(cursor.lastrowid)
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, display_name,
                  profile_dir, status, created_at, updated_at
                ) VALUES ('instagram-account', ?, '', 'instagram', 'creator', '',
                  'profiles/instagram-account', 'ready', 1, 1)
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

    def test_authorization_url_uses_instagram_business_scopes(self):
        os.environ["INSTAGRAM_APP_ID"] = "app-id"
        os.environ["INSTAGRAM_APP_SECRET"] = "app-secret"
        os.environ["INSTAGRAM_REDIRECT_URI"] = "https://console.example/api/instagram/oauth/callback"

        url = instagram_api.authorization_url("state-value")

        self.assertTrue(url.startswith("https://www.instagram.com/oauth/authorize?"))
        self.assertIn("client_id=app-id", url)
        self.assertIn("instagram_business_basic", url)
        self.assertIn("state=state-value", url)

    @patch("webapp.instagram_api._paginated_media")
    @patch("webapp.instagram_api.fetch_profile")
    def test_collect_account_data_normalizes_profile_and_media(self, profile, media):
        profile.return_value = {
            "id": "user-1",
            "username": "creator",
            "followers_count": 12,
            "follows_count": 3,
            "media_count": 1,
        }
        media.return_value = [{
            "id": "post-1",
            "username": "creator",
            "caption": "hello",
            "permalink": "https://www.instagram.com/p/post-1/",
            "like_count": 4,
            "comments_count": 2,
        }]

        result = instagram_api.collect_account_data("token")

        self.assertEqual(result["normalized"]["username"], "creator")
        self.assertEqual(result["normalized"]["followers"], 12)
        self.assertEqual(result["normalized"]["likes"], 4)
        self.assertEqual(result["normalized"]["comments"], 2)

    @patch("webapp.instagram_api.collect_account_data")
    def test_credentials_are_encrypted_and_snapshot_is_saved(self, collect_account_data):
        collect_account_data.return_value = {
            "normalized": {"platform": "instagram", "postMetrics": [], "refreshedAt": "2026-08-16T00:00:00Z"}
        }
        instagram_api.save_credential(
            account_id="instagram-account",
            user_id=self.user_id,
            platform_user_id="platform-user",
            access_token="secret-token",
            scopes=("instagram_business_basic",),
            expires_in=30 * 86400,
        )

        result = instagram_api.sync_account("instagram-account", self.user_id)

        with db() as conn:
            credential = conn.execute(
                "SELECT * FROM social_account_api_credentials WHERE account_id = 'instagram-account'"
            ).fetchone()
            snapshot = conn.execute(
                "SELECT * FROM social_account_api_snapshots WHERE account_id = 'instagram-account'"
            ).fetchone()
        self.assertNotIn("secret-token", str(credential["access_token_ciphertext"]))
        self.assertIsNotNone(snapshot)
        self.assertEqual(result["normalized"]["accountId"], "instagram-account")


if __name__ == "__main__":
    unittest.main()
