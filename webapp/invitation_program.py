from __future__ import annotations

import json
import re
import secrets
import sqlite3
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import commercial_billing


_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_REWARD_TYPES = {"points", "permission", "points_and_permission"}


def _now() -> int:
    return int(time.time())


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _normalize_code(raw_code: Any) -> str:
    value = str(raw_code or "").strip()
    if "://" in value:
        try:
            query = parse_qs(urlparse(value).query)
            value = str((query.get("invite_code") or query.get("inviteCode") or [""])[0])
        except Exception:
            return ""
    value = re.sub(r"[\s-]+", "", value).upper()
    if value.startswith("VCTOI"):
        value = value[5:]
    if len(value) != 8 or any(char not in _CODE_ALPHABET for char in value):
        return ""
    return f"VCTO-I-{value}"


def normalize_code(raw_code: Any) -> str:
    """Return the canonical public invitation code, or an empty string."""
    return _normalize_code(raw_code)


def _new_code() -> str:
    return "VCTO-I-" + "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))


def _active_customer(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT id, username, is_admin, is_disabled, deleted_at, approval_status "
        "FROM users WHERE id = ?",
        (int(user_id),),
    ).fetchone()
    if row is None:
        raise commercial_billing.BillingError("USER_NOT_FOUND", "账号不存在", 404)
    if bool(int(row["is_admin"] or 0)):
        raise commercial_billing.BillingError("INVITATION_ADMIN_NOT_SUPPORTED", "管理员账号不参与邀请活动", 409)
    if int(row["is_disabled"] or 0) or int(row["deleted_at"] or 0) or str(row["approval_status"] or "approved") != "approved":
        raise commercial_billing.BillingError("INVITATION_USER_INACTIVE", "账号当前不可参与邀请活动", 409)
    return row


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM billing_invitation_settings WHERE id = 1").fetchone()
    if row is None:
        raise commercial_billing.BillingError("INVITATION_SETTINGS_MISSING", "邀请活动配置不存在", 500)
    item = dict(row)
    return {
        "version": int(item.get("version") or 1),
        "enabled": bool(int(item.get("enabled") or 0)),
        "inviter_reward_type": str(item.get("inviter_reward_type") or "points"),
        "invitee_reward_type": str(item.get("invitee_reward_type") or "points"),
        "inviter_credit_units": int(item.get("inviter_credit_units") or 0),
        "invitee_credit_units": int(item.get("invitee_credit_units") or 0),
        "inviter_points": commercial_billing.points_from_units(int(item.get("inviter_credit_units") or 0)),
        "invitee_points": commercial_billing.points_from_units(int(item.get("invitee_credit_units") or 0)),
        "inviter_entitlement_key": str(item.get("inviter_entitlement_key") or ""),
        "invitee_entitlement_key": str(item.get("invitee_entitlement_key") or ""),
        "inviter_daily_limit": int(item.get("inviter_daily_limit") or 0),
        "source_daily_limit": int(item.get("source_daily_limit") or 0),
        "note": str(item.get("note") or ""),
        "updated_by": int(item.get("updated_by") or 0),
        "updated_at": int(item.get("updated_at") or 0),
        "permission_framework_ready": True,
        "permission_grants_implemented": False,
    }


