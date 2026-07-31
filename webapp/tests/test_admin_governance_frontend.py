import unittest
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminGovernanceFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "assets" / "style.css").read_text(encoding="utf-8")

    @classmethod
    def _extract_js_function(cls, name):
        marker = f"function {name}("
        start = cls.script.index(marker)
        brace = cls.script.index("{", start)
        depth = 0
        for index in range(brace, len(cls.script)):
            character = cls.script[index]
            if character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
                if depth == 0:
                    return cls.script[start : index + 1]
        raise AssertionError(f"JavaScript function {name} is not closed")

    @classmethod
    def _run_email_policy_helpers(cls, expression):
        constant = "const EMAIL_DELIVERY_MANUAL_LIMIT_MAX = 10000000;"
        source = "\n".join(
            (
                constant,
                cls._extract_js_function("validateEmailDeliveryManualLimit"),
                cls._extract_js_function("formatEmailDeliveryPolicyError"),
                f"console.log(JSON.stringify({expression}));",
            )
        )
        result = subprocess.run(
            ["node", "-e", source],
            cwd=ROOT.parent,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return json.loads(result.stdout)

    def test_dashboard_uses_local_chartjs_and_stable_refresh(self):
        self.assertIn('/assets/vendor/chart.js/chart.umd.js', self.html)
        self.assertNotIn('cdn.jsdelivr.net/npm/chart.js', self.html)
        self.assertIn('const GOVERNANCE_POLL_INTERVAL_MS = 30000;', self.script)
        self.assertIn('animation: false', self.script)
        self.assertIn('existing.update("none")', self.script)
        vendor = ROOT / "static" / "assets" / "vendor" / "chart.js" / "chart.umd.js"
        self.assertTrue(vendor.is_file())
        self.assertGreater(vendor.stat().st_size, 100_000)

    def test_governance_refresh_ignores_stale_responses_and_updates_range_labels(self):
        self.assertIn("governanceRequestId", self.script)
        self.assertIn("requestId !== adminState.governanceRequestId", self.script)
        self.assertIn("syncGovernanceChartRangeLabels", self.script)
        for label_id in ("governanceUsersRangeLabel", "governanceTasksRangeLabel"):
            self.assertIn(f'id="{label_id}"', self.html)

    def test_governance_kpis_are_shorter_without_shrinking_content(self):
        for element_id in (
            "govKpiConsumedTotal",
            "govKpiEmailSummary",
            "govKpiEmailSummaryMeta",
            "govKpiEmailLimit",
            "govKpiEmailLimitMeta",
            "btnEmailDeliveryPolicy",
            "emailDeliveryPolicyModal",
            "emailDeliveryLimitMode",
            "emailDeliveryManualLimit",
        ):
            self.assertIn(f'id="{element_id}"', self.html)
        self.assertIn("repeat(auto-fit, minmax(174px, 1fr))", self.styles)
        self.assertIn("min-height: 82px;", self.styles)
        self.assertIn("padding: 10px;", self.styles)
        self.assertIn("font-size: 22px;", self.styles)
        self.assertIn('api("/api/admin/email-delivery-policy"', self.script)
        self.assertIn("payload.email_delivery || {}", self.script)
        self.assertIn("summary.lifetime_consumed_points", self.script)

    def test_email_delivery_policy_helpers_enforce_limit_and_translate_422_details(self):
        result = self._run_email_policy_helpers(
            """({
              empty: validateEmailDeliveryManualLimit(""),
              decimal: validateEmailDeliveryManualLimit("1.5"),
              tooLarge: validateEmailDeliveryManualLimit("10000001"),
              valid: validateEmailDeliveryManualLimit("10000000"),
              validationDetail: formatEmailDeliveryPolicyError({
                detail: [{
                  loc: ["body", "manual_daily_limit"],
                  type: "less_than_equal",
                  msg: "Input should be less than or equal to 10000000",
                  ctx: { le: 10000000 }
                }]
              })
            })"""
        )
        self.assertEqual(result["empty"], "请输入自定义每日上限。")
        self.assertIn("整数", result["decimal"])
        self.assertIn("10,000,000", result["tooLarge"])
        self.assertEqual(result["valid"], "")
        self.assertEqual(result["validationDetail"], "自定义每日上限不能超过 10,000,000 封。")

    def test_email_delivery_policy_modal_has_abortable_save_and_focus_trap_contract(self):
        save = self.script[
            self.script.index("async function saveEmailDeliveryPolicy")
            : self.script.index("function syncGovernanceRangeControls")
        ]
        close = self.script[
            self.script.index("function closeEmailDeliveryPolicyModal")
            : self.script.index("async function saveEmailDeliveryPolicy")
        ]
        trap = self.script[
            self.script.index("function handleEmailDeliveryPolicyModalKeydown")
            : self.script.index("function openEmailDeliveryPolicyModal")
        ]
        self.assertIn("new AbortController()", save)
        self.assertIn("EMAIL_DELIVERY_POLICY_SAVE_TIMEOUT_MS", save)
        self.assertIn("signal: controller.signal", save)
        self.assertIn(".abort()", close)
        self.assertNotIn("emailDeliveryPolicySaving) return", close)
        self.assertIn('event.key !== "Tab"', trap)
        self.assertIn('event.key === "Escape"', trap)
        self.assertIn("emailDeliveryPolicyReturnFocus", close)
        self.assertIn('aria-modal="true"', self.html)
        opened = self.script[
            self.script.index("function openEmailDeliveryPolicyModal")
            : self.script.index("function closeEmailDeliveryPolicyModal")
        ]
        self.assertIn("!overview.sync_error", opened)

    def test_sensitive_one_time_values_are_cleared_on_all_boundaries(self):
        self.assertIn("scheduleUserPasswordResetClear", self.script)
        self.assertIn("scheduleServiceCredentialClear", self.script)
        self.assertIn("clearServiceCredential", self.script)
        self.assertGreaterEqual(self.script.count("60000"), 3)
        visibility = self.script[self.script.index('document.addEventListener("visibilitychange"') :]
        self.assertIn("clearUserPasswordReset()", visibility)
        self.assertIn("clearServiceCredential()", visibility)

    def test_user_bound_async_actions_and_security_owner_preservation(self):
        restore = self.script[self.script.index("async function restoreSelectedUserPassword") : self.script.index("async function loadSelectedUserPurgePreview")]
        revoke = self.script[self.script.index("async function revokeSelectedUserSessions") : self.script.index("function renderPasswordHistory")]
        self.assertIn("targetUserId", restore)
        self.assertIn("targetUserId", revoke)
        self.assertIn("selectedUserStillMatches", restore)
        self.assertIn("selectedUserStillMatches", revoke)
        security = self.script[self.script.index("async function saveSecurityAlert") : self.script.index("function parseScopeInput")]
        self.assertNotIn("assigned_admin_id", security)

    def test_recovery_code_fields_allow_non_numeric_codes(self):
        public_login = (ROOT / "static" / "assets" / "opc" / "script.js").read_text(encoding="utf-8")
        self.assertIn('name="mfa_code" inputmode="text"', public_login)
        for field_id in ("userStepUpTotpCode", "serviceRotateTotpCode", "userPurgeTotpCode"):
            marker = self.html[self.html.index(f'id="{field_id}"') :]
            self.assertIn('inputmode="text"', marker.split(">", 1)[0])

    def test_retired_admin_login_page_and_styles_are_removed(self):
        self.assertFalse((ROOT / "static" / "admin-login.html").exists())
        self.assertNotIn("page-admin-auth", self.styles)

    def test_admin_profile_control_reuses_the_shared_account_drawer(self):
        host_start = self.html.index('id="adminSharedAccountHost"')
        host = self.html[host_start - 160 : host_start + 260]
        self.assertIn('class="admin-shared-account-host"', host)
        self.assertIn('data-site-mode="public"', host)
        self.assertIn('aria-label="管理员个人信息"', host)
        self.assertNotIn('id="adminProfileModal"', self.html)
        self.assertNotIn('id="adminProfileToggle"', self.html)
        self.assertNotIn('class="admin-rail-note"', self.html)
        self.assertNotIn("openAdminProfileModal", self.script)

    def test_billing_admin_exposes_safe_refund_and_subscription_termination(self):
        self.assertIn('<option value="refunded">已冲销</option>', self.html)
        self.assertIn('id="billingSubscriptionBody"', self.html)
        self.assertIn('"order-refund"', self.script)
        self.assertIn('"subscription-terminate"', self.script)
        self.assertIn("支付渠道退款仍需另行完成", self.script)
        self.assertIn("/refund", self.script)
        self.assertIn("/terminate", self.script)

    def test_admin_creation_requires_and_submits_step_up_only_for_admins(self):
        for field_id in (
            "adminCreateStepUpPanel",
            "adminCreateAdminPassword",
            "adminCreateTotpCode",
            "adminCreateReason",
        ):
            self.assertIn(f'id="{field_id}"', self.html)
        create_user = self.script[self.script.index("async function createUser") : self.script.index("async function runTaskAction")]
        self.assertIn("if (payload.is_admin)", create_user)
        self.assertIn("readAdminStepUp", create_user)
        self.assertIn("Object.assign(payload, stepUp)", create_user)
        self.assertIn('el("adminCreateStepUpPanel").hidden = !isAdmin', self.script)

    def test_account_governance_controls_are_present(self):
        for control_id in (
            "adminUserFilterForm",
            "adminUserLifecycle",
            "adminUserRisk",
            "adminUserSubscription",
            "adminUserBatchBar",
            "adminSelectAllUsers",
            "adminUserBatchModal",
            "adminUserBatchModalTitle",
            "adminUserBatchModalCount",
            "adminUserBatchCreditField",
            "adminUserBatchCredit",
            "adminUserBatchUnlimited",
            "adminUserBatchCreditShortcuts",
            "adminUserBatchCreditShortcutList",
            "btnAdminUserBatchCreditShortcutAdd",
            "adminUserBatchCreditShortcutForm",
            "adminUserBatchCreditShortcutName",
            "adminUserBatchCreditShortcutPoints",
            "btnAdminUserBatchCreditShortcutSave",
            "adminUserBatchReason",
            "btnAdminUserBatchConfirm",
            "userPurgeSection",
            "userPurgeForm",
        ):
            self.assertIn(f'id="{control_id}"', self.html)
        self.assertIn('/api/admin/users/batch-actions', self.script)
        self.assertIn('action === "add_credit"', self.script)
        self.assertIn("delta_points", self.script)
        self.assertIn("idempotency_key", self.script)
        self.assertIn("userBatchInFlight", self.script)
        self.assertIn("selectAllFilteredUsers", self.script)
        self.assertIn("userBatchSelectionMeta", self.script)
        self.assertIn("userBatchActionAvailable", self.script)
        self.assertIn("button.dataset.userBatchAction", self.script)
        self.assertIn('payload.unlimited = Boolean(el("adminUserBatchUnlimited")?.checked)', self.script)
        self.assertIn("ADMIN_CREDIT_SHORTCUTS_STORAGE_KEY", self.script)
        self.assertIn("renderAdminCreditShortcuts", self.script)
        self.assertIn("saveAdminCreditShortcut", self.script)
        self.assertIn("removeAdminCreditShortcut", self.script)
        self.assertIn("syncAdminCreditShortcutToggle", self.script)
        self.assertIn('credit.value = String(shortcut.points)', self.script)
        self.assertIn("localStorage.setItem(ADMIN_CREDIT_SHORTCUTS_STORAGE_KEY", self.script)
        self.assertLess(
            self.html.index('id="adminUserBatchCreditShortcuts"'),
            self.html.index('id="adminUserBatchUnlimitedField"'),
        )
        self.assertLess(
            self.html.index('id="adminUserBatchCreditShortcuts"'),
            self.html.index('id="adminUserBatchCreditField"'),
        )
        self.assertIn('aria-label="选择全部筛选结果"', self.html)
        self.assertIn('/purge-preview', self.script)
        self.assertIn('method: "DELETE"', self.script)

    def test_account_batch_controls_use_three_modal_actions_only(self):
        self.assertIn('class="admin-user-batch-summary', self.html)
        self.assertIn(".page-admin .admin-user-batch-summary", self.styles)
        for obsolete_id in (
            "btnClearUserSelection",
            "adminUserBatchAction",
            "adminBatchGroupField",
            "adminBatchTagsField",
            "btnPreviewUserBatch",
            "btnRunUserBatch",
            "adminUserBatchMsg",
        ):
            self.assertNotIn(f'id="{obsolete_id}"', self.html)
        self.assertIn("function openUserBatchModal", self.script)
        self.assertIn("async function submitUserBatchModal", self.script)
        self.assertIn("await previewUserBatchAction()", self.script)
        self.assertIn("buildUserBatchPayload(false)", self.script)
        self.assertIn(".page-admin [hidden]", self.styles)
        self.assertIn("display: none !important;", self.styles)

    def test_batch_reason_is_optional_and_modal_blur_is_light(self):
        batch_modal = self.html[
            self.html.index('id="adminUserBatchModal"')
            : self.html.index('id="adminPublicPromptModal"')
        ]
        self.assertIn("操作原因（选填）", batch_modal)
        self.assertIn("选填，例如", batch_modal)
        batch_script = self.script[
            self.script.index("const USER_BATCH_ACTION_CONFIG")
            : self.script.index("function buildAdminUserListParams")
        ]
        self.assertNotIn("payload.reason.length", batch_script)
        self.assertNotIn("至少 2 个字符的操作原因", batch_script)
        modal_overlay = self.styles[
            self.styles.index(".modal-overlay {")
            : self.styles.index(".modal-card {")
        ]
        self.assertIn("backdrop-filter: blur(2px);", modal_overlay)
        self.assertIn("-webkit-backdrop-filter: blur(2px);", modal_overlay)
        self.assertNotIn("blur(8px)", modal_overlay)

    def test_public_modals_use_borderless_svg_close_and_ignore_backdrop_clicks(self):
        for button_id in (
            "btnAdminUserBatchClose",
            "btnAdminPublicPromptClose",
            "btnAdminPublicActionClose",
            "btnTaskInspectClose",
            "btnRechargeClose",
            "btnUserDetailClose",
            "btnCloseMfaSetup",
        ):
            marker = self.html[self.html.index(f'id="{button_id}"') :]
            button = marker[: marker.index("</button>")]
            self.assertIn('class="modal-close-icon"', button)
            self.assertIn("<svg", button)
            self.assertNotIn(">关闭", button)
        close_style = self.styles[
            self.styles.index(".page-admin .modal-close-icon {")
            : self.styles.index(".page-admin .modal-close-icon svg")
        ]
        self.assertIn("border: 0;", close_style)
        self.assertIn("background: transparent;", close_style)
        for modal_id in (
            "adminMfaModal",
            "adminUserBatchModal",
            "adminPublicPromptModal",
            "adminPublicActionModal",
            "taskInspectModal",
            "rechargeModal",
            "userDetailModal",
        ):
            self.assertNotIn(f'el("{modal_id}")?.addEventListener("click"', self.script)
            self.assertNotIn(f'if (el("{modal_id}")) {{', self.script)

    def test_primary_account_controls_are_batch_only_and_next_to_the_table(self):
        compose_index = self.html.index('class="admin-compose-shell"')
        batch_index = self.html.index('id="adminUserBatchBar"')
        table_index = self.html.index('class="table-wrap admin-table-shell"')
        self.assertLess(compose_index, batch_index)
        self.assertLess(batch_index, table_index)
        for action in ("add_credit", "enable", "suspend"):
            self.assertIn(f'data-user-batch-action="{action}"', self.html)
        self.assertIn("openUserBatchModal(button.dataset.userBatchAction)", self.script)
        user_rows = self.script[
            self.script.index("async function loadUsers")
            : self.script.index("function detailRow")
        ]
        self.assertNotIn('addAction("人工调整算力点"', user_rows)
        self.assertNotIn('"toggle"', user_rows)
        self.assertIn('actionLabel.className = "admin-user-action-label"', user_rows)
        self.assertIn(".page-admin .admin-user-action-label", self.styles)

    def test_user_row_actions_use_standard_icons_and_concise_labels(self):
        user_rows = self.script[
            self.script.index("const ADMIN_USER_ICONS")
            : self.script.index("function detailRow")
        ]
        self.assertIn('addAction("查看", "user_detail", "detail")', user_rows)
        self.assertIn('addAction("详情", "billing_detail", "billing"', user_rows)
        self.assertIn('addAction("删除", "archive_user", "delete"', user_rows)
        self.assertNotIn('addAction("查看详情"', user_rows)
        self.assertNotIn('addAction("计费详情"', user_rows)
        self.assertNotIn('addAction("软删除账号"', user_rows)
        self.assertIn('M14 2H6a2 2 0 0 0-2 2v16', user_rows)
        self.assertIn('M3 6h18M8 6V4h8v2', user_rows)

    def test_admin_operations_use_shared_action_modal(self):
        for control_id in (
            "adminPublicActionModal",
            "adminPublicActionDialog",
            "adminPublicActionTitle",
            "adminPublicActionMessage",
            "adminPublicActionInputField",
            "adminPublicActionInput",
            "btnAdminPublicActionCancel",
            "btnAdminPublicActionConfirm",
        ):
            self.assertIn(f'id="{control_id}"', self.html)
        self.assertIn("function requestAdminPublicAction", self.script)
        self.assertIn("function settleAdminPublicAction", self.script)
        self.assertNotIn("window.confirm", self.script)
        self.assertNotRegex(self.script, r"(?<![A-Za-z])confirm\(")
        self.assertNotRegex(self.script, r"(?<![A-Za-z])prompt\(")
        self.assertIn(".admin-public-action-modal", self.styles)

    def test_select_all_progress_does_not_leak_into_create_user_message(self):
        self.assertNotIn('setMsg("userMsg", "正在选择全部筛选结果...")', self.script)

    def test_governance_pages_and_step_up_fields_are_present(self):
        for page in ("overview", "users", "taxonomy", "audit", "security", "serviceAccounts"):
            self.assertIn(f'data-page="{page}"', self.html)
        for field in ("userStepUpAdminPassword", "userStepUpTotpCode", "userStepUpReason"):
            self.assertIn(f'id="{field}"', self.html)
        for field in (
            "adminMfaCurrentPassword",
            "serviceRotateAdminPassword",
            "serviceRotateTotpCode",
            "serviceRotateReason",
        ):
            self.assertIn(f'id="{field}"', self.html)
        self.assertIn('/api/auth/mfa/setup', self.script)
        self.assertIn('/api/auth/mfa/verify-setup', self.script)
        self.assertIn('current_password: currentPassword', self.script)
        self.assertIn('setDefaultServiceAccountExpiry()', self.script)

    def test_status_semantics_and_responsive_layout_are_defined(self):
        for token in ("enabled", "pending", "rejected", "disabled", "locked", "archived", "deleted"):
            self.assertIn(f'admin-user-badge-{token}', self.styles)
        self.assertIn('.admin-user-filter-bar', self.styles)
        self.assertIn('.admin-user-batch-bar', self.styles)
        self.assertIn('@media (max-width: 720px)', self.styles)

    def test_governance_workspace_keeps_structural_component_styles(self):
        required_selectors = (
            ".page-admin .admin-governance-panel {",
            ".page-admin .admin-governance-chart {",
            ".page-admin .admin-distribution-list,",
            ".page-admin .admin-health-row,",
            ".page-admin .admin-governance-filters",
            ".page-admin .admin-security-alert {",
            ".page-admin .admin-service-account-form",
            ".page-admin .admin-user-governance-section {",
            ".page-admin .admin-user-filter-bar,",
            ".page-admin .admin-language-panel {",
        )
        for selector in required_selectors:
            with self.subTest(selector=selector):
                self.assertIn(selector, self.styles)
        self.assertIn("border: 1px solid var(--admin-line);", self.styles)

    def test_admin_preferences_use_fixed_light_theme_and_shared_language(self):
        st_script = '/assets/vendor/opencc-js/st-characters.js?v=1.4.1'
        navigation_script = '/assets/opc/site-navigation.js?v=__SITE_NAVIGATION_JS_VERSION__'
        admin_script = '/assets/admin.js?v=__ADMIN_JS_VERSION__'
        stylesheet = '/assets/style.css?v=__STYLE_VERSION__'
        self.assertLess(self.html.index('document.documentElement.dataset.theme = "light"'), self.html.index(stylesheet))
        self.assertLess(self.html.index(st_script), self.html.index(admin_script))
        self.assertLess(self.html.index(navigation_script), self.html.index(admin_script))
        self.assertNotIn('id="adminThemeToggle"', self.html)
        self.assertNotIn('data-site-theme-toggle', self.html)
        language_tag = self.html[self.html.index('id="adminLanguageToggle"') :].split('>', 1)[0]
        self.assertNotIn('data-site-language-toggle', language_tag)
        self.assertIn('data-admin-language="zh-Hans"', self.html)
        self.assertIn('data-admin-language="zh-Hant"', self.html)
        self.assertIn('window.VectoSiteNavigation?.setLanguage(option.dataset.adminLanguage)', self.script)

    def test_admin_language_menu_accessibility_and_ui_only_translation(self):
        self.assertIn('function setAdminLanguageMenuOpen', self.script)
        self.assertNotIn('setAdminProfileMenuOpen', self.script)
        self.assertIn('setAdminLanguageMenuOpen(false)', self.script)
        self.assertIn('event.key === "Escape"', self.script)
        self.assertIn('toggle.focus({ preventScroll: true })', self.script)
        self.assertIn('markAdminStaticUi()', self.script)
        self.assertIn('markAdminStaticUi(node);', self.script)
        self.assertIn('data-admin-i18n-ui="true" data-act="detail"', self.script)
        self.assertIn('<span data-admin-i18n-ui="true">流程：</span>', self.script)
        for excluded_data_surface in (
            'tbody',
            '.task-list',
            '.admin-security-list',
            '#adminName',
            '#taskInspectBody',
            '#userDetailBody',
        ):
            self.assertIn(f'"{excluded_data_surface}"', self.script)
        self.assertIn('window.addEventListener("vecto:language-change"', self.script)

    def test_dynamic_governance_ui_is_marked_without_translating_business_data(self):
        self.assertIn("function markAdminDynamicUiElement", self.script)
        self.assertIn("function createAdminDynamicUiText", self.script)
        for source, target in (
            ("数据库", "資料庫"),
            ("连接与查询", "連線與查詢"),
            ("加密密钥检查", "加密金鑰檢查"),
            ("未启用", "未啟用"),
            ("备注", "備註"),
        ):
            self.assertIn(f'["{source}", "{target}"]', self.script)

        user_rows = self.script[
            self.script.index("async function loadUsers")
            : self.script.index("function detailRow")
        ]
        self.assertIn("markAdminDynamicUiElement(emptyCell)", user_rows)
        self.assertIn("markAdminDynamicUiElement(button)", user_rows)
        self.assertIn('button.setAttribute("aria-labelledby"', user_rows)
        self.assertNotIn("markAdminDynamicUiElement(accountName)", user_rows)
        self.assertNotIn("markAdminDynamicUiElement(companyCell)", user_rows)

        sessions = self.script[
            self.script.index("function renderUserSessions")
            : self.script.index("async function loadSelectedUserSessions")
        ]
        self.assertIn('createAdminDynamicUiText("最近活动")', sessions)
        self.assertIn('createAdminDynamicUiText("撤销于")', sessions)
        self.assertNotIn("markAdminDynamicUiElement(title)", sessions)

        password_history = self.script[
            self.script.index("function renderPasswordHistory")
            : self.script.index("async function loadSelectedPasswordHistory")
        ]
        self.assertIn('createAdminDynamicUiText("有效至")', password_history)
        self.assertIn("markAdminDynamicUiElement(button)", password_history)
        self.assertNotIn("markAdminDynamicUiElement(title)", password_history)

        security = self.script[
            self.script.index("function renderSecurityAlerts")
            : self.script.index("async function loadSecurityAlerts")
        ]
        self.assertIn('createAdminDynamicUiText("最近：")', security)
        self.assertIn("markAdminDynamicUiElement(option)", security)
        self.assertIn("markAdminDynamicUiElement(note)", security)
        self.assertNotIn("markAdminDynamicUiElement(title)", security)
        self.assertNotIn("markAdminDynamicUiElement(summary)", security)

        service_accounts = self.script[
            self.script.index("function renderServiceAccounts")
            : self.script.index("async function loadServiceAccounts")
        ]
        self.assertIn("markAdminDynamicUiElement(option)", service_accounts)
        self.assertIn("markAdminDynamicUiElement(save)", service_accounts)
        self.assertIn("markAdminDynamicUiElement(rotate)", service_accounts)
        self.assertIn('purpose.value = String(item.purpose || "")', service_accounts)
        self.assertIn('scopes.value = (item.allowed_scopes || []).join(", ")', service_accounts)

        proxy_market = self.script[
            self.script.index("function renderProxyMarketItems")
            : self.script.index("function proxyMarketItemQuery")
        ]
        self.assertIn("proxyMarketAvailabilityText(item)", proxy_market)
        self.assertIn('createAdminDynamicUiText("尚未检测")', proxy_market)
        self.assertNotIn("markAdminDynamicUiElement(endpoint)", proxy_market)

        health = self.script[
            self.script.index("function renderGovernanceHealth")
            : self.script.index("function renderGovernanceQueue")
        ]
        for label in ("数据库", "连接与查询", "密码保险库", "加密密钥检查", "计费执行", "未启用"):
            self.assertIn(label, health)
        self.assertIn("createAdminDynamicUiText(name)", health)
        self.assertIn("createAdminDynamicUiText(detail)", health)
        self.assertIn("description.textContent = String(detail ||", health)
        self.assertNotIn("createAdminDynamicUiText(vault.error)", health)

        taxonomy = self.script[
            self.script.index("function renderTaxonomyList")
            : self.script.index("async function loadTaxonomyWorkspace")
        ]
        self.assertIn("markAdminDynamicUiElement(option)", taxonomy)
        self.assertIn('createAdminDynamicUiText("位客户")', taxonomy)
        self.assertNotIn("markAdminDynamicUiElement(name)", taxonomy)

    def test_admin_language_and_account_icons_are_centered_in_fixed_light_theme(self):
        self.assertIn(
            ':root .page-admin .admin-profile-menu :is(.admin-language-toggle, .site-user)',
            self.styles,
        )
        for declaration in ('display: grid;', 'place-items: center;', 'padding: 0;', 'line-height: 0;'):
            self.assertIn(declaration, self.styles)
        self.assertIn('document.documentElement.dataset.theme = "light"', self.html)
        self.assertNotIn('html[data-theme="dark"] body.page-admin', self.styles)

    def test_proxy_market_reuses_atomic_test_and_publish_api(self):
        proxy_market = self.script[
            self.script.index("function renderProxyMarketItems")
            : self.script.index("async function updateProxyMarketStatus")
        ]
        self.assertIn('/test-and-publish`', proxy_market)
        self.assertNotIn('/test`', proxy_market)
        self.assertNotIn('/publish`', proxy_market)
        self.assertNotIn("pending_check_id", proxy_market)
        self.assertNotIn("pending_check_status", proxy_market)
        self.assertNotIn("confirm(`将重新检测并发布", proxy_market)
        self.assertIn('publish.disabled = String(item.status || "") === "archived"', proxy_market)
        self.assertIn('["draft", "active", "disabled"]', proxy_market)
        self.assertIn('if (status === "active") return publishProxyMarketRow(itemId, control);', self.script)
        self.assertIn("showAdminPublicPrompt", proxy_market)
        self.assertIn('id="adminPublicPromptModal"', self.html)
        self.assertIn("检测并发布", self.html)


if __name__ == "__main__":
    unittest.main()
