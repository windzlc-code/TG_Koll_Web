from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=90)


def _mean_volume_db(ffmpeg: str, media_path: Path, *, start: float, duration: float) -> float:
    result = _run(
        [
            ffmpeg,
            "-hide_banner",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(media_path),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ]
    )
    match = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", result.stderr)
    assert match, result.stderr
    return float(match.group(1))


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="ffmpeg/ffprobe are required")
def test_digital_human_concat_keeps_latter_video_audio_timeline(tmp_path: Path) -> None:
    """A provider video longer than its audio must not truncate the final join."""

    segment_paths: list[Path] = []
    for index, frequency in enumerate((440, 880), start=1):
        path = tmp_path / f"segment-{index}.mp4"
        _run(
            [
                FFMPEG,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=24:duration=6",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={frequency}:duration=3",
                "-t",
                "6",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(path),
            ]
        )
        segment_paths.append(path)

    output_path = tmp_path / "joined.mp4"
    applied = ArchivedSourceBackend()._concat_digital_human_video_segments(
        segment_paths,
        output_path,
        payload={
            "ffmpeg_path": FFMPEG,
            "ffprobe_path": FFPROBE,
            "digital_human_audio_micro_crossfade_seconds": 0.04,
        },
        context=VideoTaskContext(task_id="audio-continuity", task_type="create_video"),
        workdir=tmp_path,
    )

    assert applied is True
    duration = float(
        _run(
            [
                FFPROBE,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(output_path),
            ]
        ).stdout.strip()
    )
    assert duration >= 11.8
    # The second segment begins around 5.96 seconds.  Its latter half must
    # still contain an audio stream instead of ending at the first short input.
    assert _mean_volume_db(FFMPEG, output_path, start=7.0, duration=2.0) > -40.0
