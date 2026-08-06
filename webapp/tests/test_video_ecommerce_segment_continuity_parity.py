from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from video_core import ecommerce_segment_continuity as continuity
from video_core.contracts import VideoTaskCancelled, VideoTaskContext


def test_empty_recap_and_semantic_product_recap_match_original_source() -> None:
    assert continuity._ecommerce_storyboard_recap_from_prompt(
        segment_prompt="",
        segment_index=2,
        segment_duration=10,
    ) == "本段展示商品/项目与讲解人的互动，结尾自然承接下一段。"

    prompt = (
        "素材说明：参考图编号 1 是产品。片段 2/3，负责总视频 10-20 秒内容，时长 10 秒。"
        "0-5秒：女销售在浴室指向热水器恒温面板。"
        "5-10秒：展示大水量与稳定水流。"
        "分段拼接要求：结尾承接下一段。"
    )
    assert continuity._ecommerce_storyboard_recap_from_prompt(
        segment_prompt=prompt,
        segment_index=2,
        segment_duration=10,
    ) == "女销售员介绍了热水器恒温、大水量与稳定水流的卖点"


def test_recap_filters_instruction_noise_and_honours_max_chars() -> None:
    prompt = "必须保持产品一致。不要出现水印。销售顾问介绍公寓外立面、交通、配套与采光。"
    result = continuity._ecommerce_storyboard_recap_from_prompt(
        segment_prompt=prompt,
        segment_index=1,
        segment_duration=8,
        max_chars=12,
    )
    assert result == "讲解人介绍了公寓外立面"
    assert len(result) <= 12


def _mock_frame_extractor(commands: list[list[str]]) -> Any:
    def fake_run(command: list[str], **kwargs: Any) -> SimpleNamespace:
        assert kwargs == {"capture_output": True, "text": True, "timeout": 60, "check": False}
        commands.append(list(command))
        output = Path(command[-1])
        index = len(commands)
        Image.new("RGB", (120, 80), (index * 30, 80, 180)).save(output, format="JPEG")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return fake_run


def test_storyboard_sheet_extracts_six_even_frames_and_builds_source_layout(tmp_path: Path) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"local-video-placeholder")
    output = tmp_path / "continuity.jpg"
    commands: list[list[str]] = []

    result = continuity._build_ecommerce_storyboard_sheet(
        video_path=source,
        output_path=output,
        segment_index=2,
        segment_duration=12,
        summary="女销售员介绍了热水器恒温与大水量的卖点",
        ratio="9:16",
        ffmpeg_path="mock-ffmpeg",
        run_process=_mock_frame_extractor(commands),
        probe_duration=lambda _path: 12.0,
    )

    assert result == output.resolve()
    assert output.exists()
    assert [command[command.index("-ss") + 1] for command in commands] == [
        "0.000",
        "2.000",
        "4.000",
        "6.000",
        "8.000",
        "10.000",
    ]
    with Image.open(output) as image:
        assert image.size == (1140, 634)
        assert image.mode == "RGB"
    assert not (tmp_path / "continuity_frames").exists()


def test_storyboard_without_annotations_uses_only_grid_height(tmp_path: Path) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"local-video-placeholder")
    output = tmp_path / "plain.jpg"

    continuity._build_ecommerce_storyboard_sheet(
        video_path=source,
        output_path=output,
        segment_index=1,
        segment_duration=6,
        summary="ignored",
        ratio="16:9",
        include_annotations=False,
        ffmpeg_path="mock-ffmpeg",
        run_process=_mock_frame_extractor([]),
        probe_duration=lambda _path: 6.0,
    )

    with Image.open(output) as image:
        assert image.size == (1140, 528)


def test_storyboard_cancellation_stops_between_frame_extractions_and_cleans_temp(tmp_path: Path) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"local-video-placeholder")
    output = tmp_path / "cancelled.jpg"
    calls = 0

    class CancelAfterFirstFrame:
        def is_set(self) -> bool:
            return calls >= 1

    def fake_run(command: list[str], **_kwargs: Any) -> SimpleNamespace:
        nonlocal calls
        calls += 1
        Image.new("RGB", (120, 80), "navy").save(Path(command[-1]), format="JPEG")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    context = VideoTaskContext(
        task_id="continuity-cancel",
        task_type="ecommerce_short_video",
        cancel_event=CancelAfterFirstFrame(),
    )
    with pytest.raises(VideoTaskCancelled):
        continuity._build_ecommerce_storyboard_sheet(
            video_path=source,
            output_path=output,
            segment_index=1,
            segment_duration=6,
            summary="summary",
            ratio="9:16",
            context=context,
            ffmpeg_path="mock-ffmpeg",
            run_process=fake_run,
            probe_duration=lambda _path: 6.0,
        )

    assert calls == 1
    assert not output.exists()
    assert not (tmp_path / "cancelled_frames").exists()


def test_storyboard_raises_source_error_when_no_frame_can_be_extracted(tmp_path: Path) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"local-video-placeholder")
    output = tmp_path / "failed.jpg"

    def failed_run(_command: list[str], **_kwargs: Any) -> SimpleNamespace:
        return SimpleNamespace(returncode=1, stdout="", stderr="failed")

    with pytest.raises(RuntimeError, match="未能从广告短视频片段中抽取前情六宫格帧"):
        continuity._build_ecommerce_storyboard_sheet(
            video_path=source,
            output_path=output,
            segment_index=1,
            segment_duration=6,
            summary="summary",
            ratio="9:16",
            ffmpeg_path="mock-ffmpeg",
            run_process=failed_run,
            probe_duration=lambda _path: 6.0,
        )

    assert not (tmp_path / "failed_frames").exists()
