from __future__ import annotations

import contextlib
import json
import os
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from . import commercial_billing
from .db import db
from .crm.repository import create_workflow_atomic
from .crm.service import crm_data_dir, effective_module_state, reconcile_all_due, storage_capacity
from .social_automation_api import (
    cancel_crm_social_task_in_transaction,
    create_crm_relationship_task_in_transaction,
    create_crm_social_task_in_transaction,
    wake_social_automation_worker,
)


CRM_BILLABLE_SKUS = {
    "threads_auto_reply_batch",
    "crm_direct_message_batch",
    "crm_group_invite_batch",
}

_CRM_RUNTIME_OWNER = f"crm-runtime-{uuid.uuid4().hex}"
_CRM_RUNTIME_STOP = threading.Event()
_CRM_RUNTIME_WAKE = threading.Event()
_CRM_RUNTIME_THREAD: threading.Thread | None = None
_CRM_RUNTIME_LOCK = threading.Lock()
_CRM_LAST_RETENTION_AT = 0


def crm_billing_adapter(
    conn: sqlite3.Connection,
    request: dict[str, Any],
) -> dict[str, Any]:
    """Reserve a CRM action charge inside the parent workflow transaction."""

    if not isinstance(request, dict) or str(request.get("operation") or "") not in {"reserve", "settle", "release"}:
        raise HTTPException(status_code=422, detail="Unsupported CRM billing operation")
    if not conn.in_transaction:
        raise RuntimeError("CRM billing adapter requires an active database transaction")

    user_id = int(request.get("user_id") or 0)
    operation = str(request.get("operation") or "")
    workflow_id = str(request.get("workflow_id") or "").strip()
    action_id = str(request.get("action_id") or "").strip()
    sku = str(request.get("sku") or "").strip()
    quantity = max(int(request.get("quantity") or 1), 1)
    idempotency_key = str(request.get("idempotency_key") or "").strip()
    if user_id <= 0 or not workflow_id or not action_id or not idempotency_key:
        raise HTTPException(status_code=422, detail="Incomplete CRM billing request")
    if operation in {"settle", "release"}:
        reservation_id = str(request.get("reservation_id") or "").strip()
        row = conn.execute(
            "SELECT user_id, ref_type, ref_id, status FROM billing_reservations WHERE id = ?",
            (reservation_id,),
        ).fetchone()
        if (
            row is None
            or int(row["user_id"] or 0) != user_id
            or str(row["ref_type"] or "") != "crm_action"
            or str(row["ref_id"] or "") != action_id
        ):
            raise HTTPException(status_code=409, detail="CRM billing reservation ownership mismatch")
        if operation == "settle":
            result = commercial_billing.settle_reservation(
                conn,
                reservation_id,
                actual_quantity=max(int(request.get("quantity") or 1), 1),
                success=True,
            )
        else:
            result = commercial_billing.release_reservation(conn, reservation_id)
        return {"reservation_id": reservation_id, "status": str(result.get("status") or "")}
    if sku not in CRM_BILLABLE_SKUS:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "crm_sku_unmapped",
                "message": f"CRM write action SKU is not mapped: {sku or 'missing'}",
            },
        )

    reservation = commercial_billing.reserve_charge(
        conn,
        user_id=user_id,
        ref_type="crm_action",
        ref_id=action_id,
        sku=sku,
        quantity=quantity,
        idempotency_key=idempotency_key,
    )
    reservation_id = str(reservation.get("id") or "")
    if not reservation_id:
        raise RuntimeError("CRM billing reservation did not return an id")
    return {"reservation_id": reservation_id, "sku": sku, "quantity": quantity}


def crm_social_task_adapter(
    conn: sqlite3.Connection,
    request: dict[str, Any],
) -> dict[str, Any]:
    """Create the executable child task without leaving the CRM transaction."""

    if not isinstance(request, dict) or str(request.get("operation") or "") not in {"create", "cancel"}:
        raise HTTPException(status_code=422, detail="Unsupported CRM social task operation")
    if str(request.get("operation") or "") == "cancel":
        return cancel_crm_social_task_in_transaction(conn, request)
    action = request.get("action") if isinstance(request.get("action"), dict) else {}
    if str(action.get("action_type") or "") == "relationship_verify":
        return create_crm_relationship_task_in_transaction(
            conn,
            {
                "user_id": int(request.get("user_id") or 0),
                "account_id": str(action.get("account_id") or ""),
                "payload": dict(action.get("payload") or {}),
                "priority": 40,
            },
        )
    return create_crm_social_task_in_transaction(conn, request)


