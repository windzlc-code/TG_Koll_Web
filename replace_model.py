import json
import os
import time

import requests

from runninghub_common import BASE_URL, _get_run_api_base, _log, _normalize_submit_result, _safe_json_preview, query_task, rh_post


DEFAULT_APP_ID = "2028374986792116225"
LEGACY_DEFAULT_APP_ID = "1977634608437174274"
PREVIOUS_DEFAULT_APP_ID = "2003460864864886785"
PRIMARY_APP_ID = "2047889041936355329"
SLICE_APP_ID = "1955095782514987010"
MOTION_TRANSFER_APP_ID = PRIMARY_APP_ID

MODE_ORIGINAL = "original"
MODE_PRIMARY = "primary"
MODE_SLICE = "slice"
MODE_MOTION_TRANSFER = "motion_transfer"
VALID_MODES = {MODE_ORIGINAL, MODE_PRIMARY, MODE_SLICE, MODE_MOTION_TRANSFER}


def normalize_app_id(app_id: str | None) -> str:
    app_id_text = str(app_id or "").strip()
    if not app_id_text:
        return DEFAULT_APP_ID
    return app_id_text


def normalize_mode(mode: str | None) -> str:
    text = str(mode or "").strip().lower()
    if text in VALID_MODES:
        return text
    return MODE_ORIGINAL


def _build_original_node_info_list(
    *,
    app_id_text: str,
    video_path: str,
    image_path: str,
    prompt: str,
    width: int,
    height: int,
    frame: int,
    duration_seconds: int | None,
) -> list[dict]:
    if app_id_text == DEFAULT_APP_ID:
        dur = int(duration_seconds or 10)
        dur = max(dur, 1)
        frame_value = max(int(frame or 0), 1)
        max_resolution = max(int(width or 0), int(height or 0), 1)
        return [
            {"nodeId": "172", "fieldName": "video", "fieldValue": f"{video_path}", "description": "video"},
            {"nodeId": "149", "fieldName": "image", "fieldValue": f"{image_path}", "description": "image"},
            {"nodeId": "135", "fieldName": "value", "fieldValue": f"{frame_value}", "description": "value"},
            {"nodeId": "154", "fieldName": "value", "fieldValue": f"{dur}", "description": "value"},
            {"nodeId": "145", "fieldName": "value", "fieldValue": f"{max_resolution}", "description": "value"},
            {"nodeId": "170", "fieldName": "text", "fieldValue": f"{prompt}", "description": "text"},
        ]
    if app_id_text == LEGACY_DEFAULT_APP_ID:
        dur = int(duration_seconds or 10)
        dur = max(dur, 1)
        return [
            {"nodeId": "63", "fieldName": "video", "fieldValue": f"{video_path}", "description": "请导入视频"},
            {"nodeId": "193", "fieldName": "image", "fieldValue": f"{image_path}", "description": "请导入图片"},
            {"nodeId": "214", "fieldName": "value", "fieldValue": f"{dur}", "description": "生成的视频时长（秒）"},
            {"nodeId": "217", "fieldName": "text", "fieldValue": f"{prompt}", "description": "请输入大概动作提示词"},
            {"nodeId": "274", "fieldName": "int", "fieldValue": f"{frame}", "description": "视频帧率"},
            {"nodeId": "215", "fieldName": "value", "fieldValue": f"{width}", "description": "视频宽度"},
            {"nodeId": "216", "fieldName": "value", "fieldValue": f"{height}", "description": "视频高度"},
        ]
    if app_id_text == "1955905139297144834":
        dur = int(duration_seconds or 10)
        dur = max(dur, 1)
        return [
            {"nodeId": "352", "fieldName": "video", "fieldValue": f"{video_path}", "description": "请上传视频"},
            {"nodeId": "318", "fieldName": "image", "fieldValue": f"{image_path}", "description": "请上传图片"},
            {"nodeId": "339", "fieldName": "int", "fieldValue": f"{dur}", "description": "生成视频的时长（秒）"},
            {"nodeId": "329", "fieldName": "text", "fieldValue": f"{prompt}", "description": "提示词"},
            {"nodeId": "346", "fieldName": "int", "fieldValue": f"{frame}", "description": "帧率"},
            {"nodeId": "267", "fieldName": "int", "fieldValue": f"{width}", "description": "视频宽度"},
            {"nodeId": "268", "fieldName": "int", "fieldValue": f"{height}", "description": "视频高度"},
        ]

    return [
        {"nodeId": "188", "fieldName": "video", "fieldValue": f"{video_path}", "description": "请导入视频"},
        {"nodeId": "57", "fieldName": "image", "fieldValue": f"{image_path}", "description": "请导入图片"},
        {"nodeId": "197", "fieldName": "text", "fieldValue": f"{prompt}", "description": "请设置大概的提示词"},
        {"nodeId": "191", "fieldName": "int", "fieldValue": f"{frame}", "description": "视频帧率"},
        {"nodeId": "371", "fieldName": "int", "fieldValue": f"{width}", "description": "视频宽度"},
        {"nodeId": "372", "fieldName": "int", "fieldValue": f"{height}", "description": "视频高度"},
    ]


