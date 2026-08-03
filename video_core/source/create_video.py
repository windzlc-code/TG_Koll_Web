import json
import math
import os
import time
from typing import Any

import requests

from .runninghub_common import BASE_URL, _get_run_api_base, _log, _normalize_submit_result, _safe_json_preview, query_task, rh_get, rh_post
from .runtime_config_bootstrap import load_runtime_config

default_config = load_runtime_config()
DIGITAL_HUMAN_VIDEO_APP_ID = "2068273204367544322"
LEGACY_INFINITETALK_VIDEO_APP_ID = "1958162038503649281"
DEFAULT_APP_ID = DIGITAL_HUMAN_VIDEO_APP_ID
SAFE_VIDEO_WIDTH = 576
SAFE_VIDEO_HEIGHT = 1024
CURRENT_DIGITAL_HUMAN_VIDEO_APP_ID = DIGITAL_HUMAN_VIDEO_APP_ID
CURRENT_VIDEO_MAX_RESOLUTION = 1280
CURRENT_VIDEO_FRAME_RATE = 25
DIGITAL_HUMAN_ACTION_PROMPT = "角色面向镜头深情的说话，固定镜头。"
AUDIO_DURATION_ZERO_WORKFLOW_IDS: set[str] = set()
PLUS_INSTANCE_WORKFLOW_IDS = {DIGITAL_HUMAN_VIDEO_APP_ID, LEGACY_INFINITETALK_VIDEO_APP_ID}

_DEFAULT_VIDEO_WORKFLOW_CAPABILITIES: dict[str, Any] = {
    "node_mapping": "infinitetalk_audio_window",
    "supports_prompt": False,
    "supports_camera_video": False,
    "supports_max_resolution": False,
    "supports_low_motion_prompt_retry": False,
}
_VIDEO_WORKFLOW_CAPABILITIES: dict[str, dict[str, Any]] = {
    DIGITAL_HUMAN_VIDEO_APP_ID: {
        "node_mapping": "ltx23_duration",
        "supports_prompt": False,
        "supports_camera_video": False,
        "supports_max_resolution": False,
        "supports_low_motion_prompt_retry": False,
    },
    LEGACY_INFINITETALK_VIDEO_APP_ID: dict(_DEFAULT_VIDEO_WORKFLOW_CAPABILITIES),
}


def normalize_digital_human_video_app_id(app_id: Any = None) -> str:
    text = str(app_id or "").strip()
    return text or DIGITAL_HUMAN_VIDEO_APP_ID


def get_video_workflow_capabilities(app_id: Any = None) -> dict[str, Any]:
    app_id_text = normalize_digital_human_video_app_id(app_id)
    capabilities = _VIDEO_WORKFLOW_CAPABILITIES.get(app_id_text, _DEFAULT_VIDEO_WORKFLOW_CAPABILITIES)
    return {"workflow_id": app_id_text, **capabilities}


def normalize_video_max_resolution(value: Any = None) -> int:
    return CURRENT_VIDEO_MAX_RESOLUTION


def resolve_instance_type_for_workflow(app_id: str | None, instance_type: str | None = None) -> str:
    app_id_text = normalize_digital_human_video_app_id(app_id or DEFAULT_APP_ID)
    if app_id_text in PLUS_INSTANCE_WORKFLOW_IDS:
        return "plus"
    return str(instance_type or "default").strip() or "default"


