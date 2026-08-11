from __future__ import annotations

import sqlite3

from webapp.crm.service import (
    _normalized_action_evidence,
    _record_confirmed_action_event,
    _write_result_confirmed,
)


def test_billed_write_requires_platform_proof():
    assert _write_result_confirmed("public_comment", {"ok": True}) is False
    assert _write_result_confirmed(
        "public_comment",
        {
            "verified": True,
            "platform_visible": True,
            "confirmation_source": "exact_text_after_reload",
        },
    ) is True
    assert _write_result_confirmed(
        "direct_message",
        {"verified": True, "conversation_url": "https://www.threads.net/direct/t/1"},
    ) is True


def test_evidence_contains_authenticated_screenshot_url():
    evidence = _normalized_action_evidence(
        "social-1",
        {
            "verified": True,
            "platform_visible": True,
            "inspected_url": "https://www.threads.net/@source/post/abc",
            "screenshot_path": "/data/social_automation/screenshots/comment proof.png",
        },
    )
    assert evidence["platform_url"] == "https://www.threads.net/@source/post/abc"
    assert evidence["screenshot_url"] == "/api/persona_dashboard/automation/screenshots/comment%20proof.png"
    assert evidence["result"]["verified"] is True


def test_confirmed_action_event_is_idempotent():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE crm_events(
          id TEXT PRIMARY KEY,user_id INTEGER,lead_id TEXT,workflow_id TEXT,event_type TEXT,
          occurred_at INTEGER,payload_json TEXT,import_batch_id TEXT,active INTEGER,
          legacy_id TEXT,legacy_payload_json TEXT,schema_version INTEGER,created_at INTEGER,updated_at INTEGER
        )
        """
    )
    request = dict(
        user_id=7,
        workflow_id="workflow-1",
        action_id="action-1",
        action_type="public_comment",
        account_id="account-1",
        target_key="https://www.threads.net/@source/post/abc",
        payload={"lead_id": "lead-1", "_social_task_id": "social-1"},
        result={"verified": True, "platform_visible": True},
    )
    _record_confirmed_action_event(conn, **request)
    _record_confirmed_action_event(conn, **request)

    row = conn.execute("SELECT COUNT(*) AS count,event_type FROM crm_events").fetchone()
    assert row[0] == 1
    assert row[1] == "public_comment_confirmed"
