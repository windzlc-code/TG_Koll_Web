from __future__ import annotations

import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from cryptography.fernet import Fernet

from webapp.collector_accounts import (
    CollectorAccountConflictError,
    CollectorAccountPool,
    CollectorLeaseExpiredError,
    CollectorLeaseNotFoundError,
    NoCollectorAccountAvailableError,
)
from webapp.collector_db import collector_db
from webapp.collector_vault import CollectorVault


CAPABILITY = "persona.hot_candidates.v1"


class CollectorAccountPoolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "collector" / "collector.db"
        self.vault = CollectorVault(key=Fernet.generate_key(), key_version="test-v1")
        self.pool = CollectorAccountPool(self.db_path, self.vault)

    def create_ready(
        self,
        account_id: str = "colacct_one",
        *,
        platform: str = "threads",
        username: str = "collector_one",
        capabilities: tuple[str, ...] = (CAPABILITY,),
        now: int = 100,
    ) -> dict:
        return self.pool.create_account(
            account_id=account_id,
            platform=platform,
            username=username,
            display_name="Internal collector",
            login_username="private-login",
            profile_dir=f"/private/profiles/{account_id}",
            proxy_id="private-proxy",
            capabilities=capabilities,
            status="ready",
            health_status="healthy",
            secrets={
                "login_password": "super-secret-password",
                "totp": "JBSWY3DPEHPK3PXP",
            },
            now=now,
        )

    def test_independent_schema_encrypts_secrets_and_public_shape_is_safe(self) -> None:
        account = self.create_ready()

        self.assertEqual(account["id"], "colacct_one")
        forbidden = {
            "profile_dir",
            "proxy_id",
            "login_username",
            "login_password",
            "ciphertext",
            "totp",
        }
        self.assertTrue(forbidden.isdisjoint(account))
        with collector_db(self.db_path) as conn:
            quick_check = conn.execute("PRAGMA quick_check").fetchone()[0]
            secret_rows = conn.execute(
                "SELECT secret_kind, ciphertext FROM collector_account_secrets ORDER BY secret_kind"
            ).fetchall()
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }

        self.assertEqual(quick_check, "ok")
        self.assertEqual(len(secret_rows), 2)
        self.assertNotIn("super-secret-password", secret_rows[0]["ciphertext"])
        self.assertTrue(
            {
                "collector_accounts",
                "collector_account_secrets",
                "collector_account_leases",
            }.issubset(tables)
        )
        self.assertNotIn("users", tables)
        self.assertNotIn("social_accounts", tables)

    def test_pool_identity_is_unique_after_persona_detachment(self) -> None:
        self.create_ready()
        with self.assertRaises(CollectorAccountConflictError):
            self.pool.create_account(
                account_id="colacct_duplicate",
                platform="threads",
                username="COLLECTOR_ONE",
                capabilities=[CAPABILITY],
                status="ready",
                now=101,
            )

    def test_metadata_cannot_bypass_encrypted_secret_storage(self) -> None:
        with self.assertRaises(ValueError):
            self.pool.create_account(
                account_id="colacct_unsafe",
                platform="threads",
                username="unsafe",
                capabilities=[CAPABILITY],
                metadata={"nested": {"api_token": "plaintext"}},
                now=100,
            )

    def test_disabling_account_revokes_its_active_lease(self) -> None:
        self.create_ready()
        lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="job_one",
            now=110,
        )
        account = self.pool.set_account_state(
            "colacct_one", status="disabled", health_status="operator_disabled", now=111
        )
        self.assertFalse(account["leased"])
        with self.assertRaises(CollectorLeaseNotFoundError):
            self.pool.use_secret(
                lease["lease_id"],
                holder="job_one",
                kind="login_password",
                consumer=lambda value: value,
                now=112,
            )

    def test_selection_matches_platform_capability_and_lease_is_exclusive(self) -> None:
        self.create_ready()
        self.create_ready(
            "colacct_instagram",
            platform="instagram",
            username="collector_ig",
            now=100,
        )

        lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="job_one",
            lease_seconds=60,
            now=110,
        )
        self.assertEqual(lease["account"]["id"], "colacct_one")
        self.assertTrue(lease["account"]["leased"])
        with self.assertRaises(NoCollectorAccountAvailableError):
            self.pool.acquire(
                capability=CAPABILITY,
                platform="threads",
                holder="job_two",
                now=111,
            )
        with self.assertRaises(CollectorLeaseNotFoundError):
            self.pool.release(
                lease["lease_id"], holder="wrong_holder", succeeded=True, now=112
            )

    def test_secret_can_only_be_used_by_active_lease_holder(self) -> None:
        self.create_ready()
        lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="runtime_one",
            now=110,
        )
        observed = self.pool.use_secret(
            lease["lease_id"],
            holder="runtime_one",
            kind="login_password",
            consumer=lambda value: f"length:{len(value)}",
            now=111,
        )
        self.assertEqual(observed, "length:21")
        with self.assertRaises(CollectorLeaseNotFoundError):
            self.pool.use_secret(
                lease["lease_id"],
                holder="runtime_two",
                kind="login_password",
                consumer=lambda value: value,
                now=111,
            )

    def test_runtime_profile_is_only_available_inside_active_lease_callback(self) -> None:
        self.create_ready()
        lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="runtime_profile_job",
            now=110,
        )
        observed = self.pool.use_runtime_profile(
            lease["lease_id"],
            holder="runtime_profile_job",
            consumer=lambda value: {
                "platform": value["platform"],
                "basename": Path(value["profile_dir"]).name,
            },
            now=111,
        )
        self.assertEqual(observed, {"platform": "threads", "basename": "colacct_one"})
        self.assertNotIn("profile_dir", lease)
        self.assertNotIn("profile_dir", lease["account"])

    def test_success_cooldown_blocks_then_allows_reselection(self) -> None:
        self.create_ready()
        lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="job_one",
            now=110,
        )
        released = self.pool.release(
            lease["lease_id"],
            holder="job_one",
            succeeded=True,
            success_cooldown_seconds=30,
            now=120,
        )
        self.assertEqual(released["account"]["cooldown_until"], 150)
        with self.assertRaises(NoCollectorAccountAvailableError):
            self.pool.acquire(
                capability=CAPABILITY,
                platform="threads",
                holder="job_two",
                now=149,
            )
        next_lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="job_two",
            now=150,
        )
        self.assertEqual(next_lease["account"]["id"], "colacct_one")

    def test_consecutive_failures_open_circuit_until_deadline(self) -> None:
        self.create_ready()
        current = 110
        for attempt in range(3):
            lease = self.pool.acquire(
                capability=CAPABILITY,
                platform="threads",
                holder=f"job_{attempt}",
                now=current,
            )
            result = self.pool.release(
                lease["lease_id"],
                holder=f"job_{attempt}",
                succeeded=False,
                error_code="upstream_timeout",
                failure_cooldown_seconds=1,
                failure_threshold=3,
                circuit_seconds=100,
                now=current,
            )
            current += 1

        self.assertEqual(result["account"]["consecutive_failures"], 3)
        self.assertEqual(result["account"]["circuit_open_until"], 212)
        with self.assertRaises(NoCollectorAccountAvailableError):
            self.pool.acquire(
                capability=CAPABILITY,
                platform="threads",
                holder="blocked_job",
                now=211,
            )
        recovered = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="recovery_job",
            now=212,
        )
        success = self.pool.release(
            recovered["lease_id"],
            holder="recovery_job",
            succeeded=True,
            now=213,
        )
        self.assertEqual(success["account"]["consecutive_failures"], 0)
        self.assertEqual(success["account"]["circuit_open_until"], 0)

    def test_expired_lease_is_reclaimed_and_stale_owner_cannot_release_new_lease(self) -> None:
        self.create_ready()
        old_lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="old_job",
            lease_seconds=10,
            now=110,
        )
        new_lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="new_job",
            lease_seconds=30,
            now=120,
        )
        self.assertNotEqual(old_lease["lease_id"], new_lease["lease_id"])
        with self.assertRaises(CollectorLeaseNotFoundError):
            self.pool.release(
                old_lease["lease_id"], holder="old_job", succeeded=False, now=121
            )
        listed = self.pool.list_accounts(now=121)
        self.assertTrue(listed[0]["leased"])

    def test_expired_secret_access_fails(self) -> None:
        self.create_ready()
        lease = self.pool.acquire(
            capability=CAPABILITY,
            platform="threads",
            holder="job_one",
            lease_seconds=10,
            now=110,
        )
        with self.assertRaises(CollectorLeaseExpiredError):
            self.pool.use_secret(
                lease["lease_id"],
                holder="job_one",
                kind="totp",
                consumer=lambda value: value,
                now=120,
            )

    def test_concurrent_acquire_has_single_winner(self) -> None:
        self.create_ready()
        barrier = threading.Barrier(3)
        winners: list[str] = []
        unavailable: list[str] = []

        def contender(holder: str) -> None:
            barrier.wait()
            try:
                lease = self.pool.acquire(
                    capability=CAPABILITY,
                    platform="threads",
                    holder=holder,
                    now=110,
                )
                winners.append(lease["lease_id"])
            except NoCollectorAccountAvailableError:
                unavailable.append(holder)

        threads = [
            threading.Thread(target=contender, args=("job_one",)),
            threading.Thread(target=contender, args=("job_two",)),
        ]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=5)

        self.assertEqual(len(winners), 1)
        self.assertEqual(len(unavailable), 1)

    def test_foreign_keys_reject_orphan_secrets(self) -> None:
        with collector_db(self.db_path) as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    INSERT INTO collector_account_secrets(
                      account_id, secret_kind, ciphertext, key_version, created_at, updated_at
                    ) VALUES ('missing', 'totp', 'ciphertext', 'v1', 1, 1)
                    """
                )


if __name__ == "__main__":
    unittest.main()
