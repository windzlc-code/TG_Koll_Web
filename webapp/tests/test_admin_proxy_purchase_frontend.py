from pathlib import Path
import unittest


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


class AdminProxyPurchaseFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.styles = (STATIC_ROOT / "assets" / "style.css").read_text(encoding="utf-8")

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
        self.assertIn("clearProxyProviderCredentialInputs();", save)
        self.assertNotIn("testProxyProviderCredentials({ useInputs: false })", save)
        self.assertNotIn('el("proxyPurchasePlanId")', save)

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

    def test_purchase_regions_are_localized_to_chinese_in_admin_views(self):
        country_label = self._function("proxyPurchaseCountryLabel", "inferProxyMarketProviderKey")
        provider_options = self._function("renderProxyPurchaseProviderOptions", "renderProxyPurchaseIsps")
        purchased_assets = self._function("renderProxyPurchasedAssets", "loadProxyPurchasedAssets")
        purchase_orders = self._function("renderProxyPurchaseOrders", "loadProxyPurchaseOrders")

        self.assertIn("normalizeProxyMarketCountry(code)", country_label)
        self.assertIn('return "中国台湾"', country_label)
        self.assertIn("label: proxyPurchaseCountryLabel(country)", provider_options)
        self.assertIn("proxyPurchaseCountryLabel(item.country)", purchased_assets)
        self.assertIn("proxyPurchaseCountryLabel({ name: order.country_name, code: order.country })", purchase_orders)


if __name__ == "__main__":
    unittest.main()
