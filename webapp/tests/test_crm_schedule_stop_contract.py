from __future__ import annotations

import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp.auth import get_current_user
from webapp.crm import install_crm
from webapp.crm.errors import CRMError
from webapp.crm.repository import (
    create_resource,
    create_workflow_atomic,
    stop_schedule_atomic,
)
from webapp.crm.service import update_module_settings
from webapp.crm_integration import _materialize_due_schedules
from webapp import crm_integration as crm_runtime


@pytest.fixture()
def schedule_db(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setenv("WEBAPP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CRM_ENABLED", "1")
    monkeypatch.setenv("CRM_MIN_FREE_BYTES", "0")
    monkeypatch.setenv("CRM_PREFLIGHT_SECRET", "schedule-test-secret-that-is-longer-than-32-bytes")
    db_module.init_db()
    # Re-running startup migrations must remain harmless on a persistent DB.
    db_module.init_db()
    conn = sqlite3.connect(db_module.get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    now = 1_700_000_000
    admin_id = int(
        conn.execute(
            """
            INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at)
            VALUES ('schedule_admin','x',1,0,'approved',?,?)
            """,
            (now, now),
        ).lastrowid
    )
    other_id = int(
        conn.execute(
            """
            INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at)
            VALUES ('schedule_other','x',0,0,'approved',?,?)
            """,
            (now, now),
        ).lastrowid
    )
    update_module_settings(conn, {"enabled": True})
    conn.execute(
        "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
        "VALUES ('account-one',?,'schedule-persona','threads','schedule_sender','profiles/schedule','ready','alive',?,?)",
        (admin_id, now, now),
    )
    conn.commit()
    try:
        yield conn, admin_id, other_id
    finally:
        conn.close()


def _schedule(conn, user_id: int, schedule_id: str, *, actions=None):
    return create_resource(
        conn,
        "schedules",
        user_id=user_id,
        record_id=schedule_id,
        payload={
            "workflow_type": "scheduled_public",
            "cron_expression": "0 * * * *",
            "timezone": "Asia/Shanghai",
            "enabled": True,
            "next_run_at": 0,
            "last_run_at": 0,
            "payload": {"title": "Scheduled", "actions": list(actions or [])},
        },
    )


def _action(target: str):
    return {
        "action_type": "public_comment",
        "account_id": "account-one",
        "target_key": target,
        "content": f"comment for {target}",
    }


def test_schedule_id_schema_upgrade_and_all_creation_paths_persist_owner(schedule_db):
    conn, admin_id, other_id = schedule_db
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(crm_workflows)")}
    indexes = {row["name"] for row in conn.execute("PRAGMA index_list(crm_workflows)")}
    assert "schedule_id" in columns
    assert "idx_crm_workflows_schedule_owner" in indexes

    _schedule(
        conn,
        admin_id,
        "schedule-one",
        actions=[_action("https://www.threads.com/@target/post/scheduled")],
    )
    workflow = create_workflow_atomic(
        conn,
        user_id=admin_id,
        workflow_type="scheduled_public",
        title="manual schedule run",
        input_data={},
        idempotency_key="schedule-owner-manual",
        schedule_id="schedule-one",
        actions=[],
    )
    assert workflow["schedule_id"] == "schedule-one"

    _schedule(conn, other_id, "schedule-other")
    with pytest.raises(CRMError) as cross_tenant:
        create_workflow_atomic(
            conn,
            user_id=admin_id,
            workflow_type="scheduled_public",
            title="wrong owner",
            input_data={},
            idempotency_key="schedule-owner-cross-tenant",
            schedule_id="schedule-other",
            actions=[],
        )
    assert cross_tenant.value.code == "crm_invalid_tenant_reference"

    conn.execute(
        "UPDATE crm_schedules SET next_run_at=1 WHERE id='schedule-one' AND user_id=?",
        (admin_id,),
    )
    assert _materialize_due_schedules(conn, now=1_700_000_100) == 1
    automatic = conn.execute(
        "SELECT schedule_id FROM crm_workflows WHERE idempotency_key='crm-schedule:schedule-one:1'"
    ).fetchone()
    assert automatic is not None
    assert automatic["schedule_id"] == "schedule-one"


def test_legacy_empty_schedule_is_disabled_instead_of_creating_dead_workflow(schedule_db):
    conn, admin_id, _ = schedule_db
    _schedule(conn, admin_id, "schedule-empty")
    conn.execute(
        "UPDATE crm_schedules SET next_run_at=1 WHERE id='schedule-empty' AND user_id=?",
        (admin_id,),
    )

    assert _materialize_due_schedules(conn, now=1_700_000_100) == 0
    schedule = conn.execute(
        "SELECT enabled,next_run_at,payload_json FROM crm_schedules WHERE id='schedule-empty'"
    ).fetchone()
    assert schedule["enabled"] == 0
    assert schedule["next_run_at"] == 0
    assert __import__("json").loads(schedule["payload_json"])["validation_error"] == "crm_schedule_actions_required"
    assert conn.execute(
        "SELECT 1 FROM crm_workflows WHERE schedule_id='schedule-empty'"
    ).fetchone() is None


def test_confirmed_one_shot_schedule_runs_once_with_server_owned_confirmation(schedule_db, monkeypatch):
    conn, admin_id, _ = schedule_db
    conn.commit()
    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "id": admin_id,
        "username": "schedule_admin",
        "is_admin": 1,
    }
    install_crm(app)
    client = TestClient(app)
    preflight = client.post("/api/crm/v1/preflight", json={"actions": [_action("https://www.threads.com/@target/post/one")]})
    assert preflight.status_code == 200, preflight.text
    created = client.post(
        "/api/crm/v1/schedules",
        json={
            "workflow_type": "scheduled_public",
            "cron_expression": "0 * * * *",
            "timezone": "Asia/Shanghai",
            "enabled": True,
            "next_run_at": 1,
            "payload": {
                "run_once": True,
                "confirmed": True,
                "preflight_token": preflight.json()["preflight_token"],
                "confirmed_by": 999999,
                "title": "Run once",
                "actions": [_action("https://www.threads.com/@target/post/one")],
            },
        },
    )
    assert created.status_code == 200, created.text
    schedule_id = created.json()["id"]
    conn.rollback()
    stored = conn.execute("SELECT payload_json FROM crm_schedules WHERE id=?", (schedule_id,)).fetchone()
    payload = __import__("json").loads(stored["payload_json"])
    assert payload["confirmed_by"] == admin_id
    assert payload["allowed_count"] == 1
    assert len(payload["confirmation_hash"]) == 64
    assert "preflight_token" not in payload

    monkeypatch.setattr(
        crm_runtime,
        "crm_billing_adapter",
        lambda _conn, request: {"reservation_id": "run-once-reservation", "status": request["operation"]},
    )
    monkeypatch.setattr(
        crm_runtime,
        "crm_social_task_adapter",
        lambda _conn, request: {"social_task_id": f"run-once-{request['action_id']}", "status": "queued"},
    )
    assert _materialize_due_schedules(conn, now=1_700_000_500) == 1
    schedule = conn.execute("SELECT enabled,last_run_at,next_run_at FROM crm_schedules WHERE id=?", (schedule_id,)).fetchone()
    workflow = conn.execute("SELECT status,confirmation_json FROM crm_workflows WHERE schedule_id=?", (schedule_id,)).fetchone()
    assert schedule["enabled"] == 0
    assert schedule["last_run_at"] == 1
    assert schedule["next_run_at"] == 0
    assert workflow["status"] == "queued"
    assert __import__("json").loads(workflow["confirmation_json"])["confirmed_by"] == admin_id
    assert _materialize_due_schedules(conn, now=1_700_000_800) == 0


def test_schedule_route_rejects_empty_or_unconfirmed_write_payload(schedule_db):
    _conn, admin_id, _ = schedule_db
    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "id": admin_id,
        "username": "schedule_admin",
        "is_admin": 1,
    }
    install_crm(app)
    client = TestClient(app)

    empty = client.post(
        "/api/crm/v1/schedules",
        json={
            "workflow_type": "scheduled_public",
            "cron_expression": "0 * * * *",
            "timezone": "Asia/Shanghai",
            "enabled": True,
            "payload": {},
        },
    )
    assert empty.status_code == 400, empty.text
    assert empty.json()["code"] == "crm_schedule_actions_required"

    unconfirmed = client.post(
        "/api/crm/v1/schedules",
        json={
            "workflow_type": "scheduled_public",
            "cron_expression": "0 * * * *",
            "timezone": "Asia/Shanghai",
            "enabled": True,
            "payload": {
                "actions": [_action("https://www.threads.com/@target/post/unconfirmed")],
            },
        },
    )
    assert unconfirmed.status_code == 409, unconfirmed.text
    assert unconfirmed.json()["code"] == "crm_confirmation_required"


