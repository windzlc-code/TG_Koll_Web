from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sqlite3
import time
from collections.abc import Callable, Iterable
from typing import Any

from .errors import CRMError
from .comment_policy import assess_public_comment_content
from .direct_message_policy import evaluate_direct_message_trust
from .engagement_policy import PUBLIC_COMMENT_MAX_PER_DAY, evaluate_public_comment_rate
from .instagram_group_validation import validate_instagram_group_create_targets
from .repository import canonicalize_action, dumps, find_active_duplicate_action, loads


EXECUTABLE_ACTION_TYPES = {
    "account_check",
    "open_login",
    "collect_feed",
    "collect_profile",
    "public_comment",
    "public_reply",
    "followup_reply",
    "nurture_reply",
    "like",
    "repost",
    "threads_group_invite_post",
    "direct_message",
    "instagram_group_candidates_inspect",
    "instagram_recent_conversations_inspect",
    "instagram_conversation_controls_inspect",
    "instagram_group_create",
    "instagram_group_post",
    "instagram_group_settings_update",
    "instagram_group_members_add",
    "instagram_group_members_inspect",
    "instagram_group_status_inspect",
}


# ``share`` is intentionally not executable here: the current browser worker's
# only deterministic operation is "Copy link", which does not create a remote
# platform write and therefore must not reserve or settle the interaction SKU.


def _encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decoded(value: str) -> bytes:
    return base64.urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}")


def actions_hash(actions: Iterable[dict[str, Any]]) -> str:
    return hashlib.sha256(dumps(list(actions)).encode("utf-8")).hexdigest()


def _secret_bytes(secret: str) -> bytes:
    clean = str(secret or "").strip()
    if len(clean) < 32:
        raise CRMError(
            "crm_preflight_unavailable", "crm.errors.preflightUnavailable",
            status_code=503, retryable=True,
        )
    return clean.encode("utf-8")


def sign_preflight_token(payload: dict[str, Any], *, secret: str) -> str:
    encoded = _encoded(dumps(payload).encode("utf-8"))
    signature = hmac.new(_secret_bytes(secret), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_encoded(signature)}"


def verify_preflight_token(
    token: str,
    *,
    secret: str,
    user_id: int,
    actions: Iterable[dict[str, Any]],
    current_time: int | None = None,
) -> dict[str, Any]:
    try:
        encoded, supplied_signature = str(token or "").rsplit(".", 1)
        expected = hmac.new(_secret_bytes(secret), encoded.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _decoded(supplied_signature)):
            raise ValueError("signature")
        payload = json.loads(_decoded(encoded).decode("utf-8"))
    except CRMError:
        raise
    except Exception as exc:
        raise CRMError("crm_preflight_invalid", "crm.errors.preflightInvalid", status_code=409) from exc
    now = int(current_time if current_time is not None else time.time())
    canonical = [canonicalize_action(dict(action)) for action in actions if isinstance(action, dict)]
    if (
        int(payload.get("user_id") or 0) != int(user_id)
        or str(payload.get("actions_hash") or "") != actions_hash(canonical)
        or int(payload.get("expires_at") or 0) < now
    ):
        raise CRMError("crm_preflight_invalid", "crm.errors.preflightInvalid", status_code=409)
    return payload


