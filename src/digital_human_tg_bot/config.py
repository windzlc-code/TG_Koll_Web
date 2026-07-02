from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


DEFAULT_APP_TITLE = "多智能體協作工作台"
DEFAULT_WEB_HOST = "0.0.0.0"
DEFAULT_WEB_PORT = 8091
DEFAULT_PUBLIC_BASE_URL = "http://localhost:8091"
DEFAULT_SCRIPT_TEXT = (
    "大家好，今天简单聊聊八字流年运势。八字以出生年月日时定格局，结合当年流年五行，"
    "看全年事业、财运、感情与健康走向。今年整体机遇与挑战并存，做事稳扎稳打，遇事冷静三思，"
    "避开冲动是非。把握贵人助力，踏实积累，守好自身节奏，愿大家趋吉避凶，平安顺遂，收获满满一整年。"
)
DEFAULT_RUNTIME_CONFIG_PATH = Path("/opt/apps/digital-human-tg-bot/runtime/runtime_config.json")
DEFAULT_ASSET_ROOT = Path("/opt/apps/digital-human-tg-bot/runtime/assets")


def _read_runtime_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"找不到 workflow runtime config: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"runtime config 解析失敗: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("runtime config 格式錯誤，應為 JSON object")
    return data


def _parse_path(value: str | None, default: Path) -> Path:
    raw = str(value or "").strip()
    if not raw:
        return default.expanduser().resolve()
    return Path(raw).expanduser().resolve()


def _parse_int_list(text: str | None) -> tuple[int, ...]:
    values: list[int] = []
    for chunk in str(text or "").replace(";", ",").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        values.append(int(chunk))
    return tuple(dict.fromkeys(values))


@dataclass(frozen=True)
class AppConfig:
    project_root: Path
    data_dir: Path
    jobs_dir: Path
    database_path: Path
    templates_dir: Path
    static_dir: Path
    app_title: str
    web_host: str
    web_port: int
    public_base_url: str
    runtime_config_path: Path
    tg_bot_token: str
    tg_seed_chat_ids: tuple[int, ...]
    runninghub_api_key: str
    audio_workflow_id: str
    video_workflow_id: str
    source_video_path: Path
    extracted_audio_path: Path
    avatar_image_path: Path
    cloned_audio_path: Path
    final_video_path: Path
    default_script_text: str
    poll_interval_seconds: float = 5.0


