import os
import inspect
import threading
import unittest
from unittest import mock

from social_automation import runner


class RunnerResourceManagementTests(unittest.TestCase):
    def test_pressure_levels_use_soft_and_hard_application_budgets(self):
        cases = (
            (
                {"container_memory_mb": 900, "memory_available_mb": 1800},
                "normal",
            ),
            (
                {"container_memory_mb": 1300, "memory_available_mb": 1200},
                "soft",
            ),
            (
                {"container_memory_mb": 1550, "memory_available_mb": 900},
                "hard",
            ),
            (
                {"container_memory_mb": 1200, "memory_available_mb": 430},
                "emergency",
            ),
        )
        with mock.patch.dict(
            os.environ,
            {
                "SOCIAL_AUTOMATION_BROWSER_SOFT_CONTAINER_MB": "1280",
                "SOCIAL_AUTOMATION_BROWSER_HARD_CONTAINER_MB": "1536",
                "SOCIAL_AUTOMATION_BROWSER_SOFT_AVAILABLE_MB": "1024",
                "SOCIAL_AUTOMATION_BROWSER_HARD_AVAILABLE_MB": "768",
                "SOCIAL_AUTOMATION_BROWSER_EMERGENCY_AVAILABLE_MB": "448",
            },
            clear=False,
        ):
            for snapshot, expected in cases:
                with self.subTest(snapshot=snapshot):
                    control = {"resource_snapshot_provider": lambda value=snapshot: dict(value)}
                    pressure = runner._warmup_resource_pressure(control)
                    self.assertEqual(pressure["level"], expected)

    def test_soft_pressure_compacts_in_place_without_navigation_or_new_page(self):
        control = {
            "resource_snapshot_provider": lambda: {
                "container_memory_mb": 1400,
                "memory_available_mb": 900,
            }
        }
        current_page = mock.Mock()
        payload = {}
        with (
            mock.patch.object(
                runner,
                "_compact_warmup_page_in_place",
                return_value={"paused": 2, "deferred": 2},
            ) as compact,
            mock.patch.object(runner.time, "monotonic", return_value=100.0),
        ):
            result = runner._maybe_compact_warmup_page(
                current_page,
                mock.Mock(),
                platform="threads",
                context_control=control,
                last_compaction_at=0.0,
            )

        self.assertIs(result["page"], current_page)
        self.assertEqual(result["deadline_extension_seconds"], 0)
        self.assertEqual(result["pressure"]["level"], "soft")
        self.assertNotIn("_warmup_resource_rotate_requested", payload)
        self.assertFalse(
            runner._warmup_search_rotation_due(payload, phase="browse")
        )
        compact.assert_called_once_with(current_page, pressure_level="soft")
        current_page.context.new_page.assert_not_called()
        current_page.goto.assert_not_called()
        current_page.reload.assert_not_called()

    def test_hard_pressure_compacts_visible_page_without_opening_replacement(self):
        control = {
            "resource_snapshot_provider": lambda: {
                "container_memory_mb": 1700,
                "memory_available_mb": 650,
            }
        }
        current_page = mock.Mock()
        with (
            mock.patch.object(
                runner,
                "_compact_warmup_page_in_place",
                return_value={"paused": 2, "deferred": 2},
            ) as compact,
            mock.patch.object(runner.time, "monotonic", return_value=100.0),
        ):
            result = runner._maybe_compact_warmup_page(
                current_page,
                mock.Mock(),
                platform="threads",
                context_control=control,
                last_compaction_at=0.0,
            )

        self.assertIs(result["page"], current_page)
        self.assertEqual(result["pressure"]["level"], "hard")
        compact.assert_called_once_with(current_page, pressure_level="hard")
        current_page.context.new_page.assert_not_called()

    def test_known_zero_available_memory_is_emergency_pressure(self):
        snapshots = iter(
            (
                {
                    "container_memory_mb": 900,
                    "memory_available_mb": 700,
                    "memory_available_known": 1,
                },
                {
                    "container_memory_mb": 900,
                    "memory_available_mb": 0,
                    "memory_available_known": 1,
                },
            )
        )
        control = {
            "resource_snapshot_provider": lambda: next(snapshots),
            "resource_metrics_lock": threading.RLock(),
        }
        runner._warmup_resource_pressure(control)
        pressure = runner._warmup_resource_pressure(control)

        self.assertEqual(pressure["level"], "emergency")
        self.assertEqual(
            control["_resource_metrics"]["memory_available_min_mb"],
            0,
        )
        self.assertTrue(
            control["_resource_metrics"]["memory_available_min_known"]
        )

    def test_media_guard_is_installed_before_initial_warmup_navigation(self):
        source = inspect.getsource(runner._run_platform_warmup)
        self.assertLess(
            source.index("_install_warmup_media_guard(page)"),
            source.index("_goto(page, home_url"),
        )
        self.assertIn(
            "__tgWarmupResumeWhenVisible",
            runner._WARMUP_MEDIA_GUARD_SCRIPT,
        )
        self.assertIn("media.play()", runner._WARMUP_MEDIA_GUARD_SCRIPT)
        self.assertTrue(
            runner._WARMUP_MEDIA_GUARD_SCRIPT.strip().startswith("(() => {")
        )
        self.assertTrue(
            runner._WARMUP_MEDIA_GUARD_SCRIPT.strip().endswith("})();")
        )
        self.assertGreater(
            runner._WARMUP_MEDIA_GUARD_SCRIPT.rindex(
                "window.__tgWarmupMediaGuardInstalled = true"
            ),
            runner._WARMUP_MEDIA_GUARD_SCRIPT.index(
                "new MutationObserver"
            ),
        )

    def test_hard_compaction_unloads_only_offscreen_video_buffers(self):
        page = mock.Mock()
        page.evaluate.return_value = {
            "paused": 2,
            "deferred": 2,
            "released": 2,
        }

        result = runner._compact_warmup_page_in_place(page, pressure_level="hard")

        script = page.evaluate.call_args.args[0]
        self.assertEqual(result["released"], 2)
        self.assertIn('video.removeAttribute("src")', script)
        self.assertIn("video.load()", script)
        self.assertIn("__tgWarmupReleasedMedia", script)
        self.assertIn("if (!nearViewport", script)
        self.assertNotIn("location.reload", script)
        self.assertEqual(page.evaluate.call_args.args[1], "hard")
        page.goto.assert_not_called()
        page.reload.assert_not_called()

    def test_soft_compaction_also_releases_only_far_offscreen_media(self):
        page = mock.Mock()
        page.evaluate.return_value = {
            "paused": 1,
            "deferred": 1,
            "released": 1,
        }

        result = runner._compact_warmup_page_in_place(page, pressure_level="soft")

        script, pressure_level = page.evaluate.call_args.args
        self.assertEqual(result["released"], 1)
        self.assertEqual(pressure_level, "soft")
        self.assertIn('pressureLevel === "soft"', script)
        self.assertIn("viewport * 2", script)
        page.goto.assert_not_called()
        page.reload.assert_not_called()

    def test_warmup_verifies_media_guard_after_navigation(self):
        source = inspect.getsource(runner._run_platform_warmup)
        self.assertLess(
            source.index("_goto(page, home_url"),
            source.index("_ensure_warmup_media_guard(page)"),
        )

    def test_resource_metric_reads_and_writes_share_the_configured_lock(self):
        class CountingLock:
            def __init__(self):
                self.entries = 0

            def __enter__(self):
                self.entries += 1
                return self

            def __exit__(self, *_args):
                return False

        lock = CountingLock()
        control = {
            "resource_snapshot_provider": lambda: {
                "container_memory_mb": 1400,
                "memory_available_mb": 900,
                "memory_available_known": 1,
            },
            "resource_metrics_lock": lock,
        }
        with (
            mock.patch.object(
                runner,
                "_compact_warmup_page_in_place",
                return_value={"paused": 1, "deferred": 1, "released": 0},
            ),
            mock.patch.object(runner.time, "monotonic", return_value=100.0),
        ):
            runner._maybe_compact_warmup_page(
                mock.Mock(),
                mock.Mock(),
                platform="threads",
                context_control=control,
                last_compaction_at=0.0,
            )
            runner._public_warmup_resource_metrics(control)

        self.assertGreaterEqual(lock.entries, 3)


if __name__ == "__main__":
    unittest.main()
