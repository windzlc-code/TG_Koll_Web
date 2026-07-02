import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import requests
from PIL import Image

import create_audio
import create_video
import runninghub_common


VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".webm"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


@dataclass
class AudioSettings:
    emotion: str = "happy"
    language: str = "Chinese"
    model_choice: str = "1.7B"
    speaker: str = "Ryan"
    app_id: str = create_audio.DEFAULT_APP_ID


@dataclass
class NanoSettings:
    prompt_template: str = "电商口播视频场景截图风格：真实人物在室内/直播间展示商品，手持商品或放在手掌上讲解；写实摄影、柔和补光、干净背景；9:16；画面不要文字/水印/海报排版。"


@dataclass
class VideoWorkflowSettings:
    app_id: str = "1968024407312596994"
    app_ids: list[str] | None = None
    duration_mode: str = "manual"
    duration_seconds: int = 15
    camera_video_url: str | None = None
    instance_type: str = "default"
    use_personal_queue: bool = False


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
        text = str(raw or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    if out:
        return out
    fb = str(fallback or "").strip()
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


def _run_subprocess(args: list[str]) -> tuple[int, str, str]:
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return int(completed.returncode or 0), str(completed.stdout or ""), str(completed.stderr or "")


def _ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("缺少 ffmpeg，请先安装 ffmpeg。")


def _ensure_ffprobe() -> None:
    if not shutil.which("ffprobe"):
        raise RuntimeError("缺少 ffprobe，无法读取音频时长，请先安装 ffmpeg/ffprobe。")


def _probe_media_duration_seconds(media_path: Path) -> float:
    _ensure_ffprobe()
    code, out, err = _run_subprocess(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(media_path),
        ]
    )
    if code != 0:
        raise RuntimeError((err or out or "ffprobe failed").strip())
    text = out.strip()
    try:
        value = float(text)
    except Exception:
        value = 0.0
    return max(float(value or 0.0), 0.0)


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


