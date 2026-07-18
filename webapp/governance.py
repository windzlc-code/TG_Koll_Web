from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import re
import secrets
import sqlite3
import struct
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from urllib.parse import quote


LIFECYCLE_STATUSES = {
    "pending",
    "active",
    "rejected",
    "suspended",
    "locked",
    "archived",
    "deleted",
}
RISK_LEVELS = {"low", "medium", "high", "critical"}
ALERT_STATUSES = {"open", "acknowledged", "investigating", "resolved", "ignored"}
SENSITIVE_KEYS = {
    "password",
    "password_hash",
    "token",
    "session",
    "cookie",
    "secret",
    "api_key",
    "authorization",
    "ciphertext",
    "recovery_codes",
}
TAIPEI = timezone(timedelta(hours=8))


def now_ts() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def token_digest(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def recovery_code_digest(code: str) -> str:
    return hashlib.sha256(str(code or "").strip().upper().encode("utf-8")).hexdigest()


def redact(value: Any, *, key: str = "") -> Any:
    normalized = str(key or "").strip().lower()
    if any(marker in normalized for marker in SENSITIVE_KEYS):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(item_key): redact(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str) and len(value) > 4096:
        return f"{value[:4096]}...[TRUNCATED]"
    return value


def json_text(value: Any) -> str:
    return json.dumps(redact(value), ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def redact_free_text(value: Any) -> str:
    text = str(value or "")[:1000]
    text = re.sub(
        r"(?i)\b(password|token|cookie|session(?:[_ -]?id)?|api[_ -]?key|secret|authorization)\b\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )
    return re.sub(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text)


def lifecycle_for_user(row: sqlite3.Row | dict[str, Any]) -> str:
    data = dict(row)
    explicit = str(data.get("lifecycle_status") or "").strip().lower()
    if explicit in LIFECYCLE_STATUSES:
        return explicit
    if int(data.get("deleted_at") or 0) > 0:
        return "archived"
    approval = str(data.get("approval_status") or "approved").strip().lower()
    if approval == "pending":
        return "pending"
    if approval == "rejected":
        return "rejected"
    if int(data.get("is_disabled") or 0) == 1:
        return "suspended"
    return "active"


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}


def _add_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = _column_names(conn, table)
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {definition}')


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
        """
    )
    first_install = conn.execute(
        "SELECT 1 FROM schema_migrations WHERE version = 'governance_v1'"
    ).fetchone() is None
    _add_columns(
        conn,
        "users",
        {
            "lifecycle_status": "TEXT NOT NULL DEFAULT 'active'",
            "lifecycle_reason": "TEXT NOT NULL DEFAULT ''",
            "risk_level": "TEXT NOT NULL DEFAULT 'low'",
            "owner_admin_id": "INTEGER NOT NULL DEFAULT 0",
            "source_channel": "TEXT NOT NULL DEFAULT ''",
            "locked_at": "INTEGER NOT NULL DEFAULT 0",
            "locked_by": "INTEGER NOT NULL DEFAULT 0",
            "locked_until": "INTEGER NOT NULL DEFAULT 0",
            "failed_login_count": "INTEGER NOT NULL DEFAULT 0",
            "failed_login_window_at": "INTEGER NOT NULL DEFAULT 0",
            "last_login_ip": "TEXT NOT NULL DEFAULT ''",
            "last_login_user_agent": "TEXT NOT NULL DEFAULT ''",
            "last_device_id": "TEXT NOT NULL DEFAULT ''",
            "row_version": "INTEGER NOT NULL DEFAULT 1",
            "purge_requested_at": "INTEGER NOT NULL DEFAULT 0",
            "purge_requested_by": "INTEGER NOT NULL DEFAULT 0",
        },
    )
    if first_install:
        conn.execute(
            """
            UPDATE users
            SET lifecycle_status = CASE
              WHEN deleted_at > 0 THEN 'archived'
              WHEN approval_status = 'pending' THEN 'pending'
              WHEN approval_status = 'rejected' THEN 'rejected'
              WHEN is_disabled = 1 THEN 'suspended'
              ELSE 'active'
            END
            """
        )
    _add_columns(
        conn,
        "sessions",
        {
            "device_id": "TEXT NOT NULL DEFAULT ''",
            "ip_address": "TEXT NOT NULL DEFAULT ''",
            "user_agent": "TEXT NOT NULL DEFAULT ''",
            "last_seen_at": "INTEGER NOT NULL DEFAULT 0",
            "revoked_at": "INTEGER NOT NULL DEFAULT 0",
            "revoke_reason": "TEXT NOT NULL DEFAULT ''",
            "is_admin_session": "INTEGER NOT NULL DEFAULT 0",
        },
    )
    # Sessions created before token hardening stored the browser token directly.
    # Hash them in place so existing cookies continue to work after deployment.
    for row in conn.execute("SELECT token FROM sessions").fetchall():
        raw_token = str(row["token"] or "")
        if len(raw_token) == 64 and all(char in "0123456789abcdef" for char in raw_token):
            continue
        conn.execute(
            "UPDATE sessions SET token = ? WHERE token = ?",
            (token_digest(raw_token), raw_token),
        )
    # Before the admin-specific cookie existed, administrator sessions were
    # stored with the regular-session default. They must not remain usable via
    # the customer cookie after the boundary is introduced.
    session_boundary_at = now_ts()
    conn.execute(
        """
        UPDATE sessions
        SET revoked_at = ?, revoke_reason = 'admin_session_boundary_migration'
        WHERE revoked_at = 0
          AND expires_at > ?
          AND is_admin_session = 0
          AND user_id IN (SELECT id FROM users WHERE is_admin = 1)
        """,
        (session_boundary_at, session_boundary_at),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO schema_migrations(version, description, applied_at)
        VALUES ('admin_session_boundary_v1', ?, ?)
        """,
        (
            "Revoke legacy administrator sessions issued as regular sessions",
            session_boundary_at,
        ),
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'neutral',
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_group_members (
          group_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(group_id, user_id),
          FOREIGN KEY(group_id) REFERENCES customer_groups(id) ON DELETE CASCADE,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          color TEXT NOT NULL DEFAULT 'neutral',
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_tag_assignments (
          tag_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(tag_id, user_id),
          FOREIGN KEY(tag_id) REFERENCES customer_tags(id) ON DELETE CASCADE,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS password_vault_history (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          ciphertext TEXT NOT NULL,
          key_version TEXT NOT NULL DEFAULT 'v1',
          source TEXT NOT NULL DEFAULT 'unknown',
          actor_user_id INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          restored_at INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS password_vault_key_status (
          key_version TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'active',
          activated_at INTEGER NOT NULL,
          last_health_check_at INTEGER NOT NULL DEFAULT 0,
          last_health_result TEXT NOT NULL DEFAULT '',
          retired_at INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    _add_columns(
        conn,
        "password_vault_key_status",
        {"persistent_probe": "TEXT NOT NULL DEFAULT ''"},
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_mfa (
          user_id INTEGER PRIMARY KEY,
          secret_ciphertext TEXT NOT NULL DEFAULT '',
          pending_secret_ciphertext TEXT NOT NULL DEFAULT '',
          recovery_codes_json TEXT NOT NULL DEFAULT '[]',
          enabled_at INTEGER NOT NULL DEFAULT 0,
          required_after INTEGER NOT NULL DEFAULT 0,
          last_verified_at INTEGER NOT NULL DEFAULT 0,
          last_totp_counter INTEGER NOT NULL DEFAULT 0,
          failed_attempt_count INTEGER NOT NULL DEFAULT 0,
          failure_window_at INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    _add_columns(
        conn,
        "user_mfa",
        {
            "last_totp_counter": "INTEGER NOT NULL DEFAULT 0",
            "failed_attempt_count": "INTEGER NOT NULL DEFAULT 0",
            "failure_window_at": "INTEGER NOT NULL DEFAULT 0",
            "locked_until": "INTEGER NOT NULL DEFAULT 0",
        },
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          actor_user_id INTEGER NOT NULL DEFAULT 0,
          target_user_id INTEGER NOT NULL DEFAULT 0,
          session_fingerprint TEXT NOT NULL DEFAULT '',
          request_id TEXT NOT NULL DEFAULT '',
          ip_address TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL DEFAULT '',
          resource_id TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          before_json TEXT NOT NULL DEFAULT '{}',
          after_json TEXT NOT NULL DEFAULT '{}',
          outcome TEXT NOT NULL DEFAULT 'success',
          error_code TEXT NOT NULL DEFAULT '',
          risk_level TEXT NOT NULL DEFAULT 'low',
          created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_archives (
          id TEXT PRIMARY KEY,
          range_start INTEGER NOT NULL,
          range_end INTEGER NOT NULL,
          event_count INTEGER NOT NULL DEFAULT 0,
          checksum TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS security_alerts (
          id TEXT PRIMARY KEY,
          alert_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          target_user_id INTEGER NOT NULL DEFAULT 0,
          related_audit_id TEXT NOT NULL DEFAULT '',
          assigned_admin_id INTEGER NOT NULL DEFAULT 0,
          fingerprint TEXT NOT NULL DEFAULT '',
          occurrence_count INTEGER NOT NULL DEFAULT 1,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          resolved_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS security_alert_timeline (
          id TEXT PRIMARY KEY,
          alert_id TEXT NOT NULL,
          actor_user_id INTEGER NOT NULL DEFAULT 0,
          event_type TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(alert_id) REFERENCES security_alerts(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS service_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          purpose TEXT NOT NULL DEFAULT '',
          allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
          credential_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          expires_at INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER NOT NULL DEFAULT 0,
          last_used_ip TEXT NOT NULL DEFAULT '',
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          revoked_at INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_batch_jobs (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          request_json TEXT NOT NULL DEFAULT '{}',
          total_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          started_at INTEGER NOT NULL DEFAULT 0,
          finished_at INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_batch_job_results (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          user_id INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(job_id) REFERENCES admin_batch_jobs(id) ON DELETE CASCADE
        )
        """
    )
    indexes = (
        "CREATE INDEX IF NOT EXISTS idx_users_lifecycle ON users(is_admin, lifecycle_status, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_users_risk ON users(risk_level, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(user_id, last_seen_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_vault_history(user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target_user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_security_alert_status ON security_alerts(status, severity, last_seen_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_batch_jobs_created ON admin_batch_jobs(created_at DESC)",
    )
    for statement in indexes:
        conn.execute(statement)
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, description, applied_at) VALUES ('governance_v1', ?, ?)",
        ("Vecto account governance, audit, MFA and operations schema", now_ts()),
    )
    maintenance_at = now_ts()
    for row in conn.execute("SELECT DISTINCT user_id FROM password_vault_history").fetchall():
        prune_password_history(conn, int(row["user_id"]), at=maintenance_at)
    archive_expired_audit_events(conn, at=maintenance_at, batch_size=1000)


def archive_expired_audit_events(
    conn: sqlite3.Connection,
    *,
    at: int | None = None,
    retention_days: int = 180,
    batch_size: int = 1000,
) -> dict[str, Any]:
    cutoff = int(at or now_ts()) - max(int(retention_days), 1) * 86400
    rows = conn.execute(
        "SELECT * FROM audit_events WHERE created_at < ? ORDER BY created_at ASC, id ASC LIMIT ?",
        (cutoff, min(max(int(batch_size), 1), 5000)),
    ).fetchall()
    if not rows:
        return {"archived": 0, "cutoff": cutoff}
    payload = [dict(row) for row in rows]
    payload_text = json_text(payload)
    archive_id = new_id("audit_archive")
    conn.execute(
        "INSERT INTO audit_archives(id, range_start, range_end, event_count, checksum, payload_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            archive_id,
            int(rows[0]["created_at"] or 0),
            int(rows[-1]["created_at"] or 0),
            len(rows),
            hashlib.sha256(payload_text.encode("utf-8")).hexdigest(),
            payload_text,
            int(at or now_ts()),
        ),
    )
    placeholders = ",".join("?" for _ in rows)
    conn.execute(
        f"DELETE FROM audit_events WHERE id IN ({placeholders})",
        tuple(str(row["id"]) for row in rows),
    )
    return {"archived": len(rows), "cutoff": cutoff, "archive_id": archive_id}


def record_audit(
    conn: sqlite3.Connection,
    *,
    actor_user_id: int,
    action: str,
    target_user_id: int = 0,
    resource_type: str = "",
    resource_id: str = "",
    reason: str = "",
    before: Any = None,
    after: Any = None,
    outcome: str = "success",
    error_code: str = "",
    risk_level: str = "low",
    request_id: str = "",
    ip_address: str = "",
    user_agent: str = "",
    session_fingerprint: str = "",
    created_at: int | None = None,
) -> str:
    event_id = new_id("audit")
    created = int(created_at or now_ts())
    safe_risk = risk_level if risk_level in RISK_LEVELS else "low"
    conn.execute(
        """
        INSERT INTO audit_events(
          id, actor_user_id, target_user_id, session_fingerprint, request_id,
          ip_address, user_agent, action, resource_type, resource_id, reason,
          before_json, after_json, outcome, error_code, risk_level, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            int(actor_user_id or 0),
            int(target_user_id or 0),
            str(session_fingerprint or "")[:128],
            str(request_id or "")[:128],
            str(ip_address or "")[:64],
            str(user_agent or "")[:500],
            str(action or "")[:160],
            str(resource_type or "")[:80],
            str(resource_id or "")[:160],
            redact_free_text(reason),
            json_text(before or {}),
            json_text(after or {}),
            str(outcome or "success")[:32],
            str(error_code or "")[:120],
            safe_risk,
            created,
        ),
    )
    conn.execute(
        "INSERT INTO admin_audit_log(admin_user_id, action, target_user_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)",
        (
            int(actor_user_id or 0),
            str(action or "")[:160],
            int(target_user_id or 0),
            json_text({"audit_event_id": event_id, "resource_type": resource_type, "resource_id": resource_id, "outcome": outcome}),
            created,
        ),
    )
    return event_id


def upsert_alert(
    conn: sqlite3.Connection,
    *,
    alert_type: str,
    severity: str,
    title: str,
    summary: str = "",
    target_user_id: int = 0,
    related_audit_id: str = "",
    fingerprint: str = "",
    created_at: int | None = None,
) -> str:
    created = int(created_at or now_ts())
    safe_severity = severity if severity in RISK_LEVELS else "medium"
    dedupe = str(fingerprint or f"{alert_type}:{target_user_id}:{title}")[:300]
    existing = conn.execute(
        "SELECT id FROM security_alerts WHERE fingerprint = ? AND status IN ('open','acknowledged','investigating') ORDER BY last_seen_at DESC LIMIT 1",
        (dedupe,),
    ).fetchone()
    if existing:
        alert_id = str(existing["id"])
        conn.execute(
            "UPDATE security_alerts SET occurrence_count = occurrence_count + 1, last_seen_at = ?, updated_at = ?, summary = ? WHERE id = ?",
            (created, created, str(summary or "")[:2000], alert_id),
        )
        return alert_id
    alert_id = new_id("alert")
    conn.execute(
        """
        INSERT INTO security_alerts(
          id, alert_type, severity, status, title, summary, target_user_id,
          related_audit_id, fingerprint, first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            alert_id,
            str(alert_type or "")[:100],
            safe_severity,
            str(title or "")[:240],
            str(summary or "")[:2000],
            int(target_user_id or 0),
            str(related_audit_id or "")[:100],
            dedupe,
            created,
            created,
            created,
        ),
    )
    return alert_id


def prune_password_history(conn: sqlite3.Connection, user_id: int, *, at: int | None = None) -> None:
    current = int(at or now_ts())
    conn.execute("DELETE FROM password_vault_history WHERE user_id = ? AND expires_at <= ?", (int(user_id), current))
    rows = conn.execute(
        "SELECT id FROM password_vault_history WHERE user_id = ? ORDER BY created_at DESC, id DESC",
        (int(user_id),),
    ).fetchall()
    for row in rows[5:]:
        conn.execute("DELETE FROM password_vault_history WHERE id = ?", (str(row["id"]),))


def archive_password_ciphertext(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    ciphertext: str,
    actor_user_id: int,
    source: str,
    key_version: str,
    created_at: int | None = None,
) -> str:
    created = int(created_at or now_ts())
    history_id = new_id("pwdhist")
    conn.execute(
        """
        INSERT INTO password_vault_history(
          id, user_id, ciphertext, key_version, source, actor_user_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            history_id,
            int(user_id),
            str(ciphertext),
            str(key_version or "v1")[:40],
            str(source or "unknown")[:80],
            int(actor_user_id or 0),
            created,
            created + 90 * 86400,
        ),
    )
    prune_password_history(conn, int(user_id), at=created)
    return history_id


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret: str, *, at: int | None = None, interval: int = 30, digits: int = 6) -> str:
    normalized = str(secret or "").strip().replace(" ", "").upper()
    padding = "=" * ((8 - len(normalized) % 8) % 8)
    key = base64.b32decode(normalized + padding, casefold=True)
    counter = int(int(at or time.time()) // interval)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(binary % (10**digits)).zfill(digits)


def verify_totp(secret: str, code: str, *, at: int | None = None, window: int = 1) -> bool:
    return matching_totp_counter(secret, code, at=at, window=window) is not None


def matching_totp_counter(secret: str, code: str, *, at: int | None = None, window: int = 1) -> int | None:
    candidate = str(code or "").strip().replace(" ", "")
    if not candidate.isdigit() or len(candidate) != 6:
        return None
    current = int(at or time.time())
    for drift in range(-abs(int(window)), abs(int(window)) + 1):
        matched_at = current + drift * 30
        if hmac.compare_digest(totp_code(secret, at=matched_at), candidate):
            return int(matched_at // 30)
    return None


def totp_uri(secret: str, username: str, *, issuer: str = "Vecto OS") -> str:
    label = quote(f"{issuer}:{username}")
    return f"otpauth://totp/{label}?secret={quote(secret)}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"


def generate_recovery_codes(count: int = 10) -> list[str]:
    return [f"{secrets.token_hex(3).upper()}-{secrets.token_hex(3).upper()}" for _ in range(max(1, int(count)))]


def request_context(request: Any) -> dict[str, str]:
    state_request_id = str(getattr(getattr(request, "state", None), "request_id", "") or "").strip()
    request_id = str(state_request_id or request.headers.get("x-request-id") or new_id("req"))[:128]
    peer = str(request.client.host if getattr(request, "client", None) else "")[:64]
    user_agent = str(request.headers.get("user-agent") or "")[:500]
    selected_fingerprint = str(getattr(getattr(request, "state", None), "auth_session_fingerprint", "") or "")
    session_value = str(request.cookies.get("admin_session_token") or request.cookies.get("session_token") or "")
    return {
        "request_id": request_id,
        "ip_address": peer,
        "user_agent": user_agent,
        "session_fingerprint": selected_fingerprint or (token_digest(session_value)[:16] if session_value else ""),
    }


def _bucket_start(ts: int, days: int) -> int:
    local = datetime.fromtimestamp(int(ts), TAIPEI)
    start = datetime(local.year, local.month, local.day, tzinfo=TAIPEI) - timedelta(days=max(int(days), 1) - 1)
    return int(start.timestamp())


def _daily_rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...], *, start: int, days: int) -> list[dict[str, Any]]:
    by_day = {str(row["day"]): dict(row) for row in conn.execute(sql, params).fetchall()}
    start_dt = datetime.fromtimestamp(start, TAIPEI)
    output: list[dict[str, Any]] = []
    for offset in range(days):
        day = (start_dt + timedelta(days=offset)).strftime("%Y-%m-%d")
        output.append({"day": day, **by_day.get(day, {})})
    return output


def detect_operational_alerts(conn: sqlite3.Connection, *, at: int | None = None) -> None:
    current = int(at or now_ts())
    failed_tasks = int(
        conn.execute(
            "SELECT COUNT(*) AS count FROM ("
            "SELECT id FROM tasks WHERE status = 'failed' AND updated_at >= ? "
            "UNION ALL SELECT id FROM social_automation_tasks WHERE status = 'failed' AND updated_at >= ?)",
            (current - 3600, current - 3600),
        ).fetchone()["count"]
    )
    if failed_tasks >= 5:
        upsert_alert(
            conn,
            alert_type="task_failure_rate",
            severity="high",
            title="任务失败量异常",
            summary=f"最近 1 小时共有 {failed_tasks} 个任务失败。",
            fingerprint=f"task-failures:{current // 3600}",
            created_at=current,
        )
    pending_users = int(
        conn.execute(
            "SELECT COUNT(*) AS count FROM users WHERE is_admin = 0 AND lifecycle_status = 'pending'"
        ).fetchone()["count"]
    )
    if pending_users >= 10:
        upsert_alert(
            conn,
            alert_type="pending_customer_backlog",
            severity="medium",
            title="待审核客户申请积压",
            summary=f"当前有 {pending_users} 个客户申请待审核。",
            fingerprint=f"pending-users:{current // 86400}",
            created_at=current,
        )
    proxy_failures = int(
        conn.execute(
            "SELECT COUNT(*) AS count FROM social_proxies WHERE status != 'active' "
            "OR (last_check_at >= ? AND lower(last_check_result) LIKE '%fail%')",
            (current - 86400,),
        ).fetchone()["count"]
    )
    if proxy_failures > 0:
        upsert_alert(
            conn,
            alert_type="proxy_environment_unavailable",
            severity="high",
            title="代理环境存在异常",
            summary=f"发现 {proxy_failures} 个代理环境异常或检测失败。",
            fingerprint=f"proxy-failures:{current // 3600}",
            created_at=current,
        )
    expired_services = int(
        conn.execute(
            "SELECT COUNT(*) AS count FROM service_accounts WHERE status = 'active' AND expires_at > 0 AND expires_at <= ?",
            (current,),
        ).fetchone()["count"]
    )
    if expired_services > 0:
        upsert_alert(
            conn,
            alert_type="service_credential_expired",
            severity="high",
            title="内部服务凭据已过期",
            summary=f"有 {expired_services} 个启用中的服务凭据已经过期。",
            fingerprint=f"service-expired:{current // 86400}",
            created_at=current,
        )


def dashboard_snapshot(conn: sqlite3.Connection, *, days: int = 30, at: int | None = None) -> dict[str, Any]:
    current = int(at or now_ts())
    detect_operational_alerts(conn, at=current)
    safe_days = max(1, min(int(days), 366))
    start = _bucket_start(current, safe_days)
    users = conn.execute(
        """
        SELECT
          SUM(CASE WHEN is_admin = 0 THEN 1 ELSE 0 END) AS customers,
          SUM(CASE WHEN is_admin = 0 AND lifecycle_status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN is_admin = 0 AND lifecycle_status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_admin = 0 AND lifecycle_status IN ('rejected','suspended','archived','deleted') THEN 1 ELSE 0 END) AS disabled,
          SUM(CASE WHEN is_admin = 0 AND lifecycle_status = 'locked' THEN 1 ELSE 0 END) AS locked
        FROM users
        """
    ).fetchone()
    sessions = conn.execute(
        "SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ? AND revoked_at = 0",
        (current,),
    ).fetchone()
    task_totals = conn.execute(
        """
        SELECT
          SUM(CASE WHEN status IN ('running','queued','pending') THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status IN ('completed','success','succeeded','done') AND updated_at >= ? THEN 1 ELSE 0 END) AS success_today,
          SUM(CASE WHEN status = 'failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS failed_today
        FROM (
          SELECT status, updated_at FROM tasks
          UNION ALL
          SELECT status, updated_at FROM social_automation_tasks
        )
        """,
        (_bucket_start(current, 1), _bucket_start(current, 1)),
    ).fetchone()
    subscriptions = conn.execute(
        "SELECT COUNT(*) AS count FROM billing_subscriptions WHERE status = 'active' AND current_period_end > ?",
        (current,),
    ).fetchone()
    wallet = conn.execute(
        """
        SELECT COALESCE(SUM(wallet.credit_units), 0) AS units
        FROM billing_wallets AS wallet
        JOIN users ON users.id = wallet.user_id
        WHERE users.is_admin = 0 AND users.lifecycle_status != 'deleted'
        """
    ).fetchone()
    consumption = conn.execute(
        "SELECT COALESCE(SUM(CASE WHEN amount_units < 0 THEN -amount_units ELSE 0 END), 0) AS units FROM billing_ledger WHERE asset_type = 'credit' AND created_at >= ?",
        (start,),
    ).fetchone()
    alerts = conn.execute(
        "SELECT COUNT(*) AS count FROM security_alerts WHERE status IN ('open','acknowledged','investigating')"
    ).fetchone()
    user_trend = _daily_rows(
        conn,
        """
        SELECT date(created_at, 'unixepoch', '+8 hours') AS day,
               COUNT(*) AS created,
               SUM(CASE WHEN lifecycle_status = 'active' THEN 1 ELSE 0 END) AS activated
        FROM users
        WHERE is_admin = 0 AND created_at >= ?
        GROUP BY day
        """,
        (start,),
        start=start,
        days=safe_days,
    )
    login_rows = {
        str(row["day"]): int(row["active_logins"] or 0)
        for row in conn.execute(
            "SELECT date(created_at, 'unixepoch', '+8 hours') AS day, COUNT(*) AS active_logins "
            "FROM sessions WHERE created_at >= ? GROUP BY day",
            (start,),
        ).fetchall()
    }
    for item in user_trend:
        item["active_logins"] = login_rows.get(str(item.get("day") or ""), 0)
    task_trend = _daily_rows(
        conn,
        """
        SELECT date(updated_at, 'unixepoch', '+8 hours') AS day,
               SUM(CASE WHEN status IN ('completed','success','succeeded','done') THEN 1 ELSE 0 END) AS success,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status IN ('cancelled','canceled') THEN 1 ELSE 0 END) AS cancelled,
               SUM(CASE WHEN status IN ('running','queued','pending') THEN 1 ELSE 0 END) AS running
        FROM (
          SELECT status, updated_at FROM tasks WHERE updated_at >= ?
          UNION ALL
          SELECT status, updated_at FROM social_automation_tasks WHERE updated_at >= ?
        )
        GROUP BY day
        """,
        (start, start),
        start=start,
        days=safe_days,
    )
    billing_trend = _daily_rows(
        conn,
        """
        SELECT date(created_at, 'unixepoch', '+8 hours') AS day,
               SUM(CASE WHEN amount_units > 0 THEN amount_units ELSE 0 END) AS credited_units,
               SUM(CASE WHEN amount_units < 0 THEN -amount_units ELSE 0 END) AS consumed_units,
               SUM(CASE WHEN event_type LIKE '%refund%' AND amount_units > 0 THEN amount_units ELSE 0 END) AS refunded_units,
               SUM(CASE WHEN event_type LIKE 'admin_%' THEN amount_units ELSE 0 END) AS adjusted_units
        FROM billing_ledger
        WHERE asset_type = 'credit' AND created_at >= ?
        GROUP BY day
        """,
        (start,),
        start=start,
        days=safe_days,
    )
    lifecycle_rows = conn.execute(
        "SELECT lifecycle_status AS label, COUNT(*) AS value FROM users WHERE is_admin = 0 GROUP BY lifecycle_status"
    ).fetchall()
    subscription_rows = conn.execute(
        """
        SELECT label, COUNT(*) AS value FROM (
          SELECT users.id,
                 CASE
                   WHEN COALESCE(wallet.billing_mode, 'legacy') = 'legacy' THEN 'legacy'
                   WHEN EXISTS (
                     SELECT 1 FROM billing_subscriptions AS subscription
                     WHERE subscription.user_id = users.id AND subscription.status = 'active'
                       AND subscription.current_period_end > ? + 604800
                   ) THEN 'active'
                   WHEN EXISTS (
                     SELECT 1 FROM billing_subscriptions AS subscription
                     WHERE subscription.user_id = users.id AND subscription.status = 'active'
                       AND subscription.current_period_end > ?
                   ) THEN 'expiring'
                   ELSE 'expired'
                 END AS label
          FROM users
          LEFT JOIN billing_wallets AS wallet ON wallet.user_id = users.id
          WHERE users.is_admin = 0 AND users.lifecycle_status != 'deleted'
        ) GROUP BY label
        """,
        (current, current),
    ).fetchall()
    alert_rows = conn.execute(
        "SELECT severity AS label, COUNT(*) AS value FROM security_alerts WHERE status IN ('open','acknowledged','investigating') GROUP BY severity"
    ).fetchall()
    pending_users = conn.execute(
        "SELECT id, username, full_name, company, created_at FROM users WHERE is_admin = 0 AND lifecycle_status = 'pending' ORDER BY created_at ASC LIMIT 8"
    ).fetchall()
    recent_failures = conn.execute(
        """
        SELECT id, user_id, status, error, updated_at, source FROM (
          SELECT id, user_id, status, error, updated_at, 'task' AS source FROM tasks WHERE status = 'failed'
          UNION ALL
          SELECT id, user_id, status, error, updated_at, 'social' AS source FROM social_automation_tasks WHERE status = 'failed'
        ) ORDER BY updated_at DESC LIMIT 8
        """
    ).fetchall()
    recent_audits = conn.execute(
        "SELECT id, actor_user_id, target_user_id, action, risk_level, outcome, created_at FROM audit_events ORDER BY created_at DESC LIMIT 8"
    ).fetchall()
    open_alerts = conn.execute(
        "SELECT id, severity, status, title, target_user_id, last_seen_at FROM security_alerts WHERE status IN ('open','acknowledged','investigating') ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, last_seen_at DESC LIMIT 8"
    ).fetchall()
    expiring_subscriptions = conn.execute(
        "SELECT id, user_id, plan_sku, current_period_end FROM billing_subscriptions "
        "WHERE status = 'active' AND current_period_end > ? AND current_period_end <= ? "
        "ORDER BY current_period_end ASC LIMIT 8",
        (current, current + 7 * 86400),
    ).fetchall()
    password_operations = conn.execute(
        "SELECT id, actor_user_id, target_user_id, action, reason, risk_level, created_at FROM audit_events "
        "WHERE action IN ('user.password_reveal','user.password_set','user.password_reset','user.password_restore') "
        "ORDER BY created_at DESC LIMIT 8"
    ).fetchall()
    batch_jobs = conn.execute(
        "SELECT id, action, status, total_count, success_count, failed_count, skipped_count, created_at, finished_at "
        "FROM admin_batch_jobs ORDER BY created_at DESC LIMIT 8"
    ).fetchall()
    return {
        "generated_at": current,
        "timezone": "Asia/Taipei",
        "range_days": safe_days,
        "summary": {
            "customers": int(users["customers"] or 0),
            "pending": int(users["pending"] or 0),
            "active": int(users["active"] or 0),
            "disabled": int(users["disabled"] or 0),
            "locked": int(users["locked"] or 0),
            "active_sessions": int(sessions["count"] or 0),
            "running_tasks": int(task_totals["running"] or 0),
            "success_today": int(task_totals["success_today"] or 0),
            "failed_today": int(task_totals["failed_today"] or 0),
            "active_subscriptions": int(subscriptions["count"] or 0),
            "wallet_points": round(int(wallet["units"] or 0) / 100, 2),
            "consumed_points": round(int(consumption["units"] or 0) / 100, 2),
            "open_alerts": int(alerts["count"] or 0),
            "service_health": "healthy",
        },
        "trends": {"users": user_trend, "tasks": task_trend, "billing": billing_trend},
        "distributions": {
            "lifecycle": [dict(row) for row in lifecycle_rows],
            "subscriptions": [dict(row) for row in subscription_rows],
            "alerts": [dict(row) for row in alert_rows],
        },
        "queues": {
            "pending_users": [dict(row) for row in pending_users],
            "failed_tasks": [dict(row) for row in recent_failures],
            "security_alerts": [dict(row) for row in open_alerts],
            "recent_audits": [dict(row) for row in recent_audits],
            "expiring_subscriptions": [dict(row) for row in expiring_subscriptions],
            "password_operations": [dict(row) for row in password_operations],
            "batch_jobs": [dict(row) for row in batch_jobs],
        },
    }


def audit_rows_to_csv(rows: Iterable[sqlite3.Row | dict[str, Any]]) -> str:
    output = io.StringIO(newline="")
    fieldnames = [
        "id",
        "created_at",
        "actor_user_id",
        "target_user_id",
        "action",
        "resource_type",
        "resource_id",
        "reason",
        "outcome",
        "error_code",
        "risk_level",
        "request_id",
        "ip_address",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        safe_row = {}
        for key, value in dict(row).items():
            if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
                safe_row[key] = "'" + value
            else:
                safe_row[key] = value
        writer.writerow(safe_row)
    return output.getvalue()
