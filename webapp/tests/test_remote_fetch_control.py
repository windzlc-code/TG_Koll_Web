from __future__ import annotations

import contextlib
import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from webapp import server
from webapp.remote_fetch_client import RemoteFetchSettings, configured_mode


class _FakeRemoteFetchClient:
    def __init__(self):
        self.calls: list[dict] = []
        self.cancelled: list[str] = []

    def execute(self, **kwargs):
        self.calls.append(dict(kwargs))
        callback = kwargs.get("on_job_created")
        if callback:
            callback("job_1234567890abcdef12345678")
        return {
            "ok": True,
            "liveOnly": True,
            "historyFallback": False,
            "candidates": [],
        }

    def cancel(self, job_id: str):
        self.cancelled.append(job_id)
        return {"ok": True}


class RemoteFetchControlTests(unittest.TestCase):
    def test_file_configuration_enables_remote_without_container_env_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            keys = root / "keys.json"
            config = root / "config.json"
            keys.write_text(json.dumps({"capture-v1": "x" * 40}), encoding="utf-8")
            config.write_text(
                json.dumps(
                    {
                        "mode": "remote_required",
                        "base_url": "http://127.0.0.1:18092",
                        "key_id": "capture-v1",
                        "keys_file": str(keys),
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"TG_REMOTE_FETCH_CONFIG_FILE": str(config)},
                clear=True,
            ):
                settings = RemoteFetchSettings.from_environment()
                mode = configured_mode()
        self.assertIsNotNone(settings)
        self.assertEqual(settings.base_url, "http://127.0.0.1:18092")
        self.assertEqual(mode, "remote_required")

    def test_file_configuration_accepts_only_actual_container_gateway(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            keys = root / "keys.json"
            config = root / "config.json"
            keys.write_text(json.dumps({"capture-v1": "x" * 40}), encoding="utf-8")
            config.write_text(
                json.dumps(
                    {
                        "base_url": "http://172.17.0.1:18092",
                        "keys_file": str(keys),
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.dict(os.environ, {"TG_REMOTE_FETCH_CONFIG_FILE": str(config)}, clear=True),
                patch("webapp.remote_fetch_client._container_default_gateway_ipv4", return_value="172.17.0.1"),
            ):
                settings = RemoteFetchSettings.from_environment()
        self.assertIsNotNone(settings)
        assert settings is not None
        self.assertEqual(settings.base_url, "http://172.17.0.1:18092")

    def test_file_configuration_rejects_other_private_address(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.json"
            config.write_text(json.dumps({"base_url": "http://172.17.0.9:18092"}), encoding="utf-8")
            with (
                patch.dict(os.environ, {"TG_REMOTE_FETCH_CONFIG_FILE": str(config)}, clear=True),
                patch("webapp.remote_fetch_client._container_default_gateway_ipv4", return_value="172.17.0.1"),
            ):
                with self.assertRaisesRegex(RuntimeError, "current container gateway"):
                    RemoteFetchSettings.from_environment()

    def test_archive_snapshot_excludes_business_history(self) -> None:
        archive = {
            "id": "persona-a",
            "name": "A",
            "content": "persona",
            "setup": {
                "genres": ["technology", "business"],
                "personaType": "expert",
                "locale": "zh-Hans",
                "accountManagement": {"api_token": "secret"},
                "hotMetrics": {"nested": "secret"},
                "api_token": "secret",
                "tweetStyleProfile": {"nestedToken": "secret"},
            },
            "posts": [{"id": "post-secret"}],
            "favoritePosts": [{"id": "favorite-secret"}],
            "publishHistory": [{"id": "history-secret"}],
        }
        with patch.object(server, "_read_tool_r18_persona_archives", return_value=([archive], {})):
            snapshot = server._remote_fetch_archive_snapshot("persona-a")
        self.assertEqual(snapshot["posts"], [])
        self.assertNotIn("favoritePosts", snapshot)
        self.assertNotIn("publishHistory", snapshot)
        self.assertEqual(
            snapshot["setup"],
            {
                "genres": ["technology", "business"],
                "personaType": "expert",
                "locale": "zh-Hans",
            },
        )
        serialized = json.dumps(snapshot, ensure_ascii=False)
        self.assertNotIn("api_token", serialized)
        self.assertNotIn("accountManagement", serialized)
        self.assertNotIn("hotMetrics", serialized)
        self.assertNotIn("nestedToken", serialized)

    def test_post_snapshot_contains_only_refresh_metric_inputs(self) -> None:
        post = {
            "id": "post-a",
            "content": "private draft",
            "media": [{"api_token": "secret"}],
            "sourceMeta": {
                "source": "sentiment_hot_import",
                "sourceUrl": "https://www.threads.net/@a/post/1",
                "platform": "threads",
                "hotScore": 88,
                "metrics": {"viewCount": 10, "api_token": "secret"},
                "mediaItems": [
                    {"type": "image", "url": "https://example.test/image.jpg", "password": "secret"}
                ],
                "api_token": "secret",
                "accountManagement": {"password": "secret"},
            },
        }
        with patch.object(server, "_list_persona_archive_posts", return_value=[post]):
            snapshot = server._remote_fetch_post_snapshot("persona-a", "post-a")
        self.assertEqual(
            snapshot,
            {
                "id": "post-a",
                "sourceMeta": {
                    "source": "sentiment_hot_import",
                    "sourceUrl": "https://www.threads.net/@a/post/1",
                    "platform": "threads",
                    "hotScore": 88,
                    "metrics": {"viewCount": 10},
                    "mediaItems": [
                        {"type": "image", "url": "https://example.test/image.jpg"}
                    ],
                },
            },
        )
        self.assertNotIn("secret", json.dumps(snapshot))

    def test_cancel_hot_candidates_does_not_cancel_same_archive_metrics_job(self) -> None:
        client = _FakeRemoteFetchClient()
        candidate_key = (
            "persona-a",
            "persona.hot_candidates.v1",
            "unit-candidate",
            "request-candidate",
        )
        metrics_key = (
            "persona-a",
            "persona.hot_post_metrics.v1",
            "post-a",
            "request-metrics",
        )
        with server._PERSONA_HOT_PROCESS_LOCK:
            server._PERSONA_HOT_REMOTE_JOB_IDS.clear()
            server._PERSONA_HOT_REMOTE_JOB_IDS[candidate_key] = "job-candidate"
            server._PERSONA_HOT_REMOTE_JOB_IDS[metrics_key] = "job-metrics"
        try:
            with patch.object(server, "configured_remote_fetch_client", return_value=client):
                self.assertTrue(server._cancel_persona_hot_workflow("persona-a"))
            self.assertEqual(client.cancelled, ["job-candidate"])
            self.assertEqual(server._PERSONA_HOT_REMOTE_JOB_IDS, {metrics_key: "job-metrics"})
        finally:
            with server._PERSONA_HOT_PROCESS_LOCK:
                server._PERSONA_HOT_REMOTE_JOB_IDS.clear()

    def test_persona_hot_and_crm_use_expected_remote_capabilities(self) -> None:
        client = _FakeRemoteFetchClient()
        cases = (
            (
                {
                    "action": "fetch-hot-candidates",
                    "archiveId": "persona-a",
                    "liveOnly": True,
                    "recordShown": False,
                },
                "persona.hot_candidates.v1",
            ),
            (
                {
                    "action": "fetch-hot-candidates",
                    "operation": "crm_threads_live_search",
                    "archiveId": "persona-a",
                    "liveOnly": True,
                    "recordShown": False,
                },
                "crm.threads_live_search.v1",
            ),
        )
        with patch.object(server, "configured_remote_fetch_client", return_value=client):
            with patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "remote_required"}):
                for payload, capability in cases:
                    result = server._run_remote_persona_hot_workflow(
                        payload, timeout_seconds=60
                    )
                    self.assertTrue(result["ok"])
                    self.assertEqual(client.calls[-1]["capability"], capability)
                    self.assertTrue(client.calls[-1]["unit_id"].startswith("unit_"))
        self.assertEqual(server._PERSONA_HOT_REMOTE_JOB_IDS, {})

    def test_remote_crm_payload_is_allowlisted_and_contains_only_ephemeral_snapshot(self) -> None:
        client = _FakeRemoteFetchClient()
        payload = {
            "action": "fetch-hot-candidates",
            "operation": "crm_threads_live_search",
            "archiveId": "crm-search-safe1234",
            "archiveSnapshot": {
                "id": "crm-search-safe1234",
                "name": "CRM live search",
                "content": "AI marketing",
                "setup": {
                    "customTopic": "AI marketing",
                    "trendTopics": ["AI marketing"],
                    "locale": "zh-Hans",
                    "accountManagement": {"password": "must-not-leak"},
                    "api_token": "must-not-leak",
                },
                "accountManagement": {"totp": "must-not-leak"},
                "posts": [{"accountId": "must-not-leak"}],
            },
            "accountId": "tenant-account",
            "account_id": "tenant-account",
            "senderUsername": "tenant-sender",
            "sender_username": "tenant-sender",
            "user_id": 42,
            "userId": 42,
            "cookies": [{"name": "sessionid", "value": "must-not-leak"}],
            "password": "must-not-leak",
            "totp": "must-not-leak",
            "query": "AI marketing",
            "prompt": "AI marketing",
            "keywords": ["AI marketing"],
            "platform": "threads",
            "liveOnly": True,
            "recordShown": False,
        }
        with (
            patch.object(server, "configured_remote_fetch_client", return_value=client),
            patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "remote_required"}),
        ):
            server._run_remote_persona_hot_workflow(payload, timeout_seconds=60)

        sent = client.calls[-1]["payload"]
        serialized = json.dumps(sent, ensure_ascii=False)
        for forbidden in (
            "accountId",
            "account_id",
            "senderUsername",
            "sender_username",
            "user_id",
            "userId",
            "cookies",
            "password",
            "totp",
            "accountManagement",
            "api_token",
            "must-not-leak",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(sent["archiveSnapshot"], {
            "id": "crm-search-safe1234",
            "name": "CRM live search",
            "content": "AI marketing",
            "setup": {
                "customTopic": "AI marketing",
                "trendTopics": ["AI marketing"],
                "locale": "zh-Hans",
            },
            "posts": [],
        })

    def test_crm_collector_mode_defaults_only_for_remote_required_and_can_be_overridden(self) -> None:
        with patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "local"}, clear=True):
            self.assertFalse(server._crm_collector_live_search_enabled())
        with patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "remote_required"}, clear=True):
            self.assertTrue(server._crm_collector_live_search_enabled())
        with patch.dict(
            os.environ,
            {"TG_REMOTE_FETCH_MODE": "remote_required", "TG_CRM_COLLECTOR_MODE": "false"},
            clear=True,
        ):
            self.assertFalse(server._crm_collector_live_search_enabled())

    def test_non_capture_keyword_generation_stays_on_new_server(self) -> None:
        client = _FakeRemoteFetchClient()
        with (
            patch.object(server, "configured_remote_fetch_client", return_value=client),
            patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "remote_required"}),
        ):
            result = server._run_remote_persona_hot_workflow(
                {"action": "prepare-hot-keywords", "archiveId": "persona-a"},
                timeout_seconds=60,
            )
        self.assertIsNone(result)
        self.assertEqual(client.calls, [])

    def test_remote_payload_includes_current_snapshots_and_output_only(self) -> None:
        client = _FakeRemoteFetchClient()
        with (
            patch.object(server, "configured_remote_fetch_client", return_value=client),
            patch.object(server, "_remote_fetch_archive_snapshot", return_value={"id": "persona-a", "posts": []}),
            patch.object(server, "_remote_fetch_post_snapshot", return_value={"id": "post-a", "sourceMeta": {"source": "sentiment_hot_import"}}),
            patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "remote_required"}),
        ):
            server._run_remote_persona_hot_workflow(
                {"action": "refresh-hot-post", "archiveId": "persona-a", "postId": "post-a"},
                timeout_seconds=60,
            )
        sent = client.calls[-1]["payload"]
        self.assertEqual(sent["archiveSnapshot"]["id"], "persona-a")
        self.assertEqual(sent["postSnapshot"]["id"], "post-a")
        self.assertIs(sent["outputOnly"], True)

    def test_remote_metrics_patch_is_applied_only_to_authoritative_archive(self) -> None:
        archive = {
            "id": "persona-a",
            "name": "A",
            "posts": [
                {
                    "id": "post-a",
                    "sourceMeta": {
                        "source": "sentiment_hot_import",
                        "sourceUrl": "https://www.threads.net/@a/post/1",
                        "metrics": {"likes": 1},
                    },
                },
                {"id": "post-sibling", "title": "must stay unchanged"},
            ],
        }
        other_archive = {
            "id": "persona-b",
            "name": "B",
            "posts": [{"id": "post-b", "title": "unrelated"}],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            path = runtime_dir / "persona_archives.json"
            path.write_text(json.dumps([archive, other_archive]), encoding="utf-8")
            with (
                patch.object(server, "TOOL_R18_RUNTIME_DIR", runtime_dir),
                patch.object(server, "_persona_dashboard_iso_now", return_value="2026-08-11T15:00:01Z"),
            ):
                updated = server._apply_remote_persona_hot_metrics_patch(
                    "persona-a",
                    "post-a",
                    {
                        "sourceMetaPatch": {
                            "hotScore": 88,
                            "metrics": {"views": 123},
                            "capturedAt": "2026-08-11T15:00:00Z",
                        }
                    },
                )
            persisted_archives = json.loads(path.read_text(encoding="utf-8"))
            persisted = persisted_archives[0]["posts"][0]
        self.assertEqual(updated["sourceMeta"]["hotScore"], 88)
        self.assertEqual(persisted["sourceMeta"]["metrics"], {"likes": 1, "views": 123})
        self.assertEqual(persisted["sourceMeta"]["sourceUrl"], "https://www.threads.net/@a/post/1")
        self.assertEqual(persisted["updatedAt"], "2026-08-11T15:00:01Z")
        self.assertEqual(persisted_archives[0]["posts"][1], archive["posts"][1])
        self.assertEqual(persisted_archives[1], other_archive)

    def test_remote_metrics_patch_rereads_after_cross_process_lock(self) -> None:
        target = {
            "id": "post-a",
            "sourceMeta": {
                "source": "sentiment_hot_import",
                "sourceUrl": "https://www.threads.net/@a/post/1",
                "metrics": {"likes": 1},
            },
        }
        stale_archives = [
            {
                "id": "persona-a",
                "posts": [target, {"id": "post-sibling", "title": "stale"}],
            }
        ]
        latest_archives = json.loads(json.dumps(stale_archives))
        latest_archives[0]["posts"][1]["title"] = "committed while waiting"

        with tempfile.TemporaryDirectory() as temp_dir:
            runtime_dir = Path(temp_dir)
            path = runtime_dir / "persona_archives.json"
            path.write_text(json.dumps(stale_archives), encoding="utf-8")
            lock_entries: list[str] = []

            @contextlib.contextmanager
            def acquired_after_other_writer(*_args, **_kwargs):
                path.write_text(json.dumps(latest_archives), encoding="utf-8")
                lock_entries.append("entered")
                yield

            with (
                patch.object(server, "TOOL_R18_RUNTIME_DIR", runtime_dir),
                patch.object(server, "_persona_archive_file_lock", acquired_after_other_writer),
            ):
                server._apply_remote_persona_hot_metrics_patch(
                    "persona-a",
                    "post-a",
                    {"sourceMetaPatch": {"metrics": {"views": 123}}},
                )
            persisted = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(lock_entries, ["entered"])
        self.assertEqual(persisted[0]["posts"][1]["title"], "committed while waiting")
        self.assertEqual(persisted[0]["posts"][0]["sourceMeta"]["metrics"], {"likes": 1, "views": 123})

    def test_remote_required_never_silently_falls_back_local(self) -> None:
        payload = {
            "action": "fetch-hot-candidates",
            "archiveId": "persona-a",
            "liveOnly": True,
            "recordShown": False,
        }
        with patch.object(server, "configured_remote_fetch_client", return_value=None):
            with patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "remote_required"}):
                with self.assertRaises(HTTPException) as raised:
                    server._run_remote_persona_hot_workflow(payload, timeout_seconds=60)
        self.assertEqual(raised.exception.status_code, 503)

    def test_local_mode_preserves_existing_execution_when_worker_not_configured(self) -> None:
        with patch.object(server, "configured_remote_fetch_client", return_value=None):
            with patch.dict(os.environ, {"TG_REMOTE_FETCH_MODE": "local"}):
                self.assertIsNone(
                    server._run_remote_persona_hot_workflow(
                        {"action": "fetch-hot-candidates", "archiveId": "persona-a"},
                        timeout_seconds=60,
                    )
                )


if __name__ == "__main__":
    unittest.main()
