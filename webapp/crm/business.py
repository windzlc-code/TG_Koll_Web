from __future__ import annotations

import math
import sqlite3
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlparse

from .errors import CRMError
from .repository import (
    RESOURCE_TABLES,
    decode_cursor,
    dumps,
    encode_cursor,
    now_ts,
    row_public,
)

JsonDict = dict[str, Any]


# Public request names deliberately differ from physical ``*_json`` columns.
# Keep this explicit: adding a Repository column must never make it writable by
# accident. Ownership, imports, lifecycle, media storage and scheduler runtime
# timestamps are intentionally absent.
PATCH_FIELDS: dict[str, dict[str, str]] = {
    "pools": {"name": "name", "description": "description", "tags": "tags_json", "snapshot": "snapshot_json"},
    "leads": {
        "platform_user_key": "platform_user_key",
        "username": "username",
        "display_name": "display_name",
        "stage": "stage",
        "score": "score",
        "tags": "tags_json",
        "profile": "profile_json",
    },
    "events": {
        "lead_id": "lead_id",
        "workflow_id": "workflow_id",
        "event_type": "event_type",
        "occurred_at": "occurred_at",
        "payload": "payload_json",
    },
    "hotspots": {
        "source_url": "source_url",
        "title": "title",
        "content": "content",
        "metrics": "metrics_json",
        "captured_at": "captured_at",
    },
    "relationships": {
        "lead_id": "lead_id",
        "account_id": "account_id",
        "relationship_type": "relationship_type",
        "status": "status",
        "verified_at": "verified_at",
        "evidence": "evidence_json",
    },
    "templates": {
        "name": "name",
        "template_type": "template_type",
        "locale": "locale",
        "content": "content",
        "media_ids": "media_ids_json",
        "is_default": "is_default",
    },
    "media": {"original_name": "original_name"},
    "schedules": {
        "workflow_type": "workflow_type",
        "cron_expression": "cron_expression",
        "timezone": "timezone",
        "enabled": "enabled",
        "next_run_at": "next_run_at",
        "payload": "payload_json",
    },
    "groups": {
        "name": "name",
        "platform_group_key": "platform_group_key",
        "members": "members_json",
        "status": "status",
    },
    "destinations": {"name": "name", "url": "url", "enabled": "enabled"},
}

FILTER_FIELDS: dict[str, dict[str, str]] = {
    "pools": {},
    "leads": {"platform": "platform", "stage": "stage"},
    "events": {"lead_id": "lead_id", "workflow_id": "workflow_id", "event_type": "event_type"},
    "hotspots": {"platform": "platform"},
    "relationships": {
        "lead_id": "lead_id",
        "account_id": "account_id",
        "relationship_type": "relationship_type",
        "status": "status",
    },
    "templates": {"template_type": "template_type", "locale": "locale", "is_default": "is_default"},
    "media": {"mime_type": "mime_type", "sha256": "sha256"},
    "schedules": {"workflow_type": "workflow_type", "enabled": "enabled"},
    "groups": {"platform": "platform", "status": "status"},
    "destinations": {"enabled": "enabled"},
    "pool_members": {"platform": "platform", "stage": "stage", "status": "status", "source": "source"},
}

SEARCH_FIELDS: dict[str, tuple[str, ...]] = {
    "pools": ("name", "description"),
    "leads": ("username", "display_name", "platform_user_key"),
    "events": ("event_type",),
    "hotspots": ("title", "content", "source_url"),
    "relationships": ("relationship_type", "status"),
    "templates": ("name", "content"),
    "media": ("original_name", "mime_type"),
    "schedules": ("workflow_type", "cron_expression"),
    "groups": ("name", "platform_group_key"),
    "destinations": ("name", "url"),
    "pool_members": ("l.username", "l.display_name", "l.platform_user_key"),
}

