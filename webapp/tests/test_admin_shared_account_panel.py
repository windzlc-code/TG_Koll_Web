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
        self.assertLess(self.html.index('id="adminProfileMenu"'), self.html.index('id="adminMobileDrawer"'))
        self.assertNotIn('id="adminProfileModal"', self.html)
        self.assertNotIn("openAdminProfileModal", self.admin_script)
        self.assertIn("navigation.mountAccountMenu?.(accountHost, { page: \"console\" })", self.admin_script)
        self.assertIn("navigation.setAccount?.(me)", self.admin_script)
        self.assertIn('data-site-open-console-view="tasks"', self.navigation_script)
        self.assertIn('data-site-open-console-view="console_settings"', self.navigation_script)
        self.assertIn("openWorkspaceConsoleView(view)", self.navigation_script)
        self.assertIn("window.location.assign(adminConsoleTarget(view, storedAdminWorkspaceUserId()))", self.navigation_script)

    def test_shared_navigation_exposes_account_menu_mount_api(self):
        self.assertIn('function mountAccountMenu(host, { page = "home" } = {})', self.navigation_script)
        self.assertIn("mountAccountMenu,", self.navigation_script)
        self.assertIn('"__SITE_NAVIGATION_CSS_VERSION__": _asset_version("assets", "opc", "site-navigation.css")', self.server)

    def test_mobile_admin_header_keeps_shared_utilities_in_the_header_row(self):
        style = (ROOT / "static" / "assets" / "style.css").read_text(encoding="utf-8")
        self.assertIn(".page-admin .admin-profile-menu {\n    position: static;", style)
        self.assertIn(":root .page-admin .admin-profile-menu :is(.admin-language-toggle, .site-user)", style)
        self.assertIn("color: #effff9;", style)
        self.assertIn("@media (min-width: 761px)", style)
        self.assertIn("color: #19394a;", style)


if __name__ == "__main__":
    unittest.main()
