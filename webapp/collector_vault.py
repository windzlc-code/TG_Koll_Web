"""Authenticated encryption for collector-account runtime credentials.

Collector credentials intentionally use a key namespace that is separate from
the customer password vault.  Ciphertexts are bound to both the collector
account id and the credential kind, so moving a ciphertext to another account
or column fails authentication at the application layer.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Final, Mapping

from cryptography.fernet import Fernet, InvalidToken


COLLECTOR_VAULT_KEY_ENV: Final = "COLLECTOR_VAULT_KEY"
COLLECTOR_VAULT_KEY_FILE_ENV: Final = "COLLECTOR_VAULT_KEY_FILE"
COLLECTOR_VAULT_KEY_VERSION_ENV: Final = "COLLECTOR_VAULT_KEY_VERSION"
COLLECTOR_VAULT_KEYS_JSON_ENV: Final = "COLLECTOR_VAULT_KEYS_JSON"
DEFAULT_KEY_FILE_NAME: Final = "collector_vault.key"
ENVELOPE_PREFIX: Final = "cv1"
ALLOWED_SECRET_KINDS: Final = frozenset(
    {"login_password", "totp", "proxy_username", "proxy_password"}
)
_ACCOUNT_ID_PATTERN: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$")


class CollectorVaultError(RuntimeError):
    """Base class for collector-vault failures."""


class CollectorVaultUnavailableError(CollectorVaultError):
    """Raised when no usable collector vault key is configured."""


class CollectorVaultDecryptError(CollectorVaultError):
    """Raised when ciphertext authentication or context binding fails."""


def _validate_account_id(account_id: str) -> str:
    value = str(account_id or "").strip()
    if not _ACCOUNT_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid collector account id")
    return value


def _validate_secret_kind(kind: str) -> str:
    value = str(kind or "").strip().lower()
    if value not in ALLOWED_SECRET_KINDS:
        raise ValueError("unsupported collector secret kind")
    return value


def secret_purpose(account_id: str, kind: str) -> str:
    """Return the immutable context bound into a collector ciphertext."""

    return f"collector-account:{_validate_account_id(account_id)}:{_validate_secret_kind(kind)}"


def _validate_key(value: str | bytes) -> bytes:
    try:
        raw = value if isinstance(value, bytes) else str(value).strip().encode("ascii")
        Fernet(raw)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise CollectorVaultUnavailableError("collector vault key is invalid") from exc
    return raw


def _default_key_path() -> Path:
    data_dir = str(os.getenv("WEBAPP_DATA_DIR", "") or "").strip()
    if data_dir:
        return Path(data_dir).expanduser().resolve() / DEFAULT_KEY_FILE_NAME
    return Path(__file__).resolve().parent.parent / "webapp_data" / DEFAULT_KEY_FILE_NAME


class CollectorVault:
    """Versioned Fernet vault with account-and-purpose context binding."""

    def __init__(
        self,
        *,
        key: str | bytes | None = None,
        key_version: str | None = None,
        keyring: Mapping[str, str | bytes] | None = None,
        key_file: str | Path | None = None,
    ) -> None:
        self._current_version = self._normalize_version(
            key_version
            if key_version is not None
            else os.getenv(COLLECTOR_VAULT_KEY_VERSION_ENV, "v1")
        )
        configured_keyring = self._environment_keyring() if keyring is None else dict(keyring)
        self._keys: dict[str, bytes] = {
            self._normalize_version(version): _validate_key(raw_key)
            for version, raw_key in configured_keyring.items()
        }

        current_key = key
        if current_key is None:
            current_key = os.getenv(COLLECTOR_VAULT_KEY_ENV)
        if current_key is None and self._current_version in self._keys:
            current_key = self._keys[self._current_version]
        if current_key is None:
            configured_path = str(
                key_file
                or os.getenv(COLLECTOR_VAULT_KEY_FILE_ENV, "")
                or _default_key_path()
            ).strip()
            try:
                path = Path(configured_path).expanduser().resolve()
                if not path.is_file():
                    raise CollectorVaultUnavailableError("collector vault key is not configured")
                current_key = path.read_bytes().strip()
            except CollectorVaultUnavailableError:
                raise
            except OSError as exc:
                raise CollectorVaultUnavailableError("collector vault key cannot be read") from exc

        self._keys[self._current_version] = _validate_key(current_key)

    @staticmethod
    def _normalize_version(value: object) -> str:
        version = str(value or "v1").strip()
        if not version or len(version) > 40 or not re.fullmatch(r"[A-Za-z0-9_.-]+", version):
            raise CollectorVaultUnavailableError("collector vault key version is invalid")
        return version

    @staticmethod
    def _environment_keyring() -> dict[str, str]:
        raw = str(os.getenv(COLLECTOR_VAULT_KEYS_JSON_ENV, "") or "").strip()
        if not raw:
            return {}
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CollectorVaultUnavailableError("collector vault keyring is invalid JSON") from exc
        if not isinstance(payload, dict):
            raise CollectorVaultUnavailableError("collector vault keyring must be an object")
        return {
            str(version): str(value).strip()
            for version, value in payload.items()
            if str(value).strip()
        }

    @property
    def key_version(self) -> str:
        return self._current_version

    def encrypt(self, account_id: str, kind: str, plaintext: str) -> str:
        clean_account_id = _validate_account_id(account_id)
        clean_kind = _validate_secret_kind(kind)
        payload = json.dumps(
            {
                "version": 1,
                "account_id": clean_account_id,
                "purpose": secret_purpose(clean_account_id, clean_kind),
                "value": str(plaintext),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        token = Fernet(self._keys[self._current_version]).encrypt(payload).decode("ascii")
        return f"{ENVELOPE_PREFIX}:{self._current_version}:{token}"

    def decrypt(self, account_id: str, kind: str, ciphertext: str) -> str:
        clean_account_id = _validate_account_id(account_id)
        clean_kind = _validate_secret_kind(kind)
        try:
            prefix, version, token = str(ciphertext or "").split(":", 2)
            if prefix != ENVELOPE_PREFIX or not version or not token:
                raise ValueError("invalid collector vault envelope")
            key = self._keys.get(self._normalize_version(version))
            if key is None:
                raise CollectorVaultUnavailableError(
                    f"collector vault key version {version} is unavailable"
                )
            payload = json.loads(Fernet(key).decrypt(token.encode("ascii")).decode("utf-8"))
        except CollectorVaultUnavailableError:
            raise
        except (InvalidToken, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise CollectorVaultDecryptError("collector secret cannot be decrypted") from exc

        expected_purpose = secret_purpose(clean_account_id, clean_kind)
        if (
            not isinstance(payload, dict)
            or payload.get("version") != 1
            or str(payload.get("account_id") or "") != clean_account_id
            or str(payload.get("purpose") or "") != expected_purpose
            or not isinstance(payload.get("value"), str)
        ):
            raise CollectorVaultDecryptError(
                "collector secret does not match its account or purpose"
            )
        return str(payload["value"])
