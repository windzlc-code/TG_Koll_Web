import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module, governance
import webapp.server as server


class PersonalSettingsSecurityTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in (
            "APP_DB_PATH",
            "APP_RUNTIME_CONFIG_PATH",
            "WEBAPP_DATA_DIR",
            "ADMIN_BOOTSTRAP_PASSWORD",
            "SESSION_COOKIE_SECURE",
            "PASSWORD_VAULT_KEY",
            "AUTH_VERIFICATION_SECRET",
        )}
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.tmpdir = tempfile.TemporaryDirectory()
        data_dir = Path(self.tmpdir.name)
        os.environ.update({
            "WEBAPP_DATA_DIR": str(data_dir),
            "APP_DB_PATH": str(data_dir / "app.db"),
            "APP_RUNTIME_CONFIG_PATH": str(data_dir / "runtime.json"),
            "ADMIN_BOOTSTRAP_PASSWORD": "admin123secure",
            "SESSION_COOKIE_SECURE": "0",
            "PASSWORD_VAULT_KEY": Fernet.generate_key().decode("ascii"),
            "AUTH_VERIFICATION_SECRET": "personal-settings-test-secret-32-bytes",
        })
        server.RUNTIME_CONFIG_PATH = data_dir / "runtime.json"
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        self.app = server.create_app()
        self.client = TestClient(self.app)
        now = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, approval_status, email, created_at, updated_at
                ) VALUES (?, ?, 'approved', ?, ?, ?)
                """,
                ("security_user", server.hash_password("security123"), "old@example.com", now, now),
            )
            user_id = int(conn.execute("SELECT id FROM users WHERE username = 'security_user'").fetchone()["id"])
            conn.execute(
                """
                INSERT INTO user_auth_emails(
                  user_id, email_normalized, email_original, verified_at,
                  is_primary, login_enabled, source, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 1, 1, 'test', ?, ?)
                """,
                (user_id, "old@example.com", "old@example.com", now, now, now),
            )
        login = self.client.post("/api/auth/login", json={"username": "security_user", "password": "security123"})
        self.assertEqual(login.status_code, 200, login.text)

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    @staticmethod
    def delivered_code(send_mock):
        return str(send_mock.call_args.args[1])

    @mock.patch("webapp.server.email_delivery_available", return_value=True)
    @mock.patch("webapp.server.send_verification_email")
    def test_email_binding_and_email_2fa_login_round_trip(self, send_mock, _available_mock):
        sent = self.client.post(
            "/api/auth/email-verification/send",
            json={"email": "new@example.com", "purpose": "email_binding"},
        )
        self.assertEqual(sent.status_code, 200, sent.text)
        pending = self.client.get("/api/me")
        self.assertEqual(pending.json()["verified_email"], "old@example.com")

        rejected = self.client.post(
            "/api/auth/email-binding/confirm",
            json={
                "email": "new@example.com",
                "challenge_id": sent.json()["challenge_id"],
                "verification_code": "000000",
            },
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(rejected.status_code, 400, rejected.text)
        unchanged = self.client.get("/api/me")
        self.assertEqual(unchanged.json()["verified_email"], "old@example.com")

        confirmed = self.client.post(
            "/api/auth/email-binding/confirm",
            json={
                "email": "new@example.com",
                "challenge_id": sent.json()["challenge_id"],
                "verification_code": self.delivered_code(send_mock),
            },
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        me = self.client.get("/api/me")
        self.assertEqual(me.json()["verified_email"], "new@example.com")

        enabled = self.client.put(
            "/api/auth/email-2fa",
            json={"enabled": True, "current_password": "security123"},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(enabled.status_code, 200, enabled.text)
        self.assertTrue(enabled.json()["enabled"])
        self.client.post("/api/auth/logout")

        send_mock.reset_mock()
        challenged = self.client.post(
            "/api/auth/login",
            json={"username": "security_user", "password": "security123", "device_id": "same-device"},
        )
        self.assertEqual(challenged.status_code, 409, challenged.text)
        verification = challenged.json()["detail"]["verification"]
        completed = self.client.post(
            "/api/auth/login",
            json={
                "username": "security_user",
                "password": "security123",
                "device_id": "same-device",
                "security_verification_method": "email",
                "security_challenge_id": verification["challenge_id"],
                "security_verification_code": self.delivered_code(send_mock),
            },
        )
        self.assertEqual(completed.status_code, 200, completed.text)

    def test_self_delete_soft_deletes_and_revokes_session(self):
        deleted = self.client.request(
            "DELETE",
            "/api/auth/account",
            json={"current_password": "security123", "confirmation": "security_user"},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["deleted"])
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT is_disabled, lifecycle_status, lifecycle_reason FROM users WHERE username = 'security_user'"
            ).fetchone()
        self.assertEqual(int(row["is_disabled"]), 1)
        self.assertEqual(str(row["lifecycle_status"]), "deleted")
        self.assertEqual(str(row["lifecycle_reason"]), "self_service_delete")

    def test_mfa_enable_and_disable_round_trip(self):
        setup = self.client.post(
            "/api/auth/mfa/setup",
            json={"current_password": "security123"},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(setup.status_code, 200, setup.text)
        verified = self.client.post(
            "/api/auth/mfa/verify-setup",
            json={"code": governance.totp_code(setup.json()["secret"])},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertTrue(self.client.get("/api/auth/mfa").json()["enabled"])

        disabled = self.client.post(
            "/api/auth/mfa/disable",
            json={
                "current_password": "security123",
                "code": setup.json()["recovery_codes"][0],
            },
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertFalse(self.client.get("/api/auth/mfa").json()["enabled"])


if __name__ == "__main__":
    unittest.main()
