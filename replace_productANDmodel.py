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
from typing import Any

import requests

import replace_model
import replace_product
import runninghub_common


VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".webm"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
DEFAULT_PRODUCT_APP_ID = "1977410328592031746"


@dataclass
class BatchConfig:
    rh_api_key: str
    output_dir: str
    model_app_id: str
    product_app_id: str
    model_app_ids: list[str] | None
    product_app_ids: list[str] | None
    match_mode: str
    fixed_index: int
    auto_rename: bool
    model_params: dict[str, Any]
    product_params: dict[str, Any]
    batch_params: list[dict[str, Any]]
    common_params: list[dict[str, Any]]
    cycle_params_on_shortage: bool
    product_mapping: list[dict[str, Any]] | None
    upload_result: bool
    media_url_resolver: Any = None


def _now_ts() -> float:
    return time.time()


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


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


def _safe_extract_zip(zip_path: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise RuntimeError(f"不安全的 zip 路径: {member.filename}")
        zf.extractall(dest_dir)


def _copy_renamed(
    *,
    src_paths: list[Path],
    dest_dir: Path,
    kind: str,
    auto_rename: bool,
) -> tuple[list[Path], dict[str, str]]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    rename_map: dict[str, str] = {}
    all_numeric = all(_is_digits_stem(p) for p in src_paths)
    if all_numeric:
        return src_paths, rename_map
    if not auto_rename:
        raise RuntimeError(f"{kind} 文件名非数字命名，请开启 auto-rename 或自行重命名为 1..N")

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


def _read_json_value(value: str | None) -> dict[str, Any]:
    text = str(value or "").strip()
    if not text:
        return {}
    if os.path.exists(text):
        with open(text, "r", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(text)


def _read_json_list(path: str | None) -> list[dict[str, Any]] | None:
    text = str(path or "").strip()
    if not text:
        return None
    with open(text, "r", encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, list):
        raise ValueError("product-mapping-json 必须是 list")
    normalized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        normalized.append(item)
    return normalized


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


def _ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("缺少 ffmpeg，无法进行视频分段/拼接，请先安装 ffmpeg。")


def _ensure_ffprobe() -> None:
    if not shutil.which("ffprobe"):
        raise RuntimeError("缺少 ffprobe，无法读取视频时长，请先安装 ffmpeg/ffprobe。")


def _run_subprocess(args: list[str]) -> tuple[int, str, str]:
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return int(completed.returncode or 0), str(completed.stdout or ""), str(completed.stderr or "")


def _probe_video_duration_seconds(video_path: Path) -> float:
    _ensure_ffprobe()
    code, out, err = _run_subprocess(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(video_path)]
    )
    if code != 0:
        raise RuntimeError((err or out or "ffprobe failed").strip())
    text = out.strip()
    try:
        value = float(text)
    except Exception:
        value = 0.0
    return max(value, 0.0)


def _run_ffmpeg(args: list[str]) -> None:
    _ensure_ffmpeg()
    code, out, err = _run_subprocess(args)
    if code != 0:
        raise RuntimeError((err or out or "ffmpeg failed").strip())


def _split_video_segments(
    *,
    input_path: Path,
    target_duration_seconds: int,
    out_dir: Path,
    basename: str,
    max_segment_seconds: int = 30,
) -> list[dict[str, Any]]:
    target = max(int(target_duration_seconds or 0), 1)
    max_seg = max(int(max_segment_seconds or 0), 1)
    out_dir.mkdir(parents=True, exist_ok=True)
    segments: list[dict[str, Any]] = []
    start = 0
    part = 1
    while start < target:
        dur = min(max_seg, target - start)
        seg_path = out_dir / f"{basename}_seg{part:03d}.mp4"
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
        segments.append({"path": str(seg_path.resolve()), "start": int(start), "duration": int(dur)})
        start += dur
        part += 1
    return segments


def _concat_video_segments(*, segment_paths: list[Path], output_path: Path) -> None:
    if not segment_paths:
        raise RuntimeError("没有可拼接的片段")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    filelist = output_path.parent / f"concat_{int(time.time())}.txt"
    with filelist.open("w", encoding="utf-8") as f:
        for p in segment_paths:
            f.write(f"file '{str(p.resolve())}'\n")
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
        str(filelist),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
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
            str(filelist),
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
            str(output_path),
        ]
        _run_ffmpeg(cmd)


