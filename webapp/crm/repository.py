from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import time
import uuid
from collections.abc import Callable, Iterable
from typing import Any

from .errors import CRMError
from .direct_message_policy import evaluate_direct_message_trust
from .engagement_policy import evaluate_public_comment_rate, next_public_comment_delay

JsonDict = dict[str, Any]
Adapter = Callable[[sqlite3.Connection, JsonDict], JsonDict]

WORKFLOW_STATES = {
    "draft",
    "awaiting_confirmation",
    "queued",
    "running",
    "manual_required",
    "paused_by_user",
    "paused_by_policy",
    "completed",
    "failed",
    "cancelled",
}
ACTION_STATES = {
    "planned",
    "reserved",
    "submitting",
    "submitted",
    "confirmed",
    "unknown",
    "failed",
    "skipped",
}

ACTIVE_DUPLICATE_STATES = (
    "planned", "reserved", "submitting", "submitted", "confirmed", "unknown",
)

RESOURCE_TABLES = {
    "pools": "crm_pools",
    "leads": "crm_leads",
    "events": "crm_events",
    "hotspots": "crm_hotspots",
    "relationships": "crm_relationships",
    "templates": "crm_templates",
    "media": "crm_media",
    "schedules": "crm_schedules",
    "groups": "crm_groups",
    "destinations": "crm_destinations",
}

RESOURCE_FIELDS: dict[str, tuple[str, ...]] = {
    "pools": ("name", "description", "tags_json", "snapshot_json"),
    "leads": (
        "platform", "platform_user_key", "username", "display_name", "stage",
        "score", "tags_json", "profile_json",
    ),
    "events": ("lead_id", "workflow_id", "event_type", "occurred_at", "payload_json"),
    "hotspots": ("platform", "source_url", "title", "content", "metrics_json", "captured_at"),
    "relationships": (
        "lead_id", "account_id", "relationship_type", "status", "verified_at", "evidence_json",
    ),
    "templates": ("name", "template_type", "locale", "content", "media_ids_json", "is_default"),
    "media": ("storage_path", "sha256", "mime_type", "size_bytes", "original_name"),
    "schedules": (
        "workflow_type", "cron_expression", "timezone", "enabled", "next_run_at", "last_run_at", "payload_json",
    ),
    "groups": ("platform", "name", "platform_group_key", "members_json", "status"),
    "destinations": ("name", "url", "enabled"),
}

# This registry is the server-owned execution contract.  Client payloads may
# select an action type, account, target and content, but they may not decide
# whether the action writes to a platform, which worker task it becomes, or
# which SKU is charged.
ACTION_SPECS: dict[str, dict[str, Any]] = {
    "account_check": {"task_type": "check_login", "write": False, "sku": ""},
    "open_login": {"task_type": "open_login", "write": False, "sku": ""},
    "collect_feed": {"task_type": "browse_feed", "write": False, "sku": ""},
    "collect_profile": {"task_type": "browse_profile", "write": False, "sku": ""},
    "relationship_verify": {
        "task_type": "instagram_relationship_verify", "write": False, "sku": "", "platform": "instagram",
    },
    "public_comment": {"task_type": "comment_post", "write": True, "sku": "threads_auto_reply_batch"},
    "public_reply": {"task_type": "reply_comment", "write": True, "sku": "threads_auto_reply_batch"},
    "followup_reply": {"task_type": "reply_comment", "write": True, "sku": "threads_auto_reply_batch"},
    "nurture_reply": {"task_type": "reply_comment", "write": True, "sku": "threads_auto_reply_batch"},
    "like": {"task_type": "like_post", "write": True, "sku": "threads_auto_reply_batch"},
    "share": {"task_type": "share_post", "write": True, "sku": "threads_auto_reply_batch"},
    "repost": {"task_type": "repost_post", "write": True, "sku": "threads_auto_reply_batch"},
    "threads_group_invite_post": {
        "task_type": "publish_post", "write": True, "sku": "crm_group_invite_batch", "platform": "threads",
    },
    "instagram_group_candidates_inspect": {
        "task_type": "instagram_group_candidates_inspect", "write": False, "sku": "", "platform": "instagram",
    },
    "instagram_recent_conversations_inspect": {
        "task_type": "instagram_recent_conversations_inspect", "write": False, "sku": "", "platform": "instagram",
    },
    "instagram_conversation_controls_inspect": {
        "task_type": "instagram_conversation_controls_inspect", "write": False, "sku": "", "platform": "instagram",
    },
    "instagram_group_create": {
        "task_type": "instagram_group_create", "write": True, "sku": "crm_group_invite_batch", "platform": "instagram",
    },
    "instagram_group_post": {
        "task_type": "instagram_group_post", "write": True, "sku": "crm_group_invite_batch", "platform": "instagram",
    },
    "instagram_group_settings_update": {
        "task_type": "instagram_group_settings_update", "write": True, "sku": "crm_group_invite_batch", "platform": "instagram",
    },
    "instagram_group_members_add": {
        "task_type": "instagram_group_members_add", "write": True, "sku": "crm_group_invite_batch", "platform": "instagram",
    },
    "instagram_group_members_inspect": {
        "task_type": "instagram_group_members_inspect", "write": False, "sku": "", "platform": "instagram",
    },
    "instagram_group_status_inspect": {
        "task_type": "instagram_group_status_inspect", "write": False, "sku": "", "platform": "instagram",
    },
    "direct_message": {"task_type": "direct_message", "write": True, "sku": "crm_direct_message_batch"},
}

ACTION_ALIASES = {"comment": "public_comment", "reply": "public_reply"}

_DURABLE_SECRET_KEYS = {
    "authorization", "cookie", "cookies", "password", "login_password",
    "access_token", "refresh_token", "session_token", "client_secret", "api_key",
}

JSON_FIELDS = {
    "input_json", "result_json", "confirmation_json", "legacy_payload_json",
    "payload_json", "tags_json", "snapshot_json", "profile_json", "metrics_json",
    "evidence_json", "media_ids_json", "members_json", "counts_json", "report_json",
}

LIST_BLOB_COLUMNS = {
    "input_json", "result_json", "confirmation_json", "legacy_payload_json",
    "snapshot_json", "profile_json", "evidence_json", "payload_json",
    "report_json", "metrics_json",
}

LIST_OMIT_PUBLIC_KEYS = (
    "input", "result", "confirmation", "legacy_payload",
    "snapshot", "profile", "evidence", "payload", "report", "metrics",
)


def now_ts() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def loads(value: Any, default: Any) -> Any:
    try:
        return json.loads(str(value)) if value not in (None, "") else default
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def action_spec(action_type: str) -> JsonDict:
    normalized = ACTION_ALIASES.get(str(action_type or "").strip().lower(), str(action_type or "").strip().lower())
    spec = ACTION_SPECS.get(normalized)
    if spec is None:
        raise CRMError(
            "crm_action_blocked",
            "crm.errors.actionBlocked",
            status_code=409,
            details={"action_type": normalized or "unknown"},
        )
    return {"action_type": normalized, **spec}


def _find_durable_secret(value: Any, path: str = "payload") -> str:
    if isinstance(value, dict):
        for raw_key, child in value.items():
            key = str(raw_key or "").strip().lower().replace("-", "_")
            child_path = f"{path}.{raw_key}"
            if key in _DURABLE_SECRET_KEYS or key.endswith("_password") or key.endswith("_token") or key.endswith("_secret"):
                return child_path
            found = _find_durable_secret(child, child_path)
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            found = _find_durable_secret(child, f"{path}[{index}]")
            if found:
                return found
    return ""


