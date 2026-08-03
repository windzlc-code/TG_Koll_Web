import json
import os
import sqlite3
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
                sku="vanguard_enterprise_quarterly",
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

    def _approve_credit_pack(self, sku="credits_200", *, now=1_700_000_001):
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

    def test_new_user_welcome_credit_is_idempotent(self):
        with db_module.db() as conn:
            first = commercial_billing.initialize_new_user_wallet(
                conn,
                user_id=self.user_id,
                source="test_registration",
                now=200,
            )
            second = commercial_billing.initialize_new_user_wallet(
                conn,
                user_id=self.user_id,
                source="test_registration",
                now=201,
            )
            entries = conn.execute(
                "SELECT COUNT(*) AS count FROM billing_ledger WHERE idempotency_key = ?",
                (f"welcome-credit-v1:{self.user_id}",),
            ).fetchone()
        self.assertEqual(first["credit_units"], 5 * commercial_billing.POINT_SCALE)
        self.assertEqual(second["credit_units"], 5 * commercial_billing.POINT_SCALE)
        self.assertEqual(int(entries["count"]), 1)

    def test_billing_enforcement_defaults_to_enabled_and_blocks_zero_point_wallets(self):
        os.environ.pop("COMMERCIAL_BILLING_ENABLED", None)
        with db_module.db() as conn:
            self.assertTrue(commercial_billing.enforcement_enabled())
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="normal_task",
                    ref_id="default-enforcement",
                    sku="basic_text_post",
                    quantity=1,
                    now=300,
                )
        self.assertEqual(raised.exception.code, "INSUFFICIENT_POINTS")

    def test_legacy_wallets_are_not_waived_when_billing_is_enabled(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET billing_mode = 'legacy', credit_units = 0 WHERE user_id = ?",
                (self.user_id,),
            )
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type="normal_task",
                    ref_id="legacy-enforcement",
                    sku="basic_text_post",
                    quantity=1,
                    now=301,
                )
        self.assertEqual(raised.exception.code, "INSUFFICIENT_POINTS")

    def test_catalog_is_seeded_once_with_all_public_prices(self):
        db_module.init_db()
        with db_module.db() as conn:
            catalog = commercial_billing.get_active_catalog(conn)
            versions = commercial_billing.list_catalog_versions(conn)
        subscriptions = {item["sku"]: item for item in catalog["subscriptions"]}
        self.assertEqual(
            {
                sku: (item["price_ntd"], item["period_months"], item["threads_accounts"])
                for sku, item in subscriptions.items()
            },
            {
                "vanguard_personal_quarterly": (6000, 3, 1),
                "vanguard_personal_half_year": (12000, 6, 1),
                "vanguard_personal_annual": (24000, 12, 1),
                "vanguard_enterprise_quarterly": (18000, 3, 3),
                "vanguard_enterprise_half_year": (36000, 6, 3),
                "vanguard_enterprise_annual": (72000, 12, 3),
            },
        )
        self.assertTrue(all(item["monthly_free_images"] == 10 for item in subscriptions.values()))
        self.assertEqual([item["total_points"] for item in catalog["packages"]], [200, 530, 1620])
        self.assertEqual([item["price_ntd"] for item in catalog["packages"]], [2000, 5000, 15000])
        actions = {item["sku"]: item for item in catalog["actions"]}
        self.assertEqual(actions["threads_text_publish"]["points"], 0)
        self.assertEqual(actions["instagram_text_publish"]["points"], 0)
        self.assertEqual(actions["complete_image_post"]["points"], 2.5)
        self.assertEqual(actions["ai_image"]["points"], 2)
        self.assertEqual(actions["oral_video_second"]["points"], 0.5)
        self.assertEqual(actions["threads_auto_reply_batch"]["points"], 5)
        self.assertEqual(actions["seedance_fast_1080p_second"]["points"], 7.5)
        self.assertEqual(actions["seedance_4k_second"]["points"], 11)
        automation_modules = catalog["automation_modules"]
        self.assertEqual(
            [item["key"] for item in automation_modules],
            ["social_warmup", "auto_reply_comments", "auto_reply_hot_posts"],
        )
        self.assertEqual(automation_modules[0]["billing_mode"], "free")
        self.assertEqual(automation_modules[0]["action_sku"], "")
        self.assertEqual(automation_modules[1]["reply_scope"], "comments")
        self.assertEqual(automation_modules[2]["reply_scope"], "hot_posts")
        self.assertEqual(
            {item["action_sku"] for item in automation_modules[1:]},
            {"threads_auto_reply_batch"},
        )
        self.assertEqual(len([item for item in versions if item["status"] == "active"]), 1)

    def test_subscription_entitlements_match_the_complete_pdf_catalog(self):
        plans = {item["sku"]: item for item in commercial_billing.DEFAULT_CATALOG["subscriptions"]}
        personal = plans["vanguard_personal_quarterly"]
        enterprise = plans["vanguard_enterprise_quarterly"]
        self.assertEqual(len(personal["features"]), 5)
        self.assertEqual(len(enterprise["features"]), 5)
        self.assertTrue(any("1 个" in item and "IG / Threads" in item for item in personal["features"]))
        self.assertTrue(any("3 个" in item and "IG / Threads" in item for item in enterprise["features"]))
        self.assertTrue(any("每月 10 张" in item for item in personal["features"]))
        self.assertTrue(any("每月 10 张" in item for item in enterprise["features"]))
        self.assertTrue(any("单账号排程" in item for item in personal["features"]))
        self.assertTrue(any("三账号排程" in item for item in enterprise["features"]))
        self.assertTrue(any("单账号沙箱风控" in item for item in personal["features"]))
        self.assertTrue(any("多账号分流防封" in item for item in enterprise["features"]))
        self.assertIn("自由创作者", personal["audience"])
        self.assertIn("中小企业", enterprise["audience"])
        self.assertIn("乾货", personal["account_positioning"])
        self.assertIn("投放账号", enterprise["account_positioning"])
        self.assertEqual(
            [item["key"] for item in commercial_billing.DEFAULT_CATALOG["billing_rules"]],
            [
                "free_image_priority",
                "shared_compute_pool",
                "permanent_compute_points",
                "separate_payment_flows",
                "site_build_excluded",
            ],
        )

    def test_pdf_price_catalog_accepts_free_actions_and_rejects_negative_points(self):
        catalog = json.loads(json.dumps(commercial_billing.DEFAULT_CATALOG))
        commercial_billing.validate_catalog(catalog)
        catalog["actions"][0]["points"] = -0.01
        with self.assertRaises(commercial_billing.BillingError) as raised:
            commercial_billing.validate_catalog(catalog)
        self.assertEqual(raised.exception.code, "INVALID_CATALOG")

    def test_catalog_rejects_monthly_price_that_does_not_match_term_total(self):
        catalog = json.loads(json.dumps(commercial_billing.DEFAULT_CATALOG))
        catalog["subscriptions"][0]["monthly_price_ntd"] = 1999
        with self.assertRaises(commercial_billing.BillingError) as raised:
            commercial_billing.validate_catalog(catalog)
        self.assertEqual(raised.exception.code, "INVALID_CATALOG")

    def test_catalog_rejects_non_shanghai_business_timezone(self):
        catalog = json.loads(json.dumps(commercial_billing.DEFAULT_CATALOG))
        catalog["timezone"] = "Asia/Taipei"
        with self.assertRaises(commercial_billing.BillingError) as raised:
            commercial_billing.validate_catalog(catalog)
        self.assertEqual(raised.exception.code, "INVALID_CATALOG")

    def test_catalog_rejects_incomplete_automation_module_mapping(self):
        catalog = json.loads(json.dumps(commercial_billing.DEFAULT_CATALOG))
        catalog["automation_modules"][1]["action_sku"] = "missing_action_sku"
        with self.assertRaises(commercial_billing.BillingError) as raised:
            commercial_billing.validate_catalog(catalog)
        self.assertEqual(raised.exception.code, "INVALID_CATALOG")

        catalog = json.loads(json.dumps(commercial_billing.DEFAULT_CATALOG))
        catalog["automation_modules"] = catalog["automation_modules"][:2]
        with self.assertRaises(commercial_billing.BillingError) as raised:
            commercial_billing.validate_catalog(catalog)
        self.assertEqual(raised.exception.code, "INVALID_CATALOG")

    def test_quarterly_subscription_approval_creates_three_monthly_image_grants(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        with db_module.db() as conn:
            periods = conn.execute(
                "SELECT start_at, end_at FROM billing_subscription_periods WHERE user_id = ?",
                (self.user_id,),
            ).fetchall()
            grants = conn.execute(
                "SELECT available_at, expires_at, total_count FROM billing_image_grants "
                "WHERE user_id = ? AND source_type = 'subscription_monthly' ORDER BY available_at",
                (self.user_id,),
            ).fetchall()
        self.assertEqual(len(periods), 3)
        self.assertEqual(len(grants), 3)
        self.assertEqual([int(row["total_count"]) for row in grants], [10, 10, 10])
        expected_end = now
        for _ in range(3):
            expected_end = commercial_billing.add_calendar_month(expected_end)
        self.assertEqual(int(periods[-1]["end_at"]), expected_end)

    def test_existing_active_catalog_is_replaced_by_official_pdf_catalog_v4(self):
        with db_module.db() as conn:
            active = conn.execute(
                "SELECT id, version_number, catalog_json FROM billing_catalog_versions WHERE status = 'active'"
            ).fetchone()
            catalog = json.loads(str(active["catalog_json"]))
            catalog.pop("subscriptions", None)
            catalog["subscription"] = {**catalog["subscription"], "sku": "vanguard_monthly", "price_ntd": 6000, "period_months": 1}
            catalog["packages"][0] = {"sku": "credits_100", "name": "旧储值包", "price_ntd": 1000, "paid_points": 100, "bonus_points": 0, "total_points": 100, "bonus_images": 0}
            catalog["actions"] = [{"sku": "threads_text_publish", "name": "旧发布价格", "points": 0.1, "unit": "次", "implemented": True}]
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (json.dumps(catalog, ensure_ascii=False), str(active["id"])),
            )
            conn.execute("DELETE FROM admin_config WHERE key IN ('commercial_billing_catalog_v2', 'commercial_billing_catalog_v3', 'commercial_billing_catalog_v4')")
            commercial_billing.bootstrap_billing(conn, now=1_700_000_000)
            upgraded = commercial_billing.get_active_catalog(conn)
            versions = commercial_billing.list_catalog_versions(conn)

        actions = {item["sku"]: item for item in upgraded["actions"]}
        self.assertGreater(int(upgraded["version"]), int(active["version_number"]))
        self.assertEqual(actions["threads_text_publish"]["points"], 0)
        self.assertEqual(upgraded["packages"][0]["sku"], "credits_200")
        self.assertEqual(len(upgraded["subscriptions"]), 6)
        self.assertEqual(len([item for item in versions if item["status"] == "active"]), 1)

    def test_catalog_timezone_migrates_to_shanghai_without_resetting_prices(self):
        with db_module.db() as conn:
            active = conn.execute(
                "SELECT id, version_number, catalog_json FROM billing_catalog_versions WHERE status = 'active'"
            ).fetchone()
            catalog = json.loads(str(active["catalog_json"]))
            catalog["timezone"] = "Asia/Taipei"
            catalog["packages"][0]["name"] = "管理员自定义标准储值包"
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (json.dumps(catalog, ensure_ascii=False), str(active["id"])),
            )
            conn.execute(
                "DELETE FROM admin_config WHERE key = 'commercial_billing_catalog_v5_timezone_shanghai'"
            )
            commercial_billing.bootstrap_billing(conn, now=1_700_000_100)
            upgraded = commercial_billing.get_active_catalog(conn)

        self.assertEqual(commercial_billing.DEFAULT_CATALOG["timezone"], "Asia/Shanghai")
        self.assertEqual(upgraded["timezone"], "Asia/Shanghai")
        self.assertEqual(upgraded["packages"][0]["name"], "管理员自定义标准储值包")
        self.assertGreater(int(upgraded["version"]), int(active["version_number"]))

    def test_catalog_automation_modules_migrate_without_resetting_admin_prices(self):
        with db_module.db() as conn:
            active = conn.execute(
                "SELECT id, version_number, catalog_json FROM billing_catalog_versions WHERE status = 'active'"
            ).fetchone()
            catalog = json.loads(str(active["catalog_json"]))
            catalog.pop("automation_modules", None)
            catalog["packages"][0]["price_ntd"] = 2100
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (json.dumps(catalog, ensure_ascii=False), str(active["id"])),
            )
            conn.execute(
                "DELETE FROM admin_config WHERE key = 'commercial_billing_catalog_v6_automation_modules'"
            )
            commercial_billing.bootstrap_billing(conn, now=1_700_000_200)
            upgraded = commercial_billing.get_active_catalog(conn)

        self.assertEqual(upgraded["packages"][0]["price_ntd"], 2100)
        self.assertEqual(
            [item["key"] for item in upgraded["automation_modules"]],
            ["social_warmup", "auto_reply_comments", "auto_reply_hot_posts"],
        )
        self.assertGreater(int(upgraded["version"]), int(active["version_number"]))

    def test_complete_subscription_details_migrate_without_resetting_admin_prices(self):
        with db_module.db() as conn:
            active = conn.execute(
                "SELECT id, version_number, catalog_json FROM billing_catalog_versions WHERE status = 'active'"
            ).fetchone()
            catalog = json.loads(str(active["catalog_json"]))
            catalog["subscriptions"][0]["price_ntd"] = 6300
            catalog["subscriptions"][0]["monthly_price_ntd"] = 2100
            catalog["subscriptions"][0]["features"] = ["旧版简略权益"]
            if str(catalog["subscription"].get("sku") or "") == str(catalog["subscriptions"][0].get("sku") or ""):
                catalog["subscription"] = dict(catalog["subscriptions"][0])
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (json.dumps(catalog, ensure_ascii=False), str(active["id"])),
            )
            conn.execute(
                "DELETE FROM admin_config WHERE key = 'commercial_billing_catalog_v7_complete_subscription_details'"
            )
            commercial_billing.bootstrap_billing(conn, now=1_700_000_300)
            upgraded = commercial_billing.get_active_catalog(conn)

        upgraded_plan = next(
            item for item in upgraded["subscriptions"] if item["sku"] == "vanguard_personal_quarterly"
        )
        self.assertEqual(upgraded_plan["price_ntd"], 6300)
        self.assertEqual(upgraded_plan["monthly_price_ntd"], 2100)
        self.assertEqual(len(upgraded_plan["features"]), 5)
        self.assertGreater(int(upgraded["version"]), int(active["version_number"]))

    def test_video_workbench_actions_migrate_without_resetting_admin_prices(self):
        with db_module.db() as conn:
            active = conn.execute(
                "SELECT id, version_number, catalog_json FROM billing_catalog_versions WHERE status = 'active'"
            ).fetchone()
            catalog = json.loads(str(active["catalog_json"]))
            actions = [
                item
                for item in catalog["actions"]
                if item.get("sku") not in commercial_billing.VIDEO_ACTION_SKUS
            ]
            oral_video = next(
                item for item in commercial_billing.DEFAULT_CATALOG["actions"] if item.get("sku") == "oral_video_second"
            )
            actions.append({**oral_video, "points": 0.77, "implemented": False})
            catalog["actions"] = actions
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (json.dumps(catalog, ensure_ascii=False), str(active["id"])),
            )
            conn.execute(
                "DELETE FROM admin_config WHERE key = 'commercial_billing_catalog_v8_video_workbench'"
            )
            commercial_billing.bootstrap_billing(conn, now=1_700_000_400)
            upgraded = commercial_billing.get_active_catalog(conn)

        upgraded_actions = {item["sku"]: item for item in upgraded["actions"]}
        self.assertTrue(commercial_billing.VIDEO_ACTION_SKUS.issubset(upgraded_actions))
        self.assertEqual(upgraded_actions["oral_video_second"]["points"], 0.77)
        self.assertTrue(upgraded_actions["oral_video_second"]["implemented"])
        self.assertGreater(int(upgraded["version"]), int(active["version_number"]))

    def test_unlimited_compute_never_requires_subscription_or_deducts_points(self):
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
            without_subscription = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="unlimited-without-subscription",
                sku="basic_text_post",
                quantity=1,
                now=now,
            )
            self.assertEqual(without_subscription["status"], "held")
            self.assertTrue(without_subscription["unlimited_compute"])

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

    def test_free_accounts_have_no_subscription_based_threads_account_limit(self):
        with db_module.db() as conn:
            self.assertIsNone(commercial_billing.threads_account_limit(conn, self.user_id))

    def test_active_personal_and_enterprise_subscription_account_limits_are_summed(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            for sku in ("vanguard_personal_quarterly", "vanguard_enterprise_quarterly"):
                order = commercial_billing.create_order(
                    conn,
                    user_id=self.user_id,
                    sku=sku,
                    quantity=1,
                    idempotency_key=f"account-limit-{sku}",
                    now=now,
                )
                commercial_billing.approve_order(
                    conn,
                    order["id"],
                    actor_user_id=self.admin_id,
                    now=now,
                )
            self.assertEqual(
                commercial_billing.threads_account_limit(conn, self.user_id, now=now),
                4,
            )
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now)
        self.assertEqual(summary["threads_account_limit"], 4)

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

    def test_legacy_enterprise_subscription_can_renew_into_official_term(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            subscription_id = "legacy-enterprise-subscription"
            conn.execute(
                "INSERT INTO billing_subscriptions(id, user_id, plan_sku, status, current_period_end, created_at, updated_at) "
                "VALUES (?, ?, 'vanguard_monthly', 'active', ?, ?, ?)",
                (subscription_id, self.user_id, commercial_billing.add_calendar_month(now), now, now),
            )
            conn.execute(
                "INSERT INTO billing_subscription_periods(id, subscription_id, user_id, source_order_id, start_at, end_at, status, created_at) "
                "VALUES ('legacy-enterprise-period', ?, ?, 'legacy-order', ?, ?, 'active', ?)",
                (subscription_id, self.user_id, now, commercial_billing.add_calendar_month(now), now),
            )
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_enterprise_annual",
                quantity=1,
                renewal_subscription_ids=[subscription_id],
                idempotency_key="legacy-enterprise-renewal",
                now=now,
            )
            commercial_billing.approve_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                now=now,
            )
            updated = conn.execute(
                "SELECT plan_sku FROM billing_subscriptions WHERE id = ?",
                (subscription_id,),
            ).fetchone()
        self.assertEqual(str(updated["plan_sku"]), "vanguard_enterprise_annual")

    def test_subscription_can_switch_term_within_family_but_not_between_families(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            original = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_personal_quarterly",
                quantity=1,
                idempotency_key="personal-quarterly-original",
                now=now,
            )
            commercial_billing.approve_order(
                conn,
                original["id"],
                actor_user_id=self.admin_id,
                now=now,
            )
            subscription = conn.execute(
                "SELECT id FROM billing_subscriptions WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            switched = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_personal_annual",
                quantity=1,
                renewal_subscription_ids=[str(subscription["id"])],
                idempotency_key="personal-annual-switch",
                now=now + 1,
            )
            self.assertEqual(switched["sku"], "vanguard_personal_annual")
            with self.assertRaises(commercial_billing.BillingError) as raised:
                commercial_billing.create_order(
                    conn,
                    user_id=self.user_id,
                    sku="vanguard_enterprise_quarterly",
                    quantity=1,
                    renewal_subscription_ids=[str(subscription["id"])],
                    idempotency_key="personal-to-enterprise-switch",
                    now=now + 2,
                )
        self.assertEqual(raised.exception.code, "SUBSCRIPTION_PLAN_MISMATCH")

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
            "sku": "credits_200",
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

    def test_legacy_order_schema_migrates_to_refunded_status_without_data_loss(self):
        legacy_path = Path(self.tmpdir.name) / "legacy-order-schema.db"
        legacy = sqlite3.connect(legacy_path)
        try:
            legacy.execute(
                """
                CREATE TABLE billing_orders (
                  id TEXT PRIMARY KEY,
                  user_id INTEGER NOT NULL,
                  kind TEXT NOT NULL CHECK(kind IN ('subscription', 'credit_pack')),
                  sku TEXT NOT NULL,
                  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
                  renewal_subscription_ids_json TEXT NOT NULL DEFAULT '[]',
                  amount_ntd_cents INTEGER NOT NULL CHECK(amount_ntd_cents >= 0),
                  catalog_version_id TEXT NOT NULL,
                  price_snapshot_json TEXT NOT NULL,
                  payer_name TEXT NOT NULL DEFAULT '',
                  payment_reference TEXT NOT NULL DEFAULT '',
                  paid_at INTEGER NOT NULL DEFAULT 0,
                  note TEXT NOT NULL DEFAULT '',
                  proof_path TEXT NOT NULL DEFAULT '',
                  status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
                  idempotency_key TEXT NOT NULL,
                  reviewed_by INTEGER NOT NULL DEFAULT 0,
                  reviewed_at INTEGER NOT NULL DEFAULT 0,
                  review_note TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  UNIQUE(user_id, idempotency_key)
                )
                """
            )
            legacy.execute(
                """
                INSERT INTO billing_orders(
                  id, user_id, kind, sku, quantity,
                  renewal_subscription_ids_json, amount_ntd_cents,
                  catalog_version_id, price_snapshot_json, status,
                  idempotency_key, created_at, updated_at
                ) VALUES (
                  'legacy-order', 99, 'credit_pack', 'credits_100', 1,
                  '[]', 100000, 'catalog-v1', '{}', 'approved',
                  'legacy-idempotency', 100, 101
                )
                """
            )
            legacy.commit()
        finally:
            legacy.close()

        current_db_path = os.environ["APP_DB_PATH"]
        try:
            os.environ["APP_DB_PATH"] = str(legacy_path)
            db_module.init_db()
            db_module.init_db()
            with db_module.db() as conn:
                migrated = conn.execute(
                    "SELECT * FROM billing_orders WHERE id = 'legacy-order'"
                ).fetchone()
                conn.execute(
                    "UPDATE billing_orders SET status = 'refunded', "
                    "refunded_by = 7, refunded_at = 200, refund_note = 'migration test' "
                    "WHERE id = 'legacy-order'"
                )
                refunded = conn.execute(
                    "SELECT status, refunded_by, refunded_at, refund_note "
                    "FROM billing_orders WHERE id = 'legacy-order'"
                ).fetchone()
        finally:
            os.environ["APP_DB_PATH"] = current_db_path

        self.assertEqual(str(migrated["status"]), "approved")
        self.assertEqual(str(refunded["status"]), "refunded")
        self.assertEqual(int(refunded["refunded_by"]), 7)
        self.assertEqual(int(refunded["refunded_at"]), 200)
        self.assertEqual(str(refunded["refund_note"]), "migration test")

    def test_reservation_idempotency_key_is_bound_to_immutable_request_fields(self):
        self._approve_credit_pack(now=1_700_000_000)
        request = {
            "user_id": self.user_id,
            "ref_type": "normal_task",
            "ref_id": "immutable-reservation",
            "sku": "basic_text_post",
            "quantity": 1,
            "image": False,
            "admin_waived": False,
            "idempotency_key": "immutable-reservation-request",
        }
        variants = {
            "user_id": self.admin_id,
            "ref_type": "social_task",
            "ref_id": "different-reference",
            "sku": "threads_text_publish",
            "quantity": 2,
            "image": True,
            "admin_waived": True,
        }

        with db_module.db() as conn:
            original = commercial_billing.reserve_charge(
                conn,
                **request,
                now=1_700_000_010,
            )
            replay = commercial_billing.reserve_charge(
                conn,
                **request,
                now=1_700_000_020,
            )
            self.assertEqual(replay, original)

            for field, different_value in variants.items():
                with self.subTest(field=field):
                    conflicting_request = dict(request)
                    conflicting_request[field] = different_value
                    with self.assertRaises(commercial_billing.BillingError) as raised:
                        commercial_billing.reserve_charge(
                            conn,
                            **conflicting_request,
                            now=1_700_000_030,
                        )
                    self.assertEqual(
                        raised.exception.code,
                        "RESERVATION_IDEMPOTENCY_CONFLICT",
                    )
                    self.assertEqual(raised.exception.status_code, 409)

            reservation_count = conn.execute(
                "SELECT COUNT(*) AS c FROM billing_reservations WHERE idempotency_key = ?",
                (request["idempotency_key"],),
            ).fetchone()
        self.assertEqual(int(reservation_count["c"]), 1)

    def test_legacy_wallet_without_active_period_is_not_subscription_active(self):
        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET billing_mode = 'legacy' WHERE user_id = ?",
                (self.user_id,),
            )
            summary = commercial_billing.billing_summary(
                conn,
                self.user_id,
                now=1_700_000_000,
            )
        self.assertFalse(summary["subscription_active"])
        self.assertEqual(summary["active_subscription_count"], 0)

    def test_credit_pack_refund_is_idempotent_and_reclaims_unused_benefits(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="credits_1620",
                quantity=1,
                idempotency_key="refund-unused-credit-pack",
                now=now,
            )
            commercial_billing.approve_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                now=now + 1,
            )
            refunded = commercial_billing.refund_approved_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                reason="payment reversed",
                now=now + 2,
            )
            replay = commercial_billing.refund_approved_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                reason="duplicate callback",
                now=now + 3,
            )
            summary = commercial_billing.billing_summary(
                conn,
                self.user_id,
                now=now + 3,
            )
            refund_entries = conn.execute(
                "SELECT event_type, COUNT(*) AS c FROM billing_ledger "
                "WHERE order_id = ? AND event_type IN "
                "('credit_pack_refunded', 'credit_pack_bonus_revoked') "
                "GROUP BY event_type ORDER BY event_type",
                (order["id"],),
            ).fetchall()

        self.assertEqual(refunded["status"], "refunded")
        self.assertEqual(replay, refunded)
        self.assertEqual(summary["points"], 0)
        self.assertEqual(summary["free_images"]["permanent_remaining"], 0)
        self.assertEqual(
            {str(row["event_type"]): int(row["c"]) for row in refund_entries},
            {"credit_pack_bonus_revoked": 1, "credit_pack_refunded": 1},
        )

    def test_credit_pack_refund_rejects_consumed_points_or_bonus_images(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            points_order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="credits_200",
                quantity=1,
                idempotency_key="refund-consumed-points",
                now=now,
            )
            commercial_billing.approve_order(
                conn,
                points_order["id"],
                actor_user_id=self.admin_id,
                now=now + 1,
            )
            conn.execute(
                "UPDATE billing_wallets SET credit_units = 0 WHERE user_id = ?",
                (self.user_id,),
            )
            with self.assertRaises(commercial_billing.BillingError) as points_error:
                commercial_billing.refund_approved_order(
                    conn,
                    points_order["id"],
                    actor_user_id=self.admin_id,
                    reason="payment reversed",
                    now=now + 2,
                )

        self.assertEqual(points_error.exception.code, "ORDER_BENEFITS_ALREADY_USED")

        with db_module.db() as conn:
            conn.execute(
                "UPDATE billing_wallets SET credit_units = 0 WHERE user_id = ?",
                (self.user_id,),
            )
            image_order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="credits_1620",
                quantity=1,
                idempotency_key="refund-consumed-images",
                now=now + 10,
            )
            commercial_billing.approve_order(
                conn,
                image_order["id"],
                actor_user_id=self.admin_id,
                now=now + 11,
            )
            conn.execute(
                "UPDATE billing_image_grants SET remaining_count = remaining_count - 1 "
                "WHERE source_type = 'credit_pack_bonus' AND source_ref = ?",
                (image_order["id"],),
            )
            with self.assertRaises(commercial_billing.BillingError) as image_error:
                commercial_billing.refund_approved_order(
                    conn,
                    image_order["id"],
                    actor_user_id=self.admin_id,
                    reason="payment reversed",
                    now=now + 12,
                )

        self.assertEqual(image_error.exception.code, "ORDER_BENEFITS_ALREADY_USED")
        with db_module.db() as conn:
            statuses = conn.execute(
                "SELECT id, status FROM billing_orders WHERE id IN (?, ?)",
                (points_order["id"], image_order["id"]),
            ).fetchall()
        self.assertEqual(
            {str(row["id"]): str(row["status"]) for row in statuses},
            {
                points_order["id"]: "approved",
                image_order["id"]: "approved",
            },
        )

    def test_subscription_refund_revokes_only_that_orders_periods_and_remaining_images(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            original = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_enterprise_quarterly",
                quantity=1,
                idempotency_key="subscription-original",
                now=now,
            )
            commercial_billing.approve_order(
                conn,
                original["id"],
                actor_user_id=self.admin_id,
                now=now,
            )
            subscription = conn.execute(
                "SELECT id, current_period_end FROM billing_subscriptions "
                "WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            original_period_end = int(subscription["current_period_end"])
            renewal = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_enterprise_quarterly",
                quantity=1,
                renewal_subscription_ids=[str(subscription["id"])],
                idempotency_key="subscription-renewal-refund",
                now=now + 10,
            )
            commercial_billing.approve_order(
                conn,
                renewal["id"],
                actor_user_id=self.admin_id,
                now=now + 10,
            )
            refunded = commercial_billing.refund_approved_order(
                conn,
                renewal["id"],
                actor_user_id=self.admin_id,
                reason="duplicate payment",
                now=now + 20,
            )
            replay = commercial_billing.refund_approved_order(
                conn,
                renewal["id"],
                actor_user_id=self.admin_id,
                reason="duplicate payment",
                now=now + 21,
            )
            summary = commercial_billing.billing_summary(
                conn,
                self.user_id,
                now=now + 21,
            )
            periods = conn.execute(
                "SELECT source_order_id, status FROM billing_subscription_periods "
                "WHERE subscription_id = ? ORDER BY start_at",
                (str(subscription["id"]),),
            ).fetchall()
            subscription_after = conn.execute(
                "SELECT status, current_period_end FROM billing_subscriptions WHERE id = ?",
                (str(subscription["id"]),),
            ).fetchone()

        self.assertEqual(refunded["status"], "refunded")
        self.assertEqual(replay, refunded)
        self.assertTrue(summary["subscription_active"])
        self.assertEqual(summary["free_images"]["monthly_remaining"], 10)
        self.assertEqual(
            [(str(row["source_order_id"]), str(row["status"])) for row in periods],
            [
                (original["id"], "active"),
                (original["id"], "scheduled"),
                (original["id"], "scheduled"),
                (renewal["id"], "cancelled"),
                (renewal["id"], "cancelled"),
                (renewal["id"], "cancelled"),
            ],
        )
        self.assertEqual(str(subscription_after["status"]), "active")
        self.assertEqual(
            int(subscription_after["current_period_end"]),
            original_period_end,
        )

    def test_terminate_subscription_is_idempotent_and_revokes_remaining_access(self):
        now = 1_700_000_000
        self._approve_subscription(now=now)
        with db_module.db() as conn:
            subscription = conn.execute(
                "SELECT id FROM billing_subscriptions WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            period = conn.execute(
                "SELECT id FROM billing_subscription_periods WHERE subscription_id = ?",
                (str(subscription["id"]),),
            ).fetchone()
            conn.execute(
                "UPDATE billing_image_grants SET remaining_count = 7 "
                "WHERE source_type = 'subscription_monthly' AND source_ref = ?",
                (str(period["id"]),),
            )
            terminated = commercial_billing.terminate_subscription(
                conn,
                str(subscription["id"]),
                actor_user_id=self.admin_id,
                reason="manual termination",
                now=now + 10,
            )
            replay = commercial_billing.terminate_subscription(
                conn,
                str(subscription["id"]),
                actor_user_id=self.admin_id,
                reason="duplicate request",
                now=now + 11,
            )
            summary = commercial_billing.billing_summary(
                conn,
                self.user_id,
                now=now + 11,
            )
            termination_events = conn.execute(
                "SELECT COUNT(*) AS c FROM billing_ledger "
                "WHERE ref_type = 'subscription' AND ref_id = ? "
                "AND event_type = 'subscription_terminated'",
                (str(subscription["id"]),),
            ).fetchone()

        self.assertEqual(terminated["status"], "cancelled")
        self.assertEqual(replay, terminated)
        self.assertFalse(summary["subscription_active"])
        self.assertEqual(summary["free_images"]["monthly_remaining"], 0)
        self.assertEqual(summary["periods"][0]["status"], "cancelled")
        self.assertEqual(int(termination_events["c"]), 1)

    def test_subscription_reversal_blocks_images_held_by_active_tasks(self):
        now = 1_700_000_000
        with db_module.db() as conn:
            order = commercial_billing.create_order(
                conn,
                user_id=self.user_id,
                sku="vanguard_enterprise_quarterly",
                quantity=1,
                idempotency_key="subscription-with-held-image",
                now=now,
            )
            commercial_billing.approve_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                now=now,
            )
            subscription = conn.execute(
                "SELECT id FROM billing_subscriptions WHERE user_id = ?",
                (self.user_id,),
            ).fetchone()
            held = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="normal_task",
                ref_id="held-subscription-image",
                sku="ai_image",
                quantity=1,
                image=True,
                now=now + 1,
            )

            with self.assertRaises(commercial_billing.BillingError) as refund_error:
                commercial_billing.refund_approved_order(
                    conn,
                    order["id"],
                    actor_user_id=self.admin_id,
                    reason="payment reversed",
                    now=now + 2,
                )
            with self.assertRaises(commercial_billing.BillingError) as termination_error:
                commercial_billing.terminate_subscription(
                    conn,
                    str(subscription["id"]),
                    actor_user_id=self.admin_id,
                    reason="manual termination",
                    now=now + 2,
                )

            order_after_errors = conn.execute(
                "SELECT status FROM billing_orders WHERE id = ?",
                (order["id"],),
            ).fetchone()
            period_after_errors = conn.execute(
                "SELECT status FROM billing_subscription_periods "
                "WHERE subscription_id = ?",
                (str(subscription["id"]),),
            ).fetchone()
            commercial_billing.release_reservation(
                conn,
                held["id"],
                now=now + 3,
            )
            refunded = commercial_billing.refund_approved_order(
                conn,
                order["id"],
                actor_user_id=self.admin_id,
                reason="payment reversed",
                now=now + 4,
            )

        self.assertEqual(
            refund_error.exception.code,
            "SUBSCRIPTION_BENEFITS_IN_USE",
        )
        self.assertEqual(
            termination_error.exception.code,
            "SUBSCRIPTION_BENEFITS_IN_USE",
        )
        self.assertEqual(str(order_after_errors["status"]), "approved")
        self.assertEqual(str(period_after_errors["status"]), "active")
        self.assertEqual(refunded["status"], "refunded")

    def test_list_orders_supports_stable_offset_pagination(self):
        created_ids = []
        with db_module.db() as conn:
            for index in range(3):
                order = commercial_billing.create_order(
                    conn,
                    user_id=self.user_id,
                    sku="credits_200",
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
        self.assertEqual(summary["points"], 199.4)

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
            self.assertEqual(held["reserved_points"], 4)
            settled = commercial_billing.settle_reservation(conn, held["id"], actual_quantity=11, now=now + 3)
            summary = commercial_billing.billing_summary(conn, self.user_id, now=now + 3)
        self.assertEqual(settled["free_images_used"], 10)
        self.assertEqual(settled["charged_points"], 2)
        self.assertEqual(summary["points"], 198)
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
        self.assertEqual(claimed["reserved_points"], 0)
        self.assertEqual(len({item["id"] for item in reservations}), 3)

    def test_early_renewal_quantity_extends_one_subscription_quarter_by_quarter(self):
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
                sku="vanguard_enterprise_quarterly",
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
        self.assertEqual(len(periods), 9)
        self.assertEqual(int(periods[3]["start_at"]), first_end)
        for index in range(4, len(periods)):
            self.assertEqual(int(periods[index]["start_at"]), int(periods[index - 1]["end_at"]))
        self.assertEqual(int(renewed["current_period_end"]), int(periods[-1]["end_at"]))

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
        self.assertEqual(summary["points"], 200)
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
                sku="credits_200",
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
            catalog["packages"][0]["price_ntd"] = 2500
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
        self.assertEqual(approved["amount_ntd_cents"], 200000)
        self.assertEqual(approved["price_snapshot"]["item"]["price_ntd"], 2000)


if __name__ == "__main__":
    unittest.main()
