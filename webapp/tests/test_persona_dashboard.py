import base64
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

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
            mock.patch.object(server, "_probe_threads_live_auth_with_browser", return_value={"ok": True, "status": "verified"}),
        ):
            state = server._sentiment_threads_live_auth_state(profile, cookies)

        self.assertTrue(state["liveAuthUsable"])
        self.assertEqual(state["liveAuthStatus"], "verified")
        self.assertEqual(state["liveAuthAction"], "keep")

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
        self.assertEqual(state["liveAuthMessage"], "sessionid 已保存，系统正在重新检测。")

    def test_expired_threads_sessionid_is_still_reported_as_saved(self):
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

        self.assertTrue(state["sessionidSaved"])
        self.assertFalse(state["hasRequiredSessionCookie"])
        self.assertEqual(state["cookieCount"], 1)
        self.assertEqual(state["validCookieCount"], 0)

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
        with mock.patch.object(server, "_start_persona_dashboard_refresh", return_value={"id": "pdr_test", "status": "queued", "message": "queued"}) as start:
            resp = self.client.post("/api/persona_dashboard/refresh", json={"archive_id": "persona-1", "source": "browser"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["id"], "pdr_test")
        start.assert_called_once_with(
            "persona-1",
            source="browser",
            archive_ids=["persona-1"],
            user_id=1,
        )

        invalid = self.client.post("/api/persona_dashboard/refresh", json={"archive_id": "persona-1", "source": "unknown"})
        self.assertEqual(invalid.status_code, 400)

    def test_full_refresh_reuses_identical_task_and_rejects_concurrent_scope(self):
        active = {
            "id": "pdr_active",
            "user_id": 1,
            "archive_id": "persona-1",
            "archive_ids": ["persona-1"],
            "source": "browser",
            "status": "running",
        }
        with server.PERSONA_DASHBOARD_REFRESH_LOCK:
            original = dict(server.PERSONA_DASHBOARD_REFRESH_TASKS)
            server.PERSONA_DASHBOARD_REFRESH_TASKS.clear()
            server.PERSONA_DASHBOARD_REFRESH_TASKS["pdr_active"] = dict(active)
        try:
            reused = server._start_persona_dashboard_refresh(
                "persona-1",
                source="browser",
                archive_ids=["persona-1"],
                user_id=1,
            )
            self.assertEqual(reused["id"], "pdr_active")
            with self.assertRaises(server.HTTPException) as raised:
                server._start_persona_dashboard_refresh(
                    "persona-2",
                    source="browser",
                    archive_ids=["persona-2"],
                    user_id=1,
                )
            self.assertEqual(raised.exception.status_code, 409)
        finally:
            with server.PERSONA_DASHBOARD_REFRESH_LOCK:
                server.PERSONA_DASHBOARD_REFRESH_TASKS.clear()
                server.PERSONA_DASHBOARD_REFRESH_TASKS.update(original)

    def test_daily_full_refresh_is_due_immediately_when_authenticated_data_is_stale(self):
        now = datetime(2026, 7, 17, 12, 0, tzinfo=timezone.utc).timestamp()
        stale_archive = {
            "id": "persona-1",
            "setup": {
                "accountManagement": {"threads": {"handle": "@history"}},
                "hotMetrics": {
                    "threads": {
                        "platform": "threads",
                        "scope": "authenticated_full_profile",
                        "refreshedAt": "2026-07-15T12:00:00Z",
                    }
                },
            },
        }
        fresh_archive = json.loads(json.dumps(stale_archive))
        fresh_archive["setup"]["hotMetrics"]["threads"]["refreshedAt"] = "2026-07-17T11:30:00Z"

        with mock.patch.object(server, "_read_tool_r18_persona_archives", return_value=([stale_archive], {})):
            self.assertEqual(server._persona_dashboard_monitor_initial_delay(86400, "browser", now), 0)
        with mock.patch.object(server, "_read_tool_r18_persona_archives", return_value=([fresh_archive], {})):
            delay = server._persona_dashboard_monitor_initial_delay(86400, "browser", now)
        self.assertEqual(delay, 84600)

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(server._persona_dashboard_monitor_enabled())
            self.assertEqual(server._persona_dashboard_monitor_interval_seconds(), 86400)
            self.assertEqual(server._persona_dashboard_monitor_source(), "browser")

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
        self.assertTrue(post["title"].startswith("媒体草稿 #"))
        self.assertTrue(post["media_items"])

        update_resp = self.client.patch(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}",
            json={"title": "仅媒体草稿", "content": ""},
        )
        self.assertEqual(update_resp.status_code, 200)
        self.assertEqual(update_resp.json()["content"], "")

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
            "aspect_ratio": "1:1",
            "generation_content": "手动输入正文",
            "image_count": 2,
        }
        server._create_task_record(task_id, self._admin_user_id(), "persona_post_image", payload)
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
        with mock.patch.object(server.subprocess, "run", return_value=completed) as run_mock:
            result = server._run_persona_post_image_task(task_id, payload)
        self.assertTrue(result["ok"])
        self.assertEqual(result["image_count"], 2)
        self.assertEqual(len(result["image_paths"]), 2)
        self.assertEqual(run_mock.call_count, 2)
        saved_path = Path(result["image_paths"][0])
        self.assertTrue(saved_path.is_file())
        self.assertEqual(saved_path.read_bytes(), self.draft_media_path.read_bytes())

    def test_attach_persona_post_image_task_output_writes_back_to_post(self):
        self._write_archives()
        generated_path = self.tool_runtime_dir / "generated-preview.png"
        generated_path.write_bytes(self.draft_media_path.read_bytes())
        task_id = "task-persona-post-image-attach"
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

        resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts/post-1/media/from_task",
            json={"task_id": task_id, "replace_existing": True},
        )
        self.assertEqual(resp.status_code, 200)
        archives = json.loads((self.tool_runtime_dir / "persona_archives.json").read_text(encoding="utf-8"))
        post = next(item for item in archives[0]["posts"] if item["id"] == "post-1")
        self.assertEqual(post["mediaItems"][0]["url"], str(generated_path))

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

    def test_persona_publish_history_merges_full_hot_metrics_by_published_url(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        record = archives[0]["publishHistory"][0]
        record["publishedUrl"] = "https://www.threads.net/@history/post/abc/?utm_source=console"
        platform_metrics = archives[0]["setup"]["hotMetrics"]["threads"]
        platform_metrics.update({
            "method": "browser",
            "scope": "authenticated_full_profile",
            "refreshedAt": "2026-07-17T01:02:03Z",
            "complete": True,
        })
        platform_metrics["postMetrics"][0]["repostCount"] = 4
        archives_path.write_text(json.dumps(archives), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")

        self.assertEqual(resp.status_code, 200)
        row = resp.json()["publish_history"][0]
        self.assertEqual(row["source_url"], record["publishedUrl"])
        self.assertEqual(row["likes"], 10)
        self.assertEqual(row["comments"], 5)
        self.assertEqual(row["shares"], 2)
        self.assertEqual(row["reposts"], 4)
        self.assertEqual(row["views"], 300)
        self.assertEqual(row["hot_score"], 321)
        self.assertEqual(
            row["hot_metrics"],
            {
                "hot_score": 321,
                "likes": 10,
                "comments": 5,
                "shares": 2,
                "reposts": 4,
                "views": 300,
                "refreshed_at": "2026-06-30T01:00:00Z",
                "complete": True,
                "matched": True,
                "stale": False,
                "source": "browser",
                "scope": "authenticated_full_profile",
            },
        )

    def test_persona_publish_history_uses_content_fallback_and_marks_snapshot_stale(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        record = archives[0]["publishHistory"][0]
        record["content"] = "A unique published sentence that can be matched safely."
        hot_metrics = archives[0]["setup"]["hotMetrics"]["threads"]
        hot_metrics.update({
            "method": "rsshub",
            "scope": "rsshub_feed_monitor",
            "refreshedAt": "2026-07-17T01:02:03Z",
            "complete": True,
        })
        hot_metrics["postMetrics"][0].update({
            "sourceUrl": "https://www.threads.com/@history/post/content-only",
            "content": record["content"],
        })
        archives_path.write_text(json.dumps(archives), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")

        self.assertEqual(resp.status_code, 200)
        metrics = resp.json()["publish_history"][0]["hot_metrics"]
        self.assertTrue(metrics["matched"])
        self.assertFalse(metrics["complete"])
        self.assertTrue(metrics["stale"])
        self.assertEqual(metrics["scope"], "rsshub_feed_monitor")

        archives[0]["publishHistory"][0]["content"] = "No matching published content."
        archives_path.write_text(json.dumps(archives), encoding="utf-8")
        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")
        row = resp.json()["publish_history"][0]
        self.assertFalse(row["hot_metrics"]["matched"])
        self.assertTrue(row["hot_metrics"]["stale"])
        self.assertEqual(row["likes"], 3)
        self.assertEqual(row["comments"], 1)
        self.assertEqual(row["views"], 40)

    def test_persona_publish_history_does_not_guess_between_duplicate_content_rows(self):
        self._write_archives()
        archives_path = self.tool_runtime_dir / "persona_archives.json"
        archives = json.loads(archives_path.read_text(encoding="utf-8"))
        record = archives[0]["publishHistory"][0]
        record["content"] = "The same reusable published sentence appears twice."
        record.pop("publishedUrl", None)
        record["publishedMeta"] = {
            "likeCount": 3,
            "commentCount": 1,
            "viewCount": 40,
        }
        hot_metrics = archives[0]["setup"]["hotMetrics"]["threads"]
        first = dict(hot_metrics["postMetrics"][0])
        first.update({
            "sourceUrl": "https://www.threads.com/@history/post/duplicate-1",
            "content": record["content"],
        })
        second = dict(first)
        second["sourceUrl"] = "https://www.threads.com/@history/post/duplicate-2"
        second["likeCount"] = 999
        hot_metrics["postMetrics"] = [first, second]
        archives_path.write_text(json.dumps(archives), encoding="utf-8")

        resp = self.client.get("/api/persona_dashboard/personas/persona-1/publish_history")

        self.assertEqual(resp.status_code, 200)
        row = resp.json()["publish_history"][0]
        self.assertFalse(row["hot_metrics"]["matched"])
        self.assertEqual(row["likes"], 3)

    def test_publish_history_rejects_non_https_source_urls(self):
        self.assertEqual(
            server._published_record_url({"publishedUrl": "javascript:alert(1)"}),
            "",
        )
        self.assertEqual(
            server._published_record_url({"publishedUrl": "https://www.threads.com/@safe/post/1"}),
            "https://www.threads.com/@safe/post/1",
        )

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

    def test_run_persona_hot_workflow_cli_returns_success_result(self):
        process = mock.Mock()
        process.communicate.return_value = ('{"ok": true, "candidates": []}', "")
        process.returncode = 0

        with mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"), \
             mock.patch.object(server, "_tool_r18_node_command", return_value=["node", "persona-hot-workflow.ts"]), \
             mock.patch.object(server.subprocess, "Popen", return_value=process):
            result = server._run_persona_hot_workflow_cli({"action": "fetch-hot-candidates"}, timeout_seconds=45)

        self.assertEqual(result, {"ok": True, "candidates": []})
        process.communicate.assert_called_once_with(timeout=45)

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
        process.communicate.assert_called_once_with(timeout=30)
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

    def test_persona_hot_pool_worker_refills_only_low_mode(self):
        server._PERSONA_HOT_POOL_ATTEMPTS.clear()
        server._PERSONA_HOT_WARM_PENDING.clear()
        server._PERSONA_HOT_POOL_REFILLING.clear()
        server._PERSONA_HOT_POOL_COUNTS.clear()
        server._PERSONA_HOT_POOL_STRATEGY_READY.clear()
        server._PERSONA_HOT_WARM_ATTEMPTS.clear()
        server._PERSONA_HOT_POOL_CURSOR = 0
        server._PERSONA_HOT_LAST_INTERACTIVE_AT = 0.0
        workflow_results = [
            {
                "ok": True,
                "pools": [
                    {"archiveId": "persona-new", "searchMode": "normal", "readyCount": 25},
                    {"archiveId": "persona-new", "searchMode": "strict", "readyCount": 0},
                ],
            },
            {"ok": True, "candidates": []},
        ]

        with mock.patch.object(server._PERSONA_HOT_POOL_STOP, "is_set", side_effect=[False, False, True]), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "wait", return_value=False), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "clear"), \
             mock.patch.object(server, "_persona_hot_pool_worker_enabled", return_value=True), \
             mock.patch.object(server, "_persona_hot_pool_resources_available", return_value=True), \
             mock.patch.object(server, "_read_tool_r18_persona_archives", return_value=([{"id": "persona-new"}], {})), \
             mock.patch.object(server, "_run_persona_hot_workflow_cli", side_effect=workflow_results) as run_workflow:
            server._persona_hot_pool_worker_loop()

        self.assertEqual(run_workflow.call_count, 2)
        self.assertEqual(run_workflow.call_args_list[0].args[0], {"action": "pool-stats", "archiveIds": ["persona-new"]})
        self.assertEqual(run_workflow.call_args_list[1].args[0], {
            "action": "fetch-hot-candidates",
            "archiveId": "persona-new",
            "limit": 10,
            "refresh": True,
            "searchMode": "strict",
        })
        self.assertTrue(run_workflow.call_args_list[1].kwargs["background"])

    def test_persona_hot_pool_worker_continues_refill_until_target(self):
        server._PERSONA_HOT_POOL_ATTEMPTS.clear()
        server._PERSONA_HOT_WARM_PENDING.clear()
        server._PERSONA_HOT_POOL_REFILLING.clear()
        server._PERSONA_HOT_POOL_COUNTS.clear()
        server._PERSONA_HOT_POOL_STRATEGY_READY.clear()
        server._PERSONA_HOT_WARM_ATTEMPTS.clear()
        server._PERSONA_HOT_POOL_CURSOR = 0
        server._PERSONA_HOT_POOL_REFILLING.add("persona-new:strict")
        server._PERSONA_HOT_LAST_INTERACTIVE_AT = 0.0
        workflow_results = [
            {
                "ok": True,
                "pools": [
                    {"archiveId": "persona-new", "searchMode": "normal", "readyCount": 100, "strategyReady": True},
                    {"archiveId": "persona-new", "searchMode": "strict", "readyCount": 80, "strategyReady": True},
                ],
            },
            {"ok": True, "candidates": []},
        ]

        with mock.patch.object(server._PERSONA_HOT_POOL_STOP, "is_set", side_effect=[False, False, True]), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "wait", return_value=False), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "clear"), \
             mock.patch.object(server, "_persona_hot_pool_worker_enabled", return_value=True), \
             mock.patch.object(server, "_persona_hot_pool_resources_available", return_value=True), \
             mock.patch.object(server, "_read_tool_r18_persona_archives", return_value=([{"id": "persona-new"}], {})), \
             mock.patch.object(server, "_run_persona_hot_workflow_cli", side_effect=workflow_results) as run_workflow:
            server._persona_hot_pool_worker_loop()

        self.assertEqual(run_workflow.call_count, 2)
        self.assertEqual(run_workflow.call_args_list[1].args[0]["searchMode"], "strict")
        self.assertIn("persona-new:strict", server._PERSONA_HOT_POOL_REFILLING)

    def test_persona_hot_pool_worker_stops_at_target(self):
        server._PERSONA_HOT_POOL_ATTEMPTS.clear()
        server._PERSONA_HOT_WARM_PENDING.clear()
        server._PERSONA_HOT_POOL_REFILLING.clear()
        server._PERSONA_HOT_POOL_COUNTS.clear()
        server._PERSONA_HOT_POOL_STRATEGY_READY.clear()
        server._PERSONA_HOT_WARM_ATTEMPTS.clear()
        server._PERSONA_HOT_POOL_CURSOR = 0
        server._PERSONA_HOT_POOL_REFILLING.add("persona-new:strict")
        server._PERSONA_HOT_LAST_INTERACTIVE_AT = 0.0

        with mock.patch.object(server._PERSONA_HOT_POOL_STOP, "is_set", side_effect=[False, False, True]), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "wait", return_value=False), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "clear"), \
             mock.patch.object(server, "_persona_hot_pool_worker_enabled", return_value=True), \
             mock.patch.object(server, "_persona_hot_pool_resources_available", return_value=True), \
             mock.patch.object(server, "_read_tool_r18_persona_archives", return_value=([{"id": "persona-new"}], {})), \
             mock.patch.object(server, "_run_persona_hot_workflow_cli", return_value={
                 "ok": True,
                 "pools": [
                     {"archiveId": "persona-new", "searchMode": "normal", "readyCount": 100, "strategyReady": True},
                     {"archiveId": "persona-new", "searchMode": "strict", "readyCount": 100, "strategyReady": True},
                 ],
             }) as run_workflow:
            server._persona_hot_pool_worker_loop()

        self.assertEqual(run_workflow.call_count, 1)
        self.assertNotIn("persona-new:strict", server._PERSONA_HOT_POOL_REFILLING)

    def test_persona_hot_pool_worker_keeps_deferred_strategy_warm_pending(self):
        server._PERSONA_HOT_POOL_ATTEMPTS.clear()
        server._PERSONA_HOT_WARM_PENDING.clear()
        server._PERSONA_HOT_WARM_PENDING.add("persona-new")
        server._PERSONA_HOT_WARM_ATTEMPTS.clear()
        server._PERSONA_HOT_LAST_INTERACTIVE_AT = 0.0

        with mock.patch.object(server._PERSONA_HOT_POOL_STOP, "is_set", side_effect=[False, False, True]), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "wait", return_value=False), \
             mock.patch.object(server._PERSONA_HOT_POOL_WAKE, "clear"), \
             mock.patch.object(server, "_persona_hot_pool_worker_enabled", return_value=True), \
             mock.patch.object(server, "_persona_hot_pool_resources_available", return_value=True), \
             mock.patch.object(server, "_run_persona_hot_workflow_cli", side_effect=server._PersonaHotBackgroundDeferred("deferred")):
            server._persona_hot_pool_worker_loop()

        self.assertIn("persona-new", server._PERSONA_HOT_WARM_PENDING)
        self.assertNotIn("persona-new", server._PERSONA_HOT_WARM_ATTEMPTS)

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
                    "freshness_policy": "strict",
                    "selected_memory_ids": ["mem-1"],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["archive_name"], "History Teacher")
        self.assertEqual(body["keywords"], ["历史", "课堂"])
        self.assertEqual(body["freshness_days"], 15)
        self.assertEqual(body["freshness_policy"], "strict")
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
        self.assertEqual(payload["freshnessPolicy"], "strict")
        self.assertEqual(payload["memorySummaries"], ["记忆一"])
        self.assertNotIn("recordShown", payload)
        self.assertNotIn("forceLive", payload)
        self.assertNotIn("deferBackgroundRefresh", payload)

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
        self.assertEqual(payload["freshnessPolicy"], "legacy")
        self.assertEqual(resp.json()["freshness_policy"], "legacy")
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

    def test_generate_persona_posts_calls_persona_workflow_cli(self):
        self._write_archives()

        def fake_generate(_archive_id, _payload):
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

        with mock.patch.object(server, "_generate_persona_archive_posts", side_effect=fake_generate) as mocked:
            resp = self.client.post(
                "/api/persona_dashboard/personas/persona-1/generate_posts",
                json={
                    "count": 1,
                    "prompt": "围绕历史老师的通勤日常",
                    "target_words": 80,
                    "content_time_slot": "morning",
                    "selected_memory_ids": ["mem-1"],
                },
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["generated_count"], 1)
        self.assertEqual(mocked.call_args.args[0], "persona-1")
        self.assertEqual(mocked.call_args.args[1].prompt, "围绕历史老师的通勤日常")

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
            result={"status": "ready", "diagnostic_outcome": "ready"},
            priority=20,
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
        self.assertIn("https://www.threads.com/@history/post/abc", payload["target_urls"])
        self.assertTrue(payload["target_summaries"])

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


if __name__ == "__main__":
    unittest.main()
