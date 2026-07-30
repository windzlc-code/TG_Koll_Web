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

    def test_notification_cards_open_shared_detail_and_mark_read(self):
        self.assertIn('card.setAttribute("role", "button")', self.navigation)
        self.assertIn('card.setAttribute("aria-haspopup", "dialog")', self.navigation)
        self.assertIn("showNotificationDetail(item)", self.navigation)
        self.assertIn("void markNotificationsRead({ ids: [item.id] })", self.navigation)
        self.assertIn('event.key !== "Enter" && event.key !== " "', self.navigation)
        self.assertIn("function showNotificationDialog(", self.navigation)

    def test_shared_dialogs_require_an_explicit_close_and_prioritize_important_messages(self):
        self.assertNotIn("if (event.target === overlay) close();", self.navigation)
        self.assertNotIn("if (event.target === modal) close();", self.navigation)
        notification_load = self.navigation[
            self.navigation.index("async function loadNotifications")
            : self.navigation.index("async function markNotificationsRead")
        ]
        self.assertIn("item.important", notification_load)
        self.assertIn("importantUnread || latestUnread", notification_load)

    def test_opening_notification_drawer_does_not_mark_every_message_read(self):
        drawer_open = self.navigation[
            self.navigation.index("function setNotificationMenuOpen("):
            self.navigation.index("function accountRoleLabel(")
        ]
        self.assertNotIn("markNotificationsRead({ all: true })", drawer_open)

    def test_notification_controls_and_unread_cards_use_consistent_borders(self):
        close_rule = self.navigation_css[
            self.navigation_css.index(".site-notification-close {"):
            self.navigation_css.index(".site-notification-close svg")
        ]
        self.assertIn("border: 0;", close_rule)
        self.assertIn("outline: none;", close_rule)
        broadcast_close_rule = self.navigation_css[
            self.navigation_css.rindex(".site-notification-broadcast-head button {"):
            self.navigation_css.rindex(".site-notification-broadcast-head button svg")
        ]
        self.assertIn("border: 0;", broadcast_close_rule)
        self.assertIn("outline: none;", broadcast_close_rule)
        close_interaction_rule = self.navigation_css[
            self.navigation_css.index(".site-notification-close:hover,"):
            self.navigation_css.index(".site-notification-close svg")
        ]
        self.assertIn("background: transparent;", close_interaction_rule)
        self.assertNotIn("background: #eef2f4;", close_interaction_rule)
        tab_rule = self.navigation_css[
            self.navigation_css.index(".site-notification-tabs button {"):
            self.navigation_css.index('.site-notification-tabs button[aria-selected="true"]')
        ]
        self.assertIn("border: 1px solid transparent;", tab_rule)
        unread_rule = self.navigation_css[
            self.navigation_css.index(".site-notification-item.is-unread {"):
            self.navigation_css.index(".site-notification-item-meta {")
        ]
        self.assertIn("border-width: 1px;", unread_rule)
        self.assertNotIn("box-shadow: inset", unread_rule)


if __name__ == "__main__":
    unittest.main()
