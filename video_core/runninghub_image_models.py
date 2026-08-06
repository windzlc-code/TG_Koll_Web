from __future__ import annotations

import json
import mimetypes
import re
import time
from collections.abc import Callable, Mapping, MutableMapping, Sequence
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urljoin

import requests

from .contracts import VideoTaskCancelled, VideoTaskContext


GPT_IMAGE2_MODEL_ID = "gpt image 2"
NANO_BANANA2_MODEL_ID = "nano banana 2"
NANO_BANANA_PRO_MODEL_ID = "nano banana pro"
GPT_IMAGE2_OFFICIAL_MODEL_ID = "openai/gpt-image-2-official"
NANO_BANANA2_OFFICIAL_MODEL_ID = "google/nano-banana-2-official"
NANO_BANANA_PRO_OFFICIAL_MODEL_ID = "google/nano-banana-pro-official"

DEFAULT_BASE_URL = "https://www.runninghub.ai"
STATUS_PATH = "/openapi/v2/query"
UPLOAD_PATH = "/openapi/v2/media/upload/binary"

MODEL_CONFIGS: dict[str, dict[str, str]] = {
    GPT_IMAGE2_MODEL_ID: {
        "text_to_image_path": "/openapi/v2/rhart-image-g-2/text-to-image",
        "image_to_image_path": "/openapi/v2/rhart-image-g-2/image-to-image",
    },
    GPT_IMAGE2_OFFICIAL_MODEL_ID: {
        "text_to_image_path": "/openapi/v2/rhart-image-g-2-official/text-to-image",
        "image_to_image_path": "/openapi/v2/rhart-image-g-2-official/image-to-image",
    },
    NANO_BANANA2_MODEL_ID: {
        "text_to_image_path": "/openapi/v2/rhart-image-n-g31-flash/text-to-image",
        "image_to_image_path": "/openapi/v2/rhart-image-n-g31-flash/image-to-image",
    },
    NANO_BANANA2_OFFICIAL_MODEL_ID: {
        "text_to_image_path": "/openapi/v2/rhart-image-n-g31-flash-official/text-to-image",
        "image_to_image_path": "/openapi/v2/rhart-image-n-g31-flash-official/image-to-image",
    },
    NANO_BANANA_PRO_MODEL_ID: {
        "text_to_image_path": "/openapi/v2/rhart-image-n-pro/text-to-image",
        "image_to_image_path": "/openapi/v2/rhart-image-n-pro/edit",
    },
    NANO_BANANA_PRO_OFFICIAL_MODEL_ID: {
        "text_to_image_path": "/openapi/v2/rhart-image-n-pro-official/text-to-image",
        "image_to_image_path": "/openapi/v2/rhart-image-n-pro-official/edit",
    },
}

DEFAULT_MODEL_ORDER: tuple[str, ...] = (
    GPT_IMAGE2_MODEL_ID,
    NANO_BANANA2_MODEL_ID,
    NANO_BANANA_PRO_MODEL_ID,
)

_MODEL_ALIASES = {
    "gptimage2": GPT_IMAGE2_MODEL_ID,
    "gpt-image-2": GPT_IMAGE2_MODEL_ID,
    "gpt image 2": GPT_IMAGE2_MODEL_ID,
    "gpt image 2 official": GPT_IMAGE2_OFFICIAL_MODEL_ID,
    GPT_IMAGE2_OFFICIAL_MODEL_ID: GPT_IMAGE2_OFFICIAL_MODEL_ID,
    "nanobanana2": NANO_BANANA2_MODEL_ID,
    "nano-banana-2": NANO_BANANA2_MODEL_ID,
    "nano banana 2": NANO_BANANA2_MODEL_ID,
    "nano banana 2 official": NANO_BANANA2_OFFICIAL_MODEL_ID,
    NANO_BANANA2_OFFICIAL_MODEL_ID: NANO_BANANA2_OFFICIAL_MODEL_ID,
    "nanobananapro": NANO_BANANA_PRO_MODEL_ID,
    "nano-banana-pro": NANO_BANANA_PRO_MODEL_ID,
    "nano banana pro": NANO_BANANA_PRO_MODEL_ID,
    "nano banana pro official": NANO_BANANA_PRO_OFFICIAL_MODEL_ID,
    NANO_BANANA_PRO_OFFICIAL_MODEL_ID: NANO_BANANA_PRO_OFFICIAL_MODEL_ID,
}

