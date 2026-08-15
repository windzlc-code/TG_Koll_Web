from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from .db import get_admin_config


SYSTEM_PROXY_OPTION_PREFIX = "system_proxy_item:"
SYSTEM_PROXY_SETTINGS_KEY = "proxy_market_settings"
DEFAULT_SYSTEM_PROXY_LIMIT = 1
DEFAULT_HEALTH_MAX_AGE_SECONDS = 24 * 60 * 60
SHANGHAI_TIME_ZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


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


def monthly_free_proxy_status(
    conn: sqlite3.Connection,
    *,
    owner_user_id: int,
    now: int | None = None,
) -> dict[str, Any]:
    """Return the one-free-official-proxy allowance for the current Shanghai month."""

    owner_id = int(owner_user_id or 0)
    current = int(now or time.time())
    local_now = datetime.fromtimestamp(current, SHANGHAI_TIME_ZONE)
    month_start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    next_month = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
    start_at = int(month_start.timestamp())
    resets_at = int(next_month.timestamp())
    used = conn.execute(
        """
        SELECT item_id, claimed_at
        FROM proxy_market_allocations
        WHERE user_id = ?
          AND claim_mode IN ('monthly_free', 'console_select')
          AND claimed_at >= ? AND claimed_at < ?
        ORDER BY claimed_at DESC, id DESC
        LIMIT 1
        """,
        (owner_id, start_at, resets_at),
    ).fetchone() if owner_id > 0 else None
    return {
        "available": used is None,
        "period": month_start.strftime("%Y-%m"),
        "resets_at": resets_at,
        "used_at": int(used["claimed_at"] or 0) if used is not None else 0,
        "item_id": str(used["item_id"] or "") if used is not None else "",
    }


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
    include_admin_inventory: bool = False,
) -> list[dict[str, Any]]:
    owner_id = int(owner_user_id or 0)
    if owner_id <= 0:
        return []
    if not include_admin_inventory:
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
    include_admin_inventory: bool = False,
) -> list[dict[str, Any]]:
    """Return the user's owned proxies, current shared proxy, and unclaimed choices.

    Occupied proxies belonging to other users are intentionally omitted. This
    keeps the selector useful without exposing other users' allocations or
    treating a purchased asset as a releasable shared-pool allocation.
    """

    owner_id = int(owner_user_id or 0)
    if owner_id <= 0:
        return []
    now = int(time.time())
    monthly_free = monthly_free_proxy_status(conn, owner_user_id=owner_id, now=now)
    max_age = int(_settings(conn)["health_max_age_seconds"])
    rows = conn.execute(
        """
        SELECT item.*, allocation.user_id AS allocation_user_id,
               COALESCE(allocation.social_proxy_id, owned_proxy.id) AS social_proxy_id,
               allocation.claimed_at,
               owned_proxy.status AS owned_proxy_status,
               owned_proxy.country AS owned_proxy_country,
               owned_proxy.region AS owned_proxy_region,
               owned_proxy.city AS owned_proxy_city,
               owned_proxy.isp AS owned_proxy_isp,
               owned_proxy.last_check_at AS owned_proxy_last_check_at,
               owned_proxy.last_check_result AS owned_proxy_last_check_result,
               owned_order.id AS purchase_order_id,
               owned_order.renewal_enabled AS renewal_enabled,
               renewal.status AS renewal_status,
               (
                 SELECT COUNT(*)
                 FROM social_accounts account
                 WHERE account.user_id = ?
                   AND account.proxy_id = COALESCE(allocation.social_proxy_id, owned_proxy.id)
               ) AS bound_account_count
        FROM proxy_market_items item
        LEFT JOIN proxy_market_allocations allocation
          ON allocation.item_id = item.id AND allocation.status = 'active'
        LEFT JOIN social_proxies owned_proxy
         ON item.ownership_type = 'owned'
         AND owned_proxy.market_item_id = item.id
         AND owned_proxy.user_id = ?
         AND owned_proxy.status IN ('active', 'failed', 'pending')
        LEFT JOIN proxy_purchase_orders owned_order
          ON owned_order.id = item.provider_purchase_order_id
         AND owned_order.user_id = ?
        LEFT JOIN proxy_renewal_schedules renewal
          ON renewal.order_id = owned_order.id
        WHERE (
          item.ownership_type = 'owned'
          AND item.owner_user_id = ?
          AND owned_proxy.id IS NOT NULL
          AND item.status NOT IN ('retired', 'expired')
        ) OR (
          COALESCE(item.ownership_type, 'shared') <> 'owned'
          AND (allocation.id IS NULL OR allocation.user_id = ?)
        )
        ORDER BY CASE
                   WHEN item.ownership_type = 'owned' THEN 0
                   WHEN allocation.user_id = ? THEN 1
                   ELSE 2
                 END,
                 item.published_at DESC, item.updated_at DESC, item.id ASC
        """,
        (owner_id, owner_id, owner_id, owner_id, owner_id, owner_id),
    ).fetchall()
    options: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        ownership_type = str(item.get("ownership_type") or "shared").strip().lower()
        owned = ownership_type == "owned" and int(item.get("owner_user_id") or 0) == owner_id
        selected = int(item.get("allocation_user_id") or 0) == owner_id
        if not selected and not owned:
            if str(item.get("status") or "") != "active":
                continue
            if not _fresh_and_healthy(item, now=now, max_age_seconds=max_age):
                continue
        check_result = str((item.get("owned_proxy_last_check_result") if owned else item.get("last_check_result_json")) or "{}")
        try:
            parsed_check = json.loads(check_result)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed_check = {}
        if not isinstance(parsed_check, dict):
            parsed_check = {}
        response = parsed_check.get("response") if isinstance(parsed_check.get("response"), dict) else {}
        country = str((item.get("owned_proxy_country") if owned else item.get("country")) or "")
        region = str((item.get("owned_proxy_region") if owned else item.get("region")) or "")
        city = str((item.get("owned_proxy_city") if owned else item.get("city")) or "")
        isp = str((item.get("owned_proxy_isp") if owned else item.get("isp")) or "")
        details_revealed = bool(owned or selected or include_admin_inventory)
        options.append(
            {
                "id": f"{SYSTEM_PROXY_OPTION_PREFIX}{str(item.get('id') or '')}",
                "market_item_id": str(item.get("id") or ""),
                "social_proxy_id": str(item.get("social_proxy_id") or ""),
                "name": str(item.get("display_name") or item.get("sku") or "系统代理"),
                "proxy_type": str(item.get("proxy_type") or "socks5"),
                "host": str(item.get("host") or "") if details_revealed else "",
                "port": int(item.get("port") or 0) if details_revealed else 0,
                "country": country,
                "country_code": str(response.get("country_code") or (country if len(country) == 2 else "")).upper(),
                "region": region,
                "city": city,
                "isp": isp,
                "ip_type": str(item.get("ip_type") or "static_residential"),
                "description": str(item.get("description") or ""),
                "expires_at": int(item.get("expires_at") or 0),
                "health_status": (
                    "healthy"
                    if str(item.get("owned_proxy_status") or "") == "active" and bool(parsed_check.get("ok"))
                    else "pending"
                ) if owned else str(item.get("health_status") or "pending"),
                "last_check_at": int((item.get("owned_proxy_last_check_at") if owned else item.get("last_check_at")) or 0),
                "exit_ip": str(parsed_check.get("exit_ip") or parsed_check.get("ip") or "") if details_revealed else "",
                "selected": selected,
                "available": bool(owned or selected or monthly_free["available"]),
                "ownership_type": "owned" if owned else "shared",
                "details_revealed": details_revealed,
                "monthly_free": not owned,
                "monthly_free_available": bool(monthly_free["available"]),
                "purchase_order_id": str(item.get("purchase_order_id") or ""),
                "renewal_enabled": bool(int(item.get("renewal_enabled") or 0)),
                "renewal_status": str(item.get("renewal_status") or ""),
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
    allow_admin_inventory: bool = False,
    claim_mode: str = "monthly_free",
    now: int | None = None,
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
    row = conn.execute("SELECT * FROM proxy_market_items WHERE id = ?", (clean_item_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="系统代理不存在")
    item = dict(row)
    ownership_type = str(item.get("ownership_type") or "shared").strip().lower()
    if ownership_type == "owned":
        if int(item.get("owner_user_id") or 0) != owner_id:
            raise HTTPException(status_code=404, detail="系统代理不存在")
        owned_proxy = conn.execute(
            "SELECT * FROM social_proxies WHERE market_item_id = ? AND user_id = ? LIMIT 1",
            (clean_item_id, owner_id),
        ).fetchone()
        if owned_proxy is None:
            raise HTTPException(status_code=409, detail="已购代理正在同步，请稍后重试")
        return owned_proxy
    if not allow_admin_inventory:
        raise HTTPException(status_code=404, detail="系统代理不存在")
    active_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM proxy_market_allocations WHERE user_id = ? AND status = 'active'",
            (owner_id,),
        ).fetchone()[0]
    )
    limit = _claim_limit(conn, owner_id)
    if active_count >= limit and not allow_replacement:
        raise HTTPException(status_code=409, detail=f"系统代理使用数量已达到上限（{limit} 个）")
    if str(item.get("status") or "") != "active":
        raise HTTPException(status_code=409, detail="该系统代理已被占用或暂不可用")
    now = int(now or time.time())
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
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (
                allocation_id,
                clean_item_id,
                owner_id,
                proxy_id,
                str(claim_mode or "monthly_free"),
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
    allow_admin_inventory: bool = False,
    now: int | None = None,
) -> tuple[Any, bool]:
    """Select one system proxy per user without changing account bindings."""

    owner_id = int(owner_user_id or 0)
    current_time = int(now or time.time())
    clean_item_id = str(item_id or "").strip()
    target = conn.execute(
        "SELECT ownership_type, owner_user_id FROM proxy_market_items WHERE id = ?",
        (clean_item_id,),
    ).fetchone()
    if target is None:
        raise HTTPException(status_code=404, detail="系统代理不存在")
    if str(target["ownership_type"] or "shared").strip().lower() == "owned":
        selected = claim_system_proxy_in_transaction(
            conn,
            item_id=clean_item_id,
            owner_user_id=owner_id,
            client_request_id=client_request_id,
        )
        return selected, False
    if not allow_admin_inventory:
        raise HTTPException(status_code=404, detail="系统代理不存在")
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

    benefit = monthly_free_proxy_status(conn, owner_user_id=owner_id, now=current_time)
    if not benefit["available"]:
        raise HTTPException(
            status_code=409,
            detail="本月免费代理机会已使用，下月可重新选择",
        )

    selected = current or claim_system_proxy_in_transaction(
        conn,
        item_id=clean_item_id,
        owner_user_id=owner_id,
        client_request_id=client_request_id,
        allow_replacement=bool(current_rows),
        allow_admin_inventory=allow_admin_inventory,
        claim_mode="monthly_free",
        now=current_time,
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
