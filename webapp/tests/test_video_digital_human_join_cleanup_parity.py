from __future__ import annotations

import threading
from pathlib import Path

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.digital_human_join_cleanup import (
    _digital_human_leading_silence_trim_seconds,
    _digital_human_segment_head_keep_silence_seconds,
    _digital_human_segment_head_max_silence_seconds,
    _digital_human_segment_join_gap_budget_seconds,
    _digital_human_segment_join_min_tail_quiet_seconds,
    _digital_human_segment_leading_silence_enabled,
    _digital_human_segment_tail_cooldown_enabled,
    _digital_human_segment_tail_cooldown_seconds,
    _digital_human_segment_tail_max_silence_seconds,
    _digital_human_tail_cooldown_trim_seconds,
    normalize_digital_human_segment_joins,
)


def _context(cancel_event: threading.Event | None = None) -> VideoTaskContext:
    return VideoTaskContext(
        task_id="join-cleanup-test",
        task_type="create_video",
        cancel_event=cancel_event,
    )


def _touch_segments(tmp_path: Path, count: int = 2) -> list[Path]:
    paths: list[Path] = []
    for index in range(1, count + 1):
        path = tmp_path / f"segment-{index}.mp4"
        path.write_bytes(b"video")
        paths.append(path)
    return paths


def test_archived_defaults_and_clamps_are_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "DIGITAL_HUMAN_SEGMENT_TAIL_COOLDOWN_ENABLED",
        "DIGITAL_HUMAN_SEGMENT_TAIL_COOLDOWN_SECONDS",
        "DIGITAL_HUMAN_SEGMENT_TAIL_MAX_SILENCE_SECONDS",
        "DIGITAL_HUMAN_SEGMENT_LEADING_SILENCE_ENABLED",
        "DIGITAL_HUMAN_SEGMENT_HEAD_KEEP_SILENCE_SECONDS",
        "DIGITAL_HUMAN_SEGMENT_HEAD_MAX_SILENCE_SECONDS",
        "DIGITAL_HUMAN_SEGMENT_JOIN_GAP_BUDGET_SECONDS",
        "DIGITAL_HUMAN_SEGMENT_JOIN_MIN_TAIL_QUIET_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)

    assert _digital_human_segment_tail_cooldown_enabled({}) is True
    assert _digital_human_segment_tail_cooldown_seconds({}) == pytest.approx(0.35)
    assert _digital_human_segment_tail_max_silence_seconds({}) == pytest.approx(0.65)
    assert _digital_human_segment_leading_silence_enabled({}) is True
    assert _digital_human_segment_head_keep_silence_seconds({}) == pytest.approx(0.04)
    assert _digital_human_segment_head_max_silence_seconds({}) == pytest.approx(0.08)
    assert _digital_human_segment_join_gap_budget_seconds({}) == pytest.approx(0.24)
    assert _digital_human_segment_join_min_tail_quiet_seconds({}) == pytest.approx(0.16)

    payload = {
        "digital_human_segment_tail_cooldown_seconds": 9,
        "digital_human_segment_tail_max_silence_seconds": 0,
        "digital_human_segment_head_keep_silence_seconds": 9,
        "digital_human_segment_head_max_silence_seconds": 0,
        "digital_human_segment_join_gap_budget_seconds": 0,
        "digital_human_segment_join_min_tail_quiet_seconds": 9,
    }
    assert _digital_human_segment_tail_cooldown_seconds(payload) == pytest.approx(1.2)
    assert _digital_human_segment_tail_max_silence_seconds(payload) == pytest.approx(1.28)
    assert _digital_human_segment_head_keep_silence_seconds(payload) == pytest.approx(0.18)
    assert _digital_human_segment_head_max_silence_seconds(payload) == pytest.approx(0.20)
    assert _digital_human_segment_join_gap_budget_seconds(payload) == pytest.approx(0.16)
    assert _digital_human_segment_join_min_tail_quiet_seconds(payload) == pytest.approx(0.5)


def test_disabled_cleanup_returns_original_paths_without_running_tools(tmp_path: Path) -> None:
    segments = _touch_segments(tmp_path)

    def forbidden(**_kwargs: object) -> object:
        raise AssertionError("disabled cleanup must not invoke probe or ffmpeg")

    output_paths, trims = normalize_digital_human_segment_joins(
        segments,
        output_dir=tmp_path / "cleanup",
        payload={"digital_human_segment_tail_cooldown_enabled": False},
        context=_context(),
        probe=forbidden,
        run=forbidden,
    )

    assert output_paths == [path.resolve() for path in segments]
    assert trims == []
    assert not (tmp_path / "cleanup").exists()


