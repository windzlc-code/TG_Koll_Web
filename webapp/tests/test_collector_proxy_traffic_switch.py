from __future__ import annotations

import unittest
from unittest.mock import patch

from webapp import collector_proxy_admin as admin


class CollectorProxyTrafficSwitchTests(unittest.TestCase):
    def _traffic(self) -> dict:
        return {
            "products": [
                {
                    "id": "2298788",
                    "status": "ACTIVE",
                    "network_type": "RESIDENTIAL",
                    "bandwidth_total_gb": 4,
                    "bandwidth_used_gb": 3.99,
                    "bandwidth_remaining_gb": 0.01,
                },
                {
                    "id": "2320829",
                    "status": "ACTIVE",
                    "network_type": "RESIDENTIAL",
                    "bandwidth_total_gb": 4,
                    "bandwidth_used_gb": 0,
                    "bandwidth_remaining_gb": 4,
                },
                {
                    "id": "2301582",
                    "status": "ACTIVE",
                    "network_type": "RESIDENTIAL",
                    "bandwidth_total_gb": 4,
                    "bandwidth_used_gb": 0.43,
                    "bandwidth_remaining_gb": 3.57,
                },
                {
                    "id": "2315240",
                    "status": "ACTIVE",
                    "network_type": "RESIDENTIAL_STATIC",
                    "bandwidth_total_gb": 0,
                    "bandwidth_used_gb": 0.7,
                    "bandwidth_remaining_gb": 0,
                },
            ]
        }

    def _config(self) -> dict:
        fingerprint = "abc"
        return {
            "selected_product_id": "2298788",
            "provider_proxy_id": "2298788",
            "account_product_id": "2301582",
            "provider_api_key": "key",
            "provider_api_secret": "secret",
            "reader_proxy": {
                "product_id": "2298788",
                "host": "thehub.proxy-cheap.com",
                "port": 8080,
                "protocol": "http",
                "username": "old-user",
                "password": "old-pass",
            },
            "account_proxy": {
                "product_id": "2301582",
                "host": "thehub.proxy-cheap.com",
                "port": 8080,
                "protocol": "http",
                "username": "account-user",
                "password": "account-pass",
                "mode": "sticky",
            },
            "products": [
                {
                    "proxy_id": "2298788",
                    "product_id": "2298788",
                    "product": {"id": "2298788", "network_type": "RESIDENTIAL"},
                    "host": "thehub.proxy-cheap.com",
                    "port": 8080,
                    "protocol": "http",
                    "username": "old-user",
                    "password": "old-pass",
                    "public_reader_enabled": True,
                    "state": "active",
                    "last_check": {"ok": True, "connection_fingerprint": fingerprint},
                    "connection_fingerprint": fingerprint,
                },
                {
                    "proxy_id": "2301582",
                    "product_id": "2301582",
                    "product": {"id": "2301582", "network_type": "RESIDENTIAL"},
                    "host": "thehub.proxy-cheap.com",
                    "port": 8080,
                    "protocol": "http",
                    "username": "account-user",
                    "password": "account-pass",
                    "public_reader_enabled": False,
                    "state": "ready",
                    "mode": "sticky",
                    "last_check": {"ok": True, "connection_fingerprint": fingerprint},
                    "connection_fingerprint": fingerprint,
                },
            ],
        }

    def test_picks_new_rotating_package_not_account_or_static(self):
        candidate = admin._pick_reader_switch_candidate(
            self._config(),
            self._traffic(),
            exclude_ids={"2298788", "2301582"},
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(str(candidate["id"]), "2320829")

    def test_switches_exhausted_reader_to_new_product(self):
        def fake_prepare(config, products, candidate, *, api_key, api_secret):
            proxy_id = str(candidate.get("id") or "")
            entry = {
                "proxy_id": proxy_id,
                "product_id": proxy_id,
                "product": {"id": proxy_id, "network_type": "RESIDENTIAL"},
                "host": "thehub.proxy-cheap.com",
                "port": 8080,
                "protocol": "http",
                "username": "new-user",
                "password": "new-pass",
                "public_reader_enabled": False,
                "state": "ready",
                "last_check": {"ok": True, "connection_fingerprint": "new"},
            }
            products.append(entry)
            return entry

        with patch.object(admin, "_prepare_reader_product_entry", side_effect=fake_prepare):
            updated = admin._maybe_switch_exhausted_reader(self._config(), self._traffic())
        self.assertEqual(updated["selected_product_id"], "2320829")
        self.assertEqual(updated["traffic_warning"]["code"], "reader_traffic_switched")
        self.assertIn("2320829", updated["traffic_warning"]["message"])
        enabled = [
            str(item.get("proxy_id") or "")
            for item in updated["products"]
            if item.get("public_reader_enabled")
        ]
        self.assertEqual(enabled, ["2320829"])
        self.assertFalse(
            next(item for item in updated["products"] if item["proxy_id"] == "2301582")["public_reader_enabled"]
        )

    def test_low_traffic_sets_warning_without_switch(self):
        traffic = self._traffic()
        traffic["products"][0]["bandwidth_used_gb"] = 3.6
        traffic["products"][0]["bandwidth_remaining_gb"] = 0.4
        updated = admin._maybe_switch_exhausted_reader(self._config(), traffic)
        self.assertEqual(updated["selected_product_id"], "2298788")
        self.assertEqual(updated["traffic_warning"]["code"], "reader_traffic_low")

    def test_traffic_chart_groups_split_rotating_and_sticky(self):
        groups = admin._traffic_chart_groups(self._traffic(), self._config())
        self.assertEqual(groups["rotating"]["product_count"], 2)
        self.assertAlmostEqual(groups["rotating"]["total_gb"], 8)
        self.assertAlmostEqual(groups["rotating"]["remaining_gb"], 4.01)
        self.assertEqual(groups["sticky"]["product_count"], 2)
        self.assertAlmostEqual(groups["sticky"]["total_gb"], 4)
        self.assertAlmostEqual(groups["sticky"]["remaining_gb"], 3.57)
        self.assertEqual(groups["rotating"]["label"], "动态 IP")
        self.assertEqual(groups["sticky"]["label"], "粘性 IP")

    def test_public_config_exposes_warning(self):
        config = self._config()
        config["traffic_warning"] = {"level": "error", "message": "动态 IP 流量已耗尽"}
        public = admin._public_config(config)
        self.assertEqual(public["traffic_warning"]["message"], "动态 IP 流量已耗尽")

    def test_runtime_account_proxy_url_pins_sticky_session_to_collector_account(self):
        config = self._config()
        config["account_proxy"]["password"] = "secret_session-OLDTOKEN_ttl-30m"
        config["account_proxy_mode"] = "sticky"
        with patch.object(admin, "_load_config", return_value=config):
            first = admin.runtime_account_proxy_url("colacct_liliac", "2301582")
            again = admin.runtime_account_proxy_url("colacct_liliac", "2301582")
            other = admin.runtime_account_proxy_url("colacct_other", "2301582")
        self.assertTrue(first.startswith("http://account-user:"))
        self.assertIn("thehub.proxy-cheap.com:8080", first)
        self.assertNotIn("OLDTOKEN", first)
        self.assertIn("_ttl-30m", first)
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)
        self.assertEqual(admin.runtime_account_proxy_url("colacct_liliac", ""), "")

    def test_runtime_account_proxy_url_requires_matching_product(self):
        with patch.object(admin, "_load_config", return_value=self._config()):
            with self.assertRaisesRegex(RuntimeError, "matching product is unavailable"):
                admin.runtime_account_proxy_url("colacct_liliac", "9999999")

    def test_allocate_runtime_account_proxy_pins_session_and_returns_exit_ip(self) -> None:
        config = self._config()
        config["account_proxy"]["password"] = "secret_session-OLDTOKEN_ttl-30m"
        config["sticky_session_seconds"] = 1800
        probe = {"ok": True, "exit_ip": "203.0.113.44", "latency_ms": 12, "checked_at": 100}
        with patch.object(admin, "_load_config", return_value=config), \
             patch.object(admin, "_test_connection", return_value=probe), \
             patch.object(admin, "_record_sticky_session") as recorded, \
             patch.object(admin, "_now", return_value=1000):
            allocated = admin.allocate_runtime_account_proxy("account-abc")
        self.assertEqual(allocated["exit_ip"], "203.0.113.44")
        self.assertEqual(allocated["expires_at"], 2800)
        self.assertEqual(allocated["product_id"], "2301582")
        self.assertEqual(allocated["server"], "http://thehub.proxy-cheap.com:8080")
        self.assertNotIn("OLDTOKEN", allocated["password"])
        self.assertIn("_ttl-30m", allocated["password"])
        recorded.assert_called_once()
        self.assertEqual(recorded.call_args.args[0], "account-abc")

    def test_allocate_runtime_account_proxy_requires_account_id(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "account_id is required"):
            admin.allocate_runtime_account_proxy("")

    def test_prunes_metered_products_when_remaining_traffic_is_gone(self) -> None:
        config = self._config()
        config["products"].append(
            {
                "proxy_id": "2320829",
                "product_id": "2320829",
                "product": {"id": "2320829", "network_type": "RESIDENTIAL"},
                "host": "thehub.proxy-cheap.com",
                "port": 8080,
                "protocol": "http",
                "public_reader_enabled": False,
                "state": "ready",
            }
        )
        pruned, removed = admin._prune_exhausted_products(config, self._traffic())
        self.assertEqual(removed, ["2298788"])
        kept = {str(item.get("proxy_id")) for item in pruned.get("products") or []}
        self.assertNotIn("2298788", kept)
        self.assertIn("2301582", kept)
        self.assertIn("2320829", kept)

    def test_static_zero_cap_products_are_not_treated_as_exhausted(self) -> None:
        self.assertFalse(admin._is_summary_exhausted({
            "id": "2315240",
            "bandwidth_total_gb": 0,
            "bandwidth_used_gb": 0.7,
            "bandwidth_remaining_gb": 0,
        }))
        self.assertTrue(admin._is_summary_exhausted({
            "id": "2298788",
            "bandwidth_total_gb": 4,
            "bandwidth_used_gb": 4,
            "bandwidth_remaining_gb": 0,
        }))

    def test_worker_exposes_signed_sticky_allocate_route(self) -> None:
        from pathlib import Path

        worker = (Path(__file__).resolve().parents[1] / "worker_server.py").read_text(encoding="utf-8")
        self.assertIn('"/internal/worker/v1/account-proxy/allocate"', worker)
        self.assertIn("allocate_runtime_account_proxy", worker)


