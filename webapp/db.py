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


def _ensure_social_integrity_triggers(conn: sqlite3.Connection) -> None:
    triggers = (
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_proxies_integrity_insert
        BEFORE INSERT ON social_proxies
        WHEN NEW.user_id != 0
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
            THEN RAISE(ABORT, 'social proxy owner user missing')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_proxies_integrity_update
        BEFORE UPDATE OF user_id ON social_proxies
        WHEN NEW.user_id != 0
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
            THEN RAISE(ABORT, 'social proxy owner user missing')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_accounts_integrity_insert
        BEFORE INSERT ON social_accounts
        BEGIN
          SELECT CASE
            WHEN NEW.user_id != 0 AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
            THEN RAISE(ABORT, 'social account owner user missing')
            WHEN NEW.proxy_id != '' AND NOT EXISTS (
              SELECT 1 FROM social_proxies WHERE id = NEW.proxy_id
            )
            THEN RAISE(ABORT, 'social account proxy missing')
            WHEN NEW.proxy_id != '' AND NOT EXISTS (
              SELECT 1 FROM social_proxies WHERE id = NEW.proxy_id AND user_id = NEW.user_id
            )
            THEN RAISE(ABORT, 'social account proxy owner mismatch')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_accounts_integrity_update
        BEFORE UPDATE OF user_id, proxy_id ON social_accounts
        BEGIN
          SELECT CASE
            WHEN NEW.user_id != 0 AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
            THEN RAISE(ABORT, 'social account owner user missing')
            WHEN NEW.proxy_id != '' AND NOT EXISTS (
              SELECT 1 FROM social_proxies WHERE id = NEW.proxy_id
            )
            THEN RAISE(ABORT, 'social account proxy missing')
            WHEN NEW.proxy_id != '' AND NOT EXISTS (
              SELECT 1 FROM social_proxies WHERE id = NEW.proxy_id AND user_id = NEW.user_id
            )
            THEN RAISE(ABORT, 'social account proxy owner mismatch')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_account_totp_integrity_insert
        BEFORE INSERT ON social_account_totp_secrets
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM social_accounts
              WHERE id = NEW.account_id AND user_id = NEW.user_id
            )
            THEN RAISE(ABORT, 'social account TOTP owner mismatch')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_account_totp_integrity_update
        BEFORE UPDATE OF account_id, user_id ON social_account_totp_secrets
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM social_accounts
              WHERE id = NEW.account_id AND user_id = NEW.user_id
            )
            THEN RAISE(ABORT, 'social account TOTP owner mismatch')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_tasks_integrity_insert
        BEFORE INSERT ON social_automation_tasks
        BEGIN
          SELECT CASE
            WHEN NEW.user_id != 0 AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
            THEN RAISE(ABORT, 'social task owner user missing')
            WHEN NOT EXISTS (SELECT 1 FROM social_accounts WHERE id = NEW.account_id)
            THEN RAISE(ABORT, 'social task account missing')
            WHEN NOT EXISTS (
              SELECT 1 FROM social_accounts WHERE id = NEW.account_id AND user_id = NEW.user_id
            )
            THEN RAISE(ABORT, 'social task account owner mismatch')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_tasks_integrity_update
        BEFORE UPDATE OF user_id, account_id ON social_automation_tasks
        BEGIN
          SELECT CASE
            WHEN NEW.user_id != 0 AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
            THEN RAISE(ABORT, 'social task owner user missing')
            WHEN NOT EXISTS (SELECT 1 FROM social_accounts WHERE id = NEW.account_id)
            THEN RAISE(ABORT, 'social task account missing')
            WHEN NOT EXISTS (
              SELECT 1 FROM social_accounts WHERE id = NEW.account_id AND user_id = NEW.user_id
            )
            THEN RAISE(ABORT, 'social task account owner mismatch')
          END;
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_users_delete_restrict
        BEFORE DELETE ON users
        WHEN EXISTS (SELECT 1 FROM social_proxies WHERE user_id = OLD.id)
          OR EXISTS (SELECT 1 FROM social_accounts WHERE user_id = OLD.id)
          OR EXISTS (SELECT 1 FROM social_automation_tasks WHERE user_id = OLD.id)
        BEGIN
          SELECT RAISE(ABORT, 'social resources still reference user');
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_accounts_delete_restrict
        BEFORE DELETE ON social_accounts
        WHEN EXISTS (SELECT 1 FROM social_automation_tasks WHERE account_id = OLD.id)
        BEGIN
          SELECT RAISE(ABORT, 'social tasks still reference account');
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_social_proxies_delete_restrict
        BEFORE DELETE ON social_proxies
        WHEN EXISTS (SELECT 1 FROM social_accounts WHERE proxy_id = OLD.id)
        BEGIN
          SELECT RAISE(ABORT, 'social accounts still reference proxy');
        END
        """,
    )
    trigger_names = (
        "trg_social_proxies_integrity_insert",
        "trg_social_proxies_integrity_update",
        "trg_social_accounts_integrity_insert",
        "trg_social_accounts_integrity_update",
        "trg_social_account_totp_integrity_insert",
        "trg_social_account_totp_integrity_update",
        "trg_social_tasks_integrity_insert",
        "trg_social_tasks_integrity_update",
        "trg_social_users_delete_restrict",
        "trg_social_accounts_delete_restrict",
        "trg_social_proxies_delete_restrict",
    )
    for name in trigger_names:
        conn.execute(f'DROP TRIGGER IF EXISTS "{name}"')
    for statement in triggers:
        conn.execute(statement)


def _ensure_username_reservation_triggers(conn: sqlite3.Connection) -> None:
    conn.execute("DROP TRIGGER IF EXISTS trg_users_reserved_username_insert")
    conn.execute("DROP TRIGGER IF EXISTS trg_users_reserved_username_update")
    conn.execute("DROP TRIGGER IF EXISTS trg_users_reserve_username_after_insert")
    conn.execute("DROP TRIGGER IF EXISTS trg_users_reserve_username_after_update")
    conn.execute(
        """
        CREATE TRIGGER trg_users_reserved_username_insert
        BEFORE INSERT ON users
        WHEN EXISTS (
          SELECT 1 FROM username_reservations
          WHERE username = NEW.username COLLATE NOCASE
        )
        BEGIN
          SELECT RAISE(ABORT, 'username is permanently reserved');
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER trg_users_reserved_username_update
        BEFORE UPDATE OF username ON users
        WHEN NEW.username != OLD.username COLLATE NOCASE
          AND EXISTS (
            SELECT 1 FROM username_reservations
            WHERE username = NEW.username COLLATE NOCASE AND user_id != OLD.id
          )
        BEGIN
          SELECT RAISE(ABORT, 'username is permanently reserved');
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER trg_users_reserve_username_after_insert
        AFTER INSERT ON users
        BEGIN
          INSERT OR IGNORE INTO username_reservations(username, user_id, created_at)
          VALUES (NEW.username, NEW.id, NEW.created_at);
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER trg_users_reserve_username_after_update
        AFTER UPDATE OF username ON users
        WHEN NEW.username != OLD.username COLLATE NOCASE
        BEGIN
          INSERT OR IGNORE INTO username_reservations(username, user_id, created_at)
          VALUES (NEW.username, NEW.id, NEW.updated_at);
        END
        """
    )


def _ensure_commercial_billing_schema(conn: sqlite3.Connection) -> None:
    statements = (
        """
        CREATE TABLE IF NOT EXISTS billing_wallets (
          user_id INTEGER PRIMARY KEY,
          credit_units INTEGER NOT NULL DEFAULT 0 CHECK(credit_units >= 0),
          billing_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(billing_mode IN ('legacy', 'enforced')),
          unlimited_compute INTEGER NOT NULL DEFAULT 0 CHECK(unlimited_compute IN (0, 1)),
          migrated_legacy_balance INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_catalog_versions (
          id TEXT PRIMARY KEY,
          version_number INTEGER NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'retired')),
          catalog_json TEXT NOT NULL,
          effective_at INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          published_at INTEGER NOT NULL DEFAULT 0
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_orders (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('subscription', 'credit_pack')),
          sku TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
          renewal_subscription_ids_json TEXT NOT NULL DEFAULT '[]',
          amount_ntd_cents INTEGER NOT NULL CHECK(amount_ntd_cents >= 0),
          catalog_version_id TEXT NOT NULL,
          price_snapshot_json TEXT NOT NULL,
          payer_name TEXT NOT NULL DEFAULT '',
          payment_reference TEXT NOT NULL DEFAULT '',
          paid_at INTEGER NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '',
          proof_path TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
          idempotency_key TEXT NOT NULL,
          reviewed_by INTEGER NOT NULL DEFAULT 0,
          reviewed_at INTEGER NOT NULL DEFAULT 0,
          review_note TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(user_id, idempotency_key)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_subscriptions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          plan_sku TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'cancelled')),
          current_period_end INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_subscription_periods (
          id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          source_order_id TEXT NOT NULL,
          start_at INTEGER NOT NULL,
          end_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'active', 'expired', 'cancelled')),
          created_at INTEGER NOT NULL,
          UNIQUE(subscription_id, start_at)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_image_grants (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('subscription_monthly', 'credit_pack_bonus', 'admin_adjustment')),
          source_ref TEXT NOT NULL,
          total_count INTEGER NOT NULL CHECK(total_count >= 0),
          remaining_count INTEGER NOT NULL CHECK(remaining_count >= 0),
          available_at INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(source_type, source_ref)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_reservations (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          ref_type TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          sku TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('held', 'settled', 'released', 'waived')),
          reserved_credit_units INTEGER NOT NULL DEFAULT 0,
          reserved_image_count INTEGER NOT NULL DEFAULT 0,
          settled_credit_units INTEGER NOT NULL DEFAULT 0,
          settled_image_count INTEGER NOT NULL DEFAULT 0,
          catalog_version_id TEXT NOT NULL DEFAULT '',
          meta_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(ref_type, ref_id, sku)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS billing_ledger (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          asset_type TEXT NOT NULL CHECK(asset_type IN ('credit', 'image', 'subscription', 'audit')),
          event_type TEXT NOT NULL,
          amount_units INTEGER NOT NULL DEFAULT 0,
          balance_after_units INTEGER NOT NULL DEFAULT 0,
          ref_type TEXT NOT NULL DEFAULT '',
          ref_id TEXT NOT NULL DEFAULT '',
          order_id TEXT NOT NULL DEFAULT '',
          reservation_id TEXT NOT NULL DEFAULT '',
          meta_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        )
        """,
    )
    for statement in statements:
        conn.execute(statement)
    wallet_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(billing_wallets)").fetchall()}
    if "unlimited_compute" not in wallet_columns:
        conn.execute(
            "ALTER TABLE billing_wallets ADD COLUMN unlimited_compute INTEGER NOT NULL DEFAULT 0 "
            "CHECK(unlimited_compute IN (0, 1))"
        )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_catalog_active ON billing_catalog_versions(status) WHERE status = 'active'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_orders_user ON billing_orders(user_id, created_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders(status, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user ON billing_subscriptions(user_id, current_period_end)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_periods_user ON billing_subscription_periods(user_id, start_at, end_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_grants_user ON billing_image_grants(user_id, available_at, expires_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_reservations_ref ON billing_reservations(ref_type, ref_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_billing_ledger_user ON billing_ledger(user_id, created_at DESC)")

    task_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    for column, definition in {
        "billing_reservation_id": "TEXT NOT NULL DEFAULT ''",
        "credit_cost_units": "INTEGER NOT NULL DEFAULT 0",
        "free_image_count": "INTEGER NOT NULL DEFAULT 0",
    }.items():
        if column not in task_columns:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {column} {definition}")
    social_task_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(social_automation_tasks)").fetchall()}
    for column, definition in {
        "billing_reservation_id": "TEXT NOT NULL DEFAULT ''",
        "credit_cost_units": "INTEGER NOT NULL DEFAULT 0",
        "free_image_count": "INTEGER NOT NULL DEFAULT 0",
    }.items():
        if column not in social_task_columns:
            conn.execute(f"ALTER TABLE social_automation_tasks ADD COLUMN {column} {definition}")


def init_db() -> None:
    os.makedirs(os.path.dirname(get_db_path()), exist_ok=True)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              is_disabled INTEGER NOT NULL DEFAULT 0,
              balance_cents INTEGER NOT NULL DEFAULT 0,
              account_type TEXT NOT NULL DEFAULT 'managed',
              approval_status TEXT NOT NULL DEFAULT 'approved',
              full_name TEXT NOT NULL DEFAULT '',
              avatar_url TEXT NOT NULL DEFAULT '',
              email TEXT NOT NULL DEFAULT '',
              phone TEXT NOT NULL DEFAULT '',
              profile_signature TEXT NOT NULL DEFAULT '',
              profile_tags TEXT NOT NULL DEFAULT '',
              company TEXT NOT NULL DEFAULT '',
              use_case TEXT NOT NULL DEFAULT '',
              admin_note TEXT NOT NULL DEFAULT '',
              approved_at INTEGER NOT NULL DEFAULT 0,
              approved_by INTEGER NOT NULL DEFAULT 0,
              last_login_at INTEGER NOT NULL DEFAULT 0,
              must_change_password INTEGER NOT NULL DEFAULT 0,
              password_expires_at INTEGER NOT NULL DEFAULT 0,
              deleted_at INTEGER NOT NULL DEFAULT 0,
              deleted_by INTEGER NOT NULL DEFAULT 0,
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
            CREATE TABLE IF NOT EXISTS username_reservations (
              username TEXT PRIMARY KEY COLLATE NOCASE,
              user_id INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO username_reservations(username, user_id, created_at)
            SELECT username, id, created_at FROM users
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
            CREATE TABLE IF NOT EXISTS user_browser_settings (
              user_id INTEGER PRIMARY KEY,
              completion_policy TEXT NOT NULL DEFAULT 'immediate_close'
                CHECK(completion_policy IN ('immediate_close', 'review_hold')),
              review_hold_seconds INTEGER NOT NULL DEFAULT 30
                CHECK(review_hold_seconds BETWEEN 10 AND 300),
              manual_timeout_seconds INTEGER NOT NULL DEFAULT 900
                CHECK(manual_timeout_seconds BETWEEN 300 AND 1800),
              requested_concurrency INTEGER NOT NULL DEFAULT 1
                CHECK(requested_concurrency BETWEEN 1 AND 12),
              text_input_mode TEXT NOT NULL DEFAULT 'paste'
                CHECK(text_input_mode IN ('paste', 'type')),
              auto_configured INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        browser_setting_columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(user_browser_settings)").fetchall()
        }
        if "standby_seconds" not in browser_setting_columns:
            conn.execute(
                "ALTER TABLE user_browser_settings ADD COLUMN standby_seconds INTEGER NOT NULL DEFAULT 0"
            )
        if "auto_close_seconds" not in browser_setting_columns:
            conn.execute(
                "ALTER TABLE user_browser_settings ADD COLUMN auto_close_seconds INTEGER NOT NULL DEFAULT 30"
            )
            conn.execute(
                """
                UPDATE user_browser_settings
                SET auto_close_seconds = review_hold_seconds
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
              user_id INTEGER NOT NULL DEFAULT 0,
              name TEXT NOT NULL,
              proxy_type TEXT NOT NULL,
              host TEXT NOT NULL,
              port INTEGER NOT NULL,
              username TEXT NOT NULL DEFAULT '',
              password TEXT NOT NULL DEFAULT '',
              country TEXT NOT NULL DEFAULT '',
              region TEXT NOT NULL DEFAULT '',
              city TEXT NOT NULL DEFAULT '',
              isp TEXT NOT NULL DEFAULT '',
              source TEXT NOT NULL DEFAULT 'manual',
              ip_type TEXT NOT NULL DEFAULT 'static_residential',
              purchase_status TEXT NOT NULL DEFAULT 'owned',
              note TEXT NOT NULL DEFAULT '',
              expires_at INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'active',
              last_check_at INTEGER NOT NULL DEFAULT 0,
              last_check_result TEXT NOT NULL DEFAULT '',
              client_request_id TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_accounts (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL DEFAULT 0,
              persona_id TEXT NOT NULL,
              platform TEXT NOT NULL,
              username TEXT NOT NULL,
              display_name TEXT NOT NULL DEFAULT '',
              profile_dir TEXT NOT NULL,
              proxy_id TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'pending_login',
              health_status TEXT NOT NULL DEFAULT 'unknown',
              health_checked_at INTEGER NOT NULL DEFAULT 0,
              health_detail TEXT NOT NULL DEFAULT '',
              status_attempted_at INTEGER NOT NULL DEFAULT 0,
              status_attempt_error TEXT NOT NULL DEFAULT '',
              status_source_task_id TEXT NOT NULL DEFAULT '',
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
            CREATE TABLE IF NOT EXISTS proxy_market_items (
              id TEXT PRIMARY KEY,
              sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
              display_name TEXT NOT NULL,
              provider_key TEXT NOT NULL DEFAULT '',
              proxy_type TEXT NOT NULL DEFAULT 'socks5',
              host TEXT NOT NULL,
              port INTEGER NOT NULL,
              credential_owner_user_id INTEGER NOT NULL DEFAULT 0,
              username_ciphertext TEXT NOT NULL DEFAULT '',
              password_ciphertext TEXT NOT NULL DEFAULT '',
              country TEXT NOT NULL DEFAULT '',
              region TEXT NOT NULL DEFAULT '',
              city TEXT NOT NULL DEFAULT '',
              isp TEXT NOT NULL DEFAULT '',
              ip_type TEXT NOT NULL DEFAULT 'static_residential',
              description TEXT NOT NULL DEFAULT '',
              tags_json TEXT NOT NULL DEFAULT '[]',
              use_cases_json TEXT NOT NULL DEFAULT '[]',
              display_price_cents INTEGER NOT NULL DEFAULT 0,
              currency TEXT NOT NULL DEFAULT 'TWD',
              billing_cycle TEXT NOT NULL DEFAULT 'month',
              status TEXT NOT NULL DEFAULT 'draft',
              health_status TEXT NOT NULL DEFAULT 'pending',
              latency_ms INTEGER NOT NULL DEFAULT 0,
              last_check_at INTEGER NOT NULL DEFAULT 0,
              last_check_result_json TEXT NOT NULL DEFAULT '{}',
              expires_at INTEGER NOT NULL DEFAULT 0,
              published_at INTEGER NOT NULL DEFAULT 0,
              created_by INTEGER NOT NULL DEFAULT 0,
              updated_by INTEGER NOT NULL DEFAULT 0,
              version INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS proxy_market_allocations (
              id TEXT PRIMARY KEY,
              item_id TEXT NOT NULL,
              user_id INTEGER NOT NULL,
              social_proxy_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              claim_mode TEXT NOT NULL DEFAULT 'free_add',
              display_price_cents_snapshot INTEGER NOT NULL DEFAULT 0,
              currency TEXT NOT NULL DEFAULT 'TWD',
              idempotency_key TEXT NOT NULL DEFAULT '',
              claimed_at INTEGER NOT NULL,
              released_at INTEGER NOT NULL DEFAULT 0,
              seen_at INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(item_id) REFERENCES proxy_market_items(id),
              FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS proxy_market_item_checks (
              item_id TEXT PRIMARY KEY,
              check_id TEXT NOT NULL UNIQUE,
              base_version INTEGER NOT NULL,
              proxy_type TEXT NOT NULL,
              host TEXT NOT NULL,
              port INTEGER NOT NULL,
              credential_owner_user_id INTEGER NOT NULL DEFAULT 0,
              username_ciphertext TEXT NOT NULL DEFAULT '',
              password_ciphertext TEXT NOT NULL DEFAULT '',
              country TEXT NOT NULL DEFAULT '',
              region TEXT NOT NULL DEFAULT '',
              city TEXT NOT NULL DEFAULT '',
              isp TEXT NOT NULL DEFAULT '',
              expires_at INTEGER NOT NULL DEFAULT 0,
              health_status TEXT NOT NULL DEFAULT 'failed',
              latency_ms INTEGER NOT NULL DEFAULT 0,
              checked_at INTEGER NOT NULL DEFAULT 0,
              result_json TEXT NOT NULL DEFAULT '{}',
              created_by INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              consumed_at INTEGER NOT NULL DEFAULT 0,
              published_item_version INTEGER NOT NULL DEFAULT 0,
              publish_result_json TEXT NOT NULL DEFAULT '{}',
              FOREIGN KEY(item_id) REFERENCES proxy_market_items(id) ON DELETE CASCADE
            )
            """
        )
        check_columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(proxy_market_item_checks)").fetchall()
        }
        if "published_item_version" not in check_columns:
            conn.execute(
                "ALTER TABLE proxy_market_item_checks "
                "ADD COLUMN published_item_version INTEGER NOT NULL DEFAULT 0"
            )
        if "publish_result_json" not in check_columns:
            conn.execute(
                "ALTER TABLE proxy_market_item_checks "
                "ADD COLUMN publish_result_json TEXT NOT NULL DEFAULT '{}'"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS proxy_market_user_state (
              user_id INTEGER PRIMARY KEY,
              last_catalog_seen_at INTEGER NOT NULL DEFAULT 0,
              last_proxy_pool_seen_at INTEGER NOT NULL DEFAULT 0,
              claim_limit_override INTEGER,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_account_totp_secrets (
              account_id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              secret_ciphertext TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              last_used_counter INTEGER NOT NULL DEFAULT -1,
              last_attempt_at INTEGER NOT NULL DEFAULT 0,
              last_verified_at INTEGER NOT NULL DEFAULT 0,
              last_error TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(account_id) REFERENCES social_accounts(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_automation_tasks (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL DEFAULT 0,
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
              daily_publish_waived INTEGER NOT NULL DEFAULT 0,
              daily_publish_committed INTEGER NOT NULL DEFAULT 0,
              daily_publish_committed_at INTEGER NOT NULL DEFAULT 0,
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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_audit_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              admin_user_id INTEGER NOT NULL,
              action TEXT NOT NULL,
              target_user_id INTEGER NOT NULL DEFAULT 0,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS password_vault (
              user_id INTEGER PRIMARY KEY,
              ciphertext TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS persona_owners (
              archive_id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS persona_group_owners (
              group_id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_accounts_persona ON social_accounts(persona_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_tasks_queue ON social_automation_tasks(status, scheduled_at, priority, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_tasks_account ON social_automation_tasks(account_id, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_logs_task ON social_automation_logs(task_id, created_at)")
        user_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        user_column_migrations = {
            "account_type": "TEXT NOT NULL DEFAULT 'managed'",
            "approval_status": "TEXT NOT NULL DEFAULT 'approved'",
            "full_name": "TEXT NOT NULL DEFAULT ''",
            "avatar_url": "TEXT NOT NULL DEFAULT ''",
            "email": "TEXT NOT NULL DEFAULT ''",
            "phone": "TEXT NOT NULL DEFAULT ''",
            "profile_signature": "TEXT NOT NULL DEFAULT ''",
            "profile_tags": "TEXT NOT NULL DEFAULT ''",
            "company": "TEXT NOT NULL DEFAULT ''",
            "use_case": "TEXT NOT NULL DEFAULT ''",
            "admin_note": "TEXT NOT NULL DEFAULT ''",
            "approved_at": "INTEGER NOT NULL DEFAULT 0",
            "approved_by": "INTEGER NOT NULL DEFAULT 0",
            "last_login_at": "INTEGER NOT NULL DEFAULT 0",
            "must_change_password": "INTEGER NOT NULL DEFAULT 0",
            "password_expires_at": "INTEGER NOT NULL DEFAULT 0",
            "deleted_at": "INTEGER NOT NULL DEFAULT 0",
            "deleted_by": "INTEGER NOT NULL DEFAULT 0",
        }
        for column, definition in user_column_migrations.items():
            if column not in user_columns:
                conn.execute(f"ALTER TABLE users ADD COLUMN {column} {definition}")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approval_status, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, created_at DESC)")
        proxy_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(social_proxies)").fetchall()}
        proxy_column_migrations = {
            "user_id": "INTEGER NOT NULL DEFAULT 0",
            "source": "TEXT NOT NULL DEFAULT 'manual'",
            "ip_type": "TEXT NOT NULL DEFAULT 'static_residential'",
            "purchase_status": "TEXT NOT NULL DEFAULT 'owned'",
            "region": "TEXT NOT NULL DEFAULT ''",
            "city": "TEXT NOT NULL DEFAULT ''",
            "note": "TEXT NOT NULL DEFAULT ''",
            "expires_at": "INTEGER NOT NULL DEFAULT 0",
            "client_request_id": "TEXT NOT NULL DEFAULT ''",
            "market_item_id": "TEXT NOT NULL DEFAULT ''",
            "market_allocation_id": "TEXT NOT NULL DEFAULT ''",
        }
        for column, definition in proxy_column_migrations.items():
            if column not in proxy_columns:
                conn.execute(f"ALTER TABLE social_proxies ADD COLUMN {column} {definition}")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_proxies_client_request "
            "ON social_proxies(user_id, client_request_id) WHERE client_request_id <> ''"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_proxies_market_item "
            "ON social_proxies(market_item_id) WHERE market_item_id <> ''"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_market_active_item "
            "ON proxy_market_allocations(item_id) WHERE status = 'active'"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_market_active_proxy "
            "ON proxy_market_allocations(social_proxy_id) WHERE status = 'active'"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_market_idempotency "
            "ON proxy_market_allocations(user_id, idempotency_key) WHERE idempotency_key <> ''"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_proxy_market_catalog "
            "ON proxy_market_items(status, health_status, published_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_proxy_market_user_allocations "
            "ON proxy_market_allocations(user_id, status, claimed_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_proxy_market_item_checks_publishable "
            "ON proxy_market_item_checks(health_status, checked_at DESC, consumed_at)"
        )
        account_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(social_accounts)").fetchall()}
        if "user_id" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
        if "login_username" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN login_username TEXT NOT NULL DEFAULT ''")
        if "login_password" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN login_password TEXT NOT NULL DEFAULT ''")
        if "login_credentials_updated_at" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN login_credentials_updated_at INTEGER NOT NULL DEFAULT 0")
        if "health_status" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'")
        if "health_checked_at" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN health_checked_at INTEGER NOT NULL DEFAULT 0")
        if "health_detail" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN health_detail TEXT NOT NULL DEFAULT ''")
        if "status_attempted_at" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN status_attempted_at INTEGER NOT NULL DEFAULT 0")
        if "status_attempt_error" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN status_attempt_error TEXT NOT NULL DEFAULT ''")
        if "status_source_task_id" not in account_columns:
            conn.execute("ALTER TABLE social_accounts ADD COLUMN status_source_task_id TEXT NOT NULL DEFAULT ''")
        task_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(social_automation_tasks)").fetchall()}
        if "user_id" not in task_columns:
            conn.execute("ALTER TABLE social_automation_tasks ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
        if "daily_publish_waived" not in task_columns:
            conn.execute("ALTER TABLE social_automation_tasks ADD COLUMN daily_publish_waived INTEGER NOT NULL DEFAULT 0")
        if "daily_publish_committed" not in task_columns:
            conn.execute("ALTER TABLE social_automation_tasks ADD COLUMN daily_publish_committed INTEGER NOT NULL DEFAULT 0")
        if "daily_publish_committed_at" not in task_columns:
            conn.execute("ALTER TABLE social_automation_tasks ADD COLUMN daily_publish_committed_at INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            """
            UPDATE social_automation_tasks
            SET daily_publish_committed = 1,
                daily_publish_committed_at = CASE
                  WHEN daily_publish_committed_at > 0 THEN daily_publish_committed_at
                  WHEN finished_at > 0 THEN finished_at
                  ELSE updated_at
                END
            WHERE task_type = 'publish_post'
              AND daily_publish_committed = 0
              AND (
                status = 'success'
                OR REPLACE(result_json, ' ', '') LIKE '%\"publish_submitted\":true%'
                OR REPLACE(result_json, ' ', '') LIKE '%\"publish_outcome_unknown\":true%'
              )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS social_daily_publish_slots (
              task_id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              quota_day TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('planned', 'reserved', 'armed', 'submitted', 'confirmed', 'unknown', 'released', 'waived')),
              waived INTEGER NOT NULL DEFAULT 0,
              submitted_at INTEGER NOT NULL DEFAULT 0,
              released_at INTEGER NOT NULL DEFAULT 0,
              release_reason TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute("DROP INDEX IF EXISTS idx_social_accounts_persona_platform_username")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_owner_persona_platform_username "
            "ON social_accounts(user_id, persona_id, platform, username COLLATE NOCASE)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_accounts_user ON social_accounts(user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_proxies_user ON social_proxies(user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_social_tasks_user ON social_automation_tasks(user_id, created_at)")
        conn.execute("DROP INDEX IF EXISTS idx_social_tasks_daily_publish")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_social_tasks_daily_publish "
            "ON social_automation_tasks(user_id, task_type, daily_publish_waived, daily_publish_committed, daily_publish_committed_at, status, scheduled_at, created_at)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_persona_owners_user ON persona_owners(user_id, archive_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_persona_group_owners_user ON persona_group_owners(user_id, group_id)")
        _ensure_commercial_billing_schema(conn)
        conn.execute(
            """
            UPDATE social_automation_tasks
            SET daily_publish_waived = 1
            WHERE daily_publish_waived = 0
              AND (
                (
                  billing_reservation_id != ''
                  AND EXISTS (
                    SELECT 1
                    FROM billing_reservations reservation
                    WHERE reservation.id = social_automation_tasks.billing_reservation_id
                      AND reservation.status = 'waived'
                      AND REPLACE(reservation.meta_json, ' ', '') LIKE '%\"waived_reason\":\"admin\"%'
                  )
                )
                OR EXISTS (
                  SELECT 1
                  FROM billing_ledger ledger
                  WHERE ledger.event_type = 'admin_waived'
                    AND ledger.ref_type = 'social_task'
                    AND ledger.ref_id = social_automation_tasks.id
                )
              )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO social_daily_publish_slots(
              task_id, user_id, quota_day, state, waived, submitted_at,
              released_at, release_reason, created_at, updated_at
            )
            SELECT
              task.id,
              task.user_id,
              strftime(
                '%Y-%m-%d',
                CASE
                  WHEN task.daily_publish_committed_at > 0 THEN task.daily_publish_committed_at
                  WHEN task.scheduled_at > 0 THEN task.scheduled_at
                  ELSE task.created_at
                END,
                'unixepoch',
                '+8 hours'
              ),
              CASE
                WHEN task.daily_publish_waived = 1 OR owner.is_admin = 1 THEN 'waived'
                WHEN task.daily_publish_committed = 1 AND task.status = 'success' THEN 'confirmed'
                WHEN task.daily_publish_committed = 1 AND REPLACE(task.result_json, ' ', '') LIKE '%\"publish_outcome_unknown\":true%' THEN 'unknown'
                WHEN task.daily_publish_committed = 1 THEN 'submitted'
                WHEN task.status IN ('preparing', 'queued') THEN 'planned'
                WHEN task.status IN ('running', 'need_manual') THEN 'reserved'
                ELSE 'released'
              END,
              CASE WHEN task.daily_publish_waived = 1 OR owner.is_admin = 1 THEN 1 ELSE 0 END,
              task.daily_publish_committed_at,
              CASE WHEN task.status IN ('failed', 'cancelled') AND task.daily_publish_committed = 0 THEN COALESCE(NULLIF(task.finished_at, 0), task.updated_at) ELSE 0 END,
              CASE WHEN task.status IN ('failed', 'cancelled') AND task.daily_publish_committed = 0 THEN 'historical_terminal_task' ELSE '' END,
              task.created_at,
              task.updated_at
            FROM social_automation_tasks task
            LEFT JOIN users owner ON owner.id = task.user_id
            WHERE task.task_type = 'publish_post'
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_daily_publish_slots_usage "
            "ON social_daily_publish_slots(user_id, quota_day, waived, state)"
        )
        conn.execute(
            """
            UPDATE social_daily_publish_slots
            SET waived = 1, state = 'waived', updated_at = CASE WHEN updated_at > 0 THEN updated_at ELSE created_at END
            WHERE task_id IN (
              SELECT task.id
              FROM social_automation_tasks task
              LEFT JOIN users owner ON owner.id = task.user_id
              WHERE task.daily_publish_waived = 1 OR owner.is_admin = 1
            )
            """
        )
        from .governance import ensure_schema as ensure_governance_schema

        ensure_governance_schema(conn)
        from .commercial_billing import bootstrap_billing

        bootstrap_billing(conn)
        _ensure_username_reservation_triggers(conn)
        _ensure_social_integrity_triggers(conn)


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
