import base64
import json
import mimetypes
import os
import re
import traceback
from typing import Any
import time
import requests
from bs4 import BeautifulSoup
from model_endpoint_utils import build_model_request_url, clean_endpoint_input
from urllib.parse import urlsplit, urlunsplit


try:
    from json_repair import repair_json as _repair_json
except Exception:
    _repair_json = None

REQUEST_TIMEOUT_SECONDS = 120


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except Exception:
        return float(default)


OPENAI_COMPATIBLE_TEMPERATURE = _env_float("OPENAI_COMPATIBLE_TEMPERATURE", 0.7)


def _resolve_gemini_request_url(host: str, port: int | str | None = None, model: str = "") -> str:
    cleaned_host = clean_endpoint_input(host)
    model_name = str(model or "").strip() or "gemini-3-pro-preview"
    default_path = f"/v1beta/models/{model_name}:generateContent"
    return build_model_request_url(host=cleaned_host, port=port, path=default_path)


def _is_openai_compatible_model(model: str) -> bool:
    text = str(model or "").strip().lower()
    return "grok" in text


def _resolve_openai_chat_completions_url(host: str, port: int | str | None = None) -> str:
    cleaned_host = clean_endpoint_input(host)
    if not cleaned_host:
        raise ValueError("host 不能为空")

    if "://" not in cleaned_host:
        cleaned_port = str(port or "").strip()
        netloc = cleaned_host if not cleaned_port else f"{cleaned_host}:{cleaned_port}"
        return f"https://{netloc}/v1/chat/completions"

    parsed = urlsplit(cleaned_host)
    path = (parsed.path or "").rstrip("/")
    if path.endswith("/chat/completions"):
        final_path = path
    elif path.endswith("/v1"):
        final_path = f"{path}/chat/completions"
    elif not path:
        final_path = "/v1/chat/completions"
    else:
        final_path = f"{path}/v1/chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, final_path, parsed.query, parsed.fragment))


def _safe_soup(text: str) -> BeautifulSoup:
    try:
        return BeautifulSoup(text, "lxml")
    except Exception:
        return BeautifulSoup(text, "html.parser")


def _strip_code_fence(text: str) -> str:
    value = str(text or "").strip()
    if value.startswith("```") and value.endswith("```"):
        lines = value.splitlines()
        if len(lines) >= 2:
            return "\n".join(lines[1:-1]).strip()
    return value


def _try_json_loads(raw: str) -> Any:
    source = _strip_code_fence(raw)
    if _repair_json is not None:
        try:
            source = _repair_json(source)
        except Exception:
            pass
    try:
        return json.loads(source)
    except Exception:
        try:
            return json.loads(source.replace("'", "\""))
        except Exception:
            return None


def _dedupe_non_empty(values: list[Any]) -> list[str]:
    result: list[str] = []
    for item in values:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def _parse_style_json(raw: str) -> list[str]:
    parsed = _try_json_loads(raw)
    if isinstance(parsed, dict):
        styles = parsed.get("style") or parsed.get("style list") or parsed.get("style_list") or []
        if isinstance(styles, list):
            return _dedupe_non_empty(styles)
    if isinstance(parsed, list):
        return _dedupe_non_empty(parsed)

    style_items: list[str] = []
    for line in str(raw or "").replace("，", ",").splitlines():
        line = re.sub(r"^\s*(\d+[\.\)、]|[-*])\s*", "", line).strip()
        if line:
            style_items.extend([part.strip() for part in line.split(",") if part.strip()])
    return _dedupe_non_empty(style_items)


def _extract_block_by_div_class(text: str, class_name: str) -> str:
    soup = _safe_soup(text)
    node = soup.find("div", class_=class_name)
    if node is not None:
        return node.get_text("\n", strip=True)
    # class 名大小写不稳定，降级做 regex
    pattern = rf"<div\s+class=[\"']{re.escape(class_name)}[\"']\s*>(.*?)</div>"
    match = re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""


def _extract_block_by_tag(text: str, tag_name: str) -> str:
    pattern = rf"<{re.escape(tag_name)}\s*>(.*?)</{re.escape(tag_name)}\s*>"
    match = re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""


