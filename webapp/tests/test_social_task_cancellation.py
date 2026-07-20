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
        with sqlite3.connect(self.db_path) as conn:
            created = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES ('task-cancel-customer', 'hash', 0, 0, 0, 1, 1)"
            )
            self.user_id = int(created.lastrowid)
            conn.execute(
                "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, 0, 'enforced', 0, 1, 1)",
                (self.user_id,),
            )
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
                  id, user_id, persona_id, account_id, platform, task_type, priority, status,
                  scheduled_at, started_at, finished_at, payload_json, result_json,
                  error, retry_count, max_retries, created_by, created_at, updated_at
                ) VALUES (?, ?, 'persona-1', 'account-1', 'threads', ?, 50, ?, 0, 1, 0,
                          '{}', '{}', '', 0, 1, 'web', 1, 1)
                """,
                (task_id, self.user_id, task_type, status),
            )

    def _insert_account(self, status: str = "ready") -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO social_accounts(
                  id, user_id, persona_id, platform, username, display_name, profile_dir,
                  status, created_at, updated_at
                ) VALUES (
                  'account-1', ?, 'persona-1', 'threads', 'tester', 'Tester',
                  'profiles/account-1', ?, 1, 1
                )
                """,
                (self.user_id, status),
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

    def test_check_login_finish_persists_independent_account_health(self):
        self._insert_account(status="cookie_expired")
        self._insert_task("health-check", "running", task_type="check_login")

        completed = social_automation_api._finish_task(
            "health-check",
            "success",
            {
                "ok": True,
                "status": "ready",
                "health_status": "alive",
                "health_reason": "account is available",
            },
            "",
            account_status="ready",
        )

        with sqlite3.connect(self.db_path) as conn:
            account = conn.execute(
                """
                SELECT status, health_status, health_checked_at, health_detail
                FROM social_accounts
                WHERE id = ?
                """,
                ("account-1",),
            ).fetchone()
        self.assertTrue(completed)
        self.assertEqual(account[0], "ready")
        self.assertEqual(account[1], "alive")
        self.assertGreater(account[2], 0)
        self.assertEqual(account[3], "account is available")

    def test_failed_check_login_does_not_replace_last_confirmed_health(self):
        self._insert_account(status="ready")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                UPDATE social_accounts
                SET health_status = 'alive', health_checked_at = 10, health_detail = 'confirmed'
                WHERE id = 'account-1'
                """
            )
        self._insert_task("health-check-failed", "running", task_type="check_login")

        completed = social_automation_api._finish_task(
            "health-check-failed",
            "failed",
            {"ok": False, "error": "browser launch failed"},
            "browser launch failed",
        )

        with sqlite3.connect(self.db_path) as conn:
            account = conn.execute(
                """
                SELECT health_status, health_checked_at, health_detail
                FROM social_accounts
                WHERE id = ?
                """,
                ("account-1",),
            ).fetchone()
        self.assertTrue(completed)
        self.assertEqual(account, ("alive", 10, "confirmed"))

    def test_effective_account_status_combines_login_and_platform_health(self):
        effective = social_automation_api._account_effective_status

        self.assertEqual(effective({"status": "ready", "health_status": "alive"}), "ready")
        self.assertEqual(effective({"status": "ready", "health_status": "unknown"}), "ready_unverified")
        self.assertEqual(effective({"status": "ready", "health_status": "abnormal"}), "abnormal")
        self.assertEqual(effective({"status": "ready", "health_status": "banned"}), "banned")
        self.assertEqual(effective({"status": "cookie_expired", "health_status": "alive"}), "cookie_expired")
        self.assertEqual(effective({"status": "disabled", "health_status": "banned"}), "disabled")
        self.assertEqual(
            effective(
                {
                    "status": "ready",
                    "health_status": "alive",
                    "last_login_check_at": 10,
                    "health_checked_at": 10,
                    "status_attempted_at": 20,
                    "status_attempt_error": "browser launch failed",
                }
            ),
            "check_failed",
        )

    def test_failed_check_exposes_latest_attempt_without_erasing_confirmed_health(self):
        self._insert_account(status="ready")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                UPDATE social_accounts
                SET health_status = 'alive', health_checked_at = 10, health_detail = 'confirmed'
                WHERE id = 'account-1'
                """
            )
        self._insert_task("health-check-launch-failed", "running", task_type="check_login")

        social_automation_api._finish_task(
            "health-check-launch-failed",
            "failed",
            {"ok": False},
            "browser launch failed",
        )

        with social_automation_api.db() as conn:
            account = conn.execute("SELECT * FROM social_accounts WHERE id = 'account-1'").fetchone()
        public = social_automation_api._account_public(account)
        self.assertEqual(public["health_status"], "alive")
        self.assertEqual(public["effective_status"], "check_failed")
        self.assertEqual(public["status_detail"], "browser launch failed")
        self.assertEqual(public["status_source_task_id"], "health-check-launch-failed")

    def test_successful_login_clears_stale_banned_health(self):
        self._insert_account(status="cookie_expired")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                UPDATE social_accounts
                SET health_status = 'banned', health_checked_at = 10, health_detail = 'stale ban'
                WHERE id = 'account-1'
                """
            )
        self._insert_task("open-login-success", "running", task_type="open_login")

        social_automation_api._finish_task(
            "open-login-success",
            "success",
            {"ok": True, "status": "ready"},
            "",
            account_status="ready",
        )

        with social_automation_api.db() as conn:
            account = conn.execute("SELECT * FROM social_accounts WHERE id = 'account-1'").fetchone()
        public = social_automation_api._account_public(account)
        self.assertEqual(public["health_status"], "alive")
        self.assertEqual(public["effective_status"], "ready")

    def test_failed_login_preserves_account_error(self):
        self._insert_account(status="ready")
        self._insert_task("open-login-failed", "running", task_type="open_login")

        social_automation_api._finish_task(
            "open-login-failed",
            "failed",
            {"ok": False},
            "automatic login timed out",
            account_status="cookie_expired",
        )

        with sqlite3.connect(self.db_path) as conn:
            account = conn.execute(
                "SELECT status, last_error, status_attempt_error, status_source_task_id FROM social_accounts WHERE id = 'account-1'"
            ).fetchone()
        self.assertEqual(
            account,
            ("cookie_expired", "automatic login timed out", "automatic login timed out", "open-login-failed"),
        )

    def test_publish_dependency_rejects_successful_but_not_ready_login_diagnostic(self):
        self._insert_task("login-diagnostic", "success", task_type="check_login")
        self._insert_task("publish-after-login", "queued", task_type="publish_post")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET result_json = ? WHERE id = 'login-diagnostic'",
                (json.dumps({"status": "cookie_expired", "diagnostic_outcome": "not_ready"}),),
            )
            conn.execute(
                "UPDATE social_automation_tasks SET payload_json = ? WHERE id = 'publish-after-login'",
                (json.dumps({"auto_login_before_publish": True, "login_task_id": "login-diagnostic"}),),
            )

        with social_automation_api.db() as conn:
            row = conn.execute(
                "SELECT * FROM social_automation_tasks WHERE id = 'publish-after-login'"
            ).fetchone()
            blocked = social_automation_api._publish_login_dependency_blocks_claim(conn, row, 100)

        self.assertTrue(blocked)
        self.assertEqual(self._status("publish-after-login"), "failed")

    def test_banned_account_rejects_non_diagnostic_tasks(self):
        self._insert_account(status="cookie_expired")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_accounts SET health_status = 'banned' WHERE id = 'account-1'"
            )

        with self.assertRaises(social_automation_api.HTTPException) as raised:
            social_automation_api.create_social_task(
                social_automation_api.SocialTaskPayload(
                    persona_id="persona-1",
                    account_id="account-1",
                    platform="threads",
                    task_type="browse_feed",
                    payload={},
                )
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("已被封禁", str(raised.exception.detail))

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

    def test_check_login_completes_without_blocking_account_when_session_is_expired(self):
        self._insert_account(status="ready")
        self._insert_task("check-expired", "running", task_type="check_login")
        task = {
            "id": "check-expired",
            "account_id": "account-1",
            "platform": "threads",
            "task_type": "check_login",
            "payload": {},
        }
        control = {
            "cancel_event": threading.Event(),
            "task": dict(task),
            "live_browser_session_id": "",
        }

        with mock.patch.object(
            social_automation_api,
            "_run_social_task_in_clean_thread",
            return_value={"ok": True, "status": "cookie_expired", "details": {}},
        ):
            social_automation_api._execute_claimed_task_with_control(task, control)

        with sqlite3.connect(self.db_path) as conn:
            task_status = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = ?",
                ("check-expired",),
            ).fetchone()[0]
            account_status = conn.execute(
                "SELECT status FROM social_accounts WHERE id = ?",
                ("account-1",),
            ).fetchone()[0]
        self.assertEqual(task_status, "success")
        self.assertEqual(account_status, "cookie_expired")

    def test_publish_confirmation_timeout_requeues_confirmation_without_manual_state(self):
        self._insert_account(status="cookie_expired")
        self._insert_task("publish-review", "running")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'held-confirmation' WHERE id = 'publish-review'"
            )
            conn.execute(
                "INSERT INTO billing_reservations(id, user_id, ref_type, ref_id, sku, status, idempotency_key, created_at, updated_at) VALUES ('held-confirmation', ?, 'social_task', 'publish-review', 'threads_text_publish', 'held', 'confirm-test', 1, 1)",
                (self.user_id,),
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

        from social_automation.runner import PublishConfirmationPendingError

        with (
            mock.patch.object(
                social_automation_api,
                "_run_social_task_in_clean_thread",
                side_effect=PublishConfirmationPendingError(
                    "publish confirmation timed out",
                    "confirmation.png",
                    {
                        "phase": "confirm_only",
                        "profile_url": "https://www.threads.net/@tester",
                        "baseline_permalinks": [],
                        "caption": "hello",
                    },
                ),
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
                "SELECT status, result_json, payload_json, scheduled_at FROM social_automation_tasks WHERE id = ?",
                ("publish-review",),
            ).fetchone()
        self.assertEqual(account_status, "ready")
        self.assertEqual(task_status[0], "queued")
        result = json.loads(task_status[1])
        payload = json.loads(task_status[2])
        self.assertTrue(result["confirmation_pending"])
        self.assertFalse(result["retryable"])
        self.assertEqual(payload["_publish_confirmation"]["attempt"], 1)
        self.assertGreater(task_status[3], 1)
        release.assert_not_called()
        self.assertEqual(social_automation_api.get_social_task("publish-review")["billing"]["status"], "held")
        with self.assertRaises(social_automation_api.HTTPException) as raised:
            social_automation_api.retry_social_task("publish-review")
        self.assertEqual(raised.exception.status_code, 409)

    def test_cleanup_releases_held_charge_for_terminal_unconfirmed_publish(self):
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
                ) VALUES ('reservation-held', ?, 'social_task', 'publish-held', 'threads_text_publish', 'held', 'held-test', 1, 1)
                """
                ,
                (self.user_id,),
            )

        with social_automation_api.db() as conn:
            social_automation_api._release_terminal_task_billing_reservations(conn, 100)

        with sqlite3.connect(self.db_path) as conn:
            status = conn.execute(
                "SELECT status FROM billing_reservations WHERE id = 'reservation-held'"
            ).fetchone()[0]
        self.assertEqual(status, "released")

    def test_publish_confirmation_exhaustion_fails_and_releases_reservation(self):
        self._insert_account(status="ready")
        self._insert_task("publish-exhausted", "running")
        confirmation = {
            "phase": "confirm_only",
            "attempt": 2,
            "max_attempts": 3,
            "profile_url": "https://www.threads.net/@tester",
            "baseline_permalinks": [],
            "caption": "hello",
        }
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'exhausted-hold', payload_json = ? WHERE id = 'publish-exhausted'",
                (json.dumps({"_publish_confirmation": confirmation}),),
            )
            conn.execute(
                "INSERT INTO billing_reservations(id, user_id, ref_type, ref_id, sku, status, idempotency_key, created_at, updated_at) VALUES ('exhausted-hold', ?, 'social_task', 'publish-exhausted', 'threads_text_publish', 'held', 'exhausted-test', 1, 1)",
                (self.user_id,),
            )
        task = {
            "id": "publish-exhausted",
            "account_id": "account-1",
            "platform": "threads",
            "task_type": "publish_post",
            "payload": {"_publish_confirmation": confirmation},
        }
        control = {"cancel_event": threading.Event(), "task": dict(task), "live_browser_session_id": ""}
        from social_automation.runner import PublishConfirmationPendingError

        with mock.patch.object(
            social_automation_api,
            "_run_social_task_in_clean_thread",
            side_effect=PublishConfirmationPendingError("still unconfirmed", "last.png", confirmation),
        ):
            social_automation_api._execute_claimed_task_with_control(task, control)

        with sqlite3.connect(self.db_path) as conn:
            task_row = conn.execute(
                "SELECT status, result_json, payload_json FROM social_automation_tasks WHERE id = 'publish-exhausted'"
            ).fetchone()
            reservation_status = conn.execute(
                "SELECT status FROM billing_reservations WHERE id = 'exhausted-hold'"
            ).fetchone()[0]
        result = json.loads(task_row[1])
        self.assertEqual(task_row[0], "failed")
        self.assertTrue(result["confirmation_exhausted"])
        self.assertTrue(result["publish_outcome_unknown"])
        self.assertEqual(result["confirmation_attempt"], 3)
        self.assertFalse(result["retryable"])
        self.assertEqual(json.loads(task_row[2])["_publish_confirmation"]["attempt"], 3)
        self.assertEqual(reservation_status, "released")
        self.assertEqual(social_automation_api.get_social_task("publish-exhausted")["billing"]["status"], "released")

    def test_task_public_uses_actual_waived_reservation_status(self):
        self._insert_task("publish-waived", "queued")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'waived-reservation' WHERE id = 'publish-waived'"
            )
            conn.execute(
                "INSERT INTO billing_reservations(id, user_id, ref_type, ref_id, sku, status, idempotency_key, created_at, updated_at) VALUES ('waived-reservation', ?, 'social_task', 'publish-waived', 'threads_text_publish', 'waived', 'waived-test', 1, 1)",
                (self.user_id,),
            )

        self.assertEqual(social_automation_api.get_social_task("publish-waived")["billing"]["status"], "waived")
        listed = social_automation_api.list_social_tasks(account_id="account-1")
        self.assertEqual(next(item for item in listed if item["id"] == "publish-waived")["billing"]["status"], "waived")

    def test_successful_confirmation_removes_internal_confirmation_context(self):
        self._insert_task("publish-confirmed", "running")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET payload_json = ? WHERE id = 'publish-confirmed'",
                (json.dumps({"caption": "hello", "_publish_confirmation": {"phase": "confirm_only", "attempt": 1}}),),
            )

        self.assertTrue(social_automation_api._finish_task("publish-confirmed", "success", {"ok": True}, ""))
        with sqlite3.connect(self.db_path) as conn:
            payload = json.loads(conn.execute("SELECT payload_json FROM social_automation_tasks WHERE id = 'publish-confirmed'").fetchone()[0])
        self.assertNotIn("_publish_confirmation", payload)

    def test_orphaned_confirmation_only_task_is_requeued_after_worker_restart(self):
        self._insert_task("publish-orphan", "running")
        confirmation = {
            "phase": "confirm_only",
            "attempt": 1,
            "profile_url": "https://www.threads.net/@tester",
            "baseline_permalinks": [],
        }
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET payload_json = ?, updated_at = 1 WHERE id = 'publish-orphan'",
                (json.dumps({"_publish_confirmation": confirmation}),),
            )

        social_automation_api._recover_orphaned_publish_confirmation_tasks(1000)

        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT status, scheduled_at, started_at FROM social_automation_tasks WHERE id = 'publish-orphan'"
            ).fetchone()
        self.assertEqual(row, ("queued", 1000, 0))

    def test_generic_failure_after_submit_requeues_confirmation_only_payload(self):
        self._insert_task("publish-after-click-error", "running")
        confirmation = {
            "phase": "confirm_only",
            "profile_url": "https://www.threads.net/@tester",
            "baseline_permalinks": [],
            "caption": "hello",
        }
        self.assertTrue(
            social_automation_api._persist_publish_confirmation_context(
                "publish-after-click-error",
                confirmation,
            )
        )
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_automation_tasks SET max_retries = 0 WHERE id = 'publish-after-click-error'")

        social_automation_api._fail_task_safely(
            "publish-after-click-error",
            RuntimeError("browser exited after submit"),
        )

        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT status, payload_json, retry_count FROM social_automation_tasks WHERE id = 'publish-after-click-error'"
            ).fetchone()
        self.assertEqual(row[0], "queued")
        self.assertEqual(json.loads(row[1])["_publish_confirmation"]["phase"], "confirm_only")
        self.assertEqual(row[2], 0)

    def test_terminal_unconfirmed_publish_can_be_cleared_and_refunded(self):
        self._insert_task("publish-protected", "failed")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET billing_reservation_id = 'protected-hold', result_json = ? WHERE id = 'publish-protected'",
                (json.dumps({"confirmation_failed": True, "retryable": False}),),
            )
            conn.execute(
                "INSERT INTO billing_reservations(id, user_id, ref_type, ref_id, sku, status, idempotency_key, created_at, updated_at) VALUES ('protected-hold', ?, 'social_task', 'publish-protected', 'threads_text_publish', 'held', 'protected-test', 1, 1)",
                (self.user_id,),
            )

        self.assertEqual(social_automation_api.clear_social_task("publish-protected"), 1)
        with sqlite3.connect(self.db_path) as conn:
            task = conn.execute("SELECT 1 FROM social_automation_tasks WHERE id = 'publish-protected'").fetchone()
            reservation_status = conn.execute("SELECT status FROM billing_reservations WHERE id = 'protected-hold'").fetchone()[0]
        self.assertIsNone(task)
        self.assertEqual(reservation_status, "released")

    def test_account_is_disabled_before_running_tasks_are_stopped_for_deletion(self):
        self._insert_task("delete-running", "running")
        observed_statuses = []

        def observe_disabled(_task_id):
            with sqlite3.connect(self.db_path) as conn:
                observed_statuses.append(conn.execute("SELECT status FROM social_accounts WHERE id = 'account-1'").fetchone()[0])

        with mock.patch.object(social_automation_api, "_force_stop_running_task", side_effect=observe_disabled):
            self.assertEqual(social_automation_api.delete_social_account("account-1"), 1)

        self.assertEqual(observed_statuses, ["disabled"])

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

    def test_force_stop_during_shutdown_persists_cancelled_status(self):
        self._insert_task("shutdown-running", "running")
        control = {
            "cancel_event": threading.Event(),
            "context": None,
            "live_browser_session_id": "",
        }
        with (
            mock.patch.object(
                social_automation_api,
                "_RUNNING_TASK_CONTROLS",
                {"shutdown-running": control},
            ),
            mock.patch(
                "social_automation.live_browser.stop_live_browser_sessions_for_task"
            ),
        ):
            stopped = social_automation_api._force_stop_running_task(
                "shutdown-running",
                reason="service shutdown",
                mark_cancelled=True,
            )

        self.assertTrue(stopped)
        self.assertTrue(control["cancel_event"].is_set())
        self.assertEqual(self._status("shutdown-running"), "cancelled")

    def test_shutdown_cancellation_does_not_refund_terminal_task(self):
        self._insert_task("shutdown-finished", "success", task_type="check_login")

        with (
            mock.patch.object(
                social_automation_api,
                "_release_task_billing_reservation",
            ) as release_billing,
            mock.patch.object(
                social_automation_api,
                "_release_daily_publish_slot",
            ) as release_publish_slot,
        ):
            cancelled = social_automation_api._persist_shutdown_task_cancellation(
                "shutdown-finished",
                reason="service shutdown",
            )

        self.assertFalse(cancelled)
        release_billing.assert_not_called()
        release_publish_slot.assert_not_called()
        self.assertEqual(self._status("shutdown-finished"), "success")

    def test_shutdown_requeues_submitted_publish_without_refund(self):
        self._insert_task("shutdown-confirm-only", "running")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET payload_json = ? WHERE id = ?",
                (
                    json.dumps(
                        {"_publish_confirmation": {"phase": "confirm_only"}},
                        ensure_ascii=False,
                    ),
                    "shutdown-confirm-only",
                ),
            )

        with (
            mock.patch.object(
                social_automation_api,
                "_release_task_billing_reservation",
            ) as release_billing,
            mock.patch.object(
                social_automation_api,
                "_release_daily_publish_slot",
            ) as release_publish_slot,
        ):
            persisted = social_automation_api._persist_shutdown_task_cancellation(
                "shutdown-confirm-only",
                reason="service shutdown",
            )

        self.assertTrue(persisted)
        self.assertEqual(self._status("shutdown-confirm-only"), "queued")
        release_billing.assert_not_called()
        release_publish_slot.assert_not_called()

    def test_recovery_fails_orphaned_running_task(self):
        self._insert_task("orphaned-running", "running", task_type="check_login")

        social_automation_api._recover_orphaned_running_tasks(100)

        self.assertEqual(self._status("orphaned-running"), "failed")

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
