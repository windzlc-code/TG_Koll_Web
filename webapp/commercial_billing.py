from __future__ import annotations

import calendar
import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


POINT_SCALE = 100
try:
    TAIPEI = ZoneInfo("Asia/Taipei")
except ZoneInfoNotFoundError:
    TAIPEI = timezone(timedelta(hours=8), name="Asia/Taipei")


DEFAULT_CATALOG: dict[str, Any] = {
    "currency": "TWD",
    "timezone": "Asia/Taipei",
    "point_unit_ntd": 10,
    "subscription": {
        "sku": "vanguard_monthly",
        "name": "Vecto Vanguard OPC",
        "price_ntd": 6000,
        "period_months": 1,
        "threads_accounts": 3,
        "monthly_free_images": 10,
        "features": [
            "一组 OPC 超级个体与三组 Threads 账号",
            "Vecto OS 排程、数据看板与算力明细",
            "热点抓取、内容风控与多账号分流",
        ],
    },
    "actions": [
        {"sku": "threads_text_publish", "name": "Threads 文字推文发布", "points": 0.1, "unit": "次", "implemented": True},
        {"sku": "basic_text_post", "name": "基础文字贴文", "points": 0.3, "unit": "篇", "implemented": True},
        {"sku": "ai_image", "name": "AI 图片素材", "points": 0.6, "unit": "张", "implemented": True},
        {"sku": "oral_video_second", "name": "口播类短片", "points": 0.15, "unit": "秒", "implemented": False},
        {"sku": "ad_video_480p_second", "name": "广告短片 480p", "points": 1.2, "unit": "秒", "implemented": False},
        {"sku": "ad_video_720p_second", "name": "广告短片 720p", "points": 1.4, "unit": "秒", "implemented": False},
        {"sku": "ad_video_1080p_second", "name": "广告短片 1080p", "points": 1.6, "unit": "秒", "implemented": False},
        {"sku": "ad_video_2k_second", "name": "广告短片 2K", "points": 2.0, "unit": "秒", "implemented": False},
        {"sku": "ad_video_4k_second", "name": "广告短片 4K", "points": 2.4, "unit": "秒", "implemented": False},
        {"sku": "threads_auto_reply_batch", "name": "批量评论互动任务", "points": 2.0, "unit": "批", "implemented": True},
    ],
    "packages": [
        {"sku": "credits_100", "name": "轻量储值包", "price_ntd": 1000, "paid_points": 100, "bonus_points": 0, "total_points": 100, "bonus_images": 0},
        {"sku": "credits_530", "name": "畅销储值包", "price_ntd": 5000, "paid_points": 500, "bonus_points": 30, "total_points": 530, "bonus_images": 0},
        {"sku": "credits_1620", "name": "企业长期储值包", "price_ntd": 15000, "paid_points": 1500, "bonus_points": 120, "total_points": 1620, "bonus_images": 20},
    ],
}


class BillingError(RuntimeError):
    def __init__(self, code: str, detail: str, status_code: int = 409):
        super().__init__(detail)
        self.code = str(code)
        self.detail = str(detail)
        self.status_code = int(status_code)


def _now() -> int:
    return int(time.time())


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads(value: Any, default: Any) -> Any:
    try:
        return json.loads(str(value)) if value not in (None, "") else default
    except Exception:
        return default


def _ensure_immediate_transaction(conn: sqlite3.Connection) -> None:
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def points_from_units(units: int) -> float:
    return round(max(int(units or 0), 0) / POINT_SCALE, 2)


def units_from_points(points: Any) -> int:
    try:
        return max(int(round(float(points) * POINT_SCALE)), 0)
    except (TypeError, ValueError):
        return 0


def enforcement_enabled() -> bool:
    return str(os.getenv("COMMERCIAL_BILLING_ENABLED", "0") or "0").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def add_calendar_month(start_ts: int) -> int:
    start = datetime.fromtimestamp(int(start_ts), TAIPEI)
    year = start.year + (1 if start.month == 12 else 0)
    month = 1 if start.month == 12 else start.month + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return int(start.replace(year=year, month=month, day=day).timestamp())


def bootstrap_billing(conn: sqlite3.Connection, *, now: int | None = None) -> None:
    current = int(now or _now())
    migration = conn.execute("SELECT value_json FROM admin_config WHERE key = 'commercial_billing_migration_v1'").fetchone()
    if migration is None:
        skipped_negative_user_ids: list[int] = []
        rows = conn.execute("SELECT id, balance_cents FROM users").fetchall()
        for row in rows:
            user_id = int(row["id"])
            legacy = int(row["balance_cents"] or 0)
            if legacy < 0:
                skipped_negative_user_ids.append(user_id)
                continue
            units = legacy * POINT_SCALE
            conn.execute(
                "INSERT OR IGNORE INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, ?, 'legacy', ?, ?, ?)",
                (user_id, units, legacy, current, current),
            )
            conn.execute(
                "INSERT OR IGNORE INTO billing_ledger(id, user_id, asset_type, event_type, amount_units, balance_after_units, ref_type, ref_id, meta_json, idempotency_key, created_at) VALUES (?, ?, 'credit', 'opening_balance', ?, ?, 'migration', 'v1', ?, ?, ?)",
                (_id("bill_entry"), user_id, units, units, _dumps({"legacy_balance": legacy}), f"migration:v1:{user_id}", current),
            )
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_migration_v1', ?, ?)",
            (_dumps({"completed_at": current, "skipped_negative_user_ids": skipped_negative_user_ids}), current),
        )
    if conn.execute("SELECT 1 FROM billing_catalog_versions WHERE status = 'active'").fetchone() is None:
        conn.execute(
            "INSERT INTO billing_catalog_versions(id, version_number, status, catalog_json, effective_at, created_by, created_at, published_at) VALUES (?, 1, 'active', ?, ?, 0, ?, ?)",
            (_id("catalog"), _dumps(DEFAULT_CATALOG), current, current, current),
        )


