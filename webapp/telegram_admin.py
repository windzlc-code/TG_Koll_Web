from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import db, get_db_path

logger = logging.getLogger(__name__)

TELEGRAM_API_ROOT = "https://api.telegram.org"
DEFAULT_VIDEO_ENTRY = "/video.html"
_BOT_LOCK = threading.RLock()
_BOT_STOP = threading.Event()
_BOT_THREAD: threading.Thread | None = None
_BOT_OFFSET = 0
_BOT_STATUS: dict[str, Any] = {
    "running": False,
    "last_error": "",
    "bot_username": "",
    "updated_at": 0.0,
}

GetRuntime = Callable[[], dict[str, Any]]
SaveRuntime = Callable[[dict[str, Any]], None]


class TgEnvPayload(BaseModel):
    bot_token: str = ""
    allowed_chat_ids: str = ""
    bot_enabled: bool | None = None
    video_entry_url: str = ""


class TgTrustedUserPayload(BaseModel):
    chat_id: int | str
    label: str = Field(default="", max_length=120)
    enabled: bool = True
    notify_busy: bool = True
    notify_available: bool = True


class TgTrustedUserTogglePayload(BaseModel):
    enabled: bool = True


def ensure_telegram_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_trusted_users (
          chat_id INTEGER PRIMARY KEY,
          label TEXT NOT NULL DEFAULT '',
          tg_username TEXT NOT NULL DEFAULT '',
          tg_display_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          notify_busy INTEGER NOT NULL DEFAULT 1 CHECK(notify_busy IN (0, 1)),
          notify_available INTEGER NOT NULL DEFAULT 1 CHECK(notify_available IN (0, 1)),
          created_at REAL NOT NULL DEFAULT 0,
          updated_at REAL NOT NULL DEFAULT 0
        )
        """
    )
    columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(telegram_trusted_users)").fetchall()}
    if "tg_username" not in columns:
        conn.execute("ALTER TABLE telegram_trusted_users ADD COLUMN tg_username TEXT NOT NULL DEFAULT ''")
    if "tg_display_name" not in columns:
        conn.execute("ALTER TABLE telegram_trusted_users ADD COLUMN tg_display_name TEXT NOT NULL DEFAULT ''")


def _parse_chat_ids(text: str) -> list[int]:
    values: list[int] = []
    for chunk in str(text or "").replace(";", ",").split(","):
        item = chunk.strip()
        if not item:
            continue
        try:
            chat_id = int(item)
        except ValueError:
            continue
        if chat_id != 0:
            values.append(chat_id)
    return list(dict.fromkeys(values))


def _mask_token(token: str) -> str:
    text = str(token or "").strip()
    if not text:
        return ""
    if len(text) <= 10:
        return "••••"
    return f"{text[:6]}••••{text[-4:]}"


def _telegram_api(token: str, method: str, payload: dict[str, Any] | None = None, timeout: int = 20) -> dict[str, Any]:
    clean = str(token or "").strip()
    if not clean:
        raise RuntimeError("尚未配置 Telegram Bot Token")
    url = f"{TELEGRAM_API_ROOT}/bot{urllib.parse.quote(clean, safe='')}/{method}"
    body = json.dumps(payload if payload is not None else {}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "vecto-telegram-admin/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = json.loads(response.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            raw = json.loads(detail or "{}")
        except Exception:
            raise RuntimeError(f"Telegram API {method} 失败：HTTP {exc.code}") from exc
    except Exception as exc:
        raise RuntimeError(f"无法连接 Telegram API：{exc}") from exc
    if not isinstance(raw, dict) or not raw.get("ok"):
        description = ""
        if isinstance(raw, dict):
            description = str(raw.get("description") or raw.get("error_code") or "").strip()
        raise RuntimeError(description or f"Telegram API {method} 未成功")
    result = raw.get("result")
    return result if isinstance(result, dict) or isinstance(result, list) else {}


def verify_bot_token(token: str) -> dict[str, Any]:
    result = _telegram_api(token, "getMe", timeout=12)
    if not isinstance(result, dict):
        raise RuntimeError("Telegram getMe 返回异常")
    username = str(result.get("username") or "").strip()
    return {
        "ok": True,
        "id": result.get("id"),
        "username": username,
        "first_name": str(result.get("first_name") or "").strip(),
    }


def _chat_ref_candidates(chat_ref: int | str) -> list[int | str]:
    if isinstance(chat_ref, int):
        return [chat_ref, str(chat_ref)]
    text = str(chat_ref or "").strip()
    if not text:
        return []
    if text.startswith("@"):
        return [text]
    try:
        chat_id = int(text)
    except ValueError:
        return [text if text.startswith("@") else f"@{text.lstrip('@')}"]
    return [chat_id, str(chat_id)]


def fetch_telegram_chat_profile(token: str, chat_ref: int | str) -> dict[str, Any]:
    last_error: Exception | None = None
    for ref in _chat_ref_candidates(chat_ref):
        try:
            result = _telegram_api(token, "getChat", {"chat_id": ref}, timeout=12)
        except Exception as exc:
            last_error = exc
            continue
        if not isinstance(result, dict):
            last_error = RuntimeError("Telegram getChat 返回异常")
            continue
        username = str(result.get("username") or "").strip().lstrip("@")
        first_name = str(result.get("first_name") or "").strip()
        last_name = str(result.get("last_name") or "").strip()
        title = str(result.get("title") or "").strip()
        display_name = " ".join(part for part in (first_name, last_name) if part).strip() or title
        try:
            resolved_id = int(result.get("id") or 0)
        except (TypeError, ValueError):
            resolved_id = 0
        if not resolved_id:
            last_error = RuntimeError("Telegram getChat 未返回用户 ID")
            continue
        return {"chat_id": resolved_id, "username": username, "display_name": display_name}
    raise last_error or RuntimeError("Telegram getChat 未成功")


def _lookup_member_profile(token: str, chat_ref: int | str) -> dict[str, Any] | None:
    clean = str(token or "").strip()
    if not clean:
        return None
    try:
        return fetch_telegram_chat_profile(clean, chat_ref)
    except Exception as exc:
        logger.warning("Failed to fetch Telegram profile for %s: %s", chat_ref, exc)
        return None


def remember_trusted_user_profile(chat_id: int, *, username: str = "", display_name: str = "") -> None:
    member_id = int(chat_id or 0)
    next_username = str(username or "").strip().lstrip("@")
    next_display = str(display_name or "").strip()
    if not member_id or not (next_username or next_display):
        return
    with db() as conn:
        ensure_telegram_schema(conn)
        row = conn.execute(
            "SELECT tg_username, tg_display_name FROM telegram_trusted_users WHERE chat_id = ?",
            (member_id,),
        ).fetchone()
        if not row:
            return
        current_username = str(row["tg_username"] or "").strip().lstrip("@")
        current_display = str(row["tg_display_name"] or "").strip()
        saved_username = next_username or current_username
        saved_display = next_display or current_display
        if saved_username == current_username and saved_display == current_display:
            return
        conn.execute(
            """
            UPDATE telegram_trusted_users
            SET tg_username = ?, tg_display_name = ?, updated_at = ?
            WHERE chat_id = ?
            """,
            (saved_username, saved_display, time.time(), member_id),
        )


def _member_payload(row) -> dict[str, Any]:
    return {
        "chat_id": int(row["chat_id"]),
        "label": str(row["label"] or ""),
        "tg_username": str(row["tg_username"] or "").strip().lstrip("@"),
        "tg_display_name": str(row["tg_display_name"] or "").strip(),
        "enabled": bool(int(row["enabled"] or 0)),
        "notify_busy": bool(int(row["notify_busy"] or 0)),
        "notify_available": bool(int(row["notify_available"] or 0)),
        "created_at": float(row["created_at"] or 0),
        "updated_at": float(row["updated_at"] or 0),
    }


def _list_members() -> list[dict[str, Any]]:
    with db() as conn:
        ensure_telegram_schema(conn)
        rows = conn.execute(
            """
            SELECT chat_id, label, tg_username, tg_display_name, enabled, notify_busy, notify_available, created_at, updated_at
            FROM telegram_trusted_users
            ORDER BY enabled DESC, chat_id ASC
            """
        ).fetchall()
    return [_member_payload(row) for row in rows]


def _backfill_missing_member_profiles(token: str) -> None:
    clean = str(token or "").strip()
    if not clean:
        return
    for member in _list_members():
        if member.get("tg_username") or member.get("tg_display_name"):
            continue
        profile = _lookup_member_profile(clean, int(member["chat_id"]))
        if not profile or not (profile.get("username") or profile.get("display_name")):
            continue
        with db() as conn:
            ensure_telegram_schema(conn)
            conn.execute(
                """
                UPDATE telegram_trusted_users
                SET tg_username = ?, tg_display_name = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (profile["username"], profile["display_name"], time.time(), int(member["chat_id"])),
            )


