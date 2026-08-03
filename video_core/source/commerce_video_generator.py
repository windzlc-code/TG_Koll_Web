import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
import zipfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from PIL import Image, ImageChops, ImageOps, ImageStat

from . import create_audio
from . import create_video
from . import image_model_api
from . import runninghub_common


VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".webm"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
DIGITAL_HUMAN_VIDEO_MAX_AUDIO_SEGMENT_SECONDS = 30.0
DIGITAL_HUMAN_VIDEO_MAX_TRAILING_SILENCE_SECONDS = 1.2
DIGITAL_HUMAN_VIDEO_MIN_UPLOAD_MEAN_VOLUME_DB = -12.0
DIGITAL_HUMAN_VIDEO_UPLOAD_PEAK_CEILING_DB = -0.1
DIGITAL_HUMAN_VIDEO_VOLUME_TOLERANCE_DB = 0.1
DIGITAL_HUMAN_VIDEO_LOW_MOTION_MAX_FRAME_DELTA = 1.5
MINIMAX_CN_BASE_URL = "https://api.minimaxi.com"


@dataclass
class AudioSettings:
    emotion: str = "neutral"
    language: str = "Chinese"
    model_choice: str = "1.7B"
    speaker: str = "Ryan"
    app_id: str = create_audio.DEFAULT_APP_ID
    speed: float = 1.0
    volume_gain_db: float = 8.0
    tts_provider: str = "runninghub"
    minimax_api_key: str = ""
    minimax_base_url: str = MINIMAX_CN_BASE_URL
    minimax_model: str = "speech-2.8-hd"
    minimax_voice_id: str = "male-qn-qingse"
    minimax_format: str = "mp3"
    minimax_sample_rate: int = 32000
    minimax_bitrate: int = 128000
    minimax_channel: int = 1
    minimax_language_boost: str = "auto"
    reverb_enabled: bool = False
    reverb_in_gain: float = 0.95
    reverb_out_gain: float = 1.0
    reverb_delays_ms: str = "45|85"
    reverb_decays: str = "0.035|0.02"


def _minimax_base_url(settings: AudioSettings) -> str:
    value = str(getattr(settings, "minimax_base_url", "") or os.getenv("MINIMAX_BASE_URL", MINIMAX_CN_BASE_URL)).strip().rstrip("/")
    if not value:
        return MINIMAX_CN_BASE_URL
    # Web 端和服务端统一固定走 MiniMax 国内版主域名，避免旧的海外/北京备用地址继续流入。
    return MINIMAX_CN_BASE_URL


def _minimax_voice_clone_base_url(settings: AudioSettings) -> str:
    return _minimax_base_url(settings)


@dataclass
class NanoSettings:
    base_url: str = "http://202.90.21.53:3008"
    model: str = "gemini-3.1-flash-image-preview"
    gemini_api_key: str = ""
    gpt_api_key: str = ""
    prompt_template: str = "电商口播视频场景截图风格：真实人物在室内/直播间展示商品，手持商品或放在手掌上讲解；写实摄影、柔和补光、干净背景；9:16；画面不要文字/水印/海报排版。"


@dataclass
class VideoWorkflowSettings:
    app_id: str = create_video.DIGITAL_HUMAN_VIDEO_APP_ID
    app_ids: list[str] | None = None
    duration_mode: str = "manual"
    duration_seconds: int = 15
    frame_rate: int = create_video.CURRENT_VIDEO_FRAME_RATE
    camera_video_url: str | None = None
    instance_type: str = "default"
    use_personal_queue: bool = False
    max_resolution: int = create_video.CURRENT_VIDEO_MAX_RESOLUTION
    audio_upload_gain_db: float = 8.0


@dataclass
class BatchSettings:
    output_dir: str = "./outputs_commerce_video"
    match_mode: str = "cycle"
    fixed_index: int = 1
    auto_rename: bool = True
    upload_result_zip: bool = False
    resume: bool = False


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _safe_extract_zip(zip_path: Path, dest_dir: Path) -> None:
    _ensure_dir(dest_dir)
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise RuntimeError(f"不安全的 zip 路径: {member.filename}")
        zf.extractall(dest_dir)


def _audio_matched_video_target_seconds(video_seconds: float, speech_end_seconds: float) -> float | None:
    try:
        video_value = float(video_seconds or 0.0)
        speech_end_value = float(speech_end_seconds or 0.0)
    except Exception:
        return None
    if video_value <= 0 or speech_end_value <= 0:
        return None
    max_allowed = speech_end_value + DIGITAL_HUMAN_VIDEO_MAX_TRAILING_SILENCE_SECONDS
    if video_value <= max_allowed:
        return None
    return max_allowed


def _digital_human_video_target_seconds_from_uploaded_audio(video_seconds: float, uploaded_audio_seconds: float) -> float | None:
    try:
        video_value = float(video_seconds or 0.0)
        audio_value = float(uploaded_audio_seconds or 0.0)
    except Exception:
        return None
    if video_value <= 0 or audio_value <= 0:
        return None
    target_seconds = float(max(int(math.ceil(audio_value)), 1))
    if video_value <= target_seconds:
        return None
    return target_seconds


def _is_digits_stem(path: Path) -> bool:
    return bool(re.fullmatch(r"\d+", path.stem))


def _sorted_paths(paths: list[Path]) -> list[Path]:
    def key(p: Path):
        if _is_digits_stem(p):
            return (0, int(p.stem), p.name.lower())
        return (1, p.name.lower(), 0)

    return sorted(paths, key=key)


