import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from webapp.db import db, init_db
import webapp.social_automation_api as social_api


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
API_PY = (ROOT / "webapp" / "social_automation_api.py").read_text(encoding="utf-8")
RUNNER_PY = (ROOT / "social_automation" / "runner.py").read_text(encoding="utf-8")


class InstagramWarmupContractTests(unittest.TestCase):
    def test_ui_exposes_instagram_warmup_with_shared_strategies(self):
        self.assertIn('instagram_warmup: [', CONSOLE_JS)
        self.assertIn('["instagram_warmup", "Instagram 养号"]', CONSOLE_JS)
        self.assertIn('platform === "instagram" ? "instagram_warmup" : "threads_warmup"', CONSOLE_JS)
        self.assertIn('data-persona-run-automation', CONSOLE_JS)
        self.assertNotIn('data-persona-run-threads', CONSOLE_JS)

    def test_instagram_preflight_renders_shared_warmup_and_reply_rows(self):
        renderer = CONSOLE_JS[
            CONSOLE_JS.index("function personaPublishPreflightRows")
            : CONSOLE_JS.index("function renderPersonaPublishPreflight")
        ]
        self.assertNotIn('if (platform === "threads")', renderer)
        self.assertIn("preflight.warmup", renderer)
        self.assertIn("preflight.reply", renderer)

    def test_immediate_plan_maps_warmup_to_the_selected_platform(self):
        self.assertIn("function automationPlanTaskTypeForPlatform", CONSOLE_JS)
        self.assertIn('return normalizedPlatform === "instagram" ? "instagram_warmup" : "threads_warmup";', CONSOLE_JS)
        self.assertIn('automationPlanSubmissionItem(item, account.platform || "threads")', CONSOLE_JS)

    def test_instagram_auto_reply_uses_the_shared_platform_executor(self):
        self.assertIn('"instagram_auto_reply",', RUNNER_PY)
        self.assertIn("def _run_platform_auto_reply(", RUNNER_PY)
        self.assertIn("return _run_instagram_auto_reply(", RUNNER_PY)
        self.assertIn('platform === "instagram" ? "instagram_auto_reply" : "threads_auto_reply"', CONSOLE_JS)
        self.assertNotIn("Instagram 当前只开放养号任务。", CONSOLE_JS)

    def test_api_and_runner_accept_instagram_warmup(self):
        self.assertGreaterEqual(API_PY.count('"instagram_warmup"'), 6)
        self.assertIn('"instagram_warmup": "Instagram 网页自动化养号"', API_PY)
        self.assertIn('if task_type in {"threads_warmup", "instagram_warmup"}:', API_PY)
        self.assertIn('"instagram_warmup",', RUNNER_PY)
        self.assertIn("return _run_instagram_warmup(", RUNNER_PY)
        self.assertIn("def _run_platform_warmup(", RUNNER_PY)
        self.assertIn('platform="instagram"', RUNNER_PY)
        self.assertIn('f"{clean_platform} warmup completion was confirmed."', RUNNER_PY)


class SocialTaskPlatformContractTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self._tmpdir.name) / "app.db")
        init_db()
        with db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, is_admin, approval_status, created_at, updated_at
                ) VALUES ('social-platform-owner', 'hash', 1, 'approved', 1, 1)
                """
            )
            self.user_id = int(cursor.lastrowid)
            conn.execute(
                """
                INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at)
                VALUES ('persona-platform-contract', ?, 1, 1)
                """,
                (self.user_id,),
            )
            for account_id, platform in (
                ("account-threads", "threads"),
                ("account-instagram", "instagram"),
            ):
                conn.execute(
                    """
                    INSERT INTO social_accounts(
                      id, user_id, persona_id, platform, username, display_name,
                      profile_dir, status, created_at, updated_at
                    ) VALUES (?, ?, 'persona-platform-contract', ?, ?, '', ?, 'ready', 1, 1)
                    """,
                    (
                        account_id,
                        self.user_id,
                        platform,
                        f"{platform}_owner",
                        f"profiles/{account_id}",
                    ),
                )

    def tearDown(self):
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        self._tmpdir.cleanup()

    def _create_task(self, account_id, platform, task_type, task_payload=None):
        return social_api.create_social_task(
            social_api.SocialTaskPayload(
                persona_id="persona-platform-contract",
                account_id=account_id,
                platform=platform,
                task_type=task_type,
                payload=dict(task_payload or {}),
            ),
            billing_admin_waived=True,
        )

    def test_create_social_task_rejects_platform_specific_task_mismatches(self):
        mismatches = (
            ("account-threads", "threads", "instagram_warmup", "instagram"),
            ("account-instagram", "instagram", "threads_warmup", "threads"),
            ("account-instagram", "instagram", "threads_auto_reply", "threads"),
            ("account-threads", "threads", "instagram_auto_reply", "instagram"),
        )

        for account_id, platform, task_type, required_platform in mismatches:
            with self.subTest(platform=platform, task_type=task_type):
                with self.assertRaises(HTTPException) as rejected:
                    self._create_task(account_id, platform, task_type)
                self.assertEqual(rejected.exception.status_code, 400)
                self.assertIn(task_type, str(rejected.exception.detail))
                self.assertIn(required_platform, str(rejected.exception.detail))

        with db() as conn:
            task_count = conn.execute(
                "SELECT COUNT(*) AS count FROM social_automation_tasks"
            ).fetchone()
        self.assertEqual(int(task_count["count"]), 0)

    def test_create_social_task_accepts_matched_and_shared_task_types(self):
        valid_tasks = (
            ("account-instagram", "instagram", "instagram_warmup", {}),
            ("account-instagram", "instagram", "instagram_auto_reply", {}),
            ("account-threads", "threads", "threads_warmup", {}),
            ("account-threads", "threads", "threads_auto_reply", {}),
            ("account-instagram", "instagram", "open_login", {}),
            ("account-threads", "threads", "publish_post", {"content": "contract test"}),
        )

        with patch.object(social_api, "_load_persona_archive", return_value={}):
            for account_id, platform, task_type, task_payload in valid_tasks:
                with self.subTest(platform=platform, task_type=task_type):
                    task = self._create_task(account_id, platform, task_type, task_payload)
                    self.assertEqual(task["platform"], platform)
                    self.assertEqual(task["task_type"], task_type)

        with db() as conn:
            task_count = conn.execute(
                "SELECT COUNT(*) AS count FROM social_automation_tasks"
            ).fetchone()
        self.assertEqual(int(task_count["count"]), len(valid_tasks))


if __name__ == "__main__":
    unittest.main()
