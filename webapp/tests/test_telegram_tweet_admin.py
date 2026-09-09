import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from webapp import telegram_admin, telegram_tweet_admin as tweet_tg
from webapp.db import db, init_db
from webapp.telegram_tweet_bot import (
    NativeTweetBotController,
    TweetWorkbenchOps,
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


class _Types:
    InlineKeyboardButton = _Button
    InlineKeyboardMarkup = _Markup


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
            "telegram_tweet_bot_token": "123456:tweet-token",
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

    def test_disabled_worker_is_not_started_and_legacy_web_session_routes_are_gone(self):
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
        self.assertEqual(exchange.status_code, 410)
        self.assertNotIn("session_token=", landing.headers.get("set-cookie", ""))
        self.assertNotIn("session_token=", exchange.headers.get("set-cookie", ""))

    def test_admin_and_native_bot_frontend_contracts(self):
        webapp = Path(__file__).resolve().parents[1]
        html = (webapp / "static" / "admin.html").read_text(encoding="utf-8")
        admin_js = (webapp / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        console_js = (webapp / "static" / "assets" / "console.js").read_text(encoding="utf-8")
        bot_source = (webapp / "telegram_tweet_bot.py").read_text(encoding="utf-8")
        admin_source = (webapp / "telegram_tweet_admin.py").read_text(encoding="utf-8")
        console_panel = html[html.index('data-tg-workbench-panel="console"'):html.index('data-tg-workbench-panel="crm"')]
        self.assertNotIn('id="tgTweetContentSettingsEnabled"', console_panel)
        self.assertNotIn('id="tgTweetWebUser"', console_panel)
        self.assertIn('填写正数 Telegram Chat ID 即可授权', console_panel)
        self.assertIn('/api/admin/tg_tweet/settings', admin_js)
        self.assertIn('callback_data="tt:personas:0"', bot_source)
        self.assertIn('F.photo | F.video | F.document', bot_source)
        self.assertNotIn("WebAppInfo", bot_source)
        self.assertNotIn("create_session(", admin_source)
        self.assertNotIn('initialConsoleParams.get("module")', console_js)

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
        with mock.patch.object(asyncio, "create_task", side_effect=lambda coro: (coro.close(), None)[1]):
            asyncio.run(controller.handle_text(message, _Types))
        state = load_state(101)
        self.assertEqual(state["payload"]["last_hot_task_id"], "phc_test")
        buttons = message.answers[-1][1]["reply_markup"].inline_keyboard[0]
        self.assertTrue(buttons[0].callback_data.startswith("tt:hotstatus:"))
        self.assertTrue(buttons[1].callback_data.startswith("tt:hotcancel:"))

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
