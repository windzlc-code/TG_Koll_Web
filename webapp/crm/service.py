from __future__ import annotations

import os
import shutil
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import quote

from webapp.db import get_admin_config, set_admin_config

from .repository import (
    Adapter,
    action_spec,
    dumps,
    dispatch_next_action_atomic,
    get_workflow,
    loads,
    now_ts,
    transition_action_state_atomic,
    update_workflow_status,
)
from .task_watchdog import classify_task_attention

MODULE_KEY = "crm"
MODULE_CONFIG_KEY = "crm_module_settings_v1"
DEFAULT_MODULE_SETTINGS = {
    "enabled": False,
    "maintenance": False,
    "emergency_pause": False,
    "migration_required": False,
    "version": 1,
}


def _write_result_confirmed(action_type: str, result: dict[str, Any]) -> bool:
    """Require action-specific platform proof before a billed write can settle."""

    if not isinstance(result, dict):
        return False
    if str(result.get("published_url") or result.get("permalink") or "").startswith("https://"):
        return True
    published = result.get("published")
    if isinstance(published, dict) and published.get("confirmed") is True and str(
        published.get("url") or published.get("permalink") or ""
    ).startswith("https://"):
        return True
    if result.get("verified") is not True:
        return False
    # Every non-publish write worker must name the proof it observed. Group and
    # direct-message workers predate the normalized confirmation_source field,
    # so their explicit verified flag plus a concrete conversation/inspection
    # URL remains accepted during the native migration.
    if str(result.get("confirmation_source") or result.get("submit_evidence") or "").strip():
        return True
    if str(action_type) == "direct_message":
        return bool(str(result.get("conversation_url") or result.get("inspected_url") or "").strip())
    if str(action_type).startswith("instagram_group_"):
        return bool(str(result.get("target_url") or result.get("inspected_url") or "").strip())
    return result.get("platform_visible") is True


def _normalized_action_evidence(social_task_id: str, result: dict[str, Any]) -> dict[str, Any]:
    raw = dict(result or {}) if isinstance(result, dict) else {}
    screenshot_path = str(raw.get("screenshot_path") or "").strip()
    screenshot_url = ""
    if screenshot_path:
        filename = Path(screenshot_path).name
        if filename:
            screenshot_url = f"/api/persona_dashboard/automation/screenshots/{quote(filename)}"
    platform_url = str(
        raw.get("published_url")
        or raw.get("permalink")
        or raw.get("inspected_url")
        or raw.get("conversation_url")
        or raw.get("target_url")
        or raw.get("url")
        or ""
    ).strip()
    return {
        "social_task_id": str(social_task_id),
        "platform": str(raw.get("platform") or ""),
        "status": str(raw.get("status") or ("confirmed" if raw.get("verified") is True else "")),
        "verified": raw.get("verified") is True or raw.get("platform_visible") is True,
        "platform_visible": raw.get("platform_visible") is True,
        "submitted": raw.get("submitted") is True,
        "confirmation_source": str(raw.get("confirmation_source") or raw.get("submit_evidence") or ""),
        "platform_url": platform_url if platform_url.startswith("https://") else "",
        "screenshot_url": screenshot_url,
        "content_hash": str(raw.get("content_hash") or ""),
        "result": raw,
    }


def _record_confirmed_action_event(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    action_id: str,
    action_type: str,
    account_id: str,
    target_key: str,
    payload: dict[str, Any],
    result: dict[str, Any],
) -> None:
    tracked = {
        "public_comment", "public_reply", "followup_reply", "nurture_reply",
        "like", "share", "repost", "direct_message", "threads_group_invite_post",
        "instagram_group_create", "instagram_group_post", "instagram_group_settings_update",
        "instagram_group_members_add",
    }
    if str(action_type) not in tracked:
        return
    current = now_ts()
    event_payload = {
        "action_id": str(action_id),
        "account_id": str(account_id),
        "target_key": str(target_key),
        "lead_id": str(payload.get("lead_id") or ""),
        "recipient": str(payload.get("recipient_username") or payload.get("recipient") or ""),
        "confirmed": True,
        "evidence": _normalized_action_evidence(str(payload.get("_social_task_id") or ""), result),
    }
    conn.execute(
        """
        INSERT OR IGNORE INTO crm_events(
          id,user_id,lead_id,workflow_id,event_type,occurred_at,payload_json,
          import_batch_id,active,legacy_id,legacy_payload_json,schema_version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,'',1,'','{}',1,?,?)
        """,
        (
            f"crm_event_action_{action_id}", int(user_id), str(payload.get("lead_id") or ""),
            str(workflow_id), f"{action_type}_confirmed", current, dumps(event_payload), current, current,
        ),
    )


