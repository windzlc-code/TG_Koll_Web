from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from video_core.source import create_video
from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


def test_current_digital_human_app_uses_live_editable_node_contract() -> None:
    nodes = create_video._build_node_info_list(
        app_id=create_video.DIGITAL_HUMAN_VIDEO_APP_ID,
        image_url="api/presenter.png",
        audio_url="api/speech.mp3",
        duration_seconds=15,
        prompt_text="角色面向镜头说话，固定镜头。",
    )

    assert [(item["nodeId"], item["fieldName"]) for item in nodes] == [
        ("269", "image"),
        ("332", "audio"),
        ("349", "value"),
        ("392", "value"),
        ("303", "value"),
        ("347", "value"),
        ("346", "value"),
    ]
    assert nodes[2]["fieldValue"] == "15"
    assert nodes[3]["fieldValue"] == "0"
    assert nodes[4]["fieldValue"]
    assert nodes[5]["fieldValue"] == str(create_video.CURRENT_VIDEO_MAX_RESOLUTION)
    assert nodes[6]["fieldValue"] == str(create_video.CURRENT_VIDEO_FRAME_RATE)


def test_digital_human_segment_closes_over_current_contract_without_provider_call() -> None:
    submissions: list[dict[str, Any]] = []

    class NoPaidProviderBackend(ArchivedSourceBackend):
        def _generate_minimax_tts(self, *, output_path: Path, **_kwargs: Any) -> Path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake-audio")
            return output_path

        @staticmethod
        def _probe_duration(_path: Path, _payload: dict[str, Any]) -> float:
            return 12.0

        def _resolve_media(self, **kwargs: Any) -> str:
            return f"https://media.invalid/{kwargs['media_kind']}"

        def _submit_and_poll(self, **kwargs: Any) -> dict[str, Any]:
            submissions.append(kwargs)
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake-video")
            return {"status": "success", "runninghub_task_id": "mock-video-1"}

    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "final.mp4"
        result = NoPaidProviderBackend().generate_digital_human_segment(
            task_id="task-contract",
            payload={"oral_digital_human_workflow_ids": [create_video.DIGITAL_HUMAN_VIDEO_APP_ID]},
            context=VideoTaskContext(task_id="task-contract", task_type="create_video"),
            workdir=Path(tmpdir) / "work",
            output_path=output_path,
            segment_index=1,
            script_text="欢迎了解产品。",
            prompt_text="角色面向镜头说话，固定镜头。",
            source_image_path="presenter.png",
        )
        output_bytes = output_path.read_bytes()

    assert result["video_path"] == str(output_path)
    assert output_bytes == b"fake-video"
    assert len(submissions) == 1
    submit_payload = submissions[0]["submit_payload"]
    assert [(item["nodeId"], item["fieldName"]) for item in submit_payload["nodeInfoList"]] == [
        ("269", "image"),
        ("332", "audio"),
        ("349", "value"),
        ("392", "value"),
        ("303", "value"),
        ("347", "value"),
        ("346", "value"),
    ]
    assert submit_payload["instanceType"] == "plus"
    assert submissions[0]["submit_url"].endswith(f"/openapi/v2/run/ai-app/{create_video.DIGITAL_HUMAN_VIDEO_APP_ID}")
