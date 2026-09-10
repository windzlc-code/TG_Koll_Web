import tempfile
import unittest
from pathlib import Path
from unittest import mock

from webapp import server


class PersonaHotKeywordModeVersionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.runtime_dir = Path(self.temp_dir.name)
        self.runtime_patch = mock.patch.object(server, "TOOL_R18_RUNTIME_DIR", self.runtime_dir)
        self.runtime_patch.start()

    def tearDown(self):
        self.runtime_patch.stop()
        self.temp_dir.cleanup()

    @staticmethod
    def _payload(mode: str):
        return server.PersonaDashboardHotCandidatesFetchPayload(
            search_mode=mode,
            writing_locale="zh-CN",
        )

    @staticmethod
    def _row(prefix: str):
        return {
            "archive_name": "History Teacher",
            "keywords": [f"{prefix}-{index}" for index in range(20)],
            "strategy_version": server.PERSONA_HOT_KEYWORD_STRATEGY_VERSION,
            "cursor": 0,
            "batch_uses": 0,
            "cycles": 0,
            "must_regenerate": False,
        }

    def test_old_normal_prompt_plan_regenerates_without_invalidating_strict_plan(self):
        normal_payload = self._payload("normal")
        strict_payload = self._payload("strict")
        strict_keywords = self._row("strict")["keywords"]
        state = {
            server._persona_hot_keyword_batch_key("persona-1", normal_payload): self._row("old-normal"),
            server._persona_hot_keyword_batch_key("persona-1", strict_payload): self._row("strict"),
        }
        server._write_persona_hot_keyword_batch_state(state)
        generated = [f"new-normal-{index}" for index in range(20)]

        with mock.patch.object(server, "_remote_fetch_archive_snapshot", return_value=None), mock.patch.object(
            server,
            "_run_persona_hot_workflow_cli",
            return_value={
                "ok": True,
                "archiveName": "History Teacher",
                "keywords": generated,
                "searchMode": "normal",
                "warnings": [],
            },
        ) as workflow:
            normal_result = server._prepare_persona_hot_keywords("persona-1", normal_payload)
            strict_result = server._prepare_persona_hot_keywords("persona-1", strict_payload)

        self.assertEqual(normal_result["all_keywords"], generated)
        self.assertEqual(strict_result["all_keywords"], strict_keywords)
        self.assertEqual(workflow.call_count, 1)
        stored = server._read_persona_hot_keyword_batch_state()
        normal_row = stored[server._persona_hot_keyword_batch_key("persona-1", normal_payload)]
        strict_row = stored[server._persona_hot_keyword_batch_key("persona-1", strict_payload)]
        self.assertEqual(normal_row["normal_prompt_version"], server.PERSONA_HOT_NORMAL_KEYWORD_PROMPT_VERSION)
        self.assertNotIn("normal_prompt_version", strict_row)


if __name__ == "__main__":
    unittest.main()
