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
            "browse_limit": 3,
            "like_limit": 1,
            "max_comments": 1,
            "comment_chance": 100,
            "require_persona_relevance": False,
            "reply_templates": ["测试评论"],
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_dismiss_instagram_interstitials", return_value=False),
            mock.patch.object(runner, "_click_some_instagram_likes", return_value=1),
            mock.patch.object(runner, "_post_instagram_warmup_comment", return_value=True),
            mock.patch.object(
                runner,
                "_current_warmup_post_context",
                return_value={"text": "理发技巧", "root": None},
            ),
            mock.patch.object(runner, "_pick_warmup_persona_reply", return_value="理发这个细节很实用。"),
            mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="/tmp/warmup.png"),
            mock.patch.object(runner.random, "random", return_value=0),
            mock.patch.object(runner.random, "randint", return_value=1),
            mock.patch.object(runner.time, "monotonic", return_value=0),
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
        self.assertEqual(result["scrolled"], 3)
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

    def test_warmup_persona_reply_requires_a_relevant_current_post(self):
        payload = {
            "persona_name": "理发师",
            "persona_style": "接地气，爱开玩笑，吐槽式幽默",
            "persona_topics": ["理发", "手工", "职场趣事"],
            "require_persona_relevance": True,
        }

        self.assertEqual(
            runner._pick_warmup_persona_reply(payload, "今天的棒球比赛进入延长赛"),
            "",
        )
        with mock.patch.object(
            runner,
            "_generate_persona_reply_with_ai",
            return_value="AI persona reply",
        ):
            reply = runner._pick_warmup_persona_reply(
                payload,
                "这家理发店剪短发的细节处理得很自然",
            )
        self.assertEqual(reply, "AI persona reply")

    def test_warmup_persona_reply_rejects_test_templates(self):
        payload = {
            "persona_name": "理发师",
            "persona_style": "接地气",
            "persona_topics": ["理发"],
            "reply_templates": ["图文发布闭环测试（系统测试，请忽略）"],
            "require_persona_relevance": True,
        }

        with mock.patch.object(
            runner,
            "_generate_persona_reply_with_ai",
            return_value="",
        ) as generate:
            reply = runner._pick_warmup_persona_reply(payload, "分享一个理发技巧")

        self.assertEqual(reply, "")
        generate.assert_called_once()

    def test_ai_reply_retries_each_configured_model_without_local_fallback(self):
        first_failure = {"ok": False, "error": "temporary upstream error"}
        second_success = {"ok": True, "raw_text": "model generated reply"}
        runtime = {
            "llm_base_url": "https://model.example/v1",
            "llm_api_key": "secret",
            "llm_model_priority_order": "model-a, model-b",
        }

        with (
            mock.patch(
                "runtime_config_bootstrap.load_runtime_config",
                return_value=runtime,
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                side_effect=[first_failure, second_success],
            ) as request,
        ):
            reply = runner._generate_persona_reply_with_ai(
                {
                    "persona_name": "理发师",
                    "persona_topics": ["理发"],
                },
                "分享一个理发技巧",
                limit=120,
            )

        self.assertEqual(reply, "model generated reply")
        self.assertEqual(request.call_count, 2)
        self.assertEqual(
            [call.kwargs["model"] for call in request.call_args_list],
            ["model-a", "model-b"],
        )
        self.assertTrue(
            all(call.kwargs["retry_count"] == 1 for call in request.call_args_list),
        )

    def test_ai_reply_retries_non_connection_failures_on_the_same_model(self):
        runtime = {
            "llm_base_url": "https://model.example/v1",
            "llm_api_key": "secret",
            "llm_model_priority_order": "model-a",
        }
        responses = [
            {"ok": False, "error": "http error"},
            {"ok": True, "raw_text": ""},
            {"ok": True, "raw_text": "third attempt reply"},
        ]

        with (
            mock.patch(
                "runtime_config_bootstrap.load_runtime_config",
                return_value=runtime,
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                side_effect=responses,
            ) as request,
        ):
            reply = runner._generate_persona_reply_with_ai(
                {"persona_name": "理发师", "ai_retry_count": 3},
                "分享一个理发技巧",
                limit=120,
            )

        self.assertEqual(reply, "third attempt reply")
        self.assertEqual(request.call_count, 3)
        self.assertTrue(
            all(call.kwargs["model"] == "model-a" for call in request.call_args_list),
        )

    def test_ai_reply_retries_low_quality_and_duplicate_outputs(self):
        runtime = {
            "llm_base_url": "https://model.example/v1",
            "llm_api_key": "secret",
            "llm_model_priority_order": "model-a",
        }
        responses = [
            {"ok": True, "raw_text": "不错"},
            {"ok": True, "raw_text": "这个层次处理得很自然，回家也比较好打理。"},
            {"ok": True, "raw_text": "发尾保留一点重量，日常整理会轻松很多。"},
        ]

        with (
            mock.patch(
                "runtime_config_bootstrap.load_runtime_config",
                return_value=runtime,
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                side_effect=responses,
            ) as request,
        ):
            reply = runner._generate_persona_reply_with_ai(
                {
                    "persona_name": "理发师",
                    "ai_retry_count": 3,
                },
                "分享一个短发层次处理技巧",
                limit=120,
                previous_replies=["这个层次处理得很自然，回家也比较好打理。"],
            )

        self.assertEqual(reply, "发尾保留一点重量，日常整理会轻松很多。")
        self.assertEqual(request.call_count, 3)

    def test_ai_reply_returns_empty_when_every_generated_output_is_invalid(self):
        runtime = {
            "llm_base_url": "https://model.example/v1",
            "llm_api_key": "secret",
            "llm_model_priority_order": "model-a",
        }

        with (
            mock.patch(
                "runtime_config_bootstrap.load_runtime_config",
                return_value=runtime,
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                side_effect=[
                    {"ok": True, "raw_text": "支持"},
                    {"ok": True, "raw_text": "https://spam.example"},
                ],
            ) as request,
        ):
            reply = runner._generate_persona_reply_with_ai(
                {
                    "persona_name": "理发师",
                    "ai_retry_count": 2,
                },
                "分享一个短发层次处理技巧",
                limit=120,
            )

        self.assertEqual(reply, "")
        self.assertEqual(request.call_count, 2)

    def test_both_warmup_runners_limit_each_like_attempt_to_one(self):
        runner_source = Path(runner.__file__).read_text(encoding="utf-8")

        self.assertIn(
            "_click_some_instagram_likes(page, logger, 1)",
            runner_source,
        )
        self.assertIn(
            "_click_some_threads_likes(page, logger, 1)",
            runner_source,
        )

    def test_default_warmup_timeline_matches_the_legacy_tg_bot_window(self):
        with mock.patch.object(runner.random, "uniform", return_value=8.5):
            self.assertEqual(runner._warmup_session_seconds({}), 8 * 60 + 30)
            self.assertEqual(runner._warmup_session_seconds({"session_minutes": "7-10"}), 8 * 60 + 30)
        runner_source = Path(runner.__file__).read_text(encoding="utf-8")
        self.assertEqual(
            runner_source.count(
                "_wait_for_cancellation(random.uniform(20.0, 45.0), cancel_event)"
            ),
            1,
        )
        self.assertIn("def _run_platform_warmup(", runner_source)
