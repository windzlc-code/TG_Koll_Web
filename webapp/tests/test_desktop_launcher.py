import unittest
from unittest.mock import MagicMock, patch

import desktop_launcher


class DesktopLauncherTests(unittest.TestCase):
    def test_start_server_works_without_stdout_stream(self):
        mock_server = MagicMock()
        mock_thread = MagicMock()

        with patch("sys.stdout", None), patch("sys.stderr", None):
            with patch.object(desktop_launcher.uvicorn, "Server", return_value=mock_server) as server_cls:
                with patch.object(desktop_launcher.threading, "Thread", return_value=mock_thread) as thread_cls:
                    server, thread = desktop_launcher._start_server(9876)

        self.assertIs(server, mock_server)
        self.assertIs(thread, mock_thread)
        self.assertIs(server_cls.call_args.args[0].log_config, None)
        thread_cls.assert_called_once()
        mock_thread.start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
