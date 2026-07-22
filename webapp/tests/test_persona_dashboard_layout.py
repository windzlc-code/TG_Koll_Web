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

    def test_refresh_controls_are_in_the_dashboard_view(self):
        dashboard_start = self.markup.index(
            '<section class="view persona-dashboard-view" data-panel="persona_dashboard">'
        )
        dashboard = self.markup[dashboard_start:]

        self.assertNotIn('<header class="console-topbar">', self.markup)
        self.assertIn('id="viewTitle" class="sr-only"', self.markup)
        self.assertIn('id="personaDashboardTopbarActions"', dashboard)
        self.assertIn('id="btnPersonaDashboardRefresh"', dashboard)
        self.assertIn('id="btnPersonaDashboardRefreshAll"', dashboard)
        self.assertNotIn('class="persona-dashboard-hero"', dashboard)
        self.assertIn(
            'personaTopbarActions.hidden = view !== "persona_dashboard";',
            self.console_script,
        )

    def test_admin_entry_is_beside_subscription_and_keeps_permission_gate(self):
        subscription = self.markup.index('class="site-icon-button site-subscription-link"')
        admin_entry = self.markup.index('id="openAdmin"')
        account_menu = self.markup.index('class="site-account-menu"')

        self.assertLess(subscription, admin_entry)
        self.assertLess(admin_entry, account_menu)
        self.assertIn('class="site-admin-entry admin-only" hidden>运营后台</button>', self.markup)
        self.assertIn('if (me.is_admin) $("openAdmin").hidden = false;', self.console_script)

    def test_workspace_navigation_uses_titles_without_descriptions(self):
        self.assertNotIn('<small>${esc(item.hint)}</small>', self.console_script)
        self.assertNotIn('hint: "人设列表、详情、推文、账号"', self.console_script)
        self.assertIn('<span>${esc(item.label)}</span>', self.console_script)

    def test_mobile_task_dock_reuses_the_five_workspace_modules(self):
        self.assertIn('id="mobileTaskDock"', self.markup)
        self.assertIn("function renderMobileTaskDock()", self.console_script)
        self.assertIn("modules.map((item) =>", self.console_script)
        self.assertIn("renderMobileTaskIcon(item.id)", self.console_script)
        self.assertIn(
            '$("mobileTaskDock")?.addEventListener("click", handleWorkspaceModuleNavigation);',
            self.console_script,
        )
        for module_id in (
            "personas",
            "tweet_generation",
            "publishing",
            "accounts",
            "browser_list",
        ):
            with self.subTest(module_id=module_id):
                self.assertIn(f'{module_id}:', self.console_script)

    def test_mobile_publish_content_expands_without_inner_scroll(self):
        self.assertIn(".mobile-task-dock {", self.styles)
        self.assertIn("grid-template-columns: repeat(5, minmax(0, 1fr));", self.styles)
        self.assertIn(".publish-header-main > .publish-mode-tabs", self.styles)
        self.assertIn(".publish-time-tabs {", self.styles)
        self.assertIn(".publish-post-card-snippet {", self.styles)
        self.assertIn("white-space: pre-wrap;", self.styles)
        self.assertNotIn('.slice(0, 86) || "当前内容为空。"', self.console_script)
        self.assertNotIn('.slice(0, 170))}</p>', self.console_script)

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

    def test_draft_source_controls_are_wide_without_quick_select(self):
        self.assertNotIn("草稿快速选择", self.console_script)
        self.assertNotIn("收藏快速选择", self.console_script)
        self.assertIn(".persona-source-toggle {\n  width: min(100%, 280px);", self.styles)

    def test_hot_card_metrics_use_compact_thousands(self):
        self.assertIn("function hotMetricText(value)", self.console_script)
        self.assertIn("${esc(hotMetricText(value))}", self.console_script)

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
                    "/assets/opc/site-navigation.css?v=__SITE_NAVIGATION_CSS_VERSION__",
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
