from __future__ import annotations

import json
import sqlite3
from unittest import mock

import pytest
from fastapi import HTTPException

from webapp import social_automation_api


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE social_accounts(
          id TEXT PRIMARY KEY,user_id INTEGER,platform TEXT,username TEXT,
          status TEXT,health_status TEXT
        );
        CREATE TABLE crm_leads(
          id TEXT PRIMARY KEY,user_id INTEGER,username TEXT,active INTEGER
        );
        CREATE TABLE crm_relationships(
          id TEXT PRIMARY KEY,user_id INTEGER,lead_id TEXT,account_id TEXT,
          relationship_type TEXT,status TEXT,verified_at INTEGER,evidence_json TEXT,
          import_batch_id TEXT,active INTEGER,legacy_id TEXT,legacy_payload_json TEXT,
          schema_version INTEGER,created_at INTEGER,updated_at INTEGER
        );
        INSERT INTO social_accounts VALUES
          ('ig-1',1,'instagram','Owner.One','ready','alive'),
          ('ig-other',2,'instagram','Other.Owner','ready','alive');
        INSERT INTO crm_leads VALUES
          ('lead-a',1,'alpha.user',1),
          ('lead-b',1,'beta_user',1),
          ('lead-other',2,'other_user',1);
        """
    )
    return conn


def test_payload_validator_strips_untrusted_fields_and_forces_zero_write_semantics() -> None:
    conn = _db()
    account = conn.execute("SELECT * FROM social_accounts WHERE id='ig-1'").fetchone()
    clean = social_automation_api._validate_instagram_relationship_verify_payload(
        {
            "expectedUsername": "@Owner.One",
            "targetUsernames": ["@Alpha.User", "beta_user"],
            "lead_ids": ["lead-a", "lead-b"],
            "crm_relationship_verify": True,
            "password": "must-not-persist",
            "confirmed": True,
        },
        account=account,
    )
    assert clean == {
        "expected_username": "owner.one",
        "target_usernames": ["alpha.user", "beta_user"],
        "read_only": True,
        "lead_ids": ["lead-a", "lead-b"],
        "crm_relationship_verify": True,
    }


def test_payload_validator_rejects_sender_mismatch_and_duplicate_targets() -> None:
    conn = _db()
    account = conn.execute("SELECT * FROM social_accounts WHERE id='ig-1'").fetchone()
    with pytest.raises(HTTPException) as mismatch:
        social_automation_api._validate_instagram_relationship_verify_payload(
            {"expected_username": "other", "target_usernames": ["alpha.user"]},
            account=account,
        )
    assert mismatch.value.status_code == 409
    with pytest.raises(HTTPException) as duplicate:
        social_automation_api._validate_instagram_relationship_verify_payload(
            {"target_usernames": ["alpha.user", "@Alpha.User"]},
            account=account,
        )
    assert duplicate.value.status_code == 422


def test_persistence_writes_proved_and_unknown_rows_without_cross_tenant_leaks() -> None:
    conn = _db()
    task = {
        "id": "social-rel-1",
        "task_type": "instagram_relationship_verify",
        "user_id": 1,
        "account_id": "ig-1",
    }
    payload = {
        "crm_relationship_verify": True,
        "target_usernames": ["alpha.user", "beta_user"],
        "lead_ids": ["lead-a", "lead-b"],
    }
    result = {
        "ok": True,
        "results": [
            {
                "target_username": "alpha.user",
                "profile_found": True,
                "sender_follows": True,
                "follows_sender": True,
                "status": "mutual",
                "inspected_url": "https://www.instagram.com/alpha.user/",
                "screenshot_path": "alpha.png",
            },
            {
                "target_username": "beta_user",
                "profile_found": None,
                "sender_follows": None,
                "follows_sender": None,
                "status": "unknown",
                "reason_code": "profile_evidence_incomplete",
                "inspected_url": "https://www.instagram.com/beta_user/",
                "screenshot_path": "beta.png",
            },
        ],
    }
    written = social_automation_api._persist_crm_relationship_evidence_in_transaction(
        conn,
        task=task,
        payload=payload,
        result=result,
        verified_at=123,
    )
    assert written == 2
    rows = conn.execute(
        "SELECT lead_id,status,evidence_json FROM crm_relationships ORDER BY lead_id"
    ).fetchall()
    assert [(row["lead_id"], row["status"]) for row in rows] == [
        ("lead-a", "mutual"),
        ("lead-b", "unknown"),
    ]
    unknown_evidence = json.loads(rows[1]["evidence_json"])
    assert unknown_evidence["worker_evidence"] is False
    assert unknown_evidence["retryable"] is False
    assert unknown_evidence["reason_code"] == "profile_evidence_incomplete"

    with pytest.raises(RuntimeError, match="crosses tenant"):
        social_automation_api._persist_crm_relationship_evidence_in_transaction(
            conn,
            task=task,
            payload={
                "crm_relationship_verify": True,
                "target_usernames": ["other_user"],
                "lead_ids": ["lead-other"],
            },
            result={"ok": True, "results": []},
            verified_at=124,
        )


def test_crm_queue_adapter_is_free_zero_retry_and_idempotent_for_active_targets() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE social_accounts(
          id TEXT PRIMARY KEY,user_id INTEGER,persona_id TEXT,platform TEXT,
          username TEXT,status TEXT,health_status TEXT
        );
        CREATE TABLE social_automation_tasks(
          id TEXT PRIMARY KEY,user_id INTEGER,persona_id TEXT,account_id TEXT,
          platform TEXT,task_type TEXT,priority INTEGER,status TEXT,scheduled_at INTEGER,
          payload_json TEXT,result_json TEXT,max_retries INTEGER,
          billing_reservation_id TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER
        );
        INSERT INTO social_accounts VALUES
          ('ig-1',1,'persona-1','instagram','Owner.One','ready','alive');
        """
    )
    request = {
        "user_id": 1,
        "account_id": "ig-1",
        "payload": {
            "expected_username": "owner.one",
            "target_usernames": ["alpha.user"],
            "lead_ids": ["lead-a"],
            "crm_relationship_verify": True,
        },
    }
    conn.execute("BEGIN IMMEDIATE")
    with (
        mock.patch.object(social_automation_api, "_require_active_owner_user"),
        mock.patch.object(social_automation_api, "_insert_log"),
    ):
        first = social_automation_api.create_crm_relationship_task_in_transaction(conn, request)
        second = social_automation_api.create_crm_relationship_task_in_transaction(conn, request)
    assert first["reused"] is False
    assert second == {"social_task_id": first["social_task_id"], "status": "queued", "reused": True}
    row = conn.execute("SELECT * FROM social_automation_tasks").fetchone()
    assert row["task_type"] == "instagram_relationship_verify"
    assert row["max_retries"] == 0
    assert row["billing_reservation_id"] == ""
    assert row["created_by"] == "crm"
