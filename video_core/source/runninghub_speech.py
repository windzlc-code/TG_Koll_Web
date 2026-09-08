from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

from . import runninghub_common


RUNNINGHUB_SPEECH_MODELS: tuple[str, ...] = (
    "speech-2.8-hd",
    "speech-2.8-turbo",
    "speech-2.6-hd",
    "speech-2.6-turbo",
    "speech-02-hd",
    "speech-02-turbo",
)
RUNNINGHUB_SPEECH_DEFAULT_MODEL = "speech-2.8-hd"
RUNNINGHUB_SPEECH_DEFAULT_VOICE = "male-qn-qingse"
RUNNINGHUB_SPEECH_BASE_URL = "https://www.runninghub.ai"
_OFFICIAL_MINIMAX_HOST_MARKERS = ("minimaxi.com", "minimax.io", "minimax.chat")


def normalize_speech_model(value: Any) -> str:
    text = str(value or "").strip()
    if text in RUNNINGHUB_SPEECH_MODELS:
        return text
    return RUNNINGHUB_SPEECH_DEFAULT_MODEL


def normalize_speech_voice(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text == "Wise_Woman":
        return RUNNINGHUB_SPEECH_DEFAULT_VOICE
    return text


def speech_base_url(value: Any, *, fallback: str = RUNNINGHUB_SPEECH_BASE_URL) -> str:
    text = str(value or "").strip().rstrip("/")
    lowered = text.lower()
    if not text or any(marker in lowered for marker in _OFFICIAL_MINIMAX_HOST_MARKERS):
        return str(fallback or RUNNINGHUB_SPEECH_BASE_URL).strip().rstrip("/") or RUNNINGHUB_SPEECH_BASE_URL
    return text


def generate_text_to_audio(
    *,
    api_key: str,
    base_url: str,
    model: str,
    text: str,
    output_path: Path,
    voice_id: str = RUNNINGHUB_SPEECH_DEFAULT_VOICE,
    speed: float = 1.0,
    volume: float = 1.0,
    pitch: float = 0,
    emotion: str = "happy",
    timeout_seconds: float = 180,
    poll_interval_seconds: float = 2.0,
    check_cancelled: Callable[[], Any] | None = None,
) -> Path:
    api_key_text = str(api_key or "").strip()
    speech_text = str(text or "").strip()
    if not api_key_text:
        raise RuntimeError("缺少语音合成 API Key")
    if not speech_text:
        raise RuntimeError("缺少 TTS 文本")
    model_slug = normalize_speech_model(model)
    resolved_voice = normalize_speech_voice(voice_id)
    root = speech_base_url(base_url)
    submit_url = f"{root}/openapi/v2/rhart-audio/text-to-audio/{model_slug}"
    body = {
        "text": speech_text,
        "pronunciation_dict": [],
        "voice_id": resolved_voice,
        "speed": float(speed or 1.0),
        "volume": float(volume or 1.0),
        "pitch": float(pitch or 0),
        "emotion": str(emotion or "").strip() or "happy",
        "enable_base64_output": False,
        "english_normalization": False,
    }
    if callable(check_cancelled):
        check_cancelled()
    response = runninghub_common.rh_post(
        submit_url,
        headers={"Authorization": f"Bearer {api_key_text}", "Content-Type": "application/json"},
        data=json.dumps(body, ensure_ascii=False),
        timeout=120,
    )
    response.raise_for_status()
    try:
        payload = response.json()
    except Exception as exc:
        preview = str(getattr(response, "text", "") or "")[:800]
        raise RuntimeError(f"Speech 提交返回非 JSON: {preview}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"Speech 提交返回无效结果: {runninghub_common._safe_json_preview(payload)}")
    code = payload.get("code")
    if code not in (None, "", 0, "0", 200, "200"):
        raise RuntimeError(
            "Speech 提交失败: "
            f"code={code} msg={payload.get('msg') or payload.get('message') or ''} "
            f"preview={runninghub_common._safe_json_preview(payload)}"
        )
    task_id = runninghub_common._extract_task_id(payload)
    if not task_id:
        raise RuntimeError(f"Speech 提交未返回 taskId: {runninghub_common._safe_json_preview(payload)}")
    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + max(float(timeout_seconds or 180), 30.0)
    interval = max(float(poll_interval_seconds or 2.0), 0.25)
    last: dict[str, Any] = {}
    while time.monotonic() <= deadline:
        if callable(check_cancelled):
            check_cancelled()
        last = runninghub_common.query_task(
            task_id=task_id,
            api_key=api_key_text,
            video_output_path=str(output),
            base_url=root,
        )
        status = str((last or {}).get("status") or "").strip().lower()
        if status == "success":
            if output.exists() and output.stat().st_size > 0:
                return output
            raise RuntimeError(f"Speech 任务成功但未写出音频: {runninghub_common._safe_json_preview(last)}")
        if status == "failed":
            raise RuntimeError(str((last or {}).get("message") or "Speech 任务失败"))
        time.sleep(interval)
    raise RuntimeError(str((last or {}).get("message") or "Speech 任务超时"))
