from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any

from fastapi import HTTPException

from .db import get_admin_config


SYSTEM_PROXY_OPTION_PREFIX = "system_proxy_item:"
SYSTEM_PROXY_SETTINGS_KEY = "proxy_market_settings"
DEFAULT_SYSTEM_PROXY_LIMIT = 1
DEFAULT_HEALTH_MAX_AGE_SECONDS = 24 * 60 * 60


def system_proxy_item_id(value: Any) -> str:
    clean = str(value or "").strip()
    if not clean.startswith(SYSTEM_PROXY_OPTION_PREFIX):
        return ""
    return clean[len(SYSTEM_PROXY_OPTION_PREFIX):].strip()


def is_system_proxy_option_id(value: Any) -> bool:
    return bool(system_proxy_item_id(value))


def _settings(conn: sqlite3.Connection) -> dict[str, int]:
    raw = get_admin_config(conn, SYSTEM_PROXY_SETTINGS_KEY, {})
    source = raw if isinstance(raw, dict) else {}
    limit_value = source.get("default_claim_limit")
    return {
        "default_claim_limit": max(
            0,
            min(100, int(DEFAULT_SYSTEM_PROXY_LIMIT if limit_value is None else limit_value)),
        ),
        "health_max_age_seconds": max(
            300,
            min(
                7 * 24 * 60 * 60,
                int(source.get("health_max_age_seconds") or DEFAULT_HEALTH_MAX_AGE_SECONDS),
            ),
        ),
    }


def _claim_limit(conn: sqlite3.Connection, owner_user_id: int) -> int:
    del conn, owner_user_id
    return DEFAULT_SYSTEM_PROXY_LIMIT


def _fresh_and_healthy(item: dict[str, Any], *, now: int, max_age_seconds: int) -> bool:
    return bool(
        str(item.get("health_status") or "") == "healthy"
        and int(item.get("last_check_at") or 0) >= now - max_age_seconds
        and (int(item.get("expires_at") or 0) <= 0 or int(item.get("expires_at") or 0) > now)
    )


def list_available_system_proxy_options(
    conn: sqlite3.Connection,
    *,
    owner_user_id: int,
) -> list[dict[str, Any]]:
    owner_id = int(owner_user_id or 0)
    if owner_id <= 0:
        return []
    active_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM proxy_market_allocations WHERE user_id = ? AND status = 'active'",
            (owner_id,),
        ).fetchone()[0]
    )
    if active_count >= _claim_limit(conn, owner_id):
        return []
    now = int(time.time())
    max_age = int(_settings(conn)["health_max_age_seconds"])
    rows = conn.execute(
        """
        SELECT *
        FROM proxy_market_items item
        WHERE item.status = 'active'
          AND item.health_status = 'healthy'
          AND NOT EXISTS (
            SELECT 1
            FROM proxy_market_allocations allocation
            WHERE allocation.item_id = item.id AND allocation.status = 'active'
          )
        ORDER BY item.published_at DESC, item.updated_at DESC, item.id ASC
        """
    ).fetchall()
    options: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        if not _fresh_and_healthy(item, now=now, max_age_seconds=max_age):
            continue
        check_result = str(item.get("last_check_result_json") or "{}")
        try:
            parsed_check = json.loads(check_result)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed_check = {}
        if not isinstance(parsed_check, dict):
            parsed_check = {}
        options.append(
            {
                "id": f"{SYSTEM_PROXY_OPTION_PREFIX}{str(item.get('id') or '')}",
                "name": str(item.get("display_name") or item.get("sku") or "系统代理"),
                "proxy_type": str(item.get("proxy_type") or "socks5"),
                "connection_mode": "proxy",
                "host": str(item.get("host") or ""),
                "port": int(item.get("port") or 0),
                "username_configured": bool(str(item.get("username_ciphertext") or "")),
                "password_configured": bool(str(item.get("password_ciphertext") or "")),
                "country": str(item.get("country") or ""),
                "region": str(item.get("region") or ""),
                "city": str(item.get("city") or ""),
                "isp": str(item.get("isp") or ""),
                "source": "system",
                "ip_type": str(item.get("ip_type") or "static_residential"),
                "purchase_status": "leased",
                "note": str(item.get("description") or ""),
                "expires_at": int(item.get("expires_at") or 0),
                "status": "active",
                "last_check_at": int(item.get("last_check_at") or 0),
                "last_check_result": parsed_check,
                "exit_ip": str(parsed_check.get("exit_ip") or parsed_check.get("ip") or ""),
                "created_at": int(item.get("created_at") or 0),
                "updated_at": int(item.get("updated_at") or 0),
                "market_item_id": str(item.get("id") or ""),
                "market_allocation_id": "",
                "system_available": True,
                "bound_account_count": 0,
                "bound_account_ids": [],
            }
        )
    return options


