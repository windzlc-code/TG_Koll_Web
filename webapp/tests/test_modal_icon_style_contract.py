from pathlib import Path
import unittest


class ModalIconStyleContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.styles = (Path(__file__).resolve().parents[1] / "static" / "assets" / "console.css").read_text(encoding="utf-8")

    def _rule(self, selector: str, next_selector: str) -> str:
        start = self.styles.index(selector)
        end = self.styles.index(next_selector, start)
        return self.styles[start:end]

    def test_persona_image_viewer_uses_project_dark_theme_without_framed_icons(self):
        viewer = self._rule(".persona-media-lightbox {", ".notice {")
        icon_rule = self._rule(
            ".persona-media-lightbox-icon-button {",
            ".persona-media-lightbox-icon-button:hover,",
        )

        self.assertIn("--viewer-bg: #080a0b;", viewer)
        self.assertIn("--viewer-surface: #111416;", viewer)
        self.assertIn("--viewer-focus: #62d5b2;", viewer)
        self.assertIn("background: var(--viewer-surface);", viewer)
        self.assertIn("background: var(--viewer-bg);", viewer)
        self.assertNotIn("#111817", viewer)
        self.assertNotIn("#0f766e", viewer)
        self.assertIn("border: 0;", icon_rule)
        self.assertIn("background: transparent;", icon_rule)
        self.assertNotIn("border: 1px", icon_rule)

    def test_shared_modal_close_and_back_icons_have_no_outer_frame(self):
        close_rule = self._rule(
            ".console-page .console-modal-head .console-modal-close {",
            ".console-page .console-modal-head .console-modal-close:hover,",
        )
        back_rule = self._rule(
            ".persona-profile-editor-back {",
            ".persona-profile-editor-back:hover,",
        )
        mobile_back_rule = self._rule(
            ".mobile-page-toolbar > .mobile-nav-toggle.is-page-back {",
            "@media (max-width: 980px) {",
        )

        for rule in (close_rule, back_rule, mobile_back_rule):
            self.assertIn("border: 0;", rule)
            self.assertIn("background: transparent;", rule)
            self.assertNotIn("border: 1px", rule)


if __name__ == "__main__":
    unittest.main()
