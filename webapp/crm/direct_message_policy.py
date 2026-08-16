from __future__ import annotations

import re
import sqlite3
from typing import Any


_CONTACT_RE = re.compile(
    r"(?:https?://|www\.|line\s*@|line\.me|wa\.me|whatsapp|telegram|\+?\d[\d\s().-]{6,}\d)",
    re.IGNORECASE,
)
_PRESSURE_RE = re.compile(
    r"(?:#\S+|限时|限時|最后名额|最後名額|名额有限|名額有限|立即加入|立即购买|立即購買|"
    r"limited\s+time|act\s+now|guaranteed)",
    re.IGNORECASE,
)
_REPLY_EVENTS = (
    "reply",
    "replied",
    "message_reply",
    "dm_reply",
    "public_reply_received",
    "public_comment_reply_received",
)
_CONSENT_EVENTS = (
    "consent_verified",
    "reply_consent_verified",
    "public_reply_consent_verified",
)


def evaluate_direct_message_trust(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    action: dict[str, Any],
) -> dict[str, Any]:
    """Require tenant-owned evidence before a first private message.

    Client booleans are deliberately ignored. Trust must come from a persisted
    relationship check, a proved public reply, or an explicit consent event.
    """

    payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
    lead_id = str(payload.get("lead_id") or payload.get("leadId") or "").strip()
    if not lead_id:
        return {"allowed": False, "code": "trust_evidence_required", "lead_id": ""}

    relationship = None
    try:
        relationship = conn.execute(
            """
            SELECT id,status,verified_at
            FROM crm_relationships
            WHERE user_id=? AND lead_id=? AND account_id=? AND active=1
              AND lower(status) IN ('follows_sender','mutual')
            ORDER BY verified_at DESC,updated_at DESC LIMIT 1
            """,
            (int(user_id), lead_id, str(account_id)),
        ).fetchone()
    except sqlite3.OperationalError:
        relationship = None

    event = None
    event_types = (*_CONSENT_EVENTS, *_REPLY_EVENTS)
    placeholders = ",".join("?" for _ in event_types)
    try:
        event = conn.execute(
            f"""
            SELECT id,event_type,occurred_at
            FROM crm_events
            WHERE user_id=? AND lead_id=? AND active=1
              AND lower(event_type) IN ({placeholders})
            ORDER BY occurred_at DESC,updated_at DESC LIMIT 1
            """,
            (int(user_id), lead_id, *event_types),
        ).fetchone()
    except sqlite3.OperationalError:
        event = None

    event_type = str(event["event_type"] or "").strip().lower() if event is not None else ""
    explicit_consent = event_type in _CONSENT_EVENTS
    trust_source = (
        "explicit_consent"
        if explicit_consent
        else "public_reply"
        if event is not None
        else "verified_relationship"
        if relationship is not None
        else ""
    )
    if not trust_source:
        return {"allowed": False, "code": "trust_evidence_required", "lead_id": lead_id}

    # Explicit consent may use the approved template. Relationship/public-reply
    # trust remains a first-touch message and must stay short and non-promotional.
    if not explicit_consent:
        content = str(action.get("content") or "").strip()
        if len(content) < 12 or len(content) > 180:
            return {
                "allowed": False,
                "code": "trust_first_message_length",
                "lead_id": lead_id,
                "source": trust_source,
            }
        if _CONTACT_RE.search(content) or _PRESSURE_RE.search(content):
            return {
                "allowed": False,
                "code": "trust_first_message_content",
                "lead_id": lead_id,
                "source": trust_source,
            }
        if payload.get("media_id") or payload.get("media_ids") or payload.get("destination_id"):
            return {
                "allowed": False,
                "code": "trust_first_message_attachment",
                "lead_id": lead_id,
                "source": trust_source,
            }

    return {
        "allowed": True,
        "code": "",
        "lead_id": lead_id,
        "source": trust_source,
        "evidence_id": str(
            event["id"] if event is not None else relationship["id"] if relationship is not None else ""
        ),
    }
