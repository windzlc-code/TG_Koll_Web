from __future__ import annotations

import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing, contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException

from webapp import video_workbench


class VideoTaskSubtitlePostTests(unittest.TestCase):
    @staticmethod
    def _endpoint(app: FastAPI):
        for route in app.router.routes:
            if route.path == "/api/tasks/{task_id}/subtitles" and "POST" in route.methods:
                return route.endpoint
        raise AssertionError("subtitle POST route was not registered")

    @staticmethod
    def _db_factory(path: Path):
        @contextmanager
        def factory():
            conn = sqlite3.connect(path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

        return factory

    def _build_app(self, db_path: Path, events: list[dict]) -> FastAPI:
        db_factory = self._db_factory(db_path)

        def ensure_access(user, task):
            if int(user["id"]) != int(task["user_id"]):
                raise HTTPException(status_code=404, detail="Task not found")

        dependencies = video_workbench.VideoRouteDependencies(
            get_current_user=lambda: {"id": 1, "username": "owner"},
            enqueue_task=lambda *args, **kwargs: None,
            save_upload_file=lambda **kwargs: "",
            new_task_id=lambda: "unused",
            workspace_username=lambda user: str(user["username"]),
            workspace_user_id=lambda user: int(user["id"]),
            db_factory=db_factory,
            ensure_task_access=ensure_access,
            json_loads=lambda value, default: json.loads(value) if value else default,
            json_dumps=lambda value: json.dumps(value, ensure_ascii=False),
            now_ts=lambda: 1_700_000_100,
            emit_task_event=lambda **kwargs: events.append(kwargs),
        )
        app = FastAPI()
        video_workbench.register_video_routes(app, dependencies)
        return app

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
        source: Path,
        user_id: int = 1,
        status: str = "success",
        task_type: str = "create_video",
        input_payload: dict | None = None,
        output_payload: dict | None = None,
    ) -> None:
        output = {"download_path": str(source), "video_path": str(source), "duration_seconds": 4.0}
        output.update(output_payload or {})
        with closing(sqlite3.connect(path)) as conn:
            conn.execute(
                "INSERT INTO tasks(id, user_id, type, status, input_json, output_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    task_id,
                    user_id,
                    task_type,
                    status,
                    json.dumps(input_payload or {"speech_text": "hello subtitles"}, ensure_ascii=False),
                    json.dumps(output, ensure_ascii=False),
                    1,
                ),
            )
            conn.commit()

    @staticmethod
    def _fake_renderer(calls: list[dict]):
        def render(*, video_path, payload, context, workdir):
            context.check_cancelled()
            workdir.mkdir(parents=True, exist_ok=True)
            subtitle_path = workdir / f"{video_path.stem}.srt"
            rendered_path = workdir / f"{video_path.stem}_subtitled.mp4"
            subtitle_path.write_text("1\n00:00:00,000 --> 00:00:04,000\nhello subtitles\n", encoding="utf-8")
            rendered_path.write_bytes(b"mock-subtitled-video")
            calls.append({"video_path": video_path, "payload": payload, "workdir": workdir})
            return rendered_path, len(payload["subtitles"]["items"])

        return render

    def test_successful_video_is_rendered_and_download_path_is_updated(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            source = root / "result.mp4"
            source.write_bytes(b"small-local-video-placeholder")
            self._create_db(db_path)
            self._insert_task(
                db_path,
                task_id="task-subtitle",
                source=source,
                input_payload={"segment_scripts": ["first", "second"]},
                output_payload={
                    "segment_scripts": ["first", "second"],
                    "completed_segments": [
                        {"index": 1, "duration_seconds": 1.5},
                        {"index": 2, "duration_seconds": 2.5},
                    ],
                },
            )
            events: list[dict] = []
            endpoint = self._endpoint(self._build_app(db_path, events))
            calls: list[dict] = []

            with patch.object(
                video_workbench.DEFAULT_SOURCE_BACKEND,
                "_burn_subtitles_if_requested",
                side_effect=self._fake_renderer(calls),
            ):
                result = endpoint(
                    task_id="task-subtitle",
                    body={"subtitle_template": "keyword_focus", "output_path": "../../outside.mp4"},
                    user={"id": 1, "username": "owner"},
                )

            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["video_path"], source.resolve())
            self.assertEqual(calls[0]["payload"]["subtitle_template"], "keyword_focus")
            self.assertEqual([item["text"] for item in calls[0]["payload"]["subtitles"]["items"]], ["first", "second"])
            self.assertEqual(calls[0]["workdir"].parent.parent, source.parent.resolve())
            self.assertTrue(result["has_download"])
            self.assertTrue(Path(result["output"]["download_path"]).is_file())
            self.assertEqual(result["output"]["original_download_path"], str(source.resolve()))
            self.assertEqual(result["output"]["subtitle_template"], "keyword_focus")
            self.assertTrue(result["output"]["subtitled"])
            self.assertEqual(events[-1]["data"]["stage"], "subtitle")

            with closing(sqlite3.connect(db_path)) as conn:
                stored = json.loads(conn.execute("SELECT output_json FROM tasks WHERE id = ?", ("task-subtitle",)).fetchone()[0])
            self.assertEqual(stored["download_path"], result["output"]["download_path"])
            self.assertEqual(stored["original_video_path"], str(source.resolve()))

    def test_only_owner_of_successful_video_task_can_render_subtitles(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            source = root / "result.mp4"
            source.write_bytes(b"video")
            self._create_db(db_path)
            self._insert_task(db_path, task_id="task-owned", source=source)
            self._insert_task(db_path, task_id="task-failed", source=source, status="failed")
            endpoint = self._endpoint(self._build_app(db_path, []))

            with self.assertRaises(HTTPException) as denied:
                endpoint(task_id="task-owned", body={}, user={"id": 2, "username": "other"})
            self.assertEqual(denied.exception.status_code, 404)
            with self.assertRaises(HTTPException) as failed:
                endpoint(task_id="task-failed", body={}, user={"id": 1, "username": "owner"})
            self.assertEqual(failed.exception.status_code, 409)
            with self.assertRaises(HTTPException) as traversal:
                endpoint(task_id="../task-owned", body={}, user={"id": 1, "username": "owner"})
            self.assertEqual(traversal.exception.status_code, 400)

    def test_bound_cancel_event_stops_render_without_updating_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "tasks.sqlite"
            source = root / "result.mp4"
            source.write_bytes(b"video")
            self._create_db(db_path)
            self._insert_task(db_path, task_id="task-cancel", source=source)
            endpoint = self._endpoint(self._build_app(db_path, []))
            event = threading.Event()
            event.set()
            video_workbench.bind_video_cancel_event("task-cancel", event)
            try:
                with patch.object(
                    video_workbench.DEFAULT_SOURCE_BACKEND,
                    "_burn_subtitles_if_requested",
                    side_effect=self._fake_renderer([]),
                ):
                    with self.assertRaises(HTTPException) as cancelled:
                        endpoint(task_id="task-cancel", body={}, user={"id": 1, "username": "owner"})
                self.assertEqual(cancelled.exception.status_code, 409)
            finally:
                video_workbench.release_video_cancel_event("task-cancel", event)

            with closing(sqlite3.connect(db_path)) as conn:
                stored = json.loads(conn.execute("SELECT output_json FROM tasks WHERE id = ?", ("task-cancel",)).fetchone()[0])
            self.assertEqual(stored["download_path"], str(source))
            self.assertFalse((source.parent / "video_subtitles" / "task-cancel" / "result_subtitled.mp4").exists())


if __name__ == "__main__":
    unittest.main()