def upload_binary(
    *,
    api_key: str,
    file_path: Path,
    cache: dict[str, str],
    media_kind: str,
    media_url_resolver: Any = None,
) -> str:
    stat = file_path.stat()
    cache_key = f"{file_path.resolve()}|{stat.st_size}|{int(stat.st_mtime)}|{_sha1_file(file_path)}"
    if cache_key in cache:
        return cache[cache_key]
    if callable(media_url_resolver):
        resolved_url = str(media_url_resolver(media_kind=media_kind, file_path=file_path) or "").strip()
        if not resolved_url:
            raise RuntimeError(f"上传返回空 URL: media_kind={media_kind}")
        cache[cache_key] = resolved_url
        return resolved_url

    url = str(runninghub_common.BASE_URL).rstrip("/") + "/openapi/v2/media/upload/binary"
    headers = {"Authorization": f"Bearer {api_key}"}
    with file_path.open("rb") as f:
        resp = runninghub_common.rh_post(url, headers=headers, files={"file": f}, timeout=(10, 120))
    try:
        payload = resp.json()
    except Exception:
        payload = {"status": "failed", "message": str(getattr(resp, "text", "") or "")[:500]}
    if not isinstance(payload, dict) or int(payload.get("code", -1)) != 0:
        raise RuntimeError(f"上传失败: {runninghub_common._safe_json_preview(payload)}")
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise RuntimeError(f"上传返回缺少 data: {runninghub_common._safe_json_preview(payload)}")
    file_name = str(data.get("fileName") or "").strip()
    download_url = str(data.get("download_url") or "").strip()
    suffix = file_path.suffix.lower()
    if suffix in IMAGE_EXTS and download_url:
        final_url = download_url if download_url.startswith("http://") or download_url.startswith("https://") else str(runninghub_common.BASE_URL).rstrip("/") + "/" + download_url.lstrip("/")
        cache[cache_key] = final_url
        return final_url
    if suffix in VIDEO_EXTS or suffix in AUDIO_EXTS:
        if file_name:
            cache[cache_key] = file_name
            return file_name
    if not download_url and file_name:
        cache[cache_key] = file_name
        return file_name
    if not download_url:
        raise RuntimeError(f"上传返回缺少 download_url: {runninghub_common._safe_json_preview(payload)}")
    if download_url.startswith("http://") or download_url.startswith("https://"):
        final_url = download_url
    else:
        final_url = str(runninghub_common.BASE_URL).rstrip("/") + "/" + download_url.lstrip("/")
    cache[cache_key] = final_url
    return final_url


def _submit_task(*, api_key: str, app_id: str, node_info_list: list[dict[str, Any]]) -> dict[str, Any]:
    api_base = runninghub_common._get_run_api_base(app_id, app_id)
    url = str(runninghub_common.BASE_URL).rstrip("/") + "/" + api_base
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    payload = {"nodeInfoList": node_info_list, "instanceType": "default", "usePersonalQueue": False}

    def _submit():
        resp = runninghub_common.rh_post(url, headers=headers, data=json.dumps(payload), timeout=(10, 120))
        try:
            raw = resp.json()
        except Exception:
            raw = {"status": "failed", "message": str(getattr(resp, "text", "") or "")[:500]}
        if isinstance(raw, dict) and "code" in raw and int(raw.get("code") or 0) != 0:
            return {"status": "failed", "message": f"RunningHub API 返回错误: {runninghub_common._safe_json_preview(raw)}", "raw": raw}
        return runninghub_common._normalize_submit_result(raw)

    return runninghub_common.retry_submit(_submit, label=f"联合替换提交(app_id={app_id})", logger=print)


