import threading
from pathlib import Path
from unittest import TestCase, mock

from social_automation import runner


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class _Page:
    url = "https://www.threads.net/"


class ThreadsAutoReplyTests(TestCase):
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
                        {"id": f"{platform}-reply"},
                        {},
                        Path("/tmp"),
                        _Logger(),
                        account={"username": "owner"},
                    )

        self.assertEqual(
            [call.kwargs["platform"] for call in execute.call_args_list],
            ["threads", "instagram"],
        )

    def test_owned_post_discovery_uses_profile_and_rejects_external_targets(self):
        page = _Page()
        account = {"username": "owner"}
        payload = {
            "target_urls": [
                "https://www.threads.net/@owner/post/owned",
                "https://www.threads.net/@stranger/post/external",
            ],
        }
        logger = _Logger()
        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(
                runner,
                "_find_threads_post_permalinks",
                return_value=[
                    "https://www.threads.net/@owner/post/owned",
                    "https://www.threads.net/@stranger/post/external",
                ],
            ),
        ):
            targets = runner._discover_owned_post_targets(
                page,
                "threads",
                account,
                payload,
                logger,
                limit=5,
            )

        goto.assert_called_once_with(
            page,
            "https://www.threads.net/@owner",
            logger,
            "threads_owned_posts",
        )
        self.assertEqual(
            targets,
            ["https://www.threads.net/@owner/post/owned"],
        )

    def test_comment_reply_discovers_owned_posts_before_processing(self):
        payload = {
            "target_urls": ["https://www.threads.net/@owner/post/stale"],
            "reply_scope": "comments",
        }
        with (
            mock.patch.object(
                runner,
                "_discover_owned_post_targets",
                return_value=[],
            ) as discover,
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_threads_auto_reply(
                _Page(),
                {"id": "task-live-owned"},
                payload,
                Path("/tmp"),
                _Logger(),
                account={"username": "owner"},
            )

        discover.assert_called_once()
        self.assertTrue(result["noTarget"])
        self.assertEqual(result["completionReason"], "no_owned_post_targets")

    def test_comment_reply_stops_before_work_when_cancelled(self):
        cancel_event = threading.Event()
        cancel_event.set()

        with self.assertRaisesRegex(RuntimeError, "取消"):
            runner._run_threads_auto_reply(
                _Page(),
                {"id": "task-cancelled"},
                {
                    "target_urls": [
                        "https://www.threads.net/@owner/post/example",
                    ],
                    "reply_scope": "comments",
                },
                Path("/tmp"),
                _Logger(),
                cancel_event=cancel_event,
            )

    def test_comment_target_key_is_stable_and_account_scoped(self):
        first = runner._social_comment_target_key(
            "threads",
            "https://www.threads.net/@owner/post/example",
            "Visitor",
            "  How do I style this? ",
        )
        repeated = runner._social_comment_target_key(
            "threads",
            "https://www.threads.net/@owner/post/example?x=1",
            "@visitor",
            "How   do I style this?",
        )
        other_platform = runner._social_comment_target_key(
            "instagram",
            "https://www.threads.net/@owner/post/example",
            "visitor",
            "How do I style this?",
        )

        self.assertEqual(first, repeated)
        self.assertNotEqual(first, other_platform)

    def test_already_replied_comment_is_skipped_before_model_generation(self):
        url = "https://www.threads.net/@owner/post/example"
        comment = "How do I style this?"
        target_key = runner._social_comment_target_key(
            "threads",
            url,
            "visitor",
            comment,
        )
        payload = {
            "target_urls": [url],
            "reply_scope": "comments",
            "replied_comment_keys": [target_key],
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_post_text", return_value="target post"),
            mock.patch.object(
                runner,
                "_threads_comment_candidates",
                return_value=[{"text": comment, "author": "visitor"}],
            ),
            mock.patch.object(runner, "_is_replyable_social_comment", return_value=True),
            mock.patch.object(runner, "_pick_persona_reply") as generate,
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_threads_auto_reply(
                _Page(),
                {"id": "task-dedup"},
                payload,
                Path("/tmp"),
                _Logger(),
            )

        generate.assert_not_called()
        self.assertEqual(result["replied"], 0)
        self.assertEqual(result["completionReason"], "no_replyable_comments")

    def test_recent_comment_text_is_skipped_after_post_url_changes(self):
        url = "https://www.threads.net/@owner/post/new-url"
        comment = "How do I style this?"
        payload = {
            "target_urls": [url],
            "reply_scope": "comments",
            "replied_comment_history": [
                {
                    "author": "visitor",
                    "comment": comment,
                },
            ],
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_post_text", return_value="target post"),
            mock.patch.object(
                runner,
                "_threads_comment_candidates",
                return_value=[{"text": comment, "author": "visitor"}],
            ),
            mock.patch.object(runner, "_is_replyable_social_comment", return_value=True),
            mock.patch.object(runner, "_pick_persona_reply") as generate,
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_threads_auto_reply(
                _Page(),
                {"id": "task-history-dedup"},
                payload,
                Path("/tmp"),
                _Logger(),
            )

        generate.assert_not_called()
        self.assertEqual(result["replied"], 0)
        self.assertEqual(result["completionReason"], "no_replyable_comments")

    def test_hot_reply_with_a_real_target_and_missing_button_is_not_success(self):
        payload = {
            "target_urls": ["https://www.threads.net/@owner/post/example"],
            "reply_scope": "hot_posts",
            "reply_text": "reply",
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_post_text", return_value="target post"),
            mock.patch.object(runner, "_threads_reply_button", return_value=None),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_threads_hot_post_auto_reply(
                _Page(),
                {"id": "task-hot-missing-button"},
                payload,
                Path("/tmp"),
                _Logger(),
            )

        self.assertFalse(result["ok"])
        self.assertFalse(result["noTarget"])
        self.assertEqual(result["replied"], 0)

    def test_hot_reply_model_failure_is_not_reported_as_no_target_success(self):
        payload = {
            "target_urls": ["https://www.threads.net/@owner/post/example"],
            "reply_scope": "hot_posts",
            "persona_topics": ["hair"],
            "require_persona_relevance": True,
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(
                runner,
                "_threads_primary_post_context",
                return_value={"text": "hair care details", "root": None},
            ),
            mock.patch.object(runner, "_threads_reply_button", return_value=mock.Mock()),
            mock.patch.object(runner, "_generate_persona_reply_with_ai", return_value=""),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_threads_hot_post_auto_reply(
                _Page(),
                {"id": "task-hot-generation-failed"},
                payload,
                Path("/tmp"),
                _Logger(),
            )

        self.assertFalse(result["ok"])
        self.assertFalse(result["noTarget"])
        self.assertEqual(result["completionReason"], "reply_generation_failed")

    def test_persona_relevance_blocks_unrelated_generic_reply(self):
        payload = {
            "persona_topics": ["理发"],
            "persona_context": "分享理发技巧。",
            "require_persona_relevance": True,
        }

        self.assertEqual(runner._pick_persona_reply(payload, "完全无关的天气内容"), "")

    def test_reply_echo_uses_published_content_count(self):
        with (
            mock.patch.object(runner, "_threads_published_reply_count", side_effect=[0, 1]),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 0.5]),
            mock.patch.object(runner.time, "sleep"),
        ):
            confirmed = runner._wait_for_threads_reply_echo(
                mock.Mock(),
                "reply text",
                0,
            )

        self.assertTrue(confirmed)

    def test_comment_filter_rejects_spam_abuse_emoji_and_self_comments(self):
        payload = {
            "threads_handle": "owner",
            "persona_topics": ["理发", "发型"],
            "persona_context": "分享理发店日常和发型技巧。",
        }
        post_text = "今天分享一个短发造型技巧"

        self.assertFalse(runner._is_replyable_social_comment("🔥🔥🔥", "visitor", payload, post_text))
        self.assertFalse(runner._is_replyable_social_comment("加微信领取赚钱教程", "visitor", payload, post_text))
        self.assertFalse(runner._is_replyable_social_comment("垃圾骗子", "visitor", payload, post_text))
        self.assertFalse(runner._is_replyable_social_comment("这个短发怎么打理？", "owner", payload, post_text))
        self.assertTrue(runner._is_replyable_social_comment("这个短发回家后怎么打理？", "visitor", payload, post_text))

    def test_hot_reply_without_targets_is_a_no_target_completion(self):
        with mock.patch.object(runner, "_screenshot", return_value=""):
            result = runner._run_threads_hot_post_auto_reply(
                _Page(),
                {"id": "task-hot"},
                {"target_urls": [], "reply_scope": "hot_posts"},
                Path("/tmp"),
                _Logger(),
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["noTarget"])
        self.assertEqual(result["completionReason"], "no_hot_post_targets")

    def test_comment_reply_never_falls_back_to_the_public_feed(self):
        with (
            mock.patch.object(runner, "_screenshot", return_value=""),
            mock.patch.object(runner, "_discover_owned_post_targets") as discover,
        ):
            result = runner._run_threads_auto_reply(
                _Page(),
                {"id": "task-comments"},
                {"target_urls": [], "reply_scope": "comments"},
                Path("/tmp"),
                _Logger(),
                account={"username": "owner"},
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["noTarget"])
        self.assertEqual(result["completionReason"], "no_owned_post_targets")
        discover.assert_not_called()

    def test_reply_echo_is_required_before_counting_success(self):
        source = Path(runner.__file__).read_text(encoding="utf-8")

        self.assertIn("_wait_for_threads_reply_echo", source)
        self.assertIn("_threads_comment_candidates", source)
        self.assertNotIn('_goto(page, THREADS_HOME, logger, "threads_auto_reply_open")', source)

    def test_ai_failure_does_not_use_a_local_fallback_reply(self):
        payload = {
            "persona_topics": ["hair"],
            "persona_style": "professional",
            "require_persona_relevance": True,
            "reply_templates": ["fixed fallback reply"],
        }
        with mock.patch.object(
            runner,
            "_generate_persona_reply_with_ai",
            return_value="",
        ) as generate:
            reply = runner._pick_persona_reply(payload, "hair care details")

        self.assertEqual(reply, "")
        generate.assert_called_once()

    def test_missing_comment_button_keeps_operational_failure_reason(self):
        payload = {
            "target_urls": ["https://www.threads.net/@owner/post/example"],
            "reply_scope": "comments",
            "reply_text": "reply",
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_post_text", return_value="target post"),
            mock.patch.object(
                runner,
                "_threads_comment_candidates",
                return_value=[{"text": "question", "author": "visitor"}],
            ),
            mock.patch.object(runner, "_is_replyable_social_comment", return_value=True),
            mock.patch.object(runner, "_threads_comment_reply_button", return_value=None),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_threads_auto_reply(
                _Page(),
                {"id": "task-comment-missing-button"},
                payload,
                Path("/tmp"),
                _Logger(),
            )

        self.assertFalse(result["ok"])
        self.assertFalse(result["noTarget"])
        self.assertEqual(result["completionReason"], "reply_target_missing")
