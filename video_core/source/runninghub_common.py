import json
import os
from pathlib import Path
import requests
import time
from typing import Any
from urllib.parse import urlparse

import certifi


BASE_URL = "https://www.runninghub.ai/"
DEFAULT_PLUS_WORKFLOW_IDS = {"1977634608437174274", "1958162038503649281", "2068273204367544322"}


def _is_runninghub_https(url: str) -> bool:
    try:
        parsed = urlparse(str(url or "").strip())
    except Exception:
        return False
    host = str(parsed.hostname or "").strip().lower()
    return parsed.scheme.lower() == "https" and (
        host == "runninghub.ai"
        or host.endswith(".runninghub.ai")
    )


def _resolve_ca_bundle() -> str:
    override = str(os.getenv("RH_CA_BUNDLE", "") or "").strip()
    if override:
        return override
    return certifi.where()


def configure_requests_ca_bundle() -> None:
    bundle = _resolve_ca_bundle()
    if not str(bundle).strip():
        return
    os.environ.setdefault("REQUESTS_CA_BUNDLE", bundle)
    os.environ.setdefault("SSL_CERT_FILE", bundle)


def _prepare_request_kwargs(url: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    options = dict(kwargs or {})
    if "verify" not in options and _is_runninghub_https(url):
        options["verify"] = _resolve_ca_bundle()
    return options


def rh_request(method: str, url: str, **kwargs):
    return requests.request(method=str(method).upper(), url=url, **_prepare_request_kwargs(url, kwargs))


def rh_get(url: str, **kwargs):
    return rh_request("GET", url, **kwargs)


def rh_post(url: str, **kwargs):
    return rh_request("POST", url, **kwargs)


configure_requests_ca_bundle()


def cancel_task(*, task_id: str, api_key: str, base_url: str | None = None) -> dict[str, Any]:
    task_id_text = str(task_id or "").strip()
    api_key_text = str(api_key or "").strip()
    if not task_id_text:
        return {"ok": False, "task_id": "", "message": "RunningHub taskId 为空"}
    if not api_key_text:
        return {"ok": False, "task_id": task_id_text, "message": "RunningHub API Key 为空，无法取消云端任务"}
    root = str(base_url or BASE_URL).rstrip("/")
    url = f"{root}/task/openapi/cancel"
    try:
        response = rh_post(
            url,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key_text}"},
            data=json.dumps({"apiKey": api_key_text, "taskId": task_id_text}, ensure_ascii=False),
            timeout=30,
        )
        response.raise_for_status()
        body = response.json()
    except Exception as exc:
        return {"ok": False, "task_id": task_id_text, "message": f"RunningHub 取消请求失败: {exc}"}
    code = str(body.get("code") if isinstance(body, dict) else "").strip()
    msg = str(body.get("msg") or body.get("message") or "" if isinstance(body, dict) else "").strip()
    ok = code in {"", "0", "200"} or msg.lower() == "success"
    return {"ok": ok, "task_id": task_id_text, "message": msg or ("success" if ok else _safe_json_preview(body)), "raw": body}


def _safe_json_preview(value: Any, limit: int = 600) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    text = text.replace("\n", " ").replace("\r", " ")
    return text[: max(int(limit), 50)]


def _transient_collect_response(*, message: str, progress: Any, raw: dict[str, Any], file_url: str = "") -> dict[str, Any]:
    payload = raw if isinstance(raw, dict) else {}
    return {
        "status": "RUNNING",
        "progress": progress,
        "message": str(message or "RunningHub 任务已成功，正在重试收回结果"),
        "raw": {
            **payload,
            "transient_collect_error": True,
            "file_url": str(file_url or "").strip(),
        },
    }


