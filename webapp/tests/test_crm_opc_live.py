import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from webapp import db as db_module
from webapp.crm.errors import CRMError
from webapp.crm.legacy_operations import HOTSPOT_SCHEMA, OPC_QUERY_SCHEMA, TenantContext
from webapp.crm.opc_live import (
    HISTORY_SOURCE_KIND,
    LIVE_SOURCE_KIND,
    THREADS_SEARCH_SCHEMA,
    query_opc_history_realtime,
    search_hotspots_live,
    search_threads_live,
)
from webapp.crm.repository import create_resource


class CRMOPCLiveAdapterTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            key: os.environ.get(key)
            for key in ("APP_DB_PATH", "WEBAPP_DATA_DIR")
        }
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            self.user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('opc_live_owner','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            self.other_user_id = int(
                conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                    "VALUES ('opc_live_other','x',1,0,'approved',?,?)",
                    (now, now),
                ).lastrowid
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('threads-live',?,'persona-live','threads','sender','profiles/live','ready','alive',?,?)",
                (self.user_id, now, now),
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('threads-login',?,'persona-login','threads','login_sender','profiles/login','needs_login','needs_login',?,?)",
                (self.user_id, now, now),
            )
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,health_status,created_at,updated_at) "
                "VALUES ('threads-foreign',?,'persona-foreign','threads','foreign','profiles/foreign','ready','alive',?,?)",
                (self.other_user_id, now, now),
            )

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    @staticmethod
    def _live_result():
        current = datetime.now(timezone.utc)
        return {
            "ok": True,
            "liveOnly": True,
            "warnings": ["live source returned a partial page"],
            "candidates": [
                {
                    "id": "candidate-low",
                    "platform": "threads",
                    "author": "@low",
                    "content": "low engagement",
                    "sourceUrl": "https://www.threads.net/@low/post/1",
                    "engagement": {"likes": 3, "comments": 0, "shares": 0},
                    "capturedAt": "2026-08-10T00:00:00Z",
                    "publishedAt": (current - timedelta(days=2)).isoformat(),
                },
                {
                    "id": "candidate-high",
                    "platform": "threads",
                    "author": "high",
                    "content": "high engagement",
                    "sourceUrl": "https://www.threads.com/@high/post/2",
                    "metrics": {"likeCount": 1, "replyCount": 4, "repostCount": 2},
                    "publishedAt": (current - timedelta(days=1)).isoformat(),
                },
                {
                    "id": "instagram-result",
                    "platform": "instagram",
                    "sourceUrl": "https://www.instagram.com/p/ignored/",
                },
                {
                    "id": "unsafe-result",
                    "platform": "threads",
                    "sourceUrl": "http://www.threads.net/@unsafe/post/3",
                },
                {
                    "id": "duplicate-result",
                    "platform": "threads",
                    "sourceUrl": "https://www.threads.com/@high/post/2",
                },
            ],
        }

    def test_threads_search_uses_tenant_account_and_live_only_executor_contract(self):
        observed = {}

        def executor(request):
            observed.update(request)
            return self._live_result()

        with db_module.db() as conn:
            result = search_threads_live(
                conn,
                TenantContext(self.user_id, request_id="req-live-1"),
                {
                    "query": "AI 营销",
                    "accountId": "threads-live",
                    "limit": 999,
                    "scrollRounds": 99,
                    "delayMs": 1,
                },
                executor=executor,
            )
        self.assertEqual(result["schemaVersion"], THREADS_SEARCH_SCHEMA)
        self.assertEqual(result["accountId"], "threads-live")
        self.assertEqual(result["count"], 2)
        self.assertTrue(result["source"]["livePlatform"])
        self.assertEqual(result["source"]["kind"], LIVE_SOURCE_KIND)
        self.assertFalse(result["source"]["historyFallback"])
        self.assertEqual(result["source"]["executorMaxResults"], 20)
        self.assertTrue(result["truncated"])
        self.assertIn("at most 20", result["warning"])
        self.assertTrue(all(row["live"] for row in result["data"]))
        self.assertTrue(all(row["sourceKind"] == LIVE_SOURCE_KIND for row in result["data"]))
        self.assertEqual(observed["archiveId"], "persona-live")
        self.assertEqual(observed["senderUsername"], "sender")
        self.assertEqual(observed["limit"], 200)
        self.assertEqual(observed["scrollRounds"], 30)
        self.assertEqual(observed["delayMs"], 500)
        self.assertTrue(observed["refresh"])
        self.assertTrue(observed["liveOnly"])
        self.assertFalse(observed["recordShown"])

    def test_collector_search_uses_ephemeral_snapshot_without_tenant_account_identity(self):
        observed = {}

        def executor(request):
            observed.update(request)
            return self._live_result()

        with db_module.db() as conn:
            result = search_threads_live(
                conn,
                TenantContext(999_999, locale="zh-Hans", request_id="req-collector-1"),
                {
                    "query": "AI 营销",
                    "accountId": "threads-foreign",
                    "senderUsername": "must-not-leave-new-host",
                    "user_id": 999_999,
                    "cookies": [{"name": "sessionid", "value": "secret"}],
                    "password": "secret",
                    "totp": "secret",
                },
                executor=executor,
                collector_mode=True,
            )

        self.assertEqual(result["count"], 2)
        self.assertEqual(result["source"]["accountScope"], "collector_pool")
        self.assertNotIn("accountId", result)
        self.assertNotIn("senderUsername", result)
        self.assertNotIn("accountId", result["source"])
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
        ):
            self.assertNotIn(forbidden, observed)
        self.assertEqual(observed["accountScope"], "collector_pool")
        self.assertTrue(observed["archiveId"].startswith("crm-search-"))
        self.assertEqual(observed["archiveSnapshot"]["id"], observed["archiveId"])
        self.assertEqual(observed["archiveSnapshot"]["content"], "AI 营销")
        self.assertEqual(observed["archiveSnapshot"]["posts"], [])
        self.assertEqual(
            set(observed["archiveSnapshot"]),
            {"id", "name", "content", "setup", "posts"},
        )

    def test_hotspot_search_preserves_legacy_shape_and_engagement_sort(self):
        with db_module.db() as conn:
            result = search_hotspots_live(
                conn,
                TenantContext(self.user_id),
                {"query": "AI 营销", "accountId": "threads-live", "limit": 30},
                executor=lambda _request: self._live_result(),
            )
        self.assertEqual(result["schemaVersion"], HOTSPOT_SCHEMA)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["data"][0]["id"], "candidate-high")
        self.assertEqual(result["data"][0]["engagement"], 15)
        self.assertTrue(result["livePlatform"])
        self.assertFalse(result["historyFallback"])
        self.assertEqual(result["source"]["provider"], "tg_sentiment_hot")

    def test_unattested_cache_or_history_result_is_never_reported_as_live(self):
        for result in (
            {"ok": True, "data": []},
            {"ok": True, "live": True, "sourceKind": "history", "data": []},
            {"ok": True, "liveOnly": True, "historyFallback": True, "data": []},
            {"ok": True, "live": True, "sourceKind": "mock", "data": []},
        ):
            with self.subTest(result=result), db_module.db() as conn:
                with self.assertRaises(CRMError) as raised:
                    search_threads_live(
                        conn,
                        TenantContext(self.user_id),
                        {"query": "AI 营销", "accountId": "threads-live"},
                        executor=lambda _request, value=result: value,
                    )
                self.assertEqual(raised.exception.code, "crm_threads_live_evidence_required")

    def test_empty_attested_live_result_stays_empty_without_history_fallback(self):
        with db_module.db() as conn:
            result = search_threads_live(
                conn,
                TenantContext(self.user_id),
                {"query": "no visible results", "accountId": "threads-live"},
                executor=lambda _request: {"ok": True, "liveOnly": True, "candidates": []},
            )
        self.assertEqual(result["data"], [])
        self.assertEqual(result["count"], 0)
        self.assertFalse(result["source"]["historyFallback"])
        self.assertTrue(result["zeroResultRecovery"]["can_retry"])

    def test_explicit_time_window_is_forwarded_and_filters_unverifiable_rows(self):
        observed = {}
        current = datetime.now(timezone.utc)

        def executor(request):
            observed.update(request)
            return {
                "ok": True,
                "liveOnly": True,
                "candidates": [
                    {
                        "id": "recent",
                        "platform": "threads",
                        "sourceUrl": "https://www.threads.com/@recent/post/1",
                        "publishedAt": (current - timedelta(days=1)).isoformat(),
                    },
                    {
                        "id": "old",
                        "platform": "threads",
                        "sourceUrl": "https://www.threads.com/@old/post/2",
                        "publishedAt": (current - timedelta(days=10)).isoformat(),
                    },
                    {
                        "id": "unknown",
                        "platform": "threads",
                        "sourceUrl": "https://www.threads.com/@unknown/post/3",
                    },
                ],
            }

        with db_module.db() as conn:
            result = search_threads_live(
                conn,
                TenantContext(self.user_id),
                {
                    "query": "AI 营销",
                    "accountId": "threads-live",
                    "lookbackDays": 7,
                },
                executor=executor,
            )
        self.assertEqual(observed["freshnessDays"], 7)
        self.assertEqual([row["id"] for row in result["data"]], ["recent"])
        self.assertEqual(result["timeWindow"]["excluded_older"], 1)
        self.assertEqual(result["timeWindow"]["excluded_unknown"], 1)

    def test_default_time_window_is_enforced_on_returned_rows(self):
        current = datetime.now(timezone.utc)
        with db_module.db() as conn:
            result = search_threads_live(
                conn,
                TenantContext(self.user_id),
                {"query": "AI 营销", "accountId": "threads-live"},
                executor=lambda _request: {
                    "ok": True,
                    "liveOnly": True,
                    "candidates": [
                        {
                            "id": "recent-default",
                            "platform": "threads",
                            "sourceUrl": "https://www.threads.com/@recent/post/default",
                            "publishedAt": (current - timedelta(days=1)).isoformat(),
                        },
                        {
                            "id": "old-default",
                            "platform": "threads",
                            "sourceUrl": "https://www.threads.com/@old/post/default",
                            "publishedAt": (current - timedelta(days=8)).isoformat(),
                        },
                        {
                            "id": "unknown-default",
                            "platform": "threads",
                            "sourceUrl": "https://www.threads.com/@unknown/post/default",
                        },
                    ],
                },
            )
        self.assertEqual([row["id"] for row in result["data"]], ["recent-default"])
        self.assertEqual(result["timeWindow"]["lookback_days"], 7)
        self.assertEqual(result["timeWindow"]["excluded_older"], 1)
        self.assertEqual(result["timeWindow"]["excluded_unknown"], 1)

    def test_attested_batch_still_rejects_a_row_declared_as_mock_or_cache(self):
        for marker in ("mock", "cache_fallback"):
            with self.subTest(marker=marker), db_module.db() as conn:
                with self.assertRaises(CRMError) as raised:
                    search_threads_live(
                        conn,
                        TenantContext(self.user_id),
                        {"query": "AI 营销", "accountId": "threads-live"},
                        executor=lambda _request, source=marker: {
                            "ok": True,
                            "liveOnly": True,
                            "candidates": [
                                {
                                    "platform": "threads",
                                    "sourceKind": source,
                                    "sourceUrl": "https://www.threads.net/@unsafe/post/1",
                                }
                            ],
                        },
                    )
                self.assertEqual(raised.exception.code, "crm_threads_live_evidence_required")

    def test_account_selection_never_crosses_tenants_and_requires_login(self):
        called = []
        for account_id, code in (
            ("threads-foreign", "crm_threads_account_required"),
            ("threads-login", "crm_account_needs_login"),
        ):
            with self.subTest(account_id=account_id), db_module.db() as conn:
                with self.assertRaises(CRMError) as raised:
                    search_threads_live(
                        conn,
                        TenantContext(self.user_id),
                        {"query": "AI 营销", "accountId": account_id},
                        executor=lambda request: called.append(request) or self._live_result(),
                    )
                self.assertEqual(raised.exception.code, code)
        self.assertEqual(called, [])

    def test_executor_is_required_and_failures_are_retryable_without_fake_rows(self):
        with db_module.db() as conn:
            with self.assertRaises(CRMError) as blocked:
                search_threads_live(
                    conn,
                    TenantContext(self.user_id),
                    {"query": "AI 营销", "accountId": "threads-live"},
                    executor=None,
                )
            self.assertEqual(blocked.exception.code, "crm_threads_search_blocked")

            with self.assertRaises(CRMError) as unavailable:
                search_threads_live(
                    conn,
                    TenantContext(self.user_id),
                    {"query": "AI 营销", "accountId": "threads-live"},
                    executor=lambda _request: (_ for _ in ()).throw(TimeoutError("live timeout")),
                )
            self.assertEqual(unavailable.exception.code, "crm_threads_search_unavailable")
            self.assertTrue(unavailable.exception.retryable)

    def test_opc_history_realtime_queries_current_tenant_db_but_is_not_platform_live(self):
        with db_module.db() as conn:
            for owner_id, username in (
                (self.user_id, "alice"),
                (self.other_user_id, "secret"),
            ):
                create_resource(
                    conn,
                    "leads",
                    user_id=owner_id,
                    import_batch_id=f"import-{owner_id}",
                    payload={
                        "platform": "threads",
                        "platform_user_key": username,
                        "username": username,
                        "stage": "new",
                        "profile": {
                            "keyword": "AI 营销",
                            "text": f"{username} discusses AI 营销",
                            "runId": "run-live-query",
                            "sourceUrl": f"https://www.threads.com/@{username}/post/1",
                        },
                    },
                )
            result = query_opc_history_realtime(
                conn,
                TenantContext(self.user_id),
                {"keywords": ["AI"], "runIds": ["run-live-query"], "limit": 100},
            )
        self.assertEqual(result["schemaVersion"], OPC_QUERY_SCHEMA)
        self.assertEqual(result["queryMode"], "realtime_database")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["data"][0]["username"], "alice")
        self.assertEqual(result["source"]["kind"], HISTORY_SOURCE_KIND)
        self.assertFalse(result["source"]["livePlatform"])
        self.assertTrue(result["source"]["history"])
        self.assertTrue(result["source"]["tenantScoped"])

    def test_opc_contacted_filter_preserves_legacy_non_new_semantics(self):
        with db_module.db() as conn:
            for username, stage in (("new_lead", "new"), ("sent_lead", "contacted"), ("failed_lead", "failed")):
                create_resource(
                    conn,
                    "leads",
                    user_id=self.user_id,
                    import_batch_id="import-contact-status",
                    payload={
                        "platform": "threads",
                        "platform_user_key": username,
                        "username": username,
                        "stage": stage,
                        "profile": {
                            "keyword": "AI 营销",
                            "text": username,
                            "contactStatus": stage,
                        },
                    },
                )
            result = query_opc_history_realtime(
                conn,
                TenantContext(self.user_id),
                {"contact": "contacted", "limit": 20},
            )
        self.assertEqual(result["total"], 2)
        self.assertEqual(
            {row["username"] for row in result["data"]},
            {"sent_lead", "failed_lead"},
        )
        self.assertEqual(result["filters"]["contact"], "contacted")


if __name__ == "__main__":
    unittest.main()
