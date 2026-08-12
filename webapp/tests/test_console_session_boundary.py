import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = REPO_ROOT / "webapp" / "static" / "assets" / "console.js"
ADMIN_JS = REPO_ROOT / "webapp" / "static" / "assets" / "admin.js"
ADMIN_CSS = REPO_ROOT / "webapp" / "static" / "assets" / "style.css"
PERSONA_DASHBOARD_JS = REPO_ROOT / "webapp" / "static" / "assets" / "persona-dashboard.js"
CONSOLE_CSS = REPO_ROOT / "webapp" / "static" / "assets" / "console.css"
CONSOLE_HTML = REPO_ROOT / "webapp" / "static" / "console.html"
SITE_NAV_JS = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js"
SITE_NAV_CSS = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.css"
PROFILE_HTML = REPO_ROOT / "webapp" / "static" / "profile.html"
PROFILE_JS = REPO_ROOT / "webapp" / "static" / "assets" / "profile.js"
PROFILE_CSS = REPO_ROOT / "webapp" / "static" / "assets" / "profile.css"
OPENCC_ST_CHARACTERS_JS = REPO_ROOT / "webapp" / "static" / "assets" / "vendor" / "opencc-js" / "st-characters.js"


class ConsoleSessionBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = CONSOLE_JS.read_text(encoding="utf-8")
        cls.admin_source = ADMIN_JS.read_text(encoding="utf-8")
        cls.admin_styles = ADMIN_CSS.read_text(encoding="utf-8")
        cls.persona_dashboard_source = PERSONA_DASHBOARD_JS.read_text(encoding="utf-8")
        cls.styles = CONSOLE_CSS.read_text(encoding="utf-8")
        cls.markup = CONSOLE_HTML.read_text(encoding="utf-8")
        cls.site_nav_source = SITE_NAV_JS.read_text(encoding="utf-8")
        cls.site_nav_styles = SITE_NAV_CSS.read_text(encoding="utf-8")
        cls.profile_markup = PROFILE_HTML.read_text(encoding="utf-8")
        cls.profile_source = PROFILE_JS.read_text(encoding="utf-8")
        cls.profile_styles = PROFILE_CSS.read_text(encoding="utf-8")

    def test_console_uses_vecto_site_navigation_without_replacing_workspace_navigation(self):
        self.assertIn('data-site-header data-site-page="console"', self.markup)
        self.assertIn('<a class="site-skip-link"', self.markup)
        self.assertIn('class="site-nav"', self.markup)
        self.assertIn('data-site-mobile-menu', self.markup)
        self.assertIn('<script defer src="/assets/opc/site-navigation.js', self.markup)
        self.assertIn('/assets/opc/site-navigation.css', self.markup)
        self.assertIn('/assets/vendor/opencc-js/st-characters.js?v=1.4.1', self.markup)
        self.assertTrue(OPENCC_ST_CHARACTERS_JS.exists())
        self.assertIn('id="consoleMeName"', self.site_nav_source)
        self.assertIn('src="/assets/opc/vecto-logo-ui-icon.png', self.site_nav_source)
        for required_id in ("consoleSidebar", "moduleMenu", "viewTitle"):
            self.assertIn(f'id="{required_id}"', self.markup)
        self.assertNotIn('id="refreshAll"', self.markup)
        self.assertNotIn('class="header-action" href="/"', self.markup)
        for view in ("workspace", "persona_dashboard"):
            self.assertIn(f'data-view="{view}"', self.markup)
        for removed_view in ("tasks", "settings", "console_settings"):
            self.assertNotIn(f'data-view="{removed_view}"', self.markup)
        self.assertNotIn('data-panel="settings"', self.markup)
        self.assertIn('data-site-open-billing', self.markup)
        self.assertIn('data-panel="billing"', self.markup)
        self.assertIn(".site-header", self.site_nav_styles)
        self.assertIn(".console-page .console-shell", self.styles)
        self.assertIn("body.console-page", self.styles)
        self.assertIn("padding-top: var(--site-header-height)", self.styles)
        self.assertIn("grid-template-columns: 304px minmax(0, 1fr)", self.styles)
        self.assertIn("top: calc(var(--site-header-height) + 16px)", self.styles)
        self.assertIn('.site-header[data-site-page="console"] .header-actions', self.site_nav_styles)
        self.assertIn("min-width: 274px", self.site_nav_styles)
        self.assertIn("scrollbar-gutter: stable", self.site_nav_styles)
        self.assertIn('font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif', self.site_nav_styles)
        self.assertIn('data-site-nav-key="${key}"', self.site_nav_source)
        self.assertIn('.site-nav > a[data-site-nav-key]', self.site_nav_styles)

    def test_console_uses_fixed_light_theme_and_global_language_control(self):
        self.assertNotIn('id="themeToggle"', self.markup)
        self.assertNotIn('data-site-theme-toggle', self.site_nav_source)
        self.assertIn('id="languageToggle"', self.site_nav_source)
        self.assertIn('window.addEventListener("vecto:theme-change"', self.source)
        self.assertIn('window.addEventListener("vecto:language-change"', self.source)
        self.assertIn("window.VectoOpenCcStCharacters", self.source)
        self.assertIn("protectedPhrases", self.source)
        self.assertIn('const CONSOLE_I18N_MARKER = "data-i18n-ui"', self.source)
        self.assertIn("markConsoleStaticUi", self.source)
        self.assertIn("setConsoleUiAttribute", self.source)
        self.assertIn('setConsoleUiAttribute(toggle, "aria-label"', self.source)
        self.assertIn('window.addEventListener("storage"', self.site_nav_source)
        self.assertIn('const nextTheme = "light"', self.site_nav_source)
        self.assertIn('setTheme("light", { persist: false })', self.site_nav_source)
        ensure_theme = self._function_source("ensureThemeToggle")
        ensure_language = self._function_source("ensureLanguageToggle")
        self.assertNotIn("document.createElement", ensure_theme)
        self.assertNotIn("document.createElement", ensure_language)

    def test_social_task_log_summary_uses_server_strategy_detail(self):
        self.assertIn('const taskSummaryDetail = String(task?.task_summary?.detail || "").trim();', self.source)
        self.assertIn(
            "taskSummaryDetail || task.workflow_name || statusLabel(task.task_type || task.type || \"\")",
            self.source,
        )

    def test_console_marks_dynamic_ui_before_translating_it(self):
        marker_source = self._function_source("markConsoleStaticUi")
        dynamic_marker_source = self._function_source("markConsoleDynamicUi")
        observer_source = self._function_source("startLanguageObserver")
        self.assertNotIn("parent?.id", marker_source)
        self.assertIn("CONSOLE_DYNAMIC_TEXT_I18N_SELECTOR", dynamic_marker_source)
        self.assertIn("CONSOLE_DYNAMIC_ATTRIBUTE_I18N_SELECTOR", dynamic_marker_source)
        self.assertIn("attributesOnly: true", dynamic_marker_source)
        self.assertNotIn("markConsoleStaticUi(mutation.target)", observer_source)
        self.assertIn("markConsoleDynamicUi(node)", observer_source)
        self.assertLess(
            observer_source.index("markConsoleDynamicUi(node)"),
            observer_source.index("translateConsoleLanguage(node, language)"),
        )

    def test_console_dynamic_translation_covers_nested_ui_without_touching_business_content(self):
        dynamic_marker_source = self._function_source("markConsoleDynamicUi")
        ui_guard_source = self._function_source("shouldMarkConsoleDynamicUiText")
        self.assertIn("document.createTreeWalker", dynamic_marker_source)
        self.assertIn("shouldMarkConsoleDynamicUiText", dynamic_marker_source)
        self.assertIn("CONSOLE_DYNAMIC_UI_TEXT_PATTERN", ui_guard_source)
        self.assertIn("CONSOLE_DYNAMIC_USER_CONTENT_SELECTOR", ui_guard_source)
        for protected_selector in (
            '".persona-draft-table-content"',
            '".persona-draft-detail-content p"',
            '".publish-post-card-snippet"',
            '".task-detail-log-item > p"',
        ):
            self.assertIn(protected_selector, self.source)
        self.assertIn('"data-label"', self.source)
        for runtime_label in ("序号", "系统有效性", "算力余额", "人工调整", "环境", "并发", "分页"):
            self.assertIn(runtime_label, self.source)
        self.assertIn('label === eventLabels[entry.event_type] ? "data-i18n-ui" : "data-i18n-skip"', self.source)
        self.assertIn("markConsoleDynamicUi(modal)", self.source)
        self.assertNotIn('modal.querySelectorAll("strong, p, label, button', self.source)

    def test_cookie_status_keeps_credentials_and_login_placeholders_visible(self):
        status_source = self._javascript_function_source(
            self.admin_source,
            "sentimentCookieStatusDetails",
        )
        for credential_name in ("sessionid", "web_session", "c_user", "auth_token"):
            self.assertIn(f'"{credential_name}"', status_source)
        self.assertIn('label: "登录状态"', status_source)
        self.assertIn('value: "未获取"', status_source)
        self.assertIn('state: "inactive"', status_source)
        self.assertNotIn("if (!reportsSessionid)", status_source)
        self.assertNotIn("if (sessionidSaved)", status_source)
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            function sentimentCookieProfileCanonicalKey(profile) {{ return profile.key; }}
            function sentimentCookieActionLabel() {{ return ""; }}
            function formatAdminDate(value) {{ return value || ""; }}
            {status_source}

            const instagram = sentimentCookieStatusDetails({{
              key: "instagram",
              cookieCount: 16,
              validCookieCount: 16,
              cookieNames: ["datr", "sessionid"],
              validCookieNames: ["datr", "sessionid"],
              liveAuthStatus: "verified",
              liveSearchStatus: "available",
              liveSearchUsable: true,
              liveAuthCheckedAt: "2026-07-31T00:00:00Z",
            }});
            assert.deepEqual(instagram.items.map((item) => [item.label, item.value, item.state]), [
              ["Cookie", "已保存 16", "ready"],
              ["sessionid", "已保存", "ready"],
              ["登录状态", "登录有效", "ready"],
              ["实时热点搜索", "可用", "ready"],
            ]);

            const instagramPending = sentimentCookieStatusDetails({{
              key: "instagram",
              cookieCount: 16,
              validCookieCount: 16,
              cookieNames: ["datr", "sessionid"],
              validCookieNames: ["datr", "sessionid"],
            }});
            assert.equal(instagramPending.items[2].value, "待实时检测");
            assert.equal(instagramPending.items[2].state, "warning");
            assert.equal(instagramPending.items[3].value, "待手动检测");
            assert.equal(instagramPending.items[3].state, "warning");

            const instagramManual = sentimentCookieStatusDetails({{
              key: "instagram",
              cookieCount: 16,
              validCookieCount: 16,
              cookieNames: ["datr", "sessionid"],
              validCookieNames: ["datr", "sessionid"],
              liveAuthStatus: "pending_manual_check",
            }});
            assert.equal(instagramManual.items[2].value, "待手动检测");
            assert.equal(instagramManual.items[2].state, "warning");
            assert.equal(instagramManual.items[3].value, "待手动检测");
            assert.equal(instagramManual.items[3].state, "warning");

            const facebook = sentimentCookieStatusDetails({{
              key: "facebooksearch",
              cookieCount: 5,
              validCookieCount: 5,
              cookieNames: ["datr", "fr"],
            }});
            assert.deepEqual(facebook.items.map((item) => [item.label, item.value, item.state]), [
              ["Cookie", "已保存 5", "ready"],
              ["c_user", "未获取", "inactive"],
              ["登录状态", "未获取", "inactive"],
            ]);
            """
        )
        self._run_node(harness)

    def test_cookie_status_live_probe_runs_on_page_open_and_every_five_minutes(self):
        admin_markup = (REPO_ROOT / "webapp" / "static" / "admin.html").read_text(encoding="utf-8")
        self.assertIn("const SENTIMENT_COOKIE_POLL_INTERVAL_MS = 300000;", self.admin_source)
        self.assertIn("void refreshSentimentCookieProfilesIfActive({ force: true });", self.admin_source)
        self.assertIn("}, SENTIMENT_COOKIE_POLL_INTERVAL_MS);", self.admin_source)
        self.assertIn('await loadSentimentCookieProfiles({ force: true });', self.admin_source)
        self.assertIn('setButtonLoading("btnSentimentCookieRefresh", true, "检测中");', self.admin_source)
        self.assertIn('setButtonLoading("btnSentimentCookieRefresh", false);', self.admin_source)
        self.assertIn(".page-admin #btnSentimentCookieRefresh.is-loading", self.admin_styles)
        self.assertIn(".page-admin #btnSentimentCookieRefresh.is-loading::before", self.admin_styles)
        self.assertIn('? "?force=true" : ""', self.admin_source)
        self.assertIn('setSentimentCookieLiveState("自动检测中...", "checking")', self.admin_source)
        self.assertIn("当前页面每 5 分钟自动检测一次", admin_markup)
        self.assertIn("等待自动检测", admin_markup)

    def test_cookie_status_exposes_real_hot_search_availability(self):
        self.assertIn('label: "实时热点搜索"', self.admin_source)
        self.assertIn('value: "可用"', self.admin_source)
        self.assertIn('value: "不可用"', self.admin_source)

    def test_sentiment_browser_probe_checks_real_search_paths(self):
        probe_source = (REPO_ROOT / "tool_r18" / "scripts" / "probe-threads-auth.mjs").read_text(encoding="utf-8")
        self.assertIn("/search?q=", probe_source)
        self.assertIn("/api/v1/tags/web_info/?tag_name=", probe_source)
        self.assertIn("searchUsable", probe_source)
        self.assertIn("searchStatus", probe_source)

    def test_personal_profile_is_a_separate_bright_page_with_svg_upload(self):
        for removed_console_profile_marker in (
            "settingsProfileFullName",
            "settingsProfileAvatarFile",
            "saveProfileSettings",
            "loadProfileAvatarFile",
        ):
            self.assertNotIn(removed_console_profile_marker, self.source)

        self.assertIn("function openProfilePage()", self.site_nav_source)
        self.assertIn('"/profile.html"', self.site_nav_source)
        self.assertIn('"/admin-profile.html"', self.site_nav_source)
        self.assertIn('data-site-copy="personalProfile"', self.site_nav_source)
        self.assertNotIn('page === "console" ? "" : " hidden"', self.site_nav_source)
        self.assertNotIn(
            'header.dataset.sitePage !== "console"',
            self.site_nav_source,
        )
        self.assertIn("function installUnifiedAccountMenu", self.site_nav_source)
        self.assertNotIn(".profile-page .site-account-popover", self.profile_styles)
        self.assertIn("background: #ffffff", self.site_nav_styles)
        self.assertIn(".site-account-popover > * {", self.site_nav_styles)
        self.assertIn("data-site-account-signature", self.site_nav_source)
        self.assertIn('data-site-copy="profileSignatureEmpty"', self.site_nav_source)
        self.assertIn('data-site-copy="profileTagsEmpty"', self.site_nav_source)
        self.assertIn(".site-account-profile-field", self.site_nav_styles)
        self.assertIn("async function loadAccountBilling", self.site_nav_source)
        self.assertIn('fetchAccountJson("/api/billing/summary")', self.site_nav_source)
        self.assertIn('fetchAccountJson("/api/billing/orders?limit=1")', self.site_nav_source)
        self.assertIn("function syncConsoleEntryTargets", self.site_nav_source)
        self.assertIn('link.setAttribute("href", target)', self.site_nav_source)

        self.assertIn('id="profileAvatarButton"', self.profile_markup)
        self.assertIn('id="profileAvatarFile"', self.profile_markup)
        self.assertIn(" hidden", self.profile_markup)
        self.assertIn('<svg viewBox="0 0 24 24"', self.profile_markup)
        self.assertIn('<path d="M12 5v14M5 12h14"', self.profile_markup)
        self.assertNotIn("选择文件", self.profile_markup)
        self.assertIn("/assets/profile.css?v=__PROFILE_CSS_VERSION__", self.profile_markup)
        self.assertIn("/assets/profile.js?v=__PROFILE_JS_VERSION__", self.profile_markup)

        self.assertIn("color-scheme: light", self.profile_styles)
        self.assertIn("body.profile-page", self.profile_styles)
        self.assertIn("@media (max-width: 720px)", self.profile_styles)
        self.assertIn('$("profileAvatarFile")?.click()', self.profile_source)
        self.assertIn("const AVATAR_MAX_BYTES = 512 * 1024", self.profile_source)
        self.assertIn("file.size > AVATAR_MAX_BYTES", self.profile_source)
        self.assertIn('api("/api/me/profile"', self.profile_source)
        self.assertIn('error?.code === "mfa_setup_required"', self.profile_source)
        self.assertIn('"/admin#account"', self.profile_source)
        self.assertIn("/change-password.html?admin_console=1&return_url=", self.profile_source)
        self.assertIn('return_manage_user_id', self.profile_source)
        self.assertIn('?manage_user_id=', self.profile_source)
        self.assertIn('params.set("return_manage_user_id", workspaceUserId)', self.site_nav_source)

    def test_persona_image_panel_removes_only_reference_image_controls(self):
        for marker in (
            "data-persona-upload-image-file",
            "data-persona-upload-image-trigger",
            "data-persona-upload-image-dropzone",
            "uploadPersonaReferenceImage",
            "/images/upload",
            "建议优先使用三视图",
            "persona-image-upload-placeholder",
            "persona-image-library-card--empty",
        ):
            self.assertIn(marker, self.source + self.styles)
        panel_start = self.source.index("function renderPersonaImagePanel(persona")
        panel_end = self.source.index("\nfunction renderPersonaLinkSettingsContent", panel_start)
        panel = self.source[panel_start:panel_end]
        self.assertIn("data-persona-generate-image", panel)
        self.assertIn("renderPersonaImageLibraryGrid", panel)
        self.assertIn(".persona-image-library-card.is-selected::after", self.styles)
        self.assertIn("animation: persona-image-selection-sweep", self.styles)
        self.assertNotIn("data-persona-reference-image-toggle", self.source)
        self.assertNotIn("data-media-lightbox-add-reference", self.source)

    def test_mobile_workspace_controls_keep_distinct_icons_and_stable_layout(self):
        self.assertIn('<svg class="mobile-nav-toggle-icon"', self.markup)
        self.assertIn('<rect x="3" y="3" width="18" height="18" rx="2"></rect>', self.markup)
        self.assertIn('<path d="M9 3v18"></path>', self.markup)
        self.assertNotIn('<rect x="4" y="4" width="6" height="6" rx="1"></rect>', self.markup)
        self.assertNotIn('.mobile-nav-toggle[aria-expanded="true"] .mobile-nav-toggle-icon', self.styles)
        self.assertIn("const consoleLayoutLockStates = new WeakMap();", self.source)
        self.assertIn("activeLock?.previous ?? node.style.minHeight", self.source)
        self.assertIn("activeLock.token !== token", self.source)
        self.assertIn("persona-compose-mode-slot", self.source)
        self.assertIn(".persona-compose-mode-slot.is-reserved", self.styles)
        self.assertIn("persona-panel-intro--reserved", self.source)
        self.assertIn(".persona-panel-intro--reserved", self.styles)
        self.assertIn(".persona-settings-modal .row-actions button", self.styles)

    def test_console_account_menu_uses_current_identity_and_supports_logout(self):
        for marker in (
            'data-site-account-menu',
            'data-site-account-trigger',
            'data-site-account-popover',
            'data-site-account-close',
            'data-site-account-logout',
        ):
            self.assertIn(marker, self.markup)
            self.assertIn(marker, self.site_nav_source)
        self.assertIn('data-site-language-toggle', self.site_nav_source)
        self.assertIn('function installLanguageControls(header)', self.site_nav_source)
        self.assertNotIn('data-site-theme-toggle', self.markup)
        self.assertNotIn('data-site-theme-toggle', self.site_nav_source)
        self.assertIn("function setAccount(account)", self.site_nav_source)
        self.assertIn('event.key !== "Escape"', self.site_nav_source)
        self.assertIn('const EVENT_LOGOUT = "vecto:logout-request"', self.site_nav_source)
        self.assertIn("window.dispatchEvent(new CustomEvent(EVENT_LOGOUT))", self.site_nav_source)
        self.assertIn("window.VectoSiteNavigation?.setAccount(me)", self.source)
        self.assertIn('window.addEventListener("vecto:navigation-ready"', self.source)
        self.assertIn('window.dispatchEvent(new CustomEvent("vecto:navigation-ready"))', self.site_nav_source)
        self.assertIn('window.addEventListener("vecto:logout-request"', self.source)
        self.assertIn('await api("/api/auth/logout", { method: "POST" })', self.source)
        self.assertIn("clearTenantInMemoryState()", self.source)
        self.assertIn("purgeLegacyTenantContentCaches()", self.source)
        self.assertNotIn('class="site-account-preferences"', self.markup)
        self.assertNotIn('data-site-personal-controls', self.markup)
        self.assertNotIn('function accountPreferencesMarkup(page = "console")', self.site_nav_source)
        self.assertIn('data-site-account-billing', self.markup)
        self.assertIn('data-site-open-billing', self.markup)
        self.assertIn('data-site-open-settings', self.markup)
        self.assertIn('data-site-open-console-view="tasks"', self.site_nav_source)
        self.assertIn('data-site-open-console-view="console_settings"', self.site_nav_source)
        self.assertIn('const EVENT_CONSOLE_VIEW_REQUEST = "vecto:account-console-view-request"', self.site_nav_source)
        self.assertIn('window.addEventListener("vecto:account-console-view-request"', self.source)
        self.assertIn('EVENT_ACCOUNT_MENU_OPEN', self.site_nav_source)
        self.assertIn('pointerenter', self.site_nav_source)
        self.assertIn('if (event.target === trigger) return;', self.site_nav_source)
        self.assertIn('setAccountMenuOpen(menu, false, { restoreFocus: true });', self.site_nav_source)
        self.assertIn('classList.toggle("site-account-menu-open", true)', self.site_nav_source)
        self.assertIn("const accountPanelCloseTimers = new WeakMap();", self.site_nav_source)
        self.assertIn("window.requestAnimationFrame", self.site_nav_source)
        self.assertIn('event.propertyName !== "transform"', self.site_nav_source)
        self.assertIn("popover.hidden = true", self.site_nav_source)
        self.assertIn('document.body.classList.toggle("site-account-panel-active"', self.site_nav_source)
        self.assertIn('.site-header.site-account-menu-open {', self.site_nav_styles)
        self.assertIn('z-index: 5000;', self.site_nav_styles)
        self.assertIn('inset: 0;', self.site_nav_styles)
        self.assertIn('width: 100vw;', self.site_nav_styles)
        self.assertIn('height: 100dvh;', self.site_nav_styles)
        self.assertIn('transform: translate3d(100%, 0, 0);', self.site_nav_styles)
        self.assertIn('.site-account-menu.is-open .site-account-popover {', self.site_nav_styles)
        self.assertIn('body.site-account-panel-active {', self.site_nav_styles)
        self.assertIn('class="site-account-id-line"', self.site_nav_source)
        self.assertIn('class="site-account-footer"', self.site_nav_source)
        self.assertIn('margin-top: auto;', self.site_nav_styles)
        self.assertIn('.site-account-close svg {', self.site_nav_styles)
        self.assertIn('border-radius: 50%', self.site_nav_styles)
        self.assertIn('max-height: none;', self.site_nav_styles)
        self.assertIn('.site-header .site-mobile-menu,', self.site_nav_styles)
        self.assertIn('.site-header .site-account-menu {', self.site_nav_styles)
        self.assertIn('.site-header .site-menu-toggle span {', self.site_nav_styles)
        self.assertIn('grid-template-columns: 18px;', self.site_nav_styles)
        self.assertIn('width: fit-content;', self.site_nav_styles)
        self.assertIn('href="/" aria-label="Vecto 首页" data-site-home-label', self.markup)
        self.assertIn('.site-header .site-header-branding {', self.site_nav_styles)
        self.assertIn('min-width: max-content;', self.site_nav_styles)
        self.assertIn('.site-header .brand-logo {\n    width: 30px;\n    height: 30px;', self.site_nav_styles)

    def test_console_actions_and_busy_button_borders_remain_static(self):
        self.assertIn("--vecto-action-static-gradient", self.styles)
        self.assertNotIn("--vecto-action-sheen-gradient", self.styles)
        self.assertIn("--vecto-action-running-gradient", self.styles)
        self.assertNotIn("@keyframes vecto-action-running-border-sweep", self.styles)
        self.assertIn('button[aria-busy="true"]', self.styles)
        self.assertIn("background-repeat: no-repeat", self.styles)
        self.assertIn("background-size: 100% 100%", self.styles)
        self.assertNotIn("@keyframes vecto-action-click-sheen", self.styles)
        self.assertNotIn("animation: vecto-action-click-sheen", self.styles)
        self.assertIn("border: 1px solid var(--vecto-action-border)", self.styles)
        self.assertIn(':disabled:not([aria-busy="true"])', self.styles)
        self.assertIn('--vecto-action-border: #4f817a;', self.styles)
        self.assertNotIn("#43e4c7 50%", self.styles)
        self.assertIn("button:has(> .task-button-busy)", self.styles)
        self.assertIn("animation: none !important", self.styles)
        self.assertNotIn("vecto-publish-button-sheen", self.styles)
        active_rule = self.styles.split(
            ".console-page .shared-underline-tabs > button.is-active,", 1
        )[1].split("::after", 1)[0]
        self.assertIn("transparent", active_rule)
        self.assertIn("#243b53", active_rule)
        self.assertIn("box-shadow: none", active_rule)
        self.assertIn("animation: none", active_rule)
        self.assertIn('aria-busy="${busy ? "true" : "false"}"', self.source)
        for marker in (
            'id="executeSimpleFlow"',
            "data-automation-plan-submit aria-busy=",
            "data-browser-recommendation-refresh aria-busy=",
            "data-persona-create-ai-keywords aria-busy=",
            "data-persona-create-ai-submit aria-busy=",
            "data-persona-create aria-busy=",
            "data-persona-run-media-task data-persona-media-action=",
        ):
            self.assertIn(marker, self.source)
        self.assertIn('trigger.setAttribute("aria-busy", "true")', self.source)
        self.assertNotIn("state.simpleFlowPendingStartedAt = Date.now();\n    renderSimpleFlowModule(moduleId);", self.source)
        self.assertIn('state.simpleFlowPendingModule === moduleId', self.source)
        self.assertIn('state.simpleFlowPendingModule = moduleId', self.source)
        self.assertIn('state.simpleFlowPendingModule = ""', self.source)
        self.assertIn('if (!isPersonaWorkspaceModule(state.activeModule)) renderSimpleFlowModule(state.activeModule);', self.source)

    def test_public_console_modals_reuse_the_shared_page_button_component(self):
        self.assertIn(".console-modal-actions button,", self.styles)
        self.assertIn(
            ".console-page :is(.console-shell, .console-modal) :is(",
            self.styles,
        )
        self.assertIn(
            ".row-actions button.danger,\n.console-modal-actions button.danger",
            self.styles,
        )
        self.assertNotIn(
            ".console-page .console-modal-actions button.primary:not(.danger)",
            self.styles,
        )
        self.assertNotIn(".console-modal-actions .danger {", self.styles)

    def test_social_task_snapshots_files_before_busy_rerender(self):
        task_source = self.source.split("async function createSocialTask(", 1)[1].split("async function ", 1)[0]
        snapshot_index = task_source.index('const mediaFiles = [')
        rerender_index = task_source.index('renderSimpleFlowModule(state.activeModule)')
        upload_index = task_source.index('uploadAutomationMedia(mediaFiles, messageId)')

        self.assertLess(snapshot_index, rerender_index)
        self.assertLess(rerender_index, upload_index)
        self.assertIn('const targetUrls = $("simpleTargetUrls")?.value', task_source)
        self.assertNotIn("simpleScheduleAt", task_source)
        self.assertIn('target_urls: splitLines(targetUrls)', task_source)

    def test_open_login_task_opens_the_live_browser_view_after_creation(self):
        task_source = self.source.split("async function createSocialTask(", 1)[1].split("async function ", 1)[0]
        self.assertIn(
            'if (taskType === "open_login") openLiveBrowserTaskView(String(result.task?.id || ""));',
            task_source,
        )

    def test_open_login_account_actions_preserve_running_task_navigation(self):
        actions = self._section("function renderAccountPoolCardActions", "function renderAccountPoolCard(")
        create_task = self._javascript_function_source(self.source, "createSocialTask")

        self.assertIn("activeOpenLoginTaskForAccount(accountId)", actions)
        self.assertIn('data-open-login-task-id="${esc(activeLoginTask.id)}"', actions)
        self.assertIn('renderBusyButtonContent("执行中"', actions)
        self.assertIn('class="primary" ${attribute}="${esc(accountId)}">打开登录</button>', actions)
        self.assertNotIn("请先绑定人设后再打开登录", actions)
        self.assertNotIn("请先绑定人设后再打开登录", create_task)
        self.assertGreaterEqual(self.source.count("openLiveBrowserTaskView(activeTask.id)"), 3)

    def test_open_login_browser_exit_refreshes_the_terminal_task_state(self):
        refresh_source = self._javascript_function_source(self.source, "refreshLiveBrowserSessionsSoon")
        self.assertIn("await refreshSocialTaskState(targetTaskId)", refresh_source)
        self.assertIn("if (targetTaskId && !matched && observedTarget)", refresh_source)
        self.assertIn("if (!taskFinished && attempt < attempts)", refresh_source)

    def test_missing_edited_draft_is_recreated_with_current_text_and_media(self):
        create_source = self._javascript_function_source(self.source, "createPersonaDraftPost")
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const requests = [];
            const messages = [];
            const draft = {{
              title: "重新编辑的标题",
              content: "重新编辑的正文",
              editingPostId: "published-draft-1",
              editingSource: "posts",
              originalMediaSignature: JSON.stringify([
                {{ url: "uploads/users/7/old-a.png", type: "image", label: "旧图 A" }},
                {{ url: "uploads/users/7/old-b.png", type: "image", label: "旧图 B" }},
              ]),
              mediaItems: [
                {{ url: "blob:replacement", pending: true }},
                {{ url: "uploads/users/7/old-b.png" }},
                {{ url: "blob:new", pending: true }},
              ],
              mediaOps: [
                {{ type: "replace", index: 0, files: [{{ name: "replacement.png" }}] }},
                {{ type: "append", files: [{{ name: "new.png" }}] }},
              ],
            }};
            const formState = {{ draft, generate: {{ composeMode: "tweet" }} }};
            const state = {{ personaPanels: {{}}, personaDraftPosts: {{}}, personaFavoritePosts: {{}} }};
            function selectedPersona() {{ return {{ id: "persona-1" }}; }}
            function snapshotPersonaCurrentForm() {{}}
            function personaFormState() {{ return formState; }}
            function captureUploadDropzoneState() {{ return {{ files: [], stateKey: "upload-state" }}; }}
            function personaContentPlatform() {{ return "threads"; }}
            async function uploadAutomationMedia() {{ return []; }}
            async function preparePersonaDraftMediaOps() {{
              return [
                {{ type: "replace", index: 0, media_paths: ["uploads/users/7/replacement.png"] }},
                {{ type: "append", index: -1, media_paths: ["uploads/users/7/new.png"] }},
              ];
            }}
            async function loadPersonaDraftPosts() {{ return []; }}
            async function loadPersonaFavoritePosts() {{ return []; }}
            async function api(path, options) {{
              requests.push({{ path, options, body: JSON.parse(options.body) }});
              if (path.endsWith("/published-draft-1")) {{
                throw {{ status: 404, detail: "post not found" }};
              }}
              return {{ id: "replacement-draft-2", title: "重新编辑的标题" }};
            }}
            function showMsg(_id, message) {{ messages.push(message); }}
            function clearUploadDropzoneState() {{}}
            function setSelectedPersonaPostId() {{}}
            function setPersonaPostSource() {{}}
            function clearPersonaDraftComposerInputs() {{}}
            function renderPersonaDetail() {{}}
            function renderConfirmSummary() {{}}
            async {create_source}
            (async () => {{
              await createPersonaDraftPost();
              assert.equal(requests.length, 2);
              assert.equal(requests[0].path, "/api/persona_dashboard/personas/persona-1/posts/published-draft-1");
              assert.equal(requests[0].options.method, "PATCH");
              assert.equal(requests[1].path, "/api/persona_dashboard/personas/persona-1/posts");
              assert.equal(requests[1].options.method, "POST");
              assert.deepEqual(requests[1].body.media_paths, [
                "uploads/users/7/replacement.png",
                "uploads/users/7/old-b.png",
                "uploads/users/7/new.png",
              ]);
              assert.deepEqual(requests[1].body.media_ops, []);
              assert.ok(messages.some((message) => message.includes("另存为新草稿")));
            }})().catch((error) => {{ console.error(error); process.exit(1); }});
            """
        )
        self._run_node(harness)

    def test_draft_media_edits_only_notify_after_the_final_save(self):
        queue_source = self._javascript_function_source(self.source, "queuePersonaDraftMediaChange")
        bulk_delete_source = self._javascript_function_source(self.source, "deleteSelectedPersonaPostMedia")
        for intermediate_message in (
            "已临时追加",
            "已临时替换",
            "已临时删除",
            "媒体顺序已调整",
        ):
            self.assertNotIn(intermediate_message, queue_source)
            self.assertNotIn(intermediate_message, bulk_delete_source)

    def test_console_header_boundary_has_no_drop_shadow(self):
        start = self.site_nav_styles.index('.site-header.is-scrolled,')
        end = self.site_nav_styles.index('}', start)
        solid_header = self.site_nav_styles[start:end]
        self.assertIn("box-shadow: none", solid_header)

    def _section(self, start_marker, end_marker):
        start = self.source.index(start_marker)
        end = self.source.index(end_marker, start)
        return self.source[start:end]

    def _javascript_function_source(self, source, name):
        marker = f"function {name}("
        start = source.index(marker)
        brace = source.index("{", start)
        depth = 0
        quote = None
        escaped = False
        line_comment = False
        block_comment = False
        index = brace
        while index < len(source):
            char = source[index]
            next_char = source[index + 1] if index + 1 < len(source) else ""
            if line_comment:
                if char == "\n":
                    line_comment = False
            elif block_comment:
                if char == "*" and next_char == "/":
                    block_comment = False
                    index += 1
            elif quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in {'"', "'", "`"}:
                quote = char
            elif char == "/" and next_char == "/":
                line_comment = True
                index += 1
            elif char == "/" and next_char == "*":
                block_comment = True
                index += 1
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return source[start:index + 1]
            index += 1
        self.fail(f"Could not extract JavaScript function {name}")

    def _function_source(self, name):
        return self._javascript_function_source(self.source, name)

    def _persona_dashboard_function_source(self, name):
        return self._javascript_function_source(self.persona_dashboard_source, name)

    def _css_block(self, marker, start=0):
        block_start = self.styles.index(marker, start)
        brace = self.styles.index("{", block_start)
        depth = 0
        for index in range(brace, len(self.styles)):
            if self.styles[index] == "{":
                depth += 1
            elif self.styles[index] == "}":
                depth -= 1
                if depth == 0:
                    return self.styles[block_start:index + 1]
        self.fail(f"Could not extract CSS block {marker}")

    def _run_node(self, script):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        with tempfile.TemporaryDirectory() as tmpdir:
            harness = Path(tmpdir) / "session-boundary-test.js"
            harness.write_text(script, encoding="utf-8")
            result = subprocess.run(
                [node, str(harness)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_init_validates_me_before_bootstrap_or_tenant_loads(self):
        init = self._section("async function init()", "\ninit().catch")
        me_index = init.index("const me = await loadMe()")
        self.assertLess(me_index, init.index("hydratePersonaOverviewFromBootstrap(me)"))
        self.assertLess(me_index, init.index("bindEvents()"))
        self.assertLess(me_index, init.index("setView(state.view)"))
        self.assertLess(me_index, init.index("loadTasks()"))
        self.assertLess(me_index, init.index("loadSocial("))
        self.assertNotIn("hydratePersonaOverviewFromCache", init)
        self.assertNotIn("hydrateSocialAccountsFromCache", init)

    def test_persona_media_task_elapsed_time_keeps_the_submitted_start(self):
        functions = "\n".join(
            self._function_source(name)
            for name in (
                "toastTimestampMs",
                "actionLockKey",
                "actionLockStartedAt",
                "actionTaskStartedAt",
                "personaMediaTaskKey",
                "personaMediaTaskState",
                "personaMediaTaskStartedAt",
            )
        )
        self._run_node(textwrap.dedent(f"""
            const state = {{ actionLocks: {{}}, personaMediaTasks: {{}} }};
            {functions}
            state.personaMediaTasks[personaMediaTaskKey("persona-1", "post-1")] = {{
              taskType: "persona_post_image",
              status: "queued",
              startedAt: 1722477600000,
              detail: {{ status: "queued", type: "persona_post_image" }},
            }};
            const first = personaMediaTaskStartedAt("persona-1", "post-1", "persona_post_image");
            Date.now = () => 1722477609000;
            const second = personaMediaTaskStartedAt("persona-1", "post-1", "persona_post_image");
            if (first !== 1722477600000 || second !== first) {{
              throw new Error(`unstable media timer: ${{first}} -> ${{second}}`);
            }}
        """))

    def test_persona_generation_request_does_not_depend_on_animation_frame(self):
        generation = self._function_source("generatePersonaDraftPosts")

        self.assertNotIn("requestAnimationFrame", generation)
        self.assertLess(generation.index("setActionLocked(lockParts, true)"), generation.index("await api("))

    def test_persona_candidate_conflict_discards_stale_task_and_refreshes_drafts(self):
        resolver = f"async {self._function_source('resolvePersonaOrdinaryGeneratedCandidates')}"
        self._run_node(textwrap.dedent(f"""
            const assert = require("node:assert/strict");
            const state = {{ personaGeneratedPreviews: {{ "persona-1:tweet": {{ visible: true }} }}, personaPanels: {{ content: "generate" }} }};
            const form = {{ draft: {{ content: "stale" }}, media: {{ focusPostId: "candidate-1" }} }};
            const calls = {{ cleared: [], deletedPreviews: [], refreshed: [], source: [], selected: [], messages: [], summary: 0 }};
            let apiError = {{ status: 409, detail: "candidate conflict" }};
            async function openPersonaGeneratedSelectionModal() {{ return {{ action: "save", postId: "candidate-1" }}; }}
            async function api() {{ throw apiError; }}
            function clearStoredPersonaPostGenerationTask(personaId, taskId) {{ calls.cleared.push([personaId, taskId]); }}
            function clearPersonaGenerateRunState() {{}}
            function deletePersonaGeneratedPreview(personaId, composeMode) {{
              calls.deletedPreviews.push([personaId, composeMode]);
              delete state.personaGeneratedPreviews[`${{personaId}}:${{composeMode}}`];
            }}
            function personaFormState() {{ return form; }}
            function defaultPersonaDraftForm() {{ return {{}}; }}
            async function loadPersonaDraftPosts(personaId, options) {{ calls.refreshed.push([personaId, options]); }}
            function setPersonaPostSource(source, persona) {{ calls.source.push([source, persona.id]); }}
            function personaDraftPosts() {{ return [{{ id: "safe-draft" }}]; }}
            function setSelectedPersonaPostId(postId) {{ calls.selected.push(postId); }}
            function showMsg(key, message, success) {{ calls.messages.push([key, message, success]); }}
            function renderConfirmSummary() {{ calls.summary += 1; }}
            {resolver}

            (async () => {{
              const persona = {{ id: "persona-1" }};
              const result = await resolvePersonaOrdinaryGeneratedCandidates(
                persona,
                "task-1",
                [{{ id: "candidate-1" }}],
              );
              assert.deepEqual(result, {{ action: "conflict", postId: "" }});
              assert.deepEqual(calls.cleared, [["persona-1", "task-1"]]);
              assert.deepEqual(calls.refreshed, [["persona-1", {{ force: true }}]]);
              assert.deepEqual(calls.source, [["posts", "persona-1"]]);
              assert.deepEqual(calls.selected, ["safe-draft"]);
              assert.equal(state.personaPanels.content, "posts");
              assert.deepEqual(calls.deletedPreviews, [["persona-1", "tweet"]]);
              assert.equal(state.personaGeneratedPreviews["persona-1:tweet"], undefined);
              assert.equal(form.media.focusPostId, "");
              assert.match(calls.messages[0][1], /已刷新草稿库/);
              assert.equal(calls.messages[0][2], false);
              assert.equal(calls.summary, 1);

              apiError = {{ status: 503, detail: "temporary outage" }};
              await assert.rejects(
                resolvePersonaOrdinaryGeneratedCandidates(persona, "task-2", [{{ id: "candidate-1" }}]),
                (error) => error.status === 503 && error.personaCandidateResolutionPending === true,
              );
              assert.deepEqual(calls.cleared, [["persona-1", "task-1"]]);
            }})().catch((error) => {{ console.error(error); process.exitCode = 1; }});
        """))

    def test_generation_busy_indicator_is_scoped_to_the_mode_that_started_it(self):
        panel = self._section(
            "function renderPersonaContentPanel",
            "\nasync function loadTasks",
        )

        self.assertIn(
            'const activeGenerateComposeMode = String(personaGenerateRunState(persona.id)?.composeMode || composeMode);',
            panel,
        )
        self.assertIn(
            "const generateBusy = generationLocked && activeGenerateComposeMode === composeMode;",
            panel,
        )

    def test_generated_media_requires_an_explicit_selected_output_attach(self):
        submit = self._function_source("submitPersonaMediaTask")
        refresh = self._function_source("refreshPersonaMediaTask")
        attach = self._function_source("attachPersonaTaskMediaToPost")

        self.assertNotIn("attachPersonaTaskMediaToPost", submit)
        self.assertNotIn("attachPersonaTaskMediaToPost", refresh)
        self.assertIn("selectedPersonaTaskMediaKeys", attach)
        self.assertIn("const selectedItems = taskItems.filter", attach)
        self.assertIn('media_indexes: [Number(item.sourceIndex)]', attach)
        self.assertIn('/media/from_task', attach)

    def test_persona_media_submit_enters_busy_state_before_first_async_wait(self):
        submission = self._function_source("submitPersonaMediaTask")
        first_await = submission.index("await ")

        self.assertLess(submission.index("setActionLocked(lockParts, true"), first_await)
        self.assertLess(submission.index('submitButton.setAttribute("aria-busy", "true")'), first_await)
        self.assertLess(submission.index("renderBusyButtonContent("), first_await)

    def test_persona_platform_switch_is_blocked_while_generation_runs(self):
        source = self._function_source("confirmPersonaContentPlatformSwitch")
        self._run_node(textwrap.dedent(f"""
            const assert = require("node:assert/strict");
            let modalCalls = 0;
            function personaContentPlatform() {{ return "threads"; }}
            function normalizePersonaContentPlatform() {{ return "instagram"; }}
            function isActionLocked(...parts) {{
              return parts.join(":") === "persona:persona-1:generate_posts";
            }}
            function activePersonaDraftComposerTransientState() {{ return null; }}
            async function openConsoleModal() {{ modalCalls += 1; return true; }}
            const accountPoolPlatforms = [["threads", "Threads"], ["instagram", "Instagram"]];
            {source}

            (async () => {{
              const allowed = await confirmPersonaContentPlatformSwitch({{ id: "persona-1" }}, "instagram");
              assert.equal(allowed, false);
              assert.equal(modalCalls, 0);
            }})().catch((error) => {{ console.error(error); process.exitCode = 1; }});
        """))

    def test_persona_generation_lock_covers_conflicting_navigation_and_task_actions(self):
        selector = self._function_source("personaPostGenerationConflictSelector")
        sync = self._function_source("syncPersonaPostGenerationInteractionLock")
        panel = self._section(
            "function renderPersonaContentPanel",
            "\nasync function loadTasks",
        )

        for token in (
            "[data-persona-compose-mode]",
            "[data-persona-content-tab]",
            "[data-persona-route-step]",
            "[data-persona-create-post]",
            "[data-persona-open-publishing]",
            "[data-persona-run-automation]",
            "[data-persona-run-media-task]",
        ):
            self.assertIn(token, selector)
        self.assertIn("data-persona-generation-locked", sync)
        self.assertIn("button.disabled = true", sync)
        self.assertIn("renderPersonaGenerateComposeTabs(composeMode, {", panel)
        self.assertIn("disabled: generationControlsLocked", panel)

    def test_persona_generation_lock_has_event_guards_before_navigation_mutation(self):
        navigation = self._section(
            "const handleWorkspaceModuleNavigation = async (event) => {",
            '\n  $("moduleMenu").addEventListener',
        )
        module_clicks = self._section(
            '$("moduleBody").addEventListener("click", async (event) => {',
            '\n  $("moduleBody").addEventListener("change"',
        )

        self.assertIn("guardPersonaPostGenerationInteraction(event.target)", navigation)
        self.assertLess(
            navigation.index("guardPersonaPostGenerationInteraction(event.target)"),
            navigation.index("setView(nextView)"),
        )
        self.assertIn("guardPersonaPostGenerationInteraction(event.target)", module_clicks)
        self.assertLess(
            module_clicks.index("guardPersonaPostGenerationInteraction(event.target)"),
            module_clicks.index("form.generate.composeMode = nextComposeMode"),
        )

    def test_persona_media_prompt_clear_updates_saved_state_and_visible_input(self):
        clear_prompt = self._function_source("clearPersonaMediaPrompt")
        self._run_node(textwrap.dedent(f"""
            const assert = require("node:assert/strict");
            const promptInput = {{ value: "旧配图提示词" }};
            const form = {{ media: {{ prompt: "旧配图提示词" }} }};
            const state = {{ renderedPersonaId: "persona-1" }};
            function personaFormState(personaId) {{
              assert.equal(personaId, "persona-1");
              return form;
            }}
            function $(id) {{
              return id === "personaMediaTaskPrompt" ? promptInput : null;
            }}
            {clear_prompt}

            clearPersonaMediaPrompt("persona-1");
            assert.equal(form.media.prompt, "");
            assert.equal(promptInput.value, "");
        """))

    def test_persona_media_polling_has_no_hard_timeout_and_reaches_server_terminal_state(self):
        source = self._section(
            "async function watchPersonaMediaTask",
            "\nasync function submitPersonaMediaTask",
        )
        self._run_node(textwrap.dedent(f"""
            const assert = require("node:assert/strict");
            let tenantStateGeneration = 1;
            let refreshCount = 0;
            let loadTaskCalls = 0;
            const state = {{
              personaMediaTaskWatchers: {{}},
              personaMediaTasks: {{
                "persona-1:post-1": {{
                  taskId: "task-1",
                  taskType: "persona_post_image",
                  status: "queued",
                  detail: {{ status: "queued" }},
                }},
              }},
            }};
            function personaMediaTaskKey() {{ return "persona-1:post-1"; }}
            async function refreshPersonaMediaTask() {{
              refreshCount += 1;
              return {{ status: refreshCount > 500 ? "success" : "queued" }};
            }}
            async function loadTasks() {{ loadTaskCalls += 1; }}
            async function sleep() {{}}
            {source}

            (async () => {{
              await watchPersonaMediaTask("persona-1", "post-1", "task-1");
              assert.equal(refreshCount, 501);
              assert.equal(loadTaskCalls, 1);
            }})().catch((error) => {{ console.error(error); process.exitCode = 1; }});
        """))

    def test_result_links_reject_unsafe_protocols_and_preserve_admin_context(self):
        console_link_source = self._function_source("adminWorkspacePageUrl")
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const location = {{ origin: "https://vecto.test" }};
            const window = {{ location: {{ origin: location.origin, href: `${{location.origin}}/admin-console.html` }} }};
            const ADMIN_WORKSPACE_USER_ID = "42";
            const ADMIN_CONSOLE_SESSION = true;
            {console_link_source}

            for (const unsafe of [
              "javascript:alert(1)",
              "data:text/html,owned",
              "https://user:pass@example.test/path",
            ]) {{
              assert.equal(adminWorkspacePageUrl(unsafe), "");
            }}

            assert.equal(
              adminWorkspacePageUrl("/about-vecto.html#story"),
              "/about-vecto.html?admin_console=1&admin_workspace_user_id=42#story",
            );
            assert.equal(
              adminWorkspacePageUrl("https://docs.example.test/result"),
              "https://docs.example.test/result",
            );
            """
        )
        self._run_node(harness)

    def test_public_navigation_decorates_every_admin_operational_destination(self):
        target_source = self._javascript_function_source(
            self.site_nav_source,
            "adminOperationalPublicTarget",
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const window = {{ location: {{ origin: "https://vecto.test" }} }};
            const document = {{ querySelector() {{ return null; }} }};
            const currentSessionMode = "admin";
            function hasAdminConsoleContext() {{ return true; }}
            function storedAdminWorkspaceUserId() {{ return "42"; }}
            {target_source}

            const expected = new Map([
              ["/", "/?admin_console=1&admin_workspace_user_id=42"],
              ["/#solution", "/?admin_console=1&admin_workspace_user_id=42#solution"],
              ["/about-vecto.html", "/about-vecto.html?admin_console=1&admin_workspace_user_id=42"],
              ["/subscription.html", "/subscription.html?admin_console=1&admin_workspace_user_id=42"],
              ["/pricing.html", "/pricing.html?admin_console=1&admin_workspace_user_id=42"],
            ]);
            for (const [source, destination] of expected) {{
              assert.equal(adminOperationalPublicTarget(source), destination);
            }}
            assert.equal(
              adminOperationalPublicTarget("/profile.html?manage_user_id=99"),
              "/profile.html?admin_console=1",
            );
            """
        )
        self._run_node(harness)

    def test_bootstrap_requires_matching_server_user_id(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ currentUser: null }};
            const window = {{ __CONSOLE_BOOTSTRAP__: {{ user_id: "11", personas: [{{ id: "p1" }}] }} }};
            let applied = 0;
            function applyPersonaOverviewData() {{ applied += 1; }}
            {self._function_source("consoleUserId")}
            {self._function_source("consoleBootstrapUserId")}
            {self._function_source("discardConsoleBootstrap")}
            {self._function_source("hydratePersonaOverviewFromBootstrap")}

            assert.strictEqual(hydratePersonaOverviewFromBootstrap({{ id: 12 }}), false);
            assert.strictEqual(applied, 0);
            assert.strictEqual(window.__CONSOLE_BOOTSTRAP__, null);

            window.__CONSOLE_BOOTSTRAP__ = {{ user_id: 11, personas: [{{ id: "p2" }}] }};
            assert.strictEqual(hydratePersonaOverviewFromBootstrap({{ id: "11" }}), true);
            assert.strictEqual(applied, 1);
            assert.strictEqual(window.__CONSOLE_BOOTSTRAP__, null);
            """
        )
        self._run_node(harness)

    def test_auth_boundaries_redirect_but_customer_403_does_not(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            let consoleBoundaryNavigationActive = false;
            let cleared = 0;
            let target = "";
            const window = {{ location: {{ pathname: "/console.html", search: "", hash: "", replace(value) {{ target = value; }} }} }};
            function clearTenantInMemoryState() {{ cleared += 1; }}
            {self._function_source("handleSessionBoundary")}

            assert.strictEqual(handleSessionBoundary(403), false);
            assert.strictEqual(cleared, 0);
            assert.strictEqual(target, "");

            assert.strictEqual(handleSessionBoundary(401), true);
            assert.strictEqual(cleared, 1);
            assert.strictEqual(target, "/?login=1&return_url=%2Fconsole.html");

            consoleBoundaryNavigationActive = false;
            target = "";
            assert.strictEqual(handleSessionBoundary(428), true);
            assert.strictEqual(cleared, 2);
            assert.strictEqual(target, "/change-password.html?return_url=%2Fconsole.html");
            """
        )
        self._run_node(harness)

    def test_auth_clear_resets_tenant_collections_and_invalidates_requests(self):
        clear_state = self._function_source("clearTenantInMemoryState")
        self.assertIn("tenantStateGeneration += 1", clear_state)
        self.assertIn("state.events.close?.()", clear_state)
        self.assertIn("state.personaCreateKeywordController.abort?", clear_state)
        for assignment in (
            "state.tasks = []",
            "state.personas = []",
            "state.socialAccounts = []",
            "state.socialProxies = []",
            "state.socialTasks = []",
            "state.socialBrowserSessions = []",
            "state.personaDraftPosts = {}",
            "state.personaForms = {}",
            "state.accountPasswordValues = {}",
        ):
            self.assertIn(assignment, clear_state)

        api = self._section("async function api(", "async function apiWithTimeout(")
        self.assertIn("handleSessionBoundary(response.status)", api)
        self.assertIn("requestGeneration !== tenantStateGeneration", api)

        social_loader = self._section("async function loadAutomationTasksShared(", "async function activateCreatedPersona(")
        self.assertIn("tenantArrayFallback(error, state.socialTasks)", social_loader)
        fallback = self._function_source("tenantArrayFallback")
        self.assertIn("[401, 428]", fallback)
        self.assertNotIn("403", fallback)

    def test_unfinished_manual_tasks_keep_status_refresh_active(self):
        active_task = self._function_source("activeSocialAutomationTask")
        refresh_check = self._function_source("hasActiveSocialTaskToast")

        self.assertIn('status === "need_manual" && isUnfinishedTask(task)', active_task)
        self.assertIn("activeSocialAutomationTask(task)", refresh_check)
        self.assertNotIn('["queued", "running"].includes', refresh_check)

    def test_status_refresh_does_not_replace_the_account_pool_dom(self):
        account_refresh = self._section("async function refreshSocialAccountsOnly", "function refreshLiveBrowserSessionsSoon")
        account_status = self._function_source("updateAccountStatusViews")
        task_refresh = self._function_source("syncSocialTaskToastAutoRefresh")

        self.assertIn('api("/api/persona_dashboard/automation/accounts")', account_refresh)
        self.assertIn("if (includeOverview) renderLiveBrowserSessions()", account_refresh)
        self.assertNotIn("renderSocialTasks()", account_refresh)
        self.assertNotIn("renderSocialAccounts()", account_status)
        self.assertNotIn("renderConfirmSummary()", account_status)
        self.assertEqual(account_status.count('document.querySelectorAll("[data-account-totp-for]")'), 1)
        self.assertNotIn("updateAccountTotpBadgeViews(", account_status)
        self.assertIn("accountById.get(String(node.dataset.accountTotpFor", account_status)
        self.assertIn("updateAccountTotpBadgeNode(node, account)", account_status)
        self.assertIn('document.querySelectorAll("[data-account-status-for]")', account_status)
        self.assertNotIn("data-social-check-status", account_status)
        self.assertIn('loadAutomationTasksShared().catch', task_refresh)
        self.assertNotIn("loadAutomationTasksShared({ force: true })", task_refresh)

    def test_account_card_uses_one_combined_login_status(self):
        card = self._section("function renderAccountPoolCard", "function renderAccountPoolCards")
        task_loader = self._section("async function loadAutomationTasksShared", "async function activateCreatedPersona")

        self.assertIn("accountDisplayedStatus(account)", card)
        self.assertIn("data-account-status-for", card)
        self.assertNotIn("renderAccountHealthChip", card)
        self.assertNotIn("data-account-health-for", card)
        self.assertNotIn("data-social-check-status", card)
        self.assertIn("accountStatusTitle(account)", card)
        self.assertIn("updateAccountStatusViews()", task_loader)

    def test_effective_account_status_has_deterministic_precedence(self):
        effective = self._function_source("accountEffectiveStatus")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {effective}
            assert.strictEqual(accountEffectiveStatus({{ status: "ready", health_status: "alive" }}), "ready");
            assert.strictEqual(accountEffectiveStatus({{ status: "ready", health_status: "unknown" }}), "ready_unverified");
            assert.strictEqual(accountEffectiveStatus({{ status: "ready", health_status: "abnormal" }}), "abnormal");
            assert.strictEqual(accountEffectiveStatus({{ status: "need_verification", health_status: "abnormal" }}), "risk_control");
            assert.strictEqual(accountEffectiveStatus({{ status: "need_verification", health_status: "abnormal", effective_status: "need_verification" }}), "risk_control");
            assert.strictEqual(accountEffectiveStatus({{ status: "ready", health_status: "banned" }}), "banned");
            assert.strictEqual(accountEffectiveStatus({{ status: "cookie_expired", health_status: "alive" }}), "cookie_expired");
            assert.strictEqual(accountEffectiveStatus({{ status: "disabled", health_status: "banned" }}), "disabled");
            assert.strictEqual(accountEffectiveStatus({{
              status: "ready",
              health_status: "alive",
              last_login_check_at: 10,
              health_checked_at: 10,
              status_attempted_at: 20,
              status_attempt_error: "browser launch failed"
            }}), "check_failed");
            """
        )
        self._run_node(harness)

    def test_account_and_browser_status_refresh_while_publish_is_running(self):
        account_refresh = self._function_source("syncAccountStatusAutoRefresh")
        browser_refresh = self._function_source("syncLiveBrowserAutoRefresh")
        browser_fetch = self._function_source("refreshLiveBrowserSessionsOnly")
        panel_switch = self._function_source("setAccountBrowserPanel")

        self.assertIn("}, 3000)", account_refresh)
        self.assertIn("refreshLiveBrowserSessionsOnly().catch", browser_refresh)
        self.assertIn("}, 2000)", browser_refresh)
        self.assertIn('state.accountBrowserPanel === "browsers"', self._function_source("shouldRefreshLiveBrowserSessions"))
        self.assertIn("state.liveBrowserSessionsFetch", browser_fetch)
        self.assertIn("syncLiveBrowserAutoRefresh()", panel_switch)
        self.assertIn("refreshLiveBrowserSessionsSoon(taskId, 40, 500)", self._function_source("submitPersonaPublishTask"))
        self.assertIn("refreshLiveBrowserSessionsSoon(String(task.id), 40, 500)", self._function_source("submitPublishContentTasks"))
        self.assertIn("openLiveBrowserTaskView(taskId)", self._function_source("submitPersonaPublishTask"))
        self.assertIn("openLiveBrowserTaskView(immediateTaskId)", self._function_source("executeSimpleFlow"))
        self.assertIn("openLiveBrowserTaskView(firstImmediateTaskId)", self._function_source("submitMatrixPublishTask"))

    def test_live_browser_polling_preserves_unchanged_placeholder_nodes(self):
        browser_render = self._function_source("renderLiveBrowserSessions")
        placeholder_sync = self._function_source("syncLiveBrowserPlaceholders")
        card_insert = self._function_source("insertLiveBrowserSessionCard")

        self.assertIn("syncLiveBrowserPlaceholders(grid, sessions.length)", browser_render)
        self.assertIn("insertLiveBrowserSessionCard(grid, card)", browser_render)
        self.assertNotIn('querySelectorAll("[data-live-browser-placeholder]").forEach', browser_render)
        self.assertNotIn('insertAdjacentHTML("beforeend", renderLiveBrowserPlaceholders', browser_render)
        self.assertIn('querySelectorAll("[data-live-browser-placeholder]")', placeholder_sync)
        self.assertIn("existing.slice(desiredCount).forEach", placeholder_sync)
        self.assertIn("missingCount", placeholder_sync)

        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("renderLiveBrowserPlaceholder")}
            {placeholder_sync}
            {card_insert}

            const first = {{ removed: false, remove() {{ this.removed = true; }} }};
            const second = {{ removed: false, remove() {{ this.removed = true; }} }};
            const grid = {{
              placeholders: [first],
              inserted: "",
              querySelectorAll() {{ return this.placeholders.filter((node) => !node.removed); }},
              insertAdjacentHTML(_position, markup) {{ this.inserted += markup; }},
            }};

            syncLiveBrowserPlaceholders(grid, 1);
            assert.strictEqual(first.removed, false);
            assert.strictEqual(grid.inserted, "");

            grid.placeholders.push(second);
            syncLiveBrowserPlaceholders(grid, 1);
            assert.strictEqual(first.removed, false);
            assert.strictEqual(second.removed, true);

            syncLiveBrowserPlaceholders(grid, 2);
            assert.strictEqual(first.removed, true);

            const overflowPlaceholder = {{ removed: false, remove() {{ this.removed = true; }} }};
            grid.placeholders = [overflowPlaceholder];
            syncLiveBrowserPlaceholders(grid, 3);
            assert.strictEqual(overflowPlaceholder.removed, true);

            grid.placeholders = [];
            syncLiveBrowserPlaceholders(grid, 0);
            assert.strictEqual((grid.inserted.match(/data-live-browser-placeholder/g) || []).length, 2);

            const placeholder = {{ kind: "placeholder" }};
            const card = {{ kind: "session" }};
            const orderedGrid = {{
              children: [placeholder],
              querySelector() {{ return this.children.find((node) => node.kind === "placeholder") || null; }},
              insertBefore(node, anchor) {{
                const index = anchor ? this.children.indexOf(anchor) : this.children.length;
                this.children.splice(index, 0, node);
              }},
            }};
            insertLiveBrowserSessionCard(orderedGrid, card);
            assert.deepStrictEqual(orderedGrid.children, [card, placeholder]);
            """
        )
        self._run_node(harness)

    def test_removed_live_browser_session_removes_expanded_preview_without_exit_layer(self):
        browser_render = self._function_source("renderLiveBrowserSessions")
        close_session = self._function_source("closeLiveBrowserSession")
        close_modal = self._function_source("closeLiveBrowserLargeModal")

        self.assertIn(
            "closeLiveBrowserLargeModal({ restoreFocus: false });",
            browser_render,
        )
        self.assertIn("String(state.liveBrowserExpandedSessionId || \"\") === cleanSessionId", close_session)
        self.assertIn("closeLiveBrowserLargeModal({ restoreFocus: false });", close_session)
        self.assertNotIn("is-live-browser-modal-closing", close_modal)
        self.assertNotIn("setTimeout", close_modal)

    def test_live_browser_grid_uses_container_width_and_mobile_fallback(self):
        desktop_selector = (
            '.account-browser-page[data-account-browser-page="browsers"] '
            '.live-browser-panel[data-live-browser-view="grid"] .live-browser-grid'
        )
        container_rule = self._css_block(
            '.account-browser-page[data-account-browser-page="browsers"] .live-browser-panel {'
        )
        desktop_rule = self._css_block(desktop_selector)
        wide_container_marker = "@container account-live-browser (min-width: 941px)"
        wide_container_start = self.styles.index(wide_container_marker)
        wide_container = self._css_block(wide_container_marker)
        wide_rule = self._css_block(desktop_selector, wide_container_start)
        compact_container = self._css_block("@container account-live-browser (max-width: 520px)")
        mobile_rule_start = self.styles.rindex(desktop_selector)
        mobile_media_start = self.styles.rfind("@media (max-width: 760px)", 0, mobile_rule_start)
        mobile_media = self._css_block("@media (max-width: 760px)", mobile_media_start)
        mobile_rule = self._css_block(desktop_selector, mobile_rule_start)
        mobile_controls_start = self.styles.index(
            "@media (max-width: 760px)",
            self.styles.index(".live-browser-card-actions .live-browser-mode-toggle button:not"),
        )
        mobile_controls = self._css_block("@media (max-width: 760px)", mobile_controls_start)

        self.assertIn("container: account-live-browser / inline-size;", container_rule)
        self.assertIn("grid-template-columns: minmax(0, 1fr);", desktop_rule)
        self.assertIn(wide_rule, wide_container)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", wide_rule)
        self.assertIn("align-items: stretch;", wide_rule)
        self.assertIn(".live-browser-card-head", compact_container)
        self.assertIn("flex-direction: column;", compact_container)
        self.assertIn(".live-browser-card-actions", compact_container)
        self.assertIn("justify-content: flex-start;", compact_container)
        self.assertIn(mobile_rule, mobile_media)
        self.assertIn("grid-template-columns: 1fr;", mobile_rule)
        self.assertIn(".live-browser-card-head", mobile_controls)
        self.assertIn("flex-direction: column;", mobile_controls)
        self.assertIn(".live-browser-card-actions", mobile_controls)
        self.assertIn("justify-content: flex-start;", mobile_controls)

    def test_mobile_browser_monitor_uses_a_sticky_stop_all_button(self):
        render = self._function_source("renderLiveBrowserSessions")
        mobile_overrides = self.styles[self.styles.index("/* Mobile browser monitor:"):]
        head_actions = self._css_block(
            '.console-page .account-browser-page[data-account-browser-page="browsers"] .live-browser-head-actions {',
            self.styles.index("/* Mobile browser monitor:"),
        )

        self.assertIn('class="danger live-browser-stop-all--head" data-social-cancel-all disabled', render)
        self.assertIn('class="primary live-browser-stop-all--bottom" data-social-cancel-all disabled', render)
        self.assertIn(".live-browser-head-actions", mobile_overrides)
        self.assertIn("display: none;", head_actions)
        self.assertIn(".live-browser-stop-all-dock", mobile_overrides)
        self.assertIn("position: fixed;", mobile_overrides)
        self.assertIn("display: grid;", mobile_overrides)
        self.assertIn("width: 100%;", mobile_overrides)

    def test_mobile_live_browser_placeholders_and_expanded_window_prioritizes_media(self):
        mobile_density_start = self.styles.index(
            "@media (max-width: 760px)",
            self.styles.index(".live-browser-placeholder {"),
        )
        mobile_placeholder_start = self.styles.index(
            ".live-browser-placeholder {",
            mobile_density_start,
        )
        mobile_placeholder = self._css_block(
            ".live-browser-placeholder {",
            mobile_placeholder_start,
        )
        landscape_media = self._css_block(
            "@media (max-width: 760px) and (orientation: portrait)",
        )
        landscape_card_start = self.styles.index(
            ".live-browser-card.is-live-browser-modal {",
            self.styles.index("@media (max-width: 760px) and (orientation: portrait)"),
        )
        landscape_card = self._css_block(
            ".live-browser-card.is-live-browser-modal {",
            landscape_card_start,
        )
        landscape_frame_start = self.styles.index(
            ".live-browser-card.is-live-browser-modal .live-browser-frame",
            landscape_card_start,
        )
        landscape_frame = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-frame",
            landscape_frame_start,
        )
        landscape_tools_start = self.styles.index(
            ".live-browser-card.is-live-browser-modal .live-browser-tools",
            landscape_frame_start,
        )
        landscape_tools = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-tools",
            landscape_tools_start,
        )
        landscape_input_start = self.styles.index(
            ".live-browser-card.is-live-browser-modal .live-browser-tools input",
            landscape_tools_start,
        )
        landscape_input = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-tools input",
            landscape_input_start,
        )

        self.assertIn("aspect-ratio: 16 / 9;", mobile_placeholder)
        self.assertIn("min-height: 0;", mobile_placeholder)
        self.assertNotIn("aspect-ratio: auto;", mobile_placeholder)
        self.assertIn(landscape_card, landscape_media)
        self.assertIn("inset: auto;", landscape_card)
        self.assertIn("top: 50%;", landscape_card)
        self.assertIn("left: 50%;", landscape_card)
        self.assertIn("width: calc(100dvh - 12px);", landscape_card)
        self.assertIn("height: calc(100dvw - 12px);", landscape_card)
        self.assertIn("transform: translate(-50%, -50%) rotate(90deg);", landscape_card)
        self.assertIn("transform-origin: center;", landscape_card)
        self.assertIn("grid-template-rows: minmax(0, 1fr);", landscape_card)
        self.assertIn(landscape_frame, landscape_media)
        self.assertIn("height: 100%;", landscape_frame)
        self.assertIn("max-height: none;", landscape_frame)
        self.assertIn("aspect-ratio: auto;", landscape_frame)
        self.assertIn(".live-browser-frame > iframe", landscape_media)
        self.assertIn("inset: 0;", landscape_media)
        self.assertIn("width: 100%;", landscape_media)
        self.assertIn("height: 100%;", landscape_media)
        self.assertIn("transform: none;", landscape_media)
        self.assertIn("grid-template-columns: minmax(0, 1fr) repeat(3, auto);", landscape_tools)
        self.assertIn("grid-column: auto;", landscape_input)
        expanded_modal = self._css_block(
            ".console-page [data-live-browser-card].live-browser-card.is-live-browser-modal,"
        )
        expanded_head = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-card-head {"
        )
        self.assertIn("gap: 0;", expanded_modal)
        self.assertIn("padding: 0;", expanded_modal)
        self.assertIn("border: 0;", expanded_modal)
        self.assertIn("position: absolute;", expanded_head)
        self.assertIn("background: rgb(5 12 13 / 62%);", expanded_head)
        self.assertIn("pointer-events: none;", expanded_head)
        self.assertIn(".is-live-browser-controls-visible .live-browser-card-head", self.styles)
        self.assertIn(".is-live-browser-controls-visible .live-browser-interaction-note", self.styles)
        self.assertIn(".is-live-browser-controls-visible .live-browser-card-actions > .status", self.styles)
        self.assertIn("vecto-live-browser-modal-enter", self.styles)
        self.assertNotIn("vecto-live-browser-modal-exit", self.styles)
        self.assertIn(".is-live-browser-controls-visible .live-browser-task-summary span:nth-child(2)", landscape_media)
        self.assertIn(".live-browser-card-identity", self.styles)
        self.assertIn(".live-browser-interaction-note", self.styles)

    def test_mobile_live_browser_header_keeps_status_and_compact_two_line_summary(self):
        mobile_header_start = self.styles.rfind(".console-page .live-browser-card-head {")
        mobile_start = self.styles.rfind("@media (max-width: 760px) {", 0, mobile_header_start)
        mobile_styles = self.styles[mobile_start:]
        mobile_header = self._css_block(".console-page .live-browser-card-head {", mobile_start)
        mobile_summary = self._css_block(".console-page .live-browser-mobile-summary {", mobile_start)
        mobile_status = self._css_block(".console-page .live-browser-card-actions > .status {", mobile_start)

        self.assertIn("grid-template-rows: auto auto;", mobile_header)
        self.assertIn("font-size: 7.5px;", mobile_summary)
        self.assertIn("justify-content: center;", mobile_summary)
        self.assertIn("display: inline-flex;", mobile_status)
        self.assertIn("live-browser-card-identity > [data-live-browser-meta]", mobile_styles)
        self.assertIn("live-browser-mobile-summary", self.source)

    def test_expanded_desktop_browser_header_keeps_translucent_true_centerline(self):
        expanded_head = self._css_block(
            ".live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-card-head {"
        )
        expanded_content_marker = (
            ".live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-card-identity,"
        )
        expanded_content_start = self.styles.index(expanded_content_marker)
        expanded_content = self._css_block(expanded_content_marker, expanded_content_start)
        expanded_task = self._css_block(
            ".live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-task-summary {",
            expanded_content_start + len(expanded_content),
        )

        self.assertIn("top: 0;", expanded_head)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto;", expanded_head)
        self.assertIn("background: rgb(5 12 13 / 74%);", expanded_head)
        self.assertIn("align-items: center;", expanded_content)
        self.assertIn("position: absolute;", expanded_task)
        self.assertIn("top: 50%;", expanded_task)
        self.assertIn("left: 50%;", expanded_task)
        self.assertIn("transform: translate(-50%, -50%);", expanded_task)

    def test_mobile_persona_hot_fetch_uses_centered_scope_switch_and_hidden_default_freshness(self):
        mobile_toolbar = self._css_block(
            ".console-page .persona-detail .persona-hot-fetch-toolbar {"
        )
        mobile_mode_tabs = self._css_block(
            ".console-page .persona-detail .persona-hot-mode-tabs {"
        )

        self.assertIn('class="row-actions persona-hot-fetch-toolbar"', self.source)
        self.assertIn('class="primary persona-hot-fetch-action"', self.source)
        self.assertIn('class="persona-hot-fetch-action"', self.source)
        self.assertIn('["normal", "泛垂直"]', self.source)
        self.assertIn('["strict", "垂直"]', self.source)
        self.assertIn('hotSearchMode: "strict"', self.source)
        self.assertNotIn('data-persona-hot-freshness-', self.source)
        self.assertNotIn('热点时限', self.source)
        self.assertIn('freshness_days: 7,', self.source)
        self.assertIn('freshness_policy: "strict",', self.source)
        self.assertIn('return [...deduped.values()];', self.source)
        self.assertNotIn("is-reserved", self.source)
        self.assertIn(
            "grid-template-columns: repeat(2, minmax(0, 1fr));",
            mobile_toolbar,
        )
        self.assertIn(
            "grid-template-columns: repeat(2, minmax(0, 1fr));",
            mobile_mode_tabs,
        )
        self.assertIn("width: 42%;", mobile_mode_tabs)
        self.assertIn("max-width: 190px;", mobile_mode_tabs)
        self.assertIn("border-radius: 8px;", mobile_mode_tabs)
        self.assertIn("min-height: 42px;", self.styles)

    def test_persona_hot_fetch_prepares_hidden_keywords_before_tracking_controller(self):
        fetch_source = self._function_source("fetchPersonaHotCandidates")

        self.assertIn("await preparePersonaHotKeywords(false)", fetch_source)
        self.assertIn("const controller = new AbortController();", fetch_source)
        self.assertLess(
            fetch_source.index('if (!keywords.length) {'),
            fetch_source.index("const controller = new AbortController();"),
        )
        self.assertIn('data-persona-fetch-hot', self.source)
        self.assertIn('抓取热点', self.source)
        self.assertNotIn('步骤 1：生成关键词', self.source)
        self.assertNotIn('data-persona-hot-keywords', self.source)
        self.assertNotIn('data-persona-prepare-hot-keywords', self.source)
        self.assertNotIn('data-persona-fetch-hot-refresh', self.source)
        self.assertNotIn('本次关键词', self.source)
        self.assertNotIn('按关键词抓取', self.source)

    def test_persona_hot_workflow_cli_entrypoint_parses(self):
        npx = shutil.which("npx")
        if not npx:
            self.skipTest("npx is not available")

        result = subprocess.run(
            [npx, "tsx", "scripts/skills/persona-hot-workflow.ts", '{"action":"__syntax_check__"}'],
            cwd=REPO_ROOT / "tool_r18",
            text=True,
            capture_output=True,
            timeout=30,
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('"unsupported action"', result.stdout)
        self.assertNotIn("TransformError", result.stderr + result.stdout)

    def test_custom_dropdowns_close_when_clicking_outside(self):
        bind_events = self._function_source("bindEvents")

        self.assertIn('data-console-dropdown', self.source)
        self.assertIn('function closeConsoleDropdowns(exceptMenu = null)', self.source)
        self.assertIn('document.querySelectorAll("details[open][data-console-dropdown]")', self.source)
        self.assertIn('closeConsoleDropdowns(event.target.closest("[data-console-dropdown]"));', bind_events)

    def test_expanded_mobile_browser_uses_one_compact_translucent_summary(self):
        portrait_start = self.styles.rfind("@media (max-width: 760px) and (orientation: portrait)")
        portrait_styles = self.styles[portrait_start:]
        expanded_head = self._css_block(
            ".console-page .live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-card-head {",
            portrait_start,
        )
        account_title = self._css_block(
            ".console-page .live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-card-identity > strong {",
            portrait_start,
        )
        account_meta = self._css_block(
            ".console-page .live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-card-identity > [data-live-browser-meta] {",
            portrait_start,
        )
        task_summary = self._css_block(
            ".console-page .live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-task-summary {",
            portrait_start,
        )
        mobile_summary = self._css_block(
            ".console-page .live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-mobile-summary {",
            portrait_start,
        )
        mobile_status = self._css_block(
            ".console-page .live-browser-card-actions > .status {",
            self.styles.find("@media (max-width: 760px)"),
        )
        mobile_elapsed = self._css_block(
            ".console-page .live-browser-card.is-live-browser-modal.is-live-browser-controls-visible .live-browser-mobile-summary > .live-browser-task-elapsed {",
            portrait_start,
        )

        self.assertIn("padding: 3px 6px;", expanded_head)
        self.assertIn("background: rgb(5 12 13 / 37%);", expanded_head)
        self.assertIn("top: 2px;", account_title)
        self.assertIn("position: relative;", account_meta)
        self.assertIn("top: 0;", account_meta)
        self.assertIn("display: none;", task_summary)
        self.assertIn("display: grid;", mobile_summary)
        self.assertIn("position: static;", mobile_summary)
        self.assertIn("transform: none;", mobile_summary)
        self.assertIn("grid-template-columns: repeat(3, max-content);", mobile_summary)
        self.assertIn("justify-content: center;", mobile_summary)
        self.assertIn("grid-column: 3;", mobile_elapsed)
        self.assertIn("grid-row: 1;", mobile_elapsed)
        self.assertIn("font-size: inherit;", mobile_elapsed)
        self.assertIn("align-items: center;", mobile_status)
        self.assertIn("justify-content: center;", mobile_status)
        self.assertIn("live-browser-mobile-summary > span:first-child", portrait_styles)
        self.assertIn("live-browser-mobile-summary > span:nth-child(2)", portrait_styles)
        self.assertIn("live-browser-mobile-summary > span:nth-child(3)", portrait_styles)
        self.assertIn("background: rgb(13 18 19 / 42%);", portrait_styles)
    def test_expanded_live_browser_does_not_bind_native_frame_clicks_to_console_controls(self):
        toggle = self._function_source("toggleLiveBrowserModalControls")
        opening = self._function_source("requestLiveBrowserFullscreen")

        self.assertIn('[data-live-browser-modal-overlay-toggle], [data-live-browser-controls-toggle]', self.source)
        self.assertIn('class="live-browser-lock" data-live-browser-controls-toggle', self.source)
        self.assertIn('data-live-browser-mobile-controls', self.source)
        self.assertIn("isMobileLiveBrowserViewport()", toggle)
        self.assertIn("is-live-browser-controls-visible", toggle)
        self.assertNotIn("vecto-live-browser-toggle-console-frame", self.source)
        self.assertIn("setLiveBrowserModalControlsVisible(card, !isMobileLiveBrowserViewport())", opening)

    def test_mobile_expanded_browser_has_persistent_page_control_launcher(self):
        launcher = self._css_block(".live-browser-mobile-controls-launcher {")
        mobile_start = self.styles.index("@media (max-width: 760px)", self.styles.index("/* Expanded preview is media-first:"))
        mobile_launcher = self._css_block(".live-browser-mobile-controls-launcher {", mobile_start)
        desktop_start = self.styles.index("@media (min-width: 761px)", self.styles.index("/* Expanded preview is media-first:"))
        desktop_controls = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-card-head,",
            desktop_start,
        )

        self.assertIn("display: none;", launcher)
        self.assertIn("display: inline-flex;", mobile_launcher)
        self.assertIn("pointer-events: auto;", mobile_launcher)
        self.assertIn("opacity: 1;", desktop_controls)
        self.assertIn("pointer-events: auto;", desktop_controls)
        self.assertIn("visibility: visible;", desktop_controls)

    def test_desktop_expanded_browser_chrome_reserves_space_outside_remote_canvas(self):
        desktop_start = self.styles.index(
            "@media (min-width: 761px)",
            self.styles.index("/* Expanded preview is media-first:"),
        )
        desktop_card = self._css_block(
            ".console-page [data-live-browser-card].live-browser-card.is-live-browser-modal {",
            desktop_start,
        )
        desktop_head = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-card-head,",
            desktop_start,
        )
        desktop_frame = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-frame,",
            desktop_start,
        )
        desktop_note = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-interaction-note,",
            desktop_start,
        )

        self.assertIn("grid-template-rows: 48px minmax(0, 1fr) 32px;", desktop_card)
        self.assertIn("position: relative;", desktop_head)
        self.assertIn("grid-row: 1;", desktop_head)
        self.assertIn("grid-row: 2;", desktop_frame)
        self.assertIn("position: relative;", desktop_note)
        self.assertIn("grid-row: 3;", desktop_note)
        self.assertNotIn("border:", desktop_card)
        self.assertNotIn("background:", desktop_card)
        self.assertNotIn("padding:", desktop_head)
        self.assertNotIn("background:", desktop_head)
        self.assertNotIn("padding:", desktop_note)
        self.assertNotIn("background:", desktop_note)

    def test_mobile_page_control_sits_beside_account_tag_with_translucent_surface(self):
        session_markup = self._function_source("renderLiveBrowserSession")
        head_start = session_markup.index('<div class="live-browser-card-head">')
        identity_start = session_markup.index('<div class="live-browser-card-identity">')
        identity_end = session_markup.index("</div>", identity_start)
        launcher_position = session_markup.index("data-live-browser-mobile-controls", identity_start)
        task_summary_position = session_markup.index('<div class="live-browser-task-summary"', launcher_position)
        self.assertGreater(launcher_position, identity_end)
        self.assertGreater(launcher_position, head_start)
        self.assertLess(launcher_position, task_summary_position)

        mobile_start = self.styles.index(
            "@media (max-width: 760px)",
            self.styles.index("/* Mobile browser monitor:"),
        )
        mobile_launcher = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-mobile-controls-launcher {",
            mobile_start,
        )
        compact_identity = self._css_block(
            ".live-browser-card.is-live-browser-modal:not(.is-live-browser-controls-visible) .live-browser-card-identity {",
            mobile_start,
        )

        self.assertIn("position: absolute;", mobile_launcher)
        self.assertIn("background: rgb(5 12 13 / 58%);", mobile_launcher)
        self.assertIn("display: none;", compact_identity)

    def test_live_browser_task_target_shows_a_real_elapsed_timer(self):
        session_markup = self._function_source("renderLiveBrowserSession")
        session_update = self._function_source("updateLiveBrowserSessionCard")
        elapsed_sync = self._function_source("syncActionElapsedTimers")
        self.assertIn("renderLiveBrowserTaskElapsed(session)", session_markup)
        self.assertIn("data-live-browser-task-elapsed", self.source)
        self.assertIn("liveBrowserTaskTiming(session)", self.source)
        self.assertIn("liveBrowserTaskTiming(session)", session_update)
        self.assertIn("[data-live-browser-task-elapsed]", elapsed_sync)
        self.assertIn("data-live-browser-task-finished-at", self.source)

    def test_live_browser_fallback_url_uses_same_low_latency_decoder_settings(self):
        fallback_url = self._function_source("liveBrowserSessionUrl")

        self.assertIn('quality: "4"', fallback_url)
        self.assertIn('dynamic_quality_min: "2"', fallback_url)
        self.assertIn('dynamic_quality_max: "6"', fallback_url)
        self.assertIn('jpeg_video_quality: "4"', fallback_url)
        self.assertIn('webp_video_quality: "-1"', fallback_url)
        self.assertIn('video_time: "4"', fallback_url)
        self.assertIn('framerate: "30"', fallback_url)
        self.assertIn('compression: "1"', fallback_url)
        self.assertIn('enable_webp: "0"', fallback_url)
        self.assertIn('enable_threading: "0"', fallback_url)

    def test_expanded_live_browser_restores_original_full_bleed_frame(self):
        expanded_start = self.styles.index("/* Expanded preview is media-first:")
        frame_start = self.styles.index(
            ".live-browser-card.is-live-browser-modal .live-browser-frame,",
            expanded_start,
        )
        frame_rule = self._css_block(
            ".live-browser-card.is-live-browser-modal .live-browser-frame,",
            frame_start,
        )

        self.assertIn("width: 100%;", frame_rule)
        self.assertIn("height: 100%;", frame_rule)
        self.assertIn("max-height: none;", frame_rule)
        self.assertIn("aspect-ratio: auto;", frame_rule)

    def test_live_browser_controls_keep_visible_layout_until_exit_fade_finishes(self):
        cancel_controls_exit = self._function_source("cancelLiveBrowserControlsExit")
        set_controls_visible = self._function_source("setLiveBrowserModalControlsVisible")
        sync_mobile_launcher = self._function_source("syncLiveBrowserMobileControlsLauncher")
        self.assertIn("const LIVE_BROWSER_CONTROLS_EXIT_MS = 220;", self.source)
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const LIVE_BROWSER_CONTROLS_EXIT_MS = 30;
            const liveBrowserControlsExitTimers = new WeakMap();
            class FakeClassList {{
              constructor(names) {{ this.names = new Set(names); }}
              add(...names) {{ names.forEach((name) => this.names.add(name)); }}
              contains(name) {{ return this.names.has(name); }}
              remove(...names) {{ names.forEach((name) => this.names.delete(name)); }}
              toggle(name, force) {{
                if (force === undefined) force = !this.names.has(name);
                if (force) this.names.add(name);
                else this.names.delete(name);
                return force;
              }}
            }}

            function createCard(classNames) {{
              const attributes = new Set();
              return {{
                classList: new FakeClassList(classNames),
                dataset: {{}},
                attributes,
                hasAttribute: (name) => attributes.has(name),
                querySelector: () => null,
                querySelectorAll: () => [],
                removeAttribute: (name) => attributes.delete(name),
                toggleAttribute: (name, force) => {{
                  if (force) attributes.add(name);
                  else attributes.delete(name);
                }},
              }};
            }}

            {cancel_controls_exit}
            {sync_mobile_launcher}
            {set_controls_visible}
            (async () => {{

            const card = createCard([
              "is-live-browser-modal",
              "is-live-browser-controls-visible",
            ]);
            card.toggleAttribute("data-live-browser-controls-visible", true);

            setLiveBrowserModalControlsVisible(card, false);
            assert.equal(card.classList.contains("is-live-browser-controls-visible"), true);
            assert.equal(card.classList.contains("is-live-browser-controls-exiting"), true);
            assert.equal(card.hasAttribute("data-live-browser-controls-visible"), true);

            setLiveBrowserModalControlsVisible(card, true);
            assert.equal(card.classList.contains("is-live-browser-controls-exiting"), false);
            await new Promise((resolve) => setTimeout(resolve, 45));
            assert.equal(card.classList.contains("is-live-browser-controls-visible"), true);

            setLiveBrowserModalControlsVisible(card, false);
            await new Promise((resolve) => setTimeout(resolve, 45));
            assert.equal(card.classList.contains("is-live-browser-controls-visible"), false);
            assert.equal(card.classList.contains("is-live-browser-controls-exiting"), false);
            assert.equal(card.hasAttribute("data-live-browser-controls-visible"), false);
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_live_browser_controls_exit_fades_without_changing_visible_layout(self):
        exit_head = self._css_block(
            ".live-browser-card.is-live-browser-modal.is-live-browser-controls-visible.is-live-browser-controls-exiting .live-browser-card-head {"
        )
        exit_note = self._css_block(
            ".live-browser-card.is-live-browser-modal.is-live-browser-controls-visible.is-live-browser-controls-exiting .live-browser-interaction-note {"
        )

        self.assertIn("opacity: 0;", exit_head)
        self.assertIn("pointer-events: none;", exit_head)
        self.assertNotIn("display:", exit_head)
        self.assertNotIn("width:", exit_head)
        self.assertNotIn("height:", exit_head)
        self.assertNotIn("grid-template", exit_head)
        self.assertIn("opacity: 0;", exit_note)

    def test_public_toast_uses_unified_top_status_card(self):
        host = self._css_block(".toast-host {")
        message = self._css_block(".toast-message {")
        message_text = self._css_block(".toast-message-text {")
        status_icon = self._css_block(".toast-message-status-icon {")
        slide = self._css_block("@keyframes toastSlideDownIn")
        exit_slide = self._css_block("@keyframes toastSlideUpOut")
        metadata = self._section("function applyToastMeta", "function applyToastTargetMeta")
        creation = self._function_source("createToast")

        self.assertIn("left: auto;", host)
        self.assertIn("right: 16px;", host)
        self.assertIn("top: max(16px, env(safe-area-inset-top));", host)
        self.assertIn("bottom: auto;", host)
        self.assertIn("width: min(420px, calc(100vw - 24px));", host)
        self.assertNotIn("transform: translateX(-50%);", host)
        self.assertIn("grid-template-columns: 24px minmax(0, 1fr) 28px;", message)
        self.assertIn("min-height: 56px;", message)
        self.assertIn("padding: 12px 8px 12px 12px;", message)
        self.assertIn("background: var(--panel-solid);", message)
        self.assertIn("animation: toastSlideDownIn 220ms", message)
        self.assertIn("background: var(--toast-state-color);", status_icon)
        self.assertIn("border-radius: 999px;", status_icon)
        self.assertIn("toast-message-status-icon", creation)
        self.assertIn("toastStatusIconMarkup(normalizedStatus)", metadata)
        self.assertIn("-webkit-line-clamp: 2;", message_text)
        self.assertIn("max-height: 2.8em;", message_text)
        self.assertIn("overflow: hidden;", message_text)
        self.assertIn("font-weight: 700;", message_text)
        self.assertIn("transform: translateY(-24px);", slide)
        self.assertIn("transform: translateY(-24px);", exit_slide)

    def test_all_toasts_capture_a_clickable_destination_and_open_the_exact_surface(self):
        target = self._section("function currentToastTarget", "function toastTargetForKind")
        mapping = self._section("function toastTargetForKind", "function normalizeToastStatus")
        opening = self._section("async function openToastTarget", "function createToast")
        metadata = self._section("function applyToastMeta", "async function openToastTarget")
        default_target = self._function_source("defaultToastTargetForMessage")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{
              view: "workspace",
              activeModule: "publishing",
              selectedPersonaId: "persona-7",
              personaGroup: "content",
              personaPanels: {{ content: "posts" }},
              simpleBranches: {{ publishing: "publish_history" }},
              accountBrowserPanel: "accounts",
              taskQueuePanel: "persona",
            }};
            function isPersonaWorkspaceModule(moduleId) {{
              return ["personas", "tweet_generation"].includes(String(moduleId || ""));
            }}
            function personaModuleDefaultGroup(moduleId) {{
              return moduleId === "tweet_generation" ? "content" : "settings";
            }}
            function normalizedPersonaGroupKey(groupKey) {{
              return ["settings", "content"].includes(groupKey) ? groupKey : "settings";
            }}
            function normalizedPublishMode(mode) {{
              return ["matrix_start", "publish_history"].includes(mode) ? mode : "publish_now";
            }}
            {target}
            {mapping}

            assert.deepStrictEqual(currentToastTarget(), {{
              view: "workspace",
              module: "publishing",
              personaId: "persona-7",
              publishMode: "publish_history",
            }});
            assert.deepStrictEqual(toastTargetForKind("need_manual", {{
              taskId: "task-9",
              personaId: "persona-7",
            }}), {{
              view: "accounts",
              accountPanel: "browsers",
              taskId: "task-9",
              personaId: "persona-7",
            }});
            assert.deepStrictEqual(toastTargetForKind("queued"), {{
              view: "tasks",
              taskPanel: "persona",
            }});
            state.view = "accounts";
            state.accountBrowserPanel = "proxies";
            assert.strictEqual(currentToastTarget().accountPanel, "proxies");
            """
        )
        self._run_node(harness)

        self.assertIn('const moduleId = String(state.activeModule || "personas")', target)
        self.assertIn("const target = { view, module: moduleId, ...personaTarget }", target)
        self.assertIn("publishMode", target)
        self.assertIn("personaGroup", target)
        self.assertIn("accountPanel", target)
        self.assertIn('normalized === "need_manual"', mapping)
        self.assertIn('view: "accounts"', mapping)
        self.assertIn('accountPanel: "browsers"', mapping)
        self.assertIn("return currentToastTarget()", mapping)
        self.assertNotIn('view: "social"', mapping)
        self.assertIn("setAccountBrowserPanel(targetAccountPanel)", opening)
        self.assertIn("refreshLiveBrowserSessionsSoon", opening)
        self.assertIn("state.simpleBranches.publishing = targetPublishMode", opening)
        self.assertIn("taskQueuePageForTarget(state.taskQueuePanel, target.taskId)", opening)
        self.assertIn("focusTaskQueueTarget(target.taskId, state.taskQueuePanel)", opening)
        self.assertIn('target.accountPanel === "browsers"', metadata)
        self.assertIn("点击打开浏览器监控", metadata)
        self.assertIn("return currentToastTarget()", default_target)

    def test_active_social_task_toasts_open_the_browser_surface(self):
        target = self._function_source("socialTaskToastTarget")
        sync_toast = self._section("function syncSocialTaskToast(", "\nfunction syncSocialTaskToasts(")
        create_task = self._function_source("createSocialTask")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            function isFutureScheduledSocialTask(task) {{
              return Boolean(task?.scheduled);
            }}
            function socialTaskPresentationStatus(task) {{
              return String(task?.presentation_status || task?.status || "");
            }}
            {target}

            const active = {{
              id: "task-live",
              status: "queued",
              persona_id: "persona-7",
            }};
            assert.deepStrictEqual(socialTaskToastTarget(active), {{
              view: "accounts",
              accountPanel: "browsers",
              taskId: "task-live",
              personaId: "persona-7",
            }});
            assert.strictEqual(socialTaskToastTarget({{ ...active, status: "running" }}).accountPanel, "browsers");
            assert.strictEqual(socialTaskToastTarget({{ ...active, presentation_status: "need_manual" }}).accountPanel, "browsers");
            assert.deepStrictEqual(socialTaskToastTarget({{ ...active, scheduled: true }}), {{
              view: "tasks",
              taskPanel: "persona",
              taskId: "task-live",
              personaId: "persona-7",
            }});
            assert.deepStrictEqual(socialTaskToastTarget({{ ...active, status: "success" }}), {{
              view: "tasks",
              taskPanel: "persona",
              taskId: "task-live",
              personaId: "persona-7",
            }});
            assert.strictEqual(socialTaskToastTarget({{ status: "queued" }}), null);
            """
        )
        self._run_node(harness)

        self.assertIn("target: socialTaskToastTarget(task, status)", sync_toast)
        self.assertGreaterEqual(
            create_task.count('target: socialTaskToastTarget(result.task, "queued")'),
            2,
        )

    def test_only_concurrent_social_browser_tasks_use_independent_toast_stack(self):
        independent = self._function_source("socialTaskUsesIndependentToast")
        sync_toast = self._section("function syncSocialTaskToast(", "\nfunction syncSocialTaskToasts(")
        show_toast = self._section("function showToast", "function defaultToastTargetForMessage")
        create_toast = self._function_source("createToast")
        remove_toasts = self._function_source("removeToastsBeforeInsert")
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const state = {{
              socialTasks: [],
              socialTaskIndependentToastIds: new Set(),
            }};
            function activeSocialAutomationTask(task) {{
              return ["running", "need_manual"].includes(String(task?.status || ""));
            }}
            {independent}

            const first = {{ id: "warmup-1", task_type: "threads_warmup", status: "running" }};
            const second = {{ id: "publish-1", task_type: "publish_post", status: "queued" }};
            state.socialTasks = [first];
            assert.equal(socialTaskUsesIndependentToast(first), false);
            assert.equal(socialTaskUsesIndependentToast({{
              id: "single-cancelled",
              task_type: "publish_post",
              status: "cancelled",
            }}), false);

            state.socialTasks = [first, second];
            assert.equal(socialTaskUsesIndependentToast(first), false);
            assert.equal(socialTaskUsesIndependentToast(second), false);

            second.status = "running";
            assert.equal(socialTaskUsesIndependentToast(first), true);
            assert.equal(socialTaskUsesIndependentToast(second), true);

            first.status = "success";
            second.status = "success";
            assert.equal(socialTaskUsesIndependentToast(first), true);
            assert.equal(socialTaskUsesIndependentToast(second), true);
            assert.equal(socialTaskUsesIndependentToast({{ task_type: "publish_post" }}), false);
            """
        )
        self._run_node(harness)

        self.assertIn("stack: socialTaskUsesIndependentToast(task)", sync_toast)
        self.assertIn("if (existingToast && !toastReplacementInProgress)", show_toast)
        self.assertLess(
            show_toast.index("if (request.stack)"),
            show_toast.index("const isTaskRefresh"),
        )
        self.assertIn("if (request.stack) return createToast(request);", show_toast)
        self.assertIn('toast.dataset.toastStacked = "true"', create_toast)
        self.assertIn('toast.dataset.toastStacked !== "true"', remove_toasts)

    def test_status_tone_covers_live_detection_and_recovery_states(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("statusLabel")}
            {self._function_source("statusTone")}
            {self._function_source("accountStatusDisplayLabel")}
            {self._function_source("accountStatusDisplayTone")}
            {self._function_source("accountStatusClassNames")}
            assert.strictEqual(statusTone("ready"), "success");
            assert.strictEqual(statusTone("pending_login"), "manual");
            assert.strictEqual(statusTone("account_confirmation_required"), "manual");
            assert.strictEqual(statusTone("cookie_expired"), "error");
            assert.strictEqual(statusTone("checking"), "active");
            assert.strictEqual(statusTone("browser_launch"), "active");
            assert.strictEqual(statusTone("preparing"), "active");
            assert.strictEqual(statusTone("login_wait_timeout"), "error");
            assert.strictEqual(statusTone("disabled"), "muted");
            assert.strictEqual(statusLabel("need_verification"), "需验证");
            assert.strictEqual(statusLabel("account_confirmation_required"), "需确认关联账号");
            assert.strictEqual(accountStatusDisplayLabel("ready_unverified"), "已登录");
            assert.strictEqual(accountStatusDisplayLabel("cookie_expired"), "未登录");
            assert.strictEqual(accountStatusDisplayLabel("account_confirmation_required"), "需验证");
            assert.strictEqual(accountStatusDisplayLabel("check_failed"), "登录异常");
            assert.strictEqual(accountStatusDisplayLabel("disabled"), "账号不可用");
            assert.strictEqual(accountStatusDisplayLabel("banned"), "账号不可用");
            assert.strictEqual(accountStatusDisplayTone("ready_unverified"), "success");
            assert.strictEqual(accountStatusDisplayTone("disabled"), "error");
            assert.strictEqual(accountStatusClassNames("account_confirmation_required"), "need_verification");
            assert.strictEqual(accountStatusClassNames("cookie_expired"), "pending_login");
            assert.strictEqual(accountStatusClassNames("banned"), "disabled");
            assert.strictEqual(statusLabel("preparing"), "准备执行");
            """
        )
        self._run_node(harness)

    def test_status_badges_have_distinct_semantic_color_groups(self):
        for variable in (
            "--status-success-bg",
            "--status-error-bg",
            "--status-queued-bg",
            "--status-manual-bg",
            "--status-running-bg",
            "--status-muted-bg",
        ):
            self.assertIn(variable, self.styles)

        for selector in (
            ".status.pending_login",
            ".status.need_verification",
            ".status.cookie_expired",
            ".status.transient_error",
            ".status.checking",
            ".status.disabled",
        ):
            self.assertIn(selector, self.styles)

        task_rows = self.styles[
            self.styles.index(".task-row .task-status-text.is-success"):
            self.styles.index(".status.success")
        ]
        self.assertIn("background: var(--status-running-bg)", task_rows)
        self.assertIn("color: var(--status-running-ink)", task_rows)

    def test_compact_live_browser_cards_preserve_status_border_colors(self):
        for selector, color in (
            (".console-page [data-live-browser-card].live-browser-card.is-status-active {", "#2f9baa"),
            (".console-page [data-live-browser-card].live-browser-card.is-status-queued {", "#4c7fc2"),
            (".console-page [data-live-browser-card].live-browser-card.is-status-manual {", "#d28a45"),
            (".console-page [data-live-browser-card].live-browser-card.is-status-success {", "#3f9f68"),
            (".console-page [data-live-browser-card].live-browser-card.is-status-error {", "#ce5e68"),
        ):
            self.assertIn(f"border-color: {color}", self._css_block(selector))

    def test_account_pool_bind_replaces_existing_persona_binding_in_one_action(self):
        bind_account = self._function_source("bindAccountPoolAccountToPersona")

        self.assertIn("replace_existing_binding: true", bind_account)
        self.assertNotIn("请先解绑原账号", bind_account)
        self.assertIn("if (state.accountPoolBinding) return", bind_account)
        self.assertIn("state.accountPoolBinding = true", bind_account)
        self.assertIn("state.accountPoolBinding = false", bind_account)

    def test_customer_persona_generation_does_not_read_admin_runtime_config(self):
        preflight = self._function_source("personaGeneratePreflight")
        self.assertIn("!state.currentUser?.is_admin", preflight)
        self.assertIn("return { ready: true, issues: [] }", preflight)

    def test_open_login_always_starts_in_automatic_mode_and_expired_toasts_are_not_revived(self):
        create_task = self._function_source("createSocialTask")
        toast = self._section("function showToast", "function defaultToastTargetForMessage")
        self.assertIn('auto_submit: taskType === "open_login" ? true : undefined', create_task)
        self.assertIn("refreshLiveBrowserSessionsSoon", create_task)
        self.assertIn('existingToast.classList.contains("is-leaving")', toast)
        refresh_start = toast.index("if (isTaskRefresh)")
        refresh_end = toast.index("pendingToastRequest = request", refresh_start)
        self.assertNotIn("clearToastRemovalTimer", toast[refresh_start:refresh_end])
        self.assertNotIn("applyToastMeta(existingToast", toast[refresh_start:refresh_end])
        self.assertIn("keep the existing DOM and class", toast[refresh_start:refresh_end])
        self.assertIn("updateToastInPlace(existingToast, request)", toast[refresh_start:refresh_end])
        self.assertIn("previousTarget !== nextTarget", toast[refresh_start:refresh_end])

    def test_task_toasts_keep_task_routing_and_rows_have_exact_targets(self):
        show_msg = self._section("function showMsg", "function showMsgHtml")
        persona_rows = self._function_source("renderPersonaQueueRows")
        task_view = self._function_source("renderTaskQueueView")

        self.assertIn("const hasTaskRoute = Boolean(options.target || options.taskId || options.kind)", show_msg)
        self.assertIn("hasTaskRoute ? options", show_msg)
        self.assertIn('data-task-queue-row-id="${esc(task.id)}"', persona_rows)
        self.assertIn('data-task-queue-row-id="${esc(task.id)}"', task_view)
        self.assertIn('tabindex="-1"', persona_rows)

        page_harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ taskQueuePersonaPageSize: 2, taskQueueRegularPageSize: 20 }};
            function taskQueueRowsForKind(kind) {{
              return kind === "persona"
                ? [{{ id: "task-1" }}, {{ id: "task-2" }}, {{ id: "task-3" }}]
                : [];
            }}
            {self._function_source("taskQueueRowMatchesTarget")}
            {self._function_source("taskQueuePageForTarget")}
            assert.strictEqual(taskQueuePageForTarget("persona", "task-3"), 2);
            assert.strictEqual(taskQueuePageForTarget("persona", "missing"), 1);
            """
        )
        self._run_node(page_harness)

    def test_manual_takeover_waits_for_backend_ack_and_keeps_task_refresh_active(self):
        set_mode = self._section("async function setLiveBrowserMode", "function liveBrowserToolInput")
        interaction_hint = self._function_source("liveBrowserInteractionHint")
        prompt_suppression = self._function_source("socialTaskPromptSuppressed")
        active_refresh = self._function_source("hasActiveSocialTaskToast")

        self.assertIn('result?.acknowledged ? "manual" : "switching"', set_mode)
        self.assertIn("Boolean(result?.acknowledged)", set_mode)
        self.assertIn("result?.takeover_waiting_for", set_mode)
        self.assertIn("refreshLiveBrowserSessionsSoon(taskId, 40, 500)", set_mode)
        self.assertIn("definitelyRejected", set_mode)
        self.assertLess(set_mode.index("suppressedSocialTaskPromptIds.add"), set_mode.index("await api("))
        self.assertIn("suppressedSocialTaskPromptIds", prompt_suppression)
        self.assertNotIn("socialBrowserSessions", prompt_suppression)
        self.assertNotIn("socialTaskPromptSuppressed", active_refresh)
        browser_refresh = self._function_source("refreshLiveBrowserSessionsSoon")
        self.assertIn('liveBrowserLoginMode(matched) === "switching"', browser_refresh)
        self.assertIn("found && !takeoverPending", browser_refresh)
        self.assertNotIn("automaticLoginActive", browser_refresh)
        self.assertIn("refreshLiveBrowserSessionsOnly", browser_refresh)
        self.assertIn("liveBrowserRefreshTokens[refreshKey]", browser_refresh)
        self.assertIn('matched.login_mode = "takeover_timeout"', browser_refresh)
        self.assertIn("targetTaskId && !matched && observedTarget", browser_refresh)
        self.assertIn("await refreshSocialTaskState(targetTaskId)", browser_refresh)
        self.assertIn("targetTaskId && !matched && taskFinished", browser_refresh)
        self.assertIn('["success", "failed", "cancelled"]', prompt_suppression)
        self.assertIn("人工接管请求已提交", interaction_hint)
        self.assertIn("到达后将自动开放操作", interaction_hint)
        self.assertIn("当前可以直接操作浏览器窗口", interaction_hint)

    def test_browser_session_refreshes_are_isolated_and_timeout_safely(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ socialBrowserSessions: [], liveBrowserRefreshTokens: {{}} }};
            const callbacks = [];
            const window = {{ setTimeout(callback) {{ callbacks.push(callback); }} }};
            async function refreshLiveBrowserSessionsOnly() {{}}
            async function refreshSocialTaskState(taskId) {{ return {{ id: taskId, status: "success" }}; }}
            function liveBrowserLoginMode(session) {{ return session.login_mode || "automatic"; }}
            function liveBrowserTaskStatus(session) {{ return session.task_status || session.status || "running"; }}
            function renderLiveBrowserSessions() {{}}
            function renderSocialAccounts() {{}}
            function isPersonaWorkspaceModule() {{ return false; }}
            function renderPersonaDetail() {{}}
            function showMsg() {{}}
            {self._function_source("refreshLiveBrowserSessionsSoon")}

            (async () => {{
              refreshLiveBrowserSessionsSoon("task-a", 1, 1);
              refreshLiveBrowserSessionsSoon("task-b", 1, 1);
              assert.strictEqual(Object.keys(state.liveBrowserRefreshTokens).length, 2);
              state.socialBrowserSessions = [{{ task_id: "task-a", login_mode: "switching", input_allowed: false }}];
              await callbacks.shift()();
              assert.strictEqual(state.socialBrowserSessions[0].login_mode, "takeover_timeout");
              assert.ok(!state.liveBrowserRefreshTokens["task-a"]);
              assert.ok(state.liveBrowserRefreshTokens["task-b"]);

              state.socialBrowserSessions = [{{ task_id: "task-gone", login_mode: "switching" }}];
              refreshLiveBrowserSessionsSoon("task-gone", 10, 1);
              state.socialBrowserSessions = [];
              await callbacks.pop()();
              assert.ok(!state.liveBrowserRefreshTokens["task-gone"]);

              callbacks.length = 0;
              state.socialBrowserSessions = [{{ task_id: "task-auto", task_type: "open_login", task_status: "running", login_mode: "automatic" }}];
              refreshLiveBrowserSessionsSoon("task-auto", 1, 1);
              await callbacks.pop()();
              assert.ok(!state.liveBrowserRefreshTokens["task-auto"]);
              assert.strictEqual(callbacks.length, 0);
            }})().catch((error) => {{ console.error(error); process.exit(1); }});
            """
        )
        self._run_node(harness)

    def test_manual_takeover_button_is_available_for_active_login_and_publish_sessions(self):
        helpers = "\n".join([
            self._function_source("liveBrowserSessionId"),
            self._function_source("liveBrowserTaskStatus"),
            self._function_source("isManualOpenLoginSession"),
            self._function_source("liveBrowserLoginMode"),
            self._function_source("renderLiveBrowserModeToggle"),
            self._function_source("liveBrowserIsReady"),
            self._function_source("isOpenLoginBrowserStarting"),
            self._function_source("liveBrowserPresentationStatus"),
            self._function_source("liveBrowserPresentationLabel"),
        ])
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            function esc(value) {{ return String(value || ""); }}
            function statusLabel(value) {{ return String(value || ""); }}
            {helpers}

            const publishSession = {{
              id: "publish-session",
              task_type: "publish_post",
              task_status: "running",
              login_mode: "automatic",
              input_allowed: false,
            }};
            const publishToggle = renderLiveBrowserModeToggle(publishSession);
            assert.ok(publishToggle.includes("自动执行"));
            assert.ok(publishToggle.includes("人工接管"));

            const loginToggle = renderLiveBrowserModeToggle({{
              id: "login-session",
              task_type: "open_login",
              task_status: "running",
              login_mode: "automatic",
            }});
            assert.ok(loginToggle.includes("自动登录"));

            const manualLogin = {{
              id: "manual-login-session",
              task_type: "open_login",
              task_status: "need_manual",
              login_mode: "manual",
              input_allowed: true,
            }};
            assert.strictEqual(liveBrowserLoginMode(manualLogin), "manual");
            assert.strictEqual(liveBrowserPresentationStatus(manualLogin), "need_manual");
            assert.strictEqual(liveBrowserPresentationLabel(manualLogin), "人工登录");
            """
        )
        self._run_node(harness)

        update_card = self._function_source("updateLiveBrowserSessionCard")
        self.assertIn('button.disabled = loginMode === "switching" || !sessionId || !["running", "need_manual"].includes(status)', update_card)
        self.assertNotIn('status !== "running"', update_card)

        set_mode = self._function_source("setLiveBrowserMode")
        self.assertIn('liveBrowserLoginMode(session) === "manual" && Boolean(session.input_allowed)', set_mode)

    def test_live_browser_running_card_status_bar_and_action_menu_are_balanced(self):
        render_session = self._function_source("renderLiveBrowserSession")
        mode_toggle = self._css_block(
            ".console-page .live-browser-action-menu-panel .live-browser-mode-toggle {"
        )
        mode_buttons = self._css_block(
            ".console-page .live-browser-action-menu-panel .live-browser-mode-toggle button {"
        )
        status_bar = self._css_block(
            ".console-page .live-browser-interaction-note {"
        )
        status_context = self._css_block(
            ".console-page .live-browser-interaction-context {"
        )
        status_hint = self._css_block(
            ".console-page .live-browser-interaction-note [data-live-browser-hint] {"
        )
        mobile_header_start = self.styles.rfind(".console-page .live-browser-card-head {")
        mobile_density_start = self.styles.rfind("@media (max-width: 760px) {", 0, mobile_header_start)
        mobile_density = self._css_block("@media (max-width: 760px)", mobile_density_start)

        self.assertIn("任务数：<b data-live-browser-task-count>", render_session)
        self.assertIn("任务目标：<b data-live-browser-task-target>", render_session)
        update_card = self._function_source("updateLiveBrowserSessionCard")
        self.assertIn('targetContainer.setAttribute("title", taskSummary.detail)', update_card)
        self.assertIn('targetContainer.setAttribute("aria-label", `任务目标：${taskSummary.detail}`)', update_card)
        self.assertIn('class="live-browser-interaction-context"', render_session)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", mode_toggle)
        self.assertIn("width: 100%;", mode_toggle)
        self.assertIn("width: 100%;", mode_buttons)
        self.assertIn("min-width: 0;", mode_buttons)
        self.assertIn("grid-template-columns: auto minmax(0, 1fr);", status_bar)
        self.assertIn("white-space: nowrap;", status_context)
        self.assertIn("text-align: right;", status_hint)
        self.assertIn("text-overflow: ellipsis;", status_hint)
        self.assertIn(
            "grid-template-columns: minmax(0, 1fr) auto;",
            mobile_density,
        )
        self.assertIn("flex: 0 1 auto;", mobile_density)
        self.assertLess(
            render_session.index('class="live-browser-mobile-summary"'),
            render_session.index('class="live-browser-expand-button"'),
        )
        self.assertIn("justify-content: center;", mobile_density)
        self.assertIn("max-width: none;", mobile_density)
        self.assertIn("justify-self: end;", mobile_density)

    def test_live_browser_takeover_wait_and_publish_target_uses_batch_actions(self):
        render_toggle = self._function_source("renderLiveBrowserModeToggle")
        update_card = self._function_source("updateLiveBrowserSessionCard")
        task_summary = self._function_source("liveBrowserTaskSummary")

        self.assertIn('switching ? "等待中"', render_toggle)
        self.assertNotIn("再次强制接管", render_toggle)
        self.assertIn('loginMode === "switching" ? "等待中"', update_card)
        self.assertNotIn("再次强制接管", update_card)
        self.assertIn('button.disabled = loginMode === "switching"', update_card)

        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const state = {{
              socialTasks: [{{
                id: "task-1",
                task_type: "publish_post",
                account_id: "account-1",
                account_username: "Peacock83628",
                platform: "threads",
                payload: {{
                  archive_post_title: "第11篇",
                  publish_batch_id: "publish_batch_demo",
                  publish_sequence_index: 2,
                  publish_sequence_total: 3,
                  publish_sequence_targets: ["发布第1篇", "发布第2篇", "发布第3篇"],
                }},
              }}],
              socialTaskToastKeys: {{}},
              socialTaskToastBatches: {{}},
            }};
            function socialTaskPayload(task) {{ return task?.payload || {{}}; }}
            function accountById() {{ return {{ username: "fallback-account" }}; }}
            function statusLabel(value) {{ return value; }}
            {task_summary}

            const summary = liveBrowserTaskSummary({{
              task_id: "task-1",
              task_type: "publish_post",
              account_id: "account-1",
              account_username: "Peacock83628",
              platform: "threads",
            }});
            assert.equal(summary.count, 3);
            assert.equal(summary.target, "发布第2/3篇");
            assert.ok(!summary.target.includes("第11篇"));
            assert.ok(!summary.target.includes("Threads"));
            assert.ok(!summary.target.includes("Peacock83628"));

            state.socialTasks = [{{
              id: "legacy-task",
              task_type: "publish_post",
              payload: {{ archive_post_title: "旧标题" }},
            }}];
            const legacy = liveBrowserTaskSummary({{
              task_id: "legacy-task",
              task_type: "publish_post",
            }});
            assert.equal(legacy.count, 1);
            assert.equal(legacy.target, "发布第1/1篇");

            state.socialTasks = [{{
              id: "legacy-batch-task-2",
              task_type: "publish_post",
              payload: {{}},
            }}];
            state.socialTaskToastKeys = {{ "legacy-batch-task-2": "legacy-batch" }};
            state.socialTaskToastBatches = {{
              "legacy-batch": {{
                taskIds: ["legacy-batch-task-1", "legacy-batch-task-2"],
                tasks: {{}},
              }},
            }};
            const legacyBatch = liveBrowserTaskSummary({{
              task_id: "legacy-batch-task-2",
              task_type: "publish_post",
            }});
            assert.equal(legacyBatch.count, 2);
            assert.equal(legacyBatch.target, "发布第1/2篇");

            """
        )
        self._run_node(harness)

    def test_live_browser_task_summary_prefers_realtime_server_strategy(self):
        task_summary = self._function_source("liveBrowserTaskSummary")
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const state = {{
              socialTasks: [{{
                id: "warmup-task",
                task_type: "threads_warmup",
                account_id: "account-1",
                account_username: "Peacock83628",
                payload: {{}},
              }}],
              socialTaskToastKeys: {{}},
              socialTaskToastBatches: {{}},
            }};
            function socialTaskPayload(task) {{ return task?.payload || {{}}; }}
            function accountById() {{ return {{ username: "Peacock83628" }}; }}
            function statusLabel(value) {{ return value; }}
            {task_summary}

            const first = liveBrowserTaskSummary({{
              task_id: "warmup-task",
              task_type: "threads_warmup",
              task_summary: {{
                count: 3,
                target: "养号｜随机点赞｜浏览30·赞16·评0",
                detail: "养号 · 默认养号：滑动 + 随机点赞 · 浏览 30 次 · 点赞最多 16 次 · 评论最多 0 次",
              }},
            }});
            assert.equal(first.count, 3);
            assert.equal(first.target, "养号｜随机点赞｜浏览30·赞16·评0");
            assert.equal(first.detail, "养号 · 默认养号：滑动 + 随机点赞 · 浏览 30 次 · 点赞最多 16 次 · 评论最多 0 次");
            assert.ok(!first.target.includes("Peacock83628"));

            const next = liveBrowserTaskSummary({{
              task_id: "publish-task",
              task_type: "publish_post",
              task_summary: {{
                count: 3,
                target: "发布2/3｜春日穿搭",
                detail: "发布内容 · 第 2/3 篇 · 春日穿搭",
              }},
            }});
            assert.equal(next.count, 3);
            assert.equal(next.target, "发布2/3｜春日穿搭");
            assert.equal(next.detail, "发布内容 · 第 2/3 篇 · 春日穿搭");
            """
        )
        self._run_node(harness)

    def test_queued_automation_plan_browser_button_opens_the_real_queued_task(self):
        browser_link = self._section(
            "function renderAutomationPlanBrowserLink",
            "\nfunction automationPlanCanDelete",
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            function automationPlanRunTasks(plan) {{ return plan.tasks || []; }}
            function esc(value) {{ return String(value); }}
            function renderBrowserLaunchIcon() {{ return "<svg></svg>"; }}
            {browser_link}

            const queuedOnly = renderAutomationPlanBrowserLink({{
              tasks: [
                {{ id: "queued-task", status: "queued" }},
                {{ id: "later-task", status: "preparing" }},
              ],
            }});
            assert.ok(queuedOnly.includes('data-automation-plan-browser-task="queued-task"'));

            const runningWins = renderAutomationPlanBrowserLink({{
              tasks: [
                {{ id: "queued-task", status: "queued" }},
                {{ id: "running-task", status: "running" }},
              ],
            }});
            assert.ok(runningWins.includes('data-automation-plan-browser-task="running-task"'));
            """
        )
        self._run_node(harness)

    def test_task_queue_browser_button_reuses_the_live_browser_navigation(self):
        queue_rows = self._section(
            "function renderPersonaQueueRows",
            "\nfunction renderTaskQueuePersonaSelectorCard",
        )
        self.assertIn('data-social-browser="${esc(task.id)}"', queue_rows)
        self.assertIn("renderBrowserLaunchIcon()", queue_rows)
        self.assertIn("const socialBrowser = event.target.closest(\"[data-social-browser]\")", self.source)
        self.assertIn("openLiveBrowserTaskView(socialBrowser.dataset.socialBrowser || \"\")", self.source)

    def test_browser_list_replaces_the_redundant_mobile_navigation_toggle_with_back_navigation(self):
        persistent_page = self._section(
            "function isMobilePersistentDockPage",
            "\nfunction syncMobilePageToolbar",
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const state = {{
              view: "accounts",
              accountBrowserPanel: "browsers",
              activeModule: "",
            }};
            {persistent_page}
            assert.equal(isMobilePersistentDockPage(), true);

            state.view = "social";
            assert.equal(isMobilePersistentDockPage(), false);
            """
        )
        self._run_node(harness)
        toolbar = self._section("function syncMobilePageToolbar", "\nfunction renderMobileTaskDock")
        navigation = self._section("function bindMobileNavigation", "\nfunction setPersonaMobileSidebarOpen")
        self.assertIn("const showBrowserBack", toolbar)
        self.assertIn("const pageBackTarget = mobilePageBackTarget();", toolbar)
        self.assertIn("const showPageBack = Boolean(pageBackTarget);", toolbar)
        self.assertIn("renderMobileNavToggleIcon(showPageBack)", toolbar)
        self.assertIn("const browserBackLabel = liveBrowserReturnLabel();", toolbar)
        self.assertIn("showBrowserBack ? browserBackLabel", toolbar)
        self.assertIn("const pageBackTarget = mobilePageBackTarget();", navigation)
        self.assertIn('if (pageBackTarget === "live-browser")', navigation)
        self.assertIn("returnFromLiveBrowserTaskView();", navigation)
        live_browser_navigation = self._section("function captureLiveBrowserReturnTarget", "window.VectoConsoleNavigation")
        self.assertIn('view: "tasks"', live_browser_navigation)
        self.assertIn("taskQueueRegularPage", live_browser_navigation)
        self.assertIn("taskQueuePersonaPage", live_browser_navigation)
        self.assertIn("function returnFromLiveBrowserTaskView()", live_browser_navigation)
        self.assertIn("state.liveBrowserReturnTarget = captureLiveBrowserReturnTarget();", live_browser_navigation)

    def test_publish_toast_lane_rollover_does_not_merge_cancelled_batch(self):
        lane_key = self._function_source("socialTaskToastLaneKey")
        terminal = self._function_source("socialTaskToastTerminal")
        clear_delivered = self._function_source("clearDeliveredToastStates")
        register_batch = self._function_source("registerSocialTaskToastBatch")
        register_lanes = self._function_source("registerSocialTaskToastLanes")
        task_summary = self._function_source("liveBrowserTaskSummary")
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const deliveredToastStateKeys = new Set();
            const state = {{
              socialTaskToastKeys: {{}},
              socialTaskToastBatches: {{}},
              socialTaskToastLabels: {{}},
              socialTasks: [],
            }};
            function socialTaskPresentationStatus(task) {{ return String(task?.status || ""); }}
            function activeSocialAutomationTask(task) {{ return ["queued", "running", "need_manual"].includes(String(task?.status || "")); }}
            function toastTimestampMs(task) {{ return Number(task?.created_at || 0); }}
            function socialTaskPayload(task) {{ return task?.payload || {{}}; }}
            function accountById() {{ return {{}}; }}
            function statusLabel(value) {{ return value; }}
            {lane_key}
            {terminal}
            {clear_delivered}
            {register_batch}
            {register_lanes}
            {task_summary}

            const oldTasks = [
              {{ id: "cancelled-1", task_type: "publish_post", persona_id: "p1", account_id: "a1", status: "cancelled", created_at: 1 }},
              {{ id: "cancelled-2", task_type: "publish_post", persona_id: "p1", account_id: "a1", status: "cancelled", created_at: 2 }},
            ];
            const nextTasks = [
              {{ id: "restart-1", task_type: "publish_post", persona_id: "p1", account_id: "a1", status: "running", created_at: 3, payload: {{ publish_sequence_index: 1, publish_sequence_total: 2, publish_sequence_targets: ["发布第1篇", "发布第2篇"] }} }},
              {{ id: "restart-2", task_type: "publish_post", persona_id: "p1", account_id: "a1", status: "queued", created_at: 4, payload: {{ publish_sequence_index: 2, publish_sequence_total: 2, publish_sequence_targets: ["发布第1篇", "发布第2篇"] }} }},
            ];
            const lane = socialTaskToastLaneKey(oldTasks[0]);
            registerSocialTaskToastBatch(lane, oldTasks);
            registerSocialTaskToastBatch(lane, nextTasks);
            registerSocialTaskToastLanes([...oldTasks, ...nextTasks]);
            assert.deepEqual(state.socialTaskToastBatches[lane].taskIds, ["restart-1", "restart-2"]);
            assert.equal(state.socialTaskToastKeys["cancelled-1"], undefined);
            state.socialTasks = nextTasks;
            const summary = liveBrowserTaskSummary({{ task_id: "restart-1", task_type: "publish_post" }});
            assert.equal(summary.count, 2);
            assert.equal(summary.target, "发布第1/2篇");
            """
        )
        self._run_node(harness)

    def test_live_browser_manual_input_is_an_overlay_with_compact_trigger(self):
        render_start = self.source.index("function renderLiveBrowserSession(session)")
        render_end = self.source.index("let liveBrowserModalTrigger", render_start)
        render = self.source[render_start:render_end]
        frame_start = render.index('<div class="live-browser-frame">')
        frame_end = render.index('<div class="live-browser-interaction-note">')
        frame_markup = render[frame_start:frame_end]

        overlay_anchor = self.styles.index(".console-page .live-browser-manual-input[hidden]")
        overlay_start = self.styles.index(".console-page .live-browser-manual-input {", overlay_anchor)
        overlay = self._css_block(".console-page .live-browser-manual-input {", overlay_start)
        tools_start = self.styles.index(".console-page .live-browser-tools {", overlay_anchor)
        tools = self._css_block(".console-page .live-browser-tools {", tools_start)
        toggle_start = self.styles.index(".console-page .live-browser-input-toggle {", overlay_anchor)
        toggle = self._css_block(".console-page .live-browser-input-toggle {", toggle_start)

        self.assertIn('data-live-browser-manual-input', frame_markup)
        self.assertIn('title="输入验证码或文本"', frame_markup)
        self.assertNotIn('<span>输入验证码或文本</span>', frame_markup)
        self.assertIn("<span>\u8f93\u5165</span>", frame_markup)
        self.assertIn("<input", frame_markup)
        self.assertIn('type="text"', frame_markup)
        self.assertIn('aria-hidden="true" inert', frame_markup)
        self.assertLess(
            frame_markup.index('class="live-browser-lock"'),
            frame_markup.index('data-live-browser-manual-input'),
        )
        self.assertIn("position: absolute;", overlay)
        self.assertIn("left: 16px;", overlay)
        self.assertIn("right: 16px;", overlay)
        self.assertIn("pointer-events: none;", overlay)
        self.assertIn("width: 0;", tools)
        self.assertIn("visibility: hidden;", tools)
        self.assertIn("transition: width 240ms ease", tools)
        self.assertIn('data-expanded="true"', self.styles)
        self.assertIn("width: min(390px, calc(100% - 74px));", self.styles)
        self.assertIn("display: inline-flex;", toggle)
        self.assertIn("min-height: 44px;", toggle)
        self.assertIn(".console-page .live-browser-tools input {", self.styles)
        self.assertIn('manualInput.dataset.expanded = opening ? "true" : "false";', self.source)
        self.assertIn('tools.toggleAttribute("inert", !opening);', self.source)
        self.assertNotIn("tools.hidden = !opening;", self.source)

    def test_social_cancel_buttons_show_immediate_feedback_before_request_finishes(self):
        cancel_source = self._function_source("cancelSocialAutomationTask")
        pending_source = self._function_source("setSocialTaskCancelPending")
        cancel_all_source = self._function_source("cancelAllSocialAutomationTasks")

        self.assertIn("socialTaskCancelPendingIds.has(cleanTaskId)", cancel_source)
        self.assertLess(
            cancel_source.index("showMsg(messageId, \"正在停止自动化任务...\""),
            cancel_source.index("await api("),
        )
        self.assertIn("closeConsoleDropdowns();", cancel_source)
        self.assertIn('button.setAttribute("aria-busy", "true");', pending_source)
        self.assertIn('button.textContent = "停止中...";', pending_source)
        self.assertIn("loadSocial({ force: true }).catch(() => {});", cancel_source)
        self.assertNotIn("await loadSocial", cancel_source)
        self.assertLess(
            cancel_all_source.index("showMsg(messageId, \"正在停止全部自动化任务...\""),
            cancel_all_source.index("await api("),
        )
        self.assertIn("Promise.all([", cancel_all_source)
        self.assertNotIn("await Promise.all", cancel_all_source)

    def test_persona_normal_and_batch_compose_inputs_are_isolated_and_clear_without_resurrection(self):
        functions = "\n".join(
            self._function_source(name)
            for name in (
                "normalizePersonaDraftForm",
                "personaComposeDraftInputKey",
                "ensurePersonaComposeDraftInputs",
                "storePersonaComposeDraftInput",
                "restorePersonaComposeDraftInput",
                "clearPersonaDraftComposerInputs",
                "personaComposePendingMediaStateKey",
                "snapshotPersonaCurrentForm",
            )
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const titleInput = {{ value: "" }};
            const contentInput = {{ value: "" }};
            const state = {{ renderedPersonaId: "persona-1" }};
            const document = {{ querySelector() {{ return null; }}, querySelectorAll() {{ return []; }} }};
            const PERSONA_GENERATE_DEFAULT_COUNT = 5;
            const PERSONA_GENERATE_MAX_COUNT = 10;
            const PERSONA_GENERATE_DEFAULT_TARGET_WORDS = 100;
            const uploadFiles = new Map();
            const form = {{
              generate: {{ composeMode: "tweet", prompt: "旧版残留正文" }},
              draft: {{ title: "", content: "" }},
              media: {{}},
            }};
            function personaFormState() {{ return form; }}
            function $(id) {{
              if (id === "personaDraftTitle") return titleInput;
              if (id === "personaDraftContent") return contentInput;
              return null;
            }}
            function syncPersonaGenerateActionState() {{}}
            function syncPersonaDraftDirty() {{ return false; }}
            function normalizePersonaMediaGenerationForm() {{}}
            function clearPersonaPostDirections() {{}}
            function clearUploadDropzoneState(inputId, stateKey) {{
              assert.equal(inputId, "personaPostMediaUploadFiles");
              uploadFiles.set(stateKey, []);
            }}
            function defaultPersonaDraftForm(overrides = {{}}) {{
              return {{
                title: "", content: "", editingPostId: "", editingSource: "posts",
                originalTitle: "", originalContent: "", stagedReferenceContent: null,
                originalMediaSignature: "", mediaItems: [], mediaOps: [], dirty: false,
                rewriteSourcePostId: "", ...overrides,
              }};
            }}
            function defaultPersonaComposeDraftInput(overrides = {{}}) {{
              return {{ title: "", content: "", ...overrides }};
            }}
            {functions}

            form.draft = defaultPersonaDraftForm({{ title: "普通标题", content: "普通正文" }});
            storePersonaComposeDraftInput(form);
            form.generate.composeMode = "tweet_media";
            restorePersonaComposeDraftInput(form, "tweet_media");
            assert.equal(form.draft.title, "");
            assert.equal(form.draft.content, "");

            form.draft.title = "批量标题";
            form.draft.content = "批量正文";
            storePersonaComposeDraftInput(form);
            form.generate.composeMode = "tweet";
            restorePersonaComposeDraftInput(form, "tweet");
            assert.equal(form.draft.title, "普通标题");
            assert.equal(form.draft.content, "普通正文");

            titleInput.value = form.draft.title;
            contentInput.value = form.draft.content;
            const normalMediaKey = personaComposePendingMediaStateKey({{ id: "persona-1" }}, "tweet");
            const batchMediaKey = personaComposePendingMediaStateKey({{ id: "persona-1" }}, "tweet_media");
            assert.notEqual(normalMediaKey, batchMediaKey);
            uploadFiles.set(normalMediaKey, ["normal-image.png"]);
            uploadFiles.set(batchMediaKey, ["batch-image.png"]);
            clearPersonaDraftComposerInputs("persona-1", "tweet");
            assert.equal(titleInput.value, "");
            assert.equal(contentInput.value, "");
            assert.equal(form.generate.prompt, "");
            assert.deepEqual(uploadFiles.get(normalMediaKey), []);
            assert.deepEqual(uploadFiles.get(batchMediaKey), ["batch-image.png"]);
            if (!String(form.draft.content || "").trim() && String(form.generate.prompt || "").trim()) {{
              form.draft.content = String(form.generate.prompt || "");
              form.generate.prompt = "";
            }}
            assert.equal(form.draft.content, "");
            snapshotPersonaCurrentForm();
            assert.equal(form.generate.composeDraftInputs.tweet.title, "");
            assert.equal(form.generate.composeDraftInputs.tweet.content, "");

            form.generate.composeMode = "tweet_media";
            restorePersonaComposeDraftInput(form, "tweet_media");
            assert.equal(form.draft.title, "批量标题");
            assert.equal(form.draft.content, "批量正文");
            """
        )
        self._run_node(harness)

    def test_multi_publish_submission_sends_one_batch_and_sequence_metadata(self):
        submit_publish = f"async {self._function_source('submitPublishContentTasks')}"
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const PUBLISH_MULTI_SELECT_LIMIT = 2;
            const PUBLISH_MULTI_SELECT_LIMIT_MESSAGE = "单次连续发布最多选择 5 篇。";
            function publishBatchLimit(platform) {{ return platform === "instagram" ? 1 : 2; }}
            const requests = [];
            const state = {{
              socialTaskToastLabels: {{}},
              socialTaskToastBatches: {{}},
              socialTaskToastKeys: {{}},
            }};
            function selectedPersona() {{ return {{ id: "persona-1" }}; }}
            function normalizePublishContentSource() {{ return "posts"; }}
            function publishAccountForPersona() {{
              return {{ id: "account-1", platform: "threads", username: "publisher" }};
            }}
            async function promptPersonaAccountBinding() {{}}
            function canSubmitPublishWithAccount() {{ return true; }}
            function publishAccountBlockMessage() {{ return ""; }}
            function publishSourceRows() {{
              return [
                {{ id: "post-1", content: "one" }},
                {{ id: "post-2", content: "two" }},
            ];
            }}
            function syncPublishSelectedPostIds() {{ return ["post-1", "post-2"]; }}
            function publishContentSourceLabel() {{ return "草稿"; }}
            function normalizeScheduleValueForApi() {{ return ""; }}
            function $() {{ return null; }}
            async function ensureDailyPublishCapacity() {{ return true; }}
            function socialTaskToastLaneKey() {{ return "batch-toast"; }}
            function isActionLocked() {{ return false; }}
            function activeSocialTaskFor() {{ return null; }}
            function setActionLocked() {{}}
            async function uploadAutomationMedia() {{ return []; }}
            function filesFromInput() {{ return []; }}
            function showMsg() {{}}
            function publishContentForPost(post) {{ return post.content; }}
            async function api(url, options) {{
              const body = JSON.parse(options.body);
              requests.push({{ url, body }});
              return {{
                task: {{
                  id: `task-${{requests.length}}`,
                  task_type: "publish_post",
                  payload: {{ archive_post_id: `post-${{requests.length}}` }},
                }},
              }};
            }}
            function socialTaskPayload(task) {{ return task?.payload || {{}}; }}
            function mergeSocialTaskState() {{}}
            function registerSocialTaskToastBatch() {{}}
            function syncSocialTaskToast() {{}}
            function isFutureScheduledSocialTask() {{ return false; }}
            function refreshLiveBrowserSessionsSoon() {{}}
            async function watchPersonaPublishTaskSequence() {{}}
            async function loadSocial() {{}}
            async function loadPersonaDraftPosts() {{}}
            async function loadPersonaFavoritePosts() {{}}
            function clearUploadDropzoneState() {{}}
            {submit_publish}

            (async () => {{
              const results = await submitPublishContentTasks("account-1", {{ id: "persona-1" }});
              assert.equal(results.length, 2);
              assert.equal(requests.length, 2);
              const batchIds = new Set(requests.map((item) => item.body.publish_batch_id));
              assert.equal(batchIds.size, 1);
              assert.ok([...batchIds][0].startsWith("publish_batch_"));
              assert.deepEqual(
                requests.map((item) => item.body.publish_sequence_index),
                [1, 2],
              );
              assert.deepEqual(
                requests.map((item) => item.body.publish_sequence_total),
                [2, 2],
              );
              for (const request of requests) {{
                assert.deepEqual(
                  request.body.publish_sequence_targets,
                  ["发布第1篇", "发布第2篇"],
                );
                assert.ok(!request.body.publish_sequence_targets.join("").includes("threads"));
                assert.ok(!request.body.publish_sequence_targets.join("").includes("publisher"));
              }}
              assert.ok(submitPublishContentTasks.toString().includes("Promise.allSettled(submissions)"));
              assert.ok(submitPublishContentTasks.toString().includes("/cancel"));
              assert.ok(submitPublishContentTasks.toString().includes(".catch(() => api(publishPath, publishOptions))"));
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_publish_selection_state_caps_every_multi_select_path_at_platform_limit(self):
        sync_selection = self._function_source("syncPublishSelectedPostIds")
        set_selection = self._function_source("setPublishSelectedPostIds")
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const PUBLISH_MULTI_SELECT_LIMIT = 2;
            function publishBatchLimit() {{ return 2; }}
            function publishSelectionLimit() {{ return 2; }}
            const posts = Array.from({{ length: 6 }}, (_, index) => ({{ id: `post-${{index + 1}}` }}));
            const state = {{
              publishSelectedPostIds: {{ "persona-1::threads::posts": posts.map((post) => post.id) }},
              selectedPersonaPostId: "",
              publishPreviewPostId: "",
            }};
            function selectedPersona() {{ return {{ id: "persona-1" }}; }}
            function normalizePublishContentSource() {{ return "posts"; }}
            function personaContentPlatform() {{ return "threads"; }}
            function publishSelectionKey() {{ return "persona-1::threads::posts"; }}
            function publishSourceRows() {{ return posts; }}
            function setSelectedPersonaPostId(id) {{ state.selectedPersonaPostId = id; }}
            {sync_selection}
            {set_selection}

            assert.deepEqual(syncPublishSelectedPostIds(selectedPersona(), "posts", posts), [
              "post-1", "post-2",
            ]);
            setPublishSelectedPostIds(selectedPersona(), "posts", posts.map((post) => post.id));
            assert.deepEqual(state.publishSelectedPostIds["persona-1::threads::posts"], [
              "post-1", "post-2",
            ]);
            """
        )
        self._run_node(harness)

    def test_single_publish_submission_uses_minimal_non_batch_payload(self):
        submit_publish = f"async {self._function_source('submitPublishContentTasks')}"
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const PUBLISH_MULTI_SELECT_LIMIT = 5;
            const PUBLISH_MULTI_SELECT_LIMIT_MESSAGE = "单次连续发布最多选择 5 篇。";
            function publishBatchLimit(platform) {{ return platform === "instagram" ? 1 : 2; }}
            const requests = [];
            const state = {{
              socialTaskToastLabels: {{}},
              socialTaskToastBatches: {{}},
              socialTaskToastKeys: {{}},
            }};
            function selectedPersona() {{ return {{ id: "persona-1" }}; }}
            function normalizePublishContentSource() {{ return "posts"; }}
            function publishAccountForPersona() {{
              return {{ id: "account-1", platform: "threads", username: "publisher" }};
            }}
            async function promptPersonaAccountBinding() {{}}
            function canSubmitPublishWithAccount() {{ return true; }}
            function publishAccountBlockMessage() {{ return ""; }}
            function publishSourceRows() {{ return [{{ id: "post-1", content: "one" }}]; }}
            function syncPublishSelectedPostIds() {{ return ["post-1"]; }}
            function publishContentSourceLabel() {{ return "draft"; }}
            function normalizeScheduleValueForApi() {{ return ""; }}
            function $() {{ return null; }}
            async function ensureDailyPublishCapacity() {{ return true; }}
            function socialTaskToastLaneKey() {{ return "publish-toast"; }}
            function isActionLocked() {{ return false; }}
            function activeSocialTaskFor() {{ return null; }}
            function setActionLocked() {{}}
            async function uploadAutomationMedia() {{ return []; }}
            function filesFromInput() {{ return []; }}
            function showMsg() {{}}
            function publishContentForPost(post) {{ return post.content; }}
            async function api(url, options) {{
              const body = JSON.parse(options.body);
              requests.push({{ url, body }});
              return {{
                task: {{
                  id: "task-1",
                  task_type: "publish_post",
                  payload: {{ archive_post_id: "post-1" }},
                }},
              }};
            }}
            function socialTaskPayload(task) {{ return task?.payload || {{}}; }}
            function mergeSocialTaskState() {{}}
            function registerSocialTaskToastBatch() {{}}
            function syncSocialTaskToast() {{}}
            function isFutureScheduledSocialTask() {{ return false; }}
            function refreshLiveBrowserSessionsSoon() {{}}
            async function watchPersonaPublishTaskSequence() {{}}
            async function loadSocial() {{}}
            async function loadPersonaDraftPosts() {{}}
            async function loadPersonaFavoritePosts() {{}}
            function clearUploadDropzoneState() {{}}
            {submit_publish}

            (async () => {{
              const results = await submitPublishContentTasks("account-1", {{ id: "persona-1" }});
              assert.equal(results.length, 1);
              assert.equal(requests.length, 1);
              assert.equal(requests[0].body.max_retries, 0);
              assert.equal(Object.hasOwn(requests[0].body, "publish_batch_id"), false);
              assert.equal(Object.hasOwn(requests[0].body, "publish_sequence_index"), false);
              assert.equal(Object.hasOwn(requests[0].body, "publish_sequence_total"), false);
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_instagram_publish_without_media_opens_resolution_modal_before_submit(self):
        submit_publish = f"async {self._function_source('submitPublishContentTasks')}"
        modal_source = self._function_source("requestInstagramPublishMediaResolution")
        self.assertIn('modalKey: "instagram-media-required"', modal_source)
        self.assertIn('cancelText: "暂不处理"', modal_source)
        self.assertIn('confirmText: "跳转生成页面"', modal_source)
        self.assertNotIn("contentHtml", modal_source)
        self.assertIn("openInstagramMediaGenerationPage", modal_source)
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const PUBLISH_MULTI_SELECT_LIMIT = 5;
            const PUBLISH_MULTI_SELECT_LIMIT_MESSAGE = "单次连续发布最多选择 5 篇。";
            function publishBatchLimit(platform) {{ return platform === "instagram" ? 1 : 2; }}
            const requests = [];
            const resolutions = [];
            let capacityChecks = 0;
            let actionLocks = 0;
            const state = {{ activeModule: "publishing" }};
            function selectedPersona() {{ return {{ id: "persona-1" }}; }}
            function normalizePublishContentSource() {{ return "posts"; }}
            function publishAccountForPersona() {{
              return {{ id: "account-instagram", platform: "instagram", username: "publisher" }};
            }}
            async function promptPersonaAccountBinding() {{}}
            function canSubmitPublishWithAccount() {{ return true; }}
            function publishAccountBlockMessage() {{ return ""; }}
            function publishSourceRows() {{ return [{{ id: "post-no-media", content: "pure text", media_items: [] }}]; }}
            function syncPublishSelectedPostIds() {{ return ["post-no-media"]; }}
            function publishContentSourceLabel() {{ return "草稿"; }}
            async function ensureDailyPublishCapacity() {{ capacityChecks += 1; return true; }}
            function socialTaskToastLaneKey() {{ return "batch-toast"; }}
            function isActionLocked() {{ return false; }}
            function activeSocialTaskFor() {{ return null; }}
            function setActionLocked() {{ actionLocks += 1; }}
            async function uploadAutomationMedia() {{ return []; }}
            function filesFromInput() {{ return []; }}
            function personaPublishPostMediaItems() {{ return []; }}
            async function requestInstagramPublishMediaResolution(options) {{
              resolutions.push(options);
              return true;
            }}
            function showMsg() {{}}
            function renderSimpleFlowModule() {{}}
            async function api(url, options) {{
              requests.push({{ url, options }});
              return {{}};
            }}
            {submit_publish}

            (async () => {{
              const persona = {{ id: "persona-1" }};
              const result = await submitPublishContentTasks("account-instagram", persona);
              assert.equal(result, null);
              assert.equal(requests.length, 0);
              assert.equal(resolutions.length, 1);
              assert.equal(capacityChecks, 0);
              assert.equal(actionLocks, 0);
              assert.equal(resolutions[0].persona, persona);
              assert.equal(resolutions[0].source, "posts");
              assert.equal(resolutions[0].post.id, "post-no-media");
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_instagram_media_resolution_reuses_existing_generation_page(self):
        open_editor = f"async {self._function_source('openInstagramMediaGenerationPage')}"
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const calls = [];
            const form = {{
              generate: {{ composeMode: "tweet" }},
              media: {{ contentMode: "", operationMode: "" }},
            }};
            function selectedPersona() {{ return null; }}
            function setSelectedPersonaId(value) {{ calls.push(["persona", value]); }}
            function setPersonaPostSource(value) {{ calls.push(["source", value]); }}
            function setSelectedPersonaPostId(value) {{ calls.push(["post", value]); }}
            function personaFormState() {{ return form; }}
            function setWorkspaceModule(value) {{ calls.push(["module", value]); }}
            function openPersonaDraftEditor(value) {{ calls.push(["editor", value]); }}
            {open_editor}

            (async () => {{
              const persona = {{ id: "persona-1" }};
              const post = {{ id: "post-1" }};
              assert.equal(await openInstagramMediaGenerationPage({{ persona, source: "posts", post }}), true);
              assert.equal(form.generate.composeMode, "tweet_media");
              assert.equal(form.media.contentMode, "draft");
              assert.equal(form.media.operationMode, "generate");
              assert.deepEqual(calls.slice(-2), [["module", "tweet_generation"], ["editor", "post-1"]]);
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_live_browser_action_menu_closes_on_outside_and_guards_iframe(self):
        close_menus = self._function_source("closeLiveBrowserActionMenus")
        bind_events = self._function_source("bindEvents")
        open_menu_guard = self._css_block(
            ".console-page .live-browser-panel:has(.live-browser-action-menu[open]) iframe {"
        )

        self.assertIn('document.querySelectorAll(".live-browser-action-menu[open]")', close_menus)
        self.assertIn('document.addEventListener("click", (event) => {', bind_events)
        self.assertIn('event.target.closest(".live-browser-action-menu")', bind_events)
        self.assertIn("pointer-events: none;", open_menu_guard)
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const first = {{ removed: false, removeAttribute() {{ this.removed = true; }} }};
            const second = {{ removed: false, removeAttribute() {{ this.removed = true; }} }};
            const document = {{
              querySelectorAll(selector) {{
                assert.equal(selector, ".live-browser-action-menu[open]");
                return [first, second];
              }},
            }};
            {close_menus}

            closeLiveBrowserActionMenus(second);
            assert.equal(first.removed, true);
            assert.equal(second.removed, false);
            """
        )
        self._run_node(harness)

    def test_account_browser_actions_bind_to_the_owning_shell(self):
        bind_events = self._function_source("bindEvents")

        for event_name in ("click", "keydown", "change"):
            self.assertIn(
                f'if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("{event_name}", {"async " if event_name == "click" else ""}(event) => {{',
                bind_events,
            )
        self.assertNotIn('event.target.closest(".account-pool-create-panel")', bind_events)
        self.assertIn('const liveBrowserMode = event.target.closest("[data-live-browser-mode]")', bind_events)

    def test_account_pool_visible_checkbox_uses_the_multi_select_path(self):
        bind_events = self._function_source("bindEvents")
        change_events = bind_events[
            bind_events.index('$("moduleBody").addEventListener("change"'):
            bind_events.index('if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("click"')
        ]
        account_events = bind_events[
            bind_events.index('if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("click"'):
            bind_events.index('if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("keydown"')
        ]

        self.assertIn('event.target?.matches?.("[data-account-pool-check]")', change_events)
        self.assertIn("toggleAccountPoolAccount(event.target.dataset.accountPoolCheck", change_events)
        self.assertIn(".account-pool-card-check", account_events)

    def test_account_pool_does_not_mount_the_removed_persona_picker(self):
        pool = self._function_source("renderAccountPool")
        self.assertIn("renderAccountPoolPlatformTabs()", pool)
        self.assertIn("renderAccountPoolCards(accounts, selectedAccount)", pool)
        self.assertNotIn("accountPoolPersonaSidebar", pool)
        self.assertNotIn("renderPersonaPicker", pool)

    def test_account_pool_copy_controls_only_transfer_username_password_and_totp(self):
        card = self._section("function renderAccountPoolCard", "function renderAccountPoolCards")
        cards = self._function_source("renderAccountPoolCards")
        editor = self._function_source("openAccountPoolEditorModal")
        identity = self._function_source("renderAccountIdentityFields")
        copy_one = self._function_source("copyAccountPoolCardToClipboard")
        paste = self._function_source("pasteAccountPoolCardFromClipboard")
        apply = self._function_source("applyAccountClipboardFields")
        duplicate = self._function_source("duplicateAccountPoolSelectedAccounts")
        create_save = self._function_source("saveAccountPoolCreateForm")
        edit_save = self._function_source("saveAccountPoolEditForm")
        bind_events = self._function_source("bindEvents")

        self.assertIn("data-account-pool-copy-card", card)
        self.assertIn("renderAccountPoolPlatformIcon", card)
        self.assertIn("account-pool-card-platform", card)
        self.assertIn('title="复制账号卡"', cards)
        self.assertIn("openAccountPoolDuplicateModal", bind_events)
        self.assertIn("/credentials", copy_one)
        self.assertNotIn("/card-transfer", copy_one)
        self.assertIn("serializeAccountClipboardText", copy_one)
        self.assertIn("parseAccountClipboardText", paste)
        self.assertIn("data-account-pool-paste-card", editor)
        self.assertNotIn('editing ? "" : `<button type="button" class="account-pool-paste-card-button"', editor)
        self.assertIn("navigator.clipboard.readText", paste)
        self.assertNotIn("VECTO_ACCOUNT_CARD_V1.", paste)
        self.assertIn("applyAccountClipboardFields", paste)
        self.assertIn("/duplicate", duplicate)
        self.assertIn("target_platform", duplicate)
        self.assertNotIn("display_name", create_save)
        self.assertNotIn("display_name", edit_save)
        self.assertNotIn("DisplayName", identity)
        self.assertNotIn("LoginUsername", identity)
        self.assertNotIn("显示名称", identity)
        self.assertNotIn("登录账号", identity)
        self.assertIn("fields.login_password", apply)
        self.assertIn("fields.totp_secret_or_uri", apply)
        self.assertIn('password.dataset.passwordDirty = "true"', apply)
        self.assertIn("totp_secret_or_uri", create_save)
        self.assertNotIn("/card-transfer", create_save)
        self.assertNotIn("/card-transfer", edit_save)
        self.assertIn("/totp", edit_save)
        self.assertNotIn("data-account-card-paste-summary", self.source)

    def test_account_pool_clipboard_is_only_three_plain_text_fields(self):
        serialize = self._function_source("serializeAccountClipboardText")
        parse = self._function_source("parseAccountClipboardText")
        copy_one = self._function_source("copyAccountPoolCardToClipboard")

        self.assertIn('"账号: "', serialize)
        self.assertIn('"密码: "', serialize)
        self.assertIn('"2FA: "', serialize)
        self.assertNotIn("JSON.stringify", serialize)
        self.assertNotIn("platform", serialize)
        self.assertNotIn("proxy", serialize)
        self.assertNotIn("persona", serialize)
        self.assertIn("username", parse)
        self.assertIn("login_password", parse)
        self.assertIn("totp_secret_or_uri", parse)
        self.assertIn("copyTextToClipboard(state.accountClipboardText)", copy_one)
        self.assertIn(
            'showMsg("socialMsg", "账号、密码和 2FA 已复制到剪贴板", true)',
            copy_one,
        )

    def test_account_pool_clipboard_reuses_current_page_text_before_browser_read(self):
        copy_one = self._function_source("copyAccountPoolCardToClipboard")
        paste = self._function_source("pasteAccountPoolCardFromClipboard")
        clear_tenant = self._function_source("clearTenantInMemoryState")

        self.assertIn(
            "state.accountClipboardText = serializeAccountClipboardText",
            copy_one,
        )
        self.assertIn(
            'let text = String(state.accountClipboardText || "").trim()',
            paste,
        )
        self.assertIn("if (!text && navigator.clipboard?.readText)", paste)
        self.assertNotIn("window.prompt", paste)
        self.assertLess(
            paste.index("state.accountClipboardText"),
            paste.index("navigator.clipboard?.readText"),
        )
        self.assertIn('state.accountClipboardText = "";', clear_tenant)
        self.assertNotIn("showMsg", paste)

    def test_account_pool_copy_success_temporarily_replaces_the_copy_icon(self):
        success = self._function_source("showAccountPoolCardCopySuccess")
        bind_events = self._function_source("bindEvents")

        self.assertIn('classList.add("is-copy-success")', success)
        self.assertIn("window.setTimeout", success)
        self.assertIn("1800", success)
        self.assertIn('classList.remove("is-copy-success")', success)
        self.assertIn("renderClipboardIcon()", success)
        self.assertIn("renderAutomationPlanCheckIcon()", success)
        self.assertIn(".then(() => showAccountPoolCardCopySuccess(accountCopyCard))", bind_events)

    def test_account_card_platform_logo_and_compact_status_copy_have_styles(self):
        self.assertIn(".account-pool-card-platform", self.styles)
        self.assertIn(".account-pool-card-platform > svg", self.styles)
        self.assertIn(".account-pool-card-copy-button", self.styles)
        self.assertIn(".account-pool-card-copy-button.is-copy-success", self.styles)
        self.assertIn(".account-pool-create-modal-head-actions", self.styles)
        self.assertIn(".account-pool-paste-card-button", self.styles)
        self.assertIn(".account-pool-card .account-pool-card-flags .status", self.styles)
        self.assertIn(".account-pool-card .account-totp-badge", self.styles)
        self.assertIn("font-size: 10px;", self.styles)

    def test_account_clipboard_write_falls_back_when_permission_is_denied(self):
        copy_text = self._function_source("copyTextToClipboard")

        self.assertIn("navigator.clipboard?.writeText", copy_text)
        self.assertIn("catch", copy_text)
        self.assertIn('document.execCommand("copy")', copy_text)
        self.assertLess(copy_text.index("catch"), copy_text.index('document.execCommand("copy")'))

    def test_account_copy_and_paste_controls_have_mobile_touch_targets(self):
        paste_start = self.styles.index(".account-pool-paste-card-button {")
        copy_start = self.styles.index(".account-pool-card-copy-button {")
        paste_rule = self.styles[paste_start:self.styles.index("}", paste_start) + 1]
        copy_rule = self.styles[copy_start:self.styles.index("}", copy_start) + 1]

        self.assertIn("min-width: 44px", paste_rule)
        self.assertIn("min-height: 44px", paste_rule)
        self.assertIn("min-width: 28px", copy_rule)
        self.assertIn("min-height: 28px", copy_rule)

    def test_account_proxy_picker_replaces_legacy_edit_checkbox_and_keeps_single_binding(self):
        card = self._section("function renderAccountPoolCard", "function renderAccountPoolCards")
        picker = self._function_source("openAccountProxyPickerModal")
        modal = self._function_source("openAccountPoolEditorModal")
        edit_entry = self._function_source("openAccountPoolEditModal")
        editor = self._function_source("renderAccountEditorForm")
        save = self._function_source("saveAccountPoolEditForm")
        commit = self._function_source("commitAccountProxyPickerSelection")
        clear_password = self._function_source("clearAccountPasswordReveal")

        self.assertIn('data-account-proxy-picker="${esc(accountId)}"', card)
        self.assertIn("accountProxyOptionCardsHtml(selectedProxyId", picker)
        self.assertIn("commitAccountProxyPickerSelection", picker)
        self.assertIn("saveAccountProxyBinding", commit)
        self.assertIn("accountProxyBindingChanged(expectedProxyId, selectedProxyId)", commit)
        self.assertIn("modal.remove()", commit)
        self.assertIn("await claimAccountProxyPoolOption", picker)
        self.assertIn("await commitAccountProxyPickerSelection(modal, account.id, claimedProxyId)", picker)
        self.assertIn("await commitAccountProxyPickerSelection(modal, account.id, proxyId)", picker)
        self.assertIn('const originalProxyId = String(account.proxy_id || "").trim()', picker)
        self.assertNotIn("data-account-proxy-picker-save", picker)
        self.assertNotIn('<div class="console-modal-actions">', picker)
        self.assertIn("reconcileAccountProxyBindingConflict", commit)
        self.assertIn('const selectedProxyId = String(account?.proxy_id || "").trim()', modal)
        self.assertIn("modal.dataset.selectedProxyId = selectedProxyId", modal)
        self.assertIn("modal.dataset.originalProxyId = selectedProxyId", modal)
        self.assertIn("renderAccountEditorForm(account, mode)", modal)
        self.assertIn("renderAccountProxyPickerPanel(account, mode)", editor)
        self.assertIn('event.target.closest("[data-account-proxy-picker-open]")', modal)
        self.assertNotIn("commitAccountProxyPickerSelection", modal)
        self.assertNotIn('accountResidentialProxyFormHtml("accountPoolEdit"', modal)
        self.assertIn('clearAccountPasswordReveal(accountId, "pool-edit")', modal)
        self.assertIn("openAccountPoolEditorModal({ account })", edit_entry)
        self.assertIn("delete state.accountPasswordValues[cleanId]", clear_password)
        self.assertIn("delete state.accountPasswordVisible[accountPasswordStateKey(cleanId, scope)]", clear_password)
        self.assertIn('const selectedProxyId = String(editModal?.dataset.selectedProxyId || "").trim()', save)
        self.assertIn("accountProxyBindingChanged(originalProxyId, selectedProxyId)", save)
        self.assertIn("payload.expected_proxy_id = originalProxyId", save)
        self.assertIn("payload.proxy_id = selectedProxyId", save)
        self.assertIn("payload.clear_residential_proxy = true", save)
        self.assertNotIn("payload.residential_proxy", save)

    def test_account_create_uses_the_full_editor_instead_of_the_legacy_form(self):
        editor = self._function_source("renderAccountEditorForm")
        identity = self._function_source("renderAccountIdentityFields")
        automation_create = self._function_source("createPersonaAutomationAccount")
        automation_module = self._function_source("renderUnifiedAutomationModule")
        modal = self._function_source("openAccountPoolEditorModal")
        create_entry = self._function_source("openAccountPoolCreateModal")
        edit_modal = self._function_source("openAccountPoolEditModal")
        save = self._function_source("saveAccountPoolCreateForm")

        self.assertIn("renderAccountIdentityFields(account, mode)", editor)
        self.assertIn("renderAccountTotpSection(account, mode)", editor)
        self.assertIn("renderAccountProxyPickerPanel(account, mode)", editor)
        self.assertIn("data-account-totp-create-stage", self._function_source("renderAccountTotpSection"))
        self.assertIn("<span>2FA 密钥</span>", self._function_source("renderAccountTotpSection"))
        self.assertIn("2FA 未配置", self._function_source("renderAccountTotpSection"))
        self.assertIn("renderAccountEditorForm(account, mode)", modal)
        self.assertIn('event.target.closest("[data-account-totp-create-stage]")', modal)
        self.assertIn("openAccountPoolEditorModal(options)", create_entry)
        self.assertIn("openAccountPoolEditorModal({ account })", edit_modal)
        self.assertNotIn("renderAccountCreatePasswordField", self.source)
        self.assertNotIn("renderAccountCreateTotpSection", self.source)
        self.assertIn('scope: editing ? "pool-edit" : "pool-create"', identity)
        self.assertIn("renderAccountPasswordField(account", identity)
        self.assertNotIn("accountPoolCreateFormHtml", self.source)
        self.assertNotIn("accountResidentialProxyFormHtml", self.source)
        self.assertIn("openAccountPoolCreateModal", automation_create)
        self.assertNotIn('api("/api/persona_dashboard/automation/accounts"', automation_create)
        self.assertIn("data-persona-manage-account", automation_module)
        self.assertNotIn("personaAutoLoginUsername", automation_module)
        self.assertNotIn("personaAutoLoginPassword", automation_module)
        self.assertNotIn("data-persona-save-login", self.source)
        self.assertNotIn("data-persona-clear-login", self.source)
        self.assertNotIn("data-persona-account-save", self.source)
        self.assertNotIn("data-persona-account-cancel-edit", self.source)
        self.assertNotIn("persona-account-pool-card--inline-edit", self.source)
        self.assertIn('"vecto:open-account-editor"', self.source)
        self.assertNotIn('"vecto:open-account-editor"', self.persona_dashboard_source)
        self.assertNotIn("personaAutoLoginUsername", self.persona_dashboard_source)
        self.assertNotIn("personaAutoLoginPassword", self.persona_dashboard_source)
        self.assertNotIn("personaAutoCreateAccount", self.persona_dashboard_source)
        self.assertIn("modal.dataset.selectedProxyId = selectedProxyId", modal)
        self.assertIn('event.target.closest("[data-account-proxy-picker-open]")', modal)
        self.assertNotIn("saveAccountInlineCustomProxy", modal)
        self.assertIn('payload.proxy_id = selectedProxyId', save)
        self.assertIn('payload.totp_secret_or_uri = totpSecret', save)
        self.assertNotIn("payload.residential_proxy", save)

    def test_account_proxy_picker_matches_backend_eligibility_and_tracks_real_changes(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            function proxyStatusLabel(value = "") {{
              return {{ active: "正常", inactive: "停用", pending: "待检测", failed: "异常" }}[String(value || "").toLowerCase()] || String(value || "");
            }}
            {self._function_source("accountProxyEligibility")}
            {self._function_source("accountProxyBindingChanged")}

            const now = 2000;
            const valid = {{ ip_type: "static_residential", expires_at: 3000, status: "active", last_check_at: 1900, last_check_result: {{ ok: true }} }};
            assert.deepStrictEqual(accountProxyEligibility(null, now), {{ eligible: true, reason: "" }});
            assert.strictEqual(accountProxyEligibility(valid, now).eligible, true);
            assert.strictEqual(accountProxyEligibility({{ ...valid, ip_type: "datacenter", market_item_id: "market-1" }}, now).eligible, true);
            assert.strictEqual(accountProxyEligibility({{ ...valid, ip_type: "datacenter", market_item_id: "" }}, now).reason, "仅支持静态住宅 IP 或系统导入的机房代理");
            assert.strictEqual(accountProxyEligibility({{ ...valid, expires_at: now }}, now).reason, "已过期");
            assert.strictEqual(accountProxyEligibility({{ ...valid, status: "inactive" }}, now).eligible, false);
            assert.strictEqual(accountProxyEligibility({{ ...valid, last_check_at: 0 }}, now).reason, "未通过网络检测");
            assert.strictEqual(accountProxyEligibility({{ ...valid, last_check_result: {{ ok: false }} }}, now).eligible, false);
            assert.strictEqual(accountProxyBindingChanged("proxy-a", "proxy-a"), false);
            assert.strictEqual(accountProxyBindingChanged("proxy-a", "proxy-b"), true);
            assert.strictEqual(accountProxyBindingChanged("", ""), false);
            """
        )
        self._run_node(harness)

        options = self._section("function accountProxyOptionCardsHtml", "function updateAccountProxyChoice")
        status_refresh = self._function_source("updateAccountStatusViews")
        binding_save = self._function_source("saveAccountProxyBinding")
        self.assertIn("proxy-market-mini-card", options)
        self.assertIn("data-account-proxy-market-choice", options)
        self.assertIn("systemProxyPoolLocation(proxy)", options)
        self.assertIn("data-account-proxy-options", options)
        self.assertIn("[data-account-proxy-for]", status_refresh)
        self.assertIn("[data-account-proxy-picker]", status_refresh)
        self.assertIn("expected_proxy_id", binding_save)

        reconcile = self._function_source("reconcileAccountProxyBindingConflict")
        self.assertIn("fetchSocialDataShared({ force: true })", reconcile)
        self.assertIn("accountProxyBindingChanged(originalProxyId, latestProxyId)", reconcile)
        self.assertIn("refreshAccountProxyPickerOptions(modal)", reconcile)
        self.assertIn("modal.dataset.originalProxyId = latestProxyId", reconcile)

    def test_account_proxy_picker_uses_the_public_pool_without_custom_proxy_forms(self):
        picker = self._function_source("openAccountProxyPickerModal")
        editor_modal = self._function_source("openAccountPoolEditorModal")
        picker_panel = self._function_source("renderAccountProxyPickerPanel")
        proxy_pool = self._function_source("renderProxyPool")

        self.assertIn("accountProxyPoolFiltersHtml", picker)
        self.assertIn("accountProxyPurchasePlaceholderHtml", picker)
        self.assertIn("loadAccountProxyPickerPool", picker)
        self.assertIn("claimAccountProxyPoolOption", picker)
        self.assertIn("选择代理", picker)
        self.assertNotIn("data-account-proxy-custom-add", picker)
        self.assertNotIn("data-account-system-proxy-pool-open", picker)
        self.assertNotIn("accountProxyInlineCustomFormHtml", picker)
        self.assertIn('function openAccountProxyPickerModal(accountId = "", initialProxyId = null)', self.source)
        self.assertIn('initialProxyId === null || initialProxyId === undefined', picker)
        self.assertNotIn("openProxyModal", picker)
        claim = self._function_source("claimAccountProxyPoolOption")
        self.assertIn('/api/persona_dashboard/automation/system-proxy-pool/select', claim)
        self.assertIn("fetchSocialDataShared({ force: true })", claim)
        self.assertIn("data-account-proxy-picker-open", editor_modal)
        self.assertNotIn("saveAccountInlineCustomProxy", editor_modal)
        self.assertIn("data-account-proxy-picker-open", picker_panel)
        self.assertIn("accountProxyPurchasePlaceholderHtml", picker_panel)
        self.assertNotIn("accountProxyInlineCustomFormHtml", picker_panel)
        self.assertNotIn("function saveAccountInlineCustomProxy", self.source)
        self.assertNotIn("function openSystemProxyPoolModal", self.source)
        self.assertNotIn('data-account-proxy-filter="availability"', self.source)
        self.assertNotIn("data-proxy-add", proxy_pool)
        self.assertNotIn("data-system-proxy-pool-open", proxy_pool)

    def test_proxy_purchase_completion_waits_for_owned_proxy_and_restores_picker(self):
        render_order = self._function_source("accountProxyPurchaseRenderOrder")
        finalize = self._function_source("accountProxyPurchaseFinalizeActive")

        self.assertIn('const complete = status === "active";', render_order)
        self.assertIn("await fetchSocialDataShared({ force: true })", finalize)
        self.assertIn("closeAccountProxyPurchaseView", finalize)
        self.assertIn("await loadAccountProxyPickerPool(modal)", finalize)
        self.assertIn("accountProxyPurchaseResolveLocalProxy", finalize)
        self.assertNotIn("options[0]", finalize)
        self.assertLess(
            finalize.index("await fetchSocialDataShared({ force: true })"),
            finalize.index("closeAccountProxyPurchaseView"),
        )
        self.assertLess(
            finalize.index("closeAccountProxyPurchaseView"),
            finalize.index("await loadAccountProxyPickerPool(modal)"),
        )

    def test_proxy_purchase_local_proxy_resolution_never_guesses(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("accountProxyPurchaseLocalIds")}
            {self._function_source("accountProxyPurchaseResolveLocalProxy")}

            const pool = {{ options: [
              {{ market_item_id: "market-a", social_proxy_id: "social-a" }},
              {{ market_item_id: "market-b", social_proxy_id: "social-b" }},
            ] }};
            assert.deepStrictEqual(
              accountProxyPurchaseResolveLocalProxy({{ market_item_id: "market-b" }}, pool),
              {{ marketItemId: "market-b", socialProxyId: "social-b" }},
            );
            assert.deepStrictEqual(
              accountProxyPurchaseResolveLocalProxy({{ social_proxy_id: "social-a" }}, pool),
              {{ marketItemId: "market-a", socialProxyId: "social-a" }},
            );
            assert.strictEqual(accountProxyPurchaseResolveLocalProxy({{}}, pool), null);
            assert.strictEqual(
              accountProxyPurchaseResolveLocalProxy({{ market_item_id: "missing" }}, pool),
              null,
            );
            """
        )
        self._run_node(harness)

    def test_totp_code_card_uses_stable_svg_ring_and_millisecond_clock(self):
        controller = self._function_source("createAccountTotpController")

        self.assertIn('data-account-totp-code-card', controller)
        self.assertIn('pathLength="100"', controller)
        self.assertIn('data-account-totp-ring', controller)
        self.assertIn("currentCode.server_time_ms", controller)
        self.assertIn("currentCode.expires_at_ms", controller)
        self.assertIn("currentCode.period_seconds", controller)
        self.assertIn("ring.style.strokeDashoffset", controller)
        self.assertIn("requestStartedAt", controller)
        self.assertIn("(requestStartedAt + Date.now()) / 2", controller)
        self.assertIn('if (!card)', controller)
        self.assertIn("data-account-totp-copy", controller)
        self.assertIn("renderClipboardIcon()", controller)
        self.assertIn("copyTextToClipboard(code)", controller)
        self.assertIn("copyButton.disabled = Date.now() >= lastCodeExpiresAt", controller)
        self.assertIn("Date.now() < lastCodeExpiresAt", controller)
        self.assertNotIn('countdown.textContent = `${Math.ceil(remaining / 1000)} 秒`', controller)

    def test_account_status_check_is_allowed_for_both_supported_platforms(self):
        validate = self._section("function validateTaskForPlatform", "function publishOrderedPersonaIds")
        self.assertIn('["open_login", "check_login"].includes(taskType)', validate)
        self.assertIn('["threads", "instagram"].includes', validate)

    def test_pageshow_and_focus_share_identity_revalidation(self):
        revalidation = self._section("async function revalidateConsoleIdentity()", "async function loadSetupStatus()")
        self.assertIn('api("/api/me")', revalidation)
        self.assertLess(revalidation.index("maskConsoleForIdentityRevalidation()"), revalidation.index('api("/api/me")'))
        self.assertIn("unmaskConsoleAfterIdentityRevalidation()", revalidation)
        self.assertIn("consoleUserId(me.id) !== expectedUserId", revalidation)
        self.assertIn("reloadForIdentityChange()", revalidation)
        self.assertIn("handleSessionBoundary(428)", revalidation)
        catch_branch = revalidation[revalidation.index(".catch((error)") :]
        self.assertIn("unmaskConsoleAfterIdentityRevalidation()", catch_branch)

        event_binding = self._section("function bindIdentityRevalidationEvents()", "async function init()")
        self.assertIn('window.addEventListener("pageshow"', event_binding)
        self.assertIn('window.addEventListener("focus"', event_binding)
        self.assertGreaterEqual(event_binding.count("revalidateConsoleIdentity()"), 2)

    def test_identity_revalidation_only_unmasks_for_same_identity_success(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ currentUser: {{ id: "7", username: "old" }} }};
            const document = {{
              documentElement: {{ hidden: false }},
              getElementById() {{ return null; }},
            }};
            const window = {{ location: {{ reload() {{ reloads += 1; }} }} }};
            let consoleIdentityReady = true;
            let consoleBoundaryNavigationActive = false;
            let identityRevalidationPromise = null;
            let reloads = 0;
            let redirects = [];
            let warnings = 0;
            let apiImpl;
            const $ = () => null;
            const api = (...args) => apiImpl(...args);
            const appendEvent = () => {{ warnings += 1; }};
            function handleSessionBoundary(status) {{
              if (![401, 428].includes(Number(status))) return false;
              consoleBoundaryNavigationActive = true;
              redirects.push(Number(status));
              return true;
            }}
            function clearTenantInMemoryState() {{}}
            {self._function_source("consoleUserId")}
            {self._function_source("maskConsoleForIdentityRevalidation")}
            {self._function_source("unmaskConsoleAfterIdentityRevalidation")}
            {self._function_source("reloadForIdentityChange")}
            {self._function_source("revalidateConsoleIdentity")}

            (async () => {{
              apiImpl = async () => ({{ id: 7, username: "same" }});
              const samePromise = revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              await samePromise;
              assert.strictEqual(document.documentElement.hidden, false);
              assert.strictEqual(state.currentUser.username, "same");

              apiImpl = async () => ({{ id: 8, username: "other" }});
              const changedPromise = revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              await changedPromise;
              assert.strictEqual(document.documentElement.hidden, true);
              assert.strictEqual(reloads, 1);

              consoleBoundaryNavigationActive = false;
              document.documentElement.hidden = false;
              state.currentUser = {{ id: "7", username: "old" }};
              apiImpl = async () => {{ throw {{ status: 500, detail: "down" }}; }};
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, false);
              assert.strictEqual(warnings, 1);

              document.documentElement.hidden = false;
              apiImpl = async () => {{ throw new TypeError("network"); }};
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, false);
              assert.strictEqual(warnings, 2);

              document.documentElement.hidden = false;
              apiImpl = async () => {{
                handleSessionBoundary(401);
                throw {{ status: 401 }};
              }};
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              assert.deepStrictEqual(redirects, [401]);

              consoleBoundaryNavigationActive = false;
              document.documentElement.hidden = false;
              apiImpl = async () => ({{ id: 7, must_change_password: true }});
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              assert.deepStrictEqual(redirects, [401, 428]);
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_console_javascript_syntax(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        result = subprocess.run(
            [node, "--check", str(CONSOLE_JS)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_task_screenshot_gallery_deduplicates_result_and_log_in_admin_workspace(self):
        collect_task_screenshots = self._section(
            "function collectTaskScreenshots",
            "\nfunction renderTaskScreenshotGallery",
        )
        harness = textwrap.dedent(f"""
            const assert = require("node:assert/strict");
            const ADMIN_WORKSPACE_USER_ID = "42";
            const ADMIN_CONSOLE_SESSION = true;
            const location = {{ origin: "https://example.test" }};
            {self._function_source("adminWorkspaceUrl")}
            {self._function_source("directMediaPreviewUrl")}
            {self._function_source("automationScreenshotUrlFromPath")}
            {self._function_source("automationScreenshotThumbnailUrl")}
            {self._function_source("taskScreenshotFromValue")}
            function logStageLabel(stage) {{ return stage || "日志截图"; }}
            {collect_task_screenshots}

            const filename = "task-1_publish_done_123.png";
            const rows = collectTaskScreenshots({{
              id: "task-1",
              task_type: "publish_post",
              status: "success",
              finished_at: 123,
              result: {{ screenshot_path: `/data/webapp_data/social_automation/screenshots/${{filename}}` }},
            }}, [
              {{
                stage: "publish_submitted_unconfirmed",
                created_at: 122,
                screenshot_url: "/api/persona_dashboard/automation/screenshots/task-1_pending_122.png",
              }},
              {{
                stage: "publish_done",
                created_at: 123,
                screenshot_url: `/api/persona_dashboard/automation/screenshots/${{filename}}`,
              }},
            ]);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].label, "最终截图");
            assert.match(rows[0].url, /admin_workspace_user_id=42/);
            assert.match(rows[0].url, /admin_console=1/);

            const missingFinal = collectTaskScreenshots({{
              id: "task-2",
              task_type: "publish_post",
              status: "success",
              result: {{}},
            }}, [{{
              stage: "need_manual",
              screenshot_url: "/api/persona_dashboard/automation/screenshots/task-2_login.png",
            }}]);
            assert.equal(missingFinal.length, 0);

            const logOnlyFinal = collectTaskScreenshots({{
              id: "task-3",
              task_type: "publish_post",
              status: "success",
              result: {{}},
            }}, [{{
              stage: "publish_done",
              screenshot_url: "/api/persona_dashboard/automation/screenshots/task-3_publish_done.png",
            }}]);
            assert.equal(logOnlyFinal.length, 1);

            const otherTask = collectTaskScreenshots({{
              id: "task-4",
              task_type: "check_login",
              status: "success",
              result: {{}},
            }}, [{{
              stage: "check_login",
              screenshot_url: "/api/persona_dashboard/automation/screenshots/task-4_check_login.png",
            }}]);
            assert.equal(otherTask.length, 1);
        """)
        self._run_node(harness)
        log_renderer = self._section("function renderTaskDetailLogs", "\nfunction renderTaskDetailLayout")
        self.assertIn("hideScreenshots = false", log_renderer)
        self.assertIn("task-log-screenshot-button", log_renderer)
        self.assertIn("renderMediaPreviewButton", log_renderer)
        layout_renderer = self._section("function renderTaskDetailLayout", "\nfunction updatePersonaPublishResultView")
        self.assertIn('String(task?.task_type || "") === "publish_post"', layout_renderer)
        self.assertIn('String(task?.status || "") === "success"', layout_renderer)

    def test_publish_batch_log_renders_every_member_result_in_one_modal(self):
        renderer = self._function_source("renderSocialPublishBatchResults")
        harness = textwrap.dedent(f"""
            const assert = require("assert");
            function esc(value) {{ return String(value ?? ""); }}
            function formatTime(value) {{ return String(value ?? ""); }}
            function timeValue(value) {{ return Number(value || 0); }}
            function statusLabel(value) {{ return value === "success" ? "成功" : String(value || ""); }}
            function statusTone(value) {{ return value === "success" ? "success" : "neutral"; }}
            function socialTaskPayload(task) {{ return task?.payload || {{}}; }}
            function collectTaskScreenshots(task) {{
              const path = task?.result?.screenshot_path || "";
              return path ? [{{ previewUrl: path, label: "最终截图" }}] : [];
            }}
            function renderTaskScreenshotGallery(items) {{
              return `<div data-gallery>${{items.map((item) => item.previewUrl).join("|")}}</div>`;
            }}
            {renderer}

            const html = renderSocialPublishBatchResults([
              {{
                id: "publish-2",
                status: "success",
                finished_at: 22,
                publish_sequence_index: 2,
                publish_sequence_total: 2,
                persona_id: "persona-1",
                payload: {{ caption: "第二篇正文", archive_post_title: "第二篇", media_paths: ["/data/two.png"] }},
                result: {{ published_url: "https://threads.net/post/two", screenshot_path: "/shots/two.png" }},
              }},
              {{
                id: "publish-1",
                status: "success",
                finished_at: 11,
                publish_sequence_index: 1,
                publish_sequence_total: 2,
                persona_id: "persona-1",
                payload: {{ caption: "第一篇正文", archive_post_title: "第一篇", media_paths: ["/data/one.png"] }},
                result: {{ published_url: "https://threads.net/post/one", screenshot_path: "/shots/one.png" }},
              }},
            ], []);
            assert.match(html, /2 篇 · 2 张截图/);
            assert.ok(html.indexOf("第一篇正文") < html.indexOf("第二篇正文"));
            assert.match(html, /\\/shots\\/one.png/);
            assert.match(html, /\\/shots\\/two.png/);
            assert.doesNotMatch(html, /发布媒体/);
            assert.doesNotMatch(html, /查看已发布推文/);
        """)
        self._run_node(harness)

    def test_persona_task_queue_filters_existing_rows_by_task_type(self):
        harness = textwrap.dedent(f"""
            const assert = require("assert");
            const state = {{ taskQueuePersonaTypeFilter: "all" }};
            {self._function_source("taskQueuePersonaType")}
            {self._function_source("taskQueuePersonaTypeCatalog")}
            {self._function_source("filterTaskQueuePersonaRows")}
            {self._function_source("statusLabel")}
            const esc = (value) => String(value);
            const renderTaskQueueFilterIcon = () => "";
            {self._function_source("renderTaskQueuePersonaTypeFilter")}

            const rows = [
              {{ id: "publish-1", task_type: "publish_post" }},
              {{ id: "login-1", task_type: "check_login" }},
            ];
            assert.deepStrictEqual(filterTaskQueuePersonaRows(rows).map((item) => item.id), ["publish-1", "login-1"]);
            state.taskQueuePersonaTypeFilter = "publish_post";
            assert.deepStrictEqual(filterTaskQueuePersonaRows(rows).map((item) => item.id), ["publish-1"]);
            assert.deepStrictEqual(filterTaskQueuePersonaRows([]), []);
            assert.strictEqual(state.taskQueuePersonaTypeFilter, "publish_post");
            state.taskQueuePersonaTypeFilter = "missing";
            assert.deepStrictEqual(filterTaskQueuePersonaRows(rows).map((item) => item.id), ["publish-1", "login-1"]);
            assert.strictEqual(state.taskQueuePersonaTypeFilter, "all");
            const emptyMenu = renderTaskQueuePersonaTypeFilter([]);
            [
              "全部类型", "发布内容", "登录状态同步", "登录流程", "浏览动态", "浏览主页",
              "Threads 养号", "Threads 自动回复", "Instagram 养号", "Instagram 自动回复",
              "评论帖子", "回复评论", "点赞帖子", "分享帖子", "转发帖子",
            ].forEach((label) => assert.match(emptyMenu, new RegExp(label)));
        """)
        self._run_node(harness)

        catalog = self._function_source("taskQueuePersonaTypeCatalog")
        for task_type in (
            "publish_post",
            "check_login",
            "open_login",
            "browse_feed",
            "browse_profile",
            "threads_warmup",
            "threads_auto_reply",
            "instagram_warmup",
            "instagram_auto_reply",
            "comment_post",
            "reply_comment",
            "like_post",
            "share_post",
            "repost_post",
        ):
            self.assertIn(f'"{task_type}"', catalog)

        queue_view = self._function_source("renderTaskQueueView")
        bind_events = self._function_source("bindEvents")
        self.assertIn("renderTaskQueuePersonaTypeFilter(personaSourceRows)", queue_view)
        self.assertLess(queue_view.index("renderTaskQueuePersonaTypeFilter(personaSourceRows)"), queue_view.index("task-queue-persona-select-button"))
        self.assertIn("data-task-queue-type-filter-menu", self.source)
        self.assertIn("data-task-queue-type-filter-option", self.source)
        self.assertIn('state.taskQueuePersonaTypeFilter = String(taskQueueTypeFilterOption.dataset.value || "all")', bind_events)
        task_table_click = bind_events.index('$("taskTable").addEventListener("click"')
        self.assertGreater(bind_events.index("const taskQueueTypeFilterMenu", task_table_click), task_table_click)
        self.assertGreater(bind_events.index("const taskQueueTypeFilterOption", task_table_click), task_table_click)
        self.assertIn('taskQueueTypeFilterMenu?.removeAttribute("open")', bind_events)
        filter_css = self._css_block(".task-queue-type-filter")
        self.assertIn("width: 36px", filter_css)
        self.assertIn("height: 36px", filter_css)
        self.assertIn("margin: 0", filter_css)
        self.assertIn("z-index: 3", self._css_block(".task-queue-type-filter:focus-within"))
        filter_options_css = self._css_block(".task-queue-type-filter .persona-history-filter-options")
        self.assertIn("right: 0", filter_options_css)
        self.assertIn("left: auto", filter_options_css)
        self.assertIn("width: max-content", filter_options_css)
        self.assertIn("max-width: min(220px, calc(100vw - 32px))", filter_options_css)

    def test_console_settings_use_user_browser_policy_endpoints_and_keep_pagination_local(self):
        render = self._function_source("renderConsoleSettingsPage")
        save = self._function_source("saveConsoleSettingsPage")
        load = self._function_source("loadBrowserPolicySettings")
        auto_configure = self._function_source("autoConfigureBrowserPreferences")

        for field in (
            "completion_policy",
            "standby_seconds",
            "auto_close_seconds",
            "manual_timeout_seconds",
            "text_input_mode",
        ):
            self.assertIn(field, render)
        self.assertNotIn("settingsRequestedConcurrency", render)
        self.assertNotIn("发布保护参数", render)
        self.assertNotIn("savePublishPolicySettings", self.source)
        self.assertIn("review_hold_seconds", self._function_source("normalizeBrowserPreferences"))
        self.assertIn("仅供检查，不提升速度", render)
        self.assertIn("resource_level", self._function_source("renderBrowserRecommendationCard"))
        self.assertIn("effective_limits", self._function_source("renderBrowserRecommendationCard"))
        self.assertIn("hiddenConcurrencyLimits", self._function_source("renderBrowserRecommendationCard"))
        self.assertIn('api("/api/persona_dashboard/automation/browser_preferences", {', save)
        self.assertIn('method: "PUT"', save)
        self.assertIn('api("/api/persona_dashboard/automation/browser_preferences")', load)
        self.assertIn('api("/api/persona_dashboard/automation/browser_recommendation")', load)
        self.assertIn('api("/api/persona_dashboard/automation/browser_preferences/auto_configure"', auto_configure)
        self.assertIn('method: "POST"', auto_configure)
        self.assertIn("PERSONA_LIST_PAGE_SIZE_KEY", save)
        self.assertNotIn("LIVE_BROWSER_", save)
        self.assertNotIn("browser_settings", self.source)

    def test_browser_preferences_normalize_server_payload_for_policy_controls(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("normalizeBrowserPreferences")}
            {self._function_source("browserPreferencesResponseValue")}

            assert.deepStrictEqual(
              browserPreferencesResponseValue({{ preferences: {{
                completion_policy: "review_hold",
                review_hold_seconds: 999,
                standby_seconds: 120,
                auto_close_seconds: 7200,
                manual_timeout_seconds: 600,
                requested_concurrency: 0,
                text_input_mode: "type",
              }} }}),
              {{
                completion_policy: "review_hold",
                review_hold_seconds: 300,
                standby_seconds: 120,
                auto_close_seconds: 7200,
                manual_timeout_seconds: 600,
                requested_concurrency: 1,
                text_input_mode: "type",
              }},
            );
            assert.deepStrictEqual(
              normalizeBrowserPreferences({{
                completion_policy: "unknown",
                review_hold_seconds: 1,
                standby_seconds: 9999,
                auto_close_seconds: 1,
                manual_timeout_seconds: 750,
                requested_concurrency: 99,
                text_input_mode: "unknown",
              }}),
              {{
                completion_policy: "immediate_close",
                review_hold_seconds: 10,
                standby_seconds: 3600,
                auto_close_seconds: 10,
                manual_timeout_seconds: 750,
                requested_concurrency: 12,
                text_input_mode: "paste",
              }},
            );
            """
        )
        self._run_node(harness)

    def test_browser_duration_controls_support_presets_and_custom_seconds(self):
        render = self._function_source("renderConsoleSettingsPage")
        update = self._function_source("updateBrowserPreferencesDraft")
        sync = self._section("function syncBrowserDurationCustomField", "function browserPreferencesResponseValue")
        options = self._function_source("browserDurationOptions")

        self.assertIn('value="custom"', options)
        self.assertIn("自定义时间", options)
        self.assertIn("settingsBrowserStandbyCustomSeconds", render)
        self.assertIn("settingsBrowserAutoCloseCustomSeconds", render)
        self.assertIn("settingsManualTimeoutCustomSeconds", render)
        self.assertIn('min="0" max="3600"', render)
        self.assertIn('min="10" max="86400"', render)
        self.assertIn('min="300" max="1800"', render)
        self.assertIn("browserDurationValue", update)
        self.assertIn("wrapper.hidden = !usesCustom", sync)
        self.assertIn("input.focus()", sync)
        self.assertIn("browserDurationDrafts", self.source)
        self.assertIn("invalidDurationInput", self._function_source("saveConsoleSettingsPage"))

    def test_publish_waiting_for_manual_login_uses_manual_status_everywhere(self):
        helpers = "\n".join([
            self._function_source("socialTaskPayload"),
            self._function_source("socialTaskLoginDependency"),
            self._function_source("socialTaskWaitsForManualLogin"),
            self._function_source("socialTaskPresentationStatus"),
            self._function_source("aggregateSocialTaskBatch"),
            self._function_source("socialTaskPresentationRows"),
            self._function_source("isFutureScheduledSocialTask"),
            self._function_source("renderSocialQueueTaskStatus"),
            self._function_source("socialTaskDisplayStatus"),
            self._function_source("socialTaskFailureReason"),
            self._function_source("socialTaskToastMessage"),
            self._function_source("renderSocialTasks"),
        ])
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const host = {{ innerHTML: "" }};
            const state = {{
              socialTasks: [{{ id: "login-1", task_type: "open_login", status: "need_manual" }}],
              socialTaskToastLabels: {{}},
            }};
            function $(id) {{ return id === "socialTaskList" ? host : null; }}
            function esc(value) {{ return String(value || ""); }}
            function statusLabel(value) {{ return value === "need_manual" ? "需人工处理" : String(value || ""); }}
            function renderStatusText(value) {{ return `<span>${{value}}</span>`; }}
            function formatScheduledTime() {{ return ""; }}
            function timeValue() {{ return 0; }}
            function activeSocialAutomationTask() {{ return false; }}
            {helpers}
            const publishTask = {{
              id: "publish-1",
              task_type: "publish_post",
              status: "queued",
              platform: "threads",
              account_id: "account-1",
              payload: {{ login_task_id: "login-1" }},
            }};
            state.socialTasks.push(publishTask);
            assert.strictEqual(socialTaskWaitsForManualLogin(publishTask), true);
            assert.strictEqual(socialTaskPresentationStatus(publishTask), "need_manual");
            assert.ok(renderSocialQueueTaskStatus(publishTask).includes("need_manual"));
            assert.strictEqual(socialTaskDisplayStatus(publishTask), "需人工处理");
            assert.ok(socialTaskToastMessage(publishTask).includes("需要人工处理"));
            renderSocialTasks();
            assert.ok(host.innerHTML.includes('class="status need_manual"'));
            assert.ok(host.innerHTML.includes("需人工处理"));
            """
        )
        self._run_node(harness)

    def test_publish_batch_is_one_queue_row_with_aggregate_status(self):
        helpers = "\n".join([
            self._function_source("socialTaskPayload"),
            self._function_source("socialTaskLoginDependency"),
            self._function_source("socialTaskWaitsForManualLogin"),
            self._function_source("socialTaskPresentationStatus"),
            self._function_source("aggregateSocialTaskBatch"),
            self._function_source("socialTaskPresentationRows"),
            self._function_source("personaAutomationTasksFor"),
            self._function_source("renderSocialTasks"),
        ])
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const host = {{ innerHTML: "" }};
            const batchId = "publish-batch-1";
            const state = {{
              socialTasks: [
                {{
                  id: "publish-2",
                  persona_id: "persona-1",
                  account_id: "account-1",
                  account_username: "publisher",
                  task_type: "publish_post",
                  platform: "threads",
                  status: "running",
                  created_at: 20,
                  updated_at: 30,
                  payload: {{ publish_batch_id: batchId, publish_sequence_index: 2, publish_sequence_total: 2 }},
                }},
                {{
                  id: "publish-1",
                  persona_id: "persona-1",
                  account_id: "account-1",
                  account_username: "publisher",
                  task_type: "publish_post",
                  platform: "threads",
                  status: "success",
                  created_at: 10,
                  updated_at: 20,
                  payload: {{ publish_batch_id: batchId, publish_sequence_index: 1, publish_sequence_total: 2 }},
                }},
                {{
                  id: "login-1",
                  persona_id: "persona-1",
                  account_id: "account-1",
                  task_type: "check_login",
                  platform: "threads",
                  status: "success",
                  created_at: 5,
                  updated_at: 6,
                  payload: {{}},
                }},
              ],
            }};
            function $(id) {{ return id === "socialTaskList" ? host : null; }}
            function esc(value) {{ return String(value ?? ""); }}
            function statusLabel(value) {{ return String(value || ""); }}
            function timeValue(value) {{ return Number(value || 0); }}
            function activeSocialAutomationTask(task) {{ return ["queued", "running", "need_manual"].includes(task.status); }}
            {helpers}

            const rows = personaAutomationTasksFor("persona-1");
            assert.strictEqual(rows.length, 2);
            const batch = rows.find((item) => item.batch_task_count === 2);
            assert.ok(batch);
            assert.deepStrictEqual(batch.batch_task_ids, ["publish-1", "publish-2"]);
            assert.strictEqual(batch.status, "running");
            assert.strictEqual(batch.id, "publish-1");

            renderSocialTasks();
            assert.strictEqual((host.innerHTML.match(/data-social-log=/g) || []).length, 2);
            assert.strictEqual((host.innerHTML.match(/data-social-log="publish-1"/g) || []).length, 1);
            assert.ok(host.innerHTML.includes("2 篇"));
            """
        )
        self._run_node(harness)

    def test_publish_batch_child_notification_targets_aggregate_queue_row(self):
        helpers = "\n".join([
            self._function_source("taskQueueRowMatchesTarget"),
            self._function_source("taskQueuePageForTarget"),
            self._function_source("focusTaskQueueTarget"),
        ])
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const aggregate = {{
              id: "publish-1",
              batch_task_ids: ["publish-1", "publish-2"],
            }};
            const state = {{
              taskQueuePanel: "persona",
              taskQueuePersonaPageSize: 12,
            }};
            let selectedSelector = "";
            const selectedRow = {{
              classList: {{ add() {{}}, remove() {{}} }},
              scrollIntoView() {{}},
              focus() {{}},
            }};
            const document = {{
              querySelector(selector) {{
                selectedSelector = selector;
                return selectedRow;
              }},
            }};
            const window = {{
              requestAnimationFrame(callback) {{ callback(); }},
              setTimeout(callback) {{ callback(); }},
            }};
            const CSS = {{ escape(value) {{ return String(value); }} }};
            function taskQueueRowsForKind() {{ return [aggregate]; }}
            {helpers}

            assert.strictEqual(taskQueuePageForTarget("persona", "publish-2"), 1);
            focusTaskQueueTarget("publish-2", "persona");
            assert.strictEqual(selectedSelector, '[data-task-queue-row-id="publish-1"]');
            """
        )
        self._run_node(harness)

    def test_browser_recommendation_adapts_split_server_payload(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("browserRecommendationResponseValue")}

            assert.deepStrictEqual(
              browserRecommendationResponseValue({{
                environment: {{ resource_level: "limited", summary: "2 核 CPU" }},
                recommended: {{ requested_concurrency: 2, manual_timeout_seconds: 900 }},
                reasons: ["优先释放资源"],
                limits: {{ global_max_concurrency: 2 }},
              }}),
              {{
                resource_level: "limited",
                summary: "2 核 CPU",
                recommended: {{ requested_concurrency: 2, manual_timeout_seconds: 900 }},
                reasons: ["优先释放资源"],
                limits: {{
                  recommended_concurrency: 2,
                  global_max_concurrency: 2,
                  manual_timeout_minutes: 15,
                }},
              }},
            );
            """
        )
        self._run_node(harness)

    def test_proxy_auto_detection_falls_back_and_autofills_editable_fields(self):
        helper_source = "\n".join(
            [
                self._section("function proxyNameCanAutofill", "async function testProxyConfiguration"),
                self._section("async function testProxyConfiguration", "async function testProxyForm"),
            ]
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const fields = {{
              proxyFormProtocol: {{ value: "auto" }},
              proxyFormName: {{ value: "" }},
            }};
            const calls = [];
            let rendered = null;
            function $(id) {{ return fields[id] || null; }}
            function proxyCheckRequestPayload(payload) {{ return payload; }}
            function renderProxyCheckResult(_target, result) {{ rendered = result; }}
            async function api(_url, options) {{
              const payload = JSON.parse(options.body);
              calls.push(payload.proxy_type);
              if (payload.proxy_type === "http") return {{ result: {{ ok: false, error: "wrong protocol" }} }};
              return {{ result: {{
                ok: true,
                exit_ip: "194.143.193.241",
                response: {{ ip: "194.143.193.241", country_code: "ES", city: "Zaragoza" }},
              }} }};
            }}
            {helper_source}
            (async () => {{
              const payload = {{ proxy_type: "auto", host: "194.143.193.241", port: 8022, name: "" }};
              const result = await testProxyConfiguration(payload, "", "result", "proxyForm");
              assert.deepStrictEqual(calls, ["http", "socks5"]);
              assert.strictEqual(result.ok, true);
              assert.strictEqual(result.detected_proxy_type, "socks5");
              assert.strictEqual(payload.proxy_type, "socks5");
              assert.strictEqual(fields.proxyFormProtocol.value, "socks5");
              assert.strictEqual(fields.proxyFormName.value, "[代理IP] ES · Zaragoza · 194.143.193.241");
              assert.strictEqual(payload.name, fields.proxyFormName.value);
              assert.strictEqual(rendered, result);
              fields.proxyFormName.value = "";
              const verifiedPayload = {{ proxy_type: "socks5", host: "194.143.193.241", port: 8022, name: "" }};
              applyProxyDetectionAutofill("proxyForm", {{
                ok: true,
                detected_proxy_type: "socks5",
                residential_status: "verified",
                network_type: "static_residential",
                exit_ip: "194.143.193.241",
                response: {{ country_code: "ES", city: "Zaragoza" }},
              }}, verifiedPayload);
              assert.strictEqual(fields.proxyFormName.value, "[静态住宅] ES · Zaragoza · 194.143.193.241");
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_unconfirmed_publish_cannot_show_automatic_retry_action(self):
        queue = self._function_source("renderPersonaQueueRows")
        legacy_queue = self._function_source("renderSocialTasks")
        self.assertIn('task?.result?.retryable !== false', queue)
        self.assertIn('task?.result?.retryable !== false', legacy_queue)
        self.assertIn('data-social-retry', queue)
        self.assertNotIn('确认已发布', self.source)
        self.assertNotIn('确认未发布', self.source)

    def test_daily_publish_policy_locks_customers_but_waives_admins(self):
        normalize_policy = self._section(
            "function normalizeDailyPublishPolicy",
            "function isDailyPublishLimitMessage",
        )
        is_locked = self._section(
            "function dailyPublishIsLocked",
            "function dailyPublishActionAttrs",
        )
        limit_message = self._function_source("isDailyPublishLimitMessage")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ dailyPublishPolicy: {{ limit: 15, used: 0, remaining: 15 }} }};
            {normalize_policy}
            {limit_message}
            {is_locked}
            assert.strictEqual(dailyPublishIsLocked({{ limit: 15, used: 14, remaining: 1 }}), false);
            assert.strictEqual(dailyPublishIsLocked({{ limit: 15, used: 15, remaining: 0 }}), true);
            assert.strictEqual(dailyPublishIsLocked({{ limit: 15, used: 99, remaining: 0, waived: true }}), false);
            assert.strictEqual(dailyPublishIsLocked({{ limit: 15, used: 0, remaining: 15, check_failed: true }}), true);
            const batch = normalizeDailyPublishPolicy({{
              limit: 15,
              used: 14,
              remaining: 1,
              requested: 2,
              request_blocked: true,
            }});
            assert.strictEqual(batch.request_blocked, true);
            assert.strictEqual(isDailyPublishLimitMessage("超过 15 篇会有封号风险"), true);
            assert.strictEqual(isDailyPublishLimitMessage("超過 15 篇會有封號風險"), true);
            """
        )
        self._run_node(harness)

    def test_every_publish_entry_uses_the_shared_daily_limit_guard(self):
        capacity_guard = self._section(
            "async function ensureDailyPublishCapacity",
            "window.VectoPublishRiskGuard",
        )
        self.assertIn("/automation/publish_policy?", capacity_guard)
        self.assertIn("showDailyPublishLimitWarning", capacity_guard)
        api_source = self._section("async function api(", "async function apiWithTimeout")
        self.assertIn("requested_count=0", api_source)
        self.assertIn("updateDailyPublishPolicy", api_source)
        for function_name in (
            "submitPersonaPublishTask",
            "submitPublishContentTasks",
            "submitMatrixPublishTask",
            "createSocialTask",
        ):
            self.assertIn("ensureDailyPublishCapacity", self._function_source(function_name))
        self.assertGreaterEqual(self.source.count('data-daily-publish-action="true"'), 1)
        bind_events = self._function_source("bindEvents")
        self.assertIn("handleDailyPublishActionGate", bind_events)
        action_gate = self._function_source("handleDailyPublishActionGate")
        self.assertIn("stopImmediatePropagation", action_gate)
        self.assertIn("showDailyPublishLimitWarning", action_gate)
        warning_modal = self._section(
            "async function showDailyPublishLimitWarning",
            "function beginDailyPublishPolicyRequest",
        )
        self.assertIn("dailyPublishWarningPromise", warning_modal)
        self.assertIn("dailyPublishPendingWarning", warning_modal)
        self.assertIn('modalKey: "daily-publish-limit"', warning_modal)
        modal_source = self._section("function openConsoleModal", "const DAILY_PUBLISH_LIMIT_WARNING")
        self.assertIn("translateConsoleLanguage(modal, currentLanguage())", modal_source)

    def test_daily_publish_gate_blocks_business_click_and_policy_failures_close(self):
        normalize_policy = self._section(
            "function normalizeDailyPublishPolicy",
            "function isDailyPublishLimitMessage",
        )
        is_locked = self._section(
            "function dailyPublishIsLocked",
            "function dailyPublishActionAttrs",
        )
        begin_request = self._function_source("beginDailyPublishPolicyRequest")
        update_policy = self._section(
            "function updateDailyPublishPolicy",
            "async function ensureDailyPublishCapacity",
        )
        ensure_capacity = self._section(
            "async function ensureDailyPublishCapacity",
            "window.VectoPublishRiskGuard",
        )
        action_gate = self._function_source("handleDailyPublishActionGate")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{
              dailyPublishPolicy: {{ limit: 15, used: 15, remaining: 0, locked: true, waived: false }},
              dailyPublishPolicyRequestSeq: 0,
              dailyPublishPolicyAppliedSeq: 0,
            }};
            let warningCount = 0;
            let prevented = false;
            let stopped = false;
            function applyDailyPublishButtonLocks() {{}}
            async function showDailyPublishLimitWarning() {{ warningCount += 1; return false; }}
            async function api() {{ throw {{ status: 500, detail: "down" }}; }}
            {normalize_policy}
            {is_locked}
            {begin_request}
            {update_policy}
            {ensure_capacity}
            {action_gate}
            const blocked = handleDailyPublishActionGate({{
              target: {{ closest: () => ({{}}) }},
              preventDefault: () => {{ prevented = true; }},
              stopImmediatePropagation: () => {{ stopped = true; }},
            }});
            assert.strictEqual(blocked, true);
            assert.strictEqual(prevented, true);
            assert.strictEqual(stopped, true);
            (async () => {{
              state.dailyPublishPolicy = {{ limit: 15, used: 0, remaining: 15, locked: false, waived: false }};
              const allowed = await ensureDailyPublishCapacity(1);
              assert.strictEqual(allowed, false);
              assert.strictEqual(state.dailyPublishPolicy.locked, true);
              assert.strictEqual(state.dailyPublishPolicy.check_failed, true);
              assert.ok(warningCount >= 2);
            }})().catch((error) => {{ console.error(error); process.exitCode = 1; }});
            """
        )
        self._run_node(harness)

    def test_daily_publish_policy_ignores_out_of_order_responses(self):
        normalize_policy = self._section(
            "function normalizeDailyPublishPolicy",
            "function isDailyPublishLimitMessage",
        )
        update_policy = self._section(
            "function updateDailyPublishPolicy",
            "async function ensureDailyPublishCapacity",
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{
              dailyPublishPolicy: {{ limit: 15, used: 0, remaining: 15, locked: false, waived: false }},
              dailyPublishPolicyAppliedSeq: 0,
              dailyPublishWarningDay: "",
            }};
            function applyDailyPublishButtonLocks() {{}}
            async function showDailyPublishLimitWarning() {{ return false; }}
            {normalize_policy}
            {update_policy}
            updateDailyPublishPolicy({{ limit: 15, used: 15, remaining: 0, locked: true }}, {{ requestSeq: 2, notify: false }});
            updateDailyPublishPolicy({{ limit: 15, used: 14, remaining: 1, locked: false }}, {{ requestSeq: 1, notify: false }});
            assert.strictEqual(state.dailyPublishPolicy.used, 15);
            assert.strictEqual(state.dailyPublishPolicy.locked, true);
            """
        )
        self._run_node(harness)

    def test_account_menu_preserves_admin_managed_workspace_on_operational_public_pages(self):
        start = self.site_nav_source.index("function openAccountConsoleView")
        end = self.site_nav_source.index("function openProfilePage", start)
        helper = self.site_nav_source[start:end]
        local_switch = helper.index('window.location.pathname === "/console.html"')
        admin_redirect = helper.index("adminConsoleTarget(targetView, workspaceUserId)")
        self.assertLess(local_switch, admin_redirect)
        self.assertIn("window.dispatchEvent(new CustomEvent", helper)
        self.assertIn("new URLSearchParams({ view: targetView })", helper)
        self.assertIn('currentSessionMode === "admin"', helper)
        self.assertIn("hasAdminConsoleContext()", helper)
        self.assertIn("storedAdminWorkspaceUserId()", helper)
        self.assertNotIn("manage_user_id", helper)
        self.assertNotIn("/admin-console.html?view=", helper)

    def test_authenticated_navigation_prioritizes_admin_console_and_regular_user_mode(self):
        sync_source = self._javascript_function_source(
            self.site_nav_source,
            "syncAdminWorkspaceContext",
        )
        self.assertIn('currentSessionMode = "user"', sync_source)
        target_source = self._javascript_function_source(
            self.site_nav_source,
            "syncConsoleEntryTargets",
        )
        self.assertIn('adminConsoleTarget("", workspaceUserId)', target_source)
        self.assertIn('"/console.html"', target_source)
        self.assertIn("removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY)", target_source)

    def test_public_navigation_preserves_admin_workspace_and_admin_context(self):
        sync_source = self._javascript_function_source(
            self.site_nav_source,
            "syncAdminWorkspaceContext",
        )
        resolve_start = self.site_nav_source.index("async function resolvePublicSession()")
        resolve_end = self.site_nav_source.index("async function openConsoleEntry", resolve_start)
        resolve_source = self.site_nav_source[resolve_start:resolve_end]
        self._run_node(
            f"""
            const assert = require("assert");
            const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
            const removed = [];
            const document = {{ querySelector() {{ return null; }} }};
            function removeSessionValue(key) {{ removed.push(key); }}
            function clearAdminConsoleContext() {{ throw new Error("admin context must be preserved"); }}
            function markAdminConsoleContext() {{}}
            function writeSessionValue() {{}}
            function publicPagePreservesAdminWorkspace() {{ return true; }}
            function hasAdminConsoleContext() {{ return true; }}
            function adminConsoleTarget(view, workspaceUserId) {{
              return workspaceUserId ? `/admin-console.html?manage_user_id=${{workspaceUserId}}` : "/admin-console.html";
            }}
            let currentSessionMode = "admin";
            {sync_source}
            syncAdminWorkspaceContext();
            assert.deepStrictEqual(removed, []);

            let requestedWorkspace = "not-called";
            function storedAdminWorkspaceUserId() {{ return "32"; }}
            async function fetchSessionAccount(options = {{}}) {{
              requestedWorkspace = options.workspaceUserId || "";
              return {{
                response: {{ ok: true, status: 200 }},
                account: {{ id: 1, username: "admin", is_admin: true }},
              }};
            }}
            {resolve_source}
            (async () => {{
              const session = await resolvePublicSession();
            assert.strictEqual(requestedWorkspace, "32");
            assert.strictEqual(session.workspaceUserId, "32");
              assert.strictEqual(session.account.id, 1);
            }})();
            """
        )

    def test_public_admin_context_fails_closed_when_admin_probe_errors(self):
        resolve_start = self.site_nav_source.index("async function resolvePublicSession()")
        resolve_end = self.site_nav_source.index("async function openConsoleEntry", resolve_start)
        resolve_source = self.site_nav_source[resolve_start:resolve_end]
        self._run_node(
            f"""
            const assert = require("assert");
            let regularProbeCount = 0;
            const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
            function hasAdminConsoleContext() {{ return true; }}
            function publicPagePreservesAdminWorkspace() {{ return false; }}
            function storedAdminWorkspaceUserId() {{ return ""; }}
            function removeSessionValue() {{}}
            function markAdminConsoleContext() {{}}
            function clearAdminConsoleContext() {{}}
            async function fetchSessionAccount(options = {{}}) {{
              if (options.admin) {{
                return {{ response: {{ ok: false, status: 500 }}, account: null }};
              }}
              regularProbeCount += 1;
              return {{
                response: {{ ok: true, status: 200 }},
                account: {{ id: 32, username: "other-user" }},
              }};
            }}
            {resolve_source}
            (async () => {{
              await assert.rejects(resolvePublicSession(), /Admin session validation failed/);
              assert.strictEqual(regularProbeCount, 0);
            }})();
            """
        )

    def test_operational_public_pages_keep_managed_workspace_during_admin_probe(self):
        resolve_start = self.site_nav_source.index("async function resolvePublicSession()")
        resolve_end = self.site_nav_source.index("async function openConsoleEntry", resolve_start)
        resolve_source = self.site_nav_source[resolve_start:resolve_end]
        self._run_node(
            f"""
            const assert = require("assert");
            const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
            const removed = [];
            function hasAdminConsoleContext() {{ return true; }}
            function publicPagePreservesAdminWorkspace() {{ return true; }}
            function storedAdminWorkspaceUserId() {{ return "32"; }}
            function removeSessionValue(key) {{ removed.push(key); }}
            function markAdminConsoleContext() {{}}
            function adminConsoleTarget(view, workspaceUserId) {{
              return workspaceUserId ? `/admin-console.html?manage_user_id=${{workspaceUserId}}` : "/admin-console.html";
            }}
            async function fetchSessionAccount(options = {{}}) {{
              assert.strictEqual(options.admin, true);
              assert.strictEqual(options.workspaceUserId, "32");
              return {{
                response: {{ ok: true, status: 200 }},
                account: {{ id: 32, username: "managed-customer" }},
              }};
            }}
            {resolve_source}
            (async () => {{
              const session = await resolvePublicSession();
              assert.deepStrictEqual(removed, []);
              assert.strictEqual(session.workspaceUserId, "32");
              assert.strictEqual(session.path, "/admin-console.html?manage_user_id=32");
            }})();
            """
        )

    def test_public_admin_context_does_not_fall_back_on_expired_admin_session(self):
        resolve_start = self.site_nav_source.index("async function resolvePublicSession()")
        resolve_end = self.site_nav_source.index("async function openConsoleEntry", resolve_start)
        resolve_source = self.site_nav_source[resolve_start:resolve_end]
        self._run_node(
            f"""
            const assert = require("assert");
            let regularProbeCount = 0;
            const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
            function hasAdminConsoleContext() {{ return true; }}
            function publicPagePreservesAdminWorkspace() {{ return false; }}
            function storedAdminWorkspaceUserId() {{ return ""; }}
            function removeSessionValue() {{}}
            function markAdminConsoleContext() {{}}
            function clearAdminConsoleContext() {{ throw new Error("admin context must not be cleared"); }}
            async function fetchSessionAccount(options = {{}}) {{
              if (options.admin) return {{ response: {{ ok: false, status: 401 }}, account: null }};
              regularProbeCount += 1;
              return {{ response: {{ ok: true, status: 200 }}, account: {{ id: 32, username: "customer" }} }};
            }}
            {resolve_source}
            (async () => {{
              await assert.rejects(resolvePublicSession(), /Admin session validation failed/);
              assert.strictEqual(regularProbeCount, 0);
            }})();
            """
        )

    def test_admin_logout_and_session_expiry_clear_managed_workspace_context(self):
        marker = 'sessionStorage.removeItem("vecto-admin-workspace-user-id")'
        self.assertIn(marker, self.source)
        self.assertIn(marker, self.admin_source)
        self.assertIn("if (isAdminConsole) clearStoredAdminWorkspaceContext()", self.source)
        self.assertIn("if (res.status === 401)", self.admin_source)
        self.assertIn("clearStoredAdminWorkspaceContext();", self.admin_source)

    def test_proxy_detection_preserves_manual_name_and_keeps_metadata_in_preview(self):
        self.assertIn('["auto", "自动检测（推荐）"]', self.source)
        self.assertNotIn('id="${esc(prefix)}Country"', self.source)
        helper_source = self._section("function proxyNameCanAutofill", "function applyProxyDetectionAutofill")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {helper_source}
            const payload = {{ host: "proxy.example.com", port: 1080 }};
            assert.strictEqual(proxyNameCanAutofill("", payload), true);
            assert.strictEqual(proxyNameCanAutofill("socks5://proxy.example.com:1080", payload), true);
            assert.strictEqual(proxyNameCanAutofill("西班牙主账号代理", payload), false);
            """
        )
        self._run_node(harness)


if __name__ == "__main__":
    unittest.main()
