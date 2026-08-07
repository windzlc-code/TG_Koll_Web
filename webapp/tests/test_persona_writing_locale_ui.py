import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = REPO_ROOT / "webapp" / "static" / "assets"


class PersonaWritingLocaleUiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (ASSET_ROOT / "console.js").read_text(encoding="utf-8")
        cls.styles = (ASSET_ROOT / "console.css").read_text(encoding="utf-8")

    def test_locale_labels_follow_the_console_language_without_changing_locale_codes(self):
        self.assertIn('["en-US", "英语", "英語"]', self.script)
        self.assertIn('["ja-JP", "日语", "日語"]', self.script)
        self.assertIn("function personaWritingLocaleLabel(", self.script)
        self.assertIn('language === "zh-Hant"', self.script)
        self.assertIn("writing_locale:", self.script)
        self.assertIn("String(form.writingLocale)", self.script)

    def test_mobile_locale_picker_is_scroll_bounded_and_keeps_desktop_select(self):
        self.assertIn('class="persona-writing-locale-select"', self.script)
        self.assertIn('data-persona-writing-locale-open', self.script)
        self.assertIn("async function openPersonaWritingLocalePicker()", self.script)
        self.assertIn('data-modal-key="persona-writing-locale-picker"', self.styles)
        self.assertIn("overflow-y: auto;", self.styles)
        self.assertIn("max-height: min(58vh, 420px);", self.styles)
        self.assertIn(".persona-writing-locale-mobile", self.styles)

    def test_locale_control_is_reused_by_new_generation_and_draft_ai_rewrite(self):
        panel_start = self.script.index("function renderPersonaContentPanel(")
        panel_end = self.script.index("\nfunction cancelScheduledSocialViewRefresh", panel_start)
        panel = self.script[panel_start:panel_end]
        self.assertGreaterEqual(panel.count("renderPersonaWritingLocaleSelect("), 2)
        edit_start = panel.index('generateMode === "custom"')
        edit_end = panel.index('generateMode === "hot"', edit_start)
        self.assertIn("renderPersonaWritingLocaleSelect(", panel[edit_start:edit_end])


if __name__ == "__main__":
    unittest.main()
