"""Pure policy helpers for safe multi-account CRM engagement.

The functions in this module deliberately avoid database, network, and clock
side effects.  They accept the current account/task snapshots and return
decisions or summaries that API and worker layers can apply atomically.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit


MAX_PARALLEL_COMMENT_TASKS = 3
TERMINAL_TASK_STATUSES = frozenset({"completed", "needs_attention", "failed", "stopped"})
ACTIVE_TASK_STATUSES = frozenset({"queued", "running"})


def normalize_sender_key(value: Any) -> str:
    """Return a stable, case-insensitive sender identity."""

    return str(value or "").lstrip("@").strip().casefold()


def sender_channel_readiness(
    account: Mapping[str, Any] | None,
    expected_username: Any,
    channel: str = "threads",
) -> dict[str, Any]:
    """Require both a configured account and an exact verified login identity."""

    expected = normalize_sender_key(expected_username)
    normalized_channel = "instagram" if str(channel).casefold() == "instagram" else "threads"
    if not account or normalize_sender_key(account.get("username")) != expected:
        return {"ready": False, "reason": "account_not_configured"}

    surface = account.get(normalized_channel)
    if not isinstance(surface, Mapping):
        surface = {}
    verification_status = str(
        surface.get("verification_status", surface.get("verificationStatus", "")) or ""
    ).strip()
    if verification_status != "matched":
        return {"ready": False, "reason": verification_status or "needs_login"}
    logged_in = surface.get("logged_in_username", surface.get("loggedInUsername"))
    if normalize_sender_key(logged_in) != expected:
        return {"ready": False, "reason": "account_mismatch"}
    return {"ready": True, "reason": "matched"}


def normalize_comment_source_url(value: Any) -> str:
    """Drop query/fragment noise while preserving the canonical post URL."""

    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw
    if not parsed.scheme or not parsed.netloc:
        return raw
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme.casefold(), parsed.netloc.casefold(), path, "", ""))


def historical_comment_attempts(
    tasks: Iterable[Mapping[str, Any]] | None,
    pool_id: Any,
    *,
    exclude_task_id: Any = "",
) -> dict[str, set[str]]:
    """Collect targets actually attempted by earlier comment tasks.

    Pending queue entries are intentionally excluded.  Only queue entries
    before the recorded cursor, result rows, verification rows, or item rows
    carrying attempt evidence count as historical attempts.
    """

    expected_pool = str(pool_id or "").strip()
    excluded = str(exclude_task_id or "").strip()
    lead_ids: set[str] = set()
    source_urls: set[str] = set()

    def add_row(row: Any) -> None:
        if not isinstance(row, Mapping):
            return
        lead_id = str(row.get("lead_id", row.get("leadId", "")) or "").strip()
        source_url = normalize_comment_source_url(
            row.get("source_post_url", row.get("sourcePostUrl", ""))
        )
        if lead_id:
            lead_ids.add(lead_id)
        if source_url:
            source_urls.add(source_url)

    for task in tasks or ():
        if not isinstance(task, Mapping):
            continue
        task_id = str(task.get("id", "") or "").strip()
        task_type = str(task.get("type", task.get("task_type", "")) or "").strip()
        task_pool = str(task.get("pool_id", task.get("poolId", "")) or "").strip()
        if task_id == excluded or task_type != "comment" or task_pool != expected_pool:
            continue

        queue = task.get("lead_queue", task.get("leadQueue", ()))
        if not isinstance(queue, Sequence) or isinstance(queue, (str, bytes, bytearray)):
            queue = ()
        control = task.get("batch_control", task.get("batchControl", {}))
        if not isinstance(control, Mapping):
            control = {}
        try:
            cursor = int(control.get("cursor", 0) or 0)
        except (TypeError, ValueError, OverflowError):
            cursor = 0
        cursor = max(0, min(len(queue), cursor))
        for lead_id in queue[:cursor]:
            value = str(lead_id or "").strip()
            if value:
                lead_ids.add(value)

        result = task.get("result") if isinstance(task.get("result"), Mapping) else {}
        verification = (
            task.get("comment_verification", task.get("commentVerification"))
            if isinstance(task.get("comment_verification", task.get("commentVerification")), Mapping)
            else {}
        )
        for container in (result.get("results", ()), verification.get("results", ())):
            if isinstance(container, Sequence) and not isinstance(container, (str, bytes, bytearray)):
                for row in container:
                    add_row(row)

        items = task.get("items", ())
        if isinstance(items, Sequence) and not isinstance(items, (str, bytes, bytearray)):
            evidence_keys = {
                "attempted_at", "attemptedAt", "submitted", "published",
                "failed", "error", "status",
            }
            for row in items:
                if isinstance(row, Mapping) and any(row.get(key) for key in evidence_keys):
                    add_row(row)

    return {"lead_ids": lead_ids, "source_urls": source_urls}


def evaluate_multi_account_capacity(
    sender_usernames: Iterable[Any] | None,
    active_tasks: Iterable[Mapping[str, Any]] | None = None,
    *,
    minimum_senders: int = 2,
    maximum_parallel: int = MAX_PARALLEL_COMMENT_TASKS,
) -> dict[str, Any]:
    """Validate sender uniqueness, ownership, and the global parallel limit."""

    senders: list[str] = []
    seen: set[str] = set()
    for raw in sender_usernames or ():
        display = str(raw or "").lstrip("@").strip()
        identity = normalize_sender_key(display)
        if not identity or identity in seen:
            continue
        seen.add(identity)
        senders.append(display)

    active = [
        task
        for task in (active_tasks or ())
        if isinstance(task, Mapping)
        and str(task.get("status", "") or "").casefold() in ACTIVE_TASK_STATUSES
        and str(task.get("type", task.get("task_type", "comment")) or "").casefold() == "comment"
    ]
    active_senders = {
        normalize_sender_key(task.get("sender_username", task.get("senderUsername")))
        for task in active
    }
    occupied = next((sender for sender in senders if normalize_sender_key(sender) in active_senders), "")
    limit = max(1, int(maximum_parallel))
    minimum = max(1, int(minimum_senders))

    if len(senders) < minimum:
        reason = "insufficient_senders"
    elif len(senders) > limit:
        reason = "request_parallel_limit"
    elif occupied:
        reason = "sender_already_active"
    elif len(active) + len(senders) > limit:
        reason = "global_parallel_limit"
    else:
        reason = "ready"
    return {
        "allowed": reason == "ready",
        "reason": reason,
        "senders": senders,
        "occupied_sender": occupied,
        "active_count": len(active),
        "requested_count": len(senders),
        "available_slots": max(0, limit - len(active)),
        "maximum_parallel": limit,
    }


def allocate_unique_targets(
    targets: Iterable[Mapping[str, Any]] | None,
    sender_usernames: Iterable[Any] | None,
    *,
    per_sender_limit: int = 1,
    attempted_lead_ids: Iterable[Any] | None = None,
    attempted_source_urls: Iterable[Any] | None = None,
) -> dict[str, Any]:
    """Round-robin eligible targets without assigning a target twice."""

    sender_values = list(sender_usernames or ())
    senders = evaluate_multi_account_capacity(
        sender_values,
        (),
        minimum_senders=1,
        maximum_parallel=max(1, len(sender_values)),
    )["senders"]
    limit = max(1, int(per_sender_limit))
    used_leads = {str(value or "").strip() for value in attempted_lead_ids or () if str(value or "").strip()}
    used_urls = {
        normalize_comment_source_url(value)
        for value in attempted_source_urls or ()
        if normalize_comment_source_url(value)
    }
    assignments = {sender: [] for sender in senders}
    skipped = {"historical": 0, "duplicate": 0, "invalid": 0, "capacity": 0}
    seen_leads: set[str] = set()
    seen_urls: set[str] = set()
    cursor = 0

    for row in targets or ():
        if not isinstance(row, Mapping):
            skipped["invalid"] += 1
            continue
        lead_id = str(row.get("lead_id", row.get("leadId", row.get("id", ""))) or "").strip()
        source_url = normalize_comment_source_url(
            row.get("source_post_url", row.get("sourcePostUrl", row.get("url", "")))
        )
        if not lead_id and not source_url:
            skipped["invalid"] += 1
            continue
        if lead_id in used_leads or source_url in used_urls:
            skipped["historical"] += 1
            continue
        if (lead_id and lead_id in seen_leads) or (source_url and source_url in seen_urls):
            skipped["duplicate"] += 1
            continue

        available = [sender for sender in senders if len(assignments[sender]) < limit]
        if not available:
            skipped["capacity"] += 1
            continue
        sender = available[cursor % len(available)]
        cursor += 1
        assignments[sender].append(row)
        if lead_id:
            seen_leads.add(lead_id)
        if source_url:
            seen_urls.add(source_url)

    return {
        "assignments": assignments,
        "assigned_count": sum(len(rows) for rows in assignments.values()),
        "unique_lead_count": len(seen_leads),
        "skipped": skipped,
        "per_sender_limit": limit,
    }


def _parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _metric(metrics: Mapping[str, Any], key: str) -> int:
    try:
        return max(0, int(metrics.get(key, 0) or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _metric_alias(metrics: Mapping[str, Any], *keys: str) -> int:
    for key in keys:
        if key in metrics:
            return _metric(metrics, key)
    return 0


def _percentage(numerator: int, denominator: int) -> float:
    return round(numerator / denominator * 100, 2) if denominator > 0 else 0.0


def summarize_multi_account_campaign(
    tasks: Iterable[Mapping[str, Any]] | None,
    campaign_id: Any = "",
    *,
    reference_time: Any = None,
) -> dict[str, Any]:
    """Produce deterministic per-sender and campaign-level throughput metrics."""

    expected_campaign = str(campaign_id or "").strip()
    selected = [
        task for task in (tasks or ())
        if isinstance(task, Mapping)
        and (
            not expected_campaign
            or str(task.get("multi_account_campaign_id", task.get("multiAccountCampaignId", "")) or "").strip()
            == expected_campaign
        )
    ]
    start_times = [
        parsed for task in selected
        if (parsed := _parse_time(task.get("started_at", task.get("startedAt", task.get("created_at", task.get("createdAt"))))))
    ]
    finish_times = [
        parsed for task in selected
        if (parsed := _parse_time(task.get("finished_at", task.get("finishedAt", task.get("updated_at", task.get("updatedAt"))))))
    ]
    reference = _parse_time(reference_time) or datetime.now(timezone.utc)
    started = min(start_times) if start_times else None
    finished = max(finish_times) if finish_times else reference
    duration_ms = max(0, int((finished - started).total_seconds() * 1000)) if started else 0
    lead_owners: dict[str, str] = {}
    duplicate_leads: set[str] = set()
    senders: list[dict[str, Any]] = []

    for task in selected:
        sender = str(task.get("sender_username", task.get("senderUsername", "")) or "").strip()
        metrics = task.get("metrics") if isinstance(task.get("metrics"), Mapping) else {}
        result = task.get("result") if isinstance(task.get("result"), Mapping) else {}
        rows = result.get("results", ())
        unique: set[str] = set()
        if isinstance(rows, Sequence) and not isinstance(rows, (str, bytes, bytearray)):
            for row in rows:
                if not isinstance(row, Mapping):
                    continue
                lead_id = str(row.get("lead_id", row.get("leadId", row.get("id", ""))) or "").strip()
                if not lead_id:
                    continue
                unique.add(lead_id)
                owner = lead_owners.get(lead_id)
                if owner and normalize_sender_key(owner) != normalize_sender_key(sender):
                    duplicate_leads.add(lead_id)
                else:
                    lead_owners[lead_id] = sender
        task_started = _parse_time(task.get("started_at", task.get("startedAt", task.get("created_at", task.get("createdAt")))))
        task_finished = _parse_time(task.get("finished_at", task.get("finishedAt", task.get("updated_at", task.get("updatedAt")))))
        task_duration_ms = (
            max(0, int((task_finished - task_started).total_seconds() * 1000))
            if task_started and task_finished else 0
        )
        processed = _metric(metrics, "processed")
        published = _metric(metrics, "published")
        replied = _metric(metrics, "replied")
        senders.append({
            "task_id": str(task.get("id", "") or ""),
            "sender_username": sender,
            "status": str(task.get("status", "") or ""),
            "total": _metric(metrics, "total"),
            "processed": processed,
            "submitted": _metric(metrics, "submitted"),
            "published": published,
            "pending_verification": _metric_alias(metrics, "pending_verification", "pendingVerification"),
            "replied": replied,
            "failed": _metric(metrics, "failed"),
            "unique_leads": len(unique),
            "duration_ms": task_duration_ms,
            "processed_per_minute": round(processed * 60_000 / task_duration_ms, 2) if task_duration_ms else 0.0,
            "published_per_minute": round(published * 60_000 / task_duration_ms, 2) if task_duration_ms else 0.0,
            "publish_rate": _percentage(published, processed),
            "reply_rate": _percentage(replied, published),
        })

    totals = {
        key: sum(sender[key] for sender in senders)
        for key in ("total", "processed", "submitted", "published", "pending_verification", "replied", "failed")
    }
    statuses = {str(task.get("status", "") or "").casefold() for task in selected}
    if selected and statuses.issubset(TERMINAL_TASK_STATUSES):
        status = "finished"
    elif statuses & ACTIVE_TASK_STATUSES:
        status = "running"
    else:
        status = "waiting"
    sender_duration_total = sum(sender["duration_ms"] for sender in senders)
    return {
        "campaign_id": expected_campaign,
        "task_count": len(selected),
        "sender_count": len({normalize_sender_key(sender["sender_username"]) for sender in senders if sender["sender_username"]}),
        "status": status,
        "started_at": started.isoformat().replace("+00:00", "Z") if started else "",
        "finished_at": finished.isoformat().replace("+00:00", "Z") if selected and statuses.issubset(TERMINAL_TASK_STATUSES) else "",
        "duration_ms": duration_ms,
        "processed_per_minute": round(totals["processed"] * 60_000 / duration_ms, 2) if duration_ms else 0.0,
        "published_per_minute": round(totals["published"] * 60_000 / duration_ms, 2) if duration_ms else 0.0,
        "publish_rate": _percentage(totals["published"], totals["processed"]),
        "reply_rate": _percentage(totals["replied"], totals["published"]),
        "parallel_efficiency": round(sender_duration_total / duration_ms, 2) if duration_ms else 0.0,
        "maximum_parallel": MAX_PARALLEL_COMMENT_TASKS,
        "unique_lead_count": len(lead_owners),
        "duplicate_lead_ids": sorted(duplicate_leads),
        "duplicate_lead_count": len(duplicate_leads),
        "totals": totals,
        "senders": senders,
    }