def calculate_image_width(image_url: str) -> dict[str, int] | None:
    """
    下载图片并计算其长宽度。
    图片将缓存至 ./webapp_data/images_cache 目录。

    Args:
        image_url: 图片的 URL 地址

    Returns:
        包含宽度和高度的字典 {"width": width, "height": height}，如果失败则返回 None
    """
    import os
    from PIL import Image
    import io

    cache_dir = "./webapp_data/images_cache"
    os.makedirs(cache_dir, exist_ok=True)

    try:
        response = rh_get(image_url, timeout=30)
        response.raise_for_status()

        # 从 URL 中提取文件名，如果无法提取则使用默认名称
        filename = os.path.basename(image_url.split('?')[0]) or "cached_image.jpg"
        # 确保文件名安全
        safe_filename = "".join(c for c in filename if c.isalnum() or c in "._-")
        if not safe_filename:
            safe_filename = "cached_image.png"

        filepath = os.path.join(cache_dir, safe_filename)

        # 保存图片到缓存目录
        with open(filepath, "wb") as f:
            f.write(response.content)

        # 打开图片并获取宽度
        img = Image.open(io.BytesIO(response.content))
        width, height = img.size

        return {"width": width, "height": height}

    except Exception as e:
        _log(None, f"计算图片宽度失败: {e}")
        return None



def _build_node_info_list(
    *,
    app_id: str | None = None,
    image_url: str,
    audio_url: str,
    duration_seconds: int | str,
    prompt_text: str,
    camera_video_url: str | None = None,
    max_resolution: int | str | None = None,
) -> list[dict[str, Any]]:
    app_id_text = normalize_digital_human_video_app_id(app_id or DEFAULT_APP_ID)
    capabilities = get_video_workflow_capabilities(app_id_text)
    try:
        duration_number = float(duration_seconds)
    except Exception:
        duration_number = 0.0
    duration_seconds_text = str(int(math.ceil(max(duration_number, 0.0))) if duration_number else duration_seconds)
    if capabilities.get("node_mapping") == "ltx23_duration":
        return [
            {"nodeId": "269", "fieldName": "image", "fieldValue": f"{image_url}", "description": "上传数字人图片"},
            {"nodeId": "332", "fieldName": "audio", "fieldValue": f"{audio_url}", "description": "上传口播音频"},
            {"nodeId": "331", "fieldName": "duration", "fieldValue": duration_seconds_text, "description": "视频时长（秒）"},
            {"nodeId": "394", "fieldName": "duration", "fieldValue": duration_seconds_text, "description": "视频时长（秒）"},
        ]
    return [
        {"nodeId": "133", "fieldName": "image", "fieldValue": f"{image_url}", "description": "上传图像"},
        {"nodeId": "218", "fieldName": "audio", "fieldValue": f"{audio_url}", "description": "上传音频（音频时长= 结束时间-开始时间）"},
        {"nodeId": "230", "fieldName": "value", "fieldValue": "0", "description": "音频-开始时间（秒）"},
        {"nodeId": "231", "fieldName": "value", "fieldValue": duration_seconds_text, "description": "音频-结束时间（秒）"},
    ]


def _normalize_video_dimensions(width: int | None, height: int | None) -> tuple[int, int]:
    try:
        width_value = int(width or 0)
    except Exception:
        width_value = 0
    try:
        height_value = int(height or 0)
    except Exception:
        height_value = 0
    if width_value <= 0 or height_value <= 0:
        return SAFE_VIDEO_WIDTH, SAFE_VIDEO_HEIGHT
    if width_value <= SAFE_VIDEO_WIDTH and height_value <= SAFE_VIDEO_HEIGHT:
        return width_value, height_value
    return SAFE_VIDEO_WIDTH, SAFE_VIDEO_HEIGHT


def _parse_json_response(response) -> dict:
    try:
        return response.json()
    except ValueError as exc:
        preview = str(getattr(response, "text", "") or "")[:500]
        return {"status": "failed", "message": f"响应解析失败: {exc}; preview={preview}", "raw": preview}


def _submit_ai_app_task(payload: dict[str, Any]) -> dict:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        data = {}
    task_id = str(data.get("taskId") or data.get("task_id") or data.get("task id") or "").strip()
    code = payload.get("code") if isinstance(payload, dict) else None
    status = "success" if str(code) in {"0", "None"} and task_id else "failed"
    return {
        "status": status,
        "task id": task_id,
        "task_id": task_id,
        "taskId": task_id,
        "message": str(payload.get("msg") or payload.get("message") or payload.get("errorMessage") or "").strip(),
        "raw": payload,
    }


