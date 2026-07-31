from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import smtplib
import sqlite3
import ssl
import time
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any

import requests
from email_validator import EmailNotValidError, validate_email

from .db import db
from .email_delivery_governance import (
    EmailDeliveryGovernanceError,
    EmailDeliveryQuotaExceeded,
    mark_email_delivery_attempt,
    reserve_email_delivery_attempt,
    sync_brevo_usage,
    wait_for_email_delivery_attempt,
)


VERIFICATION_CODE_DIGITS = 6
VERIFICATION_TTL_SECONDS = 10 * 60
VERIFICATION_RESEND_SECONDS = 60
VERIFICATION_MAX_ATTEMPTS = 5
VERIFICATION_EMAIL_HOURLY_LIMIT = 5
VERIFICATION_IP_HOURLY_LIMIT = 20
VERIFICATION_PURPOSES = frozenset({"registration", "password_setup", "email_binding"})
BREVO_EMAIL_API_URL = "https://api.brevo.com/v3/smtp/email"


class AuthEmailConfigurationError(RuntimeError):
    pass


class VerificationDeliveryError(RuntimeError):
    pass


class VerificationChallengeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = str(code)


class VerificationRateLimitError(VerificationChallengeError):
    pass


@dataclass(frozen=True)
class SmtpConfig:
    host: str
    port: int
    username: str
    app_password: str
    from_address: str
    timeout_seconds: float = 10.0


@dataclass(frozen=True)
class BrevoConfig:
    api_key: str
    sender_email: str
    sender_name: str
    timeout_seconds: float = 10.0


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def email_registration_enabled() -> bool:
    """Return the environment-level kill switch (off unless explicitly enabled)."""

    return _truthy(os.getenv("EMAIL_REGISTRATION_ENABLED", ""))


def email_delivery_provider() -> str:
    provider = str(os.getenv("EMAIL_DELIVERY_PROVIDER", "smtp") or "").strip().lower()
    if provider not in {"smtp", "brevo"}:
        raise AuthEmailConfigurationError("unsupported email delivery provider")
    return provider


def normalize_email(email: str) -> str:
    """Return an IDNA-aware, case-insensitive login-email key.

    Gmail-specific dot or ``+tag`` rewriting is intentionally not performed.
    Delivery of a verification code is the ownership proof, so DNS lookup is
    not needed during syntax normalization.
    """

    value = str(email or "").strip()
    if not value or len(value) > 320:
        raise ValueError("invalid email address")
    try:
        normalized = str(validate_email(value, check_deliverability=False).normalized)
    except EmailNotValidError as exc:
        raise ValueError("invalid email address") from exc
    local, separator, domain = normalized.rpartition("@")
    if not separator or not local or not domain:
        raise ValueError("invalid email address")
    normalized_key = f"{local.casefold()}@{domain.casefold()}"
    if len(normalized_key) > 320:
        raise ValueError("invalid email address")
    return normalized_key


def _verification_secret() -> bytes:
    value = str(os.getenv("AUTH_VERIFICATION_SECRET", "") or "")
    if len(value.encode("utf-8")) < 32:
        raise AuthEmailConfigurationError(
            "AUTH_VERIFICATION_SECRET must contain at least 32 bytes"
        )
    return value.encode("utf-8")


def generate_verification_code() -> str:
    return f"{secrets.randbelow(10**VERIFICATION_CODE_DIGITS):0{VERIFICATION_CODE_DIGITS}d}"


def verification_code_digest(
    challenge_id: str,
    email: str,
    purpose: str,
    code: str,
) -> str:
    clean_purpose = str(purpose or "").strip()
    if clean_purpose not in VERIFICATION_PURPOSES:
        raise ValueError("invalid verification purpose")
    clean_code = str(code or "").strip()
    if len(clean_code) != VERIFICATION_CODE_DIGITS or not clean_code.isascii() or not clean_code.isdigit():
        raise ValueError("invalid verification code")
    payload = "\x1f".join(
        (
            str(challenge_id or "").strip(),
            normalize_email(email),
            clean_purpose,
            clean_code,
        )
    ).encode("utf-8")
    return hmac.new(_verification_secret(), payload, hashlib.sha256).hexdigest()


def _raise_rate_limit(code: str, message: str) -> None:
    raise VerificationRateLimitError(code, message)


