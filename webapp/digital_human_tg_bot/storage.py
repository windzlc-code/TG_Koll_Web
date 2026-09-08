from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DDL_SETTINGS = """
CREATE TABLE IF NOT EXISTS workspace_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL
)
"""

DDL_MEMBERS = """
CREATE TABLE IF NOT EXISTS workspace_members (
    chat_id            INTEGER PRIMARY KEY,
    label              TEXT NOT NULL DEFAULT '',
    enabled            INTEGER NOT NULL DEFAULT 1,
    notify_busy        INTEGER NOT NULL DEFAULT 1,
    notify_available   INTEGER NOT NULL DEFAULT 1,
    created_at         REAL NOT NULL,
    updated_at         REAL NOT NULL
)
"""

DDL_TASKS = """
CREATE TABLE IF NOT EXISTS workspace_tasks (
    id                              TEXT PRIMARY KEY,
    submitter_chat_id               INTEGER,
    submitter_label                 TEXT NOT NULL DEFAULT '',
    source                          TEXT NOT NULL DEFAULT 'telegram',
    source_video_path               TEXT NOT NULL,
    avatar_image_path               TEXT NOT NULL,
    extracted_audio_path            TEXT,
    cloned_audio_path               TEXT,
    final_video_path                TEXT,
    work_dir                        TEXT NOT NULL,
    script_text                     TEXT NOT NULL DEFAULT '',
    target_duration_seconds         INTEGER,
    cloned_audio_duration_seconds   INTEGER,
    video_duration_seconds          INTEGER,
    audio_task_id                   TEXT,
    video_task_id                   TEXT,
    status                          TEXT NOT NULL DEFAULT 'queued',
    current_stage                   TEXT NOT NULL DEFAULT '',
    summary                         TEXT NOT NULL DEFAULT '',
    error_message                   TEXT NOT NULL DEFAULT '',
    is_default_assets               INTEGER NOT NULL DEFAULT 0,
    created_at                      REAL NOT NULL,
    started_at                      REAL,
    finished_at                     REAL,
    updated_at                      REAL NOT NULL
)
"""

DDL_TASK_EVENTS = """
CREATE TABLE IF NOT EXISTS workspace_task_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info',
    stage       TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL,
    created_at  REAL NOT NULL,
    FOREIGN KEY (task_id) REFERENCES workspace_tasks(id)
)
"""

IDX_TASKS_STATUS = """
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_status
ON workspace_tasks (status, created_at)
"""

IDX_TASK_EVENTS = """
CREATE INDEX IF NOT EXISTS idx_workspace_task_events_task
ON workspace_task_events (task_id, created_at)
"""

VALID_TASK_STATUS = {"queued", "processing", "completed", "failed", "cancelled"}


@dataclass(frozen=True)
class WorkspaceMember:
    chat_id: int
    label: str
    enabled: bool
    notify_busy: bool
    notify_available: bool
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class WorkspaceTask:
    id: str
    submitter_chat_id: int | None
    submitter_label: str
    source: str
    source_video_path: str
    avatar_image_path: str
    extracted_audio_path: str | None
    cloned_audio_path: str | None
    final_video_path: str | None
    work_dir: str
    script_text: str
    target_duration_seconds: int | None
    cloned_audio_duration_seconds: int | None
    video_duration_seconds: int | None
    audio_task_id: str | None
    video_task_id: str | None
    status: str
    current_stage: str
    summary: str
    error_message: str
    is_default_assets: bool
    created_at: float
    started_at: float | None
    finished_at: float | None
    updated_at: float


class WorkspaceStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = Path(database_path)

    def init_db(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(DDL_SETTINGS)
            conn.execute(DDL_MEMBERS)
            conn.execute(DDL_TASKS)
            conn.execute(DDL_TASK_EVENTS)
            conn.execute(IDX_TASKS_STATUS)
            conn.execute(IDX_TASK_EVENTS)
            conn.commit()

    def seed_members(self, chat_ids: tuple[int, ...]) -> None:
        now = time.time()
        with self._connect() as conn:
            for chat_id in chat_ids:
                conn.execute(
                    """
                    INSERT INTO workspace_members
                    (chat_id, label, enabled, notify_busy, notify_available, created_at, updated_at)
                    VALUES (?, ?, 1, 1, 1, ?, ?)
                    ON CONFLICT(chat_id) DO NOTHING
                    """,
                    (int(chat_id), f"TG-{chat_id}", now, now),
                )
            conn.commit()

    def list_members(self) -> list[WorkspaceMember]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT chat_id, label, enabled, notify_busy, notify_available, created_at, updated_at
                FROM workspace_members
                ORDER BY enabled DESC, chat_id ASC
                """
            ).fetchall()
        return [self._member_from_row(row) for row in rows]

    def get_member(self, chat_id: int) -> WorkspaceMember | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT chat_id, label, enabled, notify_busy, notify_available, created_at, updated_at
                FROM workspace_members
                WHERE chat_id = ?
                """,
                (int(chat_id),),
            ).fetchone()
        return self._member_from_row(row) if row else None

    def upsert_member(
        self,
        *,
        chat_id: int,
        label: str,
        enabled: bool,
        notify_busy: bool,
        notify_available: bool,
    ) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO workspace_members
                (chat_id, label, enabled, notify_busy, notify_available, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    label = excluded.label,
                    enabled = excluded.enabled,
                    notify_busy = excluded.notify_busy,
                    notify_available = excluded.notify_available,
                    updated_at = excluded.updated_at
                """,
                (
                    int(chat_id),
                    label.strip() or f"TG-{chat_id}",
                    int(enabled),
                    int(notify_busy),
                    int(notify_available),
                    now,
                    now,
                ),
            )
            conn.commit()

    def delete_member(self, chat_id: int) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM workspace_members WHERE chat_id = ?", (int(chat_id),))
            conn.commit()

    def is_authorized_chat(self, chat_id: int) -> bool:
        member = self.get_member(chat_id)
        return bool(member and member.enabled)

    def list_notification_members(self, *, kind: str) -> list[WorkspaceMember]:
        column = "notify_busy" if kind == "busy" else "notify_available"
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT chat_id, label, enabled, notify_busy, notify_available, created_at, updated_at
                FROM workspace_members
                WHERE enabled = 1 AND {column} = 1
                ORDER BY chat_id ASC
                """
            ).fetchall()
        return [self._member_from_row(row) for row in rows]

    def get_settings(self) -> dict[str, str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM workspace_settings").fetchall()
        return {str(row["key"]): str(row["value"]) for row in rows}

    def set_settings(self, values: dict[str, str]) -> None:
        now = time.time()
        with self._connect() as conn:
            for key, value in values.items():
                conn.execute(
                    """
                    INSERT INTO workspace_settings (key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at
                    """,
                    (key, str(value), now),
                )
            conn.commit()

    def create_task(
        self,
        *,
        task_id: str,
        submitter_chat_id: int | None,
        submitter_label: str,
        source: str,
        source_video_path: str,
        avatar_image_path: str,
        work_dir: str,
        script_text: str,
        target_duration_seconds: int | None,
        is_default_assets: bool,
    ) -> WorkspaceTask:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO workspace_tasks (
                    id, submitter_chat_id, submitter_label, source,
                    source_video_path, avatar_image_path, work_dir,
                    script_text, target_duration_seconds, status,
                    current_stage, summary, error_message,
                    is_default_assets, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, '', ?, ?, ?)
                """,
                (
                    task_id,
                    submitter_chat_id,
                    submitter_label.strip(),
                    source.strip() or "telegram",
                    source_video_path,
                    avatar_image_path,
                    work_dir,
                    script_text,
                    target_duration_seconds,
                    "任務已建立，等待工作台排隊",
                    "排隊中",
                    int(is_default_assets),
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, 'info', ?, ?, ?)
                """,
                (task_id, "任務建立", "任務已建立，等待工作台排隊", now),
            )
            conn.commit()
        task = self.get_task(task_id)
        if task is None:
            raise RuntimeError(f"建立任務後找不到紀錄: {task_id}")
        return task

    def list_tasks(self, *, status: str | None = None, limit: int = 100) -> list[WorkspaceTask]:
        sql = "SELECT * FROM workspace_tasks"
        params: list[Any] = []
        if status:
            sql += " WHERE status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [self._task_from_row(row) for row in rows]

    def get_task(self, task_id: str) -> WorkspaceTask | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM workspace_tasks WHERE id = ?",
                (task_id,),
            ).fetchone()
        return self._task_from_row(row) if row else None

    def get_latest_task_for_submitter(self, chat_id: int) -> WorkspaceTask | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM workspace_tasks
                WHERE submitter_chat_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (int(chat_id),),
            ).fetchone()
        return self._task_from_row(row) if row else None

    def get_latest_open_task_for_submitter(self, chat_id: int) -> WorkspaceTask | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM workspace_tasks
                WHERE submitter_chat_id = ?
                  AND status IN ('queued', 'processing')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (int(chat_id),),
            ).fetchone()
        return self._task_from_row(row) if row else None

    def get_task_events(self, task_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, task_id, level, stage, message, created_at
                FROM workspace_task_events
                WHERE task_id = ?
                ORDER BY created_at ASC, id ASC
                """,
                (task_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def append_task_event(self, task_id: str, *, stage: str, message: str, level: str = "info") -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (task_id, level, stage, message, now),
            )
            conn.commit()

    def update_task_progress(self, task_id: str, *, stage: str, summary: str | None = None) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE workspace_tasks
                SET current_stage = ?, summary = ?, updated_at = ?
                WHERE id = ?
                """,
                (stage, summary or stage, now, task_id),
            )
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, 'info', ?, ?, ?)
                """,
                (task_id, stage, summary or stage, now),
            )
            conn.commit()

    def mark_task_processing(self, task_id: str, *, stage: str) -> None:
        now = time.time()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE workspace_tasks
                SET status = 'processing',
                    current_stage = ?,
                    summary = ?,
                    started_at = COALESCE(started_at, ?),
                    updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (stage, stage, now, now, task_id),
            )
            if int(cursor.rowcount or 0) > 0:
                conn.execute(
                    """
                    INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                    VALUES (?, 'info', ?, ?, ?)
                    """,
                    (task_id, "開始處理", stage, now),
                )
            conn.commit()

    def mark_task_completed(
        self,
        task_id: str,
        *,
        extracted_audio_path: str,
        cloned_audio_path: str,
        final_video_path: str,
        cloned_audio_duration_seconds: int,
        video_duration_seconds: int,
        audio_task_id: str,
        video_task_id: str,
        summary: str,
    ) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE workspace_tasks
                SET status = 'completed',
                    current_stage = '任務完成',
                    summary = ?,
                    extracted_audio_path = ?,
                    cloned_audio_path = ?,
                    final_video_path = ?,
                    cloned_audio_duration_seconds = ?,
                    video_duration_seconds = ?,
                    audio_task_id = ?,
                    video_task_id = ?,
                    finished_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    summary,
                    extracted_audio_path,
                    cloned_audio_path,
                    final_video_path,
                    cloned_audio_duration_seconds,
                    video_duration_seconds,
                    audio_task_id,
                    video_task_id,
                    now,
                    now,
                    task_id,
                ),
            )
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, 'info', '任務完成', ?, ?)
                """,
                (task_id, summary, now),
            )
            conn.commit()

    def mark_task_failed(self, task_id: str, *, error_message: str) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE workspace_tasks
                SET status = 'failed',
                    current_stage = '任務失敗',
                    summary = '任務執行失敗，請查看詳情',
                    error_message = ?,
                    finished_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (error_message, now, now, task_id),
            )
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, 'error', '任務失敗', ?, ?)
                """,
                (task_id, error_message, now),
            )
            conn.commit()

    def cancel_task(self, task_id: str, *, reason: str) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE workspace_tasks
                SET status = 'cancelled',
                    current_stage = '任務已取消',
                    summary = ?,
                    error_message = ?,
                    finished_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (reason, reason, now, now, task_id),
            )
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, 'warning', '任務已取消', ?, ?)
                """,
                (task_id, reason, now),
            )
            conn.commit()

    def mark_task_cancellation_requested(self, task_id: str, *, reason: str) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE workspace_tasks
                SET current_stage = '停止中',
                    summary = '已收到強制停止指令，正在中止工作流',
                    updated_at = ?
                WHERE id = ? AND status = 'processing'
                """,
                (now, task_id),
            )
            conn.execute(
                """
                INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                VALUES (?, 'warning', '停止中', ?, ?)
                """,
                (task_id, reason, now),
            )
            conn.commit()

    def reset_stale_processing_tasks(self) -> None:
        now = time.time()
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id
                FROM workspace_tasks
                WHERE status = 'processing'
                ORDER BY updated_at ASC
                """
            ).fetchall()
            for row in rows:
                conn.execute(
                    """
                    UPDATE workspace_tasks
                    SET status = 'queued',
                        current_stage = '服務重新啟動，任務已重新排隊',
                        summary = '服務重新啟動，任務已重新排隊',
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (now, row["id"]),
                )
                conn.execute(
                    """
                    INSERT INTO workspace_task_events (task_id, level, stage, message, created_at)
                    VALUES (?, 'warning', '重新排隊', '服務重新啟動後自動恢復排隊', ?)
                    """,
                    (row["id"], now),
                )
            conn.commit()

    def get_next_queued_task(self) -> WorkspaceTask | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM workspace_tasks
                WHERE status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
                """
            ).fetchone()
        return self._task_from_row(row) if row else None

    def count_queued_before(self, task_id: str) -> int:
        task = self.get_task(task_id)
        if task is None:
            return 0
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(1) AS total
                FROM workspace_tasks
                WHERE status = 'queued' AND created_at < ?
                """,
                (task.created_at,),
            ).fetchone()
        return int(row["total"] or 0)

    def count_by_status(self) -> dict[str, int]:
        counts = {status: 0 for status in VALID_TASK_STATUS}
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT status, COUNT(1) AS total
                FROM workspace_tasks
                GROUP BY status
                """
            ).fetchall()
        for row in rows:
            counts[str(row["status"])] = int(row["total"])
        return counts

    def get_active_task(self) -> WorkspaceTask | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM workspace_tasks
                WHERE status = 'processing'
                ORDER BY started_at ASC
                LIMIT 1
                """
            ).fetchone()
        return self._task_from_row(row) if row else None

    def get_dashboard_snapshot(self) -> dict[str, Any]:
        active_task = self.get_active_task()
        counts = self.count_by_status()
        return {
            "active_task": active_task,
            "counts": counts,
            "queued_count": counts.get("queued", 0),
            "recent_tasks": self.list_tasks(limit=12),
            "members": self.list_members(),
        }

    def serialize_task(self, task: WorkspaceTask) -> dict[str, Any]:
        return {
            "id": task.id,
            "submitter_chat_id": task.submitter_chat_id,
            "submitter_label": task.submitter_label,
            "source": task.source,
            "source_video_path": task.source_video_path,
            "avatar_image_path": task.avatar_image_path,
            "extracted_audio_path": task.extracted_audio_path,
            "cloned_audio_path": task.cloned_audio_path,
            "final_video_path": task.final_video_path,
            "work_dir": task.work_dir,
            "script_text": task.script_text,
            "target_duration_seconds": task.target_duration_seconds,
            "cloned_audio_duration_seconds": task.cloned_audio_duration_seconds,
            "video_duration_seconds": task.video_duration_seconds,
            "audio_task_id": task.audio_task_id,
            "video_task_id": task.video_task_id,
            "status": task.status,
            "current_stage": task.current_stage,
            "summary": task.summary,
            "error_message": task.error_message,
            "is_default_assets": task.is_default_assets,
            "created_at": task.created_at,
            "started_at": task.started_at,
            "finished_at": task.finished_at,
            "updated_at": task.updated_at,
        }

    def export_settings_json(self) -> str:
        return json.dumps(self.get_settings(), ensure_ascii=False, indent=2)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.database_path))
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _member_from_row(row: sqlite3.Row) -> WorkspaceMember:
        return WorkspaceMember(
            chat_id=int(row["chat_id"]),
            label=str(row["label"] or ""),
            enabled=bool(row["enabled"]),
            notify_busy=bool(row["notify_busy"]),
            notify_available=bool(row["notify_available"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    @staticmethod
    def _task_from_row(row: sqlite3.Row) -> WorkspaceTask:
        return WorkspaceTask(
            id=str(row["id"]),
            submitter_chat_id=int(row["submitter_chat_id"]) if row["submitter_chat_id"] is not None else None,
            submitter_label=str(row["submitter_label"] or ""),
            source=str(row["source"] or ""),
            source_video_path=str(row["source_video_path"] or ""),
            avatar_image_path=str(row["avatar_image_path"] or ""),
            extracted_audio_path=str(row["extracted_audio_path"]) if row["extracted_audio_path"] else None,
            cloned_audio_path=str(row["cloned_audio_path"]) if row["cloned_audio_path"] else None,
            final_video_path=str(row["final_video_path"]) if row["final_video_path"] else None,
            work_dir=str(row["work_dir"] or ""),
            script_text=str(row["script_text"] or ""),
            target_duration_seconds=int(row["target_duration_seconds"]) if row["target_duration_seconds"] is not None else None,
            cloned_audio_duration_seconds=int(row["cloned_audio_duration_seconds"])
            if row["cloned_audio_duration_seconds"] is not None
            else None,
            video_duration_seconds=int(row["video_duration_seconds"]) if row["video_duration_seconds"] is not None else None,
            audio_task_id=str(row["audio_task_id"]) if row["audio_task_id"] else None,
            video_task_id=str(row["video_task_id"]) if row["video_task_id"] else None,
            status=str(row["status"] or ""),
            current_stage=str(row["current_stage"] or ""),
            summary=str(row["summary"] or ""),
            error_message=str(row["error_message"] or ""),
            is_default_assets=bool(row["is_default_assets"]),
            created_at=float(row["created_at"]),
            started_at=float(row["started_at"]) if row["started_at"] is not None else None,
            finished_at=float(row["finished_at"]) if row["finished_at"] is not None else None,
            updated_at=float(row["updated_at"]),
        )