def _build_primary_node_info_list(*, video_path: str, image_path: str, width: int, height: int) -> list[dict]:
    return [
        {"nodeId": "55", "fieldName": "image", "fieldValue": f"{image_path}", "description": "image"},
        {"nodeId": "60", "fieldName": "video", "fieldValue": f"{video_path}", "description": "video"},
        {"nodeId": "43", "fieldName": "value", "fieldValue": f"{max(int(width or 0), 1)}", "description": "value"},
        {"nodeId": "49", "fieldName": "value", "fieldValue": f"{max(int(height or 0), 1)}", "description": "value"},
    ]


def _build_slice_node_info_list(
    *,
    video_path: str,
    image_path: str,
    prompt: str,
    duration_seconds: int | None,
    start_seconds: int | None,
) -> list[dict]:
    dur = max(int(duration_seconds or 5), 1)
    start = max(int(start_seconds or 0), 0)
    return [
        {"nodeId": "352", "fieldName": "video", "fieldValue": f"{video_path}", "description": "上传视频"},
        {"nodeId": "318", "fieldName": "image", "fieldValue": f"{image_path}", "description": "上传参考人物"},
        {"nodeId": "284", "fieldName": "text", "fieldValue": f"{prompt}", "description": "描述人物行为"},
        {"nodeId": "339", "fieldName": "int", "fieldValue": f"{dur}", "description": "生成的时长（秒）"},
        {"nodeId": "341", "fieldName": "int", "fieldValue": f"{start}", "description": "从第几秒后开始(秒）"},
    ]


def _build_node_info_list(
    *,
    mode: str | None,
    app_id: str | None,
    video_path: str,
    image_path: str,
    prompt: str,
    width: int,
    height: int,
    frame: int,
    duration_seconds: int | None,
    start_seconds: int | None = None,
) -> list[dict]:
    normalized_mode = normalize_mode(mode)
    app_id_text = normalize_app_id(app_id)
    if normalized_mode == MODE_PRIMARY:
        return _build_primary_node_info_list(video_path=video_path, image_path=image_path, width=width, height=height)
    if normalized_mode == MODE_SLICE:
        return _build_slice_node_info_list(
            video_path=video_path,
            image_path=image_path,
            prompt=prompt,
            duration_seconds=duration_seconds,
            start_seconds=start_seconds,
        )
    if normalized_mode == MODE_MOTION_TRANSFER:
        return _build_primary_node_info_list(video_path=video_path, image_path=image_path, width=width, height=height)
    return _build_original_node_info_list(
        app_id_text=app_id_text,
        video_path=video_path,
        image_path=image_path,
        prompt=prompt,
        width=width,
        height=height,
        frame=frame,
        duration_seconds=duration_seconds,
    )


def _parse_json_response(response) -> dict:
    try:
        return response.json()
    except ValueError as exc:
        preview = str(getattr(response, "text", "") or "")[:500]
        return {"status": "failed", "message": f"响应解析失败: {exc}; preview={preview}", "raw": preview}


