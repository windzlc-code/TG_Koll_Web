from __future__ import annotations

import sqlite3

import pytest

from social_automation.runner import SUPPORTED_TASK_TYPES
from webapp.crm.errors import CRMError
from webapp.crm.platform_extensions import (
    prepare_instagram_group_create,
    prepare_relationship_verification,
    prepare_threads_community_post,
    relationship_rows_from_worker_evidence,
    runtime_support_report,
)


CURRENT_WORKER_TYPES = set(SUPPORTED_TASK_TYPES)


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
        INSERT INTO social_accounts VALUES
          ('ig-1',1,'instagram','Owner.One','ready','alive'),
          ('th-1',1,'threads','Owner.One','ready','alive'),
          ('ig-2',2,'instagram','Other.Owner','ready','alive'),
          ('ig-login',1,'instagram','Needs.Login','pending_login','unknown');
        INSERT INTO crm_leads VALUES
          ('lead-a',1,'Alpha.User',1),
          ('lead-b',1,'beta_user',1),
          ('lead-other',2,'other_user',1);
        """
    )
    return conn


def test_runtime_report_proves_exact_missing_native_worker_contracts() -> None:
    report = runtime_support_report(supported_task_types=CURRENT_WORKER_TYPES)
    assert report["operations"]["threads_community_post"]["enabled"] is True
    relationship = report["operations"]["relationship_verify"]
    assert relationship["enabled"] is True
    assert relationship["missing_task_types"] == []
    assert "/sender/verify-relationships" in relationship["legacy_routes"]
    group = report["operations"]["instagram_group_create"]
    assert group["enabled"] is True
    assert group["missing_task_types"] == []


def test_relationship_verify_uses_native_worker_and_never_browse_profile() -> None:
    conn = _db()
    task = prepare_relationship_verification(
        conn,
        user_id=1,
        account_id="ig-1",
        lead_ids=["lead-a", "lead-b"],
        supported_task_types=CURRENT_WORKER_TYPES,
    )
    assert task["task_type"] == "instagram_relationship_verify"
    assert task["task_type"] != "browse_profile"
    assert task["payload"]["read_only"] is True


def test_relationship_verify_builds_tenant_safe_read_only_worker_payload_once_supported() -> None:
    conn = _db()
    task = prepare_relationship_verification(
        conn,
        user_id=1,
        account_id="ig-1",
        lead_ids=["lead-b", "lead-a"],
        supported_task_types={*CURRENT_WORKER_TYPES, "instagram_relationship_verify"},
    )
    assert task == {
        "task_type": "instagram_relationship_verify",
        "platform": "instagram",
        "account_id": "ig-1",
        "payload": {
            "expected_username": "owner.one",
            "target_usernames": ["beta_user", "alpha.user"],
            "lead_ids": ["lead-b", "lead-a"],
            "read_only": True,
            "crm_relationship_verify": True,
        },
    }
    with pytest.raises(CRMError) as cross_tenant:
        prepare_relationship_verification(
            conn,
            user_id=1,
            account_id="ig-1",
            lead_ids=["lead-other"],
            supported_task_types={*CURRENT_WORKER_TYPES, "instagram_relationship_verify"},
        )
    assert cross_tenant.value.code == "crm_invalid_tenant_reference"


def test_instagram_group_requires_real_worker_confirmation_and_two_members() -> None:
    conn = _db()
    complete_worker = {
        *CURRENT_WORKER_TYPES,
        "instagram_group_candidates_inspect",
        "instagram_group_create",
    }
    with pytest.raises(CRMError) as unconfirmed:
        prepare_instagram_group_create(
            conn,
            user_id=1,
            account_id="ig-1",
            members=["alpha.user", "beta_user"],
            message="hello",
            confirmed=False,
            supported_task_types=complete_worker,
        )
    assert unconfirmed.value.code == "crm_confirmation_required"
    task = prepare_instagram_group_create(
        conn,
        user_id=1,
        account_id="ig-1",
        members=["@Alpha.User", "alpha.user", "Beta_User"],
        message=" hello ",
        confirmed=True,
        supported_task_types=CURRENT_WORKER_TYPES,
    )
    assert task["payload"]["members"] == ["alpha.user", "beta_user"]
    assert task["payload"]["confirmed"] is True


def test_threads_community_post_is_the_only_group_operation_current_worker_can_execute() -> None:
    conn = _db()
    action = prepare_threads_community_post(
        conn,
        user_id=1,
        account_id="th-1",
        content=" 邀请加入公开社群 ",
        confirmed=True,
        supported_task_types=CURRENT_WORKER_TYPES,
    )
    assert action["action_type"] == "threads_group_invite_post"
    assert action["write"] is True
    assert action["sku"] == "crm_group_invite_batch"
    assert action["payload"]["crm_operation"] == "threads_community_post"
    with pytest.raises(CRMError) as needs_login:
        prepare_threads_community_post(
            conn,
            user_id=1,
            account_id="ig-login",
            content="hello",
            confirmed=True,
            supported_task_types=CURRENT_WORKER_TYPES,
        )
    assert needs_login.value.code == "crm_account_platform_mismatch"


def test_relationship_evidence_requires_explicit_booleans_and_instagram_url() -> None:
    rows = relationship_rows_from_worker_evidence(
        {
            "ok": True,
            "results": [
                {
                    "targetUsername": "Alpha.User",
                    "profileFound": True,
                    "senderFollows": True,
                    "followsSender": True,
                    "inspectedUrl": "https://www.instagram.com/alpha.user/",
                },
                {
                    "targetUsername": "beta_user",
                    "profileFound": True,
                    "senderFollows": False,
                    "followsSender": False,
                    "inspectedUrl": "https://example.com/beta_user/",
                },
                {
                    "targetUsername": "unknown_user",
                    "profileFound": True,
                    "senderFollows": False,
                    "followsSender": False,
                    "inspectedUrl": "https://www.instagram.com/unknown_user/",
                },
            ],
        },
        account_id="ig-1",
        lead_ids_by_username={"alpha.user": "lead-a", "beta_user": "lead-b"},
        verified_at=123,
    )
    assert len(rows) == 1
    assert rows[0]["lead_id"] == "lead-a"
    assert rows[0]["status"] == "mutual"
    assert rows[0]["evidence"]["worker_evidence"] is True