def crm_post_commit_callback(_event: dict[str, Any]) -> None:
    """Wake the existing Python worker only after the CRM transaction commits."""

    wake_social_automation_worker()
    _CRM_RUNTIME_WAKE.set()


def _crm_runtime_interval_seconds() -> float:
    try:
        return max(0.5, min(float(os.getenv("CRM_RUNTIME_POLL_SECONDS", "2") or 2), 30.0))
    except (TypeError, ValueError):
        return 2.0


def _acquire_crm_leader_lease(conn: sqlite3.Connection, *, now: int) -> bool:
    lease_seconds = max(10, min(int(os.getenv("CRM_SCHEDULER_LEASE_SECONDS", "30") or 30), 300))
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        """
        INSERT INTO crm_scheduler_leases(lease_key,owner_id,expires_at,updated_at)
        VALUES ('crm-runtime',?,?,?)
        ON CONFLICT(lease_key) DO UPDATE SET
          owner_id=excluded.owner_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE crm_scheduler_leases.expires_at < ? OR crm_scheduler_leases.owner_id = ?
        """,
        (_CRM_RUNTIME_OWNER, now + lease_seconds, now, now, _CRM_RUNTIME_OWNER),
    )
    row = conn.execute(
        "SELECT owner_id,expires_at FROM crm_scheduler_leases WHERE lease_key = 'crm-runtime'"
    ).fetchone()
    return bool(row and str(row["owner_id"] or "") == _CRM_RUNTIME_OWNER and int(row["expires_at"] or 0) > now)


def _next_schedule_time(cron_expression: str, payload: dict[str, Any], *, now: int, timezone_name: str) -> int:
    try:
        interval = int(payload.get("interval_seconds") or 0)
    except (TypeError, ValueError):
        interval = 0
    if interval > 0:
        return now + max(60, min(interval, 31 * 86400))

    parts = str(cron_expression or "").strip().split()
    try:
        tz = ZoneInfo(str(timezone_name or "Asia/Shanghai"))
    except ZoneInfoNotFoundError:
        tz = timezone(timedelta(hours=8), name="Asia/Shanghai")
    current = datetime.fromtimestamp(now, tz=tz).replace(second=0, microsecond=0) + timedelta(minutes=1)
    if len(parts) == 5:
        minute, hour, day, month, weekday = parts
        if day == month == weekday == "*":
            if minute.startswith("*/") and hour == "*":
                try:
                    step = max(1, min(int(minute[2:]), 59))
                    for _ in range(60):
                        if current.minute % step == 0:
                            return int(current.timestamp())
                        current += timedelta(minutes=1)
                except (TypeError, ValueError):
                    pass
            try:
                target_minute = int(minute)
                target_hour = current.hour if hour == "*" else int(hour)
                for _ in range(48 * 60):
                    if current.minute == target_minute and (hour == "*" or current.hour == target_hour):
                        return int(current.timestamp())
                    current += timedelta(minutes=1)
            except (TypeError, ValueError):
                pass
    return now + 86400


