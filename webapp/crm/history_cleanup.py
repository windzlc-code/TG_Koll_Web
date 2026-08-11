from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from typing import Any

from .errors import CRMError
from .repository import dumps, new_id, now_ts


def _required_key(value: Any, *, code: str, message_key: str, maximum: int = 160) -> str:
    clean = str(value or "").strip()
    if not clean or len(clean) > maximum:
        raise CRMError(code, message_key, status_code=400)
    return clean


def _audit_cleanup(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    current = now_ts()
    conn.execute(
        """
        INSERT INTO crm_events(
          id,user_id,event_type,occurred_at,payload_json,active,created_at,updated_at
        ) VALUES (?,?,?,?,?,1,?,?)
        """,
        (new_id("crm_event"), int(user_id), event_type, current, dumps(payload), current, current),
    )


def delete_tracking_campaign(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    campaign_id: str,
) -> dict[str, Any]:
    """Delete one tenant's raw click rows while retaining a durable audit event."""

    campaign = _required_key(
        campaign_id,
        code="crm_campaign_required",
        message_key="crm.errors.campaignRequired",
        maximum=120,
    )
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    result = conn.execute(
        "DELETE FROM crm_tracking_events WHERE user_id=? AND campaign_id=?",
        (int(user_id), campaign),
    )
    removed = max(int(result.rowcount or 0), 0)
    _audit_cleanup(
        conn,
        user_id=int(user_id),
        event_type="tracking_campaign_deleted",
        payload={"campaign_id": campaign, "removed": removed},
    )
    return {"ok": True, "campaign_id": campaign, "removed": removed}


def delete_outreach_campaign(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    campaign_id: str,
) -> dict[str, Any]:
    """Soft-delete tenant outreach history selected by its legacy/native campaign."""

    campaign = _required_key(
        campaign_id,
        code="crm_campaign_required",
        message_key="crm.errors.campaignRequired",
        maximum=120,
    )
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    current = now_ts()
    result = conn.execute(
        """
        UPDATE crm_events SET active=0,updated_at=?
        WHERE user_id=? AND active=1
          AND event_type NOT IN ('tracking_campaign_deleted','outreach_campaign_deleted','daily_runs_deleted')
          AND (
            json_extract(payload_json,'$.campaign')=?
            OR json_extract(payload_json,'$.campaign_id')=?
            OR json_extract(legacy_payload_json,'$.campaign')=?
            OR json_extract(legacy_payload_json,'$.campaign_id')=?
          )
        """,
        (current, int(user_id), campaign, campaign, campaign, campaign),
    )
    removed = max(int(result.rowcount or 0), 0)
    _audit_cleanup(
        conn,
        user_id=int(user_id),
        event_type="outreach_campaign_deleted",
        payload={"campaign_id": campaign, "removed": removed},
    )
    return {"ok": True, "campaign_id": campaign, "removed": removed}


def delete_daily_runs(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_ids: Iterable[Any],
) -> dict[str, Any]:
    """Soft-delete up to 500 completed daily-run workflows for one tenant."""

    ids = list(dict.fromkeys(str(item or "").strip() for item in workflow_ids))
    ids = [item for item in ids if item]
    if not ids or len(ids) > 500 or any(len(item) > 180 for item in ids):
        raise CRMError("crm_daily_run_ids_invalid", "crm.errors.dailyRunIdsInvalid", status_code=400)
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT id,status FROM crm_workflows
        WHERE user_id=? AND active=1 AND id IN ({placeholders})
          AND (workflow_type LIKE '%daily%' OR workflow_type LIKE '%scheduled%')
        """,
        (int(user_id), *ids),
    ).fetchall()
    unsafe = [
        str(row["id"])
        for row in rows
        if str(row["status"] or "") in {
            "draft", "awaiting_confirmation", "queued", "running",
            "manual_required", "paused_by_user", "paused_by_policy",
        }
    ]
    if unsafe:
        raise CRMError(
            "crm_daily_run_delete_unsafe",
            "crm.errors.dailyRunDeleteUnsafe",
            status_code=409,
            details={"workflow_ids": unsafe},
        )
    selected = [str(row["id"]) for row in rows]
    current = now_ts()
    deleted = 0
    if selected:
        selected_placeholders = ",".join("?" for _ in selected)
        result = conn.execute(
            f"UPDATE crm_workflows SET active=0,updated_at=? WHERE user_id=? AND id IN ({selected_placeholders})",
            (current, int(user_id), *selected),
        )
        deleted = max(int(result.rowcount or 0), 0)
    _audit_cleanup(
        conn,
        user_id=int(user_id),
        event_type="daily_runs_deleted",
        payload={"workflow_ids": selected, "deleted": deleted},
    )
    return {"ok": True, "deleted": deleted, "ids": selected}


__all__ = ["delete_daily_runs", "delete_outreach_campaign", "delete_tracking_campaign"]
