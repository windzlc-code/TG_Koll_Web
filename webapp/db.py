import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


def get_db_path() -> str:
    env = str(os.getenv("APP_DB_PATH", "") or "").strip()
    if env:
        return os.path.abspath(env)
    data_dir = str(os.getenv("WEBAPP_DATA_DIR", "") or "").strip()
    if data_dir:
        return str((Path(data_dir).resolve() / "app.db").absolute())
    root_dir = Path(__file__).resolve().parent.parent
    return str((root_dir / "webapp_data" / "app.db").absolute())


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    os.makedirs(os.path.dirname(get_db_path()), exist_ok=True)
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              is_disabled INTEGER NOT NULL DEFAULT 0,
              balance_cents INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_config (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              status TEXT NOT NULL,
              input_json TEXT NOT NULL,
              output_json TEXT NOT NULL,
              error TEXT NOT NULL,
              runninghub_task_id TEXT NOT NULL,
              usage_json TEXT NOT NULL,
              cost_cents INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ledger (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              amount_cents INTEGER NOT NULL,
              ref_task_id TEXT NOT NULL,
              meta_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              user_id INTEGER NOT NULL,
              kind TEXT NOT NULL,
              message TEXT NOT NULL,
              data_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_proxies (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              proxy_type TEXT NOT NULL,
              host TEXT NOT NULL,
              port INTEGER NOT NULL,
              username TEXT NOT NULL DEFAULT '',
              password TEXT NOT NULL DEFAULT '',
              country TEXT NOT NULL DEFAULT '',
              isp TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'active',
              last_check_at INTEGER NOT NULL DEFAULT 0,
              last_check_result TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_accounts (
              id TEXT PRIMARY KEY,
              persona_id TEXT NOT NULL,
              platform TEXT NOT NULL,
              username TEXT NOT NULL,
              display_name TEXT NOT NULL DEFAULT '',
              profile_dir TEXT NOT NULL,
              proxy_id TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'pending_login',
              last_login_check_at INTEGER NOT NULL DEFAULT 0,
              last_run_at INTEGER NOT NULL DEFAULT 0,
              last_error TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_automation_tasks (
              id TEXT PRIMARY KEY,
              persona_id TEXT NOT NULL,
              account_id TEXT NOT NULL,
              platform TEXT NOT NULL,
              task_type TEXT NOT NULL,
              priority INTEGER NOT NULL DEFAULT 50,
              status TEXT NOT NULL DEFAULT 'queued',
              scheduled_at INTEGER NOT NULL DEFAULT 0,
              started_at INTEGER NOT NULL DEFAULT 0,
              finished_at INTEGER NOT NULL DEFAULT 0,
              payload_json TEXT NOT NULL,
              result_json TEXT NOT NULL DEFAULT '{}',
              error TEXT NOT NULL DEFAULT '',
              retry_count INTEGER NOT NULL DEFAULT 0,
              max_retries INTEGER NOT NULL DEFAULT 1,
              created_by TEXT NOT NULL DEFAULT 'web',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_automation_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              level TEXT NOT NULL,
              stage TEXT NOT NULL,
              message TEXT NOT NULL,
              data_json TEXT NOT NULL DEFAULT '{}',
              screenshot_path TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              FOREIGN KEY(task_id) REFERENCES social_automation_tasks(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_accounts_persona ON social_accounts(persona_id)")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_persona_platform_username "
            "ON social_accounts(persona_id, platform, username COLLATE NOCASE)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_tasks_queue ON social_automation_tasks(status, scheduled_at, priority, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_tasks_account ON social_automation_tasks(account_id, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_logs_task ON social_automation_logs(task_id, created_at)")
        account_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(social_accounts)").fetchall()}
        if "login_username" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN login_username TEXT NOT NULL DEFAULT ''")
        if "login_password" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN login_password TEXT NOT NULL DEFAULT ''")
        if "login_credentials_updated_at" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN login_credentials_updated_at INTEGER NOT NULL DEFAULT 0")


def get_admin_config(conn: sqlite3.Connection, key: str, default: Any) -> Any:
    row = conn.execute("SELECT value_json FROM admin_config WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(str(row["value_json"]))
    except Exception:
        return default


def set_admin_config(conn: sqlite3.Connection, key: str, value: Any, now_ts: int) -> None:
    conn.execute(
        """
        INSERT INTO admin_config(key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
        """,
        (key, json.dumps(value, ensure_ascii=False), int(now_ts)),
    )
