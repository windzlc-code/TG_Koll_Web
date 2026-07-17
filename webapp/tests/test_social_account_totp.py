import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import webapp.server as server
from webapp import governance, social_automation_api


class SocialAccountTotpApiTests(unittest.TestCase):
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
    ADMIN_PASSWORD = "social-totp-admin-secret"
    CUSTOMER_PASSWORD = "social-totp-customer-secret"
    TOTP_SECRET = "JBSWY3DPEHPK3PXP"
    TOTP_PATH = "/api/persona_dashboard/automation/accounts/{account_id}/totp"

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
        admin_login = self.admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(admin_login.status_code, 200, admin_login.text)
        self.admin.headers["X-Admin-Console"] = "1"

        self.owner, self.owner_id = self._create_customer("totp_owner")
        self.other, self.other_id = self._create_customer("totp_other")
        self.account = self._create_account(self.owner_id, "totp_owner_account")

    def tearDown(self):
        self.owner.close()
        self.other.close()
        self.admin.close()
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

    def _create_customer(self, username: str) -> tuple[TestClient, int]:
        applicant = TestClient(self.app)
        try:
            applied = applicant.post(
                "/api/auth/apply",
                json={
                    "username": username,
                    "password": self.CUSTOMER_PASSWORD,
                    "full_name": f"{username} customer",
                    "email": f"{username}@example.com",
                    "phone": "0912345678",
                    "company": "TOTP Test",
                    "use_case": "Social account TOTP regression",
                },
            )
            self.assertEqual(applied.status_code, 200, applied.text)
            user_id = int(applied.json()["id"])
        finally:
            applicant.close()

        approved = self.admin.post(
            f"/api/admin/users/{user_id}/approval",
            json={
                "approval_status": "approved",
                "expected_approval_status": "pending",
            },
        )
        self.assertEqual(approved.status_code, 200, approved.text)

        customer = TestClient(self.app)
        login = customer.post(
            "/api/auth/user-login",
            json={"username": username, "password": self.CUSTOMER_PASSWORD},
        )
        self.assertEqual(login.status_code, 200, login.text)
        return customer, user_id

    def _create_account(self, owner_user_id: int, username: str) -> dict:
        return social_automation_api.create_social_account(
            social_automation_api.SocialAccountPayload(
                platform="threads",
                username=username,
                login_username=f"{username}@example.com",
                login_password="saved-login-password",
            ),
            owner_user_id=owner_user_id,
            billing_admin_waived=True,
        )

    def _totp_path(self, account_id: str | None = None) -> str:
        return self.TOTP_PATH.format(account_id=account_id or self.account["id"])

    def _configure_totp(self, client: TestClient | None = None, *, secret: str | None = None, headers=None):
        return (client or self.owner).put(
            self._totp_path(),
            json={"secret_or_uri": secret or self.TOTP_SECRET},
            headers=headers,
        )

    @staticmethod
    def _serialized(value) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)

    def _assert_no_totp_material(self, value, *materials: str) -> None:
        serialized = self._serialized(value)
        for material in (self.TOTP_SECRET, *materials):
            if material:
                self.assertNotIn(material, serialized)
        lowered = serialized.lower()
        self.assertNotIn("totp_secret", lowered)
        self.assertNotIn("secret_ciphertext", lowered)

    def _assert_plaintext_absent_from_database(self, plaintext: str) -> None:
        with sqlite3.connect(os.environ["APP_DB_PATH"]) as conn:
            tables = [
                str(row[0])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            ]
            for table in tables:
                rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
                for row in rows:
                    self.assertNotIn(
                        plaintext,
                        "\n".join(str(value) for value in row if value is not None),
                        f"plaintext TOTP secret leaked into {table}",
                    )

    def test_put_encrypts_secret_and_public_account_only_exposes_metadata(self):
        configured = self._configure_totp()

        self.assertEqual(configured.status_code, 200, configured.text)
        self.assertIn("no-store", configured.headers.get("cache-control", "").lower())
        self._assert_no_totp_material(configured.json())
        self._assert_plaintext_absent_from_database(self.TOTP_SECRET)

        listed = self.owner.get("/api/persona_dashboard/automation/accounts")
        self.assertEqual(listed.status_code, 200, listed.text)
        account = next(item for item in listed.json()["accounts"] if item["id"] == self.account["id"])
        self.assertTrue(account["totp_configured"])
        self.assertEqual(account["totp_status"], "pending")
        self.assertEqual(
            {key for key in account if key.startswith("totp_")},
            {
                "totp_configured",
                "totp_status",
                "totp_updated_at",
                "totp_last_verified_at",
            },
        )
        self.assertNotIn("current_code", account)
        self._assert_no_totp_material(account)

    def test_current_code_is_valid_no_store_and_delete_clears_configuration(self):
        configured = self._configure_totp()
        self.assertEqual(configured.status_code, 200, configured.text)

        current = self.owner.get(f"{self._totp_path()}/code")

        self.assertEqual(current.status_code, 200, current.text)
        self.assertIn("no-store", current.headers.get("cache-control", "").lower())
        code = str(current.json()["current_code"]["code"])
        self.assertRegex(code, r"^\d{6}$")
        self.assertTrue(governance.verify_totp(self.TOTP_SECRET, code))
        self._assert_no_totp_material(current.json(), self.TOTP_SECRET)

        deleted = self.owner.delete(self._totp_path())
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self._assert_no_totp_material(deleted.json())

        listed = self.owner.get("/api/persona_dashboard/automation/accounts")
        account = next(item for item in listed.json()["accounts"] if item["id"] == self.account["id"])
        self.assertFalse(account["totp_configured"])
        self.assertEqual(account["totp_status"], "not_configured")
        missing = self.owner.get(f"{self._totp_path()}/code")
        self.assertIn(missing.status_code, {404, 409}, missing.text)

    def test_automatic_totp_reservation_requires_at_least_fifteen_seconds(self):
        configured = self._configure_totp()
        self.assertEqual(configured.status_code, 200, configured.text)

        with mock.patch.object(social_automation_api.time, "time", return_value=1006):
            period_ending = social_automation_api._reserve_social_account_totp_code(
                self.account["id"],
                self.owner_id,
            )

        self.assertFalse(period_ending["available"])
        self.assertEqual(period_ending["reason"], "period_ending")
        self.assertEqual(period_ending["wait_seconds"], 15)

        with mock.patch.object(social_automation_api.time, "time", return_value=1005):
            reservation = social_automation_api._reserve_social_account_totp_code(
                self.account["id"],
                self.owner_id,
            )

        self.assertTrue(reservation["available"])
        self.assertEqual(reservation["valid_for_seconds"], 15)
        self.assertRegex(str(reservation["code"]), r"^\d{6}$")

    def test_owner_isolation_and_targeted_admin_access_apply_to_all_totp_actions(self):
        configured = self._configure_totp()
        self.assertEqual(configured.status_code, 200, configured.text)
        replacement_secret = "KRSXG5DSNFXGOIDB"

        for method, path, kwargs in (
            ("get", f"{self._totp_path()}/code", {}),
            ("put", self._totp_path(), {"json": {"secret_or_uri": replacement_secret}}),
            ("delete", self._totp_path(), {}),
        ):
            response = getattr(self.other, method)(path, **kwargs)
            self.assertEqual(response.status_code, 404, response.text)

        own_admin = self.admin.get(f"{self._totp_path()}/code")
        self.assertEqual(own_admin.status_code, 404, own_admin.text)

        target_headers = {"X-Admin-Workspace-User-ID": str(self.owner_id)}
        replaced = self._configure_totp(self.admin, secret=replacement_secret, headers=target_headers)
        self.assertEqual(replaced.status_code, 200, replaced.text)
        admin_code = self.admin.get(f"{self._totp_path()}/code", headers=target_headers)
        self.assertEqual(admin_code.status_code, 200, admin_code.text)
        self.assertTrue(
            governance.verify_totp(
                replacement_secret,
                str(admin_code.json()["current_code"]["code"]),
            )
        )
        removed = self.admin.delete(self._totp_path(), headers=target_headers)
        self.assertEqual(removed.status_code, 200, removed.text)

    def test_secret_never_appears_in_account_task_or_log_responses(self):
        configured = self._configure_totp()
        self.assertEqual(configured.status_code, 200, configured.text)

        task = social_automation_api.create_social_task(
            social_automation_api.SocialTaskPayload(
                account_id=self.account["id"],
                platform="threads",
                task_type="open_login",
                payload={"auto_submit": True},
            ),
            billing_admin_waived=True,
        )
        responses = [
            self.owner.get("/api/persona_dashboard/automation/accounts"),
            self.owner.get("/api/persona_dashboard/automation/tasks"),
            self.owner.get(f"/api/persona_dashboard/automation/tasks/{task['id']}"),
            self.owner.get(f"/api/persona_dashboard/automation/tasks/{task['id']}/logs"),
        ]
        for response in responses:
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotIn("current_code", self._serialized(response.json()))
            self._assert_no_totp_material(response.json())

    def test_inconclusive_submission_preserves_verified_totp_status(self):
        configured = self._configure_totp()
        self.assertEqual(configured.status_code, 200, configured.text)

        self.assertTrue(
            social_automation_api._record_social_account_totp_outcome(
                self.account["id"],
                self.owner_id,
                "verified",
            )
        )
        self.assertTrue(
            social_automation_api._record_social_account_totp_outcome(
                self.account["id"],
                self.owner_id,
                "failed",
            )
        )
        with sqlite3.connect(os.environ["APP_DB_PATH"]) as conn:
            row = conn.execute(
                """
                SELECT status, last_error
                FROM social_account_totp_secrets
                WHERE account_id = ? AND user_id = ?
                """,
                (self.account["id"], self.owner_id),
            ).fetchone()
        self.assertEqual(row, ("verified", "verification_inconclusive"))

        self.assertTrue(
            social_automation_api._record_social_account_totp_outcome(
                self.account["id"],
                self.owner_id,
                "rejected",
            )
        )
        with sqlite3.connect(os.environ["APP_DB_PATH"]) as conn:
            row = conn.execute(
                """
                SELECT status, last_error
                FROM social_account_totp_secrets
                WHERE account_id = ? AND user_id = ?
                """,
                (self.account["id"], self.owner_id),
            ).fetchone()
        self.assertEqual(row, ("error", "code_rejected"))


if __name__ == "__main__":
    unittest.main()
