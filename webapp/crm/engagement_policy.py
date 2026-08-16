from __future__ import annotations

import math
import random
import re
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping


PUBLIC_COMMENT_MIN_INTERVAL_SECONDS = 3 * 60
PUBLIC_COMMENT_JITTER_SECONDS = 2 * 60
PUBLIC_COMMENT_MAX_PER_HOUR = 6
PUBLIC_COMMENT_MAX_PER_DAY = 24
PLATFORM_MODERATION_COOLDOWN_SECONDS = 24 * 60 * 60

# Millisecond aliases make the policy values unambiguous when adapting the
# original Node implementation, while the Python API below uses seconds.
PUBLIC_COMMENT_MIN_INTERVAL_MS = PUBLIC_COMMENT_MIN_INTERVAL_SECONDS * 1000
PUBLIC_COMMENT_JITTER_MS = PUBLIC_COMMENT_JITTER_SECONDS * 1000
PLATFORM_MODERATION_COOLDOWN_MS = PLATFORM_MODERATION_COOLDOWN_SECONDS * 1000

_MODERATION_PATTERN = re.compile(
    r"spam|junk message|removed your (?:comment|reply)|community standards|"
    r"community guidelines|policy violation|我们已移除你的(?:留言|回复|回覆)|"
    r"已移除你的(?:留言|回复|回覆)|垃圾讯息|垃圾訊息|违反.*社群|違反.*社群|"
    r"社群(?:守则|守則|规范|規範)|讯息.*限制|訊息.*限制",
    re.IGNORECASE,
)
_TOUCH_EVENT_TYPES = frozenset({"engagement_touch_published", "engagement_touch_submitted"})


def normalize_policy_sender(value: Any) -> str:
    return str(value or "").lstrip("@").strip().lower()


