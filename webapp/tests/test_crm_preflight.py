from __future__ import annotations

import sqlite3

import pytest

from webapp.crm.errors import CRMError
from webapp.crm.preflight import build_preflight, verify_preflight_token


SECRET = "preflight-test-secret-with-at-least-32-characters"


@pytest.fixture()
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        CREATE TABLE social_accounts (
          id TEXT PRIMARY KEY,user_id INTEGER,status TEXT,health_status TEXT
        );
        CREATE TABLE crm_action_ledger (
          id TEXT PRIMARY KEY,workflow_id TEXT,user_id INTEGER,account_id TEXT,action_type TEXT,
          target_key TEXT,content_hash TEXT,state TEXT,created_at INTEGER
        );
        CREATE TABLE crm_events (
          id TEXT PRIMARY KEY,user_id INTEGER,lead_id TEXT DEFAULT '',event_type TEXT,occurred_at INTEGER,
          payload_json TEXT,active INTEGER,updated_at INTEGER DEFAULT 0
        );
        CREATE TABLE crm_relationships (
          id TEXT PRIMARY KEY,user_id INTEGER,lead_id TEXT,account_id TEXT,status TEXT,
          verified_at INTEGER,active INTEGER,updated_at INTEGER
        );
        INSERT INTO social_accounts VALUES ('acct',7,'ready','ready');
        INSERT INTO social_accounts VALUES ('login',7,'ready','needs_login');
        """
    )
    try:
        yield connection
    finally:
        connection.close()


def rate_lookup(_conn, sku):
    return 500, f"catalog:{sku}"


def test_preflight_signs_canonical_allowed_actions_and_quotes_once_per_sku(conn):
    actions = [
        {"action_type": "public_comment", "account_id": "acct", "target_key": "https://threads.test/1", "content": "你整理的实际案例很完整，尤其是执行顺序这一点很有参考价值。"},
        {"action_type": "public_comment", "account_id": "acct", "target_key": "https://threads.test/2", "content": "这里对成本变化的说明很清楚，也补足了常见讨论里缺少的条件。"},
    ]
    result = build_preflight(
        conn, user_id=7, actions=actions, secret=SECRET,
        rate_lookup=rate_lookup, current_time=100,
    )
    assert result["allowed_count"] == 2
    assert result["quote"]["total_points"] == 5
    payload = verify_preflight_token(
        result["preflight_token"], secret=SECRET, user_id=7,
        actions=result["actions"], current_time=101,
    )
    assert payload["allowed_count"] == 2


def test_preflight_blocks_cross_tenant_and_allows_trust_ready_direct_message(conn):
    with pytest.raises(CRMError) as cross_tenant:
        build_preflight(
            conn, user_id=8,
            actions=[{"action_type": "public_comment", "account_id": "acct", "target_key": "target", "content": "x"}],
            secret=SECRET, rate_lookup=rate_lookup, current_time=100,
        )
    assert cross_tenant.value.code == "crm_preflight_no_executable_actions"

    conn.execute(
        "INSERT INTO crm_relationships VALUES (?,?,?,?,?,?,?,?)",
        ("relationship-1", 7, "lead-1", "acct", "follows_sender", 90, 1, 90),
    )
    allowed = build_preflight(
        conn, user_id=7,
        actions=[{
            "action_type": "direct_message", "account_id": "acct", "target_key": "target",
            "content": "谢谢你之前的公开互动，想继续了解你最关心的方向。",
            "payload": {"lead_id": "lead-1"},
        }],
        secret=SECRET, rate_lookup=rate_lookup, current_time=100,
    )
    assert allowed["allowed_count"] == 1
    assert allowed["actions"][0]["sku"] == "crm_direct_message_batch"
    assert allowed["decisions"][0]["policy"]["trust"]["source"] == "verified_relationship"


def test_preflight_blocks_cold_direct_message_without_server_side_trust_evidence(conn):
    with pytest.raises(CRMError) as blocked:
        build_preflight(
            conn,
            user_id=7,
            actions=[{
                "action_type": "direct_message", "account_id": "acct", "target_key": "target",
                "content": "这是一条没有真实信任证据的冷私信内容。",
                "payload": {"lead_id": "cold-lead", "consent_verified": True},
            }],
            secret=SECRET,
            rate_lookup=rate_lookup,
            current_time=100,
        )
    decision = blocked.value.details["decisions"][0]
    assert decision["reason_code"] == "crm_direct_message_trust_evidence_required"


def test_preflight_allows_explicit_consent_event_and_ignores_first_touch_copy_limit(conn):
    conn.execute(
        "INSERT INTO crm_events(id,user_id,lead_id,event_type,occurred_at,payload_json,active,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("consent-1", 7, "lead-consent", "consent_verified", 95, "{}", 1, 95),
    )
    result = build_preflight(
        conn,
        user_id=7,
        actions=[{
            "action_type": "direct_message", "account_id": "acct", "target_key": "consented-target",
            "content": "已按你明确同意的内容发送后续资料。",
            "payload": {"lead_id": "lead-consent"},
        }],
        secret=SECRET,
        rate_lookup=rate_lookup,
        current_time=100,
    )
    assert result["allowed_count"] == 1
    assert result["decisions"][0]["policy"]["trust"]["source"] == "explicit_consent"


def test_preflight_blocks_promotional_first_message_even_with_relationship(conn):
    conn.execute(
        "INSERT INTO crm_relationships VALUES (?,?,?,?,?,?,?,?)",
        ("relationship-2", 7, "lead-2", "acct", "mutual", 90, 1, 90),
    )
    with pytest.raises(CRMError) as blocked:
        build_preflight(
            conn,
            user_id=7,
            actions=[{
                "action_type": "direct_message", "account_id": "acct", "target_key": "target-2",
                "content": "立即加入 https://example.test 获取最后名额",
                "payload": {"lead_id": "lead-2"},
            }],
            secret=SECRET,
            rate_lookup=rate_lookup,
            current_time=100,
        )
    decision = blocked.value.details["decisions"][0]
    assert decision["reason_code"] == "crm_direct_message_trust_first_message_content"


def test_preflight_applies_public_comment_content_policy(conn):
    with pytest.raises(CRMError) as blocked:
        build_preflight(
            conn,
            user_id=7,
            actions=[{
                "action_type": "public_comment",
                "account_id": "acct",
                "target_key": "https://threads.test/policy",
                "content": "加我 LINE：https://example.test",
            }],
            secret=SECRET,
            rate_lookup=rate_lookup,
            current_time=100,
        )
    decision = blocked.value.details["decisions"][0]
    assert decision["reason_code"] == "crm_public_comment_first_contact_information"
    assert decision["policy"]["content"]["allowed"] is False


def test_preflight_blocks_duplicate_comment_inside_same_request(conn):
    comment = "你整理的实际案例很完整，尤其是执行顺序这一点很有参考价值。"
    result = build_preflight(
        conn,
        user_id=7,
        actions=[
            {
                "action_type": "public_comment",
                "account_id": "acct",
                "target_key": "https://threads.test/batch-1",
                "content": comment,
            },
            {
                "action_type": "public_comment",
                "account_id": "acct",
                "target_key": "https://threads.test/batch-2",
                "content": comment,
            },
        ],
        secret=SECRET,
        rate_lookup=rate_lookup,
        current_time=100,
    )
    assert result["allowed_count"] == 1
    assert result["blocked_count"] == 1
    assert result["decisions"][1]["reason_code"] == "crm_public_comment_duplicate_comment"


def test_preflight_blocks_account_during_persisted_platform_moderation_cooldown(conn):
    conn.execute(
        "INSERT INTO crm_events(id,user_id,event_type,occurred_at,payload_json,active) VALUES (?,?,?,?,?,1)",
        (
            "moderation-1",
            7,
            "platform_moderation_detected",
            1_000,
            '{"account_id":"acct","sender_username":"acct","reason":"平台移除留言"}',
        ),
    )
    with pytest.raises(CRMError) as blocked:
        build_preflight(
            conn,
            user_id=7,
            actions=[{
                "action_type": "public_comment",
                "account_id": "acct",
                "target_key": "https://threads.test/moderated",
                "content": "你整理的案例很具体，执行顺序与风险条件都讲得很清楚。",
            }],
            secret=SECRET,
            rate_lookup=rate_lookup,
            current_time=1_100,
        )
    decision = blocked.value.details["decisions"][0]
    assert decision["reason_code"] == "crm_public_comment_platform_moderation_cooldown"
    assert decision["policy"]["rate"]["wait_seconds"] > 0


def test_preflight_detects_duplicate_and_login_gate(conn):
    import hashlib

    conn.execute(
        "INSERT INTO crm_action_ledger VALUES (?,?,?,?,?,?,?,?,?)",
        ("a1", "w1", 7, "acct", "public_comment", "target", hashlib.sha256(b"same").hexdigest(), "unknown", 1),
    )
    with pytest.raises(CRMError) as duplicate:
        build_preflight(
            conn, user_id=7,
            actions=[{"action_type": "public_comment", "account_id": "acct", "target_key": "target", "content": "same"}],
            secret=SECRET, rate_lookup=rate_lookup, current_time=100,
        )
    assert duplicate.value.details["decisions"][0]["reason_code"] == "crm_duplicate_action"

    with pytest.raises(CRMError) as login:
        build_preflight(
            conn, user_id=7,
            actions=[{"action_type": "public_comment", "account_id": "login", "target_key": "other", "content": "x"}],
            secret=SECRET, rate_lookup=rate_lookup, current_time=100,
        )
    assert login.value.details["decisions"][0]["reason_code"] == "crm_account_needs_login"


def test_direct_message_preflight_blocks_recipient_across_sender_rotation(conn):
    conn.execute(
        "INSERT INTO crm_action_ledger VALUES (?,?,?,?,?,?,?,?,?)",
        ("dm1", "w1", 7, "acct", "direct_message", "instagram:lead", "old-hash", "unknown", 1),
    )
    with pytest.raises(CRMError) as duplicate:
        build_preflight(
            conn, user_id=7,
            actions=[{
                "action_type": "direct_message", "account_id": "acct",
                "target_key": "instagram:lead", "content": "completely different copy",
            }],
            secret=SECRET, rate_lookup=rate_lookup, current_time=100,
        )
    assert duplicate.value.details["decisions"][0]["reason_code"] == "crm_duplicate_action"

    conn.execute("INSERT INTO social_accounts VALUES ('acct-2',7,'ready','ready')")
    with pytest.raises(CRMError) as rotated_duplicate:
        build_preflight(
            conn, user_id=7,
            actions=[{
                "action_type": "direct_message", "account_id": "acct-2",
                "target_key": "instagram:lead", "content": "sender rotation must not duplicate the recipient",
            }],
            secret=SECRET, rate_lookup=rate_lookup, current_time=100,
        )
    assert rotated_duplicate.value.details["decisions"][0]["reason_code"] == "crm_duplicate_action"


def test_preflight_token_rejects_action_change_and_expiry(conn):
    result = build_preflight(
        conn, user_id=7,
        actions=[{"action_type": "public_comment", "account_id": "acct", "target_key": "target", "content": "这条内容把实际限制讲得很清楚，特别是前后条件之间的关系。"}],
        secret=SECRET, rate_lookup=rate_lookup, current_time=100, ttl_seconds=60,
    )
    changed = [dict(result["actions"][0], content="changed")]
    with pytest.raises(CRMError) as altered:
        verify_preflight_token(result["preflight_token"], secret=SECRET, user_id=7, actions=changed, current_time=101)
    assert altered.value.code == "crm_preflight_invalid"
    with pytest.raises(CRMError):
        verify_preflight_token(result["preflight_token"], secret=SECRET, user_id=7, actions=result["actions"], current_time=161)


def test_copy_link_share_is_blocked_before_billing_reservation(conn):
    with pytest.raises(CRMError) as blocked:
        build_preflight(
            conn,
            user_id=7,
            actions=[{
                "action_type": "share",
                "account_id": "acct",
                "target_key": "https://threads.test/share-only-copies-link",
                "content": "",
            }],
            secret=SECRET,
            rate_lookup=rate_lookup,
            current_time=100,
        )
    assert blocked.value.code == "crm_preflight_no_executable_actions"
    assert blocked.value.details["decisions"][0]["reason_code"] == "crm_action_blocked"
