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