_BOOL_FILTERS = {"enabled", "is_default"}
_JSON_LIST_FIELDS = {"tags", "media_ids", "members"}
_JSON_OBJECT_FIELDS = {"snapshot", "profile", "payload", "metrics", "evidence"}
_INTEGER_FIELDS = {"occurred_at", "captured_at", "verified_at", "size_bytes", "next_run_at", "last_run_at"}
_BOOLEAN_FIELDS = {"enabled", "is_default"}
_LOWERCASE_FILTERS = {"platform", "stage", "status", "relationship_type", "template_type", "locale", "mime_type"}
_REQUIRED_FIELDS = {
    "pools": {"name"},
    "events": {"event_type"},
    "templates": {"name"},
    "media": {"storage_path"},
    "schedules": {"workflow_type"},
    "destinations": {"url"},
}


def _resource_table(resource: str) -> str:
    table = RESOURCE_TABLES.get(str(resource or "").strip())
    if not table:
        raise CRMError("crm_unknown_resource", "crm.errors.unknownResource", status_code=404)
    return table


def _strict_bool(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int) and value in (0, 1):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true"}:
            return 1
        if normalized in {"0", "false"}:
            return 0
    raise CRMError(
        "crm_invalid_field_value",
        "crm.errors.invalidFieldValue",
        status_code=400,
        details={"field": field},
    )


def _single_filter_value(value: Any, *, field: str) -> Any:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        values = list(value)
        if len(values) != 1:
            raise CRMError(
                "crm_invalid_filter", "crm.errors.invalidFilter", status_code=400,
                details={"field": field},
            )
        return values[0]
    return value


def normalize_list_filters(resource: str, filters: Mapping[str, Any] | None) -> JsonDict:
    """Normalize only server-owned list filters and reject every unknown key."""

    normalized_resource = str(resource or "").strip()
    if normalized_resource not in FILTER_FIELDS:
        if normalized_resource != "pool_members":
            _resource_table(normalized_resource)
        raise CRMError("crm_unknown_resource", "crm.errors.unknownResource", status_code=404)
    raw = dict(filters or {})
    allowed = {"q", "updated_after", "updated_before", *FILTER_FIELDS[normalized_resource]}
    unknown = sorted(str(key) for key in raw if str(key) not in allowed)
    if unknown:
        raise CRMError(
            "crm_invalid_filter", "crm.errors.invalidFilter", status_code=400,
            details={"fields": unknown},
        )
    result: JsonDict = {}
    for field, raw_value in raw.items():
        value = _single_filter_value(raw_value, field=str(field))
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if field == "q":
            query = str(value).strip()
            if len(query) > 200:
                raise CRMError(
                    "crm_invalid_filter", "crm.errors.invalidFilter", status_code=400,
                    details={"field": "q"},
                )
            result["q"] = query
        elif field in {"updated_after", "updated_before"}:
            try:
                timestamp = int(value)
            except (TypeError, ValueError) as exc:
                raise CRMError(
                    "crm_invalid_filter", "crm.errors.invalidFilter", status_code=400,
                    details={"field": field},
                ) from exc
            if timestamp < 0:
                raise CRMError(
                    "crm_invalid_filter", "crm.errors.invalidFilter", status_code=400,
                    details={"field": field},
                )
            result[field] = timestamp
        elif field in _BOOL_FILTERS:
            result[field] = _strict_bool(value, field=field)
        else:
            text = str(value).strip()
            result[field] = text.lower() if field in _LOWERCASE_FILTERS else text
    return result


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_resources_filtered(
    conn: sqlite3.Connection,
    resource: str,
    *,
    user_id: int,
    filters: Mapping[str, Any] | None = None,
    limit: int = 50,
    cursor: str = "",
) -> JsonDict:
    table = _resource_table(resource)
    page_size = min(max(int(limit or 50), 1), 200)
    normalized = normalize_list_filters(resource, filters)
    clauses = ["user_id = ?", "active = 1"]
    params: list[Any] = [int(user_id)]
    for public_name, column in FILTER_FIELDS[resource].items():
        if public_name in normalized:
            clauses.append(f"LOWER({column}) = ?" if public_name in _LOWERCASE_FILTERS else f"{column} = ?")
            params.append(normalized[public_name])
    if "updated_after" in normalized:
        clauses.append("updated_at >= ?")
        params.append(normalized["updated_after"])
    if "updated_before" in normalized:
        clauses.append("updated_at <= ?")
        params.append(normalized["updated_before"])
    if normalized.get("q"):
        searchable = SEARCH_FIELDS.get(resource, ())
        if searchable:
            clauses.append("(" + " OR ".join(f"{field} LIKE ? ESCAPE '\\'" for field in searchable) + ")")
            params.extend([f"%{_escape_like(str(normalized['q']))}%"] * len(searchable))
    if cursor:
        updated_at, record_id = decode_cursor(cursor)
        clauses.append("(updated_at < ? OR (updated_at = ? AND id < ?))")
        params.extend((updated_at, updated_at, record_id))
    params.append(page_size + 1)
    rows = conn.execute(
        f"SELECT * FROM {table} WHERE {' AND '.join(clauses)} "
        "ORDER BY updated_at DESC, id DESC LIMIT ?",
        tuple(params),
    ).fetchall()
    visible = rows[:page_size]
    has_more = len(rows) > page_size
    next_cursor = ""
    if has_more and visible:
        next_cursor = encode_cursor(int(visible[-1]["updated_at"] or 0), str(visible[-1]["id"]))
    return {
        "items": [row_public(row) for row in visible],
        "next_cursor": next_cursor,
        "has_more": has_more,
        "limit": page_size,
        "filters": normalized,
    }


