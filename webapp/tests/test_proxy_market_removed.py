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

    def test_standalone_purchase_and_market_pages_are_removed(self):
        for path in (
            STATIC_ROOT / "proxy-market.html",
            STATIC_ROOT / "assets" / "opc" / "proxy-market.js",
            STATIC_ROOT / "assets" / "opc" / "proxy-market.css",
            STATIC_ROOT / "proxy-purchase.html",
            STATIC_ROOT / "assets" / "proxy-purchase.js",
            STATIC_ROOT / "assets" / "proxy-purchase.css",
            WEBAPP_ROOT / "proxy_market.py",
        ):
            self.assertFalse(path.exists(), path)
        route = self.server_source[
            self.server_source.index('@app.get("/proxy-purchase"'):
            self.server_source.index('@app.get("/profile.html"')
        ]
        self.assertIn('RedirectResponse(url="/console.html", status_code=302)', route)
        self.assertNotIn('"proxy-purchase.html"', route)

    def test_public_market_routes_and_navigation_stay_removed(self):
        combined = "\n".join((self.server_source, self.navigation_script, self.console_markup, self.console_script))
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
        self.assertIn("/api/admin/proxy-market/items", self.admin_script)
        self.assertIn("register_proxy_ip_admin_routes(app)", self.server_source)
        self.assertIn('@app.get("/api/admin/proxy-market/items")', self.proxy_admin_source)

    def test_admin_proxy_inventory_uses_automatic_recognition_only(self):
        self.assertIn('id="proxyMarketSmartInput"', self.admin_markup)
        self.assertIn('id="btnAutoPublishProxyMarketItem"', self.admin_markup)
        self.assertIn("function autoDetectAndPublishProxyMarketItem", self.admin_script)
        self.assertNotIn('id="proxyMarketItemForm"', self.admin_markup)
        self.assertNotIn("function readProxyMarketItemForm", self.admin_script)

    def test_account_proxy_picker_is_the_only_user_purchase_and_selection_surface(self):
        self.assertIn('"/api/persona_dashboard/automation/system-proxy-pool"', self.console_script)
        self.assertIn('"/api/persona_dashboard/automation/system-proxy-pool/select"', self.console_script)
        self.assertIn('data-account-proxy-filter="country"', self.console_script)
        self.assertIn('data-account-proxy-filter="city"', self.console_script)
        self.assertIn('class="account-proxy-picker-location-row"', self.console_script)
        self.assertIn('class="account-proxy-picker-action-row"', self.console_script)
        self.assertIn('data-account-proxy-renewal-order', self.console_script)
        self.assertIn('data-account-proxy-type="supplier"', self.console_script)
        self.assertIn('data-account-proxy-type="managed"', self.console_script)
        self.assertIn('"/api/proxy-purchases/options"', self.console_script)
        self.assertIn('"/api/proxy-purchases/monthly-free"', self.console_script)
        self.assertIn('data-account-proxy-supplier-choice', self.console_script)
        self.assertIn('data-kind="supplier"', self.console_script)
        self.assertIn('stack: true', self.console_script)
        self.assertNotIn('本月免费机会领取后不可重复使用', self.console_script)
        self.assertIn('购买后分配', self.console_script)
        self.assertIn('class="proxy-market-compact-fields"', self.console_script)
        self.assertIn('<div><dt>代理 IP</dt><dd>${esc(ipAddress)}</dd></div>', self.console_script)
        self.assertNotIn("function accountProxyPurchasePlaceholderHtml", self.console_script)
        self.assertNotIn("function openAccountProxyPurchaseView", self.console_script)
        self.assertNotIn("account-proxy-purchase-placeholder", self.console_styles)
        self.assertIn(".account-proxy-picker-location-row", self.console_styles)
        self.assertIn(".proxy-market-mini-renewal", self.console_styles)
        self.assertIn("proxy-purchase-legacy-theme", self.console_script)
        self.assertIn("account-proxy-picker-modal", self.console_script)
        self.assertNotIn("account-proxy-selector-shell", self.console_script)
        self.assertIn("account-proxy-entry-card", self.console_script)
        self.assertNotIn("account-proxy-mapped-product", self.console_script)
        self.assertIn("data-account-proxy-region-guide", self.console_script)
        self.assertIn('if (!String(filters.country || "").trim())', self.console_script)
        self.assertIn('cityControl.disabled = !selectedCountry', self.console_script)
        self.assertIn(".account-proxy-region-guide", self.console_styles)
        self.assertIn("#68d5df 0 12%, #1678b4 32%, #102c47 82%", self.console_styles)

    def test_backend_enforces_monthly_free_selection_and_masks_unclaimed_details(self):
        self.assertIn("def monthly_free_proxy_status", self.system_proxy_pool_source)
        self.assertIn('"monthly_free_proxy"', self.system_proxy_pool_source)
        self.assertNotIn("本月免费代理机会已使用，下月可重新选择", self.system_proxy_pool_source)
        self.assertIn('claim_mode="console_select"', self.system_proxy_pool_source)
        self.assertIn('"details_revealed": details_revealed', self.system_proxy_pool_source)
        self.assertIn('"host": str(item.get("host") or "") if details_revealed else ""', self.system_proxy_pool_source)
        self.assertIn('"monthly_free": monthly_free', self.social_api_source)
        self.assertIn("allow_admin_inventory=True", self.social_api_source)
        self.assertIn("source == \"marketplace\" and purchase_status == \"leased\"", self.social_api_source)

    def test_legacy_claimed_proxy_runtime_compatibility_is_retained(self):
        self.assertIn("resolve_market_proxy_credentials", self.social_api_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS proxy_market_items", self.db_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS proxy_market_allocations", self.db_source)
        self.assertNotIn("from .proxy_market import release_market_proxy", self.social_api_source)


if __name__ == "__main__":
    unittest.main()