def _materialize_due_schedules(conn: sqlite3.Connection, *, now: int, limit: int = 50) -> int:
    if not storage_capacity().get("ready"):
        return 0
    uninitialized = conn.execute(
        "SELECT id,cron_expression,timezone,payload_json FROM crm_schedules "
        "WHERE enabled=1 AND active=1 AND next_run_at<=0 ORDER BY updated_at,id LIMIT ?",
        (max(1, min(int(limit), 200)),),
    ).fetchall()
    for row in uninitialized:
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        raw_actions = payload.get("actions")
        if (
            not isinstance(raw_actions, list)
            or not raw_actions
            or any(not isinstance(item, dict) for item in raw_actions)
        ):
            # Old builds could persist enabled schedules with an empty payload.
            # Never keep retrying those records or create a parent workflow that
            # can remain queued forever: disable it and expose a stable reason
            # through the existing payload returned by the schedules API.
            payload["validation_error"] = "crm_schedule_actions_required"
            conn.execute(
                "UPDATE crm_schedules SET enabled = 0, next_run_at = 0, payload_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False, separators=(",", ":")), now, str(row["id"])),
            )
            continue
        conn.execute(
            "UPDATE crm_schedules SET next_run_at=?,updated_at=? WHERE id=?",
            (
                _next_schedule_time(
                    str(row["cron_expression"] or ""), payload, now=now,
                    timezone_name=str(row["timezone"] or "Asia/Shanghai"),
                ),
                now,
                str(row["id"]),
            ),
        )
    rows = conn.execute(
        """
        SELECT * FROM crm_schedules
        WHERE enabled = 1 AND active = 1 AND next_run_at > 0 AND next_run_at <= ?
        ORDER BY next_run_at,id LIMIT ?
        """,
        (now, max(1, min(int(limit), 200))),
    ).fetchall()
    created = 0
    for row in rows:
        schedule_id = str(row["id"] or "")
        due_at = int(row["next_run_at"] or now)
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        raw_actions = payload.get("actions")
        if (
            not isinstance(raw_actions, list)
            or not raw_actions
            or any(not isinstance(item, dict) for item in raw_actions)
        ):
            payload["validation_error"] = "crm_schedule_actions_required"
            conn.execute(
                "UPDATE crm_schedules SET enabled = 0, next_run_at = 0, payload_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False, separators=(",", ":")), now, schedule_id),
            )
            continue
        owner = conn.execute("SELECT is_admin FROM users WHERE id = ?", (int(row["user_id"]),)).fetchone()
        module_state = effective_module_state(
            conn,
            user_id=int(row["user_id"]),
            identity_is_admin=bool(owner and int(owner["is_admin"] or 0)),
        )
        next_run_at = _next_schedule_time(
            str(row["cron_expression"] or ""),
            payload,
            now=max(now, due_at),
            timezone_name=str(row["timezone"] or "Asia/Shanghai"),
        )
        run_once = payload.get("run_once") is True
        if not module_state.get("effective"):
            conn.execute(
                "UPDATE crm_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?",
                (next_run_at, now, schedule_id),
            )
            continue
        conn.execute("SAVEPOINT crm_schedule_item")
        try:
            create_workflow_atomic(
                conn,
                user_id=int(row["user_id"]),
                workflow_type=str(row["workflow_type"] or "scheduled"),
                title=str(payload.get("title") or f"Scheduled CRM workflow {schedule_id}"),
                input_data=dict(payload.get("input") or {}),
                idempotency_key=f"crm-schedule:{schedule_id}:{due_at}",
                schedule_id=schedule_id,
                actions=raw_actions,
                confirmed_by=(
                    int(payload.get("confirmed_by") or 0)
                    if payload.get("confirmed") is True
                    else 0
                ),
                billing_adapter=crm_billing_adapter,
                social_task_adapter=crm_social_task_adapter,
            )
            if run_once:
                conn.execute(
                    "UPDATE crm_schedules SET enabled = 0, last_run_at = ?, next_run_at = 0, updated_at = ? WHERE id = ?",
                    (due_at, now, schedule_id),
                )
            else:
                conn.execute(
                    "UPDATE crm_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
                    (due_at, next_run_at, now, schedule_id),
                )
            conn.execute("RELEASE SAVEPOINT crm_schedule_item")
            created += 1
        except Exception:
            conn.execute("ROLLBACK TO SAVEPOINT crm_schedule_item")
            conn.execute("RELEASE SAVEPOINT crm_schedule_item")
            conn.execute(
                "UPDATE crm_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?",
                (now + 300, now, schedule_id),
            )
    return created


def _remove_expired_files(root: Path, *, cutoff: int) -> tuple[int, int]:
    if not root.is_dir():
        return 0, 0
    removed_files = 0
    removed_bytes = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            stat = path.stat()
            if int(stat.st_mtime) >= cutoff:
                continue
            path.unlink()
            removed_files += 1
            removed_bytes += int(stat.st_size)
        except (FileNotFoundError, OSError):
            continue
    for directory in sorted((item for item in root.rglob("*") if item.is_dir()), reverse=True):
        with contextlib.suppress(OSError):
            directory.rmdir()
    return removed_files, removed_bytes


