from pathlib import Path
import unittest


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


class AdminProxyPurchaseFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")

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
        panel_end = self.markup.index('</details>', panel_start) + len('</details>')
        panel = self.markup[panel_start:panel_end]
        self.assertIn("<details", self.markup[self.markup.rfind("<", 0, panel_start):panel_start + 80])
        self.assertIn('id="proxyProviderApiDetails"', runtime_panel)
        self.assertNotIn('id="proxyProviderApiDetails"', proxy_panel)
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


if __name__ == "__main__":
    unittest.main()