def _record_platform_moderation_event(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    social_task_id: str,
    account_id: str,
    watchdog: dict[str, Any],
) -> None:
    """Persist one account-scoped moderation signal for the preflight cooldown gate."""

    clean_account_id = str(account_id or "").strip()
    clean_task_id = str(social_task_id or "").strip()
    if not clean_account_id or not clean_task_id:
        return
    current = now_ts()
    payload = {
        "account_id": clean_account_id,
        # The local account id is the stable sender identity used by preflight.
        "sender_username": clean_account_id,
        "social_task_id": clean_task_id,
        "reason": str(watchdog.get("reason") or "").strip(),
        "source_text": str(watchdog.get("source_text") or "").strip()[:500],
    }
    conn.execute(
        """
        INSERT OR IGNORE INTO crm_events(
          id,user_id,lead_id,workflow_id,event_type,occurred_at,payload_json,
          import_batch_id,active,legacy_id,legacy_payload_json,schema_version,created_at,updated_at
        ) VALUES (?,?, '',?,'platform_moderation_detected',?,?,'',1,?,'{}',1,?,?)
        """,
        (
            f"crm_event_moderation_{clean_task_id}",
            int(user_id),
            str(workflow_id),
            current,
            dumps(payload),
            f"platform_moderation:{clean_task_id}",
            current,
            current,
        ),
    )


def crm_data_dir() -> Path:
    return Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()


def storage_capacity() -> dict[str, Any]:
    data_dir = crm_data_dir()
    probe = data_dir if data_dir.exists() else data_dir.parent
    usage = shutil.disk_usage(probe)
    minimum_free = max(int(os.getenv("CRM_MIN_FREE_BYTES", str(512 * 1024 * 1024)) or 0), 0)
    return {
        "free_bytes": int(usage.free),
        "total_bytes": int(usage.total),
        "minimum_free_bytes": minimum_free,
        "writable": data_dir.exists() and os.access(data_dir, os.W_OK),
        "ready": data_dir.exists() and os.access(data_dir, os.W_OK) and int(usage.free) >= minimum_free,
    }


def require_write_capacity() -> None:
    capacity = storage_capacity()
    if capacity["ready"]:
        return
    from .errors import CRMError

    raise CRMError(
        "crm_storage_unavailable",
        "crm.errors.storageUnavailable",
        status_code=507,
        details=capacity,
        retryable=True,
    )


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def module_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    stored = get_admin_config(conn, MODULE_CONFIG_KEY, {})
    result = dict(DEFAULT_MODULE_SETTINGS)
    if isinstance(stored, dict):
        result.update(stored)
    result["hard_enabled"] = _truthy(os.getenv("CRM_ENABLED", "0"))
    return result


def update_module_settings(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, Any]:
    current = module_settings(conn)
    for key in ("enabled", "maintenance", "emergency_pause", "migration_required"):
        if key in patch:
            current[key] = bool(patch[key])
    current["version"] = max(int(current.get("version") or 0) + 1, 1)
    current.pop("hard_enabled", None)
    set_admin_config(conn, MODULE_CONFIG_KEY, current, now_ts())
    return module_settings(conn)


def set_user_access(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    enabled: bool,
    actor_user_id: int,
) -> dict[str, Any]:
    target = conn.execute(
        "SELECT id,is_admin,is_disabled,approval_status,deleted_at FROM users WHERE id = ?",
        (int(user_id),),
    ).fetchone()
    if target is None:
        from .errors import CRMError

        raise CRMError("crm_user_not_found", "crm.errors.userNotFound", status_code=404)
    current = now_ts()
    conn.execute(
        """
        INSERT INTO user_module_access(user_id,module_key,enabled,granted_by,created_at,updated_at)
        VALUES (?,'crm',?,?,?,?)
        ON CONFLICT(user_id,module_key) DO UPDATE SET
          enabled=excluded.enabled,granted_by=excluded.granted_by,updated_at=excluded.updated_at
        """,
        (int(user_id), 1 if enabled else 0, int(actor_user_id), current, current),
    )
    if not enabled:
        pause_for_policy(conn, user_id=int(user_id))
    return {"user_id": int(user_id), "module_key": MODULE_KEY, "enabled": bool(enabled), "updated_at": current}


