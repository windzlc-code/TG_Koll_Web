import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
STYLES = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")


class MobilePublishActionDockTests(unittest.TestCase):
    def test_mobile_dock_reuses_the_existing_publish_action(self):
        self.assertIn('class="command-actions ${moduleId === "publishing" ? `publish-command-actions${publishSelectionExpanded ? " is-selection-expanded" : ""}` : ""}"', SCRIPT)
        self.assertIn('id="executeSimpleFlow"', SCRIPT)
        self.assertIn('renderPublishMobileSelectionStrip(selectedPersona(), publishModeForAction, publishSelectionExpanded)', SCRIPT)
        self.assertIn('moduleId === "publishing" ? "发布" : "确认执行"', SCRIPT)

    def test_selection_strip_only_opens_after_a_long_press(self):
        self.assertIn("const PUBLISH_SELECTION_LONG_PRESS_MS = 520;", SCRIPT)
        self.assertIn("function bindPublishMobileSelectionLongPress()", SCRIPT)
        self.assertIn('trigger.addEventListener("pointerdown"', SCRIPT)
        self.assertIn("setPublishMobileSelectionExpanded(dock, true);", SCRIPT)
        self.assertIn('trigger.dataset.publishSelectionLongPress = "true";', SCRIPT)
        self.assertIn('aria-controls="publishMobileSelectionStrip" aria-expanded="${publishSelectionExpanded ? "true" : "false"}"', SCRIPT)
        self.assertIn('aria-hidden="true"', SCRIPT)

    def test_long_press_does_not_submit_the_publish_action(self):
        self.assertIn('if (trigger?.dataset.publishSelectionLongPress === "true")', SCRIPT)
        self.assertIn('if (action?.dataset?.publishSelectionLongPress === "true") return false;', SCRIPT)
        self.assertIn("event.preventDefault();", SCRIPT)
        self.assertIn("event.stopPropagation();", SCRIPT)
        self.assertIn("delete trigger.dataset.publishSelectionLongPress;", SCRIPT)

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
        self.assertIn("bottom: var(--mobile-task-dock-height)", rule)
        self.assertIn("z-index: 1400", rule)
        self.assertIn("justify-content: stretch", rule)
        self.assertIn("justify-items: stretch", rule)
        self.assertIn("grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)", rule)
        self.assertIn("right: 0", rule)
        self.assertIn("left: 0", rule)
        self.assertIn("z-index: 1450", media)

    def test_mobile_publish_action_and_navigation_share_one_height(self):
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        self.assertIn("--mobile-task-dock-height:", media)
        self.assertIn("padding-bottom: var(--mobile-task-dock-height)", media)
        self.assertIn("bottom: var(--mobile-task-dock-height)", media)
        self.assertIn("height: var(--mobile-task-dock-height)", media)
        self.assertIn("min-height: var(--mobile-task-dock-height)", media)

    def test_mobile_publish_action_text_is_centered(self):
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        action = re.search(
            r"\.module-panel\.is-publishing-module \.publish-command-actions #executeSimpleFlow\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(action)
        self.assertIn("display: grid", action.group(1))
        self.assertIn("padding: 9px 42px", action.group(1))
        self.assertIn("place-items: center", action.group(1))
        self.assertIn("grid-column: 2", action.group(1))
        self.assertIn("width: 100%", action.group(1))
        self.assertIn("border-radius: 9px", action.group(1))

    def test_mobile_publish_action_edit_mode_has_clear_publish_and_cancel(self):
        self.assertIn('id="clearPublishMobileSelectionEdit"', SCRIPT)
        self.assertIn('class="publish-mobile-selection-clear"', SCRIPT)
        self.assertIn('id="cancelPublishMobileSelectionEdit"', SCRIPT)
        self.assertIn('class="publish-mobile-selection-cancel"', SCRIPT)
        self.assertIn('aria-hidden="${publishSelectionExpanded ? "false" : "true"}"', SCRIPT)
        self.assertIn('setPublishMobileSelectionExpanded(dock, false);', SCRIPT)
        self.assertIn("setPublishSelectedPostIds(persona, source, []);", SCRIPT)
        self.assertIn("state.publishMobileSelectionExpanded = nextExpanded;", SCRIPT)
        self.assertIn('publish-command-actions${publishSelectionExpanded ? " is-selection-expanded" : ""}', SCRIPT)
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        shared_action = re.search(
            r"\.module-panel\.is-publishing-module :is\(\s*\.publish-mobile-selection-clear,\s*\.publish-mobile-selection-cancel\s*\)\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(shared_action)
        self.assertIn("border-radius: 9px", shared_action.group(1))
        self.assertIn("visibility: hidden", shared_action.group(1))
        clear = re.search(
            r"\.module-panel\.is-publishing-module \.publish-mobile-selection-clear\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(clear)
        self.assertIn("grid-column: 1", clear.group(1))
        cancel = re.search(
            r"\.module-panel\.is-publishing-module \.publish-mobile-selection-cancel\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(cancel)
        self.assertIn("grid-column: 3", cancel.group(1))
        expanded_actions = re.search(
            r"\.publish-command-actions\.is-selection-expanded :is\(\s*\.publish-mobile-selection-clear,\s*\.publish-mobile-selection-cancel\s*\)\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(expanded_actions)
        self.assertIn("visibility: visible", expanded_actions.group(1))
        self.assertIn("pointer-events: auto", expanded_actions.group(1))

        dock = re.search(
            r"\.module-panel\.is-publishing-module \.publish-command-actions\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(dock)
        self.assertIn("column-gap: 10px", dock.group(1))

    def test_selection_strip_only_collapses_from_its_cancel_control(self):
        self.assertNotIn(
            'const expandedDock = document.querySelector(".publish-command-actions.is-selection-expanded");',
            SCRIPT,
        )
        cancel_handler = SCRIPT.split('$("cancelPublishMobileSelectionEdit")?.addEventListener("click"', 1)[1]
        cancel_handler = cancel_handler.split("});", 1)[0]
        self.assertIn("setPublishMobileSelectionExpanded(dock, false);", cancel_handler)

    def test_mobile_only_selection_actions_are_hidden_by_default(self):
        self.assertRegex(
            STYLES,
            r"\.publish-mobile-selection-strip,\s*"
            r"\.publish-mobile-selection-count,\s*"
            r"\.publish-mobile-selection-clear,\s*"
            r"\.publish-mobile-selection-cancel\s*\{[^}]*display:\s*none",
        )

    def test_mobile_link_and_sequence_tools_render_before_the_publish_source(self):
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        preview = re.search(
            r"\.publish-content-preview--selection\s*\{([^}]+)\}",
            media,
        )
        self.assertIsNotNone(preview)
        self.assertIn("display: block", preview.group(1))
        self.assertIn("order: -2", preview.group(1))

    def test_custom_mode_link_settings_use_the_same_mobile_position(self):
        panel_start = SCRIPT.index("function renderPublishContentPanel")
        layout = SCRIPT.index('<div class="publish-content-layout">', panel_start)
        mobile_link = SCRIPT.index('class="publish-mobile-custom-link-settings"', layout)
        preview = SCRIPT.index("${renderPublishContentPreview(persona, source)}", mobile_link)
        self.assertLess(layout, mobile_link)
        self.assertLess(mobile_link, preview)
        self.assertIn('${source === "custom" ? `<div class="publish-mobile-custom-link-settings">${renderPublishLinkSettings(persona)}</div>` : ""}', SCRIPT)
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        self.assertIn(".publish-mobile-custom-link-settings", media)
        self.assertIn(".publish-content-preview:not(.publish-content-preview--selection) > .publish-link-settings", media)
        custom_link_rules = re.findall(
            r"\.publish-mobile-custom-link-settings\s*\{([^}]+)\}",
            media,
        )
        self.assertTrue(
            any("order: -2" in rule for rule in custom_link_rules),
        )
        self.assertFalse(any("margin-bottom" in rule for rule in custom_link_rules))

    def test_publish_source_modes_do_not_render_layout_shifting_helper_copy(self):
        self.assertIn('if (cleanSource === "custom") return "";', SCRIPT)
        self.assertNotIn("自定义模式不需要选择草稿，右侧直接输入发布内容。", SCRIPT)
        self.assertNotIn("请先在左侧选择要发布的内容。", SCRIPT)

    def test_missing_publish_account_is_checked_before_busy_state_starts(self):
        handler = SCRIPT.index('if ($("executeSimpleFlow")) $("executeSimpleFlow").addEventListener("click"')
        preflight = SCRIPT.index("await preflightSimpleFlowExecution(moduleId)", handler)
        pending = SCRIPT.index("state.simpleFlowPending = true;", handler)
        self.assertLess(preflight, pending)
        self.assertIn("async function preflightSimpleFlowExecution", SCRIPT)
        self.assertIn("await promptPersonaAccountBinding(persona);", SCRIPT)

    def test_mobile_publish_media_defers_decode_and_offscreen_paint(self):
        self.assertIn('loading="lazy" decoding="async"', SCRIPT)
        self.assertIn("lowPriority: true", SCRIPT)
        self.assertIn("fetchpriority=\"low\"", SCRIPT)
        self.assertIn("content-visibility: auto", STYLES)
        self.assertIn("contain-intrinsic-size: auto 420px", STYLES)

    def test_remove_icon_is_positioned_in_the_chip_top_right(self):
        remove_rule = re.search(r"button\.publish-mobile-selection-remove\s*\{([^}]+)\}", STYLES)
        self.assertIsNotNone(remove_rule)
        self.assertIn("position: absolute", remove_rule.group(1))
        self.assertIn("top: -6px", remove_rule.group(1))
        self.assertIn("right: -7px", remove_rule.group(1))
        self.assertIn("width: 20px", remove_rule.group(1))
        self.assertIn("height: 20px", remove_rule.group(1))
        self.assertIn("padding: 0", remove_rule.group(1))
        self.assertIn("border-radius: 999px", remove_rule.group(1))
        self.assertIn("background: var(--ink)", remove_rule.group(1))
        self.assertIn("width: 11px", STYLES)
        self.assertIn("height: 11px", STYLES)
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
            r"\.publish-mobile-selection-strip,\s*"
            r"\.publish-mobile-selection-count,\s*"
            r"\.publish-mobile-selection-clear,\s*"
            r"\.publish-mobile-selection-cancel\s*\{[^}]*display:\s*none",
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
        self.assertIn("max-height: 0", rule)
        self.assertIn("opacity: 0", rule)
        self.assertIn("visibility: hidden", rule)
        self.assertIn("pointer-events: none", rule)
        self.assertIn("cubic-bezier(0.22, 1.42, 0.36, 1)", rule)
        expanded_strip = re.search(
            r"\.publish-command-actions\.is-selection-expanded \.publish-mobile-selection-strip\s*\{([^}]+)\}",
            STYLES,
        )
        self.assertIsNotNone(expanded_strip)
        expanded_rule = expanded_strip.group(1)
        self.assertIn("max-height: 58px", expanded_rule)
        self.assertIn("margin-bottom: 10px", expanded_rule)
        self.assertIn("opacity: 1", expanded_rule)
        self.assertIn("visibility: visible", expanded_rule)
        self.assertIn("pointer-events: auto", expanded_rule)

    def test_selection_strip_animates_both_open_and_close_with_a_gap(self):
        media = STYLES.split("@media (max-width: 760px)", 1)[1]
        self.assertIn("transform: translateY(14px) scale(0.96)", media)
        self.assertIn("transform: translateY(0) scale(1)", media)
        self.assertIn("visibility 0s linear 320ms", media)
        self.assertIn("transition-delay: 0s", media)
        self.assertIn("margin-bottom: 10px", media)
        self.assertIn("@media (prefers-reduced-motion: reduce)", media)
        self.assertIn("transition: none", media)

    def test_sequence_jump_fills_the_chip_so_its_number_is_centered(self):
        jump_rules = re.findall(
            r"\.console-page \.module-panel\.is-publishing-module \.publish-mobile-selection-jump\s*\{([^}]+)\}",
            STYLES,
        )
        self.assertTrue(jump_rules)
        centered_rule = next((rule for rule in jump_rules if "width: 100%" in rule), "")
        self.assertIn("width: 100%", centered_rule)
        self.assertIn("height: 100%", centered_rule)


if __name__ == "__main__":
    unittest.main()
