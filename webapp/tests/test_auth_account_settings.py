import json
import os
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module, governance
import webapp.server as server


class AccountSettingsApiTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_webapp_data_dir = os.environ.get("WEBAPP_DATA_DIR")
        self._old_bootstrap_password = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD")
        self._old_cookie_secure = os.environ.get("SESSION_COOKIE_SECURE")
        self._old_vault_key = os.environ.get("PASSWORD_VAULT_KEY")
        self._old_vault_key_file = os.environ.get("PASSWORD_VAULT_KEY_FILE")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmpdir.name)
        self.db_path = self.data_dir / "app.db"
        self.runtime_config_path = self.data_dir / "runtime_config.json"
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.db_path)
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.runtime_config_path)
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "admin123secure"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        server.RUNTIME_CONFIG_PATH = self.runtime_config_path
        self.app = server.create_app()
        self.client = TestClient(self.app)

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        if self._old_runtime_config_path is None:
            os.environ.pop("APP_RUNTIME_CONFIG_PATH", None)
        else:
            os.environ["APP_RUNTIME_CONFIG_PATH"] = self._old_runtime_config_path
        if self._old_webapp_data_dir is None:
            os.environ.pop("WEBAPP_DATA_DIR", None)
        else:
            os.environ["WEBAPP_DATA_DIR"] = self._old_webapp_data_dir
        if self._old_bootstrap_password is None:
            os.environ.pop("ADMIN_BOOTSTRAP_PASSWORD", None)
        else:
            os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = self._old_bootstrap_password
        if self._old_cookie_secure is None:
            os.environ.pop("SESSION_COOKIE_SECURE", None)
        else:
            os.environ["SESSION_COOKIE_SECURE"] = self._old_cookie_secure
        if self._old_vault_key is None:
            os.environ.pop("PASSWORD_VAULT_KEY", None)
        else:
            os.environ["PASSWORD_VAULT_KEY"] = self._old_vault_key
        if self._old_vault_key_file is None:
            os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        else:
            os.environ["PASSWORD_VAULT_KEY_FILE"] = self._old_vault_key_file
        self._tmpdir.cleanup()

    def test_profile_page_is_protected_and_keeps_admin_session_isolated(self):
        anonymous = TestClient(self.app)
        regular_redirect = anonymous.get("/profile.html", follow_redirects=False)
        admin_redirect = anonymous.get("/admin-profile.html", follow_redirects=False)
        self.assertEqual(regular_redirect.status_code, 302)
        self.assertEqual(
            regular_redirect.headers["location"],
            "/?login=1&return_url=%2Fprofile.html",
        )
        self.assertEqual(admin_redirect.status_code, 302)
        self.assertEqual(admin_redirect.headers["location"], "/admin?return_url=%2Fadmin-profile.html")

        login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200, login_resp.text)

        regular_profile = self.client.get("/profile.html", follow_redirects=False)
        self.assertEqual(regular_profile.status_code, 302)
        self.assertEqual(regular_profile.headers["location"], "/?login=1&return_url=%2Fprofile.html")

        admin_profile = self.client.get("/admin-profile.html")
        self.assertEqual(admin_profile.status_code, 200, admin_profile.text)
        self.assertIn('meta name="admin-console-session" content="1"', admin_profile.text)
        self.assertIn('id="profileAvatarButton"', admin_profile.text)
        self.assertIn('id="profileAvatarFile"', admin_profile.text)
        self.assertNotIn("__PROFILE_CSS_VERSION__", admin_profile.text)
        self.assertNotIn("__PROFILE_JS_VERSION__", admin_profile.text)

        avatar_url = "data:image/png;base64,iVBORw0KGgo="
        update_resp = self.client.patch(
            "/api/me/profile",
            headers={"X-Admin-Console": "1"},
            json={"full_name": "Admin Profile", "avatar_url": avatar_url},
        )
        self.assertEqual(update_resp.status_code, 200, update_resp.text)
        self.assertEqual(update_resp.json()["profile"]["full_name"], "Admin Profile")
        self.assertEqual(update_resp.json()["profile"]["avatar_url"], avatar_url)

        me_resp = self.client.get("/api/me", headers={"X-Admin-Console": "1"})
        self.assertEqual(me_resp.status_code, 200, me_resp.text)
        self.assertEqual(me_resp.json()["full_name"], "Admin Profile")
        self.assertEqual(me_resp.json()["avatar_url"], avatar_url)

    def test_regular_user_can_open_and_persist_profile_page(self):
        applicant = TestClient(self.app)
        applied = applicant.post(
            "/api/auth/apply",
            json={
                "username": "profile_user",
                "password": "profile123",
                "full_name": "Profile User",
                "email": "profile@example.test",
                "phone": "0912345678",
                "company": "Vecto Profile QA",
                "use_case": "Verify the independent profile page",
            },
        )
        self.assertEqual(applied.status_code, 200, applied.text)

        self.assertEqual(
            self.client.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        approved = self.client.post(
            f"/api/admin/users/{applied.json()['id']}/approval",
            json={
                "approval_status": "approved",
                "expected_approval_status": "pending",
                "admin_note": "Profile page verification",
            },
        )
        self.assertEqual(approved.status_code, 200, approved.text)

        customer = TestClient(self.app)
        login = customer.post(
            "/api/auth/login",
            json={"username": "profile_user", "password": "profile123"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.assertIsNotNone(customer.cookies.get("session_token"))
        self.assertIsNone(customer.cookies.get("admin_session_token"))

        page = customer.get("/profile.html")
        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn('meta name="admin-console-session" content="0"', page.text)

        saved = customer.patch(
            "/api/me/profile",
            json={
                "full_name": "Updated Profile",
                "avatar_url": "",
                "profile_signature": "Profile signature",
                "profile_tags": "AI，营销, 品牌",
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["profile"]["full_name"], "Updated Profile")
        self.assertEqual(saved.json()["profile"]["profile_signature"], "Profile signature")
        self.assertEqual(saved.json()["profile"]["profile_tags"], "AI, 营销, 品牌")

        refreshed = customer.get("/api/me")
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        self.assertEqual(refreshed.json()["full_name"], "Updated Profile")
        self.assertEqual(refreshed.json()["profile_tags"], "AI, 营销, 品牌")

        self.client.cookies.set("session_token", customer.cookies.get("session_token"))
        dual_session_console = self.client.get("/console.html", follow_redirects=False)
        self.assertEqual(dual_session_console.status_code, 200, dual_session_console.text)
        self.assertIn('meta name="admin-console-session" content=""', dual_session_console.text)
        dual_session_profile = self.client.get("/profile.html", follow_redirects=False)
        self.assertEqual(dual_session_profile.status_code, 200, dual_session_profile.text)
        self.assertIn('meta name="admin-console-session" content="0"', dual_session_profile.text)

    def test_admin_can_change_username_with_current_password(self):
        login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        change_resp = self.client.post(
            "/api/auth/change_username",
            headers={"X-Admin-Console": "1"},
            json={"password": "admin123secure", "new_username": "admin2"},
        )
        self.assertEqual(change_resp.status_code, 200)
        self.assertEqual(change_resp.json(), {"ok": True})

        me_resp = self.client.get("/api/me", headers={"X-Admin-Console": "1"})
        self.assertEqual(me_resp.status_code, 200)
        self.assertEqual(me_resp.json()["username"], "admin2")

        relogin_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin2", "password": "admin123secure"},
        )
        self.assertEqual(relogin_resp.status_code, 200)

        old_name_application = TestClient(self.app).post(
            "/api/auth/apply",
            json={
                "username": "admin",
                "password": "Applicant123",
                "full_name": "Reserved Alias",
                "email": "reserved@example.test",
                "phone": "0912345678",
                "company": "Isolation QA",
                "use_case": "Verify historical usernames cannot cross tenant boundaries",
            },
        )
        self.assertEqual(old_name_application.status_code, 409, old_name_application.text)

    def test_admin_can_change_password_with_current_password(self):
        login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        change_resp = self.client.post(
            "/api/auth/change_password",
            headers={"X-Admin-Console": "1"},
            json={"old_password": "admin123secure", "new_password": "admin456secure"},
        )
        self.assertEqual(change_resp.status_code, 200)
        self.assertEqual(change_resp.json(), {"ok": True})

        old_login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(old_login_resp.status_code, 401)

        new_login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin456secure"},
        )
        self.assertEqual(new_login_resp.status_code, 200)

    def test_admin_password_change_keeps_the_active_admin_session(self):
        login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200, login_resp.text)
        admin_token = self.client.cookies.get("admin_session_token")
        legacy_token = self.client.cookies.get("session_token")
        self.assertTrue(admin_token)
        self.assertIsNone(legacy_token)

        change_resp = self.client.post(
            "/api/auth/change_password",
            headers={"X-Admin-Console": "1"},
            json={"old_password": "admin123secure", "new_password": "admin456secure"},
        )
        self.assertEqual(change_resp.status_code, 200, change_resp.text)
        current_admin = self.client.get("/api/me", headers={"X-Admin-Console": "1"})
        self.assertEqual(current_admin.status_code, 200, current_admin.text)
        self.assertEqual(current_admin.json()["username"], "admin")
        with db_module.db() as conn:
            active_tokens = {
                str(row["token"])
                for row in conn.execute("SELECT token FROM sessions WHERE user_id = ?", (int(current_admin.json()["id"]),))
            }
        self.assertIn(governance.token_digest(admin_token), active_tokens)
        self.assertEqual(active_tokens, {governance.token_digest(admin_token)})

    def test_admin_password_change_requires_twelve_characters(self):
        self.assertEqual(
            self.client.post(
                "/api/auth/admin-login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        response = self.client.post(
            "/api/auth/change_password",
            headers={"X-Admin-Console": "1"},
            json={"old_password": "admin123secure", "new_password": "short888"},
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_change_password_rejects_wrong_current_password(self):
        login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        change_resp = self.client.post(
            "/api/auth/change_password",
            headers={"X-Admin-Console": "1"},
            json={"old_password": "wrong-pass", "new_password": "admin456"},
        )
        self.assertEqual(change_resp.status_code, 400)
        self.assertEqual(change_resp.json()["detail"], "原密码错误")

    def test_admin_task_list_includes_has_download_for_downloadable_outputs(self):
        output_file = self.data_dir / "demo.mp4"
        output_file.write_bytes(b"demo-video")
        now_ts = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO tasks(
                    id, user_id, type, status, input_json, output_json, error,
                    runninghub_task_id, usage_json, cost_cents, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "task_downloadable",
                    1,
                    "image_generate",
                    "success",
                    "{}",
                    json.dumps({"download_path": str(output_file)}, ensure_ascii=False),
                    "",
                    "",
                    "{}",
                    0,
                    now_ts,
                    now_ts,
                ),
            )

        login_resp = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        list_resp = self.client.get("/api/admin/tasks?limit=20")
        self.assertEqual(list_resp.status_code, 200)
        items = list_resp.json()["items"]
        task = next(item for item in items if item["id"] == "task_downloadable")
        self.assertEqual(task["has_download"], True)

        unmarked_download = self.client.get("/api/tasks/task_downloadable/download")
        self.assertEqual(unmarked_download.status_code, 401, unmarked_download.text)
        marked_download = self.client.get("/api/tasks/task_downloadable/download?admin_console=1")
        self.assertEqual(marked_download.status_code, 200, marked_download.text)
        self.assertEqual(marked_download.content, b"demo-video")

    def test_admin_forced_password_change_keeps_admin_session_selected(self):
        expires_at = server._now_ts() + 3600
        with db_module.db() as conn:
            conn.execute(
                "UPDATE users SET must_change_password = 1, password_expires_at = ? WHERE id = 1",
                (expires_at,),
            )

        login = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.assertTrue(login.json()["must_change_password"])
        self.client.cookies.set("session_token", "unrelated-customer-session")

        admin_entry = self.client.get("/admin", follow_redirects=False)
        self.assertEqual(admin_entry.status_code, 302, admin_entry.text)
        self.assertEqual(
            admin_entry.headers["location"],
            "/change-password.html?admin_console=1&return_url=%2Fadmin",
        )
        console_entry = self.client.get(
            "/admin-console.html?view=accounts",
            follow_redirects=False,
        )
        self.assertEqual(console_entry.status_code, 302, console_entry.text)
        self.assertEqual(
            console_entry.headers["location"],
            "/change-password.html?admin_console=1&return_url=%2Fadmin-console.html%3Fview%3Daccounts",
        )
        change_page = self.client.get(
            "/change-password.html?admin_console=1&return_url=%2Fadmin",
            follow_redirects=False,
        )
        self.assertEqual(change_page.status_code, 200, change_page.text)
        self.assertNotIn("__AUTH_JS_VERSION__", change_page.text)
        self.assertNotIn("__STYLE_VERSION__", change_page.text)

        changed = self.client.post(
            "/api/auth/change_password?admin_console=1",
            json={"old_password": "admin123secure", "new_password": "admin456secure"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(
            self.client.get("/change-password.html?admin_console=1", follow_redirects=False).headers["location"],
            "/admin",
        )

    def test_authenticated_admin_entry_honors_only_safe_local_return_url(self):
        login = self.client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login.status_code, 200, login.text)

        returned = self.client.get(
            "/admin?return_url=%2Fproxy-market.html%3Fadmin_console%3D1",
            follow_redirects=False,
        )
        self.assertEqual(returned.status_code, 302, returned.text)
        self.assertEqual(returned.headers["location"], "/proxy-market.html?admin_console=1")

        rejected = self.client.get(
            "/admin?return_url=https%3A%2F%2Fevil.example%2Fsteal",
            follow_redirects=False,
        )
        self.assertEqual(rejected.status_code, 302, rejected.text)
        self.assertEqual(rejected.headers["location"], "/admin.html#admin-overview")

        normalized_attack = self.client.get(
            "/admin",
            params={"return_url": r"/\evil.example/steal"},
            follow_redirects=False,
        )
        self.assertEqual(normalized_attack.status_code, 302, normalized_attack.text)
        self.assertEqual(normalized_attack.headers["location"], "/admin.html#admin-overview")

        mapped_console = self.client.get(
            "/admin?return_url=%2Fconsole.html%3Fview%3Daccounts",
            follow_redirects=False,
        )
        self.assertEqual(mapped_console.status_code, 302, mapped_console.text)
        self.assertEqual(mapped_console.headers["location"], "/admin-console.html?view=accounts")

    def test_return_urls_are_role_scoped_and_workspace_aliases_cannot_conflict(self):
        self.assertEqual(
            server._role_safe_return_url("/admin.html", "/console.html", admin=False),
            "/console.html",
        )
        self.assertEqual(
            server._role_safe_return_url("/api/admin/users", "/console.html", admin=False),
            "/console.html",
        )
        self.assertEqual(
            server._role_safe_return_url(
                "/proxy-market.html?admin_workspace_user_id=42",
                "/admin.html",
                admin=True,
            ),
            "/proxy-market.html?admin_workspace_user_id=42&admin_console=1",
        )
        conflict = self.client.get(
            "/console.html?manage_user_id=41&admin_workspace_user_id=42",
            follow_redirects=False,
        )
        self.assertEqual(conflict.status_code, 400, conflict.text)


if __name__ == "__main__":
    unittest.main()
