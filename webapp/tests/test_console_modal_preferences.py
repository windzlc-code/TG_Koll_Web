import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = REPO_ROOT / "webapp" / "static" / "assets" / "console.js"
CONSOLE_CSS = REPO_ROOT / "webapp" / "static" / "assets" / "console.css"


class ConsoleModalPreferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = CONSOLE_JS.read_text(encoding="utf-8")
        cls.styles = CONSOLE_CSS.read_text(encoding="utf-8")

    def test_custom_publish_leave_warning_uses_shared_remember_control(self):
        custom_state_start = self.source.index('kind: "publish_custom"')
        custom_state = self.source[custom_state_start:self.source.index('const automationPlan', custom_state_start)]
        self.assertIn('title: "离开自定义发布？"', custom_state)
        self.assertIn("未提交的正文不会保存", custom_state)
        self.assertIn('rememberKey: "publish_custom_leave_warning"', custom_state)
        self.assertIn('rememberLabel: "以后不再提示此类离开提醒"', custom_state)

        modal = self.source[self.source.index("function openConsoleModal("):self.source.index("const DAILY_PUBLISH_LIMIT_WARNING")]
        self.assertIn("rememberKey = \"\"", modal)
        self.assertIn('data-console-modal-remember', modal)
        self.assertIn("setConsoleModalRemembered(rememberKey", modal)

    def test_remembered_custom_publish_warning_skips_spa_and_browser_leave_prompts(self):
        boundary = self.source[self.source.index("async function confirmLeaveTransientWorkspaceState"):self.source.index("function selectGeneratedPreviewPost")]
        self.assertIn("isConsoleModalRemembered(activeState.rememberKey)", boundary)
        self.assertIn("rememberKey: activeState.rememberKey || \"\"", boundary)
        unload = self.source[self.source.index('window.addEventListener("beforeunload"'):self.source.index('$("moduleBody").addEventListener("click"', self.source.index('window.addEventListener("beforeunload"'))]
        self.assertIn("isConsoleModalRemembered(activeState.rememberKey)", unload)

    def test_shared_remember_control_has_checkbox_sizing(self):
        remember = self.styles[self.styles.index(".console-modal-dialog .console-modal-remember"):self.styles.index(".console-modal-fields textarea")]
        self.assertIn("display: flex", remember)
        self.assertIn("input[type=\"checkbox\"]", remember)
        self.assertIn("min-height: 16px", remember)
        self.assertIn("accent-color: var(--accent)", remember)


if __name__ == "__main__":
    unittest.main()