def ensure_wallet(conn: sqlite3.Connection, user_id: int, *, now: int | None = None) -> dict[str, Any]:
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_wallets WHERE user_id = ?", (int(user_id),)).fetchone()
    if row is None:
        user = conn.execute("SELECT is_admin, balance_cents FROM users WHERE id = ?", (int(user_id),)).fetchone()
        if user is None:
            raise BillingError("USER_NOT_FOUND", "账号不存在", 404)
        legacy_balance = int(user["balance_cents"] or 0)
        if legacy_balance < 0:
            raise BillingError(
                "MIGRATION_REVIEW_REQUIRED",
                "旧余额为负数，必须由管理员核对后才能启用商业计费",
                409,
            )
        # Users created outside the application (tests/imports) remain legacy until
        # the account creation flow explicitly opts them into enforcement.
        mode = "legacy"
        conn.execute(
            "INSERT INTO billing_wallets(user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (int(user_id), legacy_balance * POINT_SCALE, mode, legacy_balance, current, current),
        )
        _insert_ledger(
            conn,
            user_id=int(user_id),
            asset_type="credit",
            event_type="opening_balance",
            amount_units=legacy_balance * POINT_SCALE,
            balance_after_units=legacy_balance * POINT_SCALE,
            ref_type="migration",
            ref_id="lazy_v1",
            idempotency_key=f"migration:lazy_v1:{int(user_id)}",
            meta={"legacy_balance": legacy_balance},
            now=current,
        )
        row = conn.execute("SELECT * FROM billing_wallets WHERE user_id = ?", (int(user_id),)).fetchone()
    return dict(row)


def migration_report(conn: sqlite3.Connection) -> dict[str, Any]:
    marker = conn.execute(
        "SELECT value_json, updated_at FROM admin_config WHERE key = 'commercial_billing_migration_v1'"
    ).fetchone()
    rows = conn.execute(
        """
        SELECT user.id, user.username, user.balance_cents,
               wallet.user_id AS wallet_user_id, wallet.billing_mode,
               wallet.migrated_legacy_balance
        FROM users AS user
        LEFT JOIN billing_wallets AS wallet ON wallet.user_id = user.id
        ORDER BY user.id
        """
    ).fetchall()
    items: list[dict[str, Any]] = []
    counts = {"ok": 0, "missing": 0, "review_required": 0, "mismatch": 0}
    for row in rows:
        legacy = int(row["balance_cents"] or 0)
        if legacy < 0:
            status = "review_required"
        elif row["wallet_user_id"] is None:
            status = "missing"
        elif int(row["migrated_legacy_balance"] or 0) != legacy:
            status = "mismatch"
        else:
            status = "ok"
        counts[status] += 1
        items.append(
            {
                "user_id": int(row["id"]),
                "username": str(row["username"] or ""),
                "legacy_balance": legacy,
                "expected_credit_units": legacy * POINT_SCALE if legacy >= 0 else None,
                "wallet_exists": row["wallet_user_id"] is not None,
                "billing_mode": str(row["billing_mode"] or ""),
                "migrated_legacy_balance": int(row["migrated_legacy_balance"] or 0),
                "status": status,
            }
        )
    return {
        "migration": _loads(marker["value_json"], {}) if marker else {},
        "migration_updated_at": int(marker["updated_at"] or 0) if marker else 0,
        "counts": counts,
        "items": items,
    }