def test_archived_leading_and_tail_trim_decisions(tmp_path: Path) -> None:
    media = _touch_segments(tmp_path, 1)[0]

    def leading_run(**_kwargs: object) -> dict[str, object]:
        return {"returncode": 0, "stderr": "silence_start: 0\nsilence_end: 0.500"}

    def trailing_run(**_kwargs: object) -> dict[str, object]:
        return {"returncode": 0, "stderr": "silence_start: 2.000\nsilence_end: 3.000"}

    leading_trim = _digital_human_leading_silence_trim_seconds(
        media,
        duration_seconds=3.0,
        keep_quiet_seconds=0.04,
        max_quiet_seconds=0.08,
        payload={"ffmpeg_path": "mock-ffmpeg"},
        context=_context(),
        run=leading_run,
    )
    tail_trim = _digital_human_tail_cooldown_trim_seconds(
        media,
        duration_seconds=3.0,
        target_quiet_seconds=0.35,
        max_quiet_seconds=0.65,
        payload={"ffmpeg_path": "mock-ffmpeg"},
        context=_context(),
        run=trailing_run,
    )

    assert leading_trim == pytest.approx(0.46)
    assert tail_trim == pytest.approx(2.35)


def test_full_cleanup_preserves_original_order_and_reports_all_trim_reasons(tmp_path: Path) -> None:
    segments = _touch_segments(tmp_path)
    generated_durations: dict[Path, float] = {}

    def probe(*, path: Path, **_kwargs: object) -> float:
        return generated_durations.get(Path(path).resolve(), 3.0)

    def run(*, command: list[str], **_kwargs: object) -> dict[str, object]:
        if any("silencedetect=" in part for part in command):
            source = Path(command[command.index("-i") + 1]).resolve()
            if "segment-1" in source.name:
                stderr = "silence_start: 2.000\nsilence_end: 3.000"
            elif "tail_cooldown" in source.name:
                duration = generated_durations[source]
                stderr = f"silence_start: {duration - 0.35:.3f}\nsilence_end: {duration:.3f}"
            elif "leading_silence" in source.name:
                stderr = "silence_start: 0\nsilence_end: 0.040"
            else:
                stderr = "silence_start: 0\nsilence_end: 0.500"
            return {"returncode": 0, "stderr": stderr}

        target = Path(command[-1]).resolve()
        source = Path(command[command.index("-i") + 1]).resolve()
        source_duration = generated_durations.get(source, 3.0)
        if "-t" in command:
            duration = float(command[command.index("-t") + 1])
        elif "-ss" in command:
            duration = source_duration - float(command[command.index("-ss") + 1])
        else:
            duration = source_duration
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"trimmed")
        generated_durations[target] = duration
        return {"returncode": 0}

    output_paths, trims = normalize_digital_human_segment_joins(
        segments,
        output_dir=tmp_path / "cleanup",
        payload={"ffmpeg_path": "mock-ffmpeg"},
        context=_context(),
        probe=probe,
        run=run,
    )

    assert len(output_paths) == 2
    assert all(path.exists() for path in output_paths)
    reasons = [item.get("reason") for item in trims]
    assert "tail_cooldown" in reasons
    assert "leading_silence" in reasons
    assert "join_gap_budget" in reasons
    assert output_paths[0].name == "1_join_gap_tightened.mp4"
    assert output_paths[1].name == "2_leading_silence.mp4"


def test_trim_failures_degrade_to_original_segments(tmp_path: Path) -> None:
    segments = _touch_segments(tmp_path)

    def probe(**_kwargs: object) -> float:
        return 3.0

    def run(*, command: list[str], **_kwargs: object) -> dict[str, object]:
        if any("silencedetect=" in part for part in command):
            source = Path(command[command.index("-i") + 1])
            stderr = (
                "silence_start: 2.000\nsilence_end: 3.000"
                if "segment-1" in source.name
                else "silence_start: 0\nsilence_end: 0.500"
            )
            return {"returncode": 0, "stderr": stderr}
        return {"returncode": 1, "stderr": "simulated local ffmpeg failure"}

    output_paths, trims = normalize_digital_human_segment_joins(
        segments,
        output_dir=tmp_path / "cleanup",
        payload={"ffmpeg_path": "mock-ffmpeg"},
        context=_context(),
        probe=probe,
        run=run,
    )

    assert output_paths == [path.resolve() for path in segments]
    skipped = [item for item in trims if "skipped" in item]
    assert len(skipped) >= 2
    assert all("simulated local ffmpeg failure" in item["skipped"] for item in skipped)


def test_cancellation_is_never_swallowed_by_fallback(tmp_path: Path) -> None:
    event = threading.Event()
    event.set()

    with pytest.raises(VideoTaskCancelled):
        normalize_digital_human_segment_joins(
            _touch_segments(tmp_path),
            output_dir=tmp_path / "cleanup",
            payload={},
            context=_context(event),
            probe=lambda **_kwargs: 3.0,
            run=lambda **_kwargs: {"returncode": 0},
        )