def create_email_challenge(
    conn: sqlite3.Connection,
    email: str,
    purpose: str,
    request_ip: str,
    now: int,
) -> tuple[str, str, int]:
    normalized = normalize_email(email)
    clean_purpose = str(purpose or "").strip()
    if clean_purpose not in VERIFICATION_PURPOSES:
        raise ValueError("invalid verification purpose")
    now_ts = int(now)
    clean_ip = str(request_ip or "").strip()[:64]
    hour_ago = now_ts - 3600

    email_count = int(
        conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM email_verification_challenges
            WHERE email_normalized = ? COLLATE NOCASE
              AND created_at > ?
            """,
            (normalized, hour_ago),
        ).fetchone()["count"]
    )
    if email_count >= VERIFICATION_EMAIL_HOURLY_LIMIT:
        _raise_rate_limit(
            "email_rate_limited",
            "too many verification codes requested for this email",
        )
    if clean_ip:
        ip_count = int(
            conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM email_verification_challenges
                WHERE request_ip = ?
                  AND created_at > ?
                """,
                (clean_ip, hour_ago),
            ).fetchone()["count"]
        )
        if ip_count >= VERIFICATION_IP_HOURLY_LIMIT:
            _raise_rate_limit(
                "ip_rate_limited",
                "too many verification codes requested from this address",
            )

    recent = conn.execute(
        """
        SELECT resend_available_at
        FROM email_verification_challenges
        WHERE email_normalized = ? COLLATE NOCASE
          AND purpose = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (normalized, clean_purpose),
    ).fetchone()
    if recent is not None and int(recent["resend_available_at"] or 0) > now_ts:
        _raise_rate_limit(
            "resend_too_soon",
            "verification code cannot be resent yet",
        )

    challenge_id = secrets.token_urlsafe(24)
    code = generate_verification_code()
    expires_at = now_ts + VERIFICATION_TTL_SECONDS
    digest = verification_code_digest(
        challenge_id,
        normalized,
        clean_purpose,
        code,
    )
    conn.execute(
        """
        INSERT INTO email_verification_challenges(
          id, user_id, email_normalized, purpose, code_digest, send_status,
          sent_at, resend_available_at, expires_at, attempt_count, max_attempts,
          consumed_at, invalidated_at, request_ip, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, 'pending', 0, ?, ?, 0, ?, 0, 0, ?, ?, ?)
        """,
        (
            challenge_id,
            normalized,
            clean_purpose,
            digest,
            now_ts + VERIFICATION_RESEND_SECONDS,
            expires_at,
            VERIFICATION_MAX_ATTEMPTS,
            clean_ip,
            now_ts,
            now_ts,
        ),
    )
    return challenge_id, code, expires_at


def mark_challenge_sent(
    conn: sqlite3.Connection,
    challenge_id: str,
    now: int,
) -> bool:
    now_ts = int(now)
    challenge_key = str(challenge_id or "").strip()
    row = conn.execute(
        """
        SELECT email_normalized, purpose
        FROM email_verification_challenges
        WHERE id = ?
        """,
        (challenge_key,),
    ).fetchone()
    if row is None:
        return False
    cursor = conn.execute(
        """
        UPDATE email_verification_challenges
        SET send_status = 'sent', sent_at = ?, updated_at = ?
        WHERE id = ?
          AND send_status = 'pending'
          AND invalidated_at = 0
          AND consumed_at = 0
        """,
        (now_ts, now_ts, challenge_key),
    )
    if cursor.rowcount == 1:
        conn.execute(
            """
            UPDATE email_verification_challenges
            SET invalidated_at = ?, updated_at = ?
            WHERE email_normalized = ? COLLATE NOCASE
              AND purpose = ?
              AND id != ?
              AND consumed_at = 0
              AND invalidated_at = 0
            """,
            (
                now_ts,
                now_ts,
                str(row["email_normalized"]),
                str(row["purpose"]),
                challenge_key,
            ),
        )
    return cursor.rowcount == 1


def mark_challenge_failed(
    conn: sqlite3.Connection,
    challenge_id: str,
    now: int,
) -> bool:
    now_ts = int(now)
    cursor = conn.execute(
        """
        UPDATE email_verification_challenges
        SET send_status = 'failed', invalidated_at = ?, updated_at = ?
        WHERE id = ?
          AND send_status = 'pending'
          AND consumed_at = 0
        """,
        (now_ts, now_ts, str(challenge_id or "").strip()),
    )
    return cursor.rowcount == 1


def verify_and_consume_challenge(
    conn: sqlite3.Connection,
    challenge_id: str,
    email: str,
    purpose: str,
    code: str,
    now: int,
) -> bool:
    normalized = normalize_email(email)
    clean_purpose = str(purpose or "").strip()
    if clean_purpose not in VERIFICATION_PURPOSES:
        raise ValueError("invalid verification purpose")
    now_ts = int(now)
    clean_id = str(challenge_id or "").strip()
    row = conn.execute(
        "SELECT * FROM email_verification_challenges WHERE id = ?",
        (clean_id,),
    ).fetchone()
    if row is None:
        raise VerificationChallengeError(
            "challenge_not_found",
            "verification challenge was not found",
        )
    if (
        not hmac.compare_digest(str(row["email_normalized"]), normalized)
        or not hmac.compare_digest(str(row["purpose"]), clean_purpose)
    ):
        raise VerificationChallengeError(
            "challenge_mismatch",
            "verification challenge does not match the request",
        )
    if str(row["send_status"]) != "sent":
        raise VerificationChallengeError(
            "challenge_not_sent",
            "verification challenge is not available",
        )
    if int(row["consumed_at"] or 0) > 0:
        raise VerificationChallengeError(
            "challenge_consumed",
            "verification challenge was already used",
        )
    if int(row["invalidated_at"] or 0) > 0:
        raise VerificationChallengeError(
            "challenge_invalidated",
            "verification challenge is no longer valid",
        )
    if int(row["expires_at"] or 0) <= now_ts:
        conn.execute(
            """
            UPDATE email_verification_challenges
            SET invalidated_at = ?, updated_at = ?
            WHERE id = ? AND invalidated_at = 0
            """,
            (now_ts, now_ts, clean_id),
        )
        raise VerificationChallengeError(
            "challenge_expired",
            "verification challenge has expired",
        )
    if int(row["attempt_count"] or 0) >= int(row["max_attempts"] or 0):
        raise VerificationChallengeError(
            "challenge_attempts_exceeded",
            "verification challenge has too many failed attempts",
        )

    try:
        candidate_digest = verification_code_digest(
            clean_id,
            normalized,
            clean_purpose,
            code,
        )
    except ValueError:
        candidate_digest = ""
    if not hmac.compare_digest(str(row["code_digest"]), candidate_digest):
        next_attempt = int(row["attempt_count"] or 0) + 1
        lock_at = now_ts if next_attempt >= int(row["max_attempts"] or 0) else 0
        conn.execute(
            """
            UPDATE email_verification_challenges
            SET attempt_count = attempt_count + 1,
                invalidated_at = CASE WHEN ? > 0 THEN ? ELSE invalidated_at END,
                updated_at = ?
            WHERE id = ?
              AND consumed_at = 0
              AND invalidated_at = 0
            """,
            (lock_at, lock_at, now_ts, clean_id),
        )
        error_code = (
            "challenge_attempts_exceeded"
            if lock_at
            else "verification_code_invalid"
        )
        raise VerificationChallengeError(error_code, "verification code is invalid")

    cursor = conn.execute(
        """
        UPDATE email_verification_challenges
        SET consumed_at = ?, updated_at = ?
        WHERE id = ?
          AND send_status = 'sent'
          AND consumed_at = 0
          AND invalidated_at = 0
          AND expires_at > ?
          AND attempt_count < max_attempts
        """,
        (now_ts, now_ts, clean_id, now_ts),
    )
    if cursor.rowcount != 1:
        raise VerificationChallengeError(
            "challenge_consumed",
            "verification challenge is no longer valid",
        )
    return True


def _load_smtp_config() -> SmtpConfig:
    host = str(os.getenv("SMTP_HOST", "smtp.gmail.com") or "").strip()
    username = str(os.getenv("SMTP_USERNAME", "") or "").strip()
    app_password = str(os.getenv("SMTP_APP_PASSWORD", "") or "")
    from_address_raw = str(os.getenv("SMTP_FROM_ADDRESS", "") or "").strip()
    from_address = normalize_email(from_address_raw or username) if (from_address_raw or username) else ""
    try:
        port = int(str(os.getenv("SMTP_PORT", "587") or "587"))
        timeout_seconds = float(str(os.getenv("SMTP_TIMEOUT_SECONDS", "10") or "10"))
    except (TypeError, ValueError) as exc:
        raise AuthEmailConfigurationError("invalid SMTP port or timeout") from exc
    if not host or not username or not app_password or not from_address:
        raise AuthEmailConfigurationError("SMTP credentials are not configured")
    if not 1 <= port <= 65535 or not 1 <= timeout_seconds <= 60:
        raise AuthEmailConfigurationError("invalid SMTP port or timeout")
    return SmtpConfig(
        host=host,
        port=port,
        username=username,
        app_password=app_password,
        from_address=from_address,
        timeout_seconds=timeout_seconds,
    )


def _load_brevo_config() -> BrevoConfig:
    api_key = str(os.getenv("BREVO_API_KEY", "") or "").strip()
    from_address = str(os.getenv("BREVO_FROM_ADDRESS", "") or "").strip()
    if "\r" in from_address or "\n" in from_address:
        raise AuthEmailConfigurationError("invalid Brevo sender address")
    display_name, parsed_address = parseaddr(from_address)
    try:
        normalized_address = normalize_email(parsed_address)
        timeout_seconds = float(
            str(os.getenv("BREVO_TIMEOUT_SECONDS", "10") or "10")
        )
    except (TypeError, ValueError) as exc:
        raise AuthEmailConfigurationError("invalid Brevo configuration") from exc
    if not api_key.startswith("xkeysib-") or len(api_key) < 32:
        raise AuthEmailConfigurationError("Brevo API key is not configured")
    if not from_address or not parsed_address or not 1 <= timeout_seconds <= 60:
        raise AuthEmailConfigurationError("invalid Brevo configuration")
    clean_name = " ".join(str(display_name or "").split())
    return BrevoConfig(
        api_key=api_key,
        sender_email=normalized_address,
        sender_name=clean_name,
        timeout_seconds=timeout_seconds,
    )


def email_delivery_available() -> bool:
    try:
        provider = email_delivery_provider()
        if provider == "brevo":
            _load_brevo_config()
        else:
            _load_smtp_config()
    except (AuthEmailConfigurationError, ValueError):
        return False
    return True


def email_quota_governance_enabled() -> bool:
    """Brevo quota protection is enabled by default and may be disabled in tests."""

    return _truthy(os.getenv("EMAIL_QUOTA_GOVERNANCE_ENABLED", "1"))


def smtp_available() -> bool:
    """Backward-compatible availability name used by the public policy API."""

    return email_delivery_available()


def _send_verification_email_brevo(
    config: BrevoConfig,
    recipient: str,
    code: str,
    minutes: int,
    idempotency_key: str,
) -> None:
    governance_attempt_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"vecto-brevo-delivery/{idempotency_key}",
        )
    )
    governance_owner_token = secrets.token_urlsafe(24)
    governance_recovered = False
    governance_enabled = email_quota_governance_enabled()
    if governance_enabled:
        try:
            with db() as conn:
                sync_brevo_usage(conn)
                attempt = reserve_email_delivery_attempt(
                    conn,
                    attempt_id=governance_attempt_id,
                    idempotency_key=idempotency_key,
                    recipient=recipient,
                    purpose="verification",
                    owner_token=governance_owner_token,
                )
                if str(attempt.get("status") or "") == "accepted":
                    return
                if (
                    str(attempt.get("status") or "") == "reserved"
                    and not bool(attempt.get("delivery_owned"))
                ):
                    # Follow the active sender through its full bounded network
                    # lease. Returning an error after an arbitrary short wait
                    # would let the HTTP layer invalidate the same challenge
                    # while the owner is still delivering it.
                    wait_seconds = max(
                        0.1,
                        min(
                            300.0,
                            float(
                                int(attempt.get("delivery_lease_expires_at") or 0)
                            )
                            - time.time()
                            + 0.25,
                        ),
                    )
                    attempt = wait_for_email_delivery_attempt(
                        conn,
                        governance_attempt_id,
                        timeout_seconds=wait_seconds,
                    )
                    if str(attempt.get("status") or "") == "accepted":
                        return
                    if str(attempt.get("status") or "") == "reserved":
                        attempt = reserve_email_delivery_attempt(
                            conn,
                            attempt_id=governance_attempt_id,
                            idempotency_key=idempotency_key,
                            recipient=recipient,
                            purpose="verification",
                            owner_token=governance_owner_token,
                        )
                if str(attempt.get("status") or "") != "reserved":
                    raise VerificationDeliveryError(
                        "verification email delivery failed"
                    )
                if not bool(attempt.get("delivery_owned")):
                    raise VerificationDeliveryError(
                        "verification email delivery is already in progress"
                    )
                governance_recovered = bool(attempt.get("delivery_recovered"))
        except EmailDeliveryQuotaExceeded as exc:
            raise VerificationRateLimitError(
                "daily_email_limit_reached",
                "daily email delivery limit reached",
            ) from exc
        except EmailDeliveryGovernanceError as exc:
            raise VerificationDeliveryError(
                "verification email delivery failed"
            ) from exc

    def finish_attempt(
        status: str,
        *,
        message_id: str = "",
        error_code: str = "",
    ) -> None:
        if not governance_enabled:
            return
        with db() as conn:
            mark_email_delivery_attempt(
                conn,
                governance_attempt_id,
                status,
                message_id=message_id,
                error_code=error_code,
                owner_token=governance_owner_token,
            )

    sender = {"email": config.sender_email}
    if config.sender_name:
        sender["name"] = config.sender_name
    payload = {
        "sender": sender,
        "to": [{"email": recipient}],
        "subject": "Your Vecto AI verification code",
        "htmlContent": (
            '<div style="font-family:Arial,sans-serif;color:#182235;line-height:1.6">'
            "<h2>Vecto AI verification code</h2>"
            f'<p style="font-size:30px;font-weight:700;letter-spacing:6px">{code}</p>'
            f"<p>This code expires in {minutes} minutes.</p>"
            "<p>If you did not request this code, you can ignore this email.</p>"
            "</div>"
        ),
        "headers": {
            "idempotencyKey": str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"vecto-verification/{idempotency_key}",
                )
            )
        },
    }
    try:
        response = requests.post(
            BREVO_EMAIL_API_URL,
            headers={
                "api-key": config.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Vecto-OS-Auth/1.0",
            },
            json=payload,
            timeout=(min(config.timeout_seconds, 5.0), config.timeout_seconds),
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        # A transport failure can happen after Brevo accepted the request.
        # Keep the unit occupied until reconciliation instead of risking a
        # quota overshoot through a blind retry.
        try:
            finish_attempt("unknown", error_code="transport_error")
        except (EmailDeliveryGovernanceError, sqlite3.OperationalError):
            pass
        raise VerificationDeliveryError("verification email delivery failed") from exc
    if response.status_code != 201:
        try:
            finish_attempt(
                (
                    "unknown"
                    if response.status_code >= 500 or governance_recovered
                    else "failed"
                ),
                error_code=f"http_{response.status_code}",
            )
        except (EmailDeliveryGovernanceError, sqlite3.OperationalError):
            pass
        # Provider responses may include recipient data or account details.
        raise VerificationDeliveryError("verification email delivery failed")
    try:
        message_id = str(response.json().get("messageId") or "").strip()
    except (TypeError, ValueError):
        message_id = ""
    if not message_id:
        try:
            finish_attempt("unknown", error_code="missing_message_id")
        except (EmailDeliveryGovernanceError, sqlite3.OperationalError):
            pass
        raise VerificationDeliveryError("verification email delivery failed")
    try:
        finish_attempt("accepted", message_id=message_id)
    except (EmailDeliveryGovernanceError, sqlite3.OperationalError):
        # Brevo has already accepted the email. The original reservation stays
        # occupied, which is fail-closed, while the verification code remains
        # usable instead of reporting a false delivery failure.
        pass


def send_verification_email(
    email: str,
    code: str,
    ttl_seconds: int = VERIFICATION_TTL_SECONDS,
    *,
    idempotency_key: str = "",
) -> None:
    recipient = normalize_email(email)
    clean_code = str(code or "").strip()
    if (
        len(clean_code) != VERIFICATION_CODE_DIGITS
        or not clean_code.isascii()
        or not clean_code.isdigit()
    ):
        raise ValueError("invalid verification code")
    ttl = int(ttl_seconds)
    if ttl <= 0:
        raise ValueError("verification TTL must be positive")
    minutes = max(1, (ttl + 59) // 60)
    provider = email_delivery_provider()
    if provider == "brevo":
        clean_idempotency_key = str(idempotency_key or "").strip()
        if not clean_idempotency_key:
            clean_idempotency_key = secrets.token_urlsafe(24)
        if (
            len(clean_idempotency_key) > 200
            or not clean_idempotency_key.isascii()
            or not all(
                character.isalnum() or character in "._-"
                for character in clean_idempotency_key
            )
        ):
            raise ValueError("invalid email delivery idempotency key")
        _send_verification_email_brevo(
            _load_brevo_config(),
            recipient,
            clean_code,
            minutes,
            clean_idempotency_key,
        )
        return

    config = _load_smtp_config()

    message = EmailMessage()
    message["Subject"] = "Your Vecto AI verification code"
    message["From"] = config.from_address
    message["To"] = recipient
    message.set_content(
        f"Your verification code is {clean_code}.\n"
        f"It expires in {minutes} minutes.\n"
        "If you did not request this code, you can ignore this email.\n"
    )

    try:
        with smtplib.SMTP(
            config.host,
            config.port,
            timeout=config.timeout_seconds,
        ) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
            smtp.login(config.username, config.app_password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        # Do not include provider responses: they can echo credentials or PII.
        raise VerificationDeliveryError("verification email delivery failed") from exc
