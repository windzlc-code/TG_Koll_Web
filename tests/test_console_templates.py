import unittest
from pathlib import Path


class ConsoleTemplateMarkupTests(unittest.TestCase):
    def test_persona_profile_uses_inline_editor_data_and_account_columns(self):
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
        overview_start = source.index("function renderPersonaContentOverview")
        overview_end = source.index("function renderPersonaImagePanel", overview_start)
        overview = source[overview_start:overview_end]
        markers = (
            "renderPersonaProfileIdentity(persona, profile)",
            "renderPersonaDataPanel(persona)",
            "renderPersonaImagePanel(persona)",
            "renderPersonaAccountPanelV2(persona, account, profile, \"binding\")",
        )
        positions = [overview.index(marker) for marker in markers]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("data-persona-edit-profile", source)
        self.assertIn("data-persona-edit-name", source)
        self.assertIn("data-persona-edit-content", source)
        self.assertIn("personaProfileEditDrafts", source)
        self.assertNotIn("personaProfileRegenDrafts", source)
        self.assertIn("data-persona-save-profile", source)
        self.assertIn("data-persona-cancel-profile-edit", source)
        self.assertIn("data-persona-open-links", source)
        self.assertIn("data-persona-open-style", source)
        self.assertIn("data-persona-avatar-crop-open", source)
        self.assertIn("persona-avatar-add-button", source)
        self.assertIn("persona-avatar-placeholder", source)
        self.assertIn("data-persona-avatar-crop-stage", source)
        self.assertIn("data-persona-avatar-crop-viewport", source)
        self.assertIn("persona-avatar-crop-backdrop", source)
        self.assertIn("data-persona-avatar-crop-option", source)
        self.assertNotIn("data-persona-avatar-zoom", source)
        self.assertIn("failedMediaPreviewUrls", source)
        self.assertIn("renderModalCloseButton", source)
        self.assertIn("directMediaPreviewUrl(item?.preview_url", source)
        self.assertIn("await loadPersonaImageLibrary(persona.id, { force: true })", source)
        self.assertIn("if (!hasImages)", source)
        self.assertIn("persona-profile-section--empty-images", source)
        self.assertIn('modalKey: "persona-link-settings"', source)
        self.assertIn('modalKey: "persona-tweet-style"', source)
        self.assertIn("persona-profile-overview-layout", source)
        self.assertIn("persona-profile-intro-actions", source)
        self.assertIn("persona-profile-data-panel", source)
        self.assertIn("persona-profile-image-settings-panel", source)
        self.assertIn("persona-profile-account-panel", source)
        self.assertIn("persona-hot-summary-card--profile", source)
        self.assertIn("persona-hot-summary-card--hot", source)
        self.assertNotIn("persona-profile-activity-grid", overview)
        self.assertNotIn('id="personaTweetStyleSample"', panel)
        self.assertNotIn('data-persona-avatar-crop="', source)
        self.assertNotIn('class="persona-profile-editor-section"', panel)

        styles = (
            Path(__file__).resolve().parents[1]
            / "webapp"
            / "static"
            / "assets"
            / "console.css"
        ).read_text(encoding="utf-8")
        self.assertIn(".console-modal-dialog.persona-link-settings-modal", styles)
        self.assertIn(".persona-profile-settings-grid", styles)
        self.assertIn("@container persona-profile-main", styles)
        self.assertIn("@container persona-account-panel", styles)
        self.assertIn(".persona-avatar-add-button", styles)
        self.assertIn(".console-modal-close", styles)
        self.assertNotIn("width: min(1420px", styles)
        self.assertNotIn("@container persona-account-panel (max-width: 520px)", styles)

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