_KEY_FIELDS: tuple[str, ...] = (
    "runninghub_enterprise_api_key",
    "runninghub_enterprise_shared_api_key",
    "runninghub_shared_api_key",
    "video_runninghub_enterprise_api_key",
    "video_runninghub_api_key",
    "runninghub_api_key",
    "runninghub_personal_api_key",
)


class RunningHubImageTransport(Protocol):
    """Network boundary used by the adapter and replaced by fakes in tests."""

    def upload_image(
        self,
        *,
        base_url: str,
        api_key: str,
        file_path: Path,
        media_kind: str,
        check_cancelled: Callable[[], None],
    ) -> str: ...

    def submit(self, *, url: str, api_key: str, body: dict[str, Any]) -> dict[str, Any]: ...

    def query(self, *, url: str, api_key: str, task_id: str) -> dict[str, Any]: ...

    def download(
        self,
        *,
        url: str,
        output_path: Path,
        check_cancelled: Callable[[], None],
    ) -> None: ...

    def sleep(self, seconds: float) -> None: ...


def _json_payload(response: Any, label: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception as exc:
        preview = str(getattr(response, "text", "") or "")[:300]
        raise RuntimeError(f"{label} returned non-JSON response: {preview}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} returned an invalid payload: {payload!r}")
    code = payload.get("code")
    if code is not None and str(code).strip() not in {"", "0", "0.0"}:
        raise RuntimeError(f"{label} failed: {json.dumps(payload, ensure_ascii=False)[:600]}")
    return payload


class RequestsRunningHubImageTransport:
    """Default requests-based transport for RunningHub Standard Image APIs."""

    def __init__(self, session: Any = None) -> None:
        self.session = session or requests.Session()
        if hasattr(self.session, "trust_env"):
            self.session.trust_env = False

    def upload_image(
        self,
        *,
        base_url: str,
        api_key: str,
        file_path: Path,
        media_kind: str,
        check_cancelled: Callable[[], None],
    ) -> str:
        mime_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        url = _join_url(base_url, UPLOAD_PATH)
        last_error: Exception | None = None
        for attempt in range(2):
            check_cancelled()
            try:
                with file_path.open("rb") as handle:
                    response = self.session.post(
                        url,
                        headers={"Authorization": f"Bearer {api_key}"},
                        files={"file": (file_path.name, handle, mime_type)},
                        timeout=(10, 120),
                    )
                payload = _json_payload(response, f"RunningHub {media_kind} upload")
                data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
                value = str(
                    data.get("download_url")
                    or data.get("downloadUrl")
                    or data.get("url")
                    or data.get("fileName")
                    or ""
                ).strip()
                if not value:
                    raise RuntimeError(f"RunningHub {media_kind} upload did not return a URL")
                return value if value.startswith(("http://", "https://")) else _join_url(base_url, value)
            except Exception as exc:
                if _is_cancellation(exc):
                    raise
                last_error = exc
                if attempt == 0:
                    self.sleep(1)
                    continue
                raise
        raise RuntimeError(f"RunningHub {media_kind} upload failed: {last_error}")

    def submit(self, *, url: str, api_key: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self.session.post(
            url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            data=json.dumps(body, ensure_ascii=False),
            timeout=(10, 180),
        )
        return _json_payload(response, "RunningHub image submission")

    def query(self, *, url: str, api_key: str, task_id: str) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        body = {"taskId": task_id}
        response = self.session.post(url, headers=headers, data=json.dumps(body), timeout=(10, 120))
        if int(getattr(response, "status_code", 200) or 200) in {404, 405}:
            response = self.session.get(url, headers=headers, params=body, timeout=(10, 120))
        return _json_payload(response, "RunningHub image status query")

    def download(
        self,
        *,
        url: str,
        output_path: Path,
        check_cancelled: Callable[[], None],
    ) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with self.session.get(url, stream=True, timeout=180) as response:
            response.raise_for_status()
            with output_path.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=8192):
                    check_cancelled()
                    if chunk:
                        handle.write(chunk)

    @staticmethod
    def sleep(seconds: float) -> None:
        time.sleep(max(float(seconds), 0.0))


def normalize_model_id(value: Any) -> str:
    """Normalize the original platform's friendly aliases and official IDs."""

    text = str(value or "").strip()
    if text in MODEL_CONFIGS:
        return text
    normalized = re.sub(r"\s+", " ", text.replace("_", "-")).strip().lower()
    return _MODEL_ALIASES.get(normalized, GPT_IMAGE2_MODEL_ID)


def normalize_model_order(value: Any) -> list[str]:
    raw_values: list[Any]
    if isinstance(value, str):
        raw_values = [item for item in re.split(r"[,;\n]+", value) if item.strip()]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_values = list(value)
    elif value is None:
        raw_values = []
    else:
        raw_values = [value]
    models: list[str] = []
    for raw_value in raw_values:
        model = normalize_model_id(raw_value)
        if model in MODEL_CONFIGS and model not in models:
            models.append(model)
    return models or list(DEFAULT_MODEL_ORDER)


def resolve_api_key(payload: Mapping[str, Any] | None) -> str:
    source = payload if isinstance(payload, Mapping) else {}
    for field in _KEY_FIELDS:
        value = str(source.get(field) or "").strip()
        if value:
            return value
    return ""


def _join_url(base_url: str, path: str) -> str:
    return urljoin(f"{str(base_url or DEFAULT_BASE_URL).rstrip('/')}/", str(path or "").lstrip("/"))


def _extract_nested(value: Any, keys: tuple[str, ...]) -> str:
    if isinstance(value, Mapping):
        for key in keys:
            text = str(value.get(key) or "").strip()
            if text:
                return text
        for child in value.values():
            found = _extract_nested(child, keys)
            if found:
                return found
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            found = _extract_nested(child, keys)
            if found:
                return found
    return ""


def _extract_task_id(value: Any) -> str:
    return _extract_nested(value, ("taskId", "task_id", "taskID", "task id", "id"))


def _extract_status(value: Any) -> str:
    return _extract_nested(value, ("status", "taskStatus", "task_status", "state"))


def _extract_image_url(value: Any) -> str:
    image_keys = ("imageUrl", "image_url", "resultUrl", "result_url", "fileUrl", "file_url", "download_url", "url")
    if isinstance(value, Mapping):
        for key in image_keys:
            text = str(value.get(key) or "").strip()
            if not text.startswith(("http://", "https://")):
                continue
            suffix = text.lower().split("?", 1)[0]
            if key != "url" or suffix.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp")):
                return text
        for child in value.values():
            found = _extract_image_url(child)
            if found:
                return found
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            found = _extract_image_url(child)
            if found:
                return found
    elif isinstance(value, str):
        text = value.strip()
        if text.startswith(("http://", "https://")) and text.lower().split("?", 1)[0].endswith(
            (".png", ".jpg", ".jpeg", ".webp", ".bmp")
        ):
            return text
    return ""


def _aspect_ratio(payload: Mapping[str, Any]) -> str:
    value = str(
        payload.get("aspect_ratio")
        or payload.get("image_aspect_ratio")
        or payload.get("ratio")
        or payload.get("output_ratio")
        or ""
    ).strip().lower()
    if value in {"9:16", "16:9", "1:1", "3:4", "4:3", "2:3", "3:2", "21:9"}:
        return value
    if value in {"portrait", "vertical", "竖版"}:
        return "9:16"
    if value in {"landscape", "horizontal", "横版"}:
        return "16:9"
    return "1:1"


def _resolution(payload: Mapping[str, Any]) -> str:
    value = str(
        payload.get("output_size") or payload.get("resolution") or payload.get("image_resolution") or ""
    ).strip().upper()
    if value in {"1K", "2K", "4K"}:
        return value
    if value in {"720P", "1080P", "1440P"}:
        return "2K"
    return "2K"


def _input_paths(values: Sequence[str | Path] | None) -> list[Path]:
    paths: list[Path] = []
    seen: set[str] = set()
    for value in values or ():
        text = str(value or "").strip()
        if not text:
            continue
        path = Path(text).expanduser().resolve()
        key = str(path).lower()
        if key in seen:
            continue
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"RunningHub input image does not exist: {path}")
        if path.stat().st_size <= 0:
            raise RuntimeError(f"RunningHub input image is empty: {path}")
        seen.add(key)
        paths.append(path)
    return paths