def list_system_proxy_pool_options(
    conn: sqlite3.Connection,
    *,
    owner_user_id: int,
) -> list[dict[str, Any]]:
    """Return the user's current system proxy and currently unclaimed choices.

    Occupied proxies belonging to other users are intentionally omitted. This
    keeps the shared pool useful for selection without exposing other users'
    allocations in the normal proxy list or in the selector.
    """

    owner_id = int(owner_user_id or 0)
    if owner_id <= 0:
        return []
    now = int(time.time())
    max_age = int(_settings(conn)["health_max_age_seconds"])
    rows = conn.execute(
        """
        SELECT item.*, allocation.user_id AS allocation_user_id,
               allocation.social_proxy_id, allocation.claimed_at,
               (
                 SELECT COUNT(*)
                 FROM social_accounts account
                 WHERE account.proxy_id = allocation.social_proxy_id
               ) AS bound_account_count
        FROM proxy_market_items item
        LEFT JOIN proxy_market_allocations allocation
          ON allocation.item_id = item.id AND allocation.status = 'active'
        WHERE allocation.id IS NULL OR allocation.user_id = ?
        ORDER BY CASE WHEN allocation.user_id = ? THEN 0 ELSE 1 END,
                 item.published_at DESC, item.updated_at DESC, item.id ASC
        """,
        (owner_id, owner_id),
    ).fetchall()
    options: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        selected = int(item.get("allocation_user_id") or 0) == owner_id
        if not selected:
            if str(item.get("status") or "") != "active":
                continue
            if not _fresh_and_healthy(item, now=now, max_age_seconds=max_age):
                continue
        check_result = str(item.get("last_check_result_json") or "{}")
        try:
            parsed_check = json.loads(check_result)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed_check = {}
        if not isinstance(parsed_check, dict):
            parsed_check = {}
        options.append(
            {
                "id": f"{SYSTEM_PROXY_OPTION_PREFIX}{str(item.get('id') or '')}",
                "market_item_id": str(item.get("id") or ""),
                "social_proxy_id": str(item.get("social_proxy_id") or ""),
                "name": str(item.get("display_name") or item.get("sku") or "系统代理"),
                "proxy_type": str(item.get("proxy_type") or "socks5"),
                "host": str(item.get("host") or ""),
                "port": int(item.get("port") or 0),
                "country": str(item.get("country") or ""),
                "region": str(item.get("region") or ""),
                "city": str(item.get("city") or ""),
                "isp": str(item.get("isp") or ""),
                "ip_type": str(item.get("ip_type") or "static_residential"),
                "description": str(item.get("description") or ""),
                "expires_at": int(item.get("expires_at") or 0),
                "health_status": str(item.get("health_status") or "pending"),
                "last_check_at": int(item.get("last_check_at") or 0),
                "exit_ip": str(parsed_check.get("exit_ip") or parsed_check.get("ip") or ""),
                "selected": selected,
                "available": not selected,
                "bound_account_count": int(item.get("bound_account_count") or 0),
                "claimed_at": int(item.get("claimed_at") or 0),
                "published_at": int(item.get("published_at") or 0),
                "updated_at": int(item.get("updated_at") or 0),
            }
        )
    return options


