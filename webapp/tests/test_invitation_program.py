import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from webapp import commercial_billing
from webapp import db as db_module
from webapp import invitation_program


class InvitationProgramTests(unittest.TestCase):
    def setUp(self):
        self.old_db_path = os.environ.get("APP_DB_PATH")
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["APP_DB_PATH"] = str(Path(self.tmpdir.name) / "app.db")
        db_module.init_db()
        with db_module.db() as conn:
            admin = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,balance_cents,created_at,updated_at) "
                "VALUES ('invite_admin','hash',1,0,0,100,100)"
            )
            inviter = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,balance_cents,account_type,approval_status,created_at,updated_at) "
                "VALUES ('invite_owner','hash',0,0,0,'self_service','approved',100,100)"
            )
            invitee = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,balance_cents,account_type,approval_status,created_at,updated_at) "
                "VALUES ('invite_new','hash',0,0,0,'self_service','approved',101,101)"
            )
            self.admin_id = int(admin.lastrowid)
            self.inviter_id = int(inviter.lastrowid)
            self.invitee_id = int(invitee.lastrowid)
            commercial_billing.initialize_new_user_wallet(
                conn, user_id=self.inviter_id, source="test", now=100
            )
            commercial_billing.initialize_new_user_wallet(
                conn, user_id=self.invitee_id, source="test", now=101
            )

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("APP_DB_PATH", None)
        else:
            os.environ["APP_DB_PATH"] = self.old_db_path
        self.tmpdir.cleanup()

    def test_user_code_is_stable_and_claim_rewards_both_wallets_once(self):
        with db_module.db() as conn:
            first = invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=200)
            second = invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=201)
            result = invitation_program.apply_registration_invitation(
                conn,
                invitee_user_id=self.invitee_id,
                raw_code=first["code"],
                now=202,
            )
            wallets = {
                int(row["user_id"]): int(row["credit_units"])
                for row in conn.execute(
                    "SELECT user_id, credit_units FROM billing_wallets WHERE user_id IN (?, ?)",
                    (self.inviter_id, self.invitee_id),
                ).fetchall()
            }
            reward_rows = conn.execute(
                "SELECT user_id, event_type, amount_units, cash_backed_amount_units "
                "FROM billing_ledger WHERE ref_type='invitation_claim' ORDER BY user_id"
            ).fetchall()
        self.assertEqual(first["code"], second["code"])
        self.assertEqual(result["status"], "rewarded")
        self.assertEqual(wallets[self.inviter_id], 40 * commercial_billing.POINT_SCALE)
        self.assertEqual(wallets[self.invitee_id], 40 * commercial_billing.POINT_SCALE)
        self.assertEqual(len(reward_rows), 2)
        self.assertTrue(all(int(row["cash_backed_amount_units"]) == 0 for row in reward_rows))

    def test_self_invite_and_second_claim_are_rejected_without_extra_credit(self):
        with db_module.db() as conn:
            owner_code = invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=300)
            with self.assertRaises(commercial_billing.BillingError) as self_error:
                invitation_program.apply_registration_invitation(
                    conn, invitee_user_id=self.inviter_id, raw_code=owner_code["code"], now=301
                )
        self.assertEqual(self_error.exception.code, "INVITATION_SELF_NOT_ALLOWED")

        with db_module.db() as conn:
            invitation_program.apply_registration_invitation(
                conn, invitee_user_id=self.invitee_id, raw_code=owner_code["code"], now=302
            )
            with self.assertRaises(commercial_billing.BillingError) as repeat_error:
                invitation_program.apply_registration_invitation(
                    conn, invitee_user_id=self.invitee_id, raw_code=owner_code["code"], now=303
                )
        self.assertEqual(repeat_error.exception.code, "INVITATION_ALREADY_CLAIMED")

    def test_permission_reward_stays_pending_placeholder(self):
        with db_module.db() as conn:
            current = invitation_program.get_settings(conn)
            settings = invitation_program.update_settings(
                conn,
                actor_user_id=self.admin_id,
                enabled=True,
                inviter_points=10,
                invitee_points=15,
                inviter_reward_type="points_and_permission",
                invitee_reward_type="permission",
                inviter_entitlement_key="beta_access",
                invitee_entitlement_key="starter_access",
                expected_version=current["version"],
                now=400,
            )
            code = invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=401)
            result = invitation_program.apply_registration_invitation(
                conn, invitee_user_id=self.invitee_id, raw_code=code["code"], now=402
            )
            grants = conn.execute(
                "SELECT party,reward_type,status FROM billing_invitation_reward_grants "
                "WHERE claim_id=? ORDER BY party,reward_type",
                (result["claim_id"],),
            ).fetchall()
            summary = invitation_program.get_admin_summary(conn)
            record = invitation_program.list_admin_records(conn)[0][0]
            ledger_units = int(conn.execute(
                "SELECT COALESCE(SUM(amount_units),0) FROM billing_ledger "
                "WHERE ref_type='invitation_claim'"
            ).fetchone()[0])
        self.assertFalse(settings["permission_grants_implemented"])
        self.assertEqual(result["status"], "pending_permission")
        self.assertEqual(
            [(row["party"], row["reward_type"], row["status"]) for row in grants],
            [("invitee", "permission", "pending"), ("inviter", "permission", "pending"), ("inviter", "points", "applied")],
        )
        self.assertEqual(result["invitee_points"], 0)
        self.assertEqual(record["status"], "pending_permission")
        self.assertEqual(record["completed_at"], 0)
        self.assertEqual(summary["reward_points"], 10)
        self.assertEqual(ledger_units, 10 * commercial_billing.POINT_SCALE)

    def test_settings_cas_permission_validation_and_disabled_code_generation(self):
        with db_module.db() as conn:
            current = invitation_program.get_settings(conn)
            with self.assertRaises(commercial_billing.BillingError) as missing_key:
                invitation_program.update_settings(
                    conn, actor_user_id=self.admin_id, enabled=True,
                    inviter_points=0, invitee_points=0,
                    inviter_reward_type="permission", invitee_reward_type="permission",
                    expected_version=current["version"], now=500,
                )
        self.assertEqual(missing_key.exception.code, "INVITATION_ENTITLEMENT_REQUIRED")
        with db_module.db() as conn:
            current = invitation_program.get_settings(conn)
            updated = invitation_program.update_settings(
                conn, actor_user_id=self.admin_id, enabled=False,
                inviter_points=20, invitee_points=20,
                expected_version=current["version"], now=501,
            )
            with self.assertRaises(commercial_billing.BillingError) as stale:
                invitation_program.update_settings(
                    conn, actor_user_id=self.admin_id, enabled=True,
                    inviter_points=20, invitee_points=20,
                    expected_version=current["version"], now=502,
                )
            with self.assertRaises(commercial_billing.BillingError) as disabled:
                invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=503)
        self.assertEqual(updated["version"], current["version"] + 1)
        self.assertEqual(stale.exception.code, "INVITATION_SETTINGS_VERSION_CONFLICT")
        self.assertEqual(disabled.exception.code, "INVITATION_DISABLED")

    def test_admin_code_statuses_and_user_records_cover_both_roles_with_pagination(self):
        with db_module.db() as conn:
            active = invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=600)
            invitee_code = invitation_program.ensure_user_code(conn, user_id=self.invitee_id, now=601)
            conn.execute(
                "UPDATE billing_invitation_codes SET status='disabled' WHERE id=?",
                (invitee_code["id"],),
            )
            pending = invitation_program.list_admin_records(conn, status="pending")[0]
            revoked = invitation_program.list_admin_records(conn, status="revoked")[0]
            third = conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,balance_cents,account_type,approval_status,created_at,updated_at) "
                "VALUES ('invite_third','hash',0,0,0,'self_service','approved',602,602)"
            )
            third_id = int(third.lastrowid)
            commercial_billing.initialize_new_user_wallet(conn, user_id=third_id, source="test", now=602)
            invitation_program.apply_registration_invitation(
                conn, invitee_user_id=third_id, raw_code=active["code"], now=603,
            )
            invitee_view, total = invitation_program.list_user_records(
                conn, user_id=third_id, limit=1, offset=0,
            )
        self.assertEqual([item["status"] for item in pending], ["pending"])
        self.assertEqual([item["status"] for item in revoked], ["revoked"])
        self.assertEqual(total, 1)
        self.assertEqual(len(invitee_view), 1)
        self.assertEqual(invitee_view[0]["viewer_role"], "invitee")

    def test_source_and_inviter_daily_limits_are_atomic_under_concurrency(self):
        with db_module.db() as conn:
            current = invitation_program.get_settings(conn)
            invitation_program.update_settings(
                conn, actor_user_id=self.admin_id, enabled=True,
                inviter_points=20, invitee_points=20,
                inviter_daily_limit=1, source_daily_limit=1,
                expected_version=current["version"], now=700,
            )
            code = invitation_program.ensure_user_code(conn, user_id=self.inviter_id, now=701)
            invitee_ids = [self.invitee_id]
            for index in range(2):
                row = conn.execute(
                    "INSERT INTO users(username,password_hash,is_admin,is_disabled,balance_cents,account_type,approval_status,created_at,updated_at) "
                    "VALUES (?,?,0,0,0,'self_service','approved',702,702)",
                    (f'limit_user_{index}', 'hash'),
                )
                user_id = int(row.lastrowid)
                commercial_billing.initialize_new_user_wallet(conn, user_id=user_id, source="test", now=702)
                invitee_ids.append(user_id)

        def claim(user_id):
            try:
                with db_module.db() as conn:
                    invitation_program.apply_registration_invitation(
                        conn, invitee_user_id=user_id, raw_code=code["code"],
                        source_hash="same-source", now=703,
                    )
                return "ok"
            except commercial_billing.BillingError as exc:
                return exc.code

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(claim, invitee_ids[:2]))
        self.assertEqual(sorted(outcomes), ["INVITATION_INVITER_DAILY_LIMIT", "ok"])
        with db_module.db() as conn:
            self.assertEqual(
                int(conn.execute("SELECT COUNT(*) FROM billing_invitation_claims").fetchone()[0]),
                1,
            )
            current = invitation_program.get_settings(conn)
            invitation_program.update_settings(
                conn, actor_user_id=self.admin_id, enabled=True,
                inviter_points=20, invitee_points=20,
                inviter_daily_limit=10, source_daily_limit=1,
                expected_version=current["version"], now=704,
            )
            with self.assertRaises(commercial_billing.BillingError) as source_limited:
                invitation_program.apply_registration_invitation(
                    conn, invitee_user_id=invitee_ids[2], raw_code=code["code"],
                    source_hash="same-source", now=705,
                )
        self.assertEqual(source_limited.exception.code, "INVITATION_SOURCE_DAILY_LIMIT")

    def test_schema_initialization_is_repeatable(self):
        db_module.init_db()
        db_module.init_db()
        with db_module.db() as conn:
            settings = invitation_program.get_settings(conn)
        self.assertEqual(settings["version"], 1)
        self.assertTrue(settings["enabled"])


if __name__ == "__main__":
    unittest.main()