def _poll_until_done(
    *,
    task_id: str,
    api_key: str,
    output_path: str,
    poll_interval_seconds: float,
) -> dict[str, Any]:
    last_status = None
    last_progress = None
    max_wait_seconds = max(int(os.getenv("RH_POLL_MAX_SECONDS", "1800") or 1800), 60)
    started_at = time.time()
    while True:
        if time.time() - started_at > float(max_wait_seconds):
            return {"status": "failed", "message": f"任务轮询超时（>{max_wait_seconds}s）"}
        result = runninghub_common.query_task(task_id=task_id, api_key=api_key, video_output_path=output_path)
        status = str(result.get("status") or "")
        progress = result.get("progress")
        if status != last_status:
            print(f"[*] {status}")
            last_status = status
        if isinstance(progress, (int, float)):
            p = float(progress)
            if last_progress is None or abs(p - float(last_progress)) >= 0.1:
                print(f"[*] progress {p:.1f}%")
                last_progress = p
        if status in {"success", "failed"}:
            return result
        time.sleep(max(float(poll_interval_seconds or 0.0), 0.5))


def _build_product_node_info_list_default(
    *,
    video_url: str,
    image_url: str,
    product_name: str,
    duration_seconds: int,
    frame_rate: int,
) -> list[dict[str, Any]]:
    return [
        {"nodeId": "188", "fieldName": "video", "fieldValue": f"{video_url}", "description": "请导入视频"},
        {"nodeId": "57", "fieldName": "image", "fieldValue": f"{image_url}", "description": "请导入产品图片"},
        {"nodeId": "262", "fieldName": "value", "fieldValue": f"{product_name}", "description": "请准确写出商品名称"},
        {"nodeId": "196", "fieldName": "int", "fieldValue": f"{duration_seconds}", "description": "视频时长"},
        {"nodeId": "191", "fieldName": "int", "fieldValue": f"{frame_rate}", "description": "帧率"},
    ]


