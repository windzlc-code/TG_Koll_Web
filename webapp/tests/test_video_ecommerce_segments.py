from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


class _SegmentBackend(ArchivedSourceBackend):
    def __init__(self) -> None:
        super().__init__()
        self.submissions: list[dict] = []

    def _resolve_media(self, **kwargs):
        return f"https://media.invalid/{kwargs['media_kind']}"

    def _submit_and_poll(self, **kwargs):
        self.submissions.append(kwargs)
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(f"segment-{len(self.submissions)}".encode())
        provider_id = f"rh-segment-{len(self.submissions)}"
        return {"status": "success", "runninghub_task_id": provider_id, "provider_task_id": provider_id}


class EcommerceVideoSegmentTests(unittest.TestCase):
    @staticmethod
    def _context() -> VideoTaskContext:
        return VideoTaskContext(task_id="task-ecommerce-segments", task_type="ecommerce_short_video")

    @staticmethod
    def _fake_ffmpeg(commands: list[list[str]]):
        def run(command, **_kwargs):
            commands.append(command)
            Path(command[-1]).write_bytes(b"concatenated")
            return 0, "", ""

        return run

    def test_advertising_over_15_seconds_splits_concats_subtitles_and_checkpoints(self):
        backend = _SegmentBackend()
        commands: list[list[str]] = []
        checkpoints: list[dict] = []

        def checkpoint(**values):
            checkpoints.append(values)

        def apply_subtitles(**values):
            self.assertEqual(Path(values["video_path"]).name, "ecommerce_short_video.mp4")
            subtitled = Path(values["workdir"]) / "ecommerce_short_video_subtitled.mp4"
            subtitled.write_bytes(b"subtitled")
            return subtitled, 2, ""

        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "video_core.source_backend._run_local_process",
            side_effect=self._fake_ffmpeg(commands),
        ), patch.object(backend, "_apply_optional_subtitles", side_effect=apply_subtitles) as subtitle_mock:
            result = backend.ecommerce_short_video(
                task_id="task-advertising",
                payload={
                    "output_dir": tmpdir,
                    "product_image_local_path": str(Path(tmpdir) / "product.png"),
                    "content_mode": "advertising",
                    "duration_seconds": 31,
                    "prompt": "campaign prompt",
                    "ffmpeg_path": "fake-ffmpeg",
                    "_checkpoint_video_progress": checkpoint,
                },
                context=self._context(),
            )

        self.assertTrue(result["ok"])
        self.assertEqual([call["submit_payload"]["duration"] for call in backend.submissions], ["15", "15", "1"])
        self.assertEqual(len(commands), 1)
        self.assertIn("concat", commands[0])
        subtitle_mock.assert_called_once()
        self.assertEqual(result["subtitle_count"], 2)
        self.assertEqual([item["completed_segment"]["index"] for item in checkpoints], [1, 2, 3])
        self.assertEqual(
            set(checkpoints[0]["completed_segment"]),
            {"index", "path", "duration_seconds", "runninghub_task_id"},
        )

    def test_planting_uses_each_storyboard_timing_prompt_and_provider_id(self):
        backend = _SegmentBackend()
        commands: list[list[str]] = []
        storyboard = [
            {"start": 0, "end": 4.5, "visual_prompt": "macro product reveal", "dialogue": "first line"},
            {"duration": 6, "visual_prompt": "handheld product demo", "dialogue": "second line"},
        ]
        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "video_core.source_backend._run_local_process",
            side_effect=self._fake_ffmpeg(commands),
        ):
            result = backend.ecommerce_short_video(
                task_id="task-planting",
                payload={
                    "output_dir": tmpdir,
                    "product_image_local_path": str(Path(tmpdir) / "product.png"),
                    "content_mode": "planting",
                    "duration_seconds": 99,
                    "prompt": "shared campaign context",
                    "storyboard": storyboard,
                    "ffmpeg_path": "fake-ffmpeg",
                },
                context=self._context(),
            )

        self.assertEqual([call["submit_payload"]["duration"] for call in backend.submissions], ["4.5", "6"])
        self.assertIn("macro product reveal", backend.submissions[0]["submit_payload"]["prompt"])
        self.assertNotIn("handheld product demo", backend.submissions[0]["submit_payload"]["prompt"])
        self.assertIn("handheld product demo", backend.submissions[1]["submit_payload"]["prompt"])
        segments = result["raw_result"]["segments"]
        self.assertEqual([item["duration_seconds"] for item in segments], [4.5, 6.0])
        self.assertEqual([item["runninghub_task_id"] for item in segments], ["rh-segment-1", "rh-segment-2"])
        self.assertEqual([item["prompt"] for item in segments], [
            backend.submissions[0]["submit_payload"]["prompt"],
            backend.submissions[1]["submit_payload"]["prompt"],
        ])

    def test_regenerate_segment_index_submits_only_requested_storyboard_segment(self):
        backend = _SegmentBackend()
        storyboard = [
            {"start": 0, "end": 5, "visual_prompt": "first scene"},
            {"start": 5, "end": 12, "visual_prompt": "replacement scene"},
            {"start": 12, "end": 15, "visual_prompt": "third scene"},
        ]
        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "video_core.source_backend._run_local_process",
            side_effect=AssertionError("single-segment regeneration must not run concat"),
        ):
            result = backend.ecommerce_short_video(
                task_id="task-regenerate",
                payload={
                    "output_dir": tmpdir,
                    "product_image_local_path": str(Path(tmpdir) / "product.png"),
                    "content_mode": "planting",
                    "storyboard": storyboard,
                    "regenerate_segment_index": 2,
                },
                context=self._context(),
            )

        self.assertEqual(len(backend.submissions), 1)
        self.assertEqual(backend.submissions[0]["submit_payload"]["duration"], "7")
        self.assertIn("replacement scene", backend.submissions[0]["submit_payload"]["prompt"])
        self.assertEqual([item["index"] for item in result["raw_result"]["segments"]], [2])

    def test_completed_segment_with_local_path_is_skipped_during_resume(self):
        backend = _SegmentBackend()
        commands: list[list[str]] = []
        checkpoints: list[dict] = []
        storyboard = [
            {"start": 0, "end": 5, "visual_prompt": "already complete"},
            {"start": 5, "end": 10, "visual_prompt": "still needed"},
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            completed_path = Path(tmpdir) / "persisted-segment-1.mp4"
            completed_path.write_bytes(b"existing")
            with patch(
                "video_core.source_backend._run_local_process",
                side_effect=self._fake_ffmpeg(commands),
            ):
                result = backend.ecommerce_short_video(
                    task_id="task-resume",
                    payload={
                        "output_dir": tmpdir,
                        "product_image_local_path": str(Path(tmpdir) / "product.png"),
                        "content_mode": "planting",
                        "storyboard": storyboard,
                        "ffmpeg_path": "fake-ffmpeg",
                        "completed_segments": [{
                            "index": 1,
                            "path": str(completed_path),
                            "duration_seconds": 5,
                            "runninghub_task_id": "rh-existing",
                        }],
                        "_checkpoint_video_progress": lambda **values: checkpoints.append(values),
                    },
                    context=self._context(),
                )

        self.assertEqual(len(backend.submissions), 1)
        self.assertIn("still needed", backend.submissions[0]["submit_payload"]["prompt"])
        self.assertEqual([item["runninghub_task_id"] for item in result["raw_result"]["segments"]], ["rh-existing", "rh-segment-1"])
        self.assertTrue(result["raw_result"]["segments"][0]["skipped"])
        self.assertEqual([item["completed_segment"]["index"] for item in checkpoints], [2])
        self.assertEqual(len(commands), 1)


if __name__ == "__main__":
    unittest.main()
