import unittest
import contextlib
import queue
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


class LoginAssistancePresentationTests(unittest.TestCase):
    def test_verification_and_credentials_have_distinct_safe_prompts(self):
        code_prompt = runner._login_assistance_presentation({"status": "need_verification", "challenge_type": "sms_code", "reason": "短信验证"})
        email_prompt = runner._login_assistance_presentation({"status": "need_verification", "challenge_type": "email_code", "reason": "邮箱验证"})
        credentials_prompt = runner._login_assistance_presentation({"status": "invalid_credentials", "reason": "密码错误"})
        self.assertEqual(code_prompt["kind"], "verification_code")
        self.assertEqual(code_prompt["field_label"], "短信验证码")
        self.assertEqual(code_prompt["input_mode"], "numeric")
        self.assertEqual(email_prompt["field_label"], "邮箱验证码")
        self.assertEqual(email_prompt["input_mode"], "text")
        self.assertEqual(credentials_prompt["kind"], "credentials")
        self.assertIn("账号、邮箱或手机号", credentials_prompt["field_label"])

    def test_only_ready_state_maps_to_success(self):
        self.assertEqual(runner._login_assistance_presentation({"status": "ready"})["phase"], "success")
        self.assertNotEqual(runner._login_assistance_presentation({"status": "need_verification"})["phase"], "success")

    def test_all_login_states_and_exceptions_have_distinct_live_prompts(self):
        cases = {
            "ready": ("success", "success", "登录成功"),
            "invalid_credentials": ("attention", "credentials", "重新输入登录信息"),
            "cookie_expired": ("attention", "credentials", "需要登录信息"),
            "account_confirmation_required": ("attention", "confirm", "需要确认账号"),
            "post_login_interstitial": ("running", "progress", "正在处理登录后提示"),
            "transient_error": ("running", "progress", "正在执行登录"),
            "totp_submitted": ("running", "progress", "正在验证"),
            "threads_restore_required": ("running", "progress", "正在确认 Threads 登录"),
            "need_manual": ("attention", "browser_interaction", "需要人工处理"),
            "manual_login_timeout": ("error", "error", "处理超时"),
            "cancelled": ("error", "error", "登录已停止"),
            "failed": ("error", "error", "登录未完成"),
            "banned": ("error", "error", "账号已被限制"),
            "disabled": ("error", "error", "账号已被限制"),
        }
        for status, (phase, kind, title) in cases.items():
            prompt = runner._login_assistance_presentation({"status": status, "reason": "测试原因"})
            self.assertEqual(prompt["phase"], phase, status)
            self.assertEqual(prompt["kind"], kind, status)
            self.assertEqual(prompt["title"], title, status)
        banned_via_health = runner._login_assistance_presentation({
            "status": "cookie_expired",
            "health_status": "banned",
            "reason": "Account disabled",
        })
        self.assertEqual(banned_via_health["title"], "账号已被限制")
        self.assertEqual(banned_via_health["phase"], "error")

    def test_auto_login_does_not_surface_credentials_the_robot_can_submit(self):
        control = {"totp_code_provider": lambda: {"available": True, "code": "123456"}}
        runner._publish_login_assistance_state(mock.Mock(), control, {"status": "cookie_expired", "reason": "检测到登录表单"})
        self.assertNotIn("login_assistance_state", control)
        runner._publish_login_assistance_state(
            mock.Mock(),
            control,
            {"status": "need_verification", "challenge_type": "authenticator_totp"},
        )
        self.assertNotIn("login_assistance_state", control)
        runner._publish_login_assistance_state(mock.Mock(), control, {"status": "account_confirmation_required"})
        self.assertNotIn("login_assistance_state", control)
        runner._publish_login_assistance_state(mock.Mock(), control, {"status": "invalid_credentials", "reason": "密码错误"})
        self.assertEqual(control["login_assistance_state"]["kind"], "credentials")
        handed = {}
        runner._publish_login_assistance_state(
            mock.Mock(),
            handed,
            {"status": "cookie_expired", "reason": "请填写账号密码"},
            handoff=True,
        )
        self.assertEqual(handed["login_assistance_state"]["kind"], "credentials")
        runner._publish_login_assistance_state(
            mock.Mock(),
            control,
            {"status": "need_verification", "challenge_type": "sms_code"},
        )
        self.assertEqual(control["login_assistance_state"]["kind"], "verification_code")

    def test_login_assistance_only_publishes_interactive_milestones(self):
        control = {}
        runner._publish_login_assistance_state(mock.Mock(), control, {"status": "transient_error", "reason": "暂时打不开"})
        self.assertFalse(control)
        runner._publish_login_assistance_state(
            mock.Mock(),
            control,
            {"status": "need_verification", "challenge_type": "method_selection", "actions": [{"label": "Text message", "title": "短信"}]},
        )
        self.assertEqual(control["login_assistance_state"]["kind"], "choice")
        self.assertEqual(control["login_assistance_state"]["title"], "选择验证方式")
        self.assertEqual(control["login_assistance_state"]["actions"][0]["label"], "Text message")
        runner._publish_login_assistance_state(
            mock.Mock(),
            control,
            {"status": "need_verification", "challenge_type": "method_selection", "actions": [{"label": "Text message", "title": "短信"}]},
        )
        first_updated = control["login_assistance_state"]["updated_at"]
        runner._publish_login_assistance_state(
            mock.Mock(),
            control,
            {"status": "need_verification", "challenge_type": "method_selection", "actions": [{"label": "Text message", "title": "短信"}]},
        )
        self.assertEqual(control["login_assistance_state"]["updated_at"], first_updated)
        captcha = runner._login_assistance_presentation({
            "status": "need_verification",
            "challenge_type": "numeric_image_captcha",
        })
        self.assertEqual(captcha["kind"], "verification_code")
        self.assertEqual(captcha["title"], "输入图片验证码")

    def test_open_login_publishes_interstitial_errors_and_submit_progress(self):
        source = Path(runner.__file__).read_text(encoding="utf-8")
        auto_login = source.split("def _run_open_login(", 1)[1].split("def _wait_for_manual_login_completion(", 1)[0]
        wait_manual = source.split("def _wait_for_manual_login_completion(", 1)[1].split("def _login_assistance_has_cjk(", 1)[0]
        self.assertLess(
            auto_login.index('== "post_login_interstitial"'),
            auto_login.index("if last_status.get(\"status\") == \"ready\""),
        )
        self.assertIn("_publish_login_assistance_state(page, context_control, last_status)", auto_login)
        self.assertIn('"status": "cancelled"', auto_login)
        self.assertIn('"status": "failed"', auto_login)
        self.assertIn('{"status": "manual_login_timeout"', wait_manual)
        self.assertIn('{"status": "cancelled"', wait_manual)

    def test_login_assistance_publishes_the_manual_deadline(self):
        control = {"login_assistance_expires_at": 1_900_000_000}
        runner._publish_login_assistance_state(
            mock.Mock(),
            control,
            {"status": "need_verification", "challenge_type": "authenticator_totp"},
        )
        self.assertEqual(control["login_assistance_state"]["kind"], "verification_code")
        self.assertEqual(control["login_assistance_state"]["expires_at"], 1_900_000_000)

    def test_publish_assistance_reports_takeover_and_success_nodes(self):
        control = {"task": {"payload": {"caption": "今日发布测试"}}}
        runner._set_task_assistance(
            control,
            phase="attention",
            kind="takeover",
            title="需要人工接管发布",
            message="点击接受后打开实时浏览器",
        )
        self.assertEqual(control["login_assistance_state"]["kind"], "takeover")
        self.assertEqual(control["login_assistance_state"]["content"], "今日发布测试")
        runner._set_task_assistance(
            control,
            phase="success",
            kind="success",
            title="发布成功",
            permalink="https://www.threads.net/@demo/post/abc",
            screenshot_path="/data/shot.png",
        )
        self.assertEqual(control["login_assistance_state"]["permalink"], "https://www.threads.net/@demo/post/abc")
        self.assertEqual(control["login_assistance_state"]["screenshot_path"], "/data/shot.png")

    def test_submitted_verification_code_stays_hidden_until_rejected(self):
        control = {
            "login_assistance_submitted_kind": "verification_code",
            "login_assistance_submitted_challenge": "sms_code",
            "login_assistance_state": {"phase": "running", "kind": "progress", "title": "正在验证"},
        }
        page = mock.Mock()
        with mock.patch.object(runner, "_login_assistance_code_rejected", return_value=False):
            runner._publish_login_assistance_state(
                page,
                control,
                {"status": "need_verification", "challenge_type": "sms_code"},
                handoff=True,
            )
        self.assertEqual(control["login_assistance_state"]["kind"], "progress")
        self.assertEqual(control["login_assistance_state"]["title"], "正在验证")
        with mock.patch.object(runner, "_login_assistance_code_rejected", return_value=True):
            runner._publish_login_assistance_state(
                page,
                control,
                {"status": "need_verification", "challenge_type": "sms_code"},
                handoff=True,
            )
        self.assertEqual(control["login_assistance_state"]["kind"], "verification_code")
        self.assertIn("请重新输入", control["login_assistance_state"]["message"])

    def test_choice_clicks_are_sent_to_the_visible_page_button(self):
        actions = queue.Queue(maxsize=2)
        actions.put_nowait({"kind": "choice", "action_label": "Text message"})
        page, logger = mock.Mock(), mock.Mock()
        page.is_closed.return_value = False
        page.frames = []
        page.context.pages = [page]
        control = {
            "login_assistance_queue": actions,
            "login_assistance_lock": threading.Lock(),
            "login_assistance_pending": True,
        }
        with mock.patch.object(runner, "_click_text_button", return_value=True) as click:
            consumed = runner._process_login_assistance_action(page, "instagram", logger, control)
        self.assertTrue(consumed)
        click.assert_called_once()
        self.assertEqual(click.call_args.args[2], ["Text message"])
        self.assertEqual(control["login_assistance_state"]["title"], "正在验证")

    def test_login_assistance_is_persisted_to_the_live_browser_session(self):
        control = {"live_browser_session_id": "live_task-1"}
        with mock.patch("social_automation.live_browser.update_live_browser_login_assistance") as persist:
            runner._publish_login_assistance_state(
                mock.Mock(),
                control,
                {"status": "need_verification", "challenge_type": "sms_code"},
            )
        persist.assert_called_once()
        self.assertEqual(persist.call_args.args[0], "live_task-1")
        self.assertEqual(persist.call_args.args[1]["kind"], "verification_code")

    def test_visible_code_input_on_another_tab_is_treated_as_verification(self):
        main_page, challenge_page = mock.Mock(), mock.Mock()
        main_page.url = "https://www.threads.net/"
        challenge_page.url = "https://www.instagram.com/challenge/"
        code_input = mock.Mock()
        with (
            mock.patch.object(runner, "_mapped_login_verification_code", return_value=(challenge_page, challenge_page, code_input)),
            mock.patch.object(runner, "_classify_verification_challenge", return_value={"type": "sms_code"}),
        ):
            status = runner._enrich_login_state_with_visible_challenge(
                main_page,
                {"status": "cookie_expired", "reason": "尚未检测到有效会话"},
            )
        self.assertEqual(status["status"], "need_verification")
        self.assertEqual(status["challenge_type"], "sms_code")

    def test_open_login_publishes_assistance_before_waiting_for_totp(self):
        source = Path(runner.__file__).read_text(encoding="utf-8")
        auto_login = source.split("def _run_open_login(", 1)[1].split("def _wait_for_manual_login_completion(", 1)[0]
        self.assertIn("_publish_login_assistance_state(page, context_control, last_status)", auto_login)
        self.assertIn('检测到验证码或安全挑战，正在同步登录助手', auto_login)
        self.assertLess(
            auto_login.index("_publish_login_assistance_state("),
            auto_login.index("_try_auto_totp_challenge("),
        )

    def test_verification_submission_is_consumed_by_the_browser_task_thread(self):
        actions = queue.Queue(maxsize=2)
        actions.put_nowait({"kind": "verification_code", "verification_code": "654321"})
        control = {
            "login_assistance_queue": actions,
            "login_assistance_lock": threading.Lock(),
            "login_assistance_pending": True,
        }
        page, code_input, logger = mock.Mock(), mock.Mock(), mock.Mock()

        def assert_pending_while_browser_is_typing(*_args, **_kwargs):
            self.assertTrue(control["login_assistance_pending"])

        with (
            mock.patch.object(runner, "_mapped_login_verification_code", return_value=(page, page, code_input)),
            mock.patch.object(runner, "_clear_and_type", side_effect=assert_pending_while_browser_is_typing) as fill,
            mock.patch.object(runner, "_click_text_button", return_value=True) as submit,
        ):
            consumed = runner._process_login_assistance_action(page, "instagram", logger, control)
        self.assertTrue(consumed)
        self.assertFalse(control["login_assistance_pending"])
        fill.assert_called_once()
        self.assertEqual(fill.call_args.args[2], "654321")
        submit.assert_called_once()
        self.assertEqual(control["login_assistance_state"]["phase"], "running")

    def test_email_verification_preserves_alphanumeric_code_and_uses_otp_field(self):
        actions = queue.Queue(maxsize=2)
        actions.put_nowait({"kind": "verification_code", "verification_code": "Ab7-X9"})
        page, code_input, logger = mock.Mock(), mock.Mock(), mock.Mock()
        page.is_closed.return_value = False
        page.frames = []
        page.context.pages = [page]
        control = {
            "login_assistance_queue": actions,
            "login_assistance_lock": threading.Lock(),
            "login_assistance_pending": True,
        }

        def locate(_surface, selectors, **_kwargs):
            return code_input if 'input[name*="otp" i]' in selectors else None

        with (
            mock.patch.object(runner, "_visible_first", side_effect=locate),
            mock.patch.object(runner, "_clear_and_type") as fill,
            mock.patch.object(runner, "_click_text_button", return_value=True),
        ):
            consumed = runner._process_login_assistance_action(page, "instagram", logger, control)

        self.assertTrue(consumed)
        fill.assert_called_once()
        self.assertEqual(fill.call_args.args[2], "Ab7-X9")

    def test_submission_error_remains_visible_until_retry_or_prompt_changes(self):
        actions = queue.Queue(maxsize=2)
        actions.put_nowait({"kind": "credentials", "login_username": "name", "login_password": "secret"})
        control = {
            "login_assistance_queue": actions,
            "login_assistance_lock": threading.Lock(),
            "login_assistance_pending": True,
            "login_assistance_state": {"phase": "attention", "kind": "credentials"},
        }
        with mock.patch.object(runner, "_mapped_login_input", return_value=None):
            runner._process_login_assistance_action(mock.Mock(), "instagram", mock.Mock(), control)

        runner._publish_login_assistance_state(
            mock.Mock(), control, {"status": "cookie_expired", "reason": "still on login"}
        )
        self.assertEqual(control["login_assistance_state"]["title"], "暂时无法提交")

        runner._publish_login_assistance_state(
            mock.Mock(), control, {"status": "need_verification", "challenge_type": "sms_code"}
        )
        self.assertEqual(control["login_assistance_state"]["kind"], "verification_code")

    def test_credentials_follow_the_visible_login_page_when_context_switched_tabs(self):
        actions = queue.Queue(maxsize=2)
        actions.put_nowait({"kind": "credentials", "login_username": "name", "login_password": "secret"})
        stale_page, login_page = mock.Mock(), mock.Mock()
        stale_page.is_closed.return_value = False
        login_page.is_closed.return_value = False
        stale_page.frames = []
        login_page.frames = []
        stale_page.context.pages = [stale_page, login_page]
        username_input, password_input = mock.Mock(), mock.Mock()
        control = {
            "login_assistance_queue": actions,
            "login_assistance_lock": threading.Lock(),
            "login_assistance_pending": True,
        }

        def locate(surface, selectors, **_kwargs):
            if surface is not login_page:
                return None
            if 'input[name="email"]' in selectors:
                return username_input
            if 'input[name="pass"]' in selectors:
                return password_input
            return None

        with (
            mock.patch.object(runner, "_visible_first", side_effect=locate),
            mock.patch.object(runner, "_clear_and_type") as fill,
            mock.patch.object(runner, "_click_text_button", return_value=True),
        ):
            consumed = runner._process_login_assistance_action(
                stale_page, "instagram", mock.Mock(), control
            )

        self.assertTrue(consumed)
        self.assertEqual(fill.call_args_list[0].args[1:3], (username_input, "name"))
        self.assertEqual(fill.call_args_list[1].args[1:3], (password_input, "secret"))


class _BackgroundPage:
    def __init__(self, url="about:blank"):
        self.url = url
        self.closed = False
        self.reload = mock.Mock()
        self.routes = []
        self.unroutes = []

    def route(self, pattern, handler):
        self.routes.append((pattern, handler))

    def unroute(self, pattern, handler):
        self.unroutes.append((pattern, handler))

    def close(self):
        self.closed = True


class _BackgroundContext(_Context):
    def __init__(self):
        super().__init__()
        self.pages = []

    def new_page(self):
        page = _BackgroundPage()
        self.pages.append(page)
        return page


class _Page:
    def __init__(self, url="https://www.threads.net/"):
        self.url = url
        self.keyboard = _Keyboard()
        self.context = _Context()
        self.evaluations = []

    def evaluate(self, script, value=None):
        self.evaluations.append((script, value))
        return None


