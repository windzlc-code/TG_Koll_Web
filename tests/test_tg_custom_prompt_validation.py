import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

bs4 = types.ModuleType("bs4")


class BeautifulSoup:
    def __init__(self, *args, **kwargs):
        pass


bs4.BeautifulSoup = BeautifulSoup
sys.modules.setdefault("bs4", bs4)

from webapp import server


class TgCustomPromptValidationTests(unittest.TestCase):
    def test_custom_text_to_image_prompt_allows_short_chinese(self) -> None:
        payload = {
            "prompt": "站著",
            "prompt_text": "站著",
            "custom_prompt_used": True,
        }

        result = server._ensure_internal_tg_payload_chinese_image_prompt("text_to_image", payload)

        self.assertEqual(result["prompt"], "站著")
        self.assertEqual(result["prompt_text"], "站著")

    def test_custom_text_to_image_prompt_allows_english(self) -> None:
        payload = {
            "prompt": "standing portrait, cinematic light",
            "prompt_text": "standing portrait, cinematic light",
            "custom_prompt_used": True,
        }

        result = server._ensure_internal_tg_payload_chinese_image_prompt("text_to_image", payload)

        self.assertEqual(result["prompt"], "standing portrait, cinematic light")
        self.assertEqual(result["prompt_text"], "standing portrait, cinematic light")


