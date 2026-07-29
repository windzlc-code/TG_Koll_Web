import unittest
from unittest.mock import patch

from fastapi import HTTPException

import webapp.social_automation_api as social_api


class WarmupPersonaPolicyTests(unittest.TestCase):
    def test_archive_sync_retries_transient_write_failures(self):
        with (
            patch.object(
                social_api,
                "_sync_successful_task_to_persona_archive_once",
                side_effect=[OSError("locked"), None],
            ) as sync_once,
            patch.object(social_api.time, "sleep"),
        ):
            synced = social_api._sync_successful_task_to_persona_archive(
                "task-1",
                {"ok": True},
            )

        self.assertTrue(synced)
        self.assertEqual(sync_once.call_count, 2)

    def test_runtime_auto_reply_refreshes_targets_and_dedup_history(self):
        archive = {
            "id": "persona-1",
            "name": "owner",
            "posts": [
                {
                    "platform": "threads",
                    "publishedUrl": "https://www.threads.net/@owner/post/current",
                    "publishedAt": "2026-07-29T00:00:00Z",
                    "content": "current post",
                },
            ],
            "setup": {
                "socialAutoReply": {
                    "threads": {
                        "repliedComments": [
                            {
                                "targetKey": "latest-key",
                                "author": "visitor",
                                "comment": "latest comment",
                            },
                        ],
                    },
                },
            },
        }
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            payload = social_api._runtime_task_payload(
                {
                    "id": "task-1",
                    "persona_id": "persona-1",
                    "task_type": "threads_auto_reply",
                    "payload": {
                        "strategy_id": "comment_recent_1d",
                        "target_urls": ["https://www.threads.net/@owner/post/stale"],
                        "replied_comment_keys": ["stale-key"],
                        "_target_urls_explicit": False,
                    },
                },
                {"user_id": 1, "persona_id": "persona-1"},
            )
        finally:
            social_api._load_persona_archive = original_loader

        self.assertEqual(
            payload["target_urls"],
            ["https://www.threads.net/@owner/post/current"],
        )
        self.assertEqual(payload["replied_comment_keys"], ["latest-key"])

    def test_comment_targets_do_not_use_hot_metric_candidates(self):
        archive = {
            "name": "owner",
            "posts": [
                {
                    "platform": "threads",
                    "publishedUrl": "https://www.threads.net/@owner/post/owned",
                    "publishedAt": "2026-07-29T00:00:00Z",
                    "content": "owned post",
                },
            ],
            "setup": {
                "threadsHotMetrics": {
                    "posts": [
                        {
                            "platform": "threads",
                            "url": "https://www.threads.net/@stranger/post/hot",
                            "publishedAt": "2026-07-29T00:00:00Z",
                            "viewCount": 100000,
                        },
                    ],
                },
            },
        }
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            payload = social_api._enrich_threads_task_payload(
                "persona-1",
                "threads_auto_reply",
                {"strategy_id": "comment_recent_1d"},
            )
        finally:
            social_api._load_persona_archive = original_loader

        self.assertEqual(
            payload["target_urls"],
            ["https://www.threads.net/@owner/post/owned"],
        )

    def test_comment_reply_loads_persisted_dedup_keys(self):
        archive = {
            "name": "owner",
            "setup": {
                "socialAutoReply": {
                    "threads": {
                        "repliedComments": [
                            {"targetKey": "comment-key-1"},
                            {"targetKey": "comment-key-2"},
                        ],
                    },
                },
            },
        }
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            payload = social_api._enrich_threads_task_payload(
                "persona-1",
                "threads_auto_reply",
                {"strategy_id": "comment_recent_1d"},
            )
        finally:
            social_api._load_persona_archive = original_loader

        self.assertEqual(
            payload["replied_comment_keys"],
            ["comment-key-1", "comment-key-2"],
        )

    def test_instagram_auto_reply_uses_the_same_policy_and_instagram_urls(self):
        archive = {
            "name": "owner",
            "posts": [
                {
                    "platform": "instagram",
                    "publishedUrl": "https://www.instagram.com/p/owned/",
                    "publishedAt": "2026-07-29T00:00:00Z",
                    "content": "owned post",
                },
                {
                    "platform": "threads",
                    "publishedUrl": "https://www.threads.net/@owner/post/other",
                    "publishedAt": "2026-07-29T00:00:00Z",
                    "content": "other platform",
                },
            ],
            "setup": {
                "socialAutoReply": {
                    "instagram": {
                        "repliedComments": [
                            {"targetKey": "instagram-comment-key"},
                        ],
                    },
                },
            },
        }
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            payload = social_api._enrich_threads_task_payload(
                "persona-1",
                "instagram_auto_reply",
                {"strategy_id": "comment_recent_1d"},
            )
        finally:
            social_api._load_persona_archive = original_loader

        self.assertEqual(payload["reply_scope"], "comments")
        self.assertEqual(
            payload["target_urls"],
            ["https://www.instagram.com/p/owned/"],
        )
        self.assertEqual(
            payload["replied_comment_keys"],
            ["instagram-comment-key"],
        )
        self.assertEqual(payload["ai_retry_count"], 3)

    def test_named_comment_strategy_cannot_be_changed_to_hot_scope(self):
        archive = {
            "name": "owner",
            "posts": [
                {
                    "platform": "threads",
                    "publishedUrl": "https://www.threads.net/@owner/post/owned",
                    "publishedAt": "2026-07-29T00:00:00Z",
                    "content": "owned post",
                },
            ],
        }
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            payload = social_api._enrich_threads_task_payload(
                "persona-1",
                "threads_auto_reply",
                {
                    "strategy_id": "comment_recent_1d",
                    "reply_scope": "hot_posts",
                    "target_urls": [
                        "https://www.threads.net/@stranger/post/external",
                    ],
                },
            )
        finally:
            social_api._load_persona_archive = original_loader

        self.assertEqual(payload["reply_scope"], "comments")
        self.assertNotIn(
            "https://www.threads.net/@stranger/post/external",
            payload["target_urls"],
        )

    def test_persona_reply_templates_drop_test_content(self):
        archive = {
            "name": "理发师",
            "posts": [
                {"content": "图文发布闭环测试（系统测试，请忽略）"},
                {"content": "理发店里最考验耐心的是沟通发型细节。"},
            ],
        }

        templates = social_api._collect_persona_reply_templates(archive)

        self.assertEqual(templates, ["理发店里最考验耐心的是沟通发型细节。"])

    def test_persona_comment_profile_uses_declared_topics_and_style(self):
        archive = {
            "name": "理发师",
            "content": "资深理发师，关注理发店日常与手艺。",
            "setup": {
                "genres": ["搞笑", "生活日常"],
                "interests": ["理发", "手工", "理发"],
                "personaStyle": "接地气，吐槽式幽默",
                "personaDescription": "爱开玩笑的理发师。",
            },
        }

        profile = social_api._collect_persona_comment_profile(archive)

        self.assertEqual(profile["persona_name"], "理发师")
        self.assertEqual(profile["persona_style"], "接地气，吐槽式幽默")
        self.assertEqual(
            profile["persona_topics"],
            ["搞笑", "生活日常", "理发", "手工"],
        )
        self.assertIn("资深理发师", profile["persona_context"])

    def test_new_persona_theme_fields_supply_relevant_topics(self):
        archive = {
            "name": "理发师",
            "setup": {
                "contentTheme": "理发店日常、短发造型",
                "customTopic": "男士发型",
                "personaStyle": "专业、直接",
            },
        }

        profile = social_api._collect_persona_comment_profile(archive)

        self.assertIn("理发店日常", profile["persona_topics"])
        self.assertIn("短发造型", profile["persona_topics"])
        self.assertIn("男士发型", profile["persona_topics"])

    def test_threads_and_instagram_receive_the_same_safe_warmup_defaults(self):
        archive = {
            "name": "理发师",
            "content": "资深理发师。",
            "setup": {
                "interests": ["理发", "手工"],
                "personaStyle": "接地气",
            },
        }

        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            threads = social_api._enrich_threads_task_payload(
                "persona-1",
                "threads_warmup",
                {"strategy_id": "like_comment"},
            )
            instagram = social_api._enrich_threads_task_payload(
                "persona-1",
                "instagram_warmup",
                {"strategy_id": "like_comment"},
            )
        finally:
            social_api._load_persona_archive = original_loader

        for key in (
            "browse_limit",
            "like_limit",
            "like_chance",
            "max_comments",
            "comment_chance",
            "require_persona_relevance",
            "persona_topics",
            "persona_style",
        ):
            self.assertEqual(threads[key], instagram[key])
        self.assertEqual(threads["browse_limit"], 80)
        self.assertEqual(threads["like_limit"], 16)
        self.assertEqual(threads["like_chance"], 100)
        self.assertEqual(threads["max_comments"], 8)
        self.assertEqual(threads["comment_chance"], 100)
        self.assertEqual(threads["ai_retry_count"], 3)
        self.assertEqual(threads["session_minutes"], "7-10")
        self.assertEqual(threads["interaction_every_min_posts"], 2)
        self.assertEqual(threads["interaction_every_max_posts"], 3)
        self.assertEqual(threads["search_chance"], 16)
        self.assertEqual(instagram["search_chance"], 0)
        self.assertTrue(threads["stop_on_risk_limit"])
        self.assertNotIn("reply_templates", threads)

    def test_named_warmup_strategy_overrides_stale_saved_web_values(self):
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: {"name": "理发师"}
        try:
            payload = social_api._enrich_threads_task_payload(
                "persona-1",
                "threads_warmup",
                {
                    "strategy_id": "like_comment",
                    "browse_limit": 30,
                    "scroll_times": 30,
                    "like_limit": 4,
                    "max_comments": 1,
                    "comment_chance": 20,
                    "session_seconds": 60,
                },
            )
        finally:
            social_api._load_persona_archive = original_loader

        self.assertEqual(payload["browse_limit"], 80)
        self.assertEqual(payload["scroll_times"], 80)
        self.assertEqual(payload["like_limit"], 16)
        self.assertEqual(payload["like_chance"], 100)
        self.assertEqual(payload["max_comments"], 8)
        self.assertEqual(payload["comment_chance"], 100)
        self.assertEqual(payload["session_minutes"], "7-10")
        self.assertNotIn("session_seconds", payload)

    def test_warmup_rejects_missing_bound_persona_archive(self):
        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: None
        try:
            for task_type in ("threads_warmup", "instagram_warmup"):
                with self.subTest(task_type=task_type):
                    with self.assertRaises(HTTPException) as context:
                        social_api._enrich_threads_task_payload(
                            "missing-persona",
                            task_type,
                            {"persona_name": "伪造人设"},
                        )
                    self.assertEqual(context.exception.status_code, 409)
        finally:
            social_api._load_persona_archive = original_loader

    def test_bound_archive_persona_fields_override_forged_request_payload(self):
        archive = {
            "name": "归档理发师",
            "content": "专注短发造型与理发店日常。",
            "setup": {
                "genres": ["生活日常"],
                "interests": ["理发", "短发造型"],
                "personaStyle": "专业、直接",
                "personaDescription": "有十年经验的理发师。",
                "personality": "耐心",
                "language": "zh-CN",
            },
        }
        expected = social_api._collect_persona_comment_profile(archive)
        forged_fields = {
            "persona_name": "伪造人设",
            "persona_style": "伪造风格",
            "persona_personality": "伪造性格",
            "persona_language": "伪造语言",
            "persona_context": "伪造背景",
            "persona_topics": ["伪造主题"],
        }

        original_loader = social_api._load_persona_archive
        social_api._load_persona_archive = lambda _persona_id: archive
        try:
            for task_type in ("threads_warmup", "instagram_warmup"):
                with self.subTest(task_type=task_type):
                    payload = social_api._enrich_threads_task_payload(
                        "bound-persona",
                        task_type,
                        {
                            "strategy_id": "like_comment",
                            **forged_fields,
                        },
                    )

                    for field in forged_fields:
                        self.assertEqual(payload[field], expected[field])
        finally:
            social_api._load_persona_archive = original_loader


if __name__ == "__main__":
    unittest.main()
