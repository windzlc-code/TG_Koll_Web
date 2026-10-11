"""Shared Telegram/VECTO account-session resolution.

The Tweet and Video bots keep separate ticket and feature records, but they
must resolve the same Telegram chat to the same VECTO account and active web
session.  This module contains only read/synchronization primitives so the two
workbench bridges do not drift in their session checks.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any


_BINDING_TABLES = {
    "tweet": "telegram_tweet_members",
    "video": "telegram_trusted_users",
}


def active_session_row(
    conn: sqlite3.Connection,
    user_id: int,
    linked_hash: str = "",
    *,
    now: int | None = None,
) -> Any | None:
    """Return a live session, preferring the stored binding then rotation.

    A web login legitimately rotates the session token (password login, Google
    login, or a new browser device).  The Telegram binding therefore cannot
    require the old hash forever; it falls back to another live session owned
    by the same VECTO user.  The caller still enforces the admin/customer
    session boundary when issuing a new browser cookie.
    """
    clean_user_id = int(user_id or 0)
    if clean_user_id <= 0:
        return None
    current = int(time.time()) if now is None else int(now)
    clean_hash = str(linked_hash or "").strip()
    if clean_hash:
        row = conn.execute(
            """
            SELECT token, is_admin_session
            FROM sessions
            WHERE token = ? AND user_id = ? AND revoked_at = 0 AND expires_at > ?
            LIMIT 1
            """,
            (clean_hash, clean_user_id, current),
        ).fetchone()
        if row is not None:
            return row
    return conn.execute(
        """
        SELECT token, is_admin_session
        FROM sessions
        WHERE user_id = ? AND revoked_at = 0 AND expires_at > ?
        ORDER BY last_seen_at DESC, created_at DESC
        LIMIT 1
        """,
        (clean_user_id, current),
    ).fetchone()


def user_is_available(user: Any) -> bool:
    """Return whether a VECTO user may be used by a Telegram workbench."""
    if user is None:
        return False
    try:
        return not (
            int(user.get("is_disabled") or 0) == 1
            or int(user.get("deleted_at") or 0) > 0
            or str(user.get("lifecycle_status") or "active") != "active"
            or (
                int(user.get("is_admin") or 0) != 1
                and str(user.get("approval_status") or "") != "approved"
            )
        )
    except (AttributeError, TypeError, ValueError):
        return False


def _binding_row(conn: sqlite3.Connection, table: str, chat_id: int) -> dict[str, Any] | None:
    try:
        row = conn.execute(
            f"""
            SELECT m.*, u.username AS web_username, u.is_admin, u.is_disabled,
                   u.approval_status, u.lifecycle_status, u.deleted_at
            FROM {table} AS m
            LEFT JOIN users AS u ON u.id = m.web_user_id
            WHERE m.chat_id = ?
            """,
            (int(chat_id),),
        ).fetchone()
    except sqlite3.OperationalError:
        # The first startup of one Bot can precede the other Bot's schema
        # migration.  The caller can still use the table that exists.
        return None
    return dict(row) if row is not None else None


def binding_rows(conn: sqlite3.Connection, chat_id: int) -> dict[str, dict[str, Any] | None]:
    """Load both workbench bindings for one Telegram chat."""
    return {
        source: _binding_row(conn, table, int(chat_id))
        for source, table in _BINDING_TABLES.items()
    }


def resolve_binding(
    conn: sqlite3.Connection,
    chat_id: int,
    *,
    preferred_source: str,
    now: int | None = None,
) -> dict[str, Any] | None:
    """Choose one safe, shared account binding for a workbench.

    An explicitly disabled binding in the preferred workbench is a hard stop;
    it must not be bypassed by the other Bot's row.  Otherwise an active
    binding wins over a stale one.  If both workbenches have different live
    accounts, the preferred workbench wins and no silent account takeover is
    performed.
    """
    source = str(preferred_source or "").strip().lower()
    if source not in _BINDING_TABLES:
        raise ValueError("unknown Telegram binding source")
    rows = binding_rows(conn, int(chat_id))
    preferred = rows.get(source)
    if preferred is not None and not int(preferred.get("enabled") or 0):
        return None
    candidates: list[dict[str, Any]] = []
    for candidate_source in (source, "video" if source == "tweet" else "tweet"):
        row = rows.get(candidate_source)
        if row is None or not int(row.get("enabled") or 0):
            continue
        user_id = int(row.get("web_user_id") or 0)
        # A legacy allowlist row may still point at a user that was removed
        # from the local users table.  Keep that row visible to the caller so
        # its existing migration/disabled semantics remain intact; browser
        # SSO itself still requires a real available user row below.
        if user_id <= 0:
            continue
        candidate = dict(row)
        candidate["binding_source"] = candidate_source
        candidate["active_session"] = active_session_row(
            conn,
            user_id,
            str(row.get("linked_session_token_hash") or ""),
            now=now,
        )
        candidates.append(candidate)
    if not candidates:
        return None
    preferred_candidate = next(
        (item for item in candidates if item.get("binding_source") == source),
        None,
    )
    if preferred_candidate is not None and preferred_candidate.get("active_session") is not None:
        return preferred_candidate
    active_other = next(
        (item for item in candidates if item.get("active_session") is not None),
        None,
    )
    if active_other is not None:
        return active_other
    return preferred_candidate or candidates[0]


def sync_binding_session(
    conn: sqlite3.Connection,
    chat_id: int,
    user_id: int,
    session_hash: str,
    *,
    now: float | None = None,
) -> None:
    """Keep both existing workbench rows on the same rotated session hash."""
    clean_hash = str(session_hash or "").strip()
    if not clean_hash:
        return
    timestamp = time.time() if now is None else float(now)
    for table in _BINDING_TABLES.values():
        try:
            conn.execute(
                f"""
                UPDATE {table}
                SET linked_session_token_hash = ?, linked_at = ?, updated_at = ?
                WHERE chat_id = ? AND enabled = 1 AND web_user_id = ?
                """,
                (clean_hash, timestamp, timestamp, int(chat_id), int(user_id)),
            )
        except sqlite3.OperationalError:
            continue


def sync_binding_identity(
    conn: sqlite3.Connection,
    chat_id: int,
    user_id: int,
    session_hash: str,
    *,
    now: float | None = None,
) -> None:
    """Move stale enabled rows to a newly authorized shared VECTO account.

    Callers must check for a live session belonging to a different account
    before invoking this function.  Disabled rows are intentionally left
    untouched so an administrator's per-Bot disable cannot be bypassed.
    """
    clean_hash = str(session_hash or "").strip()
    clean_user_id = int(user_id or 0)
    if not clean_hash or clean_user_id <= 0:
        return
    timestamp = time.time() if now is None else float(now)
    for table in _BINDING_TABLES.values():
        try:
            row = conn.execute(
                f"SELECT web_user_id, linked_session_token_hash, enabled FROM {table} WHERE chat_id = ?",
                (int(chat_id),),
            ).fetchone()
            if row is None or not int(row["enabled"] or 0):
                continue
            old_user_id = int(row["web_user_id"] or 0)
            if old_user_id != clean_user_id:
                old_session = active_session_row(
                    conn,
                    old_user_id,
                    str(row["linked_session_token_hash"] or ""),
                    now=int(timestamp),
                )
                if old_session is not None:
                    continue
            conn.execute(
                f"""
                UPDATE {table}
                SET web_user_id = ?, linked_session_token_hash = ?, linked_at = ?, updated_at = ?
                WHERE chat_id = ? AND enabled = 1
                """,
                (clean_user_id, clean_hash, timestamp, timestamp, int(chat_id)),
            )
        except sqlite3.OperationalError:
            continue


__all__ = [
    "active_session_row",
    "binding_rows",
    "resolve_binding",
    "sync_binding_identity",
    "sync_binding_session",
    "user_is_available",
]
