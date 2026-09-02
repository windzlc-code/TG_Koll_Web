import json
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp.auth import get_current_user
from webapp.crm import install_crm
from webapp.crm.service import set_user_access, update_module_settings


class CRMLegacyTraceTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            key: os.environ.get(key)
            for key in ("APP_DB_PATH", "WEBAPP_DATA_DIR", "CRM_ENABLED")
        }
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.root)
        os.environ["CRM_ENABLED"] = "1"
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            self.admin_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                "VALUES ('legacy_trace_admin','x',1,0,'approved',?,?)",
                (now, now),
            ).lastrowid)
            self.user_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
                "VALUES ('legacy_trace_user','x',0,0,'approved',?,?)",
                (now, now),
            ).lastrowid)
            update_module_settings(conn, {"enabled": True})
            set_user_access(
                conn,
                user_id=self.user_id,
                enabled=True,
                actor_user_id=self.admin_id,
            )

        app = FastAPI()
        app.dependency_overrides[get_current_user] = lambda: {
            "id": self.user_id,
            "is_admin": 0,
            "username": "legacy_trace_user",
        }
        install_crm(app)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _seed_workflow(self, workflow_id: str, workflow_type: str, payload: dict) -> None:
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO crm_workflows(
                  id,user_id,workflow_type,title,status,legacy_payload_json,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?)
                """,
                (
                    workflow_id,
                    self.user_id,
                    workflow_type,
                    "历史采集",
                    "completed",
                    json.dumps(payload, ensure_ascii=False),
                    1_700_000_000,
                    1_700_000_100,
                ),
            )

    def test_supported_legacy_collection_types_return_allowlisted_trace_not_native_evidence(self):
        payload = {
            "status": "completed_with_warnings",
            "trigger": "schedule",
            "dateKey": "2026-07-24",
            "startedAt": "2026-07-24T21:00:00.000Z",
            "finishedAt": "2026-07-24T21:05:00.000Z",
            "error": "one keyword timed out",
            "configSnapshot": {
                "dailyQuota": 180,
                "limit": 30,
                "searchMode": "top",
                "searchType": "keyword",
                "mediaFilter": "all",
                "userDataDir": "C:/private/browser/profile",
                "senderUsername": "private_sender",
                "password": "must-not-leak",
            },
            "keywords": [
                {
                    "query": "health",
                    "count": 2,
                    "sourceUrl": "https://www.threads.com/search?q=health",
                    "warning": "",
                },
                {
                    "query": "http rejected",
                    "count": 0,
                    "sourceUrl": "http://www.threads.com/search?q=unsafe",
                    "warning": "timeout",
                },
                {
                    "query": "suffix rejected",
                    "count": 0,
                    "sourceUrl": "https://threads.com.evil.example/search",
                    "warning": "",
                },
            ],
            "rows": [
                {
                    "username": "real_user",
                    "keyword": "health",
                    "text": "public result",
                    "permalink": "https://www.instagram.com/p/ABC123/",
                    "profileUrl": "https://www.threads.net/@real_user",
                    "sourceUrl": "file:///C:/private/evidence.html",
                    "timestamp": "2026-07-24T21:01:00.000Z",
                    "platform": "threads",
                    "cookie": "must-not-leak",
                },
                {
                    "username": "unsafe_link_user",
                    "keyword": "health",
                    "text": "still a real stored row",
                    "permalink": "https://instagram.com.evil.example/p/ABC123/",
                    "profileUrl": "http://www.instagram.com/unsafe_link_user/",
                    "sourceUrl": "https://www.threads.com/t/SAFE123",
                    "platform": "instagram",
                },
            ],
        }

        for index, workflow_type in enumerate(
            ("legacy_opc_daily_run", "collection", "legacy_opc_collection")
        ):
            workflow_id = f"legacy-trace-{index}"
            self._seed_workflow(workflow_id, workflow_type, payload)
            response = self.client.get(f"/api/crm/v1/tasks/{workflow_id}")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertNotIn("legacy_payload", body)
            self.assertEqual(body["steps"], [])
            self.assertEqual(body["actions"], [])
            self.assertEqual(body["evidence"], [])

            trace = body["legacy_trace"]
            self.assertEqual(trace["source"], "legacy_import")
            self.assertEqual(trace["kind"], workflow_type)
            self.assertFalse(trace["source_details_missing"])
            self.assertEqual(trace["summary"]["original_status"], "completed_with_warnings")
            self.assertEqual(trace["summary"]["records_total"], 2)
            self.assertEqual(trace["summary"]["keywords_total"], 3)
            self.assertEqual(trace["summary"]["warning_count"], 1)
            self.assertEqual(trace["summary"]["sender_username"], "private_sender")
            self.assertEqual(trace["summary"]["daily_quota"], 180)
            self.assertEqual(trace["summary"]["limit"], 30)
            self.assertEqual(trace["summary"]["search_mode"], "top")
            self.assertEqual(trace["summary"]["search_type"], "keyword")
            self.assertEqual(trace["summary"]["media_filter"], "all")
            self.assertFalse(trace["summary"]["records_truncated"])
            self.assertFalse(trace["summary"]["keywords_truncated"])
            self.assertTrue(all(not isinstance(value, (dict, list)) for value in trace["summary"].values()))

            self.assertEqual(
                trace["keyword_evidence"][0]["source_url"],
                "https://www.threads.com/search?q=health",
            )
            self.assertNotIn("source_url", trace["keyword_evidence"][1])
            self.assertNotIn("source_url", trace["keyword_evidence"][2])
            self.assertEqual(trace["records"][0]["permalink"], "https://www.instagram.com/p/ABC123/")
            self.assertEqual(trace["records"][0]["profile_url"], "https://www.threads.net/@real_user")
            self.assertNotIn("source_url", trace["records"][0])
            self.assertNotIn("permalink", trace["records"][1])
            self.assertNotIn("profile_url", trace["records"][1])
            self.assertEqual(trace["records"][1]["source_url"], "https://www.threads.com/t/SAFE123")
            serialized = json.dumps(body, ensure_ascii=False)
            self.assertNotIn("must-not-leak", serialized)
            self.assertNotIn("C:/private/browser/profile", serialized)

    def test_collection_shapes_keep_real_summary_without_inventing_native_rows(self):
        self._seed_workflow(
            "legacy-trace-collection",
            "collection",
            {
                "status": "completed",
                "mode": "opc_history",
                "poolId": "pool-real-1",
                "progress": 100,
                "startedAt": "2026-07-30T18:05:11.910Z",
                "finishedAt": "2026-07-30T18:05:14.591Z",
                "metrics": {
                    "collected": 351,
                    "duplicatesRemoved": 3,
                    "filteredOut": 1649,
                    "instagram": 2,
                    "matched": 2093,
                    "mortgage": 351,
                    "rawMatches": 2000,
                    "threads": 349,
                    "password": "must-not-leak",
                },
            },
        )
        collection = self.client.get("/api/crm/v1/tasks/legacy-trace-collection")
        self.assertEqual(collection.status_code, 200, collection.text)
        collection_body = collection.json()
        summary = collection_body["legacy_trace"]["summary"]
        self.assertEqual(summary["mode"], "opc_history")
        self.assertEqual(summary["pool_id"], "pool-real-1")
        self.assertEqual(summary["progress"], 100)
        self.assertEqual(summary["collected"], 351)
        self.assertEqual(summary["duplicates_removed"], 3)
        self.assertEqual(summary["filtered_out"], 1649)
        self.assertEqual(summary["instagram"], 2)
        self.assertEqual(summary["matched"], 2093)
        self.assertEqual(summary["mortgage"], 351)
        self.assertEqual(summary["raw_matches"], 2000)
        self.assertEqual(summary["threads"], 349)
        self.assertTrue(collection_body["legacy_trace"]["source_details_missing"])
        self.assertIn(
            {"key": "collection_metrics", "status": "completed", "count": 351},
            collection_body["legacy_trace"]["steps"],
        )
        self.assertEqual(collection_body["steps"], [])
        self.assertEqual(collection_body["actions"], [])
        self.assertNotIn("must-not-leak", json.dumps(collection_body))

        self._seed_workflow(
            "legacy-trace-opc-collection",
            "legacy_opc_collection",
            {
                "createdAt": "2026-07-25T16:06:50.708Z",
                "name": "保存的热点集合",
                "platform": "threads",
                "contactIds": ["contact-1", "contact-2", "contact-3"],
                "postIds": ["post-1", "post-2"],
                "tags": ["房贷", "台股", "高意向"],
            },
        )
        legacy_collection = self.client.get("/api/crm/v1/tasks/legacy-trace-opc-collection")
        self.assertEqual(legacy_collection.status_code, 200, legacy_collection.text)
        legacy_body = legacy_collection.json()
        legacy_summary = legacy_body["legacy_trace"]["summary"]
        self.assertEqual(legacy_summary["name"], "保存的热点集合")
        self.assertEqual(legacy_summary["platform"], "threads")
        self.assertEqual(legacy_summary["contact_count"], 3)
        self.assertEqual(legacy_summary["post_count"], 2)
        self.assertEqual(legacy_summary["tag_count"], 3)
        self.assertEqual(legacy_summary["tags"], "房贷、台股、高意向")
        self.assertEqual(legacy_summary["created_at"], "2026-07-25T16:06:50.708Z")
        self.assertTrue(legacy_body["legacy_trace"]["source_details_missing"])
        self.assertIn(
            {"key": "collection_contacts", "status": "completed", "count": 3},
            legacy_body["legacy_trace"]["steps"],
        )
        self.assertIn(
            {"key": "collection_posts", "status": "completed", "count": 2},
            legacy_body["legacy_trace"]["steps"],
        )
        self.assertEqual(legacy_body["steps"], [])
        self.assertEqual(legacy_body["actions"], [])

    def test_trace_is_bounded_and_reports_real_totals(self):
        payload = {
            "status": "completed",
            "keywords": [
                {
                    "query": f"query-{index}",
                    "count": 1,
                    "sourceUrl": f"https://www.threads.com/search?q={index}",
                }
                for index in range(203)
            ],
            "rows": [
                {
                    "username": f"user_{index}",
                    "permalink": f"https://www.threads.com/@user_{index}/post/{index}",
                }
                for index in range(205)
            ],
        }
        self._seed_workflow("legacy-trace-bounded", "legacy_opc_daily_run", payload)

        response = self.client.get("/api/crm/v1/tasks/legacy-trace-bounded")
        self.assertEqual(response.status_code, 200, response.text)
        trace = response.json()["legacy_trace"]
        self.assertEqual(len(trace["keyword_evidence"]), 200)
        self.assertEqual(len(trace["records"]), 200)
        self.assertEqual(trace["summary"]["keywords_total"], 203)
        self.assertEqual(trace["summary"]["records_total"], 205)
        self.assertTrue(trace["summary"]["keywords_truncated"])
        self.assertTrue(trace["summary"]["records_truncated"])

    def test_missing_source_details_are_explicit_and_raw_blob_is_never_returned(self):
        self._seed_workflow(
            "legacy-trace-missing",
            "legacy_opc_daily_run",
            {"status": "failed", "error": "source bundle had no details", "api_key": "must-not-leak"},
        )
        response = self.client.get("/api/crm/v1/tasks/legacy-trace-missing")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertNotIn("legacy_payload", body)
        self.assertTrue(body["legacy_trace"]["source_details_missing"])
        self.assertEqual(body["legacy_trace"]["keyword_evidence"], [])
        self.assertEqual(body["legacy_trace"]["records"], [])
        self.assertEqual(body["legacy_trace"]["summary"]["error"], "source bundle had no details")
        self.assertNotIn("must-not-leak", json.dumps(body))

        self._seed_workflow(
            "native-with-legacy-blob",
            "public_comment",
            {"password": "must-not-leak", "rows": [{"username": "not-a-supported-history"}]},
        )
        native = self.client.get("/api/crm/v1/tasks/native-with-legacy-blob")
        self.assertEqual(native.status_code, 200, native.text)
        self.assertNotIn("legacy_payload", native.json())
        self.assertNotIn("legacy_trace", native.json())

        self._seed_workflow("native-collection-empty", "collection", {})
        native_collection = self.client.get("/api/crm/v1/tasks/native-collection-empty")
        self.assertEqual(native_collection.status_code, 200, native_collection.text)
        self.assertNotIn("legacy_payload", native_collection.json())
        self.assertNotIn("legacy_trace", native_collection.json())


if __name__ == "__main__":
    unittest.main()
