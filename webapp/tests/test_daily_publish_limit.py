import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from webapp.db import init_db
import webapp.social_automation_api as social_automation_api


class DailyPublishLimitTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_timezone = os.environ.get("WEBAPP_TIMEZONE")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self._tmpdir.name) / "app.db"
        os.environ["APP_DB_PATH"] = str(self.db_path)
        os.environ["WEBAPP_TIMEZONE"] = "Asia/Shanghai"
        init_db()
        with sqlite3.connect(self.db_path) as conn:
            customer = conn.execute(
                """
                INSERT INTO users(username, password_hash, is_admin, is_disabled, approval_status, balance_cents, created_at, updated_at)
                VALUES ('publish-limit-customer', 'hash', 0, 0, 'approved', 0, 1, 1)
                """
            )
            self.customer_id = int(customer.lastrowid)
            admin = conn.execute(
                """
                INSERT INTO users(username, password_hash, is_admin, is_disabled, approval_status, balance_cents, created_at, updated_at)
                VALUES ('publish-limit-admin', 'hash', 1, 0, 'approved', 0, 1, 1)
                """
            )
            self.admin_id = int(admin.lastrowid)
            customer_two = conn.execute(
                """
                INSERT INTO users(username, password_hash, is_admin, is_disabled, approval_status, balance_cents, created_at, updated_at)
                VALUES ('publish-limit-customer-two', 'hash', 0, 0, 'approved', 0, 1, 1)
                """
            )
            self.customer_two_id = int(customer_two.lastrowid)
            for user_id in (self.customer_id, self.customer_two_id, self.admin_id):
                conn.execute(
                    "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, 0, 'legacy', 0, 1, 1)",
                    (user_id,),
                )
            for persona_id, user_id in (
                ("persona-customer", self.customer_id),
                ("persona-customer-two", self.customer_two_id),
                ("persona-admin", self.admin_id),
            ):
                conn.execute(
                    "INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at) VALUES (?, ?, 1, 1)",
                    (persona_id, user_id),
                )
            self._insert_account(conn, "account-customer-1", self.customer_id, "persona-customer")
            self._insert_account(conn, "account-customer-2", self.customer_id, "persona-customer")
            self._insert_account(conn, "account-customer-two", self.customer_two_id, "persona-customer-two")
            self._insert_account(conn, "account-admin", self.admin_id, "persona-admin")
        self.now = 1_784_217_600  # 2026-07-17 00:00:00 +08:00

    def tearDown(self):
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        if self._old_timezone is None:
            os.environ.pop("WEBAPP_TIMEZONE", None)
        else:
            os.environ["WEBAPP_TIMEZONE"] = self._old_timezone
        self._tmpdir.cleanup()

    def _insert_account(self, conn, account_id, user_id, persona_id):
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, 'threads', ?, ?, ?, 'ready', 1, 1)
            """,
            (account_id, user_id, persona_id, account_id, account_id, f"profiles/{account_id}"),
        )

    def _payload(self, account_id="account-customer-1", persona_id="persona-customer", *, scheduled_at=0):
        return social_automation_api.SocialTaskPayload(
            persona_id=persona_id,
            account_id=account_id,
            platform="threads",
            task_type="publish_post",
            scheduled_at=scheduled_at,
            payload={"caption": "daily limit test"},
            max_retries=0,
        )

    def _create(self, *args, **kwargs):
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            return social_automation_api.create_social_task(*args, **kwargs)

    def test_customer_is_blocked_after_fifteen_across_social_accounts(self):
        for _ in range(15):
            self._create(self._payload())

        with self.assertRaises(HTTPException) as raised:
            self._create(self._payload(account_id="account-customer-2"))

        self.assertEqual(raised.exception.status_code, 429)
        self.assertIn("超过 15 篇会有封号风险", str(raised.exception.detail))
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            policy = social_automation_api.get_daily_publish_policy(self.customer_id)
        self.assertEqual(policy["used"], 15)
        self.assertEqual(policy["remaining"], 0)
        self.assertTrue(policy["locked"])

    def test_cancelled_and_failed_tasks_release_daily_capacity(self):
        tasks = [self._create(self._payload()) for _ in range(15)]
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            social_automation_api.cancel_social_task(tasks[0]["id"])
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("UPDATE social_automation_tasks SET status = 'running', started_at = ? WHERE id = ?", (self.now, tasks[1]["id"]))
            social_automation_api._finish_task(tasks[1]["id"], "failed", {"retryable": True}, "failed before submit")

        first = self._create(self._payload())
        second = self._create(self._payload())
        self.assertEqual(first["status"], "queued")
        self.assertEqual(second["status"], "queued")
        with self.assertRaises(HTTPException):
            self._create(self._payload())

    def test_admin_and_admin_managed_tasks_are_waived(self):
        for _ in range(18):
            task = self._create(self._payload("account-admin", "persona-admin"))
            self.assertEqual(task["status"], "queued")

        for _ in range(15):
            self._create(self._payload())
        managed = self._create(self._payload(), billing_admin_waived=True)
        with sqlite3.connect(self.db_path) as conn:
            waived = conn.execute(
                "SELECT daily_publish_waived FROM social_automation_tasks WHERE id = ?",
                (managed["id"],),
            ).fetchone()[0]
        self.assertEqual(waived, 1)
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            policy = social_automation_api.get_daily_publish_policy(self.customer_id)
        self.assertEqual(policy["used"], 15)

    def test_scheduled_tasks_reserve_the_target_day_and_roll_over(self):
        tomorrow = self.now + 24 * 60 * 60
        for _ in range(15):
            self._create(self._payload(scheduled_at=tomorrow))

        with self.assertRaises(HTTPException):
            self._create(self._payload(scheduled_at=tomorrow))

        today_task = self._create(self._payload())
        self.assertEqual(today_task["status"], "queued")
        with mock.patch.object(social_automation_api, "_now", return_value=tomorrow):
            tomorrow_policy = social_automation_api.get_daily_publish_policy(self.customer_id)
        self.assertTrue(tomorrow_policy["locked"])
        self.assertEqual(tomorrow_policy["used"], 15)

    def test_worker_does_not_claim_a_backlogged_sixteenth_publish(self):
        tasks = [self._create(self._payload()) for _ in range(15)]
        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
                [(self.now, self.now, task["id"]) for task in tasks],
            )
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type, priority, status,
                  scheduled_at, payload_json, result_json, max_retries, daily_publish_waived,
                  created_at, updated_at
                ) VALUES (
                  'backlogged-sixteenth', ?, 'persona-customer', 'account-customer-1',
                  'threads', 'publish_post', 100, 'queued', 0, '{}', '{}', 0, 0, ?, ?
                )
                """,
                (self.customer_id, self.now, self.now),
            )
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            for task in tasks:
                social_automation_api._finish_task(task["id"], "success", {"publish_submitted": True}, "")

        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            claimed = social_automation_api._claim_next_task()

        self.assertIsNone(claimed)
        with sqlite3.connect(self.db_path) as conn:
            status = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = 'backlogged-sixteenth'"
            ).fetchone()[0]
        self.assertEqual(status, "queued")

    def test_submitted_but_unconfirmed_failure_keeps_daily_capacity(self):
        task = self._create(self._payload())
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
                (self.now, self.now, task["id"]),
            )
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            social_automation_api._finish_task(
                task["id"],
                "failed",
                {"publish_submitted": True, "publish_outcome_unknown": True, "retryable": False},
                "confirmation exhausted",
            )
        for _ in range(14):
            self._create(self._payload())
        with self.assertRaises(HTTPException):
            self._create(self._payload())

    def test_clearing_confirmed_task_does_not_restore_capacity(self):
        task = self._create(self._payload())
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
                (self.now, self.now, task["id"]),
            )
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            social_automation_api._finish_task(task["id"], "success", {"publish_submitted": True}, "")
            social_automation_api.clear_social_task(task["id"])
        for _ in range(14):
            self._create(self._payload())
        with self.assertRaises(HTTPException):
            self._create(self._payload())

    def test_running_publish_reserves_capacity_after_midnight(self):
        previous_day = self.now - 60
        case_now = self.now
        self.now = previous_day
        old_task = self._create(self._payload())
        with mock.patch.object(social_automation_api, "_now", return_value=previous_day):
            claimed = social_automation_api._claim_next_task()
        self.assertEqual(claimed["id"], old_task["id"])

        self.now = case_now
        for _ in range(14):
            self._create(self._payload())
        with self.assertRaises(HTTPException):
            self._create(self._payload())

    def test_worker_scans_past_fifty_limited_tasks_for_another_user(self):
        tasks = [self._create(self._payload()) for _ in range(15)]
        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                "UPDATE social_automation_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
                [(self.now, self.now, task["id"]) for task in tasks],
            )
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            for task in tasks:
                social_automation_api._finish_task(task["id"], "success", {"publish_submitted": True}, "")
        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type, priority, status,
                  scheduled_at, payload_json, result_json, max_retries, daily_publish_waived,
                  created_at, updated_at
                ) VALUES (?, ?, 'persona-customer', 'account-customer-1', 'threads',
                  'publish_post', 1, 'queued', 0, '{}', '{}', 0, 0, ?, ?)
                """,
                [(f"blocked-{index:03d}", self.customer_id, self.now + index, self.now + index) for index in range(55)],
            )
        other = self._create(self._payload("account-customer-two", "persona-customer-two"))
        with mock.patch.object(social_automation_api, "_now", return_value=self.now + 100):
            claimed = social_automation_api._claim_next_task()
        self.assertEqual(claimed["id"], other["id"])

    def test_locked_policy_is_not_publishable_and_invalid_time_is_rejected(self):
        for _ in range(15):
            self._create(self._payload())
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            policy = social_automation_api.get_daily_publish_policy(self.customer_id)
        self.assertTrue(policy["locked"])
        self.assertFalse(policy["can_publish"])
        with self.assertRaises(HTTPException) as raised:
            social_automation_api.get_daily_publish_policy(self.customer_id, scheduled_at=253_402_300_800)
        self.assertEqual(raised.exception.status_code, 400)

    def test_migration_backfills_only_admin_waived_tasks(self):
        with sqlite3.connect(self.db_path) as conn:
            for suffix, reason in (("admin", "admin"), ("legacy", "legacy")):
                task_id = f"historical-{suffix}"
                reservation_id = f"reservation-{suffix}"
                conn.execute(
                    """
                    INSERT INTO billing_reservations(
                      id, user_id, ref_type, ref_id, sku, status, catalog_version_id,
                      meta_json, idempotency_key, created_at, updated_at
                    ) VALUES (?, ?, 'social_task', ?, 'threads_text_publish', 'waived', '', ?, ?, ?, ?)
                    """,
                    (
                        reservation_id,
                        self.customer_id,
                        task_id,
                        f'{{"waived_reason":"{reason}"}}',
                        f"migration-{suffix}",
                        self.now,
                        self.now,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id, user_id, persona_id, account_id, platform, task_type, priority,
                      status, scheduled_at, payload_json, result_json, max_retries,
                      billing_reservation_id, daily_publish_waived, created_at, updated_at
                    ) VALUES (?, ?, 'persona-customer', 'account-customer-1', 'threads',
                      'publish_post', 50, 'queued', 0, '{}', '{}', 0, ?, 0, ?, ?)
                    """,
                    (task_id, self.customer_id, reservation_id, self.now, self.now),
                )

        init_db()

        with sqlite3.connect(self.db_path) as conn:
            admin_task = conn.execute(
                "SELECT daily_publish_waived FROM social_automation_tasks WHERE id = 'historical-admin'"
            ).fetchone()[0]
            legacy_task = conn.execute(
                "SELECT daily_publish_waived FROM social_automation_tasks WHERE id = 'historical-legacy'"
            ).fetchone()[0]
            admin_slot = conn.execute(
                "SELECT state, waived FROM social_daily_publish_slots WHERE task_id = 'historical-admin'"
            ).fetchone()
            legacy_slot = conn.execute(
                "SELECT state, waived FROM social_daily_publish_slots WHERE task_id = 'historical-legacy'"
            ).fetchone()
        self.assertEqual(admin_task, 1)
        self.assertEqual(legacy_task, 0)
        self.assertEqual(tuple(admin_slot), ("waived", 1))
        self.assertEqual(tuple(legacy_slot), ("planned", 0))

    def test_cancel_after_publish_is_armed_keeps_capacity(self):
        task = self._create(self._payload())
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            claimed = social_automation_api._claim_next_task()
            self.assertEqual(claimed["id"], task["id"])
            persisted = social_automation_api._persist_publish_confirmation_context(
                task["id"],
                {
                    "phase": "confirm_only",
                    "profile_url": "https://www.threads.com/@daily-limit",
                    "baseline_permalinks": [],
                    "caption": "daily limit test",
                },
            )
            self.assertTrue(persisted)
            social_automation_api.cancel_social_task(task["id"])
            policy = social_automation_api.get_daily_publish_policy(self.customer_id)
        with sqlite3.connect(self.db_path) as conn:
            slot_state = conn.execute(
                "SELECT state FROM social_daily_publish_slots WHERE task_id = ?",
                (task["id"],),
            ).fetchone()[0]
        self.assertEqual(slot_state, "unknown")
        self.assertEqual(policy["used"], 1)

    def test_publish_batch_waits_until_complete_and_claims_in_sequence(self):
        batch_id = "publish-batch-test"
        first = self._payload(account_id="account-admin", persona_id="persona-admin")
        first.payload.update({
            "publish_batch_id": batch_id,
            "publish_sequence_index": 1,
            "publish_sequence_total": 2,
            "publish_sequence_targets": ["发布第1篇", "发布第2篇"],
        })
        second = self._payload(account_id="account-admin", persona_id="persona-admin")
        second.payload.update({
            "publish_batch_id": batch_id,
            "publish_sequence_index": 2,
            "publish_sequence_total": 2,
            "publish_sequence_targets": ["发布第1篇", "发布第2篇"],
        })

        self._create(first)
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            self.assertIsNone(social_automation_api._claim_next_task())

        self._create(second)
        with mock.patch.object(social_automation_api, "_now", return_value=self.now):
            claimed = social_automation_api._claim_next_task()
            self.assertEqual(claimed["payload"]["publish_sequence_index"], 1)
            batch = social_automation_api._claim_publish_batch_tail(claimed)

        self.assertEqual(
            [item["payload"]["publish_sequence_index"] for item in batch],
            [1, 2],
        )
        with sqlite3.connect(self.db_path) as conn:
            statuses = conn.execute(
                """
                SELECT status
                FROM social_automation_tasks
                WHERE json_extract(payload_json, '$.publish_batch_id') = ?
                ORDER BY CAST(json_extract(payload_json, '$.publish_sequence_index') AS INTEGER)
                """,
                (batch_id,),
            ).fetchall()
        self.assertEqual([item[0] for item in statuses], ["running", "running"])

    def test_incomplete_publish_batch_is_cancelled_after_prepare_timeout(self):
        batch_id = "publish-batch-incomplete"
        first = self._payload(account_id="account-admin", persona_id="persona-admin")
        first.payload.update({
            "publish_batch_id": batch_id,
            "publish_sequence_index": 1,
            "publish_sequence_total": 2,
            "publish_sequence_targets": ["发布第1篇", "发布第2篇"],
        })
        task = self._create(first)

        with (
            mock.patch.dict(
                os.environ,
                {"SOCIAL_AUTOMATION_BATCH_PREPARE_TIMEOUT_SECONDS": "30"},
            ),
            social_automation_api.db() as conn,
        ):
            conn.execute("BEGIN IMMEDIATE")
            social_automation_api._cancel_stale_incomplete_publish_batches(
                conn,
                self.now + 31,
            )

        with sqlite3.connect(self.db_path) as conn:
            status = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = ?",
                (task["id"],),
            ).fetchone()[0]
        self.assertEqual(status, "cancelled")


if __name__ == "__main__":
    unittest.main()