def build_preflight(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    actions: Iterable[dict[str, Any]],
    secret: str,
    rate_lookup: Callable[[sqlite3.Connection, str], tuple[int, str]] | None = None,
    current_time: int | None = None,
    ttl_seconds: int = 300,
) -> dict[str, Any]:
    raw_actions = [dict(item) for item in actions if isinstance(item, dict)]
    if not raw_actions or len(raw_actions) > 200:
        raise CRMError("crm_invalid_action_count", "crm.errors.invalidActionCount", status_code=400)
    now = int(current_time if current_time is not None else time.time())
    canonical = [canonicalize_action(item) for item in raw_actions]
    decisions: list[dict[str, Any]] = []
    allowed: list[dict[str, Any]] = []
    duplicate_count = 0
    blocked_count = 0
    planned_write_keys: set[tuple[str, str, str]] = set()
    planned_comments_by_account: dict[str, list[str]] = {}
    planned_comment_count_by_account: dict[str, int] = {}
    for index, action in enumerate(canonical):
        reason = ""
        policy: dict[str, Any] = {}
        duplicate = None
        action_type = str(action["action_type"])
        if action_type not in EXECUTABLE_ACTION_TYPES:
            reason = "crm_action_blocked"
        account_id = str(action.get("account_id") or "")
        account = None
        if not reason:
            if not account_id:
                reason = "crm_account_required"
            else:
                account = conn.execute(
                    "SELECT status,health_status FROM social_accounts WHERE id=? AND user_id=?",
                    (account_id, int(user_id)),
                ).fetchone()
                if account is None:
                    reason = "crm_account_not_found"
                elif str(account["status"] or "").lower() == "disabled":
                    reason = "crm_account_disabled"
                elif str(account["status"] or "").lower() != "ready":
                    reason = "crm_account_needs_login"
                elif str(account["health_status"] or "").lower() in {
                    "abnormal", "banned", "needs_login", "cookie_expired", "pending_login",
                }:
                    reason = "crm_account_needs_login"
        if not reason and action_type == "instagram_group_create":
            payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
            try:
                validated_targets = validate_instagram_group_create_targets(
                    conn,
                    user_id=int(user_id),
                    payload=payload,
                )
                policy["instagram_group_targets"] = {
                    "allowed": True,
                    "pool_id": validated_targets["pool_id"],
                    "member_count": len(validated_targets["members"]),
                }
            except CRMError as exc:
                reason = exc.code
                policy["instagram_group_targets"] = {
                    "allowed": False,
                    **dict(exc.details or {}),
                }
        if not reason and bool(action.get("write")):
            content_hash = hashlib.sha256(str(action.get("content") or "").encode("utf-8")).hexdigest()
            batch_key = (action_type, str(action["target_key"]), content_hash)
            if batch_key in planned_write_keys:
                reason = "crm_duplicate_action"
                duplicate_count += 1
            duplicate = find_active_duplicate_action(
                conn,
                user_id=int(user_id),
                account_id=account_id,
                action_type=action_type,
                target_key=str(action["target_key"]),
                content_hash=content_hash,
            )
            if not reason and duplicate is not None:
                reason = "crm_duplicate_action"
                duplicate_count += 1
        if not reason and action_type == "direct_message":
            trust_policy = evaluate_direct_message_trust(
                conn,
                user_id=int(user_id),
                account_id=account_id,
                action=action,
            )
            policy["trust"] = trust_policy
            if not trust_policy["allowed"]:
                reason = f"crm_direct_message_{trust_policy['code']}"
        if not reason and action_type == "public_comment":
            recent_comments: list[str] = []
            try:
                prior_rows = conn.execute(
                    """
                    SELECT step.payload_json
                    FROM crm_action_ledger action
                    JOIN crm_workflow_steps step ON step.id=action.step_id AND step.user_id=action.user_id
                    WHERE action.user_id=? AND action.account_id=? AND action.action_type='public_comment'
                      AND action.state IN ('submitted','confirmed')
                    ORDER BY action.updated_at DESC
                    LIMIT 100
                    """,
                    (int(user_id), account_id),
                ).fetchall()
                for prior in prior_rows:
                    prior_payload = loads(prior["payload_json"], {})
                    prior_content = str(prior_payload.get("content") or "").strip()
                    if prior_content:
                        recent_comments.append(prior_content)
            except sqlite3.OperationalError:
                # Migration/bootstrap tests may not have the complete ledger yet.
                recent_comments = []
            recent_comments.extend(planned_comments_by_account.get(account_id, ()))
            content_policy = assess_public_comment_content(
                comment=action.get("content"),
                recent_comments=recent_comments,
            )
            policy["content"] = content_policy
            if not content_policy["allowed"]:
                reason = f"crm_public_comment_{content_policy['code']}"
        if not reason and action_type == "public_comment" and account is not None:
            rate_events: list[dict[str, Any]] = []
            try:
                touch_rows = conn.execute(
                    """
                    SELECT state,created_at,updated_at
                    FROM crm_action_ledger
                    WHERE user_id=? AND account_id=? AND action_type='public_comment'
                      AND state IN ('submitted','confirmed') AND updated_at>=?
                    ORDER BY updated_at DESC
                    """,
                    (int(user_id), account_id, now - 86400),
                ).fetchall()
                # The account id is the stable local sender identity.  The rate
                # evaluator only requires that event and requested identities
                # match; no platform credential is exposed to this policy.
                sender_username = account_id
                rate_events = [
                    {
                        "event_type": (
                            "engagement_touch_published"
                            if str(row["state"] or "") == "confirmed"
                            else "engagement_touch_submitted"
                        ),
                        "sender_username": sender_username,
                        "occurred_at": int(row["updated_at"] or row["created_at"] or 0),
                    }
                    for row in touch_rows
                ]
            except sqlite3.OperationalError:
                pass
            try:
                moderation_rows = conn.execute(
                    """
                    SELECT event_type,occurred_at,payload_json
                    FROM crm_events
                    WHERE user_id=? AND event_type='platform_moderation_detected'
                      AND active=1 AND occurred_at>=?
                    ORDER BY occurred_at DESC
                    """,
                    (int(user_id), now - 86400),
                ).fetchall()
                for row in moderation_rows:
                    payload = loads(row["payload_json"], {})
                    if str(payload.get("account_id") or payload.get("sender_username") or "") != account_id:
                        continue
                    rate_events.append(
                        {
                            "event_type": str(row["event_type"] or ""),
                            "sender_username": account_id,
                            "occurred_at": int(row["occurred_at"] or 0),
                            "reason": str(payload.get("reason") or ""),
                        }
                    )
            except sqlite3.OperationalError:
                pass
            rate_policy = evaluate_public_comment_rate(
                events=rate_events,
                sender_username=account_id,
                current_time=now,
            )
            policy["rate"] = rate_policy
            if not rate_policy["allowed"]:
                reason = f"crm_public_comment_{rate_policy['reason']}"
            elif (
                int(rate_policy.get("daily_count") or 0)
                + int(planned_comment_count_by_account.get(account_id, 0))
                >= PUBLIC_COMMENT_MAX_PER_DAY
            ):
                reason = "crm_public_comment_daily_public_comment_limit"
                policy["rate"] = {
                    **rate_policy,
                    "allowed": False,
                    "reason": "daily_public_comment_limit",
                }
        if reason:
            blocked_count += 1
        else:
            allowed.append(action)
            if bool(action.get("write")):
                planned_write_keys.add((
                    action_type,
                    str(action["target_key"]),
                    hashlib.sha256(str(action.get("content") or "").encode("utf-8")).hexdigest(),
                ))
            if action_type == "public_comment":
                planned_comments_by_account.setdefault(account_id, []).append(str(action.get("content") or ""))
                planned_comment_count_by_account[account_id] = planned_comment_count_by_account.get(account_id, 0) + 1
        decisions.append({
            "index": index,
            "action_type": action_type,
            "target_key": str(action["target_key"]),
            "allowed": not bool(reason),
            "reason_code": reason,
            "duplicate_action_id": str(duplicate["id"] or "") if duplicate is not None else "",
            "policy": policy,
        })
    if not allowed:
        raise CRMError(
            "crm_preflight_no_executable_actions", "crm.errors.preflightNoExecutableActions",
            status_code=409, details={"decisions": decisions},
        )
    if rate_lookup is None:
        from webapp.commercial_billing import action_rate_units

        rate_lookup = action_rate_units
    from webapp.commercial_billing import points_from_units
    sku_totals: list[dict[str, Any]] = []
    total_units = 0
    for sku in sorted({str(item.get("sku") or "") for item in allowed if str(item.get("sku") or "")}):
        units, catalog_id = rate_lookup(conn, sku)
        total_units += int(units)
        sku_totals.append({"sku": sku, "quantity": 1, "points": points_from_units(int(units)), "catalog_id": catalog_id})
    expires_at = now + max(60, min(int(ttl_seconds or 300), 900))
    token_payload = {
        "version": 1,
        "user_id": int(user_id),
        "actions_hash": actions_hash(allowed),
        "allowed_count": len(allowed),
        "expires_at": expires_at,
    }
    return {
        "total_count": len(canonical),
        "allowed_count": len(allowed),
        "duplicate_count": duplicate_count,
        "blocked_count": blocked_count,
        "actions": allowed,
        "decisions": decisions,
        "quote": {"items": sku_totals, "total_points": points_from_units(total_units)},
        "actions_hash": token_payload["actions_hash"],
        "expires_at": expires_at,
        "preflight_token": sign_preflight_token(token_payload, secret=secret),
    }
