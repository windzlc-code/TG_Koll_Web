from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_HTML = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")


class ConsoleLoadingOverlayTests(unittest.TestCase):
    def test_initial_console_loader_is_visible_until_bootstrap_finishes(self):
        self.assertIn('id="consolePageLoading"', CONSOLE_HTML)
        self.assertEqual(CONSOLE_HTML.count('class="console-page-loading-orbit"'), 1)
        self.assertEqual(CONSOLE_HTML.count('--loader-dot:'), 10)
        self.assertIn('.console-page-loading {', CONSOLE_CSS)
        self.assertIn('z-index: 100;', CONSOLE_CSS)
        self.assertIn('pointer-events: none;', CONSOLE_CSS)
        self.assertIn('inset: var(--site-header-height) 0 0;', CONSOLE_CSS)
        self.assertIn('bottom: var(--mobile-task-dock-height);', CONSOLE_CSS)
        self.assertIn('background: var(--bg);', CONSOLE_CSS)
        self.assertIn('.console-page.is-console-ready .console-page-loading {', CONSOLE_CSS)
        self.assertIn('transition: opacity 260ms ease, visibility 0s linear 260ms;', CONSOLE_CSS)
        self.assertIn('@keyframes console-page-loading-dot', CONSOLE_CSS)
        self.assertIn('background: var(--accent);', CONSOLE_CSS)

    def test_loader_releases_after_the_first_console_frame_while_data_refreshes(self):
        self.assertIn('function setConsolePageLoading(loading)', CONSOLE_JS)
        self.assertIn('function syncConsolePageLoading()', CONSOLE_JS)
        self.assertIn('syncConsolePageLoading();', CONSOLE_JS)
        self.assertIn('finishWorkspaceBootstrapLoading();\n  if (me.is_admin)', CONSOLE_JS)
        self.assertIn('void Promise.all([billingCatalogReady, tasksReady, socialReady, personasReady])', CONSOLE_JS)
        self.assertNotIn('await Promise.all([tasksReady, socialReady, personasReady]);', CONSOLE_JS)

    def test_persona_dashboard_reuses_the_page_bootstrap_for_its_first_frame(self):
        dashboard_js = (ROOT / "webapp" / "static" / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        self.assertIn('window.__PERSONA_DASHBOARD_BOOTSTRAP__ || window.__CONSOLE_BOOTSTRAP__', dashboard_js)
        self.assertIn('window.__PERSONA_DASHBOARD_BOOTSTRAP__ = window.__CONSOLE_BOOTSTRAP__;', CONSOLE_HTML)
        self.assertIn('let personaDashboardLastLoadedAt = personaDashboardData ? Date.now() : 0;', dashboard_js)

    def test_dashboard_requests_do_not_control_the_console_loader(self):
        dashboard_js = (ROOT / "webapp" / "static" / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        self.assertIn('setConsolePageLoading(Boolean(state.workspaceBootstrapPending));', CONSOLE_JS)
        self.assertNotIn('personaDashboardLoading', CONSOLE_JS)
        self.assertNotIn('vecto:persona-dashboard-loading', CONSOLE_JS)
        self.assertNotIn('pdSetConsoleLoading', dashboard_js)

    def test_dashboard_reentry_reuses_recent_data_without_showing_the_page_loader(self):
        dashboard_js = (ROOT / "webapp" / "static" / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        self.assertIn('const PD_DASHBOARD_VIEW_CACHE_MS = 60 * 1000;', dashboard_js)
        self.assertIn('let personaDashboardLoadPromise = null;', dashboard_js)
        self.assertIn('if (personaDashboardLoadPromise) {', dashboard_js)
        self.assertIn('if (personaDashboardData) {', dashboard_js)
        self.assertIn('pdRenderDashboard();', dashboard_js)

    def test_dashboard_reentry_refreshes_stale_data_silently(self):
        dashboard_js = (ROOT / "webapp" / "static" / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        self.assertIn('function pdDashboardViewCacheIsFresh()', dashboard_js)
        self.assertIn('if (!pdDashboardViewCacheIsFresh()) void pdLoadDashboard({ silent: true });', dashboard_js)
        self.assertIn('const silent = Boolean(options && options.silent);', dashboard_js)

    def test_manual_dashboard_refresh_remains_blocking(self):
        dashboard_js = (ROOT / "webapp" / "static" / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        self.assertIn('refresh.addEventListener("click", pdStartRefresh);', dashboard_js)
        self.assertIn('if (personaDashboardRefreshTask) return;', dashboard_js)
        self.assertIn('if (personaDashboardLoadPromise) {\n    return personaDashboardLoadPromise;', dashboard_js)
        self.assertIn('if (!silent) pdSetMsg("正在加载人设数据...", "ok");', dashboard_js)
        self.assertIn('void pdLoadDashboard();', dashboard_js)

if __name__ == "__main__":
    unittest.main()