def update_settings(
    conn: sqlite3.Connection,
    *,
    actor_user_id: int,
    enabled: bool,
    inviter_points: Any,
    invitee_points: Any,
    inviter_reward_type: str = "points",
    invitee_reward_type: str = "points",
    inviter_entitlement_key: str = "",
    invitee_entitlement_key: str = "",
    inviter_daily_limit: Any = 100,
    source_daily_limit: Any = 20,
    expected_version: Any,
    note: str = "",
    now: int | None = None,
) -> dict[str, Any]:
    commercial_billing._ensure_immediate_transaction(conn)
    current = int(now or _now())
    inviter_type = str(inviter_reward_type or "points").strip().lower()
    invitee_type = str(invitee_reward_type or "points").strip().lower()
    if inviter_type not in _REWARD_TYPES or invitee_type not in _REWARD_TYPES:
        raise commercial_billing.BillingError("INVITATION_REWARD_TYPE_INVALID", "邀请奖励类型无效", 422)
    inviter_units = commercial_billing.units_from_points(inviter_points)
    invitee_units = commercial_billing.units_from_points(invitee_points)
    try:
        inviter_limit = int(inviter_daily_limit)
        source_limit = int(source_daily_limit)
    except (TypeError, ValueError) as exc:
        raise commercial_billing.BillingError("INVITATION_LIMIT_INVALID", "邀请奖励上限必须为整数", 422) from exc
    if not 0 <= inviter_limit <= 100_000 or not 0 <= source_limit <= 100_000:
        raise commercial_billing.BillingError("INVITATION_LIMIT_INVALID", "邀请奖励上限必须在 0 到 100000 之间", 422)
    if inviter_units > 100_000_000 or invitee_units > 100_000_000:
        raise commercial_billing.BillingError("INVITATION_REWARD_TOO_LARGE", "单次邀请奖励不能超过 1,000,000 点", 422)
    if inviter_type in {"points", "points_and_permission"} and inviter_units <= 0:
        raise commercial_billing.BillingError("INVITATION_INVITER_POINTS_REQUIRED", "邀请人积分奖励必须大于 0", 422)
    if invitee_type in {"points", "points_and_permission"} and invitee_units <= 0:
        raise commercial_billing.BillingError("INVITATION_INVITEE_POINTS_REQUIRED", "新用户积分奖励必须大于 0", 422)
    inviter_entitlement = str(inviter_entitlement_key or "").strip()[:120]
    invitee_entitlement = str(invitee_entitlement_key or "").strip()[:120]
    if inviter_type in {"permission", "points_and_permission"} and not inviter_entitlement:
        raise commercial_billing.BillingError("INVITATION_ENTITLEMENT_REQUIRED", "邀请人权限标识不能为空", 422)
    if invitee_type in {"permission", "points_and_permission"} and not invitee_entitlement:
        raise commercial_billing.BillingError("INVITATION_ENTITLEMENT_REQUIRED", "受邀人权限标识不能为空", 422)
    if inviter_type == "permission":
        inviter_units = 0
    if invitee_type == "permission":
        invitee_units = 0
    current_row = conn.execute("SELECT version FROM billing_invitation_settings WHERE id=1").fetchone()
    if current_row is None:
        raise commercial_billing.BillingError("INVITATION_SETTINGS_MISSING", "邀请活动配置不存在", 500)
    current_version = int(current_row["version"] or 1)
    try:
        expected = int(expected_version)
    except (TypeError, ValueError) as exc:
        raise commercial_billing.BillingError(
            "INVITATION_SETTINGS_VERSION_REQUIRED", "必须提供当前邀请规则版本", 422
        ) from exc
    if expected <= 0:
        raise commercial_billing.BillingError(
            "INVITATION_SETTINGS_VERSION_REQUIRED", "必须提供当前邀请规则版本", 422
        )
    updated = conn.execute(
        """
        UPDATE billing_invitation_settings
        SET version = version + 1, enabled = ?, inviter_reward_type = ?, invitee_reward_type = ?,
            inviter_credit_units = ?, invitee_credit_units = ?,
            inviter_entitlement_key = ?, invitee_entitlement_key = ?,
            inviter_daily_limit = ?, source_daily_limit = ?, note = ?,
            updated_by = ?, updated_at = ?
        WHERE id = 1 AND version = ?
        """,
        (
            1 if enabled else 0, inviter_type, invitee_type, inviter_units, invitee_units,
            inviter_entitlement, invitee_entitlement, inviter_limit, source_limit,
            str(note or "").strip()[:500], int(actor_user_id), current, expected,
        ),
    )
    if updated.rowcount != 1:
        raise commercial_billing.BillingError(
            "INVITATION_SETTINGS_VERSION_CONFLICT", "邀请规则已被其他管理员修改，请刷新后重试", 409
        )
    return get_settings(conn)


def ensure_user_code(conn: sqlite3.Connection, *, user_id: int, now: int | None = None) -> dict[str, Any]:
    commercial_billing._ensure_immediate_transaction(conn)
    current = int(now or _now())
    if not get_settings(conn)["enabled"]:
        raise commercial_billing.BillingError("INVITATION_DISABLED", "邀请活动当前未开放", 409)
    _active_customer(conn, user_id)
    row = conn.execute("SELECT * FROM billing_invitation_codes WHERE user_id = ?", (int(user_id),)).fetchone()
    if row is None:
        for _attempt in range(12):
            code = _new_code()
            try:
                conn.execute(
                    "INSERT INTO billing_invitation_codes(id,user_id,code,status,created_at,updated_at) "
                    "VALUES (?,?,?,'active',?,?)",
                    (_id("invite_code"), int(user_id), code, current, current),
                )
                break
            except sqlite3.IntegrityError:
                continue
        else:
            raise commercial_billing.BillingError("INVITATION_CODE_GENERATION_FAILED", "邀请码生成失败，请重试", 500)
        row = conn.execute("SELECT * FROM billing_invitation_codes WHERE user_id = ?", (int(user_id),)).fetchone()
    return {
        "id": str(row["id"]),
        "code": str(row["code"]),
        "status": str(row["status"]),
        "created_at": int(row["created_at"] or 0),
    }


