from __future__ import annotations

import shutil
import subprocess
import threading
from pathlib import Path

import pytest

from video_core import source_backend
from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


def _context(event: threading.Event | None = None) -> VideoTaskContext:
    return VideoTaskContext(
        task_id="digital-human-postprocess",
        task_type="create_video",
        cancel_event=event,
    )


def test_detect_audio_silence_ranges_preserves_archived_parser(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    media_path = tmp_path / "segment.mp4"
    media_path.write_bytes(b"segment")
    commands: list[list[str]] = []

    def fake_process(command, **_kwargs):
        commands.append(command)
        return (
            0,
            "",
            "\n".join(
                [
                    "[silencedetect] silence_start: 0.900",
                    "[silencedetect] silence_end: 1.250 | silence_duration: 0.350",
                    "[silencedetect] silence_start: 1.800",
                ]
            ),
        )

    monkeypatch.setattr(source_backend, "_run_local_process", fake_process)
    backend = ArchivedSourceBackend()

    ranges = backend._detect_audio_silence_ranges(
        media_path,
        duration_seconds=2.1,
        payload={"ffmpeg_path": "ffmpeg-test"},
        context=_context(),
    )

    assert ranges == [(0.9, 1.25), (1.8, 2.1)]
    assert commands[0][0] == "ffmpeg-test"
    assert "silencedetect=noise=-34dB:d=0.120" in commands[0]


def test_tail_audio_noise_trim_keeps_archived_thresholds_and_copy_first(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "segment.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "clean" / "segment_tail_noise_trimmed.mp4"
    backend = ArchivedSourceBackend()
    process_commands: list[list[str]] = []

    monkeypatch.setattr(
        backend,
        "_detect_audio_silence_ranges",
        lambda *_args, **_kwargs: [(1.0, 1.3)],
    )
    monkeypatch.setattr(
        backend,
        "_postprocess_duration",
        lambda path, _payload: 1.08 if Path(path) == target else 1.5,
    )

    def fake_process(command, **_kwargs):
        process_commands.append(command)
        Path(command[-1]).write_bytes(b"trimmed")
        return 0, "", ""

    monkeypatch.setattr(source_backend, "_run_local_process", fake_process)
    cleaned = backend._trim_video_tail_audio_noise(
        source,
        target,
        payload={"ffmpeg_path": "ffmpeg-test"},
        context=_context(),
    )

    assert cleaned == target.resolve()
    assert process_commands == [
        [
            "ffmpeg-test",
            "-y",
            "-t",
            "1.080",
            "-i",
            str(source.resolve()),
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(target),
        ]
    ]


def test_concat_wires_tail_cleanup_and_archived_micro_crossfade(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    output = tmp_path / "final.mp4"
    workdir = tmp_path / "work"
    backend = ArchivedSourceBackend()
    process_commands: list[list[str]] = []

    monkeypatch.setattr(backend, "_postprocess_duration", lambda *_args, **_kwargs: 1.0)

    def fake_trim(source, target, **_kwargs):
        if Path(source) == first.resolve():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"cleaned-first")
            return target.resolve()
        return Path(source).resolve()

    monkeypatch.setattr(backend, "_trim_video_tail_audio_noise", fake_trim)

    def fake_process(command, **_kwargs):
        process_commands.append(command)
        if command[-1] != "-":
            Path(command[-1]).write_bytes(b"crossfaded")
        return 0, "", ""

    monkeypatch.setattr(source_backend, "_run_local_process", fake_process)
    result = backend.concat_digital_human_segments(
        video_paths=[first, second],
        output_path=output,
        payload={
            "ffmpeg_path": "ffmpeg-test",
            "digital_human_segment_tail_audio_cleanup_enabled": True,
            "digital_human_audio_micro_crossfade_seconds": 0.04,
        },
        context=_context(),
        workdir=workdir,
    )

    assert result["ok"] is True
    assert result["segment_join_crossfade_seconds"] == pytest.approx(0.04)
    assert result["tail_audio_noise_trims"] == [
        {
            "index": 1,
            "path": str(first.resolve()),
            "trimmed_path": str((workdir / "tail_audio_noise_trimmed_segments" / "first_tail_noise_trimmed.mp4").resolve()),
            "original_seconds": 1.0,
            "trimmed_seconds": 1.0,
            "reason": "tail_audio_noise",
        }
    ]
    filter_complex = process_commands[-1][process_commands[-1].index("-filter_complex") + 1]
    assert "xfade=transition=fade:duration=0.040:offset=0.960" in filter_complex
    assert "acrossfade=d=0.040:c1=tri:c2=tri" in filter_complex


def test_postprocess_cancellation_is_not_swallowed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    event = threading.Event()
    backend = ArchivedSourceBackend()

    def cancel_after_first(source, _target, **_kwargs):
        event.set()
        return Path(source).resolve()

    monkeypatch.setattr(backend, "_trim_video_tail_audio_noise", cancel_after_first)
    with pytest.raises(VideoTaskCancelled):
        backend._clean_video_segments_tail_audio_noise(
            [first, second],
            output_dir=tmp_path / "cleaned",
            payload={},
            context=_context(event),
        )


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe unavailable")
def test_local_ffmpeg_micro_crossfade_forms_playable_closed_loop(tmp_path: Path) -> None:
    ffmpeg = str(shutil.which("ffmpeg"))
    ffprobe = str(shutil.which("ffprobe"))
    segments: list[Path] = []
    for index, color in enumerate(("red", "blue"), start=1):
        path = tmp_path / f"segment-{index}.mp4"
        completed = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c={color}:s=160x120:r=25:d=0.8",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={400 + index * 100}:sample_rate=44100:duration=0.8",
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        segments.append(path)

    output = tmp_path / "final.mp4"
    backend = ArchivedSourceBackend()
    result = backend.concat_digital_human_segments(
        video_paths=segments,
        output_path=output,
        payload={
            "ffmpeg_path": ffmpeg,
            "ffprobe_path": ffprobe,
            "digital_human_audio_micro_crossfade_seconds": 0.04,
            "digital_human_segment_tail_audio_cleanup_enabled": False,
        },
        context=_context(),
        workdir=tmp_path / "work",
    )

    duration = backend._postprocess_duration(output, {"ffprobe_path": ffprobe})
    assert result["segment_join_crossfade_seconds"] == pytest.approx(0.04)
    assert output.is_file() and output.stat().st_size > 0
    assert 1.45 <= duration <= 1.65
