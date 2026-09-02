from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import HTTPException

from webapp import db as db_module
from webapp import social_automation_api
from webapp.crm.errors import CRMError
from webapp.crm.preflight import build_preflight


@pytest.fixture()
def group_db():
    previous_db = os.environ.get("APP_DB_PATH")
    previous_data = os.environ.get("WEBAPP_DATA_DIR")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        os.environ["APP_DB_PATH"] = str(root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(root)
        social_automation_api.configure_social_automation(data_dir=root)
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            owner_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('group-owner','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            foreign_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('group-foreign','x',0,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('ig-owner',?,'persona','instagram','owner.one',?,'ready','alive',?,?)",
                (owner_id, str(root / "profile"), now, now),
            )
            for pool_id, user_id, active in (
                ("pool-active", owner_id, 1),
                ("pool-inactive", owner_id, 0),
                ("pool-foreign", foreign_id, 1),
            ):
                conn.execute(
                    "INSERT INTO crm_pools(id,user_id,name,description,tags_json,snapshot_json,active,created_at,updated_at) "
                    "VALUES (?,?,?,'','[]','{}',?,?,?)",
                    (pool_id, user_id, pool_id, active, now, now),
                )
            leads = (
                ("ig-alpha", owner_id, "instagram", "Alpha.User", 1),
                ("ig-beta", owner_id, "instagram", "beta_user", 1),
                ("ig-gamma", owner_id, "instagram", "gamma.user", 1),
                ("thread-alpha", owner_id, "threads", "thread.alpha", 1),
                ("ig-inactive", owner_id, "instagram", "inactive.user", 0),
                ("ig-not-member", owner_id, "instagram", "outside.user", 1),
                ("ig-foreign", foreign_id, "instagram", "foreign.user", 1),
            )
            for lead_id, user_id, platform, username, active in leads:
                conn.execute(
                    "INSERT INTO crm_leads(id,user_id,platform,platform_user_key,username,display_name,stage,score,tags_json,profile_json,active,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,'','new',0,'[]','{}',?,?,?)",
                    (lead_id, user_id, platform, username, username, active, now, now),
                )
            for lead_id, active in (
                ("ig-alpha", 1),
                ("ig-beta", 1),
                ("ig-gamma", 1),
                ("thread-alpha", 1),
                ("ig-inactive", 1),
                ("ig-not-member", 0),
            ):
                conn.execute(
                    "INSERT INTO crm_pool_members(user_id,pool_id,lead_id,status,source,active,created_at,updated_at) "
                    "VALUES (?,?,?,'active','test',?,?,?)",
                    (owner_id, "pool-active", lead_id, active, now, now),
                )
        yield root, owner_id, foreign_id
    if previous_db is None:
        os.environ.pop("APP_DB_PATH", None)
    else:
        os.environ["APP_DB_PATH"] = previous_db
    if previous_data is None:
        os.environ.pop("WEBAPP_DATA_DIR", None)
    else:
        os.environ["WEBAPP_DATA_DIR"] = previous_data


def _group_action() -> dict:
    return {
        "action_type": "instagram_group_create",
        "account_id": "ig-owner",
        "target_key": "instagram:direct:new:pool-active",
        "content": "welcome",
        "payload": {
            "confirmed": True,
            "pool_id": "pool-active",
            "members": ["@Alpha.User", "beta_user"],
            "lead_ids": ["ig-alpha", "ig-beta"],
            "message": "welcome",
        },
    }


def _preflight(conn, owner_id: int, action: dict) -> dict:
    return build_preflight(
        conn,
        user_id=owner_id,
        actions=[action],
        secret="group-target-validation-secret-32-bytes",
        rate_lookup=lambda _conn, _sku: (1, "catalog"),
        current_time=1_700_000_100,
    )


def test_preflight_accepts_only_ordered_active_instagram_pool_members(group_db) -> None:
    _root, owner_id, _foreign_id = group_db
    with db_module.db() as conn:
        result = _preflight(conn, owner_id, _group_action())
    assert result["allowed_count"] == 1
    assert result["decisions"][0]["allowed"] is True


@pytest.mark.parametrize(
    ("mutate", "expected_reason"),
    [
        (lambda payload: payload.update(members=["alpha.user"], lead_ids=["ig-alpha"]), "member_count"),
        (lambda payload: payload.update(members=[f"member{index}" for index in range(11)], lead_ids=[f"lead{index}" for index in range(11)]), "member_count"),
        (lambda payload: payload.update(lead_ids=["ig-alpha"]), "parallel_lists"),
        (lambda payload: payload.update(members=["alpha.user", "alpha.user"], lead_ids=["ig-alpha", "ig-beta"]), "duplicate_members"),
        (lambda payload: payload.update(lead_ids=["ig-alpha", "ig-alpha"]), "duplicate_lead_ids"),
        (lambda payload: payload.update(pool_id="pool-inactive"), "pool_unavailable"),
        (lambda payload: payload.update(lead_ids=["ig-alpha", "ig-foreign"], members=["alpha.user", "foreign.user"]), "inactive_or_foreign_membership"),
        (lambda payload: payload.update(lead_ids=["ig-alpha", "ig-not-member"], members=["alpha.user", "outside.user"]), "inactive_or_foreign_membership"),
        (lambda payload: payload.update(lead_ids=["ig-alpha", "ig-inactive"], members=["alpha.user", "inactive.user"]), "inactive_or_foreign_membership"),
        (lambda payload: payload.update(lead_ids=["ig-alpha", "thread-alpha"], members=["alpha.user", "thread.alpha"]), "platform_mismatch"),
        (lambda payload: payload.update(members=["beta_user", "alpha.user"]), "username_mismatch"),
    ],
)
def test_preflight_rejects_untrusted_group_target_references(group_db, mutate, expected_reason: str) -> None:
    _root, owner_id, _foreign_id = group_db
    action = deepcopy(_group_action())
    mutate(action["payload"])
    with db_module.db() as conn, pytest.raises(CRMError) as caught:
        _preflight(conn, owner_id, action)
    assert caught.value.code == "crm_preflight_no_executable_actions"
    decision = caught.value.details["decisions"][0]
    assert decision["reason_code"] == "crm_instagram_group_targets_invalid"
    assert decision["policy"]["instagram_group_targets"]["reason"] == expected_reason


def _insert_dispatch_contract(conn, *, owner_id: int, suffix: str, action_type: str = "instagram_group_create") -> dict:
    now = 1_700_000_200
    workflow_id = f"workflow-{suffix}"
    step_id = f"step-{suffix}"
    action_id = f"action-{suffix}"
    reservation_id = f"bill-{suffix}"
    conn.execute(
        "INSERT INTO crm_workflows(id,user_id,workflow_type,title,status,input_json,result_json,confirmation_json,idempotency_key,created_at,updated_at) "
        "VALUES (?,?, 'groups','Group','queued','{}','{}',?,?,?,?)",
        (workflow_id, owner_id, json.dumps({"confirmed_by": owner_id}), f"key-{suffix}", now, now),
    )
    conn.execute(
        "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) "
        "VALUES (?,?,?,?,0,'pending','{}',?,?)",
        (step_id, workflow_id, owner_id, action_type, now, now),
    )
    conn.execute(
        "INSERT INTO billing_reservations(id,user_id,ref_type,ref_id,sku,status,idempotency_key,created_at,updated_at) "
        "VALUES (?,?,'crm_action',?,'crm_group_invite_batch','held',?,?,?)",
        (reservation_id, owner_id, action_id, f"billing-{suffix}", now, now),
    )
    return {
        "user_id": owner_id,
        "workflow_id": workflow_id,
        "step_id": step_id,
        "action_id": action_id,
        "billing_reservation_id": reservation_id,
    }


def test_final_social_task_adapter_rejects_platform_bypass_before_insert(group_db) -> None:
    _root, owner_id, _foreign_id = group_db
    action = _group_action()
    action["payload"]["lead_ids"] = ["ig-alpha", "thread-alpha"]
    action["payload"]["members"] = ["alpha.user", "thread.alpha"]
    with db_module.db() as conn:
        request = {**_insert_dispatch_contract(conn, owner_id=owner_id, suffix="bypass"), "action": action}
        with pytest.raises(HTTPException) as caught:
            social_automation_api.create_crm_social_task_in_transaction(conn, request)
        assert caught.value.status_code == 400
        assert caught.value.detail["code"] == "crm_instagram_group_targets_invalid"
        assert conn.execute("SELECT COUNT(*) FROM social_automation_tasks").fetchone()[0] == 0


def test_final_social_task_adapter_accepts_valid_create_and_does_not_affect_member_add(group_db) -> None:
    _root, owner_id, _foreign_id = group_db
    with db_module.db() as conn:
        valid_request = {**_insert_dispatch_contract(conn, owner_id=owner_id, suffix="valid"), "action": _group_action()}
        created = social_automation_api.create_crm_social_task_in_transaction(conn, valid_request)
        assert created["status"] == "queued"

        add_request = _insert_dispatch_contract(
            conn,
            owner_id=owner_id,
            suffix="add",
            action_type="instagram_group_members_add",
        )
        add_request["action"] = {
            "action_type": "instagram_group_members_add",
            "account_id": "ig-owner",
            "target_key": "instagram:direct:existing:members:1",
            "payload": {
                "confirmed": True,
                "expected_username": "owner.one",
                "members": ["new.member"],
                "target_url": "https://www.instagram.com/direct/t/existing/",
            },
        }
        added = social_automation_api.create_crm_social_task_in_transaction(conn, add_request)
        assert added["status"] == "queued"
        assert conn.execute("SELECT COUNT(*) FROM social_automation_tasks").fetchone()[0] == 2
