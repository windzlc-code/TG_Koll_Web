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
RUNNINGHUB_SPEECH_FALLBACK_MODEL = "speech-2.8-turbo"
RUNNINGHUB_SPEECH_DEFAULT_VOICE = "Wise_Woman"
RUNNINGHUB_SPEECH_BASE_URL = "https://www.runninghub.cn"
_RUNNINGHUB_DEFAULT_PRONUNCIATION_DICT = ["ASAP/As soon as possible"]
_OFFICIAL_MINIMAX_HOST_MARKERS = ("minimaxi.com", "minimax.io", "minimax.chat")
_RUNNINGHUB_HOST_MARKERS = ("runninghub.ai", "runninghub.cn")
_LEGACY_VOICE_ALIASES = {
    # This is a MiniMax OpenAI-compatible voice id, not a stable RunningHub
    # Standard Speech voice id. Keep old persisted settings usable by mapping
    # the legacy default to the provider's documented voice.
    "male-qn-qingse": RUNNINGHUB_SPEECH_DEFAULT_VOICE,
}


def _provider_number(value: Any, fallback: float) -> int | float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(fallback)
    return int(number) if number.is_integer() else number


def normalize_speech_model(value: Any) -> str:
    text = str(value or "").strip()
    if text in RUNNINGHUB_SPEECH_MODELS:
        return text
    return RUNNINGHUB_SPEECH_DEFAULT_MODEL


def normalize_speech_voice(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return RUNNINGHUB_SPEECH_DEFAULT_VOICE
    return _LEGACY_VOICE_ALIASES.get(text, text)


def speech_base_url(value: Any, *, fallback: str = RUNNINGHUB_SPEECH_BASE_URL) -> str:
    text = str(value or "").strip().rstrip("/")
    lowered = text.lower()
    if not text or any(marker in lowered for marker in _OFFICIAL_MINIMAX_HOST_MARKERS):
        return str(fallback or RUNNINGHUB_SPEECH_BASE_URL).strip().rstrip("/") or RUNNINGHUB_SPEECH_BASE_URL
    # The account's Standard Speech route is currently served by the .cn
    # endpoint. The .ai endpoint accepts the task but later returns provider
    # error 1007 for the same request, so do not inherit the video workflow's
    # .ai base URL for speech.
    if any(marker in lowered for marker in _RUNNINGHUB_HOST_MARKERS):
        return RUNNINGHUB_SPEECH_BASE_URL
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
    _allow_model_fallback: bool = True,
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
        # RunningHub currently rejects an empty pronunciation_dict at task
        # execution time with provider error 1007, while its documented
        # request shape includes at least one mapping. Keep the mapping
        # provider-side only; it does not alter the user script text.
        "pronunciation_dict": list(_RUNNINGHUB_DEFAULT_PRONUNCIATION_DICT),
        "voice_id": resolved_voice,
        "speed": _provider_number(speed or 1.0, 1.0),
        "volume": _provider_number(volume or 1.0, 1.0),
        "pitch": _provider_number(pitch or 0, 0),
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
            message = str((last or {}).get("message") or "Speech 任务失败")
            if (
                _allow_model_fallback
                and model_slug != RUNNINGHUB_SPEECH_FALLBACK_MODEL
                and "1007" in message
            ):
                return generate_text_to_audio(
                    api_key=api_key_text,
                    base_url=root,
                    model=RUNNINGHUB_SPEECH_FALLBACK_MODEL,
                    text=speech_text,
                    output_path=output,
                    voice_id=resolved_voice,
                    speed=speed,
                    volume=volume,
                    pitch=pitch,
                    emotion=emotion,
                    timeout_seconds=timeout_seconds,
                    poll_interval_seconds=poll_interval_seconds,
                    check_cancelled=check_cancelled,
                    _allow_model_fallback=False,
                )
            raise RuntimeError(message)
        time.sleep(interval)
    raise RuntimeError(str((last or {}).get("message") or "Speech 任务超时"))
