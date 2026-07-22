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

    def test_charge_buttons_do_not_render_catalog_prices(self):
        self.assertNotIn("renderBillingPricePill", self.console_script)
        self.assertNotIn("billing-price-pill", self.console_script)
        self.assertNotIn(".billing-price-pill", self.console_styles)

    def test_charge_button_markup_has_no_price_text(self):
        for button_marker in (
            "data-persona-regenerate-profile-content",
            "data-persona-generate-image",
            "data-persona-run-media-task",
            "data-persona-generate-posts",
            "data-persona-publish-submit",
            "data-persona-run-threads=",
            "data-account-pool-run-threads=",
            "data-persona-create-ai-keywords",
            "data-persona-create-ai-submit",
            'id="executeSimpleFlow"',
        ):
            with self.subTest(button=button_marker):
                button_start = self.console_script.index(button_marker)
                button_end = self.console_script.index("</button>", button_start)
                button_markup = self.console_script[button_start:button_end]
                self.assertNotIn(" 点", button_markup)
                self.assertNotIn("预计", button_markup)

    def test_completed_billing_receipts_use_the_shared_message_path(self):
        helper = self.console_script[
            self.console_script.index("function billingChargeMessage")
            : self.console_script.index("function billingCurrency")
        ]
        self.assertIn("charged_points", helper)
        self.assertIn("free_images_used", helper)
        self.assertIn('status === "waived"', helper)
        self.assertIn("unlimited_compute", helper)
        self.assertIn("本次未扣费", helper)
        self.assertIn("withBillingChargeMessage", helper)
        self.assertIn("已扣除", helper)
        self.assertIn("已使用", helper)

        social = self.console_script[
            self.console_script.index("function socialTaskToastMessage")
            : self.console_script.index("function syncSocialTaskToast")
        ]
        self.assertIn("withBillingChargeMessage", social)
        self.assertIn('status === "success"', social)

        watcher = self.console_script[
            self.console_script.index("function watchTask")
            : self.console_script.index("async function submitPersonaPublishTask")
        ]
        self.assertIn("syncTaskBillingToast", watcher)
        self.assertIn("withBillingChargeMessage", watcher)

    def test_direct_billable_actions_append_actual_charge_to_success_message(self):
        for endpoint in (
            "/api/persona_dashboard/personas/ai_profile",
            "/api/persona_dashboard/personas/ai_keywords",
            "/api/persona_dashboard/personas/ai_create",
            "/generate_posts",
        ):
            with self.subTest(endpoint=endpoint):
                endpoint_start = self.console_script.index(endpoint)
                endpoint_end = min(len(self.console_script), endpoint_start + 2400)
                self.assertIn(
                    "withBillingChargeMessage",
                    self.console_script[endpoint_start:endpoint_end],
                )

    def test_mobile_toasts_enter_from_top_and_busy_spinner_has_distinct_track(self):
        mobile_start = self.console_styles.index(
            "@media (max-width: 760px)",
            self.console_styles.index("Keep compact mobile controls"),
        )
        mobile_end = self.console_styles.index("@media (max-width: 360px)", mobile_start)
        mobile_styles = self.console_styles[mobile_start:mobile_end]
        self.assertIn("top: calc(var(--site-header-height) + 12px);", mobile_styles)
        self.assertIn("bottom: auto;", mobile_styles)
        self.assertIn("animation: toastSlideDown 180ms ease-out;", mobile_styles)
        self.assertIn("@keyframes toastSlideDown", self.console_styles)
        self.assertIn("width: 16px;", self.console_styles)
        self.assertIn("flex: 0 0 16px;", self.console_styles)
        self.assertIn(".task-button-spinner circle", self.console_styles)
        self.assertIn("stroke-opacity: .28;", self.console_styles)
        self.assertIn(".task-button-spinner path", self.console_styles)
        self.assertIn("stroke: #79eed8;", self.console_styles)
        self.assertIn("stroke-width: 3;", self.console_styles)

    def test_running_button_uses_static_border_without_sweep(self):
        running_start = self.console_styles.index(
            '.console-page .console-shell button[aria-busy="true"]:not(.danger)'
        )
        running_end = self.console_styles.index(
            "@media (prefers-reduced-motion: reduce)", running_start
        )
        running_styles = self.console_styles[running_start:running_end]
        self.assertIn(
            "background-image: var(--vecto-action-running-gradient)", running_styles
        )
        self.assertIn("border-color: var(--vecto-action-border) !important;", running_styles)
        self.assertIn("box-shadow: none !important;", running_styles)
        self.assertIn("animation: none !important;", running_styles)
        self.assertNotIn("background-clip: padding-box, border-box", running_styles)
        self.assertNotIn("vecto-action-running-border-sweep", running_styles)
        self.assertNotIn("vecto-action-running-sheen", running_styles)


if __name__ == "__main__":
    unittest.main()