def requests_create_video(
    *,
    image_url: str,
    audio_url: str,
    duration_seconds: int | str,
    prompt_text: str,
    api_key: str,
    app_id: str | None = None,
    instance_type: str = "default",
    use_personal_queue: bool = False,
    camera_video_url: str | None = None,
    max_resolution: int | str | None = None,
) -> dict:
    app_id_text = normalize_digital_human_video_app_id(app_id or DEFAULT_APP_ID)
    node_info_list = _build_node_info_list(
        app_id=app_id_text,
        image_url=str(image_url or "").strip(),
        audio_url=str(audio_url or "").strip(),
        duration_seconds=int(duration_seconds) if str(duration_seconds).strip().isdigit() else duration_seconds,
        prompt_text=str(prompt_text or "").strip(),
        camera_video_url=camera_video_url,
        max_resolution=max_resolution,
    )
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    api_base = _get_run_api_base(app_id_text, DEFAULT_APP_ID)
    payload = {
        "nodeInfoList": node_info_list,
        "instanceType": resolve_instance_type_for_workflow(app_id_text, instance_type),
        "usePersonalQueue": bool(use_personal_queue),
    }
    response = rh_post(str(BASE_URL).rstrip("/") + "/" + api_base, headers=headers, data=json.dumps(payload))
    raw = _parse_json_response(response)
    if isinstance(raw, dict) and "code" in raw and int(raw.get("code") or 0) != 0:
        return {
            "status": "failed",
            "message": f"RunningHub API 返回错误: code={raw.get('code')} msg={raw.get('msg')} preview={_safe_json_preview(raw)}",
            "raw": raw,
        }
    normalized = _normalize_submit_result(raw)
    if not normalized.get("message"):
        normalized["message"] = f"submit status={normalized.get('status')} task_id={normalized.get('task id')}"
    return normalized


