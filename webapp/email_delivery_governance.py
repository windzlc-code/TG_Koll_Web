from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

from .db import _ensure_email_delivery_governance_schema


BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account"
BREVO_AGGREGATED_REPORT_URL = (
    "https://api.brevo.com/v3/smtp/statistics/aggregatedReport"
)
DEFAULT_SNAPSHOT_TTL_SECONDS = 90
DEFAULT_SYNC_LEASE_SECONDS = 45
DEFAULT_SYNC_WAIT_SECONDS = 2.0
DEFAULT_SYNC_FAILURE_BACKOFF_SECONDS = 15
DEFAULT_ATTEMPT_LEASE_SECONDS = 30
DEFAULT_LIVE_SYNC_STALE_GRACE_SECONDS = 180


class EmailDeliveryGovernanceError(RuntimeError):
    pass


class EmailDeliverySyncError(EmailDeliveryGovernanceError):
    pass


class EmailDeliveryQuotaUnavailable(EmailDeliveryGovernanceError):
    pass


class EmailDeliveryQuotaExceeded(EmailDeliveryGovernanceError):
    pass


class EmailDeliveryAttemptConflict(EmailDeliveryGovernanceError):
    pass


class EmailDeliveryStorageError(EmailDeliveryGovernanceError):
    pass


def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(str(os.getenv(name, str(default)) or str(default)))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def _bounded_env_float(
    name: str,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    try:
        value = float(str(os.getenv(name, str(default)) or str(default)))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def _now(value: int | None = None) -> int:
    return int(time.time() if value is None else value)


def _quota_timezone():
    try:
        return ZoneInfo("Asia/Shanghai")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=8), name="Asia/Shanghai")


def _quota_day(now: int) -> str:
    return datetime.fromtimestamp(int(now), tz=_quota_timezone()).date().isoformat()


def _snapshot_ttl_seconds() -> int:
    return _bounded_env_int(
        "BREVO_QUOTA_SYNC_TTL_SECONDS",
        DEFAULT_SNAPSHOT_TTL_SECONDS,
        30,
        600,
    )


def _sync_lease_seconds() -> int:
    configured = _bounded_env_int(
        "BREVO_QUOTA_SYNC_LEASE_SECONDS",
        DEFAULT_SYNC_LEASE_SECONDS,
        10,
        300,
    )
    provider_timeout = _bounded_env_float(
        "BREVO_TIMEOUT_SECONDS",
        10.0,
        1.0,
        60.0,
    )
    # The sync makes two sequential requests. Each may spend its connect
    # timeout plus the configured read timeout, so the cross-process lease must
    # cover both requests and a small scheduling/commit margin.
    minimum_safe_lease = int(
        (2 * (min(provider_timeout, 5.0) + provider_timeout)) + 15
    )
    return max(configured, minimum_safe_lease)


def _sync_wait_seconds() -> float:
    return _bounded_env_float(
        "BREVO_QUOTA_SYNC_WAIT_SECONDS",
        DEFAULT_SYNC_WAIT_SECONDS,
        0.05,
        5.0,
    )


def _sync_failure_backoff_seconds() -> int:
    return _bounded_env_int(
        "BREVO_QUOTA_SYNC_FAILURE_BACKOFF_SECONDS",
        DEFAULT_SYNC_FAILURE_BACKOFF_SECONDS,
        1,
        300,
    )


def _attempt_lease_seconds() -> int:
    provider_timeout = _bounded_env_float(
        "BREVO_TIMEOUT_SECONDS",
        10.0,
        1.0,
        60.0,
    )
    minimum_safe_lease = int(min(provider_timeout, 5.0) + provider_timeout + 15)
    configured = _bounded_env_int(
        "EMAIL_DELIVERY_ATTEMPT_LEASE_SECONDS",
        DEFAULT_ATTEMPT_LEASE_SECONDS,
        10,
        300,
    )
    return max(configured, minimum_safe_lease)


