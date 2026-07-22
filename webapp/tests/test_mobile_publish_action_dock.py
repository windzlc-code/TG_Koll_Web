import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
STYLES = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")


class MobilePublishActionDockTests(unittest.TestCase):
    def test_mobile_dock_reuses_the_existing_publish_action(self):
        self.assertIn('class="command-actions ${moduleId === "publishing" ? "publish-command-actions" : ""}"', SCRIPT)
        self.assertIn('id="executeSimpleFlow"', SCRIPT)
        self.assertIn('renderPublishMobileSelectionStrip(selectedPersona(), publishModeForAction)', SCRIPT)

    def test_multi_selection_renders_stable_source_numbers_and_remove_controls(self):
        self.assertIn("function publishMobileSelectionItems", SCRIPT)
        self.assertIn("number: index + 1", SCRIPT)
        self.assertIn('data-publish-mobile-jump="${esc(item.id)}"', SCRIPT)
        self.assertIn('data-publish-mobile-remove="${esc(item.id)}"', SCRIPT)
        self.assertIn("renderClearSelectionIcon()", SCRIPT)
        self.assertIn("if (selectedItems.length < 2) return \"\"", SCRIPT)

    def test_sequence_actions_jump_and_remove_from_the_shared_selection(self):
        self.assertIn('document.querySelectorAll("[data-publish-mobile-jump]")', SCRIPT)
        self.assertIn("scrollIntoView({", SCRIPT)
        self.assertIn('document.querySelectorAll("[data-publish-mobile-remove]")', SCRIPT)
        self.assertIn("setPublishSelectedPostIds(persona, source, selected)", SCRIPT)

    def test_mobile_dock_is_fixed_above_the_existing_bottom_navigation(self):
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        dock = re.search(
            r"\.module-panel\.is-publishing-module \.publish-command-actions\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(dock)
        rule = dock.group(1)
        self.assertIn("position: fixed", rule)
        self.assertIn("bottom: calc(68px + env(safe-area-inset-bottom, 0px))", rule)
        self.assertIn("z-index: 1400", rule)
        self.assertIn("z-index: 1450", media)

    def test_sequence_strip_scrolls_horizontally_without_wrapping(self):
        self.assertRegex(
            STYLES,
            r"\.publish-mobile-selection-strip,\s*\.publish-mobile-selection-count\s*\{[^}]*display:\s*none",
        )
        mobile_strip = re.search(
            r"\.module-panel\.is-publishing-module \.publish-mobile-selection-strip\s*\{([^}]+)\}",
            STYLES,
        )
        self.assertIsNotNone(mobile_strip)
        rule = mobile_strip.group(1)
        self.assertIn("display: flex", rule)
        self.assertIn("overflow-x: auto", rule)
        self.assertIn("touch-action: pan-x", rule)


if __name__ == "__main__":
    unittest.main()
