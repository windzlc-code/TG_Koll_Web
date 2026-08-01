import re
import unittest
from pathlib import Path
import shutil
import subprocess


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


class BillingFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_markup = (STATIC_ROOT / "admin.html").read_text(encoding="utf-8")
        cls.admin_script = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.admin_styles = (STATIC_ROOT / "assets" / "style.css").read_text(encoding="utf-8")
        cls.console_markup = (STATIC_ROOT / "console.html").read_text(encoding="utf-8")
        cls.console_script = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.console_styles = (STATIC_ROOT / "assets" / "console.css").read_text(encoding="utf-8")
        cls.site_navigation_script = (STATIC_ROOT / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
        cls.pricing_markup = (STATIC_ROOT / "pricing.html").read_text(encoding="utf-8")
        cls.pricing_script = (STATIC_ROOT / "assets" / "opc" / "pricing.js").read_text(encoding="utf-8")

    def _run_node(self, script):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        result = subprocess.run(
            [node, "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

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
        self.assertIn('publishRemainingLabel.textContent = traditional ? "今日剩餘任務額度" : "今日剩余任务额度"', personal)
        self.assertIn('loadBilling({ force: true }).catch(() => {})', events)
        self.assertIn('publishRemaining: "今日剩余任务额度"', self.site_navigation_script)
        self.assertIn('publishRemaining: "今日剩餘任務額度"', self.site_navigation_script)

    def test_charge_buttons_do_not_render_catalog_prices(self):
        self.assertNotIn("renderBillingPricePill", self.console_script)
        self.assertNotIn("billing-price-pill", self.console_script)
        self.assertNotIn(".billing-price-pill", self.console_styles)

    def test_billing_dashboard_uses_real_ledger_for_the_balance_chart(self):
        trend = self.console_script[
            self.console_script.index("function billingTrendData")
            : self.console_script.index("function renderBillingSummary")
        ]
        self.assertIn("billingLedgerEntries()", trend)
        self.assertIn("entry.balance_after_points", trend)
        self.assertIn("entry.created_at", trend)
        self.assertIn("billingTimestampMs(entry.created_at)", trend)
        self.assertIn("billingCreditAmount(entry)", trend)
        self.assertIn('entry.eventType !== "opening_balance"', trend)
        self.assertIn('role="img" aria-label="账户算力余额变化折线图"', trend)
        self.assertNotIn("Math.random", trend)
        self.assertNotIn("billingTrendArea", trend)
        self.assertNotIn("billingTrendGlow", trend)

    def test_billing_loader_pages_through_the_complete_ledger(self):
        loader = self.console_script[
            self.console_script.index("async function loadBillingLedger")
            : self.console_script.index(
                "async function loadBilling(",
                self.console_script.index("async function loadBillingLedger"),
            )
        ]
        load_billing = self.console_script[
            self.console_script.index("async function loadBilling(")
            : self.console_script.index("async function loadBillingCatalog")
        ]
        self.assertIn("const pageSize = 200", loader)
        self.assertIn('params.set("before", String(before))', loader)
        self.assertIn("page?.next_before", loader)
        self.assertIn("ledger: loadBillingLedger()", load_billing)
        self.assertNotIn('ledger: api("/api/billing/ledger")', load_billing)

    def test_billing_ledger_pagination_and_trend_baseline_behave_in_node(self):
        loader_start = self.console_script.index("async function loadBillingLedger")
        loader = self.console_script[
            loader_start:self.console_script.index("\nasync function loadBilling(", loader_start)
        ]
        credit_start = self.console_script.index("function billingCreditAmount")
        credit = self.console_script[
            credit_start:self.console_script.index("\nfunction billingTrendData", credit_start)
        ]
        trend_start = self.console_script.index("function billingTrendData")
        trend = self.console_script[
            trend_start:self.console_script.index("\nfunction billingTrendChart", trend_start)
        ]
        harness = f"""
const assert = require("node:assert/strict");
const requestedPaths = [];
async function api(path) {{
  requestedPaths.push(path);
  if (requestedPaths.length === 1) {{
    return {{
      items: Array.from({{ length: 200 }}, (_, index) => ({{ id: `row-${{index}}` }})),
      next_before: 800,
    }};
  }}
  return {{ items: [{{ id: "row-200" }}, {{ id: "row-201" }}], next_before: 700 }};
}}
{loader}

const state = {{ billing: {{ trendRangeDays: 30 }} }};
let ledgerRows = [];
function billingSummaryData() {{ return {{ creditPoints: 100 }}; }}
function billingLedgerEntries() {{ return ledgerRows; }}
{credit}
{trend}

(async () => {{
  const ledger = await loadBillingLedger();
  assert.equal(ledger.items.length, 202);
  assert.deepEqual(requestedPaths, [
    "/api/billing/ledger?limit=200",
    "/api/billing/ledger?limit=200&before=800",
  ]);

  const now = Date.now();
  ledgerRows = [{{
    asset_type: "credit",
    amount_points: 100,
    balance_after_points: 100,
    created_at: Math.floor((now - 3600000) / 1000),
    event_type: "admin_adjustment",
  }}];
  const result = billingTrendData(30);
  assert.equal(result.points[0].value, 0);
  assert.equal(result.change, 100);
}})().catch((error) => {{
  console.error(error);
  process.exitCode = 1;
}});
"""
        self._run_node(harness)

    def test_billing_dashboard_has_range_and_ledger_controls(self):
        self.assertIn('id="billingTrend"', self.console_markup)
        for marker in (
            'data-billing-ledger-filter="all"',
            'data-billing-ledger-filter="expense"',
            'data-billing-ledger-filter="income"',
        ):
            self.assertIn(marker, self.console_markup)
        events = self.console_script[
            self.console_script.index("function bindEvents")
            : self.console_script.index('window.addEventListener("beforeunload"')
        ]
        self.assertIn('data-billing-trend-range', self.console_script)
        self.assertIn('state.billing.trendRangeDays', events)
        self.assertIn('state.billing.ledgerFilter', events)
        self.assertIn('id="openBillingPlans"', self.console_markup)
        self.assertNotIn('<a class="button" href="/pricing.html">查看订阅中心</a>', self.console_markup)
        self.assertIn('window.location.assign("/pricing.html")', events)

    def test_billing_dashboard_has_console_and_mobile_layouts(self):
        dashboard_styles = self.console_styles[
            self.console_styles.index("/* Billing command center */"):
        ]
        self.assertIn(".billing-chart-panel", dashboard_styles)
        self.assertIn(".billing-trend-line", dashboard_styles)
        self.assertIn("stroke: var(--billing-accent);", dashboard_styles)
        self.assertIn("background: var(--panel-solid);", dashboard_styles)
        self.assertNotIn("radial-gradient(circle at 86% 8%", dashboard_styles)
        for status_color in ("#1db9a5", "#3778b9", "#8a65c7", "#d29035"):
            self.assertIn(status_color, dashboard_styles)
        self.assertIn(".billing-ledger-table-head", dashboard_styles)
        self.assertIn("grid-template-columns: 170px minmax(220px, 1fr) 120px 140px;", dashboard_styles)
        self.assertIn('role="table" aria-label="账户余额变动明细"', self.console_script)
        self.assertIn('role="columnheader">变动后余额', self.console_script)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", dashboard_styles)
        self.assertIn("@media (max-width: 760px)", dashboard_styles)

    def test_admin_catalog_editor_uses_business_fields_instead_of_raw_json(self):
        for control_id in (
            "billingSubscriptionEditorList",
            "billingPointUnit",
            "billingPackageEditorList",
            "billingActionEditorList",
        ):
            self.assertIn(f'id="{control_id}"', self.admin_markup)
        self.assertIn("客户套餐设置", self.admin_markup)
        self.assertIn("功能使用费用", self.admin_markup)
        self.assertIn("客户购买申请", self.admin_markup)
        self.assertNotIn('id="billingCatalogJson"', self.admin_markup)
        self.assertNotIn("目录 JSON", self.admin_markup)
        self.assertIn("billingCatalogProductName", self.admin_script)

    def test_admin_catalog_editor_edits_every_subscription_and_syncs_default_alias(self):
        form_renderer = self.admin_script[
            self.admin_script.index("function renderBillingCatalogForm")
            : self.admin_script.index("function billingCatalogNumber")
        ]
        form_reader = self.admin_script[
            self.admin_script.index("function readBillingCatalogForm")
            : self.admin_script.index("const BILLING_STATUS_LABELS")
        ]
        self.assertIn("working.subscriptions.forEach", form_renderer)
        self.assertIn("data-billing-subscription-index", form_renderer)
        for field in ("price_ntd", "monthly_price_ntd", "period_months", "threads_accounts", "monthly_free_images"):
            self.assertIn(f'field: "{field}"', form_renderer)
        self.assertIn('#billingSubscriptionEditorList [data-billing-subscription-index]', form_reader)
        self.assertIn("catalog.subscription = { ...defaultSubscription }", form_reader)

    def test_admin_catalog_layout_uses_dense_responsive_cards_without_history_overflow(self):
        self.assertIn(
            ".page-admin #secPricing .admin-billing-catalog-layout {\n  grid-template-columns: minmax(0, 1fr);",
            self.admin_styles,
        )
        self.assertIn(
            ".page-admin #secPricing .admin-billing-catalog-layout > .admin-billing-table-wrap .admin-billing-table",
            self.admin_styles,
        )
        self.assertIn("table-layout: fixed;", self.admin_styles)
        for editor_list in (
            "#billingSubscriptionEditorList",
            "#billingPackageEditorList",
            "#billingActionEditorList",
        ):
            self.assertIn(f".page-admin #secPricing {editor_list}", self.admin_styles)
        mobile_styles = self.admin_styles[self.admin_styles.index("@media (max-width: 720px)"):]
        self.assertIn("#billingSubscriptionEditorList", mobile_styles)
        self.assertIn("#billingActionEditorList", mobile_styles)

    def test_admin_catalog_editor_uses_compact_tabs_and_exposes_automation_rules(self):
        for tab_name in ("subscriptions", "packages", "actions", "automation"):
            self.assertIn(f'data-billing-editor-tab="{tab_name}"', self.admin_markup)
            self.assertIn(f'data-billing-editor-panel="{tab_name}"', self.admin_markup)
        for summary_id in (
            "billingCatalogTimezone",
            "billingCatalogSubscriptionCount",
            "billingCatalogPackageCount",
            "billingCatalogActionCount",
            "billingCatalogAutomationCount",
            "billingAutomationEditorList",
        ):
            self.assertIn(f'id="{summary_id}"', self.admin_markup)
        self.assertIn("function setBillingCatalogEditorTab", self.admin_script)
        self.assertIn("working.automation_modules.forEach", self.admin_script)
        self.assertIn('billingCatalogTimezone', self.admin_script)
        self.assertIn(".admin-billing-editor-tabs", self.admin_styles)
        self.assertIn(".admin-billing-automation-card", self.admin_styles)

    def test_admin_catalog_editor_groups_personal_and_enterprise_plans_with_pdf_details(self):
        self.assertIn('id="billingCatalogRuleList"', self.admin_markup)
        renderer = self.admin_script[
            self.admin_script.index("function renderBillingCatalogForm")
            : self.admin_script.index("function billingCatalogNumber")
        ]
        self.assertIn("admin-billing-subscription-group", renderer)
        self.assertIn('field: "audience"', renderer)
        self.assertIn('field: "account_positioning"', renderer)
        self.assertIn("working.billing_rules.forEach", renderer)
        self.assertIn("个人轻量版", renderer)
        self.assertIn("企业版", renderer)
        self.assertIn(".admin-billing-subscription-grid", self.admin_styles)
        self.assertIn(".admin-billing-rule-card", self.admin_styles)

    def test_public_pricing_renews_within_the_same_subscription_family(self):
        self.assertIn('clean === "vanguard_monthly"', self.pricing_script)
        self.assertIn('clean.startsWith("vanguard_enterprise_")', self.pricing_script)
        self.assertIn('clean.startsWith("vanguard_personal_")', self.pricing_script)
        self.assertIn(
            "subscriptionPlanFamily(entry.plan_sku) === selectedPlanFamily",
            self.pricing_script,
        )
        self.assertNotIn(
            'activeSubscriptions().filter((entry) => String(entry.plan_sku || "") === skuOf(item))',
            self.pricing_script,
        )

    def test_admin_manual_subscription_selects_a_sku_and_uses_plan_quantity_language(self):
        self.assertIn('id="billingAdjustmentSubscriptionSku"', self.admin_markup)
        self.assertNotIn("开通月度订阅", self.admin_markup)
        submit = self.admin_script[
            self.admin_script.index("async function submitBillingAdjustment")
            : self.admin_script.index("function syncBillingAdjustmentType")
        ]
        self.assertIn("const subscriptionSku", submit)
        self.assertIn("JSON.stringify({ sku: subscriptionSku, quantity", submit)
        sync = self.admin_script[
            self.admin_script.index("function syncBillingAdjustmentType")
            : self.admin_script.index("async function loadBillingWorkspace")
        ]
        self.assertIn('isSubscription ? "订阅套数"', sync)
        self.assertNotIn("1-50 个月", sync)

    def test_admin_publish_copy_uses_period_total_instead_of_monthly_fee(self):
        publish = self.admin_script[
            self.admin_script.index("async function publishBillingCatalog")
            : self.admin_script.index("function billingCatalogProductName")
        ]
        self.assertIn("当前周期总价", publish)
        self.assertNotIn("月费：", publish)

    def test_pricing_page_renders_all_formal_subscription_cycles_and_hides_internal_actions(self):
        self.assertIn("list(catalog.subscriptions)", self.pricing_script)
        self.assertIn('3: "季繳", 6: "半年繳", 12: "年繳"', self.pricing_script)
        self.assertIn("item.public !== false", self.pricing_script)
        self.assertIn("monthly_price_ntd", self.pricing_script)
        self.assertIn("renewalSubscriptions", self.pricing_script)
        self.assertIn("item.implemented === false", self.pricing_script)
        self.assertIn("暫未開放", self.pricing_script)

    def test_pricing_subscription_carousel_keeps_personal_and_enterprise_plans_separate(self):
        self.assertIn("const subscriptionPlanTier = (item) =>", self.pricing_script)
        self.assertIn('item?.plan_tier || ""', self.pricing_script)
        self.assertIn('return subscriptionPlanFamily(skuOf(item)) === "vanguard_personal" ? "personal" : "enterprise"', self.pricing_script)
        self.assertIn("const subscriptionsForPlanTier = (subscriptions, tier)", self.pricing_script)
        self.assertIn("function renderSubscriptionPlans(subscriptions)", self.pricing_script)
        self.assertIn("subscriptionsForPlanTier(subscriptions, tier)", self.pricing_script)
        self.assertIn('data-purchase-sku="${escapeHtml(skuOf(subscription))}"', self.pricing_script)
        self.assertIn("function moveSubscriptionPlanPage(direction)", self.pricing_script)
        self.assertIn("cards[1].offsetLeft - cards[0].offsetLeft", self.pricing_script)
        self.assertIn('host.scrollBy({ left: direction * pageStep, behavior: "smooth" })', self.pricing_script)
        self.assertIn('event.key === "ArrowRight"', self.pricing_script)
        self.assertIn('event.key === "ArrowLeft"', self.pricing_script)

    def test_pricing_page_has_no_enterprise_only_rights_claim_for_all_plans(self):
        self.assertNotIn("每套有效訂閱提供 3 個 Threads 帳號容量", self.pricing_markup)
        self.assertNotIn("三帳號 AI 駕駛艙", self.pricing_markup)
        self.assertNotIn("每個訂閱週期優先抵扣免費圖片額度", self.pricing_markup)
        self.assertIn("個人版 1 個、企業版 3 個", self.pricing_markup)
        self.assertIn("每月 10 張免費 AI 圖片", self.pricing_markup)

    def test_charge_button_markup_has_no_price_text(self):
        for button_marker in (
            "data-persona-profile-editor-regenerate",
            "data-persona-generate-image",
            "data-persona-run-media-task",
            "data-persona-generate-posts",
            "data-persona-publish-submit",
            "data-persona-run-automation=",
            "data-automation-plan-submit",
            "data-persona-create-ai-keywords",
            "data-persona-create-ai-submit",
            'id="executeSimpleFlow"',
        ):
            with self.subTest(button=button_marker):
                button_match = re.search(
                    rf"<button\b[^>]*{re.escape(button_marker)}[^>]*>.*?</button>",
                    self.console_script,
                    re.DOTALL,
                )
                self.assertIsNotNone(button_match)
                button_markup = button_match.group(0)
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
                endpoint_end = (
                    self.console_script.index("async function createPersonaDraftPost", endpoint_start)
                    if endpoint == "/generate_posts"
                    else min(len(self.console_script), endpoint_start + 2400)
                )
                self.assertIn(
                    "withBillingChargeMessage",
                    self.console_script[endpoint_start:endpoint_end],
                )

    def test_persona_post_generation_uses_persistent_task_polling_and_recovery(self):
        generation = self.console_script[
            self.console_script.index("async function generatePersonaDraftPosts")
            : self.console_script.index("async function createPersonaDraftPost")
        ]
        self.assertIn('"Idempotency-Key": operationKey', self.console_script)
        self.assertIn("storePersonaPostGenerationTask", generation)
        self.assertIn("watchPersonaPostGenerationTask", generation)
        self.assertIn("clearStoredPersonaPostGenerationTask", generation)
        self.assertIn("withBillingChargeMessage", generation)
        self.assertIn("task.output", generation)
        self.assertNotIn("isActiveGenerationSurface", generation)
        self.assertIn("restorePersonaPostGenerationTasks", self.console_script)
        self.assertIn("PERSONA_POST_GENERATION_TASK_STORAGE_PREFIX", self.console_script)
        self.assertIn("watchPersonaPostGenerationTask", generation)
        self.assertIn("selectionRequired", generation)
        self.assertIn("resolvePersonaOrdinaryGeneratedCandidates", generation)
        self.assertIn("applyPersonaGeneratedBatchTitles", generation)

    def test_persona_ai_steps_use_independent_stable_idempotency_keys(self):
        keywords = self.console_script[
            self.console_script.index("async function suggestPersonaCreateKeywords")
            : self.console_script.index("function cancelPersonaCreateKeywords")
        ]
        create = self.console_script[
            self.console_script.index("async function createPersonaArchiveWithAi")
            : self.console_script.index("function generatePersonaPayloadFromState")
        ]
        self.assertIn("aiKeywordOperationKey", keywords)
        self.assertIn('personaStepOperationKey(\n    "keywords"', keywords)
        self.assertIn('"Idempotency-Key": operationKey', keywords)
        self.assertIn("aiCreateOperationKey", create)
        self.assertIn('personaStepOperationKey(\n    "create"', create)
        self.assertIn('"Idempotency-Key": operationKey', create)
        self.assertIn("personaStepErrorKeepsOperationKey", keywords)
        self.assertIn("personaStepErrorKeepsOperationKey", create)
        self.assertIn("BILLABLE_OPERATION_IN_PROGRESS", self.console_script)
        self.assertIn("sessionStorage.setItem", self.console_script)
        self.assertIn("PERSONA_STEP_OPERATION_TTL_MS", self.console_script)
        self.assertIn("function personaStepErrorKeepsOperationKey", self.console_script)
        self.assertIn("status === 408 || status === 499", self.console_script)
        self.assertIn("已完成或服务端继续完成的计费步骤仍会按当前步骤扣费", self.console_script)

    def test_mobile_toasts_enter_from_top_and_busy_spinner_has_distinct_track(self):
        mobile_start = self.console_styles.index(
            "@media (max-width: 760px)",
            self.console_styles.index("Keep compact mobile controls"),
        )
        mobile_end = self.console_styles.index("@media (max-width: 360px)", mobile_start)
        mobile_styles = self.console_styles[mobile_start:mobile_end]
        self.assertIn("top: max(12px, env(safe-area-inset-top));", mobile_styles)
        self.assertIn("bottom: auto;", mobile_styles)
        self.assertIn("width: auto;", mobile_styles)
        self.assertIn("animation: toastSlideDownIn 220ms", self.console_styles)
        self.assertIn("@keyframes toastSlideDownIn", self.console_styles)
        self.assertIn("width: 16px;", self.console_styles)
        self.assertIn("flex: 0 0 16px;", self.console_styles)
        self.assertIn(".task-button-spinner circle", self.console_styles)
        self.assertIn("stroke-opacity: .28;", self.console_styles)
        self.assertIn(".task-button-spinner path", self.console_styles)
        self.assertIn("stroke: #79eed8;", self.console_styles)
        self.assertIn("stroke-width: 3;", self.console_styles)

    def test_running_button_uses_static_border_without_sweep(self):
        running_start = self.console_styles.index(
            '.console-page :is(.console-shell, .console-modal) button[aria-busy="true"]:not(.danger)'
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
