import os
import tempfile
import threading
import time
import traceback
import unittest
from pathlib import Path
from types import SimpleNamespace
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

    def test_concurrent_camoufox_launches_use_their_own_display(self):
        observed = []
        rendezvous = threading.Barrier(2)

        class FakeCamoufox:
            def __init__(self, **kwargs):
                self.expected_display = ":90" if kwargs["user_data_dir"].endswith("profile-a") else ":91"

            def __enter__(self):
                try:
                    rendezvous.wait(timeout=0.05)
                except threading.BrokenBarrierError:
                    pass
                time.sleep(0.01)
                observed.append((self.expected_display, os.environ.get("DISPLAY")))
                return object()

        original_display = os.environ.get("DISPLAY")
        managers = []
        for suffix, display in (("profile-a", ":90"), ("profile-b", ":91")):
            manager = runner._BrowserContextManager({"id": suffix}, None, _RecordingLogger())
            manager.live_session = SimpleNamespace(id=f"live-{suffix}", display=display)
            managers.append((manager, {"user_data_dir": suffix}))

        threads = [threading.Thread(target=manager._enter_camoufox, args=(FakeCamoufox, kwargs)) for manager, kwargs in managers]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=1)

        self.assertEqual(sorted(observed), [(':90', ':90'), (':91', ':91')])
        self.assertEqual(os.environ.get("DISPLAY"), original_display)

    def test_completed_task_closes_live_browser_by_default(self):
        manager = runner._BrowserContextManager(
            {"id": "account-1"},
            None,
            _RecordingLogger(),
            {"task": {"payload": {}}},
        )
        manager.cm = mock.MagicMock()
        manager.live_session = SimpleNamespace(id="live-1")

        with (
            mock.patch.object(manager, "_detach_live_browser_for_standby") as detach,
            mock.patch.object(manager, "_stop_live_browser_session") as stop,
        ):
            manager.__exit__(None, None, None)

        detach.assert_not_called()
        manager.cm.__exit__.assert_called_once_with(None, None, None)
        stop.assert_called_once_with()

    def test_completed_task_can_explicitly_retain_live_browser(self):
        manager = runner._BrowserContextManager(
            {"id": "account-1"},
            None,
            _RecordingLogger(),
            {"task": {"payload": {"retain_live_browser_after_finish": True}}},
        )

        with (
            mock.patch.object(manager, "_detach_live_browser_for_standby", return_value=True) as detach,
            mock.patch.object(manager, "_stop_live_browser_session") as stop,
        ):
            manager.__exit__(None, None, None)

        detach.assert_called_once_with()
        stop.assert_not_called()

    def test_camoufox_exit_failure_still_stops_live_browser(self):
        manager = runner._BrowserContextManager({"id": "account-1"}, None, _RecordingLogger())
        manager.cm = mock.MagicMock()
        manager.cm.__exit__.side_effect = RuntimeError("close failed")

        with (
            mock.patch.object(manager, "_stop_live_browser_session") as stop,
            self.assertRaisesRegex(RuntimeError, "close failed"),
        ):
            manager.__exit__(None, None, None)

        stop.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
