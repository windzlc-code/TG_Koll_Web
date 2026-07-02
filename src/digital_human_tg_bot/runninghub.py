from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import certifi
import requests


ENGINE_NAME = "智能體引擎"


class WorkflowCancelledError(RuntimeError):
    pass


@dataclass(frozen=True)
class UploadedMedia:
    filename: str
    download_url: str
    media_type: str
    size: int | None


class RunningHubClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://www.runninghub.cn",
        *,
        cancellation_check: Callable[[], None] | None = None,
    ) -> None:
        self.api_key = str(api_key or "").strip()
        if not self.api_key:
            raise RuntimeError("智能體引擎 API Key 未設定")
        self.base_url = str(base_url).rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.api_key}"})
        self.session.verify = self._resolve_ca_bundle()
        self.cancellation_check = cancellation_check

    @staticmethod
    def _resolve_ca_bundle() -> str:
        override = str(os.getenv("RH_CA_BUNDLE") or "").strip()
        if override:
            return override
        return certifi.where()

    def upload_binary(self, file_path: Path) -> UploadedMedia:
        self._check_cancelled()
        if not file_path.exists():
            raise FileNotFoundError(f"找不到上傳檔案: {file_path}")

        with file_path.open("rb") as handle:
            response = self.session.post(
                f"{self.base_url}/openapi/v2/media/upload/binary",
                files={"file": (file_path.name, handle)},
                timeout=120,
            )
        self._check_cancelled()
        response.raise_for_status()
        payload = response.json()
        code = payload.get("code")
        if code not in (0, 200, "0", "200", None):
            raise RuntimeError(f"{ENGINE_NAME} 上傳失敗: {json.dumps(payload, ensure_ascii=False)[:500]}")

        data = payload.get("data") or {}
        filename = str(data.get("filename") or data.get("fileName") or "").strip()
        if not filename:
            raise RuntimeError(f"{ENGINE_NAME} 上傳結果缺少 filename: {json.dumps(payload, ensure_ascii=False)[:500]}")

        download_url = str(data.get("download_url") or data.get("downloadUrl") or "").strip()
        media_type = str(data.get("type") or "").strip()
        try:
            size = int(data.get("size")) if data.get("size") is not None else None
        except (TypeError, ValueError):
            size = None
        return UploadedMedia(
            filename=filename,
            download_url=download_url,
            media_type=media_type,
            size=size,
        )

    def submit_ai_app_task(self, webapp_id: str, node_info_list: list[dict], progress_callback=None) -> str:
        self._check_cancelled()
        payload = {
            "webappId": str(webapp_id),
            "apiKey": self.api_key,
            "nodeInfoList": node_info_list,
        }

        max_retries = 120
        for attempt in range(max_retries + 1):
            self._check_cancelled()
            response = self.session.post(
                f"{self.base_url}/task/openapi/ai-app/run",
                headers={"Content-Type": "application/json"},
                data=json.dumps(payload, ensure_ascii=False),
                timeout=120,
            )
            self._check_cancelled()
            response.raise_for_status()
            body = response.json()
            code = body.get("code")
            if code in (0, "0", None):
                data = body.get("data") or {}
                task_id = str(data.get("taskId") or data.get("task_id") or "").strip()
                if not task_id:
                    raise RuntimeError(f"{ENGINE_NAME} 任務提交結果缺少 taskId: {json.dumps(body, ensure_ascii=False)[:500]}")
                return task_id

            if self._is_queue_limit_error(body) and attempt < max_retries:
                sleep_seconds = min(2.0 * (1.25**attempt), 30.0)
                if progress_callback is not None:
                    progress_callback(
                        f"{ENGINE_NAME} 目前繁忙，{sleep_seconds:.1f} 秒後自動重試 ({attempt + 1}/{max_retries})"
                    )
                self._sleep_with_cancellation(max(sleep_seconds, 1.0))
                continue

            raise RuntimeError(f"{ENGINE_NAME} 任務提交失敗: {json.dumps(body, ensure_ascii=False)[:500]}")

        raise RuntimeError(f"{ENGINE_NAME} 任務提交失敗: 已超過重試次數")

    def query_task(self, task_id: str) -> dict:
        self._check_cancelled()
        response = self.session.post(
            f"{self.base_url}/openapi/v2/query",
            headers={"Content-Type": "application/json"},
            data=json.dumps({"taskId": str(task_id)}),
            timeout=120,
        )
        self._check_cancelled()
        response.raise_for_status()
        return response.json()

    def wait_for_task(
        self,
        task_id: str,
        *,
        poll_interval_seconds: float = 5.0,
        progress_callback=None,
    ) -> dict:
        last_state = ""
        last_progress_bucket = -1

        while True:
            self._check_cancelled()
            payload = self.query_task(task_id)
            code = payload.get("code")
            if code not in (0, 200, "0", "200", None):
                raise RuntimeError(f"{ENGINE_NAME} 查詢任務失敗: {json.dumps(payload, ensure_ascii=False)[:500]}")

            status = str(
                payload.get("status")
                or payload.get("taskStatus")
                or payload.get("task_status")
                or payload.get("state")
                or ""
            ).strip().upper()

            progress = self._extract_progress_percent(payload)
            if progress_callback is not None:
                if status != last_state:
                    progress_callback(f"{ENGINE_NAME} 狀態更新: {status or 'UNKNOWN'}")
                    last_state = status
                if progress is not None:
                    bucket = int(progress // 10)
                    if bucket != last_progress_bucket:
                        progress_callback(f"{ENGINE_NAME} 進度: {progress:.1f}%")
                        last_progress_bucket = bucket

            if status == "SUCCESS":
                return payload
            if status == "FAILED":
                message = str(payload.get("errorMessage") or payload.get("msg") or "").strip()
                detail = self._format_failed_reason(payload)
                if detail:
                    message = f"{message} | {detail}" if message else detail
                raise RuntimeError(f"{ENGINE_NAME} 任務執行失敗: {message or json.dumps(payload, ensure_ascii=False)[:500]}")

            self._sleep_with_cancellation(max(float(poll_interval_seconds or 0.0), 1.0))

    def download_first_result(
        self,
        payload: dict,
        output_path: Path,
        *,
        preferred_output_types: Iterable[str] | None = None,
    ) -> Path:
        results = payload.get("results") or []
        if not isinstance(results, list) or not results:
            raise RuntimeError(f"{ENGINE_NAME} 任務結果為空: {json.dumps(payload, ensure_ascii=False)[:500]}")

        preferred = {str(item).lower() for item in (preferred_output_types or [])}
        selected = None
        for item in results:
            if not isinstance(item, dict):
                continue
            output_type = str(item.get("outputType") or "").strip().lower()
            url = str(item.get("url") or "").strip()
            if not url:
                continue
            if preferred and output_type in preferred:
                selected = item
                break
            if selected is None:
                selected = item

        if selected is None:
            raise RuntimeError(f"{ENGINE_NAME} 找不到可下載結果: {json.dumps(payload, ensure_ascii=False)[:500]}")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        file_url = str(selected.get("url") or "").strip()
        self._check_cancelled()
        response = self.session.get(file_url, stream=True, timeout=(20, 300))
        self._check_cancelled()
        response.raise_for_status()
        try:
            with output_path.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    self._check_cancelled()
                    if chunk:
                        handle.write(chunk)
        except WorkflowCancelledError:
            if output_path.exists():
                output_path.unlink(missing_ok=True)
            raise
        return output_path

    def _check_cancelled(self) -> None:
        if self.cancellation_check is not None:
            self.cancellation_check()

    def _sleep_with_cancellation(self, seconds: float) -> None:
        remaining = max(float(seconds or 0.0), 0.0)
        while remaining > 0:
            self._check_cancelled()
            step = min(remaining, 1.0)
            time.sleep(step)
            remaining -= step
        self._check_cancelled()

    @staticmethod
    def _is_queue_limit_error(payload: dict) -> bool:
        code = str(payload.get("code") or "").strip()
        msg = str(payload.get("msg") or payload.get("errorMessage") or payload.get("message") or "").strip().lower()
        return code in {"421", "429"} or "task_queue_maxed" in msg or ("queue" in msg and "max" in msg)

    @staticmethod
    def _format_failed_reason(payload: dict) -> str:
        failed_reason = payload.get("failedReason")
        if not isinstance(failed_reason, dict):
            return ""
        node_name = str(failed_reason.get("node_name") or "").strip()
        node_id = str(failed_reason.get("node_id") or "").strip()
        exception_type = str(failed_reason.get("exception_type") or "").strip()
        exception_message = str(failed_reason.get("exception_message") or "").strip()
        parts = []
        if node_name:
            parts.append(f"node={node_name}")
        if node_id:
            parts.append(f"node_id={node_id}")
        if exception_type:
            parts.append(f"exc={exception_type}")
        if exception_message:
            parts.append(f"detail={exception_message}")
        return " | ".join(parts)

    @staticmethod
    def _extract_progress_percent(payload: dict) -> float | None:
        candidates = [
            payload.get("progress"),
            payload.get("percent"),
            payload.get("percentage"),
            payload.get("taskProgress"),
            payload.get("task_progress"),
            payload.get("process"),
        ]
        for item in candidates:
            if item is None:
                continue
            if isinstance(item, (int, float)):
                value = float(item)
            else:
                text = str(item).strip().rstrip("%")
                try:
                    value = float(text)
                except ValueError:
                    continue
            if 0.0 <= value <= 1.0:
                return value * 100.0
            if 0.0 <= value <= 100.0:
                return value
        return None
