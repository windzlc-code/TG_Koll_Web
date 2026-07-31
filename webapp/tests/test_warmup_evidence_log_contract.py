import tempfile
import unittest
from pathlib import Path

from webapp import social_automation_api


class WarmupEvidenceLogContractTests(unittest.TestCase):
    def _row(self, screenshot_path: str) -> dict:
        return {
            "id": 1,
            "task_id": "task-warmup-1",
            "level": "info",
            "stage": "instagram_warmup_like_1",
            "message": "已保存截图。",
            "data_json": "{}",
            "screenshot_path": screenshot_path,
            "created_at": 1,
        }

    def test_deleted_source_screenshot_is_not_exposed_as_log_media(self):
        missing = "/data/webapp_data/social_automation/screenshots/deleted-source.png"

        public = social_automation_api._log_public(self._row(missing))

        self.assertEqual(public["screenshot_path"], "")
        self.assertEqual(public["screenshot_url"], "")

    def test_existing_composite_screenshot_remains_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            composite = Path(tmpdir) / "warmup-interaction-evidence.jpg"
            composite.write_bytes(b"evidence")

            public = social_automation_api._log_public(self._row(str(composite)))

        self.assertEqual(public["screenshot_path"], str(composite))
        self.assertTrue(
            public["screenshot_url"].endswith(
                "/warmup-interaction-evidence.jpg"
            )
        )


if __name__ == "__main__":
    unittest.main()