def _normalize_workflow_ids(values: list[str] | tuple[str, ...] | None, fallback: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in list(values or []):
        text = create_video.normalize_digital_human_video_app_id(raw)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    if out:
        return out
    fb = create_video.normalize_digital_human_video_app_id(fallback)
    return [fb] if fb else []


def _scan_files(root: Path, exts: set[str]) -> list[Path]:
    if not root.exists() or not root.is_dir():
        return []
    found: list[Path] = []
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in exts:
            found.append(path)
    return _sorted_paths(found)


def _copy_renamed(*, src_paths: list[Path], dest_dir: Path, kind: str, auto_rename: bool) -> tuple[list[Path], dict[str, str]]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    rename_map: dict[str, str] = {}
    all_numeric = all(_is_digits_stem(p) for p in src_paths)
    if all_numeric:
        return src_paths, rename_map
    if not auto_rename:
        raise RuntimeError(f"{kind} 文件名非数字命名，请开启 auto_rename 或自行重命名为 1..N")
    renamed: list[Path] = []
    for idx, src in enumerate(src_paths, start=1):
        dst = dest_dir / f"{idx}{src.suffix.lower()}"
        shutil.copy2(src, dst)
        rename_map[str(src)] = str(dst)
        renamed.append(dst)
    return renamed, rename_map


def _pick_from_list(items: list[Path], index0: int, match_mode: str, fixed_index: int) -> Path:
    if not items:
        raise RuntimeError("空列表无法配对")
    if len(items) == 1:
        return items[0]
    if match_mode == "cycle":
        return items[index0 % len(items)]
    if match_mode == "repeat_last":
        return items[index0] if index0 < len(items) else items[-1]
    if match_mode == "repeat_first":
        return items[index0] if index0 < len(items) else items[0]
    if match_mode == "fixed_index":
        idx = int(fixed_index) - 1
        if idx < 0 or idx >= len(items):
            raise RuntimeError(f"fixed_index 越界: {fixed_index}，可用范围 1..{len(items)}")
        return items[idx]
    raise RuntimeError(f"未知 match_mode: {match_mode}")


def _find_job_artifact(dir_path: Path, job_no: int, exts: set[str] | None = None) -> Path | None:
    if not dir_path.exists() or not dir_path.is_dir():
        return None
    prefix = f"{job_no}"
    for candidate in _sorted_paths([p for p in dir_path.iterdir() if p.is_file()]):
        if candidate.stem != prefix:
            continue
        if exts and candidate.suffix.lower() not in exts:
            continue
        return candidate
    return None


def _emit_job_progress(
    progress_callback: Callable[[dict[str, Any]], None] | None,
    *,
    job_no: int,
    total_jobs: int,
    job_progress: float,
    message: str,
    state: str = "running",
    extra: dict[str, Any] | None = None,
) -> None:
    if progress_callback is None:
        return
    bounded_total = max(int(total_jobs or 0), 1)
    bounded_job = min(max(float(job_progress), 0.0), 100.0)
    overall = ((max(int(job_no), 1) - 1) + (bounded_job / 100.0)) / bounded_total * 100.0
    body = {
        "job_index": int(job_no),
        "job_total": int(bounded_total),
        "job_progress": round(bounded_job, 1),
        "progress": round(overall, 1),
    }
    if isinstance(extra, dict):
        body.update(extra)
    try:
        progress_callback(
            {
                "status": str(message),
                "progress": round(overall, 1),
                "stage": "processing",
                "state": str(state),
                "data": body,
            }
        )
    except Exception:
        pass


def _sha1_file(path: Path, limit_bytes: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        remaining = int(limit_bytes)
        while remaining > 0:
            chunk = f.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


def upload_binary(*, api_key: str, file_path: Path, cache: dict[str, str], media_kind: str) -> str:
    stat = file_path.stat()
    cache_key = f"{file_path.resolve()}|{stat.st_size}|{int(stat.st_mtime)}|{_sha1_file(file_path)}"
    if cache_key in cache:
        return cache[cache_key]
    url = str(runninghub_common.BASE_URL).rstrip("/") + "/openapi/v2/media/upload/binary"
    headers = {"Authorization": f"Bearer {api_key}"}
    with file_path.open("rb") as f:
        resp = runninghub_common.rh_post(url, headers=headers, files={"file": f})
    payload = resp.json()
    if not isinstance(payload, dict) or int(payload.get("code", -1)) != 0:
        raise RuntimeError(f"上传失败: {runninghub_common._safe_json_preview(payload)}")
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise RuntimeError(f"上传返回缺少 data: {runninghub_common._safe_json_preview(payload)}")
    file_name = str(data.get("fileName") or "").strip()
    download_url = str(data.get("download_url") or "").strip()
    suffix = file_path.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"} and download_url:
        final_url = download_url if download_url.startswith("http") else str(runninghub_common.BASE_URL).rstrip("/") + "/" + download_url.lstrip("/")
        cache[cache_key] = final_url
        return final_url
    if suffix in {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm"}:
        if file_name:
            cache[cache_key] = file_name
            return file_name
    if not download_url and file_name:
        cache[cache_key] = file_name
        return file_name
    if not download_url:
        raise RuntimeError(f"上传返回缺少 download_url: {runninghub_common._safe_json_preview(payload)}")
    final_url = download_url if download_url.startswith("http") else str(runninghub_common.BASE_URL).rstrip("/") + "/" + download_url.lstrip("/")
    cache[cache_key] = final_url
    return final_url


def _render_node_info(template: list[dict[str, Any]], values: dict[str, Any]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for entry in template:
        if not isinstance(entry, dict):
            continue
        copied = dict(entry)
        fv = copied.get("fieldValue")
        if isinstance(fv, str):
            text = fv
            for k, v in values.items():
                text = text.replace("{{" + str(k) + "}}", str(v))
            copied["fieldValue"] = text
        rendered.append(copied)
    return rendered


def _submit_runninghub_task(*, api_key: str, app_id: str, node_info_list: list[dict[str, Any]], instance_type: str, use_personal_queue: bool) -> dict[str, Any]:
    api_base = runninghub_common._get_run_api_base(app_id, app_id)
    url = str(runninghub_common.BASE_URL).rstrip("/") + "/" + api_base
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    payload = {"nodeInfoList": node_info_list, "instanceType": instance_type, "usePersonalQueue": bool(use_personal_queue)}
    resp = runninghub_common.rh_post(url, headers=headers, data=json.dumps(payload))
    raw = resp.json()
    if isinstance(raw, dict) and "code" in raw and int(raw.get("code") or 0) != 0:
        return {"status": "failed", "message": f"RunningHub API 返回错误: {runninghub_common._safe_json_preview(raw)}", "raw": raw}
    return runninghub_common._normalize_submit_result(raw)


def _resolve_ffmpeg_exe() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise RuntimeError("缺少 ffmpeg，请先安装 ffmpeg。") from exc


def _resolve_ffprobe_exe() -> str | None:
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        return ffprobe
    try:
        ffmpeg_path = Path(_resolve_ffmpeg_exe())
    except Exception:
        return None
    candidates = [
        ffmpeg_path.with_name("ffprobe"),
        ffmpeg_path.with_name("ffprobe.exe"),
    ]
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _run_subprocess(args: list[str]) -> tuple[int, str, str]:
    cmd = list(args)
    if cmd and cmd[0] == "ffmpeg" and not shutil.which("ffmpeg"):
        cmd[0] = _resolve_ffmpeg_exe()
    elif cmd and cmd[0] == "ffprobe" and not shutil.which("ffprobe"):
        ffprobe = _resolve_ffprobe_exe()
        if ffprobe:
            cmd[0] = ffprobe
    completed = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return int(completed.returncode or 0), str(completed.stdout or ""), str(completed.stderr or "")


def _ensure_ffmpeg() -> None:
    _resolve_ffmpeg_exe()


def _ensure_ffprobe() -> None:
    if not _resolve_ffprobe_exe():
        raise RuntimeError("缺少 ffprobe，无法读取音频时长，请先安装 ffmpeg/ffprobe。")


def _parse_ffmpeg_duration_metadata(text: str) -> float:
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", str(text or ""))
    if not match:
        return 0.0
    hours = float(match.group(1) or 0)
    minutes = float(match.group(2) or 0)
    seconds = float(match.group(3) or 0)
    return max(hours * 3600.0 + minutes * 60.0 + seconds, 0.0)


def _probe_media_duration_seconds(media_path: Path) -> float:
    ffprobe = _resolve_ffprobe_exe()
    if ffprobe:
        code, out, err = _run_subprocess(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(media_path),
            ]
        )
        if code == 0:
            try:
                value = float(out.strip())
            except Exception:
                value = 0.0
            return max(float(value or 0.0), 0.0)
        parsed = _parse_ffmpeg_duration_metadata(f"{out}\n{err}")
        if parsed > 0:
            return parsed
        raise RuntimeError((err or out or "ffprobe failed").strip())

    ffmpeg = _resolve_ffmpeg_exe()
    code, out, err = _run_subprocess([ffmpeg, "-hide_banner", "-i", str(media_path)])
    parsed = _parse_ffmpeg_duration_metadata(f"{out}\n{err}")
    if parsed > 0:
        return parsed
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg duration probe failed").strip())
    return 0.0


def _probe_video_dimensions(video_path: Path) -> tuple[int, int]:
    ffprobe = _resolve_ffprobe_exe()
    if not ffprobe:
        return (0, 0)
    code, out, err = _run_subprocess(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            str(video_path),
        ]
    )
    if code != 0:
        raise RuntimeError((err or out or "ffprobe failed").strip())
    try:
        payload = json.loads(out or "{}")
        stream = (payload.get("streams") or [{}])[0]
        return (max(int(stream.get("width") or 0), 0), max(int(stream.get("height") or 0), 0))
    except Exception:
        return (0, 0)


def _even_dimension(value: float, *, minimum: int = 2) -> int:
    number = max(int(round(float(value or 0))), int(minimum or 2))
    if number % 2:
        number += 1
    return number


def _normalize_video_to_image_aspect(*, video_path: Path, image_path: Path, logger=None) -> dict[str, Any]:
    video_path = Path(video_path).expanduser().resolve()
    image_path = Path(image_path).expanduser().resolve()
    if not video_path.exists() or not image_path.exists():
        return {"changed": False, "reason": "missing_file"}
    try:
        with Image.open(image_path) as image:
            image_width, image_height = image.size
    except Exception as exc:
        return {"changed": False, "reason": f"image_probe_failed: {exc}"}
    video_width, video_height = _probe_video_dimensions(video_path)
    if image_width <= 0 or image_height <= 0 or video_width <= 0 or video_height <= 0:
        return {"changed": False, "reason": "invalid_dimensions"}
    image_ratio = float(image_width) / float(image_height)
    video_ratio = float(video_width) / float(video_height)
    if abs(image_ratio - video_ratio) <= 0.01:
        return {
            "changed": False,
            "reason": "already_matches",
            "image_size": [image_width, image_height],
            "video_size": [video_width, video_height],
        }

    target_width = video_width
    target_height = _even_dimension(target_width / image_ratio)
    if target_height <= 0:
        return {"changed": False, "reason": "invalid_target"}
    temp_path = video_path.with_name(f"{video_path.stem}_aspect_normalized_tmp{video_path.suffix or '.mp4'}")
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"scale={target_width}:{target_height}:flags=lanczos,setsar=1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(temp_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0 or not temp_path.exists() or temp_path.stat().st_size <= 0:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise RuntimeError((err or out or "ffmpeg aspect normalize failed").strip())
    shutil.move(str(temp_path), str(video_path))
    result = {
        "changed": True,
        "image_size": [image_width, image_height],
        "video_size_before": [video_width, video_height],
        "video_size_after": [target_width, target_height],
        "image_ratio": image_ratio,
        "video_ratio_before": video_ratio,
    }
    if logger:
        logger(f"[视频比例校正] {video_width}x{video_height} -> {target_width}x{target_height}，匹配输入图 {image_width}x{image_height}")
    return result


def _audio_end_time_seconds(media_path: Path) -> float:
    duration = float(_probe_media_duration_seconds(media_path) or 0.0)
    if duration <= 0:
        return 1.0
    return max(round(duration, 3), 1.0)


def _trim_audio_to_seconds(*, input_path: Path, output_path: Path, seconds: int) -> Path:
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sec = max(int(seconds or 0), 1)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-t",
        str(sec),
        "-i",
        str(input_path),
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    return output_path


def _split_audio_to_max_seconds(*, input_path: Path, output_dir: Path, max_seconds: float, stem: str) -> list[Path]:
    duration = float(_probe_media_duration_seconds(input_path) or 0.0)
    limit = max(float(max_seconds or 0.0), 1.0)
    if duration <= limit + 0.05:
        return [input_path]
    _ensure_ffmpeg()
    output_dir.mkdir(parents=True, exist_ok=True)
    part_count = max(int(math.ceil(duration / limit)), 1)
    part_seconds = duration / part_count
    parts: list[Path] = []
    for idx in range(part_count):
        start = part_seconds * idx
        length = part_seconds if idx < part_count - 1 else max(duration - start, 0.1)
        output_path = output_dir / f"{stem}_part{idx + 1:02d}.m4a"
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{length:.3f}",
            "-i",
            str(input_path),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            str(output_path),
        ]
        code, out, err = _run_subprocess(cmd)
        if code != 0:
            raise RuntimeError((err or out or "ffmpeg failed").strip())
        parts.append(output_path)
    return parts


def _audio_path_looks_volume_boosted(path: Path) -> bool:
    name = str(path.name or "").lower()
    return bool(re.search(r"(?:^|[_-])(?:volume|gain)\d", name))


def _prepare_digital_human_video_audio_segments(
    *,
    audio_path: Path,
    output_dir: Path,
    job_no: int,
    max_seconds: float,
    gain_db: float,
) -> list[dict[str, Any]]:
    already_boosted = _audio_path_looks_volume_boosted(audio_path)
    split_dir = output_dir / "audio" / f"{job_no}_video_segments"
    source_parts = _split_audio_to_max_seconds(
        input_path=audio_path,
        output_dir=split_dir,
        max_seconds=max_seconds,
        stem=f"{job_no}_video_audio",
    )
    prepared: list[dict[str, Any]] = []
    for idx, part_path in enumerate(source_parts, start=1):
        upload_path = part_path
        if not already_boosted:
            try:
                gain_value = float(gain_db)
            except Exception:
                gain_value = 0.0
            if abs(gain_value) >= 0.1:
                gain_label = str(round(gain_value, 2)).replace(".", "_").replace("-", "m")
                boosted_path = split_dir / f"{Path(part_path).stem}_upload_volume{gain_label}db.m4a"
                upload_path = _boost_audio_volume(input_path=part_path, output_path=boosted_path, gain_db=gain_value)
        normalized_path = split_dir / f"{Path(upload_path).stem}_upload_reflevel.m4a"
        upload_path, volume_match = _normalize_audio_to_minimum_reference_loudness(
            input_path=upload_path,
            output_path=normalized_path,
        )
        duration = _audio_end_time_seconds(upload_path)
        try:
            speech_end_seconds = _audio_effective_speech_end_seconds(upload_path, duration_seconds=duration)
        except Exception:
            speech_end_seconds = duration
        if duration > float(max_seconds or 0.0) + 0.25:
            raise RuntimeError(f"数字人口播单段音频仍超过 {int(max_seconds)} 秒: {duration:.2f} 秒")
        prepared.append(
            {
                "index": idx,
                "path": upload_path,
                "source_path": part_path,
                "duration_seconds": duration,
                "speech_end_seconds": min(max(float(speech_end_seconds or duration), 0.0), duration),
                "gain_db": 0.0 if already_boosted else float(gain_db or 0.0),
                "volume_match": volume_match,
            }
        )
    return prepared


def _concat_video_files(*, video_paths: list[Path], output_path: Path) -> None:
    existing = [Path(path) for path in video_paths if Path(path).exists()]
    if not existing:
        raise RuntimeError("没有可拼接的视频片段")
    if len(existing) == 1:
        if existing[0] != output_path:
            shutil.copy2(existing[0], output_path)
        return
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    list_path = output_path.with_name(f"{output_path.stem}_concat_list.txt")
    with list_path.open("w", encoding="utf-8") as f:
        for path in existing:
            escaped = str(path.resolve()).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
    copy_cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    code, out, err = _run_subprocess(copy_cmd)
    if code == 0 and output_path.exists() and output_path.stat().st_size > 0:
        return
    encode_cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    code, out, err = _run_subprocess(encode_cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg concat failed").strip())


def _trim_video_to_seconds(*, input_path: Path, output_path: Path, seconds: float) -> Path:
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sec = max(float(seconds or 0.0), 0.1)
    overshoot_tolerance = 0.05
    copy_cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-t",
        f"{sec:.3f}",
        "-c",
        "copy",
        str(output_path),
    ]
    code, out, err = _run_subprocess(copy_cmd)
    if code == 0 and output_path.exists() and output_path.stat().st_size > 0:
        try:
            copied_seconds = _probe_media_duration_seconds(output_path)
        except Exception:
            copied_seconds = 0.0
        if copied_seconds > 0 and copied_seconds <= sec + overshoot_tolerance:
            return output_path
    encode_cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-t",
        f"{sec:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    code, out, err = _run_subprocess(encode_cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    return output_path


def _concat_audio_video(*, video_path: Path, audio_path: Path, output_path: Path) -> None:
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())


