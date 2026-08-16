from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Mapping

from .engagement_policy import is_platform_moderation_warning


QUEUED_STALE_SECONDS = 120
RUNNING_STALE_SECONDS = 240
ACTIVE_TASK_STATUSES = frozenset({"queued", "running"})

_SIGNALS = (
    (
        "account_mismatch",
        re.compile(r"account[_ -]?mismatch|logged in as.+not|not.+expected|账号(?:不符|不一致)|帳號(?:不符|不一致)|登录身份(?:不符|不一致)|登入身分(?:不符|不一致)", re.IGNORECASE),
        "发送账号与任务指定账号不一致，需要人工切换并重新验证。",
    ),
    (
        "security_verification",
        re.compile(r"captcha|challenge|required security|security verification|checkpoint|验证码|驗證碼|安全验证|安全驗證|人机验证|人機驗證|异常登录|異常登入", re.IGNORECASE),
        "平台要求安全或人机验证，需要人工完成后才能继续。",
    ),
    (
        "rotation_locked",
        re.compile(r"rotation.+lock|locked.+sender|three consecutive|轮换(?:保护)?锁|輪替(?:保護)?鎖|账号.+锁定|帳號.+鎖定|已锁定|已鎖定", re.IGNORECASE),
        "发送工作线已触发轮换保护，需要人工检查账号与消息页。",
    ),
    (
        "authentication_required",
        re.compile(r"authentication[_ -]?required|needs?[_ -]?login|not logged in|login (?:is )?required|login[_ -]?wall|sign in|登录墙|登入牆|登入或註冊|登录或注册|需要登录|需要登入|尚未登录|尚未登入|登录已失效|登入已失效|请先登录|請先登入", re.IGNORECASE),
        "平台登录已失效或出现登录墙，需要人工登录并重新验证。",
    ),
)


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _timestamp(value: Any) -> float:
    if isinstance(value, datetime):
        parsed = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        number = float(value)
        return number / 1000 if abs(number) >= 100_000_000_000 else number
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        number = float(text)
    except ValueError:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    return number / 1000 if abs(number) >= 100_000_000_000 else number


def _last_checkpoint(task: Mapping[str, Any]) -> Mapping[str, Any]:
    batch_control = _mapping(task.get("batch_control") or task.get("batchControl"))
    checkpoints = batch_control.get("checkpoints")
    return _mapping(checkpoints[-1]) if isinstance(checkpoints, list) and checkpoints else {}


def task_activity_timestamp(task: Mapping[str, Any] | None = None) -> float:
    row = _mapping(task)
    checkpoint = _last_checkpoint(row)
    values = (
        row.get("last_activity_at") or row.get("lastActivityAt"),
        row.get("metrics_updated_at") or row.get("metricsUpdatedAt"),
        row.get("updated_at") or row.get("updatedAt"),
        row.get("started_at") or row.get("startedAt"),
        row.get("queued_at") or row.get("queuedAt"),
        row.get("created_at") or row.get("createdAt"),
        checkpoint.get("finished_at") or checkpoint.get("finishedAt"),
        checkpoint.get("started_at") or checkpoint.get("startedAt"),
    )
    parsed = [_timestamp(value) for value in values]
    return max((value for value in parsed if value > 0), default=0.0)


def task_attention_text(task: Mapping[str, Any] | None = None) -> str:
    row = _mapping(task)
    checkpoint = _last_checkpoint(row)
    result = _mapping(row.get("result"))
    warnings = row.get("warnings") if isinstance(row.get("warnings"), list) else []
    result_errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    values = [
        row.get("error"),
        *warnings,
        checkpoint.get("error"),
        checkpoint.get("warning"),
        result.get("error"),
        *result_errors,
    ]
    return "\n".join(
        value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
        for value in values
        if value
    )[:12_000]


def classify_task_attention(
    task: Mapping[str, Any] | None = None,
    *,
    current_time: float | datetime | None = None,
    now_ms: float | None = None,
    queued_seconds: int = QUEUED_STALE_SECONDS,
    running_seconds: int = RUNNING_STALE_SECONDS,
    type_thresholds: Mapping[str, int] | None = None,
) -> dict[str, Any] | None:
    row = _mapping(task)
    status = str(row.get("status") or "").strip().lower()
    if status not in ACTIVE_TASK_STATUSES:
        return None

    text = task_attention_text(row)
    result = _mapping(row.get("result"))
    moderation_detected = (
        result.get("moderationDetected") is True
        or result.get("moderation_detected") is True
        or str(result.get("status") or "").strip().lower() == "removed_by_platform"
        or is_platform_moderation_warning(text)
    )
    if moderation_detected:
        reason = str(
            result.get("moderationReason")
            or result.get("moderation_reason")
            or result.get("error")
            or "平台已移除留言或标记为垃圾信息，账号需要立即冷却并人工检查。"
        ).strip()
        return {
            "code": "platform_moderation_cooldown",
            "reason": reason,
            "source_text": text[:500],
            "stale_for_seconds": 0,
        }
    for code, pattern, reason in _SIGNALS:
        if pattern.search(text):
            return {"code": code, "reason": reason, "source_text": text[:500], "stale_for_seconds": 0}

    activity_at = task_activity_timestamp(row)
    if not activity_at:
        return None
    now = _timestamp(now_ms) if now_ms is not None else _timestamp(
        current_time if current_time is not None else datetime.now(timezone.utc)
    )
    defaults = max(30, int(queued_seconds if status == "queued" else running_seconds))
    task_type = str(row.get("type") or row.get("task_type") or row.get("taskType") or "")
    threshold = max(30, int((_mapping(type_thresholds).get(task_type) or defaults)))
    stale_for_seconds = math.floor(max(0.0, now - activity_at))
    if stale_for_seconds < threshold:
        return None
    return {
        "code": "task_stalled",
        "reason": f"任务已 {stale_for_seconds} 秒没有进度更新，已安全暂停并等待人工检查。",
        "source_text": "",
        "stale_for_seconds": stale_for_seconds,
    }


def manual_attention_for_task(
    task: Mapping[str, Any] | None = None,
    **options: Any,
) -> dict[str, Any] | None:
    row = _mapping(task)
    detected = classify_task_attention(row, **options)
    if detected:
        return detected
    if str(row.get("status") or "").lower() not in {"needs_attention", "paused"}:
        return None
    attention = _mapping(row.get("attention"))
    return {
        "code": str(attention.get("code") or "manual_review_required"),
        "reason": str(attention.get("reason") or row.get("error") or "任务需要人工检查后才能继续。"),
        "source_text": "",
        "stale_for_seconds": int(attention.get("stale_for_seconds") or attention.get("staleForSeconds") or 0),
    }


__all__ = [
    "ACTIVE_TASK_STATUSES",
    "QUEUED_STALE_SECONDS",
    "RUNNING_STALE_SECONDS",
    "classify_task_attention",
    "manual_attention_for_task",
    "task_activity_timestamp",
    "task_attention_text",
]