def _extract_main_text_from_candidates(candidates: list[dict[str, Any]]) -> str:
    for candidate in candidates:
        parts = (candidate.get("content") or {}).get("parts") or []
        chunks: list[str] = []
        for part in parts:
            if part.get("thought") is True:
                continue
            text = str(part.get("text") or "").strip()
            if text:
                chunks.append(text)
        if chunks:
            return "\n".join(chunks).strip()
    return ""


def _extract_prompt_dict(text_content: str) -> dict[str, str] | None:
    image_prompt = _extract_block_by_div_class(text_content, "ImagePrompt")
    video_prompt = _extract_block_by_div_class(text_content, "VideoPrompt")

    if not image_prompt:
        image_prompt = _extract_block_by_tag(text_content, "ImagePrompt")
    if not video_prompt:
        video_prompt = _extract_block_by_tag(text_content, "VideoPrompt")

    if image_prompt and video_prompt:
        return {
            "image prompt": image_prompt,
            "video prompt": video_prompt,
            "prompt_context": f"{image_prompt}\n{video_prompt}",
        }

    parsed = _try_json_loads(text_content)
    if isinstance(parsed, dict):
        image_val = str(parsed.get("image prompt") or parsed.get("image_prompt") or "").strip()
        video_val = str(parsed.get("video prompt") or parsed.get("video_prompt") or "").strip()
        if image_val and video_val:
            return {
                "image prompt": image_val,
                "video prompt": video_val,
                "prompt_context": f"{image_val}\n{video_val}",
            }
    return None


def _extract_timestamps(text_content: str) -> list[str]:
    soup = _safe_soup(text_content)
    values: list[str] = []
    for node in soup.find_all("div", class_=re.compile(r"^timestamp$", flags=re.IGNORECASE)):
        text = node.get_text(" ", strip=True)
        for match in re.finditer(r"\b(\d{2}\.\d{2}\.\d{2})\b", text):
            values.append(match.group(1))
    if not values:
        pattern = r"<div\s+class=[\"']timestamp[\"']\s*>.*?<p>\s*(\d{2}\.\d{2}\.\d{2})\s*</p>.*?</div>"
        for match in re.finditer(pattern, text_content, flags=re.IGNORECASE | re.DOTALL):
            values.append(match.group(1))
    return _dedupe_non_empty(values)


def _extract_frame_review(text_content: str) -> dict[str, str] | None:
    soup = _safe_soup(text_content)
    node = soup.find("div", class_=re.compile(r"^frame_review$", flags=re.IGNORECASE))
    if node is None:
        pattern = r"<div\s+class=[\"']frame_review[\"']\s*>(.*?)</div>"
        match = re.search(pattern, text_content, flags=re.IGNORECASE | re.DOTALL)
        if match:
            node_text = match.group(1)
            soup = _safe_soup(node_text)
            node = soup
    if node is None:
        return None

    text = node.get_text("\n", strip=True)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    decision = str(lines[0]).strip().upper()
    if decision not in {"PASS", "FAIL"}:
        return None
    reason = str(lines[1]).strip() if len(lines) > 1 else ""
    return {"decision": decision, "reason": reason}


def _mask_api_key(key: str) -> str:
    key = str(key or "")
    if len(key) <= 8:
        return "***"
    return f"{key[:4]}***{key[-4:]}"


