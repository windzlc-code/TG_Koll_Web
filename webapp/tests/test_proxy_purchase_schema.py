from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from webapp import db as app_db


class ProxyPurchaseSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(
            os.environ,
            {"APP_DB_PATH": os.path.join(self.temp.name, "app.db")},
            clear=False,
        )
        self.env.start()
        app_db.init_db()

    def tearDown(self) -> None:
        self.env.stop()
        self.temp.cleanup()

    def test_supplier_order_and_proxy_ids_are_unique_when_present(self) -> None:
        with app_db.db() as conn:
            index_rows = {
                str(row["name"]): str(row["sql"] or "")
                for row in conn.execute(
                    "SELECT name,sql FROM sqlite_master "
                    "WHERE type='index' AND tbl_name='proxy_purchase_orders'"
                ).fetchall()
            }

        order_index = index_rows.get("idx_proxy_purchase_orders_provider_order_unique", "")
        proxy_index = index_rows.get("idx_proxy_purchase_orders_provider_proxy_unique", "")
        self.assertIn("CREATE UNIQUE INDEX", order_index.upper())
        self.assertIn("PROVIDER_ORDER_ID <> ''", order_index.upper())
        self.assertIn("CREATE UNIQUE INDEX", proxy_index.upper())
        self.assertIn("PROVIDER_PROXY_ID <> ''", proxy_index.upper())

        raw = sqlite3.connect(os.path.join(self.temp.name, "app.db"))
        try:
            def insert_order(
                local_id: str,
                provider: str,
                provider_order_id: str,
                provider_proxy_id: str,
            ) -> None:
                raw.execute(
                    "INSERT INTO proxy_purchase_orders("
                    "id,user_id,quote_id,provider_key,provider_order_id,provider_proxy_id,"
                    "request_hash,request_json,credit_units,config_version_id,idempotency_key,"
                    "created_at,updated_at) VALUES (?,?,?,?,?,?,'hash','{}',0,'config',?,?,?)",
                    (
                        local_id,
                        1,
                        "quote",
                        provider,
                        provider_order_id,
                        provider_proxy_id,
                        local_id,
                        1,
                        1,
                    ),
                )

            insert_order("empty-a", "proxycheap", "", "")
            insert_order("empty-b", "proxycheap", "", "")
            insert_order("first", "proxycheap", "supplier-order", "supplier-proxy")
            with self.assertRaises(sqlite3.IntegrityError):
                insert_order("duplicate-order", "proxycheap", "supplier-order", "other-proxy")
            with self.assertRaises(sqlite3.IntegrityError):
                insert_order("duplicate-proxy", "proxycheap", "other-order", "supplier-proxy")
            insert_order("other-provider", "other", "supplier-order", "supplier-proxy")
        finally:
            raw.close()

    def test_legacy_duplicate_supplier_reference_stops_migration_without_rewriting_data(self) -> None:
        raw = sqlite3.connect(os.path.join(self.temp.name, "app.db"))
        raw.row_factory = sqlite3.Row
        try:
            raw.execute("DROP INDEX idx_proxy_purchase_orders_provider_order_unique")
            raw.execute("DROP INDEX idx_proxy_purchase_orders_provider_proxy_unique")
            values = (
                1,
                "quote",
                "proxycheap",
                "duplicate-supplier-order",
                "hash",
                "{}",
                0,
                "config",
                1,
                1,
            )
            for local_id in ("legacy-a", "legacy-b"):
                raw.execute(
                    "INSERT INTO proxy_purchase_orders("
                    "id,user_id,quote_id,provider_key,provider_order_id,request_hash,request_json,"
                    "credit_units,config_version_id,idempotency_key,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (local_id, *values[:-2], local_id, *values[-2:]),
                )
            raw.commit()

            with self.assertRaisesRegex(RuntimeError, "legacy-a,legacy-b"):
                app_db._ensure_proxy_purchase_schema(raw)

            remaining = raw.execute(
                "SELECT id,provider_order_id FROM proxy_purchase_orders ORDER BY id"
            ).fetchall()
            self.assertEqual(
                [(row["id"], row["provider_order_id"]) for row in remaining],
                [
                    ("legacy-a", "duplicate-supplier-order"),
                    ("legacy-b", "duplicate-supplier-order"),
                ],
            )
        finally:
            raw.close()

if __name__ == "__main__":
    unittest.main()
