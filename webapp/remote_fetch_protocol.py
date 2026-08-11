from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Mapping
from typing import Any


SIGNATURE_VERSION = "v1"
TIMESTAMP_HEADER = "x-vecto-worker-timestamp"
NONCE_HEADER = "x-vecto-worker-nonce"
SIGNATURE_HEADER = "x-vecto-worker-signature"
KEY_ID_HEADER = "x-vecto-worker-key-id"
IDEMPOTENCY_HEADER = "idempotency-key"

_KEY_PATTERN = re.compile(r"[A-Za-z0-9._:-]{8,160}")
_NONCE_PATTERN = re.compile(r"[A-Za-z0-9_-]{16,128}")


class ProtocolError(ValueError):
    pass


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def request_hash(body: bytes) -> str:
    return body_sha256(body)


def validate_idempotency_key(value: str) -> str:
    clean = str(value or "").strip()
    if not _KEY_PATTERN.fullmatch(clean):
        raise ProtocolError("invalid idempotency key")
    return clean


def validate_nonce(value: str) -> str:
    clean = str(value or "").strip()
    if not _NONCE_PATTERN.fullmatch(clean):
        raise ProtocolError("invalid nonce")
    return clean


def _secret_bytes(secret: str) -> bytes:
    clean = str(secret or "").strip()
    if len(clean) < 32:
        raise ProtocolError("worker shared secret must contain at least 32 characters")
    return clean.encode("utf-8")


def signature_payload(
    *,
    method: str,
    path: str,
    timestamp: int,
    nonce: str,
    body: bytes,
) -> bytes:
    clean_method = str(method or "").strip().upper()
    clean_path = "/" + str(path or "").strip().lstrip("/")
    clean_nonce = validate_nonce(nonce)
    return "\n".join(
        (
            SIGNATURE_VERSION,
            clean_method,
            clean_path,
            str(int(timestamp)),
            clean_nonce,
            body_sha256(body),
        )
    ).encode("utf-8")


def sign_request(
    *,
    secret: str,
    method: str,
    path: str,
    timestamp: int,
    nonce: str,
    body: bytes,
) -> str:
    payload = signature_payload(
        method=method,
        path=path,
        timestamp=timestamp,
        nonce=nonce,
        body=body,
    )
    return hmac.new(_secret_bytes(secret), payload, hashlib.sha256).hexdigest()


def signed_headers(
    *,
    secret: str,
    key_id: str,
    method: str,
    path: str,
    body: bytes,
    timestamp: int,
    nonce: str,
    idempotency_key: str = "",
) -> dict[str, str]:
    headers = {
        TIMESTAMP_HEADER: str(int(timestamp)),
        NONCE_HEADER: validate_nonce(nonce),
        SIGNATURE_HEADER: sign_request(
            secret=secret,
            method=method,
            path=path,
            timestamp=timestamp,
            nonce=nonce,
            body=body,
        ),
        KEY_ID_HEADER: validate_idempotency_key(key_id),
    }
    if idempotency_key:
        headers[IDEMPOTENCY_HEADER] = validate_idempotency_key(idempotency_key)
    return headers


def verify_request(
    *,
    secrets_by_key_id: Mapping[str, str],
    method: str,
    path: str,
    body: bytes,
    headers: Mapping[str, str],
    current_time: int | None = None,
    maximum_skew_seconds: int = 60,
) -> tuple[str, str, int]:
    normalized = {str(key).lower(): str(value) for key, value in headers.items()}
    key_id = validate_idempotency_key(normalized.get(KEY_ID_HEADER, ""))
    secret = str(secrets_by_key_id.get(key_id) or "").strip()
    if not secret:
        raise ProtocolError("unknown worker key id")
    nonce = validate_nonce(normalized.get(NONCE_HEADER, ""))
    try:
        timestamp = int(normalized.get(TIMESTAMP_HEADER, ""))
    except (TypeError, ValueError) as exc:
        raise ProtocolError("invalid worker timestamp") from exc
    now = int(current_time if current_time is not None else time.time())
    maximum_skew = max(10, min(int(maximum_skew_seconds), 300))
    if abs(now - timestamp) > maximum_skew:
        raise ProtocolError("worker timestamp outside replay window")
    supplied = str(normalized.get(SIGNATURE_HEADER) or "").strip().lower()
    expected = sign_request(
        secret=secret,
        method=method,
        path=path,
        timestamp=timestamp,
        nonce=nonce,
        body=body,
    )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise ProtocolError("invalid worker signature")
    return key_id, nonce, timestamp
