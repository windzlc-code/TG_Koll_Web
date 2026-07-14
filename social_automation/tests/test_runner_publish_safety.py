import unittest
import threading
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


class _LoginStateLocator:
    def __init__(self, *, text="", visible=False):
        self.text = text
        self.visible = visible

    @property
    def first(self):
        return self

    def count(self):
        return 1 if self.visible else 0

    def is_visible(self, **_kwargs):
        return self.visible

    def inner_text(self, **_kwargs):
        return self.text


class _ThreadsErrorPage:
    url = "https://www.threads.com/"

    def __init__(self):
        self.body = _LoginStateLocator(
            text="Something went wrong, please try again later. Retry",
            visible=True,
        )

    def locator(self, selector):
        if selector == "body":
            return self.body
        # The real error page still renders Threads sidebar controls.  Those
        # controls must never be enough to declare a successful login.
        return _LoginStateLocator(visible=("aria-label" in selector))


class _CookieContext:
    def __init__(self, cookies):
        self._cookies = cookies

    def cookies(self):
        return self._cookies


class _ThreadsShellPage:
    url = "https://www.threads.com/"

    def __init__(self, cookies):
        self.context = _CookieContext(cookies)
        self.body = _LoginStateLocator(text="", visible=True)

    def locator(self, selector):
        if selector == "body":
            return self.body
        return _LoginStateLocator(visible=("aria-label" in selector))


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class RunnerPublishSafetyTests(unittest.TestCase):
    def test_threads_error_page_is_not_treated_as_ready(self):
        status = runner._detect_threads_login_state(_ThreadsErrorPage())

        self.assertNotEqual(status["status"], "ready")
        self.assertEqual(status["status"], "transient_error")

    def test_threads_sidebar_without_a_session_cookie_is_not_ready(self):
        status = runner._detect_threads_login_state(_ThreadsShellPage([]))

        self.assertEqual(status["status"], "cookie_expired")

    def test_threads_authenticated_session_and_account_ui_is_ready(self):
        status = runner._detect_threads_login_state(_ThreadsShellPage([
            {"name": "sessionid", "value": "active-session", "domain": ".threads.net"},
        ]))

        self.assertEqual(status["status"], "ready")

    def test_manual_login_does_not_auto_heal_or_navigate_the_user_page(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        logger = _Logger()
        with (
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "cookie_expired", "reason": "login page"}),
            mock.patch.object(runner, "_prepare_manual_threads_login_page"),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
            mock.patch.object(runner, "_screenshot", return_value="timeout.png"),
            mock.patch.object(runner, "_wait_or_raise_manual", return_value={"status": "cookie_expired"}),
            mock.patch.object(runner.time, "time", side_effect=[0, 1, 31]),
        ):
            result = runner._run_open_login(
                page,
                {"id": "manual-login"},
                {},
                {"login_wait_seconds": 1, "wait_for_manual": True},
                Path("."),
                logger,
                "threads",
            )

        self.assertEqual(result["status"], "cookie_expired")
        self_heal.assert_not_called()

    def test_running_auto_login_stops_immediately_after_manual_takeover(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/login/"
        event = threading.Event()
        ack_event = threading.Event()
        event.set()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_wait_for_manual_login_completion", return_value={"status": "manual"}) as wait_manual,
            mock.patch.object(runner, "_auto_submit_login_form") as submit,
        ):
            result = runner._run_open_login(
                page,
                {"id": "auto-to-manual"},
                {},
                {"login_wait_seconds": 30, "auto_submit": True},
                Path("."),
                _Logger(),
                "threads",
                context_control={
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                },
            )

        self.assertEqual(result["status"], "manual")
        wait_manual.assert_called_once()
        submit.assert_not_called()
        self.assertTrue(ack_event.is_set())

    def test_verification_switches_auto_login_to_manual_mode(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        event = threading.Event()
        ack_event = threading.Event()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "need_verification"}),
            mock.patch.object(runner, "_screenshot", return_value="verification.png"),
            mock.patch.object(runner, "_wait_or_raise_manual", return_value={"status": "need_verification"}),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
        ):
            result = runner._run_open_login(
                page,
                {"id": "auto-verification"},
                {},
                {"login_wait_seconds": 30, "auto_submit": True},
                Path("."),
                _Logger(),
                "instagram",
                context_control={
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                },
            )

        self.assertEqual(result["status"], "need_verification")
        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        self_heal.assert_not_called()

    def test_auto_login_does_not_resubmit_or_self_heal_during_submit_grace(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/login/"
        cancel_event = threading.Event()

        def cancel_after_grace_poll(_seconds):
            cancel_event.set()

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "cookie_expired"}),
            mock.patch.object(runner, "_auto_submit_login_form", return_value=True) as submit,
            mock.patch.object(runner, "_verification_visible", return_value=False),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
            mock.patch.object(runner.time, "time", return_value=0),
            mock.patch.object(runner.time, "monotonic", side_effect=[100, 101]),
            mock.patch.object(runner.time, "sleep", side_effect=cancel_after_grace_poll),
        ):
            with self.assertRaisesRegex(RuntimeError, "取消"):
                runner._run_open_login(
                    page,
                    {"id": "auto-submit-grace"},
                    {},
                    {
                        "login_wait_seconds": 30,
                        "auto_submit": True,
                        "submit_grace_seconds": 30,
                    },
                    Path("."),
                    _Logger(),
                    "instagram",
                    cancel_event=cancel_event,
                )

        submit.assert_called_once()
        self_heal.assert_not_called()

    def test_delayed_verification_is_detected_before_invalid_credentials_self_heal(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        event = threading.Event()
        ack_event = threading.Event()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "invalid_credentials"}),
            mock.patch.object(runner, "_verification_visible", return_value=True),
            mock.patch.object(runner, "_screenshot", return_value="verification.png"),
            mock.patch.object(runner, "_wait_or_raise_manual", return_value={"status": "need_verification"}),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
        ):
            result = runner._run_open_login(
                page,
                {"id": "delayed-verification"},
                {},
                {"login_wait_seconds": 30, "auto_submit": True},
                Path("."),
                _Logger(),
                "instagram",
                context_control={
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                },
            )

        self.assertEqual(result["status"], "need_verification")
        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        self_heal.assert_not_called()

    def test_manual_takeover_during_submit_lookup_never_falls_back_to_enter(self):
        page = _Page(url="https://www.instagram.com/accounts/login/")
        event = threading.Event()
        ack_event = threading.Event()
        locator = _Locator()

        def request_takeover(*_args, **_kwargs):
            event.set()
            return False

        with (
            mock.patch.object(runner, "_screenshot", return_value="login.png"),
            mock.patch.object(runner, "_visible_first", side_effect=[locator, locator]),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_click_text_button", side_effect=request_takeover),
            mock.patch.object(runner, "_sleep_between"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "instagram",
                {"login_username": "user", "login_password": "password"},
                _Logger(),
                {"id": "takeover-during-submit"},
                Path("."),
                {
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                },
            )

        self.assertFalse(submitted)
        self.assertNotIn("Enter", page.keyboard.pressed)
        self.assertTrue(ack_event.is_set())

    def test_system_manual_takeover_notifies_persistence_callback(self):
        event = threading.Event()
        ack_event = threading.Event()
        callback = mock.Mock()

        runner._request_manual_takeover({
            "manual_takeover_event": event,
            "manual_takeover_ack_event": ack_event,
            "manual_takeover_callback": callback,
        })

        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        callback.assert_called_once_with()

    def test_threads_transient_error_keeps_manual_login_page_untouched(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        logger = _Logger()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_prepare_manual_threads_login_page"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "transient_error", "reason": "error page"}),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
            mock.patch.object(runner, "_screenshot", return_value="error.png"),
            mock.patch.object(runner, "_wait_or_raise_manual", return_value={"status": "transient_error"}),
        ):
            result = runner._run_open_login(
                page,
                {"id": "manual-transient-error"},
                {},
                {"login_wait_seconds": 30, "auto_submit": False, "wait_for_manual": True},
                Path("."),
                logger,
                "threads",
            )

        self.assertEqual(result["status"], "transient_error")
        self_heal.assert_not_called()

    def test_manual_threads_login_retries_once_then_opens_instagram_handoff(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        logger = _Logger()
        with (
            mock.patch.object(
                runner,
                "_detect_threads_login_state",
                side_effect=[
                    {"status": "transient_error", "reason": "error page"},
                    {"status": "cookie_expired", "reason": "login prompt"},
                ],
            ),
            mock.patch.object(runner, "_click_text_button", side_effect=[True, True]) as click,
            mock.patch.object(runner, "_sleep_between"),
        ):
            runner._prepare_manual_threads_login_page(page, logger)

        self.assertEqual(click.call_count, 2)
        self.assertEqual(click.call_args_list[0].args[3], "manual_login_retry")
        self.assertEqual(click.call_args_list[1].args[3], "manual_login_continue_instagram")
        self.assertEqual(page.wait_for_load_state.call_count, 2)

    def test_manual_threads_login_does_not_redirect_an_authenticated_session(self):
        page = mock.Mock()
        logger = _Logger()
        with (
            mock.patch.object(runner, "_detect_threads_login_state", return_value={"status": "ready"}),
            mock.patch.object(runner, "_click_text_button") as click,
        ):
            runner._prepare_manual_threads_login_page(page, logger)

        click.assert_not_called()

    def test_manual_threads_login_falls_back_to_top_level_instagram_login(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        logger = _Logger()
        with (
            mock.patch.object(runner, "_detect_threads_login_state", return_value={"status": "cookie_expired"}),
            mock.patch.object(runner, "_click_text_button", return_value=False),
            mock.patch.object(runner, "_goto") as goto,
        ):
            runner._prepare_manual_threads_login_page(page, logger)

        goto.assert_called_once_with(
            page,
            "https://www.instagram.com/accounts/login/",
            logger,
            "manual_login_instagram_fallback",
        )

    def test_manual_threads_login_returns_from_instagram_for_final_confirmation(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/"
        logger = _Logger()
        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_detect_threads_login_state", return_value={"status": "ready", "url": runner.THREADS_HOME}) as detect,
        ):
            result = runner._restore_threads_after_instagram_login(page, {"status": "ready"}, logger)

        goto.assert_called_once_with(page, runner.THREADS_HOME, logger, "manual_login_return_threads")
        detect.assert_called_once_with(page)
        self.assertEqual(result["status"], "ready")

    def test_screenshot_captures_current_viewport(self):
        page = mock.Mock()

        result = runner._screenshot(page, Path("."), {"id": "login-task"}, "login_complete", _Logger())

        self.assertTrue(result.endswith(".png"))
        page.screenshot.assert_called_once()
        self.assertFalse(page.screenshot.call_args.kwargs["full_page"])

    def test_publish_task_captures_final_or_manual_verification_screenshot(self):
        page = mock.Mock()
        logger = _Logger()
        task = {"id": "publish-task", "task_type": "publish_post"}

        self.assertEqual(runner._screenshot(page, Path("."), task, "failed", logger), "")
        manual_result = runner._screenshot(page, Path("."), task, "publish_submitted_unconfirmed", logger)
        result = runner._screenshot(page, Path("."), task, "publish_done", logger)

        self.assertTrue(manual_result.endswith(".png"))
        self.assertTrue(result.endswith(".png"))
        self.assertEqual(page.screenshot.call_count, 2)
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
        self.assertEqual(
            runner._find_threads_post_permalinks(page),
            ["https://www.threads.net/@alice/post/LATEST", "https://www.threads.net/@alice/post/OLDER"],
        )

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
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value=old_permalink),
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

    def test_threads_caption_confirmation_rejects_older_matching_post(self):
        latest_before = "https://www.threads.net/@alice/post/LATEST_BEFORE"
        older_match = "https://www.threads.net/@alice/post/OLDER_MATCH"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=older_match),
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value=latest_before),
            mock.patch.object(runner.time, "time", side_effect=[0, 0, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "reused post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                previous_permalinks={latest_before},
            )

        self.assertFalse(result["confirmed"])

    def test_threads_caption_confirmation_requires_readable_baseline(self):
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=new_permalink),
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value=new_permalink),
            mock.patch.object(runner.time, "time", side_effect=[0, 0, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "new post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                previous_permalinks=None,
            )

        self.assertFalse(result["confirmed"])

    def test_threads_confirmation_refreshes_profile_while_waiting_for_delayed_post(self):
        page = mock.Mock(url="https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=""),
            mock.patch.object(runner, "_find_latest_threads_post_permalink", return_value=""),
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
        page.reload.assert_called_once_with(wait_until="domcontentloaded", timeout=12000)

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
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=["https://www.threads.net/@alice/post/OLD"]),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_screenshot", return_value="manual.png") as screenshot,
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
        self.assertEqual(raised.exception.screenshot_path, "manual.png")
        screenshot.assert_called_once_with(page, Path("."), {"id": "publish-task"}, "publish_submitted_unconfirmed", mock.ANY)

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
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=["https://www.threads.net/@alice/post/OLD"]),
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
        self.assertTrue(any(call.args[1] == resolved_profile and call.args[3] == "threads_publish_baseline" for call in goto.call_args_list))
        self.assertEqual(confirm_profile.call_args.kwargs["profile_url"], resolved_profile)
        screenshot.assert_called_once_with(page, permalink, "hello threads", Path("."), {"id": "publish-task"}, mock.ANY)


if __name__ == "__main__":
    unittest.main()
