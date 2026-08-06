from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.ecommerce_seeding_renderer import template_filter
from video_core.source_backend import ArchivedSourceBackend


class _MockSeedingBackend(ArchivedSourceBackend):
    def __init__(self) -> None:
        super().__init__()
        self.video_submissions = 0
        self.image_generations: list[dict] = []

    def _submit_and_poll(self, **_kwargs):
        self.video_submissions += 1
        raise AssertionError("seeding templates must not submit the paid video workflow")

    def image_generate(self, *, task_id, payload, context):
        self.image_generations.append({"task_id": task_id, "payload": dict(payload)})
        output_dir = Path(payload["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        image_path = output_dir / "scene.png"
        image_path.write_bytes(b"scene")
        index = len(self.image_generations)
        return {
            "ok": True,
            "image_path": str(image_path),
            "image_paths": [str(image_path)],
            "runninghub_task_id": f"rh-image-{index}",
            "runninghub_task_ids": [f"rh-image-{index}"],
            "runninghub_usage": {
                "consumeCoins": float(index),
                "consumeMoney": 0.1 * index,
                "thirdPartyConsumeMoney": 0.01 * index,
            },
        }


class _UsageBackend(ArchivedSourceBackend):
    def __init__(self) -> None:
        super().__init__()
        self.submissions = 0

    def _resolve_media(self, **kwargs):
        return f"https://media.invalid/{kwargs['media_kind']}"

    def _submit_and_poll(self, **kwargs):
        self.submissions += 1
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"video")
        return {
            "status": "success",
            "runninghub_task_id": f"rh-video-{self.submissions}",
            "usage": {
                "consumeCoins": self.submissions,
                "consumeMoney": 0.25 * self.submissions,
                "thirdPartyConsumeMoney": 0.05 * self.submissions,
            },
        }


class EcommerceSeedingBackendTests(unittest.TestCase):
    @staticmethod
    def _context() -> VideoTaskContext:
        return VideoTaskContext(task_id="task-seeding", task_type="ecommerce_short_video")

    @staticmethod
    def _fake_local_process(commands: list[list[str]]):
        def run(command, **_kwargs):
            commands.append(command)
            output = Path(command[-1])
            if output.suffix.lower() in {".jpg", ".jpeg"}:
                Image.new("RGB", (120, 80), "navy").save(output, format="JPEG")
            else:
                output.write_bytes(b"rendered")
            return 0, "", ""

        return run

    def test_template_filters_are_distinct_and_reject_unknown_templates(self):
        filters = {key: template_filter(key, width=720, height=1280) for key in ("template_b", "template_d", "template_f")}
        self.assertEqual(len(set(filters.values())), 3)
        with self.assertRaisesRegex(ValueError, "template_b"):
            template_filter("template_x", width=720, height=1280)

    def test_seeding_template_uses_local_renderer_checkpoints_and_aggregates_image_usage(self):
        backend = _MockSeedingBackend()
        commands: list[list[str]] = []
        checkpoints: list[dict] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            product = Path(tmpdir) / "product.png"
            product.write_bytes(b"product")
            with patch(
                "video_core.source_backend._run_local_process",
                side_effect=self._fake_local_process(commands),
            ):
                result = backend.ecommerce_short_video(
                    task_id="task-local-seeding",
                    payload={
                        "output_dir": tmpdir,
                        "product_image_local_path": str(product),
                        "ecommerce_video_mode": "seeding_video",
                        "content_mode": "planting",
                        "ecommerce_seeding_template": "template_d",
                        "storyboard": [
                            {"duration": 4, "visual_prompt": "opening scene"},
                            {"duration": 5, "visual_prompt": "product demonstration"},
                        ],
                        "prompt": "natural product recommendation",
                        "ffmpeg_path": "fake-ffmpeg",
                        "resume_runninghub_task_id": "rh-resume-image",
                        "_checkpoint_video_progress": lambda **values: checkpoints.append(values),
                    },
                    context=self._context(),
                )

        self.assertTrue(result["ok"])
        self.assertEqual(backend.video_submissions, 0)
        self.assertEqual(len(backend.image_generations), 2)
        self.assertEqual(backend.image_generations[0]["payload"]["resume_runninghub_task_id"], "rh-resume-image")
        self.assertNotIn("resume_runninghub_task_id", backend.image_generations[1]["payload"])
        self.assertEqual(result["raw_result"]["local_renderer"], "ffmpeg_programmatic_seeding_v1")
        self.assertEqual(result["raw_result"]["ecommerce_seeding_template"], "template_d")
        self.assertEqual(result["runninghub_task_ids"], ["rh-image-1", "rh-image-2"])
        self.assertEqual(
            result["runninghub_usage"],
            {"consumeCoins": 3.0, "consumeMoney": 0.3, "thirdPartyConsumeMoney": 0.03},
        )
        self.assertEqual([item["completed_segment"]["index"] for item in checkpoints], [1, 2])
        self.assertTrue(any("drawbox" in " ".join(command) for command in commands))

    def test_seeding_resume_reuses_completed_segment_without_regeneration(self):
        backend = _MockSeedingBackend()
        commands: list[list[str]] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            product = Path(tmpdir) / "product.png"
            product.write_bytes(b"product")
            completed = Path(tmpdir) / "completed.mp4"
            completed.write_bytes(b"completed")
            with patch(
                "video_core.source_backend._run_local_process",
                side_effect=self._fake_local_process(commands),
            ):
                result = backend.ecommerce_short_video(
                    task_id="task-local-resume",
                    payload={
                        "output_dir": tmpdir,
                        "product_image_local_path": str(product),
                        "ecommerce_video_mode": "seeding_video",
                        "ecommerce_seeding_template": "template_f",
                        "storyboard": [
                            {"duration": 4, "visual_prompt": "done"},
                            {"duration": 5, "visual_prompt": "remaining"},
                        ],
                        "completed_segments": [{"index": 1, "path": str(completed), "duration_seconds": 4}],
                        "ffmpeg_path": "fake-ffmpeg",
                    },
                    context=self._context(),
                )

        self.assertTrue(result["ok"])
        self.assertEqual(len(backend.image_generations), 1)
        self.assertTrue(result["raw_result"]["segments"][0]["skipped"])

    def test_seeding_final_video_reuses_confirmed_scene_images_without_regenerating(self):
        backend = _MockSeedingBackend()
        commands: list[list[str]] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            product = root / "product.png"
            scene_one = root / "confirmed-1.png"
            scene_two = root / "confirmed-2.png"
            for item in (product, scene_one, scene_two):
                item.write_bytes(item.stem.encode())
            with patch(
                "video_core.source_backend._run_local_process",
                side_effect=self._fake_local_process(commands),
            ):
                result = backend.ecommerce_short_video(
                    task_id="task-local-confirmed",
                    payload={
                        "output_dir": tmpdir,
                        "product_image_local_path": str(product),
                        "ecommerce_video_mode": "seeding_video",
                        "ecommerce_seeding_operation": "final_video",
                        "ecommerce_seeding_confirmed_image_paths": [str(scene_one), str(scene_two)],
                        "ecommerce_seeding_template": "template_b",
                        "storyboard": [
                            {"duration": 4, "visual_prompt": "first"},
                            {"duration": 5, "visual_prompt": "second"},
                        ],
                        "ffmpeg_path": "fake-ffmpeg",
                    },
                    context=self._context(),
                )

        self.assertTrue(result["ok"])
        self.assertEqual(backend.image_generations, [])
        self.assertEqual(
            result["raw_result"]["generated_scene_image_paths"],
            [str(scene_one.resolve()), str(scene_two.resolve())],
        )

    def test_seeding_honors_task_cancellation_before_provider_or_ffmpeg_work(self):
        backend = _MockSeedingBackend()
        cancel_event = threading.Event()
        cancel_event.set()
        with tempfile.TemporaryDirectory() as tmpdir:
            product = Path(tmpdir) / "product.png"
            product.write_bytes(b"product")
            with self.assertRaises(VideoTaskCancelled):
                backend.ecommerce_short_video(
                    task_id="task-local-cancelled",
                    payload={
                        "output_dir": tmpdir,
                        "product_image_local_path": str(product),
                        "ecommerce_video_mode": "seeding_video",
                        "ecommerce_seeding_template": "template_b",
                        "storyboard": [{"duration": 4, "visual_prompt": "cancelled"}],
                        "ffmpeg_path": "fake-ffmpeg",
                    },
                    context=VideoTaskContext(
                        task_id="task-local-cancelled",
                        task_type="ecommerce_short_video",
                        cancel_event=cancel_event,
                    ),
                )

        self.assertEqual(backend.video_submissions, 0)
        self.assertEqual(backend.image_generations, [])

    def test_advertising_video_aggregates_each_provider_usage(self):
        backend = _UsageBackend()
        commands: list[list[str]] = []
        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "video_core.source_backend._run_local_process",
            side_effect=self._fake_local_process(commands),
        ):
            result = backend.ecommerce_short_video(
                task_id="task-ad-usage",
                payload={
                    "output_dir": tmpdir,
                    "product_image_local_path": str(Path(tmpdir) / "product.png"),
                    "duration_seconds": 20,
                    "prompt": "advertising video",
                    "ffmpeg_path": "fake-ffmpeg",
                },
                context=self._context(),
            )

        self.assertEqual(backend.submissions, 2)
        self.assertEqual(
            result["runninghub_usage"],
            {"consumeCoins": 3.0, "consumeMoney": 0.75, "thirdPartyConsumeMoney": 0.15},
        )

    def test_image_generation_aggregates_each_provider_usage(self):
        calls = 0

        def generate_image(**kwargs):
            nonlocal calls
            calls += 1
            Path(kwargs["output_image_path"]).write_bytes(b"image")
            return {
                "image_path": kwargs["output_image_path"],
                "runninghub_task_id": f"rh-image-{calls}",
                "usage": {
                    "consumeCoins": calls,
                    "consumeMoney": 0.2 * calls,
                    "thirdPartyConsumeMoney": 0.02 * calls,
                },
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            product = Path(tmpdir) / "product.png"
            product.write_bytes(b"product")
            with patch("video_core.source_backend.image_model_api.generate_image", side_effect=generate_image):
                result = ArchivedSourceBackend().image_generate(
                    task_id="task-image-usage",
                    payload={
                        "output_dir": tmpdir,
                        "video_image_mode": "product_only",
                        "product_image_local_path": str(product),
                        "prompt": "product advertising image",
                        "count": 2,
                    },
                    context=VideoTaskContext(task_id="task-image-usage", task_type="image_generate"),
                )

        self.assertEqual(calls, 2)
        self.assertEqual(
            result["runninghub_usage"],
            {"consumeCoins": 3.0, "consumeMoney": 0.6, "thirdPartyConsumeMoney": 0.06},
        )


if __name__ == "__main__":
    unittest.main()
