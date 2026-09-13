from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


VIDEO_EDITOR_SUFFIXES = {
    ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv",
    ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".3gp", ".ogv",
}
_BROWSER_VIDEO_SUFFIXES = {".mp4", ".m4v", ".webm", ".ogv"}
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,96}$")
_EDITOR_LOCK = threading.RLock()


@dataclass(frozen=True)
class VideoEditorDependencies:
    get_current_user: Callable[..., dict[str, Any]]
    workspace_user_id: Callable[[dict[str, Any]], int]
    db_factory: Callable[..., Any]
    data_dir: Path
    extract_output_paths: Callable[[dict[str, Any]], list[str]]
    max_upload_bytes: int = 1024 * 1024 * 1024
    now_ts: Callable[[], int] = lambda: int(time.time())


class VideoProjectPayload(BaseModel):
    name: str = Field(default="未命名剪辑", max_length=120)
    clips: list[dict[str, Any]] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)


class VideoExportPayload(BaseModel):
    name: str = Field(default="", max_length=120)
    settings: dict[str, Any] = Field(default_factory=dict)


def _json_loads(value: Any, fallback: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    return parsed


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _safe_name(value: Any, fallback: str = "video") -> str:
    text = str(value or "").strip().replace("\x00", "")
    text = re.sub(r"[\\/:*?\"<>|]+", "_", text).strip(" ._")
    return (text[:120] or fallback)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _editor_root(data_dir: Path) -> Path:
    return (Path(data_dir).resolve() / "video_editor").resolve()


def _user_root(dependencies: VideoEditorDependencies, user_id: int) -> Path:
    root = (_editor_root(dependencies.data_dir) / str(int(user_id))).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _resolve_ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError("服务器缺少 FFmpeg，暂时无法处理视频。") from exc


def _resolve_ffprobe() -> str:
    found = shutil.which("ffprobe")
    if found:
        return found
    ffmpeg = Path(_resolve_ffmpeg())
    for candidate in (ffmpeg.with_name("ffprobe"), ffmpeg.with_name("ffprobe.exe")):
        if candidate.is_file():
            return str(candidate)
    return ""


def _compact_process_error(completed: subprocess.CompletedProcess[str], fallback: str) -> str:
    detail = str(completed.stderr or completed.stdout or fallback).strip()
    return detail[-1200:] if detail else fallback


def _probe_video(path: Path) -> dict[str, Any]:
    ffprobe = _resolve_ffprobe()
    if ffprobe:
        completed = subprocess.run(
            [
                ffprobe, "-v", "error", "-show_entries",
                "format=duration:stream=index,codec_type,codec_name,width,height",
                "-of", "json", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        if completed.returncode == 0:
            payload = _json_loads(completed.stdout, {})
            streams = payload.get("streams") if isinstance(payload.get("streams"), list) else []
            video = next((item for item in streams if item.get("codec_type") == "video"), {})
            audio = next((item for item in streams if item.get("codec_type") == "audio"), {})
            duration = float((payload.get("format") or {}).get("duration") or 0)
            if video and duration > 0:
                return {
                    "duration": round(duration, 3),
                    "width": int(video.get("width") or 0),
                    "height": int(video.get("height") or 0),
                    "video_codec": str(video.get("codec_name") or ""),
                    "audio_codec": str(audio.get("codec_name") or ""),
                    "has_audio": bool(audio),
                }
        raise RuntimeError(_compact_process_error(completed, "无法读取视频信息。"))

    completed = subprocess.run(
        [_resolve_ffmpeg(), "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    detail = f"{completed.stdout}\n{completed.stderr}"
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", detail)
    size_match = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", detail)
    if not duration_match or not size_match:
        raise RuntimeError("无法识别该视频，请确认文件未损坏。")
    duration = int(duration_match.group(1)) * 3600 + int(duration_match.group(2)) * 60 + float(duration_match.group(3))
    return {
        "duration": round(duration, 3),
        "width": int(size_match.group(1)),
        "height": int(size_match.group(2)),
        "video_codec": "",
        "audio_codec": "",
        "has_audio": "Audio:" in detail,
    }


def _ensure_preview(source: Path, asset_dir: Path, metadata: dict[str, Any]) -> Path:
    suffix = source.suffix.lower()
    video_codec = str(metadata.get("video_codec") or "").lower()
    audio_codec = str(metadata.get("audio_codec") or "").lower()
    browser_ready = suffix in _BROWSER_VIDEO_SUFFIXES and (
        suffix != ".mp4" or (video_codec in {"", "h264", "av1", "hevc"} and audio_codec in {"", "aac", "mp3"})
    )
    if browser_ready:
        return source
    target = asset_dir / "preview.mp4"
    completed = subprocess.run(
        [
            _resolve_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", str(target),
        ],
        capture_output=True,
        text=True,
        timeout=60 * 30,
        check=False,
    )
    if completed.returncode != 0 or not target.is_file() or target.stat().st_size <= 0:
        target.unlink(missing_ok=True)
        raise RuntimeError(_compact_process_error(completed, "视频预览转码失败。"))
    return target


def _build_thumbnail(source: Path, asset_dir: Path, duration: float) -> Path | None:
    target = asset_dir / "thumbnail.jpg"
    seek = max(0.0, min(float(duration or 0) / 3.0, 2.0))
    completed = subprocess.run(
        [
            _resolve_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{seek:.3f}",
            "-i", str(source), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", str(target),
        ],
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    return target if completed.returncode == 0 and target.is_file() and target.stat().st_size > 0 else None


def ensure_video_editor_schema(dependencies: VideoEditorDependencies) -> None:
    root = _editor_root(dependencies.data_dir)
    root.mkdir(parents=True, exist_ok=True)
    with dependencies.db_factory() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS video_assets (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              source_type TEXT NOT NULL,
              source_task_id TEXT NOT NULL DEFAULT '',
              source_ref TEXT NOT NULL DEFAULT '',
              name TEXT NOT NULL,
              original_path TEXT NOT NULL,
              preview_path TEXT NOT NULL,
              thumbnail_path TEXT NOT NULL DEFAULT '',
              mime_type TEXT NOT NULL DEFAULT 'video/mp4',
              size_bytes INTEGER NOT NULL DEFAULT 0,
              duration REAL NOT NULL DEFAULT 0,
              width INTEGER NOT NULL DEFAULT 0,
              height INTEGER NOT NULL DEFAULT 0,
              has_audio INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'ready',
              error TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              UNIQUE(user_id, source_task_id, source_ref)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_video_assets_user_created ON video_assets(user_id, created_at DESC)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS video_projects (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              timeline_json TEXT NOT NULL DEFAULT '[]',
              settings_json TEXT NOT NULL DEFAULT '{}',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_video_projects_user_updated ON video_projects(user_id, updated_at DESC)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS video_exports (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              user_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              status TEXT NOT NULL,
              progress INTEGER NOT NULL DEFAULT 0,
              timeline_json TEXT NOT NULL,
              settings_json TEXT NOT NULL,
              output_asset_id TEXT NOT NULL DEFAULT '',
              error TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_video_exports_user_created ON video_exports(user_id, created_at DESC)")
        conn.execute(
            "UPDATE video_exports SET status = 'failed', error = '服务重启导致导出中断，请重新导出。', updated_at = ? "
            "WHERE status IN ('queued', 'running')",
            (int(dependencies.now_ts()),),
        )


def _asset_row(dependencies: VideoEditorDependencies, user_id: int, asset_id: str) -> dict[str, Any]:
    if not _ASSET_ID_RE.fullmatch(str(asset_id or "")):
        raise HTTPException(status_code=404, detail="视频素材不存在。")
    with dependencies.db_factory() as conn:
        row = conn.execute("SELECT * FROM video_assets WHERE id = ? AND user_id = ?", (asset_id, int(user_id))).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="视频素材不存在。")
    return dict(row)


def _serialize_asset(row: dict[str, Any]) -> dict[str, Any]:
    asset_id = str(row.get("id") or "")
    return {
        "id": asset_id,
        "name": str(row.get("name") or "视频素材"),
        "source_type": str(row.get("source_type") or "upload"),
        "source_task_id": str(row.get("source_task_id") or ""),
        "mime_type": str(row.get("mime_type") or "video/mp4"),
        "size_bytes": int(row.get("size_bytes") or 0),
        "duration": round(float(row.get("duration") or 0), 3),
        "width": int(row.get("width") or 0),
        "height": int(row.get("height") or 0),
        "has_audio": bool(row.get("has_audio")),
        "status": str(row.get("status") or "ready"),
        "error": str(row.get("error") or ""),
        "created_at": int(row.get("created_at") or 0),
        "updated_at": int(row.get("updated_at") or 0),
        "media_url": f"/api/video/editor/assets/{asset_id}/media",
        "download_url": f"/api/video/editor/assets/{asset_id}/download",
        "thumbnail_url": f"/api/video/editor/assets/{asset_id}/thumbnail" if str(row.get("thumbnail_path") or "") else "",
    }


def _persist_video_asset(
    dependencies: VideoEditorDependencies,
    *,
    user_id: int,
    source: Path,
    name: str,
    source_type: str,
    source_task_id: str = "",
    source_ref: str = "",
    asset_id: str = "",
    copy_source: bool = True,
) -> dict[str, Any]:
    source = source.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in VIDEO_EDITOR_SUFFIXES:
        raise ValueError("无效的视频文件。")
    ref = str(source_ref or source)
    with _EDITOR_LOCK:
        if source_task_id or ref:
            with dependencies.db_factory() as conn:
                existing = conn.execute(
                    "SELECT * FROM video_assets WHERE user_id = ? AND source_task_id = ? AND source_ref = ?",
                    (int(user_id), str(source_task_id or ""), ref),
                ).fetchone()
            if existing is not None:
                return dict(existing)

        clean_id = asset_id or _new_id("video")
        asset_dir = (_user_root(dependencies, user_id) / "assets" / clean_id).resolve()
        if not _inside(asset_dir, _user_root(dependencies, user_id)):
            raise ValueError("无效的素材目录。")
        asset_dir.mkdir(parents=True, exist_ok=False)
        target = asset_dir / f"original{source.suffix.lower()}"
        try:
            if copy_source:
                shutil.copy2(source, target)
            else:
                target = source
            metadata = _probe_video(target)
            preview = _ensure_preview(target, asset_dir, metadata)
            thumbnail = _build_thumbnail(preview, asset_dir, float(metadata.get("duration") or 0))
            now = int(dependencies.now_ts())
            mime_type = mimetypes.guess_type(str(preview))[0] or "video/mp4"
            values = (
                clean_id, int(user_id), source_type, str(source_task_id or ""), ref,
                _safe_name(name, source.stem), str(target), str(preview), str(thumbnail or ""), mime_type,
                int(target.stat().st_size), float(metadata.get("duration") or 0), int(metadata.get("width") or 0),
                int(metadata.get("height") or 0), 1 if metadata.get("has_audio") else 0, "ready", "", now, now,
            )
            with dependencies.db_factory() as conn:
                conn.execute(
                    """
                    INSERT INTO video_assets(
                      id, user_id, source_type, source_task_id, source_ref, name, original_path, preview_path,
                      thumbnail_path, mime_type, size_bytes, duration, width, height, has_audio, status, error,
                      created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    values,
                )
            return {
                "id": clean_id, "user_id": int(user_id), "source_type": source_type,
                "source_task_id": str(source_task_id or ""), "source_ref": ref, "name": _safe_name(name, source.stem),
                "original_path": str(target), "preview_path": str(preview), "thumbnail_path": str(thumbnail or ""),
                "mime_type": mime_type, "size_bytes": int(target.stat().st_size), **metadata,
                "status": "ready", "error": "", "created_at": now, "updated_at": now,
            }
        except Exception:
            if copy_source and _inside(asset_dir, _editor_root(dependencies.data_dir)):
                shutil.rmtree(asset_dir, ignore_errors=True)
            raise


def capture_generated_video_assets(
    dependencies: VideoEditorDependencies,
    *,
    user_id: int,
    task_id: str,
    task_type: str,
    output_data: dict[str, Any],
) -> list[dict[str, Any]]:
    captured: list[dict[str, Any]] = []
    for index, value in enumerate(dependencies.extract_output_paths(output_data if isinstance(output_data, dict) else {})):
        path = Path(str(value or "")).expanduser()
        if not path.is_file() or path.suffix.lower() not in VIDEO_EDITOR_SUFFIXES:
            continue
        try:
            row = _persist_video_asset(
                dependencies,
                user_id=int(user_id),
                source=path,
                name=f"{path.stem or task_type} · 生成记录",
                source_type="generated",
                source_task_id=str(task_id or ""),
                source_ref=str(path.resolve()),
            )
            captured.append(_serialize_asset(row))
        except Exception:
            # A library copy must never turn a successful generation into a failed task.
            continue
    return captured


def _sync_generated_assets(dependencies: VideoEditorDependencies, user_id: int) -> None:
    with dependencies.db_factory() as conn:
        rows = conn.execute(
            "SELECT id, type, output_json FROM tasks WHERE user_id = ? AND status = 'success' ORDER BY created_at DESC, id DESC",
            (int(user_id),),
        ).fetchall()
    for row in rows:
        record = dict(row)
        capture_generated_video_assets(
            dependencies,
            user_id=int(user_id),
            task_id=str(record.get("id") or ""),
            task_type=str(record.get("type") or ""),
            output_data=_json_loads(record.get("output_json"), {}),
        )


def _project_row(dependencies: VideoEditorDependencies, user_id: int, project_id: str) -> dict[str, Any]:
    with dependencies.db_factory() as conn:
        row = conn.execute("SELECT * FROM video_projects WHERE id = ? AND user_id = ?", (project_id, int(user_id))).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="剪辑项目不存在。")
    return dict(row)


def _serialize_project(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id") or ""),
        "name": str(row.get("name") or "未命名剪辑"),
        "clips": _json_loads(row.get("timeline_json"), []),
        "settings": _json_loads(row.get("settings_json"), {}),
        "created_at": int(row.get("created_at") or 0),
        "updated_at": int(row.get("updated_at") or 0),
    }


def _normalise_project_payload(
    dependencies: VideoEditorDependencies,
    user_id: int,
    payload: VideoProjectPayload,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    if len(payload.clips) > 100:
        raise HTTPException(status_code=400, detail="单个项目最多包含 100 个片段。")
    asset_ids = {str(item.get("asset_id") or "") for item in payload.clips if isinstance(item, dict)}
    assets: dict[str, dict[str, Any]] = {}
    if asset_ids:
        placeholders = ",".join("?" for _ in asset_ids)
        with dependencies.db_factory() as conn:
            rows = conn.execute(
                f"SELECT * FROM video_assets WHERE user_id = ? AND id IN ({placeholders}) AND status = 'ready'",
                (int(user_id), *sorted(asset_ids)),
            ).fetchall()
        assets = {str(row["id"]): dict(row) for row in rows}
    if len(assets) != len(asset_ids):
        raise HTTPException(status_code=400, detail="时间线包含不存在或不可用的视频素材。")
    clips: list[dict[str, Any]] = []
    clip_ids: set[str] = set()
    track_cursors = [0.0, 0.0, 0.0]
    for index, raw in enumerate(payload.clips):
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="时间线片段格式错误。")
        asset_id = str(raw.get("asset_id") or "")
        asset = assets[asset_id]
        try:
            total = max(float(asset.get("duration") or 0), 0.001)
            start = max(float(raw.get("start") or 0), 0.0)
            end = float(raw.get("end") or total)
            volume = float(raw.get("volume") if raw.get("volume") is not None else 1)
            speed = float(raw.get("speed") if raw.get("speed") is not None else 1)
            track = int(raw.get("track") if raw.get("track") is not None else 0)
            timeline_start = float(raw.get("timeline_start")) if raw.get("timeline_start") is not None else track_cursors[max(0, min(2, track))]
            scale = float(raw.get("scale") if raw.get("scale") is not None else (0.42 if track else 1))
            position_x = float(raw.get("position_x") if raw.get("position_x") is not None else (0.94 if track else 0.5))
            position_y = float(raw.get("position_y") if raw.get("position_y") is not None else (0.06 if track else 0.5))
            opacity = float(raw.get("opacity") if raw.get("opacity") is not None else 1)
        except (TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 个片段包含无效数值。") from exc
        if not all(math.isfinite(value) for value in (total, start, end, volume, speed, timeline_start, scale, position_x, position_y, opacity)):
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 个片段包含无效数值。")
        if track < 0 or track > 2:
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 个片段的轨道无效。")
        end = min(max(end, 0), total)
        if start >= end or end - start < 0.05:
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 个片段的裁剪范围无效。")
        volume = min(max(volume, 0), 1)
        speed = min(max(speed, 0.5), 2)
        timeline_start = max(timeline_start, 0)
        scale = min(max(scale, 0.15), 1)
        position_x = min(max(position_x, 0), 1)
        position_y = min(max(position_y, 0), 1)
        opacity = min(max(opacity, 0.05), 1)
        clip_id = str(raw.get("id") or _new_id("clip"))[:96]
        if not _ASSET_ID_RE.fullmatch(clip_id) or clip_id in clip_ids:
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 个片段标识无效或重复。")
        clip_ids.add(clip_id)
        clips.append({
            "id": clip_id,
            "asset_id": asset_id,
            "start": round(start, 3),
            "end": round(end, 3),
            "volume": round(volume, 2),
            "speed": round(speed, 2),
            "track": track,
            "timeline_start": round(timeline_start, 3),
            "scale": round(scale, 2),
            "position_x": round(position_x, 2),
            "position_y": round(position_y, 2),
            "opacity": round(opacity, 2),
        })
        track_cursors[track] = max(track_cursors[track], timeline_start + (end - start) / speed)
    if max(track_cursors, default=0) > 6 * 60 * 60:
        raise HTTPException(status_code=400, detail="单个项目总时长不能超过 6 小时。")
    ratio = str(payload.settings.get("ratio") or "source")
    quality = str(payload.settings.get("quality") or "720p")
    markers: list[dict[str, Any]] = []
    for raw_marker in payload.settings.get("markers", []) if isinstance(payload.settings.get("markers", []), list) else []:
        if len(markers) >= 50 or not isinstance(raw_marker, dict):
            break
        try:
            marker_time = float(raw_marker.get("time") or 0)
        except (TypeError, ValueError, OverflowError):
            continue
        if math.isfinite(marker_time) and marker_time >= 0:
            markers.append({"id": str(raw_marker.get("id") or _new_id("marker"))[:96], "time": round(marker_time, 3)})
    settings = {
        "ratio": ratio if ratio in {"source", "16:9", "9:16", "1:1"} else "source",
        "quality": quality if quality in {"720p", "1080p"} else "720p",
        "markers": markers,
    }
    return _safe_name(payload.name, "未命名剪辑"), clips, settings


def _export_dimensions(settings: dict[str, Any], first_asset: dict[str, Any]) -> tuple[int, int]:
    high = str(settings.get("quality") or "720p") == "1080p"
    ratio = str(settings.get("ratio") or "source")
    if ratio == "9:16":
        return (1080, 1920) if high else (720, 1280)
    if ratio == "1:1":
        return (1080, 1080) if high else (720, 720)
    if ratio == "16:9":
        return (1920, 1080) if high else (1280, 720)
    width = int(first_asset.get("width") or 1280)
    height = int(first_asset.get("height") or 720)
    limit = 1920 if high else 1280
    scale = min(1.0, limit / max(width, height, 1))
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def _update_export(dependencies: VideoEditorDependencies, export_id: str, **updates: Any) -> None:
    allowed = {"status", "progress", "output_asset_id", "error"}
    fields = [(key, value) for key, value in updates.items() if key in allowed]
    if not fields:
        return
    clause = ", ".join(f"{key} = ?" for key, _ in fields)
    with dependencies.db_factory() as conn:
        conn.execute(
            f"UPDATE video_exports SET {clause}, updated_at = ? WHERE id = ?",
            (*[value for _, value in fields], int(dependencies.now_ts()), export_id),
        )


def _run_export(dependencies: VideoEditorDependencies, export_id: str) -> None:
    export_dir: Path | None = None
    try:
        with dependencies.db_factory() as conn:
            export_row = conn.execute("SELECT * FROM video_exports WHERE id = ?", (export_id,)).fetchone()
        if export_row is None:
            return
        export_record = dict(export_row)
        user_id = int(export_record["user_id"])
        clips = _json_loads(export_record.get("timeline_json"), [])
        settings = _json_loads(export_record.get("settings_json"), {})
        if not clips:
            raise RuntimeError("时间线为空，无法导出。")
        asset_ids = sorted({str(item.get("asset_id") or "") for item in clips})
        placeholders = ",".join("?" for _ in asset_ids)
        with dependencies.db_factory() as conn:
            rows = conn.execute(
                f"SELECT * FROM video_assets WHERE user_id = ? AND id IN ({placeholders}) AND status = 'ready'",
                (user_id, *asset_ids),
            ).fetchall()
        assets = {str(row["id"]): dict(row) for row in rows}
        if len(assets) != len(asset_ids):
            raise RuntimeError("时间线中的部分素材已不可用。")
        first_clip = min(clips, key=lambda item: (float(item.get("timeline_start") or 0), int(item.get("track") or 0)))
        width, height = _export_dimensions(settings, assets[str(first_clip.get("asset_id") or "")])
        export_dir = (_user_root(dependencies, user_id) / "exports" / export_id).resolve()
        export_dir.mkdir(parents=True, exist_ok=False)
        _update_export(dependencies, export_id, status="running", progress=2, error="")
        ffmpeg = _resolve_ffmpeg()
        total_duration = max(
            float(clip.get("timeline_start") or 0)
            + (float(clip.get("end") or 0) - float(clip.get("start") or 0)) / max(float(clip.get("speed") or 1), 0.5)
            for clip in clips
        )
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-t", f"{total_duration:.3f}", "-i", f"color=c=black:s={width}x{height}:r=30",
            "-f", "lavfi", "-t", f"{total_duration:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        ]
        for index, clip in enumerate(clips):
            asset = assets[str(clip.get("asset_id") or "")]
            source = Path(str(asset.get("original_path") or "")).resolve()
            if not source.is_file() or not _inside(source, _user_root(dependencies, user_id)):
                raise RuntimeError(f"第 {index + 1} 个素材文件已丢失。")
            start = float(clip.get("start") or 0)
            duration = float(clip.get("end") or 0) - start
            command += ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(source)]

        filters = [f"[0:v]trim=duration={total_duration:.3f},setpts=PTS-STARTPTS,format=rgba[canvas0]"]
        audio_labels: list[str] = []
        ordered = sorted(enumerate(clips), key=lambda pair: (int(pair[1].get("track") or 0), float(pair[1].get("timeline_start") or 0), pair[0]))
        canvas_label = "canvas0"
        for layer_index, (source_index, clip) in enumerate(ordered):
            input_index = source_index + 2
            speed = min(max(float(clip.get("speed") or 1), 0.5), 2)
            timeline_start = max(float(clip.get("timeline_start") or 0), 0)
            scale = min(max(float(clip.get("scale") if clip.get("scale") is not None else (0.42 if int(clip.get("track") or 0) else 1)), 0.15), 1)
            opacity = min(max(float(clip.get("opacity") if clip.get("opacity") is not None else 1), 0.05), 1)
            position_x = min(max(float(clip.get("position_x") if clip.get("position_x") is not None else 0.5), 0), 1)
            position_y = min(max(float(clip.get("position_y") if clip.get("position_y") is not None else 0.5), 0), 1)
            box_width = max(2, int(width * scale) // 2 * 2)
            box_height = max(2, int(height * scale) // 2 * 2)
            filters.append(
                f"[{input_index}:v]setpts=(PTS-STARTPTS)/{speed:.3f},fps=30,"
                f"scale={box_width}:{box_height}:force_original_aspect_ratio=decrease,format=rgba,"
                f"colorchannelmixer=aa={opacity:.3f},setpts=PTS+{timeline_start:.3f}/TB[v{source_index}]"
            )
            next_canvas = f"canvas{layer_index + 1}"
            filters.append(
                f"[{canvas_label}][v{source_index}]overlay=x='(W-w)*{position_x:.3f}':y='(H-h)*{position_y:.3f}':"
                f"eof_action=pass:repeatlast=0:shortest=0:format=auto[{next_canvas}]"
            )
            canvas_label = next_canvas
            asset = assets[str(clip.get("asset_id") or "")]
            if bool(asset.get("has_audio")):
                source_duration = float(clip.get("end") or 0) - float(clip.get("start") or 0)
                delay_ms = max(0, int(round(timeline_start * 1000)))
                volume = min(max(float(clip.get("volume") if clip.get("volume") is not None else 1), 0), 1)
                filters.append(
                    f"[{input_index}:a]atrim=duration={source_duration:.3f},asetpts=PTS-STARTPTS,"
                    f"atempo={speed:.3f},volume={volume:.2f},adelay={delay_ms}:all=1[a{source_index}]"
                )
                audio_labels.append(f"a{source_index}")
        filters.append(f"[{canvas_label}]trim=duration={total_duration:.3f},format=yuv420p[vout]")
        if not audio_labels:
            filters.append(f"[1:a]atrim=duration={total_duration:.3f},asetpts=PTS-STARTPTS[aout]")
        elif len(audio_labels) == 1:
            filters.append(f"[{audio_labels[0]}]apad=whole_dur={total_duration:.3f},atrim=duration={total_duration:.3f}[aout]")
        else:
            joined_audio = "".join(f"[{label}]" for label in audio_labels)
            filters.append(f"{joined_audio}amix=inputs={len(audio_labels)}:duration=longest:dropout_transition=0,apad=whole_dur={total_duration:.3f},atrim=duration={total_duration:.3f}[aout]")
        output = export_dir / "final.mp4"
        command += [
            "-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
            "-t", f"{total_duration:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", str(output),
        ]
        _update_export(dependencies, export_id, progress=15)
        completed = subprocess.run(command, capture_output=True, text=True, timeout=60 * 60, check=False)
        if completed.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
            raise RuntimeError(_compact_process_error(completed, "多轨合成视频失败。"))
        _update_export(dependencies, export_id, progress=90)
        row = _persist_video_asset(
            dependencies,
            user_id=user_id,
            source=output,
            name=str(export_record.get("name") or "剪辑成品"),
            source_type="export",
            source_task_id=export_id,
            source_ref=str(output),
            asset_id=_new_id("video"),
            copy_source=False,
        )
        _update_export(dependencies, export_id, status="success", progress=100, output_asset_id=str(row["id"]), error="")
    except Exception as exc:
        if export_dir is not None and _inside(export_dir, _editor_root(dependencies.data_dir)):
            shutil.rmtree(export_dir, ignore_errors=True)
        _update_export(dependencies, export_id, status="failed", progress=100, error=str(exc)[:1200])


def _serialize_export(row: dict[str, Any]) -> dict[str, Any]:
    asset_id = str(row.get("output_asset_id") or "")
    return {
        "id": str(row.get("id") or ""),
        "project_id": str(row.get("project_id") or ""),
        "name": str(row.get("name") or "剪辑成品"),
        "status": str(row.get("status") or "queued"),
        "progress": int(row.get("progress") or 0),
        "output_asset_id": asset_id,
        "media_url": f"/api/video/editor/assets/{asset_id}/media" if asset_id else "",
        "download_url": f"/api/video/editor/assets/{asset_id}/download" if asset_id else "",
        "error": str(row.get("error") or ""),
        "created_at": int(row.get("created_at") or 0),
        "updated_at": int(row.get("updated_at") or 0),
    }


def register_video_editor_routes(app: Any, dependencies: VideoEditorDependencies) -> dict[str, Any]:
    ensure_video_editor_schema(dependencies)

    async def upload_asset(
        video: UploadFile = File(...),
        user: dict[str, Any] = Depends(dependencies.get_current_user),
    ) -> dict[str, Any]:
        filename = str(video.filename or "")
        suffix = Path(filename).suffix.lower()
        if suffix not in VIDEO_EDITOR_SUFFIXES:
            await video.close()
            raise HTTPException(status_code=400, detail="不支持该视频格式。")
        user_id = int(dependencies.workspace_user_id(user))
        asset_id = _new_id("video")
        staging_dir = (_user_root(dependencies, user_id) / "staging" / asset_id).resolve()
        staging_dir.mkdir(parents=True, exist_ok=False)
        staging = staging_dir / f"upload{suffix}"
        written = 0
        try:
            with staging.open("wb") as handle:
                while True:
                    chunk = await video.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > int(dependencies.max_upload_bytes):
                        raise HTTPException(status_code=413, detail="上传文件过大。")
                    handle.write(chunk)
            if written <= 0:
                raise HTTPException(status_code=400, detail="上传文件为空。")
            try:
                row = _persist_video_asset(
                    dependencies,
                    user_id=user_id,
                    source=staging,
                    name=Path(filename).stem,
                    source_type="upload",
                    source_ref=f"upload:{asset_id}",
                    asset_id=asset_id,
                )
            except RuntimeError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            return {"asset": _serialize_asset(row)}
        finally:
            await video.close()
            shutil.rmtree(staging_dir, ignore_errors=True)

    def list_assets(
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=24, ge=1, le=1000),
        source_type: str = Query(default="", max_length=32),
        q: str = Query(default="", max_length=120),
        sync_generated: bool = Query(default=False),
        user: dict[str, Any] = Depends(dependencies.get_current_user),
    ) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        sync_generated = sync_generated if isinstance(sync_generated, bool) else False
        if sync_generated:
            _sync_generated_assets(dependencies, user_id)
        page = int(page) if isinstance(page, (int, str)) else 1
        page_size = int(page_size) if isinstance(page_size, (int, str)) else 24
        source_type = source_type if isinstance(source_type, str) else ""
        q = q if isinstance(q, str) else ""
        clean_type = str(source_type or "").strip().lower()
        if clean_type and clean_type not in {"generated", "upload", "export"}:
            raise HTTPException(status_code=400, detail="素材来源筛选无效。")
        clauses = ["user_id = ?", "status = 'ready'"]
        values: list[Any] = [user_id]
        if clean_type:
            clauses.append("source_type = ?")
            values.append(clean_type)
        clean_query = str(q or "").strip()
        if clean_query:
            clauses.append("name LIKE ? ESCAPE '\\'")
            escaped = clean_query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            values.append(f"%{escaped}%")
        where = " AND ".join(clauses)
        offset = (int(page) - 1) * int(page_size)
        with dependencies.db_factory() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) FROM video_assets WHERE {where}", values).fetchone()[0])
            rows = conn.execute(
                f"SELECT * FROM video_assets WHERE {where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                (*values, int(page_size), offset),
            ).fetchall()
        total_pages = (total + int(page_size) - 1) // int(page_size) if total else 0
        return {
            "items": [_serialize_asset(dict(row)) for row in rows],
            "page": int(page),
            "page_size": int(page_size),
            "total": total,
            "total_pages": total_pages,
            "supported_formats": sorted(VIDEO_EDITOR_SUFFIXES),
        }

    def serve_asset(asset_id: str, download: bool, user: dict[str, Any]) -> FileResponse:
        user_id = int(dependencies.workspace_user_id(user))
        row = _asset_row(dependencies, user_id, asset_id)
        path = Path(str(row.get("original_path") if download else row.get("preview_path") or row.get("original_path"))).resolve()
        root = _user_root(dependencies, user_id)
        if not _inside(path, root) or not path.is_file():
            raise HTTPException(status_code=404, detail="视频文件不存在。")
        return FileResponse(
            str(path),
            media_type=str(row.get("mime_type") or mimetypes.guess_type(str(path))[0] or "video/mp4"),
            filename=f"{_safe_name(row.get('name'), 'video')}{path.suffix}" if download else None,
            content_disposition_type="attachment" if download else "inline",
            headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"},
        )

    def media_endpoint(asset_id: str, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> FileResponse:
        return serve_asset(asset_id, False, user)

    def download_endpoint(asset_id: str, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> FileResponse:
        return serve_asset(asset_id, True, user)

    def thumbnail_endpoint(asset_id: str, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> FileResponse:
        user_id = int(dependencies.workspace_user_id(user))
        row = _asset_row(dependencies, user_id, asset_id)
        path = Path(str(row.get("thumbnail_path") or "")).resolve()
        if not str(row.get("thumbnail_path") or "") or not _inside(path, _user_root(dependencies, user_id)) or not path.is_file():
            raise HTTPException(status_code=404, detail="视频封面不存在。")
        return FileResponse(str(path), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})

    def delete_asset(asset_id: str, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        row = _asset_row(dependencies, user_id, asset_id)
        with dependencies.db_factory() as conn:
            projects = conn.execute("SELECT id, timeline_json FROM video_projects WHERE user_id = ?", (user_id,)).fetchall()
            if any(asset_id in {str(item.get("asset_id") or "") for item in _json_loads(item["timeline_json"], []) if isinstance(item, dict)} for item in projects):
                raise HTTPException(status_code=409, detail="该素材仍在剪辑项目中，请先从时间线移除。")
            conn.execute("DELETE FROM video_assets WHERE id = ? AND user_id = ?", (asset_id, user_id))
        paths = [Path(str(row.get(key) or "")) for key in ("original_path", "preview_path", "thumbnail_path") if str(row.get(key) or "")]
        parents = {path.resolve().parent for path in paths}
        root = _user_root(dependencies, user_id)
        for parent in parents:
            if _inside(parent, root) and parent != root:
                shutil.rmtree(parent, ignore_errors=True)
        return {"ok": True, "id": asset_id}

    def list_projects(user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        with dependencies.db_factory() as conn:
            rows = conn.execute("SELECT * FROM video_projects WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)).fetchall()
        return {"items": [_serialize_project(dict(row)) for row in rows]}

    def create_project(payload: VideoProjectPayload, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        name, clips, settings = _normalise_project_payload(dependencies, user_id, payload)
        project_id = _new_id("project")
        now = int(dependencies.now_ts())
        with dependencies.db_factory() as conn:
            conn.execute(
                "INSERT INTO video_projects(id, user_id, name, timeline_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (project_id, user_id, name, _json_dumps(clips), _json_dumps(settings), now, now),
            )
        return {"project": {"id": project_id, "name": name, "clips": clips, "settings": settings, "created_at": now, "updated_at": now}}

    def update_project(project_id: str, payload: VideoProjectPayload, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        _project_row(dependencies, user_id, project_id)
        name, clips, settings = _normalise_project_payload(dependencies, user_id, payload)
        now = int(dependencies.now_ts())
        with dependencies.db_factory() as conn:
            conn.execute(
                "UPDATE video_projects SET name = ?, timeline_json = ?, settings_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (name, _json_dumps(clips), _json_dumps(settings), now, project_id, user_id),
            )
        return {"project": {"id": project_id, "name": name, "clips": clips, "settings": settings, "updated_at": now}}

    def delete_project(project_id: str, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        _project_row(dependencies, user_id, project_id)
        with dependencies.db_factory() as conn:
            active = conn.execute(
                "SELECT 1 FROM video_exports WHERE project_id = ? AND user_id = ? AND status IN ('queued', 'running') LIMIT 1",
                (project_id, user_id),
            ).fetchone()
            if active is not None:
                raise HTTPException(status_code=409, detail="项目正在导出，暂时不能删除。")
            conn.execute("DELETE FROM video_projects WHERE id = ? AND user_id = ?", (project_id, user_id))
        return {"ok": True, "id": project_id}

    def start_export(project_id: str, payload: VideoExportPayload, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        project = _project_row(dependencies, user_id, project_id)
        clips = _json_loads(project.get("timeline_json"), [])
        if not clips:
            raise HTTPException(status_code=400, detail="请先把视频素材加入时间线。")
        settings = _json_loads(project.get("settings_json"), {})
        settings.update(payload.settings if isinstance(payload.settings, dict) else {})
        settings_payload = VideoProjectPayload(name=str(project.get("name") or ""), clips=clips, settings=settings)
        _, clips, settings = _normalise_project_payload(dependencies, user_id, settings_payload)
        export_id = _new_id("export")
        name = _safe_name(payload.name, f"{project.get('name') or '剪辑成品'}-导出")
        now = int(dependencies.now_ts())
        with dependencies.db_factory() as conn:
            active = conn.execute(
                "SELECT id FROM video_exports WHERE user_id = ? AND status IN ('queued', 'running') LIMIT 1",
                (user_id,),
            ).fetchone()
            if active is not None:
                raise HTTPException(status_code=409, detail="已有视频正在导出，请等待完成后再试。")
            conn.execute(
                """
                INSERT INTO video_exports(id, project_id, user_id, name, status, progress, timeline_json, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
                """,
                (export_id, project_id, user_id, name, _json_dumps(clips), _json_dumps(settings), now, now),
            )
        threading.Thread(target=_run_export, args=(dependencies, export_id), name=f"video-export-{export_id[-8:]}", daemon=True).start()
        return {"export": {"id": export_id, "project_id": project_id, "name": name, "status": "queued", "progress": 0, "created_at": now, "updated_at": now}}

    def list_exports(
        project_id: str = Query(default="", max_length=96),
        user: dict[str, Any] = Depends(dependencies.get_current_user),
    ) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        project_id = project_id if isinstance(project_id, str) else ""
        with dependencies.db_factory() as conn:
            if project_id:
                rows = conn.execute(
                    "SELECT * FROM video_exports WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
                    (user_id, project_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM video_exports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
                    (user_id,),
                ).fetchall()
        return {"items": [_serialize_export(dict(row)) for row in rows]}

    def get_export(export_id: str, user: dict[str, Any] = Depends(dependencies.get_current_user)) -> dict[str, Any]:
        user_id = int(dependencies.workspace_user_id(user))
        with dependencies.db_factory() as conn:
            row = conn.execute("SELECT * FROM video_exports WHERE id = ? AND user_id = ?", (export_id, user_id)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="导出任务不存在。")
        return {"export": _serialize_export(dict(row))}

    routes = [
        ("/api/video/editor/assets", list_assets, ["GET"], "video_editor_assets"),
        ("/api/video/editor/assets/upload", upload_asset, ["POST"], "video_editor_upload"),
        ("/api/video/editor/assets/{asset_id}/media", media_endpoint, ["GET"], "video_editor_media"),
        ("/api/video/editor/assets/{asset_id}/download", download_endpoint, ["GET"], "video_editor_download"),
        ("/api/video/editor/assets/{asset_id}/thumbnail", thumbnail_endpoint, ["GET"], "video_editor_thumbnail"),
        ("/api/video/editor/assets/{asset_id}", delete_asset, ["DELETE"], "video_editor_delete_asset"),
        ("/api/video/editor/projects", list_projects, ["GET"], "video_editor_projects"),
        ("/api/video/editor/projects", create_project, ["POST"], "video_editor_create_project"),
        ("/api/video/editor/projects/{project_id}", update_project, ["PUT"], "video_editor_update_project"),
        ("/api/video/editor/projects/{project_id}", delete_project, ["DELETE"], "video_editor_delete_project"),
        ("/api/video/editor/projects/{project_id}/export", start_export, ["POST"], "video_editor_start_export"),
        ("/api/video/editor/exports", list_exports, ["GET"], "video_editor_exports"),
        ("/api/video/editor/exports/{export_id}", get_export, ["GET"], "video_editor_export"),
    ]
    for path, endpoint, methods, name in routes:
        app.add_api_route(path, endpoint, methods=methods, name=name)
    return {"registered_paths": sorted({path for path, _, _, _ in routes})}


def server_video_editor_dependencies(server_module: Any) -> VideoEditorDependencies:
    return VideoEditorDependencies(
        get_current_user=server_module.get_current_user,
        workspace_user_id=server_module._workspace_user_id,
        db_factory=server_module.db,
        data_dir=Path(server_module.DATA_DIR),
        extract_output_paths=server_module._extract_download_paths,
        max_upload_bytes=int(getattr(server_module, "MAX_UPLOAD_BYTES", 1024 * 1024 * 1024)),
        now_ts=server_module._now_ts,
    )


__all__ = [
    "VIDEO_EDITOR_SUFFIXES",
    "VideoEditorDependencies",
    "capture_generated_video_assets",
    "ensure_video_editor_schema",
    "register_video_editor_routes",
    "server_video_editor_dependencies",
]