def load_tg_settings(get_runtime: GetRuntime) -> dict[str, Any]:
    runtime = get_runtime() or {}
    token = str(runtime.get("telegram_bot_token") or "").strip()
    allowed = _parse_chat_ids(str(runtime.get("telegram_allowed_chat_ids") or ""))
    enabled = bool(runtime.get("telegram_bot_enabled"))
    entry = str(runtime.get("telegram_video_entry_url") or DEFAULT_VIDEO_ENTRY).strip() or DEFAULT_VIDEO_ENTRY
    with _BOT_LOCK:
        status = dict(_BOT_STATUS)
    _backfill_missing_member_profiles(token)
    return {
        "ok": True,
        "bot_token_configured": bool(token),
        "bot_token_masked": _mask_token(token),
        "bot_token_length": len(token),
        "bot_enabled": enabled,
        "bot_running": bool(status.get("running")),
        "bot_username": str(status.get("bot_username") or ""),
        "bot_last_error": str(status.get("last_error") or ""),
        "allowed_chat_ids_env": allowed,
        "video_entry_url": entry,
        "trusted_users": _list_members(),
    }


def save_tg_env(payload: TgEnvPayload, get_runtime: GetRuntime, save_runtime: SaveRuntime) -> dict[str, Any]:
    runtime = dict(get_runtime() or {})
    updates: dict[str, Any] = {}
    if "bot_token" in payload.model_fields_set:
        token = str(payload.bot_token or "").strip()
        if token:
            if "***" in token or "•" in token:
                raise HTTPException(status_code=400, detail="请填写完整的 Telegram Bot Token，不要提交掩码。")
            verify_bot_token(token)
            updates["telegram_bot_token"] = token
        else:
            updates["telegram_bot_token"] = ""
            if payload.bot_enabled is None:
                updates["telegram_bot_enabled"] = False
    if str(payload.allowed_chat_ids or "").strip() or "allowed_chat_ids" in payload.model_fields_set:
        updates["telegram_allowed_chat_ids"] = ",".join(str(item) for item in _parse_chat_ids(payload.allowed_chat_ids))
    if payload.bot_enabled is not None:
        updates["telegram_bot_enabled"] = bool(payload.bot_enabled)
    entry = str(payload.video_entry_url or "").strip()
    if entry:
        if not entry.startswith("/"):
            raise HTTPException(status_code=400, detail="视频工作台入口必须是站内路径，例如 /video.html")
        updates["telegram_video_entry_url"] = entry
    if not updates:
        raise HTTPException(status_code=400, detail="请至少填写一项需要更新的 Telegram 配置")
    next_runtime = dict(runtime)
    next_runtime.update(updates)
    next_token = str(next_runtime.get("telegram_bot_token") or "").strip()
    if not next_token:
        next_runtime["telegram_bot_enabled"] = False
        updates["telegram_bot_enabled"] = False
    if next_runtime.get("telegram_bot_enabled") and next_token:
        verify_bot_token(next_token)
    save_runtime(next_runtime)
    reload_telegram_bot_worker(get_runtime)
    settings = load_tg_settings(get_runtime)
    settings["restart_required"] = False
    return {"ok": True, "tg_settings": settings}


