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
        cls.pricing_styles = (cls.static_dir / "assets" / "opc" / "pricing.css").read_text(encoding="utf-8")
        cls.site_nav_script = (cls.static_dir / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.site_nav_styles = (cls.static_dir / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
        cls.admin_js = (cls.static_dir / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.console_js = (cls.static_dir / "assets" / "console.js").read_text(encoding="utf-8")
        cls.admin_html = (cls.static_dir / "admin.html").read_text(encoding="utf-8")
        cls.auth_js = (cls.static_dir / "assets" / "auth.js").read_text(encoding="utf-8")

    def test_backdrop_click_does_not_close_login(self):
        self.assertNotIn("if (event.target === loginModal) closeLogin()", self.script)
        self.assertIn('[data-close-login]', self.script)

    def test_pricing_mobile_hero_clamps_intrinsic_grid_width(self):
        self.assertIn("grid-template-columns: minmax(0, 1fr);", self.pricing_styles)
        self.assertIn(".pricing-page-hero-copy {\n    min-width: 0;", self.pricing_styles)
        self.assertIn("max-width: 100%;", self.pricing_styles)
        self.assertIn("overflow-wrap: anywhere;", self.pricing_styles)
        self.assertIn("word-break: break-word;", self.pricing_styles)

    def test_home_navigation_opens_console_or_existing_login_dialog(self):
        page = (self.static_dir / "index.html").read_text(encoding="utf-8")
        pricing = (self.static_dir / "pricing.html").read_text(encoding="utf-8")
        for markup, page_name in ((page, "home"), (pricing, "pricing")):
            self.assertIn(f'data-site-header data-site-page="{page_name}"', markup)
            self.assertIn('data-site-auth-state="pending"', markup)
            self.assertIn('<a class="site-skip-link"', markup)
            self.assertIn('class="site-nav"', markup)
            self.assertIn('data-site-mobile-menu', markup)
            self.assertIn('<script defer src="/assets/opc/site-navigation.js', markup)
            self.assertIn('/assets/opc/site-navigation.css', markup)
            self.assertIn('/assets/vendor/opencc-js/st-characters.js?v=1.4.1', markup)
            self.assertIn('/assets/vendor/opencc-js/ts-characters.js?v=1.4.1', markup)
            self.assertIn('/assets/vendor/opencc-js/ts-phrases.js?v=1.4.1', markup)
        self.assertIn('key: "console", href: "/console.html"', self.site_nav_script)
        self.assertIn("data-console-entry", self.site_nav_script)
        self.assertIn("window.VectoSiteNavigation?.openConsoleEntry", self.script)
        self.assertIn('openLogin(event)', self.script)
        self.assertEqual(page.count('id="loginModal"'), 1)

    def test_admin_origin_is_preserved_and_server_validated_on_public_navigation(self):
        self.assertIn(
            'const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context"',
            self.site_nav_script,
        )
        self.assertIn("function markAdminConsoleContext()", self.site_nav_script)
        self.assertIn("function clearAdminConsoleContext()", self.site_nav_script)
        self.assertIn("async function resolvePublicSession()", self.site_nav_script)
        self.assertIn('headers.set("X-Admin-Console", "1")', self.site_nav_script)
        self.assertIn(
            'headers.set("X-Admin-Workspace-User-ID", workspaceUserId)',
            self.site_nav_script,
        )
        self.assertIn("async function openConsoleEntry", self.site_nav_script)
        self.assertIn('path: "/admin-console.html"', self.site_nav_script)
        self.assertIn('path: "/console.html"', self.site_nav_script)
        self.assertIn("openConsoleEntry,", self.site_nav_script)

        click_handler = self.script.split(
            'document.querySelectorAll("[data-console-entry]")',
            1,
        )[1].split(
            'document.querySelectorAll("[data-close-login]")',
            1,
        )[0]
        self.assertIn("window.VectoSiteNavigation?.openConsoleEntry", click_handler)
        self.assertNotIn('fetch("/api/auth/me"', click_handler)
        self.assertNotIn('window.location.assign("/console.html")', click_handler)

        self.assertIn(
            'sessionStorage.setItem("vecto-admin-console-context", "1")',
            self.admin_js,
        )
        for source in (self.admin_js, self.console_js):
            with self.subTest(source=source[:32]):
                self.assertIn(
                    'removeItem("vecto-admin-console-context")',
                    source,
                )
        self.assertIn(
            "removeSessionValue(ADMIN_CONTEXT_STORAGE_KEY)",
            self.site_nav_script,
        )

        for page_name in ("index.html", "pricing.html", "console.html", "admin.html"):
            page = (self.static_dir / page_name).read_text(encoding="utf-8")
            with self.subTest(page=page_name):
                self.assertIn(
                    "/assets/opc/site-navigation.js?v=__SITE_NAVIGATION_JS_VERSION__",
                    page,
                )

    def test_public_navigation_preserves_authenticated_account_state(self):
        self.assertIn("async function hydratePublicSession(header)", self.site_nav_script)
        self.assertIn('fetch("/api/auth/me"', self.site_nav_script)
        self.assertIn("function showAuthenticatedAccount(header, account)", self.site_nav_script)
        self.assertIn("function showGuestAccount(header)", self.site_nav_script)
        self.assertIn('header.dataset.siteAuthState = "authenticated"', self.site_nav_script)
        self.assertIn('header.dataset.siteAuthState = "guest"', self.site_nav_script)
        self.assertIn('[data-site-auth-state="pending"] .header-actions', self.site_nav_styles)
        self.assertIn("min-width: 274px", self.site_nav_styles)
        self.assertIn('installUnifiedAccountMenu(header, header.dataset.sitePage || "home")', self.site_nav_script)
        self.assertIn("async function logoutPublicSession()", self.site_nav_script)
        self.assertIn('fetch("/api/auth/logout"', self.site_nav_script)
        self.assertIn("window.location.reload()", self.site_nav_script)

    def test_shared_navigation_keeps_public_language_and_scopes_theme_to_console(self):
        for expected in ('id="themeToggle"', 'id="languageToggle"', "site-theme-icon", "site-language-icon"):
            self.assertIn(expected, self.site_nav_script)
        for page_name in ("index.html", "pricing.html"):
            markup = (self.static_dir / page_name).read_text(encoding="utf-8")
            self.assertNotIn("data-site-theme-toggle", markup)
            self.assertIn("data-site-language-toggle", markup)
        self.assertIn("function themeEnabled()", self.site_nav_script)
        self.assertIn('return page === "console" || document.body?.classList.contains("page-admin")', self.site_nav_script)
        self.assertIn('installUnifiedAccountMenu(header, header.dataset.sitePage || "home")', self.site_nav_script)
        public_controls = self.site_nav_script.split("function renderActions", 1)[1].split("function fallbackMarkup", 1)[0]
        self.assertNotIn("data-site-theme-toggle", public_controls.split("const controls", 1)[1].split("const mobileMenu", 1)[0])
        self.assertIn("data-site-language-toggle", public_controls)
        self.assertIn('function accountPreferencesMarkup(page = "console")', self.site_nav_script)
        self.assertIn('class="site-account-preferences"', self.site_nav_script)
        self.assertIn('actions.querySelectorAll(":scope > .site-global-controls")', self.site_nav_script)
        self.assertIn('const THEME_STORAGE_KEY = "wk-console-theme"', self.site_nav_script)
        self.assertIn('const LANGUAGE_STORAGE_KEY = "wk-console-language"', self.site_nav_script)
        self.assertIn('window.addEventListener("storage"', self.site_nav_script)
        self.assertIn('data-site-mobile-menu', self.site_nav_script)
        self.assertIn('window.addEventListener("vecto:language-change"', self.script)
        self.assertIn("applyPublicLanguage", self.script)
        self.assertIn(':root[data-theme="dark"]', self.site_nav_styles)
        self.assertNotIn(".site-header {", self.styles)

    def test_public_dark_theme_covers_forms_cards_and_dialogs(self):
        for selector in (
            ':root[data-theme="dark"] .lead-form',
            ':root[data-theme="dark"] input',
            ':root[data-theme="dark"] .auth-dialog',
        ):
            self.assertIn(selector, self.styles)
        for selector in (
            ':root[data-theme="dark"] .pricing-facts',
            ':root[data-theme="dark"] .pricing-package-grid article',
            ':root[data-theme="dark"] .pricing-order-dialog',
        ):
            self.assertIn(selector, self.pricing_styles)

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

    def test_public_language_translation_is_ui_scoped_and_keeps_dynamic_state(self):
        self.assertIn('const PUBLIC_I18N_MARKER = "data-i18n-ui"', self.script)
        self.assertIn('const PUBLIC_I18N_DYNAMIC_MARKER = "data-i18n-dynamic"', self.script)
        self.assertIn("markPublicStaticUi", self.script)
        self.assertIn("setPublicUiAttribute", self.script)
        self.assertIn('setPublicUiAttribute(loginPasswordToggle, "aria-label"', self.script)
        for phrase in ('["头发", "頭髮"]', '["皇后", "皇后"]', '["干杯", "乾杯"]'):
            self.assertIn(phrase, self.script)

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
                self.assertNotIn("__SITE_NAVIGATION_CSS_VERSION__", response.text)
                self.assertNotIn("__SITE_NAVIGATION_JS_VERSION__", response.text)
                self.assertRegex(response.text, r'/assets/opc/site-navigation\.css\?v=\d+-\d+')
                self.assertRegex(response.text, r'/assets/opc/site-navigation\.js\?v=\d+-\d+')

    def test_admin_runtime_form_exposes_cookie_policy(self):
        for field_id in (
            "rtRememberLoginEnabled",
            "rtRememberLoginDefault",
            "rtRememberLoginDays",
            "rtSessionHours",
        ):
            self.assertIn(f'id="{field_id}"', self.admin_html)
            self.assertIn(field_id, self.admin_js)

    def test_admin_profile_menu_exposes_session_details_and_actions(self):
        for field_id in (
            "adminProfileToggle",
            "adminProfilePanel",
            "adminProfileClose",
            "adminSessionName",
            "adminSessionId",
            "adminSessionCreatedAt",
            "btnAdminAccountSettings",
            "btnAdminLogout",
            "adminLogoutMsg",
        ):
            self.assertIn(f'id="{field_id}"', self.admin_html)
            self.assertIn(field_id, self.admin_js)
        self.assertIn('aria-controls="adminProfilePanel"', self.admin_html)
        self.assertIn('aria-expanded="false"', self.admin_html)
        self.assertIn('setActiveAdminPage("account")', self.admin_js)
        self.assertIn('event.key === "Escape"', self.admin_js)
        self.assertIn('api("/api/auth/logout", { method: "POST" })', self.admin_js)
        self.assertIn('window.location.replace("/admin")', self.admin_js)

        public_links = self.admin_html.index('id="adminPublicLinks"')
        profile_panel = self.admin_html.index('id="adminProfilePanel"')
        main_content = self.admin_html.index('<main class="main">')
        self.assertLess(public_links, profile_panel)
        profile_markup = self.admin_html[profile_panel:main_content]
        self.assertNotIn('href="/"', profile_markup)
        self.assertNotIn('href="/admin-console.html"', profile_markup)


if __name__ == "__main__":
    unittest.main()