def get_resource_detail(
    conn: sqlite3.Connection,
    resource: str,
    *,
    user_id: int,
    record_id: str,
    include_inactive: bool = False,
) -> JsonDict:
    table = _resource_table(resource)
    active_sql = "" if include_inactive else " AND active = 1"
    row = conn.execute(
        f"SELECT * FROM {table} WHERE id = ? AND user_id = ?{active_sql}",
        (str(record_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError(
            "crm_resource_not_found", "crm.errors.resourceNotFound", status_code=404,
            details={"resource": resource},
        )
    return row_public(row) or {}


def _validate_reference(
    conn: sqlite3.Connection,
    *,
    table: str,
    record_id: Any,
    user_id: int,
    field: str,
) -> None:
    reference = str(record_id or "").strip()
    if not reference:
        return
    row = conn.execute(
        f"SELECT 1 FROM {table} WHERE id = ? AND user_id = ? AND active = 1",
        (reference, int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError(
            "crm_invalid_tenant_reference", "crm.errors.invalidTenantReference", status_code=400,
            details={"field": field},
        )


def _validate_references(conn: sqlite3.Connection, resource: str, user_id: int, data: Mapping[str, Any]) -> None:
    if resource == "events":
        _validate_reference(conn, table="crm_leads", record_id=data.get("lead_id"), user_id=user_id, field="lead_id")
        _validate_reference(conn, table="crm_workflows", record_id=data.get("workflow_id"), user_id=user_id, field="workflow_id")
    elif resource == "relationships":
        _validate_reference(conn, table="crm_leads", record_id=data.get("lead_id"), user_id=user_id, field="lead_id")
        account_id = str(data.get("account_id") or "").strip()
        if account_id:
            row = conn.execute(
                "SELECT 1 FROM social_accounts WHERE id = ? AND user_id = ?",
                (account_id, int(user_id)),
            ).fetchone()
            if row is None:
                raise CRMError(
                    "crm_invalid_tenant_reference", "crm.errors.invalidTenantReference", status_code=400,
                    details={"field": "account_id"},
                )
    elif resource == "templates":
        media_ids = data.get("media_ids") or []
        for media_id in media_ids:
            _validate_reference(
                conn, table="crm_media", record_id=media_id, user_id=user_id, field="media_ids",
            )


def _normalize_tags(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": "tags"})
    result: list[str] = []
    seen: set[str] = set()
    for raw in value:
        tag = str(raw or "").strip()
        key = tag.casefold()
        if not tag or len(tag) > 64 or key in seen:
            continue
        seen.add(key)
        result.append(tag)
        if len(result) > 50:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": "tags"})
    return result


def _normalize_patch_value(field: str, value: Any) -> Any:
    if field == "tags":
        return _normalize_tags(value)
    if field in _JSON_LIST_FIELDS:
        if not isinstance(value, list):
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": field})
        return value
    if field in _JSON_OBJECT_FIELDS:
        if not isinstance(value, dict):
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": field})
        return value
    if field in _BOOLEAN_FIELDS:
        return _strict_bool(value, field=field)
    if field in _INTEGER_FIELDS:
        try:
            result = int(value)
        except (TypeError, ValueError) as exc:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": field}) from exc
        if result < 0:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": field})
        return result
    if field == "score":
        try:
            result = float(value)
        except (TypeError, ValueError) as exc:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": field}) from exc
        if not math.isfinite(result):
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": field})
        return result
    return str(value or "").strip()


def patch_resource(
    conn: sqlite3.Connection,
    resource: str,
    *,
    user_id: int,
    record_id: str,
    payload: Mapping[str, Any],
) -> JsonDict:
    table = _resource_table(resource)
    allowed = PATCH_FIELDS[resource]
    raw = dict(payload or {})
    unknown = sorted(str(key) for key in raw if str(key) not in allowed)
    if unknown:
        raise CRMError(
            "crm_invalid_field", "crm.errors.invalidField", status_code=400,
            details={"fields": unknown},
        )
    if not raw:
        raise CRMError("crm_empty_patch", "crm.errors.emptyPatch", status_code=400)
    current = get_resource_detail(conn, resource, user_id=user_id, record_id=record_id)
    normalized = {field: _normalize_patch_value(field, value) for field, value in raw.items()}
    for required in _REQUIRED_FIELDS.get(resource, set()):
        if required in normalized and not str(normalized[required] or "").strip():
            raise CRMError(
                "crm_required_field", "crm.errors.requiredField", status_code=400,
                details={"field": required},
            )
    if resource == "destinations" and "url" in normalized:
        parsed = urlparse(str(normalized["url"]))
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            raise CRMError(
                "crm_destination_https_required", "crm.errors.destinationHttpsRequired", status_code=400,
            )
    merged = {**current, **normalized}
    _validate_references(conn, resource, int(user_id), merged)
    assignments: list[str] = []
    values: list[Any] = []
    for public_name, value in normalized.items():
        column = allowed[public_name]
        assignments.append(f"{column} = ?")
        values.append(dumps(value) if column.endswith("_json") else value)
    assignments.append("updated_at = ?")
    values.extend((now_ts(), str(record_id), int(user_id)))
    conn.execute(
        f"UPDATE {table} SET {', '.join(assignments)} WHERE id = ? AND user_id = ? AND active = 1",
        tuple(values),
    )
    return get_resource_detail(conn, resource, user_id=user_id, record_id=record_id)


def soft_delete_resource(
    conn: sqlite3.Connection,
    resource: str,
    *,
    user_id: int,
    record_id: str,
) -> JsonDict:
    table = _resource_table(resource)
    get_resource_detail(conn, resource, user_id=user_id, record_id=record_id)
    current = now_ts()
    conn.execute(
        f"UPDATE {table} SET active = 0, updated_at = ? WHERE id = ? AND user_id = ? AND active = 1",
        (current, str(record_id), int(user_id)),
    )
    if resource == "pools":
        conn.execute(
            "UPDATE crm_pool_members SET active = 0, updated_at = ? WHERE pool_id = ? AND user_id = ? AND active = 1",
            (current, str(record_id), int(user_id)),
        )
    elif resource == "leads":
        conn.execute(
            "UPDATE crm_pool_members SET active = 0, updated_at = ? WHERE lead_id = ? AND user_id = ? AND active = 1",
            (current, str(record_id), int(user_id)),
        )
    return get_resource_detail(
        conn, resource, user_id=user_id, record_id=record_id, include_inactive=True,
    )


def _require_pool(conn: sqlite3.Connection, *, user_id: int, pool_id: str) -> None:
    row = conn.execute(
        "SELECT 1 FROM crm_pools WHERE id = ? AND user_id = ? AND active = 1",
        (str(pool_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_pool_not_found", "crm.errors.poolNotFound", status_code=404)


def _require_lead(conn: sqlite3.Connection, *, user_id: int, lead_id: str) -> None:
    row = conn.execute(
        "SELECT 1 FROM crm_leads WHERE id = ? AND user_id = ? AND active = 1",
        (str(lead_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError(
            "crm_invalid_tenant_reference", "crm.errors.invalidTenantReference", status_code=400,
            details={"field": "lead_id"},
        )


def _member_detail(conn: sqlite3.Connection, *, user_id: int, pool_id: str, lead_id: str) -> JsonDict:
    row = conn.execute(
        """
        SELECT m.pool_id,m.lead_id,m.status AS member_status,m.source,m.active AS member_active,
               m.created_at AS member_created_at,m.updated_at AS member_updated_at,
               l.*
        FROM crm_pool_members m
        JOIN crm_leads l ON l.id = m.lead_id AND l.user_id = m.user_id
        WHERE m.pool_id = ? AND m.lead_id = ? AND m.user_id = ?
        """,
        (str(pool_id), str(lead_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_pool_member_not_found", "crm.errors.poolMemberNotFound", status_code=404)
    data = row_public(row) or {}
    lead = {
        key: value
        for key, value in data.items()
        if key not in {"pool_id", "lead_id", "member_status", "source", "member_active", "member_created_at", "member_updated_at"}
    }
    return {
        "pool_id": data["pool_id"],
        "lead_id": data["lead_id"],
        "status": data["member_status"],
        "source": data["source"],
        "active": data["member_active"],
        "created_at": data["member_created_at"],
        "updated_at": data["member_updated_at"],
        "lead": lead,
    }


def list_pool_members(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    pool_id: str,
    filters: Mapping[str, Any] | None = None,
    limit: int = 50,
    cursor: str = "",
) -> JsonDict:
    _require_pool(conn, user_id=user_id, pool_id=pool_id)
    page_size = min(max(int(limit or 50), 1), 200)
    normalized = normalize_list_filters("pool_members", filters)
    clauses = ["m.user_id = ?", "m.pool_id = ?", "m.active = 1", "l.active = 1"]
    params: list[Any] = [int(user_id), str(pool_id)]
    member_fields = {"status": "m.status", "source": "m.source", "platform": "l.platform", "stage": "l.stage"}
    for public_name, column in member_fields.items():
        if public_name in normalized:
            clauses.append(f"LOWER({column}) = ?" if public_name in _LOWERCASE_FILTERS else f"{column} = ?")
            params.append(normalized[public_name])
    if "updated_after" in normalized:
        clauses.append("m.updated_at >= ?")
        params.append(normalized["updated_after"])
    if "updated_before" in normalized:
        clauses.append("m.updated_at <= ?")
        params.append(normalized["updated_before"])
    if normalized.get("q"):
        pattern = f"%{_escape_like(str(normalized['q']))}%"
        clauses.append("(l.username LIKE ? ESCAPE '\\' OR l.display_name LIKE ? ESCAPE '\\' OR l.platform_user_key LIKE ? ESCAPE '\\')")
        params.extend((pattern, pattern, pattern))
    if cursor:
        updated_at, lead_id = decode_cursor(cursor)
        clauses.append("(m.updated_at < ? OR (m.updated_at = ? AND m.lead_id < ?))")
        params.extend((updated_at, updated_at, lead_id))
    params.append(page_size + 1)
    rows = conn.execute(
        "SELECT m.lead_id,m.updated_at FROM crm_pool_members m "
        "JOIN crm_leads l ON l.id = m.lead_id AND l.user_id = m.user_id "
        f"WHERE {' AND '.join(clauses)} ORDER BY m.updated_at DESC,m.lead_id DESC LIMIT ?",
        tuple(params),
    ).fetchall()
    visible = rows[:page_size]
    items = [
        _member_detail(conn, user_id=user_id, pool_id=pool_id, lead_id=str(row["lead_id"]))
        for row in visible
    ]
    has_more = len(rows) > page_size
    next_cursor = ""
    if has_more and visible:
        next_cursor = encode_cursor(int(visible[-1]["updated_at"] or 0), str(visible[-1]["lead_id"]))
    return {
        "items": items,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "limit": page_size,
        "filters": normalized,
    }


def add_pool_members(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    pool_id: str,
    lead_ids: Sequence[str],
    status: str = "active",
    source: str = "",
) -> JsonDict:
    _require_pool(conn, user_id=user_id, pool_id=pool_id)
    if isinstance(lead_ids, (str, bytes, bytearray)):
        raise CRMError("crm_invalid_pool_members", "crm.errors.invalidPoolMembers", status_code=400)
    normalized_ids: list[str] = []
    seen: set[str] = set()
    for raw in lead_ids:
        lead_id = str(raw or "").strip()
        if lead_id and lead_id not in seen:
            normalized_ids.append(lead_id)
            seen.add(lead_id)
    if not normalized_ids or len(normalized_ids) > 500:
        raise CRMError("crm_invalid_pool_members", "crm.errors.invalidPoolMembers", status_code=400)
    normalized_status = str(status or "active").strip()
    normalized_source = str(source or "").strip()
    if not normalized_status or len(normalized_status) > 64 or len(normalized_source) > 200:
        raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400)
    for lead_id in normalized_ids:
        _require_lead(conn, user_id=user_id, lead_id=lead_id)
    current = now_ts()
    created: list[str] = []
    reactivated: list[str] = []
    existing: list[str] = []
    for lead_id in normalized_ids:
        prior = conn.execute(
            "SELECT active FROM crm_pool_members WHERE pool_id = ? AND lead_id = ? AND user_id = ?",
            (str(pool_id), lead_id, int(user_id)),
        ).fetchone()
        if prior is None:
            conn.execute(
                """
                INSERT INTO crm_pool_members(user_id,pool_id,lead_id,status,source,import_batch_id,active,created_at,updated_at)
                VALUES (?,?,?,?,?,'',1,?,?)
                """,
                (int(user_id), str(pool_id), lead_id, normalized_status, normalized_source, current, current),
            )
            created.append(lead_id)
        elif int(prior["active"] or 0) == 0:
            conn.execute(
                "UPDATE crm_pool_members SET status=?,source=?,active=1,updated_at=? WHERE pool_id=? AND lead_id=? AND user_id=?",
                (normalized_status, normalized_source, current, str(pool_id), lead_id, int(user_id)),
            )
            reactivated.append(lead_id)
        else:
            existing.append(lead_id)
    return {
        "pool_id": str(pool_id),
        "created": created,
        "reactivated": reactivated,
        "existing": existing,
        "deduplicated_input_count": len(lead_ids) - len(normalized_ids),
        "items": [
            _member_detail(conn, user_id=user_id, pool_id=pool_id, lead_id=lead_id)
            for lead_id in normalized_ids
        ],
    }


def add_pool_member(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    pool_id: str,
    lead_id: str,
    status: str = "active",
    source: str = "",
) -> JsonDict:
    result = add_pool_members(
        conn, user_id=user_id, pool_id=pool_id, lead_ids=[lead_id], status=status, source=source,
    )
    item = result["items"][0]
    item["created"] = bool(result["created"])
    item["reactivated"] = bool(result["reactivated"])
    return item


def remove_pool_member(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    pool_id: str,
    lead_id: str,
) -> JsonDict:
    _require_pool(conn, user_id=user_id, pool_id=pool_id)
    item = _member_detail(conn, user_id=user_id, pool_id=pool_id, lead_id=lead_id)
    removed = bool(item["active"])
    if removed:
        conn.execute(
            "UPDATE crm_pool_members SET active=0,updated_at=? WHERE pool_id=? AND lead_id=? AND user_id=?",
            (now_ts(), str(pool_id), str(lead_id), int(user_id)),
        )
    item = _member_detail(conn, user_id=user_id, pool_id=pool_id, lead_id=lead_id)
    item["removed"] = removed
    return item


def patch_pool_member(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    pool_id: str,
    lead_id: str,
    payload: Mapping[str, Any],
) -> JsonDict:
    _require_pool(conn, user_id=user_id, pool_id=pool_id)
    _require_lead(conn, user_id=user_id, lead_id=lead_id)
    current = _member_detail(conn, user_id=user_id, pool_id=pool_id, lead_id=lead_id)
    if not current["active"]:
        raise CRMError("crm_pool_member_not_found", "crm.errors.poolMemberNotFound", status_code=404)
    raw = dict(payload or {})
    allowed = {"status", "source", "tags", "stage"}
    unknown = sorted(str(key) for key in raw if str(key) not in allowed)
    if unknown:
        raise CRMError("crm_invalid_field", "crm.errors.invalidField", status_code=400, details={"fields": unknown})
    if not raw:
        raise CRMError("crm_empty_patch", "crm.errors.emptyPatch", status_code=400)
    current_ts = now_ts()
    member_updates: list[str] = []
    member_values: list[Any] = []
    lead_updates: list[str] = []
    lead_values: list[Any] = []
    if "status" in raw:
        status = str(raw["status"] or "").strip()
        if not status or len(status) > 64:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": "status"})
        member_updates.append("status=?")
        member_values.append(status)
    if "source" in raw:
        source = str(raw["source"] or "").strip()
        if len(source) > 200:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": "source"})
        member_updates.append("source=?")
        member_values.append(source)
    if "tags" in raw:
        lead_updates.append("tags_json=?")
        lead_values.append(dumps(_normalize_tags(raw["tags"])))
    if "stage" in raw:
        stage = str(raw["stage"] or "").strip()
        if not stage or len(stage) > 64:
            raise CRMError("crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400, details={"field": "stage"})
        lead_updates.append("stage=?")
        lead_values.append(stage)
    if member_updates:
        member_updates.append("updated_at=?")
        member_values.extend((current_ts, str(pool_id), str(lead_id), int(user_id)))
        conn.execute(
            f"UPDATE crm_pool_members SET {','.join(member_updates)} WHERE pool_id=? AND lead_id=? AND user_id=? AND active=1",
            tuple(member_values),
        )
    if lead_updates:
        lead_updates.append("updated_at=?")
        lead_values.extend((current_ts, str(lead_id), int(user_id)))
        conn.execute(
            f"UPDATE crm_leads SET {','.join(lead_updates)} WHERE id=? AND user_id=? AND active=1",
            tuple(lead_values),
        )
    return _member_detail(conn, user_id=user_id, pool_id=pool_id, lead_id=lead_id)


def deduplicate_pool_members(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    pool_id: str,
) -> JsonDict:
    """Deactivate duplicate identities while preserving the oldest membership."""

    _require_pool(conn, user_id=user_id, pool_id=pool_id)
    rows = conn.execute(
        """
        SELECT m.lead_id,m.created_at,l.platform,l.platform_user_key,l.username
        FROM crm_pool_members m
        JOIN crm_leads l ON l.id=m.lead_id AND l.user_id=m.user_id
        WHERE m.user_id=? AND m.pool_id=? AND m.active=1 AND l.active=1
        ORDER BY m.created_at ASC,m.lead_id ASC
        """,
        (int(user_id), str(pool_id)),
    ).fetchall()
    identities: dict[tuple[str, str, str], str] = {}
    duplicate_ids: list[str] = []
    kept_by_duplicate: dict[str, str] = {}
    for row in rows:
        platform = str(row["platform"] or "").strip().casefold()
        platform_key = str(row["platform_user_key"] or "").strip().casefold()
        username = str(row["username"] or "").strip().lstrip("@").casefold()
        if platform_key:
            identity = (platform, "key", platform_key)
        elif username:
            identity = (platform, "username", username)
        else:
            continue
        lead_id = str(row["lead_id"])
        kept = identities.get(identity)
        if kept is None:
            identities[identity] = lead_id
        else:
            duplicate_ids.append(lead_id)
            kept_by_duplicate[lead_id] = kept
    if duplicate_ids:
        current = now_ts()
        placeholders = ",".join("?" for _ in duplicate_ids)
        conn.execute(
            f"UPDATE crm_pool_members SET active=0,updated_at=? WHERE user_id=? AND pool_id=? AND lead_id IN ({placeholders})",
            (current, int(user_id), str(pool_id), *duplicate_ids),
        )
    return {
        "pool_id": str(pool_id),
        "removed_count": len(duplicate_ids),
        "duplicates": [
            {"lead_id": duplicate_id, "kept_lead_id": kept_by_duplicate[duplicate_id]}
            for duplicate_id in duplicate_ids
        ],
    }


__all__ = [
    "FILTER_FIELDS",
    "PATCH_FIELDS",
    "add_pool_member",
    "add_pool_members",
    "deduplicate_pool_members",
    "get_resource_detail",
    "list_pool_members",
    "list_resources_filtered",
    "normalize_list_filters",
    "patch_pool_member",
    "patch_resource",
    "remove_pool_member",
    "soft_delete_resource",
]
