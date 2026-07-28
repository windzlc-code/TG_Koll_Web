from pathlib import Path
from unittest import TestCase, mock

from social_automation import runner


class _Page:
    url = "https://www.instagram.com/"


class _LocatorPage:
    def __init__(self):
        self.selectors = []

    def locator(self, selector):
        self.selectors.append(selector)
        return selector


class _Logger:
    def __init__(self):
        self.rows = []

    def log(self, level, stage, message, data=None, screenshot_path=""):
        self.rows.append((level, stage, message, data or {}, screenshot_path))


class InstagramWarmupTests(TestCase):
    def test_instagram_warmup_is_a_supported_platform_specific_task(self):
        self.assertIn("instagram_warmup", runner.SUPPORTED_TASK_TYPES)

    def test_instagram_actions_target_the_interactive_wrapper(self):
        page = _LocatorPage()

        runner._instagram_action_locators(page, "Like")

        self.assertTrue(page.selectors)
        self.assertTrue(all("button" in selector or 'role="button"' in selector for selector in page.selectors))
        self.assertFalse(any(selector == '[aria-label="Like"]' for selector in page.selectors))

    def test_instagram_warmup_checkpoints_always_capture_a_result(self):
        self.assertTrue(runner._should_capture_screenshot("instagram_warmup"))
        self.assertTrue(runner._should_capture_screenshot("instagram_warmup_comment_1"))

    def test_comment_is_confirmed_only_after_new_visible_text_echo(self):
        page = mock.Mock()
        group = mock.Mock()
        target = mock.Mock()
        group.count.side_effect = [0, 1]
        group.last = target
        target.is_visible.return_value = True
        page.get_by_text.return_value = group
        with (
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 0.5]),
            mock.patch.object(runner.time, "sleep"),
        ):
            confirmed = runner._wait_for_instagram_comment_echo(page, "测试评论", 0)

        self.assertTrue(confirmed)
        target.scroll_into_view_if_needed.assert_called_once()

    def test_warmup_closes_browse_like_and_comment_strategy(self):
        logger = _Logger()
        payload = {
            "strategy_id": "like_comment",
            "strategy_label": "互动养号：点赞 + 留言",
            "session_seconds": 15,
            "browse_limit": 2,
            "like_limit": 1,
            "max_comments": 1,
            "comment_chance": 100,
            "reply_templates": ["测试评论"],
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_dismiss_instagram_interstitials", return_value=False),
            mock.patch.object(runner, "_click_some_instagram_likes", return_value=1),
            mock.patch.object(runner, "_post_instagram_warmup_comment", return_value=True),
            mock.patch.object(runner, "_pick_persona_reply", return_value="测试评论"),
            mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="/tmp/warmup.png"),
            mock.patch.object(runner.random, "random", return_value=0),
            mock.patch.object(runner.random, "randint", return_value=1),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 8, 8, 8, 8, 16]),
        ):
            result = runner._run_instagram_warmup(
                _Page(),
                {"id": "task-1"},
                payload,
                Path("/tmp"),
                logger,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["liked"], 1)
        self.assertEqual(result["commented"], 1)
        self.assertEqual(result["scrolled"], 2)
        self.assertTrue(any(stage == "completion_node" for _, stage, *_ in logger.rows))

    def test_required_like_target_prevents_false_success(self):
        logger = _Logger()
        payload = {
            "session_seconds": 15,
            "browse_limit": 1,
            "like_limit": 1,
            "min_required_likes": 1,
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_dismiss_instagram_interstitials", return_value=False),
            mock.patch.object(runner, "_click_some_instagram_likes", return_value=0),
            mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="/tmp/warmup.png"),
            mock.patch.object(runner.random, "random", return_value=0),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 8, 16]),
        ):
            with self.assertRaisesRegex(RuntimeError, "最低点赞目标"):
                runner._run_instagram_warmup(
                    _Page(),
                    {"id": "task-2"},
                    payload,
                    Path("/tmp"),
                    logger,
                )
