import os
import tempfile
import unittest
from pathlib import Path

from webapp import commercial_billing
from webapp import db as db_module


class ProxyPurchaseBillingTests(unittest.TestCase):
    def setUp(self):
        self.old_db_path = os.environ.get("APP_DB_PATH")
        self.old_billing_enabled = os.environ.get("COMMERCIAL_BILLING_ENABLED")
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        os.environ["COMMERCIAL_BILLING_ENABLED"] = "1"
        db_module.init_db()
        with db_module.db() as conn:
            row = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, "
                "balance_cents, created_at, updated_at) "
                "VALUES ('proxy_billing_user', 'hash', 0, 0, 0, 100, 100)"
            )
            self.user_id = int(row.lastrowid)
            conn.execute(
                "INSERT INTO billing_wallets(user_id, credit_units, "
                "cash_backed_credit_units, billing_mode, migrated_legacy_balance, "
                "created_at, updated_at) VALUES (?, 700, 500, 'enforced', 0, 100, 100)",
                (self.user_id,),
            )

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db_path
        if self.old_billing_enabled is None:
            os.environ.pop("COMMERCIAL_BILLING_ENABLED", None)
        else:
            os.environ["COMMERCIAL_BILLING_ENABLED"] = self.old_billing_enabled
        self.tmpdir.cleanup()

    def test_exact_cash_reservation_is_idempotent_and_releases_original_bucket(self):
        with db_module.db() as conn:
            reservation = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=self.user_id,
                ref_type="proxy_purchase",
                ref_id="purchase-1",
                sku="proxycheap:static-residential",
                credit_units=300,
                idempotency_key="proxy-purchase-1",
                meta={"quote_id": "quote-1"},
                now=200,
            )
            replay = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=self.user_id,
                ref_type="proxy_purchase",
                ref_id="purchase-1",
                sku="proxycheap:static-residential",
                credit_units=300,
                idempotency_key="proxy-purchase-1",
                now=201,
            )
            held = conn.execute(
                "SELECT credit_units, cash_backed_credit_units FROM billing_wallets "
                "WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            released = commercial_billing.release_reservation(
                conn, reservation["id"], now=202
            )
            wallet = conn.execute(
                "SELECT credit_units, cash_backed_credit_units FROM billing_wallets "
                "WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            ledger = conn.execute(
                "SELECT cash_backed_amount_units, cash_backed_balance_after_units "
                "FROM billing_ledger WHERE reservation_id = ? ORDER BY created_at",
                (reservation["id"],),
            ).fetchall()

        self.assertEqual(replay["id"], reservation["id"])
        self.assertEqual((int(held["credit_units"]), int(held["cash_backed_credit_units"])), (400, 200))
        self.assertEqual(released["status"], "released")
        self.assertEqual((int(wallet["credit_units"]), int(wallet["cash_backed_credit_units"])), (700, 500))
        self.assertEqual([int(row["cash_backed_amount_units"]) for row in ledger], [-300, 300])

    def test_exact_cash_reservation_rejects_free_points(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET credit_units = 1000, cash_backed_credit_units = 100 "
                "WHERE user_id = ?",
                (self.user_id,),
            )
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.reserve_exact_cash_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="proxy_purchase",
                    ref_id="purchase-free",
                    sku="proxycheap:test",
                    credit_units=200,
                    idempotency_key="proxy-purchase-free",
                )
        self.assertEqual(raised.exception.code, "INSUFFICIENT_CASH_BACKED_POINTS")

    def test_exact_cash_reservation_can_be_waived_for_admin_without_balance(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE users SET is_admin = 1 WHERE id = ?",
                (self.user_id,),
            )
            conn.execute(
                "UPDATE billing_wallets SET credit_units = 0, cash_backed_credit_units = 0 "
                "WHERE user_id = ?",
                (self.user_id,),
            )
            reservation = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=self.user_id,
                ref_type="proxy_purchase",
                ref_id="purchase-admin",
                sku="proxycheap:test",
                credit_units=300,
                idempotency_key="proxy-purchase-admin",
                admin_waived=True,
            )
            wallet = conn.execute(
                "SELECT credit_units, cash_backed_credit_units FROM billing_wallets WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()

        self.assertEqual(reservation["status"], "waived")
        self.assertEqual(reservation["reserved_points"], 0)
        self.assertEqual((int(wallet["credit_units"]), int(wallet["cash_backed_credit_units"])), (0, 0))

    def test_exact_cash_idempotency_keys_are_scoped_per_user(self):
        with db_module.db() as conn:
            other = conn.execute(
                "INSERT INTO users(username,password_hash,created_at,updated_at) "
                "VALUES ('proxy_billing_other','hash',100,100)"
            )
            other_id = int(other.lastrowid)
            conn.execute(
                "INSERT INTO billing_wallets(user_id,credit_units,cash_backed_credit_units,"
                "billing_mode,migrated_legacy_balance,created_at,updated_at) "
                "VALUES (?,500,500,'enforced',0,100,100)",
                (other_id,),
            )
            first = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=self.user_id,
                ref_type="proxy_purchase",
                ref_id="owner-one",
                sku="proxycheap:test",
                credit_units=100,
                idempotency_key="same-client-key",
            )
            second = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=other_id,
                ref_type="proxy_purchase",
                ref_id="owner-two",
                sku="proxycheap:test",
                credit_units=100,
                idempotency_key="same-client-key",
            )
        self.assertNotEqual(first["id"], second["id"])

    def test_exact_cash_settlement_records_cash_backed_charge(self):
        with db_module.db() as conn:
            reservation = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=self.user_id,
                ref_type="proxy_purchase",
                ref_id="purchase-settle",
                sku="proxycheap:test",
                credit_units=250,
                idempotency_key="proxy-purchase-settle",
                now=210,
            )
            settled = commercial_billing.settle_reservation(
                conn, reservation["id"], now=211
            )
            row = conn.execute(
                "SELECT settled_credit_units, settled_cash_backed_credit_units "
                "FROM billing_reservations WHERE id = ?",
                (reservation["id"],),
            ).fetchone()
        self.assertEqual(settled["status"], "settled")
        self.assertEqual(settled["charged_cash_backed_points"], 2.5)
        self.assertEqual(
            (int(row["settled_credit_units"]), int(row["settled_cash_backed_credit_units"])),
            (250, 250),
        )

    def test_settled_exact_cash_refund_is_idempotent_and_restores_cash_bucket(self):
        with db_module.db() as conn:
            reservation = commercial_billing.reserve_exact_cash_charge(
                conn,
                user_id=self.user_id,
                ref_type="proxy_purchase",
                ref_id="purchase-refund",
                sku="proxycheap:test",
                credit_units=250,
                idempotency_key="proxy-purchase-refund",
                now=230,
            )
            commercial_billing.settle_reservation(conn, reservation["id"], now=231)
            first = commercial_billing.refund_settled_exact_cash_charge(
                conn, reservation["id"], reason="provider terminal failure", now=232
            )
            replay = commercial_billing.refund_settled_exact_cash_charge(
                conn, reservation["id"], reason="duplicate reconciliation", now=233
            )
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                (self.user_id,),
            ).fetchone()
            entries = conn.execute(
                "SELECT COUNT(*) FROM billing_ledger WHERE reservation_id=? "
                "AND event_type='exact_cash_refund'",
                (reservation["id"],),
            ).fetchone()[0]
        self.assertEqual(first["refunded_cash_backed_points"], 2.5)
        self.assertEqual(replay, first)
        self.assertEqual((int(wallet[0]), int(wallet[1])), (700, 500))
        self.assertEqual(int(entries), 1)

    def test_cash_backed_trigger_clamps_direct_total_balance_updates(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET credit_units=100 WHERE user_id=?",
                (self.user_id,),
            )
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                (self.user_id,),
            ).fetchone()
        self.assertEqual((int(wallet[0]), int(wallet[1])), (100, 100))

    def test_historical_paid_pack_backfill_is_audited_idempotent_and_excludes_free_credit(self):
        with db_module.db() as conn:
            conn.execute("DELETE FROM admin_config WHERE key='billing_cash_backed_backfill_v1'")
            conn.execute(
                "UPDATE billing_wallets SET credit_units=700,cash_backed_credit_units=0 WHERE user_id=?",
                (self.user_id,),
            )
            commercial_billing._insert_ledger(
                conn,
                user_id=self.user_id,
                asset_type="credit",
                event_type="credit_pack_approved",
                amount_units=500,
                balance_after_units=700,
                idempotency_key="legacy-paid-pack",
                now=240,
            )
        db_module.init_db()
        db_module.init_db()
        with db_module.db() as conn:
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets WHERE user_id=?",
                (self.user_id,),
            ).fetchone()
            audit_count = conn.execute(
                "SELECT COUNT(*) FROM billing_ledger WHERE idempotency_key=?",
                (f"billing_cash_backed_backfill_v1:{self.user_id}",),
            ).fetchone()[0]
        self.assertEqual((int(wallet[0]), int(wallet[1])), (700, 500))
        self.assertEqual(int(audit_count), 1)

    def test_historical_backfill_does_not_mark_free_balance_after_paid_points_were_spent(self):
        with db_module.db() as conn:
            conn.execute("DELETE FROM admin_config WHERE key='billing_cash_backed_backfill_v1'")
            conn.execute(
                "UPDATE billing_wallets SET credit_units=700,cash_backed_credit_units=0 "
                "WHERE user_id=?",
                (self.user_id,),
            )
            commercial_billing._insert_ledger(
                conn,
                user_id=self.user_id,
                asset_type="credit",
                event_type="admin_adjustment",
                amount_units=700,
                balance_after_units=700,
                idempotency_key="legacy-free-grant-before-pack",
                now=240,
            )
            commercial_billing._insert_ledger(
                conn,
                user_id=self.user_id,
                asset_type="credit",
                event_type="credit_pack_approved",
                amount_units=500,
                balance_after_units=1200,
                idempotency_key="legacy-paid-pack-consumed",
                now=241,
            )
            commercial_billing._insert_ledger(
                conn,
                user_id=self.user_id,
                asset_type="credit",
                event_type="reserve",
                amount_units=-500,
                balance_after_units=700,
                idempotency_key="legacy-paid-points-spent",
                now=242,
            )

        db_module.init_db()
        db_module.init_db()

        with db_module.db() as conn:
            wallet = conn.execute(
                "SELECT credit_units,cash_backed_credit_units FROM billing_wallets "
                "WHERE user_id=?",
                (self.user_id,),
            ).fetchone()
            audit_count = conn.execute(
                "SELECT COUNT(*) FROM billing_ledger WHERE idempotency_key=?",
                (f"billing_cash_backed_backfill_v1:{self.user_id}",),
            ).fetchone()[0]
        self.assertEqual((int(wallet[0]), int(wallet[1])), (700, 0))
        self.assertEqual(int(audit_count), 1)

    def test_paid_credit_pack_credits_entire_pack_as_cash_backed(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET credit_units = 0, cash_backed_credit_units = 0 "
                "WHERE user_id = ?",
                (self.user_id,),
            )
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="credits_530",
                quantity=1,
                idempotency_key="paid-pack-cash-backed",
                now=220,
            )
            commercial_billing.approve_order(
                conn, order["id"], actor_user_id=999, now=221
            )
            wallet = conn.execute(
                "SELECT credit_units, cash_backed_credit_units FROM billing_wallets "
                "WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
        expected = 530 * commercial_billing.POINT_SCALE
        self.assertEqual(
            (int(wallet["credit_units"]), int(wallet["cash_backed_credit_units"])),
            (expected, expected),
        )

    def test_internal_charge_consumes_non_cash_points_first(self):
        with db_module.db() as conn:
            reservation = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="task",
                ref_id="internal-task",
                sku="basic_text_post",
                quantity=10,
                idempotency_key="internal-task-charge",
                now=300,
            )
            wallet = conn.execute(
                "SELECT credit_units, cash_backed_credit_units FROM billing_wallets "
                "WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()

        self.assertEqual(reservation["reserved_points"], 3.0)
        self.assertEqual(reservation["reserved_cash_backed_points"], 1.0)
        self.assertEqual((int(wallet["credit_units"]), int(wallet["cash_backed_credit_units"])), (400, 400))

    def test_schema_contains_purchase_state_and_owned_asset_columns(self):
        with db_module.db() as conn:
            tables = {
                str(row["name"])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            item_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(proxy_market_items)").fetchall()
            }
            order_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(proxy_purchase_orders)").fetchall()
            }
            renewal_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(proxy_renewal_schedules)").fetchall()
            }
            event_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(proxy_purchase_events)").fetchall()
            }
        self.assertTrue(
            {
                "proxy_purchase_config_versions",
                "proxy_purchase_quotes",
                "proxy_purchase_orders",
                "proxy_purchase_events",
                "proxy_renewal_schedules",
            }.issubset(tables)
        )
        self.assertTrue(
            {
                "ownership_type",
                "owner_user_id",
                "provider_purchase_order_id",
                "provider_proxy_id",
            }.issubset(item_columns)
        )
        self.assertTrue(
            {"next_attempt_at", "reconcile_attempts", "client_reference"}.issubset(order_columns)
        )
        self.assertTrue(
            {
                "reservation_id", "lease_token", "lease_expires_at",
                "provider_started_at", "baseline_expires_at",
            }.issubset(renewal_columns)
        )
        self.assertTrue(
            {"processing_status", "attempt_count", "next_attempt_at", "last_error"}.issubset(event_columns)
        )

    def test_server_registers_proxy_purchase_governance_audit_callback(self):
        server_source = (
            Path(__file__).resolve().parents[1] / "server.py"
        ).read_text(encoding="utf-8")
        registration = server_source.split("register_proxy_purchase_routes(", 1)[1].split(")", 1)[0]
        self.assertIn("audit_callback=governance.record_audit", registration)


if __name__ == "__main__":
    unittest.main()