def requests_replace_model(
    prompt,
    video_path,
    image_path,
    width,
    height,
    frame,
    api_key,
    app_id: str | None = None,
    duration_seconds: int | None = None,
    mode: str | None = None,
    start_seconds: int | None = None,
):
    app_id_text = normalize_app_id(app_id)
    mode_text = normalize_mode(mode)
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }

    api_base = _get_run_api_base(app_id_text, DEFAULT_APP_ID)
    data = {
        "nodeInfoList": _build_node_info_list(
            mode=mode_text,
            app_id=app_id_text,
            video_path=video_path,
            image_path=image_path,
            prompt=prompt,
            width=int(width or 0),
            height=int(height or 0),
            frame=int(frame or 0),
            duration_seconds=duration_seconds,
            start_seconds=start_seconds,
        ),
        "instanceType": "default",
        "usePersonalQueue": False
    }

    response = rh_post(str(BASE_URL).rstrip("/") + "/" + api_base, headers=headers, data=json.dumps(data))
    requests_result = _parse_json_response(response)

    if isinstance(requests_result, dict) and "code" in requests_result and int(requests_result.get("code") or 0) != 0:
        return {
            "status": "failed",
            "message": (
                f"RunningHub API 返回错误: code={requests_result.get('code')} msg={requests_result.get('msg')} "
                f"app_id={app_id_text} preview={_safe_json_preview(requests_result)}"
            ),
            "raw": requests_result,
        }
    normalized = _normalize_submit_result(requests_result)
    if not normalized.get("message"):
        normalized["message"] = f"submit status={normalized.get('status')} task_id={normalized.get('task id')}"
    return normalized


def requests_api(
        prompt,
        video_path,
        image_path,
        width,
        height,
        frame,
        video_output_path,
        api_key,
        app_id: str | None = None,
        duration_seconds=None,
        mode: str | None = None,
        start_seconds: int | None = None,
        stop_requested=None,
        poll_interval_seconds: float = 3.0,
        logger=None,
        progress_callback=None,
    ):
    # 调用替换模型接口
    import runninghub_common

    def _submit():
        return requests_replace_model(
            prompt=prompt,
            video_path=video_path,
            image_path=image_path,
            width=width,
            height=height,
            frame=frame,
            api_key=api_key,
            app_id=app_id,
            duration_seconds=duration_seconds,
            mode=mode,
            start_seconds=start_seconds,
        )

    result = runninghub_common.retry_submit(_submit, label="模特替换提交", logger=logger)

    # 检查任务是否成功启动
    if "task id" not in result:
        _log(logger, _safe_json_preview(result))
        return result

    task_id = str(result.get("task id") or "").strip()
    if not task_id:
        message = str(result.get("message") or "").strip()
        if not message:
            message = f"提交任务失败，未返回 task_id: {_safe_json_preview(result)}"
        _log(logger, message)
        try:
            result["status"] = "failed"
            result["message"] = message
        except Exception:
            pass
        return result
    submit_status = str(result.get("status") or "").strip().upper() or "RUNNING"
    _log(logger, f"task id: {task_id}")
    _log(logger, "task status:")
    _log(logger, f"[*] {submit_status}")

    # 用于记录上次打印的状态，避免重复打印
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
            try:
                task_progress["task_id"] = str(task_id)
            except Exception:
                pass
            _log(logger, "[*] SUCCESS")
            return task_progress
        elif status == "failed":
            try:
                task_progress["task_id"] = str(task_id)
            except Exception:
                pass
            _log(logger, "[*] FAILED")
            return task_progress
        elif status == "QUEUED":
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
        
        # 添加延时，避免过于频繁的查询
        time.sleep(max(float(poll_interval_seconds or 0.0), 0.5))


if __name__ == "__main__":
    # 示例参数
    prompt = "1个中国美女在跳舞"
    video_path = "http://114.55.151.179:8000/scene/7422674968044948779.mp4"
    image_path = "http://114.55.151.179:8000/scene/7422674968044948779.png"
    width = 576
    height = 1024
    frame = 30
    duration_seconds = 10
    video_output_path = "/Users/tangsong/Python开发/NatSec/工作流接单/outputs_tiktok_replace/xxx.mp4"
    api_key = os.getenv("RUNNINGHUB_API_KEY", "")
    if not api_key:
        raise RuntimeError("请先设置 RUNNINGHUB_API_KEY 环境变量")

    # 调用主函数
    result = requests_api(
        prompt=prompt,
        video_path=video_path,
        image_path=image_path,
        width=width,
        height=height,
        frame=frame,
        video_output_path=video_output_path,
        api_key=api_key
    )

    # 输出结果
    print(result)
