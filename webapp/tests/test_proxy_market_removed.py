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
        cls.navigation_script = (STATIC_ROOT / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.admin_markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.admin_script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.social_api_source = (WEBAPP_ROOT / "social_automation_api.py").read_text(encoding="utf-8")
        cls.system_proxy_pool_source = (WEBAPP_ROOT / "system_proxy_pool.py").read_text(encoding="utf-8")
        cls.db_source = (WEBAPP_ROOT / "db.py").read_text(encoding="utf-8")

    def test_standalone_market_assets_and_backend_module_are_removed(self):
        self.assertFalse((STATIC_ROOT / "proxy-market.html").exists())
        self.assertFalse((STATIC_ROOT / "assets" / "opc" / "proxy-market.js").exists())
        self.assertFalse((STATIC_ROOT / "assets" / "opc" / "proxy-market.css").exists())
        self.assertFalse((WEBAPP_ROOT / "proxy_market.py").exists())

    def test_market_routes_navigation_and_admin_workspace_are_removed(self):
        combined = "\n".join(
            (
                self.server_source,
                self.navigation_script,
                self.admin_markup,
                self.admin_script,
            )
        )
        for fragment in (
            '@app.get("/proxy-market.html"',
            "register_proxy_market_routes",
            'href="/proxy-market.html"',
            'data-site-nav-key="proxyMarket"',
            'data-page="proxyMarket"',
            'data-page-view="proxyMarket"',
            "/api/admin/proxy-market/",
            "/api/proxy-market/",
        ):
            self.assertNotIn(fragment, combined)

    def test_console_restores_shared_add_proxy_flow(self):
        self.assertIn("data-proxy-add", self.console_script)
        self.assertIn("<span>添加代理</span>", self.console_script)
        self.assertIn("function openProxyModal(proxyId = \"\")", self.console_script)
        self.assertIn(
            '"/api/persona_dashboard/automation/proxies"',
            self.console_script,
        )
        self.assertNotIn("openProxyMarketModal", self.console_script)
        self.assertNotIn("proxyMarketUnreadBadge", self.console_markup)

    def test_backend_system_proxies_are_only_exposed_in_account_picker(self):
        self.assertIn("list_available_system_proxy_options", self.social_api_source)
        self.assertIn('SYSTEM_PROXY_OPTION_PREFIX = "system_proxy_item:"', self.system_proxy_pool_source)
        self.assertIn("claim_system_proxy_in_transaction", self.social_api_source)
        self.assertIn("release_system_proxy_in_transaction", self.social_api_source)
        self.assertIn("proxyPoolRows({ includeSystemAvailable: true })", self.console_script)
        self.assertIn("proxy?.system_available !== true", self.console_script)

    def test_legacy_claimed_proxy_runtime_compatibility_is_retained(self):
        self.assertIn("resolve_market_proxy_credentials", self.social_api_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS proxy_market_items", self.db_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS proxy_market_allocations", self.db_source)
        self.assertNotIn("from .proxy_market import release_market_proxy", self.social_api_source)


if __name__ == "__main__":
    unittest.main()