def test_stop_schedule_cancels_unsubmitted_child_and_skips_later_actions_atomically(schedule_db):
    conn, admin_id, _ = schedule_db
    _schedule(conn, admin_id, "schedule-stop")
    calls = []

    def billing(_conn, request):
        calls.append(("billing", request["operation"], request["action_id"]))
        return {
            "reservation_id": request.get("reservation_id") or f"reservation-{request['action_id']}",
            "status": "released" if request["operation"] == "release" else "reserved",
        }

    def social(_conn, request):
        calls.append(("social", request["operation"], request["action_id"]))
        if request["operation"] == "create":
            return {"social_task_id": f"child-{request['action_id']}", "status": "queued"}
        return {"social_task_id": request["social_task_id"], "status": "cancelled"}

    workflow = create_workflow_atomic(
        conn,
        user_id=admin_id,
        workflow_type="scheduled_public",
        title="stop me",
        input_data={},
        idempotency_key="schedule-stop-workflow",
        schedule_id="schedule-stop",
        confirmed_by=admin_id,
        actions=[_action("post:first"), _action("post:later")],
        billing_adapter=billing,
        social_task_adapter=social,
    )
    result = stop_schedule_atomic(
        conn,
        user_id=admin_id,
        schedule_id="schedule-stop",
        billing_adapter=billing,
        social_task_adapter=social,
    )

    assert result["schedule"]["enabled"] == 0
    assert result["schedule"]["next_run_at"] == 0
    stopped = result["workflows"][0]
    assert stopped["id"] == workflow["id"]
    assert stopped["status"] == "paused_by_user"
    assert [action["state"] for action in stopped["actions"]] == ["skipped", "skipped"]
    assert len(result["cancelled_action_ids"]) == 2
    assert len([call for call in calls if call[:2] == ("social", "cancel")]) == 1
    assert len([call for call in calls if call[:2] == ("billing", "release")]) == 1


