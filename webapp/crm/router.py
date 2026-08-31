from __future__ import annotations

import hashlib
import inspect
import json
import os
import re
import shutil
import threading
import time
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Body, Depends, FastAPI, File, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

from webapp.auth import get_current_user, require_admin
from webapp.db import db
from webapp.governance import record_audit

from .errors import CRMError
from .media_sanitize import sanitize_crm_image
from .capabilities import public_capabilities
from .account_rotation import (
    evaluate_sender_rotation_sequence,
    get_sender_rotation_status,
    reset_sender_rotation_status,
)
from .business import (
    add_pool_members,
    deduplicate_pool_members,
    get_resource_detail,
    list_pool_members,
    list_resources_filtered,
    patch_pool_member,
    patch_resource,
    remove_pool_member,
    soft_delete_resource,
)
from .importer import activate_import, dry_run_import, import_root
from .history_cleanup import delete_daily_runs, delete_outreach_campaign, delete_tracking_campaign
from .legacy_operations import (
    Provider,
    TenantContext,
    import_opc_history,
)
from .ai_port import (
    analyze_demand,
    generate_public_comment_drafts,
    generate_targeted_comment_followup,
)
from .opc_live import (
    LiveSearchExecutor,
    query_opc_history_realtime,
    search_hotspots_live,
    search_threads_live,
)
from .preflight import build_preflight, verify_preflight_token
from .platform_extensions import prepare_relationship_verification
from .repository import (
    Adapter,
    RESOURCE_TABLES,
    canonicalize_action,
    cancel_workflow_atomic,
    confirm_workflow_atomic,
    create_resource,
    create_workflow_atomic,
    dispatch_next_action_atomic,
    get_workflow,
    list_resource,
    new_id,
    now_ts,
    row_public,
    retry_workflow_atomic,
    stop_schedule_atomic,
    transition_action_state_atomic,
    update_workflow_status,
    workspace_user_id,
)
from .service import (
    effective_module_state,
    module_settings,
    pause_for_policy,
    require_write_capacity,
    reconcile_workflow,
    set_user_access,
    sync_social_child_tasks,
    update_module_settings,
)
from .tracking import sign_tracking_token, verify_tracking_token

PostCommitCallback = Callable[[dict[str, Any]], Any]

_TRACKING_RATE_LOCK = threading.Lock()
_TRACKING_RATE: dict[str, deque[float]] = defaultdict(deque)
_HEALTH_STATIC_LOCK = threading.Lock()
_HEALTH_STATIC_CACHE: dict[str, Any] = {"checked_at": 0, "static_html": False, "static_assets": False}


def _public_action_evidence(value: Any) -> dict[str, Any]:
    """Expose CRM evidence without leaking container filesystem paths."""

    evidence = dict(value) if isinstance(value, dict) else {}
    nested = dict(evidence.get("result")) if isinstance(evidence.get("result"), dict) else {}
    for container in (evidence, nested):
        path_value = str(
            container.get("screenshot_path")
            or container.get("screenshotPath")
            or ""
        ).strip()
        if path_value and not str(container.get("screenshot_url") or "").strip():
            filename = path_value.replace("\\", "/").rsplit("/", 1)[-1]
            if filename and filename not in {".", ".."}:
                container["screenshot_url"] = (
                    "/api/persona_dashboard/automation/screenshots/"
                    f"{quote(filename, safe='')}"
                )
        container.pop("screenshot_path", None)
        container.pop("screenshotPath", None)
    if nested:
        evidence["result"] = nested
        if not str(evidence.get("screenshot_url") or "").strip() and nested.get("screenshot_url"):
            evidence["screenshot_url"] = nested["screenshot_url"]
    return evidence


def _account_needs_login(status_value: Any, health_value: Any) -> bool:
    status = str(status_value or "").strip().lower()
    health = str(health_value or "").strip().lower()
    return status != "ready" or health in {
        "abnormal", "banned", "needs_login", "cookie_expired",
        "pending_login", "need_verification", "unknown",
    }


def _sample_profile_username(value: Any) -> str:
    """Normalize a public profile handle without accepting path or query data."""

    username = str(value or "").strip().lstrip("@").casefold()
    if not username or len(username) > 80 or re.fullmatch(r"[a-z0-9._]+", username) is None:
        return ""
    return username


def _health_static_checks(static_root: Path, *, current: int) -> dict[str, Any]:
    """Cache immutable build-artifact checks away from the admin health path."""

    with _HEALTH_STATIC_LOCK:
        if current - int(_HEALTH_STATIC_CACHE.get("checked_at") or 0) >= 30:
            html_path = static_root / "crm.html"
            referenced_assets: list[Path] = []
            if html_path.is_file():
                html = html_path.read_text(encoding="utf-8", errors="replace")
                for url in re.findall(r'''(?:src|href)=["']([^"']+)["']''', html):
                    clean = url.split("?", 1)[0].split("#", 1)[0]
                    if clean.startswith("/assets/crm/"):
                        referenced_assets.append(static_root / clean.lstrip("/"))
            _HEALTH_STATIC_CACHE.update({
                "checked_at": current,
                "static_html": html_path.is_file(),
                "static_assets": bool(referenced_assets) and all(path.is_file() for path in referenced_assets),
                "static_asset_count": len(referenced_assets),
                "missing_static_assets": [str(path.relative_to(static_root)).replace("\\", "/") for path in referenced_assets if not path.is_file()],
            })
        return dict(_HEALTH_STATIC_CACHE)


def _normalized_legacy_username(value: Any) -> str:
    return str(value or "").strip().lstrip("@").casefold()


def _legacy_entity_candidates(
    conn: Any,
    *,
    entity_type: str,
    table: str,
    legacy_id: str,
    username: str = "",
) -> dict[int, str]:
    clean_id = str(legacy_id or "").strip()
    if not clean_id:
        return {}
    rows = conn.execute(
        f"""
        SELECT DISTINCT entity.user_id,entity.id,
               {"entity.username" if table == "crm_leads" else "''"} AS entity_username
        FROM {table} entity
        LEFT JOIN crm_legacy_id_map legacy
          ON legacy.entity_id=entity.id AND legacy.user_id=entity.user_id
         AND legacy.entity_type=?
        WHERE entity.active=1
          AND (entity.id=? OR entity.legacy_id=? OR legacy.legacy_id=?)
        """,
        (entity_type, clean_id, clean_id, clean_id),
    ).fetchall()
    requested_username = _normalized_legacy_username(username)
    candidates: dict[int, str] = {}
    for row in rows:
        stored_username = _normalized_legacy_username(row["entity_username"])
        if requested_username and stored_username and requested_username != stored_username:
            continue
        candidates[int(row["user_id"])] = str(row["id"])
    return candidates


def _legacy_destination(conn: Any, *, user_id: int, code: str) -> Any | None:
    normalized_code = str(code or "o").strip().lower()
    if normalized_code not in {"o", "l"}:
        normalized_code = "o"
    rows = conn.execute(
        """
        SELECT * FROM crm_destinations
        WHERE user_id=? AND enabled=1 AND active=1
        ORDER BY updated_at DESC,id
        """,
        (int(user_id),),
    ).fetchall()
    exact: list[Any] = []
    semantic: list[Any] = []
    for row in rows:
        parsed = urlparse(str(row["url"] or ""))
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            continue
        legacy_id = str(row["legacy_id"] or "").strip().lower()
        name = str(row["name"] or "").strip().lower()
        if legacy_id == normalized_code or name == normalized_code:
            exact.append(row)
            continue
        hostname = parsed.hostname.lower().rstrip(".")
        if normalized_code == "l" and (hostname == "line.me" or hostname.endswith(".line.me")):
            semantic.append(row)
        elif normalized_code == "o" and name in {"official", "official account", "official_account", "instagram"}:
            semantic.append(row)
    return (exact or semantic or [None])[0]


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "") or request.headers.get("x-request-id") or new_id("req"))[:128]


def _preflight_secret() -> str:
    """Use a dedicated durable secret, with the tracking secret as a rollout fallback."""

    return str(os.getenv("CRM_PREFLIGHT_SECRET") or os.getenv("CRM_TRACKING_SECRET") or "").strip()


async def crm_error_handler(request: Request, exc: CRMError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.code,
            "message_key": exc.message_key,
            "details": exc.details,
            "request_id": _request_id(request),
            "retryable": exc.retryable,
        },
        headers={"X-CRM-Code": exc.code},
    )


def _identity_is_admin(user: dict[str, Any]) -> bool:
    return bool(int(user.get("is_admin") or 0)) and not bool(user.get("_workspace_user_id"))


def _require_admin_operator(user: dict[str, Any]) -> None:
    if not bool(int(user.get("is_admin") or 0)):
        raise CRMError(
            "crm_admin_required", "crm.errors.adminRequired", status_code=403,
            details={"reasons": ["administrator_required"]},
        )