def upsert_trusted_user(payload: TgTrustedUserPayload, get_runtime: GetRuntime | None = None) -> None:
    raw_ref = payload.chat_id
    chat_id = 0
    username_ref = ""
    if isinstance(raw_ref, int):
        chat_id = raw_ref
    else:
        text = str(raw_ref or "").strip()
        if text.startswith("@"):
            username_ref = text.lstrip("@")
        else:
            try:
                chat_id = int(text)
            except ValueError:
                username_ref = text.lstrip("@")
    token = ""
    if get_runtime is not None:
        token = str((get_runtime() or {}).get("telegram_bot_token") or "").strip()
    profile = None
    if token and username_ref:
        profile = _lookup_member_profile(token, f"@{username_ref}")
        if not profile or not int(profile.get("chat_id") or 0):
            raise HTTPException(status_code=400, detail="无法通过 @用户名读取该 Telegram 用户，请改填 Chat ID，或确认用户名公开且 Bot Token 有效。")
        chat_id = int(profile["chat_id"])
    elif token and chat_id:
        profile = _lookup_member_profile(token, chat_id)
    if chat_id == 0:
        raise HTTPException(status_code=400, detail="请填写有效的 Chat ID 或 @用户名")
    profile_username = str((profile or {}).get("username") or username_ref or "").strip().lstrip("@")
    profile_display = str((profile or {}).get("display_name") or "").strip()
    now = time.time()
    with db() as conn:
        ensure_telegram_schema(conn)
        existing = conn.execute(
            """
            SELECT chat_id, label, tg_username, tg_display_name
            FROM telegram_trusted_users
            WHERE chat_id = ?
            """,
            (chat_id,),
        ).fetchone()
        if existing and not (profile_username or profile_display):
            profile_username = str(existing["tg_username"] or "").strip().lstrip("@")
            profile_display = str(existing["tg_display_name"] or "").strip()
        label = str(payload.label or "").strip()
        if not label:
            if existing and str(existing["label"] or "").strip():
                label = str(existing["label"] or "").strip()
            else:
                label = profile_display or (f"@{profile_username}" if profile_username else f"TG-{chat_id}")
        values = (
            label,
            profile_username,
            profile_display,
            1 if payload.enabled else 0,
            1 if payload.notify_busy else 0,
            1 if payload.notify_available else 0,
            now,
            chat_id,
        )
        if existing:
            conn.execute(
                """
                UPDATE telegram_trusted_users
                SET label = ?, tg_username = ?, tg_display_name = ?, enabled = ?, notify_busy = ?, notify_available = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                values,
            )
        else:
            conn.execute(
                """
                INSERT INTO telegram_trusted_users(
                  chat_id, label, tg_username, tg_display_name, enabled, notify_busy, notify_available, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    label,
                    profile_username,
                    profile_display,
                    1 if payload.enabled else 0,
                    1 if payload.notify_busy else 0,
                    1 if payload.notify_available else 0,
                    now,
                    now,
                ),
            )