def _is_cancellation(exc: BaseException) -> bool:
    return isinstance(exc, VideoTaskCancelled) or "cancel" in type(exc).__name__.lower()


def _check_cancelled(payload: Mapping[str, Any], context: VideoTaskContext | Any) -> None:
    if context is not None and callable(getattr(context, "check_cancelled", None)):
        context.check_cancelled()
    callback = payload.get("_cancel_check")
    if callable(callback):
        callback()


def _log(context: VideoTaskContext | Any, logger: Callable[[str], Any] | None, message: str) -> None:
    if logger is not None:
        logger(message)
    elif context is not None and callable(getattr(context, "log", None)):
        context.log(message)


def _checkpoint_task(payload: Mapping[str, Any], *, stage: str, task_id: str, model: str) -> None:
    callback = payload.get("_checkpoint_video_progress")
    if callable(callback):
        callback(
            task_id=str(payload.get("_task_id") or ""),
            stage=stage,
            runninghub_task_id=task_id,
            provider_model=model,
            message=f"RunningHub image {stage}",
        )


def _register_task(payload: Mapping[str, Any], task_id: str, api_key: str, model: str) -> None:
    if isinstance(payload, MutableMapping):
        payload["runninghub_task_id"] = task_id
        current = payload.get("runninghub_task_ids") if isinstance(payload.get("runninghub_task_ids"), list) else []
        payload["runninghub_task_ids"] = list(dict.fromkeys([*current, task_id]))
    callback = payload.get("_register_runninghub_task")
    if callable(callback):
        callback(
            task_id=str(payload.get("_task_id") or ""),
            runninghub_task_id=task_id,
            api_key=api_key,
        )
    _checkpoint_task(payload, stage="provider_running", task_id=task_id, model=model)


