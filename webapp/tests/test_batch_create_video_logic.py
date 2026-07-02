import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from webapp import db as db_module
import webapp.server as server


class BatchCreateVideoLogicTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._old_upload_root = server.UPLOAD_ROOT
        self._old_output_root = server.OUTPUT_ROOT
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "app.db")
        self.runtime_config_path = Path(self._tmpdir.name) / "runtime_config.json"
        os.environ["APP_DB_PATH"] = self.db_path
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.runtime_config_path)
        server.RUNTIME_CONFIG_PATH = self.runtime_config_path
        db_module.init_db()
        now = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO users(id, username, password_hash, is_admin, balance_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (1, "admin", "test-hash", 1, 10000, now, now),
            )
        self.admin_user = {"id": 1, "username": "admin", "is_admin": 1, "balance_cents": 10000}

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        server.UPLOAD_ROOT = self._old_upload_root
        server.OUTPUT_ROOT = self._old_output_root
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

    def _make_plan_zip(self, plan_id: str, files: dict[str, bytes]) -> Path:
        safe = "admin"
        plan_dir = Path(self._tmpdir.name) / "uploads" / safe / plan_id
        plan_dir.mkdir(parents=True, exist_ok=True)
        zip_path = plan_dir / "batch_zip.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for rel_path, content in files.items():
                zf.writestr(rel_path, content)
        return zip_path

    def _write_tree_file(self, root: Path, rel_path: str, content: bytes = b"x") -> None:
        target = root / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    def test_scan_batch_items_preserves_legacy_standard_folder(self):
        root = Path(self._tmpdir.name) / "scan_standard"
        self._write_tree_file(root, "group_a/model.png", b"m")
        self._write_tree_file(root, "group_a/product.png", b"p")

        items = server._scan_batch_items(root)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["model_image"], "group_a/model.png")
        self.assertEqual(items[0]["product_image"], "group_a/product.png")
        self.assertEqual(items[0]["match_mode"], "legacy_folder")

    def test_scan_batch_items_strict_pairs_numbered_media_and_allows_missing_audio(self):
        root = Path(self._tmpdir.name) / "scan_strict"
        self._write_tree_file(root, "audio/1.wav", b"a1")
        self._write_tree_file(root, "model/1.png", b"m1")
        self._write_tree_file(root, "model/2.png", b"m2")
        self._write_tree_file(root, "product/1.png", b"p1")
        self._write_tree_file(root, "product/2.png", b"p2")

        items = server._scan_batch_items(root)

        self.assertEqual([it["match_key"] for it in items], ["1", "2"])
        self.assertEqual(items[0]["model_image"], "model/1.png")
        self.assertEqual(items[0]["product_image"], "product/1.png")
        self.assertEqual(items[0]["audio"], "audio/1.wav")
        self.assertEqual(items[0]["audio_match_state"], "matched")
        self.assertEqual(items[0]["match_mode"], "exact_stem")
        self.assertEqual(items[1]["audio"], "")
        self.assertEqual(items[1]["audio_match_state"], "missing")

    def test_scan_batch_items_handles_deep_paths_with_stable_order(self):
        root = Path(self._tmpdir.name) / "scan_deep"
        self._write_tree_file(root, "foo/x/model/look_002.png", b"m2")
        self._write_tree_file(root, "bar/y/product/look_001.png", b"p1")
        self._write_tree_file(root, "baz/audio/look_001.wav", b"a1")
        self._write_tree_file(root, "foo/x/model/look_001.png", b"m1")
        self._write_tree_file(root, "bar/y/product/look_002.png", b"p2")

        items_a = server._scan_batch_items(root)
        items_b = server._scan_batch_items(root)

        self.assertEqual([it["match_key"] for it in items_a], ["look_001", "look_002"])
        self.assertEqual([it["match_key"] for it in items_b], ["look_001", "look_002"])
        self.assertEqual(items_a, items_b)
        self.assertEqual(items_a[0]["audio"], "baz/audio/look_001.wav")

    def test_scan_batch_items_raises_on_ambiguous_product_match(self):
        root = Path(self._tmpdir.name) / "scan_ambiguous"
        self._write_tree_file(root, "model/1.png", b"m1")
        self._write_tree_file(root, "product/a/1.png", b"p1")
        self._write_tree_file(root, "product/b/1.png", b"p2")

        with self.assertRaises(RuntimeError) as ctx:
            server._scan_batch_items(root)

        self.assertIn("存在歧义配对", str(ctx.exception))

    def test_build_batch_payload_from_uploaded_zips_strict_pairs_cross_dirs(self):
        zip_path = Path(self._tmpdir.name) / "strict_batch.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("audio/1.wav", b"a1")
            zf.writestr("model/1.png", b"m1")
            zf.writestr("model/2.png", b"m2")
            zf.writestr("product/1.png", b"p1")
            zf.writestr("product/2.png", b"p2")

        payload = server._build_batch_payload_from_uploaded_zips(
            zips=[{"path": str(zip_path), "name": "strict_batch.zip"}],
            params={"batch_params": [{"speech_text": "a"}, {"speech_text": "b"}]},
        )

        self.assertEqual(len(payload["items"]), 2)
        self.assertEqual(payload["items"][0]["model_image"], "z0/model/1.png")
        self.assertEqual(payload["items"][0]["product_image"], "z0/product/1.png")
        self.assertEqual(payload["items"][0]["audio"], "z0/audio/1.wav")
        self.assertEqual(payload["items"][0]["match_mode"], "exact_stem")
        self.assertEqual(payload["items"][1]["audio"], "")
        self.assertEqual(payload["items"][1]["audio_match_state"], "missing")
        self.assertEqual(payload["items"][0]["params"]["speech_text"], "a")
        self.assertEqual(payload["items"][1]["params"]["speech_text"], "b")

    def test_batch_run_preserves_audio_field_in_normalized_items(self):
        server.UPLOAD_ROOT = Path(self._tmpdir.name) / "uploads"
        plan_id = "plan_1234567890abcdef1234"
        self._make_plan_zip(plan_id, {"model.png": b"m", "product.png": b"p"})
        endpoint = self._route_endpoint("/api/batch/create_video/run", "POST")
        captured: dict[str, object] = {}

        with patch.object(server, "_enqueue_task", side_effect=lambda task_id, user_id, task_type, payload: captured.update({"task_id": task_id, "user_id": user_id, "task_type": task_type, "payload": payload})):
            resp = endpoint(
                {
                    "plan_id": plan_id,
                    "plan": {
                        "defaults": {"speech_text": "hello"},
                        "items": [
                            {"id": "item_1", "model_image": "z0/model.png", "product_image": "z0/product.png", "audio": "z0/voice.mp3", "params": {}},
                            {"id": "item_2", "model_image": "z0/model.png", "product_image": "z0/product.png", "audio_file": "z0/voice2.mp3", "params": {}},
                        ],
                    },
                },
                self.admin_user,
            )

        self.assertTrue(resp["ok"])
        items = captured["payload"]["items"]
        self.assertEqual(items[0]["audio"], "z0/voice.mp3")
        self.assertEqual(items[1]["audio"], "z0/voice2.mp3")

    def test_build_task_workdir_uses_fallback_username(self):
        workdir = server._build_task_workdir("task_without_db_row", fallback_username="admin")
        self.assertEqual(workdir.parts[-2:], ("admin", "task_without_db_row"))
        self.assertTrue(workdir.exists())

    @patch.object(server, "_run_create_video_with_doubao")
    def test_run_batch_create_video_passes_upload_file_api_key(self, mock_run_single):
        server.UPLOAD_ROOT = Path(self._tmpdir.name) / "uploads"
        server.OUTPUT_ROOT = Path(self._tmpdir.name) / "outputs"
        server._write_runtime_config_file(
            {
                "runninghub_api_key": "rh-secret",
                "upload_file_api_key": "upload-secret",
                "nano_api_key": "nano-secret",
        "nano_host": "202.90.21.53",
                "gemini_api_key": "gemini-secret",
        "gemini_host": "202.90.21.53",
                "create_audio_app_id": "audio-app",
                "create_video_app_id": "video-app",
                "video_app_id": "video-app",
            }
        )
        server._create_task_record("task_batch_logic", 1, "batch_create_video", {})
        zip_path = Path(self._tmpdir.name) / "batch.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("model.png", b"m")
            zf.writestr("product.png", b"p")
        mock_run_single.return_value = {"ok": True, "video_path": "", "runninghub_usage": {}, "nano_images": 0}

        server._run_batch_create_video(
            "task_batch_logic",
            {
                "zip_path": str(zip_path),
                "defaults": {"speech_text": "hello", "prompt_text": "prompt"},
                "items": [{"id": "item_1", "model_image": "z0/model.png", "product_image": "z0/product.png", "params": {}}],
                "_user_id": 1,
                "_username": "admin",
            },
        )

        sent_payload = mock_run_single.call_args[0][1]
        self.assertEqual(sent_payload["upload_file_api_key"], "upload-secret")
        self.assertEqual(sent_payload["_username"], "admin")

    @patch.object(server, "_run_create_video_with_doubao")
    def test_run_batch_create_video_reports_missing_audio_file(self, mock_run_single):
        server.UPLOAD_ROOT = Path(self._tmpdir.name) / "uploads"
        server.OUTPUT_ROOT = Path(self._tmpdir.name) / "outputs"
        server._write_runtime_config_file({"runninghub_api_key": "rh-secret"})
        server._create_task_record("task_batch_missing_audio", 1, "batch_create_video", {})
        zip_path = Path(self._tmpdir.name) / "batch_missing_audio.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("model.png", b"m")
            zf.writestr("product.png", b"p")

        result = server._run_batch_create_video(
            "task_batch_missing_audio",
            {
                "zip_path": str(zip_path),
                "defaults": {"speech_text": "hello", "prompt_text": "prompt"},
                "items": [{"id": "item_1", "model_image": "z0/model.png", "product_image": "z0/product.png", "audio": "z0/missing.mp3", "params": {}}],
                "_user_id": 1,
                "_username": "admin",
            },
        )

        self.assertFalse(result["ok"])
        self.assertIn("音频文件不存在", result["items"][0]["error"])
        mock_run_single.assert_not_called()


if __name__ == "__main__":
    unittest.main()
