import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from webapp import db as db_module
import webapp.server as server
from webapp.auth import hash_password


class AdminLogTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._tmpdir = tempfile.TemporaryDirectory()
        os.environ["APP_DB_PATH"] = os.path.join(self._tmpdir.name, "app.db")
        self.runtime_config_path = os.path.join(self._tmpdir.name, "runtime_config.json")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = self.runtime_config_path
        server.RUNTIME_CONFIG_PATH = Path(self.runtime_config_path)
        db_module.init_db()
        now = int(time.time())
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO users(id, username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, 0, ?, ?)
                """,
                (1, "admin", hash_password("admin123"), 1, now, now),
            )
            conn.execute(
                """
                INSERT INTO users(id, username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, 0, ?, ?)
                """,
                (2, "alice", hash_password("alice123"), 0, now, now),
            )
        with patch.object(server, "_resume_pending_tasks", return_value=None), \
             patch.object(server, "_start_task_workers", return_value=None), \
             patch.object(server, "_start_cleanup_worker", return_value=None):
            self.client = TestClient(server.create_app())

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        if self._old_runtime_config_path is None:
            os.environ.pop("APP_RUNTIME_CONFIG_PATH", None)
        else:
            os.environ["APP_RUNTIME_CONFIG_PATH"] = self._old_runtime_config_path
        self._tmpdir.cleanup()

    def test_insert_task_event_enriches_workflow_meta(self):
        server._create_task_record("task_1", 2, "replace_model", {"app_id": "rm_123"})
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET runninghub_task_id = ?, output_json = ? WHERE id = ?",
                ("rh_777", server._json_dumps({"runninghub_task_ids": ["rh_777"]}), "task_1"),
            )
            server._insert_task_event(
                conn,
                task_id="task_1",
                user_id=2,
                kind="log",
                message="测试日志",
                data={"error": "boom"},
            )
            row = conn.execute(
                "SELECT data_json FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1",
                ("task_1",),
            ).fetchone()
        payload = json.loads(str(row["data_json"]))
        self.assertEqual(payload["workflow_name"], "替换模特（原版工作流）")
        self.assertEqual(payload["workflow_id"], "rm_123")
        self.assertEqual(payload["runninghub_task_id"], "rh_777")
        self.assertEqual(payload["task_type"], "replace_model")
        self.assertEqual(payload["workflow_mode"], "original")
        self.assertEqual(payload["workflow_mode_label"], "原版工作流")
        self.assertEqual(payload["error"], "boom")

    def test_serialize_task_event_record_backfills_old_log_meta(self):
        server._create_task_record(
            "task_2",
            2,
            "replace_productANDmodel",
            {"model_app_id": "model_1", "product_app_id": "product_2"},
        )
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET runninghub_task_id = ? WHERE id = ?",
                ("rh_combo", "task_2"),
            )
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", ("task_2",)).fetchone()
        event_row = {
            "id": 99,
            "kind": "done",
            "message": "任务失败",
            "data_json": json.dumps({"error": "failed"}),
            "created_at": 123456,
        }
        payload = server._serialize_task_event_record(task=dict(row), event_row=event_row)
        self.assertEqual(payload["data"]["workflow_name"], "联合替换商品和模特")
        self.assertEqual(payload["data"]["workflow_ids"], ["model_1", "product_2"])
        self.assertEqual(payload["data"]["runninghub_task_id"], "rh_combo")
        self.assertEqual(payload["data"]["error"], "failed")

    def test_build_task_logs_export_lines_includes_task_summary(self):
        lines = server._build_task_logs_export_lines(
            task_detail={
                "id": "task_3",
                "user_id": 2,
                "type": "batch_create_video",
                "status": "failed",
                "workflow_name": "批量创建视频",
                "workflow_id": "1968024407312596994",
                "workflow_ids": ["1968024407312596994"],
                "runninghub_task_id": "rh_batch_1",
                "runninghub_task_ids": ["rh_batch_1", "rh_batch_2"],
                "created_at": 100,
                "updated_at": 200,
                "cost_cents": 88,
                "has_download": True,
                "total_count": 3,
                "success_count": 2,
                "failed_count": 1,
                "first_error": "bad item",
                "analysis_summary": "调用参数缺失",
            },
            username="alice",
            events=[
                {
                    "id": 1,
                    "kind": "log",
                    "message": "任务进行中",
                    "data": {"workflow_name": "批量创建视频"},
                    "created_at": 111,
                }
            ],
        )
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(payload["task"]["workflow_name"], "批量创建视频")
        self.assertEqual(payload["task"]["workflow_id"], "1968024407312596994")
        self.assertEqual(payload["task"]["runninghub_task_ids"], ["rh_batch_1", "rh_batch_2"])
        self.assertEqual(payload["task"]["username"], "alice")
        self.assertEqual(payload["task"]["cost_cents"], 88)
        self.assertEqual(payload["task"]["has_download"], True)
        self.assertEqual(payload["task"]["analysis_summary"], "调用参数缺失")

    def test_extract_batch_summary_ignores_success_message_as_error(self):
        summary = server._extract_batch_summary(
            {
                "ok": True,
                "message": "批量替换完成",
                "success": 2,
                "total": 2,
                "items": [
                    {"id": "1", "ok": True, "video_path": "/tmp/1.mp4"},
                    {"id": "2", "ok": True, "video_path": "/tmp/2.mp4"},
                ],
            }
        )
        self.assertEqual(summary["first_error"], "")
        self.assertEqual(summary["success_count"], 2)
        self.assertEqual(summary["failed_count"], 0)

    def test_enqueue_task_persists_effective_workflow_id(self):
        server._write_runtime_config_file(
            {
                "replace_model_app_id": "1977000000000000001",
                "replace_product_app_id": "1977000000000000002",
            }
        )

        with patch.object(server._TASK_QUEUE, "put", return_value=None):
            server._enqueue_task("task_4", 2, "replace_model", {"prompt": "hi"})

        with db_module.db() as conn:
            task_row = conn.execute("SELECT input_json FROM tasks WHERE id = ?", ("task_4",)).fetchone()
            event_row = conn.execute(
                "SELECT data_json FROM task_events WHERE task_id = ? ORDER BY id ASC LIMIT 1",
                ("task_4",),
            ).fetchone()

        task_payload = json.loads(str(task_row["input_json"]))
        event_payload = json.loads(str(event_row["data_json"]))
        self.assertEqual(task_payload["app_id"], "1977000000000000001")
        self.assertEqual(task_payload["workflow_id"], "1977000000000000001")
        self.assertEqual(task_payload["workflow_ids"], ["1977000000000000001"])
        self.assertEqual(event_payload["workflow_id"], "1977000000000000001")
        self.assertEqual(event_payload["workflow_ids"], ["1977000000000000001"])

    @patch("webapp.server.get_gemini.request_gemini3_pro", return_value="请求失败: upstream 401")
    def test_task_worker_marks_gemini_failure_when_result_is_error_string(self, _mock_gemini):
        server._create_task_record(
            "task_gemini_fail",
            2,
            "get_gemini",
            {"gemini_api_key": "g-secret", "gemini_host": "202.90.21.53", "user_input": "hi"},
        )

        server._task_worker(
            "task_gemini_fail",
            2,
            "get_gemini",
            {"gemini_api_key": "g-secret", "gemini_host": "202.90.21.53", "user_input": "hi"},
        )

        with db_module.db() as conn:
            task_row = conn.execute("SELECT status, error FROM tasks WHERE id = ?", ("task_gemini_fail",)).fetchone()
            done_row = conn.execute(
                "SELECT message, data_json FROM task_events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
                ("task_gemini_fail", "done"),
            ).fetchone()
        self.assertEqual(task_row["status"], "failed")
        self.assertIn("请求失败: upstream 401", str(task_row["error"]))
        self.assertEqual(done_row["message"], "任务失败")
        self.assertIn("请求失败: upstream 401", str(done_row["data_json"]))

    def test_task_detail_includes_logs_and_batch_summary(self):
        output_file = Path(self._tmpdir.name) / "out.mp4"
        output_file.write_bytes(b"demo")
        now = int(time.time())
        server._create_task_record(
            "task_detail_logs",
            2,
            "batch_create_video",
            {"video_app_id": "app_123", "gemini_api_key": "secret-key"},
        )
        with db_module.db() as conn:
            conn.execute(
                """
                UPDATE tasks
                SET status = ?, output_json = ?, error = ?, runninghub_task_id = ?, usage_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    "failed",
                    server._json_dumps(
                        {
                            "download_path": str(output_file),
                            "items": [
                                {"id": "a1", "status": "success"},
                                {"id": "a2", "status": "failed", "error": "上传失败"},
                            ],
                        }
                    ),
                    "批量失败",
                    "rh_detail",
                    server._json_dumps({"runninghub": {"consumeCoins": 3}}),
                    now,
                    "task_detail_logs",
                ),
            )
            server._insert_task_event(
                conn,
                task_id="task_detail_logs",
                user_id=2,
                kind="progress",
                message="上传中",
                data={"item_index": 2, "error": "上传失败", "gemini_api_key": "secret-key"},
            )

        login_resp = self.client.post("/api/auth/login", json={"username": "alice", "password": "alice123"})
        self.assertEqual(login_resp.status_code, 200)
        detail_resp = self.client.get("/api/tasks/task_detail_logs")
        self.assertEqual(detail_resp.status_code, 200)
        payload = detail_resp.json()
        self.assertEqual(payload["has_download"], True)
        self.assertEqual(payload["total_count"], 2)
        self.assertEqual(payload["failed_count"], 1)
        self.assertEqual(payload["first_error"], "上传失败")
        self.assertGreaterEqual(len(payload["logs"]), 2)
        self.assertEqual(payload["logs"][-1]["data"]["item_index"], 2)
        self.assertEqual(payload["logs"][-1]["data"]["gemini_api_key"], "secr***-key")

    def test_task_worker_writes_final_output_snapshot_event(self):
        output_file = Path(self._tmpdir.name) / "final.mp4"
        output_file.write_bytes(b"video")
        server._create_task_record("task_final_output", 2, "replace_model", {"app_id": "rm_123"})
        with patch.dict(server.TASK_RUNNERS, {"replace_model": lambda _tid, _payload: {"ok": True, "download_path": str(output_file), "runninghub_task_id": "rh_999"}}):
            server._task_worker("task_final_output", 2, "replace_model", {"app_id": "rm_123"})
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT kind, message, data_json FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1",
                ("task_final_output",),
            ).fetchone()
        self.assertEqual(row["message"], "最终输出快照")
        payload = json.loads(str(row["data_json"]))
        self.assertEqual(payload["stage"], "final_output")
        self.assertEqual(payload["output_snapshot"]["has_download"], True)
        self.assertEqual(payload["output_snapshot"]["runninghub_task_id"], "rh_999")

    def test_emit_batch_item_output_event_records_item_snapshot(self):
        server._create_task_record("task_batch_item", 2, "batch_replace_product", {"product_app_id": "p_1"})
        with db_module.db() as conn:
            server._emit_batch_item_output_event(
                {"_task_id": "task_batch_item", "_user_id": 2},
                item_index=3,
                item_id="item-3",
                result={"id": "item-3", "ok": False, "error": "上游失败", "runninghub_task_id": "rh_item_3"},
            )
            row = conn.execute(
                "SELECT kind, message, data_json FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1",
                ("task_batch_item",),
            ).fetchone()
        self.assertEqual(row["kind"], "log")
        self.assertEqual(row["message"], "批量子项输出")
        payload = json.loads(str(row["data_json"]))
        self.assertEqual(payload["stage"], "batch_item_output")
        self.assertEqual(payload["item_index"], 3)
        self.assertEqual(payload["output_snapshot"]["runninghub_task_id"], "rh_item_3")
        self.assertEqual(payload["output_snapshot"]["error"], "上游失败")

    @patch(
        "webapp.server.get_gemini.request_gemini3_pro_json",
        return_value={
            "ok": True,
            "parsed": {
                "summary": "RunningHub 上传阶段失败",
                "root_causes": ["上游任务返回 401", "配置的 workflow_id 不可用"],
                "suggestions": ["检查 RunningHub Key", "确认工作流是否启用"],
                "confidence": 0.81,
                "notable_events": [2],
            },
        },
    )
    def test_analyze_error_endpoint_persists_analysis_event(self, _mock_gemini):
        server._write_runtime_config_file({"gemini_api_key": "g-key-001", "gemini_host": "202.90.21.53"})
        server._create_task_record("task_analysis", 2, "replace_model", {"app_id": "rm_123"})
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                ("failed", "上游报错", int(time.time()), "task_analysis"),
            )
            server._insert_task_event(
                conn,
                task_id="task_analysis",
                user_id=2,
                kind="done",
                message="任务失败",
                data={"error": "上游报错", "status": "failed"},
            )

        login_resp = self.client.post("/api/auth/login", json={"username": "alice", "password": "alice123"})
        self.assertEqual(login_resp.status_code, 200)
        analyze_resp = self.client.post("/api/tasks/task_analysis/analyze_error")
        self.assertEqual(analyze_resp.status_code, 200)
        body = analyze_resp.json()
        self.assertEqual(body["analysis"]["summary"], "RunningHub 上传阶段失败")
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT kind, message, data_json FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1",
                ("task_analysis",),
            ).fetchone()
        self.assertEqual(row["kind"], "analysis")
        payload = json.loads(str(row["data_json"]))
        self.assertEqual(payload["source"], "gemini")
        self.assertEqual(payload["analysis_type"], "gemini_error_analysis")
        self.assertEqual(payload["summary"], "RunningHub 上传阶段失败")


if __name__ == "__main__":
    unittest.main()