def _emit_gemini_log(logger, payload: dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if logger is None:
        print(text)
        return
    try:
        logger(text)
    except Exception:
        print(text)


def get_mime_type(file_path: str) -> str:
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type is None:
        if file_path.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
            return "image/png"
        if file_path.lower().endswith((".mp4", ".avi", ".mov", ".mkv", ".webm")):
            return "video/mp4"
    return mime_type or "application/octet-stream"


def _file_to_data_url(file_path: str) -> str:
    with open(file_path, "rb") as file_obj:
        encoded = base64.b64encode(file_obj.read()).decode("utf-8")
    return f"data:{get_mime_type(file_path)};base64,{encoded}"


def _build_openai_user_content(
    *,
    user_input: str,
    parameters: dict | None | str,
    image_paths: list[str] | str | None,
    video_paths: list[str] | str | None,
) -> str | list[dict[str, Any]]:
    def format_parameters(params: dict[str, Any], indent: int = 0) -> list[str]:
        lines: list[str] = []
        indent_str = "  " * indent
        for key, value in params.items():
            if isinstance(value, dict):
                lines.append(f"{indent_str}{key}:")
                lines.extend(format_parameters(value, indent + 1))
            else:
                lines.append(f"{indent_str}{key}: {value}")
        return lines

    parameters_str = ""
    if isinstance(parameters, dict) and parameters:
        parameters_str = "\n".join(format_parameters(parameters))
    elif isinstance(parameters, str) and parameters.strip():
        parameters_str = parameters.strip()

    composed_input = str(user_input or "").strip()
    if parameters_str:
        composed_input = f"{composed_input}\n{parameters_str}"

    if isinstance(image_paths, str):
        image_paths = [image_paths]
    if isinstance(video_paths, str):
        video_paths = [video_paths]

    file_parts: list[dict[str, Any]] = []
    for file_path in [*(image_paths or []), *(video_paths or [])]:
        if not file_path:
            continue
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"文件不存在: {file_path}")
        file_parts.append({"type": "image_url", "image_url": {"url": _file_to_data_url(file_path)}})

    if not file_parts:
        return composed_input
    return [*file_parts, {"type": "text", "text": composed_input}]


def _extract_openai_text(response_data: Any) -> str:
    if not isinstance(response_data, dict):
        return ""
    choices = response_data.get("choices")
    if not isinstance(choices, list):
        return ""
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            message = choice.get("delta")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            chunks: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text = str(part.get("text") or "").strip()
                    if text:
                        chunks.append(text)
            if chunks:
                return "\n".join(chunks).strip()
    return ""


