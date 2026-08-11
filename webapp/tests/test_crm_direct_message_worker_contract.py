import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from webapp import db as db_module
from webapp import social_automation_api as social_api


class CRMDirectMessageWorkerContractTests(unittest.TestCase):
    def setUp(self):
        self.previous_db = os.environ.get("APP_DB_PATH")
        self.previous_data = os.environ.get("WEBAPP_DATA_DIR")
        self.previous_runtime_data_dir = social_api._DATA_DIR
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        social_api._DATA_DIR = self.root.resolve()
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            self.user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('dm_admin','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            self.other_user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('dm_other','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('dm-account',?,'persona-dm','instagram','sender','profiles/dm','ready','alive',?,?)",
                (self.user_id, now, now),
            )
            conn.execute(
                "INSERT INTO crm_workflows(id,user_id,workflow_type,status,confirmation_json,idempotency_key,created_at,updated_at) "
                "VALUES ('workflow-dm',?,'private_outreach','running',?,'workflow-dm-idem',?,?)",
                (
                    self.user_id,
                    json.dumps({"confirmed_by": self.user_id, "confirmed_at": now}),
                    now,
                    now,
                ),
            )

    def tearDown(self):
        social_api._DATA_DIR = self.previous_runtime_data_dir
        if self.previous_db is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.previous_db
        if self.previous_data is None:
            os.environ.pop("WEBAPP_DATA_DIR", None)
        else:
            os.environ["WEBAPP_DATA_DIR"] = self.previous_data
        self.tmp.cleanup()

    def _reservation(self, conn, reservation_id: str, *, user_id: int | None = None) -> None:
        owner_id = int(user_id or self.user_id)
        conn.execute(
            "INSERT INTO billing_reservations(id,user_id,ref_type,ref_id,sku,status,catalog_version_id,meta_json,idempotency_key,created_at,updated_at) "
            "VALUES (?,?,'crm_workflow','workflow-dm','crm_direct_message_batch','waived','','{}',?,1700000000,1700000000)",
            (reservation_id, owner_id, f"idem-{reservation_id}"),
        )

    def _request(self, *, reservation_id: str, payload: dict | None = None, target: str = "instagram:lead") -> dict:
        return {
            "operation": "create",
            "user_id": self.user_id,
            "workflow_id": "workflow-dm",
            "step_id": "step-dm",
            "action_id": "action-dm",
            "social_task_id": "social-dm",
            "billing_reservation_id": reservation_id,
            "idempotency_key": "dm-idem",
            "action": {
                "action_type": "direct_message",
                "account_id": "dm-account",
                "target_key": target,
                "content": "hello verified lead",
                "payload": dict(payload or {}),
            },
        }

    def test_crm_adapter_creates_private_message_child_with_no_retry(self):
        with db_module.db() as conn:
            self._reservation(conn, "bill-dm")
            created = social_api.create_crm_social_task_in_transaction(
                conn,
                self._request(reservation_id="bill-dm"),
            )
            row = conn.execute(
                "SELECT * FROM social_automation_tasks WHERE id='social-dm'"
            ).fetchone()

        self.assertEqual(created["social_task_id"], "social-dm")
        self.assertEqual(row["user_id"], self.user_id)
        self.assertEqual(row["account_id"], "dm-account")
        self.assertEqual(row["task_type"], "direct_message")
        self.assertEqual(row["max_retries"], 0)
        stored = json.loads(row["payload_json"])
        self.assertEqual(stored["recipient_username"], "lead")
        self.assertEqual(stored["message"], "hello verified lead")
        self.assertEqual(stored["_crm_action_id"], "action-dm")
        self.assertNotIn("password", stored)

    def test_private_message_child_requires_persisted_workflow_confirmation(self):
        with db_module.db() as conn:
            self._reservation(conn, "bill-unconfirmed")
            conn.execute(
                "UPDATE crm_workflows SET status='awaiting_confirmation',confirmation_json='{}' WHERE id='workflow-dm'"
            )
            with self.assertRaises(HTTPException) as raised:
                social_api.create_crm_social_task_in_transaction(
                    conn,
                    self._request(reservation_id="bill-unconfirmed"),
                )
            queued = conn.execute(
                "SELECT COUNT(*) FROM social_automation_tasks WHERE task_type='direct_message'"
            ).fetchone()[0]
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(queued, 0)

    def test_crm_media_id_is_resolved_only_inside_owner_directory(self):
        tenant_dir = self.root / "crm_media" / str(self.user_id)
        tenant_dir.mkdir(parents=True)
        media_path = tenant_dir / "card.png"
        media_path.write_bytes(b"test-image")
        with db_module.db() as conn:
            self._reservation(conn, "bill-media")
            conn.execute(
                "INSERT INTO crm_media(id,user_id,storage_path,sha256,mime_type,size_bytes,original_name,active,created_at,updated_at) "
                "VALUES ('media-owned',? ,?,'hash','image/png',10,'card.png',1,1700000000,1700000000)",
                (self.user_id, media_path.relative_to(self.root).as_posix()),
            )
            social_api.create_crm_social_task_in_transaction(
                conn,
                self._request(reservation_id="bill-media", payload={"media_id": "media-owned"}),
            )
            row = conn.execute(
                "SELECT payload_json FROM social_automation_tasks WHERE id='social-dm'"
            ).fetchone()
        stored = json.loads(row["payload_json"])
        self.assertEqual(stored["media_paths"], [str(media_path.resolve())])
        self.assertNotIn("media_id", stored)

    def test_cross_tenant_or_raw_media_path_is_rejected_before_queueing(self):
        foreign_dir = self.root / "crm_media" / str(self.other_user_id)
        foreign_dir.mkdir(parents=True)
        foreign_path = foreign_dir / "foreign.png"
        foreign_path.write_bytes(b"foreign")
        with db_module.db() as conn:
            self._reservation(conn, "bill-foreign")
            conn.execute(
                "INSERT INTO crm_media(id,user_id,storage_path,sha256,mime_type,size_bytes,original_name,active,created_at,updated_at) "
                "VALUES ('media-foreign',? ,?,'foreign-hash','image/png',7,'foreign.png',1,1700000000,1700000000)",
                (self.other_user_id, foreign_path.relative_to(self.root).as_posix()),
            )
            with self.assertRaises(HTTPException) as foreign_error:
                social_api.create_crm_social_task_in_transaction(
                    conn,
                    self._request(reservation_id="bill-foreign", payload={"media_id": "media-foreign"}),
                )
            self.assertEqual(foreign_error.exception.status_code, 404)
            with self.assertRaises(HTTPException) as path_error:
                social_api.create_crm_social_task_in_transaction(
                    conn,
                    self._request(
                        reservation_id="bill-foreign",
                        payload={"media_paths": [str(foreign_path)]},
                    ),
                )
            self.assertEqual(path_error.exception.status_code, 400)
            queued = conn.execute(
                "SELECT COUNT(*) FROM social_automation_tasks WHERE task_type='direct_message'"
            ).fetchone()[0]
        self.assertEqual(queued, 0)

    def test_later_recipient_reuses_one_approved_batch_reservation(self):
        action_payload = json.dumps(
            {
                "action_type": "direct_message",
                "account_id": "dm-account",
                "target_key": "instagram:first_lead",
                "content": "first private message",
                "write": True,
                "sku": "crm_direct_message_batch",
            }
        )
        with db_module.db() as conn:
            self._reservation(conn, "bill-batch")
            conn.execute(
                "INSERT INTO crm_workflows(id,user_id,workflow_type,status,confirmation_json,idempotency_key,created_at,updated_at) "
                "VALUES ('workflow-batch',?,'private_outreach','running',?,'batch-idem',1700000000,1700000000)",
                (self.user_id, json.dumps({"confirmed_by": self.user_id, "confirmed_at": 1_700_000_000})),
            )
            conn.execute(
                "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) "
                "VALUES ('step-first','workflow-batch',?,'direct_message',0,'success',?,1700000000,1700000000)",
                (self.user_id, action_payload),
            )
            conn.execute(
                "INSERT INTO crm_workflow_steps(id,workflow_id,user_id,step_type,sequence_no,status,payload_json,created_at,updated_at) "
                "VALUES ('step-second','workflow-batch',?,'direct_message',1,'pending',?,1700000000,1700000000)",
                (self.user_id, action_payload),
            )
            conn.execute(
                "INSERT INTO crm_action_ledger(id,workflow_id,step_id,user_id,account_id,action_type,target_key,content_hash,idempotency_key,state,billing_reservation_id,created_at,updated_at) "
                "VALUES ('action-first','workflow-batch','step-first',?,'dm-account','direct_message','instagram:first_lead','hash-first','action-first-idem','confirmed','bill-batch',1700000000,1700000000)",
                (self.user_id,),
            )
            request = self._request(
                reservation_id="",
                target="instagram:second_lead",
            )
            request.update(
                {
                    "workflow_id": "workflow-batch",
                    "step_id": "step-second",
                    "action_id": "action-second",
                    "social_task_id": "social-second",
                }
            )
            created = social_api.create_crm_social_task_in_transaction(conn, request)
            row = conn.execute(
                "SELECT task_type,billing_reservation_id FROM social_automation_tasks WHERE id='social-second'"
            ).fetchone()
        self.assertEqual(created["social_task_id"], "social-second")
        self.assertEqual(row["task_type"], "direct_message")
        self.assertEqual(row["billing_reservation_id"], "")

    def test_unknown_crm_action_retains_reservation_and_disables_retry(self):
        with db_module.db() as conn:
            self._reservation(conn, "bill-unknown")
            conn.execute(
                "INSERT INTO social_automation_tasks(id,user_id,persona_id,account_id,platform,task_type,priority,status,scheduled_at,started_at,payload_json,result_json,max_retries,billing_reservation_id,created_by,created_at,updated_at) "
                "VALUES ('social-unknown',?,'persona-dm','dm-account','instagram','direct_message',50,'running',0,1700000000,?,'{}',0,'bill-unknown','crm',1700000000,1700000000)",
                (
                    self.user_id,
                    json.dumps(
                        {
                            "_crm_action_id": "action-unknown",
                            "_billing_submission_state": "submitted",
                        }
                    ),
                ),
            )

        social_api._finish_task(
            "social-unknown",
            "failed",
            {"action_outcome_unknown": True, "retryable": False},
            "evidence not confirmed",
            account_status="ready",
        )
        with db_module.db() as conn:
            task = conn.execute(
                "SELECT status,result_json,max_retries FROM social_automation_tasks WHERE id='social-unknown'"
            ).fetchone()
            reservation = conn.execute(
                "SELECT status FROM billing_reservations WHERE id='bill-unknown'"
            ).fetchone()
        result = json.loads(task["result_json"])
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["max_retries"], 0)
        self.assertTrue(result["action_outcome_unknown"])
        self.assertEqual(result["submission_state"], "submitted")
        self.assertFalse(result["retryable"])
        self.assertEqual(reservation["status"], "waived")

    def test_running_private_message_login_takeover_allows_live_input_only_in_manual_mode(self):
        row = {
            "id": "social-dm",
            "status": "running",
            "task_type": "direct_message",
            "payload_json": "{}",
        }
        with mock.patch.object(
            social_api,
            "_running_task_login_mode",
            return_value="manual",
        ):
            self.assertTrue(social_api._live_browser_task_input_allowed(row))
        with mock.patch.object(
            social_api,
            "_running_task_login_mode",
            return_value="automation",
        ):
            self.assertFalse(social_api._live_browser_task_input_allowed(row))


if __name__ == "__main__":
    unittest.main()
