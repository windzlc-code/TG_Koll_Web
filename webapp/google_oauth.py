from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import os
import secrets
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from .auth_email import normalize_email


GOOGLE_SCOPES = (
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
)
DEFAULT_GOOGLE_CALLBACK_PATH = "/api/auth/google/callback"


class GoogleOAuthConfigurationError(RuntimeError):
    pass


class GoogleOAuthError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = str(code)


@dataclass(frozen=True)
class GoogleOAuthConfig:
    client_id: str
    client_secret: str
    redirect_uri: str


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def google_login_enabled() -> bool:
    """Return the environment-level kill switch (off unless explicitly enabled)."""

    return _truthy(os.getenv("GOOGLE_OAUTH_ENABLED", ""))


def oauth_token_digest(token: str) -> str:
    clean_token = str(token or "").strip()
    if not clean_token:
        raise ValueError("OAuth token is required")
    return hashlib.sha256(clean_token.encode("utf-8")).hexdigest()


def generate_oauth_token() -> str:
    return secrets.token_urlsafe(32)


def safe_return_path(value: str | None, default: str = "/") -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return default
    parsed = urlsplit(candidate)
    if (
        not candidate.startswith("/")
        or candidate.startswith("//")
        or parsed.scheme
        or parsed.netloc
        or "\\" in candidate
    ):
        return default
    return candidate[:2048]


def _redirect_uri_from_environment() -> str:
    explicit = str(os.getenv("GOOGLE_OAUTH_REDIRECT_URI", "") or "").strip()
    if explicit:
        return explicit
    origin = str(
        os.getenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn") or ""
    ).strip().rstrip("/")
    return f"{origin}{DEFAULT_GOOGLE_CALLBACK_PATH}" if origin else ""


def _validate_redirect_uri(value: str) -> str:
    redirect_uri = str(value or "").strip()
    parsed = urlsplit(redirect_uri)
    if not parsed.scheme or not parsed.hostname or parsed.username or parsed.password:
        raise GoogleOAuthConfigurationError("invalid Google OAuth redirect URI")
    is_local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and is_local):
        raise GoogleOAuthConfigurationError(
            "Google OAuth redirect URI must use HTTPS outside local development"
        )
    if not is_local:
        try:
            ipaddress.ip_address(parsed.hostname)
        except ValueError:
            pass
        else:
            raise GoogleOAuthConfigurationError(
                "Google OAuth production redirect URI must use a domain name"
            )
    if parsed.query or parsed.fragment:
        raise GoogleOAuthConfigurationError(
            "Google OAuth redirect URI cannot contain a query or fragment"
        )
    return redirect_uri


