from __future__ import annotations

import os
import tempfile
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from webapp import db as db_module
from webapp import social_automation_api
from webapp.crm.repository import create_workflow_atomic, dispatch_next_action_atomic
from webapp.crm.result_persistence import persist_collection_result, persist_instagram_group_result
from webapp.crm.instagram_groups import validate_task_payload


@pytest.fixture()
def crm_db():
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
            user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('crm-persistence','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('ig-owner',?,'persona','instagram','owner.one',?,'ready','alive',?,?)",
                (user_id, str(root / "profile"), now, now),
            )
        yield root, user_id
    if previous_db is None:
        os.environ.pop("APP_DB_PATH", None)
    else:
        os.environ["APP_DB_PATH"] = previous_db
    if previous_data is None:
        os.environ.pop("WEBAPP_DATA_DIR", None)
    else:
        os.environ["WEBAPP_DATA_DIR"] = previous_data


def test_collection_result_creates_one_deduplicated_pool_and_is_idempotent(crm_db) -> None:
    _root, user_id = crm_db
    with db_module.db() as conn:
        now = 1_700_000_010
        conn.execute(
            "INSERT INTO crm_workflows(id,user_id,workflow_type,title,status,input_json,result_json,confirmation_json,"
            "idempotency_key,created_at,updated_at) VALUES ('crm-collect',?,'collect','Mortgage prospects','running','{}','{}','{}','collect-key',?,?)",
            (user_id, now, now),
        )
        task = {"id": "social-collect", "user_id": user_id, "platform": "threads", "task_type": "browse_feed"}
        payload = {"_crm_workflow_id": "crm-collect", "query": "mortgage"}
        result = {
            "data": [
                {
                    "username": "Alpha.User",
                    "displayName": "Alpha",
                    "profileUrl": "https://www.threads.com/@alpha.user",
                    "sourceUrl": "https://www.threads.com/@alpha.user/post/one",
                    "keyword": "mortgage",
                },
                {"username": "alpha.user", "displayName": "duplicate"},
                {"username": "Beta_User", "platform": "threads"},
            ]
        }
        first = persist_collection_result(conn, task=task, payload=payload, result=result, persisted_at=now)
        second = persist_collection_result(conn, task=task, payload=payload, result=result, persisted_at=now + 1)
        assert first["collected"] == 2
        assert first["new_leads"] == 2
        assert first["new_members"] == 2
        assert second["pool_id"] == first["pool_id"]
        assert second["new_leads"] == 0
        assert second["new_members"] == 0
        assert conn.execute("SELECT COUNT(*) FROM crm_pools WHERE user_id=?", (user_id,)).fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM crm_leads WHERE user_id=?", (user_id,)).fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM crm_pool_members WHERE user_id=?", (user_id,)).fetchone()[0] == 2
        assert conn.execute(
            "SELECT COUNT(*) FROM crm_events WHERE user_id=? AND event_type='collection_lead_captured'",
            (user_id,),
        ).fetchone()[0] == 2


def test_collection_profile_requires_dom_proved_profile_identity(crm_db) -> None:
    _root, user_id = crm_db
    task = {"id": "profile-task", "user_id": user_id, "platform": "instagram", "task_type": "browse_profile"}
    with db_module.db() as conn:
        proved = persist_collection_result(
            conn,
            task=task,
            payload={},
            result={
                "url": "https://www.instagram.com/real.person/",
                "items": [{
                    "platform": "instagram",
                    "username": "real.person",
                    "profile_url": "https://www.instagram.com/real.person/",
                    "evidence": {"dom_confirmed": True},
                }],
            },
        )
        post_only = persist_collection_result(
            conn,
            task={**task, "id": "post-task"},
            payload={"target_url": "https://www.instagram.com/p/post-code/"},
            result={"url": "https://www.instagram.com/p/post-code/"},
        )
        assert proved["collected"] == 1
        assert post_only["collected"] == 0
        assert conn.execute("SELECT username FROM crm_leads WHERE user_id=?", (user_id,)).fetchone()[0] == "real.person"


