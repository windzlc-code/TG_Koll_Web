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


if __name__ == "__main__":
    unittest.main()