def requests_api(
    *,
    image_url: str,
    audio_url: str,
    duration_seconds: int | str,
    prompt_text: str,
    video_output_path: str,
    api_key: str,
    app_id: str | None = None,
    instance_type: str = "default",
    use_personal_queue: bool = False,
    camera_video_url: str | None = None,
    max_resolution: int | str | None = None,
    stop_requested=None,
    poll_interval_seconds: float = 3.0,
    logger=None,
    progress_callback=None,
) -> dict:
    def _submit_retry_kind(res: Any) -> str | None:
        if not isinstance(res, dict):
            return None
        raw = res.get("raw") if isinstance(res.get("raw"), dict) else res
        if not isinstance(raw, dict):
            return None
        code = str(raw.get("code") or "").strip()
        err_code = str(raw.get("errorCode") or "").strip()
        msg = str(raw.get("msg") or raw.get("errorMessage") or raw.get("message") or "").lower()
        if code in {"421", "429"} or err_code in {"421", "429"}:
            return "limit"
        if ("limit reached" in msg) or ("并发" in msg) or ("retry later" in msg) or ("queue limit" in msg):
            return "limit"
        if err_code == "414" and (
            ("unknown error" in msg)
            or ("please retry or contact support" in msg)
            or ("未知错误" in msg)
        ):
            return "transient_unknown"
        return None

    max_retries = 120
    try:
        max_retries = int(str(os.getenv("RH_VIDEO_SUBMIT_RETRIES", "120") or "120").strip() or "120")
    except Exception:
        max_retries = 120
    transient_unknown_retries = 6
    try:
        transient_unknown_retries = int(
            str(os.getenv("RH_VIDEO_SUBMIT_UNKNOWN_RETRIES", "6") or "6").strip() or "6"
        )
    except Exception:
        transient_unknown_retries = 6
    base_sleep = 2.0
    try:
        base_sleep = float(str(os.getenv("RH_VIDEO_SUBMIT_BASE_SLEEP", "2.0") or "2.0").strip() or "2.0")
    except Exception:
        base_sleep = 2.0

    attempt = 0
    requested_max_resolution = normalize_video_max_resolution(max_resolution)
    while True:
        attempt += 1
        result = requests_create_video(
            image_url=image_url,
            audio_url=audio_url,
            duration_seconds=duration_seconds,
            prompt_text=prompt_text,
            api_key=api_key,
            app_id=app_id,
            instance_type=instance_type,
            use_personal_queue=use_personal_queue,
            camera_video_url=camera_video_url,
            max_resolution=requested_max_resolution,
        )
        task_id = str(result.get("task id") or "").strip()
        if task_id:
            break
        retry_kind = _submit_retry_kind(result)
        retry_budget = max_retries if retry_kind == "limit" else transient_unknown_retries if retry_kind == "transient_unknown" else 0
        if retry_kind and attempt <= retry_budget:
            sleep_s = min(float(base_sleep) * (1.35 ** (attempt - 1)), 30.0)
            if retry_kind == "limit":
                _log(logger, f"RunningHub 视频任务触发并发限制，等待 {sleep_s:.1f}s 后重试（{attempt}/{retry_budget}）")
            else:
                _log(
                    logger,
                    f"RunningHub 视频任务提交返回瞬时未知错误，等待 {sleep_s:.1f}s 后重试（{attempt}/{retry_budget}）",
                )
            time.sleep(max(sleep_s, 0.5))
            continue
        _log(logger, _safe_json_preview(result))
        return result

    submit_status = str(result.get("status") or "").strip().upper() or "RUNNING"
    _log(logger, f"task id: {task_id}")
    _log(logger, "task status:")
    _log(logger, f"[*] {submit_status}")

    last_printed_status = None
    last_progress = None
    while True:
        if stop_requested is not None and stop_requested():
            return {"status": "failed", "message": "用户已停止任务"}
        task_progress = query_task(task_id=task_id, api_key=api_key, video_output_path=video_output_path)
        if not isinstance(task_progress, dict):
            task_progress = {"status": "UNKNOWN", "message": f"Invalid task_progress: {task_progress}"}
        status = task_progress.get("status")
        message = str(task_progress.get("message", "")).strip()
        progress = task_progress.get("progress")
        if isinstance(progress, (int, float)):
            progress = float(progress)
        else:
            progress = None

        if progress_callback is not None and progress is not None:
            try:
                progress_callback({"status": status, "progress": progress, "raw": task_progress.get("raw")})
            except Exception:
                pass

        if status == "success":
            task_progress["task_id"] = str(task_id)
            _log(logger, "[*] SUCCESS")
            return task_progress
        if status == "failed":
            task_progress["task_id"] = str(task_id)
            _log(logger, "[*] FAILED")
            return task_progress
        if status == "QUEUED":
            if last_printed_status != "QUEUED":
                _log(logger, "[*] QUEUED")
                last_printed_status = "QUEUED"
            if progress is not None and progress != last_progress:
                _log(logger, f"[*] progress {progress:.1f}%")
                last_progress = progress
        elif status == "RUNNING":
            if last_printed_status != "RUNNING":
                _log(logger, "[*] RUNNING")
                last_printed_status = "RUNNING"
            if progress is not None and progress != last_progress:
                _log(logger, f"[*] progress {progress:.1f}%")
                last_progress = progress
        else:
            if last_printed_status != status:
                if message:
                    _log(logger, f"[*] {status} | {message}")
                else:
                    _log(logger, f"[*] {status}")
                last_printed_status = status
            if progress is not None and progress != last_progress:
                _log(logger, f"[*] progress {progress:.1f}%")
                last_progress = progress

        time.sleep(max(float(poll_interval_seconds or 0.0), 0.5))