def _atempo_filters(speed: float) -> str:
    try:
        remaining = float(speed)
    except Exception:
        remaining = 1.0
    if remaining <= 0:
        remaining = 1.0
    filters: list[str] = []
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.4f}")
    return ",".join(filters)


def _speed_audio(*, input_path: Path, output_path: Path, speed: float) -> Path:
    try:
        speed_value = float(speed)
    except Exception:
        speed_value = 1.0
    if abs(speed_value - 1.0) < 0.01:
        return input_path
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-filter:a",
        _atempo_filters(speed_value),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    return output_path


def _boost_audio_volume(*, input_path: Path, output_path: Path, gain_db: float) -> Path:
    try:
        gain_value = float(gain_db)
    except Exception:
        gain_value = 0.0
    if abs(gain_value) < 0.1:
        return input_path
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-filter:a",
        f"volume={gain_value:.2f}dB,alimiter=limit={_db_to_linear(DIGITAL_HUMAN_VIDEO_UPLOAD_PEAK_CEILING_DB):.6f}",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    return output_path


def _sanitize_aecho_series(value: Any, *, fallback: str, min_value: float, max_value: float) -> str:
    parts: list[str] = []
    for raw_part in str(value or "").split("|"):
        try:
            number = float(str(raw_part).strip())
        except Exception:
            continue
        if min_value <= number <= max_value:
            parts.append(f"{number:g}")
    return "|".join(parts) or fallback


def _apply_audio_reverb(*, input_path: Path, output_path: Path, settings: AudioSettings) -> Path:
    if not bool(getattr(settings, "reverb_enabled", False)):
        return input_path
    try:
        in_gain = float(getattr(settings, "reverb_in_gain", 0.95) or 0.95)
    except Exception:
        in_gain = 0.95
    try:
        out_gain = float(getattr(settings, "reverb_out_gain", 1.0) or 1.0)
    except Exception:
        out_gain = 1.0
    in_gain = max(0.0, min(in_gain, 1.0))
    out_gain = max(0.0, min(out_gain, 1.0))
    if out_gain <= 0.001:
        return input_path
    delays = _sanitize_aecho_series(getattr(settings, "reverb_delays_ms", ""), fallback="45|85", min_value=1.0, max_value=250.0)
    decays = _sanitize_aecho_series(getattr(settings, "reverb_decays", ""), fallback="0.035|0.02", min_value=0.001, max_value=0.35)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _ensure_ffmpeg()
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-filter:a",
        f"aecho={in_gain:.3f}:{out_gain:.3f}:{delays}:{decays},alimiter=limit={_db_to_linear(DIGITAL_HUMAN_VIDEO_UPLOAD_PEAK_CEILING_DB):.6f}",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    return output_path


def _strengthen_digital_human_motion_prompt(prompt_text: str) -> str:
    base = str(prompt_text or "").strip()
    motion_clause = (
        "口型必须与音频持续同步，人物要持续自然说话并带清晰眨眼、点头、肩部和上半身微动作，"
        "禁止静帧、禁止像照片一样不动。"
    )
    if not base:
        return motion_clause
    if motion_clause in base:
        return base
    return f"{base} {motion_clause}".strip()


def _extract_video_frame(*, video_path: Path, output_path: Path, at_seconds: float) -> Path:
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(float(at_seconds or 0.0), 0.0):.3f}",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg frame extract failed").strip())
    return output_path


def _frame_mean_delta(first_path: Path, second_path: Path) -> float:
    with Image.open(first_path) as first_image, Image.open(second_path) as second_image:
        first = ImageOps.exif_transpose(first_image).convert("L").resize((96, 96), Image.LANCZOS)
        second = ImageOps.exif_transpose(second_image).convert("L").resize((96, 96), Image.LANCZOS)
        diff = ImageChops.difference(first, second)
        stat = ImageStat.Stat(diff)
        return float(stat.mean[0] if stat.mean else 0.0)


def _detect_digital_human_low_motion_video(
    video_path: Path,
    *,
    sample_count: int = 4,
    max_frame_delta: float = DIGITAL_HUMAN_VIDEO_LOW_MOTION_MAX_FRAME_DELTA,
) -> dict[str, Any]:
    path = Path(video_path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        return {"low_motion": False, "reason": "missing_video"}
    try:
        duration = float(_probe_media_duration_seconds(path) or 0.0)
    except Exception as exc:
        return {"low_motion": False, "reason": "probe_failed", "error": str(exc)}
    if duration <= 0.6:
        return {"low_motion": False, "reason": "too_short", "duration_seconds": duration}
    usable_samples = max(int(sample_count or 0), 3)
    sample_times = [duration * ratio for ratio in [0.15, 0.38, 0.62, 0.85][:usable_samples]]
    frame_dir = path.parent / f"{path.stem}_motion_probe"
    frame_dir.mkdir(parents=True, exist_ok=True)
    frame_paths: list[Path] = []
    try:
        for idx, timestamp in enumerate(sample_times, start=1):
            frame_path = frame_dir / f"frame_{idx:02d}.jpg"
            _extract_video_frame(video_path=path, output_path=frame_path, at_seconds=timestamp)
            frame_paths.append(frame_path)
        deltas = [
            round(_frame_mean_delta(frame_paths[idx - 1], frame_paths[idx]), 3)
            for idx in range(1, len(frame_paths))
        ]
        max_delta = max(deltas) if deltas else 0.0
        return {
            "low_motion": bool(max_delta < float(max_frame_delta)),
            "reason": "frame_delta",
            "duration_seconds": duration,
            "sample_times": [round(item, 3) for item in sample_times],
            "frame_deltas": deltas,
            "max_frame_delta": round(max_delta, 3),
            "threshold": float(max_frame_delta),
        }
    except Exception as exc:
        return {"low_motion": False, "reason": "detect_failed", "error": str(exc)}
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)


def _probe_audio_volume_stats(audio_path: Path) -> dict[str, float | None]:
    try:
        _ensure_ffmpeg()
    except Exception:
        return {"mean_volume_db": None, "max_volume_db": None}
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(audio_path),
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ]
    code, out, err = _run_subprocess(cmd)
    text = f"{out}\n{err}"
    if code != 0 and not text.strip():
        return {"mean_volume_db": None, "max_volume_db": None}
    mean_match = re.search(r"mean_volume:\s*([-0-9.]+)\s*dB", text)
    max_match = re.search(r"max_volume:\s*([-0-9.]+)\s*dB", text)
    try:
        mean_value = float(mean_match.group(1)) if mean_match else None
    except Exception:
        mean_value = None
    try:
        max_value = float(max_match.group(1)) if max_match else None
    except Exception:
        max_value = None
    return {"mean_volume_db": mean_value, "max_volume_db": max_value}


def _db_to_linear(db: float) -> float:
    return math.pow(10.0, float(db) / 20.0)


def _normalize_audio_to_minimum_reference_loudness(
    *,
    input_path: Path,
    output_path: Path,
    minimum_mean_db: float = DIGITAL_HUMAN_VIDEO_MIN_UPLOAD_MEAN_VOLUME_DB,
    peak_ceiling_db: float = DIGITAL_HUMAN_VIDEO_UPLOAD_PEAK_CEILING_DB,
    tolerance_db: float = DIGITAL_HUMAN_VIDEO_VOLUME_TOLERANCE_DB,
) -> tuple[Path, dict[str, Any]]:
    before = _probe_audio_volume_stats(input_path)
    mean_db = before.get("mean_volume_db")
    if mean_db is None:
        return input_path, {"applied": False, "reason": "probe_unavailable", "before": before, "after": before}
    if float(mean_db) >= float(minimum_mean_db) - abs(float(tolerance_db or 0.0)):
        return input_path, {"applied": False, "reason": "already_loud_enough", "before": before, "after": before}
    gain_db = float(minimum_mean_db) - float(mean_db)
    peak_limit_linear = _db_to_linear(peak_ceiling_db)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-filter:a",
        f"volume={gain_db:.2f}dB,alimiter=limit={peak_limit_linear:.6f}",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    after = _probe_audio_volume_stats(output_path)
    return output_path, {
        "applied": True,
        "reason": "raised_to_reference_floor",
        "before": before,
        "after": after,
        "gain_db": round(gain_db, 2),
        "minimum_mean_db": float(minimum_mean_db),
        "peak_ceiling_db": float(peak_ceiling_db),
    }


def _leading_silence_seconds(
    audio_path: Path,
    *,
    noise_db: str = "-45dB",
    min_silence: float = 0.05,
    max_trim_seconds: float = 1.5,
) -> float:
    _ensure_ffmpeg()
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(audio_path),
        "-af",
        f"silencedetect=noise={noise_db}:d={min_silence}",
        "-f",
        "null",
        "-",
    ]
    code, out, err = _run_subprocess(cmd)
    text = f"{out}\n{err}"
    if code != 0 and not text.strip():
        return 0.0
    if "silence_start: 0" not in text:
        return 0.0
    match = re.search(r"silence_end:\s*([0-9.]+)", text)
    if not match:
        return 0.0
    try:
        value = float(match.group(1))
    except Exception:
        value = 0.0
    if value < 0.03:
        return 0.0
    if max_trim_seconds > 0:
        value = min(value, max_trim_seconds)
    return value


def _trim_audio_leading_silence(
    *,
    input_path: Path,
    output_path: Path,
    max_trim_seconds: float = 1.5,
    keep_head_seconds: float = 0.12,
) -> Path:
    offset = _leading_silence_seconds(input_path, max_trim_seconds=max_trim_seconds)
    if offset <= 0:
        return input_path
    try:
        source_duration = float(_probe_media_duration_seconds(input_path) or 0.0)
    except Exception:
        source_duration = 0.0
    if source_duration > 0.0:
        # Short lines are the most likely to lose their initial syllables, so cap
        # leading trim by both remaining playable duration and a conservative ratio.
        if source_duration <= 1.8:
            trim_ratio_cap = 0.18
        elif source_duration <= 3.0:
            trim_ratio_cap = 0.24
        else:
            trim_ratio_cap = 0.35
        safe_offset_cap = min(
            max_trim_seconds if max_trim_seconds > 0 else offset,
            max(source_duration - 0.42, 0.0),
            max(source_duration * trim_ratio_cap, 0.0),
        )
        if safe_offset_cap <= 0.03:
            return input_path
        offset = min(offset, safe_offset_cap)
    headroom = max(float(keep_head_seconds or 0.0), 0.0)
    if headroom > 0.0:
        offset = max(offset - headroom, 0.0)
    if offset <= 0.03:
        return input_path
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-ss",
        f"{offset:.3f}",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    try:
        trimmed_duration = float(_probe_media_duration_seconds(output_path) or 0.0)
    except Exception:
        trimmed_duration = 0.0
    if trimmed_duration <= 0.02:
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        return input_path
    return output_path


