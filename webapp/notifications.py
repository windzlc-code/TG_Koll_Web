from __future__ import annotations

import json
import time
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import get_current_user, require_admin
from .db import db


NOTIFICATION_CATEGORIES = {"system", "official", "interaction"}
DEFAULT_NOTIFICATIONS = (
    (
        "system",
        "欢迎使用 Vecto 控制台",
        "任务状态、账号安全和系统维护提醒会集中显示在这里。",
        "notification-welcome-system-v1",
    ),
    (
        "official",
        "通知中心已上线",
        "现在可以在标题栏查看系统消息、官方消息与互动消息。",
        "notification-center-official-v1",
    ),
)


class NotificationReadPayload(BaseModel):
    ids: list[int] = Field(default_factory=list)
    category: str = ""
    all: bool = False


class NotificationBroadcastPayload(BaseModel):
    user_ids: list[int] = Field(default_factory=list)
    category: str = "official"
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=2000)
    action_url: str = Field(default="", max_length=500)
    action_label: str = Field(default="", max_length=60)
    source_key: str = Field(default="", max_length=160)
    expires_at: int = Field(default=0, ge=0)


def _now() -> int:
    return int(time.time())


def _user_id(user: dict[str, Any]) -> int:
    return int(user.get("_workspace_user_id") or user.get("id") or 0)


def _validate_category(value: str) -> str:
    category = str(value or "").strip().lower()
    if category not in NOTIFICATION_CATEGORIES:
        raise HTTPException(status_code=422, detail="消息分类无效")
    return category


def _seed_default_notifications(conn, user_id: int) -> None:
    now = _now()
    for category, title, body, source_key in DEFAULT_NOTIFICATIONS:
        conn.execute(
            """
            INSERT OR IGNORE INTO user_notifications (
              user_id, category, title, body, action_json, source_key, created_at
            ) VALUES (?, ?, ?, ?, '{}', ?, ?)
            """,
            (user_id, category, title, body, source_key, now),
        )


def _notification_row(row) -> dict[str, Any]:
    try:
        action = json.loads(str(row["action_json"] or "{}"))
    except (TypeError, ValueError):
        action = {}
    return {
        "id": int(row["id"]),
        "category": str(row["category"]),
        "title": str(row["title"]),
        "body": str(row["body"] or ""),
        "action": action if isinstance(action, dict) else {},
        "read": int(row["read_at"] or 0) > 0,
        "read_at": int(row["read_at"] or 0),
        "created_at": int(row["created_at"] or 0),
        "expires_at": int(row["expires_at"] or 0),
    }


def _unread_counts(conn, user_id: int) -> dict[str, int]:
    counts = {category: 0 for category in NOTIFICATION_CATEGORIES}
    rows = conn.execute(
        """
        SELECT category, COUNT(*) AS total
        FROM user_notifications
        WHERE user_id = ?
          AND read_at IS NULL
          AND (expires_at IS NULL OR expires_at = 0 OR expires_at > ?)
        GROUP BY category
        """,
        (user_id, _now()),
    ).fetchall()
    for row in rows:
        category = str(row["category"])
        if category in counts:
            counts[category] = int(row["total"] or 0)
    counts["total"] = sum(counts.values())
    return counts


def register_notification_routes(app: FastAPI) -> None:
    @app.get("/api/notifications")
    def api_notifications(
        category: str = "",
        limit: int = Query(default=100, ge=1, le=200),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        user_id = _user_id(user)
        if user_id <= 0:
            raise HTTPException(status_code=401, detail="登录状态无效")
        clean_category = str(category or "").strip().lower()
        if clean_category:
            clean_category = _validate_category(clean_category)
        with db() as conn:
            _seed_default_notifications(conn, user_id)
            filters = [
                "user_id = ?",
                "(expires_at IS NULL OR expires_at = 0 OR expires_at > ?)",
            ]
            params: list[Any] = [user_id, _now()]
            if clean_category:
                filters.append("category = ?")
                params.append(clean_category)
            params.append(limit)
            rows = conn.execute(
                f"""
                SELECT id, category, title, body, action_json, read_at, created_at, expires_at
                FROM user_notifications
                WHERE {' AND '.join(filters)}
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
            unread = _unread_counts(conn, user_id)
        return {"items": [_notification_row(row) for row in rows], "unread": unread}

    @app.post("/api/notifications/read")
    def api_notifications_read(
        payload: NotificationReadPayload,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        user_id = _user_id(user)
        if user_id <= 0:
            raise HTTPException(status_code=401, detail="登录状态无效")
        category = str(payload.category or "").strip().lower()
        if category:
            category = _validate_category(category)
        ids = sorted({int(item) for item in payload.ids if int(item) > 0})
        if not payload.all and not category and not ids:
            raise HTTPException(status_code=422, detail="请选择要标记的消息")
        filters = ["user_id = ?", "read_at IS NULL"]
        params: list[Any] = [user_id]
        if category:
            filters.append("category = ?")
            params.append(category)
        if ids:
            filters.append(f"id IN ({','.join('?' for _ in ids)})")
            params.extend(ids)
        with db() as conn:
            cursor = conn.execute(
                f"UPDATE user_notifications SET read_at = ? WHERE {' AND '.join(filters)}",
                [_now(), *params],
            )
            unread = _unread_counts(conn, user_id)
        return {"updated": int(cursor.rowcount or 0), "unread": unread}

    @app.post("/api/admin/notifications")
    def api_admin_notification_broadcast(
        payload: NotificationBroadcastPayload,
        _admin: dict[str, Any] = Depends(require_admin),
    ):
        category = _validate_category(payload.category)
        action = {
            "url": str(payload.action_url or "").strip(),
            "label": str(payload.action_label or "").strip(),
        }
        source_key = str(payload.source_key or "").strip()
        now = _now()
        with db() as conn:
            user_ids = sorted({int(item) for item in payload.user_ids if int(item) > 0})
            if not user_ids:
                user_ids = [
                    int(row["id"])
                    for row in conn.execute(
                        "SELECT id FROM users WHERE deleted_at = 0 AND approval_status = 'approved'"
                    ).fetchall()
                ]
            inserted = 0
            for user_id in user_ids:
                cursor = conn.execute(
                    """
                    INSERT OR IGNORE INTO user_notifications (
                      user_id, category, title, body, action_json, source_key,
                      created_at, expires_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        category,
                        payload.title.strip(),
                        payload.body.strip(),
                        json.dumps(action, ensure_ascii=False),
                        source_key,
                        now,
                        int(payload.expires_at or 0),
                    ),
                )
                inserted += max(0, int(cursor.rowcount or 0))
        return {"inserted": inserted, "recipients": len(user_ids)}
