import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminGovernanceFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "assets" / "style.css").read_text(encoding="utf-8")

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
            "btnPreviewUserBatch",
            "btnRunUserBatch",
            "userPurgeSection",
            "userPurgeForm",
        ):
            self.assertIn(f'id="{control_id}"', self.html)
        self.assertIn('/api/admin/users/batch-actions', self.script)
        self.assertIn('/purge-preview', self.script)
        self.assertIn('method: "DELETE"', self.script)

    def test_account_batch_controls_use_stable_grouped_layout(self):
        for class_name in (
            "admin-user-batch-summary",
            "admin-user-batch-fields",
            "admin-user-batch-actions",
        ):
            self.assertIn(f'class="{class_name}', self.html)
            self.assertIn(f".page-admin .{class_name}", self.styles)
        self.assertIn("grid-template-columns: minmax(190px, 0.7fr) minmax(520px, 2.8fr) auto;", self.styles)
        self.assertIn("height: 38px;", self.styles)
        self.assertIn(".page-admin [hidden]", self.styles)
        self.assertIn("display: none !important;", self.styles)

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

    def test_admin_language_icon_is_centered_in_fixed_light_theme(self):
        self.assertIn('.admin-preference-button,', self.styles)
        self.assertIn('.admin-language-toggle,', self.styles)
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
        self.assertIn("检测并发布", self.html)


if __name__ == "__main__":
    unittest.main()
