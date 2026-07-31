import os
import sqlite3
import unittest
import uuid
from unittest import mock

from webapp import auth_email


class BrevoEmailDeliveryTests(unittest.TestCase):
    ENV_KEYS = (
        "AUTH_VERIFICATION_SECRET",
        "EMAIL_DELIVERY_PROVIDER",
        "BREVO_API_KEY",
        "BREVO_FROM_ADDRESS",
        "BREVO_TIMEOUT_SECONDS",
        "EMAIL_QUOTA_GOVERNANCE_ENABLED",
    )

    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        os.environ.update(
            {
                "AUTH_VERIFICATION_SECRET": (
                    "verification-secret-with-at-least-32-bytes"
                ),
                "EMAIL_DELIVERY_PROVIDER": "brevo",
                "BREVO_API_KEY": "xkeysib-test-key-with-sufficient-length",
                "BREVO_FROM_ADDRESS": "Vecto OS <noreply@mail.vecto-ai.cn>",
                "BREVO_TIMEOUT_SECONDS": "7",
                "EMAIL_QUOTA_GOVERNANCE_ENABLED": "0",
            }
        )

    def tearDown(self):
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @staticmethod
    def _challenge_db():
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE email_verification_challenges(
              id TEXT PRIMARY KEY,
              user_id INTEGER,
              email_normalized TEXT NOT NULL,
              purpose TEXT NOT NULL,
              code_digest TEXT NOT NULL,
              send_status TEXT NOT NULL,
              sent_at INTEGER NOT NULL,
              resend_available_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              attempt_count INTEGER NOT NULL,
              max_attempts INTEGER NOT NULL,
              consumed_at INTEGER NOT NULL,
              invalidated_at INTEGER NOT NULL,
              request_ip TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        return conn

    def test_brevo_is_available_with_a_valid_send_only_configuration(self):
        self.assertEqual(auth_email.email_delivery_provider(), "brevo")
        self.assertTrue(auth_email.email_delivery_available())
        self.assertTrue(auth_email.smtp_available())

    def test_removed_resend_provider_is_rejected(self):
        os.environ["EMAIL_DELIVERY_PROVIDER"] = "resend"
        with self.assertRaises(auth_email.AuthEmailConfigurationError):
            auth_email.email_delivery_provider()
        self.assertFalse(auth_email.email_delivery_available())

    def test_brevo_uses_fixed_endpoint_timeout_and_verified_sender_payload(self):
        response = mock.Mock(status_code=201)
        response.json.return_value = {
            "messageId": "<email-id-123@relay.brevo.com>"
        }
        with mock.patch.object(
            auth_email.requests,
            "post",
            return_value=response,
        ) as post:
            auth_email.send_verification_email(
                "recipient@gmail.com",
                "123456",
                600,
                idempotency_key="challenge-123",
            )

        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://api.brevo.com/v3/smtp/email")
        self.assertEqual(kwargs["timeout"], (5.0, 7.0))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["headers"]["Accept"], "application/json")
        self.assertEqual(
            kwargs["headers"]["User-Agent"],
            "Vecto-OS-Auth/1.0",
        )
        self.assertEqual(
            kwargs["json"]["to"],
            [{"email": "recipient@gmail.com"}],
        )
        self.assertEqual(
            kwargs["json"]["sender"],
            {
                "email": "noreply@mail.vecto-ai.cn",
                "name": "Vecto OS",
            },
        )
        self.assertIn("123456", kwargs["json"]["htmlContent"])
        uuid.UUID(kwargs["json"]["headers"]["idempotencyKey"])
        self.assertTrue(kwargs["headers"]["api-key"].startswith("xkeysib-"))
        self.assertNotIn("Authorization", kwargs["headers"])

    def test_brevo_accepts_common_email_provider_addresses(self):
        response = mock.Mock(status_code=201)
        response.json.return_value = {
            "messageId": "<email-id-123@relay.brevo.com>"
        }
        recipients = (
            "recipient@qq.com",
            "recipient@163.com",
            "recipient@outlook.com",
            "recipient@yahoo.com",
        )
        with mock.patch.object(
            auth_email.requests,
            "post",
            return_value=response,
        ) as post:
            for index, recipient in enumerate(recipients):
                with self.subTest(recipient=recipient):
                    auth_email.send_verification_email(
                        recipient,
                        "123456",
                        600,
                        idempotency_key=f"provider-{index}",
                    )
                    self.assertEqual(
                        post.call_args.kwargs["json"]["to"],
                        [{"email": recipient}],
                    )

    def test_provider_response_details_are_not_exposed(self):
        response = mock.Mock(status_code=401)
        response.text = "sensitive provider response"
        with mock.patch.object(
            auth_email.requests,
            "post",
            return_value=response,
        ):
            with self.assertRaisesRegex(
                auth_email.VerificationDeliveryError,
                "^verification email delivery failed$",
            ):
                auth_email.send_verification_email(
                    "recipient@gmail.com",
                    "123456",
                    600,
                )

    def test_previous_code_remains_valid_until_replacement_is_sent(self):
        conn = self._challenge_db()
        first_id, _, _ = auth_email.create_email_challenge(
            conn,
            "recipient@gmail.com",
            "registration",
            "203.0.113.10",
            1000,
        )
        self.assertTrue(auth_email.mark_challenge_sent(conn, first_id, 1001))
        replacement_id, _, _ = auth_email.create_email_challenge(
            conn,
            "recipient@gmail.com",
            "registration",
            "203.0.113.10",
            1061,
        )
        first = conn.execute(
            "SELECT invalidated_at FROM email_verification_challenges WHERE id = ?",
            (first_id,),
        ).fetchone()
        self.assertEqual(int(first["invalidated_at"]), 0)

        self.assertTrue(
            auth_email.mark_challenge_failed(conn, replacement_id, 1062)
        )
        first_after_failure = conn.execute(
            "SELECT invalidated_at FROM email_verification_challenges WHERE id = ?",
            (first_id,),
        ).fetchone()
        self.assertEqual(int(first_after_failure["invalidated_at"]), 0)

        delivered_id, _, _ = auth_email.create_email_challenge(
            conn,
            "recipient@gmail.com",
            "registration",
            "203.0.113.10",
            1122,
        )
        self.assertTrue(
            auth_email.mark_challenge_sent(conn, delivered_id, 1123)
        )
        first_after_success = conn.execute(
            "SELECT invalidated_at FROM email_verification_challenges WHERE id = ?",
            (first_id,),
        ).fetchone()
        self.assertGreater(int(first_after_success["invalidated_at"]), 0)
        conn.close()

    def test_failed_provider_attempts_still_count_toward_rate_limit(self):
        conn = self._challenge_db()
        for offset in range(5):
            created_at = 1000 + offset * 61
            challenge_id, _, _ = auth_email.create_email_challenge(
                conn,
                "recipient@gmail.com",
                "registration",
                "203.0.113.10",
                created_at,
            )
            self.assertTrue(
                auth_email.mark_challenge_failed(
                    conn,
                    challenge_id,
                    created_at + 1,
                )
            )
        with self.assertRaises(auth_email.VerificationRateLimitError) as exc:
            auth_email.create_email_challenge(
                conn,
                "recipient@gmail.com",
                "registration",
                "203.0.113.10",
                1000 + 5 * 61,
            )
        self.assertEqual(exc.exception.code, "email_rate_limited")
        conn.close()


if __name__ == "__main__":
    unittest.main()
