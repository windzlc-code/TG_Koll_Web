import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import requests

from webapp import auth_email
from webapp import email_delivery_governance as governance


def _response(status: int, payload: dict):
    response = mock.Mock(status_code=status)
    response.json.return_value = payload
    return response


class EmailDeliveryGovernanceTests(unittest.TestCase):
    ENV_KEYS = (
        "APP_DB_PATH",
        "AUTH_VERIFICATION_SECRET",
        "EMAIL_DELIVERY_PROVIDER",
        "BREVO_API_KEY",
        "BREVO_FROM_ADDRESS",
        "WEBAPP_TIMEZONE",
        "EMAIL_QUOTA_TIMEZONE_OFFSET_MINUTES",
        "BREVO_TIMEOUT_SECONDS",
        "EMAIL_QUOTA_GOVERNANCE_ENABLED",
        "BREVO_QUOTA_SYNC_TTL_SECONDS",
        "BREVO_QUOTA_SYNC_FAILURE_BACKOFF_SECONDS",
        "BREVO_QUOTA_SYNC_WAIT_SECONDS",
        "BREVO_QUOTA_LIVE_SYNC_STALE_GRACE_SECONDS",
        "EMAIL_DELIVERY_ATTEMPT_LEASE_SECONDS",
    )

    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "app.db"
        os.environ.update(
            {
                "APP_DB_PATH": str(self.db_path),
                "AUTH_VERIFICATION_SECRET": (
                    "verification-secret-with-at-least-32-bytes"
                ),
                "EMAIL_DELIVERY_PROVIDER": "brevo",
                "BREVO_API_KEY": "xkeysib-test-key-with-sufficient-length",
                "BREVO_FROM_ADDRESS": "Vecto OS <noreply@mail.vecto-ai.cn>",
                "BREVO_TIMEOUT_SECONDS": "7",
                "EMAIL_QUOTA_GOVERNANCE_ENABLED": "1",
                "BREVO_QUOTA_SYNC_TTL_SECONDS": "90",
                "BREVO_QUOTA_SYNC_FAILURE_BACKOFF_SECONDS": "15",
                "BREVO_QUOTA_SYNC_WAIT_SECONDS": "2",
                "BREVO_QUOTA_LIVE_SYNC_STALE_GRACE_SECONDS": "180",
                "EMAIL_DELIVERY_ATTEMPT_LEASE_SECONDS": "30",
            }
        )
        with closing(self.connect()) as conn:
            governance.ensure_email_delivery_governance_schema(conn)
            conn.commit()

    def tearDown(self):
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temp_dir.cleanup()

    def connect(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=3000")
        return conn

    def test_email_quota_is_fixed_to_shanghai_timezone(self):
        os.environ["WEBAPP_TIMEZONE"] = "UTC"
        os.environ["EMAIL_QUOTA_TIMEZONE_OFFSET_MINUTES"] = "-420"
        quota_timezone = governance._quota_timezone()
        self.assertEqual(
            getattr(quota_timezone, "key", "") or quota_timezone.tzname(None),
            "Asia/Shanghai",
        )

    @staticmethod
    def sync_responses(*, credits=250, requests_count=50):
        return (
            _response(
                200,
                {
                    "email": "must-not-be-persisted@example.com",
                    "plan": [
                        {
                            "credits": credits,
                            "creditsType": "sendLimit",
                            "type": "free",
                        }
                    ],
                    "relay": {"enabled": True, "data": {"userName": "private"}},
                },
            ),
            _response(
                200,
                {
                    "requests": requests_count,
                    "delivered": max(0, requests_count - 2),
                    "blocked": 1,
                    "hardBounces": 1,
                    "softBounces": 0,
                    "invalid": 0,
                },
            ),
        )

    def test_sync_persists_sanitized_snapshot_and_honors_ttl(self):
        now = int(time.time())
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(),
        ) as get:
            result = governance.sync_brevo_usage(conn, now=now)
            cached = governance.sync_brevo_usage(conn, now=now + 30)
            stored = conn.execute(
                "SELECT account_json FROM email_delivery_provider_snapshot"
            ).fetchone()

        self.assertEqual(get.call_count, 2)
        self.assertEqual(result["effective_daily_limit"], 300)
        self.assertEqual(result["remaining_today"], 250)
        self.assertFalse(cached["stale"])
        self.assertNotIn("must-not-be-persisted", stored["account_json"])
        self.assertNotIn("userName", stored["account_json"])
        account_call, report_call = get.call_args_list
        self.assertEqual(account_call.args[0], governance.BREVO_ACCOUNT_URL)
        self.assertEqual(
            report_call.args[0],
            governance.BREVO_AGGREGATED_REPORT_URL,
        )
        self.assertEqual(
            report_call.kwargs["params"]["startDate"],
            report_call.kwargs["params"]["endDate"],
        )

    def test_sync_uses_brevo_utc_day_before_shanghai_8am(self):
        now = int(
            datetime(2026, 8, 16, 22, 30, tzinfo=timezone.utc).timestamp()
        )
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(),
        ) as get:
            result = governance.sync_brevo_usage(conn, now=now)

        report_call = get.call_args_list[1]
        self.assertEqual(
            report_call.kwargs["params"],
            {"startDate": "2026-08-16", "endDate": "2026-08-16"},
        )
        self.assertEqual(result["report_day"], "2026-08-17")

    def test_manual_policy_can_only_tighten_provider_limit(self):
        now = int(time.time())
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(),
        ):
            governance.sync_brevo_usage(conn, now=now)
            policy = governance.set_email_delivery_policy(
                conn,
                "manual",
                60,
                now,
                updated_by=9,
            )
            overview = governance.get_email_delivery_overview(conn, now)
            with self.assertRaisesRegex(ValueError, "cannot exceed"):
                governance.set_email_delivery_policy(
                    conn,
                    "manual",
                    301,
                    now,
                )
            automatic = governance.set_email_delivery_policy(
                conn,
                "auto",
                None,
                now,
            )

        self.assertEqual(policy["manual_daily_limit"], 60)
        self.assertEqual(overview["effective_daily_limit"], 60)
        self.assertEqual(overview["remaining_today"], 10)
        self.assertEqual(automatic["mode"], "auto")
        self.assertIsNone(automatic["manual_daily_limit"])

    def test_stale_snapshot_fails_closed_and_live_lease_prevents_duplicate_sync(self):
        now = int(time.time())
        with closing(self.connect()) as conn:
            with self.assertRaises(governance.EmailDeliveryQuotaUnavailable):
                governance.reserve_email_delivery_attempt(
                    conn,
                    attempt_id="attempt-stale",
                    idempotency_key="key-stale",
                    now=now,
                )
            conn.execute(
                """
                UPDATE email_delivery_sync_state
                SET lease_token = 'another-process',
                    lease_expires_at = ?
                WHERE id = 1
                """,
                (now + 30,),
            )
            conn.commit()
            with mock.patch.object(governance.requests, "get") as get:
                result = governance.sync_brevo_usage(
                    conn,
                    force=True,
                    now=now,
                )
            self.assertTrue(result["stale"])
            get.assert_not_called()

    def test_stale_snapshot_waits_for_live_sync_lease_and_reloads_result(self):
        now = int(time.time())
        day = governance._quota_day(now)
        with closing(self.connect()) as conn:
            conn.execute(
                """
                UPDATE email_delivery_sync_state
                SET lease_token = 'another-process',
                    lease_expires_at = ?
                WHERE id = 1
                """,
                (now + 30,),
            )
            conn.commit()

        def finish_other_sync():
            time.sleep(0.12)
            with closing(self.connect()) as other:
                other.execute(
                    """
                    UPDATE email_delivery_provider_snapshot
                    SET report_day = ?, provider_daily_limit = 10,
                        provider_remaining_credits = 10, requests_today = 0,
                        synced_at = ?, updated_at = ?
                    WHERE id = 1
                    """,
                    (day, now, now),
                )
                other.execute(
                    """
                    UPDATE email_delivery_sync_state
                    SET lease_token = '', lease_expires_at = 0,
                        last_success_at = ?, last_error = '', updated_at = ?
                    WHERE id = 1
                    """,
                    (now, now),
                )
                other.commit()

        worker = threading.Thread(target=finish_other_sync)
        worker.start()
        try:
            with closing(self.connect()) as conn, mock.patch.object(
                governance.requests, "get"
            ) as get:
                started = time.monotonic()
                result = governance.sync_brevo_usage(conn, force=True, now=now)
                elapsed = time.monotonic() - started
        finally:
            worker.join(timeout=2)

        self.assertFalse(result["stale"])
        self.assertEqual(result["remaining_today"], 10)
        self.assertGreaterEqual(elapsed, 0.08)
        self.assertLess(elapsed, 1.5)
        get.assert_not_called()

    def test_sync_lease_covers_two_worst_case_provider_requests(self):
        now = int(time.time())
        observed_expiry = []

        def inspect_lease(*args, **kwargs):
            with closing(self.connect()) as observer:
                row = observer.execute(
                    "SELECT lease_expires_at FROM email_delivery_sync_state WHERE id = 1"
                ).fetchone()
                observed_expiry.append(int(row["lease_expires_at"]))
            return self.sync_responses()[len(observed_expiry) - 1]

        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=inspect_lease,
        ):
            governance.sync_brevo_usage(conn, now=now)

        # Each request may consume connect(5s) + read(7s); include a 15s margin.
        self.assertGreaterEqual(min(observed_expiry), now + (2 * (5 + 7)) + 15)

    def test_live_sync_can_use_recent_stale_snapshot_after_wait_window(self):
        now = int(time.time())
        day = governance._quota_day(now)
        os.environ["BREVO_QUOTA_SYNC_WAIT_SECONDS"] = "0.1"
        with closing(self.connect()) as conn:
            conn.execute(
                """
                UPDATE email_delivery_provider_snapshot
                SET report_day = ?, provider_daily_limit = 2,
                    provider_remaining_credits = 2, requests_today = 0,
                    synced_at = ?, updated_at = ?
                WHERE id = 1
                """,
                (day, now - 91, now - 91),
            )
            conn.execute(
                """
                UPDATE email_delivery_sync_state
                SET lease_token = 'slow-live-sync',
                    lease_expires_at = ?
                WHERE id = 1
                """,
                (now + 45,),
            )
            conn.commit()
            with mock.patch.object(governance.requests, "get") as get:
                overview = governance.sync_brevo_usage(
                    conn,
                    force=True,
                    now=now,
                )
            reserved = governance.reserve_email_delivery_attempt(
                conn,
                attempt_id="stale-while-syncing",
                idempotency_key="stale-while-syncing",
                now=now,
            )
            conn.execute(
                """
                UPDATE email_delivery_sync_state
                SET lease_token = '', lease_expires_at = 0
                WHERE id = 1
                """
            )
            conn.commit()
            with self.assertRaises(governance.EmailDeliveryQuotaUnavailable):
                governance.reserve_email_delivery_attempt(
                    conn,
                    attempt_id="stale-without-sync",
                    idempotency_key="stale-without-sync",
                    now=now,
                )

        self.assertTrue(overview["stale"])
        self.assertTrue(reserved["delivery_owned"])
        get.assert_not_called()

    def test_failed_sync_uses_cross_process_backoff_before_retrying(self):
        now = int(time.time())
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=requests.Timeout("provider unavailable"),
        ):
            with self.assertRaises(governance.EmailDeliverySyncError):
                governance.sync_brevo_usage(conn, now=now)

        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
        ) as get:
            result = governance.sync_brevo_usage(conn, now=now + 1)

        self.assertTrue(result["stale"])
        self.assertIn("network failure", result["sync_error"])
        get.assert_not_called()

    def test_atomic_reservation_and_attempt_boundaries(self):
        now = int(time.time())
        day = governance._quota_day(now)
        with closing(self.connect()) as conn:
            conn.execute(
                """
                UPDATE email_delivery_provider_snapshot
                SET report_day = ?, provider_daily_limit = 1,
                    provider_remaining_credits = 1, requests_today = 0,
                    synced_at = ?, updated_at = ?
                WHERE id = 1
                """,
                (day, now, now),
            )
            conn.commit()
            reserved = governance.reserve_email_delivery_attempt(
                conn,
                attempt_id="attempt-one",
                idempotency_key="key-one",
                recipient="recipient@example.com",
                purpose="verification",
                now=now,
            )
            self.assertEqual(reserved["status"], "reserved")
            with self.assertRaises(governance.EmailDeliveryQuotaExceeded):
                governance.reserve_email_delivery_attempt(
                    conn,
                    attempt_id="attempt-two",
                    idempotency_key="key-two",
                    now=now,
                )
            failed = governance.mark_email_delivery_attempt(
                conn,
                "attempt-one",
                "failed",
                error_code="http_400",
                now=now + 1,
            )
            self.assertEqual(failed["status"], "failed")
            second = governance.reserve_email_delivery_attempt(
                conn,
                attempt_id="attempt-two",
                idempotency_key="key-two",
                now=now + 2,
            )
            governance.mark_email_delivery_attempt(
                conn,
                "attempt-two",
                "unknown",
                error_code="transport_error",
                now=now + 3,
            )
            overview = governance.get_email_delivery_overview(conn, now + 3)

        self.assertEqual(second["status"], "reserved")
        self.assertEqual(overview["local_failed"], 1)
        self.assertEqual(overview["local_unknown"], 1)
        self.assertEqual(overview["remaining_today"], 0)

    def test_concurrent_workers_cannot_reserve_past_the_daily_limit(self):
        now = int(time.time())
        day = governance._quota_day(now)
        with closing(self.connect()) as conn:
            conn.execute(
                """
                UPDATE email_delivery_provider_snapshot
                SET report_day = ?, provider_daily_limit = 3,
                    provider_remaining_credits = 3, requests_today = 0,
                    synced_at = ?, updated_at = ?
                WHERE id = 1
                """,
                (day, now, now),
            )
            conn.commit()

        barrier = threading.Barrier(5)

        def reserve(index: int) -> str:
            with closing(self.connect()) as conn:
                barrier.wait(timeout=3)
                try:
                    governance.reserve_email_delivery_attempt(
                        conn,
                        attempt_id=f"parallel-attempt-{index}",
                        idempotency_key=f"parallel-key-{index}",
                        now=now,
                    )
                except governance.EmailDeliveryQuotaExceeded:
                    return "limited"
                return "reserved"

        with ThreadPoolExecutor(max_workers=5) as executor:
            outcomes = list(executor.map(reserve, range(5)))

        self.assertEqual(outcomes.count("reserved"), 3)
        self.assertEqual(outcomes.count("limited"), 2)
        with closing(self.connect()) as conn:
            overview = governance.get_email_delivery_overview(conn, now)
        self.assertEqual(overview["local_reserved"], 3)
        self.assertEqual(overview["remaining_today"], 0)

    def test_same_idempotency_key_has_one_sender_owner_and_safe_recovery(self):
        now = int(time.time())
        day = governance._quota_day(now)
        with closing(self.connect()) as conn:
            conn.execute(
                """
                UPDATE email_delivery_provider_snapshot
                SET report_day = ?, provider_daily_limit = 3,
                    provider_remaining_credits = 3, requests_today = 0,
                    synced_at = ?, updated_at = ?
                WHERE id = 1
                """,
                (day, now, now),
            )
            conn.commit()
            first = governance.reserve_email_delivery_attempt(
                conn,
                attempt_id="same-attempt",
                idempotency_key="same-key",
                recipient="same@example.com",
                purpose="verification",
                owner_token="owner-one",
                now=now,
            )
            second = governance.reserve_email_delivery_attempt(
                conn,
                attempt_id="same-attempt",
                idempotency_key="same-key",
                recipient="same@example.com",
                purpose="verification",
                owner_token="owner-two",
                now=now + 1,
            )
            recovered = governance.reserve_email_delivery_attempt(
                conn,
                attempt_id="same-attempt",
                idempotency_key="same-key",
                recipient="same@example.com",
                purpose="verification",
                owner_token="owner-two",
                now=now + 31,
            )
            with self.assertRaises(governance.EmailDeliveryAttemptConflict):
                governance.mark_email_delivery_attempt(
                    conn,
                    "same-attempt",
                    "failed",
                    owner_token="owner-one",
                    error_code="late_old_owner",
                    now=now + 32,
                )
            accepted = governance.mark_email_delivery_attempt(
                conn,
                "same-attempt",
                "accepted",
                owner_token="owner-two",
                message_id="<recovered@brevo>",
                now=now + 32,
            )

        self.assertTrue(first["delivery_owned"])
        self.assertFalse(first["delivery_recovered"])
        self.assertFalse(second["delivery_owned"])
        self.assertTrue(recovered["delivery_owned"])
        self.assertTrue(recovered["delivery_recovered"])
        self.assertEqual(accepted["status"], "accepted")

    def test_concurrent_same_idempotency_sends_only_once(self):
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(credits=3, requests_count=0),
        ):
            governance.sync_brevo_usage(conn)

        post_started = threading.Event()
        release_post = threading.Event()
        post_calls = []

        def send_once(*args, **kwargs):
            post_calls.append(kwargs["json"]["to"][0]["email"])
            post_started.set()
            release_post.wait(timeout=2)
            return _response(201, {"messageId": "<only-once@brevo>"})

        errors = []

        def send():
            try:
                auth_email.send_verification_email(
                    "same@gmail.com",
                    "123456",
                    idempotency_key="concurrent-same-attempt",
                )
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        with mock.patch.object(auth_email.requests, "post", side_effect=send_once):
            first = threading.Thread(target=send)
            second = threading.Thread(target=send)
            first.start()
            self.assertTrue(post_started.wait(timeout=2))
            second.start()
            time.sleep(0.15)
            release_post.set()
            first.join(timeout=3)
            second.join(timeout=3)

        self.assertFalse(errors)
        self.assertEqual(post_calls, ["same@gmail.com"])
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT status, provider_message_id
                FROM email_delivery_attempts
                WHERE idempotency_key = 'concurrent-same-attempt'
                """
            ).fetchone()
        self.assertEqual(row["status"], "accepted")
        self.assertEqual(row["provider_message_id"], "<only-once@brevo>")

    def test_duplicate_sender_waits_past_two_seconds_without_invalidating_attempt(self):
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(credits=3, requests_count=0),
        ):
            governance.sync_brevo_usage(conn)

        post_started = threading.Event()
        release_post = threading.Event()
        post_calls = []
        durations = []
        errors = []

        def slow_send(*args, **kwargs):
            post_calls.append(1)
            post_started.set()
            release_post.wait(timeout=4)
            return _response(201, {"messageId": "<slow-only-once@brevo>"})

        def send():
            started = time.monotonic()
            try:
                auth_email.send_verification_email(
                    "slow-same@gmail.com",
                    "123456",
                    idempotency_key="slow-concurrent-same-attempt",
                )
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)
            finally:
                durations.append(time.monotonic() - started)

        with mock.patch.object(auth_email.requests, "post", side_effect=slow_send):
            first = threading.Thread(target=send)
            second = threading.Thread(target=send)
            first.start()
            self.assertTrue(post_started.wait(timeout=2))
            second.start()
            time.sleep(2.2)
            self.assertTrue(second.is_alive())
            release_post.set()
            first.join(timeout=4)
            second.join(timeout=4)

        self.assertFalse(errors)
        self.assertEqual(post_calls, [1])
        self.assertGreaterEqual(max(durations), 2.0)
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT status
                FROM email_delivery_attempts
                WHERE idempotency_key = 'slow-concurrent-same-attempt'
                """
            ).fetchone()
        self.assertEqual(row["status"], "accepted")

    def test_sqlite_write_lock_is_converted_to_controlled_governance_error(self):
        now = int(time.time())
        day = governance._quota_day(now)
        with closing(self.connect()) as setup:
            setup.execute(
                """
                UPDATE email_delivery_provider_snapshot
                SET report_day = ?, provider_daily_limit = 1,
                    provider_remaining_credits = 1, requests_today = 0,
                    synced_at = ?, updated_at = ?
                WHERE id = 1
                """,
                (day, now, now),
            )
            setup.commit()

        with closing(self.connect()) as blocker, closing(self.connect()) as contender:
            blocker.execute("BEGIN IMMEDIATE")
            contender.execute("PRAGMA busy_timeout=1")
            with self.assertRaises(governance.EmailDeliveryGovernanceError) as exc:
                governance.reserve_email_delivery_attempt(
                    contender,
                    attempt_id="busy-attempt",
                    idempotency_key="busy-key",
                    now=now,
                )
            blocker.rollback()

        self.assertIsInstance(exc.exception.__cause__, sqlite3.OperationalError)

    def test_provider_success_does_not_become_false_failure_when_recording_is_busy(self):
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(credits=1, requests_count=0),
        ):
            governance.sync_brevo_usage(conn)

        with mock.patch.object(
            auth_email.requests,
            "post",
            return_value=_response(201, {"messageId": "<accepted@brevo>"}),
        ), mock.patch.object(
            auth_email,
            "mark_email_delivery_attempt",
            side_effect=sqlite3.OperationalError("database is locked"),
        ):
            auth_email.send_verification_email(
                "accepted@gmail.com",
                "123456",
                idempotency_key="accepted-record-busy",
            )

    def test_recovered_attempt_does_not_release_quota_on_provider_400(self):
        now = int(time.time())
        day = governance._quota_day(now)
        attempt_key = "recovered-provider-400"
        attempt_id = str(
            auth_email.uuid.uuid5(
                auth_email.uuid.NAMESPACE_URL,
                f"vecto-brevo-delivery/{attempt_key}",
            )
        )
        with closing(self.connect()) as conn:
            conn.execute(
                """
                UPDATE email_delivery_provider_snapshot
                SET report_day = ?, provider_daily_limit = 1,
                    provider_remaining_credits = 1, requests_today = 0,
                    synced_at = ?, updated_at = ?
                WHERE id = 1
                """,
                (day, now, now),
            )
            conn.commit()
            governance.reserve_email_delivery_attempt(
                conn,
                attempt_id=attempt_id,
                idempotency_key=attempt_key,
                recipient="recovered@gmail.com",
                purpose="verification",
                owner_token="crashed-owner",
                now=now - 31,
            )

        with mock.patch.object(
            auth_email.requests,
            "post",
            return_value=_response(400, {}),
        ):
            with self.assertRaises(auth_email.VerificationDeliveryError):
                auth_email.send_verification_email(
                    "recovered@gmail.com",
                    "123456",
                    idempotency_key=attempt_key,
                )

        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT status, error_code
                FROM email_delivery_attempts
                WHERE idempotency_key = ?
                """,
                (attempt_key,),
            ).fetchone()
        self.assertEqual(row["status"], "unknown")
        self.assertEqual(row["error_code"], "http_400")

    def test_brevo_201_records_message_id_and_5xx_stays_unknown(self):
        sync_success = self.sync_responses(credits=2, requests_count=0)
        accepted = _response(201, {"messageId": "<accepted@brevo>"})
        with mock.patch.object(
            governance.requests,
            "get",
            side_effect=sync_success,
        ), mock.patch.object(auth_email.requests, "post", return_value=accepted):
            auth_email.send_verification_email(
                "recipient@gmail.com",
                "123456",
                idempotency_key="accepted-attempt",
            )
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT status, provider_message_id
                FROM email_delivery_attempts
                WHERE idempotency_key = 'accepted-attempt'
                """
            ).fetchone()
        self.assertEqual(row["status"], "accepted")
        self.assertEqual(row["provider_message_id"], "<accepted@brevo>")

        failure = _response(503, {})
        with mock.patch.object(auth_email.requests, "post", return_value=failure):
            with self.assertRaises(auth_email.VerificationDeliveryError):
                auth_email.send_verification_email(
                    "recipient2@gmail.com",
                    "654321",
                    idempotency_key="unknown-attempt",
                )
        with closing(self.connect()) as conn:
            unknown = conn.execute(
                """
                SELECT status, error_code
                FROM email_delivery_attempts
                WHERE idempotency_key = 'unknown-attempt'
                """
            ).fetchone()
        self.assertEqual(unknown["status"], "unknown")
        self.assertEqual(unknown["error_code"], "http_503")

    def test_transport_timeout_stays_unknown_but_explicit_400_releases(self):
        with closing(self.connect()) as conn, mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(credits=2, requests_count=0),
        ):
            governance.sync_brevo_usage(conn)
        with mock.patch.object(
            auth_email.requests,
            "post",
            side_effect=requests.Timeout("provider timeout"),
        ):
            with self.assertRaises(auth_email.VerificationDeliveryError):
                auth_email.send_verification_email(
                    "timeout@gmail.com",
                    "123456",
                    idempotency_key="timeout-attempt",
                )
        with mock.patch.object(
            auth_email.requests,
            "post",
            return_value=_response(400, {}),
        ):
            with self.assertRaises(auth_email.VerificationDeliveryError):
                auth_email.send_verification_email(
                    "rejected@gmail.com",
                    "123456",
                    idempotency_key="rejected-attempt",
                )
        with closing(self.connect()) as conn:
            statuses = {
                row["idempotency_key"]: row["status"]
                for row in conn.execute(
                    "SELECT idempotency_key, status FROM email_delivery_attempts"
                )
            }
        self.assertEqual(statuses["timeout-attempt"], "unknown")
        self.assertEqual(statuses["rejected-attempt"], "failed")

    def test_exhausted_quota_maps_to_verification_rate_limit(self):
        with mock.patch.object(
            governance.requests,
            "get",
            side_effect=self.sync_responses(credits=0, requests_count=0),
        ):
            with self.assertRaises(auth_email.VerificationRateLimitError) as exc:
                auth_email.send_verification_email(
                    "limited@gmail.com",
                    "123456",
                    idempotency_key="limited-attempt",
                )
        self.assertEqual(exc.exception.code, "daily_email_limit_reached")


if __name__ == "__main__":
    unittest.main()
