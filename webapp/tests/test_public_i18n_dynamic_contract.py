import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "script.js"
NAVIGATION_PATH = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js"
CONSOLE_PATH = REPO_ROOT / "webapp" / "static" / "console.html"
AUTH_PATH = REPO_ROOT / "webapp" / "static" / "assets" / "auth.js"
CHANGE_PASSWORD_PATH = REPO_ROOT / "webapp" / "static" / "change-password.html"
AUTOMATION_LOG_PATH = REPO_ROOT / "webapp" / "static" / "persona-automation-log.html"


class PublicI18nDynamicContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")
        cls.navigation = NAVIGATION_PATH.read_text(encoding="utf-8")
        cls.console = CONSOLE_PATH.read_text(encoding="utf-8")
        cls.auth = AUTH_PATH.read_text(encoding="utf-8")
        cls.change_password = CHANGE_PASSWORD_PATH.read_text(encoding="utf-8")
        cls.automation_log = AUTOMATION_LOG_PATH.read_text(encoding="utf-8")

    def test_added_nodes_are_marked_before_translation(self):
        observer = self.navigation_slice(
            self.script,
            "function startPublicLanguageObserver()",
            "function setHeaderState()",
        )
        expected_handler = """mutation.addedNodes.forEach((node) => {
        markPublicStaticUi(node, { dynamic: true });
        translatePublicLanguage(node, language);
      });"""
        self.assertIn(
            expected_handler,
            observer,
            "新增节点必须先标记为动态 UI，再按当前语言翻译",
        )
        marker = self.navigation_slice(
            self.script,
            "function markPublicStaticUi(",
            "function translatePublicTextNode(",
        )
        self.assertIn("root.nodeType === Node.TEXT_NODE", marker)
        self.assertIn("markPublicUiElement(root.parentElement, { dynamic })", marker)

    def test_account_popover_copy_covers_accessibility_and_billing_fallbacks(self):
        expected_copy = (
            'accountClose: "关闭个人信息"',
            'accountClose: "關閉個人資訊"',
            'billingLegacyPlan: "存量账号"',
            'billingLegacyPlan: "存量帳號"',
            'billingActivePlan: "已启用"',
            'billingActivePlan: "已啟用"',
            'billingNoPlan: "暂无订阅"',
            'billingNoPlan: "暫無訂閱"',
            'billingUnlimited: "不限"',
            'billingPointUnit: "点"',
            'billingPointUnit: "點"',
            'billingImageUnit: "张"',
            'billingImageUnit: "張"',
            'billingPostUnit: "篇"',
        )
        for expected in expected_copy:
            self.assertIn(expected, self.navigation)

        account_markup = self.navigation_slice(
            self.navigation,
            'function accountMenuMarkup(page = "console")',
            "function renderMobileMenu(",
        )
        self.assertIn("data-site-account-close", account_markup)
        self.assertIn('data-site-open-console-view="tasks"', account_markup)
        self.assertIn('data-site-open-console-view="console_settings"', account_markup)
        self.assertIn('data-site-copy="taskQueue"', account_markup)
        self.assertIn('data-site-copy="personalSettings"', account_markup)
        self.assertNotIn('data-site-copy="settings"', account_markup)
        self.assertIn("data-site-workspace-actions", account_markup)
        self.assertNotIn('page === "console"', account_markup)
        self.assertNotIn('aria-label="关闭个人信息"', account_markup)
        self.assertNotIn('title="关闭个人信息"', account_markup)

        sync = self.navigation_slice(
            self.navigation,
            "function sync()",
            'document.addEventListener("click",',
        )
        self.assertIn("[data-site-account-close]", sync)
        self.assertIn("labels.accountClose", sync)

        billing = self.navigation_slice(
            self.navigation,
            "function renderAccountBilling()",
            "async function loadAccountBilling(",
        )
        for hardcoded in ('"存量账号"', '"已启用"', '"暂无订阅"', '"不限"', '" 点"', '" 张"', '" 篇"'):
            self.assertNotIn(hardcoded, billing)
        for key in (
            "labels.billingLegacyPlan",
            "labels.billingActivePlan",
            "labels.billingNoPlan",
            "labels.billingUnlimited",
            "labels.billingPointUnit",
            "labels.billingImageUnit",
            "labels.billingPostUnit",
        ):
            self.assertIn(key, billing)

    def test_builtin_welcome_notification_is_localized_without_translating_custom_messages(self):
        self.assertIn('notificationWelcomeTitle: "歡迎使用 Vecto 控制台"', self.navigation)
        self.assertIn('notificationWelcomeBody: "任務狀態、帳號安全和系統維護提醒會集中顯示在這裡。"', self.navigation)
        helper = self.navigation_slice(
            self.navigation,
            "function localizedNotificationText(",
            "function notificationAnnounceKey(",
        )
        self.assertIn('value === copy["zh-Hans"].notificationWelcomeTitle', helper)
        self.assertIn('value === copy["zh-Hans"].notificationWelcomeBody', helper)
        self.assertIn("return value", helper)

    def test_shared_auth_feedback_uses_the_active_language_copy(self):
        for expected in (
            'logoutConfirmTitle: "確認退出登入"',
            'logoutConfirmMessage: "退出後需要重新登入才能繼續使用。"',
            'googleAuthComplete: "Google 授權驗證已完成。"',
            "labels.authEveningGreeting",
            "labels.logoutSuccess",
            "labels.loginSuccess",
            "labels.logoutCancel",
        ):
            self.assertIn(expected, self.navigation)
        self.assertNotIn('<strong id="siteLogoutConfirmTitle">确认退出登录</strong>', self.navigation)

    def test_standalone_account_pages_follow_shared_language_preference(self):
        self.assertIn('AUTH_LANGUAGE_STORAGE_KEY = "wk-console-language"', self.auth)
        self.assertIn('window.addEventListener("vecto:language-change", applyAuthLanguage)', self.auth)
        self.assertIn('data-auth-i18n="stageTitle"', self.change_password)
        self.assertIn('LOG_LANGUAGE_STORAGE_KEY = "wk-console-language"', self.automation_log)
        self.assertIn('data-log-i18n="pageTitle"', self.automation_log)
        self.assertIn('document.documentElement.dataset.language = language', self.automation_log)

    def test_console_admin_entry_uses_shared_navigation_copy(self):
        self.assertIn('data-site-copy="adminConsole"', self.console)
        self.assertIn('adminConsole: "运营后台"', self.navigation)
        self.assertIn('adminConsole: "營運後台"', self.navigation)

    @staticmethod
    def navigation_slice(source, start, end):
        start_index = source.index(start)
        end_index = source.index(end, start_index)
        return source[start_index:end_index]


if __name__ == "__main__":
    unittest.main()
