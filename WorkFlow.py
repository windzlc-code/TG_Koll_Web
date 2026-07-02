from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Callable

import Video_Clip_Extraction
import get_gemini
import replace_model
from asset_uploader import upload_file


def _default_logger(message: str) -> None:
    print(message)


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _now_ts() -> float:
    return time.time()


def _format_duration(seconds: float) -> str:
    value = max(float(seconds or 0.0), 0.0)
    if value >= 60:
        return f"{value / 60:.1f}min"
    return f"{value:.1f}s"


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w\-.]+", "_", str(name).strip(), flags=re.UNICODE)
    return cleaned or "item"


def _mask_secret(value: str) -> str:
    text = str(value or "")
    if len(text) <= 8:
        return "***"
    return f"{text[:4]}***{text[-4:]}"


def _read_text_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _safe_json_preview(value: Any, limit: int = 900) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    text = text.replace("\n", " ").replace("\r", " ")
    return text[: max(int(limit), 80)]


def _parse_timestamp_candidates(raw_text: Any) -> list[str]:
    text = str(raw_text or "")
    candidates: list[str] = []
    pattern = r"(\d{2}\.\d{2}\.\d{2})"
    for match in re.finditer(pattern, text):
        candidates.append(match.group(1))
    deduped: list[str] = []
    for item in candidates:
        if item not in deduped:
            deduped.append(item)
    return deduped


def _pick_timestamp(candidates: list[str], fallback: str) -> tuple[str, bool]:
    if not candidates:
        return fallback, True
    value = str(candidates[0]).strip()
    if not re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", value):
        return fallback, True
    return value, False


def _timestamp_to_seconds(value: str) -> float | None:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", text):
        return None
    mm, ss, hh = text.split(".")
    try:
        minutes = int(mm)
        seconds = int(ss)
        hundredths = int(hh)
    except Exception:
        return None
    return float(minutes * 60 + seconds) + float(hundredths) / 100.0


def _seconds_to_timestamp(seconds: float) -> str:
    value = max(float(seconds or 0.0), 0.0)
    total_hundredths = int(round(value * 100.0))
    minutes = total_hundredths // (60 * 100)
    remaining = total_hundredths % (60 * 100)
    sec = remaining // 100
    hundredths = remaining % 100
    return f"{minutes:02d}.{sec:02d}.{hundredths:02d}"


def _build_candidate_timestamps(primary: str, candidates: list[str]) -> list[str]:
    deduped: list[str] = []
    for item in candidates:
        t = str(item).strip()
        if re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", t) and t not in deduped:
            deduped.append(t)
    if primary and primary not in deduped and re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", str(primary)):
        deduped.insert(0, str(primary))

    base_seconds = _timestamp_to_seconds(primary) if primary else None
    if base_seconds is None and deduped:
        base_seconds = _timestamp_to_seconds(deduped[0])

    if base_seconds is None:
        return deduped

    offsets = [0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.0, -2.0]
    for delta in offsets:
        cand = _seconds_to_timestamp(base_seconds + delta)
        if cand not in deduped:
            deduped.append(cand)
    return deduped


def _upload_asset(
    *,
    local_path: str,
    remote_path: str,
    server_ip: str | None,
    server_port: int | None,
) -> tuple[str, dict[str, Any] | None]:
    if not server_ip or server_port is None:
        return "", None
    result = upload_file(
        server_ip=server_ip,
        server_port=int(server_port),
        local_path=local_path,
        remote_path=remote_path,
    )
    if isinstance(result, dict) and str(result.get("statu", "")).lower() == "success":
        path = str(result.get("path", "")).strip()
        if path:
            path = path.strip().strip("`").strip().strip('"').strip("'").strip()
        return path, result
    return "", result if isinstance(result, dict) else None


def _probe_video_meta(video_path: str) -> tuple[int, int, int]:
    try:
        import cv2
    except ModuleNotFoundError as exc:
        raise RuntimeError("缺少 opencv-python（cv2），请先安装依赖后再运行。") from exc

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    cap.release()
    frame_rate = max(int(round(float(fps) or 0.0)), 1)
    width = max(width, 1)
    height = max(height, 1)
    return width, height, frame_rate


def _probe_video_duration_seconds(video_path: str) -> float:
    try:
        import cv2
    except ModuleNotFoundError as exc:
        raise RuntimeError("缺少 opencv-python（cv2），请先安装依赖后再运行。") from exc

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
    cap.release()
    fps_value = float(fps) if fps else 0.0
    if fps_value <= 0.0:
        return 0.0
    duration = float(frame_count) / fps_value if frame_count else 0.0
    return max(duration, 0.0)


def _ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("缺少 ffmpeg，无法进行视频分段/拼接，请先安装 ffmpeg。")


def _run_ffmpeg(args: list[str]) -> None:
    _ensure_ffmpeg()
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if int(completed.returncode or 0) != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "ffmpeg failed").strip())


