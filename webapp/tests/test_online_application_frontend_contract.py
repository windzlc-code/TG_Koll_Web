import unittest
from pathlib import Path


class OnlineApplicationFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        cls.pricing_script = (static_dir / "assets" / "opc" / "pricing.js").read_text(encoding="utf-8")
        cls.console_script = (static_dir / "assets" / "console.js").read_text(encoding="utf-8")

    def test_pending_application_is_not_described_as_payment_review(self):
        self.assertIn('pending: "待审批"', self.console_script)
        self.assertNotIn('pending: "待付款审核"', self.console_script)

    def test_submit_retry_does_not_generate_a_new_key_inside_submit_handler(self):
        marker = 'addEventListener("submit"'
        submit_handler = self.pricing_script[self.pricing_script.index(marker):]
        self.assertNotIn("const idempotencyKey =", submit_handler)
        self.assertNotIn("randomUUID", submit_handler)

    def test_partial_account_failures_are_not_coerced_to_known_empty_values(self):
        self.assertNotIn(
            'state.summary = summaryResult.status === "fulfilled" ? summaryResult.value : null;',
            self.pricing_script,
        )

    def test_pricing_requests_preserve_explicit_admin_console_identity(self):
        self.assertIn(
            'const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context"',
            self.pricing_script,
        )
        self.assertIn("function adminConsoleContextActive()", self.pricing_script)
        self.assertIn('headers.set("X-Admin-Console", "1")', self.pricing_script)
        self.assertIn('headers.set("X-Admin-Workspace-User-ID", billingSessionContext.workspaceUserId)', self.pricing_script)
        self.assertIn('const explicitAdminContext = pricingParams.get("admin_console") === "1"', self.pricing_script)
        self.assertIn("function billingAccountUrl()", self.pricing_script)
        self.assertIn('return `/admin-console.html?${params.toString()}`', self.pricing_script)
        self.assertIn("redirectToSelectedLogin(publicPricingUrl(sku))", self.pricing_script)
        self.assertNotIn(
            'state.orders = ordersResult.status === "fulfilled" ? list(ordersResult.value?.items) : [];',
            self.pricing_script,
        )

    def test_usage_price_rows_do_not_render_redundant_billing_status(self):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        pricing_styles = (static_dir / "assets" / "opc" / "pricing.css").read_text(encoding="utf-8")

        self.assertNotIn("pricing-action-state", self.pricing_script)
        self.assertIn("grid-template-columns: minmax(0, 1fr) 104px;", pricing_styles)
        self.assertIn("min-height: 36px;", pricing_styles)

    def test_mobile_pricing_hides_section_rail_and_compacts_package_cards(self):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        pricing_styles = (static_dir / "assets" / "opc" / "pricing.css").read_text(encoding="utf-8")

        self.assertIn(".pricing-section-nav {\n    display: none;\n  }", pricing_styles)
        self.assertIn(".pricing-package-card { min-height: 0; gap: 3px; padding: 8px; }", pricing_styles)
        self.assertIn(".pricing-public-section { padding-top: 18px; padding-bottom: 18px; }", pricing_styles)


if __name__ == "__main__":
    unittest.main()
