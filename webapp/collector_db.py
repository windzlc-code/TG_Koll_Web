"""Independent SQLite storage for the administrator collector account pool."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Final, Iterator


COLLECTOR_DB_PATH_ENV: Final = "COLLECTOR_DB_PATH"
SCHEMA_VERSION: Final = 1


def get_collector_db_path() -> str:
    configured = str(os.getenv(COLLECTOR_DB_PATH_ENV, "") or "").strip()
    if configured:
        return str(Path(configured).expanduser().resolve())
    data_dir = str(os.getenv("WEBAPP_DATA_DIR", "") or "").strip()
    root = (
        Path(data_dir).expanduser().resolve()
        if data_dir
        else Path(__file__).resolve().parent.parent / "webapp_data"
    )
    return str((root / "collector_accounts.db").resolve())


def _prepare_parent(path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            path.parent.chmod(0o700)
        except OSError:
            pass


def connect_collector_db(path: str | Path | None = None) -> sqlite3.Connection:
    target = Path(path or get_collector_db_path()).expanduser().resolve()
    _prepare_parent(target)
    conn = sqlite3.connect(str(target), timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    if os.name != "nt":
        try:
            target.chmod(0o600)
        except OSError:
            pass
    return conn


@contextmanager
def collector_db(path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = connect_collector_db(path)
    try:
        yield conn
        if conn.in_transaction:
            conn.commit()
    except Exception:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.close()


def init_collector_db(path: str | Path | None = None) -> str:
    resolved_path = str(Path(path or get_collector_db_path()).expanduser().resolve())
    with collector_db(resolved_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS collector_schema (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              version INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS collector_accounts (
              id TEXT PRIMARY KEY,
              pool_id TEXT NOT NULL DEFAULT 'pool_primary',
              source_system TEXT NOT NULL DEFAULT '',
              source_account_id TEXT NOT NULL DEFAULT '',
              source_owner_user_id INTEGER NOT NULL DEFAULT 0,
              platform TEXT NOT NULL CHECK(platform IN ('threads', 'instagram')),
              username TEXT NOT NULL,
              display_name TEXT NOT NULL DEFAULT '',
              login_username TEXT NOT NULL DEFAULT '',
              profile_dir TEXT NOT NULL DEFAULT '',
              proxy_id TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'importing'
                CHECK(status IN ('importing','pending_validation','ready','disabled')),
              health_status TEXT NOT NULL DEFAULT 'unknown',
              cooldown_until INTEGER NOT NULL DEFAULT 0,
              circuit_open_until INTEGER NOT NULL DEFAULT 0,
              consecutive_failures INTEGER NOT NULL DEFAULT 0,
              last_failure_at INTEGER NOT NULL DEFAULT 0,
              last_success_at INTEGER NOT NULL DEFAULT 0,
              last_selected_at INTEGER NOT NULL DEFAULT 0,
              last_error_code TEXT NOT NULL DEFAULT '',
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS collector_account_capabilities (
              account_id TEXT NOT NULL,
              capability TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, capability),
              FOREIGN KEY(account_id) REFERENCES collector_accounts(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS collector_account_secrets (
              account_id TEXT NOT NULL,
              secret_kind TEXT NOT NULL
                CHECK(secret_kind IN ('login_password','totp','proxy_username','proxy_password')),
              ciphertext TEXT NOT NULL,
              key_version TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, secret_kind),
              FOREIGN KEY(account_id) REFERENCES collector_accounts(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS collector_account_leases (
              account_id TEXT PRIMARY KEY,
              lease_id TEXT NOT NULL UNIQUE,
              holder TEXT NOT NULL,
              capability TEXT NOT NULL,
              acquired_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              FOREIGN KEY(account_id) REFERENCES collector_accounts(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_accounts_source
            ON collector_accounts(source_system, source_account_id)
            WHERE source_system <> '' AND source_account_id <> ''
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_accounts_pool_identity
            ON collector_accounts(pool_id, platform, username COLLATE NOCASE)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_collector_accounts_selection
            ON collector_accounts(
              pool_id, platform, status, cooldown_until,
              circuit_open_until, last_selected_at, id
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_collector_capability_selection
            ON collector_account_capabilities(capability, account_id)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_collector_leases_expiry
            ON collector_account_leases(expires_at)
            """
        )
        conn.execute(
            """
            INSERT INTO collector_schema(singleton, version, updated_at)
            VALUES (1, ?, CAST(strftime('%s','now') AS INTEGER))
            ON CONFLICT(singleton) DO UPDATE SET
              version = excluded.version,
              updated_at = excluded.updated_at
            """,
            (SCHEMA_VERSION,),
        )
    return resolved_path
