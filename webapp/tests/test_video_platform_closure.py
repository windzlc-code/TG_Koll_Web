from __future__ import annotations

import json
import unittest

from webapp import video_workbench


class VideoPlatformClosureTests(unittest.TestCase):
    def setUp(self) -> None:
        video_workbench._VIDEO_LOCAL_CONCURRENCY_LIMIT = None

    def test_runtime_defaults_ignore_client_supplier_and_concurrency_overrides(self):
        runtime = {
            "video_runninghub_base_url": "https://trusted.runninghub.example",
            "runninghub_personal_api_key": "trusted-key",
            "video_create_video_app_id": "trusted-workflow",
            "video_local_max_concurrency": 3,
        }
        merged = video_workbench.apply_video_runtime_defaults(
            "create_video",
            {
                "video_runninghub_base_url": "https://attacker.example",
                "video_runninghub_api_key": "client-key",
                "runninghub_api_key": "client-key-2",
                "video_create_video_app_id": "client-workflow",
                "oral_digital_human_workflow_ids": ["client-workflow"],
                "video_local_max_concurrency": 16,
                "ffmpeg_path": "C:/untrusted/ffmpeg.exe",
                "speech_text": "keep me",
            },
            runtime,
        )

        self.assertEqual(merged["video_runninghub_base_url"], "https://trusted.runninghub.example")
        self.assertEqual(merged["video_runninghub_api_key"], "trusted-key")
        self.assertEqual(merged["runninghub_api_key"], "trusted-key")
        self.assertEqual(merged["video_create_video_app_id"], "trusted-workflow")
        self.assertEqual(merged["video_local_max_concurrency"], 3)
        self.assertNotIn("ffmpeg_path", merged)
        self.assertEqual(merged["speech_text"], "keep me")

    def test_video_storage_payload_removes_runtime_secrets_recursively(self):
        stored = video_workbench.video_task_payload_for_storage(
            "create_video",
            {
                "speech_text": "public",
                "video_runninghub_api_key": "rh-secret",
                "minimax_api_key": "tts-secret",
                "nested": {"api_key": "nested-secret", "value": 7},
                "items": [{"token": "item-secret", "name": "safe"}],
            },
        )

        dumped = json.dumps(stored, ensure_ascii=False)
        self.assertEqual(stored["speech_text"], "public")
        self.assertEqual(stored["nested"], {"value": 7})
        self.assertEqual(stored["items"], [{"name": "safe"}])
        self.assertNotIn("secret", dumped)

    def test_remote_cancel_uses_server_runtime_and_all_checkpoint_ids(self):
        calls = []

        def cancel_fn(**kwargs):
            calls.append(kwargs)
            return {"ok": True, "message": "cancelled"}

        results = video_workbench.cancel_video_remote_tasks(
            "replace_model",
            input_payload={"video_runninghub_api_key": "stale-client-key"},
            output_payload={
                "video_checkpoint": {
                    "runninghub_task_id": "rh-1",
                    "runninghub_task_ids": ["rh-1", "rh-2"],
                },
                "raw_result": {"runninghub_task_ids": ["rh-3"]},
            },
            runninghub_task_id="rh-0",
            runtime={
                "video_runninghub_base_url": "https://trusted.runninghub.example",
                "runninghub_personal_api_key": "server-key",
            },
            cancel_fn=cancel_fn,
        )

        self.assertEqual([item["task_id"] for item in results], ["rh-0", "rh-1", "rh-2", "rh-3"])
        self.assertEqual([item["task_id"] for item in calls], ["rh-0", "rh-1", "rh-2", "rh-3"])
        self.assertTrue(all(item["api_key"] == "server-key" for item in calls))
        self.assertTrue(all(item["base_url"] == "https://trusted.runninghub.example" for item in calls))


if __name__ == "__main__":
    unittest.main()
