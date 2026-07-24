import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "script.js"
NAVIGATION_PATH = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js"
CONSOLE_PATH = REPO_ROOT / "webapp" / "static" / "console.html"
PROXY_MARKET_PATH = REPO_ROOT / "webapp" / "static" / "proxy-market.html"
PROXY_MARKET_SCRIPT_PATH = REPO_ROOT / "webapp" / "static" / "assets" / "opc" / "proxy-market.js"


class PublicI18nDynamicContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")
        cls.navigation = NAVIGATION_PATH.read_text(encoding="utf-8")
        cls.console = CONSOLE_PATH.read_text(encoding="utf-8")
        cls.proxy_market = PROXY_MARKET_PATH.read_text(encoding="utf-8")
        cls.proxy_market_script = PROXY_MARKET_SCRIPT_PATH.read_text(encoding="utf-8")

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
        self.assertNotIn('aria-label="关闭个人信息"', account_markup)
        self.assertNotIn('title="关闭个人信息"', account_markup)

        sync = self.navigation_slice(
            self.navigation,
            "function sync()",
            "async function syncProxyMarketBadge(",
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

    def test_console_admin_entry_uses_shared_navigation_copy(self):
        self.assertIn('data-site-copy="adminConsole"', self.console)
        self.assertIn('adminConsole: "运营后台"', self.navigation)
        self.assertIn('adminConsole: "營運後台"', self.navigation)

    def test_proxy_market_traditional_guest_copy_is_not_mixed_script(self):
        self.assertNotIn("游客", self.proxy_market)
        self.assertNotIn('"游客瀏覽"', self.proxy_market_script)
        self.assertIn("遊客", self.proxy_market)
        self.assertIn('"遊客瀏覽"', self.proxy_market_script)

    @staticmethod
    def navigation_slice(source, start, end):
        start_index = source.index(start)
        end_index = source.index(end, start_index)
        return source[start_index:end_index]


if __name__ == "__main__":
    unittest.main()
