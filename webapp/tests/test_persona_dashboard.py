import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import webapp.server as server


class PersonaDashboardApiTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_webapp_data_dir = os.environ.get("WEBAPP_DATA_DIR")
        self._old_tool_runtime_dir = os.environ.get("TOOL_R18_RUNTIME_DIR")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._old_server_tool_runtime_dir = server.TOOL_R18_RUNTIME_DIR
        self._tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self._tmpdir.name)
        self.data_dir = self.root / "webapp_data"
        self.tool_runtime_dir = self.root / "tool_r18_runtime"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.tool_runtime_dir.mkdir(parents=True, exist_ok=True)
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime_config.json")
        os.environ["TOOL_R18_RUNTIME_DIR"] = str(self.tool_runtime_dir)
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime_config.json"
        server.TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        self.app = server.create_app()
        self.unauth_client = TestClient(self.app)
        self.client = TestClient(self.app)
        login_resp = self.client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(login_resp.status_code, 200)

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        server.TOOL_R18_RUNTIME_DIR = self._old_server_tool_runtime_dir
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

    def _write_archives(self):
        archives = [
            {
                "id": "persona-1",
                "name": "历史老师",
                "content": "讲历史冷知识的人设",
                "createdAt": "2026-06-20T00:00:00Z",
                "updatedAt": "2026-06-30T00:00:00Z",
                "boundPadCode": "PAD-1",
                "boundPadName": "OP-TEST1",
                "ownerBotName": "primary",
                "setup": {
                    "personaName": "历史老师",
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
                "posts": [{"id": "post-1", "title": "A", "content": "post", "createdAt": "2026-06-29T00:00:00Z", "updatedAt": "2026-06-29T00:00:00Z"}],
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
        self.assertIn("逐帖浏览", persona["hot_score_formula"])
        self.assertIn("不包含账号主页浏览", persona["hot_score_formula"])

    def test_sensitive_values_are_masked(self):
        self._write_archives()
        resp = self.client.get("/api/persona_dashboard/overview")
        self.assertEqual(resp.status_code, 200)
        body = json.dumps(resp.json(), ensure_ascii=False)
        self.assertNotIn("super-secret-token", body)
        self.assertNotIn("super-secret-password", body)
        self.assertIn("configured", body)

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

    def test_public_refresh_endpoint_returns_task_status(self):
        with mock.patch.object(server, "_start_persona_dashboard_refresh", return_value={"id": "pdr_test", "status": "queued", "message": "已加入刷新队列。"}):
            resp = self.unauth_client.post("/api/persona_dashboard/refresh", json={"archive_id": "persona-1"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["id"], "pdr_test")

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


if __name__ == "__main__":
    unittest.main()
