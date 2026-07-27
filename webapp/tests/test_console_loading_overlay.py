from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_HTML = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")


class ConsoleLoadingOverlayTests(unittest.TestCase):
    def test_initial_console_loader_is_visible_until_bootstrap_finishes(self):
        self.assertIn('id="consolePageLoading"', CONSOLE_HTML)
        self.assertEqual(CONSOLE_HTML.count('class="console-page-loading-orbit"'), 1)
        self.assertEqual(CONSOLE_HTML.count('--loader-dot:'), 10)
        self.assertIn('.console-page-loading {', CONSOLE_CSS)
        self.assertIn('.console-page.is-console-ready .console-page-loading {', CONSOLE_CSS)
        self.assertIn('transition: opacity 260ms ease, visibility 0s linear 260ms;', CONSOLE_CSS)
        self.assertIn('@keyframes console-page-loading-dot', CONSOLE_CSS)

    def test_loader_waits_for_initial_console_data_before_fading_out(self):
        self.assertIn('function setConsolePageLoading(loading)', CONSOLE_JS)
        self.assertIn('setConsolePageLoading(true);', CONSOLE_JS)
        self.assertIn('setConsolePageLoading(false);', CONSOLE_JS)
        self.assertIn('await Promise.all([tasksReady, socialReady, personasReady]);', CONSOLE_JS)


if __name__ == "__main__":
    unittest.main()