def _download_to_file(*, url: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    resp = runninghub_common.rh_get(url, stream=True)
    resp.raise_for_status()
    with output_path.open("wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)


def _generate_audio(
    *,
    api_key: str,
    speech_text: str,
    settings: AudioSettings,
    output_path: Path,
    poll_interval_seconds: float = 3.0,
    logger=None,
) -> Path:
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
                        return out_path
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
            if audio_path_provider is not None:
                audio_value = audio_path_provider(job_no, model_image, product_image)
                audio_text = str(audio_value or "").strip()
                if audio_text:
                    audio_path = Path(audio_text).expanduser().resolve()
                    if not audio_path.exists():
                        raise FileNotFoundError(f"音频文件不存在: {audio_path}")
            if audio_path is None:
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
                if batch.resume:
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
                    audio_path = _generate_audio(
                        api_key=api_key,
                        speech_text=speech_text,
                        settings=audio_settings,
                        output_path=Path(out_dir / "audio" / f"{job_no}.mp3"),
                        logger=logger,
                    )
                    _emit_job_progress(
                        progress_callback,
                        job_no=job_no,
                        total_jobs=jobs,
                        job_progress=25,
                        message=f"第 {job_no}/{jobs} 条音频生成完成",
                        extra={"step": "audio_ready", "audio_path": str(audio_path)},
                    )
            else:
                audio_dest = Path(out_dir / "audio" / f"{job_no}{audio_path.suffix.lower() or '.bin'}")
                _ensure_dir(audio_dest.parent)
                if not audio_dest.exists():
                    shutil.copy2(audio_path, audio_dest)
                audio_path = audio_dest
                _emit_job_progress(
                    progress_callback,
                    job_no=job_no,
                    total_jobs=jobs,
                    job_progress=25,
                    message=f"第 {job_no}/{jobs} 条已使用上传音频",
                    extra={"step": "audio_ready", "audio_path": str(audio_path), "uploaded_audio": True},
                )

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
                raise RuntimeError("商业视频生成需要通过 image_path_provider 或配置 scene_images 提供已生成的场景图")
            if not image_path.exists():
                raise RuntimeError(f"场景图不存在: {image_path}")

            image_url = upload_binary(api_key=media_upload_api_key, file_path=image_path, cache=upload_cache, media_kind="image")
            duration_mode = str(getattr(video_workflow, "duration_mode", "manual") or "manual").strip() or "manual"
            duration_mode = duration_mode.lower()
            duration_seconds = max(int(getattr(video_workflow, "duration_seconds", 15) or 15), 1)
            audio_for_upload = audio_path
            if duration_mode == "audio":
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

            audio_url = upload_binary(api_key=media_upload_api_key, file_path=audio_for_upload, cache=upload_cache, media_kind="audio")
            record["uploaded"] = {"image_url": image_url, "audio_url": audio_url}
            _emit_job_progress(
                progress_callback,
                job_no=job_no,
                total_jobs=jobs,
                job_progress=75,
                message=f"第 {job_no}/{jobs} 条素材上传完成",
                extra={"step": "uploaded", "image_url": image_url, "audio_url": audio_url},
            )

            video_chain_ids = _normalize_workflow_ids(
                getattr(video_workflow, "app_ids", None),
                str(getattr(video_workflow, "app_id", "") or "").strip() or create_video.DEFAULT_APP_ID,
            )
            current_camera_video_url = str(getattr(video_workflow, "camera_video_url", "") or "").strip() or None
            record["video_chain"] = {"app_ids": list(video_chain_ids), "steps": []}
            done = {}
            for step_index, video_app_id in enumerate(video_chain_ids, start=1):
                step_out = out_video if step_index == len(video_chain_ids) else out_dir / "videos" / f"{job_no}_step{step_index:02d}.mp4"
                step_logger = (lambda message, prefix=f"[视频链 {step_index}/{len(video_chain_ids)}] ": logger(f"{prefix}{message}"))
                done = create_video.requests_api(
                    image_url=image_url,
                    audio_url=audio_url,
                    duration_seconds=duration_seconds,
                    prompt_text=prompt_text,
                    video_output_path=str(step_out),
                    api_key=api_key,
                    app_id=str(video_app_id or "").strip() or create_video.DEFAULT_APP_ID,
                    instance_type=str(video_workflow.instance_type or "default").strip() or "default",
                    use_personal_queue=bool(video_workflow.use_personal_queue),
                    camera_video_url=current_camera_video_url,
                    logger=step_logger,
                )
                step_task_id = str(done.get("task_id") or done.get("task id") or "").strip()
                if step_task_id:
                    runninghub_task_ids.append(step_task_id)
                record["video_chain"]["steps"].append(
                    {
                        "step": step_index,
                        "app_id": str(video_app_id),
                        "camera_video_url": current_camera_video_url,
                        "output_path": str(step_out),
                        "done": done,
                    }
                )
                if str(done.get("status")) != "success":
                    raise RuntimeError(f"视频生成失败: {str(done.get('message') or '')}")
                if step_index < len(video_chain_ids):
                    if not step_out.exists():
                        raise RuntimeError("视频链中间步骤成功但未找到输出视频")
                    current_camera_video_url = upload_binary(
                        api_key=media_upload_api_key,
                        file_path=step_out,
                        cache=upload_cache,
                        media_kind=f"video_chain_job_{job_no}_step_{step_index}",
                    )

            record["done"] = done
            if not out_video.exists():
                raise RuntimeError("视频生成返回 success 但未下载到本地")

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

    image_provider = build_provider(config.get("scene_images") or config.get("image_paths"))

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
            emotion=str(audio_cfg.get("emotion") or "happy").strip() or "happy",
            language=str(audio_cfg.get("language") or "Chinese").strip() or "Chinese",
            model_choice=str(audio_cfg.get("model_choice") or "1.7B").strip() or "1.7B",
            speaker=str(audio_cfg.get("speaker") or "Ryan").strip() or "Ryan",
        ),
        nano_settings=NanoSettings(
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
        ),
        speech_text_provider=speech_provider,
        prompt_provider=prompt_provider,
        image_path_provider=image_provider,
    )


def run_example() -> dict[str, Any]:
    config: dict[str, Any] = {
        "runninghub_api_key": os.getenv("RUNNINGHUB_API_KEY", ""),
        "product_dir": "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/people",
        "model_dir": "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/product",
        "output_dir": "./outputs_commerce_video",
        "speech_texts": "大家好，今天给大家介绍这款产品，它是真皮材质的，由法国著名工匠，卡特玲娜花费了1个月雕作的，它的设计师也不简单，是英国的设计师世家，詹姆斯英德伯爵的后代，詹姆斯扎克伯格设计",
        "prompts": "运镜缓慢推进，突出商品细节，口播与画面同步。",
        "audio": {"emotion": "happy", "language": "Chinese", "model_choice": "1.7B", "speaker": "Ryan"},
        "scene_images": "",
        "nano": {"prompt_template": "生成一张电商带货宣传图：模特正在介绍商品，画面真实自然，光照与风格协调。画面干净"},
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
