import unittest
from pathlib import Path
from unittest import mock

from social_automation import runner


class _Keyboard:
    def __init__(self):
        self.pressed = []
        self.typed = []
        self.inserted = []

    def press(self, key):
        self.pressed.append(key)

    def type(self, value):
        self.typed.append(value)

    def insert_text(self, value):
        self.inserted.append(value)


class _Context:
    def __init__(self):
        self.permissions = []

    def grant_permissions(self, permissions, origin=None):
        self.permissions.append((permissions, origin))


class _Page:
    def __init__(self, url="https://www.threads.net/"):
        self.url = url
        self.keyboard = _Keyboard()
        self.context = _Context()
        self.evaluations = []

    def evaluate(self, script, value=None):
        self.evaluations.append((script, value))
        return None


class _Locator:
    def wait_for(self, **_kwargs):
        return None

    def evaluate(self, *_args, **_kwargs):
        return None


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class RunnerPublishSafetyTests(unittest.TestCase):
    def test_screenshot_captures_current_viewport(self):
        page = mock.Mock()

        result = runner._screenshot(page, Path("."), {"id": "login-task"}, "login_complete", _Logger())

        self.assertTrue(result.endswith(".png"))
        page.screenshot.assert_called_once()
        self.assertFalse(page.screenshot.call_args.kwargs["full_page"])

    def test_publish_task_only_captures_final_screenshot(self):
        page = mock.Mock()
        logger = _Logger()
        task = {"id": "publish-task", "task_type": "publish_post"}

        self.assertEqual(runner._screenshot(page, Path("."), task, "failed", logger), "")
        self.assertEqual(runner._screenshot(page, Path("."), task, "publish_submitted_unconfirmed", logger), "")
        result = runner._screenshot(page, Path("."), task, "publish_done", logger)

        self.assertTrue(result.endswith(".png"))
        page.screenshot.assert_called_once()
        self.assertFalse(page.screenshot.call_args.kwargs["full_page"])

    def test_threads_final_screenshot_waits_for_published_caption(self):
        page = mock.Mock()
        caption_locator = mock.Mock()
        page.get_by_text.return_value.first = caption_locator

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="final.png") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, _Logger()
            )

        self.assertEqual(result, "final.png")
        goto.assert_called_once()
        caption_locator.wait_for.assert_called_once_with(state="visible", timeout=15000)
        screenshot.assert_called_once()

    def test_threads_final_screenshot_skips_loading_page(self):
        page = mock.Mock()
        page.get_by_text.return_value.first.wait_for.side_effect = TimeoutError("still loading")

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_screenshot") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, _Logger()
            )

        self.assertEqual(result, "")
        screenshot.assert_not_called()

    def test_login_credentials_never_use_clipboard(self):
        page = _Page("https://www.instagram.com/accounts/login/")
        username_input = _Locator()
        password_input = _Locator()

        with (
            mock.patch.object(runner, "_visible_first", side_effect=[username_input, password_input]),
            mock.patch.object(runner, "_paste_text", side_effect=AssertionError("credentials reached clipboard")),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner.time, "sleep"),
            mock.patch.object(runner, "_screenshot", return_value=""),
            mock.patch.object(runner, "_click_text_button", return_value=True),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "instagram",
                {"login_username": "account@example.com", "login_password": "secret-value"},
                _Logger(),
                {"id": "login-task"},
                Path("."),
            )

        self.assertTrue(submitted)
        self.assertEqual("".join(page.keyboard.typed), "account@example.comsecret-value")
        self.assertFalse(any("navigator.clipboard" in script for script, _value in page.evaluations))

    def test_body_text_still_supports_paste_and_type_modes(self):
        paste_page = _Page()
        runner._type_text(paste_page, "post body", mode="paste")
        self.assertTrue(any("navigator.clipboard" in script for script, _value in paste_page.evaluations))
        self.assertIn("Control+V", paste_page.keyboard.pressed)

        type_page = _Page()
        with mock.patch.object(runner.time, "sleep"):
            runner._type_text(type_page, "typed body", mode="type")
        self.assertEqual("".join(type_page.keyboard.typed), "typed body")
        self.assertFalse(any("navigator.clipboard" in script for script, _value in type_page.evaluations))

    def test_threads_permalink_accepts_posts_and_rejects_profiles(self):
        permalink = "https://www.threads.net/@alice/post/ABC123?x=1#fragment"
        self.assertEqual(
            runner._normalize_threads_post_permalink(permalink),
            "https://www.threads.net/@alice/post/ABC123",
        )
        self.assertEqual(
            runner._normalize_threads_post_permalink("/@alice/thread/XYZ789"),
            "https://www.threads.net/@alice/thread/XYZ789",
        )
        self.assertEqual(runner._normalize_threads_post_permalink("https://www.threads.net/@alice"), "")
        self.assertEqual(runner._normalize_threads_post_permalink("https://www.threads.net/"), "")
        self.assertEqual(runner._normalize_threads_post_permalink("https://example.com/@alice/post/ABC123"), "")

        page = _Page("https://www.threads.net/@alice")
        page.evaluate = mock.Mock(return_value="/@alice/post/ABC123")
        self.assertEqual(runner._find_threads_post_permalink(page, "post body"), "https://www.threads.net/@alice/post/ABC123")
        page.evaluate.return_value = "https://www.threads.net/@alice"
        self.assertEqual(runner._find_threads_post_permalink(page, "post body"), "")

        page.evaluate.return_value = ["https://www.threads.net/@alice/post/LATEST", "https://www.threads.net/@alice/post/OLDER"]
        self.assertEqual(runner._find_latest_threads_post_permalink(page), "https://www.threads.net/@alice/post/LATEST")

    def test_threads_profile_url_prefers_logged_in_navigation_handle(self):
        page = _Page("https://www.threads.net/")
        page.evaluate = mock.Mock(return_value="https://www.threads.net/@real_handle")

        self.assertEqual(
            runner._resolve_threads_profile_url(page, {"username": "account-field-is-not-handle"}),
            "https://www.threads.net/@real_handle",
        )

    def test_threads_profile_url_falls_back_to_account_field(self):
        page = _Page("https://www.threads.net/")
        page.evaluate = mock.Mock(return_value="")

        self.assertEqual(
            runner._resolve_threads_profile_url(page, {"username": "fallback_handle"}),
            "https://www.threads.net/@fallback_handle",
        )

    def test_threads_media_only_confirmation_requires_new_permalink(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value=new_permalink),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 5},
                previous_permalink=old_permalink,
            )

        self.assertTrue(result["confirmed"])
        self.assertEqual(result["url"], new_permalink)

    def test_threads_caption_confirmation_rejects_existing_matching_permalink(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=old_permalink),
            mock.patch.object(runner.time, "time", side_effect=[0, 0, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "same post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                previous_permalink=old_permalink,
            )

        self.assertFalse(result["confirmed"])

    def test_threads_confirmation_does_not_reload_during_initial_render(self):
        page = mock.Mock(url="https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=""),
            mock.patch.object(runner.time, "time", side_effect=[0, 0, 1, 2, 9, 11, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "new post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                profile_url="https://www.threads.net/@alice",
            )

        self.assertFalse(result["confirmed"])
        page.reload.assert_not_called()

    def test_editor_closing_is_not_publish_confirmation(self):
        page = _Page("https://www.threads.net/")
        with (
            mock.patch.object(runner, "_threads_dialog_compose_box", side_effect=[_Locator(), None]),
            mock.patch.object(runner, "_threads_dialog_post_button", return_value=None),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_publish_success(page, _Logger())

        self.assertFalse(result["confirmed"])
        self.assertTrue(result["submitted"])
        self.assertEqual(result["url"], "")

    def test_threads_profile_unconfirmed_never_returns_ok(self):
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", return_value="hello threads"),
            mock.patch.object(runner, "_click_threads_active_dialog_post", return_value=True),
            mock.patch.object(
                runner,
                "_wait_for_threads_publish_success",
                return_value={"confirmed": True, "submitted": True, "url": "https://www.threads.net/"},
            ),
            mock.patch.object(
                runner,
                "_wait_for_threads_own_post",
                return_value={"confirmed": False, "url": "https://www.threads.net/@alice"},
            ),
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value="https://www.threads.net/@alice/post/OLD"),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_screenshot") as screenshot,
        ):
            with self.assertRaises(runner.NeedManualError) as raised:
                runner._run_threads_publish_post(
                    page,
                    {"id": "publish-task"},
                    {"caption": "hello threads"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                )

        self.assertEqual(raised.exception.status, "publish_submitted_unconfirmed")
        self.assertIn("停止自动重试", str(raised.exception))
        screenshot.assert_not_called()

    def test_threads_success_returns_specific_permalink(self):
        permalink = "https://www.threads.net/@alice/post/ABC123"
        resolved_profile = "https://www.threads.net/@real_handle"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", return_value="hello threads"),
            mock.patch.object(runner, "_click_threads_active_dialog_post", return_value=True),
            mock.patch.object(
                runner,
                "_wait_for_threads_publish_success",
                return_value={"confirmed": True, "submitted": True, "url": "https://www.threads.net/"},
            ),
            mock.patch.object(
                runner,
                "_wait_for_threads_own_post",
                return_value={"confirmed": True, "url": permalink, "reason": "matched caption"},
            ) as confirm_profile,
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value="https://www.threads.net/@alice/post/OLD"),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value=resolved_profile),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="done.png") as screenshot,
        ):
            result = runner._run_threads_publish_post(
                page,
                {"id": "publish-task"},
                {"caption": "hello threads"},
                Path("."),
                _Logger(),
                {"username": "alice"},
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["url"], permalink)
        self.assertEqual(result["published"]["url"], permalink)
        self.assertFalse(any(call.args[1] == resolved_profile and call.args[3] == "threads_publish_baseline" for call in goto.call_args_list))
        self.assertEqual(confirm_profile.call_args.kwargs["profile_url"], resolved_profile)
        screenshot.assert_called_once_with(page, permalink, "hello threads", Path("."), {"id": "publish-task"}, mock.ANY)


if __name__ == "__main__":
    unittest.main()
