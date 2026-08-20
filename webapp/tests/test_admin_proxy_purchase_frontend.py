from pathlib import Path
import unittest


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


class AdminProxyPurchaseFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.styles = (STATIC_ROOT / "assets" / "style.css").read_text(encoding="utf-8")
        cls.fixed_light_styles = (STATIC_ROOT / "assets" / "fixed-light.css").read_text(encoding="utf-8")

    def _function(self, name: str, next_name: str) -> str:
        start = self.script.index(f"function {name}")
        end = self.script.index(f"function {next_name}", start)
        return self.script[start:end]

    def test_provider_credentials_are_compact_and_server_identified(self):
        runtime_start = self.markup.index('id="secRuntime"')
        runtime_end = self.markup.index('id="secAccount"', runtime_start)
        runtime_panel = self.markup[runtime_start:runtime_end]
        proxy_start = self.markup.index('id="secProxyMarket"')
        proxy_end = self.markup.index('id="secPricing"', proxy_start)
        proxy_panel = self.markup[proxy_start:proxy_end]
        panel_start = self.markup.index('id="proxyProviderApiDetails"')
        panel = runtime_panel[panel_start - runtime_start:]
        self.assertIn('id="proxyProviderApiDetails"', runtime_panel)
        self.assertNotIn('id="proxyProviderApiDetails"', proxy_panel)
        self.assertIn('data-model-tab="proxy-provider"', runtime_panel)
        self.assertIn('data-model-panel="proxy-provider"', runtime_panel)
        self.assertNotIn('<details class="admin-config-card admin-runtime-panel proxy-provider-api-panel"', runtime_panel)
        self.assertIn('id="proxyProviderCredentialSummary"', panel)
        self.assertNotIn('id="proxyProviderFieldDetails"', panel)
        for input_id in ("proxyProviderApiKey", "proxyProviderApiSecret", "proxyProviderWebhookSecret"):
            self.assertIn(f'id="{input_id}" type="password"', panel)
            self.assertIn(f'"{input_id}"', self.script)
        self.assertIn("const SENSITIVE_PROVIDER_INPUT_IDS", self.script)
        self.assertIn("[...SENSITIVE_RUNTIME_INPUT_IDS, ...SENSITIVE_PROVIDER_INPUT_IDS]", self.script)
        self.assertNotIn("proxyProviderCredentialPassword", panel)
        self.assertNotIn("proxyProviderCredentialTotp", panel)
        self.assertNotIn("proxyProviderAccountCurrency", panel)
        self.assertNotIn("proxyProviderCredentialState", panel)
        self.assertNotIn("proxyProviderCredentialReason", panel)
        self.assertNotIn("变更原因", panel)
        self.assertNotIn("保存需要管理员密码与 MFA", panel)

    def test_runtime_provider_is_a_parallel_tab_and_all_panels_share_purchase_visual_language(self):
        runtime_start = self.markup.index('id="secRuntime"')
        runtime_end = self.markup.index('id="secAccount"', runtime_start)
        runtime_panel = self.markup[runtime_start:runtime_end]
        self.assertIn('class="admin-config-card admin-runtime-panel admin-runtime-provider-shell"', runtime_panel)
        self.assertEqual(runtime_panel.count('data-model-tab='), 5)
        for panel_name in ("text", "image", "runninghub", "video", "proxy-provider"):
            self.assertIn(f'data-model-panel="{panel_name}"', runtime_panel)
        self.assertIn(".page-admin .admin-runtime-provider-shell", self.styles)
        self.assertIn("linear-gradient(105deg, #237fb2 0 8%, #155f96 24%, #123f69 56%, #102c47 100%)", self.styles)
        self.assertIn(".admin-runtime-provider-shell .admin-model-tab-panel", self.styles)
        self.assertIn(".admin-runtime-provider-shell.admin-config-card", self.fixed_light_styles)
        self.assertIn("linear-gradient(105deg, #237fb2 0 8%, #155f96 24%, #123f69 56%, #102c47 100%)", self.fixed_light_styles)
        self.assertIn(".admin-model-tab-panel.admin-runtime-block", self.fixed_light_styles)

    def test_provider_field_sync_stays_with_purchase_workspace(self):
        proxy_start = self.markup.index('id="secProxyMarket"')
        proxy_end = self.markup.index('id="secPricing"', proxy_start)
        proxy_panel = self.markup[proxy_start:proxy_end]
        self.assertIn('id="proxyProviderFieldDetails"', proxy_panel)
        self.assertIn('id="proxyPurchaseConfigForm"', proxy_panel)

    def test_runtime_page_loads_provider_credential_status(self):
        active_page = self._function("setActiveAdminPage", "clearStoredAdminWorkspaceContext")
        self.assertIn('nextPage === "runtime"', active_page)
        self.assertIn("loadProxyProviderCredentialStatus()", active_page)

    def test_credential_requests_do_not_send_server_owned_or_step_up_fields(self):
        test_connection = self._function("testProxyProviderCredentials", "saveProxyProviderCredentials")
        save = self._function("saveProxyProviderCredentials", "proxyPurchaseConfigPayload")
        for source in (test_connection, save):
            self.assertNotIn('provider:', source)
            self.assertNotIn('account_currency:', source)
            self.assertNotIn('admin_password:', source)
            self.assertNotIn('totp_code:', source)
        self.assertNotIn('service_id:', test_connection)
        self.assertNotIn('plan_id:', test_connection)
        self.assertIn("resetProxyProviderCredentialInputs();", save)
        self.assertNotIn("testProxyProviderCredentials({ useInputs: false })", save)
        self.assertNotIn('el("proxyPurchasePlanId")', save)
        self.assertNotIn("proxyProviderCredentialReason", save)
        self.assertNotIn("reason,", save)

    def test_saved_provider_credentials_remain_visible_as_non_secret_masks(self):
        status = self._function("renderProxyProviderCredentialStatus", "loadProxyProviderCredentialStatus")
        save = self._function("saveProxyProviderCredentials", "proxyPurchaseConfigPayload")
        self.assertIn("PROVIDER_SECRET_MASK", self.script)
        self.assertIn("setProviderSecretInputState", status)
        self.assertIn("providerSecretInputValue", save)
        self.assertNotIn('.value = ""', status)

    def test_purchase_config_hides_provider_owned_defaults_and_publish_step_up(self):
        proxy_start = self.markup.index('id="proxyPurchaseAdminWorkspace"')
        proxy_end = self.markup.index('id="proxyPurchaseOrderSummary"', proxy_start)
        workspace = self.markup[proxy_start:proxy_end]
        for control_id in (
            "proxyPurchaseDefaultIsp",
            "proxyPurchaseDefaultPackage",
            "proxyPurchaseDefaultProtocol",
            "proxyPurchaseDefaultAuthentication",
            "proxyPurchaseAdminPassword",
            "proxyPurchaseTotpCode",
        ):
            self.assertNotIn(f'id="{control_id}"', workspace)
        self.assertIn('<option value="1">1 个月</option>', workspace)
        publish = self._function("publishProxyPurchaseConfig", "renderProxyPurchaseOrders")
        self.assertNotIn("adminPassword", publish)
        self.assertNotIn("totpCode", publish)
        self.assertIn("JSON.stringify({})", publish)

    def test_purchase_config_groups_duration_range_and_uses_ntd_profit_only(self):
        proxy_start = self.markup.index('id="proxyPurchaseAdminWorkspace"')
        proxy_end = self.markup.index('id="proxyPurchaseOrderSummary"', proxy_start)
        workspace = self.markup[proxy_start:proxy_end]
        for control_id in (
            "proxyPurchaseDefaultPeriod",
            "proxyPurchaseMinPeriod",
            "proxyPurchaseMaxPeriod",
            "proxyPurchaseFxMode",
            "proxyPurchaseManualFxRate",
            "proxyPurchaseProfitNtd",
            "proxyPurchaseFxRate",
            "btnRefreshProxyPurchaseFx",
        ):
            self.assertIn(f'id="{control_id}"', workspace)
        self.assertIn("购买时长区间", workspace)
        self.assertIn('class="proxy-purchase-period-range-controls"', workspace)
        self.assertIn("用户端不显示时长选项", workspace)
        for removed_id in (
            "proxyPurchaseServiceId",
            "proxyPurchaseDefaultCountry",
            "proxyPurchasePointsPerUsd",
            "proxyPurchaseUsdToNtdRate",
            "proxyPurchasePaymentFeeRate",
            "proxyPurchaseFixedFeePoints",
            "proxyPurchaseSafetyBufferUsd",
            "proxyPurchaseMinProfitUsd",
        ):
            self.assertNotIn(f'id="{removed_id}"', workspace)
        payload = self._function("proxyPurchaseConfigPayload", "saveProxyPurchaseConfig")
        self.assertIn('pricing_mode: "supplier_plus_profit_ntd"', payload)
        self.assertIn("profit_ntd:", payload)
        self.assertIn("min_period_months:", payload)
        self.assertIn("max_period_months:", payload)
        self.assertIn("min_period_months: minimumPeriod", payload)
        self.assertIn("max_period_months: maximumPeriod", payload)
        self.assertIn('service_id: "static-residential-ipv4"', payload)
        self.assertIn('default_country: ""', payload)
        self.assertIn("/api/admin/proxy-purchases/exchange-rate", self.script)
        self.assertIn("const PROXY_PURCHASE_FX_REFRESH_INTERVAL_MS = 15 * 60 * 1000", self.script)
        self.assertIn('adminState.activePage !== "proxyMarket"', self.script)
        self.assertIn("loadProxyPurchaseExchangeRate({ refresh: true })", self.script)
        self.assertIn("每 15 分钟自动刷新", self.script)

    def test_purchase_sync_status_has_explicit_contrast_colors(self):
        self.assertIn("#proxyProviderFieldRevision", self.markup)
        self.assertIn("#proxyPurchaseConfigMsg.msg.ok", self.markup)

    def test_healthy_status_does_not_keep_header_chips_visible(self):
        self.assertNotIn('id="proxyPurchaseCredentialStatus"', self.markup)
        self.assertNotIn('id="proxyPurchaseBalance"', self.markup)
        self.assertNotIn('id="proxyPurchaseLastSync"', self.markup)
        status = self._function("renderProxyProviderCredentialStatus", "loadProxyProviderCredentialStatus")
        self.assertIn("readiness.hidden = reasons.length === 0", status)

    def test_admin_has_separate_user_purchased_proxy_asset_list(self):
        self.assertIn('id="proxyMarketPurchasedTab"', self.markup)
        self.assertIn('id="proxyMarketPurchasedPanel"', self.markup)
        self.assertIn('id="proxyMarketPurchasedBody"', self.markup)
        self.assertIn('"/api/admin/proxy-purchases/assets"', self.script)
        self.assertIn("function renderProxyPurchasedAssets", self.script)
        self.assertIn("function loadProxyPurchasedAssets", self.script)

    def test_proxy_auto_import_editor_keeps_balanced_layout_container(self):
        editor_start = self.markup.index('<div class="proxy-market-admin-band" id="proxyMarketEditor">')
        settings_heading = self.markup.index("<h3>库存、领取与健康策略</h3>", editor_start)
        settings_start = self.markup.rfind(
            '<div class="proxy-market-admin-band">',
            editor_start,
            settings_heading,
        )
        editor = self.markup[editor_start:settings_start]

        self.assertEqual(editor.count("<div"), editor.count("</div>"))
        self.assertIn('id="proxyMarketItemMsg"', editor)

    def test_purchase_regions_are_localized_to_chinese_in_admin_views(self):
        country_label = self._function("proxyPurchaseCountryLabel", "inferProxyMarketProviderKey")
        purchased_assets = self._function("renderProxyPurchasedAssets", "loadProxyPurchasedAssets")
        purchase_orders = self._function("renderProxyPurchaseOrders", "loadProxyPurchaseOrders")

        self.assertIn("normalizeProxyMarketCountry(code)", country_label)
        self.assertIn('return "中国台湾"', country_label)
        self.assertIn("proxyPurchaseCountryLabel(item.country)", purchased_assets)
        self.assertIn("proxyPurchaseCountryLabel({ name: order.country_name, code: order.country })", purchase_orders)
        self.assertIn("选择城市：${order.selected_city_name || order.selected_city}", purchase_orders)


if __name__ == "__main__":
    unittest.main()
