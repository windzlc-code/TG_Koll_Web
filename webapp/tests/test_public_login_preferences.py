import os
import tempfile
import time
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module
import webapp.server as server


class PublicLoginPreferenceTests(unittest.TestCase):
    def setUp(self):
        self._old_env = {
            name: os.environ.get(name)
            for name in (
                "APP_DB_PATH",
                "APP_RUNTIME_CONFIG_PATH",
                "WEBAPP_DATA_DIR",
                "ADMIN_BOOTSTRAP_PASSWORD",
                "SESSION_COOKIE_SECURE",
                "PASSWORD_VAULT_KEY",
                "PASSWORD_VAULT_KEY_FILE",
            )
        }
        self._old_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmpdir.name)
        self.runtime_config_path = self.data_dir / "runtime_config.json"
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.runtime_config_path)
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "admin123secure"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        server.RUNTIME_CONFIG_PATH = self.runtime_config_path
        self.app = server.create_app()

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_runtime_config_path
        for name, value in self._old_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self._tmpdir.cleanup()

    def _admin_login(self, client: TestClient, *, remember_me: bool = False):
        return client.post(
            "/api/auth/admin-login",
            json={
                "username": "admin",
                "password": "admin123secure",
                "remember_me": remember_me,
            },
        )

    def _latest_session_ttl(self) -> int:
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT expires_at, created_at FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1"
            ).fetchone()
        self.assertIsNotNone(row)
        return int(row["expires_at"]) - int(row["created_at"])

    def test_default_policy_uses_browser_session_cookie(self):
        client = TestClient(self.app)
        policy = client.get("/api/auth/policy")
        self.assertEqual(policy.status_code, 200, policy.text)
        self.assertEqual(
            policy.json(),
            {
                "remember_login_enabled": True,
                "remember_login_default": False,
                "remember_login_days": 30,
                "session_hours": 12,
            },
        )

        response = self._admin_login(client, remember_me=False)
        self.assertEqual(response.status_code, 200, response.text)
        cookie = response.headers.get("set-cookie", "")
        self.assertIn("admin_session_token=", cookie)
        self.assertNotIn("Max-Age=", cookie)
        self.assertAlmostEqual(self._latest_session_ttl(), 12 * 3600, delta=2)

    def test_admin_policy_controls_persistent_cookie_lifetime(self):
        admin = TestClient(self.app)
        self.assertEqual(self._admin_login(admin).status_code, 200)
        updated = admin.put(
            "/api/admin/runtime_config",
            json={
                "auth_remember_login_enabled": True,
                "auth_remember_login_default": True,
                "auth_remember_login_days": 7,
                "auth_session_hours": 2,
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        updated_config = updated.json()["runtime_config"]
        self.assertEqual(updated_config["auth_session_hours"], 2)
        self.assertEqual(updated_config["auth_remember_login_days"], 7)

        reloaded_config = admin.get("/api/admin/runtime_config").json()
        self.assertEqual(reloaded_config["auth_session_hours"], 2)
        self.assertEqual(reloaded_config["auth_remember_login_days"], 7)

        policy = TestClient(self.app).get("/api/auth/policy")
        self.assertEqual(
            policy.json(),
            {
                "remember_login_enabled": True,
                "remember_login_default": True,
                "remember_login_days": 7,
                "session_hours": 2,
            },
        )

        remembered = TestClient(self.app)
        response = self._admin_login(remembered, remember_me=True)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("Max-Age=604800", response.headers.get("set-cookie", ""))
        self.assertAlmostEqual(self._latest_session_ttl(), 7 * 24 * 3600, delta=2)

        temporary = TestClient(self.app)
        response = self._admin_login(temporary, remember_me=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("Max-Age=", response.headers.get("set-cookie", ""))
        self.assertAlmostEqual(self._latest_session_ttl(), 2 * 3600, delta=2)

    def test_disabled_remember_policy_ignores_client_request(self):
        admin = TestClient(self.app)
        self.assertEqual(self._admin_login(admin).status_code, 200)
        updated = admin.put(
            "/api/admin/runtime_config",
            json={
                "auth_remember_login_enabled": False,
                "auth_remember_login_default": True,
                "auth_remember_login_days": 90,
                "auth_session_hours": 3,
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)

        client = TestClient(self.app)
        response = self._admin_login(client, remember_me=True)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("Max-Age=", response.headers.get("set-cookie", ""))
        self.assertAlmostEqual(self._latest_session_ttl(), 3 * 3600, delta=2)


class PublicLoginUiSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.static_dir = Path(server.__file__).resolve().parent / "static"
        cls.script = (cls.static_dir / "assets" / "opc" / "script.js").read_text(encoding="utf-8")
        cls.styles = (cls.static_dir / "assets" / "opc" / "styles.css").read_text(encoding="utf-8")
        cls.admin_js = (cls.static_dir / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.admin_html = (cls.static_dir / "admin.html").read_text(encoding="utf-8")
        cls.auth_js = (cls.static_dir / "assets" / "auth.js").read_text(encoding="utf-8")

    def test_backdrop_click_does_not_close_login(self):
        self.assertNotIn("if (event.target === loginModal) closeLogin()", self.script)
        self.assertIn('[data-close-login]', self.script)

    def test_public_login_has_svg_password_toggle_and_remember_option(self):
        for page_name in ("index.html", "pricing.html"):
            page = (self.static_dir / page_name).read_text(encoding="utf-8")
            self.assertIn('data-login-password-toggle', page)
            self.assertIn('<svg', page)
            self.assertIn('name="remember_me"', page)
        self.assertIn("remember_me: Boolean(loginForm.remember_me?.checked)", self.script)
        self.assertIn("loginPassword.type = revealed ? \"text\" : \"password\"", self.script)
        self.assertNotIn("localStorage.setItem", self.script)
        self.assertNotIn("PasswordCredential", self.script)

        for page_name in ("login.html", "admin-login.html"):
            page = (self.static_dir / page_name).read_text(encoding="utf-8")
            self.assertIn("data-auth-password-toggle", page)
            self.assertIn('name="remember_me"', page)
        self.assertIn("remember_me: Boolean(form.remember_me?.checked)", self.auth_js)
        self.assertIn('api("/api/auth/policy")', self.auth_js)

    def test_public_login_handles_session_conflict_and_structured_errors(self):
        for page_name in ("index.html", "pricing.html"):
            page = (self.static_dir / page_name).read_text(encoding="utf-8")
            self.assertIn('data-login-takeover', page)

        self.assertIn('force_takeover: Boolean(forceTakeover)', self.script)
        self.assertIn('detail.code !== "SESSION_CONFLICT"', self.script)
        self.assertIn('loginTakeover.hidden = detail.code !== "SESSION_CONFLICT"', self.script)
        self.assertIn('apiErrorDetail(error)', self.script)
        self.assertNotIn('loginStatus.textContent = error.detail ||', self.script)

        login_page = (self.static_dir / "login.html").read_text(encoding="utf-8")
        self.assertIn('data-auth-login-takeover', login_page)
        self.assertIn('force_takeover: loginRole === "user" && Boolean(forceTakeover)', self.auth_js)
        self.assertIn('detail.code !== "SESSION_CONFLICT"', self.auth_js)
        self.assertIn('apiErrorDetail(err)', self.auth_js)

    def test_public_pages_use_runtime_asset_versions_and_disable_html_cache(self):
        client = TestClient(server.create_app())
        for path in ("/", "/index.html", "/pricing.html", "/login.html"):
            response = client.get(path)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn("no-store", response.headers.get("cache-control", ""))
            if path == "/login.html":
                self.assertNotIn("__AUTH_JS_VERSION__", response.text)
                self.assertRegex(response.text, r'/assets/auth\.js\?v=\d+-\d+')
            else:
                self.assertNotIn("__OPC_SCRIPT_VERSION__", response.text)
                self.assertRegex(response.text, r'/assets/opc/script\.js\?v=\d+-\d+')

    def test_admin_runtime_form_exposes_cookie_policy(self):
        for field_id in (
            "rtRememberLoginEnabled",
            "rtRememberLoginDefault",
            "rtRememberLoginDays",
            "rtSessionHours",
        ):
            self.assertIn(f'id="{field_id}"', self.admin_html)
            self.assertIn(field_id, self.admin_js)


if __name__ == "__main__":
    unittest.main()