def canonicalize_action(action: JsonDict) -> JsonDict:
    """Return the only action shape that may enter the durable ledger."""

    spec = action_spec(str(action.get("action_type") or ""))
    target_key = str(action.get("target_key") or "").strip()
    if not target_key:
        raise CRMError("crm_invalid_action", "crm.errors.invalidAction", status_code=400)
    content = str(action.get("content") or "")
    payload = dict(action.get("payload") or {}) if isinstance(action.get("payload"), dict) else {}
    secret_path = _find_durable_secret(payload)
    if secret_path:
        raise CRMError(
            "crm_durable_secret_forbidden",
            "crm.errors.durableSecretForbidden",
            status_code=400,
            details={"path": secret_path},
        )
    # Strip every field that could redirect execution, then write canonical
    # values back from the top-level request and server registry.
    for key in (
        "action_type", "task_type", "write", "sku", "content_hash", "idempotency_key",
        "target_key", "target_url", "content", "comment", "reply", "platform",
    ):
        payload.pop(key, None)
    payload["target_url"] = target_key
    if content:
        payload["content"] = content
        if spec["task_type"] == "comment_post":
            payload["comment"] = content
        elif spec["task_type"] == "reply_comment":
            payload["reply"] = content
    try:
        quantity = max(1, min(int(action.get("quantity") or 1), 200))
    except (TypeError, ValueError) as exc:
        raise CRMError("crm_invalid_action", "crm.errors.invalidAction", status_code=400) from exc
    canonical: JsonDict = {
        "action_type": spec["action_type"],
        "account_id": str(action.get("account_id") or "").strip(),
        "target_key": target_key,
        "content": content,
        "write": bool(spec["write"]),
        "sku": str(spec["sku"]),
        "quantity": quantity,
        "payload": payload,
    }
    if spec.get("platform"):
        canonical["platform"] = str(spec["platform"])
    return canonical


def _expand_instagram_group_actions(actions: Iterable[JsonDict]) -> list[JsonDict]:
    """Split a Direct group request into the platform-safe create/add sequence.

    Instagram's computer UI is substantially more reliable when the initial
    conversation is proved with at most three recipients.  The remaining
    approved recipients stay in the same CRM parent and are added in batches of
    three after the create result provides the durable conversation URL.
    """

    expanded: list[JsonDict] = []
    for action in actions:
        if str(action.get("action_type") or "") != "instagram_group_create":
            expanded.append(action)
            continue
        payload = dict(action.get("payload") or {}) if isinstance(action.get("payload"), dict) else {}
        raw_members = payload.get("members")
        if not isinstance(raw_members, list) or len(raw_members) <= 3:
            expanded.append(action)
            continue
        members = [str(item or "").strip().lstrip("@").lower() for item in raw_members]
        lead_ids = payload.get("lead_ids") if isinstance(payload.get("lead_ids"), list) else []
        first = dict(action)
        first_payload = dict(payload)
        first_payload["members"] = members[:3]
        if lead_ids:
            first_payload["lead_ids"] = [str(item or "") for item in lead_ids[:3]]
        first_payload["approved_members"] = members
        first["payload"] = first_payload
        expanded.append(first)
        target_key = str(action.get("target_key") or "instagram:direct:new")
        for offset in range(3, len(members), 3):
            batch = members[offset : offset + 3]
            batch_payload: JsonDict = {
                "confirmed": True,
                "members": batch,
                "inherit_group_target": True,
                "group_create_target_key": target_key,
            }
            expected_username = str(payload.get("expected_username") or payload.get("expectedUsername") or "").strip()
            if expected_username:
                batch_payload["expected_username"] = expected_username
            if lead_ids:
                batch_payload["lead_ids"] = [str(item or "") for item in lead_ids[offset : offset + 3]]
            expanded.append(
                {
                    "action_type": "instagram_group_members_add",
                    "account_id": str(action.get("account_id") or ""),
                    "target_key": f"{target_key}:members:{offset // 3}",
                    "content": "",
                    "payload": batch_payload,
                }
            )
    return expanded


def _hydrate_instagram_group_target(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    step_id: str,
    action: JsonDict,
) -> JsonDict:
    if str(action.get("action_type") or "") != "instagram_group_members_add":
        return action
    payload = dict(action.get("payload") or {}) if isinstance(action.get("payload"), dict) else {}
    if payload.get("inherit_group_target") is not True:
        return action
    current_step = conn.execute(
        "SELECT sequence_no FROM crm_workflow_steps WHERE id=? AND workflow_id=? AND user_id=?",
        (str(step_id), str(workflow_id), int(user_id)),
    ).fetchone()
    if current_step is None:
        raise CRMError("crm_step_not_found", "crm.errors.stepNotFound", status_code=409)
    previous = conn.execute(
        """
        SELECT result_json FROM crm_workflow_steps
        WHERE workflow_id=? AND user_id=? AND step_type='instagram_group_create'
          AND sequence_no<? AND status='success'
        ORDER BY sequence_no DESC LIMIT 1
        """,
        (str(workflow_id), int(user_id), int(current_step["sequence_no"])),
    ).fetchone()
    result = loads(previous["result_json"], {}) if previous is not None else {}
    target_url = str((result or {}).get("target_url") or (result or {}).get("targetUrl") or "").strip()
    if not target_url:
        raise CRMError(
            "crm_group_target_unavailable",
            "crm.errors.groupTargetUnavailable",
            status_code=409,
        )
    payload["target_url"] = target_url
    hydrated = dict(action)
    hydrated["payload"] = payload
    conn.execute(
        "UPDATE crm_workflow_steps SET payload_json=?,updated_at=? WHERE id=? AND user_id=?",
        (dumps(hydrated), now_ts(), str(step_id), int(user_id)),
    )
    return hydrated


def find_active_duplicate_action(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    account_id: str,
    action_type: str,
    target_key: str,
    content_hash: str,
) -> sqlite3.Row | None:
    """Return the active ledger row that makes a platform write unsafe to repeat.

    A private-message recipient may only be contacted once per tenant,
    regardless of sender rotation or copy changes.  Other write actions retain the legacy
    target-and-content policy so distinct public replies remain possible.
    """

    placeholders = ",".join("?" for _ in ACTIVE_DUPLICATE_STATES)
    if str(action_type) == "direct_message":
        return conn.execute(
            f"""
            SELECT id,workflow_id,state FROM crm_action_ledger
            WHERE user_id=? AND action_type='direct_message' AND target_key=?
              AND state IN ({placeholders})
            ORDER BY created_at DESC LIMIT 1
            """,
            (
                int(user_id), str(target_key),
                *ACTIVE_DUPLICATE_STATES,
            ),
        ).fetchone()
    return conn.execute(
        f"""
        SELECT id,workflow_id,state FROM crm_action_ledger
        WHERE user_id=? AND action_type=? AND target_key=? AND content_hash=?
          AND state IN ({placeholders})
        ORDER BY created_at DESC LIMIT 1
        """,
        (
            int(user_id), str(action_type), str(target_key), str(content_hash),
            *ACTIVE_DUPLICATE_STATES,
        ),
    ).fetchone()


def _call_adapter(adapter: Adapter, conn: sqlite3.Connection, request: JsonDict, *, fallback_code: str, fallback_key: str) -> JsonDict:
    try:
        return adapter(conn, request)
    except CRMError:
        raise
    except Exception as exc:
        raw_detail = getattr(exc, "detail", None)
        adapter_code = ""
        if isinstance(raw_detail, dict):
            adapter_code = str(raw_detail.get("code") or "").strip()
        adapter_code = adapter_code or str(getattr(exc, "code", "") or "").strip()
        status_code = int(getattr(exc, "status_code", 503) or 503)
        raise CRMError(
            adapter_code or fallback_code,
            "crm.errors.actionBlocked" if adapter_code == "crm_action_blocked" else fallback_key,
            status_code=max(400, min(status_code, 599)),
            details={"adapter": str(request.get("operation") or "")},
            retryable=status_code >= 500,
        ) from exc


