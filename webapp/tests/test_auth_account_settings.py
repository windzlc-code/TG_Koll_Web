import json
import os
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module
import webapp.server as server


class AccountSettingsApiTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._old_runtime_config_path = os.environ.get("APP_RUNTIME_CONFIG_PATH")
        self._old_webapp_data_dir = os.environ.get("WEBAPP_DATA_DIR")
        self._old_bootstrap_password = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD")
        self._old_cookie_secure = os.environ.get("SESSION_COOKIE_SECURE")
        self._old_vault_key = os.environ.get("PASSWORD_VAULT_KEY")
        self._old_vault_key_file = os.environ.get("PASSWORD_VAULT_KEY_FILE")
        self._old_server_runtime_config_path = server.RUNTIME_CONFIG_PATH
        self._tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmpdir.name)
        self.db_path = self.data_dir / "app.db"
        self.runtime_config_path = self.data_dir / "runtime_config.json"
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.db_path)
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.runtime_config_path)
        os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "admin123secure"
        os.environ["SESSION_COOKIE_SECURE"] = "0"
        os.environ["PASSWORD_VAULT_KEY"] = Fernet.generate_key().decode("ascii")
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        server.RUNTIME_CONFIG_PATH = self.runtime_config_path
        self.app = server.create_app()
        self.client = TestClient(self.app)

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self._old_server_runtime_config_path
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        if self._old_runtime_config_path is None:
            os.environ.pop("APP_RUNTIME_CONFIG_PATH", None)
        else:
            os.environ["APP_RUNTIME_CONFIG_PATH"] = self._old_runtime_config_path
        if self._old_webapp_data_dir is None:
            os.environ.pop("WEBAPP_DATA_DIR", None)
        else:
            os.environ["WEBAPP_DATA_DIR"] = self._old_webapp_data_dir
        if self._old_bootstrap_password is None:
            os.environ.pop("ADMIN_BOOTSTRAP_PASSWORD", None)
        else:
            os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = self._old_bootstrap_password
        if self._old_cookie_secure is None:
            os.environ.pop("SESSION_COOKIE_SECURE", None)
        else:
            os.environ["SESSION_COOKIE_SECURE"] = self._old_cookie_secure
        if self._old_vault_key is None:
            os.environ.pop("PASSWORD_VAULT_KEY", None)
        else:
            os.environ["PASSWORD_VAULT_KEY"] = self._old_vault_key
        if self._old_vault_key_file is None:
            os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        else:
            os.environ["PASSWORD_VAULT_KEY_FILE"] = self._old_vault_key_file
        self._tmpdir.cleanup()

    def test_admin_can_change_username_with_current_password(self):
        login_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        change_resp = self.client.post(
            "/api/auth/change_username",
            json={"password": "admin123secure", "new_username": "admin2"},
        )
        self.assertEqual(change_resp.status_code, 200)
        self.assertEqual(change_resp.json(), {"ok": True})

        me_resp = self.client.get("/api/me")
        self.assertEqual(me_resp.status_code, 200)
        self.assertEqual(me_resp.json()["username"], "admin2")

        relogin_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin2", "password": "admin123secure"},
        )
        self.assertEqual(relogin_resp.status_code, 200)

        old_name_application = TestClient(self.app).post(
            "/api/auth/apply",
            json={
                "username": "admin",
                "password": "Applicant123",
                "full_name": "Reserved Alias",
                "email": "reserved@example.test",
                "phone": "0912345678",
                "company": "Isolation QA",
                "use_case": "Verify historical usernames cannot cross tenant boundaries",
            },
        )
        self.assertEqual(old_name_application.status_code, 409, old_name_application.text)

    def test_admin_can_change_password_with_current_password(self):
        login_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        change_resp = self.client.post(
            "/api/auth/change_password",
            json={"old_password": "admin123secure", "new_password": "admin456secure"},
        )
        self.assertEqual(change_resp.status_code, 200)
        self.assertEqual(change_resp.json(), {"ok": True})

        old_login_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(old_login_resp.status_code, 401)

        new_login_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin456secure"},
        )
        self.assertEqual(new_login_resp.status_code, 200)

    def test_admin_password_change_requires_twelve_characters(self):
        self.assertEqual(
            self.client.post(
                "/api/auth/login",
                json={"username": "admin", "password": "admin123secure"},
            ).status_code,
            200,
        )
        response = self.client.post(
            "/api/auth/change_password",
            json={"old_password": "admin123secure", "new_password": "short888"},
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_change_password_rejects_wrong_current_password(self):
        login_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        change_resp = self.client.post(
            "/api/auth/change_password",
            json={"old_password": "wrong-pass", "new_password": "admin456"},
        )
        self.assertEqual(change_resp.status_code, 400)
        self.assertEqual(change_resp.json()["detail"], "原密码错误")

    def test_admin_task_list_includes_has_download_for_downloadable_outputs(self):
        output_file = self.data_dir / "demo.mp4"
        output_file.write_bytes(b"demo-video")
        now_ts = server._now_ts()
        with db_module.db() as conn:
            conn.execute(
                """
                INSERT INTO tasks(
                    id, user_id, type, status, input_json, output_json, error,
                    runninghub_task_id, usage_json, cost_cents, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "task_downloadable",
                    1,
                    "image_generate",
                    "success",
                    "{}",
                    json.dumps({"download_path": str(output_file)}, ensure_ascii=False),
                    "",
                    "",
                    "{}",
                    0,
                    now_ts,
                    now_ts,
                ),
            )

        login_resp = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login_resp.status_code, 200)

        list_resp = self.client.get("/api/admin/tasks?limit=20")
        self.assertEqual(list_resp.status_code, 200)
        items = list_resp.json()["items"]
        task = next(item for item in items if item["id"] == "task_downloadable")
        self.assertEqual(task["has_download"], True)


if __name__ == "__main__":
    unittest.main()