def _live_sync_stale_grace_seconds() -> int:
    return _bounded_env_int(
        "BREVO_QUOTA_LIVE_SYNC_STALE_GRACE_SECONDS",
        DEFAULT_LIVE_SYNC_STALE_GRACE_SECONDS,
        30,
        600,
    )


def _rollback_quietly(conn: sqlite3.Connection) -> None:
    try:
        if conn.in_transaction:
            conn.rollback()
    except sqlite3.Error:
        pass


def _storage_error(exc: sqlite3.OperationalError) -> EmailDeliveryStorageError:
    return EmailDeliveryStorageError("email delivery storage is temporarily busy")


def ensure_email_delivery_governance_schema(conn: sqlite3.Connection) -> None:
    _ensure_email_delivery_governance_schema(conn)


def _row_dict(row: sqlite3.Row | None) -> dict[str, Any]:
    return dict(row) if row is not None else {}


def _json_object(response: requests.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except (TypeError, ValueError) as exc:
        raise EmailDeliverySyncError("Brevo returned an invalid response") from exc
    if not isinstance(value, dict):
        raise EmailDeliverySyncError("Brevo returned an invalid response")
    return value


def _safe_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _extract_remaining_credits(account: dict[str, Any]) -> int:
    credits: list[int] = []
    plan = account.get("plan")
    if not isinstance(plan, list):
        return 0
    for item in plan:
        if not isinstance(item, dict):
            continue
        if str(item.get("creditsType") or "").strip().lower() != "sendlimit":
            continue
        plan_type = str(item.get("type") or "").strip().lower()
        if plan_type in {"sms", "whatsapp"}:
            continue
        credits.append(_safe_int(item.get("credits")))
    return max(credits, default=0)


def _safe_account_snapshot(account: dict[str, Any]) -> dict[str, Any]:
    """Persist quota metadata only; do not retain account identity or API secrets."""

    relay = account.get("relay")
    relay_enabled = (
        bool(relay.get("enabled"))
        if isinstance(relay, dict)
        else False
    )
    return {
        "plan": account.get("plan") if isinstance(account.get("plan"), list) else [],
        "planVerticals": (
            account.get("planVerticals")
            if isinstance(account.get("planVerticals"), list)
            else []
        ),
        "relayEnabled": relay_enabled,
    }


def _brevo_headers(api_key: str) -> dict[str, str]:
    return {
        "api-key": api_key,
        "Accept": "application/json",
        "User-Agent": "Vecto-OS-Email-Governance/1.0",
    }


def _load_brevo_sync_config() -> tuple[str, float]:
    api_key = str(os.getenv("BREVO_API_KEY", "") or "").strip()
    try:
        timeout_seconds = float(
            str(os.getenv("BREVO_TIMEOUT_SECONDS", "10") or "10")
        )
    except (TypeError, ValueError) as exc:
        raise EmailDeliverySyncError("Brevo quota sync is not configured") from exc
    if (
        not api_key.startswith("xkeysib-")
        or len(api_key) < 32
        or not 1 <= timeout_seconds <= 60
    ):
        raise EmailDeliverySyncError("Brevo quota sync is not configured")
    return api_key, timeout_seconds


def _snapshot_is_fresh(snapshot: dict[str, Any], now: int) -> bool:
    synced_at = _safe_int(snapshot.get("synced_at"))
    return (
        str(snapshot.get("report_day") or "") == _quota_day(now)
        and synced_at > 0
        and now - synced_at <= _snapshot_ttl_seconds()
    )


def _snapshot_is_usable_during_live_sync(
    snapshot: dict[str, Any],
    sync_state: dict[str, Any],
    now: int,
) -> bool:
    synced_at = _safe_int(snapshot.get("synced_at"))
    snapshot_age = now - synced_at
    return (
        str(snapshot.get("report_day") or "") == _quota_day(now)
        and _safe_int(snapshot.get("provider_daily_limit")) > 0
        and synced_at > 0
        and snapshot_age >= 0
        and snapshot_age
        <= _snapshot_ttl_seconds() + _live_sync_stale_grace_seconds()
        and bool(str(sync_state.get("lease_token") or ""))
        and _safe_int(sync_state.get("lease_expires_at")) > now
    )


def _quota_snapshot_is_usable(conn: sqlite3.Connection, now: int) -> bool:
    snapshot = _row_dict(
        conn.execute(
            "SELECT * FROM email_delivery_provider_snapshot WHERE id = 1"
        ).fetchone()
    )
    if _snapshot_is_fresh(snapshot, now):
        return True
    sync_state = _row_dict(
        conn.execute("SELECT * FROM email_delivery_sync_state WHERE id = 1").fetchone()
    )
    return _snapshot_is_usable_during_live_sync(snapshot, sync_state, now)


def get_email_delivery_policy(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT mode, manual_daily_limit, updated_by, created_at, updated_at
        FROM email_delivery_policy
        WHERE id = 1
        """
    ).fetchone()
    if row is None:
        raise EmailDeliveryGovernanceError("email delivery policy is unavailable")
    return {
        "mode": str(row["mode"]),
        "manual_daily_limit": (
            int(row["manual_daily_limit"])
            if row["manual_daily_limit"] is not None
            else None
        ),
        "updated_by": int(row["updated_by"] or 0),
        "created_at": int(row["created_at"] or 0),
        "updated_at": int(row["updated_at"] or 0),
    }


def set_email_delivery_policy(
    conn: sqlite3.Connection,
    mode: str,
    manual_daily_limit: int | None,
    now: int,
    *,
    updated_by: int = 0,
) -> dict[str, Any]:
    clean_mode = str(mode or "").strip().lower()
    if clean_mode not in {"auto", "manual"}:
        raise ValueError("email delivery policy mode must be auto or manual")
    clean_limit: int | None = None
    if clean_mode == "manual":
        try:
            clean_limit = int(manual_daily_limit or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("manual daily limit must be a positive integer") from exc
        if clean_limit <= 0:
            raise ValueError("manual daily limit must be a positive integer")
        snapshot = _row_dict(
            conn.execute(
                """
                SELECT provider_daily_limit
                FROM email_delivery_provider_snapshot
                WHERE id = 1
                """
            ).fetchone()
        )
        provider_limit = _safe_int(snapshot.get("provider_daily_limit"))
        if provider_limit <= 0:
            raise EmailDeliveryQuotaUnavailable(
                "Brevo daily limit is not available"
            )
        if clean_limit > provider_limit:
            raise ValueError("manual daily limit cannot exceed the Brevo limit")
    now_ts = _now(now)
    conn.execute(
        """
        UPDATE email_delivery_policy
        SET mode = ?,
            manual_daily_limit = ?,
            updated_by = ?,
            created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END,
            updated_at = ?
        WHERE id = 1
        """,
        (clean_mode, clean_limit, max(0, int(updated_by)), now_ts, now_ts),
    )
    return get_email_delivery_policy(conn)


def _local_attempt_counts(
    conn: sqlite3.Connection,
    day: str,
) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT status, COALESCE(SUM(units), 0) AS units
        FROM email_delivery_attempts
        WHERE quota_day = ?
        GROUP BY status
        """,
        (day,),
    ).fetchall()
    result = {
        "reserved": 0,
        "accepted": 0,
        "failed": 0,
        "unknown": 0,
    }
    for row in rows:
        status = str(row["status"])
        if status in result:
            result[status] = int(row["units"] or 0)
    unreconciled_accepted = conn.execute(
        """
        SELECT COALESCE(SUM(units), 0) AS units
        FROM email_delivery_attempts
        WHERE quota_day = ?
          AND status = 'accepted'
          AND reconciled_at = 0
        """,
        (day,),
    ).fetchone()
    result["unreconciled_accepted"] = int(
        unreconciled_accepted["units"] if unreconciled_accepted else 0
    )
    return result


def get_email_delivery_overview(
    conn: sqlite3.Connection,
    now: int | None = None,
) -> dict[str, Any]:
    now_ts = _now(now)
    day = _quota_day(now_ts)
    snapshot = _row_dict(
        conn.execute(
            "SELECT * FROM email_delivery_provider_snapshot WHERE id = 1"
        ).fetchone()
    )
    sync_state = _row_dict(
        conn.execute("SELECT * FROM email_delivery_sync_state WHERE id = 1").fetchone()
    )
    policy = get_email_delivery_policy(conn)
    provider_limit = _safe_int(snapshot.get("provider_daily_limit"))
    manual_limit = policy.get("manual_daily_limit")
    effective_limit = provider_limit
    if policy["mode"] == "manual" and manual_limit is not None:
        effective_limit = min(provider_limit, int(manual_limit))
    counts = _local_attempt_counts(conn, day)
    requests_today = (
        _safe_int(snapshot.get("requests_today"))
        if str(snapshot.get("report_day") or "") == day
        else 0
    )
    # Reserved, unreconciled accepted and unknown attempts are intentionally
    # added to the last provider report so concurrent workers cannot oversend.
    local_guard = (
        counts["reserved"]
        + counts["unreconciled_accepted"]
        + counts["unknown"]
    )
    used_with_guard = requests_today + local_guard
    fresh = _snapshot_is_fresh(snapshot, now_ts)
    return {
        "provider": "brevo",
        "mode": policy["mode"],
        "manual_daily_limit": manual_limit,
        "effective_daily_limit": effective_limit,
        "remaining_today": max(0, effective_limit - used_with_guard),
        "requests_today": requests_today,
        "delivered_today": (
            _safe_int(snapshot.get("delivered_today"))
            if str(snapshot.get("report_day") or "") == day
            else 0
        ),
        "failed_today": (
            _safe_int(snapshot.get("failed_today"))
            if str(snapshot.get("report_day") or "") == day
            else 0
        ),
        "provider_remaining_credits": _safe_int(
            snapshot.get("provider_remaining_credits")
        ),
        "synced_at": _safe_int(snapshot.get("synced_at")),
        "stale": not fresh,
        "sync_error": str(sync_state.get("last_error") or ""),
        "local_reserved": counts["reserved"],
        "local_accepted": counts["accepted"],
        "local_failed": counts["failed"],
        "local_unknown": counts["unknown"],
        "local_guard_units": local_guard,
        "report_day": day,
    }


def _record_sync_failure(
    conn: sqlite3.Connection,
    lease_token: str,
    now: int,
    error: str,
) -> None:
    if conn.in_transaction:
        raise EmailDeliveryGovernanceError(
            "email delivery sync requires a clean database transaction"
        )
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        """
        UPDATE email_delivery_sync_state
        SET lease_token = '',
            lease_expires_at = 0,
            last_error = ?,
            updated_at = ?
        WHERE id = 1 AND lease_token = ?
        """,
        (str(error)[:200], now, lease_token),
    )
    conn.commit()


