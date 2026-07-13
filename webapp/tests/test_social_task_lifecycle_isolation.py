import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from webapp.db import db, init_db
import webapp.social_automation_api as social_api


class SocialTaskLifecycleIsolationTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self._tmpdir.name) / "app.db"
        os.environ["APP_DB_PATH"] = str(self.db_path)
        init_db()
        with social_api._RUNNING_TASK_CONTROLS_LOCK:
            social_api._RUNNING_TASK_CONTROLS.clear()
        with social_api._EPHEMERAL_TASK_SECRETS_LOCK:
            social_api._EPHEMERAL_TASK_SECRETS.clear()

    def tearDown(self):
        with social_api._RUNNING_TASK_CONTROLS_LOCK:
            social_api._RUNNING_TASK_CONTROLS.clear()
        with social_api._EPHEMERAL_TASK_SECRETS_LOCK:
            social_api._EPHEMERAL_TASK_SECRETS.clear()
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        self._tmpdir.cleanup()

    def _insert_user(self, username: str) -> int:
        with db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users(username, password_hash, approval_status, created_at, updated_at)
                VALUES (?, 'hash', 'approved', 1, 1)
                """,
                (username,),
            )
            return int(cursor.lastrowid)

    def _insert_account(self, account_id: str, user_id: int, *, platform: str = "threads") -> None:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, display_name,
                  profile_dir, status, created_at, updated_at
                ) VALUES (?, ?, '', ?, ?, '', ?, 'ready', 1, 1)
                """,
                (account_id, user_id, platform, account_id, f"profiles/{account_id}"),
            )

    def _insert_task(self, task_id: str, account_id: str, user_id: int, *, status: str = "running") -> None:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type,
                  priority, status, payload_json, result_json, created_at, updated_at
                ) VALUES (?, ?, '', ?, 'threads', 'check_login', 50, ?, '{}', '{}', 1, 1)
                """,
                (task_id, user_id, account_id, status),
            )

    def test_integrity_triggers_are_installed_on_existing_database(self):
        with db() as conn:
            trigger_names = [
                str(row["name"])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_social_%'"
                ).fetchall()
            ]
            for name in trigger_names:
                conn.execute(f'DROP TRIGGER "{name}"')

        init_db()

        with sqlite3.connect(self.db_path) as conn:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "owner user missing"):
                conn.execute(
                    """
                    INSERT INTO social_proxies(
                      id, user_id, name, proxy_type, host, port, created_at, updated_at
                    ) VALUES ('orphan-proxy', 991, 'orphan', 'http', 'proxy.example', 8080, 1, 1)
                    """
                )

    def test_nonzero_social_rows_require_existing_matching_owners(self):
        owner_id = self._insert_user("owner")
        other_id = self._insert_user("other")
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_proxies(
                  id, user_id, name, proxy_type, host, port, created_at, updated_at
                ) VALUES ('other-proxy', ?, 'other', 'http', 'proxy.example', 8080, 1, 1)
                """,
                (other_id,),
            )

            with self.assertRaisesRegex(sqlite3.IntegrityError, "owner user missing"):
                conn.execute(
                    """
                    INSERT INTO social_accounts(
                      id, user_id, persona_id, platform, username, profile_dir, created_at, updated_at
                    ) VALUES ('missing-owner', 992, '', 'threads', 'missing', 'profiles/missing', 1, 1)
                    """
                )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "proxy owner mismatch"):
                conn.execute(
                    """
                    INSERT INTO social_accounts(
                      id, user_id, persona_id, platform, username, profile_dir, proxy_id, created_at, updated_at
                    ) VALUES ('cross-proxy', ?, '', 'threads', 'cross', 'profiles/cross', 'other-proxy', 1, 1)
                    """,
                    (owner_id,),
                )

            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir, created_at, updated_at
                ) VALUES ('owner-account', ?, '', 'threads', 'owner', 'profiles/owner', 1, 1)
                """,
                (owner_id,),
            )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "account missing"):
                conn.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id, user_id, persona_id, account_id, platform, task_type,
                      payload_json, created_at, updated_at
                    ) VALUES ('missing-account', ?, '', 'absent', 'threads', 'check_login', '{}', 1, 1)
                    """,
                    (owner_id,),
                )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "account owner mismatch"):
                conn.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id, user_id, persona_id, account_id, platform, task_type,
                      payload_json, created_at, updated_at
                    ) VALUES ('cross-account', ?, '', 'owner-account', 'threads', 'check_login', '{}', 1, 1)
                    """,
                    (other_id,),
                )

    def test_legacy_user_zero_internal_rows_remain_supported(self):
        with db() as conn:
            conn.execute(
                """
                INSERT INTO social_proxies(
                  id, user_id, name, proxy_type, host, port, created_at, updated_at
                ) VALUES ('legacy-proxy', 0, 'legacy', 'http', 'legacy.example', 8080, 1, 1)
                """
            )
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir,
                  proxy_id, created_at, updated_at
                ) VALUES ('legacy-account', 0, '', 'threads', 'legacy', 'profiles/legacy',
                          'legacy-proxy', 1, 1)
                """
            )
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type,
                  payload_json, created_at, updated_at
                ) VALUES ('legacy-internal-task', 0, '', 'legacy-account',
                          'threads', 'check_login', '{}', 1, 1)
                """
            )

    def test_legacy_user_zero_cannot_bind_tenant_owned_resources(self):
        owner_id = self._insert_user("tenant-owner")
        self._insert_account("tenant-account", owner_id)
        with db() as conn:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "account owner mismatch"):
                conn.execute(
                    """
                    INSERT INTO social_automation_tasks(
                      id, user_id, persona_id, account_id, platform, task_type,
                      payload_json, created_at, updated_at
                    ) VALUES ('legacy-cross-tenant', 0, '', 'tenant-account',
                              'threads', 'check_login', '{}', 1, 1)
                    """
                )

    def test_proxy_create_serializes_check_delete_insert_race(self):
        owner_id = self._insert_user("proxy-race")
        owner_checked = threading.Event()
        delete_attempted = threading.Event()
        creator_errors = []
        delete_errors = []
        original_check = social_api._require_active_owner_user

        def checked_owner(conn, user_id):
            original_check(conn, user_id)
            owner_checked.set()
            self.assertTrue(delete_attempted.wait(timeout=2))

        def create_proxy():
            try:
                social_api.create_social_proxy(
                    social_api.SocialProxyPayload(host="race.example", port=8080),
                    owner_user_id=owner_id,
                )
            except BaseException as exc:
                creator_errors.append(exc)

        def delete_user():
            self.assertTrue(owner_checked.wait(timeout=2))
            try:
                with db() as conn:
                    delete_attempted.set()
                    conn.execute("DELETE FROM users WHERE id = ?", (owner_id,))
            except BaseException as exc:
                delete_errors.append(exc)

        with mock.patch.object(social_api, "_require_active_owner_user", side_effect=checked_owner):
            creator = threading.Thread(target=create_proxy)
            deleter = threading.Thread(target=delete_user)
            creator.start()
            deleter.start()
            creator.join(timeout=5)
            deleter.join(timeout=5)

        self.assertFalse(creator.is_alive())
        self.assertFalse(deleter.is_alive())
        self.assertEqual(creator_errors, [])
        self.assertEqual(len(delete_errors), 1)
        self.assertIsInstance(delete_errors[0], sqlite3.IntegrityError)
        with db() as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM users WHERE id = ?", (owner_id,)).fetchone())
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM social_proxies WHERE user_id = ?", (owner_id,)).fetchone()[0],
                1,
            )

    def test_task_create_serializes_account_delete_insert_race(self):
        owner_id = self._insert_user("task-race")
        self._insert_account("race-account", owner_id)
        owner_checked = threading.Event()
        delete_attempted = threading.Event()
        creator_errors = []
        delete_errors = []
        original_check = social_api._require_active_owner_user

        def checked_owner(conn, user_id):
            original_check(conn, user_id)
            owner_checked.set()
            self.assertTrue(delete_attempted.wait(timeout=2))

        def create_task():
            try:
                social_api.create_social_task(
                    social_api.SocialTaskPayload(
                        account_id="race-account",
                        platform="threads",
                        task_type="check_login",
                    )
                )
            except BaseException as exc:
                creator_errors.append(exc)

        def delete_account_and_user():
            self.assertTrue(owner_checked.wait(timeout=2))
            try:
                with db() as conn:
                    delete_attempted.set()
                    conn.execute("DELETE FROM social_accounts WHERE id = 'race-account'")
                    conn.execute("DELETE FROM users WHERE id = ?", (owner_id,))
            except BaseException as exc:
                delete_errors.append(exc)

        with mock.patch.object(social_api, "_require_active_owner_user", side_effect=checked_owner):
            creator = threading.Thread(target=create_task)
            deleter = threading.Thread(target=delete_account_and_user)
            creator.start()
            deleter.start()
            creator.join(timeout=5)
            deleter.join(timeout=5)

        self.assertFalse(creator.is_alive())
        self.assertFalse(deleter.is_alive())
        self.assertEqual(creator_errors, [])
        self.assertEqual(len(delete_errors), 1)
        self.assertIsInstance(delete_errors[0], sqlite3.IntegrityError)
        with db() as conn:
            task = conn.execute(
                "SELECT user_id, account_id FROM social_automation_tasks WHERE account_id = 'race-account'"
            ).fetchone()
            self.assertEqual(tuple(task), (owner_id, "race-account"))

    def test_missing_task_row_is_cancelled(self):
        self.assertTrue(social_api._is_task_cancelled("deleted-task"))

    def test_claimed_task_registers_control_before_execution_preparation(self):
        owner_id = self._insert_user("control-race")
        self._insert_account("control-account", owner_id)
        self._insert_task("control-task", "control-account", owner_id)
        entered = threading.Event()
        release = threading.Event()

        def hold_execution(_task, control):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            self.assertTrue(control["cancel_event"].is_set())

        with mock.patch.object(
            social_api,
            "_execute_claimed_task_with_control",
            side_effect=hold_execution,
        ):
            worker = threading.Thread(
                target=social_api._execute_claimed_task,
                args=({"id": "control-task", "account_id": "control-account"},),
            )
            worker.start()
            self.assertTrue(entered.wait(timeout=2))
            social_api._force_stop_running_task("control-task")
            release.set()
            worker.join(timeout=5)

        self.assertFalse(worker.is_alive())
        with social_api._RUNNING_TASK_CONTROLS_LOCK:
            self.assertNotIn("control-task", social_api._RUNNING_TASK_CONTROLS)

    def test_cancel_all_tasks_unions_user_and_account_scopes_and_force_stops_controls(self):
        owner_id = self._insert_user("cancel-owner")
        account_owner_id = self._insert_user("cancel-account-owner")
        untouched_owner_id = self._insert_user("cancel-untouched-owner")
        self._insert_account("owner-account", owner_id)
        self._insert_account("selected-account", account_owner_id)
        self._insert_account("untouched-account", untouched_owner_id)
        self._insert_task("owner-task", "owner-account", owner_id, status="queued")
        self._insert_task("selected-account-task", "selected-account", account_owner_id)
        self._insert_task("untouched-task", "untouched-account", untouched_owner_id)

        owner_cancel = threading.Event()
        selected_cancel = threading.Event()
        untouched_cancel = threading.Event()
        with social_api._RUNNING_TASK_CONTROLS_LOCK:
            social_api._RUNNING_TASK_CONTROLS.update(
                {
                    "owner-task": {"cancel_event": owner_cancel},
                    "selected-account-task": {"cancel_event": selected_cancel},
                    "untouched-task": {"cancel_event": untouched_cancel},
                }
            )

        result = social_api.cancel_all_social_tasks(
            "targeted stop",
            user_id=owner_id,
            account_ids=[" selected-account ", "", "selected-account"],
        )

        self.assertEqual(set(result["task_ids"]), {"owner-task", "selected-account-task"})
        self.assertEqual(result["cancelled_count"], 2)
        self.assertTrue(owner_cancel.is_set())
        self.assertTrue(selected_cancel.is_set())
        self.assertFalse(untouched_cancel.is_set())
        with db() as conn:
            statuses = {
                str(row["id"]): str(row["status"])
                for row in conn.execute(
                    "SELECT id, status FROM social_automation_tasks ORDER BY id"
                ).fetchall()
            }
        self.assertEqual(statuses["owner-task"], "cancelled")
        self.assertEqual(statuses["selected-account-task"], "cancelled")
        self.assertEqual(statuses["untouched-task"], "running")


if __name__ == "__main__":
    unittest.main()