def row_public(row: sqlite3.Row | dict[str, Any] | None) -> JsonDict | None:
    if row is None:
        return None
    result = dict(row)
    for key in tuple(result):
        if key in JSON_FIELDS:
            result[key[:-5] if key.endswith("_json") else key] = loads(result.pop(key), {})
    return result


def _list_preview_fields(data: JsonDict) -> JsonDict:
    nested = data.get("detail") if isinstance(data.get("detail"), dict) else {}
    evidence = data.get("evidence") if isinstance(data.get("evidence"), dict) else {}
    text = str(
        data.get("content")
        or data.get("comment")
        or data.get("message")
        or data.get("instruction")
        or data.get("text")
        or data.get("source_text")
        or nested.get("name")
        or nested.get("title")
        or nested.get("comment")
        or nested.get("content")
        or evidence.get("comment")
        or evidence.get("content")
        or (data.get("detail") if isinstance(data.get("detail"), str) else "")
        or ""
    ).strip()[:160]
    user = str(
        data.get("recipient")
        or data.get("recipient_username")
        or data.get("username")
        or data.get("display_name")
        or data.get("target")
        or nested.get("username")
        or nested.get("display_name")
        or ""
    ).strip()
    preview: JsonDict = {}
    if text:
        preview["preview_text"] = text
    if user and user not in text:
        preview["preview_user"] = user
    return preview


def row_public_list(row: sqlite3.Row | dict[str, Any] | None) -> JsonDict | None:
    result = row_public(row)
    if not result:
        return result
    blob = result.get("payload") if isinstance(result.get("payload"), dict) else result.get("input")
    if isinstance(blob, dict):
        result.update(_list_preview_fields(blob))
    for key in LIST_OMIT_PUBLIC_KEYS:
        result.pop(key, None)
    return result


def list_select_sql(conn: sqlite3.Connection, table: str) -> str:
    omit = set(LIST_BLOB_COLUMNS)
    if table in {"crm_events", "crm_workflows"}:
        omit.discard("payload_json" if table == "crm_events" else "input_json")
    columns = [
        str(item[1])
        for item in conn.execute(f"PRAGMA table_info({table})").fetchall()
        if str(item[1]) not in omit
    ]
    return ", ".join(columns) if columns else "*"


def workspace_user_id(user: JsonDict) -> int:
    try:
        value = int(user.get("_workspace_user_id") or user.get("id") or 0)
    except (TypeError, ValueError) as exc:
        raise CRMError("crm_invalid_workspace", "crm.errors.invalidWorkspace", status_code=401) from exc
    if value <= 0:
        raise CRMError("crm_invalid_workspace", "crm.errors.invalidWorkspace", status_code=401)
    return value


