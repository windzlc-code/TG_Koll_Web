from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
REFRESH_SCRIPT = (ROOT / "tool_r18" / "scripts" / "skills" / "persona-dashboard-refresh.ts").read_text(encoding="utf-8")


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

    def test_sidebar_items_have_theme_aware_dividers(self):
        self.assertIn(".console-page .module-accordion-item + .module-accordion-item", CONSOLE_CSS)
        self.assertIn(".console-page .console-nav > button:not(.nav-parent-toggle)::before", CONSOLE_CSS)
        self.assertIn(".console-page .sidebar-bottom-actions", CONSOLE_CSS)
        self.assertIn("var(--line)", CONSOLE_CSS)
        self.assertIn("pointer-events: none", CONSOLE_CSS)

    def test_full_refresh_script_installs_primary_archive_bridge(self):
        self.assertIn('import { installNodePersonaArchiveBridge }', REFRESH_SCRIPT)
        self.assertIn("installNodePersonaArchiveBridge();", REFRESH_SCRIPT)


if __name__ == "__main__":
    unittest.main()
