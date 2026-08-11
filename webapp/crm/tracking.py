from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .errors import CRMError


def _secret() -> bytes:
    value = str(os.getenv("CRM_TRACKING_SECRET", "") or "").strip()
    if len(value) < 32:
        raise CRMError("crm_tracking_unavailable", "crm.errors.trackingUnavailable", status_code=503)
    return value.encode("utf-8")


def _encryption_key() -> bytes:
    # Keep the public token opaque while deriving a fixed-width AEAD key from
    # the existing deployment secret. The random nonce makes equal payloads
    # produce unrelated tokens.
    return hashlib.sha256(b"crm-tracking-token-v2\0" + _secret()).digest()


def sign_tracking_token(payload: dict[str, Any]) -> str:
    required = {"user_id", "campaign_id", "lead_id", "destination_id", "version", "expires_at"}
    if not required.issubset(payload):
        raise CRMError("crm_tracking_invalid_payload", "crm.errors.trackingInvalidPayload", status_code=400)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    nonce = secrets.token_bytes(12)
    encrypted = AESGCM(_encryption_key()).encrypt(nonce, body, b"crm-tracking:v2")
    encoded = base64.urlsafe_b64encode(nonce + encrypted).decode("ascii").rstrip("=")
    return f"v2_{encoded}"


def _verify_v2_token(token: str) -> dict[str, Any]:
    encoded = token[3:]
    padded = encoded + "=" * (-len(encoded) % 4)
    sealed = base64.urlsafe_b64decode(padded.encode("ascii"))
    if len(sealed) < 12 + 16:
        raise ValueError("truncated token")
    body = AESGCM(_encryption_key()).decrypt(sealed[:12], sealed[12:], b"crm-tracking:v2")
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("invalid token payload")
    return payload


def _verify_legacy_signed_token(token: str) -> dict[str, Any]:
    """Read-only compatibility for tokens issued before opaque v2 tokens."""
    encoded, signature_text = token.split(".", 1)
    expected = hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    padded_signature = signature_text + "=" * (-len(signature_text) % 4)
    actual = base64.urlsafe_b64decode(padded_signature.encode("ascii"))
    if not hmac.compare_digest(expected, actual):
        raise ValueError("signature mismatch")
    padded_body = encoded + "=" * (-len(encoded) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded_body.encode("ascii")).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("invalid token payload")
    return payload


def verify_tracking_token(token: str) -> dict[str, Any]:
    try:
        clean = str(token or "")
        payload = _verify_v2_token(clean) if clean.startswith("v2_") else _verify_legacy_signed_token(clean)
        if not isinstance(payload, dict) or int(payload.get("expires_at") or 0) < int(time.time()):
            raise ValueError("expired token")
        for field in ("user_id", "campaign_id", "lead_id", "destination_id", "version", "expires_at"):
            if payload.get(field) in (None, ""):
                raise ValueError(f"missing {field}")
        return payload
    except CRMError:
        raise
    except Exception as exc:
        raise CRMError("crm_tracking_invalid", "crm.errors.trackingInvalid", status_code=404) from exc