def _generate_one(
    *,
    payload: Mapping[str, Any],
    model: str,
    prompt: str,
    inputs: list[Path],
    output_path: Path,
    context: VideoTaskContext | Any,
    transport: RunningHubImageTransport,
    api_key: str,
    base_url: str,
    logger: Callable[[str], Any] | None,
    poll_interval_seconds: float,
    max_poll_attempts: int,
) -> dict[str, Any]:
    check_cancelled = lambda: _check_cancelled(payload, context)
    check_cancelled()
    image_urls: list[str] = []
    for index, path in enumerate(inputs, start=1):
        check_cancelled()
        image_urls.append(
            transport.upload_image(
                base_url=base_url,
                api_key=api_key,
                file_path=path,
                media_kind=f"runninghub_image_input_{index}",
                check_cancelled=check_cancelled,
            )
        )

    body: dict[str, Any] = {
        "prompt": prompt,
        "aspectRatio": _aspect_ratio(payload),
        "resolution": _resolution(payload),
    }
    if image_urls:
        body["imageUrls"] = image_urls
    instance_type = str(payload.get("instance_type") or payload.get("runninghub_instance_type") or "").strip()
    if instance_type:
        body["instanceType"] = instance_type

    config = MODEL_CONFIGS[model]
    endpoint = config["image_to_image_path" if inputs else "text_to_image_path"]
    resume_task_id = str(payload.get("resume_runninghub_task_id") or "").strip()
    if resume_task_id:
        submitted = {"resumed": True, "taskId": resume_task_id}
        task_id = resume_task_id
    else:
        _log(context, logger, f"RunningHub image submit: {model}")
        check_cancelled()
        submitted = transport.submit(url=_join_url(base_url, endpoint), api_key=api_key, body=body)
        task_id = _extract_task_id(submitted)
    immediate_url = _extract_image_url(submitted)
    if immediate_url and not task_id:
        check_cancelled()
        transport.download(url=immediate_url, output_path=output_path, check_cancelled=check_cancelled)
        return {
            "image_path": str(output_path),
            "download_path": str(output_path),
            "selected_model": model,
            "image_model_used": model,
            "task_id": "",
            "runninghub_task_id": "",
            "runninghub_task_ids": [],
            "image_url": immediate_url,
            "raw_result": {"submit": submitted},
        }
    if not task_id:
        raise RuntimeError(f"RunningHub image submission did not return taskId: {submitted!r}")
    _register_task(payload, task_id, api_key, model)

    status_url = _join_url(base_url, STATUS_PATH)
    last_status: dict[str, Any] = {}
    for _poll_count in range(1, max(int(max_poll_attempts), 1) + 1):
        check_cancelled()
        status_payload = transport.query(url=status_url, api_key=api_key, task_id=task_id)
        last_status = status_payload
        image_url = _extract_image_url(status_payload)
        status = _extract_status(status_payload).strip().lower()
        if image_url:
            check_cancelled()
            transport.download(url=image_url, output_path=output_path, check_cancelled=check_cancelled)
            _checkpoint_task(payload, stage="provider_success", task_id=task_id, model=model)
            return {
                "image_path": str(output_path),
                "download_path": str(output_path),
                "selected_model": model,
                "image_model_used": model,
                "task_id": task_id,
                "runninghub_task_id": task_id,
                "runninghub_task_ids": [task_id],
                "image_url": image_url,
                "raw_result": {"submit": submitted, "status": status_payload},
            }
        if status in {"failed", "fail", "error", "canceled", "cancelled"}:
            _checkpoint_task(payload, stage="provider_failed", task_id=task_id, model=model)
            raise RuntimeError(f"RunningHub image generation failed: {status_payload!r}")
        transport.sleep(max(float(poll_interval_seconds), 0.0))
    raise RuntimeError(f"RunningHub image generation timed out: {last_status!r}")


