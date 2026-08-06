from __future__ import annotations

from pathlib import Path

from video_core.ecommerce_segment_audio import prepare_ecommerce_segment_audio_paths


def test_single_reference_is_split_by_dialogue_weight_without_exceeding_segment_limits(tmp_path: Path) -> None:
    source = tmp_path / "voice.wav"
    source.write_bytes(b"voice")
    cuts: list[tuple[float, float, str]] = []

    def cut(_source: Path, target: Path, start: float, duration: float) -> Path:
        cuts.append((start, duration, target.name))
        target.write_bytes(b"cut")
        return target.resolve()

    result = prepare_ecommerce_segment_audio_paths(
        audio_inputs=[source],
        segment_durations=[5, 10],
        workdir=tmp_path / "audio",
        segment_dialogues=["短句", "This is a much longer spoken product explanation"],
        probe_duration=lambda _path: 12.0,
        cut_segment=cut,
    )

    assert [item.name for item in result if item] == [
        "ecommerce_voice_audio_segment_1.mp3",
        "ecommerce_voice_audio_segment_2.mp3",
    ]
    assert cuts[0][0] == 0.0
    assert cuts[1][0] == cuts[0][1]
    assert cuts[0][1] <= 5
    assert cuts[1][1] <= 10


def test_short_single_segment_reuses_original_reference_without_cutting(tmp_path: Path) -> None:
    source = tmp_path / "voice.wav"
    source.write_bytes(b"voice")
    result = prepare_ecommerce_segment_audio_paths(
        audio_inputs=[source],
        segment_durations=[10],
        workdir=tmp_path / "audio",
        probe_duration=lambda _path: 8.0,
        cut_segment=lambda *_args: (_ for _ in ()).throw(AssertionError("must not cut")),
    )
    assert result == [source.resolve()]


def test_cancellation_is_checked_before_each_cut(tmp_path: Path) -> None:
    source = tmp_path / "voice.wav"
    source.write_bytes(b"voice")
    checks: list[int] = []

    def cut(_source: Path, target: Path, _start: float, _duration: float) -> Path:
        target.write_bytes(b"cut")
        return target

    prepare_ecommerce_segment_audio_paths(
        audio_inputs=[source],
        segment_durations=[5, 5, 5],
        workdir=tmp_path / "audio",
        segment_dialogues=["one", "two", "three"],
        probe_duration=lambda _path: 15.0,
        cut_segment=cut,
        check_cancelled=lambda: checks.append(1),
    )
    assert len(checks) == 3