def _request_openai_compatible_raw_text(
    *,
    user_input: str,
    host: str,
    api_key: str,
    parameters: dict | None | str = "",
    image_paths: list[str] | str | None = None,
    port: int | str | None = None,
    video_paths: list[str] | str | None = None,
    system_prompt: str = "",
    retry_count: int = 3,
    retry_wait_seconds: float = 2.0,
    disable_proxy: bool = True,
    model: str = "",
) -> dict[str, Any]:
    url = _resolve_openai_chat_completions_url(host=host, port=port)
    user_content = _build_openai_user_content(
        user_input=user_input,
        parameters=parameters,
        image_paths=image_paths,
        video_paths=video_paths,
    )
    prompt_prefix = str(system_prompt or "").strip()
    if prompt_prefix:
        if isinstance(user_content, str):
            user_content = f"{prompt_prefix}\n{user_content}".strip()
        else:
            user_content = [{"type": "text", "text": prompt_prefix}, *user_content]
    messages: list[dict[str, Any]] = []
    messages.append(
        {
            "role": "user",
            "content": user_content,
        }
    )
    payload = {
        "model": str(model or "").strip() or "grok-4",
        "messages": messages,
        "temperature": OPENAI_COMPATIBLE_TEMPERATURE,
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    retry_count = max(int(retry_count or 1), 1)
    retry_wait_seconds = max(float(retry_wait_seconds or 0.0), 0.0)
    session = requests.Session()
    if disable_proxy:
        session.trust_env = False

    last_exc: Exception | None = None
    response = None
    for attempt in range(1, retry_count + 1):
        try:
            response = session.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            last_exc = None
            break
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last_exc = exc
            if attempt < retry_count and retry_wait_seconds > 0:
                time.sleep(retry_wait_seconds * (1.6 ** (attempt - 1)))
            continue
        except requests.exceptions.RequestException as exc:
            return {"ok": False, "error": f"请求失败: {exc}", "raw": str(getattr(exc, "response", None) or "")}

    if last_exc is not None or response is None:
        return {"ok": False, "error": f"请求失败: {last_exc}", "raw": ""}

    try:
        response_data = response.json()
    except ValueError as exc:
        preview = response.text[:800]
        return {"ok": False, "error": f"响应解析失败: {exc}", "raw": preview}

    text_content = _extract_openai_text(response_data)
    if not text_content:
        return {"ok": False, "error": "未找到有效的响应内容", "raw": response_data}
    return {"ok": True, "raw_text": text_content, "raw": response_data}


def request_gemini3_pro(
        user_input: str,
        host: str,
        api_key: str,
        parameters: dict | None | str = "",
        image_paths: list[str] | str | None = None,
        port: int | str | None = None,
        video_paths: list[str] | str | None = None,
        system_prompt="",
        retry_count: int = 3,
        retry_wait_seconds: float = 2.0,
        disable_proxy: bool = True,
        logger=None,
        model: str = "",
    ):
    """
    支持多个图片和视频输入的 Gemini 请求。
    返回：
    - 提示词任务：{"image prompt": "...", "video prompt": "..."}
    - 风格任务：{"style list": ["...", "..."]}
    - 无法解析时：字符串错误信息
    """

    url = _resolve_gemini_request_url(host=host, port=port, model=model)

    def format_parameters(params: dict[str, Any], indent: int = 0) -> list[str]:
        lines: list[str] = []
        indent_str = "  " * indent
        for key, value in params.items():
            if isinstance(value, dict):
                lines.append(f"{indent_str}{key}:")
                lines.extend(format_parameters(value, indent + 1))
            else:
                lines.append(f"{indent_str}{key}: {value}")
        return lines

    parameters_str = ""
    if isinstance(parameters, dict) and parameters:
        parameters_str = "\n".join(format_parameters(parameters))
    elif isinstance(parameters, str) and parameters.strip():
        parameters_str = parameters.strip()

    composed_input = str(user_input or "").strip()
    if parameters_str:
        composed_input = f"{composed_input}\n{parameters_str}"

    if isinstance(image_paths, str):
        image_paths = [image_paths]
    if isinstance(video_paths, str):
        video_paths = [video_paths]

    image_parts: list[dict[str, Any]] = []
    for image_path in image_paths or []:
        if not image_path:
            continue
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"图片文件不存在: {image_path}")
        with open(image_path, "rb") as file_obj:
            image_parts.append(
                {
                    "inline_data": {
                        "mime_type": get_mime_type(image_path),
                        "data": base64.b64encode(file_obj.read()).decode("utf-8"),
                    }
                }
            )

    video_parts: list[dict[str, Any]] = []
    for video_path in video_paths or []:
        if not video_path:
            continue
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"视频文件不存在: {video_path}")
        with open(video_path, "rb") as file_obj:
            video_parts.append(
                {
                    "inline_data": {
                        "mime_type": get_mime_type(video_path),
                        "data": base64.b64encode(file_obj.read()).decode("utf-8"),
                    }
                }
            )

    payload = {
        "systemInstruction": {"parts": [{"text": ""}]},
        "contents": [{"role": "user", "parts": []}],
        # 关闭 thinking 输出，降低响应体复杂度与超时概率。
        "generationConfig": {"temperature": 1, "topP": 1},
    }
    payload["contents"][0]["parts"].extend(image_parts)
    payload["contents"][0]["parts"].extend(video_parts)
    payload["contents"][0]["parts"].append({"text": f"{system_prompt}\n{composed_input}"})

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "x-goog-api-key": api_key,
    }

    retry_count = max(int(retry_count or 1), 1)
    retry_wait_seconds = max(float(retry_wait_seconds or 0.0), 0.0)

    session = requests.Session()
    if disable_proxy:
        session.trust_env = False

    last_exc: Exception | None = None
    for attempt in range(1, retry_count + 1):
        try:
            response = session.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            last_exc = None
            break
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last_exc = exc
            status_code = getattr(getattr(exc, "response", None), "status_code", "N/A")
            response_preview = str(getattr(getattr(exc, "response", None), "text", "") or "")[:500]
            error_info = {
                "error_type": type(exc).__name__,
                "error_message": str(exc),
                "status": status_code,
                "request_url": url,
                "api_key": _mask_api_key(api_key),
                "response_preview": response_preview,
                "attempt": f"{attempt}/{retry_count}",
            }
            _emit_gemini_log(logger, error_info)
            if attempt < retry_count and retry_wait_seconds > 0:
                time.sleep(retry_wait_seconds * (1.6 ** (attempt - 1)))
            continue
        except requests.exceptions.RequestException as exc:
            status_code = getattr(exc.response, "status_code", "N/A")
            response_preview = str(getattr(exc.response, "text", "") or "")[:500]
            error_info = {
                "error_type": type(exc).__name__,
                "error_message": str(exc),
                "status": status_code,
                "request_url": url,
                "api_key": _mask_api_key(api_key),
                "response_preview": response_preview,
                "attempt": f"{attempt}/{retry_count}",
            }
            _emit_gemini_log(logger, error_info)
            return f"请求失败: {exc}"

    if last_exc is not None:
        _emit_gemini_log(
            logger,
            {
                "error_type": type(last_exc).__name__,
                "error_message": str(last_exc),
                "request_url": url,
                "api_key": _mask_api_key(api_key),
            },
        )
        return f"请求失败: {last_exc}"

    try:
        response_data = response.json()
    except ValueError as exc:
        preview = response.text[:500]
        _emit_gemini_log(
            logger,
            {
                "error_type": type(exc).__name__,
                "error_message": str(exc),
                "request_url": url,
                "response_preview": preview,
            },
        )
        return f"响应解析失败: {exc}; preview={preview}"

    candidates = response_data.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        _emit_gemini_log(logger, {"error_type": "EmptyCandidates", "request_url": url, "response_preview": str(response_data)[:500]})
        return f"未找到有效的响应内容: {response_data}"

    text_content = _extract_main_text_from_candidates(candidates)
    if not text_content:
        _emit_gemini_log(logger, {"error_type": "EmptyTextContent", "request_url": url, "response_preview": str(response_data)[:500]})
        return f"未找到有效的响应内容: {response_data}"

    frame_review = _extract_frame_review(text_content)
    if frame_review is not None:
        return {"frame_review": frame_review, "raw_text": text_content}

    timestamps = _extract_timestamps(text_content)
    if timestamps:
        return {"timestamps": timestamps, "raw_text": text_content}

    style_raw = _extract_block_by_div_class(text_content, "character_style")
    if not style_raw:
        style_raw = _extract_block_by_tag(text_content, "character_style")
    if style_raw:
        style_list = _parse_style_json(style_raw)
        if style_list:
            return {"style list": style_list}

    prompt_data = _extract_prompt_dict(text_content)
    if prompt_data is not None:
        return prompt_data

    # 保底：直接尝试从纯文本解析风格列表
    fallback_style_list = _parse_style_json(text_content)
    if fallback_style_list:
        return {"style list": fallback_style_list}

    _emit_gemini_log(logger, {"error_type": "UnrecognizedResponseFormat", "request_url": url, "response_preview": text_content[:500]})
    return f"未识别的响应格式: {text_content[:500]}"


