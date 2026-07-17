import re
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import webapp.server as server

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = REPO_ROOT / "webapp" / "static"


class PersonaDashboardLayoutContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (STATIC_ROOT / "console.html").read_text(encoding="utf-8")
        cls.console_script = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.dashboard_script = (STATIC_ROOT / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        cls.styles = (STATIC_ROOT / "assets" / "console.css").read_text(encoding="utf-8")
        cls.navigation_styles = (
            STATIC_ROOT / "assets" / "opc" / "site-navigation.css"
        ).read_text(encoding="utf-8")

    def test_refresh_controls_are_in_the_console_topbar(self):
        topbar_start = self.markup.index('<header class="console-topbar">')
        topbar_end = self.markup.index("</header>", topbar_start)
        topbar = self.markup[topbar_start:topbar_end]
        dashboard_start = self.markup.index(
            '<section class="view persona-dashboard-view" data-panel="persona_dashboard">'
        )
        dashboard = self.markup[dashboard_start:]

        self.assertIn('id="personaDashboardTopbarActions"', topbar)
        self.assertIn('id="btnPersonaDashboardRefresh"', topbar)
        self.assertIn('id="btnPersonaDashboardRefreshAll"', topbar)
        self.assertNotIn('id="btnPersonaDashboardRefresh"', dashboard)
        self.assertNotIn('class="persona-dashboard-hero"', dashboard)
        self.assertIn(
            'personaTopbarActions.hidden = view !== "persona_dashboard";',
            self.console_script,
        )

    def test_refresh_actions_have_distinct_labels_and_behaviors(self):
        self.assertIn(">刷新显示</button>", self.markup)
        self.assertIn(">同步全部数据</button>", self.markup)
        self.assertIn(
            'personaDashboardRoot?.querySelector(`#${id}`) || document.getElementById(id)',
            self.dashboard_script,
        )
        self.assertIn(
            'refresh.addEventListener("click", () => pdLoadDashboard())',
            self.dashboard_script,
        )
        self.assertIn(
            'refreshAll.addEventListener("click", () => pdStartRefresh(""))',
            self.dashboard_script,
        )

    def test_dashboard_layout_uses_scoped_console_rules(self):
        required_rules = (
            ".persona-dashboard-topbar-actions",
            ".persona-dashboard-view #personaDashboardMsg:empty",
            ".persona-dashboard-view .persona-kpi-grid",
            ".persona-dashboard-view .persona-chart-panel",
            ".persona-dashboard-view .persona-workbench-panel",
        )
        for rule in required_rules:
            with self.subTest(rule=rule):
                self.assertIn(rule, self.styles)

    def test_dashboard_charts_reuse_the_console_accent(self):
        self.assertIn('const colors = ["var(--accent)"', self.dashboard_script)
        self.assertIn('color: "var(--accent)"', self.dashboard_script)
        self.assertIn(
            ".persona-dashboard-view .persona-bar-fill",
            self.styles,
        )

    def test_shared_navigation_isolated_from_legacy_brand_styles(self):
        header_rule = re.search(
            r"\.site-header\s*\{(?P<body>.*?)\}",
            self.navigation_styles,
            re.DOTALL,
        )
        self.assertIsNotNone(header_rule)
        self.assertIn("font-size: 16px;", header_rule.group("body"))
        self.assertIn("line-height: normal;", header_rule.group("body"))

        brand_rule = re.search(
            r"\.site-header \.brand\s*\{(?P<body>.*?)\}",
            self.navigation_styles,
            re.DOTALL,
        )
        self.assertIsNotNone(brand_rule)
        for declaration in (
            "padding: 0;",
            "background: transparent;",
            "border: 0;",
            "border-radius: 0;",
            "box-shadow: none;",
        ):
            with self.subTest(declaration=declaration):
                self.assertIn(declaration, brand_rule.group("body"))

        for page in ("index.html", "console.html", "pricing.html"):
            markup = (STATIC_ROOT / page).read_text(encoding="utf-8")
            with self.subTest(page=page):
                self.assertIn(
                    "/assets/opc/site-navigation.css?v=2026071706",
                    markup,
                )

    def test_full_refresh_scope_is_limited_to_visible_personas(self):
        user = {"id": 7}
        with mock.patch.object(
            server,
            "_visible_persona_ids",
            return_value={"persona-b", "persona-a"},
        ):
            self.assertEqual(
                server._persona_dashboard_refresh_archive_ids("", user),
                ["persona-a", "persona-b"],
            )

    def test_single_refresh_scope_still_checks_persona_access(self):
        user = {"id": 7}
        with mock.patch.object(server, "_require_persona_access") as require_access:
            self.assertEqual(
                server._persona_dashboard_refresh_archive_ids("persona-a", user),
                ["persona-a"],
            )
        require_access.assert_called_once_with("persona-a", user)

    def test_full_refresh_rejects_an_empty_visible_scope(self):
        with mock.patch.object(server, "_visible_persona_ids", return_value=set()):
            with self.assertRaises(HTTPException) as raised:
                server._persona_dashboard_refresh_archive_ids("", {"id": 7})
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