def generate_image_with_fallback(
    payload: Mapping[str, Any] | None,
    prompt: str,
    input_paths: Sequence[str | Path] | None,
    output_path: str | Path,
    context: VideoTaskContext | Any = None,
    *,
    transport: RunningHubImageTransport | None = None,
    logger: Callable[[str], Any] | None = None,
    poll_interval_seconds: float = 2.0,
    max_poll_attempts: int = 180,
) -> dict[str, Any]:
    """Generate an image through RunningHub and fall back in configured order.

    The function mirrors the original platform's Standard Image API behavior,
    while keeping all provider I/O behind an injectable transport.
    """

    source: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    prompt_text = str(prompt or "").strip()
    if not prompt_text:
        raise ValueError("RunningHub image generation requires a prompt")
    api_key = resolve_api_key(source)
    if not api_key:
        raise RuntimeError("RunningHub image generation requires an API key")
    base_url = str(
        source.get("runninghub_image_base_url")
        or source.get("image_model_provider_base_url")
        or source.get("video_runninghub_base_url")
        or source.get("runninghub_base_url")
        or DEFAULT_BASE_URL
    ).strip().rstrip("/") or DEFAULT_BASE_URL
    requested_models = (
        source.get("image_generate_model")
        or source.get("image_model_priority_order")
        or source.get("image_model_default_model")
        or source.get("image_model_default_model_gemini")
    )
    models = normalize_model_order(requested_models)
    inputs = _input_paths(input_paths)
    target = Path(output_path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    selected_transport = transport or RequestsRunningHubImageTransport()
    attempts: list[dict[str, Any]] = []
    last_error = ""
    for attempt_number, model in enumerate(models, start=1):
        try:
            attempt_payload = source if attempt_number == 1 else dict(source)
            if attempt_number > 1:
                attempt_payload.pop("resume_runninghub_task_id", None)
            result = _generate_one(
                payload=attempt_payload,
                model=model,
                prompt=prompt_text,
                inputs=inputs,
                output_path=target,
                context=context,
                transport=selected_transport,
                api_key=api_key,
                base_url=base_url,
                logger=logger,
                poll_interval_seconds=poll_interval_seconds,
                max_poll_attempts=max_poll_attempts,
            )
            attempts.append(
                {
                    "attempt": attempt_number,
                    "provider": "runninghub",
                    "model": model,
                    "ok": True,
                    "error": "",
                    "task_id": str(result.get("runninghub_task_id") or ""),
                }
            )
            result["ok"] = True
            result["image_model_attempts"] = attempts
            return result
        except Exception as exc:
            if _is_cancellation(exc):
                raise
            last_error = str(exc)
            attempts.append(
                {
                    "attempt": attempt_number,
                    "provider": "runninghub",
                    "model": model,
                    "ok": False,
                    "error": last_error,
                }
            )
            if attempt_number < len(models):
                _log(context, logger, f"RunningHub image model failed, trying next model: {model}")
    attempted = ", ".join(item["model"] for item in attempts)
    raise RuntimeError(f"RunningHub image generation failed ({attempted}): {last_error or 'all models failed'}")


__all__ = [
    "DEFAULT_MODEL_ORDER",
    "MODEL_CONFIGS",
    "RequestsRunningHubImageTransport",
    "RunningHubImageTransport",
    "generate_image_with_fallback",
    "normalize_model_id",
    "normalize_model_order",
    "resolve_api_key",
]