def is_platform_moderation_warning(value: Any) -> bool:
    return bool(_MODERATION_PATTERN.search(str(value or "")))


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _field(value: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in value and value[name] not in (None, ""):
            return value[name]
    return None


def _timestamp(value: Any) -> float:
    if isinstance(value, datetime):
        parsed = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        number = float(value)
        return number / 1000 if abs(number) >= 100_000_000_000 else number
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        number = float(text)
    except ValueError:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    return number / 1000 if abs(number) >= 100_000_000_000 else number


def _event_at(event: Mapping[str, Any]) -> float:
    return _timestamp(_field(event, "created_at", "createdAt", "updated_at", "updatedAt", "detected_at", "detectedAt", "occurred_at", "occurredAt"))


def _sender_matches(event: Mapping[str, Any], sender_key: str) -> bool:
    detail = _mapping(event.get("detail"))
    payload = _mapping(event.get("payload"))
    sender = (
        _field(event, "sender_username", "senderUsername", "sender_account", "senderAccount")
        or _field(detail, "sender_username", "senderUsername", "sender_account", "senderAccount")
        or _field(payload, "sender_username", "senderUsername", "sender_account", "senderAccount")
    )
    return normalize_policy_sender(sender) == sender_key


def _event_moderation_text(event: Mapping[str, Any]) -> str:
    detail = _mapping(event.get("detail"))
    payload = _mapping(event.get("payload"))
    return str(
        _field(event, "reason", "error")
        or _field(detail, "reason", "error")
        or _field(payload, "reason", "error")
        or ""
    )


def _iso_utc(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _decision(
    *,
    allowed: bool,
    reason: str,
    retry_at: float = 0,
    wait_seconds: float = 0,
    hourly_count: int,
    daily_count: int,
) -> dict[str, Any]:
    wait = max(0, int(math.ceil(wait_seconds)))
    return {
        "allowed": allowed,
        "reason": reason,
        "retry_at": _iso_utc(retry_at) if retry_at else "",
        "wait_seconds": wait,
        "wait_ms": wait * 1000,
        "hourly_count": hourly_count,
        "daily_count": daily_count,
    }


def evaluate_public_comment_rate(
    *,
    events: Iterable[Mapping[str, Any]] = (),
    sender_username: str = "",
    current_time: float | datetime | None = None,
    now_ms: float | None = None,
) -> dict[str, Any]:
    """Evaluate the per-sender public-comment gate without reading or writing state."""

    now = _timestamp(now_ms) if now_ms is not None else _timestamp(
        current_time if current_time is not None else datetime.now(timezone.utc)
    )
    sender_key = normalize_policy_sender(sender_username)
    sender_events = [event for event in events if isinstance(event, Mapping) and _sender_matches(event, sender_key)]

    moderation_events = [
        event
        for event in sender_events
        if _field(event, "type", "event_type", "eventType") == "platform_moderation_detected"
        or is_platform_moderation_warning(_event_moderation_text(event))
    ]
    moderation_at = max((_event_at(event) for event in moderation_events), default=0.0)
    moderation_retry = moderation_at + PLATFORM_MODERATION_COOLDOWN_SECONDS
    if moderation_at and now < moderation_retry:
        return _decision(
            allowed=False,
            reason="platform_moderation_cooldown",
            retry_at=moderation_retry,
            wait_seconds=moderation_retry - now,
            hourly_count=0,
            daily_count=0,
        )

    touches = sorted(
        (
            _event_at(event)
            for event in sender_events
            if _field(event, "type", "event_type", "eventType") in _TOUCH_EVENT_TYPES
        ),
        reverse=True,
    )
    touches = [timestamp for timestamp in touches if timestamp > 0]
    hourly = [timestamp for timestamp in touches if 0 <= now - timestamp < 60 * 60]
    daily = [timestamp for timestamp in touches if 0 <= now - timestamp < 24 * 60 * 60]
    if len(daily) >= PUBLIC_COMMENT_MAX_PER_DAY:
        retry_at = min(daily) + 24 * 60 * 60
        return _decision(
            allowed=False,
            reason="daily_public_comment_limit",
            retry_at=retry_at,
            wait_seconds=retry_at - now,
            hourly_count=len(hourly),
            daily_count=len(daily),
        )
    if len(hourly) >= PUBLIC_COMMENT_MAX_PER_HOUR:
        retry_at = min(hourly) + 60 * 60
        return _decision(
            allowed=False,
            reason="hourly_public_comment_limit",
            retry_at=retry_at,
            wait_seconds=retry_at - now,
            hourly_count=len(hourly),
            daily_count=len(daily),
        )

    last_touch_at = touches[0] if touches else 0.0
    retry_at = last_touch_at + PUBLIC_COMMENT_MIN_INTERVAL_SECONDS if last_touch_at else 0.0
    wait_seconds = max(0.0, retry_at - now) if retry_at else 0.0
    return _decision(
        allowed=wait_seconds == 0,
        reason="minimum_interval" if wait_seconds else "ready",
        retry_at=retry_at if wait_seconds else 0,
        wait_seconds=wait_seconds,
        hourly_count=len(hourly),
        daily_count=len(daily),
    )


def next_public_comment_delay(
    base_pause_seconds: float = PUBLIC_COMMENT_MIN_INTERVAL_SECONDS,
    random_value: float | None = None,
) -> int:
    """Return the 3-minute minimum plus a bounded 0-2 minute jitter."""

    requested = max(0.0, float(base_pause_seconds or 0))
    sample = random.random() if random_value is None else float(random_value)
    bounded = max(0.0, min(1.0, sample))
    return round(max(PUBLIC_COMMENT_MIN_INTERVAL_SECONDS, requested) + PUBLIC_COMMENT_JITTER_SECONDS * bounded)


__all__ = [
    "PLATFORM_MODERATION_COOLDOWN_MS",
    "PLATFORM_MODERATION_COOLDOWN_SECONDS",
    "PUBLIC_COMMENT_JITTER_MS",
    "PUBLIC_COMMENT_JITTER_SECONDS",
    "PUBLIC_COMMENT_MAX_PER_DAY",
    "PUBLIC_COMMENT_MAX_PER_HOUR",
    "PUBLIC_COMMENT_MIN_INTERVAL_MS",
    "PUBLIC_COMMENT_MIN_INTERVAL_SECONDS",
    "evaluate_public_comment_rate",
    "is_platform_moderation_warning",
    "next_public_comment_delay",
    "normalize_policy_sender",
]