def toggle_trusted_user(chat_id: int, enabled: bool) -> None:
    with db() as conn:
        ensure_telegram_schema(conn)
        row = conn.execute("SELECT chat_id FROM telegram_trusted_users WHERE chat_id = ?", (int(chat_id),)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="找不到该 TG 用户 ID")
        conn.execute(
            "UPDATE telegram_trusted_users SET enabled = ?, updated_at = ? WHERE chat_id = ?",
            (1 if enabled else 0, time.time(), int(chat_id)),
        )


def delete_trusted_user(chat_id: int) -> None:
    with db() as conn:
        ensure_telegram_schema(conn)
        conn.execute("DELETE FROM telegram_trusted_users WHERE chat_id = ?", (int(chat_id),))


def _authorized_chat_ids(runtime: dict[str, Any]) -> set[int]:
    allowed = set(_parse_chat_ids(str(runtime.get("telegram_allowed_chat_ids") or "")))
    for member in _list_members():
        if member.get("enabled"):
            allowed.add(int(member["chat_id"]))
    return allowed


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _prepare_bot_env() -> None:
    data_dir = str(os.getenv("WEBAPP_DATA_DIR") or "").strip() or str((_project_root() / "webapp_data").resolve())
    os.environ.setdefault("WEBAPP_DATA_DIR", data_dir)
    os.environ["WEBAPP_DB_PATH"] = get_db_path()
    port = str(os.getenv("WEBAPP_PORT") or "8001").strip() or "8001"
    os.environ.setdefault("TG_INTERNAL_WEBAPP_BASE_URL", f"http://127.0.0.1:{port}")
    os.environ.setdefault("TG_INTERNAL_API_TOKEN", "vecto-local-tg-internal")