def request_gemini3_pro_raw_text(
    *,
    user_input: str,
    host: str,
    api_key: str,
    parameters: dict | None | str = "",
    image_paths: list[str] | str | None = None,
    port: int | str | None = None,
    video_paths: list[str] | str | None = None,
    system_prompt: str = "",
    retry_count: int = 3,
    retry_wait_seconds: float = 2.0,
    disable_proxy: bool = True,
    logger=None,
    model: str = "",
) -> dict[str, Any]:
    if _is_openai_compatible_model(model):
        return _request_openai_compatible_raw_text(
            user_input=user_input,
            host=host,
            api_key=api_key,
            parameters=parameters,
            image_paths=image_paths,
            port=port,
            video_paths=video_paths,
            system_prompt=system_prompt,
            retry_count=retry_count,
            retry_wait_seconds=retry_wait_seconds,
            disable_proxy=disable_proxy,
            model=model,
        )

    url = _resolve_gemini_request_url(host=host, port=port, model=model)

    def format_parameters(params: dict[str, Any], indent: int = 0) -> list[str]:
        lines: list[str] = []
        indent_str = "  " * indent
        for key, value in params.items():
            if isinstance(value, dict):
                lines.append(f"{indent_str}{key}:")
                lines.extend(format_parameters(value, indent + 1))
            else:
                lines.append(f"{indent_str}{key}: {value}")
        return lines

    parameters_str = ""
    if isinstance(parameters, dict) and parameters:
        parameters_str = "\n".join(format_parameters(parameters))
    elif isinstance(parameters, str) and parameters.strip():
        parameters_str = parameters.strip()

    composed_input = str(user_input or "").strip()
    if parameters_str:
        composed_input = f"{composed_input}\n{parameters_str}"

    if isinstance(image_paths, str):
        image_paths = [image_paths]
    if isinstance(video_paths, str):
        video_paths = [video_paths]

    image_parts: list[dict[str, Any]] = []
    for image_path in image_paths or []:
        if not image_path:
            continue
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"图片文件不存在: {image_path}")
        with open(image_path, "rb") as file_obj:
            image_parts.append(
                {
                    "inline_data": {
                        "mime_type": get_mime_type(image_path),
                        "data": base64.b64encode(file_obj.read()).decode("utf-8"),
                    }
                }
            )

    video_parts: list[dict[str, Any]] = []
    for video_path in video_paths or []:
        if not video_path:
            continue
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"视频文件不存在: {video_path}")
        with open(video_path, "rb") as file_obj:
            video_parts.append(
                {
                    "inline_data": {
                        "mime_type": get_mime_type(video_path),
                        "data": base64.b64encode(file_obj.read()).decode("utf-8"),
                    }
                }
            )

    payload = {
        "systemInstruction": {"parts": [{"text": ""}]},
        "contents": [{"role": "user", "parts": []}],
        "generationConfig": {"temperature": 0.2, "topP": 1},
    }
    payload["contents"][0]["parts"].extend(image_parts)
    payload["contents"][0]["parts"].extend(video_parts)
    payload["contents"][0]["parts"].append({"text": f"{system_prompt}\n{composed_input}"})

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "x-goog-api-key": api_key,
    }

    retry_count = max(int(retry_count or 1), 1)
    retry_wait_seconds = max(float(retry_wait_seconds or 0.0), 0.0)

    session = requests.Session()
    if disable_proxy:
        session.trust_env = False

    last_exc: Exception | None = None
    response = None
    for attempt in range(1, retry_count + 1):
        try:
            response = session.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            last_exc = None
            break
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last_exc = exc
            if attempt < retry_count and retry_wait_seconds > 0:
                time.sleep(retry_wait_seconds * (1.6 ** (attempt - 1)))
            continue
        except requests.exceptions.RequestException as exc:
            return {"ok": False, "error": f"请求失败: {exc}", "raw": str(getattr(exc, "response", None) or "")}

    if last_exc is not None or response is None:
        return {"ok": False, "error": f"请求失败: {last_exc}", "raw": ""}

    try:
        response_data = response.json()
    except ValueError as exc:
        preview = response.text[:800]
        return {"ok": False, "error": f"响应解析失败: {exc}", "raw": preview}

    candidates = response_data.get("candidates") if isinstance(response_data, dict) else None
    candidates = candidates if isinstance(candidates, list) else []
    text_content = _extract_main_text_from_candidates(candidates)
    if not text_content:
        return {"ok": False, "error": "未找到有效的响应内容", "raw": response_data}
    return {"ok": True, "raw_text": text_content, "raw": response_data}


