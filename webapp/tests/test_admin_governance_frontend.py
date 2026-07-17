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
        login_html = (ROOT / "static" / "admin-login.html").read_text(encoding="utf-8")
        self.assertIn('id="adminMfaCode" name="mfa_code" inputmode="text"', login_html)
        for field_id in ("userStepUpTotpCode", "serviceRotateTotpCode", "userPurgeTotpCode"):
            marker = self.html[self.html.index(f'id="{field_id}"') :]
            self.assertIn('inputmode="text"', marker.split(">", 1)[0])

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

    def test_admin_preferences_reuse_shared_navigation_without_language_toggle_binding(self):
        st_script = '/assets/vendor/opencc-js/st-characters.js?v=1.4.1'
        navigation_script = '/assets/opc/site-navigation.js?v=2026071801'
        admin_script = '/assets/admin.js?v=__ADMIN_JS_VERSION__'
        stylesheet = '/assets/style.css?v=__STYLE_VERSION__'
        self.assertLess(self.html.index('window.localStorage.getItem("wk-console-theme")'), self.html.index(stylesheet))
        self.assertLess(self.html.index(st_script), self.html.index(admin_script))
        self.assertLess(self.html.index(navigation_script), self.html.index(admin_script))
        self.assertIn('id="adminThemeToggle"', self.html)
        self.assertIn('data-site-theme-toggle', self.html)
        language_tag = self.html[self.html.index('id="adminLanguageToggle"') :].split('>', 1)[0]
        self.assertNotIn('data-site-language-toggle', language_tag)
        self.assertIn('data-admin-language="zh-Hans"', self.html)
        self.assertIn('data-admin-language="zh-Hant"', self.html)
        self.assertIn('window.VectoSiteNavigation?.setTheme(nextTheme)', self.script)
        self.assertIn('window.VectoSiteNavigation?.setLanguage(option.dataset.adminLanguage)', self.script)

    def test_admin_language_menu_accessibility_and_ui_only_translation(self):
        self.assertIn('function setAdminLanguageMenuOpen', self.script)
        self.assertIn('setAdminProfileMenuOpen(false)', self.script)
        self.assertIn('setAdminLanguageMenuOpen(false)', self.script)
        self.assertIn('event.key === "Escape"', self.script)
        self.assertIn('toggle.focus({ preventScroll: true })', self.script)
        self.assertIn('markAdminStaticUi()', self.script)
        self.assertIn('markAdminStaticUi(node);', self.script)
        self.assertIn('data-admin-i18n-ui="true" data-act="detail"', self.script)
        self.assertIn('<span data-admin-i18n-ui="true">生成类型：</span>', self.script)
        for excluded_data_surface in (
            'tbody',
            '.task-list',
            '.admin-security-list',
            '#adminName',
            '#adminSessionName',
            '#taskInspectBody',
            '#userDetailBody',
        ):
            self.assertIn(f'"{excluded_data_surface}"', self.script)
        self.assertIn('window.addEventListener("vecto:language-change"', self.script)

    def test_admin_preference_icons_are_centered_and_dark_theme_is_readable(self):
        self.assertIn('.page-admin .admin-preference-button', self.styles)
        for declaration in ('display: grid;', 'place-items: center;', 'padding: 0;', 'line-height: 0;'):
            self.assertIn(declaration, self.styles)
        self.assertIn('.page-admin .admin-language-toggle svg', self.styles)
        self.assertIn('display: block;', self.styles)
        self.assertIn('.admin-preference-button .admin-theme-icon-sun', self.styles)
        self.assertIn('html[data-theme="dark"] body.page-admin', self.styles)
        self.assertIn('#secOverview > .admin-governance-head', self.styles)
        for surface in ('modal-card', 'admin-profile-panel', 'table th', 'input'):
            self.assertIn(surface, self.styles)


if __name__ == "__main__":
    unittest.main()