def _trailing_silence_trim_seconds(
    audio_path: Path,
    *,
    noise_db: str = "-42dB",
    min_silence: float = 0.18,
    keep_tail_seconds: float = 0.22,
) -> Optional[float]:
    duration = float(_probe_media_duration_seconds(audio_path) or 0.0)
    if duration <= 0:
        return None
    _ensure_ffmpeg()
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(audio_path),
        "-af",
        f"silencedetect=noise={noise_db}:d={max(float(min_silence or 0.0), 0.05):.3f}",
        "-f",
        "null",
        "-",
    ]
    code, out, err = _run_subprocess(cmd)
    text = f"{out}\n{err}"
    if code != 0 and not text.strip():
        return None

    current_start: Optional[float] = None
    last_closed_start: Optional[float] = None
    last_closed_end: Optional[float] = None
    for line in text.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            try:
                current_start = float(start_match.group(1))
            except Exception:
                current_start = None
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match:
            try:
                last_closed_end = float(end_match.group(1))
                last_closed_start = current_start
            except Exception:
                last_closed_end = None
                last_closed_start = None
            current_start = None

    tail_start: Optional[float] = None
    if current_start is not None and duration - current_start >= min_silence:
        tail_start = current_start
    elif (
        last_closed_start is not None
        and last_closed_end is not None
        and abs(duration - last_closed_end) <= 0.08
        and last_closed_end - last_closed_start >= min_silence
    ):
        tail_start = last_closed_start

    if tail_start is None:
        return None
    trim_at = min(duration, max(tail_start + max(float(keep_tail_seconds or 0.0), 0.0), 0.15))
    if duration - trim_at < 0.2:
        return None
    return trim_at


def _audio_effective_speech_end_seconds(audio_path: Path, *, duration_seconds: float | None = None) -> float:
    duration = float(duration_seconds or 0.0)
    if duration <= 0:
        duration = _audio_end_time_seconds(audio_path)
    # Only a true trailing silence marks the end of spoken copy. A short sound after
    # a pause can still be the final spoken word, so do not infer "tail noise" here.
    trim_at = _trailing_silence_trim_seconds(
        audio_path,
        noise_db="-35dB",
        min_silence=0.12,
        keep_tail_seconds=0.0,
    )
    if trim_at is None:
        return duration
    return min(max(float(trim_at or duration), 0.15), duration)


def _trim_audio_trailing_silence(*, input_path: Path, output_path: Path) -> Path:
    trim_at = _trailing_silence_trim_seconds(input_path)
    if trim_at is None:
        return input_path
    _ensure_ffmpeg()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-t",
        f"{trim_at:.3f}",
        "-i",
        str(input_path),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())
    return output_path


def _prepare_current_digital_human_workflow_audio(
    *,
    input_path: Path,
    output_dir: Path,
    job_no: int,
    logger=None,
) -> Path:
    current_path = input_path
    leading_trimmed_path = output_dir / "audio" / f"{job_no}_no_lead_silence.m4a"
    leading_result = _trim_audio_leading_silence(
        input_path=current_path,
        output_path=leading_trimmed_path,
    )
    if leading_result != current_path:
        current_path = leading_result
        if logger:
            logger(f"[音频预处理] 已裁剪开头静音: {current_path}")

    trailing_trimmed_path = output_dir / "audio" / f"{job_no}_no_tail_silence.m4a"
    trailing_result = _trim_audio_trailing_silence(
        input_path=current_path,
        output_path=trailing_trimmed_path,
    )
    if trailing_result != current_path:
        current_path = trailing_result
        if logger:
            logger(f"[音频预处理] 已裁剪结尾静音: {current_path}")
    return current_path


