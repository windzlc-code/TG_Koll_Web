import os
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest import mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from webapp import telegram_admin
from webapp.db import init_db
from webapp.telegram_admin import TgEnvPayload, TgTrustedUserPayload


class TelegramAdminTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("APP_DB_PATH")
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        init_db()
        self.runtime = {
            "telegram_bot_token": "",
            "telegram_allowed_chat_ids": "",
            "telegram_bot_enabled": False,
            "telegram_video_entry_url": "/video.html",
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

    def test_trusted_user_roundtrip(self):
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=6258005891, label="客户A"))
        rows = telegram_admin._list_members()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["label"], "客户A")
        self.assertEqual(rows[0]["tg_username"], "")
        self.assertEqual(rows[0]["tg_display_name"], "")
        telegram_admin.toggle_trusted_user(6258005891, False)
        self.assertFalse(telegram_admin._list_members()[0]["enabled"])
        telegram_admin.delete_trusted_user(6258005891)
        self.assertEqual(telegram_admin._list_members(), [])

    def test_upsert_fetches_telegram_user_name(self):
        self.runtime["telegram_bot_token"] = "123456:ABCDEF-token"
        with mock.patch.object(
            telegram_admin,
            "fetch_telegram_chat_profile",
            return_value={"username": "daodi", "display_name": "到底"},
        ) as fetch:
            telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=6258005891, label=""), self._get)
            fetch.assert_called_once_with("123456:ABCDEF-token", 6258005891)
        row = telegram_admin._list_members()[0]
        self.assertEqual(row["tg_username"], "daodi")
        self.assertEqual(row["tg_display_name"], "到底")
        self.assertEqual(row["label"], "到底")

    def test_upsert_resolves_public_username(self):
        self.runtime["telegram_bot_token"] = "123456:ABCDEF-token"
        with mock.patch.object(
            telegram_admin,
            "fetch_telegram_chat_profile",
            return_value={"chat_id": 6258005891, "username": "daodi", "display_name": "到底"},
        ):
            telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id="@daodi", label=""), self._get)
        row = telegram_admin._list_members()[0]
        self.assertEqual(row["chat_id"], 6258005891)
        self.assertEqual(row["tg_username"], "daodi")
        self.assertEqual(row["tg_display_name"], "到底")
        self.assertEqual(row["label"], "到底")

    def test_remember_trusted_user_profile_updates_existing(self):
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=6258005891, label="客户A"))
        telegram_admin.remember_trusted_user_profile(6258005891, username="daodi", display_name="到底")
        row = telegram_admin._list_members()[0]
        self.assertEqual(row["tg_username"], "daodi")
        self.assertEqual(row["tg_display_name"], "到底")
        self.assertEqual(row["label"], "客户A")

    def test_video_self_service_ticket_binds_and_logout_clears_session_link(self):
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=6258005891, label="客户A"))
        token = telegram_admin.create_video_link_ticket(6258005891)
        telegram_admin.consume_video_link_ticket(
            token,
            {"id": 6258005891, "username": "video_user", "display_name": "视频用户"},
            {"id": 42, "username": "vecto_user"},
            "session-digest",
        )
        row = telegram_admin._list_members()[0]
        self.assertEqual(row["chat_id"], 6258005891)
        self.assertEqual(row["web_user_id"], 42)
        self.assertTrue(row["enabled"])
        self.assertTrue(row["has_linked_session"])
        member = telegram_admin.load_video_member(6258005891)
        self.assertIsNotNone(member)
        self.assertEqual(int(member["web_user_id"]), 42)

        result = telegram_admin.logout_video_member(6258005891)
        self.assertTrue(result["ok"])
        self.assertTrue(result["bound"])
        row = telegram_admin._list_members()[0]
        self.assertEqual(row["web_user_id"], 42)
        self.assertFalse(row["has_linked_session"])
        member = telegram_admin.load_video_member(6258005891)
        self.assertIsNotNone(member)
        self.assertFalse(telegram_admin.video_member_has_active_web_session(member))

    def test_video_ticket_requires_matching_signed_telegram_identity(self):
        token = telegram_admin.create_video_link_ticket(731)
        values = {
            "auth_date": str(int(__import__("time").time())),
            "user": json.dumps({"id": 731, "username": "video_user"}, separators=(",", ":")),
        }
        check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
        secret = hmac.new(b"123456:video", b"WebAppData", hashlib.sha256).digest()
        values["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        init_data = urlencode(values)
        self.assertEqual(
            telegram_admin.validate_video_webapp_login_context(
                token,
                init_data,
                {"telegram_bot_enabled": True, "telegram_bot_token": "123456:video"},
            ),
            731,
        )

    def test_video_browser_ticket_rechecks_live_authorization(self):
        self.runtime.update({"telegram_bot_token": "123456:video", "telegram_bot_enabled": True})
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=731, label="视频用户"))
        token = telegram_admin.create_video_link_ticket(731)
        self.assertEqual(
            telegram_admin.validate_video_browser_login_context(token, self.runtime),
            731,
        )
        telegram_admin.toggle_trusted_user(731, False)
        with self.assertRaises(HTTPException) as raised:
            telegram_admin.validate_video_browser_login_context(token, self.runtime)
        self.assertEqual(getattr(raised.exception, "status_code", None), 403)
        self.assertEqual(getattr(raised.exception, "detail", {}).get("code"), "telegram_binding_not_authorized")

    def test_video_webapp_url_and_landing_page_are_video_scoped(self):
        self.runtime.update({"telegram_bot_token": "123456:video", "telegram_bot_enabled": True})
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=731, label="视频用户"))
        with mock.patch.dict(os.environ, {"PUBLIC_BASE_URL": "https://example.test"}, clear=False):
            url = telegram_admin.create_video_webapp_url(731, self._get)
        self.assertTrue(url.startswith("https://example.test/telegram/video/open?ticket="))
        token = url.split("ticket=", 1)[1]

        app = FastAPI()
        with mock.patch.object(telegram_admin, "start_telegram_bot_worker"):
            telegram_admin.inject_telegram_admin(
                app,
                require_admin=lambda: {"is_admin": 1},
                get_runtime=self._get,
                save_runtime=self._save,
            )
        response = TestClient(app).get("/telegram/video/open", params={"ticket": token})
        self.assertEqual(response.status_code, 200)
        self.assertIn("/telegram/video/exchange", response.text)
        self.assertIn("telegram-video-login-context", response.text)
        self.assertIn("video-login.html", response.text)
        self.assertIn("browser", response.text)
        self.assertNotIn("telegram/tweet/open", response.text)

    def test_video_webapp_ticket_requires_live_admin_authorization(self):
        self.runtime.update({"telegram_bot_token": "123456:video", "telegram_bot_enabled": True})
        with mock.patch.dict(os.environ, {"PUBLIC_BASE_URL": "https://example.test"}, clear=False):
            with self.assertRaises(RuntimeError):
                telegram_admin.create_video_webapp_url(731, self._get)
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=731, label="视频用户"))
        self.assertTrue(telegram_admin.is_video_chat_authorized(731, self.runtime))
        telegram_admin.toggle_trusted_user(731, False)
        self.assertFalse(telegram_admin.is_video_chat_authorized(731, self.runtime))

    def test_video_ticket_cannot_bind_chat_id_removed_from_admin_list(self):
        token = telegram_admin.create_video_link_ticket(731)
        with self.assertRaises(HTTPException) as raised:
            telegram_admin.consume_video_link_ticket(
                token,
                {"id": 731, "username": "video_user"},
                {"id": 42, "username": "vecto_user"},
                "session-digest",
            )
        self.assertEqual(getattr(raised.exception, "status_code", None), 403)
        detail = getattr(raised.exception, "detail", {})
        self.assertEqual(detail.get("code"), "telegram_binding_not_authorized")

    def test_video_webapp_exchange_requires_normal_web_session(self):
        self.runtime.update({"telegram_bot_token": "123456:video", "telegram_bot_enabled": True})
        token = telegram_admin.create_video_link_ticket(731)
        app = FastAPI()
        with mock.patch.object(telegram_admin, "start_telegram_bot_worker"):
            telegram_admin.inject_telegram_admin(
                app,
                require_admin=lambda: {"is_admin": 1},
                get_runtime=self._get,
                save_runtime=self._save,
            )
        response = TestClient(app).post(
            "/telegram/video/exchange",
            json={"ticket": token, "init_data": "not-used-before-session-check"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json().get("detail", {}).get("code"), "web_login_required")

    def test_video_browser_exchange_accepts_external_url_context_after_web_login(self):
        self.runtime.update({"telegram_bot_token": "123456:video", "telegram_bot_enabled": True})
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=731, label="视频用户"))
        token = telegram_admin.create_video_link_ticket(731)
        app = FastAPI()
        with mock.patch.object(telegram_admin, "start_telegram_bot_worker"):
            telegram_admin.inject_telegram_admin(
                app,
                require_admin=lambda: {"is_admin": 1},
                get_runtime=self._get,
                save_runtime=self._save,
            )
        with mock.patch.object(
            telegram_admin,
            "_authenticated_video_web_session",
            return_value=({"id": 42, "username": "vecto_user", "is_admin": 0}, "session-digest"),
        ), mock.patch.object(telegram_admin, "consume_video_link_ticket") as consume:
            response = TestClient(app).post(
                "/telegram/video/exchange",
                json={"ticket": token, "browser": True},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("target"), "/video.html")
        self.assertEqual(consume.call_args.args[0], token)
        self.assertEqual(consume.call_args.args[1]["id"], 731)

    def test_load_settings_backfills_missing_user_name(self):
        telegram_admin.upsert_trusted_user(TgTrustedUserPayload(chat_id=6258005891, label="客户A"))
        self.runtime["telegram_bot_token"] = "123456:ABCDEF-token"
        with mock.patch.object(
            telegram_admin,
            "fetch_telegram_chat_profile",
            return_value={"username": "daodi", "display_name": "到底"},
        ):
            settings = telegram_admin.load_tg_settings(self._get)
        row = settings["trusted_users"][0]
        self.assertEqual(row["tg_username"], "daodi")
        self.assertEqual(row["tg_display_name"], "到底")

    def test_save_env_verifies_token_and_masks_settings(self):
        with mock.patch.object(telegram_admin, "verify_bot_token", return_value={"username": "vecto_video_bot", "id": 1}):
            with mock.patch.object(telegram_admin, "reload_telegram_bot_worker"):
                result = telegram_admin.save_tg_env(
                    TgEnvPayload(bot_token="123456:ABCDEF-token", allowed_chat_ids="11,22", bot_enabled=True),
                    self._get,
                    self._save,
                )
        settings = result["tg_settings"]
        self.assertTrue(settings["bot_token_configured"])
        self.assertNotIn("123456:ABCDEF-token", settings["bot_token_masked"])
        self.assertEqual(settings["bot_token_length"], len("123456:ABCDEF-token"))
        self.assertEqual(settings["allowed_chat_ids_env"], [11, 22])
        self.assertEqual(self.runtime["telegram_bot_token"], "123456:ABCDEF-token")

    def test_empty_token_clears_existing_token_and_stops_polling(self):
        self.runtime["telegram_bot_token"] = "123456:ABCDEF-token"
        self.runtime["telegram_bot_enabled"] = True
        with mock.patch.object(telegram_admin, "reload_telegram_bot_worker"):
            result = telegram_admin.save_tg_env(
                TgEnvPayload(bot_token="", bot_enabled=True),
                self._get,
                self._save,
            )
        self.assertEqual(self.runtime["telegram_bot_token"], "")
        self.assertFalse(self.runtime["telegram_bot_enabled"])
        self.assertFalse(result["tg_settings"]["bot_token_configured"])

    def test_admin_html_contains_telegram_block(self):
        html = (Path(__file__).resolve().parents[1] / "static" / "admin.html").read_text(encoding="utf-8")
        js = (Path(__file__).resolve().parents[1] / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        self.assertIn('data-page="telegram"', html)
        self.assertIn('data-page-view="telegram"', html)
        self.assertIn("Telegram Bot", html)
        self.assertIn("id=\"tgBotToken\"", html)
        self.assertIn("id=\"btnSaveTgEnv\"", html)
        self.assertIn('data-tg-workbench-tab="video"', html)
        self.assertIn('data-tg-workbench-tab="console"', html)
        self.assertIn('data-tg-workbench-tab="crm"', html)
        self.assertIn("/api/admin/tg_settings", js)
        self.assertIn("/api/admin/tg_env", js)
        self.assertIn('"tgBotToken"', js[js.index("SENSITIVE_RUNTIME_INPUT_IDS"):js.index("SENSITIVE_PROVIDER_INPUT_IDS")])
        self.assertIn('tgBotToken: "telegram_bot_token"', js)
        self.assertIn('setRuntimeSecretInputState("tgBotToken"', js)
        self.assertNotIn('el("tgBotToken").value = ""', js)
        self.assertIn("hydrateTgBotTokenField", js)
        self.assertIn("SENSITIVE_EYE_OFF_ICON_SVG", js)
        self.assertIn('button.className = "sensitive-toggle-btn"', js)
        self.assertNotIn('button.className = "ghost sensitive-toggle-btn"', js)
        render_fn = js[js.index("function tgStatusBadge"):js.index("async function loadTgSettings")]
        self.assertIn("tgStatusBadge", render_fn)
        self.assertIn("admin-user-badge-${tone}", render_fn)
        self.assertIn('enabled ? "enabled" : "disabled"', render_fn)
        self.assertIn('"pending"', render_fn)
        self.assertIn('"rejected"', render_fn)
        self.assertIn("tgMemberNameCell", render_fn)
        self.assertIn("tg_display_name", render_fn)
        self.assertIn("tg_username", render_fn)
        self.assertIn("未获取", render_fn)
        self.assertNotIn("忙时通知", render_fn)
        self.assertNotIn("空闲通知", render_fn)
        self.assertIn('colspan="6"', render_fn)
        self.assertIn('configured ? "已配置" : "未配置"', render_fn)
        self.assertIn("bot_token_length", render_fn)
        self.assertNotIn("video_entry_url:", js[js.index("async function saveTgEnv"):js.index("async function testTgEnv")])
        runtime = html[html.index("id=\"secRuntime\""):html.index("id=\"secTelegram\"")]
        self.assertNotIn("id=\"tgBotToken\"", runtime)
        video_panel = html[html.index('data-tg-workbench-panel="video"'):html.index('data-tg-workbench-panel="console"')]
        self.assertIn("id=\"tgBotToken\"", video_panel)
        self.assertNotIn("视频工作台入口", video_panel)
        self.assertNotIn("允许 Chat ID（逗号分隔）", video_panel)
        self.assertNotIn("id=\"tgVideoEntryUrl\"", video_panel)
        self.assertNotIn("id=\"tgAllowedChatIds\"", video_panel)
        self.assertIn("<table", video_panel)
        self.assertIn("<thead>", video_panel)
        self.assertIn("授权状态", video_panel)
        self.assertIn("用户名称", video_panel)
        self.assertNotIn("通知偏好", video_panel)
        self.assertIn("Chat ID 或 @用户名", video_panel)
        self.assertIn(">时间</th>", video_panel)
        self.assertIn("id=\"tgTrustedUserList\"", video_panel)
        self.assertIn("admin-tg-token-row", video_panel)
        self.assertIn("admin-tg-member-row", video_panel)
        self.assertIn("admin-tg-field", video_panel)
        self.assertIn("admin-tg-split", video_panel)
        self.assertIn("admin-tg-status-row", video_panel)
        self.assertIn("admin-tg-bot-pane", video_panel)
        self.assertIn("admin-tg-member-pane", video_panel)
        split = video_panel[video_panel.index("admin-tg-split"):video_panel.index("tgSettingsMsg")]
        self.assertLess(split.index("Telegram Bot"), split.index("允许成员"))

    def test_product_login_carries_video_telegram_context(self):
        js = (Path(__file__).resolve().parents[1] / "static" / "assets" / "product-login.js").read_text(encoding="utf-8")
        self.assertIn('flag: "telegram_video"', js)
        self.assertIn('vecto-telegram-video-login-context', js)
        self.assertIn('telegram_video_ticket', js)
        self.assertIn('telegram_video_init_data', js)
        self.assertIn('telegram_video_browser', js)


if __name__ == "__main__":
    unittest.main()
