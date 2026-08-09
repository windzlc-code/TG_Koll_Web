from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
WEBAPP_ROOT = REPO_ROOT / "webapp"
STATIC_ROOT = WEBAPP_ROOT / "static"


class ProxyMarketRemovalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server_source = (WEBAPP_ROOT / "server.py").read_text(encoding="utf-8")
        cls.console_markup = (STATIC_ROOT / "console.html").read_text(encoding="utf-8")
        cls.console_script = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.console_styles = (STATIC_ROOT / "assets" / "console.css").read_text(encoding="utf-8")
        cls.navigation_script = (STATIC_ROOT / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.admin_markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.admin_script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.social_api_source = (WEBAPP_ROOT / "social_automation_api.py").read_text(encoding="utf-8")
        cls.system_proxy_pool_source = (WEBAPP_ROOT / "system_proxy_pool.py").read_text(encoding="utf-8")
        cls.proxy_admin_source = (WEBAPP_ROOT / "proxy_ip_admin.py").read_text(encoding="utf-8")
        cls.db_source = (WEBAPP_ROOT / "db.py").read_text(encoding="utf-8")

    def test_standalone_market_assets_and_backend_module_are_removed(self):
        self.assertFalse((STATIC_ROOT / "proxy-market.html").exists())
        self.assertFalse((STATIC_ROOT / "assets" / "opc" / "proxy-market.js").exists())
        self.assertFalse((STATIC_ROOT / "assets" / "opc" / "proxy-market.css").exists())
        self.assertFalse((WEBAPP_ROOT / "proxy_market.py").exists())

    def test_public_market_routes_and_navigation_stay_removed(self):
        combined = "\n".join(
            (
                self.server_source,
                self.navigation_script,
                self.console_markup,
                self.console_script,
            )
        )
        for fragment in (
            '@app.get("/proxy-market.html"',
            "register_proxy_market_routes",
            'href="/proxy-market.html"',
            'data-site-nav-key="proxyMarket"',
            "/api/proxy-market/",
        ):
            self.assertNotIn(fragment, combined)

    def test_admin_proxy_inventory_workspace_is_retained(self):
        self.assertIn('data-page="proxyMarket"', self.admin_markup)
        self.assertIn('data-page-view="proxyMarket"', self.admin_markup)
        self.assertIn("代理 IP 管理", self.admin_markup)
        self.assertNotIn('href="/proxy-market.html"', self.admin_markup)
        self.assertIn("/api/admin/proxy-market/items", self.admin_script)
        self.assertIn("register_proxy_ip_admin_routes(app)", self.server_source)
        self.assertIn('@app.get("/api/admin/proxy-market/items")', self.proxy_admin_source)
        self.assertNotIn('@app.get("/api/proxy-market/catalog")', self.proxy_admin_source)

    def test_console_keeps_custom_proxy_and_adds_on_demand_system_pool(self):
        self.assertIn("data-system-proxy-pool-open", self.console_script)
        self.assertIn("data-proxy-add", self.console_script)
        self.assertIn("<span>添加代理 IP</span>", self.console_script)
        self.assertNotIn("<span>添加 IP</span>", self.console_script)
        self.assertIn("<span>自定义代理</span>", self.console_script)
        self.assertIn(
            'function openSystemProxyPoolModal({ accountId = "", selectedProxyId = "" } = {})',
            self.console_script,
        )
        self.assertIn(
            '"/api/persona_dashboard/automation/system-proxy-pool"',
            self.console_script,
        )
        self.assertIn("function openProxyModal(proxyId = \"\")", self.console_script)
        self.assertNotIn("data-system-proxy-custom-add", self.console_script)
        self.assertIn("data-account-system-proxy-pool-open", self.console_script)
        self.assertIn(".system-proxy-pool-link {", self.console_styles)
        self.assertIn(".account-system-proxy-pool-add {", self.console_styles)
        self.assertNotIn("openProxyMarketModal", self.console_script)
        self.assertNotIn("proxyMarketUnreadBadge", self.console_markup)

    def test_shared_system_pool_keeps_the_limit_in_the_compact_header(self):
        self.assertIn(
            '<span class="system-proxy-pool-limit">只能免费领取 1 个</span>',
            self.console_script,
        )
        self.assertIn(".system-proxy-pool-limit {", self.console_styles)
        self.assertIn(
            ".system-proxy-pool-modal .console-modal-head > div {\n  display: grid;\n  flex: 1 1 auto;",
            self.console_styles,
        )
        self.assertIn("justify-content: space-between;", self.console_styles)
        self.assertNotIn("system-proxy-pool-guide", self.console_script)
        self.assertNotIn(".system-proxy-pool-guide", self.console_styles)

    def test_shared_system_pool_uses_the_legacy_embedded_market_dimensions(self):
        self.assertIn(
            "width: min(840px, calc(100vw - 32px));",
            self.console_styles,
        )
        self.assertIn(
            ".system-proxy-pool-modal {\n  width: min(840px, calc(100vw - 32px));\n  grid-template-rows: auto minmax(0, 1fr);",
            self.console_styles,
        )
        self.assertIn("max-height: min(70vh, 720px);", self.console_styles)
        self.assertIn(
            ".proxy-market-mini-grid {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));",
            self.console_styles,
        )
        self.assertIn(
            ".console-page .proxy-market-mini-grid {\n    grid-template-columns: minmax(0, 1fr);",
            self.console_styles,
        )
        self.assertNotIn("system-proxy-pool-actions", self.console_script)
        self.assertNotIn("data-system-proxy-pool-close>完成", self.console_script)

    def test_shared_system_pool_reuses_the_legacy_market_card_pattern(self):
        self.assertIn(
            '<article class="proxy-market-mini-card" data-system-proxy-pool-card=',
            self.console_script,
        )
        for class_name in (
            "proxy-market-mini-card-head",
            "proxy-market-mini-country",
            "proxy-market-mini-stock",
            "proxy-market-mini-location",
            "proxy-market-mini-meta",
        ):
            self.assertIn(class_name, self.console_script)
            self.assertIn(f".{class_name}", self.console_styles)
        self.assertIn(
            ".proxy-market-mini-card {\n  display: grid;\n  gap: 8px;\n  padding: 12px;",
            self.console_styles,
        )
        self.assertIn(
            ".proxy-market-mini-card {\n    gap: 7px;\n    padding: 10px;",
            self.console_styles,
        )
        self.assertNotIn(".system-proxy-pool-card {", self.console_styles)
        self.assertNotIn('class="system-proxy-pool-card', self.console_script)

    def test_backend_system_proxies_are_exposed_only_through_the_shared_pool(self):
        regular_list_route = self.social_api_source[
            self.social_api_source.index('@app.get("/api/persona_dashboard/automation/proxies")'):
            self.social_api_source.index('@app.get("/api/persona_dashboard/automation/system-proxy-pool")')
        ]
        self.assertIn("list_available_system_proxy_options", self.social_api_source)
        self.assertIn("list_system_proxy_pool_options", self.social_api_source)
        self.assertIn("switch_system_proxy_in_transaction", self.social_api_source)
        self.assertIn('SYSTEM_PROXY_OPTION_PREFIX = "system_proxy_item:"', self.system_proxy_pool_source)
        self.assertIn("claim_system_proxy_in_transaction", self.social_api_source)
        self.assertIn("release_system_proxy_in_transaction", self.social_api_source)
        self.assertIn('@app.get("/api/persona_dashboard/automation/system-proxy-pool")', self.social_api_source)
        self.assertIn('@app.post("/api/persona_dashboard/automation/system-proxy-pool/select")', self.social_api_source)
        self.assertNotIn("list_available_system_proxy_options", regular_list_route)
        self.assertNotIn("proxyPoolRows({ includeSystemAvailable: true })", self.console_script)
        self.assertIn("proxy?.system_available !== true", self.console_script)

    def test_legacy_claimed_proxy_runtime_compatibility_is_retained(self):
        self.assertIn("resolve_market_proxy_credentials", self.social_api_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS proxy_market_items", self.db_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS proxy_market_allocations", self.db_source)
        self.assertNotIn("from .proxy_market import release_market_proxy", self.social_api_source)


if __name__ == "__main__":
    unittest.main()
