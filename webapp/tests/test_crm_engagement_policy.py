from datetime import datetime, timezone

from webapp.crm.engagement_policy import (
    evaluate_public_comment_rate,
    next_public_comment_delay,
)


NOW = datetime(2026, 8, 16, 6, 0, tzinfo=timezone.utc).timestamp()


def _event(seconds_ago, *, sender="sender", event_type="engagement_touch_published", reason=""):
    return {
        "type": event_type,
        "senderUsername": sender,
        "createdAt": datetime.fromtimestamp(NOW - seconds_ago, tz=timezone.utc).isoformat(),
        "reason": reason,
    }


def test_public_comment_delay_is_three_minutes_plus_zero_to_two_minute_jitter():
    assert next_public_comment_delay(0, 0) == 180
    assert next_public_comment_delay(10, 0.5) == 240
    assert next_public_comment_delay(180, 1) == 300


def test_rate_limits_are_scoped_to_the_normalized_sender():
    events = [_event(60 * index, sender="@Sender") for index in range(1, 7)]
    events.extend(_event(10, sender="other") for _ in range(30))
    decision = evaluate_public_comment_rate(events=events, sender_username="sender", current_time=NOW)
    assert decision["allowed"] is False
    assert decision["reason"] == "hourly_public_comment_limit"
    assert decision["hourly_count"] == 6
    assert decision["daily_count"] == 6


def test_daily_limit_and_minimum_interval_are_enforced():
    daily = [_event(3700 + 60 * index) for index in range(24)]
    assert evaluate_public_comment_rate(events=daily, sender_username="sender", current_time=NOW)["reason"] == "daily_public_comment_limit"

    recent = evaluate_public_comment_rate(events=[_event(30)], sender_username="sender", current_time=NOW)
    assert recent["reason"] == "minimum_interval"
    assert recent["wait_seconds"] == 150


def test_platform_moderation_stops_the_sender_for_24_hours_before_other_limits():
    events = [
        _event(
            60,
            event_type="platform_moderation_detected",
            reason="We removed your comment because it may be spam",
        ),
        *[_event(120 + index) for index in range(24)],
    ]
    decision = evaluate_public_comment_rate(events=events, sender_username="sender", current_time=NOW)
    assert decision["reason"] == "platform_moderation_cooldown"
    assert decision["wait_seconds"] == 24 * 60 * 60 - 60

