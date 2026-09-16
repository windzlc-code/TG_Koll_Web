import asyncio
import os
import hashlib
import hmac
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qsl, urlencode, urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from webapp import telegram_admin, telegram_tweet_admin as tweet_tg
from webapp.auth import create_session, session_storage_token
from webapp.db import db, init_db
from webapp.telegram_tweet_bot import (
    NativeTweetBotController,
    TweetWorkbenchOps,
    _persona_image_option_definition,
    _reconcile_persona_image_options,
    _pagination_rows,
    _task_bucket,
    _task_timestamp,
    callback_token,
    load_state,
    resolve_callback_token,
    save_state,
)


async def _unused_async_dispatch(_user_id, _action, _payload):
    return {}


class _Button:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _Markup:
    def __init__(self, *, inline_keyboard):
        self.inline_keyboard = inline_keyboard


class _WebAppInfo:
    def __init__(self, *, url):
        self.url = url


class _ReplyMarkup:
    def __init__(self, *, keyboard, **kwargs):
        self.keyboard = keyboard
        self.__dict__.update(kwargs)


class _Types:
    InlineKeyboardButton = _Button
    InlineKeyboardMarkup = _Markup
    WebAppInfo = _WebAppInfo
    KeyboardButton = _Button
    ReplyKeyboardMarkup = _ReplyMarkup


class _Message:
    def __init__(self, chat_id=101, text="", message_id=1):
        self.chat = SimpleNamespace(id=chat_id, type="private")
        self.from_user = SimpleNamespace(id=chat_id)
        self.text = text
        self.message_id = message_id
        self.answers = []
        self.edits = []
        self.bot = SimpleNamespace()

    async def answer(self, text, **kwargs):
        self.answers.append((text, kwargs))

    async def edit_text(self, text, **kwargs):
        self.edits.append((text, kwargs))


class _Query:
    def __init__(self, data, message):
        self.data = data
        self.message = message
        self.from_user = message.from_user
        self.answers = []

    async def answer(self, text="", **kwargs):
        self.answers.append((text, kwargs))


class TelegramTweetAdminTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("APP_DB_PATH")
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        init_db()
        with db() as conn:
            now = 1
            first = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                "VALUES ('tweet_alice','x',0,0,'approved',?,?)",
                (now, now),
            )
            second = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                "VALUES ('tweet_bob','x',0,0,'approved',?,?)",
                (now, now),
            )
            self.alice_id = int(first.lastrowid)
            self.bob_id = int(second.lastrowid)
        self.runtime = {
            "telegram_bot_token": "video-token-must-not-change",
            "telegram_bot_enabled": True,
            "telegram_tweet_bot_token": "",
            "telegram_tweet_bot_enabled": False,
            "telegram_tweet_public_base_url": "https://console.example.test",
        }

    def tearDown(self):
        tweet_tg.stop_tweet_telegram_bot_worker()
        if self.old_db is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db
        self.tmpdir.cleanup()

    def _get(self):
        return dict(self.runtime)

    def _save(self, updates):
        self.runtime.update(updates)

    def _member(self, chat_id, web_user, *, enabled=True):
        tweet_tg.upsert_tweet_member(
            tweet_tg.TweetTgMemberPayload(chat_id=chat_id, label="test", enabled=enabled),
            self._get,
            default_web_user=web_user,
        )

    def _app(self):
        app = FastAPI()
        ops = TweetWorkbenchOps(dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch)
        with mock.patch.object(tweet_tg, "start_tweet_telegram_bot_worker"):
            tweet_tg.inject_tweet_telegram_admin(
                app,
                require_admin=lambda: {"id": self.alice_id, "is_admin": 1},
                get_runtime=self._get,
                save_runtime=self._save,
                workbench_ops=ops,
            )
        return app

    def _session(self, user_id):
        with db() as conn:
            return create_session(conn, int(user_id), ttl_seconds=3600)

    def _telegram_init_data(self, chat_id, bot_token="123456:tweet-token"):
        values = {
            "auth_date": str(int(time.time())),
            "user": json.dumps(
                {
                    "id": int(chat_id),
                    "first_name": "Telegram",
                    "last_name": "用户",
                    "username": "telegram_user",
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        }
        data_check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
        secret_key = hmac.new(
            bot_token.encode("utf-8"), b"WebAppData", hashlib.sha256
        ).digest()
        values["hash"] = hmac.new(
            secret_key, data_check.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return urlencode(values)

    def test_members_need_only_positive_chat_id_and_keep_internal_owner_boundary(self):
        self._member(101, "tweet_alice")
        self._member(202, self.bob_id)
        rows = {row["chat_id"]: row for row in tweet_tg._list_members()}
        self.assertEqual(rows[101]["web_user_id"], self.alice_id)
        self.assertEqual(rows[202]["web_user_id"], self.bob_id)
        with TestClient(self._app()) as client:
            added = client.post("/api/admin/tg_tweet/members", json={"chat_id": 303, "label": "ID only"})
            rejected = client.post("/api/admin/tg_tweet/members", json={"chat_id": "@not-supported"})
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(int(tweet_tg._load_enabled_member(303)["web_user_id"]), self.alice_id)
        self.assertEqual(rejected.status_code, 400)

    def test_tweet_member_save_fetches_telegram_profile_and_keeps_custom_label(self):
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        with mock.patch.object(
            tweet_tg,
            "fetch_telegram_chat_profile",
            return_value={"username": "tweet_user", "display_name": "推文用户"},
        ) as fetch:
            tweet_tg.upsert_tweet_member(
                tweet_tg.TweetTgMemberPayload(chat_id=303, label="客户A"),
                self._get,
                default_web_user=self.alice_id,
            )
        fetch.assert_called_once_with("123456:tweet-token", 303)
        row = tweet_tg._list_members()[0]
        self.assertEqual(row["tg_username"], "tweet_user")
        self.assertEqual(row["tg_display_name"], "推文用户")
        self.assertEqual(row["label"], "客户A")

    def test_tweet_member_username_reference_resolves_chat_id(self):
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        with mock.patch.object(
            tweet_tg,
            "fetch_telegram_chat_profile",
            return_value={"chat_id": 404, "username": "tweet_user", "display_name": "推文用户"},
        ) as fetch:
            tweet_tg.upsert_tweet_member(
                tweet_tg.TweetTgMemberPayload(chat_id="@tweet_user"),
                self._get,
                default_web_user=self.alice_id,
            )
        fetch.assert_called_once_with("123456:tweet-token", "@tweet_user")
        row = tweet_tg._list_members()[0]
        self.assertEqual(row["chat_id"], 404)
        self.assertEqual(row["label"], "推文用户")

    def test_tweet_member_profile_failure_does_not_block_authorization(self):
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        with mock.patch.object(tweet_tg, "fetch_telegram_chat_profile", side_effect=RuntimeError("offline")):
            tweet_tg.upsert_tweet_member(
                tweet_tg.TweetTgMemberPayload(chat_id=505),
                self._get,
                default_web_user=self.alice_id,
            )
        row = tweet_tg._list_members()[0]
        self.assertEqual(row["chat_id"], 505)
        self.assertEqual(row["tg_username"], "")
        self.assertEqual(row["tg_display_name"], "")
        self.assertEqual(row["label"], "TG-505")

    def test_tweet_member_settings_backfill_missing_profile(self):
        tweet_tg.upsert_tweet_member(
            tweet_tg.TweetTgMemberPayload(chat_id=606, label="客户B"),
            self._get,
            default_web_user=self.alice_id,
        )
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        with mock.patch.object(
            tweet_tg,
            "fetch_telegram_chat_profile",
            return_value={"username": "backfilled", "display_name": "回填用户"},
        ) as fetch:
            settings = tweet_tg.load_tweet_tg_settings(self._get)
        fetch.assert_called_once_with("123456:tweet-token", 606)
        row = settings["trusted_users"][0]
        self.assertEqual(row["tg_username"], "backfilled")
        self.assertEqual(row["tg_display_name"], "回填用户")
        self.assertEqual(row["label"], "客户B")

    def test_tweet_bot_profile_fallback_keeps_existing_label(self):
        tweet_tg.upsert_tweet_member(
            tweet_tg.TweetTgMemberPayload(chat_id=707, label="固定备注"),
            self._get,
            default_web_user=self.alice_id,
        )
        tweet_tg.remember_tweet_member_profile(707, username="fallback_user", display_name="回退用户")
        row = tweet_tg._list_members()[0]
        self.assertEqual(row["tg_username"], "fallback_user")
        self.assertEqual(row["tg_display_name"], "回退用户")
        self.assertEqual(row["label"], "固定备注")

    def test_tweet_bot_authorization_reports_profile_without_changing_member_binding(self):
        remember = mock.Mock()
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id, "label": "固定备注"},
            remember_member_profile=remember,
        )
        chat = SimpleNamespace(id=808, type="private")
        from_user = SimpleNamespace(id=808, username="profile_user", first_name="资料", last_name="用户")
        replies = []

        async def reply(text, **_kwargs):
            replies.append(text)

        member = asyncio.run(controller._authorized(chat, from_user, reply))
        self.assertEqual(member["label"], "固定备注")
        remember.assert_called_once_with(808, username="profile_user", display_name="资料 用户")
        self.assertEqual(replies, [])

    def test_disable_rebind_and_delete_clear_native_state(self):
        self._member(101, self.alice_id)
        save_state(101, selected_persona_id="persona-a", mode="draft_edit", payload={"post_id": "p1"})
        callback_token(101, "d", {"post_id": "p1"})
        with TestClient(self._app()) as client:
            response = client.post("/api/admin/tg_tweet/members/101/toggle", json={"enabled": False})
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(load_state(101)["selected_persona_id"], "")
        with db() as conn:
            count = conn.execute("SELECT COUNT(*) AS count FROM telegram_tweet_bot_callbacks WHERE chat_id=101").fetchone()
        self.assertEqual(int(count["count"]), 0)
        self._member(101, self.alice_id)
        save_state(101, selected_persona_id="persona-a")
        self._member(101, self.bob_id)
        self.assertEqual(load_state(101)["selected_persona_id"], "")
        with TestClient(self._app()) as client:
            self.assertEqual(client.delete("/api/admin/tg_tweet/members/101").status_code, 200)
        self.assertIsNone(tweet_tg._load_enabled_member(101))

    def test_callback_tokens_are_short_chat_bound_and_capped(self):
        first = callback_token(101, "d", {"post_id": "secret-post"})
        self.assertLessEqual(len(first.encode("utf-8")), 64)
        _, action, token = first.split(":")
        self.assertEqual(resolve_callback_token(101, action, token)["post_id"], "secret-post")
        with self.assertRaisesRegex(HTTPException, "已过期"):
            resolve_callback_token(202, action, token)
        self.assertEqual(resolve_callback_token(101, action, token, consume=True)["post_id"], "secret-post")
        with self.assertRaisesRegex(HTTPException, "已过期"):
            resolve_callback_token(101, action, token, consume=True)
        for index in range(210):
            callback_token(101, "d", {"post_id": str(index)})
        with db() as conn:
            count = conn.execute("SELECT COUNT(*) AS count FROM telegram_tweet_bot_callbacks WHERE chat_id=101").fetchone()
        self.assertLessEqual(int(count["count"]), 200)

    def test_native_controller_persists_persona_creation_flow(self):
        calls = []

        def dispatch(user_id, action, payload):
            calls.append((user_id, action, payload))
            if action == "personas.create":
                return {"id": "persona-new", "name": payload["name"]}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id, "web_username": "tweet_alice"},
        )
        prompt = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:persona_new", prompt), _Types))
        self.assertEqual(load_state(101)["mode"], "persona_new")
        answer = _Message(text="科技观察员｜关注 AI 产品")
        asyncio.run(controller.handle_text(answer, _Types))
        self.assertEqual(load_state(101)["selected_persona_id"], "persona-new")
        self.assertEqual(calls[-1][1], "personas.create")
        self.assertEqual(calls[-1][2]["content"], "关注 AI 产品")

    def test_main_menu_uses_compact_persistent_control_keyboard(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(
                dispatch=lambda _uid, _action, _payload: [],
                dispatch_async=_unused_async_dispatch,
            ),
            get_runtime=self._get,
            load_member=lambda chat_id: {
                "chat_id": chat_id,
                "web_user_id": self.alice_id,
                "web_username": "tweet_alice",
            },
        )
        message = _Message()
        asyncio.run(controller.send_main_menu(message, _Types))
        markup = message.answers[-1][1]["reply_markup"]
        self.assertIsInstance(markup, _ReplyMarkup)
        self.assertEqual([len(row) for row in markup.keyboard], [2, 2])
        self.assertEqual(
            [[button.text for button in row] for row in markup.keyboard],
            [
                ["👤 我的人设", "📊 排程状态"],
                ["🔐 账号管理", "🛑 停止当前任务"],
            ],
        )
        self.assertTrue(markup.resize_keyboard)
        self.assertTrue(markup.is_persistent)
        self.assertNotIn("请选择功能。", message.answers[-1][0])

    def test_root_controls_open_cross_persona_pages_and_leave_input_mode(self):
        def dispatch(_user_id, action, _payload):
            if action == "personas.list":
                return [{"id": "persona-a", "name": "A", "counts": {"posts": 2, "favorites": 1}}]
            if action == "accounts.list":
                return [{"id": "account-a", "platform": "threads", "username": "alice", "status": "authorized"}]
            if action == "tasks.list":
                return []
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(
                dispatch=dispatch,
                dispatch_async=_unused_async_dispatch,
            ),
            get_runtime=self._get,
            load_member=lambda chat_id: {
                "chat_id": chat_id,
                "web_user_id": self.alice_id,
                "web_username": "tweet_alice",
            },
        )
        expected_callbacks = {
            "👤 我的人设": {
                "tt:matrix", "tt:persona_new", "tt:persona_ai_new", "tt:persona_copy_new", "tt:menu",
            },
            "📊 排程状态": {
                "tt:tasks:0:pending", "tt:tasks:0:failed", "tt:tasks:0:scheduled",
                "tt:tasks:0:immediate", "tt:tasks:0:running",
                "tt:tasks:0:manual", "tt:tasks:0:paused", "tt:tasks:0:completed", "tt:tasks:0:cancelled",
                "tt:taskfilter:platform", "tt:taskfilter:persona", "tt:menu",
            },
            "🔐 账号管理": {
                "tt:vectosession",
                "tt:platformaccounts",
                "tt:menu",
            },
        }
        for label, callbacks in expected_callbacks.items():
            save_state(101, selected_persona_id="persona-a", mode="draft_edit", payload={"post_id": "p1"})
            message = _Message(text=label)
            asyncio.run(controller.handle_text(message, _Types))
            self.assertEqual(load_state(101)["mode"], "")
            markup = message.answers[-1][1]["reply_markup"]
            actual = {
                button.callback_data for row in markup.inline_keyboard for button in row
                if getattr(button, "callback_data", None) and not button.callback_data.startswith("tt:p:")
            }
            self.assertEqual(actual, callbacks)

    def test_schedule_status_summary_exposes_r18_style_buckets_and_filters(self):
        def dispatch(_user_id, action, _payload):
            if action == "tasks.list":
                return [
                    {
                        "id": "scheduled-1", "status": "pending", "platform": "threads",
                        "persona_id": "persona-a", "created_at": 1000, "scheduled_at": 2000,
                        "task_type": "publish_post",
                    },
                    {
                        "id": "immediate-1", "status": "queued", "platform": "instagram",
                        "persona_id": "persona-a", "created_at": 1000, "scheduled_at": 0,
                        "task_type": "publish_post",
                    },
                    {
                        "id": "running-1", "status": "running", "platform": "threads",
                        "persona_id": "persona-a", "task_type": "publish_post",
                    },
                    {
                        "id": "failed-1", "status": "failed", "platform": "threads",
                        "persona_id": "persona-a", "task_type": "publish_post",
                    },
                ]
            if action == "personas.list":
                return [{"id": "persona-a", "name": "科技观察员"}]
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message(text="📊 排程状态")
        asyncio.run(controller.handle_text(message, _Types))
        text = message.answers[-1][0]
        self.assertIn("待发布：2", text)
        self.assertIn("定时任务：1", text)
        self.assertIn("立即任务：1", text)
        self.assertIn("执行中：1", text)
        self.assertIn("失败：1", text)
        callbacks = {
            button.callback_data
            for row in message.answers[-1][1]["reply_markup"].inline_keyboard
            for button in row
            if getattr(button, "callback_data", None)
        }
        self.assertTrue({
            "tt:tasks:0:pending", "tt:tasks:0:scheduled", "tt:tasks:0:immediate",
            "tt:tasks:0:running", "tt:tasks:0:failed", "tt:taskfilter:platform",
            "tt:taskfilter:persona", "tt:menu",
        }.issubset(callbacks))
        asyncio.run(controller.handle_callback(_Query("tt:taskfilter:platform", message), _Types))
        self.assertIn("按平台筛选任务", message.edits[-1][0])
        platform_callbacks = [
            button.callback_data
            for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:taskview:")
        ]
        self.assertTrue(platform_callbacks)

    def test_schedule_status_keeps_r18_terminal_and_manual_buckets_distinct(self):
        now = int(time.time())
        self.assertEqual(_task_bucket({"status": "preparing"}, now=now), "immediate")
        self.assertEqual(_task_bucket({"status": "publishing"}, now=now), "running")
        self.assertEqual(_task_bucket({"status": "need_manual"}, now=now), "manual")
        self.assertEqual(_task_bucket({"status": "paused"}, now=now), "paused")
        self.assertEqual(_task_bucket({"status": "done"}, now=now), "completed")
        self.assertEqual(_task_bucket({"status": "cancelled"}, now=now), "cancelled")
        self.assertEqual(
            _task_timestamp("2026-09-15T12:30:00+08:00"),
            _task_timestamp("2026-09-15T04:30:00Z"),
        )

    def test_account_management_drills_into_persona_binding_actions(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, dict(payload)))
            if action == "accounts.list":
                return [{
                    "id": "account-a",
                    "platform": "threads",
                    "username": "alice",
                    "status": "ready",
                    "health_status": "alive",
                    "auth_provider": "browser",
                    "persona_id": "",
                }]
            if action == "personas.list":
                return [{"id": "persona-a", "name": "科技观察员", "counts": {"posts": 1}}]
            if action == "accounts.bind_persona":
                return {"id": "account-a", "persona_id": "persona-a"}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message(text="🔐 账号管理")
        asyncio.run(controller.handle_text(message, _Types))
        menu_markup = message.answers[-1][1]["reply_markup"]
        self.assertIn("tt:platformaccounts", {
            button.callback_data
            for row in menu_markup.inline_keyboard
            for button in row
            if getattr(button, "callback_data", None)
        })

        asyncio.run(controller.handle_callback(_Query("tt:platformaccounts", message), _Types))
        list_markup = message.edits[-1][1]["reply_markup"]
        account_callback = next(
            button.callback_data
            for row in list_markup.inline_keyboard
            for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:ac:")
        )
        asyncio.run(controller.handle_callback(_Query(account_callback, message), _Types))
        detail_markup = message.edits[-1][1]["reply_markup"]
        bind_callback = next(
            button.callback_data
            for row in detail_markup.inline_keyboard
            for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:acbind:")
        )
        asyncio.run(controller.handle_callback(_Query(bind_callback, message), _Types))
        picker_markup = message.edits[-1][1]["reply_markup"]
        bind_select = next(
            button.callback_data
            for row in picker_markup.inline_keyboard
            for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:acbindselect:")
        )
        asyncio.run(controller.handle_callback(_Query(bind_select, message), _Types))
        self.assertIn(
            ("accounts.bind_persona", {"account_id": "account-a", "persona_id": "persona-a", "replace_existing_binding": True}),
            calls,
        )

    def test_vecto_session_and_platform_accounts_are_separate_callback_pages(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, dict(payload)))
            if action == "accounts.list":
                return [{"id": "account-a", "platform": "threads", "username": "alice", "status": "ready"}]
            if action == "auth.logout":
                return {"ok": True, "revoked_sessions": 2}
            return []

        async def chat_login(*_args, **_kwargs):
            return None

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {
                "chat_id": chat_id,
                "web_user_id": self.alice_id,
                "web_username": "tweet_alice",
            },
            chat_login=chat_login,
        )
        message = _Message(text="🔐 账号管理")
        asyncio.run(controller.handle_text(message, _Types))
        menu = message.answers[-1][1]["reply_markup"]
        callbacks = {
            button.callback_data
            for row in menu.inline_keyboard
            for button in row
            if getattr(button, "callback_data", None)
        }
        self.assertEqual(callbacks, {"tt:vectosession", "tt:platformaccounts", "tt:menu"})

        asyncio.run(controller.handle_callback(_Query("tt:vectosession", message), _Types))
        vecto_text, vecto_kwargs = message.edits[-1]
        self.assertIn("VECTO 网页账号", vecto_text)
        vecto_callbacks = {
            button.callback_data
            for row in vecto_kwargs["reply_markup"].inline_keyboard
            for button in row
            if getattr(button, "callback_data", None)
        }
        self.assertEqual(vecto_callbacks, {"tt:chatlogin", "tt:aclogout", "tt:accountmenu"})

        asyncio.run(controller.handle_callback(_Query("tt:platformaccounts", message), _Types))
        platform_text, platform_kwargs = message.edits[-1]
        self.assertIn("已绑定账号", platform_text)
        self.assertNotIn("VECTO 网页账号", platform_text)
        platform_callbacks = {
            button.callback_data
            for row in platform_kwargs["reply_markup"].inline_keyboard
            for button in row
            if getattr(button, "callback_data", None)
        }
        self.assertIn("tt:accountmenu", platform_callbacks)

        asyncio.run(controller.handle_callback(_Query("tt:aclogout", message), _Types))
        self.assertIn(("auth.logout", {"chat_id": 101}), calls)
        self.assertIn("Telegram 推文工作台也已停止使用", message.edits[-1][0])

    def test_persona_list_and_detail_keep_related_actions_in_one_path(self):
        def dispatch(_user_id, action, _payload):
            if action == "personas.list":
                return [{"id": "persona-a", "name": "科技观察员", "counts": {"posts": 2, "favorites": 1}}]
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message(text="👤 我的人设")
        asyncio.run(controller.handle_text(message, _Types))
        list_markup = message.answers[-1][1]["reply_markup"]
        self.assertEqual(list_markup.inline_keyboard[0][0].callback_data, "tt:matrix")
        self.assertEqual(list_markup.inline_keyboard[1][0].callback_data, "tt:persona_new")
        persona_callback = next(
            button.callback_data for row in list_markup.inline_keyboard for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:p:")
        )
        asyncio.run(controller.handle_callback(_Query(persona_callback, message), _Types))
        callbacks = {
            button.callback_data for row in message.edits[-1][1]["reply_markup"].inline_keyboard for button in row
            if getattr(button, "callback_data", None)
        }
        self.assertEqual(callbacks, {
            "tt:pmod:create", "tt:pmod:content", "tt:pmod:publish", "tt:pmod:settings", "tt:personas:0",
        })
        self.assertNotIn("tt:postsmenu", callbacks)
        self.assertNotIn("tt:createmenu", callbacks)
        asyncio.run(controller.handle_callback(_Query("tt:pmod:create", message), _Types))
        create_module_callbacks = {
            button.callback_data for row in message.edits[-1][1]["reply_markup"].inline_keyboard for button in row
            if getattr(button, "callback_data", None)
        }
        self.assertIn("tt:createmenu", create_module_callbacks)
        self.assertIn("tt:imageposts:0", create_module_callbacks)
        self.assertIn("tt:personaimage", create_module_callbacks)
        asyncio.run(controller.handle_callback(_Query("tt:createmenu", message), _Types))
        create_callbacks = {
            button.callback_data for row in message.edits[-1][1]["reply_markup"].inline_keyboard for button in row
            if getattr(button, "callback_data", None) and not button.callback_data.startswith("tt:p:")
        }
        self.assertEqual(create_callbacks, {"tt:generate", "tt:hot", "tt:draft_new", "tt:pmod:create"})

    def test_persona_publish_history_is_scoped_to_selected_persona(self):
        def dispatch(_user_id, action, _payload):
            if action == "tasks.list":
                return [
                    {"id": "ok-a", "persona_id": "persona-a", "status": "success", "_tg_task_kind": "social", "platform": "threads"},
                    {"id": "ok-b", "persona_id": "persona-b", "status": "success", "_tg_task_kind": "social", "platform": "threads"},
                    {"id": "failed-a", "persona_id": "persona-a", "status": "failed", "_tg_task_kind": "social", "platform": "threads"},
                ]
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a")
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:persona_history", message), _Types))
        self.assertIn("发布历史（1 条）", message.edits[-1][0])
        task_buttons = [
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:t:")
        ]
        self.assertEqual(len(task_buttons), 1)

    def test_stop_current_task_cancels_active_tasks_and_pending_input(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "tasks.list":
                return [
                    {"id": "running-a", "status": "running"},
                    {"id": "scheduled-a", "status": "scheduled"},
                ]
            if action == "tasks.cancel":
                return {"message": "已取消"}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a", mode="generate_prompt", payload={"count": 3})
        message = _Message(text="🛑 停止当前任务")
        asyncio.run(controller.handle_text(message, _Types))
        cancelled = [payload["task_id"] for action, payload in calls if action == "tasks.cancel"]
        self.assertEqual(cancelled, ["running-a", "scheduled-a"])
        self.assertEqual(load_state(101)["mode"], "")
        self.assertEqual(load_state(101)["payload"], {})
        self.assertIn("未提交的输入步骤已取消", message.answers[-1][0])

    def test_r18_pagination_has_first_previous_next_last_and_clamps_stale_page(self):
        rows, page, total_pages = _pagination_rows(
            _Types,
            page=1,
            total_items=15,
            callback_for_page=lambda target: f"tt:test:{target}",
            page_size=6,
        )
        self.assertEqual((page, total_pages), (1, 3))
        labels = [button.text for row in rows for button in row]
        self.assertIn("⏮ 首页", labels)
        self.assertIn("◀️ 上一页", labels)
        self.assertIn("下一页 ▶️", labels)
        self.assertIn("尾页 ⏭", labels)
        self.assertEqual(
            {button.callback_data for row in rows for button in row},
            {"tt:test:0", "tt:test:1", "tt:test:2"},
        )
        _rows, clamped_page, _clamped_total = _pagination_rows(
            _Types,
            page=99,
            total_items=15,
            callback_for_page=lambda target: f"tt:test:{target}",
            page_size=6,
        )
        self.assertEqual(clamped_page, 2)

    def test_persona_image_options_follow_web_dependency_buckets_and_keep_china_default(self):
        options = {
            "character_gender": "female",
            "character_age": "23_27",
            "character_hairstyle": "crew_cut",
            "character_temperament": "street",
            "character_clothing": "dark_suit_male",
        }
        reconciled = _reconcile_persona_image_options(options)
        self.assertNotIn("character_hairstyle", reconciled)
        self.assertNotIn("character_temperament", reconciled)
        self.assertNotIn("character_clothing", reconciled)
        _label, hair_values = _persona_image_option_definition("character_hairstyle", reconciled)
        self.assertIn("soft_wave", {key for key, _caption in hair_values})
        _region_label, region_values = _persona_image_option_definition("digital_human_character_region", {})
        self.assertEqual(region_values[0][0], "china")

    def test_image_post_list_enters_image_options_and_submits_canonical_payload(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "posts.list":
                return [{"id": "post-a", "content": "在咖啡店观察 AI 产品"}]
            if action == "image.styles":
                return {"image_styles": [{"kind": "scene", "label": "咖啡店街景"}]}
            if action == "image.generate":
                return {"task_id": "image-task-1"}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a")
        message = _Message()
        post_button = callback_token(101, "d", {
            "persona_id": "persona-a", "post_id": "post-a", "source": "posts", "intent": "image",
        })
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(post_button, message), _Types))
        self.assertIn("推文配图设置", message.edits[-1][0])
        style_button = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if "写实摄影" in str(button.text)
        )
        asyncio.run(controller.handle_callback(_Query(style_button.callback_data, message), _Types))
        direction_button = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if "生成构图方向" in str(button.text)
        )
        asyncio.run(controller.handle_callback(_Query(direction_button.callback_data, message), _Types))
        composition_button = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if "咖啡店街景" in str(button.text)
        )
        asyncio.run(controller.handle_callback(_Query(composition_button.callback_data, message), _Types))
        generate_button = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(button.text).endswith("提交配图任务")
        )
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(generate_button.callback_data, message), _Types))
        image_calls = [payload for action, payload in calls if action == "image.generate"]
        self.assertEqual(len(image_calls), 1)
        self.assertEqual(image_calls[0]["post_id"], "post-a")
        self.assertEqual(image_calls[0]["image_render_style"], "photorealistic")
        self.assertIn("aspect_ratio", image_calls[0])
        self.assertEqual(image_calls[0]["image_mode"], "scene")
        self.assertEqual(image_calls[0]["image_composition_label"], "咖啡店街景")
        self.assertEqual(image_calls[0]["image_count"], 1)

    def test_persona_image_options_keep_defaults_and_support_library_actions(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "persona_image.list":
                return {"items": [{"id": "img-1", "created_at": "2026-09-15T10:00:00", "source": "生成", "is_reference": True}]}
            if action == "persona_image.generate":
                return {"task_id": "persona-image-task"}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a")
        message = _Message()
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query("tt:personaimage", message), _Types))
        self.assertIn("人设图与图库", message.edits[-1][0])
        region = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(button.text).startswith("地区特征")
        )
        asyncio.run(controller.handle_callback(_Query(region.callback_data, message), _Types))
        europe = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if "欧美" in str(button.text)
        )
        asyncio.run(controller.handle_callback(_Query(europe.callback_data, message), _Types))
        direct = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if "直接生成" in str(button.text)
        )
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(direct.callback_data, message), _Types))
        image_calls = [payload for action, payload in calls if action == "persona_image.generate"]
        self.assertEqual(image_calls[0]["persona_image_options"]["digital_human_character_region"], "europe_america")
        self.assertIn("persona_image.list", [action for action, _payload in calls])

    def test_generation_resumes_after_persona_and_confirms_before_enqueue(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "personas.list":
                return [{"id": "persona-a", "name": "科技观察员", "counts": {"posts": 0, "favorites": 0}}]
            if action == "generation.start":
                return {"task_id": "gen-task-1"}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:generate", message), _Types))
        self.assertEqual(load_state(101)["payload"]["resume_action"], "generate")
        persona_callback = next(
            button.callback_data
            for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row
            if str(getattr(button, "callback_data", "")).startswith("tt:p:")
        )
        asyncio.run(controller.handle_callback(_Query(persona_callback, message), _Types))
        self.assertEqual(load_state(101)["mode"], "generate_count")
        self.assertIn("第 1/3 步", message.edits[-1][0])
        asyncio.run(controller.handle_callback(_Query("tt:gcount:3", message), _Types))
        asyncio.run(controller.handle_callback(_Query("tt:gwords:120", message), _Types))
        self.assertEqual(load_state(101)["mode"], "generate_prompt")
        prompt = _Message(text="AI 产品趋势")
        asyncio.run(controller.handle_text(prompt, _Types))
        self.assertEqual(load_state(101)["mode"], "generate_confirm")
        self.assertEqual([action for action, _payload in calls].count("generation.start"), 0)
        confirm = prompt.answers[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(confirm, prompt), _Types))
        generated = [payload for action, payload in calls if action == "generation.start"]
        self.assertEqual(len(generated), 1)
        self.assertEqual(generated[0]["count"], 3)
        self.assertEqual(generated[0]["target_words"], 120)
        self.assertEqual(generated[0]["prompt"], "AI 产品趋势")

    def test_generation_memory_picker_keeps_selected_context_in_enqueue_payload(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "profile.memories":
                return {"memories": [
                    {"id": "memory-1", "summary": "保持科技观察员的克制语气"},
                    {"id": "memory-2", "summary": "优先使用真实案例和可执行建议"},
                ]}
            if action == "generation.start":
                return {"task_id": "memory-gen-task"}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a", mode="generate_confirm", payload={
            "count": 1,
            "target_words": 120,
            "prompt": "AI 产品趋势",
            "platform": "threads",
            "writing_locale": "zh-TW",
            "selected_memory_ids": [],
            "selected_memory_summaries": [],
            "selected_directions": ["真实案例"],
            "selection_required": True,
        })
        message = _Message()
        opening = callback_token(101, "gmem", {"page": 0})
        asyncio.run(controller.handle_callback(_Query(opening, message), _Types))
        memory_button = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(getattr(button, "callback_data", "")).startswith("tt:gmempick:")
        )
        asyncio.run(controller.handle_callback(_Query(memory_button.callback_data, message), _Types))
        self.assertEqual(load_state(101)["mode"], "generate_memories")
        self.assertEqual(load_state(101)["payload"]["selected_memory_ids"], ["memory-1"])
        confirm_button = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(getattr(button, "callback_data", "")).startswith("tt:gmemconfirm:")
        )
        asyncio.run(controller.handle_callback(_Query(confirm_button.callback_data, message), _Types))
        submit_button = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0]
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(submit_button.callback_data, message), _Types))
        generated = [payload for action, payload in calls if action == "generation.start"]
        self.assertEqual(len(generated), 1)
        self.assertEqual(generated[0]["selected_memory_ids"], ["memory-1"])
        self.assertEqual(generated[0]["selected_memory_summaries"], ["保持科技观察员的克制语气"])
        self.assertEqual(generated[0]["selected_directions"], ["真实案例"])

    def test_generation_direction_picker_can_refresh_without_dropping_confirmation_state(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "post_directions":
                return {"keywords": [
                    "方向一", "方向二", "方向三", "方向四", "方向五",
                    "方向六", "方向七", "方向八", "方向九", "方向十",
                ]}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a", mode="generate_confirm", payload={
            "prompt": "AI 产品趋势", "platform": "threads", "writing_locale": "zh-TW",
        })
        message = _Message()
        first = callback_token(101, "gdir", {})
        asyncio.run(controller.handle_callback(_Query(first, message), _Types))
        refresh = next(
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(button.text) == "换一批"
        )
        asyncio.run(controller.handle_callback(_Query(refresh.callback_data, message), _Types))
        direction_calls = [payload for action, payload in calls if action == "post_directions"]
        self.assertEqual(len(direction_calls), 2)
        self.assertEqual(direction_calls[1]["previous_keywords"], direction_calls[0]["previous_keywords"] or [
            "方向一", "方向二", "方向三", "方向四", "方向五",
            "方向六", "方向七", "方向八", "方向九", "方向十",
        ])
        self.assertNotEqual(direction_calls[0]["idempotency_key"], direction_calls[1]["idempotency_key"])
        self.assertEqual(load_state(101)["mode"], "generate_directions")

    def test_return_callback_restores_reply_control_keyboard(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(
                dispatch=lambda _uid, _action, _payload: [],
                dispatch_async=_unused_async_dispatch,
            ),
            get_runtime=self._get,
            load_member=lambda chat_id: {
                "chat_id": chat_id,
                "web_user_id": self.alice_id,
                "web_username": "tweet_alice",
            },
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:menu", message), _Types))
        self.assertEqual(message.edits[-1][0], "已返回推文工作台总控菜单。")
        self.assertIsInstance(message.answers[-1][1]["reply_markup"], _ReplyMarkup)

    def test_native_publish_selects_bound_account_and_requires_confirmation(self):
        calls = []

        def dispatch(user_id, action, payload):
            calls.append((user_id, action, payload))
            if action == "accounts.list":
                return [{
                    "id": "account-1", "persona_id": "persona-a", "platform": "threads",
                    "username": "alice_threads", "status": "authorized",
                }]
            if action == "publish.start":
                return {"task": {}}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id, "web_username": "tweet_alice"},
        )
        save_state(101, selected_persona_id="persona-a")
        message = _Message()
        publish_button = callback_token(101, "pub", {"source": "posts", "post_id": "post-1"})
        asyncio.run(controller.handle_callback(_Query(publish_button, message), _Types))
        picker = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        self.assertTrue(picker.startswith("tt:pa:"))
        asyncio.run(controller.handle_callback(_Query(picker, message), _Types))
        confirmation = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        self.assertTrue(confirmation.startswith("tt:pubok:"))
        asyncio.run(controller.handle_callback(_Query(confirmation, message), _Types))
        published = [item for item in calls if item[1] == "publish.start"]
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0][2]["account_id"], "account-1")
        with self.assertLogs("webapp.telegram_tweet_bot", level="ERROR"):
            asyncio.run(controller.handle_callback(_Query(confirmation, message), _Types))
        self.assertEqual(len([item for item in calls if item[1] == "publish.start"]), 1)

    def test_tweet_config_is_field_scoped_and_token_conflict_requires_both_enabled(self):
        captured = []

        def save(updates):
            captured.append(dict(updates))
            self._save(updates)

        with mock.patch.object(tweet_tg, "verify_bot_token", return_value={"username": "same_bot", "id": 10}), \
             mock.patch.object(tweet_tg, "reload_tweet_telegram_bot_worker"):
            with self.assertRaisesRegex(HTTPException, "不能与视频工作台共用"):
                tweet_tg.save_tweet_tg_env(
                    tweet_tg.TweetTgEnvPayload(bot_token="video-token-must-not-change", bot_enabled=True),
                    self._get,
                    self._save,
                )
        self.runtime.update({"telegram_tweet_bot_token": "123456:tweet-token", "telegram_tweet_bot_enabled": False})
        with mock.patch.object(telegram_admin, "verify_bot_token", return_value={"username": "same_bot", "id": 10}), \
             mock.patch.object(telegram_admin, "reload_telegram_bot_worker"):
            allowed = telegram_admin.save_tg_env(
                telegram_admin.TgEnvPayload(bot_token="123456:tweet-token", bot_enabled=True),
                self._get,
                self._save,
            )
        self.assertTrue(allowed["ok"])

    def test_tweet_token_verification_errors_are_actionable_and_not_persisted(self):
        with mock.patch.object(tweet_tg, "verify_bot_token", side_effect=RuntimeError("Not Found")):
            with self.assertRaises(HTTPException) as ctx:
                tweet_tg.save_tweet_tg_env(
                    tweet_tg.TweetTgEnvPayload(bot_token="123456:invalid", bot_enabled=True),
                    self._get,
                    self._save,
                )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("无效或已撤销", str(ctx.exception.detail))
        self.assertEqual(self.runtime["telegram_tweet_bot_token"], "")
        self.assertFalse(self.runtime["telegram_tweet_bot_enabled"])

    def test_database_lease_allows_only_one_poller_owner(self):
        token = "123456:tweet-token"
        with db() as conn:
            tweet_tg.ensure_tweet_telegram_schema(conn)
            conn.execute(
                "INSERT INTO telegram_tweet_bot_leases(name,owner_id,expires_at,updated_at) VALUES (?,?,?,?)",
                (tweet_tg._lease_name(token), "other-process", time.time() + 60, time.time()),
            )
        self.assertFalse(tweet_tg._acquire_or_renew_bot_lease(token))
        with db() as conn:
            conn.execute("UPDATE telegram_tweet_bot_leases SET expires_at = 0")
        self.assertTrue(tweet_tg._acquire_or_renew_bot_lease(token))
        tweet_tg._release_bot_lease(token)

    def test_disabled_worker_is_not_started_and_binding_routes_require_enabled_bot(self):
        tweet_tg._BOT_OPS = TweetWorkbenchOps(
            dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch,
        )
        with mock.patch.object(tweet_tg.threading, "Thread") as thread:
            tweet_tg.start_tweet_telegram_bot_worker(self._get)
        thread.assert_not_called()
        with TestClient(self._app()) as client:
            landing = client.get("/telegram/tweet/open?ticket=anything")
            exchange = client.post("/telegram/tweet/exchange", json={"ticket": "x", "init_data": "y"})
        self.assertEqual(landing.status_code, 410)
        self.assertEqual(exchange.status_code, 403)
        self.assertNotIn("session_token=", landing.headers.get("set-cookie", ""))
        self.assertNotIn("session_token=", exchange.headers.get("set-cookie", ""))

    def test_telegram_webapp_binds_chat_to_logged_in_user_without_admin_member_setup(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        session = self._session(self.alice_id)
        ticket_url = tweet_tg._create_link_ticket(101, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        init_data = self._telegram_init_data(101)
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", session)
            landing = client.get(ticket_url)
            exchange = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": ticket, "init_data": init_data},
            )
            reused = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": ticket, "init_data": init_data},
            )
        self.assertEqual(landing.status_code, 200, landing.text)
        self.assertIn("正在绑定 Telegram 推文工作台", landing.text)
        self.assertIn("vecto-telegram-tweet-login-context", landing.text)
        self.assertIn("telegram_tweet=1", landing.text)
        self.assertEqual(exchange.status_code, 200, exchange.text)
        self.assertEqual(exchange.json()["target"], tweet_tg.WEBAPP_TARGET)
        self.assertNotIn("session_token=", exchange.headers.get("set-cookie", ""))
        self.assertEqual(reused.status_code, 410)
        member = tweet_tg._load_enabled_member(101)
        self.assertIsNotNone(member)
        self.assertEqual(int(member["web_user_id"]), self.alice_id)
        self.assertEqual(str(member["linked_session_token_hash"]), session_storage_token(session))
        self.assertTrue(tweet_tg._member_has_active_web_session(member))

    def test_login_context_requires_signed_webapp_data_and_live_ticket(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        ticket_url = tweet_tg._create_link_ticket(303, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        self.assertEqual(
            tweet_tg.validate_tweet_webapp_login_context(
                ticket,
                self._telegram_init_data(303),
                self.runtime,
            ),
            303,
        )
        with self.assertRaises(HTTPException) as context:
            tweet_tg.validate_tweet_webapp_login_context(
                ticket,
                self._telegram_init_data(303, "wrong-token"),
                self.runtime,
            )
        self.assertEqual(context.exception.status_code, 401)

    def test_admin_webapp_binding_returns_admin_console_target(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        with db() as conn:
            conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (self.bob_id,))
            admin_session = create_session(
                conn,
                self.bob_id,
                ttl_seconds=3600,
                is_admin_session=True,
            )
        ticket_url = tweet_tg._create_link_ticket(111, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("admin_session_token", admin_session)
            exchange = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": ticket, "init_data": self._telegram_init_data(111)},
            )
        self.assertEqual(exchange.status_code, 200, exchange.text)
        self.assertEqual(exchange.json()["target"], tweet_tg.WEBAPP_ADMIN_TARGET)

    def test_binding_requires_browser_session_and_rejects_invalid_telegram_signature(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        ticket_url = tweet_tg._create_link_ticket(202, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            unauthenticated = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": ticket, "init_data": self._telegram_init_data(202)},
            )
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(unauthenticated.json()["detail"]["code"], "web_login_required")

        session = self._session(self.alice_id)
        invalid_ticket_url = tweet_tg._create_link_ticket(202, self._get)
        invalid_ticket = parse_qsl(urlsplit(invalid_ticket_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", session)
            rejected = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": invalid_ticket, "init_data": self._telegram_init_data(202, "wrong-token")},
            )
        self.assertEqual(rejected.status_code, 401)
        self.assertIsNone(tweet_tg._load_enabled_member(202))

    def test_deleted_member_invalidates_pending_self_service_ticket(self):
        ticket_url = tweet_tg._create_link_ticket(242, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            deleted = client.delete("/api/admin/tg_tweet/members/242")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        with self.assertRaises(HTTPException) as context:
            tweet_tg._ticket_chat_id(ticket)
        self.assertEqual(context.exception.status_code, 410)

    def test_disabling_member_invalidates_pending_self_service_ticket(self):
        self._member(262, self.alice_id)
        ticket_url = tweet_tg._create_link_ticket(262, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            disabled = client.post(
                "/api/admin/tg_tweet/members/262/toggle",
                json={"enabled": False},
            )
        self.assertEqual(disabled.status_code, 200, disabled.text)
        with self.assertRaises(HTTPException) as context:
            tweet_tg._ticket_chat_id(ticket)
        self.assertEqual(context.exception.status_code, 410)

    def test_signed_non_object_telegram_user_is_rejected_without_server_error(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        ticket_url = tweet_tg._create_link_ticket(252, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        values = {
            "auth_date": str(int(time.time())),
            "user": json.dumps([], separators=(",", ":")),
        }
        data_check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
        secret_key = hmac.new(
            b"123456:tweet-token", b"WebAppData", hashlib.sha256
        ).digest()
        values["hash"] = hmac.new(
            secret_key, data_check.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        session = self._session(self.alice_id)
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", session)
            rejected = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": ticket, "init_data": urlencode(values)},
            )
        self.assertEqual(rejected.status_code, 401, rejected.text)
        self.assertEqual(rejected.json()["detail"], "Telegram 用户身份无效")

    def test_mfa_setup_challenge_is_not_downgraded_to_login_required(self):
        request = SimpleNamespace(cookies={"session_token": "session-token"})
        challenge = HTTPException(
            status_code=428,
            detail={"code": "mfa_setup_required", "message": "administrator MFA enrollment is required"},
        )
        with mock.patch.object(tweet_tg, "get_current_user_for_session", side_effect=challenge):
            with self.assertRaises(HTTPException) as context:
                tweet_tg._authenticated_web_session(request)
        self.assertEqual(context.exception.status_code, 428)
        self.assertEqual(context.exception.detail["code"], "mfa_setup_required")

    def test_active_binding_cannot_be_claimed_by_another_logged_in_account(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        alice_session = self._session(self.alice_id)
        first_url = tweet_tg._create_link_ticket(212, self._get)
        first_ticket = parse_qsl(urlsplit(first_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", alice_session)
            first = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": first_ticket, "init_data": self._telegram_init_data(212)},
            )
        self.assertEqual(first.status_code, 200, first.text)

        bob_session = self._session(self.bob_id)
        second_url = tweet_tg._create_link_ticket(212, self._get)
        second_ticket = parse_qsl(urlsplit(second_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", bob_session)
            rejected = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": second_ticket, "init_data": self._telegram_init_data(212)},
            )
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "telegram_already_bound")
        self.assertEqual(int(tweet_tg._load_enabled_member(212)["web_user_id"]), self.alice_id)

    def test_stale_binding_can_be_reclaimed_after_old_web_session_logout(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        alice_session = self._session(self.alice_id)
        first_url = tweet_tg._create_link_ticket(222, self._get)
        first_ticket = parse_qsl(urlsplit(first_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", alice_session)
            first = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": first_ticket, "init_data": self._telegram_init_data(222)},
            )
        self.assertEqual(first.status_code, 200, first.text)
        with db() as conn:
            conn.execute(
                "UPDATE sessions SET revoked_at = ?, revoke_reason = 'test_logout' WHERE token = ?",
                (int(time.time()), session_storage_token(alice_session)),
            )

        bob_session = self._session(self.bob_id)
        second_url = tweet_tg._create_link_ticket(222, self._get)
        second_ticket = parse_qsl(urlsplit(second_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", bob_session)
            rebound = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": second_ticket, "init_data": self._telegram_init_data(222)},
            )
        self.assertEqual(rebound.status_code, 200, rebound.text)
        self.assertEqual(int(tweet_tg._load_enabled_member(222)["web_user_id"]), self.bob_id)

    def test_admin_disabled_binding_cannot_be_reenabled_by_self_service(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        session = self._session(self.alice_id)
        first_url = tweet_tg._create_link_ticket(232, self._get)
        first_ticket = parse_qsl(urlsplit(first_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", session)
            first = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": first_ticket, "init_data": self._telegram_init_data(232)},
            )
            self.assertEqual(first.status_code, 200, first.text)
            disabled = client.post("/api/admin/tg_tweet/members/232/toggle", json={"enabled": False})
            self.assertEqual(disabled.status_code, 200, disabled.text)

        second_url = tweet_tg._create_link_ticket(232, self._get)
        second_ticket = parse_qsl(urlsplit(second_url).query, keep_blank_values=True)[0][1]
        # Disabling a member revokes the linked session.  A fresh login still
        # must not be able to self-enable that administrator decision.
        fresh_session = self._session(self.alice_id)
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", fresh_session)
            rejected = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": second_ticket, "init_data": self._telegram_init_data(232)},
            )
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(rejected.json()["detail"]["code"], "telegram_binding_disabled")
        self.assertIsNone(tweet_tg._load_enabled_member(232))

    def test_bot_denies_bound_member_after_browser_session_logout(self):
        self.runtime.update({
            "telegram_tweet_bot_token": "123456:tweet-token",
            "telegram_tweet_bot_enabled": True,
        })
        session = self._session(self.alice_id)
        ticket_url = tweet_tg._create_link_ticket(303, self._get)
        ticket = parse_qsl(urlsplit(ticket_url).query, keep_blank_values=True)[0][1]
        with TestClient(self._app()) as client:
            client.cookies.set("session_token", session)
            exchange = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": ticket, "init_data": self._telegram_init_data(303)},
            )
        self.assertEqual(exchange.status_code, 200, exchange.text)
        member = tweet_tg._load_enabled_member(303)
        self.assertTrue(tweet_tg._member_has_active_web_session(member))
        with db() as conn:
            conn.execute(
                "UPDATE sessions SET revoked_at = ?, revoke_reason = 'test_logout' WHERE token = ?",
                (int(time.time()), session_storage_token(session)),
            )
        self.assertFalse(tweet_tg._member_has_active_web_session(member))
        replies = []

        async def reply(text, **_kwargs):
            replies.append(text)

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=tweet_tg._load_enabled_member,
            has_active_web_session=tweet_tg._member_has_active_web_session,
        )
        result = asyncio.run(
            controller._authorized(
                SimpleNamespace(id=303, type="private"),
                SimpleNamespace(id=303),
                reply,
            )
        )
        self.assertIsNone(result)
        self.assertIn("网页登录会话已失效", replies[-1])

    def test_unbound_bot_entry_offers_signed_webapp_binding_button(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda _chat_id: None,
            create_webapp_url=lambda chat_id, route: f"https://console.example.test/telegram/tweet/open?chat={chat_id}&route={route}",
        )
        message = _Message(chat_id=404)
        asyncio.run(controller.send_main_menu(message, _Types))
        self.assertIn("尚未绑定", message.answers[-1][0])
        markup = message.answers[-1][1]["reply_markup"]
        button = markup.inline_keyboard[0][0]
        self.assertEqual(button.web_app.url, "https://console.example.test/telegram/tweet/open?chat=404&route=home")

    def test_unauthorized_callback_acknowledges_spinner_before_binding_prompt(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda _chat_id: None,
            create_webapp_url=lambda chat_id, route: f"https://console.example.test/telegram/tweet/open?chat={chat_id}&route={route}",
        )
        message = _Message(chat_id=414)
        query = _Query("tt:help", message)
        asyncio.run(controller.handle_callback(query, _Types))
        self.assertTrue(query.answers)
        self.assertTrue(message.answers)
        self.assertIn("尚未绑定", message.answers[-1][0])
        self.assertIn("reply_markup", message.answers[-1][1])

    def test_admin_and_native_bot_frontend_contracts(self):
        webapp = Path(__file__).resolve().parents[1]
        html = (webapp / "static" / "admin.html").read_text(encoding="utf-8")
        admin_js = (webapp / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        console_js = (webapp / "static" / "assets" / "console.js").read_text(encoding="utf-8")
        server_source = (webapp / "server.py").read_text(encoding="utf-8")
        bot_source = (webapp / "telegram_tweet_bot.py").read_text(encoding="utf-8")
        admin_source = (webapp / "telegram_tweet_admin.py").read_text(encoding="utf-8")
        console_panel = html[html.index('data-tg-workbench-panel="console"'):html.index('data-tg-workbench-panel="crm"')]
        telegram_section = html[html.index('id="secTelegram"'):]
        self.assertNotIn('id="tgTweetContentSettingsEnabled"', console_panel)
        self.assertNotIn('id="tgTweetWebUser"', console_panel)
        self.assertNotIn('id="tgTweetPublicBaseUrl"', console_panel)
        self.assertNotIn('id="btnClearTgTweetToken"', console_panel)
        self.assertIn('可填 Chat ID 或 @用户名', console_panel)
        self.assertIn('自动读取 Telegram 用户名称', console_panel)
        self.assertIn('视频与推文工作台已接入', telegram_section)
        self.assertIn('<div class="admin-config-card-title">Telegram Bot</div>', console_panel)
        self.assertIn('<div class="admin-config-card-title">允许成员</div>', console_panel)
        self.assertIn('<th scope="col">用户名称</th>', console_panel)
        self.assertIn('<th scope="col">授权状态</th>', console_panel)
        self.assertIn('<th scope="col">时间</th>', console_panel)
        self.assertIn('placeholder="Chat ID 或 @用户名"', console_panel)
        self.assertIn('grid-template-rows: 28px 48px 68px 68px 42px', html)
        self.assertGreaterEqual(html.count('display: contents;'), 2)
        self.assertIn('grid-column: 1;\n      grid-row: 4;', html)
        self.assertIn('grid-column: 2;\n      grid-row: 4;', html)
        self.assertIn('height: 40px;', html)
        self.assertIn('flex-wrap: nowrap', html)
        self.assertIn('min-width: 88px', html)
        self.assertIn('admin-tg-member-empty', admin_js)
        self.assertIn('colspan="6"', admin_js)
        self.assertIn('/api/admin/tg_tweet/settings', admin_js)
        self.assertIn('/api/admin/runtime_config/secrets/telegram_tweet_bot_token', admin_js)
        self.assertIn('tgTweetBotTokenInputValue()', admin_js)
        self.assertIn('tgTweetBotToken: "telegram_tweet_bot_token"', admin_js)
        self.assertIn('input.dataset.runtimeSecretDirty === "true"', admin_js)
        self.assertIn('setButtonLoading("btnSaveTgTweetEnv", true, "保存中...")', admin_js)
        self.assertIn('setButtonLoading("btnTestTgTweetEnv", true, "检测中...")', admin_js)
        self.assertIn('callback_data="tt:personas:0"', bot_source)
        self.assertIn('F.photo | F.video | F.document', bot_source)
        self.assertIn('remember_member_profile', bot_source)
        self.assertIn('remember_tweet_member_profile', admin_source)
        self.assertIn("WebAppInfo", bot_source)
        self.assertIn("create_webapp_url", bot_source)
        self.assertIn("has_active_web_session", bot_source)
        self.assertNotIn("create_session(", admin_source)
        self.assertNotIn('initialConsoleParams.get("module")', console_js)
        self.assertIn('"hot.rewrite"', server_source)
        self.assertIn('"personas.ai_create"', server_source)
        self.assertIn('"personas.copy_analyze"', server_source)
        self.assertIn('mode == "hot_rewrite"', bot_source)
        self.assertIn('text="✍️ 改写"', bot_source)

    def test_hot_start_accepts_service_id_and_exposes_status_and_cancel(self):
        def dispatch(_user_id, action, _payload):
            if action == "hot.start":
                return {"id": "phc_test", "status": "queued"}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a", mode="hot_prompt", payload={})
        message = _Message(text="AI 热点")
        asyncio.run(controller.handle_text(message, _Types))
        self.assertEqual(load_state(101)["mode"], "hot_confirm")
        confirm = message.answers[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(confirm, message), _Types))
        state = load_state(101)
        self.assertEqual(state["payload"]["last_hot_task_id"], "phc_test")
        buttons = message.edits[-1][1]["reply_markup"].inline_keyboard[0]
        self.assertTrue(buttons[0].callback_data.startswith("tt:hotstatus:"))
        self.assertTrue(buttons[1].callback_data.startswith("tt:hotcancel:"))

    def test_hot_candidate_can_be_rewritten_then_imported(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "hot.rewrite":
                return {"ok": True, "content": "改写后的生活化热点正文，保留核心事实。"}
            if action == "hot.import":
                return {"posts": [{"id": "post-hot-1", "content": payload["candidates"][0]["content"]}]}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a", mode="hot_select", payload={
            "hot_candidates": [{"title": "热点标题", "content": "原始热点正文。", "platform": "threads"}],
            "last_hot_task_id": "hot-task-1",
            "last_hot_persona_id": "persona-a",
        })
        message = _Message()
        rewrite = callback_token(101, "hotrewrite", {
            "index": 0, "task_id": "hot-task-1", "persona_id": "persona-a",
        })
        asyncio.run(controller.handle_callback(_Query(rewrite, message), _Types))
        self.assertEqual(load_state(101)["mode"], "hot_rewrite")
        rewritten_message = _Message(text="/auto")
        asyncio.run(controller.handle_text(rewritten_message, _Types))
        state = load_state(101)
        self.assertEqual(state["mode"], "hot_select")
        self.assertEqual(state["payload"]["hot_candidates"][0]["content"], "改写后的生活化热点正文，保留核心事实。")
        rewrite_payload = next(payload for action, payload in calls if action == "hot.rewrite")
        self.assertTrue(rewrite_payload["idempotency_key"].startswith("tg:hot-rewrite:101:"))
        save = next(
            button
            for row in rewritten_message.answers[-1][1]["reply_markup"].inline_keyboard
            for button in row
            if str(button.text).startswith("保存")
        )
        asyncio.run(controller.handle_callback(_Query(save.callback_data, message), _Types))
        imported = [payload for action, payload in calls if action == "hot.import"]
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]["candidates"][0]["content"], "改写后的生活化热点正文，保留核心事实。")

    def test_persona_ai_and_copy_creation_are_reachable_from_telegram(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "personas.ai_create":
                return {"profile": {"id": "persona-ai", "name": "AI 人设"}}
            if action == "personas.copy_analyze":
                return {
                    "source": {"platform": "threads", "url": "https://www.threads.net/@public"},
                    "profile": {"name": "复制人设", "content": "复制后的简介", "setup": {"personaGender": "female"}},
                }
            if action == "personas.create":
                return {"id": "persona-copy", "name": payload["name"]}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:persona_ai_new", message), _Types))
        asyncio.run(controller.handle_text(_Message(text="AI观察员｜关注科技趋势并保持克制专业"), _Types))
        self.assertEqual(load_state(101)["selected_persona_id"], "persona-ai")
        self.assertTrue(any(action == "personas.ai_create" for action, _payload in calls))

        asyncio.run(controller.handle_callback(_Query("tt:persona_copy_new", message), _Types))
        asyncio.run(controller.handle_text(_Message(text="复制观察员｜https://www.threads.net/@public"), _Types))
        self.assertEqual(load_state(101)["mode"], "persona_copy_confirm")
        asyncio.run(controller.handle_callback(_Query("tt:persona_copy_confirm", message), _Types))
        created = [payload for action, payload in calls if action == "personas.create"]
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["copy_source"]["platform"], "threads")
        self.assertEqual(created[0]["setup"]["personaGender"], "female")

    def test_persona_ai_keyword_selection_matches_web_limits_and_creates(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "personas.ai_keywords":
                return {
                    "ok": True,
                    "keywords": ["长期方向一", "长期方向二", "长期方向三", "长期方向四", "长期方向五"],
                    "hot_keywords": ["热门方向一", "热门方向二", "热门方向三", "热门方向四", "热门方向五"],
                    "hot_keyword_source": {"available": True, "candidate_count": 12},
                }
            if action == "personas.ai_create":
                return {"profile": {"id": "persona-keyword", "name": payload["name"]}}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:persona_ai_new", message), _Types))
        keyword_message = _Message(text="生活观察员｜记录日常生活和城市见闻")
        asyncio.run(controller.handle_text(keyword_message, _Types))
        self.assertEqual(load_state(101)["mode"], "persona_ai_keyword_select")
        regular = next(
            button for row in keyword_message.answers[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(button.text).endswith("长期方向一")
        )
        hot = next(
            button for row in keyword_message.answers[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(button.text).endswith("热门方向一")
        )
        asyncio.run(controller.handle_callback(_Query(regular.callback_data, keyword_message), _Types))
        asyncio.run(controller.handle_callback(_Query(hot.callback_data, keyword_message), _Types))
        confirm = next(
            button for row in keyword_message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(button.text).startswith("确认生成人设")
        )
        asyncio.run(controller.handle_callback(_Query(confirm.callback_data, keyword_message), _Types))
        created = [payload for action, payload in calls if action == "personas.ai_create"]
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["selected_regular_keywords"], ["长期方向一"])
        self.assertEqual(created[0]["selected_hot_keywords"], ["热门方向一"])
        self.assertEqual(load_state(101)["selected_persona_id"], "persona-keyword")

    def test_watchers_stop_when_member_is_disabled_or_rebound(self):
        calls = []

        def dispatch(_user_id, action, _payload):
            calls.append(action)
            return {"status": "success"}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda _chat_id: None,
        )
        bot = SimpleNamespace(send_message=mock.AsyncMock())
        with mock.patch("webapp.telegram_tweet_bot.asyncio.sleep", new=mock.AsyncMock()):
            asyncio.run(controller._watch_generation(bot, 101, self.alice_id, "persona-a", "task-a", _Types))
            asyncio.run(controller._watch_publish(bot, 101, self.alice_id, "task-b", _Types))
            asyncio.run(controller._watch_hot(bot, 101, self.alice_id, "persona-a", "task-c", _Types))
        self.assertEqual(calls, [])
        bot.send_message.assert_not_awaited()

    def test_matrix_failure_is_not_reported_as_success(self):
        def dispatch(_user_id, action, _payload):
            if action == "publish.matrix":
                return {"ok": False, "errors": [{"message": "未绑定账号"}]}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        token = callback_token(101, "matrixok", {"persona_ids": ["persona-a"]})
        asyncio.run(controller.handle_callback(_Query(token, message), _Types))
        self.assertIn("未入队", message.edits[-1][0])
        self.assertIn("未绑定账号", message.edits[-1][0])

    def test_matrix_all_skipped_is_not_reported_as_enqueued(self):
        def dispatch(_user_id, action, _payload):
            if action == "publish.matrix":
                return {"ok": True, "created": [], "skipped": [{"reason": "没有可发布内容"}]}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        token = callback_token(101, "matrixok", {
            "persona_ids": ["persona-a"], "source": "posts", "platform": "threads",
        })
        asyncio.run(controller.handle_callback(_Query(token, message), _Types))
        self.assertIn("未入队", message.edits[-1][0])
        self.assertIn("没有可发布内容", message.edits[-1][0])

    def test_matrix_publish_selects_personas_before_confirmation(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "personas.list":
                return [
                    {"id": "persona-a", "name": "A", "counts": {"posts": 2}},
                    {"id": "persona-b", "name": "B", "counts": {"posts": 1}},
                ]
            if action == "accounts.list":
                return [{"id": "account-a", "persona_id": "persona-a", "platform": "threads"}]
            if action == "publish.matrix":
                return {"ok": True, "batch_id": "batch-1", "created": [{}]}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:matrix", message), _Types))
        self.assertEqual(load_state(101)["mode"], "matrix_select")
        self.assertFalse(any(action == "publish.matrix" for action, _payload in calls))
        first_persona = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        asyncio.run(controller.handle_callback(_Query(first_persona, message), _Types))
        self.assertEqual(load_state(101)["payload"]["matrix_persona_ids"], ["persona-a"])
        asyncio.run(controller.handle_callback(_Query("tt:matrixnext", message), _Types))
        self.assertEqual(load_state(101)["mode"], "matrix_source")
        self.assertIn("第 2/4 步", message.edits[-1][0])
        asyncio.run(controller.handle_callback(_Query("tt:mxsource:posts", message), _Types))
        self.assertEqual(load_state(101)["mode"], "matrix_platform")
        self.assertIn("第 3/4 步", message.edits[-1][0])
        asyncio.run(controller.handle_callback(_Query("tt:mxplatform:threads", message), _Types))
        self.assertEqual(load_state(101)["mode"], "matrix_confirm")
        self.assertIn("第 4/4 步", message.edits[-1][0])
        confirm = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        asyncio.run(controller.handle_callback(_Query(confirm, message), _Types))
        published = [payload for action, payload in calls if action == "publish.matrix"]
        self.assertEqual(published, [{
            "persona_ids": ["persona-a"],
            "source": "posts",
            "platform": "threads",
            "per_persona_count": 1,
        }])

    def test_scheduled_publish_requires_final_confirmation_and_keeps_platform(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "publish.start":
                return {"task": {"id": "scheduled-1"}}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        future = time.time() + 600
        schedule_text = time.strftime("%Y-%m-%d %H:%M", time.localtime(future))
        save_state(101, selected_persona_id="persona-a", mode="schedule_time", payload={
            "persona_id": "persona-a",
            "source": "posts",
            "post_id": "post-a",
            "account_id": "account-a",
            "platform": "instagram",
        })
        message = _Message(text=schedule_text)
        asyncio.run(controller.handle_text(message, _Types))
        self.assertEqual(load_state(101)["mode"], "schedule_confirm")
        self.assertFalse(any(action == "publish.start" for action, _payload in calls))
        self.assertIn("最终确认", message.answers[-1][0])
        confirm = message.answers[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(confirm, message), _Types))
        published = [payload for action, payload in calls if action == "publish.start"]
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["persona_id"], "persona-a")
        self.assertEqual(published[0]["platform"], "instagram")
        self.assertGreater(int(published[0]["scheduled_at"]), int(time.time()))

    def test_publish_callbacks_keep_original_persona_and_instagram_account(self):
        calls = []

        def dispatch(_user_id, action, payload):
            calls.append((action, payload))
            if action == "accounts.list":
                return [{
                    "id": "instagram-a",
                    "persona_id": "persona-a",
                    "platform": "instagram",
                    "username": "ig-a",
                }]
            if action == "publish.start":
                return {"task": {"id": "publish-a"}}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a")
        message = _Message()
        open_publish = callback_token(101, "pub", {
            "persona_id": "persona-a", "source": "posts", "post_id": "post-a",
        })
        asyncio.run(controller.handle_callback(_Query(open_publish, message), _Types))
        account_button = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0]
        self.assertIn("Instagram", account_button.text)
        save_state(101, selected_persona_id="persona-b")
        asyncio.run(controller.handle_callback(_Query(account_button.callback_data, message), _Types))
        confirm = message.edits[-1][1]["reply_markup"].inline_keyboard[0][0].callback_data
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_callback(_Query(confirm, message), _Types))
        published = [payload for action, payload in calls if action == "publish.start"]
        self.assertEqual(published[0]["persona_id"], "persona-a")
        self.assertEqual(published[0]["platform"], "instagram")

    def test_generation_completion_previews_only_current_task_output(self):
        calls = []

        def dispatch(_user_id, action, _payload):
            calls.append(action)
            if action == "generation.status":
                return {
                    "status": "success",
                    "output": {
                        "post_ids": ["new-1"],
                        "posts": [{"id": "new-1", "content": "本次生成的内容"}],
                    },
                }
            if action == "posts.list":
                return [{"id": "old-1", "content": "旧草稿不应出现"}]
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        bot = SimpleNamespace(send_message=mock.AsyncMock())
        with mock.patch("webapp.telegram_tweet_bot.asyncio.sleep", new=mock.AsyncMock()):
            asyncio.run(controller._watch_generation(bot, 101, self.alice_id, "persona-a", "task-a", _Types))
        rendered = bot.send_message.await_args.args[1]
        self.assertIn("本次生成的内容", rendered)
        self.assertNotIn("旧草稿不应出现", rendered)
        self.assertNotIn("posts.list", calls)
        callback = bot.send_message.await_args.kwargs["reply_markup"].inline_keyboard[0][0].callback_data
        self.assertTrue(callback.startswith("tt:gendrafts:"))

    def test_task_submenu_filters_before_opening_task_detail(self):
        def dispatch(_user_id, action, _payload):
            if action == "tasks.list":
                return [
                    {"id": "running-1", "type": "publish", "status": "running", "_tg_task_kind": "social"},
                    {"id": "failed-1", "type": "publish", "status": "failed", "_tg_task_kind": "social"},
                    {"id": "done-1", "type": "publish", "status": "success", "_tg_task_kind": "social"},
                ]
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:tasks:0:failed", message), _Types))
        self.assertIn("失败任务（1 条）", message.edits[-1][0])
        task_buttons = [
            button for row in message.edits[-1][1]["reply_markup"].inline_keyboard
            for button in row if str(getattr(button, "callback_data", "")).startswith("tt:t:")
        ]
        self.assertEqual(len(task_buttons), 1)

    def test_task_submenu_routes_manual_terminal_filters(self):
        def dispatch(_user_id, action, _payload):
            if action == "tasks.list":
                return [
                    {"id": "manual-1", "status": "need_manual", "task_type": "publish_post"},
                    {"id": "paused-1", "status": "paused", "task_type": "publish_post"},
                    {"id": "done-1", "status": "done", "task_type": "publish_post"},
                    {"id": "cancelled-1", "status": "cancelled", "task_type": "publish_post"},
                ]
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        for callback, expected in (
            ("tt:tasks:0:manual", "待人工/暂停任务（2 条）"),
            ("tt:tasks:0:paused", "已暂停任务（1 条）"),
            ("tt:tasks:0:completed", "已完成任务（1 条）"),
            ("tt:tasks:0:cancelled", "已取消任务（1 条）"),
        ):
            asyncio.run(controller.handle_callback(_Query(callback, message), _Types))
            self.assertIn(expected, message.edits[-1][0])

    def test_generation_failure_offers_regenerate_not_unsupported_retry(self):
        def dispatch(_user_id, action, _payload):
            if action == "tasks.get":
                return {"id": "gen-1", "type": "persona_post_generation", "status": "failed", "_tg_task_kind": "normal"}
            return []

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        token = callback_token(101, "t", {"task_id": "gen-1", "task_kind": "normal"})
        asyncio.run(controller.handle_callback(_Query(token, message), _Types))
        callbacks = [button.callback_data for row in message.edits[-1][1]["reply_markup"].inline_keyboard for button in row]
        self.assertIn("tt:generate", callbacks)
        self.assertFalse(any(value.startswith("tt:tretry:") for value in callbacks))

    def test_content_settings_are_available_without_a_second_switch(self):
        def dispatch(_user_id, action, _payload):
            if action == "profile.get":
                return {"content": "简介", "tweet_style_sample": "风格"}
            return {}

        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=dispatch, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        save_state(101, selected_persona_id="persona-a")
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:profile", message), _Types))
        self.assertIn("简介", message.edits[-1][0])
        asyncio.run(controller.handle_callback(_Query("tt:bio", message), _Types))
        self.assertEqual(load_state(101)["mode"], "profile_content")

    def test_help_keeps_account_prerequisites_inside_telegram(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(dispatch=lambda _uid, _action, _payload: {}, dispatch_async=_unused_async_dispatch),
            get_runtime=self._get,
            load_member=lambda chat_id: {"chat_id": chat_id, "web_user_id": self.alice_id},
        )
        message = _Message()
        asyncio.run(controller.handle_callback(_Query("tt:help", message), _Types))
        self.assertIn("绑定", message.edits[-1][0])
        self.assertIn("Threads 或 Instagram 账号", message.edits[-1][0])
        self.assertIn("不接收账号密码", message.edits[-1][0])

    def test_slow_poller_shutdown_is_restarted_after_exit(self):
        class _OldThread:
            def __init__(self):
                self.alive = True
                self.joins = []

            def is_alive(self):
                return self.alive

            def join(self, timeout=None):
                self.joins.append(timeout)
                if timeout is None:
                    self.alive = False

        class _ImmediateThread:
            def __init__(self, *, target, args, **_kwargs):
                self.target = target
                self.args = args
                self.alive = False

            def start(self):
                self.alive = True
                self.target(*self.args)
                self.alive = False

            def is_alive(self):
                return self.alive

        old_thread = _OldThread()
        tweet_tg._BOT_THREAD = old_thread
        tweet_tg._BOT_RELOAD_THREAD = None
        with mock.patch.object(tweet_tg.threading, "Thread", _ImmediateThread):
            tweet_tg.reload_tweet_telegram_bot_worker(self._get)
        self.assertEqual(old_thread.joins, [15, None])
        self.assertIsNone(tweet_tg._BOT_THREAD)
        self.assertIsNone(tweet_tg._BOT_RELOAD_THREAD)

    def test_server_adapter_filters_normal_tasks_to_tweet_generation(self):
        server_source = (Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8")
        self.assertIn("WHERE user_id = ? AND type = 'persona_post_generation'", server_source)
        self.assertIn("AND type = 'persona_post_generation'", server_source)


if __name__ == "__main__":
    unittest.main()
