import unittest
from pathlib import Path


class ConsoleTemplateMarkupTests(unittest.TestCase):
    def test_persona_group_toggle_closes_aria_expanded_attribute(self):
        source = (
            Path(__file__).resolve().parents[1]
            / "webapp"
            / "static"
            / "assets"
            / "console.js"
        ).read_text(encoding="utf-8")

        self.assertNotIn('aria-expanded="${collapsed ? "false" : "true"}>', source)
        self.assertIn('aria-expanded="${collapsed ? "false" : "true"}"', source)


if __name__ == "__main__":
    unittest.main()
