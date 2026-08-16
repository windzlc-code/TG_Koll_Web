from datetime import datetime, timezone

from webapp.crm.task_watchdog import (
    classify_task_attention,
    manual_attention_for_task,
    task_activity_timestamp,
)


NOW = datetime(2026, 8, 16, 6, 0, tzinfo=timezone.utc).timestamp()


def test_watchdog_detects_platform_blockers_before_stale_thresholds():
    samples = (
        ("Threads login wall: sign in is required", "authentication_required"),
        ("captcha challenge requires security verification", "security_verification"),
        ("browser is logged in as someone_else, not expected_sender", "account_mismatch"),
        ("sender rotation protection is locked", "rotation_locked"),
    )
    for warning, code in samples:
        result = classify_task_attention(
            {"status": "running", "updatedAt": NOW, "warnings": [warning]},
            current_time=NOW,
        )
        assert result is not None
        assert result["code"] == code


def test_watchdog_detects_platform_moderation_from_structured_result_or_warning():
    structured = classify_task_attention(
        {
            "status": "running",
            "updatedAt": NOW,
            "result": {"moderationDetected": True, "moderationReason": "平台移除留言"},
        },
        current_time=NOW,
    )
    warning = classify_task_attention(
        {"status": "running", "updatedAt": NOW, "warnings": ["removed your comment as spam"]},
        current_time=NOW,
    )
    assert structured and structured["code"] == "platform_moderation_cooldown"
    assert structured["reason"] == "平台移除留言"
    assert warning and warning["code"] == "platform_moderation_cooldown"


def test_queued_and_running_tasks_use_120_and_240_second_defaults():
    queued = classify_task_attention(
        {"status": "queued", "created_at": NOW - 120},
        current_time=NOW,
    )
    running = classify_task_attention(
        {"status": "running", "last_activity_at": NOW - 240},
        current_time=NOW,
    )
    assert queued and queued["code"] == "task_stalled"
    assert queued["stale_for_seconds"] == 120
    assert running and running["code"] == "task_stalled"
    assert running["stale_for_seconds"] == 240


def test_latest_checkpoint_or_heartbeat_prevents_a_false_positive():
    task = {
        "status": "running",
        "updated_at": NOW - 600,
        "last_activity_at": NOW - 30,
        "batch_control": {"checkpoints": [{"finished_at": NOW - 45}]},
    }
    assert task_activity_timestamp(task) == NOW - 30
    assert classify_task_attention(task, current_time=NOW) is None


def test_manual_attention_preserves_existing_reason():
    result = manual_attention_for_task(
        {
            "status": "needs_attention",
            "error": "需要检查",
            "attention": {"code": "operator_review", "stale_for_seconds": 9},
        }
    )
    assert result == {
        "code": "operator_review",
        "reason": "需要检查",
        "source_text": "",
        "stale_for_seconds": 9,
    }