def request_gemini3_pro_json(
    *,
    user_input: str,
    host: str,
    api_key: str,
    system_prompt: str,
    port: int | str | None = None,
    parameters: dict | None | str = "",
    image_paths: list[str] | str | None = None,
    video_paths: list[str] | str | None = None,
    retry_count: int = 3,
    retry_wait_seconds: float = 2.0,
    disable_proxy: bool = True,
    logger=None,
    model: str = "",
) -> dict[str, Any]:
    raw = request_gemini3_pro_raw_text(
        user_input=user_input,
        host=host,
        api_key=api_key,
        parameters=parameters,
        image_paths=image_paths,
        port=port,
        video_paths=video_paths,
        system_prompt=system_prompt,
        retry_count=retry_count,
        retry_wait_seconds=retry_wait_seconds,
        disable_proxy=disable_proxy,
        logger=logger,
        model=model,
    )
    if not raw.get("ok"):
        return {"ok": False, "error": str(raw.get("error") or ""), "raw": raw.get("raw")}
    text_content = str(raw.get("raw_text") or "").strip()
    parsed = _try_json_loads(text_content)
    if parsed is None:
        return {"ok": False, "error": "未返回可解析 JSON", "raw_text": text_content, "raw": raw.get("raw")}
    return {"ok": True, "parsed": parsed, "raw_text": text_content, "raw": raw.get("raw")}


if __name__ == "__main__":
    print("get_gemini module")