def get_active_catalog(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1").fetchone()
    if row is None:
        raise BillingError("CATALOG_UNAVAILABLE", "当前没有已发布的计费目录", 503)
    catalog = _loads(row["catalog_json"], {})
    return {
        "id": str(row["id"]),
        "version": int(row["version_number"]),
        "effective_at": int(row["effective_at"]),
        "published_at": int(row["published_at"]),
        **(catalog if isinstance(catalog, dict) else {}),
    }


def list_catalog_versions(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM billing_catalog_versions ORDER BY version_number DESC").fetchall()
    return [
        {
            "id": str(row["id"]),
            "version": int(row["version_number"]),
            "status": str(row["status"]),
            "catalog": _loads(row["catalog_json"], {}),
            "effective_at": int(row["effective_at"]),
            "created_by": int(row["created_by"]),
            "created_at": int(row["created_at"]),
            "published_at": int(row["published_at"]),
        }
        for row in rows
    ]


def create_catalog_draft(conn: sqlite3.Connection, *, actor_user_id: int, source_id: str = "", now: int | None = None) -> dict[str, Any]:
    current = int(now or _now())
    source = conn.execute("SELECT catalog_json FROM billing_catalog_versions WHERE id = ?", (str(source_id),)).fetchone() if source_id else None
    catalog_json = str(source["catalog_json"]) if source else _dumps(get_active_catalog(conn) | {})
    if not source:
        active = get_active_catalog(conn)
        catalog_json = _dumps({key: value for key, value in active.items() if key not in {"id", "version", "effective_at", "published_at"}})
    version = int(conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"])
    row_id = _id("catalog")
    conn.execute(
        "INSERT INTO billing_catalog_versions(id, version_number, status, catalog_json, created_by, created_at) VALUES (?, ?, 'draft', ?, ?, ?)",
        (row_id, version, catalog_json, int(actor_user_id), current),
    )
    return next(item for item in list_catalog_versions(conn) if item["id"] == row_id)


def update_catalog_draft(conn: sqlite3.Connection, catalog_id: str, catalog: dict[str, Any], *, actor_user_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT status FROM billing_catalog_versions WHERE id = ?", (str(catalog_id),)).fetchone()
    if row is None:
        raise BillingError("CATALOG_NOT_FOUND", "计费目录不存在", 404)
    if str(row["status"]) != "draft":
        raise BillingError("CATALOG_IMMUTABLE", "已发布目录不能修改，请复制为新草稿", 409)
    validate_catalog(catalog)
    conn.execute("UPDATE billing_catalog_versions SET catalog_json = ?, created_by = ? WHERE id = ?", (_dumps(catalog), int(actor_user_id), str(catalog_id)))
    return next(item for item in list_catalog_versions(conn) if item["id"] == str(catalog_id))


def publish_catalog(conn: sqlite3.Connection, catalog_id: str, *, actor_user_id: int, now: int | None = None) -> dict[str, Any]:
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_catalog_versions WHERE id = ?", (str(catalog_id),)).fetchone()
    if row is None:
        raise BillingError("CATALOG_NOT_FOUND", "计费目录不存在", 404)
    if str(row["status"]) == "active":
        return get_active_catalog(conn)
    if str(row["status"]) != "draft":
        raise BillingError("CATALOG_IMMUTABLE", "只有草稿可以发布", 409)
    validate_catalog(_loads(row["catalog_json"], {}))
    conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
    conn.execute(
        "UPDATE billing_catalog_versions SET status = 'active', effective_at = ?, published_at = ?, created_by = ? WHERE id = ?",
        (current, current, int(actor_user_id), str(catalog_id)),
    )
    return get_active_catalog(conn)


def validate_catalog(catalog: dict[str, Any]) -> None:
    if not isinstance(catalog, dict):
        raise BillingError("INVALID_CATALOG", "计费目录格式错误", 400)
    subscription = catalog.get("subscription") if isinstance(catalog.get("subscription"), dict) else {}
    if str(subscription.get("sku") or "") != "vanguard_monthly" or int(subscription.get("price_ntd") or 0) <= 0:
        raise BillingError("INVALID_CATALOG", "订阅方案配置不完整", 400)
    packages = catalog.get("packages") if isinstance(catalog.get("packages"), list) else []
    if not packages or any(int((item or {}).get("price_ntd") or 0) <= 0 or int((item or {}).get("total_points") or 0) <= 0 for item in packages):
        raise BillingError("INVALID_CATALOG", "算力套餐配置不完整", 400)
    actions = catalog.get("actions") if isinstance(catalog.get("actions"), list) else []
    if any(units_from_points((item or {}).get("points")) <= 0 for item in actions):
        raise BillingError("INVALID_CATALOG", "操作计费点数必须大于0", 400)


def _catalog_item(catalog: dict[str, Any], sku: str) -> tuple[str, dict[str, Any]]:
    subscription = catalog.get("subscription") if isinstance(catalog.get("subscription"), dict) else {}
    if str(subscription.get("sku") or "") == str(sku):
        return "subscription", subscription
    for item in catalog.get("packages") if isinstance(catalog.get("packages"), list) else []:
        if isinstance(item, dict) and str(item.get("sku") or "") == str(sku):
            return "credit_pack", item
    raise BillingError("SKU_NOT_FOUND", "所选方案不存在或已下架", 404)


def action_rate_units(conn: sqlite3.Connection, sku: str) -> tuple[int, str]:
    catalog = get_active_catalog(conn)
    for item in catalog.get("actions") if isinstance(catalog.get("actions"), list) else []:
        if isinstance(item, dict) and str(item.get("sku") or "") == str(sku):
            if not bool(item.get("implemented")):
                raise BillingError("SKU_NOT_IMPLEMENTED", "该计费项目尚未开放", 409)
            return units_from_points(item.get("points")), str(catalog["id"])
    raise BillingError("SKU_NOT_FOUND", "计费项目不存在", 404)


def _active_subscription_count(conn: sqlite3.Connection, user_id: int, now: int) -> int:
    return int(
        conn.execute(
            "SELECT COUNT(DISTINCT subscription_id) AS c FROM billing_subscription_periods WHERE user_id = ? AND status != 'cancelled' AND start_at <= ? AND end_at > ?",
            (int(user_id), int(now), int(now)),
        ).fetchone()["c"]
    )


def require_write_access(conn: sqlite3.Connection, user_id: int, *, admin_waived: bool = False, now: int | None = None) -> dict[str, Any]:
    wallet = ensure_wallet(conn, int(user_id), now=now)
    if not enforcement_enabled() or admin_waived or str(wallet["billing_mode"]) == "legacy":
        return wallet
    current = int(now or _now())
    if _active_subscription_count(conn, int(user_id), current) <= 0:
        raise BillingError("SUBSCRIPTION_REQUIRED", "订阅已到期，请先续费后再执行操作", 402)
    return wallet


def threads_account_limit(conn: sqlite3.Connection, user_id: int, *, now: int | None = None) -> int | None:
    wallet = ensure_wallet(conn, int(user_id), now=now)
    if not enforcement_enabled() or str(wallet["billing_mode"]) == "legacy":
        return None
    catalog = get_active_catalog(conn)
    per_subscription = int((catalog.get("subscription") or {}).get("threads_accounts") or 3)
    return _active_subscription_count(conn, int(user_id), int(now or _now())) * per_subscription


def _insert_ledger(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    asset_type: str,
    event_type: str,
    amount_units: int,
    balance_after_units: int,
    idempotency_key: str,
    ref_type: str = "",
    ref_id: str = "",
    order_id: str = "",
    reservation_id: str = "",
    meta: dict[str, Any] | None = None,
    now: int | None = None,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO billing_ledger(
          id, user_id, asset_type, event_type, amount_units, balance_after_units,
          ref_type, ref_id, order_id, reservation_id, meta_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            _id("bill_entry"), int(user_id), str(asset_type), str(event_type), int(amount_units), int(balance_after_units),
            str(ref_type), str(ref_id), str(order_id), str(reservation_id), _dumps(meta or {}), str(idempotency_key), int(now or _now()),
        ),
    )


def _reservation_public(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": str(item.get("id") or ""),
        "sku": str(item.get("sku") or ""),
        "status": str(item.get("status") or ""),
        "reserved_points": points_from_units(int(item.get("reserved_credit_units") or 0)),
        "charged_points": points_from_units(int(item.get("settled_credit_units") or 0)),
        "reserved_images": int(item.get("reserved_image_count") or 0),
        "free_images_used": int(item.get("settled_image_count") or 0),
    }


def claim_reservation(
    conn: sqlite3.Connection,
    *,
    reservation_id: str,
    user_id: int,
    ref_type: str,
    ref_id: str,
    sku: str,
) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM billing_reservations WHERE id = ?",
        (str(reservation_id),),
    ).fetchone()
    if row is None:
        raise BillingError("RESERVATION_NOT_FOUND", "计费预占不存在", 404)
    if (
        int(row["user_id"]) != int(user_id)
        or str(row["ref_type"]) != str(ref_type)
        or str(row["ref_id"]) != str(ref_id)
        or str(row["sku"]) != str(sku)
        or str(row["status"]) not in {"held", "waived"}
    ):
        raise BillingError("RESERVATION_MISMATCH", "计费预占与当前任务不匹配", 409)
    return _reservation_public(row)


def reserve_charge(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    ref_type: str,
    ref_id: str,
    sku: str,
    quantity: int = 1,
    image: bool = False,
    admin_waived: bool = False,
    idempotency_key: str = "",
    now: int | None = None,
) -> dict[str, Any]:
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    qty = max(int(quantity or 0), 0)
    if qty <= 0:
        raise BillingError("INVALID_QUANTITY", "计费数量必须大于0", 400)
    idem = str(idempotency_key or f"reserve:{ref_type}:{ref_id}:{sku}")
    existing = conn.execute("SELECT * FROM billing_reservations WHERE idempotency_key = ?", (idem,)).fetchone()
    if existing is not None:
        return _reservation_public(existing)
    wallet = require_write_access(conn, int(user_id), admin_waived=admin_waived, now=current)
    rate_units, catalog_version_id = action_rate_units(conn, str(sku))
    waived_reason = (
        "feature_disabled"
        if not enforcement_enabled()
        else ("admin" if admin_waived else ("legacy" if str(wallet["billing_mode"]) == "legacy" else ""))
    )
    reservation_id = _id("bill_hold")
    if waived_reason:
        conn.execute(
            "INSERT INTO billing_reservations(id, user_id, ref_type, ref_id, sku, status, catalog_version_id, meta_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'waived', ?, ?, ?, ?, ?)",
            (reservation_id, int(user_id), str(ref_type), str(ref_id), str(sku), catalog_version_id, _dumps({"quantity": qty, "unit_credit_units": rate_units, "waived_reason": waived_reason}), idem, current, current),
        )
        if admin_waived:
            _insert_ledger(
                conn, user_id=int(user_id), asset_type="audit", event_type="admin_waived", amount_units=0,
                balance_after_units=int(wallet["credit_units"]), ref_type=ref_type, ref_id=ref_id,
                reservation_id=reservation_id, idempotency_key=f"{idem}:waived", meta={"sku": sku, "quantity": qty}, now=current,
            )
        return _reservation_public(conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone())

    grant_holds: list[dict[str, Any]] = []
    free_images = 0
    if image:
        remaining = qty
        grants = conn.execute(
            """
            SELECT * FROM billing_image_grants
            WHERE user_id = ? AND remaining_count > 0 AND available_at <= ? AND (expires_at = 0 OR expires_at > ?)
            ORDER BY CASE WHEN expires_at = 0 THEN 1 ELSE 0 END, expires_at ASC, created_at ASC
            """,
            (int(user_id), current, current),
        ).fetchall()
        for grant in grants:
            if remaining <= 0:
                break
            take = min(remaining, int(grant["remaining_count"] or 0))
            if take <= 0:
                continue
            conn.execute("UPDATE billing_image_grants SET remaining_count = remaining_count - ?, updated_at = ? WHERE id = ?", (take, current, str(grant["id"])))
            grant_holds.append({"grant_id": str(grant["id"]), "count": take})
            free_images += take
            remaining -= take
        credit_units = remaining * rate_units
    else:
        credit_units = qty * rate_units
    balance = int(wallet["credit_units"])
    if balance < credit_units:
        raise BillingError("INSUFFICIENT_POINTS", "算力点不足，请先提交储值申请", 402)
    if credit_units:
        conn.execute("UPDATE billing_wallets SET credit_units = credit_units - ?, updated_at = ? WHERE user_id = ?", (credit_units, current, int(user_id)))
    meta = {"quantity": qty, "unit_credit_units": rate_units, "image": bool(image), "grant_holds": grant_holds}
    conn.execute(
        """
        INSERT INTO billing_reservations(
          id, user_id, ref_type, ref_id, sku, status, reserved_credit_units, reserved_image_count,
          catalog_version_id, meta_json, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?)
        """,
        (reservation_id, int(user_id), str(ref_type), str(ref_id), str(sku), credit_units, free_images, catalog_version_id, _dumps(meta), idem, current, current),
    )
    if credit_units:
        _insert_ledger(
            conn, user_id=int(user_id), asset_type="credit", event_type="reserve", amount_units=-credit_units,
            balance_after_units=balance - credit_units, ref_type=ref_type, ref_id=ref_id, reservation_id=reservation_id,
            idempotency_key=f"{idem}:credit_hold", meta={"sku": sku, "quantity": qty}, now=current,
        )
    if free_images:
        remaining_images = sum(int(row["remaining_count"] or 0) for row in conn.execute("SELECT remaining_count FROM billing_image_grants WHERE user_id = ?", (int(user_id),)).fetchall())
        _insert_ledger(
            conn, user_id=int(user_id), asset_type="image", event_type="reserve", amount_units=-free_images,
            balance_after_units=remaining_images, ref_type=ref_type, ref_id=ref_id, reservation_id=reservation_id,
            idempotency_key=f"{idem}:image_hold", meta={"sku": sku, "grant_holds": grant_holds}, now=current,
        )
    return _reservation_public(conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone())


def _restore_grants(conn: sqlite3.Connection, holds: list[dict[str, Any]], restore_count: int, now: int) -> None:
    remaining = max(int(restore_count or 0), 0)
    for hold in reversed(holds):
        if remaining <= 0:
            break
        count = min(remaining, max(int(hold.get("count") or 0), 0))
        if count:
            conn.execute("UPDATE billing_image_grants SET remaining_count = MIN(total_count, remaining_count + ?), updated_at = ? WHERE id = ?", (count, int(now), str(hold.get("grant_id") or "")))
            remaining -= count


def settle_reservation(conn: sqlite3.Connection, reservation_id: str, *, actual_quantity: int | None = None, success: bool = True, now: int | None = None) -> dict[str, Any]:
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (str(reservation_id),)).fetchone()
    if row is None:
        raise BillingError("RESERVATION_NOT_FOUND", "计费预占不存在", 404)
    if str(row["status"]) in {"settled", "released", "waived"}:
        return _reservation_public(row)
    if not success:
        return release_reservation(conn, str(reservation_id), now=current)
    meta = _loads(row["meta_json"], {})
    reserved_qty = max(int(meta.get("quantity") or 0), 0)
    actual = reserved_qty if actual_quantity is None else max(min(int(actual_quantity or 0), reserved_qty), 0)
    rate_units = max(int(meta.get("unit_credit_units") or 0), 0)
    image = bool(meta.get("image"))
    reserved_credit = int(row["reserved_credit_units"] or 0)
    reserved_images = int(row["reserved_image_count"] or 0)
    settled_images = min(actual, reserved_images) if image else 0
    settled_credit = max(actual - settled_images, 0) * rate_units if image else actual * rate_units
    credit_refund = max(reserved_credit - settled_credit, 0)
    image_refund = max(reserved_images - settled_images, 0)
    wallet = ensure_wallet(conn, int(row["user_id"]), now=current)
    if credit_refund:
        conn.execute("UPDATE billing_wallets SET credit_units = credit_units + ?, updated_at = ? WHERE user_id = ?", (credit_refund, current, int(row["user_id"])))
        _insert_ledger(
            conn, user_id=int(row["user_id"]), asset_type="credit", event_type="reservation_refund", amount_units=credit_refund,
            balance_after_units=int(wallet["credit_units"]) + credit_refund, ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]),
            reservation_id=str(row["id"]), idempotency_key=f"{row['id']}:settle_credit_refund", meta={"actual_quantity": actual}, now=current,
        )
    holds = meta.get("grant_holds") if isinstance(meta.get("grant_holds"), list) else []
    if image_refund:
        _restore_grants(conn, holds, image_refund, current)
        total_images = int(conn.execute("SELECT COALESCE(SUM(remaining_count), 0) AS c FROM billing_image_grants WHERE user_id = ?", (int(row["user_id"]),)).fetchone()["c"])
        _insert_ledger(
            conn, user_id=int(row["user_id"]), asset_type="image", event_type="reservation_refund", amount_units=image_refund,
            balance_after_units=total_images, ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]), reservation_id=str(row["id"]),
            idempotency_key=f"{row['id']}:settle_image_refund", meta={"actual_quantity": actual}, now=current,
        )
    conn.execute(
        "UPDATE billing_reservations SET status = 'settled', settled_credit_units = ?, settled_image_count = ?, updated_at = ? WHERE id = ? AND status = 'held'",
        (settled_credit, settled_images, current, str(row["id"])),
    )
    _insert_ledger(
        conn, user_id=int(row["user_id"]), asset_type="audit", event_type="settled", amount_units=0,
        balance_after_units=max(int(wallet["credit_units"]) + credit_refund, 0), ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]),
        reservation_id=str(row["id"]), idempotency_key=f"{row['id']}:settled", meta={"sku": str(row["sku"]), "actual_quantity": actual, "charged_credit_units": settled_credit, "free_images": settled_images}, now=current,
    )
    return _reservation_public(conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (str(row["id"]),)).fetchone())


