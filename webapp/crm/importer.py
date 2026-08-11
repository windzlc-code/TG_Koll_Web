from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .errors import CRMError
from .repository import RESOURCE_TABLES, create_resource, dumps, new_id, now_ts, row_public

IMPORT_KEYS: dict[str, tuple[str, ...]] = {
    "pools": ("pools", "customerPools", "customer_pools", "leadPools"),
    "leads": ("leads", "customers", "prospects"),
    "events": ("events", "outreachEvents", "interactionEvents"),
    "hotspots": ("hotspots", "hotTopics", "trends"),
    "relationships": ("relationships", "relationshipRecords"),
    "templates": ("templates", "messageTemplates"),
    "schedules": ("schedules", "scheduledTasks"),
    "groups": ("groups", "chatGroups"),
    "destinations": ("destinations", "trackingDestinations"),
}
ATTACHMENT_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
ATTACHMENT_FORMATS = {
    ".jpg": ("JPEG", "image/jpeg"),
    ".jpeg": ("JPEG", "image/jpeg"),
    ".png": ("PNG", "image/png"),
    ".webp": ("WEBP", "image/webp"),
    ".gif": ("GIF", "image/gif"),
}
LEGACY_TRACKING_DESTINATIONS = (
    {
        "legacy_id": "o",
        "name": "Legacy CRM official Instagram",
        "url": "https://www.instagram.com/vecto.ai/",
        "enabled": True,
        "source": "legacy_crm_recordTaskTrackingClick",
        "source_schema_version": 1,
    },
    {
        "legacy_id": "l",
        "name": "Legacy CRM official LINE",
        "url": "https://line.me/R/ti/p/@vecto",
        "enabled": True,
        "source": "legacy_crm_recordTaskTrackingClick",
        "source_schema_version": 1,
    },
)
SENSITIVE_PATH_PARTS = {"cookies", "cookie", "profiles", "profile", "sessions", "session", "cache", "browser"}
SENSITIVE_FILE_MARKERS = ("credential", "vault", "secret", "gemini-proxy-config")


def _is_sensitive_relative(path: Path) -> bool:
    parts = [part.lower() for part in path.parts]
    return any(
        part in SENSITIVE_PATH_PARTS
        or "cookie" in part
        or "sender-profile" in part
        or part.endswith("profiles")
        or part.endswith("_cache")
        or part.startswith("cache_")
        for part in parts
    )


def _is_evidence_relative(path: str | Path) -> bool:
    parts = [part.lower() for part in Path(path).parts]
    return any(part in {"audit-screenshots", "evidence", "screenshots"} for part in parts)


def import_root(data_dir: Path | str) -> Path:
    root = (Path(data_dir).resolve() / "crm_imports").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_import_source(root: Path, source: str) -> Path:
    clean = str(source or "").strip()
    if not clean:
        raise CRMError("crm_import_source_required", "crm.errors.importSourceRequired", status_code=400)
    candidate = (root / clean).resolve() if not Path(clean).is_absolute() else Path(clean).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise CRMError("crm_import_source_forbidden", "crm.errors.importSourceForbidden", status_code=403) from exc
    if not candidate.exists() or (candidate.is_file() and candidate.suffix.lower() != ".json"):
        raise CRMError("crm_import_source_not_found", "crm.errors.importSourceNotFound", status_code=404)
    return candidate


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def source_manifest(path: Path) -> tuple[str, list[dict[str, Any]], list[str]]:
    candidates = [path] if path.is_file() else sorted(item for item in path.rglob("*") if item.is_file())
    digest = hashlib.sha256()
    manifest: list[dict[str, Any]] = []
    skipped: list[str] = []
    root = path.parent if path.is_file() else path
    for item in candidates:
        relative = item.relative_to(root).as_posix()
        relative_path = item.relative_to(root)
        lowered_name = item.name.lower()
        if _is_sensitive_relative(relative_path) or any(marker in lowered_name for marker in SENSITIVE_FILE_MARKERS):
            skipped.append(relative)
            continue
        if item.suffix.lower() != ".json" and item.suffix.lower() not in ATTACHMENT_SUFFIXES:
            continue
        file_hash = sha256_file(item)
        size = item.stat().st_size
        digest.update(relative.encode("utf-8"))
        digest.update(str(size).encode("ascii"))
        digest.update(file_hash.encode("ascii"))
        manifest.append({
            "path": relative,
            "size_bytes": size,
            "sha256": file_hash,
            "kind": "json" if item.suffix.lower() == ".json" else "attachment",
        })
    if not manifest:
        raise CRMError("crm_import_source_empty", "crm.errors.importSourceEmpty", status_code=422)
    return digest.hexdigest(), manifest, skipped


def _media_limits() -> dict[str, int]:
    max_bytes = max(int(os.getenv("CRM_MEDIA_MAX_BYTES", str(20 * 1024 * 1024)) or 0), 1024)
    max_dimension = max(int(os.getenv("CRM_MEDIA_MAX_DIMENSION", "12000") or 0), 1)
    max_pixels = max(int(os.getenv("CRM_MEDIA_MAX_PIXELS", str(40_000_000)) or 0), 1)
    max_frames = max(int(os.getenv("CRM_MEDIA_MAX_FRAMES", "200") or 0), 1)
    return {
        "max_bytes": max_bytes,
        "max_dimension": max_dimension,
        "max_pixels": max_pixels,
        "max_frames": max_frames,
    }


