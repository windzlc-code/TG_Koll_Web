from __future__ import annotations

import sqlite3
from typing import Any, Iterable

from .errors import CRMError
from .repository import dumps, loads, new_id, now_ts


ROTATION_EVENT_TYPE = "sender_rotation_state"
ROTATION_LOCK_THRESHOLD = 3


def _account(conn: sqlite3.Connection, *, user_id: int, account_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT id,user_id,platform,username FROM social_accounts WHERE id=? AND user_id=?",
        (str(account_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_account_not_found", "crm.errors.accountNotFound", status_code=404)
    return dict(row)


def classify_sender_message_failure(
    *,
    platform: str,
    warning: str = "",
    status: str = "",
    expected_username: str = "",
    logged_in_username: str = "",
    inspected_url: str = "",
) -> dict[str, Any]:
    channel = str(platform or "").strip().lower()
    if channel != "threads":
        return {"category": "not_applicable", "counts_toward_rotation": False}
    message = str(warning or "")
    normalized_status = str(status or "").strip().lower()
    expected = str(expected_username or "").strip().lstrip("@").lower()
    logged_in = str(logged_in_username or "").strip().lstrip("@").lower()
    lowered = message.lower()
    if normalized_status in {"needs_login", "mismatch"} or any(
        marker in lowered for marker in ("log in", "login", "password", "登入", "密码", "密碼")
    ):
        return {
            "category": "account_mismatch" if normalized_status == "mismatch" else "authentication_required",
            "counts_toward_rotation": False,
        }
    if any(
        marker in lowered
        for marker in (
            "follow", "mutual", "cannot message", "can't message", "not available",
            "contact safety", "blocked", "限制", "無法傳送", "无法发送", "追蹤", "关注",
        )
    ):
        return {"category": "recipient_contact_restricted", "counts_toward_rotation": False}
    if any(
        marker in lowered
        for marker in (
            "timeout", "timed out", "something went wrong", "try again", "network",
            "load", "暫時", "稍後", "载入", "載入", "网络", "網路",
        )
    ):
        return {"category": "transient_platform_error", "counts_toward_rotation": False}
    composer_unavailable = any(
        marker in lowered
        for marker in (
            "message composer was not visible", "composer was not visible",
            "composer not visible", "usable message composer", "private-message input",
            "private message input", "no message input", "no usable message input",
        )
    )
    if composer_unavailable:
        sender_verified = bool(expected and logged_in and expected == logged_in)
        inspected_message_surface = "/messages" in str(inspected_url or "").lower()
        qualified = sender_verified and inspected_message_surface
        return {
            "category": "sender_composer_unavailable" if qualified else "composer_unavailable_unqualified",
            "counts_toward_rotation": qualified,
        }
    return {"category": "other_unverified_failure", "counts_toward_rotation": False}


def get_sender_rotation_status(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
) -> dict[str, Any]:
    account = _account(conn, user_id=int(user_id), account_id=str(account_id))
    row = conn.execute(
        """
        SELECT payload_json,occurred_at FROM crm_events
        WHERE user_id=? AND lead_id=? AND event_type=? AND active=1
        ORDER BY occurred_at DESC,created_at DESC,rowid DESC LIMIT 1
        """,
        (int(user_id), str(account_id), ROTATION_EVENT_TYPE),
    ).fetchone()
    payload = loads(row["payload_json"], {}) if row is not None else {}
    payload = payload if isinstance(payload, dict) else {}
    consecutive = max(0, int(payload.get("consecutive_composer_failures") or 0))
    locked = consecutive >= ROTATION_LOCK_THRESHOLD or payload.get("locked") is True
    return {
        "account_id": str(account_id),
        "username": str(account.get("username") or ""),
        "platform": str(account.get("platform") or ""),
        "consecutive_composer_failures": consecutive,
        "locked": locked,
        "requires_follow_action": locked or payload.get("requires_follow_action") is True,
        "last_recipient": str(payload.get("last_recipient") or ""),
        "last_warning": str(payload.get("last_warning") or ""),
        "last_failure_category": str(payload.get("last_failure_category") or ""),
        "last_failure_qualified_for_rotation": payload.get("last_failure_qualified_for_rotation") is True,
        "updated_at": int(row["occurred_at"] or 0) if row is not None else 0,
        "reset_at": int(payload.get("reset_at") or 0),
    }


def update_sender_rotation_status(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    sent: bool,
    warning: str = "",
    status: str = "",
    recipient: str = "",
    logged_in_username: str = "",
    inspected_url: str = "",
) -> dict[str, Any]:
    account = _account(conn, user_id=int(user_id), account_id=str(account_id))
    previous = get_sender_rotation_status(conn, user_id=int(user_id), account_id=str(account_id))
    failure = classify_sender_message_failure(
        platform=str(account.get("platform") or ""),
        warning=warning,
        status=status,
        expected_username=str(account.get("username") or ""),
        logged_in_username=logged_in_username,
        inspected_url=inspected_url,
    )
    qualified = not bool(sent) and failure["counts_toward_rotation"] is True
    consecutive = int(previous["consecutive_composer_failures"]) + 1 if qualified else 0
    current = now_ts()
    payload = {
        "account_id": str(account_id),
        "username": str(account.get("username") or ""),
        "platform": str(account.get("platform") or ""),
        "consecutive_composer_failures": consecutive,
        "locked": consecutive >= ROTATION_LOCK_THRESHOLD,
        "requires_follow_action": consecutive >= ROTATION_LOCK_THRESHOLD,
        "last_recipient": str(recipient or "").strip().lstrip("@")[:80],
        "last_warning": str(warning or "")[:500],
        "last_failure_category": "" if sent else str(failure["category"]),
        "last_failure_qualified_for_rotation": qualified,
    }
    conn.execute(
        """
        INSERT INTO crm_events(
          id,user_id,lead_id,event_type,occurred_at,payload_json,active,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,1,?,?)
        """,
        (new_id("crm_event"), int(user_id), str(account_id), ROTATION_EVENT_TYPE, current, dumps(payload), current, current),
    )
    return get_sender_rotation_status(conn, user_id=int(user_id), account_id=str(account_id))


def evaluate_sender_rotation_sequence(
    results: Iterable[dict[str, Any]],
    *,
    platform: str,
    expected_username: str,
) -> dict[str, Any]:
    consecutive = 0
    locked = False
    for item in results:
        row = item if isinstance(item, dict) else {}
        failure = classify_sender_message_failure(
            platform=platform,
            warning=str(row.get("warning") or row.get("reason") or ""),
            status=str(row.get("status") or ""),
            expected_username=expected_username,
            logged_in_username=str(row.get("logged_in_username") or ""),
            inspected_url=str(row.get("inspected_url") or ""),
        )
        consecutive = consecutive + 1 if not bool(row.get("sent")) and failure["counts_toward_rotation"] else 0
        if consecutive >= ROTATION_LOCK_THRESHOLD:
            locked = True
            break
    return {
        "platform": str(platform or "").lower(),
        "consecutive_composer_failures": consecutive,
        "rotation_required": locked,
        "rotation_reason": "three_consecutive_composer_failures" if locked else "",
    }


def reset_sender_rotation_status(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    confirmed_follow_action: bool,
) -> dict[str, Any]:
    if confirmed_follow_action is not True:
        raise CRMError(
            "crm_rotation_follow_confirmation_required",
            "crm.errors.rotationFollowConfirmationRequired",
            status_code=409,
        )
    account = _account(conn, user_id=int(user_id), account_id=str(account_id))
    current = now_ts()
    payload = {
        "account_id": str(account_id),
        "username": str(account.get("username") or ""),
        "platform": str(account.get("platform") or ""),
        "consecutive_composer_failures": 0,
        "locked": False,
        "requires_follow_action": False,
        "reset_at": current,
        "last_failure_category": "",
        "last_failure_qualified_for_rotation": False,
    }
    conn.execute(
        """
        INSERT INTO crm_events(
          id,user_id,lead_id,event_type,occurred_at,payload_json,active,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,1,?,?)
        """,
        (new_id("crm_event"), int(user_id), str(account_id), ROTATION_EVENT_TYPE, current, dumps(payload), current, current),
    )
    return get_sender_rotation_status(conn, user_id=int(user_id), account_id=str(account_id))


def require_sender_rotation_unlocked(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
) -> dict[str, Any]:
    status = get_sender_rotation_status(conn, user_id=int(user_id), account_id=str(account_id))
    if status["locked"]:
        raise CRMError(
            "crm_sender_rotation_locked",
            "crm.errors.senderRotationLocked",
            status_code=409,
            details=status,
        )
    return status


__all__ = [
    "classify_sender_message_failure",
    "evaluate_sender_rotation_sequence",
    "get_sender_rotation_status",
    "require_sender_rotation_unlocked",
    "reset_sender_rotation_status",
    "update_sender_rotation_status",
]
