from __future__ import annotations

import asyncio
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import telegram_admin
from webapp.digital_human_tg_bot import bot as tg_bot
from webapp.telegram_internal import inject_telegram_internal_routes


class _VideoReplyMessage:
    """Small aiogram-like message double for the video Bot route contracts."""

    def __init__(self, chat_id: int = 6258005891, text: str = "") -> None:
        self.chat = SimpleNamespace(id=chat_id, type="private")
        self.from_user = SimpleNamespace(
            id=chat_id,
            username="video_user",
            first_name="Video",
            last_name="User",
        )
        self.text = text
        self.answers: list[tuple[str, dict[str, object]]] = []
        self.edits: list[tuple[str, dict[str, object]]] = []

    async def answer(self, text: str, **kwargs: object) -> None:
        self.answers.append((str(text), dict(kwargs)))

    async def edit_text(self, text: str, **kwargs: object) -> None:
        self.edits.append((str(text), dict(kwargs)))


class _VideoCallbackQuery:
    def __init__(self, message: _VideoReplyMessage, data: str) -> None:
        self.message = message
        self.data = data
        self.from_user = message.from_user
        self.answers: list[tuple[object, dict[str, object]]] = []

    async def answer(self, text: object = None, **kwargs: object) -> None:
        self.answers.append((text, dict(kwargs)))


class _VideoState:
    async def clear(self) -> None:
        return None

    async def set_state(self, _state: object) -> None:
        return None


class _VideoFlowState(_VideoState):
    def __init__(self) -> None:
        self.current = ""
        self.cleared = False
        self.data: dict[str, object] = {}

    async def clear(self) -> None:
        self.current = ""
        self.cleared = True

    async def set_state(self, state: object) -> None:
        self.current = str(getattr(state, "state", state))

    async def get_state(self) -> str:
        return self.current

    async def get_data(self) -> dict[str, object]:
        return dict(self.data)

    async def update_data(self, **kwargs: object) -> None:
        self.data.update(kwargs)


class _AuthorizedVideoService:
    def is_chat_authorized(self, _chat_id: int) -> bool:
        return True


def _video_route_callback(dispatcher, name: str):
    router = dispatcher.sub_routers[0]
    return next(
        handler.callback
        for handler in router.message.handlers
        if getattr(handler.callback, "__name__", "") == name
    )


def _video_callback_route(dispatcher, name: str):
    router = dispatcher.sub_routers[0]
    return next(
        handler.callback
        for handler in router.callback_query.handlers
        if getattr(handler.callback, "__name__", "") == name
    )


