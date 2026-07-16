import csv
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import governance, password_vault
from webapp import social_automation_api
from webapp import db as db_module
import webapp.server as server


class AccountGovernanceTests(unittest.TestCase):
    ADMIN_PASSWORD = "admin123secure"
    ORIGIN_HEADERS = {"Origin": "http://testserver"}
    ENV_KEYS = (
        "APP_DB_PATH",
        "APP_RUNTIME_CONFIG_PATH",
        "WEBAPP_DATA_DIR",
        "ADMIN_BOOTSTRAP_PASSWORD",
        "SESSION_COOKIE_SECURE",
        "PASSWORD_VAULT_KEY",
        "PASSWORD_VAULT_KEY_FILE",
        "PASSWORD_VAULT_KEY_VERSION",
        "PASSWORD_VAULT_KEYS_JSON",
        "PASSWORD_VAULT_LEGACY_KEY_VERSION",
    )

    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        self.old_paths = {
            "RUNTIME_CONFIG_PATH": server.RUNTIME_CONFIG_PATH,
            "SENTIMENT_CONFIG_PATH": server.SENTIMENT_CONFIG_PATH,
            "DATA_DIR": server.DATA_DIR,
            "UPLOAD_ROOT": server.UPLOAD_ROOT,
            "OUTPUT_ROOT": server.OUTPUT_ROOT,
            "TOOL_R18_UPLOAD_ROOT": server.TOOL_R18_UPLOAD_ROOT,
            "TOOL_R18_RUNTIME_DIR": server.TOOL_R18_RUNTIME_DIR,
        }
        self.old_social_data_dir = social_automation_api._DATA_DIR
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmpdir.name)

        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime.json")
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = self.ADMIN_PASSWORD
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)

        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        server.SENTIMENT_CONFIG_PATH = self.data_dir / "sentiment-config.json"
        server.SENTIMENT_CONFIG_PATH.write_text("{}", encoding="utf-8")
        server.DATA_DIR = self.data_dir
        server.UPLOAD_ROOT = self.data_dir / "uploads"
        server.OUTPUT_ROOT = self.data_dir / "outputs"
        server.TOOL_R18_UPLOAD_ROOT = self.data_dir / "tool-r18-uploads"
        server.TOOL_R18_RUNTIME_DIR = self.data_dir / "tool-r18-runtime"
        social_automation_api.configure_social_automation(data_dir=self.data_dir)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        with server._ADMIN_DASHBOARD_CACHE_LOCK:
            server._ADMIN_DASHBOARD_CACHE.clear()
        self.app = server.create_app()

    def tearDown(self):
        for name, value in self.old_paths.items():
            setattr(server, name, value)
        social_automation_api.configure_social_automation(data_dir=self.old_social_data_dir)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        with server._ADMIN_DASHBOARD_CACHE_LOCK:
            server._ADMIN_DASHBOARD_CACHE.clear()
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    def _admin_client(self) -> tuple[TestClient, dict]:
        client = TestClient(self.app)
        response = client.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["is_admin"])
        client.headers["X-Admin-Console"] = "1"
        return client, response.json()

    def _create_customer(
        self,
        admin: TestClient,
        username: str,
        password: str = "CustomerPass123",
    ) -> dict:
        response = admin.post(
            "/api/admin/users",
            json={"username": username, "password": password, "is_admin": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["user"]

    def _enable_admin_mfa(self, admin: TestClient) -> tuple[str, list[str]]:
        setup = admin.post("/api/auth/mfa/setup", headers=self.ORIGIN_HEADERS, json={"current_password": self.ADMIN_PASSWORD})
        self.assertEqual(setup.status_code, 200, setup.text)
        self.assertIn("no-store", setup.headers.get("cache-control", ""))
        body = setup.json()
        secret = str(body["secret"])
        recovery_codes = [str(code) for code in body["recovery_codes"]]
        verified = admin.post(
            "/api/auth/mfa/verify-setup",
            headers=self.ORIGIN_HEADERS,
            json={"code": governance.totp_code(secret)},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        return secret, recovery_codes

    def test_governance_schema_and_lifecycle_projection(self):
        governance_tables = {
            "schema_migrations",
            "customer_groups",
            "customer_group_members",
            "customer_tags",
            "customer_tag_assignments",
            "password_vault_history",
            "user_mfa",
            "audit_events",
            "audit_archives",
            "security_alerts",
            "security_alert_timeline",
            "service_accounts",
            "admin_batch_jobs",
            "admin_batch_job_results",
        }
        with db_module.db() as conn:
            tables = {
                str(row["name"])
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            user_columns = {
                str(row["name"]) for row in conn.execute("PRAGMA table_info(users)")
            }
            session_columns = {
                str(row["name"]) for row in conn.execute("PRAGMA table_info(sessions)")
            }
            migration = conn.execute(
                "SELECT description, applied_at FROM schema_migrations WHERE version = 'governance_v1'"
            ).fetchone()

        self.assertTrue(governance_tables.issubset(tables))
        self.assertTrue(
            {
                "lifecycle_status",
                "lifecycle_reason",
                "risk_level",
                "owner_admin_id",
                "locked_at",
                "row_version",
            }.issubset(user_columns)
        )
        self.assertTrue(
            {
                "device_id",
                "ip_address",
                "user_agent",
                "last_seen_at",
                "revoked_at",
                "revoke_reason",
                "is_admin_session",
            }.issubset(session_columns)
        )
        self.assertIsNotNone(migration)
        self.assertGreater(int(migration["applied_at"]), 0)
        self.assertEqual(
            governance.lifecycle_for_user(
                {"lifecycle_status": "", "approval_status": "pending", "deleted_at": 0, "is_disabled": 1}
            ),
            "pending",
        )
        self.assertEqual(
            governance.lifecycle_for_user(
                {"lifecycle_status": "", "approval_status": "approved", "deleted_at": 1, "is_disabled": 0}
            ),
            "archived",
        )
        self.assertEqual(
            governance.lifecycle_for_user(
                {"lifecycle_status": "locked", "approval_status": "approved", "deleted_at": 0, "is_disabled": 0}
            ),
            "locked",
        )

    def test_customer_session_digest_single_session_takeover_and_revoke(self):
        admin, _ = self._admin_client()
        customer = self._create_customer(admin, "session-customer")
        customer_id = int(customer["id"])

        first = TestClient(self.app)
        first_login = first.post(
            "/api/auth/user-login",
            json={
                "username": "session-customer",
                "password": "CustomerPass123",
                "device_id": "device-a",
            },
        )
        self.assertEqual(first_login.status_code, 200, first_login.text)
        raw_token = str(first.cookies.get("session_token") or "")
        self.assertTrue(raw_token)
        with db_module.db() as conn:
            stored = conn.execute(
                "SELECT token, revoked_at FROM sessions WHERE user_id = ?",
                (customer_id,),
            ).fetchone()
        self.assertEqual(str(stored["token"]), governance.token_digest(raw_token))
        self.assertNotEqual(str(stored["token"]), raw_token)
        self.assertEqual(int(stored["revoked_at"]), 0)

        second = TestClient(self.app)
        conflict = second.post(
            "/api/auth/user-login",
            json={
                "username": "session-customer",
                "password": "CustomerPass123",
                "device_id": "device-b",
            },
        )
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertEqual(conflict.json()["detail"]["code"], "SESSION_CONFLICT")

        takeover = second.post(
            "/api/auth/user-login",
            json={
                "username": "session-customer",
                "password": "CustomerPass123",
                "device_id": "device-b",
                "force_takeover": True,
            },
        )
        self.assertEqual(takeover.status_code, 200, takeover.text)
        replacement_token = str(second.cookies.get("session_token") or "")
        self.assertNotEqual(replacement_token, raw_token)
        self.assertEqual(first.get("/api/me").status_code, 401)

        sessions = second.get("/api/account/sessions")
        self.assertEqual(sessions.status_code, 200, sessions.text)
        self.assertEqual(len(sessions.json()["sessions"]), 1)
        current = sessions.json()["sessions"][0]
        self.assertTrue(current["current"])
        self.assertEqual(current["device_id"], "device-b")
        self.assertEqual(current["id"], governance.token_digest(replacement_token)[:16])

        revoked = second.delete(
            f"/api/account/sessions/{current['id']}",
            headers=self.ORIGIN_HEADERS,
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT revoked_at, revoke_reason FROM sessions WHERE token = ?",
                (governance.token_digest(replacement_token),),
            ).fetchone()
        self.assertGreater(int(row["revoked_at"]), 0)
        self.assertEqual(str(row["revoke_reason"]), "user_revoked")
        self.assertEqual(second.get("/api/me").status_code, 401)

    def test_legacy_session_is_hashed_in_place_without_logging_out(self):
        admin, _ = self._admin_client()
        customer = self._create_customer(admin, "legacy-session-customer")
        raw_token = "legacy-raw-session-token"
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO sessions(token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (raw_token, int(customer["id"]), 4_000_000_000, 1),
            )
            governance.ensure_schema(conn)
            migrated = conn.execute("SELECT token FROM sessions WHERE user_id = ?", (int(customer["id"]),)).fetchone()
        self.assertEqual(str(migrated["token"]), governance.token_digest(raw_token))
        browser = TestClient(self.app, cookies={"session_token": raw_token})
        self.assertEqual(browser.get("/api/me").status_code, 200)

    def test_admin_api_requires_admin_cookie_and_server_request_ids_cannot_be_reused(self):
        admin, _ = self._admin_client()
        admin_token = str(admin.cookies.get("admin_session_token") or "")
        self.assertTrue(admin_token)
        self.assertFalse(admin.cookies.get("session_token"))
        wrong_cookie = TestClient(self.app, cookies={"session_token": admin_token})
        self.assertEqual(wrong_cookie.get("/api/admin/users").status_code, 401)

        pricing = admin.get("/api/admin/pricing").json()
        headers = {**self.ORIGIN_HEADERS, "X-Request-ID": "client-reused-request-id"}
        first = admin.put("/api/admin/pricing", json=pricing, headers=headers)
        second = admin.put("/api/admin/pricing", json=pricing, headers=headers)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertNotEqual(first.headers["x-request-id"], second.headers["x-request-id"])
        with db_module.db() as conn:
            audits = conn.execute(
                "SELECT request_id FROM audit_events WHERE action = 'admin_api.put' AND resource_id = '/api/admin/pricing'"
            ).fetchall()
        self.assertEqual(len(audits), 2)
        self.assertEqual(len({str(row["request_id"]) for row in audits}), 2)

    def test_password_vault_keyring_reads_old_ciphertext_and_detects_same_version_drift(self):
        key_v1 = os.environ["PASSWORD_VAULT_KEY"]
        os.environ["PASSWORD_VAULT_KEY_VERSION"] = "v1"
        encrypted_v1 = password_vault.encrypt_password(77, "secret-v1")
        self.assertTrue(encrypted_v1.startswith("pv1:v1:"))

        key_v2 = Fernet.generate_key().decode("ascii")
        os.environ["PASSWORD_VAULT_KEY_VERSION"] = "v2"
        os.environ["PASSWORD_VAULT_KEY"] = key_v2
        os.environ["PASSWORD_VAULT_KEYS_JSON"] = json.dumps({"v1": key_v1})
        self.assertEqual(password_vault.decrypt_password(77, encrypted_v1), "secret-v1")
        encrypted_v2 = password_vault.encrypt_password(77, "secret-v2")
        self.assertTrue(encrypted_v2.startswith("pv1:v2:"))

        healthy = password_vault.health_check(probe_key_version="v2")
        self.assertTrue(healthy["healthy"])
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        drifted = password_vault.health_check(
            persistent_probe=str(healthy["persistent_probe"]),
            probe_key_version="v2",
        )
        self.assertFalse(drifted["healthy"])

    def test_audit_csv_escapes_spreadsheet_formula_prefixes(self):
        text = governance.audit_rows_to_csv(
            [
                {
                    "id": "audit-1",
                    "created_at": 1,
                    "actor_user_id": 1,
                    "target_user_id": 2,
                    "action": "user.export",
                    "resource_type": "user",
                    "resource_id": "@target",
                    "reason": "=HYPERLINK(\"https://example.invalid\")",
                    "outcome": "success",
                    "error_code": "",
                    "risk_level": "medium",
                    "request_id": "+request",
                    "ip_address": "127.0.0.1",
                }
            ]
        )
        row = next(csv.DictReader(io.StringIO(text)))
        self.assertTrue(row["reason"].startswith("'="))
        self.assertTrue(row["resource_id"].startswith("'@"))
        self.assertTrue(row["request_id"].startswith("'+"))

    def test_admin_creation_requires_step_up_and_records_semantic_audit(self):
        admin, _ = self._admin_client()
        secret, _ = self._enable_admin_mfa(admin)
        payload = {
            "username": "second-admin",
            "password": "SecondAdminPass123",
            "is_admin": True,
            "admin_password": self.ADMIN_PASSWORD,
            "totp_code": governance.totp_code(secret),
            "reason": "create backup administrator",
        }
        missing_origin = admin.post("/api/admin/users", json=payload)
        self.assertEqual(missing_origin.status_code, 403, missing_origin.text)

        created = admin.post("/api/admin/users", headers=self.ORIGIN_HEADERS, json=payload)
        self.assertEqual(created.status_code, 200, created.text)
        created_id = int(created.json()["user"]["id"])
        with db_module.db() as conn:
            audit = conn.execute(
                "SELECT action, risk_level, before_json, after_json FROM audit_events "
                "WHERE action = 'user.admin_create' AND target_user_id = ?",
                (created_id,),
            ).fetchone()
        self.assertIsNotNone(audit)
        self.assertEqual(str(audit["risk_level"]), "high")
        self.assertNotIn("SecondAdminPass123", str(audit["after_json"]))

    def test_admin_mfa_setup_verify_and_login_challenge(self):
        admin, identity = self._admin_client()
        status = admin.get("/api/auth/mfa")
        self.assertEqual(status.status_code, 200, status.text)
        self.assertFalse(status.json()["enabled"])
        self.assertTrue(status.json()["required"])

        setup = admin.post("/api/auth/mfa/setup", headers=self.ORIGIN_HEADERS, json={"current_password": self.ADMIN_PASSWORD})
        self.assertEqual(setup.status_code, 200, setup.text)
        setup_body = setup.json()
        secret = str(setup_body["secret"])
        recovery_codes = [str(code) for code in setup_body["recovery_codes"]]
        self.assertEqual(len(recovery_codes), 10)
        self.assertTrue(str(setup_body["otpauth_uri"]).startswith("otpauth://totp/"))
        with db_module.db() as conn:
            pending = conn.execute(
                "SELECT pending_secret_ciphertext, recovery_codes_json FROM user_mfa WHERE user_id = ?",
                (int(identity["id"]),),
            ).fetchone()
        self.assertNotEqual(str(pending["pending_secret_ciphertext"]), secret)
        self.assertNotIn(secret, str(pending["pending_secret_ciphertext"]))
        stored_recovery = json.loads(str(pending["recovery_codes_json"]))
        self.assertEqual(
            stored_recovery,
            [governance.recovery_code_digest(code) for code in recovery_codes],
        )
        self.assertTrue(all(code not in str(pending["recovery_codes_json"]) for code in recovery_codes))

        wrong = admin.post(
            "/api/auth/mfa/verify-setup",
            headers=self.ORIGIN_HEADERS,
            json={"code": "000000"},
        )
        self.assertEqual(wrong.status_code, 400, wrong.text)
        verified = admin.post(
            "/api/auth/mfa/verify-setup",
            headers=self.ORIGIN_HEADERS,
            json={"code": governance.totp_code(secret)},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        enabled = admin.get("/api/auth/mfa")
        self.assertTrue(enabled.json()["enabled"])
        self.assertFalse(enabled.json()["setup_pending"])

        no_code = TestClient(self.app).post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": self.ADMIN_PASSWORD},
        )
        self.assertEqual(no_code.status_code, 401, no_code.text)
        self.assertEqual(no_code.json()["detail"]["code"], "mfa_code_invalid")
        challenged = TestClient(self.app).post(
            "/api/auth/admin-login",
            json={
                "username": "admin",
                "password": self.ADMIN_PASSWORD,
                "mfa_code": governance.totp_code(secret),
            },
        )
        self.assertEqual(challenged.status_code, 200, challenged.text)

    def test_admin_mfa_rejects_replay_and_locks_repeated_failures(self):
        admin, identity = self._admin_client()
        secret, _ = self._enable_admin_mfa(admin)
        code = governance.totp_code(secret)

        first = TestClient(self.app).post(
            "/api/auth/admin-login",
            json={
                "username": "admin",
                "password": self.ADMIN_PASSWORD,
                "mfa_code": code,
            },
        )
        self.assertEqual(first.status_code, 200, first.text)

        replay = TestClient(self.app).post(
            "/api/auth/admin-login",
            json={
                "username": "admin",
                "password": self.ADMIN_PASSWORD,
                "mfa_code": code,
            },
        )
        self.assertEqual(replay.status_code, 401, replay.text)
        self.assertEqual(replay.json()["detail"]["code"], "mfa_code_invalid")

        for _ in range(4):
            failed = TestClient(self.app).post(
                "/api/auth/admin-login",
                json={
                    "username": "admin",
                    "password": self.ADMIN_PASSWORD,
                    "mfa_code": "000000",
                },
            )
            self.assertEqual(failed.status_code, 401, failed.text)

        locked = TestClient(self.app).post(
            "/api/auth/admin-login",
            json={
                "username": "admin",
                "password": self.ADMIN_PASSWORD,
                "mfa_code": "000000",
            },
        )
        self.assertEqual(locked.status_code, 429, locked.text)
        self.assertEqual(locked.json()["detail"]["code"], "mfa_rate_limited")

        with db_module.db() as conn:
            mfa = conn.execute(
                "SELECT failed_attempt_count, locked_until FROM user_mfa WHERE user_id = ?",
                (int(identity["id"]),),
            ).fetchone()
            alert = conn.execute(
                "SELECT severity FROM security_alerts WHERE alert_type = 'mfa_failures' AND target_user_id = ?",
                (int(identity["id"]),),
            ).fetchone()
        self.assertGreaterEqual(int(mfa["failed_attempt_count"]), 5)
        self.assertGreater(int(mfa["locked_until"]), governance.now_ts())
        self.assertEqual(str(alert["severity"]), "high")

    def test_dashboard_groups_tags_batches_audit_redaction_and_alerts(self):
        admin, identity = self._admin_client()
        customer = self._create_customer(admin, "governed-customer")
        customer_id = int(customer["id"])
        customer_client = TestClient(self.app)
        customer_login = customer_client.post(
            "/api/auth/user-login",
            json={"username": "governed-customer", "password": "CustomerPass123"},
        )
        self.assertEqual(customer_login.status_code, 200, customer_login.text)

        group = admin.post(
            "/api/admin/customer-groups",
            headers=self.ORIGIN_HEADERS,
            json={"name": "Priority", "description": "Priority customers", "color": "red"},
        )
        tag = admin.post(
            "/api/admin/tags",
            headers=self.ORIGIN_HEADERS,
            json={"name": "Renewal", "color": "blue"},
        )
        self.assertEqual(group.status_code, 200, group.text)
        self.assertEqual(tag.status_code, 200, tag.text)
        group_id = str(group.json()["id"])
        tag_id = str(tag.json()["id"])

        invalid_tags = admin.post(
            "/api/admin/users/batch-actions",
            headers=self.ORIGIN_HEADERS,
            json={
                "action": "add_tags",
                "user_ids": [customer_id],
                "tag_ids": [tag_id, "missing-tag"],
                "reason": "Reject the whole batch when any tag is invalid",
            },
        )
        self.assertEqual(invalid_tags.status_code, 400, invalid_tags.text)
        with db_module.db() as conn:
            assignment_count = int(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM customer_tag_assignments WHERE user_id = ?",
                    (customer_id,),
                ).fetchone()["count"]
            )
        self.assertEqual(assignment_count, 0)

        preview = admin.post(
            "/api/admin/users/batch-actions",
            headers=self.ORIGIN_HEADERS,
            json={
                "action": "assign_group",
                "user_ids": [customer_id],
                "group_id": group_id,
                "reason": "Preview group assignment",
                "preview": True,
            },
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertTrue(preview.json()["preview"])
        self.assertEqual(preview.json()["matched"], 1)

        for payload in (
            {
                "action": "assign_group",
                "user_ids": [customer_id],
                "group_id": group_id,
                "reason": "Assign priority group",
            },
            {
                "action": "add_tags",
                "user_ids": [customer_id],
                "tag_ids": [tag_id],
                "reason": "Mark renewal customer",
            },
        ):
            result = admin.post(
                "/api/admin/users/batch-actions",
                headers=self.ORIGIN_HEADERS,
                json=payload,
            )
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["success"], 1)
            self.assertEqual(result.json()["failed"], 0)

        groups = admin.get("/api/admin/customer-groups")
        tags = admin.get("/api/admin/tags")
        group_row = next(item for item in groups.json()["items"] if item["id"] == group_id)
        tag_row = next(item for item in tags.json()["items"] if item["id"] == tag_id)
        self.assertEqual(int(group_row["member_count"]), 1)
        self.assertEqual(int(tag_row["member_count"]), 1)

        suspended = admin.post(
            "/api/admin/users/batch-actions",
            headers=self.ORIGIN_HEADERS,
            json={
                "action": "suspend",
                "user_ids": [customer_id],
                "reason": "Governance lifecycle test",
            },
        )
        self.assertEqual(suspended.status_code, 200, suspended.text)
        self.assertEqual(suspended.json()["success"], 1)
        self.assertEqual(customer_client.get("/api/me").status_code, 401)

        marker_values = {
            "plain_password": "password-should-not-leak",
            "nested_api_key": "api-key-should-not-leak",
            "list_token": "token-should-not-leak",
            "secret_note": "secret-note-should-not-leak",
        }
        with db_module.db() as conn:
            lifecycle = conn.execute(
                "SELECT lifecycle_status, lifecycle_reason, approval_status, is_disabled FROM users WHERE id = ?",
                (customer_id,),
            ).fetchone()
            audit_id = governance.record_audit(
                conn,
                actor_user_id=int(identity["id"]),
                target_user_id=customer_id,
                action="governance.redaction_probe",
                resource_type="user",
                resource_id=str(customer_id),
                before={
                    "password": marker_values["plain_password"],
                    "profile": {"api_key": marker_values["nested_api_key"], "display_name": "Visible Name"},
                    "items": [{"token": marker_values["list_token"], "safe": "visible-list-value"}],
                },
                after={"secret_note": marker_values["secret_note"], "status": "reviewed"},
                risk_level="high",
            )
            alert_id = governance.upsert_alert(
                conn,
                alert_type="governance_probe",
                severity="high",
                title="Governance probe alert",
                summary="first occurrence",
                target_user_id=customer_id,
                related_audit_id=audit_id,
                fingerprint="governance-probe-alert",
            )
            duplicate_id = governance.upsert_alert(
                conn,
                alert_type="governance_probe",
                severity="high",
                title="Governance probe alert",
                summary="second occurrence",
                target_user_id=customer_id,
                related_audit_id=audit_id,
                fingerprint="governance-probe-alert",
            )
        self.assertEqual(str(lifecycle["lifecycle_status"]), "suspended")
        self.assertEqual(str(lifecycle["approval_status"]), "approved")
        self.assertEqual(int(lifecycle["is_disabled"]), 1)
        self.assertEqual(duplicate_id, alert_id)

        audit = admin.get("/api/admin/audit/events?action=governance.redaction_probe")
        self.assertEqual(audit.status_code, 200, audit.text)
        self.assertEqual(audit.json()["total"], 1)
        audit_row = audit.json()["items"][0]
        self.assertEqual(audit_row["id"], audit_id)
        serialized_audit = f"{audit_row['before_json']} {audit_row['after_json']}"
        self.assertNotIn(marker_values["plain_password"], serialized_audit)
        self.assertNotIn(marker_values["nested_api_key"], serialized_audit)
        self.assertNotIn(marker_values["list_token"], serialized_audit)
        self.assertNotIn(marker_values["secret_note"], serialized_audit)
        before = json.loads(audit_row["before_json"])
        after = json.loads(audit_row["after_json"])
        self.assertEqual(before["password"], "[REDACTED]")
        self.assertEqual(before["profile"]["api_key"], "[REDACTED]")
        self.assertEqual(before["profile"]["display_name"], "Visible Name")
        self.assertEqual(before["items"][0]["safe"], "visible-list-value")
        self.assertEqual(after["secret_note"], "[REDACTED]")

        alerts = admin.get("/api/admin/security/alerts?status=open&severity=high")
        self.assertEqual(alerts.status_code, 200, alerts.text)
        alert_row = next(item for item in alerts.json()["items"] if item["id"] == alert_id)
        self.assertEqual(int(alert_row["occurrence_count"]), 2)
        self.assertEqual(alert_row["summary"], "second occurrence")

        dashboard = admin.get("/api/admin/dashboard?days=7")
        self.assertEqual(dashboard.status_code, 200, dashboard.text)
        self.assertEqual(dashboard.json()["range_days"], 7)
        self.assertGreaterEqual(int(dashboard.json()["summary"]["customers"]), 1)
        self.assertGreaterEqual(int(dashboard.json()["summary"]["disabled"]), 1)
        self.assertGreaterEqual(int(dashboard.json()["summary"]["open_alerts"]), 1)
        self.assertTrue(
            any(item["id"] == alert_id for item in dashboard.json()["queues"]["security_alerts"])
        )

        resolved = admin.patch(
            f"/api/admin/security/alerts/{alert_id}",
            headers=self.ORIGIN_HEADERS,
            json={
                "status": "resolved",
                "assigned_admin_id": int(identity["id"]),
                "note": "Reviewed and resolved",
            },
        )
        self.assertEqual(resolved.status_code, 200, resolved.text)
        with db_module.db() as conn:
            resolved_row = conn.execute(
                "SELECT status, assigned_admin_id, resolved_at FROM security_alerts WHERE id = ?",
                (alert_id,),
            ).fetchone()
            timeline = conn.execute(
                "SELECT event_type, note FROM security_alert_timeline WHERE alert_id = ?",
                (alert_id,),
            ).fetchone()
        self.assertEqual(str(resolved_row["status"]), "resolved")
        self.assertEqual(int(resolved_row["assigned_admin_id"]), int(identity["id"]))
        self.assertGreater(int(resolved_row["resolved_at"]), 0)
        self.assertEqual(str(timeline["event_type"]), "resolved")
        self.assertEqual(str(timeline["note"]), "Reviewed and resolved")

        updated_without_assignee = admin.patch(
            f"/api/admin/security/alerts/{alert_id}",
            headers=self.ORIGIN_HEADERS,
            json={"status": "resolved", "note": "Keep the existing assignee"},
        )
        self.assertEqual(updated_without_assignee.status_code, 200, updated_without_assignee.text)
        with db_module.db() as conn:
            preserved = conn.execute(
                "SELECT assigned_admin_id FROM security_alerts WHERE id = ?",
                (alert_id,),
            ).fetchone()
        self.assertEqual(int(preserved["assigned_admin_id"]), int(identity["id"]))

    def test_batch_enable_does_not_bypass_pending_approval(self):
        admin, _ = self._admin_client()
        customer = self._create_customer(admin, "pending-batch-customer")
        customer_id = int(customer["id"])
        with db_module.db() as conn:
            conn.execute(
                "UPDATE users SET approval_status = 'pending', lifecycle_status = 'pending', is_disabled = 1 WHERE id = ?",
                (customer_id,),
            )

        result = admin.post(
            "/api/admin/users/batch-actions",
            headers=self.ORIGIN_HEADERS,
            json={
                "action": "enable",
                "user_ids": [customer_id],
                "reason": "This must not bypass the approval workflow",
            },
        )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["success"], 0)
        self.assertEqual(result.json()["skipped"], 1)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT approval_status, lifecycle_status, is_disabled FROM users WHERE id = ?",
                (customer_id,),
            ).fetchone()
        self.assertEqual(str(row["approval_status"]), "pending")
        self.assertEqual(str(row["lifecycle_status"]), "pending")
        self.assertEqual(int(row["is_disabled"]), 1)

    def test_service_account_credential_is_returned_once_and_only_digest_is_stored(self):
        admin, _ = self._admin_client()
        secret, recovery_codes = self._enable_admin_mfa(admin)
        denied = admin.post(
            "/api/admin/service-accounts",
            headers=self.ORIGIN_HEADERS,
            json={
                "name": "reporting-worker",
                "purpose": "Read governance reports",
                "allowed_scopes": ["audit:read", "users:read"],
                "expires_at": governance.now_ts() + 86400,
            },
        )
        self.assertEqual(denied.status_code, 422, denied.text)
        created = admin.post(
            "/api/admin/service-accounts",
            headers=self.ORIGIN_HEADERS,
            json={
                "name": "reporting-worker",
                "purpose": "Read governance reports",
                "allowed_scopes": ["audit:read", "audit:read", "internal:tg", "users:read"],
                "expires_at": governance.now_ts() + 86400,
                "admin_password": self.ADMIN_PASSWORD,
                "totp_code": governance.totp_code(secret),
                "reason": "create reporting worker token=must-not-appear",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertIn("no-store", created.headers.get("cache-control", ""))
        service_id = str(created.json()["id"])
        credential = str(created.json()["credential"])
        self.assertGreater(len(credential), 40)

        listed = admin.get("/api/admin/service-accounts")
        self.assertEqual(listed.status_code, 200, listed.text)
        item = next(row for row in listed.json()["items"] if row["id"] == service_id)
        self.assertNotIn("credential", item)
        self.assertNotIn("credential_hash", item)
        self.assertEqual(item["allowed_scopes"], ["audit:read", "internal:tg", "users:read"])

        internal_status = TestClient(self.app).get(
            "/api/internal/tg/status?chat_id=1",
            headers={"x-tg-internal-token": credential},
        )
        self.assertEqual(internal_status.status_code, 200, internal_status.text)

        with db_module.db() as conn:
            stored = conn.execute(
                "SELECT credential_hash FROM service_accounts WHERE id = ?",
                (service_id,),
            ).fetchone()
            audit = conn.execute(
                "SELECT reason FROM audit_events WHERE action = 'service_account.create' AND resource_id = ?",
                (service_id,),
            ).fetchone()
        self.assertEqual(str(stored["credential_hash"]), governance.token_digest(credential))
        self.assertNotEqual(str(stored["credential_hash"]), credential)
        self.assertNotIn("must-not-appear", str(audit["reason"]))
        self.assertIn("[REDACTED]", str(audit["reason"]))

        updated = admin.patch(
            f"/api/admin/service-accounts/{service_id}",
            headers=self.ORIGIN_HEADERS,
            json={
                "status": "revoked",
                "purpose": "Retired reporting worker",
                "allowed_scopes": [],
                "expires_at": 0,
                "admin_password": self.ADMIN_PASSWORD,
                "totp_code": recovery_codes[0],
                "reason": "retire reporting worker",
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertNotIn(credential, updated.text)
        relisted = admin.get("/api/admin/service-accounts")
        relisted_item = next(row for row in relisted.json()["items"] if row["id"] == service_id)
        self.assertEqual(relisted_item["status"], "revoked")
        self.assertNotIn(credential, relisted.text)

    def test_password_history_restore_requires_password_and_mfa_step_up(self):
        admin, _ = self._admin_client()
        secret, _ = self._enable_admin_mfa(admin)
        original_password = "OriginalPass123"
        changed_password = "ChangedPass456"
        customer = self._create_customer(
            admin,
            "restore-customer",
            password=original_password,
        )
        customer_id = int(customer["id"])

        customer_client = TestClient(self.app)
        login = customer_client.post(
            "/api/auth/user-login",
            json={"username": "restore-customer", "password": original_password},
        )
        self.assertEqual(login.status_code, 200, login.text)
        changed = customer_client.post(
            "/api/auth/change_password",
            json={"old_password": original_password, "new_password": changed_password},
        )
        self.assertEqual(changed.status_code, 200, changed.text)

        history = admin.get(f"/api/admin/users/{customer_id}/password-history")
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(len(history.json()["items"]), 1)
        history_id = str(history.json()["items"][0]["id"])
        detail = admin.get(f"/api/admin/users/{customer_id}")
        self.assertEqual(detail.status_code, 200, detail.text)
        expected_updated_at = int(detail.json()["user"]["updated_at"])
        base_payload = {
            "history_id": history_id,
            "expected_updated_at": expected_updated_at,
            "reason": "Restore the prior customer credential after verification",
        }

        wrong_password = admin.post(
            f"/api/admin/users/{customer_id}/restore-password",
            headers=self.ORIGIN_HEADERS,
            json={**base_payload, "admin_password": "wrong-password", "totp_code": governance.totp_code(secret)},
        )
        self.assertEqual(wrong_password.status_code, 403, wrong_password.text)
        self.assertEqual(wrong_password.json()["detail"]["code"], "admin_reauthentication_failed")

        wrong_totp = admin.post(
            f"/api/admin/users/{customer_id}/restore-password",
            headers=self.ORIGIN_HEADERS,
            json={**base_payload, "admin_password": self.ADMIN_PASSWORD, "totp_code": "000000"},
        )
        self.assertEqual(wrong_totp.status_code, 403, wrong_totp.text)
        self.assertEqual(wrong_totp.json()["detail"]["code"], "mfa_code_invalid")

        restored = admin.post(
            f"/api/admin/users/{customer_id}/restore-password",
            headers=self.ORIGIN_HEADERS,
            json={
                **base_payload,
                "admin_password": self.ADMIN_PASSWORD,
                "totp_code": governance.totp_code(secret),
            },
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertGreater(int(restored.json()["updated_at"]), expected_updated_at)
        self.assertEqual(customer_client.get("/api/me").status_code, 401)

        changed_login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "restore-customer", "password": changed_password},
        )
        self.assertEqual(changed_login.status_code, 401, changed_login.text)
        original_login = TestClient(self.app).post(
            "/api/auth/user-login",
            json={"username": "restore-customer", "password": original_password},
        )
        self.assertEqual(original_login.status_code, 200, original_login.text)

        history_after = admin.get(f"/api/admin/users/{customer_id}/password-history")
        restored_history = next(
            row for row in history_after.json()["items"] if row["id"] == history_id
        )
        self.assertGreater(int(restored_history["restored_at"]), 0)
        restore_audit = admin.get(
            f"/api/admin/audit/events?action=user.password_restore&target_user_id={customer_id}"
        )
        self.assertEqual(restore_audit.status_code, 200, restore_audit.text)
        self.assertEqual(restore_audit.json()["total"], 1)
        restore_alerts = admin.get("/api/admin/security/alerts?severity=high")
        self.assertTrue(
            any(
                row["alert_type"] == "admin_password_restore"
                and int(row["target_user_id"]) == customer_id
                for row in restore_alerts.json()["items"]
            )
        )


if __name__ == "__main__":
    unittest.main()