def test_social_task_completion_projects_collection_into_crm_tables(crm_db) -> None:
    _root, user_id = crm_db
    now = 1_700_000_030
    with db_module.db() as conn:
        conn.execute(
            "INSERT INTO crm_workflows(id,user_id,workflow_type,title,status,input_json,result_json,confirmation_json,"
            "idempotency_key,created_at,updated_at) VALUES ('crm-finish',?,'collect','Finished collection','running','{}','{}','{}','finish-key',?,?)",
            (user_id, now, now),
        )
        conn.execute(
            "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) "
            "VALUES ('step-finish','crm-finish',?,'collect_feed',0,'running','{}',?,?)",
            (user_id, now, now),
        )
        payload = {
            "_crm_workflow_id": "crm-finish",
            "_crm_step_id": "step-finish",
            "_crm_action_id": "action-finish",
            "_crm_action_type": "collect_feed",
            "query": "loan",
        }
        conn.execute(
            "INSERT INTO social_automation_tasks(id,user_id,persona_id,account_id,platform,task_type,status,scheduled_at,"
            "started_at,payload_json,result_json,max_retries,created_by,created_at,updated_at) "
            "VALUES ('social-finish',?,'persona','ig-owner','threads','browse_feed','running',?,?,?,'{}',0,'crm',?,?)",
            (user_id, now, now, json.dumps(payload), now, now),
        )
    completed = social_automation_api._finish_task(
        "social-finish",
        "success",
        {"data": [{"username": "captured.user", "platform": "threads"}]},
        "",
    )
    assert completed is True
    with db_module.db() as conn:
        task = conn.execute("SELECT status,result_json FROM social_automation_tasks WHERE id='social-finish'").fetchone()
        assert task["status"] == "success"
        assert '"crm_collection"' in task["result_json"]
        assert conn.execute("SELECT COUNT(*) FROM crm_leads WHERE user_id=?", (user_id,)).fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM crm_pool_members WHERE user_id=?", (user_id,)).fetchone()[0] == 1


def test_group_workflow_splits_members_and_inherits_verified_conversation_url(crm_db) -> None:
    _root, user_id = crm_db
    social_requests: list[dict] = []

    def billing(_conn, request):
        return {"reservation_id": "bill-group"} if request["operation"] == "reserve" else {"status": "settled"}

    def social(_conn, request):
        social_requests.append(request)
        return {"social_task_id": f"social-{len(social_requests)}"}

    with db_module.db() as conn:
        workflow = create_workflow_atomic(
            conn,
            user_id=user_id,
            workflow_type="groups",
            title="VIP group",
            input_data={},
            idempotency_key="group-seven-members",
            confirmed_by=user_id,
            actions=[
                {
                    "action_type": "instagram_group_create",
                    "account_id": "ig-owner",
                    "target_key": "instagram:direct:new:pool-one",
                    "content": "welcome",
                    "payload": {
                        "confirmed": True,
                        "expected_username": "owner.one",
                        "message": "welcome",
                        "members": ["one", "two", "three", "four", "five", "six", "seven"],
                        "lead_ids": [f"lead-{index}" for index in range(7)],
                    },
                }
            ],
            billing_adapter=billing,
            social_task_adapter=social,
        )
        assert [step["step_type"] for step in workflow["steps"]] == [
            "instagram_group_create",
            "instagram_group_members_add",
            "instagram_group_members_add",
        ]
        assert social_requests[0]["action"]["payload"]["members"] == ["one", "two", "three"]
        first_step = workflow["steps"][0]
        first_action = workflow["actions"][0]
        conn.execute(
            "UPDATE crm_workflow_steps SET status='success',result_json=? WHERE id=?",
            ('{"target_url":"https://www.instagram.com/direct/t/proved-thread/"}', first_step["id"]),
        )
        conn.execute("UPDATE crm_action_ledger SET state='confirmed' WHERE id=?", (first_action["id"],))
        dispatch_next_action_atomic(
            conn,
            user_id=user_id,
            workflow_id=workflow["id"],
            billing_adapter=billing,
            social_task_adapter=social,
        )
        second = social_requests[1]["action"]
        assert second["payload"]["members"] == ["four", "five", "six"]
        assert second["payload"]["target_url"] == "https://www.instagram.com/direct/t/proved-thread/"
        assert second["payload"]["expected_username"] == "owner.one"

    with pytest.raises(ValueError, match="exclude the sender"):
        validate_task_payload(
            "instagram_group_create",
            {
                "confirmed": True,
                "members": ["one", "two", "three"],
                "approved_members": ["one", "two", "three", "owner.one"],
            },
            {"username": "owner.one"},
        )


