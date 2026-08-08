import base64
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from PIL import Image

import webapp.server as server
import webapp.social_automation_api as social_automation_api


class PersonaDashboardApiTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_webapp_data_dir = os.environ.get("WEBAPP_DATA_DIR")
        self._old_tool_runtime_dir = os.environ.get("TOOL_R18_RUNTIME_DIR")
        self._old_bootstrap_password = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD")
        self._old_cookie_secure = os.environ.get("SESSION_COOKIE_SECURE")
        self._old_password_vault_key = os.environ.get("PASSWORD_VAULT_KEY")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._old_server_tool_runtime_dir = server.TOOL_R18_RUNTIME_DIR
        self._old_server_upload_root = server.UPLOAD_ROOT
        self._old_social_tool_runtime_dir = social_automation_api._TOOL_R18_RUNTIME_DIR
        self._tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self._tmpdir.name)
        self.data_dir = self.root / "webapp_data"
        self.tool_runtime_dir = self.root / "tool_r18_runtime"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.tool_runtime_dir.mkdir(parents=True, exist_ok=True)
        (self.tool_runtime_dir / "admin").mkdir(parents=True, exist_ok=True)
        self.draft_media_path = self.tool_runtime_dir / "admin" / "draft_media.png"
        self.draft_media_path.write_bytes(
            bytes.fromhex("89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE0000000C49444154789C636060000000040001F61738550000000049454E44AE426082")
        )
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime_config.json")
        os.environ["TOOL_R18_RUNTIME_DIR"] = str(self.tool_runtime_dir)
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "admin123secure"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime_config.json"
        server.TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        server.UPLOAD_ROOT = self.tool_runtime_dir
        social_automation_api._TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        self.app = server.create_app()
        self.unauth_client = TestClient(self.app)
        self.client = TestClient(self.app)
        login_resp = self.client.post("/api/auth/admin-login", json={"username": "admin", "password": "admin123secure"})
        self.assertEqual(login_resp.status_code, 200)
        self.client.headers["X-Admin-Console"] = "1"

    def tearDown(self):
        self.unauth_client.close()
        self.client.close()
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        server.TOOL_R18_RUNTIME_DIR = self._old_server_tool_runtime_dir
        server.UPLOAD_ROOT = self._old_server_upload_root
        social_automation_api._TOOL_R18_RUNTIME_DIR = self._old_social_tool_runtime_dir
        self._restore_env("APP_DB_PATH", self._old_db_path)
        self._restore_env("APP_RUNTIME_CONFIG_PATH", self._old_runtime_config_path)
        self._restore_env("WEBAPP_DATA_DIR", self._old_webapp_data_dir)
        self._restore_env("TOOL_R18_RUNTIME_DIR", self._old_tool_runtime_dir)
        self._restore_env("ADMIN_BOOTSTRAP_PASSWORD", self._old_bootstrap_password)
        self._restore_env("SESSION_COOKIE_SECURE", self._old_cookie_secure)
        self._restore_env("PASSWORD_VAULT_KEY", self._old_password_vault_key)
        self._tmpdir.cleanup()

    def _restore_env(self, key, old_value):
        if old_value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = old_value

    def test_sentiment_profile_lookup_accepts_legacy_aliases(self):
        profiles = [
            {"key": "xiaohongshusearch", "platform": "xiaohongshusearch"},
            {"key": "facebooksearch", "platform": "facebooksearch"},
        ]

        self.assertEqual(server._find_sentiment_profile(profiles, "xiaohongshu")["key"], "xiaohongshusearch")
        self.assertEqual(server._find_sentiment_profile(profiles, "facebook")["key"], "facebooksearch")

    def test_threads_live_auth_prefers_browser_probe_success(self):
        profile = {"key": "threads", "platform": "threads"}
        cookies = [
            {
                "name": "sessionid",
                "value": "live-session",
                "domain": ".threads.com",
                "path": "/",
                "expires": 1893456000,
            }
        ]

        server._SENTIMENT_THREADS_LIVE_AUTH_CACHE.clear()
        response = mock.Mock(
            status_code=200,
            text="Threads home",
            url="https://www.threads.com/",
            headers={},
        )
        response.raw.headers.get_all.return_value = []
        session = mock.Mock()
        session.get.return_value = response
        with (
            mock.patch.object(server.requests, "Session", return_value=session),
            mock.patch.object(
                server,
                "_probe_threads_live_auth_with_browser",
                return_value={
                    "ok": True,
                    "status": "verified",
                    "searchUsable": True,
                    "searchStatus": "available",
                    "searchReason": "Threads search GraphQL returned 200",
                },
            ),
        ):
            state = server._sentiment_threads_live_auth_state(profile, cookies)

        self.assertTrue(state["liveAuthUsable"])
        self.assertEqual(state["liveAuthStatus"], "verified")
        self.assertEqual(state["liveAuthAction"], "keep")
        self.assertTrue(state["liveSearchUsable"])
        self.assertEqual(state["liveSearchStatus"], "available")

    def test_sentiment_cookie_expiry_normalizes_milliseconds_before_live_probe(self):
        milliseconds = 1_825_453_191_068
        normalized = server._normalize_sentiment_cookie_expiry(milliseconds)

        self.assertAlmostEqual(normalized, milliseconds / 1000, places=3)
        self.assertEqual(server._normalize_sentiment_cookie_expiry(1_893_456_000), 1_893_456_000)
        self.assertEqual(server._normalize_sentiment_cookie_expiry(None), -1)

    def test_instagram_profile_does_not_report_saved_cookie_as_live_usable(self):
        profile = {
            "key": "instagram",
            "platform": "instagram",
            "cookies": [
                {
                    "name": "sessionid",
                    "value": "saved-instagram-session",
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": 1_893_456_000,
                }
            ],
        }

        with mock.patch.object(
            server,
            "_sentiment_instagram_live_auth_state",
            return_value={
                "liveAuthStatus": "invalid",
                "liveAuthUsable": False,
                "liveAuthCheckedAt": "2026-07-31T00:00:00Z",
                "liveAuthMessage": "Instagram real-time session is invalid.",
                "liveAuthAction": "reauthorize-profile",
            },
        ):
            state = server._sentiment_profile_for_client(profile)

        self.assertTrue(state["sessionidSaved"])
        self.assertFalse(state["liveAuthUsable"])
        self.assertEqual(state["liveAuthStatus"], "invalid")
        self.assertEqual(state["authHealth"], "degraded")
        self.assertTrue(state["authorizationNeedsRefresh"])

    def test_forced_instagram_live_auth_refresh_bypasses_cached_result(self):
        profile = {"key": "instagram", "platform": "instagram"}
        cookies = [
            {
                "name": "sessionid",
                "value": "instagram-session-to-recheck",
                "domain": ".instagram.com",
                "path": "/",
                "expires": 1_893_456_000,
            }
        ]
        server._SENTIMENT_INSTAGRAM_LIVE_AUTH_CACHE.clear()
        with mock.patch.object(
            server,
            "_probe_instagram_live_auth_with_browser",
            side_effect=[
                {"ok": True, "status": "verified"},
                {"ok": False, "status": "invalid"},
            ],
        ) as probe:
            first = server._sentiment_instagram_live_auth_state(profile, cookies)
            cached = server._sentiment_instagram_live_auth_state(profile, cookies)
            refreshed = server._sentiment_instagram_live_auth_state(profile, cookies, force=True)

        self.assertTrue(first["liveAuthUsable"])
        self.assertTrue(cached["liveAuthUsable"])
        self.assertFalse(refreshed["liveAuthUsable"])
        self.assertEqual(probe.call_count, 2)

    def test_expired_live_auth_cache_keeps_last_result_for_non_probe_display(self):
        profile = {"key": "instagram", "platform": "instagram"}
        cookies = [
            {
                "name": "sessionid",
                "value": "instagram-session-for-stable-display",
                "domain": ".instagram.com",
                "path": "/",
                "expires": 1_893_456_000,
            }
        ]
        server._SENTIMENT_INSTAGRAM_LIVE_AUTH_CACHE.clear()
        with mock.patch.object(
            server,
            "_probe_instagram_live_auth_with_browser",
            return_value={
                "ok": True,
                "status": "verified",
                "searchUsable": True,
                "searchStatus": "available",
            },
        ):
            checked = server._sentiment_instagram_live_auth_state(profile, cookies, force=True)

        for entry in server._SENTIMENT_INSTAGRAM_LIVE_AUTH_CACHE.values():
            entry["expiresAt"] = 0

        with mock.patch.object(server, "_probe_instagram_live_auth_with_browser") as probe:
            displayed = server._sentiment_instagram_live_auth_state(
                profile,
                cookies,
                allow_probe=False,
            )

        probe.assert_not_called()
        self.assertEqual(displayed, checked)
        self.assertEqual(displayed["liveAuthStatus"], "verified")
        self.assertEqual(displayed["liveSearchStatus"], "available")

    def test_instagram_profile_waits_for_manual_refresh_before_uncached_probe(self):
        profile = {
            "key": "instagram",
            "platform": "instagram",
            "cookies": [
                {
                    "name": "sessionid",
                    "value": "saved-for-manual-check",
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": 1_893_456_000,
                }
            ],
        }
        server._SENTIMENT_INSTAGRAM_LIVE_AUTH_CACHE.clear()
        with mock.patch.object(server, "_probe_instagram_live_auth_with_browser") as probe:
            state = server._sentiment_profile_for_client(profile)

        probe.assert_not_called()
        self.assertEqual(state["liveAuthStatus"], "pending_manual_check")
        self.assertIsNone(state["liveAuthUsable"])
        self.assertEqual(state["liveAuthAction"], "manual-refresh")
        self.assertEqual(state["liveSearchStatus"], "pending_manual_check")
        self.assertIsNone(state["liveSearchUsable"])

    def test_instagram_live_auth_and_search_availability_are_reported_separately(self):
        profile = {"key": "instagram", "platform": "instagram"}
        cookies = [
            {
                "name": "sessionid",
                "value": "instagram-session-with-blocked-search",
                "domain": ".instagram.com",
                "path": "/",
                "expires": 1_893_456_000,
            }
        ]
        server._SENTIMENT_INSTAGRAM_LIVE_AUTH_CACHE.clear()
        with mock.patch.object(
            server,
            "_probe_instagram_live_auth_with_browser",
            return_value={
                "ok": True,
                "status": "verified",
                "searchUsable": False,
                "searchStatus": "unavailable",
                "searchReason": "Instagram search returned 403",
            },
        ):
            state = server._sentiment_instagram_live_auth_state(profile, cookies, force=True)

        self.assertTrue(state["liveAuthUsable"])
        self.assertEqual(state["liveAuthStatus"], "verified")
        self.assertFalse(state["liveSearchUsable"])
        self.assertEqual(state["liveSearchStatus"], "unavailable")

    def test_threads_profile_keeps_saved_state_separate_from_live_usability(self):
        profile = {
            "key": "threads",
            "platform": "threads",
            "cookies": [
                {
                    "name": "sessionid",
                    "value": "saved-session",
                    "domain": ".threads.com",
                    "path": "/",
                    "expires": 1893456000,
                }
            ],
        }

        with mock.patch.object(
            server,
            "_sentiment_threads_live_auth_state",
            return_value={
                "liveAuthStatus": "invalid",
                "liveAuthUsable": False,
                "liveAuthCheckedAt": "2026-07-13T00:00:00Z",
                "liveAuthMessage": "sessionid 已保存，但当前登录已失效；请重新登录后同步。",
                "liveAuthAction": "reauthorize-profile",
            },
        ):
            state = server._sentiment_profile_for_client(profile)

        self.assertTrue(state["sessionidSaved"])
        self.assertTrue(state["hasRequiredSessionCookie"])
        self.assertFalse(state["liveAuthUsable"])

    def test_threads_probe_failure_does_not_expose_runtime_error(self):
        profile = {"key": "threads", "platform": "threads"}
        cookies = [
            {
                "name": "sessionid",
                "value": "saved-session-2",
                "domain": ".threads.com",
                "path": "/",
                "expires": 1893456000,
            }
        ]
        response = mock.Mock()
        response.status_code = 200
        response.text = "Threads home"
        response.url = "https://www.threads.com/"
        response.headers = {}
        response.raw.headers.get_all.return_value = []
        session = mock.Mock()
        session.get.return_value = response
        technical_error = "Executable doesn't exist at /data/cache/chrome-headless-shell"

        server._SENTIMENT_THREADS_LIVE_AUTH_CACHE.clear()
        with (
            mock.patch.object(server.requests, "Session", return_value=session),
            mock.patch.object(
                server,
                "_probe_threads_live_auth_with_browser",
                return_value={"ok": None, "status": "probe_failed", "reason": technical_error},
            ),
        ):
            state = server._sentiment_threads_live_auth_state(profile, cookies)

        self.assertEqual(state["liveAuthStatus"], "probe_failed")
        self.assertNotIn(technical_error, state["liveAuthMessage"])
        self.assertEqual(state["liveAuthMessage"], "sessionid 已保存，实时检测未完成，请点击“刷新状态”重试。")

    def test_expired_threads_sessionid_is_not_reported_as_usable(self):
        state = server._sentiment_auth_state(
            [
                {
                    "name": "sessionid",
                    "value": "expired-but-stored",
                    "domain": ".threads.net",
                    "path": "/",
                    "expires": 1,
                }
            ],
            platform="threads",
        )

        self.assertFalse(state["sessionidSaved"])
        self.assertFalse(state["hasRequiredSessionCookie"])
        self.assertEqual(state["cookieCount"], 1)
        self.assertEqual(state["validCookieCount"], 0)

    def test_empty_cookie_value_is_not_reported_as_usable(self):
        state = server._sentiment_auth_state(
            [
                {
                    "name": "sessionid",
                    "value": "",
                    "domain": ".threads.net",
                    "path": "/",
                    "expires": 1893456000,
                }
            ],
            platform="threads",
        )

        self.assertFalse(state["sessionidSaved"])
        self.assertFalse(state["hasRequiredSessionCookie"])
        self.assertEqual(state["validCookieCount"], 0)
        self.assertEqual(state["validCookieNames"], [])

    def test_instagram_sessionid_is_reported_as_saved(self):
        state = server._sentiment_auth_state(
            [
                {
                    "name": "sessionid",
                    "value": "instagram-session",
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": 1893456000,
                }
            ],
            platform="instagram",
        )

        self.assertTrue(state["sessionidSaved"])
        self.assertTrue(state["hasRequiredSessionCookie"])

    def test_instagram_without_sessionid_is_reported_as_incomplete(self):
        state = server._sentiment_auth_state(
            [
                {
                    "name": "ds_user_id",
                    "value": "12345",
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": 1893456000,
                }
            ],
            platform="instagram",
        )

        self.assertFalse(state["sessionidSaved"])
        self.assertFalse(state["hasRequiredSessionCookie"])
        self.assertEqual(state["authHealth"], "degraded")
        self.assertEqual(state["authStatus"], "incomplete")

    def _admin_user_id(self) -> int:
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        row = conn.execute("SELECT id FROM users WHERE username = ?", ("admin",)).fetchone()
        conn.close()
        return int(row[0])

    def _assign_personas_to_admin(self, persona_ids):
        now = 1
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            conn.executemany(
                "INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(archive_id) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at",
                [(str(persona_id), self._admin_user_id(), now, now) for persona_id in persona_ids],
            )
            conn.commit()
        finally:
            conn.close()

    def _write_archives(self):
        archives = [
            {
                "id": "persona-1",
                "name": "History Teacher",
                "content": "Persona intro for history topics.",
                "createdAt": "2026-06-20T00:00:00Z",
                "updatedAt": "2026-06-30T00:00:00Z",
                "boundPadCode": "PAD-1",
                "boundPadName": "OP-TEST1",
                "ownerBotName": "primary",
                "setup": {
                    "personaName": "History Teacher",
                    "api_token": "super-secret-token",
                    "accountManagement": {"threads": {"password": "super-secret-password"}},
                    "hotMetrics": {
                        "threads": {
                            "platform": "threads",
                            "username": "history",
                            "recentViews": 1234,
                            "likes": 10,
                            "comments": 5,
                            "shares": 2,
                            "views": 300,
                            "scannedPosts": 2,
                            "viewResolvedPosts": 1,
                            "viewMissingPosts": 1,
                            "complete": True,
                            "postMetrics": [
                                {
                                    "sourceUrl": "https://www.threads.com/@history/post/abc",
                                    "content": "post one",
                                    "likeCount": 10,
                                    "commentCount": 5,
                                    "shareCount": 2,
                                    "viewCount": 300,
                                    "capturedAt": "2026-06-30T01:00:00Z",
                                    "mediaItems": [{"url": "data:image/png;base64,abc123", "type": "image"}],
                                }
                            ],
                        }
                    },
                },
                "posts": [{
                    "id": "post-1",
                    "title": "A",
                    "content": "post",
                    "createdAt": "2026-06-29T00:00:00Z",
                    "updatedAt": "2026-06-29T00:00:00Z",
                    "mediaUrl": str(self.draft_media_path),
                    "mediaType": "image",
                }],
                "platformPosts": {"threads": [{"id": "post-1"}], "telegram": []},
                "publishHistory": [
                    {
                        "id": "pub-1",
                        "archivePostId": "post-1",
                        "title": "A",
                        "content": "post",
                        "wordCount": 4,
                        "publishedAt": "2026-06-30T02:00:00Z",
                        "platform": "threads",
                        "publishedMeta": {
                            "platform": "threads",
                            "capturedAt": "2026-06-30T03:00:00Z",
                            "imageUrl": "https://example.com/publish-image.png",
                            "mediaItems": [{"url": str(self.draft_media_path), "type": "image", "label": "local-history"}],
                            "engagement": {"likeCount": 3, "commentCount": 1, "viewCount": 40},
                        },
                    }
                ],
                "personaImageLibrary": [{"id": "img-1", "imageUrl": "/x.jpg", "createdAt": "2026-06-29T00:00:00Z"}],
            }
        ]
        (self.tool_runtime_dir / "persona_archives.json").write_text(json.dumps(archives), encoding="utf-8")
        self._assign_personas_to_admin([archive["id"] for archive in archives])

    def _write_queue(self):
        conn = sqlite3.connect(str(self.tool_runtime_dir / "publish_queue.db"))
        conn.execute(
            """
            CREATE TABLE publish_tasks (
              id TEXT PRIMARY KEY,
              archive_id TEXT,
              archive_post_id TEXT,
              pad_code TEXT,
              platform TEXT,
              caption TEXT,
              media_url TEXT,
              status TEXT,
              attempts INTEGER,
              scheduled_at TEXT,
              started_at TEXT,
              finished_at TEXT,
              created_at TEXT,
              telegram_chat_id TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO publish_tasks(id, archive_id, archive_post_id, pad_code, platform, caption, status, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("task-1", "persona-1", "post-1", "PAD-1", "threads", "caption", "done", "2026-06-30T00:00:00Z", "2026-06-30T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO publish_tasks(id, archive_id, archive_post_id, pad_code, platform, caption, status, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("task-2", "", "", "PAD-2", "telegram", "caption", "failed", "2026-06-30T00:00:00Z", "2026-06-30T00:00:00Z"),
        )
        conn.commit()
        conn.close()

    def _insert_social_account(self, *, account_id="acct-1", persona_id="persona-1", platform="instagram", username="insta_user", status="ready"):
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        now = 1_720_000_000
        proxy_id = f"proxy-{account_id}"
        conn.execute(
            """
            INSERT OR IGNORE INTO social_proxies(
              id, user_id, name, proxy_type, host, port, username, password, country, isp,
              status, last_check_at, last_check_result, created_at, updated_at
            ) VALUES (?, ?, ?, 'http', '127.0.0.1', 18080, '', '', '', '', 'active', ?, '{"ok": true}', ?, ?)
            """,
            (proxy_id, self._admin_user_id(), proxy_id, now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_accounts(id, user_id, persona_id, platform, username, display_name, profile_dir, proxy_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account_id,
                self._admin_user_id(),
                persona_id,
                platform,
                username,
                username,
                str(self.data_dir / "profiles" / account_id),
                proxy_id,
                status,
                now,
                now,
            ),
        )
        conn.commit()
        conn.close()

    def _insert_social_task(
        self,
        *,
        task_id="task-social-1",
        account_id="acct-1",
        persona_id="persona-1",
        platform="instagram",
        task_type="check_login",
        status="success",
        payload=None,
        result=None,
        created_at=1_720_000_000,
        priority=50,
    ):
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, user_id, persona_id, account_id, platform, task_type, priority, status, scheduled_at,
              started_at, finished_at, payload_json, result_json, error, retry_count, max_retries,
              created_by, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                self._admin_user_id(),
                persona_id,
                account_id,
                platform,
                task_type,
                priority,
                status,
                0,
                created_at,
                created_at + 10,
                json.dumps(payload or {}, ensure_ascii=False),
                json.dumps(result or {}, ensure_ascii=False),
                "",
                0,
                2,
                "web",
                created_at,
                created_at + 10,
            ),
        )
        conn.commit()
        conn.close()

    def test_overview_returns_empty_when_archive_files_are_missing(self):
        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["summary"]["persona_count"], 0)
        self.assertEqual(data["personas"], [])

    def test_overview_is_public_read_only(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["summary"]["persona_count"], 1)

    def test_overview_merges_primary_and_cache_persona_archives(self):
        self._write_archives()
        cache_archives = {
            "persona_archives_v2": [
                {
                    "id": "persona-1",
                    "name": "Primary duplicate should not win",
                    "setup": {},
                },
                {
                    "id": "legacy-cache-only",
                    "name": "Cache Legacy",
                    "content": "legacy persona from cache",
                    "setup": {},
                    "posts": [],
                    "platformPosts": {},
                    "publishHistory": [],
                    "personaImageLibrary": [],
                },
            ]
        }
        (self.tool_runtime_dir / "persona_archives_cache.json").write_text(json.dumps(cache_archives, ensure_ascii=False), encoding="utf-8")
        self._assign_personas_to_admin(["legacy-cache-only"])

        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        names = {item["name"]: item for item in data["personas"]}
        self.assertEqual(data["summary"]["persona_count"], 2)
        self.assertIn("History Teacher", names)
        self.assertIn("Cache Legacy", names)
        self.assertTrue(data["data_sources"]["archives"]["merged"])
        self.assertEqual(data["data_sources"]["archives"]["primary_count"], 1)
        self.assertEqual(data["data_sources"]["archives"]["fallback_count"], 2)

        profile_resp = self.client.get("/api/persona_dashboard/personas/legacy-cache-only/profile")
        self.assertEqual(profile_resp.status_code, 200)

    def test_overview_aggregates_personas_and_queue_stats(self):
        self._write_archives()
        self._write_queue()
        (self.tool_runtime_dir / "sentiment_hot_candidates.json").write_text(
            json.dumps({"shown": {"persona-1": [{"id": "hot-1"}]}, "cache": [{"id": "candidate-1"}]}),
            encoding="utf-8",
        )

        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["summary"]["persona_count"], 1)
        self.assertEqual(data["summary"]["post_count"], 1)
        self.assertEqual(data["summary"]["published_count"], 1)
        self.assertEqual(data["summary"]["task_count"], 1)
        self.assertEqual(data["charts"]["task_status_distribution"]["done"], 1)
        self.assertEqual(data["data_sources"]["sentiment_hot_candidates"]["shown_count"], 1)
        data_sources = json.dumps(data["data_sources"], ensure_ascii=False)
        self.assertNotIn(str(self.tool_runtime_dir), data_sources)
        persona = data["personas"][0]
        self.assertIn("threads_account", persona)
        self.assertNotIn("telegram", persona)
        self.assertFalse(persona["threads_account"]["bound"])
        self.assertTrue(any("Threads" in item for item in persona["warnings"]))

    def test_overview_exposes_platform_scoped_trends_without_changing_global_totals(self):
        self._write_archives()

        resp = self.client.get("/api/persona_dashboard/overview")

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["summary"]["persona_count"], 1)
        self.assertEqual(data["summary"]["post_count"], 1)
        self.assertEqual(data["summary"]["published_count"], 1)
        threads_trend = data["charts"]["platform_trend"]["threads"]
        self.assertEqual(threads_trend[0]["date"], "2026-06-30")
        self.assertEqual(threads_trend[0]["published"], 1)
        self.assertEqual(threads_trend[0]["likes"], 3)
        self.assertNotIn("instagram", data["charts"]["platform_trend"])

    def test_overview_post_count_ignores_legacy_published_drafts(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"].append({
            "id": "legacy-published-count",
            "title": "Legacy published draft",
            "content": "Already published",
            "publishedAt": "2026-07-01T00:00:00Z",
        })
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/overview")

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["summary"]["post_count"], 1)
        self.assertEqual(data["personas"][0]["counts"]["posts"], 1)

    def test_recent_views_and_post_views_are_separate(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["summary"]["recent_views"], 1234)
        self.assertGreaterEqual(data["summary"]["post_views"], 300)
        persona = data["personas"][0]
        self.assertEqual(persona["hot"]["recent_views"], 1234)
        self.assertEqual(persona["hot"]["post_views"], 300)
        self.assertEqual(persona["post_metrics"][0]["media_items"][0]["url"], "data:image/png;base64,abc123")
        self.assertIn("浏览", persona["hot_score_formula"])

    def test_post_metadata_keeps_reposts_and_shares_as_independent_metrics(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"][0]["sourceMeta"] = {
            "platform": "threads",
            "originalContent": "post",
            "metrics": {"send_count": 11},
            "engagement": {"shareCount": 99, "repostCount": 7},
            "capturedAt": "2026-06-30T04:00:00Z",
        }
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        response = self.client.get("/api/persona_dashboard/overview")

        self.assertEqual(response.status_code, 200)
        rows = response.json()["personas"][0]["post_metrics"]
        row = next(item for item in rows if item.get("id") == "post-1")
        self.assertEqual(row["share_count"], 11)
        self.assertEqual(row["repost_count"], 7)

    def test_overview_uses_owner_scoped_media_route_for_matched_archive_post(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        metric = archives[0]["setup"]["hotMetrics"]["threads"]["postMetrics"][0]
        metric["content"] = "post"
        metric["mediaItems"] = [{"url": "https://cdn.example.invalid/expired.jpg", "type": "image"}]
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        response = self.client.get("/api/persona_dashboard/overview")

        self.assertEqual(response.status_code, 200)
        item = response.json()["personas"][0]["post_metrics"][0]["media_items"][0]
        self.assertIn("/api/persona_dashboard/personas/persona-1/posts/post-1/media/0", item["preview_url"])
        self.assertNotIn("/api/persona_dashboard/media/", item["preview_url"])
        media_response = self.client.get(item["preview_url"])
        self.assertEqual(media_response.status_code, 200)
        self.assertEqual(media_response.headers["content-type"], "image/png")

    def test_console_overview_aggregates_hot_metrics_without_heavy_rows(self):
        self._write_archives()

        full_resp = self.client.get("/api/persona_dashboard/overview")
        console_resp = self.client.get("/api/persona_dashboard/console_overview")

        self.assertEqual(full_resp.status_code, 200)
        self.assertEqual(console_resp.status_code, 200)
        full_persona = full_resp.json()["personas"][0]
        console_persona = console_resp.json()["personas"][0]
        self.assertEqual(console_persona["hot"], full_persona["hot"])
        self.assertGreater(console_persona["hot"]["hot_score"], 0)
        self.assertEqual(console_persona["hot_platforms"], [])
        self.assertEqual(console_persona["post_metrics"], [])

        post_key = full_persona["post_metrics"][0]["post_key"]
        (self.tool_runtime_dir / "persona_dashboard_deleted_posts.json").write_text(
            json.dumps({"persona-1": [post_key]}),
            encoding="utf-8",
        )
        filtered_full = self.client.get("/api/persona_dashboard/overview").json()["personas"][0]
        filtered_console = self.client.get("/api/persona_dashboard/console_overview").json()["personas"][0]
        self.assertEqual(filtered_console["hot"], filtered_full["hot"])
        self.assertEqual(filtered_console["hot"]["hot_score"], 0)
        self.assertEqual(filtered_console["hot"]["recent_views"], 1234)

    def test_sensitive_values_are_masked(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        body = json.dumps(resp.json(), ensure_ascii=False)
        self.assertNotIn("super-secret-token", body)
        self.assertNotIn("super-secret-password", body)
        self.assertIn("configured", body)

    def test_persona_groups_create_assign_collapse_rename_and_remove(self):
        self._write_archives()

        create_resp = self.client.post("/api/persona_dashboard/groups", json={"name": "Matrix Group"})
        self.assertEqual(create_resp.status_code, 200)
        group = create_resp.json()["group"]
        group_id = group["id"]
        self.assertEqual(group["name"], "Matrix Group")
        self.assertEqual(group["persona_ids"], [])

        add_resp = self.client.post(
            f"/api/persona_dashboard/groups/{group_id}/personas",
            json={"persona_id": "persona-1"},
        )
        self.assertEqual(add_resp.status_code, 200)
        self.assertEqual(add_resp.json()["group"]["persona_ids"], ["persona-1"])

        overview = self.client.get("/api/persona_dashboard/overview").json()
        groups = overview["persona_groups"]["groups"]
        self.assertEqual(groups[0]["persona_ids"], ["persona-1"])
        self.assertEqual(overview["persona_groups"]["assigned_persona_ids"], ["persona-1"])

        second_resp = self.client.post("/api/persona_dashboard/groups", json={"name": "Second Matrix"})
        self.assertEqual(second_resp.status_code, 200)
        second_group_id = second_resp.json()["group"]["id"]
        move_resp = self.client.post(
            f"/api/persona_dashboard/groups/{second_group_id}/personas",
            json={"persona_id": "persona-1"},
        )
        self.assertEqual(move_resp.status_code, 200)
        overview = self.client.get("/api/persona_dashboard/overview").json()
        groups = overview["persona_groups"]["groups"]
        self.assertEqual(groups[0]["persona_ids"], [])
        self.assertEqual(groups[1]["persona_ids"], ["persona-1"])

        add_resp = self.client.post(
            f"/api/persona_dashboard/groups/{group_id}/personas",
            json={"persona_id": "persona-1"},
        )
        self.assertEqual(add_resp.status_code, 200)
        self.assertEqual(add_resp.json()["group"]["persona_ids"], ["persona-1"])

        collapse_resp = self.client.post(
            f"/api/persona_dashboard/groups/{group_id}/collapse",
            json={"collapsed": True},
        )
        self.assertEqual(collapse_resp.status_code, 200)
        self.assertTrue(collapse_resp.json()["group"]["collapsed"])

        rename_resp = self.client.patch(
            f"/api/persona_dashboard/groups/{group_id}",
            json={"name": "Renamed Matrix"},
        )
        self.assertEqual(rename_resp.status_code, 200)
        self.assertEqual(rename_resp.json()["group"]["name"], "Renamed Matrix")

        remove_resp = self.client.delete(f"/api/persona_dashboard/groups/{group_id}/personas/persona-1")
        self.assertEqual(remove_resp.status_code, 200)
        self.assertEqual(remove_resp.json()["group"]["persona_ids"], [])

        persisted = json.loads((self.tool_runtime_dir / "persona_groups.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["groups"][0]["name"], "Renamed Matrix")
        self.assertEqual(persisted["groups"][0]["persona_ids"], [])
        self.assertEqual(persisted["groups"][1]["persona_ids"], [])

    def test_batch_delete_groups_preserves_personas_and_releases_them_in_order(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        second = json.loads(json.dumps(archives[0]))
        second.update({"id": "persona-2", "name": "Science Teacher"})
        archives.append(second)
        archives_path.write_text(json.dumps(archives), encoding="utf-8")
        self._assign_personas_to_admin(["persona-2"])

        first = self.client.post("/api/persona_dashboard/groups", json={"name": "First"}).json()["group"]
        second_group = self.client.post("/api/persona_dashboard/groups", json={"name": "Second"}).json()["group"]
        self.client.post(f"/api/persona_dashboard/groups/{first['id']}/personas", json={"persona_id": "persona-1"})
        self.client.post(f"/api/persona_dashboard/groups/{second_group['id']}/personas", json={"persona_id": "persona-2"})

        resp = self.client.post(
            "/api/persona_dashboard/groups/batch-delete",
            json={"group_ids": [first["id"], second_group["id"], first["id"]]},
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["deleted_ids"], [first["id"], second_group["id"]])
        self.assertEqual(resp.json()["deleted_count"], 2)
        persisted = json.loads((self.tool_runtime_dir / "persona_groups.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["groups"], [])
        self.assertEqual(persisted["ungrouped_persona_ids"], ["persona-1", "persona-2"])
        self.assertEqual(len(json.loads(archives_path.read_text(encoding="utf-8"))), 2)
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            owner_count = conn.execute(
                "SELECT COUNT(*) FROM persona_group_owners WHERE group_id IN (?, ?)",
                (first["id"], second_group["id"]),
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(owner_count, 0)

    def test_batch_delete_groups_supports_empty_group(self):
        empty_group = self.client.post("/api/persona_dashboard/groups", json={"name": "Empty"}).json()["group"]

        resp = self.client.post(
            "/api/persona_dashboard/groups/batch-delete",
            json={"group_ids": [empty_group["id"]]},
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["deleted_count"], 1)
        self.assertEqual(resp.json()["released_persona_ids"], [])

    def test_batch_delete_selection_removes_personas_and_groups_together(self):
        self._write_archives()
        group = self.client.post("/api/persona_dashboard/groups", json={"name": "Combined"}).json()["group"]
        self.client.post(
            f"/api/persona_dashboard/groups/{group['id']}/personas",
            json={"persona_id": "persona-1"},
        )

        resp = self.client.post(
            "/api/persona_dashboard/selection/batch-delete",
            json={"persona_ids": ["persona-1"], "group_ids": [group["id"]]},
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["deleted_persona_ids"], ["persona-1"])
        self.assertEqual(resp.json()["deleted_group_ids"], [group["id"]])
        self.assertEqual(
            json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8")),
            [],
        )
        groups = json.loads((self.tool_runtime_dir / "persona_groups.json").read_text(encoding="utf-8"))
        self.assertEqual(groups["groups"], [])
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            persona_owner_count = conn.execute(
                "SELECT COUNT(*) FROM persona_owners WHERE archive_id = 'persona-1'"
            ).fetchone()[0]
            group_owner_count = conn.execute(
                "SELECT COUNT(*) FROM persona_group_owners WHERE group_id = ?",
                (group["id"],),
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(persona_owner_count, 0)
        self.assertEqual(group_owner_count, 0)

    def test_batch_delete_selection_restores_files_when_second_mutation_fails(self):
        self._write_archives()
        group = self.client.post("/api/persona_dashboard/groups", json={"name": "Rollback"}).json()["group"]
        self.client.post(
            f"/api/persona_dashboard/groups/{group['id']}/personas",
            json={"persona_id": "persona-1"},
        )
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        groups_path = self.tool_runtime_dir / "persona_groups.json"
        archives_before = archives_path.read_bytes()
        groups_before = groups_path.read_bytes()

        with mock.patch.object(server, "_delete_persona_groups", side_effect=RuntimeError("write failed")):
            with self.assertRaisesRegex(RuntimeError, "write failed"):
                self.client.post(
                    "/api/persona_dashboard/selection/batch-delete",
                    json={"persona_ids": ["persona-1"], "group_ids": [group["id"]]},
                )

        self.assertEqual(archives_path.read_bytes(), archives_before)
        self.assertEqual(groups_path.read_bytes(), groups_before)
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            persona_owner_count = conn.execute(
                "SELECT COUNT(*) FROM persona_owners WHERE archive_id = 'persona-1'"
            ).fetchone()[0]
            group_owner_count = conn.execute(
                "SELECT COUNT(*) FROM persona_group_owners WHERE group_id = ?",
                (group["id"],),
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(persona_owner_count, 1)
        self.assertEqual(group_owner_count, 1)

    def test_batch_delete_group_does_not_release_persona_kept_in_another_group(self):
        groups_path = self.tool_runtime_dir / "persona_groups.json"
        groups_path.write_text(json.dumps({
            "groups": [
                {"id": "delete-me", "name": "Delete", "persona_ids": ["persona-1"]},
                {"id": "keep-me", "name": "Keep", "persona_ids": ["persona-1"]},
            ],
            "ungrouped_persona_ids": [],
        }), encoding="utf-8")
        now = 1
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            conn.executemany(
                "INSERT INTO persona_group_owners(group_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
                [("delete-me", self._admin_user_id(), now, now), ("keep-me", self._admin_user_id(), now, now)],
            )
            conn.commit()
        finally:
            conn.close()

        resp = self.client.post(
            "/api/persona_dashboard/groups/batch-delete",
            json={"group_ids": ["delete-me"]},
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["released_persona_ids"], [])
        persisted = json.loads(groups_path.read_text(encoding="utf-8"))
        self.assertEqual([group["id"] for group in persisted["groups"]], ["keep-me"])
        self.assertEqual(persisted["ungrouped_persona_ids"], [])

    def test_group_mutations_preserve_existing_ungrouped_order(self):
        groups_path = self.tool_runtime_dir / "persona_groups.json"
        groups_path.write_text(json.dumps({
            "groups": [],
            "ungrouped_persona_ids": ["persona-2", "persona-1"],
        }), encoding="utf-8")

        group = self.client.post("/api/persona_dashboard/groups", json={"name": "Temporary"}).json()["group"]
        rename = self.client.patch(
            f"/api/persona_dashboard/groups/{group['id']}",
            json={"name": "Renamed"},
        )
        self.assertEqual(rename.status_code, 200, rename.text)
        collapse = self.client.post(
            f"/api/persona_dashboard/groups/{group['id']}/collapse",
            json={"collapsed": True},
        )
        self.assertEqual(collapse.status_code, 200, collapse.text)
        delete = self.client.delete(f"/api/persona_dashboard/groups/{group['id']}")
        self.assertEqual(delete.status_code, 200, delete.text)

        persisted = json.loads(groups_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["ungrouped_persona_ids"], ["persona-2", "persona-1"])

    def test_batch_delete_groups_rejects_missing_group_without_mutation(self):
        first = self.client.post("/api/persona_dashboard/groups", json={"name": "Keep"}).json()["group"]
        groups_path = self.tool_runtime_dir / "persona_groups.json"
        before = groups_path.read_text(encoding="utf-8")

        resp = self.client.post(
            "/api/persona_dashboard/groups/batch-delete",
            json={"group_ids": [first["id"], "missing-group"]},
        )

        self.assertEqual(resp.status_code, 404, resp.text)
        self.assertEqual(groups_path.read_text(encoding="utf-8"), before)

    def test_batch_delete_groups_requires_login(self):
        resp = self.unauth_client.post(
            "/api/persona_dashboard/groups/batch-delete",
            json={"group_ids": ["group-1"]},
        )
        self.assertEqual(resp.status_code, 401, resp.text)

    def test_batch_delete_groups_rejects_group_owned_by_another_user(self):
        group = self.client.post("/api/persona_dashboard/groups", json={"name": "Admin only"}).json()["group"]
        groups_path = self.tool_runtime_dir / "persona_groups.json"
        before = groups_path.read_text(encoding="utf-8")
        application = self.unauth_client.post("/api/auth/apply", json={
            "username": "group_batch_user",
            "password": "guest123",
            "full_name": "Group Batch User",
            "email": "group-batch@example.com",
            "phone": "0912345678",
            "company": "Vecto Test",
            "use_case": "Group batch permission regression",
        })
        self.assertEqual(application.status_code, 200, application.text)
        user_id = int(application.json()["id"])
        approval = self.client.post(
            f"/api/admin/users/{user_id}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approval.status_code, 200, approval.text)
        customer = TestClient(self.app)
        login = customer.post(
            "/api/auth/user-login",
            json={"username": "group_batch_user", "password": "guest123"},
        )
        self.assertEqual(login.status_code, 200, login.text)

        resp = customer.post(
            "/api/persona_dashboard/groups/batch-delete",
            json={"group_ids": [group["id"]]},
        )

        self.assertEqual(resp.status_code, 404, resp.text)
        self.assertEqual(groups_path.read_text(encoding="utf-8"), before)

    def test_persona_groups_reorder_persists_drag_layout(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        for persona_id, name in (("persona-2", "Driver"), ("persona-3", "Broker")):
            item = json.loads(json.dumps(archives[0]))
            item["id"] = persona_id
            item["name"] = name
            item["setup"]["personaName"] = name
            archives.append(item)
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")
        self._assign_personas_to_admin(["persona-2", "persona-3"])

        first_group = self.client.post("/api/persona_dashboard/groups", json={"name": "First"}).json()["group"]
        second_group = self.client.post("/api/persona_dashboard/groups", json={"name": "Second"}).json()["group"]

        reorder_resp = self.client.post(
            "/api/persona_dashboard/groups/reorder",
            json={
                "groups": [
                    {"id": second_group["id"], "persona_ids": ["persona-2"]},
                    {"id": first_group["id"], "persona_ids": ["persona-1"]},
                ],
                "ungrouped_persona_ids": ["persona-3"],
            },
        )
        self.assertEqual(reorder_resp.status_code, 200)
        groups = reorder_resp.json()["groups"]
        self.assertEqual([group["id"] for group in groups], [second_group["id"], first_group["id"]])
        self.assertEqual(groups[0]["persona_ids"], ["persona-2"])
        self.assertEqual(groups[1]["persona_ids"], ["persona-1"])
        self.assertEqual(reorder_resp.json()["ungrouped_persona_ids"], ["persona-3"])

        drag_out_resp = self.client.post(
            "/api/persona_dashboard/groups/reorder",
            json={
                "groups": [
                    {"id": second_group["id"], "persona_ids": []},
                    {"id": first_group["id"], "persona_ids": ["persona-1"]},
                ],
                "ungrouped_persona_ids": ["persona-2", "persona-3"],
            },
        )
        self.assertEqual(drag_out_resp.status_code, 200)
        self.assertEqual(drag_out_resp.json()["groups"][0]["persona_ids"], [])
        self.assertEqual(drag_out_resp.json()["ungrouped_persona_ids"], ["persona-2", "persona-3"])

        persisted = json.loads((self.tool_runtime_dir / "persona_groups.json").read_text(encoding="utf-8"))
        self.assertEqual([group["id"] for group in persisted["groups"]], [second_group["id"], first_group["id"]])
        self.assertEqual(persisted["ungrouped_persona_ids"], ["persona-2", "persona-3"])

    def test_publish_queue_missing_is_non_fatal(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["summary"]["task_count"], 0)
        self.assertFalse(data["data_sources"]["publish_queue"]["exists"])

    def test_public_threads_binding_updates_archive(self):
        self._write_archives()
        resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/threads_binding",
            json={"username": "https://www.threads.net/@history_user?x=1"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["username"], "history_user")
        overview = self.client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        self.assertTrue(persona["threads_account"]["bound"])
        self.assertEqual(persona["threads_account"]["handle"], "history_user")

    def test_public_threads_unbinding_clears_handle(self):
        self._write_archives()
        bind_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/threads_binding",
            json={"username": "history_user"},
        )
        self.assertEqual(bind_resp.status_code, 200)
        resp = self.client.delete("/api/persona_dashboard/personas/persona-1/threads_binding")
        self.assertEqual(resp.status_code, 200)
        overview = self.client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        self.assertFalse(persona["threads_account"]["bound"])
        self.assertEqual(persona["threads_account"]["handle"], "")

    def test_public_persona_profile_returns_editable_fields(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/personas/persona-1/profile")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["id"], "persona-1")
        self.assertEqual(data["name"], "History Teacher")
        self.assertEqual(data["content"], "Persona intro for history topics.")
        self.assertEqual(data["image_count"], 1)
        self.assertEqual(data["bound_pad_code"], "PAD-1")
        self.assertEqual(data["bound_pad_name"], "OP-TEST1")
        self.assertEqual(data["link_presets"], [])
        self.assertIsNone(data["avatar"])

    def test_public_persona_profile_patch_updates_basic_fields(self):
        self._write_archives()
        resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={
                "name": "Updated History Teacher",
                "content": "Updated intro",
                "bound_pad_code": "PAD-99",
                "bound_pad_name": "OP-TEST99",
            },
        )
        self.assertEqual(resp.status_code, 200)
        profile = resp.json()
        self.assertEqual(profile["name"], "Updated History Teacher")
        self.assertEqual(profile["content"], "Updated intro")
        self.assertEqual(profile["bound_pad_code"], "PAD-99")
        self.assertEqual(profile["bound_pad_name"], "OP-TEST99")
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertEqual(archives[0]["name"], "Updated History Teacher")
        self.assertEqual(archives[0]["content"], "Updated intro")
        self.assertEqual(archives[0]["boundPadCode"], "PAD-99")
        self.assertEqual(archives[0]["boundPadName"], "OP-TEST99")

    def test_hot_warning_reports_keyword_timeout_without_generic_fallback(self):
        messages = server._persona_hot_user_warnings(
            ["热点关键词生成超时，本次未执行抓取；请稍后重试。"],
            0,
            10,
            [],
        )

        self.assertEqual(messages, ["热点关键词生成超时，本次未执行抓取，请稍后重试。"])
        self.assertNotIn("暂未找到", " ".join(messages))

    def test_hot_warning_reports_source_timeout_without_generic_fallback(self):
        messages = server._persona_hot_user_warnings(
            ["热点抓取已超时，已停止后续耗时步骤。"],
            0,
            10,
            [],
        )

        self.assertEqual(messages, ["热点来源抓取超时，本次未获得候选，请稍后重试。"])
        self.assertNotIn("暂未找到", " ".join(messages))

    def test_public_persona_profile_persists_avatar_crop_without_replacing_reference(self):
        self._write_archives()
        resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={
                "avatar": {
                    "image_id": "img-1",
                    "crop_x": 18,
                    "crop_y": 74,
                    "zoom": 1.65,
                }
            },
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        avatar = resp.json()["avatar"]
        self.assertEqual(avatar["image_id"], "img-1")
        self.assertEqual(avatar["crop_x"], 18)
        self.assertEqual(avatar["crop_y"], 74)
        self.assertEqual(avatar["zoom"], 1.65)
        self.assertEqual(avatar["preview_url"], "/api/persona_dashboard/personas/persona-1/images/img-1")
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertEqual(archives[0]["setup"]["personaProfileAvatar"]["imageId"], "img-1")
        self.assertNotIn("personaImageReferenceUrl", archives[0]["setup"])

    def test_public_persona_profile_rejects_unknown_avatar_and_delete_clears_avatar(self):
        self._write_archives()
        invalid = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={"avatar": {"image_id": "missing-image"}},
        )
        self.assertEqual(invalid.status_code, 400, invalid.text)

        saved = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={"avatar": {"image_id": "img-1", "crop_x": 50, "crop_y": 50, "zoom": 1}},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        deleted = self.client.delete("/api/persona_dashboard/personas/persona-1/images/img-1")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        profile = self.client.get("/api/persona_dashboard/personas/persona-1/profile").json()
        self.assertIsNone(profile["avatar"])

    def test_public_persona_profile_patch_updates_tweet_style_and_link_presets(self):
        self._write_archives()
        resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={
                "tweet_style_sample": "Tonight a quick history fact. Want more? https://example.com/story",
                "link_presets": [
                    {
                        "id": "preset-main",
                        "name": "style preset",
                        "link_url": "https://example.com/main",
                        "ending_text": "see more",
                        "enabled": True,
                    }
                ],
                "active_link_preset_id": "preset-main",
            },
        )
        self.assertEqual(resp.status_code, 200)
        profile = resp.json()
        self.assertTrue(profile["tweet_style_profile"])
        self.assertEqual(profile["active_link_preset_id"], "preset-main")
        self.assertEqual(len(profile["link_presets"]), 1)
        self.assertEqual(profile["link_presets"][0]["link_url"], "https://example.com/main")
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        setup = archives[0]["setup"]
        self.assertEqual(setup["tweetStyleSample"], "Tonight a quick history fact. Want more? https://example.com/story")
        self.assertTrue(setup["tweetStyleProfile"])
        self.assertEqual(setup["activeLinkEndingPresetId"], "preset-main")
        self.assertEqual(setup["linkEndingPresets"][0]["linkUrl"], "https://example.com/main")

    def test_public_persona_profile_accepts_long_unified_ending_content(self):
        self._write_archives()
        ending_content = "了解更多： https://example.com/main\n" + ("补充说明" * 180)
        resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={
                "link_presets": [
                    {
                        "id": "preset-ending",
                        "name": "结尾内容模板",
                        "link_url": "",
                        "ending_text": ending_content,
                        "enabled": True,
                    }
                ],
                "active_link_preset_id": "preset-ending",
            },
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        preset = resp.json()["link_presets"][0]
        self.assertEqual(preset["link_url"], "")
        self.assertEqual(preset["ending_text"], ending_content)
        persisted = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted[0]["setup"]["linkEndingPresets"][0]["endingText"], ending_content)

    def test_public_persona_profile_allows_clearing_active_link_preset(self):
        self._write_archives()
        enabled = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={
                "link_presets": [
                    {
                        "id": "preset-main",
                        "name": "main preset",
                        "link_url": "https://example.com/main",
                        "ending_text": "see more",
                        "enabled": True,
                    }
                ],
                "active_link_preset_id": "preset-main",
            },
        )
        self.assertEqual(enabled.status_code, 200, enabled.text)
        self.assertEqual(enabled.json()["active_link_preset_id"], "preset-main")

        disabled = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/profile",
            json={"active_link_preset_id": ""},
        )

        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertEqual(disabled.json()["active_link_preset_id"], "")
        persisted = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted[0]["setup"]["activeLinkEndingPresetId"], "")

    def test_public_delete_persona_removes_non_workflow_archive(self):
        self._write_archives()
        resp = self.client.delete("/api/persona_dashboard/personas/persona-1")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["archive_id"], "persona-1")
        overview = self.client.get("/api/persona_dashboard/overview").json()
        self.assertEqual(overview["summary"]["persona_count"], 0)

    def test_public_delete_persona_removes_primary_and_cache_duplicates(self):
        self._write_archives()
        primary_path = self.tool_runtime_dir / "persona_archives.json"
        cache_path = self.tool_runtime_dir / "persona_archives_cache.json"
        cache_path.write_text(primary_path.read_text(encoding="utf-8"), encoding="utf-8")

        resp = self.client.delete("/api/persona_dashboard/personas/persona-1")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(set(resp.json()["paths"]), {"persona_archives.json", "persona_archives_cache.json"})
        self.assertEqual(json.loads(primary_path.read_text(encoding="utf-8")), [])
        self.assertEqual(json.loads(cache_path.read_text(encoding="utf-8")), [])
        overview = self.client.get("/api/persona_dashboard/overview").json()
        self.assertEqual(overview["summary"]["persona_count"], 0)

    def test_public_delete_persona_allows_legacy_archive(self):
        archives = [
            {
                "id": "wf-1",
                "name": "Legacy Persona",
                "content": "legacy seed",
                "setup": {},
            }
        ]
        (self.tool_runtime_dir / "persona_archives.json").write_text(json.dumps(archives), encoding="utf-8")
        self._assign_personas_to_admin(["wf-1"])
        resp = self.client.delete("/api/persona_dashboard/personas/wf-1")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

    def test_batch_delete_personas_cleans_related_runtime_state(self):
        self._write_archives()
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        second = json.loads(json.dumps(archives[0]))
        second.update({"id": "persona-2", "name": "Science Teacher"})
        archives.append(second)
        primary_path = self.tool_runtime_dir / "persona_archives.json"
        cache_path = self.tool_runtime_dir / "persona_archives_cache.json"
        primary_path.write_text(json.dumps(archives), encoding="utf-8")
        cache_path.write_text(json.dumps(archives), encoding="utf-8")
        (self.tool_runtime_dir / "persona_groups.json").write_text(json.dumps({
            "groups": [{"id": "group-1", "name": "Teachers", "persona_ids": ["persona-1", "persona-2"]}],
        }), encoding="utf-8")
        for filename in (
            "persona_memory.json",
            "persona_dashboard_deleted_posts.json",
            "persona_dashboard_hidden_memories.json",
        ):
            (self.tool_runtime_dir / filename).write_text(json.dumps({
                "persona-1": ["entry-1"],
                "persona-2": ["entry-2"],
            }), encoding="utf-8")
        admin_id = self._admin_user_id()
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            conn.executemany(
                "INSERT OR REPLACE INTO persona_owners(archive_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
                [("persona-1", admin_id, 1, 1), ("persona-2", admin_id, 1, 1)],
            )
            conn.commit()
        finally:
            conn.close()

        resp = self.client.post(
            "/api/persona_dashboard/personas/batch-delete",
            json={"persona_ids": ["persona-1", "persona-2", "persona-1"]},
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["deleted_ids"], ["persona-1", "persona-2"])
        self.assertEqual(resp.json()["deleted_count"], 2)
        self.assertEqual(json.loads(primary_path.read_text(encoding="utf-8")), [])
        self.assertEqual(json.loads(cache_path.read_text(encoding="utf-8")), [])
        groups = json.loads((self.tool_runtime_dir / "persona_groups.json").read_text(encoding="utf-8"))
        self.assertEqual(groups["groups"][0]["persona_ids"], [])
        for filename in (
            "persona_memory.json",
            "persona_dashboard_deleted_posts.json",
            "persona_dashboard_hidden_memories.json",
        ):
            self.assertEqual(json.loads((self.tool_runtime_dir / filename).read_text(encoding="utf-8")), {})
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            owner_count = conn.execute(
                "SELECT COUNT(*) FROM persona_owners WHERE archive_id IN ('persona-1', 'persona-2')"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(owner_count, 0)

    def test_batch_delete_rejects_missing_persona_without_mutation(self):
        self._write_archives()
        primary_path = self.tool_runtime_dir / "persona_archives.json"
        before = primary_path.read_text(encoding="utf-8")

        resp = self.client.post(
            "/api/persona_dashboard/personas/batch-delete",
            json={"persona_ids": ["persona-1", "missing-persona"]},
        )

        self.assertEqual(resp.status_code, 404, resp.text)
        self.assertEqual(primary_path.read_text(encoding="utf-8"), before)

    def test_batch_delete_personas_requires_login(self):
        resp = self.unauth_client.post(
            "/api/persona_dashboard/personas/batch-delete",
            json={"persona_ids": ["persona-1"]},
        )
        self.assertEqual(resp.status_code, 401, resp.text)

    def test_batch_delete_rejects_persona_owned_by_another_user(self):
        self._write_archives()
        primary_path = self.tool_runtime_dir / "persona_archives.json"
        before = primary_path.read_text(encoding="utf-8")
        application = self.unauth_client.post("/api/auth/apply", json={
            "username": "batch_delete_user",
            "password": "guest123",
            "full_name": "Batch Delete User",
            "email": "batch-delete@example.com",
            "phone": "0912345678",
            "company": "Vecto Test",
            "use_case": "Batch delete permission regression",
        })
        self.assertEqual(application.status_code, 200, application.text)
        user_id = int(application.json()["id"])
        approval = self.client.post(
            f"/api/admin/users/{user_id}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approval.status_code, 200, approval.text)
        customer = TestClient(self.app)
        login = customer.post(
            "/api/auth/user-login",
            json={"username": "batch_delete_user", "password": "guest123"},
        )
        self.assertEqual(login.status_code, 200, login.text)

        resp = customer.post(
            "/api/persona_dashboard/personas/batch-delete",
            json={"persona_ids": ["persona-1"]},
        )

        self.assertEqual(resp.status_code, 404, resp.text)
        self.assertEqual(primary_path.read_text(encoding="utf-8"), before)

    def test_public_refresh_endpoint_returns_task_status(self):
        self._write_archives()
        with mock.patch.object(server, "_start_persona_dashboard_refresh", return_value={"id": "pdr_test", "status": "queued", "message": "queued"}):
            resp = self.client.post("/api/persona_dashboard/refresh", json={"archive_id": "persona-1"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["id"], "pdr_test")

    def test_create_persona_requires_auth_and_persists_archive(self):
        resp = self.client.post(
            "/api/persona_dashboard/personas",
            json={"name": "New Persona", "content": "New persona intro"},
        )
        self.assertEqual(resp.status_code, 200)
        profile = resp.json()
        self.assertEqual(profile["name"], "New Persona")
        self.assertEqual(profile["content"], "New persona intro")
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0]["name"], "New Persona")
        self.assertEqual(archives[0]["posts"], [])

    def test_persona_creation_rolls_back_json_when_owner_recording_fails(self):
        with mock.patch.object(
            server,
            "_record_persona_owner",
            side_effect=server.HTTPException(status_code=500, detail="owner write failed"),
        ):
            response = self.client.post(
                "/api/persona_dashboard/personas",
                json={"name": "Rollback Persona", "content": "Must not remain orphaned"},
            )

        self.assertEqual(response.status_code, 500, response.text)
        archives = server._read_tool_r18_persona_archives()[0]
        self.assertFalse(any(item.get("name") == "Rollback Persona" for item in archives))

    def test_group_creation_rolls_back_json_when_owner_recording_fails(self):
        with mock.patch.object(
            server,
            "_record_persona_group_owner",
            side_effect=server.HTTPException(status_code=500, detail="owner write failed"),
        ):
            response = self.client.post(
                "/api/persona_dashboard/groups",
                json={"name": "Rollback Group"},
            )

        self.assertEqual(response.status_code, 500, response.text)
        groups = server._read_persona_groups_config().get("groups") or []
        self.assertFalse(any(item.get("name") == "Rollback Group" for item in groups))

    def test_duplicate_persona_copies_shell_without_content_data(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        seeded_archives = json.loads(archives_path.read_text(encoding="utf-8"))
        seeded_archives[0]["setup"]["personaProfileAvatar"] = {
            "imageId": "img-1",
            "cropX": 40,
            "cropY": 60,
            "zoom": 1.2,
        }
        archives_path.write_text(json.dumps(seeded_archives), encoding="utf-8")
        resp = self.client.post("/api/persona_dashboard/personas/persona-1/duplicate")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        profile = body["profile"]
        self.assertNotEqual(profile["id"], "persona-1")
        self.assertEqual(profile["name"], "History Teacher 副本")
        self.assertEqual(profile["content"], "Persona intro for history topics.")
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertEqual(len(archives), 2)
        original, duplicate = archives
        self.assertEqual(original["id"], "persona-1")
        self.assertNotEqual(duplicate["id"], original["id"])
        self.assertEqual(duplicate["name"], "History Teacher 副本")
        self.assertEqual(duplicate["content"], original["content"])
        self.assertEqual(duplicate["setup"]["personaName"], "History Teacher 副本")
        self.assertNotIn("api_token", duplicate["setup"])
        self.assertEqual(duplicate["setup"]["accountManagement"], {"threads": {}})
        self.assertNotIn("hotMetrics", duplicate["setup"])
        self.assertNotIn("personaProfileAvatar", duplicate["setup"])
        self.assertEqual(duplicate["posts"], [])
        self.assertEqual(duplicate["platformPosts"], {"threads": [], "instagram": [], "telegram": []})
        self.assertEqual(duplicate["publishHistory"], [])
        self.assertEqual(duplicate["personaImageLibrary"], [])

    def test_persona_image_upload_creates_current_reference_for_follow_up_generation(self):
        self._write_archives()
        image_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        response = self.client.post(
            "/api/persona_dashboard/personas/persona-1/images/upload",
            files={"image": ("persona-front-view.png", image_bytes, "image/png")},
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["saved_item_id"])
        self.assertEqual(body["current_reference_url"], body["items"][0]["image_url"])
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        archive = archives[0]
        self.assertEqual(archive["personaReferenceSheet"], body["current_reference_url"])
        self.assertEqual(archive["setup"]["personaImageReferenceUrl"], body["current_reference_url"])
        self.assertEqual(server._persona_reference_image_url_from_archive(archive), body["current_reference_url"])
        uploaded = next(item for item in archive["personaImageLibrary"] if item["id"] == body["saved_item_id"])
        self.assertEqual(uploaded["source"], "manual-upload")
        self.assertIsNone(uploaded.get("mode"))

    def test_persona_image_upload_rejects_unsupported_format_and_oversize_file(self):
        self._write_archives()
        unsupported = self.client.post(
            "/api/persona_dashboard/personas/persona-1/images/upload",
            files={"image": ("persona.svg", b"<svg></svg>", "image/svg+xml")},
        )
        self.assertEqual(unsupported.status_code, 400, unsupported.text)

        old_limit = server.MAX_PERSONA_IMAGE_UPLOAD_BYTES
        try:
            server.MAX_PERSONA_IMAGE_UPLOAD_BYTES = 3
            oversized = self.client.post(
                "/api/persona_dashboard/personas/persona-1/images/upload",
                files={"image": ("persona.png", b"1234", "image/png")},
            )
        finally:
            server.MAX_PERSONA_IMAGE_UPLOAD_BYTES = old_limit
        self.assertEqual(oversized.status_code, 413, oversized.text)

    def test_persona_ai_keywords_calls_cli_and_returns_keywords(self):
        with mock.patch.object(
            server,
            "_run_persona_create_cli",
            return_value={"ok": True, "keywords": ["夜班司机", "城市见闻", "出租车故事", "深夜通勤", "城市观察"]},
        ) as cli_mock:
            resp = self.client.post(
                "/api/persona_dashboard/personas/ai_keywords",
                json={"name": "Night Driver", "prompt": "夜班出租车司机，分享夜间载客见闻和城市通勤观察。"},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["name"], "Night Driver")
        self.assertEqual(len(body["keywords"]), 5)
        cli_mock.assert_called_once()
        payload = cli_mock.call_args.args[0]
        self.assertEqual(payload["action"], "suggest-keywords")
        self.assertEqual(payload["personaName"], "Night Driver")

    def test_persona_ai_keywords_surfaces_cli_error_without_fallback_keywords(self):
        with mock.patch.object(
            server,
            "_run_persona_create_cli",
            side_effect=server.HTTPException(
                status_code=500,
                detail="关键词提炼失败：上游模型余额不足，请充值后重试。",
            ),
        ):
            resp = self.client.post(
                "/api/persona_dashboard/personas/ai_keywords",
                json={"name": "Night Driver", "prompt": "夜班出租车司机。"},
            )
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(resp.json()["detail"], "关键词提炼失败：上游模型余额不足，请充值后重试。")

    def test_persona_ai_keywords_rejects_incomplete_model_response(self):
        with mock.patch.object(
            server,
            "_run_persona_create_cli",
            return_value={"ok": True, "keywords": ["夜班司机", "城市见闻", "深夜通勤", "城市观察"]},
        ):
            resp = self.client.post(
                "/api/persona_dashboard/personas/ai_keywords",
                json={"name": "Night Driver", "prompt": "夜班出租车司机。"},
            )
        self.assertEqual(resp.status_code, 502)
        self.assertEqual(resp.json()["detail"], "关键词提炼失败：模型未返回 5 个有效关键词，请稍后重试。")

    def test_persona_ai_create_calls_cli_and_returns_profile(self):
        archives = [
            {
                "id": "persona-ai-1",
                "name": "Night Driver",
                "content": "一位夜班司机人设，擅长分享深夜通勤与城市观察。",
                "createdAt": "2026-07-05T00:00:00Z",
                "updatedAt": "2026-07-05T00:00:00Z",
                "setup": {
                    "personaName": "Night Driver",
                    "customTopic": "夜班出租车司机，分享夜间载客见闻和城市通勤观察。",
                    "stylePrompt": "口语化，带城市夜生活细节。",
                },
                "posts": [],
            }
        ]
        (self.tool_runtime_dir / "persona_archives.json").write_text(json.dumps(archives, ensure_ascii=False, indent=2), encoding="utf-8")
        with mock.patch.object(
            server,
            "_run_persona_create_cli",
            return_value={
                "ok": True,
                "archiveId": "persona-ai-1",
                "name": "Night Driver",
                "content": "一位夜班司机人设，擅长分享深夜通勤与城市观察。",
                "setup": {"personaName": "Night Driver", "customTopic": "夜班出租车司机，分享夜间载客见闻和城市通勤观察。"},
                "selectedKeywords": ["夜班司机", "城市见闻"],
            },
        ) as cli_mock:
            resp = self.client.post(
                "/api/persona_dashboard/personas/ai_create",
                json={
                    "name": "Night Driver",
                    "prompt": "夜班出租车司机，分享夜间载客见闻和城市通勤观察。",
                    "selected_keywords": ["夜班司机", "城市见闻"],
                },
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["selected_keywords"], ["夜班司机", "城市见闻"])
        self.assertEqual(body["profile"]["id"], "persona-ai-1")
        self.assertEqual(body["profile"]["name"], "Night Driver")
        cli_mock.assert_called_once()
        payload = cli_mock.call_args.args[0]
        self.assertEqual(payload["action"], "create-from-prompt")
        self.assertEqual(payload["selectedKeywords"], ["夜班司机", "城市见闻"])

    def test_create_persona_post_lists_draft(self):
        self._write_archives()
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Draft 1", "content": "This is the first draft"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        self.assertEqual(post["title"], "Draft 1")
        self.assertEqual(post["content"], "This is the first draft")
        list_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        self.assertEqual(list_resp.status_code, 200)
        posts = list_resp.json()["posts"]
        self.assertTrue(any(item["id"] == post["id"] for item in posts))
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        self.assertTrue(any(item["id"] == post["id"] for item in archives[0]["posts"]))

    def test_user_post_retention_prunes_oldest_history_across_owned_personas(self):
        self._write_archives()
        archive_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archive_path.read_text(encoding="utf-8"))
        archives.append({
            "id": "persona-2",
            "name": "Second persona",
            "content": "Second persona",
            "createdAt": "2026-06-25T00:00:00Z",
            "updatedAt": "2026-07-01T00:00:00Z",
            "posts": [],
            "publishHistory": [{
                "id": "pub-2",
                "archivePostId": "post-published-2",
                "title": "Newer history",
                "content": "Newer history",
                "publishedAt": "2026-07-01T00:00:00Z",
                "sourceMeta": {"archivePostSource": "posts"},
            }],
        })
        archives.append({
            "id": "persona-other-user",
            "name": "Other user",
            "content": "Other user",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "posts": [{
                "id": "other-old-post",
                "title": "Other",
                "content": "Must not be pruned",
                "createdAt": "2026-01-01T00:00:00Z",
            }],
            "publishHistory": [],
        })
        archive_path.write_text(json.dumps(archives), encoding="utf-8")
        self._assign_personas_to_admin(["persona-2"])

        with mock.patch.object(server, "PERSONA_USER_POST_LIMIT", 3):
            response = self.client.post(
                "/api/persona_dashboard/personas/persona-1/posts",
                json={"title": "Newest draft", "content": "Newest draft content"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        persisted = {
            archive["id"]: archive
            for archive in json.loads(archive_path.read_text(encoding="utf-8"))
        }
        self.assertEqual(persisted["persona-1"]["publishHistory"], [])
        self.assertEqual([item["id"] for item in persisted["persona-2"]["publishHistory"]], ["pub-2"])
        self.assertEqual(
            {item["id"] for item in persisted["persona-1"]["posts"]},
            {"post-1", response.json()["id"]},
        )
        self.assertEqual(
            [item["id"] for item in persisted["persona-other-user"]["posts"]],
            ["other-old-post"],
        )

    def test_create_persona_media_only_post_requires_explicit_media_intent(self):
        self._write_archives()
        allowed_media_path = self.draft_media_path.parent / "media-only.png"
        allowed_media_path.write_bytes(self.draft_media_path.read_bytes())

        empty_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "", "content": ""},
        )
        self.assertEqual(empty_resp.status_code, 400)
        bypass_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "", "content": "", "allow_empty_content": True},
        )
        self.assertEqual(bypass_resp.status_code, 400)

        media_only_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "", "content": "", "media_paths": [str(allowed_media_path)]},
        )
        self.assertEqual(media_only_resp.status_code, 200)
        post = media_only_resp.json()
        self.assertEqual(post["content"], "")
        self.assertEqual(post["title"], "")
        self.assertTrue(post["media_items"])

        update_resp = self.client.patch(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}",
            json={"title": "仅媒体草稿", "content": ""},
        )
        self.assertEqual(update_resp.status_code, 200)
        self.assertEqual(update_resp.json()["content"], "")

    def test_persona_post_title_is_blank_until_the_user_supplies_one(self):
        self._write_archives()
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"content": "正文不能被自动截取成标题"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        self.assertEqual(post["title"], "")

        update_resp = self.client.patch(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}",
            json={"content": "更新正文仍不生成标题"},
        )
        self.assertEqual(update_resp.status_code, 200)
        self.assertEqual(update_resp.json()["title"], "")

        titled_resp = self.client.patch(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}",
            json={"title": "用户填写的标题", "content": "更新正文仍不生成标题"},
        )
        self.assertEqual(titled_resp.status_code, 200)
        self.assertEqual(titled_resp.json()["title"], "用户填写的标题")

        outside_path = self.root / "outside-media.png"
        outside_path.write_bytes(self.draft_media_path.read_bytes())
        outside_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "", "content": "", "media_paths": [str(outside_path)]},
        )
        self.assertEqual(outside_resp.status_code, 404)

    def test_persona_draft_media_ops_are_atomic_when_final_content_is_empty(self):
        self._write_archives()
        patch_resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/posts/post-1",
            json={"title": "", "content": "", "media_ops": [{"type": "delete", "index": 0, "media_paths": []}]},
        )
        self.assertEqual(patch_resp.status_code, 400)

        list_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        post = next(item for item in list_resp.json()["posts"] if item["id"] == "post-1")
        self.assertTrue(post["media_items"])

    def test_persona_draft_media_move_persists_order_and_primary_media(self):
        self._write_archives()
        second_path = self.draft_media_path.parent / "ordered-second.png"
        third_path = self.draft_media_path.parent / "ordered-third.mp4"
        second_path.write_bytes(self.draft_media_path.read_bytes())
        third_path.write_bytes(b"video")

        append_resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/posts/post-1",
            json={
                "title": "A",
                "content": "post",
                "media_ops": [{
                    "type": "append",
                    "index": -1,
                    "media_paths": [str(second_path), str(third_path)],
                }],
            },
        )
        self.assertEqual(append_resp.status_code, 200, append_resp.text)

        move_resp = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/posts/post-1",
            json={
                "title": "A",
                "content": "post",
                "media_ops": [{
                    "type": "move",
                    "from_index": 2,
                    "to_index": 0,
                    "media_paths": [],
                }],
            },
        )
        self.assertEqual(move_resp.status_code, 200, move_resp.text)
        moved = move_resp.json()
        self.assertEqual(
            [item["url"] for item in moved["media_items"]],
            [str(third_path), str(self.draft_media_path), str(second_path)],
        )

        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        persisted = next(item for item in archives[0]["posts"] if item["id"] == "post-1")
        self.assertEqual([item["url"] for item in persisted["mediaItems"]], [
            str(third_path),
            str(self.draft_media_path),
            str(second_path),
        ])
        self.assertEqual(persisted["mediaUrl"], str(third_path))
        self.assertEqual(persisted["mediaType"], "video")
        self.assertNotIn("imageUrl", persisted)

    def test_persona_draft_media_ops_reject_paths_outside_current_user_directory(self):
        self._write_archives()
        other_user_dir = self.tool_runtime_dir / "other_user"
        other_user_dir.mkdir(parents=True, exist_ok=True)
        other_user_media = other_user_dir / "other.png"
        other_user_media.write_bytes(self.draft_media_path.read_bytes())

        response = self.client.patch(
            "/api/persona_dashboard/personas/persona-1/posts/post-1",
            json={
                "title": "Keep",
                "content": "Keep existing draft safe",
                "media_ops": [
                    {"type": "append", "media_paths": [str(other_user_media)]},
                ],
            },
        )

        self.assertEqual(response.status_code, 404, response.text)

    def test_persona_media_endpoint_rejects_legacy_path_outside_trusted_roots(self):
        self._write_archives()
        outside_path = self.root / "outside-secret.txt"
        outside_path.write_text("not dashboard media", encoding="utf-8")
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"].append({
            "id": "unsafe-media-post",
            "title": "Unsafe",
            "content": "Unsafe path",
            "mediaItems": [{"url": str(outside_path), "type": "image"}],
        })
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        media_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts/unsafe-media-post/media/0")
        self.assertEqual(media_resp.status_code, 404)

    def test_media_only_publish_history_record_is_visible(self):
        self.assertTrue(server._is_persona_publish_history_record({
            "automationTaskType": "publish_post",
            "content": "",
            "mediaItems": [{"url": str(self.draft_media_path), "type": "image"}],
        }))

    def test_persona_posts_hide_legacy_published_drafts(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"].append({
            "id": "legacy-published-1",
            "title": "Legacy published draft",
            "content": "Already published",
            "publishedAt": "2026-07-01T00:00:00Z",
        })
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        list_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")

        self.assertEqual(list_resp.status_code, 200)
        posts = list_resp.json()["posts"]
        self.assertFalse(any(item["id"] == "legacy-published-1" for item in posts))

    def test_persona_posts_include_media_and_preview_endpoint(self):
        self._write_archives()
        list_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        self.assertEqual(list_resp.status_code, 200)
        post = next(item for item in list_resp.json()["posts"] if item["id"] == "post-1")
        self.assertEqual(post["media_url"], str(self.draft_media_path))
        self.assertEqual(post["media_type"], "image")
        self.assertTrue(post["media_items"])
        media_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts/post-1/media/0")
        self.assertEqual(media_resp.status_code, 200)
        self.assertEqual(media_resp.headers["content-type"], "image/png")

    def test_task_submit_accepts_persona_post_image(self):
        self._write_archives()
        captured = {}

        def fake_enqueue(task_id, user_id, task_type, payload):
            captured["task_id"] = task_id
            captured["user_id"] = user_id
            captured["task_type"] = task_type
            captured["payload"] = payload

        with mock.patch.object(server, "_enqueue_task", side_effect=fake_enqueue):
            resp = self.client.post(
                "/api/tasks/submit",
                data={
                    "task_type": "persona_post_image",
                    "params_json": json.dumps(
                        {
                            "related_persona_id": "persona-1",
                            "related_post_id": "post-1",
                            "prompt": "请生成一张通勤风格的配图",
                            "generation_content": "手动输入的通勤配图正文",
                            "content_source_mode": "manual",
                            "image_count": 3,
                            "aspect_ratio": "1:1",
                        },
                        ensure_ascii=False,
                    ),
                },
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["task_type"], "persona_post_image")
        self.assertEqual(captured["task_type"], "persona_post_image")
        self.assertEqual(captured["payload"]["related_persona_id"], "persona-1")
        self.assertEqual(captured["payload"]["related_post_id"], "post-1")
        self.assertEqual(captured["payload"]["generation_content"], "手动输入的通勤配图正文")
        self.assertEqual(captured["payload"]["content_source_mode"], "manual")
        self.assertEqual(captured["payload"]["image_count"], 3)
        self.assertEqual(captured["payload"]["aspect_ratio"], "1:1")

    def test_task_submit_accepts_auto_persona_post_image_ratio(self):
        self._write_archives()
        captured = {}

        def fake_enqueue(task_id, user_id, task_type, payload):
            captured["payload"] = payload

        with mock.patch.object(server, "_enqueue_task", side_effect=fake_enqueue):
            resp = self.client.post(
                "/api/tasks/submit",
                data={
                    "task_type": "persona_post_image",
                    "params_json": json.dumps(
                        {
                            "related_persona_id": "persona-1",
                            "related_post_id": "post-1",
                            "generation_content": "一群人在宽阔海岸线上奔跑",
                            "aspect_ratio": "auto",
                            "aspect_ratio_resolved": "16:9",
                            "llm_base_url": "https://attacker.example",
                            "llm_api_key": "client-supplied-key",
                        },
                        ensure_ascii=False,
                    ),
                },
            )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(captured["payload"]["aspect_ratio"], "auto")
        self.assertNotIn("aspect_ratio_resolved", captured["payload"])
        self.assertNotIn("llm_base_url", captured["payload"])
        self.assertNotIn("llm_api_key", captured["payload"])

    def test_auto_persona_post_image_ratio_uses_tweet_and_prompt(self):
        captured = {}

        def fake_request(**kwargs):
            captured.update(kwargs)
            return (
                {"ok": True, "parsed": {"aspect_ratio": "16:9", "reason": "宽阔海岸与多人横向运动"}},
                {"model": "test-text-model"},
                [{"ok": True, "model": "test-text-model"}],
            )

        with mock.patch.object(server, "_request_llm_json_with_fallback", side_effect=fake_request):
            ratio, detail = server._resolve_persona_post_image_aspect_ratio(
                {"aspect_ratio": "auto"},
                tweet_content="一群人在宽阔海岸线上奔跑",
                custom_prompt="电影感远景构图",
            )

        self.assertEqual(ratio, "16:9")
        self.assertEqual(detail["mode"], "auto")
        self.assertEqual(detail["resolved"], "16:9")
        self.assertIn("一群人在宽阔海岸线上奔跑", captured["user_input"])
        self.assertIn("电影感远景构图", captured["user_input"])

    def test_auto_persona_post_image_ratio_ignores_client_llm_settings(self):
        captured = {}
        trusted_runtime = {
            "llm_base_url": "https://trusted.example",
            "llm_api_key_gpt": "server-key",
            "llm_default_model_gpt": "trusted-model",
        }

        def fake_request(**kwargs):
            captured.update(kwargs)
            return (
                {"ok": True, "parsed": {"aspect_ratio": "4:3", "reason": "横向环境构图"}},
                {"model": "trusted-model"},
                [{"ok": True, "model": "trusted-model"}],
            )

        with (
            mock.patch.object(server, "_get_runtime_config", return_value=trusted_runtime),
            mock.patch.object(server, "_request_llm_json_with_fallback", side_effect=fake_request),
        ):
            ratio, _ = server._resolve_persona_post_image_aspect_ratio(
                {
                    "aspect_ratio": "auto",
                    "llm_base_url": "https://attacker.example",
                    "llm_api_key": "client-supplied-key",
                    "llm_default_model": "attacker-model",
                },
                tweet_content="横向城市街景",
                custom_prompt="",
            )

        self.assertEqual(ratio, "4:3")
        self.assertEqual(captured["source"]["llm_base_url"], "https://trusted.example")
        self.assertEqual(captured["source"]["llm_api_key_gpt"], "server-key")
        self.assertNotEqual(captured["source"].get("llm_default_model"), "attacker-model")

    def test_auto_persona_post_image_ratio_reuses_cached_selection(self):
        with mock.patch.object(server, "_request_llm_json_with_fallback") as request_mock:
            ratio, detail = server._resolve_persona_post_image_aspect_ratio(
                {"aspect_ratio": "auto", "aspect_ratio_resolved": "3:4"},
                tweet_content="人物全身照",
                custom_prompt="生活方式场景",
            )

        self.assertEqual(ratio, "3:4")
        self.assertEqual(detail["mode"], "auto_cached")
        request_mock.assert_not_called()

    def test_auto_persona_post_image_ratio_fallback_hides_provider_error(self):
        with mock.patch.object(
            server,
            "_request_llm_json_with_fallback",
            side_effect=RuntimeError("internal-provider.example: secret upstream error"),
        ):
            ratio, detail = server._resolve_persona_post_image_aspect_ratio(
                {"aspect_ratio": "auto"},
                tweet_content="正文",
                custom_prompt="",
            )

        self.assertEqual(ratio, "1:1")
        self.assertEqual(detail["mode"], "auto_fallback")
        self.assertNotIn("error", detail)
        self.assertNotIn("attempts", detail)

    def test_task_submit_rejects_unknown_persona_post_image_ratio(self):
        self._write_archives()
        resp = self.client.post(
            "/api/tasks/submit",
            data={
                "task_type": "persona_post_image",
                "params_json": json.dumps(
                    {
                        "related_persona_id": "persona-1",
                        "related_post_id": "post-1",
                        "generation_content": "正文",
                        "aspect_ratio": "2:1",
                    },
                    ensure_ascii=False,
                ),
            },
        )

        self.assertEqual(resp.status_code, 400)
        self.assertIn("不支持的图像比例", resp.text)

    def test_retry_persona_post_image_reuses_resolved_auto_ratio(self):
        self._write_archives()
        task_id = "task-persona-post-image-retry"
        payload = {
            "related_persona_id": "persona-1",
            "related_post_id": "post-1",
            "generation_content": "正文",
            "aspect_ratio": "auto",
            "aspect_ratio_resolved": "16:9",
        }
        server._create_task_record(
            task_id,
            self._admin_user_id(),
            "persona_post_image",
            payload,
        )
        with server.db() as conn:
            conn.execute("UPDATE tasks SET status = 'failed' WHERE id = ?", (task_id,))
        captured = {}

        def fake_enqueue(new_task_id, user_id, task_type, retry_payload):
            captured["payload"] = retry_payload

        with mock.patch.object(server, "_enqueue_task", side_effect=fake_enqueue):
            resp = self.client.post(f"/api/tasks/{task_id}/retry")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(captured["payload"]["aspect_ratio"], "auto")
        self.assertEqual(captured["payload"]["aspect_ratio_resolved"], "16:9")

    def test_task_submit_limits_persona_post_image_to_four_outputs(self):
        self._write_archives()
        captured = {}

        def fake_enqueue(task_id, user_id, task_type, payload):
            captured["payload"] = payload

        with mock.patch.object(server, "_enqueue_task", side_effect=fake_enqueue):
            resp = self.client.post(
                "/api/tasks/submit",
                data={
                    "task_type": "persona_post_image",
                    "params_json": json.dumps(
                        {
                            "related_persona_id": "persona-1",
                            "related_post_id": "post-1",
                            "generation_content": "draft content",
                            "image_count": 8,
                        },
                    ),
                },
            )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(captured["payload"]["image_count"], 4)

    def test_persona_image_tasks_require_ownership_before_enqueue(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        unowned = json.loads(json.dumps(archives[0]))
        unowned["id"] = "persona-unowned"
        unowned["posts"][0]["id"] = "post-unowned"
        archives.append(unowned)
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        persona_image = self.client.post(
            "/api/tasks/submit",
            data={
                "task_type": "persona_image",
                "params_json": json.dumps({"related_persona_id": "persona-unowned"}),
            },
        )
        post_image = self.client.post(
            "/api/tasks/submit",
            data={
                "task_type": "persona_post_image",
                "params_json": json.dumps(
                    {
                        "related_persona_id": "persona-unowned",
                        "related_post_id": "post-unowned",
                        "prompt": "unowned",
                    }
                ),
            },
        )

        self.assertEqual(persona_image.status_code, 404, persona_image.text)
        self.assertEqual(post_image.status_code, 404, post_image.text)

    def test_persona_task_worker_revalidates_owner_before_runner_execution(self):
        self._write_archives()
        task_id = "task-owner-revalidation"
        user_id = self._admin_user_id()
        payload = {"related_persona_id": "persona-1"}
        server._create_task_record(task_id, user_id, "persona_image", payload)
        with server.db() as conn:
            conn.execute("DELETE FROM persona_owners WHERE archive_id = ?", ("persona-1",))

        runner = mock.Mock(return_value={"ok": True})
        with mock.patch.dict(server.TASK_RUNNERS, {"persona_image": runner}):
            server._task_worker(task_id, user_id, "persona_image", payload)

        runner.assert_not_called()
        with server.db() as conn:
            task = conn.execute("SELECT status, error FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(str(task["status"]), "failed")
        self.assertTrue(str(task["error"] or ""))

    def test_persona_post_image_runner_saves_local_preview_file(self):
        self._write_archives()
        task_id = "task-persona-post-image"
        payload = {
            "related_persona_id": "persona-1",
            "related_post_id": "post-1",
            "prompt": "请生成一张适合当前推文的通勤配图",
            "aspect_ratio": "auto",
            "generation_content": "手动输入正文",
            "image_count": 2,
        }
        server._create_task_record(task_id, self._admin_user_id(), "persona_post_image", payload)
        with server.db() as conn:
            conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (task_id,))
        data_url = "data:image/png;base64," + base64.b64encode(self.draft_media_path.read_bytes()).decode("ascii")
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "imageResult": {"url": data_url, "mode": "closed-person"},
                    "timings": {"provider": "test-provider"},
                },
                ensure_ascii=False,
            ),
            stderr="",
        )
        ratio_detail = {
            "mode": "auto",
            "requested": "auto",
            "resolved": "4:3",
            "reason": "环境叙事需要横向空间",
        }
        with (
            mock.patch.object(server, "_resolve_persona_post_image_aspect_ratio", return_value=("4:3", ratio_detail)),
            mock.patch.object(server.subprocess, "run", return_value=completed) as run_mock,
        ):
            result = server._run_persona_post_image_task(task_id, payload)
        self.assertTrue(result["ok"])
        self.assertEqual(result["image_count"], 2)
        self.assertEqual(len(result["image_paths"]), 2)
        self.assertEqual(run_mock.call_count, 2)
        cli_payload = json.loads(run_mock.call_args_list[0].args[0][-1])
        self.assertEqual(cli_payload["aspectRatio"], "4:3")
        self.assertEqual(result["aspect_ratio"], "4:3")
        self.assertEqual(result["aspect_ratio_selection"], ratio_detail)
        with server.db() as conn:
            stored_task = conn.execute("SELECT input_json FROM tasks WHERE id = ?", (task_id,)).fetchone()
        stored_payload = json.loads(stored_task["input_json"])
        self.assertEqual(stored_payload["aspect_ratio"], "auto")
        self.assertEqual(stored_payload["aspect_ratio_resolved"], "4:3")
        saved_path = Path(result["image_paths"][0])
        self.assertTrue(saved_path.is_file())
        self.assertEqual(saved_path.read_bytes(), self.draft_media_path.read_bytes())

    def test_persona_post_image_runner_generates_requested_images_concurrently(self):
        self._write_archives()
        task_id = "task-persona-post-image-concurrent"
        payload = {
            "related_persona_id": "persona-1",
            "related_post_id": "post-1",
            "generation_content": "concurrent image generation",
            "image_count": 4,
        }
        server._create_task_record(task_id, self._admin_user_id(), "persona_post_image", payload)
        with server.db() as conn:
            conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (task_id,))

        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps({
                "ok": True,
                "imageResult": {"url": "data:image/png;base64,AA=="},
                "timings": {"provider": "test-provider"},
            }),
            stderr="",
        )
        all_workers_started = threading.Barrier(4, timeout=2)

        def concurrent_run(*_args, **_kwargs):
            all_workers_started.wait()
            return completed

        def fake_persist(_task_id, _image_url, index):
            return str(self.data_dir / f"generated-{index}.png")

        with (
            mock.patch.object(server, "_resolve_persona_post_image_aspect_ratio", return_value=("1:1", {"mode": "fixed"})),
            mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"),
            mock.patch.object(server.subprocess, "run", side_effect=concurrent_run) as run_mock,
            mock.patch.object(server, "_persist_generated_image_for_task", side_effect=fake_persist),
        ):
            result = server._run_persona_post_image_task(task_id, payload)

        self.assertEqual(run_mock.call_count, 4)
        self.assertEqual(result["image_count"], 4)
        self.assertEqual(
            result["image_paths"],
            [str(self.data_dir / f"generated-{index}.png") for index in range(1, 5)],
        )
        self.assertEqual(
            [item["index"] for item in result["timings"]["stage_items"]],
            [1, 2, 3, 4],
        )

    def test_persona_post_image_runner_honors_shared_provider_limit(self):
        self._write_archives()
        task_id = "task-persona-post-image-limited"
        payload = {
            "related_persona_id": "persona-1",
            "related_post_id": "post-1",
            "generation_content": "limited concurrent image generation",
            "image_count": 4,
        }
        server._create_task_record(task_id, self._admin_user_id(), "persona_post_image", payload)
        with server.db() as conn:
            conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (task_id,))

        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps({"ok": True, "imageResult": {"url": "data:image/png;base64,AA=="}}),
            stderr="",
        )
        active = 0
        maximum_active = 0
        active_lock = threading.Lock()

        def limited_run(*_args, **_kwargs):
            nonlocal active, maximum_active
            with active_lock:
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.05)
            with active_lock:
                active -= 1
            return completed

        with (
            mock.patch.object(server, "_resolve_persona_post_image_aspect_ratio", return_value=("1:1", {"mode": "fixed"})),
            mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"),
            mock.patch.object(server, "_PERSONA_POST_IMAGE_SEMAPHORE", threading.BoundedSemaphore(2), create=True),
            mock.patch.object(server.subprocess, "run", side_effect=limited_run),
            mock.patch.object(server, "_persist_generated_image_for_task", side_effect=lambda task, url, index: f"{task}-{index}.png"),
        ):
            server._run_persona_post_image_task(task_id, payload)

        self.assertEqual(maximum_active, 2)

    def test_persona_post_image_runner_removes_partial_files_after_failure(self):
        self._write_archives()
        task_id = "task-persona-post-image-partial-failure"
        payload = {
            "related_persona_id": "persona-1",
            "related_post_id": "post-1",
            "generation_content": "partial failure image generation",
            "image_count": 2,
        }
        server._create_task_record(task_id, self._admin_user_id(), "persona_post_image", payload)
        with server.db() as conn:
            conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (task_id,))

        successful = mock.Mock(
            returncode=0,
            stdout=json.dumps({"ok": True, "imageResult": {"url": "data:image/png;base64,AA=="}}),
            stderr="",
        )
        failed = mock.Mock(returncode=1, stdout=json.dumps({"error": "provider failed"}), stderr="")
        call_count = 0
        call_lock = threading.Lock()
        both_started = threading.Barrier(2, timeout=2)

        def partially_failed_run(*_args, **_kwargs):
            nonlocal call_count
            with call_lock:
                call_count += 1
                current = call_count
            both_started.wait()
            return successful if current == 1 else failed

        media_root = self.data_dir / "persona_media_failure"
        with (
            mock.patch.object(server, "_resolve_persona_post_image_aspect_ratio", return_value=("1:1", {"mode": "fixed"})),
            mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"),
            mock.patch.object(server, "_persona_media_root", return_value=media_root),
            mock.patch.object(server.subprocess, "run", side_effect=partially_failed_run),
        ):
            with self.assertRaisesRegex(RuntimeError, "provider failed"):
                server._run_persona_post_image_task(task_id, payload)

        self.assertFalse((media_root / task_id).exists())

    def test_attach_persona_post_image_task_output_writes_back_to_post(self):
        self._write_archives()
        original_archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        original_post = next(item for item in original_archives[0]["posts"] if item["id"] == "post-1")
        original_title = original_post.get("title")
        original_content = original_post.get("content")
        task_id = "task-persona-post-image-attach"
        durable_root = self.data_dir / "persona_media"
        generated_path = durable_root / task_id / "generated-preview.png"
        generated_path.parent.mkdir(parents=True, exist_ok=True)
        generated_path.write_bytes(self.draft_media_path.read_bytes())
        server._create_task_record(
            task_id,
            self._admin_user_id(),
            "persona_post_image",
            {"related_persona_id": "persona-1", "related_post_id": "post-1"},
        )
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        conn.execute(
            "UPDATE tasks SET status = ?, output_json = ?, updated_at = ? WHERE id = ?",
            ("success", json.dumps({"image_paths": [str(generated_path)]}, ensure_ascii=False), 1_720_000_100, task_id),
        )
        conn.commit()
        conn.close()

        with (
            mock.patch.object(server, "DATA_DIR", self.data_dir),
            mock.patch.object(server, "_persona_media_root", return_value=durable_root),
        ):
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/posts/post-1/media/from_task",
                json={"task_id": task_id, "replace_existing": True},
            )
        self.assertEqual(resp.status_code, 200)
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        post = next(item for item in archives[0]["posts"] if item["id"] == "post-1")
        self.assertEqual(post.get("title"), original_title)
        self.assertEqual(post.get("content"), original_content)
        archived_path = Path(post["mediaItems"][0]["url"])
        self.assertTrue(archived_path.resolve().is_relative_to(durable_root.resolve()))
        self.assertTrue(archived_path.is_file())
        self.assertEqual(archived_path.read_bytes(), generated_path.read_bytes())

        with mock.patch.object(server, "DATA_DIR", self.data_dir):
            server._delete_task_artifacts(task_id)
            self.assertTrue(archived_path.is_file())
            media_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts/post-1/media/0")
        self.assertEqual(media_resp.status_code, 200)
        self.assertEqual(media_resp.content, self.draft_media_path.read_bytes())

    def test_attach_persona_post_image_task_only_writes_selected_outputs(self):
        self._write_archives()
        task_id = "task-persona-post-image-selected-attach"
        durable_root = self.data_dir / "persona_media"
        task_media_dir = durable_root / task_id
        task_media_dir.mkdir(parents=True, exist_ok=True)
        first_path = task_media_dir / "generated-first.png"
        second_path = task_media_dir / "generated-second.png"
        first_path.write_bytes(self.draft_media_path.read_bytes())
        second_path.write_bytes(self.draft_media_path.read_bytes())
        server._create_task_record(
            task_id,
            self._admin_user_id(),
            "persona_post_image",
            {"related_persona_id": "persona-1", "related_post_id": "post-1"},
        )
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        conn.execute(
            "UPDATE tasks SET status = ?, output_json = ?, updated_at = ? WHERE id = ?",
            (
                "success",
                json.dumps({"image_paths": [str(first_path), str(second_path)]}, ensure_ascii=False),
                1_720_000_101,
                task_id,
            ),
        )
        conn.commit()
        conn.close()

        with (
            mock.patch.object(server, "DATA_DIR", self.data_dir),
            mock.patch.object(server, "_persona_media_root", return_value=durable_root),
        ):
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/posts/post-1/media/from_task",
                json={"task_id": task_id, "replace_existing": True, "media_indexes": [1]},
            )
        self.assertEqual(resp.status_code, 200)
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        post = next(item for item in archives[0]["posts"] if item["id"] == "post-1")
        archived_paths = [Path(item["url"]) for item in post["mediaItems"]]
        self.assertEqual(len(archived_paths), 1)
        self.assertEqual(archived_paths[0].resolve(), second_path.resolve())
        self.assertNotEqual(archived_paths[0].resolve(), first_path.resolve())
        self.assertTrue(archived_paths[0].resolve().is_relative_to(durable_root.resolve()))
        self.assertTrue(archived_paths[0].is_file())
        self.assertEqual(archived_paths[0].read_bytes(), second_path.read_bytes())

    def test_persona_publish_history_lists_visible_records(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")
        self.assertEqual(resp.status_code, 200)
        rows = resp.json()["publish_history"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "pub-1")
        self.assertEqual(rows[0]["archive_post_id"], "post-1")
        self.assertEqual(rows[0]["platform"], "threads")
        self.assertTrue(rows[0]["media_items"])
        preview_item = next(item for item in rows[0]["media_items"] if "/publish_history/pub-1/media/" in str(item.get("preview_url") or ""))
        preview_path = str(preview_item["preview_url"])
        self.assertIn("/publish_history/pub-1/media/", preview_path)
        media_resp = self.client.get(preview_path)
        self.assertEqual(media_resp.status_code, 200)
        self.assertEqual(media_resp.headers["content-type"], "image/png")

    def test_persona_publish_history_marks_account_mismatch_only_when_current_handle_differs(self):
        self._write_archives()
        path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(path.read_text(encoding="utf-8"))
        archive = archives[0]
        archive["setup"]["accountManagement"]["threads"]["handle"] = "current_user"
        archive["publishHistory"][0]["publishedMeta"]["sourceUrl"] = "https://www.threads.com/@old_user/post/abc"
        path.write_text(json.dumps(archives), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")

        self.assertEqual(resp.status_code, 200)
        row = resp.json()["publish_history"][0]
        self.assertFalse(row["account_match"]["matches_current"])
        self.assertEqual(row["account_match"]["source_handle"], "old_user")
        self.assertEqual(row["account_match"]["current_handle"], "current_user")
        self.assertIn("@old_user", row["account_match"]["warning"])

    def test_instagram_publish_history_uses_bound_account_identity_for_mismatch(self):
        self._write_archives()
        self._insert_social_account(
            account_id="instagram-current",
            persona_id="persona-1",
            platform="instagram",
            username="current.ig",
        )
        path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(path.read_text(encoding="utf-8"))
        record = archives[0]["publishHistory"][0]
        record["platform"] = "instagram"
        record["publishedMeta"].update({
            "platform": "instagram",
            "accountId": "instagram-old",
            "username": "old.ig",
            "publishedUrl": "https://www.instagram.com/p/example/",
        })
        path.write_text(json.dumps(archives), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")

        self.assertEqual(resp.status_code, 200)
        row = resp.json()["publish_history"][0]
        self.assertEqual(row["account_id"], "instagram-old")
        self.assertEqual(row["account_username"], "old.ig")
        self.assertFalse(row["account_match"]["matches_current"])
        self.assertEqual(row["account_match"]["current_account_id"], "instagram-current")
        self.assertEqual(row["account_match"]["current_handle"], "current.ig")
        self.assertIn("@old.ig", row["account_match"]["warning"])

    def test_overview_exposes_hot_metric_account_id_for_current_account_filtering(self):
        self._write_archives()
        path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(path.read_text(encoding="utf-8"))
        archives[0]["setup"]["hotMetrics"]["threads"]["accountId"] = "threads-current"
        path.write_text(json.dumps(archives), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/overview")

        self.assertEqual(resp.status_code, 200)
        platform = resp.json()["personas"][0]["hot_platforms"][0]
        self.assertEqual(platform["account_id"], "threads-current")

    def test_publish_history_requeue_persists_media_in_both_archive_sources_and_platform_queues(self):
        self._write_archives()
        primary_path = self.tool_runtime_dir / "persona_archives.json"
        cache_path = self.tool_runtime_dir / "persona_archives_cache.json"
        cache_path.write_text(primary_path.read_text(encoding="utf-8"), encoding="utf-8")

        resp = self.client.post("/api/persona_dashboard/personas/persona-1/publish_history/pub-1/requeue")

        self.assertEqual(resp.status_code, 200)
        requeued = resp.json()["post"]
        self.assertEqual(requeued["content"], "post")
        requeued_media_urls = [item["url"] for item in requeued["media_items"]]
        self.assertEqual(requeued_media_urls[0], "https://example.com/publish-image.png")
        self.assertIn(str(self.draft_media_path), requeued_media_urls)

        for path in (primary_path, cache_path):
            archives = json.loads(path.read_text(encoding="utf-8"))
            archive = archives[0]
            stored = next(item for item in archive["posts"] if item["id"] == requeued["id"])
            stored_media_urls = [item["url"] for item in stored["mediaItems"]]
            self.assertEqual(stored_media_urls, requeued_media_urls)
            self.assertEqual(stored["mediaUrl"], "https://example.com/publish-image.png")
            self.assertEqual(stored["mediaType"], "image")
            self.assertEqual(stored["imageUrl"], "https://example.com/publish-image.png")
            for platform in ("threads", "telegram"):
                self.assertIn(requeued["id"], [item["id"] for item in archive["platformPosts"][platform]])

        refreshed = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        self.assertEqual(refreshed.status_code, 200)
        refreshed_post = next(item for item in refreshed.json()["posts"] if item["id"] == requeued["id"])
        self.assertEqual([item["url"] for item in refreshed_post["media_items"]], requeued_media_urls)

    def test_missing_media_is_retained_as_unavailable_item(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"][0]["mediaUrl"] = str(self.root / "missing-media.png")
        archives_path.write_text(json.dumps(archives, ensure_ascii=False, indent=2), encoding="utf-8")
        (self.tool_runtime_dir / "persona_archives_cache.json").write_text(
            json.dumps(archives, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        self.assertEqual(resp.status_code, 200)
        post = next(item for item in resp.json()["posts"] if item["id"] == "post-1")
        self.assertTrue(post["media_items"])
        self.assertTrue(post["media_items"][0]["unavailable"])
        self.assertEqual(post["media_items"][0]["reason"], "原始媒体文件不存在")
        self.assertEqual(post["media_items"][0]["preview_url"], "")

    def test_profile_photo_url_is_not_treated_as_post_media(self):
        from webapp import server

        rows = server._compact_dashboard_media_items({
            "mediaUrl": "https://scontent.example.com/v/t51.82787-19/profile.jpg",
            "mediaType": "image",
        })
        self.assertEqual(rows, [])

    def test_publish_history_excludes_automation_screenshots(self):
        from webapp import server

        row = server._compact_publish_record({
            "title": "Published post",
            "content": "Real published content",
            "screenshotUrl": "/data/automation/screenshots/publish_done_task-1.png",
            "mediaItems": [{"url": str(self.draft_media_path), "type": "image"}],
        })
        self.assertNotIn("screenshot_path", row)
        self.assertNotIn("screenshot_url", row)
        self.assertEqual([item["url"] for item in row["media_items"]], [str(self.draft_media_path)])

    def test_successful_publish_archive_does_not_store_execution_screenshot(self):
        task = {
            "id": "task-publish-1",
            "task_type": "publish_post",
            "platform": "threads",
            "account_id": "acct-1",
            "finished_at": 1_720_000_000,
        }
        account = {"platform": "threads", "username": "threads_user"}
        payload = {
            "caption": "Real published content",
            "archive_post_id": "post-1",
            "media_paths": [str(self.draft_media_path)],
        }
        result = {
            "url": "https://www.threads.net/@threads_user/post/example",
            "screenshot_path": "/data/automation/screenshots/publish_done_task-publish-1.png",
        }

        publish_record, post_record = social_automation_api._build_archive_sync_records(task, account, payload, result)

        self.assertNotIn("screenshotUrl", publish_record)
        self.assertNotIn("screenshotUrl", publish_record["publishedTargets"][0])
        self.assertIsNotNone(post_record)
        self.assertNotIn("screenshotUrl", post_record)
        self.assertEqual(post_record["mediaItems"][0]["url"], str(self.draft_media_path))

    def test_non_publish_task_is_not_synced_to_publish_history(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        before = json.loads(archives_path.read_text(encoding="utf-8"))[0]["publishHistory"]
        self._insert_social_account(account_id="acct-check", platform="threads", username="threads_user")
        self._insert_social_task(
            task_id="task-check-login",
            account_id="acct-check",
            platform="threads",
            task_type="check_login",
            payload={"caption": "This is not published content"},
        )

        social_automation_api._sync_successful_task_to_persona_archive(
            "task-check-login",
            {"screenshot_path": "/data/automation/screenshots/check_login.png"},
        )

        after = json.loads(archives_path.read_text(encoding="utf-8"))[0]["publishHistory"]
        self.assertEqual(after, before)

    def test_internal_media_proxy_urls_are_not_treated_as_raw_preview_urls(self):
        from webapp import server

        self.assertFalse(server._is_direct_preview_media_url("/api/persona_dashboard/personas/persona-1/posts/post-1/media/0"))
        self.assertFalse(server._is_direct_preview_media_url("/api/persona_dashboard/personas/persona-1/publish_history/pub-1/media/0"))
        self.assertFalse(server._is_direct_preview_media_url("/api/persona_dashboard/automation/screenshots/screenshot?sign=abc"))

    def test_media_fields_from_payload_keeps_multiple_media_items(self):
        payload = {
            "media_paths": [
                str(self.root / "first.png"),
                str(self.root / "second.mp4"),
            ]
        }
        fields = social_automation_api._media_fields_from_payload(payload)
        self.assertEqual(fields["mediaUrl"], str(self.root / "first.png"))
        self.assertEqual(fields["imageUrl"], str(self.root / "first.png"))
        self.assertEqual(len(fields["mediaItems"]), 2)
        self.assertEqual(fields["mediaItems"][0]["type"], "image")
        self.assertEqual(fields["mediaItems"][1]["type"], "video")

    def test_persona_memories_lists_runtime_entries(self):
        self._write_archives()
        (self.tool_runtime_dir / "persona_memory.json").write_text(json.dumps({
            "persona-1": [
                {"id": "mem-1", "date": "2026-07-04T10:00:00Z", "summary": "第一条记忆"},
                {"id": "mem-2", "date": "2026-07-03T10:00:00Z", "summary": "第二条记忆"},
            ]
        }), encoding="utf-8")
        resp = self.client.get("/api/persona_dashboard/personas/persona-1/memories")
        self.assertEqual(resp.status_code, 200)
        memories = resp.json()["memories"]
        self.assertEqual([item["id"] for item in memories[:2]], ["mem-1", "mem-2"])

    def test_persona_memory_create_persists_runtime_entry(self):
        self._write_archives()

        resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/memories",
            json={"summary": "新增的人设记忆"},
        )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["memory"]["summary"], "新增的人设记忆")
        self.assertEqual(body["memory"]["kind"], "consolidated")
        stored = json.loads((self.tool_runtime_dir / "persona_memory.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["persona-1"][0]["id"], body["memory"]["id"])

    def test_persona_memory_create_rejects_blank_content(self):
        self._write_archives()

        resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/memories",
            json={"summary": "   "},
        )

        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["detail"], "人设记忆内容不能为空。")

    def test_persona_memory_delete_removes_runtime_entry(self):
        self._write_archives()
        memory_path = self.tool_runtime_dir / "persona_memory.json"
        memory_path.write_text(json.dumps({
            "persona-1": [
                {"id": "mem-1", "date": "2026-07-04T10:00:00Z", "summary": "第一条记忆"},
                {"id": "mem-2", "date": "2026-07-03T10:00:00Z", "summary": "第二条记忆"},
            ]
        }, ensure_ascii=False), encoding="utf-8")

        resp = self.client.delete("/api/persona_dashboard/personas/persona-1/memories/mem-1")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([item["id"] for item in resp.json()["memories"]], ["mem-2", "archive-post-pub-1"])

        stored = json.loads(memory_path.read_text(encoding="utf-8"))
        self.assertEqual([item["id"] for item in stored["persona-1"]], ["mem-2"])

    def test_persona_memory_delete_hides_history_derived_entry(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["publishHistory"][0]["publishedMemory"] = "来自发布历史的记忆"
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        list_resp = self.client.get("/api/persona_dashboard/personas/persona-1/memories")
        self.assertEqual(list_resp.status_code, 200)
        self.assertEqual([item["id"] for item in list_resp.json()["memories"]], ["archive-post-pub-1"])

        delete_resp = self.client.delete("/api/persona_dashboard/personas/persona-1/memories/archive-post-pub-1")
        self.assertEqual(delete_resp.status_code, 200)
        self.assertEqual(delete_resp.json()["memories"], [])

        hidden = json.loads((self.tool_runtime_dir / "persona_dashboard_hidden_memories.json").read_text(encoding="utf-8"))
        self.assertEqual(hidden["persona-1"], ["archive-post-pub-1"])

        next_list_resp = self.client.get("/api/persona_dashboard/personas/persona-1/memories")
        self.assertEqual(next_list_resp.status_code, 200)
        self.assertEqual(next_list_resp.json()["memories"], [])

    def test_delete_favorite_removes_only_favorite_copy(self):
        self._write_archives()

        add_resp = self.client.post("/api/persona_dashboard/personas/persona-1/favorites/post-1")
        self.assertEqual(add_resp.status_code, 200)
        favorite_post_id = add_resp.json()["post"]["id"]

        delete_resp = self.client.delete(f"/api/persona_dashboard/personas/persona-1/favorites/{favorite_post_id}")
        self.assertEqual(delete_resp.status_code, 200)
        self.assertEqual(delete_resp.json()["favorites"], [])

        posts_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        self.assertEqual(posts_resp.status_code, 200)
        self.assertEqual([item["id"] for item in posts_resp.json()["posts"]], ["post-1"])

    def test_favorite_copy_preserves_the_source_numeric_title(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"][0]["title"] = "第5篇"
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

        add_resp = self.client.post("/api/persona_dashboard/personas/persona-1/favorites/post-1")
        self.assertEqual(add_resp.status_code, 200)
        self.assertEqual(add_resp.json()["post"]["title"], "第5篇")
        self.assertEqual(add_resp.json()["post"]["source_post_id"], "post-1")

        favorites_resp = self.client.get("/api/persona_dashboard/personas/persona-1/favorites")
        self.assertEqual(favorites_resp.status_code, 200)
        self.assertEqual(favorites_resp.json()["favorites"][0]["title"], "第5篇")

    def test_draft_and_favorite_keep_the_selected_content_platform(self):
        self._write_archives()

        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={
                "title": "Instagram draft",
                "content": "Instagram content",
                "platform": "instagram",
            },
        )

        self.assertEqual(create_resp.status_code, 200)
        created = create_resp.json()
        self.assertEqual(created["platform"], "instagram")

        favorite_resp = self.client.post(
            f"/api/persona_dashboard/personas/persona-1/favorites/{created['id']}"
        )
        self.assertEqual(favorite_resp.status_code, 200)
        self.assertEqual(favorite_resp.json()["post"]["platform"], "instagram")

        posts_resp = self.client.get("/api/persona_dashboard/personas/persona-1/posts")
        favorites_resp = self.client.get("/api/persona_dashboard/personas/persona-1/favorites")
        self.assertEqual(
            {item["id"]: item["platform"] for item in posts_resp.json()["posts"]},
            {"post-1": "threads", created["id"]: "instagram"},
        )
        self.assertEqual(favorites_resp.json()["favorites"][0]["platform"], "instagram")

    def test_run_persona_hot_workflow_cli_returns_success_result(self):
        process = mock.Mock()
        process.communicate.return_value = ('{"ok": true, "candidates": []}', "")
        process.returncode = 0

        with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
             mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
             mock.patch.object(server.subprocess, "Popen", return_value=process):
            result = server._run_persona_hot_workflow_cli({"action": "fetch-hot-candidates"}, timeout_seconds=45)

        self.assertEqual(result, {"ok": True, "candidates": []})
        communicate_timeout = process.communicate.call_args.kwargs["timeout"]
        self.assertGreater(communicate_timeout, 44)
        self.assertLessEqual(communicate_timeout, 45)

    def test_persona_hot_workflow_only_reserves_browser_for_browser_actions(self):
        self.assertTrue(server._persona_hot_workflow_uses_browser({"action": "fetch-hot-candidates"}))
        self.assertTrue(server._persona_hot_workflow_uses_browser({"action": "refresh-hot-post"}))
        self.assertFalse(server._persona_hot_workflow_uses_browser({"action": "pool-stats"}))
        self.assertFalse(server._persona_hot_workflow_uses_browser({"action": "import-hot-candidates"}))
        self.assertFalse(server._persona_hot_workflow_uses_browser({"action": "warm-hot-strategy"}))
        self.assertFalse(server._persona_hot_workflow_uses_browser({"action": "prepare-hot-keywords"}))

    def test_run_persona_hot_workflow_cli_does_not_lease_browser_for_import(self):
        process = mock.Mock()
        process.communicate.return_value = ('{"ok": true, "importedCount": 1}', "")
        process.returncode = 0

        with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
             mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
             mock.patch.object(server, "acquire_external_browser_lease") as acquire_lease, \
             mock.patch.object(server, "release_external_browser_lease") as release_lease, \
             mock.patch.object(server.subprocess, "Popen", return_value=process):
            result = server._run_persona_hot_workflow_cli(
                {"action": "import-hot-candidates", "archiveId": "persona-1"},
                timeout_seconds=45,
            )

        self.assertEqual(result, {"ok": True, "importedCount": 1})
        acquire_lease.assert_not_called()
        release_lease.assert_not_called()

    def test_run_persona_hot_workflow_cli_terminates_live_process_before_releasing_lease(self):
        process = mock.Mock(pid=1234)
        process.communicate.side_effect = RuntimeError("pipe read failed")
        process.poll.return_value = None
        events: list[str] = []

        with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
             mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
             mock.patch.object(server, "acquire_external_browser_lease", return_value="lease-1"), \
             mock.patch.object(
                 server,
                 "_terminate_persona_hot_process",
                 side_effect=lambda candidate: events.append("terminate") if candidate is process else None,
             ) as terminate, \
             mock.patch.object(
                 server,
                 "release_external_browser_lease",
                 side_effect=lambda _lease: events.append("release"),
             ) as release, \
             mock.patch.object(server.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "pipe read failed"):
                server._run_persona_hot_workflow_cli(
                    {"action": "fetch-hot-candidates", "archiveId": "persona-1"},
                    timeout_seconds=45,
                )

        terminate.assert_any_call(process)
        release.assert_called_once_with("lease-1")
        self.assertEqual(events, ["terminate", "release"])

    def test_run_persona_hot_workflow_cli_cleans_up_after_timeout(self):
        process = mock.Mock(pid=1234)
        process.communicate.side_effect = server.subprocess.TimeoutExpired(["node"], 30)
        process.wait.side_effect = [server.subprocess.TimeoutExpired(["node"], 2), 0]

        with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
             mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
             mock.patch.object(server.subprocess, "Popen", return_value=process), \
             mock.patch.object(server.os, "killpg", create=True) as killpg:
            with self.assertRaises(server.HTTPException) as raised:
                server._run_persona_hot_workflow_cli({"action": "fetch-hot-candidates"}, timeout_seconds=10)

        self.assertEqual(raised.exception.status_code, 504)
        communicate_timeout = process.communicate.call_args.kwargs["timeout"]
        self.assertGreater(communicate_timeout, 29)
        self.assertLessEqual(communicate_timeout, 30)
        process.wait.assert_has_calls([mock.call(timeout=2), mock.call(timeout=2)])
        if server.os.name == "nt":
            process.terminate.assert_called_once_with()
            process.kill.assert_called_once_with()
            killpg.assert_not_called()
        else:
            self.assertEqual(
                killpg.call_args_list,
                [mock.call(1234, server.signal.SIGTERM), mock.call(1234, server.signal.SIGKILL)],
            )

    def test_run_persona_hot_workflow_cli_limits_total_queue_wait_without_five_second_cutoff(self):
        run_lock = mock.Mock()
        run_lock.acquire.return_value = False

        with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
             mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
             mock.patch.object(server, "_PERSONA_HOT_RUN_LOCK", run_lock), \
             mock.patch.object(server.time, "monotonic", side_effect=[0, 0, 0, 0, 1, 1, 31]), \
             mock.patch.object(server.subprocess, "Popen") as popen:
            with self.assertRaises(server.HTTPException) as raised:
                server._run_persona_hot_workflow_cli(
                    {"action": "fetch-hot-candidates", "archiveId": "persona-1"},
                    timeout_seconds=120,
                )

        self.assertEqual(raised.exception.status_code, 504)
        self.assertIn("排队超过 30 秒", raised.exception.detail)
        self.assertGreater(run_lock.acquire.call_count, 1)
        self.assertTrue(all(
            0 < call.kwargs["timeout"] <= 0.25
            for call in run_lock.acquire.call_args_list
        ))
        popen.assert_not_called()

    def test_run_persona_hot_workflow_cli_rechecks_late_background_process(self):
        run_lock = mock.Mock()
        background_process = mock.Mock()
        workflow_process = mock.Mock()
        workflow_process.communicate.return_value = ('{"ok": true, "candidates": []}', "")
        workflow_process.returncode = 0
        previous_background = server._PERSONA_HOT_BACKGROUND_PROCESS

        def acquire_once_background_is_registered(*, timeout):
            if run_lock.acquire.call_count == 1:
                server._PERSONA_HOT_BACKGROUND_PROCESS = background_process
                return False
            return True

        run_lock.acquire.side_effect = acquire_once_background_is_registered
        try:
            with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
                 mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
                 mock.patch.object(server, "_PERSONA_HOT_RUN_LOCK", run_lock), \
                 mock.patch.object(server, "_terminate_persona_hot_process") as terminate, \
                 mock.patch.object(server.subprocess, "Popen", return_value=workflow_process):
                result = server._run_persona_hot_workflow_cli(
                    {"action": "fetch-hot-candidates", "archiveId": "persona-1"},
                    timeout_seconds=120,
                )
        finally:
            server._PERSONA_HOT_BACKGROUND_PROCESS = previous_background

        self.assertEqual(result, {"ok": True, "candidates": []})
        terminate.assert_any_call(background_process)
        self.assertEqual(run_lock.acquire.call_count, 2)

    def test_cancel_persona_hot_workflow_terminates_matching_process(self):
        process = mock.Mock()
        process.poll.return_value = None
        previous_process = server._PERSONA_HOT_INTERACTIVE_PROCESS
        previous_archive_id = server._PERSONA_HOT_INTERACTIVE_ARCHIVE_ID
        try:
            server._PERSONA_HOT_INTERACTIVE_PROCESS = process
            server._PERSONA_HOT_INTERACTIVE_ARCHIVE_ID = "persona-1"
            with mock.patch.object(server, "_terminate_persona_hot_process") as terminate:
                self.assertTrue(server._cancel_persona_hot_workflow("persona-1"))
                self.assertFalse(server._cancel_persona_hot_workflow("persona-2"))
            terminate.assert_called_once_with(process)
        finally:
            server._PERSONA_HOT_INTERACTIVE_PROCESS = previous_process
            server._PERSONA_HOT_INTERACTIVE_ARCHIVE_ID = previous_archive_id

    def test_rsshub_dashboard_refresh_does_not_reserve_browser_slot(self):
        task_id = "pdr_rsshub_test"
        process = mock.Mock()
        process.poll.return_value = 0
        process.returncode = 0
        process.wait.return_value = 0
        with server.PERSONA_DASHBOARD_REFRESH_LOCK:
            server.PERSONA_DASHBOARD_REFRESH_TASKS[task_id] = {
                "id": task_id,
                "status": "queued",
            }
        try:
            with mock.patch.object(server, "acquire_external_browser_lease") as acquire_lease, \
                 mock.patch.object(server, "release_external_browser_lease") as release_lease, \
                 mock.patch.object(server.subprocess, "Popen", return_value=process) as popen:
                server._persona_dashboard_refresh_worker_v2(
                    task_id,
                    source="rsshub",
                    archive_ids=[],
                )
        finally:
            with server.PERSONA_DASHBOARD_REFRESH_LOCK:
                server.PERSONA_DASHBOARD_REFRESH_TASKS.pop(task_id, None)

        popen.assert_called_once()
        acquire_lease.assert_not_called()
        release_lease.assert_not_called()

    def test_cancel_persona_hot_candidates_endpoint(self):
        self._write_archives()
        with mock.patch.object(server, "_cancel_persona_hot_candidate_tasks", return_value=False), mock.patch.object(server, "_cancel_persona_hot_workflow", return_value=True) as cancel:
            response = self.client.post("/api/persona_dashboard/personas/persona-1/hot_candidates/cancel")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "cancelled": True})
        cancel.assert_called_once_with("persona-1")

    def test_hot_candidate_task_endpoint_returns_before_worker_finishes(self):
        self._write_archives()
        fake_result = {
            "ok": True,
            "archive_name": "测试人设",
            "keywords": ["测试"],
            "search_mode": "strict",
            "freshness_days": 7,
            "freshness_policy": "strict",
            "cookie_statuses": [],
            "warnings": [],
            "candidates": [{"id": "hot-1", "content": "测试热点"}],
        }
        release_worker = threading.Event()

        def fetch_after_release(*_args, **_kwargs):
            release_worker.wait(timeout=1)
            return fake_result

        with mock.patch.object(server, "_fetch_persona_hot_candidates", side_effect=fetch_after_release):
            started = self.client.post(
                "/api/persona_dashboard/personas/persona-1/hot_candidates/tasks",
                json={"refresh": True, "limit": 10},
            )
            self.assertEqual(started.status_code, 200)
            task_id = started.json()["id"]
            self.assertIn(started.json()["status"], {"queued", "running"})
            release_worker.set()

            deadline = time.time() + 2
            status = {}
            while time.time() < deadline:
                response = self.client.get(
                    f"/api/persona_dashboard/personas/persona-1/hot_candidates/tasks/{task_id}"
                )
                self.assertEqual(response.status_code, 200)
                status = response.json()
                if status.get("status") == "success":
                    break
                time.sleep(0.01)

        self.assertEqual(status.get("status"), "success")
        self.assertEqual(status.get("result", {}).get("candidates", [])[0]["id"], "hot-1")

    def test_fetch_persona_hot_candidates_calls_hot_workflow_cli(self):
        self._write_archives()
        (self.tool_runtime_dir / "persona_memory.json").write_text(json.dumps({
            "persona-1": [
                {"id": "mem-1", "date": "2026-07-04T10:00:00Z", "summary": "记忆一"},
                {"id": "mem-2", "date": "2026-07-03T10:00:00Z", "summary": "记忆二"},
            ]
        }, ensure_ascii=False), encoding="utf-8")

        fake_result = {
            "ok": True,
            "archiveName": "History Teacher",
            "keywords": ["历史", "课堂"],
            "cookieStatuses": [{"platform": "threads", "message": "ok"}],
            "warnings": ["暂无 Instagram cookie"],
            "candidates": [
                {
                    "id": "hot-1",
                    "platform": "threads",
                    "sourceUrl": "https://www.threads.com/@history/post/1",
                    "author": "history",
                    "content": "完整热点正文",
                    "hotScore": 98,
                    "metrics": {"viewCount": 1000, "likeCount": 99, "commentCount": 12},
                    "capturedAt": "2026-07-06T10:00:00Z",
                    "media": [{"url": "https://example.com/hot.png", "type": "image"}],
                    "warnings": [],
                }
            ],
        }

        with mock.patch.object(server, "_run_persona_hot_workflow_cli", return_value=fake_result) as mocked:
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/hot_candidates",
                json={
                    "prompt": "抓取历史老师热点",
                    "refresh": True,
                    "limit": 6,
                    "freshness_days": 30,
                    "keywords": ["history", "teacher", "history"],
                    "selected_memory_ids": ["mem-1"],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["archive_name"], "History Teacher")
        self.assertEqual(body["keywords"], ["历史", "课堂"])
        self.assertEqual(body["freshness_days"], 15)
        self.assertEqual(body["candidates"][0]["candidate_id"], "hot-1")
        self.assertEqual(body["candidates"][0]["id"], "hot-1")
        self.assertEqual(body["candidates"][0]["full_content"], "完整热点正文")
        self.assertEqual(body["candidates"][0]["media_items"][0]["url"], "https://example.com/hot.png")
        payload = mocked.call_args.args[0]
        self.assertEqual(payload["action"], "fetch-hot-candidates")
        self.assertEqual(payload["archiveId"], "persona-1")
        self.assertEqual(payload["prompt"], "抓取历史老师热点")
        self.assertTrue(payload["refresh"])
        self.assertEqual(payload["limit"], 6)
        self.assertEqual(payload["searchMode"], "strict")
        self.assertEqual(payload["freshnessDays"], 15)
        self.assertEqual(payload["keywords"], ["history", "teacher"])
        self.assertEqual(payload["memorySummaries"], ["记忆一"])
        self.assertIs(payload["recordShown"], False)
        self.assertNotIn("forceLive", payload)
        self.assertNotIn("deferBackgroundRefresh", payload)

    def test_prepare_persona_hot_keywords_calls_hot_workflow_cli(self):
        self._write_archives()
        (self.tool_runtime_dir / "persona_memory.json").write_text(json.dumps({
            "persona-1": [
                {"id": "mem-1", "date": "2026-07-04T10:00:00Z", "summary": "memory one"},
                {"id": "mem-2", "date": "2026-07-03T10:00:00Z", "summary": "memory two"},
            ]
        }, ensure_ascii=False), encoding="utf-8")

        fake_result = {
            "ok": True,
            "archiveName": "History Teacher",
            "keywords": ["history", "teacher"],
            "searchMode": "normal",
            "warnings": [],
        }

        with mock.patch.object(server, "_run_persona_hot_workflow_cli", return_value=fake_result) as mocked:
            body = server._prepare_persona_hot_keywords(
                "persona-1",
                server.PersonaDashboardHotCandidatesFetchPayload(
                    prompt="prepare keywords",
                    search_mode="normal",
                    writing_locale="zh-CN",
                    selected_memory_ids=["mem-1"],
                ),
            )

        self.assertEqual(body["archive_name"], "History Teacher")
        self.assertEqual(body["keywords"], ["history", "teacher"])
        self.assertEqual(body["search_mode"], "normal")
        payload = mocked.call_args.args[0]
        self.assertEqual(payload["action"], "prepare-hot-keywords")
        self.assertEqual(payload["archiveId"], "persona-1")
        self.assertEqual(payload["prompt"], "prepare keywords")
        self.assertEqual(payload["searchMode"], "normal")
        self.assertEqual(payload["writingLocale"], "zh-CN")
        self.assertEqual(payload["memorySummaries"], ["memory one"])

    def test_hot_keyword_gateway_html_error_is_not_exposed(self):
        detail = server._normalize_persona_hot_workflow_error_detail(
            "<html><head><title>502 Bad Gateway</title></head></html>",
            action="prepare-hot-keywords",
        )

        self.assertEqual(detail, "热点关键词服务暂时不可用，请稍后重试。")

    def test_hot_candidate_normalization_keeps_every_media_item(self):
        media = [
            {"url": f"https://example.com/hot-{index}.png", "type": "image"}
            for index in range(1, 16)
        ]

        candidate = server._normalize_persona_hot_candidate({
            "id": "hot-many-media",
            "platform": "threads",
            "author": "history",
            "authorAvatar": "https://example.com/history-avatar.png",
            "content": "带完整媒体组的热点",
            "media": media,
        })

        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["author"], "history")
        self.assertEqual(candidate["author_avatar"], "https://example.com/history-avatar.png")
        self.assertEqual(
            [item["url"] for item in candidate["media_items"]],
            [item["url"] for item in media],
        )

    def test_fetch_persona_hot_candidates_uses_default_memories_without_web_params(self):
        self._write_archives()
        (self.tool_runtime_dir / "persona_memory.json").write_text(json.dumps({
            "persona-1": [
                {"id": f"mem-{index}", "date": f"2026-07-{index:02d}T10:00:00Z", "summary": f"记忆{index}"}
                for index in range(1, 11)
            ]
        }, ensure_ascii=False), encoding="utf-8")

        fake_result = {
            "ok": True,
            "archiveName": "History Teacher",
            "keywords": [],
            "cookieStatuses": [],
            "warnings": [],
            "candidates": [],
        }

        with mock.patch.object(server, "_run_persona_hot_workflow_cli", return_value=fake_result) as mocked:
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/hot_candidates",
                json={"refresh": False, "limit": 10},
            )

        self.assertEqual(resp.status_code, 200)
        payload = mocked.call_args.args[0]
        self.assertEqual(payload["prompt"], "")
        self.assertFalse(payload["refresh"])
        self.assertEqual(payload["limit"], 10)
        self.assertEqual(payload["memorySummaries"], [f"记忆{index}" for index in range(10, 2, -1)])

    def test_import_persona_hot_candidates_returns_hot_source_meta(self):
        self._write_archives()

        def fake_hot_import(payload, timeout_seconds=180):
            archives_path = self.tool_runtime_dir / "persona_archives.json"
            archives = json.loads(archives_path.read_text(encoding="utf-8"))
            archives[0]["posts"].append({
                "id": "hot-post-1",
                "title": "热点 #1",
                "content": "导入的热点正文",
                "wordCount": 6,
                "orderIndex": 2,
                "createdAt": "2026-07-06T11:00:00Z",
                "updatedAt": "2026-07-06T11:00:00Z",
                "mediaItems": [{"url": str(self.draft_media_path), "type": "image", "localPath": str(self.draft_media_path)}],
                "mediaUrl": str(self.draft_media_path),
                "mediaType": "image",
                "sourceMeta": {
                    "source": "sentiment_hot_import",
                    "platform": "threads",
                    "sourceUrl": "https://www.threads.com/@history/post/hot-1",
                    "metrics": {"viewCount": 888},
                    "engagement": {"likeCount": 66, "commentCount": 7},
                    "originalContent": "导入的热点正文",
                    "media": [{"url": "https://example.com/hot.png", "localPath": str(self.draft_media_path), "type": "image"}],
                    "mediaItems": [{"url": str(self.draft_media_path), "type": "image", "localPath": str(self.draft_media_path)}],
                    "originalMediaUrl": "https://example.com/hot.png",
                    "originalMediaUrls": ["https://example.com/hot.png"],
                    "warnings": [],
                },
            })
            archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")
            return {
                "ok": True,
                "archiveId": payload["archiveId"],
                "importedCount": 1,
                "posts": [{"id": "hot-post-1", "title": "热点 #1", "content": "导入的热点正文"}],
            }

        with mock.patch.object(server, "_run_persona_hot_workflow_cli", side_effect=fake_hot_import):
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/hot_candidates/import",
                json={
                    "platform": "instagram",
                    "candidates": [
                        {
                            "id": "hot-1",
                            "platform": "threads",
                            "sourceUrl": "https://www.threads.com/@history/post/hot-1",
                            "content": "导入的热点正文",
                            "media": [{"url": "https://example.com/hot.png", "type": "image"}],
                        }
                    ]
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["imported_count"], 1)
        self.assertEqual(body["posts"][0]["id"], "hot-post-1")
        self.assertTrue(body["posts"][0]["is_hot_imported"])
        self.assertEqual(body["posts"][0]["source_meta"]["source"], "sentiment_hot_import")
        self.assertEqual(body["posts"][0]["source_meta"]["source_url"], "https://www.threads.com/@history/post/hot-1")
        self.assertTrue(body["posts"][0]["source_meta"]["media_items"])
        self.assertEqual(body["posts"][0]["platform"], "instagram")

    def test_generate_persona_posts_archives_new_rows_under_selected_platform(self):
        self._write_archives()

        def fake_generate(payload):
            self.assertEqual(payload["platform"], "instagram")
            archives_path = self.tool_runtime_dir / "persona_archives.json"
            archives = json.loads(archives_path.read_text(encoding="utf-8"))
            archives[0]["posts"].append({
                "id": "post-instagram-1",
                "title": "Generated Instagram title",
                "content": "Generated Instagram content",
                "platform": payload["platform"],
                "wordCount": 27,
                "orderIndex": 1,
                "createdAt": "2026-07-04T12:00:00Z",
                "updatedAt": "2026-07-04T12:00:00Z",
            })
            archives_path.write_text(json.dumps(archives), encoding="utf-8")
            return {
                "ok": True,
                "postIds": ["post-instagram-1"],
                "generatedCount": 1,
                "selectedMemoryCount": 0,
            }

        with mock.patch.object(server, "_run_persona_workflow_cli", side_effect=fake_generate):
            result = server._generate_persona_archive_posts(
                "persona-1",
                server.PersonaDashboardGeneratePostsPayload(
                    count=1,
                    platform="instagram",
                ),
            )

        self.assertEqual(result["posts"][0]["platform"], "instagram")
        stored = json.loads(
            (self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8")
        )
        generated = next(
            post for post in stored[0]["posts"] if post["id"] == "post-instagram-1"
        )
        self.assertEqual(generated["platform"], "instagram")

    def test_ordinary_generation_candidates_stay_out_of_draft_library_until_selected(self):
        self._write_archives()

        def fake_generate(payload):
            self.assertEqual(payload["generationOperationId"], "ordinary-operation-1")
            self.assertTrue(payload["selectionRequired"])
            archives_path = self.tool_runtime_dir / "persona_archives.json"
            archives = json.loads(archives_path.read_text(encoding="utf-8"))
            for index in range(3):
                archives[0]["posts"].append({
                    "id": f"ordinary-candidate-{index + 1}",
                    "title": f"Candidate {index + 1}",
                    "content": f"Generated candidate {index + 1}",
                    "wordCount": 21,
                    "orderIndex": index + 1,
                    "createdAt": "2026-08-01T00:00:00Z",
                    "updatedAt": "2026-08-01T00:00:00Z",
                    "platform": "threads",
                    "generationOperationId": "ordinary-operation-1",
                    "generationCandidate": True,
                })
            archives_path.write_text(json.dumps(archives), encoding="utf-8")
            return {
                "ok": True,
                "postIds": [f"ordinary-candidate-{index + 1}" for index in range(3)],
                "generatedCount": 3,
                "selectedMemoryCount": 0,
            }

        payload = server.PersonaDashboardGeneratePostsPayload(
            count=3,
            platform="threads",
            selection_required=True,
        )
        with (
            mock.patch.object(server, "_run_persona_workflow_cli", side_effect=fake_generate),
            mock.patch.object(server, "_cleanup_stale_persona_generation_candidates", side_effect=AssertionError("hot-path cleanup")),
            mock.patch.object(
                server,
                "_write_persona_archives_preserving_shape",
                wraps=server._write_persona_archives_preserving_shape,
            ) as archive_write,
        ):
            result = server._generate_persona_archive_posts(
                "persona-1",
                payload,
                operation_id="ordinary-operation-1",
            )

        self.assertEqual(len(result["posts"]), 3)
        self.assertEqual(archive_write.call_count, 0)
        self.assertTrue(all(post["generation_candidate"] for post in result["posts"]))
        self.assertEqual(
            [post["id"] for post in server._list_persona_archive_posts("persona-1")],
            ["post-1"],
        )

        selected = result["posts"][1]
        server._update_persona_archive_post(
            "persona-1",
            selected["id"],
            server.PersonaDashboardDraftPostPayload(
                title=selected["title"],
                content=selected["content"],
                platform="threads",
            ),
        )
        visible_ids = [post["id"] for post in server._list_persona_archive_posts("persona-1")]
        self.assertEqual(visible_ids, ["ordinary-candidate-2", "post-1"])

    def test_generation_candidate_tagging_failure_does_not_leak_unresolved_posts(self):
        self._write_archives()
        generated_ids = {f"leaked-candidate-{index + 1}" for index in range(3)}

        def fake_generate(payload):
            archives_path = self.tool_runtime_dir / "persona_archives.json"
            archives = json.loads(archives_path.read_text(encoding="utf-8"))
            marked_in_initial_write = bool(payload.get("selectionRequired"))
            rows = []
            for post_id in sorted(generated_ids):
                row = {
                    "id": post_id,
                    "title": post_id,
                    "content": "generated",
                    "createdAt": "2026-08-01T00:00:00Z",
                    "updatedAt": "2026-08-01T00:00:00Z",
                }
                if marked_in_initial_write:
                    row["platform"] = "threads"
                    row["generationOperationId"] = "failed-operation-1"
                    row["generationCandidate"] = True
                rows.append(row)
            archives[0]["posts"].extend(rows)
            archives_path.write_text(json.dumps(archives), encoding="utf-8")
            return {"ok": True, "postIds": sorted(generated_ids), "generatedCount": 3}

        with (
            mock.patch.object(server, "_run_persona_workflow_cli", side_effect=fake_generate),
            mock.patch.object(server, "_set_persona_archive_posts_platform", side_effect=RuntimeError("tag write failed")),
        ):
            try:
                server._generate_persona_archive_posts(
                    "persona-1",
                    server.PersonaDashboardGeneratePostsPayload(
                        count=3,
                        platform="threads",
                        selection_required=True,
                    ),
                    operation_id="failed-operation-1",
                )
            except RuntimeError as error:
                self.assertEqual(str(error), "tag write failed")

        visible_ids = {
            str(post.get("id") or "")
            for post in server._list_persona_archive_posts("persona-1")
        }
        self.assertTrue(generated_ids.isdisjoint(visible_ids))

    def test_batch_generation_keeps_all_posts_without_candidate_markers(self):
        self._write_archives()

        def fake_generate(payload):
            self.assertFalse(payload.get("selectionRequired", False))
            archives_path = self.tool_runtime_dir / "persona_archives.json"
            archives = json.loads(archives_path.read_text(encoding="utf-8"))
            for index in range(3):
                archives[0]["posts"].append({
                    "id": f"batch-post-{index + 1}",
                    "title": f"Batch {index + 1}",
                    "content": f"Generated batch post {index + 1}",
                    "createdAt": "2026-08-01T00:00:00Z",
                    "updatedAt": "2026-08-01T00:00:00Z",
                    "platform": "threads",
                    "generationOperationId": "batch-operation-1",
                })
            archives_path.write_text(json.dumps(archives), encoding="utf-8")
            return {
                "ok": True,
                "postIds": [f"batch-post-{index + 1}" for index in range(3)],
                "generatedCount": 3,
            }

        with mock.patch.object(server, "_run_persona_workflow_cli", side_effect=fake_generate):
            result = server._generate_persona_archive_posts(
                "persona-1",
                server.PersonaDashboardGeneratePostsPayload(
                    count=3,
                    platform="threads",
                    selection_required=False,
                ),
                operation_id="batch-operation-1",
            )

        self.assertEqual(len(result["posts"]), 3)
        self.assertTrue(all(not post["generation_candidate"] for post in result["posts"]))
        visible_ids = [post["id"] for post in server._list_persona_archive_posts("persona-1")]
        self.assertTrue({"batch-post-1", "batch-post-2", "batch-post-3"}.issubset(visible_ids))

    def test_generation_candidates_are_finalized_atomically_and_idempotently(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        for index in range(3):
            candidate = {
                "id": f"candidate-{index + 1}",
                "title": f"Candidate {index + 1}",
                "content": f"Generated candidate {index + 1}",
                "createdAt": "2026-08-01T00:00:00Z",
                "updatedAt": "2026-08-01T00:00:00Z",
                "generationCandidate": True,
                "generationOperationId": "generation-op-1",
            }
            archives[0]["posts"].append(candidate)
            archives[0]["platformPosts"]["threads"].append(dict(candidate))
        archives_path.write_text(json.dumps(archives), encoding="utf-8")

        first = server._finalize_persona_generated_candidates(
            "persona-1",
            operation_id="generation-op-1",
            selected_post_id="candidate-2",
            title="Chosen candidate",
        )
        replay = server._finalize_persona_generated_candidates(
            "persona-1",
            operation_id="generation-op-1",
            selected_post_id="candidate-2",
            title="Chosen candidate",
        )

        self.assertEqual(first["selected_post"]["id"], "candidate-2")
        self.assertEqual(replay["selected_post"]["id"], "candidate-2")
        self.assertTrue(replay["replayed"])
        self.assertEqual(
            [post["id"] for post in server._list_persona_archive_posts("persona-1")],
            ["candidate-2", "post-1"],
        )
        stored = json.loads(archives_path.read_text(encoding="utf-8"))
        selected = next(post for post in stored[0]["posts"] if post["id"] == "candidate-2")
        self.assertEqual(selected["title"], "Chosen candidate")
        self.assertNotIn("generationCandidate", selected)
        platform_ids = [post["id"] for post in stored[0]["platformPosts"]["threads"]]
        self.assertNotIn("candidate-1", platform_ids)
        self.assertIn("candidate-2", platform_ids)
        self.assertNotIn("candidate-3", platform_ids)
        self.assertFalse((self.tool_runtime_dir / "persona_dashboard_deleted_posts.json").exists())

    def test_stale_generation_candidates_are_cleaned_without_removing_recent_candidates(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"].extend([
            {
                "id": "candidate-stale",
                "title": "Stale",
                "content": "Stale candidate",
                "createdAt": "2026-07-31T00:00:00Z",
                "updatedAt": "2026-07-31T00:00:00Z",
                "generationCandidate": True,
                "generationOperationId": "generation-old",
            },
            {
                "id": "candidate-recent",
                "title": "Recent",
                "content": "Recent candidate",
                "createdAt": "2026-08-01T00:30:00Z",
                "updatedAt": "2026-08-01T00:30:00Z",
                "generationCandidate": True,
                "generationOperationId": "generation-new",
            },
        ])
        archives_path.write_text(json.dumps(archives), encoding="utf-8")

        result = server._cleanup_stale_persona_generation_candidates(
            "persona-1",
            max_age_seconds=3600,
            now_ts=datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc).timestamp(),
        )

        self.assertEqual(result["removed_count"], 1)
        stored = json.loads(archives_path.read_text(encoding="utf-8"))
        stored_ids = [post["id"] for post in stored[0]["posts"]]
        self.assertNotIn("candidate-stale", stored_ids)
        self.assertIn("candidate-recent", stored_ids)

    def test_generation_candidate_resolution_endpoint_is_replay_safe_and_enforces_retention(self):
        self._write_archives()
        with mock.patch.object(server._TASK_QUEUE, "put"):
            accepted = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "candidate-resolution-endpoint-1"},
                json={"count": 3, "selection_required": True},
            )
        self.assertEqual(accepted.status_code, 202, accepted.text)
        task_id = accepted.json()["task_id"]
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        for index in range(3):
            archives[0]["posts"].append({
                "id": f"endpoint-candidate-{index + 1}",
                "title": f"Candidate {index + 1}",
                "content": f"Generated candidate {index + 1}",
                "createdAt": f"2026-08-01T00:0{index}:00Z",
                "updatedAt": f"2026-08-01T00:0{index}:00Z",
                "generationCandidate": True,
                "generationOperationId": task_id,
            })
        archives_path.write_text(json.dumps(archives), encoding="utf-8")
        output = {
            "ok": True,
            "generated_count": 3,
            "post_ids": [f"endpoint-candidate-{index + 1}" for index in range(3)],
        }
        with server.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = 'success', output_json = ? WHERE id = ?",
                (json.dumps(output), task_id),
            )

        with mock.patch.object(server, "PERSONA_USER_POST_LIMIT", 1):
            first = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/generate_posts/tasks/{task_id}/resolve",
                json={"selected_post_id": "endpoint-candidate-2", "title": "Selected"},
            )
            replay = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/generate_posts/tasks/{task_id}/resolve",
                json={"selected_post_id": "endpoint-candidate-2", "title": "Selected"},
            )

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(
            [post["id"] for post in server._list_persona_archive_posts("persona-1")],
            ["endpoint-candidate-2"],
        )

    def test_refresh_hot_post_returns_updated_source_metrics(self):
        self._write_archives()
        refreshed_post = {
            "id": "post-1",
            "title": "Draft 1",
            "content": "Draft content",
            "wordCount": 13,
            "orderIndex": 0,
            "createdAt": "2026-07-03T00:00:00Z",
            "updatedAt": "2026-07-11T01:02:03Z",
            "sourceMeta": {
                "source": "sentiment_hot_import",
                "platform": "threads",
                "sourceUrl": "https://www.threads.com/@history/post/hot-1",
                "hotScore": 987,
                "metrics": {"viewCount": 900},
                "engagement": {"likeCount": 70, "commentCount": 8},
                "capturedAt": "2026-07-11T01:02:03Z",
            },
        }
        fake_result = {"ok": True, "archiveId": "persona-1", "post": refreshed_post}
        with mock.patch.object(server, "_run_persona_hot_workflow_cli", return_value=fake_result) as mocked:
            resp = self.client.post("/api/persona_dashboard/personas/persona-1/posts/post-1/hot_metrics/refresh")

        self.assertEqual(resp.status_code, 200)
        post = resp.json()["post"]
        self.assertTrue(post["is_hot_imported"])
        self.assertEqual(post["source_meta"]["hot_score"], 987)
        self.assertEqual(post["source_meta"]["metrics"]["viewCount"], 900)
        self.assertEqual(post["source_meta"]["engagement"]["likeCount"], 70)
        payload = mocked.call_args.args[0]
        self.assertEqual(payload, {"action": "refresh-hot-post", "archiveId": "persona-1", "postId": "post-1"})

    def test_generate_persona_posts_runs_as_recoverable_idempotent_task(self):
        self._write_archives()

        def fake_generate(_archive_id, _payload, *, operation_id=""):
            archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
            archives[0]["posts"].append({
                "id": "post-new-1",
                "title": "Generated title",
                "content": "Generated content",
                "wordCount": 17,
                "orderIndex": 1,
                "createdAt": "2026-07-04T12:00:00Z",
                "updatedAt": "2026-07-04T12:00:00Z",
            })
            (self.tool_runtime_dir / "persona_archives.json").write_text(json.dumps(archives), encoding="utf-8")
            return {
                "ok": True,
                "persona_id": "persona-1",
                "generated_count": 1,
                "selected_memory_count": 1,
                "post_ids": ["post-new-1"],
                "posts": [{"id": "post-new-1", "title": "Generated title", "content": "Generated content"}],
            }

        with (
            mock.patch.object(server, "_generate_persona_archive_posts", side_effect=fake_generate) as mocked,
            mock.patch.object(server._TASK_QUEUE, "put") as queued,
        ):
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-test-0001"},
                json={
                    "count": 1,
                    "prompt": "围绕历史老师的通勤日常",
                    "target_words": 80,
                    "content_time_slot": "morning",
                    "selected_memory_ids": ["mem-1"],
                },
            )
            self.assertEqual(resp.status_code, 202)
            body = resp.json()
            task_id = body["task_id"]
            self.assertEqual(body["task"]["status"], "queued")
            self.assertFalse(body["replayed"])
            mocked.assert_not_called()
            queued.assert_called_once()

            queued_task_id, queued_user_id, queued_type, queued_payload = queued.call_args.args[0]
            self.assertEqual(queued_task_id, task_id)
            self.assertEqual(queued_user_id, self._admin_user_id())
            self.assertEqual(queued_type, "persona_post_generation")
            server._task_worker(task_id, queued_user_id, queued_type, queued_payload)

            status_resp = self.client.get(
                f"/api/persona_dashboard/personas/persona-1/generate_posts/tasks/{task_id}"
            )
            self.assertEqual(status_resp.status_code, 200)
            task = status_resp.json()["task"]
            self.assertEqual(task["status"], "success")
            self.assertEqual(task["output"]["generated_count"], 1)
            self.assertEqual(task["output"]["posts"][0]["id"], "post-new-1")

            replay = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-test-0001"},
                json={
                    "count": 1,
                    "prompt": "围绕历史老师的通勤日常",
                    "target_words": 80,
                    "content_time_slot": "morning",
                    "selected_memory_ids": ["mem-1"],
                },
            )
            self.assertEqual(replay.status_code, 202)
            self.assertEqual(replay.json()["task_id"], task_id)
            self.assertTrue(replay.json()["replayed"])

        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(mocked.call_args.args[0], "persona-1")
        self.assertEqual(mocked.call_args.args[1].prompt, "围绕历史老师的通勤日常")
        self.assertEqual(mocked.call_args.kwargs["operation_id"], task_id)

        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM tasks WHERE id = ?", (task_id,)).fetchone()[0],
                1,
            )
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM billing_reservations WHERE ref_type = 'normal_task' AND ref_id = ?",
                    (task_id,),
                ).fetchone()[0],
                1,
            )
        finally:
            conn.close()

    def test_generate_persona_posts_rejects_idempotency_key_reuse_with_changed_payload(self):
        self._write_archives()
        with mock.patch.object(server._TASK_QUEUE, "put"):
            first = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-test-0002"},
                json={"count": 1, "prompt": "first", "target_words": 80},
            )
            second = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-test-0002"},
                json={"count": 2, "prompt": "changed", "target_words": 80},
            )

        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["detail"]["code"], "IDEMPOTENCY_KEY_REUSED")

    def test_generate_persona_posts_rejects_different_request_while_same_persona_is_active(self):
        self._write_archives()
        with mock.patch.object(server._TASK_QUEUE, "put"):
            first = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-active-0001"},
                json={"count": 1, "prompt": "first", "target_words": 80},
            )
            second = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-active-0002"},
                json={"count": 2, "prompt": "different", "target_words": 100},
            )

        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["detail"]["code"], "PERSONA_GENERATION_IN_PROGRESS")
        self.assertEqual(second.json()["detail"]["task_id"], first.json()["task_id"])

    def test_generate_persona_posts_persists_alias_for_same_active_request(self):
        self._write_archives()
        payload = {"count": 1, "prompt": "same request", "target_words": 80}
        with mock.patch.object(server._TASK_QUEUE, "put"):
            first = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-primary-key"},
                json=payload,
            )
            alias = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-alias-key"},
                json=payload,
            )

            self.assertEqual(first.status_code, 202, first.text)
            self.assertEqual(alias.status_code, 202, alias.text)
            self.assertEqual(alias.json()["task_id"], first.json()["task_id"])
            self.assertTrue(alias.json()["replayed"])

            with server.db() as conn:
                conn.execute(
                    "UPDATE tasks SET status = 'success', output_json = ? WHERE id = ?",
                    (json.dumps({"ok": True, "generated_count": 1}), first.json()["task_id"]),
                )

            replay_after_completion = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-alias-key"},
                json=payload,
            )

        self.assertEqual(replay_after_completion.status_code, 202, replay_after_completion.text)
        self.assertEqual(replay_after_completion.json()["task_id"], first.json()["task_id"])
        self.assertTrue(replay_after_completion.json()["replayed"])

    def test_persona_post_generation_settles_only_actual_generated_count_once(self):
        self._write_archives()
        application = self.unauth_client.post("/api/auth/apply", json={
            "username": "persona_billing_user",
            "password": "guest123",
            "full_name": "Persona Billing User",
            "email": "persona-billing@example.com",
            "phone": "0912345678",
            "company": "Vecto Test",
            "use_case": "Persona generation billing regression",
        })
        self.assertEqual(application.status_code, 200, application.text)
        user_id = int(application.json()["id"])
        approval = self.client.post(
            f"/api/admin/users/{user_id}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approval.status_code, 200, approval.text)
        with server.db() as conn:
            conn.execute("UPDATE persona_owners SET user_id = ? WHERE archive_id = 'persona-1'", (user_id,))
            before_units = int(conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                (user_id,),
            ).fetchone()["credit_units"])
            unit_rate = int(server.commercial_billing.action_rate_units(conn, "basic_text_post")[0])

        customer = TestClient(self.app)
        try:
            login = customer.post(
                "/api/auth/user-login",
                json={"username": "persona_billing_user", "password": "guest123"},
            )
            self.assertEqual(login.status_code, 200, login.text)

            def fake_generate(_archive_id, _payload, *, operation_id=""):
                return {
                    "ok": True,
                    "persona_id": "persona-1",
                    "generated_count": 1,
                    "post_ids": ["post-billed-1"],
                    "posts": [{"id": "post-billed-1", "title": "Generated", "content": "One"}],
                }

            with (
                mock.patch.object(server, "_generate_persona_archive_posts", side_effect=fake_generate),
                mock.patch.object(server._TASK_QUEUE, "put") as queued,
            ):
                accepted = customer.post(
                    "/api/persona_dashboard/personas/persona-1/generate_posts",
                    headers={"Idempotency-Key": "persona-post-generation-billing-0001"},
                    json={"count": 3, "prompt": "bill actual output", "target_words": 80},
                )
                self.assertEqual(accepted.status_code, 202, accepted.text)
                task_id, queued_user_id, task_type, task_payload = queued.call_args.args[0]
                server._task_worker(task_id, queued_user_id, task_type, task_payload)
                replay = customer.post(
                    "/api/persona_dashboard/personas/persona-1/generate_posts",
                    headers={"Idempotency-Key": "persona-post-generation-billing-0001"},
                    json={"count": 3, "prompt": "bill actual output", "target_words": 80},
                )
                self.assertEqual(replay.status_code, 202, replay.text)
                self.assertTrue(replay.json()["replayed"])

            with server.db() as conn:
                after_units = int(conn.execute(
                    "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                    (user_id,),
                ).fetchone()["credit_units"])
                reservation = conn.execute(
                    "SELECT status, settled_credit_units FROM billing_reservations WHERE ref_id = ?",
                    (task_id,),
                ).fetchone()
            self.assertEqual(before_units - after_units, unit_rate)
            self.assertEqual(str(reservation["status"]), "settled")
            self.assertEqual(int(reservation["settled_credit_units"]), unit_rate)
        finally:
            customer.close()

    def test_restart_recovers_checkpointed_persona_post_generation_without_rerun(self):
        self._write_archives()
        with mock.patch.object(server._TASK_QUEUE, "put"):
            accepted = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-recovery-0001"},
                json={"count": 1, "prompt": "recover checkpoint", "target_words": 80},
            )
        self.assertEqual(accepted.status_code, 202, accepted.text)
        task_id = accepted.json()["task_id"]
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"].append({
            "id": "post-recovered-1",
            "title": "Recovered",
            "content": "Durable output",
            "generationOperationId": task_id,
        })
        archives_path.write_text(json.dumps(archives), encoding="utf-8")
        with server.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = 'running', output_json = ? WHERE id = ?",
                (json.dumps({
                    "ok": True,
                    "generated_count": 1,
                    "post_ids": ["post-recovered-1"],
                    "posts": [{"id": "post-recovered-1", "title": "Recovered", "content": "Durable output"}],
                }), task_id),
            )

        with mock.patch.object(server._TASK_QUEUE, "put") as queue_mock:
            server._resume_pending_tasks()

        queue_mock.assert_not_called()
        with server.db() as conn:
            task = conn.execute("SELECT status, output_json FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(str(task["status"]), "success")
        output = json.loads(task["output_json"])
        self.assertEqual(output["post_ids"], ["post-recovered-1"])
        self.assertIn("billing", output)

    def test_restart_recovers_operation_tagged_posts_without_task_checkpoint(self):
        self._write_archives()
        with mock.patch.object(server._TASK_QUEUE, "put"):
            accepted = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                headers={"Idempotency-Key": "persona-post-generation-operation-recovery"},
                json={"count": 1, "prompt": "recover durable operation", "target_words": 80},
            )
        self.assertEqual(accepted.status_code, 202, accepted.text)
        task_id = accepted.json()["task_id"]
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        archives[0]["posts"].append({
            "id": "post-operation-recovered-1",
            "title": "Recovered from operation marker",
            "content": "Durable output without task checkpoint",
            "generationOperationId": task_id,
            "platform": "threads",
        })
        archives_path.write_text(json.dumps(archives), encoding="utf-8")
        with server.db() as conn:
            conn.execute(
                "UPDATE tasks SET status = 'running', output_json = '{}' WHERE id = ?",
                (task_id,),
            )

        with mock.patch.object(server._TASK_QUEUE, "put") as queue_mock:
            server._resume_pending_tasks()

        queue_mock.assert_not_called()
        with server.db() as conn:
            task = conn.execute("SELECT status, output_json FROM tasks WHERE id = ?", (task_id,)).fetchone()
            reservation = conn.execute(
                "SELECT status FROM billing_reservations WHERE ref_id = ?",
                (task_id,),
            ).fetchone()
        self.assertEqual(str(task["status"]), "success")
        output = json.loads(task["output_json"])
        self.assertEqual(output["generated_count"], 1)
        self.assertEqual(output["post_ids"], ["post-operation-recovered-1"])
        self.assertEqual(output["posts"][0]["id"], "post-operation-recovered-1")
        self.assertIn(str(reservation["status"]), {"settled", "waived"})

    def test_generate_persona_posts_rejects_more_than_five_candidates(self):
        self._write_archives()
        with mock.patch.object(server, "_generate_persona_archive_posts") as mocked:
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                json={
                    "count": 6,
                    "prompt": "批量候选",
                    "target_words": 120,
                },
            )
        self.assertEqual(resp.status_code, 422)
        mocked.assert_not_called()

    def test_persona_workflow_syncs_runtime_llm_config_into_tool_api_config(self):
        runtime_payload = dict(server.DEFAULT_RUNTIME_CONFIG)
        runtime_payload.update({
            "llm_base_url": "http://llm.example",
            "llm_api_key": "key-123",
            "llm_api_key_gpt": "key-123",
            "llm_default_model": "xai/grok-4.3",
            "llm_default_model_gpt": "xai/grok-4.3",
            "llm_model_priority_order": "xai/grok-4.3, google/gemini-3.5-flash",
        })
        server._write_runtime_config_file(runtime_payload)
        (self.tool_runtime_dir / "api_config.json").write_text(json.dumps({
            "gptEndpoint": "http://old.example",
            "geminiTextEndpoint": "http://old.example",
            "llmFreeModelPriorityOrder": "stale/model",
            "llm_free_model_priority_order": "stale/model",
        }), encoding="utf-8")

        server._sync_tool_r18_api_config_for_persona_workflow()

        synced = json.loads((self.tool_runtime_dir / "api_config.json").read_text(encoding="utf-8"))
        self.assertEqual(synced["gptEndpoint"], "http://llm.example")
        self.assertEqual(synced["geminiTextEndpoint"], "http://llm.example")
        self.assertEqual(synced["gptKey"], "key-123")
        self.assertEqual(synced["geminiTextKey"], "key-123")
        self.assertEqual(synced["llmModelPriorityOrder"], "xai/grok-4.3, google/gemini-3.5-flash")
        self.assertEqual(synced["llmFreeModelPriorityOrder"], "xai/grok-4.3, google/gemini-3.5-flash")
        self.assertEqual(synced["llm_free_model_priority_order"], "xai/grok-4.3, google/gemini-3.5-flash")

    def test_publish_persona_post_creates_publish_task_with_archive_post_id(self):
        self._write_archives()
        self._insert_social_account()
        self._insert_social_task(account_id="acct-1", platform="instagram", task_type="check_login")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Draft publish", "content": "Publish me"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        media_path = self.draft_media_path.parent / "publish-media.png"
        media_path.write_bytes(self.draft_media_path.read_bytes())
        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-1", "task_type": "publish_post", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"media_paths": [str(media_path)]},
            )
        self.assertEqual(publish_resp.status_code, 200)
        payload_obj = mocked.call_args.args[0]
        self.assertEqual(payload_obj.persona_id, "persona-1")
        self.assertEqual(payload_obj.account_id, "acct-1")
        self.assertEqual(payload_obj.task_type, "publish_post")
        self.assertEqual(payload_obj.payload["archive_post_id"], post["id"])
        self.assertEqual(payload_obj.payload["archive_post_title"], "Draft publish")
        self.assertEqual(payload_obj.payload["caption"], "Publish me")
        self.assertEqual(payload_obj.payload["media_paths"], [str(media_path.resolve())])

    def test_publish_persona_post_uses_content_override_without_mutating_draft(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Draft publish", "content": "Original draft"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()

        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-link", "task_type": "publish_post", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={
                    "account_id": "acct-threads",
                    "platform": "threads",
                    "content_override": "Original draft\nRead more\nhttps://example.com/post",
                },
            )

        self.assertEqual(publish_resp.status_code, 200, publish_resp.text)
        payload_obj = mocked.call_args.args[0]
        self.assertEqual(payload_obj.payload["caption"], "Original draft\nRead more\nhttps://example.com/post")
        posts = self.client.get("/api/persona_dashboard/personas/persona-1/posts").json()["posts"]
        saved = next(item for item in posts if item["id"] == post["id"])
        self.assertEqual(saved["content"], "Original draft")

    def test_publish_persona_post_supports_threads_without_media(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user")
        self._insert_social_task(account_id="acct-threads", platform="threads", task_type="check_login")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Threads draft", "content": "Threads publish content"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-th", "task_type": "publish_post", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"account_id": "acct-threads", "platform": "threads", "media_paths": []},
            )
        self.assertEqual(publish_resp.status_code, 200)
        payload_obj = mocked.call_args.args[0]
        self.assertEqual(payload_obj.persona_id, "persona-1")
        self.assertEqual(payload_obj.account_id, "acct-threads")
        self.assertEqual(payload_obj.platform, "threads")
        self.assertEqual(payload_obj.task_type, "publish_post")
        self.assertEqual(payload_obj.payload["platform"], "threads")
        self.assertEqual(payload_obj.payload["archive_post_id"], post["id"])
        self.assertEqual(payload_obj.payload["caption"], "Threads publish content")
        self.assertEqual(payload_obj.payload["media_paths"], [])
        self.assertEqual(payload_obj.max_retries, 0)
        self.assertNotIn("publish_batch_id", payload_obj.payload)
        self.assertNotIn("publish_sequence_total", payload_obj.payload)

    def test_publish_persona_post_respects_zero_retries(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-no-retry", platform="threads", username="threads_user")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "No retry", "content": "Publish once"},
        )
        post = create_resp.json()

        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-once", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"account_id": "acct-no-retry", "platform": "threads", "max_retries": 0},
            )

        self.assertEqual(publish_resp.status_code, 200)
        self.assertEqual(mocked.call_args.args[0].max_retries, 0)

    def test_publish_persona_post_reuses_active_task_for_same_draft(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-idempotent", platform="threads", username="threads_user")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "One task", "content": "Do not duplicate"},
        )
        post = create_resp.json()
        self._insert_social_task(
            task_id="publish-existing",
            account_id="acct-idempotent",
            platform="threads",
            task_type="publish_post",
            status="running",
            payload={"archive_post_id": post["id"]},
        )

        with mock.patch.object(server, "create_social_task") as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"account_id": "acct-idempotent", "platform": "threads"},
            )

        self.assertEqual(publish_resp.status_code, 200)
        self.assertTrue(publish_resp.json()["reused"])
        self.assertEqual(publish_resp.json()["task"]["id"], "publish-existing")
        mocked.assert_not_called()

    def test_publish_persona_post_only_reuses_active_task_from_same_batch(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-batch", platform="threads", username="threads_user")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Batch task", "content": "Do not cross batches"},
        )
        post = create_resp.json()
        self._insert_social_task(
            task_id="publish-old-batch",
            account_id="acct-batch",
            platform="threads",
            task_type="publish_post",
            status="queued",
            payload={
                "archive_post_id": post["id"],
                "publish_batch_id": "batch-old",
            },
        )

        same_batch = self.client.post(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
            json={
                "account_id": "acct-batch",
                "platform": "threads",
                "publish_batch_id": "batch-old",
            },
        )
        different_batch = self.client.post(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
            json={
                "account_id": "acct-batch",
                "platform": "threads",
                "publish_batch_id": "batch-new",
            },
        )

        self.assertEqual(same_batch.status_code, 200)
        self.assertTrue(same_batch.json()["reused"])
        self.assertEqual(different_batch.status_code, 409)

    def test_publish_persona_post_supports_media_without_text(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-media", platform="threads", username="media_user")
        self._insert_social_task(account_id="acct-media", platform="threads", task_type="check_login")
        media_path = self.draft_media_path.parent / "publish-media-only.png"
        media_path.write_bytes(self.draft_media_path.read_bytes())
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Media only", "content": "", "media_paths": [str(media_path)]},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()

        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-media", "task_type": "publish_post", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"account_id": "acct-media", "platform": "threads", "media_paths": []},
            )

        self.assertEqual(publish_resp.status_code, 200)
        payload_obj = mocked.call_args.args[0]
        self.assertEqual(payload_obj.payload["caption"], "")
        self.assertEqual(payload_obj.payload["media_paths"], [str(media_path.resolve())])

    def test_publish_draft_post_sync_removes_source_post(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        draft_post = {
            "id": "draft-sync-1",
            "title": "Draft to publish",
            "content": "Draft publish content",
            "createdAt": "2026-07-01T00:00:00Z",
            "updatedAt": "2026-07-01T00:00:00Z",
        }
        archives[0]["posts"].append(draft_post)
        archives[0]["platformPosts"]["threads"].append({"id": "draft-sync-1", "content": "Draft publish content"})
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")
        self._insert_social_account(account_id="acct-draft", platform="threads", username="threads_user")
        self._insert_social_task(
            task_id="task-draft-publish",
            account_id="acct-draft",
            platform="threads",
            task_type="publish_post",
            payload={
                "archive_post_id": "draft-sync-1",
                "archive_post_title": "Draft to publish",
                "archive_post_source": "posts",
                "caption": "Draft publish content",
            },
        )

        social_automation_api._sync_successful_task_to_persona_archive(
            "task-draft-publish",
            {"url": "https://threads.example/draft-sync-1"},
        )

        synced = json.loads(archives_path.read_text(encoding="utf-8"))[0]
        self.assertFalse(any(post.get("id") == "draft-sync-1" for post in synced["posts"]))
        self.assertFalse(any(post.get("id") == "draft-sync-1" for post in synced["platformPosts"]["threads"]))
        self.assertEqual(synced["publishHistory"][0]["archivePostId"], "draft-sync-1")
        self.assertEqual(synced["publishHistory"][0]["publishedUrl"], "https://threads.example/draft-sync-1")

    def test_publish_favorite_post_sync_marks_favorite_not_source_post(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        source_post = dict(archives[0]["posts"][0])
        source_post.update({
            "id": "favorite-1",
            "title": "Favorite draft",
            "content": "Favorite publish content",
            "sourceMeta": {"favoriteSourcePostId": "post-1"},
        })
        source_post.pop("publishedAt", None)
        archives[0]["favoritePosts"] = [source_post]
        archives_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")
        self._insert_social_account(account_id="acct-fav", platform="threads", username="threads_user")
        self._insert_social_task(
            task_id="task-favorite-publish",
            account_id="acct-fav",
            platform="threads",
            task_type="publish_post",
            payload={
                "archive_post_id": "favorite-1",
                "archive_post_title": "Favorite draft",
                "archive_post_source": "favorites",
                "caption": "Favorite publish content",
            },
        )

        social_automation_api._sync_successful_task_to_persona_archive(
            "task-favorite-publish",
            {"url": "https://threads.example/favorite-1"},
        )

        synced = json.loads(archives_path.read_text(encoding="utf-8"))[0]
        favorite = synced["favoritePosts"][0]
        self.assertEqual(favorite["id"], "favorite-1")
        self.assertEqual(favorite["publishedUrl"], "https://threads.example/favorite-1")
        self.assertTrue(str(favorite.get("publishedAt") or "").strip())
        self.assertEqual(favorite["sourceMeta"]["archivePostSource"], "favorites")
        self.assertNotIn("publishedAt", synced["posts"][0])
        self.assertFalse(any(post.get("id") == "favorite-1" for post in synced["posts"]))
        self.assertEqual(synced["publishHistory"][0]["archivePostId"], "favorite-1")

    def test_publish_persona_post_checks_login_inside_publish_task_for_non_ready_account(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user", status="cookie_expired")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Threads draft", "content": "Threads publish content"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        created_tasks = []

        def fake_create_social_task(payload):
            created = {"id": f"sat-{len(created_tasks) + 1}", "task_type": payload.task_type, "status": "queued"}
            created_tasks.append((payload, created))
            return created

        with mock.patch.object(server, "create_social_task", side_effect=fake_create_social_task):
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"account_id": "acct-threads", "platform": "threads", "media_paths": []},
            )
        self.assertEqual(publish_resp.status_code, 200)
        self.assertEqual([payload.task_type for payload, _ in created_tasks], ["publish_post"])
        publish_payload = created_tasks[0][0]
        self.assertNotIn("auto_login_before_publish", publish_payload.payload)
        self.assertNotIn("login_task_id", publish_payload.payload)
        self.assertEqual(publish_payload.payload["archive_post_id"], post["id"])

    def test_publish_persona_post_does_not_require_manual_login_check(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Threads draft", "content": "Threads publish content"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-ready", "task_type": "publish_post", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"account_id": "acct-threads", "platform": "threads", "media_paths": []},
            )
        self.assertEqual(publish_resp.status_code, 200)
        payload_obj = mocked.call_args.args[0]
        self.assertEqual(payload_obj.task_type, "publish_post")
        self.assertNotIn("auto_login_before_publish", payload_obj.payload)
        self.assertNotIn("login_task_id", payload_obj.payload)
        self.assertEqual(payload_obj.payload["archive_post_id"], post["id"])

    def test_publish_task_waits_for_login_dependency_before_claim(self):
        now = int(datetime.now(timezone.utc).timestamp())
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user", status="cookie_expired")
        self._insert_social_task(
            task_id="login-needed",
            account_id="acct-threads",
            platform="threads",
            task_type="open_login",
            status="need_manual",
            priority=20,
            created_at=now,
        )
        self._insert_social_task(
            task_id="publish-waiting",
            account_id="acct-threads",
            platform="threads",
            task_type="publish_post",
            status="queued",
            priority=50,
            payload={
                "archive_post_id": "post-1",
                "auto_login_before_publish": True,
                "login_task_id": "login-needed",
            },
        )

        claimed = social_automation_api._claim_next_task()

        self.assertIsNone(claimed)
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            login_status = conn.execute("SELECT status FROM social_automation_tasks WHERE id = 'login-needed'").fetchone()[0]
            status = conn.execute("SELECT status FROM social_automation_tasks WHERE id = 'publish-waiting'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(login_status, "need_manual")
        self.assertEqual(status, "queued")

    def test_stale_orphaned_login_dependency_fails_instead_of_locking_queue(self):
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user", status="cookie_expired")
        self._insert_social_task(
            task_id="login-stale",
            account_id="acct-threads",
            platform="threads",
            task_type="open_login",
            status="need_manual",
            priority=20,
        )
        self._insert_social_task(
            task_id="publish-stale",
            account_id="acct-threads",
            platform="threads",
            task_type="publish_post",
            status="queued",
            priority=50,
            payload={
                "archive_post_id": "post-1",
                "auto_login_before_publish": True,
                "login_task_id": "login-stale",
            },
        )

        claimed = social_automation_api._claim_next_task()

        self.assertIsNone(claimed)
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        try:
            login_status = conn.execute("SELECT status FROM social_automation_tasks WHERE id = 'login-stale'").fetchone()[0]
            publish_status = conn.execute("SELECT status FROM social_automation_tasks WHERE id = 'publish-stale'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(login_status, "failed")
        self.assertEqual(publish_status, "failed")

    def test_publish_task_claims_after_login_dependency_succeeds(self):
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user", status="ready")
        self._insert_social_task(
            task_id="login-success",
            account_id="acct-threads",
            platform="threads",
            task_type="open_login",
            status="success",
            priority=20,
            result={"status": "ready", "diagnostic_outcome": "ready"},
        )
        self._insert_social_task(
            task_id="publish-ready",
            account_id="acct-threads",
            platform="threads",
            task_type="publish_post",
            status="queued",
            priority=50,
            payload={
                "archive_post_id": "post-1",
                "auto_login_before_publish": True,
                "login_task_id": "login-success",
            },
        )

        claimed = social_automation_api._claim_next_task()

        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["id"], "publish-ready")
        self.assertEqual(claimed["status"], "running")

    def test_public_delete_post_removes_metric_row(self):
        self._write_archives()
        overview = self.client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        post_key = persona["post_metrics"][0]["post_key"]
        resp = self.client.delete(f"/api/persona_dashboard/personas/persona-1/posts/{post_key}")
        self.assertEqual(resp.status_code, 200)
        self.assertGreaterEqual(resp.json()["deleted"], 1)
        deleted_posts = json.loads((self.tool_runtime_dir / "persona_dashboard_deleted_posts.json").read_text(encoding="utf-8"))
        self.assertIn(post_key, deleted_posts["persona-1"])
        next_overview = self.client.get("/api/persona_dashboard/overview").json()
        next_persona = next_overview["personas"][0]
        self.assertEqual(next_persona["post_metrics"], [])
        self.assertEqual(next_persona["hot"]["likes"], 0)
        self.assertEqual(next_persona["hot"]["post_views"], 0)

    def test_deleted_post_tombstone_filters_restored_metric_rows(self):
        self._write_archives()
        overview = self.client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        post_key = persona["post_metrics"][0]["post_key"]
        (self.tool_runtime_dir / "persona_dashboard_deleted_posts.json").write_text(
            json.dumps({"persona-1": [post_key]}),
            encoding="utf-8",
        )

        next_overview = self.client.get("/api/persona_dashboard/overview").json()
        next_persona = next_overview["personas"][0]
        self.assertEqual(next_persona["post_metrics"], [])
        self.assertEqual(next_persona["hot"]["likes"], 0)
        self.assertEqual(next_persona["hot"]["post_views"], 0)

    def test_threads_auto_reply_enriches_handle_and_comment_targets(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        archives[0].setdefault("setup", {}).setdefault("accountManagement", {}).setdefault("threads", {})["handle"] = "history_teacher"
        archives[0]["publishHistory"][0]["publishedAt"] = now_iso
        archives[0]["publishHistory"][0]["publishedUrl"] = "https://www.threads.net/@history/post/abc"
        archives[0]["publishHistory"][0].setdefault("publishedMeta", {})["capturedAt"] = now_iso
        archives[0]["setup"]["hotMetrics"]["threads"]["postMetrics"][0]["capturedAt"] = now_iso
        archives_path.write_text(json.dumps(archives), encoding="utf-8")
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user")

        resp = self.client.post(
            "/api/persona_dashboard/automation/tasks",
            json={
                "persona_id": "persona-1",
                "account_id": "acct-threads",
                "platform": "threads",
                "task_type": "threads_auto_reply",
                "priority": 50,
                "max_retries": 2,
                "payload": {"strategy_id": "comment_recent_7d"},
            },
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()["task"]["payload"]
        self.assertEqual(payload["threads_handle"], "history_teacher")
        self.assertEqual(payload["reply_scope"], "comments")
        self.assertTrue(payload["target_urls"])
        self.assertIn("https://www.threads.net/@history/post/abc", payload["target_urls"])
        self.assertTrue(payload["target_summaries"])
        self.assertEqual(payload["persona_context"], "Persona intro for history topics.")
        self.assertEqual(payload["ai_retry_count"], 3)
        self.assertNotIn("reply_templates", payload)

    def test_threads_hot_reply_targets_use_legacy_metrics_and_skip_replied_posts(self):
        now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        archive = {
            "publishHistory": [
                {
                    "publishedUrl": "https://www.threads.com/@history/post/replied?x=1",
                    "publishedAt": now_iso,
                    "engagement": {"viewCount": 9000, "likeCount": 80},
                },
                {
                    "publishedUrl": "https://www.threads.net/@history/post/fresh/",
                    "publishedAt": now_iso,
                    "metrics": {"view_count": 1800, "comment_count": 12, "share_count": 4},
                },
            ],
            "setup": {
                "threadsOwnPostAutoReply": {
                    "repliedPosts": [{"url": "https://www.threads.net/@history/post/replied/"}],
                },
            },
        }

        targets = social_automation_api._collect_threads_hot_reply_targets(
            archive,
            max_age_days=7,
            min_views=1000,
            limit=5,
        )

        self.assertEqual([item["url"] for item in targets], ["https://www.threads.net/@history/post/fresh"])
        self.assertEqual(targets[0]["view_count"], 1800)
        self.assertEqual(targets[0]["heat"], 1816)

        comment_targets = social_automation_api._collect_threads_hot_reply_targets(
            archive,
            max_age_days=7,
            min_views=0,
            limit=5,
            exclude_replied=False,
        )
        self.assertIn(
            "https://www.threads.net/@history/post/replied",
            [item["url"] for item in comment_targets],
        )

    def test_threads_hot_reply_empty_target_list_is_refilled(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        history = archives[0]["publishHistory"][0]
        history["publishedUrl"] = "https://www.threads.com/@history/post/refill"
        history["publishedAt"] = now_iso
        history["publishedMeta"]["capturedAt"] = now_iso
        history["publishedMeta"]["engagement"]["viewCount"] = 2400
        archives_path.write_text(json.dumps(archives), encoding="utf-8")

        payload = social_automation_api._enrich_threads_task_payload(
            "persona-1",
            "threads_auto_reply",
            {
                "strategy_id": "hot_posts",
                "reply_scope": "hot_posts",
                "target_urls": [],
            },
        )

        self.assertIn("https://www.threads.net/@history/post/refill", payload["target_urls"])
        refill = next(
            item
            for item in payload["target_summaries"]
            if item["url"] == "https://www.threads.net/@history/post/refill"
        )
        self.assertEqual(refill["view_count"], 2400)

    def test_threads_reply_rejects_requested_urls_outside_persona_archive(self):
        now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        archive = {
            "publishHistory": [{
                "publishedUrl": "https://www.threads.com/@owner/post/allowed?source=web",
                "publishedAt": now_iso,
                "content": "owned post",
            }],
            "setup": {},
        }
        with mock.patch.object(
            social_automation_api,
            "_load_persona_archive",
            return_value=archive,
        ):
            payload = social_automation_api._enrich_threads_task_payload(
                "persona-1",
                "threads_auto_reply",
                {
                    "strategy_id": "hot_posts",
                    "reply_scope": "hot_posts",
                    "target_urls": [
                        "https://www.threads.net/@stranger/post/external",
                        "https://www.threads.com/@owner/post/allowed?duplicate=1",
                    ],
                },
            )

        self.assertEqual(
            payload["target_urls"],
            ["https://www.threads.net/@owner/post/allowed"],
        )
        self.assertEqual(
            [item["url"] for item in payload["target_summaries"]],
            ["https://www.threads.net/@owner/post/allowed"],
        )

    def test_known_post_targets_round_trip_label_and_expected_text(self):
        now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        archive = {
            "setup": {
                "threadsOwnPostAutoReply": {
                    "knownPostTargets": [{
                        "url": "https://www.threads.net/@owner/post/known",
                        "label": "saved label",
                        "expectedText": "saved expected text",
                        "publishedAt": now_iso,
                    }],
                },
            },
        }

        targets = social_automation_api._collect_threads_hot_reply_targets(
            archive,
            max_age_days=7,
            min_views=0,
            limit=5,
            exclude_replied=False,
        )

        self.assertEqual(targets[0]["label"], "saved label")
        self.assertEqual(targets[0]["expected_text"], "saved expected text")

    def test_successful_hot_reply_writes_legacy_reply_history_once(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-hot", platform="threads", username="history")
        target_url = "https://www.threads.com/@history/post/hot-one?source=web"
        self._insert_social_task(
            task_id="task-hot-reply",
            account_id="acct-hot",
            platform="threads",
            task_type="threads_auto_reply",
            status="success",
            payload={
                "reply_scope": "hot_posts",
                "target_summaries": [{
                    "url": target_url,
                    "label": "history topic",
                    "view_count": 3200,
                    "published_at": 1_720_000_000,
                }],
            },
            result={
                "repliedUrls": [target_url],
                "repliedComments": [{
                    "url": target_url,
                    "replyText": "很值得继续讨论。",
                }],
            },
        )

        social_automation_api._sync_successful_task_to_persona_archive(
            "task-hot-reply",
            {
                "repliedUrls": [target_url],
                "repliedComments": [{
                    "url": target_url,
                    "replyText": "很值得继续讨论。",
                }],
            },
        )
        social_automation_api._sync_successful_task_to_persona_archive(
            "task-hot-reply",
            {
                "repliedUrls": [target_url],
                "repliedComments": [{
                    "url": target_url,
                    "replyText": "很值得继续讨论。",
                }],
            },
        )

        archive = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))[0]
        reply_state = archive["setup"]["threadsOwnPostAutoReply"]
        self.assertEqual(len(reply_state["repliedPosts"]), 1)
        self.assertEqual(reply_state["repliedPosts"][0]["url"], "https://www.threads.net/@history/post/hot-one")
        self.assertEqual(reply_state["repliedPosts"][0]["replyText"], "很值得继续讨论。")
        self.assertEqual(reply_state["knownPostTargets"][0]["viewCount"], 3200)

    def test_automation_tasks_include_account_identity_fields(self):
        self._insert_social_account(
            account_id="acct-threads",
            persona_id="persona-1",
            platform="threads",
            username="threads_user",
            status="ready",
        )
        self._insert_social_task(
            task_id="task-social-identity",
            account_id="acct-threads",
            persona_id="persona-1",
            platform="threads",
            task_type="check_login",
            status="success",
        )

        resp = self.client.get("/api/persona_dashboard/automation/tasks?limit=5")
        self.assertEqual(resp.status_code, 200)
        task = next(item for item in resp.json()["tasks"] if item["id"] == "task-social-identity")
        self.assertEqual(task["account_id"], "acct-threads")
        self.assertEqual(task["account_username"], "threads_user")
        self.assertEqual(task["account_display_name"], "threads_user")

    def test_publish_batch_logs_return_aggregate_task_and_full_members(self):
        self._insert_social_account(
            account_id="acct-publish-batch",
            persona_id="persona-1",
            platform="threads",
            username="batch_user",
            status="ready",
        )
        batch_id = "publish-batch-logs"
        self._insert_social_task(
            task_id="publish-batch-1",
            account_id="acct-publish-batch",
            persona_id="persona-1",
            platform="threads",
            task_type="publish_post",
            status="success",
            payload={
                "publish_batch_id": batch_id,
                "publish_sequence_index": 1,
                "publish_sequence_total": 2,
            },
            created_at=1_720_000_100,
        )
        self._insert_social_task(
            task_id="publish-batch-2",
            account_id="acct-publish-batch",
            persona_id="persona-1",
            platform="threads",
            task_type="publish_post",
            status="running",
            payload={
                "publish_batch_id": batch_id,
                "publish_sequence_index": 2,
                "publish_sequence_total": 2,
            },
            created_at=1_720_000_200,
        )
        self._insert_social_task(
            task_id="publish-other-batch",
            account_id="acct-publish-batch",
            persona_id="persona-1",
            platform="threads",
            task_type="publish_post",
            status="failed",
            payload={
                "publish_batch_id": "publish-batch-other",
                "publish_sequence_index": 1,
                "publish_sequence_total": 1,
            },
            created_at=1_720_000_300,
        )
        self._insert_social_task(
            task_id="publish-same-batch-other-persona",
            account_id="acct-publish-batch",
            persona_id="persona-2",
            platform="threads",
            task_type="publish_post",
            status="failed",
            payload={
                "publish_batch_id": batch_id,
                "publish_sequence_index": 3,
                "publish_sequence_total": 3,
            },
            created_at=1_720_000_250,
        )
        self._insert_social_task(
            task_id="publish-malformed-sequence",
            account_id="acct-publish-batch",
            persona_id="persona-1",
            platform="threads",
            task_type="publish_post",
            status="failed",
            payload={
                "publish_batch_id": "publish-malformed-batch",
                "publish_sequence_index": "bad",
                "publish_sequence_total": "bad",
            },
            created_at=1_720_000_275,
        )
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        conn.executemany(
            """
            INSERT INTO social_automation_logs(
              task_id, level, stage, message, data_json, screenshot_path, created_at
            ) VALUES (?, 'info', 'publish', ?, '{}', '', ?)
            """,
            [
                ("publish-batch-1", "first", 1_720_000_111),
                ("publish-batch-2", "second", 1_720_000_222),
                ("publish-same-batch-other-persona", "wrong persona", 1_720_000_250),
                ("publish-other-batch", "other", 1_720_000_333),
            ],
        )
        conn.commit()
        conn.close()

        resp = self.client.get("/api/persona_dashboard/automation/tasks/publish-batch-1/logs")
        second_resp = self.client.get("/api/persona_dashboard/automation/tasks/publish-batch-2/logs")
        malformed_resp = self.client.get(
            "/api/persona_dashboard/automation/tasks/publish-malformed-sequence/logs"
        )

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(second_resp.status_code, 200)
        self.assertEqual(malformed_resp.status_code, 200)
        self.assertEqual(
            malformed_resp.json()["batch_tasks"][0]["publish_sequence_index"],
            1,
        )
        self.assertEqual(
            malformed_resp.json()["batch_tasks"][0]["publish_sequence_total"],
            1,
        )
        second_data = second_resp.json()
        self.assertEqual([item["id"] for item in data["batch_tasks"]], ["publish-batch-1", "publish-batch-2"])
        self.assertEqual([item["status"] for item in data["batch_tasks"]], ["success", "running"])
        self.assertEqual([item["message"] for item in data["logs"]], ["first", "second"])
        self.assertEqual(data["task"]["id"], "publish-batch-1")
        self.assertEqual(data["task"]["status"], "running")
        self.assertEqual(data["task"]["batch_task_count"], 2)
        self.assertEqual(data["task"]["batch_task_ids"], ["publish-batch-1", "publish-batch-2"])
        self.assertEqual(
            [(item["publish_sequence_index"], item["publish_sequence_total"]) for item in data["batch_tasks"]],
            [(1, 2), (2, 2)],
        )
        self.assertEqual(second_data["task"], data["task"])
        self.assertEqual(second_data["logs"], data["logs"])

    def test_publish_batch_aggregate_uses_status_representative_result(self):
        aggregate = social_automation_api._aggregate_publish_batch_task([
            {
                "id": "publish-1",
                "status": "success",
                "created_at": 10,
                "updated_at": 20,
                "finished_at": 20,
                "result": {"published_url": "https://example.com/first"},
                "error": "",
            },
            {
                "id": "publish-2",
                "status": "failed",
                "created_at": 30,
                "updated_at": 40,
                "finished_at": 40,
                "result": {},
                "error": "second failed",
            },
        ])

        self.assertEqual(aggregate["id"], "publish-1")
        self.assertEqual(aggregate["status"], "failed")
        self.assertEqual(aggregate["result"], {})
        self.assertEqual(aggregate["error"], "second failed")

    def test_task_image_media_uses_cached_thumbnail_and_keeps_original_preview(self):
        task_id = "task-thumbnail-preview"
        source_path = self.root / "generated-result.png"
        Image.effect_noise((1600, 1200), 100).convert("RGB").save(source_path, format="PNG")
        with server.db() as conn:
            admin_id = int(conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()["id"])
            server._insert_task_record_in_transaction(
                conn,
                task_id,
                admin_id,
                "persona_post_image",
                {},
            )
            conn.execute(
                "UPDATE tasks SET status = 'success', output_json = ?, updated_at = ? WHERE id = ?",
                (
                    server._json_dumps({"image_paths": [str(source_path)]}),
                    server._now_ts(),
                    task_id,
                ),
            )

        thumbnail_root = self.data_dir / "outputs"
        with mock.patch.object(server, "OUTPUT_ROOT", thumbnail_root):
            detail_response = self.client.get(f"/api/tasks/{task_id}")
            self.assertEqual(detail_response.status_code, 200)
            media_item = detail_response.json()["media_items"][0]
            self.assertEqual(media_item["url"], f"/api/tasks/{task_id}/media/0")
            self.assertEqual(
                media_item["thumbnail_url"],
                f"/api/tasks/{task_id}/media/0/thumbnail",
            )

            thumbnail_response = self.client.get(media_item["thumbnail_url"])
            self.assertEqual(thumbnail_response.status_code, 200)
            self.assertEqual(thumbnail_response.headers["content-type"], "image/jpeg")
            self.assertIn("immutable", thumbnail_response.headers["cache-control"])
            with Image.open(BytesIO(thumbnail_response.content)) as thumbnail:
                self.assertLessEqual(thumbnail.width, 480)
                self.assertLessEqual(thumbnail.height, 480)
            self.assertLess(len(thumbnail_response.content), source_path.stat().st_size)

            cached_response = self.client.get(media_item["thumbnail_url"])
            self.assertEqual(cached_response.content, thumbnail_response.content)
            self.assertEqual(
                len(list((thumbnail_root / ".thumbnails" / task_id).glob("0-*.jpg"))),
                1,
            )

            original_response = self.client.get(media_item["url"])
            self.assertEqual(original_response.status_code, 200)
            self.assertIn("max-age=86400", original_response.headers["cache-control"])
            self.assertEqual(original_response.content, source_path.read_bytes())

    def test_persona_generation_instruction_uses_native_locale_writing_rules(self):
        japanese = server._build_persona_generate_instruction(
            server.PersonaDashboardGeneratePostsPayload(
                platform="threads",
                writing_locale="ja-JP",
                prompt="朝の仕事について",
            )
        )
        self.assertIn("Target writing locale: ja-JP (日本語).", japanese)
        self.assertIn("Compose natively for the selected locale", japanese)
        self.assertIn("翻訳調を避ける", japanese)

        fallback = server._build_persona_generate_instruction(
            server.PersonaDashboardGeneratePostsPayload(writing_locale="unsupported")
        )
        self.assertIn("Target writing locale: zh-TW (繁體中文).", fallback)
        self.assertIn("不套用簡體中文句式", fallback)

if __name__ == "__main__":
    unittest.main()
