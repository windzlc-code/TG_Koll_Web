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

    def test_persona_hot_fetch_uses_strict_policy_for_bounded_freshness(self):
        source = (
            Path(__file__).resolve().parents[1]
            / "webapp"
            / "static"
            / "assets"
            / "console.js"
        ).read_text(encoding="utf-8")

        freshness_field = source.index("freshness_days: form.hotFreshnessDays")
        payload_tail = source[freshness_field : freshness_field + 500]
        self.assertIn(
            'freshness_policy: form.hotFreshnessDays > 0 ? "strict" : "legacy"',
            payload_tail,
        )


if __name__ == "__main__":
    unittest.main()