def _add_reward_grant(
    conn: sqlite3.Connection,
    *,
    claim_id: str,
    user_id: int,
    party: str,
    reward_type: str,
    reward_key: str,
    amount_units: int,
    status: str,
    ledger_key: str = "",
    now: int,
) -> None:
    conn.execute(
        """
        INSERT INTO billing_invitation_reward_grants(
          id, claim_id, beneficiary_user_id, party, reward_type, reward_key,
          amount_units, status, ledger_idempotency_key, meta_json, created_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
        """,
        (
            _id("invite_reward"), str(claim_id), int(user_id), str(party), str(reward_type),
            str(reward_key), int(amount_units), str(status), str(ledger_key), int(now),
            int(now) if status == "applied" else 0,
        ),
    )


def apply_registration_invitation(
    conn: sqlite3.Connection,
    *,
    invitee_user_id: int,
    raw_code: Any,
    source_channel: str = "registration",
    risk: dict[str, Any] | None = None,
    source_hash: str = "",
    now: int | None = None,
) -> dict[str, Any]:
    commercial_billing._ensure_immediate_transaction(conn)
    current = int(now or _now())
    code = _normalize_code(raw_code)
    if not code:
        raise commercial_billing.BillingError("INVITATION_CODE_INVALID", "邀请码格式不正确", 422)
    settings = get_settings(conn)
    if not settings["enabled"]:
        raise commercial_billing.BillingError("INVITATION_DISABLED", "邀请活动当前未开放", 409)
    invitee = _active_customer(conn, invitee_user_id)
    code_row = conn.execute(
        """
        SELECT code.*, user.username AS inviter_username, user.is_admin, user.is_disabled,
               user.deleted_at, user.approval_status
        FROM billing_invitation_codes AS code
        JOIN users AS user ON user.id = code.user_id
        WHERE code.code = ? COLLATE NOCASE
        """,
        (code,),
    ).fetchone()
    if code_row is None or str(code_row["status"] or "") != "active":
        raise commercial_billing.BillingError("INVITATION_CODE_NOT_FOUND", "邀请码不存在或已失效", 404)
    inviter_id = int(code_row["user_id"])
    _active_customer(conn, inviter_id)
    if inviter_id == int(invitee["id"]):
        raise commercial_billing.BillingError("INVITATION_SELF_NOT_ALLOWED", "不能使用自己的邀请码", 409)
    if conn.execute(
        "SELECT 1 FROM billing_invitation_claims WHERE invitee_user_id = ?",
        (int(invitee_user_id),),
    ).fetchone() is not None:
        raise commercial_billing.BillingError("INVITATION_ALREADY_CLAIMED", "该账号已经绑定过邀请关系", 409)
    clean_source_hash = re.sub(r"[^a-fA-F0-9]", "", str(source_hash or ""))[:64].lower()
    rolling_start = current - 86_400
    inviter_limit = int(settings.get("inviter_daily_limit") or 0)
    if inviter_limit > 0:
        inviter_recent = int(conn.execute(
            "SELECT COUNT(*) FROM billing_invitation_claims WHERE inviter_user_id=? AND created_at>?",
            (inviter_id, rolling_start),
        ).fetchone()[0] or 0)
        if inviter_recent >= inviter_limit:
            raise commercial_billing.BillingError(
                "INVITATION_INVITER_DAILY_LIMIT", "该邀请人的24小时奖励名额已用完", 429
            )
    source_limit = int(settings.get("source_daily_limit") or 0)
    if clean_source_hash and source_limit > 0:
        source_recent = int(conn.execute(
            "SELECT COUNT(*) FROM billing_invitation_claims WHERE source_hash=? AND created_at>?",
            (clean_source_hash, rolling_start),
        ).fetchone()[0] or 0)
        if source_recent >= source_limit:
            raise commercial_billing.BillingError(
                "INVITATION_SOURCE_DAILY_LIMIT", "同一来源的24小时邀请奖励名额已用完", 429
            )

    claim_id = _id("invite_claim")
    has_pending_permission = any(
        settings[key] in {"permission", "points_and_permission"}
        for key in ("inviter_reward_type", "invitee_reward_type")
    )
    snapshot = {
        key: settings[key]
        for key in (
            "version", "inviter_reward_type", "invitee_reward_type", "inviter_credit_units",
            "invitee_credit_units", "inviter_entitlement_key", "invitee_entitlement_key",
            "inviter_daily_limit", "source_daily_limit", "note",
        )
    }
    conn.execute(
        """
        INSERT INTO billing_invitation_claims(
          id, code_id, invitation_code, inviter_user_id, invitee_user_id, status,
          policy_version, policy_snapshot_json, source_channel, source_hash, risk_json,
          inviter_credit_units, invitee_credit_units, inviter_entitlement_key,
          invitee_entitlement_key, created_at, rewarded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            claim_id, str(code_row["id"]), code, inviter_id, int(invitee_user_id),
            "pending_permission" if has_pending_permission else "rewarded",
            int(settings["version"]), _json(snapshot), str(source_channel or "registration")[:40],
            clean_source_hash, _json({"source_hash_present": bool(clean_source_hash), **{
                key: value for key, value in (risk or {}).items() if key in {"client_ip_present"}
            }}), int(settings["inviter_credit_units"]), int(settings["invitee_credit_units"]),
            str(settings["inviter_entitlement_key"]), str(settings["invitee_entitlement_key"]),
            current, 0 if has_pending_permission else current,
        ),
    )

    for party, beneficiary_id in (("inviter", inviter_id), ("invitee", int(invitee_user_id))):
        reward_type = str(settings[f"{party}_reward_type"])
        units = int(settings[f"{party}_credit_units"])
        entitlement = str(settings[f"{party}_entitlement_key"])
        if reward_type in {"points", "points_and_permission"}:
            ledger_key = f"invitation:{claim_id}:{party}:points"
            commercial_billing.grant_promotional_credit(
                conn,
                user_id=beneficiary_id,
                credit_units=units,
                event_type=f"invitation_{party}_reward",
                idempotency_key=ledger_key,
                ref_type="invitation_claim",
                ref_id=claim_id,
                meta={"party": party, "policy_version": int(settings["version"])},
                now=current,
            )
            _add_reward_grant(
                conn, claim_id=claim_id, user_id=beneficiary_id, party=party,
                reward_type="points", reward_key="credit", amount_units=units,
                status="applied", ledger_key=ledger_key, now=current,
            )
        if reward_type in {"permission", "points_and_permission"}:
            _add_reward_grant(
                conn, claim_id=claim_id, user_id=beneficiary_id, party=party,
                reward_type="permission", reward_key=entitlement or "unconfigured",
                amount_units=0, status="pending", now=current,
            )
    return {
        "claim_id": claim_id,
        "code": code,
        "inviter_user_id": inviter_id,
        "inviter_username": str(code_row["inviter_username"] or ""),
        "invitee_user_id": int(invitee_user_id),
        "inviter_points": commercial_billing.points_from_units(int(settings["inviter_credit_units"])),
        "invitee_points": commercial_billing.points_from_units(int(settings["invitee_credit_units"])),
        "permission_status": "pending" if has_pending_permission else "not_requested",
        "status": "pending_permission" if has_pending_permission else "rewarded",
        "created_at": current,
    }


def _claim_public(row: sqlite3.Row | dict[str, Any], *, viewer_user_id: int = 0, admin: bool = False) -> dict[str, Any]:
    item = dict(row)
    inviter_name = str(item.get("inviter_username") or "")
    invitee_name = str(item.get("invitee_username") or "")
    if not admin:
        invitee_name = (invitee_name[:1] + "***") if invitee_name else "已注册用户"
    internal_status = str(item.get("status") or "")
    inviter_entitlement = str(item.get("inviter_entitlement_key") or "")
    invitee_entitlement = str(item.get("invitee_entitlement_key") or "")
    inviter_units = int(item.get("inviter_applied_units") or 0)
    invitee_units = int(item.get("invitee_applied_units") or 0)
    return {
        "id": str(item.get("id") or ""),
        "code": str(item.get("invitation_code") or ""),
        "inviter_user_id": int(item.get("inviter_user_id") or 0) if admin else 0,
        "inviter_id": int(item.get("inviter_user_id") or 0) if admin else 0,
        "inviter_username": inviter_name,
        "invitee_user_id": int(item.get("invitee_user_id") or 0) if admin else 0,
        "invitee_id": int(item.get("invitee_user_id") or 0) if admin else 0,
        "invitee_username": invitee_name,
        "record_kind": "claim",
        "status": internal_status,
        "internal_status": internal_status,
        "viewer_role": (
            "inviter" if viewer_user_id and int(item.get("inviter_user_id") or 0) == int(viewer_user_id)
            else "invitee" if viewer_user_id and int(item.get("invitee_user_id") or 0) == int(viewer_user_id)
            else "admin" if admin else ""
        ),
        "inviter_points": commercial_billing.points_from_units(inviter_units),
        "invitee_points": commercial_billing.points_from_units(invitee_units),
        "inviter_entitlement_key": inviter_entitlement,
        "invitee_entitlement_key": invitee_entitlement,
        "permission_reward_label": "待接入：" + " / ".join(filter(None, (inviter_entitlement, invitee_entitlement))) if inviter_entitlement or invitee_entitlement else "未配置",
        "source_channel": str(item.get("source_channel") or ""),
        "created_at": int(item.get("created_at") or 0),
        "rewarded_at": int(item.get("rewarded_at") or 0),
        "completed_at": int(item.get("rewarded_at") or 0) if internal_status == "rewarded" else 0,
    }


def _claim_query(
    conn: sqlite3.Connection,
    *,
    where: str,
    params: tuple[Any, ...],
) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT claim.*, inviter.username AS inviter_username, invitee.username AS invitee_username,
               COALESCE(SUM(CASE WHEN grant_row.party='inviter' AND grant_row.reward_type='points'
                                      AND grant_row.status='applied' AND ledger.id IS NOT NULL
                                 THEN ledger.amount_units ELSE 0 END),0)
                 AS inviter_applied_units,
               COALESCE(SUM(CASE WHEN grant_row.party='invitee' AND grant_row.reward_type='points'
                                      AND grant_row.status='applied' AND ledger.id IS NOT NULL
                                 THEN ledger.amount_units ELSE 0 END),0)
                 AS invitee_applied_units
        FROM billing_invitation_claims AS claim
        LEFT JOIN users AS inviter ON inviter.id = claim.inviter_user_id
        LEFT JOIN users AS invitee ON invitee.id = claim.invitee_user_id
        LEFT JOIN billing_invitation_reward_grants AS grant_row ON grant_row.claim_id = claim.id
        LEFT JOIN billing_ledger AS ledger ON ledger.idempotency_key = grant_row.ledger_idempotency_key
        WHERE {where}
        GROUP BY claim.id
        """,
        params,
    ).fetchall()