def encode_cursor(updated_at: int, record_id: str) -> str:
    raw = dumps({"updated_at": int(updated_at), "id": str(record_id)}).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[int, str]:
    try:
        padded = str(cursor or "") + "=" * (-len(str(cursor or "")) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        updated_at = int(data["updated_at"])
        record_id = str(data["id"])
        if updated_at < 0 or not record_id:
            raise ValueError("invalid cursor values")
        return updated_at, record_id
    except Exception as exc:
        raise CRMError("crm_invalid_cursor", "crm.errors.invalidCursor", status_code=400) from exc


def list_resource(
    conn: sqlite3.Connection,
    resource: str,
    *,
    user_id: int,
    limit: int = 50,
    cursor: str = "",
) -> JsonDict:
    table = RESOURCE_TABLES.get(str(resource))
    if not table:
        raise CRMError("crm_unknown_resource", "crm.errors.unknownResource", status_code=404)
    page_size = min(max(int(limit or 50), 1), 200)
    params: list[Any] = [int(user_id)]
    cursor_sql = ""
    if cursor:
        updated_at, record_id = decode_cursor(cursor)
        cursor_sql = " AND (updated_at < ? OR (updated_at = ? AND id < ?))"
        params.extend((updated_at, updated_at, record_id))
    params.append(page_size + 1)
    rows = conn.execute(
        f"SELECT {list_select_sql(conn, table)} FROM {table} WHERE user_id = ? AND active = 1{cursor_sql} "
        "ORDER BY updated_at DESC, id DESC LIMIT ?",
        tuple(params),
    ).fetchall()
    has_more = len(rows) > page_size
    visible = rows[:page_size]
    next_cursor = ""
    if has_more and visible:
        next_cursor = encode_cursor(int(visible[-1]["updated_at"] or 0), str(visible[-1]["id"]))
    return {
        "items": [row_public_list(row) for row in visible],
        "next_cursor": next_cursor,
        "has_more": has_more,
        "limit": page_size,
    }


def _coerce_field(field: str, value: Any) -> Any:
    if field.endswith("_json"):
        return dumps(value if isinstance(value, (dict, list)) else {})
    if field in {"score"}:
        return float(value or 0)
    if field in {"occurred_at", "captured_at", "verified_at", "size_bytes", "enabled", "next_run_at", "last_run_at", "is_default"}:
        return int(value or 0)
    return str(value or "")


def _require_tenant_reference(
    conn: sqlite3.Connection,
    *,
    table: str,
    record_id: str,
    user_id: int,
    field: str,
) -> None:
    if not record_id:
        return
    row = conn.execute(
        f"SELECT 1 FROM {table} WHERE id = ? AND user_id = ?",
        (str(record_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError(
            "crm_invalid_tenant_reference",
            "crm.errors.invalidTenantReference",
            status_code=400,
            details={"field": field},
        )


def _validate_resource_references(
    conn: sqlite3.Connection,
    *,
    resource: str,
    user_id: int,
    payload: JsonDict,
) -> None:
    if resource == "events":
        _require_tenant_reference(
            conn, table="crm_leads", record_id=str(payload.get("lead_id") or ""),
            user_id=user_id, field="lead_id",
        )
        _require_tenant_reference(
            conn, table="crm_workflows", record_id=str(payload.get("workflow_id") or ""),
            user_id=user_id, field="workflow_id",
        )
    elif resource == "relationships":
        _require_tenant_reference(
            conn, table="crm_leads", record_id=str(payload.get("lead_id") or ""),
            user_id=user_id, field="lead_id",
        )
        _require_tenant_reference(
            conn, table="social_accounts", record_id=str(payload.get("account_id") or ""),
            user_id=user_id, field="account_id",
        )
    elif resource == "templates":
        media_ids = payload.get("media_ids")
        if media_ids is None:
            media_ids = payload.get("media_ids_json")
        if media_ids not in (None, "") and not isinstance(media_ids, list):
            raise CRMError("crm_invalid_media_ids", "crm.errors.invalidMediaIds", status_code=400)
        for media_id in media_ids or []:
            _require_tenant_reference(
                conn, table="crm_media", record_id=str(media_id or ""),
                user_id=user_id, field="media_ids",
            )


def create_resource(
    conn: sqlite3.Connection,
    resource: str,
    *,
    user_id: int,
    payload: JsonDict,
    record_id: str = "",
    active: bool = True,
    import_batch_id: str = "",
    legacy_id: str = "",
) -> JsonDict:
    table = RESOURCE_TABLES.get(str(resource))
    fields = RESOURCE_FIELDS.get(str(resource))
    if not table or fields is None:
        raise CRMError("crm_unknown_resource", "crm.errors.unknownResource", status_code=404)
    if resource == "destinations":
        from urllib.parse import urlparse

        parsed = urlparse(str(payload.get("url") or ""))
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            raise CRMError("crm_destination_https_required", "crm.errors.destinationHttpsRequired", status_code=400)
    required = {
        "pools": "name", "events": "event_type", "templates": "name",
        "media": "storage_path", "schedules": "workflow_type", "destinations": "url",
    }.get(resource)
    if required and not str(payload.get(required) or "").strip():
        raise CRMError("crm_required_field", "crm.errors.requiredField", status_code=400, details={"field": required})
    if active:
        _validate_resource_references(conn, resource=resource, user_id=int(user_id), payload=payload)
    created = now_ts()
    rid = str(record_id or new_id(f"crm_{resource[:-1]}"))
    columns = ["id", "user_id", *fields, "import_batch_id", "active", "legacy_id", "legacy_payload_json", "schema_version", "created_at", "updated_at"]
    values: list[Any] = [rid, int(user_id)]
    values.extend(_coerce_field(field, payload.get(field[:-5] if field.endswith("_json") else field)) for field in fields)
    values.extend((str(import_batch_id), 1 if active else 0, str(legacy_id), dumps(payload), 1, created, created))
    placeholders = ",".join("?" for _ in columns)
    try:
        conn.execute(
            f"INSERT INTO {table}({','.join(columns)}) VALUES ({placeholders})",
            tuple(values),
        )
    except sqlite3.IntegrityError as exc:
        raise CRMError("crm_resource_conflict", "crm.errors.resourceConflict", status_code=409) from exc
    return row_public(conn.execute(f"SELECT * FROM {table} WHERE id = ? AND user_id = ?", (rid, int(user_id))).fetchone()) or {}


def get_workflow(conn: sqlite3.Connection, *, user_id: int, workflow_id: str) -> JsonDict:
    row = conn.execute(
        "SELECT * FROM crm_workflows WHERE id = ? AND user_id = ? AND active = 1",
        (str(workflow_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_task_not_found", "crm.errors.taskNotFound", status_code=404)
    workflow = row_public(row) or {}
    workflow["steps"] = [
        row_public(item)
        for item in conn.execute(
            "SELECT * FROM crm_workflow_steps WHERE workflow_id = ? AND user_id = ? ORDER BY sequence_no, id",
            (str(workflow_id), int(user_id)),
        ).fetchall()
    ]
    workflow["actions"] = [
        row_public(item)
        for item in conn.execute(
            """
            SELECT action.*
            FROM crm_action_ledger action
            JOIN crm_workflow_steps step
              ON step.id=action.step_id AND step.workflow_id=action.workflow_id AND step.user_id=action.user_id
            WHERE action.workflow_id = ? AND action.user_id = ?
            ORDER BY step.sequence_no, action.id
            """,
            (str(workflow_id), int(user_id)),
        ).fetchall()
    ]
    return workflow


def _dispatch_action_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    step_id: str,
    action_id: str,
    action: JsonDict,
    action_idempotency_key: str,
    billing_adapter: Adapter | None,
    social_task_adapter: Adapter | None,
) -> None:
    if social_task_adapter is None:
        raise CRMError("crm_adapter_unavailable", "crm.errors.socialAdapterUnavailable", status_code=503, retryable=True)
    action = _hydrate_instagram_group_target(
        conn,
        user_id=int(user_id),
        workflow_id=str(workflow_id),
        step_id=str(step_id),
        action=action,
    )
    if str(action.get("action_type") or "") == "direct_message":
        trust_policy = evaluate_direct_message_trust(
            conn,
            user_id=int(user_id),
            account_id=str(action.get("account_id") or ""),
            action=dict(action),
        )
        if not trust_policy["allowed"]:
            raise CRMError(
                f"crm_direct_message_{trust_policy['code']}",
                "crm.errors.actionBlocked",
                status_code=409,
                details={"trust": trust_policy},
            )
    sku = str(action.get("sku") or "").strip()
    if bool(action.get("write", True)) and not sku:
        raise CRMError("crm_billing_sku_required", "crm.errors.billingSkuRequired", status_code=409)
    reservation_id = ""
    batch_sku_already_reserved = False
    if sku:
        current_step = conn.execute(
            "SELECT sequence_no FROM crm_workflow_steps WHERE id=? AND workflow_id=? AND user_id=?",
            (str(step_id), str(workflow_id), int(user_id)),
        ).fetchone()
        if current_step is None:
            raise CRMError("crm_step_not_found", "crm.errors.stepNotFound", status_code=409)
        prior_steps = conn.execute(
            "SELECT payload_json FROM crm_workflow_steps WHERE workflow_id=? AND user_id=? AND sequence_no<? ORDER BY sequence_no",
            (str(workflow_id), int(user_id), int(current_step["sequence_no"])),
        ).fetchall()
        batch_sku_already_reserved = any(
            str((loads(row["payload_json"], {}) or {}).get("sku") or "").strip() == sku
            for row in prior_steps
        )
    if sku and not batch_sku_already_reserved:
        if billing_adapter is None:
            raise CRMError("crm_adapter_unavailable", "crm.errors.billingAdapterUnavailable", status_code=503, retryable=True)
        reserved = _call_adapter(
            billing_adapter,
            conn,
            {
                "operation": "reserve", "user_id": int(user_id), "workflow_id": workflow_id,
                "action_id": action_id, "sku": sku, "quantity": 1,
                "billing_scope": "approved_workflow_batch",
                "idempotency_key": f"crm-billing:{int(user_id)}:{workflow_id}:{sku}",
            },
            fallback_code="crm_billing_reservation_failed",
            fallback_key="crm.errors.billingReservationFailed",
        )
        reservation_id = str((reserved or {}).get("reservation_id") or (reserved or {}).get("id") or "")
        if not reservation_id:
            raise CRMError("crm_billing_reservation_failed", "crm.errors.billingReservationFailed", status_code=503, retryable=True)
    action_for_child = dict(action)
    action_for_child["billing_reservation_id"] = reservation_id
    scheduled_at = 0
    if str(action.get("action_type") or "") == "public_comment":
        current = now_ts()
        rate_events: list[JsonDict] = []
        rows = conn.execute(
            """
            SELECT state,created_at,updated_at
            FROM crm_action_ledger
            WHERE user_id=? AND account_id=? AND action_type='public_comment'
              AND id<>? AND state IN ('reserved','submitting','submitted','confirmed','unknown')
              AND updated_at>=?
            ORDER BY updated_at DESC
            """,
            (int(user_id), str(action.get("account_id") or ""), str(action_id), current - 86400),
        ).fetchall()
        rate_events.extend({
            "event_type": (
                "engagement_touch_published"
                if str(row["state"] or "") == "confirmed"
                else "engagement_touch_submitted"
            ),
            "sender_username": str(action.get("account_id") or ""),
            "occurred_at": int(row["updated_at"] or row["created_at"] or 0),
        } for row in rows)
        try:
            moderation_rows = conn.execute(
                """
                SELECT event_type,occurred_at,payload_json
                FROM crm_events
                WHERE user_id=? AND event_type='platform_moderation_detected'
                  AND active=1 AND occurred_at>=?
                ORDER BY occurred_at DESC
                """,
                (int(user_id), current - 86400),
            ).fetchall()
            for row in moderation_rows:
                payload = loads(row["payload_json"], {})
                if str(payload.get("account_id") or payload.get("sender_username") or "") != str(action.get("account_id") or ""):
                    continue
                rate_events.append({
                    "event_type": "platform_moderation_detected",
                    "sender_username": str(action.get("account_id") or ""),
                    "occurred_at": int(row["occurred_at"] or 0),
                    "reason": str(payload.get("reason") or ""),
                })
        except sqlite3.OperationalError:
            pass
        rate = evaluate_public_comment_rate(
            events=rate_events,
            sender_username=str(action.get("account_id") or ""),
            current_time=current,
        )
        wait_seconds = int(rate.get("wait_seconds") or 0)
        if str(rate.get("reason") or "") == "minimum_interval" and wait_seconds:
            wait_seconds += max(0, next_public_comment_delay() - 180)
        if wait_seconds:
            scheduled_at = current + wait_seconds
            action_for_child["payload"] = {
                **dict(action_for_child.get("payload") or {}),
                "_crm_rate_policy": {
                    "reason": str(rate.get("reason") or ""),
                    "scheduled_at": scheduled_at,
                },
            }
    child_request = {
        "operation": "create", "user_id": int(user_id), "workflow_id": workflow_id,
        "step_id": step_id, "action_id": action_id, "action": action_for_child,
        "billing_reservation_id": reservation_id, "idempotency_key": action_idempotency_key,
    }
    if scheduled_at:
        child_request["scheduled_at"] = scheduled_at
    child = _call_adapter(
        social_task_adapter,
        conn,
        child_request,
        fallback_code="crm_child_task_failed",
        fallback_key="crm.errors.childTaskFailed",
    )
    social_task_id = str((child or {}).get("social_task_id") or (child or {}).get("task_id") or (child or {}).get("id") or "")
    if not social_task_id:
        raise CRMError("crm_child_task_failed", "crm.errors.childTaskFailed", status_code=503, retryable=True)
    current = now_ts()
    conn.execute(
        "UPDATE crm_action_ledger SET state = ?, billing_reservation_id = ?, updated_at = ? WHERE id = ?",
        ("reserved" if reservation_id else "planned", reservation_id, current, action_id),
    )
    conn.execute(
        "UPDATE crm_workflow_steps SET social_task_id = ?, status = 'queued', updated_at = ? WHERE id = ?",
        (social_task_id, current, step_id),
    )


def create_workflow_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_type: str,
    title: str,
    input_data: JsonDict,
    idempotency_key: str,
    schedule_id: str = "",
    actions: Iterable[JsonDict] = (),
    confirmed_by: int = 0,
    billing_adapter: Adapter | None = None,
    social_task_adapter: Adapter | None = None,
) -> JsonDict:
    """Atomically create a CRM parent workflow, action ledger and child tasks.

    Adapters must use the supplied connection. Opening/committing a separate
    connection would break the contract and is rejected by integration policy.
    Any adapter exception is allowed to bubble so the surrounding db() context
    rolls back the complete graph.
    """
    clean_idempotency = str(idempotency_key or "").strip()
    if not clean_idempotency or len(clean_idempotency) > 160:
        raise CRMError("crm_invalid_idempotency_key", "crm.errors.invalidIdempotencyKey", status_code=400)
    # Acquire the writer lock before the replay lookup.  Without this ordering,
    # two connections can both miss the key and one leaks a raw UNIQUE error.
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    clean_schedule_id = str(schedule_id or "").strip()
    if clean_schedule_id:
        schedule = conn.execute(
            "SELECT 1 FROM crm_schedules WHERE id = ? AND user_id = ? AND active = 1",
            (clean_schedule_id, int(user_id)),
        ).fetchone()
        if schedule is None:
            raise CRMError(
                "crm_invalid_tenant_reference",
                "crm.errors.invalidTenantReference",
                status_code=400,
                details={"field": "schedule_id"},
            )
    existing = conn.execute(
        "SELECT id,schedule_id FROM crm_workflows WHERE user_id = ? AND idempotency_key = ?",
        (int(user_id), clean_idempotency),
    ).fetchone()
    if existing is not None:
        if clean_schedule_id and not str(existing["schedule_id"] or ""):
            conn.execute(
                "UPDATE crm_workflows SET schedule_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (clean_schedule_id, now_ts(), str(existing["id"]), int(user_id)),
            )
        return get_workflow(conn, user_id=int(user_id), workflow_id=str(existing["id"]))

    expanded_actions = _expand_instagram_group_actions(
        dict(item) for item in actions if isinstance(item, dict)
    )
    normalized_actions = [canonicalize_action(item) for item in expanded_actions]
    requires_confirmation = any(bool(action["write"]) for action in normalized_actions)
    dispatch_now = not requires_confirmation or int(confirmed_by or 0) > 0
    if dispatch_now and normalized_actions and social_task_adapter is None:
        raise CRMError("crm_adapter_unavailable", "crm.errors.socialAdapterUnavailable", status_code=503, retryable=True)
    if dispatch_now and any(str(action.get("sku") or "").strip() for action in normalized_actions) and billing_adapter is None:
        raise CRMError("crm_adapter_unavailable", "crm.errors.billingAdapterUnavailable", status_code=503, retryable=True)

    created = now_ts()
    workflow_id = new_id("crm")
    confirmation = {}
    if confirmed_by:
        confirmation = {
            "confirmed_by": int(confirmed_by),
            "confirmed_at": created,
            "target_count": len(normalized_actions),
            "targets_hash": hashlib.sha256(dumps(normalized_actions).encode("utf-8")).hexdigest(),
        }
    conn.execute(
        """
        INSERT INTO crm_workflows(
          id,user_id,workflow_type,title,status,input_json,confirmation_json,
          idempotency_key,schedule_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            workflow_id, int(user_id), str(workflow_type or "generic"), str(title or ""),
            "queued" if dispatch_now else "awaiting_confirmation",
            dumps(input_data), dumps(confirmation), clean_idempotency, clean_schedule_id, created, created,
        ),
    )
    graph: list[tuple[str, str, JsonDict, str]] = []
    for sequence, action in enumerate(normalized_actions):
        action_type = str(action["action_type"])
        target_key = str(action.get("target_key") or "").strip()
        if not action_type or not target_key:
            raise CRMError("crm_invalid_action", "crm.errors.invalidAction", status_code=400)
        content = str(action.get("content") or "")
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        duplicate = None
        if bool(action.get("write", True)):
            duplicate = find_active_duplicate_action(
                conn,
                user_id=int(user_id),
                account_id=str(action.get("account_id") or ""),
                action_type=action_type,
                target_key=target_key,
                content_hash=content_hash,
            )
        if duplicate is not None:
            raise CRMError(
                "crm_duplicate_action",
                "crm.errors.duplicateAction",
                status_code=409,
                details={
                    "existing_action_id": str(duplicate["id"]),
                    "existing_workflow_id": str(duplicate["workflow_id"]),
                    "state": str(duplicate["state"]),
                },
            )
        action_id = new_id("crm_action")
        step_id = new_id("crm_step")
        action_idem = f"{clean_idempotency}:{sequence}:{action_type}:{target_key}"
        conn.execute(
            "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?,?)",
            (step_id, workflow_id, int(user_id), action_type, sequence, dumps(action), created, created),
        )
        conn.execute(
            """
            INSERT INTO crm_action_ledger(
              id,workflow_id,step_id,user_id,account_id,action_type,target_key,content_hash,
              idempotency_key,state,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,'planned',?,?)
            """,
            (
                action_id, workflow_id, step_id, int(user_id), str(action.get("account_id") or ""),
                action_type, target_key, content_hash, action_idem, created, created,
            ),
        )
        graph.append((step_id, action_id, action, action_idem))
    # A CRM workflow is sequential.  Only the first child becomes executable;
    # reconciliation dispatches the next step after the current action reaches
    # a terminal ledger state.
    if dispatch_now and graph:
        step_id, action_id, action, action_idem = graph[0]
        _dispatch_action_atomic(
            conn,
            user_id=int(user_id), workflow_id=workflow_id, step_id=step_id, action_id=action_id,
            action=action, action_idempotency_key=action_idem,
            billing_adapter=billing_adapter, social_task_adapter=social_task_adapter,
        )
    return get_workflow(conn, user_id=int(user_id), workflow_id=workflow_id)


def confirm_workflow_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    confirmed_by: int,
    billing_adapter: Adapter | None,
    social_task_adapter: Adapter | None,
) -> JsonDict:
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    workflow = get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    if str(workflow["status"]) != "awaiting_confirmation":
        raise CRMError("crm_task_not_awaiting_confirmation", "crm.errors.taskNotAwaitingConfirmation", status_code=409)
    steps_by_id = {str(step["id"]): step for step in workflow["steps"]}
    targets: list[dict[str, Any]] = []
    for action_row in workflow["actions"]:
        if str(action_row.get("state") or "") != "planned":
            raise CRMError("crm_confirmation_state_conflict", "crm.errors.confirmationStateConflict", status_code=409)
        step = steps_by_id.get(str(action_row.get("step_id") or ""))
        if not step:
            raise CRMError("crm_step_not_found", "crm.errors.stepNotFound", status_code=409)
        action = dict(step.get("payload") or {}) if isinstance(step.get("payload"), dict) else loads(step.get("payload"), {})
        if not isinstance(action, dict):
            raise CRMError("crm_invalid_action", "crm.errors.invalidAction", status_code=409)
        targets.append(action)
    current = now_ts()
    confirmation = {
        "confirmed_by": int(confirmed_by), "confirmed_at": current,
        "target_count": len(targets),
        "targets_hash": hashlib.sha256(dumps(targets).encode("utf-8")).hexdigest(),
    }
    conn.execute(
        "UPDATE crm_workflows SET status='queued',confirmation_json=?,updated_at=? WHERE id=? AND user_id=?",
        (dumps(confirmation), current, str(workflow_id), int(user_id)),
    )
    dispatch_next_action_atomic(
        conn,
        user_id=int(user_id),
        workflow_id=str(workflow_id),
        billing_adapter=billing_adapter,
        social_task_adapter=social_task_adapter,
    )
    return get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))


def dispatch_next_action_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    billing_adapter: Adapter | None,
    social_task_adapter: Adapter | None,
) -> JsonDict:
    """Dispatch at most one sequential child whose predecessors are terminal."""

    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    workflow = get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    if str(workflow.get("status") or "") not in {"queued", "running"}:
        return workflow
    completed_predecessors = {"confirmed", "skipped"}
    actions_by_step = {str(item.get("step_id") or ""): item for item in workflow["actions"]}
    for step in workflow["steps"]:
        action = actions_by_step.get(str(step.get("id") or ""))
        if action is None:
            raise CRMError("crm_action_not_found", "crm.errors.actionNotFound", status_code=409)
        state = str(action.get("state") or "")
        if state in completed_predecessors:
            continue
        if state == "failed":
            return workflow
        # An existing child is the sole active step.  Never enqueue a later
        # step until reconciliation proves this one terminal.
        if str(step.get("social_task_id") or ""):
            return workflow
        if state != "planned":
            return workflow
        payload = step.get("payload") if isinstance(step.get("payload"), dict) else loads(step.get("payload"), {})
        if not isinstance(payload, dict):
            raise CRMError("crm_invalid_action", "crm.errors.invalidAction", status_code=409)
        _dispatch_action_atomic(
            conn,
            user_id=int(user_id), workflow_id=str(workflow_id), step_id=str(step["id"]),
            action_id=str(action["id"]), action=payload,
            action_idempotency_key=str(action["idempotency_key"]),
            billing_adapter=billing_adapter, social_task_adapter=social_task_adapter,
        )
        return get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    return workflow


def retry_workflow_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    idempotency_key: str,
    confirmed_by: int,
    billing_adapter: Adapter | None,
    social_task_adapter: Adapter | None,
) -> JsonDict:
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    original = get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    if str(original["status"]) != "failed":
        raise CRMError("crm_task_not_retryable", "crm.errors.taskNotRetryable", status_code=409)
    if any(str(action.get("state") or "") == "unknown" for action in original["actions"]):
        raise CRMError("crm_action_review_required", "crm.errors.actionReviewRequired", status_code=409)
    unsafe_states = {
        str(action.get("state") or "")
        for action in original["actions"]
        if str(action.get("state") or "") in {"reserved", "submitting", "submitted"}
    }
    if unsafe_states:
        raise CRMError(
            "crm_task_retry_unsafe", "crm.errors.taskRetryUnsafe", status_code=409,
            details={"states": sorted(unsafe_states)},
        )
    actions: list[dict[str, Any]] = []
    action_by_step = {str(item.get("step_id") or ""): item for item in original["actions"]}
    for step in original["steps"]:
        prior_action = action_by_step.get(str(step.get("id") or ""), {})
        # Never replay an action that platform evidence already confirmed.
        # Failed and not-yet-dispatched steps form the retry continuation.
        if str(prior_action.get("state") or "") == "confirmed":
            continue
        payload = step.get("payload")
        action = dict(payload) if isinstance(payload, dict) else loads(payload, {})
        if not isinstance(action, dict) or not action.get("action_type") or not action.get("target_key"):
            raise CRMError("crm_retry_payload_unavailable", "crm.errors.retryPayloadUnavailable", status_code=409)
        # A retry is a new platform action graph with new action keys; the
        # caller's workflow idempotency key protects double clicks.
        action.pop("idempotency_key", None)
        action.pop("billing_reservation_id", None)
        actions.append(action)
        if str(prior_action.get("state") or "") == "planned":
            current = now_ts()
            conn.execute(
                "UPDATE crm_action_ledger SET state='skipped',updated_at=? WHERE id=? AND user_id=?",
                (current, str(prior_action.get("id") or ""), int(user_id)),
            )
            conn.execute(
                "UPDATE crm_workflow_steps SET status='cancelled',updated_at=? WHERE id=? AND user_id=?",
                (current, str(step.get("id") or ""), int(user_id)),
            )
    if not actions:
        raise CRMError("crm_task_not_retryable", "crm.errors.taskNotRetryable", status_code=409)
    original_confirmation = original.get("confirmation") if isinstance(original.get("confirmation"), dict) else {}
    was_confirmed = int(original_confirmation.get("confirmed_by") or 0) > 0
    return create_workflow_atomic(
        conn,
        user_id=int(user_id),
        workflow_type=str(original["workflow_type"]),
        title=str(original.get("title") or ""),
        input_data=dict(original.get("input") or {}),
        idempotency_key=str(idempotency_key or ""),
        actions=actions,
        confirmed_by=int(confirmed_by) if was_confirmed else 0,
        billing_adapter=billing_adapter,
        social_task_adapter=social_task_adapter,
    )


def update_workflow_status(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    status: str,
) -> JsonDict:
    if status not in WORKFLOW_STATES:
        raise CRMError("crm_invalid_task_status", "crm.errors.invalidTaskStatus", status_code=400)
    current = get_workflow(conn, user_id=user_id, workflow_id=workflow_id)
    current_status = str(current["status"])
    allowed = {
        "awaiting_confirmation": {"cancelled"},
        "queued": {"running", "manual_required", "paused_by_user", "paused_by_policy", "cancelled", "failed"},
        "running": {"manual_required", "paused_by_user", "paused_by_policy", "completed", "failed", "cancelled"},
        "manual_required": {"queued", "paused_by_user", "paused_by_policy", "failed", "cancelled"},
        "paused_by_user": {"queued", "cancelled"},
        "paused_by_policy": {"queued", "cancelled"},
        "failed": {"queued", "cancelled"},
    }
    if status != current_status and status not in allowed.get(current_status, set()):
        raise CRMError(
            "crm_invalid_task_transition", "crm.errors.invalidTaskTransition", status_code=409,
            details={"from": current_status, "to": status},
        )
    updated = now_ts()
    finished = updated if status in {"completed", "failed", "cancelled"} else int(current.get("finished_at") or 0)
    conn.execute(
        "UPDATE crm_workflows SET status = ?, finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (status, finished, updated, str(workflow_id), int(user_id)),
    )
    return get_workflow(conn, user_id=user_id, workflow_id=workflow_id)


def transition_action_state_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    action_id: str,
    state: str,
    evidence: JsonDict | None = None,
    error_code: str = "",
    manual_review: bool = False,
    billing_adapter: Adapter | None = None,
) -> JsonDict:
    """Advance the durable platform-action truth and settle billing together."""
    if state not in ACTION_STATES:
        raise CRMError("crm_invalid_action_state", "crm.errors.invalidActionState", status_code=400)
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        "SELECT * FROM crm_action_ledger WHERE id = ? AND user_id = ?",
        (str(action_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_action_not_found", "crm.errors.actionNotFound", status_code=404)
    current_state = str(row["state"])
    allowed = {
        "planned": {"reserved", "skipped", "failed"},
        "reserved": {"submitting", "skipped", "failed"},
        "submitting": {"submitted", "unknown", "failed"},
        "submitted": {"confirmed", "unknown", "failed"},
        "unknown": {"confirmed", "failed"},
    }
    if state != current_state and state not in allowed.get(current_state, set()):
        raise CRMError(
            "crm_invalid_action_transition", "crm.errors.invalidActionTransition", status_code=409,
            details={"from": current_state, "to": state},
        )
    if current_state == "unknown" and not manual_review:
        raise CRMError("crm_action_review_required", "crm.errors.actionReviewRequired", status_code=409)
    reservation_id = str(row["billing_reservation_id"] or "")
    billing_operation = ""
    if reservation_id and state == "confirmed" and current_state != "confirmed":
        billing_operation = "settle"
    elif reservation_id and state in {"failed", "skipped"} and current_state in {"planned", "reserved", "unknown"}:
        billing_operation = "release"
    if billing_operation:
        reservation = conn.execute(
            "SELECT status FROM billing_reservations WHERE id = ?",
            (reservation_id,),
        ).fetchone()
        terminal_billing = str(reservation["status"] or "") if reservation is not None else ""
        expected_terminal = {"settle": {"settled", "waived"}, "release": {"released", "waived"}}[billing_operation]
        if terminal_billing not in expected_terminal:
            if billing_adapter is None:
                raise CRMError("crm_adapter_unavailable", "crm.errors.billingAdapterUnavailable", status_code=503, retryable=True)
            _call_adapter(
                billing_adapter,
                conn,
                {
                    "operation": billing_operation,
                    "user_id": int(user_id),
                    "workflow_id": str(row["workflow_id"]),
                    "action_id": str(action_id),
                    "reservation_id": reservation_id,
                    "idempotency_key": f"crm-billing:{int(user_id)}:{billing_operation}:{action_id}",
                },
                fallback_code="crm_billing_transition_failed",
                fallback_key="crm.errors.billingTransitionFailed",
            )
    current = now_ts()
    conn.execute(
        """
        UPDATE crm_action_ledger
        SET state = ?, evidence_json = ?, error_code = ?,
            submitted_at = CASE WHEN ? = 'submitted' AND submitted_at = 0 THEN ? ELSE submitted_at END,
            confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
            updated_at = ?
        WHERE id = ? AND user_id = ?
        """,
        (
            state, dumps(evidence or {}), str(error_code or ""), state, current,
            state, current, current, str(action_id), int(user_id),
        ),
    )
    return row_public(conn.execute("SELECT * FROM crm_action_ledger WHERE id = ?", (str(action_id),)).fetchone()) or {}


def _advance_action_to_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    action_id: str,
    desired: str,
    evidence: JsonDict | None,
    error_code: str,
    billing_adapter: Adapter | None,
) -> JsonDict:
    row = conn.execute(
        "SELECT state FROM crm_action_ledger WHERE id=? AND user_id=?",
        (str(action_id), int(user_id)),
    ).fetchone()
    if row is None:
        raise CRMError("crm_action_not_found", "crm.errors.actionNotFound", status_code=404)
    current = str(row["state"] or "")
    paths = {
        "confirmed": ["planned", "reserved", "submitting", "submitted", "confirmed"],
        "unknown": ["planned", "reserved", "submitting", "unknown"],
        "failed": ["failed"],
        "skipped": ["skipped"],
    }
    path = paths.get(desired, [desired])
    if current == desired:
        return row_public(conn.execute("SELECT * FROM crm_action_ledger WHERE id=?", (str(action_id),)).fetchone()) or {}
    if current in path:
        path = path[path.index(current) + 1:]
    for next_state in path:
        transition_action_state_atomic(
            conn,
            user_id=int(user_id),
            action_id=str(action_id),
            state=next_state,
            evidence=evidence if next_state in {"confirmed", "unknown", "failed"} else {},
            error_code=error_code if next_state in {"unknown", "failed"} else "",
            billing_adapter=billing_adapter,
        )
    return row_public(conn.execute("SELECT * FROM crm_action_ledger WHERE id=?", (str(action_id),)).fetchone()) or {}


def cancel_workflow_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    billing_adapter: Adapter | None,
    social_task_adapter: Adapter | None,
) -> JsonDict:
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    workflow = get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    unsafe = [item for item in workflow["actions"] if str(item.get("state") or "") in {"submitting", "submitted", "unknown"}]
    if unsafe:
        raise CRMError(
            "crm_task_cancel_unsafe", "crm.errors.taskCancelUnsafe", status_code=409,
            details={"action_ids": [item["id"] for item in unsafe]},
        )
    steps_by_id = {str(step["id"]): step for step in workflow["steps"]}
    for action in workflow["actions"]:
        if str(action.get("state") or "") in {"confirmed", "failed", "skipped"}:
            continue
        step = steps_by_id.get(str(action.get("step_id") or ""), {})
        social_task_id = str(step.get("social_task_id") or "")
        if social_task_id:
            if social_task_adapter is None:
                raise CRMError("crm_adapter_unavailable", "crm.errors.socialAdapterUnavailable", status_code=503, retryable=True)
            child = _call_adapter(
                social_task_adapter,
                conn,
                {
                    "operation": "cancel", "user_id": int(user_id), "workflow_id": str(workflow_id),
                    "step_id": str(step.get("id") or ""), "action_id": str(action["id"]),
                    "social_task_id": social_task_id,
                    "idempotency_key": f"crm-social:cancel:{action['id']}",
                },
                fallback_code="crm_child_cancel_failed",
                fallback_key="crm.errors.childCancelFailed",
            )
            child_status = str((child or {}).get("status") or "").lower()
            child_evidence = {
                "social_task_id": social_task_id,
                "result": (child or {}).get("result") or {},
                "cancel_observed_status": child_status,
            }
            if child_status == "success":
                _advance_action_to_atomic(
                    conn, user_id=int(user_id), action_id=str(action["id"]),
                    desired="confirmed", evidence=child_evidence, error_code="",
                    billing_adapter=billing_adapter,
                )
                current = now_ts()
                conn.execute(
                    "UPDATE crm_workflow_steps SET status='success',result_json=?,updated_at=? WHERE id=?",
                    (dumps((child or {}).get("result") or {}), current, str(step["id"])),
                )
                continue
            if child_status == "failed":
                _advance_action_to_atomic(
                    conn, user_id=int(user_id), action_id=str(action["id"]),
                    desired="failed", evidence=child_evidence,
                    error_code=str((child or {}).get("error") or "crm_child_failed"),
                    billing_adapter=billing_adapter,
                )
                current = now_ts()
                conn.execute(
                    "UPDATE crm_workflow_steps SET status='failed',result_json=?,error_code=?,updated_at=? WHERE id=?",
                    (
                        dumps((child or {}).get("result") or {}),
                        str((child or {}).get("error") or "crm_child_failed"),
                        current,
                        str(step["id"]),
                    ),
                )
                continue
        reservation_id = str(action.get("billing_reservation_id") or "")
        if reservation_id:
            if billing_adapter is None:
                raise CRMError("crm_adapter_unavailable", "crm.errors.billingAdapterUnavailable", status_code=503, retryable=True)
            _call_adapter(
                billing_adapter,
                conn,
                {
                    "operation": "release", "user_id": int(user_id), "workflow_id": str(workflow_id),
                    "action_id": str(action["id"]), "reservation_id": reservation_id,
                    "idempotency_key": f"crm-billing:{int(user_id)}:release:{action['id']}",
                },
                fallback_code="crm_billing_release_failed",
                fallback_key="crm.errors.billingReleaseFailed",
            )
        current = now_ts()
        conn.execute("UPDATE crm_action_ledger SET state='skipped',updated_at=? WHERE id=?", (current, str(action["id"])))
        if step:
            conn.execute("UPDATE crm_workflow_steps SET status='cancelled',updated_at=? WHERE id=?", (current, str(step["id"])))
    return update_workflow_status(conn, user_id=int(user_id), workflow_id=str(workflow_id), status="cancelled")


def stop_schedule_atomic(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    schedule_id: str,
    billing_adapter: Adapter | None,
    social_task_adapter: Adapter | None,
) -> JsonDict:
    """Disable a schedule and safely quiesce every workflow it owns.

    Platform actions that may already have crossed the submission boundary are
    never cancelled or replayed.  Their worker may finish and reconciliation
    may record evidence, while the paused parent prevents dispatching a later
    action.  Children that are still safely cancellable and not-yet-created
    actions are skipped in the same transaction.
    """

    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    clean_schedule_id = str(schedule_id or "").strip()
    schedule = conn.execute(
        "SELECT * FROM crm_schedules WHERE id = ? AND user_id = ? AND active = 1",
        (clean_schedule_id, int(user_id)),
    ).fetchone()
    if schedule is None:
        raise CRMError("crm_schedule_not_found", "crm.errors.scheduleNotFound", status_code=404)

    current = now_ts()
    conn.execute(
        "UPDATE crm_schedules SET enabled=0,next_run_at=0,updated_at=? "
        "WHERE id=? AND user_id=? AND active=1",
        (current, clean_schedule_id, int(user_id)),
    )
    workflow_rows = conn.execute(
        """
        SELECT id FROM crm_workflows
        WHERE user_id=? AND schedule_id=? AND active=1
          AND status NOT IN ('completed','failed','cancelled')
        ORDER BY created_at,id
        """,
        (int(user_id), clean_schedule_id),
    ).fetchall()
    unsafe_states = {"submitting", "submitted", "unknown"}
    stopped_workflows: list[JsonDict] = []
    cancelled_action_ids: list[str] = []
    deferred_action_ids: list[str] = []
    unsafe_action_ids: list[str] = []

    for workflow_row in workflow_rows:
        workflow_id = str(workflow_row["id"])
        workflow = get_workflow(conn, user_id=int(user_id), workflow_id=workflow_id)
        steps_by_id = {str(step["id"]): step for step in workflow["steps"]}
        for action in workflow["actions"]:
            action_id = str(action["id"])
            state = str(action.get("state") or "")
            if state in {"confirmed", "failed", "skipped"}:
                continue
            if state in unsafe_states:
                unsafe_action_ids.append(action_id)
                continue
            step = steps_by_id.get(str(action.get("step_id") or ""), {})
            social_task_id = str(step.get("social_task_id") or "")
            child: JsonDict = {}
            if social_task_id:
                if social_task_adapter is None:
                    deferred_action_ids.append(action_id)
                    continue
                try:
                    child = _call_adapter(
                        social_task_adapter,
                        conn,
                        {
                            "operation": "cancel",
                            "user_id": int(user_id),
                            "workflow_id": workflow_id,
                            "step_id": str(step.get("id") or ""),
                            "action_id": action_id,
                            "social_task_id": social_task_id,
                            "idempotency_key": f"crm-social:schedule-stop:{action_id}",
                        },
                        fallback_code="crm_child_cancel_failed",
                        fallback_key="crm.errors.childCancelFailed",
                    )
                except CRMError:
                    # The child may have crossed the platform submission
                    # boundary between our ledger read and cancel request.
                    # Pausing the parent is the safe fallback; reconciliation
                    # will later promote it to submitting/submitted/unknown.
                    deferred_action_ids.append(action_id)
                    continue
                child_status = str(child.get("status") or "").strip().lower()
                evidence = {
                    "social_task_id": social_task_id,
                    "result": child.get("result") or {},
                    "schedule_stop_observed_status": child_status,
                }
                if child_status == "success":
                    _advance_action_to_atomic(
                        conn,
                        user_id=int(user_id),
                        action_id=action_id,
                        desired="confirmed",
                        evidence=evidence,
                        error_code="",
                        billing_adapter=billing_adapter,
                    )
                    conn.execute(
                        "UPDATE crm_workflow_steps SET status='success',result_json=?,updated_at=? "
                        "WHERE id=? AND user_id=?",
                        (dumps(child.get("result") or {}), current, str(step["id"]), int(user_id)),
                    )
                    continue
                if child_status == "failed":
                    _advance_action_to_atomic(
                        conn,
                        user_id=int(user_id),
                        action_id=action_id,
                        desired="failed",
                        evidence=evidence,
                        error_code=str(child.get("error") or "crm_child_failed"),
                        billing_adapter=billing_adapter,
                    )
                    conn.execute(
                        "UPDATE crm_workflow_steps SET status='failed',result_json=?,error_code=?,updated_at=? "
                        "WHERE id=? AND user_id=?",
                        (
                            dumps(child.get("result") or {}),
                            str(child.get("error") or "crm_child_failed"),
                            current,
                            str(step["id"]),
                            int(user_id),
                        ),
                    )
                    continue
                if child_status != "cancelled":
                    deferred_action_ids.append(action_id)
                    continue

            transition_action_state_atomic(
                conn,
                user_id=int(user_id),
                action_id=action_id,
                state="skipped",
                evidence={
                    "reason": "schedule_stopped",
                    "social_task_id": social_task_id,
                },
                billing_adapter=billing_adapter,
            )
            if step:
                conn.execute(
                    "UPDATE crm_workflow_steps SET status='cancelled',error_code='schedule_stopped',updated_at=? "
                    "WHERE id=? AND user_id=?",
                    (current, str(step["id"]), int(user_id)),
                )
            cancelled_action_ids.append(action_id)

        conn.execute(
            "UPDATE crm_workflows SET status='paused_by_user',finished_at=0,updated_at=? "
            "WHERE id=? AND user_id=?",
            (current, workflow_id, int(user_id)),
        )
        stopped_workflows.append(
            get_workflow(conn, user_id=int(user_id), workflow_id=workflow_id)
        )

    stopped_schedule = row_public(
        conn.execute(
            "SELECT * FROM crm_schedules WHERE id=? AND user_id=?",
            (clean_schedule_id, int(user_id)),
        ).fetchone()
    ) or {}
    return {
        "schedule": stopped_schedule,
        "workflows": stopped_workflows,
        "cancelled_action_ids": cancelled_action_ids,
        "deferred_action_ids": deferred_action_ids,
        "unsafe_action_ids": unsafe_action_ids,
    }
