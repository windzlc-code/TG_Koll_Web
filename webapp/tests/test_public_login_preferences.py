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

    def test_customer_login_return_url_cannot_select_admin_surfaces(self):
        client = TestClient(self.app)
        direct_admin = client.get(
            "/login.html?return_url=%2Fadmin.html",
            follow_redirects=False,
        )
        self.assertEqual(direct_admin.status_code, 302, direct_admin.text)
        self.assertEqual(direct_admin.headers["location"], "/?login=1&return_url=%2Fconsole.html")

        admin_query = client.get(
            "/login.html?return_url=%2Fproxy-market.html%3Fadmin_console%3D1",
            follow_redirects=False,
        )
        self.assertEqual(admin_query.status_code, 302, admin_query.text)
        self.assertEqual(admin_query.headers["location"], "/?login=1&return_url=%2Fconsole.html")

    def test_shared_home_login_detects_admin_role_and_uses_admin_cookie(self):
        client = TestClient(self.app)
        response = client.post(
            "/api/auth/portal-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["is_admin"])
        self.assertIsNotNone(client.cookies.get("admin_session_token"))
        self.assertIsNone(client.cookies.get("session_token"))
        session = client.get("/api/auth/me", headers={"X-Admin-Console": "1"})
        self.assertEqual(session.status_code, 200, session.text)
        self.assertTrue(session.json()["is_admin"])

    def test_admin_entry_redirects_anonymous_users_to_shared_home_login(self):
        client = TestClient(self.app)
        for path in ("/admin", "/admin-login.html"):
            with self.subTest(path=path):
                response = client.get(path, follow_redirects=False)
                self.assertEqual(response.status_code, 302, response.text)
                self.assertEqual(
                    response.headers["location"],
                    "/?login=1&return_url=%2Fadmin",
                )

    def test_public_pages_receive_the_shared_fixed_light_stylesheet_last(self):
        client = TestClient(self.app)
        for path in ("/", "/subscription.html", "/about-vecto.html", "/proxy-market.html"):
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 200, response.text)
                markup = response.text
                self.assertIn('/assets/fixed-light.css?v=', markup)
                self.assertLess(
                    markup.rindex('rel="stylesheet"'),
                    markup.index('document.documentElement.dataset.theme="light"'),
                )


class PublicLoginUiSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.static_dir = Path(server.__file__).resolve().parent / "static"
        cls.script = (cls.static_dir / "assets" / "opc" / "script.js").read_text(encoding="utf-8")
        cls.styles = (cls.static_dir / "assets" / "opc" / "styles.css").read_text(encoding="utf-8")
        cls.pricing_styles = (cls.static_dir / "assets" / "opc" / "pricing.css").read_text(encoding="utf-8")
        cls.site_nav_script = (cls.static_dir / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.site_nav_styles = (cls.static_dir / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
        cls.fixed_light_styles = (cls.static_dir / "assets" / "fixed-light.css").read_text(encoding="utf-8")
        cls.proxy_market_js = (cls.static_dir / "assets" / "opc" / "proxy-market.js").read_text(encoding="utf-8")
        cls.admin_js = (cls.static_dir / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.console_js = (cls.static_dir / "assets" / "console.js").read_text(encoding="utf-8")
        cls.admin_html = (cls.static_dir / "admin.html").read_text(encoding="utf-8")
        cls.auth_js = (cls.static_dir / "assets" / "auth.js").read_text(encoding="utf-8")
        cls.automation_log_html = (cls.static_dir / "persona-automation-log.html").read_text(encoding="utf-8")
        cls.server_source = Path(server.__file__).read_text(encoding="utf-8")

    def test_backdrop_click_does_not_close_login(self):
        self.assertNotIn("if (event.target === loginModal) closeLogin()", self.script)
        self.assertIn('[data-close-login]', self.script)

    def test_admin_login_page_is_removed_and_shared_login_handles_admins(self):
        self.assertFalse((self.static_dir / "admin-login.html").exists())
        self.assertNotIn("_admin_login_page", self.server_source)
        self.assertIn('api("/api/auth/portal-login"', self.script)
        self.assertIn("result?.is_admin === true", self.script)
        self.assertNotIn("adminLoginForm", self.auth_js)
        self.assertNotIn("/api/auth/admin-login", self.auth_js)

    def test_shared_login_keeps_the_current_public_page_after_success(self):
        home = (self.static_dir / "index.html").read_text(encoding="utf-8")
        self.assertIn("登入後保留在目前頁面", home)
        self.assertIn("登入並繼續", home)
        self.assertNotIn("成功後直接進入 Web 任務控制台", home)
        self.assertIn("refreshPublicSession", self.site_nav_script)
        self.assertIn("await window.VectoSiteNavigation?.refreshPublicSession?.()", self.script)
        self.assertNotIn(
            "window.location.assign(result?.must_change_password ? passwordTarget : safeRedirect);",
            self.script,
        )

    def test_logout_returns_to_a_public_page_without_opening_login_automatically(self):
        profile_script = (self.static_dir / "assets" / "profile.js").read_text(encoding="utf-8")
        admin_logout = self.admin_js.split("async function logoutAdmin()", 1)[1].split("function runtimeFormToPayload", 1)[0]
        self.assertIn("function publicLogoutLocation()", self.site_nav_script)
        self.assertNotIn("window.location.reload()", self.site_nav_script)
        self.assertNotIn('"/?login=1&return_url=%2Fprofile.html"', profile_script)
        self.assertIn('window.location.replace("/")', admin_logout)
        self.assertNotIn('ADMIN_CONSOLE_SESSION ? "/admin" : "/"', self.console_js)

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
        self.assertIn('path: adminConsoleTarget("", workspaceUserId)', self.site_nav_script)
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

        for page_name in (
            "index.html",
            "pricing.html",
            "console.html",
            "about-vecto.html",
            "admin.html",
        ):
            page = (self.static_dir / page_name).read_text(encoding="utf-8")
            with self.subTest(page=page_name):
                self.assertIn(
                    "/assets/opc/site-navigation.js?v=__SITE_NAVIGATION_JS_VERSION__",
                    page,
                )

    def test_admin_proxy_market_entry_preserves_separate_admin_session(self):
        self.assertIn('href="/proxy-market.html?admin_console=1"', self.admin_html)
        self.assertIn(
            'const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context"',
            self.proxy_market_js,
        )
        self.assertIn("function adminConsoleContextActive()", self.proxy_market_js)
        self.assertIn("function seedAdminConsoleContext()", self.proxy_market_js)
        self.assertIn('headers.set("X-Admin-Console", "1")', self.proxy_market_js)
        self.assertIn("seedAdminConsoleContext();", self.proxy_market_js)
        self.assertIn("function captureSessionContext()", self.proxy_market_js)
        self.assertIn("captureSessionContext();", self.proxy_market_js)
        self.assertIn('headers.set("X-Admin-Workspace-User-ID", state.workspaceUserId)', self.proxy_market_js)
        self.assertIn('MARKET_PARAMS.get("admin_workspace_user_id")', self.proxy_market_js)
        self.assertIn("function seedExplicitAdminContext()", self.site_nav_script)
        self.assertIn(
            "const preserveWorkspace = publicPagePreservesAdminWorkspace()",
            self.site_nav_script,
        )
        self.assertIn(
            "fetchSessionAccount({ admin: true, workspaceUserId })",
            self.site_nav_script,
        )
        self.assertIn("function syncOperationalPublicTargets()", self.site_nav_script)
        self.assertIn('url.searchParams.set("admin_console", "1")', self.site_nav_script)
        self.assertIn('url.searchParams.set("admin_workspace_user_id", workspaceUserId)', self.site_nav_script)
        self.assertIn('[data-site-home-label]', self.site_nav_script)
        self.assertIn('[data-site-nav-key="aboutVecto"]', self.site_nav_script)
        self.assertIn('"/about-vecto.html",', self.site_nav_script)
        self.assertIn('["home", "aboutVecto", "proxyMarket", "pricing"].includes(page)', self.site_nav_script)
        self.assertIn('url.searchParams.delete("admin_workspace_user_id")', self.site_nav_script)
        self.assertIn("function adminWorkspacePageUrl(value)", self.console_js)
        self.assertIn('data-proxy-market-open', self.console_js)
        self.assertIn("openProxyMarketModal();", self.console_js)
        self.assertIn('adminWorkspacePageUrl(publishedUrl)', self.console_js)
        self.assertIn('adminWorkspacePageUrl(resultUrl)', self.console_js)
        self.assertIn('sessionStorage.getItem("vecto-admin-console-context") === "1"', self.automation_log_html)
        self.assertIn('sessionStorage.getItem("vecto-admin-workspace-user-id")', self.automation_log_html)

    def test_admin_direct_download_and_forced_password_routes_keep_admin_context(self):
        self.assertIn(
            "`/api/tasks/${id}/download?admin_console=1`",
            self.admin_js,
        )
        self.assertIn('safeAuthReturnUrl(admin ? "/admin" : "/console.html"', self.auth_js)
        self.assertIn('headers.set("X-Admin-Console", "1")', self.auth_js)

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
        self.assertIn("window.location.replace(publicLogoutLocation())", self.site_nav_script)

    def test_shared_navigation_keeps_language_and_uses_fixed_light_theme(self):
        for expected in ('id="languageToggle"', "site-language-icon"):
            self.assertIn(expected, self.site_nav_script)
        self.assertNotIn('id="themeToggle"', self.site_nav_script)
        self.assertNotIn("site-theme-icon", self.site_nav_script)
        for page_name in ("index.html", "pricing.html"):
            markup = (self.static_dir / page_name).read_text(encoding="utf-8")
            self.assertNotIn("data-site-theme-toggle", markup)
            self.assertIn("data-site-language-toggle", markup)
        self.assertIn("function themeEnabled()", self.site_nav_script)
        self.assertIn("function themeEnabled() {\n    return false;", self.site_nav_script)
        self.assertIn('installUnifiedAccountMenu(header, header.dataset.sitePage || "home")', self.site_nav_script)
        public_controls = self.site_nav_script.split("function renderActions", 1)[1].split("function fallbackMarkup", 1)[0]
        self.assertNotIn("data-site-theme-toggle", public_controls.split("const controls", 1)[1].split("const mobileMenu", 1)[0])
        self.assertIn("data-site-language-toggle", public_controls)
        self.assertIn('function accountPreferencesMarkup(page = "console")', self.site_nav_script)
        self.assertIn('class="site-account-preferences"', self.site_nav_script)
        self.assertIn('actions.querySelectorAll(":scope > .site-global-controls")', self.site_nav_script)
        self.assertIn('const LANGUAGE_STORAGE_KEY = "wk-console-language"', self.site_nav_script)
        self.assertIn('window.addEventListener("storage"', self.site_nav_script)
        self.assertIn('const nextTheme = "light"', self.site_nav_script)
        self.assertIn('setTheme("light", { persist: false })', self.site_nav_script)
        self.assertIn('data-site-mobile-menu', self.site_nav_script)
        self.assertIn('window.addEventListener("vecto:language-change"', self.script)
        self.assertIn("applyPublicLanguage", self.script)
        self.assertIn(':root[data-theme="dark"]', self.site_nav_styles)
        self.assertNotRegex(self.styles, r"(?m)^\.site-header\s*\{")

    def test_mobile_site_navigation_is_modal_and_backdrop_closes_it(self):
        self.assertIn("const mobileMenuIsolation = new WeakMap();", self.site_nav_script)
        self.assertIn("function setMobileMenuBackgroundInert(menu, active)", self.site_nav_script)
        self.assertIn("sibling.inert = true;", self.site_nav_script)
        self.assertIn("setMobileMenuBackgroundInert(menu, true);", self.site_nav_script)
        self.assertIn("setMobileMenuBackgroundInert(menu, false);", self.site_nav_script)
        self.assertIn(
            "if (event.target === backdrop) setMobileMenuOpen(menu, false",
            self.site_nav_script,
        )
        self.assertIn("width: 100vw;", self.site_nav_styles)
        self.assertIn("height: 100dvh;", self.site_nav_styles)
        self.assertIn("body.site-mobile-menu-active", self.site_nav_styles)

    def test_fixed_light_palette_covers_each_public_page_without_recoloring_media(self):
        for selector in (
            ".home-canvas .home-flow-section",
            ".about-canvas .about-capabilities",
            'body[data-login-redirect="/subscription.html"] .pricing-comparison-band',
            ".proxy-market-page .proxy-market-facts",
        ):
            self.assertIn(selector, self.fixed_light_styles)
        self.assertIn("--public-cool: #4b6478", self.fixed_light_styles)
        self.assertIn("--public-warm: #f5f1ec", self.fixed_light_styles)
        self.assertNotIn(".home-canvas .home-media-card img {", self.fixed_light_styles)
        self.assertNotIn(".about-canvas .about-hero-shade {", self.fixed_light_styles)

    def test_fixed_light_palette_also_covers_authenticated_shells(self):
        for selector in (
            ".console-page",
            ".page-admin .admin-page-title",
            "body.profile-page",
            ".auth-dialog",
            '.site-nav a[aria-current="page"]::after',
        ):
            self.assertIn(selector, self.fixed_light_styles)
        self.assertIn("--public-cool: #4b6478", self.fixed_light_styles)
        self.assertIn("--public-warm-accent: #8a674d", self.fixed_light_styles)
        self.assertIn("background: var(--public-paper)", self.fixed_light_styles)

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


    def test_public_registration_moves_application_form_into_shared_auth_dialog(self):
        home = (self.static_dir / "index.html").read_text(encoding="utf-8")
        self.assertNotIn('class="home-contact-section"', home)
        self.assertNotIn('id="contact"', home)

        for page_name in (
            "index.html",
            "pricing.html",
            "about-vecto.html",
            "proxy-market.html",
        ):
            page = (self.static_dir / page_name).read_text(encoding="utf-8")
            with self.subTest(page=page_name):
                self.assertIn("data-open-register", page)
                self.assertNotIn('href="#contact"', page)
                self.assertNotIn('href="/#contact"', page)
                self.assertEqual(page.count('id="loginModal"'), 1)
                header = page.split("</header>", 1)[0]
                self.assertEqual(header.count("data-open-login"), 1)
                self.assertNotIn("data-open-register", header)
                self.assertNotIn("site-guest-action", header)
                self.assertNotIn("site-mobile-menu-extra", header)

        self.assertIn("function registrationPanelMarkup()", self.script)
        self.assertIn('id="accountRegistrationForm"', self.script)
        self.assertIn('data-auth-view="register"', self.script)
        self.assertIn('event.target.closest("[data-open-register]")', self.script)
        self.assertIn('api("/api/auth/apply"', self.script)
        self.assertIn("註冊遊客帳號", self.script)
        self.assertIn("管理員審核通過後", self.script)
        self.assertNotIn("#contact", self.site_nav_script)
        self.assertIn('login: "登录"', self.site_nav_script)
        self.assertIn('login: "登入"', self.site_nav_script)
        self.assertNotIn('class="header-action site-guest-action"', self.site_nav_script)
        self.assertNotIn('className: "site-mobile-menu-extra"', self.site_nav_script)
        self.assertIn("z-index: 300", self.styles)

    def test_retired_register_page_redirects_to_shared_registration_dialog(self):
        self.assertFalse((self.static_dir / "register.html").exists())
        self.assertNotIn('location.href = "/register.html"', self.auth_js)
        client = TestClient(server.create_app())
        response = client.get("/register.html", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/?register=1")

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

        self.assertIn('mfa_code: String(loginForm.mfa_code?.value || "").trim()', self.script)
        self.assertIn('detail.code === "mfa_code_invalid"', self.script)

    def test_public_pages_use_runtime_asset_versions_and_disable_html_cache(self):
        client = TestClient(server.create_app())
        for path in ("/", "/index.html", "/pricing.html"):
            response = client.get(path)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn("no-store", response.headers.get("cache-control", ""))
            self.assertNotIn("__OPC_SCRIPT_VERSION__", response.text)
            self.assertRegex(response.text, r'/assets/opc/script\.js\?v=\d+-\d+')

    def test_retired_user_login_page_redirects_to_shared_home_dialog(self):
        self.assertFalse((self.static_dir / "login.html").exists())
        self.assertNotIn('"login.html",', self.server_source)
        self.assertIn("function openRequestedLogin()", self.script)
        self.assertIn('searchParams.get("login") === "1"', self.script)
        self.assertIn('searchParams.get("register") === "1"', self.script)
        self.assertIn('document.body.dataset.loginRedirect = safeLoginReturnUrl(', self.script)

        client = TestClient(server.create_app())
        response = client.get(
            "/login.html?return_url=%2Fprofile.html",
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response.headers["location"],
            "/?login=1&return_url=%2Fprofile.html",
        )

        unsafe = client.get(
            "/login.html?return_url=https%3A%2F%2Fexample.com%2Fsteal",
            follow_redirects=False,
        )
        self.assertEqual(
            unsafe.headers["location"],
            "/?login=1&return_url=%2Fconsole.html",
        )

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
