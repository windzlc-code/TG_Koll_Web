import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp import social_automation_api
from webapp.auth import get_current_user


class BrowserPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db_path = os.environ.get("APP_DB_PATH")
        os.environ["APP_DB_PATH"] = str(Path(self.temp_dir.name) / "app.db")
        db_module.init_db()
        with db_module.db() as conn:
            now = 100
            conn.execute(
                "INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES (1, 'user-a', 'x', ?, ?)",
                (now, now),
            )
            conn.execute(
                "INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES (2, 'user-b', 'x', ?, ?)",
                (now, now),
            )
        social_automation_api.set_live_browser_settings(
            social_automation_api.LiveBrowserSettingsPayload(
                standby_seconds=0,
                auto_close_seconds=30,
                max_concurrency=2,
                text_input_mode="paste",
            )
        )

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def test_preferences_are_isolated_and_clamped_by_global_limit(self):
        saved = social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="review_hold",
                review_hold_seconds=120,
                manual_timeout_seconds=1800,
                requested_concurrency=8,
                text_input_mode="type",
            ),
            auto_configured=False,
        )

        self.assertEqual(saved["completion_policy"], "review_hold")
        self.assertEqual(social_automation_api.get_user_browser_preferences(2)["completion_policy"], "immediate_close")
        effective = social_automation_api.effective_user_browser_preferences(saved)
        self.assertEqual(effective["requested_concurrency"], 2)
        self.assertEqual(effective["review_hold_seconds"], 120)

    def test_user_endpoint_can_save_own_preferences(self):
        app = FastAPI()
        social_automation_api.register_social_automation_routes(app)
        app.dependency_overrides[get_current_user] = lambda: {"id": 1, "is_admin": 0}
        client = TestClient(app)

        response = client.put(
            "/api/persona_dashboard/automation/browser_preferences",
            json={
                "completion_policy": "immediate_close",
                "review_hold_seconds": 30,
                "manual_timeout_seconds": 600,
                "requested_concurrency": 2,
                "text_input_mode": "paste",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["preferences"]["manual_timeout_seconds"], 600)
        self.assertEqual(social_automation_api.get_user_browser_preferences(2)["manual_timeout_seconds"], 900)

    def test_auto_configure_uses_server_recommendation(self):
        app = FastAPI()
        social_automation_api.register_social_automation_routes(app)
        app.dependency_overrides[get_current_user] = lambda: {"id": 1, "is_admin": 0}
        client = TestClient(app)
        with (
            mock.patch.object(social_automation_api.os, "cpu_count", return_value=2),
            mock.patch.object(
                social_automation_api,
                "_memory_environment",
                return_value={"memory_total_mb": 3584, "memory_available_mb": 1800, "swap_total_mb": 0},
            ),
            mock.patch.object(social_automation_api, "_live_browser_sessions", return_value=[]),
        ):
            response = client.post("/api/persona_dashboard/automation/browser_preferences/auto_configure")

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["environment"]["resource_level"], "limited")
        self.assertEqual(body["preferences"]["completion_policy"], "immediate_close")
        self.assertEqual(body["preferences"]["requested_concurrency"], 2)
        self.assertTrue(body["preferences"]["auto_configured"])
        self.assertNotIn("path", str(body).lower())

    def test_runtime_payload_overrides_client_resource_controls(self):
        social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="immediate_close",
                review_hold_seconds=30,
                manual_timeout_seconds=900,
                requested_concurrency=2,
                text_input_mode="paste",
            ),
            auto_configured=True,
        )
        task = {
            "id": "task-1",
            "user_id": 1,
            "task_type": "browse_feed",
            "payload": {
                "retain_live_browser_after_finish": True,
                "live_browser_standby_seconds": 999,
                "live_browser_auto_close_seconds": 999,
                "manual_login_timeout_seconds": 1800,
                "text_input_mode": "type",
            },
        }

        payload = social_automation_api._runtime_task_payload(task, {"id": "account-1", "user_id": 1})

        self.assertFalse(payload["retain_live_browser_after_finish"])
        self.assertEqual(payload["live_browser_standby_seconds"], 0)
        self.assertEqual(payload["live_browser_auto_close_seconds"], 10)
        self.assertEqual(payload["manual_login_timeout_seconds"], 900)
        self.assertEqual(payload["text_input_mode"], "paste")

    def test_runtime_preferences_reach_browser_cleanup_control(self):
        social_automation_api.set_user_browser_preferences(
            1,
            social_automation_api.BrowserPreferencesPayload(
                completion_policy="review_hold",
                review_hold_seconds=120,
                manual_timeout_seconds=600,
                requested_concurrency=2,
                text_input_mode="paste",
            ),
            auto_configured=False,
        )
        client_task = {
            "id": "task-control",
            "user_id": 1,
            "task_type": "browse_feed",
            "payload": {
                "retain_live_browser_after_finish": False,
                "live_browser_auto_close_seconds": 999,
            },
        }
        control = {"task": dict(client_task)}

        runtime_task = social_automation_api._apply_runtime_task_preferences(
            client_task,
            {"id": "account-1", "user_id": 1},
            control,
        )

        self.assertTrue(runtime_task["payload"]["retain_live_browser_after_finish"])
        self.assertEqual(runtime_task["payload"]["live_browser_auto_close_seconds"], 120)
        self.assertEqual(control["task"]["payload"], runtime_task["payload"])


if __name__ == "__main__":
    unittest.main()
