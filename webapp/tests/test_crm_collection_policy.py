import unittest
from datetime import datetime, timezone

from webapp.crm.collection_policy import (
    COLLECTION_LOOKBACK_OPTIONS,
    collect_source_keywords,
    create_zero_result_recovery_plan,
    filter_rows_by_collection_window,
    normalize_collection_lookback_days,
)


class CRMCollectionPolicyTests(unittest.TestCase):
    def test_supported_windows_and_real_timestamp_filter(self):
        self.assertEqual(COLLECTION_LOOKBACK_OPTIONS, (1, 3, 7, 15, 30))
        self.assertEqual(normalize_collection_lookback_days("15"), 15)
        self.assertEqual(normalize_collection_lookback_days(99), 7)
        result = filter_rows_by_collection_window(
            [
                {"id": "inside", "publishedAt": "2026-08-14T12:00:00Z"},
                {"id": "boundary", "timestamp": "2026-08-09T12:00:00Z"},
                {"id": "old", "created_at": "2026-08-09T11:59:59Z"},
                {"id": "future", "timestamp": "2026-08-16T12:00:01Z"},
                {"id": "unknown", "timestamp": ""},
            ],
            7,
            datetime(2026, 8, 16, 12, tzinfo=timezone.utc),
        )
        self.assertEqual([row["id"] for row in result["data"]], ["inside", "boundary"])
        self.assertEqual(result["excluded_older"], 1)
        self.assertEqual(result["excluded_future"], 1)
        self.assertEqual(result["excluded_unknown"], 1)

    def test_keywords_only_come_from_declared_sources(self):
        keywords = collect_source_keywords(
            ["手作皮具", "限量定制"],
            ["皮革保养", "手作皮具"],
            {"keywordGroups": [{"name": "客群", "keywords": ["礼物需求"]}]},
        )
        self.assertEqual(keywords, ["手作皮具", "限量定制", "皮革保养", "礼物需求"])
        self.assertEqual(collect_source_keywords(None, None, {"title": "没有关键词字段"}), [])
        self.assertFalse(any(word in keywords for word in ("房贷", "股票", "美业")))

    def test_zero_result_expands_once_and_reuses_keywords(self):
        initial = create_zero_result_recovery_plan(
            result_count=0,
            limit=30,
            lookback_days=7,
            request_keywords=["陶艺课程"],
            model_keywords=["周末体验"],
            persona={"keywords": ["亲子手作"]},
        )
        self.assertTrue(initial["can_retry"])
        self.assertEqual(initial["expanded_limit"], 60)
        self.assertEqual(initial["expanded_lookback_days"], 15)
        self.assertEqual(initial["keywords"], ["陶艺课程", "周末体验", "亲子手作"])

        exhausted = create_zero_result_recovery_plan(
            result_count=0,
            limit=initial["expanded_limit"],
            lookback_days=initial["expanded_lookback_days"],
            expansion_count=1,
            request_keywords=initial["keywords"],
        )
        self.assertFalse(exhausted["can_retry"])
        self.assertEqual(exhausted["reason"], "single_expansion_exhausted")

    def test_non_empty_result_never_expands(self):
        plan = create_zero_result_recovery_plan(result_count=1, limit=30, lookback_days=7)
        self.assertFalse(plan["can_retry"])
        self.assertEqual(plan["reason"], "results_available")


if __name__ == "__main__":
    unittest.main()