def _require_effective(conn: Any, user: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    user_id = workspace_user_id(user)
    state = effective_module_state(conn, user_id=user_id, identity_is_admin=_identity_is_admin(user))
    if not state["effective"]:
        raise CRMError(
            "crm_module_unavailable", "crm.errors.moduleUnavailable", status_code=403,
            details={"reasons": state["reasons"]},
        )
    return user_id, state


def _audit_request(conn: Any, request: Request, user: dict[str, Any], action: str, *, target_user_id: int = 0, after: Any = None) -> None:
    record_audit(
        conn,
        actor_user_id=int(user.get("id") or 0),
        target_user_id=int(target_user_id or 0),
        action=action,
        resource_type="crm",
        request_id=_request_id(request),
        ip_address=str(request.client.host if request.client else ""),
        user_agent=str(request.headers.get("user-agent") or ""),
        session_fingerprint=str(getattr(request.state, "auth_session_fingerprint", "") or ""),
        after=after or {},
    )


def _tracking_rate_limit(request: Request) -> None:
    key = str(request.client.host if request.client else "unknown")
    current = time.monotonic()
    with _TRACKING_RATE_LOCK:
        events = _TRACKING_RATE[key]
        while events and events[0] < current - 60:
            events.popleft()
        if len(events) >= 60:
            raise CRMError("crm_tracking_rate_limited", "crm.errors.trackingRateLimited", status_code=429, retryable=True)
        events.append(current)


def _public_tracking_error(status_code: int = 404) -> HTMLResponse:
    # Public tracking failures intentionally share one response. Do not reveal
    # whether a token, tenant, lead, campaign, or legacy mapping existed.
    return HTMLResponse(
        "<!doctype html><html lang='zh-Hans'><meta charset='utf-8'>"
        "<meta name='robots' content='noindex,nofollow'><title>链接不可用</title>"
        "<body><main><h1>链接不可用</h1><p>请向发送方获取新的安全链接。</p></main></body></html>",
        status_code=int(status_code),
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


async def _notify(callback: PostCommitCallback | None, event: dict[str, Any]) -> None:
    if callback is None:
        return
    try:
        result = callback(event)
        if inspect.isawaitable(result):
            await result
    except Exception as exc:
        raise CRMError(
            "crm_wakeup_failed", "crm.errors.wakeupFailed", status_code=503,
            details={"workflow_id": str(event.get("workflow_id") or "")}, retryable=True,
        ) from exc


def _json_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


def _json_values(value: Any) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return list(parsed) if isinstance(parsed, list) else []


def _ai_pool_snapshot(conn: Any, *, user_id: int, pool_id: str) -> dict[str, Any]:
    pool = conn.execute(
        "SELECT * FROM crm_pools WHERE id=? AND user_id=? AND active=1",
        (str(pool_id or "").strip(), int(user_id)),
    ).fetchone()
    if pool is None:
        raise CRMError("crm_pool_not_found", "crm.errors.poolNotFound", status_code=404)
    pool_row = row_public(pool) or {}
    snapshot = dict(pool_row.get("snapshot") or {})
    rows = conn.execute(
        """
        SELECT l.* FROM crm_pool_members AS pm
        JOIN crm_leads AS l ON l.id=pm.lead_id AND l.user_id=pm.user_id
        WHERE pm.user_id=? AND pm.pool_id=? AND pm.active=1 AND l.active=1
        ORDER BY pm.updated_at DESC,l.id DESC LIMIT 5000
        """,
        (int(user_id), str(pool_id)),
    ).fetchall()
    leads: list[dict[str, Any]] = []
    for raw in rows:
        lead_row = row_public(raw) or {}
        profile = dict(lead_row.get("profile") or {})
        source_urls = [
            str(value).strip()
            for value in (
                profile.get("sourceUrl"), profile.get("source_url"), profile.get("postUrl"),
                profile.get("post_url"), profile.get("url"),
            )
            if str(value or "").strip()
        ]
        source_urls.extend(
            str(value).strip() for value in _json_values(profile.get("sourceUrls"))
            if str(value or "").strip()
        )
        leads.append({
            **profile,
            "id": str(lead_row.get("id") or ""),
            "username": str(lead_row.get("username") or profile.get("username") or ""),
            "displayName": str(lead_row.get("display_name") or profile.get("displayName") or ""),
            "platform": str(lead_row.get("platform") or profile.get("platform") or "threads"),
            "text": str(profile.get("text") or profile.get("content") or profile.get("summary") or ""),
            "tags": list(lead_row.get("tags") or []),
            "sourceUrl": source_urls[0] if source_urls else "",
            "sourceUrls": list(dict.fromkeys(source_urls)),
        })
    return {
        **snapshot,
        "id": str(pool_row.get("id") or ""),
        "name": str(pool_row.get("name") or ""),
        "description": str(pool_row.get("description") or ""),
        "tags": list(pool_row.get("tags") or []),
        "businessCategory": str(
            snapshot.get("businessCategory") or snapshot.get("business_category") or "general"
        ),
        "leads": leads,
    }


def _ai_task_snapshots(conn: Any, *, user_id: int, pool_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM crm_workflows WHERE user_id=? AND active=1 ORDER BY updated_at DESC LIMIT 500",
        (int(user_id),),
    ).fetchall()
    tasks: list[dict[str, Any]] = []
    for raw in rows:
        item = row_public(raw) or {}
        input_data = dict(item.get("input") or {})
        legacy = dict(item.get("legacy_payload") or {})
        item_pool_id = str(
            input_data.get("pool_id") or input_data.get("poolId")
            or legacy.get("poolId") or legacy.get("pool_id") or ""
        )
        if item_pool_id != str(pool_id):
            continue
        workflow_type = str(item.get("workflow_type") or legacy.get("type") or "")
        tasks.append({
            **legacy,
            "id": str(item.get("id") or ""),
            "type": "comment" if workflow_type in {"public", "comment", "public_comment"} else workflow_type,
            "poolId": item_pool_id,
            "input": input_data,
            "result": dict(item.get("result") or legacy.get("result") or {}),
        })
    return tasks


def _ai_task_snapshot(conn: Any, *, user_id: int, workflow_id: str) -> dict[str, Any]:
    workflow = get_workflow(conn, user_id=int(user_id), workflow_id=str(workflow_id))
    input_data = dict(workflow.get("input") or {})
    pool_id = str(input_data.get("pool_id") or input_data.get("poolId") or "")
    actions_by_step = {str(action.get("step_id") or ""): action for action in workflow.get("actions") or []}
    items: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for step in workflow.get("steps") or []:
        payload = dict(step.get("payload") or {})
        action = actions_by_step.get(str(step.get("id") or ""), {})
        action_payload = dict(payload.get("payload") or {})
        item_id = str(action.get("id") or step.get("id") or "")
        lead_id = str(action_payload.get("lead_id") or "")
        source_url = str(action_payload.get("target_url") or payload.get("target_key") or "")
        content = str(payload.get("content") or action_payload.get("content") or "")
        items.append({
            "id": item_id,
            "leadId": lead_id,
            "username": str(action_payload.get("recipient") or ""),
            "platform": str(action_payload.get("platform") or "threads"),
            "sourcePostUrl": source_url,
            "comment": content,
        })
        evidence = dict(action.get("evidence") or {})
        evidence_result = dict(evidence.get("result") or {}) if isinstance(evidence.get("result"), dict) else {}
        explicitly_visible = any(
            source.get(key) is True
            for source in (evidence, evidence_result)
            for key in (
                "published", "replied", "verified", "verifiedVisible",
                "platformVisible", "platform_visible", "comment_visible",
            )
        ) or str(action.get("state") or "") == "confirmed"
        results.append({
            "id": item_id,
            "leadId": lead_id,
            "sourcePostUrl": source_url,
            "comment": content,
            "published": explicitly_visible,
            "verifiedVisible": explicitly_visible,
            "replyEvidence": str(
                evidence.get("replyEvidence") or evidence.get("reply_text")
                or evidence_result.get("replyEvidence") or evidence_result.get("reply_text")
                or evidence_result.get("matched_text") or ""
            ),
            "evidence": evidence,
        })
    return {
        "id": str(workflow.get("id") or ""),
        "type": "comment" if str(workflow.get("workflow_type") or "") in {"public", "comment", "public_comment"} else str(workflow.get("workflow_type") or ""),
        "poolId": pool_id,
        "items": items,
        "result": {"results": results},
    }


def create_crm_router(
    *,
    billing_adapter: Adapter | None = None,
    social_task_adapter: Adapter | None = None,
    post_commit_callback: PostCommitCallback | None = None,
    llm_provider: Provider | None = None,
    hotspot_search_provider: Provider | None = None,
    live_search_executor: LiveSearchExecutor | None = None,
    collector_live_search: bool = False,
) -> APIRouter:
    router = APIRouter(tags=["crm"])

    def hydrate_template_snapshot(
        conn: Any,
        *,
        user_id: int,
        action: dict[str, Any],
    ) -> dict[str, Any]:
        """Freeze tenant-owned template media into an executable action.

        The client may edit the copied message before confirmation, so content
        remains action-owned.  Attachments, however, must be resolved from the
        authenticated tenant's template instead of trusting arbitrary ids sent
        by a browser.
        """
        canonical = canonicalize_action(dict(action))
        payload = dict(canonical.get("payload") or {})
        content = str(canonical.get("content") or "")
        action_type = str(canonical.get("action_type") or "")
        if action_type in {"followup_reply", "nurture_reply"}:
            parent_workflow_id = str(payload.get("parent_workflow_id") or "").strip()
            source_action_id = str(payload.get("source_action_id") or "").strip()
            source = conn.execute(
                """
                SELECT a.state,a.action_type,a.target_key,a.payload_json,a.evidence_json
                FROM crm_action_ledger a
                JOIN crm_workflows w ON w.id=a.workflow_id AND w.user_id=a.user_id
                WHERE a.id=? AND a.workflow_id=? AND a.user_id=? AND w.active=1
                """,
                (source_action_id, parent_workflow_id, int(user_id)),
            ).fetchone() if parent_workflow_id and source_action_id else None
            if source is None or str(source["state"] or "") != "confirmed":
                raise CRMError("crm_followup_evidence_required", "crm.errors.followupEvidenceRequired", status_code=409)
            source_evidence = json.loads(str(source["evidence_json"] or "{}"))
            nested_evidence = source_evidence.get("result") if isinstance(source_evidence.get("result"), dict) else {}
            visible = any(
                evidence.get(key) is True
                for evidence in (source_evidence, nested_evidence)
                for key in ("published", "replied", "verified", "verifiedVisible", "platformVisible", "platform_visible", "comment_visible")
            )
            if not visible:
                raise CRMError("crm_followup_evidence_required", "crm.errors.followupEvidenceRequired", status_code=409)
            duplicate = conn.execute(
                """
                SELECT id FROM crm_action_ledger
                WHERE user_id=? AND action_type IN ('followup_reply','nurture_reply')
                  AND state IN ('planned','reserved','submitting','submitted','confirmed','unknown')
                  AND json_extract(payload_json,'$.parent_workflow_id')=?
                  AND json_extract(payload_json,'$.source_action_id')=?
                LIMIT 1
                """,
                (int(user_id), parent_workflow_id, source_action_id),
            ).fetchone()
            if duplicate is not None:
                raise CRMError(
                    "crm_duplicate_followup",
                    "crm.errors.duplicateFollowup",
                    status_code=409,
                    details={"action_id": str(duplicate["id"] or "")},
                )
            source_payload = json.loads(str(source["payload_json"] or "{}"))
            target_url = str(source_payload.get("target_url") or source["target_key"] or "")
            if target_url:
                payload["target_url"] = target_url
                canonical["target_key"] = target_url
            payload["source_action_type"] = str(source["action_type"] or "")
            canonical["payload"] = payload
        if action_type == "direct_message":
            recipient = str(
                payload.get("recipient")
                or payload.get("recipient_username")
                or payload.get("target_username")
                or ""
            ).strip().lstrip("@")
            if recipient:
                content = content.replace("{username}", recipient)
                canonical["content"] = content
                payload["content"] = content
                payload["message"] = content
                canonical["payload"] = payload
            destination_id = str(payload.get("destination_id") or "").strip()
            if destination_id:
                destination = get_resource_detail(conn, "destinations", user_id=int(user_id), record_id=destination_id)
                if not bool(destination.get("enabled")):
                    raise CRMError("crm_tracking_destination_disabled", "crm.errors.trackingDestinationDisabled", status_code=409)
                lead_id = str(payload.get("lead_id") or "").strip()
                campaign_id = str(payload.get("campaign_id") or "").strip()
                if not lead_id or not campaign_id:
                    raise CRMError("crm_tracking_invalid_payload", "crm.errors.trackingInvalidPayload", status_code=400)
                public_base = str(os.getenv("CRM_PUBLIC_BASE_URL", "") or os.getenv("HTTPS_CANONICAL_ORIGIN", "") or "").strip().rstrip("/")
                parsed_base = urlparse(public_base)
                if parsed_base.scheme.lower() != "https" or not parsed_base.hostname:
                    raise CRMError("crm_tracking_unavailable", "crm.errors.trackingUnavailable", status_code=503)
                token = str(payload.get("tracking_token") or "").strip()
                tracking_url = str(payload.get("tracking_url") or "").strip()
                if not token or not tracking_url:
                    token = sign_tracking_token({
                        "user_id": int(user_id), "campaign_id": campaign_id, "lead_id": lead_id,
                        "destination_id": destination_id, "version": 2,
                        "expires_at": now_ts() + max(86400, min(int(payload.get("tracking_ttl_seconds") or 90 * 86400), 365 * 86400)),
                    })
                    tracking_url = f"{public_base}/crm/go/{token}"
                content = content.replace("{tracking_url}", tracking_url) if "{tracking_url}" in content else f"{content.rstrip()}\n{tracking_url}"
                payload.update({"tracking_token": token, "tracking_url": tracking_url, "content": content, "message": content})
                canonical["content"] = content
                canonical["payload"] = payload
        template_id = str(payload.get("template_id") or payload.get("templateId") or "").strip()
        if not template_id:
            return canonical
        template = get_resource_detail(
            conn,
            "templates",
            user_id=int(user_id),
            record_id=template_id,
        )
        media_ids = [
            str(value).strip()
            for value in (template.get("media_ids") or [])
            if str(value or "").strip()
        ]
        if media_ids:
            # Current platform workers support one verified image per action.
            # Preserve the full template snapshot for audit while executing the
            # first attachment exactly as the legacy CRM did.
            payload["media_ids"] = [media_ids[0]]
        else:
            payload.pop("media_id", None)
            payload.pop("media_ids", None)
        payload["template_snapshot"] = {
            "id": template_id,
            "name": str(template.get("name") or ""),
            "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "media_ids": media_ids,
        }
        canonical["payload"] = payload
        return canonical

    @router.get("/api/crm/v1/bootstrap")
    def bootstrap(user: dict[str, Any] = Depends(get_current_user)):
        target_id = workspace_user_id(user)
        with db() as conn:
            state = effective_module_state(conn, user_id=target_id, identity_is_admin=_identity_is_admin(user))
            counts = {}
            accounts: list[dict[str, Any]] = []
            if state["effective"]:
                for resource, table in RESOURCE_TABLES.items():
                    counts[resource] = int(conn.execute(
                        f"SELECT COUNT(*) AS count FROM {table} WHERE user_id = ? AND active = 1",
                        (target_id,),
                    ).fetchone()["count"])
                counts["tasks"] = int(conn.execute(
                    "SELECT COUNT(*) AS count FROM crm_workflows WHERE user_id = ? AND active = 1",
                    (target_id,),
                ).fetchone()["count"])
                account_rows = conn.execute(
                    """
                    SELECT id, username, display_name, platform, status, health_status
                    FROM social_accounts
                    WHERE user_id = ?
                    ORDER BY updated_at DESC, created_at DESC
                    LIMIT 100
                    """,
                    (target_id,),
                ).fetchall()
                accounts = [
                    {
                        "id": str(row["id"] or ""),
                        "username": str(row["username"] or ""),
                        "display_name": str(row["display_name"] or ""),
                        "platform": str(row["platform"] or ""),
                        "status": str(row["status"] or ""),
                        "health_status": str(row["health_status"] or ""),
                        "needs_login": _account_needs_login(row["status"], row["health_status"]),
                    }
                    for row in account_rows
                ]
            return {
                "module": state,
                "workspace": {
                    "user_id": target_id,
                    "username": str(user.get("_workspace_username") or user.get("username") or "").strip(),
                    "managed_by_admin": bool(user.get("_workspace_admin_user_id")),
                    "operator_user_id": int(user.get("_workspace_admin_user_id") or 0) or None,
                },
                "counts": counts,
                "accounts": accounts,
                "capabilities": public_capabilities(),
                "api_version": "v1",
            }

    @router.get("/api/crm/v1/capabilities")
    def capabilities(user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            _require_effective(conn, user)
        return {"items": public_capabilities(), "api_version": "v1"}

    @router.post("/api/crm/v1/demand/analyze")
    def demand_analysis(
        request: Request,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
        tenant = TenantContext(
            target_id,
            str(payload.get("locale") or request.headers.get("accept-language") or "zh-Hans"),
            _request_id(request),
        )
        return analyze_demand(tenant, payload, llm_provider=llm_provider)

    @router.post("/api/crm/v1/comments/drafts")
    def public_comment_drafts(
        request: Request,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        pool_id = str(payload.get("poolId") or payload.get("pool_id") or "").strip()
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            pool = _ai_pool_snapshot(conn, user_id=target_id, pool_id=pool_id)
            tasks = _ai_task_snapshots(conn, user_id=target_id, pool_id=pool_id)
        normalized = {**payload, "poolId": pool_id}
        return generate_public_comment_drafts(
            TenantContext(
                target_id,
                str(payload.get("locale") or request.headers.get("accept-language") or "zh-Hans"),
                _request_id(request),
            ),
            normalized,
            pool=pool,
            tasks=tasks,
            llm_provider=llm_provider,
        )

    @router.post("/api/crm/v1/comments/followup-draft")
    def targeted_comment_followup(
        request: Request,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        workflow_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            task = _ai_task_snapshot(conn, user_id=target_id, workflow_id=workflow_id)
            pool_id = str(task.get("poolId") or "")
            pool = _ai_pool_snapshot(conn, user_id=target_id, pool_id=pool_id) if pool_id else None
        normalized = {**payload, "taskId": workflow_id}
        return generate_targeted_comment_followup(
            TenantContext(
                target_id,
                str(payload.get("locale") or request.headers.get("accept-language") or "zh-Hans"),
                _request_id(request),
            ),
            normalized,
            task=task,
            pool=pool,
            llm_provider=llm_provider,
        )

    @router.post("/api/crm/v1/hotspots/search")
    def hotspot_search(
        request: Request,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
        tenant = TenantContext(
            target_id,
            str(payload.get("locale") or request.headers.get("accept-language") or "zh-Hans"),
            _request_id(request),
        )
        with db() as conn:
            return search_hotspots_live(
                conn,
                tenant,
                payload,
                executor=live_search_executor,
                collector_mode=collector_live_search,
            )

    @router.post("/api/crm/v1/threads/search")
    def threads_search(
        request: Request,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return search_threads_live(
                conn,
                TenantContext(target_id, str(payload.get("locale") or "zh-Hans"), _request_id(request)),
                payload,
                executor=live_search_executor,
                collector_mode=collector_live_search,
            )

    @router.post("/api/crm/v1/collections/sample-inspection", status_code=202)
    async def inspect_collection_samples(
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        """Schedule tenant-scoped profile samples through the existing CRM worker."""

        channel = str(payload.get("channel") or "threads").strip().lower()
        if channel not in {"threads", "instagram"}:
            raise CRMError(
                "crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400,
                details={"field": "channel"},
            )
        raw_usernames = payload.get("usernames")
        if not isinstance(raw_usernames, list):
            raise CRMError(
                "crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400,
                details={"field": "usernames"},
            )
        usernames: list[str] = []
        seen: set[str] = set()
        for value in raw_usernames:
            username = _sample_profile_username(value)
            if username and username not in seen:
                usernames.append(username)
                seen.add(username)
            if len(usernames) >= 10:
                break
        if not usernames:
            raise CRMError(
                "crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400,
                details={"field": "usernames"},
            )

        requested_account_id = str(payload.get("account_id") or payload.get("accountId") or "").strip()
        sender_username = _sample_profile_username(payload.get("sender_username") or payload.get("senderUsername"))
        if not requested_account_id and not sender_username:
            raise CRMError(
                "crm_invalid_field_value", "crm.errors.invalidFieldValue", status_code=400,
                details={"field": "senderUsername"},
            )

        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            if requested_account_id:
                account = conn.execute(
                    "SELECT id,platform,username,status,health_status FROM social_accounts "
                    "WHERE id=? AND user_id=?",
                    (requested_account_id, target_id),
                ).fetchone()
            else:
                account = conn.execute(
                    "SELECT id,platform,username,status,health_status FROM social_accounts "
                    "WHERE user_id=? AND lower(ltrim(username,'@'))=? AND lower(platform)=? "
                    "ORDER BY updated_at DESC,id DESC LIMIT 1",
                    (target_id, sender_username, channel),
                ).fetchone()
            if account is None or str(account["platform"] or "").strip().lower() != channel:
                raise CRMError("crm_account_not_found", "crm.errors.accountNotFound", status_code=404)
            if _account_needs_login(account["status"], account["health_status"]):
                raise CRMError(
                    "crm_account_needs_login", "crm.errors.accountNeedsLogin", status_code=409,
                    details={"account_id": str(account["id"])},
                )

            targets = [
                (
                    f"https://www.threads.com/@{quote(username, safe='._')}"
                    if channel == "threads"
                    else f"https://www.instagram.com/{quote(username, safe='._')}/"
                )
                for username in usernames
            ]
            digest = hashlib.sha256("\n".join(usernames).encode("utf-8")).hexdigest()[:20]
            idempotency_key = str(
                payload.get("idempotency_key")
                or payload.get("idempotencyKey")
                or f"collection-samples:{target_id}:{account['id']}:{channel}:{digest}:{now_ts() // 60}"
            ).strip()
            workflow = create_workflow_atomic(
                conn,
                user_id=target_id,
                workflow_type="collection_sample_inspection",
                title=f"Collection samples · {channel} · {len(usernames)}",
                input_data={
                    "channel": channel,
                    "account_id": str(account["id"]),
                    "sender_username": str(account["username"] or ""),
                    "usernames": usernames,
                },
                idempotency_key=idempotency_key,
                actions=[
                    {
                        "action_type": "collect_profile",
                        "account_id": str(account["id"]),
                        "target_key": target,
                        "write": False,
                        "payload": {"platform": channel, "username": username, "limit": 20, "scroll_times": 1},
                    }
                    for username, target in zip(usernames, targets)
                ],
                social_task_adapter=social_task_adapter,
            )
        await _notify(
            post_commit_callback,
            {"event": "workflow_created", "workflow_id": workflow["id"], "user_id": target_id},
        )
        return {
            "task_id": workflow["id"],
            "status": workflow["status"],
            "idempotency_key": workflow["idempotency_key"],
            "status_url": f"/api/crm/v1/tasks/{workflow['id']}",
            "channel": channel,
            "requested": len(usernames),
            "usernames": usernames,
        }

    @router.post("/api/crm/v1/opc/history/query")
    def opc_history_query(
        request: Request,
        payload: dict[str, Any] = Body(default={}),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return query_opc_history_realtime(
                conn,
                TenantContext(target_id, str(payload.get("locale") or "zh-Hans"), _request_id(request)),
                payload,
            )

    @router.post("/api/crm/v1/opc/history/import", status_code=201)
    def opc_history_import(
        request: Request,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        require_write_capacity()
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return import_opc_history(
                conn,
                TenantContext(target_id, str(payload.get("locale") or "zh-Hans"), _request_id(request)),
                payload,
            )

    def list_handler(resource: str):
        def handler(
            request: Request,
            limit: int = Query(default=50, ge=1, le=200),
            cursor: str = Query(default="", max_length=1024),
            user: dict[str, Any] = Depends(get_current_user),
        ):
            filters = {
                key: value
                for key, value in request.query_params.multi_items()
                if key not in {"limit", "cursor"}
            }
            with db() as conn:
                target_id, _ = _require_effective(conn, user)
                return list_resources_filtered(
                    conn, resource, user_id=target_id, filters=filters, limit=limit, cursor=cursor,
                )
        return handler

    def create_handler(resource: str):
        def handler(payload: dict[str, Any] = Body(...), user: dict[str, Any] = Depends(get_current_user)):
            with db() as conn:
                target_id, _ = _require_effective(conn, user)
                normalized = dict(payload)
                if resource == "schedules":
                    schedule_payload = dict(payload.get("payload") or {})
                    raw_actions = schedule_payload.get("actions")
                    if not isinstance(raw_actions, list) or not raw_actions:
                        raise CRMError(
                            "crm_schedule_actions_required",
                            "crm.errors.scheduleActionsRequired",
                            status_code=400,
                        )
                    actions = [
                        hydrate_template_snapshot(conn, user_id=target_id, action=dict(item))
                        for item in raw_actions
                        if isinstance(item, dict)
                    ]
                    if len(actions) != len(raw_actions):
                        raise CRMError(
                            "crm_invalid_action",
                            "crm.errors.invalidAction",
                            status_code=400,
                        )
                    schedule_payload["actions"] = actions
                    # A scheduled write may reuse the explicit confirmation
                    # made while creating the schedule, but the actor id and
                    # approved target hash always come from the authenticated
                    # server context rather than arbitrary client data.
                    schedule_payload.pop("confirmed_by", None)
                    schedule_payload.pop("confirmation_hash", None)
                    contains_write = any(bool(action.get("write")) for action in actions)
                    if contains_write:
                        if schedule_payload.get("confirmed") is not True:
                            raise CRMError(
                                "crm_confirmation_required",
                                "crm.errors.confirmationRequired",
                                status_code=409,
                            )
                        verify_preflight_token(
                            str(schedule_payload.pop("preflight_token", "") or ""),
                            secret=_preflight_secret(),
                            user_id=target_id,
                            actions=actions,
                        )
                        schedule_payload["confirmed_by"] = int(user.get("id") or 0)
                        schedule_payload["confirmed_at"] = now_ts()
                        schedule_payload["allowed_count"] = len(actions)
                        schedule_payload["confirmation_hash"] = hashlib.sha256(
                            json.dumps(actions, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                        ).hexdigest()
                    else:
                        schedule_payload.pop("preflight_token", None)
                    normalized["payload"] = schedule_payload
                created = create_resource(conn, resource, user_id=target_id, payload=normalized)
                if resource == "templates" and bool(created.get("is_default")):
                    conn.execute(
                        "UPDATE crm_templates SET is_default=0,updated_at=? "
                        "WHERE user_id=? AND template_type=? AND locale=? AND id<>? AND active=1",
                        (
                            now_ts(),
                            int(target_id),
                            str(created.get("template_type") or ""),
                            str(created.get("locale") or ""),
                            str(created.get("id") or ""),
                        ),
                    )
                return created
        return handler

    def detail_handler(resource: str):
        def handler(record_id: str, user: dict[str, Any] = Depends(get_current_user)):
            with db() as conn:
                target_id, _ = _require_effective(conn, user)
                return get_resource_detail(conn, resource, user_id=target_id, record_id=record_id)
        return handler

    def patch_handler(resource: str):
        def handler(
            record_id: str,
            payload: dict[str, Any] = Body(...),
            user: dict[str, Any] = Depends(get_current_user),
        ):
            with db() as conn:
                target_id, _ = _require_effective(conn, user)
                normalized_patch = dict(payload)
                if resource == "schedules":
                    if "next_run_at" in normalized_patch:
                        next_run_at = int(normalized_patch.get("next_run_at") or 0)
                        if next_run_at and next_run_at <= now_ts() + 60:
                            raise CRMError(
                                "crm_schedule_time_invalid",
                                "crm.errors.scheduleTimeInvalid",
                                status_code=400,
                            )
                    if "workflow_type" in normalized_patch and "payload" not in normalized_patch:
                        raise CRMError(
                            "crm_schedule_actions_required",
                            "crm.errors.scheduleActionsRequired",
                            status_code=400,
                        )
                    if "payload" in normalized_patch:
                        schedule_payload = dict(normalized_patch.get("payload") or {})
                        raw_actions = schedule_payload.get("actions")
                        if not isinstance(raw_actions, list) or not raw_actions:
                            raise CRMError(
                                "crm_schedule_actions_required",
                                "crm.errors.scheduleActionsRequired",
                                status_code=400,
                            )
                        actions = [
                            hydrate_template_snapshot(conn, user_id=target_id, action=dict(item))
                            for item in raw_actions
                            if isinstance(item, dict)
                        ]
                        if len(actions) != len(raw_actions):
                            raise CRMError("crm_invalid_action", "crm.errors.invalidAction", status_code=400)
                        schedule_payload["actions"] = actions
                        schedule_payload.pop("confirmed_by", None)
                        schedule_payload.pop("confirmation_hash", None)
                        if any(bool(action.get("write")) for action in actions):
                            if schedule_payload.get("confirmed") is not True:
                                raise CRMError(
                                    "crm_confirmation_required",
                                    "crm.errors.confirmationRequired",
                                    status_code=409,
                                )
                            verify_preflight_token(
                                str(schedule_payload.pop("preflight_token", "") or ""),
                                secret=_preflight_secret(),
                                user_id=target_id,
                                actions=actions,
                            )
                            schedule_payload["confirmed_by"] = int(user.get("id") or 0)
                            schedule_payload["confirmed_at"] = now_ts()
                            schedule_payload["allowed_count"] = len(actions)
                            schedule_payload["confirmation_hash"] = hashlib.sha256(
                                json.dumps(actions, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                            ).hexdigest()
                        else:
                            schedule_payload.pop("preflight_token", None)
                        normalized_patch["payload"] = schedule_payload
                updated = patch_resource(conn, resource, user_id=target_id, record_id=record_id, payload=normalized_patch)
                if resource == "templates" and bool(updated.get("is_default")):
                    conn.execute(
                        "UPDATE crm_templates SET is_default=0,updated_at=? "
                        "WHERE user_id=? AND template_type=? AND locale=? AND id<>? AND active=1",
                        (
                            now_ts(),
                            int(target_id),
                            str(updated.get("template_type") or ""),
                            str(updated.get("locale") or ""),
                            str(updated.get("id") or ""),
                        ),
                    )
                return updated
        return handler

    def delete_handler(resource: str):
        def handler(record_id: str, user: dict[str, Any] = Depends(get_current_user)):
            removable_path = ""
            target_id = 0
            with db() as conn:
                target_id, _ = _require_effective(conn, user)
                if resource == "media":
                    referenced = conn.execute(
                        """
                        SELECT template.id
                        FROM crm_templates template, json_each(template.media_ids_json) media_ref
                        WHERE template.user_id=? AND template.active=1 AND media_ref.value=?
                        LIMIT 1
                        """,
                        (target_id, str(record_id)),
                    ).fetchone()
                    if referenced is not None:
                        raise CRMError(
                            "crm_media_in_use", "crm.errors.mediaInUse", status_code=409,
                            details={"template_id": str(referenced["id"])},
                        )
                deleted = soft_delete_resource(conn, resource, user_id=target_id, record_id=record_id)
                if resource == "media":
                    candidate = str(deleted.get("storage_path") or "")
                    still_used = conn.execute(
                        "SELECT 1 FROM crm_media WHERE user_id=? AND storage_path=? AND active=1 LIMIT 1",
                        (target_id, candidate),
                    ).fetchone()
                    if still_used is None:
                        removable_path = candidate
            if removable_path:
                data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()
                tenant_root = (data_dir / "crm_media" / str(target_id)).resolve()
                path = (data_dir / removable_path).resolve()
                try:
                    path.relative_to(tenant_root)
                except ValueError:
                    pass
                else:
                    if path.is_file() and not path.is_symlink():
                        try:
                            path.unlink(missing_ok=True)
                        except OSError:
                            # The database deletion remains authoritative; the
                            # CRM retention pass can retry orphan cleanup.
                            pass
            return deleted
        return handler

    for resource in RESOURCE_TABLES:
        router.add_api_route(f"/api/crm/v1/{resource}", list_handler(resource), methods=["GET"], name=f"crm_list_{resource}")
        if resource != "media":
            router.add_api_route(f"/api/crm/v1/{resource}", create_handler(resource), methods=["POST"], name=f"crm_create_{resource}")

        router.add_api_route(f"/api/crm/v1/{resource}/{{record_id}}", detail_handler(resource), methods=["GET"], name=f"crm_get_{resource}")
        router.add_api_route(f"/api/crm/v1/{resource}/{{record_id}}", patch_handler(resource), methods=["PATCH"], name=f"crm_patch_{resource}")
        router.add_api_route(f"/api/crm/v1/{resource}/{{record_id}}", delete_handler(resource), methods=["DELETE"], name=f"crm_delete_{resource}")

    @router.get("/api/crm/v1/pools/{pool_id}/members")
    def pool_members(
        request: Request,
        pool_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        cursor: str = Query(default="", max_length=1024),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        filters = {
            key: value
            for key, value in request.query_params.multi_items()
            if key not in {"limit", "cursor"}
        }
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return list_pool_members(
                conn, user_id=target_id, pool_id=pool_id, filters=filters, limit=limit, cursor=cursor,
            )

    @router.post("/api/crm/v1/pools/{pool_id}/members")
    def add_members(
        pool_id: str,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        lead_ids = payload.get("lead_ids")
        if not isinstance(lead_ids, list):
            raise CRMError("crm_invalid_pool_members", "crm.errors.invalidPoolMembers", status_code=400)
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return add_pool_members(
                conn,
                user_id=target_id,
                pool_id=pool_id,
                lead_ids=[str(item) for item in lead_ids],
                status=str(payload.get("status") or "active"),
                source=str(payload.get("source") or ""),
            )

    @router.patch("/api/crm/v1/pools/{pool_id}/members/{lead_id}")
    def update_member(
        pool_id: str,
        lead_id: str,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return patch_pool_member(
                conn, user_id=target_id, pool_id=pool_id, lead_id=lead_id, payload=payload,
            )

    @router.delete("/api/crm/v1/pools/{pool_id}/members/{lead_id}")
    def delete_member(
        pool_id: str,
        lead_id: str,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return remove_pool_member(conn, user_id=target_id, pool_id=pool_id, lead_id=lead_id)

    @router.post("/api/crm/v1/pools/{pool_id}/members/deduplicate")
    def deduplicate_members(pool_id: str, user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return deduplicate_pool_members(conn, user_id=target_id, pool_id=pool_id)

    @router.post("/api/crm/v1/relationships/verify", status_code=202)
    async def verify_relationships(
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        require_write_capacity()
        idempotency_key = str(payload.get("idempotency_key") or "").strip()
        if not idempotency_key:
            raise CRMError(
                "crm_invalid_idempotency_key", "crm.errors.invalidIdempotencyKey", status_code=400,
            )
        lead_ids = payload.get("lead_ids")
        if not isinstance(lead_ids, list):
            raise CRMError(
                "crm_invalid_relationship_target_count",
                "crm.errors.invalidRelationshipTargetCount",
                status_code=400,
            )
        from webapp.social_automation_api import SOCIAL_TASK_TYPES

        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            prepared = prepare_relationship_verification(
                conn,
                user_id=target_id,
                account_id=str(payload.get("account_id") or ""),
                lead_ids=[str(item) for item in lead_ids],
                supported_task_types=SOCIAL_TASK_TYPES,
            )
            target_hash = hashlib.sha256(
                json.dumps(prepared["payload"]["lead_ids"], separators=(",", ":")).encode("utf-8")
            ).hexdigest()[:24]
            workflow = create_workflow_atomic(
                conn,
                user_id=target_id,
                workflow_type="relationship_verify",
                title=str(payload.get("title") or "Instagram relationship verification"),
                input_data={
                    "account_id": prepared["account_id"],
                    "lead_ids": list(prepared["payload"]["lead_ids"]),
                },
                idempotency_key=idempotency_key,
                actions=[{
                    "action_type": "relationship_verify",
                    "account_id": prepared["account_id"],
                    "target_key": f"instagram-relationship:{prepared['account_id']}:{target_hash}",
                    "payload": prepared["payload"],
                }],
                social_task_adapter=social_task_adapter,
            )
        await _notify(
            post_commit_callback,
            {"event": "workflow_created", "workflow_id": workflow["id"], "user_id": target_id},
        )
        return {
            "task_id": workflow["id"],
            "status": workflow["status"],
            "idempotency_key": workflow["idempotency_key"],
            "status_url": f"/api/crm/v1/tasks/{workflow['id']}",
        }

    @router.delete("/api/crm/v1/tracking-events")
    def delete_tracking_events(
        campaign_id: str = Query(..., min_length=1, max_length=120),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return delete_tracking_campaign(conn, user_id=target_id, campaign_id=campaign_id)

    @router.delete("/api/crm/v1/outreach-events")
    def delete_outreach_events(
        campaign_id: str = Query(..., min_length=1, max_length=120),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return delete_outreach_campaign(conn, user_id=target_id, campaign_id=campaign_id)

    @router.delete("/api/crm/v1/daily-runs")
    def remove_daily_runs(
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        workflow_ids = payload.get("ids")
        if not isinstance(workflow_ids, list):
            raise CRMError(
                "crm_daily_run_ids_invalid", "crm.errors.dailyRunIdsInvalid", status_code=400,
            )
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return delete_daily_runs(conn, user_id=target_id, workflow_ids=workflow_ids)

    @router.post("/api/crm/v1/schedules/{schedule_id}/run", status_code=202)
    async def run_schedule_now(
        schedule_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        require_write_capacity()
        request_payload = dict(payload or {})
        confirmed = request_payload.get("confirmed", False)
        if not isinstance(confirmed, bool):
            raise CRMError("crm_invalid_confirmation", "crm.errors.invalidConfirmation", status_code=400)
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            schedule = get_resource_detail(
                conn, "schedules", user_id=target_id, record_id=schedule_id,
            )
            schedule_payload = schedule.get("payload") if isinstance(schedule.get("payload"), dict) else {}
            raw_actions = schedule_payload.get("actions") if isinstance(schedule_payload.get("actions"), list) else []
            actions = [canonicalize_action(dict(item)) for item in raw_actions if isinstance(item, dict)]
            if not actions or len(actions) != len(raw_actions):
                raise CRMError(
                    "crm_schedule_actions_required",
                    "crm.errors.scheduleActionsRequired",
                    status_code=409,
                )
            if any(bool(action.get("write")) for action in actions):
                if confirmed is not True:
                    raise CRMError(
                        "crm_confirmation_required",
                        "crm.errors.confirmationRequired",
                        status_code=409,
                    )
                verify_preflight_token(
                    str(request_payload.get("preflight_token") or ""),
                    secret=_preflight_secret(),
                    user_id=target_id,
                    actions=actions,
                )
            current = now_ts()
            workflow = create_workflow_atomic(
                conn,
                user_id=target_id,
                workflow_type=str(schedule.get("workflow_type") or "scheduled"),
                title=str(schedule_payload.get("title") or f"Scheduled CRM workflow {schedule_id}"),
                input_data=dict(schedule_payload.get("input") or {}),
                idempotency_key=str(
                    request_payload.get("idempotency_key")
                    or f"crm-schedule-manual:{schedule_id}:{current // 60}"
                ),
                schedule_id=str(schedule_id),
                actions=actions,
                confirmed_by=int(user.get("id") or 0) if confirmed else 0,
                billing_adapter=billing_adapter,
                social_task_adapter=social_task_adapter,
            )
            conn.execute(
                "UPDATE crm_schedules SET last_run_at=?,updated_at=? WHERE id=? AND user_id=?",
                (current, current, str(schedule_id), target_id),
            )
        await _notify(
            post_commit_callback,
            {"event": "workflow_created", "workflow_id": workflow["id"], "user_id": target_id},
        )
        return {
            "task_id": workflow["id"],
            "status": workflow["status"],
            "idempotency_key": workflow["idempotency_key"],
            "status_url": f"/api/crm/v1/tasks/{workflow['id']}",
        }

    @router.post("/api/crm/v1/schedules/{schedule_id}/stop")
    async def stop_schedule(
        schedule_id: str,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            result = stop_schedule_atomic(
                conn,
                user_id=target_id,
                schedule_id=schedule_id,
                billing_adapter=billing_adapter,
                social_task_adapter=social_task_adapter,
            )
        await _notify(
            post_commit_callback,
            {
                "event": "schedule_stopped",
                "schedule_id": str(schedule_id),
                "user_id": target_id,
                "workflow_ids": [str(item.get("id") or "") for item in result["workflows"]],
            },
        )
        return {
            "schedule_id": str(schedule_id),
            "status": "stopped",
            **result,
        }

    @router.post("/api/crm/v1/media", status_code=201)
    async def upload_media(
        upload: UploadFile = File(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        require_write_capacity()
        extension_map = {
            ".jpg": {"image/jpeg"}, ".jpeg": {"image/jpeg"}, ".png": {"image/png"},
            ".webp": {"image/webp"}, ".gif": {"image/gif"},
        }
        original_name = Path(str(upload.filename or "upload")).name
        suffix = Path(original_name).suffix.lower()
        content_type = str(upload.content_type or "").lower()
        if suffix not in extension_map or content_type not in extension_map[suffix]:
            raise CRMError("crm_media_type_not_allowed", "crm.errors.mediaTypeNotAllowed", status_code=415)
        max_bytes = max(int(os.getenv("CRM_MEDIA_MAX_BYTES", str(20 * 1024 * 1024)) or 0), 1024)
        user_quota = max(int(os.getenv("CRM_MEDIA_USER_QUOTA_BYTES", str(500 * 1024 * 1024)) or 0), max_bytes)
        data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            used = int(conn.execute(
                "SELECT COALESCE(SUM(size_bytes),0) FROM crm_media WHERE user_id=? AND active=1",
                (target_id,),
            ).fetchone()[0])
        target_dir = (data_dir / "crm_media" / str(target_id)).resolve()
        target_dir.mkdir(parents=True, exist_ok=True)
        temp_path = target_dir / f".upload-{uuid.uuid4().hex}.tmp"
        digest = hashlib.sha256()
        size = 0
        try:
            with temp_path.open("xb") as stream:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise CRMError("crm_media_too_large", "crm.errors.mediaTooLarge", status_code=413, details={"max_bytes": max_bytes})
                    if used + size > user_quota:
                        raise CRMError("crm_media_quota_exceeded", "crm.errors.mediaQuotaExceeded", status_code=409, details={"quota_bytes": user_quota})
                    digest.update(chunk)
                    stream.write(chunk)
            try:
                cleaned, content_type, suffix = sanitize_crm_image(temp_path)
            except CRMError:
                raise
            except Exception as exc:
                raise CRMError("crm_media_decode_failed", "crm.errors.mediaDecodeFailed", status_code=422) from exc
            temp_path.write_bytes(cleaned)
            size = len(cleaned)
            digest = hashlib.sha256(cleaned)
            sha256 = digest.hexdigest()
            final_path = target_dir / f"{sha256}{suffix}"
            relative_path = final_path.relative_to(data_dir).as_posix()
            with db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                target_id_again, _ = _require_effective(conn, user)
                if target_id_again != target_id:
                    raise CRMError("crm_workspace_changed", "crm.errors.workspaceChanged", status_code=409)
                current_used = int(conn.execute(
                    "SELECT COALESCE(SUM(size_bytes),0) FROM crm_media WHERE user_id=? AND active=1",
                    (target_id,),
                ).fetchone()[0])
                if current_used + size > user_quota:
                    raise CRMError("crm_media_quota_exceeded", "crm.errors.mediaQuotaExceeded", status_code=409, details={"quota_bytes": user_quota})
                existing = conn.execute(
                    "SELECT * FROM crm_media WHERE user_id=? AND sha256=? AND active=1",
                    (target_id, sha256),
                ).fetchone()
                if existing is not None:
                    return row_public(existing)
                os.replace(temp_path, final_path)
                try:
                    return create_resource(
                        conn,
                        "media",
                        user_id=target_id,
                        payload={
                            "storage_path": relative_path, "sha256": sha256, "mime_type": content_type,
                            "size_bytes": size, "original_name": original_name,
                        },
                    )
                except Exception:
                    final_path.unlink(missing_ok=True)
                    raise
        finally:
            await upload.close()
            temp_path.unlink(missing_ok=True)

    @router.get("/api/crm/v1/media/{media_id}/content")
    def media_content(media_id: str, user: dict[str, Any] = Depends(get_current_user)):
        data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            media = get_resource_detail(conn, "media", user_id=target_id, record_id=media_id)
        tenant_root = (data_dir / "crm_media" / str(target_id)).resolve()
        path = (data_dir / str(media.get("storage_path") or "")).resolve()
        try:
            path.relative_to(tenant_root)
        except ValueError as exc:
            raise CRMError("crm_media_path_invalid", "crm.errors.mediaPathInvalid", status_code=409) from exc
        if not path.is_file() or path.is_symlink():
            raise CRMError("crm_media_not_found", "crm.errors.mediaNotFound", status_code=404)
        return FileResponse(
            path,
            media_type=str(media.get("mime_type") or "application/octet-stream"),
            headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"},
        )

    @router.get("/api/crm/v1/tasks")
    def list_tasks(
        limit: int = Query(default=50, ge=1, le=200),
        cursor: str = Query(default="", max_length=1024),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            # Workflows use the same cursor contract as the other resources.
            from .repository import decode_cursor, encode_cursor, list_select_sql, row_public_list

            page_size = min(max(int(limit), 1), 200)
            params: list[Any] = [target_id]
            condition = ""
            if cursor:
                updated_at, record_id = decode_cursor(cursor)
                condition = " AND (updated_at < ? OR (updated_at = ? AND id < ?))"
                params.extend((updated_at, updated_at, record_id))
            params.append(page_size + 1)
            rows = conn.execute(
                "SELECT " + list_select_sql(conn, "crm_workflows") +
                " FROM crm_workflows WHERE user_id = ? AND active = 1" + condition +
                " ORDER BY updated_at DESC,id DESC LIMIT ?",
                tuple(params),
            ).fetchall()
            visible = rows[:page_size]
            return {
                "items": [row_public_list(row) for row in visible],
                "has_more": len(rows) > page_size,
                "next_cursor": encode_cursor(int(visible[-1]["updated_at"]), str(visible[-1]["id"])) if len(rows) > page_size and visible else "",
                "limit": page_size,
            }

    @router.post("/api/crm/v1/preflight")
    def preflight(
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        actions = payload.get("actions")
        if not isinstance(actions, list):
            raise CRMError("crm_invalid_action_count", "crm.errors.invalidActionCount", status_code=400)
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            hydrated = [
                hydrate_template_snapshot(conn, user_id=target_id, action=dict(item))
                for item in actions
                if isinstance(item, dict)
            ]
            return build_preflight(
                conn,
                user_id=target_id,
                actions=hydrated,
                secret=_preflight_secret(),
            )

    @router.post("/api/crm/v1/tasks", status_code=202)
    async def create_task(
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        require_write_capacity()
        confirmed = payload.get("confirmed", False)
        if not isinstance(confirmed, bool):
            raise CRMError("crm_invalid_confirmation", "crm.errors.invalidConfirmation", status_code=400)
        raw_actions = payload.get("actions") if isinstance(payload.get("actions"), list) else []
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            canonical_actions = [
                hydrate_template_snapshot(conn, user_id=target_id, action=dict(item))
                for item in raw_actions
                if isinstance(item, dict)
            ]
            if not canonical_actions or len(canonical_actions) != len(raw_actions):
                raise CRMError(
                    "crm_invalid_action_count",
                    "crm.errors.invalidActionCount",
                    status_code=400,
                )
            if any(bool(action.get("write")) for action in canonical_actions):
                verify_preflight_token(
                    str(payload.get("preflight_token") or ""),
                    secret=_preflight_secret(),
                    user_id=target_id,
                    actions=canonical_actions,
                )
            workflow = create_workflow_atomic(
                conn,
                user_id=target_id,
                workflow_type=str(payload.get("workflow_type") or payload.get("type") or "generic"),
                title=str(payload.get("title") or ""),
                input_data=dict(payload.get("input") or {}),
                idempotency_key=str(payload.get("idempotency_key") or ""),
                actions=canonical_actions,
                confirmed_by=int(user.get("id") or 0) if confirmed else 0,
                billing_adapter=billing_adapter,
                social_task_adapter=social_task_adapter,
            )
        await _notify(post_commit_callback, {"event": "workflow_created", "workflow_id": workflow["id"], "user_id": target_id})
        return {
            "task_id": workflow["id"],
            "status": workflow["status"],
            "idempotency_key": workflow["idempotency_key"],
            "status_url": f"/api/crm/v1/tasks/{workflow['id']}",
        }

    @router.get("/api/crm/v1/tasks/{workflow_id}")
    def task_detail(workflow_id: str, user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            workflow = get_workflow(conn, user_id=target_id, workflow_id=workflow_id)
            workflow["evidence"] = [
                {
                    "action_id": item["id"],
                    "state": item["state"],
                    "evidence": _public_action_evidence(item.get("evidence")),
                    "review_required": str(item.get("state") or "") == "unknown",
                }
                for item in workflow["actions"]
            ]
            return workflow

    @router.delete("/api/crm/v1/tasks/{workflow_id}")
    def delete_task(
        workflow_id: str,
        request: Request,
        payload: dict[str, Any] = Body(default={}),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        if payload.get("confirmed") is not True:
            raise CRMError(
                "crm_delete_confirmation_required",
                "crm.errors.deleteConfirmationRequired",
                status_code=409,
            )
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            target_id, _ = _require_effective(conn, user)
            workflow = get_workflow(conn, user_id=target_id, workflow_id=workflow_id)
            status = str(workflow.get("status") or "")
            if status not in {"completed", "failed", "cancelled"}:
                raise CRMError(
                    "crm_task_not_deletable",
                    "crm.errors.taskNotDeletable",
                    status_code=409,
                    details={"status": status},
                )
            if status in {"failed", "cancelled"}:
                # Sequential workflows never dispatch later planned actions
                # after a terminal failure/cancel.  Close those untouched
                # ledger rows as skipped so the audit remains explicit and the
                # terminal parent can be archived like the legacy CRM task.
                conn.execute(
                    "UPDATE crm_action_ledger SET state='skipped',updated_at=? "
                    "WHERE workflow_id=? AND user_id=? AND state='planned'",
                    (now_ts(), str(workflow_id), int(target_id)),
                )
                workflow = get_workflow(conn, user_id=target_id, workflow_id=workflow_id)
            unfinished = [
                str(action.get("state") or "")
                for action in workflow.get("actions") or []
                if str(action.get("state") or "") not in {"confirmed", "failed", "skipped"}
            ]
            if unfinished:
                raise CRMError(
                    "crm_task_has_unresolved_actions",
                    "crm.errors.taskHasUnresolvedActions",
                    status_code=409,
                    details={"states": sorted(set(unfinished))},
                )
            create_resource(
                conn,
                "events",
                user_id=target_id,
                payload={
                    "workflow_id": workflow_id,
                    "event_type": "workflow_deleted",
                    "occurred_at": now_ts(),
                    "payload": {"previous_status": status},
                },
            )
            deleted_at = now_ts()
            conn.execute(
                "UPDATE crm_workflows SET active=0,updated_at=? WHERE id=? AND user_id=? AND active=1",
                (deleted_at, str(workflow_id), int(target_id)),
            )
            _audit_request(
                conn,
                request,
                user,
                "crm.workflow.delete",
                target_user_id=target_id,
                after={"workflow_id": workflow_id, "previous_status": status},
            )
            return {"task_id": workflow_id, "status": "deleted", "deleted_at": deleted_at}

    @router.post("/api/crm/v1/tasks/{workflow_id}/{operation}")
    async def task_operation(
        workflow_id: str,
        operation: str,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        if operation not in {"start", "resume", "pause", "cancel", "retry", "takeover", "reconcile", "confirm"}:
            raise CRMError("crm_unknown_task_operation", "crm.errors.unknownTaskOperation", status_code=404)
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            if operation == "cancel":
                updated = cancel_workflow_atomic(
                    conn, user_id=target_id, workflow_id=workflow_id,
                    billing_adapter=billing_adapter, social_task_adapter=social_task_adapter,
                )
            elif operation == "reconcile":
                updated = sync_social_child_tasks(
                    conn,
                    user_id=target_id,
                    workflow_id=workflow_id,
                    billing_adapter=billing_adapter,
                    social_task_adapter=social_task_adapter,
                )["workflow"]
            elif operation == "confirm":
                updated = confirm_workflow_atomic(
                    conn,
                    user_id=target_id,
                    workflow_id=workflow_id,
                    confirmed_by=int(user.get("id") or 0),
                    billing_adapter=billing_adapter,
                    social_task_adapter=social_task_adapter,
                )
            elif operation == "retry":
                updated = retry_workflow_atomic(
                    conn,
                    user_id=target_id,
                    workflow_id=workflow_id,
                    idempotency_key=str((payload or {}).get("idempotency_key") or ""),
                    confirmed_by=int(user.get("id") or 0),
                    billing_adapter=billing_adapter,
                    social_task_adapter=social_task_adapter,
                )
            elif operation == "pause":
                updated = update_workflow_status(
                    conn, user_id=target_id, workflow_id=workflow_id, status="paused_by_user",
                )
            elif operation in {"start", "resume"}:
                current = get_workflow(conn, user_id=target_id, workflow_id=workflow_id)
                current_status = str(current.get("status") or "")
                if operation == "start" and current_status == "queued":
                    # Idempotent wake-up for clients that use start both to
                    # start and resume; the Worker remains the source of
                    # truth for the running state.
                    updated = current
                elif current_status in {"paused_by_user", "paused_by_policy"}:
                    updated = update_workflow_status(
                        conn, user_id=target_id, workflow_id=workflow_id, status="queued",
                    )
                else:
                    raise CRMError(
                        "crm_task_not_resumable", "crm.errors.taskNotResumable", status_code=409,
                        details={"status": current_status, "operation": operation},
                    )
            elif operation == "takeover":
                # A browser/session adapter creates manual_required.  A client
                # may open that takeover, but may never assign the state itself.
                updated = get_workflow(conn, user_id=target_id, workflow_id=workflow_id)
                if str(updated.get("status") or "") != "manual_required":
                    raise CRMError(
                        "crm_task_not_manual", "crm.errors.taskNotManual", status_code=409,
                        details={"status": str(updated.get("status") or "")},
                    )
            else:
                raise CRMError("crm_unknown_task_operation", "crm.errors.unknownTaskOperation", status_code=404)
        notified_workflow_id = str(updated.get("id") or workflow_id)
        await _notify(post_commit_callback, {"event": f"workflow_{operation}", "workflow_id": notified_workflow_id, "user_id": target_id})
        return updated

    @router.post("/api/crm/v1/tasks/{workflow_id}/actions/{action_id}/review")
    def review_action(
        workflow_id: str,
        action_id: str,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        desired = str(payload.get("state") or "")
        if desired not in {"confirmed", "failed"}:
            raise CRMError("crm_invalid_review_state", "crm.errors.invalidReviewState", status_code=400)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            target_id, _ = _require_effective(conn, user)
            owner = conn.execute(
                "SELECT state FROM crm_action_ledger WHERE id=? AND workflow_id=? AND user_id=?",
                (action_id, workflow_id, target_id),
            ).fetchone()
            if owner is None:
                raise CRMError("crm_action_not_found", "crm.errors.actionNotFound", status_code=404)
            if str(owner["state"] or "") != "unknown":
                raise CRMError(
                    "crm_action_review_required", "crm.errors.actionReviewRequired", status_code=409,
                    details={"state": str(owner["state"] or "")},
                )
            action = transition_action_state_atomic(
                conn,
                user_id=target_id,
                action_id=action_id,
                state=desired,
                evidence=dict(payload.get("evidence") or {}),
                error_code=str(payload.get("error_code") or ""),
                manual_review=True,
                billing_adapter=billing_adapter,
            )
            workflow = reconcile_workflow(conn, user_id=target_id, workflow_id=workflow_id)
            if str(workflow.get("status") or "") in {"queued", "running"}:
                workflow = dispatch_next_action_atomic(
                    conn,
                    user_id=target_id,
                    workflow_id=workflow_id,
                    billing_adapter=billing_adapter,
                    social_task_adapter=social_task_adapter,
                )
                workflow = reconcile_workflow(conn, user_id=target_id, workflow_id=workflow_id)
            return {"action": action, "workflow": workflow}

    @router.get("/api/crm/v1/tasks/{workflow_id}/evidence")
    def task_evidence(workflow_id: str, user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            workflow = get_workflow(conn, user_id=target_id, workflow_id=workflow_id)
            return {
                "task_id": workflow_id,
                "items": [
                    {
                        "action_id": item["id"],
                        "state": item["state"],
                        "evidence": _public_action_evidence(item.get("evidence")),
                    }
                    for item in workflow["actions"]
                ],
            }

    @router.get("/api/crm/v1/accounts")
    def accounts(user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            rows = conn.execute(
                "SELECT id,platform,username,display_name,status,health_status,health_checked_at,updated_at FROM social_accounts WHERE user_id = ? ORDER BY updated_at DESC",
                (target_id,),
            ).fetchall()
            items = []
            for row in rows:
                item = dict(row)
                item["needs_login"] = _account_needs_login(row["status"], row["health_status"])
                item["rotation"] = get_sender_rotation_status(
                    conn, user_id=target_id, account_id=str(row["id"]),
                )
                items.append(item)
            return {"items": items}

    @router.get("/api/crm/v1/accounts/{account_id}/rotation")
    def account_rotation_status(
        account_id: str,
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return get_sender_rotation_status(conn, user_id=target_id, account_id=account_id)

    @router.post("/api/crm/v1/accounts/{account_id}/rotation/evaluate")
    def evaluate_account_rotation(
        account_id: str,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        results = payload.get("results")
        if not isinstance(results, list) or len(results) > 500:
            raise CRMError(
                "crm_rotation_results_invalid", "crm.errors.rotationResultsInvalid", status_code=400,
            )
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            current = get_sender_rotation_status(conn, user_id=target_id, account_id=account_id)
        return evaluate_sender_rotation_sequence(
            [dict(item) for item in results if isinstance(item, dict)],
            platform=str(current.get("platform") or ""),
            expected_username=str(current.get("username") or ""),
        )

    @router.post("/api/crm/v1/accounts/{account_id}/rotation/reset")
    def reset_account_rotation(
        account_id: str,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        confirmed = payload.get("confirmed_follow_action")
        if not isinstance(confirmed, bool):
            raise CRMError(
                "crm_rotation_follow_confirmation_required",
                "crm.errors.rotationFollowConfirmationRequired",
                status_code=409,
            )
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            return reset_sender_rotation_status(
                conn,
                user_id=target_id,
                account_id=account_id,
                confirmed_follow_action=confirmed,
            )

    @router.post("/api/crm/v1/accounts/{account_id}/open-login", status_code=202)
    async def open_account_login(
        account_id: str,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(get_current_user),
    ):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            account = conn.execute(
                "SELECT id,platform,username,status,health_status FROM social_accounts WHERE id=? AND user_id=?",
                (str(account_id), target_id),
            ).fetchone()
            if account is None:
                raise CRMError("crm_account_not_found", "crm.errors.accountNotFound", status_code=404)
            idempotency_key = str((payload or {}).get("idempotency_key") or f"open-login:{target_id}:{account_id}:{now_ts() // 60}")
            workflow = create_workflow_atomic(
                conn,
                user_id=target_id,
                workflow_type="open_login",
                title=f"Login @{account['username']}",
                input_data={"account_id": str(account_id), "platform": str(account["platform"])},
                idempotency_key=idempotency_key,
                actions=[{
                    "action_type": "open_login", "target_key": f"{account['platform']}:{account_id}",
                    "account_id": str(account_id), "write": False,
                    "payload": {"account_id": str(account_id), "platform": str(account["platform"])},
                }],
                social_task_adapter=social_task_adapter,
            )
        await _notify(post_commit_callback, {"event": "workflow_created", "workflow_id": workflow["id"], "user_id": target_id})
        return {
            "task_id": workflow["id"], "status": workflow["status"],
            "idempotency_key": workflow["idempotency_key"],
            "status_url": f"/api/crm/v1/tasks/{workflow['id']}",
        }

    @router.get("/api/crm/v1/analytics")
    def analytics(user: dict[str, Any] = Depends(get_current_user)):
        with db() as conn:
            target_id, _ = _require_effective(conn, user)
            statuses = conn.execute(
                "SELECT status,COUNT(*) AS count FROM crm_workflows WHERE user_id = ? AND active = 1 GROUP BY status",
                (target_id,),
            ).fetchall()
            event_types = conn.execute(
                "SELECT event_type,COUNT(*) AS count FROM crm_events WHERE user_id = ? AND active = 1 GROUP BY event_type ORDER BY count DESC LIMIT 30",
                (target_id,),
            ).fetchall()
            action_states = conn.execute(
                "SELECT state,COUNT(*) AS count FROM crm_action_ledger WHERE user_id = ? GROUP BY state",
                (target_id,),
            ).fetchall()
            action_types = conn.execute(
                "SELECT action_type,COUNT(*) AS count FROM crm_action_ledger "
                "WHERE user_id = ? AND state = 'confirmed' GROUP BY action_type ORDER BY count DESC LIMIT 30",
                (target_id,),
            ).fetchall()
            tracking_clicks = int(conn.execute(
                "SELECT COUNT(*) AS count FROM crm_tracking_events WHERE user_id = ?",
                (target_id,),
            ).fetchone()["count"])
            funnel_rows = conn.execute(
                """
                SELECT
                  SUM(CASE WHEN lower(event_type) IN ('delivered','message_delivered','dm_delivered') THEN 1 ELSE 0 END) AS delivered,
                  SUM(CASE WHEN lower(event_type) IN ('read','message_read','dm_read') THEN 1 ELSE 0 END) AS read_count,
                  SUM(CASE WHEN lower(event_type) IN ('reply','replied','message_reply','dm_reply') THEN 1 ELSE 0 END) AS replied,
                  SUM(CASE WHEN lower(event_type) IN ('interaction','engagement','liked','shared','reposted') THEN 1 ELSE 0 END) AS engaged
                FROM crm_events
                WHERE user_id = ? AND active = 1
                """,
                (target_id,),
            ).fetchone()
            historical_rows = conn.execute(
                """
                SELECT
                  SUM(CASE WHEN lower(event_type) IN ('public_comment_published','public_comment_submitted_unverified','engagement_touch_submitted','engagement_touch_published','outreach_evidence_verified','message_sent_verified','group_post_verified') THEN 1 ELSE 0 END) AS submitted,
                  SUM(CASE WHEN lower(event_type) IN ('public_comment_evidence_verified','engagement_touch_published','outreach_evidence_verified','message_sent_verified','group_post_verified') THEN 1 ELSE 0 END) AS confirmed,
                  SUM(CASE WHEN lower(event_type) LIKE '%failed' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN lower(event_type) IN ('engagement_touch_published','liked','shared','reposted') THEN 1 ELSE 0 END) AS engaged,
                  SUM(CASE WHEN lower(event_type) LIKE '%reply%' AND lower(event_type) NOT LIKE '%monitor_started' THEN 1 ELSE 0 END) AS replied,
                  SUM(CASE WHEN lower(event_type) IN ('legacy_tracking_click','tracking_click','clicked') THEN 1 ELSE 0 END) AS clicked
                FROM crm_events WHERE user_id=? AND active=1 AND import_batch_id<>''
                """,
                (target_id,),
            ).fetchone()
            state_counts = {row["state"]: int(row["count"]) for row in action_states}
            submitted = sum(state_counts.get(state, 0) for state in ("submitted", "confirmed", "unknown"))
            return {
                "workflow_statuses": {row["status"]: int(row["count"]) for row in statuses},
                "event_types": {row["event_type"]: int(row["count"]) for row in event_types},
                "action_states": state_counts,
                "confirmed_action_types": {row["action_type"]: int(row["count"]) for row in action_types},
                "funnel": {
                    "submitted": submitted,
                    "confirmed": state_counts.get("confirmed", 0),
                    "unknown": state_counts.get("unknown", 0),
                    "failed": state_counts.get("failed", 0),
                    "skipped": state_counts.get("skipped", 0),
                    "delivered": int(funnel_rows["delivered"] or 0),
                    "read": int(funnel_rows["read_count"] or 0),
                    "replied": int(funnel_rows["replied"] or 0),
                    "engaged": int(funnel_rows["engaged"] or 0),
                    "clicked": tracking_clicks,
                },
                "historical_funnel": {key: int(historical_rows[key] or 0) for key in ("submitted", "confirmed", "failed", "engaged", "replied", "clicked")},
                "generated_at": now_ts(),
            }

    @router.get("/api/admin/modules/crm")
    def admin_module(user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            return module_settings(conn)

    @router.patch("/api/admin/modules/crm")
    def patch_admin_module(request: Request, payload: dict[str, Any] = Body(...), user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            current = module_settings(conn)
            dangerous = (
                (current["enabled"] and payload.get("enabled") is False)
                or (not current["maintenance"] and payload.get("maintenance") is True)
                or (not current["emergency_pause"] and payload.get("emergency_pause") is True)
            )
            if dangerous and payload.get("confirmed") is not True:
                raise CRMError("crm_confirmation_required", "crm.errors.confirmationRequired", status_code=409)
            updated = update_module_settings(conn, {key: value for key, value in payload.items() if key != "confirmed"})
            paused = 0
            if not updated["enabled"] or updated["maintenance"] or updated["emergency_pause"]:
                paused = pause_for_policy(conn)
            _audit_request(conn, request, user, "crm.module.update", after={**updated, "paused_workflows": paused})
            return {**updated, "paused_workflows": paused}

    @router.post("/api/admin/modules/crm/emergency-pause")
    def emergency_pause(request: Request, payload: dict[str, Any] = Body(default={}), user: dict[str, Any] = Depends(require_admin)):
        if payload.get("confirmed") is not True:
            raise CRMError("crm_confirmation_required", "crm.errors.confirmationRequired", status_code=409)
        with db() as conn:
            updated = update_module_settings(conn, {"emergency_pause": True})
            paused = pause_for_policy(conn)
            _audit_request(conn, request, user, "crm.module.emergency_pause", after={"paused_workflows": paused})
            return {**updated, "paused_workflows": paused}

    @router.get("/api/admin/modules/crm/health")
    def module_health(user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            settings = module_settings(conn)
            # Health is an interactive admin endpoint; a full quick_check can
            # scan the whole multi-GB database and block live requests.
            db_ok = int(conn.execute("SELECT 1").fetchone()[0]) == 1
            required_tables = {
                *RESOURCE_TABLES.values(), "user_module_access", "crm_workflows", "crm_workflow_steps",
                "crm_action_ledger", "crm_pool_members", "crm_tracking_events", "crm_import_batches",
                "crm_legacy_id_map", "crm_scheduler_leases",
            }
            present_tables = {
                str(row["name"])
                for row in conn.execute(
                    f"SELECT name FROM sqlite_master WHERE type='table' AND name IN ({','.join('?' for _ in required_tables)})",
                    tuple(sorted(required_tables)),
                ).fetchall()
            }
            db_schema_ok = present_tables == required_tables
            unknown = int(conn.execute("SELECT COUNT(*) FROM crm_action_ledger WHERE state = 'unknown'").fetchone()[0])
            data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()
            media_dir = data_dir / "crm_media"
            static_root = Path(__file__).resolve().parent.parent / "static"
            current = now_ts()
            static_checks = _health_static_checks(static_root, current=current)
            disk = shutil.disk_usage(data_dir if data_dir.exists() else data_dir.parent)
            minimum_free = max(int(os.getenv("CRM_MIN_FREE_BYTES", str(512 * 1024 * 1024)) or 0), 0)
            lease = conn.execute(
                "SELECT owner_id,expires_at FROM crm_scheduler_leases WHERE lease_key='crm-runtime'"
            ).fetchone()
            checks = {
                "database": db_ok,
                "database_schema": db_schema_ok,
                "database_check_mode": "lightweight",
                "static_html": bool(static_checks["static_html"]),
                "static_assets": bool(static_checks["static_assets"]),
                "static_checked_at": int(static_checks["checked_at"]),
                "static_asset_count": int(static_checks.get("static_asset_count") or 0),
                "missing_static_assets": list(static_checks.get("missing_static_assets") or []),
                "media_directory": media_dir.is_dir(),
                "media_writable": media_dir.is_dir() and os.access(media_dir, os.W_OK),
                "disk_free_bytes": int(disk.free),
                "disk_ok": int(disk.free) >= minimum_free,
                "tracking_secret": len(str(os.getenv("CRM_TRACKING_SECRET", "") or "").strip()) >= 32,
                "scheduler_lease": bool(lease and str(lease["owner_id"] or "") and int(lease["expires_at"] or 0) > current),
                "worker_adapter_registered": social_task_adapter is not None,
                "billing_adapter_registered": billing_adapter is not None,
            }
            ready = all(bool(checks[key]) for key in ("database", "database_schema", "static_html", "static_assets", "media_directory", "media_writable", "disk_ok", "tracking_secret", "scheduler_lease", "worker_adapter_registered", "billing_adapter_registered"))
            return {"status": "ok" if ready and not settings["emergency_pause"] else "degraded", "ready": ready, "checked_at": current, "checks": checks, "settings": settings, "unknown_actions": unknown}

    @router.get("/api/admin/users/{target_user_id}/modules/crm")
    def admin_user_module(target_user_id: int, user: dict[str, Any] = Depends(require_admin)):
        with db() as conn:
            state = effective_module_state(conn, user_id=target_user_id, identity_is_admin=False)
            return state

    @router.patch("/api/admin/users/{target_user_id}/modules/crm")
    def patch_admin_user_module(
        request: Request,
        target_user_id: int,
        payload: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(require_admin),
    ):
        with db() as conn:
            updated = set_user_access(
                conn, user_id=target_user_id, enabled=bool(payload.get("enabled")), actor_user_id=int(user.get("id") or 0),
            )
            _audit_request(conn, request, user, "crm.user_access.update", target_user_id=target_user_id, after=updated)
            return updated

    @router.post("/api/admin/modules/crm/import/dry-run")
    def import_dry_run(request: Request, payload: dict[str, Any] = Body(...), user: dict[str, Any] = Depends(require_admin)):
        require_write_capacity()
        data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()
        target_user_id = int(payload.get("user_id") or user.get("id") or 0)
        with db() as conn:
            result = dry_run_import(
                conn, user_id=target_user_id, actor_user_id=int(user.get("id") or 0),
                root=import_root(data_dir), source=str(payload.get("source") or ""),
            )
            if str(result.get("status") or "") != "active":
                update_module_settings(conn, {"migration_required": True})
            _audit_request(conn, request, user, "crm.import.dry_run", target_user_id=target_user_id, after={"batch_id": result["id"]})
            return result

    @router.post("/api/admin/modules/crm/import/activate")
    def import_activate(request: Request, payload: dict[str, Any] = Body(...), user: dict[str, Any] = Depends(require_admin)):
        if payload.get("confirmed") is not True:
            raise CRMError("crm_confirmation_required", "crm.errors.confirmationRequired", status_code=409)
        require_write_capacity()
        target_user_id = int(payload.get("user_id") or user.get("id") or 0)
        with db() as conn:
            result = activate_import(conn, batch_id=str(payload.get("batch_id") or ""), user_id=target_user_id)
            pending_imports = int(conn.execute(
                "SELECT COUNT(*) FROM crm_import_batches WHERE status IN ('dry_run','staged')"
            ).fetchone()[0])
            update_module_settings(conn, {"migration_required": pending_imports > 0})
            _audit_request(conn, request, user, "crm.import.activate", target_user_id=target_user_id, after={"batch_id": result["id"]})
            return result

    @router.post("/api/admin/modules/crm/import/{batch_id}/dismiss")
    def dismiss_import_batch(
        batch_id: str,
        request: Request,
        payload: dict[str, Any] = Body(default={}),
        user: dict[str, Any] = Depends(require_admin),
    ):
        if payload.get("confirmed") is not True:
            raise CRMError("crm_confirmation_required", "crm.errors.confirmationRequired", status_code=409)
        target_user_id = int(payload.get("user_id") or user.get("id") or 0)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            batch = conn.execute(
                "SELECT status FROM crm_import_batches WHERE id=? AND user_id=?",
                (str(batch_id), target_user_id),
            ).fetchone()
            if batch is None:
                raise CRMError("crm_import_not_found", "crm.errors.importNotFound", status_code=404)
            if str(batch["status"] or "") == "active":
                raise CRMError("crm_import_active_cannot_dismiss", "crm.errors.importActiveCannotDismiss", status_code=409)
            for table in (*RESOURCE_TABLES.values(), "crm_pool_members", "crm_workflows"):
                conn.execute(
                    f"DELETE FROM {table} WHERE import_batch_id=? AND user_id=? AND active=0",
                    (str(batch_id), target_user_id),
                )
            conn.execute("DELETE FROM crm_legacy_id_map WHERE import_batch_id=? AND user_id=?", (str(batch_id), target_user_id))
            conn.execute(
                "UPDATE crm_import_batches SET status='dismissed',updated_at=? WHERE id=? AND user_id=?",
                (now_ts(), str(batch_id), target_user_id),
            )
            pending = int(conn.execute("SELECT COUNT(*) FROM crm_import_batches WHERE status IN ('dry_run','staged')").fetchone()[0])
            update_module_settings(conn, {"migration_required": pending > 0})
            _audit_request(conn, request, user, "crm.import.dismiss", target_user_id=target_user_id, after={"batch_id": batch_id})
            return {"id": batch_id, "status": "dismissed", "migration_required": pending > 0}

    @router.get("/api/admin/modules/crm/import-status")
    def import_status(
        user_id: int = Query(default=0, ge=0),
        user: dict[str, Any] = Depends(require_admin),
    ):
        target = int(user_id or user.get("id") or 0)
        with db() as conn:
            rows = conn.execute(
                "SELECT * FROM crm_import_batches WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
                (target,),
            ).fetchall()
            return {"items": [row_public(row) for row in rows]}

    @router.get("/crm/go/{token}")
    def tracking_redirect(token: str, request: Request):
        try:
            _tracking_rate_limit(request)
            payload = verify_tracking_token(token)
        except CRMError as exc:
            return _public_tracking_error(429 if exc.status_code == 429 else 404)
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM crm_destinations WHERE id = ? AND user_id = ? AND enabled = 1 AND active = 1",
                (str(payload["destination_id"]), int(payload["user_id"])),
            ).fetchone()
            if row is None:
                return _public_tracking_error()
            visitor = hashlib.sha256(
                f"{request.client.host if request.client else ''}|{request.headers.get('user-agent','')}|{int(time.time()) // 86400}".encode("utf-8")
            ).hexdigest()
            occurred = now_ts()
            conn.execute(
                "INSERT OR IGNORE INTO crm_tracking_events(id,user_id,campaign_id,lead_id,destination_id,visitor_hash,token_version,occurred_at,metadata_json) VALUES (?,?,?,?,?,?,?,?, '{}')",
                (new_id("crm_track"), int(payload["user_id"]), str(payload["campaign_id"]), str(payload["lead_id"]), str(payload["destination_id"]), visitor, int(payload["version"]), occurred),
            )
            return RedirectResponse(str(row["url"]), status_code=302)

    @router.get("/go/{code}/{username}/{lead_id}")
    def legacy_tracking_redirect(
        code: str,
        username: str,
        lead_id: str,
        request: Request,
        campaign: str = Query(default="", max_length=180),
    ):
        try:
            _tracking_rate_limit(request)
        except CRMError:
            return _public_tracking_error(429)
        with db() as conn:
            workflow_candidates = _legacy_entity_candidates(
                conn,
                entity_type="workflows",
                table="crm_workflows",
                legacy_id=campaign,
            )
            lead_candidates = _legacy_entity_candidates(
                conn,
                entity_type="leads",
                table="crm_leads",
                legacy_id=lead_id,
                username=username,
            )
            if not lead_candidates or (str(campaign).strip() and not workflow_candidates):
                return _public_tracking_error()
            if workflow_candidates:
                tenant_ids = set(workflow_candidates).intersection(lead_candidates)
            else:
                tenant_ids = set(lead_candidates)
            # Legacy ids are only tenant-local. Ambiguity must fail closed
            # rather than redirect through another tenant's configured URL.
            if len(tenant_ids) != 1:
                return _public_tracking_error()
            user_id = int(next(iter(tenant_ids)))
            destination = _legacy_destination(conn, user_id=user_id, code=code)
            if destination is None:
                return _public_tracking_error()
            visitor = hashlib.sha256(
                f"legacy|{request.client.host if request.client else ''}|{request.headers.get('user-agent','')}|{int(time.time()) // 86400}".encode("utf-8")
            ).hexdigest()
            mapped_workflow_id = str(workflow_candidates.get(user_id) or "")
            mapped_lead_id = str(lead_candidates.get(user_id) or lead_id)
            metadata = {
                "legacy": True,
                "legacy_code": str(code),
                "legacy_username": str(username),
                "legacy_lead_id": str(lead_id),
                "legacy_campaign_id": str(campaign),
            }
            conn.execute(
                "INSERT OR IGNORE INTO crm_tracking_events(id,user_id,campaign_id,lead_id,destination_id,visitor_hash,token_version,occurred_at,metadata_json) VALUES (?,?,?,?,?,?,0,?,?)",
                (
                    new_id("crm_track"), user_id, mapped_workflow_id, mapped_lead_id,
                    str(destination["id"]), visitor, now_ts(),
                    json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
                ),
            )
            return RedirectResponse(str(destination["url"]), status_code=302)

    return router


def install_crm(
    app: FastAPI,
    *,
    billing_adapter: Adapter | None = None,
    social_task_adapter: Adapter | None = None,
    post_commit_callback: PostCommitCallback | None = None,
    llm_provider: Provider | None = None,
    hotspot_search_provider: Provider | None = None,
    live_search_executor: LiveSearchExecutor | None = None,
    collector_live_search: bool = False,
) -> None:
    data_dir = Path(str(os.getenv("WEBAPP_DATA_DIR", "webapp_data") or "webapp_data")).resolve()
    (data_dir / "crm_media").mkdir(parents=True, exist_ok=True)
    import_root(data_dir)
    app.add_exception_handler(CRMError, crm_error_handler)
    app.include_router(
        create_crm_router(
            billing_adapter=billing_adapter,
            social_task_adapter=social_task_adapter,
            post_commit_callback=post_commit_callback,
            llm_provider=llm_provider,
            hotspot_search_provider=hotspot_search_provider,
            live_search_executor=live_search_executor,
            collector_live_search=collector_live_search,
        )
    )
