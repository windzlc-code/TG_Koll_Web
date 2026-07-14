import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import webapp.server as server
from webapp import social_automation_api


class AdminWorkspaceManagementTests(unittest.TestCase):
    ENV_KEYS = (
        "APP_DB_PATH",
        "APP_RUNTIME_CONFIG_PATH",
        "WEBAPP_DATA_DIR",
        "TOOL_R18_RUNTIME_DIR",
        "ADMIN_BOOTSTRAP_PASSWORD",
        "SESSION_COOKIE_SECURE",
        "ALLOW_PUBLIC_REGISTER",
        "PASSWORD_VAULT_KEY",
        "PASSWORD_VAULT_KEY_FILE",
    )
    ADMIN_PASSWORD = "admin-workspace-secret"
    CUSTOMER_PASSWORD = "customer123"

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

        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.data_dir = Path(self.tmpdir.name)
        self.tool_runtime_dir = self.data_dir / "tool_r18_runtime"
        self.tool_runtime_dir.mkdir(parents=True, exist_ok=True)

        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["TOOL_R18_RUNTIME_DIR"] = str(self.tool_runtime_dir)
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = self.ADMIN_PASSWORD
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["ALLOW_PUBLIC_REGISTER"] = "1"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)

        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        server.SENTIMENT_CONFIG_PATH = self.data_dir / "sentiment-config.json"
        server.SENTIMENT_CONFIG_PATH.write_text("{}", encoding="utf-8")
        server.DATA_DIR = self.data_dir
        server.UPLOAD_ROOT = self.data_dir / "uploads"
        server.OUTPUT_ROOT = self.data_dir / "outputs"
        server.TOOL_R18_UPLOAD_ROOT = self.data_dir / "tool_r18_uploads"
        server.TOOL_R18_UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
        server.TOOL_R18_RUNTIME_DIR = self.tool_runtime_dir
        social_automation_api.configure_social_automation(data_dir=self.data_dir)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()

        self.app = server.create_app()
        self.admin = TestClient(self.app)
        admin_login = self.admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(admin_login.status_code, 200, admin_login.text)
        self.admin_user_id = int(admin_login.json()["id"])

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

    def _create_customer(self, username: str) -> tuple[TestClient, int]:
        applicant = TestClient(self.app)
        applied = applicant.post(
            "/api/auth/apply",
            json={
                "username": username,
                "password": self.CUSTOMER_PASSWORD,
                "full_name": f"{username} customer",
                "email": f"{username}@example.com",
                "phone": "0912345678",
                "company": "Workspace Test",
                "use_case": "Admin workspace management regression",
            },
        )
        self.assertEqual(applied.status_code, 200, applied.text)
        user_id = int(applied.json()["id"])
        approved = self.admin.post(
            f"/api/admin/users/{user_id}/approval",
            json={
                "approval_status": "approved",
                "expected_approval_status": "pending",
            },
        )
        self.assertEqual(approved.status_code, 200, approved.text)

        customer = TestClient(self.app)
        login = customer.post(
            "/api/auth/user-login",
            json={"username": username, "password": self.CUSTOMER_PASSWORD},
        )
        self.assertEqual(login.status_code, 200, login.text)
        return customer, user_id

    def _seed_workspace(self, customer: TestClient, user_id: int, label: str) -> dict[str, str]:
        persona_response = customer.post(
            "/api/persona_dashboard/personas",
            json={"name": f"{label} persona", "content": f"{label} persona content"},
        )
        self.assertEqual(persona_response.status_code, 200, persona_response.text)
        persona_id = str(persona_response.json()["id"])

        group_response = customer.post(
            "/api/persona_dashboard/groups",
            json={"name": f"{label} group"},
        )
        self.assertEqual(group_response.status_code, 200, group_response.text)
        group_id = str(group_response.json()["group"]["id"])
        assigned = customer.post(
            f"/api/persona_dashboard/groups/{group_id}/personas",
            json={"persona_id": persona_id},
        )
        self.assertEqual(assigned.status_code, 200, assigned.text)

        proxy_response = customer.post(
            "/api/persona_dashboard/automation/proxies",
            json={
                "name": f"{label} proxy",
                "proxy_type": "http",
                "host": "127.0.0.1",
                "port": 18080,
                "status": "active",
            },
        )
        self.assertEqual(proxy_response.status_code, 200, proxy_response.text)
        proxy_id = str(proxy_response.json()["proxy"]["id"])
        with server.db() as conn:
            conn.execute(
                "UPDATE social_proxies SET status = 'active', last_check_at = ?, last_check_result = ? WHERE id = ?",
                (
                    server._now_ts(),
                    json.dumps({"ok": True, "exit_ip": "8.8.8.8", "response": {"ip": "8.8.8.8"}}),
                    proxy_id,
                ),
            )

        account_response = customer.post(
            "/api/persona_dashboard/automation/accounts",
            json={
                "platform": "threads",
                "username": f"{label}_handle",
                "display_name": f"{label} account",
                "persona_id": persona_id,
                "proxy_id": proxy_id,
            },
        )
        self.assertEqual(account_response.status_code, 200, account_response.text)
        account_id = str(account_response.json()["account"]["id"])

        social_task_response = customer.post(
            "/api/persona_dashboard/automation/tasks",
            json={
                "account_id": account_id,
                "platform": "threads",
                "task_type": "check_login",
            },
        )
        self.assertEqual(social_task_response.status_code, 200, social_task_response.text)
        social_task_id = str(social_task_response.json()["task"]["id"])

        now = server._now_ts()
        normal_task_id = f"normal-task-{label}"
        ledger_id = f"ledger-{label}"
        with server.db() as conn:
            conn.execute(
                """
                INSERT INTO tasks(
                  id, user_id, type, status, input_json, output_json, error,
                  runninghub_task_id, usage_json, cost_cents, created_at, updated_at
                ) VALUES (?, ?, 'image_generate', 'success', '{}', '{}', '', '', '{}', 25, ?, ?)
                """,
                (normal_task_id, user_id, now, now),
            )
            conn.execute(
                """
                INSERT INTO ledger(id, user_id, type, amount_cents, ref_task_id, meta_json, created_at)
                VALUES (?, ?, 'task_charge', -25, ?, '{}', ?)
                """,
                (ledger_id, user_id, normal_task_id, now),
            )

        return {
            "persona_id": persona_id,
            "group_id": group_id,
            "proxy_id": proxy_id,
            "account_id": account_id,
            "social_task_id": social_task_id,
            "normal_task_id": normal_task_id,
            "ledger_id": ledger_id,
        }

    @staticmethod
    def _target_headers(user_id: int) -> dict[str, str]:
        return {"X-Admin-Workspace-User-ID": str(user_id)}

    def test_delete_archives_user_revokes_sessions_and_preserves_workspace_rows(self):
        customer, user_id = self._create_customer("archive_customer")
        resources = self._seed_workspace(customer, user_id, "archive")

        archived = self.admin.delete(f"/api/admin/users/{user_id}")

        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertTrue(archived.json()["ok"], archived.text)
        self.assertEqual(customer.get("/api/me").status_code, 401)
        with server.db() as conn:
            user_row = conn.execute(
                "SELECT id, is_disabled FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
            self.assertIsNotNone(user_row)
            self.assertEqual(int(user_row["is_disabled"]), 1)
            self.assertEqual(
                int(conn.execute("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?", (user_id,)).fetchone()["c"]),
                0,
            )
            expected_rows = {
                "persona_owners": ("archive_id", resources["persona_id"]),
                "persona_group_owners": ("group_id", resources["group_id"]),
                "social_accounts": ("id", resources["account_id"]),
                "social_proxies": ("id", resources["proxy_id"]),
                "social_automation_tasks": ("id", resources["social_task_id"]),
                "tasks": ("id", resources["normal_task_id"]),
                "ledger": ("id", resources["ledger_id"]),
            }
            for table, (column, value) in expected_rows.items():
                row = conn.execute(
                    f"SELECT 1 FROM {table} WHERE {column} = ? AND user_id = ?",
                    (value, user_id),
                ).fetchone()
                self.assertIsNotNone(row, table)

        persona_ids = {str(item.get("id") or "") for item in server._read_tool_r18_persona_archives()[0]}
        group_ids = {
            str(item.get("id") or "")
            for item in (server._read_persona_groups_config().get("groups") or [])
            if isinstance(item, dict)
        }
        self.assertIn(resources["persona_id"], persona_ids)
        self.assertIn(resources["group_id"], group_ids)

    def test_admin_can_restore_archived_user(self):
        _customer, user_id = self._create_customer("restore_customer")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)

        restored = self.admin.post(f"/api/admin/users/{user_id}/restore")

        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertTrue(restored.json()["ok"], restored.text)
        with server.db() as conn:
            row = conn.execute("SELECT is_disabled FROM users WHERE id = ?", (user_id,)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(int(row["is_disabled"]), 0)
        login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "restore_customer", "password": self.CUSTOMER_PASSWORD},
        )
        self.assertEqual(login.status_code, 200, login.text)
        with server.db() as conn:
            audit = conn.execute(
                "SELECT 1 FROM admin_audit_log WHERE action = 'user.restore' AND target_user_id = ?",
                (user_id,),
            ).fetchone()
        self.assertIsNotNone(audit)

    def test_archived_user_cannot_be_reenabled_through_generic_account_actions(self):
        _customer, user_id = self._create_customer("archived_action_guard")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)

        toggled = self.admin.post(
            f"/api/admin/users/{user_id}/toggle",
            json={"is_disabled": False},
        )
        approval = self.admin.post(
            f"/api/admin/users/{user_id}/approval",
            json={
                "approval_status": "approved",
                "expected_approval_status": "rejected",
            },
        )

        self.assertEqual(toggled.status_code, 409, toggled.text)
        self.assertEqual(approval.status_code, 409, approval.text)
        login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "archived_action_guard", "password": self.CUSTOMER_PASSWORD},
        )
        self.assertEqual(login.status_code, 403, login.text)

    def test_admin_can_read_and_modify_explicit_target_user_workspace(self):
        customer, user_id = self._create_customer("workspace_owner")
        resources = self._seed_workspace(customer, user_id, "owner")
        target_headers = self._target_headers(user_id)

        overview = self.admin.get("/api/persona_dashboard/overview", headers=target_headers)
        groups = self.admin.get("/api/persona_dashboard/groups", headers=target_headers)
        accounts = self.admin.get("/api/persona_dashboard/automation/accounts", headers=target_headers)
        proxies = self.admin.get("/api/persona_dashboard/automation/proxies", headers=target_headers)

        for response in (overview, groups, accounts, proxies):
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in overview.json()["personas"]], [resources["persona_id"]])
        self.assertEqual([item["id"] for item in groups.json()["groups"]], [resources["group_id"]])
        self.assertEqual([item["id"] for item in accounts.json()["accounts"]], [resources["account_id"]])
        self.assertEqual([item["id"] for item in proxies.json()["proxies"]], [resources["proxy_id"]])

        updates = (
            self.admin.patch(
                f"/api/persona_dashboard/personas/{resources['persona_id']}/profile",
                json={"name": "Admin updated persona", "content": "Updated by an administrator"},
                headers=target_headers,
            ),
            self.admin.patch(
                f"/api/persona_dashboard/groups/{resources['group_id']}",
                json={"name": "Admin updated group"},
                headers=target_headers,
            ),
            self.admin.patch(
                f"/api/persona_dashboard/automation/accounts/{resources['account_id']}",
                json={"display_name": "Admin updated account"},
                headers=target_headers,
            ),
            self.admin.patch(
                f"/api/persona_dashboard/automation/proxies/{resources['proxy_id']}",
                json={"name": "Admin updated proxy"},
                headers=target_headers,
            ),
        )
        for response in updates:
            self.assertEqual(response.status_code, 200, response.text)

        profile = customer.get(f"/api/persona_dashboard/personas/{resources['persona_id']}/profile")
        own_groups = customer.get("/api/persona_dashboard/groups")
        own_accounts = customer.get("/api/persona_dashboard/automation/accounts")
        own_proxies = customer.get("/api/persona_dashboard/automation/proxies")
        self.assertEqual(profile.json()["name"], "Admin updated persona")
        self.assertEqual(own_groups.json()["groups"][0]["name"], "Admin updated group")
        self.assertEqual(own_accounts.json()["accounts"][0]["display_name"], "Admin updated account")
        self.assertEqual(own_proxies.json()["proxies"][0]["name"], "Admin updated proxy")
        with server.db() as conn:
            audit_actions = {
                str(row["action"])
                for row in conn.execute(
                    "SELECT action FROM admin_audit_log WHERE target_user_id = ?",
                    (user_id,),
                ).fetchall()
            }
        self.assertTrue(
            {
                "workspace.persona.update",
                "workspace.group.update",
                "workspace.social_account.update",
                "workspace.social_proxy.update",
            }.issubset(audit_actions),
            audit_actions,
        )

    def test_ordinary_user_cannot_use_target_user_workspace_or_cross_tenants(self):
        owner, owner_id = self._create_customer("target_owner")
        resources = self._seed_workspace(owner, owner_id, "target")
        stranger, _stranger_id = self._create_customer("target_stranger")
        target_headers = self._target_headers(owner_id)

        admin_workspace_attempts = (
            stranger.get("/api/persona_dashboard/overview", headers=target_headers),
            stranger.patch(
                f"/api/persona_dashboard/personas/{resources['persona_id']}/profile",
                json={"name": "stolen"},
                headers=target_headers,
            ),
            stranger.patch(
                f"/api/persona_dashboard/groups/{resources['group_id']}",
                json={"name": "stolen"},
                headers=target_headers,
            ),
            stranger.patch(
                f"/api/persona_dashboard/automation/accounts/{resources['account_id']}",
                json={"display_name": "stolen"},
                headers=target_headers,
            ),
            stranger.patch(
                f"/api/persona_dashboard/automation/proxies/{resources['proxy_id']}",
                json={"name": "stolen"},
                headers=target_headers,
            ),
        )
        self.assertTrue(
            all(response.status_code == 403 for response in admin_workspace_attempts),
            [(response.status_code, response.text) for response in admin_workspace_attempts],
        )

        tenant_api_attempts = (
            stranger.get(f"/api/persona_dashboard/personas/{resources['persona_id']}/profile"),
            stranger.patch(
                f"/api/persona_dashboard/groups/{resources['group_id']}",
                json={"name": "stolen"},
            ),
            stranger.patch(
                f"/api/persona_dashboard/automation/accounts/{resources['account_id']}",
                json={"display_name": "stolen"},
            ),
            stranger.patch(
                f"/api/persona_dashboard/automation/proxies/{resources['proxy_id']}",
                json={"name": "stolen"},
            ),
        )
        self.assertTrue(
            all(response.status_code == 404 for response in tenant_api_attempts),
            [(response.status_code, response.text) for response in tenant_api_attempts],
        )

    def test_admin_archive_action_is_audited(self):
        _customer, user_id = self._create_customer("audit_customer")

        archived = self.admin.delete(f"/api/admin/users/{user_id}")

        self.assertEqual(archived.status_code, 200, archived.text)
        with server.db() as conn:
            row = conn.execute(
                """
                SELECT admin_user_id, action, target_user_id, metadata_json, created_at
                FROM admin_audit_log
                WHERE action = 'user.archive' AND target_user_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (user_id,),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(int(row["admin_user_id"]), self.admin_user_id)
        self.assertEqual(str(row["action"]), "user.archive")
        self.assertEqual(int(row["target_user_id"]), user_id)
        self.assertIsInstance(json.loads(str(row["metadata_json"])), dict)
        self.assertGreater(int(row["created_at"]), 0)

    def test_admin_workspace_console_bootstraps_target_identity(self):
        _customer, user_id = self._create_customer("console_workspace_owner")

        page = self.admin.get(f"/admin-console.html?manage_user_id={user_id}", follow_redirects=False)
        me = self.admin.get("/api/me", headers=self._target_headers(user_id))
        normal_admin_console = self.admin.get("/console.html", follow_redirects=False)
        personal_admin_console = self.admin.get("/admin-console.html", follow_redirects=False)
        admin_me = self.admin.get("/api/me", headers={"X-Admin-Console": "1"})

        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn(f'content="{user_id}"', page.text)
        self.assertIn("admin_workspace", page.text)
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(int(me.json()["id"]), user_id)
        self.assertEqual(me.json()["username"], "console_workspace_owner")
        self.assertTrue(me.json()["acting_admin"])
        self.assertFalse(me.json()["is_admin"])
        self.assertEqual(normal_admin_console.status_code, 302, normal_admin_console.text)
        self.assertEqual(normal_admin_console.headers["location"], "/admin-console.html")
        self.assertEqual(personal_admin_console.status_code, 200, personal_admin_console.text)
        self.assertIn('name="admin-workspace-user-id" content=""', personal_admin_console.text)
        self.assertIn('name="admin-console-session" content="1"', personal_admin_console.text)
        self.assertNotIn(f'content="{user_id}"', personal_admin_console.text)
        self.assertEqual(admin_me.status_code, 200, admin_me.text)
        self.assertEqual(int(admin_me.json()["id"]), self.admin_user_id)
        self.assertTrue(admin_me.json()["is_admin"])

    def test_account_owner_can_reveal_saved_social_login_password(self):
        customer, _user_id = self._create_customer("credential_workspace_owner")
        created = customer.post(
            "/api/persona_dashboard/automation/accounts",
            json={
                "platform": "threads",
                "username": "credential-thread",
                "login_username": "credential@example.com",
                "login_password": "social-login-secret",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        account_id = str(created.json()["account"]["id"])

        credentials = customer.get(
            f"/api/persona_dashboard/automation/accounts/{account_id}/credentials"
        )

        self.assertEqual(credentials.status_code, 200, credentials.text)
        self.assertEqual(credentials.headers.get("cache-control"), "no-store")
        self.assertEqual(credentials.json()["login_username"], "credential@example.com")
        self.assertEqual(credentials.json()["login_password"], "social-login-secret")

    def test_admin_can_create_resources_owned_by_target_workspace(self):
        _customer, user_id = self._create_customer("admin_create_owner")
        headers = self._target_headers(user_id)

        persona = self.admin.post(
            "/api/persona_dashboard/personas",
            json={"name": "Created by admin", "content": "Target-owned content"},
            headers=headers,
        )
        group = self.admin.post(
            "/api/persona_dashboard/groups",
            json={"name": "Created target group"},
            headers=headers,
        )
        proxy = self.admin.post(
            "/api/persona_dashboard/automation/proxies",
            json={"name": "Created target proxy", "proxy_type": "http", "host": "127.0.0.1", "port": 18081},
            headers=headers,
        )
        for response in (persona, group, proxy):
            self.assertEqual(response.status_code, 200, response.text)

        with server.db() as conn:
            persona_owner = conn.execute("SELECT user_id FROM persona_owners WHERE archive_id = ?", (persona.json()["id"],)).fetchone()
            group_owner = conn.execute("SELECT user_id FROM persona_group_owners WHERE group_id = ?", (group.json()["group"]["id"],)).fetchone()
            proxy_owner = conn.execute("SELECT user_id FROM social_proxies WHERE id = ?", (proxy.json()["proxy"]["id"],)).fetchone()
        self.assertEqual(int(persona_owner["user_id"]), user_id)
        self.assertEqual(int(group_owner["user_id"]), user_id)
        self.assertEqual(int(proxy_owner["user_id"]), user_id)

    def test_admin_can_manage_preserved_data_after_account_archive(self):
        customer, user_id = self._create_customer("archived_workspace_owner")
        resources = self._seed_workspace(customer, user_id, "archived-workspace")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)
        headers = self._target_headers(user_id)

        overview = self.admin.get("/api/persona_dashboard/overview", headers=headers)
        updated = self.admin.patch(
            f"/api/persona_dashboard/personas/{resources['persona_id']}/profile",
            json={"name": "Archived data managed by admin"},
            headers=headers,
        )

        self.assertEqual(overview.status_code, 200, overview.text)
        self.assertIn(resources["persona_id"], [item["id"] for item in overview.json()["personas"]])
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["name"], "Archived data managed by admin")

    def test_admin_workspace_query_context_supports_native_get_requests(self):
        customer, user_id = self._create_customer("native_context_owner")
        resources = self._seed_workspace(customer, user_id, "native-context")
        path = (
            f"/api/tasks/{resources['normal_task_id']}"
            f"?admin_workspace_user_id={user_id}"
        )

        target_response = self.admin.get(path)
        own_admin_response = self.admin.get(f"/api/tasks/{resources['normal_task_id']}")
        ordinary_response = customer.get(path)

        self.assertEqual(target_response.status_code, 200, target_response.text)
        self.assertEqual(own_admin_response.status_code, 404, own_admin_response.text)
        self.assertEqual(ordinary_response.status_code, 403, ordinary_response.text)

    def test_admin_workspace_rejects_customer_self_service_identity_changes(self):
        _customer, user_id = self._create_customer("self_service_guard")
        headers = self._target_headers(user_id)

        password_change = self.admin.post(
            "/api/auth/change_password",
            json={
                "old_password": self.ADMIN_PASSWORD,
                "new_password": "changed-admin-password",
            },
            headers=headers,
        )
        username_change = self.admin.post(
            "/api/auth/change_username",
            json={
                "password": self.ADMIN_PASSWORD,
                "new_username": "changed_admin_username",
            },
            headers=headers,
        )

        self.assertEqual(password_change.status_code, 403, password_change.text)
        self.assertEqual(username_change.status_code, 403, username_change.text)
        fresh_admin = TestClient(self.app).post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(fresh_admin.status_code, 200, fresh_admin.text)

    def test_active_account_cannot_be_permanently_purged(self):
        customer, user_id = self._create_customer("active_purge_guard")
        resources = self._seed_workspace(customer, user_id, "active-purge")

        response = self.admin.delete(
            f"/api/admin/users/{user_id}/purge",
            params={"confirm_username": "active_purge_guard"},
        )

        self.assertEqual(response.status_code, 409, response.text)
        with server.db() as conn:
            self.assertIsNotNone(conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())
            self.assertIsNotNone(
                conn.execute(
                    "SELECT archive_id FROM persona_owners WHERE archive_id = ? AND user_id = ?",
                    (resources["persona_id"], user_id),
                ).fetchone()
            )

    def test_purge_cleanup_failure_preserves_account_persona_and_group(self):
        customer, user_id = self._create_customer("purge_cleanup_failure")
        resources = self._seed_workspace(customer, user_id, "purge-cleanup-failure")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)
        upload_dir = server.UPLOAD_ROOT / "purge_cleanup_failure"
        upload_dir.mkdir(parents=True, exist_ok=True)
        (upload_dir / "artifact.txt").write_text("keep until purge succeeds", encoding="utf-8")

        with patch.object(server.shutil, "rmtree", side_effect=OSError("injected cleanup failure")):
            response = self.admin.delete(
                f"/api/admin/users/{user_id}/purge",
                params={"confirm_username": "purge_cleanup_failure"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["ok"], response.text)
        with server.db() as conn:
            self.assertIsNotNone(conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())
            self.assertIsNotNone(
                conn.execute(
                    "SELECT archive_id FROM persona_owners WHERE archive_id = ? AND user_id = ?",
                    (resources["persona_id"], user_id),
                ).fetchone()
            )
            self.assertIsNotNone(
                conn.execute(
                    "SELECT group_id FROM persona_group_owners WHERE group_id = ? AND user_id = ?",
                    (resources["group_id"], user_id),
                ).fetchone()
            )
        persona_ids = {str(item.get("id") or "") for item in server._read_tool_r18_persona_archives()[0]}
        group_ids = {
            str(item.get("id") or "")
            for item in (server._read_persona_groups_config().get("groups") or [])
            if isinstance(item, dict)
        }
        self.assertIn(resources["persona_id"], persona_ids)
        self.assertIn(resources["group_id"], group_ids)

    def test_purge_group_cleanup_failure_rolls_back_and_can_be_retried(self):
        customer, user_id = self._create_customer("purge_group_failure")
        resources = self._seed_workspace(customer, user_id, "purge-group-failure")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)

        with patch.object(server, "_delete_persona_groups", side_effect=OSError("injected group cleanup failure")):
            response = self.admin.delete(
                f"/api/admin/users/{user_id}/purge",
                params={"confirm_username": "purge_group_failure"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["ok"], response.text)
        self.assertTrue(
            any(item.startswith("groups:") for item in response.json()["cleanup_pending"]),
            response.text,
        )
        with server.db() as conn:
            self.assertIsNotNone(conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())
            self.assertIsNotNone(
                conn.execute(
                    "SELECT archive_id FROM persona_owners WHERE archive_id = ? AND user_id = ?",
                    (resources["persona_id"], user_id),
                ).fetchone()
            )
            self.assertIsNotNone(
                conn.execute(
                    "SELECT group_id FROM persona_group_owners WHERE group_id = ? AND user_id = ?",
                    (resources["group_id"], user_id),
                ).fetchone()
            )
        persona_ids = {str(item.get("id") or "") for item in server._read_tool_r18_persona_archives()[0]}
        group_ids = {
            str(item.get("id") or "")
            for item in (server._read_persona_groups_config().get("groups") or [])
            if isinstance(item, dict)
        }
        self.assertIn(resources["persona_id"], persona_ids)
        self.assertIn(resources["group_id"], group_ids)

        retried = self.admin.delete(
            f"/api/admin/users/{user_id}/purge",
            params={"confirm_username": "purge_group_failure"},
        )

        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertTrue(retried.json()["ok"], retried.text)
        with server.db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())
        persona_ids = {str(item.get("id") or "") for item in server._read_tool_r18_persona_archives()[0]}
        group_ids = {
            str(item.get("id") or "")
            for item in (server._read_persona_groups_config().get("groups") or [])
            if isinstance(item, dict)
        }
        self.assertNotIn(resources["persona_id"], persona_ids)
        self.assertNotIn(resources["group_id"], group_ids)

    def test_interrupted_purge_blocks_restore_and_recovers_on_retry(self):
        customer, user_id = self._create_customer("interrupted_purge")
        resources = self._seed_workspace(customer, user_id, "interrupted-purge")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)

        server._create_account_purge_journal(user_id)
        server._delete_persona_dashboard_personas([resources["persona_id"]])

        restore = self.admin.post(f"/api/admin/users/{user_id}/restore")
        retried = self.admin.delete(
            f"/api/admin/users/{user_id}/purge",
            params={"confirm_username": "interrupted_purge"},
        )

        self.assertEqual(restore.status_code, 409, restore.text)
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertTrue(retried.json()["ok"], retried.text)
        self.assertFalse(server._account_purge_journal_dir(user_id).exists())
        with server.db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())
        persona_ids = {str(item.get("id") or "") for item in server._read_tool_r18_persona_archives()[0]}
        group_ids = {
            str(item.get("id") or "")
            for item in (server._read_persona_groups_config().get("groups") or [])
            if isinstance(item, dict)
        }
        self.assertNotIn(resources["persona_id"], persona_ids)
        self.assertNotIn(resources["group_id"], group_ids)

    def test_restore_waits_for_in_progress_purge_and_cannot_reenable_deleted_account(self):
        _customer, user_id = self._create_customer("purge_restore_race")
        archived = self.admin.delete(f"/api/admin/users/{user_id}")
        self.assertEqual(archived.status_code, 200, archived.text)
        upload_dir = server.UPLOAD_ROOT / "purge_restore_race"
        upload_dir.mkdir(parents=True, exist_ok=True)
        (upload_dir / "artifact.txt").write_text("purge race", encoding="utf-8")

        restore_admin = TestClient(self.app)
        restore_login = restore_admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(restore_login.status_code, 200, restore_login.text)

        purge_paused = threading.Event()
        allow_purge = threading.Event()
        restore_finished = threading.Event()
        responses: dict[str, object] = {}
        original_rmtree = server.shutil.rmtree

        def blocking_rmtree(path, *args, **kwargs):
            if Path(path).resolve() == upload_dir.resolve():
                purge_paused.set()
                if not allow_purge.wait(timeout=5):
                    raise TimeoutError("test did not release purge")
            return original_rmtree(path, *args, **kwargs)

        def run_purge():
            try:
                responses["purge"] = self.admin.delete(
                    f"/api/admin/users/{user_id}/purge",
                    params={"confirm_username": "purge_restore_race"},
                )
            except BaseException as exc:
                responses["purge_error"] = exc

        def run_restore():
            try:
                responses["restore"] = restore_admin.post(f"/api/admin/users/{user_id}/restore")
            except BaseException as exc:
                responses["restore_error"] = exc
            finally:
                restore_finished.set()

        with patch.object(server.shutil, "rmtree", side_effect=blocking_rmtree):
            purge_thread = threading.Thread(target=run_purge, daemon=True)
            restore_thread = threading.Thread(target=run_restore, daemon=True)
            purge_thread.start()
            self.assertTrue(purge_paused.wait(timeout=5), responses)
            restore_thread.start()
            restore_completed_while_purge_paused = restore_finished.wait(timeout=1)
            allow_purge.set()
            purge_thread.join(timeout=5)
            restore_thread.join(timeout=5)

        self.assertFalse(purge_thread.is_alive(), responses)
        self.assertFalse(restore_thread.is_alive(), responses)
        self.assertFalse(restore_completed_while_purge_paused, responses)
        self.assertNotIn("purge_error", responses)
        self.assertNotIn("restore_error", responses)
        purge_response = responses["purge"]
        restore_response = responses["restore"]
        self.assertEqual(purge_response.status_code, 200, purge_response.text)
        self.assertTrue(purge_response.json()["ok"], purge_response.text)
        self.assertEqual(restore_response.status_code, 404, restore_response.text)
        with server.db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())

    def test_live_browser_sessions_allow_admin_global_access_but_keep_customer_scope(self):
        sessions = [{"id": "live-session", "task_id": "task-1"}]
        with patch.object(social_automation_api, "_live_browser_sessions", return_value=sessions) as lookup:
            self.assertTrue(
                social_automation_api._live_browser_session_accessible(
                    "live-session",
                    {"id": self.admin_user_id, "is_admin": 1},
                )
            )
            lookup.assert_called_with(user_id=None)

        with patch.object(social_automation_api, "_live_browser_sessions", return_value=sessions) as lookup:
            self.assertTrue(
                social_automation_api._live_browser_session_accessible(
                    "live-session",
                    {"id": self.admin_user_id, "is_admin": 1, "_workspace_user_id": 42},
                )
            )
            lookup.assert_called_with(user_id=42)

        with patch.object(social_automation_api, "_live_browser_sessions", return_value=[]) as lookup:
            self.assertFalse(
                social_automation_api._live_browser_session_accessible(
                    "live-session",
                    {"id": 43, "is_admin": 0},
                )
            )
            lookup.assert_called_with(user_id=43)


if __name__ == "__main__":
    unittest.main()
