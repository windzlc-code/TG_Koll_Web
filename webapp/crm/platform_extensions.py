from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Mapping
from typing import Any
from urllib.parse import urlparse

from .errors import CRMError
from .repository import canonicalize_action


# These contracts intentionally describe worker capabilities, rather than UI
# labels.  A contract is executable only when the native Python social worker
# advertises every required task type.  This prevents a read-only profile visit
# from being reported as a verified relationship, or a normal post from being
# reported as an Instagram group operation.
PLATFORM_OPERATION_CONTRACTS: dict[str, dict[str, Any]] = {
    "relationship_verify": {
        "platform": "instagram",
        "write": False,
        "required_task_types": ("instagram_relationship_verify",),
        "legacy_routes": (
            "/api/relationships/verify",
            "/sender/verify-relationships",
        ),
        "reason_code": "crm_relationship_verify_python_handler_unavailable",
    },
    "instagram_group_candidates_inspect": {
        "platform": "instagram",
        "write": False,
        "required_task_types": ("instagram_group_candidates_inspect",),
        "legacy_routes": ("/social/inspect-instagram-group-candidates",),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "instagram_group_create": {
        "platform": "instagram",
        "write": True,
        "required_task_types": (
            "instagram_group_candidates_inspect",
            "instagram_group_create",
        ),
        "legacy_routes": (
            "/api/groups",
            "/social/inspect-instagram-group-candidates",
            "/social/create-instagram-group",
        ),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "instagram_group_members_add": {
        "platform": "instagram",
        "write": True,
        "required_task_types": ("instagram_group_members_add",),
        "legacy_routes": ("/social/add-instagram-group-members",),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "instagram_group_members_inspect": {
        "platform": "instagram",
        "write": False,
        "required_task_types": ("instagram_group_members_inspect",),
        "legacy_routes": ("/social/inspect-instagram-group-members",),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "instagram_group_post": {
        "platform": "instagram",
        "write": True,
        "required_task_types": ("instagram_group_post",),
        "legacy_routes": ("/social/group-post",),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "instagram_group_settings_update": {
        "platform": "instagram",
        "write": True,
        "required_task_types": ("instagram_group_settings_update",),
        "legacy_routes": ("/social/update-instagram-group-settings",),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "instagram_group_status_inspect": {
        "platform": "instagram",
        "write": False,
        "required_task_types": ("instagram_group_status_inspect",),
        "legacy_routes": ("/social/group-status",),
        "reason_code": "crm_instagram_group_python_handler_unavailable",
    },
    "threads_community_post": {
        "platform": "threads",
        "write": True,
        "required_task_types": ("publish_post",),
        "legacy_routes": ("/api/groups", "/social/group-post"),
        "reason_code": "crm_threads_community_post_unavailable",
    },
}


def _clean_username(value: Any) -> str:
    username = str(value or "").strip().lstrip("@").lower()
    if not username or len(username) > 80:
        return ""
    if any(character not in "abcdefghijklmnopqrstuvwxyz0123456789._" for character in username):
        return ""
    return username


def _unique_usernames(values: Iterable[Any], *, limit: int) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        username = _clean_username(value)
        if not username or username in seen:
            continue
        seen.add(username)
        result.append(username)
        if len(result) >= limit:
            break
    return result


def operation_support(
    operation: str,
    *,
    supported_task_types: Iterable[str],
) -> dict[str, Any]:
    name = str(operation or "").strip()
    contract = PLATFORM_OPERATION_CONTRACTS.get(name)
    if contract is None:
        raise CRMError(
            "crm_platform_operation_unknown",
            "crm.errors.platformOperationUnknown",
            status_code=404,
            details={"operation": name or "unknown"},
        )
    available = {str(item or "").strip() for item in supported_task_types}
    required = tuple(str(item) for item in contract["required_task_types"])
    missing = [item for item in required if item not in available]
    return {
        "operation": name,
        "platform": str(contract["platform"]),
        "write": bool(contract["write"]),
        "enabled": not missing,
        "required_task_types": list(required),
        "missing_task_types": missing,
        "legacy_routes": list(contract["legacy_routes"]),
        "reason_code": "" if not missing else str(contract["reason_code"]),
    }


def runtime_support_report(*, supported_task_types: Iterable[str]) -> dict[str, Any]:
    operations = {
        name: operation_support(name, supported_task_types=supported_task_types)
        for name in PLATFORM_OPERATION_CONTRACTS
    }
    return {
        "operations": operations,
        "enabled_count": sum(1 for item in operations.values() if item["enabled"]),
        "blocked_count": sum(1 for item in operations.values() if not item["enabled"]),
    }


def require_operation_supported(
    operation: str,
    *,
    supported_task_types: Iterable[str],
) -> dict[str, Any]:
    support = operation_support(operation, supported_task_types=supported_task_types)
    if support["enabled"]:
        return support
    raise CRMError(
        str(support["reason_code"]),
        "crm.errors.actionBlocked",
        status_code=409,
        details={
            "operation": support["operation"],
            "platform": support["platform"],
            "required_task_types": support["required_task_types"],
            "missing_task_types": support["missing_task_types"],
            "legacy_routes": support["legacy_routes"],
        },
    )


def _tenant_account(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    platform: str,
) -> sqlite3.Row:
    row = conn.execute(
        "SELECT id,user_id,platform,username,status,health_status "
        "FROM social_accounts WHERE id=? AND user_id=?",
        (str(account_id or "").strip(), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_account_not_found", "crm.errors.accountNotFound", status_code=404)
    if str(row["platform"] or "").strip().lower() != str(platform):
        raise CRMError(
            "crm_account_platform_mismatch",
            "crm.errors.accountPlatformMismatch",
            status_code=400,
            details={"required_platform": platform},
        )
    status = str(row["status"] or "").strip().lower()
    health = str(row["health_status"] or "").strip().lower()
    if status != "ready" or health in {"banned", "abnormal", "needs_login", "cookie_expired", "pending_login"}:
        raise CRMError(
            "crm_account_needs_login",
            "crm.errors.accountNeedsLogin",
            status_code=409,
            details={"account_id": str(row["id"]), "status": status, "health_status": health},
        )
    return row


def prepare_relationship_verification(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    lead_ids: Iterable[str],
    supported_task_types: Iterable[str],
) -> dict[str, Any]:
    account = _tenant_account(
        conn, user_id=int(user_id), account_id=account_id, platform="instagram"
    )
    selected = list(dict.fromkeys(str(item or "").strip() for item in lead_ids if str(item or "").strip()))
    if not selected or len(selected) > 20:
        raise CRMError(
            "crm_invalid_relationship_target_count",
            "crm.errors.invalidRelationshipTargetCount",
            status_code=400,
            details={"minimum": 1, "maximum": 20},
        )
    placeholders = ",".join("?" for _ in selected)
    rows = conn.execute(
        f"SELECT id,username FROM crm_leads WHERE user_id=? AND active=1 AND id IN ({placeholders})",
        (int(user_id), *selected),
    ).fetchall()
    by_id = {str(row["id"]): row for row in rows}
    if len(by_id) != len(selected):
        raise CRMError(
            "crm_invalid_tenant_reference",
            "crm.errors.invalidTenantReference",
            status_code=400,
            details={"field": "lead_ids"},
        )
    targets = _unique_usernames((by_id[lead_id]["username"] for lead_id in selected), limit=20)
    if len(targets) != len(selected):
        raise CRMError(
            "crm_invalid_relationship_target",
            "crm.errors.invalidRelationshipTarget",
            status_code=400,
        )
    support = require_operation_supported(
        "relationship_verify", supported_task_types=supported_task_types
    )
    return {
        "task_type": support["required_task_types"][0],
        "platform": "instagram",
        "account_id": str(account["id"]),
        "payload": {
            "expected_username": _clean_username(account["username"]),
            "target_usernames": targets,
            "lead_ids": selected,
            "read_only": True,
            "crm_relationship_verify": True,
        },
    }


def prepare_instagram_group_create(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    members: Iterable[str],
    message: str,
    confirmed: bool,
    supported_task_types: Iterable[str],
) -> dict[str, Any]:
    if confirmed is not True:
        raise CRMError(
            "crm_confirmation_required",
            "crm.errors.confirmationRequired",
            status_code=409,
        )
    account = _tenant_account(
        conn, user_id=int(user_id), account_id=account_id, platform="instagram"
    )
    usernames = _unique_usernames(members, limit=10)
    if len(usernames) < 2:
        raise CRMError(
            "crm_instagram_group_minimum_members",
            "crm.errors.instagramGroupMinimumMembers",
            status_code=400,
            details={"minimum": 2, "maximum": 10},
        )
    content = str(message or "").strip()
    if not content:
        raise CRMError("crm_required_field", "crm.errors.requiredField", status_code=400, details={"field": "message"})
    support = require_operation_supported(
        "instagram_group_create", supported_task_types=supported_task_types
    )
    return {
        "task_type": "instagram_group_create",
        "platform": "instagram",
        "account_id": str(account["id"]),
        "payload": {
            "expected_username": _clean_username(account["username"]),
            "members": usernames,
            "message": content[:5000],
            "confirmed": True,
            "requires_candidate_inspection": "instagram_group_candidates_inspect"
            in support["required_task_types"],
        },
    }


def prepare_threads_community_post(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    content: str,
    confirmed: bool,
    supported_task_types: Iterable[str],
) -> dict[str, Any]:
    if confirmed is not True:
        raise CRMError(
            "crm_confirmation_required",
            "crm.errors.confirmationRequired",
            status_code=409,
        )
    account = _tenant_account(
        conn, user_id=int(user_id), account_id=account_id, platform="threads"
    )
    message = str(content or "").strip()
    if not message:
        raise CRMError("crm_required_field", "crm.errors.requiredField", status_code=400, details={"field": "content"})
    require_operation_supported(
        "threads_community_post", supported_task_types=supported_task_types
    )
    return canonicalize_action(
        {
            "action_type": "threads_group_invite_post",
            "account_id": str(account["id"]),
            # This is an idempotency target, not an external URL. publish_post
            # publishes to the authenticated account's own Threads feed.
            "target_key": f"threads:account:{account['id']}:community-post",
            "content": message[:500],
            "payload": {"crm_operation": "threads_community_post"},
        }
    )


def relationship_rows_from_worker_evidence(
    result: Mapping[str, Any],
    *,
    account_id: str,
    lead_ids_by_username: Mapping[str, str],
    verified_at: int,
) -> list[dict[str, Any]]:
    """Translate proved worker evidence into repository rows.

    Missing, malformed, off-domain, or merely inferred results are omitted. The
    caller must keep those leads at ``unknown`` and must never treat omission as
    a negative relationship result.
    """

    if result.get("ok") is not True or not isinstance(result.get("results"), list):
        return []
    normalized_leads = {
        _clean_username(username): str(lead_id or "").strip()
        for username, lead_id in lead_ids_by_username.items()
        if _clean_username(username) and str(lead_id or "").strip()
    }
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in result["results"]:
        if not isinstance(raw, Mapping):
            continue
        username = _clean_username(raw.get("target_username") or raw.get("targetUsername"))
        lead_id = normalized_leads.get(username, "")
        if not lead_id or username in seen or raw.get("profile_found", raw.get("profileFound")) is not True:
            continue
        inspected_url = str(raw.get("inspected_url") or raw.get("inspectedUrl") or "").strip()
        parsed = urlparse(inspected_url)
        if parsed.scheme != "https" or parsed.hostname not in {"instagram.com", "www.instagram.com"}:
            continue
        sender_follows = raw.get("sender_follows", raw.get("senderFollows"))
        follows_sender = raw.get("follows_sender", raw.get("followsSender"))
        if not isinstance(sender_follows, bool) or not isinstance(follows_sender, bool):
            continue
        status = (
            "mutual" if sender_follows and follows_sender
            else "sender_follows" if sender_follows
            else "follows_sender" if follows_sender
            else "none"
        )
        seen.add(username)
        rows.append(
            {
                "lead_id": lead_id,
                "account_id": str(account_id or "").strip(),
                "relationship_type": "instagram_follow",
                "status": status,
                "verified_at": int(verified_at),
                "evidence": {
                    "target_username": username,
                    "sender_follows": sender_follows,
                    "follows_sender": follows_sender,
                    "profile_found": True,
                    "inspected_url": inspected_url,
                    "worker_evidence": True,
                },
            }
        )
    return rows