def release_reservation(conn: sqlite3.Connection, reservation_id: str, *, now: int | None = None) -> dict[str, Any]:
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (str(reservation_id),)).fetchone()
    if row is None:
        raise BillingError("RESERVATION_NOT_FOUND", "计费预占不存在", 404)
    if str(row["status"]) != "held":
        return _reservation_public(row)
    meta = _loads(row["meta_json"], {})
    credit_units = int(row["reserved_credit_units"] or 0)
    image_count = int(row["reserved_image_count"] or 0)
    wallet = ensure_wallet(conn, int(row["user_id"]), now=current)
    if credit_units:
        conn.execute("UPDATE billing_wallets SET credit_units = credit_units + ?, updated_at = ? WHERE user_id = ?", (credit_units, current, int(row["user_id"])))
        _insert_ledger(
            conn, user_id=int(row["user_id"]), asset_type="credit", event_type="release", amount_units=credit_units,
            balance_after_units=int(wallet["credit_units"]) + credit_units, ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]),
            reservation_id=str(row["id"]), idempotency_key=f"{row['id']}:release_credit", now=current,
        )
    holds = meta.get("grant_holds") if isinstance(meta.get("grant_holds"), list) else []
    if image_count:
        _restore_grants(conn, holds, image_count, current)
        total_images = int(conn.execute("SELECT COALESCE(SUM(remaining_count), 0) AS c FROM billing_image_grants WHERE user_id = ?", (int(row["user_id"]),)).fetchone()["c"])
        _insert_ledger(
            conn, user_id=int(row["user_id"]), asset_type="image", event_type="release", amount_units=image_count,
            balance_after_units=total_images, ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]), reservation_id=str(row["id"]),
            idempotency_key=f"{row['id']}:release_image", now=current,
        )
    conn.execute("UPDATE billing_reservations SET status = 'released', updated_at = ? WHERE id = ? AND status = 'held'", (current, str(row["id"])))
    return _reservation_public(conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (str(row["id"]),)).fetchone())