def is_queue_limit_error(value: Any) -> bool:
    if isinstance(value, dict) and isinstance(value.get("raw"), dict):
        value = value.get("raw")
    if not isinstance(value, dict):
        return False
    code = str(value.get("code") or "").strip()
    err_code = str(value.get("errorCode") or "").strip()
    msg = str(value.get("msg") or value.get("errorMessage") or value.get("message") or "").lower()
    if code in {"421", "429"} or err_code in {"421", "429"}:
        return True
    if code in {"414"} or err_code in {"414"}:
        if ("unknown error" in msg) or ("请重试" in msg) or ("retry" in msg):
            return True
    return ("limit reached" in msg) or ("并发" in msg) or ("retry later" in msg) or ("queue limit" in msg)


def _split_id_list(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        items = list(value)
    else:
        items = str(value or "").replace(";", ",").split(",")
    result: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def plus_workflow_ids() -> set[str]:
    configured = set(_split_id_list(os.getenv("RUNNINGHUB_PLUS_WORKFLOW_IDS", "")))
    return DEFAULT_PLUS_WORKFLOW_IDS | configured


def instance_type_for_workflow(app_id: Any, requested: Any = None) -> str:
    requested_text = str(requested or "").strip()
    app_id_text = str(app_id or "").strip()
    if app_id_text and app_id_text in plus_workflow_ids():
        if requested_text and requested_text.lower() not in {"default", "normal"}:
            return requested_text
        return "plus"
    if requested_text:
        return requested_text
    return "default"


def retry_submit(
    submit_fn,
    *,
    label: str,
    logger=None,
    max_retries: int | None = None,
    base_sleep_seconds: float | None = None,
    cancellation_check=None,
) -> Any:
    tries = max_retries
    if tries is None:
        tries = int(str(os.getenv("RH_SUBMIT_RETRIES", "120") or "120").strip() or "120")
    base = base_sleep_seconds
    if base is None:
        base = float(str(os.getenv("RH_SUBMIT_BASE_SLEEP", "2.0") or "2.0").strip() or "2.0")

    tries = max(int(tries), 0)
    attempt = 0
    while True:
        attempt += 1
        if callable(cancellation_check):
            cancellation_check()
        res = submit_fn()
        if callable(cancellation_check):
            cancellation_check()
        if not is_queue_limit_error(res):
            return res
        if attempt > tries:
            return res
        sleep_s = min(float(base) * (1.35 ** (attempt - 1)), 30.0)
        _log(logger, f"RunningHub {label} 触发并发限制，等待 {sleep_s:.1f}s 后重试（{attempt}/{tries}）")
        remaining = max(sleep_s, 0.5)
        while remaining > 0:
            if callable(cancellation_check):
                cancellation_check()
            step = min(remaining, 1.0)
            time.sleep(step)
            remaining -= step


def _log(logger, message: str) -> None:
    if logger is None:
        print(message)
        return
    try:
        logger(message)
    except Exception:
        print(message)


def _extract_task_id(payload: dict) -> str:
    for key in ("task_id", "task id", "taskId", "taskID"):
        value = payload.get(key)
        if value:
            text = str(value).strip()
            if text:
                return text
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("task_id", "task id", "taskId", "taskID"):
            value = data.get(key)
            if value:
                text = str(value).strip()
                if text:
                    return text
    return ""


def _normalize_submit_result(raw: object) -> dict:
    if not isinstance(raw, dict):
        return {"status": "failed", "task_id": "", "message": f"Invalid submit result: {raw}", "raw": raw}

    task_id = _extract_task_id(raw)
    status = str(raw.get("status") or "").strip() or ("RUNNING" if task_id else "FAILED")
    return {
        "status": status,
        "task id": task_id,
        "task_id": task_id,
        "taskId": task_id,
        "message": str(raw.get("errorMessage") or raw.get("message") or "").strip(),
        "raw": raw,
    }


def _get_run_api_base(app_id: str | None, default_app_id: str) -> str:
    app_id_text = str(app_id or "").strip() or str(default_app_id or "").strip()
    return f"openapi/v2/run/ai-app/{app_id_text}"


def _extract_progress(data: dict) -> float | None:
    def _to_percent(value) -> float | None:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            num = float(value)
            if 0.0 <= num <= 1.0:
                return num * 100.0
            if 0.0 <= num <= 100.0:
                return num
            return None
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("%"):
            text = text[:-1].strip()
        try:
            num = float(text)
        except Exception:
            return None
        if 0.0 <= num <= 1.0:
            return num * 100.0
        if 0.0 <= num <= 100.0:
            return num
        return None

    candidates = [
        data.get("progress"),
        data.get("percent"),
        data.get("percentage"),
        data.get("taskProgress"),
        data.get("task_progress"),
        data.get("process"),
        data.get("stepProgress"),
        data.get("step_progress"),
    ]
    for cand in candidates:
        pct = _to_percent(cand)
        if pct is not None:
            return pct

    payload = data.get("data") or data.get("result") or {}
    if isinstance(payload, dict):
        for cand in [
            payload.get("progress"),
            payload.get("percent"),
            payload.get("percentage"),
            payload.get("taskProgress"),
            payload.get("task_progress"),
            payload.get("process"),
        ]:
            pct = _to_percent(cand)
            if pct is not None:
                return pct
    return None


def download_file(file_url: str, output_path: str) -> bool:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = rh_get(file_url, stream=True, timeout=(10, 180))
            response.raise_for_status()
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "wb") as output_file:
                for chunk in response.iter_content(chunk_size=8192):
                    output_file.write(chunk)
            return True
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                sleep_s = min(2.0 * attempt, 5.0)
                time.sleep(sleep_s)
    raise RuntimeError(f"文件下载失败: {last_error}")