def test_group_add_adapter_preserves_hydrated_direct_url(crm_db) -> None:
    _root, user_id = crm_db
    now = 1_700_000_050
    with db_module.db() as conn:
        conn.execute(
            "INSERT INTO crm_workflows(id,user_id,workflow_type,title,status,input_json,result_json,confirmation_json,"
            "idempotency_key,created_at,updated_at) VALUES ('crm-group-add',?,'groups','Add members','queued','{}','{}',?,"
            "'group-add-key',?,?)",
            (user_id, json.dumps({"confirmed_by": user_id}), now, now),
        )
        conn.execute(
            "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) "
            "VALUES ('step-group-add','crm-group-add',?,'instagram_group_members_add',0,'pending','{}',?,?)",
            (user_id, now, now),
        )
        conn.execute(
            "INSERT INTO billing_reservations(id,user_id,ref_type,ref_id,sku,status,idempotency_key,created_at,updated_at) "
            "VALUES ('bill-group-add',?,'crm_action','action-group-add','crm_group_invite_batch','held','bill-group-add-key',?,?)",
            (user_id, now, now),
        )
        queued = social_automation_api.create_crm_social_task_in_transaction(
            conn,
            {
                "user_id": user_id,
                "workflow_id": "crm-group-add",
                "step_id": "step-group-add",
                "action_id": "action-group-add",
                "billing_reservation_id": "bill-group-add",
                "action": {
                    "action_type": "instagram_group_members_add",
                    "account_id": "ig-owner",
                    "target_key": "instagram:direct:new:pool-one:members:1",
                    "payload": {
                        "confirmed": True,
                        "expected_username": "owner.one",
                        "members": ["four", "five"],
                        "target_url": "https://www.instagram.com/direct/t/proved-thread/",
                    },
                },
            },
        )
        task = conn.execute(
            "SELECT payload_json FROM social_automation_tasks WHERE id=?",
            (queued["social_task_id"],),
        ).fetchone()
        payload = json.loads(str(task["payload_json"]))
        assert payload["target_url"] == "https://www.instagram.com/direct/t/proved-thread/"
        assert payload["members"] == ["four", "five"]


def test_group_result_projection_merges_followup_members_idempotently(crm_db) -> None:
    _root, user_id = crm_db
    create_task = {"id": "group-create-task", "user_id": user_id, "task_type": "instagram_group_create"}
    add_task = {"id": "group-add-task", "user_id": user_id, "task_type": "instagram_group_members_add"}
    payload = {"_crm_workflow_id": "crm-group", "members": ["one", "two", "three"]}
    create_result = {
        "target_url": "https://www.instagram.com/direct/t/group-42/",
        "members": ["one", "two", "three"],
        "verified": True,
    }
    with db_module.db() as conn:
        created = persist_instagram_group_result(conn, task=create_task, payload=payload, result=create_result)
        added = persist_instagram_group_result(
            conn,
            task=add_task,
            payload={"_crm_workflow_id": "crm-group", "target_url": create_result["target_url"], "members": ["four", "five"]},
            result={"target_url": create_result["target_url"], "added_members": ["four", "five"], "verified": True},
        )
        replay = persist_instagram_group_result(
            conn,
            task=add_task,
            payload={"_crm_workflow_id": "crm-group", "target_url": create_result["target_url"], "members": ["four", "five"]},
            result={"target_url": create_result["target_url"], "added_members": ["four", "five"], "verified": True},
        )
        assert created["persisted"] is True
        assert added["members"] == ["one", "two", "three", "four", "five"]
        assert replay["members"] == added["members"]
        assert conn.execute("SELECT COUNT(*) FROM crm_groups WHERE user_id=?", (user_id,)).fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM crm_events WHERE user_id=?", (user_id,)).fetchone()[0] == 2


