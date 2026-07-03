import base64
import json
import mimetypes
import re
import time
from pathlib import Path
from typing import Any

import requests


DEFAULT_MODEL = "gemini-3-pro-image-preview"
DEFAULT_HOST = "https://generativelanguage.googleapis.com"
IMAGE_URL_RE = re.compile(r"https?://[^\s\]\)>\"']+\.(?:png|jpe?g|webp|gif|bmp|tiff?)(?:\?[^\s\]\)>\"']*)?", re.I)


def _log(logger, message: str) -> None:
    if logger is None:
        return
    try:
        logger(message)
    except Exception:
        return


def _image_mime(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    return mime or "image/png"


def _extract_image_url_from_text(text: str) -> str | None:
    match = IMAGE_URL_RE.search(str(text or ""))
    if not match:
        return None
    return match.group(0).rstrip(").,;")


def _iter_candidate_parts(candidate: dict[str, Any]) -> list[dict[str, Any]]:
    content = candidate.get("content") if isinstance(candidate, dict) else None
    if isinstance(content, dict) and isinstance(content.get("parts"), list):
        return [part for part in content.get("parts") if isinstance(part, dict)]
    if isinstance(candidate, dict) and isinstance(candidate.get("parts"), list):
        return [part for part in candidate.get("parts") if isinstance(part, dict)]
    return []


def _extract_candidate_image_payload(candidate: dict[str, Any], timeout_seconds: int = 60) -> dict[str, str] | None:
    deadline = time.time() + max(float(timeout_seconds or 0), 0.0)
    while True:
        for part in _iter_candidate_parts(candidate):
            inline_data = part.get("inline_data") or part.get("inlineData")
            if isinstance(inline_data, dict):
                data = str(inline_data.get("data") or "").strip()
                if data:
                    return {"kind": "base64", "value": data}
            text = str(part.get("text") or "").strip()
            if text:
                image_url = _extract_image_url_from_text(text)
                if image_url:
                    return {"kind": "url", "value": image_url}
        if time.time() >= deadline:
            return None
        time.sleep(min(0.2, max(deadline - time.time(), 0.0)))


def _resolve_generate_url(host: str, model: str) -> str:
    base = str(host or DEFAULT_HOST).strip().rstrip("/")
    if ":generateContent" in base:
        return base
    if base.endswith("/v1beta"):
        return f"{base}/models/{model}:generateContent"
    if base.endswith("/v1"):
        return f"{base}/models/{model}:generateContent"
    return f"{base}/v1beta/models/{model}:generateContent"


def _write_payload(payload: dict[str, str], output_image_path: str) -> str:
    output = Path(output_image_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if payload["kind"] == "base64":
        output.write_bytes(base64.b64decode(payload["value"]))
        return str(output)
    response = requests.get(payload["value"], timeout=(10, 180))
    response.raise_for_status()
    output.write_bytes(response.content)
    return str(output)


def get_nano_banana_pro(
    *,
    prompt: str,
    output_image_path: str,
    api_key: str,
    input_image_path: str = "",
    host: str = DEFAULT_HOST,
    model: str = DEFAULT_MODEL,
    retry_count: int = 2,
    timeout_seconds: int = 120,
    logger=None,
) -> dict[str, Any]:
    parts: list[dict[str, Any]] = [{"text": str(prompt or "").strip()}]
    if input_image_path:
        image_path = Path(input_image_path)
        image_data = base64.b64encode(image_path.read_bytes()).decode("ascii")
        parts.append({"inline_data": {"mime_type": _image_mime(str(image_path)), "data": image_data}})

    url = _resolve_generate_url(host, model)
    payload = {"contents": [{"role": "user", "parts": parts}]}
    headers = {"Content-Type": "application/json"}
    params = {"key": api_key}
    attempts = max(int(retry_count or 0) + 1, 1)
    last_error: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            response = requests.post(url, headers=headers, params=params, json=payload, timeout=timeout_seconds)
            response.raise_for_status()
            data = response.json()
            candidates = data.get("candidates") if isinstance(data, dict) else None
            if not isinstance(candidates, list) or not candidates:
                raise RuntimeError("Nano Banana 响应缺少 candidates")
            image_payload = _extract_candidate_image_payload(candidates[0], timeout_seconds=timeout_seconds)
            if not image_payload:
                raise RuntimeError("Nano Banana 响应缺少图片结果")
            path = _write_payload(image_payload, output_image_path)
            return {"ok": True, "output_image_path": path, "raw": data}
        except Exception as exc:
            last_error = exc
            response = getattr(exc, "response", None)
            detail = {
                "attempt": attempt,
                "status_code": getattr(response, "status_code", None),
                "response_preview": str(getattr(response, "text", "") or "")[:500],
                "error": str(exc),
            }
            _log(logger, "Nano Banana 请求失败: " + json.dumps(detail, ensure_ascii=False))
            if attempt < attempts:
                time.sleep(min(2.0 * attempt, 5.0))

    raise RuntimeError(f"Nano Banana 请求失败: {last_error}")