def _build_original_app_config(runtime: dict[str, Any]):
    from .digital_human_tg_bot.config import AppConfig, DEFAULT_SCRIPT_TEXT, DEFAULT_ASSET_ROOT

    token = str(runtime.get("telegram_bot_token") or "").strip()
    seed_ids = tuple(_authorized_chat_ids(runtime))
    root = _project_root()
    data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR") or (root / "webapp_data"))).expanduser().resolve()
    jobs_dir = (data_dir / "tg_jobs").resolve()
    database_path = Path(str(os.getenv("TG_WORKBENCH_DB_PATH") or (data_dir / "workbench.db"))).expanduser().resolve()
    jobs_dir.mkdir(parents=True, exist_ok=True)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    public_base = str(runtime.get("telegram_video_entry_url") or DEFAULT_VIDEO_ENTRY).strip() or DEFAULT_VIDEO_ENTRY
    if public_base.startswith("/"):
        site = str(os.getenv("PUBLIC_BASE_URL") or os.getenv("VECTO_PUBLIC_BASE_URL") or "https://www.vecto-ai.cn").strip().rstrip("/")
        public_base = f"{site}{public_base}"
    runninghub_key = str(
        runtime.get("video_runninghub_api_key")
        or runtime.get("runninghub_api_key")
        or os.getenv("ENGINE_API_KEY")
        or os.getenv("RUNNINGHUB_API_KEY")
        or ""
    ).strip()
    return AppConfig(
        project_root=root,
        data_dir=data_dir,
        jobs_dir=jobs_dir,
        database_path=database_path,
        templates_dir=(root / "templates").resolve(),
        static_dir=(root / "webapp" / "static").resolve(),
        app_title=str(runtime.get("app_title") or "视频工作台").strip() or "视频工作台",
        web_host="127.0.0.1",
        web_port=int(str(os.getenv("WEBAPP_PORT") or "8001").strip() or "8001"),
        public_base_url=public_base,
        runtime_config_path=Path(str(os.getenv("APP_RUNTIME_CONFIG_PATH") or (data_dir / "runtime_config.json"))).expanduser().resolve(),
        tg_bot_token=token,
        tg_seed_chat_ids=seed_ids,
        runninghub_api_key=runninghub_key or "unset",
        audio_workflow_id=str(runtime.get("video_create_audio_app_id") or runtime.get("create_audio_app_id") or "").strip(),
        video_workflow_id=str(runtime.get("video_create_video_app_id") or runtime.get("create_video_app_id") or "").strip(),
        source_video_path=Path(DEFAULT_ASSET_ROOT) / "擷取視頻.mp4",
        extracted_audio_path=Path(DEFAULT_ASSET_ROOT) / "擷取音頻.mp4",
        avatar_image_path=Path(DEFAULT_ASSET_ROOT) / "數字人照片.jpg",
        cloned_audio_path=Path(DEFAULT_ASSET_ROOT) / "口播文案音頻1.flac",
        final_video_path=Path(DEFAULT_ASSET_ROOT) / "結果1.mp4",
        default_script_text=DEFAULT_SCRIPT_TEXT,
        poll_interval_seconds=5.0,
    )


def _sync_store_members(service, runtime: dict[str, Any]) -> None:
    service.store.init_db()
    seed = tuple(_authorized_chat_ids(runtime))
    if seed:
        service.store.seed_members(seed)
    for member in _list_members():
        service.upsert_member(
            chat_id=int(member["chat_id"]),
            label=str(member.get("label") or f"TG-{member['chat_id']}"),
            enabled=bool(member.get("enabled")),
            notify_busy=bool(member.get("notify_busy")),
            notify_available=bool(member.get("notify_available")),
        )


