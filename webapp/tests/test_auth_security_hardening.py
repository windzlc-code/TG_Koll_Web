import os
import base64
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import webapp.server as server
from webapp import social_automation_api


class AuthSecurityHardeningTests(unittest.TestCase):
    ENV_KEYS = (
        "APP_DB_PATH",
        "APP_RUNTIME_CONFIG_PATH",
        "WEBAPP_DATA_DIR",
        "ADMIN_BOOTSTRAP_PASSWORD",
        "SESSION_COOKIE_SECURE",
        "FORCE_HTTPS",
        "ALLOW_PUBLIC_REGISTER",
        "PASSWORD_VAULT_KEY",
        "PASSWORD_VAULT_KEY_FILE",
    )
    ADMIN_PASSWORD = "bootstrap-secret"

    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.old_sentiment_config_path = server.SENTIMENT_CONFIG_PATH
        self.old_tool_upload_root = server.TOOL_R18_UPLOAD_ROOT
        self.old_tool_runtime_dir = server.TOOL_R18_RUNTIME_DIR
        self.old_data_dir = server.DATA_DIR
        self.old_upload_root = server.UPLOAD_ROOT
        self.old_output_root = server.OUTPUT_ROOT
        self.old_social_data_dir = social_automation_api._DATA_DIR
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmpdir.name)
        self._configure_environment(self.data_dir, bootstrap_password=self.ADMIN_PASSWORD)
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["ALLOW_PUBLIC_REGISTER"] = "1"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        server.SENTIMENT_CONFIG_PATH = self.data_dir / "sentiment-config.json"
        server.SENTIMENT_CONFIG_PATH.write_text(json.dumps({}), encoding="utf-8")
        server.DATA_DIR = self.data_dir
        server.UPLOAD_ROOT = self.data_dir / "uploads"
        server.OUTPUT_ROOT = self.data_dir / "outputs"
        server.TOOL_R18_UPLOAD_ROOT = self.data_dir / "tool_r18_uploads"
        server.TOOL_R18_UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
        server.TOOL_R18_RUNTIME_DIR = self.data_dir / "tool_r18_runtime"
        server.TOOL_R18_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        social_automation_api.configure_social_automation(data_dir=self.data_dir)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        self.app = server.create_app()

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        server.SENTIMENT_CONFIG_PATH = self.old_sentiment_config_path
        server.TOOL_R18_UPLOAD_ROOT = self.old_tool_upload_root
        server.TOOL_R18_RUNTIME_DIR = self.old_tool_runtime_dir
        server.DATA_DIR = self.old_data_dir
        server.UPLOAD_ROOT = self.old_upload_root
        server.OUTPUT_ROOT = self.old_output_root
        social_automation_api.configure_social_automation(data_dir=self.old_social_data_dir)
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    @staticmethod
    def application_payload(username: str) -> dict[str, str]:
        return {
            "username": username,
            "password": "guest123",
            "full_name": "Security Test User",
            "email": f"{username}@example.com",
            "phone": "0912345678",
            "company": "Vecto Test",
            "use_case": "Security regression testing",
        }

    def _configure_environment(self, data_dir: Path, *, bootstrap_password: str | None) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        os.environ["WEBAPP_DATA_DIR"] = str(data_dir)
        os.environ["APP_DB_PATH"] = str(data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(data_dir / "runtime.json")
        if bootstrap_password is None:
            os.environ.pop("ADMIN_BOOTSTRAP_PASSWORD", None)
        else:
            os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = bootstrap_password
        server.RUNTIME_CONFIG_PATH = data_dir / "runtime.json"

    def _admin_client(self) -> tuple[TestClient, dict]:
        client = TestClient(self.app)
        response = client.post(
            "/api/auth/login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["is_admin"])
        return client, response.json()

    def _apply(self, username: str) -> int:
        response = TestClient(self.app).post(
            "/api/auth/apply",
            json=self.application_payload(username),
        )
        self.assertEqual(response.status_code, 200, response.text)
        return int(response.json()["id"])

    def _approved_client(self, username: str) -> tuple[TestClient, int]:
        user_id = self._apply(username)
        admin, _identity = self._admin_client()
        approved = admin.post(
            f"/api/admin/users/{user_id}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        client = TestClient(self.app)
        login = client.post(
            "/api/auth/user-login",
            json={"username": username, "password": "guest123"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        return client, user_id

    def test_anonymous_persona_profile_refresh_and_delete_require_login(self):
        client = TestClient(self.app)

        profile = client.get("/api/persona_dashboard/personas/missing-persona/profile")
        refresh = client.post(
            "/api/persona_dashboard/refresh",
            json={"archive_id": "missing-persona"},
        )
        delete = client.delete("/api/persona_dashboard/personas/missing-persona")

        self.assertEqual(profile.status_code, 401, profile.text)
        self.assertEqual(refresh.status_code, 401, refresh.text)
        self.assertEqual(delete.status_code, 401, delete.text)

    def test_browser_extension_config_never_bootstraps_token_anonymously(self):
        anonymous = TestClient(self.app)
        denied = anonymous.get("/browser-auth-extension/config.json")
        self.assertEqual(denied.status_code, 403, denied.text)
        self.assertNotIn("authToken", denied.text)

        admin, _identity = self._admin_client()
        admin_config = admin.get("/browser-auth-extension/config.json")
        self.assertEqual(admin_config.status_code, 200, admin_config.text)
        token = str(admin_config.json().get("authToken") or "")
        self.assertGreater(len(token), 32)

        extension_config = anonymous.get(
            "/browser-auth-extension/config.json",
            headers={"x-sentiment-browser-auth": token},
        )
        self.assertEqual(extension_config.status_code, 200, extension_config.text)
        self.assertNotIn("authToken", extension_config.json())

    def test_saved_social_password_is_never_returned_by_api(self):
        admin, _identity = self._admin_client()
        created = admin.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "security-account"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        account_id = created.json()["account"]["id"]
        updated = admin.patch(
            f"/api/persona_dashboard/automation/accounts/{account_id}",
            json={"login_username": "security-login", "login_password": "top-secret"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)

        response = admin.get(f"/api/persona_dashboard/automation/accounts/{account_id}/credentials")
        self.assertEqual(response.status_code, 410, response.text)
        self.assertNotIn("top-secret", response.text)
        self.assertNotIn("login_password", response.text)

    def test_social_resources_are_isolated_between_ordinary_users(self):
        owner, owner_id = self._approved_client("owner_user")
        stranger, _stranger_id = self._approved_client("stranger_user")

        owner_persona_response = owner.post(
            "/api/persona_dashboard/personas",
            json={"name": "Owner persona", "content": "Only the owner may access this persona."},
        )
        self.assertEqual(owner_persona_response.status_code, 200, owner_persona_response.text)
        owner_persona_id = owner_persona_response.json()["id"]
        stranger_persona_response = stranger.post(
            "/api/persona_dashboard/personas",
            json={"name": "Stranger persona", "content": "A separate tenant persona."},
        )
        self.assertEqual(stranger_persona_response.status_code, 200, stranger_persona_response.text)
        stranger_persona_id = stranger_persona_response.json()["id"]

        proxy_response = owner.post(
            "/api/persona_dashboard/automation/proxies",
            json={"name": "Owner proxy", "proxy_type": "http", "host": "127.0.0.1", "port": 8080, "status": "active"},
        )
        self.assertEqual(proxy_response.status_code, 200, proxy_response.text)
        proxy_id = proxy_response.json()["proxy"]["id"]
        account_response = owner.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "shared_handle", "persona_id": owner_persona_id},
        )
        self.assertEqual(account_response.status_code, 200, account_response.text)
        account_id = account_response.json()["account"]["id"]
        task_response = owner.post(
            "/api/persona_dashboard/automation/tasks",
            json={"account_id": account_id, "platform": "threads", "task_type": "check_login"},
        )
        self.assertEqual(task_response.status_code, 200, task_response.text)
        task_id = task_response.json()["task"]["id"]

        self.assertEqual(len(owner.get("/api/persona_dashboard/automation/accounts").json()["accounts"]), 1)
        self.assertEqual(len(owner.get("/api/persona_dashboard/automation/proxies").json()["proxies"]), 1)
        self.assertEqual(len(owner.get("/api/persona_dashboard/automation/tasks").json()["tasks"]), 1)
        self.assertEqual(stranger.get("/api/persona_dashboard/automation/accounts").json()["accounts"], [])
        self.assertEqual(stranger.get("/api/persona_dashboard/automation/proxies").json()["proxies"], [])
        self.assertEqual(stranger.get("/api/persona_dashboard/automation/tasks").json()["tasks"], [])
        self.assertEqual(stranger.get("/api/persona_dashboard/automation/overview").json()["summary"]["account_count"], 0)
        self.assertEqual([item["id"] for item in owner.get("/api/persona_dashboard/overview").json()["personas"]], [owner_persona_id])
        self.assertEqual([item["id"] for item in stranger.get("/api/persona_dashboard/overview").json()["personas"]], [stranger_persona_id])
        self.assertEqual(stranger.get(f"/api/persona_dashboard/personas/{owner_persona_id}/profile").status_code, 404)
        self.assertEqual(stranger.delete(f"/api/persona_dashboard/personas/{owner_persona_id}").status_code, 404)

        owner_group = owner.post("/api/persona_dashboard/groups", json={"name": "Owner group"})
        self.assertEqual(owner_group.status_code, 200, owner_group.text)
        owner_group_id = owner_group.json()["group"]["id"]
        self.assertEqual(len(owner.get("/api/persona_dashboard/groups").json()["groups"]), 1)
        self.assertEqual(stranger.get("/api/persona_dashboard/groups").json()["groups"], [])
        self.assertEqual(stranger.patch(f"/api/persona_dashboard/groups/{owner_group_id}", json={"name": "stolen"}).status_code, 404)

        denied = [
            stranger.patch(f"/api/persona_dashboard/automation/accounts/{account_id}", json={"display_name": "stolen"}),
            stranger.delete(f"/api/persona_dashboard/automation/accounts/{account_id}"),
            stranger.patch(f"/api/persona_dashboard/automation/proxies/{proxy_id}", json={"name": "stolen"}),
            stranger.delete(f"/api/persona_dashboard/automation/proxies/{proxy_id}"),
            stranger.get(f"/api/persona_dashboard/automation/tasks/{task_id}"),
            stranger.get(f"/api/persona_dashboard/automation/tasks/{task_id}/logs"),
            stranger.post(f"/api/persona_dashboard/automation/tasks/{task_id}/cancel", json={}),
            stranger.post(f"/api/persona_dashboard/automation/tasks/{task_id}/retry"),
            stranger.delete(f"/api/persona_dashboard/automation/tasks/{task_id}"),
        ]
        self.assertTrue(all(response.status_code == 404 for response in denied), [(response.status_code, response.text) for response in denied])

        cross_bind = stranger.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "shared_handle", "persona_id": stranger_persona_id, "proxy_id": proxy_id},
        )
        self.assertEqual(cross_bind.status_code, 404, cross_bind.text)

        own_same_username = stranger.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "shared_handle", "persona_id": stranger_persona_id},
        )
        self.assertEqual(own_same_username.status_code, 200, own_same_username.text)

        with server.db() as conn:
            self.assertEqual(int(conn.execute("SELECT user_id FROM social_accounts WHERE id = ?", (account_id,)).fetchone()["user_id"]), owner_id)
            self.assertEqual(int(conn.execute("SELECT user_id FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()["user_id"]), owner_id)
            self.assertEqual(int(conn.execute("SELECT user_id FROM social_automation_tasks WHERE id = ?", (task_id,)).fetchone()["user_id"]), owner_id)

        admin, _identity = self._admin_client()
        self.assertEqual(admin.get("/api/persona_dashboard/automation/accounts").json()["accounts"], [])
        self.assertEqual(admin.get(f"/api/persona_dashboard/personas/{owner_persona_id}/profile").status_code, 404)
        admin_console = admin.get("/console.html", follow_redirects=False)
        self.assertEqual(admin_console.status_code, 302)
        self.assertEqual(admin_console.headers["location"], "/admin")
        owner_detail = admin.get(f"/api/admin/users/{owner_id}")
        self.assertEqual(owner_detail.status_code, 200, owner_detail.text)
        self.assertEqual(owner_detail.json()["resource_counts"]["personas"], 1)
        self.assertEqual(owner_detail.json()["resource_counts"]["social_accounts"], 1)
        self.assertEqual(owner_detail.json()["resource_counts"]["social_proxies"], 1)
        self.assertEqual(owner_detail.json()["resource_counts"]["social_tasks"], 1)

    def test_deleting_customer_cascades_tenant_resources_without_user_zero_orphans(self):
        customer, customer_id = self._approved_client("delete_tenant")
        persona_response = customer.post(
            "/api/persona_dashboard/personas",
            json={"name": "Deleted tenant persona", "content": "Tenant-owned content"},
        )
        self.assertEqual(persona_response.status_code, 200, persona_response.text)
        persona_id = persona_response.json()["id"]
        group_response = customer.post("/api/persona_dashboard/groups", json={"name": "Deleted tenant group"})
        self.assertEqual(group_response.status_code, 200, group_response.text)
        group_id = group_response.json()["group"]["id"]
        account_response = customer.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "deleted_tenant_handle", "persona_id": persona_id},
        )
        self.assertEqual(account_response.status_code, 200, account_response.text)
        account_id = account_response.json()["account"]["id"]
        task_response = customer.post(
            "/api/persona_dashboard/automation/tasks",
            json={"account_id": account_id, "platform": "threads", "task_type": "check_login"},
        )
        self.assertEqual(task_response.status_code, 200, task_response.text)
        social_task_id = task_response.json()["task"]["id"]
        with server.db() as conn:
            profile_dir = Path(conn.execute("SELECT profile_dir FROM social_accounts WHERE id = ?", (account_id,)).fetchone()["profile_dir"])
            screenshot_dir = self.data_dir / "social_automation" / "screenshots"
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            screenshot_path = screenshot_dir / f"screenshot_{social_task_id}.png"
            screenshot_path.write_bytes(b"screenshot")
            conn.execute(
                "INSERT INTO social_automation_logs(task_id, level, stage, message, data_json, screenshot_path, created_at) VALUES (?, 'info', 'test', 'test', '{}', ?, 1)",
                (social_task_id, str(screenshot_path)),
            )
        profile_marker = profile_dir / "Cookies"
        profile_marker.write_text("sensitive cookie data", encoding="utf-8")
        social_upload_dir = self.data_dir / "social_automation" / "uploads" / str(customer_id) / "upload"
        social_upload_dir.mkdir(parents=True, exist_ok=True)
        (social_upload_dir / "media.png").write_bytes(b"media")
        regular_upload_dir = server.UPLOAD_ROOT / "delete_tenant" / "persona"
        regular_upload_dir.mkdir(parents=True, exist_ok=True)
        (regular_upload_dir / "reference.png").write_bytes(b"reference")

        admin, _identity = self._admin_client()
        deleted = admin.delete(f"/api/admin/users/{customer_id}")

        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["ok"], deleted.text)
        self.assertEqual(deleted.json()["deleted_personas"], 1)
        self.assertEqual(deleted.json()["deleted_groups"], 1)
        with server.db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM users WHERE id = ?", (customer_id,)).fetchone())
            for table in (
                "persona_owners",
                "persona_group_owners",
                "social_accounts",
                "social_proxies",
                "social_automation_tasks",
            ):
                count = int(conn.execute(f"SELECT COUNT(*) AS c FROM {table} WHERE user_id = ?", (customer_id,)).fetchone()["c"])
                self.assertEqual(count, 0, table)
                orphan_count = int(conn.execute(f"SELECT COUNT(*) AS c FROM {table} WHERE user_id = 0").fetchone()["c"])
                self.assertEqual(orphan_count, 0, table)
        archive_ids = {str(item.get("id") or "") for item in server._read_tool_r18_persona_archives()[0]}
        group_ids = {
            str(item.get("id") or "")
            for item in (server._read_persona_groups_config().get("groups") or [])
            if isinstance(item, dict)
        }
        self.assertNotIn(persona_id, archive_ids)
        self.assertNotIn(group_id, group_ids)
        self.assertFalse(profile_dir.exists())
        self.assertFalse((self.data_dir / "social_automation" / "uploads" / str(customer_id)).exists())
        self.assertFalse((server.UPLOAD_ROOT / "delete_tenant").exists())
        self.assertFalse(screenshot_path.exists())

    def test_tool_uploads_require_authenticated_session(self):
        sample = server.TOOL_R18_UPLOAD_ROOT / "security-sample.txt"
        sample.write_text("protected upload", encoding="utf-8")

        anonymous = TestClient(self.app)
        self.assertEqual(anonymous.get("/tool_r18_uploads/security-sample.txt").status_code, 401)

        admin, _identity = self._admin_client()
        allowed = admin.get("/tool_r18_uploads/security-sample.txt")
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(allowed.text, "protected upload")

    def test_password_change_gate_applies_to_social_automation_routes(self):
        customer, user_id = self._approved_client("password_gate_user")
        with server.db() as conn:
            conn.execute(
                "UPDATE users SET must_change_password = 1, password_expires_at = ? WHERE id = ?",
                (server._now_ts() + 3600, user_id),
            )

        persona_response = customer.get("/api/persona_dashboard/overview")
        social_response = customer.get("/api/persona_dashboard/automation/overview")

        self.assertEqual(persona_response.status_code, 428, persona_response.text)
        self.assertEqual(social_response.status_code, 428, social_response.text)
        self.assertEqual(social_response.json()["detail"]["code"], "password_change_required")

    def test_social_task_cannot_override_account_persona(self):
        owner, _owner_id = self._approved_client("task_owner")
        stranger, _stranger_id = self._approved_client("task_stranger")
        owner_persona = owner.post(
            "/api/persona_dashboard/personas",
            json={"name": "Owner task persona", "content": "Owner task content"},
        ).json()["id"]
        stranger_persona = stranger.post(
            "/api/persona_dashboard/personas",
            json={"name": "Stranger task persona", "content": "Stranger task content"},
        ).json()["id"]
        account_response = owner.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "task_owner_handle", "persona_id": owner_persona},
        )
        self.assertEqual(account_response.status_code, 200, account_response.text)
        account_id = account_response.json()["account"]["id"]

        injected = owner.post(
            "/api/persona_dashboard/automation/tasks",
            json={
                "account_id": account_id,
                "persona_id": stranger_persona,
                "platform": "threads",
                "task_type": "check_login",
            },
        )

        self.assertEqual(injected.status_code, 400, injected.text)
        self.assertEqual(owner.get("/api/persona_dashboard/automation/tasks").json()["tasks"], [])

    def test_social_task_media_cannot_read_another_tenant_upload(self):
        owner, owner_id = self._approved_client("media_owner")
        _stranger, stranger_id = self._approved_client("media_stranger")
        persona_id = owner.post(
            "/api/persona_dashboard/personas",
            json={"name": "Media owner persona", "content": "Owner media content"},
        ).json()["id"]
        account_id = owner.post(
            "/api/persona_dashboard/automation/accounts",
            json={"platform": "threads", "username": "media_owner_handle", "persona_id": persona_id},
        ).json()["account"]["id"]
        victim_dir = self.data_dir / "social_automation" / "uploads" / str(stranger_id) / "private"
        victim_dir.mkdir(parents=True, exist_ok=True)
        victim_path = victim_dir / "private.png"
        victim_path.write_bytes(b"private tenant media")

        for endpoint in ("check_login", "open_login"):
            denied = owner.post(
                f"/api/persona_dashboard/automation/accounts/{account_id}/{endpoint}",
                json={"payload": {"media_paths": [str(victim_path)]}},
            )
            self.assertEqual(denied.status_code, 404, denied.text)

        legacy_task = social_automation_api.create_social_task(
            social_automation_api.SocialTaskPayload(
                persona_id=persona_id,
                account_id=account_id,
                platform="threads",
                task_type="check_login",
                payload={"media_paths": [str(victim_path)]},
            )
        )
        with server.db() as conn:
            self.assertEqual(
                int(conn.execute("SELECT user_id FROM social_automation_tasks WHERE id = ?", (legacy_task["id"],)).fetchone()["user_id"]),
                owner_id,
            )
        denied_download = owner.get(
            f"/api/persona_dashboard/automation/tasks/{legacy_task['id']}/media/0"
        )
        self.assertEqual(denied_download.status_code, 404, denied_download.text)

    def test_persona_overview_queue_stats_are_tenant_scoped(self):
        owner, _owner_id = self._approved_client("queue_owner")
        stranger, _stranger_id = self._approved_client("queue_stranger")
        owner_persona = owner.post(
            "/api/persona_dashboard/personas",
            json={"name": "Queue owner", "content": "Queue owner content"},
        ).json()["id"]
        stranger_persona = stranger.post(
            "/api/persona_dashboard/personas",
            json={"name": "Queue stranger", "content": "Queue stranger content"},
        ).json()["id"]
        queue_db = server.TOOL_R18_RUNTIME_DIR / "publish_queue.db"
        conn = sqlite3.connect(str(queue_db))
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS publish_tasks (id TEXT PRIMARY KEY, archive_id TEXT, archive_post_id TEXT, pad_code TEXT, platform TEXT, status TEXT, scheduled_at TEXT, finished_at TEXT)"
            )
            conn.execute("DELETE FROM publish_tasks")
            conn.executemany(
                "INSERT INTO publish_tasks VALUES (?, ?, '', ?, 'threads', ?, ?, '')",
                [
                    ("queue-owner", owner_persona, "PAD-A", "queued", "2026-07-14T01:00:00Z"),
                    ("queue-stranger", stranger_persona, "PAD-B", "failed", "2026-07-14T02:00:00Z"),
                ],
            )
            conn.commit()
        finally:
            conn.close()

        owner_overview = owner.get("/api/persona_dashboard/overview").json()
        stranger_overview = stranger.get("/api/persona_dashboard/overview").json()

        self.assertEqual(owner_overview["summary"]["task_count"], 1)
        self.assertEqual(stranger_overview["summary"]["task_count"], 1)
        self.assertEqual(owner_overview["charts"]["task_status_distribution"], {"queued": 1})
        self.assertEqual(stranger_overview["charts"]["task_status_distribution"], {"failed": 1})
        self.assertEqual(set(owner_overview["data_sources"]["publish_queue"]["by_archive"]), {owner_persona})
        self.assertEqual(set(stranger_overview["data_sources"]["publish_queue"]["by_archive"]), {stranger_persona})

    def test_group_reorder_preserves_other_tenant_ungrouped_state(self):
        owner, _owner_id = self._approved_client("group_owner")
        stranger, _stranger_id = self._approved_client("group_stranger")
        owner_persona = owner.post(
            "/api/persona_dashboard/personas",
            json={"name": "Group owner", "content": "Group owner content"},
        ).json()["id"]
        stranger_persona = stranger.post(
            "/api/persona_dashboard/personas",
            json={"name": "Group stranger", "content": "Group stranger content"},
        ).json()["id"]
        owner_group = owner.post("/api/persona_dashboard/groups", json={"name": "Owner group"}).json()["group"]["id"]
        stranger_group = stranger.post("/api/persona_dashboard/groups", json={"name": "Stranger group"}).json()["group"]["id"]
        self.assertEqual(
            owner.post(f"/api/persona_dashboard/groups/{owner_group}/personas", json={"persona_id": owner_persona}).status_code,
            200,
        )
        self.assertEqual(
            stranger.post(f"/api/persona_dashboard/groups/{stranger_group}/personas", json={"persona_id": stranger_persona}).status_code,
            200,
        )
        self.assertEqual(
            stranger.delete(f"/api/persona_dashboard/groups/{stranger_group}/personas/{stranger_persona}").status_code,
            200,
        )

        reordered = owner.post(
            "/api/persona_dashboard/groups/reorder",
            json={"groups": [{"id": owner_group, "persona_ids": [owner_persona]}], "ungrouped_persona_ids": []},
        )
        stranger_state = stranger.get("/api/persona_dashboard/groups").json()

        self.assertEqual(reordered.status_code, 200, reordered.text)
        self.assertEqual(stranger_state["ungrouped_persona_ids"], [stranger_persona])
        self.assertEqual([group["id"] for group in stranger_state["groups"]], [stranger_group])

    def test_concurrent_customer_persona_creation_preserves_both_tenants(self):
        owner, _owner_id = self._approved_client("concurrent_owner")
        stranger, _stranger_id = self._approved_client("concurrent_stranger")

        def create(client, name):
            return client.post(
                "/api/persona_dashboard/personas",
                json={"name": name, "content": f"{name} content"},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            owner_future = executor.submit(create, owner, "Concurrent owner")
            stranger_future = executor.submit(create, stranger, "Concurrent stranger")
            owner_response = owner_future.result(timeout=10)
            stranger_response = stranger_future.result(timeout=10)

        self.assertEqual(owner_response.status_code, 200, owner_response.text)
        self.assertEqual(stranger_response.status_code, 200, stranger_response.text)
        self.assertEqual(
            [row["id"] for row in owner.get("/api/persona_dashboard/overview").json()["personas"]],
            [owner_response.json()["id"]],
        )
        self.assertEqual(
            [row["id"] for row in stranger.get("/api/persona_dashboard/overview").json()["personas"]],
            [stranger_response.json()["id"]],
        )

    def test_dashboard_media_proxy_rejects_database_and_runtime_config_paths(self):
        admin, _identity = self._admin_client()
        for path in (self.data_dir / "app.db", server.SENTIMENT_CONFIG_PATH):
            token = base64.urlsafe_b64encode(str(path.resolve()).encode("utf-8")).decode("ascii").rstrip("=")
            response = admin.get(f"/api/persona_dashboard/media/{token}")
            self.assertEqual(response.status_code, 404, response.text)

    def test_social_media_upload_rejects_excess_files_and_non_media_types(self):
        admin, _identity = self._admin_client()
        too_many = [
            ("files", (f"sample-{index}.png", b"not-an-image", "image/png"))
            for index in range(11)
        ]
        excessive = admin.post("/api/persona_dashboard/automation/media", files=too_many)
        self.assertEqual(excessive.status_code, 413, excessive.text)

        invalid = admin.post(
            "/api/persona_dashboard/automation/media",
            files={"files": ("payload.exe", b"binary", "application/octet-stream")},
        )
        self.assertEqual(invalid.status_code, 415, invalid.text)

    def test_admin_runtime_config_response_redacts_secrets(self):
        runtime = dict(server.DEFAULT_RUNTIME_CONFIG)
        runtime.update({
            "llm_api_key": "runtime-secret-key",
            "llm_api_key_gpt": "runtime-secret-key",
            "image_model_provider_api_key_gemini": "image-secret-key",
        })
        server._write_runtime_config_file(runtime)
        admin, _identity = self._admin_client()

        response = admin.get("/api/admin/runtime_config")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertNotIn("runtime-secret-key", response.text)
        self.assertNotIn("image-secret-key", response.text)
        self.assertEqual(payload["llm_api_key"], "")
        self.assertTrue(payload["llm_api_key_configured"])
        self.assertEqual(payload["llm_api_key_masked"], "•" * len("runtime-secret-key"))
        self.assertNotIn("runtime-secret-key"[:3], payload["llm_api_key_masked"])

    def test_admin_can_reveal_allowlisted_runtime_secret_on_demand(self):
        runtime = dict(server.DEFAULT_RUNTIME_CONFIG)
        runtime["llm_api_key_gpt"] = "runtime-secret-key"
        runtime["new_persona_runninghub_api_key"] = "runninghub-secret-key"
        server._write_runtime_config_file(runtime)

        admin, _identity = self._admin_client()
        revealed = admin.post(
            "/api/admin/runtime_config/secrets/llm_api_key_gpt",
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(revealed.status_code, 200, revealed.text)
        self.assertEqual(revealed.json(), {"key": "llm_api_key_gpt", "value": "runtime-secret-key"})
        self.assertIn("no-store", revealed.headers["cache-control"])
        self.assertEqual(revealed.headers["pragma"], "no-cache")

        runninghub_revealed = admin.post(
            "/api/admin/runtime_config/secrets/new_persona_runninghub_api_key",
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(runninghub_revealed.status_code, 200, runninghub_revealed.text)
        self.assertEqual(
            runninghub_revealed.json(),
            {"key": "new_persona_runninghub_api_key", "value": "runninghub-secret-key"},
        )

        unknown = admin.post(
            "/api/admin/runtime_config/secrets/telegram_bot_token",
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(unknown.status_code, 404, unknown.text)

    def test_admin_runtime_config_preserves_existing_secret_for_masked_form_save(self):
        runtime = dict(server.DEFAULT_RUNTIME_CONFIG)
        runtime["llm_api_key_gpt"] = "runtime-secret-key"
        server._write_runtime_config_file(runtime)
        admin, _identity = self._admin_client()

        response = admin.put("/api/admin/runtime_config", json={"llm_api_key_gpt": ""})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("runtime-secret-key", response.text)
        self.assertTrue(response.json()["runtime_config"]["llm_api_key_gpt_configured"])
        with server.db() as conn:
            saved = server._get_runtime_config(conn)
        self.assertEqual(saved["llm_api_key_gpt"], "runtime-secret-key")

    def test_admin_runninghub_key_status_uses_saved_key_and_reports_unusable(self):
        runtime = dict(server.DEFAULT_RUNTIME_CONFIG)
        runtime["new_persona_runninghub_api_key"] = "saved-runninghub-key"
        server._write_runtime_config_file(runtime)
        provider_response = Mock()
        provider_response.raise_for_status.return_value = None
        provider_response.json.return_value = {
            "code": 0,
            "msg": "success",
            "data": {
                "remainCoins": "6991",
                "remainMoney": "-0.130",
                "currency": "CNY",
                "apiType": "SHARED",
                "currentTaskCounts": "0",
            },
        }
        admin, _identity = self._admin_client()
        with patch.object(server.requests, "post", return_value=provider_response) as request_post:
            response = admin.post("/api/admin/runninghub/key_status", json={"type": "runninghub"})

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["valid"])
        self.assertFalse(payload["usable"])
        self.assertIn("企业余额不足", payload["message"])
        self.assertNotIn("saved-runninghub-key", response.text)
        self.assertEqual(request_post.call_args.kwargs["json"], {"apikey": "saved-runninghub-key"})

    def test_admin_runninghub_key_status_reports_invalid_key(self):
        provider_response = Mock()
        provider_response.raise_for_status.return_value = None
        provider_response.json.return_value = {"code": 806, "msg": "APIKEY_USER_NOT_FOUND", "data": None}
        admin, _identity = self._admin_client()
        with patch.object(server.requests, "post", return_value=provider_response):
            response = admin.post(
                "/api/admin/runninghub/key_status",
                json={"base_url": "https://www.runninghub.ai", "api_key": "invalid-key"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["valid"])
        self.assertIn("Key 无效", response.json()["message"])

    def test_public_application_switch_is_enforced(self):
        os.environ["ALLOW_PUBLIC_REGISTER"] = "0"
        response = TestClient(self.app).post("/api/auth/apply", json=self.application_payload("closed-application"))
        self.assertEqual(response.status_code, 403, response.text)

    def test_cookie_secure_default_tracks_force_https(self):
        os.environ.pop("SESSION_COOKIE_SECURE", None)
        os.environ["FORCE_HTTPS"] = "0"
        self.assertFalse(server._session_cookie_secure())
        os.environ["FORCE_HTTPS"] = "1"
        self.assertTrue(server._session_cookie_secure())

    def test_https_request_sets_secure_cookie_without_restart_environment(self):
        os.environ.pop("SESSION_COOKIE_SECURE", None)
        os.environ["FORCE_HTTPS"] = "0"
        client = TestClient(self.app, base_url="https://testserver")
        response = client.post(
            "/api/auth/login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("secure", response.headers["set-cookie"].lower())

    def test_dashboard_media_path_must_remain_inside_allowed_roots(self):
        allowed = server.DATA_DIR / "outputs" / "allowed.png"
        outside = Path(self.tmpdir.name).parent / "outside-dashboard-media.png"
        self.assertTrue(server._is_allowed_dashboard_media_path(allowed))
        self.assertFalse(server._is_allowed_dashboard_media_path(outside))

    def test_container_defaults_session_cookie_to_secure(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
        entrypoint = (root / "docker" / "entrypoint.sh").read_text(encoding="utf-8")
        self.assertIn("SESSION_COOKIE_SECURE=1", dockerfile)
        self.assertIn('SESSION_COOKIE_SECURE="${SESSION_COOKIE_SECURE:-1}"', entrypoint)

    def test_interactive_api_docs_are_not_public(self):
        anonymous = TestClient(self.app)
        self.assertEqual(anonymous.get("/docs").status_code, 404)
        self.assertEqual(anonymous.get("/openapi.json").status_code, 404)

    def test_empty_database_requires_explicit_admin_bootstrap_password(self):
        bootstrap_dir = self.data_dir / "explicit-bootstrap"
        self._configure_environment(bootstrap_dir, bootstrap_password=None)

        with self.assertRaises(RuntimeError):
            server.create_app()

        self._configure_environment(bootstrap_dir, bootstrap_password="one-time-admin-password")
        app = server.create_app()
        login = TestClient(app).post(
            "/api/auth/login",
            json={"username": "admin", "password": "one-time-admin-password"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.assertTrue(login.json()["is_admin"])

    def test_admin_cannot_disable_current_account(self):
        admin, identity = self._admin_client()

        response = admin.post(
            f"/api/admin/users/{identity['id']}/toggle",
            json={"is_disabled": True},
        )

        self.assertIn(response.status_code, (400, 409), response.text)
        self.assertEqual(admin.get("/api/me").status_code, 200)

    def test_approval_endpoint_enforces_allowed_state_transitions(self):
        pending_to_approved = self._apply("pending-approved")
        pending_to_rejected = self._apply("pending-rejected")
        admin, _identity = self._admin_client()

        approved = admin.post(
            f"/api/admin/users/{pending_to_approved}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending", "admin_note": "approved once"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)

        repeated_approval = admin.post(
            f"/api/admin/users/{pending_to_approved}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending", "admin_note": "stale request"},
        )
        self.assertEqual(repeated_approval.status_code, 409, repeated_approval.text)

        rejected = admin.post(
            f"/api/admin/users/{pending_to_rejected}/approval",
            json={"approval_status": "rejected", "expected_approval_status": "pending", "admin_note": "needs changes"},
        )
        self.assertEqual(rejected.status_code, 200, rejected.text)

        approved_after_rejection = admin.post(
            f"/api/admin/users/{pending_to_rejected}/approval",
            json={"approval_status": "approved", "expected_approval_status": "rejected", "admin_note": "changes verified"},
        )
        self.assertEqual(approved_after_rejection.status_code, 200, approved_after_rejection.text)

    def test_password_change_revokes_other_sessions_but_keeps_current_session(self):
        current_client = TestClient(self.app)
        other_client = TestClient(self.app)
        credentials = {"username": "admin", "password": self.ADMIN_PASSWORD}
        self.assertEqual(current_client.post("/api/auth/login", json=credentials).status_code, 200)
        self.assertEqual(other_client.post("/api/auth/login", json=credentials).status_code, 200)

        changed = current_client.post(
            "/api/auth/change_password",
            json={"old_password": self.ADMIN_PASSWORD, "new_password": "rotated-admin-password"},
        )

        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(current_client.get("/api/me").status_code, 200)
        self.assertEqual(other_client.get("/api/me").status_code, 401)

    def test_repeated_login_attempts_are_rate_limited(self):
        client = TestClient(self.app)
        statuses = [
            client.post(
                "/api/auth/login",
                json={"username": "unknown-user", "password": "incorrect-password"},
            ).status_code
            for _ in range(25)
        ]

        self.assertIn(429, statuses, statuses)

    def test_successful_logins_do_not_accumulate_ip_rate_limit_and_rotate_session(self):
        client = TestClient(self.app)
        credentials = {"username": "admin", "password": self.ADMIN_PASSWORD}
        first = client.post("/api/auth/login", json=credentials)
        self.assertEqual(first.status_code, 200, first.text)
        stale_token = first.cookies.get("session_token")

        statuses = [client.post("/api/auth/login", json=credentials).status_code for _ in range(35)]
        self.assertEqual(set(statuses), {200}, statuses)

        stale_client = TestClient(self.app, cookies={"session_token": stale_token})
        self.assertEqual(stale_client.get("/api/me").status_code, 401)

    def test_successful_login_does_not_clear_ip_failure_history(self):
        client = TestClient(self.app)
        for index in range(29):
            response = client.post(
                "/api/auth/login",
                json={"username": f"missing-{index}", "password": "incorrect-password"},
            )
            self.assertEqual(response.status_code, 401, response.text)

        success = client.post(
            "/api/auth/login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(success.status_code, 200, success.text)
        thirtieth_failure = client.post(
            "/api/auth/login",
            json={"username": "missing-29", "password": "incorrect-password"},
        )
        self.assertEqual(thirtieth_failure.status_code, 401, thirtieth_failure.text)
        blocked = client.post(
            "/api/auth/login",
            json={"username": "missing-30", "password": "incorrect-password"},
        )
        self.assertEqual(blocked.status_code, 429, blocked.text)

    def test_repeated_account_applications_are_rate_limited(self):
        client = TestClient(self.app)
        statuses = [
            client.post(
                "/api/auth/apply",
                json=self.application_payload(f"rate-user-{index}"),
            ).status_code
            for index in range(25)
        ]

        self.assertIn(429, statuses, statuses)


if __name__ == "__main__":
    unittest.main()
