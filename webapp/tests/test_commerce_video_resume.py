import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import commerce_video_generator
from webapp import db as db_module
import webapp.server as server


class CommerceVideoResumeTests(unittest.TestCase):
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
        now = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO users(id, username, password_hash, is_admin, balance_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (1, "admin", "test-hash", 1, 10000, now, now),
            )
        self.admin_user = {"id": 1, "username": "admin", "is_admin": 1, "balance_cents": 10000}

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

    def test_retry_resume_creates_new_resume_task(self):
        payload = {
            "video_app_id": "2018758760096862209",
            "runninghub_api_key": "rh-secret",
            "nano_api_key": "nano-secret",
        "nano_host": "202.90.21.53",
            "gemini_api_key": "gemini-secret",
        "gemini_host": "202.90.21.53",
        }
        server._create_task_record("task_resume_source", 1, "commerce_video", payload)
        with db_module.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                ("failed", "mock failed", server._now_ts(), "task_resume_source"),
            )
        workdir = server._build_task_workdir("task_resume_source")
        (workdir / "commerce_out").mkdir(parents=True, exist_ok=True)
        (workdir / "commerce_out" / "logs.jsonl").write_text("", encoding="utf-8")

        retry_resume = self._route_endpoint("/api/tasks/{task_id}/retry_resume", "POST")
        with patch.object(server, "_enqueue_task", side_effect=server._create_task_record):
            resp = retry_resume("task_resume_source", self.admin_user)

        self.assertEqual(resp["task_type"], "commerce_video")
        self.assertEqual(resp["source_task_id"], "task_resume_source")
        self.assertEqual(resp["retry_mode"], "resume")
        with db_module.db() as conn:
            row = conn.execute("SELECT input_json FROM tasks WHERE id = ?", (resp["id"],)).fetchone()
        stored = json.loads(row["input_json"])
        self.assertEqual(stored["resume_from_task_id"], "task_resume_source")
        self.assertEqual(stored["retry_mode"], "resume")

    @patch("commerce_video_generator.upload_binary")
    @patch("commerce_video_generator._generate_audio")
    @patch("commerce_video_generator.create_video.requests_api")
    def test_generate_commerce_videos_skips_finished_job_in_resume_mode(
        self,
        mock_video_api,
        mock_generate_audio,
        mock_upload,
    ):
        root = Path(self._tmpdir.name)
        product_dir = root / "products"
        model_dir = root / "models"
        out_dir = root / "commerce_out"
        (product_dir).mkdir(parents=True, exist_ok=True)
        (model_dir).mkdir(parents=True, exist_ok=True)
        (out_dir / "videos").mkdir(parents=True, exist_ok=True)

        (product_dir / "1.png").write_bytes(b"fake-product")
        (model_dir / "1.png").write_bytes(b"fake-model")
        (out_dir / "videos" / "1.mp4").write_bytes(b"fake-video")

        result = commerce_video_generator.generate_commerce_videos(
            runninghub_api_key="rh-secret",
            upload_api_key="rh-secret",
            product_dir=str(product_dir),
            model_dir=str(model_dir),
            output_dir=str(out_dir),
            batch=commerce_video_generator.BatchSettings(output_dir=str(out_dir), resume=True),
            audio_settings=commerce_video_generator.AudioSettings(),
            nano_settings=commerce_video_generator.NanoSettings(),
            video_workflow=commerce_video_generator.VideoWorkflowSettings(app_id="2018758760096862209"),
            speech_text_provider=lambda *_: "speech",
            prompt_provider=lambda *_: "prompt",
            logger=lambda *_args, **_kwargs: None,
        )

        self.assertEqual(result["success"], 1)
        self.assertTrue((out_dir / "result.zip").exists())
        mock_video_api.assert_not_called()
        mock_generate_audio.assert_not_called()
        mock_upload.assert_not_called()

    @patch("commerce_video_generator.upload_binary", side_effect=["https://example.com/scene.png", "https://example.com/1.mp3"])
    @patch("commerce_video_generator._generate_audio")
    @patch("commerce_video_generator._probe_media_duration_seconds", return_value=10.0)
    @patch("commerce_video_generator._compose_reference_image")
    @patch("commerce_video_generator.create_video.requests_api")
    def test_generate_commerce_videos_uses_existing_scene_image_without_nano_generation(
        self,
        mock_video_api,
        mock_compose_reference,
        _mock_probe_duration,
        mock_generate_audio,
        mock_upload,
    ):
        root = Path(self._tmpdir.name)
        product_dir = root / "products_scene"
        model_dir = root / "models_scene"
        out_dir = root / "commerce_out_scene"
        product_dir.mkdir(parents=True, exist_ok=True)
        model_dir.mkdir(parents=True, exist_ok=True)
        (product_dir / "1.png").write_bytes(b"fake-product")
        (model_dir / "1.png").write_bytes(b"fake-model")

        existing_scene = root / "existing_scene.png"
        existing_scene.write_bytes(b"scene")
        generated_audio = out_dir / "audio" / "1.mp3"
        generated_audio.parent.mkdir(parents=True, exist_ok=True)
        generated_audio.write_bytes(b"audio")
        generated_video = out_dir / "videos" / "1.mp4"
        generated_video.parent.mkdir(parents=True, exist_ok=True)
        generated_video.write_bytes(b"video")

        mock_generate_audio.return_value = generated_audio
        mock_compose_reference.return_value = out_dir / "images" / "1_ref.png"
        mock_video_api.return_value = {"status": "success", "message": ""}

        result = commerce_video_generator.generate_commerce_videos(
            runninghub_api_key="rh-secret",
            upload_api_key="rh-secret",
            product_dir=str(product_dir),
            model_dir=str(model_dir),
            output_dir=str(out_dir),
            batch=commerce_video_generator.BatchSettings(output_dir=str(out_dir), resume=False),
            audio_settings=commerce_video_generator.AudioSettings(),
            nano_settings=commerce_video_generator.NanoSettings(),
            video_workflow=commerce_video_generator.VideoWorkflowSettings(app_id="2018758760096862209"),
            speech_text_provider=lambda *_: "speech",
            prompt_provider=lambda *_: "prompt",
            audio_path_provider=None,
            image_path_provider=lambda *_: str(existing_scene),
            logger=lambda *_args, **_kwargs: None,
        )

        self.assertEqual(result["success"], 1)
        mock_upload.assert_any_call(api_key="rh-secret", file_path=existing_scene, cache=unittest.mock.ANY, media_kind="image")

    def test_fast_path_with_generated_scene_does_not_require_nano_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            model = tmp / "model.png"
            scene = tmp / "scene.png"
            model.write_bytes(b"model")
            scene.write_bytes(b"scene")
            output_dir = tmp / "commerce_out"
            output_videos = output_dir / "videos"
            output_videos.mkdir(parents=True, exist_ok=True)
            (output_videos / "1.mp4").write_bytes(b"video")
            payload = {
                "runninghub_api_key": "rh-key",
                "model_image_local_path": str(model),
                "product_image_local_path": str(scene),
                "generated_scene_image_local_path": str(scene),
                "speech_text": "口播文案",
                "prompt_text": "提示词",
                "product_name": "耳环",
                "style_hint": "真实电商场景",
                "create_audio_app_id": "2027189109067878402",
                "video_app_id": "2018758760096862209",
            }
            with patch.object(server, "_build_task_workdir", return_value=tmp), \
                 patch.object(server.commerce_video_generator, "generate_commerce_videos", return_value={"success": 1, "output_dir": str(output_dir)}):
                result = server._run_create_video_with_doubao("task_fast_path", payload)
    @patch("commerce_video_generator.upload_binary", side_effect=["https://example.com/1.png", "https://example.com/1.mp3"])
    @patch("commerce_video_generator._generate_audio")
    @patch("commerce_video_generator._probe_media_duration_seconds", return_value=10.0)
    @patch("commerce_video_generator._compose_reference_image")
    @patch("commerce_video_generator.create_video.requests_api")
    def test_generate_commerce_videos_emits_structured_progress(
        self,
        mock_video_api,
        mock_compose_reference,
        _mock_probe_duration,
        mock_generate_audio,
        mock_upload,
    ):
        root = Path(self._tmpdir.name)
        product_dir = root / "products_p"
        model_dir = root / "models_p"
        out_dir = root / "commerce_out_p"
        product_dir.mkdir(parents=True, exist_ok=True)
        model_dir.mkdir(parents=True, exist_ok=True)
        (product_dir / "1.png").write_bytes(b"fake-product")
        (model_dir / "1.png").write_bytes(b"fake-model")
        generated_audio = out_dir / "audio" / "1.mp3"
        generated_audio.parent.mkdir(parents=True, exist_ok=True)
        generated_audio.write_bytes(b"audio")
        generated_image = out_dir / "images" / "1.png"
        generated_image.parent.mkdir(parents=True, exist_ok=True)
        generated_image.write_bytes(b"image")
        generated_video = out_dir / "videos" / "1.mp4"
        generated_video.parent.mkdir(parents=True, exist_ok=True)
        generated_video.write_bytes(b"video")
        ref_image = out_dir / "images" / "1_ref.png"
        ref_image.write_bytes(b"ref")

        mock_generate_audio.return_value = generated_audio
        mock_compose_reference.return_value = ref_image
        mock_video_api.return_value = {"status": "success", "message": ""}
        progress_events = []

        result = commerce_video_generator.generate_commerce_videos(
            runninghub_api_key="rh-secret",
            upload_api_key="rh-secret",
            product_dir=str(product_dir),
            model_dir=str(model_dir),
            output_dir=str(out_dir),
            batch=commerce_video_generator.BatchSettings(output_dir=str(out_dir), resume=False),
            audio_settings=commerce_video_generator.AudioSettings(),
            nano_settings=commerce_video_generator.NanoSettings(),
            video_workflow=commerce_video_generator.VideoWorkflowSettings(app_id="2018758760096862209"),
            speech_text_provider=lambda *_: "speech",
            prompt_provider=lambda *_: "prompt",
            image_path_provider=lambda *_: str(generated_image),
            logger=lambda *_args, **_kwargs: None,
            progress_callback=lambda payload: progress_events.append(payload),
        )

        self.assertEqual(result["success"], 1)
        self.assertGreaterEqual(len(progress_events), 4)
        final_event = progress_events[-1]
        self.assertEqual(final_event["state"], "success")
        self.assertEqual(final_event["data"]["job_index"], 1)
        self.assertEqual(final_event["data"]["job_total"], 1)
        self.assertEqual(final_event["data"]["step"], "video_ready")
        self.assertEqual(final_event["data"]["progress"], 100.0)


if __name__ == "__main__":
    unittest.main()