async def _run_original_bot(get_runtime: GetRuntime) -> None:
    from .digital_human_tg_bot.bot import TelegramWorkbenchBot
    from .digital_human_tg_bot.storage import WorkspaceStore
    from .digital_human_tg_bot.workbench import WorkspaceService

    _prepare_bot_env()
    current: Any = None
    while not _BOT_STOP.is_set():
        runtime = get_runtime() or {}
        token = str(runtime.get("telegram_bot_token") or "").strip()
        enabled = bool(runtime.get("telegram_bot_enabled"))
        if not token or not enabled:
            if current is not None:
                try:
                    await current.stop()
                except Exception:
                    logger.exception("Failed to stop Telegram bot while disabled")
                current = None
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": False, "last_error": "未启用或未配置 Token", "updated_at": time.time()})
            await asyncio.sleep(5)
            continue
        try:
            me = verify_bot_token(token)
            config = _build_original_app_config(runtime)
            store = WorkspaceStore(config.database_path)
            service = WorkspaceService(config, store)
            _sync_store_members(service, runtime)
            bot = TelegramWorkbenchBot(config, service)
            await bot.start()
            current = bot
            with _BOT_LOCK:
                _BOT_STATUS.update({
                    "running": True,
                    "last_error": "",
                    "bot_username": str(me.get("username") or ""),
                    "updated_at": time.time(),
                })
            while not _BOT_STOP.is_set():
                latest = get_runtime() or {}
                latest_token = str(latest.get("telegram_bot_token") or "").strip()
                latest_enabled = bool(latest.get("telegram_bot_enabled"))
                if latest_token != token or (not latest_enabled):
                    break
                await asyncio.sleep(2)
        except Exception as exc:
            logger.exception("Original Telegram workbench bot stopped unexpectedly")
            with _BOT_LOCK:
                _BOT_STATUS.update({"running": False, "last_error": str(exc)[:400], "updated_at": time.time()})
            await asyncio.sleep(8)
        finally:
            if current is not None:
                try:
                    await current.stop()
                except Exception:
                    logger.exception("Failed to stop Telegram workbench bot")
                current = None


def _bot_thread_main(get_runtime: GetRuntime) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_run_original_bot(get_runtime))
    finally:
        loop.close()


def start_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    global _BOT_THREAD
    with _BOT_LOCK:
        if _BOT_THREAD and _BOT_THREAD.is_alive():
            return
        _BOT_STOP.clear()
        _BOT_THREAD = threading.Thread(target=_bot_thread_main, args=(get_runtime,), name="vecto-telegram-bot", daemon=True)
        _BOT_THREAD.start()


def stop_telegram_bot_worker() -> None:
    _BOT_STOP.set()


def reload_telegram_bot_worker(get_runtime: GetRuntime) -> None:
    stop_telegram_bot_worker()
    thread = None
    with _BOT_LOCK:
        thread = _BOT_THREAD
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=8)
    start_telegram_bot_worker(get_runtime)


def inject_telegram_admin(
    app,
    *,
    require_admin: Callable,
    get_runtime: GetRuntime,
    save_runtime: SaveRuntime,
) -> None:
    router = APIRouter()

    @router.get("/api/admin/tg_settings")
    def api_admin_tg_settings(_user: dict[str, Any] = Depends(require_admin)):
        return load_tg_settings(get_runtime)

    @router.put("/api/admin/tg_env")
    def api_admin_set_tg_env(payload: TgEnvPayload, _user: dict[str, Any] = Depends(require_admin)):
        return save_tg_env(payload, get_runtime, save_runtime)

    @router.post("/api/admin/tg_env/test")
    def api_admin_test_tg_env(payload: TgEnvPayload, _user: dict[str, Any] = Depends(require_admin)):
        runtime = get_runtime() or {}
        token = str(payload.bot_token or "").strip() or str(runtime.get("telegram_bot_token") or "").strip()
        if not token or "***" in token or "•" in token:
            raise HTTPException(status_code=400, detail="请填写完整 Token，或先保存后再检测。")
        info = verify_bot_token(token)
        return {"ok": True, "username": info.get("username") or "", "id": info.get("id")}

    @router.post("/api/admin/tg_trusted_users")
    def api_admin_upsert_tg_trusted_user(payload: TgTrustedUserPayload, _user: dict[str, Any] = Depends(require_admin)):
        upsert_trusted_user(payload, get_runtime)
        return {"ok": True, "tg_settings": load_tg_settings(get_runtime)}

    @router.post("/api/admin/tg_trusted_users/{chat_id}/toggle")
    def api_admin_toggle_tg_trusted_user(
        chat_id: int,
        payload: TgTrustedUserTogglePayload,
        _user: dict[str, Any] = Depends(require_admin),
    ):
        toggle_trusted_user(chat_id, payload.enabled)
        return {"ok": True, "tg_settings": load_tg_settings(get_runtime)}

    @router.delete("/api/admin/tg_trusted_users/{chat_id}")
    def api_admin_delete_tg_trusted_user(chat_id: int, _user: dict[str, Any] = Depends(require_admin)):
        delete_trusted_user(chat_id)
        return {"ok": True, "tg_settings": load_tg_settings(get_runtime)}

    app.include_router(router)
    start_telegram_bot_worker(get_runtime)
