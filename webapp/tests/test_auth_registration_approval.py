import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module, governance
import webapp.server as server


class RegistrationApprovalTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in (
            "APP_DB_PATH", "APP_RUNTIME_CONFIG_PATH", "WEBAPP_DATA_DIR",
            "ADMIN_BOOTSTRAP_PASSWORD", "SESSION_COOKIE_SECURE",
            "PASSWORD_VAULT_KEY", "PASSWORD_VAULT_KEY_FILE",
        )}
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmpdir.name)
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "admin123secure"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        self.app = server.create_app()
        self._admin_mfa_secret = ""
        self._admin_recovery_codes: list[str] = []
        self._admin_step_up_count = 0

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    @staticmethod
    def application_payload():
        return {
            "username": "guest001",
            "password": "guest123",
            "full_name": "测试访客",
            "email": "guest@example.com",
            "phone": "0912345678",
            "company": "Vecto Test",
            "use_case": "OPC 导入测试",
        }

    def admin_step_up(self, admin: TestClient, reason: str = "security regression") -> dict[str, str]:
        if not self._admin_mfa_secret:
            setup = admin.post(
                "/api/auth/mfa/setup",
                headers={"Origin": "http://testserver", "X-Admin-Console": "1"},
                json={"current_password": "admin123secure"},
            )
            self.assertEqual(setup.status_code, 200, setup.text)
            self._admin_mfa_secret = str(setup.json()["secret"])
            self._admin_recovery_codes = [str(code) for code in setup.json()["recovery_codes"]]
            verified = admin.post(
                "/api/auth/mfa/verify-setup",
                headers={"Origin": "http://testserver", "X-Admin-Console": "1"},
                json={"code": governance.totp_code(self._admin_mfa_secret)},
            )
            self.assertEqual(verified.status_code, 200, verified.text)
        code = governance.totp_code(self._admin_mfa_secret) if self._admin_step_up_count == 0 else self._admin_recovery_codes.pop(0)
        self._admin_step_up_count += 1
        return {
            "admin_password": "admin123secure",
            "totp_code": code,
            "reason": reason,
        }

    def test_pending_application_has_no_session_and_cannot_login(self):
        client = TestClient(self.app)
        response = client.post("/api/auth/apply", json=self.application_payload())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["approval_status"], "pending")
        self.assertNotIn("session_token", response.cookies)

        login = client.post("/api/auth/login", json={"username": "guest001", "password": "guest123"})
        self.assertEqual(login.status_code, 403)
        self.assertIn("等待管理员授权", login.json()["detail"])
        with db_module.db() as conn:
            user = conn.execute("SELECT * FROM users WHERE username = ?", ("guest001",)).fetchone()
            sessions = conn.execute("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", (int(user["id"]),)).fetchone()
        self.assertEqual(user["approval_status"], "pending")
        self.assertEqual(user["full_name"], "测试访客")
        self.assertEqual(int(sessions["count"]), 0)

    def test_registration_and_admin_creation_enforce_role_password_minimums(self):
        short_application = self.application_payload()
        short_application["username"] = "short-password"
        short_application["password"] = "seven77"
        rejected_application = TestClient(self.app).post("/api/auth/apply", json=short_application)
        self.assertEqual(rejected_application.status_code, 400, rejected_application.text)

        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        rejected_user = admin.post(
            "/api/admin/users",
            json={"username": "short-user", "password": "seven77", "is_admin": False},
        )
        rejected_admin = admin.post(
            "/api/admin/users",
            json={"username": "short-admin", "password": "elevenchars", "is_admin": True},
        )
        self.assertEqual(rejected_user.status_code, 400, rejected_user.text)
        self.assertEqual(rejected_admin.status_code, 400, rejected_admin.text)

    def test_application_password_is_encrypted_and_only_revealed_by_admin_post(self):
        password = "vault-pass-123"
        payload = self.application_payload()
        payload["username"] = "vault-applicant"
        payload["password"] = password
        applied = TestClient(self.app).post("/api/auth/apply", json=payload)
        self.assertEqual(applied.status_code, 200, applied.text)
        user_id = int(applied.json()["id"])

        with db_module.db() as conn:
            vault_row = conn.execute(
                "SELECT ciphertext FROM password_vault WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        self.assertIsNotNone(vault_row)
        ciphertext = str(vault_row["ciphertext"])
        self.assertNotEqual(ciphertext, password)
        self.assertNotIn(password, ciphertext)

        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        detail = admin.get(f"/api/admin/users/{user_id}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["user"]["password_reveal_status"], "available")
        self.assertTrue(detail.json()["user"]["password_reveal_available"])
        self.assertNotIn("ciphertext", detail.text)
        self.assertNotIn(password, detail.text)
        listing = admin.get("/api/admin/users")
        self.assertNotIn("ciphertext", listing.text)
        self.assertNotIn(password, listing.text)
        step_up = self.admin_step_up(admin, "reveal customer password")

        self.assertEqual(admin.get(f"/api/admin/users/{user_id}/reveal-password").status_code, 405)
        self.assertEqual(admin.post(f"/api/admin/users/{user_id}/reveal-password", json=step_up).status_code, 403)
        self.assertEqual(
            admin.post(
                f"/api/admin/users/{user_id}/reveal-password",
                headers={"Origin": "https://attacker.example"},
                json=step_up,
            ).status_code,
            403,
        )
        revealed = admin.post(
            f"/api/admin/users/{user_id}/reveal-password",
            headers={"Origin": "http://testserver"},
            json=step_up,
        )
        self.assertEqual(revealed.status_code, 200, revealed.text)
        self.assertEqual(revealed.json()["password"], password)
        self.assertGreater(revealed.json()["reveal_expires_at"], server._now_ts())
        self.assertIn("no-store", revealed.headers["cache-control"])
        self.assertEqual(revealed.headers["pragma"], "no-cache")

        with db_module.db() as conn:
            audit = conn.execute(
                "SELECT metadata_json FROM admin_audit_log WHERE action = ? AND target_user_id = ? "
                "ORDER BY id DESC LIMIT 1",
                ("user.password_reveal", user_id),
            ).fetchone()
        self.assertIsNotNone(audit)
        self.assertEqual(json.loads(str(audit["metadata_json"]))["outcome"], "success")
        self.assertNotIn(password, str(audit["metadata_json"]))

    def test_historical_and_admin_passwords_are_not_revealable(self):
        now = server._now_ts()
        with db_module.db() as conn:
            inserted = conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, is_admin, is_disabled, balance_cents,
                  account_type, approval_status, created_at, updated_at
                ) VALUES (?, ?, 0, 0, 0, 'managed', 'approved', ?, ?)
                """,
                ("historical-user", server.hash_password("historical123"), now, now),
            )
            historical_id = int(inserted.lastrowid)

        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        detail = admin.get(f"/api/admin/users/{historical_id}")
        self.assertEqual(detail.json()["user"]["password_reveal_status"], "unavailable")
        self.assertFalse(detail.json()["user"]["password_reveal_available"])
        step_up = self.admin_step_up(admin, "verify historical password state")
        unavailable = admin.post(
            f"/api/admin/users/{historical_id}/reveal-password",
            headers={"Origin": "http://testserver"},
            json=step_up,
        )
        self.assertEqual(unavailable.status_code, 404, unavailable.text)
        self.assertEqual(unavailable.json()["detail"]["code"], "password_unavailable")
        self.assertIn("no-store", unavailable.headers["cache-control"])

        admin_detail = admin.get("/api/admin/users/1")
        self.assertEqual(admin_detail.json()["user"]["password_reveal_status"], "prohibited")
        prohibited = admin.post(
            "/api/admin/users/1/reveal-password",
            headers={"Origin": "http://testserver"},
            json=self.admin_step_up(admin, "verify admin password prohibition"),
        )
        self.assertEqual(prohibited.status_code, 403, prohibited.text)
        self.assertEqual(prohibited.json()["detail"]["code"], "admin_password_not_revealable")

    def test_missing_vault_key_fails_without_creating_account_or_key_file(self):
        configured_key = os.environ.pop("PASSWORD_VAULT_KEY")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        key_path = self.data_dir / "password_vault.key"
        payload = self.application_payload()
        payload["username"] = "missing-vault-key"
        try:
            response = TestClient(self.app).post("/api/auth/apply", json=payload)
            self.assertEqual(response.status_code, 503, response.text)
            self.assertEqual(response.json()["detail"]["code"], "password_vault_unavailable")
            self.assertFalse(key_path.exists())
            with db_module.db() as conn:
                row = conn.execute(
                    "SELECT id FROM users WHERE username = ?",
                    ("missing-vault-key",),
                ).fetchone()
            self.assertIsNone(row)
        finally:
            os.environ["PASSWORD_VAULT_KEY"] = configured_key

    def test_changed_key_file_does_not_get_overwritten_or_expose_ciphertext(self):
        configured_key = os.environ.pop("PASSWORD_VAULT_KEY")
        key_path = self.data_dir / "configured-vault.key"
        original_key = Fernet.generate_key()
        replacement_key = Fernet.generate_key()
        key_path.write_bytes(original_key)
        os.environ["PASSWORD_VAULT_KEY_FILE"] = str(key_path)
        try:
            payload = self.application_payload()
            payload["username"] = "key-change-user"
            payload["password"] = "key-change-password"
            applied = TestClient(self.app).post("/api/auth/apply", json=payload)
            self.assertEqual(applied.status_code, 200, applied.text)

            key_path.write_bytes(replacement_key)
            admin = TestClient(self.app)
            self.assertEqual(
                admin.post(
                    "/api/auth/admin-login",
                    json={"username": "admin", "password": "admin123secure"},
                ).status_code,
                200,
            )
            response = admin.post(
                f"/api/admin/users/{applied.json()['id']}/reveal-password",
                headers={"Origin": "http://testserver"},
                json=self.admin_step_up(admin, "test unavailable vault key"),
            )
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], "password_unavailable")
            self.assertNotIn("key-change-password", response.text)
            self.assertEqual(key_path.read_bytes(), replacement_key)
        finally:
            os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
            os.environ["PASSWORD_VAULT_KEY"] = configured_key

    def test_admin_can_review_and_approve_then_user_can_open_console(self):
        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        user_id = applied.json()["id"]

        admin = TestClient(self.app)
        admin_login = admin.post("/api/auth/admin-login", json={"username": "admin", "password": "admin123secure"})
        self.assertEqual(admin_login.status_code, 200)
        self.assertTrue(admin_login.json()["is_admin"])

        detail = admin.get(f"/api/admin/users/{user_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["user"]["email"], "guest@example.com")
        self.assertNotIn("password_hash", detail.json()["user"])

        approved = admin.post(
            f"/api/admin/users/{user_id}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending", "admin_note": "资料已核对"},
        )
        self.assertEqual(approved.status_code, 200)

        user_client = TestClient(self.app)
        login = user_client.post("/api/auth/login", json={"username": "guest001", "password": "guest123"})
        self.assertEqual(login.status_code, 200)
        self.assertFalse(login.json()["is_admin"])
        original_cookie = user_client.cookies.get("session_token")

        console = user_client.get("/console.html", follow_redirects=False)
        self.assertEqual(console.status_code, 200)
        self.assertEqual(user_client.cookies.get("session_token"), original_cookie)
        me = user_client.get("/api/me")
        self.assertEqual(me.json()["username"], "guest001")
        self.assertFalse(me.json()["is_admin"])
        self.assertEqual(user_client.get("/api/admin/users").status_code, 401)

    def test_console_requires_login(self):
        response = TestClient(self.app).get("/console.html", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/login.html")

    def test_admin_can_reset_user_password_and_revoke_existing_sessions(self):
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        created = admin.post(
            "/api/admin/users",
            json={"username": "managed001", "password": "oldpass123", "is_admin": False, "balance_cents": 0},
        )
        self.assertEqual(created.status_code, 200)
        created_user = created.json()["user"]
        user_id = int(created_user["id"])

        user = TestClient(self.app)
        self.assertEqual(
            user.post(
                "/api/auth/user-login",
                json={"username": "managed001", "password": "oldpass123"},
            ).status_code,
            200,
        )
        self.assertEqual(
            user.post(
                f"/api/admin/users/{user_id}/reset-password",
                json={"expected_updated_at": created_user["updated_at"], "admin_password": "invalid", "totp_code": "000000", "reason": "unauthorized access"},
                headers={"Origin": "http://testserver"},
            ).status_code,
            401,
        )

        detail_before_reset = admin.get(f"/api/admin/users/{user_id}").json()["user"]
        step_up = self.admin_step_up(admin, "manage customer password")
        initial_reveal = admin.post(
            f"/api/admin/users/{user_id}/reveal-password",
            headers={"Origin": "http://testserver"},
            json=step_up,
        )
        self.assertEqual(initial_reveal.status_code, 200, initial_reveal.text)
        self.assertEqual(initial_reveal.json()["password"], "oldpass123")
        self.assertEqual(
            user.post(
                f"/api/admin/users/{user_id}/reveal-password",
                headers={"Origin": "http://testserver"},
                json={"admin_password": "invalid", "totp_code": "000000", "reason": "unauthorized access"},
            ).status_code,
            401,
        )
        reset = admin.post(
            f"/api/admin/users/{user_id}/reset-password",
            json={"expected_updated_at": detail_before_reset["updated_at"], **self.admin_step_up(admin, "reset customer password")},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(reset.status_code, 200)
        self.assertTrue(reset.json()["ok"])
        temporary_password = str(reset.json()["temporary_password"])
        self.assertGreaterEqual(len(temporary_password), 20)
        reset_reveal = admin.post(
            f"/api/admin/users/{user_id}/reveal-password",
            headers={"Origin": "http://testserver"},
            json=self.admin_step_up(admin, "verify reset password"),
        )
        self.assertEqual(reset_reveal.status_code, 200, reset_reveal.text)
        self.assertEqual(reset_reveal.json()["password"], temporary_password)
        self.assertIn("no-store", reset.headers["cache-control"])
        self.assertEqual(reset.headers["pragma"], "no-cache")
        self.assertEqual(user.get("/api/me").status_code, 401)

        old_login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "managed001", "password": "oldpass123"},
        )
        self.assertEqual(old_login.status_code, 401)
        temporary_client = TestClient(self.app)
        new_login = temporary_client.post(
            "/api/auth/user-login",
            json={"username": "managed001", "password": temporary_password},
        )
        self.assertEqual(new_login.status_code, 200)
        self.assertTrue(new_login.json()["must_change_password"])

        self.assertEqual(
            temporary_client.post(
                "/api/auth/user-login",
                json={"username": "managed001", "password": temporary_password},
            ).status_code,
            200,
        )
        self.assertTrue(temporary_client.get("/api/me").json()["must_change_password"])
        restricted_console = temporary_client.get("/console.html", follow_redirects=False)
        self.assertEqual(restricted_console.status_code, 302)
        self.assertEqual(restricted_console.headers["location"], "/change-password.html")
        self.assertEqual(temporary_client.get("/change-password.html").status_code, 200)
        blocked = temporary_client.get("/api/persona_dashboard/overview")
        self.assertEqual(blocked.status_code, 428, blocked.text)
        self.assertEqual(blocked.json()["detail"]["code"], "password_change_required")
        short_change = temporary_client.post(
            "/api/auth/change_password",
            json={"old_password": temporary_password, "new_password": "seven77"},
        )
        self.assertEqual(short_change.status_code, 400, short_change.text)
        changed = temporary_client.post(
            "/api/auth/change_password",
            json={"old_password": temporary_password, "new_password": "permanent123"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        changed_reveal = admin.post(
            f"/api/admin/users/{user_id}/reveal-password",
            headers={"Origin": "http://testserver"},
            json=self.admin_step_up(admin, "verify changed password"),
        )
        self.assertEqual(changed_reveal.status_code, 200, changed_reveal.text)
        self.assertEqual(changed_reveal.json()["password"], "permanent123")
        self.assertFalse(temporary_client.get("/api/me").json()["must_change_password"])
        completed_change_page = temporary_client.get("/change-password.html", follow_redirects=False)
        self.assertEqual(completed_change_page.status_code, 302)
        self.assertEqual(completed_change_page.headers["location"], "/console.html")
        self.assertEqual(temporary_client.get("/console.html").status_code, 200)
        self.assertEqual(temporary_client.get("/api/persona_dashboard/overview").status_code, 200)

        detail = admin.get(f"/api/admin/users/{user_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertNotIn("password", detail.json()["user"])
        self.assertNotIn("password_hash", detail.json()["user"])
        listing = admin.get("/api/admin/users")
        self.assertNotIn(temporary_password, listing.text)

    def test_password_reset_requires_same_origin_and_rejects_stale_version(self):
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        created = admin.post(
            "/api/admin/users",
            json={"username": "reset-version", "password": "oldpass123", "is_admin": False},
        ).json()["user"]
        user_id = int(created["id"])
        expected_updated_at = int(created["updated_at"])
        payload = {"expected_updated_at": expected_updated_at, **self.admin_step_up(admin, "reset customer password")}

        self.assertEqual(
            admin.post(f"/api/admin/users/{user_id}/reset-password", json=payload).status_code,
            403,
        )
        self.assertEqual(
            admin.post(
                f"/api/admin/users/{user_id}/reset-password",
                json=payload,
                headers={"Origin": "https://attacker.example"},
            ).status_code,
            403,
        )
        first = admin.post(
            f"/api/admin/users/{user_id}/reset-password",
            json=payload,
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(first.status_code, 200, first.text)
        stale = admin.post(
            f"/api/admin/users/{user_id}/reset-password",
            json={**payload, **self.admin_step_up(admin, "verify stale reset version")},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(stale.status_code, 409, stale.text)

        with db_module.db() as conn:
            row = conn.execute(
                "SELECT before_json, after_json FROM audit_events WHERE action = ? AND target_user_id = ?",
                ("user.password_reset", user_id),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(json.loads(str(row["before_json"]))["updated_at"], expected_updated_at)
        self.assertNotIn("password", f"{row['before_json']} {row['after_json']}".lower())

    def test_admin_can_manually_set_user_password_and_revoke_existing_sessions(self):
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        created = admin.post(
            "/api/admin/users",
            json={"username": "manual-password", "password": "oldpass123", "is_admin": False},
        ).json()["user"]
        user_id = int(created["id"])

        user = TestClient(self.app)
        self.assertEqual(
            user.post(
                "/api/auth/user-login",
                json={"username": "manual-password", "password": "oldpass123"},
            ).status_code,
            200,
        )
        detail_before_change = admin.get(f"/api/admin/users/{user_id}").json()["user"]
        step_up = self.admin_step_up(admin, "set customer password")
        payload = {
            "password": "chosen-password-456",
            "expected_updated_at": int(detail_before_change["updated_at"]),
            **step_up,
        }
        self.assertEqual(
            admin.post(f"/api/admin/users/{user_id}/set-password", json=payload).status_code,
            403,
        )
        wrong_confirmation = admin.post(
            f"/api/admin/users/{user_id}/set-password",
            json={**payload, "admin_password": "wrong-admin-password"},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(wrong_confirmation.status_code, 403, wrong_confirmation.text)
        self.assertEqual(
            admin.post(
                f"/api/admin/users/{user_id}/set-password",
                json={
                    **payload,
                    **self.admin_step_up(admin, "reject a short customer password"),
                    "password": "seven77",
                },
                headers={"Origin": "http://testserver"},
            ).status_code,
            400,
        )
        self.assertEqual(
            admin.post(
                f"/api/admin/users/{user_id}/set-password",
                json={
                    **payload,
                    **self.admin_step_up(admin, "reject an oversized customer password"),
                    "password": "x" * 257,
                },
                headers={"Origin": "http://testserver"},
            ).status_code,
            400,
        )
        changed = admin.post(
            f"/api/admin/users/{user_id}/set-password",
            json={**payload, **self.admin_step_up(admin, "set customer password")},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertFalse(changed.json()["must_change_password"])
        self.assertEqual(changed.json()["password_expires_at"], 0)
        self.assertIn("no-store", changed.headers["cache-control"])

        self.assertEqual(user.get("/api/me").status_code, 401)
        self.assertEqual(
            TestClient(self.app).post(
                "/api/auth/user-login",
                json={"username": "manual-password", "password": "oldpass123"},
            ).status_code,
            401,
        )
        new_user = TestClient(self.app)
        new_login = new_user.post(
            "/api/auth/user-login",
            json={"username": "manual-password", "password": "chosen-password-456"},
        )
        self.assertEqual(new_login.status_code, 200, new_login.text)
        self.assertFalse(new_login.json()["must_change_password"])
        self.assertEqual(new_user.get("/console.html").status_code, 200)

        revealed = admin.post(
            f"/api/admin/users/{user_id}/reveal-password",
            headers={"Origin": "http://testserver"},
            json=self.admin_step_up(admin, "verify manually set password"),
        )
        self.assertEqual(revealed.status_code, 200, revealed.text)
        self.assertEqual(revealed.json()["password"], "chosen-password-456")

        stale = admin.post(
            f"/api/admin/users/{user_id}/set-password",
            json={**payload, **self.admin_step_up(admin, "verify stale password version")},
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(stale.status_code, 409, stale.text)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT metadata_json FROM admin_audit_log WHERE action = ? AND target_user_id = ?",
                ("user.password_set", user_id),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertNotIn("chosen-password-456", str(row["metadata_json"]))
        self.assertNotIn("admin123secure", str(row["metadata_json"]))

    def test_expired_temporary_password_cannot_login(self):
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        created = admin.post(
            "/api/admin/users",
            json={"username": "expired-reset", "password": "oldpass123", "is_admin": False},
        ).json()["user"]
        reset = admin.post(
            f"/api/admin/users/{created['id']}/reset-password",
            json={"expected_updated_at": created["updated_at"], **self.admin_step_up(admin, "reset expiring password")},
            headers={"Origin": "http://testserver"},
        )
        temporary_password = reset.json()["temporary_password"]
        with db_module.db() as conn:
            conn.execute(
                "UPDATE users SET password_expires_at = 1 WHERE id = ?",
                (int(created["id"]),),
            )

        expired = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "expired-reset", "password": temporary_password},
        )
        self.assertEqual(expired.status_code, 403, expired.text)
        self.assertEqual(expired.json()["detail"]["code"], "temporary_password_expired")

    def test_admin_user_list_returns_compatible_pagination_metadata(self):
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        for index in range(3):
            created = admin.post(
                "/api/admin/users",
                json={"username": f"paged-{index}", "password": "password123", "is_admin": False},
            )
            self.assertEqual(created.status_code, 200, created.text)

        response = admin.get("/api/admin/users?limit=2&offset=1")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(len(body["items"]), 2)
        self.assertGreaterEqual(body["total"], 4)
        self.assertEqual(body["limit"], 2)
        self.assertEqual(body["offset"], 1)
        self.assertTrue(body["has_more"])

    def test_admin_user_list_filters_roles_and_includes_content_metrics(self):
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        customer = admin.post(
            "/api/admin/users",
            json={"username": "metrics-customer", "password": "password123", "is_admin": False},
        ).json()["user"]
        with db_module.db() as conn:
            now = int(time.time())
            inserted = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, "
                "account_type, approval_status, lifecycle_status, created_at, updated_at) "
                "VALUES (?, ?, 1, 0, 0, 'managed', 'approved', 'active', ?, ?)",
                ("metrics-admin", server.hash_password("adminpassword123"), now, now),
            )
            manager = dict(conn.execute("SELECT * FROM users WHERE id = ?", (int(inserted.lastrowid),)).fetchone())

        archives = [{
            "id": "metrics-persona",
            "posts": [{"id": "draft-1", "content": "draft"}],
            "publishHistory": [{"id": "pub-1", "content": "published", "publishedAt": "2026-07-13T00:00:00Z"}],
        }]
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
                ("metrics-persona", int(customer["id"]), 1, 1),
            )

        with mock.patch.object(server, "_read_tool_r18_persona_archives", return_value=(archives, {})), mock.patch.object(
            server, "_read_persona_dashboard_deleted_posts", return_value={}
        ):
            customers = admin.get("/api/admin/users?role=customer&limit=100")
            managers = admin.get("/api/admin/users?role=admin&limit=100")

        self.assertEqual(customers.status_code, 200, customers.text)
        customer_body = customers.json()
        self.assertEqual(customer_body["role"], "customer")
        self.assertTrue(all(not bool(row["is_admin"]) for row in customer_body["items"]))
        metric_row = next(row for row in customer_body["items"] if int(row["id"]) == int(customer["id"]))
        self.assertEqual(metric_row["persona_count"], 1)
        self.assertEqual(metric_row["created_post_count"], 2)
        self.assertEqual(metric_row["published_post_count"], 1)

        self.assertEqual(managers.status_code, 200, managers.text)
        manager_body = managers.json()
        self.assertEqual(manager_body["role"], "admin")
        self.assertTrue(all(bool(row["is_admin"]) for row in manager_body["items"]))
        self.assertGreaterEqual(manager_body["admin_count"], 2)
        self.assertGreaterEqual(customer_body["customer_count"], 1)
        self.assertTrue(any(int(row["id"]) == int(manager["id"]) for row in manager_body["items"]))
        self.assertEqual(admin.get("/api/admin/users?role=operator").status_code, 400)

    def test_user_and_admin_login_endpoints_reject_the_wrong_role(self):
        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        self.assertEqual(applied.status_code, 200)

        admin = TestClient(self.app)
        admin_login = admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(admin_login.status_code, 200)
        approved = admin.post(
            f"/api/admin/users/{applied.json()['id']}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approved.status_code, 200)

        wrong_admin_entry = TestClient(self.app)
        rejected_admin = wrong_admin_entry.post(
            "/api/auth/user-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(rejected_admin.status_code, 403)
        self.assertNotIn("session_token", wrong_admin_entry.cookies)

        rejected_legacy_admin = wrong_admin_entry.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(rejected_legacy_admin.status_code, 403)
        self.assertNotIn("admin_session_token", wrong_admin_entry.cookies)

        wrong_user_entry = TestClient(self.app)
        rejected_user = wrong_user_entry.post(
            "/api/auth/admin-login",
            json={"username": "guest001", "password": "guest123"},
        )
        self.assertEqual(rejected_user.status_code, 403)
        self.assertNotIn("session_token", wrong_user_entry.cookies)

        user = TestClient(self.app)
        user_login = user.post(
            "/api/auth/user-login",
            json={"username": "guest001", "password": "guest123"},
        )
        self.assertEqual(user_login.status_code, 200)
        self.assertFalse(user_login.json()["is_admin"])

    def test_user_and_admin_sessions_can_coexist_in_one_browser(self):
        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        self.assertEqual(applied.status_code, 200, applied.text)

        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        approved = admin.post(
            f"/api/admin/users/{applied.json()['id']}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)

        browser = TestClient(self.app)
        user_login = browser.post(
            "/api/auth/user-login",
            json={"username": "guest001", "password": "guest123"},
        )
        self.assertEqual(user_login.status_code, 200, user_login.text)
        user_token = browser.cookies.get("session_token")

        admin_login = browser.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(admin_login.status_code, 200, admin_login.text)
        self.assertEqual(browser.cookies.get("session_token"), user_token)
        self.assertTrue(browser.cookies.get("admin_session_token"))
        admin_token = browser.cookies.get("admin_session_token")
        with db_module.db() as conn:
            user_session = conn.execute(
                "SELECT revoked_at, is_admin_session FROM sessions WHERE token = ?",
                (governance.token_digest(user_token),),
            ).fetchone()
            admin_session = conn.execute(
                "SELECT revoked_at, is_admin_session FROM sessions WHERE token = ?",
                (governance.token_digest(admin_token),),
            ).fetchone()
        self.assertIsNotNone(user_session)
        self.assertEqual(int(user_session["revoked_at"] or 0), 0)
        self.assertEqual(int(user_session["is_admin_session"] or 0), 0)
        self.assertIsNotNone(admin_session)
        self.assertEqual(int(admin_session["revoked_at"] or 0), 0)
        self.assertEqual(int(admin_session["is_admin_session"] or 0), 1)

        user_me = browser.get("/api/me")
        admin_me = browser.get("/api/me", headers={"X-Admin-Console": "1"})
        user_console = browser.get("/console.html", follow_redirects=False)
        admin_console = browser.get("/admin-console.html", follow_redirects=False)

        self.assertEqual(user_me.status_code, 200, user_me.text)
        self.assertEqual(user_me.json()["username"], "guest001")
        self.assertFalse(user_me.json()["is_admin"])
        self.assertEqual(admin_me.status_code, 200, admin_me.text)
        self.assertEqual(admin_me.json()["username"], "admin")
        self.assertTrue(admin_me.json()["is_admin"])
        self.assertEqual(user_console.status_code, 200, user_console.text)
        self.assertEqual(admin_console.status_code, 200, admin_console.text)

        admin_logout = browser.post("/api/auth/logout", headers={"X-Admin-Console": "1"})
        self.assertEqual(admin_logout.status_code, 200, admin_logout.text)
        self.assertEqual(browser.get("/api/me").json()["username"], "guest001")
        self.assertEqual(browser.get("/api/me", headers={"X-Admin-Console": "1"}).status_code, 401)

    def test_session_cookie_kind_must_match_persisted_session_kind(self):
        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        self.assertEqual(applied.status_code, 200, applied.text)

        admin = TestClient(self.app)
        admin_login = admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(admin_login.status_code, 200, admin_login.text)
        approved = admin.post(
            f"/api/admin/users/{applied.json()['id']}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)

        customer = TestClient(self.app)
        customer_login = customer.post(
            "/api/auth/user-login",
            json={"username": "guest001", "password": "guest123"},
        )
        self.assertEqual(customer_login.status_code, 200, customer_login.text)

        admin_token = admin.cookies.get("admin_session_token")
        customer_token = customer.cookies.get("session_token")
        self.assertTrue(admin_token)
        self.assertTrue(customer_token)

        admin_token_in_regular_cookie = TestClient(
            self.app,
            cookies={"session_token": admin_token},
        )
        self.assertEqual(admin_token_in_regular_cookie.get("/api/me").status_code, 401)

        customer_token_in_admin_cookie = TestClient(
            self.app,
            cookies={"admin_session_token": customer_token},
        )
        self.assertEqual(
            customer_token_in_admin_cookie.get(
                "/api/me",
                headers={"X-Admin-Console": "1"},
            ).status_code,
            401,
        )

    def test_admin_legacy_regular_sessions_are_revoked_by_schema_and_login(self):
        admin = TestClient(self.app)
        first_login = admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(first_login.status_code, 200, first_login.text)
        valid_admin_token = admin.cookies.get("admin_session_token")
        self.assertTrue(valid_admin_token)

        with db_module.db() as conn:
            admin_user = conn.execute(
                "SELECT id FROM users WHERE username = 'admin'"
            ).fetchone()
            admin_id = int(admin_user["id"])
            conn.execute(
                """
                INSERT INTO sessions(
                  token, user_id, expires_at, created_at, revoked_at,
                  revoke_reason, is_admin_session
                ) VALUES (?, ?, ?, ?, 0, '', 0)
                """,
                (
                    governance.token_digest("legacy-admin-regular-before-schema"),
                    admin_id,
                    4_000_000_000,
                    1,
                ),
            )
            governance.ensure_schema(conn)
            schema_revoked = conn.execute(
                "SELECT revoked_at, revoke_reason FROM sessions WHERE token = ?",
                (governance.token_digest("legacy-admin-regular-before-schema"),),
            ).fetchone()
            valid_after_schema = conn.execute(
                "SELECT revoked_at, is_admin_session FROM sessions WHERE token = ?",
                (governance.token_digest(valid_admin_token),),
            ).fetchone()
        self.assertGreater(int(schema_revoked["revoked_at"] or 0), 0)
        self.assertEqual(
            str(schema_revoked["revoke_reason"] or ""),
            "admin_session_boundary_migration",
        )
        self.assertEqual(int(valid_after_schema["revoked_at"] or 0), 0)
        self.assertEqual(int(valid_after_schema["is_admin_session"] or 0), 1)

        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO sessions(
                  token, user_id, expires_at, created_at, revoked_at,
                  revoke_reason, is_admin_session
                ) VALUES (?, ?, ?, ?, 0, '', 0)
                """,
                (
                    governance.token_digest("legacy-admin-regular-before-login"),
                    admin_id,
                    4_000_000_000,
                    2,
                ),
            )
        second_login = admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(second_login.status_code, 200, second_login.text)
        with db_module.db() as conn:
            login_revoked = conn.execute(
                "SELECT revoked_at, revoke_reason FROM sessions WHERE token = ?",
                (governance.token_digest("legacy-admin-regular-before-login"),),
            ).fetchone()
        self.assertGreater(int(login_revoked["revoked_at"] or 0), 0)
        self.assertEqual(
            str(login_revoked["revoke_reason"] or ""),
            "admin_session_boundary_login",
        )

    def test_admin_login_uses_only_admin_cookie_and_logout_revokes_it(self):
        browser = TestClient(self.app)
        login = browser.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.assertIsNone(browser.cookies.get("session_token"))
        self.assertTrue(browser.cookies.get("admin_session_token"))

        logout = browser.post("/api/auth/logout", headers={"X-Admin-Console": "1"})
        self.assertEqual(logout.status_code, 200, logout.text)
        self.assertIsNone(browser.cookies.get("session_token"))
        self.assertIsNone(browser.cookies.get("admin_session_token"))
        self.assertEqual(browser.get("/api/me", headers={"X-Admin-Console": "1"}).status_code, 401)
        with db_module.db() as conn:
            admin = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
            session_count = conn.execute(
                "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at = 0",
                (int(admin["id"]),),
            ).fetchone()
        self.assertEqual(int(session_count["count"]), 0)

    def test_admin_logout_without_admin_cookie_never_revokes_customer_session(self):
        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        self.assertEqual(applied.status_code, 200, applied.text)
        admin = TestClient(self.app)
        self.assertEqual(
            admin.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        self.assertEqual(
            admin.post(
                f"/api/admin/users/{applied.json()['id']}/approval",
                json={"approval_status": "approved", "expected_approval_status": "pending"},
            ).status_code,
            200,
        )
        browser = TestClient(self.app)
        login = browser.post(
            "/api/auth/user-login",
            json={"username": "guest001", "password": "guest123"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        customer_token = browser.cookies.get("session_token")

        logout = browser.post("/api/auth/logout", headers={"X-Admin-Console": "1"})

        self.assertEqual(logout.status_code, 200, logout.text)
        self.assertEqual(browser.cookies.get("session_token"), customer_token)
        self.assertEqual(browser.get("/api/me").status_code, 200)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT revoked_at FROM sessions WHERE token = ?",
                (governance.token_digest(customer_token),),
            ).fetchone()
        self.assertEqual(int(row["revoked_at"] or 0), 0)

    def test_admin_pages_do_not_accept_ordinary_session_cookie(self):
        login_browser = TestClient(self.app)
        login = login_browser.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        admin_token = login_browser.cookies.get("admin_session_token")
        self.assertTrue(admin_token)

        stale_browser = TestClient(self.app, cookies={"session_token": admin_token})
        page = stale_browser.get("/admin-console.html", follow_redirects=False)
        self.assertEqual(page.status_code, 302, page.text)
        self.assertEqual(page.headers["location"], "/admin")
        self.assertNotIn("admin_session_token", page.headers.get("set-cookie", ""))

        admin_api = stale_browser.get("/api/me", headers={"X-Admin-Console": "1"})
        self.assertEqual(admin_api.status_code, 401, admin_api.text)

    def test_admin_entry_and_page_are_server_side_role_protected(self):
        anonymous = TestClient(self.app)
        admin_entry = anonymous.get("/admin", follow_redirects=False)
        self.assertEqual(admin_entry.status_code, 200)
        self.assertIn('id="adminLoginForm"', admin_entry.text)

        admin_page = anonymous.get("/admin.html", follow_redirects=False)
        self.assertEqual(admin_page.status_code, 302)
        self.assertEqual(admin_page.headers["location"], "/admin")
        self.assertEqual(anonymous.get("/quick-setup.html", follow_redirects=False).status_code, 404)
        self.assertEqual(anonymous.get("/api/quick_setup/status").status_code, 404)

        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        self.assertEqual(applied.status_code, 200)

        reviewer = TestClient(self.app)
        self.assertEqual(
            reviewer.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        self.assertEqual(
            reviewer.post(
                f"/api/admin/users/{applied.json()['id']}/approval",
                json={"approval_status": "approved", "expected_approval_status": "pending"},
            ).status_code,
            200,
        )

        user = TestClient(self.app)
        self.assertEqual(
            user.post(
                "/api/auth/user-login",
                json={"username": "guest001", "password": "guest123"},
            ).status_code,
            200,
        )
        user_entry = user.get("/admin", follow_redirects=False)
        self.assertEqual(user_entry.status_code, 200)
        self.assertIn('id="adminLoginForm"', user_entry.text)
        user_admin_page = user.get("/admin.html", follow_redirects=False)
        self.assertEqual(user_admin_page.status_code, 302)
        self.assertEqual(user_admin_page.headers["location"], "/admin")
        user_admin_console = user.get("/admin-console.html", follow_redirects=False)
        self.assertEqual(user_admin_console.status_code, 302)
        self.assertEqual(user_admin_console.headers["location"], "/admin")
        self.assertEqual(user.get("/quick-setup.html", follow_redirects=False).status_code, 404)
        self.assertEqual(user.get("/api/quick_setup/status").status_code, 404)

        switched_login = user.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(switched_login.status_code, 200)
        self.assertTrue(switched_login.json()["is_admin"])
        switched_entry = user.get("/admin", follow_redirects=False)
        self.assertEqual(switched_entry.status_code, 302)
        self.assertEqual(switched_entry.headers["location"], "/admin.html#admin-overview")
        self.assertEqual(user.get("/admin.html", follow_redirects=False).status_code, 200)

        admin = TestClient(self.app)
        login = admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login.status_code, 200)
        entry = admin.get("/admin", follow_redirects=False)
        self.assertEqual(entry.status_code, 302)
        self.assertEqual(entry.headers["location"], "/admin.html#admin-overview")
        rendered_admin = admin.get("/admin.html", follow_redirects=False)
        self.assertEqual(rendered_admin.status_code, 200)
        admin_console = admin.get("/console.html", follow_redirects=False)
        self.assertEqual(admin_console.status_code, 302)
        self.assertEqual(admin_console.headers["location"], "/admin-console.html")
        self.assertNotIn('href="/console.html"', rendered_admin.text)
        self.assertNotIn("快速配置", rendered_admin.text)
        self.assertNotIn("人设数据看板", rendered_admin.text)
        self.assertNotIn("TG Bot 设置", rendered_admin.text)
        self.assertNotIn('id="tgTrustedUserBody"', rendered_admin.text)
        self.assertEqual(admin.get("/api/admin/tg_settings").status_code, 404)
        self.assertEqual(admin.post("/api/admin/tg_trusted_users", json={"chat_id": 1}).status_code, 404)
        self.assertEqual(admin.get("/quick-setup.html", follow_redirects=False).status_code, 404)
        self.assertEqual(admin.get("/api/quick_setup/status").status_code, 404)


if __name__ == "__main__":
    unittest.main()
