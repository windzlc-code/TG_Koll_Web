import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminSharedAccountPanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.admin_script = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.navigation_script = (ROOT / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.server = (ROOT / "server.py").read_text(encoding="utf-8")

    def test_admin_uses_the_shared_account_drawer_host(self):
        self.assertIn('id="adminSharedAccountHost"', self.html)
        self.assertIn('meta name="admin-console-session" content="1"', self.html)
        self.assertIn('/assets/opc/site-navigation.css?v=__SITE_NAVIGATION_CSS_VERSION__', self.html)
        self.assertNotIn('id="adminProfileModal"', self.html)
        self.assertNotIn("openAdminProfileModal", self.admin_script)
        self.assertIn("navigation.mountAccountMenu?.(accountHost, { page: \"home\" })", self.admin_script)
        self.assertIn("navigation.setAccount?.(me)", self.admin_script)

    def test_shared_navigation_exposes_account_menu_mount_api(self):
        self.assertIn('function mountAccountMenu(host, { page = "home" } = {})', self.navigation_script)
        self.assertIn("mountAccountMenu,", self.navigation_script)
        self.assertIn('"__SITE_NAVIGATION_CSS_VERSION__": _asset_version("assets", "opc", "site-navigation.css")', self.server)


if __name__ == "__main__":
    unittest.main()
