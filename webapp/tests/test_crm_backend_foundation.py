import json
import base64
import os
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp.auth import get_current_user, require_admin
from webapp.crm import CRMError, install_crm
from webapp.crm.business import add_pool_members
from webapp.crm.capabilities import public_capabilities
from webapp.crm.importer import activate_import, dry_run_import, import_root
from webapp.crm.repository import cancel_workflow_atomic, confirm_workflow_atomic, create_resource, create_workflow_atomic, dispatch_next_action_atomic, list_resource, retry_workflow_atomic, transition_action_state_atomic
from webapp.crm.service import effective_module_state, require_write_capacity, set_user_access, sync_social_child_tasks, update_module_settings
from webapp.crm.tracking import sign_tracking_token
from webapp.crm_integration import crm_social_task_adapter, run_crm_runtime_once
from webapp.social_automation_api import _crm_task_policy_reason


class CRMBackendFoundationTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            key: os.environ.get(key)
            for key in ("APP_DB_PATH", "WEBAPP_DATA_DIR", "CRM_ENABLED", "CRM_TRACKING_SECRET", "CRM_MIN_FREE_BYTES")
        }
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        os.environ["CRM_ENABLED"] = "1"
        os.environ["CRM_TRACKING_SECRET"] = "crm-test-secret-that-is-longer-than-32-bytes"
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            self.admin_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) VALUES ('crm_admin','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            self.user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) VALUES ('crm_user','x',0,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            self.other_user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) VALUES ('crm_other','x',0,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _enable(self, conn: sqlite3.Connection, user_id: int | None = None) -> None:
        update_module_settings(conn, {"enabled": True})
        set_user_access(
            conn,
            user_id=int(user_id or self.user_id),
            enabled=True,
            actor_user_id=self.admin_id,
        )

    def _grant_dm_consent(self, conn: sqlite3.Connection, lead_id: str) -> None:
        now = 1_700_000_000
        conn.execute(
            """
            INSERT INTO crm_events(
              id,user_id,lead_id,event_type,occurred_at,payload_json,active,created_at,updated_at
            ) VALUES (?,?,?,?,?,'{}',1,?,?)
            """,
            (f"consent-{lead_id}", self.user_id, str(lead_id), "consent_verified", now, now, now),
        )

    def test_schema_contains_native_crm_tables_and_indexes(self):
        expected = {
            "user_module_access", "crm_workflows", "crm_workflow_steps", "crm_action_ledger",
            "crm_pools", "crm_leads", "crm_pool_members", "crm_events", "crm_hotspots",
            "crm_relationships", "crm_templates", "crm_media", "crm_schedules", "crm_groups",
            "crm_destinations", "crm_tracking_events", "crm_import_batches", "crm_legacy_id_map",
        }
        with db_module.db() as conn:
            names = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        self.assertTrue(expected.issubset(names))
        self.assertIn("idx_crm_action_idempotency", indexes)
        self.assertIn("idx_crm_workflows_list", indexes)

    def test_atomic_workflow_links_billing_child_task_and_ledger(self):
        observed = {}

        def billing_adapter(conn, request):
            self.assertTrue(conn.in_transaction)
            observed["billing"] = request
            return {"reservation_id": "bill_crm_1"}

        def social_adapter(conn, request):
            self.assertTrue(conn.in_transaction)
            observed["social"] = request
            self.assertEqual(request["billing_reservation_id"], "bill_crm_1")
            self.assertEqual(request["action"]["billing_reservation_id"], "bill_crm_1")
            return {"social_task_id": "social_crm_1"}

        with db_module.db() as conn:
            self._grant_dm_consent(conn, "lead-1")
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="private_outreach",
                title="test workflow",
                input_data={"locale": "zh-Hant"},
                idempotency_key="workflow-request-1",
                confirmed_by=self.user_id,
                actions=[{
                    "action_type": "direct_message", "target_key": "threads:lead-1",
                    "account_id": "account-1", "content": "hello", "sku": "crm_dm_batch",
                    "payload": {"lead_id": "lead-1"},
                }],
                billing_adapter=billing_adapter,
                social_task_adapter=social_adapter,
            )
        self.assertEqual(workflow["status"], "queued")
        self.assertEqual(workflow["actions"][0]["billing_reservation_id"], "bill_crm_1")
        self.assertEqual(workflow["steps"][0]["social_task_id"], "social_crm_1")
        self.assertEqual(observed["billing"]["action_id"], workflow["actions"][0]["id"])

        # Idempotent replay returns the same graph and never calls adapters again.
        def fail_adapter(_conn, _request):
            raise AssertionError("adapter must not be called on replay")

        with db_module.db() as conn:
            replay = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="private_outreach",
                title="ignored replay",
                input_data={},
                idempotency_key="workflow-request-1",
                actions=[],
                billing_adapter=fail_adapter,
                social_task_adapter=fail_adapter,
            )
        self.assertEqual(replay["id"], workflow["id"])

    def test_workflow_charges_one_approved_batch_per_sku(self):
        billing_requests = []
        social_requests = []

        def billing_adapter(_conn, request):
            billing_requests.append(dict(request))
            if request["operation"] == "reserve":
                return {"reservation_id": "bill-once"}
            return {"reservation_id": request.get("reservation_id", ""), "status": "settled"}

        def social_adapter(_conn, request):
            social_requests.append(dict(request))
            return {"social_task_id": f"social-{len(social_requests)}"}

        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="public_batch",
                title="two comments",
                input_data={},
                idempotency_key="one-charge-per-sku",
                confirmed_by=self.user_id,
                actions=[
                    {"action_type": "public_comment", "account_id": "a", "target_key": "post:1", "content": "one"},
                    {"action_type": "public_comment", "account_id": "a", "target_key": "post:2", "content": "two"},
                ],
                billing_adapter=billing_adapter,
                social_task_adapter=social_adapter,
            )
            first = workflow["actions"][0]
            for state in ("reserved", "submitting", "submitted", "confirmed"):
                transition_action_state_atomic(
                    conn, user_id=self.user_id, action_id=first["id"], state=state,
                    evidence={"platform_id": "post-1"} if state == "confirmed" else {},
                    billing_adapter=billing_adapter,
                )
            dispatched = dispatch_next_action_atomic(
                conn, user_id=self.user_id, workflow_id=workflow["id"],
                billing_adapter=billing_adapter, social_task_adapter=social_adapter,
            )
        reserves = [item for item in billing_requests if item["operation"] == "reserve"]
        self.assertEqual(len(reserves), 1)
        self.assertEqual(reserves[0]["quantity"], 1)
        self.assertEqual(len(social_requests), 2)
        self.assertEqual(dispatched["actions"][1]["billing_reservation_id"], "")
        self.assertNotIn("scheduled_at", social_requests[0])
        self.assertGreaterEqual(int(social_requests[1]["scheduled_at"]), int(time.time()) + 179)
        self.assertLessEqual(int(social_requests[1]["scheduled_at"]), int(time.time()) + 301)

    def test_write_workflow_waits_for_explicit_confirmation_before_dispatch(self):
        calls = []

        def billing(conn, request):
            calls.append(("billing", request["operation"]))
            return {"reservation_id": "confirm-bill"}

        def social(conn, request):
            calls.append(("social", request["operation"]))
            return {"social_task_id": "confirm-social"}

        with db_module.db() as conn:
            self._grant_dm_consent(conn, "lead-confirm")
            waiting = create_workflow_atomic(
                conn, user_id=self.user_id, workflow_type="direct_message", title="needs confirm",
                input_data={}, idempotency_key="needs-confirmation",
                actions=[{
                    "action_type": "direct_message", "target_key": "lead-confirm", "content": "hi",
                    "sku": "crm_dm_batch", "payload": {"lead_id": "lead-confirm"},
                }],
                billing_adapter=billing, social_task_adapter=social,
            )
            self.assertEqual(waiting["status"], "awaiting_confirmation")
            self.assertEqual(calls, [])
            confirmed = confirm_workflow_atomic(
                conn, user_id=self.user_id, workflow_id=waiting["id"], confirmed_by=self.user_id,
                billing_adapter=billing, social_task_adapter=social,
            )
        self.assertEqual(confirmed["status"], "queued")
        self.assertEqual(confirmed["steps"][0]["social_task_id"], "confirm-social")
        self.assertEqual(confirmed["actions"][0]["billing_reservation_id"], "confirm-bill")
        self.assertEqual(confirmed["confirmation"]["confirmed_by"], self.user_id)
        self.assertEqual(calls, [("billing", "reserve"), ("social", "create")])

    def test_direct_message_dispatch_rechecks_trust_after_preflight(self):
        calls = []

        def adapter(_conn, request):
            calls.append(request)
            return {"reservation_id": "unexpected", "social_task_id": "unexpected"}

        with self.assertRaises(CRMError) as blocked:
            with db_module.db() as conn:
                self._grant_dm_consent(conn, "lead-revoked")
                waiting = create_workflow_atomic(
                    conn,
                    user_id=self.user_id,
                    workflow_type="direct_message",
                    title="trust is rechecked",
                    input_data={},
                    idempotency_key="dm-trust-recheck",
                    actions=[{
                        "action_type": "direct_message",
                        "target_key": "instagram:lead-revoked",
                        "account_id": "sender-1",
                        "content": "approved while consent exists",
                        "payload": {"lead_id": "lead-revoked"},
                    }],
                    billing_adapter=adapter,
                    social_task_adapter=adapter,
                )
                conn.execute(
                    "UPDATE crm_events SET active=0 WHERE user_id=? AND lead_id=?",
                    (self.user_id, "lead-revoked"),
                )
                confirm_workflow_atomic(
                    conn,
                    user_id=self.user_id,
                    workflow_id=waiting["id"],
                    confirmed_by=self.user_id,
                    billing_adapter=adapter,
                    social_task_adapter=adapter,
                )
        self.assertEqual(blocked.exception.code, "crm_direct_message_trust_evidence_required")
        self.assertEqual(calls, [])

    def test_server_owned_action_contract_blocks_free_write_disguise_and_nested_secrets(self):
        with db_module.db() as conn:
            self._enable(conn)
            now = 1_700_000_050
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,created_at,updated_at) VALUES ('contract-account',?,'persona','threads','contract_user','profiles/contract','ready',?,?)",
                (self.user_id, now, now),
            )
            waiting = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="comment",
                title="cannot be free",
                input_data={},
                idempotency_key="server-owned-write",
                actions=[{
                    "action_type": "public_comment",
                    "target_key": "https://www.threads.net/t/disguise",
                    "account_id": "contract-account",
                    "content": "real comment",
                    "write": False,
                    "task_type": "browse_profile",
                    "sku": "",
                }],
                social_task_adapter=crm_social_task_adapter,
            )
            self.assertEqual(waiting["status"], "awaiting_confirmation")
            self.assertEqual(waiting["steps"][0]["payload"]["write"], True)
            self.assertEqual(waiting["steps"][0]["payload"]["sku"], "threads_auto_reply_batch")
            self.assertFalse(waiting["steps"][0]["social_task_id"])

            read = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="collection",
                title="read stays read",
                input_data={},
                idempotency_key="server-owned-read",
                actions=[{
                    "action_type": "collect_profile",
                    "target_key": "https://www.threads.net/@target",
                    "account_id": "contract-account",
                    "content": "smuggled comment",
                    "task_type": "comment_post",
                    "payload": {"comment": "smuggled comment", "task_type": "comment_post"},
                }],
                social_task_adapter=crm_social_task_adapter,
            )
            child = conn.execute(
                "SELECT task_type,payload_json,billing_reservation_id FROM social_automation_tasks WHERE id=?",
                (read["steps"][0]["social_task_id"],),
            ).fetchone()
            self.assertEqual(child["task_type"], "browse_profile")
            self.assertFalse(child["billing_reservation_id"])
            child_payload = json.loads(child["payload_json"])
            self.assertNotIn("comment", child_payload)
            self.assertNotIn("task_type", child_payload)

            with self.assertRaises(CRMError) as secret_error:
                create_workflow_atomic(
                    conn,
                    user_id=self.user_id,
                    workflow_type="collection",
                    title="secret rejected",
                    input_data={},
                    idempotency_key="server-owned-secret",
                    actions=[{
                        "action_type": "collect_profile",
                        "target_key": "threads:secret",
                        "account_id": "contract-account",
                        "payload": {"nested": [{"Access-Token": "must-not-persist"}]},
                    }],
                    social_task_adapter=crm_social_task_adapter,
                )
            self.assertEqual(secret_error.exception.code, "crm_durable_secret_forbidden")

    def test_concurrent_workflow_idempotency_reuses_one_graph(self):
        def create_once():
            with db_module.db() as conn:
                return create_workflow_atomic(
                    conn,
                    user_id=self.user_id,
                    workflow_type="analysis",
                    title="concurrent",
                    input_data={},
                    idempotency_key="concurrent-workflow-key",
                    actions=[],
                )["id"]

        with ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(lambda _index: create_once(), range(2)))
        self.assertEqual(len(set(ids)), 1)
        with db_module.db() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM crm_workflows WHERE user_id=? AND idempotency_key='concurrent-workflow-key'",
                    (self.user_id,),
                ).fetchone()[0],
                1,
            )

    def test_retry_continues_without_replaying_confirmed_actions(self):
        dispatched = []

        def social(_conn, request):
            dispatched.append(str(request["action"]["target_key"]))
            return {"social_task_id": f"retry-child-{len(dispatched)}"}

        with db_module.db() as conn:
            original = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="sequence",
                title="retry continuation",
                input_data={},
                idempotency_key="retry-original",
                actions=[
                    {"action_type": "collect_profile", "target_key": "lead:confirmed"},
                    {"action_type": "collect_profile", "target_key": "lead:pending"},
                ],
                social_task_adapter=social,
            )
            by_target = {str(item["target_key"]): item for item in original["actions"]}
            first = by_target["lead:confirmed"]
            second = by_target["lead:pending"]
            conn.execute("UPDATE crm_action_ledger SET state='confirmed' WHERE id=?", (first["id"],))
            conn.execute("UPDATE crm_workflows SET status='failed' WHERE id=?", (original["id"],))
            retried = retry_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_id=original["id"],
                idempotency_key="retry-continuation",
                confirmed_by=self.user_id,
                billing_adapter=None,
                social_task_adapter=social,
            )
            original_states = {
                row["id"]: row["state"]
                for row in conn.execute(
                    "SELECT id,state FROM crm_action_ledger WHERE workflow_id=?",
                    (original["id"],),
                ).fetchall()
            }
        self.assertEqual([item["target_key"] for item in retried["actions"]], ["lead:pending"])
        self.assertEqual(original_states[first["id"]], "confirmed")
        self.assertEqual(original_states[second["id"]], "skipped")
        self.assertEqual(dispatched, ["lead:confirmed", "lead:pending"])

    def test_write_ledger_blocks_duplicate_target_and_content_across_workflows(self):
        def billing(_conn, request):
            return {"reservation_id": f"bill-{request['action_id']}"}

        def social(_conn, request):
            return {"social_task_id": f"social-{request['action_id']}"}

        action = {
            "action_type": "public_comment", "target_key": "threads:post-duplicate",
            "account_id": "account-1", "content": "same comment", "sku": "threads_auto_reply_batch",
        }
        with db_module.db() as conn:
            create_workflow_atomic(
                conn, user_id=self.user_id, workflow_type="comment", title="first", input_data={},
                idempotency_key="duplicate-first", confirmed_by=self.user_id, actions=[action],
                billing_adapter=billing, social_task_adapter=social,
            )
        with self.assertRaises(CRMError) as raised:
            with db_module.db() as conn:
                create_workflow_atomic(
                    conn, user_id=self.user_id, workflow_type="comment", title="second", input_data={},
                    idempotency_key="duplicate-second", confirmed_by=self.user_id, actions=[action],
                    billing_adapter=billing, social_task_adapter=social,
                )
        self.assertEqual(raised.exception.code, "crm_duplicate_action")

    def test_direct_message_ledger_blocks_recipient_across_sender_rotation(self):
        def billing(_conn, request):
            return {"reservation_id": f"bill-{request['action_id']}"}

        def social(_conn, request):
            return {"social_task_id": f"social-{request['action_id']}"}

        first = {
            "action_type": "direct_message", "target_key": "instagram:lead-once",
            "account_id": "sender-1", "content": "first copy",
            "payload": {"lead_id": "lead-once"},
        }
        changed_copy = dict(first, content="a different message must not bypass recipient dedupe")
        with db_module.db() as conn:
            self._grant_dm_consent(conn, "lead-once")
            create_workflow_atomic(
                conn, user_id=self.user_id, workflow_type="private_outreach", title="first", input_data={},
                idempotency_key="dm-recipient-first", confirmed_by=self.user_id, actions=[first],
                billing_adapter=billing, social_task_adapter=social,
            )
        with self.assertRaises(CRMError) as raised:
            with db_module.db() as conn:
                create_workflow_atomic(
                    conn, user_id=self.user_id, workflow_type="private_outreach", title="second", input_data={},
                    idempotency_key="dm-recipient-second", confirmed_by=self.user_id, actions=[changed_copy],
                    billing_adapter=billing, social_task_adapter=social,
                )
        self.assertEqual(raised.exception.code, "crm_duplicate_action")

        with self.assertRaises(CRMError) as rotated_duplicate:
            with db_module.db() as conn:
                create_workflow_atomic(
                    conn, user_id=self.user_id, workflow_type="private_outreach", title="rotated sender", input_data={},
                    idempotency_key="dm-recipient-third", confirmed_by=self.user_id,
                    actions=[dict(changed_copy, account_id="sender-2")],
                    billing_adapter=billing, social_task_adapter=social,
                )
        self.assertEqual(rotated_duplicate.exception.code, "crm_duplicate_action")

    def test_adapter_failure_rolls_back_parent_step_ledger_and_reservation_side_effect(self):
        def billing_adapter(conn, request):
            conn.execute(
                "INSERT INTO crm_events(id,user_id,event_type,active,created_at,updated_at) VALUES ('billing-side-effect',?,'billing_reserved',1,1,1)",
                (self.user_id,),
            )
            return {"reservation_id": "bill_will_rollback"}

        def social_adapter(_conn, _request):
            raise CRMError("crm_action_blocked", "crm.errors.actionBlocked", status_code=409)

        with self.assertRaises(CRMError):
            with db_module.db() as conn:
                create_workflow_atomic(
                    conn,
                    user_id=self.user_id,
                    workflow_type="comment",
                    title="rollback",
                    input_data={},
                    idempotency_key="workflow-rollback",
                    confirmed_by=self.user_id,
                    actions=[{"action_type": "comment", "target_key": "post-1", "content": "x", "sku": "interaction_batch"}],
                    billing_adapter=billing_adapter,
                    social_task_adapter=social_adapter,
                )
        with db_module.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_workflows WHERE user_id=?", (self.user_id,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_action_ledger WHERE user_id=?", (self.user_id,)).fetchone()[0], 0)
            self.assertIsNone(conn.execute("SELECT 1 FROM crm_events WHERE id='billing-side-effect'").fetchone())

    def test_cancel_releases_billing_and_cancels_child_in_same_transaction(self):
        calls = []

        def billing(conn, request):
            self.assertTrue(conn.in_transaction)
            calls.append(("billing", request["operation"]))
            return {"reservation_id": "cancel-bill"}

        def social(conn, request):
            self.assertTrue(conn.in_transaction)
            calls.append(("social", request["operation"]))
            return {"social_task_id": "cancel-social"}

        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn, user_id=self.user_id, workflow_type="comment", title="cancel",
                input_data={}, idempotency_key="cancel-workflow",
                confirmed_by=self.user_id,
                actions=[{"action_type": "comment", "target_key": "post-cancel", "content": "x", "sku": "interaction_batch"}],
                billing_adapter=billing, social_task_adapter=social,
            )
            cancelled = cancel_workflow_atomic(
                conn, user_id=self.user_id, workflow_id=workflow["id"],
                billing_adapter=billing, social_task_adapter=social,
            )
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["actions"][0]["state"], "skipped")
        self.assertIn(("social", "cancel"), calls)
        self.assertIn(("billing", "release"), calls)

    def test_cancel_observes_already_successful_child_and_never_marks_it_skipped(self):
        operations = []

        def billing(_conn, request):
            operations.append(request["operation"])
            return {"reservation_id": "cancel-race-bill", "status": "settled"}

        def social(_conn, request):
            if request["operation"] == "create":
                return {"social_task_id": "cancel-race-child"}
            return {"social_task_id": "cancel-race-child", "status": "success", "result": {"platform_url": "https://example.test/proof"}}

        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="comment",
                title="cancel race",
                input_data={},
                idempotency_key="cancel-race-workflow",
                confirmed_by=self.user_id,
                actions=[{
                    "action_type": "public_comment",
                    "target_key": "threads:cancel-race",
                    "content": "already posted",
                }],
                billing_adapter=billing,
                social_task_adapter=social,
            )
            cancelled = cancel_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_id=workflow["id"],
                billing_adapter=billing,
                social_task_adapter=social,
            )
        self.assertEqual(cancelled["actions"][0]["state"], "confirmed")
        self.assertEqual(cancelled["steps"][0]["status"], "success")
        self.assertEqual(operations, ["reserve", "settle"])

    def test_social_child_reconcile_marks_submission_crash_unknown_without_release(self):
        with db_module.db() as conn:
            now = 1_700_000_100
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,created_at,updated_at) VALUES ('crm-account',?,'persona','threads','crm_handle','profiles/crm',?,?)",
                (self.user_id, now, now),
            )

            def social_adapter(inner, request):
                inner.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id,user_id,persona_id,account_id,platform,task_type,status,payload_json,created_at,updated_at
                    ) VALUES ('crm-social-child',?,'persona','crm-account','threads','comment_post','queued','{}',?,?)
                    """,
                    (self.user_id, now, now),
                )
                return {"social_task_id": "crm-social-child"}

            workflow = create_workflow_atomic(
                conn, user_id=self.user_id, workflow_type="comment", title="reconcile",
                input_data={}, idempotency_key="reconcile-workflow",
                actions=[{"action_type": "public_comment", "target_key": "post-reconcile", "content": "x"}],
                confirmed_by=self.user_id,
                billing_adapter=lambda _conn, request: {"reservation_id": f"bill-{request['action_id']}"},
                social_task_adapter=social_adapter,
            )
            queued = sync_social_child_tasks(conn, user_id=self.user_id, workflow_id=workflow["id"])
            self.assertEqual(queued["workflow"]["actions"][0]["state"], "reserved")
            conn.execute(
                "UPDATE social_automation_tasks SET status='failed',payload_json=?,result_json=?,error='worker crashed',updated_at=? WHERE id='crm-social-child'",
                (
                    json.dumps({"_billing_submission_state": "submitted"}),
                    json.dumps({"action_outcome_unknown": True}),
                    now + 5,
                ),
            )
            unknown = sync_social_child_tasks(conn, user_id=self.user_id, workflow_id=workflow["id"])
            self.assertEqual(unknown["workflow"]["actions"][0]["state"], "unknown")
            self.assertEqual(unknown["workflow"]["status"], "manual_required")
            conn.execute(
                "UPDATE social_automation_tasks SET status='success',result_json='{}',updated_at=? WHERE id='crm-social-child'",
                (now + 10,),
            )
            still_unknown = sync_social_child_tasks(conn, user_id=self.user_id, workflow_id=workflow["id"])
            self.assertEqual(still_unknown["workflow"]["actions"][0]["state"], "unknown")
            self.assertEqual(still_unknown["workflow"]["status"], "manual_required")

    def test_manual_unknown_review_releases_or_settles_held_billing(self):
        operations = []

        def billing(_conn, request):
            operations.append(request["operation"])
            return {"reservation_id": "review-bill", "status": "released"}

        def social(_conn, _request):
            return {"social_task_id": "review-social"}

        with db_module.db() as conn:
            workflow = create_workflow_atomic(
                conn, user_id=self.user_id, workflow_type="comment", title="review", input_data={},
                idempotency_key="unknown-review", confirmed_by=self.user_id,
                actions=[{"action_type": "public_comment", "target_key": "post-review", "content": "x", "sku": "threads_auto_reply_batch"}],
                billing_adapter=billing, social_task_adapter=social,
            )
            action_id = workflow["actions"][0]["id"]
            transition_action_state_atomic(conn, user_id=self.user_id, action_id=action_id, state="submitting")
            transition_action_state_atomic(conn, user_id=self.user_id, action_id=action_id, state="unknown")
            reviewed = transition_action_state_atomic(
                conn, user_id=self.user_id, action_id=action_id, state="failed",
                manual_review=True, evidence={"checked": True}, billing_adapter=billing,
            )
        self.assertEqual(reviewed["state"], "failed")
        self.assertEqual(operations, ["reserve", "release"])

    def test_real_social_adapter_creates_child_and_policy_revocation_blocks_submission(self):
        with db_module.db() as conn:
            self._enable(conn)
            now = 1_700_000_200
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,created_at,updated_at) VALUES ('native-crm-account',?,'persona','threads','native_crm','profiles/native','ready',?,?)",
                (self.user_id, now, now),
            )
            workflow = create_workflow_atomic(
                conn,
                user_id=self.user_id,
                workflow_type="collection",
                title="native collection",
                input_data={},
                idempotency_key="native-social-adapter",
                actions=[{
                    "action_type": "collect_profile", "target_key": "https://www.threads.net/@target",
                    "account_id": "native-crm-account", "write": False,
                }],
                social_task_adapter=crm_social_task_adapter,
            )
            task = conn.execute(
                "SELECT * FROM social_automation_tasks WHERE id=?",
                (workflow["steps"][0]["social_task_id"],),
            ).fetchone()
            self.assertEqual(task["created_by"], "crm")
            self.assertEqual(task["task_type"], "browse_profile")
            set_user_access(conn, user_id=self.user_id, enabled=False, actor_user_id=self.admin_id)
            reason = _crm_task_policy_reason(conn, task)
            self.assertIn("permission_denied", reason)

    def test_unported_social_action_rolls_back_instead_of_faking_success(self):
        with self.assertRaises(Exception):
            with db_module.db() as conn:
                self._enable(conn)
                now = 1_700_000_300
                conn.execute(
                    "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,created_at,updated_at) VALUES ('blocked-crm-account',?,'persona','instagram','blocked_crm','profiles/blocked','ready',?,?)",
                    (self.user_id, now, now),
                )
                create_workflow_atomic(
                    conn,
                    user_id=self.user_id,
                    workflow_type="direct_message",
                    title="must block",
                    input_data={},
                    idempotency_key="blocked-social-adapter",
                    confirmed_by=self.user_id,
                    actions=[{
                        "action_type": "direct_message", "target_key": "instagram:lead",
                        "account_id": "blocked-crm-account", "write": False,
                    }],
                    social_task_adapter=crm_social_task_adapter,
                )
        with db_module.db() as conn:
            self.assertIsNone(conn.execute(
                "SELECT 1 FROM crm_workflows WHERE idempotency_key='blocked-social-adapter'"
            ).fetchone())

    def test_tenant_scoped_cursor_pagination(self):
        with db_module.db() as conn:
            for index in range(4):
                create_resource(conn, "pools", user_id=self.user_id, payload={"name": f"pool-{index}"})
            create_resource(conn, "pools", user_id=self.other_user_id, payload={"name": "other-secret"})
            first = list_resource(conn, "pools", user_id=self.user_id, limit=2)
            second = list_resource(conn, "pools", user_id=self.user_id, limit=2, cursor=first["next_cursor"])
        names = [item["name"] for item in first["items"] + second["items"]]
        self.assertEqual(len(names), 4)
        self.assertNotIn("other-secret", names)
        self.assertTrue(first["has_more"])

    def test_scheduler_lease_materializes_each_due_slot_once(self):
        with db_module.db() as conn:
            self._enable(conn)
            current = 1_700_000_000
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('scheduled-collection-account',?,'scheduled-persona','threads','scheduled_collector','profiles/scheduled','ready','alive',?,?)",
                (self.user_id, current, current),
            )
            create_resource(
                conn,
                "schedules",
                user_id=self.user_id,
                payload={
                    "workflow_type": "scheduled_collection",
                    "cron_expression": "*/5 * * * *",
                    "timezone": "Asia/Shanghai",
                    "enabled": 1,
                    "next_run_at": 0,
                    "payload": {
                        "title": "scheduled test",
                        "actions": [{
                            "action_type": "collect_profile",
                            "account_id": "scheduled-collection-account",
                            "target_key": "https://www.threads.com/@scheduled_target",
                            "payload": {"target_url": "https://www.threads.com/@scheduled_target"},
                        }],
                    },
                },
            )
        initialized = run_crm_runtime_once()
        self.assertTrue(initialized["leader"])
        self.assertEqual(initialized["schedules"], 0)
        with db_module.db() as conn:
            schedule = conn.execute(
                "SELECT id,next_run_at FROM crm_schedules WHERE user_id=?",
                (self.user_id,),
            ).fetchone()
            self.assertGreater(int(schedule["next_run_at"]), 0)
            conn.execute("UPDATE crm_schedules SET next_run_at=1 WHERE id=?", (schedule["id"],))
        first_due = run_crm_runtime_once()
        replay = run_crm_runtime_once()
        self.assertEqual(first_due["schedules"], 1)
        self.assertEqual(replay["schedules"], 0)
        with db_module.db() as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM crm_workflows WHERE user_id=? AND workflow_type='scheduled_collection'",
                (self.user_id,),
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_module_precedence_and_permission_default(self):
        with db_module.db() as conn:
            update_module_settings(conn, {"enabled": True})
            denied = effective_module_state(conn, user_id=self.user_id)
            self.assertFalse(denied["effective"])
            self.assertIn("permission_denied", denied["reasons"])
            set_user_access(conn, user_id=self.user_id, enabled=True, actor_user_id=self.admin_id)
            allowed = effective_module_state(conn, user_id=self.user_id)
            self.assertTrue(allowed["effective"])
        os.environ["CRM_ENABLED"] = "0"
        with db_module.db() as conn:
            hard_disabled = effective_module_state(conn, user_id=self.user_id)
        self.assertFalse(hard_disabled["effective"])
        self.assertIn("hard_disabled", hard_disabled["reasons"])

    def test_runtime_capabilities_enable_native_ports_and_keep_legacy_secrets_blocked(self):
        capabilities = public_capabilities()
        self.assertTrue(capabilities["public_interaction"]["enabled"])
        self.assertEqual(capabilities["public_interaction"]["status"], "adapted")
        self.assertTrue(capabilities["direct_message_batch"]["enabled"])
        self.assertEqual(capabilities["direct_message_batch"]["status"], "adapted")
        for key in ("instagram_group_management", "ai_demand_analysis", "opc_history_live_query"):
            self.assertTrue(capabilities[key]["enabled"])
            self.assertEqual(capabilities[key]["status"], "adapted")
        self.assertFalse(capabilities["legacy_ai_secret_config"]["enabled"])
        self.assertEqual(capabilities["legacy_ai_secret_config"]["status"], "blocked")
        self.assertTrue(capabilities["legacy_ai_secret_config"]["reason_code"])

    def test_low_disk_gate_stops_new_crm_writes(self):
        os.environ["CRM_MIN_FREE_BYTES"] = str(2**63 - 1)
        with self.assertRaises(CRMError) as raised:
            require_write_capacity()
        self.assertEqual(raised.exception.code, "crm_storage_unavailable")
        self.assertEqual(raised.exception.status_code, 507)

    def test_legacy_import_is_dry_run_first_and_idempotent(self):
        root = import_root(self.root)
        source = root / "crm-state.json"
        source.write_text(
            json.dumps({
                "pools": [{"id": "old-pool", "name": "Legacy pool"}],
                "events": [{"id": "old-event", "event_type": "reply", "payload": {"ok": True}}],
                "templates": [{"id": "old-template", "name": "Welcome", "content": "Hi"}],
                "tasks": [{"id": "old-task", "type": "collect", "status": "success"}],
            }),
            encoding="utf-8",
        )
        with db_module.db() as conn:
            dry = dry_run_import(
                conn, user_id=self.admin_id, actor_user_id=self.admin_id,
                root=root, source="crm-state.json",
            )
            self.assertEqual(dry["status"], "dry_run")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_pools").fetchone()[0], 0)
            active = activate_import(conn, batch_id=dry["id"], user_id=self.admin_id)
            replay = activate_import(conn, batch_id=dry["id"], user_id=self.admin_id)
            self.assertEqual(active["status"], "active")
            self.assertEqual(replay["id"], active["id"])
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_pools WHERE active=1").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_workflows WHERE active=1").fetchone()[0], 1)

    def test_real_crm_snapshot_shape_normalizes_fields_and_pool_memberships(self):
        root = import_root(self.root)
        source = root / "crm-state.json"
        lead = {
            "id": "legacy-lead", "username": "Target_User", "platform": "threads",
            "profileUrl": "https://www.threads.net/@Target_User", "tags": ["warm"],
            "collectedAt": "2026-07-30T23:32:48.016Z",
            "mortgageClassification": {"stage": "qualified"},
        }
        source.write_text(json.dumps({
            "pools": [
                {"id": "pool-a", "customName": "A", "leads": [lead]},
                {"id": "pool-b", "name": "B", "leads": [lead]},
            ],
            "events": [{"id": "event-a", "type": "public_comment_published", "taskId": "task-a", "leadId": "legacy-lead", "createdAt": "2026-07-30T23:32:48.016Z", "detail": {"ok": True}}],
            "hotspots": [{"id": "hot-a", "sourceUrl": "https://www.threads.net/t/1", "text": "topic", "likeCount": 3, "collectedAt": "2026-07-30T23:32:48.016Z"}],
            "relationships": [{"senderUsername": "sender", "targetUsername": "Target_User", "status": "mutual", "checkedAt": "2026-07-30T23:32:48.016Z"}],
            "templates": [{"id": "tpl-a", "name": "Welcome", "kind": "outreach", "message": "hello"}],
            "tasks": [{"id": "task-a", "type": "outreach", "status": "running", "createdAt": "2026-07-30T23:32:48.016Z"}],
        }), encoding="utf-8")
        with db_module.db() as conn:
            now = 1_700_000_000
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,created_at,updated_at) VALUES ('legacy-sender-account',?,'legacy-persona','threads','sender','profiles/legacy-sender','ready',?,?)",
                (self.admin_id, now, now),
            )
            dry = dry_run_import(conn, user_id=self.admin_id, actor_user_id=self.admin_id, root=root, source="crm-state.json")
            self.assertEqual(dry["counts"]["pool_members"], 2)
            active = activate_import(conn, batch_id=dry["id"], user_id=self.admin_id)
            self.assertEqual(active["status"], "active")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_leads WHERE active=1").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_pool_members WHERE active=1").fetchone()[0], 2)
            event = conn.execute("SELECT * FROM crm_events WHERE legacy_id='event-a'").fetchone()
            workflow = conn.execute("SELECT * FROM crm_workflows WHERE legacy_id='task-a'").fetchone()
            self.assertEqual(workflow["status"], "paused_by_policy")
            self.assertEqual(event["event_type"], "public_comment_published")
            self.assertEqual(event["workflow_id"], workflow["id"])
            self.assertGreater(event["occurred_at"], 1_700_000_000)
            hotspot = conn.execute("SELECT * FROM crm_hotspots WHERE legacy_id='hot-a'").fetchone()
            self.assertEqual(hotspot["source_url"], "https://www.threads.net/t/1")
            self.assertEqual(hotspot["content"], "topic")
            template = conn.execute("SELECT * FROM crm_templates WHERE legacy_id='tpl-a'").fetchone()
            self.assertEqual(template["template_type"], "outreach")
            self.assertEqual(template["content"], "hello")

    def test_opc_array_snapshots_are_preserved_but_credentials_and_profiles_are_skipped(self):
        root = import_root(self.root)
        package = root / "opc-package"
        package.mkdir()
        (package / "threads-outreach-events.json").write_text(
            json.dumps([{"id": "opc-event", "eventType": "outreach_completed", "createdAt": "2026-07-30T00:00:00Z"}]), encoding="utf-8",
        )
        (package / "threads-daily-runs.json").write_text(
            json.dumps([{"id": "opc-run", "status": "success", "startedAt": "2026-07-30T00:00:00Z", "rows": [{"username": "kept-in-audit"}]}]), encoding="utf-8",
        )
        (package / "vecto-credential-vault.json").write_text(json.dumps({"token": "must-not-import"}), encoding="utf-8")
        profiles = package / "threads-sender-profiles" / "sender" / "profile"
        profiles.mkdir(parents=True)
        (profiles / "cookie.json").write_text(json.dumps({"cookie": "must-not-import"}), encoding="utf-8")
        with db_module.db() as conn:
            dry = dry_run_import(conn, user_id=self.admin_id, actor_user_id=self.admin_id, root=root, source="opc-package")
            self.assertTrue(any("credential" in item for item in dry["report"]["skipped_sensitive_paths"]))
            self.assertTrue(any("profile" in item for item in dry["report"]["skipped_sensitive_paths"]))
            activate_import(conn, batch_id=dry["id"], user_id=self.admin_id)
            self.assertIsNotNone(conn.execute("SELECT 1 FROM crm_events WHERE legacy_id='opc-event' AND event_type='outreach_completed'").fetchone())
            run = conn.execute("SELECT legacy_payload_json FROM crm_workflows WHERE legacy_id='opc-run'").fetchone()
            self.assertIn("kept-in-audit", run["legacy_payload_json"])
            self.assertNotIn("must-not-import", "".join(
                str(row[0]) for row in conn.execute("SELECT legacy_payload_json FROM crm_workflows UNION ALL SELECT legacy_payload_json FROM crm_events").fetchall()
            ))

    def test_directory_import_manifests_attachments_skips_profiles_and_creates_backup(self):
        root = import_root(self.root)
        package = root / "legacy-package"
        package.mkdir()
        (package / "crm-state.json").write_text(
            json.dumps({"templates": [{"id": "template-with-media", "name": "Media", "content": "Hi", "media": "asset.png"}]}),
            encoding="utf-8",
        )
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        (package / "asset.png").write_bytes(png)
        evidence_dir = package / "audit-screenshots"
        evidence_dir.mkdir()
        (evidence_dir / "proof.png").write_bytes(png)
        profile = package / "profiles"
        profile.mkdir()
        (profile / "cookie.json").write_text("{}", encoding="utf-8")
        with db_module.db() as conn:
            dry = dry_run_import(
                conn, user_id=self.admin_id, actor_user_id=self.admin_id,
                root=root, source="legacy-package",
            )
            self.assertEqual(dry["report"]["attachments"], 2)
            self.assertEqual(dry["report"]["media_attachments"], 1)
            self.assertEqual(dry["report"]["evidence_attachments"], 1)
            self.assertTrue(any("profiles" in item for item in dry["report"]["skipped_sensitive_paths"]))
            active = activate_import(conn, batch_id=dry["id"], user_id=self.admin_id)
            self.assertEqual(active["status"], "active")
            self.assertTrue(Path(active["report"]["backup_path"]).is_file())
            media = conn.execute("SELECT storage_path FROM crm_media WHERE user_id=? AND active=1", (self.admin_id,)).fetchone()
            self.assertIsNotNone(media)
            self.assertTrue((self.root / str(media["storage_path"])).is_file())
            evidence = conn.execute(
                "SELECT entity_id FROM crm_legacy_id_map WHERE import_batch_id=? AND entity_type='evidence'",
                (dry["id"],),
            ).fetchone()
            self.assertIsNotNone(evidence)
            self.assertTrue((self.root / str(evidence["entity_id"])).is_file())

    def test_router_uniform_error_and_post_commit_notification(self):
        notifications = []
        app = FastAPI()

        def current_user():
            return {
                "id": self.admin_id, "is_admin": 1, "username": "crm_admin",
                "_workspace_user_id": self.user_id,
                "_workspace_username": "crm_user",
                "_workspace_admin_user_id": self.admin_id,
            }

        app.dependency_overrides[get_current_user] = current_user
        app.dependency_overrides[require_admin] = lambda: {"id": self.admin_id, "is_admin": 1}
        install_crm(
            app,
            post_commit_callback=notifications.append,
            social_task_adapter=lambda _conn, request: {"social_task_id": f"social-{request['action_id']}"},
        )
        client = TestClient(app)
        denied = client.get("/api/crm/v1/pools")
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["code"], "crm_module_unavailable")
        self.assertIn("request_id", denied.json())
        with db_module.db() as conn:
            self._enable(conn)
        app.dependency_overrides[get_current_user] = lambda: {
            "id": self.user_id, "is_admin": 0, "username": "crm_user",
        }
        ordinary_denied = client.get("/api/crm/v1/bootstrap")
        self.assertEqual(ordinary_denied.status_code, 403)
        self.assertEqual(ordinary_denied.json()["code"], "crm_admin_required")
        app.dependency_overrides[get_current_user] = current_user
        invalid_confirmation = client.post(
            "/api/crm/v1/tasks",
            json={
                "workflow_type": "analysis",
                "idempotency_key": "router-invalid-confirmation",
                "confirmed": "false",
                "actions": [],
            },
        )
        self.assertEqual(invalid_confirmation.status_code, 400)
        self.assertEqual(invalid_confirmation.json()["code"], "crm_invalid_confirmation")
        created = client.post(
            "/api/crm/v1/tasks",
            json={
                "workflow_type": "analysis", "idempotency_key": "router-workflow-1",
                "actions": [{"action_type": "collect_feed", "account_id": "read-account", "target_key": "search:test", "payload": {"query": "test", "platform": "threads"}}],
            },
        )
        self.assertEqual(created.status_code, 202, created.text)
        self.assertEqual(notifications[0]["event"], "workflow_created")
        bootstrap = client.get("/api/crm/v1/bootstrap")
        self.assertEqual(bootstrap.status_code, 200, bootstrap.text)
        self.assertTrue(bootstrap.json()["capabilities"]["direct_message_batch"]["enabled"])

    def test_write_task_requires_matching_server_preflight(self):
        app = FastAPI()
        app.dependency_overrides[get_current_user] = lambda: {
            "id": self.admin_id, "is_admin": 1, "username": "crm_admin",
            "_workspace_user_id": self.user_id,
            "_workspace_username": "crm_user",
            "_workspace_admin_user_id": self.admin_id,
        }
        app.dependency_overrides[require_admin] = lambda: {"id": self.admin_id, "is_admin": 1}
        install_crm(app)
        with db_module.db() as conn:
            self._enable(conn)
            now = 1_700_000_200
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('preflight-account',?,'persona','threads','writer','profiles/writer','ready','alive',?,?)",
                (self.user_id, now, now),
            )
        client = TestClient(app)
        action = {
            "action_type": "public_comment", "account_id": "preflight-account",
            "target_key": "https://www.threads.net/@target/post/one",
            "content": "这条分享把实际执行过程说明得很清楚，其中的边界条件很有参考价值。",
        }
        missing = client.post(
            "/api/crm/v1/tasks",
            json={"workflow_type": "public", "idempotency_key": "preflight-missing", "actions": [action]},
        )
        self.assertEqual(missing.status_code, 409, missing.text)
        self.assertEqual(missing.json()["code"], "crm_preflight_invalid")

        checked = client.post("/api/crm/v1/preflight", json={"actions": [action]})
        self.assertEqual(checked.status_code, 200, checked.text)
        self.assertEqual(checked.json()["allowed_count"], 1)
        self.assertEqual(checked.json()["quote"]["total_points"], 5)

        tampered = dict(action, content="changed")
        rejected = client.post(
            "/api/crm/v1/tasks",
            json={
                "workflow_type": "public", "idempotency_key": "preflight-tampered",
                "actions": [tampered], "preflight_token": checked.json()["preflight_token"],
            },
        )
        self.assertEqual(rejected.status_code, 409, rejected.text)
        self.assertEqual(rejected.json()["code"], "crm_preflight_invalid")

        created = client.post(
            "/api/crm/v1/tasks",
            json={
                "workflow_type": "public", "idempotency_key": "preflight-valid",
                "actions": checked.json()["actions"],
                "preflight_token": checked.json()["preflight_token"],
            },
        )
        self.assertEqual(created.status_code, 202, created.text)
        self.assertEqual(created.json()["status"], "awaiting_confirmation")

    def test_native_ai_comment_and_live_search_routes_keep_legacy_contracts(self):
        app = FastAPI()
        app.dependency_overrides[get_current_user] = lambda: {
            "id": self.admin_id, "is_admin": 1, "username": "crm_admin",
            "_workspace_user_id": self.user_id,
            "_workspace_username": "crm_user",
            "_workspace_admin_user_id": self.admin_id,
        }
        app.dependency_overrides[require_admin] = lambda: {"id": self.admin_id, "is_admin": 1}
        live_requests = []

        def live_executor(payload):
            live_requests.append(dict(payload))
            return {
                "ok": True,
                "liveOnly": True,
                "sourceKind": "live_platform",
                "historyFallback": False,
                "candidates": [{
                    "id": "live-one",
                    "username": "live_user",
                    "text": "正在比较 AI 营销自动化方案",
                    "sourceUrl": "https://www.threads.com/@live_user/post/live-one",
                    "platform": "threads",
                    "likeCount": 12,
                    "replyCount": 4,
                    "publishedAt": datetime.now(timezone.utc).isoformat(),
                }],
            }

        install_crm(app, live_search_executor=live_executor)
        with db_module.db() as conn:
            self._enable(conn)
            now = 1_700_000_200
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('live-account',?,'persona-live','threads','sender','profiles/sender','ready','alive',?,?)",
                (self.user_id, now, now),
            )
            pool = create_resource(conn, "pools", user_id=self.user_id, payload={"name": "AI prospects"})
            lead = create_resource(
                conn,
                "leads",
                user_id=self.user_id,
                payload={
                    "platform": "threads",
                    "platform_user_key": "draft_target",
                    "username": "draft_target",
                    "display_name": "Draft Target",
                    "profile": {
                        "text": "想比较房贷利率和每月还款压力",
                        "sourceUrl": "https://www.threads.com/@draft_target/post/demo",
                    },
                },
            )
            add_pool_members(conn, user_id=self.user_id, pool_id=pool["id"], lead_ids=[lead["id"]])
        client = TestClient(app)
        demand = client.post("/api/crm/v1/demand/analyze", json={"text": "寻找 AI 营销客户", "locale": "zh-Hans"})
        self.assertEqual(demand.status_code, 200, demand.text)
        self.assertTrue(demand.json()["keywords"])
        drafts = client.post(
            "/api/crm/v1/comments/drafts",
            json={"poolId": pool["id"], "selectedLeadIds": [lead["id"]], "locale": "zh-Hans"},
        )
        self.assertEqual(drafts.status_code, 200, drafts.text)
        self.assertEqual(drafts.json()["data"][0]["leadId"], lead["id"])
        self.assertTrue(drafts.json()["data"][0]["comment"])
        hotspots = client.post(
            "/api/crm/v1/hotspots/search",
            json={"query": "AI 营销", "accountId": "live-account", "limit": 10},
        )
        self.assertEqual(hotspots.status_code, 200, hotspots.text)
        self.assertEqual(hotspots.json()["data"][0]["sourceUrl"], "https://www.threads.com/@live_user/post/live-one")
        self.assertTrue(live_requests[0]["liveOnly"])
        self.assertFalse(live_requests[0]["recordShown"])

    def test_media_upload_and_open_login_are_tenant_scoped_native_flows(self):
        notifications = []
        social_requests = []

        def social_adapter(conn, request):
            social_requests.append(request)
            return {"social_task_id": "social-open-login"}

        app = FastAPI()
        app.dependency_overrides[get_current_user] = lambda: {
            "id": self.admin_id, "is_admin": 1, "username": "crm_admin",
            "_workspace_user_id": self.user_id,
            "_workspace_username": "crm_user",
            "_workspace_admin_user_id": self.admin_id,
        }
        app.dependency_overrides[require_admin] = lambda: {"id": self.admin_id, "is_admin": 1}
        install_crm(app, social_task_adapter=social_adapter, post_commit_callback=notifications.append)
        with db_module.db() as conn:
            self._enable(conn)
            now = 1_700_000_100
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,created_at,updated_at) VALUES ('open-login-account',?,'persona','threads','login_handle','profiles/login',?,?)",
                (self.user_id, now, now),
            )
        client = TestClient(app)
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        uploaded = client.post(
            "/api/crm/v1/media",
            files={"upload": ("pixel.png", png, "image/png")},
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.text)
        stored = self.root / uploaded.json()["storage_path"]
        self.assertTrue(stored.is_file())
        content = client.get(f"/api/crm/v1/media/{uploaded.json()['id']}/content")
        self.assertEqual(content.status_code, 200, content.text)
        self.assertEqual(content.content, png)
        self.assertEqual(content.headers["x-content-type-options"], "nosniff")
        deleted_media = client.delete(f"/api/crm/v1/media/{uploaded.json()['id']}")
        self.assertEqual(deleted_media.status_code, 200, deleted_media.text)
        self.assertFalse(stored.exists())
        self.assertEqual(
            client.get(f"/api/crm/v1/media/{uploaded.json()['id']}/content").status_code,
            404,
        )

        opened = client.post(
            "/api/crm/v1/accounts/open-login-account/open-login",
            json={"idempotency_key": "open-login-test"},
        )
        self.assertEqual(opened.status_code, 202, opened.text)
        self.assertEqual(social_requests[0]["action"]["action_type"], "open_login")
        self.assertEqual(social_requests[0]["action"]["account_id"], "open-login-account")
        self.assertEqual(notifications[-1]["workflow_id"], opened.json()["task_id"])

    def test_signed_tracking_redirect_is_https_and_deduplicated(self):
        app = FastAPI()
        install_crm(app)
        with db_module.db() as conn:
            destination = create_resource(
                conn, "destinations", user_id=self.user_id,
                payload={"name": "safe", "url": "https://example.test/landing", "enabled": 1},
            )
        token = sign_tracking_token({
            "user_id": self.user_id,
            "campaign_id": "campaign-1",
            "lead_id": "lead-1",
            "destination_id": destination["id"],
            "version": 1,
            "expires_at": int(__import__("time").time()) + 60,
        })
        client = TestClient(app, follow_redirects=False)
        first = client.get(f"/crm/go/{token}")
        second = client.get(f"/crm/go/{token}")
        invalid = client.get("/crm/go/not-a-valid-token")
        self.assertEqual(first.status_code, 302, first.text)
        self.assertEqual(first.headers["location"], "https://example.test/landing")
        self.assertEqual(second.status_code, 302)
        self.assertEqual(invalid.status_code, 404)
        self.assertIn("text/html", invalid.headers["content-type"])
        self.assertNotIn("crm_tracking_invalid", invalid.text)
        with db_module.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_tracking_events").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