def _split_video_segments(
    *,
    input_path: str,
    target_duration_seconds: int,
    out_dir: str,
    basename: str,
    max_segment_seconds: int = 30,
) -> list[dict[str, Any]]:
    target = max(int(target_duration_seconds or 0), 1)
    max_seg = max(int(max_segment_seconds or 0), 1)
    _ensure_dir(out_dir)
    segments: list[dict[str, Any]] = []
    start = 0
    part = 1
    while start < target:
        dur = min(max_seg, target - start)
        seg_path = os.path.join(out_dir, f"{_sanitize_filename(basename)}_seg{part:03d}.mp4")
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            str(start),
            "-t",
            str(dur),
            "-i",
            str(input_path),
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(seg_path),
        ]
        try:
            _run_ffmpeg(cmd)
        except Exception:
            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                str(start),
                "-t",
                str(dur),
                "-i",
                str(input_path),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
                str(seg_path),
            ]
            _run_ffmpeg(cmd)
        segments.append({"path": os.path.abspath(seg_path), "start": int(start), "duration": int(dur)})
        start += dur
        part += 1
    return segments


def _concat_video_segments(*, segment_paths: list[str], output_path: str) -> None:
    if not segment_paths:
        raise RuntimeError("没有可拼接的片段")
    out_dir = os.path.dirname(output_path)
    _ensure_dir(out_dir)
    filelist_path = os.path.join(out_dir, f"concat_{int(time.time())}.txt")
    with open(filelist_path, "w", encoding="utf-8") as f:
        for p in segment_paths:
            f.write(f"file '{os.path.abspath(p)}'\n")
    cmd = [
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
        filelist_path,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output_path,
    ]
    try:
        _run_ffmpeg(cmd)
    except Exception:
        cmd = [
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
            filelist_path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            output_path,
        ]
        _run_ffmpeg(cmd)


@dataclass
class StepResult:
    name: str
    status: str
    started_at: str
    finished_at: str
    duration: str
    inputs: dict[str, Any] = field(default_factory=dict)
    outputs: dict[str, Any] = field(default_factory=dict)
    prompt: str = ""
    error: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class VideoItem:
    video_id: str
    source_url: str = ""
    local_video_path: str = ""
    timestamp: str = ""
    timestamp_fallback: bool = False
    frame_image_path: str = ""
    generated_image_path: str = ""
    uploaded_video_url: str = ""
    uploaded_image_url: str = ""
    final_versions: list[dict[str, Any]] = field(default_factory=list)
    steps: list[StepResult] = field(default_factory=list)


@dataclass
class ProjectManifest:
    run_id: str
    created_at: str
    project_dir: str
    config: dict[str, Any]
    items: list[VideoItem]
    logs: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class WorkflowSettings:
    username: str
    output_root: str = "./outputs_tiktok_replace"
    download_dir: str | None = None
    frames_dir: str | None = None
    images_dir: str | None = None
    finals_dir: str | None = None
    max_videos: int = 30
    enable_tiktok_download: bool = True
    video_folder: str | None = None
    image_folder: str | None = None
    skip_generate_image: bool = False
    image_match_mode: str = "cycle"
    fixed_image_index: int = 1
    gemini_host: str = "202.90.21.53"
    gemini_port: int | None = 3008
    gemini_api_key: str = ""
    nano_host: str = "202.90.21.53"
    nano_port: int | None = 3008
    nano_api_key: str = ""
    runninghub_api_key: str = ""
    runninghub_replace_app_id: str = "1977634608437174274"
    output_fps: int = 30
    output_width: int = 576
    output_height: int = 1024
    output_duration_seconds: int = 10
    use_custom_duration: bool = False
    nano_prompt: str = "生成相似但非同一人的新人物，保持原图的姿势、服装、场景与光照。"
    upload_server_ip: str | None = None
    upload_server_port: int | None = None
    replace_prompt: str = "保持原视频的动作、镜头、节奏、场景与光照一致，仅替换人物为上传图片中的人物。"
    regenerate_prompt_append: str = ""


