from __future__ import annotations

import math
import subprocess
from pathlib import Path

from imageio_ffmpeg import get_ffmpeg_exe
from mutagen import File as MutagenFile


def extract_audio_track(input_video: Path, output_audio: Path) -> Path:
    if not input_video.exists():
        raise FileNotFoundError(f"找不到輸入視頻: {input_video}")

    output_audio.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(input_video),
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(output_audio),
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if int(completed.returncode or 0) != 0:
        detail = (completed.stderr or completed.stdout or "ffmpeg failed").strip()
        raise RuntimeError(f"抽取音頻失敗: {detail}")

    if not output_audio.exists():
        raise RuntimeError("抽取音頻後未找到輸出文件")
    return output_audio


def extract_video_first_frame(input_video: Path, output_image: Path, *, timestamp_seconds: float = 0.1) -> Path:
    if not input_video.exists():
        raise FileNotFoundError(f"找不到輸入視頻: {input_video}")

    output_image.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-ss",
        str(max(float(timestamp_seconds), 0.0)),
        "-i",
        str(input_video),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_image),
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if int(completed.returncode or 0) != 0:
        detail = (completed.stderr or completed.stdout or "ffmpeg failed").strip()
        raise RuntimeError(f"抽取視頻首幀失敗: {detail}")
    if not output_image.exists():
        raise RuntimeError("抽取視頻首幀後未找到輸出文件")
    return output_image


def get_audio_duration_seconds(audio_path: Path) -> int:
    if not audio_path.exists():
        raise FileNotFoundError(f"找不到音頻文件: {audio_path}")

    media = MutagenFile(str(audio_path))
    if media is None or getattr(media, "info", None) is None:
        raise RuntimeError(f"無法讀取音頻時長: {audio_path}")

    seconds = float(getattr(media.info, "length", 0.0) or 0.0)
    return max(int(math.ceil(seconds)), 1)