def reservation_for_reference(conn: sqlite3.Connection, ref_type: str, ref_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM billing_reservations WHERE ref_type = ? AND ref_id = ? ORDER BY created_at DESC LIMIT 1", (str(ref_type), str(ref_id))).fetchone()
    return _reservation_public(row) if row else None


def create_order(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    sku: str,
    quantity: int,
    idempotency_key: str,
    renewal_subscription_ids: list[str] | None = None,
    payer_name: str = "",
    payment_reference: str = "",
    paid_at: int = 0,
    note: str = "",
    proof_path: str = "",
    now: int | None = None,
) -> dict[str, Any]:
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    qty = max(min(int(quantity or 1), 50), 1)
    idem = str(idempotency_key or "").strip()
    if not idem or len(idem) > 128:
        raise BillingError("INVALID_IDEMPOTENCY_KEY", "缺少有效的幂等键", 400)
    requested_sku = str(sku)
    renewals = [str(item_id).strip() for item_id in (renewal_subscription_ids or []) if str(item_id).strip()]
    requested_payer_name = str(payer_name)[:120]
    requested_payment_reference = str(payment_reference)[:160]
    requested_paid_at = max(int(paid_at or 0), 0)
    requested_note = str(note)[:1000]
    requested_proof_path = str(proof_path)[:500]
    existing = conn.execute("SELECT * FROM billing_orders WHERE user_id = ? AND idempotency_key = ?", (int(user_id), idem)).fetchone()
    if existing:
        existing_request = (
            str(existing["sku"]),
            int(existing["quantity"]),
            _loads(existing["renewal_subscription_ids_json"], []),
            str(existing["payer_name"]),
            str(existing["payment_reference"]),
            int(existing["paid_at"]),
            str(existing["note"]),
            str(existing["proof_path"]),
        )
        requested_order = (
            requested_sku,
            qty,
            renewals,
            requested_payer_name,
            requested_payment_reference,
            requested_paid_at,
            requested_note,
            requested_proof_path,
        )
        if existing_request != requested_order:
            raise BillingError(
                "ORDER_IDEMPOTENCY_CONFLICT",
                "Idempotency key is already bound to a different order request",
                409,
            )
        return order_public(existing)
    catalog = get_active_catalog(conn)
    kind, item = _catalog_item(catalog, requested_sku)
    if kind != "subscription" and renewals:
        raise BillingError("INVALID_RENEWAL", "算力储值订单不能指定订阅", 400)
    if renewals and len(renewals) not in {1, qty}:
        raise BillingError("INVALID_RENEWAL", "续费订阅数量必须与购买数量一致", 400)
    if renewals:
        placeholders = ",".join("?" for _ in renewals)
        owned = int(conn.execute(f"SELECT COUNT(*) AS c FROM billing_subscriptions WHERE user_id = ? AND id IN ({placeholders})", (int(user_id), *renewals)).fetchone()["c"])
        if owned != len(renewals):
            raise BillingError("SUBSCRIPTION_NOT_FOUND", "续费订阅不存在", 404)
    amount = int(item.get("price_ntd") or 0) * 100 * qty
    order_id = _id("bill_order")
    snapshot = {"kind": kind, "item": item, "catalog_version": int(catalog["version"]), "catalog_id": str(catalog["id"])}
    conn.execute(
        """
        INSERT INTO billing_orders(
          id, user_id, kind, sku, quantity, renewal_subscription_ids_json, amount_ntd_cents,
          catalog_version_id, price_snapshot_json, payer_name, payment_reference, paid_at, note,
          proof_path, status, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        """,
        (
            order_id, int(user_id), kind, requested_sku, qty, _dumps(renewals), amount, str(catalog["id"]), _dumps(snapshot),
            requested_payer_name, requested_payment_reference, requested_paid_at, requested_note, requested_proof_path, idem, current, current,
        ),
    )
    return order_public(conn.execute("SELECT * FROM billing_orders WHERE id = ?", (order_id,)).fetchone())


def order_public(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": str(item.get("id") or ""),
        "user_id": int(item.get("user_id") or 0),
        "kind": str(item.get("kind") or ""),
        "sku": str(item.get("sku") or ""),
        "quantity": int(item.get("quantity") or 1),
        "renewal_subscription_ids": _loads(item.get("renewal_subscription_ids_json"), []),
        "amount_ntd_cents": int(item.get("amount_ntd_cents") or 0),
        "amount_ntd": round(int(item.get("amount_ntd_cents") or 0) / 100, 2),
        "price_snapshot": _loads(item.get("price_snapshot_json"), {}),
        "payer_name": str(item.get("payer_name") or ""),
        "payment_reference": str(item.get("payment_reference") or ""),
        "paid_at": int(item.get("paid_at") or 0),
        "note": str(item.get("note") or ""),
        "proof_path": str(item.get("proof_path") or ""),
        "status": str(item.get("status") or ""),
        "reviewed_by": int(item.get("reviewed_by") or 0),
        "reviewed_at": int(item.get("reviewed_at") or 0),
        "review_note": str(item.get("review_note") or ""),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }


def list_orders(
    conn: sqlite3.Connection,
    *,
    user_id: int | None = None,
    status: str = "",
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if user_id is not None:
        clauses.append("user_id = ?")
        params.append(int(user_id))
    if status:
        clauses.append("status = ?")
        params.append(str(status))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    safe_limit = min(max(int(limit), 1), 500)
    safe_offset = max(int(offset), 0)
    rows = conn.execute(
        f"SELECT * FROM billing_orders {where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        (*params, safe_limit, safe_offset),
    ).fetchall()
    return [order_public(row) for row in rows]


def approve_order(conn: sqlite3.Connection, order_id: str, *, actor_user_id: int, review_note: str = "", now: int | None = None) -> dict[str, Any]:
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_orders WHERE id = ?", (str(order_id),)).fetchone()
    if row is None:
        raise BillingError("ORDER_NOT_FOUND", "订单不存在", 404)
    if str(row["status"]) == "approved":
        return order_public(row)
    if str(row["status"]) != "pending":
        raise BillingError("ORDER_NOT_PENDING", "订单当前状态不能批准", 409)
    user_id = int(row["user_id"])
    wallet = ensure_wallet(conn, user_id, now=current)
    snapshot = _loads(row["price_snapshot_json"], {})
    item = snapshot.get("item") if isinstance(snapshot.get("item"), dict) else {}
    quantity = int(row["quantity"] or 1)
    if str(row["kind"]) == "credit_pack":
        credit_units = int(item.get("total_points") or 0) * POINT_SCALE * quantity
        before = int(wallet["credit_units"])
        conn.execute("UPDATE billing_wallets SET credit_units = credit_units + ?, updated_at = ? WHERE user_id = ?", (credit_units, current, user_id))
        _insert_ledger(
            conn, user_id=user_id, asset_type="credit", event_type="credit_pack_approved", amount_units=credit_units,
            balance_after_units=before + credit_units, order_id=str(row["id"]), ref_type="order", ref_id=str(row["id"]),
            idempotency_key=f"order:{row['id']}:credit", meta={"sku": str(row["sku"]), "quantity": quantity}, now=current,
        )
        bonus_images = int(item.get("bonus_images") or 0) * quantity
        if bonus_images:
            grant_id = _id("image_grant")
            conn.execute(
                "INSERT OR IGNORE INTO billing_image_grants(id, user_id, source_type, source_ref, total_count, remaining_count, available_at, expires_at, created_at, updated_at) VALUES (?, ?, 'credit_pack_bonus', ?, ?, ?, ?, 0, ?, ?)",
                (grant_id, user_id, str(row["id"]), bonus_images, bonus_images, current, current, current),
            )
            image_balance = int(
                conn.execute(
                    "SELECT COALESCE(SUM(remaining_count), 0) AS c FROM billing_image_grants WHERE user_id = ?",
                    (user_id,),
                ).fetchone()["c"]
            )
            _insert_ledger(
                conn, user_id=user_id, asset_type="image", event_type="credit_pack_bonus", amount_units=bonus_images,
                balance_after_units=image_balance, order_id=str(row["id"]), ref_type="order", ref_id=str(row["id"]),
                idempotency_key=f"order:{row['id']}:images", meta={"permanent": True}, now=current,
            )
    else:
        renewals = _loads(row["renewal_subscription_ids_json"], [])
        monthly_images = int(item.get("monthly_free_images") or 10)
        targets: list[str] = []
        if renewals:
            clean_renewals = [str(value) for value in renewals]
            targets = clean_renewals * quantity if len(clean_renewals) == 1 else clean_renewals
        else:
            for _ in range(quantity):
                subscription_id = _id("subscription")
                conn.execute(
                    "INSERT INTO billing_subscriptions(id, user_id, plan_sku, status, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)",
                    (subscription_id, user_id, str(row["sku"]), current, current),
                )
                targets.append(subscription_id)
        for subscription_id in targets:
            subscription = conn.execute("SELECT * FROM billing_subscriptions WHERE id = ? AND user_id = ?", (subscription_id, user_id)).fetchone()
            if subscription is None:
                raise BillingError("SUBSCRIPTION_NOT_FOUND", "续费订阅不存在", 404)
            start_at = max(current, int(subscription["current_period_end"] or 0))
            end_at = add_calendar_month(start_at)
            period_id = _id("subscription_period")
            conn.execute(
                "INSERT INTO billing_subscription_periods(id, subscription_id, user_id, source_order_id, start_at, end_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (period_id, subscription_id, user_id, str(row["id"]), start_at, end_at, "active" if start_at <= current else "scheduled", current),
            )
            conn.execute("UPDATE billing_subscriptions SET status = 'active', current_period_end = ?, updated_at = ? WHERE id = ?", (end_at, current, subscription_id))
            conn.execute(
                "INSERT INTO billing_image_grants(id, user_id, source_type, source_ref, total_count, remaining_count, available_at, expires_at, created_at, updated_at) VALUES (?, ?, 'subscription_monthly', ?, ?, ?, ?, ?, ?, ?)",
                (_id("image_grant"), user_id, period_id, monthly_images, monthly_images, start_at, end_at, current, current),
            )
            _insert_ledger(
                conn, user_id=user_id, asset_type="subscription", event_type="subscription_period_approved", amount_units=1,
                balance_after_units=1, order_id=str(row["id"]), ref_type="subscription", ref_id=subscription_id,
                idempotency_key=f"period:{period_id}:approved", meta={"start_at": start_at, "end_at": end_at}, now=current,
            )
        conn.execute("UPDATE billing_wallets SET billing_mode = 'enforced', updated_at = ? WHERE user_id = ?", (current, user_id))
    conn.execute(
        "UPDATE billing_orders SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        (int(actor_user_id), current, str(review_note)[:1000], current, str(order_id)),
    )
    return order_public(conn.execute("SELECT * FROM billing_orders WHERE id = ?", (str(order_id),)).fetchone())


def review_order(conn: sqlite3.Connection, order_id: str, *, actor_user_id: int, status: str, review_note: str = "", now: int | None = None) -> dict[str, Any]:
    desired = str(status)
    if desired == "approved":
        return approve_order(conn, order_id, actor_user_id=actor_user_id, review_note=review_note, now=now)
    if desired not in {"rejected", "cancelled"}:
        raise BillingError("INVALID_ORDER_STATUS", "无效订单状态", 400)
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_orders WHERE id = ?", (str(order_id),)).fetchone()
    if row is None:
        raise BillingError("ORDER_NOT_FOUND", "订单不存在", 404)
    if str(row["status"]) == desired:
        return order_public(row)
    if str(row["status"]) != "pending":
        raise BillingError("ORDER_NOT_PENDING", "订单当前状态不能变更", 409)
    conn.execute(
        "UPDATE billing_orders SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        (desired, int(actor_user_id), current, str(review_note)[:1000], current, str(order_id)),
    )
    return order_public(conn.execute("SELECT * FROM billing_orders WHERE id = ?", (str(order_id),)).fetchone())


def cancel_order(conn: sqlite3.Connection, order_id: str, *, user_id: int, now: int | None = None) -> dict[str, Any]:
    current = int(now or _now())
    row = conn.execute("SELECT * FROM billing_orders WHERE id = ? AND user_id = ?", (str(order_id), int(user_id))).fetchone()
    if row is None:
        raise BillingError("ORDER_NOT_FOUND", "订单不存在", 404)
    if str(row["status"]) == "cancelled":
        return order_public(row)
    if str(row["status"]) != "pending":
        raise BillingError("ORDER_NOT_PENDING", "只有待审核订单可以取消", 409)
    conn.execute("UPDATE billing_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ?", (current, str(order_id), int(user_id)))
    return order_public(conn.execute("SELECT * FROM billing_orders WHERE id = ?", (str(order_id),)).fetchone())


def adjust_credit(conn: sqlite3.Connection, *, user_id: int, delta_units: int, actor_user_id: int, reason: str, now: int | None = None) -> dict[str, Any]:
    if not str(reason or "").strip():
        raise BillingError("ADJUSTMENT_REASON_REQUIRED", "人工调整必须填写原因", 400)
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    wallet = ensure_wallet(conn, int(user_id), now=current)
    after = int(wallet["credit_units"]) + int(delta_units)
    if after < 0:
        raise BillingError("INSUFFICIENT_POINTS", "调整后算力点不能为负数", 409)
    conn.execute("UPDATE billing_wallets SET credit_units = ?, updated_at = ? WHERE user_id = ?", (after, current, int(user_id)))
    ref_id = _id("adjustment")
    _insert_ledger(
        conn, user_id=int(user_id), asset_type="credit", event_type="admin_adjustment", amount_units=int(delta_units),
        balance_after_units=after, ref_type="admin_adjustment", ref_id=ref_id,
        idempotency_key=f"adjustment:{ref_id}", meta={"reason": str(reason), "actor_user_id": int(actor_user_id)}, now=current,
    )
    return {"user_id": int(user_id), "credit_units": after, "points": points_from_units(after)}


def billing_summary(conn: sqlite3.Connection, user_id: int, *, now: int | None = None) -> dict[str, Any]:
    current = int(now or _now())
    wallet = ensure_wallet(conn, int(user_id), now=current)
    subscriptions = conn.execute(
        "SELECT * FROM billing_subscriptions WHERE user_id = ? ORDER BY created_at DESC",
        (int(user_id),),
    ).fetchall()
    periods = conn.execute(
        "SELECT * FROM billing_subscription_periods WHERE user_id = ? ORDER BY start_at DESC",
        (int(user_id),),
    ).fetchall()
    grants = conn.execute(
        "SELECT * FROM billing_image_grants WHERE user_id = ? ORDER BY CASE WHEN expires_at = 0 THEN 1 ELSE 0 END, expires_at ASC, created_at ASC",
        (int(user_id),),
    ).fetchall()
    active_count = _active_subscription_count(conn, int(user_id), current)
    catalog = get_active_catalog(conn)
    threads_per = int((catalog.get("subscription") or {}).get("threads_accounts") or 3)
    monthly_remaining = sum(int(row["remaining_count"] or 0) for row in grants if str(row["source_type"]) == "subscription_monthly" and int(row["available_at"] or 0) <= current and int(row["expires_at"] or 0) > current)
    permanent_remaining = sum(int(row["remaining_count"] or 0) for row in grants if int(row["expires_at"] or 0) == 0 and int(row["available_at"] or 0) <= current)
    return {
        "user_id": int(user_id),
        "enforcement_enabled": enforcement_enabled(),
        "billing_mode": str(wallet["billing_mode"]),
        "credit_units": int(wallet["credit_units"]),
        "points": points_from_units(int(wallet["credit_units"])),
        "subscription_active": active_count > 0 or str(wallet["billing_mode"]) == "legacy",
        "active_subscription_count": active_count,
        "threads_account_limit": None if str(wallet["billing_mode"]) == "legacy" else active_count * threads_per,
        "free_images": {"monthly_remaining": monthly_remaining, "permanent_remaining": permanent_remaining, "total_remaining": monthly_remaining + permanent_remaining},
        "subscriptions": [
            {
                "id": str(row["id"]),
                "plan_sku": str(row["plan_sku"]),
                "status": "expired" if int(row["current_period_end"] or 0) <= current else str(row["status"]),
                "current_period_end": int(row["current_period_end"]),
                "created_at": int(row["created_at"]),
            }
            for row in subscriptions
        ],
        "periods": [
            {
                "id": str(row["id"]),
                "subscription_id": str(row["subscription_id"]),
                "start_at": int(row["start_at"]),
                "end_at": int(row["end_at"]),
                "status": (
                    "expired"
                    if int(row["end_at"] or 0) <= current
                    else ("scheduled" if int(row["start_at"] or 0) > current else "active")
                ),
            }
            for row in periods
        ],
        "image_grants": [
            {"id": str(row["id"]), "source_type": str(row["source_type"]), "total_count": int(row["total_count"]), "remaining_count": int(row["remaining_count"]), "available_at": int(row["available_at"]), "expires_at": int(row["expires_at"])}
            for row in grants
        ],
    }


def list_ledger(conn: sqlite3.Connection, *, user_id: int, limit: int = 100, before: int = 0) -> list[dict[str, Any]]:
    clauses = ["user_id = ?"]
    params: list[Any] = [int(user_id)]
    if int(before or 0) > 0:
        clauses.append("created_at < ?")
        params.append(int(before))
    rows = conn.execute(
        f"SELECT * FROM billing_ledger WHERE {' AND '.join(clauses)} ORDER BY created_at DESC, id DESC LIMIT ?",
        (*params, min(max(int(limit), 1), 200)),
    ).fetchall()
    return [
        {
            "id": str(row["id"]), "asset_type": str(row["asset_type"]), "event_type": str(row["event_type"]),
            "amount_units": int(row["amount_units"]), "amount_points": points_from_units(abs(int(row["amount_units"]))) * (-1 if int(row["amount_units"]) < 0 else 1),
            "balance_after_units": int(row["balance_after_units"]), "balance_after_points": points_from_units(int(row["balance_after_units"])),
            "ref_type": str(row["ref_type"]), "ref_id": str(row["ref_id"]), "order_id": str(row["order_id"]),
            "reservation_id": str(row["reservation_id"]), "meta": _loads(row["meta_json"], {}), "created_at": int(row["created_at"]),
        }
        for row in rows
    ]