def list_user_records(conn: sqlite3.Connection, *, user_id: int, limit: int = 50, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
    total = int(conn.execute(
        "SELECT COUNT(*) FROM billing_invitation_claims WHERE inviter_user_id = ? OR invitee_user_id = ?",
        (int(user_id), int(user_id)),
    ).fetchone()[0] or 0)
    rows = _claim_query(
        conn,
        where="claim.inviter_user_id = ? OR claim.invitee_user_id = ?",
        params=(int(user_id), int(user_id)),
    )
    rows = sorted(rows, key=lambda row: (int(row["created_at"] or 0), str(row["id"])), reverse=True)
    clean_offset = max(int(offset), 0)
    rows = rows[clean_offset:clean_offset + min(max(int(limit), 1), 100)]
    return ([_claim_public(row, viewer_user_id=user_id) for row in rows], total)


def get_user_summary(conn: sqlite3.Connection, *, user_id: int, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    _active_customer(conn, user_id)
    settings = get_settings(conn)
    code = conn.execute("SELECT * FROM billing_invitation_codes WHERE user_id = ?", (int(user_id),)).fetchone()
    clean_limit = min(max(int(limit), 1), 100)
    clean_offset = max(int(offset), 0)
    records, total = list_user_records(conn, user_id=user_id, limit=clean_limit, offset=clean_offset)
    return {
        "enabled": settings["enabled"],
        "code": str(code["code"]) if code else "",
        "code_info": ({"id": str(code["id"]), "code": str(code["code"]), "status": str(code["status"]), "created_at": int(code["created_at"] or 0)} if code else None),
        "settings": {
            "inviter_points": settings["inviter_points"],
            "invitee_points": settings["invitee_points"],
            "inviter_reward_type": settings["inviter_reward_type"],
            "invitee_reward_type": settings["invitee_reward_type"],
            "permission_grants_implemented": False,
            "inviter_daily_limit": settings["inviter_daily_limit"],
            "source_daily_limit": settings["source_daily_limit"],
        },
        "records": records,
        "total": total,
        "limit": clean_limit,
        "offset": clean_offset,
        "next_offset": clean_offset + len(records) if clean_offset + len(records) < total else 0,
    }


def list_admin_records(
    conn: sqlite3.Connection,
    *,
    status: str = "",
    query: str = "",
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    clean_status = str(status or "").strip().lower()
    if clean_status not in {"", "completed", "pending", "revoked", "rewarded", "pending_permission"}:
        raise commercial_billing.BillingError("INVITATION_STATUS_INVALID", "邀请记录状态无效", 422)
    if clean_status == "completed":
        clean_status = "rewarded"
    clean_query = str(query or "").strip()
    needle = f"%{clean_query}%"
    items: list[dict[str, Any]] = []
    if clean_status not in {"pending", "revoked"}:
        claim_clauses = ["1=1"]
        claim_params: list[Any] = []
        if clean_status in {"rewarded", "pending_permission"}:
            claim_clauses.append("claim.status=?")
            claim_params.append(clean_status)
        if clean_query:
            claim_clauses.append("(claim.invitation_code LIKE ? OR inviter.username LIKE ? OR invitee.username LIKE ?)")
            claim_params.extend((needle, needle, needle))
        items.extend(
            _claim_public(row, admin=True)
            for row in _claim_query(conn, where=" AND ".join(claim_clauses), params=tuple(claim_params))
        )
    if clean_status in {"", "pending", "revoked"}:
        code_clauses = ["code.status=?"] if clean_status in {"pending", "revoked"} else ["1=1"]
        code_params: list[Any] = ["active" if clean_status == "pending" else "disabled"] if clean_status else []
        if clean_query:
            code_clauses.append("(code.code LIKE ? OR owner.username LIKE ?)")
            code_params.extend((needle, needle))
        code_rows = conn.execute(
            f"SELECT code.*, owner.username AS inviter_username FROM billing_invitation_codes AS code "
            f"LEFT JOIN users AS owner ON owner.id=code.user_id WHERE {' AND '.join(code_clauses)}",
            tuple(code_params),
        ).fetchall()
        for row in code_rows:
            item = dict(row)
            item_status = "pending" if str(item.get("status") or "") == "active" else "revoked"
            items.append({
                "id": str(item.get("id") or ""), "code": str(item.get("code") or ""),
                "record_kind": "code", "status": item_status, "internal_status": item_status,
                "inviter_user_id": int(item.get("user_id") or 0), "inviter_id": int(item.get("user_id") or 0),
                "inviter_username": str(item.get("inviter_username") or ""),
                "invitee_user_id": 0, "invitee_id": 0, "invitee_username": "",
                "inviter_points": 0, "invitee_points": 0,
                "inviter_entitlement_key": "", "invitee_entitlement_key": "",
                "permission_reward_label": "未配置", "source_channel": "",
                "created_at": int(item.get("created_at") or 0), "rewarded_at": 0, "completed_at": 0,
            })
    items.sort(key=lambda item: (int(item.get("created_at") or 0), str(item.get("id") or "")), reverse=True)
    total = len(items)
    clean_offset = max(int(offset), 0)
    clean_limit = min(max(int(limit), 1), 500)
    return (items[clean_offset:clean_offset + clean_limit], total)


def get_admin_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT SUM(CASE WHEN status='rewarded' THEN 1 ELSE 0 END) AS completed,
               SUM(CASE WHEN status = 'pending_permission' THEN 1 ELSE 0 END) AS pending_permission
        FROM billing_invitation_claims
        """
    ).fetchone()
    return {
        "completed": int(row["completed"] or 0),
        "pending": int(conn.execute("SELECT COUNT(*) FROM billing_invitation_codes WHERE status='active'").fetchone()[0] or 0),
        "revoked": int(conn.execute("SELECT COUNT(*) FROM billing_invitation_codes WHERE status='disabled'").fetchone()[0] or 0),
        "pending_permission": int(row["pending_permission"] or 0),
        "reward_points": commercial_billing.points_from_units(int(conn.execute(
            "SELECT COALESCE(SUM(ledger.amount_units),0) FROM billing_invitation_reward_grants AS grant_row "
            "JOIN billing_ledger AS ledger ON ledger.idempotency_key=grant_row.ledger_idempotency_key "
            "WHERE grant_row.reward_type='points' AND grant_row.status='applied'"
        ).fetchone()[0] or 0)),
    }