def test_stop_schedule_rolls_back_disable_and_pause_when_billing_release_fails(schedule_db):
    conn, admin_id, _ = schedule_db
    _schedule(conn, admin_id, "schedule-rollback")

    def reserve(_conn, request):
        return {"reservation_id": f"reservation-{request['action_id']}"}

    def social(_conn, request):
        if request["operation"] == "create":
            return {"social_task_id": f"child-{request['action_id']}", "status": "queued"}
        return {"social_task_id": request["social_task_id"], "status": "cancelled"}

    workflow = create_workflow_atomic(
        conn,
        user_id=admin_id,
        workflow_type="scheduled_public",
        title="rollback stop",
        input_data={},
        idempotency_key="schedule-stop-rollback",
        schedule_id="schedule-rollback",
        confirmed_by=admin_id,
        actions=[_action("post:rollback")],
        billing_adapter=reserve,
        social_task_adapter=social,
    )
    conn.commit()

    def fail_release(_conn, request):
        assert request["operation"] == "release"
        raise RuntimeError("billing unavailable")

    with pytest.raises(CRMError) as failed:
        stop_schedule_atomic(
            conn,
            user_id=admin_id,
            schedule_id="schedule-rollback",
            billing_adapter=fail_release,
            social_task_adapter=social,
        )
    assert failed.value.code == "crm_billing_transition_failed"
    conn.rollback()
    schedule = conn.execute(
        "SELECT enabled FROM crm_schedules WHERE id='schedule-rollback'"
    ).fetchone()
    persisted_workflow = conn.execute(
        "SELECT status FROM crm_workflows WHERE id=?", (workflow["id"],)
    ).fetchone()
    action = conn.execute(
        "SELECT state FROM crm_action_ledger WHERE workflow_id=?", (workflow["id"],)
    ).fetchone()
    assert schedule["enabled"] == 1
    assert persisted_workflow["status"] == "queued"
    assert action["state"] == "reserved"


@pytest.mark.parametrize("unsafe_state", ["submitting", "submitted", "unknown"])
def test_stop_schedule_never_cancels_or_replays_unsafe_action(schedule_db, unsafe_state):
    conn, admin_id, _ = schedule_db
    schedule_id = f"schedule-{unsafe_state}"
    _schedule(conn, admin_id, schedule_id)

    def social(_conn, request):
        if request["operation"] == "cancel":
            raise AssertionError("unsafe action must never be cancelled")
        return {"social_task_id": f"child-{request['action_id']}", "status": "queued"}

    workflow = create_workflow_atomic(
        conn,
        user_id=admin_id,
        workflow_type="scheduled_read",
        title=unsafe_state,
        input_data={},
        idempotency_key=f"unsafe-{unsafe_state}",
        schedule_id=schedule_id,
        actions=[{"action_type": "collect_feed", "target_key": f"feed:{unsafe_state}"}],
        social_task_adapter=social,
    )
    action_id = workflow["actions"][0]["id"]
    conn.execute(
        "UPDATE crm_action_ledger SET state=? WHERE id=? AND user_id=?",
        (unsafe_state, action_id, admin_id),
    )

    result = stop_schedule_atomic(
        conn,
        user_id=admin_id,
        schedule_id=schedule_id,
        billing_adapter=None,
        social_task_adapter=social,
    )
    stopped = result["workflows"][0]
    assert stopped["status"] == "paused_by_user"
    assert stopped["actions"][0]["state"] == unsafe_state
    assert result["unsafe_action_ids"] == [action_id]
    assert result["cancelled_action_ids"] == []


def test_stop_route_is_tenant_isolated_and_returns_persisted_state(schedule_db):
    conn, admin_id, other_id = schedule_db
    _schedule(conn, admin_id, "schedule-route")
    _schedule(conn, other_id, "schedule-hidden")
    conn.commit()

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "id": admin_id,
        "username": "schedule_admin",
        "is_admin": 1,
    }
    install_crm(app)
    client = TestClient(app)

    response = client.post("/api/crm/v1/schedules/schedule-route/stop")
    assert response.status_code == 200
    assert response.json()["status"] == "stopped"
    assert response.json()["schedule"]["enabled"] == 0

    hidden = client.post("/api/crm/v1/schedules/schedule-hidden/stop")
    assert hidden.status_code == 404
    assert hidden.json()["code"] == "crm_schedule_not_found"
    with db_module.db() as verify:
        assert verify.execute(
            "SELECT enabled FROM crm_schedules WHERE id='schedule-hidden' AND user_id=?",
            (other_id,),
        ).fetchone()["enabled"] == 1
