from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit


SUPPORTED_LEGACY_TRACE_TYPES = frozenset({
    "collection",
    "legacy_opc_collection",
    "legacy_opc_daily_run",
})

# Production currently tops out at 180 records and 174 keyword executions per
# run.  The cap retains every current run while bounding malformed imports.
MAX_TRACE_ITEMS = 200
_SOCIAL_HOSTS = ("instagram.com", "threads.com", "threads.net")
_SUMMARY_SOURCE_KEYS = {
    "collected", "completed", "error_count", "failed", "processed", "skipped",
    "success", "total", "warning_count",
}
_COLLECTION_METRIC_KEYS = {
    "collected": "collected",
    "duplicatesRemoved": "duplicates_removed",
    "filteredOut": "filtered_out",
    "instagram": "instagram",
    "matched": "matched",
    "mortgage": "mortgage",
    "rawMatches": "raw_matches",
    "threads": "threads",
}


def _text(value: Any, *, limit: int) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    return str(value).strip()[:limit]


def _count(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return max(0, int(value))
    try:
        return max(0, int(str(value).strip()))
    except (TypeError, ValueError):
        return 0


def _safe_social_url(value: Any) -> str:
    raw = _text(value, limit=2048)
    if not raw or any(character.isspace() for character in raw):
        return ""
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    host = str(parsed.hostname or "").rstrip(".").lower()
    if (
        parsed.scheme.lower() != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or not any(host == root or host.endswith(f".{root}") for root in _SOCIAL_HOSTS)
    ):
        return ""
    return raw


def _keyword_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    query = _text(item.get("query") or item.get("keyword"), limit=500)
    warning = _text(item.get("warning") or item.get("error"), limit=2000)
    source_url = _safe_social_url(item.get("source_url") or item.get("sourceUrl"))
    result: dict[str, Any] = {
        "query": query,
        "count": _count(item.get("count")),
    }
    if source_url:
        result["source_url"] = source_url
    if warning:
        result["warning"] = warning
    return result if query or warning or result["count"] or source_url else None


def _record_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    result: dict[str, Any] = {}
    for public_key, source_keys, limit in (
        ("username", ("username", "user_name"), 240),
        ("keyword", ("keyword", "query"), 500),
        ("text", ("text", "rawText", "raw_text"), 5000),
        ("timestamp", ("timestamp", "collectedAt", "collected_at"), 120),
        ("platform", ("platform",), 40),
    ):
        value = ""
        for source_key in source_keys:
            value = _text(item.get(source_key), limit=limit)
            if value:
                break
        if value:
            result[public_key] = value
    for public_key, source_keys in (
        ("permalink", ("permalink",)),
        ("profile_url", ("profile_url", "profileUrl")),
        ("source_url", ("source_url", "sourceUrl")),
    ):
        value = ""
        for source_key in source_keys:
            value = _safe_social_url(item.get(source_key))
            if value:
                break
        if value:
            result[public_key] = value
    return result or None


def _source_steps(payload: dict[str, Any], *, original_status: str) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    raw_steps = payload.get("steps")
    if isinstance(raw_steps, list):
        for item in raw_steps[:MAX_TRACE_ITEMS]:
            if not isinstance(item, dict):
                continue
            key = _text(item.get("key") or item.get("type") or item.get("name"), limit=120)
            status = _text(item.get("status"), limit=80)
            warning = _text(item.get("warning") or item.get("error"), limit=2000)
            if not key and not status and not warning and item.get("count") is None:
                continue
            step: dict[str, Any] = {"key": key or "legacy_step", "status": status or original_status}
            if item.get("count") is not None:
                step["count"] = _count(item.get("count"))
            if warning:
                step["warning"] = warning
            steps.append(step)
    return steps


def build_legacy_trace(workflow: dict[str, Any]) -> dict[str, Any] | None:
    """Project imported collection history without creating native CRM evidence."""

    workflow_type = _text(workflow.get("workflow_type"), limit=120)
    if workflow_type not in SUPPORTED_LEGACY_TRACE_TYPES:
        return None
    payload = workflow.get("legacy_payload")
    if not isinstance(payload, dict) or not payload:
        return None

    raw_keywords = payload.get("keywords") if isinstance(payload.get("keywords"), list) else []
    raw_records = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    keyword_evidence = [
        projected
        for item in raw_keywords[:MAX_TRACE_ITEMS]
        if (projected := _keyword_item(item)) is not None
    ]
    records = [
        projected
        for item in raw_records[:MAX_TRACE_ITEMS]
        if (projected := _record_item(item)) is not None
    ]
    original_status = _text(payload.get("status") or workflow.get("status"), limit=80)
    warning_count = sum(1 for item in raw_keywords if isinstance(item, dict) and _text(item.get("warning") or item.get("error"), limit=1))

    summary: dict[str, str | int | bool | float] = {
        "original_status": original_status,
        "trigger": _text(payload.get("trigger"), limit=120),
        "date_key": _text(payload.get("dateKey") or payload.get("date_key"), limit=120),
        "started_at": _text(payload.get("startedAt") or payload.get("started_at"), limit=120),
        "finished_at": _text(payload.get("finishedAt") or payload.get("finished_at"), limit=120),
        "error": _text(payload.get("error"), limit=2000),
        "keywords_total": len(raw_keywords),
        "keywords_truncated": len(raw_keywords) > MAX_TRACE_ITEMS,
        "records_total": len(raw_records),
        "records_truncated": len(raw_records) > MAX_TRACE_ITEMS,
        "warning_count": warning_count,
    }
    config = payload.get("configSnapshot")
    if not isinstance(config, dict):
        config = payload.get("config_snapshot") if isinstance(payload.get("config_snapshot"), dict) else {}
    for source_key, public_key in (
        ("senderUsername", "sender_username"),
        ("searchMode", "search_mode"),
        ("searchType", "search_type"),
        ("mediaFilter", "media_filter"),
    ):
        value = _text(config.get(source_key), limit=240)
        if value:
            summary[public_key] = value
    for source_key, public_key in (("dailyQuota", "daily_quota"), ("limit", "limit")):
        if config.get(source_key) is not None:
            summary[public_key] = _count(config.get(source_key))

    if workflow_type == "collection":
        mode = _text(payload.get("mode"), limit=120)
        pool_id = _text(payload.get("poolId") or payload.get("pool_id"), limit=240)
        if mode:
            summary["mode"] = mode
        if pool_id:
            summary["pool_id"] = pool_id
        if payload.get("progress") is not None:
            summary["progress"] = _count(payload.get("progress"))
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
        for source_key, public_key in _COLLECTION_METRIC_KEYS.items():
            if metrics.get(source_key) is not None:
                summary[public_key] = _count(metrics.get(source_key))
    elif workflow_type == "legacy_opc_collection":
        name = _text(payload.get("name") or payload.get("title"), limit=500)
        platform = _text(payload.get("platform"), limit=40)
        created_at = _text(payload.get("createdAt") or payload.get("created_at"), limit=120)
        contact_ids = payload.get("contactIds") if isinstance(payload.get("contactIds"), list) else []
        post_ids = payload.get("postIds") if isinstance(payload.get("postIds"), list) else []
        tags = payload.get("tags") if isinstance(payload.get("tags"), list) else []
        if name:
            summary["name"] = name
        if platform:
            summary["platform"] = platform
        if created_at:
            summary["created_at"] = created_at
        summary["contact_count"] = len(contact_ids)
        summary["post_count"] = len(post_ids)
        summary["tag_count"] = len(tags)
        public_tags = [_text(item, limit=120) for item in tags[:20]]
        public_tags = [item for item in public_tags if item]
        if public_tags:
            summary["tags"] = "、".join(public_tags)[:1000]
    source_summary = payload.get("summary")
    if isinstance(source_summary, dict):
        for key in _SUMMARY_SOURCE_KEYS:
            value = source_summary.get(key)
            if isinstance(value, bool):
                summary[f"source_{key}"] = value
            elif isinstance(value, (int, float)):
                summary[f"source_{key}"] = value
            elif isinstance(value, str):
                summary[f"source_{key}"] = value[:500]
    elif isinstance(source_summary, str) and source_summary.strip():
        summary["source_summary"] = source_summary.strip()[:2000]

    steps = _source_steps(payload, original_status=original_status)
    if not steps:
        if original_status or summary["started_at"] or summary["finished_at"]:
            run_step: dict[str, Any] = {"key": "run", "status": original_status or "recorded"}
            if summary["error"]:
                run_step["warning"] = summary["error"]
            steps.append(run_step)
        if raw_keywords:
            steps.append({"key": "keyword_evidence", "status": original_status or "recorded", "count": len(raw_keywords)})
        if raw_records:
            steps.append({"key": "records", "status": original_status or "recorded", "count": len(raw_records)})
        if workflow_type == "collection" and isinstance(payload.get("metrics"), dict):
            steps.append({
                "key": "collection_metrics",
                "status": original_status or "recorded",
                "count": _count(payload["metrics"].get("collected")),
            })
        if workflow_type == "legacy_opc_collection":
            contact_ids = payload.get("contactIds") if isinstance(payload.get("contactIds"), list) else []
            post_ids = payload.get("postIds") if isinstance(payload.get("postIds"), list) else []
            if contact_ids:
                steps.append({"key": "collection_contacts", "status": original_status or "recorded", "count": len(contact_ids)})
            if post_ids:
                steps.append({"key": "collection_posts", "status": original_status or "recorded", "count": len(post_ids)})

    return {
        "source": "legacy_import",
        "kind": workflow_type,
        "summary": summary,
        "steps": steps,
        "keyword_evidence": keyword_evidence,
        "records": records,
        "source_details_missing": not bool(raw_keywords or raw_records or payload.get("steps")),
    }
