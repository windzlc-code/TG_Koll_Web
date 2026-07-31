from pathlib import Path
import unittest


class PersonaPlatformSwitchRenderContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (Path(__file__).resolve().parents[1] / "static" / "assets" / "console.js").read_text(encoding="utf-8")

    def test_draft_platform_switch_keeps_the_persona_shell_mounted(self):
        handler_start = self.source.index('const contentPlatformButton = event.target.closest("[data-persona-content-platform]");')
        handler = self.source[
            handler_start:
            self.source.index('const contentTabButton = event.target.closest("[data-persona-content-tab]");', handler_start)
        ]
        helper_start = self.source.index("function refreshPersonaContentPlatformPanel(")
        helper = self.source[helper_start:self.source.index("\nfunction ", helper_start + 1)]

        self.assertIn("refreshPersonaContentPlatformPanel(persona)", handler)
        self.assertIn("if (!refreshPersonaContentPlatformPanel(persona)) renderPersonaDetail();", handler)
        self.assertIn('contentPanel.outerHTML = renderPersonaContentPanel(', helper)
        self.assertNotIn('$("personaDetail").innerHTML', helper)


if __name__ == "__main__":
    unittest.main()
