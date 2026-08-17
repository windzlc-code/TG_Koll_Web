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
        self.assertIn("/api/admin/proxy-market/items/${encodeURIComponent(itemId)}/purge", self.admin_script)
        self.assertIn("/api/admin/proxy-market/items/${encodeURIComponent(itemId)}/shares", self.admin_script)
        self.assertIn("彻底删除", self.admin_script)
        self.assertIn("共享给用户", self.admin_script)
        self.assertIn("id=\"proxyMarketShareModal\"", self.admin_markup)
        self.assertIn("admin-public-action-modal", self.admin_markup)
        self.assertIn("M12 2v13", self.admin_script)
        self.assertIn("已购代理", self.admin_markup)
        self.assertIn("record-tab-count", self.admin_markup)
        self.assertIn("register_proxy_ip_admin_routes(app)", self.server_source)
        self.assertIn('@app.get("/api/admin/proxy-market/items")', self.proxy_admin_source)
        self.assertIn("def purge_shared_market_item", self.proxy_admin_source)
        self.assertIn("def set_owned_market_shares", self.proxy_admin_source)
        self.assertIn("silent: adminState.proxyMarketLoaded", self.admin_script)

    def test_admin_proxy_inventory_uses_automatic_recognition_only(self):
        self.assertIn('id="proxyMarketSmartInput"', self.admin_markup)
        self.assertIn('id="btnAutoPublishProxyMarketItem"', self.admin_markup)
        self.assertIn("function autoDetectAndPublishProxyMarketItem", self.admin_script)
        self.assertNotIn('id="proxyMarketItemForm"', self.admin_markup)
        self.assertNotIn("function readProxyMarketItemForm", self.admin_script)

    def test_account_proxy_picker_is_the_only_user_purchase_and_selection_surface(self):
        self.assertIn('"/api/persona_dashboard/automation/system-proxy-pool"', self.console_script)
        self.assertNotIn('"/api/persona_dashboard/automation/system-proxy-pool/select"', self.console_script)
        self.assertIn('data-account-proxy-filter="country"', self.console_script)
        self.assertIn('data-account-proxy-filter="city"', self.console_script)
        self.assertIn('class="account-proxy-picker-location-row"', self.console_script)
        self.assertIn('class="account-proxy-source-row"', self.console_script)
        self.assertIn('class="account-proxy-type-tabs"', self.console_script)
        self.assertNotIn('class="account-proxy-picker-action-row"', self.console_script)
        filters = self.console_script[
            self.console_script.index('function accountProxyPoolFiltersHtml'):
            self.console_script.index('function accountProxyPickerFilters')
        ]
        self.assertLess(filters.index('data-account-proxy-type="supplier"'), filters.index('data-account-proxy-type="selected"'))
        self.assertLess(filters.index('data-account-proxy-type="selected"'), filters.index('data-account-proxy-choice=""'))
        self.assertIn('data-account-proxy-renewal-order', self.console_script)
        self.assertIn('data-account-proxy-type="supplier"', self.console_script)
        self.assertIn('data-account-proxy-type="selected"', self.console_script)
        self.assertIn("record-tab-count", self.console_script)
        self.assertIn("ACCOUNT_PROXY_POOL_TTL_MS", self.console_script)
        self.assertIn("readAccountProxyPoolCache", self.console_script)
        self.assertIn('>平台 <span class="record-tab-count"', self.console_script)
        self.assertIn('>已选择 <span class="record-tab-count"', self.console_script)
        self.assertIn("function accountProxyCityZh", self.console_script)
        self.assertIn("解除使用", self.console_script)
        self.assertIn("is-selected", self.console_script)
        self.assertIn("account-proxy-unbind", self.console_script)
        self.assertIn("justify-content: space-between", self.console_styles)
        self.assertNotIn('data-account-proxy-type="managed"', self.console_script)
        self.assertNotIn('>管理员代理</button>', self.console_script)
        self.assertIn('"/api/proxy-purchases/options"', self.console_script)
        self.assertIn('"/api/proxy-purchases/monthly-free"', self.console_script)
        self.assertIn('data-account-proxy-supplier-choice', self.console_script)
        self.assertIn('data-kind="supplier"', self.console_script)
        self.assertIn('proxyType === "selected" && owned', self.console_script)
        self.assertIn('? [supplierCard()].filter(Boolean)', self.console_script)
        self.assertIn('marketOptions.map((option) => marketOption(option, "selected"))', self.console_script)
        self.assertIn('data-account-proxy-owned-choice="${esc(proxyId)}"', self.console_script)
        self.assertIn('>用户选择</span>', self.console_script)
        self.assertIn('stack: true', self.console_script)
        self.assertNotIn('本月免费机会领取后不可重复使用', self.console_script)
        self.assertIn('选择后分配', self.console_script)
        self.assertNotIn('购买后分配', self.console_script)
        self.assertNotIn('实时购买', self.console_script)
        self.assertNotIn('购买并使用', self.console_script)
        self.assertIn('选择使用', self.console_script)
        self.assertNotIn('确认购买平台代理', self.console_script)
        self.assertNotIn('暂不购买', self.console_script)
        self.assertNotIn('平台代理已购买', self.console_script)
        self.assertIn('确认选择平台代理', self.console_script)
        self.assertIn('再看看', self.console_script)
        self.assertIn('本次免费。', self.console_script)
        self.assertIn('选择成功后，该代理会加入“用户选择”', self.console_script)
        self.assertNotIn('平台承担费用', self.console_script)
        self.assertNotIn('不会扣除用户点数', self.console_script)
        self.assertNotIn('class="account-proxy-picker-hero"', self.console_script)
        self.assertNotIn('data-account-proxy-provider-state', self.console_script)
        self.assertIn('data-account-proxy-filter-menu="${esc(name)}"', self.console_script)
        self.assertIn('data-account-proxy-filter-options="${esc(name)}"', self.console_script)
        self.assertIn('name: "country"', self.console_script)
        self.assertIn('name: "city"', self.console_script)
        self.assertIn('name: "sort"', self.console_script)
        self.assertIn('[data-account-proxy-filter-menu="city"]', self.console_script)
        self.assertIn('function accountProxySelectMenuHtml', self.console_script)
        self.assertIn('popover="auto"', self.console_script)
        self.assertIn('function bindAccountProxyCountryMenu', self.console_script)
        self.assertIn('function bindAccountProxyFloatingMenu', self.console_script)
        self.assertIn('options.showPopover()', self.console_script)
        self.assertIn('options.hidePopover()', self.console_script)
        self.assertIn('data-account-proxy-filter-option="${esc(name)}"', self.console_script)
        self.assertIn('filterOption.dataset.accountProxyFilterOption', self.console_script)
        self.assertIn('data-account-proxy-sort-option="time_desc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="name_asc"', self.console_script)
        self.assertIn('data-account-proxy-sort-option="health_first"', self.console_script)
        self.assertNotIn('data-account-proxy-sort-option="time_asc"', self.console_script)
        self.assertNotIn('data-account-proxy-sort-option="name_desc"', self.console_script)
        self.assertNotIn('data-account-proxy-sort-option="country_asc"', self.console_script)
        self.assertIn('class="proxy-market-compact-fields"', self.console_script)
        self.assertIn('class="proxy-market-mini-card-banner"', self.console_script)
        self.assertIn('class="proxy-market-mini-title"', self.console_script)
        self.assertIn('const boundCount = Math.max(0, Number(proxy.bound_account_count) || 0);', self.console_script)
        self.assertIn('${boundCount}/3', self.console_script)
        self.assertIn('class="proxy-market-mini-card-badges"', self.console_script)
        self.assertIn('<div><dt>代理 IP</dt><dd>${esc(ipAddress)}</dd></div>', self.console_script)
        self.assertNotIn("function accountProxyPurchasePlaceholderHtml", self.console_script)
        self.assertNotIn("function openAccountProxyPurchaseView", self.console_script)
        self.assertNotIn("account-proxy-purchase-placeholder", self.console_styles)
        self.assertIn(".account-proxy-picker-location-row", self.console_styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.console_styles)
        self.assertIn('.account-proxy-source-row > .account-proxy-clear[aria-pressed="true"]', self.console_styles)
        self.assertIn(".proxy-market-mini-renewal", self.console_styles)
        self.assertIn('.proxy-market-mini-card > button.proxy-market-mini-renewal[aria-pressed="true"],', self.console_styles)
        self.assertIn("height: 32px !important;", self.console_styles)
        self.assertIn("min-height: 32px !important;", self.console_styles)
        self.assertIn(".proxy-market-mini-card-banner", self.console_styles)
        self.assertIn("--proxy-purchase-gradient: linear-gradient(110deg, #126eaa 0%, #0b4e83 48%, #102c47 100%);", self.console_styles)
        self.assertIn("background: var(--proxy-purchase-gradient);", self.console_styles)
        self.assertNotIn(".account-proxy-picker-hero", self.console_styles)
        self.assertIn(".account-proxy-select-menu-options", self.console_styles)
        self.assertIn("max-height: min(240px, 42dvh);", self.console_styles)
        self.assertIn('.account-proxy-select-menu-options button[aria-selected="true"]', self.console_styles)
        self.assertIn('.account-proxy-select-menu-options:popover-open', self.console_styles)
        self.assertNotIn('.account-proxy-select-menu[open] .account-proxy-select-menu-options', self.console_styles)
        self.assertNotIn('.account-proxy-select-menu[open] {\n  height: auto;', self.console_styles)
        self.assertIn('.proxy-market-mini-usage', self.console_styles)
        self.assertIn('justify-content: space-between;', self.console_styles)
        self.assertIn("@media (hover: hover) and (pointer: fine)", self.console_styles)
        self.assertNotIn(".proxy-market-mini-card::before", self.console_styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.console_styles)
        self.assertNotIn(".proxy-market-compact-fields > div:last-child", self.console_styles)
        self.assertIn("proxy-purchase-legacy-theme", self.console_script)
        self.assertIn("account-proxy-picker-modal", self.console_script)
        self.assertNotIn("account-proxy-selector-shell", self.console_script)
        self.assertIn("account-proxy-entry-card", self.console_script)
        self.assertNotIn("account-proxy-mapped-product", self.console_script)
        self.assertIn("data-account-proxy-region-guide", self.console_script)
        self.assertIn('if (proxyType === "supplier" && !String(filters.country || "").trim())', self.console_script)
        self.assertIn('cityMenu.toggleAttribute("data-disabled", !selectedCountry)', self.console_script)
        self.assertIn(".account-proxy-region-guide", self.console_styles)
        self.assertNotIn("linear-gradient(100deg, #168fbd 0%, #147db2 30%, #115b91 62%, #102c47 100%)", self.console_styles)

    def test_proxy_selection_success_uses_public_modal_and_existing_check_animation(self):
        self.assertIn("function openAccountProxySelectionSuccess", self.console_script)
        success = self.console_script[
            self.console_script.index("function openAccountProxySelectionSuccess"):
            self.console_script.index("function accountProxyPoolFiltersHtml")
        ]
        self.assertIn('title: "代理选择成功"', success)
        self.assertIn('modalKey: "account-proxy-selection-success"', success)
        self.assertIn('renderLoginAssistanceVisual({ phase: "success" })', success)
        self.assertIn('showCancel: false', success)
        self.assertIn('dismissOnBackdrop: false', success)
        self.assertIn("account-proxy-selection-success", self.console_styles)
        self.assertIn("login-assistance-success", self.console_styles)

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
