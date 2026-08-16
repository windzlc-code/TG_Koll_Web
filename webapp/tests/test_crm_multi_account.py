import unittest

from webapp.crm.multi_account import (
    MAX_PARALLEL_COMMENT_TASKS,
    allocate_unique_targets,
    evaluate_multi_account_capacity,
    historical_comment_attempts,
    sender_channel_readiness,
    summarize_multi_account_campaign,
)


class CRMMultiAccountPolicyTests(unittest.TestCase):
    def test_sender_readiness_requires_exact_verified_identity(self):
        account = {
            "username": "ann.54088",
            "threads": {"verificationStatus": "matched", "loggedInUsername": "ann.54088"},
        }
        self.assertEqual(
            sender_channel_readiness(account, "@ANN.54088"),
            {"ready": True, "reason": "matched"},
        )
        self.assertEqual(
            sender_channel_readiness(account, "ann_54088")["reason"],
            "account_not_configured",
        )
        mismatch = dict(account)
        mismatch["threads"] = {"verificationStatus": "matched", "loggedInUsername": "other"}
        self.assertEqual(sender_channel_readiness(mismatch, "ann.54088")["reason"], "account_mismatch")

    def test_capacity_deduplicates_senders_and_respects_active_slots(self):
        ready = evaluate_multi_account_capacity(["@alpha", "ALPHA", "beta"], [])
        self.assertTrue(ready["allowed"])
        self.assertEqual(ready["senders"], ["alpha", "beta"])
        self.assertEqual(ready["maximum_parallel"], MAX_PARALLEL_COMMENT_TASKS)

        occupied = evaluate_multi_account_capacity(
            ["alpha", "beta"],
            [{"type": "comment", "status": "running", "senderUsername": "@Alpha"}],
        )
        self.assertFalse(occupied["allowed"])
        self.assertEqual(occupied["reason"], "sender_already_active")

        full = evaluate_multi_account_capacity(
            ["alpha", "beta"],
            [
                {"type": "comment", "status": "running", "senderUsername": "gamma"},
                {"type": "comment", "status": "queued", "senderUsername": "delta"},
            ],
        )
        self.assertFalse(full["allowed"])
        self.assertEqual(full["reason"], "global_parallel_limit")

    def test_historical_attempts_exclude_pending_queue_rows(self):
        attempts = historical_comment_attempts(
            [{
                "id": "old",
                "type": "comment",
                "poolId": "pool-1",
                "leadQueue": ["processed", "pending"],
                "batchControl": {"cursor": 1},
                "result": {"results": [{
                    "leadId": "result",
                    "sourcePostUrl": "https://www.threads.com/@writer/post/ABC?sort=recent#reply",
                }]},
            }],
            "pool-1",
        )
        self.assertEqual(attempts["lead_ids"], {"processed", "result"})
        self.assertNotIn("pending", attempts["lead_ids"])
        self.assertIn("https://www.threads.com/@writer/post/ABC", attempts["source_urls"])

    def test_allocator_never_reuses_historical_or_duplicate_targets(self):
        targets = [
            {"id": "old", "url": "https://example.com/post/old"},
            {"id": "one", "url": "https://example.com/post/one?x=1"},
            {"id": "one", "url": "https://example.com/post/one"},
            {"id": "two", "url": "https://example.com/post/two"},
            {"id": "three", "url": "https://example.com/post/three"},
        ]
        result = allocate_unique_targets(
            targets,
            ["alpha", "beta"],
            per_sender_limit=1,
            attempted_lead_ids=["old"],
        )
        assigned = [row["id"] for rows in result["assignments"].values() for row in rows]
        self.assertEqual(assigned, ["one", "two"])
        self.assertEqual(result["assigned_count"], 2)
        self.assertEqual(result["skipped"]["historical"], 1)
        self.assertEqual(result["skipped"]["duplicate"], 1)
        self.assertEqual(result["skipped"]["capacity"], 1)

        generated = allocate_unique_targets(
            [{"id": "one"}, {"id": "two"}],
            (sender for sender in ("alpha", "beta")),
            per_sender_limit=1,
        )
        self.assertEqual(generated["assigned_count"], 2)

    def test_campaign_summary_reports_duplicates_and_throughput(self):
        tasks = [
            {
                "id": "a",
                "multiAccountCampaignId": "campaign",
                "senderUsername": "alpha",
                "status": "completed",
                "startedAt": "2026-08-05T08:00:00Z",
                "finishedAt": "2026-08-05T08:10:00Z",
                "metrics": {"total": 2, "processed": 2, "published": 2, "replied": 1},
                "result": {"results": [{"leadId": "one"}, {"leadId": "shared"}]},
            },
            {
                "id": "b",
                "multiAccountCampaignId": "campaign",
                "senderUsername": "beta",
                "status": "needs_attention",
                "startedAt": "2026-08-05T08:00:00Z",
                "finishedAt": "2026-08-05T08:10:00Z",
                "metrics": {"total": 2, "processed": 2, "published": 1, "failed": 1},
                "result": {"results": [{"leadId": "two"}, {"leadId": "shared"}]},
            },
        ]
        summary = summarize_multi_account_campaign(tasks, "campaign")
        self.assertEqual(summary["status"], "finished")
        self.assertEqual(summary["sender_count"], 2)
        self.assertEqual(summary["unique_lead_count"], 3)
        self.assertEqual(summary["duplicate_lead_ids"], ["shared"])
        self.assertEqual(summary["processed_per_minute"], 0.4)
        self.assertEqual(summary["published_per_minute"], 0.3)
        self.assertEqual(summary["publish_rate"], 75.0)
        self.assertEqual(summary["reply_rate"], 33.33)
        self.assertEqual(summary["parallel_efficiency"], 2.0)


if __name__ == "__main__":
    unittest.main()