class _RedirectedPage(_Page):
    def __init__(self):
        super().__init__("about:blank")
        self.goto_calls = []
        self.waited_states = []

    def goto(self, url, **_kwargs):
        self.goto_calls.append(url)
        self.url = "https://www.threads.com/@alice"
        raise RuntimeError(
            'Page.goto: Navigation to "https://www.threads.net/@alice" is '
            'interrupted by another navigation to "https://www.threads.com/@alice"'
        )

    def wait_for_load_state(self, state, **_kwargs):
        self.waited_states.append(state)


class _TransientThreadsHomePage(_Page):
    def __init__(self):
        super().__init__("about:blank")
        self.goto_calls = []
        self.waited_states = []

    def goto(self, url, **_kwargs):
        self.goto_calls.append(url)
        if url == runner.THREADS_HOME:
            self.url = "about:blank"
            raise RuntimeError(
                'Page.goto: NS_ERROR_NET_EMPTY_RESPONSE\n'
                'Call log:\n  - navigating to "https://www.threads.net/"'
            )
        self.url = url

    def wait_for_load_state(self, state, **_kwargs):
        self.waited_states.append(state)


class _PageWithBackground(_Page):
    def __init__(self, url="https://www.threads.net/"):
        super().__init__(url)
        self.context = _BackgroundContext()
        self.brought_to_front = 0

    def bring_to_front(self):
        self.brought_to_front += 1


class _Locator:
    @property
    def first(self):
        return self

    def count(self):
        return 1

    def is_visible(self, **_kwargs):
        return True

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


class _InstagramRiskyContactPage:
    def __init__(self, url="https://www.instagram.com/accounts/update_risky_contactpoint/?challenge_context=secure-account"):
        self.url = url
        self.context = _CookieContext(
            [{"name": "sessionid", "value": "active-session", "domain": ".instagram.com"}]
        )
        self.body = _LoginStateLocator(
            text="Your email may not be secure. Update email address to secure your account.",
            visible=True,
        )

    def locator(self, selector):
        if selector == "body":
            return self.body
        return _LoginStateLocator(visible=False)


class _CookieContext:
    def __init__(self, cookies):
        self._cookies = cookies

    def cookies(self):
        return self._cookies


class _ThreadsShellPage:
    url = "https://www.threads.com/"

    def __init__(self, cookies, body_text=""):
        self.context = _CookieContext(cookies)
        self.body = _LoginStateLocator(text=body_text, visible=True)

    def locator(self, selector):
        if selector == "body":
            return self.body
        return _LoginStateLocator(visible=("aria-label" in selector))


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class _RecordingLogger:
    def __init__(self):
        self.entries = []

    def log(self, *args, **kwargs):
        self.entries.append((args, kwargs))


