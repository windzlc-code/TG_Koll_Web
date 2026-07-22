import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
STYLES = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")


def css_rule(selector: str) -> str:
    match = re.search(re.escape(selector) + r"\s*\{([^}]+)\}", STYLES)
    if not match:
        raise AssertionError(f"missing CSS rule: {selector}")
    return match.group(1)


class PersonaDragVisualContractTests(unittest.TestCase):
    def test_pointer_ghost_stays_above_mobile_drawer(self):
        ghost_rule = css_rule(".persona-pointer-ghost")
        drawer_rule = css_rule(".persona-mobile-drawer")
        ghost_z = int(re.search(r"z-index:\s*(\d+)", ghost_rule).group(1))
        drawer_z = int(re.search(r"z-index:\s*(\d+)", drawer_rule).group(1))
        self.assertGreater(ghost_z, drawer_z)

    def test_pointer_ghost_preserves_the_original_grab_position(self):
        self.assertIn("grabOffsetX", SCRIPT)
        self.assertIn("grabOffsetY", SCRIPT)
        self.assertIn("x - grabOffsetX", SCRIPT)
        self.assertIn("y - grabOffsetY", SCRIPT)
        self.assertNotIn("translate(-50%, -50%) scale(1.02)", SCRIPT)

    def test_drop_placeholder_uses_source_card_height_without_height_animation(self):
        self.assertIn("sourceHeight", SCRIPT)
        self.assertIn("placeholder.style.height", SCRIPT)
        keyframes = STYLES.split("@keyframes personaDropSlot", 1)[1].split("}", 2)[0]
        self.assertNotIn("min-height", keyframes)
        self.assertNotIn("transform", keyframes)

    def test_pointer_drag_clears_stale_drop_target_and_cancels_before_rerender(self):
        self.assertIn("drag.hasDropTarget = false", SCRIPT)
        self.assertIn("clearPersonaDropVisuals();", SCRIPT)
        self.assertIn("if (!drag.hasDropTarget)", SCRIPT)
        self.assertIn("if (pointerDrag.pending || pointerDrag.active) cleanupPersonaPointerDrag();", SCRIPT)


if __name__ == "__main__":
    unittest.main()