def load_config(project_root: Path) -> AppConfig:
    env_path = project_root / ".env"
    load_dotenv(env_path)

    runtime_config_path = _parse_path(
        os.getenv("WORKFLOW_RUNTIME_CONFIG_PATH"),
        DEFAULT_RUNTIME_CONFIG_PATH,
    )
    runtime = _read_runtime_config(runtime_config_path)

    tg_bot_token = str(os.getenv("TG_BOT_TOKEN") or "").strip()
    if not tg_bot_token:
        raise RuntimeError("TG_BOT_TOKEN 未設定")

    seed_ids = _parse_int_list(os.getenv("TG_ALLOWED_CHAT_IDS"))
    if not seed_ids:
        seed_ids = _parse_int_list(os.getenv("TG_CHAT_ID"))

    runninghub_api_key = (
        str(os.getenv("ENGINE_API_KEY") or "").strip()
        or str(os.getenv("RUNNINGHUB_API_KEY") or "").strip()
        or str(runtime.get("runninghub_api_key") or "").strip()
    )

    data_dir = (project_root / "data").resolve()
    jobs_dir = (data_dir / "jobs").resolve()
    templates_dir = (project_root / "templates").resolve()
    static_dir = (project_root / "static").resolve()
    database_path = _parse_path(os.getenv("DATABASE_PATH"), data_dir / "workbench.db")

    data_dir.mkdir(parents=True, exist_ok=True)
    jobs_dir.mkdir(parents=True, exist_ok=True)
    templates_dir.mkdir(parents=True, exist_ok=True)
    static_dir.mkdir(parents=True, exist_ok=True)
    database_path.parent.mkdir(parents=True, exist_ok=True)

    return AppConfig(
        project_root=project_root.resolve(),
        data_dir=data_dir,
        jobs_dir=jobs_dir,
        database_path=database_path,
        templates_dir=templates_dir,
        static_dir=static_dir,
        app_title=str(os.getenv("APP_TITLE") or DEFAULT_APP_TITLE).strip() or DEFAULT_APP_TITLE,
        web_host=str(os.getenv("WEB_HOST") or DEFAULT_WEB_HOST).strip() or DEFAULT_WEB_HOST,
        web_port=int(str(os.getenv("WEB_PORT") or DEFAULT_WEB_PORT).strip() or DEFAULT_WEB_PORT),
        public_base_url=str(os.getenv("PUBLIC_BASE_URL") or DEFAULT_PUBLIC_BASE_URL).strip()
        or DEFAULT_PUBLIC_BASE_URL,
        runtime_config_path=runtime_config_path,
        tg_bot_token=tg_bot_token,
        tg_seed_chat_ids=seed_ids,
        runninghub_api_key=runninghub_api_key,
        audio_workflow_id=str(
            os.getenv("ENGINE_AUDIO_WORKFLOW_ID")
            or os.getenv("RUNNINGHUB_AUDIO_WORKFLOW_ID")
            or runtime.get("create_audio_app_id")
            or "1965684535247650818"
        ).strip(),
        video_workflow_id=str(
            os.getenv("ENGINE_VIDEO_WORKFLOW_ID")
            or os.getenv("RUNNINGHUB_VIDEO_WORKFLOW_ID")
            or runtime.get("create_video_app_id")
            or runtime.get("video_app_id")
            or "2031016553440878594"
        ).strip(),
        source_video_path=_parse_path(os.getenv("SOURCE_VIDEO_PATH"), DEFAULT_ASSET_ROOT / "擷取視頻.mp4"),
        extracted_audio_path=_parse_path(os.getenv("EXTRACTED_AUDIO_PATH"), DEFAULT_ASSET_ROOT / "擷取音頻.mp4"),
        avatar_image_path=_parse_path(os.getenv("AVATAR_IMAGE_PATH"), DEFAULT_ASSET_ROOT / "數字人照片.jpg"),
        cloned_audio_path=_parse_path(os.getenv("CLONED_AUDIO_PATH"), DEFAULT_ASSET_ROOT / "口播文案音頻1.flac"),
        final_video_path=_parse_path(os.getenv("FINAL_VIDEO_PATH"), DEFAULT_ASSET_ROOT / "結果1.mp4"),
        default_script_text=str(os.getenv("DEFAULT_SCRIPT_TEXT") or DEFAULT_SCRIPT_TEXT).strip()
        or DEFAULT_SCRIPT_TEXT,
        poll_interval_seconds=float(
            str(os.getenv("ENGINE_POLL_INTERVAL_SECONDS") or os.getenv("RUNNINGHUB_POLL_INTERVAL_SECONDS") or "5").strip()
            or "5"
        ),
    )


def apply_setting_overrides(config: AppConfig, overrides: dict[str, str]) -> AppConfig:
    values = {key: str(value).strip() for key, value in overrides.items() if value is not None}
    runtime_config_path = _parse_path(values.get("runtime_config_path"), config.runtime_config_path)

    api_key = values.get("engine_api_key") or config.runninghub_api_key
    audio_workflow_id = values.get("audio_workflow_id") or config.audio_workflow_id
    video_workflow_id = values.get("video_workflow_id") or config.video_workflow_id

    return replace(
        config,
        app_title=values.get("app_title") or config.app_title,
        public_base_url=values.get("public_base_url") or config.public_base_url,
        runtime_config_path=runtime_config_path,
        runninghub_api_key=api_key,
        audio_workflow_id=audio_workflow_id,
        video_workflow_id=video_workflow_id,
        source_video_path=_parse_path(values.get("source_video_path"), config.source_video_path),
        extracted_audio_path=_parse_path(values.get("extracted_audio_path"), config.extracted_audio_path),
        avatar_image_path=_parse_path(values.get("avatar_image_path"), config.avatar_image_path),
        cloned_audio_path=_parse_path(values.get("cloned_audio_path"), config.cloned_audio_path),
        final_video_path=_parse_path(values.get("final_video_path"), config.final_video_path),
        default_script_text=values.get("default_script_text") or config.default_script_text,
        poll_interval_seconds=float(values.get("poll_interval_seconds") or config.poll_interval_seconds),
    )
