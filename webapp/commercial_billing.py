from __future__ import annotations

import calendar
import json
import math
import os
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


POINT_SCALE = 100
NEW_USER_WELCOME_POINTS = 5
LEGACY_R18_ACTION_SKUS = {
    "ad_video_480p_second",
    "ad_video_720p_second",
    "ad_video_1080p_second",
    "ad_video_2k_second",
    "ad_video_4k_second",
}
try:
    SHANGHAI = ZoneInfo("Asia/Shanghai")
except ZoneInfoNotFoundError:
    SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")


DEFAULT_AUTOMATION_MODULES: list[dict[str, Any]] = [
    {
        "key": "social_warmup",
        "name": "养号",
        "description": "浏览、点赞与低频互动养号；当前不扣除算力点。",
        "task_types": ["threads_warmup", "instagram_warmup"],
        "reply_scope": "",
        "billing_mode": "free",
        "action_sku": "",
    },
    {
        "key": "auto_reply_comments",
        "name": "自动回复评论",
        "description": "自动回复账号收到的评论，按互动任务批次计费。",
        "task_types": ["threads_auto_reply", "instagram_auto_reply"],
        "reply_scope": "comments",
        "billing_mode": "action",
        "action_sku": "threads_auto_reply_batch",
    },
    {
        "key": "auto_reply_hot_posts",
        "name": "自动回复热点推文",
        "description": "自动发现并回复热点推文，按互动任务批次计费。",
        "task_types": ["threads_auto_reply", "instagram_auto_reply"],
        "reply_scope": "hot_posts",
        "billing_mode": "action",
        "action_sku": "threads_auto_reply_batch",
    },
]

PERSONAL_SUBSCRIPTION_FEATURES = [
    "1 个独立 IG / Threads 综合代理账号，由 AI 自动驾驶",
    "每月 10 张免费 AI 图片，使用免费额度不扣算力点",
    "通用基础文案模板与日常发文话术包无限使用",
    "Vecto OS 标准后台：单账号排程、流量数据看板与算力消耗明细",
    "AI 热点抓取、单账号沙箱风控与内容前置审核",
]

ENTERPRISE_SUBSCRIPTION_FEATURES = [
    "3 个独立 IG / Threads 分工代理账号，由 Vecto OS 自动管理",
    "每月 10 张免费 AI 图片，使用免费额度不扣算力点",
    "全行业乾货文案库、产品对比模板与评论互动话术包无限使用",
    "Vecto OS 完整后台：三账号排程、流量向量看板与算力消耗明细",
    "AI 热点抓取、内容前置风控与多账号分流防封机制",
]

PERSONAL_SUBSCRIPTION_PROFILE = {
    "plan_tier": "personal",
    "audience": "自由创作者与微型个人商家",
    "account_positioning": "乾货输出、真实分享与轻量引流合一的综合账号",
}

ENTERPRISE_SUBSCRIPTION_PROFILE = {
    "plan_tier": "enterprise",
    "audience": "中小企业、品牌商家与多线运营团队",
    "account_positioning": "乾货主账号、体验账号与投放账号分工运行",
}

OFFICIAL_BILLING_RULES = [
    {"key": "free_image_priority", "name": "免费图片优先抵扣", "description": "订阅期间每月赠送 10 张免费 AI 图片，用完后才扣除算力点。"},
    {"key": "shared_compute_pool", "name": "算力池共享", "description": "同一会员的个人版与多套企业版 OPC 共用同一算力池。"},
    {"key": "permanent_compute_points", "name": "算力点永久有效", "description": "已储值算力点跨月累计，不设使用期限且不会自动清零。"},
    {"key": "separate_payment_flows", "name": "订阅与储值独立", "description": "订阅费与算力储值分开结算，不能互相抵扣或转换。"},
    {"key": "site_build_excluded", "name": "独立站不含在订阅内", "description": "独立站规划、设计、建置、网域、主机和维护需要另行委托报价。"},
]


DEFAULT_CATALOG: dict[str, Any] = {
    "currency": "TWD",
    "timezone": "Asia/Shanghai",
    "point_unit_ntd": 10,
    "subscription": {
        "sku": "vanguard_enterprise_quarterly",
        "name": "Vecto Vanguard OPC 企业版（季缴）",
        "price_ntd": 18000,
        "monthly_price_ntd": 6000,
        "period_months": 3,
        "threads_accounts": 3,
        "monthly_free_images": 10,
        "features": [
            "3 个独立 IG / Threads 代理账号",
            "Vecto OS 排程、完整数据与账号分流风控",
            "每月 10 张免费 AI 图片",
        ],
    },
    "subscriptions": [
        {"sku": "vanguard_personal_quarterly", "name": "Vecto Vanguard OPC 个人轻量版（季缴）", "price_ntd": 6000, "monthly_price_ntd": 2000, "period_months": 3, "threads_accounts": 1, "monthly_free_images": 10, "features": ["1 个综合 IG / Threads 代理账号", "标准排程、文案库、模板与话术包", "每月 10 张免费 AI 图片"]},
        {"sku": "vanguard_personal_half_year", "name": "Vecto Vanguard OPC 个人轻量版（半年缴）", "price_ntd": 12000, "monthly_price_ntd": 2000, "period_months": 6, "threads_accounts": 1, "monthly_free_images": 10, "features": ["1 个综合 IG / Threads 代理账号", "标准排程、文案库、模板与话术包", "每月 10 张免费 AI 图片"]},
        {"sku": "vanguard_personal_annual", "name": "Vecto Vanguard OPC 个人轻量版（年缴）", "price_ntd": 24000, "monthly_price_ntd": 2000, "period_months": 12, "threads_accounts": 1, "monthly_free_images": 10, "features": ["1 个综合 IG / Threads 代理账号", "标准排程、文案库、模板与话术包", "每月 10 张免费 AI 图片"]},
        {"sku": "vanguard_enterprise_quarterly", "name": "Vecto Vanguard OPC 企业版（季缴）", "price_ntd": 18000, "monthly_price_ntd": 6000, "period_months": 3, "threads_accounts": 3, "monthly_free_images": 10, "features": ["3 个独立 IG / Threads 代理账号", "完整数据、三账号排程与分流风控", "每月 10 张免费 AI 图片"]},
        {"sku": "vanguard_enterprise_half_year", "name": "Vecto Vanguard OPC 企业版（半年缴）", "price_ntd": 36000, "monthly_price_ntd": 6000, "period_months": 6, "threads_accounts": 3, "monthly_free_images": 10, "features": ["3 个独立 IG / Threads 代理账号", "完整数据、三账号排程与分流风控", "每月 10 张免费 AI 图片"]},
        {"sku": "vanguard_enterprise_annual", "name": "Vecto Vanguard OPC 企业版（年缴）", "price_ntd": 72000, "monthly_price_ntd": 6000, "period_months": 12, "threads_accounts": 3, "monthly_free_images": 10, "features": ["3 个独立 IG / Threads 代理账号", "完整数据、三账号排程与分流风控", "每月 10 张免费 AI 图片"]},
    ],
    "actions": [
        {"sku": "threads_text_publish", "name": "Threads 纯文字推文发布", "points": 0, "unit": "次", "implemented": True},
        {"sku": "instagram_text_publish", "name": "Instagram 纯文字推文发布", "points": 0, "unit": "次", "implemented": True},
        {"sku": "complete_image_post", "name": "基础完整图文贴文（文案、1 张基础 AI 图及发布）", "points": 2.5, "unit": "篇", "implemented": True},
        {"sku": "basic_text_post", "name": "AI 文本处理步骤", "points": 0.3, "unit": "步", "implemented": True, "public": False},
        {"sku": "tweet_generation", "name": "AI 推文生成", "points": 0.5, "unit": "篇", "implemented": True},
        {"sku": "hot_tweet_fetch", "name": "热点推文抓取", "points": 0.5, "unit": "次", "implemented": True},
        {"sku": "ai_image", "name": "单独生成或追加 AI 图片", "points": 2, "unit": "张", "implemented": True},
        {"sku": "oral_video_second", "name": "数字人口播视频", "points": 0.5, "unit": "秒", "implemented": True},
        {"sku": "threads_auto_reply_batch", "name": "批量评论 / Quote 转发互动任务", "points": 5, "unit": "批次", "implemented": True},
        {"sku": "crm_direct_message_batch", "name": "CRM 私信触达批准批次", "points": 5, "unit": "批准批次", "implemented": True},
        {"sku": "crm_group_invite_batch", "name": "CRM 群组邀请批准批次", "points": 5, "unit": "批准批次", "implemented": True},
        {"sku": "seedance_fast_480p_second", "name": "SeedDance 2.0 Fast 480p", "points": 3, "unit": "秒", "implemented": True},
        {"sku": "seedance_fast_720p_second", "name": "SeedDance 2.0 Fast 720p", "points": 6, "unit": "秒", "implemented": True},
        {"sku": "seedance_fast_1080p_second", "name": "SeedDance 2.0 Fast 1080p", "points": 7.5, "unit": "秒", "implemented": True},
        {"sku": "seedance_fast_2k_second", "name": "SeedDance 2.0 Fast 2K", "points": 8, "unit": "秒", "implemented": True},
        {"sku": "seedance_fast_4k_second", "name": "SeedDance 2.0 Fast 4K", "points": 9, "unit": "秒", "implemented": True},
        {"sku": "seedance_480p_second", "name": "SeedDance 2.0 480p", "points": 4, "unit": "秒", "implemented": True},
        {"sku": "seedance_720p_second", "name": "SeedDance 2.0 720p", "points": 8, "unit": "秒", "implemented": True},
        {"sku": "seedance_1080p_second", "name": "SeedDance 2.0 1080p", "points": 9, "unit": "秒", "implemented": True},
        {"sku": "seedance_2k_second", "name": "SeedDance 2.0 2K", "points": 10, "unit": "秒", "implemented": True},
        {"sku": "seedance_4k_second", "name": "SeedDance 2.0 4K", "points": 11, "unit": "秒", "implemented": True},
        {"sku": "video_language_replace_second", "name": "视频语种更换", "points": 0.5, "unit": "秒", "implemented": True},
        {"sku": "video_model_replace_second", "name": "视频模特替换", "points": 0.5, "unit": "秒", "implemented": True},
        {"sku": "video_product_replace_second", "name": "视频商品替换", "points": 0.5, "unit": "秒", "implemented": True},
        {"sku": "ecommerce_image", "name": "电商广告图", "points": 2, "unit": "张", "implemented": True},
        {"sku": "ecommerce_seeding_image", "name": "种草视频分镜图", "points": 2, "unit": "张", "implemented": True},
        {"sku": "subject_replace_image", "name": "人物 / 商品图片替换", "points": 2, "unit": "张", "implemented": True},
        {"sku": "poster_translate_image", "name": "电商图语种切换", "points": 2, "unit": "张", "implemented": True},
        {"sku": "subject_generate_image", "name": "数字人 / 产品主体图", "points": 2, "unit": "张", "implemented": True},
    ],
    "packages": [
        {"sku": "credits_200", "name": "标准储值包", "price_ntd": 2000, "paid_points": 200, "bonus_points": 0, "total_points": 200, "bonus_images": 0},
        {"sku": "credits_530", "name": "畅销储值包", "price_ntd": 5000, "paid_points": 500, "bonus_points": 30, "total_points": 530, "bonus_images": 0},
        {"sku": "credits_1620", "name": "企业长期储值包", "price_ntd": 15000, "paid_points": 1500, "bonus_points": 120, "total_points": 1620, "bonus_images": 20},
    ],
    "automation_modules": DEFAULT_AUTOMATION_MODULES,
}