class CollectorProxyOnboardTests(unittest.TestCase):
    def _supplier(self, proxy_id: str = "2400001") -> dict:
        return {
            "id": proxy_id,
            "status": "ACTIVE",
            "networkType": "RESIDENTIAL",
            "proxyType": "HTTP",
            "authentication": {"username": "new-user", "password": "new-pass"},
            "connection": {"hostnames": ["thehub.proxy-cheap.com"], "httpPort": 8080},
            "bandwidth": {"total": 4, "used": 0},
        }

    def _probe(self) -> dict:
        return {"ok": True, "exit_ip": "203.0.113.10", "latency_ms": 12, "checked_at": 1}

    def test_onboard_fills_connection_tests_and_enables_reader_when_pool_empty(self) -> None:
        config = {"account_product_id": "2301582"}
        products: list[dict] = []
        with patch.object(admin, "_test_connection", return_value=self._probe()) as probed:
            entry = admin._onboard_proxy_product(
                config, products, self._supplier(), supplier=self._supplier(), is_new=True,
            )
        self.assertEqual(probed.call_count, 1)
        self.assertEqual(entry["host"], "thehub.proxy-cheap.com")
        self.assertEqual(entry["port"], 8080)
        self.assertEqual(entry["username"], "new-user")
        self.assertEqual(entry["traffic_role"], "dynamic")
        self.assertTrue(entry["public_reader_enabled"])
        self.assertEqual(entry["state"], "active")
        self.assertTrue(entry["last_check"]["ok"])
        self.assertEqual(entry["last_check"]["connection_fingerprint"], entry["connection_fingerprint"])

    def test_second_new_product_joins_ready_and_does_not_steal_reader(self) -> None:
        config = {}
        products: list[dict] = []
        with patch.object(admin, "_test_connection", return_value=self._probe()):
            first = admin._onboard_proxy_product(
                config, products, self._supplier("2400001"), supplier=self._supplier("2400001"), is_new=True,
            )
            second = admin._onboard_proxy_product(
                config, products, self._supplier("2400002"), supplier=self._supplier("2400002"), is_new=True,
            )
        self.assertTrue(first["public_reader_enabled"])
        self.assertEqual(first["state"], "active")
        self.assertFalse(second["public_reader_enabled"])
        self.assertEqual(second["state"], "ready")
        self.assertEqual(second["traffic_role"], "dynamic")

    def test_user_set_reader_stays_off_even_when_pool_empty(self) -> None:
        config = {}
        products = [admin._blank_product_entry("2400001")]
        products[0]["user_set_reader"] = True
        products[0]["public_reader_enabled"] = False
        with patch.object(admin, "_test_connection", return_value=self._probe()):
            entry = admin._onboard_proxy_product(
                config, products, self._supplier(), supplier=self._supplier(), is_new=True,
            )
        self.assertFalse(entry["public_reader_enabled"])
        self.assertEqual(entry["state"], "ready")
        self.assertTrue(entry["user_set_reader"])

    def test_user_set_sticky_role_is_kept_and_reader_stays_off(self) -> None:
        config = {}
        products = [admin._blank_product_entry("2400001")]
        products[0]["user_set_traffic_role"] = True
        products[0]["traffic_role"] = "sticky"
        with patch.object(admin, "_test_connection", return_value=self._probe()):
            entry = admin._onboard_proxy_product(
                config, products, self._supplier(), supplier=self._supplier(), is_new=True,
            )
        self.assertEqual(entry["traffic_role"], "sticky")
        self.assertEqual(entry["mode"], "sticky")
        self.assertFalse(entry["public_reader_enabled"])
        self.assertEqual(entry["state"], "ready")

    def test_normalise_products_preserves_user_overrides(self) -> None:
        config = {
            "products": [
                {
                    "proxy_id": "2400001",
                    "public_reader_enabled": False,
                    "user_set_reader": True,
                    "user_set_traffic_role": True,
                    "traffic_role": "sticky",
                }
            ]
        }
        products = admin._normalise_products(config)
        self.assertEqual(len(products), 1)
        self.assertTrue(products[0]["user_set_reader"])
        self.assertTrue(products[0]["user_set_traffic_role"])
        self.assertEqual(products[0]["traffic_role"], "sticky")
        self.assertFalse(products[0]["public_reader_enabled"])

    def test_failed_detect_does_not_enable_reader(self) -> None:
        config = {}
        products: list[dict] = []
        with patch.object(admin, "_test_connection", return_value={"ok": False, "error": "timeout", "checked_at": 1}):
            entry = admin._onboard_proxy_product(
                config, products, self._supplier(), supplier=self._supplier(), is_new=True,
            )
        self.assertFalse(entry["public_reader_enabled"])
        self.assertEqual(entry["state"], "check_failed")

    def test_webhook_ingests_new_sku_and_skips_existing(self) -> None:
        current = {
            "proxy_id": "2301582",
            "product_id": "2301582",
            "host": "thehub.proxy-cheap.com",
            "port": 8080,
            "protocol": "http",
            "username": "old-user",
            "password": "old-pass",
            "public_reader_enabled": True,
            "state": "active",
            "traffic_role": "dynamic",
        }
        fingerprint = admin._connection_fingerprint(current)
        current["connection_fingerprint"] = fingerprint
        current["last_check"] = {"ok": True, "connection_fingerprint": fingerprint}
        existing = {
            "provider_api_key": "key",
            "provider_api_secret": "secret",
            "products": [current],
        }
        written: list[dict] = []
        supplier_list = [
            {"id": "2301582", "status": "ACTIVE", "networkType": "RESIDENTIAL", "bandwidth": {"total": 4, "used": 0.2}},
            self._supplier("2400001"),
        ]

        def fake_load():
            return written[-1] if written else dict(existing)

        def fake_write(config):
            written.append(dict(config))

        with patch.object(admin, "_load_config", side_effect=fake_load), \
             patch.object(admin, "_write_config", side_effect=fake_write), \
             patch.object(admin, "_fetch_proxycheap_products", return_value=supplier_list), \
             patch.object(admin, "_fetch_proxycheap_product", return_value=self._supplier("2400001")), \
             patch.object(admin, "_test_connection", return_value=self._probe()):
            admin._refresh_proxycheap_after_webhook({"event_id": "evt-1"})
        self.assertTrue(written)
        latest = written[-1]
        ids = [str(item.get("proxy_id")) for item in latest.get("products") or []]
        self.assertIn("2400001", ids)
        new_item = next(item for item in latest["products"] if item["proxy_id"] == "2400001")
        self.assertEqual(new_item["host"], "thehub.proxy-cheap.com")
        self.assertEqual(new_item["username"], "new-user")
        self.assertEqual(new_item["state"], "ready")
        self.assertFalse(new_item["public_reader_enabled"])
        old_item = next(item for item in latest["products"] if item["proxy_id"] == "2301582")
        self.assertTrue(old_item["public_reader_enabled"])
        self.assertEqual(latest["webhook_last_refresh"]["ingested_ids"], ["2400001"])


if __name__ == "__main__":
    unittest.main()
