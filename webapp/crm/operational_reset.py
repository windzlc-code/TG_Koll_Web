"""Pure planning and transformation helpers for CRM operational resets."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Mapping


OPERATIONAL_RESET_CONFIRMATION = "CLEAR_ALL_TASKS_AND_CUSTOMERS"
OPERATIONAL_COLLECTIONS = (
    "tasks",
    "pools",
    "events",
    "hotspots",
    "relationships",
)
ACTIVE_TASK_STATUSES = frozenset(
    {"queued", "running", "paused", "needs_attention", "awaiting_batch_confirmation"}
)


def _collection_count(value: Any) -> int:
    return len(value) if isinstance(value, (list, tuple, dict, set, frozenset)) else 0


def _sender_settings_count(state: Mapping[str, Any]) -> int:
    settings = state.get("settings")
    if not isinstance(settings, Mapping):
        return 0
    senders = settings.get("senders")
    return len(senders) if isinstance(senders, (list, tuple)) else 0


def create_operational_reset_plan(
    state: Mapping[str, Any] | None,
    *,
    confirmed: bool,
    confirmation: Any,
) -> dict[str, Any]:
    """Describe an operational reset without mutating the provided state."""

    source = state if isinstance(state, Mapping) else {}
    accepted = confirmed is True and str(confirmation or "").strip() == OPERATIONAL_RESET_CONFIRMATION
    tasks = source.get("tasks") if isinstance(source.get("tasks"), (list, tuple)) else ()
    active_task_ids = [
        str(task.get("id", "") or "")
        for task in tasks
        if isinstance(task, Mapping)
        and str(task.get("status", "") or "").casefold() in ACTIVE_TASK_STATUSES
        and str(task.get("id", "") or "")
    ]
    cleared = {key: _collection_count(source.get(key)) for key in OPERATIONAL_COLLECTIONS}
    preserved = {
        "templates": _collection_count(source.get("templates")),
        "sender_settings": _sender_settings_count(source),
    }
    return {
        "allowed": accepted,
        "reason": "confirmed" if accepted else "confirmation_required",
        "confirmation_token": OPERATIONAL_RESET_CONFIRMATION,
        "cleared": cleared,
        "preserved": preserved,
        "active_task_ids_to_stop": active_task_ids,
        "operational_collections": list(OPERATIONAL_COLLECTIONS),
    }


def apply_operational_reset(
    state: Mapping[str, Any] | None,
    *,
    confirmed: bool,
    confirmation: Any,
    reset_at: Any = None,
) -> dict[str, Any]:
    """Return a reset copy while preserving templates, settings, and unknown keys.

    A caller should stop the task ids from ``plan.active_task_ids_to_stop`` in
    its live worker registry before committing the returned state.  The input
    object is never modified.
    """

    source = state if isinstance(state, Mapping) else {}
    plan = create_operational_reset_plan(
        source,
        confirmed=confirmed,
        confirmation=confirmation,
    )
    if not plan["allowed"]:
        return {"ok": False, "state": deepcopy(dict(source)), "plan": plan, "reset_at": ""}

    clean_state = deepcopy(dict(source))
    for key in OPERATIONAL_COLLECTIONS:
        clean_state[key] = []
    timestamp = str(reset_at or "").strip()
    if not timestamp:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    clean_state["updatedAt"] = timestamp
    return {
        "ok": True,
        "state": clean_state,
        "plan": plan,
        "cleared": plan["cleared"],
        "preserved": plan["preserved"],
        "reset_at": timestamp,
    }
