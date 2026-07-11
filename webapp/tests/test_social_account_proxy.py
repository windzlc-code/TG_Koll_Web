import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from webapp.db import init_db
import webapp.social_automation_api as social_api


class SocialAccountResidentialProxyTests(unittest.TestCase):
    def setUp(self):
        self._old_db_path = os.environ.get("APP_DB_PATH")
        self._tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self._tmpdir.name)
        self.db_path = self.root / "app.db"
        os.environ["APP_DB_PATH"] = str(self.db_path)
        init_db()

    def tearDown(self):
        if self._old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self._old_db_path
        self._tmpdir.cleanup()

    def _proxy(self, **overrides):
        values = {
            "protocol": "socks5",
            "host": "residential.example",
            "port": 1080,
            "username": "region-user",
            "password": "proxy-secret",
            "country": "US",
            "isp": "Residential ISP",
            "status": "active",
        }
        values.update(overrides)
        return values

    def _account(self, username: str, *, persona_id: str = "", proxy=None):
        return social_api.create_social_account(
            social_api.SocialAccountPayload(
                persona_id=persona_id,
                platform="threads",
                username=username,
                profile_dir=str(self.root / "profiles" / username),
                residential_proxy=proxy,
            )
        )

    def _task(self, account_id: str):
        return social_api.create_social_task(
            social_api.SocialTaskPayload(
                account_id=account_id,
                platform="threads",
                task_type="check_login",
            )
        )

    def test_create_and_patch_proxy_are_atomic_and_password_is_write_only(self):
        account = self._account(
            "creator",
            persona_id="persona-1",
            proxy=social_api.ResidentialProxyPayload(
                **self._proxy(), source="account-vendor", note="preserve me"
            ),
        )
        proxy_id = account["proxy_id"]

        self.assertEqual(account["residential_proxy"]["protocol"], "socks5")
        self.assertEqual(account["residential_proxy"]["country"], "US")
        self.assertEqual(account["residential_proxy"]["isp"], "Residential ISP")
        self.assertEqual(account["residential_proxy"]["source"], "account-vendor")
        self.assertEqual(account["residential_proxy"]["ip_type"], "static_residential")
        self.assertEqual(account["residential_proxy"]["purchase_status"], "owned")
        self.assertEqual(account["residential_proxy"]["expires_at"], 0)
        self.assertTrue(account["residential_proxy"]["password_configured"])
        self.assertNotIn("proxy-secret", json.dumps(account, ensure_ascii=False))
        self.assertNotIn("password", account["residential_proxy"])

        updated = social_api.update_social_account(
            account["id"],
            social_api.SocialAccountPatchPayload(
                residential_proxy=social_api.ResidentialProxyPayload(
                    **self._proxy(host="new-residential.example", port=8443, password="")
                )
            ),
        )
        self.assertEqual(updated["proxy_id"], proxy_id)
        self.assertEqual(updated["residential_proxy"]["host"], "new-residential.example")
        self.assertEqual(updated["residential_proxy"]["source"], "account-vendor")
        self.assertEqual(updated["residential_proxy"]["note"], "preserve me")
        self.assertNotIn("proxy-secret", json.dumps(updated, ensure_ascii=False))

        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT host, port, password FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()
            counts = (
                conn.execute("SELECT COUNT(*) FROM social_accounts").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM social_proxies").fetchone()[0],
            )
        self.assertEqual(row, ("new-residential.example", 8443, "proxy-secret"))
        self.assertEqual(counts, (1, 1))

    def test_persona_platform_conflicts_return_409_without_orphan_proxy(self):
        self._account(
            "first",
            persona_id="persona-1",
            proxy=social_api.ResidentialProxyPayload(**self._proxy()),
        )
        with sqlite3.connect(self.db_path) as conn:
            proxy_count = conn.execute("SELECT COUNT(*) FROM social_proxies").fetchone()[0]

        with self.assertRaises(HTTPException) as caught:
            self._account(
                "second",
                persona_id="persona-1",
                proxy=social_api.ResidentialProxyPayload(**self._proxy(host="other.example")),
            )
        self.assertEqual(caught.exception.status_code, 409)
        with sqlite3.connect(self.db_path) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM social_proxies").fetchone()[0], proxy_count)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM social_accounts").fetchone()[0], 1)

        unbound_one = self._account("unbound-one", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="one.example")))
        unbound_two = self._account("unbound-two", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="two.example")))
        social_api.update_social_account(unbound_one["id"], social_api.SocialAccountPatchPayload(persona_id="persona-2"))
        with self.assertRaises(HTTPException) as update_error:
            social_api.update_social_account(unbound_two["id"], social_api.SocialAccountPatchPayload(persona_id="persona-2"))
        self.assertEqual(update_error.exception.status_code, 409)

    def test_shared_proxy_is_cloned_before_account_specific_edit(self):
        shared = social_api.create_social_proxy(
            social_api.SocialProxyPayload(
                proxy_type="http",
                host="shared.example",
                port=8000,
                username="shared-user",
                password="shared-secret",
            )
        )
        first = social_api.create_social_account(
            social_api.SocialAccountPayload(
                platform="threads", username="first", profile_dir=str(self.root / "profiles" / "first"), proxy_id=shared["id"]
            )
        )
        second = social_api.create_social_account(
            social_api.SocialAccountPayload(
                platform="threads", username="second", profile_dir=str(self.root / "profiles" / "second"), proxy_id=shared["id"]
            )
        )

        updated = social_api.update_social_account(
            first["id"],
            social_api.SocialAccountPatchPayload(
                residential_proxy=social_api.ResidentialProxyPayload(
                    protocol="https", host="dedicated.example", port=9443, username="dedicated", password="",
                    country="US", isp="Residential ISP"
                )
            ),
        )
        self.assertNotEqual(updated["proxy_id"], shared["id"])
        with sqlite3.connect(self.db_path) as conn:
            original = conn.execute("SELECT host, password FROM social_proxies WHERE id = ?", (shared["id"],)).fetchone()
            cloned = conn.execute("SELECT host, password FROM social_proxies WHERE id = ?", (updated["proxy_id"],)).fetchone()
            second_proxy_id = conn.execute("SELECT proxy_id FROM social_accounts WHERE id = ?", (second["id"],)).fetchone()[0]
        self.assertEqual(original, ("shared.example", "shared-secret"))
        self.assertEqual(cloned, ("dedicated.example", "shared-secret"))
        self.assertEqual(second_proxy_id, shared["id"])

    def test_task_creation_allows_no_proxy_but_rejects_missing_or_failed_proxy(self):
        no_proxy = self._account("no-proxy")
        self.assertEqual(self._task(no_proxy["id"])["account_id"], no_proxy["id"])

        active = self._account("active", proxy=social_api.ResidentialProxyPayload(**self._proxy()))
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_accounts SET proxy_id = 'missing-proxy' WHERE id = ?", (active["id"],))
        with self.assertRaises(HTTPException) as missing_row:
            self._task(active["id"])
        self.assertEqual(missing_row.exception.status_code, 409)

        failed = self._account("failed", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="failed.example")))
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_proxies SET status = 'failed' WHERE id = ?", (failed["proxy_id"],))
        with self.assertRaises(HTTPException) as failed_status:
            self._task(failed["id"])
        self.assertEqual(failed_status.exception.status_code, 409)

        inactive = self._account("inactive", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="inactive.example")))
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_proxies SET status = 'inactive' WHERE id = ?", (inactive["proxy_id"],))
        with self.assertRaises(HTTPException) as inactive_status:
            self._task(inactive["id"])
        self.assertEqual(inactive_status.exception.status_code, 409)

        ready = self._account("ready", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="ready.example")))
        self.assertEqual(self._task(ready["id"])["account_id"], ready["id"])

    def test_worker_runs_without_proxy_but_blocks_dangling_or_failed_proxy(self):
        no_proxy = self._account("legacy-no-proxy")
        no_proxy_task = self._task(no_proxy["id"])
        with mock.patch.object(
            social_api,
            "_run_social_task_in_clean_thread",
            return_value={"ok": True, "status": "ready"},
        ) as run_task:
            social_api._execute_claimed_task(no_proxy_task)
        self.assertIsNone(run_task.call_args.kwargs["proxy"])

        dangling = self._account("legacy-dangling-proxy")
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_accounts SET proxy_id = 'missing-proxy' WHERE id = ?", (dangling["id"],))
        with self.assertRaisesRegex(RuntimeError, "不存在"):
            social_api._execute_claimed_task({"id": "legacy-task-1", "account_id": dangling["id"]})

        failed = self._account(
            "legacy-failed-proxy",
            proxy=social_api.ResidentialProxyPayload(**self._proxy(host="legacy-failed.example")),
        )
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_proxies SET status = 'failed' WHERE id = ?", (failed["proxy_id"],))
        with self.assertRaisesRegex(RuntimeError, "不可用"):
            social_api._execute_claimed_task({"id": "legacy-task-2", "account_id": failed["id"]})

    def test_clear_residential_proxy_and_conflicting_patch_inputs(self):
        account = self._account(
            "clear-proxy",
            proxy=social_api.ResidentialProxyPayload(**self._proxy()),
        )
        with self.assertRaises(HTTPException) as proxy_id_conflict:
            social_api.update_social_account(
                account["id"],
                social_api.SocialAccountPatchPayload(clear_residential_proxy=True, proxy_id=""),
            )
        self.assertEqual(proxy_id_conflict.exception.status_code, 400)

        with self.assertRaises(HTTPException) as inline_conflict:
            social_api.update_social_account(
                account["id"],
                social_api.SocialAccountPatchPayload(
                    clear_residential_proxy=True,
                    residential_proxy=social_api.ResidentialProxyPayload(**self._proxy()),
                ),
            )
        self.assertEqual(inline_conflict.exception.status_code, 400)

        updated = social_api.update_social_account(
            account["id"],
            social_api.SocialAccountPatchPayload(clear_residential_proxy=True),
        )
        self.assertEqual(updated["proxy_id"], "")
        self.assertIsNone(updated["residential_proxy"])

    def test_independent_proxy_update_delete_and_bulk_binding_fields(self):
        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(
                name="managed",
                proxy_type="socks5",
                host="managed.example",
                port=1080,
                username="saved-user",
                password="saved-secret",
                source="vendor-a",
                ip_type="static_residential",
                purchase_status="leased",
                note="first note",
                expires_at=123456,
            )
        )
        self.assertEqual(proxy["source"], "vendor-a")
        self.assertEqual(proxy["purchase_status"], "leased")
        self.assertNotIn("saved-secret", json.dumps(proxy, ensure_ascii=False))

        updated = social_api.update_social_proxy(
            proxy["id"],
            social_api.SocialProxyPatchPayload(
                host="updated.example",
                port=8443,
                username="",
                password="",
                source="vendor-b",
                purchase_status="owned",
                note="",
                expires_at=0,
            ),
        )
        self.assertEqual(updated["host"], "updated.example")
        self.assertEqual(updated["source"], "vendor-b")
        self.assertEqual(updated["note"], "")
        with self.assertRaises(HTTPException) as invalid_host:
            social_api.update_social_proxy(
                proxy["id"], social_api.SocialProxyPatchPayload(host="")
            )
        self.assertEqual(invalid_host.exception.status_code, 400)
        with sqlite3.connect(self.db_path) as conn:
            stored = conn.execute(
                "SELECT username, password FROM social_proxies WHERE id = ?",
                (proxy["id"],),
            ).fetchone()
        self.assertEqual(stored, ("saved-user", "saved-secret"))

        account = social_api.create_social_account(
            social_api.SocialAccountPayload(
                platform="threads",
                username="bound-managed",
                profile_dir=str(self.root / "profiles" / "bound-managed"),
                proxy_id=proxy["id"],
            )
        )
        with social_api.db() as conn:
            rows = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy["id"],)).fetchall()
            listed = social_api._proxy_public_rows(conn, rows)
        self.assertEqual(listed[0]["bound_account_count"], 1)
        self.assertEqual(listed[0]["bound_account_ids"], [account["id"]])

        with self.assertRaises(HTTPException) as bound_error:
            social_api.delete_social_proxy(proxy["id"])
        self.assertEqual(bound_error.exception.status_code, 409)
        social_api.update_social_account(
            account["id"],
            social_api.SocialAccountPatchPayload(clear_residential_proxy=True),
        )
        self.assertEqual(social_api.delete_social_proxy(proxy["id"]), 1)
        with self.assertRaises(HTTPException) as missing_error:
            social_api.delete_social_proxy(proxy["id"])
        self.assertEqual(missing_error.exception.status_code, 404)

    def test_proxy_schema_migrates_existing_table_with_metadata_defaults(self):
        legacy_path = self.root / "legacy.db"
        with sqlite3.connect(legacy_path) as conn:
            conn.execute(
                """
                CREATE TABLE social_proxies (
                  id TEXT PRIMARY KEY, name TEXT NOT NULL, proxy_type TEXT NOT NULL,
                  host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '',
                  password TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
                  isp TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
                  last_check_at INTEGER NOT NULL DEFAULT 0,
                  last_check_result TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                INSERT INTO social_proxies(
                  id, name, proxy_type, host, port, created_at, updated_at
                ) VALUES ('legacy', 'Legacy', 'http', 'legacy.example', 8080, 1, 1)
                """
            )
        os.environ["APP_DB_PATH"] = str(legacy_path)
        try:
            init_db()
            with sqlite3.connect(legacy_path) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(social_proxies)").fetchall()}
                metadata = conn.execute(
                    "SELECT source, ip_type, purchase_status, region, city, note, expires_at FROM social_proxies WHERE id = 'legacy'"
                ).fetchone()
        finally:
            os.environ["APP_DB_PATH"] = str(self.db_path)
        self.assertTrue({"source", "ip_type", "purchase_status", "region", "city", "note", "expires_at"}.issubset(columns))
        self.assertEqual(metadata, ("manual", "static_residential", "owned", "", "", "", 0))

    def test_only_static_residential_proxy_type_is_accepted(self):
        with self.assertRaises(HTTPException) as create_error:
            social_api.create_social_proxy(
                social_api.SocialProxyPayload(host="dc.example", port=8080, ip_type="datacenter")
            )
        self.assertEqual(create_error.exception.status_code, 400)

        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(host="static.example", port=1080)
        )
        with self.assertRaises(HTTPException) as update_error:
            social_api.update_social_proxy(
                proxy["id"], social_api.SocialProxyPatchPayload(ip_type="residential")
            )
        self.assertEqual(update_error.exception.status_code, 400)

        with self.assertRaises(HTTPException) as account_error:
            self._account(
                "invalid-proxy-type",
                proxy=social_api.ResidentialProxyPayload(
                    **self._proxy(), ip_type="datacenter"
                ),
            )
        self.assertEqual(account_error.exception.status_code, 400)

    def test_proxy_routes_and_exit_ip_list_field(self):
        app = social_api.FastAPI()
        social_api.register_social_automation_routes(app)
        route_methods = {
            (route.path, method)
            for route in app.routes
            for method in (getattr(route, "methods", None) or set())
        }
        proxy_path = "/api/persona_dashboard/automation/proxies/{proxy_id}"
        self.assertIn((proxy_path, "PATCH"), route_methods)
        self.assertIn((proxy_path, "DELETE"), route_methods)

        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(host="exit.example", port=8080)
        )
        response = mock.Mock(ok=True, status_code=200)
        response.json.return_value = {
            "success": True,
            "ip": "203.0.113.10",
            "country_code": "US",
        }
        with mock.patch.object(social_api.requests, "get", return_value=response):
            checked = social_api.check_social_proxy(proxy["id"])
        self.assertEqual(checked["exit_ip"], "203.0.113.10")
        self.assertEqual(checked["country"], "US")
        self.assertEqual(checked["region"], "")
        self.assertEqual(checked["city"], "")
        self.assertEqual(checked["isp"], "")
        with social_api.db() as conn:
            rows = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy["id"],)).fetchall()
            listed = social_api._proxy_public_rows(conn, rows)
        self.assertEqual(listed[0]["exit_ip"], "203.0.113.10")
        self.assertEqual(listed[0]["country"], "US")
        self.assertEqual(listed[0]["bound_account_count"], 0)
        self.assertEqual(listed[0]["bound_account_ids"], [])

    def test_proxy_check_url_encodes_and_redacts_credentials_from_errors(self):
        password = "p@ss:/?#"
        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(
                proxy_type="socks5",
                host="proxy.example",
                port=1080,
                username="user@region",
                password=password,
            )
        )
        encoded_url = "socks5://user%40region:p%40ss%3A%2F%3F%23@proxy.example:1080"
        with mock.patch.object(
            social_api.requests,
            "get",
            side_effect=RuntimeError(f"proxy failed: {encoded_url}; password={password}"),
        ) as request_get:
            checked = social_api.check_social_proxy(proxy["id"])

        self.assertEqual(request_get.call_args.kwargs["proxies"]["http"], encoded_url)
        public_json = json.dumps(checked, ensure_ascii=False)
        self.assertNotIn(password, public_json)
        self.assertNotIn("user@region", public_json)
        self.assertNotIn("p%40ss%3A%2F%3F%23", public_json)
        self.assertIn("***", public_json)
        with sqlite3.connect(self.db_path) as conn:
            stored = conn.execute("SELECT last_check_result FROM social_proxies WHERE id = ?", (proxy["id"],)).fetchone()[0]
        self.assertNotIn(password, stored)
        self.assertNotIn("p%40ss%3A%2F%3F%23", stored)


if __name__ == "__main__":
    unittest.main()
