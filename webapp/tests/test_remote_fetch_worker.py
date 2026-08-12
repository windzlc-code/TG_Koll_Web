from __future__ import annotations

import json
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
from webapp.worker_server import (
    JobStore,
    WorkerRuntime,
    WorkerSettings,
    _validate_envelope,
    create_worker_app,
    run_tool_r18_job,
)


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
        self.store = JobStore(self.path)

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

    def test_persona_target_is_registered_for_old_host_low_frequency_refill(self) -> None:
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
                "liveOnly": False,
                "recordShown": False,
                "limit": 10,
            },
        )
        original = self.store.claim_next()
        self.assertIsNotNone(original)
        self.store.finish(original[0]["id"], status="success", result={"ok": True})
        self.assertFalse(self.store.enqueue_due_pool_refill(now=now))
        self.assertTrue(self.store.enqueue_due_pool_refill(now=now + 21601))
        queued = self.store.claim_next()
        self.assertIsNotNone(queued)
        _job, payload = queued
        self.assertTrue(payload["_poolRefill"])
        self.assertFalse(payload["liveOnly"])
        self.assertEqual(payload["limit"], 20)

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
        with self.assertRaises(ProtocolError):
            _validate_envelope(
                {
                    "capability": "persona.hot_candidates.v1",
                    "unit_id": "archive_12345678",
                    "payload": {"liveOnly": True, "recordShown": False},
                }
            )

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
            {"ok": True, "candidates": []},
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
                    "_workerCapability": "persona.hot_candidates.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "threads",
                    "limit": 1,
                    "accountId": "must-not-reach-node",
                },
                threading.Event(),
            )

        self.assertTrue(result["ok"])
        sent = json.loads(observed["command"][-1])
        self.assertNotIn("_workerCapability", sent)
        self.assertNotIn("accountId", sent)
        self.assertEqual(
            observed["env"]["PERSONA_DASHBOARD_THREADS_PROFILE_DIR"],
            "/collector/profiles/one",
        )
        self.assertEqual(observed["env"]["TG_COLLECTOR_PROFILE_REQUIRED"], "1")
        self.assertEqual(pool.acquire_args["capability"], "persona.hot_candidates.v1")
        self.assertTrue(pool.released[0][1]["succeeded"])

    def test_runtime_does_not_lease_account_when_reader_pool_is_sufficient(self) -> None:
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
                    "limit": 2,
                },
                threading.Event(),
            )

        self.assertEqual([row["id"] for row in result["candidates"]], ["reader-1", "reader-2"])
        sent = json.loads(popen.call_args.args[0][-1])
        self.assertEqual(sent["sourcePolicy"], "reader_only")

    def test_runtime_rotates_collector_account_when_first_result_is_sparse(self) -> None:
        class FakePool:
            def __init__(self):
                self.acquired = 0
                self.released = []

            def acquire(self, **_kwargs):
                self.acquired += 1
                return {"lease_id": f"collease_{self.acquired:08d}", "account": {"id": "hidden"}}

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
                {"id": "one", "hotScore": 600},
                {"id": "two", "hotScore": 900},
                {"id": "three", "hotScore": 700},
            ]},
        ]
        with (
            patch("webapp.worker_server._configured_collector_pool", return_value=pool),
            patch("webapp.worker_server.subprocess.Popen", side_effect=lambda *_args, **_kwargs: FakeProcess(responses.pop(0))),
        ):
            result = run_tool_r18_job(
                {
                    "_workerCapability": "persona.hot_candidates.v1",
                    "action": "fetch-hot-candidates",
                    "platform": "threads",
                    "limit": 10,
                },
                threading.Event(),
            )

        self.assertEqual(pool.acquired, 1)
        self.assertEqual([item["id"] for item in result["candidates"]], ["two", "three", "one"])
        self.assertEqual(len(pool.released), 1)
        self.assertTrue(pool.released[0][1]["succeeded"])

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
