from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
VIDEO_SECONDS = 15.0
TTS_SECONDS = 8.4
TAIL_COOLDOWN_SECONDS = 0.35
MAX_SEGMENT_QUIET_TAIL_SECONDS = 0.65
MICRO_CROSSFADE_SECONDS = 0.04
EXPECTED_CROPPED_SEGMENT_SECONDS = TTS_SECONDS + TAIL_COOLDOWN_SECONDS


def _run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _probe_duration(path: Path, *, stream: str | None = None) -> float:
    command = [FFPROBE, "-v", "error"]
    if stream:
        command.extend(["-select_streams", stream])
        entries = "stream=duration"
    else:
        entries = "format=duration"
    command.extend(
        [
            "-show_entries",
            entries,
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    output = _run(command).stdout.strip().splitlines()
    assert output, f"ffprobe did not return a duration for {path}"
    return float(output[0])


def _make_tts_audio(path: Path, *, ffmpeg: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=660:sample_rate=48000:duration={TTS_SECONDS:.3f}",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            str(path),
        ]
    )


def _make_provider_like_video(path: Path, *, ffmpeg: str, frequency: int) -> None:
    """Create a provider response with 15s AAC: 8.4s tone followed by silence."""

    path.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=320x240:rate=24:duration={VIDEO_SECONDS:.3f}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=48000:duration={TTS_SECONDS:.3f}",
            "-af",
            "apad",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-t",
            f"{VIDEO_SECONDS:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(path),
        ]
    )


def _trailing_silence_seconds(path: Path) -> float:
    """Measure the tail gap, including an audio stream that ends before video."""

    video_duration = _probe_duration(path, stream="v:0")
    audio_duration = _probe_duration(path, stream="a:0")
    detected_ranges: list[tuple[float, float]] = []
    current_start: float | None = None
    detected = _run(
        [
            FFMPEG,
            "-hide_banner",
            "-i",
            str(path),
            "-af",
            "silencedetect=noise=-38dB:d=0.120",
            "-f",
            "null",
            "-",
        ],
        check=False,
    )
    for line in f"{detected.stdout}\n{detected.stderr}".splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            current_start = float(start_match.group(1))
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match and current_start is not None:
            detected_ranges.append((current_start, float(end_match.group(1))))
            current_start = None
    if current_start is not None:
        detected_ranges.append((current_start, video_duration))

    for start, end in reversed(detected_ranges):
        if video_duration - end <= 0.20:
            return max(video_duration - start, 0.0)
    return max(video_duration - audio_duration, 0.0)


def _assert_no_excessive_tail_silence(path: Path) -> None:
    tail = _trailing_silence_seconds(path)
    assert tail <= MAX_SEGMENT_QUIET_TAIL_SECONDS, (
        f"{path} keeps {tail:.3f}s of tail silence; the provider fixture has only "
        f"{TTS_SECONDS:.3f}s of non-silent TTS audio"
    )


