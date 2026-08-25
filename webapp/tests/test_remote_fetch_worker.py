from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from webapp.remote_fetch_protocol import (
    ProtocolError,
    canonical_json_bytes,
    signed_headers,
    verify_request,
)
from webapp.collector_accounts import NoCollectorAccountAvailableError
from webapp.worker_server import (
    JobStore,
    PERSONA_HOT_KEYWORD_STRATEGY_VERSION,
    WorkerRuntime,
    WorkerSettings,
    _apply_hot_reader_execution_profile,
    _validate_envelope,
    create_worker_app,
    run_tool_r18_job,
)


def current_keyword_strategy(keywords):
    body = json.dumps(keywords, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    import hashlib
    return {
        "keywords": keywords,
        "keywordStrategyVersion": PERSONA_HOT_KEYWORD_STRATEGY_VERSION,
        "keywordDigest": hashlib.sha256(body).hexdigest(),
    }


class RemoteFetchProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.secret = "worker-secret-" + "x" * 48
        self.body = canonical_json_bytes({"capability": "persona.hot_candidates.v1"})

    def test_signature_round_trip_and_tamper_rejection(self) -> None:
        headers = signed_headers(
            secret=self.secret,
            key_id="capture-v1",
            method="POST",
            path="/internal/worker/v1/jobs",
            body=self.body,
            timestamp=1_700_000_000,
            nonce="nonce_abcdefghijklmnop",
            idempotency_key="capture:test:1234",
        )
        key_id, nonce, timestamp = verify_request(
            secrets_by_key_id={"capture-v1": self.secret},
            method="POST",
            path="/internal/worker/v1/jobs",
            body=self.body,
            headers=headers,
            current_time=1_700_000_030,
        )
        self.assertEqual((key_id, nonce, timestamp), (
            "capture-v1", "nonce_abcdefghijklmnop", 1_700_000_000,
        ))
        with self.assertRaises(ProtocolError):
            verify_request(
                secrets_by_key_id={"capture-v1": self.secret},
                method="POST",
                path="/internal/worker/v1/jobs",
                body=self.body + b"x",
                headers=headers,
                current_time=1_700_000_030,
            )

    def test_expired_signature_is_rejected(self) -> None:
        headers = signed_headers(
            secret=self.secret,
            key_id="capture-v1",
            method="GET",
            path="/internal/worker/v1/jobs/job_123",
            body=b"",
            timestamp=1_700_000_000,
            nonce="nonce_abcdefghijklmnop",
        )
        with self.assertRaises(ProtocolError):
            verify_request(
                secrets_by_key_id={"capture-v1": self.secret},
                method="GET",
                path="/internal/worker/v1/jobs/job_123",
                body=b"",
                headers=headers,
                current_time=1_700_000_061,
            )


class RemoteFetchStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "jobs.db"
        self.runtime_dir = Path(self.temp.name) / "runtime"
        self.runtime_dir.mkdir(parents=True)
        self.store = JobStore(self.path, runtime_dir=self.runtime_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def submit(self, *, key: str = "capture:test:1234", digest: str = "a" * 64):
        return self.store.submit(
            idempotency_key=key,
            request_digest=digest,
            capability="persona.hot_candidates.v1",
            unit_id="archive_12345678",
            payload={
                "action": "fetch-hot-candidates",
                "archiveId": "archive_12345678",
                "liveOnly": True,
                "recordShown": False,
            },
        )

    def test_idempotent_submit_returns_original_and_rejects_conflict(self) -> None:
        first, created = self.submit()
        replay, replay_created = self.submit()
        self.assertTrue(created)
        self.assertFalse(replay_created)
        self.assertEqual(first["id"], replay["id"])
        with self.assertRaises(ProtocolError):
            self.submit(digest="b" * 64)

    def test_persona_hot_submit_does_not_register_background_refill(self) -> None:
        now = int(time.time())
        self.store.submit(
            idempotency_key="capture:pool-target:1234",
            request_digest="c" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_pool_target",
            payload={
                "action": "fetch-hot-candidates",
                "archiveId": "archive_pool_target",
                "archiveSnapshot": {"id": "archive_pool_target", "posts": []},
                **current_keyword_strategy(["理发师", "理发店趣事"]),
                "liveOnly": False,
                "recordShown": False,
                "limit": 10,
            },
        )
        original = self.store.claim_next()
        self.assertIsNotNone(original)
        self.store.finish(original[0]["id"], status="success", result={"ok": True})
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now))
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now + 21601))
        with self.store._connection() as connection:
            target_count = connection.execute("SELECT COUNT(*) FROM fetch_pool_targets").fetchone()[0]
        self.assertEqual(target_count, 0)

    def pool_payload(self, archive_id: str, *, user_initiated: bool) -> dict:
        return {
            "action": "fetch-hot-candidates",
            "archiveId": archive_id,
            "archiveSnapshot": {"id": archive_id, "posts": []},
            **current_keyword_strategy(["hair salon", "hair care trends"]),
            "liveOnly": False,
            "recordShown": False,
            "userInitiated": user_initiated,
            "limit": 10,
        }

    def test_only_user_initiated_persona_hot_submit_registers_refill_target(self) -> None:
        self.store.submit(
            idempotency_key="capture:inactive-target:1234",
            request_digest="d" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_inactive_target",
            payload=self.pool_payload("archive_inactive_target", user_initiated=False),
        )
        with self.store._connection() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM fetch_pool_targets").fetchone()[0], 0)

        self.store.submit(
            idempotency_key="capture:active-target:1234",
            request_digest="e" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_active_target",
            payload=self.pool_payload("archive_active_target", user_initiated=True),
        )
        with self.store._connection() as connection:
            target = connection.execute("SELECT * FROM fetch_pool_targets").fetchone()
        self.assertIsNotNone(target)
        self.assertEqual(target["archive_id"], "archive_active_target")
        self.assertGreater(target["active_until"], target["last_user_fetch_at"])
        self.assertEqual(target["next_run_at"] - target["last_user_fetch_at"], 8 * 3600)
        self.assertEqual(target["active_until"] - target["last_user_fetch_at"], 2 * 86400)
        self.assertEqual(target["low_watermark"], 15)
        self.assertEqual(target["target_watermark"], 15)

    def test_pool_refill_waits_eight_hours_and_stops_after_two_idle_days(self) -> None:
        now = int(time.time())
        archive_id = "archive_eight_hour"
        self.store.submit(
            idempotency_key="capture:eight-hour:1234",
            request_digest="a" * 64,
            capability="persona.hot_candidates.v1",
            unit_id=archive_id,
            payload=self.pool_payload(archive_id, user_initiated=True),
        )
        original = self.store.claim_next()
        self.assertIsNotNone(original)
        self.store.finish(original[0]["id"], status="success", result={"ok": True})
        with self.store._connection() as connection:
            target = connection.execute("SELECT next_run_at, last_user_fetch_at, active_until FROM fetch_pool_targets").fetchone()
        due = int(target["next_run_at"])
        fetched = int(target["last_user_fetch_at"])
        self.assertEqual(due - fetched, 8 * 3600)
        self.assertEqual(int(target["active_until"]) - fetched, 2 * 86400)
        self.assertFalse(self.store.enqueue_due_pool_refill(now=due - 1))
        self.assertTrue(self.store.enqueue_due_pool_refill(now=due))
        refill = self.store.claim_next()
        self.assertIsNotNone(refill)
        self.assertTrue(refill[1].get("_poolRefill"))
        self.store.finish(refill[0]["id"], status="success", result={"ok": True})
        with self.store._connection() as connection:
            connection.execute(
                "UPDATE fetch_pool_targets SET next_run_at=?, last_user_fetch_at=?, active_until=?",
                (now + 2 * 86400, now, now + 2 * 86400),
            )
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now + 2 * 86400))
        with self.store._connection() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM fetch_pool_targets").fetchone()[0], 0)

    def test_dataset_overview_lists_global_pool_first_and_named_persona_counts(self) -> None:
        now = int(time.time())
        archive_id = "12345678-1234-4234-8234-123456789abc"
        payload = self.pool_payload(archive_id, user_initiated=True)
        payload["archiveSnapshot"]["name"] = "理发师"
        self.store.submit(
            idempotency_key="capture:dataset-overview:1234",
            request_digest="9" * 64,
            capability="persona.hot_candidates.v1",
            unit_id=archive_id,
            payload=payload,
        )
        cache_dir = self.runtime_dir / "sentiment_threads_search_cache"
        cache_dir.mkdir()
        candidate = {
            "id": "persona-candidate-1",
            "content": "qualified persona candidate content " * 4,
            "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }
        (cache_dir / f"{archive_id}-keywords-strict.json").write_text(
            json.dumps({f"{archive_id}::strict::query": {"candidates": [candidate]}}),
            encoding="utf-8",
        )
        global_db = sqlite3.connect(self.runtime_dir / "sentiment_hot_global_pool.sqlite3")
        global_db.execute(
            "CREATE TABLE sentiment_hot_global_candidates(id TEXT,candidate_json TEXT,content_at_ms INTEGER)"
        )
        global_db.execute(
            "INSERT INTO sentiment_hot_global_candidates VALUES(?,?,?)",
            ("global-1", json.dumps({"content": "qualified global candidate content " * 4}), now * 1000),
        )
        global_db.commit()
        global_db.close()

        overview = self.store.dataset_overview(now=now)
        self.assertEqual(overview["global"]["count"], 1)
        self.assertEqual(overview["global"]["capacity"], 100000)
        self.assertEqual(len(overview["personas"]), 1)
        self.assertEqual(overview["personas"][0]["name"], "理发师")
        self.assertEqual(overview["personas"][0]["count"], 1)
        self.assertEqual(overview["personas"][0]["capacity"], 30)

    def test_hot_dataset_change_events_use_first_snapshot_as_baseline_and_can_be_deleted(self) -> None:
        archive_id = "12345678-1234-4234-8234-123456789abc"
        baseline = {
            "generated_at": 1_700_000_000,
            "global": {"name": "全局数据集", "count": 10, "capacity": 100000},
            "personas": [{"archive_id": archive_id, "name": "理发师", "count": 4, "capacity": 100}],
        }
        self.store._record_dataset_overview_changes(baseline, reason="worker_sync", source="worker")
        self.assertEqual(self.store.list_hot_dataset_events(), [])

        changed = {
            **baseline,
            "generated_at": 1_700_000_030,
            "global": {**baseline["global"], "count": 13},
            "personas": [{**baseline["personas"][0], "count": 2}],
        }
        self.store._record_dataset_overview_changes(changed, reason="worker_sync", source="worker")
        events = self.store.list_hot_dataset_events()
        self.assertEqual(len(events), 2)
        self.assertEqual({event["dataset_id"]: event["delta"] for event in events}, {"global": 3, archive_id: -2})
        self.assertEqual({event["dataset_id"]: (event["count_before"], event["count_after"]) for event in events}, {"global": (10, 13), archive_id: (4, 2)})

        self.assertTrue(self.store.delete_hot_dataset_event(events[0]["id"]))
        self.assertEqual(len(self.store.list_hot_dataset_events()), 1)
        self.assertFalse(self.store.delete_hot_dataset_event(events[0]["id"]))
        with self.assertRaises(ValueError):
            self.store.delete_hot_dataset_event("invalid")

    def test_hot_dataset_events_paginate_and_prune_to_max(self) -> None:
        os.environ["TG_HOT_DATASET_OVERVIEW_PATH"] = str(self.runtime_dir / "hot-dataset-overview.json")
        archive_id = "12345678-1234-4234-8234-123456789abc"
        snapshot = {
            "generated_at": 1_700_000_000,
            "global": {"name": "全局数据集", "count": 1, "capacity": 100000},
            "personas": [{"archive_id": archive_id, "name": "理发师", "count": 1, "capacity": 100}],
        }
        self.store._record_dataset_overview_changes(snapshot, reason="worker_sync", source="worker")
        for index in range(12):
            snapshot = {
                **snapshot,
                "generated_at": 1_700_000_010 + index,
                "global": {**snapshot["global"], "count": index + 2},
            }
            self.store._record_dataset_overview_changes(snapshot, reason="worker_sync", source="worker")
        page = self.store.page_hot_dataset_events(page=1, page_size=5, scope="global")
        self.assertEqual(page["page_size"], 5)
        self.assertEqual(len(page["events"]), 5)
        self.assertGreaterEqual(page["total"], 5)
        self.assertEqual(page["scope"], "global")
        persona_page = self.store.page_hot_dataset_events(page=1, page_size=5, scope="persona")
        self.assertTrue(all(event["dataset_id"] != "global" for event in persona_page["events"]))
        saved = self.store.save_hot_dataset_ui_settings({"event_max": 50, "event_page_size": 5, "persona_page_size": 5})
        self.assertEqual(saved["event_max"], 50)
        self.assertEqual(saved["event_page_size"], 5)
        for index in range(60):
            snapshot = {
                **snapshot,
                "generated_at": 1_700_000_100 + index,
                "global": {**snapshot["global"], "count": 20 + index},
            }
            self.store._record_dataset_overview_changes(snapshot, reason="worker_sync", source="worker")
        pruned = self.store.page_hot_dataset_events(page=1, page_size=5, scope="all")
        self.assertLessEqual(pruned["total"], 50)
        self.assertEqual(len(pruned["events"]), 5)
        self.assertGreaterEqual(pruned["pages"], 1)

    def test_clear_hot_dataset_removes_candidates_but_preserves_persona_refill_target(self) -> None:
        now = int(time.time())
        archive_id = "12345678-1234-4234-8234-123456789abc"
        payload = self.pool_payload(archive_id, user_initiated=True)
        payload["archiveSnapshot"]["name"] = "理发师"
        self.store.submit(
            idempotency_key="capture:dataset-clear:1234",
            request_digest="8" * 64,
            capability="persona.hot_candidates.v1",
            unit_id=archive_id,
            payload=payload,
        )
        cache_dir = self.runtime_dir / "sentiment_threads_search_cache"
        cache_dir.mkdir()
        candidate = {
            "id": "persona-candidate-1",
            "content": "qualified persona candidate content " * 4,
            "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }
        cache_path = cache_dir / f"{archive_id}-keywords-strict.json"
        cache_path.write_text(
            json.dumps({f"{archive_id}::strict::query": {"candidates": [candidate]}}),
            encoding="utf-8",
        )
        global_path = self.runtime_dir / "sentiment_hot_global_pool.sqlite3"
        global_db = sqlite3.connect(global_path)
        try:
            global_db.execute(
                "CREATE TABLE sentiment_hot_global_candidates(id TEXT,candidate_json TEXT,content_at_ms INTEGER)"
            )
            global_db.execute(
                "INSERT INTO sentiment_hot_global_candidates VALUES(?,?,?)",
                ("global-1", json.dumps({"content": "qualified global candidate content " * 4}), now * 1000),
            )
            global_db.commit()
        finally:
            global_db.close()

        self.assertTrue(any(item["archive_id"] == archive_id for item in self.store.dataset_overview()["personas"]))
        persona_result = self.store.clear_hot_dataset(archive_id)
        self.assertEqual(persona_result["deleted_count"], 1)
        self.assertEqual(persona_result["moved_count"], 0)
        self.assertFalse(any(item["archive_id"] == archive_id for item in self.store.dataset_overview()["personas"]))
        cleared_cache = json.loads(cache_path.read_text(encoding="utf-8"))
        self.assertEqual(cleared_cache[f"{archive_id}::strict::query"]["candidates"], [])
        global_db = sqlite3.connect(global_path)
        try:
            leftover_ids = {row[0] for row in global_db.execute("SELECT id FROM sentiment_hot_global_candidates")}
        finally:
            global_db.close()
        self.assertEqual(leftover_ids, {"global-1"})
        with self.store._connection() as connection:
            target = connection.execute(
                "SELECT archive_id FROM fetch_pool_targets WHERE archive_id=?",
                (archive_id,),
            ).fetchone()
        self.assertIsNone(target)

        self.store.submit(
            idempotency_key="capture:dataset-clear-restart:1234",
            request_digest="7" * 64,
            capability="persona.hot_candidates.v1",
            unit_id=archive_id,
            payload=payload,
        )
        self.assertTrue(any(item["archive_id"] == archive_id for item in self.store.dataset_overview()["personas"]))

        global_result = self.store.clear_hot_dataset("global")
        self.assertEqual(global_result["deleted_count"], 1)
        global_db = sqlite3.connect(global_path)
        try:
            self.assertEqual(global_db.execute("SELECT COUNT(*) FROM sentiment_hot_global_candidates").fetchone()[0], 0)
        finally:
            global_db.close()
        global_json = json.loads((self.runtime_dir / "sentiment_hot_global_pool.json").read_text(encoding="utf-8"))
        self.assertEqual(global_json["candidates"], [])
        with self.assertRaises(ValueError):
            self.store.clear_hot_dataset("not-a-dataset")

    def test_persona_overflow_above_capacity_moves_oldest_to_global(self) -> None:
        now = int(time.time())
        archive_id = "12345678-1234-4234-8234-123456789abc"
        cache_dir = self.runtime_dir / "sentiment_threads_search_cache"
        cache_dir.mkdir()
        candidates = []
        for index in range(60):
            candidates.append({
                "id": f"persona-extra-{index}",
                "content": f"qualified persona overflow candidate {index} " + ("text " * 20),
                "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - index)),
            })
        cache_path = cache_dir / f"{archive_id}-keywords-strict.json"
        cache_path.write_text(
            json.dumps({f"{archive_id}::strict::query": {"candidates": candidates}}),
            encoding="utf-8",
        )
        moved = self.store.spill_persona_overflow_to_global()
        self.assertEqual(moved, 30)
        kept = json.loads(cache_path.read_text(encoding="utf-8"))[f"{archive_id}::strict::query"]["candidates"]
        self.assertEqual(len(kept), 30)
        kept_ids = {item["id"] for item in kept}
        self.assertIn("persona-extra-0", kept_ids)
        self.assertNotIn("persona-extra-59", kept_ids)
        global_db = sqlite3.connect(self.runtime_dir / "sentiment_hot_global_pool.sqlite3")
        try:
            overflow_ids = {row[0] for row in global_db.execute("SELECT id FROM sentiment_hot_global_candidates")}
        finally:
            global_db.close()
        self.assertEqual(len(overflow_ids), 30)
        self.assertIn("persona-extra-59", overflow_ids)

    def test_due_persona_below_watermark_enqueues_one_internal_refill(self) -> None:
        now = int(time.time())
        self.store.submit(
            idempotency_key="capture:low-water:1234",
            request_digest="f" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_low_water",
            payload=self.pool_payload("archive_low_water", user_initiated=True),
        )
        original = self.store.claim_next()
        self.assertIsNotNone(original)
        self.store.finish(original[0]["id"], status="success", result={"ok": True})
        with self.store._connection() as connection:
            connection.execute("UPDATE fetch_pool_targets SET next_run_at=?", (now,))
        self.assertTrue(self.store.enqueue_due_pool_refill(now=now))
        with self.store._connection() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM fetch_jobs WHERE unit_id LIKE 'pool_%'"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        payload = json.loads(rows[0]["payload_json"])
        self.assertTrue(payload["_poolRefill"])
        self.assertFalse(payload["userInitiated"])
        self.assertEqual(payload["limit"], 15)
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now + 1))

    def test_due_persona_waits_while_its_user_fetch_is_still_active(self) -> None:
        now = int(time.time())
        self.store.submit(
            idempotency_key="capture:active-fetch:1234",
            request_digest="0" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_active_fetch",
            payload=self.pool_payload("archive_active_fetch", user_initiated=True),
        )
        with self.store._connection() as connection:
            connection.execute("UPDATE fetch_pool_targets SET next_run_at=?", (now,))
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now))
        with self.store._connection() as connection:
            target = connection.execute("SELECT next_run_at FROM fetch_pool_targets").fetchone()
            refill_count = connection.execute(
                "SELECT COUNT(*) FROM fetch_jobs WHERE unit_id LIKE 'pool_%'"
            ).fetchone()[0]
        self.assertEqual(target["next_run_at"], now + 60)
        self.assertEqual(refill_count, 0)

    def test_claim_next_prefers_interactive_job_over_earlier_pool_refill(self) -> None:
        self.store.submit(
            idempotency_key="pool:earlier-refill:1234",
            request_digest="1" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="pool_earlier_refill",
            payload={
                **self.pool_payload("archive_pool_first", user_initiated=False),
                "_poolRefill": True,
            },
        )
        interactive, _created = self.store.submit(
            idempotency_key="capture:interactive-second:1234",
            request_digest="2" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_interactive_second",
            payload=self.pool_payload("archive_interactive_second", user_initiated=True),
        )
        claimed = self.store.claim_next()
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed[0]["id"], interactive["id"])
        self.assertFalse(claimed[1].get("_poolRefill"))

    def test_preempt_background_refills_cancels_queued_pool_jobs(self) -> None:
        pool, _created = self.store.submit(
            idempotency_key="pool:preempt:1234",
            request_digest="3" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="pool_preempt",
            payload={
                **self.pool_payload("archive_preempt", user_initiated=False),
                "_poolRefill": True,
            },
        )
        running = self.store.preempt_background_refills()
        self.assertEqual(running, [])
        stored = self.store.get(pool["id"])
        self.assertEqual(stored["status"], "cancelled")

    def test_watermark_starts_below_15_and_stops_at_15(self) -> None:
        now = int(time.time())
        archive_id = "archive_full_water"
        self.store.submit(
            idempotency_key="capture:full-water:1234",
            request_digest="1" * 64,
            capability="persona.hot_candidates.v1",
            unit_id=archive_id,
            payload=self.pool_payload(archive_id, user_initiated=True),
        )
        original = self.store.claim_next()
        self.assertIsNotNone(original)
        self.store.finish(original[0]["id"], status="success", result={"ok": True})
        cache_dir = self.runtime_dir / "sentiment_threads_search_cache"
        cache_dir.mkdir()

        def write_candidates(count: int) -> None:
            rows = [
                {
                    "id": f"candidate-{index}",
                    "content": "useful persona candidate content " * 4,
                    "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                }
                for index in range(count)
            ]
            (cache_dir / f"{archive_id}-keywords-strict.json").write_text(
                json.dumps({f"{archive_id}::strict::query": {"candidates": rows}}),
                encoding="utf-8",
            )

        write_candidates(15)
        with self.store._connection() as connection:
            connection.execute("UPDATE fetch_pool_targets SET next_run_at=?", (now,))
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now))
        with self.store._connection() as connection:
            target = connection.execute("SELECT last_available_count FROM fetch_pool_targets").fetchone()
            refill_count = connection.execute(
                "SELECT COUNT(*) FROM fetch_jobs WHERE unit_id LIKE 'pool_%'"
            ).fetchone()[0]
        self.assertEqual(target["last_available_count"], 15)
        self.assertEqual(refill_count, 0)

        write_candidates(10)
        with self.store._connection() as connection:
            connection.execute(
                "UPDATE fetch_pool_targets SET last_run_at=last_user_fetch_at,next_run_at=?",
                (now,),
            )
        self.assertTrue(self.store.enqueue_due_pool_refill(now=now))
        refill = self.store.claim_next()
        self.assertIsNotNone(refill)
        self.store.finish(refill[0]["id"], status="success", result={"ok": True})

        write_candidates(15)
        with self.store._connection() as connection:
            connection.execute("UPDATE fetch_pool_targets SET next_run_at=?", (now + 601,))
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now + 601))
        with self.store._connection() as connection:
            target = connection.execute("SELECT last_available_count,last_run_at FROM fetch_pool_targets").fetchone()
        self.assertEqual(target["last_available_count"], 15)
        self.assertEqual(target["last_run_at"], 0)

    def test_expired_persona_target_is_removed_without_refill(self) -> None:
        now = int(time.time())
        self.store.submit(
            idempotency_key="capture:expired-water:1234",
            request_digest="2" * 64,
            capability="persona.hot_candidates.v1",
            unit_id="archive_expired_water",
            payload=self.pool_payload("archive_expired_water", user_initiated=True),
        )
        original = self.store.claim_next()
        self.assertIsNotNone(original)
        self.store.finish(original[0]["id"], status="success", result={"ok": True})
        with self.store._connection() as connection:
            connection.execute(
                "UPDATE fetch_pool_targets SET next_run_at=?,active_until=?",
                (now, now),
            )
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now))
        with self.store._connection() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM fetch_pool_targets").fetchone()[0], 0)

    def test_persona_hot_envelope_rejects_external_pool_refill(self) -> None:
        payload = self.pool_payload("archive_external_refill", user_initiated=False)
        payload["_poolRefill"] = True
        with self.assertRaisesRegex(ProtocolError, "cannot be submitted externally"):
            _validate_envelope(
                {
                    "capability": "persona.hot_candidates.v1",
                    "unit_id": "archive_external_refill",
                    "payload": payload,
                }
            )

    def test_persona_hot_envelope_keeps_new_host_keywords_and_drops_snapshot(self) -> None:
        capability, unit_id, payload = _validate_envelope(
            {
                "capability": "persona.hot_candidates.v1",
                "unit_id": "archive_empty_keywords",
                "payload": {
                    "action": "fetch-hot-candidates",
                    "archiveId": "archive_empty_keywords",
                    "archiveSnapshot": {"id": "archive_empty_keywords", "posts": []},
                    **current_keyword_strategy(["女性成长", "心理疗愈"]),
                    "liveOnly": False,
                    "recordShown": False,
                },
            }
        )
        self.assertEqual(capability, "persona.hot_candidates.v1")
        self.assertEqual(unit_id, "archive_empty_keywords")
        self.assertEqual(payload["archiveId"], "archive_empty_keywords")
        self.assertEqual(payload["keywords"], ["女性成长", "心理疗愈"])
        self.assertEqual(payload["archiveSnapshot"]["id"], "archive_empty_keywords")
        self.assertEqual(payload["archiveSnapshot"]["posts"], [])

    def test_persona_hot_envelope_rejects_empty_keywords_from_new_host(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "keywords"):
            _validate_envelope(
                {
                    "capability": "persona.hot_candidates.v1",
                    "unit_id": "archive_empty_keywords",
                    "payload": {
                        "action": "fetch-hot-candidates",
                        "archiveId": "archive_empty_keywords",
                        "keywords": [],
                        "liveOnly": False,
                        "recordShown": False,
                    },
                }
            )

    def test_persona_hot_envelope_requires_archive_id(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "archive id"):
            _validate_envelope(
                {
                    "capability": "persona.hot_candidates.v1",
                    "unit_id": "archive_missing_id",
                    "payload": {
                        "action": "fetch-hot-candidates",
                        **current_keyword_strategy(["女性成长"]),
                        "liveOnly": False,
                        "recordShown": False,
                    },
                }
            )

    def test_nonce_replay_is_persistently_rejected(self) -> None:
        now = int(time.time())
        self.store.use_nonce("capture-v1", "nonce_abcdefghijklmnop", now=now, ttl_seconds=120)
        restarted = JobStore(self.path)
        with self.assertRaises(ProtocolError):
            restarted.use_nonce("capture-v1", "nonce_abcdefghijklmnop", now=now + 1, ttl_seconds=120)

    def test_prune_removes_only_expired_terminal_jobs_and_expired_nonces(self) -> None:
        store = JobStore(
            self.path,
            terminal_retention_seconds=100,
            minimum_terminal_jobs=2,
        )
        rows = [
            ("job_" + "1" * 24, "success", 100),
            ("job_" + "2" * 24, "failed", 110),
            ("job_" + "3" * 24, "cancelled", 120),
            ("job_" + "4" * 24, "success", 950),
            ("job_" + "5" * 24, "queued", 100),
            ("job_" + "6" * 24, "running", 100),
        ]
        with store._connection() as connection:
            for index, (job_id, status, finished_at) in enumerate(rows):
                connection.execute(
                    """
                    INSERT INTO fetch_jobs(
                      id,idempotency_key,request_hash,capability,unit_id,payload_json,
                      status,created_at,updated_at,started_at,finished_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        job_id,
                        f"capture:retention:{index}",
                        str(index) * 64,
                        "persona.hot_candidates.v1",
                        f"unit-{index}",
                        '{"prompt":"must expire"}',
                        status,
                        finished_at,
                        finished_at,
                        finished_at if status == "running" else 0,
                        finished_at if status in {"success", "failed", "cancelled"} else 0,
                    ),
                )
            connection.execute(
                "INSERT INTO fetch_nonces(key_id,nonce,expires_at) VALUES('capture-v1','expired-nonce',500)"
            )
            connection.execute(
                "INSERT INTO fetch_nonces(key_id,nonce,expires_at) VALUES('capture-v1','recent-nonce',1200)"
            )

        store.prune(now=1000)
        with store._connection() as connection:
            remaining_jobs = {
                str(row["id"]): str(row["status"])
                for row in connection.execute("SELECT id,status FROM fetch_jobs")
            }
            remaining_nonces = {
                str(row["nonce"])
                for row in connection.execute("SELECT nonce FROM fetch_nonces")
            }

        self.assertNotIn("job_" + "1" * 24, remaining_jobs)
        self.assertNotIn("job_" + "2" * 24, remaining_jobs)
        self.assertIn("job_" + "3" * 24, remaining_jobs)
        self.assertIn("job_" + "4" * 24, remaining_jobs)
        self.assertEqual(remaining_jobs["job_" + "5" * 24], "queued")
        self.assertEqual(remaining_jobs["job_" + "6" * 24], "running")
        self.assertEqual(remaining_nonces, {"recent-nonce"})

    def test_failed_unit_can_be_retried_without_replaying_success(self) -> None:
        job, _ = self.submit()
        claimed, _payload = self.store.claim_next()
        self.assertEqual(claimed["id"], job["id"])
        self.store.finish(
            job["id"],
            status="failed",
            error={"code": "temporary", "retryable": True},
        )
        retried, created = self.store.retry(
            job["id"], idempotency_key="capture:retry:1234"
        )
        self.assertTrue(created)
        self.assertNotEqual(retried["id"], job["id"])

        claimed_retry, _payload = self.store.claim_next()
        self.store.finish(claimed_retry["id"], status="success", result={"ok": True})
        with self.assertRaises(ProtocolError):
            self.store.retry(
                claimed_retry["id"], idempotency_key="capture:retry:5678"
            )

    def test_runtime_executes_one_unit_and_persists_result(self) -> None:
        job, _ = self.submit()

        def runner(payload: dict, cancel_event: threading.Event) -> dict:
            self.assertFalse(cancel_event.is_set())
            return {"ok": True, "archiveId": payload["archiveId"]}

        runtime = WorkerRuntime(self.store, runner)
        runtime.start()
        runtime.wake()
        deadline = time.time() + 5
        state = None
        while time.time() < deadline:
            state = self.store.get(job["id"])
            if state and state["status"] == "success":
                break
            time.sleep(0.05)
        runtime.stop()
        self.assertIsNotNone(state)
        self.assertEqual(state["status"], "success")
        self.assertEqual(state["result"]["archiveId"], "archive_12345678")

    def test_runtime_starts_multiple_job_workers(self) -> None:
        with patch.dict(os.environ, {"TG_WORKER_JOB_CONCURRENCY": "3"}):
            runtime = WorkerRuntime(self.store, lambda _payload, _cancel: {"ok": True})
            runtime.start()
            try:
                self.assertEqual(len(runtime.threads), 3)
                self.assertTrue(all(thread.is_alive() for thread in runtime.threads))
            finally:
                runtime.stop()
        self.assertEqual(runtime.threads, [])


class RemoteFetchIsolationTests(unittest.TestCase):
    def test_runtime_sync_contains_only_empty_persona_scaffolds_and_allowlisted_profiles(self) -> None:
        script = (Path(__file__).parents[2] / "scripts" / "sync_capture_worker_runtime.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("printf '[]\\n'", script)
        self.assertGreaterEqual(script.count("printf '{}\\n'"), 3)
        self.assertNotIn('cp -- "$source_runtime/persona_archives.json"', script)
        self.assertNotIn('cp -- "$sentiment_source"', script)
        self.assertIn('allowed_platforms = {"threads", "instagram"}', script)
        self.assertIn('"cookieDomains", "matchDomains", "urlTemplate", "linkPattern", "cookies"', script)
        self.assertIn('blocked_cookie_names = {"authhelpertoken", "api_token", "api_key", "apikey", "llm_key"}', script)
        self.assertIn("if cookie_name in blocked_cookie_names:", script)
        self.assertIn("clean_profile[key] = clean_cookies", script)
        self.assertNotIn("filtered.append({key: profile[key]", script)

    def test_hot_reader_profile_enables_only_the_requested_platform(self) -> None:
        threads_env: dict[str, str] = {}
        instagram_env: dict[str, str] = {}
        _apply_hot_reader_execution_profile(threads_env, background_refill=False, platform="threads")
        _apply_hot_reader_execution_profile(instagram_env, background_refill=False, platform="instagram")
        refill_env: dict[str, str] = {}
        _apply_hot_reader_execution_profile(refill_env, background_refill=True, platform="threads")
        self.assertEqual(refill_env["SENTIMENT_HOT_READER_CONCURRENCY"], "2")
        self.assertEqual(threads_env["TG_HOT_READER_INCLUDE_INSTAGRAM"], "0")
        self.assertEqual(instagram_env["TG_HOT_READER_INCLUDE_INSTAGRAM"], "1")
        self.assertNotEqual(
            threads_env["TG_HOT_READER_INCLUDE_INSTAGRAM"],
            instagram_env["TG_HOT_READER_INCLUDE_INSTAGRAM"],
        )

    def test_worker_import_does_not_import_full_server(self) -> None:
        code = (
            "import os,sys;"
            "os.environ['TG_FETCH_WORKER_AUTOCREATE']='0';"
            "import webapp.worker_server;"
            "assert 'webapp.server' not in sys.modules"
        )
        subprocess.run([sys.executable, "-c", code], check=True, cwd=Path(__file__).parents[2])

    def test_worker_routes_are_internal_only(self) -> None:
        settings = WorkerSettings(
            keys={"capture-v1": "worker-secret-" + "x" * 48},
            database_path=Path(self._testMethodName + ".db").resolve(),
            runtime_dir=Path(".").resolve(),
        )
        try:
            app = create_worker_app(settings, runner=lambda payload, cancel: {"ok": True})
            paths = {route.path for route in app.routes}
            self.assertIn("/health", paths)
            self.assertIn("/internal/worker/v1/jobs", paths)
            self.assertIn("/internal/worker/v1/hot-datasets/refresh", paths)
            self.assertIn("/internal/worker/v1/hot-datasets/events", paths)
            self.assertIn("/internal/worker/v1/hot-datasets/settings", paths)
            self.assertIn("/internal/worker/v1/hot-datasets/events/{event_id}", paths)
            self.assertIn("/internal/worker/v1/hot-datasets/{dataset_id}", paths)
            self.assertNotIn("/api/auth/login", paths)
            self.assertNotIn("/api/crm/v1/bootstrap", paths)
        finally:
            settings.database_path.unlink(missing_ok=True)
            Path(str(settings.database_path) + "-wal").unlink(missing_ok=True)
            Path(str(settings.database_path) + "-shm").unlink(missing_ok=True)

    def test_capability_routes_persona_through_old_host_pool_and_removes_secrets(self) -> None:
        capability, unit_id, payload = _validate_envelope(
            {
                "capability": "persona.hot_candidates.v1",
                "unit_id": "archive_12345678",
                "payload": {
                    "archiveId": "archive_12345678",
                    "archiveSnapshot": {"id": "archive_12345678", "posts": []},
                    **current_keyword_strategy(["理发师", "理发店趣事"]),
                    "liveOnly": False,
                    "recordShown": False,
                    "cookies": ["must-not-cross-control-boundary"],
                    "accountId": "new-host-account",
                    "senderUsername": "new-host-user",
                    "user_id": 42,
                    "profile_dir": "/new-host/private-profile",
                },
            }
        )
        self.assertEqual(capability, "persona.hot_candidates.v1")
        self.assertEqual(unit_id, "archive_12345678")
        self.assertNotIn("cookies", payload)
        self.assertNotIn("accountId", payload)
        self.assertNotIn("senderUsername", payload)
        self.assertNotIn("user_id", payload)
        self.assertNotIn("profile_dir", payload)
        self.assertEqual(payload["_workerCapability"], "persona.hot_candidates.v1")
        self.assertEqual(payload["archiveId"], "archive_12345678")
        self.assertEqual(payload["keywords"], ["理发师", "理发店趣事"])
        self.assertEqual(payload["archiveSnapshot"]["id"], "archive_12345678")
        self.assertEqual(payload["archiveSnapshot"]["posts"], [])
        with self.assertRaises(ProtocolError):
            _validate_envelope(
                {
                    "capability": "persona.hot_candidates.v1",
                    "unit_id": "archive_12345678",
                    "payload": {"liveOnly": True, "recordShown": False},
                }
            )

    def test_keyword_job_uses_local_archive_without_leasing_account(self) -> None:
        class FakePool:
            def acquire(self, **_kwargs):
                raise AssertionError("keyword prep must not lease an account")

        class FakeProcess:
            returncode = 0

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps({"ok": True, "keywords": ["理发师"], "archiveName": "理发师"}), ""

        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=FakePool()),
            patch("webapp.worker_server.subprocess.Popen", return_value=FakeProcess()) as popen,
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "persona.hot_keywords.v1",
                    "action": "prepare-hot-keywords",
                    "archiveId": "archive_12345678",
                    "searchMode": "strict",
                },
                threading.Event(),
            )

        self.assertEqual(result["keywords"], ["理发师"])
        sent = json.loads(popen.call_args.args[0][-1])
        self.assertEqual(sent["action"], "prepare-hot-keywords")
        self.assertEqual(sent["archiveId"], "archive_12345678")
        self.assertNotIn("archiveSnapshot", sent)

    def test_keyword_capability_uses_local_archive_id_only(self) -> None:
        capability, unit_id, payload = _validate_envelope(
            {
                "capability": "persona.hot_keywords.v1",
                "unit_id": "archive_12345678",
                "payload": {
                    "archiveId": "archive_12345678",
                    "archiveSnapshot": {"id": "archive_12345678", "posts": []},
                    "searchMode": "strict",
                },
            }
        )
        self.assertEqual(capability, "persona.hot_keywords.v1")
        self.assertEqual(unit_id, "archive_12345678")
        self.assertEqual(payload["action"], "prepare-hot-keywords")
        self.assertEqual(payload["archiveId"], "archive_12345678")
        self.assertEqual(payload["searchMode"], "strict")
        self.assertEqual(payload["archiveSnapshot"]["id"], "archive_12345678")

    def test_profile_metrics_capability_leases_collector_viewer_and_hides_secrets(self) -> None:
        capability, unit_id, payload = _validate_envelope(
            {
                "capability": "persona.profile_metrics.v1",
                "unit_id": "archive_12345678",
                "payload": {
                    "action": "refresh-profile-metrics",
                    "archiveId": "archive_12345678",
                    "username": "sherryjim68",
                    "platform": "threads",
                    "outputOnly": True,
                    "profile_dir": "/new-host/private-profile",
                    "accountId": "must-not-cross",
                    "cookies": ["secret"],
                },
            }
        )
        self.assertEqual(capability, "persona.profile_metrics.v1")
        self.assertEqual(payload["action"], "refresh-profile-metrics")
        self.assertEqual(payload["username"], "sherryjim68")
        self.assertEqual(payload["platform"], "threads")
        self.assertIs(payload["outputOnly"], True)
        self.assertNotIn("profile_dir", payload)
        self.assertNotIn("accountId", payload)
        self.assertNotIn("cookies", payload)
        with self.assertRaisesRegex(ProtocolError, "output-only"):
            _validate_envelope(
                {
                    "capability": "persona.profile_metrics.v1",
                    "unit_id": "archive_12345678",
                    "payload": {
                        "archiveId": "archive_12345678",
                        "username": "sherryjim68",
                        "platform": "threads",
                    },
                }
            )

        class FakePool:
            def __init__(self):
                self.released = []

            def acquire(self, **kwargs):
                self.acquire_args = kwargs
                return {"lease_id": "collease_profile", "account": {"id": "colacct_viewer"}}

            def use_runtime_profile(self, _lease_id, *, holder, consumer):
                return consumer({
                    "platform": "threads",
                    "profile_dir": "/collector/profiles/viewer",
                    "account_id": "colacct_viewer",
                    "proxy_id": "2301582",
                })

            def release(self, lease_id, **kwargs):
                self.released.append((lease_id, kwargs))

        class FakeProcess:
            returncode = 0

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps({
                    "ok": True,
                    "outputOnly": True,
                    "username": "sherryjim68",
                    "metrics": {"complete": True, "scannedPosts": 6},
                }), ""

        pool = FakePool()
        observed = {}

        def popen(command, **kwargs):
            observed["env"] = kwargs["env"]
            observed["command"] = command
            return FakeProcess()

        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=pool),
            patch(
                "webapp.worker_server.runtime_account_proxy_url",
                return_value="http://viewer:sess@thehub.proxy-cheap.com:8080",
            ) as resolve_proxy,
            patch("webapp.worker_server.subprocess.Popen", side_effect=popen),
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "persona.profile_metrics.v1",
                    "action": "refresh-profile-metrics",
                    "archiveId": "archive_12345678",
                    "username": "sherryjim68",
                    "platform": "threads",
                    "outputOnly": True,
                    "profileDir": "/must-not-reach-node",
                },
                threading.Event(),
            )

        self.assertTrue(result["ok"])
        sent = json.loads(observed["command"][-1])
        self.assertEqual(sent["action"], "refresh-profile-metrics")
        self.assertEqual(sent["username"], "sherryjim68")
        self.assertNotIn("profileDir", sent)
        self.assertEqual(observed["env"]["PERSONA_DASHBOARD_THREADS_PROFILE_DIR"], "/collector/profiles/viewer")
        self.assertEqual(observed["env"]["TG_COLLECTOR_PROFILE_REQUIRED"], "1")
        self.assertNotIn("PERSONA_DASHBOARD_THREADS_PROXY_URL", observed["env"])
        resolve_proxy.assert_not_called()
        self.assertEqual(pool.acquire_args["capability"], "persona.profile_metrics.v1")
        self.assertEqual(pool.acquire_args["exclude_usernames"], ("sherryjim68",))
        self.assertTrue(pool.acquire_args.get("rotate"))
        self.assertTrue(pool.released[0][1]["succeeded"])

    def test_profile_metrics_fails_immediately_when_no_logged_in_collector_exists(self) -> None:
        class EmptyPool:
            def acquire(self, **kwargs):
                raise NoCollectorAccountAvailableError("no collector account is currently available")

            def use_runtime_profile(self, *args, **kwargs):
                raise AssertionError("must not open a collector profile without a lease")

            def release(self, *args, **kwargs):
                raise AssertionError("must not release a lease that was never acquired")

        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=EmptyPool()),
            patch("webapp.worker_server.subprocess.Popen") as popen,
        ):
            with self.assertRaisesRegex(RuntimeError, "no healthy collector account is currently available"):
                run_tool_r18_job(
                    {
                        "_workerCapability": "persona.profile_metrics.v1",
                        "action": "refresh-profile-metrics",
                        "archiveId": "archive_12345678",
                        "username": "le.huuuczxsn.196960",
                        "platform": "instagram",
                        "outputOnly": True,
                    },
                    threading.Event(),
                )
        popen.assert_not_called()

    def test_profile_metrics_failed_http_does_not_mark_collector_healthy(self) -> None:
        class FakePool:
            def __init__(self):
                self.released = []

            def acquire(self, **kwargs):
                return {"lease_id": "collease_failed", "account": {"id": "colacct_viewer"}}

            def use_runtime_profile(self, _lease_id, *, holder, consumer):
                return consumer({
                    "platform": "threads",
                    "profile_dir": "/collector/profiles/viewer",
                    "account_id": "colacct_viewer",
                    "proxy_id": "2301582",
                })

            def release(self, lease_id, **kwargs):
                self.released.append((lease_id, kwargs))

        class FakeProcess:
            returncode = 0

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps({
                    "ok": True,
                    "username": "sherryjim68",
                    "metrics": {
                        "method": "failed",
                        "complete": False,
                        "error": "fetch failed: redirect count exceeded",
                    },
                }), ""

        pool = FakePool()
        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=pool),
            patch("webapp.worker_server.runtime_account_proxy_url", return_value="http://viewer@proxy:8080"),
            patch("webapp.worker_server.subprocess.Popen", return_value=FakeProcess()),
        ):
            with self.assertRaisesRegex(RuntimeError, "redirect count exceeded"):
                run_tool_r18_job(
                    {
                        "_workerCapability": "persona.profile_metrics.v1",
                        "action": "refresh-profile-metrics",
                        "archiveId": "archive_12345678",
                        "username": "sherryjim68",
                        "platform": "threads",
                        "outputOnly": True,
                    },
                    threading.Event(),
                )
        self.assertEqual(pool.released[0][1]["succeeded"], False)

    def test_runtime_uses_only_the_leased_collector_profile(self) -> None:
        class FakePool:
            def __init__(self):
                self.released = []

            def acquire(self, **kwargs):
                self.acquire_args = kwargs
                return {"lease_id": "collease_12345678", "account": {"id": "colacct_hidden"}}

            def use_runtime_profile(self, _lease_id, *, holder, consumer):
                self.holder = holder
                return consumer({"platform": "threads", "profile_dir": "/collector/profiles/one"})

            def release(self, lease_id, **kwargs):
                self.released.append((lease_id, kwargs))

        class FakeProcess:
            returncode = 0

            def __init__(self, body):
                self.body = body

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps(self.body), ""

        pool = FakePool()
        observed = {}

        responses = [
            {"ok": True, "candidates": [{"id": "candidate-1", "hotScore": 800}]},
        ]

        def popen(command, **kwargs):
            observed["command"] = command
            observed["env"] = kwargs["env"]
            return FakeProcess(responses.pop(0))

        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=pool),
            patch("webapp.worker_server.subprocess.Popen", side_effect=popen),
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "crm.threads_live_search.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "threads",
                    "limit": 1,
                    "recordShown": False,
                    "accountId": "must-not-reach-node",
                },
                threading.Event(),
            )

        self.assertTrue(result["ok"])
        sent = json.loads(observed["command"][-1])
        self.assertNotIn("_workerCapability", sent)
        self.assertNotIn("accountId", sent)
        self.assertEqual(sent["sourcePolicy"], "authenticated_only")
        self.assertFalse(sent["recordShown"])
        self.assertEqual(
            observed["env"]["PERSONA_DASHBOARD_THREADS_PROFILE_DIR"],
            "/collector/profiles/one",
        )
        self.assertEqual(observed["env"]["TG_COLLECTOR_PROFILE_REQUIRED"], "1")
        self.assertEqual(pool.acquire_args["capability"], "crm.threads_live_search.v1")
        self.assertTrue(pool.released[0][1]["succeeded"])

    def test_background_refill_uses_reader_without_leasing_account(self) -> None:
        class FakePool:
            def acquire(self, **_kwargs):
                raise AssertionError("reader-only pass must not lease an account")

        class FakeProcess:
            returncode = 0

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps({
                    "ok": True,
                    "candidates": [
                        {"id": "reader-1", "hotScore": 900},
                        {"id": "reader-2", "hotScore": 800},
                    ],
                }), ""

        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=FakePool()),
            patch("webapp.worker_server.subprocess.Popen", return_value=FakeProcess()) as popen,
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "persona.hot_candidates.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "threads",
                    **current_keyword_strategy(["理发师", "理发店趣事"]),
                    "limit": 2,
                    "_poolRefill": True,
                    "userInitiated": False,
                },
                threading.Event(),
            )

        self.assertEqual([row["id"] for row in result["candidates"]], ["reader-1", "reader-2"])
        sent = json.loads(popen.call_args.args[0][-1])
        self.assertEqual(sent["sourcePolicy"], "reader_only")
        self.assertFalse(sent["recordShown"])
        self.assertNotIn("userInitiated", sent)
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_CONCURRENCY"], "2")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_SERIAL_PLATFORMS"], "1")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_TOTAL_TIMEOUT_MS"], "55000")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_JITTER_MAX_MS"], "5000")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_MAX_ATTEMPTS"], "2")
        self.assertEqual(popen.call_args.kwargs["env"]["TG_HOT_READER_INCLUDE_INSTAGRAM"], "0")

    def test_interactive_hot_fetch_uses_reader_without_leasing_account(self) -> None:
        class FakePool:
            def __init__(self):
                self.acquired = 0
                self.released = []

            def acquire(self, **_kwargs):
                raise AssertionError("interactive Reader fetch must not lease an account")

            def use_runtime_profile(self, _lease_id, *, holder, consumer):
                return consumer({"platform": "threads", "profile_dir": f"/collector/profiles/{self.acquired}"})

            def release(self, lease_id, **kwargs):
                self.released.append((lease_id, kwargs))

        class FakeProcess:
            returncode = 0

            def __init__(self, body):
                self.body = body

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps(self.body), ""

        pool = FakePool()
        responses = [
            {"ok": True, "candidates": [
                {"id": "one", "hotScore": 600},
                {"id": "two", "hotScore": 900},
                {"id": "three", "hotScore": 700},
            ]},
        ]
        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=pool),
            patch("webapp.worker_server.subprocess.Popen", side_effect=lambda *_args, **_kwargs: FakeProcess(responses.pop(0))) as popen,
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "persona.hot_candidates.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "threads",
                    **current_keyword_strategy(["理发师", "理发店趣事"]),
                    "limit": 10,
                },
                threading.Event(),
            )

        self.assertEqual(pool.acquired, 0)
        self.assertEqual([item["id"] for item in result["candidates"]], ["one", "two", "three"])
        self.assertEqual(len(pool.released), 0)
        self.assertEqual(len(responses), 0)
        sent = json.loads(popen.call_args.args[0][-1])
        self.assertEqual(sent["sourcePolicy"], "reader_only")
        self.assertTrue(sent["recordShown"])
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_CONCURRENCY"], "24")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_SERIAL_PLATFORMS"], "0")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_TOTAL_TIMEOUT_MS"], "45000")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_JITTER_MAX_MS"], "200")
        self.assertEqual(popen.call_args.kwargs["env"]["SENTIMENT_HOT_READER_MAX_ATTEMPTS"], "1")
        self.assertEqual(popen.call_args.kwargs["env"]["TG_HOT_READER_INCLUDE_INSTAGRAM"], "0")

    def test_interactive_instagram_hot_fetch_does_not_enable_threads_companion(self) -> None:
        class FakeProcess:
            returncode = 0

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps({"ok": True, "candidates": [{"id": "ig-1", "platform": "instagram", "hotScore": 700}]}), ""

        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=None),
            patch("webapp.worker_server.subprocess.Popen", return_value=FakeProcess()) as popen,
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "persona.hot_candidates.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "instagram",
                    **current_keyword_strategy(["理发师", "理发店趣事"]),
                    "limit": 10,
                },
                threading.Event(),
            )

        self.assertEqual([item["id"] for item in result["candidates"]], ["ig-1"])
        sent = json.loads(popen.call_args.args[0][-1])
        self.assertEqual(sent["platform"], "instagram")
        self.assertEqual(popen.call_args.kwargs["env"]["TG_HOT_READER_INCLUDE_INSTAGRAM"], "1")

    def test_crm_live_search_rotates_account_after_sparse_result(self) -> None:
        class FakePool:
            def __init__(self):
                self.acquired = 0
                self.released = []

            def acquire(self, **_kwargs):
                self.acquired += 1
                return {"lease_id": f"collease_{self.acquired:08d}", "account": {"id": f"account-{self.acquired}"}}

            def use_runtime_profile(self, _lease_id, *, holder, consumer):
                return consumer({"platform": "threads", "profile_dir": f"/collector/profiles/{self.acquired}"})

            def release(self, lease_id, **kwargs):
                self.released.append((lease_id, kwargs))

        class FakeProcess:
            returncode = 0

            def __init__(self, body):
                self.body = body

            def poll(self):
                return 0

            def communicate(self):
                return json.dumps(self.body), ""

        pool = FakePool()
        responses = [
            {"ok": True, "candidates": [{"id": "one", "hotScore": 600}]},
            {"ok": True, "candidates": [
                {"id": "two", "hotScore": 900},
                {"id": "three", "hotScore": 700},
                {"id": "four", "hotScore": 650},
            ]},
        ]
        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=pool),
            patch("webapp.worker_server.subprocess.Popen", side_effect=lambda *_args, **_kwargs: FakeProcess(responses.pop(0))),
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "crm.threads_live_search.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "threads",
                    "limit": 10,
                },
                threading.Event(),
            )

        self.assertEqual(pool.acquired, 2)
        self.assertEqual([item["id"] for item in result["candidates"]], ["two", "three", "four"])
        self.assertFalse(pool.released[0][1]["succeeded"])
        self.assertTrue(pool.released[1][1]["succeeded"])

    def test_capability_requires_current_snapshot_and_hides_unimplemented_dashboard(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "archive snapshot"):
            _validate_envelope(
                {
                    "capability": "crm.threads_live_search.v1",
                    "unit_id": "archive_12345678",
                    "payload": {
                        "archiveId": "archive_12345678",
                        "liveOnly": True,
                        "recordShown": False,
                    },
                }
            )
        with self.assertRaisesRegex(ProtocolError, "not allowed"):
            _validate_envelope(
                {
                    "capability": "persona.dashboard_metrics.v1",
                    "unit_id": "archive_12345678",
                    "payload": {},
                }
            )


if __name__ == "__main__":
    unittest.main()
