from __future__ import annotations

import asyncio
import io
import json
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from starlette.datastructures import UploadFile

from webapp import video_editor


class VideoEditorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db_path = self.root / "app.db"
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                """
                CREATE TABLE tasks (
                  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL,
                  status TEXT NOT NULL, output_json TEXT NOT NULL, created_at INTEGER NOT NULL
                )
                """
            )
            conn.commit()
        finally:
            conn.close()

        @contextmanager
        def db_factory():
            conn = sqlite3.connect(self.db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

        self.dependencies = video_editor.VideoEditorDependencies(
            get_current_user=lambda: {"id": 1, "username": "editor"},
            workspace_user_id=lambda user: int(user["id"]),
            db_factory=db_factory,
            data_dir=self.root / "data",
            extract_output_paths=lambda output: list(output.get("video_paths") or []) + ([output["video_path"]] if output.get("video_path") else []),
            max_upload_bytes=20 * 1024 * 1024,
            now_ts=lambda: int(time.time()),
        )
        self.app = FastAPI()
        video_editor.register_video_editor_routes(self.app, self.dependencies)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def endpoint(self, path: str, method: str):
        for route in self.app.router.routes:
            if getattr(route, "path", "") == path and method in getattr(route, "methods", set()):
                return route.endpoint
        raise AssertionError(f"missing route: {method} {path}")

    def make_video(self, target: Path, *, audio: bool = True, container: str = "mp4", color: str = "#197f80") -> Path:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("ffmpeg is not installed")
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=320x180:d=1"]
        if audio:
            command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest"]
        command += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
        if audio:
            command += ["-c:a", "aac"]
        if container == "avi":
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=1", "-c:v", "mpeg4"]
        command.append(str(target))
        completed = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(target.is_file())
        return target

    def sample_rgb(self, source: Path, x: int, y: int) -> tuple[int, int, int]:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("ffmpeg is not installed")
        completed = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", "0.25", "-i", str(source), "-vf", f"crop=2:2:{x}:{y},format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"],
            capture_output=True, timeout=30, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        self.assertGreaterEqual(len(completed.stdout), 3)
        return tuple(completed.stdout[:3])

    def test_generated_asset_project_export_and_durable_playback_closed_loop(self):
        source = self.make_video(self.root / "generated.mp4", audio=True)
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                "INSERT INTO tasks(id, user_id, type, status, output_json, created_at) VALUES (?, ?, ?, 'success', ?, ?)",
                ("task-video-1", 1, "create_video", json.dumps({"video_path": str(source)}), int(time.time())),
            )
            conn.commit()
        finally:
            conn.close()

        list_assets = self.endpoint("/api/video/editor/assets", "GET")
        assets = list_assets(sync_generated=True, user={"id": 1})["items"]
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["source_type"], "generated")
        asset_id = assets[0]["id"]
        durable_path = Path(video_editor._asset_row(self.dependencies, 1, asset_id)["original_path"])
        self.assertNotEqual(durable_path.resolve(), source.resolve())

        source.unlink()
        media = self.endpoint("/api/video/editor/assets/{asset_id}/media", "GET")(asset_id, {"id": 1})
        self.assertTrue(Path(media.path).is_file())

        create_project = self.endpoint("/api/video/editor/projects", "POST")
        project = create_project(
            video_editor.VideoProjectPayload(
                name="闭环验收",
                clips=[{"asset_id": asset_id, "start": 0.1, "end": 0.8, "volume": 0.8, "speed": 2}],
                settings={"ratio": "16:9", "quality": "720p"},
            ),
            {"id": 1},
        )["project"]
        self.assertEqual(project["clips"][0]["track"], 0)
        self.assertEqual(project["clips"][0]["timeline_start"], 0)
        start_export = self.endpoint("/api/video/editor/projects/{project_id}/export", "POST")
        export = start_export(project["id"], video_editor.VideoExportPayload(name="闭环成品"), {"id": 1})["export"]

        get_export = self.endpoint("/api/video/editor/exports/{export_id}", "GET")
        deadline = time.time() + 45
        current = export
        while current["status"] in {"queued", "running"} and time.time() < deadline:
            time.sleep(0.2)
            current = get_export(export["id"], {"id": 1})["export"]
        self.assertEqual(current["status"], "success", current.get("error"))
        self.assertEqual(current["progress"], 100)
        self.assertTrue(current["output_asset_id"])

        refreshed = list_assets(sync_generated=False, user={"id": 1})["items"]
        self.assertEqual({item["source_type"] for item in refreshed}, {"generated", "export"})
        exported = next(item for item in refreshed if item["source_type"] == "export")
        exported_media = self.endpoint("/api/video/editor/assets/{asset_id}/media", "GET")(exported["id"], {"id": 1})
        probe = video_editor._probe_video(Path(exported_media.path))
        self.assertGreater(probe["duration"], 0.25)
        self.assertLess(probe["duration"], 0.55)
        self.assertTrue(probe["has_audio"])

    def test_custom_avi_upload_creates_browser_mp4_preview(self):
        source = self.make_video(self.root / "custom.avi", audio=False, container="avi")
        upload = UploadFile(file=io.BytesIO(source.read_bytes()), filename="自定义素材.avi")
        endpoint = self.endpoint("/api/video/editor/assets/upload", "POST")
        result = asyncio.run(endpoint(upload, {"id": 1}))
        asset = result["asset"]
        self.assertEqual(asset["source_type"], "upload")
        row = video_editor._asset_row(self.dependencies, 1, asset["id"])
        self.assertEqual(Path(row["preview_path"]).suffix.lower(), ".mp4")
        self.assertTrue(Path(row["preview_path"]).is_file())

    def test_multitrack_overlay_is_saved_and_composited_into_export(self):
        red = self.make_video(self.root / "base-red.mp4", audio=False, color="red")
        blue = self.make_video(self.root / "overlay-blue.mp4", audio=False, color="blue")
        base = video_editor._persist_video_asset(
            self.dependencies, user_id=1, source=red, name="底层", source_type="upload", source_ref="upload:base-red",
        )
        overlay = video_editor._persist_video_asset(
            self.dependencies, user_id=1, source=blue, name="叠加层", source_type="upload", source_ref="upload:overlay-blue",
        )
        create_project = self.endpoint("/api/video/editor/projects", "POST")
        project = create_project(
            video_editor.VideoProjectPayload(
                name="多轨合成",
                clips=[
                    {"id": "clip_base_001", "asset_id": base["id"], "start": 0, "end": 0.8, "track": 0, "timeline_start": 0, "scale": 1},
                    {"id": "clip_overlay_001", "asset_id": overlay["id"], "start": 0, "end": 0.8, "track": 1, "timeline_start": 0, "scale": 0.4, "position_x": 1, "position_y": 0, "opacity": 1},
                ],
                settings={"ratio": "16:9", "quality": "720p"},
            ),
            {"id": 1},
        )["project"]
        self.assertEqual(project["clips"][1]["track"], 1)
        self.assertEqual(project["clips"][1]["timeline_start"], 0)
        self.assertEqual(project["clips"][1]["scale"], 0.4)

        start_export = self.endpoint("/api/video/editor/projects/{project_id}/export", "POST")
        export = start_export(project["id"], video_editor.VideoExportPayload(name="多轨成品"), {"id": 1})["export"]
        get_export = self.endpoint("/api/video/editor/exports/{export_id}", "GET")
        deadline = time.time() + 45
        current = export
        while current["status"] in {"queued", "running"} and time.time() < deadline:
            time.sleep(0.2)
            current = get_export(export["id"], {"id": 1})["export"]
        self.assertEqual(current["status"], "success", current.get("error"))
        output = Path(video_editor._asset_row(self.dependencies, 1, current["output_asset_id"])["preview_path"])
        base_pixel = self.sample_rgb(output, 100, 600)
        overlay_pixel = self.sample_rgb(output, 1100, 100)
        self.assertGreater(base_pixel[0], base_pixel[2] + 80, base_pixel)
        self.assertGreater(overlay_pixel[2], overlay_pixel[0] + 80, overlay_pixel)

    def test_project_rejects_cross_workspace_asset_and_delete_protects_references(self):
        source = self.make_video(self.root / "source.mp4", audio=False)
        row = video_editor._persist_video_asset(
            self.dependencies,
            user_id=1,
            source=source,
            name="隔离素材",
            source_type="upload",
            source_ref="upload:isolation",
        )
        create_project = self.endpoint("/api/video/editor/projects", "POST")
        with self.assertRaises(HTTPException) as denied:
            create_project(
                video_editor.VideoProjectPayload(name="越权", clips=[{"asset_id": row["id"], "start": 0, "end": 0.5}]),
                {"id": 2},
            )
        self.assertEqual(denied.exception.status_code, 400)

        create_project(
            video_editor.VideoProjectPayload(name="引用保护", clips=[{"asset_id": row["id"], "start": 0, "end": 0.5}]),
            {"id": 1},
        )
        delete_asset = self.endpoint("/api/video/editor/assets/{asset_id}", "DELETE")
        with self.assertRaises(HTTPException) as protected:
            delete_asset(row["id"], {"id": 1})
        self.assertEqual(protected.exception.status_code, 409)

    def test_asset_list_uses_stable_server_pagination_search_and_source_filter(self):
        now = int(time.time())
        conn = sqlite3.connect(self.db_path)
        try:
            for index in range(31):
                source_type = "generated" if index % 2 == 0 else "upload"
                conn.execute(
                    """
                    INSERT INTO video_assets(
                      id, user_id, source_type, source_task_id, source_ref, name, original_path, preview_path,
                      thumbnail_path, mime_type, size_bytes, duration, width, height, has_audio, status, error,
                      created_at, updated_at
                    ) VALUES (?, 1, ?, '', ?, ?, ?, ?, '', 'video/mp4', 10, 1, 320, 180, 0, 'ready', '', ?, ?)
                    """,
                    (f"video_page_{index:03d}", source_type, f"ref:{index}", f"记录 {index:02d}", str(self.root / f"{index}.mp4"), str(self.root / f"{index}.mp4"), now, now),
                )
            conn.commit()
        finally:
            conn.close()

        endpoint = self.endpoint("/api/video/editor/assets", "GET")
        first = endpoint(page=1, page_size=10, source_type="generated", q="记录", sync_generated=False, user={"id": 1})
        second = endpoint(page=2, page_size=10, source_type="generated", q="记录", sync_generated=False, user={"id": 1})
        self.assertEqual(first["total"], 16)
        self.assertEqual(first["total_pages"], 2)
        self.assertEqual(len(first["items"]), 10)
        self.assertEqual(len(second["items"]), 6)
        self.assertTrue(set(item["id"] for item in first["items"]).isdisjoint(item["id"] for item in second["items"]))

    def test_project_rejects_duplicate_clip_ids_and_non_finite_values(self):
        source = self.make_video(self.root / "validation.mp4", audio=False)
        row = video_editor._persist_video_asset(
            self.dependencies, user_id=1, source=source, name="验证素材", source_type="upload", source_ref="upload:validation",
        )
        create_project = self.endpoint("/api/video/editor/projects", "POST")
        duplicate = [
            {"id": "clip_duplicate_001", "asset_id": row["id"], "start": 0, "end": 0.4},
            {"id": "clip_duplicate_001", "asset_id": row["id"], "start": 0.4, "end": 0.8},
        ]
        with self.assertRaises(HTTPException) as duplicated:
            create_project(video_editor.VideoProjectPayload(name="重复", clips=duplicate), {"id": 1})
        self.assertEqual(duplicated.exception.status_code, 400)
        with self.assertRaises(HTTPException) as non_finite:
            create_project(
                video_editor.VideoProjectPayload(name="无效", clips=[{"asset_id": row["id"], "start": float("nan"), "end": 0.8}]),
                {"id": 1},
            )
        self.assertEqual(non_finite.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
