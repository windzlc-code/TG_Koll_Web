from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from webapp import db as db_module
from webapp.crm.errors import CRMError
from webapp.crm.history_cleanup import (
    delete_daily_runs,
    delete_outreach_campaign,
    delete_tracking_campaign,
)


@pytest.fixture()
def tenant_db():
    previous = os.environ.get("APP_DB_PATH")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        os.environ["APP_DB_PATH"] = str(Path(directory) / "app.db")
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            first = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at,updated_at) VALUES ('cleanup-one','x',1,?,?)",
                (now, now),
            ).lastrowid)
            second = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at,updated_at) VALUES ('cleanup-two','x',1,?,?)",
                (now, now),
            ).lastrowid)
        yield first, second
    if previous is None:
        os.environ.pop("APP_DB_PATH", None)
    else:
        os.environ["APP_DB_PATH"] = previous


def test_campaign_cleanup_is_tenant_scoped_and_audited(tenant_db):
    first, second = tenant_db
    with db_module.db() as conn:
        for owner in (first, second):
            conn.execute(
                "INSERT INTO crm_destinations(id,user_id,name,url,active,created_at,updated_at) VALUES (?,?,?,'https://example.test',1,1,1)",
                (f"destination-{owner}", owner, f"destination-{owner}"),
            )
        for event_id, owner in (("click-one", first), ("click-two", second)):
            conn.execute(
                "INSERT INTO crm_tracking_events(id,user_id,campaign_id,destination_id,visitor_hash,occurred_at) VALUES (?,?,?,?, 'visitor',1)",
                (event_id, owner, "campaign-a", f"destination-{owner}"),
            )
        for event_id, owner in (("outreach-one", first), ("outreach-two", second)):
            conn.execute(
                "INSERT INTO crm_events(id,user_id,event_type,payload_json,active,created_at,updated_at) VALUES (?,?,'legacy_outreach_event',?,1,1,1)",
                (event_id, owner, json.dumps({"campaign": "campaign-a"})),
            )
        click_result = delete_tracking_campaign(conn, user_id=first, campaign_id="campaign-a")
        outreach_result = delete_outreach_campaign(conn, user_id=first, campaign_id="campaign-a")
        assert click_result["removed"] == 1
        assert outreach_result["removed"] == 1
        assert conn.execute("SELECT COUNT(*) FROM crm_tracking_events WHERE user_id=?", (first,)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM crm_tracking_events WHERE user_id=?", (second,)).fetchone()[0] == 1
        assert conn.execute("SELECT active FROM crm_events WHERE id='outreach-one'").fetchone()[0] == 0
        assert conn.execute("SELECT active FROM crm_events WHERE id='outreach-two'").fetchone()[0] == 1
        audit_types = {
            row[0] for row in conn.execute(
                "SELECT event_type FROM crm_events WHERE user_id=? AND event_type LIKE '%_deleted'",
                (first,),
            )
        }
        assert audit_types == {"tracking_campaign_deleted", "outreach_campaign_deleted"}


def test_daily_run_cleanup_rejects_active_and_soft_deletes_only_owned_history(tenant_db):
    first, second = tenant_db
    with db_module.db() as conn:
        for workflow_id, owner, status in (
            ("daily-finished", first, "completed"),
            ("daily-active", first, "running"),
            ("daily-foreign", second, "completed"),
        ):
            conn.execute(
                "INSERT INTO crm_workflows(id,user_id,workflow_type,status,idempotency_key,created_at,updated_at) VALUES (?,?,'legacy_opc_daily_run',?, ?,1,1)",
                (workflow_id, owner, status, f"idem-{workflow_id}"),
            )
        with pytest.raises(CRMError) as unsafe:
            delete_daily_runs(conn, user_id=first, workflow_ids=["daily-active"])
        assert unsafe.value.code == "crm_daily_run_delete_unsafe"
        result = delete_daily_runs(
            conn,
            user_id=first,
            workflow_ids=["daily-finished", "daily-foreign", "missing", "daily-finished"],
        )
        assert result == {"ok": True, "deleted": 1, "ids": ["daily-finished"]}
        assert conn.execute("SELECT active FROM crm_workflows WHERE id='daily-finished'").fetchone()[0] == 0
        assert conn.execute("SELECT active FROM crm_workflows WHERE id='daily-foreign'").fetchone()[0] == 1


def test_daily_run_cleanup_caps_batch_size(tenant_db):
    first, _second = tenant_db
    with db_module.db() as conn, pytest.raises(CRMError) as raised:
        delete_daily_runs(conn, user_id=first, workflow_ids=[f"run-{index}" for index in range(501)])
    assert raised.value.code == "crm_daily_run_ids_invalid"
