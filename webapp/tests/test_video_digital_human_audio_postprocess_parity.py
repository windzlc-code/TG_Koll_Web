from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from video_core import digital_human_audio_postprocess as audio_postprocess
from video_core.contracts import VideoTaskCancelled, VideoTaskContext


def _context(event: threading.Event | None = None) -> VideoTaskContext:
    return VideoTaskContext(
        task_id="digital-human-audio-postprocess",
        task_type="create_video",
        cancel_event=event,
    )


def _successful_runner(commands: list[list[str]], timeouts: list[int]):
    def run(*, command: list[str], timeout_seconds: int, **_kwargs: Any) -> tuple[int, str, str]:
        commands.append(command)
        timeouts.append(timeout_seconds)
        Path(command[-1]).write_bytes(b"mock-ffmpeg-output")
        return 0, "", ""

    return run


def test_defaults_leave_video_untouched_without_running_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("DIGITAL_HUMAN_AUDIO_DELAY_SECONDS", raising=False)
    monkeypatch.delenv("DIGITAL_HUMAN_VIDEO_END_PADDING_SECONDS", raising=False)
    monkeypatch.delenv("DIGITAL_HUMAN_AMBIENT_AUDIO_ENABLED", raising=False)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")

    def unexpected_run(**_kwargs: Any) -> Any:
        raise AssertionError("default audio postprocess must not invoke ffmpeg")

    result, meta = audio_postprocess.postprocess_digital_human_audio(
        source,
        payload={"ffmpeg_path": "ffmpeg-mock"},
        context=_context(),
        probe=lambda **_kwargs: 4.0,
        run=unexpected_run,
    )

    assert result == source.resolve()
    assert meta == {
        "audio_delay": None,
        "ambient_audio": None,
        "tail_padding": None,
        "warnings": [],
    }
    assert audio_postprocess._digital_human_audio_delay_seconds({}) == 0.0
    assert audio_postprocess._digital_human_audio_delay_seconds(
        {"digital_human_audio_delay_seconds": -1}
    ) == 0.0
    assert audio_postprocess._digital_human_video_end_padding_seconds({}) == 0.0
    assert audio_postprocess._digital_human_ambient_audio_enabled({}) is True


