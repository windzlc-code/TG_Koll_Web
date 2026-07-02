import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from webapp import db as db_module
import webapp.server as server


class RuntimeConfigStoreTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "app.db")
        self.runtime_config_path = Path(self._tmpdir.name) / "runtime_config.json"
        os.environ["APP_DB_PATH"] = self.db_path
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.runtime_config_path)
        server.RUNTIME_CONFIG_PATH = self.runtime_config_path
        db_module.init_db()
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO users(id, username, password_hash, is_admin, balance_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (1, "admin", "test-hash", 1, 0, server._now_ts(), server._now_ts()),
            )
        self.admin_user = {"id": 1, "username": "admin", "is_admin": 1}

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

    def _route_endpoint(self, path: str, method: str):
        for route in server.app.router.routes:
            if getattr(route, "path", None) != path:
                continue
            methods = {m.upper() for m in getattr(route, "methods", set())}
            if method.upper() in methods:
                return route.endpoint
        raise AssertionError(f"route not found: {method} {path}")

    def test_initialize_runtime_config_file_migrates_legacy_db_value(self):
        with db_module.db() as conn:
            db_module.set_admin_config(
                conn,
                "runtime_config",
                {
                    "replace_model_app_id": "legacy_app_123",
                    "nano_host": "example.internal",
                },
                server._now_ts(),
            )

        server._ensure_default_runtime_config()

        stored = json.loads(self.runtime_config_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["replace_model_app_id"], "legacy_app_123")
        self.assertEqual(stored["nano_host"], "example.internal")
        self.assertEqual(stored["cleanup_enabled"], True)
        self.assertEqual(stored["runninghub_api_key"], "")

    def test_initialize_runtime_config_file_recovers_broken_file(self):
        self.runtime_config_path.write_text("{broken json", encoding="utf-8")
        with db_module.db() as conn:
            db_module.set_admin_config(
                conn,
                "runtime_config",
                {"replace_model_app_id": "restored_from_db"},
                server._now_ts(),
            )

        server._ensure_default_runtime_config()

        stored = json.loads(self.runtime_config_path.read_text(encoding="utf-8"))
        backups = list(self.runtime_config_path.parent.glob("runtime_config.broken-*.json"))
        self.assertEqual(stored["replace_model_app_id"], "restored_from_db")
        self.assertTrue(backups)

    def test_get_runtime_config_raises_on_broken_file(self):
        self.runtime_config_path.write_text("{broken json", encoding="utf-8")

        with db_module.db() as conn:
            with self.assertRaises(server.RuntimeConfigFileError):
                server._get_runtime_config(conn)

    def test_get_runtime_config_fills_missing_fields_without_overwriting_explicit_values(self):
        self.runtime_config_path.write_text(
            json.dumps(
                {
                    "replace_model_app_id": "custom_app_456",
                    "cleanup_enabled": False,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with db_module.db() as conn:
            runtime = server._get_runtime_config(conn)

        stored = json.loads(self.runtime_config_path.read_text(encoding="utf-8"))
        self.assertEqual(runtime["replace_model_app_id"], "custom_app_456")
        self.assertEqual(stored["replace_model_app_id"], "custom_app_456")
        self.assertEqual(runtime["cleanup_enabled"], False)
        self.assertEqual(stored["cleanup_enabled"], False)
        self.assertIn("runninghub_api_key", runtime)
        self.assertEqual(stored["runninghub_api_key"], "")

    def test_runtime_config_api_save_and_refresh_keeps_local_file_value(self):
        put_runtime_config = self._route_endpoint("/api/admin/runtime_config", "PUT")
        get_runtime_config = self._route_endpoint("/api/admin/runtime_config", "GET")
        with db_module.db() as conn:
            db_module.set_admin_config(
                conn,
                "runtime_config",
                {"replace_model_app_id": "legacy_db_app"},
                server._now_ts(),
            )

        payload = server.RuntimeConfigPayload(
            replace_model_app_id="custom_runtime_app",
            replace_model_original_app_id="custom_runtime_app",
            replace_model_primary_app_id="2047889041936355329",
            replace_model_slice_app_id="1955095782514987010",
            replace_model_motion_transfer_app_id="2047889041936355329",
            nano_host="runtime.example.internal",
            cleanup_enabled=False,
        )
        resp = put_runtime_config(payload, self.admin_user)
        self.assertEqual(resp["runtime_config"]["replace_model_app_id"], "custom_runtime_app")
        self.assertEqual(resp["runtime_config"]["nano_host"], "runtime.example.internal")
        self.assertEqual(resp["runtime_config"]["cleanup_enabled"], False)

        stored = json.loads(self.runtime_config_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["replace_model_app_id"], "custom_runtime_app")
        self.assertEqual(stored["replace_model_original_app_id"], "custom_runtime_app")
        self.assertEqual(stored["replace_model_primary_app_id"], "2047889041936355329")
        self.assertEqual(stored["nano_host"], "runtime.example.internal")
        self.assertEqual(stored["cleanup_enabled"], False)

        current = get_runtime_config(self.admin_user)
        self.assertEqual(current["replace_model_app_id"], "custom_runtime_app")
        self.assertEqual(current["replace_model_original_app_id"], "custom_runtime_app")
        self.assertEqual(current["nano_host"], "runtime.example.internal")
        self.assertEqual(current["cleanup_enabled"], False)

    def test_runtime_config_api_saves_comfy_gpu_queue_limit_and_switch(self):
        put_runtime_config = self._route_endpoint("/api/admin/runtime_config", "PUT")
        get_runtime_config = self._route_endpoint("/api/admin/runtime_config", "GET")

        resp = put_runtime_config(
            server.RuntimeConfigPayload(comfy_gpu_queue_enabled=True, comfy_gpu_max_concurrency=6),
            self.admin_user,
        )

        self.assertEqual(resp["runtime_config"]["comfy_gpu_queue_enabled"], True)
        self.assertEqual(resp["runtime_config"]["comfy_gpu_max_concurrency"], 4)
        stored = json.loads(self.runtime_config_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["comfy_gpu_queue_enabled"], True)
        self.assertEqual(stored["comfy_gpu_max_concurrency"], 4)
        current = get_runtime_config(self.admin_user)
        self.assertEqual(current["comfy_gpu_queue_enabled"], True)
        self.assertEqual(current["comfy_gpu_max_concurrency"], 4)

    def test_comfy_gpu_queue_is_disabled_by_default(self):
        server._write_runtime_config_file({})

        self.assertEqual(server._runtime_comfy_gpu_queue_enabled(), False)
        with server._comfy_gpu_execution_slot({"_task_id": "task_direct"}, workflow_path="wf.api.json") as slot:
            self.assertEqual(slot["queue_enabled"], False)
            self.assertEqual(slot["mode"], "direct")
        self.assertEqual(server._comfy_gpu_snapshot()["waiting"], 0)
        self.assertEqual(server._comfy_gpu_snapshot()["running"], 0)

    def test_runtime_config_api_preserves_comfy_when_saving_partial_config(self):
        put_runtime_config = self._route_endpoint("/api/admin/runtime_config", "PUT")
        server._write_runtime_config_file(
            {
                "image_generate_mode_default": "remote_comfy",
                "comfy_workflow_source": "remote",
                "remote_comfy_gateway_url": "http://comfy.local",
                "remote_comfy_gateway_token": "secret-token",
                "remote_comfy_workflow_mappings": {"text_to_image": "wf-text", "image_generate": "wf-image"},
            }
        )

        resp = put_runtime_config(server.RuntimeConfigPayload(llm_base_url="http://llm.local"), self.admin_user)

        self.assertEqual(resp["runtime_config"]["llm_base_url"], "http://llm.local")
        self.assertEqual(resp["runtime_config"]["image_generate_mode_default"], "remote_comfy")
        self.assertEqual(resp["runtime_config"]["comfy_workflow_source"], "remote")
        self.assertEqual(resp["runtime_config"]["remote_comfy_gateway_url"], "http://comfy.local")
        self.assertEqual(resp["runtime_config"]["remote_comfy_gateway_token"], "secret-token")
        self.assertEqual(resp["runtime_config"]["remote_comfy_workflow_mappings"]["text_to_image"], "wf-text")

    def test_runtime_config_bot_token_empty_save_preserves_existing_token(self):
        put_runtime_config = self._route_endpoint("/api/admin/runtime_config", "PUT")
        server._write_runtime_config_file({"telegram_bot_token": "old-token-123"})

        resp = put_runtime_config(server.RuntimeConfigPayload(telegram_bot_token="", llm_base_url="http://llm.local"), self.admin_user)

        self.assertEqual(resp["runtime_config"]["telegram_bot_token"], "old-token-123")
        self.assertEqual(resp["runtime_config"]["llm_base_url"], "http://llm.local")

    def test_runtime_config_bot_token_save_writes_local_bot_token_file(self):
        put_runtime_config = self._route_endpoint("/api/admin/runtime_config", "PUT")
        token_file = Path(self._tmpdir.name) / "bot-runtime" / "telegram_bot_token.txt"
        local_env = Path(self._tmpdir.name) / "bot-runtime" / "local-bot.env"
        old_token_file = os.environ.get("TOOL_R18_TELEGRAM_BOT_TOKEN_FILE")
        old_local_env = os.environ.get("TOOL_R18_LOCAL_BOT_ENV_PATH")
        os.environ["TOOL_R18_TELEGRAM_BOT_TOKEN_FILE"] = str(token_file)
        os.environ["TOOL_R18_LOCAL_BOT_ENV_PATH"] = str(local_env)
        try:
            resp = put_runtime_config(server.RuntimeConfigPayload(telegram_bot_token="new-token-456"), self.admin_user)
        finally:
            if old_token_file is None:
                os.environ.pop("TOOL_R18_TELEGRAM_BOT_TOKEN_FILE", None)
            else:
                os.environ["TOOL_R18_TELEGRAM_BOT_TOKEN_FILE"] = old_token_file
            if old_local_env is None:
                os.environ.pop("TOOL_R18_LOCAL_BOT_ENV_PATH", None)
            else:
                os.environ["TOOL_R18_LOCAL_BOT_ENV_PATH"] = old_local_env

        self.assertEqual(resp["runtime_config"]["telegram_bot_token"], "new-token-456")
        self.assertEqual(token_file.read_text(encoding="utf-8").strip(), "new-token-456")
        self.assertIn("TELEGRAM_BOT_TOKEN=new-token-456", local_env.read_text(encoding="utf-8"))

    def test_runtime_defaults_prefer_local_file_and_keep_explicit_app_id(self):
        with db_module.db() as conn:
            db_module.set_admin_config(
                conn,
                "runtime_config",
                {
                    "replace_model_app_id": "legacy_model_app",
                    "replace_product_app_id": "legacy_product_app",
                },
                server._now_ts(),
            )

        server._write_runtime_config_file(
            {
                "replace_model_app_id": "file_model_app",
                "replace_product_app_id": "file_product_app",
            }
        )

        replace_model_payload = server._apply_runtime_defaults("replace_model", {})
        replace_product_payload = server._apply_runtime_defaults("replace_product", {})
        combo_payload = server._apply_runtime_defaults("replace_productANDmodel", {})
        explicit_payload = server._apply_runtime_defaults("replace_model", {"app_id": "1234567890123456789"})

        self.assertEqual(replace_model_payload["app_id"], "file_model_app")
        self.assertEqual(replace_model_payload["workflow_id"], "file_model_app")
        self.assertEqual(replace_model_payload["workflow_ids"], ["file_model_app"])
        self.assertEqual(replace_product_payload["app_id"], "file_product_app")
        self.assertEqual(replace_product_payload["workflow_id"], "file_product_app")
        self.assertEqual(combo_payload["model_app_id"], "file_model_app")
        self.assertEqual(combo_payload["product_app_id"], "file_product_app")
        self.assertEqual(combo_payload["workflow_ids"], ["file_model_app", "file_product_app"])
        self.assertEqual(explicit_payload["app_id"], "1234567890123456789")
        self.assertEqual(explicit_payload["workflow_id"], "1234567890123456789")

    def test_runtime_defaults_fill_empty_comfy_mappings_from_runtime(self):
        server._write_runtime_config_file(
            {
                "comfy_workflow_source": "remote",
                "remote_comfy_gateway_url": "http://comfy.local",
                "remote_comfy_workflow_mappings": {"text_to_image": "wf-text"},
            }
        )

        payload = server._apply_runtime_defaults("text_to_image", {"remote_comfy_workflow_mappings": {}})

        self.assertEqual(payload["remote_comfy_gateway_url"], "http://comfy.local")
        self.assertEqual(payload["remote_comfy_workflow_mappings"], {"text_to_image": "wf-text"})

    def test_runtime_defaults_replace_invalid_replace_workflow_ids(self):
        server._write_runtime_config_file(
            {
                "replace_model_app_id": "1977634608437174274",
                "replace_product_app_id": "1977410328592031746",
            }
        )

        replace_model_payload = server._apply_runtime_defaults("replace_model", {"app_id": "runtime_rm_app"})
        replace_product_payload = server._apply_runtime_defaults("replace_product", {"app_id": "runtime_rp_app"})
        combo_payload = server._apply_runtime_defaults(
            "replace_productANDmodel",
            {"model_app_id": "runtime_rm_app", "product_app_id": "runtime_rp_app"},
        )

        self.assertEqual(replace_model_payload["app_id"], "1977634608437174274")
        self.assertEqual(replace_model_payload["workflow_id"], "1977634608437174274")
        self.assertEqual(replace_product_payload["app_id"], "1977410328592031746")
        self.assertEqual(replace_product_payload["workflow_id"], "1977410328592031746")
        self.assertEqual(combo_payload["model_app_id"], "1977634608437174274")
        self.assertEqual(combo_payload["product_app_id"], "1977410328592031746")
        self.assertEqual(combo_payload["workflow_ids"], ["1977634608437174274", "1977410328592031746"])

    def test_runtime_defaults_pick_mode_specific_replace_model_app_id(self):
        server._write_runtime_config_file(
            {
                "replace_model_original_app_id": "1977634608437174274",
                "replace_model_primary_app_id": "2047889041936355329",
                "replace_model_slice_app_id": "1955095782514987010",
                "replace_model_motion_transfer_app_id": "2047889041936355999",
            }
        )

        original_payload = server._apply_runtime_defaults("replace_model", {"mode": "original"})
        primary_payload = server._apply_runtime_defaults("replace_model", {"mode": "primary"})
        slice_payload = server._apply_runtime_defaults("replace_model", {"mode": "slice"})
        motion_payload = server._apply_runtime_defaults("replace_model", {"mode": "motion_transfer"})

        self.assertEqual(original_payload["app_id"], "1977634608437174274")
        self.assertEqual(original_payload["workflow_name"], "替换模特（原版工作流）")
        self.assertEqual(primary_payload["app_id"], "2047889041936355329")
        self.assertEqual(primary_payload["workflow_name"], "替换模特（主要工作流）")
        self.assertEqual(slice_payload["app_id"], "1955095782514987010")
        self.assertEqual(slice_payload["workflow_name"], "替换模特（切片工作流）")
        self.assertEqual(motion_payload["app_id"], "2047889041936355999")
        self.assertEqual(motion_payload["workflow_name"], "替换模特（动作迁移工作流）")

    def test_runtime_config_api_returns_error_when_file_is_broken(self):
        get_runtime_config = self._route_endpoint("/api/admin/runtime_config", "GET")
        put_runtime_config = self._route_endpoint("/api/admin/runtime_config", "PUT")
        self.runtime_config_path.write_text("{broken json", encoding="utf-8")

        with self.assertRaises(server.HTTPException) as get_ctx:
            get_runtime_config(self.admin_user)

        save_resp = put_runtime_config(
            server.RuntimeConfigPayload(replace_model_app_id="should_not_save"),
            self.admin_user,
        )

        self.assertEqual(get_ctx.exception.status_code, 500)
        self.assertIn("运行配置文件", str(get_ctx.exception.detail))
        self.assertTrue(self.runtime_config_path.exists())
        self.assertEqual(save_resp["runtime_config"]["replace_model_app_id"], server.DEFAULT_RUNTIME_CONFIG["replace_model_original_app_id"])

    def test_create_task_record_keeps_raw_secrets_for_retry(self):
        payload = {
            "nano_api_key": "sk-raw-nano-secret",
            "gemini_api_key": "sk-raw-gemini-secret",
            "runninghub_api_key": "rh-raw-secret",
            "nano_host": "example.internal",
            "gemini_host": "example.internal",
        }
        server._create_task_record("task_raw_secret", 1, "commerce_video", payload)

        with db_module.db() as conn:
            row = conn.execute("SELECT input_json FROM tasks WHERE id = ?", ("task_raw_secret",)).fetchone()
        stored = json.loads(row["input_json"])
        self.assertEqual(stored["nano_api_key"], "sk-raw-nano-secret")
        self.assertEqual(stored["gemini_api_key"], "sk-raw-gemini-secret")
        self.assertEqual(stored["runninghub_api_key"], "rh-raw-secret")

    def test_runninghub_image_generate_waits_until_query_reaches_success(self):
        calls = [
            {"status": "RUNNING", "progress": None, "raw": {"taskId": "rh_task_1", "status": "RUNNING"}},
            {"status": "RUNNING", "progress": None, "raw": {"taskId": "rh_task_1", "status": "RUNNING"}},
            {
                "status": "success",
                "results": [{"url": "https://example.com/out.png"}],
                "usage": {"consumeCoins": "91"},
                "raw": {"taskId": "rh_task_1", "status": "SUCCESS", "results": [{"url": "https://example.com/out.png"}]},
            },
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            src = Path(tmpdir) / "input.png"
            src.write_bytes(b"fake")
            out = Path(tmpdir) / "out.png"
            with patch.object(server, "_upload_binary_to_runninghub", return_value="https://example.com/in.png"), \
                 patch.object(server.requests, "post") as mock_post, \
                 patch.object(server.runninghub_common, "query_task", side_effect=calls), \
                 patch.object(server, "_download_to_file", side_effect=lambda url, path: Path(path).write_bytes(b"png")), \
                 patch.object(server, "_build_task_workdir", return_value=Path(tmpdir)), \
                 patch.object(server.time, "sleep", return_value=None):
                response = type("Resp", (), {"raise_for_status": lambda self: None, "json": lambda self: {"taskId": "rh_task_1", "status": "RUNNING"}})()
                mock_post.return_value = response
                result = server._run_image_generate_via_runninghub_workflow(
                    "task_demo",
                    {
                        "runninghub_api_key": "rh-key",
                        "image_runninghub_workflow_id": "1900814586436534274",
                        "product_name": "耳环",
                        "style_hint": "白底",
                    },
                    ref_input=src,
                    prompt_text="生成图片",
                    mode="product_only",
                )
        self.assertEqual(result["runninghub_task_id"], "rh_task_1")
        self.assertTrue(str(result["image_path"]).endswith("image_generate_output.png"))
        self.assertEqual(mock_post.call_count, 1)

    def test_runninghub_image_generate_surfaces_audit_failure_clearly(self):
        calls = [
            {
                "status": "failed",
                "errorCode": "805",
                "errorMessage": "工作流运行失败",
                "raw": {
                    "taskId": "rh_task_2",
                    "status": "FAILED",
                    "errorCode": "805",
                    "errorMessage": "工作流运行失败",
                    "failedReason": {
                        "exception_type": "audit.RHAuditException",
                        "msg": "Porn",
                        "node_name": "PreviewBridge",
                    },
                },
            },
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            src = Path(tmpdir) / "input.png"
            src.write_bytes(b"fake")
            with patch.object(server, "_upload_binary_to_runninghub", return_value="https://example.com/in.png"), \
                 patch.object(server.requests, "post") as mock_post, \
                 patch.object(server.runninghub_common, "query_task", side_effect=calls), \
                 patch.object(server, "_build_task_workdir", return_value=Path(tmpdir)), \
                 patch.object(server.time, "sleep", return_value=None):
                response = type("Resp", (), {"raise_for_status": lambda self: None, "json": lambda self: {"taskId": "rh_task_2", "status": "RUNNING"}})()
                mock_post.return_value = response
                with self.assertRaises(RuntimeError) as ctx:
                    server._run_image_generate_via_runninghub_workflow(
                        "task_demo",
                        {
                            "runninghub_api_key": "rh-key",
                            "image_runninghub_workflow_id": "1900814586436534274",
                            "product_name": "耳环",
                            "style_hint": "白底",
                        },
                        ref_input=src,
                        prompt_text="生成图片",
                        mode="product_only",
                    )
        self.assertIn("图片疑似触发平台审核", str(ctx.exception))
        self.assertIn("PreviewBridge", str(ctx.exception))
        self.assertIn("Porn", str(ctx.exception))


    def test_apply_runtime_defaults_restores_masked_task_secrets(self):
        server._write_runtime_config_file(
            {
                "runninghub_api_key": "rh-live-secret",
                "nano_api_key": "sk-live-nano-secret",
                "nano_host": "202.90.21.53",
                "nano_port": "3008",
                "gemini_api_key": "sk-live-gemini-secret",
                "gemini_host": "202.90.21.53",
                "gemini_port": "3008",
            }
        )

        restored = server._apply_runtime_defaults(
            "commerce_video",
            {
                "runninghub_api_key": "rh-l***cret",
                "nano_api_key": "sk-A***DJwt",
                "gemini_api_key": "sk-A***DJwt",
                "nano_host": "202.90.21.53",
                "nano_port": "3008",
                "gemini_host": "202.90.21.53",
                "gemini_port": "3008",
            },
        )

        self.assertEqual(restored["runninghub_api_key"], "rh-live-secret")
        self.assertEqual(restored["nano_api_key"], "sk-live-nano-secret")
        self.assertEqual(restored["gemini_api_key"], "sk-live-gemini-secret")

    def test_task_detail_masks_stored_secrets(self):
        get_task_detail = self._route_endpoint("/api/tasks/{task_id}", "GET")
        server._write_runtime_config_file({"llm_api_key": "sk-live-llm-secret", "llm_base_url": "http://example.internal:3008"})
        payload = {
            "nano_api_key": "sk-raw-nano-secret",
            "gemini_api_key": "sk-raw-gemini-secret",
            "runninghub_api_key": "rh-raw-secret",
            "nano_host": "example.internal",
            "gemini_host": "example.internal",
            "llm_api_key": "sk-raw-llm-secret",
            "llm_base_url": "http://example.internal:3008",
        }
        server._create_task_record("task_detail_secret", 1, "commerce_video", payload)

        detail = get_task_detail("task_detail_secret", self.admin_user)
        self.assertEqual(detail["input"]["nano_api_key"], "sk-r***cret")
        self.assertEqual(detail["input"]["gemini_api_key"], "sk-r***cret")
        self.assertEqual(detail["input"]["runninghub_api_key"], "rh-r***cret")
        self.assertEqual(detail["error_analysis_available"], True)

    def test_task_detail_reports_error_analysis_capability(self):
        get_task_detail = self._route_endpoint("/api/tasks/{task_id}", "GET")
        server._write_runtime_config_file({"gemini_api_key": "g-key-001", "gemini_host": "202.90.21.53"})
        server._create_task_record("task_detail_analysis_flag", 1, "commerce_video", {})

        detail = get_task_detail("task_detail_analysis_flag", self.admin_user)

        self.assertEqual(detail["error_analysis_available"], True)

    def test_image_generate_task_detail_keeps_comfy_runtime_fields(self):
        get_task_detail = self._route_endpoint("/api/tasks/{task_id}", "GET")
        server._write_runtime_config_file(
            {
                "image_generate_mode_default": "remote_comfy",
                "comfy_workflow_source": "remote",
                "remote_comfy_gateway_url": "http://comfy.local",
                "remote_comfy_workflow_mappings": {"image_generate": "wf-image"},
                "llm_base_url": "http://202.90.21.53:3008",
                "llm_api_key": "sk-gemini-llm",
                "llm_default_model": "gemini-3.1-pro-preview",
            }
        )
        payload = server._apply_runtime_defaults(
            "image_generate",
            {
                "image_generate_provider": "remote_comfy",
                "prompt": "生成图片",
            },
        )
        server._create_task_record("task_image_detail_clean", 1, "image_generate", payload)

        detail = get_task_detail("task_image_detail_clean", self.admin_user)

        self.assertEqual(detail["workflow_id"], "wf-image")
        self.assertEqual(detail["workflow_ids"], ["wf-image"])
        self.assertEqual(detail["input"]["image_generate_mode_default"], "remote_comfy")
        self.assertEqual(detail["input"]["remote_comfy_gateway_url"], "http://comfy.local")
        self.assertEqual(detail["input"]["remote_comfy_workflow_mappings"], {"image_generate": "wf-image"})
        self.assertEqual(detail["input"]["llm_base_url"], "http://202.90.21.53:3008")
        self.assertEqual(detail["input"]["llm_api_key"], "sk-g***-llm")
        self.assertEqual(detail["input"]["llm_default_model"], "gemini-3.1-pro-preview")
        self.assertEqual(detail["input"]["image_generate_provider"], "remote_comfy")
        self.assertNotIn("image_model_provider_base_url", detail["input"])
    def test_runtime_config_supports_comfy_image_generation_and_llm_fields(self):
        payload = server.RuntimeConfigPayload(
            image_generate_mode_default="remote_comfy",
            comfy_workflow_source="remote",
            remote_comfy_gateway_url="http://comfy.local",
            remote_comfy_workflow_mappings={"image_generate": "wf-image"},
            llm_base_url="http://202.90.21.53:3008",
            llm_api_key="sk-gemini-llm",
            llm_default_model="gemini-3.1-pro-preview",
        )
        self.assertEqual(payload.image_generate_mode_default, "remote_comfy")
        self.assertEqual(payload.comfy_workflow_source, "remote")
        self.assertEqual(payload.remote_comfy_gateway_url, "http://comfy.local")
        self.assertEqual(payload.remote_comfy_workflow_mappings, {"image_generate": "wf-image"})
        self.assertEqual(payload.llm_base_url, "http://202.90.21.53:3008")
        self.assertEqual(payload.llm_api_key, "sk-gemini-llm")
        self.assertEqual(payload.llm_default_model, "gemini-3.1-pro-preview")

    def test_chinese_image_prompt_format_keeps_punctuation_and_8k(self):
        prompt = (
            "一位女子全身躺在床上穿着丝质睡袍她的左手轻轻抚摸胸前而右手放在大腿内侧"
            "她的身体平躺微微拱起朝向镜头她的头转向直视镜头带着诱惑眼神"
            "豪华卧室背景柔和大床和枕头柔和的暖光从侧面照射浅景深真实皮肤纹理细节布料褶皱自然身体比例高细节8写实摄影风格"
        )

        normalized = server._normalize_tg_chinese_image_prompt_format(prompt)

        self.assertIn("床上，穿着", normalized)
        self.assertIn("，她的左手", normalized)
        self.assertIn("，她的身体", normalized)
        self.assertIn("，她的头", normalized)
        self.assertIn("浅景深，真实皮肤纹理", normalized)
        self.assertNotIn("真实，皮肤，纹理", normalized)
        self.assertIn("高细节，8K，写实摄影风格", normalized)

    def test_chinese_image_prompt_format_does_not_split_location_phrase(self):
        prompt = "一位美少女全身站立在现代卧室中穿着白色衬衫她的左手扶着椅背而右手自然下垂"

        normalized = server._normalize_tg_chinese_image_prompt_format(prompt)

        self.assertIn("现代卧室中", normalized)
        self.assertNotIn("现代，卧室中", normalized)

    def test_non_r18_generated_post_image_prompt_rules_do_not_force_exposure(self):
        system_prompt, prompt_chain = server._build_tg_prompt_system_prompt(
            "text_to_image",
            "text-to-image",
            non_r18_free=True,
        )

        self.assertEqual("image", prompt_chain)
        self.assertIn("NON-R18 FREE-GROUP IMAGE RULE", system_prompt)
        self.assertNotIn("露出丰满坚挺的乳房和清晰可见的乳头", system_prompt)
        self.assertNotIn("Upper-body exposure is mandatory", system_prompt)

    def test_non_r18_generated_post_image_validation_allows_safe_prompt(self):
        prompt = (
            "一位身形纤细修长且腰胯比例轻盈自然的女性坐在床边，"
            "穿着米白色细肩带吊带背心和深灰色短裙，"
            "服装贴合场景并保持完整自然，"
            "她的左手扶在床沿而右手轻放在膝侧，"
            "她的身体微微前倾面向镜头，"
            "她的头自然转向镜头，目光看向镜头，眼神柔和且表情嘴角上扬，"
            "背景是简洁卧室环境，床铺和窗帘保持清楚，"
            "柔和自然光从侧面照射，浅景深突出主体，"
            "真实皮肤纹理与布料褶皱自然，高清写实摄影"
        )

        server._validate_tg_image_structured_prompt(prompt, require_erotic=False)
        with self.assertRaises(RuntimeError):
            server._validate_tg_image_structured_prompt(prompt)

    def test_non_r18_generated_post_image_canonicalizer_keeps_clothing_safe(self):
        prompt = (
            "一位女性坐在床边，穿着米白色细肩带吊带背心和深灰色短裙，"
            "她的左手扶在床沿而右手轻放在膝侧，"
            "她的身体微微前倾面向镜头，"
            "她的头自然转向镜头，目光看向镜头，眼神柔和且表情嘴角上扬，"
            "背景是简洁卧室环境，柔和自然光从侧面照射，浅景深突出主体，"
            "真实皮肤纹理与布料褶皱自然，高清写实摄影"
        )

        final_prompt = server._canonicalize_tg_image_nine_segment_prompt(
            prompt,
            {"tg_no_r18_exposure": True, "source": "telegram-generated-post-image-candidates"},
            "为免费群推文生成配图",
        )

        self.assertIn("服装贴合场景并保持完整自然", final_prompt)
        self.assertNotIn("乳房", final_prompt)
        self.assertNotIn("乳头", final_prompt)
        server._validate_tg_image_structured_prompt(final_prompt, require_erotic=False)

    def test_tg_image_clothing_anchor_adds_missing_color_and_structure(self):
        prompt = (
            "一位成人女性全身站立在现代卧室中，穿着时尚服装，"
            "她的左手扶着椅背而右手自然下垂，她的身体朝向镜头，她的头转向镜头"
        )

        anchored = server._ensure_tg_image_clothing_anchor(
            prompt,
            "生成室内人物图",
            {"text_to_image_workflow_profile": "person_t2i"},
        )

        self.assertIn("米白色", anchored)
        self.assertIn("深灰色", anchored)
        self.assertIn("簡潔上衣", anchored)
        self.assertIn("直筒下裝", anchored)
        self.assertIn("領口", anchored)
        self.assertIn("袖口", anchored)
        self.assertIn("腰線", anchored)

    def test_tg_image_clothing_anchor_keeps_existing_color_and_structure(self):
        prompt = (
            "一位成人女性全身站立在现代卧室中，穿着红色连衣裙，领口和裙摆边界清楚，"
            "她的左手扶着椅背而右手自然下垂，她的身体朝向镜头，她的头转向镜头"
        )

        anchored = server._ensure_tg_image_clothing_anchor(
            prompt,
            "生成室内人物图",
            {"text_to_image_workflow_profile": "person_t2i"},
        )

        self.assertIn("红色连衣裙", anchored)
        self.assertNotIn("米白色", anchored)
        self.assertNotIn("直筒下裝", anchored)

    def test_tg_image_clothing_anchor_treats_bathrobe_as_structure(self):
        prompt = (
            "一位成人女性坐在宽敞浴室的浴缸边缘，穿着半透明白色浴袍低开领，"
            "她的左手扶着浴缸而右手自然下垂，她的身体朝向镜头，她的头转向镜头"
        )

        anchored = server._ensure_tg_image_clothing_anchor(
            prompt,
            "生成浴室人物图",
            {"text_to_image_workflow_profile": "person_t2i"},
        )

        self.assertIn("白色浴袍", anchored)
        self.assertNotIn("簡潔上衣", anchored)
        self.assertNotIn("直筒下裝", anchored)

    def test_tg_image_clothing_anchor_skips_default_clothes_for_no_clothing_request(self):
        prompt = (
            "一位成人女性全身站立在卧室中，保持无衣状态，"
            "她的左手扶着床沿而右手自然下垂，她的身体朝向镜头，她的头转向镜头"
        )

        anchored = server._ensure_tg_image_clothing_anchor(
            prompt,
            "美女无衣写真",
            {"text_to_image_workflow_profile": "person_t2i"},
        )

        self.assertIn("无衣状态", anchored)
        self.assertNotIn("服裝以米白色", anchored)
        self.assertNotIn("簡潔上衣", anchored)
        self.assertNotIn("直筒下裝", anchored)

    def test_persona_body_profile_uses_short_visible_anchor_for_jinjunya_lora(self):
        payload = server._apply_persona_body_profile_to_payload(
            "text_to_image",
            {
                "prompt": "一位成人女性站在现代卧室中，她的左手扶着椅背而右手自然下垂，她的身体朝向镜头，她的头转向镜头",
                "persona_enabled": True,
                "persona_lora": r"Character Setting\人设1捞女1金君雅.safetensors",
                "persona_label": "人设1捞女1金君雅",
                "negative_prompt": "low quality",
            },
        )

        self.assertIn("身形修長纖細，肩頸線條柔和，腰胯比例輕盈自然", payload["prompt"])
        self.assertNotIn("身材约束", payload["prompt"])
        self.assertNotIn("腰腹线条平滑", payload["prompt"])
        self.assertEqual(payload["prompt_text"], payload["prompt"])
        self.assertEqual(payload["tg_persona_body_profile_id"], "jinjunya_gy")
        self.assertIn("身材约束", payload["tg_persona_body_profile_prompt"])
        self.assertEqual(payload["tg_persona_body_prompt_anchor"], "身形修長纖細，肩頸線條柔和，腰胯比例輕盈自然")
        self.assertIn("粗腰", payload["negative_prompt"])
        self.assertIn("low quality", payload["negative_prompt"])

    def test_persona_body_profile_does_not_prepend_anchor_when_prompt_already_has_it(self):
        payload = server._apply_persona_body_profile_to_payload(
            "text_to_image",
            {
                "prompt": (
                    "一位身形修長纖細，肩頸線條柔和，腰胯比例輕盈自然的成人女性"
                    "站在现代卧室中，她的左手扶着椅背而右手自然下垂，"
                    "她的身体朝向镜头，她的头转向镜头"
                ),
                "persona_enabled": True,
                "persona_lora": r"Character Setting\人设1捞女1金君雅.safetensors",
                "persona_label": "人设1捞女1金君雅",
            },
        )

        self.assertEqual(payload["prompt"].count("身形修長纖細"), 1)
        self.assertNotRegex(payload["prompt"], r"^身形修長纖細，肩頸線條柔和，腰胯比例輕盈自然，一位身形修長纖細")

    def test_persona_body_profile_not_injected_when_persona_disabled(self):
        payload = server._apply_persona_body_profile_to_payload(
            "text_to_image",
            {
                "prompt": "一位成人女性站在现代卧室中",
                "persona_enabled": False,
                "persona_lora": r"Character Setting\人设1捞女1金君雅.safetensors",
            },
        )

        self.assertNotIn("身材约束", payload["prompt"])
        self.assertNotIn("tg_persona_body_profile_id", payload)

    def test_persona_body_profile_does_not_duplicate_prompt_or_negative(self):
        body_profile = server.PERSONA_BODY_PROFILES["jinjunya_gy"]["body_profile_prompt"]
        negative = server.PERSONA_BODY_PROFILES["jinjunya_gy"]["negative_body_prompt"]
        payload = server._apply_persona_body_profile_to_payload(
            "text_to_image",
            {
                "prompt": f"{body_profile}，一位成人女性站在现代卧室中",
                "negative_prompt": negative,
                "persona_enabled": True,
                "persona_label": "人设1金君雅",
            },
        )

        self.assertNotIn(body_profile, payload["prompt"])
        self.assertEqual(payload["prompt"].count("身形修長纖細"), 1)
        self.assertEqual(payload["negative_prompt"].count(negative), 1)

    def test_persona_body_profile_runtime_config_can_override_profile(self):
        payload = server._apply_persona_body_profile_to_payload(
            "text_to_image",
            {
                "prompt": "一位成人女性站在现代卧室中",
                "persona_enabled": True,
                "persona_lora": r"Character Setting\人设1捞女1金君雅.safetensors",
                "persona_body_profiles": {
                    "custom_jinjunya": {
                        "label": "自定义金君雅",
                        "match_terms": ["金君雅", "人设1捞女1金君雅.safetensors"],
                        "body_profile_prompt": "身材约束：自定义纤细沙漏体型",
                        "negative_body_prompt": "自定义负面体型漂移",
                    }
                },
            },
        )

        self.assertEqual(payload["tg_persona_body_profile_id"], "custom_jinjunya")
        self.assertIn("身形修長纖細，腰胯比例輕盈自然", payload["prompt"])
        self.assertNotIn("身材约束：自定义纤细沙漏体型", payload["prompt"])
        self.assertIn("自定义纤细沙漏体型", payload["tg_persona_body_profile_prompt"])
        self.assertIn("自定义负面体型漂移", payload["negative_prompt"])

    def test_finished_text_to_image_uses_reply_keyboard(self):
        markup = server._send_telegram_reply_markup_for_finished_task("task_1", "text_to_image")

        self.assertIn("keyboard", markup)
        self.assertNotIn("inline_keyboard", markup)
        self.assertEqual(markup["keyboard"][0][0]["text"], "重新生成圖片")
        self.assertEqual(markup["keyboard"][1][0]["text"], "繼續生成圖片")
        self.assertEqual(markup["keyboard"][2][0]["text"], "返回主選單")

    def test_user_visible_task_error_shortens_insufficient_balance_json(self):
        raw_error = (
            'MuleRouter 图生视频提交失败失败 HTTP 402: {"status": 402, "title": "Insufficient balance", '
            '"detail": "Insufficient balance to complete this request. Required: 650000 amount '
            '(65.0 credits), Available: 170000 amount (17.0 credits)"}'
        )

        formatted = server._format_user_visible_task_error(raw_error)

        self.assertEqual(formatted, "余额不足：本次需要 65.0 credits，当前只有 17.0 credits，请充值或降低视频参数后重试。")
        self.assertNotIn("{", formatted)
        self.assertNotIn("HTTP", formatted)

    def test_user_visible_task_error_shortens_comfy_cuda_oom(self):
        raw_error = (
            "远程 ComfyUI 工作流执行失败: 节点 17 (KSampler) CUDA error: "
            "out of memory Search for `cudaErrorMemoryAllocation` in docs"
        )

        formatted = server._format_user_visible_task_error(raw_error)

        self.assertTrue(formatted.startswith("4090 显存不足："))
        self.assertNotIn("cudaErrorMemoryAllocation", formatted)

    def test_user_visible_task_error_shortens_comfy_validation_json(self):
        raw_error = (
            '远程 ComfyUI 网关请求失败: 400 Client Error: Bad Request '
            '{"error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", '
            '"details": "", "node_errors": {"468": {"errors": [{"type": "value_not_in_list", '
            '"message": "Value not in list", "details": "keep_proportion: 1080 not in list"}]}}}}'
        )

        formatted = server._format_user_visible_task_error(raw_error)

        self.assertTrue(formatted.startswith("ComfyUI 工作流参数校验失败："))
        self.assertNotIn("node_errors", formatted)

    def test_user_visible_task_error_shortens_missing_custom_node(self):
        raw_error = '{"error": {"type": "missing_node_type", "message": "Node FooBar not found"}}'

        formatted = server._format_user_visible_task_error(raw_error)

        self.assertEqual(formatted, "ComfyUI 缺少自定义节点：当前工作流需要的节点没有安装或未启用，请在 4090 安装对应 custom node 后重试。")

    def test_user_visible_task_error_hides_unknown_raw_json(self):
        raw_error = '{"error": {"code": "vendor_error", "message": "very long private upstream payload"}}'

        formatted = server._format_user_visible_task_error(raw_error)

        self.assertEqual(formatted, "后台生成失败：上游服务返回了结构化错误，已隐藏原始 JSON；请在工作台查看详情或按当前任务类型重新提交。")
        self.assertNotIn("vendor_error", formatted)

    def test_task_detail_formats_error_fields_for_display(self):
        raw_error = (
            'MuleRouter 图生视频提交失败失败 HTTP 402: {"status": 402, "title": "Insufficient balance", '
            '"detail": "Insufficient balance to complete this request. Required: 650000 amount '
            '(65.0 credits), Available: 170000 amount (17.0 credits)"}'
        )
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO tasks(id, user_id, type, status, input_json, output_json, error, runninghub_task_id, usage_json, cost_cents, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "task_error_display",
                    1,
                    "video_i2v",
                    "failed",
                    "{}",
                    json.dumps({"items": [{"ok": False, "error": raw_error}], "ok": False}, ensure_ascii=False),
                    raw_error,
                    "",
                    "{}",
                    0,
                    server._now_ts(),
                    server._now_ts(),
                ),
            )

        with db_module.db() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", ("task_error_display",)).fetchone()
        detail = server._build_task_detail_payload(task=dict(row), include_logs=False)

        self.assertEqual(detail["error"], "余额不足：本次需要 65.0 credits，当前只有 17.0 credits，请充值或降低视频参数后重试。")
        self.assertEqual(detail["first_error"], detail["error"])
        self.assertEqual(detail["output"]["items"][0]["error"], detail["error"])

    def test_text_to_image_auto_qa_retries_rejected_candidate(self):
        first_image = Path(self._tmpdir.name) / "first.png"
        second_image = Path(self._tmpdir.name) / "second.png"
        first_image.write_bytes(b"first")
        second_image.write_bytes(b"second")
        comfy_results = [
            {"ok": True, "prompt_id": "prompt_1", "local_outputs": [{"local_path": str(first_image), "filename": "first.png"}]},
            {"ok": True, "prompt_id": "prompt_2", "local_outputs": [{"local_path": str(second_image), "filename": "second.png"}]},
        ]
        qa_results = [
            {
                "inspected": True,
                "passed": False,
                "overall_score": 40,
                "prompt_match_score": 80,
                "anatomy_score": 20,
                "visual_score": 60,
                "limb_or_body_broken": True,
                "issues": ["人物肢体错乱"],
            },
            {
                "inspected": True,
                "passed": True,
                "overall_score": 88,
                "prompt_match_score": 86,
                "anatomy_score": 92,
                "visual_score": 84,
                "deliverable_ready": True,
                "issues": [],
            },
        ]

        with patch.object(server, "_run_remote_comfy_gateway_test", side_effect=comfy_results) as run_mock, patch.object(
            server,
            "_analyze_generated_person_image_quality",
            side_effect=qa_results,
        ), patch.object(server, "_new_image_qa_seed", return_value=123456):
            output = server._run_remote_comfy_mapped_task(
                "task_qa",
                {
                    "remote_comfy_gateway_url": "http://comfy.local",
                    "remote_comfy_workflow_mappings": {"text_to_image": "ZIT_final_output.api.json"},
                    "prompt": "一位人物肖像，清晰自然",
                    "width": 640,
                    "height": 960,
                    "text_to_image_auto_qa_enabled": True,
                    "text_to_image_auto_qa_max_attempts": 3,
                },
                "text_to_image",
            )

        self.assertEqual(run_mock.call_count, 2)
        self.assertIsNone(run_mock.call_args_list[0].kwargs["seed"])
        self.assertEqual(run_mock.call_args_list[1].kwargs["seed"], 123456)
        self.assertEqual(output["image_path"], str(second_image))
        self.assertEqual(output["seed"], 123456)
        self.assertEqual(output["image_qa"]["rejected_rounds"], 1)
        self.assertEqual(output["image_qa"]["attempts"], 2)
        self.assertIn("已筛选 1 轮候选图", server._text_to_image_qa_notice(output))

    def test_text_to_image_auto_qa_unavailable_is_blocking(self):
        report = {"inspected": False, "passed": False, "qa_unavailable": True}

        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_ten_point_scores(self):
        report = {
            "inspected": True,
            "overall_score": server._qa_score(9),
            "prompt_match_score": server._qa_score(9),
            "anatomy_score": server._qa_score(9),
            "visual_score": server._qa_score(9),
            "deliverable_ready": True,
        }

        self.assertEqual(report["overall_score"], 90)
        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_requires_head_when_prompt_mentions_expression(self):
        self.assertTrue(server._text_to_image_prompt_requires_visible_head("人物直视镜头，眼神自然，表情柔和"))
        self.assertTrue(server._text_to_image_prompt_requires_visible_head("她的头微微侧转注视着前方"))
        self.assertFalse(server._text_to_image_prompt_requires_visible_head("人物站在室内，全身构图，背景自然"))

        report = {
            "inspected": True,
            "passed": True,
            "requires_visible_head": True,
            "head_visible": False,
            "head_cropped_or_missing": True,
            "overall_score": 90,
            "prompt_match_score": 90,
            "anatomy_score": 90,
            "visual_score": 90,
            "deliverable_ready": True,
            "issues": [],
        }

        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_borderline_anatomy_when_deliverable(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 88,
            "prompt_match_score": 90,
            "anatomy_score": 85,
            "visual_score": 87,
            "limb_or_body_broken": False,
            "deliverable_ready": True,
            "issues": [],
        }

        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_rejects_limb_geometry_flags(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 95,
            "prompt_match_score": 95,
            "anatomy_score": 95,
            "visual_score": 95,
            "limb_overlap_or_fusion": True,
            "deliverable_ready": True,
            "issues": [],
        }

        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_rejects_body_shape_flags(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 95,
            "prompt_match_score": 95,
            "anatomy_score": 95,
            "visual_score": 95,
            "body_shape_too_full": True,
            "body_shape_bulky_or_obese": True,
            "body_silhouette_score": 25,
            "deliverable_ready": True,
            "issues": [],
        }

        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_borderline_body_shape_audit(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 95,
            "prompt_match_score": 95,
            "anatomy_score": 95,
            "visual_score": 95,
            "deliverable_ready": True,
            "issues": [],
            "body_shape_audit": {
                "inspected": True,
                "clear_person_body_visible": True,
                "body_shape_too_full": True,
                "body_shape_bulky_or_obese": False,
                "upper_torso_contour_anomaly": True,
                "body_silhouette_score": 30,
                "confidence": 85,
            },
        }

        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_non_extreme_body_shape_flags(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 95,
            "prompt_match_score": 95,
            "anatomy_score": 95,
            "visual_score": 95,
            "body_shape_too_full": True,
            "upper_torso_contour_anomaly": True,
            "body_part_scale_anomaly": True,
            "body_silhouette_score": 76,
            "deliverable_ready": True,
            "issues": [],
        }

        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_minor_color_difference_when_deliverable(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 88,
            "prompt_match_score": 82,
            "anatomy_score": 92,
            "visual_score": 90,
            "prompt_mismatch_visible": True,
            "deliverable_ready": True,
            "issues": ["上衣颜色与提示词描述略有差异"],
        }

        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_minor_hand_pose_when_deliverable(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 88,
            "prompt_match_score": 90,
            "anatomy_score": 85,
            "visual_score": 88,
            "hand_anomaly_visible": True,
            "deliverable_ready": True,
            "issues": ["右手手指轻微姿态异常"],
        }

        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_accepts_unavailable_hand_review_when_main_report_deliverable(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 92,
            "prompt_match_score": 95,
            "anatomy_score": 95,
            "visual_score": 90,
            "deliverable_ready": True,
            "issues": ["图像手部肢体复审未完成，不能确认候选图可交付。"],
            "hand_limb_audit": {
                "inspected": False,
                "qa_unavailable": True,
                "issues": ["图像手部肢体复审未完成，不能确认候选图可交付。"],
            },
        }

        self.assertFalse(server._should_reject_generated_person_image(report))

    def test_internal_tg_cancel_finds_latest_active_webapp_task(self):
        server._create_task_record("task_old", 1, "text_to_image", {"tg_chat_id": 8100401093})
        server._create_task_record("task_other_chat", 1, "text_to_image", {"tg_chat_id": 123})
        server._create_task_record("task_latest", 1, "text_to_image", {"tg_chat_id": 8100401093})
        with db_module.db() as conn:
            conn.execute("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", ("running", server._now_ts() + 10, "task_latest"))

        target = server._find_latest_internal_tg_active_task(8100401093)
        result = server._cancel_task_record_for_user(
            task_id=str(target["id"]),
            user_id=int(target["user_id"]),
            requested_by="TG-8100401093",
            expected_chat_id=8100401093,
        )

        self.assertTrue(result["cancelled"])
        self.assertEqual(result["id"], "task_latest")
        with db_module.db() as conn:
            latest = conn.execute("SELECT status, error FROM tasks WHERE id = ?", ("task_latest",)).fetchone()
            old = conn.execute("SELECT status FROM tasks WHERE id = ?", ("task_old",)).fetchone()
            other = conn.execute("SELECT status FROM tasks WHERE id = ?", ("task_other_chat",)).fetchone()
        self.assertEqual(latest["status"], "cancelled")
        self.assertIn("TG-8100401093", latest["error"])
        self.assertEqual(old["status"], "queued")
        self.assertEqual(other["status"], "queued")

    def test_internal_tg_cancel_latest_reports_recent_finished_task_when_no_active_task(self):
        cancel_latest = self._route_endpoint("/api/internal/tg/tasks/cancel_latest", "POST")
        server._create_task_record("task_done", 1, "face_swap", {"tg_chat_id": 8100401093})
        server._create_task_record("task_other_chat", 1, "face_swap", {"tg_chat_id": 123})
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                ("success", server._now_ts() + 20, "task_done"),
            )
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                ("running", server._now_ts() + 30, "task_other_chat"),
            )

        class Request:
            query_params = {"chat_id": "8100401093"}
            headers = {}
            client = type("Client", (), {"host": "127.0.0.1"})()

        result = cancel_latest(Request())

        self.assertFalse(result["cancelled"])
        self.assertEqual(result["state"], "none")
        self.assertEqual(result["latest"]["id"], "task_done")
        self.assertEqual(result["latest"]["status"], "success")
        self.assertIn("目前狀態為已完成", result["message"])

    def test_internal_tg_tasks_include_workflow_meta(self):
        get_tasks = self._route_endpoint("/api/internal/tg/tasks", "GET")
        workflow_path = "__converted__/轉化TG機器人/firered图像编辑.api.json"
        old_workflow_path = "__converted__/old.api.json"
        server._write_runtime_config_file(
            {
                "remote_comfy_workflow_mappings": {"get_nano_banana": workflow_path},
            }
        )
        server._create_task_record(
            "task_edit_workflow",
            1,
            "get_nano_banana",
            {
                "tg_chat_id": 8100401093,
                "remote_comfy_workflow_mappings": {"get_nano_banana": old_workflow_path},
            },
        )

        class Request:
            query_params = {"chat_id": "8100401093", "limit": "5"}
            headers = {}
            client = type("Client", (), {"host": "127.0.0.1"})()

        result = get_tasks(Request())

        task = result["tasks"][0]
        self.assertEqual(task["id"], "task_edit_workflow")
        self.assertEqual(task["workflow_name"], "图片编辑")
        self.assertEqual(task["workflow_ids"], [old_workflow_path])
        self.assertEqual(task["current_workflow_name"], "圖片編輯")
        self.assertEqual(task["current_workflow_ids"], [workflow_path])

    def test_internal_tg_status_includes_active_workflow_meta(self):
        get_status = self._route_endpoint("/api/internal/tg/status", "GET")
        workflow_path = "__converted__/轉化TG機器人/firered图像编辑.api.json"
        old_workflow_path = "__converted__/old.api.json"
        server._write_runtime_config_file(
            {
                "remote_comfy_workflow_mappings": {"get_nano_banana": workflow_path},
            }
        )
        server._create_task_record(
            "task_active_workflow",
            1,
            "get_nano_banana",
            {
                "tg_chat_id": 8100401093,
                "remote_comfy_workflow_mappings": {"get_nano_banana": old_workflow_path},
            },
        )
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                ("running", server._now_ts() + 20, "task_active_workflow"),
            )

        class Request:
            query_params = {"chat_id": "8100401093"}
            headers = {}
            client = type("Client", (), {"host": "127.0.0.1"})()

        result = get_status(Request())

        self.assertEqual(result["active_task"]["id"], "task_active_workflow")
        self.assertEqual(result["active_task"]["workflow_name"], "图片编辑")
        self.assertEqual(result["active_task"]["workflow_ids"], [old_workflow_path])
        self.assertEqual(result["active_task"]["current_workflow_name"], "圖片編輯")
        self.assertEqual(result["active_task"]["current_workflow_ids"], [workflow_path])

    def test_cancelled_queued_webapp_task_is_not_started_by_worker(self):
        server._create_task_record("task_cancelled_before_start", 1, "text_to_image", {"tg_chat_id": 8100401093})
        server._cancel_task_record_for_user(
            task_id="task_cancelled_before_start",
            user_id=1,
            requested_by="TG-8100401093",
            expected_chat_id=8100401093,
        )

        with patch.dict(server.TASK_RUNNERS, {"text_to_image": lambda task_id, payload: {"ok": True}}, clear=False) as runners:
            server._task_worker("task_cancelled_before_start", 1, "text_to_image", {"tg_chat_id": 8100401093})

        with db_module.db() as conn:
            row = conn.execute("SELECT status FROM tasks WHERE id = ?", ("task_cancelled_before_start",)).fetchone()
        self.assertEqual(row["status"], "cancelled")

    def test_running_webapp_cancel_ignores_late_success_result(self):
        server._create_task_record("task_cancelled_late", 1, "text_to_image", {"tg_chat_id": 8100401093})

        def runner(task_id: str, payload: dict):
            server._cancel_task_record_for_user(
                task_id=task_id,
                user_id=1,
                requested_by="TG-8100401093",
                expected_chat_id=8100401093,
            )
            return {"ok": True, "image_path": str(Path(self._tmpdir.name) / "late.png"), "runninghub_task_id": "late_success"}

        with patch.dict(server.TASK_RUNNERS, {"text_to_image": runner}, clear=False):
            server._task_worker("task_cancelled_late", 1, "text_to_image", {"tg_chat_id": 8100401093})

        with db_module.db() as conn:
            task = conn.execute(
                "SELECT status, runninghub_task_id, cost_cents FROM tasks WHERE id = ?",
                ("task_cancelled_late",),
            ).fetchone()
            late_event = conn.execute(
                "SELECT message FROM task_events WHERE task_id = ? AND message = ?",
                ("task_cancelled_late", "任务已取消，忽略迟到的生成结果"),
            ).fetchone()
        self.assertEqual(task["status"], "cancelled")
        self.assertEqual(task["runninghub_task_id"], "")
        self.assertEqual(task["cost_cents"], 0)
        self.assertIsNotNone(late_event)

    def test_comfy_gpu_gate_serializes_remote_workflow_submits(self):
        server._write_runtime_config_file({"comfy_gpu_queue_enabled": True, "comfy_gpu_max_concurrency": 1})
        active_posts = 0
        max_active_posts = 0
        calls: list[str] = []
        lock = threading.Lock()

        def fake_gateway_json(**kwargs):
            nonlocal active_posts, max_active_posts
            if kwargs["method"] == "POST":
                with lock:
                    active_posts += 1
                    max_active_posts = max(max_active_posts, active_posts)
                    calls.append(str(kwargs["json_body"]["path"]))
                time.sleep(0.05)
                with lock:
                    active_posts -= 1
                return {"prompt_id": f"prompt_{len(calls)}"}
            return {"ok": True, "done": True, "outputs": []}

        def run_one(workflow: str):
            return server._run_remote_comfy_gateway_test(
                gateway_url="http://gateway",
                token="secret",
                workflow_path=workflow,
                prompt_text="一位人物站在室内",
                timeout_seconds=30,
            )

        with patch.object(server, "_COMFY_GPU_SEMAPHORE", threading.BoundedSemaphore(1)), \
             patch.object(server, "_COMFY_GPU_WAITING", 0), \
             patch.object(server, "_COMFY_GPU_RUNNING", 0), \
             patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json):
            threads = [
                threading.Thread(target=run_one, args=("workflow_a.api.json",)),
                threading.Thread(target=run_one, args=("workflow_b.api.json",)),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

        self.assertEqual(max_active_posts, 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(server._comfy_gpu_snapshot()["running"], 0)

    def test_comfy_gpu_gate_blocks_cancelled_task_before_submit(self):
        server._write_runtime_config_file({"comfy_gpu_queue_enabled": True, "comfy_gpu_max_concurrency": 1})
        server._create_task_record("task_wait_cancel", 1, "text_to_image", {"tg_chat_id": 8100401093})
        server._cancel_task_record_for_user(
            task_id="task_wait_cancel",
            user_id=1,
            requested_by="TG-8100401093",
            expected_chat_id=8100401093,
        )

        semaphore = threading.BoundedSemaphore(1)
        semaphore.acquire()
        try:
            with patch.object(server, "_COMFY_GPU_SEMAPHORE", semaphore), \
                 patch.object(server, "_COMFY_GPU_WAITING", 0), \
                 patch.object(server, "_COMFY_GPU_RUNNING", 0), \
                 patch.object(server, "COMFY_GPU_QUEUE_TIMEOUT_SECONDS", 30), \
                 patch.object(server, "COMFY_GPU_QUEUE_POLL_SECONDS", 1):
                with self.assertRaisesRegex(RuntimeError, "任務已取消"):
                    with server._comfy_gpu_execution_slot({"_task_id": "task_wait_cancel"}, workflow_path="wf.api.json"):
                        pass
                self.assertEqual(server._comfy_gpu_snapshot()["waiting"], 0)
                self.assertEqual(server._comfy_gpu_snapshot()["running"], 0)
        finally:
            semaphore.release()

    def test_latest_user_visible_event_prefers_terminal_event_after_failed_task(self):
        server._create_task_record("task_terminal_event", 1, "text_to_image", {"tg_chat_id": 8100401093})
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                ("failed", "restart interrupted", server._now_ts(), "task_terminal_event"),
            )
            server._insert_task_event(
                conn,
                task_id="task_terminal_event",
                user_id=1,
                kind="done",
                message="服務重啟，上一輪生成已中斷，請重新提交任務。",
                data={"status": "failed", "stage": "finish", "user_visible": True},
            )
            server._insert_task_event(
                conn,
                task_id="task_terminal_event",
                user_id=1,
                kind="progress",
                message="4090 正在生成，prompt_id: stale",
                data={"stage": "remote_comfy", "status": "running", "user_visible": True},
            )

        event = server._latest_user_visible_task_event("task_terminal_event")

        self.assertEqual(event["kind"], "done")
        self.assertIn("服務重啟", event["message"])

    def test_emit_task_event_ignores_progress_after_terminal_status(self):
        server._create_task_record("task_terminal_progress", 1, "text_to_image", {"tg_chat_id": 8100401093})
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                ("failed", "already failed", server._now_ts(), "task_terminal_progress"),
            )

        server._emit_task_event(
            task_id="task_terminal_progress",
            user_id=1,
            kind="progress",
            message="stale progress",
            data={"stage": "remote_comfy", "status": "running"},
        )

        with db_module.db() as conn:
            stale = conn.execute(
                "SELECT id FROM task_events WHERE task_id = ? AND message = ?",
                ("task_terminal_progress", "stale progress"),
            ).fetchone()
        self.assertIsNone(stale)

    def test_resume_pending_tasks_marks_running_task_interrupted(self):
        server._create_task_record("task_restart_running", 1, "text_to_image", {"tg_chat_id": 8100401093})
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                ("running", server._now_ts(), "task_restart_running"),
            )

        server._resume_pending_tasks()

        with db_module.db() as conn:
            task = conn.execute(
                "SELECT status, error FROM tasks WHERE id = ?",
                ("task_restart_running",),
            ).fetchone()
            event = conn.execute(
                "SELECT kind, message FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1",
                ("task_restart_running",),
            ).fetchone()

        self.assertEqual(task["status"], "failed")
        self.assertIn("服務重啟", task["error"])
        self.assertEqual(event["kind"], "done")

    def test_person_t2i_batch_qa_defaults_to_six_attempts(self):
        calls: list[int] = []

        def fake_run_remote(**kwargs):
            calls.append(len(calls) + 1)
            idx = len(calls)
            outputs = []
            for image_idx in range(3):
                path = Path(self._tmpdir.name) / f"candidate_{idx}_{image_idx}.jpg"
                path.write_bytes(b"fake")
                outputs.append({"local_path": str(path), "type": "output", "filename": path.name})
            return {
                "ok": True,
                "prompt_id": f"prompt_{idx}",
                "local_outputs": outputs,
            }

        def fake_qa(**kwargs):
            return {"inspected": True, "passed": False, "limb_or_body_broken": True, "issues": ["test reject"]}

        payload = {
            "_task_id": "task_batch_qa_limit",
            "_task_type": "text_to_image",
            "prompt": "test prompt",
            "remote_comfy_gateway_url": "http://gateway",
            "remote_comfy_gateway_token": "secret",
            "remote_comfy_workflow_mappings": {"text_to_image": "person_t2i.api.json"},
            "text_to_image_auto_qa_enabled": True,
            "text_to_image_qa_target_count": 6,
            "batch_size": 3,
        }

        with patch.object(server, "_run_remote_comfy_gateway_test", side_effect=fake_run_remote), \
             patch.object(server, "_analyze_generated_person_image_quality", side_effect=fake_qa):
            with self.assertRaisesRegex(RuntimeError, "6"):
                server._run_remote_comfy_mapped_task("task_batch_qa_limit", payload, "text_to_image")

        self.assertEqual(len(calls), 6)

    def test_person_t2i_batch_qa_keeps_passed_images_and_regenerates_full_batches(self):
        batch_sizes: list[int] = []
        qa_results = iter(
            [
                {"inspected": True, "passed": True, "overall_score": 90, "prompt_match_score": 90, "anatomy_score": 90, "visual_score": 90, "deliverable_ready": True},
                {"inspected": True, "passed": True, "overall_score": 90, "prompt_match_score": 90, "anatomy_score": 90, "visual_score": 90, "deliverable_ready": True},
                {"inspected": True, "passed": False, "limb_or_body_broken": True, "issues": ["test reject"]},
                {"inspected": True, "passed": False, "limb_or_body_broken": True, "issues": ["test reject"]},
                {"inspected": True, "passed": True, "overall_score": 90, "prompt_match_score": 90, "anatomy_score": 90, "visual_score": 90, "deliverable_ready": True},
                {"inspected": True, "passed": True, "overall_score": 90, "prompt_match_score": 90, "anatomy_score": 90, "visual_score": 90, "deliverable_ready": True},
                {"inspected": True, "passed": False, "limb_or_body_broken": True, "issues": ["test reject"]},
                {"inspected": True, "passed": False, "limb_or_body_broken": True, "issues": ["test reject"]},
            ]
        )

        def fake_run_remote(**kwargs):
            requested = int(kwargs.get("batch_size") or 1)
            batch_sizes.append(requested)
            outputs = []
            for image_idx in range(requested):
                path = Path(self._tmpdir.name) / f"candidate_{len(batch_sizes)}_{image_idx}.jpg"
                path.write_bytes(b"fake")
                outputs.append({"local_path": str(path), "type": "output", "filename": path.name})
            return {
                "ok": True,
                "prompt_id": f"prompt_{len(batch_sizes)}",
                "local_outputs": outputs,
            }

        payload = {
            "_task_id": "task_batch_qa_missing_only",
            "_task_type": "text_to_image",
            "prompt": "test prompt",
            "remote_comfy_gateway_url": "http://gateway",
            "remote_comfy_gateway_token": "secret",
            "remote_comfy_workflow_mappings": {"text_to_image": "person_t2i.api.json"},
            "text_to_image_auto_qa_enabled": True,
            "text_to_image_auto_qa_max_attempts": 3,
            "text_to_image_qa_target_count": 4,
            "batch_size": 4,
        }

        with patch.object(server, "_run_remote_comfy_gateway_test", side_effect=fake_run_remote), \
             patch.object(server, "_analyze_generated_person_image_quality", side_effect=lambda **kwargs: next(qa_results)), \
             patch.object(server, "_new_image_qa_seed", return_value=123456):
            output = server._run_remote_comfy_mapped_task("task_batch_qa_missing_only", payload, "text_to_image")

        self.assertEqual(batch_sizes, [4, 4])
        self.assertEqual(len(output["image_paths"]), 4)
        self.assertEqual(output["image_qa"]["attempts"], 2)
        self.assertEqual(output["image_qa"]["passed_count"], 4)

    def test_comfy_gpu_memory_stats_parse_comfy_system_stats(self):
        stats = {
            "devices": [
                {
                    "name": "NVIDIA GeForce RTX 4090",
                    "type": "cuda",
                    "vram_total": 24 * 1024**3,
                    "vram_free": 18 * 1024**3,
                }
            ]
        }

        parsed = server._extract_comfy_gpu_memory_stats(stats)

        self.assertTrue(parsed["available"])
        self.assertEqual(parsed["vram_total_gb"], 24.0)
        self.assertEqual(parsed["vram_free_gb"], 18.0)

    def test_comfy_gpu_capacity_check_ignores_low_vram_when_queue_has_slot(self):
        def fake_gateway_json(**kwargs):
            if kwargs["path"] == "/api/health":
                return {
                    "devices": [
                        {
                            "name": "4090",
                            "type": "cuda",
                            "vram_total": 24 * 1024**3,
                            "vram_free": 7 * 1024**3,
                        }
                    ]
                }
            if kwargs["path"] == "/api/queue":
                return {"queue_running": [], "queue_pending": []}
            return {}

        with patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json), \
             patch.object(server, "COMFY_GPU_DYNAMIC_ENABLED", True), \
             patch.object(server, "COMFY_GPU_MIN_FREE_GB", 8.0), \
             patch.object(server, "COMFY_GPU_RESERVE_GB", 4.0), \
             patch.object(server, "COMFY_GPU_MAX_CONCURRENCY", 4):
            check = server._comfy_gpu_capacity_check(
                gateway_url="http://gateway",
                token="secret",
                payload={"_task_id": "task_gpu_check", "_task_type": "text_to_image", "batch_size": 3},
                workflow_path="person_t2i.api.json",
                body={"path": "person_t2i.api.json", "batch_size": 3, "width": 1024, "height": 1536},
            )

        self.assertTrue(check["ok"])
        self.assertEqual(check["reason"], "queue_slot_available")
        self.assertEqual(check["queue_load"], 0)
        self.assertEqual(check["free_gb"], 7.0)
        self.assertGreater(check["required_free_gb"], 7)

    def test_comfy_gpu_capacity_check_allows_queue_running_below_limit(self):
        def fake_gateway_json(**kwargs):
            if kwargs["path"] == "/api/health":
                return {
                    "devices": [
                        {
                            "name": "4090",
                            "type": "cuda",
                            "vram_total": 24 * 1024**3,
                            "vram_free": 22 * 1024**3,
                        }
                    ]
                }
            if kwargs["path"] == "/api/queue":
                return {"queue_running": [["prompt-running"]], "queue_pending": []}
            return {}

        with patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json), \
             patch.object(server, "COMFY_GPU_DYNAMIC_ENABLED", True), \
             patch.object(server, "COMFY_GPU_MAX_CONCURRENCY", 4):
            check = server._comfy_gpu_capacity_check(
                gateway_url="http://gateway",
                token="secret",
                payload={"_task_id": "task_gpu_queue", "_task_type": "single_image_edit"},
                workflow_path="edit.api.json",
                body={"path": "edit.api.json"},
            )

        self.assertTrue(check["ok"])
        self.assertEqual(check["reason"], "queue_slot_available")

    def test_comfy_gpu_capacity_check_reports_remote_queue_over_limit_without_blocking(self):
        server._write_runtime_config_file({"comfy_gpu_max_concurrency": 2})

        def fake_gateway_json(**kwargs):
            if kwargs["path"] == "/api/health":
                return {
                    "devices": [
                        {
                            "name": "4090",
                            "type": "cuda",
                            "vram_total": 24 * 1024**3,
                            "vram_free": 22 * 1024**3,
                        }
                    ]
                }
            if kwargs["path"] == "/api/queue":
                return {"queue_running": [["prompt-running"], ["prompt-running-2"]], "queue_pending": []}
            return {}

        with patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json), \
             patch.object(server, "COMFY_GPU_DYNAMIC_ENABLED", True), \
             patch.object(server, "COMFY_GPU_MAX_CONCURRENCY", 4):
            check = server._comfy_gpu_capacity_check(
                gateway_url="http://gateway",
                token="secret",
                payload={"_task_id": "task_gpu_queue", "_task_type": "single_image_edit"},
                workflow_path="edit.api.json",
                body={"path": "edit.api.json"},
            )

        self.assertTrue(check["ok"])
        self.assertEqual(check["reason"], "queue_slot_available")
        self.assertEqual(check["max_concurrency"], 2)
        self.assertEqual(check["queue_load"], 2)
        self.assertEqual(check["remote_queue_over_limit"], True)

    def test_comfy_gpu_capacity_check_waits_when_comfy_queue_reaches_limit(self):
        def fake_gateway_json(**kwargs):
            if kwargs["path"] == "/api/health":
                return {
                    "devices": [
                        {
                            "name": "4090",
                            "type": "cuda",
                            "vram_total": 24 * 1024**3,
                            "vram_free": 22 * 1024**3,
                        }
                    ]
                }
            if kwargs["path"] == "/api/queue":
                return {
                    "queue_running": [["prompt-running"], ["prompt-running-2"]],
                    "queue_pending": [["prompt-pending"], ["prompt-pending-2"]],
                }
            return {}

        with patch.object(server, "_remote_comfy_gateway_json", side_effect=fake_gateway_json), \
             patch.object(server, "COMFY_GPU_DYNAMIC_ENABLED", True), \
             patch.object(server, "COMFY_GPU_MAX_CONCURRENCY", 4):
            check = server._comfy_gpu_capacity_check(
                gateway_url="http://gateway",
                token="secret",
                payload={"_task_id": "task_gpu_queue", "_task_type": "single_image_edit"},
                workflow_path="edit.api.json",
                body={"path": "edit.api.json"},
            )

        self.assertTrue(check["ok"])
        self.assertEqual(check["reason"], "queue_slot_available")
        self.assertEqual(check["queue_load"], 4)
        self.assertEqual(check["remote_queue_over_limit"], True)

    def test_person_t2i_generates_four_per_attempt_and_returns_four_to_telegram(self):
        workflow = "__converted__/person_t2i.api.json"

        self.assertEqual(server._remote_comfy_default_batch_size("text_to_image", workflow), 4)
        self.assertEqual(
            server._text_to_image_qa_target_count({}, batch_size=4, workflow_path=workflow),
            4,
        )

    def test_text_to_image_auto_qa_rejects_hand_limb_audit_extra_hands(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 98,
            "prompt_match_score": 98,
            "anatomy_score": 99,
            "visual_score": 98,
            "deliverable_ready": True,
            "issues": [],
            "hand_limb_audit": {
                "inspected": True,
                "visible_hand_count": 3,
                "visible_arm_count": 2,
                "extra_hand_suspected": True,
                "confidence": 92,
            },
        }

        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_rejects_clothing_color_mismatch(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 98,
            "prompt_match_score": 98,
            "anatomy_score": 99,
            "visual_score": 98,
            "deliverable_ready": True,
            "issues": [],
            "clothing_audit": {
                "inspected": True,
                "clothing_requirement_visible": True,
                "garment_mismatch_visible": False,
                "color_mismatch_visible": True,
                "clothing_state_mismatch_visible": False,
                "clothing_match_score": 90,
                "color_match_score": 45,
                "confidence": 88,
            },
        }

        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_rejects_clothing_boundary_artifact_at_moderate_confidence(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 98,
            "prompt_match_score": 98,
            "anatomy_score": 99,
            "visual_score": 98,
            "deliverable_ready": True,
            "issues": [],
        }
        clothing_audit = {
            "inspected": True,
            "clothing_requirement_visible": True,
            "garment_mismatch_visible": False,
            "color_mismatch_visible": False,
            "clothing_state_mismatch_visible": False,
            "clothing_clipping_or_fusion_visible": True,
            "impossible_clothing_structure_visible": True,
            "exposed_region_clothing_conflict_visible": False,
            "clothing_match_score": 70,
            "color_match_score": 95,
            "confidence": 80,
            "summary": "衣物边缘与胸部边界融合，出现贴片硬边。",
            "issues": ["衣物边缘与身体边界穿插融合，局部像贴片。"],
        }

        server._merge_generated_person_clothing_audit(report, clothing_audit)

        self.assertTrue(report["clothing_mismatch_visible"])
        self.assertTrue(report["clothing_clipping_or_fusion_visible"])
        self.assertFalse(report["deliverable_ready"])
        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_text_to_image_auto_qa_rejects_body_boundary_artifact_at_moderate_confidence(self):
        report = {
            "inspected": True,
            "passed": True,
            "overall_score": 98,
            "prompt_match_score": 98,
            "anatomy_score": 99,
            "visual_score": 98,
            "body_silhouette_score": 92,
            "deliverable_ready": True,
            "issues": [],
        }
        body_audit = {
            "inspected": True,
            "clear_person_body_visible": True,
            "body_shape_too_full": False,
            "body_shape_bulky_or_obese": False,
            "upper_torso_contour_anomaly": True,
            "exposed_region_anatomy_artifact": True,
            "body_silhouette_score": 55,
            "confidence": 80,
            "summary": "衣物与身体边界穿模融合。",
            "issues": ["上半身局部边界与布料融合，出现硬边贴片。"],
        }

        server._merge_generated_person_body_shape_audit(report, body_audit)

        self.assertTrue(report["upper_torso_contour_anomaly"])
        self.assertTrue(report["exposed_region_artifact_visible"])
        self.assertFalse(report["deliverable_ready"])
        self.assertTrue(server._should_reject_generated_person_image(report))

    def test_tg_clothing_state_matches_upper_exposure_without_quality_tail_constraint(self):
        clothing = "穿着浅粉色柔软吊带上衣和米白色丝质短裙，肩带自然滑落"
        exposure = "露出丰满坚挺的乳房和清晰可见的乳头"

        fixed = server._tg_ensure_clothing_state_matches_exposure(clothing, exposure)

        self.assertIn("吊带上衣领口下拉至胸下", fixed)
        self.assertNotIn("肩带自然滑落", fixed)

        quality = server._tg_prompt_quality_clause(["高清", "写实摄影"])
        self.assertNotIn("衣物边缘与暴露区域边界清晰分离", quality)

    def test_generated_person_qa_rejects_clothing_audit_before_hand_audit(self):
        image_path = Path(self._tmpdir.name) / "candidate_clothing.png"
        image_path.write_bytes(b"not-a-real-png-but-existing")
        general_pass = {
            "parsed": {
                "summary": "general pass",
                "overallScore": 98,
                "promptMatchScore": 98,
                "anatomyScore": 99,
                "visualScore": 98,
                "limbOrBodyBroken": False,
                "extraOrMissingLimbs": False,
                "limbOverlapOrFusion": False,
                "handAnomalyVisible": False,
                "poseGeometryBroken": False,
                "bodyPartScaleAnomaly": False,
                "bodyShapeTooFull": False,
                "bodyShapeBulkyOrObese": False,
                "bodySilhouetteScore": 92,
                "promptMismatchVisible": False,
                "meaninglessOrCollapsed": False,
                "textOrWatermarkVisible": False,
                "headVisible": True,
                "headCroppedOrMissing": False,
                "deliverableReady": True,
                "issues": [],
                "fixPriorities": [],
            }
        }
        body_audit_pass = {
            "parsed": {
                "summary": "body pass",
                "clearPersonBodyVisible": True,
                "bodyShapeTooFull": False,
                "bodyShapeBulkyOrObese": False,
                "upperTorsoContourAnomaly": False,
                "bodySilhouetteScore": 92,
                "confidence": 91,
                "issues": [],
            }
        }
        clothing_audit_reject = {
            "parsed": {
                "summary": "服装颜色不匹配",
                "clothingRequirementVisible": True,
                "requiredClothing": ["白色衬衫", "黑色短裙"],
                "requiredColors": ["白色", "黑色"],
                "visibleClothing": ["红色连衣裙"],
                "visibleColors": ["红色"],
                "garmentMismatchVisible": True,
                "colorMismatchVisible": True,
                "clothingStateMismatchVisible": False,
                "clothingMatchScore": 35,
                "colorMatchScore": 25,
                "confidence": 92,
                "issues": ["服装类型和主色与提示词不一致"],
            }
        }

        hand_audit_pass = {
            "parsed": {
                "summary": "hand limb pass",
                "visibleHandCount": 2,
                "visibleArmCount": 2,
                "extraHandSuspected": False,
                "extraArmSuspected": False,
                "handFingerAnomalySuspected": False,
                "armAttachmentAnomalySuspected": False,
                "limbFusionSuspected": False,
                "bodyDuplicatePartSuspected": False,
                "confidence": 92,
                "issues": [],
            }
        }

        with patch.object(
            server,
            "_request_llm_json_with_fallback",
            side_effect=[
                (general_pass, {"model": "qa-general"}, 1),
                (body_audit_pass, {"model": "qa-body"}, 1),
                (clothing_audit_reject, {"model": "qa-clothing"}, 1),
                (hand_audit_pass, {"model": "qa-hand"}, 1),
            ],
        ) as qa_mock:
            report = server._analyze_generated_person_image_quality(
                image_path=str(image_path),
                prompt_text="一位女性站在卧室中，穿着白色衬衫和黑色短裙，写实摄影",
                payload={},
                attempt=1,
            )

        self.assertEqual(qa_mock.call_count, 4)
        self.assertFalse(report["passed"])
        self.assertTrue(report["clothing_mismatch_visible"])
        self.assertTrue(report["garment_mismatch_visible"])
        self.assertTrue(report["clothing_color_mismatch_visible"])
        self.assertEqual(report["clothing_audit"]["color_match_score"], 25)
        self.assertNotIn("hand_limb_audit", report)

    def test_generated_person_qa_runs_hand_limb_audit_after_general_pass(self):
        image_path = Path(self._tmpdir.name) / "candidate.png"
        image_path.write_bytes(b"not-a-real-png-but-existing")
        general_pass = {
            "parsed": {
                "summary": "整体画面可交付。",
                "overallScore": 98,
                "promptMatchScore": 98,
                "anatomyScore": 99,
                "visualScore": 98,
                "limbOrBodyBroken": False,
                "extraOrMissingLimbs": False,
                "limbOverlapOrFusion": False,
                "handAnomalyVisible": False,
                "poseGeometryBroken": False,
                "bodyPartScaleAnomaly": False,
                "promptMismatchVisible": False,
                "meaninglessOrCollapsed": False,
                "textOrWatermarkVisible": False,
                "headVisible": True,
                "headCroppedOrMissing": False,
                "deliverableReady": True,
                "issues": [],
                "fixPriorities": [],
            }
        }
        hand_audit_reject = {
            "parsed": {
                "summary": "画面中疑似出现第三只手。",
                "visibleHandCount": 3,
                "visibleArmCount": 2,
                "extraHandSuspected": True,
                "extraArmSuspected": False,
                "handFingerAnomalySuspected": False,
                "armAttachmentAnomalySuspected": False,
                "limbFusionSuspected": False,
                "bodyDuplicatePartSuspected": False,
                "confidence": 92,
                "issues": ["疑似额外手掌"],
            }
        }
        body_audit_pass = {
            "parsed": {
                "summary": "身形自然可交付。",
                "clearPersonBodyVisible": True,
                "bodyShapeTooFull": False,
                "bodyShapeBulkyOrObese": False,
                "bodySilhouetteScore": 92,
                "confidence": 91,
                "issues": [],
            }
        }

        with patch.object(
            server,
            "_request_llm_json_with_fallback",
            side_effect=[
                (general_pass, {"model": "qa-general"}, 1),
                (body_audit_pass, {"model": "qa-body"}, 1),
                (hand_audit_reject, {"model": "qa-audit"}, 1),
            ],
        ) as qa_mock:
            report = server._analyze_generated_person_image_quality(
                image_path=str(image_path),
                prompt_text="一个人物站在室内，完整身体构图",
                payload={},
                attempt=1,
            )

        self.assertEqual(qa_mock.call_count, 3)
        self.assertFalse(report["passed"])
        self.assertEqual(report["body_shape_audit"]["body_silhouette_score"], 92)
        self.assertTrue(report["extra_or_missing_limbs"])
        self.assertTrue(report["hand_anomaly_visible"])
        self.assertEqual(report["hand_limb_audit"]["visible_hand_count"], 3)
        self.assertIn("疑似额外手掌", report["issues"])

    def test_generated_person_qa_rejects_body_shape_audit_before_hand_audit(self):
        image_path = Path(self._tmpdir.name) / "candidate_body.png"
        image_path.write_bytes(b"not-a-real-png-but-existing")
        general_pass = {
            "parsed": {
                "summary": "整体画面可交付。",
                "overallScore": 98,
                "promptMatchScore": 98,
                "anatomyScore": 99,
                "visualScore": 98,
                "limbOrBodyBroken": False,
                "extraOrMissingLimbs": False,
                "limbOverlapOrFusion": False,
                "handAnomalyVisible": False,
                "poseGeometryBroken": False,
                "bodyPartScaleAnomaly": False,
                "bodyShapeTooFull": False,
                "bodyShapeBulkyOrObese": False,
                "bodySilhouetteScore": 92,
                "promptMismatchVisible": False,
                "meaninglessOrCollapsed": False,
                "textOrWatermarkVisible": False,
                "headVisible": True,
                "headCroppedOrMissing": False,
                "deliverableReady": True,
                "issues": [],
                "fixPriorities": [],
            }
        }
        body_audit_reject = {
            "parsed": {
                "summary": "人物身形過於厚重，不符合交付要求。",
                "clearPersonBodyVisible": True,
                "bodyShapeTooFull": True,
                "bodyShapeBulkyOrObese": True,
                "bodySilhouetteScore": 25,
                "confidence": 92,
                "issues": ["人物身形過於厚重"],
            }
        }

        with patch.object(
            server,
            "_request_llm_json_with_fallback",
            side_effect=[
                (general_pass, {"model": "qa-general"}, 1),
                (body_audit_reject, {"model": "qa-body"}, 1),
                (body_audit_reject, {"model": "qa-hand"}, 1),
            ],
        ) as qa_mock:
            report = server._analyze_generated_person_image_quality(
                image_path=str(image_path),
                prompt_text="一位人物站在室内，完整身体构图",
                payload={},
                attempt=1,
            )

        self.assertEqual(qa_mock.call_count, 3)
        self.assertFalse(report["passed"])
        self.assertTrue(report["body_shape_too_full"])
        self.assertTrue(report["body_shape_bulky_or_obese"])
        self.assertEqual(report["body_shape_audit"]["body_silhouette_score"], 25)
        self.assertNotIn("hand_limb_audit", report)

    def test_generated_person_qa_accepts_non_extreme_upper_torso_contour_anomaly(self):
        image_path = Path(self._tmpdir.name) / "candidate_upper_torso.png"
        image_path.write_bytes(b"not-a-real-png-but-existing")
        general_pass = {
            "parsed": {
                "summary": "general pass",
                "overallScore": 98,
                "promptMatchScore": 98,
                "anatomyScore": 99,
                "visualScore": 98,
                "limbOrBodyBroken": False,
                "extraOrMissingLimbs": False,
                "limbOverlapOrFusion": False,
                "handAnomalyVisible": False,
                "poseGeometryBroken": False,
                "bodyPartScaleAnomaly": False,
                "bodyShapeTooFull": False,
                "bodyShapeBulkyOrObese": False,
                "bodySilhouetteScore": 92,
                "promptMismatchVisible": False,
                "meaninglessOrCollapsed": False,
                "textOrWatermarkVisible": False,
                "headVisible": True,
                "headCroppedOrMissing": False,
                "deliverableReady": True,
                "issues": [],
                "fixPriorities": [],
            }
        }
        body_audit_reject = {
            "parsed": {
                "summary": "upper torso contour anomaly",
                "clearPersonBodyVisible": True,
                "bodyShapeTooFull": False,
                "bodyShapeBulkyOrObese": False,
                "upperTorsoContourAnomaly": True,
                "bodySilhouetteScore": 90,
                "confidence": 94,
                "issues": ["upper torso contour anomaly"],
            }
        }
        hand_audit_pass = {
            "parsed": {
                "summary": "hand limb pass",
                "visibleHandCount": 2,
                "visibleArmCount": 2,
                "extraHandSuspected": False,
                "extraArmSuspected": False,
                "handFingerAnomalySuspected": False,
                "armAttachmentAnomalySuspected": False,
                "limbFusionSuspected": False,
                "bodyDuplicatePartSuspected": False,
                "confidence": 92,
                "issues": [],
            }
        }

        with patch.object(
            server,
            "_request_llm_json_with_fallback",
            side_effect=[
                (general_pass, {"model": "qa-general"}, 1),
                (body_audit_reject, {"model": "qa-body"}, 1),
                (hand_audit_pass, {"model": "qa-hand"}, 1),
            ],
        ) as qa_mock:
            report = server._analyze_generated_person_image_quality(
                image_path=str(image_path),
                prompt_text="portrait candidate",
                payload={},
                attempt=1,
            )

        self.assertEqual(qa_mock.call_count, 3)
        self.assertTrue(report["passed"])
        self.assertFalse(report.get("upper_torso_contour_anomaly", False))
        self.assertFalse(report.get("body_part_scale_anomaly", False))
        self.assertTrue(report["body_shape_audit"]["upper_torso_contour_anomaly"])
        self.assertIn("hand_limb_audit", report)

    def test_text_to_image_aspect_ratio_pose_guidance_matches_orientation(self):
        portrait = server._tg_image_aspect_ratio_pose_guidance({"aspect_ratio": "9:16", "width": 576, "height": 1024})
        landscape = server._tg_image_aspect_ratio_pose_guidance({"aspect_ratio": "16:9", "width": 1024, "height": 576})
        base_landscape = server._tg_image_aspect_ratio_pose_guidance({"aspect_ratio": "3:2", "width": 960, "height": 640})
        balanced_landscape = server._tg_image_aspect_ratio_pose_guidance({"aspect_ratio": "4:3", "width": 896, "height": 672})
        square = server._tg_image_aspect_ratio_pose_guidance({"aspect_ratio": "1:1", "width": 768, "height": 768})

        self.assertIn("手机长竖图", portrait)
        self.assertIn("站立", portrait)
        self.assertIn("宽屏横图", landscape)
        self.assertIn("横向场景动作", landscape)
        self.assertIn("正方形构图", square)
        self.assertIn("居中半身", square)

        self.assertIn("3:2", base_landscape)
        self.assertIn("4:3", balanced_landscape)

    def test_tg_image_fallback_prompt_includes_aspect_ratio_pose_guidance(self):
        prompt = server._build_tg_image_fallback_prompt(
            "人物在室内拍照",
            {"aspect_ratio": "16:9", "width": 1024, "height": 576},
        )

        self.assertIn("宽屏横图", prompt)
        self.assertIn("横向场景动作", prompt)
        self.assertIn("头部完整入镜", prompt)

    def test_tg_video_duration_guidance_uses_selected_seconds(self):
        guidance = server._tg_video_duration_timing_guidance({"duration_seconds": 8})

        self.assertIn("Clip length category: medium", guidance)
        self.assertIn("begin", guidance)
        self.assertIn("continue", guidance)
        self.assertIn("ending state", guidance)
        self.assertIn("about three natural action beats", guidance)
        self.assertNotIn("8 seconds", guidance)
        self.assertNotIn("秒", guidance)
        self.assertNotIn("0-2s", guidance)
        self.assertNotIn("2-6s", guidance)
        self.assertNotIn("6-8s", guidance)
        self.assertIn("stable", guidance)

    def test_tg_video_duration_guidance_limits_short_clip_action_density(self):
        two_second_guidance = server._tg_video_duration_timing_guidance({"duration_seconds": 2})
        five_second_guidance = server._tg_video_duration_timing_guidance({"duration_seconds": 5})
        long_guidance = server._tg_video_duration_timing_guidance({"duration_seconds": 15})

        self.assertIn("one simple requested motion", two_second_guidance)
        self.assertIn("avoid adding extra plot beats", two_second_guidance)
        self.assertIn("at most two action beats", five_second_guidance)
        self.assertIn("do not add scene changes or secondary actions", five_second_guidance)
        self.assertIn("four or more slow connected action beats", long_guidance)
        self.assertIn("without hard cuts", long_guidance)

    def test_tg_video_prompt_normalizer_splits_long_tail_and_stabilizes_camera(self):
        prompt = server._normalize_tg_chinese_video_prompt_format(
            "\u5979\u7684\u5de6\u624b\u8f7b\u8f7b\u79fb\u52a8\u800c\u53f3\u624b\u6276\u5728\u817f\u4fa7\uff0c"
            "\u5979\u7684\u8eab\u4f53\u9762\u5411\u753b\u9762\uff0c\u5979\u7684\u5934\u8f6c\u5411\u524d\u65b9\uff0c"
            "\u52a8\u4f5c\u9010\u6e10\u52a0\u5feb\u4f34\u968f\u7740\u6e7f\u6da6\u6c34\u58f0\u548c\u5979\u7684\u547c\u5438\u58f0\u8d28\u611f\u7ec6\u817b\u771f\u5b9e",
            {"duration_seconds": 5},
        )

        self.assertIn("\u52a0\u5feb\uff0c\u4f34\u968f", prompt)
        self.assertIn("\u547c\u5438\u58f0\uff0c\u8d28\u611f", prompt)
        self.assertIn("\u955c\u5934\u57fa\u672c\u4fdd\u6301\u7a33\u5b9a", prompt)

    def test_tg_video_prompt_normalizer_removes_numeric_timestamps(self):
        prompt = server._normalize_tg_chinese_video_prompt_format(
            "\u955c\u59340-1\u79d2\u521d\u59cb\u59ff\u52bf\uff0c1-4\u79d2\u624b\u6307\u52a0\u901f\u79fb\u52a8\uff0c"
            "4-5\u79d2\u8eab\u4f53\u8f7b\u98a4\uff0c\u7ed3\u675f\uff0c\u9ad8\u6e05\u6d41\u7545\u89c6\u9891\uff0c\u8d28\u611f",
            {"duration_seconds": 5},
        )

        self.assertNotIn("0-1\u79d2", prompt)
        self.assertNotIn("1-4\u79d2", prompt)
        self.assertNotIn("4-5\u79d2", prompt)
        self.assertNotIn("\u79d2", prompt)
        self.assertIn("\u955c\u5934\u57fa\u672c\u4fdd\u6301\u7a33\u5b9a", prompt)
        self.assertNotIn("\u9ad8\u6e05\u6d41\u7545\u89c6\u9891\uff0c\u8d28\u611f", prompt)

    def test_tg_video_prompt_normalizer_removes_single_duration_terms(self):
        prompt = server._normalize_tg_chinese_video_prompt_format(
            "\u753b\u9762\u5f00\u59cb\u65f6\u5979\u5750\u5728\u5e8a\u8fb9\uff0c"
            "5\u79d2\u5185\u52a8\u4f5c\u6d41\u7545\u5c55\u5f00\uff0c\u7ea6\u4e94\u79d2\u7ed3\u675f\uff0c"
            "\u77ed\u77ed\u51e0\u79d2\u5185\u8868\u60c5\u53d8\u5316\uff0c"
            "\u6700\u540e\u955c\u5934\u4fdd\u6301\u7a33\u5b9a\uff0c\u753b\u9762\u8d28\u611f\u7ec6\u817b",
            {"duration_seconds": 5},
        )

        self.assertNotIn("5\u79d2\u5185", prompt)
        self.assertNotIn("\u7ea6\u4e94\u79d2", prompt)
        self.assertNotIn("\u51e0\u79d2", prompt)
        self.assertNotIn("\u79d2", prompt)
        self.assertIn("\u52a8\u4f5c\u6d41\u7545\u5c55\u5f00", prompt)

    def test_tg_video_prompt_normalizer_keeps_camera_phrases_natural(self):
        prompt = server._normalize_tg_chinese_video_prompt_format(
            "\u5979\u9762\u5bf9\u955c\u5934\uff0c\u624b\u90e8\u5f00\u59cb\u52a8\u4f5c\uff0c"
            "\u753b\u9762\u6d41\u7545\u771f\u5b9e\u4e14\u8d28\u611f\u7ec6\u817b",
            {"duration_seconds": 5},
        )

        self.assertIn("\u9762\u5bf9\u955c\u5934", prompt)
        self.assertNotIn("\u9762\u5bf9\uff0c\u955c\u5934", prompt)
        self.assertNotIn("\u955c\u5934\u57fa\u672c\u4fdd\u6301\u7a33\u5b9a\uff0c\u955c\u5934", prompt)
        self.assertNotIn("\u624b\u90e8\uff0c\u5f00\u59cb\u52a8\u4f5c", prompt)
        self.assertNotIn("\u753b\u9762\uff0c\u6d41\u7545", prompt)
        self.assertNotIn("\u771f\u5b9e\uff0c\u4e14\u8d28\u611f", prompt)
        self.assertIn("\u955c\u5934\u57fa\u672c\u4fdd\u6301\u7a33\u5b9a", prompt)

    def test_tg_video_narrative_order_is_added_when_missing(self):
        prompt = server._ensure_tg_video_narrative_order(
            "\u5973\u6027\u4fdd\u6301\u53c2\u8003\u56fe\u59ff\u52bf\uff0c\u624b\u90e8\u5f00\u59cb\u52a8\u4f5c\uff0c"
            "\u8eab\u4f53\u4ea7\u751f\u81ea\u7136\u53cd\u5e94\uff0c\u58f0\u97f3\u548c\u8868\u60c5\u9010\u6e10\u53d8\u5316\uff0c"
            "\u955c\u5934\u57fa\u672c\u4fdd\u6301\u7a33\u5b9a\uff0c\u753b\u9762\u6d41\u7545\u771f\u5b9e"
        )

        self.assertTrue(server._tg_video_has_narrative_order(prompt))
        self.assertIn("\u753b\u9762\u5f00\u59cb\u65f6", prompt)
        self.assertIn("\u968f\u540e", prompt)
        self.assertIn("\u6700\u540e", prompt)

    def test_tg_video_prompt_rules_request_detailed_subject_and_action(self):
        system_prompt, prompt_chain = server._build_tg_prompt_system_prompt("video_i2v", "图生视频")
        user_prompt = server._build_tg_video_llm_user_input("人物动作", {"duration_seconds": 5})

        self.assertEqual("video", prompt_chain)
        self.assertIn("SUBJECT STYLING DETAIL IS MANDATORY", system_prompt)
        self.assertIn("SUBJECT AND ACTION DETAIL IS MANDATORY", system_prompt)
        self.assertIn("hairstyle", system_prompt)
        self.assertIn("makeup or facial expression", system_prompt)
        self.assertIn("body silhouette", system_prompt)
        self.assertIn("outfit styling", system_prompt)
        self.assertIn("fabric material", system_prompt)
        self.assertIn("garment color contrast", system_prompt)
        self.assertIn("visible posture", system_prompt)
        self.assertIn("hand/finger movement path", system_prompt)
        self.assertIn("controlled movement range", system_prompt)
        self.assertIn("Avoid aggressive sound wording", system_prompt)
        self.assertIn("动作缓慢连贯", system_prompt)
        self.assertIn("IMAGE-TO-VIDEO FIRST FRAME IS MANDATORY", system_prompt)
        self.assertIn("reference image is the first frame", system_prompt)
        self.assertIn("以参考图作为开始画面", system_prompt)
        self.assertIn("ENDING POSITIVE QUALITY CLAUSE IS MANDATORY", system_prompt)
        self.assertIn("260 to 520 Chinese characters", system_prompt)
        self.assertIn("no second-duration wording", system_prompt)
        self.assertIn("reference image is the FIRST FRAME", user_prompt)
        self.assertIn("say 参考图, not 用户上传的图片", user_prompt)
        self.assertIn("continuous, gradual process", user_prompt)
        self.assertIn("Describe sound as part of the process", user_prompt)
        self.assertIn("soft delicate breathing must be emphasized", user_prompt)
        self.assertIn("interwoven between action beats", user_prompt)
        self.assertIn("exposed body-part contact sounds", user_prompt)
        self.assertIn("light moist contact sounds", user_prompt)
        self.assertIn("subtle body-fluid friction sounds", user_prompt)
        self.assertIn("黏滑", user_prompt)
        self.assertIn("Keep background ambience weak and secondary", user_prompt)
        self.assertIn("End with positive visual quality constraints", user_prompt)
        self.assertIn("hairstyle", user_prompt)
        self.assertIn("makeup or facial expression", user_prompt)
        self.assertIn("body silhouette", user_prompt)
        self.assertIn("outfit styling", user_prompt)
        self.assertIn("fabric material", user_prompt)
        self.assertIn("color contrast", user_prompt)
        self.assertIn("visible body posture", user_prompt)
        self.assertIn("hand/finger path", user_prompt)
        self.assertIn("controlled movement range", user_prompt)

    def test_tg_video_i2v_constraints_complete_short_prompt(self):
        prompt = server._ensure_tg_video_i2v_prompt_constraints(
            "画面开始时人物坐在床边，随后按用户要求缓慢移动，最后表情放松",
            {"type": "video_i2v", "image_local_path": "data/input.jpg", "duration_seconds": 5},
        )

        self.assertIn("以参考图作为开始画面", prompt)
        self.assertNotIn("用户上传", prompt)
        self.assertIn("人物、姿势、构图、场景、光线和主体连续性", prompt)
        self.assertIn("缓慢移动", prompt)
        self.assertIn("轻缓细腻的呼吸声", prompt)
        self.assertIn("呼吸变得更贴近更轻柔", prompt)
        self.assertIn("暴露部位轻柔接触产生的湿润细响", prompt)
        self.assertIn("体液带来的细密黏滑摩擦声", prompt)
        self.assertIn("柔和轻响", prompt)
        self.assertIn("呼吸声穿插在每个动作停顿之间", prompt)
        self.assertIn("最后逐渐放缓并恢复平稳", prompt)
        self.assertIn("背景氛围声保持很弱", prompt)
        self.assertIn("画面清晰稳定", prompt)
        self.assertIn("动作连贯流畅", prompt)
        self.assertIn("主体一致", prompt)
        self.assertIn("身体结构稳定", prompt)

    def test_tg_video_i2v_constraints_rewrite_user_uploaded_wording(self):
        prompt = server._ensure_tg_video_i2v_prompt_constraints(
            "以用户上传的图片作为开始画面，画面开始时人物缓慢移动，随后动作轻柔延续，最后镜头稳定",
            {"type": "video_i2v", "image_local_path": "data/input.jpg", "duration_seconds": 5},
        )

        self.assertIn("以参考图作为开始画面", prompt)
        self.assertNotIn("用户上传", prompt)


if __name__ == "__main__":
    unittest.main()
