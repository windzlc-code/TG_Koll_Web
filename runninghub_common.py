import json
import os
from pathlib import Path
import requests
import time
from typing import Any
from urllib.parse import urlparse

import certifi


BASE_URL = "https://www.runninghub.cn/"


def _is_runninghub_https(url: str) -> bool:
    try:
        parsed = urlparse(str(url or "").strip())
    except Exception:
        return False
    host = str(parsed.hostname or "").strip().lower()
    return parsed.scheme.lower() == "https" and (host == "runninghub.cn" or host.endswith(".runninghub.cn"))


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


def _safe_json_preview(value: Any, limit: int = 600) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    text = text.replace("\n", " ").replace("\r", " ")
    return text[: max(int(limit), 50)]


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


def retry_submit(
    submit_fn,
    *,
    label: str,
    logger=None,
    max_retries: int | None = None,
    base_sleep_seconds: float | None = None,
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
        res = submit_fn()
        if not is_queue_limit_error(res):
            return res
        if attempt > tries:
            return res
        sleep_s = min(float(base) * (1.35 ** (attempt - 1)), 30.0)
        _log(logger, f"RunningHub {label} 触发并发限制，等待 {sleep_s:.1f}s 后重试（{attempt}/{tries}）")
        time.sleep(max(sleep_s, 0.5))


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
        response = requests.post(
            query_url,
            **_prepare_request_kwargs(
                query_url,
                {"headers": headers, "data": json.dumps(query_data), "timeout": (10, 120)},
            ),
        )
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
        return {
            "status": "failed",
            "progress": None,
            "message": f"RunningHub 查询返回非 JSON: {str(getattr(response, 'text', '') or '')[:300]}",
            "raw": {"text": str(getattr(response, "text", "") or "")[:1000]},
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
                        return {
                            "message": "[*] Video download failed!"
                                       "    Place download it you self"
                                       f"   Video URL: {file_url}"
                                       f"   Error Information: {e}",
                            "status": "failed",
                            "progress": progress,
                            "raw": query_result,
                        }
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
                        return {
                            "message": "[*] Image download failed!"
                                       f"   Image URL: {file_url}"
                                       f"   Error Information: {e}",
                            "status": "failed",
                            "progress": progress,
                            "raw": query_result,
                        }

        return {
            "message": "[*] Task SUCCESS but missing downloadable media result.",
            "status": "failed",
            "progress": progress,
            "raw": query_result,
        }

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