def claim_system_proxy_in_transaction(
    conn: sqlite3.Connection,
    *,
    item_id: str,
    owner_user_id: int,
    client_request_id: str = "",
    allow_replacement: bool = False,
) -> Any:
    owner_id = int(owner_user_id or 0)
    clean_item_id = str(item_id or "").strip()
    if owner_id <= 0 or not clean_item_id:
        raise HTTPException(status_code=404, detail="系统代理不存在")
    existing = conn.execute(
        """
        SELECT proxy.*
        FROM proxy_market_allocations allocation
        JOIN social_proxies proxy ON proxy.id = allocation.social_proxy_id
        WHERE allocation.item_id = ? AND allocation.user_id = ?
          AND allocation.status = 'active'
        LIMIT 1
        """,
        (clean_item_id, owner_id),
    ).fetchone()
    if existing is not None:
        return existing
    user = conn.execute("SELECT * FROM users WHERE id = ?", (owner_id,)).fetchone()
    if user is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    user_data = dict(user)
    if int(user_data.get("deleted_at") or 0) > 0 or int(user_data.get("is_disabled") or 0) == 1:
        raise HTTPException(status_code=403, detail="账号当前不可使用系统代理")
    if int(user_data.get("is_admin") or 0) != 1 and str(user_data.get("approval_status") or "") != "approved":
        raise HTTPException(status_code=403, detail="账号审核通过后才能使用系统代理")
    active_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM proxy_market_allocations WHERE user_id = ? AND status = 'active'",
            (owner_id,),
        ).fetchone()[0]
    )
    limit = _claim_limit(conn, owner_id)
    if active_count >= limit and not allow_replacement:
        raise HTTPException(status_code=409, detail=f"系统代理使用数量已达到上限（{limit} 个）")
    row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (clean_item_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="系统代理不存在")
    item = dict(row)
    if str(item.get("status") or "") != "active":
        raise HTTPException(status_code=409, detail="该系统代理已被占用或暂不可用")
    now = int(time.time())
    if not _fresh_and_healthy(
        item,
        now=now,
        max_age_seconds=int(_settings(conn)["health_max_age_seconds"]),
    ):
        raise HTTPException(status_code=409, detail="该系统代理需要管理员重新检测后才能使用")
    proxy_id = f"social_proxy_{uuid.uuid4().hex[:20]}"
    allocation_id = f"proxy_alloc_{uuid.uuid4().hex}"
    clean_request_id = str(client_request_id or "")[:128]
    conn.execute(
        """
        INSERT INTO social_proxies(
          id, user_id, name, proxy_type, host, port, username, password,
          country, region, city, isp, source, ip_type, purchase_status,
          note, expires_at, status, last_check_at, last_check_result,
          client_request_id, market_item_id, market_allocation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, 'marketplace',
                  ?, 'leased', ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            proxy_id,
            owner_id,
            str(item.get("display_name") or item.get("sku") or "系统代理"),
            str(item.get("proxy_type") or "socks5"),
            str(item.get("host") or ""),
            int(item.get("port") or 0),
            str(item.get("country") or ""),
            str(item.get("region") or ""),
            str(item.get("city") or ""),
            str(item.get("isp") or ""),
            str(item.get("ip_type") or "static_residential"),
            str(item.get("description") or "").strip() or f"系统代理 {str(item.get('sku') or '')}",
            int(item.get("expires_at") or 0),
            int(item.get("last_check_at") or 0),
            str(item.get("last_check_result_json") or "{}"),
            clean_request_id,
            clean_item_id,
            allocation_id,
            now,
            now,
        ),
    )
    try:
        conn.execute(
            """
            INSERT INTO proxy_market_allocations(
              id, item_id, user_id, social_proxy_id, status, claim_mode,
              display_price_cents_snapshot, currency, idempotency_key,
              claimed_at, released_at, seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'active', 'console_select', ?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (
                allocation_id,
                clean_item_id,
                owner_id,
                proxy_id,
                int(item.get("display_price_cents") or 0),
                str(item.get("currency") or "TWD"),
                clean_request_id,
                now,
                now,
                now,
                now,
            ),
        )
        updated = conn.execute(
            "UPDATE proxy_market_items SET status = 'allocated', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'active'",
            (now, clean_item_id),
        ).rowcount
        if not updated:
            raise sqlite3.IntegrityError("system proxy already allocated")
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="该系统代理刚刚已被其他用户选择") from exc
    return conn.execute("SELECT * FROM social_proxies WHERE id = ?", (proxy_id,)).fetchone()


