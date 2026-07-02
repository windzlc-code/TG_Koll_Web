from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


DEFAULT_RUNTIME_CONFIG: dict[str, Any] = {
    "runninghub_api_key": "",
    "upload_server_ip": "",
    "upload_file_api_key": "",
    "remote_comfy_gateway_url": "",
    "remote_comfy_gateway_token": "",
    "remote_comfy_workflow_mappings": {},
    "remote_comfy_image_input_bindings": {
        "get_nano_banana": {
            "image1": {"node_id": "2", "input_name": "image"},
            "image2": {"node_id": "19", "input_name": "image"},
        }
    },
    "local_comfy_gateway_url": "http://127.0.0.1:9001",
    "local_comfy_gateway_token": "",
    "local_comfy_workflow_mappings": {},
    "local_comfy_image_input_bindings": {},
    "comfy_workflow_source": "remote",
    "image_generate_mode_default": "remote_comfy",
    "image_runninghub_workflow_id": "",
    "llm_base_url": "http://202.90.21.53:3008",
    "llm_api_key": "",
    "llm_api_key_gemini": "",
    "llm_api_key_gpt": "",
    "llm_default_model": "gemini-3.1-pro-preview",
    "llm_default_model_gemini": "gemini-3.1-pro-preview",
    "llm_default_model_gpt": "gpt-4.1",
    "llm_model_priority_order": "gemini-3.1-pro-preview, gpt-4.1",
    "create_video_app_id": "2031016553440878594",
    "create_audio_app_id": "1965684535247650818",
    "video_app_id": "2031016553440878594",
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


def runtime_config_candidates() -> list[Path]:
    root = Path(__file__).resolve().parent
    candidates: list[Path] = []
    env_path = str(os.getenv("APP_RUNTIME_CONFIG_PATH", "") or "").strip()
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.extend(
        [
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
    for path in runtime_config_candidates():
        if not path.exists():
            continue
        data = _read_json_object(path)
        if data is None:
            continue
        merged.update(data)
        return merged
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
