from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import requests


ELEVENLABS_LANGUAGE_CODES_BY_LANGUAGE: dict[str, str] = {
    "Chinese": "zh",
    "English": "en",
    "Japanese": "ja",
    "Spanish": "es",
    "Thai": "th",
    "Malay": "ms",
}

_FALLBACK_ELEVENLABS_VOICE_PRESETS: dict[str, list[dict[str, str]]] = {
    "Chinese": [
        {
            "key": "zh_male_adam",
            "button": "中文男声 商务沉稳",
            "label": "中文男声 Adam · 商务沉稳",
            "voice_name": "Adam",
            "voice_id": "pNInz6obpgDQGcFmaJgB",
            "gender": "male",
            "language_code": "zh",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/d6905d7a-dd26-4187-bfff-1bd3a5ea7cac.mp3",
        },
        {
            "key": "zh_female_bella",
            "button": "中文女声 专业亲和",
            "label": "中文女声 Bella · 专业亲和",
            "voice_name": "Bella",
            "voice_id": "hpp4J3VqNfWAUOO0d1Us",
            "gender": "female",
            "language_code": "zh",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3",
        },
    ],
    "English": [
        {
            "key": "en_male_eric",
            "button": "英文男声 沉稳可信",
            "label": "英文男声 Eric · 沉稳可信",
            "voice_name": "Eric",
            "voice_id": "cjVigY5qzO86Huf0OWal",
            "gender": "male",
            "language_code": "en",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/cjVigY5qzO86Huf0OWal/d098fda0-6456-4030-b3d8-63aa048c9070.mp3",
        },
        {
            "key": "en_female_alice",
            "button": "英文女声 清晰讲解",
            "label": "英文女声 Alice · 清晰讲解",
            "voice_name": "Alice",
            "voice_id": "Xb7hH8MSUJpSbSDYk0k2",
            "gender": "female",
            "language_code": "en",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3",
        },
    ],
    "Japanese": [
        {
            "key": "ja_male_bill",
            "button": "日语男声 均衡稳重",
            "label": "日语男声 Bill · 均衡稳重",
            "voice_name": "Bill",
            "voice_id": "pqHfZKP75CvOlQylNhV4",
            "gender": "male",
            "language_code": "ja",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/pqHfZKP75CvOlQylNhV4/d782b3ff-84ba-4029-848c-acf01285524d.mp3",
        },
        {
            "key": "ja_female_lily",
            "button": "日语女声 柔和讲解",
            "label": "日语女声 Lily · 柔和讲解",
            "voice_name": "Lily",
            "voice_id": "pFZP5JQG7iQjIQuC4Bku",
            "gender": "female",
            "language_code": "ja",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3",
        },
    ],
    "Spanish": [
        {
            "key": "es_male_roger",
            "button": "西语男声 自然松弛",
            "label": "西语男声 Roger · 自然松弛",
            "voice_name": "Roger",
            "voice_id": "CwhRBWXzGAHq8TQ4Fs17",
            "gender": "male",
            "language_code": "es",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3",
        },
        {
            "key": "es_female_jessica",
            "button": "西语女声 明亮亲和",
            "label": "西语女声 Jessica · 明亮亲和",
            "voice_name": "Jessica",
            "voice_id": "cgSgspJ2msm6clMCkdW9",
            "gender": "female",
            "language_code": "es",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3",
        },
    ],
    "Thai": [
        {
            "key": "th_male_liam",
            "button": "泰语男声 活力口播",
            "label": "泰语男声 Liam · 活力口播",
            "voice_name": "Liam",
            "voice_id": "TX3LPaxmHKxFdv7VOQHJ",
            "gender": "male",
            "language_code": "th",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3",
        },
        {
            "key": "th_female_sarah",
            "button": "泰语女声 成熟亲和",
            "label": "泰语女声 Sarah · 成熟亲和",
            "voice_name": "Sarah",
            "voice_id": "EXAVITQu4vr4xnSDxMaL",
            "gender": "female",
            "language_code": "th",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3",
        },
    ],
    "Malay": [
        {
            "key": "ms_male_callum",
            "button": "马来男声 清晰厚实",
            "label": "马来男声 Callum · 清晰厚实",
            "voice_name": "Callum",
            "voice_id": "N2lVS1w4EtoT3dr4eOWO",
            "gender": "male",
            "language_code": "ms",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3",
        },
        {
            "key": "ms_female_matilda",
            "button": "马来女声 专业温和",
            "label": "马来女声 Matilda · 专业温和",
            "voice_name": "Matilda",
            "voice_id": "XrExE9yKIg1WjnnlVkGX",
            "gender": "female",
            "language_code": "ms",
            "preview_url": "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3",
        },
    ],
}

_VOICE_PRESET_MANIFEST_PATH = (Path(__file__).resolve().parents[2] / "webapp" / "static" / "assets" / "voice_presets_manifest.json").resolve()