DEFAULT_CATALOG["subscription"]["features"] = list(ENTERPRISE_SUBSCRIPTION_FEATURES)
DEFAULT_CATALOG["subscription"].update(ENTERPRISE_SUBSCRIPTION_PROFILE)
for _default_subscription in DEFAULT_CATALOG["subscriptions"]:
    _is_personal_plan = str(_default_subscription.get("sku") or "").startswith("vanguard_personal_")
    _default_subscription["features"] = list(
        PERSONAL_SUBSCRIPTION_FEATURES if _is_personal_plan else ENTERPRISE_SUBSCRIPTION_FEATURES
    )
    _default_subscription.update(
        PERSONAL_SUBSCRIPTION_PROFILE if _is_personal_plan else ENTERPRISE_SUBSCRIPTION_PROFILE
    )
DEFAULT_CATALOG["billing_rules"] = OFFICIAL_BILLING_RULES

VIDEO_ACTION_SKUS = {
    "oral_video_second",
    "seedance_fast_480p_second",
    "seedance_fast_720p_second",
    "seedance_fast_1080p_second",
    "seedance_fast_2k_second",
    "seedance_fast_4k_second",
    "seedance_480p_second",
    "seedance_720p_second",
    "seedance_1080p_second",
    "seedance_2k_second",
    "seedance_4k_second",
    "video_language_replace_second",
    "video_model_replace_second",
    "video_product_replace_second",
    "ecommerce_image",
    "ecommerce_seeding_image",
    "subject_replace_image",
    "poster_translate_image",
    "subject_generate_image",
}

CRM_ACTION_SKUS = {
    "crm_direct_message_batch",
    "crm_group_invite_batch",
}

SOCIAL_CONTENT_ACTION_SKUS = {
    "tweet_generation",
    "hot_tweet_fetch",
}


def _with_video_action_catalog(catalog: dict[str, Any]) -> dict[str, Any]:
    """Add video-workbench SKUs without overwriting administrator prices."""
    result = _loads(_dumps(catalog), {})
    actions = list(result.get("actions") or []) if isinstance(result, dict) else []
    action_by_sku = {
        str(item.get("sku") or ""): item
        for item in actions
        if isinstance(item, dict) and str(item.get("sku") or "")
    }
    defaults = {
        str(item.get("sku") or ""): item
        for item in DEFAULT_CATALOG["actions"]
        if isinstance(item, dict) and str(item.get("sku") or "") in VIDEO_ACTION_SKUS
    }
    for sku, desired in defaults.items():
        current = action_by_sku.get(sku)
        if current is None:
            actions.append(dict(desired))
            continue
        preserved_points = current.get("points", desired.get("points", 0))
        current.update(desired)
        current["points"] = preserved_points
        current["implemented"] = True
    result["actions"] = actions
    return result


def _with_crm_action_catalog(catalog: dict[str, Any]) -> dict[str, Any]:
    """Add CRM action SKUs without overwriting administrator prices."""
    result = _loads(_dumps(catalog), {})
    actions = list(result.get("actions") or []) if isinstance(result, dict) else []
    action_by_sku = {
        str(item.get("sku") or ""): item
        for item in actions
        if isinstance(item, dict) and str(item.get("sku") or "")
    }
    defaults = {
        str(item.get("sku") or ""): item
        for item in DEFAULT_CATALOG["actions"]
        if isinstance(item, dict) and str(item.get("sku") or "") in CRM_ACTION_SKUS
    }
    for sku, desired in defaults.items():
        current = action_by_sku.get(sku)
        if current is None:
            actions.append(dict(desired))
            continue
        preserved_points = current.get("points", desired.get("points", 0))
        current.update(desired)
        current["points"] = preserved_points
        current["implemented"] = True
    result["actions"] = actions
    return result


def _with_social_content_action_catalog(catalog: dict[str, Any]) -> dict[str, Any]:
    """Apply the fixed public rate for tweet generation and hot-tweet fetches."""
    result = _loads(_dumps(catalog), {})
    actions = list(result.get("actions") or []) if isinstance(result, dict) else []
    action_by_sku = {
        str(item.get("sku") or ""): item
        for item in actions
        if isinstance(item, dict) and str(item.get("sku") or "")
    }
    for desired in DEFAULT_CATALOG["actions"]:
        sku = str(desired.get("sku") or "")
        if sku not in SOCIAL_CONTENT_ACTION_SKUS:
            continue
        current = action_by_sku.get(sku)
        if current is None:
            actions.append(dict(desired))
        else:
            current.update(desired)
    result["actions"] = actions
    return result


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


def _env_enabled(name: str, default: str = "0") -> bool:
    return str(os.getenv(name, default) or default).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _with_complete_subscription_details(catalog: dict[str, Any]) -> dict[str, Any]:
    result = _loads(_dumps(catalog), {})
    existing_plans = {
        str(item.get("sku") or ""): item
        for item in result.get("subscriptions") if isinstance(result.get("subscriptions"), list)
        if isinstance(item, dict) and str(item.get("sku") or "")
    }
    merged_plans: list[dict[str, Any]] = []
    for official in DEFAULT_CATALOG["subscriptions"]:
        sku = str(official.get("sku") or "")
        existing = existing_plans.get(sku, {})
        merged = {**existing, **_loads(_dumps(official), {})}
        existing_price = int(existing.get("price_ntd") or 0)
        existing_monthly_price = int(existing.get("monthly_price_ntd") or 0)
        period_months = int(official.get("period_months") or 0)
        if (
            existing_price > 0
            and existing_monthly_price > 0
            and existing_monthly_price * period_months == existing_price
        ):
            merged["price_ntd"] = existing_price
            merged["monthly_price_ntd"] = existing_monthly_price
        merged_plans.append(merged)
    result["subscriptions"] = merged_plans
    valid_skus = {str(item.get("sku") or "") for item in merged_plans}
    default_sku = str((result.get("subscription") or {}).get("sku") or "")
    if default_sku not in valid_skus:
        default_sku = str(DEFAULT_CATALOG["subscription"]["sku"])
    result["subscription"] = dict(
        next(item for item in merged_plans if str(item.get("sku") or "") == default_sku)
    )
    result["billing_rules"] = _loads(_dumps(OFFICIAL_BILLING_RULES), [])
    return result


def enforcement_enabled() -> bool:
    return _env_enabled("COMMERCIAL_BILLING_ENABLED", "1")


