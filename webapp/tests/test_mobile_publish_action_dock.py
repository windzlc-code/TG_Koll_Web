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

    def test_selection_renders_publish_order_numbers_and_remove_controls(self):
        self.assertIn("function publishMobileSelectionItems", SCRIPT)
        self.assertIn("number: publishIndex + 1", SCRIPT)
        self.assertIn('data-publish-mobile-jump="${esc(item.id)}"', SCRIPT)
        self.assertIn('data-publish-mobile-remove="${esc(item.id)}"', SCRIPT)
        self.assertIn('class="publish-mobile-selection-remove-icon"', SCRIPT)
        self.assertIn("if (!selectedItems.length) return \"\"", SCRIPT)
        self.assertIn('publish-mobile-selection-chip ${item.id === activeId ? "is-active" : ""}', SCRIPT)

    def test_sequence_actions_jump_and_remove_from_the_shared_selection(self):
        self.assertIn('document.querySelectorAll("[data-publish-mobile-jump]")', SCRIPT)
        self.assertIn("scrollIntoView({", SCRIPT)
        self.assertIn('document.querySelectorAll("[data-publish-mobile-remove]")', SCRIPT)
        self.assertIn("setPublishSelectedPostIds(persona, source, selected)", SCRIPT)
        self.assertIn('node.closest(".publish-mobile-selection-chip")?.classList.toggle("is-active", active)', SCRIPT)

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
        self.assertIn("justify-content: stretch", rule)
        self.assertIn("justify-items: stretch", rule)
        self.assertIn("grid-template-columns: minmax(0, 1fr)", rule)
        self.assertIn("z-index: 1450", media)

    def test_remove_icon_is_positioned_in_the_chip_top_right(self):
        remove_rule = re.search(r"\.publish-mobile-selection-remove\s*\{([^}]+)\}", STYLES)
        self.assertIsNotNone(remove_rule)
        self.assertIn("position: absolute", remove_rule.group(1))
        self.assertIn("top: 2px", remove_rule.group(1))
        self.assertIn("right: 2px", remove_rule.group(1))
        self.assertIn("stroke: currentColor", STYLES)

    def test_sequence_strip_has_no_outer_card_and_active_chip_is_fully_highlighted(self):
        mobile_strip = re.search(
            r"\.module-panel\.is-publishing-module \.publish-mobile-selection-strip\s*\{([^}]+)\}",
            STYLES,
        )
        self.assertIsNotNone(mobile_strip)
        rule = mobile_strip.group(1)
        self.assertIn("border: 0", rule)
        self.assertIn("background: transparent", rule)
        self.assertIn("box-shadow: none", rule)
        active = re.search(r"\.publish-mobile-selection-chip\.is-active\s*\{([^}]+)\}", STYLES)
        self.assertIsNotNone(active)
        self.assertIn("background: var(--accent)", active.group(1))

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
