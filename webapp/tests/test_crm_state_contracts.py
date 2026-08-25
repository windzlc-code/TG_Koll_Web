import json
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp.auth import get_current_user, require_admin
from webapp.crm import install_crm
from webapp.crm_integration import crm_social_task_adapter
from webapp.crm.repository import create_resource, create_workflow_atomic, now_ts
from webapp.crm.service import (
    reconcile_all_due,
    reconcile_workflow,
    set_user_access,
    sync_social_child_tasks,
    update_module_settings,
)


class CRMStateContractTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            key: os.environ.get(key)
            for key in ("APP_DB_PATH", "WEBAPP_DATA_DIR", "CRM_ENABLED", "CRM_TRACKING_SECRET")
        }
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        os.environ["CRM_ENABLED"] = "1"
        os.environ["CRM_TRACKING_SECRET"] = "crm-state-contract-secret-longer-than-32-bytes"
        db_module.init_db()
        with db_module.db() as conn:
            current = now_ts()
            self.admin_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) VALUES ('state_admin','x',1,0,'approved',?,?)",
                (current, current),
            ).lastrowid)
            self.user_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) VALUES ('state_user','x',0,0,'approved',?,?)",
                (current, current),
            ).lastrowid)
            update_module_settings(conn, {"enabled": True})
            set_user_access(conn, user_id=self.user_id, enabled=True, actor_user_id=self.admin_id)

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _app(self, **install_kwargs):
        app = FastAPI()
        app.dependency_overrides[get_current_user] = lambda: {
            "id": self.admin_id, "is_admin": 1, "username": "state_admin",
            "_workspace_user_id": self.user_id,
            "_workspace_username": "state_user",
            "_workspace_admin_user_id": self.admin_id,
        }
        app.dependency_overrides[require_admin] = lambda: {
            "id": self.admin_id, "is_admin": 1, "username": "state_admin",
        }
        install_crm(app, **install_kwargs)
        return app

    def test_review_uses_immediate_transaction_and_releases_unknown_hold(self):
        def billing_adapter(conn, request):
            self.assertTrue(conn.in_transaction)
            self.assertEqual(request["operation"], "release")
            conn.execute(
                "UPDATE billing_reservations SET status='released',updated_at=? WHERE id=?",
                (now_ts(), request["reservation_id"]),
            )
            return {"reservation_id": request["reservation_id"], "status": "released"}

        with db_module.db() as conn:
            current = now_ts()
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="review",
                title="review",
                input_data={},
                idempotency_key="state-review",
                actions=[{"action_type": "collect_profile", "target_key": "lead:1", "write": False}],
                social_task_adapter=lambda _conn, _request: {"social_task_id": "state-review-child"},
            )
            action_id = str(workflow["actions"][0]["id"])
            conn.execute(
                """
                INSERT INTO billing_reservations(
                  id,user_id,ref_type,ref_id,sku,status,meta_json,idempotency_key,created_at,updated_at
                ) VALUES ('state-review-hold',?,'crm_action',?,'threads_auto_reply_batch','held','{\"quantity\":1}','state-review-hold-idem',?,?)
                """,
                (self.user_id, action_id, current, current),
            )
            conn.execute(
                "UPDATE crm_action_ledger SET state='unknown',billing_reservation_id='state-review-hold' WHERE id=?",
                (action_id,),
            )
        client = TestClient(self._app(billing_adapter=billing_adapter))
        response = client.post(
            f"/api/crm/v1/tasks/{workflow['id']}/actions/{action_id}/review",
            json={"state": "failed", "evidence": {"checked": True}},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["action"]["state"], "failed")
        self.assertEqual(response.json()["workflow"]["status"], "failed")

    def test_relationship_verify_route_creates_tenant_scoped_parent_and_native_child(self):
        with db_module.db() as conn:
            current = now_ts()
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('state-ig',?,'state-persona','instagram','State.Owner','profiles/state-ig','ready','alive',?,?)",
                (self.user_id, current, current),
            )
            conn.execute(
                "INSERT INTO crm_leads(id,user_id,platform,platform_user_key,username,active,created_at,updated_at) "
                "VALUES ('state-lead',?,'instagram','state-target','State.Target',1,?,?)",
                (self.user_id, current, current),
            )
            conn.execute(
                "INSERT INTO crm_leads(id,user_id,platform,platform_user_key,username,active,created_at,updated_at) "
                "VALUES ('hidden-lead',?,'instagram','hidden-target','Hidden.Target',1,?,?)",
                (self.admin_id, current, current),
            )
        client = TestClient(self._app(
            social_task_adapter=crm_social_task_adapter,
            post_commit_callback=lambda _event: None,
        ))
        response = client.post(
            "/api/crm/v1/relationships/verify",
            json={
                "account_id": "state-ig",
                "lead_ids": ["state-lead"],
                "idempotency_key": "state-relationship-verify",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        task_id = response.json()["task_id"]
        with db_module.db() as conn:
            step = conn.execute(
                "SELECT social_task_id FROM crm_workflow_steps WHERE workflow_id=? AND user_id=?",
                (task_id, self.user_id),
            ).fetchone()
            child = conn.execute(
                "SELECT task_type,max_retries,payload_json FROM social_automation_tasks WHERE id=? AND user_id=?",
                (str(step["social_task_id"]), self.user_id),
            ).fetchone()
            self.assertEqual(child["task_type"], "instagram_relationship_verify")
            self.assertEqual(child["max_retries"], 0)
            self.assertEqual(json.loads(child["payload_json"])["lead_ids"], ["state-lead"])
        hidden = client.post(
            "/api/crm/v1/relationships/verify",
            json={
                "account_id": "state-ig",
                "lead_ids": ["hidden-lead"],
                "idempotency_key": "state-relationship-hidden",
            },
        )
        self.assertEqual(hidden.status_code, 400, hidden.text)
        self.assertEqual(hidden.json()["code"], "crm_invalid_tenant_reference")

    def test_task_evidence_exposes_authenticated_url_without_filesystem_path(self):
        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="evidence",
                title="evidence",
                input_data={},
                idempotency_key="state-evidence",
                actions=[{"action_type": "collect_profile", "target_key": "lead:evidence", "write": False}],
                social_task_adapter=lambda _conn, _request: {"social_task_id": "state-evidence-child"},
            )
            action_id = str(workflow["actions"][0]["id"])
            conn.execute(
                "UPDATE crm_action_ledger SET evidence_json=? WHERE id=? AND user_id=?",
                (
                    json.dumps({
                        "social_task_id": "state-evidence-child",
                        "result": {
                            "screenshot_path": "/data/webapp_data/social_automation/screenshots/evidence one.png",
                        },
                    }),
                    action_id,
                    self.user_id,
                ),
            )

        response = TestClient(self._app()).get(f"/api/crm/v1/tasks/{workflow['id']}/evidence")
        self.assertEqual(response.status_code, 200, response.text)
        evidence = response.json()["items"][0]["evidence"]
        self.assertEqual(
            evidence["screenshot_url"],
            "/api/persona_dashboard/automation/screenshots/evidence%20one.png",
        )
        self.assertNotIn("screenshot_path", evidence["result"])
        self.assertNotIn("/data/webapp_data", response.text)

    def test_cleanup_and_rotation_routes_enforce_effective_tenant(self):
        with db_module.db() as conn:
            current = now_ts()
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('state-threads',?,'state-persona','threads','State.Sender','profiles/state-threads','ready','alive',?,?)",
                (self.user_id, current, current),
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('state-login',?,'state-persona','threads','State.Login','profiles/state-login','need_verification','unknown',?,?)",
                (self.user_id, current, current),
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('hidden-threads',?,'hidden-persona','threads','Hidden.Sender','profiles/hidden-threads','ready','alive',?,?)",
                (self.admin_id, current, current),
            )
            conn.execute(
                "INSERT INTO crm_destinations(id,user_id,name,url,enabled,active,created_at,updated_at) "
                "VALUES ('state-dest',?,'state','https://example.com/state',1,1,?,?),"
                "('hidden-dest',?,'hidden','https://example.com/hidden',1,1,?,?)",
                (self.user_id, current, current, self.admin_id, current, current),
            )
            conn.execute(
                "INSERT INTO crm_tracking_events(id,user_id,campaign_id,destination_id,visitor_hash,occurred_at,metadata_json) "
                "VALUES ('state-track',?,'campaign-a','state-dest','visitor-a',?,'{}'),"
                "('hidden-track',?,'campaign-a','hidden-dest','visitor-b',?,'{}')",
                (self.user_id, current, self.admin_id, current),
            )
        client = TestClient(self._app())
        analytics = client.get("/api/crm/v1/analytics")
        self.assertEqual(analytics.status_code, 200, analytics.text)
        self.assertEqual(analytics.json()["funnel"]["clicked"], 1)
        self.assertIn("action_states", analytics.json())
        self.assertIn("confirmed_action_types", analytics.json())
        deleted = client.delete("/api/crm/v1/tracking-events", params={"campaign_id": "campaign-a"})
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["removed"], 1)
        rotation = client.get("/api/crm/v1/accounts/state-threads/rotation")
        self.assertEqual(rotation.status_code, 200, rotation.text)
        self.assertFalse(rotation.json()["locked"])
        accounts = client.get("/api/crm/v1/accounts")
        self.assertEqual(accounts.status_code, 200, accounts.text)
        by_id = {item["id"]: item for item in accounts.json()["items"]}
        self.assertFalse(by_id["state-threads"]["needs_login"])
        self.assertTrue(by_id["state-login"]["needs_login"])
        rejected = client.post(
            "/api/crm/v1/accounts/state-threads/rotation/reset",
            json={"confirmed_follow_action": False},
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)
        hidden = client.get("/api/crm/v1/accounts/hidden-threads/rotation")
        self.assertEqual(hidden.status_code, 404, hidden.text)
        with db_module.db() as conn:
            self.assertIsNotNone(conn.execute(
                "SELECT 1 FROM crm_tracking_events WHERE id='hidden-track'",
            ).fetchone())

    def test_reconcile_converges_mixed_terminals_and_unknown_wins(self):
        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="mixed",
                title="mixed",
                input_data={},
                idempotency_key="state-mixed",
                actions=[
                    {"action_type": "collect_profile", "target_key": "lead:a", "write": False},
                    {"action_type": "collect_profile", "target_key": "lead:b", "write": False},
                    {"action_type": "collect_profile", "target_key": "lead:c", "write": False},
                ],
                social_task_adapter=lambda _conn, request: {"social_task_id": f"child-{request['action_id']}"},
            )
            first, second, third = workflow["actions"]
            conn.execute("UPDATE crm_action_ledger SET state='confirmed' WHERE id=?", (first["id"],))
            conn.execute("UPDATE crm_action_ledger SET state='failed' WHERE id=?", (second["id"],))
            failed = reconcile_workflow(conn, user_id=self.user_id, workflow_id=workflow["id"])
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(
                conn.execute("SELECT state FROM crm_action_ledger WHERE id=?", (third["id"],)).fetchone()["state"],
                "planned",
            )
            conn.execute("UPDATE crm_action_ledger SET state='unknown' WHERE id=?", (second["id"],))
            conn.execute("UPDATE crm_workflows SET status='paused_by_user' WHERE id=?", (workflow["id"],))
            manual = reconcile_workflow(conn, user_id=self.user_id, workflow_id=workflow["id"])
            self.assertEqual(manual["status"], "manual_required")

    def test_paused_workflow_syncs_terminal_child_without_timestamp_gate(self):
        with db_module.db() as conn:
            current = now_ts()
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,created_at,updated_at) VALUES ('state-account',?,'persona','threads','state_handle','profiles/state',?,?)",
                (self.user_id, current, current),
            )

            def social_adapter(inner, request):
                inner.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id,user_id,persona_id,account_id,platform,task_type,status,payload_json,result_json,created_at,updated_at
                    ) VALUES ('state-paused-child',?,'persona','state-account','threads','browse_profile','success','{}','{\"verified\":true}',?,?)
                    """,
                    (self.user_id, current - 20, current - 20),
                )
                return {"social_task_id": "state-paused-child"}

            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="paused",
                title="paused",
                input_data={},
                idempotency_key="state-paused",
                actions=[{"action_type": "collect_profile", "target_key": "lead:paused", "account_id": "state-account", "write": False}],
                social_task_adapter=social_adapter,
            )
            conn.execute(
                "UPDATE crm_workflows SET status='paused_by_user',updated_at=? WHERE id=?",
                (current + 20, workflow["id"]),
            )
            result = reconcile_all_due(conn)
            self.assertEqual(result["workflows"], 1)
            stored = conn.execute("SELECT status FROM crm_workflows WHERE id=?", (workflow["id"],)).fetchone()
            action = conn.execute("SELECT state FROM crm_action_ledger WHERE workflow_id=?", (workflow["id"],)).fetchone()
            self.assertEqual(stored["status"], "completed")
            self.assertEqual(action["state"], "confirmed")
            self.assertEqual(reconcile_all_due(conn)["workflows"], 0)

            skipped = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="paused-skipped",
                title="paused skipped",
                input_data={},
                idempotency_key="state-paused-skipped",
                actions=[{"action_type": "collect_profile", "target_key": "lead:skipped", "account_id": "state-account", "write": False}],
                social_task_adapter=lambda _conn, _request: {"social_task_id": "state-skipped-child"},
            )
            conn.execute("UPDATE crm_action_ledger SET state='skipped' WHERE workflow_id=?", (skipped["id"],))
            conn.execute("UPDATE crm_workflows SET status='paused_by_policy' WHERE id=?", (skipped["id"],))
            preserved = reconcile_workflow(conn, user_id=self.user_id, workflow_id=skipped["id"])
            self.assertEqual(preserved["status"], "paused_by_policy")

    def test_terminal_child_dispatches_only_the_next_sequential_step(self):
        dispatched = []

        def social_adapter(conn, request):
            task_id = f"state-sequence-{len(dispatched) + 1}"
            dispatched.append(str(request["action_id"]))
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id,user_id,persona_id,account_id,platform,task_type,status,payload_json,result_json,created_at,updated_at
                ) VALUES (?,?,'persona','state-sequence-account','threads','browse_profile','queued','{}','{}',?,?)
                """,
                (task_id, self.user_id, now_ts(), now_ts()),
            )
            return {"social_task_id": task_id}

        with db_module.db() as conn:
            current = now_ts()
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,created_at,updated_at) VALUES ('state-sequence-account',?,'persona','threads','sequence_handle','profiles/sequence',?,?)",
                (self.user_id, current, current),
            )
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="sequence",
                title="sequence",
                input_data={},
                idempotency_key="state-sequence",
                actions=[
                    {"action_type": "collect_profile", "target_key": "lead:first", "account_id": "state-sequence-account", "write": False},
                    {"action_type": "collect_profile", "target_key": "lead:second", "account_id": "state-sequence-account", "write": False},
                ],
                social_task_adapter=social_adapter,
            )
            self.assertEqual(len(dispatched), 1)
            first_task_id = str(workflow["steps"][0]["social_task_id"])
            self.assertFalse(workflow["steps"][1]["social_task_id"])
            conn.execute(
                "UPDATE social_automation_tasks SET status='success',result_json='{\"verified\":true}',updated_at=? WHERE id=?",
                (now_ts() + 1, first_task_id),
            )
            synced = sync_social_child_tasks(
                conn,
                user_id=self.user_id,
                workflow_id=workflow["id"],
                social_task_adapter=social_adapter,
            )
            self.assertEqual(len(dispatched), 2)
            self.assertTrue(synced["workflow"]["steps"][1]["social_task_id"])

    def test_task_operations_do_not_self_assign_worker_states(self):
        client = TestClient(self._app(
            post_commit_callback=lambda _event: None,
            social_task_adapter=lambda _conn, request: {"social_task_id": f"social-{request['action_id']}"},
        ))
        created = client.post(
            "/api/crm/v1/tasks",
            json={
                "workflow_type": "read", "idempotency_key": "state-ops",
                "actions": [{"action_type": "collect_feed", "account_id": "read-account", "target_key": "search:test", "payload": {"query": "test", "platform": "threads"}}],
            },
        )
        task_id = created.json()["task_id"]
        started = client.post(f"/api/crm/v1/tasks/{task_id}/start", json={})
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["status"], "queued")
        takeover = client.post(f"/api/crm/v1/tasks/{task_id}/takeover", json={})
        self.assertEqual(takeover.status_code, 409, takeover.text)
        paused = client.post(f"/api/crm/v1/tasks/{task_id}/pause", json={})
        self.assertEqual(paused.status_code, 200, paused.text)
        resumed = client.post(f"/api/crm/v1/tasks/{task_id}/resume", json={})
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertEqual(resumed.json()["status"], "queued")
        listed = client.get("/api/crm/v1/tasks")
        self.assertEqual(listed.status_code, 200, listed.text)
        listed_item = next(item for item in listed.json()["items"] if item["id"] == task_id)
        self.assertEqual(listed_item["status"], "queued")
        self.assertNotIn("legacy_payload", listed_item)
        self.assertNotIn("input", listed_item)
        self.assertNotIn("result", listed_item)
        self.assertNotIn("payload", listed_item)
        detail = client.get(f"/api/crm/v1/tasks/{task_id}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertIn("steps", detail.json())
        self.assertIn("actions", detail.json())
        self.assertIn("evidence", detail.json())
        health = client.get("/api/admin/modules/crm/health")
        self.assertEqual(health.status_code, 200, health.text)
        self.assertEqual(health.json()["checks"]["database_check_mode"], "lightweight")
        self.assertIn("checked_at", health.json())

    def test_legacy_o_link_uses_mapped_tenant_and_https_destination(self):
        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="outreach",
                title="legacy campaign",
                input_data={},
                idempotency_key="legacy-campaign-native",
                actions=[],
            )
            conn.execute("UPDATE crm_workflows SET legacy_id='legacy-campaign' WHERE id=?", (workflow["id"],))
            lead = create_resource(
                conn,
                "leads",
                user_id=self.user_id,
                payload={"platform": "threads", "platform_user_key": "legacy-user", "username": "legacy_user"},
                legacy_id="legacy-lead",
            )
            destination = create_resource(
                conn,
                "destinations",
                user_id=self.user_id,
                payload={"name": "official", "url": "https://www.instagram.com/tenant-official/", "enabled": 1},
                legacy_id="o",
            )
        client = TestClient(self._app(), follow_redirects=False)
        response = client.get("/go/o/legacy_user/legacy-lead?campaign=legacy-campaign")
        self.assertEqual(response.status_code, 302, response.text)
        self.assertEqual(response.headers["location"], destination["url"])
        wrong_username = client.get("/go/o/not_the_lead/legacy-lead?campaign=legacy-campaign")
        self.assertEqual(wrong_username.status_code, 404)
        with db_module.db() as conn:
            event = conn.execute("SELECT * FROM crm_tracking_events").fetchone()
            self.assertEqual(event["user_id"], self.user_id)
            self.assertEqual(event["campaign_id"], workflow["id"])
            self.assertEqual(event["lead_id"], lead["id"])


if __name__ == "__main__":
    unittest.main()