def add_calendar_month(start_ts: int) -> int:
    start = datetime.fromtimestamp(int(start_ts), SHANGHAI)
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
    catalog_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v2'"
    ).fetchone()
    if catalog_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        actions = list(active_catalog.get("actions") or []) if isinstance(active_catalog, dict) else []
        action_by_sku = {
            str(item.get("sku") or ""): item
            for item in actions
            if isinstance(item, dict) and str(item.get("sku") or "")
        }
        changed = False
        for default_action in DEFAULT_CATALOG["actions"]:
            sku = str(default_action["sku"])
            current_action = action_by_sku.get(sku)
            if current_action is None:
                actions.append(dict(default_action))
                action_by_sku[sku] = actions[-1]
                changed = True
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            active_catalog["actions"] = actions
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(active_catalog), current, current, current),
            )
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v2', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed}), current),
        )

    catalog_cleanup = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v3'"
    ).fetchone()
    if catalog_cleanup is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        actions = list(active_catalog.get("actions") or []) if isinstance(active_catalog, dict) else []
        cleaned_actions = [
            item
            for item in actions
            if isinstance(item, dict)
            and str(item.get("sku") or "") not in LEGACY_R18_ACTION_SKUS
        ]
        changed = len(cleaned_actions) != len(actions)
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            active_catalog["actions"] = cleaned_actions
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(active_catalog), current, current, current),
            )
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v3', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed}), current),
        )

    official_price_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v4'"
    ).fetchone()
    if official_price_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        official_catalog = _loads(_dumps(DEFAULT_CATALOG), {})
        changed = active_row is None or active_catalog != official_catalog
        # Old drafts may still contain obsolete prices. Retire them so they cannot
        # accidentally be published after the official PDF catalog is activated.
        conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'draft'")
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            validate_catalog(official_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(official_catalog), current, current, current),
            )
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v4', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed, "source": "official-pricing-pdf"}), current),
        )

    shanghai_timezone_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v5_timezone_shanghai'"
    ).fetchone()
    if shanghai_timezone_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        changed = bool(active_row) and str(active_catalog.get("timezone") or "") != "Asia/Shanghai"
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            active_catalog["timezone"] = "Asia/Shanghai"
            active_catalog.setdefault(
                "automation_modules",
                _loads(_dumps(DEFAULT_AUTOMATION_MODULES), []),
            )
            active_catalog = _with_complete_subscription_details(active_catalog)
            validate_catalog(active_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(active_catalog), current, current, current),
            )
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v5_timezone_shanghai', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed}), current),
        )

    automation_modules_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v6_automation_modules'"
    ).fetchone()
    if automation_modules_migration is None:
        desired_modules = _loads(_dumps(DEFAULT_AUTOMATION_MODULES), [])
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        changed = bool(active_row) and active_catalog.get("automation_modules") != desired_modules
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            active_catalog["automation_modules"] = desired_modules
            active_catalog = _with_complete_subscription_details(active_catalog)
            validate_catalog(active_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(active_catalog), current, current, current),
            )

        updated_drafts = 0
        draft_rows = conn.execute(
            "SELECT id, catalog_json FROM billing_catalog_versions WHERE status = 'draft'"
        ).fetchall()
        for draft_row in draft_rows:
            draft_catalog = _loads(draft_row["catalog_json"], {})
            if not isinstance(draft_catalog, dict) or draft_catalog.get("automation_modules") == desired_modules:
                continue
            draft_catalog["automation_modules"] = _loads(_dumps(desired_modules), [])
            draft_catalog = _with_complete_subscription_details(draft_catalog)
            validate_catalog(draft_catalog)
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (_dumps(draft_catalog), str(draft_row["id"])),
            )
            updated_drafts += 1
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v6_automation_modules', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed, "updated_drafts": updated_drafts}), current),
        )

    complete_subscription_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v7_complete_subscription_details'"
    ).fetchone()
    if complete_subscription_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        upgraded_catalog = _with_complete_subscription_details(active_catalog) if active_row else active_catalog
        changed = bool(active_row) and upgraded_catalog != active_catalog
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            validate_catalog(upgraded_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(upgraded_catalog), current, current, current),
            )

        updated_drafts = 0
        draft_rows = conn.execute(
            "SELECT id, catalog_json FROM billing_catalog_versions WHERE status = 'draft'"
        ).fetchall()
        for draft_row in draft_rows:
            draft_catalog = _loads(draft_row["catalog_json"], {})
            upgraded_draft = _with_complete_subscription_details(draft_catalog)
            if upgraded_draft == draft_catalog:
                continue
            validate_catalog(upgraded_draft)
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (_dumps(upgraded_draft), str(draft_row["id"])),
            )
            updated_drafts += 1
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v7_complete_subscription_details', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed, "updated_drafts": updated_drafts}), current),
        )

    video_catalog_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v8_video_workbench'"
    ).fetchone()
    if video_catalog_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        upgraded_catalog = _with_video_action_catalog(active_catalog) if active_row else active_catalog
        changed = bool(active_row) and upgraded_catalog != active_catalog
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            validate_catalog(upgraded_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(upgraded_catalog), current, current, current),
            )

        updated_drafts = 0
        draft_rows = conn.execute(
            "SELECT id, catalog_json FROM billing_catalog_versions WHERE status = 'draft'"
        ).fetchall()
        for draft_row in draft_rows:
            draft_catalog = _loads(draft_row["catalog_json"], {})
            upgraded_draft = _with_video_action_catalog(draft_catalog)
            if upgraded_draft == draft_catalog:
                continue
            validate_catalog(upgraded_draft)
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (_dumps(upgraded_draft), str(draft_row["id"])),
            )
            updated_drafts += 1
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v8_video_workbench', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed, "updated_drafts": updated_drafts}), current),
        )

    crm_catalog_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v9_crm_actions'"
    ).fetchone()
    if crm_catalog_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        upgraded_catalog = _with_crm_action_catalog(active_catalog) if active_row else active_catalog
        changed = bool(active_row) and upgraded_catalog != active_catalog
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            validate_catalog(upgraded_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(upgraded_catalog), current, current, current),
            )

        updated_drafts = 0
        draft_rows = conn.execute(
            "SELECT id, catalog_json FROM billing_catalog_versions WHERE status = 'draft'"
        ).fetchall()
        for draft_row in draft_rows:
            draft_catalog = _loads(draft_row["catalog_json"], {})
            upgraded_draft = _with_crm_action_catalog(draft_catalog)
            if upgraded_draft == draft_catalog:
                continue
            validate_catalog(upgraded_draft)
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (_dumps(upgraded_draft), str(draft_row["id"])),
            )
            updated_drafts += 1
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v9_crm_actions', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed, "updated_drafts": updated_drafts}), current),
        )

    social_content_rates_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_catalog_v10_social_content_rates'"
    ).fetchone()
    if social_content_rates_migration is None:
        active_row = conn.execute(
            "SELECT * FROM billing_catalog_versions WHERE status = 'active' ORDER BY version_number DESC LIMIT 1"
        ).fetchone()
        active_catalog = _loads(active_row["catalog_json"], {}) if active_row else {}
        upgraded_catalog = _with_social_content_action_catalog(active_catalog) if active_row else active_catalog
        changed = bool(active_row) and upgraded_catalog != active_catalog
        if changed and active_row is not None:
            next_version = int(
                conn.execute("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM billing_catalog_versions").fetchone()["n"]
            )
            validate_catalog(upgraded_catalog)
            conn.execute("UPDATE billing_catalog_versions SET status = 'retired' WHERE status = 'active'")
            conn.execute(
                """
                INSERT INTO billing_catalog_versions(
                  id, version_number, status, catalog_json, effective_at,
                  created_by, created_at, published_at
                ) VALUES (?, ?, 'active', ?, ?, 0, ?, ?)
                """,
                (_id("catalog"), next_version, _dumps(upgraded_catalog), current, current, current),
            )
        updated_drafts = 0
        draft_rows = conn.execute(
            "SELECT id, catalog_json FROM billing_catalog_versions WHERE status = 'draft'"
        ).fetchall()
        for draft_row in draft_rows:
            draft_catalog = _loads(draft_row["catalog_json"], {})
            upgraded_draft = _with_social_content_action_catalog(draft_catalog)
            if upgraded_draft == draft_catalog:
                continue
            validate_catalog(upgraded_draft)
            conn.execute(
                "UPDATE billing_catalog_versions SET catalog_json = ? WHERE id = ?",
                (_dumps(upgraded_draft), str(draft_row["id"])),
            )
            updated_drafts += 1
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_catalog_v10_social_content_rates', ?, ?)",
            (_dumps({"completed_at": current, "changed": changed, "updated_drafts": updated_drafts}), current),
        )

    enforcement_migration = conn.execute(
        "SELECT value_json FROM admin_config WHERE key = 'commercial_billing_enforcement_v2'"
    ).fetchone()
    if (
        enforcement_migration is None
        and enforcement_enabled()
        and _env_enabled("COMMERCIAL_BILLING_MIGRATE_LEGACY")
    ):
        migrated_user_ids: list[int] = []
        transition_end = add_calendar_month(current)
        free_images = int(get_active_catalog(conn)["subscription"]["monthly_free_images"])
        rows = conn.execute(
            """
            SELECT wallet.user_id
            FROM billing_wallets AS wallet
            JOIN users AS user ON user.id = wallet.user_id
            WHERE wallet.billing_mode = 'legacy' AND user.is_admin = 0
            """
        ).fetchall()
        for row in rows:
            user_id = int(row["user_id"])
            subscription_id = _id("subscription")
            period_id = _id("period")
            source_ref = f"billing-enforcement-v2:{user_id}"
            conn.execute(
                "UPDATE billing_wallets SET billing_mode = 'enforced', updated_at = ? WHERE user_id = ?",
                (current, user_id),
            )
            if _active_subscription_count(conn, user_id, current) <= 0:
                conn.execute(
                    """
                    INSERT INTO billing_subscriptions(
                      id, user_id, plan_sku, status, current_period_end, created_at, updated_at
                    ) VALUES (?, ?, 'vanguard_monthly', 'active', ?, ?, ?)
                    """,
                    (subscription_id, user_id, transition_end, current, current),
                )
                conn.execute(
                    """
                    INSERT INTO billing_subscription_periods(
                      id, subscription_id, user_id, source_order_id, start_at, end_at, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
                    """,
                    (period_id, subscription_id, user_id, source_ref, current, transition_end, current),
                )
                if free_images > 0:
                    conn.execute(
                        """
                        INSERT INTO billing_image_grants(
                          id, user_id, source_type, source_ref, total_count, remaining_count,
                          available_at, expires_at, created_at, updated_at
                        ) VALUES (?, ?, 'subscription_monthly', ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (_id("image_grant"), user_id, source_ref, free_images, free_images, current, transition_end, current, current),
                    )
            _insert_ledger(
                conn,
                user_id=user_id,
                asset_type="audit",
                event_type="billing_enforcement_enabled",
                amount_units=0,
                balance_after_units=int(ensure_wallet(conn, user_id, now=current)["credit_units"]),
                ref_type="migration",
                ref_id="commercial_billing_enforcement_v2",
                idempotency_key=f"commercial_billing_enforcement_v2:{user_id}",
                meta={"transition_subscription_end": transition_end},
                now=current,
            )
            migrated_user_ids.append(user_id)
        conn.execute(
            "INSERT INTO admin_config(key, value_json, updated_at) VALUES ('commercial_billing_enforcement_v2', ?, ?)",
            (_dumps({"completed_at": current, "user_ids": migrated_user_ids}), current),
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
    if row is not None and int(row["cash_backed_credit_units"] or 0) > int(row["credit_units"] or 0):
        # Protect the invariant when legacy tools/tests wrote total credit directly.
        conn.execute(
            "UPDATE billing_wallets SET cash_backed_credit_units = credit_units, updated_at = ? "
            "WHERE user_id = ? AND cash_backed_credit_units > credit_units",
            (current, int(user_id)),
        )
        row = conn.execute(
            "SELECT * FROM billing_wallets WHERE user_id = ?", (int(user_id),)
        ).fetchone()
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
    if str(catalog.get("timezone") or "") != "Asia/Shanghai":
        raise BillingError("INVALID_CATALOG", "业务时区必须为 Asia/Shanghai", 400)
    subscription = catalog.get("subscription") if isinstance(catalog.get("subscription"), dict) else {}
    subscriptions = catalog.get("subscriptions") if isinstance(catalog.get("subscriptions"), list) else []
    subscription_skus = [str((item or {}).get("sku") or "") for item in subscriptions]
    subscription_by_sku = {
        str(item.get("sku") or ""): item
        for item in subscriptions
        if isinstance(item, dict) and str(item.get("sku") or "")
    }
    if (
        not subscriptions
        or len(set(subscription_skus)) != len(subscription_skus)
        or any(
            not isinstance(item, dict)
            or not str(item.get("sku") or "")
            or int(item.get("price_ntd") or 0) <= 0
            or int(item.get("period_months") or 0) not in {3, 6, 12}
            or int(item.get("monthly_price_ntd") or 0) <= 0
            or int(item.get("monthly_price_ntd") or 0) * int(item.get("period_months") or 0)
            != int(item.get("price_ntd") or 0)
            or int(item.get("threads_accounts") or 0) not in {1, 3}
            or int(item.get("monthly_free_images") or 0) < 0
            or len(item.get("features") if isinstance(item.get("features"), list) else []) < 5
            or not str(item.get("audience") or "").strip()
            or not str(item.get("account_positioning") or "").strip()
            for item in subscriptions
        )
        or str(subscription.get("sku") or "") not in set(subscription_skus)
        or any(
            subscription.get(field) != subscription_by_sku[str(subscription.get("sku") or "")].get(field)
            for field in (
                "name",
                "price_ntd",
                "period_months",
                "threads_accounts",
                "monthly_free_images",
                "features",
                "audience",
                "account_positioning",
            )
        )
    ):
        raise BillingError("INVALID_CATALOG", "订阅方案配置不完整", 400)
    packages = catalog.get("packages") if isinstance(catalog.get("packages"), list) else []
    package_skus = [str((item or {}).get("sku") or "") for item in packages]
    if (
        not packages
        or len(set(package_skus)) != len(package_skus)
        or any(
            not isinstance(item, dict)
            or not str(item.get("sku") or "")
            or int(item.get("price_ntd") or 0) <= 0
            or int(item.get("total_points") or 0) <= 0
            or int(item.get("paid_points") or 0) + int(item.get("bonus_points") or 0) != int(item.get("total_points") or 0)
            for item in packages
        )
    ):
        raise BillingError("INVALID_CATALOG", "算力套餐配置不完整", 400)
    actions = catalog.get("actions") if isinstance(catalog.get("actions"), list) else []
    action_skus = [str((item or {}).get("sku") or "") for item in actions]
    try:
        invalid_action = (
            not actions
            or len(set(action_skus)) != len(action_skus)
            or any(
                not isinstance(item, dict)
                or not str(item.get("sku") or "")
                or not math.isfinite(float(item.get("points")))
                or float(item.get("points")) < 0
                for item in actions
            )
        )
    except (TypeError, ValueError):
        invalid_action = True
    if invalid_action:
        raise BillingError("INVALID_CATALOG", "操作计费点数必须为非负数", 400)

    automation_modules = catalog.get("automation_modules") if isinstance(catalog.get("automation_modules"), list) else []
    module_keys = [str((item or {}).get("key") or "") for item in automation_modules]
    default_modules = {str(item["key"]): item for item in DEFAULT_AUTOMATION_MODULES}
    invalid_automation_modules = (
        len(automation_modules) != len(default_modules)
        or len(set(module_keys)) != len(module_keys)
        or set(module_keys) != set(default_modules)
    )
    if not invalid_automation_modules:
        for item in automation_modules:
            if not isinstance(item, dict):
                invalid_automation_modules = True
                break
            key = str(item.get("key") or "")
            expected = default_modules.get(key, {})
            task_types = item.get("task_types") if isinstance(item.get("task_types"), list) else []
            billing_mode = str(item.get("billing_mode") or "")
            action_sku = str(item.get("action_sku") or "")
            if (
                not str(item.get("name") or "").strip()
                or not str(item.get("description") or "").strip()
                or task_types != expected.get("task_types")
                or str(item.get("reply_scope") or "") != str(expected.get("reply_scope") or "")
                or billing_mode != str(expected.get("billing_mode") or "")
                or action_sku != str(expected.get("action_sku") or "")
                or (billing_mode == "action" and action_sku not in set(action_skus))
                or (billing_mode == "free" and bool(action_sku))
            ):
                invalid_automation_modules = True
                break
    if invalid_automation_modules:
        raise BillingError("INVALID_CATALOG", "自动化任务计费映射配置不完整", 400)

    billing_rules = catalog.get("billing_rules") if isinstance(catalog.get("billing_rules"), list) else []
    expected_rule_keys = [str(item["key"]) for item in OFFICIAL_BILLING_RULES]
    if (
        [str((item or {}).get("key") or "") for item in billing_rules] != expected_rule_keys
        or any(
            not isinstance(item, dict)
            or not str(item.get("name") or "").strip()
            or not str(item.get("description") or "").strip()
            for item in billing_rules
        )
    ):
        raise BillingError("INVALID_CATALOG", "订阅与算力通用规则配置不完整", 400)


def _catalog_item(catalog: dict[str, Any], sku: str) -> tuple[str, dict[str, Any]]:
    for item in catalog.get("subscriptions") if isinstance(catalog.get("subscriptions"), list) else []:
        if isinstance(item, dict) and str(item.get("sku") or "") == str(sku):
            return "subscription", item
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


def _subscription_plan_family(sku: str) -> str:
    clean = str(sku or "").strip()
    if clean == "vanguard_monthly" or clean.startswith("vanguard_enterprise_"):
        return "vanguard_enterprise"
    if clean.startswith("vanguard_personal_"):
        return "vanguard_personal"
    return clean


def require_write_access(conn: sqlite3.Connection, user_id: int, *, admin_waived: bool = False, now: int | None = None) -> dict[str, Any]:
    return ensure_wallet(conn, int(user_id), now=now)


def threads_account_limit(conn: sqlite3.Connection, user_id: int, *, now: int | None = None) -> int | None:
    current = int(now or _now())
    ensure_wallet(conn, int(user_id), now=now)
    rows = conn.execute(
        """
        SELECT DISTINCT subscription.id, subscription.plan_sku
        FROM billing_subscriptions AS subscription
        JOIN billing_subscription_periods AS period
          ON period.subscription_id = subscription.id
        WHERE subscription.user_id = ?
          AND period.status != 'cancelled'
          AND period.start_at <= ?
          AND period.end_at > ?
        """,
        (int(user_id), current, current),
    ).fetchall()
    if not rows:
        return None
    catalog = get_active_catalog(conn)
    plan_accounts = {
        str(item.get("sku") or ""): int(item.get("threads_accounts") or 0)
        for item in catalog.get("subscriptions") if isinstance(catalog.get("subscriptions"), list)
        if isinstance(item, dict) and str(item.get("sku") or "")
    }
    total = 0
    recognized = False
    for row in rows:
        sku = str(row["plan_sku"] or "")
        accounts = int(plan_accounts.get(sku) or 0)
        if accounts <= 0:
            family = _subscription_plan_family(sku)
            accounts = 3 if family == "vanguard_enterprise" else (1 if family == "vanguard_personal" else 0)
        if accounts > 0:
            recognized = True
            total += accounts
    return total if recognized else None


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
    cash_backed_amount_units: int = 0,
    cash_backed_balance_after_units: int | None = None,
    meta: dict[str, Any] | None = None,
    now: int | None = None,
) -> None:
    if cash_backed_balance_after_units is None:
        wallet = conn.execute(
            "SELECT cash_backed_credit_units FROM billing_wallets WHERE user_id = ?",
            (int(user_id),),
        ).fetchone()
        cash_backed_balance_after_units = (
            int(wallet["cash_backed_credit_units"] or 0) if wallet is not None else 0
        )
    conn.execute(
        """
        INSERT OR IGNORE INTO billing_ledger(
          id, user_id, asset_type, event_type, amount_units, balance_after_units,
          cash_backed_amount_units, cash_backed_balance_after_units,
          ref_type, ref_id, order_id, reservation_id, meta_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            _id("bill_entry"), int(user_id), str(asset_type), str(event_type), int(amount_units), int(balance_after_units),
            int(cash_backed_amount_units), int(cash_backed_balance_after_units),
            str(ref_type), str(ref_id), str(order_id), str(reservation_id), _dumps(meta or {}), str(idempotency_key), int(now or _now()),
        ),
    )


