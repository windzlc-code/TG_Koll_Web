import json
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
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

    @staticmethod
    def _json_response(payload, *, status_code=200):
        response = mock.Mock(ok=200 <= status_code < 300, status_code=status_code)
        response.json.return_value = payload
        response.text = json.dumps(payload)
        return response

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

    def _claimed_task(self, task_id: str, account_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO social_automation_tasks(
                  id, user_id, persona_id, account_id, platform, task_type,
                  priority, status, payload_json, result_json, created_at, updated_at
                ) VALUES (?, 0, '', ?, 'threads', 'check_login', 50, 'running', '{}', '{}', 1, 1)
                """,
                (task_id, account_id),
            )
        return {"id": task_id, "account_id": account_id, "task_type": "check_login"}

    def _set_legacy_proxy_id(self, account_id: str, proxy_id: str) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DROP TRIGGER trg_social_accounts_integrity_update")
            conn.execute(
                "UPDATE social_accounts SET proxy_id = ? WHERE id = ?",
                (proxy_id, account_id),
            )
        init_db()

    def _mark_proxy_verified(self, proxy_id: str, exit_ip: str = "8.8.8.8") -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_proxies SET status = 'active', last_check_at = 100, last_check_result = ? WHERE id = ?",
                (json.dumps({"ok": True, "exit_ip": exit_ip, "response": {"ip": exit_ip}}), proxy_id),
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
        self.assertEqual(account["residential_proxy"]["country"], "")
        self.assertEqual(account["residential_proxy"]["isp"], "")
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

    def test_login_credentials_are_created_atomically_and_survive_proxy_removal(self):
        account = social_api.create_social_account(
            social_api.SocialAccountPayload(
                platform="threads",
                username="credential-owner",
                login_username="owner@example.com",
                login_password="saved-login-secret",
                profile_dir=str(self.root / "profiles" / "credential-owner"),
                residential_proxy=social_api.ResidentialProxyPayload(**self._proxy()),
            )
        )

        self.assertEqual(account["login_username"], "owner@example.com")
        self.assertTrue(account["login_password_configured"])
        self.assertTrue(account["proxy_id"])

        updated = social_api.update_social_account(
            account["id"],
            social_api.SocialAccountPatchPayload(clear_residential_proxy=True),
        )

        self.assertEqual(updated["proxy_id"], "")
        self.assertTrue(updated["login_password_configured"])
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT login_username, login_password, proxy_id FROM social_accounts WHERE id = ?",
                (account["id"],),
            ).fetchone()
        self.assertEqual(row, ("owner@example.com", "saved-login-secret", ""))

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

    def test_account_binding_can_atomically_replace_existing_persona_account(self):
        original = self._account("original-bound", persona_id="persona-switch")
        replacement = self._account("replacement-unbound")

        with self.assertRaises(HTTPException) as conflict:
            social_api.update_social_account(
                replacement["id"],
                social_api.SocialAccountPatchPayload(persona_id="persona-switch"),
            )
        self.assertEqual(conflict.exception.status_code, 409)

        updated = social_api.update_social_account(
            replacement["id"],
            social_api.SocialAccountPatchPayload(
                persona_id="persona-switch",
                replace_existing_binding=True,
            ),
        )

        self.assertEqual(updated["persona_id"], "persona-switch")
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, persona_id FROM social_accounts WHERE id IN (?, ?) ORDER BY id",
                (original["id"], replacement["id"]),
            ).fetchall()
        bindings = {account_id: persona_id for account_id, persona_id in rows}
        self.assertEqual(bindings[original["id"]], "")
        self.assertEqual(bindings[replacement["id"]], "persona-switch")

    def test_account_binding_replacement_releases_all_legacy_duplicates(self):
        first = self._account("legacy-first", persona_id="persona-legacy")
        replacement = self._account("legacy-replacement")
        second_id = "legacy-second-id"
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO social_accounts(
                  id, user_id, persona_id, platform, username, profile_dir, status, created_at, updated_at
                ) VALUES (?, 0, 'persona-legacy', 'threads', 'legacy-second', '', 'pending_login', 1, 1)
                """,
                (second_id,),
            )

        social_api.update_social_account(
            replacement["id"],
            social_api.SocialAccountPatchPayload(
                persona_id="persona-legacy",
                replace_existing_binding=True,
            ),
        )

        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, persona_id FROM social_accounts WHERE id IN (?, ?, ?)",
                (first["id"], second_id, replacement["id"]),
            ).fetchall()
        bindings = {account_id: persona_id for account_id, persona_id in rows}
        self.assertEqual(bindings[first["id"]], "")
        self.assertEqual(bindings[second_id], "")
        self.assertEqual(bindings[replacement["id"]], "persona-legacy")

    def test_account_binding_replacement_rolls_back_on_unbound_username_conflict(self):
        original = self._account("duplicate-name", persona_id="persona-conflict")
        self._account("duplicate-name")
        replacement = self._account("replacement-conflict")

        with self.assertRaises(HTTPException) as caught:
            social_api.update_social_account(
                replacement["id"],
                social_api.SocialAccountPatchPayload(
                    persona_id="persona-conflict",
                    replace_existing_binding=True,
                ),
            )
        self.assertEqual(caught.exception.status_code, 409)

        with sqlite3.connect(self.db_path) as conn:
            bindings = dict(conn.execute(
                "SELECT id, persona_id FROM social_accounts WHERE id IN (?, ?)",
                (original["id"], replacement["id"]),
            ).fetchall())
        self.assertEqual(bindings[original["id"]], "persona-conflict")
        self.assertEqual(bindings[replacement["id"]], "")

    def test_account_binding_replacement_rejects_active_tasks(self):
        original = self._account("active-original", persona_id="persona-active")
        replacement = self._account("active-replacement")
        self._claimed_task("active-binding-task", original["id"])

        with self.assertRaises(HTTPException) as caught:
            social_api.update_social_account(
                replacement["id"],
                social_api.SocialAccountPatchPayload(
                    persona_id="persona-active",
                    replace_existing_binding=True,
                ),
            )
        self.assertEqual(caught.exception.status_code, 409)

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
        self._set_legacy_proxy_id(active["id"], "missing-proxy")
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

    def test_concurrent_duplicate_publish_reuses_one_active_task(self):
        account = self._account("publish-dedup")

        def create_publish_task():
            return social_api.create_social_task(
                social_api.SocialTaskPayload(
                    account_id=account["id"],
                    platform="threads",
                    task_type="publish_post",
                    payload={
                        "content": "same publish content",
                        "archive_post_id": "post-dedup-1",
                        "archive_post_source": "draft",
                    },
                )
            )

        with mock.patch.object(social_api, "wake_social_automation_worker"):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _index: create_publish_task(), range(2)))

        self.assertEqual(results[0]["id"], results[1]["id"])
        self.assertTrue(any(bool(item.get("reused")) for item in results))
        with sqlite3.connect(self.db_path) as conn:
            task_count = conn.execute(
                "SELECT COUNT(*) FROM social_automation_tasks WHERE account_id = ? AND task_type = 'publish_post'",
                (account["id"],),
            ).fetchone()[0]
        self.assertEqual(task_count, 1)

    def test_social_worker_scheduler_stops_cleanly(self):
        old_enabled = os.environ.get("SOCIAL_AUTOMATION_WORKER_ENABLED")
        os.environ["SOCIAL_AUTOMATION_WORKER_ENABLED"] = "1"
        try:
            social_api.ensure_social_automation_worker_started()
            worker = social_api._WORKER_THREAD
            self.assertIsNotNone(worker)
            self.assertTrue(worker.is_alive())

            social_api.stop_social_automation_worker(timeout_seconds=2)

            self.assertFalse(worker.is_alive())
            self.assertIsNone(social_api._WORKER_THREAD)
        finally:
            social_api.stop_social_automation_worker(timeout_seconds=2)
            if old_enabled is None:
                os.environ.pop("SOCIAL_AUTOMATION_WORKER_ENABLED", None)
            else:
                os.environ["SOCIAL_AUTOMATION_WORKER_ENABLED"] = old_enabled

        ready = self._account("ready", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="ready.example")))
        self._mark_proxy_verified(ready["proxy_id"])
        self.assertEqual(self._task(ready["id"])["account_id"], ready["id"])

    def test_task_creation_and_worker_reject_expired_proxy(self):
        account = self._account(
            "expired",
            proxy=social_api.ResidentialProxyPayload(**self._proxy(host="expired.example", expires_at=social_api._now() - 1)),
        )
        with self.assertRaises(HTTPException) as create_error:
            self._task(account["id"])
        self.assertEqual(create_error.exception.status_code, 409)
        with self.assertRaisesRegex(RuntimeError, "已过期"):
            social_api._execute_claimed_task(self._claimed_task("expired-task-1", account["id"]))

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
        self._set_legacy_proxy_id(dangling["id"], "missing-proxy")
        with self.assertRaisesRegex(RuntimeError, "不存在"):
            social_api._execute_claimed_task(self._claimed_task("legacy-task-1", dangling["id"]))

        failed = self._account(
            "legacy-failed-proxy",
            proxy=social_api.ResidentialProxyPayload(**self._proxy(host="legacy-failed.example")),
        )
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE social_proxies SET status = 'failed' WHERE id = ?", (failed["proxy_id"],))
        with self.assertRaisesRegex(RuntimeError, "不可用"):
            social_api._execute_claimed_task(self._claimed_task("legacy-task-2", failed["id"]))

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
        self.assertEqual(stored, ("", ""))

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

    def test_proxy_endpoint_rejects_complete_urls_and_invalid_auth(self):
        invalid_hosts = (
            "socks5://208.113.11.225",
            "user@example.com",
            "proxy.example.com/path",
            "proxy.example.com:1080",
        )
        for host in invalid_hosts:
            with self.subTest(host=host):
                with self.assertRaises(HTTPException) as caught:
                    social_api.create_social_proxy(
                        social_api.SocialProxyPayload(host=host, port=1080)
                    )
                self.assertEqual(caught.exception.status_code, 400)

        with self.assertRaises(HTTPException) as password_only:
            social_api.create_social_proxy(
                social_api.SocialProxyPayload(
                    host="208.113.11.225",
                    port=7778,
                    password="secret-without-user",
                )
            )
        self.assertEqual(password_only.exception.status_code, 400)

    def test_proxy_status_is_server_managed_and_connection_changes_require_recheck(self):
        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(
                host="208.113.11.225",
                port=7778,
                status="active",
            )
        )
        self.assertEqual(proxy["status"], "pending")

        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE social_proxies SET status = 'active', last_check_at = 100, last_check_result = ? WHERE id = ?",
                (json.dumps({"ok": True, "exit_ip": "208.113.11.225"}), proxy["id"]),
            )
        updated = social_api.update_social_proxy(
            proxy["id"],
            social_api.SocialProxyPatchPayload(host="208.113.11.226", status="active"),
        )
        self.assertEqual(updated["status"], "pending")
        self.assertEqual(updated["last_check_at"], 0)
        self.assertEqual(updated["last_check_result"], {})

    def test_proxy_check_verifies_route_static_exit_and_residential_metadata(self):
        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(
                proxy_type="socks5",
                host="208.113.11.225",
                port=7778,
                username="region-user",
                password="proxy-secret",
            )
        )
        responses = [
            self._json_response({"ip": "47.243.99.2"}),
            self._json_response({"ip": "208.113.11.225"}),
            self._json_response({
                "success": True,
                "ip": "208.113.11.225",
                "country": "Taiwan",
                "country_code": "TW",
                "region": "Keelung City",
                "city": "Taipei",
                "connection": {"isp": "Bunny Communications", "org": "Bunny Communications"},
            }),
            self._json_response({
                "ip": "208.113.11.225",
                "is_bogon": False,
                "is_datacenter": False,
                "is_tor": False,
                "is_vpn": False,
                "company": {"type": "isp", "name": "Accelerated Connections Inc."},
            }),
        ]
        with mock.patch.object(social_api.requests, "get", side_effect=responses) as request_get:
            checked = social_api.check_social_proxy(proxy["id"])

        self.assertEqual(request_get.call_count, 4)
        self.assertEqual(checked["status"], "active")
        self.assertEqual(checked["exit_ip"], "208.113.11.225")
        self.assertEqual(checked["country"], "TW")
        self.assertEqual(checked["region"], "Keelung City")
        self.assertEqual(checked["city"], "Taipei")
        self.assertEqual(checked["isp"], "Bunny Communications")
        result = checked["last_check_result"]
        self.assertTrue(result["ok"])
        self.assertTrue(result["route_verified"])
        self.assertTrue(result["static_consistent"])
        self.assertEqual(result["residential_status"], "verified")

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
        self.assertIn(("/api/persona_dashboard/automation/proxies/test", "POST"), route_methods)

        proxy = social_api.create_social_proxy(
            social_api.SocialProxyPayload(host="exit.example", port=8080)
        )
        responses = [
            self._json_response({"ip": "47.243.99.2"}),
            self._json_response({"ip": "8.8.8.8"}),
            self._json_response({"success": True, "ip": "8.8.8.8", "country_code": "US"}),
            self._json_response({
                "ip": "8.8.8.8", "is_bogon": False, "is_datacenter": False,
                "is_tor": False, "is_vpn": False, "company": {"type": "isp"},
            }),
        ]
        with mock.patch.object(social_api.requests, "get", side_effect=responses):
            checked = social_api.check_social_proxy(proxy["id"])
        self.assertEqual(checked["exit_ip"], "8.8.8.8")
        self.assertEqual(checked["country"], "US")
        self.assertEqual(checked["region"], "")
        self.assertEqual(checked["city"], "")
        self.assertEqual(checked["isp"], "")
        with social_api.db() as conn:
            rows = conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy["id"],)).fetchall()
            listed = social_api._proxy_public_rows(conn, rows)
        self.assertEqual(listed[0]["exit_ip"], "8.8.8.8")
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
        direct = self._json_response({"ip": "47.243.99.2"})
        with mock.patch.object(
            social_api.requests,
            "get",
            side_effect=[direct, RuntimeError(f"proxy failed: {encoded_url}; password={password}")],
        ) as request_get:
            checked = social_api.check_social_proxy(proxy["id"])

        self.assertEqual(request_get.call_args_list[1].kwargs["proxies"]["http"], encoded_url)
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
