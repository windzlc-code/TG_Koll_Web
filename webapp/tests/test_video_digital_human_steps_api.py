from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing, contextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException

from webapp import video_workbench


class DigitalHumanStepApiTests(unittest.TestCase):
    @staticmethod
    def _endpoint(app: FastAPI, path: str):
        for route in app.router.routes:
            if getattr(route, "path", None) == path and "POST" in getattr(route, "methods", set()):
                return route.endpoint
        raise AssertionError(f"route not found: POST {path}")

    @staticmethod
    def _create_db(path: Path) -> None:
        with closing(sqlite3.connect(path)) as conn:
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

    @staticmethod
    def _insert_task(
        path: Path,
        *,
        task_id: str,
        user_id: int,
        input_payload: dict,
        task_type: str = "create_video",
        status: str = "success",
    ) -> None:
        with closing(sqlite3.connect(path)) as conn:
            conn.execute(
                "INSERT INTO tasks(id, user_id, type, status, input_json, output_json, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    task_id,
                    user_id,
                    task_type,
                    status,
                    json.dumps(input_payload, ensure_ascii=False),
                    "{}",
                    1,
                ),
            )
            conn.commit()

    @staticmethod
    def _dependencies(db_path: Path, work_root: Path, events: list[dict], ai_calls: list[dict]):
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

        def ai_copy_provider(**kwargs):
            ai_calls.append(kwargs)
            return {
                "speech_text": "确认后的数字人口播文案",
                "segment_scripts": ["第一段", "第二段"],
                "metadata": {"provider": "mock-text-model"},
            }

        def enrich(task_type, task_id, payload):
            enriched = dict(payload)
            enriched["_digital_human_ai_copy_provider"] = ai_copy_provider
            enriched["_video_workdir_factory"] = lambda _task_id: work_root / str(_task_id)
            return enriched

        return video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "owner"},
            enqueue_task=lambda *args, **kwargs: None,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "unused",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
            db_factory=db_factory,
            ensure_task_access=ensure_task_access,
            json_loads=lambda value, default: json.loads(value) if value else default,
            json_dumps=lambda value: json.dumps(value, ensure_ascii=False),
            now_ts=lambda: 2,
            emit_task_event=lambda **kwargs: events.append(kwargs),
            enrich_video_payload=enrich,
        )

    @staticmethod
    def _stored(db_path: Path, task_id: str) -> tuple[dict, dict]:
        with closing(sqlite3.connect(db_path)) as conn:
            row = conn.execute(
                "SELECT input_json, output_json FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
        return json.loads(row[0]), json.loads(row[1])

    def test_registers_original_and_current_compatibility_routes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            self._create_db(db_path)
            app = FastAPI()
            video_workbench.register_video_routes(app, self._dependencies(db_path, root / "work", [], []))
            self._endpoint(app, "/api/tasks/create_video/step")
            self._endpoint(app, "/api/video/create-video/step")

    def test_original_oral_candidate_normalization_keeps_three_choices_and_selection(self):
        candidates, selected = video_workbench._normalize_digital_human_oral_script_candidates({
            "selected_index": 2,
            "candidates": [
                {"title": "热点", "speech_text": "第一条完整口播", "hook_keywords": ["热点", "避坑"]},
                {"title": "痛点", "speech_text": "第二条完整口播", "hook_keywords": ["痛点"]},
                {"title": "方法", "speech_text": "第三条完整口播", "hook_keywords": ["方法"]},
                {"title": "多余", "speech_text": "第四条不应保留"},
            ],
        })
        self.assertEqual(len(candidates), 3)
        self.assertEqual(selected, 1)
        self.assertEqual(candidates[selected]["speech_text"], "第二条完整口播")

    def test_script_uses_ai_copy_provider_and_persists_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            model = root / "model.png"
            product = root / "product.png"
            model.write_bytes(b"model")
            product.write_bytes(b"product")
            self._create_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-script",
                user_id=1,
                input_payload={
                    "model_image_local_path": str(model),
                    "product_image_local_path": str(product),
                    "use_ai_copy": True,
                },
            )
            events: list[dict] = []
            ai_calls: list[dict] = []
            app = FastAPI()
            video_workbench.register_video_routes(app, self._dependencies(db_path, root / "work", events, ai_calls))
            endpoint = self._endpoint(app, "/api/tasks/create_video/step")

            result = asyncio.run(
                endpoint(
                    payload={"task_id": "task-script", "step": "script", "params": {}},
                    user={"id": 1, "username": "owner"},
                )
            )

            self.assertEqual(result["speech_text"], "确认后的数字人口播文案")
            self.assertEqual(len(ai_calls), 1)
            stored_input, stored_output = self._stored(db_path, "task-script")
            self.assertEqual(stored_input["speech_text"], result["speech_text"])
            self.assertEqual(stored_output["video_checkpoint"]["stage"], "digital_human_script_ready")
            self.assertEqual(stored_output["video_checkpoint"]["segment_scripts"], ["第一段", "第二段"])
            self.assertEqual(events[-1]["data"]["step"], "script")

    def test_fusion_steps_persist_owned_media_and_single_view_replaces_only_target_slot(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            model = root / "model.png"
            product = root / "product.png"
            model.write_bytes(b"model")
            product.write_bytes(b"product")
            self._create_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-fusion",
                user_id=1,
                input_payload={
                    "model_image_local_path": str(model),
                    "product_image_local_path": str(product),
                    "speech_text": "已确认文案",
                    "digital_human_short_mode": "storyboard",
                },
            )
            workdir = root / "work" / "task-fusion"
            workdir.mkdir(parents=True)
            main = workdir / "main.png"
            view_two = workdir / "view-2.png"
            view_three = workdir / "view-3.png"
            replacement = workdir / "view-3-new.png"
            for item in (main, view_two, view_three, replacement):
                item.write_bytes(item.name.encode())
            app = FastAPI()
            video_workbench.register_video_routes(app, self._dependencies(db_path, root / "work", [], []))
            endpoint = self._endpoint(app, "/api/video/create-video/step")

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "generate_digital_human_fusion_main",
                return_value={"image_path": str(main)},
                create=True,
            ):
                main_result = asyncio.run(endpoint(
                    payload={"task_id": "task-fusion", "step": "fusion_main", "params": {}},
                    user={"id": 1, "username": "owner"},
                ))
            self.assertEqual(main_result["image_path"], str(main.resolve()))

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "generate_digital_human_consistency_views",
                return_value={"image_paths": [str(view_two), str(view_three)]},
                create=True,
            ):
                views_result = asyncio.run(endpoint(
                    payload={"task_id": "task-fusion", "step": "fusion_views", "params": {}},
                    user={"id": 1, "username": "owner"},
                ))
            self.assertEqual(
                views_result["image_paths"],
                [str(main.resolve()), str(view_two.resolve()), str(view_three.resolve())],
            )

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "generate_digital_human_single_consistency_view",
                return_value={"image_path": str(replacement)},
                create=True,
            ) as provider:
                single_result = asyncio.run(endpoint(
                    payload={
                        "task_id": "task-fusion",
                        "step": "fusion_view",
                        "params": {"digital_human_regenerate_view_index": 3},
                    },
                    user={"id": 1, "username": "owner"},
                ))
            self.assertEqual(single_result["view_index"], 3)
            self.assertEqual(
                single_result["image_paths"],
                [str(main.resolve()), str(view_two.resolve()), str(replacement.resolve())],
            )
            self.assertEqual(provider.call_args.kwargs["view_index"], 3)
            self.assertEqual(provider.call_args.kwargs["main_image_path"], str(main.resolve()))
            stored_input, stored_output = self._stored(db_path, "task-fusion")
            self.assertEqual(stored_input["digital_human_fusion_image_paths"], single_result["image_paths"])
            self.assertEqual(stored_output["video_checkpoint"]["fusion_images"], single_result["image_paths"])

    def test_fusion_step_billing_settles_success_and_releases_provider_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            model = root / "model.png"
            product = root / "product.png"
            model.write_bytes(b"model")
            product.write_bytes(b"product")
            self._create_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-billing",
                user_id=1,
                input_payload={
                    "model_image_local_path": str(model),
                    "product_image_local_path": str(product),
                    "speech_text": "confirmed script",
                },
            )
            workdir = root / "work" / "task-billing"
            workdir.mkdir(parents=True)
            main = workdir / "main.png"
            main.write_bytes(b"main")
            calls: list[tuple[str, int]] = []

            dependencies = replace(
                self._dependencies(db_path, root / "work", [], []),
                reserve_video_step_charge=lambda **kwargs: (
                    calls.append(("reserve", int(kwargs["quantity"])))
                    or {"id": f"hold-{len(calls)}"}
                ),
                settle_video_step_charge=lambda **kwargs: (
                    calls.append(("settle", int(kwargs["actual_quantity"])))
                    or {"status": "settled"}
                ),
                release_video_step_charge=lambda **_kwargs: (
                    calls.append(("release", 0)) or {"status": "released"}
                ),
            )
            app = FastAPI()
            video_workbench.register_video_routes(app, dependencies)
            endpoint = self._endpoint(app, "/api/video/create-video/step")

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "generate_digital_human_fusion_main",
                return_value={"image_path": str(main)},
                create=True,
            ):
                result = asyncio.run(endpoint(
                    payload={"task_id": "task-billing", "step": "fusion_main", "params": {}},
                    user={"id": 1, "username": "owner"},
                ))
            self.assertEqual(calls, [("reserve", 1), ("settle", 1)])
            self.assertEqual(result["billing"]["status"], "settled")

            calls.clear()
            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "generate_digital_human_fusion_main",
                side_effect=RuntimeError("mock provider failure"),
                create=True,
            ):
                with self.assertRaises(HTTPException) as failed:
                    asyncio.run(endpoint(
                        payload={"task_id": "task-billing", "step": "fusion_main", "params": {}},
                        user={"id": 1, "username": "owner"},
                    ))
            self.assertEqual(failed.exception.status_code, 502)
            self.assertEqual(calls, [("reserve", 1), ("release", 0)])

    def test_real_source_backend_step_methods_run_with_only_image_generate_mocked(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            model = root / "model.png"
            product = root / "product.png"
            model.write_bytes(b"model")
            product.write_bytes(b"product")
            self._create_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-real-provider",
                user_id=1,
                input_payload={
                    "model_image_local_path": str(model),
                    "product_image_local_path": str(product),
                    "speech_text": "已确认文案",
                    "digital_human_short_mode": "storyboard",
                    "digital_human_fusion_count": 3,
                    "storyboard": {
                        "items": [
                            {"segment_index": 1, "prompt": "主镜头"},
                            {"segment_index": 2, "prompt": "左侧视角"},
                            {"segment_index": 3, "prompt": "右侧视角"},
                        ]
                    },
                },
            )
            app = FastAPI()
            video_workbench.register_video_routes(app, self._dependencies(db_path, root / "work", [], []))
            endpoint = self._endpoint(app, "/api/video/create-video/step")
            generated: list[Path] = []

            def fake_image_generate(*, task_id, payload, context):
                context.check_cancelled()
                output_dir = Path(payload["output_dir"]).resolve()
                output_dir.mkdir(parents=True, exist_ok=True)
                image_path = output_dir / f"generated-{len(generated) + 1}.png"
                image_path.write_bytes(str(task_id).encode())
                generated.append(image_path)
                return {"ok": True, "image_path": str(image_path), "runninghub_task_ids": [f"mock-{len(generated)}"]}

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "image_generate",
                side_effect=fake_image_generate,
            ):
                main_result = asyncio.run(endpoint(
                    payload={"task_id": "task-real-provider", "step": "fusion_main", "params": {}},
                    user={"id": 1, "username": "owner"},
                ))
                views_result = asyncio.run(endpoint(
                    payload={"task_id": "task-real-provider", "step": "fusion_views", "params": {}},
                    user={"id": 1, "username": "owner"},
                ))
                before = list(views_result["image_paths"])
                single_result = asyncio.run(endpoint(
                    payload={
                        "task_id": "task-real-provider",
                        "step": "fusion_view",
                        "params": {"digital_human_regenerate_view_index": 3},
                    },
                    user={"id": 1, "username": "owner"},
                ))

            self.assertEqual(views_result["image_paths"][0], main_result["image_path"])
            self.assertEqual(len(views_result["image_paths"]), 3)
            self.assertEqual(single_result["image_paths"][0], before[0])
            self.assertEqual(single_result["image_paths"][1], before[1])
            self.assertNotEqual(single_result["image_paths"][2], before[2])
            self.assertEqual(len(generated), 4)

    def test_rejects_cross_tenant_foreign_paths_outside_outputs_and_cancelled_work(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            model = root / "model.png"
            product = root / "product.png"
            foreign = root / "foreign.png"
            for item in (model, product, foreign):
                item.write_bytes(b"image")
            self._create_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-secure",
                user_id=1,
                input_payload={
                    "model_image_local_path": str(model),
                    "product_image_local_path": str(product),
                    "speech_text": "文案",
                },
            )
            app = FastAPI()
            video_workbench.register_video_routes(app, self._dependencies(db_path, root / "work", [], []))
            endpoint = self._endpoint(app, "/api/tasks/create_video/step")

            with self.assertRaises(HTTPException) as denied:
                asyncio.run(endpoint(
                    payload={"task_id": "task-secure", "step": "script", "params": {}},
                    user={"id": 2, "username": "other"},
                ))
            self.assertEqual(denied.exception.status_code, 404)

            with self.assertRaises(HTTPException) as bad_path:
                asyncio.run(endpoint(
                    payload={
                        "task_id": "task-secure",
                        "step": "fusion_main",
                        "params": {"product_image_local_path": str(foreign)},
                    },
                    user={"id": 1, "username": "owner"},
                ))
            self.assertEqual(bad_path.exception.status_code, 400)

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "generate_digital_human_fusion_main",
                return_value={"image_path": str(foreign)},
                create=True,
            ):
                with self.assertRaises(HTTPException) as outside:
                    asyncio.run(endpoint(
                        payload={"task_id": "task-secure", "step": "fusion_main", "params": {}},
                        user={"id": 1, "username": "owner"},
                    ))
            self.assertEqual(outside.exception.status_code, 502)

            event = threading.Event()
            event.set()
            video_workbench.bind_video_cancel_event("task-secure", event)
            try:
                with patch.object(
                    video_workbench.DEFAULT_SOURCE_BACKEND,
                    "generate_digital_human_fusion_main",
                    create=True,
                ) as provider:
                    with self.assertRaises(HTTPException) as cancelled:
                        asyncio.run(endpoint(
                            payload={"task_id": "task-secure", "step": "fusion_main", "params": {}},
                            user={"id": 1, "username": "owner"},
                        ))
                self.assertEqual(cancelled.exception.status_code, 409)
                provider.assert_not_called()
            finally:
                video_workbench.release_video_cancel_event("task-secure", event)


if __name__ == "__main__":
    unittest.main()