def _sync_brevo_usage_impl(
    conn: sqlite3.Connection,
    force: bool = False,
    *,
    now: int | None = None,
) -> dict[str, Any]:
    now_ts = _now(now)
    snapshot = _row_dict(
        conn.execute(
            "SELECT * FROM email_delivery_provider_snapshot WHERE id = 1"
        ).fetchone()
    )
    if not force and _snapshot_is_fresh(snapshot, now_ts):
        return get_email_delivery_overview(conn, now_ts)

    if conn.in_transaction:
        raise EmailDeliveryGovernanceError(
            "email delivery sync requires a clean database transaction"
        )
    sync_state = _row_dict(
        conn.execute("SELECT * FROM email_delivery_sync_state WHERE id = 1").fetchone()
    )
    if (
        not force
        and str(sync_state.get("last_error") or "")
        and _safe_int(sync_state.get("last_attempt_at")) > 0
        and now_ts - _safe_int(sync_state.get("last_attempt_at"))
        < _sync_failure_backoff_seconds()
    ):
        return get_email_delivery_overview(conn, now_ts)

    lease_token = secrets.token_urlsafe(24)
    conn.execute("BEGIN IMMEDIATE")
    cursor = conn.execute(
        """
        UPDATE email_delivery_sync_state
        SET lease_token = ?,
            lease_expires_at = ?,
            last_attempt_at = ?,
            updated_at = ?
        WHERE id = 1
          AND (lease_expires_at <= ? OR lease_token = '')
        """,
        (
            lease_token,
            now_ts + _sync_lease_seconds(),
            now_ts,
            now_ts,
            now_ts,
        ),
    )
    conn.commit()
    if cursor.rowcount != 1:
        current = get_email_delivery_overview(conn, now_ts)
        if not current["stale"]:
            return current
        # Another process owns the provider sync. Wait briefly for its durable
        # snapshot instead of making concurrent registration requests fail at
        # every TTL boundary. This is condition-based and capped to keep the
        # request path responsive.
        deadline = time.monotonic() + _sync_wait_seconds()
        while time.monotonic() < deadline:
            time.sleep(0.05)
            current = get_email_delivery_overview(conn, now_ts)
            if not current["stale"]:
                return current
            state = _row_dict(
                conn.execute(
                    "SELECT * FROM email_delivery_sync_state WHERE id = 1"
                ).fetchone()
            )
            if (
                not str(state.get("lease_token") or "")
                and _safe_int(state.get("lease_expires_at")) <= now_ts
            ):
                break
        return current

    try:
        api_key, timeout_seconds = _load_brevo_sync_config()
        headers = _brevo_headers(api_key)
        timeout = (min(timeout_seconds, 5.0), timeout_seconds)
        day = _quota_day(now_ts)
        account_response = requests.get(
            BREVO_ACCOUNT_URL,
            headers=headers,
            timeout=timeout,
            allow_redirects=False,
        )
        if account_response.status_code != 200:
            raise EmailDeliverySyncError(
                f"Brevo account sync failed ({account_response.status_code})"
            )
        report_response = requests.get(
            BREVO_AGGREGATED_REPORT_URL,
            headers=headers,
            params={"startDate": day, "endDate": day},
            timeout=timeout,
            allow_redirects=False,
        )
        if report_response.status_code != 200:
            raise EmailDeliverySyncError(
                f"Brevo report sync failed ({report_response.status_code})"
            )
        account = _json_object(account_response)
        report = _json_object(report_response)
        requests_today = _safe_int(report.get("requests"))
        remaining_credits = _extract_remaining_credits(account)
        # Brevo exposes currently available sendLimit credits. Combining that
        # with today's accepted requests yields a stable daily ceiling.
        provider_daily_limit = requests_today + remaining_credits
        failed_today = sum(
            _safe_int(report.get(key))
            for key in ("blocked", "hardBounces", "softBounces", "invalid")
        )
    except requests.RequestException as exc:
        _record_sync_failure(
            conn,
            lease_token,
            now_ts,
            "Brevo quota sync network failure",
        )
        raise EmailDeliverySyncError("Brevo quota sync failed") from exc
    except EmailDeliverySyncError as exc:
        _record_sync_failure(conn, lease_token, now_ts, str(exc))
        raise

    conn.execute("BEGIN IMMEDIATE")
    lease = conn.execute(
        """
        SELECT lease_token
        FROM email_delivery_sync_state
        WHERE id = 1
        """
    ).fetchone()
    if lease is None or str(lease["lease_token"]) != lease_token:
        conn.rollback()
        return get_email_delivery_overview(conn, now_ts)
    conn.execute(
        """
        UPDATE email_delivery_provider_snapshot
        SET provider = 'brevo',
            report_day = ?,
            provider_daily_limit = ?,
            provider_remaining_credits = ?,
            requests_today = ?,
            delivered_today = ?,
            failed_today = ?,
            account_json = ?,
            report_json = ?,
            synced_at = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            day,
            provider_daily_limit,
            remaining_credits,
            requests_today,
            _safe_int(report.get("delivered")),
            failed_today,
            json.dumps(_safe_account_snapshot(account), ensure_ascii=False),
            json.dumps(report, ensure_ascii=False),
            now_ts,
            now_ts,
        ),
    )
    # The report now accounts for accepted attempts predating this snapshot.
    # Unknown attempts stay unreconciled and continue reserving capacity.
    conn.execute(
        """
        UPDATE email_delivery_attempts
        SET reconciled_at = ?, updated_at = ?
        WHERE quota_day = ?
          AND status = 'accepted'
          AND reconciled_at = 0
          AND accepted_at > 0
          AND accepted_at <= ?
        """,
        (now_ts, now_ts, day, now_ts),
    )
    conn.execute(
        """
        UPDATE email_delivery_sync_state
        SET lease_token = '',
            lease_expires_at = 0,
            last_success_at = ?,
            last_error = '',
            updated_at = ?
        WHERE id = 1 AND lease_token = ?
        """,
        (now_ts, now_ts, lease_token),
    )
    conn.commit()
    return get_email_delivery_overview(conn, now_ts)


def sync_brevo_usage(
    conn: sqlite3.Connection,
    force: bool = False,
    *,
    now: int | None = None,
) -> dict[str, Any]:
    try:
        return _sync_brevo_usage_impl(conn, force=force, now=now)
    except sqlite3.OperationalError as exc:
        _rollback_quietly(conn)
        raise _storage_error(exc) from exc


def _attempt_result(
    row: sqlite3.Row | dict[str, Any],
    *,
    owned: bool,
    recovered: bool = False,
) -> dict[str, Any]:
    result = dict(row)
    result["delivery_owned"] = bool(owned)
    result["delivery_recovered"] = bool(recovered)
    return result


def _reserve_email_delivery_attempt_impl(
    conn: sqlite3.Connection,
    *,
    attempt_id: str,
    idempotency_key: str,
    recipient: str = "",
    purpose: str = "",
    user_id: int = 0,
    units: int = 1,
    now: int | None = None,
    owner_token: str = "",
) -> dict[str, Any]:
    clean_id = str(attempt_id or "").strip()
    clean_key = str(idempotency_key or "").strip()
    clean_purpose = str(purpose or "").strip()[:80]
    if not clean_id or len(clean_id) > 200 or not clean_key or len(clean_key) > 200:
        raise ValueError("invalid email delivery attempt identifier")
    clean_units = int(units)
    if clean_units <= 0 or clean_units > 2000:
        raise ValueError("invalid email delivery attempt units")
    now_ts = _now(now)
    clean_owner_token = str(owner_token or "").strip()
    if not clean_owner_token:
        clean_owner_token = secrets.token_urlsafe(24)
    if len(clean_owner_token) > 200:
        raise ValueError("invalid email delivery owner token")
    overview = get_email_delivery_overview(conn, now_ts)
    if overview["stale"] and not _quota_snapshot_is_usable(conn, now_ts):
        raise EmailDeliveryQuotaUnavailable(
            "Brevo quota snapshot is unavailable or stale"
        )
    recipient_hash = (
        hashlib.sha256(str(recipient).strip().casefold().encode("utf-8")).hexdigest()
        if str(recipient or "").strip()
        else ""
    )
    if conn.in_transaction:
        raise EmailDeliveryGovernanceError(
            "email delivery reservation requires a clean database transaction"
        )
    conn.execute("BEGIN IMMEDIATE")
    existing = conn.execute(
        """
        SELECT *
        FROM email_delivery_attempts
        WHERE id = ? OR idempotency_key = ?
        """,
        (clean_id, clean_key),
    ).fetchone()
    if existing is not None:
        if (
            str(existing["id"]) != clean_id
            or str(existing["idempotency_key"]) != clean_key
            or int(existing["units"]) != clean_units
            or str(existing["purpose"]) != clean_purpose
            or int(existing["user_id"]) != max(0, int(user_id))
            or str(existing["recipient_hash"]) != recipient_hash
        ):
            conn.rollback()
            raise EmailDeliveryAttemptConflict(
                "email delivery idempotency key conflicts with another attempt"
            )
        old_status = str(existing["status"])
        stored_owner = str(existing["delivery_owner_token"] or "")
        if old_status == "reserved" and stored_owner == clean_owner_token:
            conn.commit()
            return _attempt_result(existing, owned=True)
        if (
            old_status == "reserved"
            and int(existing["delivery_lease_expires_at"] or 0) <= now_ts
        ):
            conn.execute(
                """
                UPDATE email_delivery_attempts
                SET delivery_owner_token = ?,
                    delivery_lease_expires_at = ?,
                    updated_at = ?
                WHERE id = ?
                  AND status = 'reserved'
                  AND delivery_lease_expires_at <= ?
                """,
                (
                    clean_owner_token,
                    now_ts + _attempt_lease_seconds(),
                    now_ts,
                    clean_id,
                    now_ts,
                ),
            )
            recovered = conn.execute(
                "SELECT * FROM email_delivery_attempts WHERE id = ?",
                (clean_id,),
            ).fetchone()
            conn.commit()
            owns_recovered = (
                recovered is not None
                and str(recovered["delivery_owner_token"]) == clean_owner_token
            )
            return _attempt_result(
                recovered,
                owned=owns_recovered,
                recovered=owns_recovered,
            )
        conn.commit()
        return _attempt_result(existing, owned=False)

    # Re-read under the write lock so multiple processes cannot reserve the
    # final available email simultaneously.
    current = get_email_delivery_overview(conn, now_ts)
    if current["stale"] and not _quota_snapshot_is_usable(conn, now_ts):
        conn.rollback()
        raise EmailDeliveryQuotaUnavailable(
            "Brevo quota snapshot is unavailable or stale"
        )
    if int(current["remaining_today"]) < clean_units:
        conn.rollback()
        raise EmailDeliveryQuotaExceeded("daily email delivery limit reached")
    day = _quota_day(now_ts)
    conn.execute(
        """
        INSERT INTO email_delivery_attempts(
          id, idempotency_key, user_id, purpose, recipient_hash, units,
          status, provider_message_id, error_code, quota_day, reserved_at,
          delivery_owner_token, delivery_lease_expires_at,
          accepted_at, finished_at, reconciled_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, 'reserved', '', '', ?, ?, ?, ?,
          0, 0, 0, ?, ?
        )
        """,
        (
            clean_id,
            clean_key,
            max(0, int(user_id)),
            clean_purpose,
            recipient_hash,
            clean_units,
            day,
            now_ts,
            clean_owner_token,
            now_ts + _attempt_lease_seconds(),
            now_ts,
            now_ts,
        ),
    )
    row = conn.execute(
        "SELECT * FROM email_delivery_attempts WHERE id = ?",
        (clean_id,),
    ).fetchone()
    conn.commit()
    return _attempt_result(row, owned=True)


def reserve_email_delivery_attempt(
    conn: sqlite3.Connection,
    *,
    attempt_id: str,
    idempotency_key: str,
    recipient: str = "",
    purpose: str = "",
    user_id: int = 0,
    units: int = 1,
    now: int | None = None,
    owner_token: str = "",
) -> dict[str, Any]:
    try:
        return _reserve_email_delivery_attempt_impl(
            conn,
            attempt_id=attempt_id,
            idempotency_key=idempotency_key,
            recipient=recipient,
            purpose=purpose,
            user_id=user_id,
            units=units,
            now=now,
            owner_token=owner_token,
        )
    except sqlite3.OperationalError as exc:
        _rollback_quietly(conn)
        raise _storage_error(exc) from exc


def wait_for_email_delivery_attempt(
    conn: sqlite3.Connection,
    attempt_id: str,
    *,
    timeout_seconds: float = 2.0,
) -> dict[str, Any]:
    clean_id = str(attempt_id or "").strip()
    deadline = time.monotonic() + max(0.0, min(300.0, float(timeout_seconds)))
    try:
        while True:
            row = conn.execute(
                "SELECT * FROM email_delivery_attempts WHERE id = ?",
                (clean_id,),
            ).fetchone()
            if row is None:
                raise EmailDeliveryGovernanceError(
                    "email delivery attempt was not found"
                )
            if str(row["status"]) != "reserved" or time.monotonic() >= deadline:
                return _attempt_result(row, owned=False)
            time.sleep(0.05)
    except sqlite3.OperationalError as exc:
        _rollback_quietly(conn)
        raise _storage_error(exc) from exc


def _mark_email_delivery_attempt_impl(
    conn: sqlite3.Connection,
    attempt_id: str,
    status: str,
    *,
    message_id: str = "",
    error_code: str = "",
    now: int | None = None,
    owner_token: str = "",
) -> dict[str, Any]:
    clean_status = str(status or "").strip().lower()
    if clean_status not in {"accepted", "failed", "unknown"}:
        raise ValueError("invalid email delivery attempt status")
    clean_id = str(attempt_id or "").strip()
    now_ts = _now(now)
    if conn.in_transaction:
        raise EmailDeliveryGovernanceError(
            "email delivery attempt update requires a clean database transaction"
        )
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        "SELECT * FROM email_delivery_attempts WHERE id = ?",
        (clean_id,),
    ).fetchone()
    if row is None:
        conn.rollback()
        raise EmailDeliveryGovernanceError("email delivery attempt was not found")
    old_status = str(row["status"])
    clean_owner_token = str(owner_token or "").strip()
    if (
        clean_owner_token
        and str(row["delivery_owner_token"] or "") != clean_owner_token
    ):
        conn.rollback()
        raise EmailDeliveryAttemptConflict(
            "email delivery attempt is owned by another sender"
        )
    if old_status != "reserved":
        if old_status != clean_status:
            conn.rollback()
            raise EmailDeliveryAttemptConflict(
                "email delivery attempt already has a terminal status"
            )
        conn.commit()
        return dict(row)
    clean_message_id = str(message_id or "").strip()[:500]
    if clean_status == "accepted" and not clean_message_id:
        conn.rollback()
        raise ValueError("accepted email delivery requires a message id")
    accepted_at = now_ts if clean_status == "accepted" else 0
    conn.execute(
        """
        UPDATE email_delivery_attempts
        SET status = ?,
            provider_message_id = ?,
            error_code = ?,
            accepted_at = ?,
            finished_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'reserved'
        """,
        (
            clean_status,
            clean_message_id,
            str(error_code or "").strip()[:100],
            accepted_at,
            now_ts,
            now_ts,
            clean_id,
        ),
    )
    updated = conn.execute(
        "SELECT * FROM email_delivery_attempts WHERE id = ?",
        (clean_id,),
    ).fetchone()
    conn.commit()
    return dict(updated)


def mark_email_delivery_attempt(
    conn: sqlite3.Connection,
    attempt_id: str,
    status: str,
    *,
    message_id: str = "",
    error_code: str = "",
    now: int | None = None,
    owner_token: str = "",
) -> dict[str, Any]:
    try:
        return _mark_email_delivery_attempt_impl(
            conn,
            attempt_id,
            status,
            message_id=message_id,
            error_code=error_code,
            now=now,
            owner_token=owner_token,
        )
    except sqlite3.OperationalError as exc:
        _rollback_quietly(conn)
        raise _storage_error(exc) from exc
