import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN_HTML = ROOT / "webapp" / "static" / "admin.html"
ADMIN_JS = ROOT / "webapp" / "static" / "assets" / "admin.js"
ADMIN_CSS = ROOT / "webapp" / "static" / "assets" / "style.css"


class AdminBrowserCacheCleanupContractTests(unittest.TestCase):
    def test_runtime_card_exposes_safe_cleanup_controls_and_status(self):
        markup = ADMIN_HTML.read_text(encoding="utf-8")

        for marker in (
            'id="rtBrowserCacheCleanupEnabled"',
            'id="rtBrowserCacheCleanupIntervalDays"',
            'value="15"',
            'id="browserCacheCleanupStatus"',
            'id="browserCacheCleanupLastRun"',
            'id="browserCacheCleanupNextRun"',
            'id="browserCacheCleanupReclaimed"',
            'id="btnRunBrowserCacheCleanup"',
            "不触碰 Cookie、站点存储与登录状态",
            "检测到任何浏览器任务时本轮整体延后",
        ):
            self.assertIn(marker, markup)

    def test_runtime_config_persists_schedule_and_run_uses_dedicated_endpoint(self):
        source = ADMIN_JS.read_text(encoding="utf-8")

        self.assertIn("browser_cache_cleanup_enabled:", source)
        self.assertIn("browser_cache_cleanup_interval_days:", source)
        self.assertIn('api("/api/admin/runtime_config", {', source)
        self.assertIn('api("/api/admin/browser-cache-cleanup/run", { method: "POST" })', source)
        self.assertIn("renderBrowserCacheCleanupStatus(v);", source)
        self.assertIn("requestAdminPublicAction({", source)
        self.assertIn('skipped_busy: "本轮已安全延后"', source)
        self.assertIn("data.deleted_count ?? data.cleaned_profile_count", source)
        self.assertNotIn('api("/api/admin/browser-cache-cleanup/run", { method: "DELETE" })', source)

    def test_cleanup_status_layout_keeps_compact_blue_gray_visuals(self):
        styles = ADMIN_CSS.read_text(encoding="utf-8")

        self.assertIn(".page-admin .admin-browser-cache-status", styles)
        self.assertIn(".page-admin .admin-browser-cache-run", styles)
        self.assertIn("background: #263b4d;", styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", styles)


if __name__ == "__main__":
    unittest.main()