def _validate_attachment(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    expected = ATTACHMENT_FORMATS.get(suffix)
    if expected is None:
        raise CRMError("crm_import_media_type_not_allowed", "crm.errors.mediaTypeNotAllowed", status_code=422)
    limits = _media_limits()
    size = int(path.stat().st_size)
    if size <= 0 or size > limits["max_bytes"]:
        raise CRMError(
            "crm_import_media_too_large", "crm.errors.mediaTooLarge", status_code=422,
            details={"filename": path.name, "size_bytes": size, "max_bytes": limits["max_bytes"]},
        )
    try:
        with Image.open(path) as image:
            actual_format = str(image.format or "").upper()
            width, height = (int(image.width), int(image.height))
            frames = int(getattr(image, "n_frames", 1) or 1)
            if actual_format != expected[0]:
                raise CRMError(
                    "crm_import_media_format_mismatch", "crm.errors.mediaTypeNotAllowed", status_code=422,
                    details={"filename": path.name, "expected": expected[0], "actual": actual_format},
                )
            if width <= 0 or height <= 0 or width > limits["max_dimension"] or height > limits["max_dimension"] or width * height * frames > limits["max_pixels"]:
                raise CRMError(
                    "crm_import_media_dimensions_invalid", "crm.errors.mediaDimensionsInvalid", status_code=422,
                    details={"filename": path.name, "width": width, "height": height},
                )
            if frames > limits["max_frames"]:
                raise CRMError(
                    "crm_import_media_frames_invalid", "crm.errors.mediaFramesInvalid", status_code=422,
                    details={"filename": path.name, "frames": frames},
                )
            image.verify()
        # verify() checks container integrity; load every bounded frame as well
        # so truncated or maliciously structured payloads cannot be activated.
        with Image.open(path) as decoded:
            for frame_index in range(int(getattr(decoded, "n_frames", 1) or 1)):
                decoded.seek(frame_index)
                decoded.load()
    except CRMError:
        raise
    except Exception as exc:
        raise CRMError(
            "crm_import_media_decode_failed", "crm.errors.mediaDecodeFailed", status_code=422,
            details={"filename": path.name},
        ) from exc
    return {"mime_type": expected[1], "size_bytes": size, "format": expected[0]}


def _manifest_item_path(source: Path, relative: str) -> Path:
    root = source.parent if source.is_file() else source
    candidate = (root / str(relative)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise CRMError("crm_import_source_forbidden", "crm.errors.importSourceForbidden", status_code=403) from exc
    return candidate


def _load_json_value(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CRMError(
            "crm_import_invalid_json", "crm.errors.importInvalidJson", status_code=422,
            details={"filename": path.name},
        ) from exc


def load_source(path: Path) -> dict[str, Any]:
    payload = _load_json_value(path)
    if not isinstance(payload, dict):
        raise CRMError("crm_import_invalid_root", "crm.errors.importInvalidRoot", status_code=422)
    return payload


def _append_legacy_file(merged: dict[str, Any], path: Path, payload: Any) -> None:
    """Map known OPC snapshots without interpreting browser/profile state.

    Unknown safe JSON is retained as an audit event, so a migration report can
    prove that it was not silently discarded. Credential/profile files are
    excluded before this function is called.
    """
    name = path.name.lower()
    if isinstance(payload, dict):
        is_legacy_crm_state = name == "crm-state.json" and any(
            isinstance(payload.get(key), list)
            for key in ("tasks", "pools", "events", "hotspots", "relationships", "templates")
        )
        recognized = is_legacy_crm_state
        if is_legacy_crm_state:
            # The old runtime generated /go/o and /go/l links from a fixed map;
            # those destinations were never persisted in crm-state.json.
            # Inject the exact audited HTTPS allowlist before any source-provided
            # destination so the historical code cannot be redirected elsewhere.
            merged["destinations"].extend(dict(item) for item in LEGACY_TRACKING_DESTINATIONS)
        for resource, aliases in IMPORT_KEYS.items():
            items = _items(payload, aliases)
            if items:
                merged[resource].extend(items)
                recognized = True
        tasks = payload.get("tasks") or payload.get("workflows") or payload.get("campaigns") or []
        if isinstance(tasks, list) and tasks:
            merged["tasks"].extend(item for item in tasks if isinstance(item, dict))
            recognized = True
        if name == "opc-hotspot-library.json":
            merged["hotspots"].extend(item for item in payload.get("posts", []) if isinstance(item, dict))
            merged["leads"].extend(item for item in payload.get("contacts", []) if isinstance(item, dict))
            for item in payload.get("collections", []):
                if isinstance(item, dict):
                    merged["tasks"].append({**item, "type": item.get("type") or "legacy_opc_collection"})
            recognized = True
        elif name == "sender-rotation-state.json":
            for account_key, state in payload.items():
                if account_key == "updatedAt" or not isinstance(state, dict):
                    continue
                merged["events"].append({
                    "id": f"rotation:{account_key}", "type": "sender_rotation_state",
                    "detail": {"account_key": account_key, "state": state},
                    "createdAt": payload.get("updatedAt") if isinstance(payload.get("updatedAt"), str) else None,
                })
            recognized = True
        elif name == "threads-daily-config.json":
            merged["schedules"].append({
                "id": "threads-daily-config", "workflow_type": "legacy_opc_daily_collection",
                "enabled": bool(payload.get("enabled")), "timezone": "Asia/Shanghai", "payload": payload,
            })
            recognized = True
        if not recognized:
            merged["events"].append({
                "id": f"file:{path.as_posix()}", "type": "legacy_source_snapshot",
                "detail": {"filename": path.name, "payload": payload},
            })
        return

    if not isinstance(payload, list):
        return
    records = [dict(item) for item in payload if isinstance(item, dict)]
    if "daily-runs" in name:
        merged["tasks"].extend({**item, "type": item.get("type") or "legacy_opc_daily_run"} for item in records)
    elif "outreach-events" in name or "click-events" in name or "blocklist" in name or "deleted-history" in name:
        event_type = (
            "legacy_tracking_click" if "click-events" in name else
            "legacy_contact_blocked" if "blocklist" in name else
            "legacy_history_deleted" if "deleted-history" in name else "legacy_outreach_event"
        )
        merged["events"].extend({**item, "type": item.get("type") or item.get("eventType") or event_type} for item in records)
    else:
        merged["events"].append({
            "id": f"file:{path.as_posix()}", "type": "legacy_source_snapshot",
            "detail": {"filename": path.name, "payload": records},
        })


def load_source_bundle(path: Path) -> tuple[dict[str, Any], list[str]]:
    merged: dict[str, Any] = {resource: [] for resource in IMPORT_KEYS}
    merged["tasks"] = []
    warnings: list[str] = []
    candidates = [path] if path.is_file() else sorted(path.rglob("*.json"))
    root = path.parent if path.is_file() else path
    for item in candidates:
        relative_path = item.relative_to(root)
        lowered_name = item.name.lower()
        if _is_sensitive_relative(relative_path) or any(marker in lowered_name for marker in SENSITIVE_FILE_MARKERS):
            continue
        try:
            payload = _load_json_value(item)
        except CRMError:
            warnings.append(f"invalid_json:{item.relative_to(root).as_posix()}")
            continue
        _append_legacy_file(merged, item, payload)
    return merged, warnings


def _items(payload: dict[str, Any], aliases: tuple[str, ...]) -> list[dict[str, Any]]:
    for key in aliases:
        value = payload.get(key)
        if isinstance(value, list):
            return [dict(item) for item in value if isinstance(item, dict)]
    return []


def source_inventory(payload: dict[str, Any]) -> dict[str, int]:
    counts = {resource: len(_items(payload, aliases)) for resource, aliases in IMPORT_KEYS.items()}
    task_items = payload.get("tasks") or payload.get("workflows") or payload.get("campaigns") or []
    counts["workflows"] = len(task_items) if isinstance(task_items, list) else 0
    pool_items = _items(payload, IMPORT_KEYS["pools"])
    memberships = sum(len(item.get("leads") or []) for item in pool_items if isinstance(item.get("leads"), list))
    counts["pool_members"] = memberships
    counts["nested_leads"] = len({
        (str(lead.get("platform") or "threads").lower(), str(lead.get("username") or lead.get("id") or "").lstrip("@").lower())
        for pool in pool_items for lead in (pool.get("leads") or []) if isinstance(lead, dict)
        if str(lead.get("username") or lead.get("id") or "").strip()
    })
    return counts


def _timestamp(value: Any, fallback: int | None = None) -> int:
    default = now_ts() if fallback is None else int(fallback)
    if value in (None, ""):
        return default
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        return int(number / 1000 if number > 10_000_000_000 else number)
    text = str(value).strip()
    if text.replace(".", "", 1).isdigit():
        return _timestamp(float(text), default)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())
    except (ValueError, OverflowError):
        return default


def _normalize_resource(resource: str, item: dict[str, Any]) -> dict[str, Any]:
    if resource == "pools":
        return {
            "name": item.get("customName") or item.get("name") or item.get("categoryLabel") or "Legacy pool",
            "description": item.get("description") or item.get("categoryLabel") or item.get("businessCategory") or "",
            "tags": item.get("tags") or [], "snapshot": item,
        }
    if resource == "leads":
        username = str(item.get("username") or item.get("handle") or "").lstrip("@")
        classification = item.get("mortgageClassification") if isinstance(item.get("mortgageClassification"), dict) else {}
        return {
            "platform": str(item.get("platform") or item.get("channel") or "threads").lower(),
            "platform_user_key": str(item.get("platform_user_key") or item.get("platformUserKey") or username or item.get("id") or "").lower(),
            "username": username, "display_name": item.get("display_name") or item.get("displayName") or item.get("name") or "",
            "stage": item.get("stage") or classification.get("stage") or "new",
            "score": item.get("score") or item.get("engagement") or 0,
            "tags": item.get("tags") or [], "profile": item,
        }
    if resource == "events":
        return {
            "lead_id": item.get("lead_id") or item.get("leadId") or item.get("contactId") or "",
            "workflow_id": item.get("workflow_id") or item.get("taskId") or item.get("campaignId") or "",
            "event_type": item.get("event_type") or item.get("eventType") or item.get("type") or "legacy_event",
            "occurred_at": _timestamp(item.get("occurred_at") or item.get("createdAt") or item.get("clickedAt") or item.get("updatedAt"), 0),
            "payload": item,
        }
    if resource == "hotspots":
        return {
            "platform": item.get("platform") or "threads", "source_url": item.get("source_url") or item.get("sourceUrl") or item.get("url") or "",
            "title": item.get("title") or item.get("query") or "", "content": item.get("content") or item.get("text") or "",
            "metrics": item.get("metrics") or {key: item.get(key) for key in ("likeCount", "replyCount", "repostCount", "engagement") if key in item},
            "captured_at": _timestamp(item.get("captured_at") or item.get("collectedAt") or item.get("updatedAt"), 0),
        }
    if resource == "relationships":
        return {
            "lead_id": item.get("lead_id") or item.get("leadId") or item.get("targetUsername") or "",
            "account_id": item.get("account_id") or item.get("accountId") or "",
            "relationship_type": item.get("relationship_type") or item.get("relationshipType") or "follow",
            "status": item.get("status") or "unknown",
            "verified_at": _timestamp(item.get("verified_at") or item.get("checkedAt") or item.get("updatedAt"), 0),
            "evidence": item,
        }
    if resource == "templates":
        content = item.get("content") or item.get("message") or item.get("body") or item.get("contact") or ""
        return {
            "name": item.get("name") or "Legacy template", "template_type": item.get("template_type") or item.get("kind") or "message",
            "locale": item.get("locale") or "zh-Hans", "content": content, "media_ids": item.get("media_ids") or item.get("mediaIds") or [],
            "is_default": item.get("is_default") or item.get("isDefault") or 0,
        }
    if resource == "schedules":
        return {
            "workflow_type": item.get("workflow_type") or item.get("workflowType") or "legacy_schedule",
            "cron_expression": item.get("cron_expression") or item.get("cronExpression") or "",
            "timezone": item.get("timezone") or "Asia/Shanghai", "enabled": item.get("enabled", True),
            "next_run_at": _timestamp(item.get("next_run_at") or item.get("nextRunAt"), 0),
            "last_run_at": _timestamp(item.get("last_run_at") or item.get("lastRunAt"), 0), "payload": item.get("payload") or item,
        }
    if resource == "groups":
        return {
            "platform": item.get("platform") or "instagram", "name": item.get("name") or "",
            "platform_group_key": item.get("platform_group_key") or item.get("platformGroupKey") or item.get("id") or "",
            "members": item.get("members") or [], "status": item.get("status") or "draft",
        }
    if resource == "destinations":
        return {
            "name": item.get("name") or "",
            "url": item.get("url") or item.get("destinationUrl") or "",
            "enabled": item.get("enabled", True),
            "source": item.get("source") or "legacy_import",
            "source_schema_version": int(item.get("source_schema_version") or item.get("schemaVersion") or 1),
        }
    return dict(item)


def _collect_string_fields(
    value: Any,
    *,
    key_hint: str = "",
    platform_hint: str = "threads",
) -> tuple[set[str], set[tuple[str, str]]]:
    media: set[str] = set()
    accounts: set[tuple[str, str]] = set()
    if isinstance(value, dict):
        inspected_url = str(value.get("inspectedUrl") or value.get("inspected_url") or "").lower()
        inferred_platform = "instagram" if "instagram.com/" in inspected_url else ("threads" if "threads.net/" in inspected_url or "threads.com/" in inspected_url else platform_hint)
        local_platform = str(value.get("platform") or value.get("channel") or inferred_platform or "threads").strip().lower()
        if local_platform not in {"threads", "instagram"}:
            local_platform = "threads"
        for key, item in value.items():
            child_media, child_accounts = _collect_string_fields(
                item,
                key_hint=str(key),
                platform_hint=local_platform,
            )
            media.update(child_media)
            accounts.update(child_accounts)
    elif isinstance(value, list):
        for item in value:
            child_media, child_accounts = _collect_string_fields(
                item,
                key_hint=key_hint,
                platform_hint=platform_hint,
            )
            media.update(child_media)
            accounts.update(child_accounts)
    elif isinstance(value, str):
        clean = value.strip()
        if Path(clean).suffix.lower() in ATTACHMENT_SUFFIXES:
            media.add(clean.replace("\\", "/"))
        lowered = key_hint.lower()
        if clean and "username" in lowered and any(marker in lowered for marker in ("account", "sender", "from")):
            accounts.add((str(platform_hint or "threads").lower(), clean.lstrip("@").lower()))
    return media, accounts


def _inspect_import_bundle(
    conn: sqlite3.Connection,
    *,
    path: Path,
    user_id: int,
    manifest: list[dict[str, Any]],
    payload: dict[str, Any],
    parse_warnings: list[str],
) -> dict[str, Any]:
    media_refs, account_refs = _collect_string_fields(payload)
    available_paths = {str(item["path"]) for item in manifest if item["kind"] == "attachment"}
    available_names = {Path(item).name for item in available_paths}
    missing_media = sorted(ref for ref in media_refs if ref not in available_paths and Path(ref).name not in available_names)

    account_mapping: dict[str, str] = {}
    for platform, username in sorted(account_refs):
        matches = conn.execute(
            "SELECT id FROM social_accounts WHERE user_id=? AND platform=? COLLATE NOCASE AND username=? COLLATE NOCASE",
            (int(user_id), platform, username),
        ).fetchall()
        account_mapping[f"{platform}:{username}"] = "matched" if len(matches) == 1 else ("missing" if not matches else "ambiguous")

    invalid_media: list[dict[str, Any]] = []
    attachment_metadata: dict[str, dict[str, Any]] = {}
    copy_hashes: set[tuple[str, str]] = set()
    copy_bytes = 0
    for item in manifest:
        if item["kind"] != "attachment":
            continue
        relative = str(item["path"])
        attachment = _manifest_item_path(path, relative)
        try:
            attachment_metadata[relative] = _validate_attachment(attachment)
        except (CRMError, OSError) as exc:
            invalid_media.append({
                "path": relative,
                "code": str(getattr(exc, "code", "crm_import_media_unreadable")),
            })
            continue
        digest = str(item["sha256"])
        attachment_kind = "evidence" if _is_evidence_relative(relative) else "media"
        copy_key = (attachment_kind, digest)
        if copy_key in copy_hashes:
            continue
        copy_hashes.add(copy_key)
        if attachment_kind == "evidence":
            copy_bytes += int(item["size_bytes"])
            continue
        exists = conn.execute(
            "SELECT 1 FROM crm_media WHERE user_id=? AND sha256=? AND active=1",
            (int(user_id), digest),
        ).fetchone()
        if exists is None:
            copy_bytes += int(item["size_bytes"])

    blocking_errors: list[dict[str, Any]] = [
        {"code": "crm_import_invalid_json", "path": warning.removeprefix("invalid_json:")}
        for warning in parse_warnings if warning.startswith("invalid_json:")
    ]
    blocking_errors.extend(
        {"code": str(item["code"]), "path": str(item["path"])} for item in invalid_media
    )
    blocking_errors.extend(
        {"code": "crm_import_account_mapping_required", "account": key, "state": state}
        for key, state in account_mapping.items() if state != "matched"
    )
    return {
        "missing_media": missing_media,
        "account_mapping": account_mapping,
        "invalid_media": invalid_media,
        "attachment_metadata": attachment_metadata,
        "attachment_copy_bytes": copy_bytes,
        "blocking_errors": blocking_errors,
    }


def _copy_capacity(data_root: Path, *, copy_bytes: int) -> dict[str, int | bool]:
    usage = shutil.disk_usage(data_root if data_root.exists() else data_root.parent)
    safety_margin = max(int(os.getenv("CRM_MIN_FREE_BYTES", str(512 * 1024 * 1024)) or 0), 0)
    required = max(int(copy_bytes), 0) + safety_margin
    return {
        "free_bytes": int(usage.free),
        "copy_bytes": max(int(copy_bytes), 0),
        "safety_margin_bytes": safety_margin,
        "required_free_bytes": required,
        "ready": int(usage.free) >= required,
    }


def _mark_batch_failed(
    conn: sqlite3.Connection,
    *,
    batch_id: str,
    report: dict[str, Any],
    error: dict[str, Any],
) -> None:
    failed_report = dict(report)
    failures = list(failed_report.get("activation_errors") or [])
    failures.append(error)
    failed_report["activation_errors"] = failures
    failed_report["activated"] = False
    conn.execute(
        "UPDATE crm_import_batches SET status='failed',report_json=?,updated_at=? WHERE id=?",
        (dumps(failed_report), now_ts(), str(batch_id)),
    )
    # Persist the failure and any prior inactive checkpoints even though the
    # request raises. Normal CRM queries cannot see inactive staging rows.
    conn.commit()


def _safe_copy_attachment(
    conn: sqlite3.Connection,
    *,
    batch_id: str,
    report: dict[str, Any],
    source: Path,
    destination: Path,
    data_root: Path,
) -> None:
    if destination.exists():
        return
    try:
        _validate_attachment(source)
    except CRMError as exc:
        error = {"code": exc.code, "path": source.name}
        _mark_batch_failed(conn, batch_id=batch_id, report=report, error=error)
        raise
    capacity = _copy_capacity(data_root, copy_bytes=int(source.stat().st_size))
    if not bool(capacity["ready"]):
        error = {"code": "crm_import_storage_unavailable", **capacity, "path": source.name}
        _mark_batch_failed(conn, batch_id=batch_id, report=report, error=error)
        raise CRMError(
            "crm_import_storage_unavailable", "crm.errors.storageUnavailable", status_code=507,
            details=capacity, retryable=True,
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        error = {"code": "crm_import_attachment_copy_failed", "path": source.name}
        _mark_batch_failed(conn, batch_id=batch_id, report=report, error=error)
        raise CRMError(
            "crm_import_attachment_copy_failed", "crm.errors.importAttachmentCopyFailed", status_code=507,
            details={"filename": source.name}, retryable=True,
        ) from exc


def dry_run_import(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    actor_user_id: int,
    root: Path,
    source: str,
) -> dict[str, Any]:
    path = resolve_import_source(root, source)
    source_hash, manifest, skipped = source_manifest(path)
    existing = conn.execute(
        "SELECT * FROM crm_import_batches WHERE user_id = ? AND source_sha256 = ?",
        (int(user_id), source_hash),
    ).fetchone()
    if existing is not None and str(existing["status"] or "") not in {"dry_run", "failed"}:
        return row_public(existing) or {}
    payload, parse_warnings = load_source_bundle(path)
    counts = source_inventory(payload)
    inspection = _inspect_import_bundle(
        conn,
        path=path,
        user_id=int(user_id),
        manifest=manifest,
        payload=payload,
        parse_warnings=parse_warnings,
    )
    batch_id = str(existing["id"]) if existing is not None else new_id("crm_import")
    created = now_ts()
    report = {
        "filename": path.name,
        "source_type": "directory" if path.is_dir() else "file",
        "size_bytes": sum(int(item["size_bytes"]) for item in manifest),
        "manifest": manifest,
        "json_files": sum(1 for item in manifest if item["kind"] == "json"),
        "attachments": sum(1 for item in manifest if item["kind"] == "attachment"),
        "evidence_attachments": sum(1 for item in manifest if item["kind"] == "attachment" and _is_evidence_relative(str(item["path"]))),
        "media_attachments": sum(1 for item in manifest if item["kind"] == "attachment" and not _is_evidence_relative(str(item["path"]))),
        "skipped_sensitive_paths": skipped,
        "missing_media": inspection["missing_media"],
        "account_mapping": inspection["account_mapping"],
        "invalid_media": inspection["invalid_media"],
        "attachment_copy_bytes": inspection["attachment_copy_bytes"],
        "blocking_errors": inspection["blocking_errors"],
        "recognized_entities": sum(counts.values()),
        "warnings": parse_warnings + ([] if sum(counts.values()) else ["no_recognized_entities"]),
        "retain_source_until": created + 7 * 86400,
    }
    if existing is None:
        conn.execute(
            """
            INSERT INTO crm_import_batches(
              id,user_id,source_path,source_sha256,status,counts_json,report_json,
              created_by,created_at,updated_at
            ) VALUES (?,?,?,?,'dry_run',?,?,?,?,?)
            """,
            (
                batch_id, int(user_id), str(path), source_hash, dumps(counts), dumps(report),
                int(actor_user_id), created, created,
            ),
        )
    else:
        conn.execute(
            """
            UPDATE crm_import_batches
            SET source_path=?,status='dry_run',counts_json=?,report_json=?,created_by=?,updated_at=?
            WHERE id=? AND user_id=?
            """,
            (
                str(path), dumps(counts), dumps(report), int(actor_user_id), created,
                batch_id, int(user_id),
            ),
        )
    return row_public(conn.execute("SELECT * FROM crm_import_batches WHERE id = ?", (batch_id,)).fetchone()) or {}


def _legacy_id(item: dict[str, Any], index: int) -> str:
    return str(item.get("id") or item.get("legacy_id") or item.get("legacyId") or index)


def _stage_workflow(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    batch_id: str,
    item: dict[str, Any],
    index: int,
) -> str:
    legacy_id = _legacy_id(item, index)
    mapped = conn.execute(
        "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id = ? AND entity_type = 'workflows' AND legacy_id = ?",
        (batch_id, legacy_id),
    ).fetchone()
    if mapped is not None:
        return str(mapped["entity_id"])
    record_id = new_id("crm")
    created = _timestamp(item.get("created_at") or item.get("createdAt"))
    updated = _timestamp(item.get("updated_at") or item.get("updatedAt"), created)
    raw_status = str(item.get("status") or "completed")
    status_map = {"success": "completed", "need_manual": "manual_required", "paused": "paused_by_user"}
    status = status_map.get(raw_status, raw_status)
    valid = {
        "draft", "awaiting_confirmation", "queued", "running", "manual_required",
        "paused_by_user", "paused_by_policy", "completed", "failed", "cancelled",
    }
    if status not in valid:
        status = "completed" if bool(item.get("completed")) else "failed"
    # Imported non-terminal runs are historical evidence, not restartable
    # native workflows. They have no trusted action ledger/child-task graph and
    # must never resume against a live account after activation.
    if status in {"queued", "running", "manual_required"}:
        status = "paused_by_policy"
    conn.execute(
        """
        INSERT INTO crm_workflows(
          id,user_id,workflow_type,title,status,input_json,result_json,error_detail,
          import_batch_id,active,legacy_id,legacy_payload_json,schema_version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,1,?,?)
        """,
        (
            record_id, int(user_id), str(item.get("type") or item.get("taskType") or "legacy"),
            str(item.get("title") or item.get("name") or ""), status,
            dumps(item.get("input") or {}), dumps(item.get("result") or item.get("output") or {}),
            str(item.get("error") or ""), batch_id, legacy_id, dumps(item), created, updated,
        ),
    )
    conn.execute(
        "INSERT INTO crm_legacy_id_map(import_batch_id,user_id,entity_type,legacy_id,entity_id,created_at) VALUES (?,?,?,?,?,?)",
        (batch_id, int(user_id), "workflows", legacy_id, record_id, now_ts()),
    )
    return record_id


def activate_import(conn: sqlite3.Connection, *, batch_id: str, user_id: int) -> dict[str, Any]:
    batch = conn.execute(
        "SELECT * FROM crm_import_batches WHERE id = ? AND user_id = ?",
        (str(batch_id), int(user_id)),
    ).fetchone()
    if batch is None:
        raise CRMError("crm_import_not_found", "crm.errors.importNotFound", status_code=404)
    if str(batch["status"]) == "active":
        return row_public(batch) or {}
    path = Path(str(batch["source_path"])).resolve()
    source_hash, manifest, _skipped = source_manifest(path) if path.exists() else ("", [], [])
    if not path.exists() or source_hash != str(batch["source_sha256"]):
        raise CRMError("crm_import_source_changed", "crm.errors.importSourceChanged", status_code=409)
    # Make a recoverable database snapshot before the first staged write. The
    # source package remains read-only and is never overwritten.
    if conn.in_transaction:
        conn.commit()
    backup_dir = path.parent.parent / "crm_backups" if path.parent.name == "crm_imports" else path.parent / "crm_backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"app-before-{batch_id}.db"
    if not backup_path.exists():
        backup_conn = sqlite3.connect(str(backup_path))
        try:
            conn.backup(backup_conn)
        finally:
            backup_conn.close()
    payload, parse_warnings = load_source_bundle(path)
    public_batch = row_public(batch) or {}
    prior_report = public_batch.get("report", {})
    if not isinstance(prior_report, dict):
        prior_report = {}
    inspection = _inspect_import_bundle(
        conn,
        path=path,
        user_id=int(user_id),
        manifest=manifest,
        payload=payload,
        parse_warnings=parse_warnings,
    )
    if inspection["blocking_errors"]:
        error = {"code": "crm_import_blocked", "errors": inspection["blocking_errors"]}
        blocked_report = {**prior_report, **inspection, "attachment_metadata": None}
        _mark_batch_failed(conn, batch_id=str(batch_id), report=blocked_report, error=error)
        raise CRMError(
            "crm_import_blocked", "crm.errors.importBlocked", status_code=409,
            details={"errors": inspection["blocking_errors"]},
        )
    data_root = path.parent.parent if path.parent.name == "crm_imports" else path.parent
    capacity = _copy_capacity(data_root, copy_bytes=int(inspection["attachment_copy_bytes"]))
    if not bool(capacity["ready"]):
        error = {"code": "crm_import_storage_unavailable", **capacity}
        _mark_batch_failed(conn, batch_id=str(batch_id), report={**prior_report, "capacity": capacity}, error=error)
        raise CRMError(
            "crm_import_storage_unavailable", "crm.errors.storageUnavailable", status_code=507,
            details=capacity, retryable=True,
        )
    staged_counts: dict[str, int] = {}
    staged_since_commit = 0
    activation_warnings: list[str] = []
    reference_report = {"event_leads_unmapped": 0, "event_workflows_unmapped": 0, "relationships_unmapped": 0}

    def checkpoint() -> None:
        nonlocal staged_since_commit
        staged_since_commit += 1
        if staged_since_commit >= 500:
            conn.commit()
            staged_since_commit = 0

    def stage_resource(resource: str, item: dict[str, Any], index: int, *, legacy_id: str = "") -> tuple[str, bool]:
        source_id = str(legacy_id or _legacy_id(item, index))
        mapped = conn.execute(
            "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id = ? AND entity_type = ? AND legacy_id = ?",
            (str(batch_id), resource, source_id),
        ).fetchone()
        if mapped is not None:
            if resource == "destinations":
                # The audited built-in legacy destination is staged before any
                # source-provided collision and must remain authoritative.
                return str(mapped["entity_id"]), False
            existing = conn.execute(
                f"SELECT legacy_payload_json FROM {RESOURCE_TABLES[resource]} WHERE id=? AND user_id=?",
                (str(mapped["entity_id"]), int(user_id)),
            ).fetchone()
            existing_payload = json.loads(str(existing["legacy_payload_json"] or "{}")) if existing else {}
            if existing_payload == item:
                return str(mapped["entity_id"]), False
            # Legacy ids are not globally unique (not even inside a resource).
            # Preserve distinct records with a deterministic collision suffix.
            digest = hashlib.sha256(dumps(item).encode("utf-8")).hexdigest()[:12]
            source_id = f"{source_id}:{digest}"
            mapped = conn.execute(
                "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id = ? AND entity_type = ? AND legacy_id = ?",
                (str(batch_id), resource, source_id),
            ).fetchone()
            if mapped is not None:
                return str(mapped["entity_id"]), False
        if (
            resource == "destinations"
            and str(item.get("source") or "") == "legacy_crm_recordTaskTrackingClick"
            and source_id in {"o", "l"}
        ):
            existing_destination = conn.execute(
                "SELECT id FROM crm_destinations WHERE user_id=? AND legacy_id=? AND url=? AND active=1 ORDER BY updated_at DESC LIMIT 1",
                (int(user_id), source_id, str(item.get("url") or "")),
            ).fetchone()
            if existing_destination is not None:
                entity_id = str(existing_destination["id"])
                conn.execute(
                    "INSERT INTO crm_legacy_id_map(import_batch_id,user_id,entity_type,legacy_id,entity_id,created_at) VALUES (?,?,?,?,?,?)",
                    (str(batch_id), int(user_id), resource, source_id, entity_id, now_ts()),
                )
                checkpoint()
                return entity_id, False
        normalized = _normalize_resource(resource, item)
        created = create_resource(
            conn, resource, user_id=int(user_id), payload=normalized, active=False,
            import_batch_id=str(batch_id), legacy_id=source_id,
        )
        entity_id = str(created["id"])
        legacy_created = _timestamp(item.get("created_at") or item.get("createdAt"), int(created["created_at"]))
        legacy_updated = _timestamp(item.get("updated_at") or item.get("updatedAt"), legacy_created)
        conn.execute(
            f"UPDATE {RESOURCE_TABLES[resource]} SET legacy_payload_json=?, created_at=?, updated_at=? WHERE id=? AND user_id=?",
            (dumps(item), legacy_created, legacy_updated, entity_id, int(user_id)),
        )
        conn.execute(
            "INSERT INTO crm_legacy_id_map(import_batch_id,user_id,entity_type,legacy_id,entity_id,created_at) VALUES (?,?,?,?,?,?)",
            (str(batch_id), int(user_id), resource, source_id, entity_id, now_ts()),
        )
        checkpoint()
        return entity_id, True

    # Pools embed their leads in the real CRM snapshot. Stage the pool, dedupe
    # leads by stable platform identity, and preserve every pool membership.
    pool_items = _items(payload, IMPORT_KEYS["pools"])
    pool_ids: dict[str, str] = {}
    staged_counts["pools"] = 0
    for index, item in enumerate(pool_items):
        legacy_pool_id = _legacy_id(item, index)
        pool_id, inserted = stage_resource("pools", item, index, legacy_id=legacy_pool_id)
        pool_ids[legacy_pool_id] = pool_id
        staged_counts["pools"] += int(inserted)

    lead_by_identity: dict[tuple[str, str], str] = {}
    for row in conn.execute(
        "SELECT id,platform,platform_user_key FROM crm_leads WHERE user_id=? AND active=1 AND platform_user_key<>''",
        (int(user_id),),
    ).fetchall():
        lead_by_identity[(str(row["platform"]).lower(), str(row["platform_user_key"]).lower())] = str(row["id"])

    def stage_lead(item: dict[str, Any], index: int, *, context: str = "") -> tuple[str, bool]:
        normalized = _normalize_resource("leads", item)
        identity = (str(normalized["platform"]).lower(), str(normalized["platform_user_key"]).lower())
        raw_legacy_lead_id = str(item.get("id") or item.get("legacy_id") or item.get("legacyId") or (":".join(identity) if identity[1] else f"{context}:{index}"))
        legacy_lead_id = f"{identity[0]}:{raw_legacy_lead_id}" if identity[1] else raw_legacy_lead_id
        mapped = conn.execute(
            "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='leads' AND legacy_id=?",
            (str(batch_id), legacy_lead_id),
        ).fetchone()
        if mapped is not None:
            return str(mapped["entity_id"]), False
        entity_id = lead_by_identity.get(identity) if identity[1] else None
        inserted = False
        if entity_id is None:
            entity_id, inserted = stage_resource("leads", item, index, legacy_id=legacy_lead_id)
            if identity[1]:
                lead_by_identity[identity] = entity_id
            return entity_id, inserted
        conn.execute(
            "INSERT INTO crm_legacy_id_map(import_batch_id,user_id,entity_type,legacy_id,entity_id,created_at) VALUES (?,?,?,?,?,?)",
            (str(batch_id), int(user_id), "leads", legacy_lead_id, entity_id, now_ts()),
        )
        checkpoint()
        return entity_id, inserted

    staged_counts["leads"] = 0
    for index, item in enumerate(_items(payload, IMPORT_KEYS["leads"])):
        _lead_id, inserted = stage_lead(item, index, context="top")
        staged_counts["leads"] += int(inserted)

    staged_counts["pool_members"] = 0
    for pool_index, pool in enumerate(pool_items):
        legacy_pool_id = _legacy_id(pool, pool_index)
        pool_id = pool_ids[legacy_pool_id]
        for lead_index, lead in enumerate(pool.get("leads") or []):
            if not isinstance(lead, dict):
                continue
            lead_id, inserted = stage_lead(lead, lead_index, context=legacy_pool_id)
            staged_counts["leads"] += int(inserted)
            current = now_ts()
            before = conn.total_changes
            conn.execute(
                "INSERT OR IGNORE INTO crm_pool_members(user_id,pool_id,lead_id,status,source,import_batch_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)",
                (int(user_id), pool_id, lead_id, "active", "legacy_pool", str(batch_id), current, current),
            )
            if conn.total_changes > before:
                staged_counts["pool_members"] += 1
                checkpoint()

    for resource, aliases in IMPORT_KEYS.items():
        if resource in {"pools", "leads"}:
            continue
        count = 0
        for index, item in enumerate(_items(payload, aliases)):
            if resource == "destinations" and not str(item.get("url") or item.get("destinationUrl") or "").lower().startswith("https://"):
                activation_warnings.append(f"destination_skipped_non_https:{_legacy_id(item, index)}")
                continue
            _entity_id, inserted = stage_resource(resource, item, index)
            count += int(inserted)
        staged_counts[resource] = count
    task_items = payload.get("tasks") or payload.get("workflows") or payload.get("campaigns") or []
    staged_counts["workflows"] = 0
    if isinstance(task_items, list):
        for index, item in enumerate(task_items):
            if isinstance(item, dict):
                before = conn.total_changes
                _stage_workflow(conn, user_id=int(user_id), batch_id=str(batch_id), item=dict(item), index=index)
                staged_counts["workflows"] += 1 if conn.total_changes > before else 0
                checkpoint()

    # Repair legacy references after workflows and leads have stable native IDs.
    for row in conn.execute(
        "SELECT id,lead_id,workflow_id FROM crm_events WHERE import_batch_id=? AND user_id=?",
        (str(batch_id), int(user_id)),
    ).fetchall():
        lead_map = conn.execute(
            "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='leads' AND legacy_id=?",
            (str(batch_id), str(row["lead_id"])),
        ).fetchone()
        workflow_map = conn.execute(
            "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='workflows' AND legacy_id=?",
            (str(batch_id), str(row["workflow_id"])),
        ).fetchone()
        resolved_lead_id = str(lead_map["entity_id"]) if lead_map else ""
        resolved_workflow_id = str(workflow_map["entity_id"]) if workflow_map else ""
        if str(row["lead_id"]) and not lead_map:
            reference_report["event_leads_unmapped"] += 1
        if str(row["workflow_id"]) and not workflow_map:
            reference_report["event_workflows_unmapped"] += 1
        conn.execute(
            "UPDATE crm_events SET lead_id=?,workflow_id=? WHERE id=?",
            (resolved_lead_id, resolved_workflow_id, str(row["id"])),
        )

    for row in conn.execute(
        "SELECT id,legacy_payload_json FROM crm_relationships WHERE import_batch_id=? AND user_id=?",
        (str(batch_id), int(user_id)),
    ).fetchall():
        legacy = json.loads(str(row["legacy_payload_json"] or "{}"))
        target = str(legacy.get("targetUsername") or legacy.get("username") or "").lstrip("@").lower()
        sender = str(legacy.get("senderUsername") or "").lstrip("@").lower()
        inspected_url = str(legacy.get("inspectedUrl") or legacy.get("inspected_url") or "").lower()
        inferred_platform = "instagram" if "instagram.com/" in inspected_url else ("threads" if "threads.net/" in inspected_url or "threads.com/" in inspected_url else "threads")
        platform = str(legacy.get("platform") or legacy.get("channel") or inferred_platform).strip().lower()
        if platform not in {"threads", "instagram"}:
            platform = "threads"
        lead = conn.execute(
            "SELECT id FROM crm_leads WHERE user_id=? AND lower(username)=? ORDER BY active DESC LIMIT 1",
            (int(user_id), target),
        ).fetchone() if target else None
        account = conn.execute(
            "SELECT id FROM social_accounts WHERE user_id=? AND platform=? COLLATE NOCASE AND username=? COLLATE NOCASE",
            (int(user_id), platform, sender),
        ).fetchone() if sender else None
        if target and lead is None:
            reference_report["relationships_unmapped"] += 1
        conn.execute(
            "UPDATE crm_relationships SET lead_id=?,account_id=? WHERE id=?",
            (str(lead["id"]) if lead else "", str(account["id"]) if account else "", str(row["id"])),
        )

    # Old sender-rotation snapshots are keyed by account id or username. Make
    # them native state events so the runtime lock/rotation checks can consume
    # them immediately after activation; unresolved senders remain explicit in
    # the mapping report instead of silently becoming inert audit records.
    reference_report["rotation_accounts_unmapped"] = 0
    for row in conn.execute(
        "SELECT id,legacy_payload_json FROM crm_events WHERE import_batch_id=? AND user_id=? AND event_type IN ('sender_rotation_state','legacy_sender_rotation_state')",
        (str(batch_id), int(user_id)),
    ).fetchall():
        legacy = json.loads(str(row["legacy_payload_json"] or "{}"))
        source = legacy.get("payload") if isinstance(legacy.get("payload"), dict) else legacy
        detail = source.get("detail") if isinstance(source.get("detail"), dict) else {}
        account_key = str(detail.get("account_key") or "").strip().lstrip("@")
        state = detail.get("state") if isinstance(detail.get("state"), dict) else {}
        platform_hint = str(state.get("channel") or state.get("platform") or "").strip().lower()
        username_hint = account_key
        if ":" in account_key:
            key_platform, key_username = account_key.split(":", 1)
            if key_platform.lower() in {"threads", "instagram"}:
                platform_hint = key_platform.lower()
                username_hint = key_username.lstrip("@")
        account = conn.execute(
            """
            SELECT id,platform,username FROM social_accounts
            WHERE user_id=? AND (id=? OR (username=? COLLATE NOCASE AND (?='' OR platform=? COLLATE NOCASE)))
            ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1
            """,
            (int(user_id), account_key, username_hint, platform_hint, platform_hint, account_key),
        ).fetchone() if account_key else None
        if account is None:
            reference_report["rotation_accounts_unmapped"] += 1
            continue
        rotation_payload = {
            "account_id": str(account["id"]),
            "username": str(account["username"] or ""),
            "platform": str(account["platform"] or ""),
            "consecutive_composer_failures": int(state.get("consecutive_composer_failures") or state.get("consecutiveComposerFailures") or state.get("consecutiveFailures") or 0),
            "locked": state.get("locked") is True or int(state.get("consecutive_composer_failures") or state.get("consecutiveComposerFailures") or state.get("consecutiveFailures") or 0) >= 2,
            "requires_follow_action": state.get("requires_follow_action") is True or state.get("requiresFollowAction") is True or int(state.get("consecutive_composer_failures") or state.get("consecutiveComposerFailures") or state.get("consecutiveFailures") or 0) >= 2,
            "last_recipient": str(state.get("last_recipient") or state.get("lastRecipient") or ""),
            "last_warning": str(state.get("last_warning") or state.get("lastWarning") or ""),
            "last_failure_category": str(state.get("last_failure_category") or state.get("lastFailureCategory") or ""),
            "last_failure_qualified_for_rotation": state.get("last_failure_qualified_for_rotation") is True or state.get("lastFailureQualifiedForRotation") is True,
        }
        conn.execute(
            "UPDATE crm_events SET lead_id=?,event_type='sender_rotation_state',payload_json=? WHERE id=?",
            (str(account["id"]), dumps(rotation_payload), str(row["id"])),
        )

    staged_counts["media"] = 0
    staged_counts["evidence"] = 0
    if path.is_dir():
        data_root = path.parent
        media_dir = (path.parent / "crm_media" / str(user_id)).resolve()
        evidence_dir = (path.parent / "crm_evidence" / str(user_id) / str(batch_id)).resolve()
        if path.parent.name == "crm_imports":
            data_root = path.parent.parent
            media_dir = (data_root / "crm_media" / str(user_id)).resolve()
            evidence_dir = (data_root / "crm_evidence" / str(user_id) / str(batch_id)).resolve()
        media_dir.mkdir(parents=True, exist_ok=True)
        for attachment in sorted(item for item in path.rglob("*") if item.is_file() and item.suffix.lower() in ATTACHMENT_SUFFIXES):
            if _is_sensitive_relative(attachment.relative_to(path)):
                continue
            legacy_id = attachment.relative_to(path).as_posix()
            digest = sha256_file(attachment)
            if _is_evidence_relative(legacy_id):
                mapped = conn.execute(
                    "SELECT 1 FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='evidence' AND legacy_id=?",
                    (str(batch_id), legacy_id),
                ).fetchone()
                if mapped is None:
                    evidence_dir.mkdir(parents=True, exist_ok=True)
                    destination = evidence_dir / f"{digest}{attachment.suffix.lower()}"
                    _safe_copy_attachment(
                        conn,
                        batch_id=str(batch_id),
                        report={**prior_report, "staged": staged_counts},
                        source=attachment,
                        destination=destination,
                        data_root=data_root,
                    )
                    conn.execute(
                        "INSERT INTO crm_legacy_id_map(import_batch_id,user_id,entity_type,legacy_id,entity_id,created_at) VALUES (?,?,?,?,?,?)",
                        (str(batch_id), int(user_id), "evidence", legacy_id, destination.relative_to(data_root).as_posix(), now_ts()),
                    )
                    staged_counts["evidence"] += 1
                    checkpoint()
                continue
            if conn.execute(
                "SELECT 1 FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='media' AND legacy_id=?",
                (str(batch_id), legacy_id),
            ).fetchone() is not None:
                continue
            existing = conn.execute(
                "SELECT id FROM crm_media WHERE user_id=? AND sha256=? AND (active=1 OR import_batch_id=?) ORDER BY active DESC LIMIT 1",
                (int(user_id), digest, str(batch_id)),
            ).fetchone()
            if existing is not None:
                media_id = str(existing["id"])
            else:
                destination = media_dir / f"{digest}{attachment.suffix.lower()}"
                _safe_copy_attachment(
                    conn,
                    batch_id=str(batch_id),
                    report={**prior_report, "staged": staged_counts},
                    source=attachment,
                    destination=destination,
                    data_root=data_root,
                )
                media_metadata = inspection["attachment_metadata"].get(legacy_id) or _validate_attachment(attachment)
                created_media = create_resource(
                    conn, "media", user_id=int(user_id), active=False,
                    import_batch_id=str(batch_id), legacy_id=legacy_id,
                    payload={
                        "storage_path": destination.relative_to(data_root).as_posix(),
                        "sha256": digest, "mime_type": str(media_metadata["mime_type"]),
                        "size_bytes": attachment.stat().st_size, "original_name": attachment.name,
                    },
                )
                media_id = str(created_media["id"])
                staged_counts["media"] += 1
            conn.execute(
                "INSERT INTO crm_legacy_id_map(import_batch_id,user_id,entity_type,legacy_id,entity_id,created_at) VALUES (?,?,?,?,?,?)",
                (str(batch_id), int(user_id), "media", legacy_id, media_id, now_ts()),
            )
            checkpoint()

        media_map = {
            str(row["legacy_id"]): str(row["entity_id"])
            for row in conn.execute(
                "SELECT legacy_id,entity_id FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='media'",
                (str(batch_id),),
            ).fetchall()
        }
        for template in conn.execute(
            "SELECT id,legacy_payload_json FROM crm_templates WHERE import_batch_id=? AND user_id=?",
            (str(batch_id), int(user_id)),
        ).fetchall():
            legacy = json.loads(str(template["legacy_payload_json"] or "{}"))
            refs, _accounts = _collect_string_fields(legacy)
            media_ids = sorted({
                media_id for ref in refs for legacy_path, media_id in media_map.items()
                if ref == legacy_path or Path(ref).name == Path(legacy_path).name
            })
            if media_ids:
                conn.execute("UPDATE crm_templates SET media_ids_json=? WHERE id=?", (dumps(media_ids), str(template["id"])))

    if staged_since_commit:
        conn.commit()

    # Activation is one transaction boundary: staged records are invisible to
    # normal queries until every parsed entity has been written successfully.
    for table in (
        "crm_pools", "crm_leads", "crm_pool_members", "crm_events", "crm_hotspots", "crm_relationships",
        "crm_templates", "crm_media", "crm_schedules", "crm_groups", "crm_destinations", "crm_workflows",
    ):
        conn.execute(f"UPDATE {table} SET active = 1 WHERE import_batch_id = ? AND user_id = ?", (str(batch_id), int(user_id)))
    activated = now_ts()
    report = {
        **prior_report,
        "staged": staged_counts,
        "source_counts": source_inventory(payload),
        "reference_mapping": reference_report,
        "activated": True,
        "backup_path": str(backup_path),
        "warnings": parse_warnings + activation_warnings,
        "attachment_copy_bytes": int(inspection["attachment_copy_bytes"]),
        "capacity": capacity,
        "blocking_errors": [],
        "retain_source_until": int(time.time()) + 7 * 86400,
    }
    conn.execute(
        "UPDATE crm_import_batches SET status = 'active', report_json = ?, activated_at = ?, updated_at = ? WHERE id = ?",
        (dumps(report), activated, activated, str(batch_id)),
    )
    return row_public(conn.execute("SELECT * FROM crm_import_batches WHERE id = ?", (str(batch_id),)).fetchone()) or {}
