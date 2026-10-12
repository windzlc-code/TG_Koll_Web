from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import pytest

from video_core.contracts import VideoTaskContext
from video_core.source import create_video
from video_core.source_backend import ArchivedSourceBackend


@pytest.mark.parametrize(
    ("app_id", "expected_duration_field"),
    [
        (create_video.DIGITAL_HUMAN_VIDEO_APP_ID, "0"),
        (create_video.LEGACY_INFINITETALK_VIDEO_APP_ID, "9"),
    ],
)
def test_digital_human_segment_preserves_workflow_audio_duration_contract(
    app_id: str,
    expected_duration_field: str,
) -> None:
    submissions: list[dict[str, Any]] = []

    class MediaDurationBackend(ArchivedSourceBackend):
        def _generate_minimax_tts(self, *, output_path: Path, **_kwargs: Any) -> Path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake-audio")
            return output_path

        @staticmethod
        def _probe_media_duration_seconds(_path: Path, _payload: dict[str, Any]) -> float:
            return 8.388

        @staticmethod
        def _probe_duration(_path: Path, _payload: dict[str, Any]) -> float:
            return 15.0

        def _resolve_media(self, **kwargs: Any) -> str:
            return f"https://media.invalid/{kwargs['media_kind']}"

        def _submit_and_poll(self, **kwargs: Any) -> dict[str, Any]:
            submissions.append(kwargs)
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake-video")
            return {"status": "success", "runninghub_task_id": "mock-video-1"}

    with tempfile.TemporaryDirectory() as tmpdir:
        result = MediaDurationBackend().generate_digital_human_segment(
            task_id="task-audio-duration",
            payload={
                "duration_seconds": 15,
                "oral_digital_human_workflow_ids": [app_id],
            },
            context=VideoTaskContext(task_id="task-audio-duration", task_type="create_video"),
            workdir=Path(tmpdir) / "work",
            output_path=Path(tmpdir) / "final.mp4",
            segment_index=1,
            script_text="欢迎了解产品。",
            prompt_text="角色面向镜头说话，固定镜头。",
            source_image_path="presenter.png",
        )

    assert result["duration_seconds"] == 8.388
    node_info = submissions[0]["submit_payload"]["nodeInfoList"]
    duration_node = next(item for item in node_info if item["nodeId"] in {"349", "231"})
    assert duration_node["fieldValue"] == expected_duration_field