def _apply_placeholders(node_info_list: list[dict[str, Any]], values: dict[str, Any]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for entry in node_info_list:
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


def run_batch(
    *,
    model_paths: list[Path],
    product_paths: list[Path],
    video_paths: list[Path],
    cfg: BatchConfig,
) -> dict[str, Any]:
    def _merge_dict(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
        merged = dict(base or {})
        for k, v in (override or {}).items():
            if isinstance(v, dict) and isinstance(merged.get(k), dict):
                merged[k] = _merge_dict(merged.get(k) or {}, v)
            else:
                merged[k] = v
        return merged

    def _pick_param_for_job(job_index: int) -> dict[str, Any]:
        base = {
            "match_mode": cfg.match_mode,
            "fixed_index": cfg.fixed_index,
            "auto_rename": cfg.auto_rename,
            "model_params": dict(cfg.model_params or {}),
            "product_params": dict(cfg.product_params or {}),
        }
        common0 = cfg.common_params[0] if cfg.common_params else {}
        base = _merge_dict(base, common0 if isinstance(common0, dict) else {})
        if not cfg.batch_params:
            return base
        idx0 = int(job_index) - 1
        item: dict[str, Any] | None = None
        if 0 <= idx0 < len(cfg.batch_params):
            cand = cfg.batch_params[idx0]
            item = cand if isinstance(cand, dict) else None
        elif cfg.cycle_params_on_shortage and len(cfg.batch_params) > 0:
            cand = cfg.batch_params[idx0 % len(cfg.batch_params)]
            item = cand if isinstance(cand, dict) else None
        if item:
            base = _merge_dict(base, item)
        return base

    out_dir = Path(cfg.output_dir).resolve()
    tmp_dir = out_dir / "tmp"
    final_dir = out_dir / "final"
    temp_model_dir = out_dir / "temp_model"
    temp_product_dir = out_dir / "temp_product"
    _ensure_dir(str(tmp_dir))
    _ensure_dir(str(final_dir))
    _ensure_dir(str(temp_model_dir))
    _ensure_dir(str(temp_product_dir))

    logs_path = out_dir / "logs.jsonl"
    rename_map_path = out_dir / "rename_map.json"

    model_paths2, model_rename = _copy_renamed(src_paths=model_paths, dest_dir=tmp_dir / "models", kind="模特图片", auto_rename=cfg.auto_rename)
    product_paths2, product_rename = _copy_renamed(src_paths=product_paths, dest_dir=tmp_dir / "products", kind="商品图片", auto_rename=cfg.auto_rename)
    video_paths2, video_rename = _copy_renamed(src_paths=video_paths, dest_dir=tmp_dir / "videos", kind="视频", auto_rename=cfg.auto_rename)

    rename_map = {"models": model_rename, "products": product_rename, "videos": video_rename}
    with rename_map_path.open("w", encoding="utf-8") as f:
        json.dump(rename_map, f, ensure_ascii=False, indent=2)

    jobs = max(len(model_paths2), len(product_paths2), len(video_paths2))
    upload_cache: dict[str, str] = {}
    success_files: list[Path] = []
    summary_items: list[dict[str, Any]] = []
    runninghub_task_ids: list[str] = []
    model_chain_ids = _normalize_workflow_ids(cfg.model_app_ids, cfg.model_app_id)
    product_chain_ids = _normalize_workflow_ids(cfg.product_app_ids, cfg.product_app_id)

    for idx0 in range(jobs):
        job_no = idx0 + 1
        chosen = _pick_param_for_job(job_no)
        chosen_model_params = chosen.get("model_params") if isinstance(chosen.get("model_params"), dict) else {}
        chosen_product_params = chosen.get("product_params") if isinstance(chosen.get("product_params"), dict) else {}
        chosen_match_mode = str(chosen.get("match_mode") or cfg.match_mode).strip() or cfg.match_mode
        try:
            chosen_fixed_index = int(chosen.get("fixed_index") or cfg.fixed_index)
        except Exception:
            chosen_fixed_index = int(cfg.fixed_index)
        chosen_fixed_index = max(chosen_fixed_index, 1)
        m_path = _pick_from_list(model_paths2, idx0, chosen_match_mode, chosen_fixed_index)
        p_path = _pick_from_list(product_paths2, idx0, chosen_match_mode, chosen_fixed_index)
        v_path = _pick_from_list(video_paths2, idx0, chosen_match_mode, chosen_fixed_index)

        record: dict[str, Any] = {
            "job": job_no,
            "model_image": str(m_path),
            "product_image": str(p_path),
            "video": str(v_path),
            "started_at": int(_now_ts()),
        }
        try:
            record["params_used"] = {
                "match_mode": chosen_match_mode,
                "fixed_index": chosen_fixed_index,
                "model_params": chosen_model_params,
                "product_params": chosen_product_params,
            }

            model_image_url = upload_binary(
                api_key=cfg.rh_api_key,
                file_path=m_path,
                cache=upload_cache,
                media_kind=f"model_job_{job_no}",
                media_url_resolver=cfg.media_url_resolver,
            )
            product_image_url = upload_binary(
                api_key=cfg.rh_api_key,
                file_path=p_path,
                cache=upload_cache,
                media_kind=f"product_job_{job_no}",
                media_url_resolver=cfg.media_url_resolver,
            )
            record["uploaded"] = {"model_image_url": model_image_url, "product_image_url": product_image_url}

            model_prompt = str(chosen_model_params.get("prompt") or "").strip()
            width = int(chosen_model_params.get("width") or 576)
            height = int(chosen_model_params.get("height") or 1024)
            frame = int(chosen_model_params.get("frame") or 30)
            width = max(width, 1)
            height = max(height, 1)
            frame = max(frame, 1)

            video_duration = _probe_video_duration_seconds(v_path)
            video_duration_int = max(int(round(video_duration or 0.0)), 1)
            use_custom_duration = bool(chosen_model_params.get("use_custom_duration") or chosen_product_params.get("use_custom_duration") or False)
            requested_duration = 0
            if use_custom_duration:
                requested_duration = int(chosen_model_params.get("duration_seconds") or chosen_product_params.get("duration_seconds") or 0)
            if use_custom_duration and requested_duration > 0:
                target_duration = min(int(requested_duration), video_duration_int)
            else:
                target_duration = video_duration_int
            target_duration = max(int(target_duration or 0), 1)

            segments: list[dict[str, Any]] = []
            if target_duration <= 30 and target_duration == video_duration_int and not use_custom_duration:
                segments = [{"path": str(v_path.resolve()), "start": 0, "duration": int(target_duration)}]
            else:
                segments = _split_video_segments(
                    input_path=v_path,
                    target_duration_seconds=target_duration,
                    out_dir=tmp_dir / "video_segments" / f"job_{job_no:03d}",
                    basename=f"job{job_no:03d}",
                    max_segment_seconds=30,
                )
            record["video_meta"] = {"duration_seconds": video_duration_int, "target_duration_seconds": target_duration, "segments": segments, "use_custom_duration": use_custom_duration}

            product_name = str(chosen_product_params.get("product_name") or "").strip()
            product_frame_rate = int(chosen_product_params.get("frame_rate") or frame)
            product_prompt_text = str(
                chosen_product_params.get("prompt_text")
                or chosen_product_params.get("prompt")
                or ""
            ).strip()
            product_width = int(chosen_product_params.get("width") or width)
            product_height = int(chosen_product_params.get("height") or height)
            product_frame_rate = max(product_frame_rate, 1)
            product_width = max(product_width, 1)
            product_height = max(product_height, 1)

            record["stage_model"] = {"app_ids": model_chain_ids, "parts": []}
            record["stage_product"] = {"app_ids": product_chain_ids, "parts": []}
            final_parts: list[Path] = []

            for seg_index, seg in enumerate(segments, start=1):
                seg_path = Path(str(seg.get("path") or "")).resolve()
                seg_dur = int(seg.get("duration") or 0) or 1
                seg_dur = min(max(seg_dur, 1), 30)

                seg_video_url = upload_binary(
                    api_key=cfg.rh_api_key,
                    file_path=seg_path,
                    cache=upload_cache,
                    media_kind=f"video_job_{job_no}_part_{seg_index}",
                    media_url_resolver=cfg.media_url_resolver,
                )
                record.setdefault("uploaded", {})[f"video_url_p{seg_index:03d}"] = seg_video_url

                model_part_record: dict[str, Any] = {"part": seg_index, "input_video_url": seg_video_url, "steps": []}
                current_model_video_url = seg_video_url
                temp_out = temp_model_dir / (f"{job_no}_part{seg_index:03d}.mp4" if len(segments) > 1 else f"{job_no}.mp4")
                for step_index, app_id in enumerate(model_chain_ids, start=1):
                    step_out = temp_out if step_index == len(model_chain_ids) else temp_model_dir / (
                        f"{job_no}_part{seg_index:03d}_step{step_index:02d}.mp4" if len(segments) > 1 else f"{job_no}_step{step_index:02d}.mp4"
                    )
                    model_node_info = replace_model._build_node_info_list(
                        app_id=app_id,
                        video_path=current_model_video_url,
                        image_path=model_image_url,
                        prompt=model_prompt,
                        width=width,
                        height=height,
                        frame=frame,
                        duration_seconds=seg_dur,
                    )
                    model_submit = _submit_task(api_key=cfg.rh_api_key, app_id=app_id, node_info_list=model_node_info)
                    task_id1 = str(model_submit.get("task id") or "").strip()
                    if task_id1:
                        runninghub_task_ids.append(task_id1)
                    model_step_record = {"step": step_index, "app_id": app_id, "submit": model_submit, "output": str(step_out)}
                    model_part_record["steps"].append(model_step_record)
                    if not task_id1:
                        raise RuntimeError(f"模特替换提交失败 app_id={app_id}: {runninghub_common._safe_json_preview(model_submit)}")
                    print(f"[job {job_no}] model part {seg_index} step {step_index} task id: {task_id1}")
                    model_done = _poll_until_done(task_id=task_id1, api_key=cfg.rh_api_key, output_path=str(step_out), poll_interval_seconds=3.0)
                    model_step_record["done"] = model_done
                    if str(model_done.get("status")) != "success":
                        raise RuntimeError(f"模特替换失败: part={seg_index} step={step_index} {str(model_done.get('message') or '')}")
                    if not step_out.exists():
                        raise RuntimeError("模特替换返回 success 但未生成中间视频文件")
                    if step_index < len(model_chain_ids):
                        current_model_video_url = upload_binary(
                            api_key=cfg.rh_api_key,
                            file_path=step_out,
                            cache=upload_cache,
                            media_kind=f"temp_model_job_{job_no}_part_{seg_index}_step_{step_index}",
                            media_url_resolver=cfg.media_url_resolver,
                        )
                        model_step_record["uploaded_video_url"] = current_model_video_url
                record["stage_model"]["parts"].append(model_part_record)

                temp_video_url = upload_binary(
                    api_key=cfg.rh_api_key,
                    file_path=temp_out,
                    cache=upload_cache,
                    media_kind=f"temp_job_{job_no}_part_{seg_index}",
                    media_url_resolver=cfg.media_url_resolver,
                )

                product_part_record: dict[str, Any] = {"part": seg_index, "input_temp_video_url": temp_video_url, "steps": []}
                current_product_video_url = temp_video_url
                final_part = final_dir / (f"{job_no}_part{seg_index:03d}.mp4" if len(segments) > 1 else f"{job_no}.mp4")
                for step_index, app_id in enumerate(product_chain_ids, start=1):
                    step_out = final_part if step_index == len(product_chain_ids) else temp_product_dir / (
                        f"{job_no}_part{seg_index:03d}_step{step_index:02d}.mp4" if len(segments) > 1 else f"{job_no}_step{step_index:02d}.mp4"
                    )
                    product_step_record: dict[str, Any] = {"step": step_index, "app_id": app_id, "output": str(step_out)}
                    product_part_record["steps"].append(product_step_record)
                    if cfg.product_mapping:
                        values = {
                            "video_url": current_product_video_url,
                            "image_url": product_image_url,
                            "product_name": product_name,
                            "prompt_text": product_prompt_text,
                            "duration_seconds": seg_dur,
                            "frame_rate": product_frame_rate,
                            "width": product_width,
                            "height": product_height,
                        }
                        product_node_info = _apply_placeholders(cfg.product_mapping, values)
                        product_submit = _submit_task(api_key=cfg.rh_api_key, app_id=app_id, node_info_list=product_node_info)
                        task_id2 = str(product_submit.get("task id") or "").strip()
                        if task_id2:
                            runninghub_task_ids.append(task_id2)
                        product_step_record["submit"] = product_submit
                        if not task_id2:
                            raise RuntimeError(f"商品替换提交失败 app_id={app_id}: {runninghub_common._safe_json_preview(product_submit)}")
                        print(f"[job {job_no}] product part {seg_index} step {step_index} task id: {task_id2}")
                        product_done = _poll_until_done(task_id=task_id2, api_key=cfg.rh_api_key, output_path=str(step_out), poll_interval_seconds=3.0)
                        product_step_record["done"] = product_done
                        if str(product_done.get("status")) != "success":
                            raise RuntimeError(f"商品替换失败: part={seg_index} step={step_index} {str(product_done.get('message') or '')}")
                    else:
                        product_done = replace_product.requests_api(
                            product_name=product_name,
                            video_path=current_product_video_url,
                            image_path=product_image_url,
                            prompt_text=product_prompt_text,
                            duration_seconds=seg_dur,
                            frame_rate=product_frame_rate,
                            width=product_width,
                            height=product_height,
                            video_output_path=str(step_out),
                            api_key=cfg.rh_api_key,
                            app_id=app_id,
                            logger=print,
                        )
                        product_step_record["done"] = product_done
                        if str(product_done.get("status")) != "success":
                            raise RuntimeError(f"商品替换失败: part={seg_index} step={step_index} {str(product_done.get('message') or '')}")
                    if not step_out.exists():
                        raise RuntimeError("商品替换返回 success 但未生成最终视频文件")
                    if step_index < len(product_chain_ids):
                        current_product_video_url = upload_binary(
                            api_key=cfg.rh_api_key,
                            file_path=step_out,
                            cache=upload_cache,
                            media_kind=f"temp_product_job_{job_no}_part_{seg_index}_step_{step_index}",
                            media_url_resolver=cfg.media_url_resolver,
                        )
                        product_step_record["uploaded_video_url"] = current_product_video_url
                record["stage_product"]["parts"].append(product_part_record)

                if not final_part.exists():
                    raise RuntimeError("商品替换返回 success 但未生成最终视频文件")
                final_parts.append(final_part)

            final_out = final_dir / f"{job_no}.mp4"
            if len(final_parts) > 1:
                _concat_video_segments(segment_paths=final_parts, output_path=final_out)
                if not final_out.exists():
                    raise RuntimeError("分段拼接失败，未生成最终视频文件")
            else:
                final_out = final_parts[0]

            record["status"] = "success"
            record["final"] = str(final_out)
            success_files.append(final_out)
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = str(exc)
        finally:
            record["finished_at"] = int(_now_ts())
            with logs_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            summary_items.append(
                {
                    "job": int(job_no),
                    "status": str(record.get("status") or "").strip() or "failed",
                    "error": str(record.get("error") or "").strip(),
                    "final": str(record.get("final") or "").strip(),
                    "model_image": str(record.get("model_image") or "").strip(),
                    "product_image": str(record.get("product_image") or "").strip(),
                    "video": str(record.get("video") or "").strip(),
                }
            )

    results_path = out_dir / "results.json"
    with results_path.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "success": int(len(success_files)),
                "total": int(jobs),
                "items": summary_items,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    result_zip = out_dir / "result.zip"
    with zipfile.ZipFile(result_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if results_path.exists():
            zf.write(results_path, arcname="results.json")
        if logs_path.exists():
            zf.write(logs_path, arcname="logs.jsonl")
        if rename_map_path.exists():
            zf.write(rename_map_path, arcname="rename_map.json")
        for p in success_files:
            if p.exists():
                zf.write(p, arcname=p.name)

    result_url = ""
    if cfg.upload_result and result_zip.exists():
        try:
            result_url = upload_binary(
                api_key=cfg.rh_api_key,
                file_path=result_zip,
                cache=upload_cache,
                media_kind="result_zip",
                media_url_resolver=cfg.media_url_resolver,
            )
        except Exception:
            result_url = ""

    unique_task_ids: list[str] = []
    seen_ids: set[str] = set()
    for tid in runninghub_task_ids:
        text = str(tid or "").strip()
        if not text or text in seen_ids:
            continue
        seen_ids.add(text)
        unique_task_ids.append(text)

    return {
        "output_dir": str(out_dir),
        "success": len(success_files),
        "total": jobs,
        "result_zip": str(result_zip),
        "result_url": result_url,
        "runninghub_task_ids": unique_task_ids,
    }


def _resolve_input(kind: str, zip_path: str | None, dir_path: str | None, tmp_root: Path) -> Path:
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


def run_product_and_model_replace(
    *,
    rh_api_key: str,
    model_zip: str | None = None,
    model_dir: str | None = None,
    product_zip: str | None = None,
    product_dir: str | None = None,
    video_zip: str | None = None,
    video_dir: str | None = None,
    output_dir: str = "./outputs_product_and_model",
    model_app_id: str = replace_model.DEFAULT_APP_ID,
    product_app_id: str = DEFAULT_PRODUCT_APP_ID,
    model_app_ids: list[str] | None = None,
    product_app_ids: list[str] | None = None,
    match_mode: str = "cycle",
    fixed_index: int = 1,
    auto_rename: bool = True,
    model_params: dict[str, Any] | None = None,
    product_params: dict[str, Any] | None = None,
    batch_params: list[dict[str, Any]] | None = None,
    common_params: list[dict[str, Any]] | None = None,
    cycle_params_on_shortage: bool = True,
    product_mapping: list[dict[str, Any]] | None = None,
    upload_result: bool = False,
    media_url_resolver: Any = None,
) -> dict[str, Any]:
    api_key = str(rh_api_key or "").strip()
    if not api_key:
        raise ValueError("rh_api_key 不能为空")

    out_dir = Path(output_dir).expanduser().resolve()
    tmp_root = out_dir / "tmp"
    _ensure_dir(str(tmp_root))

    model_root = _resolve_input("model", model_zip, model_dir, tmp_root)
    product_root = _resolve_input("product", product_zip, product_dir, tmp_root)
    video_root = _resolve_input("video", video_zip, video_dir, tmp_root)

    model_paths = _scan_files(model_root, IMAGE_EXTS)
    product_paths = _scan_files(product_root, IMAGE_EXTS)
    video_paths = _scan_files(video_root, VIDEO_EXTS)
    if not model_paths:
        raise RuntimeError("未找到模特图片")
    if not product_paths:
        raise RuntimeError("未找到商品图片")
    if not video_paths:
        raise RuntimeError("未找到原视频")

    try:
        fixed_index_int = int(fixed_index or 1)
    except Exception:
        fixed_index_int = 1
    fixed_index_int = max(fixed_index_int, 1)
    normalized_model_app_id = replace_model.normalize_app_id(model_app_id)
    normalized_product_app_id = str(product_app_id).strip() or DEFAULT_PRODUCT_APP_ID
    normalized_model_app_ids = _normalize_workflow_ids(model_app_ids, normalized_model_app_id)
    normalized_product_app_ids = _normalize_workflow_ids(product_app_ids, normalized_product_app_id)

    cfg = BatchConfig(
        rh_api_key=api_key,
        output_dir=str(out_dir),
        model_app_id=normalized_model_app_ids[-1] if normalized_model_app_ids else normalized_model_app_id,
        product_app_id=normalized_product_app_ids[-1] if normalized_product_app_ids else normalized_product_app_id,
        model_app_ids=normalized_model_app_ids,
        product_app_ids=normalized_product_app_ids,
        match_mode=str(match_mode).strip() or "cycle",
        fixed_index=fixed_index_int,
        auto_rename=bool(auto_rename),
        model_params=model_params or {},
        product_params=product_params or {},
        batch_params=batch_params or [],
        common_params=common_params or [],
        cycle_params_on_shortage=bool(cycle_params_on_shortage),
        product_mapping=product_mapping,
        upload_result=bool(upload_result),
        media_url_resolver=media_url_resolver,
    )
    return run_batch(model_paths=model_paths, product_paths=product_paths, video_paths=video_paths, cfg=cfg)


if __name__ == "__main__":
    rh_api_key = os.getenv("RUNNINGHUB_API_KEY", "")
    if not rh_api_key:
        raise RuntimeError("请先设置 RUNNINGHUB_API_KEY 环境变量")
    model_dir = "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/model_dir"
    product_dir = "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/product_dir"
    video_dir = "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/video_dir"

    result = run_product_and_model_replace(
        rh_api_key=rh_api_key,
        model_dir=model_dir,
        product_dir=product_dir,
        video_dir=video_dir,
        model_params={
            "prompt": "一个中国女人在介绍保温杯",
            "width": 576,
            "height": 1024,
            "frame": 30
        },
        product_params={
            "product_name": "保温杯",
            "prompt_text": "一个女人在卖保温杯",
            "width": 576, "height": 1024, "frame_rate": 30
        }
    )
    print(result)
