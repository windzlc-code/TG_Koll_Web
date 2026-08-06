from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from video_core.contracts import VideoTaskCancelled
from video_core.digital_human_storyboard import (
    build_digital_human_view_sequence,
    normalize_digital_human_segment_scripts,
)


class DigitalHumanStoryboardParityTest(unittest.TestCase):
    def test_single_long_script_uses_source_duration_and_weighted_split(self):
        script = "".join(
            f"第{index}部分介绍产品的重要卖点与真实使用体验。"
            for index in range(1, 17)
        )

        segments = normalize_digital_human_segment_scripts(
            script,
            mode="single",
        )

        self.assertGreater(len(segments), 1)
        self.assertLessEqual(len(segments), 8)
        self.assertEqual("".join(segments), script)

    def test_storyboard_items_are_filled_to_four_segments(self):
        storyboard = [
            {"dialogue": "主视图开场"},
            {"speech_text": "厨房动线合理，收纳空间充足，日常料理更顺手"},
            {"narration": "最后回到主视图总结"},
        ]

        segments = normalize_digital_human_segment_scripts(
            storyboard=storyboard,
            mode="storyboard",
        )

        self.assertEqual(len(segments), 4)
        self.assertEqual(segments[0], "主视图开场")
        self.assertEqual("".join(segments), "".join(item[next(iter(item))] for item in storyboard))

    def test_explicit_scene_mapping_selects_matching_middle_views(self):
        main = Path("main.png")
        sequence = build_digital_human_view_sequence(
            {
                "digital_human_short_mode": "storyboard",
                "digital_human_scene_labels": ["bedroom", "kitchen"],
            },
            ["主视图开场", "走进明亮厨房", "卧室收纳充足", "最后总结"],
            [main, Path("bedroom.png"), Path("kitchen.png"), main],
            llm_enabled=False,
        )

        self.assertEqual(sequence, [0, 2, 1, 0])

    def test_llm_scene_mapping_is_callback_injected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            kitchen = root / "scene-a.png"
            bedroom = root / "scene-b.png"
            kitchen.write_bytes(b"kitchen")
            bedroom.write_bytes(b"bedroom")
            calls: list[dict] = []

            def analyze_scene_markers(**kwargs):
                calls.append(kwargs)
                return (
                    {
                        "parsed": {
                            "scenes": [
                                {"index": 1, "label": "kitchen", "description": "厨房"},
                                {"index": 2, "label": "bedroom", "description": "卧室"},
                            ]
                        }
                    },
                    "mock-llm",
                    [],
                )

            main = root / "main.png"
            sequence = build_digital_human_view_sequence(
                {
                    "digital_human_short_mode": "storyboard",
                    "digital_human_scene_image_local_paths": [
                        str(kitchen),
                        str(bedroom),
                    ],
                },
                ["主视图开场", "卧室睡眠空间", "厨房料理空间", "最后总结"],
                [main, kitchen, bedroom, main],
                task_id="task-storyboard",
                analyze_scene_markers=analyze_scene_markers,
            )

            self.assertEqual(sequence, [0, 2, 1, 0])
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["task_id"], "task-storyboard")
            self.assertEqual(calls[0]["image_paths"], [str(kitchen), str(bedroom)])

    def test_missing_or_single_fusion_view_defaults_to_main_view(self):
        self.assertEqual(
            build_digital_human_view_sequence(
                {},
                ["开场", "细节", "总结"],
                [],
            ),
            [0, 0, 0],
        )
        self.assertEqual(
            build_digital_human_view_sequence(
                {},
                ["开场", "细节", "总结"],
                [Path("main.png")],
            ),
            [0, 0, 0],
        )

    def test_llm_failure_degrades_but_cancellation_propagates(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            scene_one = root / "scene-one.png"
            scene_two = root / "scene-two.png"
            scene_one.write_bytes(b"one")
            scene_two.write_bytes(b"two")
            main = root / "main.png"
            payload = {
                "digital_human_short_mode": "storyboard",
                "digital_human_scene_image_local_paths": [
                    str(scene_one),
                    str(scene_two),
                ],
            }
            scripts = ["主视图开场", "厨房细节", "卧室细节", "最后总结"]
            views = [main, scene_one, scene_two, main]

            def failing_analyzer(**kwargs):
                raise RuntimeError("mock provider unavailable")

            self.assertEqual(
                build_digital_human_view_sequence(
                    payload,
                    scripts,
                    views,
                    analyze_scene_markers=failing_analyzer,
                ),
                [0, 1, 2, 0],
            )

            def cancelled_analyzer(**kwargs):
                raise VideoTaskCancelled("cancelled by test")

            with self.assertRaisesRegex(VideoTaskCancelled, "cancelled by test"):
                build_digital_human_view_sequence(
                    payload,
                    scripts,
                    views,
                    analyze_scene_markers=cancelled_analyzer,
                )


if __name__ == "__main__":
    unittest.main()
