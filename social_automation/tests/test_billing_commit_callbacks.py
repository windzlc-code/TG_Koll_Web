import tempfile
import unittest
from pathlib import Path
from unittest import mock

from social_automation import runner


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class BillingCommitCallbackTests(unittest.TestCase):
    def test_comment_submission_runs_inside_durable_billing_guard(self):
        page = mock.MagicMock()
        page.locator.return_value.last = mock.MagicMock()
        events: list[str] = []
        context_control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_human_type"),
            mock.patch.object(
                runner,
                "_click_text_button",
                side_effect=lambda *_args, **_kwargs: events.append("submit") or True,
            ),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_comment_post(
                page,
                {"id": "comment-task"},
                {"target_url": "https://example.test/post", "comment": "hello"},
                Path(tmp),
                _Logger(),
                context_control=context_control,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(events, ["guard", "submit"])

    def test_hot_post_auto_reply_records_each_confirmed_submission(self):
        page = mock.MagicMock()
        page.url = "https://example.test/post"
        events: list[str] = []
        context_control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(
                runner,
                "_platform_primary_post_context",
                return_value={"text": "target post"},
            ),
            mock.patch.object(
                runner,
                "_platform_primary_reply_target",
                return_value=object(),
            ),
            mock.patch.object(
                runner,
                "_persona_reply_generation_applicable",
                return_value=True,
            ),
            mock.patch.object(runner, "_pick_persona_reply", return_value="reply"),
            mock.patch.object(
                runner,
                "_submit_platform_reply",
                side_effect=lambda *_args, **_kwargs: events.append("submit") or True,
            ),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_platform_hot_post_auto_reply(
                page,
                {"id": "auto-reply-task"},
                {
                    "target_urls": ["https://example.test/post"],
                    "max_posts": 1,
                    "max_replies": 1,
                },
                Path(tmp),
                _Logger(),
                platform="threads",
                context_control=context_control,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["replied"], 1)
        self.assertEqual(events, ["guard", "submit"])

    def test_share_records_commit_only_after_copy_link_succeeds(self):
        page = mock.MagicMock()
        page.url = "https://example.test/post"
        events: list[str] = []
        context_control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }

        def click_button(_page, _logger, labels, _step):
            if labels == ["Share", "Send"]:
                events.append("open_menu")
                return True
            events.append("copy_link")
            return True

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_click_text_button", side_effect=click_button),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            result = runner._run_share_post(
                page,
                {"id": "share-task"},
                {"target_url": "https://example.test/post"},
                Path(tmp),
                _Logger(),
                context_control=context_control,
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["copied_link"])
        self.assertEqual(events, ["open_menu", "guard", "copy_link"])

    def test_repost_is_rejected_before_opening_browser_or_recording_commit(self):
        events: list[str] = []
        context_control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(runner, "_open_camoufox_context") as open_browser,
            self.assertRaises(runner.UnsupportedActionError),
        ):
            runner.run_social_task(
                task={
                    "id": "repost-task",
                    "task_type": "repost_post",
                    "platform": "instagram",
                    "payload": {"target_url": "https://example.test/post"},
                },
                account={"platform": "instagram"},
                proxy=None,
                data_dir=Path(tmp),
                logger=_Logger(),
                context_control=context_control,
            )

        open_browser.assert_not_called()
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