class RemoteComfyImageOutputTests(unittest.TestCase):
    def test_text_to_image_cannot_succeed_without_output_file(self) -> None:
        payload = {
            "prompt": "站立人像",
            "remote_comfy_node_inputs": {},
            "text_to_image_auto_qa_enabled": False,
        }

        with (
            patch.object(server, "_comfy_gateway_from_payload", return_value=("remote", "http://comfy-gateway", "")),
            patch.object(server, "_remote_comfy_workflow_mapping", return_value="ZIT_final_output.api.json"),
            patch.object(server, "_run_remote_comfy_gateway_test", return_value={"ok": True, "prompt_id": "p1", "outputs": [], "local_outputs": []}),
            patch.object(server, "_emit_stage"),
        ):
            with self.assertRaisesRegex(RuntimeError, "未返回可下载图片"):
                server._run_remote_comfy_mapped_task("task_test", payload, "text_to_image")

    def test_text_to_image_batch_qa_accumulates_until_six_passed_images(self) -> None:
        def pass_report():
            return {
                "inspected": True,
                "passed": True,
                "overall_score": 90,
                "prompt_match_score": 88,
                "anatomy_score": 92,
                "visual_score": 88,
                "deliverable_ready": True,
                "issues": [],
            }

        def reject_report():
            return {
                "inspected": True,
                "passed": False,
                "overall_score": 55,
                "prompt_match_score": 70,
                "anatomy_score": 40,
                "visual_score": 60,
                "limb_or_body_broken": True,
                "deliverable_ready": False,
                "issues": ["肢體結構不穩定"],
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_round = []
            second_round = []
            for index in range(1, 4):
                first = root / f"round1_{index}.png"
                second = root / f"round2_{index}.png"
                first.write_bytes(b"first")
                second.write_bytes(b"second")
                first_round.append(str(first))
                second_round.append(str(second))

            comfy_results = [
                {"ok": True, "prompt_id": "prompt_1", "local_outputs": [{"local_path": path} for path in first_round]},
                {"ok": True, "prompt_id": "prompt_2", "local_outputs": [{"local_path": path} for path in second_round]},
            ]
            qa_results = [
                pass_report(),
                pass_report(),
                pass_report(),
                pass_report(),
                pass_report(),
                pass_report(),
            ]

            with (
                patch.object(server, "_run_remote_comfy_gateway_test", side_effect=comfy_results) as run_mock,
                patch.object(server, "_analyze_generated_person_image_quality", side_effect=qa_results),
                patch.object(server, "_new_image_qa_seed", return_value=123456),
                patch.object(server, "_emit_stage"),
            ):
                output = server._run_remote_comfy_mapped_task(
                    "task_batch_qa",
                    {
                        "remote_comfy_gateway_url": "http://comfy.local",
                        "remote_comfy_workflow_mappings": {"text_to_image": "person_t2i.api.json"},
                        "prompt": "一位人物肖像，清晰自然",
                        "width": 640,
                        "height": 960,
                        "batch_size": 3,
                        "text_to_image_qa_target_count": 6,
                        "text_to_image_auto_qa_enabled": True,
                        "text_to_image_auto_qa_max_attempts": 3,
                    },
                    "text_to_image",
                )

        self.assertEqual(run_mock.call_count, 2)
        self.assertEqual(len(output["image_paths"]), 6)
        self.assertEqual(output["image_paths"][:3], first_round)
        self.assertEqual(output["image_paths"][3:], second_round)
        self.assertEqual(output["image_qa"]["target_count"], 6)
        self.assertEqual(output["image_qa"]["checked_count"], 6)
        self.assertEqual(output["image_qa"]["passed_count"], 6)
        self.assertFalse(output["image_qa"]["insufficient_count"])

    def test_text_to_image_batch_qa_fails_when_configured_attempts_end_before_target(self) -> None:
        def pass_report():
            return {
                "inspected": True,
                "passed": True,
                "overall_score": 90,
                "prompt_match_score": 88,
                "anatomy_score": 92,
                "visual_score": 88,
                "deliverable_ready": True,
                "issues": [],
            }

        def reject_report():
            return {
                "inspected": True,
                "passed": False,
                "overall_score": 55,
                "prompt_match_score": 70,
                "anatomy_score": 40,
                "visual_score": 60,
                "limb_or_body_broken": True,
                "deliverable_ready": False,
                "issues": ["肢体结构不稳定"],
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rounds = []
            for round_index in range(1, 4):
                paths = []
                for image_index in range(1, 4):
                    path = root / f"round{round_index}_{image_index}.png"
                    path.write_bytes(f"round-{round_index}-{image_index}".encode("utf-8"))
                    paths.append(str(path))
                rounds.append(paths)

            comfy_results = [
                {"ok": True, "prompt_id": f"prompt_{idx}", "local_outputs": [{"local_path": path} for path in paths]}
                for idx, paths in enumerate(rounds, start=1)
            ]
            qa_results = [
                pass_report(),
                reject_report(),
                pass_report(),
                reject_report(),
                pass_report(),
                pass_report(),
                pass_report(),
                pass_report(),
                reject_report(),
            ]

            with (
                patch.object(server, "_run_remote_comfy_gateway_test", side_effect=comfy_results) as run_mock,
                patch.object(server, "_analyze_generated_person_image_quality", side_effect=qa_results),
                patch.object(server, "_new_image_qa_seed", side_effect=[123456, 123457]),
                patch.object(server, "_emit_stage"),
            ):
                with self.assertRaisesRegex(RuntimeError, "6"):
                    server._run_remote_comfy_mapped_task(
                        "task_batch_qa_unbounded",
                        {
                            "remote_comfy_gateway_url": "http://comfy.local",
                            "remote_comfy_workflow_mappings": {"text_to_image": "person_t2i.api.json"},
                            "prompt": "一位成人女性肖像，清晰自然",
                            "width": 640,
                            "height": 960,
                            "batch_size": 3,
                            "text_to_image_qa_target_count": 6,
                            "text_to_image_auto_qa_enabled": True,
                            "text_to_image_auto_qa_max_attempts": 1,
                        },
                        "text_to_image",
                    )

        self.assertEqual(run_mock.call_count, 1)

    def test_text_to_image_batch_qa_stops_before_next_round_when_cancelled(self) -> None:
        def reject_report():
            return {
                "inspected": True,
                "passed": False,
                "overall_score": 55,
                "prompt_match_score": 70,
                "anatomy_score": 40,
                "visual_score": 60,
                "limb_or_body_broken": True,
                "deliverable_ready": False,
                "issues": ["肢体结构不稳定"],
            }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_round = []
            for index in range(1, 4):
                path = root / f"round1_{index}.png"
                path.write_bytes(b"first")
                first_round.append(str(path))

            with (
                patch.object(
                    server,
                    "_run_remote_comfy_gateway_test",
                    return_value={"ok": True, "prompt_id": "prompt_1", "local_outputs": [{"local_path": path} for path in first_round]},
                ) as run_mock,
                patch.object(server, "_analyze_generated_person_image_quality", return_value=reject_report()),
                patch.object(server, "_task_cancelled_for_payload", side_effect=[False, True]),
                patch.object(server, "_emit_stage"),
            ):
                with self.assertRaisesRegex(RuntimeError, "任务已取消"):
                    server._run_remote_comfy_mapped_task(
                        "task_batch_qa_cancel",
                        {
                            "remote_comfy_gateway_url": "http://comfy.local",
                            "remote_comfy_workflow_mappings": {"text_to_image": "person_t2i.api.json"},
                            "prompt": "一位成人女性肖像，清晰自然",
                            "width": 640,
                            "height": 960,
                            "batch_size": 3,
                            "text_to_image_qa_target_count": 6,
                            "text_to_image_auto_qa_enabled": True,
                            "text_to_image_auto_qa_max_attempts": 3,
                        },
                        "text_to_image",
                    )

        self.assertEqual(run_mock.call_count, 1)


if __name__ == "__main__":
    unittest.main()
