import json
import os
import tempfile
import unittest
from pathlib import Path

from webapp import db as db_module
from webapp.crm.errors import CRMError
from webapp.crm.legacy_operations import (
    DEMAND_SCHEMA,
    HOTSPOT_SCHEMA,
    OPC_IMPORT_SCHEMA,
    OPC_QUERY_SCHEMA,
    TenantContext,
    analyze_demand,
    import_opc_history,
    query_opc_history,
    search_hotspots,
)
from webapp.crm.repository import create_resource


class CRMLegacyOperationsTests(unittest.TestCase):
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
            self.user_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                "VALUES ('legacy_ops_user','x',1,0,'approved',?,?)",
                (now, now),
            ).lastrowid)
            self.other_user_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                "VALUES ('legacy_ops_other','x',1,0,'approved',?,?)",
                (now, now),
            ).lastrowid)

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _legacy_lead(
        self,
        conn,
        *,
        user_id,
        username,
        platform="threads",
        keyword="AI 营销",
        contact_status="new",
        run_id="run-1",
    ):
        return create_resource(
            conn,
            "leads",
            user_id=user_id,
            import_batch_id=f"batch-{user_id}",
            payload={
                "platform": platform,
                "platform_user_key": username.casefold(),
                "username": username,
                "display_name": f"Display {username}",
                "stage": contact_status,
                "tags": [f"关键词:{keyword}", "来源:OPC"],
                "profile": {
                    "keyword": keyword,
                    "text": f"{username} is discussing {keyword}",
                    "contactStatus": contact_status,
                    "runId": run_id,
                    "sourceUrl": f"https://www.threads.com/@{username}/post/demo",
                    "collectedAt": "2026-08-01T00:00:00Z",
                },
            },
        )

    def test_demand_fallback_is_stable_in_simplified_and_traditional_chinese(self):
        hans = analyze_demand(
            TenantContext(self.user_id, "zh-CN"),
            {"text": "电商品牌需要 AI 自动化获客"},
        )
        hant = analyze_demand(
            TenantContext(self.user_id, "zh-TW"),
            {"text": "電商品牌需要 AI 自動化獲客"},
        )
        self.assertEqual(hans["schemaVersion"], DEMAND_SCHEMA)
        self.assertEqual(hans["locale"], "zh-Hans")
        self.assertEqual(hans["title"], "寻找增长与自动化方案的品牌经营者")
        self.assertTrue(hans["fallback"])
        self.assertEqual(hans["fallbackReason"], "provider_unconfigured")
        self.assertGreaterEqual(len(hans["keywords"]), 18)
        self.assertEqual(hant["locale"], "zh-Hant")
        self.assertEqual(hant["title"], "尋找成長與自動化方案的品牌經營者")
        self.assertIn("行銷自動化", hant["keywords"])

    def test_demand_uses_tenant_scoped_provider_and_rejects_invalid_output_to_fallback(self):
        observed = {}

        def provider(tenant, request):
            observed["tenant"] = tenant
            observed["request"] = request
            return {
                "model": "configured-model",
                "title": "目标客户",
                "intent": "高",
                "need": "增长",
                "pain": "效率",
                "signal": "主动咨询",
                "segments": ["品牌经营者"],
                "scenarios": ["寻找工具"],
                "keywordGroups": [{"name": "意向", "keywords": [f"关键词{i}" for i in range(12)]}],
                "keywords": [f"关键词{i}" for i in range(12)],
            }

        result = analyze_demand(
            TenantContext(self.user_id, request_id="req-legacy-1"),
            {"text": "寻找营销客户"},
            llm_provider=provider,
        )
        self.assertFalse(result["fallback"])
        self.assertEqual(result["model"], "configured-model")
        self.assertEqual(observed["tenant"].user_id, self.user_id)
        self.assertNotIn("api_key", observed["request"])
        invalid = analyze_demand(
            TenantContext(self.user_id),
            {"text": "寻找营销客户"},
            llm_provider=lambda _tenant, _request: {"keywords": ["太少"]},
        )
        self.assertTrue(invalid["fallback"])
        self.assertEqual(invalid["fallbackReason"], "provider_failed_or_invalid")

    def test_demand_enforces_input_limit_and_tenant_boundary(self):
        with self.assertRaises(CRMError) as error:
            TenantContext(0)
        self.assertEqual(error.exception.code, "crm_invalid_workspace")
        with self.assertRaises(CRMError) as error:
            analyze_demand(TenantContext(self.user_id), {"text": " "})
        self.assertEqual(error.exception.code, "crm_invalid_demand")
        result = analyze_demand(TenantContext(self.user_id), {"text": "贷款" + "甲" * 10_000})
        self.assertLessEqual(max(map(len, result["keywords"])), 40)

    def test_hotspot_search_blocks_without_real_provider(self):
        with self.assertRaises(CRMError) as error:
            search_hotspots(TenantContext(self.user_id), {"query": "AI 营销"})
        self.assertEqual(error.exception.code, "crm_hotspot_search_blocked")
        self.assertFalse(error.exception.retryable)

    def test_hotspot_search_normalizes_real_rows_and_never_fabricates(self):
        observed = {}

        def provider(tenant, request):
            observed["tenant"] = tenant.user_id
            observed["request"] = request
            return {
                "data": [
                    {
                        "id": "post-low",
                        "username": "@low",
                        "permalink": "https://www.threads.net/@low/post/1",
                        "text": "low",
                        "likeCount": 3,
                    },
                    {
                        "id": "post-high",
                        "username": "high",
                        "sourceUrl": "https://www.threads.com/@high/post/2",
                        "text": "high",
                        "likeCount": 1,
                        "replyCount": 4,
                        "repostCount": 2,
                    },
                    {
                        "id": "unsafe",
                        "sourceUrl": "http://www.threads.com/@unsafe/post/3",
                    },
                ],
                "warning": "partial source",
            }

        result = search_hotspots(
            TenantContext(self.user_id),
            {"query": "AI 营销", "limit": 999, "scrollRounds": 999},
            search_provider=provider,
        )
        self.assertEqual(result["schemaVersion"], HOTSPOT_SCHEMA)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["data"][0]["id"], "post-high")
        self.assertEqual(result["data"][0]["engagement"], 15)
        self.assertEqual(observed["tenant"], self.user_id)
        self.assertEqual(observed["request"]["limit"], 200)
        self.assertEqual(observed["request"]["scrollRounds"], 30)

    def test_opc_query_filters_and_never_crosses_tenants(self):
        with db_module.db() as conn:
            self._legacy_lead(conn, user_id=self.user_id, username="alice", keyword="AI 营销")
            self._legacy_lead(conn, user_id=self.user_id, username="bob", keyword="房贷", contact_status="contacted")
            self._legacy_lead(conn, user_id=self.other_user_id, username="secret", keyword="AI 营销")
            # A native CRM lead is not OPC/legacy history and must not be returned.
            create_resource(
                conn,
                "leads",
                user_id=self.user_id,
                payload={"platform": "threads", "platform_user_key": "native", "username": "native"},
            )
            result = query_opc_history(
                conn,
                TenantContext(self.user_id),
                {"keywords": ["AI"], "contact": "new", "limit": 5000},
            )
        self.assertEqual(result["schemaVersion"], OPC_QUERY_SCHEMA)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["data"][0]["username"], "alice")
        self.assertNotIn("secret", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("native", json.dumps(result, ensure_ascii=False))
        self.assertEqual(result["limit"], 500)

    def test_opc_import_creates_real_pool_membership_workflow_and_is_idempotent(self):
        with db_module.db() as conn:
            first = self._legacy_lead(conn, user_id=self.user_id, username="alice", keyword="AI 营销")
            second = self._legacy_lead(conn, user_id=self.user_id, username="bob", keyword="AI 营销")
            result = import_opc_history(
                conn,
                TenantContext(self.user_id, "zh-Hans"),
                {
                    "keywords": ["AI"],
                    "category": "OPC AI 客户",
                    "tags": ["来源:历史", "活动:夏季"],
                    "idempotencyKey": "opc-import-request-001",
                },
            )
            self.assertEqual(result["schemaVersion"], OPC_IMPORT_SCHEMA)
            self.assertEqual(result["importedCount"], 2)
            pool_id = result["pool"]["id"]
            member_ids = {
                row["lead_id"]
                for row in conn.execute(
                    "SELECT lead_id FROM crm_pool_members WHERE user_id=? AND pool_id=? AND active=1",
                    (self.user_id, pool_id),
                ).fetchall()
            }
            self.assertEqual(member_ids, {first["id"], second["id"]})
            workflow = conn.execute(
                "SELECT status,result_json FROM crm_workflows WHERE id=? AND user_id=?",
                (result["task"]["id"], self.user_id),
            ).fetchone()
            self.assertEqual(workflow["status"], "completed")
            self.assertEqual(json.loads(workflow["result_json"])["pool"]["id"], pool_id)
            replay = import_opc_history(
                conn,
                TenantContext(self.user_id),
                {"keywords": ["ignored"], "idempotencyKey": "opc-import-request-001"},
            )
            self.assertTrue(replay["replayed"])
            self.assertEqual(replay["pool"]["id"], pool_id)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) AS n FROM crm_pools WHERE user_id=?", (self.user_id,)).fetchone()["n"],
                1,
            )

    def test_opc_import_requires_idempotency_and_interaction_filter_is_tenant_scoped(self):
        with db_module.db() as conn:
            lead = self._legacy_lead(conn, user_id=self.user_id, username="alice")
            other = self._legacy_lead(conn, user_id=self.other_user_id, username="other")
            create_resource(
                conn,
                "events",
                user_id=self.other_user_id,
                payload={"lead_id": other["id"], "event_type": "message_sent"},
            )
            with self.assertRaises(CRMError) as error:
                import_opc_history(conn, TenantContext(self.user_id), {"keywords": ["AI"]})
            self.assertEqual(error.exception.code, "crm_idempotency_key_required")
            result = import_opc_history(
                conn,
                TenantContext(self.user_id),
                {
                    "keywords": ["AI"],
                    "excludeInteracted": True,
                    "idempotencyKey": "opc-import-scope-001",
                },
            )
            self.assertEqual(result["importedCount"], 1)
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS n FROM crm_pool_members WHERE user_id=? AND lead_id=?",
                    (self.user_id, lead["id"]),
                ).fetchone()["n"],
                1,
            )


if __name__ == "__main__":
    unittest.main()