class RunnerPublishSafetyTests(unittest.TestCase):
    def test_click_text_button_uses_dom_fallback_after_safe_click_miss(self):
        page = mock.Mock()
        locator = mock.Mock()
        locator.count.return_value = 1
        locator.is_visible.return_value = True
        page.get_by_role.return_value.first = locator
        page.get_by_text.return_value.first = locator
        page.locator.return_value.first = locator
        page.evaluate.return_value = True

        with mock.patch.object(runner, "_human_click", return_value=False) as human_click:
            clicked = runner._click_text_button(
                page,
                _Logger(),
                ["Create"],
                "publish_create",
            )

        self.assertTrue(clicked)
        self.assertGreaterEqual(human_click.call_count, 1)
        page.evaluate.assert_called_once()

    def test_publish_submit_guard_blocks_cancelled_action(self):
        cancelled = threading.Event()
        cancelled.set()
        action = mock.Mock()
        guard = mock.Mock()

        with self.assertRaisesRegex(RuntimeError, "已取消"):
            runner._run_publish_submit_action(
                {"publish_submit_callback": guard},
                cancelled,
                action,
            )

        guard.assert_not_called()
        action.assert_not_called()

    def test_publish_submit_guard_wraps_final_action(self):
        action = mock.Mock(return_value="clicked")
        guard = mock.Mock(side_effect=lambda callback: callback())

        result = runner._run_publish_submit_action(
            {"publish_submit_callback": guard},
            threading.Event(),
            action,
        )

        self.assertEqual(result, "clicked")
        guard.assert_called_once()
        action.assert_called_once()

    @staticmethod
    def _totp_verification_page(text):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        page.keyboard = _Keyboard()
        body = mock.Mock()
        body.first = body
        body.count.return_value = 1
        body.is_visible.return_value = True
        body.inner_text.return_value = text
        field = mock.Mock()
        field.first = field
        field.count.return_value = 1
        field.is_visible.return_value = True
        field.input_value.return_value = ""
        field.nth.return_value = field
        field.filter.return_value = field

        def locator(selector):
            return body if selector == "body" else field

        page.locator.side_effect = locator
        page.get_by_role.return_value = field
        page.get_by_text.return_value = field
        return page, body

    @staticmethod
    def _totp_state_detector(body, states):
        index = 0

        def detect(_page, _platform):
            nonlocal index
            state = states[min(index, len(states) - 1)]
            index += 1
            body.inner_text.return_value = state["text"]
            return {
                "status": state["status"],
                "reason": state["text"],
                "verification_method": state.get("verification_method", ""),
            }

        return detect

    def _run_totp_case(self, task_id, states, provider):
        page, body = self._totp_verification_page(states[0]["text"])
        outcome = mock.Mock()
        wait_manual = mock.Mock(return_value={"status": "need_verification"})
        code_input = page.locator('input[autocomplete="one-time-code"]')
        challenge_states = [states[0], states[0]]
        for state in states[1:-1]:
            challenge_states.extend((state, state))
        if len(states) > 1:
            challenge_states.append(states[-1])
        challenge_index = 0
        current_text = states[0]["text"]
        monotonic_value = 0

        def classify(_page):
            nonlocal challenge_index, current_text
            state = challenge_states[min(challenge_index, len(challenge_states) - 1)]
            challenge_index += 1
            current_text = state["text"]
            method = state.get("verification_method", "")
            challenge_type = {
                "authenticator": "authenticator_totp",
                "sms": "sms_code",
                "email": "email_code",
                "unknown": "unknown_code",
            }.get(method, "none")
            return {
                "type": challenge_type,
                "url": str(page.url or ""),
                "has_code_input": challenge_type != "none",
                "code_input": code_input if challenge_type != "none" else None,
            }

        def monotonic():
            nonlocal monotonic_value
            monotonic_value += 1
            return float(monotonic_value)

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                side_effect=self._totp_state_detector(body, states),
            ),
            mock.patch.object(runner, "_verification_visible", return_value=True),
            mock.patch.object(
                runner,
                "_classify_verification_challenge",
                side_effect=classify,
            ),
            mock.patch.object(
                runner,
                "_page_body_text_lower",
                side_effect=lambda *_args, **_kwargs: current_text.lower(),
            ),
            mock.patch.object(runner, "_wait_interruptibly", return_value=True),
            mock.patch.object(runner, "_confirm_platform_ready", return_value={"status": "ready"}),
            mock.patch.object(runner, "_screenshot", return_value=f"{task_id}.png"),
            mock.patch.object(runner, "_wait_or_raise_manual", wait_manual),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner.time, "sleep"),
            mock.patch.object(runner.time, "time", return_value=0),
            mock.patch.object(runner.time, "monotonic", side_effect=monotonic),
        ):
            result = runner._run_open_login(
                page,
                {"id": task_id},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                Path("."),
                _Logger(),
                "instagram",
                context_control={
                    "manual_takeover_event": threading.Event(),
                    "manual_takeover_ack_event": threading.Event(),
                    "totp_code_provider": provider,
                    "totp_outcome_callback": outcome,
                },
            )
        return result, outcome, wait_manual

    def test_risky_contactpoint_page_requires_immediate_manual_verification(self):
        page = _InstagramRiskyContactPage()

        status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "need_verification")
        self.assertEqual(status["url"], page.url)

    def test_risky_contactpoint_query_is_a_verification_url(self):
        self.assertTrue(
            runner._is_verification_url(
                "https://www.instagram.com/accounts/update_risky_contactpoint/"
            )
        )

    def test_threads_delegation_preserves_risky_contactpoint_verification(self):
        status = runner._detect_platform_login_state(_InstagramRiskyContactPage(), "threads")

        self.assertEqual(status["status"], "need_verification")

    def test_risky_contactpoint_text_requires_verification_on_another_instagram_url(self):
        page = _InstagramRiskyContactPage("https://www.instagram.com/accounts/edit/")

        status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "need_verification")

    def test_publish_verification_state_skips_automatic_login_repair(self):
        initial_status = {"status": "need_verification", "reason": "security challenge"}

        with (
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
            mock.patch.object(runner, "_run_open_login") as open_login,
        ):
            result = runner._attempt_publish_login_repair(
                mock.Mock(),
                {"task_type": "publish_post"},
                {"login_password": "saved-password"},
                {},
                Path("."),
                _Logger(),
                "instagram",
                None,
                initial_status,
            )

        self.assertIs(result, initial_status)
        self_heal.assert_not_called()
        open_login.assert_not_called()

    def test_publish_login_repair_uses_shared_open_login_defaults(self):
        initial_status = {"status": "cookie_expired", "reason": "login page"}

        with mock.patch.object(runner, "_run_open_login", return_value={"ok": True, "status": "ready"}) as open_login:
            result = runner._attempt_publish_login_repair(
                mock.Mock(),
                {"id": "publish-login", "task_type": "publish_post"},
                {
                    "platform": "threads",
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                {},
                Path("."),
                _Logger(),
                "threads",
                None,
                initial_status,
                {},
            )

        self.assertEqual(result["status"], "ready")
        repair_payload = open_login.call_args.args[3]
        self.assertEqual(repair_payload["login_username"], "saved-user")
        self.assertEqual(repair_payload["login_password"], "saved-password")
        self.assertIs(repair_payload["auto_submit"], True)
        self.assertIs(repair_payload["wait_for_manual"], True)
        self.assertEqual(repair_payload["login_wait_seconds"], 3600)
        self.assertNotIn("max_login_attempts", repair_payload)
        self.assertNotIn("max_self_heal_attempts", repair_payload)

    def test_publish_reports_ready_login_before_running_action(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        callback = mock.Mock()
        browser_start_barrier = mock.Mock()
        control = {
            "account_login_status_callback": callback,
            "browser_start_barrier_callback": browser_start_barrier,
        }

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value={"status": "ready"}),
            mock.patch.object(runner, "_run_publish_post", return_value={"ok": True}),
        ):
            result = runner.run_social_task(
                task={"id": "publish-task", "task_type": "publish_post", "platform": "threads", "payload": {}},
                account={"platform": "threads"},
                proxy=None,
                data_dir=Path("."),
                logger=_Logger(),
                context_control=control,
            )

        self.assertTrue(result["ok"])
        browser_start_barrier.assert_called_once_with()
        callback.assert_called_once_with("ready")

    def test_publish_batch_reuses_one_browser_context_for_four_posts(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        lifecycle = []
        control = {
            "account_login_status_callback": mock.Mock(),
            "batch_item_started_callback": lambda task, index, total: lifecycle.append(
                ("started", task["id"], index, total)
            ),
            "batch_item_completed_callback": lambda task, result, index, total: lifecycle.append(
                ("completed", task["id"], result["post"], index, total)
            ),
        }
        tasks = [
            {"id": "publish-1", "task_type": "publish_post", "platform": "threads", "payload": {}},
            {"id": "publish-2", "task_type": "publish_post", "platform": "threads", "payload": {}},
            {"id": "publish-3", "task_type": "publish_post", "platform": "threads", "payload": {}},
            {"id": "publish-4", "task_type": "publish_post", "platform": "threads", "payload": {}},
        ]

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager) as open_context,
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value={"status": "ready"}) as login,
            mock.patch.object(
                runner,
                "_run_publish_post",
                side_effect=[
                    {"ok": True, "post": 1},
                    {"ok": True, "post": 2},
                    {"ok": True, "post": 3},
                    {"ok": True, "post": 4},
                ],
            ) as publish,
        ):
            results = runner.run_social_publish_batch(
                tasks=tasks,
                account={"platform": "threads"},
                proxy=None,
                data_dir=Path("."),
                loggers=[_Logger(), _Logger(), _Logger(), _Logger()],
                context_control=control,
            )

        self.assertEqual(
            [item["task_id"] for item in results],
            ["publish-1", "publish-2", "publish-3", "publish-4"],
        )
        self.assertEqual(open_context.call_count, 1)
        self.assertEqual(manager.__enter__.call_count, 1)
        self.assertEqual(manager.__exit__.call_count, 1)
        self.assertEqual(login.call_count, 1)
        self.assertEqual(publish.call_count, 4)
        self.assertEqual(control["current_task_id"], "publish-4")
        self.assertEqual(
            lifecycle,
            [
                ("started", "publish-1", 1, 4),
                ("completed", "publish-1", 1, 1, 4),
                ("started", "publish-2", 2, 4),
                ("completed", "publish-2", 2, 2, 4),
                ("started", "publish-3", 3, 4),
                ("completed", "publish-3", 3, 3, 4),
                ("started", "publish-4", 4, 4),
                ("completed", "publish-4", 4, 4, 4),
            ],
        )

    def test_publish_batch_clears_takeover_requested_during_completion_before_next_item(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        takeover_event = threading.Event()
        takeover_ack_event = threading.Event()
        resolved = mock.Mock(return_value=True)
        event_state_at_publish = []
        tasks = [
            {"id": "publish-1", "task_type": "publish_post", "platform": "threads", "payload": {}},
            {"id": "publish-2", "task_type": "publish_post", "platform": "threads", "payload": {}},
        ]

        def complete(_task, _result, index, _total):
            if index == 1:
                takeover_event.set()
            return True

        def publish(*_args, **_kwargs):
            event_state_at_publish.append(takeover_event.is_set())
            return {"ok": True}

        control = {
            "account_login_status_callback": mock.Mock(),
            "manual_takeover_event": takeover_event,
            "manual_takeover_ack_event": takeover_ack_event,
            "manual_takeover_callback": mock.Mock(return_value=True),
            "manual_takeover_resolved_callback": resolved,
            "batch_item_completed_callback": complete,
        }

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value={"status": "ready"}),
            mock.patch.object(runner, "_run_publish_post", side_effect=publish),
        ):
            runner.run_social_publish_batch(
                tasks=tasks,
                account={"platform": "threads"},
                proxy=None,
                data_dir=Path("."),
                loggers=[_Logger(), _Logger()],
                context_control=control,
            )

        self.assertEqual(event_state_at_publish, [False, False])
        self.assertFalse(takeover_event.is_set())
        resolved.assert_called_once()

    def test_publish_batch_stops_before_next_item_when_completion_is_not_persisted(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        control = {
            "account_login_status_callback": mock.Mock(),
            "batch_item_started_callback": mock.Mock(),
            "batch_item_completed_callback": mock.Mock(return_value=False),
        }
        tasks = [
            {"id": "publish-1", "task_type": "publish_post", "platform": "threads", "payload": {}},
            {"id": "publish-2", "task_type": "publish_post", "platform": "threads", "payload": {}},
        ]

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value={"status": "ready"}),
            mock.patch.object(runner, "_run_publish_post", return_value={"ok": True}) as publish,
        ):
            with self.assertRaisesRegex(RuntimeError, "could not be persisted"):
                runner.run_social_publish_batch(
                    tasks=tasks,
                    account={"platform": "threads"},
                    proxy=None,
                    data_dir=Path("."),
                    loggers=[_Logger(), _Logger()],
                    context_control=control,
                )

        publish.assert_called_once()
        control["batch_item_started_callback"].assert_called_once_with(tasks[0], 1, 2)
        control["batch_item_completed_callback"].assert_called_once()

    def test_publish_verification_keeps_browser_open_until_manual_login_completes(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        account_status = mock.Mock()
        takeover = mock.Mock()
        resolved = mock.Mock()
        control = {
            "account_login_status_callback": account_status,
            "manual_takeover_event": threading.Event(),
            "manual_takeover_ack_event": threading.Event(),
            "manual_takeover_callback": takeover,
            "manual_takeover_resolved_callback": resolved,
        }
        verification = {"status": "need_verification", "reason": "security challenge"}

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value=verification),
            mock.patch.object(runner, "_attempt_publish_login_repair", return_value=verification),
            mock.patch.object(runner, "_wait_for_manual_login_completion", return_value={"status": "ready"}) as wait_manual,
            mock.patch.object(runner, "_screenshot", return_value="verification.png"),
            mock.patch.object(runner, "_run_publish_post", return_value={"ok": True}) as publish,
        ):
            result = runner.run_social_task(
                task={"id": "publish-verification", "task_type": "publish_post", "platform": "threads", "payload": {}},
                account={"platform": "threads"},
                proxy=None,
                data_dir=Path("."),
                logger=_Logger(),
                context_control=control,
            )

        self.assertTrue(result["ok"])
        wait_manual.assert_called_once()
        publish.assert_called_once()
        self.assertEqual(account_status.call_args_list, [mock.call("need_verification"), mock.call("ready")])
        self.assertTrue(takeover.called)
        resolved.assert_called_once_with()
        self.assertIsNone(manager.__exit__.call_args.args[0])

    def test_publish_login_check_uses_shared_primary_page_flow(self):
        page = mock.Mock()
        with (
            mock.patch.object(runner, "_check_platform_login", return_value={"status": "ready"}) as check_login,
            mock.patch.object(runner, "_report_account_login_status"),
            mock.patch.object(runner, "_run_publish_post", return_value={"ok": True}) as publish,
        ):
            result = runner._run_publish_task_in_context(
                page,
                {"id": "publish-shared-login", "task_type": "publish_post", "payload": {}},
                {"platform": "threads"},
                {},
                Path("."),
                _Logger(),
                "threads",
                None,
                {},
                verify_login=True,
            )

        self.assertEqual(result, {"ok": True})
        check_login.assert_called_once_with(page, "threads", mock.ANY)
        publish.assert_called_once()

    def test_warmup_cookie_expiry_auto_logs_in_then_continues_original_task(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        expired = {"status": "cookie_expired", "reason": "login page"}

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value=expired),
            mock.patch.object(runner, "_self_heal_login_page"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value=expired),
            mock.patch.object(
                runner,
                "_run_open_login",
                return_value={"ok": True, "status": "ready"},
            ) as auto_login,
            mock.patch.object(
                runner,
                "_run_instagram_warmup",
                return_value={"ok": True, "status": "success"},
            ) as warmup,
        ):
            result = runner.run_social_task(
                task={
                    "id": "warmup-login-recovery",
                    "task_type": "instagram_warmup",
                    "platform": "instagram",
                    "payload": {"publish_login_repair_attempts": 1},
                },
                account={
                    "platform": "instagram",
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                proxy=None,
                data_dir=Path("."),
                logger=_Logger(),
            )

        self.assertTrue(result["ok"])
        auto_login.assert_called_once()
        warmup.assert_called_once()
        self.assertIsNone(manager.__exit__.call_args.args[0])

    def test_warmup_verification_auto_submits_totp_then_continues_original_task(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        verification = {"status": "need_verification", "reason": "2FA challenge"}

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_check_platform_login", return_value=verification),
            mock.patch.object(
                runner,
                "_try_auto_totp_challenge",
                return_value={"status": "ready"},
            ) as auto_totp,
            mock.patch.object(
                runner,
                "_run_instagram_warmup",
                return_value={"ok": True, "status": "success"},
            ) as warmup,
        ):
            result = runner.run_social_task(
                task={
                    "id": "warmup-totp-recovery",
                    "task_type": "instagram_warmup",
                    "platform": "instagram",
                    "payload": {},
                },
                account={
                    "platform": "instagram",
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                proxy=None,
                data_dir=Path("."),
                logger=_Logger(),
            )

        self.assertTrue(result["ok"])
        auto_totp.assert_called_once()
        warmup.assert_called_once()
        self.assertIsNone(manager.__exit__.call_args.args[0])

    def test_threads_error_page_is_not_treated_as_ready(self):
        status = runner._detect_threads_login_state(_ThreadsErrorPage())

        self.assertNotEqual(status["status"], "ready")
        self.assertEqual(status["status"], "transient_error")

    def test_threads_disabled_page_is_classified_as_banned(self):
        page = _ThreadsShellPage(
            [],
            body_text="Your account has been disabled. Visit the Help Center for more information.",
        )
        page.url = "https://www.threads.com/checkpoint/disabled"

        status = runner._detect_threads_login_state(page)

        self.assertEqual(status["status"], "cookie_expired")
        self.assertEqual(status["health_status"], "banned")

    def test_threads_sidebar_without_a_session_cookie_is_not_ready(self):
        status = runner._detect_threads_login_state(_ThreadsShellPage([]))

        self.assertEqual(status["status"], "cookie_expired")

    def test_threads_authenticated_session_and_account_ui_is_ready(self):
        status = runner._detect_threads_login_state(_ThreadsShellPage([
            {"name": "sessionid", "value": "active-session", "domain": ".threads.net"},
        ]))

        self.assertEqual(status["status"], "ready")

    def test_threads_authenticated_session_with_say_more_prompt_is_not_expired(self):
        page = _ThreadsShellPage(
            [{"name": "sessionid", "value": "active-session", "domain": ".threads.net"}],
            body_text="Say more with Threads Continue with Instagram mysticshadowxp214",
        )

        status = runner._detect_threads_login_state(page)

        self.assertNotEqual(status["status"], "cookie_expired")

    def test_instagram_verification_selfie_requires_manual_verification(self):
        page = _ThreadsShellPage(
            [{"name": "sessionid", "value": "active-session", "domain": ".instagram.com"}],
            body_text="Upload a verification selfie",
        )
        page.url = "https://www.instagram.com/accounts/secure/"

        status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "need_verification")

    def test_instagram_disabled_page_is_classified_as_banned(self):
        page = _ThreadsShellPage(
            [],
            body_text="We suspended your account because it does not follow our rules.",
        )
        page.url = "https://www.instagram.com/checkpoint/disabled"

        status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "cookie_expired")
        self.assertEqual(status["health_status"], "banned")

    def test_instagram_unknown_page_without_session_is_not_ready(self):
        page = _ThreadsShellPage([])
        page.url = "https://www.instagram.com/"
        with mock.patch.object(page, "locator", return_value=_LoginStateLocator(visible=False)):
            status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "cookie_expired")

    def test_instagram_onetap_prompt_is_not_ready_even_with_visible_sidebar(self):
        page = _ThreadsShellPage(
            [{"name": "sessionid", "value": "active-session", "domain": ".instagram.com"}],
            body_text=(
                "Save your login info? We can save your login info on this browser "
                "so you don't need to enter it again. Save info Not now"
            ),
        )
        page.url = "https://www.instagram.com/accounts/onetap/"

        status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "post_login_interstitial")
        self.assertIn("onetap", status["url"])

    def test_instagram_login_page_reports_invalid_credentials_before_login_form(self):
        page = _ThreadsShellPage([], body_text="Your password was incorrect. Please try again.")
        page.url = "https://www.instagram.com/accounts/login/"

        status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "invalid_credentials")

    def test_temporary_background_page_keeps_primary_page_available(self):
        page = _PageWithBackground()
        logger = _Logger()

        with runner._temporary_background_page(
            page,
            logger,
            "baseline_probe",
            block_heavy_assets=True,
        ) as probe:
            self.assertIsNot(probe, page)
            self.assertEqual(len(page.context.pages), 1)
            self.assertEqual(probe.routes[0][0], "**/*")
            route_handler = probe.routes[0][1]
            image_route = mock.Mock()
            image_route.request.resource_type = "image"
            route_handler(image_route)
            image_route.abort.assert_called_once_with()
            script_route = mock.Mock()
            script_route.request.resource_type = "script"
            route_handler(script_route)
            script_route.continue_.assert_called_once_with()

        self.assertEqual(len(page.context.pages), 1)
        probe = page.context.pages[0]
        self.assertTrue(probe.closed)
        self.assertEqual(probe.unroutes, probe.routes)
        self.assertGreaterEqual(page.brought_to_front, 1)

    def test_check_login_reports_expired_session_as_completed_diagnostic(self):
        page = _Page()
        detected = {"status": "cookie_expired", "reason": "login prompt"}
        with (
            mock.patch.object(runner, "_check_platform_login", return_value=detected),
            mock.patch.object(runner, "_screenshot", return_value="check.png"),
        ):
            result = runner._run_check_login(
                page,
                {"id": "check-task"},
                {"id": "account-1"},
                {},
                Path("."),
                _Logger(),
                "threads",
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "cookie_expired")
        self.assertEqual(result["health_status"], "unknown")
        self.assertEqual(result["diagnostic_outcome"], "not_ready")
        self.assertEqual(result["screenshot_path"], "check.png")

    def test_check_login_reports_ready_account_as_alive(self):
        with (
            mock.patch.object(runner, "_check_platform_login", return_value={"status": "ready"}),
            mock.patch.object(runner, "_screenshot", return_value="check.png"),
        ):
            result = runner._run_check_login(
                _Page(),
                {"id": "check-task-ready"},
                {"id": "account-1"},
                {},
                Path("."),
                _Logger(),
                "threads",
            )

        self.assertEqual(result["health_status"], "alive")
        self.assertEqual(result["diagnostic_outcome"], "ready")

    def test_login_self_heal_uses_visible_retry_action_before_navigation(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        with (
            mock.patch.object(runner, "_screenshot", return_value="error.png"),
            mock.patch.object(runner, "_click_text_button", return_value=True) as click_retry,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_goto") as goto,
        ):
            runner._self_heal_login_page(
                page,
                "threads",
                _Logger(),
                {"id": "retry-error-page"},
                Path("."),
                "transient_error",
                1,
            )

        click_retry.assert_called_once()
        page.reload.assert_not_called()
        goto.assert_not_called()

    def test_threads_login_form_recovery_stays_on_instagram_login(self):
        page = mock.Mock()
        page.url = runner.INSTAGRAM_LOGIN
        with (
            mock.patch.object(runner, "_screenshot", return_value="blank.png"),
            mock.patch.object(runner, "_click_text_button", return_value=False),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_goto") as goto,
        ):
            runner._self_heal_login_page(
                page,
                "threads",
                _Logger(),
                {"id": "blank-instagram-login"},
                Path("."),
                "auto_login_form_not_ready",
                2,
            )

        goto.assert_called_once_with(
            page,
            runner.INSTAGRAM_LOGIN,
            mock.ANY,
            "login_self_heal_instagram_login",
            timeout_ms=30000,
            networkidle_ms=8000,
        )
        page.reload.assert_not_called()

    def test_default_login_self_heal_attempts_allow_multiple_page_recoveries(self):
        self.assertGreaterEqual(runner.DEFAULT_LOGIN_SELF_HEAL_ATTEMPTS, 4)

    def test_generic_persistent_context_timeout_does_not_rebuild_profile(self):
        error = RuntimeError("Timeout 30000ms exceeded while launch_persistent_context")

        self.assertFalse(runner._should_rebuild_profile_after_launch_error(error))

    def test_human_click_relocates_after_first_click_failure_without_mouse_coordinates(self):
        page = mock.Mock()
        page.viewport_size = {"width": 1600, "height": 900}
        locator = mock.Mock()
        locator.bounding_box.return_value = {"x": 100, "y": 200, "width": 120, "height": 40}
        locator.click.side_effect = [RuntimeError("layout shifted"), None]

        with mock.patch.object(runner, "_sleep_between"):
            clicked = runner._human_click(page, locator, _Logger(), "stable_login_click")

        self.assertTrue(clicked)
        self.assertEqual(locator.click.call_count, 2)
        locator.wait_for.assert_any_call(state="visible", timeout=1500)
        page.mouse.click.assert_not_called()

    def test_human_click_does_not_use_unbounded_dom_fallback_after_retry_failure(self):
        page = mock.Mock()
        page.viewport_size = {"width": 1280, "height": 720}
        locator = mock.Mock()
        locator.bounding_box.return_value = {"x": 100, "y": 200, "width": 120, "height": 40}
        locator.click.side_effect = RuntimeError("target detached")

        with mock.patch.object(runner, "_sleep_between"):
            clicked = runner._human_click(page, locator, _Logger(), "safe_social_click")

        self.assertFalse(clicked)
        locator.evaluate.assert_not_called()

    def test_live_browser_viewport_records_actual_geometry_without_resizing_page(self):
        page = mock.Mock()
        page.evaluate.return_value = {
            "screenX": 0,
            "screenY": 0,
            "outerWidth": 1600,
            "outerHeight": 900,
            "innerWidth": 1600,
            "innerHeight": 810,
            "devicePixelRatio": 1,
        }
        control = {
            "live_browser_session_id": "live-1",
            "live_browser_width": 1600,
            "live_browser_height": 900,
        }

        runner._sync_live_browser_viewport(page, control, _Logger())

        page.set_viewport_size.assert_not_called()
        self.assertEqual(control["live_browser_viewport_width"], 1600)
        self.assertEqual(control["live_browser_viewport_height"], 810)

    def test_live_browser_geometry_preserves_1080p_layout_on_larger_framebuffer(self):
        session = mock.Mock(width=1600, height=900)

        config = runner._live_browser_geometry_config(session)

        self.assertEqual(
            config,
            {
                "screen.width": 1920,
                "screen.height": 1080,
                "screen.availWidth": 1920,
                "screen.availHeight": 1019,
                "window.innerWidth": 1920,
                "window.innerHeight": 1019,
                "window.outerWidth": 1920,
                "window.outerHeight": 1080,
                "window.screenX": 0,
                "window.screenY": 0,
            },
        )
        self.assertEqual(
            runner._live_browser_viewport_size(session),
            {"width": 1920, "height": 1019},
        )

    def test_live_browser_geometry_keeps_1080p_layout_on_720p_framebuffer(self):
        session = mock.Mock(spec=[])

        config = runner._live_browser_geometry_config(session)

        self.assertEqual(config["screen.width"], 1920)
        self.assertEqual(config["screen.height"], 1080)
        self.assertEqual(config["screen.availHeight"], 1019)
        self.assertEqual(config["window.innerWidth"], 1920)
        self.assertEqual(config["window.innerHeight"], 1019)
        self.assertEqual(config["window.outerWidth"], 1920)
        self.assertEqual(config["window.outerHeight"], 1080)

    def test_threads_feed_text_with_challenge_word_is_not_verification(self):
        page = _ThreadsShellPage(
            [{"name": "sessionid", "value": "active-session", "domain": ".threads.net"}],
            body_text="Join my 30 day challenge and follow the daily updates.",
        )

        status = runner._detect_threads_login_state(page)

        self.assertEqual(status["status"], "ready")

    def test_threads_login_handoff_uses_instagram_state_detector(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        with mock.patch.object(
            runner,
            "_detect_instagram_login_state",
            return_value={"status": "need_verification"},
        ) as detect_instagram:
            status = runner._detect_platform_login_state(page, "threads")

        self.assertEqual(status["status"], "need_verification")
        detect_instagram.assert_called_once_with(page)

    def test_threads_auto_login_checks_existing_session_before_instagram_login(self):
        page = mock.Mock()
        page.url = runner.THREADS_HOME
        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "ready"}) as detect,
            mock.patch.object(runner, "_confirm_platform_ready", return_value={"status": "ready"}),
            mock.patch.object(runner, "_screenshot", return_value="login-complete.png"),
        ):
            result = runner._run_open_login(
                page,
                {"id": "threads-existing-session"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                Path("."),
                _Logger(),
                "threads",
            )

        self.assertEqual(result["status"], "ready")
        detect.assert_called()
        self.assertNotIn(runner.INSTAGRAM_LOGIN, [call.args[1] for call in goto.call_args_list])

    def test_threads_auto_login_prefers_saved_credentials_before_official_handoff(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/login"
        logger = _Logger()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                side_effect=[
                    {
                        "status": "account_confirmation_required",
                        "url": page.url,
                    },
                    {"status": "ready", "url": runner.THREADS_HOME},
                ],
            ),
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(runner, "_auto_submit_login_form", return_value=True) as submit,
            mock.patch.object(runner, "_confirm_platform_ready", return_value={"status": "ready"}),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="login-complete.png"),
        ):
            result = runner._run_open_login(
                page,
                {"id": "threads-official-account-confirmation"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                Path("."),
                logger,
                "threads",
            )

        self.assertEqual(result["status"], "ready")
        click.assert_not_called()
        submit.assert_called_once()

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

    def test_manual_login_timeout_uses_payload_default_and_clamped_bounds(self):
        cases = [
            ({}, 300),
            ({"manual_login_timeout_seconds": 1}, 300),
            ({"manual_login_timeout_seconds": 9999}, 1800),
            ({"manual_login_timeout_seconds": "invalid"}, 300),
        ]
        for payload, expected_timeout in cases:
            with self.subTest(payload=payload):
                page = mock.Mock()
                logger = _RecordingLogger()
                with (
                    mock.patch.object(runner.time, "monotonic", side_effect=[0.0, float(expected_timeout)]),
                    mock.patch.object(runner, "_screenshot", return_value="manual-timeout.png") as screenshot,
                ):
                    with self.assertRaises(runner.AutoLoginFailedError) as raised:
                        runner._wait_for_manual_login_completion(
                            page,
                            {"id": "manual-timeout", "task_type": "publish_post", "payload": payload},
                            Path("."),
                            logger,
                            "threads",
                            None,
                            "manual login required",
                        )

                self.assertEqual(raised.exception.status, "cookie_expired")
                self.assertEqual(raised.exception.screenshot_path, "manual-timeout.png")
                self.assertIn(str(expected_timeout // 60), str(raised.exception))
                screenshot.assert_called_once_with(page, Path("."), mock.ANY, "manual_login_timeout", logger)
                timeout_entry = next(entry for entry in logger.entries if entry[0][1] == "manual_login_timeout")
                self.assertEqual(timeout_entry[0][3]["timeout_seconds"], expected_timeout)

    def test_manual_login_wait_uses_cancel_event_for_immediate_cancellation(self):
        page = mock.Mock()
        cancel_event = mock.Mock()
        cancel_event.is_set.side_effect = [False, True]
        cancel_event.wait.return_value = True
        with (
            mock.patch.object(runner.time, "monotonic", return_value=10.0),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "need_verification"}),
            mock.patch.object(runner.time, "sleep") as sleep,
        ):
            with self.assertRaises(RuntimeError):
                runner._wait_for_manual_login_completion(
                    page,
                    {"id": "manual-cancel", "payload": {"manual_login_timeout_seconds": 300}},
                    Path("."),
                    _Logger(),
                    "instagram",
                    cancel_event,
                    "manual login required",
                )

        cancel_event.wait.assert_called_once_with(1.0)
        sleep.assert_not_called()

    def test_manual_login_success_logic_is_preserved_before_timeout(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        with (
            mock.patch.object(runner.time, "monotonic", return_value=1.0),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "ready"}),
            mock.patch.object(runner, "_confirm_platform_ready", return_value={"status": "ready"}),
            mock.patch.object(runner, "_screenshot", return_value="complete.png"),
        ):
            result = runner._wait_for_manual_login_completion(
                page,
                {"id": "manual-success", "payload": {"manual_login_timeout_seconds": 300}},
                Path("."),
                _Logger(),
                "threads",
                None,
                "manual login required",
            )

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["screenshot_path"], "complete.png")

    def test_manual_login_hard_deadline_wins_over_late_ready_result(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        with (
            mock.patch.object(runner.time, "monotonic", side_effect=[0.0, 1.0, 1.0, 1.0, 300.0]),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "ready"}),
            mock.patch.object(runner, "_confirm_platform_ready", return_value={"status": "ready"}),
            mock.patch.object(runner, "_screenshot", return_value="late-timeout.png"),
        ):
            with self.assertRaises(runner.AutoLoginFailedError) as raised:
                runner._wait_for_manual_login_completion(
                    page,
                    {"id": "late-ready", "payload": {"manual_login_timeout_seconds": 300}},
                    Path("."),
                    _Logger(),
                    "threads",
                    None,
                    "manual login required",
                )

        self.assertEqual(raised.exception.status, "cookie_expired")
        self.assertEqual(raised.exception.screenshot_path, "late-timeout.png")

    def test_manual_login_timeout_exception_releases_browser_context(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        timeout_error = runner.AutoLoginFailedError("timed out", "manual_login_timeout", "timeout.png")
        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_run_open_login", side_effect=timeout_error),
        ):
            with self.assertRaises(runner.AutoLoginFailedError):
                runner.run_social_task(
                    task={"id": "manual-timeout", "task_type": "open_login", "platform": "threads", "payload": {}},
                    account={"platform": "threads"},
                    proxy=None,
                    data_dir=Path("."),
                    logger=_Logger(),
                )

        self.assertIs(manager.__exit__.call_args.args[0], runner.AutoLoginFailedError)

    def test_closed_manual_browser_fails_instead_of_leaving_unresolvable_manual_task(self):
        page = mock.Mock()
        page.title.side_effect = RuntimeError("Target page, context or browser has been closed")

        with self.assertRaises(runner.AutoLoginFailedError) as raised:
            runner._wait_for_manual_login_completion(
                page,
                {"id": "closed-manual", "payload": {"manual_login_timeout_seconds": 300}},
                Path("."),
                _Logger(),
                "threads",
                None,
                "manual login required",
                "need_verification",
                "challenge.png",
            )

        self.assertEqual(raised.exception.status, "cookie_expired")
        self.assertEqual(raised.exception.screenshot_path, "challenge.png")

    def test_running_auto_login_stops_immediately_after_manual_takeover(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/login/"
        event = threading.Event()
        ack_event = threading.Event()
        totp_provider = mock.Mock(
            return_value={"available": True, "code": "123456", "counter": 100}
        )
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
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                Path("."),
                _Logger(),
                "threads",
                context_control={
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                    "totp_code_provider": totp_provider,
                },
            )

        self.assertEqual(result["status"], "manual")
        wait_manual.assert_called_once()
        submit.assert_not_called()
        totp_provider.assert_not_called()
        self.assertTrue(ack_event.is_set())

    def test_verification_switches_auto_login_to_manual_mode(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        event = threading.Event()
        ack_event = threading.Event()
        account_status = mock.Mock()
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
                    "account_login_status_callback": account_status,
                },
            )

        self.assertEqual(result["status"], "need_verification")
        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        account_status.assert_called_once_with("need_verification")
        self_heal.assert_not_called()

    def test_authenticator_challenge_uses_stored_totp_once_and_marks_success(self):
        page, _body = self._totp_verification_page(
            "Enter the 6-digit code from your authentication app."
        )
        self.assertEqual(
            runner._classify_verification_challenge(page)["type"],
            "authenticator_totp",
        )
        provider = mock.Mock(
            return_value={
                "available": True,
                "code": "123456",
                "counter": 100,
                "expires_at": 3030,
                "valid_for_seconds": 20,
            }
        )
        states = [
            {
                "status": "need_verification",
                "text": "Enter the 6-digit code from your authentication app.",
                "verification_method": "authenticator",
            },
            {"status": "ready", "text": "Instagram home"},
        ]
        result, outcome, wait_manual = self._run_totp_case(
            "totp-success",
            states,
            provider,
        )

        self.assertEqual(result["status"], "ready")
        provider.assert_called_once_with()
        outcome.assert_called_with("verified")
        wait_manual.assert_not_called()

    def test_authenticator_challenge_detects_unlabelled_code_input(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/login/two_step_verification"
        body = mock.Mock()
        body.inner_text.return_value = (
            "Go to your authentication app. Enter the 6-digit code. "
            "Trust this device. Try another way."
        )
        missing = mock.Mock()
        missing.first = missing
        missing.count.return_value = 0
        code_input = mock.Mock()
        code_input.first = code_input
        code_input.count.return_value = 1
        code_input.is_visible.return_value = True

        def locator(selector):
            if selector == "body":
                return body
            if selector == runner.GENERIC_VERIFICATION_CODE_INPUT_SELECTOR:
                return code_input
            return missing

        page.locator.side_effect = locator

        challenge = runner._classify_verification_challenge(page)

        self.assertEqual(challenge["type"], "authenticator_totp")
        self.assertTrue(challenge["has_code_input"])
        self.assertIs(challenge["code_input"], code_input)

    def test_authenticator_challenge_waits_for_delayed_code_input_before_manual_fallback(self):
        page, _body = self._totp_verification_page(
            "Go to your authentication app."
        )
        page.url = "https://www.instagram.com/accounts/login/two_step_verification"
        code_input = page.locator('input[autocomplete="one-time-code"]')
        provider = mock.Mock(
            return_value={
                "available": True,
                "code": "123456",
                "counter": 100,
                "expires_at": 3030,
                "valid_for_seconds": 20,
            }
        )
        outcome = mock.Mock()
        unknown = {
            "type": "unknown_challenge",
            "url": page.url,
            "has_code_input": False,
            "code_input": None,
        }
        authenticator = {
            "type": "authenticator_totp",
            "url": page.url,
            "has_code_input": True,
            "code_input": code_input,
        }

        with (
            mock.patch.object(
                runner,
                "_classify_verification_challenge",
                side_effect=[unknown, authenticator, authenticator],
            ),
            mock.patch.object(runner, "_wait_interruptibly", return_value=True),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                return_value={"status": "ready"},
            ),
            mock.patch.object(
                runner,
                "_confirm_platform_ready",
                return_value={"status": "ready"},
            ),
            mock.patch.object(runner.time, "time", return_value=3000),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            result = runner._try_auto_totp_challenge(
                page,
                {"id": "totp-delayed-input"},
                Path("."),
                _Logger(),
                "instagram",
                None,
                {
                    "manual_takeover_event": threading.Event(),
                    "totp_code_provider": provider,
                    "totp_outcome_callback": outcome,
                },
            )

        self.assertEqual(result["status"], "ready")
        provider.assert_called_once_with()
        outcome.assert_called_once_with("verified")

    def test_totp_submit_waits_through_stale_verification_state_until_ready(self):
        page, _body = self._totp_verification_page(
            "Enter the 6-digit code from your authentication app."
        )
        page.url = "https://www.instagram.com/accounts/login/two_step_verification"
        code_input = page.locator('input[autocomplete="one-time-code"]')
        authenticator = {
            "type": "authenticator_totp",
            "url": page.url,
            "has_code_input": True,
            "code_input": code_input,
        }
        transitioned = {
            "type": "none",
            "url": "https://www.instagram.com/accounts/onetap/",
            "has_code_input": False,
            "code_input": None,
        }
        provider = mock.Mock(
            return_value={
                "available": True,
                "code": "123456",
                "counter": 100,
                "expires_at": 3030,
                "valid_for_seconds": 20,
            }
        )
        outcome = mock.Mock()

        with (
            mock.patch.object(
                runner,
                "_classify_verification_challenge",
                side_effect=[authenticator, authenticator, transitioned],
            ),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                side_effect=[
                    {"status": "need_verification"},
                    {"status": "ready"},
                ],
            ),
            mock.patch.object(
                runner,
                "_confirm_platform_ready",
                return_value={"status": "ready"},
            ),
            mock.patch.object(runner, "_wait_interruptibly", return_value=True),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner.time, "monotonic", side_effect=range(100)),
            mock.patch.object(runner.time, "time", return_value=3000),
        ):
            result = runner._try_auto_totp_challenge(
                page,
                {"id": "totp-stale-transition"},
                Path("."),
                _Logger(),
                "instagram",
                None,
                {
                    "totp_code_provider": provider,
                    "totp_outcome_callback": outcome,
                },
            )

        self.assertEqual(result["status"], "ready")
        provider.assert_called_once_with()
        outcome.assert_called_once_with("verified")

    def test_totp_expiring_before_submit_is_cleared_and_replaced_next_period(self):
        page, _body = self._totp_verification_page(
            "Enter the 6-digit code from your authentication app."
        )
        code_input = page.locator('input[autocomplete="one-time-code"]')
        provider = mock.Mock(
            side_effect=[
                {
                    "available": True,
                    "code": "123456",
                    "counter": 100,
                    "expires_at": 1002,
                    "valid_for_seconds": 15,
                },
                {
                    "available": True,
                    "code": "654321",
                    "counter": 101,
                    "expires_at": 1030,
                    "valid_for_seconds": 27,
                },
            ]
        )
        outcome = mock.Mock()
        events = []
        clock = {"now": 1000.0}

        def record_input(_page, _locator, value, **_kwargs):
            events.append(("fill", value))

        def clear_input(_page, locator):
            self.assertIs(locator, code_input)
            events.append(("clear", None))

        def wait_interruptibly(seconds, _cancel_event, _context_control):
            events.append(("wait", seconds))
            if seconds > 1:
                clock["now"] = 1003.0
            return True

        def click_submit(*_args, **_kwargs):
            events.append(("submit", None))
            return True

        with (
            mock.patch.object(
                runner,
                "_classify_verification_challenge",
                return_value={
                    "type": "authenticator_totp",
                    "url": str(page.url),
                    "has_code_input": True,
                    "code_input": code_input,
                },
            ),
            mock.patch.object(runner, "_page_body_text_lower", return_value=""),
            mock.patch.object(runner, "_clear_and_type", side_effect=record_input),
            mock.patch.object(
                runner,
                "_clear_verification_code",
                side_effect=clear_input,
            ),
            mock.patch.object(
                runner,
                "_wait_interruptibly",
                side_effect=wait_interruptibly,
            ),
            mock.patch.object(
                runner,
                "_click_text_button",
                side_effect=click_submit,
            ) as submit,
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                return_value={"status": "ready"},
            ),
            mock.patch.object(
                runner,
                "_confirm_platform_ready",
                return_value={"status": "ready"},
            ),
            mock.patch.object(runner.time, "time", side_effect=lambda: clock["now"]),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            result = runner._try_auto_totp_challenge(
                page,
                {"id": "totp-period-rollover"},
                Path("."),
                _Logger(),
                "instagram",
                None,
                {
                    "manual_takeover_event": threading.Event(),
                    "totp_code_provider": provider,
                    "totp_outcome_callback": outcome,
                },
            )

        self.assertEqual(result["status"], "ready")
        self.assertEqual(provider.call_count, 2)
        self.assertEqual(
            [event for event in events if event[0] in {"fill", "clear", "submit"}],
            [
                ("fill", "123456"),
                ("clear", None),
                ("fill", "654321"),
                ("submit", None),
            ],
        )
        submit.assert_called_once()
        self.assertNotIn("Enter", page.keyboard.pressed)
        outcome.assert_called_once_with("verified")

    def test_sms_email_and_unknown_challenges_never_use_stored_totp(self):
        cases = (
            ("sms", "Enter the code we sent to your phone via SMS."),
            ("email", "Enter the security code sent to your email address."),
            ("unknown", "Confirm it is you to continue."),
        )
        for verification_method, text in cases:
            with self.subTest(verification_method=verification_method):
                page, _body = self._totp_verification_page(text)
                expected_type = {
                    "sms": "sms_code",
                    "email": "email_code",
                    "unknown": "unknown_code",
                }[verification_method]
                self.assertEqual(
                    runner._classify_verification_challenge(page)["type"],
                    expected_type,
                )
                provider = mock.Mock(
                    return_value={"available": True, "code": "123456", "counter": 100}
                )
                states = [
                    {
                        "status": "need_verification",
                        "text": text,
                        "verification_method": verification_method,
                    }
                ]
                result, outcome, wait_manual = self._run_totp_case(
                    f"totp-{verification_method}",
                    states,
                    provider,
                )

                self.assertEqual(result["status"], "need_verification")
                provider.assert_not_called()
                outcome.assert_not_called()
                wait_manual.assert_called_once()

    def test_explicit_incorrect_totp_goes_manual_without_second_code(self):
        provider = mock.Mock(
            return_value={"available": True, "code": "123456", "counter": 100}
        )
        states = [
            {
                "status": "need_verification",
                "text": "Enter the 6-digit code from your authentication app.",
                "verification_method": "authenticator",
            },
            {
                "status": "need_verification",
                "text": "Incorrect code. Try again.",
                "verification_method": "authenticator",
            },
        ]
        result, outcome, wait_manual = self._run_totp_case(
            "totp-incorrect",
            states,
            provider,
        )

        self.assertEqual(result["status"], "need_verification")
        provider.assert_called_once_with()
        self.assertIn(outcome.call_args.args[0], {"invalid", "rejected"})
        wait_manual.assert_called_once()

    def test_ambiguous_authenticator_result_goes_manual_without_second_code(self):
        prompt = "Enter the 6-digit code from your authentication app."
        provider = mock.Mock(
            return_value={"available": True, "code": "123456", "counter": 100}
        )
        states = [
            {
                "status": "need_verification",
                "text": prompt,
                "verification_method": "authenticator",
            },
            {
                "status": "need_verification",
                "text": prompt,
                "verification_method": "authenticator",
            },
        ]
        result, outcome, wait_manual = self._run_totp_case(
            "totp-ambiguous",
            states,
            provider,
        )

        self.assertEqual(result["status"], "need_verification")
        provider.assert_called_once_with()
        self.assertNotIn(
            "expired",
            [call.args[0] for call in outcome.call_args_list],
        )
        wait_manual.assert_called_once()

    def test_only_explicit_expiry_allows_one_next_totp_counter_with_max_two_attempts(self):
        provider = mock.Mock(
            side_effect=[
                {"available": True, "code": "123456", "counter": 100},
                {"available": True, "code": "654321", "counter": 101},
            ]
        )
        states = [
            {
                "status": "need_verification",
                "text": "Enter the 6-digit code from your authentication app.",
                "verification_method": "authenticator",
            },
            {
                "status": "need_verification",
                "text": "That code has expired. Request a new code.",
                "verification_method": "authenticator",
            },
            {
                "status": "need_verification",
                "text": "That code has expired. Request a new code.",
                "verification_method": "authenticator",
            },
        ]
        result, outcome, wait_manual = self._run_totp_case(
            "totp-expired-twice",
            states,
            provider,
        )

        self.assertEqual(result["status"], "need_verification")
        self.assertEqual(provider.call_count, 2)
        self.assertEqual(
            [call.args[0] for call in outcome.call_args_list].count("expired"),
            2,
        )
        wait_manual.assert_called_once()

    def test_publish_totp_transition_does_not_trigger_self_heal_or_reload(self):
        for status in ("totp_submitted", "account_confirmation_required"):
            with self.subTest(status=status):
                page = mock.Mock()
                page.url = "https://www.instagram.com/challenge/"
                totp_result = {
                    "status": status,
                    "reason": "TOTP accepted; platform redirect is still settling.",
                }
                with (
                    mock.patch.object(
                        runner,
                        "_try_auto_totp_challenge",
                        return_value=totp_result,
                    ),
                    mock.patch.object(
                        runner,
                        "_detect_platform_login_state",
                        return_value={"status": status},
                    ) as detect,
                    mock.patch.object(runner, "_self_heal_login_page") as self_heal,
                ):
                    result = runner._attempt_publish_login_repair(
                        page,
                        {"id": f"publish-{status}", "task_type": "publish_post"},
                        {"login_password": "saved-password"},
                        {"publish_login_repair_attempts": 3},
                        Path("."),
                        _Logger(),
                        "instagram",
                        None,
                        {"status": "need_verification"},
                        {"totp_code_provider": mock.Mock()},
                    )

                self.assertEqual(result["status"], status)
                detect.assert_not_called()
                self_heal.assert_not_called()
                page.reload.assert_not_called()

    def test_totp_challenge_logs_strip_query_and_fragment(self):
        page, _body = self._totp_verification_page(
            "Enter the 6-digit code from your authentication app."
        )
        page.url = (
            "https://www.instagram.com/challenge/two_factor/"
            "?encrypted_context=top-secret&challenge_context=private"
            "#verification-fragment"
        )
        code_input = page.locator('input[autocomplete="one-time-code"]')
        challenge = {
            "type": "authenticator_totp",
            "url": page.url,
            "has_code_input": True,
            "code_input": code_input,
        }
        logger = _RecordingLogger()
        outcome = mock.Mock()
        with (
            mock.patch.object(
                runner,
                "_classify_verification_challenge",
                return_value=challenge,
            ),
            mock.patch.object(
                runner,
                "_page_body_text_lower",
                return_value="enter the 6-digit code from your authentication app.",
            ),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner, "_wait_interruptibly", return_value=True),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                return_value={"status": "ready"},
            ),
            mock.patch.object(
                runner,
                "_confirm_platform_ready",
                return_value={"status": "ready"},
            ),
        ):
            result = runner._try_auto_totp_challenge(
                page,
                {"id": "totp-log-redaction"},
                Path("."),
                logger,
                "instagram",
                None,
                {
                    "totp_code_provider": mock.Mock(
                        return_value={
                            "available": True,
                            "code": "123456",
                            "counter": 100,
                        }
                    ),
                    "totp_outcome_callback": outcome,
                },
            )

        self.assertEqual(result["status"], "ready")
        outcome.assert_called_with("verified")
        logged_urls = [
            str(args[3]["url"])
            for args, _kwargs in logger.entries
            if len(args) > 3
            and isinstance(args[3], dict)
            and "url" in args[3]
        ]
        self.assertTrue(logged_urls)
        for logged_url in logged_urls:
            self.assertEqual(
                logged_url,
                "https://www.instagram.com/challenge/two_factor/",
            )
            self.assertNotIn("encrypted_context", logged_url)
            self.assertNotIn("challenge_context", logged_url)
            self.assertNotIn("#", logged_url)

    def test_totp_method_switch_does_not_report_configuration_failure(self):
        for challenge_type in ("sms_code", "email_code", "method_selection"):
            with self.subTest(challenge_type=challenge_type):
                page, _body = self._totp_verification_page(
                    "Enter the 6-digit code from your authentication app."
                )
                code_input = page.locator('input[autocomplete="one-time-code"]')
                authenticator = {
                    "type": "authenticator_totp",
                    "url": page.url,
                    "has_code_input": True,
                    "code_input": code_input,
                }
                switched = {
                    "type": challenge_type,
                    "url": page.url,
                    "has_code_input": challenge_type != "method_selection",
                    "code_input": (
                        code_input if challenge_type != "method_selection" else None
                    ),
                }
                outcome = mock.Mock()
                with (
                    mock.patch.object(
                        runner,
                        "_classify_verification_challenge",
                        side_effect=[authenticator, authenticator, switched],
                    ),
                    mock.patch.object(
                        runner,
                        "_page_body_text_lower",
                        return_value="choose another verification method",
                    ),
                    mock.patch.object(runner, "_clear_and_type"),
                    mock.patch.object(runner, "_clear_verification_code"),
                    mock.patch.object(runner, "_click_text_button", return_value=True),
                    mock.patch.object(runner, "_wait_interruptibly", return_value=True),
                    mock.patch.object(
                        runner,
                        "_detect_platform_login_state",
                        return_value={
                            "status": "need_verification",
                            "reason": "A different verification method is required.",
                        },
                    ),
                ):
                    result = runner._try_auto_totp_challenge(
                        page,
                        {"id": f"totp-switch-{challenge_type}"},
                        Path("."),
                        _Logger(),
                        "instagram",
                        None,
                        {
                            "totp_code_provider": mock.Mock(
                                return_value={
                                    "available": True,
                                    "code": "123456",
                                    "counter": 100,
                                }
                            ),
                            "totp_outcome_callback": outcome,
                        },
                    )

                self.assertEqual(result["status"], "need_verification")
                outcomes = [str(call.args[0]) for call in outcome.call_args_list]
                self.assertNotIn("failed", outcomes)
                self.assertNotIn("error", outcomes)

    def test_delayed_totp_success_marks_configuration_verified(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        outcome = mock.Mock()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                side_effect=[
                    {"status": "need_verification"},
                    {"status": "ready"},
                ],
            ),
            mock.patch.object(
                runner,
                "_verification_visible",
                return_value=True,
            ),
            mock.patch.object(
                runner,
                "_try_auto_totp_challenge",
                return_value={
                    "status": "totp_submitted",
                    "challenge_type": "none",
                },
            ),
            mock.patch.object(
                runner,
                "_confirm_platform_ready",
                return_value={"status": "ready"},
            ),
            mock.patch.object(
                runner,
                "_screenshot",
                return_value="login-complete.png",
            ),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
            mock.patch.object(runner.time, "time", return_value=0),
        ):
            result = runner._run_open_login(
                page,
                {"id": "totp-delayed-success"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                },
                Path("."),
                _Logger(),
                "instagram",
                context_control={
                    "manual_takeover_event": threading.Event(),
                    "manual_takeover_ack_event": threading.Event(),
                    "totp_code_provider": mock.Mock(),
                    "totp_outcome_callback": outcome,
                },
            )

        self.assertEqual(result["status"], "ready")
        outcome.assert_called_with("verified")
        self_heal.assert_not_called()

    def test_open_login_dismisses_instagram_onetap_before_declaring_ready(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/onetap/"
        interstitial = {
            "status": "post_login_interstitial",
            "reason": "Save your login info prompt is blocking the page.",
            "url": page.url,
        }
        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                side_effect=[interstitial, {"status": "ready"}],
            ),
            mock.patch.object(
                runner,
                "_resolve_instagram_post_login_interstitial",
                return_value=True,
            ) as resolve_interstitial,
            mock.patch.object(
                runner,
                "_confirm_platform_ready",
                return_value={"status": "ready"},
            ),
            mock.patch.object(runner, "_screenshot", return_value="login-complete.png"),
            mock.patch.object(runner.time, "time", return_value=0),
        ):
            result = runner._run_open_login(
                page,
                {"id": "instagram-onetap"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": False,
                },
                Path("."),
                _Logger(),
                "instagram",
            )

        self.assertEqual(result["status"], "ready")
        resolve_interstitial.assert_called_once_with(page, mock.ANY)
        goto.assert_called_once()

    def test_instagram_onetap_saves_login_info_then_handles_optional_prompt(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/onetap/"
        with (
            mock.patch.object(
                runner,
                "_page_body_text_lower",
                return_value="save your login info? save info not now",
            ),
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(runner, "_dismiss_instagram_interstitials", return_value=True) as dismiss,
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_sleep_between"),
        ):
            resolved = runner._resolve_instagram_post_login_interstitial(page, _Logger())

        self.assertTrue(resolved)
        self.assertEqual(click.call_args.args[3], "instagram_save_login_info")
        self.assertIn("Save info", click.call_args.args[2])
        dismiss.assert_called_once_with(page, mock.ANY)
        goto.assert_called_once_with(
            page,
            runner.INSTAGRAM_HOME,
            mock.ANY,
            "instagram_post_login_home",
        )

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
                        "login_username": "saved-user",
                        "login_password": "saved-password",
                        "submit_grace_seconds": 30,
                    },
                    Path("."),
                    _Logger(),
                    "instagram",
                    cancel_event=cancel_event,
                )

        submit.assert_called_once()
        self_heal.assert_not_called()

    def test_auto_login_preserves_failed_page_after_submit_grace_expires(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/login"
        context_control = {
            "manual_takeover_event": threading.Event(),
            "manual_takeover_ack_event": threading.Event(),
        }

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_detect_platform_login_state",
                return_value={"status": "cookie_expired", "url": page.url},
            ),
            mock.patch.object(runner, "_auto_submit_login_form", return_value=True) as submit,
            mock.patch.object(runner, "_verification_visible", return_value=False),
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
            mock.patch.object(runner, "_screenshot", return_value="failed-login.png"),
            mock.patch.object(
                runner,
                "_wait_for_manual_login_completion",
                return_value={"status": "need_manual"},
            ) as wait_manual,
            mock.patch.object(runner.time, "time", return_value=0),
            mock.patch.object(runner.time, "monotonic", side_effect=[100, 131]),
        ):
            result = runner._run_open_login(
                page,
                {"id": "preserve-failed-login"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                    "max_login_attempts": 1,
                    "max_self_heal_attempts": 0,
                    "submit_grace_seconds": 30,
                },
                Path("."),
                _Logger(),
                "threads",
                context_control=context_control,
            )

        self.assertEqual(result["status"], "need_manual")
        submit.assert_called_once()
        self_heal.assert_not_called()
        wait_manual.assert_called_once()
        self.assertEqual(page.url, "https://www.threads.com/login")
        self.assertTrue(context_control["manual_takeover_event"].is_set())

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

    def test_invalid_credentials_immediately_switches_to_manual_without_retry(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/login/"
        event = threading.Event()
        ack_event = threading.Event()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "invalid_credentials"}),
            mock.patch.object(runner, "_verification_visible", return_value=False),
            mock.patch.object(runner, "_screenshot", return_value="invalid.png"),
            mock.patch.object(runner, "_wait_for_manual_login_completion", return_value={"status": "invalid_credentials"}) as wait_manual,
            mock.patch.object(runner, "_auto_submit_login_form") as submit,
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
        ):
            result = runner._run_open_login(
                page,
                {"id": "invalid-credentials"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "wait_for_manual": True,
                    "manual_only_on_verification": True,
                },
                Path("."),
                _Logger(),
                "instagram",
                context_control={
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                },
            )

        self.assertEqual(result["status"], "invalid_credentials")
        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        wait_manual.assert_called_once()
        submit.assert_not_called()
        self_heal.assert_not_called()

    def test_exhausted_automatic_recovery_switches_to_manual(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/login/"
        event = threading.Event()
        ack_event = threading.Event()
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_detect_platform_login_state", return_value={"status": "transient_error"}),
            mock.patch.object(runner, "_verification_visible", return_value=False),
            mock.patch.object(runner, "_screenshot", return_value="exhausted.png"),
            mock.patch.object(runner, "_wait_for_manual_login_completion", return_value={"status": "manual"}) as wait_manual,
            mock.patch.object(runner, "_self_heal_login_page") as self_heal,
        ):
            result = runner._run_open_login(
                page,
                {"id": "recovery-exhausted"},
                {},
                {
                    "login_wait_seconds": 30,
                    "auto_submit": True,
                    "login_username": "saved-user",
                    "login_password": "saved-password",
                    "max_login_attempts": 1,
                    "max_self_heal_attempts": 0,
                },
                Path("."),
                _Logger(),
                "instagram",
                context_control={
                    "manual_takeover_event": event,
                    "manual_takeover_ack_event": ack_event,
                },
            )

        self.assertEqual(result["status"], "manual")
        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        self_heal.assert_not_called()
        wait_manual.assert_called_once()

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

    def test_instagram_remembered_profile_continues_without_retyping_credentials(self):
        page = _Page(url="https://www.instagram.com/accounts/login/")
        payload = {"login_username": "windzlc123", "login_password": "saved-password"}
        with (
            mock.patch.object(
                runner,
                "_page_body_text_lower",
                return_value="windzlc123 continue use another profile create new account",
            ),
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(runner, "_visible_first") as visible_first,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="remembered.png"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "instagram",
                payload,
                _Logger(),
                {"id": "remembered-profile-login"},
                Path("."),
            )

        self.assertTrue(submitted)
        click.assert_called_once_with(
            page,
            mock.ANY,
            ["Continue", "继续"],
            "instagram_remembered_profile_continue",
            abort_if=mock.ANY,
        )
        visible_first.assert_not_called()
        self.assertEqual(page.keyboard.typed, [])
        self.assertTrue(payload["_instagram_remembered_profile_continue_attempted"])

    def test_instagram_remembered_profile_falls_back_to_password_after_continue_stalls(self):
        page = _Page(url="https://www.instagram.com/accounts/login/")
        username_input = _Locator()
        password_input = _Locator()
        payload = {
            "login_username": "windzlc123",
            "login_password": "saved-password",
            "_instagram_remembered_profile_continue_attempted": True,
        }
        with (
            mock.patch.object(
                runner,
                "_page_body_text_lower",
                return_value="windzlc123 continue use another profile create new account",
            ),
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(
                runner,
                "_visible_first",
                side_effect=[username_input, password_input],
            ),
            mock.patch.object(runner, "_clear_and_type") as type_text,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="remembered.png"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "instagram",
                payload,
                _Logger(),
                {"id": "remembered-profile-password-fallback"},
                Path("."),
            )

        self.assertTrue(submitted)
        self.assertEqual(
            [call.args[3] for call in click.call_args_list],
            ["instagram_remembered_profile_switch", "auto_login_submit"],
        )
        self.assertEqual(
            [call.args[2] for call in type_text.call_args_list],
            ["windzlc123", "saved-password"],
        )

    def test_system_manual_takeover_notifies_persistence_callback(self):
        event = threading.Event()
        ack_event = threading.Event()
        callback = mock.Mock()
        control = {
            "manual_takeover_event": event,
            "manual_takeover_ack_event": ack_event,
            "manual_takeover_callback": callback,
            "takeover_waiting_for": "threads_before_submit",
        }

        runner._request_manual_takeover(control)

        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())
        self.assertEqual(control["takeover_waiting_for"], "manual_ready")
        callback.assert_called_once_with()

    def test_late_user_takeover_ack_always_notifies_persistence_callback(self):
        event = threading.Event()
        event.set()
        ack_event = threading.Event()
        callback = mock.Mock()

        requested = runner._manual_takeover_requested({
            "manual_takeover_event": event,
            "manual_takeover_ack_event": ack_event,
            "manual_takeover_callback": callback,
        })

        self.assertTrue(requested)
        self.assertTrue(ack_event.is_set())
        callback.assert_called_once_with()

    def test_manual_takeover_ack_retries_persistence_before_unlocking_input(self):
        event = threading.Event()
        ack_event = threading.Event()
        callback = mock.Mock(side_effect=[OSError("busy"), OSError("busy"), True])

        with mock.patch.object(runner.time, "sleep") as sleep:
            runner._request_manual_takeover({
                "manual_takeover_event": event,
                "manual_takeover_ack_event": ack_event,
                "manual_takeover_callback": callback,
            })

        self.assertEqual(callback.call_count, 3)
        self.assertTrue(ack_event.is_set())
        self.assertEqual(sleep.call_count, 2)

    def test_manual_takeover_persistence_failure_keeps_input_locked(self):
        event = threading.Event()
        ack_event = threading.Event()
        callback = mock.Mock(return_value=False)

        with (
            mock.patch.object(runner.time, "sleep"),
            self.assertRaisesRegex(RuntimeError, "人工接管状态持久化失败"),
        ):
            runner._request_manual_takeover({
                "manual_takeover_event": event,
                "manual_takeover_ack_event": ack_event,
                "manual_takeover_callback": callback,
            })

        self.assertTrue(event.is_set())
        self.assertFalse(ack_event.is_set())

    def test_manual_resume_persistence_failure_keeps_manual_events_set(self):
        event = threading.Event()
        ack_event = threading.Event()
        event.set()
        ack_event.set()

        with self.assertRaisesRegex(RuntimeError, "人工验证恢复状态持久化失败"):
            runner._resume_after_manual_takeover({
                "manual_takeover_event": event,
                "manual_takeover_ack_event": ack_event,
                "manual_takeover_resolved_callback": mock.Mock(return_value=False),
            })

        self.assertTrue(event.is_set())
        self.assertTrue(ack_event.is_set())

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

    def test_manual_threads_login_never_falls_back_to_instagram(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        logger = _Logger()
        with (
            mock.patch.object(runner, "_detect_threads_login_state", return_value={"status": "cookie_expired"}),
            mock.patch.object(runner, "_click_text_button", return_value=False),
            mock.patch.object(runner, "_goto") as goto,
        ):
            runner._prepare_manual_threads_login_page(page, logger)

        goto.assert_not_called()

    def test_threads_auto_login_never_forces_instagram_when_native_entry_is_missing(self):
        page = _Page(url="https://www.threads.com/")
        with (
            mock.patch.object(runner, "_click_text_button", return_value=False),
            mock.patch.object(runner, "_visible_first", return_value=None),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="missing.png"),
            mock.patch.object(runner, "_goto") as goto,
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "threads",
                {"login_username": "saved-user", "login_password": "saved-password"},
                _Logger(),
                {"id": "threads-native-entry-missing"},
                Path("."),
            )

        self.assertFalse(submitted)
        goto.assert_not_called()

    def test_threads_auto_login_fills_visible_native_form_before_clicking_handoff(self):
        page = _Page(url="https://www.threads.com/login")
        username_input = _Locator()
        password_input = _Locator()
        with (
            mock.patch.object(
                runner,
                "_visible_first",
                side_effect=[
                    username_input,
                    password_input,
                    username_input,
                    password_input,
                ],
            ),
            mock.patch.object(runner, "_clear_and_type") as type_text,
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner.time, "sleep"),
            mock.patch.object(runner, "_screenshot", return_value="native-login.png"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "threads",
                {"login_username": "saved-user", "login_password": "saved-password"},
                _Logger(),
                {"id": "threads-visible-native-form"},
                Path("."),
            )

        self.assertTrue(submitted)
        self.assertEqual(
            [call.args[2] for call in type_text.call_args_list],
            ["saved-user", "saved-password"],
        )
        self.assertEqual([call.args[3] for call in click.call_args_list], ["auto_login_submit"])

    def test_threads_auto_login_uses_official_handoff_only_after_native_form_is_missing(self):
        page = _Page(url="https://www.threads.com/login")
        payload = {"login_username": "saved-user", "login_password": "saved-password"}
        with (
            mock.patch.object(runner, "_visible_first", return_value=None),
            mock.patch.object(
                runner,
                "_click_text_button",
                side_effect=[False, False, False],
            ) as click,
            mock.patch.object(runner, "_click_threads_instagram_login_entry", return_value=True) as handoff,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="handoff.png"),
            mock.patch.object(runner, "_goto") as goto,
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "threads",
                payload,
                _Logger(),
                {"id": "threads-official-handoff-fallback"},
                Path("."),
        )

        self.assertTrue(submitted)
        self.assertEqual(click.call_count, 3)
        handoff.assert_called_once()
        self.assertTrue(payload["_threads_official_handoff_attempted"])
        goto.assert_not_called()

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

    def test_threads_publish_evidence_accepts_confirmed_permalink_with_split_body_text(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/@user/post/ABC?xmt=AQG"
        page.locator.return_value.inner_text.return_value = (
            "Published headline\n"
            "with split whitespace and the rest of the post rendered separately."
        )

        self.assertTrue(
            runner._threads_publish_evidence_page_ready(
                page,
                "https://www.threads.com/@user/post/ABC",
            )
        )
        page.locator.assert_called_once_with("body")

    def test_threads_publish_evidence_rejects_wrong_permalink(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/@user/post/OTHER"
        page.locator.return_value.inner_text.return_value = "Published headline"

        self.assertFalse(
            runner._threads_publish_evidence_page_ready(
                page,
                "https://www.threads.net/@user/post/ABC",
            )
        )
        page.locator.assert_not_called()

    def test_threads_publish_evidence_rejects_login_redirect_shell(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/@user/post/ABC"
        page.locator.return_value.inner_text.return_value = "Log in or sign up for Threads"

        self.assertFalse(
            runner._threads_publish_evidence_page_ready(
                page,
                "https://www.threads.net/@user/post/ABC",
            )
        )

    def test_threads_final_screenshot_validates_confirmed_permalink_content(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/@user/post/ABC"

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_dismiss_threads_cookie_consent", return_value=True) as dismiss_cookie,
            mock.patch.object(runner, "_threads_publish_evidence_page_ready", return_value=True) as evidence_ready,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="final.png") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, _Logger()
            )

        self.assertEqual(result, "final.png")
        goto.assert_called_once()
        dismiss_cookie.assert_called_once()
        evidence_ready.assert_called_once_with(
            page,
            "https://www.threads.com/@user/post/ABC",
        )
        screenshot.assert_called_once()

    def test_threads_cookie_consent_is_dismissed_before_evidence(self):
        page = mock.Mock()
        with (
            mock.patch.object(
                runner,
                "_page_body_text_lower",
                side_effect=["allow the use of cookies from threads", ""],
            ),
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._dismiss_threads_cookie_consent(page, _Logger())

        self.assertTrue(result)
        click.assert_called_once_with(
            page,
            mock.ANY,
            ["Decline optional cookies", "Allow all cookies"],
            "threads_cookie_consent",
        )

    def test_threads_final_screenshot_skips_cookie_dialog(self):
        page = mock.Mock()

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_dismiss_threads_cookie_consent", return_value=False),
            mock.patch.object(runner, "_screenshot") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, _Logger()
            )

        self.assertEqual(result, "")
        screenshot.assert_not_called()

    def test_threads_final_screenshot_skips_loading_page(self):
        page = mock.Mock()

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_dismiss_threads_cookie_consent", return_value=True),
            mock.patch.object(runner, "_threads_publish_evidence_page_ready", return_value=False),
            mock.patch.object(runner, "_screenshot") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, _Logger()
            )

        self.assertEqual(result, "")
        screenshot.assert_not_called()

    def test_threads_final_screenshot_reopens_permalink_after_cookie_failure(self):
        page = mock.Mock()
        logger = _RecordingLogger()

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_dismiss_threads_cookie_consent", side_effect=[False, True]) as dismiss_cookie,
            mock.patch.object(runner, "_threads_publish_evidence_page_ready", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="final.png") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, logger
            )

        self.assertEqual(result, "final.png")
        self.assertEqual(goto.call_count, 2)
        self.assertEqual(dismiss_cookie.call_count, 2)
        screenshot.assert_called_once()
        self.assertTrue(any(args[1] == "publish_evidence_retry" for args, _kwargs in logger.entries))

    def test_threads_final_screenshot_retries_when_saving_fails(self):
        page = mock.Mock()

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_dismiss_threads_cookie_consent", return_value=True),
            mock.patch.object(runner, "_threads_publish_evidence_page_ready", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", side_effect=["", "final.png"]) as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, _Logger()
            )

        self.assertEqual(result, "final.png")
        self.assertEqual(goto.call_count, 2)
        self.assertEqual(screenshot.call_count, 2)

    def test_threads_final_screenshot_stops_after_retry_limit(self):
        page = mock.Mock()
        logger = _RecordingLogger()

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_dismiss_threads_cookie_consent", return_value=False) as dismiss_cookie,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot") as screenshot,
        ):
            result = runner._capture_threads_publish_evidence(
                page, "https://www.threads.com/@user/post/ABC", "published body", Path("."), {"id": "task"}, logger
            )

        self.assertEqual(result, "")
        self.assertEqual(goto.call_count, 3)
        self.assertEqual(dismiss_cookie.call_count, 3)
        screenshot.assert_not_called()
        retry_entries = [args for args, _kwargs in logger.entries if args[1] == "publish_evidence_retry"]
        final_entries = [args for args, _kwargs in logger.entries if args[1] == "publish_evidence_not_ready"]
        self.assertEqual(len(retry_entries), 2)
        self.assertEqual(len(final_entries), 1)

    def test_requested_threads_publish_takeover_stops_automation_and_waits_for_manual_completion(self):
        event = threading.Event()
        event.set()
        context_control = {
            "manual_takeover_event": event,
            "manual_takeover_ack_event": threading.Event(),
            "manual_takeover_callback": mock.Mock(return_value=True),
        }
        expected = {"ok": True, "url": "https://www.threads.net/@user/post/manual"}

        with mock.patch.object(
            runner,
            "_wait_for_manual_threads_publish_completion",
            return_value=expected,
        ) as wait_manual:
            result = runner._pause_for_requested_threads_publish_takeover(
                mock.Mock(),
                {"id": "publish-task", "payload": {}},
                {},
                Path("."),
                _Logger(),
                {},
                "https://www.threads.net/@user",
                {"https://www.threads.net/@user/post/old"},
                threading.Event(),
                context_control,
            )

        self.assertEqual(result, expected)
        self.assertTrue(context_control["manual_takeover_ack_event"].is_set())
        wait_manual.assert_called_once()

    def test_manual_publish_completion_matches_the_current_caption_before_advancing_batch(self):
        expected_caption = "current batch post body"
        expected_url = "https://www.threads.net/@user/post/current"
        page = _PageWithBackground()
        logger = _Logger()

        def confirm_current_caption(_page, caption, *_args, **_kwargs):
            self.assertEqual(caption, expected_caption)
            return {"confirmed": True, "url": expected_url}

        with (
            mock.patch.object(runner, "_screenshot", return_value=""),
            mock.patch.object(
                runner,
                "_wait_for_threads_own_post",
                side_effect=confirm_current_caption,
            ),
            mock.patch.object(
                runner,
                "_capture_threads_publish_evidence",
                return_value="/tmp/current.png",
            ),
        ):
            result = runner._wait_for_manual_threads_publish_completion(
                page,
                {"id": "publish-1"},
                {"caption": expected_caption},
                Path("."),
                logger,
                {"username": "user"},
                "https://www.threads.net/@user",
                {"https://www.threads.net/@user/post/old"},
                threading.Event(),
                {},
            )

        self.assertEqual(result["url"], expected_url)

    def test_threads_publish_takeover_helper_is_noop_without_request(self):
        result = runner._pause_for_requested_threads_publish_takeover(
            mock.Mock(),
            {"id": "publish-task", "payload": {}},
            {},
            Path("."),
            _Logger(),
            {},
            "https://www.threads.net/@user",
            set(),
            threading.Event(),
            {
                "manual_takeover_event": threading.Event(),
                "manual_takeover_ack_event": threading.Event(),
            },
        )

        self.assertIsNone(result)

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
        self.assertEqual(
            runner._normalize_threads_post_permalink("https://threads.com/@alice/post/ABC123"),
            "https://www.threads.net/@alice/post/ABC123",
        )

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
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[new_permalink, old_permalink]),
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
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[old_permalink]),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 91]),
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
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[latest_before, older_match]),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "reused post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                previous_permalinks={latest_before, older_match},
            )

        self.assertFalse(result["confirmed"])

    def test_threads_caption_confirmation_requires_readable_baseline(self):
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=new_permalink),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[new_permalink]),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 91]),
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

    def test_threads_caption_confirmation_rejects_unique_new_permalink_without_caption_match(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=""),
            mock.patch.object(
                runner,
                "_find_threads_post_permalinks",
                return_value=[new_permalink, old_permalink],
            ),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 151]),
            mock.patch.object(runner, "_wait_for_cancellation"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "new post body split across nested nodes",
                _Logger(),
                {"username": "alice"},
                previous_permalinks={old_permalink},
            )

        self.assertFalse(result["confirmed"])

    def test_threads_profile_baseline_unions_repeated_nonempty_reads(self):
        latest = "https://www.threads.net/@alice/post/LATEST"
        older = "https://www.threads.net/@alice/post/OLDER"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(
                runner,
                "_find_threads_post_permalinks",
                side_effect=[[latest], [latest, older]],
            ),
            mock.patch.object(runner, "_sleep_between"),
        ):
            baseline = runner._capture_threads_profile_baseline(
                page,
                "https://www.threads.net/@alice",
                _Logger(),
            )

        self.assertEqual(baseline, {latest, older})
        self.assertEqual(goto.call_count, 2)

    def test_threads_profile_baseline_reads_loaded_dom_after_navigation_timeout(self):
        permalink = "https://www.threads.net/@alice/post/LOADED"
        page = _Page("https://www.threads.com/@alice")
        with (
            mock.patch.object(runner, "_goto", side_effect=TimeoutError("network idle timed out")),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[permalink]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            baseline = runner._capture_threads_profile_baseline(
                page,
                "https://www.threads.net/@alice",
                _Logger(),
            )

        self.assertEqual(baseline, {permalink})

    def test_threads_publish_session_remembers_all_four_confirmed_permalinks(self):
        control = {}
        expected = {
            f"https://www.threads.net/@alice/post/POST{index}"
            for index in range(1, 5)
        }

        for permalink in sorted(expected):
            runner._remember_threads_publish_permalink(control, permalink)

        self.assertEqual(runner._threads_publish_session_permalinks(control), expected)

    def test_threads_publish_reuses_batch_baseline_when_later_profile_probe_times_out(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        new_permalink = "https://www.threads.net/@alice/post/NEW3"
        control = {"threads_publish_session_permalinks": {old_permalink}}
        page = _PageWithBackground("https://www.threads.net/")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", return_value="third post"),
            mock.patch.object(runner, "_click_threads_active_dialog_post", return_value=True),
            mock.patch.object(
                runner,
                "_wait_for_threads_publish_success",
                return_value={"confirmed": True, "submitted": True, "url": new_permalink},
            ) as confirm,
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=None),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="done.png"),
        ):
            result = runner._run_threads_publish_post(
                page,
                {"id": "publish-3"},
                {"caption": "third post"},
                Path("."),
                _Logger(),
                {"username": "alice"},
                control,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(confirm.call_args.kwargs["previous_permalinks"], {old_permalink})
        self.assertEqual(
            runner._threads_publish_session_permalinks(control),
            {old_permalink, new_permalink},
        )

    def test_threads_four_sequential_posts_keep_distinct_confirmed_links(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        new_permalinks = [
            f"https://www.threads.net/@alice/post/NEW{index}"
            for index in range(1, 5)
        ]
        control = {}
        page = _PageWithBackground("https://www.threads.net/")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", side_effect=[f"post {index}" for index in range(1, 5)]),
            mock.patch.object(runner, "_click_threads_active_dialog_post", return_value=True),
            mock.patch.object(
                runner,
                "_wait_for_threads_publish_success",
                side_effect=[
                    {"confirmed": True, "submitted": True, "url": permalink}
                    for permalink in new_permalinks
                ],
            ),
            mock.patch.object(
                runner,
                "_capture_threads_profile_baseline",
                side_effect=[{old_permalink}, None, None, None],
            ),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="done.png"),
        ):
            results = [
                runner._run_threads_publish_post(
                    page,
                    {"id": f"publish-{index}"},
                    {"caption": f"post {index}"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                    control,
                )
                for index in range(1, 5)
            ]

        self.assertEqual([result["url"] for result in results], new_permalinks)
        self.assertEqual(
            runner._threads_publish_session_permalinks(control),
            {old_permalink, *new_permalinks},
        )

    def test_threads_confirmation_refreshes_profile_while_waiting_for_delayed_post(self):
        page = mock.Mock(url="https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=""),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[]),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 31, 91]),
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
        page.reload.assert_called_once_with(wait_until="commit", timeout=5000)

    def test_threads_confirmation_recovers_after_refresh_timeout_and_detects_post(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = mock.Mock(url="https://www.threads.net/@alice")
        page.reload.side_effect = TimeoutError("slow refresh")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalinks", side_effect=[[old_permalink], [old_permalink], [new_permalink, old_permalink]]),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=new_permalink),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 31, 40]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "new post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                profile_url="https://www.threads.net/@alice",
                previous_permalinks={old_permalink},
            )

        self.assertTrue(result["confirmed"])
        self.assertEqual(result["url"], new_permalink)
        page.reload.assert_called_once_with(wait_until="commit", timeout=5000)

    def test_threads_media_confirmation_rejects_multiple_new_links(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        new_one = "https://www.threads.net/@alice/post/NEW1"
        new_two = "https://www.threads.net/@alice/post/NEW2"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[new_one, new_two, old_permalink]),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                previous_permalinks={old_permalink},
            )

        self.assertFalse(result["confirmed"])

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

    def test_threads_feed_confirms_first_post_for_empty_readable_baseline(self):
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = _Page("https://www.threads.net/")
        with (
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=new_permalink),
            mock.patch.object(runner.time, "time", side_effect=[0, 1]),
        ):
            result = runner._wait_for_threads_publish_success(
                page,
                _Logger(),
                caption="new post body",
                profile_url="https://www.threads.net/@alice",
                previous_permalinks=set(),
            )

        self.assertTrue(result["confirmed"])
        self.assertEqual(result["url"], new_permalink)

    def test_threads_caption_confirmation_accepts_new_post_below_pinned_post(self):
        pinned = "https://www.threads.net/@alice/post/PINNED"
        new_permalink = "https://www.threads.net/@alice/post/NEW"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[pinned, new_permalink]),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=new_permalink),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "new post body",
                _Logger(),
                {"username": "alice"},
                previous_permalinks={pinned},
            )

        self.assertTrue(result["confirmed"])
        self.assertEqual(result["url"], new_permalink)

    def test_threads_confirmation_rejects_other_accounts_post_link(self):
        old_permalink = "https://www.threads.net/@alice/post/OLD"
        other_permalink = "https://www.threads.net/@bob/post/NEW"
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[other_permalink, old_permalink]),
            mock.patch.object(runner, "_find_threads_post_permalink", return_value=other_permalink),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 91]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_own_post(
                page,
                "new post body",
                _Logger(),
                {"username": "alice"},
                {"profile_confirm_seconds": 90},
                previous_permalinks={old_permalink},
            )

        self.assertFalse(result["confirmed"])
        self.assertTrue(runner._threads_permalink_belongs_to_profile(old_permalink, "https://www.threads.net/@alice"))
        self.assertFalse(runner._threads_permalink_belongs_to_profile(other_permalink, "https://www.threads.net/@alice"))

    def test_threads_publish_aborts_before_submit_when_profile_baseline_is_unreadable(self):
        page = _Page("https://www.threads.net/")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=None),
            mock.patch.object(runner, "_click_threads_active_dialog_post") as submit,
        ):
            with self.assertRaisesRegex(RuntimeError, "未点击发布按钮"):
                runner._run_threads_publish_post(
                    page,
                    {"id": "publish-task"},
                    {"caption": "hello threads"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                )

        submit.assert_not_called()

    def test_threads_matrix_publish_does_not_wait_for_other_routes(self):
        page = _Page("https://www.threads.net/")
        start_barrier = mock.Mock()

        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_ensure_threads_home_for_publish"),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(
                runner,
                "_temporary_background_page",
                return_value=contextlib.nullcontext(page),
            ) as background_page,
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=None),
            mock.patch.object(runner, "_wait_for_browser_start_barrier", start_barrier),
            mock.patch.object(runner, "_wait_for_cancellation"),
        ):
            with self.assertRaisesRegex(RuntimeError, "未点击发布按钮"):
                runner._run_threads_publish_post(
                    page,
                    {"id": "matrix-baseline-task"},
                    {"caption": "hello threads", "matrix_publish_batch_id": "matrix-one"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                )

        self.assertTrue(background_page.call_args.kwargs["block_heavy_assets"])
        self.assertNotIn("force_primary", background_page.call_args.kwargs)
        start_barrier.assert_not_called()

    def test_threads_publish_runs_profile_baseline_inside_matrix_resource_phase(self):
        page = _Page("https://www.threads.net/")
        phases = []

        def run_phase(phase, action):
            phases.append(phase)
            return action()

        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_ensure_threads_home_for_publish"),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_temporary_background_page", return_value=contextlib.nullcontext(page)),
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=None),
        ):
            with self.assertRaisesRegex(RuntimeError, "未点击发布按钮"):
                runner._run_threads_publish_post(
                    page,
                    {"id": "matrix-baseline-task"},
                    {"caption": "hello threads"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                    context_control={"matrix_resource_phase_callback": run_phase},
                )

        self.assertEqual(phases, ["threads_profile_baseline"])

    def test_threads_publish_preview_stops_at_actionable_button_without_submit(self):
        page = _Page("https://www.threads.net/")
        compose = _Locator()
        post_button = _Locator()
        task = {"id": "publish-preview-task", "task_type": "publish_post"}
        start_barrier = mock.Mock()
        payload = {
            "caption": "preview only",
            "stop_before_publish_click": True,
            "matrix_publish_batch_id": "matrix-preview",
        }
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_ensure_threads_home_for_publish"),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_temporary_background_page") as background_page,
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=set()) as capture_baseline,
            mock.patch.object(runner, "_pause_for_requested_threads_publish_takeover", return_value=None),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=compose),
            mock.patch.object(runner, "_human_click", return_value=True),
            mock.patch.object(runner, "_clear_and_type") as clear_and_type,
            mock.patch.object(runner, "_threads_dialog_compose_box", return_value=compose),
            mock.patch.object(runner, "_threads_active_dialog_text", side_effect=["", "preview only"]),
            mock.patch.object(runner, "_threads_dialog_post_button", return_value=post_button),
            mock.patch.object(runner, "_screenshot", return_value="preview.png"),
            mock.patch.object(runner, "_wait_for_browser_start_barrier", start_barrier),
        ):
            result = runner._run_threads_publish_post(
                page,
                task,
                payload,
                Path("."),
                _Logger(),
                {"username": "alice"},
                context_control={},
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["preview_only"])
        self.assertTrue(result["ready_to_submit"])
        self.assertFalse(result["submitted"])
        self.assertEqual(result["screenshot_path"], "preview.png")
        capture_baseline.assert_called_once()
        self.assertTrue(capture_baseline.call_args.kwargs["skip"])
        background_page.assert_not_called()
        self.assertEqual(clear_and_type.call_count, 2)
        self.assertEqual(clear_and_type.call_args_list[0].kwargs["mode"], "paste")
        self.assertEqual(clear_and_type.call_args_list[1].kwargs["mode"], "type")
        start_barrier.assert_not_called()

    def test_threads_profile_baseline_requires_two_stable_empty_reads(self):
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[]),
            mock.patch.object(runner, "_threads_profile_is_stably_empty", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
        ):
            baseline = runner._capture_threads_profile_baseline(page, "https://www.threads.net/@alice", _Logger())

        self.assertEqual(baseline, set())
        self.assertEqual(goto.call_count, 2)

    def test_threads_profile_baseline_rejects_only_one_empty_observation(self):
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_goto", side_effect=[TimeoutError("slow"), None, TimeoutError("slow again")]),
            mock.patch.object(runner, "_find_threads_post_permalinks", side_effect=[None, [], None]),
            mock.patch.object(runner, "_threads_profile_is_stably_empty", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
        ):
            baseline = runner._capture_threads_profile_baseline(page, "https://www.threads.net/@alice", _Logger())

        self.assertIsNone(baseline)

    def test_threads_profile_empty_baseline_rejects_error_or_loading_shell(self):
        page = _ThreadsShellPage(
            [{"name": "sessionid", "value": "active-session", "domain": ".instagram.com"}],
            "Something went wrong, please try again later.",
        )
        page.url = "https://www.threads.com/@alice"
        self.assertFalse(runner._threads_profile_is_stably_empty(page, "https://www.threads.net/@alice"))

        page.body.text = "No threads yet"
        self.assertTrue(runner._threads_profile_is_stably_empty(page, "https://www.threads.net/@alice"))

    def test_threads_profile_empty_baseline_accepts_loaded_handle_without_empty_copy(self):
        page = _ThreadsShellPage(
            [{"name": "sessionid", "value": "active-session", "domain": ".instagram.com"}],
            "Alice @alice Followers Following",
        )
        page.url = "https://www.threads.com/@alice"

        self.assertTrue(runner._threads_profile_is_stably_empty(page, "https://www.threads.net/@alice"))

    def test_threads_compose_ready_prefers_direct_new_opener_once(self):
        opener = _Locator()
        compose = _Locator()
        page = mock.Mock()
        with (
            mock.patch.object(runner, "_threads_dialog_compose_box", side_effect=[None, compose]),
            mock.patch.object(runner, "_threads_sidebar_compose_opener", return_value=opener) as sidebar_lookup,
            mock.patch.object(runner, "_click_threads_compose_opener", return_value=True) as click_opener,
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._ensure_threads_compose_ready(page, _Logger())

        self.assertIs(result, compose)
        click_opener.assert_called_once()
        sidebar_lookup.assert_called_once_with(page)

    def test_threads_compose_ready_skips_news_links_and_uses_sidebar_opener(self):
        news_link = mock.Mock()
        news_link.is_visible.return_value = True
        news_link.get_attribute.return_value = "https://www.orientaldaily.com.my/news/wenhui/2026/08/09/839119"
        news_link.bounding_box.return_value = {"x": 800, "y": 500, "width": 100, "height": 40}
        sidebar_opener = mock.Mock()
        sidebar_opener.is_visible.return_value = True
        sidebar_opener.get_attribute.return_value = "https://www.threads.com/new"
        sidebar_opener.bounding_box.return_value = {"x": 60, "y": 120, "width": 120, "height": 40}
        anchors = mock.Mock()
        anchors.count.return_value = 2
        anchors.nth.side_effect = [news_link, sidebar_opener]
        empty = mock.Mock()
        empty.count.return_value = 0
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        page.evaluate.return_value = 1920
        page.locator.side_effect = lambda selector: anchors if selector == 'a[href]' else empty

        result = runner._threads_sidebar_compose_opener(page)

        self.assertIs(result, sidebar_opener)

    def test_threads_sidebar_compose_opener_accepts_traditional_chinese_sidebar_text(self):
        text_span = mock.Mock()
        text_span.is_visible.return_value = True
        text_span.get_attribute.return_value = None
        text_span.bounding_box.return_value = {"x": 18, "y": 110, "width": 80, "height": 36}
        sidebar_opener = mock.Mock()
        sidebar_opener.count.return_value = 1
        sidebar_opener.is_visible.return_value = True
        sidebar_opener.get_attribute.return_value = None
        sidebar_opener.bounding_box.return_value = {"x": 10, "y": 98, "width": 145, "height": 50}
        text_span.locator.return_value = sidebar_opener
        sidebar_group = mock.Mock()
        sidebar_group.count.return_value = 1
        sidebar_group.nth.return_value = text_span
        empty = mock.Mock()
        empty.count.return_value = 0
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        page.evaluate.return_value = 1920
        page.locator.side_effect = lambda selector: sidebar_group if selector == 'text="新串文"' else empty

        result = runner._threads_sidebar_compose_opener(page)

        self.assertIs(result, sidebar_opener)

    def test_threads_compose_ready_does_not_use_inline_home_composer(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        inline_opener = _Locator()
        with (
            mock.patch.object(runner, "_threads_dialog_compose_box", return_value=None),
            mock.patch.object(runner, "_threads_sidebar_compose_opener", return_value=None),
            mock.patch.object(runner, "_threads_inline_compose_opener", return_value=inline_opener),
            mock.patch.object(runner, "_threads_inline_compose_box", return_value=inline_opener),
            mock.patch.object(runner, "_click_threads_compose_opener") as click_opener,
            mock.patch.object(runner, "_goto"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Threads"):
                runner._ensure_threads_compose_ready(page, _Logger())

        click_opener.assert_not_called()

    def test_threads_compose_ready_reloads_stale_home_once_before_retry(self):
        state = {"reloaded": False, "clicked": False}
        hidden = _LoginStateLocator(visible=False)
        opener = _Locator()
        compose = _Locator()
        page = mock.Mock()
        page.url = "https://www.threads.com/"

        def recover(*_args, **_kwargs):
            state["reloaded"] = True

        def click(*_args, **_kwargs):
            state["clicked"] = True
            return True

        with (
            mock.patch.object(
                runner,
                "_threads_dialog_compose_box",
                side_effect=lambda _page: compose if state["clicked"] else None,
            ),
            mock.patch.object(
                runner,
                "_threads_sidebar_compose_opener",
                side_effect=lambda _page: opener if state["reloaded"] else None,
            ),
            mock.patch.object(runner, "_click_threads_compose_opener", side_effect=click) as click_opener,
            mock.patch.object(runner, "_goto", side_effect=recover) as goto,
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._ensure_threads_compose_ready(page, _Logger())

        self.assertIs(result, compose)
        goto.assert_called_once_with(
            page,
            runner.THREADS_HOME,
            mock.ANY,
            "threads_publish_open_recovery",
        )
        click_opener.assert_called_once()

    def test_threads_compose_ready_recovery_does_not_loop(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        with (
            mock.patch.object(runner, "_threads_dialog_compose_box", return_value=None),
            mock.patch.object(runner, "_threads_sidebar_compose_opener", return_value=None),
            mock.patch.object(runner, "_goto") as goto,
        ):
            with self.assertRaisesRegex(RuntimeError, "Threads"):
                runner._ensure_threads_compose_ready(page, _Logger())

        goto.assert_called_once()

    def test_threads_compose_opener_does_not_click_twice_when_dialog_appears_after_timeout(self):
        page = mock.Mock()
        opener = mock.Mock()
        compose = _Locator()
        with (
            mock.patch.object(runner, "_human_click", return_value=False),
            mock.patch.object(runner, "_threads_dialog_compose_box", return_value=compose),
        ):
            clicked = runner._click_threads_compose_opener(page, opener, _Logger())

        self.assertTrue(clicked)
        opener.evaluate.assert_not_called()

    def test_threads_compose_opener_uses_dom_fallback_after_validated_click_timeout(self):
        page = mock.Mock()
        opener = mock.Mock()
        compose = _Locator()
        with (
            mock.patch.object(runner, "_human_click", return_value=False),
            mock.patch.object(runner, "_threads_dialog_compose_box", side_effect=[None, compose]),
            mock.patch.object(runner, "_sleep_between"),
        ):
            clicked = runner._click_threads_compose_opener(page, opener, _Logger())

        self.assertTrue(clicked)
        opener.evaluate.assert_called_once_with("node => node.click()")

    def test_threads_compose_focus_reacquires_after_stale_locator(self):
        page = mock.Mock()
        stale_compose = _Locator()
        fresh_compose = _Locator()
        with (
            mock.patch.object(runner, "_human_click", side_effect=[TimeoutError("stale compose"), True]) as click,
            mock.patch.object(runner, "_threads_dialog_compose_box", return_value=fresh_compose),
            mock.patch.object(runner, "_ensure_threads_compose_ready") as reopen,
        ):
            result = runner._focus_threads_compose(page, stale_compose, _Logger())

        self.assertIs(result, fresh_compose)
        self.assertEqual([call.args[1] for call in click.call_args_list], [stale_compose, fresh_compose])
        reopen.assert_not_called()

    def test_threads_active_submit_reports_a_blocked_click(self):
        page = mock.Mock()
        page.evaluate.return_value = True
        target = mock.Mock()
        page.locator.return_value.first = target
        with mock.patch.object(runner, "_human_click", return_value=False):
            clicked = runner._click_threads_active_dialog_post(page, _Logger())

        self.assertFalse(clicked)

    def test_threads_publish_skips_duplicate_home_navigation_when_already_on_threads_home(self):
        permalink = "https://www.threads.net/@alice/post/NEW"
        page = _PageWithBackground("https://www.threads.net/")
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
                return_value={"confirmed": True, "url": permalink},
            ),
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=set()),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="done.png"),
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
        self.assertFalse(
            any(
                call.args[1] == runner.THREADS_HOME and call.args[3] == "threads_publish_open"
                for call in goto.call_args_list
            )
        )

    def test_threads_profile_redirect_interrupt_continues_from_loaded_page(self):
        page = _RedirectedPage()

        runner._goto(
            page,
            "https://www.threads.net/@alice",
            _Logger(),
            "threads_publish_baseline",
            timeout_ms=5000,
            networkidle_ms=1500,
        )

        self.assertEqual(page.goto_calls, ["https://www.threads.net/@alice"])
        self.assertEqual(page.url, "https://www.threads.com/@alice")
        self.assertEqual(page.waited_states, ["networkidle"])

    def test_threads_home_empty_response_uses_canonical_host_without_closing_browser(self):
        page = _TransientThreadsHomePage()

        runner._goto(
            page,
            runner.THREADS_HOME,
            _Logger(),
            "open_login",
            timeout_ms=5000,
            networkidle_ms=1500,
        )

        self.assertEqual(
            page.goto_calls,
            [runner.THREADS_HOME, "https://www.threads.com/"],
        )
        self.assertEqual(page.url, "https://www.threads.com/")
        self.assertEqual(page.waited_states, ["networkidle"])

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
            with self.assertRaises(runner.PublishConfirmationPendingError) as raised:
                runner._run_threads_publish_post(
                    page,
                    {"id": "publish-task"},
                    {"caption": "hello threads"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                )

        self.assertIn("不会自动重发", str(raised.exception))
        self.assertEqual(raised.exception.screenshot_path, "manual.png")
        self.assertEqual(raised.exception.confirmation["phase"], "confirm_only")
        screenshot.assert_called_once_with(page, Path("."), {"id": "publish-task"}, "publish_submitted_unconfirmed", mock.ANY)

    def test_threads_uncertain_dom_click_never_uses_fallback_submit(self):
        page = _Page("https://www.threads.net/@alice")
        permalink = "https://www.threads.net/@alice/post/NEW"
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", return_value="hello threads"),
            mock.patch.object(
                runner,
                "_click_threads_active_dialog_post",
                side_effect=runner.PublishClickUncertainError("navigation interrupted evaluation"),
            ),
            mock.patch.object(runner, "_threads_dialog_post_button") as fallback,
            mock.patch.object(
                runner,
                "_wait_for_threads_publish_success",
                return_value={"confirmed": True, "submitted": True, "url": permalink},
            ),
            mock.patch.object(runner, "_find_threads_post_permalinks", return_value=[]),
            mock.patch.object(runner, "_threads_profile_is_stably_empty", return_value=True),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="evidence.png"),
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
        fallback.assert_not_called()

    def test_threads_confirmation_context_is_persisted_before_submit_click(self):
        page = _Page("https://www.threads.net/@alice")
        events = []

        def click_after_persist(_page, _logger, before_click=None):
            self.assertIsNotNone(before_click)
            before_click()
            events.append("clicked")
            return True

        def persist(confirmation):
            events.append("persisted")
            self.assertEqual(confirmation["phase"], "confirm_only")
            return True

        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", return_value="hello threads"),
            mock.patch.object(runner, "_click_threads_active_dialog_post", side_effect=click_after_persist),
            mock.patch.object(runner, "_wait_for_threads_publish_success", side_effect=RuntimeError("browser exited after click")),
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=set()),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
        ):
            with self.assertRaisesRegex(RuntimeError, "browser exited after click"):
                runner._run_threads_publish_post(
                    page,
                    {"id": "publish-task"},
                    {"caption": "hello threads"},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                    {"publish_confirmation_callback": persist},
                )

        self.assertEqual(events, ["persisted", "clicked"])

    def test_threads_publish_never_submits_when_media_preview_is_not_ready(self):
        page = _Page("https://www.threads.net/@alice")
        media_input = mock.Mock()
        media_input.count.return_value = 1
        media_input.wait_for.return_value = None
        media_path = Path(__file__).resolve()

        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_ensure_threads_compose_ready", return_value=_Locator()),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_clear_and_type"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_active_dialog_text", return_value="hello threads"),
            mock.patch.object(runner, "_threads_media_input", return_value=media_input),
            mock.patch.object(
                runner,
                "_threads_attachment_snapshot",
                return_value={"preview_count": 0, "remove_control_count": 0, "selected_file_count": 0},
            ),
            mock.patch.object(
                runner,
                "_wait_for_threads_media_ready",
                side_effect=RuntimeError("Threads media attachment preview did not become ready."),
            ),
            mock.patch.object(runner, "_click_threads_active_dialog_post") as submit,
            mock.patch.object(runner, "_capture_threads_profile_baseline", return_value=set()),
            mock.patch.object(runner, "_resolve_threads_profile_url", return_value="https://www.threads.net/@alice"),
        ):
            with self.assertRaisesRegex(RuntimeError, "media attachment preview"):
                runner._run_threads_publish_post(
                    page,
                    {"id": "publish-task"},
                    {"caption": "hello threads", "media_paths": [str(media_path)]},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                )

        media_input.set_input_files.assert_called_once_with([str(media_path)])
        submit.assert_not_called()

    def test_threads_media_waits_for_rendered_attachment_evidence(self):
        logger = _RecordingLogger()
        snapshots = [
            {"preview_count": 0, "remove_control_count": 0, "selected_file_count": 1},
            {"preview_count": 1, "remove_control_count": 1, "selected_file_count": 1},
        ]
        with (
            mock.patch.object(runner, "_threads_attachment_snapshot", side_effect=snapshots),
            mock.patch.object(runner, "_sleep_between"),
        ):
            result = runner._wait_for_threads_media_ready(
                _Page(),
                logger,
                expected_files=1,
                baseline={"preview_count": 0, "remove_control_count": 0, "selected_file_count": 0},
            )

        self.assertEqual(result["preview_count"], 1)
        self.assertTrue(any(entry[0][1] == "threads_publish_upload_ready" for entry in logger.entries))

    def test_threads_confirmation_only_never_opens_or_submits_composer(self):
        page = _Page("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_ensure_threads_compose_ready") as compose,
            mock.patch.object(runner, "_click_threads_active_dialog_post") as submit,
            mock.patch.object(
                runner,
                "_wait_for_threads_own_post",
                return_value={"confirmed": True, "url": "https://threads.com/@alice/post/NEW"},
            ),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="evidence.png"),
        ):
            result = runner._run_threads_publish_post(
                page,
                {"id": "publish-task"},
                {
                    "media_paths": ["missing-file.jpg"],
                    "_publish_confirmation": {
                        "phase": "confirm_only",
                        "profile_url": "https://threads.com/@alice",
                        "baseline_permalinks": ["https://www.threads.net/@alice/post/OLD"],
                        "caption": "hello threads",
                    },
                },
                Path("."),
                _Logger(),
                {"username": "alice"},
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["url"], "https://www.threads.net/@alice/post/NEW")
        compose.assert_not_called()
        submit.assert_not_called()

    def test_threads_success_returns_specific_permalink(self):
        permalink = "https://www.threads.net/@alice/post/ABC123"
        resolved_profile = "https://www.threads.net/@real_handle"
        page = _PageWithBackground("https://www.threads.net/@alice")
        with (
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(
                runner,
                "_goto",
                side_effect=lambda target_page, url, *_args, **_kwargs: setattr(target_page, "url", url),
            ) as goto,
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
        self.assertEqual(len(page.context.pages), 1)
        self.assertIs(confirm_profile.call_args.args[0], page)
        self.assertEqual(confirm_profile.call_args.kwargs["profile_url"], resolved_profile)
        screenshot.assert_called_once_with(page, permalink, "hello threads", Path("."), {"id": "publish-task"}, mock.ANY)
        self.assertTrue(all(background.closed for background in page.context.pages))

    def test_instagram_home_is_not_publish_confirmation(self):
        page = mock.Mock()
        page.url = runner.INSTAGRAM_HOME
        body = mock.Mock()
        body.inner_text.return_value = "Home"
        page.locator.return_value = body

        with (
            mock.patch.object(runner.time, "time", side_effect=[0.0, 1.0, 91.0]),
            mock.patch.object(runner.time, "sleep"),
        ):
            result = runner._wait_for_publish_success(page, _Logger())

        self.assertFalse(result["confirmed"])

    def test_instagram_permalink_is_normalized_without_query_string(self):
        self.assertEqual(
            runner._normalize_instagram_post_permalink(
                "https://instagram.com/p/ABC123/?utm_source=ig_web_copy_link"
            ),
            "https://www.instagram.com/p/ABC123/",
        )
        self.assertEqual(
            runner._normalize_instagram_post_permalink(
                "https://www.instagram.com/reel/REEL456/"
            ),
            "https://www.instagram.com/reel/REEL456/",
        )
        self.assertEqual(
            runner._normalize_instagram_post_permalink(
                "https://www.instagram.com/windzlc123/p/PROFILE_LINK/"
            ),
            "https://www.instagram.com/p/PROFILE_LINK/",
        )
        self.assertEqual(
            runner._normalize_instagram_post_permalink(
                "https://www.instagram.com/windzlc123/"
            ),
            "",
        )

    def test_instagram_publish_evidence_requires_permalink_and_caption(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/p/ABC123/?img_index=1"
        page.locator.return_value.inner_text.return_value = (
            "windzlc123\nInstagram 自动发布链路测试\n1 like"
        )

        self.assertTrue(
            runner._instagram_publish_evidence_page_ready(
                page,
                "https://www.instagram.com/p/ABC123/",
                "Instagram 自动发布链路测试",
            )
        )
        self.assertFalse(
            runner._instagram_publish_evidence_page_ready(
                page,
                "https://www.instagram.com/p/OTHER/",
                "Instagram 自动发布链路测试",
            )
        )
        self.assertFalse(
            runner._instagram_publish_evidence_page_ready(
                page,
                "https://www.instagram.com/p/ABC123/",
                "另一条并未发布的正文",
            )
        )

    def test_instagram_final_screenshot_opens_confirmed_post_content(self):
        page = mock.Mock()
        permalink = "https://www.instagram.com/p/ABC123/"

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(
                runner,
                "_instagram_publish_evidence_page_ready",
                return_value=True,
            ) as evidence_ready,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="instagram-final.png") as screenshot,
        ):
            result = runner._capture_instagram_publish_evidence(
                page,
                permalink,
                "published caption",
                Path("."),
                {"id": "instagram-task"},
                _Logger(),
            )

        self.assertEqual(result, "instagram-final.png")
        goto.assert_called_once_with(
            page,
            permalink,
            mock.ANY,
            "instagram_publish_result",
            timeout_ms=20000,
            networkidle_ms=3500,
        )
        evidence_ready.assert_called_once_with(page, permalink, "published caption")
        screenshot.assert_called_once_with(
            page,
            Path("."),
            {"id": "instagram-task"},
            "publish_done",
            mock.ANY,
        )

    def test_instagram_publish_returns_permalink_and_concrete_post_screenshot(self):
        page = mock.Mock()
        page.url = runner.INSTAGRAM_HOME
        media_path = Path(__file__).resolve()
        permalink = "https://www.instagram.com/p/ABC123/"

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_capture_instagram_profile_baseline",
                return_value={"https://www.instagram.com/p/OLD/"},
            ),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_type_text"),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_warmup_scroll") as warmup_scroll,
            mock.patch.object(
                runner,
                "_run_publish_submit_action",
                side_effect=lambda _control, _cancel, action: action(),
            ),
            mock.patch.object(
                runner,
                "_wait_for_publish_success",
                return_value={"confirmed": True, "reason": "Post shared"},
            ),
            mock.patch.object(
                runner,
                "_wait_for_instagram_own_post",
                return_value={"confirmed": True, "reason": "profile match", "url": permalink},
            ) as confirm_profile,
            mock.patch.object(
                runner,
                "_capture_instagram_publish_evidence",
                return_value="instagram-evidence.png",
            ) as capture_evidence,
            mock.patch.object(runner, "_screenshot") as direct_screenshot,
        ):
            result = runner._run_publish_post(
                page,
                {"id": "instagram-publish"},
                {
                    "caption": "published caption",
                    "media_paths": [str(media_path)],
                },
                Path("."),
                _Logger(),
                "instagram",
                {"username": "publisher"},
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["url"], permalink)
        self.assertEqual(result["published"]["permalink"], permalink)
        self.assertEqual(result["screenshot_path"], "instagram-evidence.png")
        confirm_profile.assert_called_once()
        capture_evidence.assert_called_once()
        direct_screenshot.assert_not_called()
        warmup_scroll.assert_not_called()

    def test_instagram_profile_baseline_accepts_empty_profile_after_login_stabilizes(self):
        page = mock.Mock()
        profile_url = "https://www.instagram.com/publisher/"

        with (
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_find_instagram_post_permalinks", return_value=[]),
            mock.patch.object(runner, "_instagram_profile_page_ready", side_effect=[False, True, True]),
            mock.patch.object(runner, "_sleep_between") as sleep_between,
        ):
            result = runner._capture_instagram_profile_baseline(
                page,
                profile_url,
                _Logger(),
            )

        self.assertEqual(result, set())
        self.assertEqual(goto.call_count, 3)
        self.assertEqual(sleep_between.call_count, 2)

    def test_instagram_profile_ready_rejects_unready_or_error_shell(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/publisher/"

        with (
            mock.patch.object(runner, "_detect_instagram_login_state", return_value={"status": "cookie_expired"}),
            mock.patch.object(runner, "_browser_navigation_error_visible", return_value=False),
            mock.patch.object(runner, "_page_body_text_lower", return_value="publisher no posts yet"),
        ):
            self.assertFalse(runner._instagram_profile_page_ready(page, "https://www.instagram.com/publisher/"))

        with (
            mock.patch.object(runner, "_detect_instagram_login_state", return_value={"status": "ready"}),
            mock.patch.object(runner, "_browser_navigation_error_visible", return_value=False),
            mock.patch.object(runner, "_page_body_text_lower", return_value="Something went wrong. Please try again later."),
        ):
            self.assertFalse(runner._instagram_profile_page_ready(page, "https://www.instagram.com/publisher/"))

    def test_instagram_profile_ready_accepts_loaded_empty_profile(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/publisher/"

        with (
            mock.patch.object(runner, "_detect_instagram_login_state", return_value={"status": "ready"}),
            mock.patch.object(runner, "_browser_navigation_error_visible", return_value=False),
            mock.patch.object(runner, "_page_body_text_lower", return_value="Publisher publisher No posts yet"),
        ):
            self.assertTrue(runner._instagram_profile_page_ready(page, "https://www.instagram.com/publisher/"))

    def test_instagram_publish_confirmation_stops_immediately_when_cancelled(self):
        page = mock.Mock()
        page.url = runner.INSTAGRAM_HOME
        cancel_event = threading.Event()
        cancel_event.set()

        with self.assertRaises(RuntimeError):
            runner._wait_for_publish_success(
                page,
                _Logger(),
                cancel_event=cancel_event,
            )
        page.locator.assert_not_called()

    def test_instagram_unconfirmed_publish_raises_unknown_outcome(self):
        page = mock.Mock()
        page.url = runner.INSTAGRAM_HOME
        media_path = Path(__file__).resolve()

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_warmup_scroll"),
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner, "_capture_instagram_profile_baseline", return_value=set()),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_run_publish_submit_action", side_effect=lambda _control, _cancel, action: action()),
            mock.patch.object(
                runner,
                "_wait_for_publish_success",
                return_value={"confirmed": False, "reason": "confirmation timed out"},
            ),
            mock.patch.object(runner, "_screenshot", return_value="instagram-unknown.png"),
        ):
            with self.assertRaises(runner.PublishOutcomeUnknownError) as raised:
                runner._run_publish_post(
                    page,
                    {"id": "instagram-publish"},
                    {"media_paths": [str(media_path)], "warmup": False},
                    Path("."),
                    _Logger(),
                    "instagram",
                    {"username": "publisher"},
                )

        self.assertTrue(raised.exception.publish_submitted)
        self.assertTrue(raised.exception.publish_outcome_unknown)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(raised.exception.status, "ready")
        self.assertEqual(raised.exception.screenshot_path, "instagram-unknown.png")

    def test_manual_publish_timeout_is_failed_not_need_manual(self):
        page = _PageWithBackground()
        logger = _RecordingLogger()

        with (
            mock.patch.object(runner.time, "monotonic", side_effect=[0.0, 300.0]),
            mock.patch.object(runner, "_screenshot", side_effect=["takeover.png", "timeout.png"]),
        ):
            with self.assertRaises(runner.ManualTimeoutError) as raised:
                runner._wait_for_manual_threads_publish_completion(
                    page,
                    {"id": "manual-publish-timeout"},
                    {"caption": "post", "manual_publish_timeout_seconds": 300},
                    Path("."),
                    logger,
                    {"username": "alice"},
                    "https://www.threads.net/@alice",
                    set(),
                    threading.Event(),
                    {},
                )

        self.assertIsInstance(raised.exception, runner.AutoLoginFailedError)
        self.assertNotIsInstance(raised.exception, runner.NeedManualError)
        self.assertEqual(raised.exception.timeout_kind, "manual_publish_timeout")
        self.assertFalse(raised.exception.browser_available)
        self.assertEqual(raised.exception.status, "ready")

    def test_manual_login_timeout_exposes_explicit_timeout_semantics(self):
        page = mock.Mock()

        with (
            mock.patch.object(runner.time, "monotonic", side_effect=[0.0, 300.0]),
            mock.patch.object(runner, "_screenshot", return_value="timeout.png"),
        ):
            with self.assertRaises(runner.ManualTimeoutError) as raised:
                runner._wait_for_manual_login_completion(
                    page,
                    {"id": "manual-login-timeout", "payload": {"manual_login_timeout_seconds": 300}},
                    Path("."),
                    _Logger(),
                    "instagram",
                    None,
                    "manual login required",
                )

        self.assertEqual(raised.exception.timeout_kind, "manual_login_timeout")
        self.assertFalse(raised.exception.browser_available)
        self.assertEqual(raised.exception.status, "cookie_expired")

    def test_threads_confirmation_cancel_closes_background_page_and_worker(self):
        page = _PageWithBackground()
        cancel_event = threading.Event()
        confirmation_started = threading.Event()
        outcome = {}

        def no_post_yet(_page):
            confirmation_started.set()
            return []

        def target():
            try:
                runner._wait_for_manual_threads_publish_completion(
                    page,
                    {"id": "cancel-confirmation"},
                    {"caption": "post", "manual_publish_timeout_seconds": 300},
                    Path("."),
                    _Logger(),
                    {"username": "alice"},
                    "https://www.threads.net/@alice",
                    set(),
                    cancel_event,
                    {},
                )
            except BaseException as exc:
                outcome["error"] = exc

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_dismiss_threads_compose_dialogs"),
            mock.patch.object(runner, "_find_threads_post_permalinks", side_effect=no_post_yet),
            mock.patch.object(runner, "_screenshot", return_value=""),
        ):
            worker = threading.Thread(target=target)
            worker.start()
            self.assertTrue(confirmation_started.wait(1.0))
            cancel_event.set()
            worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertIsInstance(outcome.get("error"), RuntimeError)
        self.assertTrue(page.context.pages)
        self.assertTrue(all(background.closed for background in page.context.pages))

    def test_threads_confirm_only_resolves_manual_takeover_before_success(self):
        page = _PageWithBackground("https://www.threads.net/@alice")
        takeover_event = threading.Event()
        takeover_event.set()
        acknowledged = mock.Mock(return_value=True)
        resolved = mock.Mock(return_value=True)
        control = {
            "manual_takeover_event": takeover_event,
            "manual_takeover_ack_event": threading.Event(),
            "manual_takeover_timeout_event": threading.Event(),
            "manual_takeover_callback": acknowledged,
            "manual_takeover_resolved_callback": resolved,
        }

        with (
            mock.patch.object(
                runner,
                "_wait_for_threads_own_post",
                return_value={"confirmed": True, "url": "https://www.threads.net/@alice/post/NEW"},
            ),
            mock.patch.object(runner, "_capture_threads_publish_evidence", return_value="evidence.png"),
        ):
            result = runner._run_threads_publish_post(
                page,
                {"id": "confirm-only"},
                {
                    "_publish_confirmation": {
                        "phase": "confirm_only",
                        "profile_url": "https://www.threads.net/@alice",
                        "baseline_permalinks": [],
                        "caption": "post",
                    },
                },
                Path("."),
                _Logger(),
                {"username": "alice"},
                control,
                threading.Event(),
            )

        self.assertTrue(result["ok"])
        acknowledged.assert_called()
        resolved.assert_called_once()
        self.assertFalse(takeover_event.is_set())
        self.assertFalse(control["manual_takeover_ack_event"].is_set())

    def test_publish_batch_clears_completed_item_takeover_before_next_item(self):
        page = mock.Mock()
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context
        takeover_event = threading.Event()
        observed_events = []
        control = {
            "manual_takeover_event": takeover_event,
            "manual_takeover_ack_event": threading.Event(),
            "manual_takeover_timeout_event": threading.Event(),
            "manual_takeover_callback": mock.Mock(return_value=True),
            "manual_takeover_resolved_callback": mock.Mock(return_value=True),
        }
        tasks = [
            {"id": "publish-1", "task_type": "publish_post", "platform": "threads", "payload": {}},
            {"id": "publish-2", "task_type": "publish_post", "platform": "threads", "payload": {}},
        ]

        def publish_item(*_args, **_kwargs):
            observed_events.append(takeover_event.is_set())
            if len(observed_events) == 1:
                takeover_event.set()
            return {"ok": True}

        with (
            mock.patch.object(runner, "_open_camoufox_context", return_value=manager),
            mock.patch.object(runner, "_import_initial_cookies"),
            mock.patch.object(runner, "_first_page", return_value=page),
            mock.patch.object(runner, "_sync_live_browser_viewport"),
            mock.patch.object(runner, "_run_publish_task_in_context", side_effect=publish_item),
        ):
            results = runner.run_social_publish_batch(
                tasks=tasks,
                account={"platform": "threads"},
                proxy=None,
                data_dir=Path("."),
                loggers=[_Logger(), _Logger()],
                context_control=control,
            )

        self.assertEqual(len(results), 2)
        self.assertEqual(observed_events, [False, False])
        control["manual_takeover_resolved_callback"].assert_called_once()

    def test_instagram_risky_contactpoint_is_classified_as_abnormal_verification(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/accounts/update_risky_contactpoint/?challenge_context=redacted"

        with (
            mock.patch.object(runner, "_detect_platform_account_restriction", return_value=None),
            mock.patch.object(
                runner,
                "_classify_verification_challenge",
                return_value={"type": "identity_challenge"},
            ),
        ):
            status = runner._detect_instagram_login_state(page)

        self.assertEqual(status["status"], "need_verification")
        self.assertEqual(status["health_status"], "abnormal")
        self.assertEqual(status["challenge_type"], "identity_challenge")


if __name__ == "__main__":
    unittest.main()
