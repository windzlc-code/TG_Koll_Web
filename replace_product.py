import json
import os
import time

import requests

from runninghub_common import BASE_URL, _get_run_api_base, _log, _normalize_submit_result, _safe_json_preview, query_task, rh_post
from runtime_config_bootstrap import load_runtime_config

config = load_runtime_config()
DEFAULT_APP_ID = str(config.get("replace_product_app_id") or "1977410328592031746")


def _build_node_info_list(
    *,
    video_path: str,
    image_path: str,
    product_name: str,
    prompt_text: str,
    duration_seconds: int | str,
    frame_rate: int | str,
    width: int | str,
    height: int | str,
) -> list[dict]:
    return [
        {"nodeId": "188", "fieldName": "video", "fieldValue": f"{video_path}", "description": "请导入视频"},
        {"nodeId": "57", "fieldName": "image", "fieldValue": f"{image_path}", "description": "请导入产品图片"},
        {"nodeId": "197", "fieldName": "text", "fieldValue": f"{prompt_text}", "description": "请填写简单的提示词"},
        {"nodeId": "304", "fieldName": "value", "fieldValue": f"{product_name}", "description": "请填写要被换的产品的中文名称（需要是视频中唯一的名称）"},
        {"nodeId": "297", "fieldName": "int", "fieldValue": f"{duration_seconds}", "description": "视频时长（秒）"},
        {"nodeId": "191", "fieldName": "int", "fieldValue": f"{frame_rate}", "description": "视频的帧率"},
        {"nodeId": "311", "fieldName": "int", "fieldValue": f"{width}", "description": "生成的视频宽度（要是32的倍数）"},
        {"nodeId": "312", "fieldName": "int", "fieldValue": f"{height}", "description": "生成的视频长度（要是32的倍数）"},
    ]


def _parse_json_response(response) -> dict:
    try:
        return response.json()
    except ValueError as exc:
        preview = str(getattr(response, "text", "") or "")[:500]
        return {"status": "failed", "message": f"响应解析失败: {exc}; preview={preview}", "raw": preview}


def requests_replace_product(
    *,
    product_name: str,
    video_path: str,
    image_path: str,
    prompt_text: str,
    duration_seconds: int | str,
    frame_rate: int | str,
    width: int | str,
    height: int | str,
    api_key: str,
    app_id: str | None = None,
) -> dict:
    app_id_text = str(app_id or "").strip() or DEFAULT_APP_ID
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    api_base = _get_run_api_base(app_id_text, DEFAULT_APP_ID)
    payload = {
        "nodeInfoList": _build_node_info_list(
            video_path=video_path,
            image_path=image_path,
            product_name=product_name,
            prompt_text=prompt_text,
            duration_seconds=duration_seconds,
            frame_rate=frame_rate,
            width=width,
            height=height,
        ),
        "instanceType": "default",
        "usePersonalQueue": False,
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
    product_name: str,
    video_path: str,
    image_path: str,
    prompt_text: str,
    duration_seconds: int | str,
    frame_rate: int | str,
    width: int | str,
    height: int | str,
    video_output_path: str,
    api_key: str,
    app_id: str | None = None,
    stop_requested=None,
    poll_interval_seconds: float = 3.0,
    logger=None,
    progress_callback=None,
) -> dict:
    import runninghub_common

    def _submit():
        return requests_replace_product(
            product_name=product_name,
            video_path=video_path,
            image_path=image_path,
            prompt_text=prompt_text,
            duration_seconds=duration_seconds,
            frame_rate=frame_rate,
            width=width,
            height=height,
            api_key=api_key,
            app_id=app_id,
        )

    result = runninghub_common.retry_submit(_submit, label="商品替换提交", logger=logger)
    task_id = str(result.get("task id") or "").strip()
    if not task_id:
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


def requests_api_2(
    product_name: str,
    video_path: str,
    image_path: str,
    prompt_text: str,
    times: str | int,
    frame_rate: str | int,
    width: str | int,
    height: str | int,
    api_key: str,
) -> dict:
    return requests_api(
        product_name=product_name,
        video_path=video_path,
        image_path=image_path,
        prompt_text=prompt_text,
        duration_seconds=times,
        frame_rate=frame_rate,
        width=width,
        height=height,
        video_output_path=os.path.abspath("./outputs_tiktok_replace/product_replace.mp4"),
        api_key=api_key,
    )


if __name__ == "__main__":
    api_key = os.getenv("RUNNINGHUB_API_KEY", "")
    if not api_key:
        raise ValueError("请设置环境变量 RUNNINGHUB_API_KEY")
    product_name = "保温杯"
    video_path = "http://114.55.151.179:8000/scene/Wanimate_00001_p84-audio_uspqg_1772098626.mp4"
    image_path = "http://114.55.151.179:8000/scene/img.png"
    prompt_text = "一个女人在卖水杯"
    times = 15
    frame_rate = 30
    width = "576"
    height = "1024"
    result = requests_api(
        product_name=product_name,
        video_path=video_path,
        image_path=image_path,
        prompt_text=prompt_text,
        duration_seconds=times,
        frame_rate=frame_rate,
        width=width,
        height=height,
        video_output_path=os.path.abspath("./outputs_tiktok_replace/product_replace.mp4"),
        api_key=api_key,
    )
    print(result)
