import json
import os
import unittest
from types import SimpleNamespace
from unittest import mock

from webapp import google_oauth


class GoogleOAuthTokenExchangeTests(unittest.TestCase):
    REDIRECT_URI = "https://www.vecto-ai.cn/api/auth/google/callback"
    ENV = {
        "GOOGLE_OAUTH_CLIENT_ID": "test.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "test-secret",
        "GOOGLE_OAUTH_REDIRECT_URI": REDIRECT_URI,
    }

    @staticmethod
    def _token_response(scope: str):
        return SimpleNamespace(
            status_code=200,
            text=json.dumps(
                {
                    "access_token": "access-token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": scope,
                    "id_token": "encoded-id-token",
                }
            ),
            headers={},
            request=SimpleNamespace(
                url="https://oauth2.googleapis.com/token",
                headers={},
                body="",
            ),
        )

    @mock.patch.dict(os.environ, ENV, clear=True)
    def test_exchange_accepts_google_canonical_userinfo_scopes(self):
        nonce = "n" * 43
        expected = {
            "sub": "subject",
            "email": "user@gmail.com",
            "email_verified": True,
            "name": "User",
            "picture": "",
        }
        response = self._token_response(
            "openid "
            "https://www.googleapis.com/auth/userinfo.email "
            "https://www.googleapis.com/auth/userinfo.profile"
        )

        with (
            mock.patch(
                "requests_oauthlib.OAuth2Session.request",
                return_value=response,
            ),
            mock.patch.object(
                google_oauth,
                "_verify_google_id_token",
                return_value=expected,
            ) as verify,
        ):
            result = google_oauth.exchange_google_code(
                "callback-code",
                self.REDIRECT_URI,
                nonce,
            )

        self.assertEqual(result, expected)
        verify.assert_called_once()
        self.assertEqual(verify.call_args.args[0], "encoded-id-token")
        self.assertEqual(verify.call_args.args[2], nonce)

    @mock.patch.dict(os.environ, ENV, clear=True)
    def test_exchange_rejects_scope_change_missing_profile(self):
        response = self._token_response(
            "openid https://www.googleapis.com/auth/userinfo.email"
        )
        with (
            mock.patch(
                "requests_oauthlib.OAuth2Session.request",
                return_value=response,
            ),
            self.assertRaises(google_oauth.GoogleOAuthError) as raised,
        ):
            google_oauth.exchange_google_code(
                "callback-code",
                self.REDIRECT_URI,
                "n" * 43,
            )

        self.assertEqual(raised.exception.code, "token_exchange_failed")


if __name__ == "__main__":
    unittest.main()
