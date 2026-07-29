import tempfile
import threading
from pathlib import Path
from unittest import TestCase, mock

from social_automation import runner


class _Page:
    url = "https://www.threads.net/"


class _Logger:
    def log(self, _level, _stage, _message, _data=None, _screenshot_path=""):
        return None


class WarmupChainParityTests(TestCase):
    def test_threads_browse_feed_does_not_start_the_full_warmup_chain(self):
        with (
            mock.patch.object(
                runner,
                "_run_browse_feed",
                return_value={"ok": True},
            ) as browse,
            mock.patch.object(runner, "_run_threads_warmup") as warmup,
        ):
            result = runner._dispatch_browse_feed(
                _Page(),
                {"id": "threads-browse"},
                {},
                Path("."),
                _Logger(),
                platform="threads",
            )

        self.assertTrue(result["ok"])
        browse.assert_called_once()
        warmup.assert_not_called()

    def test_both_platform_wrappers_use_the_shared_warmup_executor(self):
        with mock.patch.object(
            runner,
            "_run_platform_warmup",
            return_value={"ok": True},
        ) as execute:
            for platform, run in (
                ("threads", runner._run_threads_warmup),
                ("instagram", runner._run_instagram_warmup),
            ):
                with self.subTest(platform=platform):
                    run(
                        _Page(),
                        {"id": f"{platform}-shared"},
                        {},
                        Path("."),
                        _Logger(),
                    )

        self.assertEqual(
            [call.kwargs["platform"] for call in execute.call_args_list],
            ["threads", "instagram"],
        )

    def test_both_platform_wrappers_use_the_shared_auto_reply_executor(self):
        with mock.patch.object(
            runner,
            "_run_platform_auto_reply",
            return_value={"ok": True},
        ) as execute:
            for platform, run in (
                ("threads", runner._run_threads_auto_reply),
                ("instagram", runner._run_instagram_auto_reply),
            ):
                with self.subTest(platform=platform):
                    run(
                        _Page(),
                        {"id": f"{platform}-reply-shared"},
                        {},
                        Path("."),
                        _Logger(),
                    )

        self.assertEqual(
            [call.kwargs["platform"] for call in execute.call_args_list],
            ["threads", "instagram"],
        )

    def test_minimum_targets_must_fit_configured_capacity(self):
        with self.assertRaisesRegex(RuntimeError, "总上限"):
            runner._warmup_minimum_targets(
                {"min_required_interactions": 1},
                like_limit=0,
                max_comments=0,
            )

    def test_threads_like_is_not_counted_without_state_confirmation(self):
        button = mock.Mock()
        button.is_visible.return_value = True
        button.get_attribute.return_value = "Like"
        button.inner_text.return_value = ""
        group = mock.Mock()
        group.count.return_value = 1
        group.nth.return_value = button

        with (
            mock.patch.object(runner, "_threads_like_buttons", return_value=[group]),
            mock.patch.object(runner, "_threads_unlike_count", side_effect=[0, 0]),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_sleep_between"),
        ):
            clicked = runner._click_some_threads_likes(
                mock.Mock(),
                _Logger(),
                1,
            )

        self.assertEqual(clicked, 0)

    def test_both_platforms_stop_when_warmup_risk_is_detected(self):
        risk = {
            "status": "need_verification",
            "reason": "触发平台风控限制",
        }
        for platform in ("threads", "instagram"):
            with (
                self.subTest(platform=platform),
                mock.patch.object(runner, "_warmup_risk_state", return_value=risk),
            ):
                with self.assertRaisesRegex(runner.NeedManualError, "风控"):
                    runner._guard_warmup_risk(
                        mock.Mock(),
                        platform,
                        {"stop_on_risk_limit": True},
                        _Logger(),
                    )

    def test_banned_risk_preserves_account_health_status(self):
        risk = {
            "status": "cookie_expired",
            "health_status": "banned",
            "reason": "账号已被封禁",
        }
        with mock.patch.object(runner, "_warmup_risk_state", return_value=risk):
            with self.assertRaises(runner.NeedManualError) as context:
                runner._guard_warmup_risk(
                    mock.Mock(),
                    "instagram",
                    {"stop_on_risk_limit": True},
                    _Logger(),
                )

        self.assertEqual(context.exception.health_status, "banned")

    def test_threads_post_open_does_not_swallow_cancellation(self):
        cancel_event = threading.Event()
        link = mock.Mock()
        link.is_visible.return_value = True
        link.bounding_box.return_value = {
            "width": 100,
            "height": 40,
            "y": 120,
        }
        link.get_attribute.return_value = "/@tester/post/123"
        candidates = mock.Mock()
        candidates.count.return_value = 1
        candidates.nth.return_value = link
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        page.locator.return_value = candidates

        def cancel_after_click(*_args, **_kwargs):
            cancel_event.set()

        with (
            mock.patch.object(runner, "_human_click", side_effect=cancel_after_click),
            mock.patch.object(runner.random, "shuffle"),
        ):
            with self.assertRaisesRegex(RuntimeError, "取消"):
                runner._open_random_threads_post(
                    page,
                    _Logger(),
                    cancel_event=cancel_event,
                )

    def test_instagram_rejects_success_below_minimum_total_interactions(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 1,
            "like_limit": 1,
            "like_chance": 0,
            "max_comments": 1,
            "comment_chance": 0,
            "min_required_likes": 0,
            "min_required_comments": 0,
            "min_required_interactions": 1,
        }

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_dismiss_instagram_interstitials",
                return_value=False,
            ),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
            mock.patch.object(
                runner,
                "_slow_human_scroll",
                return_value={"delta": 320},
            ),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            with self.assertRaises(RuntimeError):
                runner._run_instagram_warmup(
                    _Page(),
                    {"id": "instagram-minimum-interactions"},
                    payload,
                    Path("."),
                    _Logger(),
                )

    def test_threads_rejects_success_below_minimum_total_interactions(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 1,
            "like_limit": 1,
            "like_chance": 0,
            "max_comments": 1,
            "comment_chance": 0,
            "min_required_likes": 0,
            "min_required_comments": 0,
            "min_required_interactions": 1,
        }

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
            mock.patch.object(
                runner,
                "_slow_human_scroll",
                return_value={"delta": 320},
            ),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            with self.assertRaises(RuntimeError):
                runner._run_threads_warmup(
                    _Page(),
                    {"id": "threads-minimum-interactions"},
                    payload,
                    Path("."),
                    _Logger(),
                )

    def test_threads_dispatch_passes_cancel_event_into_interruptible_warmup(self):
        cancel_event = threading.Event()
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context

        def cancel_after_first_scroll(_page):
            cancel_event.set()
            return {"delta": 320}

        task = {
            "id": "threads-cancel",
            "task_type": "threads_warmup",
            "platform": "threads",
            "payload": {
                "session_seconds": 15,
                "browse_limit": 2,
                "like_limit": 0,
                "max_comments": 0,
            },
        }

        with tempfile.TemporaryDirectory() as data_dir:
            with (
                mock.patch.object(
                    runner,
                    "_open_camoufox_context",
                    return_value=manager,
                ),
                mock.patch.object(runner, "_import_initial_cookies"),
                mock.patch.object(runner, "_first_page", return_value=page),
                mock.patch.object(runner, "_sync_live_browser_viewport"),
                mock.patch.object(
                    runner,
                    "_check_platform_login",
                    return_value={"status": "ready"},
                ),
                mock.patch.object(runner, "_goto"),
                mock.patch.object(
                    runner,
                    "_next_warmup_interaction_at",
                    return_value=99,
                ),
                mock.patch.object(
                    runner,
                    "_slow_human_scroll",
                    side_effect=cancel_after_first_scroll,
                ),
                mock.patch.object(runner, "_sleep_between"),
                mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
                mock.patch.object(runner.time, "monotonic", return_value=0),
            ):
                with self.assertRaisesRegex(RuntimeError, "取消"):
                    runner.run_social_task(
                        task=task,
                        account={"platform": "threads"},
                        proxy=None,
                        data_dir=data_dir,
                        logger=_Logger(),
                        cancel_event=cancel_event,
                    )
