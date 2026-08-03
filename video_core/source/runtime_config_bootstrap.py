from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

MINIMAX_CN_BASE_URL = "https://api.minimaxi.com"

DEFAULT_RUNTIME_CONFIG: dict[str, Any] = {
    "runninghub_api_key": "",
    "runninghub_personal_api_key": "",
    "runninghub_enterprise_api_key": "",
    "upload_server_ip": "",
    "upload_file_api_key": "",
    "image_generate_mode_default": "closed_model_api",
    "image_runninghub_workflow_id": "1900814586436534274",
    "image_model_provider_base_url": "https://www.runninghub.ai",
    "image_model_provider_api_key_gemini": "",
    "image_model_provider_api_key_gpt": "",
    "image_model_default_model": "gpt image 2",
    "image_model_default_model_gemini": "gpt image 2",
    "image_model_default_model_gpt": "",
    "image_model_priority_order": "gpt image 2, nano banana 2, nano banana pro",
    "llm_base_url": "https://llm.runninghub.ai/v1",
    "llm_api_key": "",
    "llm_api_key_gemini": "",
    "llm_api_key_gpt": "",
    "llm_default_model": "google/gemini-3.1-pro-preview",
    "llm_default_model_gemini": "google/gemini-3.1-pro-preview",
    "llm_default_model_gpt": "",
    "llm_model_priority_order": "google/gemini-3.1-pro-preview, google/gemini-3.5-flash",
    "minimax_api_key": "",
    "minimax_base_url": MINIMAX_CN_BASE_URL,
    "minimax_tts_model": "speech-2.8-hd",
    "minimax_tts_voice_id": "male-qn-qingse",
    "minimax_tts_format": "mp3",
    "minimax_tts_language_boost": "auto",
    "create_video_app_id": "2068273204367544322",
    "create_audio_app_id": "1965684535247650818",
    "video_app_id": "2068273204367544322",
    "replace_model_original_app_id": "1977634608437174274",
    "replace_product_app_id": "1977410328592031746",
    "replace_union_model_workflow_ids": ["1977634608437174274"],
    "replace_union_product_workflow_ids": ["1977410328592031746"],
    "cleanup_enabled": True,
    "cleanup_time": "03:30",
    "cleanup_retention_days": 7,
}


def bundled_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)).resolve()


def _read_json_object(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _has_runtime_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def runtime_config_candidates() -> list[Path]:
    root = Path(__file__).resolve().parent
    candidates: list[Path] = []
    env_path = str(os.getenv("APP_RUNTIME_CONFIG_PATH", "") or "").strip()
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.extend(
        [
            Path.cwd() / "runtime" / "runtime_config.json",
            root / "runtime" / "runtime_config.json",
            Path.cwd() / "webapp_data" / "runtime_config.json",
            root / "webapp_data" / "runtime_config.json",
            bundled_root() / "webapp_data" / "runtime_config.json",
            root / "runtime_config.example.json",
            bundled_root() / "runtime_config.example.json",
        ]
    )
    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            unique.append(path)
            seen.add(key)
    return unique


def load_runtime_config() -> dict[str, Any]:
    merged = dict(DEFAULT_RUNTIME_CONFIG)
    explicit_keys: set[str] = set()
    for path in runtime_config_candidates():
        if not path.exists():
            continue
        data = _read_json_object(path)
        if data is None:
            continue
        for key, value in data.items():
            if key not in explicit_keys:
                merged[key] = value
                explicit_keys.add(key)
                continue
            if not _has_runtime_value(merged.get(key)) and _has_runtime_value(value):
                merged[key] = value
    merged["minimax_api_key"] = str(merged.get("minimax_api_key") or "").strip()
    merged["minimax_base_url"] = MINIMAX_CN_BASE_URL
    merged["minimax_tts_model"] = str(merged.get("minimax_tts_model") or "speech-2.8-hd").strip() or "speech-2.8-hd"
    merged["minimax_tts_voice_id"] = str(merged.get("minimax_tts_voice_id") or "male-qn-qingse").strip() or "male-qn-qingse"
    merged["minimax_tts_format"] = str(merged.get("minimax_tts_format") or "mp3").strip().lower() or "mp3"
    merged["minimax_tts_language_boost"] = str(merged.get("minimax_tts_language_boost") or "auto").strip() or "auto"
    return merged


def ensure_runtime_config_file(path: Path) -> Path:
    target = path.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return target

    for candidate in runtime_config_candidates():
        if candidate.name != "runtime_config.example.json" or not candidate.exists():
            continue
        data = _read_json_object(candidate)
        if data is not None:
            target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return target

    target.write_text(json.dumps(DEFAULT_RUNTIME_CONFIG, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target
