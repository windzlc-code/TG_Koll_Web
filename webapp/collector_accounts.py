"""Collector account-pool selection, encryption, and lease coordination.

This module has no web routes and does not touch the customer application DB.
Callers receive explicit public projections; stored profile paths and encrypted
credentials are never included in those projections.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping, TypeVar

from .collector_db import collector_db, init_collector_db
from .collector_vault import ALLOWED_SECRET_KINDS, CollectorVault


SUPPORTED_PLATFORMS = frozenset({"threads", "instagram"})
ACCOUNT_STATUSES = frozenset({"importing", "pending_validation", "ready", "disabled"})
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$")
_CAPABILITY_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{2,119}$")
_ERROR_CODE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
_SENSITIVE_METADATA_TOKENS = (
    "password",
    "passwd",
    "secret",
    "token",
    "cookie",
    "authorization",
    "credential",
    "totp",
)
_T = TypeVar("_T")


class CollectorAccountError(RuntimeError):
    """Base class for collector account-pool errors."""


class CollectorAccountNotFoundError(CollectorAccountError):
    """Raised when a collector account does not exist."""


class CollectorAccountConflictError(CollectorAccountError):
    """Raised when an account violates a pool uniqueness boundary."""


class NoCollectorAccountAvailableError(CollectorAccountError):
    """Raised when no ready, unleased account matches a selection request."""


class CollectorLeaseNotFoundError(CollectorAccountError):
    """Raised when a lease is missing or belongs to another holder."""


class CollectorLeaseExpiredError(CollectorAccountError):
    """Raised when a caller attempts to use an expired collector lease."""


def _now() -> int:
    return int(time.time())


def _clean_identifier(value: object, *, label: str) -> str:
    cleaned = str(value or "").strip()
    if not _IDENTIFIER_PATTERN.fullmatch(cleaned):
        raise ValueError(f"invalid {label}")
    return cleaned


def _clean_platform(value: object) -> str:
    platform = str(value or "").strip().lower()
    if platform not in SUPPORTED_PLATFORMS:
        raise ValueError("unsupported collector platform")
    return platform


def _clean_capability(value: object) -> str:
    capability = str(value or "").strip().lower()
    if not _CAPABILITY_PATTERN.fullmatch(capability):
        raise ValueError("invalid collector capability")
    return capability


def _clean_duration(value: object, *, label: str, maximum: int = 86400) -> int:
    seconds = int(value)
    if seconds < 0 or seconds > maximum:
        raise ValueError(f"invalid {label}")
    return seconds


def _reject_sensitive_metadata(value: Any, *, path: str = "metadata") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            clean_key = str(key or "").strip().lower()
            if any(token in clean_key for token in _SENSITIVE_METADATA_TOKENS):
                raise ValueError(f"collector {path} cannot contain credential fields")
            _reject_sensitive_metadata(item, path=f"{path}.{clean_key or 'field'}")
    elif isinstance(value, (list, tuple)):
        for item in value:
            _reject_sensitive_metadata(item, path=path)


def _public_account(
    row: Mapping[str, Any],
    capabilities: list[str],
    *,
    leased: bool,
    totp_configured: bool,
) -> dict[str, Any]:
    """Return the only account shape intended for controllers and APIs."""

    return {
        "id": str(row["id"]),
        "pool_id": str(row["pool_id"]),
        "platform": str(row["platform"]),
        "username": str(row["username"]),
        "display_name": str(row["display_name"] or ""),
        "status": str(row["status"]),
        "health_status": str(row["health_status"]),
        "capabilities": sorted(capabilities),
        "cooldown_until": int(row["cooldown_until"] or 0),
        "circuit_open_until": int(row["circuit_open_until"] or 0),
        "consecutive_failures": int(row["consecutive_failures"] or 0),
        "last_failure_at": int(row["last_failure_at"] or 0),
        "last_success_at": int(row["last_success_at"] or 0),
        "last_selected_at": int(row["last_selected_at"] or 0),
        "leased": bool(leased),
        "profile_configured": bool(str(row["profile_dir"] or "").strip()),
        "proxy_configured": bool(str(row["proxy_id"] or "").strip()),
        "totp_configured": bool(totp_configured),
        "created_at": int(row["created_at"] or 0),
        "updated_at": int(row["updated_at"] or 0),
    }


class CollectorAccountPool:
    """Transactional collector-account repository and fair lease allocator."""

    def __init__(self, db_path: str | Path, vault: CollectorVault) -> None:
        self.db_path = init_collector_db(db_path)
        self.vault = vault

    @staticmethod
    def _capabilities(conn: sqlite3.Connection, account_id: str) -> list[str]:
        return [
            str(row["capability"])
            for row in conn.execute(
                "SELECT capability FROM collector_account_capabilities "
                "WHERE account_id = ? ORDER BY capability",
                (account_id,),
            ).fetchall()
        ]

    @classmethod
    def _public_from_conn(
        cls,
        conn: sqlite3.Connection,
        row: Mapping[str, Any],
        *,
        now: int,
    ) -> dict[str, Any]:
        account_id = str(row["id"])
        lease = conn.execute(
            "SELECT 1 FROM collector_account_leases WHERE account_id = ? AND expires_at > ?",
            (account_id, int(now)),
        ).fetchone()
        totp = conn.execute(
            "SELECT 1 FROM collector_account_secrets WHERE account_id = ? AND secret_kind = 'totp'",
            (account_id,),
        ).fetchone()
        return _public_account(
            row,
            cls._capabilities(conn, account_id),
            leased=lease is not None,
            totp_configured=totp is not None,
        )

    def create_account(
        self,
        *,
        platform: str,
        username: str,
        capabilities: list[str] | tuple[str, ...] | set[str],
        account_id: str | None = None,
        pool_id: str = "pool_primary",
        display_name: str = "",
        login_username: str = "",
        profile_dir: str = "",
        proxy_id: str = "",
        source_system: str = "",
        source_account_id: str = "",
        source_owner_user_id: int = 0,
        status: str = "importing",
        health_status: str = "unknown",
        metadata: Mapping[str, Any] | None = None,
        secrets: Mapping[str, str] | None = None,
        now: int | None = None,
    ) -> dict[str, Any]:
        timestamp = _now() if now is None else int(now)
        clean_id = (
            _clean_identifier(account_id, label="collector account id")
            if account_id
            else f"colacct_{uuid.uuid4().hex}"
        )
        clean_pool = _clean_identifier(pool_id, label="collector pool id")
        clean_platform = _clean_platform(platform)
        clean_username = str(username or "").strip().lstrip("@")
        if not clean_username or len(clean_username) > 200:
            raise ValueError("invalid collector username")
        clean_status = str(status or "").strip().lower()
        if clean_status not in ACCOUNT_STATUSES:
            raise ValueError("invalid collector account status")
        clean_capabilities = sorted({_clean_capability(item) for item in capabilities})
        if not clean_capabilities:
            raise ValueError("at least one collector capability is required")
        clean_secrets: dict[str, tuple[str, str]] = {}
        for raw_kind, plaintext in (secrets or {}).items():
            kind = str(raw_kind or "").strip().lower()
            if kind not in ALLOWED_SECRET_KINDS:
                raise ValueError("unsupported collector secret kind")
            if not isinstance(plaintext, str) or not plaintext:
                raise ValueError("collector secret value must be a non-empty string")
            clean_secrets[kind] = (
                self.vault.encrypt(clean_id, kind, plaintext),
                self.vault.key_version,
            )
        clean_metadata = dict(metadata or {})
        _reject_sensitive_metadata(clean_metadata)
        try:
            metadata_json = json.dumps(
                clean_metadata, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("collector metadata must be JSON serializable") from exc

        with collector_db(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    INSERT INTO collector_accounts(
                      id, pool_id, source_system, source_account_id, source_owner_user_id,
                      platform, username, display_name, login_username, profile_dir,
                      proxy_id, status, health_status, metadata_json, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        clean_id,
                        clean_pool,
                        str(source_system or "").strip()[:120],
                        str(source_account_id or "").strip()[:200],
                        max(0, int(source_owner_user_id or 0)),
                        clean_platform,
                        clean_username,
                        str(display_name or "").strip()[:200],
                        str(login_username or "").strip()[:320],
                        str(profile_dir or "").strip(),
                        str(proxy_id or "").strip()[:160],
                        clean_status,
                        str(health_status or "unknown").strip().lower()[:80] or "unknown",
                        metadata_json,
                        timestamp,
                        timestamp,
                    ),
                )
                conn.executemany(
                    "INSERT INTO collector_account_capabilities(account_id, capability, created_at) "
                    "VALUES (?, ?, ?)",
                    [(clean_id, capability, timestamp) for capability in clean_capabilities],
                )
                conn.executemany(
                    """
                    INSERT INTO collector_account_secrets(
                      account_id, secret_kind, ciphertext, key_version, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (clean_id, kind, ciphertext, version, timestamp, timestamp)
                        for kind, (ciphertext, version) in clean_secrets.items()
                    ],
                )
            except sqlite3.IntegrityError as exc:
                raise CollectorAccountConflictError("collector account already exists") from exc
            row = conn.execute(
                "SELECT * FROM collector_accounts WHERE id = ?", (clean_id,)
            ).fetchone()
            assert row is not None
            return self._public_from_conn(conn, row, now=timestamp)

    def list_accounts(self, *, pool_id: str = "pool_primary", now: int | None = None) -> list[dict[str, Any]]:
        timestamp = _now() if now is None else int(now)
        clean_pool = _clean_identifier(pool_id, label="collector pool id")
        with collector_db(self.db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM collector_accounts WHERE pool_id = ? ORDER BY platform, username, id",
                (clean_pool,),
            ).fetchall()
            return [self._public_from_conn(conn, row, now=timestamp) for row in rows]

    def set_account_state(
        self,
        account_id: str,
        *,
        status: str,
        health_status: str,
        now: int | None = None,
    ) -> dict[str, Any]:
        timestamp = _now() if now is None else int(now)
        clean_id = _clean_identifier(account_id, label="collector account id")
        clean_status = str(status or "").strip().lower()
        if clean_status not in ACCOUNT_STATUSES:
            raise ValueError("invalid collector account status")
        clean_health = str(health_status or "unknown").strip().lower()[:80] or "unknown"
        with collector_db(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            updated = conn.execute(
                "UPDATE collector_accounts SET status = ?, health_status = ?, updated_at = ? WHERE id = ?",
                (clean_status, clean_health, timestamp, clean_id),
            ).rowcount
            if not updated:
                raise CollectorAccountNotFoundError("collector account not found")
            if clean_status != "ready":
                conn.execute(
                    "DELETE FROM collector_account_leases WHERE account_id = ?", (clean_id,)
                )
            row = conn.execute("SELECT * FROM collector_accounts WHERE id = ?", (clean_id,)).fetchone()
            assert row is not None
            return self._public_from_conn(conn, row, now=timestamp)

    def replace_secret(
        self,
        account_id: str,
        kind: str,
        plaintext: str,
        *,
        now: int | None = None,
    ) -> None:
        timestamp = _now() if now is None else int(now)
        clean_id = _clean_identifier(account_id, label="collector account id")
        clean_kind = str(kind or "").strip().lower()
        if clean_kind not in ALLOWED_SECRET_KINDS:
            raise ValueError("unsupported collector secret kind")
        if not isinstance(plaintext, str) or not plaintext:
            raise ValueError("collector secret value must be a non-empty string")
        ciphertext = self.vault.encrypt(clean_id, clean_kind, plaintext)
        with collector_db(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute(
                "SELECT 1 FROM collector_accounts WHERE id = ?", (clean_id,)
            ).fetchone():
                raise CollectorAccountNotFoundError("collector account not found")
            conn.execute(
                """
                INSERT INTO collector_account_secrets(
                  account_id, secret_kind, ciphertext, key_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id, secret_kind) DO UPDATE SET
                  ciphertext = excluded.ciphertext,
                  key_version = excluded.key_version,
                  updated_at = excluded.updated_at
                """,
                (
                    clean_id,
                    clean_kind,
                    ciphertext,
                    self.vault.key_version,
                    timestamp,
                    timestamp,
                ),
            )

    def acquire(
        self,
        *,
        capability: str,
        platform: str,
        holder: str,
        pool_id: str = "pool_primary",
        lease_seconds: int = 120,
        now: int | None = None,
    ) -> dict[str, Any]:
        timestamp = _now() if now is None else int(now)
        clean_capability = _clean_capability(capability)
        clean_platform = _clean_platform(platform)
        clean_holder = _clean_identifier(holder, label="collector lease holder")
        clean_pool = _clean_identifier(pool_id, label="collector pool id")
        duration = _clean_duration(lease_seconds, label="collector lease duration", maximum=3600)
        if duration < 1:
            raise ValueError("collector lease duration must be positive")

        with collector_db(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "DELETE FROM collector_account_leases WHERE expires_at <= ?", (timestamp,)
            )
            row = conn.execute(
                """
                SELECT account.*
                FROM collector_accounts account
                JOIN collector_account_capabilities capability
                  ON capability.account_id = account.id
                 AND capability.capability = ?
                LEFT JOIN collector_account_leases lease ON lease.account_id = account.id
                WHERE account.pool_id = ?
                  AND account.platform = ?
                  AND account.status = 'ready'
                  AND account.cooldown_until <= ?
                  AND account.circuit_open_until <= ?
                  AND lease.account_id IS NULL
                ORDER BY account.last_selected_at ASC, account.last_success_at ASC, account.id ASC
                LIMIT 1
                """,
                (clean_capability, clean_pool, clean_platform, timestamp, timestamp),
            ).fetchone()
            if row is None:
                raise NoCollectorAccountAvailableError("no collector account is currently available")
            account_id = str(row["id"])
            lease_id = f"collease_{uuid.uuid4().hex}"
            expires_at = timestamp + duration
            conn.execute(
                """
                INSERT INTO collector_account_leases(
                  account_id, lease_id, holder, capability, acquired_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (account_id, lease_id, clean_holder, clean_capability, timestamp, expires_at),
            )
            conn.execute(
                "UPDATE collector_accounts SET last_selected_at = ?, updated_at = ? WHERE id = ?",
                (timestamp, timestamp, account_id),
            )
            updated = conn.execute(
                "SELECT * FROM collector_accounts WHERE id = ?", (account_id,)
            ).fetchone()
            assert updated is not None
            return {
                "lease_id": lease_id,
                "holder": clean_holder,
                "capability": clean_capability,
                "acquired_at": timestamp,
                "expires_at": expires_at,
                "account": self._public_from_conn(conn, updated, now=timestamp),
            }

    @staticmethod
    def _lease_row(
        conn: sqlite3.Connection,
        lease_id: str,
        holder: str,
    ) -> sqlite3.Row:
        row = conn.execute(
            "SELECT * FROM collector_account_leases WHERE lease_id = ? AND holder = ?",
            (lease_id, holder),
        ).fetchone()
        if row is None:
            raise CollectorLeaseNotFoundError("collector lease not found")
        return row

    def renew(
        self,
        lease_id: str,
        *,
        holder: str,
        lease_seconds: int = 120,
        now: int | None = None,
    ) -> dict[str, Any]:
        timestamp = _now() if now is None else int(now)
        clean_lease_id = _clean_identifier(lease_id, label="collector lease id")
        clean_holder = _clean_identifier(holder, label="collector lease holder")
        duration = _clean_duration(lease_seconds, label="collector lease duration", maximum=3600)
        if duration < 1:
            raise ValueError("collector lease duration must be positive")
        with collector_db(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            lease = self._lease_row(conn, clean_lease_id, clean_holder)
            if int(lease["expires_at"] or 0) <= timestamp:
                conn.execute(
                    "DELETE FROM collector_account_leases WHERE lease_id = ?", (clean_lease_id,)
                )
                raise CollectorLeaseExpiredError("collector lease has expired")
            expires_at = timestamp + duration
            conn.execute(
                "UPDATE collector_account_leases SET expires_at = ? WHERE lease_id = ?",
                (expires_at, clean_lease_id),
            )
            return {"lease_id": clean_lease_id, "expires_at": expires_at}

    def use_secret(
        self,
        lease_id: str,
        *,
        holder: str,
        kind: str,
        consumer: Callable[[str], _T],
        now: int | None = None,
    ) -> _T:
        """Pass one decrypted secret to a runtime callback without returning it."""

        timestamp = _now() if now is None else int(now)
        clean_lease_id = _clean_identifier(lease_id, label="collector lease id")
        clean_holder = _clean_identifier(holder, label="collector lease holder")
        clean_kind = str(kind or "").strip().lower()
        if clean_kind not in ALLOWED_SECRET_KINDS:
            raise ValueError("unsupported collector secret kind")
        with collector_db(self.db_path) as conn:
            lease = self._lease_row(conn, clean_lease_id, clean_holder)
            if int(lease["expires_at"] or 0) <= timestamp:
                raise CollectorLeaseExpiredError("collector lease has expired")
            account_id = str(lease["account_id"])
            secret = conn.execute(
                "SELECT ciphertext FROM collector_account_secrets "
                "WHERE account_id = ? AND secret_kind = ?",
                (account_id, clean_kind),
            ).fetchone()
            if secret is None:
                raise CollectorAccountError("collector secret is not configured")
            plaintext = self.vault.decrypt(account_id, clean_kind, str(secret["ciphertext"]))
        return consumer(plaintext)

    def use_runtime_profile(
        self,
        lease_id: str,
        *,
        holder: str,
        consumer: Callable[[dict[str, str]], _T],
        now: int | None = None,
    ) -> _T:
        """Pass the leased browser profile to an in-process runtime callback.

        The private filesystem path never appears in public account or lease
        projections and must not be returned by web or worker APIs.
        """

        timestamp = _now() if now is None else int(now)
        clean_lease_id = _clean_identifier(lease_id, label="collector lease id")
        clean_holder = _clean_identifier(holder, label="collector lease holder")
        with collector_db(self.db_path) as conn:
            lease = self._lease_row(conn, clean_lease_id, clean_holder)
            if int(lease["expires_at"] or 0) <= timestamp:
                raise CollectorLeaseExpiredError("collector lease has expired")
            account = conn.execute(
                "SELECT platform, profile_dir FROM collector_accounts WHERE id = ?",
                (str(lease["account_id"]),),
            ).fetchone()
            if account is None:
                raise CollectorAccountNotFoundError("collector account not found")
            profile_dir = str(account["profile_dir"] or "").strip()
            if not profile_dir:
                raise CollectorAccountError("collector browser profile is not configured")
            runtime_profile = {
                "platform": str(account["platform"]),
                "profile_dir": profile_dir,
            }
        return consumer(runtime_profile)

    def release(
        self,
        lease_id: str,
        *,
        holder: str,
        succeeded: bool,
        error_code: str = "collector_failure",
        success_cooldown_seconds: int = 0,
        failure_cooldown_seconds: int = 30,
        failure_threshold: int = 3,
        circuit_seconds: int = 300,
        now: int | None = None,
    ) -> dict[str, Any]:
        timestamp = _now() if now is None else int(now)
        clean_lease_id = _clean_identifier(lease_id, label="collector lease id")
        clean_holder = _clean_identifier(holder, label="collector lease holder")
        success_cooldown = _clean_duration(
            success_cooldown_seconds, label="success cooldown"
        )
        failure_cooldown = _clean_duration(
            failure_cooldown_seconds, label="failure cooldown"
        )
        circuit_duration = _clean_duration(circuit_seconds, label="circuit duration")
        threshold = int(failure_threshold)
        if threshold < 1 or threshold > 100:
            raise ValueError("invalid collector failure threshold")
        clean_error = str(error_code or "collector_failure").strip()
        if not _ERROR_CODE_PATTERN.fullmatch(clean_error):
            clean_error = "collector_failure"

        with collector_db(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            lease = self._lease_row(conn, clean_lease_id, clean_holder)
            if int(lease["expires_at"] or 0) <= timestamp:
                conn.execute(
                    "DELETE FROM collector_account_leases WHERE lease_id = ?", (clean_lease_id,)
                )
                raise CollectorLeaseExpiredError("collector lease has expired")
            account_id = str(lease["account_id"])
            account = conn.execute(
                "SELECT * FROM collector_accounts WHERE id = ?", (account_id,)
            ).fetchone()
            if account is None:
                raise CollectorAccountNotFoundError("collector account not found")
            conn.execute(
                "DELETE FROM collector_account_leases WHERE lease_id = ?", (clean_lease_id,)
            )
            if succeeded:
                conn.execute(
                    """
                    UPDATE collector_accounts
                    SET health_status = 'healthy', consecutive_failures = 0,
                        cooldown_until = ?, circuit_open_until = 0,
                        last_success_at = ?, last_error_code = '', updated_at = ?
                    WHERE id = ?
                    """,
                    (timestamp + success_cooldown, timestamp, timestamp, account_id),
                )
            else:
                failures = int(account["consecutive_failures"] or 0) + 1
                circuit_until = (
                    timestamp + circuit_duration
                    if failures >= threshold
                    else int(account["circuit_open_until"] or 0)
                )
                conn.execute(
                    """
                    UPDATE collector_accounts
                    SET health_status = 'degraded', consecutive_failures = ?,
                        cooldown_until = ?, circuit_open_until = ?,
                        last_failure_at = ?, last_error_code = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        failures,
                        timestamp + failure_cooldown,
                        circuit_until,
                        timestamp,
                        clean_error,
                        timestamp,
                        account_id,
                    ),
                )
            updated = conn.execute(
                "SELECT * FROM collector_accounts WHERE id = ?", (account_id,)
            ).fetchone()
            assert updated is not None
            return {
                "released": True,
                "succeeded": bool(succeeded),
                "account": self._public_from_conn(conn, updated, now=timestamp),
            }