class _LocalDigitalHumanBackend(ArchivedSourceBackend):
    """Use only local ffmpeg fixtures in place of TTS and provider calls."""

    def __init__(self, *, ffmpeg: str) -> None:
        super().__init__()
        self.ffmpeg = ffmpeg
        self.submit_payloads: list[dict[str, Any]] = []
        self.provider_output_audio_durations: list[float] = []
        self.provider_output_tail_silences: list[float] = []

    def _generate_minimax_tts(self, *, output_path: Path, **_kwargs: Any) -> Path:
        _make_tts_audio(output_path, ffmpeg=self.ffmpeg)
        return output_path

    def _resolve_media(self, *, local_values: tuple[Any, ...], **_kwargs: Any) -> str:
        value = next((str(item) for item in local_values if str(item or "").strip()), "")
        assert value
        return value

    def _submit_and_poll(self, *, submit_payload: dict[str, Any], output_path: Path, **_kwargs: Any) -> dict[str, Any]:
        self.submit_payloads.append(submit_payload)
        _make_provider_like_video(output_path, ffmpeg=self.ffmpeg, frequency=660)
        # Cleanup may overwrite the same path, so capture the provider fixture's
        # media facts before returning it to the production postprocessor.
        self.provider_output_audio_durations.append(_probe_duration(output_path, stream="a:0"))
        self.provider_output_tail_silences.append(_trailing_silence_seconds(output_path))
        return {"status": "success", "runninghub_task_id": "local-provider-fixture"}


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="ffmpeg/ffprobe are required")
def test_generate_digital_human_segment_closes_provider_video_to_tts_audio(tmp_path: Path) -> None:
    """A 15s provider response is cropped to the 8.4s TTS tail budget."""

    output_path = tmp_path / "segment-final.mp4"
    backend = _LocalDigitalHumanBackend(ffmpeg=FFMPEG)
    result = backend.generate_digital_human_segment(
        task_id="local-audio-tail-single",
        payload={
            "duration_seconds": VIDEO_SECONDS,
            "ffmpeg_path": FFMPEG,
            "ffprobe_path": FFPROBE,
            "oral_digital_human_workflow_ids": ["2068273204367544322"],
            "digital_human_segment_tail_cooldown_enabled": True,
            "digital_human_segment_tail_cooldown_seconds": TAIL_COOLDOWN_SECONDS,
            "digital_human_segment_tail_max_silence_seconds": MAX_SEGMENT_QUIET_TAIL_SECONDS,
        },
        context=VideoTaskContext(task_id="local-audio-tail-single", task_type="create_video"),
        workdir=tmp_path / "work",
        output_path=output_path,
        segment_index=1,
        script_text="本地回归音频。",
        prompt_text="固定镜头。",
        source_image_path="presenter.png",
    )

    final_path = Path(result["video_path"])
    assert backend.provider_output_audio_durations == pytest.approx([VIDEO_SECONDS], abs=0.15)
    assert backend.provider_output_tail_silences[0] >= VIDEO_SECONDS - TTS_SECONDS - 0.20
    assert result["duration_seconds"] == pytest.approx(TTS_SECONDS, abs=0.15)
    video_duration = _probe_duration(final_path, stream="v:0")
    assert video_duration == pytest.approx(EXPECTED_CROPPED_SEGMENT_SECONDS, abs=0.20)
    assert _probe_duration(final_path, stream="a:0") == pytest.approx(EXPECTED_CROPPED_SEGMENT_SECONDS, abs=0.20)
    _assert_no_excessive_tail_silence(final_path)


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="ffmpeg/ffprobe are required")
def test_concat_digital_human_segments_closes_last_provider_audio_tail(tmp_path: Path) -> None:
    """Two 15s provider responses become two 8.75s segments before concat."""

    segments = [
        tmp_path / "segment-1.mp4",
        tmp_path / "segment-2.mp4",
    ]
    for path, frequency in zip(segments, (440, 880)):
        _make_provider_like_video(path, ffmpeg=FFMPEG, frequency=frequency)

    output_path = tmp_path / "joined-final.mp4"
    result = ArchivedSourceBackend().concat_digital_human_segments(
        video_paths=segments,
        output_path=output_path,
        payload={
            "ffmpeg_path": FFMPEG,
            "ffprobe_path": FFPROBE,
            "digital_human_segment_tail_audio_cleanup_enabled": False,
            "digital_human_segment_tail_cooldown_enabled": True,
            "digital_human_segment_tail_cooldown_seconds": TAIL_COOLDOWN_SECONDS,
            "digital_human_segment_tail_max_silence_seconds": MAX_SEGMENT_QUIET_TAIL_SECONDS,
            "digital_human_audio_micro_crossfade_seconds": MICRO_CROSSFADE_SECONDS,
        },
        context=VideoTaskContext(task_id="local-audio-tail-multi", task_type="create_video"),
        workdir=tmp_path / "work",
    )

    assert result["ok"] is True
    for segment in segments:
        assert _probe_duration(segment, stream="a:0") == pytest.approx(VIDEO_SECONDS, abs=0.15)
        assert _trailing_silence_seconds(segment) >= VIDEO_SECONDS - TTS_SECONDS - 0.20

    final_durations = {
        "format": _probe_duration(output_path),
        "video": _probe_duration(output_path, stream="v:0"),
        "audio": _probe_duration(output_path, stream="a:0"),
    }
    expected_multi_duration = (2 * EXPECTED_CROPPED_SEGMENT_SECONDS) - MICRO_CROSSFADE_SECONDS
    for stream_name, duration in final_durations.items():
        assert duration == pytest.approx(expected_multi_duration, abs=0.25), (
            f"{stream_name} timeline {duration:.3f}s is not the sum of two "
            f"{EXPECTED_CROPPED_SEGMENT_SECONDS:.2f}s cropped segments"
        )
    _assert_no_excessive_tail_silence(output_path)
