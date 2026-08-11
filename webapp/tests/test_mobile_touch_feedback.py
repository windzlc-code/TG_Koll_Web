from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
SITE_NAV_CSS = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
SITE_CSS = (ROOT / "webapp" / "static" / "assets" / "opc" / "styles.css").read_text(encoding="utf-8")


class MobileTouchFeedbackTests(unittest.TestCase):
    def test_mobile_controls_disable_the_native_touch_highlight(self):
        self.assertIn("-webkit-tap-highlight-color: transparent;", CONSOLE_CSS)
        self.assertIn("-webkit-tap-highlight-color: transparent;", SITE_NAV_CSS)
        self.assertIn("-webkit-tap-highlight-color: transparent;", SITE_CSS)
        for stylesheet in (CONSOLE_CSS, SITE_NAV_CSS, SITE_CSS):
            self.assertNotIn("-webkit-tap-highlight-color: rgba(", stylesheet)


if __name__ == "__main__":
    unittest.main()
