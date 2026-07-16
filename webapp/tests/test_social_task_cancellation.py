import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from webapp.db import init_db
import webapp.social_automation_api as social_automation_api


class SocialTaskCancellationTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self._tmpdir.name) / "app.db"
        os.environ["APP_DB_PATH"] = str(self.db_path)
        init_db()
        with social_automation_api._EPHEMERAL_TASK_SECRETS_LOCK:
            social_automation_api._EPHEMERAL_TASK_SECRETS.clear()

    def tearDown(self):
        with social_automation_api._EPHEMERAL_TASK_SECRETS_LOCK:
            social_automation_api._EPHEMERAL_TASK_SECRETS.clear()
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        self._tmpdir.cleanup()

    def _insert_task(self, task_id: str, status: str, *, task_type: str = "publish_post") -> None:
        self._insert_account()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, persona_id, account_id, platform, task_type, priority, status,
                  scheduled_at, started_at, finished_at, payload_json, result_json,
                  error, retry_count, max_retries, created_by, created_at, updated_at
                ) VALUES (?, 'persona-1', 'account-1', 'threads', ?, 50, ?, 0, 1, 0,
                          '{}', '{}', '', 0, 1, 'web', 1, 1)
                """,
                (task_id, task_type, status),
            )

    def _insert_account(self, status: str = "ready") -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO social_accounts(
                  id, persona_id, platform, username, display_name, profile_dir,
                  status, created_at, updated_at
                ) VALUES (
                  'account-1', 'persona-1', 'threads', 'tester', 'Tester',
                  'profiles/account-1', ?, 1, 1
                )
                """,
                (status,),
            )

    def _status(self, task_id: str) -> str:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = ?",
                (task_id,),
            ).fetchone()
        return str(row[0])

    def _put_secret(self, task_id: str) -> None:
        with social_automation_api._EPHEMERAL_TASK_SECRETS_LOCK:
            social_automation_api._EPHEMERAL_TASK_SECRETS[task_id] = {
                "login_password": "do-not-retain"
            }

    def _has_secret(self, task_id: str) -> bool:
        with social_automation_api._EPHEMERAL_TASK_SECRETS_LOCK:
            return task_id in social_automation_api._EPHEMERAL_TASK_SECRETS

    def test_finish_does_not_overwrite_cancelled_or_archive(self):
        self._insert_task("cancelled-task", "cancelled")

        with mock.patch.object(
            social_automation_api, "_sync_successful_task_to_persona_archive"
        ) as archive:
            social_automation_api._finish_task(
                "cancelled-task", "success", {"ok": True}, ""
            )

        self.assertEqual(self._status("cancelled-task"), "cancelled")
        archive.assert_not_called()

    def test_need_manual_after_logger_stays_open_and_updates_account(self):
        self._insert_account()
        self._insert_task("manual-task", "running", task_type="open_login")
        logger = social_automation_api._DbTaskLogger("manual-task")

        logger.log("warn", "need_manual", "verification required")
        completed = social_automation_api._finish_task(
            "manual-task",
            "need_manual",
            {},
            "verification required",
            account_status="need_verification",
        )

        with sqlite3.connect(self.db_path) as conn:
            task = conn.execute(
                "SELECT status, finished_at FROM social_automation_tasks WHERE id = ?",
                ("manual-task",),
            ).fetchone()
            account = conn.execute(
                "SELECT status FROM social_accounts WHERE id = ?", ("account-1",)
            ).fetchone()
        self.assertTrue(completed)
        self.assertEqual(task, ("need_manual", 0))
        self.assertEqual(account[0], "need_verification")

    def test_need_manual_finish_cannot_revive_cancelled_or_update_account(self):
        self._insert_account()
        self._insert_task("cancelled-manual", "cancelled", task_type="open_login")

        completed = social_automation_api._finish_task(
            "cancelled-manual",
            "need_manual",
            {},
            "verification required",
            account_status="need_verification",
        )

        with sqlite3.connect(self.db_path) as conn:
            account_status = conn.execute(
                "SELECT status FROM social_accounts WHERE id = ?", ("account-1",)
            ).fetchone()[0]
        self.assertFalse(completed)
        self.assertEqual(self._status("cancelled-manual"), "cancelled")
        self.assertEqual(account_status, "ready")

    def test_running_login_detection_updates_account_immediately(self):
        self._insert_account(status="cookie_expired")
        self._insert_task("publish-running", "running")

        updated = social_automation_api._persist_running_account_login_status(
            "publish-running",
            "account-1",
            "ready",
        )

        with sqlite3.connect(self.db_path) as conn:
            account = conn.execute(
                "SELECT status, last_login_check_at FROM social_accounts WHERE id = ?",
                ("account-1",),
            ).fetchone()
        self.assertTrue(updated)
        self.assertEqual(account[0], "ready")
        self.assertGreater(account[1], 0)

    def test_publish_confirmation_timeout_finishes_failed_without_manual_state(self):
        self._insert_account(status="cookie_expired")
        self._insert_task("publish-review", "running")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'held-confirmation' WHERE id = 'publish-review'"
            )
        task = {
            "id": "publish-review",
            "account_id": "account-1",
            "platform": "threads",
            "task_type": "publish_post",
            "payload": {},
        }
        control = {
            "cancel_event": threading.Event(),
            "task": dict(task),
            "live_browser_session_id": "",
        }

        from social_automation.runner import PublishConfirmationFailedError

        with (
            mock.patch.object(
                social_automation_api,
                "_run_social_task_in_clean_thread",
                side_effect=PublishConfirmationFailedError("publish confirmation timed out", "confirmation.png"),
            ),
            mock.patch.object(social_automation_api, "_release_task_billing_reservation") as release,
        ):
            social_automation_api._execute_claimed_task_with_control(task, control)

        with sqlite3.connect(self.db_path) as conn:
            account_status = conn.execute(
                "SELECT status FROM social_accounts WHERE id = ?",
                ("account-1",),
            ).fetchone()[0]
            task_status = conn.execute(
                "SELECT status, result_json FROM social_automation_tasks WHERE id = ?",
                ("publish-review",),
            ).fetchone()
        self.assertEqual(account_status, "ready")
        self.assertEqual(task_status[0], "failed")
        result = json.loads(task_status[1])
        self.assertTrue(result["confirmation_failed"])
        self.assertFalse(result["retryable"])
        release.assert_not_called()
        self.assertEqual(social_automation_api.get_social_task("publish-review")["billing"]["status"], "held")
        with self.assertRaises(social_automation_api.HTTPException) as raised:
            social_automation_api.retry_social_task("publish-review")
        self.assertEqual(raised.exception.status_code, 409)

    def test_cleanup_preserves_held_charge_for_unconfirmed_publish(self):
        self._insert_task("publish-held", "failed")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'reservation-held', result_json = ? WHERE id = 'publish-held'",
                (json.dumps({"confirmation_failed": True, "retryable": False}),),
            )
            conn.execute(
                """
                INSERT INTO billing_reservations(
                  id, user_id, ref_type, ref_id, sku, status, idempotency_key, created_at, updated_at
                ) VALUES ('reservation-held', 0, 'social_task', 'publish-held', 'threads_text_publish', 'held', 'held-test', 1, 1)
                """
            )

        with social_automation_api.db() as conn:
            social_automation_api._release_terminal_task_billing_reservations(conn, 100)

        with sqlite3.connect(self.db_path) as conn:
            status = conn.execute(
                "SELECT status FROM billing_reservations WHERE id = 'reservation-held'"
            ).fetchone()[0]
        self.assertEqual(status, "held")

    def test_unconfirmed_publish_cannot_be_deleted_or_refunded_through_generic_paths(self):
        self._insert_task("publish-protected", "failed")
        with social_automation_api.db() as conn:
            stale_task = conn.execute(
                "SELECT * FROM social_automation_tasks WHERE id = 'publish-protected'"
            ).fetchone()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'protected-hold', result_json = ? WHERE id = 'publish-protected'",
                (json.dumps({"confirmation_failed": True, "retryable": False}),),
            )

        with self.assertRaises(social_automation_api.HTTPException) as clear_error:
            social_automation_api.clear_social_task("publish-protected")
        self.assertEqual(clear_error.exception.status_code, 409)
        self.assertEqual(social_automation_api.clear_social_tasks(account_id="account-1"), 0)
        with self.assertRaises(social_automation_api.HTTPException) as delete_error:
            social_automation_api.delete_social_account("account-1")
        self.assertEqual(delete_error.exception.status_code, 409)

        with mock.patch.object(social_automation_api.commercial_billing, "release_reservation") as release:
            with social_automation_api.db() as conn:
                self.assertFalse(social_automation_api._release_task_billing_reservation(conn, stale_task))
            social_automation_api.cancel_social_task("publish-protected")
        release.assert_not_called()
        self.assertEqual(self._status("publish-protected"), "failed")

    def test_manual_takeover_ack_marks_open_login_task_need_manual(self):
        self._insert_account(status="cookie_expired")
        self._insert_task("login-risk-challenge", "running", task_type="open_login")

        social_automation_api._persist_manual_takeover_ack(
            "login-risk-challenge",
            "live-login-risk-challenge",
        )

        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT status, payload_json FROM social_automation_tasks WHERE id = ?",
                ("login-risk-challenge",),
            ).fetchone()
        payload = json.loads(row[1])
        self.assertEqual(row[0], "need_manual")
        self.assertFalse(payload["auto_submit"])
        self.assertTrue(payload["manual_takeover"])

    def test_publish_takeover_ack_enters_manual_and_can_resume_running(self):
        self._insert_account(status="ready")
        self._insert_task("publish-risk-challenge", "running", task_type="publish_post")

        social_automation_api._persist_manual_takeover_ack(
            "publish-risk-challenge",
            "live-publish-risk-challenge",
        )
        self.assertEqual(self._status("publish-risk-challenge"), "need_manual")

        social_automation_api._persist_manual_takeover_resolved(
            "publish-risk-challenge",
            "live-publish-risk-challenge",
        )
        self.assertEqual(self._status("publish-risk-challenge"), "running")

    def test_orphaned_manual_publish_fails_and_releases_billing_reservation(self):
        self._insert_account(status="need_verification")
        self._insert_task("orphaned-publish", "need_manual", task_type="publish_post")

        with (
            mock.patch.dict(social_automation_api._RUNNING_TASK_CONTROLS, {}, clear=True),
            mock.patch.object(social_automation_api, "_release_task_billing_reservation") as release,
        ):
            social_automation_api._recover_orphaned_manual_task(10_000)

        self.assertEqual(self._status("orphaned-publish"), "failed")
        release.assert_called_once()
        self.assertEqual(str(release.call_args.args[1]["id"]), "orphaned-publish")

    def test_already_manual_open_login_still_transitions_out_of_running(self):
        self._insert_account(status="cookie_expired")
        self._insert_task("login-already-manual", "running", task_type="open_login")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET payload_json = ? WHERE id = ?",
                (json.dumps({"auto_submit": False, "manual_takeover": True}), "login-already-manual"),
            )

        social_automation_api._persist_manual_takeover_ack(
            "login-already-manual",
            "live-login-already-manual",
        )

        self.assertEqual(self._status("login-already-manual"), "need_manual")

    def test_retry_path_cannot_requeue_after_cancellation_wins(self):
        self._insert_task("cancelled-retry", "cancelled")

        with (
            mock.patch.object(social_automation_api, "_is_task_cancelled", return_value=False),
            mock.patch.object(
                social_automation_api,
                "get_social_task",
                return_value={"retry_count": 0, "max_retries": 1},
            ),
        ):
            social_automation_api._fail_task_safely(
                "cancelled-retry", RuntimeError("runner failed")
            )

        self.assertEqual(self._status("cancelled-retry"), "cancelled")

    def test_cancel_does_not_overwrite_terminal_and_scrubs_secret(self):
        for status in ("success", "failed", "cancelled"):
            task_id = f"terminal-{status}"
            self._insert_task(task_id, status)
            self._put_secret(task_id)

            with mock.patch.object(social_automation_api, "_force_stop_running_task") as stop:
                task = social_automation_api.cancel_social_task(task_id, "stop")

            self.assertEqual(task["status"], status)
            self.assertEqual(self._status(task_id), status)
            self.assertFalse(self._has_secret(task_id))
            stop.assert_not_called()

    def test_cancel_all_only_changes_active_states_and_scrubs_their_secrets(self):
        active_ids = []
        terminal_ids = []
        for status in ("queued", "running", "need_manual"):
            task_id = f"active-{status}"
            active_ids.append(task_id)
            self._insert_task(task_id, status)
            self._put_secret(task_id)
        for status in ("success", "failed", "cancelled"):
            task_id = f"terminal-{status}"
            terminal_ids.append(task_id)
            self._insert_task(task_id, status)

        with (
            mock.patch.object(social_automation_api, "_force_stop_running_task") as stop,
            mock.patch.object(social_automation_api, "wake_social_automation_worker"),
        ):
            result = social_automation_api.cancel_all_social_tasks("stop all")

        self.assertEqual(result["cancelled_count"], len(active_ids))
        self.assertEqual(set(result["task_ids"]), set(active_ids))
        self.assertEqual({call.args[0] for call in stop.call_args_list}, set(active_ids))
        for task_id in active_ids:
            self.assertEqual(self._status(task_id), "cancelled")
            self.assertFalse(self._has_secret(task_id))
        for task_id, status in zip(terminal_ids, ("success", "failed", "cancelled")):
            self.assertEqual(self._status(task_id), status)

    def test_claimed_task_cancelled_before_execution_scrubs_secret(self):
        self._insert_task("claimed-cancelled", "cancelled")
        self._put_secret("claimed-cancelled")

        social_automation_api._execute_claimed_task(
            {"id": "claimed-cancelled", "account_id": "account-1"}
        )

        self.assertFalse(self._has_secret("claimed-cancelled"))

    def test_concurrent_cancel_and_finish_have_one_consistent_winner(self):
        archived = set()
        archived_lock = threading.Lock()

        def record_archive(task_id, _result):
            with archived_lock:
                archived.add(task_id)

        for index in range(12):
            task_id = f"race-{index}"
            self._insert_task(task_id, "running")
            self._put_secret(task_id)
            barrier = threading.Barrier(3)
            cancel_result = {}
            errors = []

            def cancel():
                try:
                    barrier.wait()
                    cancel_result.update(
                        social_automation_api.cancel_social_task(task_id, "race cancel")
                    )
                except BaseException as exc:
                    errors.append(exc)

            def finish():
                try:
                    barrier.wait()
                    social_automation_api._finish_task(
                        task_id, "success", {"ok": True}, ""
                    )
                except BaseException as exc:
                    errors.append(exc)

            with (
                mock.patch.object(
                    social_automation_api,
                    "_sync_successful_task_to_persona_archive",
                    side_effect=record_archive,
                ),
                mock.patch.object(social_automation_api, "_force_stop_running_task"),
                mock.patch.object(social_automation_api, "wake_social_automation_worker"),
            ):
                cancel_thread = threading.Thread(target=cancel)
                finish_thread = threading.Thread(target=finish)
                cancel_thread.start()
                finish_thread.start()
                barrier.wait()
                cancel_thread.join(timeout=5)
                finish_thread.join(timeout=5)

            self.assertFalse(cancel_thread.is_alive())
            self.assertFalse(finish_thread.is_alive())
            self.assertEqual(errors, [])
            final_status = self._status(task_id)
            self.assertIn(final_status, {"success", "cancelled"})
            self.assertEqual(cancel_result["status"], final_status)
            self.assertEqual(task_id in archived, final_status == "success")
            self.assertFalse(self._has_secret(task_id))


if __name__ == "__main__":
    unittest.main()
