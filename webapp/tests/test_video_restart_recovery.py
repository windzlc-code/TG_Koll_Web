from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from webapp import db as db_module
import webapp.server as server


class VideoRestartRecoveryTests(unittest.TestCase):
    def test_inflight_provider_submission_without_task_id_is_not_automatically_resubmitted(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            db_path = Path(tmpdir) / "app.db"
            with mock.patch.dict(os.environ, {"APP_DB_PATH": str(db_path)}):
                db_module.init_db()
                now = server._now_ts()
                with db_module.db() as conn:
                    user_id = int(conn.execute(
                        "INSERT INTO users(username, password_hash, created_at, updated_at) VALUES ('video-uncertain-user', 'unused', ?, ?)",
                        (now, now),
                    ).lastrowid)
                    conn.execute(
                        """
                        INSERT INTO tasks(
                          id, user_id, type, status, input_json, output_json, error,
                          runninghub_task_id, usage_json, created_at, updated_at
                        ) VALUES (?, ?, 'create_video', 'running', '{}', ?, '', '', '{}', ?, ?)
                        """,
                        (
                            "video-provider-uncertain",
                            user_id,
                            json.dumps({"video_checkpoint": {
                                "recoverable": True,
                                "stage": "provider_submitting",
                                "provider_submission_key": "video-provider-uncertain:oral:0:1",
                            }}),
                            now,
                            now,
                        ),
                    )

                with mock.patch.object(server._TASK_QUEUE, "put") as queue_put:
                    server._resume_pending_tasks()

                queue_put.assert_not_called()
                with db_module.db() as conn:
                    task = conn.execute(
                        "SELECT status, output_json, error FROM tasks WHERE id = ?",
                        ("video-provider-uncertain",),
                    ).fetchone()
                self.assertEqual(str(task["status"]), "failed")
                self.assertIn("duplicate paid work", str(task["error"]))
                checkpoint = json.loads(task["output_json"])["video_checkpoint"]
                self.assertEqual(checkpoint["stage"], "provider_submission_uncertain")
                self.assertFalse(checkpoint["recoverable"])

    def test_running_video_task_with_provider_checkpoint_is_requeued_without_new_submission(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            db_path = Path(tmpdir) / "app.db"
            with mock.patch.dict(os.environ, {"APP_DB_PATH": str(db_path)}):
                db_module.init_db()
                now = server._now_ts()
                with db_module.db() as conn:
                    user_id = int(conn.execute(
                        """
                        INSERT INTO users(username, password_hash, created_at, updated_at)
                        VALUES ('video-recovery-user', 'unused', ?, ?)
                        """,
                        (now, now),
                    ).lastrowid)
                    conn.execute(
                        """
                        INSERT INTO tasks(
                          id, user_id, type, status, input_json, output_json, error,
                          runninghub_task_id, usage_json, created_at, updated_at
                        ) VALUES (?, ?, 'create_video', 'running', ?, ?, '', '', '{}', ?, ?)
                        """,
                        (
                            "video-running-1",
                            user_id,
                            json.dumps({"source": "video_workbench_api", "duration_seconds": 5}),
                            json.dumps({
                                "video_checkpoint": {
                                    "recoverable": True,
                                    "stage": "provider_running",
                                    "runninghub_task_id": "rh-existing-1",
                                    "runninghub_task_ids": ["rh-existing-1"],
                                }
                            }),
                            now,
                            now,
                        ),
                    )

                with mock.patch.object(server._TASK_QUEUE, "put") as queue_put:
                    server._resume_pending_tasks()

                queue_put.assert_called_once()
                queued_args = queue_put.call_args.args[0]
                self.assertEqual(queued_args[0], "video-running-1")
                self.assertEqual(queued_args[2], "create_video")
                self.assertEqual(queued_args[3]["resume_runninghub_task_id"], "rh-existing-1")

                with db_module.db() as conn:
                    task = conn.execute(
                        "SELECT status, input_json, error FROM tasks WHERE id = ?",
                        ("video-running-1",),
                    ).fetchone()
                self.assertEqual(str(task["status"]), "queued")
                self.assertEqual(str(task["error"] or ""), "")
                persisted = json.loads(task["input_json"])
                self.assertTrue(persisted["resume_after_restart"])
                self.assertEqual(persisted["resume_runninghub_task_id"], "rh-existing-1")

    def test_completed_provider_checkpoint_resumes_from_segments_without_polling_old_task(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            db_path = Path(tmpdir) / "app.db"
            with mock.patch.dict(os.environ, {"APP_DB_PATH": str(db_path)}):
                db_module.init_db()
                now = server._now_ts()
                with db_module.db() as conn:
                    user_id = int(conn.execute(
                        "INSERT INTO users(username, password_hash, created_at, updated_at) VALUES ('video-segment-user', 'unused', ?, ?)",
                        (now, now),
                    ).lastrowid)
                    conn.execute(
                        """
                        INSERT INTO tasks(
                          id, user_id, type, status, input_json, output_json, error,
                          runninghub_task_id, usage_json, created_at, updated_at
                        ) VALUES (?, ?, 'ecommerce_short_video', 'running', ?, ?, '', '', '{}', ?, ?)
                        """,
                        (
                            "video-segment-resume",
                            user_id,
                            json.dumps({"source": "video_workbench_api"}),
                            json.dumps({"video_checkpoint": {
                                "recoverable": True,
                                "stage": "provider_success",
                                "runninghub_task_id": "rh-completed-segment",
                                "completed_segments": [{"index": 1, "path": "C:/outputs/segment-1.mp4"}],
                            }}),
                            now,
                            now,
                        ),
                    )

                with mock.patch.object(server._TASK_QUEUE, "put") as queue_put:
                    server._resume_pending_tasks()

                payload = queue_put.call_args.args[0][3]
                self.assertNotIn("resume_runninghub_task_id", payload)
                self.assertEqual(payload["completed_segments"][0]["index"], 1)
                self.assertEqual(payload["resume_checkpoint"]["stage"], "provider_success")

    def test_failed_worker_preserves_completed_video_segment_checkpoint(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            db_path = Path(tmpdir) / "app.db"
            with mock.patch.dict(os.environ, {"APP_DB_PATH": str(db_path)}):
                db_module.init_db()
                now = server._now_ts()
                checkpoint = {
                    "recoverable": True,
                    "runninghub_task_id": "rh-segment-1",
                    "completed_segments": [{"index": 1, "path": "C:/outputs/segment-1.mp4"}],
                }
                with db_module.db() as conn:
                    user_id = int(conn.execute(
                        "INSERT INTO users(username, password_hash, created_at, updated_at) VALUES ('video-failure-user', 'unused', ?, ?)",
                        (now, now),
                    ).lastrowid)
                    conn.execute(
                        """
                        INSERT INTO tasks(
                          id, user_id, type, status, input_json, output_json, error,
                          runninghub_task_id, usage_json, created_at, updated_at
                        ) VALUES (?, ?, 'create_video', 'queued', '{}', ?, '', '', '{}', ?, ?)
                        """,
                        ("video-failed-1", user_id, json.dumps({"video_checkpoint": checkpoint}), now, now),
                    )

                def fail_runner(_task_id, _payload):
                    raise RuntimeError("segment 2 failed")

                with mock.patch.dict(server.TASK_RUNNERS, {"create_video": fail_runner}):
                    server._task_worker_with_control(
                        "video-failed-1",
                        user_id,
                        "create_video",
                        {},
                        threading.Event(),
                    )

                with db_module.db() as conn:
                    row = conn.execute(
                        "SELECT status, output_json FROM tasks WHERE id = ?",
                        ("video-failed-1",),
                    ).fetchone()
                self.assertEqual(str(row["status"]), "failed")
                output = json.loads(row["output_json"])
                self.assertEqual(output["video_checkpoint"]["runninghub_task_id"], "rh-segment-1")
                self.assertEqual(output["completed_segments"][0]["index"], 1)


if __name__ == "__main__":
    unittest.main()