class TelegramClosedLoopTests(unittest.TestCase):
    def test_video_main_menu_keeps_original_controls_and_adds_account_entry(self):
        """The account entry is additive; the original video controls stay unchanged."""
        self.assertEqual(tg_bot.VIDEO_EDIT_MENU_BUTTON, "🎞️ 视频编辑")
        self.assertNotEqual(tg_bot.VIDEO_EDIT_MENU_BUTTON, "✂️ 视频编辑")
        self.assertIn("✂️ 视频编辑", tg_bot.VIDEO_EDIT_TEXTS)
        markup = tg_bot._menu_keyboard()
        labels = [
            [str(getattr(button, "text", "")) for button in row]
            for row in markup.keyboard
        ]
        self.assertEqual(
            labels,
            [
                [tg_bot.DIGITAL_HUMAN_VIDEO_MENU_BUTTON, tg_bot.ECOMMERCE_SHORT_VIDEO_MENU_BUTTON],
                [tg_bot.VIDEO_EDIT_MENU_BUTTON, tg_bot.IMAGE_GENERATION_MENU_BUTTON_DISPLAY],
                ["🔐 账号管理"],
                [tg_bot.RERUN_MENU_BUTTON, tg_bot.STATUS_MENU_BUTTON, tg_bot.STOP_MENU_BUTTON],
            ],
        )

        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        # Existing labels remain the source-level contract for old keyboards
        # and previously sent workflow instructions.
        for marker in (
            "LEGACY_ORAL_UPLOAD_BUTTON",
            "LEGACY_UPLOAD_BUTTON",
            "LEGACY_IMAGE_WORKFLOW_BUTTON",
            "LEGACY_IMAGE_GENERATE_WORKFLOW_BUTTON",
            "LEGACY_REPLACE_MODEL_WORKFLOW_BUTTON",
            "LEGACY_REPLACE_PRODUCT_WORKFLOW_BUTTON",
        ):
            self.assertIn(marker, source)
        for old_label in (
            "數字人視頻生成",
            "廣告短視頻",
            "視頻編輯",
            "圖片生成",
            "重跑最近任務",
            "查看工作台狀態",
            "強制停止目前任務",
        ):
            self.assertIn(old_label, source)

    def test_video_start_shows_main_menu_before_web_login(self):
        """A backend-authorized chat can reach the account entry from /start."""
        service = SimpleNamespace(
            is_chat_authorized=lambda _chat_id: True,
            get_app_title=lambda: "视频工作台",
        )
        dispatcher = tg_bot.build_dispatcher(SimpleNamespace(), service)
        callback = _video_route_callback(dispatcher, "cmd_start")
        message = _VideoReplyMessage(text="/start")

        asyncio.run(callback(message))

        self.assertEqual(len(message.answers), 1)
        self.assertIn("可用工作流", message.answers[0][0])
        markup = message.answers[0][1]["reply_markup"]
        labels = [[str(getattr(button, "text", "")) for button in row] for row in markup.keyboard]
        self.assertEqual(labels[2], ["🔐 账号管理"])
        self.assertEqual(labels[3], [tg_bot.RERUN_MENU_BUTTON, tg_bot.STATUS_MENU_BUTTON, tg_bot.STOP_MENU_BUTTON])

    def test_video_workbench_accepts_legacy_whitelist_without_web_login(self):
        """A backend-authorized Chat ID remains sufficient for video actions."""
        from types import SimpleNamespace

        dispatcher = tg_bot.build_dispatcher(
            SimpleNamespace(),
            SimpleNamespace(
                is_chat_authorized=lambda _chat_id: True,
                get_app_title=lambda: "视频工作台",
            ),
            load_member=lambda _chat_id: {
                "chat_id": 6258005891,
                "web_user_id": 0,
                "enabled": 1,
            },
            has_active_web_session=lambda _member: True,
            chat_login=lambda *_args, **_kwargs: {"ok": True},
        )
        callback = _video_route_callback(dispatcher, "cmd_start")
        message = _VideoReplyMessage()
        with mock.patch("webapp.telegram_admin.remember_trusted_user_profile"):
            asyncio.run(callback(message))

        self.assertTrue(message.answers)
        response_texts = [text for text, _kwargs in message.answers]
        self.assertTrue(any("可用工作流" in text for text in response_texts))
        self.assertFalse(any("后台白名单不会直接解锁" in text for text in response_texts))

    def test_video_account_management_expands_all_actions_and_uses_browser_url(self):
        """Account management exposes login/switch/logout on its first page."""
        from types import SimpleNamespace

        dispatcher = tg_bot.build_dispatcher(
            SimpleNamespace(),
            _AuthorizedVideoService(),
            load_member=lambda _chat_id: {
                "chat_id": 6258005891,
                "web_user_id": 42,
                "web_username": "alice",
                "enabled": 1,
            },
            has_active_web_session=lambda _member: True,
            chat_login=lambda *_args, **_kwargs: {"ok": True},
            logout_member=lambda _chat_id: {"ok": True, "bound": True},
            web_login_url=lambda _chat_id: "https://example.test/telegram/video/open?ticket=test",
        )
        state = _VideoState()

        status_callback = _video_route_callback(dispatcher, "video_account_management")
        status_message = _VideoReplyMessage()
        with mock.patch("webapp.telegram_admin.remember_trusted_user_profile"):
            asyncio.run(status_callback(status_message, state))
        self.assertIn("已登录", status_message.answers[-1][0])
        status_markup = status_message.answers[-1][1]["reply_markup"]
        status_labels = {
            str(getattr(button, "text", ""))
            for row in status_markup.inline_keyboard
            for button in row
        }
        status_callbacks = {
            str(getattr(button, "callback_data", ""))
            for row in status_markup.inline_keyboard
            for button in row
        }
        self.assertTrue(any("登录" in label or "切换" in label for label in status_labels))
        self.assertIn(tg_bot.VIDEO_WEB_ACCOUNT_BUTTON, status_labels)
        self.assertIn(tg_bot.VIDEO_GOOGLE_ACCOUNT_BUTTON, status_labels)
        self.assertTrue(any("退出" in label for label in status_labels))
        self.assertTrue(any("返回" in label for label in status_labels))
        self.assertNotIn("tv:vectosession", status_callbacks)

        login_callback = _video_route_callback(dispatcher, "video_account_login_start")
        login_message = _VideoReplyMessage()
        asyncio.run(login_callback(login_message, state))
        self.assertIn("登录方式选择", login_message.answers[-1][0])
        self.assertIn("VECTO 官方网页", login_message.answers[-1][0])
        self.assertNotIn("发送 VECTO 登录密码", login_message.answers[-1][0])
        login_markup = login_message.answers[-1][1]["reply_markup"]
        self.assertEqual(getattr(login_markup.inline_keyboard[0][0], "callback_data", ""), "tv:login_step_vecto")
        self.assertEqual(getattr(login_markup.inline_keyboard[1][0], "callback_data", ""), "tv:login_step_google")
        self.assertEqual(getattr(login_markup.inline_keyboard[2][0], "callback_data", ""), "tv:accountmenu")

        callback = _video_callback_route(dispatcher, "video_account_callback")
        step_message = _VideoReplyMessage()
        asyncio.run(callback(_VideoCallbackQuery(step_message, "tv:login_step_vecto"), state))
        self.assertIn("VECTO 网页账号登录步骤", step_message.edits[-1][0])
        password_button = step_message.edits[-1][1]["reply_markup"].inline_keyboard[0][0]
        self.assertEqual(str(getattr(password_button, "text", "")), "打开 VECTO 网页授权")
        self.assertEqual(getattr(password_button, "url", ""), "https://example.test/telegram/video/open?ticket=test&provider=password")
        self.assertIsNone(getattr(password_button, "web_app", None))

        google_message = _VideoReplyMessage()
        asyncio.run(callback(_VideoCallbackQuery(google_message, "tv:login_step_google"), state))
        self.assertIn("Google 官方授权步骤", google_message.edits[-1][0])
        google_button = google_message.edits[-1][1]["reply_markup"].inline_keyboard[0][0]
        self.assertEqual(str(getattr(google_button, "text", "")), "打开 Google 官方授权")
        self.assertEqual(getattr(google_button, "url", ""), "https://example.test/telegram/video/open?ticket=test&provider=google")
        self.assertIsNone(getattr(google_button, "web_app", None))

    def test_video_login_cancel_button_clears_pending_flow(self):
        dispatcher = tg_bot.build_dispatcher(
            SimpleNamespace(),
            _AuthorizedVideoService(),
            chat_login=lambda *_args, **_kwargs: {"ok": True},
        )
        callback = _video_route_callback(dispatcher, "video_account_login_cancel")
        state = _VideoFlowState()
        message = _VideoReplyMessage(text=tg_bot.VIDEO_LOGIN_CANCEL_BUTTON)

        asyncio.run(callback(message, state))

        self.assertTrue(state.cleared)
        self.assertIn("已取消视频工作台登录", message.answers[-1][0])
        markup = message.answers[-1][1]["reply_markup"]
        labels = {
            str(getattr(button, "text", ""))
            for row in markup.inline_keyboard
            for button in row
        }
        self.assertIn(tg_bot.VIDEO_WEB_ACCOUNT_BUTTON, labels)
        self.assertIn("返回账号管理", labels)

    def test_video_account_subpages_use_callback_edit_flow(self):
        dispatcher = tg_bot.build_dispatcher(
            SimpleNamespace(),
            _AuthorizedVideoService(),
            load_member=lambda _chat_id: {
                "chat_id": 6258005891,
                "web_user_id": 42,
                "web_username": "alice",
                "enabled": 1,
            },
            has_active_web_session=lambda _member: True,
            chat_login=lambda *_args, **_kwargs: {"ok": True},
            web_login_url=lambda _chat_id: "https://example.test/telegram/video/open?ticket=test",
        )
        callback = _video_callback_route(dispatcher, "video_account_callback")
        state = _VideoState()
        message = _VideoReplyMessage()

        asyncio.run(callback(_VideoCallbackQuery(message, "tv:vectosession"), state))
        self.assertTrue(message.edits)
        session_markup = message.edits[-1][1]["reply_markup"]
        callbacks = {
            str(getattr(button, "callback_data", ""))
            for row in session_markup.inline_keyboard
            for button in row
        }
        self.assertEqual(
            {value for value in callbacks if value != "None"},
            {"tv:login_step_vecto", "tv:login_step_google", "tv:logout_step", "tv:menu"},
        )

        asyncio.run(callback(_VideoCallbackQuery(message, "tv:chatlogin"), state))
        self.assertIn("登录方式选择", message.edits[-1][0])
        self.assertNotIn("发送 VECTO 登录密码", message.edits[-1][0])
        login_markup = message.edits[-1][1]["reply_markup"]
        self.assertEqual(getattr(login_markup.inline_keyboard[0][0], "callback_data", ""), "tv:login_step_vecto")
        self.assertEqual(getattr(login_markup.inline_keyboard[1][0], "callback_data", ""), "tv:login_step_google")

        asyncio.run(callback(_VideoCallbackQuery(message, "tv:login_step_vecto"), state))
        self.assertIn("VECTO 网页账号登录步骤", message.edits[-1][0])
        password_button = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0]
        self.assertEqual(getattr(password_button, "url", ""), "https://example.test/telegram/video/open?ticket=test&provider=password")
        self.assertIsNone(getattr(password_button, "web_app", None))

        asyncio.run(callback(_VideoCallbackQuery(message, "tv:logout_step"), state))
        self.assertIn("退出 VECTO 账号步骤", message.edits[-1][0])
        logout_markup = message.edits[-1][1]["reply_markup"]
        self.assertEqual(getattr(logout_markup.inline_keyboard[0][0], "callback_data", ""), "tv:aclogout_confirm")
        self.assertEqual(getattr(logout_markup.inline_keyboard[1][0], "callback_data", ""), "tv:accountmenu")

        asyncio.run(callback(_VideoCallbackQuery(message, "tv:login_cancel"), state))
        self.assertIn("已取消视频工作台登录", message.edits[-1][0])
        self.assertIn("账号管理", message.edits[-1][0])

    def test_video_workflows_do_not_emit_late_step_navigation(self):
        """The initial video Bot has no generic inline step-navigation banner."""
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        self.assertNotIn("步骤导航", source)
        self.assertNotIn("tv:step_", source)
        self.assertNotIn("set_state(VideoAccountLoginForm.waiting_for_username)", source)
        self.assertNotIn("聊天内登录绑定", source)

    def test_account_and_main_menu_return_are_available_before_login(self):
        dispatcher = tg_bot.build_dispatcher(
            SimpleNamespace(),
            _AuthorizedVideoService(),
            load_member=lambda _chat_id: {"web_user_id": 0, "enabled": 1},
            has_active_web_session=lambda _member: False,
        )
        state = _VideoState()

        account_back = _video_route_callback(dispatcher, "video_account_back")
        account_message = _VideoReplyMessage(text="返回工作台")
        asyncio.run(account_back(account_message, state))
        self.assertIn("已返回视频工作台主菜单", account_message.answers[-1][0])
        self.assertNotIn("尚未登录", account_message.answers[-1][0])

        main_back = _video_route_callback(dispatcher, "on_main_menu_button")
        main_message = _VideoReplyMessage(text="返回主菜单")
        asyncio.run(main_back(main_message, state))
        self.assertIn("已返回主菜單", main_message.answers[-1][0])

    def test_video_image_keyboard_keeps_initial_navigation(self):
        markup = tg_bot._image_edit_size_keyboard()
        labels = {
            str(getattr(button, "text", ""))
            for row in markup.keyboard
            for button in row
        }
        self.assertNotIn(tg_bot.BACK_STEP_BUTTON, labels)
        self.assertIn(tg_bot.MAIN_MENU_BUTTON, labels)

    def test_video_duration_validation_keeps_initial_menu(self):
        dispatcher = tg_bot.build_dispatcher(
            SimpleNamespace(),
            _AuthorizedVideoService(),
            load_member=lambda _chat_id: {"web_user_id": 42, "enabled": 1},
            has_active_web_session=lambda _member: True,
        )
        for handler_name, state_name in (
            (
                "on_replace_product_duration",
                tg_bot.ProductionWorkflowForm.replace_product_waiting_for_duration,
            ),
            (
                "on_union_duration",
                tg_bot.ProductionWorkflowForm.union_waiting_for_duration,
            ),
        ):
            with self.subTest(handler_name=handler_name):
                callback = _video_route_callback(dispatcher, handler_name)
                state = _VideoFlowState()
                state.current = state_name.state
                message = _VideoReplyMessage(text="not-a-duration")

                asyncio.run(callback(message, state))

                self.assertIn("格式不正確", message.answers[-1][0])
                markup = message.answers[-1][1]["reply_markup"]
                labels = {
                    str(getattr(button, "text", ""))
                    for row in markup.keyboard
                    for button in row
                }
                self.assertNotIn(tg_bot.BACK_STEP_BUTTON, labels)
                self.assertEqual(state.current, state_name.state)

    def test_original_bot_keyboards_are_copied(self):
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        for label in (
            "數字人視頻生成",
            "廣告短視頻",
            "查看工作台狀態",
            "強制停止目前任務",
            "確認提交視頻生成",
            "重新生成",
            "添加字幕",
            "確認生成",
            "/api/internal/tg/submit",
            "_load_webapp_tg_status",
            "FROM tasks",
            "tg_chat_id",
        ):
            self.assertIn(label, source)

    def test_bot_reads_generation_records_by_chat_id(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "app.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            "CREATE TABLE tasks (id TEXT, user_id INTEGER, type TEXT, status TEXT, error TEXT, runninghub_task_id TEXT, input_json TEXT, output_json TEXT, created_at INTEGER, updated_at INTEGER)"
        )
        conn.execute(
            "CREATE TABLE task_events (kind TEXT, message TEXT, data_json TEXT, created_at INTEGER, task_id TEXT)"
        )
        conn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "task-1",
                1,
                "create_video",
                "success",
                "",
                "",
                '{"tg_chat_id": 6258005891, "source": "telegram"}',
                '{"download_path": "/tmp/out.mp4"}',
                1,
                1,
            ),
        )
        conn.execute(
            "INSERT INTO task_events VALUES (?,?,?,?,?)",
            ("done", "生成成功", "{}", 1, "task-1"),
        )
        conn.commit()
        conn.close()
        with mock.patch.dict(os.environ, {"WEBAPP_DB_PATH": str(db_path)}, clear=False):
            status = tg_bot._load_webapp_tg_status(6258005891)
        self.assertIsNotNone(status)
        self.assertEqual(status["latest"]["id"], "task-1")
        self.assertEqual(status["counts"].get("success"), 1)

    def test_internal_submit_enqueues_telegram_task(self):
        captured: dict[str, object] = {}

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _new_id(self, prefix: str) -> str:
                return f"{prefix}-1"

            def _apply_runtime_defaults(self, task_type, payload):
                return dict(payload)

            def _enqueue_task(self, task_id, user_id, task_type, payload):
                captured.update(
                    {"id": task_id, "user_id": user_id, "type": task_type, "payload": dict(payload)}
                )

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(value)

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _json_loads(self, value, default=None):
                return default

            def _now_ts(self):
                return 1

            def _insert_task_event(self, *args, **kwargs):
                return None

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _guess_file_kind(self, path_or_name):
                return "image"

            def _build_task_workdir(self, task_id, fallback_username=None):
                return Path(tempfile.gettempdir())

            def _get_runtime_config(self, conn):
                return {}

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        class Conn:
                            def execute(self, *args, **kwargs):
                                class Row(dict):
                                    def __getitem__(self, key):
                                        return 1

                                return self

                            def fetchone(self):
                                return {"id": 1}

                        return Conn()

                    def __exit__(self_inner, exc_type, exc, tb):
                        return False

                return Ctx()

        app = FastAPI()
        inject_telegram_internal_routes(app, FakeServer())
        client = TestClient(app)
        with mock.patch.dict(os.environ, {"TG_INTERNAL_API_TOKEN": "test-token"}, clear=False):
            response = client.post(
                "/api/internal/tg/submit",
                json={"task_type": "image_generate", "tg_chat_id": 6258005891, "params": {"mode": "scene_image", "prompt": "a studio"}},
                headers={"x-tg-internal-token": "test-token"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body.get("ok"))
        self.assertEqual(captured.get("type"), "image_generate")
        self.assertEqual(captured["payload"]["tg_chat_id"], 6258005891)
        self.assertEqual(captured["payload"]["source"], "telegram")

    def test_admin_still_has_telegram_settings(self):
        html = (Path(__file__).resolve().parents[1] / "static" / "admin.html").read_text(encoding="utf-8")
        self.assertIn("id=\"tgBotToken\"", html)
        self.assertIn("Telegram Bot", html)
        self.assertIn('data-page="telegram"', html)

    def test_agent_keyword_maps_to_production_task(self):
        from webapp.telegram_agent import build_agent_task_payload

        class FakeServer:
            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        return object()
                    def __exit__(self_inner, exc_type, exc, tb):
                        return False
                return Ctx()

            def _get_runtime_config(self, conn):
                return {}

            def _resolve_llm_fallback_candidates(self, runtime, allow_builtin=True):
                return "", []

            def _request_llm_json_with_fallback(self, **kwargs):
                raise RuntimeError("llm unavailable")

        from webapp import telegram_agent
        telegram_agent.bind_server(FakeServer())
        typ, payload, summary = build_agent_task_payload(
            message="做广告短视频",
            file_infos=[{"name": "p.jpg", "path": "/tmp/p.jpg", "kind": "image"}],
            use_ai_copy=True,
            default_duration=15,
            production_only=True,
        )
        self.assertEqual(typ, "ecommerce_short_video")
        self.assertEqual(payload.get("product_image_local_path"), "/tmp/p.jpg")
        self.assertTrue(payload.get("tg_use_llm_prompt"))
        self.assertIn("广告短视频", summary)

    def test_union_payload_keeps_local_media_paths(self):
        from webapp.telegram_internal import _bind_server, _build_internal_tg_task_payload

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        video = root / "src.mp4"
        model = root / "model.jpg"
        product = root / "product.jpg"
        for path in (video, model, product):
            path.write_bytes(b"x")

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(Path(value).resolve())

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _build_task_workdir(self, task_id, fallback_username=None):
                work = root / "work"
                work.mkdir(exist_ok=True)
                return work

        _bind_server(FakeServer())
        payload = _build_internal_tg_task_payload(
            "task-union",
            "replace_productANDmodel",
            {
                "video_local_path": str(video),
                "model_image_local_path": str(model),
                "product_image_local_path": str(product),
            },
        )
        self.assertTrue(Path(payload["video_local_path"]).is_file())
        self.assertTrue(Path(payload["model_image_local_path"]).is_file())
        self.assertTrue(Path(payload["product_image_local_path"]).is_file())

    def test_union_replace_resolves_from_web_module(self):
        from webapp import video_workbench
        task_type, payload = video_workbench.resolve_video_ui_task("video_subject_replace", {"replace_mode": "union", "subject_kind": "union"})
        self.assertEqual(task_type, "replace_productANDmodel")

    def test_image_generate_payload_keeps_video_image_mode(self):
        from video_core.source_backend import ArchivedSourceBackend
        from webapp import video_workbench
        from webapp.telegram_internal import _bind_server, _build_internal_tg_task_payload

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        product = Path(tmp.name) / "product.jpg"
        product.write_bytes(b"x")

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(Path(value).resolve())

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _get_runtime_config(self, conn):
                return {}

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        class Conn:
                            def execute(self, *args, **kwargs):
                                return self

                            def fetchone(self):
                                return {}

                        return Conn()

                    def __exit__(self_inner, exc_type, exc, tb):
                        return False

                return Ctx()

        _bind_server(FakeServer())
        for mode in ("three_view", "product_only", "poster_translate"):
            payload = _build_internal_tg_task_payload(
                f"task-{mode}",
                "image_generate",
                {
                    "mode": mode,
                    "product_image_local_path": str(product),
                    "target_language": "English",
                },
            )
            self.assertEqual(payload["video_image_mode"], mode, mode)
            merged = video_workbench.apply_video_runtime_defaults("image_generate", payload, {})
            smashed_mode = str(merged.get("mode") or "single_reference").strip() or "single_reference"
            if smashed_mode not in {"single_reference", "dual_reference"}:
                smashed_mode = "single_reference"
            merged["mode"] = smashed_mode
            self.assertEqual(ArchivedSourceBackend._image_generate_mode(merged), mode)

    def test_rerun_command_uses_internal_webapp_path(self):
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        self.assertIn("await rerun_latest_webapp_or_local_task(message)", source)
        self.assertNotIn("await enqueue_request(message, request, source=\"telegram-rerun\"", source)

    def test_bot_guided_revision_hooks_match_source(self):
        source = Path(tg_bot.__file__).read_text(encoding="utf-8")
        self.assertIn("ECOMMERCE_GUIDED_REVISION_BUTTON", source)
        self.assertIn("waiting_for_digital_human_script_guided_revision", source)
        self.assertIn("ecommerce_waiting_for_prompt_guided_revision", source)
        self.assertIn('step="script_guided_revision"', source)
        self.assertEqual(source.count("if text in ECOMMERCE_GUIDED_REVISION_TEXTS:"), 3)

    def test_script_guided_revision_uses_source_revise_helper(self):
        from webapp.telegram_internal import _bind_server, _run_digital_human_tg_step

        captured = {}

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _new_id(self, prefix):
                return f"{prefix}-1"

            def _apply_runtime_defaults(self, task_type, payload):
                return dict(payload)

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(value)

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _revise_digital_human_short_script_with_llm(self, payload, **kwargs):
                captured.update(kwargs)
                captured["payload"] = dict(payload)
                return "revised speech", {"ok": True}

            def _get_runtime_config(self, conn):
                return {}

            def _build_task_workdir(self, task_id, fallback_username=None):
                return Path(tempfile.gettempdir())

        _bind_server(FakeServer())
        result = _run_digital_human_tg_step(
            "script_guided_revision",
            {
                "speech_text": "original speech",
                "revision_instruction": "更口语",
                "model_image_local_path": "/tmp/model.jpg",
                "product_image_local_path": "/tmp/product.jpg",
            },
        )
        self.assertEqual(result["step"], "script_guided_revision")
        self.assertEqual(result["speech_text"], "revised speech")
        self.assertEqual(captured.get("current_script"), "original speech")
        self.assertEqual(captured.get("revision_instruction"), "更口语")

    def test_ecommerce_preview_keeps_revision_draft(self):
        from webapp.telegram_internal import _bind_server, _build_internal_tg_ecommerce_prompt_preview_payload

        class FakeServer:
            DEFAULT_RUNTIME_CONFIG = {}

            def _new_id(self, prefix):
                return f"{prefix}-1"

            def _apply_runtime_defaults(self, task_type, payload):
                payload = dict(payload)
                if not payload.get("prompt"):
                    payload["prompt"] = payload.get("tg_user_instruction") or "generated"
                return payload

            def _to_bool(self, value, default=False):
                return bool(value) if value not in (None, "") else default

            def _to_int(self, value, default=0):
                try:
                    return int(value)
                except Exception:
                    return default

            def _validated_local_file(self, value, *, label: str) -> str:
                return str(value)

            def _enhance_tg_payload_with_llm_prompt(self, task_type, payload):
                return payload

            def _get_runtime_config(self, conn):
                return {}

            def db(self):
                class Ctx:
                    def __enter__(self_inner):
                        class Conn:
                            def execute(self, *args, **kwargs):
                                return self

                            def fetchone(self):
                                return {}

                        return Conn()

                    def __exit__(self_inner, exc_type, exc, tb):
                        return False

                return Ctx()

        _bind_server(FakeServer())
        payload = _build_internal_tg_ecommerce_prompt_preview_payload(
            {
                "product_image_local_path": "/tmp/p.jpg",
                "ecommerce_current_prompt": "old prompt",
                "ecommerce_revision_instruction": "开场更抓人",
                "tg_user_instruction": "根据图片生成广告",
            }
        )
        instruction = payload.get("tg_user_instruction") or ""
        self.assertIn("old prompt", instruction)
        self.assertIn("开场更抓人", instruction)


if __name__ == "__main__":
    unittest.main()
