import unittest
from pathlib import Path


class OnlineApplicationFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        cls.pricing_markup = (static_dir / "pricing.html").read_text(encoding="utf-8")
        cls.pricing_script = (static_dir / "assets" / "opc" / "pricing.js").read_text(encoding="utf-8")
        cls.pricing_styles = (static_dir / "assets" / "opc" / "pricing.css").read_text(encoding="utf-8")
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
        self.assertIn(".pricing-section-nav {\n    display: none;\n  }", self.pricing_styles)
        self.assertIn(".pricing-package-card { min-height: 0; gap: 3px; padding: 8px; }", self.pricing_styles)
        self.assertIn(".pricing-public-section { padding-top: 18px; padding-bottom: 18px; }", self.pricing_styles)

    def test_pricing_application_preserves_the_existing_page_canvas(self):
        for legacy_green in (
            "#071112",
            "#0d2426",
            "#163b3d",
            "#0b1719",
            "#58d4c8",
            "rgba(12, 154, 154, 0.2)",
        ):
            with self.subTest(legacy_green=legacy_green):
                self.assertNotIn(legacy_green, self.pricing_styles)

        overlay_rule = self.pricing_styles.split(".pricing-order-overlay {", 1)[1].split("}", 1)[0]
        card_rule = self.pricing_styles.split(".pricing-subscription-card {", 1)[1].split("}", 1)[0]
        main_rule = self.pricing_styles.split(".pricing-subscription-main {", 1)[1].split("}", 1)[0]

        self.assertIn("background: transparent;", overlay_rule)
        self.assertIn("background: #f8fafb;", card_rule)
        self.assertIn("color: var(--ink);", card_rule)
        self.assertIn("background: #dfe7ed;", main_rule)

    def test_opening_an_order_does_not_mutate_the_page_theme(self):
        open_order = self.pricing_script.split("function openOrder(sku) {", 1)[1].split(
            "async function loadAccount", 1
        )[0]

        self.assertIn('modal.classList.add("is-open")', open_order)
        self.assertIn('document.body.classList.add("modal-open")', open_order)
        self.assertNotIn("data-theme", open_order)
        self.assertNotIn("setTheme", open_order)

    def test_subscription_plans_use_accessible_pills_and_a_horizontal_snap_carousel(self):
        self.assertIn('role="tablist" aria-label="訂閱方案類型"', self.pricing_markup)
        self.assertIn('data-pricing-plan-family="personal"', self.pricing_markup)
        self.assertIn('data-pricing-plan-family="enterprise"', self.pricing_markup)
        self.assertIn('data-pricing-plan-page="prev"', self.pricing_markup)
        self.assertIn('data-pricing-plan-page="next"', self.pricing_markup)
        self.assertIn('role="region" aria-label="個人版訂閱方案"', self.pricing_markup)
        self.assertIn(".pricing-plan-slider {", self.pricing_styles)
        self.assertIn("grid-template-columns: 34px minmax(0, 1fr) 34px;", self.pricing_styles)
        self.assertIn("justify-content: center;", self.pricing_styles)
        shell_rule = self.pricing_styles.split(".pricing-subscription-shell {", 1)[1].split("}", 1)[0]
        card_rule = self.pricing_styles.split(".pricing-subscription-card {", 1)[1].split("}", 1)[0]

        self.assertIn("display: flex;", shell_rule)
        self.assertIn("overflow-x: auto;", shell_rule)
        self.assertIn("scroll-snap-type: x mandatory;", shell_rule)
        self.assertIn("overscroll-behavior-inline: contain;", shell_rule)
        self.assertIn("scroll-snap-align: start;", card_rule)
        self.assertIn("flex: 0 0 clamp(300px, 34vw, 370px);", card_rule)
        self.assertIn('button[aria-selected="true"]', self.pricing_styles)
        self.assertIn(".pricing-plan-page-button:focus-visible", self.pricing_styles)

    def test_subscription_cards_use_compact_copy_without_duplicate_entitlements(self):
        renderer = self.pricing_script.split("function renderSubscriptionPlans(subscriptions) {", 1)[1].split(
            "function updateSubscriptionPlanPagination", 1
        )[0]

        self.assertIn('const planTitle = subscriptionPlanTier(subscription) === "enterprise"', renderer)
        self.assertIn('class="pricing-subscription-cycle"', renderer)
        self.assertIn('class="pricing-subscription-monthly"', renderer)
        self.assertIn('class="button button-primary pricing-subscription-cta"', renderer)
        self.assertIn("const displayFeatures = features.length ? features :", renderer)
        self.assertEqual(renderer.count("monthly_free_images"), 1)
        self.assertEqual(renderer.count("threads_accounts"), 1)


if __name__ == "__main__":
    unittest.main()