def effective_module_state(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    identity_is_admin: bool = False,
) -> dict[str, Any]:
    settings = module_settings(conn)
    user = conn.execute(
        "SELECT id,is_admin,is_disabled,approval_status,deleted_at FROM users WHERE id = ?",
        (int(user_id),),
    ).fetchone()
    reasons: list[str] = []
    # CRM usage is open for approved accounts. Env flags, the global module
    # switch, per-user grants, and import-pending markers stay visible in
    # settings/admin APIs but must not wall off the workspace.
    _ = identity_is_admin
    if bool(settings.get("maintenance")):
        reasons.append("maintenance")
    if bool(settings.get("emergency_pause")):
        reasons.append("emergency_pause")
    if user is None:
        reasons.append("user_missing")
        access = False
    else:
        access = True
        if int(user["is_disabled"] or 0) == 1:
            reasons.append("user_disabled")
            access = False
        if str(user["approval_status"] or "") != "approved":
            reasons.append("user_not_approved")
            access = False
        if int(user["deleted_at"] or 0) > 0:
            reasons.append("user_deleted")
            access = False
    return {
        "module_key": MODULE_KEY,
        "effective": not reasons,
        "reasons": reasons,
        "user_access": access,
        "settings": settings,
    }


def pause_for_policy(conn: sqlite3.Connection, *, user_id: int | None = None) -> int:
    current = now_ts()
    params: list[Any] = [current]
    where_user = ""
    if user_id is not None:
        where_user = " AND user_id = ?"
        params.append(int(user_id))
    result = conn.execute(
        "UPDATE crm_workflows SET status = 'paused_by_policy', updated_at = ? "
        "WHERE active = 1 AND status IN ('queued','running','manual_required')" + where_user,
        tuple(params),
    )
    return max(int(result.rowcount or 0), 0)


def reconcile_workflow(conn: sqlite3.Connection, *, user_id: int, workflow_id: str) -> dict[str, Any]:
    workflow = get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    if str(workflow["status"]) in {"cancelled", "completed"}:
        return workflow
    states = [str(item.get("state") or "") for item in workflow.get("actions") or []]
    if not states:
        return workflow
    terminal_states = {"confirmed", "skipped", "failed"}
    all_terminal = all(state in terminal_states for state in states)
    current_status = str(workflow["status"])
    # An unknown platform outcome always needs an explicit review, even when a
    # user or policy paused the remaining workflow in the meantime.
    if "unknown" in states:
        desired = "manual_required"
    elif "failed" in states:
        # A failed sequential step blocks all later planned work. Mixed
        # confirmed/failed/planned batches therefore fail immediately instead
        # of waiting forever for a child that must not be dispatched.
        desired = "failed"
    elif current_status in {"paused_by_user", "paused_by_policy"}:
        # Policy cancellation turns a not-yet-submitted child into `skipped`.
        # That is a safe pause, not successful completion. Only a workflow
        # whose every platform action is confirmed may complete while paused.
        desired = "completed" if all(state == "confirmed" for state in states) else current_status
    elif all_terminal:
        desired = "completed"
    elif any(state in {"submitting", "submitted"} for state in states):
        desired = "running"
    elif any(state in {"planned", "reserved"} for state in states):
        desired = "queued"
    else:
        desired = current_status
    current = now_ts()
    finished = current if desired in {"completed", "failed"} else 0
    conn.execute(
        "UPDATE crm_workflows SET status = ?, finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (desired, finished, current, str(workflow_id), int(user_id)),
    )
    return get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))


def _advance_action(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    action_id: str,
    desired: str,
    evidence: dict[str, Any],
    error_code: str,
    billing_adapter: Adapter | None,
) -> None:
    row = conn.execute(
        "SELECT state FROM crm_action_ledger WHERE id=? AND user_id=?",
        (action_id, int(user_id)),
    ).fetchone()
    if row is None:
        return
    state = str(row["state"])
    paths = {
        "reserved": ["reserved"],
        "submitting": ["reserved", "submitting"],
        "submitted": ["reserved", "submitting", "submitted"],
        "confirmed": ["reserved", "submitting", "submitted", "confirmed"],
        "unknown": ["reserved", "submitting", "unknown"],
        "failed": ["failed"],
        "skipped": ["skipped"],
    }
    if state == desired:
        return
    sequence = paths.get(desired, [desired])
    if state in sequence:
        sequence = sequence[sequence.index(state) + 1:]
    elif state != "planned":
        sequence = [desired]
    for next_state in sequence:
        transition_action_state_atomic(
            conn,
            user_id=int(user_id),
            action_id=action_id,
            state=next_state,
            evidence=evidence if next_state in {"confirmed", "unknown", "failed"} else {},
            error_code=error_code if next_state in {"unknown", "failed"} else "",
            billing_adapter=billing_adapter,
        )


