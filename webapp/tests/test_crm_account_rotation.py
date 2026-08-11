import json
import os
import tempfile
import unittest
from pathlib import Path

from webapp import db as db_module
from webapp import social_automation_api as social_api
from webapp.crm.account_rotation import (
    classify_sender_message_failure,
    evaluate_sender_rotation_sequence,
    get_sender_rotation_status,
    require_sender_rotation_unlocked,
    reset_sender_rotation_status,
    update_sender_rotation_status,
)
from webapp.crm.errors import CRMError


QUALIFIED_FAILURE = {
    "sent": False,
    "status": "composer_unavailable",
    "warning": "The verified conversation did not expose a usable message composer.",
    "logged_in_username": "sender",
    "inspected_url": "https://www.threads.net/messages/123",
}


class CRMAccountRotationTests(unittest.TestCase):
    def setUp(self):
        self.previous_db = os.environ.get("APP_DB_PATH")
        self.previous_data = os.environ.get("WEBAPP_DATA_DIR")
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            self.user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('rotation_owner','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            self.other_user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('rotation_other','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            for account_id, owner_id, username in (
                ("rotation-account", self.user_id, "sender"),
                ("rotation-other", self.other_user_id, "other_sender"),
            ):
                conn.execute(
                    "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                    "VALUES (?,?,?,'threads',?,?,'ready','alive',?,?)",
                    (
                        account_id,
                        owner_id,
                        f"persona-{account_id}",
                        username,
                        f"profiles/{account_id}",
                        now,
                        now,
                    ),
                )

    def tearDown(self):
        if self.previous_db is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.previous_db
        if self.previous_data is None:
            os.environ.pop("WEBAPP_DATA_DIR", None)
        else:
            os.environ["WEBAPP_DATA_DIR"] = self.previous_data
        self.tmp.cleanup()

    def _record(self, conn, **overrides):
        values = dict(QUALIFIED_FAILURE)
        values.update(overrides)
        return update_sender_rotation_status(
            conn,
            user_id=self.user_id,
            account_id="rotation-account",
            sent=bool(values.get("sent")),
            warning=str(values.get("warning") or ""),
            status=str(values.get("status") or ""),
            recipient="lead",
            logged_in_username=str(values.get("logged_in_username") or ""),
            inspected_url=str(values.get("inspected_url") or ""),
        )

    def _insert_running_task(self, conn, task_id: str):
        conn.execute(
            "INSERT INTO social_automation_tasks("
            "id,user_id,persona_id,account_id,platform,task_type,status,started_at,payload_json,max_retries,created_at,updated_at"
            ") VALUES (?,?,?,'rotation-account','threads','direct_message','running',?,?,0,?,?)",
            (
                task_id,
                self.user_id,
                "persona-rotation-account",
                1_700_000_000,
                json.dumps({"recipient_username": "lead"}),
                1_700_000_000,
                1_700_000_000,
            ),
        )

    def test_only_verified_threads_composer_failure_qualifies(self):
        qualified = classify_sender_message_failure(
            platform="threads",
            warning=QUALIFIED_FAILURE["warning"],
            status="composer_unavailable",
            expected_username="sender",
            logged_in_username="@Sender",
            inspected_url="https://www.threads.net/messages/123",
        )
        self.assertTrue(qualified["counts_toward_rotation"])
        for override in (
            {"logged_in_username": "different"},
            {"inspected_url": "https://www.threads.net/@lead"},
            {"platform": "instagram"},
            {"status": "needs_login", "warning": "login required"},
            {"warning": "The recipient cannot message this account."},
            {"warning": "Network timeout; try again."},
        ):
            values = {
                "platform": "threads",
                "warning": QUALIFIED_FAILURE["warning"],
                "status": "composer_unavailable",
                "expected_username": "sender",
                "logged_in_username": "sender",
                "inspected_url": QUALIFIED_FAILURE["inspected_url"],
            }
            values.update(override)
            self.assertFalse(classify_sender_message_failure(**values)["counts_toward_rotation"])

    def test_evaluator_requires_three_consecutive_qualified_failures(self):
        result = evaluate_sender_rotation_sequence(
            [dict(QUALIFIED_FAILURE), dict(QUALIFIED_FAILURE), dict(QUALIFIED_FAILURE)],
            platform="threads",
            expected_username="sender",
        )
        self.assertTrue(result["rotation_required"])
        self.assertEqual(result["consecutive_composer_failures"], 3)

        interrupted = evaluate_sender_rotation_sequence(
            [
                dict(QUALIFIED_FAILURE),
                {**QUALIFIED_FAILURE, "warning": "Network timeout; try again."},
                dict(QUALIFIED_FAILURE),
                dict(QUALIFIED_FAILURE),
            ],
            platform="threads",
            expected_username="sender",
        )
        self.assertFalse(interrupted["rotation_required"])
        self.assertEqual(interrupted["consecutive_composer_failures"], 2)

    def test_persistent_state_is_tenant_and_account_scoped(self):
        with db_module.db() as conn:
            self.assertEqual(self._record(conn)["consecutive_composer_failures"], 1)
            self.assertEqual(self._record(conn)["consecutive_composer_failures"], 2)
            locked = self._record(conn)
            other = get_sender_rotation_status(
                conn,
                user_id=self.other_user_id,
                account_id="rotation-other",
            )
        self.assertTrue(locked["locked"])
        self.assertTrue(locked["requires_follow_action"])
        self.assertEqual(other["consecutive_composer_failures"], 0)
        self.assertFalse(other["locked"])

    def test_nonqualified_failure_resets_consecutive_count(self):
        with db_module.db() as conn:
            self._record(conn)
            self._record(conn)
            reset = self._record(conn, warning="Network timeout; try again.")
        self.assertEqual(reset["consecutive_composer_failures"], 0)
        self.assertFalse(reset["locked"])
        self.assertEqual(reset["last_failure_category"], "transient_platform_error")

    def test_reset_requires_literal_confirmed_follow_action(self):
        with db_module.db() as conn:
            for _ in range(3):
                self._record(conn)
            for value in (False, "true", 1, None):
                with self.assertRaises(CRMError) as raised:
                    reset_sender_rotation_status(
                        conn,
                        user_id=self.user_id,
                        account_id="rotation-account",
                        confirmed_follow_action=value,
                    )
                self.assertEqual(raised.exception.code, "crm_rotation_follow_confirmation_required")
            reset = reset_sender_rotation_status(
                conn,
                user_id=self.user_id,
                account_id="rotation-account",
                confirmed_follow_action=True,
            )
        self.assertFalse(reset["locked"])
        self.assertEqual(reset["consecutive_composer_failures"], 0)
        self.assertGreater(reset["reset_at"], 0)

    def test_locked_account_is_rejected_before_new_direct_message(self):
        with db_module.db() as conn:
            for _ in range(3):
                self._record(conn)
            with self.assertRaises(CRMError) as raised:
                require_sender_rotation_unlocked(
                    conn,
                    user_id=self.user_id,
                    account_id="rotation-account",
                )
        self.assertEqual(raised.exception.code, "crm_sender_rotation_locked")
        self.assertTrue(raised.exception.details["locked"])

    def test_direct_message_finish_path_persists_failure_and_success_reset(self):
        failure = {
            "status": "composer_unavailable",
            "warning": QUALIFIED_FAILURE["warning"],
            "recipient_username": "lead",
            "logged_in_username": "sender",
            "inspected_url": QUALIFIED_FAILURE["inspected_url"],
        }
        for index in range(3):
            task_id = f"rotation-task-{index}"
            with db_module.db() as conn:
                self._insert_running_task(conn, task_id)
            self.assertTrue(social_api._finish_task(task_id, "failed", failure, failure["warning"]))

        with db_module.db() as conn:
            locked = get_sender_rotation_status(
                conn,
                user_id=self.user_id,
                account_id="rotation-account",
            )
            row = conn.execute(
                "SELECT result_json FROM social_automation_tasks WHERE id='rotation-task-2'"
            ).fetchone()
            self._insert_running_task(conn, "rotation-success")
        self.assertTrue(locked["locked"])
        self.assertTrue(json.loads(row["result_json"])["sender_rotation"]["locked"])
        self.assertFalse(social_api._finish_task("rotation-task-2", "failed", failure, failure["warning"]))

        self.assertTrue(
            social_api._finish_task(
                "rotation-success",
                "success",
                {
                    "verified": True,
                    "recipient_username": "lead",
                    "logged_in_username": "sender",
                    "conversation_url": QUALIFIED_FAILURE["inspected_url"],
                },
                "",
            )
        )
        with db_module.db() as conn:
            reset = get_sender_rotation_status(
                conn,
                user_id=self.user_id,
                account_id="rotation-account",
            )
            event_count = conn.execute(
                "SELECT COUNT(*) FROM crm_events WHERE user_id=? AND lead_id='rotation-account' AND event_type='sender_rotation_state'",
                (self.user_id,),
            ).fetchone()[0]
        self.assertFalse(reset["locked"])
        self.assertEqual(reset["consecutive_composer_failures"], 0)
        self.assertEqual(event_count, 4)


if __name__ == "__main__":
    unittest.main()
