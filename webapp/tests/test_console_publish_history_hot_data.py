from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
REFRESH_SCRIPT = (ROOT / "tool_r18" / "scripts" / "skills" / "persona-dashboard-refresh.ts").read_text(encoding="utf-8")
ARCHIVE_STORE = (ROOT / "tool_r18" / "src" / "runtime" / "node" / "persona-archive-store.ts").read_text(encoding="utf-8")


def function_source(name: str, next_name: str) -> str:
    start = CONSOLE_JS.index(f"function {name}")
    end = CONSOLE_JS.index(f"function {next_name}", start)
    return CONSOLE_JS[start:end]


class ConsolePublishHistoryHotDataTests(unittest.TestCase):
    def test_publish_history_renders_full_hot_metrics_and_manual_refresh(self):
        preview = function_source("renderPublishHistoryPreview", "renderPublishHistoryPanel")
        panel = function_source("renderPublishHistoryPanel", "requeuePublishHistoryRecord")

        self.assertIn("hot_metrics", preview)
        for label in ("热度", "浏览", "点赞", "评论", "分享", "转发"):
            self.assertIn(label, preview)
        self.assertIn("data-publish-history-refresh", panel)
        self.assertIn("刷新热点数据", panel)

    def test_manual_hot_refresh_uses_authenticated_source_and_reloads_history(self):
        refresh = function_source("refreshPublishHistoryHotData", "publishGroupSelectionState")

        self.assertIn('api("/api/persona_dashboard/refresh"', refresh)
        self.assertIn('source: "browser"', refresh)
        self.assertIn("/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}", refresh)
        self.assertIn("loadPersonaPublishHistory(cleanPersonaId, { force: true })", refresh)
        self.assertIn("publishHistoryRefreshPersonaId = cleanPersonaId", refresh)
        self.assertIn("syncPublishHistoryRefreshDom", refresh)
        self.assertEqual(refresh.count('renderSimpleFlowModule("publishing")'), 1)

    def test_refresh_progress_is_scoped_to_the_selected_persona(self):
        panel = function_source("renderPublishHistoryPanel", "syncPublishHistoryRefreshDom")
        self.assertIn("publishHistoryRefreshPersonaId === personaId", panel)
        self.assertIn("ownsRefresh ? state.publishHistoryRefreshStatus : null", panel)
        self.assertIn("data-publish-history-refresh-status", panel)

    def test_sidebar_items_have_theme_aware_dividers(self):
        self.assertIn(".console-page .module-accordion-item + .module-accordion-item", CONSOLE_CSS)
        self.assertIn(".console-page .console-nav > button:not(.nav-parent-toggle)::before", CONSOLE_CSS)
        self.assertIn(".console-page .sidebar-bottom-actions", CONSOLE_CSS)
        self.assertIn("var(--line)", CONSOLE_CSS)
        self.assertIn("pointer-events: none", CONSOLE_CSS)

    def test_full_refresh_script_installs_primary_archive_bridge(self):
        self.assertIn("installNodePersonaArchiveBridge", REFRESH_SCRIPT)
        self.assertIn("installNodePersonaArchiveBridge();", REFRESH_SCRIPT)
        self.assertIn("updatePersonaArchiveThreadsHotMetrics", REFRESH_SCRIPT)
        self.assertIn(".then(() => process.exit(0))", REFRESH_SCRIPT)
        self.assertIn("sentimentAuthStatusIsUsable", REFRESH_SCRIPT)
        self.assertIn('["healthy", "watch"]', REFRESH_SCRIPT)
        self.assertIn("authorizationNeedsRefresh !== true", REFRESH_SCRIPT)
        self.assertIn("withArchiveFileLock", ARCHIVE_STORE)
        self.assertIn("threads_binding_changed", ARCHIVE_STORE)

    def test_publish_history_rejects_unsafe_external_links(self):
        preview = function_source("renderPublishHistoryPreview", "renderPublishHistoryPanel")
        self.assertIn("safeExternalHttpUrl", preview)
        self.assertNotIn('String(activeRecord?.source_url', preview)

    def test_custom_proxy_idempotency_fingerprint_is_not_written_to_dom(self):
        self.assertIn("const accountProxyCustomRequestState = new WeakMap()", CONSOLE_JS)
        self.assertNotIn("dataset.proxyCustomRequestFingerprint", CONSOLE_JS)


if __name__ == "__main__":
    unittest.main()
