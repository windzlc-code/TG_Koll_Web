import unittest
from pathlib import Path


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


class BillingFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.admin_script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.admin_styles = (STATIC_ROOT / "assets" / "style.css").read_text(encoding="utf-8")
        cls.console_script = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.console_styles = (STATIC_ROOT / "assets" / "console.css").read_text(encoding="utf-8")
        cls.site_navigation_script = (STATIC_ROOT / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")

    def test_both_admin_adjustment_entries_submit_the_unlimited_contract(self):
        for control_id in ("billingAdjustmentUnlimited", "rechargeUnlimited"):
            self.assertIn(f'id="{control_id}"', self.admin_markup)

        detailed = self.admin_script[
            self.admin_script.index("async function submitBillingAdjustment")
            : self.admin_script.index("function syncBillingAdjustmentType")
        ]
        quick = self.admin_script[
            self.admin_script.index("async function submitRecharge")
            : self.admin_script.index("function bindBillingActions")
        ]
        self.assertIn("const adjustmentPayload = { delta_points: deltaPoints, reason: note }", detailed)
        self.assertIn("if (unlimited) adjustmentPayload.unlimited = true", detailed)
        self.assertIn("else if (wasUnlimited) adjustmentPayload.unlimited = false", detailed)
        self.assertIn("const rechargePayload = { amount_cents: unlimited ? 0 : amount, note }", quick)
        self.assertIn("if (unlimited) rechargePayload.unlimited = true", quick)
        self.assertIn("else if (target.unlimited) rechargePayload.unlimited = false", quick)
        self.assertIn('"unlimited_compute", "unlimited"', self.admin_script)
        self.assertIn("response.unlimited_compute", quick)
        self.assertIn("amount.disabled = unlimited", self.admin_script)

    def test_admin_lists_and_billing_details_render_unlimited_accounts(self):
        self.assertIn('balanceCell.textContent = u.is_admin ? "-" : (unlimited ? "∞"', self.admin_script)
        self.assertIn('createBillingSummaryItem("算力点余额", unlimited ? "∞"', self.admin_script)
        self.assertIn('? "无限"', self.admin_script)
        self.assertIn(".admin-billing-unlimited-option", self.admin_styles)

    def test_admin_wallet_kpi_and_credit_unit_fallback_are_unambiguous(self):
        self.assertIn(">客户算力余额总计<", self.admin_markup)
        detail = self.admin_script[
            self.admin_script.index("function renderUserBilling")
            : self.admin_script.index("async function loadUserBilling")
        ]
        self.assertIn("Number(wallet.credit_units) / 100", detail)
        self.assertIn("Number(summaryData.credit_units) / 100", detail)
        self.assertNotIn("?? wallet.credit_units ?? summaryData.credit_units ?? 0", detail)

    def test_personal_billing_menu_refreshes_and_renders_effective_unlimited(self):
        summary = self.console_script[
            self.console_script.index("function billingSummaryData")
            : self.console_script.index("function renderBillingSummary")
        ]
        personal = self.console_script[
            self.console_script.index("function renderPersonalBillingSummary")
            : self.console_script.index("function renderBillingOrders")
        ]
        events = self.console_script[
            self.console_script.index("function bindEvents")
            : self.console_script.index('window.addEventListener("beforeunload"')
        ]
        for marker in ("effective_unlimited", "admin_waived", "unlimited_compute"):
            self.assertIn(marker, summary)
        self.assertIn('pointsNode.textContent = unlimited ? "不限"', personal)
        self.assertIn('publishRemainingLabel.textContent = traditional ? "今日剩餘發布額度" : "今日剩余发布额度"', personal)
        self.assertIn('loadBilling({ force: true }).catch(() => {})', events)
        self.assertIn('publishRemaining: "今日剩余发布额度"', self.site_navigation_script)
        self.assertIn('publishRemaining: "今日剩餘發布額度"', self.site_navigation_script)

    def test_console_initialization_loads_action_prices_from_the_catalog(self):
        loader = self.console_script[
            self.console_script.index("async function loadBillingCatalog")
            : self.console_script.index("function syncPersonaDashboardStyles")
        ]
        helper = self.console_script[
            self.console_script.index("function billingCatalogAction")
            : self.console_script.index("function billingCurrency")
        ]
        init = self.console_script[self.console_script.index("async function init()") :]
        self.assertIn('api("/api/billing/catalog")', loader)
        self.assertIn("await loadBillingCatalog()", init)
        self.assertIn('billingRows(state.billing.catalog, ["actions"])', helper)
        self.assertIn("Number(action?.points)", helper)
        self.assertIn("unitPoints * normalizedQuantity", helper)

    def test_price_pills_are_inside_charge_buttons_only(self):
        required_pairs = (
            ('data-persona-generate-image', 'renderBillingPricePill("ai_image")'),
            ('data-persona-run-media-task', 'renderBillingPricePill("ai_image", mediaForm.imageCount'),
            ('data-persona-generate-posts', 'renderBillingPricePill("basic_text_post", currentGenerateCount'),
            ('data-persona-publish-submit', 'renderBillingPricePill(publishBillingSku(publishAccount))'),
            ('data-persona-run-threads=', 'renderBillingPricePill("threads_auto_reply_batch")'),
        )
        for button_marker, price_marker in required_pairs:
            with self.subTest(button=button_marker):
                button_start = self.console_script.index(button_marker)
                button_end = self.console_script.index("</button>", button_start)
                self.assertIn(price_marker, self.console_script[button_start:button_end])

        panel_start = self.console_script.rindex(
            "function renderAccountPoolAutomationPanel"
        )
        account_button_start = self.console_script.index(
            "data-account-pool-run-threads=",
            panel_start,
        )
        account_button_end = self.console_script.index("</button>", account_button_start)
        self.assertIn(
            'renderBillingPricePill("threads_auto_reply_batch")',
            self.console_script[account_button_start:account_button_end],
        )

        navigation_start = self.console_script.index('data-persona-generated-media="${esc(post.id)}"')
        navigation_end = self.console_script.index("</button>", navigation_start)
        self.assertNotIn("renderBillingPricePill", self.console_script[navigation_start:navigation_end])

    def test_quantity_actions_show_estimated_totals_and_responsive_pills(self):
        for input_id in ("personaGenerateCount", "personaMediaImageCount"):
            self.assertIn(f'quantityInputId: "{input_id}"', self.console_script)
        self.assertIn("matrixPublishRequestedCount()", self.console_script)
        self.assertIn("publishBillingSku", self.console_script)
        self.assertIn('"instagram_publish"', self.console_script)
        self.assertIn("renderBillingPricePill(publishExecutionSku(publishModeForAction), publishQuantity", self.console_script)
        self.assertIn('estimated ? "预计 " : ""', self.console_script)
        self.assertIn(".billing-price-pill", self.console_styles)
        self.assertIn("button:has(.billing-price-pill)", self.console_styles)
        self.assertIn("@media (max-width: 720px)", self.console_styles)

    def test_ai_keyword_create_and_profile_actions_show_catalog_price(self):
        for button_marker in (
            "data-persona-create-ai-keywords",
            "data-persona-create-ai-submit",
            "data-persona-regenerate-profile-content",
        ):
            with self.subTest(button=button_marker):
                button_start = self.console_script.index(button_marker)
                button_end = self.console_script.index("</button>", button_start)
                self.assertIn(
                    'renderBillingPricePill("basic_text_post")',
                    self.console_script[button_start:button_end],
                )


if __name__ == "__main__":
    unittest.main()