def download_video(video_url: str, video_output_path: str) -> bool:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = rh_get(video_url, stream=True, timeout=(10, 180))
            response.raise_for_status()
            with open(video_output_path, "wb") as video_file:
                for chunk in response.iter_content(chunk_size=8192):
                    video_file.write(chunk)
            print(f"视频已成功下载到: {video_output_path}")
            return True
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                sleep_s = min(2.0 * attempt, 5.0)
                time.sleep(sleep_s)
    raise RuntimeError(f"视频下载失败: {last_error}")


def query_task(*, task_id: str, api_key: str, video_output_path: str, base_url: str = BASE_URL) -> dict:
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    query_url = f"{str(base_url).rstrip('/')}/openapi/v2/query"
    query_data = {"taskId": str(task_id)}
    try:
        response = rh_post(query_url, headers=headers, data=json.dumps(query_data), timeout=(10, 120))
    except requests.exceptions.RequestException as exc:
        return {
            "status": "RUNNING",
            "progress": None,
            "message": f"query_task 临时网络异常，稍后重试: {str(exc)}",
            "raw": {"exception": str(exc)},
        }
    try:
        query_result = response.json()
    except Exception:
        status_code = int(getattr(response, "status_code", 0) or 0)
        preview = str(getattr(response, "text", "") or "")[:1000]
        return {
            "status": "RUNNING",
            "progress": None,
            "message": f"RunningHub 查询暂时返回非 JSON，稍后重试: status={status_code} preview={preview[:300]}",
            "raw": {"status_code": status_code, "text": preview, "transient_query_error": True},
        }
    if isinstance(query_result, dict) and "code" in query_result and int(query_result.get("code") or 0) != 0:
        return {
            "status": "failed",
            "progress": None,
            "message": f"RunningHub API 返回错误: code={query_result.get('code')} msg={query_result.get('msg')} preview={_safe_json_preview(query_result)}",
            "raw": query_result,
        }

    status = (
        query_result.get("status")
        or query_result.get("taskStatus")
        or query_result.get("task_status")
        or query_result.get("state")
    )
    status = str(status).strip() if status is not None else ""
    status_upper = status.upper()
    progress = _extract_progress(query_result) if isinstance(query_result, dict) else None

    if status_upper == "SUCCESS":
        results = query_result.get("results") or []
        video_formats = {"mp4", "mov", "avi", "mkv", "flv", "wmv", "webm"}
        image_formats = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"}
        if isinstance(results, list):
            for entry in results:
                if not isinstance(entry, dict):
                    continue
                file_url = str(entry.get("url", "")).strip()
                format_name = str(entry.get("outputType", "")).strip().lower()
                if not file_url:
                    continue
                if format_name in video_formats:
                    try:
                        download_video(video_url=file_url, video_output_path=video_output_path)
                        return {
                            "message": "[*] Video Download successfully!"
                                       f"    Video path: {video_output_path}"
                                       f"    Video format: {format_name}"
                                       f"    Video URL: {file_url}",
                            "status": "success",
                            "progress": 100.0,
                            "raw": query_result,
                        }
                    except Exception as e:
                        return _transient_collect_response(
                            message=(
                                "[*] Video download failed; RunningHub task is SUCCESS, "
                                f"will retry collection. Video URL: {file_url} Error: {e}"
                            ),
                            progress=progress,
                            raw=query_result,
                            file_url=file_url,
                        )
                if format_name in image_formats or (not format_name and file_url.lower().endswith(tuple('.' + x for x in image_formats))):
                    try:
                        download_file(file_url=file_url, output_path=video_output_path)
                        return {
                            "message": "[*] Image Download successfully!"
                                       f"    Image path: {video_output_path}"
                                       f"    Image format: {format_name or 'image'}"
                                       f"    Image URL: {file_url}",
                            "status": "success",
                            "progress": 100.0,
                            "raw": query_result,
                        }
                    except Exception as e:
                        return _transient_collect_response(
                            message=(
                                "[*] Image download failed; RunningHub task is SUCCESS, "
                                f"will retry collection. Image URL: {file_url} Error: {e}"
                            ),
                            progress=progress,
                            raw=query_result,
                            file_url=file_url,
                        )

        return _transient_collect_response(
            message="[*] Task SUCCESS but downloadable media result is not ready; will retry collection.",
            progress=progress,
            raw=query_result,
        )

    if status_upper == "FAILED":
        failed_reason = query_result.get("failedReason") if isinstance(query_result, dict) else None
        reason_preview = ""
        if isinstance(failed_reason, dict):
            node_name = str(failed_reason.get("node_name") or "").strip()
            node_id = str(failed_reason.get("node_id") or "").strip()
            exception_type = str(failed_reason.get("exception_type") or "").strip()
            exception_message = str(failed_reason.get("exception_message") or "").strip()
            if node_name or exception_message:
                reason_preview = (
                    f" node={node_name or 'unknown'}"
                    f" node_id={node_id or 'unknown'}"
                    f" exc={exception_type or 'unknown'}"
                    f" msg={exception_message or 'unknown'}"
                )
        return {
            "message": "[*] Failed, there is a problem with the workflow！"
                       f"   Error Code: {query_result.get('errorCode')}"
                       f"   Error Information: \n{query_result.get('errorMessage')}{reason_preview}",
            "status": "failed",
            "progress": progress,
            "raw": query_result,
        }

    if status_upper in {"QUEUED", "RUNNING", "PENDING", "CREATED"}:
        err = str(query_result.get("errorMessage") or "").strip()
        msg = f"task_status={status}"
        if progress is not None:
            msg = f"{msg} progress={progress:.1f}%"
        if err:
            msg = f"{msg} errorMessage={err[:200]}"
        return {
            "status": status,
            "progress": progress,
            "message": msg,
            "raw": query_result,
        }

    return {
        "status": status or "UNKNOWN",
        "progress": progress,
        "message": (
            f"query_task 返回未识别状态: {status or 'UNKNOWN'} | "
            f"errorCode={query_result.get('errorCode')} | "
            f"errorMessage={str(query_result.get('errorMessage') or '')[:200]} | "
            f"preview={_safe_json_preview(query_result)}"
        ),
        "raw": query_result,
    }