def initialize_new_user_wallet(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    extra_points: Any = 0,
    actor_user_id: int = 0,
    source: str = "registration",
    now: int | None = None,
) -> dict[str, Any]:
    """Create an enforced wallet and apply the idempotent new-user grants."""
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    target_id = int(user_id)
    user = conn.execute("SELECT id, is_admin FROM users WHERE id = ?", (target_id,)).fetchone()
    if user is None:
        raise BillingError("USER_NOT_FOUND", "账号不存在", 404)
    if bool(int(user["is_admin"] or 0)):
        raise BillingError("ADMIN_WALLET_NOT_SUPPORTED", "管理员账号不参与客户算力点赠送", 409)
    conn.execute(
        """
        INSERT OR IGNORE INTO billing_wallets(
          user_id, credit_units, billing_mode, migrated_legacy_balance, created_at, updated_at
        ) VALUES (?, 0, 'enforced', 0, ?, ?)
        """,
        (target_id, current, current),
    )
    conn.execute(
        "UPDATE billing_wallets SET billing_mode = 'enforced', updated_at = ? WHERE user_id = ?",
        (current, target_id),
    )

    grants = [
        (
            NEW_USER_WELCOME_POINTS * POINT_SCALE,
            "welcome_credit",
            f"welcome-credit-v1:{target_id}",
            "welcome_credit",
            "v1",
            {"points": NEW_USER_WELCOME_POINTS, "source": str(source or "registration")},
        )
    ]
    extra_units = units_from_points(extra_points)
    if extra_units > 0:
        grants.append(
            (
                extra_units,
                "admin_initial_credit",
                f"new-user-extra:{str(source or 'registration')}:{target_id}",
                "user_create",
                str(target_id),
                {
                    "points": points_from_units(extra_units),
                    "source": str(source or "registration"),
                    "actor_user_id": int(actor_user_id or 0),
                },
            )
        )

    for amount_units, event_type, idempotency_key, ref_type, ref_id, meta in grants:
        if conn.execute(
            "SELECT 1 FROM billing_ledger WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone() is not None:
            continue
        wallet = conn.execute(
            "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
            (target_id,),
        ).fetchone()
        after = int(wallet["credit_units"] or 0) + int(amount_units)
        conn.execute(
            "UPDATE billing_wallets SET credit_units = ?, updated_at = ? WHERE user_id = ?",
            (after, current, target_id),
        )
        _insert_ledger(
            conn,
            user_id=target_id,
            asset_type="credit",
            event_type=event_type,
            amount_units=int(amount_units),
            balance_after_units=after,
            ref_type=ref_type,
            ref_id=ref_id,
            idempotency_key=idempotency_key,
            meta=meta,
            now=current,
        )
    return ensure_wallet(conn, target_id, now=current)


def _reservation_public(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    meta = _loads(item.get("meta_json"), {})
    return {
        "id": str(item.get("id") or ""),
        "sku": str(item.get("sku") or ""),
        "status": str(item.get("status") or ""),
        "reserved_points": points_from_units(int(item.get("reserved_credit_units") or 0)),
        "reserved_cash_backed_points": points_from_units(
            int(item.get("reserved_cash_backed_credit_units") or 0)
        ),
        "charged_points": points_from_units(int(item.get("settled_credit_units") or 0)),
        "charged_cash_backed_points": points_from_units(
            int(item.get("settled_cash_backed_credit_units") or 0)
        ),
        "refunded_cash_backed_points": points_from_units(
            int(item.get("refunded_cash_backed_credit_units") or 0)
        ),
        "reserved_images": int(item.get("reserved_image_count") or 0),
        "free_images_used": int(item.get("settled_image_count") or 0),
        "unlimited_compute": bool(meta.get("unlimited_compute")),
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
        existing_meta = _loads(existing["meta_json"], {})
        existing_request = (
            int(existing["user_id"]),
            str(existing["ref_type"]),
            str(existing["ref_id"]),
            str(existing["sku"]),
            int(existing_meta.get("quantity") or 0),
            bool(
                existing_meta.get(
                    "image",
                    int(existing["reserved_image_count"] or 0) > 0,
                )
            ),
            bool(
                existing_meta.get("admin_waived")
                or str(existing_meta.get("waived_reason") or "") == "admin"
            ),
        )
        requested_request = (
            int(user_id),
            str(ref_type),
            str(ref_id),
            str(sku),
            qty,
            bool(image),
            bool(admin_waived),
        )
        if existing_request != requested_request:
            raise BillingError(
                "RESERVATION_IDEMPOTENCY_CONFLICT",
                "Idempotency key is already bound to a different reservation request",
                409,
            )
        return _reservation_public(existing)
    wallet = ensure_wallet(conn, int(user_id), now=current)
    rate_units, catalog_version_id = action_rate_units(conn, str(sku))
    unlimited_compute = bool(int(wallet.get("unlimited_compute") or 0))
    waived_reason = (
        "feature_disabled"
        if not enforcement_enabled()
        else ("admin" if admin_waived else "")
    )
    reservation_id = _id("bill_hold")
    if waived_reason:
        conn.execute(
            "INSERT INTO billing_reservations(id, user_id, ref_type, ref_id, sku, status, catalog_version_id, meta_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'waived', ?, ?, ?, ?, ?)",
            (
                reservation_id,
                int(user_id),
                str(ref_type),
                str(ref_id),
                str(sku),
                catalog_version_id,
                _dumps(
                    {
                        "quantity": qty,
                        "unit_credit_units": rate_units,
                        "image": bool(image),
                        "admin_waived": bool(admin_waived),
                        "waived_reason": waived_reason,
                    }
                ),
                idem,
                current,
                current,
            ),
        )
        if admin_waived:
            _insert_ledger(
                conn, user_id=int(user_id), asset_type="audit", event_type="admin_waived", amount_units=0,
                balance_after_units=int(wallet["credit_units"]), ref_type=ref_type, ref_id=ref_id,
                reservation_id=reservation_id, idempotency_key=f"{idem}:waived", meta={"sku": sku, "quantity": qty}, now=current,
            )
        return _reservation_public(conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone())

    if unlimited_compute:
        meta = {
            "quantity": qty,
            "unit_credit_units": rate_units,
            "image": bool(image),
            "admin_waived": False,
            "unlimited_compute": True,
            "theoretical_credit_units": qty * rate_units,
        }
        conn.execute(
            """
            INSERT INTO billing_reservations(
              id, user_id, ref_type, ref_id, sku, status,
              catalog_version_id, meta_json, idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)
            """,
            (
                reservation_id,
                int(user_id),
                str(ref_type),
                str(ref_id),
                str(sku),
                catalog_version_id,
                _dumps(meta),
                idem,
                current,
                current,
            ),
        )
        _insert_ledger(
            conn,
            user_id=int(user_id),
            asset_type="audit",
            event_type="unlimited_compute_reserved",
            amount_units=0,
            balance_after_units=int(wallet["credit_units"]),
            ref_type=ref_type,
            ref_id=ref_id,
            reservation_id=reservation_id,
            idempotency_key=f"{idem}:unlimited",
            meta={"sku": sku, "quantity": qty, "theoretical_credit_units": qty * rate_units},
            now=current,
        )
        return _reservation_public(
            conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone()
        )

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
    cash_backed_balance = int(wallet.get("cash_backed_credit_units") or 0)
    if balance < credit_units:
        raise BillingError("INSUFFICIENT_POINTS", "算力点不足，请先提交储值申请", 402)
    non_cash_balance = max(balance - cash_backed_balance, 0)
    cash_backed_credit_units = max(credit_units - non_cash_balance, 0)
    if credit_units:
        conn.execute(
            "UPDATE billing_wallets SET credit_units = credit_units - ?, "
            "cash_backed_credit_units = cash_backed_credit_units - ?, updated_at = ? "
            "WHERE user_id = ? AND credit_units >= ? AND cash_backed_credit_units >= ?",
            (
                credit_units,
                cash_backed_credit_units,
                current,
                int(user_id),
                credit_units,
                cash_backed_credit_units,
            ),
        )
    meta = {
        "quantity": qty,
        "unit_credit_units": rate_units,
        "image": bool(image),
        "admin_waived": False,
        "grant_holds": grant_holds,
        "cash_backed_credit_units": cash_backed_credit_units,
    }
    conn.execute(
        """
        INSERT INTO billing_reservations(
          id, user_id, ref_type, ref_id, sku, status, reserved_credit_units,
          reserved_cash_backed_credit_units, reserved_image_count,
          catalog_version_id, meta_json, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            reservation_id, int(user_id), str(ref_type), str(ref_id), str(sku),
            credit_units, cash_backed_credit_units, free_images, catalog_version_id,
            _dumps(meta), idem, current, current,
        ),
    )
    if credit_units:
        _insert_ledger(
            conn, user_id=int(user_id), asset_type="credit", event_type="reserve", amount_units=-credit_units,
            balance_after_units=balance - credit_units, ref_type=ref_type, ref_id=ref_id, reservation_id=reservation_id,
            idempotency_key=f"{idem}:credit_hold", meta={"sku": sku, "quantity": qty}, now=current,
            cash_backed_amount_units=-cash_backed_credit_units,
            cash_backed_balance_after_units=cash_backed_balance - cash_backed_credit_units,
        )
    if free_images:
        remaining_images = sum(int(row["remaining_count"] or 0) for row in conn.execute("SELECT remaining_count FROM billing_image_grants WHERE user_id = ?", (int(user_id),)).fetchall())
        _insert_ledger(
            conn, user_id=int(user_id), asset_type="image", event_type="reserve", amount_units=-free_images,
            balance_after_units=remaining_images, ref_type=ref_type, ref_id=ref_id, reservation_id=reservation_id,
            idempotency_key=f"{idem}:image_hold", meta={"sku": sku, "grant_holds": grant_holds}, now=current,
        )
    return _reservation_public(conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)).fetchone())


def reserve_exact_cash_charge(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    ref_type: str,
    ref_id: str,
    sku: str,
    credit_units: int,
    idempotency_key: str,
    admin_waived: bool = False,
    meta: dict[str, Any] | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Reserve a server-calculated amount using only paid, cash-backed points."""
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    amount = int(credit_units or 0)
    if amount <= 0:
        raise BillingError("INVALID_CHARGE", "Charge amount must be greater than zero", 400)
    raw_idem = str(idempotency_key or "").strip()
    if not raw_idem:
        raise BillingError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400)
    # External purchase callers supply client-controlled keys. Scope them by
    # owner so two customers can legitimately use the same client key while
    # retaining the legacy globally-unique reservation schema.
    idem = f"cash-exact:{int(user_id)}:{raw_idem}"
    existing = conn.execute(
        "SELECT * FROM billing_reservations WHERE idempotency_key = ?", (idem,)
    ).fetchone()
    if existing is None:
        # Compatibility for holds created before per-user key scoping shipped.
        existing = conn.execute(
            "SELECT * FROM billing_reservations WHERE idempotency_key = ? AND user_id = ?",
            (raw_idem, int(user_id)),
        ).fetchone()
    request_fingerprint = (
        int(user_id), str(ref_type), str(ref_id), str(sku), amount, bool(admin_waived)
    )
    if existing is not None:
        existing_meta = _loads(existing["meta_json"], {})
        existing_amount = int(
            existing_meta.get("theoretical_credit_units")
            or existing["reserved_credit_units"]
            or 0
        )
        existing_fingerprint = (
            int(existing["user_id"]),
            str(existing["ref_type"]),
            str(existing["ref_id"]),
            str(existing["sku"]),
            existing_amount,
            bool(existing_meta.get("admin_waived")),
        )
        if (
            existing_fingerprint != request_fingerprint
            or not bool(existing_meta.get("exact_cash_backed"))
        ):
            raise BillingError(
                "RESERVATION_IDEMPOTENCY_CONFLICT",
                "Idempotency key is already bound to a different reservation request",
                409,
            )
        return _reservation_public(existing)

    wallet = ensure_wallet(conn, int(user_id), now=current)
    balance = int(wallet["credit_units"] or 0)
    cash_balance = int(wallet.get("cash_backed_credit_units") or 0)
    reservation_id = _id("bill_hold")
    if admin_waived:
        merged_meta = dict(meta or {})
        merged_meta.update(
            {
                "quantity": 1,
                "unit_credit_units": amount,
                "theoretical_credit_units": amount,
                "image": False,
                "admin_waived": True,
                "waived_reason": "admin",
                "exact_cash_backed": True,
                "cash_backed_credit_units": 0,
            }
        )
        conn.execute(
            "INSERT INTO billing_reservations(id,user_id,ref_type,ref_id,sku,status,"
            "catalog_version_id,meta_json,idempotency_key,created_at,updated_at) "
            "VALUES (?,?,?,?,?,'waived','',?,?,?,?)",
            (
                reservation_id,
                int(user_id),
                str(ref_type),
                str(ref_id),
                str(sku),
                _dumps(merged_meta),
                idem,
                current,
                current,
            ),
        )
        _insert_ledger(
            conn,
            user_id=int(user_id),
            asset_type="audit",
            event_type="admin_waived",
            amount_units=0,
            balance_after_units=balance,
            cash_backed_balance_after_units=cash_balance,
            ref_type=str(ref_type),
            ref_id=str(ref_id),
            reservation_id=reservation_id,
            idempotency_key=f"{idem}:waived",
            meta={"sku": str(sku), "theoretical_credit_units": amount},
            now=current,
        )
        return _reservation_public(
            conn.execute(
                "SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)
            ).fetchone()
        )
    if cash_balance < amount:
        raise BillingError(
            "INSUFFICIENT_CASH_BACKED_POINTS",
            "Cash-backed points are insufficient for this purchase",
            402,
        )
    merged_meta = dict(meta or {})
    merged_meta.update(
        {
            "quantity": 1,
            "unit_credit_units": amount,
            "image": False,
            "admin_waived": False,
            "exact_cash_backed": True,
            "cash_backed_credit_units": amount,
        }
    )
    cursor = conn.execute(
        "UPDATE billing_wallets SET credit_units = credit_units - ?, "
        "cash_backed_credit_units = cash_backed_credit_units - ?, updated_at = ? "
        "WHERE user_id = ? AND credit_units >= ? AND cash_backed_credit_units >= ?",
        (amount, amount, current, int(user_id), amount, amount),
    )
    if cursor.rowcount != 1:
        raise BillingError(
            "INSUFFICIENT_CASH_BACKED_POINTS",
            "Cash-backed points are insufficient for this purchase",
            402,
        )
    conn.execute(
        """
        INSERT INTO billing_reservations(
          id, user_id, ref_type, ref_id, sku, status, reserved_credit_units,
          reserved_cash_backed_credit_units, catalog_version_id, meta_json,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, '', ?, ?, ?, ?)
        """,
        (
            reservation_id, int(user_id), str(ref_type), str(ref_id), str(sku),
            amount, amount, _dumps(merged_meta), idem, current, current,
        ),
    )
    _insert_ledger(
        conn,
        user_id=int(user_id),
        asset_type="credit",
        event_type="reserve",
        amount_units=-amount,
        balance_after_units=balance - amount,
        cash_backed_amount_units=-amount,
        cash_backed_balance_after_units=cash_balance - amount,
        ref_type=str(ref_type),
        ref_id=str(ref_id),
        reservation_id=reservation_id,
        idempotency_key=f"{idem}:credit_hold",
        meta={"sku": str(sku), "exact_cash_backed": True},
        now=current,
    )
    return _reservation_public(
        conn.execute(
            "SELECT * FROM billing_reservations WHERE id = ?", (reservation_id,)
        ).fetchone()
    )


def refund_settled_exact_cash_charge(
    conn: sqlite3.Connection,
    reservation_id: str,
    *,
    reason: str,
    now: int | None = None,
) -> dict[str, Any]:
    """Idempotently reverse a settled exact cash-backed reservation."""
    clean_reason = str(reason or "").strip()
    if not clean_reason:
        raise BillingError("REFUND_REASON_REQUIRED", "Refund reason is required", 400)
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    row = conn.execute(
        "SELECT * FROM billing_reservations WHERE id = ?", (str(reservation_id),)
    ).fetchone()
    if row is None:
        raise BillingError("RESERVATION_NOT_FOUND", "Billing reservation not found", 404)
    meta = _loads(row["meta_json"], {})
    if not bool(meta.get("exact_cash_backed")):
        raise BillingError(
            "RESERVATION_NOT_EXACT_CASH",
            "Only exact cash-backed reservations can use this refund path",
            409,
        )
    if str(row["status"]) != "settled":
        raise BillingError(
            "RESERVATION_NOT_SETTLED",
            "Only settled reservations can be refunded",
            409,
        )
    settled = int(row["settled_cash_backed_credit_units"] or 0)
    refunded = int(row["refunded_cash_backed_credit_units"] or 0)
    amount = max(settled - refunded, 0)
    if amount <= 0:
        return _reservation_public(row)
    wallet = ensure_wallet(conn, int(row["user_id"]), now=current)
    before_total = int(wallet["credit_units"] or 0)
    before_cash = int(wallet.get("cash_backed_credit_units") or 0)
    updated = conn.execute(
        "UPDATE billing_reservations SET refunded_cash_backed_credit_units = ?, "
        "updated_at = ? WHERE id = ? AND status = 'settled' "
        "AND refunded_cash_backed_credit_units = ?",
        (settled, current, str(row["id"]), refunded),
    ).rowcount
    if updated != 1:
        return _reservation_public(
            conn.execute(
                "SELECT * FROM billing_reservations WHERE id = ?", (str(row["id"]),)
            ).fetchone()
        )
    conn.execute(
        "UPDATE billing_wallets SET credit_units = credit_units + ?, "
        "cash_backed_credit_units = cash_backed_credit_units + ?, updated_at = ? "
        "WHERE user_id = ?",
        (amount, amount, current, int(row["user_id"])),
    )
    _insert_ledger(
        conn,
        user_id=int(row["user_id"]),
        asset_type="credit",
        event_type="exact_cash_refund",
        amount_units=amount,
        balance_after_units=before_total + amount,
        cash_backed_amount_units=amount,
        cash_backed_balance_after_units=before_cash + amount,
        ref_type=str(row["ref_type"]),
        ref_id=str(row["ref_id"]),
        reservation_id=str(row["id"]),
        idempotency_key=f"{row['id']}:exact_cash_refund",
        meta={"reason": clean_reason},
        now=current,
    )
    return _reservation_public(
        conn.execute(
            "SELECT * FROM billing_reservations WHERE id = ?", (str(row["id"]),)
        ).fetchone()
    )


def reserve_exact_charge(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    ref_type: str,
    ref_id: str,
    sku: str,
    credit_units: int,
    idempotency_key: str,
    require_cash_backed: bool = True,
    meta: dict[str, Any] | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Compatibility entrypoint for trusted, dynamic-price server workflows."""
    if not require_cash_backed:
        raise BillingError(
            "CASH_BACKING_REQUIRED",
            "Exact external purchases must require cash-backed points",
            400,
        )
    return reserve_exact_cash_charge(
        conn,
        user_id=user_id,
        ref_type=ref_type,
        ref_id=ref_id,
        sku=sku,
        credit_units=credit_units,
        idempotency_key=idempotency_key,
        meta=meta,
        now=now,
    )


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
    if bool(meta.get("unlimited_compute")):
        wallet = ensure_wallet(conn, int(row["user_id"]), now=current)
        conn.execute(
            "UPDATE billing_reservations SET status = 'settled', updated_at = ? WHERE id = ? AND status = 'held'",
            (current, str(row["id"])),
        )
        _insert_ledger(
            conn,
            user_id=int(row["user_id"]),
            asset_type="audit",
            event_type="unlimited_compute_settled",
            amount_units=0,
            balance_after_units=int(wallet["credit_units"]),
            ref_type=str(row["ref_type"]),
            ref_id=str(row["ref_id"]),
            reservation_id=str(row["id"]),
            idempotency_key=f"{row['id']}:unlimited_settled",
            meta={
                "sku": str(row["sku"]),
                "actual_quantity": actual,
                "theoretical_credit_units": actual * rate_units,
            },
            now=current,
        )
        return _reservation_public(
            conn.execute("SELECT * FROM billing_reservations WHERE id = ?", (str(row["id"]),)).fetchone()
        )
    image = bool(meta.get("image"))
    reserved_credit = int(row["reserved_credit_units"] or 0)
    reserved_cash_backed = int(row["reserved_cash_backed_credit_units"] or 0)
    reserved_images = int(row["reserved_image_count"] or 0)
    settled_images = min(actual, reserved_images) if image else 0
    settled_credit = max(actual - settled_images, 0) * rate_units if image else actual * rate_units
    reserved_non_cash = max(reserved_credit - reserved_cash_backed, 0)
    settled_cash_backed = max(settled_credit - reserved_non_cash, 0)
    credit_refund = max(reserved_credit - settled_credit, 0)
    cash_backed_refund = max(reserved_cash_backed - settled_cash_backed, 0)
    image_refund = max(reserved_images - settled_images, 0)
    wallet = ensure_wallet(conn, int(row["user_id"]), now=current)
    if credit_refund:
        conn.execute(
            "UPDATE billing_wallets SET credit_units = credit_units + ?, "
            "cash_backed_credit_units = cash_backed_credit_units + ?, updated_at = ? "
            "WHERE user_id = ?",
            (credit_refund, cash_backed_refund, current, int(row["user_id"])),
        )
        _insert_ledger(
            conn, user_id=int(row["user_id"]), asset_type="credit", event_type="reservation_refund", amount_units=credit_refund,
            balance_after_units=int(wallet["credit_units"]) + credit_refund, ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]),
            reservation_id=str(row["id"]), idempotency_key=f"{row['id']}:settle_credit_refund", meta={"actual_quantity": actual}, now=current,
            cash_backed_amount_units=cash_backed_refund,
            cash_backed_balance_after_units=int(wallet.get("cash_backed_credit_units") or 0) + cash_backed_refund,
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
        "UPDATE billing_reservations SET status = 'settled', settled_credit_units = ?, "
        "settled_cash_backed_credit_units = ?, settled_image_count = ?, updated_at = ? "
        "WHERE id = ? AND status = 'held'",
        (settled_credit, settled_cash_backed, settled_images, current, str(row["id"])),
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
    cash_backed_credit_units = int(row["reserved_cash_backed_credit_units"] or 0)
    image_count = int(row["reserved_image_count"] or 0)
    wallet = ensure_wallet(conn, int(row["user_id"]), now=current)
    if credit_units:
        conn.execute(
            "UPDATE billing_wallets SET credit_units = credit_units + ?, "
            "cash_backed_credit_units = cash_backed_credit_units + ?, updated_at = ? "
            "WHERE user_id = ?",
            (credit_units, cash_backed_credit_units, current, int(row["user_id"])),
        )
        _insert_ledger(
            conn, user_id=int(row["user_id"]), asset_type="credit", event_type="release", amount_units=credit_units,
            balance_after_units=int(wallet["credit_units"]) + credit_units, ref_type=str(row["ref_type"]), ref_id=str(row["ref_id"]),
            reservation_id=str(row["id"]), idempotency_key=f"{row['id']}:release_credit", now=current,
            cash_backed_amount_units=cash_backed_credit_units,
            cash_backed_balance_after_units=int(wallet.get("cash_backed_credit_units") or 0) + cash_backed_credit_units,
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
        owned_rows = conn.execute(
            f"SELECT id, plan_sku FROM billing_subscriptions WHERE user_id = ? AND id IN ({placeholders})",
            (int(user_id), *renewals),
        ).fetchall()
        if len(owned_rows) != len(renewals):
            raise BillingError("SUBSCRIPTION_NOT_FOUND", "续费订阅不存在", 404)
        requested_family = _subscription_plan_family(requested_sku)
        if any(_subscription_plan_family(str(existing["plan_sku"] or "")) != requested_family for existing in owned_rows):
            raise BillingError("SUBSCRIPTION_PLAN_MISMATCH", "续费方案必须属于原订阅计划系列；跨系列变更请新开订阅", 409)
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
        "refunded_by": int(item.get("refunded_by") or 0),
        "refunded_at": int(item.get("refunded_at") or 0),
        "refund_note": str(item.get("refund_note") or ""),
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
        cash_before = int(wallet.get("cash_backed_credit_units") or 0)
        conn.execute(
            "UPDATE billing_wallets SET credit_units = credit_units + ?, "
            "cash_backed_credit_units = cash_backed_credit_units + ?, updated_at = ? "
            "WHERE user_id = ?",
            (credit_units, credit_units, current, user_id),
        )
        _insert_ledger(
            conn, user_id=user_id, asset_type="credit", event_type="credit_pack_approved", amount_units=credit_units,
            balance_after_units=before + credit_units, order_id=str(row["id"]), ref_type="order", ref_id=str(row["id"]),
            idempotency_key=f"order:{row['id']}:credit", meta={"sku": str(row["sku"]), "quantity": quantity}, now=current,
            cash_backed_amount_units=credit_units,
            cash_backed_balance_after_units=cash_before + credit_units,
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
        period_months = max(int(item.get("period_months") or 1), 1)
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
            cursor = max(current, int(subscription["current_period_end"] or 0))
            for month_index in range(period_months):
                start_at = cursor
                end_at = add_calendar_month(start_at)
                period_id = _id("subscription_period")
                conn.execute(
                    "INSERT INTO billing_subscription_periods(id, subscription_id, user_id, source_order_id, start_at, end_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (period_id, subscription_id, user_id, str(row["id"]), start_at, end_at, "active" if start_at <= current < end_at else "scheduled", current),
                )
                conn.execute(
                    "INSERT INTO billing_image_grants(id, user_id, source_type, source_ref, total_count, remaining_count, available_at, expires_at, created_at, updated_at) VALUES (?, ?, 'subscription_monthly', ?, ?, ?, ?, ?, ?, ?)",
                    (_id("image_grant"), user_id, period_id, monthly_images, monthly_images, start_at, end_at, current, current),
                )
                _insert_ledger(
                    conn, user_id=user_id, asset_type="subscription", event_type="subscription_period_approved", amount_units=1,
                    balance_after_units=1, order_id=str(row["id"]), ref_type="subscription", ref_id=subscription_id,
                    idempotency_key=f"period:{period_id}:approved", meta={"start_at": start_at, "end_at": end_at, "month_index": month_index + 1, "period_months": period_months}, now=current,
                )
                cursor = end_at
            conn.execute(
                "UPDATE billing_subscriptions SET status = 'active', plan_sku = ?, current_period_end = ?, updated_at = ? WHERE id = ?",
                (str(row["sku"]), cursor, current, subscription_id),
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


def _subscription_public(
    row: sqlite3.Row | dict[str, Any],
    *,
    now: int,
) -> dict[str, Any]:
    item = dict(row)
    stored_status = str(item.get("status") or "")
    current_period_end = int(item.get("current_period_end") or 0)
    status = stored_status
    if stored_status != "cancelled" and current_period_end <= int(now):
        status = "expired"
    return {
        "id": str(item.get("id") or ""),
        "user_id": int(item.get("user_id") or 0),
        "plan_sku": str(item.get("plan_sku") or ""),
        "status": status,
        "current_period_end": current_period_end,
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
    }


def _image_balance(conn: sqlite3.Connection, user_id: int, now: int) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(remaining_count), 0) AS c
        FROM billing_image_grants
        WHERE user_id = ?
          AND remaining_count > 0
          AND available_at <= ?
          AND (expires_at = 0 OR expires_at > ?)
        """,
        (int(user_id), int(now), int(now)),
    ).fetchone()
    return int(row["c"] or 0)


def _ensure_image_grants_not_held(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    grant_ids: set[str],
) -> None:
    if not grant_ids:
        return
    held = conn.execute(
        """
        SELECT id, meta_json
        FROM billing_reservations
        WHERE user_id = ? AND status = 'held' AND reserved_image_count > 0
        """,
        (int(user_id),),
    ).fetchall()
    for reservation in held:
        meta = _loads(reservation["meta_json"], {})
        reservation_grants = {
            str(item.get("grant_id") or "")
            for item in (meta.get("grant_holds") or [])
            if isinstance(item, dict)
        }
        if grant_ids.intersection(reservation_grants):
            raise BillingError(
                "SUBSCRIPTION_BENEFITS_IN_USE",
                "Subscription images are reserved by an active task; finish or cancel it before reversing access",
                409,
            )


def _revoke_remaining_image_grant(
    conn: sqlite3.Connection,
    grant: sqlite3.Row,
    *,
    user_id: int,
    event_type: str,
    order_id: str = "",
    subscription_id: str = "",
    actor_user_id: int,
    reason: str,
    now: int,
) -> int:
    remaining = int(grant["remaining_count"] or 0)
    if remaining <= 0:
        return 0
    conn.execute(
        "UPDATE billing_image_grants SET remaining_count = 0, updated_at = ? "
        "WHERE id = ? AND remaining_count = ?",
        (int(now), str(grant["id"]), remaining),
    )
    _insert_ledger(
        conn,
        user_id=int(user_id),
        asset_type="image",
        event_type=str(event_type),
        amount_units=-remaining,
        balance_after_units=_image_balance(conn, int(user_id), int(now)),
        order_id=str(order_id),
        ref_type="subscription" if subscription_id else "order",
        ref_id=str(subscription_id or order_id),
        idempotency_key=f"grant:{grant['id']}:{event_type}",
        meta={
            "grant_id": str(grant["id"]),
            "revoked_remaining": remaining,
            "actor_user_id": int(actor_user_id),
            "reason": str(reason),
        },
        now=int(now),
    )
    return remaining


def _recompute_subscription_state(
    conn: sqlite3.Connection,
    subscription_id: str,
    *,
    now: int,
) -> sqlite3.Row:
    remaining = conn.execute(
        """
        SELECT MAX(end_at) AS max_end
        FROM billing_subscription_periods
        WHERE subscription_id = ? AND status != 'cancelled'
        """,
        (str(subscription_id),),
    ).fetchone()
    max_end = int(remaining["max_end"] or 0)
    if max_end <= 0:
        status = "cancelled"
        current_period_end = int(now)
    elif max_end <= int(now):
        status = "expired"
        current_period_end = max_end
    else:
        status = "active"
        current_period_end = max_end
    conn.execute(
        "UPDATE billing_subscriptions "
        "SET status = ?, current_period_end = ?, updated_at = ? WHERE id = ?",
        (status, current_period_end, int(now), str(subscription_id)),
    )
    return conn.execute(
        "SELECT * FROM billing_subscriptions WHERE id = ?",
        (str(subscription_id),),
    ).fetchone()


def terminate_subscription(
    conn: sqlite3.Connection,
    subscription_id: str,
    *,
    actor_user_id: int,
    reason: str,
    now: int | None = None,
) -> dict[str, Any]:
    termination_reason = str(reason or "").strip()
    if not termination_reason:
        raise BillingError(
            "SUBSCRIPTION_TERMINATION_REASON_REQUIRED",
            "Subscription termination requires an audit reason",
            400,
        )
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    subscription = conn.execute(
        "SELECT * FROM billing_subscriptions WHERE id = ?",
        (str(subscription_id),),
    ).fetchone()
    if subscription is None:
        raise BillingError("SUBSCRIPTION_NOT_FOUND", "Subscription not found", 404)
    if str(subscription["status"]) == "cancelled":
        return _subscription_public(subscription, now=current)

    user_id = int(subscription["user_id"])
    periods = conn.execute(
        """
        SELECT *
        FROM billing_subscription_periods
        WHERE subscription_id = ? AND status != 'cancelled' AND end_at > ?
        ORDER BY start_at
        """,
        (str(subscription_id), current),
    ).fetchall()
    grants_by_period: dict[str, sqlite3.Row] = {}
    for period in periods:
        grant = conn.execute(
            "SELECT * FROM billing_image_grants "
            "WHERE source_type = 'subscription_monthly' AND source_ref = ?",
            (str(period["id"]),),
        ).fetchone()
        if grant is not None:
            grants_by_period[str(period["id"])] = grant
    _ensure_image_grants_not_held(
        conn,
        user_id=user_id,
        grant_ids={str(grant["id"]) for grant in grants_by_period.values()},
    )
    for period in periods:
        conn.execute(
            "UPDATE billing_subscription_periods SET status = 'cancelled' "
            "WHERE id = ? AND status != 'cancelled'",
            (str(period["id"]),),
        )
        grant = grants_by_period.get(str(period["id"]))
        if grant is not None:
            _revoke_remaining_image_grant(
                conn,
                grant,
                user_id=user_id,
                event_type="subscription_images_terminated",
                subscription_id=str(subscription_id),
                actor_user_id=int(actor_user_id),
                reason=termination_reason,
                now=current,
            )

    conn.execute(
        "UPDATE billing_subscriptions "
        "SET status = 'cancelled', current_period_end = ?, updated_at = ? "
        "WHERE id = ? AND status != 'cancelled'",
        (current, current, str(subscription_id)),
    )
    _insert_ledger(
        conn,
        user_id=user_id,
        asset_type="subscription",
        event_type="subscription_terminated",
        amount_units=-1,
        balance_after_units=_active_subscription_count(conn, user_id, current),
        ref_type="subscription",
        ref_id=str(subscription_id),
        idempotency_key=f"subscription:{subscription_id}:terminated",
        meta={
            "actor_user_id": int(actor_user_id),
            "reason": termination_reason,
            "cancelled_period_ids": [str(period["id"]) for period in periods],
        },
        now=current,
    )
    updated = conn.execute(
        "SELECT * FROM billing_subscriptions WHERE id = ?",
        (str(subscription_id),),
    ).fetchone()
    return _subscription_public(updated, now=current)


def refund_approved_order(
    conn: sqlite3.Connection,
    order_id: str,
    *,
    actor_user_id: int,
    reason: str,
    now: int | None = None,
) -> dict[str, Any]:
    """Reverse unused entitlements from a manually approved order.

    This records the internal entitlement reversal only. Any payment-provider
    refund remains an explicit external/manual operation.
    """
    refund_reason = str(reason or "").strip()
    if not refund_reason:
        raise BillingError(
            "REFUND_REASON_REQUIRED",
            "Approved order refund requires an audit reason",
            400,
        )
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    row = conn.execute(
        "SELECT * FROM billing_orders WHERE id = ?",
        (str(order_id),),
    ).fetchone()
    if row is None:
        raise BillingError("ORDER_NOT_FOUND", "Order not found", 404)
    if str(row["status"]) == "refunded":
        return order_public(row)
    if str(row["status"]) != "approved":
        raise BillingError(
            "ORDER_NOT_APPROVED",
            "Only approved orders can be refunded",
            409,
        )

    user_id = int(row["user_id"])
    snapshot = _loads(row["price_snapshot_json"], {})
    item = snapshot.get("item") if isinstance(snapshot.get("item"), dict) else {}
    quantity = int(row["quantity"] or 1)
    wallet = ensure_wallet(conn, user_id, now=current)

    if str(row["kind"]) == "credit_pack":
        credit_units = int(item.get("total_points") or 0) * POINT_SCALE * quantity
        bonus_images = int(item.get("bonus_images") or 0) * quantity
        balance = int(wallet["credit_units"])
        cash_backed_balance = int(wallet.get("cash_backed_credit_units") or 0)
        if balance < credit_units or cash_backed_balance < credit_units:
            raise BillingError(
                "ORDER_BENEFITS_ALREADY_USED",
                "The credited points have already been used and cannot be safely reclaimed",
                409,
            )
        bonus_grant = None
        if bonus_images > 0:
            bonus_grant = conn.execute(
                "SELECT * FROM billing_image_grants "
                "WHERE source_type = 'credit_pack_bonus' AND source_ref = ?",
                (str(row["id"]),),
            ).fetchone()
            if (
                bonus_grant is None
                or int(bonus_grant["total_count"] or 0) != bonus_images
                or int(bonus_grant["remaining_count"] or 0) != bonus_images
            ):
                raise BillingError(
                    "ORDER_BENEFITS_ALREADY_USED",
                    "The bonus images have already been used and cannot be safely reclaimed",
                    409,
                )

        if credit_units > 0:
            conn.execute(
                "UPDATE billing_wallets SET credit_units = credit_units - ?, "
                "cash_backed_credit_units = cash_backed_credit_units - ?, updated_at = ? "
                "WHERE user_id = ? AND credit_units >= ? AND cash_backed_credit_units >= ?",
                (credit_units, credit_units, current, user_id, credit_units, credit_units),
            )
            _insert_ledger(
                conn,
                user_id=user_id,
                asset_type="credit",
                event_type="credit_pack_refunded",
                amount_units=-credit_units,
                balance_after_units=balance - credit_units,
                order_id=str(row["id"]),
                ref_type="order",
                ref_id=str(row["id"]),
                idempotency_key=f"order:{row['id']}:credit_refund",
                meta={
                    "actor_user_id": int(actor_user_id),
                    "reason": refund_reason,
                    "sku": str(row["sku"]),
                    "quantity": quantity,
                },
                cash_backed_amount_units=-credit_units,
                cash_backed_balance_after_units=cash_backed_balance - credit_units,
                now=current,
            )
        if bonus_grant is not None:
            _revoke_remaining_image_grant(
                conn,
                bonus_grant,
                user_id=user_id,
                event_type="credit_pack_bonus_revoked",
                order_id=str(row["id"]),
                actor_user_id=int(actor_user_id),
                reason=refund_reason,
                now=current,
            )
    else:
        periods = conn.execute(
            "SELECT * FROM billing_subscription_periods "
            "WHERE source_order_id = ? ORDER BY start_at",
            (str(row["id"]),),
        ).fetchall()
        if not periods:
            raise BillingError(
                "ORDER_REFUND_UNSAFE",
                "The approved subscription order has no entitlement periods to reverse",
                409,
            )
        grants_by_period: dict[str, sqlite3.Row] = {}
        for period in periods:
            grant = conn.execute(
                "SELECT * FROM billing_image_grants "
                "WHERE source_type = 'subscription_monthly' AND source_ref = ?",
                (str(period["id"]),),
            ).fetchone()
            if grant is not None:
                grants_by_period[str(period["id"])] = grant
        _ensure_image_grants_not_held(
            conn,
            user_id=user_id,
            grant_ids={str(grant["id"]) for grant in grants_by_period.values()},
        )
        affected_subscription_ids: set[str] = set()
        for period in periods:
            subscription_id = str(period["subscription_id"])
            affected_subscription_ids.add(subscription_id)
            if str(period["status"]) != "cancelled":
                conn.execute(
                    "UPDATE billing_subscription_periods SET status = 'cancelled' "
                    "WHERE id = ? AND status != 'cancelled'",
                    (str(period["id"]),),
                )
                _insert_ledger(
                    conn,
                    user_id=user_id,
                    asset_type="subscription",
                    event_type="subscription_period_refunded",
                    amount_units=-1,
                    balance_after_units=_active_subscription_count(
                        conn,
                        user_id,
                        current,
                    ),
                    order_id=str(row["id"]),
                    ref_type="subscription",
                    ref_id=subscription_id,
                    idempotency_key=f"period:{period['id']}:refunded",
                    meta={
                        "period_id": str(period["id"]),
                        "actor_user_id": int(actor_user_id),
                        "reason": refund_reason,
                    },
                    now=current,
                )
            grant = grants_by_period.get(str(period["id"]))
            if grant is not None:
                _revoke_remaining_image_grant(
                    conn,
                    grant,
                    user_id=user_id,
                    event_type="subscription_images_refunded",
                    order_id=str(row["id"]),
                    subscription_id=subscription_id,
                    actor_user_id=int(actor_user_id),
                    reason=refund_reason,
                    now=current,
                )
        for subscription_id in affected_subscription_ids:
            _recompute_subscription_state(
                conn,
                subscription_id,
                now=current,
            )

    conn.execute(
        """
        UPDATE billing_orders
        SET status = 'refunded', refunded_by = ?, refunded_at = ?,
            refund_note = ?, updated_at = ?
        WHERE id = ? AND status = 'approved'
        """,
        (
            int(actor_user_id),
            current,
            refund_reason[:1000],
            current,
            str(row["id"]),
        ),
    )
    _insert_ledger(
        conn,
        user_id=user_id,
        asset_type="audit",
        event_type="order_refunded",
        amount_units=0,
        balance_after_units=int(
            conn.execute(
                "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                (user_id,),
            ).fetchone()["credit_units"]
        ),
        order_id=str(row["id"]),
        ref_type="order",
        ref_id=str(row["id"]),
        idempotency_key=f"order:{row['id']}:refunded",
        meta={
            "actor_user_id": int(actor_user_id),
            "reason": refund_reason,
            "kind": str(row["kind"]),
        },
        now=current,
    )
    updated = conn.execute(
        "SELECT * FROM billing_orders WHERE id = ?",
        (str(row["id"]),),
    ).fetchone()
    return order_public(updated)


def adjust_credit(conn: sqlite3.Connection, *, user_id: int, delta_units: int, actor_user_id: int, reason: str, now: int | None = None) -> dict[str, Any]:
    if not str(reason or "").strip():
        raise BillingError("ADJUSTMENT_REASON_REQUIRED", "人工调整必须填写原因", 400)
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    wallet = ensure_wallet(conn, int(user_id), now=current)
    after = int(wallet["credit_units"]) + int(delta_units)
    if after < 0:
        raise BillingError("INSUFFICIENT_POINTS", "调整后算力点不能为负数", 409)
    cash_before = int(wallet.get("cash_backed_credit_units") or 0)
    # Free/admin grants never become purchase-eligible. Negative adjustments
    # consume non-cash points first and only then reduce the cash-backed bucket.
    cash_after = min(cash_before, after)
    conn.execute(
        "UPDATE billing_wallets SET credit_units = ?, cash_backed_credit_units = ?, "
        "updated_at = ? WHERE user_id = ?",
        (after, cash_after, current, int(user_id)),
    )
    ref_id = _id("adjustment")
    _insert_ledger(
        conn, user_id=int(user_id), asset_type="credit", event_type="admin_adjustment", amount_units=int(delta_units),
        balance_after_units=after, ref_type="admin_adjustment", ref_id=ref_id,
        idempotency_key=f"adjustment:{ref_id}", meta={"reason": str(reason), "actor_user_id": int(actor_user_id)}, now=current,
        cash_backed_amount_units=cash_after - cash_before,
        cash_backed_balance_after_units=cash_after,
    )
    return {
        "user_id": int(user_id),
        "credit_units": after,
        "points": points_from_units(after),
        "cash_backed_credit_units": cash_after,
        "cash_backed_points": points_from_units(cash_after),
        "unlimited_compute": bool(int(wallet.get("unlimited_compute") or 0)),
    }


def set_unlimited_compute(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    enabled: bool,
    actor_user_id: int,
    reason: str,
    now: int | None = None,
) -> dict[str, Any]:
    if not str(reason or "").strip():
        raise BillingError("ADJUSTMENT_REASON_REQUIRED", "人工调整必须填写原因", 400)
    _ensure_immediate_transaction(conn)
    current = int(now or _now())
    wallet = ensure_wallet(conn, int(user_id), now=current)
    before = bool(int(wallet.get("unlimited_compute") or 0))
    after = bool(enabled)
    if before != after:
        conn.execute(
            "UPDATE billing_wallets SET unlimited_compute = ?, updated_at = ? WHERE user_id = ?",
            (1 if after else 0, current, int(user_id)),
        )
        ref_id = _id("unlimited_compute")
        _insert_ledger(
            conn,
            user_id=int(user_id),
            asset_type="audit",
            event_type="unlimited_compute_enabled" if after else "unlimited_compute_disabled",
            amount_units=0,
            balance_after_units=int(wallet["credit_units"]),
            ref_type="admin_adjustment",
            ref_id=ref_id,
            idempotency_key=f"unlimited_compute:{ref_id}",
            meta={
                "reason": str(reason),
                "actor_user_id": int(actor_user_id),
                "before": before,
                "after": after,
            },
            now=current,
        )
    return {
        "user_id": int(user_id),
        "credit_units": int(wallet["credit_units"]),
        "points": points_from_units(int(wallet["credit_units"])),
        "cash_backed_credit_units": int(wallet.get("cash_backed_credit_units") or 0),
        "cash_backed_points": points_from_units(
            int(wallet.get("cash_backed_credit_units") or 0)
        ),
        "unlimited_compute": after,
    }


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
    monthly_remaining = sum(int(row["remaining_count"] or 0) for row in grants if str(row["source_type"]) == "subscription_monthly" and int(row["available_at"] or 0) <= current and int(row["expires_at"] or 0) > current)
    permanent_remaining = sum(int(row["remaining_count"] or 0) for row in grants if int(row["expires_at"] or 0) == 0 and int(row["available_at"] or 0) <= current)
    return {
        "user_id": int(user_id),
        "enforcement_enabled": enforcement_enabled(),
        "billing_mode": str(wallet["billing_mode"]),
        "unlimited_compute": bool(int(wallet.get("unlimited_compute") or 0)),
        "credit_units": int(wallet["credit_units"]),
        "points": points_from_units(int(wallet["credit_units"])),
        "cash_backed_credit_units": int(wallet.get("cash_backed_credit_units") or 0),
        "cash_backed_points": points_from_units(
            int(wallet.get("cash_backed_credit_units") or 0)
        ),
        "subscription_active": active_count > 0,
        "active_subscription_count": active_count,
        "threads_account_limit": threads_account_limit(conn, int(user_id), now=current),
        "free_images": {"monthly_remaining": monthly_remaining, "permanent_remaining": permanent_remaining, "total_remaining": monthly_remaining + permanent_remaining},
        "subscriptions": [
            {
                "id": str(row["id"]),
                "plan_sku": str(row["plan_sku"]),
                "status": _subscription_public(row, now=current)["status"],
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
                    "cancelled"
                    if str(row["status"]) == "cancelled"
                    else (
                        "expired"
                        if int(row["end_at"] or 0) <= current
                        else ("scheduled" if int(row["start_at"] or 0) > current else "active")
                    )
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
            "cash_backed_amount_units": int(row["cash_backed_amount_units"]),
            "cash_backed_amount_points": points_from_units(
                abs(int(row["cash_backed_amount_units"]))
            ) * (-1 if int(row["cash_backed_amount_units"]) < 0 else 1),
            "cash_backed_balance_after_units": int(row["cash_backed_balance_after_units"]),
            "cash_backed_balance_after_points": points_from_units(
                int(row["cash_backed_balance_after_units"])
            ),
            "ref_type": str(row["ref_type"]), "ref_id": str(row["ref_id"]), "order_id": str(row["order_id"]),
            "reservation_id": str(row["reservation_id"]), "meta": _loads(row["meta_json"], {}), "created_at": int(row["created_at"]),
        }
        for row in rows
    ]
