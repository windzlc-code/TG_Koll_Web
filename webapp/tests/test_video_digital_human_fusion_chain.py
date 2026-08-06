from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.digital_human_pipeline import run_digital_human_pipeline
from video_core.source_backend import ArchivedSourceBackend


class DigitalHumanFusionChainTest(unittest.TestCase):
    @staticmethod
    def _file(root: Path, name: str, content: bytes = b"fixture") -> str:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return str(path.resolve())

    @staticmethod
    def _context(cancel_event: Any = None) -> VideoTaskContext:
        return VideoTaskContext(
            task_id="task-fusion",
            task_type="create_video",
            cancel_event=cancel_event,
        )

    def _backend_with_mock_images(
        self,
        root: Path,
        *,
        fail_on_call: int = 0,
        prefix: str = "rh",
        cancel_after_call: int = 0,
        cancel_event: threading.Event | None = None,
    ) -> tuple[ArchivedSourceBackend, list[dict[str, Any]]]:
        backend = ArchivedSourceBackend()
        calls: list[dict[str, Any]] = []

        def image_generate(*, task_id: str, payload: dict[str, Any], context: VideoTaskContext) -> dict[str, Any]:
            call_number = len(calls) + 1
            calls.append({"task_id": task_id, "payload": dict(payload)})
            if fail_on_call and call_number == fail_on_call:
                raise RuntimeError(f"mock image failure {call_number}")
            output = Path(payload["output_dir"]) / "image_generate.png"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(f"image-{call_number}".encode())
            if cancel_after_call and call_number == cancel_after_call and cancel_event is not None:
                cancel_event.set()
            provider_id = f"{prefix}-{call_number}"
            return {
                "ok": True,
                "image_path": str(output.resolve()),
                "runninghub_task_id": provider_id,
                "runninghub_task_ids": [provider_id],
                "runninghub_usage": {"consumeCoins": call_number},
            }

        backend.image_generate = image_generate  # type: ignore[method-assign]
        return backend, calls

    def test_master_image_drives_independent_consistency_views_and_preserves_provider_ids(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            backend, calls = self._backend_with_mock_images(root)

            result = backend.generate_digital_human_fusion_views(
                task_id="task-chain",
                payload={"digital_human_fusion_count": 4, "ratio": "9:16"},
                context=self._context(),
                workdir=root / "work",
                speech_text="Introduce the product",
                storyboard=[
                    {"visual_prompt": "master"},
                    {"visual_prompt": "left view"},
                    {"visual_prompt": "right view"},
                    {"visual_prompt": "closing view"},
                ],
                mode="storyboard",
                model_references=[model],
                product_references=[product],
            )

            self.assertEqual([call["task_id"] for call in calls], [
                "task-chain-fusion-main",
                "task-chain-fusion-view-2",
                "task-chain-fusion-view-3",
                "task-chain-fusion-view-4",
            ])
            self.assertEqual(calls[0]["payload"]["product_image_local_path"], product)
            self.assertEqual(calls[0]["payload"]["model_image_local_path"], model)
            master_path = result["fusion_images"][0]
            self.assertTrue(all(call["payload"]["product_image_local_path"] == master_path for call in calls[1:]))
            self.assertTrue(all(call["payload"]["model_image_local_path"] == model for call in calls[1:]))
            self.assertTrue(all(call["payload"]["count"] == 1 for call in calls))
            view_prompts = [call["payload"]["prompt"] for call in calls[1:]]
            self.assertEqual(len(set(view_prompts)), 3)
            self.assertEqual(result["runninghub_task_ids"], ["rh-1", "rh-2", "rh-3", "rh-4"])
            self.assertFalse(any(Path(provider_id).is_absolute() for provider_id in result["runninghub_task_ids"]))
            self.assertEqual(result["runninghub_usage"]["consumeCoins"], 10.0)

    def test_single_consistency_view_regeneration_keeps_opaque_provider_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            main = self._file(root, "main.png")
            backend, calls = self._backend_with_mock_images(root, prefix="rh-single")

            result = backend.generate_digital_human_single_consistency_view(
                task_id="task-redo",
                payload={},
                context=self._context(),
                workdir=root / "work",
                main_image_path=main,
                view_index=3,
                speech_text="Continue",
                storyboard=[],
                model_references=[model],
            )

            self.assertEqual(calls[0]["task_id"], "task-redo-fusion-view-3")
            self.assertEqual(calls[0]["payload"]["product_image_local_path"], main)
            self.assertEqual(result["runninghub_task_id"], "rh-single-1")
            self.assertEqual(result["runninghub_task_ids"], ["rh-single-1"])

    def test_cancellation_is_checked_between_master_and_consistency_views(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            event = threading.Event()
            backend, calls = self._backend_with_mock_images(
                root,
                cancel_after_call=1,
                cancel_event=event,
            )

            with self.assertRaises(VideoTaskCancelled):
                backend.generate_digital_human_fusion_views(
                    task_id="task-cancel",
                    payload={"digital_human_fusion_count": 4},
                    context=self._context(event),
                    workdir=root / "work",
                    speech_text="Cancel after master",
                    storyboard=[],
                    mode="storyboard",
                    model_references=[model],
                    product_references=[product],
                )
            self.assertEqual(len(calls), 1)

    def test_partial_view_checkpoint_resumes_without_repeating_ai_or_completed_images(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            model = self._file(root, "model.png")
            product = self._file(root, "product.png")
            backend, first_calls = self._backend_with_mock_images(root, fail_on_call=3)
            checkpoint_state: dict[str, Any] = {}
            checkpoint_history: list[dict[str, Any]] = []
            ai_calls: list[str] = []

            def checkpoint(**changes: Any) -> None:
                checkpoint_state.update(changes)
                checkpoint_history.append(dict(checkpoint_state))

            def ai_provider(**_kwargs: Any) -> dict[str, Any]:
                ai_calls.append("called")
                return {
                    "speech_text": "First line. Second line.",
                    "segment_scripts": ["First line.", "Second line."],
                    "metadata": {"provider": "mock-llm", "version": "v1"},
                }

            def segment_provider(**kwargs: Any) -> dict[str, Any]:
                output = Path(kwargs["output_path"])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(f"segment-{kwargs['segment_index']}".encode())
                provider_id = f"rh-video-{kwargs['segment_index']}"
                return {"video_path": str(output), "runninghub_task_ids": [provider_id]}

            def concat_provider(**kwargs: Any) -> Path:
                output = Path(kwargs["output_path"])
                output.write_bytes(b"joined")
                return output

            base_payload = {
                "output_dir": str(root / "out"),
                "digital_human_short_mode": "storyboard",
                "digital_human_fusion_count": 4,
                "use_ai_copy": True,
                "model_image_local_path": model,
                "product_image_local_path": product,
                "_digital_human_ai_copy_provider": ai_provider,
                "_digital_human_segment_provider": segment_provider,
                "_digital_human_concat_provider": concat_provider,
                "_checkpoint_video_progress": checkpoint,
            }

            with self.assertRaisesRegex(RuntimeError, "mock image failure 3"):
                run_digital_human_pipeline(backend, "task-first", base_payload, self._context())

            self.assertEqual(ai_calls, ["called"])
            self.assertEqual([call["task_id"] for call in first_calls], [
                "task-first-fusion-main",
                "task-first-fusion-view-2",
                "task-first-fusion-view-3",
            ])
            script_checkpoint = next(item for item in checkpoint_history if item.get("stage") == "digital_human_script")
            self.assertEqual(script_checkpoint["speech_text"], "First line. Second line.")
            self.assertEqual(script_checkpoint["segment_scripts"], ["First", "line.", "Second", "line."])
            self.assertEqual(script_checkpoint["ai_copy"], {"provider": "mock-llm", "version": "v1"})
            self.assertEqual(checkpoint_state["stage"], "digital_human_fusion_views_partial")
            self.assertEqual(checkpoint_state["runninghub_task_ids"], ["rh-1", "rh-2"])
            self.assertFalse(any(Path(provider_id).is_absolute() for provider_id in checkpoint_state["runninghub_task_ids"]))

            resumed_backend, resumed_calls = self._backend_with_mock_images(root, prefix="rh-resumed")
            resumed_payload = {
                **base_payload,
                "resume_checkpoint": dict(checkpoint_state),
            }
            result = run_digital_human_pipeline(
                resumed_backend,
                "task-resumed",
                resumed_payload,
                self._context(),
            )

            self.assertTrue(result["ok"])
            self.assertEqual(ai_calls, ["called"])
            self.assertEqual([call["task_id"] for call in resumed_calls], [
                "task-resumed-fusion-view-3",
                "task-resumed-fusion-view-4",
            ])
            self.assertEqual(result["speech_text"], "First line. Second line.")
            self.assertEqual(result["segment_scripts"], ["First", "line.", "Second", "line."])
            self.assertEqual(result["ai_copy"], {"provider": "mock-llm", "version": "v1"})
            self.assertEqual(result["runninghub_task_ids"][:4], [
                "rh-1",
                "rh-2",
                "rh-resumed-1",
                "rh-resumed-2",
            ])
            self.assertFalse(any(Path(provider_id).is_absolute() for provider_id in result["runninghub_task_ids"]))
            self.assertIn("digital_human_fusion_views", [item.get("stage") for item in checkpoint_history])


if __name__ == "__main__":
    unittest.main()
