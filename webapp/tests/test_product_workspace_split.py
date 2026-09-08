import os
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import server


ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "webapp" / "static"
SERVER = (ROOT / "webapp" / "server.py").read_text(encoding="utf-8")
CONSOLE = (STATIC / "console.html").read_text(encoding="utf-8")
VIDEO = (STATIC / "video.html").read_text(encoding="utf-8")
LOGIN = (STATIC / "product-login.html").read_text(encoding="utf-8")
ADMIN = (STATIC / "admin.html").read_text(encoding="utf-8")
NAVIGATION = (STATIC / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")


def test_product_pages_share_vecto_logo_and_keep_independent_shells():
    assert "/assets/opc/vecto-logo-ui-icon.png" in CONSOLE
    assert "/assets/opc/vecto-logo-ui-icon.png" in VIDEO
    assert "/assets/opc/vecto-logo-ui-icon.png" in LOGIN
    assert 'data-site-page="video"' in VIDEO
    assert 'id="videoWorkbenchRoot"' in VIDEO
    assert 'data-site-nav-key="video"' not in CONSOLE
    assert 'data-site-nav-key="crm"' not in CONSOLE
    assert 'href="/video.html" data-video-entry' not in CONSOLE
    assert ">采集工作台</a>" not in CONSOLE
    assert "推文工作台" in CONSOLE
    video_header = VIDEO.split("<header", 1)[1].split("</header>", 1)[0]
    assert "推文工作台" not in video_header
    assert 'data-site-nav-key="console"' not in video_header
    assert "解决方案" not in video_header
    assert "了解 Vecto" not in video_header
    assert 'data-site-admin-entry' in video_header
    assert 'data-site-language-toggle' in video_header
    assert 'data-product-kind="__PRODUCT_KIND__"' in LOGIN
    assert 'src="/assets/opc/vecto-logo-ui-icon.png' in LOGIN
    assert 'data-view="video_workspace"' not in CONSOLE.split("sidebar-bottom-actions")[0]


def test_admin_sidebar_links_to_each_workspace():
    assert 'href="/admin-console.html">进入推文工作台</a>' in ADMIN
    assert 'href="/admin-video.html">进入视频工作台</a>' in ADMIN
    assert 'href="/crm.html?admin_console=1">进入采集工作台</a>' in ADMIN


def test_server_routes_product_login_by_return_url():
    assert "def _product_login_path_for_return" in SERVER
    assert 'return "/video-login.html"' in SERVER
    assert 'return "/crm-login.html"' in SERVER
    assert 'return "/console-login.html"' in SERVER
    assert '"/video": "/video.html"' in SERVER
    assert "def _canonical_product_page_path" in SERVER
    assert "def page_product_short_alias" in SERVER
    assert '@app.get("/console-login.html"' in SERVER
    assert '@app.get("/video-login.html"' in SERVER
    assert '@app.get("/crm-login.html"' in SERVER
    assert '@app.get("/admin-video.html"' in SERVER


def test_shared_navigation_keeps_workspaces_off_the_public_bar():
    links = NAVIGATION[NAVIGATION.index("function navigationLinks"):NAVIGATION.index("function stripPublicWorkspaceSwitcher")]
    assert "function publicPageKeepsTweetWorkbench" in NAVIGATION
    assert "function isolatedWorkspacePage" in NAVIGATION
    assert "isolatedWorkspacePage(page)" in links
    assert "publicPageKeepsTweetWorkbench(page)" in links
    assert 'key: "console", href: "/console.html"' in links
    assert 'key: "aboutVecto", href: "/about-vecto.html"' in links
    assert 'key: "video", href: "/video.html"' not in links
    assert 'key: "crm", href: "/crm.html"' not in links
    assert 'console: "推文工作台"' in NAVIGATION
    assert "function stripPublicWorkspaceSwitcher" in NAVIGATION
    assert '[data-site-nav-key="console"]' in NAVIGATION[NAVIGATION.index("function stripPublicWorkspaceSwitcher"):NAVIGATION.index("function installCrmDesktopEntry")]
    assert "function syncVideoEntryTargets" in NAVIGATION
    mobile = NAVIGATION[NAVIGATION.index("function mobileNavigationLinks"):NAVIGATION.index("function renderMobileMenu")]
    assert 'key: "console", href: "/console.html"' in mobile
    assert 'key: "video", href: "/video.html"' not in mobile
    assert 'key: "crm", href: "/crm.html"' not in mobile


class ProductWorkspaceSplitHttpTests(unittest.TestCase):
    def setUp(self):
        self.old_env = {
            key: os.environ.get(key)
            for key in (
                "APP_DB_PATH",
                "APP_RUNTIME_CONFIG_PATH",
                "WEBAPP_DATA_DIR",
                "ADMIN_BOOTSTRAP_PASSWORD",
                "SESSION_COOKIE_SECURE",
                "PASSWORD_VAULT_KEY",
                "PASSWORD_VAULT_KEY_FILE",
            )
        }
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
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        self.client = TestClient(server.create_app())

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    def test_anonymous_workspace_pages_use_dedicated_login(self):
        cases = (
            ("/console.html", "/console-login.html?return_url=%2Fconsole.html"),
            ("/video.html", "/video-login.html?return_url=%2Fvideo.html"),
            ("/crm.html", "/crm-login.html?return_url=%2Fcrm.html"),
            ("/profile.html", "/?login=1&return_url=%2Fprofile.html"),
        )
        for path, location in cases:
            response = self.client.get(path, follow_redirects=False)
            self.assertEqual(response.status_code, 302, path)
            self.assertEqual(response.headers["location"], location, path)

    def test_short_workspace_urls_open_the_normal_pages(self):
        cases = (
            ("/console", "/console.html"),
            ("/video", "/video.html"),
            ("/crm", "/crm.html"),
            ("/video/", "/video.html"),
            ("/video-login", "/video-login.html"),
            ("/console-login", "/console-login.html"),
            ("/crm-login", "/crm-login.html"),
            ("/admin-video", "/admin-video.html"),
            ("/admin-console", "/admin-console.html"),
        )
        for path, location in cases:
            response = self.client.get(path, follow_redirects=False)
            self.assertEqual(response.status_code, 302, path)
            self.assertEqual(response.headers["location"], location, path)
        queued = self.client.get("/video?view=digital_human_video", follow_redirects=False)
        self.assertEqual(queued.status_code, 302)
        self.assertEqual(queued.headers["location"], "/video.html?view=digital_human_video")

    def test_dedicated_login_pages_render_branded_form(self):
        for path, title in (
            ("/console-login.html", "推文工作台登录 · Vecto"),
            ("/video-login.html", "视频工作台登录 · Vecto"),
            ("/crm-login.html", "采集工作台登录 · Vecto"),
        ):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertIn(title, response.text)
            self.assertIn("/assets/opc/vecto-logo-ui-icon.png", response.text)
            self.assertIn('id="productLoginForm"', response.text)
            self.assertIn("Vecto", response.text)
