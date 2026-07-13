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
DEFAULT_KEY_FILE_NAME: Final = "password_vault.key"


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


def _load_key() -> bytes:
    configured_key = os.getenv(PASSWORD_VAULT_KEY_ENV)
    if configured_key is not None:
        key = configured_key.strip().encode("ascii", errors="strict")
        if not key:
            raise PasswordVaultUnavailableError("password vault key is empty")
        return _validate_key(key)

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


def encrypt_password(user_id: int, password: str) -> str:
    uid = int(user_id)
    if uid <= 0:
        raise ValueError("user_id must be positive")
    payload = json.dumps(
        {"version": 1, "user_id": uid, "password": str(password)},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return Fernet(_load_key()).encrypt(payload).decode("ascii")


def decrypt_password(user_id: int, ciphertext: str) -> str:
    uid = int(user_id)
    try:
        plaintext = Fernet(_load_key()).decrypt(str(ciphertext).encode("ascii"))
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
