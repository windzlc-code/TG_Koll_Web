import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp import db as db_module
from webapp import google_oauth
import webapp.server as server


class VerifiedEmailGoogleAuthTests(unittest.TestCase):
    ENV_KEYS = (
        "APP_DB_PATH",
        "APP_RUNTIME_CONFIG_PATH",
        "WEBAPP_DATA_DIR",
        "ADMIN_BOOTSTRAP_PASSWORD",
        "SESSION_COOKIE_SECURE",
        "PASSWORD_VAULT_KEY",
        "PASSWORD_VAULT_KEY_FILE",
        "EMAIL_REGISTRATION_ENABLED",
        "AUTH_VERIFICATION_SECRET",
        "SMTP_HOST",
        "SMTP_USERNAME",
        "SMTP_APP_PASSWORD",
        "SMTP_FROM_ADDRESS",
        "EMAIL_DELIVERY_PROVIDER",
        "BREVO_API_KEY",
        "BREVO_FROM_ADDRESS",
        "BREVO_TIMEOUT_SECONDS",
        "GOOGLE_OAUTH_ENABLED",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REDIRECT_URI",
        "HTTPS_CANONICAL_ORIGIN",
    )

    def setUp(self):
        self.old_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        self.old_runtime_path = server.RUNTIME_CONFIG_PATH
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmpdir.name)
        os.environ.update(
            {
                "APP_DB_PATH": str(self.data_dir / "app.db"),
                "APP_RUNTIME_CONFIG_PATH": str(self.data_dir / "runtime.json"),
                "WEBAPP_DATA_DIR": str(self.data_dir),
                "ADMIN_BOOTSTRAP_PASSWORD": "admin123secure",
                "SESSION_COOKIE_SECURE": "0",
                "PASSWORD_VAULT_KEY": Fernet.generate_key().decode("ascii"),
                "EMAIL_REGISTRATION_ENABLED": "1",
                "AUTH_VERIFICATION_SECRET": "verification-secret-with-at-least-32-bytes",
                "SMTP_HOST": "smtp.gmail.com",
                "SMTP_USERNAME": "sender@gmail.com",
                "SMTP_APP_PASSWORD": "test-app-password",
                "SMTP_FROM_ADDRESS": "sender@gmail.com",
                "GOOGLE_OAUTH_ENABLED": "1",
                "GOOGLE_OAUTH_CLIENT_ID": "test-client.apps.googleusercontent.com",
                "GOOGLE_OAUTH_CLIENT_SECRET": "test-client-secret",
                "GOOGLE_OAUTH_REDIRECT_URI": "https://www.vecto-ai.cn/api/auth/google/callback",
                "HTTPS_CANONICAL_ORIGIN": "https://www.vecto-ai.cn",
            }
        )
        os.environ.pop("PASSWORD_VAULT_KEY_FILE", None)
        os.environ.pop("EMAIL_DELIVERY_PROVIDER", None)
        os.environ.pop("BREVO_API_KEY", None)
        os.environ.pop("BREVO_FROM_ADDRESS", None)
        os.environ.pop("BREVO_TIMEOUT_SECONDS", None)
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime.json"
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        self.app = server.create_app()
        self.admin = TestClient(self.app)
        login = self.admin.post(
            "/api/auth/admin-login",
            json={"username": "admin", "password": "admin123secure"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        enabled = self.admin.put(
            "/api/admin/runtime_config",
            json={
                "auth_email_registration_enabled": True,
                "auth_google_login_enabled": True,
            },
        )
        self.assertEqual(enabled.status_code, 200, enabled.text)

    def tearDown(self):
        server.RUNTIME_CONFIG_PATH = self.old_runtime_path
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmpdir.cleanup()

    def _register_email_user(
        self,
        *,
        email: str = "new.user@gmail.com",
        username: str = "email-user",
    ) -> TestClient:
        client = TestClient(self.app)
        delivered = {}

        def capture(recipient, code, ttl_seconds, *, idempotency_key=""):
            delivered.update(
                email=recipient,
                code=code,
                ttl=ttl_seconds,
                idempotency_key=idempotency_key,
            )

        with mock.patch.object(server, "send_verification_email", side_effect=capture):
            sent = client.post(
                "/api/auth/email-verification/send",
                headers={"Origin": "http://testserver"},
                json={"email": email, "purpose": "register"},
            )
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(delivered["idempotency_key"], sent.json()["challenge_id"])
        registered = client.post(
            "/api/auth/register",
            headers={"Origin": "http://testserver"},
            json={
                "email": email,
                "challenge_id": sent.json()["challenge_id"],
                "verification_code": delivered["code"],
                "username": username,
                "password": "registered-pass-123",
                "full_name": "Verified Email User",
                "company": "Vecto QA",
                "use_case": "OPC導入",
                "consent": True,
            },
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        self.assertEqual(registered.json()["approval_status"], "approved")
        self.assertIsNotNone(client.cookies.get("session_token"))
        return client

    def test_verified_email_registration_auto_activates_and_email_login_works(self):
        client = self._register_email_user()
        me = client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["username"], "email-user")

        by_email = TestClient(self.app).post(
            "/api/auth/login",
            json={
                "username": "NEW.USER@gmail.com",
                "password": "registered-pass-123",
                "force_takeover": True,
            },
        )
        self.assertEqual(by_email.status_code, 200, by_email.text)
        self.assertEqual(by_email.json()["username"], "email-user")

        with db_module.db() as conn:
            user = conn.execute(
                "SELECT * FROM users WHERE username = 'email-user'"
            ).fetchone()
            verified = conn.execute(
                "SELECT * FROM user_auth_emails WHERE user_id = ?",
                (int(user["id"]),),
            ).fetchone()
            wallet = conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                (int(user["id"]),),
            ).fetchone()
            welcome = conn.execute(
                "SELECT title, body FROM user_notifications WHERE user_id = ? AND source_key = 'welcome-credit-v1'",
                (int(user["id"]),),
            ).fetchone()
            challenge = conn.execute(
                "SELECT code_digest, consumed_at FROM email_verification_challenges"
            ).fetchone()
        self.assertEqual(user["approval_status"], "approved")
        self.assertEqual(int(user["is_disabled"]), 0)
        self.assertEqual(int(wallet["credit_units"]), 5 * server.commercial_billing.POINT_SCALE)
        self.assertIn("5", str(welcome["title"]))
        self.assertEqual(user["full_name"], "Verified Email User")
        self.assertEqual(user["phone"], "")
        self.assertEqual(user["company"], "Vecto QA")
        self.assertEqual(user["use_case"], "OPC導入")
        self.assertEqual(verified["email_normalized"], "new.user@gmail.com")
        self.assertNotEqual(challenge["code_digest"], "")
        self.assertGreater(int(challenge["consumed_at"]), 0)

    def test_registered_email_gets_clear_registration_error(self):
        self._register_email_user(
            email="already.registered@gmail.com",
            username="already-registered",
        )
        duplicate = TestClient(self.app).post(
            "/api/auth/email-verification/send",
            headers={"Origin": "http://testserver"},
            json={
                "email": "already.registered@gmail.com",
                "purpose": "register",
            },
        )
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(
            duplicate.json()["detail"]["code"],
            "email_already_registered",
        )
        self.assertIn("请返回登录", duplicate.json()["detail"]["message"])

    def test_daily_email_quota_exhaustion_returns_429_and_invalidates_challenge(self):
        client = TestClient(self.app)
        quota_error = server.VerificationRateLimitError(
            "daily_email_limit_reached",
            "daily email delivery limit reached",
        )
        with mock.patch.object(
            server,
            "send_verification_email",
            side_effect=quota_error,
        ):
            response = client.post(
                "/api/auth/email-verification/send",
                headers={"Origin": "http://testserver"},
                json={"email": "daily-limit@gmail.com", "purpose": "register"},
            )
        self.assertEqual(response.status_code, 429, response.text)
        self.assertEqual(
            response.json()["detail"]["code"],
            "daily_email_limit_reached",
        )
        with db_module.db() as conn:
            challenge = conn.execute(
                """
                SELECT send_status, invalidated_at
                FROM email_verification_challenges
                WHERE email_normalized = 'daily-limit@gmail.com'
                """
            ).fetchone()
        self.assertEqual(str(challenge["send_status"]), "failed")
        self.assertGreater(int(challenge["invalidated_at"]), 0)

    def test_verification_failures_persist_and_invalidate_the_challenge(self):
        client = TestClient(self.app)
        with mock.patch.object(server, "send_verification_email"):
            sent = client.post(
                "/api/auth/email-verification/send",
                headers={"Origin": "http://testserver"},
                json={
                    "email": "guess-limit@gmail.com",
                    "purpose": "register",
                },
            )
        self.assertEqual(sent.status_code, 200, sent.text)
        challenge_id = sent.json()["challenge_id"]
        payload = {
            "email": "guess-limit@gmail.com",
            "challenge_id": challenge_id,
            "verification_code": "000000",
            "username": "guess-limit",
            "password": "registered-pass-123",
            "full_name": "Guess Limit User",
            "company": "",
            "use_case": "算力計費",
            "consent": True,
        }
        for attempt in range(5):
            failed = client.post(
                "/api/auth/register",
                headers={"Origin": "http://testserver"},
                json=payload,
            )
            self.assertEqual(failed.status_code, 400, failed.text)
            expected = (
                "challenge_attempts_exceeded"
                if attempt == 4
                else "verification_code_invalid"
            )
            self.assertEqual(failed.json()["detail"]["code"], expected)
        with server.db() as conn:
            row = conn.execute(
                """
                SELECT attempt_count, invalidated_at
                FROM email_verification_challenges
                WHERE id = ?
                """,
                (challenge_id,),
            ).fetchone()
        self.assertEqual(int(row["attempt_count"]), 5)
        self.assertGreater(int(row["invalidated_at"]), 0)

    def test_registration_requires_profile_fields_and_consent(self):
        base_payload = {
            "email": "required-fields@gmail.com",
            "challenge_id": "not-used-for-profile-validation",
            "verification_code": "123456",
            "username": "required-fields",
            "password": "registered-pass-123",
            "full_name": "Required Fields",
            "company": "",
            "use_case": "私域轉化",
            "consent": True,
        }
        for field, value, expected_code in (
            ("full_name", "", "full_name_invalid"),
            ("use_case", "", "use_case_invalid"),
            ("consent", False, "consent_required"),
        ):
            with self.subTest(field=field):
                payload = dict(base_payload)
                payload[field] = value
                response = TestClient(self.app).post(
                    "/api/auth/register",
                    headers={"Origin": "http://testserver"},
                    json=payload,
                )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["detail"]["code"], expected_code)

    def test_profile_email_is_not_a_verified_login_identifier(self):
        applicant = TestClient(self.app)
        applied = applicant.post(
            "/api/auth/apply",
            json={
                "username": "legacy-user",
                "password": "legacy-pass-123",
                "full_name": "Legacy User",
                "email": "legacy@gmail.com",
                "phone": "0912345678",
                "company": "Vecto",
                "use_case": "legacy compatibility",
            },
        )
        self.assertEqual(applied.status_code, 200, applied.text)
        approved = self.admin.post(
            f"/api/admin/users/{applied.json()['id']}/approval",
            json={"approval_status": "approved", "expected_approval_status": "pending"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        email_login = TestClient(self.app).post(
            "/api/auth/login",
            json={"username": "legacy@gmail.com", "password": "legacy-pass-123"},
        )
        self.assertEqual(email_login.status_code, 401, email_login.text)

    def test_google_new_user_onboarding_then_existing_identity_login(self):
        captured = {}

        def authorization_url(state, nonce, redirect_uri):
            captured.update(state=state, nonce=nonce, redirect_uri=redirect_uri)
            return f"https://accounts.google.test/auth?state={state}"

        client = TestClient(self.app)
        with mock.patch.object(
            server,
            "create_google_authorization",
            side_effect=authorization_url,
        ):
            started = client.get(
                "/api/auth/google/start?return_url=%2Fpricing.html",
                follow_redirects=False,
            )
        self.assertEqual(started.status_code, 302, started.text)
        self.assertEqual(
            captured["redirect_uri"],
            "https://www.vecto-ai.cn/api/auth/google/callback",
        )
        claims = {
            "sub": "google-subject-1",
            "email": "google.user@gmail.com",
            "email_verified": True,
            "name": "Google User",
            "picture": "https://example.com/avatar.png",
        }
        with mock.patch.object(server, "exchange_google_code", return_value=claims):
            callback = client.get(
                f"/api/auth/google/callback?state={captured['state']}&code=code-1",
                follow_redirects=False,
            )
        self.assertEqual(callback.status_code, 302, callback.text)
        callback_query = parse_qs(urlsplit(callback.headers["location"]).query)
        self.assertEqual(callback_query["google_setup"], ["1"])
        self.assertEqual(callback_query["return_url"], ["/pricing.html"])

        completed = client.post(
            "/api/auth/google/complete",
            headers={"Origin": "http://testserver"},
            json={"username": "google-user"},
        )
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertFalse(completed.json()["password_login_enabled"])
        self.assertIsNotNone(client.cookies.get("session_token"))
        me = client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertFalse(me.json()["password_login_enabled"])
        self.assertEqual(me.json()["verified_email"], "google.user@gmail.com")
        self.assertEqual(me.json()["avatar_url"], "https://example.com/avatar.png")
        with db_module.db() as conn:
            google_user = conn.execute(
                "SELECT id FROM users WHERE username = 'google-user'"
            ).fetchone()
            wallet = conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                (int(google_user["id"]),),
            ).fetchone()
            welcome = conn.execute(
                "SELECT title FROM user_notifications WHERE user_id = ? AND source_key = 'welcome-credit-v1'",
                (int(google_user["id"]),),
            ).fetchone()
        self.assertEqual(int(wallet["credit_units"]), 5 * server.commercial_billing.POINT_SCALE)
        self.assertIsNotNone(welcome)

        delivered = {}

        def capture_password_code(
            recipient,
            code,
            ttl_seconds,
            *,
            idempotency_key="",
        ):
            delivered.update(
                email=recipient,
                code=code,
                ttl=ttl_seconds,
                idempotency_key=idempotency_key,
            )

        with mock.patch.object(
            server,
            "send_verification_email",
            side_effect=capture_password_code,
        ):
            sent = client.post(
                "/api/auth/email-verification/send",
                headers={"Origin": "http://testserver"},
                json={"email": "google.user@gmail.com", "purpose": "set_password"},
            )
        self.assertEqual(sent.status_code, 200, sent.text)
        password_setup = client.post(
            "/api/auth/password/setup",
            headers={"Origin": "http://testserver"},
            json={
                "challenge_id": sent.json()["challenge_id"],
                "verification_code": delivered["code"],
                "new_password": "google-local-pass-123",
            },
        )
        self.assertEqual(password_setup.status_code, 200, password_setup.text)
        local_login = TestClient(self.app).post(
            "/api/auth/login",
            json={
                "username": "google.user@gmail.com",
                "password": "google-local-pass-123",
                "force_takeover": True,
            },
        )
        self.assertEqual(local_login.status_code, 200, local_login.text)

        second = TestClient(self.app)
        captured.clear()
        with mock.patch.object(
            server,
            "create_google_authorization",
            side_effect=authorization_url,
        ):
            started_again = second.get(
                "/api/auth/google/start?return_url=%2Fabout-vecto.html",
                follow_redirects=False,
            )
        self.assertEqual(started_again.status_code, 302, started_again.text)
        with mock.patch.object(server, "exchange_google_code", return_value=claims):
            logged_in = second.get(
                f"/api/auth/google/callback?state={captured['state']}&code=code-2",
                follow_redirects=False,
            )
        self.assertEqual(logged_in.status_code, 302, logged_in.text)
        self.assertEqual(logged_in.headers["location"], "/about-vecto.html")
        self.assertIsNotNone(second.cookies.get("session_token"))

    def test_google_account_session_authorizes_current_user_without_replacing_session(self):
        client = self._register_email_user(
            email="account.owner@gmail.com",
            username="account-owner",
        )
        original_session = client.cookies.get("session_token")
        original_me = client.get("/api/auth/me").json()
        captured = {}

        def authorization_url(state, nonce, redirect_uri):
            captured.update(state=state, nonce=nonce, redirect_uri=redirect_uri)
            return f"https://accounts.google.test/auth?state={state}"

        with mock.patch.object(
            server,
            "create_google_authorization",
            side_effect=authorization_url,
        ):
            started = client.get(
                "/api/auth/google/account-session/start",
                follow_redirects=False,
            )
        self.assertEqual(started.status_code, 302, started.text)
        self.assertEqual(
            captured["redirect_uri"],
            "https://www.vecto-ai.cn/api/auth/google/callback",
        )

        claims = {
            "sub": "google-account-session-owner",
            "email": "linked.google.account@gmail.com",
            "email_verified": True,
            "name": "Account Owner",
            "picture": "https://example.com/account-owner.png",
        }
        with mock.patch.object(server, "exchange_google_code", return_value=claims):
            callback = client.get(
                f"/api/auth/google/callback?state={captured['state']}&code=session-code",
                follow_redirects=False,
            )
        self.assertEqual(callback.status_code, 302, callback.text)
        self.assertEqual(
            callback.headers["location"],
            "/console.html?view=accounts&google_account_session=success",
        )
        self.assertEqual(client.cookies.get("session_token"), original_session)

        me = client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["id"], original_me["id"])
        self.assertEqual(me.json()["verified_email"], "account.owner@gmail.com")
        self.assertTrue(me.json()["auth_methods"]["google"]["bound"])
        self.assertTrue(me.json()["auth_methods"]["google"]["enabled"])
        self.assertEqual(
            me.json()["auth_methods"]["google"]["email"],
            "linked.google.account@gmail.com",
        )
        with db_module.db() as conn:
            identity = conn.execute(
                "SELECT user_id, provider_subject FROM oauth_identities WHERE provider = 'google'"
            ).fetchone()
        self.assertEqual(int(identity["user_id"]), int(original_me["id"]))
        self.assertEqual(identity["provider_subject"], "google-account-session-owner")

    def test_google_account_session_rebinds_verified_identity_to_current_user(self):
        original = self._register_email_user(
            email="original.google.owner@gmail.com",
            username="original-google-owner",
        )
        current = self._register_email_user(
            email="current.console.owner@gmail.com",
            username="current-console-owner",
        )
        original_user_id = int(original.get("/api/auth/me").json()["id"])
        current_user_id = int(current.get("/api/auth/me").json()["id"])
        claims = {
            "sub": "transferable-google-subject",
            "email": "original.google.owner@gmail.com",
            "email_verified": True,
            "name": "Google Owner",
            "picture": "",
        }

        def authorize(client, code):
            captured = {}

            def authorization_url(state, nonce, redirect_uri):
                captured.update(state=state, nonce=nonce, redirect_uri=redirect_uri)
                return f"https://accounts.google.test/auth?state={state}"

            with mock.patch.object(
                server,
                "create_google_authorization",
                side_effect=authorization_url,
            ):
                started = client.get(
                    "/api/auth/google/account-session/start",
                    follow_redirects=False,
                )
            self.assertEqual(started.status_code, 302, started.text)
            with mock.patch.object(server, "exchange_google_code", return_value=claims):
                return client.get(
                    f"/api/auth/google/callback?state={captured['state']}&code={code}",
                    follow_redirects=False,
                )

        first_callback = authorize(original, "original-binding")
        self.assertIn("google_account_session=success", first_callback.headers["location"])
        rebound_callback = authorize(current, "replacement-binding")
        self.assertIn("google_account_session=success", rebound_callback.headers["location"])

        with db_module.db() as conn:
            identity = conn.execute(
                "SELECT user_id FROM oauth_identities WHERE provider = 'google' AND provider_subject = ?",
                (claims["sub"],),
            ).fetchone()
        self.assertIsNotNone(identity)
        self.assertEqual(int(identity["user_id"]), current_user_id)
        self.assertNotEqual(int(identity["user_id"]), original_user_id)
        self.assertFalse(original.get("/api/auth/me").json()["auth_methods"]["google"]["bound"])
        current_google = current.get("/api/auth/me").json()["auth_methods"]["google"]
        self.assertTrue(current_google["bound"])
        self.assertEqual(current_google["email"], claims["email"])

    def test_google_account_session_preserves_admin_workspace_context(self):
        customer = self._register_email_user(
            email="managed.customer@gmail.com",
            username="managed-customer",
        )
        customer_id = int(customer.get("/api/auth/me").json()["id"])
        captured = {}

        def authorization_url(state, nonce, redirect_uri):
            captured.update(state=state, nonce=nonce, redirect_uri=redirect_uri)
            return f"https://accounts.google.test/auth?state={state}"

        with mock.patch.object(
            server,
            "create_google_authorization",
            side_effect=authorization_url,
        ):
            started = self.admin.get(
                "/api/auth/google/account-session/start",
                params={
                    "admin_console": "1",
                    "admin_workspace_user_id": str(customer_id),
                },
                follow_redirects=False,
            )
        self.assertEqual(started.status_code, 302, started.text)

        claims = {
            "sub": "google-managed-customer",
            "email": "managed.customer@gmail.com",
            "email_verified": True,
            "name": "Managed Customer",
            "picture": "",
        }
        with mock.patch.object(server, "exchange_google_code", return_value=claims):
            callback = self.admin.get(
                f"/api/auth/google/callback?state={captured['state']}&code=managed-code",
                follow_redirects=False,
            )
        self.assertEqual(callback.status_code, 302, callback.text)
        parsed = urlsplit(callback.headers["location"])
        callback_query = parse_qs(parsed.query)
        self.assertEqual(parsed.path, "/admin-console.html")
        self.assertEqual(callback_query["view"], ["accounts"])
        self.assertEqual(callback_query["admin_console"], ["1"])
        self.assertEqual(callback_query["admin_workspace_user_id"], [str(customer_id)])
        self.assertEqual(callback_query["google_account_session"], ["success"])

    def test_google_pkce_verifier_is_reused_and_equivalent_scopes_are_accepted(self):
        state = "state-token-with-more-than-thirty-two-random-characters"
        nonce = "nonce-token-with-more-than-thirty-two-random-characters"
        redirect_uri = "https://www.vecto-ai.cn/api/auth/google/callback"
        captured_verifiers = []

        class FakeFlow:
            redirect_uri = ""

            def __init__(self, verifier):
                self.verifier = verifier

            def authorization_url(self, **kwargs):
                return "https://accounts.google.test/auth", state

            def fetch_token(self, **kwargs):
                warning = Warning("equivalent Google scope aliases")
                warning.token = {"id_token": "signed-id-token"}
                warning.new_scope = {
                    "openid",
                    "https://www.googleapis.com/auth/userinfo.email",
                    "https://www.googleapis.com/auth/userinfo.profile",
                }
                raise warning

        def fake_from_client_config(client_config, scopes, **kwargs):
            captured_verifiers.append(kwargs["code_verifier"])
            self.assertFalse(kwargs["autogenerate_code_verifier"])
            return FakeFlow(kwargs["code_verifier"])

        claims = {
            "sub": "google-subject-pkce",
            "email": "pkce.user@gmail.com",
            "email_verified": True,
            "name": "PKCE User",
            "picture": "",
        }
        with (
            mock.patch(
                "google_auth_oauthlib.flow.Flow.from_client_config",
                side_effect=fake_from_client_config,
            ),
            mock.patch.object(
                google_oauth,
                "_verify_google_id_token",
                return_value=claims,
            ),
        ):
            authorization_url = google_oauth.create_google_authorization(
                state,
                nonce,
                redirect_uri,
            )
            exchanged = google_oauth.exchange_google_code(
                "authorization-code",
                redirect_uri,
                nonce,
            )

        self.assertEqual(authorization_url, "https://accounts.google.test/auth")
        self.assertEqual(exchanged, claims)
        self.assertEqual(len(captured_verifiers), 2)
        self.assertEqual(captured_verifiers[0], captured_verifiers[1])
        self.assertEqual(len(captured_verifiers[0]), 43)

    def test_google_callback_rechecks_the_global_runtime_switch(self):
        captured = {}

        def authorization_url(state, nonce, redirect_uri):
            captured.update(state=state, nonce=nonce)
            return f"https://accounts.google.test/auth?state={state}"

        client = TestClient(self.app)
        with mock.patch.object(
            server,
            "create_google_authorization",
            side_effect=authorization_url,
        ):
            started = client.get("/api/auth/google/start", follow_redirects=False)
        self.assertEqual(started.status_code, 302, started.text)
        disabled = self.admin.put(
            "/api/admin/runtime_config",
            json={
                "auth_email_registration_enabled": True,
                "auth_google_login_enabled": False,
            },
        )
        self.assertEqual(disabled.status_code, 200, disabled.text)

        with mock.patch.object(server, "exchange_google_code") as exchange:
            callback = client.get(
                f"/api/auth/google/callback?state={captured['state']}&code=unused",
                follow_redirects=False,
            )
        self.assertEqual(callback.status_code, 302, callback.text)
        self.assertIn(
            "oauth_error=google_login_unavailable",
            callback.headers["location"],
        )
        exchange.assert_not_called()

    def test_google_start_limits_pending_flows_and_cleans_expired_rows(self):
        def authorization_url(state, nonce, redirect_uri):
            return f"https://accounts.google.test/auth?state={state}"

        with server.db() as conn:
            now = server._now_ts()
            conn.execute(
                """
                INSERT INTO oauth_authorization_flows(
                  state_digest, provider, nonce_digest, flow_token_digest,
                  return_path, context_json, request_ip, expires_at,
                  consumed_at, created_at
                ) VALUES (?, 'google', ?, ?, '/', '{}', 'expired', ?, 0, ?)
                """,
                ("expired-state", "expired-nonce", "expired-flow", now - 1, now - 700),
            )

        with mock.patch.object(
            server,
            "create_google_authorization",
            side_effect=authorization_url,
        ):
            client = TestClient(self.app)
            for _ in range(10):
                response = client.get(
                    "/api/auth/google/start",
                    follow_redirects=False,
                )
                self.assertEqual(response.status_code, 302, response.text)
            blocked = client.get(
                "/api/auth/google/start",
                follow_redirects=False,
            )
        self.assertEqual(blocked.status_code, 429, blocked.text)
        with server.db() as conn:
            expired = conn.execute(
                "SELECT 1 FROM oauth_authorization_flows WHERE state_digest = 'expired-state'"
            ).fetchone()
        self.assertIsNone(expired)

    def test_password_failures_persist_and_temporary_lock_expires(self):
        self._register_email_user(
            email="lock-test@gmail.com",
            username="lock-test",
        )
        attacker = TestClient(self.app)
        for _ in range(8):
            failed = attacker.post(
                "/api/auth/login",
                json={"username": "lock-test", "password": "wrong-password"},
            )
            self.assertEqual(failed.status_code, 401, failed.text)
        with server.db() as conn:
            locked = dict(
                conn.execute(
                    """
                    SELECT is_disabled, lifecycle_reason, locked_until
                    FROM users WHERE username = ?
                    """,
                    ("lock-test",),
                ).fetchone()
            )
            self.assertEqual(locked["is_disabled"], 0)
            self.assertEqual(
                locked["lifecycle_reason"],
                "too_many_failed_logins",
            )
            self.assertGreater(
                int(locked["locked_until"]),
                server._now_ts(),
            )
            conn.execute(
                "UPDATE users SET locked_until = ? WHERE username = ?",
                (server._now_ts() - 1, "lock-test"),
            )
        with server._AUTH_RATE_LOCK:
            server._AUTH_RATE_EVENTS.clear()
        recovered = TestClient(self.app).post(
            "/api/auth/login",
            json={
                "username": "lock-test",
                "password": "registered-pass-123",
                "force_takeover": True,
            },
        )
        self.assertEqual(recovered.status_code, 200, recovered.text)

    def test_admin_sees_auth_metadata_and_cannot_remove_last_method(self):
        self._register_email_user(email="admin-view@gmail.com", username="admin-view")
        listing = self.admin.get(
            "/api/admin/users",
            params={"auth_method": "password", "email_status": "verified"},
        )
        self.assertEqual(listing.status_code, 200, listing.text)
        item = next(user for user in listing.json()["items"] if user["username"] == "admin-view")
        self.assertEqual(item["verified_email"], "admin-view@gmail.com")
        self.assertTrue(item["auth_methods"]["password"]["enabled"])
        self.assertFalse(item["auth_methods"]["google"]["bound"])

        blocked = self.admin.patch(
            f"/api/admin/users/{item['id']}/auth-methods",
            headers={"Origin": "http://testserver"},
            json={"password_login_enabled": False},
        )
        self.assertEqual(blocked.status_code, 409, blocked.text)

        runtime = self.admin.get("/api/admin/runtime_config")
        self.assertEqual(runtime.status_code, 200, runtime.text)
        self.assertTrue(runtime.json()["auth_google_oauth_configured"])
        self.assertTrue(runtime.json()["auth_smtp_configured"])
        self.assertTrue(runtime.json()["auth_email_delivery_configured"])


if __name__ == "__main__":
    unittest.main()
