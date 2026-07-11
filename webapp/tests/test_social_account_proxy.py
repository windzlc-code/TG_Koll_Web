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
            proxy=social_api.ResidentialProxyPayload(**self._proxy()),
        )
        proxy_id = account["proxy_id"]

        self.assertEqual(account["residential_proxy"]["protocol"], "socks5")
        self.assertEqual(account["residential_proxy"]["country"], "US")
        self.assertEqual(account["residential_proxy"]["isp"], "Residential ISP")
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

    def test_task_creation_requires_existing_non_failed_proxy(self):
        no_proxy = self._account("no-proxy")
        with self.assertRaises(HTTPException) as missing_config:
            self._task(no_proxy["id"])
        self.assertEqual(missing_config.exception.status_code, 409)

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

        ready = self._account("ready", proxy=social_api.ResidentialProxyPayload(**self._proxy(host="ready.example")))
        self.assertEqual(self._task(ready["id"])["account_id"], ready["id"])

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
