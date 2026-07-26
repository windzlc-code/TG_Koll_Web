import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PublicAccountDrawerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.navigation = (ROOT / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.navigation_css = (ROOT / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
        cls.light_css = (ROOT / "static" / "assets" / "fixed-light.css").read_text(encoding="utf-8")

    def test_public_admin_session_exposes_shared_console_entry(self):
        self.assertIn("function syncPublicAdminEntry()", self.navigation)
        self.assertIn("data-site-admin-entry", self.navigation)
        self.assertIn('window.location.assign("/admin.html")', self.navigation)
        admin_entry = self.navigation[
            self.navigation.index("function syncPublicAdminEntry()"):
            self.navigation.index("function currentTheme()")
        ]
        self.assertNotIn("adminConsoleTarget(", admin_entry)
        self.assertIn("syncPublicAdminEntry();", self.navigation)
        self.assertIn(".site-header .site-admin-entry", self.navigation_css)

    def test_desktop_account_panel_is_a_full_height_right_drawer(self):
        marker = "/* Keep desktop account information in the same edge-to-edge side drawer as mobile. */"
        desktop_block = self.light_css[
            self.light_css.index(marker):
            self.light_css.index(":root[data-theme=\"light\"] .site-header .brand-name")
        ]
        self.assertIn("inset: 0 0 0 auto;", desktop_block)
        self.assertIn("height: 100dvh;", desktop_block)
        self.assertIn("max-height: none;", desktop_block)
        self.assertNotIn("calc(var(--site-header-height, 68px) + 12px)", desktop_block)

    def test_desktop_notification_panel_matches_the_account_side_drawer(self):
        desktop_block = self.navigation_css[self.navigation_css.rindex("@media (min-width: 821px)"):]
        self.assertIn(".site-notification-popover {", desktop_block)
        self.assertIn("inset: 0 0 0 auto;", desktop_block)
        self.assertIn("width: min(520px, 42vw);", desktop_block)
        self.assertIn("height: 100dvh;", desktop_block)
        self.assertIn("max-height: none;", desktop_block)
        self.assertNotIn("calc(var(--site-header-height, 68px) + 12px)", desktop_block)


if __name__ == "__main__":
    unittest.main()
