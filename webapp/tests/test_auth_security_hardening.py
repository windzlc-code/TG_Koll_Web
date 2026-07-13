import os
import base64
import json
import tempfile
import unittest
from pathlib import Path

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
        social_automation_api.configure_social_automation(data_dir=self.data_dir)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        self.app = server.create_app()

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        server.SENTIMENT_CONFIG_PATH = self.old_sentiment_config_path
        server.TOOL_R18_UPLOAD_ROOT = self.old_tool_upload_root
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
        self.assertGreaterEqual(len(admin.get("/api/persona_dashboard/automation/accounts").json()["accounts"]), 2)
        owner_detail = admin.get(f"/api/admin/users/{owner_id}")
        self.assertEqual(owner_detail.status_code, 200, owner_detail.text)
        self.assertEqual(owner_detail.json()["resource_counts"]["personas"], 1)
        self.assertEqual(owner_detail.json()["resource_counts"]["social_accounts"], 1)
        self.assertEqual(owner_detail.json()["resource_counts"]["social_proxies"], 1)
        self.assertEqual(owner_detail.json()["resource_counts"]["social_tasks"], 1)

    def test_tool_uploads_require_authenticated_session(self):
        sample = server.TOOL_R18_UPLOAD_ROOT / "security-sample.txt"
        sample.write_text("protected upload", encoding="utf-8")

        anonymous = TestClient(self.app)
        self.assertEqual(anonymous.get("/tool_r18_uploads/security-sample.txt").status_code, 401)

        admin, _identity = self._admin_client()
        allowed = admin.get("/tool_r18_uploads/security-sample.txt")
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(allowed.text, "protected upload")

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
