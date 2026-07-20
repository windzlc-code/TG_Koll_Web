import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

from webapp import commercial_billing
from webapp import db as db_module


LEGACY_R18_ACTION_SKUS = {
    "oral_video_second",
    "ad_video_480p_second",
    "ad_video_720p_second",
    "ad_video_1080p_second",
    "ad_video_2k_second",
    "ad_video_4k_second",
}


class CommercialBillingTests(unittest.TestCase):
    def setUp(self):
        self.old_db_path = os.environ.get("APP_DB_PATH")
        self.old_billing_enabled = os.environ.get("COMMERCIAL_BILLING_ENABLED")
        self.old_migrate_legacy = os.environ.get("COMMERCIAL_BILLING_MIGRATE_LEGACY")
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        os.environ["COMMERCIAL_BILLING_ENABLED"] = "1"
        os.environ.pop("COMMERCIAL_BILLING_MIGRATE_LEGACY", None)
        db_module.init_db()
        with db_module.db() as conn:
            customer = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES ('billing_customer', 'hash', 0, 0, 0, 100, 100)"
            )
            admin = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES ('billing_admin', 'hash', 1, 0, 0, 100, 100)"
            )
            self.user_id = int(customer.lastrowid)
            self.admin_id = int(admin.lastrowid)
            conn.execute(
                "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, 0, 'enforced', 0, 100, 100)",
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
        if self.old_migrate_legacy is None:
            os.environ.pop("COMMERCIAL_BILLING_MIGRATE_LEGACY", None)
        else:
            os.environ["COMMERCIAL_BILLING_MIGRATE_LEGACY"] = self.old_migrate_legacy
        self.tmpdir.cleanup()

    def _approve_subscription(self, *, now=1_700_000_000):
        with db_module.db() as conn:
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_monthly",
                quantity=1,
                idempotency_key=f"subscription-{now}",
                now=now,
            )
            return commercial_billing.approve_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                now=now,
            )

    def _approve_credit_pack(self, sku="credits_100", *, now=1_700_000_001):
        with db_module.db() as conn:
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku=sku,
                quantity=1,
                idempotency_key=f"pack-{sku}-{now}",
                now=now,
            )
            commercial_billing.approve_order(conn, order["id"], actor_user_id=self.admin_id, now=now)
            commercial_billing.approve_order(conn, order["id"], actor_user_id=self.admin_id, now=now + 1)

    def test_catalog_is_seeded_once_with_all_public_prices(self):
        db_module.init_db()
        with db_module.db() as conn:
            catalog = commercial_billing.get_active_catalog(conn)
            versions = commercial_billing.list_catalog_versions(conn)
        self.assertEqual(catalog["subscription"]["price_ntd"], 6000)
        self.assertEqual([item["total_points"] for item in catalog["packages"]], [100, 530, 1620])
        self.assertEqual(len(catalog["actions"]), 6)
        actions = {item["sku"]: item for item in catalog["actions"]}
        self.assertTrue(LEGACY_R18_ACTION_SKUS.isdisjoint(actions))
        self.assertEqual(actions["instagram_publish"]["points"], 0.1)
        self.assertEqual(actions["social_interaction"]["points"], 0.1)
        self.assertEqual(len([item for item in versions if item["status"] == "active"]), 1)

    def test_existing_active_catalog_adds_current_actions_and_removes_legacy_r18_actions(self):
        with db_module.db() as conn:
            active = conn.execute(
                "SELECT id, version_number, catalog_json FROM billing_catalog_versions WHERE status = 'active'"
            ).fetchone()
            catalog = json.loads(str(active["catalog_json"]))
            catalog["actions"] = [
                item
                for item in catalog["actions"]
                if item["sku"] not in {"instagram_publish", "social_interaction"}
            ]
            catalog["actions"].extend(
                [
                    {
                        "sku": sku,
                        "name": f"legacy {sku}",
                        "points": 1,
                        "unit": "次",
                        "implemented": True,
                    }
                    for sku in sorted(LEGACY_R18_ACTION_SKUS)
                ]
            )
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (json.dumps(catalog, ensure_ascii=False), str(active["id"])),
            )
            conn.execute("DELETE FROM admin_config WHERE key = 'commercial_billing_catalog_v2'")
            conn.execute("DELETE FROM admin_config WHERE key = 'commercial_billing_catalog_v3'")
            commercial_billing.bootstrap_billing(conn, now=1_700_000_000)
            upgraded = commercial_billing.get_active_catalog(conn)
            versions = commercial_billing.list_catalog_versions(conn)

        actions = {item["sku"]: item for item in upgraded["actions"]}
        self.assertGreater(int(upgraded["version"]), int(active["version_number"]))
        self.assertTrue(LEGACY_R18_ACTION_SKUS.isdisjoint(actions))
        self.assertIn("instagram_publish", actions)
        self.assertIn("social_interaction", actions)
        self.assertEqual(len([item for item in versions if item["status"] == "active"]), 1)

    def test_unlimited_compute_keeps_subscription_gate_but_never_deducts_points(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            result = commercial_billing.set_unlimited_compute(
                conn,
                user_id=self.user_id,
                enabled=True,
                actor_user_id=self.admin_id,
                reason="enterprise unlimited plan",
                now=now,
            )
            self.assertTrue(result["unlimited_compute"])
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="normal_task",
                    ref_id="unlimited-without-subscription",
                    sku="basic_text_post",
                    quantity=1,
                    now=now,
                )
            self.assertEqual(raised.exception.code, "SUBSCRIPTION_REQUIRED")

        self._approve_subscription(now=now)
        with db_module.db() as conn:
            before = commercial_billing.billing_summary(conn, self.user_id, now=now)
            held = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="unlimited-billable-task",
                sku="basic_text_post",
                quantity=3,
                now=now,
            )
            settled = commercial_billing.settle_reservation(
                conn,
                held["id"],
                actual_quantity=2,
                now=now,
            )
            after = commercial_billing.billing_summary(conn, self.user_id, now=now)
            entries = commercial_billing.list_ledger(conn, user_id=self.user_id)

        self.assertEqual(held["status"], "held")
        self.assertTrue(held["unlimited_compute"])
        self.assertEqual(settled["status"], "settled")
        self.assertEqual(settled["charged_points"], 0)
        self.assertEqual(before["points"], after["points"])
        self.assertTrue(after["unlimited_compute"])
        self.assertTrue(any(entry["event_type"] == "unlimited_compute_settled" for entry in entries))

    def test_disabling_unlimited_compute_restores_normal_balance_checks(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        with db_module.db() as conn:
            commercial_billing.set_unlimited_compute(
                conn,
                user_id=self.user_id,
                enabled=True,
                actor_user_id=self.admin_id,
                reason="temporary unlimited",
                now=now,
            )
            commercial_billing.set_unlimited_compute(
                conn,
                user_id=self.user_id,
                enabled=False,
                actor_user_id=self.admin_id,
                reason="return to metered billing",
                now=now + 1,
            )
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="normal_task",
                    ref_id="metered-again",
                    sku="basic_text_post",
                    quantity=1,
                    now=now + 1,
                )
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 1)

        self.assertEqual(raised.exception.code, "INSUFFICIENT_POINTS")
        self.assertFalse(summary["unlimited_compute"])

    def test_production_migration_enforces_legacy_wallets_with_transition_subscription(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            inserted = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) "
                "VALUES ('legacy_transition', 'hash', 0, 0, 12, ?, ?)",
                (now, now),
            )
            legacy_user_id = int(inserted.lastrowid)
            conn.execute(
                "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) "
                "VALUES (?, 1200, 'legacy', 12, ?, ?)",
                (legacy_user_id, now, now),
            )
        os.environ["COMMERCIAL_BILLING_MIGRATE_LEGACY"] = "1"
        with db_module.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            commercial_billing.bootstrap_billing(conn, now=now)
            summary = commercial_billing.billing_summary(conn, legacy_user_id, now=now)
            marker = conn.execute(
                "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_enforcement_v2'"
            ).fetchone()

        self.assertEqual(summary["billing_mode"], "enforced")
        self.assertTrue(summary["subscription_active"])
        self.assertEqual(summary["points"], 12)
        self.assertEqual(summary["threads_account_limit"], 3)
        self.assertIsNotNone(marker)

    def test_subscription_approval_enables_enforcement_and_monthly_images(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        with db_module.db() as conn:
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now)
        self.assertEqual(summary["billing_mode"], "enforced")
        self.assertTrue(summary["subscription_active"])
        self.assertEqual(summary["threads_account_limit"], 3)
        self.assertEqual(summary["free_images"]["monthly_remaining"], 10)

    def test_credit_pack_approval_is_idempotent(self):
        self._approve_credit_pack("credits_530")
        with db_module.db() as conn:
            summary = commercial_billing.billing_summary(conn, self.user_id)
            entries = commercial_billing.list_ledger(conn, user_id=self.user_id)
        self.assertEqual(summary["points"], 530)
        self.assertEqual(len([entry for entry in entries if entry["event_type"] == "credit_pack_approved"]), 1)

    def test_order_idempotency_key_is_bound_to_immutable_request_fields(self):
        request = {
            "user_id": self.user_id,
            "sku": "credits_100",
            "quantity": 1,
            "idempotency_key": "immutable-order-request",
            "renewal_subscription_ids": [],
            "payer_name": "Test Payer",
            "payment_reference": "PAY-100",
            "paid_at": 1_700_000_000,
            "note": "first payment",
            "proof_path": "/proofs/payment-100.png",
        }
        variants = {
            "sku": "credits_530",
            "quantity": 2,
            "renewal_subscription_ids": ["different-subscription"],
            "payer_name": "Different Payer",
            "payment_reference": "PAY-101",
            "paid_at": 1_700_000_001,
            "note": "different note",
            "proof_path": "/proofs/payment-101.png",
        }

        with db_module.db() as conn:
            original = commercial_billing.create_order(conn, **request, now=1_700_000_010)
            replay = commercial_billing.create_order(conn, **request, now=1_700_000_020)
            self.assertEqual(replay, original)

            for field, different_value in variants.items():
                with self.subTest(field=field):
                    conflicting_request = dict(request)
                    conflicting_request[field] = different_value
                    with self.assertRaises(commercial_billing.BillingError) as raised:
                        commercial_billing.create_order(
                            conn,
                            **conflicting_request,
                            now=1_700_000_030,
                        )
                    self.assertEqual(raised.exception.code, "ORDER_IDEMPOTENCY_CONFLICT")
                    self.assertEqual(raised.exception.status_code, 409)

            order_count = conn.execute(
                "SELECT COUNT(*) AS c FROM billing_orders WHERE user_id = ? AND idempotency_key = ?",
                (self.user_id, request["idempotency_key"]),
            ).fetchone()
        self.assertEqual(int(order_count["c"]), 1)

    def test_list_orders_supports_stable_offset_pagination(self):
        created_ids = []
        with db_module.db() as conn:
            for index in range(3):
                order = commercial_billing.create_order(
                    conn,
                    user_id=self.user_id,
                    sku="credits_100",
                    quantity=1,
                    idempotency_key=f"pagination-order-{index}",
                    now=1_700_000_100 + index,
                )
                created_ids.append(order["id"])

            first_page = commercial_billing.list_orders(
                conn,
                user_id=self.user_id,
                status="pending",
                limit=1,
                offset=0,
            )
            second_page = commercial_billing.list_orders(
                conn,
                user_id=self.user_id,
                status="pending",
                limit=1,
                offset=1,
            )

        self.assertEqual([item["id"] for item in first_page], [created_ids[2]])
        self.assertEqual([item["id"] for item in second_page], [created_ids[1]])

    def test_concurrent_order_approval_credits_wallet_once(self):
        now = 1_700_000_100
        with db_module.db() as conn:
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="credits_530",
                quantity=1,
                idempotency_key="concurrent-order-approval",
                now=now,
            )

        barrier = threading.Barrier(2)
        results: list[dict] = []
        errors: list[Exception] = []

        def approve_once():
            try:
                barrier.wait(timeout=5)
                with db_module.db() as conn:
                    results.append(
                        commercial_billing.approve_order(
                            conn,
                            order["id"],
                            actor_user_id=self.admin_id,
                            now=now + 1,
                        )
                    )
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        workers = [threading.Thread(target=approve_once) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertEqual(errors, [])
        self.assertEqual([item["status"] for item in results], ["approved", "approved"])
        with db_module.db() as conn:
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 2)
            entries = conn.execute(
                "SELECT COUNT(*) AS c FROM billing_ledger WHERE ref_id = ? AND event_type = 'credit_pack_approved'",
                (order["id"],),
            ).fetchone()
        self.assertEqual(summary["points"], 530)
        self.assertEqual(int(entries["c"]), 1)

    def test_admin_managed_charge_is_waived_and_audited(self):
        now = 1_700_000_200
        with db_module.db() as conn:
            reservation = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="social_task",
                ref_id="admin-managed-publish",
                sku="threads_text_publish",
                quantity=1,
                admin_waived=True,
                now=now,
            )
            entries = commercial_billing.list_ledger(conn, user_id=self.user_id)
        self.assertEqual(reservation["status"], "waived")
        self.assertEqual(reservation["charged_points"], 0)
        self.assertEqual(len([entry for entry in entries if entry["event_type"] == "admin_waived"]), 1)

    def test_reserve_settle_and_release_are_idempotent(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        self._approve_credit_pack(now=now + 1)
        with db_module.db() as conn:
            held = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="post-task-1",
                sku="basic_text_post",
                quantity=3,
                now=now + 2,
            )
            self.assertEqual(held["reserved_points"], 0.9)
            settled = commercial_billing.settle_reservation(conn, held["id"], actual_quantity=2, now=now + 3)
            settled_again = commercial_billing.settle_reservation(conn, held["id"], actual_quantity=2, now=now + 4)
            self.assertEqual(settled, settled_again)
            self.assertEqual(settled["charged_points"], 0.6)
            releasable = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="post-task-2",
                sku="basic_text_post",
                quantity=1,
                now=now + 5,
            )
            released = commercial_billing.release_reservation(conn, releasable["id"], now=now + 6)
            released_again = commercial_billing.release_reservation(conn, releasable["id"], now=now + 7)
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 7)
        self.assertEqual(released, released_again)
        self.assertEqual(released["status"], "released")
        self.assertEqual(summary["points"], 99.4)

    def test_image_reservation_consumes_expiring_grant_then_points(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        self._approve_credit_pack(now=now + 1)
        with db_module.db() as conn:
            held = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="image-task",
                sku="ai_image",
                quantity=12,
                image=True,
                now=now + 2,
            )
            self.assertEqual(held["reserved_images"], 10)
            self.assertEqual(held["reserved_points"], 1.2)
            settled = commercial_billing.settle_reservation(conn, held["id"], actual_quantity=11, now=now + 3)
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 3)
        self.assertEqual(settled["free_images_used"], 10)
        self.assertEqual(settled["charged_points"], 0.6)
        self.assertEqual(summary["points"], 99.4)
        self.assertEqual(summary["free_images"]["monthly_remaining"], 0)

    def test_insufficient_points_rolls_back_free_image_holds(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        with self.assertRaises(commercial_billing.BillingError) as raised:
            with db_module.db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="normal_task",
                    ref_id="oversized-image-task",
                    sku="ai_image",
                    quantity=11,
                    image=True,
                    now=now + 1,
                )
        self.assertEqual(raised.exception.code, "INSUFFICIENT_POINTS")
        with db_module.db() as conn:
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 1)
        self.assertEqual(summary["free_images"]["monthly_remaining"], 10)

    def test_calendar_month_clamps_month_end_in_taipei(self):
        start = int(datetime(2024, 1, 31, 12, tzinfo=timezone.utc).timestamp())
        end = commercial_billing.add_calendar_month(start)
        end_dt = datetime.fromtimestamp(end, timezone.utc)
        self.assertEqual((end_dt.year, end_dt.month, end_dt.day), (2024, 2, 29))

    def test_batch_reservations_are_independent_and_claimable(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        self._approve_credit_pack(now=now + 1)
        with db_module.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            reservations = [
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="social_task",
                    ref_id=f"social-task-{index}",
                    sku="threads_text_publish",
                    quantity=1,
                    now=now + 2,
                )
                for index in range(3)
            ]
            claimed = commercial_billing.claim_reservation(
                conn,
                reservation_id=reservations[1]["id"],
                user_id=self.user_id,
                ref_type="social_task",
                ref_id="social-task-1",
                sku="threads_text_publish",
            )
        self.assertEqual(claimed["status"], "held")
        self.assertEqual(claimed["reserved_points"], 0.1)
        self.assertEqual(len({item["id"] for item in reservations}), 3)

    def test_early_renewal_quantity_extends_one_subscription_month_by_month(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        with db_module.db() as conn:
            subscription = conn.execute(
                "SELECT id, current_period_end FROM billing_subscriptions WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            first_end = int(subscription["current_period_end"])
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_monthly",
                quantity=2,
                renewal_subscription_ids=[str(subscription["id"])],
                idempotency_key="renew-one-subscription-two-months",
                now=now + 100,
            )
            commercial_billing.approve_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                now=now + 100,
            )
            renewed = conn.execute(
                "SELECT current_period_end FROM billing_subscriptions WHERE id = ?",
                (str(subscription["id"]),),
            ).fetchone()
            periods = conn.execute(
                "SELECT start_at, end_at FROM billing_subscription_periods WHERE subscription_id = ? ORDER BY start_at",
                (str(subscription["id"]),),
            ).fetchall()
        self.assertEqual(len(periods), 3)
        self.assertEqual(int(periods[1]["start_at"]), first_end)
        self.assertEqual(int(periods[2]["start_at"]), int(periods[1]["end_at"]))
        self.assertEqual(int(renewed["current_period_end"]), int(periods[2]["end_at"]))

    def test_concurrent_release_refunds_only_once(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        self._approve_credit_pack(now=now + 1)
        with db_module.db() as conn:
            held = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="concurrent-release",
                sku="basic_text_post",
                quantity=1,
                now=now + 2,
            )

        errors: list[Exception] = []

        def release_once():
            try:
                with db_module.db() as conn:
                    commercial_billing.release_reservation(conn, held["id"], now=now + 3)
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        workers = [threading.Thread(target=release_once) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertEqual(errors, [])
        with db_module.db() as conn:
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 4)
            release_entries = conn.execute(
                "SELECT COUNT(*) AS c FROM billing_ledger WHERE reservation_id = ? AND event_type = 'release'",
                (held["id"],),
            ).fetchone()
        self.assertEqual(summary["points"], 100)
        self.assertEqual(int(release_entries["c"]), 1)

    def test_legacy_balance_migration_reports_negative_accounts_for_review(self):
        with db_module.db() as conn:
            conn.execute("DELETE FROM admin_config WHERE key = 'commercial_billing_migration_v1'")
            positive = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES ('legacy_positive', 'hash', 0, 0, 7, 100, 100)"
            )
            negative = conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES ('legacy_negative', 'hash', 0, 0, -2, 100, 100)"
            )
            commercial_billing.bootstrap_billing(conn, now=200)
            positive_wallet = conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                (int(positive.lastrowid),),
            ).fetchone()
            report = commercial_billing.migration_report(conn)
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.ensure_wallet(conn, int(negative.lastrowid), now=201)
        self.assertEqual(int(positive_wallet["credit_units"]), 700)
        self.assertEqual(raised.exception.code, "MIGRATION_REVIEW_REQUIRED")
        self.assertEqual(report["counts"]["review_required"], 1)

    def test_pending_order_keeps_its_original_catalog_snapshot(self):
        with db_module.db() as conn:
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="credits_100",
                quantity=1,
                idempotency_key="catalog-snapshot-order",
                now=300,
            )
            draft = commercial_billing.create_catalog_draft(
                conn,
                actor_user_id=self.admin_id,
                now=301,
            )
            catalog = dict(draft["catalog"])
            catalog["packages"] = [dict(item) for item in catalog["packages"]]
            catalog["packages"][0]["price_ntd"] = 1200
            commercial_billing.update_catalog_draft(
                conn,
                draft["id"],
                catalog,
                actor_user_id=self.admin_id,
            )
            commercial_billing.publish_catalog(conn, draft["id"], actor_user_id=self.admin_id, now=302)
            approved = commercial_billing.approve_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                now=303,
            )
        self.assertEqual(approved["amount_ntd_cents"], 100000)
        self.assertEqual(approved["price_snapshot"]["item"]["price_ntd"], 1000)


if __name__ == "__main__":
    unittest.main()
