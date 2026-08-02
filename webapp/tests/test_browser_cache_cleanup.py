import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from webapp import db as db_module
import webapp.server as server
import webapp.social_automation_api as social_api


class BrowserCacheCleanupTests(unittest.TestCase):
    def setUp(self):
        self._old_env = {
            name: os.environ.get(name)
            for name in ("APP_DB_PATH", "APP_RUNTIME_CONFIG_PATH", "WEBAPP_DATA_DIR")
        }
        self._old_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._old_data_dir = server.DATA_DIR
        self._old_cleanup_run_lock = server._BROWSER_CACHE_CLEANUP_RUN_LOCK
        self._tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self._tmpdir.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.root / "runtime_config.json")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        server.RUNTIME_CONFIG_PATH = self.root / "runtime_config.json"
        server.DATA_DIR = self.root
        server._BROWSER_CACHE_CLEANUP_RUN_LOCK = server.threading.Lock()
        db_module.init_db()
        server._ensure_default_runtime_config()

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_runtime_config_path
        server.DATA_DIR = self._old_data_dir
        server._BROWSER_CACHE_CLEANUP_RUN_LOCK = self._old_cleanup_run_lock
        for name, value in self._old_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self._tmpdir.cleanup()

    def _add_profile(self, name: str = "account-1") -> Path:
        profile = self.root / "social_automation" / "profiles" / "threads" / name
        profile.mkdir(parents=True)
        now = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir,
                  created_at, updated_at
                ) VALUES (?, 0, '', 'threads', ?, ?, ?, ?)
                """,
                (name, name, str(profile), now, now),
            )
        return profile.resolve()

    def _runtime(self):
        with db_module.db() as conn:
            return server._get_runtime_config(conn)

    def test_cleanup_removes_only_direct_cache2_and_preserves_profile_state(self):
        profile = self._add_profile()
        cache = profile / "cache2"
        cache.mkdir()
        (cache / "entries").mkdir()
        (cache / "entries" / "cache.bin").write_bytes(b"x" * 4096)
        protected = {
            "cookies.sqlite": b"cookies",
            "prefs.js": b"prefs",
            "key4.db": b"key",
        }
        for name, content in protected.items():
            (profile / name).write_bytes(content)
        storage = profile / "storage" / "default"
        storage.mkdir(parents=True)
        (storage / "state.bin").write_bytes(b"state")
        unrelated_nested_cache = profile / "snapshots" / "cache2"
        unrelated_nested_cache.mkdir(parents=True)
        (unrelated_nested_cache / "keep.bin").write_bytes(b"keep")

        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "acquire_exclusive_browser_maintenance_lease", return_value=("cleanup-lease-1", "cleanup-lease-2")
        ), mock.patch.object(server, "release_exclusive_browser_maintenance_lease") as release:
            result = server._run_browser_cache_cleanup_once(manual=True)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["deleted_count"], 1)
        self.assertGreaterEqual(result["reclaimed_bytes"], 4096)
        self.assertFalse(cache.exists())
        self.assertTrue(unrelated_nested_cache.is_dir())
        self.assertEqual((unrelated_nested_cache / "keep.bin").read_bytes(), b"keep")
        for name, content in protected.items():
            self.assertEqual((profile / name).read_bytes(), content)
        self.assertEqual((storage / "state.bin").read_bytes(), b"state")
        release.assert_called_once_with(("cleanup-lease-1", "cleanup-lease-2"))

        runtime = self._runtime()
        self.assertEqual(runtime["browser_cache_cleanup_last_status"], "success")
        self.assertEqual(runtime["browser_cache_cleanup_last_deleted_count"], 1)
        self.assertGreater(runtime["browser_cache_cleanup_last_run_at"], 0)
        self.assertEqual(
            runtime["browser_cache_cleanup_next_run_at"] - runtime["browser_cache_cleanup_last_run_at"],
            15 * 86400,
        )
        self.assertEqual(runtime["browser_cache_cleanup_last_trigger_reason"], "manual")

    def test_busy_cleanup_skips_without_advancing_success_schedule(self):
        profile = self._add_profile()
        cache = profile / "cache2"
        cache.mkdir()
        (cache / "cache.bin").write_bytes(b"cache")
        runtime = self._runtime()
        runtime.update(
            browser_cache_cleanup_last_run_at=123,
            browser_cache_cleanup_next_run_at=456,
        )
        server._write_runtime_config_file(runtime)

        with mock.patch.object(
            server,
            "_browser_cache_cleanup_busy_reason",
            return_value="active tasks: general=0, browser=1",
        ), mock.patch.object(server, "acquire_exclusive_browser_maintenance_lease") as acquire:
            result = server._run_browser_cache_cleanup_once(manual=True)

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "skipped_busy")
        self.assertTrue(cache.is_dir())
        acquire.assert_not_called()
        runtime = self._runtime()
        self.assertEqual(runtime["browser_cache_cleanup_last_run_at"], 123)
        self.assertEqual(runtime["browser_cache_cleanup_next_run_at"], 456)
        self.assertEqual(runtime["browser_cache_cleanup_last_status"], "skipped_busy")
        self.assertGreater(runtime["browser_cache_cleanup_last_attempt_at"], 0)

    def test_non_directory_cache2_is_reported_and_never_removed(self):
        profile = self._add_profile()
        cache_file = profile / "cache2"
        cache_file.write_bytes(b"not-a-cache-directory")

        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "acquire_exclusive_browser_maintenance_lease", return_value=("cleanup-lease-1", "cleanup-lease-2")
        ), mock.patch.object(server, "release_exclusive_browser_maintenance_lease"):
            result = server._run_browser_cache_cleanup_once(manual=True)

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertTrue(cache_file.is_file())
        self.assertEqual(cache_file.read_bytes(), b"not-a-cache-directory")
        runtime = self._runtime()
        self.assertEqual(runtime["browser_cache_cleanup_last_run_at"], 0)
        self.assertEqual(runtime["browser_cache_cleanup_last_status"], "error")

    def test_database_profile_outside_managed_root_is_never_removed(self):
        outside_profile = self.root / "outside-profile"
        outside_cache = outside_profile / "cache2"
        outside_cache.mkdir(parents=True)
        (outside_cache / "private.bin").write_bytes(b"private")
        now = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir,
                  created_at, updated_at
                ) VALUES ('outside', 0, '', 'threads', 'outside', ?, ?, ?)
                """,
                (str(outside_profile), now, now),
            )

        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "acquire_exclusive_browser_maintenance_lease", return_value=("cleanup-lease-1", "cleanup-lease-2")
        ), mock.patch.object(server, "release_exclusive_browser_maintenance_lease"):
            result = server._run_browser_cache_cleanup_once(manual=True)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["deleted_count"], 0)
        self.assertEqual((outside_cache / "private.bin").read_bytes(), b"private")

    def test_cache2_symlink_is_never_followed_or_removed(self):
        profile = self._add_profile()
        external_target = self.root / "external-cache-target"
        external_target.mkdir()
        (external_target / "private.bin").write_bytes(b"private")
        cache_link = profile / "cache2"
        try:
            cache_link.symlink_to(external_target, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"directory symlinks unavailable: {exc}")

        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "acquire_exclusive_browser_maintenance_lease", return_value=("cleanup-lease-1", "cleanup-lease-2")
        ), mock.patch.object(server, "release_exclusive_browser_maintenance_lease"):
            result = server._run_browser_cache_cleanup_once(manual=True)

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertTrue(cache_link.is_symlink())
        self.assertEqual((external_target / "private.bin").read_bytes(), b"private")

    def test_default_runtime_policy_is_enabled_every_fifteen_days(self):
        runtime = self._runtime()
        self.assertTrue(runtime["browser_cache_cleanup_enabled"])
        self.assertEqual(runtime["browser_cache_cleanup_interval_days"], 15)
        self.assertTrue(runtime["browser_cache_cleanup_size_trigger_enabled"])
        self.assertEqual(runtime["browser_cache_cleanup_size_threshold_mb"], 2048)
        self.assertEqual(runtime["browser_cache_cleanup_min_disk_free_mb"], 5120)
        self.assertEqual(runtime["browser_cache_cleanup_check_interval_minutes"], 15)
        self.assertEqual(runtime["browser_cache_cleanup_last_status"], "never")

    def test_capacity_check_runs_at_configured_frequency_and_records_snapshot(self):
        runtime = self._runtime()
        snapshot = {
            "total_bytes": 2048 * 1024 * 1024,
            "cache_count": 2,
            "scanned_profiles": 2,
            "disk_free_bytes": 20 * 1024 * 1024 * 1024,
        }
        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "_browser_cache_reclaimable_snapshot", return_value=snapshot
        ) as inspect:
            reason = server._browser_cache_cleanup_capacity_trigger(runtime, now=1000)

        self.assertEqual(reason, "capacity_threshold")
        inspect.assert_called_once_with()
        updated = self._runtime()
        self.assertEqual(updated["browser_cache_cleanup_last_check_at"], 1000)
        self.assertEqual(updated["browser_cache_cleanup_last_total_bytes"], snapshot["total_bytes"])
        self.assertEqual(updated["browser_cache_cleanup_last_disk_free_bytes"], snapshot["disk_free_bytes"])

        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "_browser_cache_reclaimable_snapshot"
        ) as inspect_again:
            reason = server._browser_cache_cleanup_capacity_trigger(updated, now=1899)
        self.assertEqual(reason, "")
        inspect_again.assert_not_called()

    def test_size_trigger_can_be_disabled_without_disabling_low_disk_trigger(self):
        runtime = self._runtime()
        runtime.update(
            browser_cache_cleanup_size_trigger_enabled=False,
            browser_cache_cleanup_min_disk_free_mb=5120,
        )
        snapshot = {
            "total_bytes": 3 * 1024 * 1024 * 1024,
            "cache_count": 1,
            "scanned_profiles": 1,
            "disk_free_bytes": 10 * 1024 * 1024 * 1024,
        }
        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "_browser_cache_reclaimable_snapshot", return_value=snapshot
        ):
            self.assertEqual(server._browser_cache_cleanup_capacity_trigger(runtime, now=2000), "")

        runtime = self._runtime()
        runtime.update(
            browser_cache_cleanup_size_trigger_enabled=False,
            browser_cache_cleanup_min_disk_free_mb=5120,
        )
        snapshot["disk_free_bytes"] = 1024 * 1024 * 1024
        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server, "_browser_cache_reclaimable_snapshot", return_value=snapshot
        ):
            self.assertEqual(server._browser_cache_cleanup_capacity_trigger(runtime, now=3000), "low_disk")

    def test_low_disk_trigger_requires_at_least_256_mb_reclaimable_cache(self):
        low_free = 1024 * 1024 * 1024
        cases = (
            (0, 4000, ""),
            (255 * 1024 * 1024, 5000, ""),
            (256 * 1024 * 1024, 6000, "low_disk"),
        )
        for total_bytes, checked_at, expected in cases:
            runtime = self._runtime()
            runtime.update(
                browser_cache_cleanup_size_trigger_enabled=False,
                browser_cache_cleanup_min_disk_free_mb=5120,
            )
            with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
                server,
                "_browser_cache_reclaimable_snapshot",
                return_value={
                    "total_bytes": total_bytes,
                    "cache_count": int(total_bytes > 0),
                    "scanned_profiles": 1,
                    "disk_free_bytes": low_free,
                },
            ):
                self.assertEqual(
                    server._browser_cache_cleanup_capacity_trigger(runtime, now=checked_at),
                    expected,
                )

    def test_combined_capacity_and_low_disk_reason_is_exposed(self):
        runtime = self._runtime()
        with mock.patch.object(server, "_browser_cache_cleanup_busy_reason", return_value=""), mock.patch.object(
            server,
            "_browser_cache_reclaimable_snapshot",
            return_value={
                "total_bytes": 3 * 1024 * 1024 * 1024,
                "cache_count": 3,
                "scanned_profiles": 3,
                "disk_free_bytes": 1024 * 1024 * 1024,
            },
        ):
            reason = server._browser_cache_cleanup_capacity_trigger(runtime, now=7000)
        self.assertEqual(reason, "capacity_threshold+low_disk")

    def test_capacity_check_does_not_walk_profiles_while_browser_is_busy(self):
        runtime = self._runtime()
        with mock.patch.object(
            server,
            "_browser_cache_cleanup_busy_reason",
            return_value="active tasks: general=0, browser=1",
        ), mock.patch.object(server, "_browser_cache_reclaimable_snapshot") as inspect:
            reason = server._browser_cache_cleanup_capacity_trigger(runtime, now=8000)

        self.assertEqual(reason, "")
        inspect.assert_not_called()
        self.assertEqual(self._runtime()["browser_cache_cleanup_last_check_at"], 0)

    def test_busy_capacity_trigger_remains_pending_for_lightweight_retry(self):
        runtime = self._runtime()
        runtime.update(
            browser_cache_cleanup_last_status="skipped_busy",
            browser_cache_cleanup_last_trigger_reason="capacity_threshold+low_disk",
            browser_cache_cleanup_last_check_at=8000,
        )
        self.assertEqual(
            server._browser_cache_cleanup_pending_capacity_retry(runtime),
            "capacity_threshold+low_disk",
        )
        runtime["browser_cache_cleanup_last_trigger_reason"] = "scheduled_interval"
        self.assertEqual(server._browser_cache_cleanup_pending_capacity_retry(runtime), "")
        runtime["browser_cache_cleanup_last_trigger_reason"] = "manual"
        self.assertEqual(server._browser_cache_cleanup_pending_capacity_retry(runtime), "")

        runtime.update(
            browser_cache_cleanup_last_trigger_reason="capacity_threshold+low_disk",
            browser_cache_cleanup_size_trigger_enabled=False,
        )
        self.assertEqual(server._browser_cache_cleanup_pending_capacity_retry(runtime), "low_disk")
        runtime["browser_cache_cleanup_min_disk_free_mb"] = 0
        self.assertEqual(server._browser_cache_cleanup_pending_capacity_retry(runtime), "")

    def test_exclusive_maintenance_lease_blocks_all_regular_browser_slots_and_releases(self):
        with social_api._EXTERNAL_BROWSER_LEASES_LOCK:
            original_leases = set(social_api._EXTERNAL_BROWSER_LEASES)
            social_api._EXTERNAL_BROWSER_LEASES.clear()
        try:
            with mock.patch.object(social_api, "_active_worker_thread_task_ids", return_value=set()), mock.patch.object(
                social_api, "_live_browser_sessions", return_value=[]
            ), mock.patch.object(social_api, "_social_worker_max_concurrency", return_value=2), mock.patch.object(
                social_api, "_refresh_worker_state"
            ), mock.patch.object(
                social_api, "wake_social_automation_worker"
            ), mock.patch.object(
                social_api, "_browser_worker_resource_admission", return_value={"allow_launch": True}
            ):
                leases = social_api.acquire_exclusive_browser_maintenance_lease("test-cleanup")
                self.assertEqual(len(leases), 2)
                self.assertEqual(social_api.acquire_external_browser_lease("regular-task"), "")

                social_api.release_exclusive_browser_maintenance_lease(leases)
                regular_lease = social_api.acquire_external_browser_lease("regular-task")
                self.assertTrue(regular_lease)
                social_api.release_external_browser_lease(regular_lease)
        finally:
            with social_api._EXTERNAL_BROWSER_LEASES_LOCK:
                social_api._EXTERNAL_BROWSER_LEASES.clear()
                social_api._EXTERNAL_BROWSER_LEASES.update(original_leases)


if __name__ == "__main__":
    unittest.main()
