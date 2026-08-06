from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from video_core.contracts import VideoTaskContext
from video_core.digital_human_pipeline import run_digital_human_pipeline


class _Backend:
    @staticmethod
    def _workdir(task_id: str, payload: dict) -> Path:
        path = Path(payload["output_dir"]) / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path


class DigitalHumanPipelineParityTest(unittest.TestCase):
    @staticmethod
    def _context() -> VideoTaskContext:
        return VideoTaskContext(task_id="task-dh", task_type="create_video")

    @staticmethod
    def _file(root: Path, name: str, content: bytes = b"fixture") -> str:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return str(path)

    def test_storyboard_ai_copy_dual_presenter_concat_and_subtitles_close_loop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            models = [self._file(root, "model-1.png"), self._file(root, "model-2.png")]
            products = [self._file(root, "product-1.png"), self._file(root, "product-2.png")]
            fusion = [self._file(root, f"view-{index}.png") for index in range(1, 4)]
            ai_calls: list[dict] = []
            fusion_calls: list[dict] = []
            segment_calls: list[dict] = []
            concat_calls: list[list[str]] = []
            subtitle_calls: list[dict] = []

            def ai_copy_provider(**kwargs):
                ai_calls.append(kwargs)
                return {
                    "speech_text": "开场介绍。展示细节。现在行动。",
                    "metadata": {"provider": "mock-llm", "prompt_version": "original-parity"},
                }

            def fusion_provider(**kwargs):
                fusion_calls.append(kwargs)
                return {"paths": fusion, "provider_task_ids": ["fusion-1", "fusion-2", "fusion-3"]}

            def segment_provider(**kwargs):
                segment_calls.append(kwargs)
                path = Path(kwargs["output_path"])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"segment-{kwargs['segment_index']}".encode())
                return {
                    "status": "success",
                    "video_path": str(path),
                    "duration_seconds": 2.0,
                    "provider_task_id": f"rh-segment-{kwargs['segment_index']}",
                    "usage": {"credits": kwargs["segment_index"]},
                }

            def concat_provider(**kwargs):
                concat_calls.append([str(item) for item in kwargs["video_paths"]])
                output = Path(kwargs["output_path"])
                output.write_bytes(b"joined")
                return {
                    "video_path": str(output),
                    "segment_join_crossfade_seconds": 0.25,
                }

            def subtitle_provider(**kwargs):
                subtitle_calls.append(kwargs)
                output = Path(kwargs["output_path"])
                output.write_bytes(b"subtitled")
                subtitle = output.with_suffix(".srt")
                subtitle.write_text("mock subtitle", encoding="utf-8")
                return {"video_path": str(output), "subtitle_path": str(subtitle), "count": 3}

            result = run_digital_human_pipeline(
                _Backend(),
                "task-dh",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "use_ai_copy": True,
                    "model_image_local_paths": models,
                    "product_image_local_paths": products,
                    "storyboard": [
                        {"dialogue": "开场介绍", "visual_prompt": "主视角"},
                        {"dialogue": "展示细节", "visual_prompt": "商品特写"},
                        {"dialogue": "现在行动", "visual_prompt": "回到主视角"},
                    ],
                    "subtitles": {"enabled": True},
                    "_digital_human_ai_copy_provider": ai_copy_provider,
                    "_digital_human_fusion_provider": fusion_provider,
                    "_digital_human_segment_provider": segment_provider,
                    "_digital_human_concat_provider": concat_provider,
                    "_digital_human_subtitle_provider": subtitle_provider,
                },
                self._context(),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["speech_text"], "开场介绍。展示细节。现在行动。")
            self.assertEqual(result["segment_scripts"], ["开场", "介绍", "展示细节", "现在行动"])
            self.assertEqual(result["view_sequence"], [1, 2, 3, 1])
            self.assertEqual(result["runninghub_task_ids"], [
                "fusion-1", "fusion-2", "fusion-3", "rh-segment-1", "rh-segment-2", "rh-segment-3", "rh-segment-4"
            ])
            self.assertEqual(result["segment_provider_task_ids"], {
                "1": ["rh-segment-1"], "2": ["rh-segment-2"], "3": ["rh-segment-3"], "4": ["rh-segment-4"]
            })
            self.assertEqual(result["ai_copy"], {"provider": "mock-llm", "prompt_version": "original-parity"})
            self.assertTrue(result["subtitled"])
            self.assertTrue(Path(result["video_path"]).is_file())
            self.assertTrue(Path(result["subtitle_path"]).is_file())
            self.assertEqual(len(ai_calls), 1)
            self.assertEqual(ai_calls[0]["model_references"], models)
            self.assertEqual(ai_calls[0]["product_references"], products)
            self.assertEqual(len(fusion_calls), 1)
            self.assertTrue(fusion_calls[0]["dual_presenter"])
            self.assertEqual(len(segment_calls), 4)
            self.assertTrue(all(call["dual_presenter"] for call in segment_calls))
            self.assertEqual([call["model_references"] for call in segment_calls], [models, models, models, models])
            self.assertEqual([call["product_references"] for call in segment_calls], [products, products, products, products])
            self.assertEqual(len(concat_calls), 1)
            self.assertEqual(len(concat_calls[0]), 4)
            self.assertEqual(len(subtitle_calls), 1)
            self.assertEqual(subtitle_calls[0]["segment_durations"], [1.75, 1.75, 1.75, 2.0])

    def test_resume_skips_completed_segments_and_preserves_segment_provider_ids(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            segment_one = self._file(root, "saved-1.mp4", b"old-1")
            segment_three = self._file(root, "saved-3.mp4", b"old-3")
            segment_four = self._file(root, "saved-4.mp4", b"old-4")
            calls: list[int] = []

            def segment_provider(**kwargs):
                calls.append(kwargs["segment_index"])
                output = Path(kwargs["output_path"])
                output.write_bytes(b"new-2")
                return {"video_path": str(output), "runninghub_task_id": "rh-new-2", "status": "success"}

            def concat_provider(**kwargs):
                output = Path(kwargs["output_path"])
                output.write_bytes(b"joined")
                return str(output)

            result = run_digital_human_pipeline(
                _Backend(),
                "task-resume",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "speech_text": "一。二。三。",
                    "segment_scripts": ["一", "二", "三"],
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "completed_segments": [
                        {"segment_index": 1, "video_path": segment_one, "provider_task_id": "rh-old-1"},
                        {"segment_index": 3, "video_path": segment_three, "runninghub_task_ids": ["rh-old-3a", "rh-old-3b"]},
                        {"segment_index": 4, "video_path": segment_four, "provider_task_id": "rh-old-4"},
                    ],
                    "_digital_human_segment_provider": segment_provider,
                    "_digital_human_concat_provider": concat_provider,
                },
                self._context(),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(calls, [2])
            self.assertEqual(result["completed_segment_indices"], [1, 2, 3, 4])
            self.assertEqual(result["segment_provider_task_ids"], {
                "1": ["rh-old-1"], "2": ["rh-new-2"], "3": ["rh-old-3a", "rh-old-3b"], "4": ["rh-old-4"]
            })
            self.assertEqual(result["runninghub_task_ids"], ["rh-old-1", "rh-new-2", "rh-old-3a", "rh-old-3b", "rh-old-4"])
            self.assertEqual(Path(result["raw_result"]["segment_video_paths"][0]).read_bytes(), b"old-1")
            self.assertEqual(Path(result["raw_result"]["segment_video_paths"][2]).read_bytes(), b"old-3")

    def test_single_segment_regeneration_only_replaces_requested_segment(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            saved = [self._file(root, f"saved-{index}.mp4", f"old-{index}".encode()) for index in range(1, 5)]
            calls: list[int] = []

            def segment_provider(**kwargs):
                calls.append(kwargs["segment_index"])
                output = Path(kwargs["output_path"])
                output.write_bytes(b"new-2")
                return {"video_path": str(output), "taskId": "rh-regenerated-2", "status": "success"}

            def concat_provider(**kwargs):
                output = Path(kwargs["output_path"])
                output.write_bytes(b"joined")
                return output

            result = run_digital_human_pipeline(
                _Backend(),
                "task-regenerate",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "speech_text": "一。二。三。",
                    "segment_scripts": ["一", "二", "三"],
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "digital_human_regenerate_segment_index": 2,
                    "completed_segments": [
                        {"segment_index": index, "video_path": path, "provider_task_id": f"rh-old-{index}"}
                        for index, path in enumerate(saved, start=1)
                    ],
                    "_digital_human_segment_provider": segment_provider,
                    "_digital_human_concat_provider": concat_provider,
                },
                self._context(),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(calls, [2])
            self.assertEqual(result["regenerated_segment_index"], 2)
            self.assertEqual(Path(result["raw_result"]["segment_video_paths"][1]).read_bytes(), b"new-2")
            self.assertEqual(result["segment_provider_task_ids"]["2"], ["rh-regenerated-2"])
            self.assertNotIn("rh-old-2", result["runninghub_task_ids"])

    def test_failed_segment_returns_resumable_partial_result_without_concat(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            concat_calls: list[dict] = []

            def segment_provider(**kwargs):
                if kwargs["segment_index"] == 2:
                    raise RuntimeError("mock provider failure")
                output = Path(kwargs["output_path"])
                output.write_bytes(b"ok")
                return {"video_path": str(output), "provider_task_id": f"rh-{kwargs['segment_index']}"}

            result = run_digital_human_pipeline(
                _Backend(),
                "task-partial",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "speech_text": "一。二。三。",
                    "segment_scripts": ["一", "二", "三"],
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "_digital_human_segment_provider": segment_provider,
                    "_digital_human_concat_provider": lambda **kwargs: concat_calls.append(kwargs),
                },
                self._context(),
            )

            self.assertFalse(result["ok"])
            self.assertTrue(result["partial"])
            self.assertTrue(result["can_resume"])
            self.assertEqual(result["completed_segment_indices"], [1, 3, 4])
            self.assertEqual(result["missing_segment_indices"], [2])
            self.assertEqual(result["runninghub_task_ids"], ["rh-1", "rh-3", "rh-4"])
            self.assertIn("mock provider failure", result["message"])
            self.assertEqual(concat_calls, [])

    def test_single_mode_uses_one_segment_and_does_not_require_concat_provider(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")

            def segment_provider(**kwargs):
                output = Path(kwargs["output_path"])
                output.write_bytes(b"single")
                return {"video_path": str(output), "provider_task_id": "rh-single"}

            result = run_digital_human_pipeline(
                _Backend(),
                "task-single",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "single",
                    "speech_text": "单段口播",
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "_digital_human_segment_provider": segment_provider,
                },
                self._context(),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["segment_scripts"], ["单段口播"])
            self.assertEqual(Path(result["video_path"]).read_bytes(), b"single")

    def test_fully_completed_checkpoint_closes_without_resubmitting_provider_work(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            saved = self._file(root, "saved.mp4", b"already-complete")

            result = run_digital_human_pipeline(
                _Backend(),
                "task-complete-checkpoint",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "single",
                    "speech_text": "无需重复提交",
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": view,
                    "resume_checkpoint": {
                        "raw_result": {
                            "segment_video_paths": [saved],
                            "segment_provider_task_ids": {"1": ["rh-existing"]},
                        }
                    },
                },
                self._context(),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["runninghub_task_ids"], ["rh-existing"])
            self.assertEqual(Path(result["video_path"]).read_bytes(), b"already-complete")

    def test_each_successful_segment_persists_resume_compatible_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            checkpoints: list[dict] = []
            generated: list[int] = []

            def segment_provider(**kwargs):
                generated.append(kwargs["segment_index"])
                output = Path(kwargs["output_path"])
                output.write_bytes(f"segment-{kwargs['segment_index']}".encode())
                return {
                    "video_path": str(output),
                    "duration_seconds": kwargs["segment_index"] + 0.25,
                    "runninghub_task_ids": [
                        f"rh-{kwargs['segment_index']}-prepare",
                        f"rh-{kwargs['segment_index']}-render",
                    ],
                }

            def concat_provider(**kwargs):
                output = Path(kwargs["output_path"])
                output.write_bytes(b"joined")
                return output

            result = run_digital_human_pipeline(
                _Backend(),
                "task-checkpoint",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "speech_text": "第一段。第二段。",
                    "segment_scripts": ["第一段", "第二段"],
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "_digital_human_segment_provider": segment_provider,
                    "_digital_human_concat_provider": concat_provider,
                    "_checkpoint_video_progress": lambda **values: checkpoints.append(values),
                },
                self._context(),
            )

            self.assertEqual([item["segment_index"] for item in checkpoints], [1, 2, 3, 4])
            self.assertTrue(all(item["stage"] == "digital_human_video" for item in checkpoints))
            self.assertTrue(all(item["segment_count"] == 4 for item in checkpoints))
            self.assertEqual(checkpoints[0]["completed_segment"]["index"], 1)
            self.assertEqual(checkpoints[0]["completed_segment"]["duration_seconds"], 1.25)
            self.assertEqual(checkpoints[0]["completed_segment"]["runninghub_task_id"], "rh-1-render")
            self.assertEqual(
                checkpoints[0]["completed_segment"]["runninghub_task_ids"],
                ["rh-1-prepare", "rh-1-render"],
            )
            self.assertEqual(checkpoints[0]["completed_segment"]["provider_task_id"], "rh-1-render")
            self.assertEqual(
                checkpoints[0]["completed_segment"]["provider_task_ids"],
                ["rh-1-prepare", "rh-1-render"],
            )
            self.assertTrue(Path(checkpoints[0]["completed_segment"]["path"]).is_file())
            self.assertEqual(result["completed_segments"], [item["completed_segment"] for item in checkpoints])
            self.assertEqual(result["raw_result"]["completed_segments"], result["completed_segments"])
            self.assertEqual(result["raw_result"]["segment_video_paths"], [
                item["path"] for item in result["completed_segments"]
            ])
            self.assertEqual(result["raw_result"]["segment_provider_task_ids"], {
                "1": ["rh-1-prepare", "rh-1-render"],
                "2": ["rh-2-prepare", "rh-2-render"],
                "3": ["rh-3-prepare", "rh-3-render"],
                "4": ["rh-4-prepare", "rh-4-render"],
            })
            self.assertEqual(result["video_checkpoint"]["completed_segments"], result["completed_segments"])
            self.assertEqual(result["video_checkpoint"]["segment_video_paths"], result["segment_video_paths"])
            self.assertEqual(result["video_checkpoint"]["segment_provider_task_ids"], result["segment_provider_task_ids"])

            resumed = run_digital_human_pipeline(
                _Backend(),
                "task-checkpoint-resumed",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "speech_text": "第一段。第二段。",
                    "segment_scripts": ["第一段", "第二段"],
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "resume_checkpoint": result["video_checkpoint"],
                    "_digital_human_concat_provider": concat_provider,
                },
                self._context(),
            )
            self.assertTrue(resumed["ok"])
            self.assertEqual(generated, [1, 2, 3, 4])
            self.assertEqual(resumed["segment_provider_task_ids"], result["segment_provider_task_ids"])

    def test_api_regenerate_segment_index_alias_only_replaces_target_segment(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            view = self._file(root, "view.png")
            saved = [self._file(root, f"alias-saved-{index}.mp4", f"old-{index}".encode()) for index in range(1, 5)]
            generated: list[int] = []

            def segment_provider(**kwargs):
                generated.append(kwargs["segment_index"])
                output = Path(kwargs["output_path"])
                output.write_bytes(b"alias-new-2")
                return {"video_path": str(output), "provider_task_id": "rh-alias-2"}

            def concat_provider(**kwargs):
                output = Path(kwargs["output_path"])
                output.write_bytes(b"joined")
                return output

            result = run_digital_human_pipeline(
                _Backend(),
                "task-api-alias",
                {
                    "output_dir": str(root / "out"),
                    "digital_human_short_mode": "storyboard",
                    "speech_text": "一。二。三。",
                    "segment_scripts": ["一", "二", "三"],
                    "model_image_local_path": model,
                    "product_image_local_path": product,
                    "digital_human_fusion_image_paths": [view],
                    "digital_human_regenerate_segment_index": "0",
                    "regenerate_segment_index": 2,
                    "completed_segments": [
                        {"index": index, "path": path, "runninghub_task_id": f"rh-old-{index}"}
                        for index, path in enumerate(saved, start=1)
                    ],
                    "_digital_human_segment_provider": segment_provider,
                    "_digital_human_concat_provider": concat_provider,
                },
                self._context(),
            )

            self.assertEqual(generated, [2])
            self.assertEqual(result["regenerated_segment_index"], 2)
            self.assertEqual(Path(result["raw_result"]["segment_video_paths"][1]).read_bytes(), b"alias-new-2")
            self.assertEqual(result["segment_provider_task_ids"]["2"], ["rh-alias-2"])


if __name__ == "__main__":
    unittest.main()
