from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import telegram_admin
from webapp.digital_human_tg_bot import bot as tg_bot
from webapp.telegram_internal import inject_telegram_internal_routes


class TelegramClosedLoopTests(unittest.TestCase):
    def test_original_bot_keyboards_are_copied(self):
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        for label in (
            "數字人視頻生成",
            "廣告短視頻",
            "查看工作台狀態",
            "強制停止目前任務",
            "確認提交視頻生成",
            "重新生成",
            "添加字幕",
            "確認生成",
            "/api/internal/tg/submit",
            "_load_webapp_tg_status",
            "FROM tasks",
            "tg_chat_id",
        ):
            self.assertIn(label, source)

    def test_bot_reads_generation_records_by_chat_id(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "app.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            "CREATE TABLE tasks (id TEXT, user_id INTEGER, type TEXT, status TEXT, error TEXT, runninghub_task_id TEXT, input_json TEXT, output_json TEXT, created_at INTEGER, updated_at INTEGER)"
        )
        conn.execute(
            "CREATE TABLE task_events (kind TEXT, message TEXT, data_json TEXT, created_at INTEGER, task_id TEXT)"
        )
        conn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "task-1",
                1,
                "create_video",
                "success",
                "",
                "",
                '{"tg_chat_id": 6258005891, "source": "telegram"}',
                '{"download_path": "/tmp/out.mp4"}',
                1,
                1,
            ),
        )
        conn.execute(
            "INSERT INTO task_events VALUES (?,?,?,?,?)",
            ("done", "生成成功", "{}", 1, "task-1"),
        )
        conn.commit()
        conn.close()
        with mock.patch.dict(os.environ, {"WEBAPP_DB_PATH": str(db_path)}, clear=False):
            status = tg_bot._load_webapp_tg_status(6258005891)
        self.assertIsNotNone(status)
        self.assertEqual(status["latest"]["id"], "task-1")
        self.assertEqual(status["counts"].get("success"), 1)

    def test_internal_submit_enqueues_telegram_task(self):
        captured: dict[str, object] = {}

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _new_id(self, prefix: str) -> str:
                return f"{prefix}-1"

            def _apply_runtime_defaults(self, task_type, payload):
                return dict(payload)

            def _enqueue_task(self, task_id, user_id, task_type, payload):
                captured.update(
                    {"id": task_id, "user_id": user_id, "type": task_type, "payload": dict(payload)}
                )

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(value)

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _json_loads(self, value, default=None):
                return default

            def _now_ts(self):
                return 1

            def _insert_task_event(self, *args, **kwargs):
                return None

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _guess_file_kind(self, path_or_name):
                return "image"

            def _build_task_workdir(self, task_id, fallback_username=None):
                return Path(tempfile.gettempdir())

            def _get_runtime_config(self, conn):
                return {}

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        class Conn:
                            def execute(self, *args, **kwargs):
                                class Row(dict):
                                    def __getitem__(self, key):
                                        return 1

                                return self

                            def fetchone(self):
                                return {"id": 1}

                        return Conn()

                    def __exit__(self_inner, exc_type, exc, tb):
                        return False

                return Ctx()

        app = FastAPI()
        inject_telegram_internal_routes(app, FakeServer())
        client = TestClient(app)
        with mock.patch.dict(os.environ, {"TG_INTERNAL_API_TOKEN": "test-token"}, clear=False):
            response = client.post(
                "/api/internal/tg/submit",
                json={"task_type": "image_generate", "tg_chat_id": 6258005891, "params": {"mode": "scene_image", "prompt": "a studio"}},
                headers={"x-tg-internal-token": "test-token"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body.get("ok"))
        self.assertEqual(captured.get("type"), "image_generate")
        self.assertEqual(captured["payload"]["tg_chat_id"], 6258005891)
        self.assertEqual(captured["payload"]["source"], "telegram")

    def test_admin_still_has_telegram_settings(self):
        html = (Path(__file__).resolve().parents[1] / "static" / "admin.html").read_text(encoding="utf-8")
        self.assertIn("id=\"tgBotToken\"", html)
        self.assertIn("Telegram Bot", html)
        self.assertIn('data-page="telegram"', html)

    def test_agent_keyword_maps_to_production_task(self):
        from webapp.telegram_agent import build_agent_task_payload

        class FakeServer:
            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        return object()
                    def __exit__(self_inner, exc_type, exc, tb):
                        return False
                return Ctx()

            def _get_runtime_config(self, conn):
                return {}

            def _resolve_llm_fallback_candidates(self, runtime, allow_builtin=True):
                return "", []

            def _request_llm_json_with_fallback(self, **kwargs):
                raise RuntimeError("llm unavailable")

        from webapp import telegram_agent
        telegram_agent.bind_server(FakeServer())
        typ, payload, summary = build_agent_task_payload(
            message="做广告短视频",
            file_infos=[{"name": "p.jpg", "path": "/tmp/p.jpg", "kind": "image"}],
            use_ai_copy=True,
            default_duration=15,
            production_only=True,
        )
        self.assertEqual(typ, "ecommerce_short_video")
        self.assertEqual(payload.get("product_image_local_path"), "/tmp/p.jpg")
        self.assertTrue(payload.get("tg_use_llm_prompt"))
        self.assertIn("广告短视频", summary)

    def test_union_payload_keeps_local_media_paths(self):
        from webapp.telegram_internal import _bind_server, _build_internal_tg_task_payload

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        video = root / "src.mp4"
        model = root / "model.jpg"
        product = root / "product.jpg"
        for path in (video, model, product):
            path.write_bytes(b"x")

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(Path(value).resolve())

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _build_task_workdir(self, task_id, fallback_username=None):
                work = root / "work"
                work.mkdir(exist_ok=True)
                return work

        _bind_server(FakeServer())
        payload = _build_internal_tg_task_payload(
            "task-union",
            "replace_productANDmodel",
            {
                "video_local_path": str(video),
                "model_image_local_path": str(model),
                "product_image_local_path": str(product),
            },
        )
        self.assertTrue(Path(payload["video_local_path"]).is_file())
        self.assertTrue(Path(payload["model_image_local_path"]).is_file())
        self.assertTrue(Path(payload["product_image_local_path"]).is_file())

    def test_union_replace_resolves_from_web_module(self):
        from webapp import video_workbench
        task_type, payload = video_workbench.resolve_video_ui_task("video_subject_replace", {"replace_mode": "union", "subject_kind": "union"})
        self.assertEqual(task_type, "replace_productANDmodel")

    def test_image_generate_payload_keeps_video_image_mode(self):
        from video_core.source_backend import ArchivedSourceBackend
        from webapp import video_workbench
        from webapp.telegram_internal import _bind_server, _build_internal_tg_task_payload

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        product = Path(tmp.name) / "product.jpg"
        product.write_bytes(b"x")

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(Path(value).resolve())

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _get_runtime_config(self, conn):
                return {}

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        class Conn:
                            def execute(self, *args, **kwargs):
                                return self

                            def fetchone(self):
                                return {}

                        return Conn()

                    def __exit__(self_inner, exc_type, exc, tb):
                        return False

                return Ctx()

        _bind_server(FakeServer())
        for mode in ("three_view", "product_only", "poster_translate"):
            payload = _build_internal_tg_task_payload(
                f"task-{mode}",
                "image_generate",
                {
                    "mode": mode,
                    "product_image_local_path": str(product),
                    "target_language": "English",
                },
            )
            self.assertEqual(payload["video_image_mode"], mode, mode)
            merged = video_workbench.apply_video_runtime_defaults("image_generate", payload, {})
            smashed_mode = str(merged.get("mode") or "single_reference").strip() or "single_reference"
            if smashed_mode not in {"single_reference", "dual_reference"}:
                smashed_mode = "single_reference"
            merged["mode"] = smashed_mode
            self.assertEqual(ArchivedSourceBackend._image_generate_mode(merged), mode)

    def test_rerun_command_uses_internal_webapp_path(self):
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        self.assertIn("await rerun_latest_webapp_or_local_task(message)", source)
        self.assertNotIn("await enqueue_request(message, request, source=\"telegram-rerun\"", source)

    def test_bot_guided_revision_hooks_match_source(self):
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        self.assertIn("ECOMMERCE_GUIDED_REVISION_BUTTON", source)
        self.assertIn("waiting_for_digital_human_script_guided_revision", source)
        self.assertIn("ecommerce_waiting_for_prompt_guided_revision", source)
        self.assertIn('step="script_guided_revision"', source)
        self.assertEqual(source.count("if text in ECOMMERCE_GUIDED_REVISION_TEXTS:"), 3)

    def test_script_guided_revision_uses_source_revise_helper(self):
        from webapp.telegram_internal import _bind_server, _run_digital_human_tg_step

        captured = {}

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _new_id(self, prefix):
                return f"{prefix}-1"

            def _apply_runtime_defaults(self, task_type, payload):
                return dict(payload)

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(value)

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _revise_digital_human_short_script_with_llm(self, payload, **kwargs):
                captured.update(kwargs)
                captured["payload"] = dict(payload)
                return "revised speech", {"ok": True}

            def _get_runtime_config(self, conn):
                return {}

            def _build_task_workdir(self, task_id, fallback_username=None):
                return Path(tempfile.gettempdir())

        _bind_server(FakeServer())
        result = _run_digital_human_tg_step(
            "script_guided_revision",
            {
                "speech_text": "original speech",
                "revision_instruction": "更口语",
                "model_image_local_path": "/tmp/model.jpg",
                "product_image_local_path": "/tmp/product.jpg",
            },
        )
        self.assertEqual(result["step"], "script_guided_revision")
        self.assertEqual(result["speech_text"], "revised speech")
        self.assertEqual(captured.get("current_script"), "original speech")
        self.assertEqual(captured.get("revision_instruction"), "更口语")

    def test_ecommerce_preview_keeps_revision_draft(self):
        from webapp.telegram_internal import _bind_server, _build_internal_tg_ecommerce_prompt_preview_payload

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _new_id(self, prefix):
                return f"{prefix}-1"

            def _apply_runtime_defaults(self, task_type, payload):
                payload = dict(payload)
                if not payload.get("prompt"):
                    payload["prompt"] = payload.get("tg_user_instruction") or "generated"
                return payload

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(value)

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _get_runtime_config(self, conn):
                return {}

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        class Conn:
                            def execute(self, *args, **kwargs):
                                return self

                            def fetchone(self):
                                return {}

                        return Conn()

                    def __exit__(self_inner, exc_type, exc, tb):
                        return False

                return Ctx()

        _bind_server(FakeServer())
        payload = _build_internal_tg_ecommerce_prompt_preview_payload(
            {
                "product_image_local_path": "/tmp/p.jpg",
                "ecommerce_current_prompt": "old prompt",
                "ecommerce_revision_instruction": "开场更抓人",
                "tg_user_instruction": "根据图片生成广告",
            }
        )
        instruction = payload.get("tg_user_instruction") or ""
        self.assertIn("old prompt", instruction)
        self.assertIn("开场更抓人", instruction)


if __name__ == "__main__":
    unittest.main()
