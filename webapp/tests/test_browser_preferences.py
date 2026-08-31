import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp import social_automation_api
from webapp.auth import get_current_user


class BrowserPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db_path = os.environ.get("APP_DB_PATH")
        self.old_worker_last_launch = (
            social_automation_api._WORKER_LAST_TASK_LAUNCH_MONOTONIC
        )
        social_automation_api._WORKER_LAST_TASK_LAUNCH_MONOTONIC = 0.0
        os.environ["APP_DB_PATH"] = str(Path(self.temp_dir.name) / "app.db")
        db_module.init_db()
        with db_module.db() as conn:
            now = 100
            conn.execute(
                "INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES (1, 'user-a', 'x', ?, ?)",
                (now, now),
            )
            conn.execute(
                "INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES (2, 'user-b', 'x', ?, ?)",
                (now, now),
            )
        social_automation_api.set_live_browser_settings(
            social_automation_api.LiveBrowserSettingsPayload(
                standby_seconds=0,
                auto_close_seconds=30,
                max_concurrency=2,
                text_input_mode="paste",
            )
        )

    def tearDown(self):
        social_automation_api._WORKER_LAST_TASK_LAUNCH_MONOTONIC = (
            self.old_worker_last_launch
        )
        with social_automation_api._EXTERNAL_BROWSER_LEASES_LOCK:
            social_automation_api._EXTERNAL_BROWSER_LEASES.clear()
        if self.old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def _insert_scheduler_task(self, task_id, user_id, status, *, created_at, account_id=None):
        clean_account_id = account_id or f"account-{task_id}"
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO social_accounts(
                  id, user_id, persona_id, platform, username, display_name,
                  profile_dir, status, created_at, updated_at
                ) VALUES (?, ?, 'persona-1', 'threads', ?, 'Scheduler Test', ?, 'ready', ?, ?)
                """,
                (
                    clean_account_id,
                    int(user_id),
                    f"user-{user_id}-{task_id}",
                    f"profiles/{clean_account_id}",
                    created_at,
                    created_at,
                ),
            )
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type, priority, status,
                  scheduled_at, started_at, payload_json, result_json, error,
                  retry_count, max_retries, created_by, created_at, updated_at
                ) VALUES (?, ?, 'persona-1', ?, 'threads', 'browse_feed', 50, ?, 0, ?, '{}', '{}', '', 0, 0, 'web', ?, ?)
                """,
                (
                    task_id,
                    int(user_id),
                    clean_account_id,
                    status,
                    created_at if status == "running" else 0,
                    created_at,
                    created_at,
                ),
            )

    def _claim_without_recovery(self):
        with (
            mock.patch.object(social_automation_api, "_recover_orphaned_publish_confirmation_tasks"),
            mock.patch.object(social_automation_api, "_recover_orphaned_manual_task"),
            mock.patch.object(social_automation_api, "_recover_orphaned_running_tasks"),
        ):
            return social_automation_api._claim_next_task()

    def test_default_global_concurrency_is_three(self):
        with db_module.db() as conn:
            conn.execute("DELETE FROM admin_config WHERE key = 'live_browser_settings'")

        self.assertEqual(
            social_automation_api.get_live_browser_settings()["max_concurrency"],
            3,
        )

    def test_preferences_are_isolated_and_clamped_by_global_limit(self):
        saved = social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="review_hold",
                review_hold_seconds=120,
                standby_seconds=60,
                auto_close_seconds=300,
                manual_timeout_seconds=1800,
                requested_concurrency=2,
                text_input_mode="type",
            ),
            auto_configured=False,
        )

        self.assertEqual(saved["completion_policy"], "review_hold")
        self.assertEqual(social_automation_api.get_user_browser_preferences(2)["completion_policy"], "immediate_close")
        effective = social_automation_api.effective_user_browser_preferences(saved)
        self.assertEqual(effective["requested_concurrency"], 2)
        self.assertEqual(effective["standby_seconds"], 60)
        self.assertEqual(effective["auto_close_seconds"], 300)

    def test_browser_concurrency_above_server_limit_is_rejected_with_clear_message(self):
        with self.assertRaises(social_automation_api.HTTPException) as global_error:
            social_automation_api.set_live_browser_settings(
                social_automation_api.LiveBrowserSettingsPayload(
                    standby_seconds=0,
                    auto_close_seconds=30,
                    max_concurrency=5,
                    text_input_mode="paste",
                )
            )
        self.assertEqual(global_error.exception.status_code, 400)
        self.assertIn("最多允许 4", str(global_error.exception.detail))

        with self.assertRaises(social_automation_api.HTTPException) as user_error:
            social_automation_api.set_user_browser_preferences(
                1,
                social_automation_api.BrowserPreferencesPayload(
                    requested_concurrency=5,
                ),
                auto_configured=False,
            )
        self.assertEqual(user_error.exception.status_code, 400)
        self.assertIn("最多允许 2", str(user_error.exception.detail))

    def test_legacy_user_concurrency_is_capped_at_two(self):
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO user_browser_settings(
                  user_id, completion_policy, review_hold_seconds, manual_timeout_seconds,
                  requested_concurrency, text_input_mode, auto_configured, updated_at,
                  standby_seconds, auto_close_seconds
                ) VALUES (1, 'immediate_close', 30, 900, 6, 'paste', 0, 100, 0, 30)
                """
            )
            conn.execute(
                """
                UPDATE admin_config
                SET value_json = '{"standby_seconds":0,"auto_close_seconds":30,"max_concurrency":6,"text_input_mode":"paste"}'
                WHERE key = 'live_browser_settings'
                """
            )

        self.assertEqual(social_automation_api.get_live_browser_settings()["max_concurrency"], 3)
        self.assertEqual(social_automation_api.get_live_browser_settings()["text_input_mode"], "type")
        self.assertEqual(social_automation_api.get_user_browser_preferences(1)["requested_concurrency"], 2)
        self.assertEqual(social_automation_api.get_user_browser_preferences(1)["text_input_mode"], "type")

    def test_scheduler_queues_third_task_for_same_customer(self):
        social_automation_api.set_live_browser_settings(
            social_automation_api.LiveBrowserSettingsPayload(
                standby_seconds=0,
                auto_close_seconds=30,
                max_concurrency=3,
                text_input_mode="paste",
            )
        )
        self._insert_scheduler_task("user-a-running-1", 1, "running", created_at=101)
        self._insert_scheduler_task("user-a-running-2", 1, "running", created_at=102)
        self._insert_scheduler_task("user-a-queued", 1, "queued", created_at=103)
        self._insert_scheduler_task("user-b-queued", 2, "queued", created_at=104)

        claimed = self._claim_without_recovery()

        self.assertEqual(claimed["id"], "user-b-queued")
        with db_module.db() as conn:
            queued_status = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = 'user-a-queued'"
            ).fetchone()["status"]
        self.assertEqual(queued_status, "queued")

    def test_admin_bypasses_customer_global_concurrency(self):
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO users(id, username, password_hash, is_admin, created_at, updated_at) VALUES (3, 'admin-a', 'x', 1, 100, 100)"
            )
        social_automation_api.set_live_browser_settings(
            social_automation_api.LiveBrowserSettingsPayload(
                standby_seconds=0,
                auto_close_seconds=30,
                max_concurrency=3,
                text_input_mode="paste",
            )
        )
        self._insert_scheduler_task("normal-running-1", 1, "running", created_at=101)
        self._insert_scheduler_task("normal-running-2", 1, "running", created_at=102)
        self._insert_scheduler_task("normal-running-3", 2, "running", created_at=103)
        self._insert_scheduler_task("normal-queued", 2, "queued", created_at=104)
        self._insert_scheduler_task("admin-queued", 3, "queued", created_at=105)

        claimed = self._claim_without_recovery()

        self.assertEqual(claimed["id"], "admin-queued")
        with db_module.db() as conn:
            normal_status = conn.execute(
                "SELECT status FROM social_automation_tasks WHERE id = 'normal-queued'"
            ).fetchone()["status"]
        self.assertEqual(normal_status, "queued")

    def test_worker_resource_gate_blocks_new_browser_when_memory_is_low(self):
        with mock.patch.object(
            social_automation_api,
            "_memory_environment",
            return_value={"memory_total_mb": 3584, "memory_available_mb": 1300, "swap_total_mb": 0},
        ):
            blocked = social_automation_api._browser_worker_resource_admission(active_slots=1)
            first_task = social_automation_api._browser_worker_resource_admission(active_slots=0)

        self.assertFalse(blocked["allow_launch"])
        self.assertEqual(blocked["reason"], "low_memory")
        self.assertEqual(blocked["required_available_mb"], 1536)
        self.assertFalse(blocked["swap_relaxed"])
        self.assertTrue(first_task["allow_launch"])

    def test_worker_resource_gate_uses_lower_additional_threshold_with_two_gb_swap(self):
        with mock.patch.object(
            social_automation_api,
            "_memory_environment",
            return_value={
                "memory_total_mb": 3584,
                "memory_available_mb": 700,
                "swap_total_mb": 2048,
            },
        ):
            admission = social_automation_api._browser_worker_resource_admission(
                active_slots=1
            )

        self.assertTrue(admission["allow_launch"])
        self.assertEqual(admission["required_available_mb"], 512)
        self.assertEqual(admission["swap_total_mb"], 2048)
        self.assertTrue(admission["swap_relaxed"])

    def test_worker_resource_gate_keeps_original_threshold_below_two_gb_swap(self):
        with mock.patch.object(
            social_automation_api,
            "_memory_environment",
            return_value={
                "memory_total_mb": 3584,
                "memory_available_mb": 700,
                "swap_total_mb": 2047,
            },
        ):
            admission = social_automation_api._browser_worker_resource_admission(
                active_slots=1
            )

        self.assertFalse(admission["allow_launch"])
        self.assertEqual(admission["required_available_mb"], 1536)
        self.assertFalse(admission["swap_relaxed"])

    def test_worker_launches_queued_tasks_at_least_ten_seconds_apart(self):
        clock = {"now": 100.0}
        queued = iter([{"id": "task-1"}, {"id": "task-2"}])
        started: list[str] = []

        with (
            mock.patch.dict(
                os.environ,
                {"SOCIAL_AUTOMATION_WORKER_LAUNCH_STAGGER_SECONDS": "10"},
            ),
            mock.patch.object(
                social_automation_api.time,
                "monotonic",
                side_effect=lambda: clock["now"],
            ),
            mock.patch.object(
                social_automation_api._WORKER_STOP,
                "is_set",
                return_value=False,
            ),
            mock.patch.object(
                social_automation_api,
                "_social_worker_slots_in_use",
                return_value=0,
            ),
            mock.patch.object(
                social_automation_api,
                "_social_worker_max_concurrency",
                return_value=3,
            ),
            mock.patch.object(
                social_automation_api,
                "_browser_worker_resource_admission",
                return_value={"allow_launch": True},
            ),
            mock.patch.object(
                social_automation_api,
                "_claim_next_task",
                side_effect=lambda: next(queued, None),
            ) as claim,
            mock.patch.object(
                social_automation_api,
                "_start_claimed_task_thread",
                side_effect=lambda task: started.append(str(task["id"])),
            ),
            mock.patch.object(social_automation_api, "_refresh_worker_state"),
        ):
            self.assertEqual(
                social_automation_api._launch_available_social_tasks(), 1
            )
            clock["now"] = 109.999
            self.assertEqual(
                social_automation_api._launch_available_social_tasks(), 0
            )
            clock["now"] = 110.0
            self.assertEqual(
                social_automation_api._launch_available_social_tasks(), 1
            )

        self.assertEqual(started, ["task-1", "task-2"])
        self.assertEqual(claim.call_count, 2)

    def test_worker_launch_stagger_can_be_disabled(self):
        queued = iter([{"id": "task-1"}, {"id": "task-2"}, None])
        started: list[str] = []

        with (
            mock.patch.dict(
                os.environ,
                {"SOCIAL_AUTOMATION_WORKER_LAUNCH_STAGGER_SECONDS": "0"},
            ),
            mock.patch.object(
                social_automation_api._WORKER_STOP,
                "is_set",
                return_value=False,
            ),
            mock.patch.object(
                social_automation_api,
                "_social_worker_slots_in_use",
                return_value=0,
            ),
            mock.patch.object(
                social_automation_api,
                "_social_worker_max_concurrency",
                return_value=3,
            ),
            mock.patch.object(
                social_automation_api,
                "_browser_worker_resource_admission",
                return_value={"allow_launch": True},
            ),
            mock.patch.object(
                social_automation_api,
                "_claim_next_task",
                side_effect=lambda: next(queued),
            ),
            mock.patch.object(
                social_automation_api,
                "_start_claimed_task_thread",
                side_effect=lambda task: started.append(str(task["id"])),
            ),
            mock.patch.object(social_automation_api, "_refresh_worker_state"),
        ):
            launched = social_automation_api._launch_available_social_tasks()

        self.assertEqual(launched, 2)
        self.assertEqual(started, ["task-1", "task-2"])

    def test_worker_keeps_one_hard_slot_for_admin_bypass(self):
        slots = iter([3, 4])
        started = []
        with (
            mock.patch.object(
                social_automation_api._WORKER_STOP,
                "is_set",
                return_value=False,
            ),
            mock.patch.object(
                social_automation_api,
                "_social_worker_slots_in_use",
                side_effect=lambda: next(slots),
            ),
            mock.patch.object(
                social_automation_api,
                "_social_worker_launch_stagger_remaining_seconds",
                return_value=0,
            ),
            mock.patch.object(
                social_automation_api,
                "_browser_worker_resource_admission",
                return_value={"allow_launch": True},
            ),
            mock.patch.object(
                social_automation_api,
                "_claim_next_task",
                return_value={"id": "admin-fourth-task"},
            ),
            mock.patch.object(
                social_automation_api,
                "_start_claimed_task_thread",
                side_effect=lambda task: started.append(task["id"]),
            ),
            mock.patch.object(social_automation_api, "_record_social_worker_task_launch"),
            mock.patch.object(social_automation_api, "_refresh_worker_state"),
        ):
            launched = social_automation_api._launch_available_social_tasks()

        self.assertEqual(launched, 1)
        self.assertEqual(started, ["admin-fourth-task"])

    def test_worker_launch_stagger_is_disabled_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SOCIAL_AUTOMATION_WORKER_LAUNCH_STAGGER_SECONDS", None)
            self.assertEqual(
                social_automation_api._social_worker_launch_stagger_seconds(),
                0,
            )

    def test_cgroup_headroom_is_part_of_the_browser_admission_budget(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_memory_environment",
                return_value={
                    "memory_total_mb": 3584,
                    "memory_available_mb": 1800,
                    "swap_total_mb": 0,
                },
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_value",
                return_value=(2 * 1024 * 1024 * 1024, True),
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_limit",
                return_value=(3 * 1024 * 1024 * 1024, True),
            ),
        ):
            snapshot = social_automation_api._browser_runtime_resource_snapshot()
            admission = social_automation_api._browser_worker_resource_admission(
                active_slots=1
            )

        self.assertEqual(snapshot["container_memory_headroom_mb"], 1024)
        self.assertEqual(snapshot["memory_available_mb"], 1024)
        self.assertFalse(admission["allow_launch"])

    def test_exhausted_cgroup_limit_never_fails_open(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_memory_environment",
                return_value={
                    "memory_total_mb": 3584,
                    "memory_available_mb": 1800,
                    "swap_total_mb": 4096,
                },
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_value",
                return_value=(3 * 1024 * 1024 * 1024, True),
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_limit",
                return_value=(3 * 1024 * 1024 * 1024, True),
            ),
        ):
            admission = social_automation_api._browser_worker_resource_admission(
                active_slots=0
            )

        self.assertTrue(admission["memory_available_known"])
        self.assertEqual(admission["memory_available_mb"], 0)
        self.assertFalse(admission["allow_launch"])

    def test_unlimited_cgroup_uses_host_availability(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_memory_environment",
                return_value={
                    "memory_total_mb": 3584,
                    "memory_available_mb": 1800,
                    "swap_total_mb": 4096,
                },
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_value",
                return_value=(2 * 1024 * 1024 * 1024, True),
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_limit",
                return_value=(0, False),
            ),
        ):
            snapshot = social_automation_api._browser_runtime_resource_snapshot()

        self.assertEqual(snapshot["memory_available_mb"], 1800)
        self.assertFalse(snapshot["container_memory_limit_known"])

    def test_unknown_cgroup_current_does_not_manufacture_headroom(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_memory_environment",
                return_value={
                    "memory_total_mb": 3584,
                    "memory_available_mb": 1800,
                    "swap_total_mb": 4096,
                },
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_value",
                return_value=(0, False),
            ),
            mock.patch.object(
                social_automation_api,
                "_read_linux_memory_limit",
                return_value=(3 * 1024 * 1024 * 1024, True),
            ),
        ):
            snapshot = social_automation_api._browser_runtime_resource_snapshot()

        self.assertEqual(snapshot["memory_available_mb"], 1800)
        self.assertEqual(snapshot["container_memory_headroom_mb"], 0)
        self.assertFalse(snapshot["container_memory_headroom_known"])
        self.assertFalse(snapshot["container_memory_current_known"])

    def test_running_task_and_its_live_session_share_one_slot(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_active_worker_thread_task_ids",
                return_value={"task-1"},
            ),
            mock.patch.object(
                social_automation_api,
                "_live_browser_sessions",
                return_value=[{"id": "browser-1", "task_id": "task-1"}],
            ),
        ):
            self.assertEqual(social_automation_api._social_worker_slots_in_use(), 1)

    def test_independent_standby_browser_is_added_to_running_task_slot(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_active_worker_thread_task_ids",
                return_value={"task-1"},
            ),
            mock.patch.object(
                social_automation_api,
                "_live_browser_sessions",
                return_value=[
                    {"id": "browser-1", "task_id": "task-1"},
                    {"id": "browser-2", "task_id": "finished-task"},
                ],
            ),
        ):
            self.assertEqual(social_automation_api._social_worker_slots_in_use(), 2)

    def test_live_session_mapped_by_control_is_deduplicated_from_worker(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_active_worker_thread_task_ids",
                return_value={"batch-root"},
            ),
            mock.patch.object(
                social_automation_api,
                "_live_browser_sessions",
                return_value=[{"id": "browser-1", "task_id": "batch-item-2"}],
            ),
        ):
            with social_automation_api._RUNNING_TASK_CONTROLS_LOCK:
                social_automation_api._RUNNING_TASK_CONTROLS["batch-root"] = {
                    "live_browser_session_id": "browser-1",
                    "current_task_id": "batch-item-2",
                }
            try:
                self.assertEqual(
                    social_automation_api._social_worker_slots_in_use(),
                    1,
                )
            finally:
                with social_automation_api._RUNNING_TASK_CONTROLS_LOCK:
                    social_automation_api._RUNNING_TASK_CONTROLS.pop(
                        "batch-root",
                        None,
                    )

    def test_extra_live_session_for_same_running_task_consumes_another_slot(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_active_worker_thread_task_ids",
                return_value={"task-1"},
            ),
            mock.patch.object(
                social_automation_api,
                "_live_browser_sessions",
                return_value=[
                    {"id": "browser-1", "task_id": "task-1"},
                    {"id": "browser-2", "task_id": "task-1"},
                ],
            ),
        ):
            self.assertEqual(social_automation_api._social_worker_slots_in_use(), 2)

    def test_external_chromium_workflow_shares_the_two_browser_budget(self):
        with (
            mock.patch.object(
                social_automation_api,
                "_active_worker_thread_task_ids",
                return_value={"task-1"},
            ),
            mock.patch.object(
                social_automation_api,
                "_live_browser_sessions",
                return_value=[],
            ),
            mock.patch.object(
                social_automation_api,
                "_browser_runtime_resource_snapshot",
                return_value={
                    "memory_available_mb": 2200,
                    "memory_available_known": 1,
                    "container_memory_mb": 800,
                    "container_memory_headroom_mb": 2200,
                },
            ),
            mock.patch.object(social_automation_api, "_refresh_worker_state"),
            mock.patch.object(social_automation_api, "wake_social_automation_worker"),
        ):
            first = social_automation_api.acquire_external_browser_lease(
                "persona-refresh"
            )
            second = social_automation_api.acquire_external_browser_lease(
                "persona-refresh"
            )
            social_automation_api.release_external_browser_lease(first)

        self.assertTrue(first)
        self.assertEqual(second, "")

    def test_known_zero_available_memory_is_recorded_as_the_minimum(self):
        samples = iter(
            [
                {
                    "container_memory_mb": 900,
                    "memory_available_mb": 700,
                    "memory_available_known": 1,
                },
                {
                    "container_memory_mb": 1100,
                    "memory_available_mb": 0,
                    "memory_available_known": 1,
                },
            ]
        )
        control = {
            "resource_snapshot_provider": lambda: next(samples),
        }

        social_automation_api._sample_running_task_resources(control)
        social_automation_api._sample_running_task_resources(control)

        self.assertEqual(
            control["_resource_metrics"]["memory_available_min_mb"],
            0,
        )

    def test_idle_memory_release_is_single_flight(self):
        social_automation_api._IDLE_MEMORY_RELEASE_LOCK.acquire()
        try:
            with mock.patch.object(
                social_automation_api.gc,
                "collect",
            ) as collect:
                result = social_automation_api._release_idle_worker_memory()
        finally:
            social_automation_api._IDLE_MEMORY_RELEASE_LOCK.release()

        self.assertFalse(result["released"])
        self.assertEqual(result["reason"], "release_in_progress")
        collect.assert_not_called()

    def test_user_endpoint_can_save_own_preferences(self):
        app = FastAPI()
        social_automation_api.register_social_automation_routes(app)
        app.dependency_overrides[get_current_user] = lambda: {"id": 1, "is_admin": 0}
        client = TestClient(app)

        response = client.put(
            "/api/persona_dashboard/automation/browser_preferences",
            json={
                "completion_policy": "immediate_close",
                "review_hold_seconds": 30,
                "standby_seconds": 120,
                "auto_close_seconds": 600,
                "manual_timeout_seconds": 600,
                "requested_concurrency": 2,
                "text_input_mode": "paste",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["preferences"]["manual_timeout_seconds"], 600)
        self.assertEqual(response.json()["preferences"]["standby_seconds"], 120)
        self.assertEqual(response.json()["preferences"]["auto_close_seconds"], 600)
        self.assertEqual(response.json()["preferences"]["text_input_mode"], "type")
        self.assertEqual(social_automation_api.get_user_browser_preferences(2)["manual_timeout_seconds"], 300)

    def test_auto_configure_uses_server_recommendation(self):
        app = FastAPI()
        social_automation_api.register_social_automation_routes(app)
        app.dependency_overrides[get_current_user] = lambda: {"id": 1, "is_admin": 0}
        client = TestClient(app)
        with (
            mock.patch.object(social_automation_api.os, "cpu_count", return_value=2),
            mock.patch.object(
                social_automation_api,
                "_memory_environment",
                return_value={"memory_total_mb": 3584, "memory_available_mb": 1800, "swap_total_mb": 0},
            ),
            mock.patch.object(social_automation_api, "_live_browser_sessions", return_value=[]),
        ):
            response = client.post("/api/persona_dashboard/automation/browser_preferences/auto_configure")

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["environment"]["resource_level"], "limited")
        self.assertEqual(body["preferences"]["completion_policy"], "immediate_close")
        self.assertEqual(body["preferences"]["standby_seconds"], 0)
        self.assertEqual(body["preferences"]["auto_close_seconds"], 30)
        self.assertEqual(body["preferences"]["requested_concurrency"], 1)
        self.assertTrue(body["preferences"]["auto_configured"])
        self.assertNotIn("path", str(body).lower())

    def test_runtime_payload_overrides_client_resource_controls(self):
        social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="immediate_close",
                review_hold_seconds=30,
                manual_timeout_seconds=900,
                requested_concurrency=2,
                text_input_mode="paste",
            ),
            auto_configured=True,
        )
        task = {
            "id": "task-1",
            "user_id": 1,
            "task_type": "browse_feed",
            "payload": {
                "retain_live_browser_after_finish": True,
                "live_browser_standby_seconds": 999,
                "live_browser_auto_close_seconds": 999,
                "manual_login_timeout_seconds": 1800,
                "text_input_mode": "type",
            },
        }

        payload = social_automation_api._runtime_task_payload(task, {"id": "account-1", "user_id": 1})

        self.assertFalse(payload["retain_live_browser_after_finish"])
        self.assertEqual(payload["live_browser_standby_seconds"], 0)
        self.assertEqual(payload["live_browser_auto_close_seconds"], 10)
        self.assertEqual(payload["manual_login_timeout_seconds"], 900)
        self.assertEqual(payload["text_input_mode"], "type")

    def test_runtime_preferences_reach_browser_cleanup_control(self):
        social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="review_hold",
                review_hold_seconds=120,
                standby_seconds=60,
                auto_close_seconds=300,
                manual_timeout_seconds=600,
                requested_concurrency=2,
                text_input_mode="paste",
            ),
            auto_configured=False,
        )
        client_task = {
            "id": "task-control",
            "user_id": 1,
            "task_type": "browse_feed",
            "payload": {
                "retain_live_browser_after_finish": False,
                "live_browser_auto_close_seconds": 999,
            },
        }
        control = {"task": dict(client_task)}

        runtime_task = social_automation_api._apply_runtime_task_preferences(
            client_task,
            {"id": "account-1", "user_id": 1},
            control,
        )

        self.assertTrue(runtime_task["payload"]["retain_live_browser_after_finish"])
        self.assertEqual(runtime_task["payload"]["live_browser_standby_seconds"], 60)
        self.assertEqual(runtime_task["payload"]["live_browser_auto_close_seconds"], 300)
        self.assertEqual(control["task"]["payload"], runtime_task["payload"])

    def test_browser_settings_schema_contains_user_timing_columns(self):
        with db_module.db() as conn:
            columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(user_browser_settings)").fetchall()
            }

        self.assertIn("standby_seconds", columns)
        self.assertIn("auto_close_seconds", columns)

    def test_legacy_save_preserves_new_timing_preferences(self):
        social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="review_hold",
                standby_seconds=300,
                auto_close_seconds=1800,
            ),
            auto_configured=False,
        )

        saved = social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="review_hold",
                review_hold_seconds=60,
                manual_timeout_seconds=600,
                requested_concurrency=1,
                text_input_mode="paste",
            ),
            auto_configured=False,
        )

        self.assertEqual(saved["standby_seconds"], 300)
        self.assertEqual(saved["auto_close_seconds"], 1800)
        self.assertEqual(saved["text_input_mode"], "type")

    def test_legacy_schema_migrates_review_hold_to_auto_close(self):
        current_path = os.environ["APP_DB_PATH"]
        legacy_path = str(Path(self.temp_dir.name) / "legacy-browser-settings.db")
        with sqlite3.connect(legacy_path) as conn:
            conn.execute(
                """
                CREATE TABLE user_browser_settings (
                  user_id INTEGER PRIMARY KEY,
                  completion_policy TEXT NOT NULL,
                  review_hold_seconds INTEGER NOT NULL,
                  manual_timeout_seconds INTEGER NOT NULL,
                  requested_concurrency INTEGER NOT NULL,
                  text_input_mode TEXT NOT NULL,
                  auto_configured INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "INSERT INTO user_browser_settings VALUES (1, 'review_hold', 120, 900, 1, 'paste', 0, 100)"
            )
        try:
            os.environ["APP_DB_PATH"] = legacy_path
            db_module.init_db()
            with db_module.db() as conn:
                row = conn.execute(
                    "SELECT standby_seconds, auto_close_seconds FROM user_browser_settings WHERE user_id = 1"
                ).fetchone()
        finally:
            os.environ["APP_DB_PATH"] = current_path

        self.assertEqual(int(row["standby_seconds"]), 0)
        self.assertEqual(int(row["auto_close_seconds"]), 120)


if __name__ == "__main__":
    unittest.main()