def test_audio_delay_preserves_archived_ffmpeg_command_and_metadata(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    target = tmp_path / "nested" / "delayed.mp4"
    source.write_bytes(b"source")
    commands: list[list[str]] = []
    timeouts: list[int] = []

    result, meta = audio_postprocess._apply_digital_human_audio_delay(
        source,
        output_path=target,
        payload={"ffmpeg_path": "ffmpeg-mock", "digital_human_audio_delay_seconds": 0.8},
        context=_context(),
        probe=lambda **_kwargs: 2.5,
        run=_successful_runner(commands, timeouts),
    )

    assert result == target.resolve()
    assert meta == {
        "input_path": str(source.resolve()),
        "output_path": str(target.resolve()),
        "delay_seconds": 0.8,
    }
    assert commands == [
        [
            "ffmpeg-mock",
            "-y",
            "-i",
            str(source.resolve()),
            "-filter_complex",
            "[0:v]tpad=stop_mode=clone:stop_duration=0.800[v];[0:a]adelay=800:all=1[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-t",
            "3.300",
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-preset",
            "veryfast",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(target),
        ]
    ]
    assert timeouts == [300]


def test_tail_padding_preserves_archived_filters_and_zero_probe_downgrade(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    target = tmp_path / "tail.mp4"
    source.write_bytes(b"source")
    commands: list[list[str]] = []
    timeouts: list[int] = []

    unchanged = audio_postprocess._pad_video_audio_tail(
        source,
        target,
        padding_seconds=1.25,
        payload={"ffmpeg_path": "ffmpeg-mock"},
        context=_context(),
        probe=lambda **_kwargs: 0.0,
        run=lambda **_kwargs: pytest.fail("zero-duration padding should not invoke ffmpeg"),
    )
    assert unchanged == source.resolve()

    padded = audio_postprocess._pad_video_audio_tail(
        source,
        target,
        padding_seconds=1.25,
        payload={"ffmpeg_path": "ffmpeg-mock"},
        context=_context(),
        probe=lambda **_kwargs: 4.0,
        run=_successful_runner(commands, timeouts),
    )

    assert padded == target.resolve()
    command = commands[0]
    assert command[command.index("-filter_complex") + 1] == (
        "[0:v]tpad=stop_mode=clone:stop_duration=1.250[v];[0:a]apad=pad_dur=1.250[a]"
    )
    assert command[command.index("-t") + 1] == "5.250"
    assert command[command.index("-c:v") + 1] == "libx264"
    assert command[command.index("-c:a") + 1] == "aac"
    assert timeouts == [600]


def test_ambient_scene_context_and_mix_command_match_archived_behavior(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    target = tmp_path / "ambient.mp4"
    source.write_bytes(b"source")
    commands: list[list[str]] = []
    timeouts: list[int] = []
    payload = {
        "ffmpeg_path": "ffmpeg-mock",
        "product_description": "湖边花园自然景观",
        "digital_human_product_reference_analysis": {"style": "住宅"},
        "scene_image_local_paths": ["/tmp/garden-view.png"],
    }

    result, meta = audio_postprocess._apply_digital_human_ambient_audio(
        source,
        output_path=target,
        payload=payload,
        context=_context(),
        probe=lambda **_kwargs: 5.0,
        run=_successful_runner(commands, timeouts),
    )

    assert result == target.resolve()
    assert meta is not None
    assert meta["scene"] == "nature"
    assert meta["label"] == "自然白噪音"
    assert meta["ambient_source"] == "anoisesrc=color=brown:amplitude=0.032:sample_rate=48000"
    assert meta["ambient_filters"].endswith("afade=t=out:st=4.200:d=0.8")
    command = commands[0]
    assert command[command.index("-f") + 1] == "lavfi"
    assert command[command.index("-t") + 1] == "5.000"
    assert command[command.index("-c:v") + 1] == "copy"
    filter_complex = command[command.index("-filter_complex") + 1]
    assert "aecho=0.98:1.0:70|145:0.055|0.03[voice]" in filter_complex
    assert "amix=inputs=2:duration=first:dropout_transition=0:normalize=0" in filter_complex
    assert timeouts == [600]


def test_segment_preview_falls_back_per_failed_ffmpeg_call(tmp_path: Path) -> None:
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    calls = 0

    def run(*, command: list[str], **_kwargs: Any) -> tuple[int, str, str]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return 1, "", "preview failed"
        Path(command[-1]).write_bytes(b"preview")
        return 0, "", ""

    paths, meta = audio_postprocess.build_digital_human_segment_previews(
        [first, second],
        output_dir=tmp_path / "previews",
        payload={"ffmpeg_path": "ffmpeg-mock", "digital_human_video_end_padding_seconds": 0.6},
        context=_context(),
        probe=lambda **_kwargs: 2.0,
        run=run,
    )

    assert paths == [first.resolve(), (tmp_path / "previews" / "2_preview_tail_pad.mp4").resolve()]
    assert meta[0] == {
        "index": 1,
        "input_path": str(first.resolve()),
        "output_path": str(first.resolve()),
        "padding_seconds": 0.0,
        "error": "preview failed",
    }
    assert meta[1]["padding_seconds"] == pytest.approx(0.6)
    assert "error" not in meta[1]


def test_public_chain_degrades_failed_ambient_stage_and_continues(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    commands: list[list[str]] = []

    def run(*, command: list[str], **_kwargs: Any) -> tuple[int, str, str]:
        commands.append(command)
        if "lavfi" in command:
            return 1, "", "ambient unavailable"
        Path(command[-1]).write_bytes(b"output")
        return 0, "", ""

    result, meta = audio_postprocess.postprocess_digital_human_audio(
        source,
        payload={
            "ffmpeg_path": "ffmpeg-mock",
            "digital_human_audio_delay_seconds": 0.2,
            "digital_human_ambient_scene": "indoor",
            "digital_human_video_end_padding_seconds": 0.4,
        },
        context=_context(),
        probe=lambda **_kwargs: 3.0,
        run=run,
    )

    assert result.name == "source_audio_delay_tail_pad.mp4"
    assert result.exists()
    assert meta["audio_delay"] is not None
    assert meta["ambient_audio"] is None
    assert meta["tail_padding"] is not None
    assert meta["warnings"] == ["ambient_audio_failed: ambient unavailable"]
    assert len(commands) == 3


def test_cancellation_propagates_before_and_after_injected_run(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    pre_cancelled = threading.Event()
    pre_cancelled.set()

    with pytest.raises(VideoTaskCancelled, match="digital-human-audio-postprocess"):
        audio_postprocess.postprocess_digital_human_audio(
            source,
            payload={},
            context=_context(pre_cancelled),
        )

    cancelled_during_run = threading.Event()

    def cancelling_run(*, command: list[str], **_kwargs: Any) -> tuple[int, str, str]:
        Path(command[-1]).write_bytes(b"output")
        cancelled_during_run.set()
        return 0, "", ""

    with pytest.raises(VideoTaskCancelled, match="digital-human-audio-postprocess"):
        audio_postprocess._apply_digital_human_audio_delay(
            source,
            payload={"ffmpeg_path": "ffmpeg-mock", "digital_human_audio_delay_seconds": 0.3},
            context=_context(cancelled_during_run),
            probe=lambda **_kwargs: 2.0,
            run=cancelling_run,
        )


def test_segment_duration_helpers_preserve_count_crossfade_and_tail_rules() -> None:
    adjusted = audio_postprocess.adjust_digital_human_segment_durations(
        [1.0, 0.03, 2.0],
        expected_count=3,
        crossfade_seconds=0.04,
        tail_padding_meta={"padding_seconds": 0.5},
    )

    assert adjusted == pytest.approx([0.96, 0.01, 2.5])
    assert audio_postprocess.adjust_digital_human_segment_durations(
        [1.0, 2.0],
        expected_count=3,
        crossfade_seconds=0.04,
    ) is None
