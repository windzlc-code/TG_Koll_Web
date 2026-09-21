import tempfile
import time
import unittest
from pathlib import Path

from webapp import server, social_automation_api


class ArchiveLockCompatibilityTests(unittest.TestCase):
    def _stale_lock(self, directory: str) -> Path:
        path = Path(directory) / "persona_archives.lock"
        created_ms = int((time.time() - 3600) * 1000)
        path.write_text(f"999999 {created_ms}\n", encoding="utf-8")
        return path

    def test_server_removes_stale_node_millisecond_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._stale_lock(directory)
            self.assertTrue(server._remove_stale_lock_file(path))
            self.assertFalse(path.exists())

    def test_social_api_removes_stale_node_millisecond_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._stale_lock(directory)
            self.assertTrue(social_automation_api._remove_stale_archive_lock(path))
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
