import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


if __name__ == "__main__":
    unittest.main()