def test_group_media_resolves_owner_id_and_rejects_paths_or_cross_tenant(crm_db) -> None:
    root, user_id = crm_db
    owned = root / "crm_media" / str(user_id) / "owned.png"
    owned.parent.mkdir(parents=True)
    owned.write_bytes(b"image")
    with db_module.db() as conn:
        now = 1_700_000_020
        conn.execute(
            "INSERT INTO crm_media(id,user_id,storage_path,sha256,mime_type,size_bytes,original_name,created_at,updated_at) "
            "VALUES ('owned-media',? ,?,'hash','image/png',5,'owned.png',?,?)",
            (user_id, str(owned.relative_to(root)), now, now),
        )
        resolved = social_automation_api._crm_instagram_group_media_paths(
            conn, user_id=user_id, payload={"media_id": "owned-media"}
        )
        assert resolved == [str(owned.resolve())]
        with pytest.raises(HTTPException) as raw_path:
            social_automation_api._crm_instagram_group_media_paths(
                conn, user_id=user_id, payload={"media_paths": [str(owned)]}
            )
        assert raw_path.value.status_code == 400
        with pytest.raises(HTTPException) as foreign:
            social_automation_api._crm_instagram_group_media_paths(
                conn, user_id=user_id + 1, payload={"media_id": "owned-media"}
            )
        assert foreign.value.status_code == 404

        conn.execute(
            "INSERT INTO crm_workflows(id,user_id,workflow_type,title,status,input_json,result_json,confirmation_json,"
            "idempotency_key,created_at,updated_at) VALUES ('crm-media-group',?,'groups','Media group','queued','{}','{}',?,"
            "'media-group-key',?,?)",
            (user_id, json.dumps({"confirmed_by": user_id}), now, now),
        )
        conn.execute(
            "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) "
            "VALUES ('step-media-group','crm-media-group',?,'instagram_group_create',0,'pending','{}',?,?)",
            (user_id, now, now),
        )
        conn.execute(
            "INSERT INTO billing_reservations(id,user_id,ref_type,ref_id,sku,status,idempotency_key,created_at,updated_at) "
            "VALUES ('bill-media-group',?,'crm_action','action-media-group','crm_group_invite_batch','held','bill-media-group-key',?,?)",
            (user_id, now, now),
        )
        queued = social_automation_api.create_crm_social_task_in_transaction(
            conn,
            {
                "user_id": user_id,
                "workflow_id": "crm-media-group",
                "step_id": "step-media-group",
                "action_id": "action-media-group",
                "billing_reservation_id": "bill-media-group",
                "action": {
                    "action_type": "instagram_group_create",
                    "account_id": "ig-owner",
                    "target_key": "instagram:direct:new:media",
                    "content": "hello",
                    "payload": {
                        "confirmed": True,
                        "members": ["alpha", "beta"],
                        "message": "hello",
                        "media_id": "owned-media",
                    },
                },
            },
        )
        stored = conn.execute(
            "SELECT payload_json FROM social_automation_tasks WHERE id=?",
            (queued["social_task_id"],),
        ).fetchone()
        stored_payload = json.loads(stored["payload_json"])
        assert stored_payload["media_paths"] == [str(owned.resolve())]
        assert "media_id" not in stored_payload
