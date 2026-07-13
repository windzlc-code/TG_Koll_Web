import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from webapp import db as db_module
import webapp.server as server


class RegistrationApprovalTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in (
            "APP_DB_PATH", "APP_RUNTIME_CONFIG_PATH", "WEBAPP_DATA_DIR",
            "ADMIN_BOOTSTRAP_PASSWORD", "SESSION_COOKIE_SECURE",
        )}
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmpdir.name)
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "admin123secure"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        self.app = server.create_app()

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

    def test_admin_can_review_and_approve_then_user_can_open_console(self):
        applicant = TestClient(self.app)
        applied = applicant.post("/api/auth/apply", json=self.application_payload())
        user_id = applied.json()["id"]

        admin = TestClient(self.app)
        admin_login = admin.post("/api/auth/login", json={"username": "admin", "password": "admin123secure"})
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
        self.assertEqual(user_client.get("/api/admin/users").status_code, 403)

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
        user_id = int(created.json()["user"]["id"])

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
            ).status_code,
            403,
        )

        reset = admin.post(f"/api/admin/users/{user_id}/reset-password")
        self.assertEqual(reset.status_code, 200)
        self.assertTrue(reset.json()["ok"])
        temporary_password = str(reset.json()["temporary_password"])
        self.assertGreaterEqual(len(temporary_password), 20)
        self.assertIn("no-store", reset.headers["cache-control"])
        self.assertEqual(reset.headers["pragma"], "no-cache")
        self.assertEqual(user.get("/api/me").status_code, 401)

        old_login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "managed001", "password": "oldpass123"},
        )
        self.assertEqual(old_login.status_code, 401)
        new_login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "managed001", "password": temporary_password},
        )
        self.assertEqual(new_login.status_code, 200)

        detail = admin.get(f"/api/admin/users/{user_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertNotIn("password", detail.json()["user"])
        self.assertNotIn("password_hash", detail.json()["user"])
        listing = admin.get("/api/admin/users")
        self.assertNotIn(temporary_password, listing.text)

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

    def test_admin_entry_and_page_are_server_side_role_protected(self):
        anonymous = TestClient(self.app)
        admin_entry = anonymous.get("/admin", follow_redirects=False)
        self.assertEqual(admin_entry.status_code, 200)
        self.assertIn('id="adminLoginForm"', admin_entry.text)

        admin_page = anonymous.get("/admin.html", follow_redirects=False)
        self.assertEqual(admin_page.status_code, 302)
        self.assertEqual(admin_page.headers["location"], "/admin")
        quick_setup = anonymous.get("/quick-setup.html", follow_redirects=False)
        self.assertEqual(quick_setup.status_code, 302)
        self.assertEqual(quick_setup.headers["location"], "/admin")
        self.assertEqual(anonymous.get("/api/quick_setup/status").status_code, 401)

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
        user_quick_setup = user.get("/quick-setup.html", follow_redirects=False)
        self.assertEqual(user_quick_setup.status_code, 302)
        self.assertEqual(user_quick_setup.headers["location"], "/admin")
        self.assertEqual(user.get("/api/quick_setup/status").status_code, 403)

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
        self.assertEqual(admin.get("/admin.html", follow_redirects=False).status_code, 200)
        self.assertEqual(admin.get("/quick-setup.html", follow_redirects=False).status_code, 200)
        self.assertEqual(admin.get("/api/quick_setup/status").status_code, 200)


if __name__ == "__main__":
    unittest.main()