def run_tiktok_face_replace_project(
    settings: WorkflowSettings,
    *,
    logger: Callable[[str], None] | None = None,
    emit: Callable[[str, dict[str, Any]], None] | None = None,
    stop_requested: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    logger = logger or _default_logger

    def _emit(event: str, payload: dict[str, Any]) -> None:
        if emit is not None:
            emit(event, payload)
        if stop_requested is not None and stop_requested():
            raise RuntimeError("用户已停止任务")

    enable_tiktok_download = bool(getattr(settings, "enable_tiktok_download", True))
    username = str(getattr(settings, "username", "") or "").strip().lstrip("@")
    if enable_tiktok_download and not username:
        raise ValueError("启用 TikTok 下载时，username 不能为空")
    video_folder = str(getattr(settings, "video_folder", "") or "").strip() or ""
    image_folder = str(getattr(settings, "image_folder", "") or "").strip() or ""
    skip_generate_image = bool(getattr(settings, "skip_generate_image", False)) or bool(image_folder)
    image_match_mode = str(getattr(settings, "image_match_mode", "cycle") or "cycle").strip() or "cycle"
    try:
        fixed_image_index = int(getattr(settings, "fixed_image_index", 1) or 1)
    except Exception:
        fixed_image_index = 1
    fixed_image_index = max(fixed_image_index, 1)

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    project_dir = os.path.abspath(os.path.join(settings.output_root, f"project_{run_id}"))
    download_dir = os.path.abspath(settings.download_dir or os.path.join(project_dir, "videos"))
    frames_dir = os.path.abspath(settings.frames_dir or os.path.join(project_dir, "frames"))
    images_dir = os.path.abspath(settings.images_dir or os.path.join(project_dir, "images"))
    finals_dir = os.path.abspath(settings.finals_dir or os.path.join(project_dir, "finals"))
    _ensure_dir(project_dir)
    _ensure_dir(download_dir)
    _ensure_dir(frames_dir)
    _ensure_dir(images_dir)
    _ensure_dir(finals_dir)

    project_logs: list[dict[str, Any]] = []
    items: list[VideoItem] = []

    def log_step(message: str, **extra: Any) -> None:
        if emit is None:
            logger(message)
        record = {"time": datetime.now().isoformat(timespec="seconds"), "message": message, **extra}
        project_logs.append(record)
        _emit("log", record)

    def emit_progress(
        *,
        percent: float,
        phase: str,
        video_id: str = "",
        detail: str = "",
    ) -> None:
        payload: dict[str, Any] = {
            "percent": max(min(float(percent), 100.0), 0.0),
            "phase": phase,
        }
        if video_id:
            payload["video_id"] = video_id
        if detail:
            payload["detail"] = detail
        _emit("progress", payload)

    log_step("[启动] 项目目录", project_dir=project_dir)
    log_step(
        "[配置] 输入来源",
        enable_tiktok_download=enable_tiktok_download,
        username=f"@{username}" if username else "",
        video_folder=video_folder,
        image_folder=image_folder,
        skip_generate_image=skip_generate_image,
        image_match_mode=image_match_mode,
        fixed_image_index=fixed_image_index,
    )
    log_step("[配置] Gemini", host=settings.gemini_host, port=settings.gemini_port, api_key=_mask_secret(settings.gemini_api_key))
    log_step("[配置] 图片生成", mode="ComfyUI/外部场景图")
    log_step("[配置] RunningHub", api_key=_mask_secret(settings.runninghub_api_key), app_id=str(getattr(settings, "runninghub_replace_app_id", "") or ""))
    log_step(
        "[配置] 输出参数",
        fps=int(getattr(settings, "output_fps", 30) or 30),
        width=int(getattr(settings, "output_width", 576) or 576),
        height=int(getattr(settings, "output_height", 1024) or 1024),
        duration_seconds=int(getattr(settings, "output_duration_seconds", 10) or 10),
    )

    prompt_gemini_path = os.path.join(os.path.dirname(__file__), "system_prompt", "gemini_system_prompt.md")
    prompt_review_path = os.path.join(os.path.dirname(__file__), "system_prompt", "gemini_frame_review_prompt.md")
    gemini_system_prompt = _read_text_file(prompt_gemini_path)
    frame_review_prompt = _read_text_file(prompt_review_path)

    download_started = _now_ts()
    video_paths: list[str] = []
    if enable_tiktok_download:
        log_step("[阶段1] 下载 TikTok 视频")
        emit_progress(percent=1.0, phase="download_start")
        try:
            from Titalk_GOT import simple_video_downloader
        except Exception as exc:
            raise RuntimeError("缺少 TikTok 下载依赖（Titalk_GOT/yt_dlp），请先安装 requirements.txt 再运行。") from exc

        download_result = simple_video_downloader.download_tiktok_videos(
            username=username,
            output_dir=download_dir,
            max_videos=int(settings.max_videos or 30),
        )
        if not isinstance(download_result, dict) or not download_result.get("success"):
            raise RuntimeError(f"下载失败: {download_result}")

        video_paths = [str(p) for p in (download_result.get("video_files") or []) if str(p)]
        if not video_paths:
            raise RuntimeError(f"下载结果未包含可用视频文件: {download_result}")
    else:
        if not video_folder or not os.path.isdir(video_folder):
            raise RuntimeError("关闭 TikTok 下载时，必须提供可用的视频文件夹路径")
        log_step("[阶段1] 读取本地视频", video_folder=video_folder)
        exts = {".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".webm"}
        found: list[str] = []
        for root, _dirs, files in os.walk(video_folder):
            for name in sorted(files):
                ext = os.path.splitext(name)[1].lower()
                if ext not in exts:
                    continue
                path = os.path.join(root, name)
                if os.path.exists(path):
                    found.append(os.path.abspath(path))
        found.sort()
        if not found:
            raise RuntimeError("本地视频文件夹中未找到视频文件")
        video_paths = found
    download_finished = _now_ts()

    video_ids = [os.path.splitext(os.path.basename(p))[0] or f"video_{i:03d}" for i, p in enumerate(video_paths, start=1)]
    _emit("project_init", {"total_videos": len(video_paths), "video_ids": video_ids, "project_dir": project_dir})

    log_step(
        f"[阶段1完成] 下载完成: {len(video_paths)} 个视频，用时 {_format_duration(download_finished - download_started)}",
        download="enabled" if enable_tiktok_download else "disabled",
    )
    _emit("download_done", {"count": len(video_paths), "paths": video_paths})
    emit_progress(percent=5.0, phase="download_done")

    image_paths: list[str] = []
    if image_folder and os.path.isdir(image_folder):
        image_exts = {".png", ".jpg", ".jpeg", ".webp"}
        found_images: list[str] = []
        for root, _dirs, files in os.walk(image_folder):
            for name in sorted(files):
                ext = os.path.splitext(name)[1].lower()
                if ext not in image_exts:
                    continue
                path = os.path.join(root, name)
                if os.path.exists(path):
                    found_images.append(os.path.abspath(path))
        found_images.sort()
        image_paths = found_images
        log_step("[阶段0] 本地图片加载完成", count=len(image_paths), image_folder=image_folder)
        if skip_generate_image and not image_paths:
            raise RuntimeError("已指定图片文件夹但未找到任何图片文件")
    if skip_generate_image and not image_paths:
        raise RuntimeError("已启用跳过抽帧与生图，但未提供可用的图片文件夹")

    def select_image_for_video(index0: int) -> str:
        if not image_paths:
            return ""
        if image_match_mode == "fixed":
            idx = fixed_image_index - 1
            if idx < 0 or idx >= len(image_paths):
                raise RuntimeError(f"固定图片序号越界: {fixed_image_index}，可用范围 1..{len(image_paths)}")
            return image_paths[idx]
        return image_paths[index0 % len(image_paths)]

    per_video_units = 5
    if skip_generate_image:
        per_video_units = 2
    total_units = 1 + len(video_paths) * per_video_units
    completed_units = 1

    for index, video_path in enumerate(video_paths, start=1):
        if stop_requested is not None and stop_requested():
            raise RuntimeError("用户已停止任务")
        video_id = os.path.splitext(os.path.basename(video_path))[0] or f"video_{index:03d}"
        item = VideoItem(video_id=video_id, local_video_path=os.path.abspath(video_path))
        items.append(item)

        log_step(f"[视频] {index}/{len(video_paths)} 开始处理: {video_id}", video_path=item.local_video_path)
        _emit("video_item", {"video_id": video_id, "status": "processing"})
        emit_progress(
            percent=5.0 + (completed_units / total_units) * 95.0,
            phase="video_start",
            video_id=video_id,
            detail=f"{index}/{len(video_paths)}",
        )

        use_local_image = bool(skip_generate_image and image_paths)
        if use_local_image:
            step_started = _now_ts()
            chosen_image = select_image_for_video(index - 1)
            item.generated_image_path = os.path.abspath(chosen_image)
            step_finished = _now_ts()
            item.steps.append(
                StepResult(
                    name="use_local_image",
                    status="success",
                    started_at=datetime.fromtimestamp(step_started).isoformat(timespec="seconds"),
                    finished_at=datetime.fromtimestamp(step_finished).isoformat(timespec="seconds"),
                    duration=_format_duration(step_finished - step_started),
                    inputs={"image_path": item.generated_image_path, "match_mode": image_match_mode, "fixed_image_index": fixed_image_index},
                    outputs={"selected_image_path": item.generated_image_path},
                )
            )
            log_step(f"[阶段4] 使用本地图片: {item.generated_image_path}", video_id=video_id)
            _emit("image", {"video_id": video_id, "path": item.generated_image_path})
        else:
            try:
                step_started = _now_ts()
                log_step(
                    "[任务] Gemini 分析关键帧时间戳",
                    video_id=video_id,
                    model="gemini-3-pro-preview",
                    host=settings.gemini_host,
                    port=settings.gemini_port,
                    system_prompt_file="system_prompt/gemini_system_prompt.md",
                )
                raw_analysis = get_gemini.request_gemini3_pro(
                    user_input="请按 system prompt 要求输出关键帧时间戳。",
                    host=settings.gemini_host,
                    api_key=settings.gemini_api_key,
                    parameters="",
                    video_paths=[item.local_video_path],
                    port=settings.gemini_port,
                    system_prompt=gemini_system_prompt,
                    retry_count=3,
                    retry_wait_seconds=2.0,
                    disable_proxy=True,
                )
                candidates = []
                if isinstance(raw_analysis, dict):
                    candidates = raw_analysis.get("timestamps") or raw_analysis.get("timestamp") or []
                    if isinstance(candidates, str):
                        candidates = [candidates]
                    if not isinstance(candidates, list):
                        candidates = []
                    if not candidates:
                        candidates = _parse_timestamp_candidates(raw_analysis.get("raw_text") or raw_analysis.get("text") or "")
                else:
                    candidates = _parse_timestamp_candidates(raw_analysis)

                timestamp, fallback_used = _pick_timestamp([str(x) for x in candidates if str(x).strip()], "00.01.00")
                candidate_timestamps = _build_candidate_timestamps(timestamp, [str(x) for x in candidates if str(x).strip()])
                step_finished = _now_ts()
                item.steps.append(
                    StepResult(
                        name="gemini_analyze",
                        status="fallback" if fallback_used else "success",
                        started_at=datetime.fromtimestamp(step_started).isoformat(timespec="seconds"),
                        finished_at=datetime.fromtimestamp(step_finished).isoformat(timespec="seconds"),
                        duration=_format_duration(step_finished - step_started),
                        inputs={"video_path": item.local_video_path},
                        outputs={"timestamp": timestamp, "candidates": candidates, "candidate_timestamps": candidate_timestamps, "raw": raw_analysis},
                        prompt="system_prompt=system_prompt/gemini_system_prompt.md",
                    )
                )
                log_step(
                    f"[阶段2] Gemini 时间戳: {timestamp} (fallback={fallback_used})",
                    video_id=video_id,
                    timestamp=timestamp,
                    fallback=fallback_used,
                )
                _emit("timestamp", {"video_id": video_id, "timestamp": timestamp, "fallback": fallback_used})
                completed_units += 1
                emit_progress(
                    percent=5.0 + (completed_units / total_units) * 95.0,
                    phase="gemini_timestamp_done",
                    video_id=video_id,
                    detail=timestamp,
                )

                if not candidates and fallback_used:
                    raise RuntimeError(f"Gemini 未返回可用时间戳: {raw_analysis}")

                chosen_timestamp = timestamp
                chosen_fallback = bool(fallback_used)
                chosen_frame_path = ""
                review_attempts: list[dict[str, Any]] = []
                review_started = _now_ts()
                for attempt_index, ts in enumerate(candidate_timestamps[:8], start=1):
                    if stop_requested is not None and stop_requested():
                        raise RuntimeError("用户已停止任务")
                    try:
                        frame_output_path = os.path.join(
                            frames_dir,
                            f"{_sanitize_filename(video_id)}_{ts.replace('.', '_')}_try{attempt_index:02d}.png",
                        )
                        log_step(
                            "[任务] 抽帧",
                            video_id=video_id,
                            timestamp=ts,
                            try_index=attempt_index,
                            video_path=item.local_video_path,
                            output_image_path=frame_output_path,
                        )
                        frame_path = Video_Clip_Extraction.extract_frame_at_timestamp(
                            video_path=item.local_video_path,
                            timestamp=ts,
                            output_path=frame_output_path,
                        )

                        log_step(
                            "[任务] Gemini 关键帧审核",
                            video_id=video_id,
                            timestamp=ts,
                            try_index=attempt_index,
                            model="gemini-3-pro-preview",
                            host=settings.gemini_host,
                            port=settings.gemini_port,
                            system_prompt_file="system_prompt/gemini_frame_review_prompt.md",
                            image_path=frame_path,
                        )
                        review_raw = get_gemini.request_gemini3_pro(
                            user_input="请审核该帧是否适合作为高质量人像关键帧。",
                            host=settings.gemini_host,
                            api_key=settings.gemini_api_key,
                            parameters="",
                            image_paths=[frame_path],
                            port=settings.gemini_port,
                            system_prompt=frame_review_prompt,
                            retry_count=3,
                            retry_wait_seconds=2.0,
                            disable_proxy=True,
                        )

                        if isinstance(review_raw, str) and review_raw.strip().startswith("请求失败"):
                            raise RuntimeError(f"Gemini 审核请求失败: {review_raw}")

                        decision = "FAIL"
                        reason = ""
                        if isinstance(review_raw, dict):
                            frame_review = review_raw.get("frame_review") or {}
                            if isinstance(frame_review, dict):
                                decision = str(frame_review.get("decision", "FAIL")).upper()
                                reason = str(frame_review.get("reason", "")).strip()
                        review_attempts.append(
                            {
                                "timestamp": ts,
                                "frame_path": os.path.abspath(frame_path),
                                "decision": decision,
                                "reason": reason,
                                "raw": review_raw,
                            }
                        )
                        log_step(
                            f"[审核] {ts} => {decision} {reason}".strip(),
                            video_id=video_id,
                            timestamp=ts,
                            decision=decision,
                        )
                        if decision == "PASS":
                            chosen_timestamp = ts
                            chosen_fallback = False if ts != "00.01.00" else chosen_fallback
                            chosen_frame_path = os.path.abspath(frame_path)
                            break
                    except Exception as exc:
                        review_attempts.append(
                            {
                                "timestamp": ts,
                                "frame_path": "",
                                "decision": "ERROR",
                                "reason": str(exc),
                                "raw": "",
                            }
                        )
                        log_step(
                            f"[审核异常] {ts} try#{attempt_index}: {exc}",
                            video_id=video_id,
                            timestamp=ts,
                            try_index=attempt_index,
                        )
                        if "Gemini 审核请求失败" in str(exc):
                            break
                        continue

                item.timestamp = chosen_timestamp
                item.timestamp_fallback = bool(chosen_fallback)
                item.frame_image_path = chosen_frame_path
                review_finished = _now_ts()
                item.steps.append(
                    StepResult(
                        name="frame_review",
                        status="success" if chosen_frame_path else "failed",
                        started_at=datetime.fromtimestamp(review_started).isoformat(timespec="seconds"),
                        finished_at=datetime.fromtimestamp(review_finished).isoformat(timespec="seconds"),
                        duration=_format_duration(review_finished - review_started),
                        inputs={"video_path": item.local_video_path, "candidate_timestamps": candidate_timestamps},
                        outputs={"timestamp": chosen_timestamp, "frame_image_path": chosen_frame_path, "attempts": review_attempts},
                        prompt="system_prompt=system_prompt/gemini_frame_review_prompt.md",
                    )
                )

                if not chosen_frame_path:
                    raise RuntimeError(
                        f"关键帧审核失败，未得到 PASS 帧: video_id={video_id} attempts={len(review_attempts)}"
                    )

                log_step(f"[阶段3] 抽帧完成(已审核): {item.frame_image_path}", video_id=video_id, timestamp=chosen_timestamp)
                _emit("frame", {"video_id": video_id, "path": item.frame_image_path, "timestamp": chosen_timestamp})
                completed_units += 1
                emit_progress(
                    percent=5.0 + (completed_units / total_units) * 95.0,
                    phase="frame_review_done",
                    video_id=video_id,
                    detail=chosen_timestamp,
                )
            except Exception as exc:
                item.steps.append(
                    StepResult(
                        name="video_pipeline",
                        status="failed",
                        started_at=datetime.now().isoformat(timespec="seconds"),
                        finished_at=datetime.now().isoformat(timespec="seconds"),
                        duration="0.0s",
                        inputs={"video_path": item.local_video_path},
                        outputs={},
                        error=str(exc),
                    )
                )
                log_step(f"[失败] 视频处理失败: {video_id}; 错误: {exc}", video_id=video_id)
                _emit("video_item", {"video_id": video_id, "status": "failed", "error": str(exc)[:200]})
                completed_units += per_video_units
                emit_progress(
                    percent=5.0 + (completed_units / total_units) * 95.0,
                    phase="video_failed",
                    video_id=video_id,
                    detail=str(exc)[:120],
                )
                continue

            raise RuntimeError("WorkFlow.py 需要先由 ComfyUI 生成场景图，再进入视频工作流")

        use_custom_duration = bool(getattr(settings, "use_custom_duration", False))
        requested_duration = int(getattr(settings, "output_duration_seconds", 0) or 0)
        probe_width, probe_height, probe_fps = _probe_video_meta(item.local_video_path)
        width = int(getattr(settings, "output_width", 0) or 0) or int(probe_width or 0) or 576
        height = int(getattr(settings, "output_height", 0) or 0) or int(probe_height or 0) or 1024
        frame_rate = int(getattr(settings, "output_fps", 0) or 0) or int(probe_fps or 0) or 30
        width = max(width, 1)
        height = max(height, 1)
        frame_rate = max(frame_rate, 1)

        source_duration = _probe_video_duration_seconds(item.local_video_path)
        source_duration_int = max(int(round(source_duration or 0.0)), 1)
        if use_custom_duration and requested_duration > 0:
            target_duration = min(int(requested_duration), source_duration_int)
        else:
            target_duration = source_duration_int
        target_duration = max(int(target_duration or 0), 1)

        segments_dir = os.path.join(project_dir, "segments", _sanitize_filename(video_id))
        segments: list[dict[str, Any]] = []
        if target_duration <= 30 and target_duration == source_duration_int and not use_custom_duration:
            segments = [{"path": os.path.abspath(item.local_video_path), "start": 0, "duration": int(target_duration)}]
        else:
            segments = _split_video_segments(
                input_path=item.local_video_path,
                target_duration_seconds=target_duration,
                out_dir=segments_dir,
                basename=video_id,
                max_segment_seconds=30,
            )

        step_started = _now_ts()
        image_ext = os.path.splitext(str(item.generated_image_path or ""))[1] or ".png"
        remote_image = f"tiktok_replace/{run_id}/images/{_sanitize_filename(video_id)}{image_ext}"
        uploaded_image_url, upload_image_meta = _upload_asset(
            local_path=item.generated_image_path,
            remote_path=remote_image,
            server_ip=settings.upload_server_ip,
            server_port=settings.upload_server_port,
        )
        item.uploaded_image_url = uploaded_image_url
        step_finished = _now_ts()
        item.steps.append(
            StepResult(
                name="upload_image",
                status="success" if uploaded_image_url else "skipped",
                started_at=datetime.fromtimestamp(step_started).isoformat(timespec="seconds"),
                finished_at=datetime.fromtimestamp(step_finished).isoformat(timespec="seconds"),
                duration=_format_duration(step_finished - step_started),
                inputs={"server_ip": settings.upload_server_ip, "server_port": settings.upload_server_port},
                outputs={"image_url": uploaded_image_url, "upload_image": upload_image_meta},
                meta={"target_duration_seconds": target_duration, "segments": segments},
            )
        )
        log_step("[阶段5] 图片上传", video_id=video_id, image_url="ok" if uploaded_image_url else "skip", target_duration_seconds=target_duration, segments=len(segments))
        completed_units += 1
        emit_progress(percent=5.0 + (completed_units / total_units) * 95.0, phase="upload_done", video_id=video_id)

        replace_prompt = settings.replace_prompt.strip()
        if settings.regenerate_prompt_append.strip():
            replace_prompt = f"{replace_prompt}\n补充建议：{settings.regenerate_prompt_append.strip()}"

        output_name = f"{_sanitize_filename(video_id)}_v1.mp4"
        final_output_path = os.path.join(finals_dir, output_name)
        segment_outputs: list[str] = []
        segment_results: list[dict[str, Any]] = []
        first_video_url = ""

        for seg_index, seg in enumerate(segments, start=1):
            seg_path = str(seg.get("path") or "").strip()
            seg_dur = int(seg.get("duration") or 0) or 1
            seg_dur = min(max(seg_dur, 1), 30)
            remote_video = f"tiktok_replace/{run_id}/videos/{_sanitize_filename(video_id)}_p{seg_index:03d}.mp4"
            uploaded_video_url, upload_video_meta = _upload_asset(
                local_path=seg_path,
                remote_path=remote_video,
                server_ip=settings.upload_server_ip,
                server_port=settings.upload_server_port,
            )
            if not first_video_url:
                first_video_url = uploaded_video_url
            replace_video_ref = uploaded_video_url or seg_path
            replace_image_ref = uploaded_image_url or item.generated_image_path

            part_output_path = final_output_path
            if len(segments) > 1:
                part_output_path = os.path.join(finals_dir, f"{_sanitize_filename(video_id)}_part{seg_index:03d}.mp4")
            segment_outputs.append(part_output_path)

            step_started = _now_ts()
            log_step(
                "[任务] replace_model 分段生成",
                video_id=video_id,
                part=seg_index,
                video_ref=replace_video_ref,
                image_ref=replace_image_ref,
                app_id=str(getattr(settings, "runninghub_replace_app_id", "") or ""),
                width=width,
                height=height,
                frame=frame_rate,
                duration_seconds=seg_dur,
                output_path=part_output_path,
                prompt=replace_prompt,
            )
            replace_result = replace_model.requests_api(
                prompt=replace_prompt,
                video_path=replace_video_ref,
                image_path=replace_image_ref,
                width=width,
                height=height,
                frame=frame_rate,
                duration_seconds=seg_dur,
                video_output_path=part_output_path,
                api_key=settings.runninghub_api_key,
                app_id=str(getattr(settings, "runninghub_replace_app_id", "") or None),
                stop_requested=stop_requested,
                logger=lambda msg, _p=seg_index: log_step(str(msg), video_id=video_id, step="replace_model_poll", part=_p),
            )
            step_finished = _now_ts()
            ok = str(replace_result.get("status", "")).lower() == "success" and os.path.exists(part_output_path)
            segment_results.append({"part": seg_index, "status": "success" if ok else "failed", "output": os.path.abspath(part_output_path), "raw": replace_result, "upload_video": upload_video_meta})
            item.steps.append(
                StepResult(
                    name="replace_model_part",
                    status="success" if ok else "failed",
                    started_at=datetime.fromtimestamp(step_started).isoformat(timespec="seconds"),
                    finished_at=datetime.fromtimestamp(step_finished).isoformat(timespec="seconds"),
                    duration=_format_duration(step_finished - step_started),
                    inputs={"video_ref": replace_video_ref, "image_ref": replace_image_ref, "width": width, "height": height, "frame": frame_rate, "duration_seconds": seg_dur},
                    outputs={"final_video_path": os.path.abspath(part_output_path), "raw": replace_result},
                    prompt=replace_prompt,
                    meta={"part": seg_index},
                )
            )
            if not ok:
                raise RuntimeError(f"replace_model 分段失败: part={seg_index} message={str(replace_result.get('message') or '')[:200]}")

        item.uploaded_video_url = first_video_url
        if len(segment_outputs) > 1:
            concat_started = _now_ts()
            _concat_video_segments(segment_paths=segment_outputs, output_path=final_output_path)
            concat_finished = _now_ts()
            item.steps.append(
                StepResult(
                    name="concat_segments",
                    status="success" if os.path.exists(final_output_path) else "failed",
                    started_at=datetime.fromtimestamp(concat_started).isoformat(timespec="seconds"),
                    finished_at=datetime.fromtimestamp(concat_finished).isoformat(timespec="seconds"),
                    duration=_format_duration(concat_finished - concat_started),
                    inputs={"segments": segment_outputs},
                    outputs={"final_video_path": os.path.abspath(final_output_path)},
                )
            )

        ok_final = os.path.exists(final_output_path)
        item.final_versions.append(
            {
                "version": 1,
                "path": os.path.abspath(final_output_path),
                "status": "success" if ok_final else "failed",
                "prompt": replace_prompt,
                "raw": {"segments": segment_results},
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }
        )
        log_step(
            f"[阶段6] replace_model: {'成功' if ok_final else '失败'} 输出={final_output_path}",
            video_id=video_id,
            status="success" if ok_final else "failed",
            segments=len(segments),
            target_duration_seconds=target_duration,
        )
        _emit("final", {"video_id": video_id, "path": final_output_path, "status": "success" if ok else "failed"})
        completed_units += 1
        emit_progress(
            percent=5.0 + (completed_units / total_units) * 95.0,
            phase="replace_done",
            video_id=video_id,
            detail="success" if ok else "failed",
        )
        _emit("video_item", {"video_id": video_id, "status": "success" if ok else "failed"})

    manifest = ProjectManifest(
        run_id=run_id,
        created_at=datetime.now().isoformat(timespec="seconds"),
        project_dir=project_dir,
        config={
            **asdict(settings),
            "gemini_api_key": _mask_secret(settings.gemini_api_key),
            "nano_api_key": _mask_secret(settings.nano_api_key),
            "runninghub_api_key": _mask_secret(settings.runninghub_api_key),
            "prompt_files": {"gemini": "system_prompt/gemini_system_prompt.md"},
        },
        items=items,
        logs=project_logs,
    )

    manifest_path = os.path.join(project_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(asdict(manifest), f, ensure_ascii=False, indent=2)

    log_step(f"[完成] manifest 已保存: {manifest_path}", manifest_path=manifest_path)
    emit_progress(percent=100.0, phase="done")
    return {"project_dir": project_dir, "manifest_path": manifest_path, "items": [asdict(x) for x in items]}


def regenerate_single_video(
    *,
    manifest_path: str,
    video_id: str,
    feedback: str,
    api_key: str,
    logger: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    logger = logger or _default_logger
    if not os.path.exists(manifest_path):
        raise FileNotFoundError(f"manifest 不存在: {manifest_path}")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    items = manifest.get("items") or []
    target = None
    for item in items:
        if str(item.get("video_id", "")) == str(video_id):
            target = item
            break
    if target is None:
        raise ValueError(f"找不到 video_id={video_id}")

    finals_dir = os.path.join(manifest.get("project_dir") or os.path.dirname(manifest_path), "finals")
    _ensure_dir(finals_dir)
    versions = target.get("final_versions") or []
    next_version = len(versions) + 1
    output_path = os.path.join(finals_dir, f"{_sanitize_filename(video_id)}_v{next_version}.mp4")
    video_ref = str(target.get("uploaded_video_url") or target.get("local_video_path") or "").strip()
    image_ref = str(target.get("uploaded_image_url") or target.get("generated_image_path") or "").strip()
    if not video_ref or not image_ref:
        raise RuntimeError("缺少可用于重生成的视频/图片引用")

    probe_width, probe_height, probe_fps = _probe_video_meta(str(target.get("local_video_path") or ""))
    config = manifest.get("config") or {}
    width = int(config.get("output_width") or 0) or int(probe_width or 0) or 576
    height = int(config.get("output_height") or 0) or int(probe_height or 0) or 1024
    frame_rate = int(config.get("output_fps") or 0) or int(probe_fps or 0) or 30
    width = max(width, 1)
    height = max(height, 1)
    frame_rate = max(frame_rate, 1)
    local_video_path = str(target.get("local_video_path") or "").strip()
    source_duration = _probe_video_duration_seconds(local_video_path)
    source_duration_int = max(int(round(source_duration or 0.0)), 1)
    use_custom_duration = bool(config.get("use_custom_duration", False))
    requested_duration = int(config.get("output_duration_seconds") or 0)
    if use_custom_duration and requested_duration > 0:
        target_duration = min(int(requested_duration), source_duration_int)
    else:
        target_duration = source_duration_int
    target_duration = max(int(target_duration or 0), 1)
    base_prompt = str(config.get("replace_prompt") or "").strip() or "保持原视频内容一致，仅替换人物。"
    new_prompt = f"{base_prompt}\n修改建议：{feedback.strip()}" if feedback.strip() else base_prompt
    logger(f"[重生成] {video_id} v{next_version} 输出={output_path}")
    app_id = str(config.get("runninghub_replace_app_id") or "1977634608437174274")
    upload_server_ip = str(config.get("upload_server_ip") or "").strip() or None
    upload_server_port = config.get("upload_server_port")
    try:
        upload_server_port_int = int(upload_server_port) if upload_server_port is not None and str(upload_server_port).strip() else None
    except Exception:
        upload_server_port_int = None

    segments_dir = os.path.join(finals_dir, "regen_segments", _sanitize_filename(video_id), f"v{next_version}")
    segments: list[dict[str, Any]] = []
    if target_duration <= 30 and target_duration == source_duration_int and not use_custom_duration:
        segments = [{"path": os.path.abspath(local_video_path), "start": 0, "duration": int(target_duration)}]
    else:
        segments = _split_video_segments(
            input_path=local_video_path,
            target_duration_seconds=target_duration,
            out_dir=segments_dir,
            basename=f"{video_id}_v{next_version}",
            max_segment_seconds=30,
        )

    segment_outputs: list[str] = []
    segment_results: list[dict[str, Any]] = []
    for seg_index, seg in enumerate(segments, start=1):
        seg_path = str(seg.get("path") or "").strip()
        seg_dur = int(seg.get("duration") or 0) or 1
        seg_dur = min(max(seg_dur, 1), 30)
        part_output = output_path
        if len(segments) > 1:
            part_output = os.path.join(finals_dir, f"{_sanitize_filename(video_id)}_v{next_version}_part{seg_index:03d}.mp4")
        segment_outputs.append(part_output)

        seg_video_ref = video_ref
        if upload_server_ip and upload_server_port_int is not None:
            run_id = str(manifest.get("run_id") or "regen").strip() or "regen"
            remote_video = f"tiktok_replace/{run_id}/regen/{_sanitize_filename(video_id)}/v{next_version}_p{seg_index:03d}.mp4"
            uploaded_seg_url, _meta = _upload_asset(
                local_path=seg_path,
                remote_path=remote_video,
                server_ip=upload_server_ip,
                server_port=upload_server_port_int,
            )
            seg_video_ref = uploaded_seg_url or seg_path
        elif len(segments) > 1:
            raise RuntimeError("重生成分段需要配置 upload_server_ip/upload_server_port 用于上传片段公网 URL。")

        result = replace_model.requests_api(
            prompt=new_prompt,
            video_path=seg_video_ref,
            image_path=image_ref,
            width=width,
            height=height,
            frame=frame_rate,
            video_output_path=part_output,
            api_key=api_key,
            app_id=app_id,
            duration_seconds=seg_dur,
        )
        status = str(result.get("status", "")).lower()
        ok_part = status == "success" and os.path.exists(part_output)
        segment_results.append({"part": seg_index, "status": "success" if ok_part else "failed", "output": os.path.abspath(part_output), "raw": result})
        if not ok_part:
            break

    ok = all(r.get("status") == "success" for r in segment_results) and bool(segment_results)
    if ok and len(segment_outputs) > 1:
        _concat_video_segments(segment_paths=segment_outputs, output_path=output_path)
        ok = os.path.exists(output_path)
    versions.append(
        {
            "version": next_version,
            "path": os.path.abspath(output_path),
            "status": "success" if ok else "failed",
            "prompt": new_prompt,
            "raw": result,
            "raw": {"segments": segment_results},
        }
    )
    target["final_versions"] = versions
    target["final_versions"] = versions
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return {"status": "success" if ok else "failed", "output_path": os.path.abspath(output_path), "raw": result}
