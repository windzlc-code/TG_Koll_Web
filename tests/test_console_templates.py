import unittest
from pathlib import Path


class ConsoleTemplateMarkupTests(unittest.TestCase):
    def test_persona_profile_is_a_single_long_page(self):
        source = (
            Path(__file__).resolve().parents[1]
            / "webapp"
            / "static"
            / "assets"
            / "console.js"
        ).read_text(encoding="utf-8")
        panel_start = source.index("function renderPersonaSettingsPanelV2")
        panel_end = source.index("function renderPersonaAccountPanelV2", panel_start)
        panel = source[panel_start:panel_end]

        self.assertNotIn("data-persona-profile-mode", source)
        self.assertNotIn("renderPersonaProfileModeTabs", source)
        self.assertNotIn('profileMode ===', panel)
        markers = (
            "renderPersonaContentOverview(persona, account, profile)",
            'class="persona-profile-edit-main',
            "renderPersonaImagePanel(persona)",
            'id="personaTweetStyleSample"',
        )
        positions = [panel.index(marker) for marker in markers]
        self.assertEqual(positions, sorted(positions))

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