def _download_to_file(*, url: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    resp = runninghub_common.rh_get(url, stream=True)
    resp.raise_for_status()
    with output_path.open("wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)


def _postprocess_generated_audio(*, input_path: Path, output_path: Path, settings: AudioSettings, logger=None) -> Path:
    out_path = input_path
    audio_speed = float(getattr(settings, "speed", 1.0) or 1.0)
    if abs(audio_speed - 1.0) >= 0.01:
        sped_path = output_path.with_name(f"{output_path.stem}_speed{str(audio_speed).replace('.', '_')}.m4a")
        out_path = _speed_audio(input_path=out_path, output_path=sped_path, speed=audio_speed)
        if logger:
            logger(f"[TTS] 已按 {audio_speed:.2f}x 调整口播速度: {out_path}")
    trimmed_path = out_path.with_name(f"{out_path.stem}_trimmed.m4a")
    trimmed_result = _trim_audio_leading_silence(input_path=out_path, output_path=trimmed_path)
    if trimmed_result != out_path:
        out_path = trimmed_result
        if logger:
            logger(f"[TTS] 已裁掉开头静音以改善口型同步: {out_path}")
    volume_gain_db = float(getattr(settings, "volume_gain_db", 0.0) or 0.0)
    if abs(volume_gain_db) >= 0.1:
        boosted_path = out_path.with_name(f"{out_path.stem}_volume{str(volume_gain_db).replace('.', '_').replace('-', 'm')}db.m4a")
        out_path = _boost_audio_volume(input_path=out_path, output_path=boosted_path, gain_db=volume_gain_db)
        if logger:
            logger(f"[TTS] 已提升音频音量 {volume_gain_db:.1f}dB: {out_path}")
    if bool(getattr(settings, "reverb_enabled", False)):
        reverb_path = out_path.with_name(f"{out_path.stem}_room.m4a")
        out_path = _apply_audio_reverb(input_path=out_path, output_path=reverb_path, settings=settings)
        if logger:
            logger(f"[TTS] 已添加轻微空间混响: {out_path}")
    return out_path


def _generate_minimax_audio(
    *,
    speech_text: str,
    settings: AudioSettings,
    output_path: Path,
    logger=None,
) -> Path:
    api_key = str(getattr(settings, "minimax_api_key", "") or os.getenv("MINIMAX_API_KEY", "")).strip()
    if not api_key:
        raise RuntimeError("缺少 MiniMax API Key，无法生成数字人口播 TTS 音频")
    base_url = _minimax_base_url(settings)
    model = str(getattr(settings, "minimax_model", "") or os.getenv("MINIMAX_TTS_MODEL", "speech-2.8-hd")).strip() or "speech-2.8-hd"
    voice_id = str(getattr(settings, "minimax_voice_id", "") or os.getenv("MINIMAX_TTS_VOICE_ID", "male-qn-qingse")).strip() or "male-qn-qingse"
    audio_format = str(getattr(settings, "minimax_format", "") or os.getenv("MINIMAX_TTS_FORMAT", "mp3")).strip().lower() or "mp3"
    if audio_format not in {"mp3", "wav", "pcm", "flac"}:
        audio_format = "mp3"
    payload = {
        "model": model,
        "text": str(speech_text or ""),
        "stream": False,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": 1.0,
            "vol": 1.0,
            "pitch": 0,
            "emotion": str(getattr(settings, "emotion", "") or "neutral").strip() or "neutral",
        },
        "audio_setting": {
            "sample_rate": max(int(getattr(settings, "minimax_sample_rate", 32000) or 32000), 8000),
            "bitrate": max(int(getattr(settings, "minimax_bitrate", 128000) or 128000), 32000),
            "format": audio_format,
            "channel": max(int(getattr(settings, "minimax_channel", 1) or 1), 1),
        },
        "language_boost": str(getattr(settings, "minimax_language_boost", "") or "auto").strip() or "auto",
    }
    output_path = output_path.with_suffix("." + ("wav" if audio_format == "pcm" else audio_format))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.post(
        f"{base_url}/v1/t2a_v2",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=180,
    )
    try:
        data = resp.json()
    except Exception:
        data = {"raw": str(getattr(resp, "text", "") or "")[:800]}
    if resp.status_code >= 400:
        raise RuntimeError(f"MiniMax TTS 请求失败（HTTP {resp.status_code}）：{runninghub_common._safe_json_preview(data)}")
    base_resp = data.get("base_resp") if isinstance(data, dict) else None
    if isinstance(base_resp, dict) and int(base_resp.get("status_code") or 0) != 0:
        raise RuntimeError(f"MiniMax TTS 返回错误：{runninghub_common._safe_json_preview(base_resp)}")
    audio_hex = ""
    if isinstance(data, dict):
        data_obj = data.get("data")
        if isinstance(data_obj, dict):
            audio_hex = str(data_obj.get("audio") or "").strip()
    if not audio_hex:
        raise RuntimeError(f"MiniMax TTS 未返回 audio 字段：{runninghub_common._safe_json_preview(data)}")
    try:
        output_path.write_bytes(bytes.fromhex(audio_hex))
    except ValueError as exc:
        raise RuntimeError("MiniMax TTS 返回的 audio 不是有效十六进制音频") from exc
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RuntimeError("MiniMax TTS 音频写入失败")
    if logger:
        logger(f"[MiniMax TTS] 已生成音频: {output_path}")
    return _postprocess_generated_audio(input_path=output_path, output_path=output_path, settings=settings, logger=logger)


def _minimax_voice_clone_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".wav":
        return "audio/wav"
    if suffix == ".m4a":
        return "audio/mp4"
    return "audio/mpeg"


def _prepare_minimax_voice_clone_audio(reference_audio_path: Path, *, logger=None) -> Path:
    suffix = reference_audio_path.suffix.lower()
    target_seconds = 10.5
    duration_seconds = 0.0
    try:
        duration_seconds = float(_probe_media_duration_seconds(reference_audio_path) or 0.0)
    except Exception:
        duration_seconds = 0.0
    if suffix in {".mp3", ".m4a", ".wav"} and duration_seconds >= 10.0:
        return reference_audio_path
    converted_path = reference_audio_path.with_name(f"{reference_audio_path.stem}_minimax_clone.wav")
    ffmpeg = _resolve_ffmpeg_exe()
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if duration_seconds > 0 and duration_seconds < 10.0:
        loop_count = max(int(math.ceil(target_seconds / duration_seconds)), 1)
        cmd.extend(["-stream_loop", str(loop_count)])
    cmd.extend(
        [
            "-i",
            str(reference_audio_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
        ]
    )
    if duration_seconds > 0 and duration_seconds < 10.0:
        cmd.extend(["-t", f"{target_seconds:.1f}"])
    cmd.append(str(converted_path))
    code, out, err = _run_subprocess(cmd)
    if code != 0:
        raise RuntimeError(f"MiniMax 参考音频转码失败：{(err or out or 'ffmpeg failed').strip()[:800]}")
    if not converted_path.exists() or converted_path.stat().st_size <= 0:
        raise RuntimeError("MiniMax 参考音频转码失败：未生成有效音频文件")
    if logger:
        if duration_seconds > 0 and duration_seconds < 10.0:
            logger(f"[MiniMax TTS] 参考干音仅 {duration_seconds:.2f} 秒，已循环补齐到 {target_seconds:.1f} 秒用于 voice clone: {converted_path.name}")
        else:
            logger(f"[MiniMax TTS] 已将参考音频转为 voice clone 支持格式: {converted_path.name}")
    return converted_path


def _minimax_voice_clone_preview_text(language: str) -> str:
    lang = str(language or "").strip().lower()
    if lang.startswith("en") or "english" in lang:
        return "Welcome. This is a short voice clone preview for natural speech generation."
    if lang.startswith("ja") or "japanese" in lang:
        return "こんにちは。これは自然な音声生成のための短い音色復刻プレビューです。"
    if lang.startswith("es") or "spanish" in lang:
        return "Hola. Esta es una breve prueba de clonacion de voz para generar habla natural."
    if lang.startswith("th") or "thai" in lang:
        return "สวัสดี นี่คือตัวอย่างสั้นสำหรับการโคลนเสียงพูดให้เป็นธรรมชาติ"
    if lang.startswith("ms") or "malay" in lang:
        return "Hai. Ini ialah pratonton ringkas untuk klon suara yang lebih semula jadi."
    return "您好，这是用于自然语音生成的音色复刻试听。"


def clone_minimax_voice_from_reference(
    *,
    reference_audio_path: Path,
    settings: AudioSettings,
    logger=None,
) -> str:
    api_key = str(getattr(settings, "minimax_api_key", "") or os.getenv("MINIMAX_API_KEY", "")).strip()
    if not api_key:
        raise RuntimeError("缺少 MiniMax API Key，无法克隆参考音色")
    base_url = _minimax_voice_clone_base_url(settings)
    reference_audio_path = reference_audio_path.expanduser().resolve()
    if not reference_audio_path.exists() or not reference_audio_path.is_file():
        raise FileNotFoundError(f"参考音频文件不存在: {reference_audio_path}")
    upload_audio_path = _prepare_minimax_voice_clone_audio(reference_audio_path, logger=logger)
    voice_hash = hashlib.sha1(
        f"{reference_audio_path.name}:{reference_audio_path.stat().st_size}:{reference_audio_path.stat().st_mtime_ns}".encode("utf-8")
    ).hexdigest()[:24]
    voice_id = f"vecto_clone_{voice_hash}"
    mime = _minimax_voice_clone_mime(upload_audio_path)
    with upload_audio_path.open("rb") as fh:
        upload_resp = requests.post(
            f"{base_url}/v1/files/upload",
            headers={"Authorization": f"Bearer {api_key}"},
            data={"purpose": "voice_clone"},
            files={"file": (upload_audio_path.name, fh, mime)},
            timeout=180,
        )
    try:
        upload_data = upload_resp.json()
    except Exception:
        upload_data = {"raw": str(getattr(upload_resp, "text", "") or "")[:800]}
    if upload_resp.status_code >= 400:
        raise RuntimeError(f"MiniMax 干音上传失败（HTTP {upload_resp.status_code}）：{runninghub_common._safe_json_preview(upload_data)}")
    upload_base_resp = upload_data.get("base_resp") if isinstance(upload_data, dict) else None
    if isinstance(upload_base_resp, dict) and int(upload_base_resp.get("status_code") or 0) != 0:
        upload_status_code = int(upload_base_resp.get("status_code") or 0)
        upload_status_msg = str(upload_base_resp.get("status_msg") or "").lower()
        if upload_status_code == 2049 or "invalid api key" in upload_status_msg or "unauthorized" in upload_status_msg:
            raise RuntimeError("MiniMax 干音上传失败：当前 MiniMax API Key 无效或未授权，请检查后台配置")
        raise RuntimeError(f"MiniMax 干音上传返回错误：{runninghub_common._safe_json_preview(upload_base_resp)}")
    file_id: Any = None
    if isinstance(upload_data, dict):
        file_obj = upload_data.get("file")
        if isinstance(file_obj, dict):
            file_id = file_obj.get("file_id") or file_obj.get("id")
        file_id = file_id or upload_data.get("file_id") or upload_data.get("id")
    if file_id is None or str(file_id).strip() == "":
        raise RuntimeError(f"MiniMax 干音上传未返回 file_id：{runninghub_common._safe_json_preview(upload_data)}")
    if isinstance(file_id, str) and file_id.strip().isdigit():
        file_id = int(file_id.strip())
    clone_payload = {
        "file_id": file_id,
        "voice_id": voice_id,
        "text": _minimax_voice_clone_preview_text(str(getattr(settings, "language", "") or "")),
        "model": str(getattr(settings, "minimax_model", "") or os.getenv("MINIMAX_TTS_MODEL", "speech-2.8-hd")).strip() or "speech-2.8-hd",
    }
    clone_resp = requests.post(
        f"{base_url}/v1/voice_clone",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=clone_payload,
        timeout=180,
    )
    try:
        clone_data = clone_resp.json()
    except Exception:
        clone_data = {"raw": str(getattr(clone_resp, "text", "") or "")[:800]}
    if clone_resp.status_code >= 400:
        raise RuntimeError(f"MiniMax 音色克隆失败（HTTP {clone_resp.status_code}）：{runninghub_common._safe_json_preview(clone_data)}")
    clone_base_resp = clone_data.get("base_resp") if isinstance(clone_data, dict) else None
    if isinstance(clone_base_resp, dict) and int(clone_base_resp.get("status_code") or 0) != 0:
        clone_status_code = int(clone_base_resp.get("status_code") or 0)
        status_msg = str(clone_base_resp.get("status_msg") or "").lower()
        if clone_status_code == 2038 or ("voice clone" in status_msg and "forbidden" in status_msg):
            raise RuntimeError("MiniMax 音色复刻失败：当前账号/API Key 未开通音色复刻权限（Voice Clone），请在 MiniMax 控制台开通该权限，或更换已开通该权限的 API Key")
        if clone_status_code == 2037 or "duration too short" in status_msg:
            raise RuntimeError("MiniMax 音色复刻失败：参考干音少于 10 秒。系统会在新任务中自动补齐短干音，请重新提交任务")
        if "exist" not in status_msg and "already" not in status_msg and "duplicate" not in status_msg:
            raise RuntimeError(f"MiniMax 音色克隆返回错误：{runninghub_common._safe_json_preview(clone_base_resp)}")
    if logger:
        logger(f"[MiniMax TTS] 已克隆参考音色: {voice_id}")
    return voice_id


def _generate_audio(
    *,
    api_key: str,
    speech_text: str,
    settings: AudioSettings,
    output_path: Path,
    reference_audio_path: Path | None = None,
    poll_interval_seconds: float = 3.0,
    logger=None,
) -> Path:
    provider = str(getattr(settings, "tts_provider", "") or "").strip().lower()
    if provider == "minimax":
        if reference_audio_path is not None:
            voice_id = clone_minimax_voice_from_reference(
                reference_audio_path=reference_audio_path,
                settings=settings,
                logger=logger,
            )
            settings = replace(settings, minimax_voice_id=voice_id)
        return _generate_minimax_audio(
            speech_text=speech_text,
            settings=settings,
            output_path=output_path,
            logger=logger,
        )
    reference_audio_file = ""
    if reference_audio_path is not None:
        reference_audio_path = reference_audio_path.expanduser().resolve()
        if not reference_audio_path.exists():
            raise FileNotFoundError(f"参考音频文件不存在: {reference_audio_path}")
        reference_audio_file = upload_binary(
            api_key=api_key,
            file_path=reference_audio_path,
            cache={},
            media_kind="reference_audio",
        )
        logger(f"[音频克隆] 已上传参考音频: {reference_audio_file}")
    submit = create_audio.submit_audio_task(
        api_key=api_key,
        word=speech_text,
        emotion=settings.emotion,
        language=settings.language,
        model_choice=settings.model_choice,
        speaker=settings.speaker,
        app_id=str(getattr(settings, "app_id", "") or "").strip() or create_audio.DEFAULT_APP_ID,
        max_retries=int(os.getenv("RH_AUDIO_SUBMIT_RETRIES", "120") or 120),
        base_sleep_seconds=float(os.getenv("RH_AUDIO_SUBMIT_BASE_SLEEP", "2.0") or 2.0),
        reference_audio_file=reference_audio_file,
        logger=logger,
    )
    task_id = str(submit.get("task_id") or "").strip()
    if not task_id:
        raise RuntimeError(str(submit.get("message") or "音频任务创建失败，未返回 taskId"))
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    query_url = str(runninghub_common.BASE_URL).rstrip("/") + "/openapi/v2/query"
    while True:
        resp = runninghub_common.rh_post(query_url, headers=headers, data=json.dumps({"taskId": str(task_id)}))
        payload = resp.json()
        status = str((payload.get("status") if isinstance(payload, dict) else "") or "").strip().upper()
        if status == "SUCCESS":
            results = payload.get("results") if isinstance(payload, dict) else None
            if isinstance(results, list):
                for entry in results:
                    if not isinstance(entry, dict):
                        continue
                    u = str(entry.get("url") or "").strip().strip("`").strip().strip('"').strip("'").strip()
                    t = str(entry.get("outputType") or "").strip().lower()
                    if u:
                        out_path = output_path
                        if t:
                            out_path = output_path.with_suffix("." + t.lstrip("."))
                        _download_to_file(url=u, output_path=out_path)
                        if not out_path.exists():
                            raise RuntimeError("音频下载完成但文件不存在")
                        return _postprocess_generated_audio(input_path=out_path, output_path=output_path, settings=settings, logger=logger)
            raise RuntimeError(f"音频任务成功但未返回可下载结果: {runninghub_common._safe_json_preview(payload)}")
        if status == "FAILED":
            raise RuntimeError(f"音频任务失败: {runninghub_common._safe_json_preview(payload)}")
        time.sleep(max(float(poll_interval_seconds or 0.0), 0.5))


def _poll_video_task(
    *,
    task_id: str,
    api_key: str,
    output_path: Path,
    poll_interval_seconds: float = 3.0,
) -> dict[str, Any]:
    last_status = None
    while True:
        result = runninghub_common.query_task(task_id=task_id, api_key=api_key, video_output_path=str(output_path))
        status = str(result.get("status") or "").strip()
        if status != last_status:
            last_status = status
        if status in {"success", "failed"}:
            return result
        time.sleep(max(float(poll_interval_seconds or 0.0), 0.5))


def _compose_reference_image(*, model_image: Path, product_image: Path, output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(model_image) as im_model:
        with Image.open(product_image) as im_product:
            im_model = im_model.convert("RGB")
            im_product = im_product.convert("RGB")
            h = max(im_model.height, im_product.height, 1)
            w1 = int(im_model.width * (h / max(im_model.height, 1)))
            w2 = int(im_product.width * (h / max(im_product.height, 1)))
            im_model = im_model.resize((max(w1, 1), h))
            im_product = im_product.resize((max(w2, 1), h))
            canvas = Image.new("RGB", (im_model.width + im_product.width, h), (0, 0, 0))
            canvas.paste(im_model, (0, 0))
            canvas.paste(im_product, (im_model.width, 0))
            canvas.save(output_path)
    return output_path


def _resolve_input(*, kind: str, zip_path: str | None, dir_path: str | None, tmp_root: Path) -> Path:
    if bool(zip_path) == bool(dir_path):
        raise ValueError(f"{kind} 必须且只能提供 zip 或 dir 其中一个")
    if zip_path:
        src = Path(zip_path).expanduser().resolve()
        if not src.exists():
            raise FileNotFoundError(f"{kind} zip 不存在: {src}")
        dest = tmp_root / f"input_{kind}"
        if dest.exists():
            shutil.rmtree(dest)
        _safe_extract_zip(src, dest)
        return dest
    src = Path(dir_path).expanduser().resolve()
    if not src.exists() or not src.is_dir():
        raise FileNotFoundError(f"{kind} dir 不存在或不可用: {src}")
    return src


def generate_commerce_videos(
    *,
    runninghub_api_key: str,
    upload_api_key: str | None = None,
    product_dir: str | None = None,
    product_zip: str | None = None,
    model_dir: str | None = None,
    model_zip: str | None = None,
    output_dir: str = "./outputs_commerce_video",
    batch: BatchSettings | None = None,
    audio_settings: AudioSettings | None = None,
    nano_settings: NanoSettings | None = None,
    video_workflow: VideoWorkflowSettings | None = None,
    speech_text_provider: Callable[[int, Path, Path], str] | None = None,
    prompt_provider: Callable[[int, Path, Path], str] | None = None,
    audio_path_provider: Callable[[int, Path, Path], Path | str] | None = None,
    image_path_provider: Callable[[int, Path, Path], Path | str] | None = None,
    logger: Callable[[str], None] | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    force_regenerate_audio: bool = False,
) -> dict[str, Any]:
    api_key = str(runninghub_api_key or "").strip()
    if not api_key:
        raise ValueError("runninghub_api_key 不能为空")
    media_upload_api_key = str(upload_api_key or "").strip() or api_key
    logger = logger or (lambda msg: print(msg))
    batch = batch or BatchSettings(output_dir=output_dir)
    audio_settings = audio_settings or AudioSettings()
    nano_settings = nano_settings or NanoSettings()
    video_workflow = video_workflow or VideoWorkflowSettings()

    out_dir = Path(batch.output_dir or output_dir).expanduser().resolve()
    tmp_root = out_dir / "tmp"
    _ensure_dir(out_dir)
    _ensure_dir(tmp_root)
    _ensure_dir(out_dir / "audio")
    _ensure_dir(out_dir / "images")
    _ensure_dir(out_dir / "videos")

    product_root = _resolve_input(kind="product", zip_path=product_zip, dir_path=product_dir, tmp_root=tmp_root)
    model_root = _resolve_input(kind="model", zip_path=model_zip, dir_path=model_dir, tmp_root=tmp_root)

    product_paths = _scan_files(product_root, IMAGE_EXTS)
    model_paths = _scan_files(model_root, IMAGE_EXTS)
    if not product_paths:
        raise RuntimeError("未找到商品图片")
    if not model_paths:
        raise RuntimeError("未找到模特图片")

    product_paths2, product_rename = _copy_renamed(src_paths=product_paths, dest_dir=tmp_root / "products", kind="商品图片", auto_rename=batch.auto_rename)
    model_paths2, model_rename = _copy_renamed(src_paths=model_paths, dest_dir=tmp_root / "models", kind="模特图片", auto_rename=batch.auto_rename)
    with (out_dir / "rename_map.json").open("w", encoding="utf-8") as f:
        json.dump({"products": product_rename, "models": model_rename}, f, ensure_ascii=False, indent=2)

    jobs = max(len(product_paths2), len(model_paths2))
    upload_cache: dict[str, str] = {}
    runninghub_task_ids: list[str] = []
    success_files: list[Path] = []
    logs_path = out_dir / "logs.jsonl"

    for idx0 in range(jobs):
        job_no = idx0 + 1
        product_image = _pick_from_list(product_paths2, idx0, batch.match_mode, batch.fixed_index)
        model_image = _pick_from_list(model_paths2, idx0, batch.match_mode, batch.fixed_index)
        out_video = out_dir / "videos" / f"{job_no}.mp4"

        record: dict[str, Any] = {
            "job": job_no,
            "product_image": str(product_image),
            "model_image": str(model_image),
            "started_at": int(time.time()),
        }
        current_stage = "初始化阶段"
        try:
            _emit_job_progress(
                progress_callback,
                job_no=job_no,
                total_jobs=jobs,
                job_progress=0,
                message=f"开始处理第 {job_no}/{jobs} 条",
                extra={"step": "start"},
            )
            if batch.resume and out_video.exists():
                record["status"] = "success"
                record["video"] = str(out_video)
                record["resumed"] = True
                record["resume_stage"] = "video_exists"
                success_files.append(out_video)
                logger(f"[续跑跳过] job={job_no} 已存在视频={out_video}")
                _emit_job_progress(
                    progress_callback,
                    job_no=job_no,
                    total_jobs=jobs,
                    job_progress=100,
                    message=f"第 {job_no}/{jobs} 条已复用现成视频",
                    state="success",
                    extra={"step": "resume_video", "video_path": str(out_video), "resumed": True},
                )
                continue

            audio_path: Path | None = None
            reference_audio_path: Path | None = None
            if audio_path_provider is not None:
                audio_value = audio_path_provider(job_no, model_image, product_image)
                audio_text = str(audio_value or "").strip()
                if audio_text:
                    reference_audio_path = Path(audio_text).expanduser().resolve()
                    if not reference_audio_path.exists():
                        raise FileNotFoundError(f"参考音频文件不存在: {reference_audio_path}")
            if speech_text_provider is None:
                raise RuntimeError("speech_text_provider 不能为空（需要提供人物说话文案，或接入豆包AI生成）。")
            speech_text = str(speech_text_provider(job_no, model_image, product_image) or "").strip()
            if not speech_text:
                raise RuntimeError("speech_text 为空")

            prompt_text = ""
            if prompt_provider is not None:
                prompt_text = str(prompt_provider(job_no, model_image, product_image) or "").strip()
            if not prompt_text:
                raise RuntimeError("prompt_provider 未提供或返回空字符串（需要视频提示词，或接入豆包AI生成）。")

            if audio_path is None:
                if batch.resume and not force_regenerate_audio:
                    resumed_audio = _find_job_artifact(
                        out_dir / "audio",
                        job_no,
                        {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".bin"},
                    )
                    if resumed_audio is not None and resumed_audio.exists():
                        audio_path = resumed_audio
                        record["resume_audio_path"] = str(resumed_audio)
                        logger(f"[续跑复用] job={job_no} audio={resumed_audio}")
                        _emit_job_progress(
                            progress_callback,
                            job_no=job_no,
                            total_jobs=jobs,
                            job_progress=25,
                            message=f"第 {job_no}/{jobs} 条已复用音频",
                            extra={"step": "audio_ready", "audio_path": str(resumed_audio), "resumed": True},
                        )
                if audio_path is None:
                    current_stage = "音频生成阶段"
                    audio_path = _generate_audio(
                        api_key=api_key,
                        speech_text=speech_text,
                        settings=audio_settings,
                        output_path=Path(out_dir / "audio" / f"{job_no}.mp3"),
                        reference_audio_path=reference_audio_path,
                        logger=logger,
                    )
                    record["audio_regenerated"] = True
                    _emit_job_progress(
                        progress_callback,
                        job_no=job_no,
                        total_jobs=jobs,
                        job_progress=25,
                        message=f"第 {job_no}/{jobs} 条音频生成完成",
                        extra={"step": "audio_ready", "audio_path": str(audio_path)},
                    )
                else:
                    record["audio_regenerated"] = False
            current_stage = "参考图合成阶段"
            ref_path = _compose_reference_image(model_image=model_image, product_image=product_image, output_path=out_dir / "images" / f"{job_no}_ref.png")
            generated_img_path = out_dir / "images" / f"{job_no}.png"
            image_path = generated_img_path
            image_override = None
            if image_path_provider is not None:
                image_value = image_path_provider(job_no, model_image, product_image)
                image_text = str(image_value or "").strip()
                if image_text:
                    image_override = Path(image_text).resolve()
                    if not image_override.exists():
                        raise FileNotFoundError(f"指定场景图不存在: {image_override}")
            nano_prompt = str(nano_settings.prompt_template or "").strip()
            if not nano_prompt and image_override is None:
                raise RuntimeError("nano prompt 不能为空")
            if image_override is not None:
                image_path = image_override
                record["provided_image_path"] = str(image_override)
                logger(f"[外部场景图] job={job_no} image={image_override}")
                _emit_job_progress(
                    progress_callback,
                    job_no=job_no,
                    total_jobs=jobs,
                    job_progress=50,
                    message=f"第 {job_no}/{jobs} 条已复用场景图",
                    extra={"step": "image_ready", "image_path": str(image_override), "provided": True},
                )
            elif batch.resume and generated_img_path.exists():
                record["resume_image_path"] = str(generated_img_path)
                logger(f"[续跑复用] job={job_no} image={generated_img_path}")
                _emit_job_progress(
                    progress_callback,
                    job_no=job_no,
                    total_jobs=jobs,
                    job_progress=50,
                    message=f"第 {job_no}/{jobs} 条已复用场景图",
                    extra={"step": "image_ready", "image_path": str(generated_img_path), "resumed": True},
                )
            else:
                nano_result = image_model_api.generate_image(
                    base_url=str(nano_settings.base_url or "").strip(),
                    model=str(nano_settings.model or "").strip(),
                    prompt=nano_prompt,
                    output_image_path=str(generated_img_path),
                    gemini_api_key=str(nano_settings.gemini_api_key or "").strip(),
                    gpt_api_key=str(nano_settings.gpt_api_key or "").strip(),
                    input_image_path=str(ref_path),
                    logger=logger,
                )
                image_path_value = ""
                if isinstance(nano_result, dict):
                    image_path_value = str(nano_result.get("image_path") or nano_result.get("imagePath") or "").strip()
                elif isinstance(nano_result, str):
                    image_path_value = nano_result.strip()
                image_path = Path(image_path_value or str(generated_img_path)).resolve()
                _emit_job_progress(
                    progress_callback,
                    job_no=job_no,
                    total_jobs=jobs,
                    job_progress=50,
                    message=f"第 {job_no}/{jobs} 条场景图生成完成",
                    extra={"step": "image_ready", "image_path": str(image_path)},
                )
            if not image_path.exists():
                raise RuntimeError("闭源图片模型生成成功但未找到输出文件")

            current_stage = "主图上传阶段"
            try:
                image_url = upload_binary(api_key=media_upload_api_key, file_path=image_path, cache=upload_cache, media_kind="image")
            except Exception as exc:
                raise RuntimeError(f"主图上传失败: {exc}") from exc
            video_chain_ids = _normalize_workflow_ids(
                getattr(video_workflow, "app_ids", None),
                str(getattr(video_workflow, "app_id", "") or "").strip() or create_video.DEFAULT_APP_ID,
            )
            last_video_app_id = str(video_chain_ids[-1]) if video_chain_ids else ""
            is_current_digital_human_video = last_video_app_id == create_video.DIGITAL_HUMAN_VIDEO_APP_ID
            duration_mode = str(getattr(video_workflow, "duration_mode", "manual") or "manual").strip() or "manual"
            duration_mode = duration_mode.lower()
            duration_seconds = max(int(getattr(video_workflow, "duration_seconds", 15) or 15), 1)
            audio_for_upload = audio_path
            if duration_mode == "audio":
                if video_chain_ids and str(video_chain_ids[-1]) in create_video.AUDIO_DURATION_ZERO_WORKFLOW_IDS:
                    duration_seconds = 0
                elif (
                    video_chain_ids
                    and create_video.get_video_workflow_capabilities(video_chain_ids[-1]).get("node_mapping")
                    == "ltx23_duration"
                ):
                    current_stage = "音频预处理阶段"
                    audio_for_upload = _prepare_current_digital_human_workflow_audio(
                        input_path=audio_path,
                        output_dir=out_dir,
                        job_no=job_no,
                        logger=logger,
                    )
                    duration_seconds = _audio_end_time_seconds(audio_for_upload)
                elif (
                    video_chain_ids
                    and create_video.get_video_workflow_capabilities(video_chain_ids[-1]).get("node_mapping")
                    == "infinitetalk_audio_window"
                ):
                    duration_seconds = _audio_end_time_seconds(audio_path)
                else:
                    audio_dur = _probe_media_duration_seconds(audio_path)
                    base = float(audio_dur or 0.0)
                    padded = base + 1.5
                    if padded <= 30.0:
                        base = padded
                    duration_seconds = max(int(round(base)), 1)
                    if duration_seconds > 30:
                        duration_seconds = 30
                        audio_for_upload = _trim_audio_to_seconds(
                            input_path=audio_path,
                            output_path=Path(out_dir / "audio" / f"{job_no}_trim30.m4a"),
                            seconds=30,
                        )
            elif duration_mode != "manual":
                raise RuntimeError(f"未知 duration_mode: {duration_mode}（可选 manual/audio）")

            if is_current_digital_human_video and duration_mode == "audio":
                current_stage = "音频预处理阶段"
                audio_segments = _prepare_digital_human_video_audio_segments(
                    audio_path=audio_for_upload,
                    output_dir=out_dir,
                    job_no=job_no,
                    max_seconds=DIGITAL_HUMAN_VIDEO_MAX_AUDIO_SEGMENT_SECONDS,
                    gain_db=float(getattr(video_workflow, "audio_upload_gain_db", 8.0) or 0.0),
                )
                duration_seconds = float(sum(float(item.get("duration_seconds") or 0.0) for item in audio_segments))
            else:
                try:
                    speech_end_seconds = (
                        _audio_effective_speech_end_seconds(audio_for_upload, duration_seconds=float(duration_seconds or 0.0))
                        if duration_mode == "audio"
                        else duration_seconds
                    )
                except Exception:
                    speech_end_seconds = duration_seconds
                audio_segments = [
                    {
                        "index": 1,
                        "path": audio_for_upload,
                        "source_path": audio_for_upload,
                        "duration_seconds": duration_seconds,
                        "speech_end_seconds": min(max(float(speech_end_seconds or duration_seconds), 0.0), float(duration_seconds or 0.0)),
                        "gain_db": 0.0,
                    }
                ]

            current_camera_video_url = str(getattr(video_workflow, "camera_video_url", "") or "").strip() or None
            record["uploaded"] = {"image_url": image_url, "audio_urls": []}
            record["video_chain"] = {"app_ids": list(video_chain_ids), "steps": [], "audio_segments": []}
            record["video_aspect_normalization"] = []
            record["video_settings"] = {
                "duration_mode": duration_mode,
                "duration_seconds": duration_seconds,
                "frame_rate": max(int(getattr(video_workflow, "frame_rate", create_video.CURRENT_VIDEO_FRAME_RATE) or create_video.CURRENT_VIDEO_FRAME_RATE), 1),
                "max_resolution": getattr(video_workflow, "max_resolution", create_video.CURRENT_VIDEO_MAX_RESOLUTION),
                "audio_upload_gain_db": getattr(video_workflow, "audio_upload_gain_db", 8.0),
                "max_audio_segment_seconds": DIGITAL_HUMAN_VIDEO_MAX_AUDIO_SEGMENT_SECONDS if is_current_digital_human_video else None,
                "workflow_capabilities": [
                    create_video.get_video_workflow_capabilities(video_app_id)
                    for video_app_id in video_chain_ids
                ],
            }
            done = {}
            segment_video_paths: list[Path] = []
            for audio_segment_index, audio_segment in enumerate(audio_segments, start=1):
                audio_segment_path = Path(audio_segment["path"])
                current_stage = "音频上传阶段"
                try:
                    audio_url = upload_binary(
                        api_key=media_upload_api_key,
                        file_path=audio_segment_path,
                        cache=upload_cache,
                        media_kind="audio" if len(audio_segments) == 1 else f"audio_job_{job_no}_part_{audio_segment_index}",
                    )
                except Exception as exc:
                    raise RuntimeError(f"音频上传失败: {exc}") from exc
                record["uploaded"]["audio_urls"].append(audio_url)
                record["video_chain"]["audio_segments"].append(
                    {
                        "index": audio_segment_index,
                        "path": str(audio_segment_path),
                        "source_path": str(audio_segment.get("source_path") or ""),
                        "duration_seconds": audio_segment.get("duration_seconds"),
                        "gain_db": audio_segment.get("gain_db"),
                        "volume_match": audio_segment.get("volume_match"),
                        "audio_url": audio_url,
                    }
                )
                _emit_job_progress(
                    progress_callback,
                    job_no=job_no,
                    total_jobs=jobs,
                    job_progress=75,
                    message=f"第 {job_no}/{jobs} 条素材上传完成",
                    extra={"step": "uploaded", "image_url": image_url, "audio_url": audio_url, "audio_segment": audio_segment_index},
                )
                part_out_video = (
                    out_video
                    if len(audio_segments) == 1
                    else out_dir / "videos" / f"{job_no}_audio_part{audio_segment_index:02d}.mp4"
                )
                segment_duration_seconds = max(float(audio_segment.get("duration_seconds") or duration_seconds or 1), 1.0)
                active_prompt_text = prompt_text
                low_motion_meta: dict[str, Any] | None = None
                for attempt_index in range(2):
                    segment_camera_video_url = current_camera_video_url
                    for step_index, video_app_id in enumerate(video_chain_ids, start=1):
                        step_capabilities = create_video.get_video_workflow_capabilities(video_app_id)
                        effective_prompt_text = (
                            active_prompt_text if step_capabilities.get("supports_prompt") else ""
                        )
                        effective_camera_video_url = (
                            segment_camera_video_url if step_capabilities.get("supports_camera_video") else None
                        )
                        effective_max_resolution = (
                            getattr(video_workflow, "max_resolution", create_video.CURRENT_VIDEO_MAX_RESOLUTION)
                            if step_capabilities.get("supports_max_resolution")
                            else None
                        )
                        current_stage = "视频生成阶段"
                        step_out = (
                            part_out_video
                            if step_index == len(video_chain_ids)
                            else out_dir / "videos" / f"{job_no}_part{audio_segment_index:02d}_step{step_index:02d}.mp4"
                        )
                        step_logger = (
                            lambda message,
                            prefix=f"[视频段 {audio_segment_index}/{len(audio_segments)} · 尝试 {attempt_index + 1}/2 · 视频链 {step_index}/{len(video_chain_ids)}] ": logger(f"{prefix}{message}")
                        )
                        done = create_video.requests_api(
                            image_url=image_url,
                            audio_url=audio_url,
                            duration_seconds=segment_duration_seconds,
                            prompt_text=effective_prompt_text,
                            video_output_path=str(step_out),
                            api_key=api_key,
                            app_id=str(video_app_id or "").strip() or create_video.DEFAULT_APP_ID,
                            instance_type=str(video_workflow.instance_type or "default").strip() or "default",
                            use_personal_queue=bool(video_workflow.use_personal_queue),
                            camera_video_url=effective_camera_video_url,
                            max_resolution=effective_max_resolution,
                            logger=step_logger,
                        )
                        step_task_id = str(done.get("task_id") or done.get("task id") or "").strip()
                        if step_task_id:
                            runninghub_task_ids.append(step_task_id)
                        record["video_chain"]["steps"].append(
                            {
                                "audio_segment": audio_segment_index,
                                "attempt": attempt_index + 1,
                                "step": step_index,
                                "app_id": str(video_app_id),
                                "capabilities": step_capabilities,
                                "camera_video_url": effective_camera_video_url,
                                "requested_camera_video_url": segment_camera_video_url,
                                "duration_seconds": segment_duration_seconds,
                                "prompt_text": effective_prompt_text,
                                "requested_prompt_text": active_prompt_text,
                                "output_path": str(step_out),
                                "done": done,
                            }
                        )
                        if str(done.get("status")) != "success":
                            raise RuntimeError(f"视频生成失败: {str(done.get('message') or '')}")
                        if step_index < len(video_chain_ids):
                            if not step_out.exists():
                                raise RuntimeError("视频链中间步骤成功但未找到输出视频")
                            current_stage = "中间视频上传阶段"
                            try:
                                segment_camera_video_url = upload_binary(
                                    api_key=media_upload_api_key,
                                    file_path=step_out,
                                    cache=upload_cache,
                                    media_kind=f"video_chain_job_{job_no}_part_{audio_segment_index}_step_{step_index}",
                                )
                            except Exception as exc:
                                raise RuntimeError(f"中间视频上传失败: {exc}") from exc
                    if not is_current_digital_human_video:
                        break
                    current_stage = "低动画复检阶段"
                    low_motion_meta = _detect_digital_human_low_motion_video(part_out_video)
                    if not low_motion_meta.get("low_motion"):
                        break
                    if not all(
                        create_video.get_video_workflow_capabilities(video_app_id).get("supports_low_motion_prompt_retry")
                        for video_app_id in video_chain_ids
                    ):
                        low_motion_meta["retry_skipped"] = True
                        low_motion_meta["retry_skip_reason"] = "workflow_does_not_support_prompt"
                        logger(
                            f"[低运动复检] job={job_no} part={audio_segment_index} "
                            "当前视频 workflow 不支持 prompt 动作控制，跳过无效重试"
                        )
                        break
                    if attempt_index >= 1:
                        break
                    strengthened_prompt = _strengthen_digital_human_motion_prompt(active_prompt_text)
                    if strengthened_prompt == active_prompt_text:
                        break
                    active_prompt_text = strengthened_prompt
                    logger(
                        f"[低运动重试] job={job_no} part={audio_segment_index} "
                        f"max_delta={low_motion_meta.get('max_frame_delta')} threshold={low_motion_meta.get('threshold')}"
                    )
                    _emit_job_progress(
                        progress_callback,
                        job_no=job_no,
                        total_jobs=jobs,
                        job_progress=88,
                        message=f"第 {job_no}/{jobs} 条检测到低运动，正在重试增强动作版视频",
                        extra={
                            "step": "low_motion_retry",
                            "audio_segment": audio_segment_index,
                            "max_frame_delta": low_motion_meta.get("max_frame_delta"),
                            "threshold": low_motion_meta.get("threshold"),
                        },
                    )
                if low_motion_meta:
                    record.setdefault("low_motion_checks", []).append(
                        {
                            "audio_segment": audio_segment_index,
                            **low_motion_meta,
                        }
                    )
                if is_current_digital_human_video:
                    aspect_info = _normalize_video_to_image_aspect(
                        video_path=part_out_video,
                        image_path=image_path,
                        logger=logger,
                    )
                    aspect_info["audio_segment"] = audio_segment_index
                    aspect_info["path"] = str(part_out_video)
                    record["video_aspect_normalization"].append(aspect_info)
                segment_video_paths.append(part_out_video)

            if len(segment_video_paths) > 1:
                current_stage = "片段合并阶段"
                _concat_video_files(video_paths=segment_video_paths, output_path=out_video)

            record["done"] = done
            if not out_video.exists():
                raise RuntimeError("视频生成返回 success 但未下载到本地")
            try:
                video_seconds = _probe_media_duration_seconds(out_video)
            except Exception:
                video_seconds = 0.0
            try:
                uploaded_audio_seconds = sum(float(item.get("duration_seconds") or 0.0) for item in audio_segments)
            except Exception:
                uploaded_audio_seconds = 0.0
            try:
                uploaded_speech_end_seconds = sum(
                    float(item.get("speech_end_seconds") or item.get("duration_seconds") or 0.0)
                    for item in audio_segments
                )
            except Exception:
                uploaded_speech_end_seconds = uploaded_audio_seconds
            record["media_duration"] = {
                "requested_seconds": duration_seconds,
                "uploaded_audio_seconds": uploaded_audio_seconds,
                "uploaded_speech_end_seconds": uploaded_speech_end_seconds,
                "video_seconds_before_trim": video_seconds,
            }
            if duration_mode == "audio" and is_current_digital_human_video:
                target_seconds = _digital_human_video_target_seconds_from_uploaded_audio(video_seconds, uploaded_audio_seconds)
            elif duration_mode == "audio":
                target_seconds = _audio_matched_video_target_seconds(video_seconds, uploaded_speech_end_seconds)
            else:
                target_seconds = None
            if target_seconds is not None:
                current_stage = "视频收尾阶段"
                trimmed_video = out_video.with_name(f"{out_video.stem}_audio_matched{out_video.suffix or '.mp4'}")
                _trim_video_to_seconds(input_path=out_video, output_path=trimmed_video, seconds=target_seconds)
                shutil.move(str(trimmed_video), str(out_video))
                try:
                    video_seconds = _probe_media_duration_seconds(out_video)
                except Exception:
                    video_seconds = target_seconds
                record["media_duration"]["video_seconds_after_trim"] = video_seconds
                record["media_duration"]["trim_reason"] = (
                    "match_uploaded_audio_end"
                    if is_current_digital_human_video
                    else "match_speech_end"
                )
                record["media_duration"]["max_trailing_silence_seconds"] = DIGITAL_HUMAN_VIDEO_MAX_TRAILING_SILENCE_SECONDS

            record["status"] = "success"
            record["video"] = str(out_video)
            success_files.append(out_video)
            logger(f"[完成] job={job_no} video={out_video}")
            _emit_job_progress(
                progress_callback,
                job_no=job_no,
                total_jobs=jobs,
                job_progress=100,
                message=f"第 {job_no}/{jobs} 条视频生成完成",
                state="success",
                extra={"step": "video_ready", "video_path": str(out_video)},
            )
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = str(exc)
            record["failed_stage"] = current_stage
            logger(f"[失败] job={job_no} error={exc}")
            _emit_job_progress(
                progress_callback,
                job_no=job_no,
                total_jobs=jobs,
                job_progress=100,
                message=f"第 {job_no}/{jobs} 条处理失败",
                state="failed",
                extra={"step": "failed", "error": str(exc)},
            )
        finally:
            record["finished_at"] = int(time.time())
            with logs_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    result_zip = out_dir / "result.zip"
    with zipfile.ZipFile(result_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in success_files:
            if p.exists():
                zf.write(p, arcname=p.name)

    result_url = ""
    if batch.upload_result_zip and result_zip.exists():
        try:
            result_url = upload_binary(api_key=media_upload_api_key, file_path=result_zip, cache=upload_cache, media_kind="result_zip")
        except Exception:
            result_url = ""
    return {
        "output_dir": str(out_dir),
        "success": len(success_files),
        "total": jobs,
        "result_zip": str(result_zip),
        "result_url": result_url,
        "runninghub_task_ids": list(dict.fromkeys([str(x).strip() for x in runninghub_task_ids if str(x).strip()])),
    }


def run_from_config(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ValueError("config 必须是 dict")

    runninghub_api_key = str(config.get("runninghub_api_key") or "").strip()
    if not runninghub_api_key:
        runninghub_api_key = str(os.getenv("RUNNINGHUB_API_KEY", "") or "").strip()
    if not runninghub_api_key:
        raise ValueError("缺少 runninghub_api_key 或 RUNNINGHUB_API_KEY")

    product_dir = str(config.get("product_dir") or "").strip() or None
    product_zip = str(config.get("product_zip") or "").strip() or None
    model_dir = str(config.get("model_dir") or "").strip() or None
    model_zip = str(config.get("model_zip") or "").strip() or None

    output_dir = str(config.get("output_dir") or "./outputs_commerce_video").strip() or "./outputs_commerce_video"
    batch_cfg = config.get("batch") if isinstance(config.get("batch"), dict) else {}
    audio_cfg = config.get("audio") if isinstance(config.get("audio"), dict) else {}
    nano_cfg = config.get("nano") if isinstance(config.get("nano"), dict) else {}
    video_cfg = config.get("video_workflow") if isinstance(config.get("video_workflow"), dict) else {}

    def build_provider(value: object) -> Callable[[int, Path, Path], str]:
        if isinstance(value, str):
            text = str(value).strip()
            return lambda _i, _m, _p: text
        if isinstance(value, list):
            items = [str(x or "").strip() for x in value]
            return lambda i, _m, _p: (items[i - 1] if 0 < i <= len(items) and items[i - 1] else "")
        if isinstance(value, dict):
            mapping = {str(k).strip(): str(v or "").strip() for k, v in value.items()}
            return lambda i, _m, _p: mapping.get(str(i), "")
        return lambda _i, _m, _p: ""

    speech_provider = build_provider(config.get("speech_texts"))
    prompt_provider = build_provider(config.get("prompts"))
    if not speech_provider(1, Path("."), Path(".")).strip():
        raise ValueError("缺少 speech_texts（可为 str/list/dict）")
    if not prompt_provider(1, Path("."), Path(".")).strip():
        raise ValueError("缺少 prompts（可为 str/list/dict）")

    image_base_url = str(nano_cfg.get("base_url") or "http://202.90.21.53:3008").strip() or "http://202.90.21.53:3008"
    image_model = str(nano_cfg.get("model") or "gemini-3.1-flash-image-preview").strip() or "gemini-3.1-flash-image-preview"
    image_gemini_api_key = str(nano_cfg.get("gemini_api_key") or "").strip()
    image_gpt_api_key = str(nano_cfg.get("gpt_api_key") or "").strip()
    if not image_gemini_api_key and not image_gpt_api_key:
        raise ValueError("缺少 nano.gemini_api_key 或 nano.gpt_api_key")

    return generate_commerce_videos(
        runninghub_api_key=runninghub_api_key,
        product_dir=product_dir,
        product_zip=product_zip,
        model_dir=model_dir,
        model_zip=model_zip,
        output_dir=output_dir,
        batch=BatchSettings(
            output_dir=str(batch_cfg.get("output_dir") or output_dir),
            match_mode=str(batch_cfg.get("match_mode") or "cycle").strip() or "cycle",
            fixed_index=int(batch_cfg.get("fixed_index") or 1),
            auto_rename=bool(batch_cfg.get("auto_rename", True)),
            upload_result_zip=bool(batch_cfg.get("upload_result_zip", False)),
        ),
        audio_settings=AudioSettings(
            emotion=str(audio_cfg.get("emotion") or "neutral").strip() or "neutral",
            language=str(audio_cfg.get("language") or "Chinese").strip() or "Chinese",
            model_choice=str(audio_cfg.get("model_choice") or "1.7B").strip() or "1.7B",
            speaker=str(audio_cfg.get("speaker") or "Ryan").strip() or "Ryan",
            speed=float(audio_cfg.get("speed") or 1.0),
        ),
        nano_settings=NanoSettings(
            base_url=image_base_url,
            model=image_model,
            gemini_api_key=image_gemini_api_key,
            gpt_api_key=image_gpt_api_key,
            prompt_template=str(nano_cfg.get("prompt_template") or "生成一张电商带货宣传图：模特正在介绍商品，画面真实自然，光照与风格协调。").strip()
            or "生成一张电商带货宣传图：模特正在介绍商品，画面真实自然，光照与风格协调。",
        ),
        video_workflow=VideoWorkflowSettings(
            app_id=str(video_cfg.get("app_id") or "1968024407312596994").strip() or "1968024407312596994",
            app_ids=[str(x or "").strip() for x in (video_cfg.get("app_ids") or []) if str(x or "").strip()] if isinstance(video_cfg.get("app_ids"), list) else None,
            duration_mode=str(video_cfg.get("duration_mode") or "manual").strip() or "manual",
            duration_seconds=max(int(video_cfg.get("duration_seconds") or 15), 1),
            camera_video_url=str(video_cfg.get("camera_video_url") or "").strip() or None,
            instance_type=str(video_cfg.get("instance_type") or "default").strip() or "default",
            use_personal_queue=bool(video_cfg.get("use_personal_queue", False)),
            audio_upload_gain_db=float(video_cfg.get("audio_upload_gain_db") or 8.0),
        ),
        speech_text_provider=speech_provider,
        prompt_provider=prompt_provider,
    )


def run_example() -> dict[str, Any]:
    config: dict[str, Any] = {
        "runninghub_api_key": os.getenv("RUNNINGHUB_API_KEY", ""),
        "product_dir": "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/people",
        "model_dir": "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/product",
        "output_dir": "./outputs_commerce_video",
        "speech_texts": "大家好，今天给大家介绍这款产品，它是真皮材质的，由法国著名工匠，卡特玲娜花费了1个月雕作的，它的设计师也不简单，是英国的设计师世家，詹姆斯英德伯爵的后代，詹姆斯扎克伯格设计",
        "prompts": "运镜缓慢推进，突出商品细节，口播与画面同步。",
        "audio": {"emotion": "neutral", "language": "Chinese", "model_choice": "1.7B", "speaker": "Ryan"},
        "nano": {
            "base_url": "http://202.90.21.53:3008",
            "model": "gemini-3.1-flash-image-preview",
            "gemini_api_key": "",
            "gpt_api_key": "",
            "prompt_template": "生成一张电商带货宣传图：模特正在介绍商品，画面真实自然，光照与风格协调。画面干净",
        },
        "video_workflow": {
            "app_id": "1968024407312596994",
            "duration_mode": "manual",
            "duration_seconds": 15,
            "camera_video_url": None,
            "instance_type": "default",
            "use_personal_queue": False,
        },
        "batch": {"match_mode": "cycle", "fixed_index": 1, "auto_rename": True, "upload_result_zip": False},
    }
    return run_from_config(config)


if __name__ == "__main__":
    try:
        result = run_example()
    except Exception as exc:
        print(str(exc))
        print("请在 run_example() 的 config 中填写：product_dir/model_dir（目录或 zip），以及必要的密钥。")
        raise SystemExit(2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
