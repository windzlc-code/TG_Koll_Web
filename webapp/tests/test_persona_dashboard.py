import base64
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import webapp.server as server
import webapp.social_automation_api as social_automation_api


class PersonaDashboardApiTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_webapp_data_dir = os.environ.get("WEBAPP_DATA_DIR")
        self._old_tool_runtime_dir = os.environ.get("TOOL_R18_RUNTIME_DIR")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._old_server_tool_runtime_dir = server.TOOL_R18_RUNTIME_DIR
        self._old_social_tool_runtime_dir = social_automation_api._TOOL_R18_RUNTIME_DIR
        self._tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self._tmpdir.name)
        self.data_dir = self.root / "webapp_data"
        self.tool_runtime_dir = self.root / "tool_r18_runtime"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.tool_runtime_dir.mkdir(parents=True, exist_ok=True)
        self.draft_media_path = self.root / "draft_media.png"
        self.draft_media_path.write_bytes(
            bytes.fromhex("89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE0000000C49444154789C636060000000040001F61738550000000049454E44AE426082")
        )
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime_config.json")
        os.environ["TOOL_R18_RUNTIME_DIR"] = str(self.tool_runtime_dir)
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime_config.json"
        server.TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        social_automation_api._TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        self.app = server.create_app()
        self.unauth_client = TestClient(self.app)
        self.client = TestClient(self.app)
        login_resp = self.client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(login_resp.status_code, 200)

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        server.TOOL_R18_RUNTIME_DIR = self._old_server_tool_runtime_dir
        social_automation_api._TOOL_R18_RUNTIME_DIR = self._old_social_tool_runtime_dir
        self._restore_env("APP_DB_PATH", self._old_db_path)
        self._restore_env("APP_RUNTIME_CONFIG_PATH", self._old_runtime_config_path)
        self._restore_env("WEBAPP_DATA_DIR", self._old_webapp_data_dir)
        self._restore_env("TOOL_R18_RUNTIME_DIR", self._old_tool_runtime_dir)
        self._tmpdir.cleanup()

    def _restore_env(self, key, old_value):
        if old_value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = old_value

    def _admin_user_id(self) -> int:
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        row = conn.execute("SELECT id FROM users WHERE username = ?", ("admin",)).fetchone()
        conn.close()
        return int(row[0])

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
        conn.execute(
            """
            INSERT INTO social_accounts(id, persona_id, platform, username, display_name, profile_dir, proxy_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account_id,
                persona_id,
                platform,
                username,
                username,
                str(self.data_dir / "profiles" / account_id),
                "",
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
    ):
        conn = sqlite3.connect(str(self.data_dir / "app.db"))
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, persona_id, account_id, platform, task_type, priority, status, scheduled_at,
              started_at, finished_at, payload_json, result_json, error, retry_count, max_retries,
              created_by, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                persona_id,
                account_id,
                platform,
                task_type,
                50,
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
        resp = self.unauth_client.get("/api/persona_dashboard/overview")
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
        self.assertEqual(data["summary"]["task_count"], 2)
        self.assertEqual(data["charts"]["task_status_distribution"]["done"], 1)
        self.assertEqual(data["data_sources"]["sentiment_hot_candidates"]["shown_count"], 1)
        data_sources = json.dumps(data["data_sources"], ensure_ascii=False)
        self.assertNotIn(str(self.tool_runtime_dir), data_sources)
        persona = data["personas"][0]
        self.assertIn("threads_account", persona)
        self.assertNotIn("telegram", persona)
        self.assertFalse(persona["threads_account"]["bound"])
        self.assertTrue(any("Threads" in item for item in persona["warnings"]))

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
        resp = self.unauth_client.post(
            "/api/persona_dashboard/personas/persona-1/threads_binding",
            json={"username": "https://www.threads.net/@history_user?x=1"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["username"], "history_user")
        overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        self.assertTrue(persona["threads_account"]["bound"])
        self.assertEqual(persona["threads_account"]["handle"], "history_user")

    def test_public_threads_unbinding_clears_handle(self):
        self._write_archives()
        bind_resp = self.unauth_client.post(
            "/api/persona_dashboard/personas/persona-1/threads_binding",
            json={"username": "history_user"},
        )
        self.assertEqual(bind_resp.status_code, 200)
        resp = self.unauth_client.delete("/api/persona_dashboard/personas/persona-1/threads_binding")
        self.assertEqual(resp.status_code, 200)
        overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        self.assertFalse(persona["threads_account"]["bound"])
        self.assertEqual(persona["threads_account"]["handle"], "")

    def test_public_persona_profile_returns_editable_fields(self):
        self._write_archives()
        resp = self.unauth_client.get("/api/persona_dashboard/personas/persona-1/profile")
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
        resp = self.unauth_client.patch(
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
        resp = self.unauth_client.patch(
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
        resp = self.unauth_client.delete("/api/persona_dashboard/personas/persona-1")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["archive_id"], "persona-1")
        overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
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
        resp = self.unauth_client.delete("/api/persona_dashboard/personas/wf-1")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

    def test_public_refresh_endpoint_returns_task_status(self):
        with mock.patch.object(server, "_start_persona_dashboard_refresh", return_value={"id": "pdr_test", "status": "queued", "message": "queued"}):
            resp = self.unauth_client.post("/api/persona_dashboard/refresh", json={"archive_id": "persona-1"})
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

    def test_persona_post_image_runner_saves_local_preview_file(self):
        self._write_archives()
        task_id = "task-persona-post-image"
        payload = {
            "related_persona_id": "persona-1",
            "related_post_id": "post-1",
            "prompt": "请生成一张适合当前推文的通勤配图",
            "aspect_ratio": "1:1",
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
        with mock.patch.object(server.subprocess, "run", return_value=completed):
            result = server._run_persona_post_image_task(task_id, payload)
        self.assertTrue(result["ok"])
        self.assertTrue(result["image_paths"])
        saved_path = Path(result["image_paths"][0])
        self.assertTrue(saved_path.is_file())
        self.assertEqual(saved_path.read_bytes(), self.draft_media_path.read_bytes())

    def test_attach_persona_post_image_task_output_writes_back_to_post(self):
        self._write_archives()
        generated_path = self.root / "generated-preview.png"
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

    def test_publish_history_drops_unstable_signed_screenshot_preview_urls(self):
        from webapp import server

        row = server._compact_publish_record({
            "title": "Signed screenshot",
            "screenshotPath": "/api/persona_dashboard/automation/screenshots/screenshot?cbsIp=1.2.3.4&sign=abc",
        })
        self.assertEqual(row["screenshot_url"], "")

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
                    "selected_memory_ids": ["mem-1"],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["archive_name"], "History Teacher")
        self.assertEqual(body["keywords"], ["历史", "课堂"])
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
        self.assertEqual(payload["memorySummaries"], ["记忆一"])

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
        }), encoding="utf-8")

        server._sync_tool_r18_api_config_for_persona_workflow()

        synced = json.loads((self.tool_runtime_dir / "api_config.json").read_text(encoding="utf-8"))
        self.assertEqual(synced["gptEndpoint"], "http://llm.example")
        self.assertEqual(synced["geminiTextEndpoint"], "http://llm.example")
        self.assertEqual(synced["gptKey"], "key-123")
        self.assertEqual(synced["geminiTextKey"], "key-123")
        self.assertEqual(synced["llmModelPriorityOrder"], "xai/grok-4.3, google/gemini-3.5-flash")

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
        with mock.patch.object(server, "create_social_task", return_value={"id": "sat-1", "task_type": "publish_post", "status": "queued"}) as mocked:
            publish_resp = self.client.post(
                f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
                json={"media_paths": [r"E:\\tmp\\media_1.png"]},
            )
        self.assertEqual(publish_resp.status_code, 200)
        payload_obj = mocked.call_args.args[0]
        self.assertEqual(payload_obj.persona_id, "persona-1")
        self.assertEqual(payload_obj.account_id, "acct-1")
        self.assertEqual(payload_obj.task_type, "publish_post")
        self.assertEqual(payload_obj.payload["archive_post_id"], post["id"])
        self.assertEqual(payload_obj.payload["archive_post_title"], "Draft publish")
        self.assertEqual(payload_obj.payload["caption"], "Publish me")
        self.assertEqual(payload_obj.payload["media_paths"], [r"E:\\tmp\\media_1.png"])

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

    def test_publish_persona_post_rejects_non_ready_account(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user", status="cookie_expired")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Threads draft", "content": "Threads publish content"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        publish_resp = self.client.post(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
            json={"account_id": "acct-threads", "platform": "threads", "media_paths": []},
        )
        self.assertEqual(publish_resp.status_code, 400)
        self.assertIn("detail", publish_resp.json())

    def test_publish_persona_post_requires_successful_login_check(self):
        self._write_archives()
        self._insert_social_account(account_id="acct-threads", platform="threads", username="threads_user")
        create_resp = self.client.post(
            "/api/persona_dashboard/personas/persona-1/posts",
            json={"title": "Threads draft", "content": "Threads publish content"},
        )
        self.assertEqual(create_resp.status_code, 200)
        post = create_resp.json()
        publish_resp = self.client.post(
            f"/api/persona_dashboard/personas/persona-1/posts/{post['id']}/publish",
            json={"account_id": "acct-threads", "platform": "threads", "media_paths": []},
        )
        self.assertEqual(publish_resp.status_code, 400)
        self.assertIn("detail", publish_resp.json())

    def test_public_delete_post_removes_metric_row(self):
        self._write_archives()
        overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        post_key = persona["post_metrics"][0]["post_key"]
        resp = self.unauth_client.delete(f"/api/persona_dashboard/personas/persona-1/posts/{post_key}")
        self.assertEqual(resp.status_code, 200)
        self.assertGreaterEqual(resp.json()["deleted"], 1)
        deleted_posts = json.loads((self.tool_runtime_dir / "persona_dashboard_deleted_posts.json").read_text(encoding="utf-8"))
        self.assertIn(post_key, deleted_posts["persona-1"])
        next_overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
        next_persona = next_overview["personas"][0]
        self.assertEqual(next_persona["post_metrics"], [])
        self.assertEqual(next_persona["hot"]["likes"], 0)
        self.assertEqual(next_persona["hot"]["post_views"], 0)

    def test_deleted_post_tombstone_filters_restored_metric_rows(self):
        self._write_archives()
        overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
        persona = overview["personas"][0]
        post_key = persona["post_metrics"][0]["post_key"]
        (self.tool_runtime_dir / "persona_dashboard_deleted_posts.json").write_text(
            json.dumps({"persona-1": [post_key]}),
            encoding="utf-8",
        )

        next_overview = self.unauth_client.get("/api/persona_dashboard/overview").json()
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
