import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from webapp.db import db, init_db
import webapp.social_automation_api as social_api


class AutomationPlanSchedulerTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self._tmpdir.name) / "app.db"
        os.environ["APP_DB_PATH"] = str(self.db_path)
        init_db()
        with db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, is_admin, approval_status, created_at, updated_at
                ) VALUES ('automation-owner', 'hash', 1, 'approved', 1, 1)
                """
            )
            self.user_id = int(cursor.lastrowid)
            conn.execute(
                """
                INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at)
                VALUES ('persona-1', ?, 1, 1)
                """,
                (self.user_id,),
            )
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, display_name,
                  profile_dir, status, created_at, updated_at
                ) VALUES (
                  'account-1', ?, 'persona-1', 'threads', 'owner_threads', '',
                  'profiles/account-1', 'ready', 1, 1
                )
                """,
                (self.user_id,),
            )
        self.user = {"id": self.user_id, "is_admin": 1}

    def tearDown(self):
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        self._tmpdir.cleanup()

    def _payload(self, *, mode="list", offsets=(0, 30)):
        return social_api.SocialAutomationPlanPayload(
            persona_id="persona-1",
            account_id="account-1",
            platform="threads",
            mode=mode,
            items=[
                social_api.SocialAutomationPlanItemPayload(
                    reservation_minutes=offset,
                    task_type="browse_feed",
                    payload={"browse_limit": index + 1},
                )
                for index, offset in enumerate(offsets)
            ],
        )

    def _insert_plan(self, *, plan_id="plan-manual", mode="list", offsets=(0, 30)):
        payload = self._payload(mode=mode, offsets=offsets)
        account = social_api._require_account_access(payload.account_id, self.user)
        normalized_mode, platform, persona_id, items = social_api._validate_automation_plan_payload(
            payload,
            account,
            user=self.user,
        )
        now = social_api._now()
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_automation_plans(
                  id, user_id, persona_id, account_id, platform, mode, status,
                  items_json, cycle_index, last_error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, '', ?, ?)
                """,
                (
                    plan_id,
                    self.user_id,
                    persona_id,
                    "account-1",
                    platform,
                    normalized_mode,
                    json.dumps(items, ensure_ascii=False),
                    now,
                    now,
                ),
            )
        return plan_id

    def test_list_plan_materializes_ordered_persistent_tasks(self):
        plan = social_api.create_social_automation_plan(self._payload(), user=self.user)

        self.assertEqual(plan["mode"], "list")
        self.assertEqual(plan["status"], "active")
        self.assertEqual(plan["cycle_index"], 1)
        with db() as conn:
            rows = social_api._automation_plan_task_rows(
                conn,
                plan["id"],
                cycle_index=1,
            )
        self.assertEqual(len(rows), 2)
        self.assertEqual([row["status"] for row in rows], ["queued", "queued"])
        self.assertEqual(int(rows[1]["scheduled_at"]) - int(rows[0]["scheduled_at"]), 30 * 60)
        payloads = [json.loads(row["payload_json"]) for row in rows]
        self.assertEqual([item["_automation_plan_sequence"] for item in payloads], [1, 2])

    def test_loop_plan_creates_next_cycle_after_current_cycle_finishes(self):
        plan = social_api.create_social_automation_plan(
            self._payload(mode="loop", offsets=(0,)),
            user=self.user,
        )
        with db() as conn:
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'success', finished_at = 2, updated_at = 2
                WHERE json_extract(payload_json, '$._automation_plan_id') = ?
                """,
                (plan["id"],),
            )

        social_api._reconcile_social_automation_plans()

        with db() as conn:
            updated = conn.execute(
                "SELECT cycle_index, status FROM social_automation_plans WHERE id = ?",
                (plan["id"],),
            ).fetchone()
            cycle_two = social_api._automation_plan_task_rows(
                conn,
                plan["id"],
                cycle_index=2,
            )
        self.assertEqual(int(updated["cycle_index"]), 2)
        self.assertEqual(updated["status"], "active")
        self.assertEqual(len(cycle_two), 1)
        self.assertEqual(cycle_two[0]["status"], "queued")

    def test_materialization_is_idempotent_while_current_cycle_is_active(self):
        plan = social_api.create_social_automation_plan(
            self._payload(mode="loop", offsets=(30,)),
            user=self.user,
        )

        repeated = social_api._materialize_automation_plan(plan["id"])

        self.assertEqual(repeated["cycle_index"], 1)
        with db() as conn:
            all_tasks = social_api._automation_plan_task_rows(conn, plan["id"])
        self.assertEqual(len(all_tasks), 1)

    def test_reservation_must_use_half_hour_steps_and_forward_order(self):
        with self.assertRaises(HTTPException) as invalid_step:
            social_api.create_social_automation_plan(
                self._payload(offsets=(15,)),
                user=self.user,
            )
        self.assertEqual(invalid_step.exception.status_code, 400)

        with self.assertRaises(HTTPException) as backwards:
            social_api.create_social_automation_plan(
                self._payload(offsets=(60, 30)),
                user=self.user,
            )
        self.assertEqual(backwards.exception.status_code, 400)

        with self.assertRaises(HTTPException) as duplicate_time:
            social_api.create_social_automation_plan(
                self._payload(offsets=(30, 30)),
                user=self.user,
            )
        self.assertEqual(duplicate_time.exception.status_code, 400)

    def test_cancel_stops_only_the_selected_plan(self):
        first = social_api.create_social_automation_plan(
            self._payload(offsets=(30,)),
            user=self.user,
        )
        second = social_api.create_social_automation_plan(
            self._payload(offsets=(60,)),
            user=self.user,
        )

        cancelled = social_api.cancel_social_automation_plan(
            first["id"],
            user_id=self.user_id,
        )

        self.assertEqual(cancelled["status"], "cancelled")
        with db() as conn:
            first_tasks = social_api._automation_plan_task_rows(conn, first["id"])
            second_tasks = social_api._automation_plan_task_rows(conn, second["id"])
        self.assertEqual(first_tasks[0]["status"], "cancelled")
        self.assertEqual(second_tasks[0]["status"], "queued")

    def test_plan_rejects_media_outside_the_workspace_upload_directory(self):
        foreign_media = self.db_path.parent / "foreign-user.png"
        foreign_media.write_bytes(b"not-an-image-but-existing")
        payload = social_api.SocialAutomationPlanPayload(
            persona_id="persona-1",
            account_id="account-1",
            platform="threads",
            mode="list",
            items=[
                social_api.SocialAutomationPlanItemPayload(
                    reservation_minutes=0,
                    task_type="publish_post",
                    payload={
                        "content": "publish with media",
                        "media_paths": [str(foreign_media)],
                    },
                )
            ],
        )

        with self.assertRaises(HTTPException) as rejected:
            social_api.create_social_automation_plan(payload, user=self.user)

        self.assertEqual(rejected.exception.status_code, 404)

    def test_plan_rejects_reserved_automation_metadata_from_external_payload(self):
        payload = self._payload(offsets=(0,))
        payload.items[0].payload["_automation_plan_id"] = "spoofed-plan"

        with self.assertRaises(HTTPException) as rejected:
            social_api.create_social_automation_plan(payload, user=self.user)

        self.assertEqual(rejected.exception.status_code, 400)

    def test_admin_workspace_billing_waiver_persists_for_every_cycle(self):
        with db() as conn:
            conn.execute("UPDATE users SET is_admin = 0 WHERE id = ?", (self.user_id,))
        managed_user = {
            "id": self.user_id,
            "is_admin": 0,
            "_workspace_user_id": self.user_id,
            "_workspace_admin_user_id": 987,
        }
        plan = social_api.create_social_automation_plan(
            self._payload(mode="loop", offsets=(0,)),
            user=managed_user,
        )
        with db() as conn:
            stored = conn.execute(
                "SELECT billing_admin_waived FROM social_automation_plans WHERE id = ?",
                (plan["id"],),
            ).fetchone()
            first_cycle = social_api._automation_plan_task_rows(
                conn,
                plan["id"],
                cycle_index=1,
            )
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'success', finished_at = 2, updated_at = 2
                WHERE automation_plan_id = ? AND automation_plan_cycle = 1
                """,
                (plan["id"],),
            )

        self.assertEqual(int(stored["billing_admin_waived"]), 1)
        self.assertEqual(int(first_cycle[0]["daily_publish_waived"]), 1)

        social_api._reconcile_social_automation_plans()

        with db() as conn:
            second_cycle = social_api._automation_plan_task_rows(
                conn,
                plan["id"],
                cycle_index=2,
            )
        self.assertEqual(int(second_cycle[0]["daily_publish_waived"]), 1)

    def test_cancel_during_materialization_cannot_reactivate_the_plan(self):
        plan_id = self._insert_plan(plan_id="plan-cancel-race", offsets=(0, 30))
        original_create = social_api.create_social_task
        calls = 0

        def create_then_cancel(*args, **kwargs):
            nonlocal calls
            created = original_create(*args, **kwargs)
            calls += 1
            if calls == 1:
                social_api.cancel_social_automation_plan(plan_id, user_id=self.user_id)
            return created

        with patch.object(social_api, "create_social_task", side_effect=create_then_cancel):
            try:
                social_api._materialize_automation_plan(plan_id)
            except HTTPException:
                pass

        with db() as conn:
            plan = conn.execute(
                "SELECT status FROM social_automation_plans WHERE id = ?",
                (plan_id,),
            ).fetchone()
            tasks = social_api._automation_plan_task_rows(conn, plan_id)
        self.assertEqual(plan["status"], "cancelled")
        self.assertTrue(tasks)
        self.assertTrue(all(task["status"] == "cancelled" for task in tasks))

    def test_fresh_database_materialization_lease_is_not_stolen(self):
        plan_id = self._insert_plan(plan_id="plan-owned-materialization", offsets=(0,))
        now = social_api._now()
        with db() as conn:
            conn.execute(
                """
                UPDATE social_automation_plans
                SET status = 'materializing',
                    materialization_token = 'other-worker',
                    materializing_cycle = 1,
                    updated_at = ?
                WHERE id = ?
                """,
                (now, plan_id),
            )

        observed = social_api._materialize_automation_plan(plan_id)

        self.assertEqual(observed["status"], "materializing")
        with db() as conn:
            tasks = social_api._automation_plan_task_rows(conn, plan_id)
        self.assertEqual(tasks, [])

    def test_active_plan_tasks_cannot_be_cleared_out_from_under_the_plan(self):
        plan = social_api.create_social_automation_plan(
            self._payload(offsets=(30,)),
            user=self.user,
        )
        with db() as conn:
            task = social_api._automation_plan_task_rows(conn, plan["id"])[0]

        with self.assertRaises(HTTPException) as rejected:
            social_api.clear_social_task(str(task["id"]))

        self.assertEqual(rejected.exception.status_code, 409)
        with db() as conn:
            persisted = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = ?",
                (str(task["id"]),),
            ).fetchone()
        self.assertIsNotNone(persisted)

        with self.assertRaises(HTTPException) as bulk_rejected:
            social_api.clear_social_tasks(
                persona_id="persona-1",
                user_id=self.user_id,
            )
        self.assertEqual(bulk_rejected.exception.status_code, 409)

    def test_zero_offset_loop_waits_at_least_thirty_minutes_between_cycles(self):
        plan = social_api.create_social_automation_plan(
            self._payload(mode="loop", offsets=(0,)),
            user=self.user,
        )
        with db() as conn:
            first = social_api._automation_plan_task_rows(
                conn,
                plan["id"],
                cycle_index=1,
            )[0]
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'success', finished_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (social_api._now(), social_api._now(), str(first["id"])),
            )

        social_api._reconcile_social_automation_plans()

        with db() as conn:
            second = social_api._automation_plan_task_rows(
                conn,
                plan["id"],
                cycle_index=2,
            )[0]
        self.assertGreaterEqual(
            int(second["scheduled_at"]) - int(first["scheduled_at"]),
            30 * 60,
        )

    def test_failed_list_plan_is_not_reported_as_completed(self):
        plan = social_api.create_social_automation_plan(
            self._payload(mode="list", offsets=(0,)),
            user=self.user,
        )
        with db() as conn:
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET status = 'failed', error = 'intentional failure',
                    finished_at = 2, updated_at = 2
                WHERE automation_plan_id = ?
                """,
                (plan["id"],),
            )

        social_api._reconcile_social_automation_plans()

        with db() as conn:
            stored = conn.execute(
                "SELECT status, last_error FROM social_automation_plans WHERE id = ?",
                (plan["id"],),
            ).fetchone()
        self.assertEqual(stored["status"], "failed")
        self.assertIn("intentional failure", stored["last_error"])

    def test_plan_tasks_use_indexed_columns_and_ignore_spoofed_json_metadata(self):
        plan = social_api.create_social_automation_plan(
            self._payload(offsets=(30,)),
            user=self.user,
        )
        now = social_api._now()
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type,
                  priority, status, scheduled_at, payload_json, created_at, updated_at
                ) VALUES (
                  'spoofed-task', ?, 'persona-1', 'account-1', 'threads',
                  'browse_feed', 50, 'queued', 0, ?, ?, ?
                )
                """,
                (
                    self.user_id,
                    json.dumps(
                        {
                            "_automation_plan_id": plan["id"],
                            "_automation_plan_cycle": 1,
                            "_automation_plan_sequence": 99,
                        }
                    ),
                    now,
                    now,
                ),
            )
            rows = social_api._automation_plan_task_rows(conn, plan["id"])
            columns = {
                str(row["name"])
                for row in conn.execute(
                    "PRAGMA table_info(social_automation_tasks)"
                ).fetchall()
            }
            indexes = {
                str(row["name"])
                for row in conn.execute(
                    "PRAGMA index_list(social_automation_tasks)"
                ).fetchall()
            }

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["automation_plan_id"], plan["id"])
        self.assertEqual(int(rows[0]["automation_plan_cycle"]), 1)
        self.assertEqual(int(rows[0]["automation_plan_sequence"]), 1)
        self.assertTrue(
            {
                "automation_plan_id",
                "automation_plan_cycle",
                "automation_plan_sequence",
            }.issubset(columns)
        )
        self.assertIn("idx_social_tasks_plan_cycle", indexes)

    def test_init_db_backfills_legacy_plan_metadata_only_for_matching_owner_and_account(self):
        plan = social_api.create_social_automation_plan(
            self._payload(offsets=(30,)),
            user=self.user,
        )
        with db() as conn:
            task = social_api._automation_plan_task_rows(conn, plan["id"])[0]
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET automation_plan_id = '',
                    automation_plan_cycle = 0,
                    automation_plan_sequence = 0
                WHERE id = ?
                """,
                (str(task["id"]),),
            )

        init_db()

        with db() as conn:
            migrated = conn.execute(
                """
                SELECT automation_plan_id, automation_plan_cycle,
                       automation_plan_sequence
                FROM social_automation_tasks
                WHERE id = ?
                """,
                (str(task["id"]),),
            ).fetchone()
        self.assertEqual(migrated["automation_plan_id"], plan["id"])
        self.assertEqual(int(migrated["automation_plan_cycle"]), 1)
        self.assertEqual(int(migrated["automation_plan_sequence"]), 1)


if __name__ == "__main__":
    unittest.main()
