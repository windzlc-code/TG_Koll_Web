"""Pure collection-policy helpers shared by CRM collection entry points.

This module deliberately contains no database, network, model, or clock side
effects.  Callers may inject ``reference_time`` and can therefore apply the
same policy in an API request, a worker, or a replay test.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
import re
import unicodedata
from typing import Any, Iterable, Mapping, Sequence


COLLECTION_LOOKBACK_OPTIONS = (1, 3, 7, 15, 30)
_TIMESTAMP_FIELDS = (
    "timestamp",
    "published_at",
    "publishedAt",
    "posted_at",
    "postedAt",
    "created_at",
    "createdAt",
)
_KEYWORD_KEYS = ("keywords", "search_keywords", "searchKeywords")
_KEYWORD_GROUP_KEYS = ("keyword_groups", "keywordGroups")
_KEYWORD_SPLIT = re.compile(r"[\n\r,，;；]+")


def normalize_collection_lookback_days(value: Any, fallback: int = 7) -> int:
    """Return one of the five supported rolling collection windows."""

    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        parsed = -1
    if parsed in COLLECTION_LOOKBACK_OPTIONS:
        return parsed
    return fallback if fallback in COLLECTION_LOOKBACK_OPTIONS else 7


def collection_time_range_label(value: Any) -> str:
    days = normalize_collection_lookback_days(value)
    return "最近 1 天" if days == 1 else f"最近 {days} 天"


def _reference_datetime(value: Any = None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)) and math.isfinite(float(value)):
        seconds = float(value)
        if abs(seconds) >= 100_000_000_000:
            seconds /= 1000
        try:
            parsed = datetime.fromtimestamp(seconds, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return datetime.now(timezone.utc)
    else:
        text = str(value or "").strip()
        if not text:
            return datetime.now(timezone.utc)
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)) and math.isfinite(float(value)):
        seconds = float(value)
        if abs(seconds) >= 100_000_000_000:
            seconds /= 1000
        try:
            parsed = datetime.fromtimestamp(seconds, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    else:
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


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def collection_cutoff_at(value: Any, reference_time: Any = None) -> str:
    """Return the inclusive UTC cutoff for a rolling lookback window."""

    days = normalize_collection_lookback_days(value)
    return _iso_utc(_reference_datetime(reference_time) - timedelta(days=days))


def filter_rows_by_collection_window(
    rows: Iterable[Mapping[str, Any]] | None,
    value: Any,
    reference_time: Any = None,
) -> dict[str, Any]:
    """Keep rows with a verifiable timestamp between the cutoff and now.

    Missing, malformed, and future timestamps are never silently admitted.
    The returned rows are the original mapping objects; this function does not
    mutate them.
    """

    source_rows = list(rows or ())
    days = normalize_collection_lookback_days(value)
    reference = _reference_datetime(reference_time)
    cutoff = reference - timedelta(days=days)
    accepted: list[Mapping[str, Any]] = []
    excluded_older = 0
    excluded_unknown = 0
    excluded_future = 0

    for row in source_rows:
        raw_timestamp = next(
            (row.get(field) for field in _TIMESTAMP_FIELDS if row.get(field) not in (None, "")),
            None,
        )
        timestamp = _parse_timestamp(raw_timestamp)
        if timestamp is None:
            excluded_unknown += 1
        elif timestamp > reference:
            excluded_future += 1
        elif timestamp < cutoff:
            excluded_older += 1
        else:
            accepted.append(row)

    return {
        "data": accepted,
        "lookback_days": days,
        "label": collection_time_range_label(days),
        "cutoff_at": _iso_utc(cutoff),
        "reference_at": _iso_utc(reference),
        "excluded_older": excluded_older,
        "excluded_unknown": excluded_unknown,
        "excluded_future": excluded_future,
        "inspected": len(source_rows),
    }


def _clean_keyword(value: Any, maximum: int = 120) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).replace("\x00", "").strip()
    return text[:maximum]


def _keyword_values(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield from (_clean_keyword(part) for part in _KEYWORD_SPLIT.split(value))
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        for item in value:
            yield from _keyword_values(item)


def _persona_keyword_values(persona: Mapping[str, Any] | None) -> Iterable[str]:
    if not isinstance(persona, Mapping):
        return
    for key in _KEYWORD_KEYS:
        yield from _keyword_values(persona.get(key))
    for key in _KEYWORD_GROUP_KEYS:
        groups = persona.get(key)
        if not isinstance(groups, Sequence) or isinstance(groups, (str, bytes, bytearray)):
            continue
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            for keyword_key in _KEYWORD_KEYS:
                yield from _keyword_values(group.get(keyword_key))


def collect_source_keywords(
    request_keywords: Any = None,
    model_keywords: Any = None,
    persona: Mapping[str, Any] | None = None,
    *,
    maximum: int = 120,
) -> list[str]:
    """Merge only caller, model, and explicit persona keyword sources.

    No industry vocabulary or synthetic fallback is added when those sources
    are empty.  Stable first-seen ordering makes caching and replay predictable.
    """

    result: list[str] = []
    seen: set[str] = set()
    values = (
        *_keyword_values(request_keywords),
        *_keyword_values(model_keywords),
        *_persona_keyword_values(persona),
    )
    for value in values:
        cleaned = _clean_keyword(value)
        identity = cleaned.casefold()
        if not cleaned or identity in seen:
            continue
        seen.add(identity)
        result.append(cleaned)
        if len(result) >= max(0, int(maximum)):
            break
    return result


def next_collection_lookback_days(value: Any) -> int:
    current = normalize_collection_lookback_days(value)
    index = COLLECTION_LOOKBACK_OPTIONS.index(current)
    return COLLECTION_LOOKBACK_OPTIONS[min(index + 1, len(COLLECTION_LOOKBACK_OPTIONS) - 1)]


def create_zero_result_recovery_plan(
    input_data: Mapping[str, Any] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """Plan at most one retry after an empty collection result.

    The retry expands only ``limit`` and the supported lookback window.  It
    reuses the existing keyword sources verbatim and never invents a vertical
    fallback.  ``expansion_count``/``attempt`` or ``already_expanded`` prevents
    a second expansion.
    """

    source = dict(input_data or {})
    source.update(overrides)
    result_count = max(0, int(source.get("result_count", source.get("resultCount", 0)) or 0))
    original_limit = max(1, min(10_000, int(source.get("limit", 30) or 30)))
    max_limit = max(original_limit, min(10_000, int(source.get("max_limit", 1000) or 1000)))
    original_lookback = normalize_collection_lookback_days(
        source.get("lookback_days", source.get("lookbackDays", 7))
    )
    expansion_count = max(
        0,
        int(source.get("expansion_count", source.get("expansionCount", source.get("attempt", 0))) or 0),
    )
    already_expanded = bool(source.get("already_expanded", source.get("alreadyExpanded", False))) or expansion_count >= 1
    expanded_limit = min(max_limit, max(original_limit + 1, original_limit * 2))
    expanded_lookback = next_collection_lookback_days(original_lookback)
    keywords = collect_source_keywords(
        source.get("request_keywords", source.get("requestKeywords", source.get("keywords"))),
        source.get("model_keywords", source.get("modelKeywords")),
        source.get("persona") if isinstance(source.get("persona"), Mapping) else None,
        maximum=int(source.get("maximum_keywords", source.get("maximumKeywords", 120)) or 120),
    )
    changed = expanded_limit > original_limit or expanded_lookback > original_lookback
    can_retry = result_count == 0 and not already_expanded and changed
    if result_count > 0:
        reason = "results_available"
    elif already_expanded:
        reason = "single_expansion_exhausted"
    elif not changed:
        reason = "expansion_limit_reached"
    else:
        reason = "zero_results"

    return {
        "attempt": expansion_count + 1 if can_retry else expansion_count,
        "can_retry": can_retry,
        "reason": reason,
        "original_limit": original_limit,
        "expanded_limit": expanded_limit,
        "original_lookback_days": original_lookback,
        "expanded_lookback_days": expanded_lookback,
        "keywords": keywords,
    }


# A descriptive alias for callers that assemble the policy before execution.
plan_zero_result_recovery = create_zero_result_recovery_plan