def _cleanup_crm_retention(conn: sqlite3.Connection, *, now: int) -> dict[str, int]:
    """Delete only expired CRM-owned artifacts; never inspect browser profiles."""

    global _CRM_LAST_RETENTION_AT
    if _CRM_LAST_RETENTION_AT and now - _CRM_LAST_RETENTION_AT < 6 * 3600:
        return {"files": 0, "bytes": 0, "packages": 0}
    root = crm_data_dir()
    totals = {"files": 0, "bytes": 0, "packages": 0}
    policies = (
        (root / "crm_evidence", max(int(os.getenv("CRM_EVIDENCE_RETENTION_DAYS", "90") or 90), 1)),
        (root / "crm_logs", max(int(os.getenv("CRM_LOG_RETENTION_DAYS", "180") or 180), 1)),
    )
    for directory, days in policies:
        files, size = _remove_expired_files(directory.resolve(), cutoff=now - days * 86400)
        totals["files"] += files
        totals["bytes"] += size

    import_root = (root / "crm_imports").resolve()
    rows = conn.execute(
        "SELECT source_path,report_json,activated_at FROM crm_import_batches WHERE status='active' AND activated_at > 0"
    ).fetchall()
    for row in rows:
        try:
            source = Path(str(row["source_path"] or "")).resolve()
            source.relative_to(import_root)
            report = json.loads(str(row["report_json"] or "{}"))
            retain_until = int(report.get("retain_source_until") or (int(row["activated_at"] or 0) + 7 * 86400))
            if now < retain_until or not source.exists():
                continue
            if source.is_dir() and not source.is_symlink():
                package_bytes = sum(item.stat().st_size for item in source.rglob("*") if item.is_file() and not item.is_symlink())
                shutil.rmtree(source)
            elif source.is_file() and not source.is_symlink():
                package_bytes = source.stat().st_size
                source.unlink()
            else:
                continue
            totals["packages"] += 1
            totals["bytes"] += int(package_bytes)
        except (FileNotFoundError, OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    _CRM_LAST_RETENTION_AT = now
    return totals


def run_crm_runtime_once() -> dict[str, Any]:
    now = int(time.time())
    with db() as conn:
        if not _acquire_crm_leader_lease(conn, now=now):
            return {"leader": False, "workflows": 0, "actions": 0, "schedules": 0}
        reconciled = reconcile_all_due(
            conn,
            limit=200,
            billing_adapter=crm_billing_adapter,
            social_task_adapter=crm_social_task_adapter,
        )
        schedules = _materialize_due_schedules(conn, now=now)
        retention = _cleanup_crm_retention(conn, now=now)
    if int(reconciled.get("actions") or 0) or schedules:
        wake_social_automation_worker()
    return {"leader": True, **reconciled, "schedules": schedules, "retention": retention}


def _crm_runtime_loop() -> None:
    while not _CRM_RUNTIME_STOP.is_set():
        with contextlib.suppress(Exception):
            run_crm_runtime_once()
        _CRM_RUNTIME_WAKE.wait(timeout=_crm_runtime_interval_seconds())
        _CRM_RUNTIME_WAKE.clear()


def ensure_crm_runtime_started() -> None:
    global _CRM_RUNTIME_THREAD
    with _CRM_RUNTIME_LOCK:
        if _CRM_RUNTIME_THREAD and _CRM_RUNTIME_THREAD.is_alive():
            return
        _CRM_RUNTIME_STOP.clear()
        _CRM_RUNTIME_THREAD = threading.Thread(target=_crm_runtime_loop, name="crm-runtime", daemon=True)
        _CRM_RUNTIME_THREAD.start()


def stop_crm_runtime(*, timeout_seconds: float = 5.0) -> None:
    global _CRM_RUNTIME_THREAD
    _CRM_RUNTIME_STOP.set()
    _CRM_RUNTIME_WAKE.set()
    thread = _CRM_RUNTIME_THREAD
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=max(0.0, float(timeout_seconds)))
    with contextlib.suppress(Exception):
        with db() as conn:
            conn.execute(
                "UPDATE crm_scheduler_leases SET expires_at = 0, updated_at = ? WHERE lease_key = 'crm-runtime' AND owner_id = ?",
                (int(time.time()), _CRM_RUNTIME_OWNER),
            )
    if thread is None or not thread.is_alive():
        _CRM_RUNTIME_THREAD = None
