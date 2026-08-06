from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend
from video_core.video_language_timing import (
    build_atempo_chain,
    build_timed_audio_layout,
    normalize_chinese_tts_text,
)


class VideoLanguageTimingParityTests(unittest.TestCase):
    def test_chinese_tts_normalization_matches_source_rules(self):
        normalized = normalize_chinese_tts_text("臺灣 總價 2,500,000元，管理費 2%")

        self.assertIn("台湾", normalized)
        self.assertIn("总价", normalized)
        self.assertIn("两百五十万元", normalized)
        self.assertIn("百分之二", normalized)
        self.assertNotRegex(normalized, r"\d")

    def test_short_overrun_is_compressed_with_source_tempo_cap(self):
        rows, total = build_timed_audio_layout(
            [
                {
                    "role": "source",
                    "segment_index": 1,
                    "text": "Simple line",
                    "start_seconds": 0.0,
                    "slot_end_seconds": 1.0,
                    "raw_audio_duration_seconds": 1.2,
                },
                {
                    "role": "source",
                    "segment_index": 2,
                    "text": "Next line",
                    "start_seconds": 1.0,
                    "slot_end_seconds": 2.0,
                    "raw_audio_duration_seconds": 1.0,
                },
            ],
            source_duration=2.0,
        )

        self.assertTrue(rows[0]["duration_compressed"])
        self.assertAlmostEqual(rows[0]["playback_tempo"], 1.2)
        self.assertEqual(rows[1]["start_seconds"], 1.0)
        self.assertEqual(total, 2.0)
        self.assertEqual(build_atempo_chain(rows[0]["playback_tempo"]), "atempo=1.200000")

    def test_large_overrun_shifts_following_segments_without_overlap(self):
        rows, total = build_timed_audio_layout(
            [
                {
                    "role": "source",
                    "segment_index": 1,
                    "text": "这句包含 120 个参数，不能为了卡槽过度加速",
                    "start_seconds": 0.0,
                    "slot_end_seconds": 1.0,
                    "raw_audio_duration_seconds": 2.0,
                },
                {
                    "role": "source",
                    "segment_index": 2,
                    "text": "后续台词",
                    "start_seconds": 1.0,
                    "slot_end_seconds": 2.0,
                    "raw_audio_duration_seconds": 1.0,
                },
                {
                    "role": "ending",
                    "segment_index": 3,
                    "text": "结束语",
                    "start_seconds": 2.0,
                    "raw_audio_duration_seconds": 0.5,
                },
            ],
            source_duration=2.0,
        )

        self.assertFalse(rows[0]["duration_compressed"])
        self.assertGreaterEqual(rows[1]["start_seconds"], rows[0]["end_seconds"])
        self.assertGreaterEqual(rows[2]["start_seconds"], rows[1]["end_seconds"])
        self.assertEqual(total, rows[2]["end_seconds"])

    def test_backend_applies_atempo_and_normalizes_chinese_before_tts(self):
        class FakeBackend(ArchivedSourceBackend):
            generated_texts: list[str]

            def __init__(self):
                super().__init__()
                self.generated_texts = []

            def _generate_minimax_tts(self, *, speech_text, output_path, **_kwargs):
                self.generated_texts.append(speech_text)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"audio")
                return output_path

            @staticmethod
            def _probe_media_duration_seconds(path, payload):
                return 1.1 if "001" in path.name else 1.0

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            commands: list[list[str]] = []

            def fake_process(command, **_kwargs):
                commands.append(command)
                Path(command[-1]).write_bytes(b"mixed")
                return 0, "", ""

            backend = FakeBackend()
            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                _audio, rows, _total = backend._generate_timed_tts_audio(
                    segments=[
                        {"start_seconds": 0.0, "end_seconds": 1.0, "text": "臺灣 2套"},
                        {"start_seconds": 1.0, "end_seconds": 2.0, "text": "下一句"},
                    ],
                    source_duration=2.0,
                    payload={"ffmpeg_path": "ffmpeg", "target_language": "Chinese"},
                    context=VideoTaskContext(task_id="timing", task_type="video_language_replace"),
                    workdir=root,
                )

        self.assertEqual(backend.generated_texts[0], "台湾，两套")
        self.assertTrue(rows[0]["duration_compressed"])
        filter_complex = commands[0][commands[0].index("-filter_complex") + 1]
        self.assertIn("atempo=1.100000", filter_complex)


if __name__ == "__main__":
    unittest.main()
