from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import tempfile
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from pathlib import Path

from fastapi import FastAPI, HTTPException

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
        merged["ecommerce_short_video_workflow_ids"].append("mutated")
        self.assertEqual(runtime["ecommerce_short_video_workflow_ids"], ["custom-workflow"])
        self.assertEqual(video_workbench.VIDEO_RUNTIME_CONFIG_DEFAULTS["video_tts_provider"], "minimax")
        self.assertIn("video_runninghub_api_key", video_workbench.VIDEO_RUNTIME_CONFIG_DEFAULTS)

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
            "source_segments": [{"start_seconds": 0, "end_seconds": 1.2, "source_text": "你好"}],
        })
        self.assertTrue(result["ok"])
        self.assertEqual(result["raw_result"]["target_script"], "Hello")
        self.assertEqual(result["raw_result"]["segments"][0]["source_text"], "你好")
        self.assertNotIn("api_key", result["raw_result"]["transcription"]["selected"])
        self.assertEqual(calls[0]["video_paths"], [str(Path("C:/uploads/source.mp4").resolve())])
        self.assertEqual(calls[0]["retry_count"], 2)
        self.assertIn("Use this supplied source transcript exactly", calls[0]["user_input"])
        self.assertIn("Translate and insert this opening line", calls[0]["user_input"])
        self.assertIn("Translate and append this ending line", calls[0]["user_input"])

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
        self.assertIn("/api/video/voice-presets", paths)
        self.assertIn("/api/video/voice-preview", paths)
        self.assertIn("/api/video/tasks/{task_id}/storyboard", paths)
        self.assertIn("/api/video/tasks/{task_id}/storyboard/regenerate", paths)
        self.assertIn("/api/video/tasks/{task_id}/subtitles", paths)
        self.assertIn("/api/video/tasks/{task_id}/segments/{segment_index}/regenerate", paths)
        self.assertIn("/api/video/tasks/{task_id}/resume", paths)
        self.assertIn("/api/video/language-script/parse", paths)
        for task_type in video_workbench.VIDEO_TASK_RUNNERS:
            self.assertIn(f"/api/video/{task_type}", paths)

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

    def test_archived_source_backend_create_video_is_runnable_with_server_hooks(self):
        class FakeSourceBackend(ArchivedSourceBackend):
            def _resolve_media(self, **kwargs):
                return f"https://media.invalid/{kwargs['media_kind']}"

            def _submit_and_poll(self, **kwargs):
                output_path = kwargs["output_path"]
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"video")
                return {"status": "success", "runninghub_task_id": "rh-source-1", "message": "ok"}

        with tempfile.TemporaryDirectory() as tmpdir:
            payload = {
                "model_image_local_path": str(Path(tmpdir) / "person.png"),
                "audio_local_path": str(Path(tmpdir) / "speech.mp3"),
                "output_dir": tmpdir,
                "duration_seconds": 5,
            }
            context = VideoTaskContext(task_id="task-source", task_type="create_video")
            result = FakeSourceBackend().run_task("create_video", "task-source", payload, context)
        self.assertTrue(result["ok"])
        self.assertEqual(result["runninghub_task_id"], "rh-source-1")


if __name__ == "__main__":
    unittest.main()