_LANGUAGE_ALIASES = {
    "chinese": "Chinese",
    "中文": "Chinese",
    "mandarin": "Chinese",
    "english": "English",
    "英文": "English",
    "japanese": "Japanese",
    "日语": "Japanese",
    "日本语": "Japanese",
    "spanish": "Spanish",
    "西班牙语": "Spanish",
    "thai": "Thai",
    "泰语": "Thai",
    "malay": "Malay",
    "马来语": "Malay",
    "马来西亚": "Malay",
}


def _load_voice_preset_manifest() -> dict[str, list[dict[str, str]]]:
    try:
        payload = json.loads(_VOICE_PRESET_MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    manifest: dict[str, list[dict[str, str]]] = {}
    for language, presets in payload.items():
        if not isinstance(language, str) or not isinstance(presets, list):
            continue
        rows = [item for item in presets if isinstance(item, dict)]
        if not rows and language in _FALLBACK_ELEVENLABS_VOICE_PRESETS:
            rows = list(_FALLBACK_ELEVENLABS_VOICE_PRESETS[language])
        manifest[language] = rows
    return manifest


ELEVENLABS_VOICE_PRESETS: dict[str, list[dict[str, str]]] = _load_voice_preset_manifest() or _FALLBACK_ELEVENLABS_VOICE_PRESETS


def normalize_voice_preset_language(value: Any, default: str = "Chinese") -> str:
    text = str(value or "").strip()
    if text in ELEVENLABS_VOICE_PRESETS:
        return text
    return _LANGUAGE_ALIASES.get(text.lower(), default)


def elevenlabs_voice_presets_for_language(target_language: Any) -> list[dict[str, str]]:
    language = normalize_voice_preset_language(target_language)
    if language in ELEVENLABS_VOICE_PRESETS:
        return list(ELEVENLABS_VOICE_PRESETS[language])
    return list(ELEVENLABS_VOICE_PRESETS["Chinese"])


def elevenlabs_voice_preset_by_button(button: Any, target_language: Any) -> dict[str, str] | None:
    text = str(button or "").strip()
    for preset in elevenlabs_voice_presets_for_language(target_language):
        if text == str(preset.get("button") or "").strip():
            return preset
    return None


def elevenlabs_voice_preset_by_key(key: Any) -> dict[str, str] | None:
    target = str(key or "").strip()
    if not target:
        return None
    for presets in ELEVENLABS_VOICE_PRESETS.values():
        for preset in presets:
            if target == str(preset.get("key") or "").strip():
                return preset
    return None


def elevenlabs_voice_preset_display_label(preset: dict[str, str] | None) -> str:
    if not isinstance(preset, dict):
        return ""
    return str(preset.get("label") or preset.get("button") or preset.get("voice_name") or "").strip()


def elevenlabs_language_code(target_language: Any) -> str:
    language = normalize_voice_preset_language(target_language)
    return str(ELEVENLABS_LANGUAGE_CODES_BY_LANGUAGE.get(language) or "en")


def elevenlabs_preview_cache_name(target_language: Any, preset: dict[str, str] | None) -> str:
    language_key = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(normalize_voice_preset_language(target_language) or "Chinese")).strip("_")
    preset_key = re.sub(r"[^a-zA-Z0-9_-]+", "_", str((preset or {}).get("key") or (preset or {}).get("voice_name") or "voice")).strip("_")
    return f"{language_key}_{preset_key}.mp3"


def elevenlabs_bundled_preview_audio_path(preset: dict[str, str] | None) -> Path | None:
    relative_asset = str((preset or {}).get("preview_asset") or "").strip()
    if not relative_asset:
        return None
    candidate = (_VOICE_PRESET_MANIFEST_PATH.parent / relative_asset).resolve()
    if candidate.exists() and candidate.is_file():
        return candidate
    return None


def ensure_elevenlabs_preview_audio(*, preset: dict[str, str], output_path: Path) -> Path:
    bundled_path = elevenlabs_bundled_preview_audio_path(preset)
    if bundled_path is not None:
        return bundled_path
    preview_url = str((preset or {}).get("preview_url") or "").strip()
    if not preview_url:
        raise RuntimeError("预设音色缺少 ElevenLabs preview_url")
    output_path = Path(output_path).expanduser().resolve()
    if output_path.exists() and output_path.stat().st_size > 0:
        return output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
    response = requests.get(preview_url, timeout=60)
    if response.status_code >= 400:
        detail = str(getattr(response, "text", "") or "")[:300]
        raise RuntimeError(f"ElevenLabs 预设音色下载失败（HTTP {response.status_code}）：{detail}")
    temp_path.write_bytes(response.content or b"")
    if temp_path.stat().st_size <= 0:
        raise RuntimeError("ElevenLabs 预设音色下载为空文件")
    temp_path.replace(output_path)
    return output_path
