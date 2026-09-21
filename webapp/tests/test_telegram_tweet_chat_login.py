import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from webapp.db import db, init_db
from webapp.telegram_tweet_bot import (
    CHAT_LOGIN_BACK_BUTTON,
    CHAT_LOGIN_CANCEL_BUTTON,
    NativeTweetBotController,
    TweetWorkbenchOps,
    load_state,
)


async def _unused_async_dispatch(_user_id, _action, _payload):
    return {}


class _Button:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _Markup:
    def __init__(self, *, inline_keyboard):
        self.inline_keyboard = inline_keyboard


class _ReplyMarkup:
    def __init__(self, *, keyboard, **kwargs):
        self.keyboard = keyboard
        self.__dict__.update(kwargs)


class _Types:
    InlineKeyboardButton = _Button
    InlineKeyboardMarkup = _Markup
    KeyboardButton = _Button
    ReplyKeyboardMarkup = _ReplyMarkup


class _Message:
    def __init__(self, chat_id=731, text="", message_id=1):
        self.chat = SimpleNamespace(id=chat_id, type="private")
        self.from_user = SimpleNamespace(
            id=chat_id, username="chat_user", first_name="Chat", last_name="User",
        )
        self.text = text
        self.message_id = message_id
        self.answers = []
        self.deleted = False

    async def answer(self, text, **kwargs):
        self.answers.append((text, kwargs))

    async def delete(self):
        self.deleted = True


class TelegramTweetChatLoginTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("APP_DB_PATH")
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        init_db()
        self.calls = []
        self.member = {}

    def tearDown(self):
        if self.old_db is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db
        self.tmpdir.cleanup()

    def _login(self, chat_id, username, password, profile, verification):
        self.calls.append((chat_id, username, password, profile, verification))
        self.member.update({"chat_id": chat_id, "web_user_id": 9})
        return {"ok": True, "username": username}

    def test_private_chat_login_uses_chat_messages_and_never_persists_password(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(
                dispatch=lambda _uid, _action, _payload: {},
                dispatch_async=_unused_async_dispatch,
            ),
            get_runtime=lambda: {},
            load_member=lambda _chat_id: self.member or None,
            has_active_web_session=lambda _member: True,
            chat_login=self._login,
        )
        start = _Message()
        asyncio.run(controller.send_web_login_link(start, _Types))
        self.assertIn("聊天内登录绑定", start.answers[-1][0])
        login_markup = start.answers[-1][1]["reply_markup"]
        self.assertIsInstance(login_markup, _ReplyMarkup)
        labels = {
            button.text
            for row in login_markup.keyboard
            for button in row
        }
        self.assertIn(CHAT_LOGIN_CANCEL_BUTTON, labels)
        self.assertIn(CHAT_LOGIN_BACK_BUTTON, labels)

        username = _Message(text="alice@example.com", message_id=2)
        asyncio.run(controller.handle_text(username, _Types))
        self.assertTrue(username.deleted)
        self.assertEqual(load_state(731)["mode"], "chat_login_password")

        password = _Message(text="secret-not-persisted", message_id=3)
        asyncio.run(controller.handle_text(password, _Types))
        self.assertTrue(password.deleted)
        self.assertEqual(self.calls[0][1:3], ("alice@example.com", "secret-not-persisted"))
        self.assertIsNone(load_state(731)["mode"] or None)
        with db() as conn:
            row = conn.execute(
                "SELECT payload_json FROM telegram_tweet_bot_states WHERE chat_id = ?",
                (731,),
            ).fetchone()
        self.assertNotIn("secret-not-persisted", str(row["payload_json"] if row else ""))

    def test_cancel_button_closes_login_and_restores_binding_action(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(
                dispatch=lambda _uid, _action, _payload: {},
                dispatch_async=_unused_async_dispatch,
            ),
            get_runtime=lambda: {},
            load_member=lambda _chat_id: None,
            chat_login=self._login,
        )
        start = _Message()
        asyncio.run(controller.send_web_login_link(start, _Types))
        cancel = _Message(text=CHAT_LOGIN_CANCEL_BUTTON, message_id=2)
        asyncio.run(controller.handle_text(cancel, _Types))

        self.assertEqual(load_state(731)["mode"], "")
        self.assertIn("已取消推文工作台登录", cancel.answers[-1][0])
        binding_markup = cancel.answers[-1][1]["reply_markup"]
        self.assertEqual(binding_markup.inline_keyboard[0][0].callback_data, "tt:chatlogin")

    def test_production_binding_action_stays_in_chat(self):
        controller = NativeTweetBotController(
            ops=TweetWorkbenchOps(
                dispatch=lambda _uid, _action, _payload: {},
                dispatch_async=_unused_async_dispatch,
            ),
            get_runtime=lambda: {},
            load_member=lambda _chat_id: None,
            chat_login=self._login,
            create_webapp_url=lambda _chat_id, _route="home": "https://example.test/legacy",
        )
        markup = controller._binding_markup(_Types, 731)
        button = markup.inline_keyboard[0][0]
        self.assertEqual(button.callback_data, "tt:chatlogin")
        self.assertFalse(hasattr(button, "web_app"))


if __name__ == "__main__":
    unittest.main()