def sync_social_child_tasks(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    billing_adapter: Adapter | None = None,
    social_task_adapter: Adapter | None = None,
) -> dict[str, Any]:
    """Synchronize child worker truth into the CRM ledger without guessing.

    A crashed/failed child after the submission boundary always becomes
    ``unknown``. That state is never released or automatically retried.
    """
    rows = conn.execute(
        """
        SELECT action.id AS action_id, action.state AS action_state,
               action.action_type,action.account_id,action.target_key,
               step.id AS step_id, step.social_task_id,
               task.status AS social_status, task.payload_json, task.result_json,
               task.error AS social_error, task.updated_at AS social_updated_at
        FROM crm_action_ledger action
        JOIN crm_workflow_steps step ON step.id = action.step_id
        LEFT JOIN social_automation_tasks task ON task.id = step.social_task_id AND task.user_id = action.user_id
        WHERE action.user_id = ? AND action.workflow_id = ? AND step.social_task_id != ''
        ORDER BY step.sequence_no, action.id
        """,
        (int(user_id), str(workflow_id)),
    ).fetchall()
    synced = 0
    child_needs_manual = False
    for row in rows:
        if row["social_status"] is None:
            continue
        status = str(row["social_status"] or "")
        result_json = str(row["result_json"] or "{}")
        social_error = str(row["social_error"] or "")
        social_updated_at = int(row["social_updated_at"] or 0)
        result = loads(result_json, {})
        watchdog = classify_task_attention(
            {
                "status": "queued" if status in {"queued", "preparing"} else status,
                "updated_at": social_updated_at,
                "error": social_error,
                "result": result,
            }
        )
        if watchdog is not None:
            watchdog_error = dumps({"code": watchdog["code"], "reason": watchdog["reason"]})
            watchdog_updated_at = now_ts()
            changed = conn.execute(
                """
                UPDATE social_automation_tasks
                SET status='need_manual',error=?,updated_at=?
                WHERE id=? AND user_id=?
                  AND status IN ('preparing','queued','running','need_manual') AND updated_at=?
                """,
                (
                    watchdog_error,
                    watchdog_updated_at,
                    str(row["social_task_id"]),
                    int(user_id),
                    social_updated_at,
                ),
            )
            if changed.rowcount:
                status = "need_manual"
                social_error = watchdog_error
                social_updated_at = watchdog_updated_at
                if str(watchdog.get("code") or "") == "platform_moderation_cooldown":
                    _record_platform_moderation_event(
                        conn,
                        user_id=int(user_id),
                        workflow_id=str(workflow_id),
                        social_task_id=str(row["social_task_id"]),
                        account_id=str(row["account_id"] or ""),
                        watchdog=watchdog,
                    )
            else:
                fresh = conn.execute(
                    "SELECT status,result_json,error,updated_at FROM social_automation_tasks WHERE id=? AND user_id=?",
                    (str(row["social_task_id"]), int(user_id)),
                ).fetchone()
                if fresh is None:
                    continue
                status = str(fresh["status"] or "")
                result_json = str(fresh["result_json"] or "{}")
                social_error = str(fresh["error"] or "")
                social_updated_at = int(fresh["updated_at"] or 0)
                result = loads(result_json, {})
                watchdog = None
        if status == "need_manual":
            child_needs_manual = True
        payload = loads(row["payload_json"], {})
        submission_state = str(payload.get("_billing_submission_state") or "")
        outcome_unknown = bool(result.get("action_outcome_unknown") or result.get("publish_outcome_unknown"))
        spec = action_spec(str(row["action_type"] or ""))
        write_proved = not bool(spec.get("write")) or _write_result_confirmed(
            str(row["action_type"] or ""), result,
        )
        if outcome_unknown or (status in {"failed", "cancelled"} and submission_state in {"submitting", "submitted"}):
            desired = "unknown"
        elif status == "success":
            desired = "confirmed" if write_proved else (
                "unknown" if submission_state in {"submitting", "submitted"} else "failed"
            )
        elif status == "failed":
            desired = "failed"
        elif status == "cancelled":
            desired = "skipped"
        elif submission_state == "submitted":
            desired = "submitted"
        elif submission_state == "submitting":
            desired = "submitting"
        elif status in {"queued", "preparing", "running", "need_manual"}:
            desired = "reserved"
        else:
            continue
        before = str(row["action_state"] or "")
        evidence = _normalized_action_evidence(str(row["social_task_id"]), result)
        evidence_error = social_error
        if watchdog is not None:
            evidence_error = str(watchdog["code"])
        if status == "success" and not write_proved:
            evidence_error = "crm_platform_evidence_missing"
        _advance_action(
            conn,
            user_id=int(user_id),
            action_id=str(row["action_id"]),
            desired=desired,
            evidence=evidence,
            error_code=evidence_error,
            billing_adapter=billing_adapter,
        )
        if desired == "confirmed":
            event_payload = dict(payload)
            event_payload["_social_task_id"] = str(row["social_task_id"])
            _record_confirmed_action_event(
                conn,
                user_id=int(user_id),
                workflow_id=str(workflow_id),
                action_id=str(row["action_id"]),
                action_type=str(row["action_type"] or ""),
                account_id=str(row["account_id"] or ""),
                target_key=str(row["target_key"] or ""),
                payload=event_payload,
                result=result,
            )
        step_error = watchdog_error if watchdog is not None else social_error
        step_updated_at = social_updated_at or now_ts()
        conn.execute(
            "UPDATE crm_workflow_steps SET status=?,result_json=?,error_code=?,updated_at=? WHERE id=? AND user_id=?",
            (status, result_json, step_error, step_updated_at, str(row["step_id"]), int(user_id)),
        )
        if before != desired:
            synced += 1
    workflow = reconcile_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    if child_needs_manual and str(workflow.get("status") or "") not in {"cancelled", "completed", "failed"}:
        workflow = update_workflow_status(
            conn,
            user_id=int(user_id),
            workflow_id=str(workflow_id),
            status="manual_required",
        )
    if str(workflow.get("status") or "") in {"queued", "running"}:
        workflow = dispatch_next_action_atomic(
            conn,
            user_id=int(user_id),
            workflow_id=str(workflow_id),
            billing_adapter=billing_adapter,
            social_task_adapter=social_task_adapter,
        )
        workflow = reconcile_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    return {"workflow": workflow, "synced_actions": synced}