def switch_system_proxy_in_transaction(
    conn: sqlite3.Connection,
    *,
    item_id: str,
    owner_user_id: int,
    client_request_id: str = "",
    expected_current_item_id: str | None = None,
) -> tuple[Any, bool]:
    """Select one system proxy per user without changing account bindings."""

    owner_id = int(owner_user_id or 0)
    clean_item_id = str(item_id or "").strip()
    current_rows = conn.execute(
        """
        SELECT proxy.*, allocation.item_id AS allocated_item_id
        FROM proxy_market_allocations allocation
        JOIN social_proxies proxy ON proxy.id = allocation.social_proxy_id
        WHERE allocation.user_id = ? AND allocation.status = 'active'
        ORDER BY allocation.claimed_at DESC, allocation.id DESC
        """,
        (owner_id,),
    ).fetchall()
    current = next(
        (row for row in current_rows if str(row["allocated_item_id"] or "") == clean_item_id),
        None,
    )
    actual_current_item_id = str(current_rows[0]["allocated_item_id"] or "") if current_rows else ""
    if expected_current_item_id is not None:
        expected = str(expected_current_item_id or "").strip()
        if expected != actual_current_item_id:
            raise HTTPException(status_code=409, detail="当前代理已在其他页面变更，请刷新公共代理池后重试")
    if current is not None and len(current_rows) == 1:
        return current, 0

    current_proxy_ids = [str(row["id"] or "") for row in current_rows if str(row["id"] or "")]
    if current_proxy_ids:
        placeholders = ",".join("?" for _ in current_proxy_ids)
        bound_account = conn.execute(
            f"""
            SELECT account.id
            FROM social_accounts account
            WHERE account.user_id = ?
              AND account.proxy_id IN ({placeholders})
            LIMIT 1
            """,
            (owner_id, *current_proxy_ids),
        ).fetchone()
        if bound_account is not None:
            raise HTTPException(status_code=409, detail="当前代理仍有账号绑定，请先解除账号绑定后再切换代理 IP")

    selected = current or claim_system_proxy_in_transaction(
        conn,
        item_id=clean_item_id,
        owner_user_id=owner_id,
        client_request_id=client_request_id,
        allow_replacement=bool(current_rows),
    )
    selected_proxy_id = str(selected["id"] or "")
    replaced_proxy = any(str(row["id"] or "") != selected_proxy_id for row in current_rows)
    for row in current_rows:
        if str(row["id"] or "") == selected_proxy_id:
            continue
        release_system_proxy_in_transaction(conn, proxy=row, owner_user_id=owner_id)
    return conn.execute("SELECT * FROM social_proxies WHERE id = ?", (selected_proxy_id,)).fetchone(), replaced_proxy


def release_system_proxy_in_transaction(
    conn: sqlite3.Connection,
    *,
    proxy: Any,
    owner_user_id: int,
) -> bool:
    item = dict(proxy)
    proxy_id = str(item.get("id") or "").strip()
    allocation_id = str(item.get("market_allocation_id") or "").strip()
    if not proxy_id or not allocation_id or str(item.get("source") or "") != "marketplace":
        return False
    allocation = conn.execute(
        "SELECT * FROM proxy_market_allocations WHERE id = ? AND user_id = ? AND social_proxy_id = ? AND status = 'active'",
        (allocation_id, int(owner_user_id), proxy_id),
    ).fetchone()
    if allocation is None:
        raise HTTPException(status_code=409, detail="系统代理分配记录已失效")
    now = int(time.time())
    item_id = str(allocation["item_id"] or "")
    conn.execute("DELETE FROM social_proxies WHERE id = ?", (proxy_id,))
    conn.execute(
        "UPDATE proxy_market_allocations SET status = 'released', released_at = ?, updated_at = ? WHERE id = ?",
        (now, now, allocation_id),
    )
    source = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (item_id,)).fetchone()
    if source is not None:
        source_item = dict(source)
        next_status = "active" if _fresh_and_healthy(
            source_item,
            now=now,
            max_age_seconds=int(_settings(conn)["health_max_age_seconds"]),
        ) else "maintenance"
        if str(source_item.get("status") or "") == "allocated":
            conn.execute(
                "UPDATE proxy_market_items SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?",
                (next_status, now, item_id),
            )
    return True