def _load_google_config(redirect_uri: str | None = None) -> GoogleOAuthConfig:
    client_id = str(os.getenv("GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
    client_secret = str(os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "") or "")
    configured_redirect = _validate_redirect_uri(_redirect_uri_from_environment())
    requested_redirect = _validate_redirect_uri(redirect_uri or configured_redirect)
    if not hmac.compare_digest(requested_redirect, configured_redirect):
        raise GoogleOAuthConfigurationError(
            "Google OAuth redirect URI does not match the configured callback"
        )
    if not client_id or not client_secret:
        raise GoogleOAuthConfigurationError(
            "Google OAuth client credentials are not configured"
        )
    return GoogleOAuthConfig(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=configured_redirect,
    )


def google_oauth_configured() -> bool:
    try:
        _load_google_config()
    except GoogleOAuthConfigurationError:
        return False
    return True


def _google_client_config(config: GoogleOAuthConfig) -> dict[str, Any]:
    return {
        "web": {
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [config.redirect_uri],
        }
    }


def _google_pkce_verifier(config: GoogleOAuthConfig, nonce: str) -> str:
    """Derive a stable, secret-bound PKCE verifier for one short-lived flow."""

    digest = hmac.new(
        config.client_secret.encode("utf-8"),
        f"vecto-google-pkce:{nonce}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _new_google_flow(
    config: GoogleOAuthConfig,
    *,
    state: str | None = None,
    code_verifier: str | None = None,
) -> Any:
    try:
        from google_auth_oauthlib.flow import Flow
    except ImportError as exc:
        raise GoogleOAuthConfigurationError(
            "google-auth-oauthlib is not installed"
        ) from exc
    flow = Flow.from_client_config(
        _google_client_config(config),
        scopes=list(GOOGLE_SCOPES),
        state=state,
        code_verifier=code_verifier,
        autogenerate_code_verifier=False,
    )
    flow.redirect_uri = config.redirect_uri
    return flow


def _require_random_token(value: str, label: str) -> str:
    token = str(value or "").strip()
    if len(token) < 32 or len(token) > 512:
        raise ValueError(f"{label} must be a strong random token")
    return token


def create_google_authorization(
    state: str,
    nonce: str,
    redirect_uri: str,
) -> str:
    """Build a Google OIDC authorization URL without requesting refresh access."""

    clean_state = _require_random_token(state, "state")
    clean_nonce = _require_random_token(nonce, "nonce")
    config = _load_google_config(redirect_uri)
    flow = _new_google_flow(
        config,
        state=clean_state,
        code_verifier=_google_pkce_verifier(config, clean_nonce),
    )
    authorization_url, returned_state = flow.authorization_url(
        access_type="online",
        prompt="select_account",
        nonce=clean_nonce,
    )
    if not hmac.compare_digest(str(returned_state), clean_state):
        raise GoogleOAuthError("state_generation_failed", "OAuth state mismatch")
    return str(authorization_url)


def _verify_google_id_token(
    encoded_id_token: str,
    config: GoogleOAuthConfig,
    expected_nonce: str,
    *,
    token_verifier: Callable[[str, Any, str], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    if token_verifier is None:
        try:
            from google.auth.transport.requests import Request as GoogleRequest
            from google.oauth2 import id_token as google_id_token
        except ImportError as exc:
            raise GoogleOAuthConfigurationError("google-auth is not installed") from exc

        request_adapter = GoogleRequest()

        def verify(token: str, request: Any, audience: str) -> Mapping[str, Any]:
            return google_id_token.verify_oauth2_token(
                token,
                request,
                audience,
                clock_skew_in_seconds=30,
            )

        token_verifier = verify
    else:
        request_adapter = None

    try:
        payload = dict(
            token_verifier(encoded_id_token, request_adapter, config.client_id)
        )
    except Exception as exc:
        raise GoogleOAuthError(
            "id_token_invalid",
            "Google ID token verification failed",
        ) from exc

    nonce_claim = str(payload.get("nonce") or "")
    if not nonce_claim or not hmac.compare_digest(nonce_claim, expected_nonce):
        raise GoogleOAuthError("nonce_mismatch", "Google ID token nonce mismatch")
    subject = str(payload.get("sub") or "").strip()
    if not subject or len(subject) > 255:
        raise GoogleOAuthError("subject_invalid", "Google account subject is invalid")
    if payload.get("email_verified") is not True:
        raise GoogleOAuthError(
            "email_not_verified",
            "Google account email is not verified",
        )
    try:
        email = normalize_email(str(payload.get("email") or ""))
    except ValueError as exc:
        raise GoogleOAuthError(
            "email_invalid",
            "Google account email is invalid",
        ) from exc

    return {
        "sub": subject,
        "email": email,
        "email_verified": True,
        "name": str(payload.get("name") or "")[:500],
        "picture": str(payload.get("picture") or "")[:2048],
    }


def exchange_google_code(
    code: str,
    redirect_uri: str,
    nonce: str,
) -> dict[str, Any]:
    """Exchange one authorization code and return only verified identity claims."""

    clean_code = str(code or "").strip()
    if not clean_code or len(clean_code) > 4096:
        raise GoogleOAuthError(
            "authorization_code_invalid",
            "Google authorization code is invalid",
        )
    clean_nonce = _require_random_token(nonce, "nonce")
    config = _load_google_config(redirect_uri)
    flow = _new_google_flow(
        config,
        code_verifier=_google_pkce_verifier(config, clean_nonce),
    )
    try:
        token = flow.fetch_token(code=clean_code)
    except Warning as exc:
        # Google can return canonical userinfo scope URLs for the requested
        # email/profile aliases. oauthlib raises a Warning for that equivalent
        # scope spelling; accept it only when every requested identity scope is
        # still present. The verified ID token remains the source of identity.
        warning_token = getattr(exc, "token", None)
        returned_scopes = set(getattr(exc, "new_scope", ()) or ())
        required_scope_aliases = (
            {"openid"},
            {"email", "https://www.googleapis.com/auth/userinfo.email"},
            {"profile", "https://www.googleapis.com/auth/userinfo.profile"},
        )
        if not isinstance(warning_token, Mapping) or not all(
            returned_scopes.intersection(aliases)
            for aliases in required_scope_aliases
        ):
            raise GoogleOAuthError(
                "token_exchange_failed",
                "Google authorization code exchange failed",
            ) from exc
        token = warning_token
    except Exception as exc:
        raise GoogleOAuthError(
            "token_exchange_failed",
            "Google authorization code exchange failed",
        ) from exc
    encoded_id_token = str(token.get("id_token") or "")
    if not encoded_id_token:
        raise GoogleOAuthError(
            "id_token_missing",
            "Google did not return an ID token",
        )
    return _verify_google_id_token(
        encoded_id_token,
        config,
        clean_nonce,
    )
