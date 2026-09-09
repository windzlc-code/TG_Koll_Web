import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import telegram_admin, telegram_tweet_admin as tweet_tg
from webapp.db import db, init_db


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
            "telegram_tweet_content_settings_enabled": False,
        }

    def tearDown(self):
        if self.old_db is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db
        self.tmpdir.cleanup()

    def _get(self):
        return dict(self.runtime)

    def _save(self, updates):
        self.runtime.update(updates)

    def _member(self, chat_id, web_user):
        tweet_tg.upsert_tweet_member(
            tweet_tg.TweetTgMemberPayload(chat_id=chat_id, web_user=web_user, label="test"),
            self._get,
        )

    def _signed_init_data(self, chat_id):
        values = {
            "auth_date": str(int(time.time())),
            "query_id": "AAE-test-query",
            "user": json.dumps({"id": int(chat_id), "first_name": "Tester"}, separators=(",", ":")),
        }
        data_check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
        secret = hmac.new(b"WebAppData", self.runtime["telegram_tweet_bot_token"].encode(), hashlib.sha256).digest()
        values["hash"] = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
        return urlencode(values)

    def test_members_are_bound_to_distinct_web_users(self):
        self._member(101, "tweet_alice")
        self._member(202, self.bob_id)
        rows = {row["chat_id"]: row for row in tweet_tg._list_members()}
        self.assertEqual(rows[101]["web_user_id"], self.alice_id)
        self.assertEqual(rows[101]["web_username"], "tweet_alice")
        self.assertEqual(rows[202]["web_user_id"], self.bob_id)
        alice_url = tweet_tg._create_ticket(101, "personas", self._get)
        bob_url = tweet_tg._create_ticket(202, "publishing", self._get)
        alice_token = alice_url.split("ticket=", 1)[1]
        bob_token = bob_url.split("ticket=", 1)[1]
        self.assertEqual(tweet_tg._consume_ticket(alice_token, self._get), (self.alice_id, "/console.html?view=workspace&module=personas"))
        self.assertEqual(tweet_tg._consume_ticket(bob_token, self._get), (self.bob_id, "/console.html?view=workspace&module=publishing"))

    def test_ticket_is_one_time_and_member_disable_revokes_unused_ticket(self):
        self._member(101, "tweet_alice")
        token = tweet_tg._create_ticket(101, "tasks", self._get).split("ticket=", 1)[1]
        tweet_tg._consume_ticket(token, self._get)
        with self.assertRaisesRegex(Exception, "已失效"):
            tweet_tg._consume_ticket(token, self._get)

        unused = tweet_tg._create_ticket(101, "accounts", self._get).split("ticket=", 1)[1]
        with db() as conn:
            conn.execute("UPDATE telegram_tweet_members SET enabled = 0 WHERE chat_id = 101")
        with self.assertRaisesRegex(Exception, "停用"):
            tweet_tg._consume_ticket(unused, self._get)

    def test_content_settings_requires_feature_flag_at_issue_and_consume(self):
        self._member(101, "tweet_alice")
        with self.assertRaisesRegex(RuntimeError, "尚未开放"):
            tweet_tg._create_ticket(101, "content_settings", self._get)
        self.runtime["telegram_tweet_content_settings_enabled"] = True
        token = tweet_tg._create_ticket(101, "content_settings", self._get).split("ticket=", 1)[1]
        self.runtime["telegram_tweet_content_settings_enabled"] = False
        with self.assertRaisesRegex(Exception, "尚未开放"):
            tweet_tg._consume_ticket(token, self._get)

    def test_tweet_config_does_not_mutate_video_bot_config(self):
        with mock.patch.object(tweet_tg, "verify_bot_token", return_value={"username": "tweet_bot", "id": 10}), \
             mock.patch.object(tweet_tg, "reload_tweet_telegram_bot_worker"):
            result = tweet_tg.save_tweet_tg_env(
                tweet_tg.TweetTgEnvPayload(
                    bot_token="123456:tweet-token",
                    bot_enabled=True,
                    public_base_url="https://console.example.test/",
                    content_settings_enabled=True,
                ),
                self._get,
                self._save,
            )
        self.assertEqual(self.runtime["telegram_bot_token"], "video-token-must-not-change")
        self.assertTrue(self.runtime["telegram_bot_enabled"])
        self.assertEqual(self.runtime["telegram_tweet_bot_token"], "123456:tweet-token")
        self.assertTrue(result["tg_settings"]["content_settings_enabled"])

    def test_rejects_group_chat_ids_and_video_bot_token_reuse(self):
        with self.assertRaisesRegex(Exception, "私聊"):
            self._member(-100123456, "tweet_alice")
        with mock.patch.object(tweet_tg, "verify_bot_token", return_value={"username": "same_bot", "id": 10}), \
             mock.patch.object(tweet_tg, "reload_tweet_telegram_bot_worker"):
            with self.assertRaisesRegex(Exception, "不能与视频工作台共用"):
                tweet_tg.save_tweet_tg_env(
                    tweet_tg.TweetTgEnvPayload(bot_token="video-token-must-not-change", bot_enabled=True),
                    self._get,
                    self._save,
                )
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        with mock.patch.object(telegram_admin, "verify_bot_token", return_value={"username": "same_bot", "id": 10}), \
             mock.patch.object(telegram_admin, "reload_telegram_bot_worker"):
            with self.assertRaisesRegex(Exception, "不能与推文 Bot 共用"):
                telegram_admin.save_tg_env(
                    telegram_admin.TgEnvPayload(bot_token="123456:tweet-token", bot_enabled=True),
                    self._get,
                    self._save,
                )

    def test_public_entry_sets_short_user_session_and_redirects(self):
        self._member(101, "tweet_alice")
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        self.runtime["telegram_tweet_bot_enabled"] = True
        app = FastAPI()
        with mock.patch.object(tweet_tg, "start_tweet_telegram_bot_worker"):
            tweet_tg.inject_tweet_telegram_admin(
                app,
                require_admin=lambda: {"id": 1, "is_admin": 1},
                get_runtime=self._get,
                save_runtime=self._save,
                session_cookie_secure=lambda _request: False,
            )
        token = tweet_tg._create_ticket(101, "home", self._get).split("ticket=", 1)[1]
        with TestClient(app) as client:
            landing = client.get(f"/telegram/tweet/open?ticket={token}")
            self.assertEqual(landing.status_code, 200)
            self.assertIn("telegram-web-app.js", landing.text)
            self.assertNotIn("session_token=", landing.headers.get("set-cookie", ""))
            response = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": token, "init_data": self._signed_init_data(101)},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["target"], "/console.html?view=persona_dashboard")
            self.assertIn("session_token=", response.headers.get("set-cookie", ""))
            with db() as conn:
                session = conn.execute("SELECT token, user_id, expires_at, created_at, revoked_at FROM sessions ORDER BY created_at DESC LIMIT 1").fetchone()
            self.assertEqual(int(session["user_id"]), self.alice_id)
            self.assertLessEqual(int(session["expires_at"]) - int(session["created_at"]), tweet_tg.SESSION_TTL_SECONDS)
            tweet_tg._create_ticket(101, "tasks", self._get)
            blocked = client.patch("/api/persona_dashboard/personas/example/profile", json={})
            self.assertEqual(blocked.status_code, 403)
            self.assertEqual(blocked.json()["code"], "tg_tweet_content_settings_disabled")
            toggled = client.post("/api/admin/tg_tweet/members/101/toggle", json={"enabled": False})
            self.assertEqual(toggled.status_code, 200, toggled.text)
        with db() as conn:
            revoked = conn.execute("SELECT revoked_at FROM sessions WHERE token = ?", (session["token"],)).fetchone()
        self.assertGreater(int(revoked["revoked_at"]), 0)

    def test_exchange_rejects_different_telegram_user(self):
        self._member(101, "tweet_alice")
        self.runtime["telegram_tweet_bot_token"] = "123456:tweet-token"
        self.runtime["telegram_tweet_bot_enabled"] = True
        app = FastAPI()
        with mock.patch.object(tweet_tg, "start_tweet_telegram_bot_worker"):
            tweet_tg.inject_tweet_telegram_admin(
                app,
                require_admin=lambda: {"id": 1, "is_admin": 1},
                get_runtime=self._get,
                save_runtime=self._save,
                session_cookie_secure=lambda _request: False,
            )
        token = tweet_tg._create_ticket(101, "home", self._get).split("ticket=", 1)[1]
        with TestClient(app) as client:
            response = client.post(
                "/telegram/tweet/exchange",
                json={"ticket": token, "init_data": self._signed_init_data(202)},
            )
            self.assertEqual(response.status_code, 403)
        with db() as conn:
            ticket = conn.execute("SELECT used_at FROM telegram_tweet_tickets").fetchone()
        self.assertEqual(float(ticket["used_at"]), 0)

    def test_admin_and_console_frontend_contracts(self):
        static = Path(__file__).resolve().parents[1] / "static"
        html = (static / "admin.html").read_text(encoding="utf-8")
        admin_js = (static / "assets" / "admin.js").read_text(encoding="utf-8")
        console_js = (static / "assets" / "console.js").read_text(encoding="utf-8")
        console_panel = html[html.index('data-tg-workbench-panel="console"'):html.index('data-tg-workbench-panel="crm"')]
        self.assertIn('id="tgTweetContentSettingsEnabled"', console_panel)
        self.assertIn('id="btnClearTgTweetToken"', console_panel)
        self.assertIn('id="tgTweetWebUser"', console_panel)
        self.assertIn('id="tgTweetMemberList"', console_panel)
        self.assertIn('/api/admin/tg_tweet/settings', admin_js)
        self.assertIn('/api/admin/tg_tweet/members', admin_js)
        self.assertIn('callback_data="tw:personas"', (Path(__file__).resolve().parents[1] / "telegram_tweet_admin.py").read_text(encoding="utf-8"))
        self.assertIn('initialConsoleParams.get("module")', console_js)
        self.assertIn('url.searchParams.delete("module")', console_js)


if __name__ == "__main__":
    unittest.main()
