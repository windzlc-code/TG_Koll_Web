from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageChops

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.digital_human_cover import (
    _create_digital_human_video_cover,
    _draw_poster_keyword_text,
    _maybe_create_digital_human_video_cover,
    _split_digital_human_video_cover_lines,
)
from video_core.digital_human_pipeline import run_digital_human_pipeline


class _Backend:
    @staticmethod
    def _workdir(task_id: str, payload: dict) -> Path:
        path = Path(payload["output_dir"]) / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path


class DigitalHumanCoverParityTest(unittest.TestCase):
    @staticmethod
    def _context() -> VideoTaskContext:
        return VideoTaskContext(task_id="task-cover", task_type="create_video")

    @staticmethod
    def _file(root: Path, name: str, content: bytes = b"fixture") -> str:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return str(path)

    def test_explicit_cover_keywords_keep_original_split_and_limits(self):
        self.assertEqual(
            _split_digital_human_video_cover_lines(
                {"video_cover_keywords": " 第一卖点 / 第二卖点，第三卖点；第四卖点 "},
                "不会使用这段口播",
            ),
            ["第一卖点", "第二卖点", "第三卖点"],
        )
        self.assertEqual(
            _split_digital_human_video_cover_lines(
                {"product_name": "海景公寓"},
                "大家好，今天介绍核心卖点。第二个亮点非常关键。",
            ),
            ["海景公寓", "介绍核心卖点", "第二个亮点非常关键"],
        )

    def test_draw_poster_preserves_dimensions_and_renders_overlay(self):
        source = Image.new("RGB", (720, 1280), (36, 42, 50))
        rendered = _draw_poster_keyword_text(source, ["核心卖点", "真实体验"])

        self.assertEqual(rendered.mode, "RGB")
        self.assertEqual(rendered.size, source.size)
        self.assertIsNotNone(ImageChops.difference(source, rendered).getbbox())

    def test_create_cover_uses_original_frame_time_and_removes_temporary_frame(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            video_path = root / "merged.mp4"
            video_path.write_bytes(b"local-video")
            output_path = root / "merged_cover.jpg"
            calls: list[dict] = []

            def fake_extract(source, target, **kwargs):
                calls.append({"source": Path(source), "target": Path(target), **kwargs})
                Image.new("RGB", (640, 360), (208, 218, 228)).save(target, format="JPEG")
                return Path(target)

            with patch("video_core.digital_human_cover._extract_video_frame_at", side_effect=fake_extract):
                result = _create_digital_human_video_cover(
                    video_path,
                    output_path,
                    payload={"cover_keywords": "本地封面"},
                    speech_text="口播文案",
                    context=self._context(),
                )

            self.assertEqual(result["path"], str(output_path.resolve()))
            self.assertEqual(result["keyword"], "本地封面")
            self.assertEqual(result["source_video_path"], str(video_path.resolve()))
            self.assertTrue(output_path.is_file())
            self.assertEqual(calls[0]["timestamp_seconds"], 0.2)
            self.assertEqual(calls[0]["context"].task_id, "task-cover")
            self.assertFalse(output_path.with_suffix(".frame.jpg").exists())

    def test_real_local_ffmpeg_cover_smoke_has_no_supplier_dependency(self):
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("local ffmpeg is unavailable")
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            video_path = root / "local.mp4"
            proc = subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=#243447:s=360x640:d=1",
                    "-pix_fmt",
                    "yuv420p",
                    str(video_path),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-800:])

            result = _create_digital_human_video_cover(
                video_path,
                root / "local_cover.jpg",
                payload={"video_cover_keywords": "本地能力/无付费调用", "ffmpeg_path": ffmpeg},
                speech_text="本地测试",
                context=self._context(),
            )

            cover_path = Path(result["path"])
            self.assertTrue(cover_path.is_file())
            with Image.open(cover_path) as cover:
                self.assertEqual(cover.size, (360, 640))

    def test_optional_cover_disable_and_failure_match_original_nonfatal_behavior(self):
        warnings: list[str] = []
        disabled = _maybe_create_digital_human_video_cover(
            Path("missing.mp4"),
            payload={"digital_human_video_cover_enabled": False},
            warnings=warnings,
        )
        self.assertIsNone(disabled)
        self.assertEqual(warnings, [])

        failed = _maybe_create_digital_human_video_cover(
            Path("missing.mp4"),
            payload={},
            warnings=warnings,
        )
        self.assertIsNone(failed)
        self.assertEqual(len(warnings), 1)
        self.assertTrue(warnings[0].startswith("video_cover_failed: "))

    def test_task_cancellation_is_not_downgraded_to_cover_warning(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = Path(tmpdir) / "merged.mp4"
            video_path.write_bytes(b"local-video")
            event = threading.Event()
            event.set()
            context = VideoTaskContext(
                task_id="task-cover-cancelled",
                task_type="create_video",
                cancel_event=event,
            )
            warnings: list[str] = []

            with self.assertRaises(VideoTaskCancelled):
                _maybe_create_digital_human_video_cover(
                    video_path,
                    payload={},
                    warnings=warnings,
                    context=context,
                )
            self.assertEqual(warnings, [])

    def test_pipeline_creates_cover_from_merged_video_before_subtitles(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            events: list[tuple[str, str]] = []

            def segment_provider(**kwargs):
                output = Path(kwargs["output_path"])
                output.write_bytes(b"merged-source")
                return {"video_path": str(output), "provider_task_id": "rh-local-test"}

            def cover_provider(video_path, **kwargs):
                source = Path(video_path)
                events.append(("cover", source.read_bytes().decode()))
                output = source.with_name(f"{source.stem}_cover.jpg")
                Image.new("RGB", (320, 180), (20, 40, 60)).save(output, format="JPEG")
                return {
                    "path": str(output.resolve()),
                    "keyword": "封面标题",
                    "lines": ["封面标题"],
                    "source_video_path": str(source.resolve()),
                }

            def subtitle_provider(**kwargs):
                source = Path(kwargs["video_path"])
                events.append(("subtitle", source.read_bytes().decode()))
                output = Path(kwargs["output_path"])
                output.write_bytes(b"subtitled-output")
                subtitle = output.with_suffix(".srt")
                subtitle.write_text("subtitle", encoding="utf-8")
                return {"video_path": str(output), "subtitle_path": str(subtitle), "count": 1}

            with patch("video_core.digital_human_pipeline._maybe_create_digital_human_video_cover", side_effect=cover_provider):
                result = run_digital_human_pipeline(
                    _Backend(),
                    "task-cover-order",
                    {
                        "output_dir": str(root / "out"),
                        "digital_human_short_mode": "single",
                        "speech_text": "本地封面测试",
                        "model_image_local_path": model,
                        "product_image_local_path": product,
                        "digital_human_fusion_image_paths": [view],
                        "subtitles": {"enabled": True},
                        "_digital_human_segment_provider": segment_provider,
                        "_digital_human_subtitle_provider": subtitle_provider,
                    },
                    self._context(),
                )

            self.assertEqual(events, [("cover", "merged-source"), ("subtitle", "merged-source")])
            self.assertTrue(result["ok"])
            self.assertTrue(Path(result["cover_image_path"]).is_file())
            self.assertEqual(result["poster_image_path"], result["cover_image_path"])
            self.assertEqual(result["raw_result"]["video_cover"]["keyword"], "封面标题")
            self.assertEqual(Path(result["video_path"]).read_bytes(), b"subtitled-output")


if __name__ == "__main__":
    unittest.main()
