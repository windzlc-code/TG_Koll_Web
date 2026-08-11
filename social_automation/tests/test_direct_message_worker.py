import tempfile
import unittest
from pathlib import Path
from unittest import mock

from social_automation import runner


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class DirectMessageWorkerTests(unittest.TestCase):
    def test_recipient_is_derived_from_supported_profile_targets(self):
        self.assertEqual(
            runner._direct_message_recipient(
                {"target_url": "https://www.instagram.com/lead.name/"}
            ),
            "lead.name",
        )
        self.assertEqual(
            runner._direct_message_recipient(
                {"target_url": "https://www.threads.net/@lead_name"}
            ),
            "lead_name",
        )
        self.assertEqual(
            runner._direct_message_recipient({"target_url": "threads:lead_1"}),
            "lead_1",
        )
        with self.assertRaises(ValueError):
            runner._direct_message_recipient({"target_url": "https://example.test/not/a/profile"})

    def test_confirmed_message_runs_submit_inside_durable_guard(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/direct/t/123/"
        events: list[str] = []
        control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }
        evidence = {
            "message_visible": True,
            "delivered": True,
            "read": False,
            "attachment_visible": False,
            "recipient_visible": True,
            "outgoing_hint": True,
            "status_text": "Delivered",
        }

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(
                runner,
                "_open_direct_message_conversation",
                return_value={"opened": True, "recipient_verified": True, "method": "profile"},
            ),
            mock.patch.object(runner, "_fill_direct_message_composer", return_value=True),
            mock.patch.object(
                runner,
                "_click_text_button",
                side_effect=lambda *_args, **_kwargs: events.append("submit") or True,
            ),
            mock.patch.object(runner, "_wait_interruptibly", return_value=True),
            mock.patch.object(runner, "_direct_message_conversation_evidence", return_value=evidence),
            mock.patch.object(runner, "_screenshot", return_value="dm-confirmed.png"),
        ):
            result = runner._run_direct_message(
                page,
                {"id": "dm-task"},
                {"username": "sender"},
                {"recipient_username": "lead", "content": "hello lead"},
                Path(tmp),
                _Logger(),
                platform="instagram",
                context_control=control,
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["verified"])
        self.assertEqual(result["recipient_username"], "lead")
        self.assertEqual(result["screenshot_path"], "dm-confirmed.png")
        self.assertEqual(events, ["guard", "submit"])

    def test_unconfirmed_submission_is_unknown_and_never_reported_success(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/messages/123"
        control = {"billing_submit_callback": lambda action: action()}

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(
                runner,
                "_open_direct_message_conversation",
                return_value={"opened": True, "recipient_verified": True, "method": "profile"},
            ),
            mock.patch.object(runner, "_fill_direct_message_composer", return_value=True),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner, "_wait_interruptibly", return_value=True),
            mock.patch.object(
                runner,
                "_direct_message_conversation_evidence",
                return_value={"message_visible": False},
            ) as inspect_evidence,
            mock.patch.object(runner, "_screenshot", return_value="dm-unknown.png"),
        ):
            with self.assertRaises(runner.ActionOutcomeUnknownError) as raised:
                runner._run_direct_message(
                    page,
                    {"id": "dm-unknown"},
                    {"username": "sender"},
                    {"recipient_username": "lead", "content": "message requiring evidence"},
                    Path(tmp),
                    _Logger(),
                    platform="threads",
                    context_control=control,
                )

        self.assertTrue(raised.exception.action_submitted)
        self.assertTrue(raised.exception.action_outcome_unknown)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(raised.exception.screenshot_path, "dm-unknown.png")
        self.assertEqual(inspect_evidence.call_count, 8)

    def test_pre_submission_failure_does_not_enter_billing_guard(self):
        page = mock.Mock()
        events: list[str] = []
        control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }
        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(
                runner,
                "_open_direct_message_conversation",
                return_value={"opened": False, "recipient_verified": False},
            ),
            mock.patch.object(runner, "_screenshot", return_value="recipient-missing.png"),
        ):
            result = runner._run_direct_message(
                page,
                {"id": "dm-missing"},
                {"username": "sender"},
                {"recipient_username": "lead", "content": "hello missing lead"},
                Path(tmp),
                _Logger(),
                platform="instagram",
                context_control=control,
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "recipient_unavailable")
        self.assertEqual(events, [])

    def test_composer_failure_carries_verified_sender_rotation_evidence(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/messages/123"
        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(runner, "_direct_message_logged_in_username", return_value="sender"),
            mock.patch.object(
                runner,
                "_open_direct_message_conversation",
                return_value={"opened": True, "recipient_verified": True},
            ),
            mock.patch.object(runner, "_fill_direct_message_composer", return_value=False),
            mock.patch.object(runner, "_screenshot", return_value="composer-missing.png"),
        ):
            result = runner._run_direct_message(
                page,
                {"id": "dm-composer"},
                {"username": "sender"},
                {"recipient_username": "lead", "content": "hello missing composer"},
                Path(tmp),
                _Logger(),
                platform="threads",
                context_control={"billing_submit_callback": lambda action: action()},
            )

        self.assertFalse(result["ok"])
        self.assertFalse(result["sent"])
        self.assertEqual(result["status"], "composer_unavailable")
        self.assertEqual(result["logged_in_username"], "sender")
        self.assertEqual(result["inspected_url"], "https://www.threads.net/messages/123")

    def test_attachment_must_exist_before_irreversible_submission(self):
        page = mock.Mock()
        events: list[str] = []
        control = {
            "billing_submit_callback": lambda action: (
                events.append("guard"),
                action(),
            )[1]
        }
        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(
                runner,
                "_open_direct_message_conversation",
                return_value={"opened": True, "recipient_verified": True},
            ),
            mock.patch.object(runner, "_attach_direct_message_media", return_value=False),
            mock.patch.object(runner, "_screenshot", return_value="media-missing.png"),
            self.assertRaises(RuntimeError),
        ):
            runner._run_direct_message(
                page,
                {"id": "dm-media"},
                {"username": "sender"},
                {
                    "recipient_username": "lead",
                    "content": "hello with image",
                    "media_paths": [str(Path(tmp) / "image.png")],
                },
                Path(tmp),
                _Logger(),
                platform="instagram",
                context_control=control,
            )
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
