import tempfile
import traceback
import unittest
from pathlib import Path
from unittest import mock

from social_automation import runner


class _RecordingLogger:
    def __init__(self):
        self.entries = []

    def log(self, level, stage, message, data=None, screenshot_path=""):
        self.entries.append(
            {
                "level": level,
                "stage": stage,
                "message": message,
                "data": data or {},
                "screenshot_path": screenshot_path,
            }
        )


class RunnerProxyRedactionTests(unittest.TestCase):
    def setUp(self):
        self.proxy = {
            "proxy_type": "socks5",
            "host": "proxy.example.test",
            "port": 1080,
            "username": "resident-user@example.test",
            "password": "p@ss/word:with spaces",
        }

    def test_proxy_config_keeps_structured_credentials_for_camoufox(self):
        self.assertEqual(
            runner._proxy_config(self.proxy),
            {
                "server": "socks5://proxy.example.test:1080",
                "username": "resident-user@example.test",
                "password": "p@ss/word:with spaces",
            },
        )

    def test_masked_proxy_hides_username_and_password(self):
        masked = runner._masked_proxy(runner._proxy_config(self.proxy))

        self.assertEqual(masked["server"], "socks5://proxy.example.test:1080")
        self.assertEqual(masked["username"], "***")
        self.assertEqual(masked["password"], "***")

    def test_camoufox_launch_error_and_log_redact_proxy_credentials(self):
        username = self.proxy["username"]
        password = self.proxy["password"]
        authenticated_url = (
            "socks5://resident-user%40example.test:"
            "p%40ss%2Fword%3Awith%20spaces@proxy.example.test:1080"
        )
        launch_error = RuntimeError(
            f"Failed to connect to proxy: {authenticated_url}; "
            f"proxy={{'username': '{username}', 'password': '{password}'}}"
        )
        logger = _RecordingLogger()

        with tempfile.TemporaryDirectory() as temp_dir:
            manager = runner._BrowserContextManager(
                {"id": "account-1", "profile_dir": str(Path(temp_dir) / "profile")},
                self.proxy,
                logger,
            )
            with (
                mock.patch.object(manager, "_start_live_browser_session", return_value=None),
                mock.patch.object(manager, "_enter_camoufox", side_effect=launch_error),
                self.assertRaises(RuntimeError) as raised,
            ):
                manager.__enter__()

        rendered = "".join(traceback.format_exception(raised.exception)) + f"\n{logger.entries}"
        self.assertNotIn(username, rendered)
        self.assertNotIn(password, rendered)
        self.assertNotIn("resident-user%40example.test", rendered)
        self.assertNotIn("p%40ss%2Fword%3Awith%20spaces", rendered)
        self.assertNotIn(authenticated_url, rendered)
        self.assertIn("socks5://***:***@proxy.example.test:1080", str(raised.exception))
        self.assertTrue(raised.exception.__suppress_context__)


if __name__ == "__main__":
    unittest.main()
