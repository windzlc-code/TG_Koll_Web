from __future__ import annotations

import asyncio
import io
import json
import sqlite3
import threading
import tempfile
import unittest
from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace
from pathlib import Path

from fastapi import FastAPI, HTTPException
from starlette.datastructures import UploadFile

from video_core import ArchivedSourceBackend, VideoTaskCancelled, VideoTaskContext
from webapp import video_workbench


class VideoWorkbenchTests(unittest.TestCase):
    @staticmethod
    def _route_endpoint(app: FastAPI, path: str, method: str):
        for route in app.router.routes:
            if getattr(route, "path", None) == path and method.upper() in getattr(route, "methods", set()):
                return route.endpoint
        raise AssertionError(f"route not found: {method} {path}")

    @staticmethod
    def _workflow_dependencies(db_path: Path, enqueued: list, events: list):
        @contextmanager
        def db_factory():
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

        def ensure_task_access(user, task):
            if int(user["id"]) != int(task["user_id"]):
                raise HTTPException(status_code=404, detail="Task not found")

        def enqueue_task(task_id, user_id, task_type, payload, user):
            enqueued.append({
                "id": task_id,
                "user_id": user_id,
                "task_type": task_type,
                "payload": payload,
                "user": user,
            })

        return video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "tester"},
            enqueue_task=enqueue_task,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: f"task-child-{len(enqueued) + 1}",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
            db_factory=db_factory,
            ensure_task_access=ensure_task_access,
            json_loads=lambda value, default: json.loads(value) if value else default,
            json_dumps=lambda value: json.dumps(value, ensure_ascii=False),
            now_ts=lambda: 1_700_000_000,
            emit_task_event=lambda **kwargs: events.append(kwargs),
        )

    @staticmethod
    def _create_task_db(db_path: Path):
        conn = sqlite3.connect(db_path)
        try:
            conn.execute(
                """
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    input_json TEXT,
                    output_json TEXT,
                    updated_at INTEGER
                )
                """
            )
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _insert_task(
        db_path: Path,
        *,
        task_id: str,
        user_id: int = 1,
        task_type: str = "ecommerce_short_video",
        status: str = "success",
        input_payload: dict | None = None,
        output_payload: dict | None = None,
    ):
        conn = sqlite3.connect(db_path)
        try:
            conn.execute(
                "INSERT INTO tasks(id, user_id, type, status, input_json, output_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    task_id,
                    user_id,
                    task_type,
                    status,
                    json.dumps(input_payload or {}, ensure_ascii=False),
                    json.dumps(output_payload or {}, ensure_ascii=False),
                    1,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def test_module_exports_all_requested_task_types(self):
        expected = {
            "create_video",
            "ecommerce_short_video",
            "video_language_replace",
            "replace_model",
            "replace_product",
            "image_generate",
        }
        self.assertEqual(set(video_workbench.VIDEO_TASK_RUNNERS), expected)
        self.assertEqual(set(video_workbench.VIDEO_MODULE_METADATA), expected)
        self.assertFalse(video_workbench.MODULE_METADATA["queue_managed"])
        self.assertNotIn("telegram", video_workbench.__dict__)

    def test_task_types_map_back_to_all_eight_workbench_modules(self):
        cases = {
            ("create_video", ""): "digital_human_video",
            ("ecommerce_short_video", ""): "ecommerce_short_video",
            ("video_language_replace", ""): "video_language_replace",
            ("replace_model", ""): "video_subject_replace",
            ("replace_product", ""): "video_subject_replace",
            ("image_generate", "product_only"): "ecommerce_image",
            ("image_generate", "model_product"): "ecommerce_image",
            ("image_generate", "subject_replace"): "subject_replace",
            ("image_generate", "poster_translate"): "poster_translate",
            ("image_generate", "digital_human_character"): "subject_generate",
            ("image_generate", "three_view"): "subject_generate",
        }
        for (task_type, mode), expected in cases.items():
            with self.subTest(task_type=task_type, mode=mode):
                payload = {"video_image_mode": mode} if mode else {}
                self.assertEqual(video_workbench.video_ui_module_for_task(task_type, payload), expected)

    def test_explicit_workbench_module_wins_for_persisted_task_routing(self):
        self.assertEqual(
            video_workbench.video_ui_module_for_task(
                "image_generate",
                {"_video_module_id": "poster_translate", "video_image_mode": "single_reference"},
            ),
            "poster_translate",
        )

    def test_runner_preserves_source_fields_and_normalizes_result_shape(self):
        calls = []

        def backend(task_type, task_id, payload, context):
            calls.append((task_type, task_id, payload["prompt"], context.cancelled()))
            return {
                "status": "success",
                "taskId": "rh-123",
                "video_path": "output.mp4",
                "runninghub_usage": {"consumeCoins": 3},
                "source_specific": "kept",
            }

        runner = video_workbench.make_video_task_runners(backend)["create_video"]
        result = runner("task-1", {"prompt": "hello"})

        self.assertEqual(calls, [("create_video", "task-1", "hello", False)])
        self.assertTrue(result["ok"])
        self.assertEqual(result["runninghub_task_id"], "rh-123")
        self.assertEqual(result["runninghub_task_ids"], ["rh-123"])
        self.assertEqual(result["source_specific"], "kept")
        self.assertIn("raw_result", result)
        self.assertIn("warnings", result)

    def test_cancel_event_stops_runner_before_backend(self):
        called = False

        def backend(task_id, payload):
            nonlocal called
            called = True
            return {"ok": True}

        event = threading.Event()
        event.set()
        runner = video_workbench.make_video_task_runners(backend)["replace_model"]
        with self.assertRaises(VideoTaskCancelled):
            runner("task-cancelled", {"_cancel_event": event})
        self.assertFalse(called)

    def test_bound_cancel_event_is_used_and_released(self):
        event = threading.Event()
        video_workbench.bind_video_cancel_event("task-bound", event)
        self.assertTrue(video_workbench.request_video_cancel("task-bound"))
        runner = video_workbench.make_video_task_runners(lambda task_id, payload: {"ok": True})["replace_product"]
        with self.assertRaises(VideoTaskCancelled):
            runner("task-bound", {})
        video_workbench.release_video_cancel_event("task-bound", event)
        self.assertFalse(video_workbench.request_video_cancel("task-bound"))

    def test_runtime_defaults_preserve_explicit_values_and_copy_lists(self):
        runtime = {
            "runninghub_api_key": "runtime-secret",
            "ecommerce_short_video_workflow_ids": ["custom-workflow"],
            "ecommerce_short_video_duration": 12,
        }
        merged = video_workbench.apply_video_runtime_defaults(
            "ecommerce_short_video",
            {"ratio": "16:9", "resolution": "1080p"},
            runtime,
        )
        self.assertEqual(merged["runninghub_api_key"], "runtime-secret")
        self.assertEqual(merged["ecommerce_short_video_workflow_ids"], ["custom-workflow"])
        self.assertEqual(merged["duration"], 12)
        self.assertEqual(merged["ratio"], "16:9")
        self.assertEqual(merged["resolution"], "1080p")
        self.assertTrue(merged["_ecommerce_seeding_dynamic_enabled"])
        merged["ecommerce_short_video_workflow_ids"].append("mutated")
        self.assertEqual(runtime["ecommerce_short_video_workflow_ids"], ["custom-workflow"])
        self.assertEqual(video_workbench.VIDEO_RUNTIME_CONFIG_DEFAULTS["video_tts_provider"], "minimax")
        self.assertIn("video_runninghub_api_key", video_workbench.VIDEO_RUNTIME_CONFIG_DEFAULTS)
        digital_human_runtime = video_workbench.apply_video_runtime_defaults("create_video", {}, {})
        self.assertEqual(digital_human_runtime["_digital_human_view_retry_count"], 2)

    def test_billing_spec_and_actual_quantity(self):
        self.assertEqual(
            video_workbench.video_task_billing_spec(
                "ecommerce_short_video",
                {"duration": 6.2, "resolution": "1080p", "ecommerce_short_video_model": "seedance2.0fast"},
            ),
            ("seedance_fast_1080p_second", 7, False),
        )
        self.assertEqual(
            video_workbench.video_task_billing_spec("replace_model", {"source_video_duration_seconds": 8.1}),
            ("video_model_replace_second", 9, False),
        )
        self.assertEqual(
            video_workbench.video_billing_actual_quantity(
                "video_language_replace",
                {"ok": True, "raw_result": {"source_duration_seconds": 11.2}},
                {"duration": 20},
            ),
            12,
        )
        self.assertEqual(
            video_workbench.video_billing_actual_quantity("replace_product", {"ok": False}, {"duration": 20}),
            0,
        )
        self.assertEqual(
            video_workbench.video_task_billing_spec("image_generate", {"video_image_mode": "poster_translate", "count": 2}),
            ("poster_translate_image", 2, True),
        )
        self.assertEqual(
            video_workbench.video_task_billing_spec(
                "ecommerce_short_video",
                {"ecommerce_video_mode": "seeding_video", "storyboard": [{}, {}, {}, {}]},
            ),
            ("ecommerce_seeding_image", 4, True),
        )
        self.assertEqual(
            video_workbench.video_task_billing_spec(
                "video_language_replace",
                {
                    "duration_seconds": 20,
                    "resume": True,
                    "video_workbench_action": "resume",
                    "completed_segments": [
                        {"start_seconds": 0, "end_seconds": 6},
                        {"duration_seconds": 5.2},
                    ],
                },
            ),
            ("video_language_replace_second", 9, False),
        )
        self.assertEqual(
            video_workbench.video_task_billing_spec(
                "create_video",
                {"duration_seconds": 20, "video_workbench_action": "segment_regenerate", "segment": {"duration_seconds": 3.1}},
            ),
            ("oral_video_second", 4, False),
        )
        self.assertEqual(
            video_workbench.video_billing_actual_quantity(
                "create_video",
                {"ok": True, "raw_result": {"duration_seconds": 20}},
                {"video_workbench_action": "segment_regenerate", "segment": {"duration_seconds": 3.1}},
            ),
            4,
        )

    def test_all_eight_ui_modules_resolve_to_queue_task_types(self):
        resolved = {
            key: video_workbench.resolve_video_ui_task(key, {})[0]
            for key in video_workbench.VIDEO_UI_MODULE_TASKS
        }
        self.assertEqual(len(resolved), 8)
        self.assertEqual(resolved["digital_human_video"], "create_video")
        self.assertEqual(resolved["video_subject_replace"], "replace_model")
        product_type, _ = video_workbench.resolve_video_ui_task("video_subject_replace", {"subject_kind": "product"})
        self.assertEqual(product_type, "replace_product")
        image_type, image_payload = video_workbench.resolve_video_ui_task("poster_translate", {})
        self.assertEqual(image_type, "image_generate")
        self.assertEqual(image_payload["video_image_mode"], "poster_translate")

    def test_injection_preserves_existing_runner_and_does_not_touch_queue(self):
        existing_image_runner = lambda task_id, payload: {"ok": True, "source": "existing"}
        server = SimpleNamespace(
            TASK_RUNNERS={"image_generate": existing_image_runner},
            DEFAULT_RUNTIME_CONFIG={},
            _NORMAL_TASK_CONTROLS={},
            _NORMAL_TASK_CONTROLS_LOCK=threading.RLock(),
            _apply_runtime_defaults=lambda task_type, payload: dict(payload),
            _normal_task_billing_spec=lambda task_type, payload: ("ai_image", 1, True) if task_type == "image_generate" else None,
            _billing_actual_quantity=lambda task_type, output, payload: 1 if task_type == "image_generate" else 0,
        )
        result = video_workbench.inject_video_workbench(
            server,
            backend=lambda task_type, task_id, payload: {"ok": True, "duration_seconds": 3},
        )

        self.assertEqual(server.TASK_RUNNERS["image_generate"]("regular", {})["source"], "existing")
        self.assertTrue(server.TASK_RUNNERS["image_generate"]("video", {"source": "video_workbench_api"})["ok"])
        self.assertIn("create_video", server.TASK_RUNNERS)
        self.assertFalse(result["queue_touched"])
        self.assertFalse(hasattr(server, "_TASK_QUEUE"))
        self.assertEqual(server._normal_task_billing_spec("replace_product", {"duration": 4}), ("video_product_replace_second", 4, False))
        self.assertEqual(server._billing_actual_quantity("replace_product", {"ok": True, "duration_seconds": 3}, {}), 3)

    def test_injected_runner_persists_provider_checkpoint_for_restart_recovery(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "tasks.sqlite"
            self._create_task_db(db_path)
            self._insert_task(db_path, task_id="task-provider", status="running")

            @contextmanager
            def db_factory():
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                try:
                    yield conn
                    conn.commit()
                finally:
                    conn.close()

            def backend(task_type, task_id, payload):
                payload["_register_runninghub_task"](
                    task_id=task_id,
                    runninghub_task_id="rh-recover-1",
                )
                payload["_checkpoint_video_progress"](
                    task_id=task_id,
                    completed_segment={
                        "index": 1,
                        "path": "C:/outputs/segment-1.mp4",
                        "runninghub_task_id": "rh-recover-1",
                    },
                )
                return {"ok": True, "runninghub_task_id": "rh-recover-1"}

            server = SimpleNamespace(
                TASK_RUNNERS={},
                DEFAULT_RUNTIME_CONFIG={},
                _NORMAL_TASK_CONTROLS={},
                _NORMAL_TASK_CONTROLS_LOCK=threading.RLock(),
                _apply_runtime_defaults=lambda task_type, payload: dict(payload),
                _normal_task_billing_spec=lambda task_type, payload: None,
                _billing_actual_quantity=lambda task_type, output, payload: 0,
                db=db_factory,
                _json_loads=lambda value, default: json.loads(value) if value else default,
                _json_dumps=lambda value: json.dumps(value, ensure_ascii=False),
                _now_ts=lambda: 1_700_000_100,
            )
            video_workbench.inject_video_workbench(server, backend=backend)
            result = server.TASK_RUNNERS["create_video"]("task-provider", {})
            self.assertTrue(result["ok"])

            conn = sqlite3.connect(db_path)
            try:
                output = json.loads(conn.execute(
                    "SELECT output_json FROM tasks WHERE id = ?", ("task-provider",)
                ).fetchone()[0])
            finally:
                conn.close()
            checkpoint = output["video_checkpoint"]
            self.assertTrue(checkpoint["recoverable"])
            self.assertEqual(checkpoint["runninghub_task_id"], "rh-recover-1")
            self.assertEqual(checkpoint["runninghub_task_ids"], ["rh-recover-1"])
            self.assertEqual(checkpoint["completed_segments"][0]["index"], 1)
            self.assertEqual(output["completed_segments"], checkpoint["completed_segments"])

    def test_injected_language_transcriber_uses_media_llm_without_provider_video_submission(self):
        calls = []

        def llm_json_request(**kwargs):
            calls.append(kwargs)
            return (
                {
                    "parsed": {
                        "source_language": "Chinese",
                        "source_script": "你好",
                        "target_script": "Hello",
                        "segments": [{
                            "start_seconds": 0,
                            "end_seconds": 1.2,
                            "source_text": "你好",
                            "text": "Hello",
                        }],
                    }
                },
                {"provider": "fake", "model": "fake-media-model", "api_key": "must-not-leak"},
                [{"ok": True}],
            )

        def backend(task_type, task_id, payload):
            result = payload["_video_language_transcribe_translate"](
                video_path="C:/uploads/source.mp4",
                source_language="Chinese",
                target_language="English",
                source_duration=2,
                payload=payload,
            )
            return {"ok": True, "raw_result": result}

        server = SimpleNamespace(
            TASK_RUNNERS={},
            DEFAULT_RUNTIME_CONFIG={},
            _NORMAL_TASK_CONTROLS={},
            _NORMAL_TASK_CONTROLS_LOCK=threading.RLock(),
            _apply_runtime_defaults=lambda task_type, payload: dict(payload),
            _normal_task_billing_spec=lambda task_type, payload: None,
            _billing_actual_quantity=lambda task_type, output, payload: 0,
            _request_llm_json_with_fallback=llm_json_request,
        )
        video_workbench.inject_video_workbench(server, backend=backend)
        result = server.TASK_RUNNERS["video_language_replace"]("task-language-auto", {
            "script_text": "你好",
            "opening_insert_text": "欢迎",
            "ending_insert_text": "再见",
            "video_language_source_segments": [{"start_seconds": 0, "end_seconds": 1.2, "source_text": "你好"}],
        })
        self.assertTrue(result["ok"])
        self.assertEqual(result["raw_result"]["target_script"], "Hello")
        self.assertEqual(result["raw_result"]["segments"][0]["source_text"], "你好")
        self.assertNotIn("api_key", result["raw_result"]["transcription"]["selected"])
        self.assertEqual(calls[0]["video_paths"], [str(Path("C:/uploads/source.mp4").resolve())])
        self.assertEqual(calls[0]["retry_count"], 2)
        self.assertIn("Use this supplied source transcript exactly", calls[0]["user_input"])
        self.assertIn("Use these supplied source time segments", calls[0]["user_input"])
        self.assertIn("Translate and insert this opening line", calls[0]["user_input"])
        self.assertIn("Translate and append this ending line", calls[0]["user_input"])

    def test_injected_digital_human_copy_uses_supplied_references_and_duration(self):
        calls = []

        def llm_json_request(**kwargs):
            calls.append(kwargs)
            return (
                {"parsed": {"speech_text": "A complete spoken script.", "segment_scripts": []}},
                {"provider": "fake", "model": "fake-text-model"},
                [{"ok": True}],
            )

        def backend(task_type, task_id, payload):
            result = payload["_digital_human_ai_copy_provider"](
                payload=payload,
                mode="single",
                model_references=[payload["model_image_local_path"]],
                product_references=[payload["product_image_local_path"]],
            )
            return {"ok": True, "raw_result": result}

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = root / "model.png"
            product = root / "product.png"
            model.write_bytes(b"model")
            product.write_bytes(b"product")
            server = SimpleNamespace(
                TASK_RUNNERS={},
                DEFAULT_RUNTIME_CONFIG={},
                _NORMAL_TASK_CONTROLS={},
                _NORMAL_TASK_CONTROLS_LOCK=threading.RLock(),
                _apply_runtime_defaults=lambda task_type, payload: dict(payload),
                _normal_task_billing_spec=lambda task_type, payload: None,
                _billing_actual_quantity=lambda task_type, output, payload: 0,
                _request_llm_json_with_fallback=llm_json_request,
            )
            video_workbench.inject_video_workbench(server, backend=backend)
            result = server.TASK_RUNNERS["create_video"]("task-ai-copy", {
                "model_image_local_path": str(model),
                "product_image_local_path": str(product),
                "target_language": "English",
                "oral_target_duration_seconds": 30,
            })

        self.assertTrue(result["ok"])
        self.assertEqual(calls[0]["image_paths"], [str(model), str(product)])
        self.assertIn("30 seconds", calls[0]["system_prompt"])
        self.assertIn("66 to 84 English words", calls[0]["system_prompt"])

    def test_oral_hot_topic_mode_uses_source_search_and_off_mode_skips_it(self):
        calls: list[dict] = []

        class Response:
            text = (
                '<a class="result__a" href="https://news.example/item">AI 工具本周趋势</a>'
                '<a class="result__snippet">近期用户讨论集中在自动化工作流。</a>'
            )

            @staticmethod
            def raise_for_status():
                return None

        def http_get(*args, **kwargs):
            calls.append({"args": args, "kwargs": kwargs})
            return Response()

        research = video_workbench._digital_human_oral_hot_topic_research(
            "AI 工具干货",
            "面向职场用户介绍自动化工作流",
            mode="soft",
            http_get=http_get,
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(research["mode"], "soft")
        self.assertEqual(research["results"][0]["title"], "AI 工具本周趋势")
        disabled = video_workbench._digital_human_oral_hot_topic_research(
            "AI 工具干货",
            "自动化工作流",
            mode="off",
            http_get=lambda *args, **kwargs: self.fail("off mode must not search"),
        )
        self.assertEqual(disabled["attempted_queries"], [])

    def test_submit_payload_maps_uploads_and_rejects_local_path_injection(self):
        payload = video_workbench.build_video_submit_payload(
            "replace_model",
            {"prompt": "keep motion"},
            [
                {"name": "source.mp4", "path": "C:/uploads/source.mp4", "kind": "video"},
                {"name": "person.png", "path": "C:/uploads/person.png", "kind": "image"},
            ],
        )
        self.assertEqual(payload["video_local_path"], "C:/uploads/source.mp4")
        self.assertEqual(payload["model_image_local_path"], "C:/uploads/person.png")
        with self.assertRaisesRegex(ValueError, "本地路径"):
            video_workbench.build_video_submit_payload(
                "replace_product",
                {"video_local_path": "C:/Windows/win.ini"},
                [],
            )

    def test_original_frontend_upload_roles_map_without_exposing_path_fields(self):
        digital_human = video_workbench.build_video_submit_payload(
            "create_video",
            {"speech_text": "hello", "file_roles": ["model", "product", "audio"]},
            [
                {"name": "person.png", "path": "C:/uploads/person.png", "kind": "image"},
                {"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"},
                {"name": "voice.wav", "path": "C:/uploads/voice.wav", "kind": "audio"},
            ],
        )
        self.assertEqual(digital_human["model_image_local_path"], "C:/uploads/person.png")
        self.assertEqual(digital_human["product_image_local_path"], "C:/uploads/product.png")
        self.assertEqual(digital_human["audio_local_path"], "C:/uploads/voice.wav")

        subject_replace = video_workbench.build_video_submit_payload(
            "image_generate",
            {
                "video_image_mode": "subject_replace",
                "file_roles": ["original", "replacement_product"],
            },
            [
                {"name": "original.png", "path": "C:/uploads/original.png", "kind": "image"},
                {"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"},
            ],
        )
        self.assertEqual(subject_replace["source_image_local_path"], "C:/uploads/original.png")
        self.assertEqual(subject_replace["subject_image_local_path"], "C:/uploads/product.png")

        subject_replace_both = video_workbench.build_video_submit_payload(
            "image_generate",
            {
                "video_image_mode": "subject_replace",
                "file_roles": ["original", "replacement_product", "replacement_model"],
            },
            [
                {"name": "original.png", "path": "C:/uploads/original.png", "kind": "image"},
                {"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"},
                {"name": "model.png", "path": "C:/uploads/model.png", "kind": "image"},
            ],
        )
        self.assertEqual(subject_replace_both["replacement_product_image_local_path"], "C:/uploads/product.png")
        self.assertEqual(subject_replace_both["replacement_model_image_local_path"], "C:/uploads/model.png")

    def test_language_replace_can_auto_transcribe_when_target_script_is_blank(self):
        payload = video_workbench.build_video_submit_payload(
            "video_language_replace",
            {"target_language": "English", "file_roles": ["video_file"]},
            [{"name": "source.mp4", "path": "C:/uploads/source.mp4", "kind": "video"}],
        )
        self.assertEqual(payload["video_local_path"], "C:/uploads/source.mp4")
        self.assertTrue(payload["auto_transcribe_translate"])

        with self.assertRaisesRegex(ValueError, "目标语言"):
            video_workbench.build_video_submit_payload(
                "video_language_replace",
                {"file_roles": ["video_file"]},
                [{"name": "source.mp4", "path": "C:/uploads/source.mp4", "kind": "video"}],
            )

    def test_image_submit_payload_maps_mode_specific_roles(self):
        poster = video_workbench.build_video_submit_payload(
            "image_generate",
            {
                "video_image_mode": "poster_translate",
                "target_language": "Chinese",
                "file_roles": ["poster_image"],
            },
            [{"name": "poster.png", "path": "C:/uploads/poster.png", "kind": "image"}],
        )
        self.assertEqual(poster["poster_image_local_path"], "C:/uploads/poster.png")
        self.assertEqual(poster["count"], 1)
        self.assertNotIn("prompt", poster)

        replaced = video_workbench.build_video_submit_payload(
            "image_generate",
            {
                "video_image_mode": "subject_replace",
                "file_roles": ["source_image", "subject_image"],
            },
            [
                {"name": "source.png", "path": "C:/uploads/source.png", "kind": "image"},
                {"name": "subject.png", "path": "C:/uploads/subject.png", "kind": "image"},
            ],
        )
        self.assertEqual(replaced["source_image_local_path"], "C:/uploads/source.png")
        self.assertEqual(replaced["subject_image_local_path"], "C:/uploads/subject.png")
        self.assertTrue(replaced["prompt"])

        model_product = video_workbench.build_video_submit_payload(
            "image_generate",
            {
                "video_image_mode": "model_product",
                "prompt": "catalog image",
                "file_roles": ["product_image", "model_image"],
            },
            [
                {"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"},
                {"name": "model.png", "path": "C:/uploads/model.png", "kind": "image"},
            ],
        )
        self.assertEqual(model_product["product_image_local_path"], "C:/uploads/product.png")
        self.assertEqual(model_product["model_image_local_path"], "C:/uploads/model.png")

        with self.assertRaisesRegex(ValueError, "both product and model"):
            video_workbench.build_video_submit_payload(
                "image_generate",
                {"video_image_mode": "model_product", "prompt": "catalog image", "file_roles": ["product_image"]},
                [{"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"}],
            )
        with self.assertRaisesRegex(ValueError, "between 1 and 8"):
            video_workbench.build_video_submit_payload(
                "image_generate",
                {"video_image_mode": "digital_human_character", "prompt": "person", "count": 9},
                [],
            )

    def test_register_video_routes_exposes_all_task_endpoints(self):
        app = FastAPI()
        dependencies = video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "tester"},
            enqueue_task=lambda *args: None,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "task-route",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
        )
        result = video_workbench.register_video_routes(app, dependencies)
        paths = {route.path for route in app.router.routes}
        self.assertGreaterEqual(len(result["registered_paths"]), 8)
        self.assertIn("/api/video/modules", paths)
        self.assertIn("/api/video/tasks", paths)
        self.assertIn("/api/video/prompt-preview", paths)
        self.assertIn("/api/video/prompt-preview/recover", paths)
        self.assertIn("/api/video/voice-presets", paths)
        self.assertIn("/api/video/voice-preview", paths)
        self.assertIn("/api/video/tasks/{task_id}/storyboard", paths)
        self.assertIn("/api/video/tasks/{task_id}/storyboard/regenerate", paths)
        self.assertIn("/api/video/tasks/{task_id}/subtitles", paths)
        self.assertIn("/api/video/tasks/{task_id}/segments/{segment_index}/regenerate", paths)
        self.assertIn("/api/video/tasks/{task_id}/resume", paths)
        self.assertIn("/api/video/language-script/parse", paths)
        self.assertIn("/api/video/language-script/analyze", paths)
        self.assertIn("/api/tasks/video_language_replace/script", paths)
        self.assertIn("/api/video/tasks/{task_id}/digital-human/finalize", paths)
        self.assertIn("/api/video/tasks/{task_id}/seeding/finalize", paths)
        self.assertIn("/api/video/tasks/{task_id}/seeding-images/{scene_index}/regenerate", paths)
        self.assertIn("/api/video/tasks/{task_id}/seeding-images/{scene_index}/upload", paths)
        self.assertIn("/api/video/tasks/{task_id}/seeding-images/{scene_index}/history", paths)
        self.assertIn("/api/video/tasks/{task_id}/seeding-images/{scene_index}/use", paths)
        self.assertIn("/api/video/tasks/{task_id}/digital-human/assets/{asset_index}/history", paths)
        self.assertIn("/api/video/tasks/{task_id}/digital-human/assets/{asset_index}/use", paths)
        for task_type in video_workbench.VIDEO_TASK_RUNNERS:
            self.assertIn(f"/api/video/{task_type}", paths)

    def test_prompt_preview_preserves_candidates_and_hidden_ecommerce_analysis(self):
        app = FastAPI()
        dependencies = video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "tester"},
            enqueue_task=lambda *args: None,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "task-preview",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
            generate_prompt_preview=lambda **kwargs: {
                "speech_text": "selected copy",
                "prompt_text": "director prompt",
                "speech_candidates": [{"title": "A", "speech_text": "selected copy"}],
                "selected_speech_candidate_index": 0,
                "ecommerce_material_analysis": {"usable_image_indexes": [1]},
                "ecommerce_creative_brief": {"ontology": {"primary_subject": "product"}},
                "ecommerce_segments": [{"duration": 15, "shots": []}],
            },
        )
        video_workbench.register_video_routes(app, dependencies)
        endpoint = self._route_endpoint(app, "/api/video/prompt-preview", "POST")
        result = asyncio.run(
            endpoint(
                module="ecommerce_short_video",
                params_json=json.dumps({"prompt_text": "make an ad"}),
                files=None,
                user={"id": 1, "username": "tester"},
            )
        )
        self.assertEqual(result["speech_candidates"][0]["title"], "A")
        self.assertEqual(result["ecommerce_material_analysis"]["usable_image_indexes"], [1])
        self.assertEqual(result["ecommerce_creative_brief"]["ontology"]["primary_subject"], "product")

    def test_prompt_preview_nonce_can_recover_completed_result_without_second_provider_call(self):
        calls: list[dict] = []

        def generate(**kwargs):
            calls.append(kwargs)
            return {"prompt_text": "recovered prompt", "speech_text": "recovered speech"}

        app = FastAPI()
        dependencies = video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "tester"},
            enqueue_task=lambda *args: None,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "task-preview-recovery",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
            generate_prompt_preview=generate,
        )
        video_workbench.register_video_routes(app, dependencies)
        preview = self._route_endpoint(app, "/api/video/prompt-preview", "POST")
        recover = self._route_endpoint(app, "/api/video/prompt-preview/recover", "GET")
        user = {"id": 1, "username": "tester"}

        first = asyncio.run(preview(
            module="digital_human_video",
            params_json=json.dumps({"prompt_text": "source"}),
            request_nonce="nonce-preview-1",
            files=None,
            user=user,
        ))
        recovered = asyncio.run(recover(request_nonce="nonce-preview-1", user=user))
        repeated = asyncio.run(preview(
            module="digital_human_video",
            params_json=json.dumps({"prompt_text": "source"}),
            request_nonce="nonce-preview-1",
            files=None,
            user=user,
        ))

        self.assertEqual(first, recovered)
        self.assertEqual(first, repeated)
        self.assertEqual(len(calls), 1)

    def test_voice_preview_returns_only_a_fixed_preset_resource(self):
        app = FastAPI()
        dependencies = video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "tester"},
            enqueue_task=lambda *args: None,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "task-route",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
        )
        video_workbench.register_video_routes(app, dependencies)
        endpoint = self._route_endpoint(app, "/api/video/voice-preview", "POST")
        preset = next(item for items in video_workbench.ELEVENLABS_VOICE_PRESETS.values() for item in items)
        result = asyncio.run(endpoint(payload={"voice_id": preset["voice_id"], "text": "hello"}, user={"id": 1}))

        self.assertTrue(result["ok"])
        self.assertEqual(result["source"], "fixed_preset_resource")
        self.assertFalse(result["requested_text_synthesized"])
        self.assertTrue(result["preview_url"].startswith(("/assets/", "https://")))
        self.assertNotIn("api_key", json.dumps(result).lower())

    def test_storyboard_and_subtitles_persist_in_existing_task_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "tasks.sqlite"
            self._create_task_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-owned",
                input_payload={"prompt": "original", "uploaded_files": [{"path": str(Path(tmpdir) / "owned.png")}]},
            )
            self._insert_task(db_path, task_id="task-other", user_id=2)
            self._insert_task(db_path, task_id="task-running", status="running")
            enqueued: list = []
            events: list = []
            app = FastAPI()
            dependencies = self._workflow_dependencies(db_path, enqueued, events)
            video_workbench.register_video_routes(app, dependencies)
            storyboard_put = self._route_endpoint(app, "/api/video/tasks/{task_id}/storyboard", "PUT")
            storyboard_get = self._route_endpoint(app, "/api/video/tasks/{task_id}/storyboard", "GET")
            subtitles_put = self._route_endpoint(app, "/api/video/tasks/{task_id}/subtitles", "PUT")
            subtitles_get = self._route_endpoint(app, "/api/video/tasks/{task_id}/subtitles", "GET")
            user = {"id": 1, "username": "tester"}

            storyboard_result = asyncio.run(storyboard_put(
                task_id="task-owned",
                payload={"items": [
                    {"prompt": "opening shot", "duration_seconds": 2.5},
                    {"text": "product close-up", "duration_seconds": 3},
                ]},
                user=user,
            ))
            self.assertEqual(storyboard_result["revision"], 1)
            loaded_storyboard = asyncio.run(storyboard_get(task_id="task-owned", user=user))
            self.assertEqual(loaded_storyboard["storyboard"]["segment_count"], 2)

            subtitle_result = asyncio.run(subtitles_put(
                task_id="task-owned",
                payload={"enabled": True, "items": [
                    {"start_seconds": 0, "end_seconds": 1.5, "text": "Hello"},
                    {"start_seconds": 1.5, "end_seconds": 3, "text": "World"},
                ]},
                user=user,
            ))
            self.assertEqual(subtitle_result["revision"], 2)
            loaded_subtitles = asyncio.run(subtitles_get(task_id="task-owned", user=user))
            self.assertEqual(loaded_subtitles["subtitles"]["cue_count"], 2)
            self.assertEqual(len(events), 2)

            with self.assertRaises(HTTPException) as unauthorized:
                asyncio.run(storyboard_get(task_id="task-other", user=user))
            self.assertEqual(unauthorized.exception.status_code, 404)
            with self.assertRaises(HTTPException) as running:
                asyncio.run(storyboard_put(task_id="task-running", payload={"items": [{"text": "blocked"}]}, user=user))
            self.assertEqual(running.exception.status_code, 409)
            with self.assertRaises(HTTPException) as path_injection:
                asyncio.run(storyboard_put(
                    task_id="task-owned",
                    payload={"items": [{"text": "bad", "image_path": "C:/Windows/win.ini"}]},
                    user=user,
                ))
            self.assertEqual(path_injection.exception.status_code, 400)

    def test_regenerate_segment_and_resume_enqueue_owned_child_tasks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "tasks.sqlite"
            self._create_task_db(db_path)
            storyboard = {"items": [{"text": "one"}, {"text": "two"}]}
            self._insert_task(
                db_path,
                task_id="task-success",
                input_payload={"prompt": "base", "video_workbench": {"storyboard": storyboard}},
            )
            self._insert_task(
                db_path,
                task_id="task-failed",
                status="failed",
                input_payload={
                    "prompt": "base",
                    "video_workbench": {
                        "storyboard": storyboard,
                        "subtitles": {
                            "enabled": True,
                            "items": [{"text": "one", "start_seconds": 0, "end_seconds": 1}],
                        },
                    },
                },
                output_payload={
                    "video_checkpoint": {"runninghub_task_id": "rh-resume"},
                    "completed_segments": [1],
                },
            )
            self._insert_task(
                db_path,
                task_id="task-language-success",
                task_type="video_language_replace",
                input_payload={"target_language": "English"},
                output_payload={"raw_result": {"timed_audio_segments": [
                    {"index": 1, "start_seconds": 0, "end_seconds": 1.5, "text": "Hello", "audio_path": "C:/task/1.mp3"},
                    {"index": 2, "start_seconds": 1.5, "end_seconds": 3, "text": "World", "audio_path": "C:/task/2.mp3"},
                ]}},
            )
            self._insert_task(
                db_path,
                task_id="task-digital-human-scripts",
                task_type="create_video",
                input_payload={"prompt": "base"},
                output_payload={"segment_scripts": ["first spoken segment", "second spoken segment"]},
            )
            enqueued: list = []
            app = FastAPI()
            video_workbench.register_video_routes(app, self._workflow_dependencies(db_path, enqueued, []))
            segment_regenerate = self._route_endpoint(
                app, "/api/video/tasks/{task_id}/segments/{segment_index}/regenerate", "POST"
            )
            storyboard_regenerate = self._route_endpoint(
                app, "/api/video/tasks/{task_id}/storyboard/regenerate", "POST"
            )
            resume = self._route_endpoint(app, "/api/video/tasks/{task_id}/resume", "POST")
            user = {"id": 1, "username": "tester"}

            segment_result = asyncio.run(segment_regenerate(
                task_id="task-success", segment_index=2, payload={}, user=user
            ))
            self.assertEqual(segment_result["action"], "segment_regenerate")
            self.assertEqual(enqueued[-1]["payload"]["segment_index"], 2)
            with self.assertRaises(HTTPException) as bad_index:
                asyncio.run(segment_regenerate(task_id="task-success", segment_index=3, payload={}, user=user))
            self.assertEqual(bad_index.exception.status_code, 400)

            language_segment = asyncio.run(segment_regenerate(
                task_id="task-language-success", segment_index=2, payload={}, user=user
            ))
            self.assertEqual(language_segment["action"], "segment_regenerate")
            self.assertEqual(enqueued[-1]["payload"]["regenerate_segment_index"], 2)
            self.assertEqual(len(enqueued[-1]["payload"]["script_segments"]), 2)
            self.assertEqual(len(enqueued[-1]["payload"]["_video_language_reuse_segments"]), 2)

            digital_human_segment = asyncio.run(segment_regenerate(
                task_id="task-digital-human-scripts", segment_index=2, payload={}, user=user
            ))
            self.assertEqual(digital_human_segment["action"], "segment_regenerate")
            self.assertEqual(enqueued[-1]["payload"]["regenerate_segment_index"], 2)
            self.assertEqual(enqueued[-1]["payload"]["speech_text"], "second spoken segment")

            regenerated = asyncio.run(storyboard_regenerate(task_id="task-success", payload={}, user=user))
            self.assertEqual(regenerated["action"], "storyboard_regenerate")
            self.assertEqual(enqueued[-1]["payload"]["prompt_segments"], ["one", "two"])

            resumed = asyncio.run(resume(task_id="task-failed", payload={"checkpoint": "latest"}, user=user))
            self.assertEqual(resumed["action"], "resume")
            self.assertTrue(enqueued[-1]["payload"]["resume"])
            self.assertEqual(enqueued[-1]["payload"]["prompt_segments"], ["one", "two"])
            self.assertEqual(enqueued[-1]["payload"]["subtitles"]["items"][0]["text"], "one")
            self.assertEqual(enqueued[-1]["payload"]["resume_checkpoint"]["runninghub_task_id"], "rh-resume")
            self.assertEqual(enqueued[-1]["payload"]["completed_segments"], [1])
            with self.assertRaises(HTTPException) as completed:
                asyncio.run(resume(task_id="task-success", payload={}, user=user))
            self.assertEqual(completed.exception.status_code, 409)

    def test_language_script_parse_supports_srt_and_plain_lines(self):
        parsed = video_workbench.parse_language_script({
            "script": "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,000\nWorld",
            "target_language": "zh",
        })
        self.assertTrue(parsed["has_timecodes"])
        self.assertEqual(parsed["segment_count"], 2)
        self.assertEqual(parsed["duration_seconds"], 3.0)
        self.assertEqual(parsed["plain_text"], "Hello\nWorld")

        plain = video_workbench.parse_language_script({"text": "first line\nsecond line"})
        self.assertFalse(plain["has_timecodes"])
        self.assertEqual([item["text"] for item in plain["segments"]], ["first line", "second line"])

    def test_visual_confirmation_endpoints_enqueue_final_tasks_with_confirmed_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            self._create_task_db(db_path)
            fusion = root / "fusion.png"
            scene = root / "scene.png"
            fusion.write_bytes(b"fusion")
            scene.write_bytes(b"scene")
            self._insert_task(
                db_path,
                task_id="task-digital-review",
                task_type="create_video",
                input_payload={"digital_human_operation": "visual_review"},
                output_payload={
                    "fusion_images": [str(fusion)],
                    "speech_text": "confirmed copy",
                    "raw_result": {"digital_human_stage": "visual_review", "fusion_images": [str(fusion)]},
                },
            )
            self._insert_task(
                db_path,
                task_id="task-seeding-review",
                input_payload={"ecommerce_seeding_operation": "images_only"},
                output_payload={
                    "image_paths": [str(scene)],
                    "raw_result": {"seeding_stage": "images_only", "generated_scene_image_paths": [str(scene)]},
                },
            )
            enqueued: list = []
            app = FastAPI()
            video_workbench.register_video_routes(app, self._workflow_dependencies(db_path, enqueued, []))
            digital_finalize = self._route_endpoint(app, "/api/video/tasks/{task_id}/digital-human/finalize", "POST")
            seeding_finalize = self._route_endpoint(app, "/api/video/tasks/{task_id}/seeding/finalize", "POST")
            user = {"id": 1, "username": "tester"}

            digital_result = asyncio.run(digital_finalize(task_id="task-digital-review", user=user))
            self.assertEqual(digital_result["action"], "digital_human_finalize")
            self.assertEqual(enqueued[-1]["payload"]["digital_human_operation"], "final_video")
            self.assertEqual(enqueued[-1]["payload"]["digital_human_fusion_image_paths"], [str(fusion)])
            seeding_result = asyncio.run(seeding_finalize(task_id="task-seeding-review", user=user))
            self.assertEqual(seeding_result["action"], "ecommerce_seeding_finalize")
            self.assertEqual(enqueued[-1]["payload"]["ecommerce_seeding_operation"], "final_video")
            self.assertEqual(enqueued[-1]["payload"]["ecommerce_seeding_confirmed_image_paths"], [str(scene)])

    def test_language_script_analysis_uses_enriched_media_provider_without_enqueuing(self):
        calls: list[dict] = []

        def enrich(_task_type, _task_id, payload):
            result = dict(payload)

            def provider(**kwargs):
                calls.append(kwargs)
                return {
                    "source_language": "Chinese",
                    "source_script": "第一句\n第二句",
                    "segments": [
                        {"start_seconds": 0, "end_seconds": 1.2, "source_text": "第一句", "text": "First"},
                        {"start_seconds": 1.2, "end_seconds": 2.4, "source_text": "第二句", "text": "Second"},
                    ],
                }

            result["_video_language_transcribe_translate"] = provider
            return result

        app = FastAPI()
        dependencies = video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "tester"},
            enqueue_task=lambda *args: self.fail("script analysis must not enqueue a video task"),
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "preview-language",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
            enrich_video_payload=enrich,
        )
        video_workbench.register_video_routes(app, dependencies)
        endpoint = self._route_endpoint(app, "/api/video/language-script/analyze", "POST")
        upload = UploadFile(file=io.BytesIO(b"mock-video"), filename="source.mp4")
        result = asyncio.run(endpoint(
            params_json=json.dumps({"target_language": "English"}),
            files=[upload],
            user={"id": 1, "username": "tester"},
        ))

        self.assertEqual(result["params"]["script_text"], "第一句\n第二句")
        self.assertEqual(result["params"]["video_language_source_segments"][0]["text"], "第一句")
        self.assertEqual(len(calls), 1)

    def test_seeding_scene_regenerate_upload_history_and_restore_form_a_closed_loop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            self._create_task_db(db_path)
            original = root / "scene-original.png"
            regenerated = root / "scene-regenerated.png"
            uploaded = root / "scene-uploaded.png"
            for item in (original, regenerated):
                item.write_bytes(item.stem.encode())
            self._insert_task(
                db_path,
                task_id="task-seeding-source",
                input_payload={
                    "ecommerce_video_mode": "seeding_video",
                    "ecommerce_seeding_operation": "images_only",
                    "storyboard": [{"prompt": "scene one", "duration_seconds": 4}],
                },
                output_payload={
                    "image_paths": [str(original)],
                    "raw_result": {"seeding_stage": "images_only", "generated_scene_image_paths": [str(original)]},
                },
            )
            self._insert_task(
                db_path,
                task_id="task-seeding-child",
                input_payload={
                    "source_task_id": "task-seeding-source",
                    "ecommerce_seeding_regenerate_scene_index": 1,
                },
                output_payload={
                    "image_paths": [str(regenerated)],
                    "raw_result": {"seeding_stage": "images_only", "generated_scene_image_paths": [str(regenerated)]},
                },
            )
            enqueued: list = []
            events: list = []
            base = self._workflow_dependencies(db_path, enqueued, events)

            async def save_upload_file(upload, **_kwargs):
                uploaded.write_bytes(await upload.read())
                return str(uploaded)

            app = FastAPI()
            video_workbench.register_video_routes(app, replace(base, save_upload_file=save_upload_file))
            regenerate = self._route_endpoint(app, "/api/video/tasks/{task_id}/seeding-images/{scene_index}/regenerate", "POST")
            history = self._route_endpoint(app, "/api/video/tasks/{task_id}/seeding-images/{scene_index}/history", "GET")
            use = self._route_endpoint(app, "/api/video/tasks/{task_id}/seeding-images/{scene_index}/use", "POST")
            upload = self._route_endpoint(app, "/api/video/tasks/{task_id}/seeding-images/{scene_index}/upload", "POST")
            user = {"id": 1, "username": "tester"}

            regenerated_task = asyncio.run(regenerate(task_id="task-seeding-source", scene_index=1, user=user))
            self.assertEqual(regenerated_task["action"], "ecommerce_seeding_image_regenerate")
            self.assertEqual(enqueued[-1]["payload"]["ecommerce_seeding_regenerate_scene_index"], 1)
            history_result = asyncio.run(history(task_id="task-seeding-source", scene_index=1, user=user))
            self.assertEqual({Path(item["path"]).name for item in history_result["items"]}, {original.name, regenerated.name})
            asyncio.run(use(
                task_id="task-seeding-source",
                scene_index=1,
                payload={"path": str(regenerated)},
                user=user,
            ))
            replacement_upload = UploadFile(file=io.BytesIO(b"uploaded"), filename="replacement.png")
            asyncio.run(upload(task_id="task-seeding-source", scene_index=1, image=replacement_upload, user=user))
            conn = sqlite3.connect(db_path)
            try:
                output = json.loads(conn.execute("SELECT output_json FROM tasks WHERE id = ?", ("task-seeding-source",)).fetchone()[0])
            finally:
                conn.close()
            self.assertEqual(output["image_paths"], [str(uploaded.resolve())])
            self.assertTrue(events)

    def test_digital_human_asset_history_can_restore_only_the_owned_slot(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            self._create_task_db(db_path)
            current = root / "fusion-current.png"
            previous = root / "fusion-previous.png"
            outside = root / "outside.png"
            for item in (current, previous, outside):
                item.write_bytes(item.stem.encode())
            self._insert_task(
                db_path,
                task_id="task-digital-history",
                task_type="create_video",
                input_payload={"digital_human_fusion_image_paths": [str(current)]},
                output_payload={
                    "fusion_images": [str(current)],
                    "digital_human_asset_history": {
                        "main": [{"path": str(previous), "source": "regenerated", "created_at": 1}]
                    },
                    "raw_result": {"fusion_images": [str(current)]},
                },
            )
            app = FastAPI()
            video_workbench.register_video_routes(app, self._workflow_dependencies(db_path, [], []))
            history = self._route_endpoint(
                app, "/api/video/tasks/{task_id}/digital-human/assets/{asset_index}/history", "GET"
            )
            use = self._route_endpoint(
                app, "/api/video/tasks/{task_id}/digital-human/assets/{asset_index}/use", "POST"
            )
            user = {"id": 1, "username": "tester"}

            listed = asyncio.run(history(task_id="task-digital-history", asset_index=1, user=user))
            self.assertEqual({Path(item["path"]).name for item in listed["items"]}, {current.name, previous.name})
            restored = asyncio.run(use(
                task_id="task-digital-history", asset_index=1, payload={"path": str(previous)}, user=user
            ))
            self.assertEqual(Path(restored["path"]).name, previous.name)
            with self.assertRaises(HTTPException) as denied:
                asyncio.run(use(
                    task_id="task-digital-history", asset_index=1, payload={"path": str(outside)}, user=user
                ))
            self.assertEqual(denied.exception.status_code, 403)

            conn = sqlite3.connect(db_path)
            try:
                row = conn.execute(
                    "SELECT input_json, output_json FROM tasks WHERE id = ?", ("task-digital-history",)
                ).fetchone()
            finally:
                conn.close()
            stored_input = json.loads(row[0])
            stored_output = json.loads(row[1])
            self.assertEqual(stored_input["digital_human_main_image_local_path"], str(previous.resolve()))
            self.assertEqual(stored_output["fusion_images"], [str(previous.resolve())])

    def test_archived_source_backend_create_video_is_runnable_with_server_hooks(self):
        class FakeSourceBackend(ArchivedSourceBackend):
            def image_generate(self, *, payload, **_kwargs):
                output = Path(payload["output_dir"]) / "fusion.png"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"image")
                return {"ok": True, "image_path": str(output), "image_paths": [str(output)]}

            def _generate_minimax_tts(self, *, output_path, **_kwargs):
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"audio")
                return output_path

            def _probe_duration(self, *_args, **_kwargs):
                return 5

            def _resolve_media(self, **kwargs):
                return f"https://media.invalid/{kwargs['media_kind']}"

            def _submit_and_poll(self, **kwargs):
                output_path = kwargs["output_path"]
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"video")
                return {"status": "success", "runninghub_task_id": "rh-source-1", "message": "ok"}

        with tempfile.TemporaryDirectory() as tmpdir:
            model_path = Path(tmpdir) / "person.png"
            product_path = Path(tmpdir) / "product.png"
            model_path.write_bytes(b"model")
            product_path.write_bytes(b"product")
            payload = {
                "model_image_local_path": str(model_path),
                "product_image_local_path": str(product_path),
                "speech_text": "hello",
                "output_dir": tmpdir,
                "duration_seconds": 5,
            }
            context = VideoTaskContext(task_id="task-source", task_type="create_video")
            result = FakeSourceBackend().run_task("create_video", "task-source", payload, context)
        self.assertTrue(result["ok"])
        self.assertEqual(result["runninghub_task_id"], "rh-source-1")


if __name__ == "__main__":
    unittest.main()
