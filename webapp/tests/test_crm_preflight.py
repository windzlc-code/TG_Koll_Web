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
        {"action_type": "public_comment", "account_id": "acct", "target_key": "https://threads.test/1", "content": "hello"},
        {"action_type": "public_comment", "account_id": "acct", "target_key": "https://threads.test/2", "content": "hello"},
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


def test_preflight_blocks_cross_tenant_and_allows_native_direct_message(conn):
    with pytest.raises(CRMError) as cross_tenant:
        build_preflight(
            conn, user_id=8,
            actions=[{"action_type": "public_comment", "account_id": "acct", "target_key": "target", "content": "x"}],
            secret=SECRET, rate_lookup=rate_lookup, current_time=100,
        )
    assert cross_tenant.value.code == "crm_preflight_no_executable_actions"

    allowed = build_preflight(
        conn, user_id=7,
        actions=[{"action_type": "direct_message", "account_id": "acct", "target_key": "target", "content": "x"}],
        secret=SECRET, rate_lookup=rate_lookup, current_time=100,
    )
    assert allowed["allowed_count"] == 1
    assert allowed["actions"][0]["sku"] == "crm_direct_message_batch"


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


def test_direct_message_preflight_blocks_same_account_recipient_even_when_copy_changes(conn):
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
    allowed = build_preflight(
        conn, user_id=7,
        actions=[{
            "action_type": "direct_message", "account_id": "acct-2",
            "target_key": "instagram:lead", "content": "different sender is a distinct rotation slot",
        }],
        secret=SECRET, rate_lookup=rate_lookup, current_time=100,
    )
    assert allowed["allowed_count"] == 1


def test_preflight_token_rejects_action_change_and_expiry(conn):
    result = build_preflight(
        conn, user_id=7,
        actions=[{"action_type": "public_comment", "account_id": "acct", "target_key": "target", "content": "x"}],
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
