from __future__ import annotations

import sqlite3
from collections.abc import Mapping
from typing import Any

from .errors import CRMError


ERROR_CODE = "crm_instagram_group_targets_invalid"


def _invalid(reason: str, **details: Any) -> CRMError:
    return CRMError(
        ERROR_CODE,
        "crm.errors.instagramGroupTargetsInvalid",
        status_code=400,
        details={"reason": str(reason), **details},
    )


def _username(value: Any) -> str:
    return str(value or "").strip().lstrip("@").lower()


def validate_instagram_group_create_targets(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate the tenant-owned pool identities behind an Instagram group create.

    Client usernames are never sufficient identity proof.  Every requested
    member must stay aligned with one active Instagram lead in the effective
    tenant and one active membership in the selected active pool.
    """

    pool_id = str(payload.get("pool_id") or payload.get("poolId") or "").strip()
    raw_members = payload.get("members")
    raw_lead_ids = payload.get("lead_ids") or payload.get("leadIds")
    if not isinstance(raw_members, list) or not isinstance(raw_lead_ids, list):
        raise _invalid("parallel_lists")

    members = [_username(item) for item in raw_members]
    lead_ids = [str(item or "").strip() for item in raw_lead_ids]
    if len(members) < 2 or len(members) > 10:
        raise _invalid("member_count", minimum=2, maximum=10)
    if len(members) != len(lead_ids) or any(not item for item in members) or any(not item for item in lead_ids):
        raise _invalid("parallel_lists")
    if len(set(members)) != len(members):
        raise _invalid("duplicate_members")
    if len(set(lead_ids)) != len(lead_ids):
        raise _invalid("duplicate_lead_ids")
    if not pool_id:
        raise _invalid("pool_unavailable")

    pool = conn.execute(
        "SELECT id FROM crm_pools WHERE id=? AND user_id=? AND active=1",
        (pool_id, int(user_id)),
    ).fetchone()
    if pool is None:
        raise _invalid("pool_unavailable")

    placeholders = ",".join("?" for _ in lead_ids)
    rows = conn.execute(
        f"""
        SELECT l.id,l.platform,l.username
        FROM crm_leads AS l
        JOIN crm_pool_members AS pm
          ON pm.user_id=l.user_id AND pm.lead_id=l.id
        WHERE l.user_id=? AND l.active=1
          AND pm.user_id=? AND pm.pool_id=? AND pm.active=1
          AND l.id IN ({placeholders})
        """,
        (int(user_id), int(user_id), pool_id, *lead_ids),
    ).fetchall()
    by_id = {str(row["id"]): row for row in rows}
    if len(by_id) != len(lead_ids):
        raise _invalid("inactive_or_foreign_membership")

    for index, (lead_id, member) in enumerate(zip(lead_ids, members, strict=True)):
        row = by_id[lead_id]
        if str(row["platform"] or "").strip().lower() != "instagram":
            raise _invalid("platform_mismatch", index=index, lead_id=lead_id)
        if _username(row["username"]) != member:
            raise _invalid("username_mismatch", index=index, lead_id=lead_id)

    return {"pool_id": pool_id, "lead_ids": lead_ids, "members": members}


__all__ = ["ERROR_CODE", "validate_instagram_group_create_targets"]
