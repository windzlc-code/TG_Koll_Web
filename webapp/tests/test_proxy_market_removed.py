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
        combined = "\n".join((
            self.server_source,
            self.navigation_script,
            self.console_markup,
            self.console_script,
        ))
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
        self.assertNotIn('@app.get("/api/proxy-market/catalog")', self.proxy_admin_source)

    def test_console_selects_directly_from_the_shared_pool_without_add_entrypoints(self):
        self.assertIn('"/api/persona_dashboard/automation/system-proxy-pool"', self.console_script)
        self.assertIn('"/api/persona_dashboard/automation/system-proxy-pool/select"', self.console_script)
        self.assertIn("function accountProxyPoolFiltersHtml()", self.console_script)
        self.assertIn('data-account-proxy-filter="country"', self.console_script)
        self.assertIn("account-proxy-filter-menu", self.console_script)
        self.assertIn("data-account-proxy-purchase-placeholder", self.console_script)
        self.assertIn('data-account-proxy-sort-option="time_desc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="time_asc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="name_asc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="name_desc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="country_asc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="health_first"', self.console_script)
        self.assertNotIn('data-account-proxy-filter="isp"', self.console_script)
        self.assertNotIn('data-account-proxy-filter="ip_type"', self.console_script)
        self.assertNotIn('data-account-proxy-filter="availability"', self.console_script)
        self.assertIn("data-account-proxy-market-choice", self.console_script)
        self.assertIn("data-account-proxy-picker-open", self.console_script)
        self.assertIn("function claimAccountProxyPoolOption", self.console_script)
        self.assertIn("function systemProxyPoolLocation", self.console_script)
        self.assertIn("function openProxyModal(proxyId = \"\")", self.console_script)
        self.assertIn(".account-proxy-picker-filters {", self.console_styles)
        self.assertIn(".account-proxy-purchase-placeholder {", self.console_styles)
        self.assertIn(".proxy-market-mini-card {", self.console_styles)
        for fragment in (
            "data-system-proxy-pool-open",
            "data-proxy-add",
            "data-account-proxy-custom-add",
            "data-account-system-proxy-pool-open",
            "function openSystemProxyPoolModal",
            "function saveAccountInlineCustomProxy",
            "system-proxy-pool-link",
            "account-system-proxy-pool-add",
        ):
            self.assertNotIn(fragment, self.console_script)
            self.assertNotIn(fragment, self.console_styles)
        self.assertNotIn("openProxyMarketModal", self.console_script)
        self.assertNotIn("proxyMarketUnreadBadge", self.console_markup)

    def test_account_proxy_picker_keeps_only_compact_region_filter_and_sort_menu(self):
        filters = self.console_script[
            self.console_script.index("function accountProxyPoolFiltersHtml()"):
            self.console_script.index("function accountProxyPurchasePlaceholderHtml()")
        ]
        options = self.console_script[
            self.console_script.index("function accountProxyOptionCardsHtml"):
            self.console_script.index("function updateAccountProxyChoice")
        ]

        self.assertIn('data-account-proxy-filter="country"', filters)
        self.assertIn('aria-label="地区"', filters)
        self.assertIn('data-account-proxy-sort-option="time_desc"', filters)
        self.assertIn('data-account-proxy-sort-option="time_asc"', filters)
        self.assertIn('data-account-proxy-sort-option="name_asc"', filters)
        self.assertIn('data-account-proxy-sort-option="name_desc"', filters)
        self.assertIn('data-account-proxy-sort-option="country_asc"', filters)
        self.assertIn('data-account-proxy-sort-option="health_first"', filters)
        self.assertNotIn('data-account-proxy-filter="query"', filters)
        self.assertNotIn('data-account-proxy-filter="isp"', filters)
        self.assertNotIn('data-account-proxy-filter="ip_type"', filters)
        self.assertIn("accountProxyPoolSortOptions", options)
        self.assertIn("renderNoProxyIcon()", self.console_script)
        self.assertIn("renderNetworkIcon()}<span>${esc(action)}</span>", options)
        self.assertIn("renderShoppingBagIcon()", self.console_script)
        self.assertIn('<span class="account-proxy-purchase-icon">${renderShoppingBagIcon()}</span>', self.console_script)
        self.assertIn('${renderShoppingBagIcon()}<span>点击购买</span>', self.console_script)
        self.assertIn("点击购买", self.console_script)
        self.assertNotIn("accountProxyOptionBorderFlow", self.console_styles)
        self.assertIn(".account-proxy-purchase-placeholder {", self.console_styles)
        self.assertIn("--account-proxy-flow-highlight: #337bb1;", self.console_styles)
        self.assertIn("--account-proxy-flow-cyan: #1963a2;", self.console_styles)
        self.assertIn("var(--account-proxy-flow-highlight) 0%,", self.console_styles)
        self.assertIn("var(--account-proxy-flow-cyan) 4%,", self.console_styles)
        self.assertIn("var(--media-edit-flow-blue) 20%,", self.console_styles)
        self.assertIn("var(--media-edit-flow-deep) 68%,", self.console_styles)
        self.assertIn("--media-edit-flow-navy: #243b53;", self.console_styles)
        self.assertIn("var(--media-edit-flow-navy) 100%", self.console_styles)
        self.assertIn("min-height: 56px;\n  gap: 9px;\n  margin: 2px 0 12px;\n  padding: 6px 10px;\n  box-sizing: border-box;", self.console_styles)
        self.assertIn("animation: none;\n  will-change: auto;", self.console_styles)
        self.assertNotIn("@keyframes accountProxyPurchaseFlow", self.console_styles)
        self.assertIn(".account-proxy-picker-controls {\n  width: 100%;\n  align-items: center;", self.console_styles)
        self.assertIn(".account-proxy-picker-filters {\n  display: grid;\n  grid-template-columns: minmax(0, 142px) 36px;", self.console_styles)
        self.assertIn(".account-proxy-picker-filters label {\n  display: grid;\n  min-width: 0;\n  margin: 0;", self.console_styles)
        self.assertNotIn(".account-proxy-filter-menu-options label", self.console_styles)
        self.assertIn(".account-proxy-filter-menu-options {\n  position: absolute;\n  z-index: 24;\n  top: calc(100% + 7px);\n  left: 0;", self.console_styles)
        self.assertNotIn(".account-proxy-picker-filter-toolbar:has(.account-proxy-filter-menu[open])", self.console_styles)
        self.assertIn("width: min(136px, calc(100vw - 72px));\n  max-height: 132px;", self.console_styles)
        self.assertIn("overflow-y: auto;\n  overscroll-behavior: contain;\n  scrollbar-gutter: stable;", self.console_styles)
        self.assertIn(".account-proxy-clear {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  flex: 0 0 auto;\n  height: 36px;\n  min-height: 36px;", self.console_styles)
        self.assertIn("${accountProxyPoolFiltersHtml()}<button type=\"button\" class=\"account-proxy-clear\"", self.console_script)
        self.assertIn("appearance: none;\n  box-shadow: none;\n  transform: none;", self.console_styles)
        self.assertIn("border: 1px solid var(--line);", self.console_styles)
        self.assertIn("var(--media-edit-flow-cyan) 64%", self.console_styles)
        self.assertIn("color: #fff;\n  border: 1px solid color-mix(in srgb, #fff 62%, transparent);", self.console_styles)
        self.assertIn("border: 1px solid var(--media-edit-flow-blue);", self.console_styles)
        self.assertIn("background: var(--media-edit-flow-blue);", self.console_styles)
        picker = self.console_script[
            self.console_script.index("function openAccountProxyPickerModal"):
            self.console_script.index("function renderAccountProxyPickerPanel")
        ]
        self.assertNotIn('<div class="console-modal-actions">', picker)
        self.assertNotIn("data-account-proxy-picker-save", picker)
        self.assertIn("commitAccountProxyPickerSelection", picker)
        self.assertLess(
            picker.index("${accountProxyPurchasePlaceholderHtml()}"),
            picker.index("${accountProxyPoolFiltersHtml()}"),
        )
        panel = self.console_script[
            self.console_script.index("function renderAccountProxyPickerPanel"):
            self.console_script.index("function renderAccountTotpSection")
        ]
        self.assertLess(
            panel.index("${accountProxyPurchasePlaceholderHtml()}"),
            panel.index("${accountProxyPoolFiltersHtml()}"),
        )

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