def reconcile_all_due(
    conn: sqlite3.Connection,
    *,
    limit: int = 200,
    billing_adapter: Adapter | None = None,
    social_task_adapter: Adapter | None = None,
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT workflow.id, workflow.user_id, MAX(task.updated_at) AS child_updated_at
        FROM crm_workflows workflow
        JOIN crm_workflow_steps step ON step.workflow_id = workflow.id AND step.user_id = workflow.user_id
        JOIN social_automation_tasks task ON task.id = step.social_task_id AND task.user_id = workflow.user_id
        WHERE workflow.active = 1
          AND workflow.status IN ('queued','running','manual_required','paused_by_user','paused_by_policy')
          AND (
            task.updated_at > step.updated_at
            OR task.status != step.status
            OR COALESCE(task.result_json,'{}') != COALESCE(step.result_json,'{}')
            OR COALESCE(task.error,'') != COALESCE(step.error_code,'')
            OR (task.status IN ('queued','preparing','running') AND task.updated_at <= ?)
          )
        GROUP BY workflow.id, workflow.user_id
        ORDER BY child_updated_at DESC, workflow.id
        LIMIT ?
        """,
        (now_ts() - 120, min(max(int(limit or 200), 1), 1000)),
    ).fetchall()
    workflows = 0
    actions = 0
    errors: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        savepoint = f"crm_reconcile_{index}"
        conn.execute(f"SAVEPOINT {savepoint}")
        try:
            result = sync_social_child_tasks(
                conn,
                user_id=int(row["user_id"]),
                workflow_id=str(row["id"]),
                billing_adapter=billing_adapter,
                social_task_adapter=social_task_adapter,
            )
            workflows += 1
            actions += int(result["synced_actions"])
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        except Exception as exc:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            errors.append({"workflow_id": str(row["id"]), "error": type(exc).__name__})
    return {"workflows": workflows, "actions": actions, "errors": errors, "has_more": len(rows) >= min(max(int(limit or 200), 1), 1000)}
