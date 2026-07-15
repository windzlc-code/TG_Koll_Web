"""Authenticated encryption for the optional administrator password vault.

Password hashes remain authoritative for authentication. This module only
maintains a separately encrypted copy for explicitly requested admin reveals.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Final

from cryptography.fernet import Fernet, InvalidToken


PASSWORD_VAULT_KEY_ENV: Final = "PASSWORD_VAULT_KEY"
PASSWORD_VAULT_KEY_FILE_ENV: Final = "PASSWORD_VAULT_KEY_FILE"
PASSWORD_VAULT_KEY_VERSION_ENV: Final = "PASSWORD_VAULT_KEY_VERSION"
PASSWORD_VAULT_KEYS_JSON_ENV: Final = "PASSWORD_VAULT_KEYS_JSON"
PASSWORD_VAULT_LEGACY_KEY_VERSION_ENV: Final = "PASSWORD_VAULT_LEGACY_KEY_VERSION"
DEFAULT_KEY_FILE_NAME: Final = "password_vault.key"
ENVELOPE_PREFIX: Final = "pv1"


class PasswordVaultError(RuntimeError):
    """Base class for password-vault failures."""


class PasswordVaultUnavailableError(PasswordVaultError):
    """Raised when no valid externally provisioned key is available."""


class PasswordVaultDecryptError(PasswordVaultError):
    """Raised when stored ciphertext cannot be authenticated or decoded."""


def _default_key_path() -> Path:
    data_dir = str(os.getenv("WEBAPP_DATA_DIR", "") or "").strip()
    if data_dir:
        return Path(data_dir).expanduser().resolve() / DEFAULT_KEY_FILE_NAME
    root_dir = Path(__file__).resolve().parent.parent
    return root_dir / "webapp_data" / DEFAULT_KEY_FILE_NAME


def _configured_keyring() -> dict[str, str]:
    raw = str(os.getenv(PASSWORD_VAULT_KEYS_JSON_ENV, "") or "").strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PasswordVaultUnavailableError("password vault keyring is invalid JSON") from exc
    if not isinstance(payload, dict):
        raise PasswordVaultUnavailableError("password vault keyring must be an object")
    return {str(version)[:40]: str(value).strip() for version, value in payload.items() if str(value).strip()}


def _load_key(requested_version: str | None = None) -> bytes:
    requested = str(requested_version or key_version()).strip()[:40] or "v1"
    current_version = key_version()
    keyring = _configured_keyring()
    if requested != current_version:
        historical = keyring.get(requested)
        if not historical:
            raise PasswordVaultUnavailableError(f"password vault key version {requested} is unavailable")
        return _validate_key(historical.encode("ascii", errors="strict"))

    configured_key = os.getenv(PASSWORD_VAULT_KEY_ENV)
    if configured_key is not None:
        key = configured_key.strip().encode("ascii", errors="strict")
        if not key:
            raise PasswordVaultUnavailableError("password vault key is empty")
        return _validate_key(key)

    if current_version in keyring:
        return _validate_key(keyring[current_version].encode("ascii", errors="strict"))

    configured_path = str(os.getenv(PASSWORD_VAULT_KEY_FILE_ENV, "") or "").strip()
    key_path = Path(configured_path).expanduser().resolve() if configured_path else _default_key_path()
    try:
        if not key_path.is_file():
            raise PasswordVaultUnavailableError("password vault key is not configured")
        key = key_path.read_bytes().strip()
    except PasswordVaultUnavailableError:
        raise
    except OSError as exc:
        raise PasswordVaultUnavailableError("password vault key cannot be read") from exc
    if not key:
        raise PasswordVaultUnavailableError("password vault key file is empty")
    return _validate_key(key)


def _validate_key(key: bytes) -> bytes:
    try:
        Fernet(key)
    except (TypeError, ValueError) as exc:
        raise PasswordVaultUnavailableError("password vault key is invalid") from exc
    return key


def key_version() -> str:
    value = str(os.getenv(PASSWORD_VAULT_KEY_VERSION_ENV, "v1") or "v1").strip()
    return value[:40] or "v1"


def ciphertext_key_version(ciphertext: str) -> str:
    value = str(ciphertext or "")
    parts = value.split(":", 2)
    if len(parts) == 3 and parts[0] == ENVELOPE_PREFIX and parts[1]:
        return parts[1][:40]
    legacy_version = str(os.getenv(PASSWORD_VAULT_LEGACY_KEY_VERSION_ENV, "v1") or "v1").strip()
    return legacy_version[:40] or "v1"


def _wrap_ciphertext(token: str, version: str | None = None) -> str:
    return f"{ENVELOPE_PREFIX}:{str(version or key_version())[:40]}:{token}"


def _unwrap_ciphertext(ciphertext: str) -> tuple[str, str]:
    value = str(ciphertext or "")
    parts = value.split(":", 2)
    if len(parts) == 3 and parts[0] == ENVELOPE_PREFIX and parts[1] and parts[2]:
        return parts[1][:40], parts[2]
    legacy_version = str(os.getenv(PASSWORD_VAULT_LEGACY_KEY_VERSION_ENV, "v1") or "v1").strip()
    return legacy_version[:40] or "v1", value


def health_check(*, persistent_probe: str = "", probe_key_version: str = "") -> dict[str, str | bool]:
    try:
        version = str(probe_key_version or key_version())[:40] or "v1"
        key = _load_key(version)
        probe = str(persistent_probe or "")
        if probe:
            _, token = _unwrap_ciphertext(probe)
            healthy = Fernet(key).decrypt(token.encode("ascii")) == b"vecto-password-vault-health"
        else:
            token = Fernet(key).encrypt(b"vecto-password-vault-health").decode("ascii")
            probe = _wrap_ciphertext(token, version)
            healthy = True
        return {
            "healthy": bool(healthy),
            "key_version": version,
            "detail": "ok" if healthy else "persistent_probe_failed",
            "persistent_probe": probe,
        }
    except PasswordVaultError as exc:
        return {"healthy": False, "key_version": key_version(), "detail": str(exc)}
    except (InvalidToken, UnicodeError):
        return {"healthy": False, "key_version": str(probe_key_version or key_version())[:40], "detail": "persistent_probe_failed"}


def encrypt_password(user_id: int, password: str) -> str:
    uid = int(user_id)
    if uid <= 0:
        raise ValueError("user_id must be positive")
    payload = json.dumps(
        {"version": 1, "user_id": uid, "password": str(password)},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    version = key_version()
    return _wrap_ciphertext(Fernet(_load_key(version)).encrypt(payload).decode("ascii"), version)


def decrypt_password(user_id: int, ciphertext: str) -> str:
    uid = int(user_id)
    try:
        version, token = _unwrap_ciphertext(ciphertext)
        plaintext = Fernet(_load_key(version)).decrypt(token.encode("ascii"))
        payload = json.loads(plaintext.decode("utf-8"))
    except PasswordVaultUnavailableError:
        raise
    except (InvalidToken, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise PasswordVaultDecryptError("password vault entry cannot be decrypted") from exc
    if not isinstance(payload, dict) or payload.get("version") != 1 or int(payload.get("user_id") or 0) != uid:
        raise PasswordVaultDecryptError("password vault entry does not match the user")
    password = payload.get("password")
    if not isinstance(password, str):
        raise PasswordVaultDecryptError("password vault entry is malformed")
    return password


def encrypt_secret(user_id: int, purpose: str, value: str) -> str:
    uid = int(user_id)
    clean_purpose = str(purpose or "").strip()
    if uid <= 0:
        raise ValueError("user_id must be positive")
    if not clean_purpose:
        raise ValueError("purpose is required")
    payload = json.dumps(
        {"version": 2, "user_id": uid, "purpose": clean_purpose, "value": str(value)},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    version = key_version()
    return _wrap_ciphertext(Fernet(_load_key(version)).encrypt(payload).decode("ascii"), version)


def decrypt_secret(user_id: int, purpose: str, ciphertext: str) -> str:
    uid = int(user_id)
    clean_purpose = str(purpose or "").strip()
    try:
        version, token = _unwrap_ciphertext(ciphertext)
        plaintext = Fernet(_load_key(version)).decrypt(token.encode("ascii"))
        payload = json.loads(plaintext.decode("utf-8"))
    except PasswordVaultUnavailableError:
        raise
    except (InvalidToken, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise PasswordVaultDecryptError("password vault secret cannot be decrypted") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("version") != 2
        or int(payload.get("user_id") or 0) != uid
        or str(payload.get("purpose") or "") != clean_purpose
    ):
        raise PasswordVaultDecryptError("password vault secret does not match its owner or purpose")
    value = payload.get("value")
    if not isinstance(value, str):
        raise PasswordVaultDecryptError("password vault secret is malformed")
    return value
