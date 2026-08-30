from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import json
import os
import queue
import random
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol
from urllib.parse import quote, quote_plus, urljoin, urlparse


INSTAGRAM_HOME = "https://www.instagram.com/"
INSTAGRAM_LOGIN = "https://www.instagram.com/accounts/login/"
THREADS_HOME = "https://www.threads.net/"
THREADS_LOGIN = "https://www.threads.com/login"
THREADS_POST_SUBMIT_WATCH_SECONDS = 2
DEFAULT_LOGIN_SELF_HEAL_ATTEMPTS = 4
LOGIN_FORM_WAIT_SECONDS = 12
LOGIN_ASSISTANCE_CREDENTIAL_SUBMIT_SETTLE_SECONDS = 6
LOGIN_ASSISTANCE_VERIFICATION_SUBMIT_SETTLE_SECONDS = 6
LOGIN_ASSISTANCE_VERIFICATION_CREDENTIAL_STABLE_SECONDS = 6
DEFAULT_MANUAL_LOGIN_TIMEOUT_SECONDS = 300
MIN_MANUAL_LOGIN_TIMEOUT_SECONDS = 300
MAX_MANUAL_LOGIN_TIMEOUT_SECONDS = 1800
MAX_AUTO_TOTP_ATTEMPTS = 2
AUTO_TOTP_RESULT_WAIT_SECONDS = 20
AUTO_TOTP_MIN_SUBMIT_REMAINING_SECONDS = 3
AUTO_TOTP_CHALLENGE_READY_WAIT_SECONDS = 10
GENERIC_VERIFICATION_CODE_INPUT_SELECTOR = (
    'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])'
    ':not([type="submit"]):not([type="button"]):not([type="password"])'
    ':not([type="email"]):not([autocomplete="username"])'
    ':not([autocomplete="email"]):not([autocomplete="tel"])'
    ':not([autocomplete="current-password"])'
    ':not([name="username"]):not([name="email"]):not([name="phone"])'
    ':not([name="password"]):not([name="pass"])'
)
MAX_WARMUP_LIKES = 16
MAX_WARMUP_COMMENTS = 6
MAX_WARMUP_COMMENT_CHARS = 48
DEFAULT_WARMUP_RESOURCE_COMPACTION_COOLDOWN_SECONDS = 90
DEFAULT_BROWSER_DISK_CACHE_CAPACITY_MB = 64
MIN_BROWSER_DISK_CACHE_CAPACITY_MB = 64
MAX_BROWSER_DISK_CACHE_CAPACITY_MB = 1024
DEFAULT_BROWSER_IMAGE_SURFACE_CACHE_MB = 24
MIN_BROWSER_IMAGE_SURFACE_CACHE_MB = 16
MAX_BROWSER_IMAGE_SURFACE_CACHE_MB = 1024
DEFAULT_BROWSER_MEMORY_CACHE_CAPACITY_MB = 8
DEFAULT_BROWSER_DISK_CHUNK_MEMORY_MB = 8
DEFAULT_BROWSER_MEDIA_MEMORY_CACHE_MB = 16
DEFAULT_BROWSER_MEDIA_COMBINED_CACHE_MB = 32
DEFAULT_BROWSER_MEDIA_DISK_CACHE_MB = 32
DEFAULT_LIGHTWEIGHT_WARMUP_COMPACTION_COOLDOWN_SECONDS = 15
INSTAGRAM_GROUP_TASK_TYPES = {
    "instagram_group_candidates_inspect",
    "instagram_recent_conversations_inspect",
    "instagram_conversation_controls_inspect",
    "instagram_group_create",
    "instagram_group_post",
    "instagram_group_settings_update",
    "instagram_group_members_add",
    "instagram_group_members_inspect",
    "instagram_group_status_inspect",
}
SUPPORTED_TASK_TYPES = {
    "check_login",
    "open_login",
    "browse_feed",
    "browse_profile",
    "instagram_warmup",
    "instagram_auto_reply",
    "instagram_relationship_verify",
    *INSTAGRAM_GROUP_TASK_TYPES,
    "threads_warmup",
    "threads_auto_reply",
    "publish_post",
    "comment_post",
    "reply_comment",
    "like_post",
    "share_post",
    "repost_post",
    "direct_message",
}

_WARMUP_ACTION_HISTORY_LOCK = threading.Lock()
_DEFAULT_LIVE_BROWSER_WIDTH = 1280
_DEFAULT_LIVE_BROWSER_HEIGHT = 720
_DEFAULT_LIVE_BROWSER_CHROME_HEIGHT = 61
_REFERENCE_LIVE_BROWSER_WIDTH = 1920
_REFERENCE_LIVE_BROWSER_HEIGHT = 1080


def _browser_disk_cache_preferences() -> dict[str, Any]:
    try:
        capacity_mb = int(
            str(
                os.getenv(
                    "SOCIAL_AUTOMATION_DISK_CACHE_CAPACITY_MB",
                    DEFAULT_BROWSER_DISK_CACHE_CAPACITY_MB,
                )
            ).strip()
        )
    except (TypeError, ValueError):
        capacity_mb = DEFAULT_BROWSER_DISK_CACHE_CAPACITY_MB
    capacity_mb = max(
        MIN_BROWSER_DISK_CACHE_CAPACITY_MB,
        min(capacity_mb, MAX_BROWSER_DISK_CACHE_CAPACITY_MB),
    )
    return {
        "browser.cache.disk.enable": True,
        "browser.cache.disk.smart_size.enabled": False,
        # Firefox expresses browser.cache.disk.capacity in KiB.
        "browser.cache.disk.capacity": capacity_mb * 1024,
    }


def _conservative_browser_resources_enabled() -> bool:
    return str(
        os.getenv("SOCIAL_AUTOMATION_CONSERVATIVE_BROWSER_RESOURCES", "1") or "1"
    ).strip().lower() not in {"0", "false", "no", "off"}


def _browser_image_surface_cache_mb() -> int:
    try:
        value = int(
            str(
                os.getenv(
                    "SOCIAL_AUTOMATION_IMAGE_SURFACE_CACHE_MB",
                    DEFAULT_BROWSER_IMAGE_SURFACE_CACHE_MB,
                )
            ).strip()
        )
    except (TypeError, ValueError):
        value = DEFAULT_BROWSER_IMAGE_SURFACE_CACHE_MB
    if value <= 0:
        return 0
    return max(
        MIN_BROWSER_IMAGE_SURFACE_CACHE_MB,
        min(value, MAX_BROWSER_IMAGE_SURFACE_CACHE_MB),
    )


def _browser_runtime_preferences(locale: str | None = None) -> dict[str, Any]:
    """Reduce speculative background work without changing rendered content."""
    preferences = _browser_disk_cache_preferences()
    if not _conservative_browser_resources_enabled():
        _apply_network_locale_preferences(preferences, locale)
        return preferences
    preferences.update(
        {
            # Avoid keeping an otherwise idle content process per browser.
            # Firefox still creates the same isolated processes on demand.
            "dom.ipc.processPrelaunch.enabled": False,
            # Each automation profile drives one foreground social site. Keep
            # one shared web process plus Firefox's isolated-site process; four
            # independent browser profiles otherwise duplicate an idle second
            # shared process and its JS/runtime heap.
            "dom.ipc.processCount": 1,
            "dom.ipc.processCount.webIsolated": 1,
            # Xvnc and the live monitor are both capped at 15fps. Matching the
            # page cadence avoids rendering frames that can never be displayed
            # and leaves CPU time for four concurrent Firefox event loops.
            "layout.frame_rate": 15,
            # Keep current responses in the bounded disk cache and prevent the
            # same Threads assets from building a large per-browser RAM cache.
            "browser.cache.memory.enable": True,
            "browser.cache.memory.capacity": DEFAULT_BROWSER_MEMORY_CACHE_CAPACITY_MB * 1024,
            # Firefox otherwise permits two separate 40 MiB disk-cache chunk
            # pools in every browser process. The persistent disk cache remains
            # enabled; only its per-profile RAM staging buffers are bounded.
            "browser.cache.disk.max_chunks_memory_usage": DEFAULT_BROWSER_DISK_CHUNK_MEMORY_MB * 1024,
            "browser.cache.disk.max_priority_chunks_memory_usage": DEFAULT_BROWSER_DISK_CHUNK_MEMORY_MB * 1024,
            "browser.cache.disk.preload_chunk_count": 1,
            # Keep audio/video decoding in Firefox's sandboxed RDD process
            # instead of also starting a separate utility decoder per profile.
            # The startup sanity probe is unnecessary in this software-display
            # environment; real media still starts RDD on demand.
            "media.utility-process.enabled": False,
            "media.sanity-test.disabled": True,
            # Threads feeds can preload multiple videos even when automation
            # only needs text and the composer. Keep media available on user
            # interaction while bounding its per-profile buffers and queues.
            "media.memory_cache_max_size": DEFAULT_BROWSER_MEDIA_MEMORY_CACHE_MB * 1024,
            "media.memory_caches_combined_limit_kb": DEFAULT_BROWSER_MEDIA_COMBINED_CACHE_MB * 1024,
            "media.cache_size": DEFAULT_BROWSER_MEDIA_DISK_CACHE_MB * 1024,
            "media.video-queue.default-size": 3,
            "media.autoplay.default": 5,
            "media.preload.default": 1,
            # Expire non-visible decoded surfaces sooner; visible feed images
            # and manually opened media remain renderable.
            "image.animation_mode": "once",
            "image.mem.surfacecache.min_expiration_ms": 15 * 1000,
            "network.prefetch-next": False,
            "network.predictor.enabled": False,
        }
    )
    surface_cache_mb = _browser_image_surface_cache_mb()
    if surface_cache_mb > 0:
        # This is an eviction ceiling, not an eager allocation. Keep the cap
        # conservative so visible Threads images and publish previews remain
        # smooth while old decoded feed images cannot grow without bound.
        preferences["image.mem.surfacecache.max_size_kb"] = surface_cache_mb * 1024
    _apply_network_locale_preferences(preferences, locale)
    return preferences


def _lightweight_threads_warmup_requested(
    task: dict[str, Any] | None,
    payload: dict[str, Any] | None,
    platform: str,
) -> bool:
    """Use media-light mode only for the conservative Threads browse task."""
    enabled = str(
        os.getenv("SOCIAL_AUTOMATION_LIGHTWEIGHT_THREADS_WARMUP", "1") or "1"
    ).strip().lower() not in {"0", "false", "no", "off"}
    if not enabled or not isinstance(task, dict) or not isinstance(payload, dict):
        return False
    strategy_id = str(payload.get("strategy_id") or "").strip()
    read_only_custom = bool(
        strategy_id == "warmup_custom"
        and _safe_int(payload.get("like_limit"), 0) <= 0
        and _safe_int(payload.get("max_comments"), 0) <= 0
    )
    return bool(
        str(task.get("task_type") or "").strip() == "threads_warmup"
        and str(platform or task.get("platform") or "").strip().lower() == "threads"
        and (strategy_id == "browse_only" or read_only_custom)
    )


class AutomationLogger(Protocol):
    def log(
        self,
        level: str,
        stage: str,
        message: str,
        data: dict[str, Any] | None = None,
        screenshot_path: str = "",
    ) -> None:
        ...


class NeedManualError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: str = "need_verification",
        screenshot_path: str = "",
        health_status: str = "",
    ):
        super().__init__(message)
        self.status = status
        self.screenshot_path = str(screenshot_path or "")
        self.health_status = str(health_status or "")


class AutoLoginFailedError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: str = "cookie_expired",
        screenshot_path: str = "",
        health_status: str = "",
    ):
        super().__init__(message)
        self.status = status
        self.screenshot_path = str(screenshot_path or "")
        self.health_status = str(health_status or "")


class ManualTimeoutError(AutoLoginFailedError):
    def __init__(
        self,
        message: str,
        timeout_kind: str,
        screenshot_path: str = "",
        account_status: str = "cookie_expired",
    ):
        super().__init__(message, account_status, screenshot_path)
        self.timeout_kind = str(timeout_kind or "manual_timeout")
        self.browser_available = False
        self.retryable = True


class PublishOutcomeUnknownError(AutoLoginFailedError):
    def __init__(self, message: str, screenshot_path: str = ""):
        super().__init__(message, "ready", screenshot_path)
        self.publish_submitted = True
        self.publish_outcome_unknown = True
        self.browser_available = False
        self.retryable = False


class ActionOutcomeUnknownError(AutoLoginFailedError):
    """An irreversible non-publish action was submitted but is not confirmed.

    CRM must never retry this condition automatically.  The server-side
    submission guard has already persisted ``submitting``/``submitted`` before
    this exception is raised, so reconciliation can move the action ledger to
    ``unknown`` and retain the billing reservation for evidence review.
    """

    def __init__(self, message: str, screenshot_path: str = ""):
        super().__init__(message, "ready", screenshot_path)
        self.action_submitted = True
        self.action_outcome_unknown = True
        self.browser_available = False
        self.retryable = False


class PublishConfirmationPendingError(RuntimeError):
    def __init__(self, message: str, screenshot_path: str = "", confirmation: dict[str, Any] | None = None):
        super().__init__(message)
        self.screenshot_path = str(screenshot_path or "")
        self.confirmation = dict(confirmation or {})


class PublishClickUncertainError(RuntimeError):
    pass


class UnsupportedActionError(RuntimeError):
    pass


def _live_browser_geometry_config(session: Any) -> dict[str, int]:
    physical_width = max(
        320,
        _safe_int(
            getattr(session, "width", _DEFAULT_LIVE_BROWSER_WIDTH),
            _DEFAULT_LIVE_BROWSER_WIDTH,
        ),
    )
    physical_height = max(
        240,
        _safe_int(
            getattr(session, "height", _DEFAULT_LIVE_BROWSER_HEIGHT),
            _DEFAULT_LIVE_BROWSER_HEIGHT,
        ),
    )
    display_scale = min(
        1.0,
        physical_width / _REFERENCE_LIVE_BROWSER_WIDTH,
        physical_height / _REFERENCE_LIVE_BROWSER_HEIGHT,
    )
    width = round(physical_width / display_scale)
    height = round(physical_height / display_scale)
    chrome_height = _safe_int(
        os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_CHROME_HEIGHT"),
        _DEFAULT_LIVE_BROWSER_CHROME_HEIGHT,
    )
    chrome_height = max(0, min(chrome_height, height - 1))
    content_height = height - chrome_height
    return {
        "screen.width": width,
        "screen.height": height,
        "screen.availWidth": width,
        "screen.availHeight": content_height,
        "window.innerWidth": width,
        "window.innerHeight": content_height,
        "window.outerWidth": width,
        "window.outerHeight": height,
        "window.screenX": 0,
        "window.screenY": 0,
    }


def _live_browser_viewport_size(session: Any) -> dict[str, int]:
    geometry = _live_browser_geometry_config(session)
    return {
        "width": geometry["window.innerWidth"],
        "height": geometry["window.innerHeight"],
    }


def _wait_for_publish_login_transition(
    page,
    task: dict[str, Any],
    payload: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    initial_status: dict[str, Any],
    context_control: dict[str, Any] | None,
) -> dict[str, Any]:
    timeout_seconds = _int_payload_or_env(
        payload,
        "totp_transition_wait_seconds",
        "SOCIAL_AUTOMATION_TOTP_TRANSITION_WAIT_SECONDS",
        30,
        5,
        120,
    )
    deadline = time.monotonic() + timeout_seconds
    current = dict(initial_status or {})
    while time.monotonic() < deadline:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            return {
                "status": "need_verification",
                "reason": "用户已切换为人工接管，自动验证确认已停止。",
            }
        current = _detect_platform_login_state(page, platform)
        if platform == "threads":
            current = _restore_threads_after_instagram_login(page, current, logger)
        if str(current.get("status") or "") == "post_login_interstitial":
            if _resolve_instagram_post_login_interstitial(page, logger):
                if platform == "threads":
                    _goto(page, THREADS_HOME, logger, "threads_post_login_notice_return")
                current = _detect_platform_login_state(page, platform)
        if str(current.get("status") or "") == "ready":
            stable = _confirm_platform_ready(page, platform, logger, cancel_event)
            if str(stable.get("status") or "") == "ready":
                _complete_pending_totp_verification(context_control)
                return _safe_login_status(stable)
            current = stable
        if str(current.get("status") or "") == "invalid_credentials":
            return _safe_login_status(current)
        if not _wait_interruptibly(0.5, cancel_event, context_control):
            return {
                "status": "need_verification",
                "reason": "用户已切换为人工接管，自动验证确认已停止。",
            }
    return {
        "status": "need_verification",
        "reason": str(
            current.get("reason")
            or "2FA 验证已提交，但平台未在等待时间内确认登录，请人工继续处理。"
        ),
        "details": _safe_login_status(current),
    }


def _shared_auto_login_payload(
    payload: dict[str, Any],
    account: dict[str, Any],
) -> dict[str, Any]:
    repair_payload = dict(payload or {})
    repair_payload["auto_submit"] = True
    repair_payload.setdefault(
        "login_username",
        str(account.get("login_username") or account.get("username") or "").strip(),
    )
    saved_password = str(account.get("login_password") or "")
    if saved_password:
        repair_payload.setdefault("login_password", saved_password)
    repair_payload.setdefault(
        "login_wait_seconds",
        _int_payload_or_env({}, "login_wait_seconds", "SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", 3600, 30, 3600),
    )
    repair_payload.setdefault("wait_for_manual", True)
    return repair_payload


def _attempt_publish_login_repair(
    page,
    task: dict[str, Any],
    account: dict[str, Any],
    payload: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    initial_status: dict[str, Any],
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    initial_code = str(initial_status.get("status") or "")
    if initial_code == "invalid_credentials":
        return initial_status
    if initial_code == "need_verification":
        totp_result = _try_auto_totp_challenge(
            page,
            task,
            screenshot_dir,
            logger,
            platform,
            cancel_event,
            context_control,
        )
        if totp_result is None or str(totp_result.get("status") or "") == "need_verification":
            return totp_result or initial_status
        if str(totp_result.get("status") or "") == "ready":
            return totp_result
        if str(totp_result.get("status") or "") == "totp_submitted":
            return totp_result
    if initial_code == "post_login_interstitial":
        _resolve_instagram_post_login_interstitial(page, logger)
    max_repair_attempts = _int_payload_or_env(payload, "publish_login_repair_attempts", "SOCIAL_AUTOMATION_PUBLISH_LOGIN_REPAIR_ATTEMPTS", 3, 0, 8)
    saved_password = str(account.get("login_password") or "")
    if saved_password:
        repair_payload = _shared_auto_login_payload(payload, account)
        try:
            return _run_open_login(
                page,
                task,
                account,
                repair_payload,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                context_control,
            )
        except NeedManualError as exc:
            return {"status": str(exc.status or "need_verification"), "reason": str(exc), "screenshot_path": str(exc.screenshot_path or "")}
    if max_repair_attempts <= 0:
        return initial_status
    logger.log(
        "warn",
        "publish_login_repair",
        f"{_platform_name(platform)} login check failed before task execution; trying automatic recovery before manual handoff.",
        {"status": initial_status, "attempts": max_repair_attempts},
    )
    for attempt in range(1, max_repair_attempts + 1):
        _self_heal_login_page(
            page,
            platform,
            logger,
            task,
            screenshot_dir,
            str(initial_status.get("reason") or "task_login_not_ready"),
            attempt,
            cancel_event,
            context_control,
        )
        current = _detect_platform_login_state(page, platform)
        if str(current.get("status") or "") in {"need_verification", "invalid_credentials"}:
            return current
        if current.get("status") == "ready":
            stable = _confirm_platform_ready(page, platform, logger, cancel_event)
            if stable.get("status") == "ready":
                return stable
        initial_status = current
    return initial_status


def _wait_for_browser_start_barrier(
    context_control: dict[str, Any] | None,
    cancel_event: Any | None,
) -> None:
    callback = (
        context_control.get("browser_start_barrier_callback")
        if isinstance(context_control, dict)
        else None
    )
    if callable(callback):
        callback()
        _raise_if_cancelled(cancel_event)


def run_social_task(
    *,
    task: dict[str, Any],
    account: dict[str, Any],
    proxy: dict[str, Any] | None,
    data_dir: str | Path,
    logger: AutomationLogger,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task_type = str(task.get("task_type") or "").strip()
    if task_type not in SUPPORTED_TASK_TYPES:
        raise UnsupportedActionError(f"不支持的社交自动化任务类型：{task_type}")
    platform = str(task.get("platform") or account.get("platform") or "").strip().lower()
    if platform not in {"instagram", "threads"}:
        raise UnsupportedActionError(f"不支持的平台：{platform}")
    if platform == "instagram" and task_type in {"threads_warmup", "threads_auto_reply"}:
        raise UnsupportedActionError(f"{task_type} 需要使用 Threads 账号。")
    if platform == "threads" and task_type in {"instagram_warmup", "instagram_auto_reply", "instagram_relationship_verify", *INSTAGRAM_GROUP_TASK_TYPES}:
        raise UnsupportedActionError(f"{task_type} 需要使用 Instagram 账号。")
    if platform == "threads" and task_type not in {
        "open_login", "check_login", "browse_feed", "browse_profile",
        "threads_warmup", "threads_auto_reply", "publish_post", "direct_message",
        "comment_post", "reply_comment", "like_post", "share_post", "repost_post",
    }:
        raise UnsupportedActionError(f"{task_type} 尚未支持 Threads Web 自动化。")
    if platform == "instagram" and task_type == "repost_post":
        raise UnsupportedActionError("Instagram Web 不提供真正的转发动作，请改用 share_post/复制链接。")

    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    data_root = Path(data_dir).resolve()
    screenshot_dir = data_root / "social_automation" / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)

    logger.log("info", "prepare", "自动化任务开始执行。", {"task_type": task_type, "platform": platform})
    _raise_if_cancelled(cancel_event)
    with _open_camoufox_context(account=account, proxy=proxy, logger=logger, context_control=context_control) as context:
        page = _first_page(context)
        _install_automation_media_guard(page)
        _import_initial_cookies(context, payload.get("initial_cookies"), platform, logger)
        _sync_live_browser_viewport(page, context_control, logger)
        page.set_default_timeout(int(os.getenv("SOCIAL_AUTOMATION_DEFAULT_TIMEOUT_MS", "30000")))
        defer_matrix_start = (
            platform == "threads"
            and task_type == "publish_post"
            and bool(str(payload.get("matrix_publish_batch_id") or "").strip())
        )
        if not defer_matrix_start:
            _wait_for_browser_start_barrier(context_control, cancel_event)
        if task_type == "open_login":
            return _run_open_login(page, task, account, payload, screenshot_dir, logger, platform, cancel_event, context_control)
        if task_type == "check_login":
            return _run_check_login(page, task, account, payload, screenshot_dir, logger, platform)
        if task_type == "publish_post":
            return _run_publish_task_in_context(
                page,
                task,
                account,
                payload,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                context_control,
                verify_login=True,
            )

        _raise_if_cancelled(cancel_event)
        login = _check_platform_login(page, platform, logger)
        if login.get("status") != "ready":
            login = _attempt_publish_login_repair(
                page,
                task,
                account,
                payload,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                login,
                context_control,
            )
        if login.get("status") == "totp_submitted":
            login = _wait_for_publish_login_transition(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                login,
                context_control,
            )
        if login.get("status") in {"need_verification", "invalid_credentials"}:
            detected_status = str(login.get("status") or "need_verification")
            account_status = "need_verification" if detected_status == "need_verification" else "cookie_expired"
            _report_account_login_status(context_control, account_status, logger)
            _request_manual_takeover(context_control)
            shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
            logger.log(
                "warn",
                "task_login_manual_takeover",
                str(login.get("reason") or f"{_platform_name(platform)} 任务执行前需要人工完成登录验证。"),
                {"details": login, "screenshot_path": shot},
                shot,
            )
            login = _wait_for_manual_login_completion(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                f"{_platform_name(platform)} 任务执行前需要人工验证，完成后系统会继续原任务。",
                detected_status,
                shot,
                login,
                context_control,
            )
            if login.get("status") == "ready":
                _resume_after_manual_takeover(context_control)
        if login.get("status") != "ready":
            shot = _screenshot(page, screenshot_dir, task, "login_not_ready", logger)
            logger.log("warn", "need_manual", str(login.get("reason") or f"{_platform_name(platform)} 账号需要人工登录或验证。"), {"details": login}, shot)
            raise NeedManualError(
                str(login.get("reason") or f"{_platform_name(platform)} 账号需要人工登录或验证。"),
                str(login.get("status") or "need_verification"),
                shot,
            )

        _report_account_login_status(context_control, "ready", logger)

        if task_type == "browse_feed":
            _raise_if_cancelled(cancel_event)
            return _dispatch_browse_feed(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                platform=platform,
            )
        if task_type == "instagram_warmup":
            _raise_if_cancelled(cancel_event)
            return _run_instagram_warmup(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "instagram_auto_reply":
            _raise_if_cancelled(cancel_event)
            return _run_instagram_auto_reply(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                account=account,
                context_control=context_control,
            )
        if task_type == "threads_warmup":
            _raise_if_cancelled(cancel_event)
            return _run_threads_warmup(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "threads_auto_reply":
            _raise_if_cancelled(cancel_event)
            return _run_threads_auto_reply(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                account=account,
                context_control=context_control,
            )
        if task_type == "browse_profile":
            _raise_if_cancelled(cancel_event)
            return _run_browse_profile(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                platform=platform,
            )
        if task_type == "comment_post":
            _raise_if_cancelled(cancel_event)
            return _run_comment_post(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "reply_comment":
            _raise_if_cancelled(cancel_event)
            return _run_reply_comment(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "instagram_relationship_verify":
            _raise_if_cancelled(cancel_event)
            return _run_instagram_relationship_verify(
                page,
                task,
                account,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
            )
        if task_type in INSTAGRAM_GROUP_TASK_TYPES:
            from webapp.crm.instagram_groups import run_instagram_group_task

            return run_instagram_group_task(
                page=page,
                task=task,
                account=account,
                payload=payload,
                screenshot_dir=screenshot_dir,
                logger=logger,
                navigate=_goto,
                screenshot=_screenshot,
                submission_guard=lambda action: _run_billing_commit_action(
                    context_control,
                    cancel_event,
                    action,
                ),
                unknown_error_factory=lambda message, shot: ActionOutcomeUnknownError(message, shot),
                manual_error_factory=lambda message, status, shot: NeedManualError(message, status, shot),
                cancel_check=lambda: _raise_if_cancelled(cancel_event),
            )
        if task_type == "direct_message":
            _raise_if_cancelled(cancel_event)
            return _run_direct_message(
                page,
                task,
                account,
                payload,
                screenshot_dir,
                logger,
                platform=platform,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "like_post":
            _raise_if_cancelled(cancel_event)
            return _run_like_post(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "share_post":
            _raise_if_cancelled(cancel_event)
            return _run_share_post(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
        if task_type == "repost_post":
            _raise_if_cancelled(cancel_event)
            return _run_repost_post(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                cancel_event=cancel_event,
                context_control=context_control,
            )
    raise UnsupportedActionError(f"未处理的社交自动化任务类型：{task_type}")


def run_social_publish_batch(
    *,
    tasks: list[dict[str, Any]],
    account: dict[str, Any],
    proxy: dict[str, Any] | None,
    data_dir: str | Path,
    loggers: list[AutomationLogger],
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not tasks:
        return []
    if len(tasks) != len(loggers):
        raise ValueError("Publish batch tasks and loggers must have the same length.")
    platform = str(tasks[0].get("platform") or account.get("platform") or "").strip().lower()
    if platform not in {"instagram", "threads"}:
        raise UnsupportedActionError(f"Unsupported platform: {platform}")
    for task in tasks:
        if str(task.get("task_type") or "").strip() != "publish_post":
            raise UnsupportedActionError("Only publish_post tasks can share a publish browser batch.")
        task_platform = str(task.get("platform") or account.get("platform") or "").strip().lower()
        if task_platform != platform:
            raise UnsupportedActionError("Publish batch tasks must use one platform.")

    data_root = Path(data_dir).resolve()
    screenshot_dir = data_root / "social_automation" / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    first_payload = tasks[0].get("payload") if isinstance(tasks[0].get("payload"), dict) else {}
    results: list[dict[str, Any]] = []
    if platform == "threads" and isinstance(context_control, dict):
        context_control["threads_publish_session_permalinks"] = set()
    with _open_camoufox_context(
        account=account,
        proxy=proxy,
        logger=loggers[0],
        context_control=context_control,
    ) as context:
        page = _first_page(context)
        _install_automation_media_guard(page)
        _import_initial_cookies(context, first_payload.get("initial_cookies"), platform, loggers[0])
        _sync_live_browser_viewport(page, context_control, loggers[0])
        page.set_default_timeout(int(os.getenv("SOCIAL_AUTOMATION_DEFAULT_TIMEOUT_MS", "30000")))
        _wait_for_browser_start_barrier(context_control, cancel_event)
        for index, (task, logger) in enumerate(zip(tasks, loggers)):
            payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
            try:
                if isinstance(context_control, dict):
                    context_control["task"] = dict(task)
                    context_control["current_task_id"] = str(task.get("id") or "")
                started_callback = (
                    context_control.get("batch_item_started_callback")
                    if isinstance(context_control, dict)
                    else None
                )
                if callable(started_callback):
                    started_callback(task, index + 1, len(tasks))
                logger.log(
                    "info",
                    "prepare",
                    "Publish batch task started.",
                    {
                        "task_type": "publish_post",
                        "platform": platform,
                        "publish_sequence_index": index + 1,
                        "publish_sequence_total": len(tasks),
                    },
                )
                _raise_if_cancelled(cancel_event)
                result = _run_publish_task_in_context(
                    page,
                    task,
                    account,
                    payload,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    context_control,
                    verify_login=index == 0,
                )
                completed_callback = (
                    context_control.get("batch_item_completed_callback")
                    if isinstance(context_control, dict)
                    else None
                )
                if callable(completed_callback):
                    completion_persisted = completed_callback(task, result, index + 1, len(tasks))
                    if completion_persisted is False:
                        raise RuntimeError("The completed publish item could not be persisted; the batch was stopped.")
                _resolve_completed_manual_takeover(context_control)
            except BaseException as exc:
                setattr(exc, "completed_batch_results", list(results))
                setattr(exc, "failed_batch_task_id", str(task.get("id") or ""))
                raise
            results.append({"task_id": str(task.get("id") or ""), "result": result})
            if isinstance(context_control, dict):
                context_control["completed_batch_task_ids"] = [
                    str(item.get("task_id") or "")
                    for item in results
                    if str(item.get("task_id") or "")
                ]
    return results


def _run_publish_task_in_context(
    page: Any,
    task: dict[str, Any],
    account: dict[str, Any],
    payload: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
    *,
    verify_login: bool,
) -> dict[str, Any]:
    _set_task_assistance(
        context_control,
        title="正在准备发布",
        message="正在检查账号登录状态，通过后会自动撰写并发布。",
        content=_task_assistance_caption(task, payload),
    )
    if verify_login:
        login = _check_platform_login(page, platform, logger)
        if login.get("status") != "ready":
            login = _attempt_publish_login_repair(
                page,
                task,
                account,
                payload,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                login,
                context_control,
            )
        if login.get("status") == "totp_submitted":
            login = _wait_for_publish_login_transition(
                page,
                task,
                payload,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                login,
                context_control,
            )
        if login.get("status") in {"need_verification", "invalid_credentials"}:
            detected_status = str(login.get("status") or "need_verification")
            account_status = "need_verification" if detected_status == "need_verification" else "cookie_expired"
            _report_account_login_status(context_control, account_status, logger)
            _request_manual_takeover(context_control)
            shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
            login = _wait_for_manual_login_completion(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                str(login.get("reason") or f"{_platform_name(platform)} requires login verification before publishing."),
                detected_status,
                shot,
                login,
                context_control,
            )
            if login.get("status") == "ready":
                _resume_after_manual_takeover(context_control)
        if login.get("status") != "ready":
            shot = _screenshot(page, screenshot_dir, task, "login_not_ready", logger)
            reason = str(login.get("reason") or f"{_platform_name(platform)} 账号登录未完成，无法继续发布。")
            _set_task_assistance(
                context_control,
                phase="error",
                kind="error",
                title="发布前登录未完成",
                message=reason,
                screenshot_path=shot,
            )
            raise AutoLoginFailedError(
                reason,
                str(login.get("status") or "need_verification"),
                shot,
            )
        _report_account_login_status(context_control, "ready", logger)

    _set_task_assistance(
        context_control,
        title="正在撰写发布内容",
        message="账号已就绪，正在打开发布页并填写内容。",
        content=_task_assistance_caption(task, payload),
    )
    _raise_if_cancelled(cancel_event)
    result = _run_publish_post(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform,
        account=account,
        cancel_event=cancel_event,
        context_control=context_control,
    )
    if isinstance(result, dict) and result.get("ok"):
        permalink = str(result.get("url") or result.get("permalink") or "").strip()
        _set_task_assistance(
            context_control,
            phase="success",
            kind="success",
            title="发布成功",
            message="帖子已发布，可在助手中查看截图和链接。",
            content=_task_assistance_caption(task, payload),
            permalink=permalink,
            screenshot_path=str(result.get("screenshot_path") or ""),
        )
    return result


def _report_account_login_status(
    context_control: dict[str, Any] | None,
    status: str,
    logger: AutomationLogger,
) -> None:
    if not isinstance(context_control, dict):
        return
    callback = context_control.get("account_login_status_callback")
    if not callable(callback):
        return
    try:
        clean_status = str(status or "").strip().lower()
        # The persistence layer uses disabled + banned health for a platform
        # ban; never let an out-of-vocabulary banned callback be dropped.
        callback("disabled" if clean_status == "banned" else clean_status)
    except Exception as exc:
        logger.log(
            "warn",
            "account_login_status_sync_failed",
            "Account login status was detected but could not be synchronized immediately.",
            {"status": str(status or ""), "error": str(exc)},
        )


def _persist_publish_confirmation_context(
    context_control: dict[str, Any] | None,
    confirmation: dict[str, Any],
    logger: AutomationLogger,
) -> None:
    if not isinstance(context_control, dict):
        return
    callback = context_control.get("publish_confirmation_callback")
    if not callable(callback):
        return
    try:
        persisted = callback(dict(confirmation))
    except Exception as exc:
        logger.log("error", "threads_publish_confirmation_persist_failed", "发布前无法保存确认上下文，已停止且未点击发布。", {"error": str(exc)[:500]})
        raise RuntimeError("Unable to persist Threads publish confirmation context before submit.") from exc
    if persisted is False:
        raise RuntimeError("Unable to persist Threads publish confirmation context before submit.")


class _BrowserContextManager:
    def __init__(self, account: dict[str, Any], proxy: dict[str, Any] | None, logger: AutomationLogger, context_control: dict[str, Any] | None = None):
        self.account = account
        self.proxy = proxy
        self.logger = logger
        self.context_control = context_control
        self.cm = None
        self.context = None
        self.live_session = None

    def _cancel_event(self) -> Any | None:
        if self.context_control is None:
            return None
        return self.context_control.get("cancel_event")

    def _cancel_requested(self) -> bool:
        cancel_event = self._cancel_event()
        return bool(cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)())

    def _raise_if_cancelled_before_launch(self) -> None:
        _raise_if_cancelled(self._cancel_event())

    def __enter__(self):
        from .browser_runtime import verify_pinned_browser_runtime

        self._raise_if_cancelled_before_launch()
        runtime_versions = verify_pinned_browser_runtime()
        self._raise_if_cancelled_before_launch()
        try:
            from camoufox.sync_api import Camoufox
        except Exception as exc:
            raise RuntimeError(
                "Camoufox 未安装，请从项目锁定依赖恢复受管浏览器运行环境，禁止直接安装最新版。"
            ) from exc

        profile_dir = Path(str(self.account.get("profile_dir") or "")).expanduser().resolve()
        profile_dir.mkdir(parents=True, exist_ok=True)
        _cleanup_stale_profile_locks(profile_dir, self.logger)
        proxy_config = _proxy_config(self.proxy)
        proxy_locale = _current_network_locale(self.proxy)
        self.live_session = self._start_live_browser_session()
        try:
            self._raise_if_cancelled_before_launch()
        except Exception:
            self._stop_live_browser_session()
            raise
        headless: bool | str = False
        if self.live_session is None and os.name != "nt" and str(os.getenv("SOCIAL_AUTOMATION_HEADLESS") or "").strip().lower() == "virtual":
            headless = "virtual"
        kwargs: dict[str, Any] = {
            "persistent_context": True,
            "user_data_dir": str(profile_dir),
            "headless": headless,
            "humanize": float(os.getenv("SOCIAL_AUTOMATION_HUMANIZE_MAX_SECONDS", "0.5")),
            "firefox_user_prefs": _browser_runtime_preferences(proxy_locale),
        }
        if self.live_session is not None:
            geometry_config = _live_browser_geometry_config(self.live_session)
            # Camoufox beta.28 randomizes both its screen fingerprint and inner
            # viewport. Pin both to the real Xvnc framebuffer so automation,
            # remote monitoring, and the reported fingerprint share one frame.
            kwargs["window"] = (
                geometry_config["window.outerWidth"],
                geometry_config["window.outerHeight"],
            )
            kwargs["viewport"] = {
                "width": geometry_config["window.innerWidth"],
                "height": geometry_config["window.innerHeight"],
            }
            kwargs["config"] = geometry_config
            kwargs["i_know_what_im_doing"] = True
            display_scale = min(
                float(getattr(self.live_session, "width", _DEFAULT_LIVE_BROWSER_WIDTH))
                / geometry_config["window.outerWidth"],
                float(getattr(self.live_session, "height", _DEFAULT_LIVE_BROWSER_HEIGHT))
                / geometry_config["window.outerHeight"],
            )
            if display_scale < 0.999:
                kwargs["firefox_user_prefs"]["layout.css.devPixelsPerPx"] = (
                    f"{display_scale:.4f}".rstrip("0").rstrip(".")
                )
            if self.context_control is not None:
                self.context_control["live_browser_window_width"] = geometry_config["window.outerWidth"]
                self.context_control["live_browser_window_height"] = geometry_config["window.outerHeight"]
                self.context_control["live_browser_chrome_reserve_height"] = (
                    geometry_config["window.outerHeight"] - geometry_config["window.innerHeight"]
                )
        kwargs["geoip"] = True
        if proxy_config:
            kwargs["proxy"] = proxy_config
        if proxy_locale:
            kwargs["locale"] = proxy_locale
        try:
            self._raise_if_cancelled_before_launch()
        except Exception:
            self._stop_live_browser_session()
            raise
        self.logger.log(
            "info",
            "browser_launch",
            "正在启动 Camoufox 指纹浏览器环境。",
            {
                "profile_dir": str(profile_dir),
                "proxy": _masked_proxy(proxy_config),
                "locale": proxy_locale or "",
                "headless": headless,
                "runtime_versions": runtime_versions,
            },
        )
        try:
            self._enter_camoufox(Camoufox, kwargs)
        except Exception as exc:
            with contextlib.suppress(Exception):
                if self.cm:
                    self.cm.__exit__(type(exc), exc, getattr(exc, "__traceback__", None))
            if self._cancel_requested():
                self._stop_live_browser_session()
                self._raise_if_cancelled_before_launch()
            if _should_rebuild_profile_after_launch_error(exc):
                backup_dir = _quarantine_profile_dir(profile_dir, self.logger)
                if backup_dir:
                    profile_dir.mkdir(parents=True, exist_ok=True)
                    self.logger.log(
                        "warn",
                        "profile_rebuild_retry",
                        "浏览器配置启动失败，已备份失效配置并使用干净配置重试。",
                        {"backup_dir": str(backup_dir), "profile_dir": str(profile_dir)},
                    )
                    try:
                        self._enter_camoufox(Camoufox, kwargs)
                        return self.context
                    except Exception as retry_exc:
                        with contextlib.suppress(Exception):
                            if self.cm:
                                self.cm.__exit__(type(retry_exc), retry_exc, getattr(retry_exc, "__traceback__", None))
                        exc = retry_exc
            safe_error = _redact_proxy_error(exc, proxy_config)
            self._stop_live_browser_session()
            raise RuntimeError(
                "Camoufox 浏览器启动失败。请从项目锁定依赖和服务器浏览器构建备份恢复，"
                "禁止直接下载或升级浏览器版本。"
                f"原始错误：{safe_error}"
            ) from None
        return self.context

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None and self._retain_live_browser_after_finish() and self._detach_live_browser_for_standby():
            return None
        if self.context_control is not None:
            self.context_control["context"] = None
            self.context_control["manager"] = None
            self.context_control["live_browser_session_id"] = ""
        if self.cm:
            try:
                return self.cm.__exit__(exc_type, exc, tb)
            finally:
                self._stop_live_browser_session()
        self._stop_live_browser_session()
        return None

    def _retain_live_browser_after_finish(self) -> bool:
        task = {}
        if self.context_control is not None and isinstance(self.context_control.get("task"), dict):
            task = self.context_control.get("task") or {}
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        return bool(payload.get("retain_live_browser_after_finish"))

    def _detach_live_browser_for_standby(self) -> bool:
        if self.live_session is None or self.context is None:
            return False
        task = {}
        if self.context_control is not None and isinstance(self.context_control.get("task"), dict):
            task = dict(self.context_control.get("task") or {})
        payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
        standby_seconds = _safe_int_env_or_payload(payload, "live_browser_standby_seconds", "SOCIAL_AUTOMATION_LIVE_BROWSER_STANDBY_SECONDS", 60)
        auto_close_seconds = _safe_int_env_or_payload(payload, "live_browser_auto_close_seconds", "SOCIAL_AUTOMATION_LIVE_BROWSER_AUTO_CLOSE_SECONDS", 300)
        standby_seconds = max(0, min(standby_seconds, 3600))
        auto_close_seconds = max(10, min(auto_close_seconds, 24 * 3600))
        close_delay = standby_seconds + auto_close_seconds
        session_id = str(getattr(self.live_session, "id", "") or "")
        if not session_id:
            return False

        context = self.context
        cm = self.cm
        live_session = self.live_session
        closed = threading.Event()

        def close_live_browser() -> None:
            if closed.is_set():
                return
            closed.set()
            with contextlib.suppress(Exception):
                context.close()
            with contextlib.suppress(Exception):
                if cm:
                    cm.__exit__(None, None, None)

        try:
            from social_automation.live_browser import mark_live_browser_session_standby, register_live_browser_close_callback, stop_live_browser_session

            close_at = int(time.time()) + close_delay
            mark_live_browser_session_standby(session_id, close_at=close_at)
            register_live_browser_close_callback(session_id, close_live_browser)
            self.logger.log(
                "info",
                "live_browser_standby",
                "实时浏览器已进入待机，可手动关闭或等待系统自动关闭。",
                {"session_id": session_id, "standby_seconds": standby_seconds, "auto_close_seconds": auto_close_seconds, "close_at": close_at},
            )

            def auto_close() -> None:
                time.sleep(close_delay)
                stop_live_browser_session(session_id, session=live_session)

            threading.Thread(target=auto_close, name=f"live-browser-standby-{session_id}", daemon=True).start()
        except Exception as detach_exc:
            self.logger.log("warn", "live_browser_standby_failed", "实时浏览器进入待机失败，已按正常流程关闭。", {"error": str(detach_exc)})
            return False

        if self.context_control is not None:
            self.context_control["context"] = None
            self.context_control["manager"] = None
            self.context_control["live_browser_session_id"] = session_id
        self.context = None
        self.cm = None
        self.live_session = None
        return True

    def _enter_camoufox(self, Camoufox: Any, kwargs: dict[str, Any]) -> None:
        launch_kwargs = dict(kwargs)
        if self.live_session is not None:
            # Camoufox passes this environment directly to the Firefox child.
            # Keeping DISPLAY launch-local lets independent Xvnc sessions start
            # concurrently without mutating the worker process environment.
            launch_env = dict(os.environ)
            launch_env.update(dict(launch_kwargs.get("env") or {}))
            launch_env["DISPLAY"] = str(self.live_session.display)
            launch_kwargs["env"] = launch_env
        self.cm = Camoufox(**launch_kwargs)
        self.context = self.cm.__enter__()
        if self.live_session is not None and self.context is not None:
            live_display = str(self.live_session.display)
            # Keep the X display on the corresponding BrowserContext for
            # xdotool operations after the browser has started.
            with contextlib.suppress(Exception):
                setattr(self.context, "_tg_live_display", live_display)
                setattr(self.context, "_tg_live_width", int(self.live_session.width))
                setattr(self.context, "_tg_live_height", int(self.live_session.height))
            if self.context_control is not None:
                self.context_control["live_browser_display"] = live_display
        if self.context_control is not None:
            self.context_control["context"] = self.context
            self.context_control["manager"] = self.cm
            self.context_control["live_browser_session_id"] = str(getattr(self.live_session, "id", "") or "")
        if self.live_session is not None:
            from social_automation.live_browser import mark_live_browser_session_ready

            mark_live_browser_session_ready(str(self.live_session.id))
            self.logger.log(
                "info",
                "browser_ready",
                "Camoufox 指纹浏览器已启动，可以显示实时画面。",
                {"session_id": str(self.live_session.id)},
            )

    def _start_live_browser_session(self) -> Any | None:
        try:
            from social_automation.live_browser import start_live_browser_session

            self._raise_if_cancelled_before_launch()
            task = {}
            if self.context_control is not None and isinstance(self.context_control.get("task"), dict):
                task = dict(self.context_control.get("task") or {})
            session = start_live_browser_session(task=task, account=self.account, logger=self.logger)
            if self._cancel_requested():
                if session is not None:
                    with contextlib.suppress(Exception):
                        from social_automation.live_browser import stop_live_browser_session

                        stop_live_browser_session(str(session.id), session=session)
                self._raise_if_cancelled_before_launch()
            if session is not None and self.context_control is not None:
                self.context_control["live_browser_session_id"] = str(session.id)
                self.context_control["live_browser_width"] = int(getattr(session, "width", 0) or 0)
                self.context_control["live_browser_height"] = int(getattr(session, "height", 0) or 0)
            return session
        except Exception as exc:
            if self._cancel_requested():
                raise
            self.logger.log("warn", "live_browser_error", "实时浏览器监控初始化失败，将在无监控窗口模式下继续执行。", {"error": str(exc)})
            return None

    def _stop_live_browser_session(self) -> None:
        if self.live_session is None:
            return
        try:
            from social_automation.live_browser import stop_live_browser_session

            stop_live_browser_session(str(self.live_session.id))
        except Exception:
            pass
        self.live_session = None


def _open_camoufox_context(account: dict[str, Any], proxy: dict[str, Any] | None, logger: AutomationLogger, context_control: dict[str, Any] | None = None):
    return _BrowserContextManager(account, proxy, logger, context_control)


def _cleanup_stale_profile_locks(profile_dir: Path, logger: AutomationLogger) -> None:
    removed: list[str] = []
    for name in ("parent.lock", ".parentlock", "lock", ".startup-incomplete"):
        path = profile_dir / name
        if not path.exists():
            continue
        try:
            age_seconds = max(0.0, time.time() - path.stat().st_mtime)
        except Exception:
            age_seconds = 0.0
        if name != ".startup-incomplete" or age_seconds < 600:
            logger.log(
                "warn",
                "profile_lock_present",
                "检测到浏览器配置锁；为保护当前登录会话，未自动删除。",
                {"path": str(path), "age_seconds": round(age_seconds, 1)},
            )
            continue
        try:
            path.unlink()
            removed.append(name)
        except PermissionError:
            logger.log("warn", "profile_lock_active", "浏览器配置锁仍在使用，可能还有其他浏览器窗口未关闭。", {"path": str(path)})
        except Exception as exc:
            logger.log("warn", "profile_lock_cleanup_failed", "清理失效的浏览器配置锁失败。", {"path": str(path), "error": str(exc)})
    if removed:
        logger.log("info", "profile_lock_cleanup", "已清理失效的浏览器配置锁文件。", {"files": removed})


def _should_rebuild_profile_after_launch_error(exc: Exception) -> bool:
    text = str(exc).lower()
    # A generic launch timeout can be caused by a slow X11/browser startup and
    # is not evidence that the persistent profile is corrupt. Rebuilding on a
    # timeout silently replaces a valid logged-in profile with an empty one.
    corruption_markers = (
        "profile is corrupt",
        "profile cannot be loaded",
        "corrupt profile",
        "invalid profile",
    )
    return any(marker in text for marker in corruption_markers)


def _quarantine_profile_dir(profile_dir: Path, logger: AutomationLogger) -> Path | None:
    if not profile_dir.exists():
        return None
    backup = profile_dir.with_name(f"{profile_dir.name}.broken_{int(time.time())}")
    try:
        profile_dir.rename(backup)
        return backup
    except Exception as exc:
        logger.log("warn", "profile_rebuild_failed", "备份失效的浏览器配置失败。", {"profile_dir": str(profile_dir), "error": str(exc)})
        return None


def _raise_if_cancelled(cancel_event: Any | None) -> None:
    if cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)():
        raise RuntimeError("社交自动化任务已取消。")


def _run_publish_submit_action(
    context_control: dict[str, Any] | None,
    cancel_event: Any | None,
    action: Callable[[], Any],
) -> Any:
    """Run the irreversible publish click under the server-owned cancellation guard."""
    _raise_if_cancelled(cancel_event)
    callback = context_control.get("publish_submit_callback") if isinstance(context_control, dict) else None
    if callable(callback):
        return callback(action)
    return action()


def _run_billing_commit_action(
    context_control: dict[str, Any] | None,
    cancel_event: Any | None,
    action: Callable[[], Any],
) -> Any:
    """Run an irreversible billed interaction under the cancellation guard."""
    _raise_if_cancelled(cancel_event)
    callback = context_control.get("billing_submit_callback") if isinstance(context_control, dict) else None
    if callable(callback):
        return callback(action)
    return action()


def _run_matrix_resource_phase(
    context_control: dict[str, Any] | None,
    cancel_event: Any | None,
    phase: str,
    action: Callable[[], Any],
) -> Any:
    _raise_if_cancelled(cancel_event)
    callback = context_control.get("matrix_resource_phase_callback") if isinstance(context_control, dict) else None
    if callable(callback):
        return callback(phase, action)
    return action()


def _manual_takeover_event(context_control: dict[str, Any] | None) -> Any | None:
    if not isinstance(context_control, dict):
        return None
    return context_control.get("manual_takeover_event")


def _set_manual_takeover_waiting_for(
    context_control: dict[str, Any] | None,
    checkpoint: str,
) -> None:
    if isinstance(context_control, dict):
        context_control["takeover_waiting_for"] = str(checkpoint or "").strip()


def _request_manual_takeover(context_control: dict[str, Any] | None) -> None:
    event = _manual_takeover_event(context_control)
    if event is not None:
        event.set()
    _acknowledge_manual_takeover(context_control)


def _run_manual_transition_callback(context_control: dict[str, Any], key: str, action: str) -> None:
    callback = context_control.get(key)
    if not callable(callback):
        return
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            if callback() is not False:
                return
            last_error = RuntimeError(f"{action}未写入任务状态")
        except Exception as exc:
            last_error = exc
        if attempt < 2:
            time.sleep(0.1 * (attempt + 1))
    raise RuntimeError(f"{action}失败，已停止继续操作：{last_error}") from last_error


def _acknowledge_manual_takeover(context_control: dict[str, Any] | None) -> None:
    if isinstance(context_control, dict):
        _run_manual_transition_callback(context_control, "manual_takeover_callback", "人工接管状态持久化")
        _set_manual_takeover_waiting_for(context_control, "manual_ready")
        ack_event = context_control.get("manual_takeover_ack_event")
        if ack_event is not None:
            ack_event.set()


def _manual_takeover_requested(context_control: dict[str, Any] | None) -> bool:
    event = _manual_takeover_event(context_control)
    requested = bool(event is not None and getattr(event, "is_set", lambda: False)())
    if requested:
        _acknowledge_manual_takeover(context_control)
    return requested


def _resume_after_manual_takeover(context_control: dict[str, Any] | None) -> None:
    if not isinstance(context_control, dict):
        return
    _run_manual_transition_callback(context_control, "manual_takeover_resolved_callback", "人工验证恢复状态持久化")
    _set_manual_takeover_waiting_for(context_control, "next_safe_checkpoint")
    for key in ("manual_takeover_event", "manual_takeover_ack_event", "manual_takeover_timeout_event"):
        event = context_control.get(key)
        if event is not None:
            with contextlib.suppress(Exception):
                event.clear()


def _resolve_completed_manual_takeover(context_control: dict[str, Any] | None) -> None:
    event = _manual_takeover_event(context_control)
    if event is None or not getattr(event, "is_set", lambda: False)():
        return
    ack_event = context_control.get("manual_takeover_ack_event") if isinstance(context_control, dict) else None
    if ack_event is None or not getattr(ack_event, "is_set", lambda: False)():
        _acknowledge_manual_takeover(context_control)
    _resume_after_manual_takeover(context_control)


def _safe_int_env_or_payload(payload: dict[str, Any], key: str, env_key: str, fallback: int) -> int:
    raw = payload.get(key)
    if raw is None or raw == "":
        raw = os.getenv(env_key)
    try:
        return int(raw)
    except Exception:
        return int(fallback)


def _proxy_config(proxy: dict[str, Any] | None) -> dict[str, str] | None:
    if not proxy:
        return None
    host = str(proxy.get("host") or "").strip()
    port = int(proxy.get("port") or 0)
    if not host or port <= 0:
        return None
    proxy_type = str(proxy.get("proxy_type") or "http").strip().lower()
    if proxy_type not in {"http", "https", "socks5"}:
        proxy_type = "http"
    username = str(proxy.get("username") or "").strip()
    password = str(proxy.get("password") or "").strip()
    is_marketplace_proxy = bool(
        str(proxy.get("source") or "").strip().lower() == "marketplace"
        or str(proxy.get("market_item_id") or "").strip()
    )
    browser_proxy_type = "http" if proxy_type == "socks5" and username and is_marketplace_proxy else proxy_type
    config = {"server": f"{browser_proxy_type}://{host}:{port}"}
    if username:
        config["username"] = username
        config["password"] = password
    return config


def _proxy_locale(proxy: dict[str, Any] | None) -> str | None:
    """Return the current proxy territory so Camoufox refreshes its locale."""
    if not proxy:
        return None

    candidates: list[Any] = []
    last_check = proxy.get("last_check_result") or proxy.get("last_check_result_json")
    if isinstance(last_check, str) and last_check.strip():
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            last_check = json.loads(last_check)
    if isinstance(last_check, dict):
        for section in (last_check.get("response"), last_check.get("detected"), last_check):
            if isinstance(section, dict):
                candidates.extend((section.get("country_code"), section.get("countryCode")))
    candidates.extend((proxy.get("country_code"), proxy.get("countryCode"), proxy.get("country")))

    aliases = {
        "TAIWAN": "TW",
        "中国台湾": "TW",
        "中國台灣": "TW",
        "台灣": "TW",
    }
    for candidate in candidates:
        value = str(candidate or "").strip()
        if not value:
            continue
        normalized = aliases.get(value.upper(), value.upper())
        if len(normalized) == 2 and normalized.isalpha():
            return normalized
    return None


_NETWORK_LOCALE_CACHE_LOCK = threading.Lock()
_NETWORK_LOCALE_CACHE: dict[str, tuple[float, str]] = {}
_NETWORK_LOCALE_CACHE_TTL_SECONDS = 45
_COUNTRY_ACCEPT_LANGUAGES = {
    "TW": "zh-TW,zh,en-US,en",
    "HK": "zh-HK,zh-TW,zh,en-US,en",
    "CN": "zh-CN,zh,en-US,en",
    "MO": "zh-MO,zh-TW,zh,en-US,en",
    "JP": "ja,en-US,en",
    "KR": "ko,en-US,en",
    "PT": "pt-PT,pt,en-US,en",
    "BR": "pt-BR,pt,en-US,en",
    "ES": "es-ES,es,en-US,en",
    "MX": "es-MX,es,en-US,en",
    "US": "en-US,en",
    "GB": "en-GB,en-US,en",
    "DE": "de,en-US,en",
    "FR": "fr,en-US,en",
    "IT": "it,en-US,en",
    "TH": "th,en-US,en",
    "VN": "vi,en-US,en",
    "ID": "id,en-US,en",
    "MY": "ms,en-US,en",
}


def _normalize_country_code(value: Any) -> str | None:
    text = str(value or "").strip().upper()
    aliases = {
        "TAIWAN": "TW",
        "中国台湾": "TW",
        "中國台灣": "TW",
        "台灣": "TW",
        "台湾": "TW",
        "JAPAN": "JP",
        "KOREA": "KR",
        "PORTUGAL": "PT",
        "UNITED STATES": "US",
        "USA": "US",
        "HONG KONG": "HK",
    }
    normalized = aliases.get(text, text)
    if len(normalized) == 2 and normalized.isalpha():
        return normalized
    return None


def _network_locale_cache_key(proxy: dict[str, Any] | None) -> str:
    if not proxy:
        return "direct"
    return "|".join(
        (
            str(proxy.get("host") or "").strip().lower(),
            str(proxy.get("port") or "").strip(),
            str(proxy.get("username") or "").strip(),
            str((proxy.get("source") or "")).strip().lower(),
        )
    )


def _live_exit_ip(proxy: dict[str, Any] | None) -> str | None:
    request = urllib.request.Request(
        "https://api.ipify.org?format=json",
        headers={"User-Agent": "Vecto-Locale-Probe/1.0"},
    )
    opener = urllib.request.build_opener()
    if proxy:
        config = _proxy_config(proxy)
        server = str((config or {}).get("server") or "")
        if not server.startswith(("http://", "https://")):
            return None
        parsed = urlparse(server)
        username = str((config or {}).get("username") or "")
        password = str((config or {}).get("password") or "")
        auth = ""
        if username or password:
            auth = f"{quote(username, safe='')}:{quote(password, safe='')}@"
        proxy_url = f"{parsed.scheme}://{auth}{parsed.hostname}:{parsed.port}"
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        )
    try:
        with opener.open(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
        ip_text = str((payload or {}).get("ip") or "").strip()
        ipaddress.ip_address(ip_text)
        return ip_text
    except Exception:
        return None


def _lookup_ip_country(ip_text: str) -> str | None:
    ip_value = str(ip_text or "").strip()
    if not ip_value:
        return None
    request = urllib.request.Request(
        f"http://ip-api.com/json/{quote(ip_value, safe='.')}?fields=status,countryCode",
        headers={"User-Agent": "Vecto-Locale-Probe/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
        if str((payload or {}).get("status") or "").strip().lower() != "success":
            return None
        return _normalize_country_code((payload or {}).get("countryCode"))
    except Exception:
        return None


def _cached_exit_ip(proxy: dict[str, Any] | None) -> str | None:
    if not proxy:
        return None
    last_check = proxy.get("last_check_result") or proxy.get("last_check_result_json")
    if isinstance(last_check, str) and last_check.strip():
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            last_check = json.loads(last_check)
    candidates: list[Any] = []
    if isinstance(last_check, dict):
        for section in (last_check.get("response"), last_check.get("detected"), last_check):
            if isinstance(section, dict):
                candidates.extend((section.get("exit_ip"), section.get("ip")))
    candidates.append(proxy.get("exit_ip"))
    for candidate in candidates:
        ip_text = str(candidate or "").strip()
        if not ip_text:
            continue
        try:
            ipaddress.ip_address(ip_text)
        except ValueError:
            continue
        return ip_text
    return None


def _live_network_locale(proxy: dict[str, Any] | None) -> str | None:
    if str(os.getenv("SOCIAL_AUTOMATION_SKIP_LIVE_LOCALE") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return None
    exit_ip = _cached_exit_ip(proxy) or _live_exit_ip(proxy)
    if not exit_ip:
        return None
    return _lookup_ip_country(exit_ip)


def _current_network_locale(proxy: dict[str, Any] | None) -> str | None:
    """Resolve the locale from the current exit IP, never a leftover proxy country."""
    cache_key = _network_locale_cache_key(proxy)
    now = time.monotonic()
    with _NETWORK_LOCALE_CACHE_LOCK:
        cached = _NETWORK_LOCALE_CACHE.get(cache_key)
        if cached and now - cached[0] < _NETWORK_LOCALE_CACHE_TTL_SECONDS:
            return cached[1]
    live = _live_network_locale(proxy)
    if live:
        with _NETWORK_LOCALE_CACHE_LOCK:
            _NETWORK_LOCALE_CACHE[cache_key] = (now, live)
        return live
    return _proxy_locale(proxy) if proxy else None


def _apply_network_locale_preferences(preferences: dict[str, Any], locale: str | None) -> None:
    country = _normalize_country_code(locale)
    if not country:
        return
    languages = _COUNTRY_ACCEPT_LANGUAGES.get(country) or "en-US,en"
    preferences["intl.accept_languages"] = languages
    preferences["intl.locale.requested"] = country.lower()


def _masked_proxy(proxy_config: dict[str, str] | None) -> dict[str, str]:
    if not proxy_config:
        return {}
    masked = dict(proxy_config)
    if masked.get("username"):
        masked["username"] = "***"
    if masked.get("password"):
        masked["password"] = "***"
    return masked


_AUTHENTICATED_PROXY_URL_RE = re.compile(r"\b(?P<scheme>https?|socks5)://[^/@\s]+@", re.IGNORECASE)


def _redact_proxy_error(error: BaseException | str, proxy_config: dict[str, str] | None) -> str:
    text = str(error)
    if not proxy_config:
        return text

    text = _AUTHENTICATED_PROXY_URL_RE.sub(lambda match: f"{match.group('scheme')}://***:***@", text)
    secrets: set[str] = set()
    for key in ("username", "password"):
        value = str(proxy_config.get(key) or "")
        if not value:
            continue
        secrets.update({value, quote(value, safe=""), quote_plus(value, safe="")})
    for secret in sorted(secrets, key=len, reverse=True):
        if secret:
            text = text.replace(secret, "***")
    return text


def _first_page(context):
    pages = getattr(context, "pages", None) or []
    if pages:
        return pages[0]
    return context.new_page()


def _sync_live_browser_viewport(page, context_control: dict[str, Any] | None, logger: AutomationLogger) -> None:
    if not isinstance(context_control, dict) or not context_control.get("live_browser_session_id"):
        return
    width = _safe_int(
        context_control.get("live_browser_width"),
        _DEFAULT_LIVE_BROWSER_WIDTH,
    )
    height = _safe_int(
        context_control.get("live_browser_height"),
        _DEFAULT_LIVE_BROWSER_HEIGHT,
    )
    expected = {"width": max(320, width), "height": max(240, height)}
    try:
        geometry = page.evaluate(
            """() => ({
                screenX: window.screenX,
                screenY: window.screenY,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio
            })"""
        )
        context_control["live_browser_viewport_width"] = int(geometry.get("innerWidth") or 0)
        context_control["live_browser_viewport_height"] = int(geometry.get("innerHeight") or 0)
        logger.log(
            "info",
            "live_browser_viewport",
            "已固定实时监控浏览器外框并记录页面坐标系。",
            {
                "framebuffer": expected,
                "browser_window": {
                    "width": _safe_int(context_control.get("live_browser_window_width"), expected["width"]),
                    "height": _safe_int(context_control.get("live_browser_window_height"), expected["height"]),
                },
                "chrome_reserve_height": _safe_int(context_control.get("live_browser_chrome_reserve_height"), 0),
                "geometry": geometry,
            },
        )
    except Exception as exc:
        logger.log(
            "warn",
            "live_browser_viewport_failed",
            "实时监控窗口坐标系读取失败；已停止强制调整页面尺寸。",
            {"error": str(exc), "framebuffer": expected},
        )


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _import_initial_cookies(context, cookies: Any, platform: str, logger: AutomationLogger) -> None:
    if not isinstance(cookies, list) or not cookies:
        return
    allowed_domains = ("threads.net", "threads.com", "instagram.com", "facebook.com") if platform == "threads" else ("instagram.com", "facebook.com")
    rows: list[dict[str, Any]] = []
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "").strip()
        domain = str(cookie.get("domain") or "").strip()
        if not name or not value or not domain:
            continue
        clean_domain = domain.lstrip(".").lower()
        if not any(clean_domain == allowed or clean_domain.endswith(f".{allowed}") for allowed in allowed_domains):
            continue
        row: dict[str, Any] = {
            "name": name,
            "value": value,
            "domain": domain,
            "path": str(cookie.get("path") or "/").strip() or "/",
            "httpOnly": bool(cookie.get("httpOnly") or cookie.get("http_only")),
            "secure": cookie.get("secure") is not False,
        }
        same_site = str(cookie.get("sameSite") or cookie.get("same_site") or "").strip().lower()
        if same_site in {"strict", "lax", "none"}:
            row["sameSite"] = {"strict": "Strict", "lax": "Lax", "none": "None"}[same_site]
        try:
            expires = float(cookie.get("expires", cookie.get("expirationDate", 0)) or 0)
        except (TypeError, ValueError):
            expires = 0
        if expires > time.time():
            row["expires"] = expires
        rows.append(row)
    if not rows:
        logger.log("warn", "cookie_import", "当前浏览器配置没有可用的初始 Cookie。", {"platform": platform})
        return
    try:
        context.add_cookies(rows)
        logger.log("info", "cookie_import", "已将初始 Cookie 导入浏览器配置。", {"platform": platform, "cookie_count": len(rows)})
    except Exception as exc:
        logger.log("warn", "cookie_import_failed", "导入初始 Cookie 到浏览器配置失败。", {"platform": platform, "error": str(exc)})


def _sleep_between(min_s: float, max_s: float) -> None:
    time.sleep(random.uniform(min_s, max_s))


def _human_type(
    page,
    text: str,
    min_delay: float = 0.08,
    max_delay: float = 0.18,
    *,
    abort_if: Callable[[], bool] | None = None,
) -> None:
    for ch in str(text or ""):
        if abort_if is not None and abort_if():
            return
        page.keyboard.type(ch)
        time.sleep(random.uniform(min_delay, max_delay))


def _normalize_text_input_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in {"paste", "type"} else "paste"


def _paste_text(page, text: str) -> bool:
    clean_text = str(text or "")
    try:
        origin = ""
        with contextlib.suppress(Exception):
            parsed = urlparse(str(page.url or ""))
            if parsed.scheme and parsed.netloc:
                origin = f"{parsed.scheme}://{parsed.netloc}"
        with contextlib.suppress(Exception):
            page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin or None)
        page.evaluate(
            """async (value) => {
                await navigator.clipboard.writeText(value);
            }""",
            clean_text,
        )
        page.keyboard.press("Control+V")
        return True
    except Exception:
        return False


def _type_text(
    page,
    text: str,
    min_delay: float = 0.08,
    max_delay: float = 0.18,
    *,
    mode: str = "paste",
    logger: AutomationLogger | None = None,
    stage: str = "text_input",
    abort_if: Callable[[], bool] | None = None,
) -> None:
    clean_text = str(text or "")
    if abort_if is not None and abort_if():
        return
    input_mode = _normalize_text_input_mode(mode or os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste"))
    if input_mode == "type":
        if logger is not None:
            logger.log("info", stage, "正在使用逐字输入方式填写内容。", {"mode": "type", "chars": len(clean_text)})
        _human_type(page, clean_text, min_delay=min_delay, max_delay=max_delay, abort_if=abort_if)
        return
    if abort_if is not None and abort_if():
        return
    if clean_text and _paste_text(page, clean_text):
        if logger is not None:
            logger.log("info", stage, "正在使用剪贴板粘贴方式填写内容。", {"mode": "paste", "chars": len(clean_text)})
        return
    if logger is not None:
        logger.log("warn", stage, "剪贴板粘贴失败，已改用直接文本输入。", {"mode": "paste", "chars": len(clean_text)})
    insert_enabled = str(os.getenv("SOCIAL_AUTOMATION_FAST_TEXT_INPUT", "1")).strip().lower() not in {"0", "false", "no", "off"}
    if insert_enabled and len(clean_text) >= 12:
        try:
            page.keyboard.insert_text(clean_text)
            if logger is not None:
                logger.log("info", stage, "Text input used direct browser insertion fallback.", {"mode": "insert_text", "chars": len(clean_text)})
            return
        except Exception:
            pass
    if logger is not None:
        logger.log("info", stage, "Text input used per-character fallback.", {"mode": "type_fallback", "chars": len(clean_text)})
    _human_type(page, clean_text, min_delay=min_delay, max_delay=max_delay, abort_if=abort_if)


def _human_click(
    page,
    locator,
    logger: AutomationLogger,
    stage: str = "click",
    *,
    abort_if: Callable[[], bool] | None = None,
) -> bool:
    if abort_if is not None and abort_if():
        return False
    # A stale social-DOM target should never leave the live view frozen for
    # tens of seconds.  Fresh candidates were already visibility-probed by
    # their callers, so a short confirmation window is sufficient here.
    locator.wait_for(state="visible", timeout=2500)
    if abort_if is not None and abort_if():
        return False
    try:
        locator.scroll_into_view_if_needed(timeout=1500)
        _sleep_between(0.2, 0.5)
    except Exception:
        pass
    box = locator.bounding_box()
    if abort_if is not None and abort_if():
        return False
    if not box:
        locator.click(timeout=2500)
        return True
    viewport = page.viewport_size
    if not viewport:
        try:
            measured = page.evaluate("() => ({ width: window.innerWidth, height: window.innerHeight })")
            viewport = {
                "width": int(measured.get("width") or 0),
                "height": int(measured.get("height") or 0),
            }
        except Exception:
            viewport = None
    viewport = viewport or {"width": 1280, "height": 720}
    if box["y"] < 0 or box["y"] + box["height"] > viewport["height"] or box["x"] < 0 or box["x"] + box["width"] > viewport["width"]:
        locator.scroll_into_view_if_needed(timeout=1500)
        _sleep_between(0.2, 0.5)
        box = locator.bounding_box()
        if abort_if is not None and abort_if():
            return False
        if not box:
            locator.click(timeout=2500)
            return True
    rel_x = random.uniform(box["width"] * 0.25, box["width"] * 0.75)
    rel_y = random.uniform(box["height"] * 0.25, box["height"] * 0.75)
    logger.log("debug", stage, "正在点击目标元素。", {"x": round(box["x"] + rel_x, 1), "y": round(box["y"] + rel_y, 1)})
    if abort_if is not None and abort_if():
        return False
    try:
        locator.click(position={"x": rel_x, "y": rel_y}, timeout=2500)
        return True
    except Exception as exc:
        logger.log("warn", f"{stage}_locator_click_failed", "目标元素点击超时，正在重新定位后重试。", {"error": str(exc)[:500]})
    try:
        if abort_if is not None and abort_if():
            return False
        locator.wait_for(state="visible", timeout=1500)
        locator.scroll_into_view_if_needed(timeout=1500)
        locator.click(timeout=2500)
        return True
    except Exception as exc:
        logger.log("warn", f"{stage}_locator_retry_failed", "重新定位点击失败，改用目标元素 DOM 点击兜底。", {"error": str(exc)[:500]})
    # Do not bypass Playwright's actionability checks with ``node.click()``.
    # On dynamic social pages that fallback can hang on a stale node and makes
    # an interaction appear successful without a browser-confirmed pointer
    # action.  The caller treats False as a recoverable target miss.
    logger.log(
        "warn",
        f"{stage}_aborted",
        "The target could not be clicked safely; skipped without DOM fallback.",
        {},
    )
    return False


def _screenshot(page, screenshot_dir: Path, task: dict[str, Any], stage: str, logger: AutomationLogger) -> str:
    if str(task.get("task_type") or "").strip().lower() == "publish_post" and str(stage or "") not in {
        "login_verification_required",
        "login_invalid_credentials",
        "manual_login_timeout",
        "publish_ready_no_submit",
        "publish_done",
        "publish_submitted_unconfirmed",
    }:
        return ""
    if not _should_capture_screenshot(stage):
        return ""
    path = screenshot_dir / f"{str(task.get('id') or 'task')}_{stage}_{int(time.time())}.png"
    try:
        page.screenshot(path=str(path), full_page=False)
        logger.log("info", stage, "已保存截图。", {"path": str(path)}, str(path))
        return str(path)
    except Exception as exc:
        logger.log("warn", stage, f"截图失败：{exc}")
        return ""


def _should_capture_screenshot(stage: str) -> bool:
    mode = str(os.getenv("SOCIAL_AUTOMATION_SCREENSHOT_MODE") or "checkpoint").strip().lower()
    if mode in {"debug", "all", "full"}:
        return True
    normalized_stage = str(stage or "").strip().lower()
    if re.fullmatch(r"(?:threads|instagram)_warmup_(?:like|comment)_\d+", normalized_stage):
        return True
    return normalized_stage in {
        "login_verification_required",
        "login_invalid_credentials",
        "login_wait_timeout",
        "manual_login_timeout",
        "login_complete",
        "publish_ready_no_submit",
        "publish_done",
        "publish_submitted_unconfirmed",
        "failed",
    }


def _compose_warmup_evidence_sheet(
    evidence: Iterable[tuple[str, int, str]],
    screenshot_dir: Path,
    task: dict[str, Any],
    logger: AutomationLogger,
) -> str:
    """Stack confirmed interaction screenshots vertically into one final image.

    Source captures are removed only after the composite has been saved
    successfully, so a failed compose never destroys the original evidence.
    """
    try:
        from PIL import Image, ImageDraw, ImageOps

        sources: list[tuple[str, int, Path]] = []
        for action, index, raw_path in evidence:
            path = Path(str(raw_path or ""))
            if action in {"like", "comment"} and path.is_file():
                sources.append((action, max(1, int(index)), path))
        if not sources:
            return ""

        columns = 1
        cell_width = 800
        image_height = 450
        label_height = 34
        cell_height = label_height + image_height
        rows = (len(sources) + columns - 1) // columns
        sheet = Image.new("RGB", (cell_width * columns, cell_height * rows), "#111827")
        draw = ImageDraw.Draw(sheet)
        for offset, (action, index, path) in enumerate(sources):
            column = offset % columns
            row = offset // columns
            left = column * cell_width
            top = row * cell_height
            label = f"{'LIKE' if action == 'like' else 'COMMENT'} #{index}"
            draw.rectangle(
                (left, top, left + cell_width, top + label_height),
                fill="#0f172a",
            )
            draw.text((left + 14, top + 9), label, fill="#f8fafc")
            with Image.open(path) as source:
                frame = ImageOps.exif_transpose(source).convert("RGB")
                contained = ImageOps.contain(
                    frame,
                    (cell_width, image_height),
                    method=Image.Resampling.LANCZOS,
                )
                canvas = Image.new("RGB", (cell_width, image_height), "#000000")
                canvas.paste(
                    contained,
                    (
                        (cell_width - contained.width) // 2,
                        (image_height - contained.height) // 2,
                    ),
                )
                sheet.paste(canvas, (left, top + label_height))

        output_path = screenshot_dir / (
            f"{str(task.get('id') or 'task')}_warmup_interaction_evidence_{int(time.time())}.jpg"
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output_path, format="JPEG", quality=88, optimize=True)
        removed_sources = 0
        for source_path in dict.fromkeys(path for _, _, path in sources):
            try:
                source_path.unlink()
                removed_sources += 1
            except FileNotFoundError:
                continue
            except Exception as exc:
                logger.log(
                    "warn",
                    "warmup_interaction_evidence_cleanup",
                    f"Could not remove a source screenshot after composing evidence: {exc}",
                    {"path": str(source_path)},
                )
        logger.log(
            "info",
            "warmup_interaction_evidence",
            "已将全部成功点赞和评论截图拼接为最终证据图。",
            {
                "count": len(sources),
                "likes": sum(1 for action, _, _ in sources if action == "like"),
                "comments": sum(1 for action, _, _ in sources if action == "comment"),
                "layout": "vertical",
                "removed_sources": removed_sources,
            },
            str(output_path),
        )
        return str(output_path)
    except Exception as exc:
        logger.log("warn", "warmup_interaction_evidence", f"互动证据图拼接失败：{exc}")
        return ""


def _page_navigation_unusable(page) -> bool:
    """HTTP/blank/error documents must not count as a successful Threads navigation."""
    url = str(getattr(page, "url", "") or "").strip()
    try:
        parsed = urlparse(url)
    except Exception:
        return True
    host = str(parsed.hostname or "").lower()
    if not url or parsed.scheme in {"", "about"}:
        return True
    if parsed.scheme == "http" and host.endswith(("threads.net", "threads.com", "instagram.com")):
        return True
    if _browser_navigation_error_visible(page):
        return True
    try:
        body = str(page.locator("body").inner_text(timeout=800) or "").strip()
    except Exception:
        return False
    interactive = 0
    try:
        interactive = int(page.locator("input, button, a, img, [role='button']").count() or 0)
    except Exception:
        interactive = 0
    return (not body) and interactive <= 0


def _goto(page, url: str, logger: AutomationLogger, stage: str, *, timeout_ms: int = 60000, networkidle_ms: int = 15000) -> None:
    logger.log("info", stage, f"正在打开页面：{url}")
    candidates = [url]
    if url == THREADS_HOME:
        candidates.extend(["https://www.threads.com/", "https://www.threads.com/login"])
    home_open = url == THREADS_HOME
    per_try = min(int(timeout_ms or 60000), 15000) if home_open else int(timeout_ms or 60000)
    # Sticky HTTP proxies can land on a blank HTTP document that never fires
    # DOMContentLoaded. Commit returns as soon as the URL is known so the
    # existing home fallback (threads.com/) can run instead of hanging.
    wait_until = "commit" if home_open else "domcontentloaded"
    login_ready = False
    for index, candidate in enumerate(candidates):
        try:
            page.goto(candidate, wait_until=wait_until, timeout=per_try)
            if home_open:
                current_scheme = str(urlparse(str(getattr(page, "url", "") or "")).scheme or "").lower()
                if current_scheme != "http":
                    with contextlib.suppress(Exception):
                        page.wait_for_load_state("domcontentloaded", timeout=4000)
                if _page_navigation_unusable(page):
                    logger.log(
                        "warn",
                        f"{stage}_navigation_recovery",
                        "打开的页面不可用（空白、HTTP 或错误页），改试下一地址。",
                        {"from": candidate, "url": _safe_navigation_url(getattr(page, "url", ""))},
                    )
                    if index + 1 < len(candidates):
                        continue
                if _threads_login_surface_visible(page):
                    login_ready = True
            break
        except Exception as exc:
            message = str(exc)
            current_url = str(getattr(page, "url", "") or "").strip()
            is_redirect_navigation = any(
                marker in message
                for marker in (
                    "NS_ERROR_REDIRECT_LOOP",
                    "ERR_TOO_MANY_REDIRECTS",
                    "interrupted by another navigation",
                )
            )
            is_transient_threads_navigation = (
                home_open and _is_transient_navigation_exception(message)
            )
            if not is_redirect_navigation and not is_transient_threads_navigation:
                raise
            if is_redirect_navigation and current_url and current_url != "about:blank" and not (
                home_open and _page_navigation_unusable(page)
            ):
                logger.log(
                    "warn",
                    stage,
                    "Navigation reported a transient redirect error; continuing from the loaded page.",
                    {"error": message.splitlines()[0], "url": current_url},
                )
                break
            if index + 1 < len(candidates):
                next_url = candidates[index + 1]
                logger.log(
                    "warn",
                    f"{stage}_navigation_recovery",
                    "Threads navigation failed transiently; trying the canonical host without closing the browser.",
                    {"from": candidate, "to": next_url, "error": message.splitlines()[0]},
                )
                continue
            logger.log(
                "warn",
                f"{stage}_state_recovery",
                "Threads navigation is still redirecting; keeping the browser open for login recovery.",
                {"url": candidate},
            )
    try:
        if login_ready:
            pass
        elif not (home_open and _page_navigation_unusable(page)):
            idle_ms = min(int(networkidle_ms or 15000), 4000) if home_open else int(networkidle_ms or 15000)
            page.wait_for_load_state("networkidle", timeout=idle_ms)
    except Exception:
        pass


def _threads_home_is_current(page) -> bool:
    try:
        parsed = urlparse(str(getattr(page, "url", "") or ""))
    except Exception:
        return False
    host = str(parsed.hostname or "").lower()
    if host not in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
        return False
    return str(parsed.path or "/").rstrip("/") in {"", "/"}


def _ensure_threads_home_for_publish(page, logger: AutomationLogger) -> None:
    if _threads_home_is_current(page):
        logger.log(
            "debug",
            "threads_publish_open",
            "Threads home is already open; skipped duplicate navigation.",
            {"url": _safe_navigation_url(getattr(page, "url", ""))},
        )
        return
    _goto(page, THREADS_HOME, logger, "threads_publish_open")


def _is_transient_navigation_exception(message: str) -> bool:
    normalized = str(message or "").lower()
    return any(
        marker in normalized
        for marker in (
            "ns_error_net_empty_response",
            "ns_error_proxy_connection_refused",
            "err_proxy_connection_failed",
            "err_tunnel_connection_failed",
            "err_connection_reset",
            "err_connection_closed",
            "err_connection_timed_out",
            "err_timed_out",
            "timeout",
            "net::",
            "proxy",
            "tunnel",
            "connection reset",
            "connection refused",
            "temporarily unavailable",
        )
    )


def _check_instagram_login(page, logger: AutomationLogger) -> dict[str, Any]:
    _goto(page, INSTAGRAM_HOME, logger, "check_login")
    return _detect_instagram_login_state(page)


def _check_threads_login(page, logger: AutomationLogger) -> dict[str, Any]:
    _goto(page, THREADS_HOME, logger, "check_login")
    return _detect_threads_login_state(page)


def _check_platform_login(page, platform: str, logger: AutomationLogger) -> dict[str, Any]:
    if platform == "threads":
        return _check_threads_login(page, logger)
    return _check_instagram_login(page, logger)


@contextlib.contextmanager
def _temporary_background_page(
    page,
    logger: AutomationLogger,
    stage: str,
    *,
    block_heavy_assets: bool = False,
):
    background = page
    route_handler = None
    try:
        browser_context = getattr(page, "context", None)
        new_page = getattr(browser_context, "new_page", None)
        if callable(new_page):
            candidate = new_page()
            if candidate is not None and candidate is not page:
                background = candidate
                with contextlib.suppress(Exception):
                    page.bring_to_front()
                logger.log(
                    "debug",
                    stage,
                    "Background browser page opened for a non-disruptive check.",
                    {"heavy_assets_blocked": bool(block_heavy_assets)},
                )
        if block_heavy_assets:
            route_page = getattr(background, "route", None)
            if callable(route_page):
                def handle_background_request(route) -> None:
                    request = getattr(route, "request", None)
                    resource_type = str(getattr(request, "resource_type", "") or "").lower()
                    if resource_type in {"image", "media", "font", "stylesheet"}:
                        route.abort()
                        return
                    route.continue_()

                route_handler = handle_background_request
                route_page("**/*", route_handler)
    except Exception as exc:
        background = page
        logger.log("debug", stage, "Background page unavailable; using the primary page.", {"error": str(exc)[:500]})
    try:
        yield background
    finally:
        if route_handler is not None:
            with contextlib.suppress(Exception):
                background.unroute("**/*", route_handler)
        if background is not page:
            with contextlib.suppress(Exception):
                background.close()
            with contextlib.suppress(Exception):
                page.bring_to_front()


_ACCOUNT_RESTRICTION_URL_MARKERS = (
    "/disabled/",
    "/suspended/",
    "/checkpoint/disabled",
    "/accounts/disabled",
)
_ACCOUNT_RESTRICTION_SURFACE_SELECTORS = (
    'a[href*="/accounts/disabled"]',
    'a[href*="/checkpoint/disabled"]',
    'a[href*="/suspended/"]',
    'a[href*="help.instagram.com/447613741984126"]',
    'a[href*="help.instagram.com/366994040048856"]',
    'a[href*="help.instagram.com/477434105621119"]',
    'form[action*="/accounts/disabled"]',
    'form[action*="/checkpoint/disabled"]',
    'form[action*="disabled"]',
    'form[action*="suspended"]',
)
_ACCOUNT_RESTRICTION_TEXT_MARKERS = (
    "your account has been disabled",
    "your account was disabled",
    "we disabled your account",
    "your account has been suspended",
    "your account was suspended",
    "we suspended your account",
    "account has been deactivated",
    "account is disabled",
)


def _platform_restriction_surface_visible(page) -> bool:
    """Recognize a disabled/suspended splash by DOM hrefs and forms, independent of page language."""
    try:
        marked = page.evaluate(
            r"""() => {
                const hrefOf = (node) => String(
                    node.href || node.action || node.getAttribute('href') || node.getAttribute('action') || ''
                );
                const isVisible = (node) => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0
                        && style.visibility !== 'hidden'
                        && style.display !== 'none';
                };
                const disabledPath = /\/(?:accounts|checkpoint)\/disabled(?:\/|$|\?)|\/suspended(?:\/|$|\?)/i;
                const helpDisabled = /help\.instagram\.com\/(?:447613741984126|366994040048856|477434105621119)/i;
                const nodes = Array.from(document.querySelectorAll('a[href], form[action]'));
                for (const node of nodes) {
                    if (node.tagName !== 'FORM' && !isVisible(node)) continue;
                    const href = hrefOf(node);
                    if (disabledPath.test(href) || helpDisabled.test(href)) return true;
                }
                return false;
            }"""
        )
        if marked:
            return True
    except Exception:
        pass
    return _visible_first(page, list(_ACCOUNT_RESTRICTION_SURFACE_SELECTORS), timeout_ms=400) is not None


def _detect_platform_account_restriction(
    url: str,
    body_text: str,
    platform: str,
    page=None,
) -> dict[str, Any] | None:
    clean_url = str(url or "").lower()
    clean_text = str(body_text or "").lower()
    evidence = ""
    if any(marker in clean_url for marker in _ACCOUNT_RESTRICTION_URL_MARKERS):
        evidence = "url"
    elif page is not None and _platform_restriction_surface_visible(page):
        evidence = "visual_structure"
    elif any(marker in clean_text for marker in _ACCOUNT_RESTRICTION_TEXT_MARKERS):
        evidence = "page_text"
    if not evidence:
        return None
    platform_name = _platform_name(platform)
    return {
        "status": "cookie_expired",
        "health_status": "banned",
        "reason": f"{platform_name} 检测到账号已被停用或封禁。",
        "url": str(url or ""),
        "evidence": evidence,
    }


def _account_health_from_login_state(status: dict[str, Any]) -> tuple[str, str]:
    explicit = str(status.get("health_status") or "").strip().lower()
    if explicit in {"unknown", "alive", "abnormal", "banned"}:
        return explicit, str(status.get("reason") or explicit)
    login_status = str(status.get("status") or "").strip().lower()
    if login_status == "ready":
        return "alive", str(status.get("reason") or "Account is available.")
    if login_status == "disabled":
        return "banned", str(status.get("reason") or "Account is disabled or suspended.")
    if login_status == "transient_error":
        return "abnormal", str(status.get("reason") or "Platform page is temporarily abnormal.")
    return "unknown", str(status.get("reason") or "Platform health could not be confirmed before login.")


def _detect_instagram_login_state(page) -> dict[str, Any]:
    url = str(page.url or "")
    normalized_url = url.lower()
    body_text = ""
    try:
        body_text = str(page.locator("body").inner_text(timeout=5000) or "").lower()
    except Exception:
        pass
    restriction = _detect_platform_account_restriction(url, body_text, "instagram", page=page)
    if restriction is not None:
        return restriction
    if "/accounts/scraping_warning" in normalized_url:
        return {
            "status": "post_login_interstitial",
            "reason": "Instagram is showing a post-login account notice.",
            "url": url,
        }
    if _is_verification_url(url):
        challenge = _classify_verification_challenge(page)
        challenge_type = str(challenge.get("type") or "")
        risk_control = (
            "/accounts/update_risky_contactpoint" in normalized_url
            or challenge_type in {"email_code", "identity_challenge", "method_selection"}
        )
        return {
            "status": "need_verification",
            "reason": (
                "Instagram 触发邮箱或身份安全验证，账号已进入封控验证状态。"
                if risk_control
                else "Instagram 需要输入验证码。"
            ),
            "url": url,
            "challenge_type": challenge_type,
            **({"health_status": "abnormal"} if risk_control else {}),
        }
    if _page_shows_invalid_credentials(page, body_text=body_text):
        return {"status": "invalid_credentials", "reason": "平台提示账号或密码不正确，请重新输入。", "url": url}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        challenge = _classify_verification_challenge(page)
        challenge_type = str(challenge.get("type") or "")
        risk_control = challenge_type in {"email_code", "identity_challenge", "method_selection"}
        return {
            "status": "need_verification",
            "reason": "检测到邮箱或身份安全验证。" if risk_control else "检测到验证或安全挑战文案。",
            "challenge_type": challenge_type,
            **({"health_status": "abnormal"} if risk_control else {}),
        }
    post_login_interstitial = (
        "/accounts/onetap" in normalized_url
        or "save your login info?" in body_text
        or (
            "turn on notifications" in body_text
            and "not now" in body_text
        )
    )
    if post_login_interstitial:
        return {
            "status": "post_login_interstitial",
            "reason": "Instagram 登录后的确认窗口仍在显示，尚未进入可操作页面。",
            "url": url,
        }
    if "/accounts/login" in url:
        return {"status": "cookie_expired", "reason": "检测到 Instagram 登录页面。", "url": url}
    login_inputs = page.locator(
        'input[name="username"], input[name="password"], '
        'input[aria-label*="username" i], input[aria-label*="email" i], input[aria-label*="password" i], '
        'input[placeholder*="username" i], input[placeholder*="email" i], input[placeholder*="password" i]'
    )
    try:
        if login_inputs.count() > 0 and login_inputs.first.is_visible():
            return {"status": "cookie_expired", "reason": "检测到登录表单。"}
    except Exception:
        pass
    login_markers = ["log into instagram", "log in with facebook", "forgot password", "create new account"]
    if any(marker in body_text for marker in login_markers):
        return {"status": "cookie_expired", "reason": "检测到 Instagram 登录页面文案。"}
    ready_markers = [
        '[aria-label="New post"]',
        'text=Create',
        'text=Messages',
        'text=Notifications',
        'a[href="/direct/inbox/"]',
        'a[href="/explore/"]',
    ]
    for selector in ready_markers:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=2000):
                return {"status": "ready", "reason": "已检测到 Instagram 首页界面。", "url": url}
        except Exception:
            continue
    if _has_threads_session_cookie(page):
        return {"status": "ready", "reason": "已检测到有效的 Instagram 登录会话。", "url": url}
    return {"status": "cookie_expired", "reason": "尚未检测到有效的 Instagram 登录会话。", "url": url}


def _browser_navigation_error_visible(page) -> bool:
    """Recognize the browser's stable network-error artwork/structure across locales."""
    for selector in (
        "body.neterror",
        "#errorPageContainer",
        "#netErrorButtonContainer",
        "#netErrorButton",
    ):
        try:
            locator = page.locator(selector).first
            if locator.count() and locator.is_visible(timeout=500):
                return True
        except Exception:
            continue
    return False


def _detect_threads_login_state(page) -> dict[str, Any]:
    url = str(page.url or "")
    normalized_url = url.lower()
    hostname = str(urlparse(url).hostname or "").lower()
    body_text = ""
    try:
        body_text = str(page.locator("body").inner_text(timeout=5000) or "").lower()
    except Exception:
        pass
    restriction = _detect_platform_account_restriction(url, body_text, "threads", page=page)
    if restriction is not None:
        return restriction
    if _is_verification_url(url):
        challenge = _classify_verification_challenge(page)
        return {
            "status": "need_verification",
            "reason": "Threads/Instagram 需要输入验证码。",
            "url": url,
            "challenge_type": str(challenge.get("type") or ""),
        }
    if "/accounts/scraping_warning" in normalized_url:
        return {
            "status": "post_login_interstitial",
            "reason": "Threads is showing a post-login account notice.",
            "url": url,
        }
    if _browser_navigation_error_visible(page):
        return {
            "status": "transient_error",
            "reason": "Threads browser navigation error page is visible.",
            "url": url,
            "evidence": "visual_structure",
        }
    transient_error_markers = [
        "something went wrong",
        "please try again later",
        "try again later",
        "unable to load",
        "couldn't refresh",
    ]
    if any(marker in body_text for marker in transient_error_markers):
        return {
            "status": "transient_error",
            "reason": "Threads 页面当前显示加载错误，尚未确认登录成功。",
            "url": url,
        }
    if any(marker in body_text for marker in _verification_text_markers()):
        return {"status": "need_verification", "reason": "检测到验证码或安全挑战文案。", "url": url}

    is_threads_host = hostname in {"threads.net", "threads.com"} or hostname.endswith(
        (".threads.net", ".threads.com")
    )
    if not is_threads_host:
        return {
            "status": "cookie_expired",
            "reason": "Threads login cannot be confirmed outside the Threads domain.",
            "url": url,
        }
    if _page_shows_invalid_credentials(page, body_text=body_text):
        return {"status": "invalid_credentials", "reason": "平台提示账号或密码不正确，请重新输入。", "url": url}
    if "/login" in url:
        return {"status": "cookie_expired", "reason": "检测到 Threads 登录页面。", "url": url, "evidence": "url"}
    if _threads_login_surface_visible(page):
        return {
            "status": "cookie_expired",
            "reason": "检测到 Threads 登录卡或登录表单结构。",
            "url": url,
            "evidence": "visual_structure",
        }
    login_prompt_selectors = [
        'text="Log in or sign up for Threads"',
        'text="Log in with username instead"',
    ]
    for selector in login_prompt_selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=1500):
                return {"status": "cookie_expired", "reason": "检测到 Threads 登录提示。", "url": url}
        except Exception:
            continue
    login_inputs = page.locator(
        'input[name="username"], input[name="password"], '
        'input[autocomplete="username"], input[autocomplete="current-password"], '
        'input[placeholder*="username" i], input[placeholder*="phone" i], input[placeholder*="email" i], input[placeholder*="password" i]'
    )
    try:
        if login_inputs.count() > 0 and login_inputs.first.is_visible():
            return {"status": "cookie_expired", "reason": "检测到 Threads 登录表单。", "evidence": "visual_structure"}
    except Exception:
        pass
    login_markers = ["log in", "login", "continue with instagram", "forgot password", "sign up"]
    if any(marker in body_text for marker in login_markers) and any(marker in body_text for marker in ["threads", "instagram"]):
        return {"status": "cookie_expired", "reason": "检测到 Threads 登录页面文案。", "url": url}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        return {"status": "need_verification", "reason": "检测到验证或安全挑战文案。"}

    if not _has_threads_session_cookie(page):
        return {
            "status": "cookie_expired",
            "reason": "未检测到有效的 Threads/Instagram 登录会话。",
            "url": url,
        }

    account_markers = [
        '[aria-label*="New thread" i]',
        '[aria-label*="Create" i]',
        '[aria-label*="Profile" i]',
        '[aria-label*="Activity" i]',
        'a[href="/search"]',
        'a[href="/activity"]',
        'a[href="/direct/inbox/"]',
        'a[href^="/@"]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ]
    matched = 0
    for selector in account_markers:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=2000):
                matched += 1
        except Exception:
            continue
    if matched >= 2:
        return {"status": "ready", "reason": "已检测到 Threads 登录后的界面。", "url": url, "matched_markers": matched}

    if any(marker in body_text for marker in ("log in", "continue with instagram", "continue with facebook", "sign up")):
        return {"status": "cookie_expired", "reason": "检测到 Threads 登录提示。", "url": url}
    return {"status": "cookie_expired", "reason": "尚未检测到 Threads 登录后的界面。", "url": url, "matched_markers": matched}


def _has_threads_session_cookie(page) -> bool:
    try:
        cookies = page.context.cookies()
    except Exception:
        return False
    for cookie in cookies or []:
        if str(cookie.get("name") or "").strip().lower() != "sessionid":
            continue
        if not str(cookie.get("value") or "").strip():
            continue
        domain = str(cookie.get("domain") or "").strip().lower().lstrip(".")
        if domain.endswith(("threads.net", "threads.com", "instagram.com")):
            return True
    return False


def _platform_home(platform: str) -> str:
    return THREADS_HOME if platform == "threads" else INSTAGRAM_HOME


def _platform_name(platform: str) -> str:
    return "Threads" if platform == "threads" else "Instagram"


def _is_verification_url(url: str) -> bool:
    normalized = str(url or "").strip().lower()
    return any(
        part in normalized
        for part in (
            "/challenge",
            "/checkpoint",
            "/two_step_verification",
            "two_factor_login",
            "/accounts/update_risky_contactpoint",
        )
    )


def _invalid_credential_text_markers() -> list[str]:
    return [
        "login information you entered is incorrect",
        "your password was incorrect",
        "incorrect password",
        "wrong password",
        "we couldn't find an account",
        "sorry, your password was incorrect",
        "the username you entered doesn't belong",
        "couldn't find your account",
        "invalid username",
        "invalid password",
        "password is incorrect",
        "please check your password",
        "密码不正确",
        "密码错误",
        "你输入的密码不正确",
        "你輸入的密碼不正確",
        "密碼不正確",
        "密碼錯誤",
        "找不到与该用户名",
        "找不到該用戶名",
        "找不到你的帐户",
        "找不到你的帳戶",
        "用户名无效",
        "用戶名無效",
        "请检查你的密码",
        "請檢查你的密碼",
    ]


def _page_shows_invalid_credentials(page, body_text: str | None = None) -> bool:
    text = str(body_text or "").strip().lower()
    if not text:
        text = _page_body_text_lower(page)
    return any(marker in text for marker in _invalid_credential_text_markers())


def _verification_text_markers() -> list[str]:
    return [
        "verification code",
        "enter the code",
        "security code",
        "two-factor",
        "two factor",
        "two-step",
        "two step",
        "authentication app",
        "6-digit code",
        "confirm it's you",
        "confirm you're human",
        "confirm you are human",
        "enter the code from the image",
        "suspicious login attempt",
        "unusual login attempt",
        "security challenge",
        "verify your account",
        "help us confirm",
        "upload a verification selfie",
        "verification selfie",
        "video selfie",
        "take a selfie video",
        "identity confirmation",
        "your email may not be secure",
        "验证码",
        "两步验证",
        "双重验证",
        "安全码",
    ]


def _detect_platform_login_state(page, platform: str) -> dict[str, Any]:
    if platform == "threads":
        if "instagram.com" in str(page.url or "").lower():
            instagram_status = _detect_instagram_login_state(page)
            if str(instagram_status.get("status") or "") == "ready":
                return _enrich_login_state_with_visible_challenge(page, {
                    **instagram_status,
                    "status": "threads_restore_required",
                    "reason": "Instagram login is ready; Threads still requires final confirmation on the Threads domain.",
                })
            return _enrich_login_state_with_visible_challenge(page, instagram_status)
        return _enrich_login_state_with_visible_challenge(page, _detect_threads_login_state(page))
    return _enrich_login_state_with_visible_challenge(page, _detect_instagram_login_state(page))


def _enrich_login_state_with_visible_challenge(page, status: dict[str, Any] | None) -> dict[str, Any]:
    current = dict(status or {})
    current_code = str(current.get("status") or "").strip().lower()
    mapped = None
    with contextlib.suppress(Exception):
        mapped = _mapped_login_verification_code(page)
    if mapped is None:
        if current_code == "need_verification":
            credentials = None
            with contextlib.suppress(Exception):
                credentials = _mapped_login_credentials(page)
            if credentials is not None:
                demoted = {
                    **current,
                    "status": "cookie_expired",
                    "reason": "当前页面显示的是账号密码登录，而不是验证码。",
                    "url": str(current.get("url") or getattr(page, "url", "") or ""),
                }
                demoted.pop("challenge_type", None)
                return demoted
        return current
    if current_code in {"ready", "need_verification", "invalid_credentials"}:
        return current
    challenge = {}
    with contextlib.suppress(Exception):
        challenge = _classify_verification_challenge(page)
    challenge_type = str(challenge.get("type") or "unknown_code")
    if challenge_type in {"", "none"}:
        challenge_type = "unknown_code"
    return {
        **current,
        "status": "need_verification",
        "reason": str(current.get("reason") or "检测到验证码输入框，需要填写平台验证码。"),
        "challenge_type": challenge_type,
        "url": str(current.get("url") or getattr(page, "url", "") or ""),
    }


def _int_payload_or_env(payload: dict[str, Any], key: str, env_key: str, default: int, minimum: int, maximum: int) -> int:
    raw = payload.get(key)
    if raw is None or raw == "":
        raw = os.getenv(env_key, str(default))
    try:
        value = int(raw)
    except Exception:
        value = default
    return max(minimum, min(value, maximum))


def _self_heal_login_page(
    page,
    platform: str,
    logger: AutomationLogger,
    task: dict[str, Any],
    screenshot_dir: Path,
    reason: str,
    attempt: int,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    if _manual_takeover_requested(context_control):
        return
    shot = _screenshot(page, screenshot_dir, task, f"login_self_heal_{attempt}", logger)
    logger.log(
        "warn",
        "login_self_heal",
        f"{_platform_name(platform)} login is unstable; running automatic recovery attempt {attempt}.",
        {"attempt": attempt, "reason": reason, "url": _safe_navigation_url(page.url)},
        shot,
    )
    if platform == "threads" and "/accounts/scraping_warning" in str(page.url or "").lower():
        auth_submission_started = bool(
            isinstance(context_control, dict)
            and (
                context_control.get("login_submission_started")
                or context_control.get("_totp_verification_pending")
            )
        )
        if auth_submission_started:
            logger.log(
                "warn",
                "login_self_heal_threads_notice_preserved",
                "Threads is showing a post-login notice; preserving the authenticated session for final confirmation.",
                {"url": _safe_navigation_url(page.url)},
            )
            return
        logger.log(
            "warn",
            "login_self_heal_threads_session_reset",
            "Threads 会话卡在重定向警告页，正在重置 Threads 会话并恢复登录入口。",
            {"url": _safe_navigation_url(page.url)},
        )
        page.context.clear_cookies(domain=re.compile(r"(^|\.)threads\.(?:com|net)$"))
        with contextlib.suppress(Exception):
            page.goto("about:blank", wait_until="domcontentloaded", timeout=5000)
        _goto(
            page,
            "https://www.threads.com/login",
            logger,
            "login_self_heal_threads_direct",
            timeout_ms=30000,
            networkidle_ms=8000,
        )
        _sleep_between(1.5, 3.0)
        return
    retry_clicked = _click_text_button(
        page,
        logger,
        ["Retry", "Try again", "重试", "再试一次"],
        "login_self_heal_retry",
        abort_if=lambda: _manual_takeover_requested(context_control),
    )
    if retry_clicked:
        with contextlib.suppress(Exception):
            page.wait_for_load_state("domcontentloaded", timeout=15000)
        _sleep_between(1.5, 3.0)
        return
    if platform == "threads" and reason == "auto_login_form_not_ready":
        # Cross-domain handoff is owned by _run_open_login/_auto_submit_login_form.
        # If the handoff already landed on Instagram, stay there.  Going back
        # to Threads creates a second Threads -> Instagram -> Threads loop.
        try:
            current_host = str(urlparse(str(page.url or "")).hostname or "").lower()
        except Exception:
            current_host = ""
        if current_host == "instagram.com" or current_host.endswith(".instagram.com"):
            _goto(
                page,
                INSTAGRAM_LOGIN,
                logger,
                "login_self_heal_instagram_login",
                timeout_ms=30000,
                networkidle_ms=8000,
            )
            _sleep_between(1.5, 3.0)
            return
        # Otherwise stay on Threads.  Do not bounce between domains.
        if attempt % 2:
            with contextlib.suppress(Exception):
                page.reload(wait_until="domcontentloaded", timeout=30000)
                page.wait_for_load_state("networkidle", timeout=8000)
        else:
            _goto(page, THREADS_HOME, logger, "login_self_heal_threads_home")
        _sleep_between(1.5, 3.0)
        return
    with contextlib.suppress(Exception):
        if _manual_takeover_requested(context_control):
            return
        page.keyboard.press("Escape")
    action = attempt % 4
    if _manual_takeover_requested(context_control):
        return
    if action == 1:
        with contextlib.suppress(Exception):
            if _manual_takeover_requested(context_control):
                return
            page.reload(wait_until="domcontentloaded", timeout=60000)
            page.wait_for_load_state("networkidle", timeout=12000)
    elif action == 2:
        _goto(page, _platform_home(platform), logger, "login_self_heal_home")
    elif platform == "threads":
        _goto(page, THREADS_HOME, logger, "login_self_heal_threads")
    else:
        _goto(page, "https://www.instagram.com/accounts/login/", logger, "login_self_heal_instagram_login")
    _sleep_between(1.5, 3.0)


def _prepare_manual_threads_login_page(page, logger: AutomationLogger) -> None:
    """Open the Threads username/password form used by the login assistant."""
    status = _detect_threads_login_state(page)
    if status.get("status") == "ready":
        return

    if status.get("status") == "transient_error":
        retried = _click_text_button(page, logger, ["Retry", "Try again"], "manual_login_retry")
        logger.log(
            "info" if retried else "warn",
            "manual_login_retry",
            "Threads initial error page retry was handled.",
            {"clicked": retried, "url": _safe_navigation_url(page.url)},
        )
        if retried:
            _sleep_between(1.5, 3.0)
            with contextlib.suppress(Exception):
                page.wait_for_load_state("domcontentloaded", timeout=15000)
            status = _detect_threads_login_state(page)

    if status.get("status") == "ready":
        return
    opened = _click_threads_username_entry_by_structure(page, logger)
    if not opened:
        opened = _click_text_button(
            page,
            logger,
            [
                "Log in with username instead",
                "Log in with username",
                "Use username instead",
                "代わりにユーザーネームでログイン",
                "ユーザーネームでログイン",
                "改用用户名登录",
                "使用用户名登录",
                "改用用戶名稱登入",
                "使用用戶名稱登入",
            ],
            "manual_threads_username_login",
        )
    logger.log(
        "info" if opened else "warn",
        "manual_threads_username_login",
        "Threads username/password login form was opened." if opened else "Threads username/password login entry is not available yet.",
        {"clicked": opened, "url": _safe_navigation_url(page.url)},
    )
    if opened:
        _sleep_between(2.0, 4.0)
        with contextlib.suppress(Exception):
            page.wait_for_load_state("domcontentloaded", timeout=15000)
    # Keep the current Threads page open when its native form is unavailable.


def _restore_threads_after_instagram_login(page, status: dict[str, Any], logger: AutomationLogger) -> dict[str, Any]:
    if (
        str(status.get("status") or "") not in {"ready", "threads_restore_required"}
        or "instagram.com" not in str(page.url or "").lower()
    ):
        return status
    logger.log(
        "info",
        "manual_login_return_threads",
        "Instagram login completed; returning to Threads for final session confirmation.",
        {"url": _safe_navigation_url(page.url)},
    )
    _goto(page, THREADS_HOME, logger, "manual_login_return_threads")
    return _detect_threads_login_state(page)


def _account_status_for_login_handoff(status: dict[str, Any] | None) -> str:
    code = str((status or {}).get("status") or "").strip().lower()
    health = str((status or {}).get("health_status") or "").strip().lower()
    if health == "banned" or code == "banned":
        # ``social_accounts.status`` deliberately uses ``disabled`` as its
        # terminal value.  Do not send the health-layer ``banned`` marker to
        # the running-task callback: it is not a valid account status and used
        # to be silently ignored until the browser task finished.
        return "disabled"
    if code == "disabled":
        return "disabled"
    if code == "need_verification":
        return "need_verification"
    return "cookie_expired"


def _handoff_status_for_open_login(
    page,
    platform: str,
    last_status: dict[str, Any] | None,
    reason: str,
) -> dict[str, Any]:
    current = dict(last_status or {})
    detected: dict[str, Any] = {}
    with contextlib.suppress(Exception):
        detected = _detect_platform_login_state(page, platform)
    if detected:
        current = detected
    code = str(current.get("status") or "").strip().lower()
    if code in {"banned", "disabled", "need_verification"}:
        if reason and not str(current.get("reason") or "").strip():
            current["reason"] = reason
        return current
    if code == "invalid_credentials" or _page_shows_invalid_credentials(page):
        return {
            **current,
            "status": "invalid_credentials",
            "reason": str(current.get("reason") or reason or "平台提示账号或密码不正确，请重新输入。"),
        }
    return {
        **current,
        "status": "cookie_expired",
        "reason": reason or "自动登录未成功，请人工输入账号和密码。",
        "url": str(current.get("url") or getattr(page, "url", "") or ""),
    }


def _handoff_open_login_to_manual(
    page,
    task,
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
    last_status: dict[str, Any] | None,
    reason: str,
    stage: str = "login_auto_retry_exhausted",
    screenshot_path: str = "",
) -> dict[str, Any]:
    _request_manual_takeover(context_control)
    current = _handoff_status_for_open_login(page, platform, last_status, reason)
    account_status = _account_status_for_login_handoff(current)
    _report_account_login_status(context_control, account_status, logger)
    shot = screenshot_path or _screenshot(page, screenshot_dir, task, stage, logger)
    logger.log(
        "warn",
        stage,
        str(current.get("reason") or reason),
        {"status": str(current.get("status") or "cookie_expired"), "account_status": account_status, "details": _safe_login_status(current)},
        shot,
    )
    return _wait_for_manual_login_completion(
        page,
        task,
        screenshot_dir,
        logger,
        platform,
        cancel_event,
        str(current.get("reason") or reason),
        str(current.get("status") or "cookie_expired"),
        shot,
        current,
        context_control,
    )


def _wait_or_raise_manual(
    page,
    task,
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    reason: str,
    status: str,
    screenshot_path: str,
    last_status: dict[str, Any] | None,
    wait_for_manual: bool,
    manual_only_on_verification: bool = False,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if wait_for_manual and (
        not manual_only_on_verification
        or status in {"need_verification", "invalid_credentials"}
    ):
        return _wait_for_manual_login_completion(
            page,
            task,
            screenshot_dir,
            logger,
            platform,
            cancel_event,
            reason,
            status,
            screenshot_path,
            last_status,
            context_control,
        )
    logger.log(
        "error",
        "auto_login_failed",
        reason,
        {"status": status, "screenshot_path": screenshot_path, "details": last_status or {}},
        screenshot_path,
    )
    failed_status = dict(last_status or {})
    failed_status.setdefault("status", status or "failed")
    failed_status.setdefault("reason", reason)
    if str(failed_status.get("status") or "") not in {"failed", "auto_login_failed", "manual_login_timeout", "cancelled", "banned", "disabled"}:
        failed_status["status"] = "failed"
        failed_status["reason"] = reason
    _publish_login_assistance_state(page, context_control, failed_status, handoff=True)
    health_status = str(failed_status.get("health_status") or "").strip().lower()
    effective_status = str(failed_status.get("status") or status or "failed").strip().lower()
    if effective_status in {"banned", "disabled"} or str(status or "").strip().lower() in {"banned", "disabled"}:
        health_status = "banned"
        effective_status = "disabled"
    raise AutoLoginFailedError(
        reason,
        effective_status,
        screenshot_path,
        health_status=health_status,
    )


def _run_open_login(
    page,
    task,
    account,
    payload,
    screenshot_dir,
    logger,
    platform: str = "instagram",
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    login_username = str(payload.get("login_username") or payload.get("username") or "").strip()
    login_password = str(payload.get("login_password") or payload.get("password") or "").strip()
    has_credentials = bool(login_username and login_password)
    requested_auto_submit = payload.get("auto_submit")
    auto_submit = has_credentials if requested_auto_submit is None else bool(requested_auto_submit) and has_credentials
    # Detect the persistent platform session before navigating to any login URL.
    # This preserves a valid session without clearing or retyping credentials.
    _goto(page, _platform_home(platform), logger, "open_login")
    wait_seconds = int(payload.get("login_wait_seconds") or os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "3600"))
    wait_seconds = max(30, min(wait_seconds, 3600))
    default_login_attempts = 1 if platform == "threads" else 2
    max_login_attempts = _int_payload_or_env(
        payload,
        "max_login_attempts",
        "SOCIAL_AUTOMATION_LOGIN_MAX_ATTEMPTS",
        default_login_attempts,
        1,
        8,
    )
    max_self_heal_attempts = _int_payload_or_env(
        payload,
        "max_self_heal_attempts",
        "SOCIAL_AUTOMATION_LOGIN_SELF_HEAL_ATTEMPTS",
        DEFAULT_LOGIN_SELF_HEAL_ATTEMPTS,
        0,
        12,
    )
    default_submit_grace_seconds = 6 if platform == "threads" else 30
    submit_grace_seconds = _int_payload_or_env(
        payload,
        "submit_grace_seconds",
        "SOCIAL_AUTOMATION_LOGIN_SUBMIT_GRACE_SECONDS",
        default_submit_grace_seconds,
        5,
        120,
    )
    wait_for_manual = bool(payload.get("wait_for_manual", True))
    manual_only_on_verification = bool(payload.get("manual_only_on_verification", False))
    if platform == "threads" and not auto_submit:
        _prepare_manual_threads_login_page(page, logger)
    logger.log("info", "open_login", "浏览器登录窗口已打开。", {"wait_seconds": wait_seconds, "auto_submit": auto_submit})
    initial_status: dict[str, Any] | None = None
    if not has_credentials:
        current_status = _detect_platform_login_state(page, platform)
        if platform == "threads":
            current_status = _restore_threads_after_instagram_login(page, current_status, logger)
        if (
            str(current_status.get("status") or "") not in {"post_login_interstitial", "ready"}
            and not _verification_visible(page)
        ):
            return _handoff_open_login_to_manual(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                context_control,
                current_status,
                str(current_status.get("reason") or "请在登录助手中填写账号和密码。"),
                stage="login_manual_credentials_required",
            )
        initial_status = current_status
    deadline = time.time() + wait_seconds
    last_status: dict[str, Any] = dict(initial_status or {})
    login_attempts = 0
    self_heal_attempts = 0
    verification_hits = 0
    verification_logged = False
    last_submit_monotonic: float | None = None
    threads_restore_attempted = False
    while time.time() < deadline:
        _raise_if_cancelled(cancel_event)
        if auto_submit and _manual_takeover_requested(context_control):
            auto_submit = False
            logger.log(
                "warn",
                "manual_takeover",
                "已立即停止自动登录操作，当前浏览器已切换为人工接管。",
                {"url": _safe_navigation_url(page.url)},
            )
            return _wait_for_manual_login_completion(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                "用户已切换为人工接管，自动登录提示已停止。",
                str(last_status.get("status") or "need_verification"),
                "",
                last_status,
                context_control,
            )
        post_submit_waiting = bool(
            last_submit_monotonic is not None
            and (time.monotonic() - last_submit_monotonic) < submit_grace_seconds
        )
        post_submit_grace_expired = bool(last_submit_monotonic is not None and not post_submit_waiting)
        try:
            if initial_status is not None:
                last_status = initial_status
                initial_status = None
            else:
                last_status = _detect_platform_login_state(page, platform)
            if platform == "threads" and str(last_status.get("status") or "") == "threads_restore_required":
                if threads_restore_attempted:
                    last_status = {
                        "status": "cookie_expired",
                        "reason": "Instagram handoff already returned to Threads, but the Threads session is still not ready.",
                        "url": str(page.url or ""),
                    }
                else:
                    threads_restore_attempted = True
                    last_status = _restore_threads_after_instagram_login(page, last_status, logger)
            elif platform == "threads":
                last_status = _restore_threads_after_instagram_login(page, last_status, logger)
            if str(last_status.get("status") or "") == "post_login_interstitial":
                _publish_login_assistance_state(page, context_control, last_status)
                if _resolve_instagram_post_login_interstitial(page, logger):
                    if platform == "threads":
                        _goto(page, THREADS_HOME, logger, "threads_post_login_notice_return")
                    last_submit_monotonic = None
                    continue
                logger.log(
                    "warn",
                    "instagram_post_login_interstitial",
                    "Instagram 登录后的确认窗口仍未关闭，继续等待公共登录链路处理。",
                    {"url": _safe_navigation_url(page.url), "details": last_status},
                )
                time.sleep(2)
                continue
            if str(last_status.get("status") or "") != "ready":
                _publish_login_assistance_state(page, context_control, last_status)
            if last_status.get("status") == "ready":
                stable_status = _confirm_platform_ready(page, platform, logger, cancel_event)
                if stable_status.get("status") == "ready":
                    _publish_login_assistance_state(page, context_control, stable_status, handoff=True)
                    _complete_pending_totp_verification(context_control)
                    _report_account_login_status(context_control, "ready", logger)
                    shot = _screenshot(page, screenshot_dir, task, "login_complete", logger)
                    logger.log(
                        "info",
                        "completion_node",
                        f"{_platform_name(platform)} 登录成功节点已确认。",
                        {"url": _safe_navigation_url(page.url), "details": _safe_login_status(stable_status)},
                        shot,
                    )
                    return {"ok": True, "status": "ready", "screenshot_path": shot, "details": stable_status}
                last_status = stable_status
                if str(last_status.get("status") or "") != "ready":
                    _publish_login_assistance_state(page, context_control, last_status)
            if _verification_visible(page):
                _publish_login_assistance_state(
                    page,
                    context_control,
                    {
                        "status": "need_verification",
                        "reason": "检测到验证码或安全挑战，正在同步登录助手。",
                        "url": str(getattr(page, "url", "") or ""),
                    },
                )
                totp_result = _try_auto_totp_challenge(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    context_control,
                )
                if totp_result is not None:
                    last_status = totp_result
                    if str(totp_result.get("status") or "") == "totp_submitted":
                        _mark_totp_verification_pending(context_control)
                    if str(totp_result.get("status") or "") in {"ready", "totp_submitted"}:
                        continue
                verification_hits += 1
                _report_account_login_status(context_control, "need_verification", logger)
                _request_manual_takeover(context_control)
                if not verification_logged:
                    shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
                    logger.log(
                        "warn",
                        "login_verification_required",
                        "检测到验证码或安全挑战，正在等待人工在浏览器中处理。",
                        {"url": _safe_navigation_url(page.url), "screenshot_path": shot},
                        shot,
                    )
                    verification_logged = True
                return _wait_or_raise_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    f"{_platform_name(platform)} 需要人工验证，浏览器会保持打开直到验证完成或任务取消。",
                    "need_verification",
                    shot,
                    last_status,
                    wait_for_manual,
                    manual_only_on_verification,
                    context_control,
                )
            if last_status.get("status") == "invalid_credentials":
                return _handoff_open_login_to_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    context_control,
                    last_status,
                    str(last_status.get("reason") or "平台提示账号或密码不正确，请重新输入后再提交。"),
                    stage="login_invalid_credentials",
                )
            if last_status.get("status") == "need_verification":
                shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
                verification_hits += 1
                _report_account_login_status(context_control, "need_verification", logger)
                logger.log(
                    "warn",
                    "login_verification_required",
                    f"{_platform_name(platform)} 需要输入验证码。",
                    {"url": _safe_navigation_url(page.url), "screenshot_path": shot, "details": _safe_login_status(last_status)},
                    shot,
                )
                _request_manual_takeover(context_control)
                return _wait_or_raise_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    f"{_platform_name(platform)} 需要人工验证，浏览器会保持打开直到验证完成或任务取消。",
                    "need_verification",
                    shot,
                    last_status,
                    wait_for_manual,
                    manual_only_on_verification,
                    context_control,
                )
            if last_status.get("status") == "transient_error":
                shot = _screenshot(page, screenshot_dir, task, "login_transient_error", logger)
                logger.log(
                    "warn",
                    "login_transient_error",
                    f"{_platform_name(platform)} 页面暂时异常，正在决定是否继续自动恢复。",
                    {"url": _safe_navigation_url(page.url), "screenshot_path": shot, "details": _safe_login_status(last_status)},
                    shot,
                )
                if auto_submit and post_submit_waiting:
                    time.sleep(3)
                    continue
                if auto_submit and self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, "login_transient_error", self_heal_attempts, cancel_event, context_control)
                    continue
                if auto_submit:
                    return _handoff_open_login_to_manual(
                        page,
                        task,
                        screenshot_dir,
                        logger,
                        platform,
                        cancel_event,
                        context_control,
                        last_status,
                        f"{_platform_name(platform)} 页面暂时异常，自动登录已停止，请人工继续。",
                        stage="login_transient_error_manual",
                        screenshot_path=shot,
                    )
                return _wait_or_raise_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    f"{_platform_name(platform)} 页面暂时异常，请在已打开的浏览器中继续。",
                    "transient_error",
                    shot,
                    last_status,
                    wait_for_manual,
                    manual_only_on_verification,
                    context_control,
                )
            if (
                auto_submit
                and not post_submit_waiting
                and not post_submit_grace_expired
                and login_attempts < max_login_attempts
                and str(last_status.get("status") or "") != "need_verification"
            ):
                if _auto_submit_login_form(page, platform, payload, logger, task, screenshot_dir, context_control):
                    login_attempts += 1
                    last_submit_monotonic = time.monotonic()
                    if isinstance(context_control, dict):
                        try:
                            submitted_at = float(context_control.pop("login_submission_monotonic", 0) or 0)
                        except (TypeError, ValueError):
                            submitted_at = 0
                        if submitted_at > 0:
                            last_submit_monotonic = submitted_at
                    _publish_login_assistance_state(
                        page,
                        context_control,
                        {
                            "status": "totp_submitted",
                            "reason": "登录表单已提交，正在等待登录成功或平台验证。",
                            "url": str(getattr(page, "url", "") or ""),
                        },
                    )
                    continue
                elif _manual_takeover_requested(context_control):
                    continue
                elif self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, "auto_login_form_not_ready", self_heal_attempts, cancel_event, context_control)
                    continue
        except NeedManualError as exc:
            _publish_login_assistance_state(
                page,
                context_control,
                {
                    "status": str(getattr(exc, "status", "") or "need_manual"),
                    "reason": str(exc),
                    "health_status": str(getattr(exc, "health_status", "") or ""),
                },
                handoff=True,
            )
            raise
        except AutoLoginFailedError as exc:
            _publish_login_assistance_state(
                page,
                context_control,
                {
                    "status": str(getattr(exc, "status", "") or "failed"),
                    "reason": str(exc),
                },
                handoff=True,
            )
            raise
        except Exception as exc:
            message = str(exc)
            if "社交自动化任务已取消" in message:
                _publish_login_assistance_state(page, context_control, {"status": "cancelled", "reason": message}, handoff=True)
                raise
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                closed_reason = f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新打开登录窗口并保持到账号就绪。"
                _publish_login_assistance_state(page, context_control, {"status": "failed", "reason": closed_reason}, handoff=True)
                raise NeedManualError(closed_reason, "cookie_expired") from exc
            if _is_transient_navigation_exception(message):
                last_status = {
                    "status": "transient_error",
                    "reason": f"{_platform_name(platform)} 页面暂时打不开，正在重试。",
                    "url": str(getattr(page, "url", "") or ""),
                }
                _publish_login_assistance_state(page, context_control, last_status)
                logger.log(
                    "warn",
                    "open_login_transient_navigation",
                    "Login navigation failed temporarily; keeping the failure classified as transient instead of manual takeover.",
                    {"details": _safe_login_status(last_status)},
                )
            else:
                logger.log("warn", "open_login_poll", f"登录窗口状态检查失败：{exc}")
                _publish_login_assistance_state(
                    page,
                    context_control,
                    {"status": "transient_error", "reason": f"登录状态检查失败：{message.splitlines()[0][:240]}"},
                )
        # A manual login session belongs to the user.  Do not press Escape,
        # reload, or navigate away from the page they are actively handling.
        if auto_submit and post_submit_waiting:
            time.sleep(3)
            continue
        if post_submit_grace_expired:
            last_submit_monotonic = None
            if auto_submit and login_attempts > 0:
                if login_attempts < max_login_attempts and str(last_status.get("status") or "") == "cookie_expired":
                    time.sleep(1)
                    continue
                return _handoff_open_login_to_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    context_control,
                    last_status,
                    f"{_platform_name(platform)} 自动登录提交后仍未成功，已转为人工接手。",
                    stage="login_auto_submit_unsuccessful",
                )
        if auto_submit:
            if login_attempts > 0:
                return _handoff_open_login_to_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    context_control,
                    last_status,
                    f"{_platform_name(platform)} 自动登录未成功，已转为人工接手。",
                    stage="login_auto_submit_unsuccessful",
                )
            if self_heal_attempts < max_self_heal_attempts:
                self_heal_attempts += 1
                _self_heal_login_page(page, platform, logger, task, screenshot_dir, "login_state_not_ready", self_heal_attempts, cancel_event, context_control)
                continue
            return _handoff_open_login_to_manual(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                context_control,
                last_status,
                f"{_platform_name(platform)} 自动登录已重试结束，仍未登录，请人工输入账号和密码。",
                stage="login_recovery_exhausted",
            )
        time.sleep(3 if auto_submit else 10)
    return _handoff_open_login_to_manual(
        page,
        task,
        screenshot_dir,
        logger,
        platform,
        cancel_event,
        context_control,
        last_status,
        f"自动登录等待超时：{last_status.get('reason') or '账号未就绪'}。已转为人工接手。",
        stage="login_wait_timeout",
    )


def _login_assistance_status_page(page: Any, context_control: dict[str, Any] | None) -> Any:
    if not isinstance(context_control, dict):
        return page
    candidate = context_control.get("login_assistance_action_page")
    if candidate is None:
        return page
    try:
        if bool(getattr(candidate, "is_closed", lambda: False)()):
            context_control.pop("login_assistance_action_page", None)
            return page
    except Exception:
        context_control.pop("login_assistance_action_page", None)
        return page
    return candidate


def _wait_for_manual_login_completion(
    page,
    task,
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    reason: str,
    status: str = "need_verification",
    screenshot_path: str = "",
    last_status: dict[str, Any] | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    try:
        manual_login_timeout_seconds = int(payload.get("manual_login_timeout_seconds"))
    except (TypeError, ValueError):
        manual_login_timeout_seconds = DEFAULT_MANUAL_LOGIN_TIMEOUT_SECONDS
    manual_login_timeout_seconds = max(
        MIN_MANUAL_LOGIN_TIMEOUT_SECONDS,
        min(manual_login_timeout_seconds, MAX_MANUAL_LOGIN_TIMEOUT_SECONDS),
    )
    deadline = time.monotonic() + manual_login_timeout_seconds
    if isinstance(context_control, dict):
        context_control["login_assistance_expires_at"] = int(time.time()) + manual_login_timeout_seconds
    logger.log(
        "warn",
        "need_manual",
        reason,
        {"status": status, "screenshot_path": screenshot_path, "details": last_status or {}},
        screenshot_path,
    )
    last_seen_status = str(status or "")
    initial_status = dict(last_status or {})
    initial_status.setdefault("status", status)
    initial_status.setdefault("reason", reason)
    _publish_login_assistance_state(page, context_control, initial_status, handoff=True)

    def raise_manual_login_timeout() -> None:
        shot = _screenshot(page, screenshot_dir, task, "manual_login_timeout", logger)
        message = f"{_platform_name(platform)} 人工处理已超过 {manual_login_timeout_seconds // 60} 分钟，请重新打开登录任务。"
        logger.log(
            "error",
            "manual_login_timeout",
            message,
            {
                "status": "manual_login_timeout",
                "timeout_seconds": manual_login_timeout_seconds,
                "last_status": last_seen_status,
            },
            shot,
        )
        _publish_login_assistance_state(
            page,
            context_control,
            {"status": "manual_login_timeout", "reason": message},
            handoff=True,
        )
        raise ManualTimeoutError(
            message,
            "manual_login_timeout",
            shot,
            account_status="cookie_expired",
        )

    try:
        while True:
            _raise_if_cancelled(cancel_event)
            if time.monotonic() >= deadline:
                raise_manual_login_timeout()
            status_page = _login_assistance_status_page(page, context_control)
            try:
                status_page.title(timeout=1000)
            except Exception as exc:
                message = str(exc)
                if "Target page, context or browser has been closed" in message or "has been closed" in message:
                    closed_reason = f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新启动登录任务。"
                    _publish_login_assistance_state(page, context_control, {"status": "failed", "reason": closed_reason}, handoff=True)
                    raise AutoLoginFailedError(
                        closed_reason,
                        "cookie_expired",
                        screenshot_path,
                    ) from exc
            if _process_login_assistance_action(page, platform, logger, context_control):
                _wait_for_cancellation(0.8, cancel_event)
                continue
            if time.monotonic() >= deadline:
                raise_manual_login_timeout()
            status_page = _login_assistance_status_page(page, context_control)
            current_status = _detect_platform_login_state(page, platform)
            if status_page is not page and str(current_status.get("status") or "") != "ready":
                current_status = _detect_platform_login_state(status_page, platform)
            else:
                status_page = page
            if platform == "threads":
                current_status = _restore_threads_after_instagram_login(status_page, current_status, logger)
            if time.monotonic() >= deadline:
                raise_manual_login_timeout()
            current_code = str(current_status.get("status") or "").strip()
            _publish_login_assistance_state(status_page, context_control, current_status, handoff=True)
            if (
                str(current_status.get("health_status") or "").strip().lower() == "banned"
                or current_code.lower() in {"banned", "disabled"}
            ):
                ban_reason = str(
                    current_status.get("reason")
                    or f"{_platform_name(platform)} 检测到账号进入账号封控状态，已停止本次自动化任务。"
                )
                _report_account_login_status(context_control, "disabled", logger)
                shot = _screenshot(status_page, screenshot_dir, task, "account_banned", logger)
                logger.log(
                    "error",
                    "account_banned",
                    ban_reason,
                    {"status": "disabled", "health_status": "banned", "details": _safe_login_status(current_status)},
                    shot,
                )
                raise AutoLoginFailedError(
                    ban_reason,
                    "disabled",
                    shot,
                    health_status="banned",
                )
            if current_code == "post_login_interstitial":
                if _resolve_instagram_post_login_interstitial(status_page, logger):
                    if platform == "threads":
                        _goto(status_page, THREADS_HOME, logger, "threads_post_login_notice_return")
                    continue
            if current_code == "ready":
                stable_status = _confirm_platform_ready(status_page, platform, logger, cancel_event)
                if time.monotonic() >= deadline:
                    raise_manual_login_timeout()
                if stable_status.get("status") == "ready":
                    _complete_pending_totp_verification(context_control)
                    _report_account_login_status(context_control, "ready", logger)
                    shot = _screenshot(status_page, screenshot_dir, task, "login_complete", logger)
                    logger.log(
                        "info",
                        "completion_node",
                        f"{_platform_name(platform)} 登录成功节点已确认。",
                        {"url": _safe_navigation_url(status_page.url), "details": _safe_login_status(stable_status), "manual_completion": True},
                        shot,
                    )
                    _publish_login_assistance_state(status_page, context_control, stable_status, handoff=True)
                    return {"ok": True, "status": "ready", "screenshot_path": shot, "details": stable_status}
                current_status = stable_status
                current_code = str(current_status.get("status") or "").strip()
            if current_code and current_code != last_seen_status:
                logger.log(
                    "info" if current_code == "ready" else "warn",
                    "manual_login_status",
                    f"{_platform_name(platform)} 人工登录状态已更新。",
                    {"status": current_code, "details": current_status},
                )
                last_seen_status = current_code
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise_manual_login_timeout()
            wait_seconds = min(1.0, remaining_seconds)
            wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
            if callable(wait):
                if wait(wait_seconds):
                    _raise_if_cancelled(cancel_event)
            else:
                time.sleep(wait_seconds)
    except RuntimeError as exc:
        if "社交自动化任务已取消" in str(exc):
            _publish_login_assistance_state(page, context_control, {"status": "cancelled", "reason": str(exc)}, handoff=True)
        raise


def _login_assistance_has_cjk(value: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in str(value or ""))


def _login_assistance_message(reason: str, fallback: str) -> str:
    clean = str(reason or "").strip()
    if clean and _login_assistance_has_cjk(clean):
        return clean
    return str(fallback or clean or "正在同步登录状态。")


def _login_assistance_presentation(status: dict[str, Any] | None) -> dict[str, Any]:
    current = dict(status or {})
    status_code = str(current.get("status") or "").strip().lower()
    challenge_type = str(current.get("challenge_type") or "").strip().lower()
    health = str(current.get("health_status") or "").strip().lower()
    reason = str(current.get("reason") or "").strip()
    actions = _login_assistance_normalize_actions(current.get("actions"))
    if status_code == "ready":
        return {"phase": "success", "kind": "success", "title": "登录成功", "message": "账号登录状态已确认，可以开始使用。", "challenge_type": challenge_type}
    if health == "banned" or status_code in {"banned", "disabled"}:
        return {
            "phase": "error",
            "kind": "error",
            "title": "账号封控",
            "message": _login_assistance_message(reason, "当前账号疑似被停用或封禁，无法继续自动登录。"),
            "challenge_type": challenge_type,
        }
    if status_code == "manual_login_timeout":
        return {
            "phase": "error",
            "kind": "error",
            "title": "处理超时",
            "message": _login_assistance_message(reason, "人工处理超时，请重新打开登录任务。"),
            "challenge_type": challenge_type,
        }
    if status_code == "cancelled":
        return {
            "phase": "error",
            "kind": "error",
            "title": "登录已停止",
            "message": _login_assistance_message(reason, "本次登录任务已取消。"),
            "challenge_type": challenge_type,
        }
    if status_code in {"failed", "auto_login_failed"}:
        return {
            "phase": "error",
            "kind": "error",
            "title": "登录未完成",
            "message": _login_assistance_message(reason, "本次登录任务没有完成，请稍后重试。"),
            "challenge_type": challenge_type,
        }
    if status_code in {"invalid_credentials", "cookie_expired"}:
        if status_code == "invalid_credentials":
            title = "账号或密码不正确"
            fallback = "平台提示账号或密码错误，请重新输入后再提交。"
        else:
            title = "需要登录信息"
            fallback = "自动登录未成功，请对照当前页面填写账号和密码。"
        return {
            "phase": "attention",
            "kind": "credentials",
            "title": title,
            "message": _login_assistance_message(reason, fallback),
            "field_label": "账号、邮箱或手机号",
            "submit_label": "提交并继续",
            "challenge_type": challenge_type,
            "actions": actions,
        }
    if status_code == "need_verification":
        code_labels = {
            "sms_code": ("输入短信验证码", "短信验证码", "numeric"),
            "email_code": ("输入邮箱验证码", "邮箱验证码", "text"),
            "authenticator_totp": ("输入身份验证器验证码", "验证码", "numeric"),
            "unknown_code": ("输入验证码", "验证码", "text"),
            "verification": ("输入验证码", "验证码", "text"),
            "numeric_image_captcha": ("输入图片验证码", "图片验证码", "text"),
        }
        if challenge_type in code_labels:
            title, label, input_mode = code_labels[challenge_type]
            return {
                "phase": "attention",
                "kind": "verification_code",
                "title": title,
                "message": _login_assistance_message(
                    reason,
                    "请对照实时画面输入图片中的验证码。" if challenge_type == "numeric_image_captcha" else "请填写平台当前要求的验证码。",
                ),
                "field_label": label,
                "input_mode": input_mode,
                "submit_label": "提交验证码",
                "challenge_type": challenge_type,
            }
        if challenge_type == "method_selection":
            return {
                "phase": "attention",
                "kind": "choice" if actions else "browser_interaction",
                "title": "选择验证方式",
                "message": _login_assistance_message(reason, "请选择一种验证方式，或打开实时画面继续。"),
                "submit_label": "查看验证页面",
                "challenge_type": challenge_type,
                "actions": actions,
            }
        if challenge_type in {"identity_challenge", "human_verification", "unknown_challenge"}:
            titles = {
                "identity_challenge": "需要身份确认",
                "human_verification": "需要真人验证",
                "unknown_challenge": "需要人工验证",
            }
            return {
                "phase": "attention",
                "kind": "choice" if actions else "browser_interaction",
                "title": titles[challenge_type],
                "message": _login_assistance_message(reason, "请打开实时画面完成当前验证，或点击助手中的可用按钮。"),
                "submit_label": "查看验证页面",
                "challenge_type": challenge_type,
                "actions": actions,
            }
        return {
            "phase": "attention",
            "kind": "choice" if actions else "browser_interaction",
            "title": "需要人工验证",
            "message": _login_assistance_message(reason, "平台要求完成身份确认，请打开实时画面继续。"),
            "submit_label": "查看验证页面",
            "challenge_type": challenge_type,
            "actions": actions,
        }
    if status_code == "post_login_interstitial":
        return {
            "phase": "running",
            "kind": "progress",
            "title": "正在处理登录后提示",
            "message": _login_assistance_message(reason, "平台正在显示登录后确认页，系统会继续处理。"),
            "challenge_type": challenge_type,
        }
    if status_code == "transient_error":
        return {
            "phase": "running",
            "kind": "progress",
            "title": "正在执行登录",
            "message": _login_assistance_message(reason, "页面暂时异常，正在重试。"),
            "challenge_type": challenge_type,
        }
    if status_code == "totp_submitted":
        return {
            "phase": "running",
            "kind": "progress",
            "title": "正在验证",
            "message": _login_assistance_message(reason, "验证信息已提交，正在等待平台确认。"),
            "challenge_type": challenge_type,
        }
    if status_code == "threads_restore_required":
        return {
            "phase": "running",
            "kind": "progress",
            "title": "正在确认 Threads 登录",
            "message": _login_assistance_message(reason, "已完成 Instagram 登录，正在返回 Threads 确认会话。"),
            "challenge_type": challenge_type,
        }
    if status_code == "need_manual":
        return {
            "phase": "attention",
            "kind": "browser_interaction",
            "title": "需要人工处理",
            "message": _login_assistance_message(reason, "请打开实时画面继续当前登录。"),
            "submit_label": "查看实时画面",
            "challenge_type": challenge_type,
        }
    return {
        "phase": "running",
        "kind": "progress",
        "title": "正在执行登录",
        "message": _login_assistance_message(reason, "正在检查页面并同步登录状态。"),
        "challenge_type": challenge_type,
    }


LOGIN_ASSISTANCE_CHOICE_GROUPS = {
    "method_selection": [
        "Text message", "Send SMS", "短信", "简讯", "簡訊", "手機簡訊",
        "Email", "Send email", "电子邮件", "邮箱", "電子郵件",
        "Authentication app", "Authenticator app", "身份验证应用", "验证器应用",
        "WhatsApp",
        "Try another way", "尝试其他方式", "试试其他方法", "選擇其他方式",
    ],
    "identity_or_human": [
        "Continue", "Confirm", "Next", "继续", "确认", "下一步",
        "Try another way", "尝试其他方式",
    ],
}


def _login_assistance_normalize_actions(raw: Any) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw or []:
        if isinstance(item, str):
            label = item.strip()
            title = label
        elif isinstance(item, dict):
            label = str(item.get("label") or item.get("value") or "").strip()
            title = str(item.get("title") or label).strip()
        else:
            continue
        key = label.lower()
        if not label or key in seen:
            continue
        seen.add(key)
        actions.append({"kind": "choice", "label": label, "title": title or label})
    return actions


def _login_assistance_choice_labels(status: dict[str, Any]) -> list[str]:
    challenge_type = str(status.get("challenge_type") or "").strip().lower()
    if challenge_type == "method_selection":
        return list(LOGIN_ASSISTANCE_CHOICE_GROUPS["method_selection"])
    if challenge_type in {"identity_challenge", "human_verification", "unknown_challenge"}:
        return list(LOGIN_ASSISTANCE_CHOICE_GROUPS["identity_or_human"])
    return []


def _login_assistance_collect_choices(page: Any, status: dict[str, Any]) -> list[dict[str, str]]:
    labels = _login_assistance_choice_labels(status)
    if not labels or page is None:
        return []
    found: list[str] = []
    script = """labels => {
        const wanted = new Set((labels || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
        const matched = [];
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="radio"], [role="option"]'));
        for (const node of nodes) {
            const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text || !wanted.has(text.toLowerCase())) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const style = window.getComputedStyle(node);
            if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
            if (!matched.some((item) => item.toLowerCase() === text.toLowerCase())) matched.push(text);
        }
        return matched;
    }"""
    surfaces = []
    with contextlib.suppress(Exception):
        surfaces = [surface for _action_page, surface in _login_assistance_surfaces(page)]
    if not surfaces:
        surfaces = [page]
    for surface in surfaces:
        evaluate = getattr(surface, "evaluate", None)
        if not callable(evaluate):
            continue
        with contextlib.suppress(Exception):
            visible = evaluate(script, labels)
            if isinstance(visible, list):
                found.extend(str(item) for item in visible if str(item or "").strip())
    return _login_assistance_normalize_actions(found)


def _login_assistance_requires_user(status: dict[str, Any] | None, context_control: dict[str, Any] | None = None) -> bool:
    current = dict(status or {})
    status_code = str(current.get("status") or "").strip().lower()
    challenge_type = str(current.get("challenge_type") or "").strip().lower()
    health = str(current.get("health_status") or "").strip().lower()
    if health == "banned" or status_code in {
        "banned",
        "disabled",
        "failed",
        "auto_login_failed",
        "cancelled",
        "manual_login_timeout",
        "invalid_credentials",
        "need_manual",
    }:
        return True
    if status_code == "ready":
        return True
    if status_code != "need_verification":
        return False
    if challenge_type in {
        "sms_code",
        "email_code",
        "unknown_code",
        "verification",
        "numeric_image_captcha",
        "method_selection",
        "identity_challenge",
        "human_verification",
        "unknown_challenge",
    }:
        return True
    if challenge_type in {"authenticator_totp", "", "none"}:
        return _totp_provider(context_control) is None
    return True


def _login_assistance_is_milestone(presentation: dict[str, Any] | None) -> bool:
    current = dict(presentation or {})
    phase = str(current.get("phase") or "").strip().lower()
    kind = str(current.get("kind") or "").strip().lower()
    if phase in {"success", "error", "attention"}:
        return True
    return kind in {"credentials", "verification_code", "choice", "browser_interaction", "success", "error"}


def _login_assistance_code_rejected(page: Any) -> bool:
    text = ""
    with contextlib.suppress(Exception):
        text = _page_body_text_lower(page, timeout_ms=1000)
    return any(
        marker in text
        for marker in (
            "incorrect code",
            "code you entered is incorrect",
            "invalid code",
            "code isn't valid",
            "code is not valid",
            "wrong code",
            "code has expired",
            "code expired",
            "expired code",
            "验证码不正确",
            "验证码无效",
            "验证码错误",
            "验证码已过期",
            "请重新输入验证码",
        )
    )


def _login_assistance_submission_rejected(page: Any, submitted_kind: str, status: dict[str, Any] | None) -> bool:
    kind = str(submitted_kind or "").strip().lower()
    current = dict(status or {})
    if kind == "verification_code":
        return _login_assistance_code_rejected(page)
    if kind == "credentials":
        code = str(current.get("status") or "").strip().lower()
        if code == "invalid_credentials" or _page_shows_invalid_credentials(page):
            return True
        # Threads/Instagram can retain the login form briefly after the mapped
        # submit succeeds.  That transient page must remain "正在验证" rather
        # than being rendered as a fresh credentials prompt.
        return False
    return False


def _login_assistance_credentials_submission_waiting(context_control: dict[str, Any] | None) -> bool:
    if not isinstance(context_control, dict):
        return False
    try:
        submitted_at = float(context_control.get("login_assistance_credentials_submitted_at") or 0)
    except (TypeError, ValueError):
        return False
    return submitted_at > 0 and (time.monotonic() - submitted_at) < LOGIN_ASSISTANCE_CREDENTIAL_SUBMIT_SETTLE_SECONDS


def _login_assistance_verification_submission_waiting(context_control: dict[str, Any] | None) -> bool:
    if not isinstance(context_control, dict):
        return False
    try:
        submitted_at = float(context_control.get("login_assistance_verification_submitted_at") or 0)
    except (TypeError, ValueError):
        return False
    return submitted_at > 0 and (time.monotonic() - submitted_at) < LOGIN_ASSISTANCE_VERIFICATION_SUBMIT_SETTLE_SECONDS


def _login_assistance_verification_credentials_waiting(
    page: Any,
    context_control: dict[str, Any] | None,
    status: dict[str, Any] | None,
    presentation: dict[str, Any] | None,
) -> bool:
    if not isinstance(context_control, dict):
        return False
    candidate_key = "login_assistance_verification_credentials_candidate_at"
    if (
        str(context_control.get("login_assistance_submitted_kind") or "").strip().lower() != "verification_code"
        or str((presentation or {}).get("kind") or "").strip().lower() != "credentials"
    ):
        context_control.pop(candidate_key, None)
        return False
    if str((status or {}).get("status") or "").strip().lower() == "invalid_credentials" or _page_shows_invalid_credentials(page):
        context_control.pop(candidate_key, None)
        return False
    if _mapped_login_credentials(page) is None:
        context_control.pop(candidate_key, None)
        return True
    now = time.monotonic()
    try:
        candidate_at = float(context_control.get(candidate_key) or 0)
    except (TypeError, ValueError):
        candidate_at = 0
    if candidate_at <= 0:
        context_control[candidate_key] = now
        return True
    if (now - candidate_at) < LOGIN_ASSISTANCE_VERIFICATION_CREDENTIAL_STABLE_SECONDS:
        return True
    context_control.pop(candidate_key, None)
    return False


def _login_assistance_same_prompt_after_submit(
    submitted_kind: str,
    submitted_challenge: str,
    presentation: dict[str, Any] | None,
) -> bool:
    current = dict(presentation or {})
    next_kind = str(current.get("kind") or "").strip().lower()
    next_challenge = str(current.get("challenge_type") or "").strip().lower()
    kind = str(submitted_kind or "").strip().lower()
    if kind == "verification_code":
        if next_kind != "verification_code":
            return False
        previous = str(submitted_challenge or "").strip().lower()
        return not previous or not next_challenge or previous == next_challenge
    return kind == next_kind and kind in {"credentials", "choice"}


def _login_assistance_signature(presentation: dict[str, Any] | None) -> tuple[str, ...]:
    current = dict(presentation or {})
    actions = _login_assistance_normalize_actions(current.get("actions"))
    return (
        str(current.get("phase") or ""),
        str(current.get("kind") or ""),
        str(current.get("title") or ""),
        str(current.get("message") or ""),
        str(current.get("field_label") or ""),
        str(current.get("challenge_type") or ""),
        "|".join(item["label"] for item in actions),
    )


def _publish_login_assistance_state(
    page: Any,
    context_control: dict[str, Any] | None,
    status: dict[str, Any] | None,
    *,
    handoff: bool = False,
) -> None:
    if not isinstance(context_control, dict):
        return
    current = dict(status or {})
    if str(current.get("status") or "").strip().lower() == "need_verification" and not current.get("challenge_type"):
        with contextlib.suppress(Exception):
            current["challenge_type"] = str(_classify_verification_challenge(page).get("type") or "")
    if str(current.get("status") or "").strip().lower() == "post_login_interstitial":
        return
    if not handoff and not _login_assistance_requires_user(current, context_control):
        return
    if "actions" not in current and _login_assistance_choice_labels(current):
        with contextlib.suppress(Exception):
            current["actions"] = _login_assistance_collect_choices(page, current)
    presentation = _login_assistance_presentation(current)
    if handoff and not _login_assistance_is_milestone(presentation):
        current = {
            **current,
            "status": "cookie_expired",
            "reason": str(current.get("reason") or "自动登录未成功，请人工输入账号和密码。"),
        }
        if not _login_assistance_has_cjk(str(current.get("reason") or "")):
            current["reason"] = "自动登录未成功，请人工输入账号和密码。"
        presentation = _login_assistance_presentation(current)
    submitted_kind = str(context_control.get("login_assistance_submitted_kind") or "").strip().lower()
    submitted_challenge = str(context_control.get("login_assistance_submitted_challenge") or "").strip().lower()
    if _login_assistance_verification_credentials_waiting(page, context_control, current, presentation):
        return
    if submitted_kind and _login_assistance_same_prompt_after_submit(submitted_kind, submitted_challenge, presentation):
        rejected = _login_assistance_submission_rejected(page, submitted_kind, current)
        if submitted_kind == "credentials":
            if _login_assistance_credentials_submission_waiting(context_control) and not rejected:
                return
            if not rejected and not context_control.get("login_assistance_credentials_submitted_at"):
                return
        elif submitted_kind == "verification_code" and _login_assistance_verification_submission_waiting(context_control) and not rejected:
            return
        context_control.pop("login_assistance_submitted_kind", None)
        context_control.pop("login_assistance_submitted_challenge", None)
        context_control.pop("login_assistance_credentials_submitted_at", None)
        context_control.pop("login_assistance_verification_submitted_at", None)
        if submitted_kind == "verification_code":
            current["reason"] = (
                "验证码未通过，请重新输入。"
                if rejected
                else "平台尚未确认当前验证码，请检查实时画面或重新输入。"
            )
            presentation = _login_assistance_presentation(current)
        elif submitted_kind == "credentials":
            if str(current.get("status") or "").strip().lower() == "invalid_credentials" or _page_shows_invalid_credentials(page):
                current["status"] = "invalid_credentials"
                current["reason"] = str(current.get("reason") or "平台提示账号或密码不正确，请重新输入。")
            else:
                current["reason"] = "登录未成功，请检查账号和密码后重新提交。"
            presentation = _login_assistance_presentation(current)
    elif submitted_kind and str(presentation.get("kind") or "") not in {submitted_kind, "progress"}:
        context_control.pop("login_assistance_submitted_kind", None)
        context_control.pop("login_assistance_submitted_challenge", None)
        context_control.pop("login_assistance_credentials_submitted_at", None)
        context_control.pop("login_assistance_verification_submitted_at", None)
    previous = context_control.get("login_assistance_state")
    if (
        not submitted_kind
        and isinstance(previous, dict)
        and str(previous.get("kind") or "").strip().lower() == "credentials"
        and str(previous.get("title") or "").strip() == "账号或密码不正确"
        and str(presentation.get("kind") or "").strip().lower() == "credentials"
        and str(current.get("status") or "").strip().lower() == "cookie_expired"
    ):
        return
    if not _login_assistance_is_milestone(presentation):
        return
    expires_at = context_control.get("login_assistance_expires_at")
    if expires_at:
        presentation["expires_at"] = int(expires_at)
    if isinstance(previous, dict) and previous.get("action_error"):
        previous_kind = str(previous.get("prompt_kind") or previous.get("kind") or "").strip().lower()
        next_kind = str(presentation.get("kind") or "").strip().lower()
        if previous_kind and previous_kind == next_kind and str(presentation.get("phase") or "") != "success":
            return
    if isinstance(previous, dict) and not previous.get("action_error"):
        previous_compare = {key: previous.get(key) for key in ("phase", "kind", "title", "message", "field_label", "challenge_type", "actions")}
        if _login_assistance_signature(previous_compare) == _login_assistance_signature(presentation):
            return
    presentation["updated_at"] = int(time.time())
    context_control["login_assistance_state"] = presentation
    session_id = str(context_control.get("live_browser_session_id") or "").strip()
    if not session_id:
        task = context_control.get("task") if isinstance(context_control.get("task"), dict) else {}
        task_id = str(context_control.get("current_task_id") or task.get("id") or "").strip()
        if task_id:
            session_id = f"live_{task_id}"
    if session_id:
        with contextlib.suppress(Exception):
            from social_automation.live_browser import update_live_browser_login_assistance

            update_live_browser_login_assistance(session_id, presentation)


def _task_assistance_caption(task: dict[str, Any] | None = None, payload: dict[str, Any] | None = None) -> str:
    data = dict(payload or {})
    if not data and isinstance(task, dict):
        raw = task.get("payload")
        if isinstance(raw, dict):
            data = raw
    return str(data.get("caption") or data.get("content") or data.get("text") or "").strip()


def _set_task_assistance(
    context_control: dict[str, Any] | None,
    *,
    phase: str = "running",
    kind: str = "progress",
    title: str = "",
    message: str = "",
    **extra: Any,
) -> None:
    if not isinstance(context_control, dict):
        return
    task = context_control.get("task") if isinstance(context_control.get("task"), dict) else {}
    content = str(extra.pop("content", "") or _task_assistance_caption(task)).strip()
    presentation = {
        "phase": phase,
        "kind": kind,
        "title": title,
        "message": message,
        "updated_at": int(time.time()),
    }
    if content:
        presentation["content"] = content[:800]
    for key, value in extra.items():
        if value in (None, "", [], {}):
            continue
        presentation[key] = value
    context_control["login_assistance_state"] = presentation
    session_id = str(context_control.get("live_browser_session_id") or "").strip()
    if not session_id:
        task_id = str(context_control.get("current_task_id") or task.get("id") or "").strip()
        if task_id:
            session_id = f"live_{task_id}"
    if session_id:
        with contextlib.suppress(Exception):
            from social_automation.live_browser import update_live_browser_login_assistance

            update_live_browser_login_assistance(session_id, presentation)


def _mapped_login_input(page: Any, selectors: list[str]) -> Any | None:
    return _visible_first(page, selectors, timeout_ms=1200)


def _login_assistance_surfaces(page: Any) -> list[tuple[Any, Any]]:
    candidates: list[Any] = []
    context = getattr(page, "context", None)
    context_pages = getattr(context, "pages", None)
    pages = list(context_pages) if isinstance(context_pages, (list, tuple)) else []
    for candidate in reversed(pages):
        if all(candidate is not existing for existing in candidates):
            candidates.append(candidate)
    if all(page is not existing for existing in candidates):
        candidates.append(page)
    surfaces: list[tuple[Any, Any]] = []
    for candidate in candidates:
        try:
            closed = bool(getattr(candidate, "is_closed", lambda: False)())
        except Exception:
            closed = False
        if closed:
            continue
        candidate_frames = getattr(candidate, "frames", None)
        frames = list(candidate_frames) if isinstance(candidate_frames, (list, tuple)) else []
        surfaces.extend((candidate, frame) for frame in reversed(frames))
        surfaces.append((candidate, candidate))
    return surfaces


def _mapped_login_credentials(page: Any) -> tuple[Any, Any, Any, Any] | None:
    username_selectors = [
        'input[name="username"]',
        'input[name="email"]',
        'input[name="phone"]',
        'input[autocomplete="username"]',
        'input[type="email"]',
        'input[type="tel"]',
        'input[aria-label*="username" i]',
        'input[aria-label*="email" i]',
        'input[aria-label*="phone" i]',
        'input[placeholder*="username" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="mobile" i]',
    ]
    password_selectors = [
        'input[name="password"]',
        'input[name="pass"]',
        'input[autocomplete="current-password"]',
        'input[type="password"]',
        'input[aria-label*="password" i]',
        'input[placeholder*="password" i]',
    ]
    for action_page, surface in _login_assistance_surfaces(page):
        username_input = _mapped_login_input(surface, username_selectors)
        password_input = _mapped_login_input(surface, password_selectors)
        if username_input is not None and password_input is not None:
            return action_page, surface, username_input, password_input
    return None


def _mapped_login_verification_code(page: Any) -> tuple[Any, Any, Any] | None:
    for action_page, surface in _login_assistance_surfaces(page):
        code_input = _verification_code_input(surface)
        if code_input is not None:
            return action_page, surface, code_input
    return None


def _set_login_assistance_pending(context_control: dict[str, Any], pending: bool) -> None:
    submission_lock = context_control.get("login_assistance_lock")
    if submission_lock is not None and hasattr(submission_lock, "__enter__"):
        with submission_lock:
            context_control["login_assistance_pending"] = bool(pending)
        return
    context_control["login_assistance_pending"] = bool(pending)


def _process_login_assistance_action(page: Any, platform: str, logger: AutomationLogger, context_control: dict[str, Any] | None) -> bool:
    if not isinstance(context_control, dict):
        return False
    actions = context_control.get("login_assistance_queue")
    if actions is None or not hasattr(actions, "get_nowait"):
        return False
    try:
        action = actions.get_nowait()
    except queue.Empty:
        return False
    if not isinstance(action, dict):
        _set_login_assistance_pending(context_control, False)
        return False
    kind = str(action.get("kind") or "").strip().lower()
    expires_at = context_control.get("login_assistance_expires_at")
    try:
        if kind == "verification_code":
            code = str(action.get("verification_code") or "").strip()
            verification = _mapped_login_verification_code(page)
            if not code or verification is None:
                raise RuntimeError("当前页面没有可填写的验证码输入框")
            action_page, action_surface, code_input = verification
            _clear_and_type(action_page, code_input, code, mode="type", logger=logger, stage="mapped_verification_code")
            clicked = _click_text_button(action_surface, logger, ["Continue", "Confirm", "Verify", "Submit", "Next", "继续", "确认", "验证", "提交", "下一步"], "mapped_verification_submit")
            if not clicked:
                action_page.keyboard.press("Enter")
            logger.log(
                "info",
                "mapped_verification_submit",
                "验证码提交动作已执行。",
                {"method": "button" if clicked else "enter", "url": _safe_navigation_url(getattr(action_page, "url", ""))},
            )
            message = "验证码已提交，正在确认登录结果。"
        elif kind == "credentials":
            username = str(action.get("login_username") or "").strip()
            password = str(action.get("login_password") or "")
            if not username or not password:
                raise RuntimeError("请完整填写登录账号和密码")
            credentials = _mapped_login_credentials(page)
            if credentials is None:
                raise RuntimeError("当前页面尚未显示账号密码输入框")
            action_page, action_surface, username_input, password_input = credentials
            _clear_and_type(action_page, username_input, username, mode="type", logger=logger, stage="mapped_login_username")
            _clear_and_type(action_page, password_input, password, mode="type", logger=logger, stage="mapped_login_password")
            clicked = _click_text_button(action_surface, logger, ["Log in", "Log In", "Login", "Continue", "登录", "登入", "继续"], "mapped_login_submit")
            if not clicked:
                action_page.keyboard.press("Enter")
            message = "登录信息已提交，正在检查账号状态。"
        elif kind == "choice":
            label = str(action.get("action_label") or action.get("label") or "").strip()
            if not label:
                raise RuntimeError("请选择一个页面操作")
            clicked = False
            for action_page, surface in _login_assistance_surfaces(page):
                if _click_text_button(surface, logger, [label], "mapped_login_choice"):
                    clicked = True
                    break
            if not clicked:
                raise RuntimeError("当前页面没有找到该操作按钮")
            message = f"已点击「{label}」，正在继续登录。"
        else:
            raise RuntimeError("当前登录步骤不支持该操作")
    except Exception as exc:
        context_control.pop("login_assistance_submitted_kind", None)
        context_control.pop("login_assistance_submitted_challenge", None)
        context_control.pop("login_assistance_credentials_submitted_at", None)
        context_control.pop("login_assistance_verification_submitted_at", None)
        context_control.pop("login_assistance_action_page", None)
        context_control["login_assistance_state"] = {"phase": "attention", "kind": kind or "browser_interaction", "prompt_kind": kind, "action_error": True, "title": "暂时无法提交", "message": str(exc)[:240], "submit_label": "重试", "updated_at": int(time.time()), **({"expires_at": int(expires_at)} if expires_at else {})}
        _set_login_assistance_pending(context_control, False)
        logger.log("warn", "login_assistance_submit_failed", "登录映射页提交失败。", {"kind": kind, "error": str(exc)[:240]})
        return True
    previous = context_control.get("login_assistance_state") if isinstance(context_control.get("login_assistance_state"), dict) else {}
    context_control["login_assistance_submitted_kind"] = kind
    context_control["login_assistance_submitted_challenge"] = str(previous.get("challenge_type") or "")
    context_control["login_assistance_action_page"] = action_page
    if kind == "credentials":
        context_control["login_assistance_credentials_submitted_at"] = time.monotonic()
    elif kind == "verification_code":
        context_control["login_assistance_verification_submitted_at"] = time.monotonic()
    progress = {
        "phase": "running",
        "kind": "progress",
        "title": "正在验证",
        "message": message,
        "updated_at": int(time.time()),
        **({"expires_at": int(expires_at)} if expires_at else {}),
    }
    context_control["login_assistance_state"] = progress
    session_id = str(context_control.get("live_browser_session_id") or "").strip()
    if session_id:
        with contextlib.suppress(Exception):
            from social_automation.live_browser import update_live_browser_login_assistance

            update_live_browser_login_assistance(session_id, progress)
    _set_login_assistance_pending(context_control, False)
    logger.log("info", "login_assistance_submitted", message, {"kind": kind, "platform": platform})
    return True


def _confirm_platform_ready(page, platform: str, logger: AutomationLogger, cancel_event: Any | None = None) -> dict[str, Any]:
    if platform == "instagram" and "/accounts/password/reset" in str(page.url or "").lower():
        _goto(page, INSTAGRAM_HOME, logger, "login_ready_home_confirm")
    last_status: dict[str, Any] = {}
    ready_hits = 0
    for index in range(4):
        _raise_if_cancelled(cancel_event)
        _sleep_between(0.8, 1.4)
        last_status = _detect_platform_login_state(page, platform)
        if (
            platform == "instagram"
            and str(last_status.get("status") or "") == "post_login_interstitial"
        ):
            ready_hits = 0
            _resolve_instagram_post_login_interstitial(page, logger)
            continue
        if last_status.get("status") == "ready":
            ready_hits += 1
            if ready_hits >= 2:
                result = dict(last_status)
                result["ready_confirmations"] = ready_hits
                return result
        else:
            ready_hits = 0
            logger.log("debug", "login_ready_confirm", "登录就绪状态仍不稳定。", {"index": index + 1, "status": last_status})
    return last_status or {"status": "cookie_expired", "reason": "登录就绪状态仍不稳定。"}


def _run_check_login(page, task, account, payload, screenshot_dir, logger, platform: str = "instagram") -> dict[str, Any]:
    status = _check_platform_login(page, platform, logger)
    health_status, health_reason = _account_health_from_login_state(status)
    diagnostic_outcome = "banned" if health_status == "banned" else ("ready" if status.get("status") == "ready" else "not_ready")
    shot = _screenshot(page, screenshot_dir, task, "check_login", logger)
    if status.get("status") != "ready":
        logger.log("warn", "check_login_not_ready", str(status.get("reason") or f"{_platform_name(platform)} 账号未就绪。"), {"details": status}, shot)
        return {
            "ok": True,
            "status": str(status.get("status") or "cookie_expired"),
            "health_status": health_status,
            "health_reason": health_reason,
            "diagnostic_outcome": diagnostic_outcome,
            "screenshot_path": shot,
            "details": status,
        }
    logger.log("info", "completion_node", f"{_platform_name(platform)} 登录检查完成节点已确认。", {"details": status}, shot)
    return {
        "ok": True,
        "status": "ready",
        "health_status": health_status,
        "health_reason": health_reason,
        "diagnostic_outcome": diagnostic_outcome,
        "screenshot_path": shot,
        "details": status,
    }


def _warmup_scroll(page, logger: AutomationLogger, times: int = 2) -> None:
    for index in range(max(1, times)):
        scroll = _slow_human_scroll(page)
        logger.log("debug", "warmup", "已缓慢浏览信息流。", {"index": index + 1, **scroll})
        _sleep_between(4.0, 8.0)


def _send_human_wheel(page, delta: int) -> str:
    """Send a bounded wheel event without letting a busy page deadlock Playwright."""
    context_display = ""
    with contextlib.suppress(Exception):
        candidate = getattr(page.context, "_tg_live_display", "")
        if isinstance(candidate, str):
            context_display = candidate.strip()
    display = context_display or str(os.getenv("DISPLAY") or "").strip()
    xdotool = shutil.which("xdotool")
    if display and xdotool:
        viewport = page.viewport_size if isinstance(getattr(page, "viewport_size", None), dict) else {}
        width = max(
            320,
            _safe_int(getattr(page.context, "_tg_live_width", 0), 0)
            or int(viewport.get("width") or _DEFAULT_LIVE_BROWSER_WIDTH),
        )
        height = max(
            240,
            _safe_int(getattr(page.context, "_tg_live_height", 0), 0)
            or int(
                viewport.get("height")
                or (_DEFAULT_LIVE_BROWSER_HEIGHT - _DEFAULT_LIVE_BROWSER_CHROME_HEIGHT)
            ),
        )
        pointer_x = max(160, min(width - 80, width // 2))
        pointer_y = max(180, min(height - 80, height // 2))
        button = "5" if delta > 0 else "4"
        repeat = max(1, min(3, round(abs(int(delta)) / 70)))
        env = dict(os.environ)
        env["DISPLAY"] = display
        move = subprocess.run(
            # KasmVNC accepts the pointer move immediately but does not always
            # emit the position acknowledgement expected by --sync.
            [xdotool, "mousemove", "--screen", "0", str(pointer_x), str(pointer_y)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            env=env,
        )
        wheel = subprocess.run(
            [
                xdotool,
                "click",
                "--repeat",
                str(repeat),
                "--delay",
                str(random.randint(35, 90)),
                button,
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
            env=env,
        )
        if move.returncode != 0 or wheel.returncode != 0:
            raise RuntimeError(
                f"native wheel failed: move={move.returncode}, wheel={wheel.returncode}"
            )
        return "xdotool"

    page.mouse.wheel(0, delta)
    return "playwright"


def _slow_human_scroll(page) -> dict[str, Any]:
    roll = random.random()
    if roll < 0.12:
        direction = -1
        total_delta = random.randint(80, 260)
        pause_range = (0.75, 1.6)
    elif roll < 0.38:
        direction = 1
        total_delta = random.randint(120, 360)
        pause_range = (0.65, 1.4)
    elif roll < 0.84:
        direction = 1
        total_delta = random.randint(360, 760)
        pause_range = (0.55, 1.25)
    else:
        direction = 1
        total_delta = random.randint(760, 1120)
        pause_range = (0.45, 1.1)

    remaining = total_delta
    segments = 0
    micro_reverse = 0
    wheel_driver = ""
    while remaining > 0:
        step = min(remaining, random.randint(35, 125))
        wheel_driver = _send_human_wheel(page, direction * step)
        remaining -= step
        segments += 1
        if direction > 0 and remaining > 0 and random.random() < 0.16:
            back_step = random.randint(25, 95)
            wheel_driver = _send_human_wheel(page, -back_step)
            micro_reverse += back_step
            _sleep_between(0.35, 0.9)
        _sleep_between(*pause_range)
        if random.random() < 0.25:
            _sleep_between(0.9, 2.6)
    return {
        "delta": direction * total_delta,
        "direction": "up" if direction < 0 else "down",
        "segments": segments,
        "micro_reverse": micro_reverse,
        "wheel_driver": wheel_driver,
    }


def _warmup_session_seconds(payload: dict[str, Any], default_seconds: int | None = None) -> int:
    for key in ("session_seconds", "duration_seconds"):
        value = payload.get(key)
        if value is None or value == "":
            continue
        with contextlib.suppress(Exception):
            return max(15, min(7200, int(float(value))))

    raw = str(payload.get("session_minutes") or "").strip()
    numbers = [float(item) for item in re.findall(r"\d+(?:\.\d+)?", raw)]
    if len(numbers) >= 2:
        low, high = sorted(numbers[:2])
        return max(15, min(7200, int(random.uniform(low, high) * 60)))
    if len(numbers) == 1:
        return max(15, min(7200, int(numbers[0] * 60)))
    if default_seconds is not None:
        return max(15, min(7200, int(default_seconds)))
    return max(15, min(7200, int(random.uniform(7, 10) * 60)))


def _remaining_warmup_session_seconds(
    task: dict[str, Any],
    session_seconds: int,
    *,
    now_epoch: float | None = None,
) -> float:
    """Deduct browser and model setup from the user-visible warmup duration."""
    budget = max(0.0, float(session_seconds))
    try:
        started_at = float(task.get("started_at") or 0)
    except (TypeError, ValueError):
        started_at = 0.0
    if started_at <= 0:
        return budget
    now = float(time.time() if now_epoch is None else now_epoch)
    elapsed = max(0.0, now - started_at)
    return max(0.0, budget - elapsed)


def _payload_int(payload: dict[str, Any], keys: tuple[str, ...], default: int, min_value: int, max_value: int) -> int:
    for key in keys:
        value = payload.get(key)
        if value is None or value == "":
            continue
        with contextlib.suppress(Exception):
            parsed = int(float(value))
            return max(min_value, min(max_value, parsed))
    return max(min_value, min(max_value, int(default)))


def _warmup_interaction_window(payload: dict[str, Any]) -> tuple[int, int]:
    minimum = _payload_int(payload, ("interaction_every_min_posts",), 2, 1, 20)
    maximum = _payload_int(payload, ("interaction_every_max_posts",), 3, minimum, 30)
    return min(minimum, maximum), max(minimum, maximum)


def _next_warmup_interaction_at(current_index: int, payload: dict[str, Any]) -> int:
    minimum, maximum = _warmup_interaction_window(payload)
    return max(0, int(current_index)) + random.randint(minimum, maximum)


def _validate_warmup_completion(
    platform: str,
    *,
    liked: int,
    commented: int,
    min_required_likes: int,
    min_required_comments: int,
    min_required_interactions: int,
) -> None:
    platform_name = _platform_name(platform)
    if liked < min_required_likes:
        raise RuntimeError(f"{platform_name} 养号未达到最低点赞目标：{liked}/{min_required_likes}")
    if commented < min_required_comments:
        raise RuntimeError(f"{platform_name} 养号未达到最低评论目标：{commented}/{min_required_comments}")
    interactions = liked + commented
    if interactions < min_required_interactions:
        raise RuntimeError(
            f"{platform_name} 养号未达到最低互动目标：{interactions}/{min_required_interactions}"
        )


def _warmup_minimum_targets(
    payload: dict[str, Any],
    *,
    like_limit: int,
    max_comments: int,
) -> tuple[int, int, int]:
    min_required_likes = _payload_int(
        payload,
        ("min_required_likes",),
        1 if like_limit > 0 else 0,
        0,
        MAX_WARMUP_LIKES,
    )
    min_required_comments = _payload_int(
        payload,
        ("min_required_comments",),
        0,
        0,
        MAX_WARMUP_COMMENTS,
    )
    min_required_interactions = _payload_int(
        payload,
        ("min_required_interactions",),
        0,
        0,
        MAX_WARMUP_LIKES + MAX_WARMUP_COMMENTS,
    )
    if min_required_likes > like_limit:
        raise RuntimeError("养号最低点赞目标不能大于本次点赞上限。")
    if min_required_comments > max_comments:
        raise RuntimeError("养号最低评论目标不能大于本次评论上限。")
    if min_required_interactions > like_limit + max_comments:
        raise RuntimeError("养号最低互动目标不能大于本次点赞与评论总上限。")
    return min_required_likes, min_required_comments, min_required_interactions


def _is_numeric_image_captcha_text(visible_text: str) -> bool:
    normalized = str(visible_text or "").strip().lower()
    return (
        "enter the code from the image" in normalized
        and (
            "confirm you're human" in normalized
            or "confirm you are human" in normalized
            or "get a new code" in normalized
        )
    )


def _is_human_verification_text(visible_text: str) -> bool:
    normalized = str(visible_text or "").strip().lower()
    return any(
        marker in normalized
        for marker in (
            "confirm you're human",
            "confirm you are human",
            "verify you're human",
            "verify you are human",
            "prove you're human",
            "prove you are human",
            "确认你是真人",
            "验证你是真人",
            "请验证你是真人",
            "真人验证",
        )
    )


def _warmup_risk_state(page, platform: str) -> dict[str, str] | None:
    url = str(page.url or "")
    body_text = ""
    with contextlib.suppress(Exception):
        body_text = str(page.locator("body").inner_text(timeout=3000) or "").lower()
    notice_text_parts: list[str] = []
    for selector in ('[role="dialog"]', '[role="alert"]'):
        with contextlib.suppress(Exception):
            group = page.locator(selector)
            for index in range(min(group.count(), 8)):
                locator = group.nth(index)
                if locator.is_visible(timeout=500):
                    notice_text_parts.append(str(locator.inner_text(timeout=1000) or "").lower())
    notice_text = " ".join(notice_text_parts)
    restriction = _detect_platform_account_restriction(url, body_text, platform, page=page)
    if restriction is not None:
        return {
            "status": str(restriction.get("status") or "cookie_expired"),
            "health_status": str(restriction.get("health_status") or ""),
            "reason": str(restriction.get("reason") or "账号进入账号封控状态。"),
            "force_manual": "true",
        }
    has_verification_input = False
    with contextlib.suppress(Exception):
        verification_inputs = page.locator(
            'input[autocomplete="one-time-code"], '
            'input[name*="verification" i], input[name*="security_code" i]'
        )
        has_verification_input = any(
            verification_inputs.nth(index).is_visible(timeout=500)
            for index in range(min(verification_inputs.count(), 8))
        )
    visible_text = f"{notice_text} {body_text}".strip()
    numeric_image_captcha = _is_numeric_image_captcha_text(visible_text)
    human_verification = _is_human_verification_text(visible_text)
    if (
        _is_verification_url(url)
        or has_verification_input
        or any(marker in visible_text for marker in _verification_text_markers())
    ):
        return {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": f"{_platform_name(platform)} 触发了安全验证，自动操作已暂停，请人工处理当前页面。",
            "force_manual": "true",
            "challenge_type": (
                "numeric_image_captcha"
                if numeric_image_captcha
                else ("human_verification" if human_verification else "verification")
            ),
        }
    risk_markers = (
        "we restrict certain activity to protect our community",
        "we limit how often you can do certain things",
        "your account has been temporarily blocked",
        "try again later. we limit how often",
        "feedback_required",
        "rate limit exceeded",
        "操作过于频繁",
        "暂时无法执行此操作",
    )
    if any(marker in visible_text for marker in risk_markers):
        return {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": f"{_platform_name(platform)} 触发了频率或风控限制，养号任务已停止。",
        }
    return None


def _guard_warmup_risk(
    page,
    platform: str,
    payload: dict[str, Any],
    logger: AutomationLogger,
    *,
    task: dict[str, Any] | None = None,
    screenshot_dir: Path | None = None,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> None:
    risk = _warmup_risk_state(page, platform)
    if risk is None:
        return
    challenge_type = str(risk.get("challenge_type") or "")
    if challenge_type in {"numeric_image_captcha", "human_verification"}:
        challenge_label = "数字图片验证码" if challenge_type == "numeric_image_captcha" else "真人验证页面"
        retry_key = f"{str(platform or '').strip().lower()}_{challenge_type}_retry_attempted"
        retry_attempted = bool(
            isinstance(context_control, dict) and context_control.get(retry_key)
        )
        if not retry_attempted:
            if isinstance(context_control, dict):
                context_control[retry_key] = True
            logger.log(
                "warn",
                f"{platform}_{challenge_type}_retry",
                f"检测到{challenge_label}，正在进行唯一一次低频重试。",
                {"status": risk.get("status", "need_verification")},
            )
            try:
                page.reload(wait_until="domcontentloaded", timeout=30000)
            except Exception as exc:
                refreshed_risk = {
                    "status": "need_verification",
                    "health_status": "abnormal",
                    "reason": f"{_platform_name(platform)} {challenge_label}重试失败，账号状态保持异常并等待人工确认。",
                    "force_manual": "true",
                    "challenge_type": "verification_retry_failed",
                }
                logger.log(
                    "warn",
                    f"{platform}_{challenge_type}_retry_failed",
                    refreshed_risk["reason"],
                    {"error": str(exc)[:500]},
                )
            else:
                _wait_for_cancellation(1.5, cancel_event)
                refreshed_risk = _warmup_risk_state(page, platform)
            if refreshed_risk is None:
                if isinstance(context_control, dict):
                    context_control.pop(retry_key, None)
                logger.log(
                    "info",
                    f"{platform}_{challenge_type}_cleared",
                    f"{challenge_label}在一次重试后已解除，继续执行任务。",
                    {},
                )
                return
            risk = refreshed_risk
        if str(risk.get("challenge_type") or "") == challenge_type:
            risk = {
                "status": "disabled",
                "health_status": "banned",
                "reason": f"{_platform_name(platform)} {challenge_label}在一次重试后仍未解除，账号已判定为封控死号并停止使用。",
                "force_manual": "true",
                "challenge_type": challenge_type,
            }
    force_manual = str(risk.get("force_manual") or "").lower() == "true"
    if not force_manual and not bool(payload.get("stop_on_risk_limit", False)):
        return
    logger.log("warn", f"{platform}_warmup_risk_limit", risk["reason"], {"status": risk["status"]})
    _report_account_login_status(context_control, risk["status"], logger)
    if force_manual and risk["status"] == "need_verification":
        _request_manual_takeover(context_control)
        if task is not None and screenshot_dir is not None:
            shot = _screenshot(page, screenshot_dir, task, "warmup_manual_verification", logger)
            login = _wait_for_manual_login_completion(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                risk["reason"],
                risk["status"],
                shot,
                risk,
                context_control,
            )
            if login.get("status") == "ready":
                _resume_after_manual_takeover(context_control)
                _report_account_login_status(context_control, "ready", logger)
                return
    raise NeedManualError(
        risk["reason"],
        risk["status"],
        health_status=risk.get("health_status", ""),
    )


def _collection_username(value: Any) -> str:
    username = str(value or "").strip().strip("/@").lower()
    if not username or len(username) > 80:
        return ""
    if not re.fullmatch(r"[a-z0-9._]+", username):
        return ""
    return username


def _collection_platform_url(value: Any, platform: str, *, profile: bool = False) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if platform == "threads":
        if profile:
            return _normalize_threads_profile_url(raw)
        post_url = _normalize_threads_post_permalink(raw)
        if post_url:
            return post_url
        parsed = urlparse(raw)
        host = str(parsed.hostname or "").lower()
        if parsed.scheme == "https" and host in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
            return parsed._replace(query="", fragment="").geturl()
        return ""
    if profile:
        return _normalize_instagram_profile_url(raw)
    post_url = _normalize_instagram_post_permalink(raw)
    if post_url:
        return post_url
    parsed = urlparse(raw)
    host = str(parsed.hostname or "").lower()
    if parsed.scheme == "https" and host in {"instagram.com", "www.instagram.com"}:
        return parsed._replace(query="", fragment="").geturl()
    return ""


def _normalize_collection_dom_result(
    raw: Any,
    *,
    platform: str,
    source_url: str,
    limit: int,
) -> dict[str, Any]:
    def nonnegative_int(value: Any) -> int:
        try:
            return max(int(value or 0), 0)
        except (TypeError, ValueError, OverflowError):
            return 0

    result = raw if isinstance(raw, dict) else {}
    safe_page_url = _collection_platform_url(result.get("page_url") or source_url, platform)
    rows = result.get("candidates") if isinstance(result.get("candidates"), list) else []
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for candidate in rows:
        if not isinstance(candidate, dict) or candidate.get("dom_confirmed") is not True:
            continue
        username = _collection_username(candidate.get("username"))
        if not username:
            continue
        profile_url = _collection_platform_url(candidate.get("profile_url"), platform, profile=True)
        if not profile_url:
            continue
        profile_username = _collection_username(urlparse(profile_url).path.strip("/").lstrip("@"))
        if profile_username != username:
            continue
        candidate_source = _collection_platform_url(candidate.get("source_url"), platform) or safe_page_url
        identity = (platform, username)
        if identity in seen:
            continue
        seen.add(identity)
        metrics = candidate.get("metrics") if isinstance(candidate.get("metrics"), dict) else {}
        normalized_metrics: dict[str, int] = {}
        for key in ("like_count", "reply_count", "repost_count", "quote_count"):
            try:
                normalized_metrics[key] = max(0, min(int(metrics.get(key) or 0), 2_147_483_647))
            except (TypeError, ValueError, OverflowError):
                normalized_metrics[key] = 0
        evidence = candidate.get("evidence") if isinstance(candidate.get("evidence"), dict) else {}
        items.append(
            {
                "platform": platform,
                "username": username,
                "display_name": str(candidate.get("display_name") or "").strip()[:160],
                "profile_url": profile_url,
                "source_url": candidate_source,
                "text": str(candidate.get("text") or "").strip()[:3_000],
                "tags": ["source:visible_dom", f"channel:{platform}"],
                **normalized_metrics,
                "evidence": {
                    "dom_confirmed": True,
                    "container": str(evidence.get("container") or "").strip()[:80],
                    "profile_href": profile_url,
                    "post_href": _collection_platform_url(evidence.get("post_href"), platform),
                    "has_time": bool(evidence.get("has_time")),
                    "visible_text_sample": str(evidence.get("visible_text_sample") or "").strip()[:500],
                },
            }
        )
        if len(items) >= limit:
            break
    reason = ""
    if not items:
        reason = str(result.get("empty_reason") or "no_dom_verified_profiles").strip()[:240]
    return {
        "items": items,
        "collected": len(items),
        "collection_status": "collected" if items else "empty",
        "collection_reason": reason,
        "dom_evidence": {
            "page_url": safe_page_url,
            "title": str(result.get("title") or "").strip()[:240],
            "semantic_containers": nonnegative_int(result.get("semantic_containers")),
            "visible_text_length": nonnegative_int(result.get("visible_text_length")),
        },
    }


def _extract_visible_collection_items(
    page,
    *,
    platform: str,
    surface: str,
    limit: int,
) -> dict[str, Any]:
    raw = page.evaluate(
        r"""({ platform, surface, limit }) => {
          const compact = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
          const absolute = (href) => {
            try { return new URL(href, window.location.href).href; } catch (_) { return ''; }
          };
          const reservedInstagram = new Set([
            'accounts', 'direct', 'explore', 'reels', 'stories', 'about', 'legal', 'privacy',
            'terms', 'developer', 'web', 'api', 'p', 'reel'
          ]);
          const identityFromProfile = (href) => {
            try {
              const parsed = new URL(href, window.location.href);
              const host = parsed.hostname.toLowerCase();
              const parts = parsed.pathname.split('/').filter(Boolean);
              if (platform === 'threads') {
                if (!['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'].includes(host)) return null;
                if (parts.length !== 1 || !parts[0].startsWith('@')) return null;
                const username = parts[0].slice(1).toLowerCase();
                return /^[a-z0-9._]{1,80}$/.test(username) ? { username, url: absolute(parsed.href) } : null;
              }
              if (!['instagram.com', 'www.instagram.com'].includes(host)) return null;
              if (parts.length !== 1) return null;
              const username = parts[0].toLowerCase();
              if (reservedInstagram.has(username) || !/^[a-z0-9._]{1,80}$/.test(username)) return null;
              return { username, url: absolute(parsed.href) };
            } catch (_) { return null; }
          };
          const postUrl = (container) => {
            const links = Array.from(container.querySelectorAll('a[href]'));
            for (const link of links) {
              const href = absolute(link.getAttribute('href') || link.href || '');
              try {
                const parsed = new URL(href);
                if (platform === 'threads' && /\/@[^/]+\/(?:post|t)\/[^/?#]+/i.test(parsed.pathname)) return href;
                if (platform === 'instagram' && /^\/(?:p|reel)\/[^/?#]+\/?$/i.test(parsed.pathname)) return href;
              } catch (_) {}
            }
            return '';
          };
          const parseCount = (value) => {
            const raw = compact(value).replace(/,/g, '').toLowerCase();
            const match = raw.match(/(\d+(?:\.\d+)?)/);
            if (!match) return null;
            let multiplier = 1;
            if (/\d(?:\.\d+)?(?:k|\u5343)\b/i.test(raw)) multiplier = 1000;
            else if (/\d(?:\.\d+)?(?:m|\u4e07|\u842c)\b/i.test(raw)) multiplier = /[\u4e07\u842c]/.test(raw) ? 10000 : 1000000;
            return Math.max(0, Math.round(Number(match[1]) * multiplier));
          };
          const metricsFrom = (container) => {
            const metrics = { like_count: 0, reply_count: 0, repost_count: 0, quote_count: 0 };
            for (const node of Array.from(container.querySelectorAll('[aria-label], [title]'))) {
              const label = compact(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`);
              const count = parseCount(label);
              if (count == null) continue;
              if (/like|\u8d5e|\u8b9a/i.test(label)) metrics.like_count = Math.max(metrics.like_count, count);
              if (/reply|comment|\u56de\u590d|\u56de\u8986|\u7559\u8a00|\u8bc4\u8bba|\u8a55\u8ad6/i.test(label)) metrics.reply_count = Math.max(metrics.reply_count, count);
              if (/repost|share|\u8f6c\u53d1|\u8f49\u767c|\u5206\u4eab/i.test(label)) metrics.repost_count = Math.max(metrics.repost_count, count);
              if (/quote|\u5f15\u7528/i.test(label)) metrics.quote_count = Math.max(metrics.quote_count, count);
            }
            return metrics;
          };
          const containers = Array.from(document.querySelectorAll('article, [role="article"], [data-pressable-container]'));
          const rows = [];
          const seen = new Set();
          for (const container of containers) {
            const text = compact(container.innerText || container.textContent || '');
            const source = postUrl(container);
            const hasTime = Boolean(container.querySelector('time'));
            if (!source && !hasTime) continue;
            const profiles = Array.from(container.querySelectorAll('a[href]'))
              .map((node) => ({ node, identity: identityFromProfile(node.getAttribute('href') || node.href || '') }))
              .filter((entry) => entry.identity);
            if (!profiles.length) continue;
            const entry = profiles[0];
            const identity = entry.identity;
            if (seen.has(identity.username)) continue;
            const linkText = compact(entry.node.innerText || entry.node.textContent || entry.node.getAttribute('aria-label') || '');
            const displayName = linkText && linkText.toLowerCase().replace(/^@/, '') !== identity.username ? linkText : '';
            seen.add(identity.username);
            rows.push({
              platform,
              username: identity.username,
              display_name: displayName,
              profile_url: identity.url,
              source_url: source || window.location.href,
              text: text.slice(0, 3000),
              metrics: metricsFrom(container),
              dom_confirmed: true,
              evidence: {
                container: compact(`${container.tagName || ''}${container.getAttribute('role') ? `[role=${container.getAttribute('role')}]` : ''}`),
                profile_href: identity.url,
                post_href: source,
                has_time: hasTime,
                visible_text_sample: text.slice(0, 500),
              },
            });
            if (rows.length >= limit) break;
          }

          if (surface === 'profile' && rows.length === 0) {
            const currentIdentity = identityFromProfile(window.location.href);
            if (currentIdentity) {
              const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
              const visible = compact(main && (main.innerText || main.textContent || ''));
              const matchingAnchor = Array.from(document.querySelectorAll('a[href]')).find((node) => {
                const identity = identityFromProfile(node.getAttribute('href') || node.href || '');
                return identity && identity.username === currentIdentity.username;
              });
              const handleVisible = visible.toLowerCase().split(/\s+/).some((part) =>
                part.replace(/^@/, '').replace(/^[^a-z0-9._]+|[^a-z0-9._]+$/g, '') === currentIdentity.username
              );
              if (matchingAnchor || handleVisible) {
                const headings = Array.from(document.querySelectorAll('main h1, main h2, header h1, header h2'))
                  .map((node) => compact(node.innerText || node.textContent || ''))
                  .filter(Boolean);
                rows.push({
                  platform,
                  username: currentIdentity.username,
                  display_name: headings.find((value) => value.toLowerCase().replace(/^@/, '') !== currentIdentity.username) || '',
                  profile_url: currentIdentity.url,
                  source_url: window.location.href,
                  text: visible.slice(0, 3000),
                  metrics: { like_count: 0, reply_count: 0, repost_count: 0, quote_count: 0 },
                  dom_confirmed: true,
                  evidence: {
                    container: main === document.body ? 'body' : 'main',
                    profile_href: matchingAnchor ? absolute(matchingAnchor.getAttribute('href') || matchingAnchor.href || '') : currentIdentity.url,
                    post_href: '',
                    has_time: false,
                    visible_text_sample: visible.slice(0, 500),
                  },
                });
              }
            }
          }

          const bodyText = compact(document.body && (document.body.innerText || document.body.textContent || ''));
          const loginWall = /log in|sign up|\u767b\u5f55|\u767b\u5165|\u8a3b\u518a|\u6ce8\u518c/i.test(bodyText) && rows.length === 0;
          let emptyReason = '';
          if (!rows.length && loginWall) emptyReason = 'platform_login_wall_visible';
          else if (!rows.length && surface === 'profile') emptyReason = 'profile_identity_not_visible_in_dom';
          else if (!rows.length && containers.length === 0) emptyReason = 'no_semantic_post_containers';
          else if (!rows.length) emptyReason = 'no_dom_verified_profile_links';
          return {
            page_url: window.location.href,
            title: document.title || '',
            semantic_containers: containers.length,
            visible_text_length: bodyText.length,
            empty_reason: emptyReason,
            candidates: rows,
          };
        }""",
        {"platform": platform, "surface": surface, "limit": limit},
    )
    return _normalize_collection_dom_result(
        raw,
        platform=platform,
        source_url=str(getattr(page, "url", "") or ""),
        limit=limit,
    )


def _run_browse_feed(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str = "instagram",
) -> dict[str, Any]:
    home_url = THREADS_HOME if platform == "threads" else INSTAGRAM_HOME
    _goto(page, home_url, logger, "browse_feed")
    query = " ".join(str(payload.get("query") or "").split()).strip()
    surface = "feed"
    search_driver = ""
    if query:
        # CRM persona collection is a directed search, not a generic home-feed
        # scrape.  Reuse the same visible platform search interaction as the
        # warm-up worker so the query is actually submitted through the UI and
        # the collected evidence belongs to the resulting search surface.
        search_driver = _search_warmup_interest_surface(
            page,
            platform,
            query,
            logger,
        )
        surface = f"search:{query}"
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    limit = max(1, min(int(payload.get("limit") or 50), 200))
    collection = _extract_visible_collection_items(
        page,
        platform=platform,
        surface=surface,
        limit=limit,
    )
    shot = _screenshot(page, screenshot_dir, task, "browse_feed", logger)
    return {
        "ok": True,
        "url": _safe_navigation_url(page.url),
        "platform": platform,
        "query": query,
        "search_driver": search_driver,
        "screenshot_path": shot,
        **collection,
    }


def _dispatch_browse_feed(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str,
) -> dict[str, Any]:
    return _run_browse_feed(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform=platform,
    )


def _instagram_action_locators(page, label: str):
    localized_labels = {
        "Like": ("Like", "赞", "讚"),
        "Comment": ("Comment", "评论", "留言"),
    }.get(str(label or "").strip(), (str(label or "").strip(),))
    result = []
    for action_label in localized_labels:
        if not action_label:
            continue
        selectors = [
            f'xpath=.//*[@aria-label="{action_label}" and (self::button or @role="button")]',
            f'xpath=.//*[@aria-label="{action_label}"]/ancestor::*[self::button or @role="button"][1]',
        ]
        for selector in selectors:
            with contextlib.suppress(Exception):
                result.append(page.locator(selector))
    return result


def _instagram_unlike_count(page) -> int:
    total = 0
    for label in ("Unlike", "取消赞", "取消讚"):
        with contextlib.suppress(Exception):
            total += int(page.locator(f'[aria-label="{label}"]').count())
    return total


def _dismiss_instagram_interstitials(page, logger: AutomationLogger) -> bool:
    dismissed = False
    for _ in range(2):
        if not _click_text_button(
            page,
            logger,
            ["Not Now", "稍后", "以后再说", "暂不", "現在不要"],
            "instagram_interstitial_dismiss",
        ):
            break
        dismissed = True
        logger.log("info", "instagram_interstitial_dismiss", "已关闭 Instagram 平台提示弹窗。")
        _sleep_between(0.5, 1.0)
    return dismissed


def _dismiss_instagram_scraping_warning_by_structure(page, logger: AutomationLogger) -> bool:
    """Dismiss the single prominent action on Instagram's localized warning page."""
    try:
        candidates = page.locator('button, [role="button"]')
        best = None
        best_area = 0.0
        for index in range(min(int(candidates.count()), 40)):
            candidate = candidates.nth(index)
            if not candidate.is_visible(timeout=300):
                continue
            box = candidate.bounding_box()
            if not isinstance(box, dict):
                continue
            width = float(box.get("width") or 0)
            height = float(box.get("height") or 0)
            if width < 240 or height < 36 or height > 100:
                continue
            area = width * height
            if area > best_area:
                best = candidate
                best_area = area
        if best is not None and _human_click(
            page,
            best,
            logger,
            "instagram_scraping_warning_dismiss_structure",
        ):
            logger.log(
                "info",
                "instagram_scraping_warning_dismiss_structure",
                "Instagram account notice was dismissed using its prominent visual action.",
                {"evidence": "visual_structure", "url": _safe_navigation_url(page.url)},
            )
            return True
    except Exception:
        pass
    return _click_text_button(
        page,
        logger,
        ["Close", "閉じる", "关闭", "關閉"],
        "instagram_scraping_warning_dismiss_text",
    )


def _resolve_instagram_post_login_interstitial(page, logger: AutomationLogger) -> bool:
    url_before = str(page.url or "")
    body_text = _page_body_text_lower(page)
    if "/accounts/scraping_warning" in url_before.lower():
        if not _dismiss_instagram_scraping_warning_by_structure(page, logger):
            return False
        _sleep_between(0.8, 1.5)
        return True
    save_login_prompt = (
        "/accounts/onetap" in url_before.lower()
        or "save your login info?" in body_text
    )
    if save_login_prompt:
        if not _click_text_button(
            page,
            logger,
            [
                "Save info",
                "Save Info",
                "保存信息",
                "保存登录信息",
                "儲存登入資料",
            ],
            "instagram_save_login_info",
        ):
            return False
        logger.log(
            "info",
            "instagram_save_login_info",
            "已保存 Instagram 登录信息，后续任务将继续复用当前浏览器会话。",
            {"url": _safe_navigation_url(page.url)},
        )
        _sleep_between(0.8, 1.5)
        # Saving the browser session can be followed by a notification prompt.
        # That second prompt is optional and should be dismissed independently.
        _dismiss_instagram_interstitials(page, logger)
    elif not _dismiss_instagram_interstitials(page, logger):
        return False
    if "/accounts/onetap" in url_before.lower() or "/accounts/onetap" in str(page.url or "").lower():
        _goto(page, INSTAGRAM_HOME, logger, "instagram_post_login_home")
    logger.log(
        "info",
        "instagram_post_login_interstitial",
        "Instagram 登录后的确认窗口已关闭，正在确认首页可操作状态。",
        {"url": _safe_navigation_url(page.url)},
    )
    return True


def _click_some_instagram_likes(
    page,
    logger: AutomationLogger,
    limit: int,
    *,
    target_root=None,
) -> int:
    clicked = 0
    if limit <= 0:
        return clicked
    action_scope = target_root if target_root is not None else page
    for group in _instagram_action_locators(action_scope, "Like"):
        with contextlib.suppress(Exception):
            indices = list(range(min(group.count(), 32)))
            random.shuffle(indices)
            for index in indices:
                locator = group.nth(index)
                if not locator.is_visible(timeout=1000):
                    continue
                unlike_before = _instagram_unlike_count(page)
                _human_click(page, locator, logger, "instagram_warmup_like")
                _sleep_between(0.8, 1.4)
                unlike_after = _instagram_unlike_count(page)
                if unlike_after <= unlike_before:
                    logger.log(
                        "warn",
                        "instagram_warmup_like_unconfirmed",
                        "Instagram 点赞状态未变更，本次不计入成功数。",
                        {"unlike_before": unlike_before, "unlike_after": unlike_after},
                    )
                    continue
                clicked += 1
                logger.log("info", "instagram_warmup_like", "Instagram 养号过程中已点赞。", {"liked": clicked})
                _sleep_between(0.4, 1.4)
                if clicked >= limit:
                    return clicked
    return clicked


def _instagram_warmup_comment_box(page):
    selectors = [
        'textarea[aria-label*="comment" i]',
        'textarea[placeholder*="comment" i]',
        'textarea',
    ]
    for selector in selectors:
        with contextlib.suppress(Exception):
            group = page.locator(selector)
            for index in reversed(range(min(group.count(), 12))):
                locator = group.nth(index)
                if locator.is_visible(timeout=1000):
                    return locator
    return None


def _instagram_exact_text_count(page, text: str) -> int:
    with contextlib.suppress(Exception):
        return int(page.get_by_text(str(text or ""), exact=True).count())
    return 0


def _wait_for_instagram_comment_echo(page, text: str, previous_count: int, timeout_seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    while time.monotonic() < deadline:
        with contextlib.suppress(Exception):
            group = page.get_by_text(str(text or ""), exact=True)
            if int(group.count()) > int(previous_count):
                target = group.last
                if target.is_visible(timeout=1000):
                    target.scroll_into_view_if_needed(timeout=5000)
                    return True
        time.sleep(0.5)
    return False


def _post_instagram_warmup_comment(
    page,
    logger: AutomationLogger,
    text: str,
    *,
    target_root=None,
    before_submit: Callable[[], Any] | None = None,
) -> bool:
    clean_text = str(text or "").strip()
    if not clean_text:
        return False
    action_scope = target_root if target_root is not None else page
    for group in _instagram_action_locators(action_scope, "Comment"):
        with contextlib.suppress(Exception):
            for index in range(min(group.count(), 20)):
                button = group.nth(index)
                if not button.is_visible(timeout=1000):
                    continue
                _human_click(page, button, logger, "instagram_warmup_comment_button")
                _sleep_between(1.0, 2.0)
                box = _instagram_warmup_comment_box(page)
                if box is None:
                    continue
                previous_count = _instagram_exact_text_count(page, clean_text)
                _human_click(page, box, logger, "instagram_warmup_comment_focus")
                _human_type(page, clean_text, min_delay=0.10, max_delay=0.22)
                if before_submit is not None:
                    before_submit()
                network_confirmed = threading.Event()

                def capture_submission(response) -> None:
                    if _is_warmup_comment_submission_response(
                        response,
                        "instagram",
                        clean_text,
                    ):
                        network_confirmed.set()

                listener_attached = False
                with contextlib.suppress(Exception):
                    page.on("response", capture_submission)
                    listener_attached = True
                if not _click_text_button(page, logger, ["Post", "发布"], "instagram_warmup_comment_submit"):
                    if listener_attached:
                        with contextlib.suppress(Exception):
                            page.remove_listener("response", capture_submission)
                    continue
                echoed = _wait_for_instagram_comment_echo(page, clean_text, previous_count)
                if listener_attached:
                    with contextlib.suppress(Exception):
                        page.remove_listener("response", capture_submission)
                if echoed or network_confirmed.is_set():
                    logger.log(
                        "info",
                        "instagram_warmup_comment_confirmed",
                        "Instagram 评论提交已确认。",
                        {
                            "text": clean_text[:80],
                            "confirmation": "page_echo" if echoed else "network_response",
                        },
                    )
                    return True
                logger.log(
                    "warn",
                    "instagram_warmup_comment_unconfirmed",
                    "Instagram 评论提交后未检测到内容回显，本次不计入成功数。",
                    {"text": clean_text[:80]},
                )
                return False
    return False


def _is_instagram_post_url(value: Any) -> bool:
    url = str(value or "").lower()
    return any(marker in url for marker in ("/p/", "/reel/", "/tv/"))


def _return_instagram_feed_after_post(
    page,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
) -> None:
    for _ in range(2):
        if not _is_instagram_post_url(page.url):
            break
        with contextlib.suppress(Exception):
            page.keyboard.press("Escape")
        _wait_for_cancellation(random.uniform(0.8, 1.8), cancel_event)
        if not _is_instagram_post_url(page.url):
            break
        try:
            page.go_back(wait_until="domcontentloaded", timeout=12000)
        except Exception:
            with contextlib.suppress(Exception):
                page.keyboard.press("Alt+Left")
        _wait_for_cancellation(random.uniform(2.5, 5.5), cancel_event)
    final_url = str(page.url or "")
    if _is_instagram_post_url(final_url):
        _goto(page, INSTAGRAM_HOME, logger, "instagram_return_feed")
        final_url = str(page.url or "")
    logger.log("info", "instagram_return_feed", "已从打开的 Instagram 帖子返回信息流。", {"url": final_url})


def _open_random_instagram_post(
    page,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
    target_root=None,
) -> bool:
    candidates: list[Any] = []
    action_scope = target_root if target_root is not None else page
    for selector in ('a[href*="/p/"]', 'a[href*="/reel/"]', 'a[href*="/tv/"]'):
        with contextlib.suppress(Exception):
            group = action_scope.locator(selector)
            candidates.extend(group.nth(index) for index in range(min(int(group.count()), 48)))
    random.shuffle(candidates)
    for link in candidates:
        try:
            if not link.is_visible(timeout=800):
                continue
            box = link.bounding_box()
            if not box or box["width"] < 20 or box["height"] < 12 or box["y"] < 80:
                continue
            href = str(link.get_attribute("href") or "")
            if not _is_instagram_post_url(href):
                continue
            before_url = str(page.url or "")
            _human_click(page, link, logger, "instagram_open_post")
            _wait_for_cancellation(random.uniform(2.0, 4.0), cancel_event)
            after_url = str(page.url or "")
            if after_url == before_url and not _is_instagram_post_url(after_url):
                continue
            logger.log("info", "instagram_open_post", "已打开一条 Instagram 帖子进行浏览。", {"url": after_url})
            _wait_for_cancellation(random.uniform(6.0, 12.0), cancel_event)
            if random.random() < 0.55:
                detail_scroll = _slow_human_scroll(page)
                logger.log("debug", "instagram_read_post", "已在打开的 Instagram 帖子内浏览。", detail_scroll)
                _wait_for_cancellation(random.uniform(4.0, 9.0), cancel_event)
            _return_instagram_feed_after_post(page, logger, cancel_event=cancel_event)
            return True
        except Exception:
            _raise_if_cancelled(cancel_event)
            continue
    return False


def _open_random_platform_post(
    page,
    logger: AutomationLogger,
    *,
    platform: str,
    cancel_event: Any | None = None,
    target_root=None,
) -> bool:
    if platform == "threads":
        return _open_random_threads_post(
            page,
            logger,
            cancel_event=cancel_event,
            target_root=target_root,
        )
    if platform == "instagram":
        return _open_random_instagram_post(
            page,
            logger,
            cancel_event=cancel_event,
            target_root=target_root,
        )
    raise UnsupportedActionError(f"Unsupported warmup platform: {platform}")


def _run_instagram_warmup(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _run_platform_warmup(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="instagram",
        cancel_event=cancel_event,
        context_control=context_control,
    )


def _threads_like_buttons(scope):
    selectors = [
        # Threads renders the accessible "Like" label on an inner SVG. Click
        # its role=button ancestor first; clicking the SVG itself is fragile
        # when a virtualized feed shifts after scrolling.
        '[role="button"]:has([aria-label="Like"])',
        '[role="button"]:has([aria-label*="赞"])',
        '[aria-label="Like"]',
        '[aria-label*="\u8d5e"]',
    ]
    locators = []
    for selector in selectors:
        try:
            locators.append(scope.locator(selector))
        except Exception:
            continue
    return locators


def _is_threads_like_candidate(locator) -> bool:
    label = ""
    text = ""
    with contextlib.suppress(Exception):
        label = str(locator.get_attribute("aria-label") or "")
    if not label:
        # Current Threads action buttons put the accessible name on their
        # nested SVG. Keep lookup scoped to the selected relevant card.
        with contextlib.suppress(Exception):
            label = str(locator.locator("[aria-label]").first.get_attribute("aria-label") or "")
    with contextlib.suppress(Exception):
        text = str(locator.inner_text(timeout=500) or "")
    probe = f"{label} {text}".strip().lower()
    if not probe:
        return False
    blocked = ("unlike", "liked", "\u53d6\u6d88", "\u5df2\u8d5e", "\u5df2\u6309\u8d5e", "\u6536\u56de")
    if any(item in probe for item in blocked):
        return False
    return "like" in probe or "\u8d5e" in probe


def _click_some_threads_likes(
    page,
    logger: AutomationLogger,
    limit: int,
    *,
    target_root=None,
) -> int:
    clicked = 0
    if limit <= 0:
        return clicked
    action_scope = target_root if target_root is not None else page
    for group in _threads_like_buttons(action_scope):
        try:
            total = group.count()
        except Exception:
            continue
        indices = list(range(min(total, 24)))
        random.shuffle(indices)
        for index in indices:
            try:
                loc = group.nth(index)
                if loc.is_visible(timeout=1000) and _is_threads_like_candidate(loc):
                    label = ""
                    with contextlib.suppress(Exception):
                        label = str(loc.get_attribute("aria-label") or "")
                    logger.log("debug", "threads_like_candidate", "已选中未点赞的 Threads 点赞按钮。", {"aria_label": label})
                    unlike_before = _threads_unlike_count(page)
                    _human_click(page, loc, logger, "threads_like")
                    _sleep_between(1.0, 2.5)
                    unlike_after = _threads_unlike_count(page)
                    if unlike_after <= unlike_before:
                        logger.log(
                            "warn",
                            "threads_warmup_like_unconfirmed",
                            "Threads 点赞状态未变更，本次不计入成功数。",
                            {"unlike_before": unlike_before, "unlike_after": unlike_after},
                        )
                        continue
                    clicked += 1
                    if clicked >= limit:
                        return clicked
            except Exception:
                continue
    return clicked


def _threads_unlike_count(page) -> int:
    total = 0
    for label in ("Unlike", "取消赞", "取消讚"):
        with contextlib.suppress(Exception):
            total += int(page.locator(f'[aria-label="{label}"]').count())
    return total


def _open_random_threads_post(
    page,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
    target_root=None,
) -> bool:
    action_scope = target_root if target_root is not None else page
    candidates = action_scope.locator('a[href*="/post/"]')
    try:
        total = candidates.count()
    except Exception:
        return False
    for allow_media in (False, True):
        indices = list(range(min(total, 48)))
        random.shuffle(indices)
        for index in indices:
            try:
                link = candidates.nth(index)
                if not link.is_visible(timeout=800):
                    continue
                box = link.bounding_box()
                if not box or box["width"] < 20 or box["height"] < 12 or box["y"] < 80:
                    continue
                href = str(link.get_attribute("href") or "")
                href_lower = href.lower()
                if "/post/" not in href_lower or (not allow_media and "/media" in href_lower):
                    continue
                before_url = str(page.url or "")
                _human_click(page, link, logger, "threads_open_post")
                _wait_for_cancellation(random.uniform(2.0, 4.0), cancel_event)
                after_url = str(page.url or "")
                opened = after_url != before_url or "/post/" in after_url
                if not opened:
                    continue
                logger.log("info", "threads_open_post", "已打开一条 Threads 帖子进行浏览。", {"url": after_url})
                _wait_for_cancellation(random.uniform(6.0, 12.0), cancel_event)
                if random.random() < 0.55:
                    detail_scroll = _slow_human_scroll(page)
                    logger.log("debug", "threads_read_post", "已在打开的 Threads 帖子内浏览。", detail_scroll)
                    _wait_for_cancellation(random.uniform(4.0, 9.0), cancel_event)
                _return_threads_feed_after_post(page, logger, cancel_event=cancel_event)
                return True
            except Exception:
                _raise_if_cancelled(cancel_event)
                continue
    return False


def _return_threads_feed_after_post(
    page,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
) -> None:
    initial_url = str(page.url or "")
    return_method = "page_back_control"
    if "/post/" in initial_url.lower() or "/media" in initial_url.lower():
        back_control = _first_visible_locator(
            page,
            (
                '[role="button"]:has([aria-label*="back" i])',
                'button:has([aria-label*="back" i])',
                '[aria-label*="back" i]',
                '[aria-label="返回"]',
            ),
        )
        if back_control is not None and _human_click(
            page,
            back_control,
            logger,
            "threads_return_post_back_control",
        ):
            _wait_for_cancellation(random.uniform(0.8, 1.5), cancel_event)

    current_url = str(page.url or "").lower()
    if "/post/" in current_url or "/media" in current_url:
        return_method = "browser_history"
        try:
            page.go_back(wait_until="domcontentloaded", timeout=12000)
        except Exception:
            return_method = "alt_left"
            with contextlib.suppress(Exception):
                page.keyboard.press("Alt+Left")
        _wait_for_cancellation(random.uniform(1.5, 3.0), cancel_event)

    final_url = str(page.url or "")
    if "/post/" in final_url.lower() or "/media" in final_url.lower():
        _goto(page, THREADS_HOME, logger, "threads_return_feed")
        return_method = "home_fallback"
        final_url = str(page.url or "")
    logger.log(
        "info",
        "threads_return_feed",
        "已从打开的 Threads 帖子返回原浏览上下文。",
        {
            "initial_url": initial_url,
            "url": final_url,
            "method": return_method,
            "preserved_context": return_method != "home_fallback",
        },
    )


def _post_threads_warmup_comment(
    page,
    logger: AutomationLogger,
    text: str,
    *,
    target_root=None,
    before_submit: Callable[[], Any] | None = None,
) -> bool:
    clean_text = str(text or "").strip()
    if not clean_text:
        return False
    button = _threads_reply_button(page, root=target_root)
    if button is None:
        return False
    previous_count = _threads_published_reply_count(page, clean_text)
    _human_click(page, button, logger, "threads_warmup_reply_button")
    _sleep_between(1.0, 2.5)
    box = _threads_text_box(page)
    if box is None:
        return False
    _human_click(page, box, logger, "threads_warmup_reply_focus")
    _human_type(page, clean_text, min_delay=0.10, max_delay=0.22)
    if before_submit is not None:
        before_submit()
    network_confirmed = threading.Event()

    def capture_submission(response) -> None:
        if _is_warmup_comment_submission_response(response, "threads", clean_text):
            network_confirmed.set()

    listener_attached = False
    with contextlib.suppress(Exception):
        page.on("response", capture_submission)
        listener_attached = True
    if not _click_threads_reply_submit(
        page,
        box,
        logger,
        "threads_warmup_reply_submit",
    ):
        if listener_attached:
            with contextlib.suppress(Exception):
                page.remove_listener("response", capture_submission)
        return False
    echoed = _wait_for_threads_reply_echo(page, clean_text, previous_count)
    if listener_attached:
        with contextlib.suppress(Exception):
            page.remove_listener("response", capture_submission)
    if echoed or network_confirmed.is_set():
        logger.log(
            "info",
            "threads_warmup_comment_confirmed",
            "Threads 评论提交已确认。",
            {
                "text": clean_text[:80],
                "confirmation": "page_echo" if echoed else "network_response",
            },
        )
        return True
    logger.log(
        "warn",
        "threads_warmup_comment_unconfirmed",
        "Threads 评论提交后未检测到内容回显，本次不计入成功数。",
        {"text": clean_text[:80]},
    )
    return False


def _response_value(obj: Any, name: str, default: Any = "") -> Any:
    value = getattr(obj, name, default)
    if callable(value):
        with contextlib.suppress(Exception):
            return value()
        return default
    return value


def _is_warmup_comment_submission_response(
    response: Any,
    platform: str,
    text: str,
) -> bool:
    """Recognize a successful comment mutation without relying on UI placement.

    Threads and Instagram can move a newly posted reply outside the current
    virtualized viewport.  Their mutation request still contains the exact
    typed text, so a successful 2xx response is a stronger confirmation than a
    missing DOM echo.
    """
    clean_text = str(text or "").strip()
    if not clean_text:
        return False
    status = int(_response_value(response, "status", 0) or 0)
    if status < 200 or status >= 300:
        return False
    request = _response_value(response, "request", None)
    if request is None:
        return False
    method = str(_response_value(request, "method", "") or "").upper()
    if method != "POST":
        return False
    url = str(
        _response_value(response, "url", "")
        or _response_value(request, "url", "")
        or ""
    ).lower()
    clean_platform = str(platform or "").strip().lower()
    if clean_platform == "threads":
        if "threads." not in url and "instagram." not in url:
            return False
    elif clean_platform == "instagram":
        if "instagram." not in url:
            return False
    else:
        return False
    if not any(marker in url for marker in ("graphql", "/api/", "/ajax/")):
        return False
    post_data = str(_response_value(request, "post_data", "") or "")
    escaped_text = json.dumps(clean_text, ensure_ascii=True)[1:-1]
    return clean_text in post_data or escaped_text in post_data


def _warmup_interest_search_url(platform: str, topic: str) -> str:
    query = quote_plus(" ".join(str(topic or "").split()))
    if platform == "threads":
        return f"https://www.threads.net/search?q={query}"
    if platform == "instagram":
        return f"https://www.instagram.com/explore/search/keyword/?q={query}"
    raise UnsupportedActionError(f"Unsupported warmup platform: {platform}")


def _first_visible_locator(page, selectors: Iterable[str]):
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if locator.count() > 0 and locator.is_visible(timeout=1000):
                return locator
        except Exception:
            continue
    return None


def _warmup_search_entry_locator(page, platform: str):
    if platform == "threads":
        selectors = (
            'a[href="/search"]',
            'a[href^="/search?"]',
            '[role="link"][aria-label="Search"]',
            '[role="link"][aria-label="搜索"]',
            '[role="link"][aria-label="搜尋"]',
            '[aria-label="Search"]',
            '[aria-label="搜索"]',
            '[aria-label="搜尋"]',
        )
    else:
        selectors = (
            'a[href="/explore/"]',
            'a[href^="/explore/search/"]',
            '[role="link"][aria-label="Search"]',
            '[role="link"][aria-label="搜索"]',
            '[role="link"][aria-label="搜尋"]',
            '[aria-label="Search"]',
            '[aria-label="搜索"]',
            '[aria-label="搜尋"]',
        )
    return _first_visible_locator(page, selectors)


def _warmup_search_input_locator(page, platform: str):
    if platform == "threads":
        selectors = (
            'input[placeholder="Search"]',
            'input[placeholder="搜索"]',
            'input[placeholder="搜尋"]',
            'input[aria-label="Search"]',
            'input[aria-label="搜索"]',
            'input[aria-label="搜尋"]',
            'input[type="search"]',
        )
    else:
        selectors = (
            'input[placeholder="Search"]',
            'input[placeholder="搜索"]',
            'input[placeholder="搜尋"]',
            'input[aria-label="Search input"]',
            'input[aria-label="搜索输入"]',
            'input[type="search"]',
        )
    return _first_visible_locator(page, selectors)


def _focus_warmup_search_input(
    page,
    search_input,
    logger: AutomationLogger,
    stage: str,
) -> bool:
    if _human_click(page, search_input, logger, stage):
        return True
    # Search result pages can temporarily place an animation layer over an
    # already-visible input. Keep the operation inside the real page UI: close
    # transient overlays, focus the same input, then verify browser focus.
    with contextlib.suppress(Exception):
        page.keyboard.press("Escape")
    try:
        search_input.focus(timeout=2500)
        focused = bool(
            search_input.evaluate(
                "element => document.activeElement === element"
            )
        )
    except Exception as exc:
        logger.log(
            "warn",
            f"{stage}_focus_recovery_failed",
            "搜索输入框点击受阻，焦点恢复失败。",
            {"error": str(exc)[:500]},
        )
        return False
    if focused:
        logger.log(
            "info",
            f"{stage}_focus_recovered",
            "搜索输入框点击受阻，已在当前页面恢复输入焦点。",
            {"interaction": "ui_focus_recovery"},
        )
    return focused


def _warmup_search_result_signature(page, platform: str) -> tuple[str, ...]:
    contexts = _visible_warmup_post_contexts(page, platform, limit=6)
    return tuple(
        normalized
        for context in contexts
        if (normalized := _normalize_warmup_text(context.get("text"))[:180])
    )


def _wait_for_warmup_search_results(
    page,
    platform: str,
    keyword: str,
    logger: AutomationLogger,
    *,
    previous_signature: tuple[str, ...] = (),
    timeout_seconds: float = 14.0,
) -> bool:
    """Wait for a new search result surface to settle without scrolling it."""
    stage = f"{platform}_warmup_relevance_search_ready"
    started_at = time.monotonic()
    deadline = started_at + max(3.0, float(timeout_seconds))
    last_signature: tuple[str, ...] = ()
    stable_reads = 0
    while time.monotonic() < deadline:
        current_signature = _warmup_search_result_signature(page, platform)
        elapsed = time.monotonic() - started_at
        result_is_new = bool(current_signature) and (
            current_signature != previous_signature or elapsed >= 3.0
        )
        if result_is_new:
            if current_signature == last_signature:
                stable_reads += 1
            else:
                last_signature = current_signature
                stable_reads = 1
            if stable_reads >= 2:
                logger.log(
                    "info",
                    stage,
                    "搜索结果已加载并稳定，开始校准人设相关内容。",
                    {
                        "keyword": keyword,
                        "candidate_count": len(current_signature),
                        "waited_seconds": round(elapsed, 1),
                    },
                )
                return True
        else:
            last_signature = current_signature
            stable_reads = 0
        _sleep_between(0.6, 0.9)
    logger.log(
        "warn",
        stage,
        "搜索结果在限定时间内未稳定，已停止滚动并切换兜底加载。",
        {"keyword": keyword, "timeout_seconds": float(timeout_seconds)},
    )
    return False


def _visible_instagram_search_post_link(page):
    """Return the first visible Instagram search-grid post link."""
    for selector in (
        'a[href*="/p/"]',
        'a[href*="/reel/"]',
        'a[href*="/tv/"]',
    ):
        try:
            links = page.locator(selector)
            for index in range(min(int(links.count()), 24)):
                link = links.nth(index)
                if not link.is_visible(timeout=500):
                    continue
                box = link.bounding_box()
                if not box:
                    continue
                if float(box.get("width") or 0) < 40 or float(box.get("height") or 0) < 40:
                    continue
                if float(box.get("y") or 0) < 70:
                    continue
                return link
        except Exception:
            continue
    return None


def _visible_instagram_search_suggestion(page, keyword: str):
    """Return the visible Instagram search suggestion matching the query."""
    clean_keyword = _normalize_warmup_text(keyword).lower()
    scored = []
    for selector in (
        'a[href*="/explore/search/keyword/"]',
        '[role="link"]',
        '[role="button"]',
    ):
        try:
            candidates = page.locator(selector)
            for index in range(min(int(candidates.count()), 80)):
                candidate = candidates.nth(index)
                if not candidate.is_visible(timeout=300):
                    continue
                box = candidate.bounding_box()
                if not box:
                    continue
                width = float(box.get("width") or 0)
                height = float(box.get("height") or 0)
                y = float(box.get("y") or 0)
                if width < 80 or height < 24 or height > 180 or y < 70:
                    continue
                text = ""
                href = ""
                with contextlib.suppress(Exception):
                    text = _normalize_warmup_text(candidate.inner_text(timeout=500)).lower()
                with contextlib.suppress(Exception):
                    href = str(candidate.get_attribute("href") or "").lower()
                query_match = bool(clean_keyword) and clean_keyword in text
                keyword_route = "/explore/search/keyword/" in href
                if not query_match and not keyword_route:
                    continue
                score = 0
                if text == clean_keyword:
                    score += 5
                elif query_match:
                    score += 3
                if keyword_route:
                    score += 4
                scored.append((score, -y, candidate))
        except Exception:
            continue
    if not scored:
        return None
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][2]


def _submit_instagram_warmup_search(
    page,
    keyword: str,
    logger: AutomationLogger,
    stage: str,
) -> str:
    """Activate an Instagram search suggestion and open one result post.

    Instagram's desktop search drawer does not submit a keyword when Enter is
    pressed while the text input is focused. The query suggestion must be
    activated first; its result grid must then be opened before the shared
    article-based relevance calibration can inspect post text.
    """
    interaction = "click_type_suggestion"
    suggestion_clicked = False
    suggestion_deadline = time.monotonic() + 8.0
    while time.monotonic() < suggestion_deadline:
        candidate = _visible_instagram_search_suggestion(page, keyword)
        if candidate is not None:
            suggestion_clicked = _human_click(
                page,
                candidate,
                logger,
                f"{stage}_suggestion",
            )
            if suggestion_clicked:
                break
        _sleep_between(0.4, 0.7)

    if not suggestion_clicked:
        interaction = "click_type_arrow_enter"
        page.keyboard.press("ArrowDown")
        _sleep_between(0.2, 0.4)
        page.keyboard.press("Enter")

    with contextlib.suppress(Exception):
        page.wait_for_load_state("domcontentloaded", timeout=10000)

    deadline = time.monotonic() + 16.0
    while time.monotonic() < deadline:
        if _warmup_search_result_signature(page, "instagram"):
            return interaction
        post_link = _visible_instagram_search_post_link(page)
        if post_link is not None:
            if not _human_click(page, post_link, logger, f"{stage}_open_result"):
                raise RuntimeError("Instagram search result click was not confirmed")
            with contextlib.suppress(Exception):
                page.wait_for_load_state("domcontentloaded", timeout=10000)
            return f"{interaction}_open_result"
        _sleep_between(0.5, 0.8)
    raise RuntimeError("Instagram search suggestion did not expose a result post")


def _search_warmup_interest_surface(
    page,
    platform: str,
    keyword: str,
    logger: AutomationLogger,
) -> str:
    """Open platform search through its visible UI, type a query, and submit it.

    Direct URL navigation is deliberately only a recovery path.  The primary
    behavior mirrors the reference TG warmup chain: click Search, focus the
    input, clear it, type the keyword, and press Enter.
    """
    stage = f"{platform}_warmup_relevance_search"
    clean_keyword = " ".join(str(keyword or "").split())
    try:
        if platform == "instagram":
            # Instagram opens search-grid posts in a modal layer. Close the
            # prior result before returning to the persistent Search entry.
            with contextlib.suppress(Exception):
                page.keyboard.press("Escape")
            _sleep_between(0.4, 0.7)
        search_input = _warmup_search_input_locator(page, platform)
        if search_input is None:
            search_entry = _warmup_search_entry_locator(page, platform)
            if search_entry is None:
                raise RuntimeError("search entry was not visible")
            if not _human_click(page, search_entry, logger, f"{stage}_open"):
                # The navigation item can be marked aria-current and reject a
                # redundant click while its search input is already appearing.
                # Re-probe the input before treating the UI interaction as failed.
                search_input = _warmup_search_input_locator(page, platform)
                if search_input is None:
                    raise RuntimeError("search entry click was not confirmed")
            else:
                _sleep_between(0.8, 1.5)
                search_input = _warmup_search_input_locator(page, platform)
        if search_input is None:
            raise RuntimeError("search input was not visible after opening Search")
        if not _focus_warmup_search_input(
            page,
            search_input,
            logger,
            f"{stage}_focus",
        ):
            raise RuntimeError("search input focus was not confirmed")
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
        _type_text(
            page,
            clean_keyword,
            min_delay=0.06,
            max_delay=0.14,
            mode="type",
            logger=logger,
            stage=f"{stage}_type",
        )
        previous_signature = _warmup_search_result_signature(page, platform)
        if platform == "instagram":
            interaction = _submit_instagram_warmup_search(
                page,
                clean_keyword,
                logger,
                stage,
            )
        else:
            interaction = "click_type_enter"
            page.keyboard.press("Enter")
            with contextlib.suppress(Exception):
                page.wait_for_load_state("domcontentloaded", timeout=10000)
        logger.log(
            "info",
            stage,
            "已通过页面搜索入口输入人设关键词并提交。",
            {"keyword": clean_keyword, "interaction": interaction},
        )
        if not _wait_for_warmup_search_results(
            page,
            platform,
            clean_keyword,
            logger,
            previous_signature=previous_signature,
        ):
            raise RuntimeError("search results did not stabilize after UI submission")
        return "ui"
    except Exception as exc:
        logger.log(
            "error",
            f"{stage}_ui_failed",
            "页面搜索交互未完成，已停止本次关键词搜索，不使用网址直跳。",
            {"keyword": clean_keyword, "error": str(exc)[:500]},
        )
        raise RuntimeError("platform search UI interaction failed") from exc


def _next_warmup_search_keywords(
    payload: dict[str, Any],
    keywords: Iterable[Any],
    *,
    limit: int = 3,
) -> list[str]:
    """Return the next keyword batch; each term may be searched at most twice."""
    cleaned = _sanitize_warmup_search_keywords(keywords, limit=12)
    if not cleaned:
        return []
    normalized = [_normalize_warmup_text(item).replace(" ", "") for item in cleaned]
    cycle = payload.get("_warmup_search_keyword_cycle")
    if (
        not isinstance(cycle, list)
        or len(cycle) != len(cleaned)
        or {
            _normalize_warmup_text(item).replace(" ", "")
            for item in cycle
        } != set(normalized)
    ):
        cycle = list(cleaned)
        random.shuffle(cycle)
        payload["_warmup_search_keyword_cycle"] = list(cycle)
        payload["_warmup_search_keyword_cursor"] = 0

    cursor = max(0, int(payload.get("_warmup_search_keyword_cursor") or 0))
    active = _normalize_warmup_text(payload.get("_warmup_active_search_keyword")).replace(" ", "")
    raw_use_counts = payload.get("_warmup_search_keyword_use_counts")
    use_counts = raw_use_counts if isinstance(raw_use_counts, dict) else {}
    eligible_use_counts = [
        int(use_counts.get(keyword_key) or 0)
        for keyword_key in normalized
        if keyword_key and int(use_counts.get(keyword_key) or 0) < 2
    ]
    if not eligible_use_counts:
        return []
    minimum_use_count = min(eligible_use_counts)
    selected: list[str] = []
    attempts = 0
    max_attempts = max(len(cycle) * 3, int(limit))
    while len(selected) < min(max(1, int(limit)), len(cycle)) and attempts < max_attempts:
        candidate = str(cycle[cursor % len(cycle)] or "").strip()
        cursor += 1
        attempts += 1
        candidate_key = _normalize_warmup_text(candidate).replace(" ", "")
        if not candidate_key or candidate in selected:
            continue
        if int(use_counts.get(candidate_key) or 0) != minimum_use_count:
            continue
        if active and len(cycle) > 1 and candidate_key == active:
            continue
        selected.append(candidate)
    payload["_warmup_search_keyword_cursor"] = cursor % len(cycle)
    return selected


def _mark_warmup_search_keyword_used(payload: dict[str, Any], keyword: str) -> int:
    """Record one real UI search attempt and return the keyword's use count."""
    keyword_key = _normalize_warmup_text(keyword).replace(" ", "")
    if not keyword_key:
        return 0
    raw_counts = payload.get("_warmup_search_keyword_use_counts")
    counts = raw_counts if isinstance(raw_counts, dict) else {}
    count = max(0, int(counts.get(keyword_key) or 0)) + 1
    counts[keyword_key] = count
    payload["_warmup_search_keyword_use_counts"] = counts
    return count


def _warmup_search_rotation_due(payload: dict[str, Any], *, phase: str) -> bool:
    if phase != "browse":
        return False
    if not str(payload.get("_warmup_active_search_keyword") or "").strip():
        return False
    target = _payload_int(
        payload,
        ("warmup_keyword_rotation_posts",),
        int(payload.get("_warmup_search_rotation_target") or 4),
        2,
        20,
    )
    return int(payload.get("_warmup_search_keyword_matches") or 0) >= target


def _activate_warmup_search_keyword(payload: dict[str, Any], keyword: str) -> None:
    payload["_warmup_active_search_keyword"] = str(keyword or "").strip()
    payload["_warmup_search_keyword_matches"] = 0
    _mark_warmup_search_keyword_used(payload, keyword)
    history_value = str(payload.get("_warmup_keyword_history_path") or "").strip()
    if history_value:
        _record_warmup_keyword_history(Path(history_value), keyword)
    if "warmup_keyword_rotation_posts" not in payload:
        payload["_warmup_search_rotation_target"] = random.randint(3, 5)


_WARMUP_RELEVANCE_IGNORED_TERMS = {
    "人设", "人格", "风格", "語氣", "语气", "自然", "真实", "真實",
    "中文", "简体中文", "簡體中文", "繁体中文", "繁體中文", "内容", "內容",
    "分享", "日常", "生活", "资深", "資深", "专业", "專業", "关注", "關注",
    "博主", "达人", "達人", "老师", "老師",
    "搞笑", "生活日常", "生活方式", "职场趣事", "職場趣事", "日常吐槽",
}

# These words describe an intent or presentation style, but not a searchable
# content domain by themselves.  A model may combine two or more of them into
# a fluent-looking phrase such as ``手艺展示`` or ``店里聊天``.  Such phrases
# are still ambiguous outside the prompt and must not drive browser searches.
_WARMUP_GENERIC_KEYWORD_PARTS = (
    "生活方式", "生活日常", "职场趣事", "日常吐槽", "手工活",
    "店里", "门店", "店铺", "工作", "职业", "行业", "顾客", "客户",
    "日常", "生活", "趣事", "吐槽", "互动", "聊天", "沟通", "交流",
    "手艺", "手工", "作品", "成果", "案例", "经验", "心得", "技巧",
    "知识", "问题", "建议", "见闻", "故事", "展示", "分享", "创作",
    "制作", "过程", "工具", "对象", "内容", "场景", "话题", "活动",
    "记录", "观察", "讨论", "方式", "趣闻", "手作", "小",
)

_WARMUP_RELEVANCE_BLOCKLIST = (
    "点击链接",
    "私信领取",
    "免费领取",
    "抽奖",
    "推广",
    "代购",
    "赚钱教程",
)


def _warmup_persona_core_terms(payload: dict[str, Any], limit: int = 8) -> list[str]:
    """Return conservative terms that describe the persona's primary identity."""
    raw_name = " ".join(str(payload.get("persona_name") or "").split())
    candidates: list[Any] = []
    role_candidates: list[Any] = []
    normalized_name = _normalize_warmup_text(raw_name).replace(" ", "")
    for suffix in ("工程师", "修理工", "设计师", "摄影师", "咨询师", "老师", "師", "师"):
        if normalized_name.endswith(suffix):
            stem = normalized_name[:-len(suffix)]
            if len(stem) >= 2:
                role_candidates.extend((raw_name, stem))

    topics = payload.get("persona_topics")
    if not role_candidates and not any(str(item or "").strip() for item in (topics or [])):
        context = " ".join(str(payload.get("persona_context") or "").split())
        for match in re.findall(r"[\u3400-\u9fff]{2,10}(?:工程师|修理工|设计师|摄影师|咨询师|老师|師|师)", context):
            profession = re.sub(r"^(?:资深|資深|专业|專業|高级|高級|一名|一个|一位)+", "", match)
            role_candidates.append(profession)
            for suffix in ("工程师", "修理工", "设计师", "摄影师", "咨询师", "老师", "師", "师"):
                if profession.endswith(suffix):
                    stem = profession[:-len(suffix)]
                    if len(stem) >= 2:
                        role_candidates.append(stem)

    candidates.extend(role_candidates)
    core_seed_keys = {
        _normalize_warmup_text(item).replace(" ", "")
        for item in role_candidates
        if len(_normalize_warmup_text(item).replace(" ", "")) >= 2
    }
    if isinstance(topics, list):
        for topic in topics:
            normalized_topic = _normalize_warmup_text(topic).replace(" ", "")
            if not core_seed_keys or any(
                len(seed) >= 2
                and (seed in normalized_topic or normalized_topic in seed)
                for seed in core_seed_keys
            ):
                candidates.append(topic)

    # A friendly display name such as "李师傅" identifies the account owner,
    # not the content domain.  When no profession can be derived, the explicit
    # persona topics are the safest lexical anchors; use the display name only
    # as a last resort when no topical data exists.
    if not candidates and raw_name:
        candidates.append(raw_name)

    return _sanitize_warmup_search_keywords(candidates, limit=limit)


def _sanitize_warmup_search_keywords(values: Iterable[Any], *, limit: int = 5) -> list[str]:
    """Keep only short, human-searchable persona keywords from model output."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        raw = " ".join(str(value or "").split()).strip("-•,，。;；:：[]()（）\"'")
        normalized = _normalize_warmup_text(raw).replace(" ", "")
        if (
            len(normalized) < 2
            or len(normalized) > 16
            or not re.search(r"[\u3400-\u9fff]", raw)
            or re.search(r"[A-Za-z]", raw)
            or normalized in _WARMUP_RELEVANCE_IGNORED_TERMS
            or any(normalized in term for term in _WARMUP_RELEVANCE_IGNORED_TERMS if len(term) > len(normalized))
            or _is_warmup_test_content(raw)
            or "http" in normalized.lower()
            or normalized in seen
        ):
            continue
        seen.add(normalized)
        cleaned.append(raw[:32])
        if len(cleaned) >= limit:
            break
    return cleaned


def _is_generic_warmup_search_keyword(value: Any) -> bool:
    """Return True when a keyword is composed only of non-domain intent words."""
    normalized = _normalize_warmup_text(value).replace(" ", "")
    if not normalized:
        return True
    reachable = {0}
    for index in range(len(normalized)):
        if index not in reachable:
            continue
        for part in _WARMUP_GENERIC_KEYWORD_PARTS:
            if normalized.startswith(part, index):
                reachable.add(index + len(part))
    return len(normalized) in reachable


def _keep_specific_warmup_search_keywords(
    payload: dict[str, Any],
    values: Iterable[Any],
    *,
    limit: int = 8,
) -> list[str]:
    """Drop model phrases that still make no sense without the persona prompt."""
    candidates = _sanitize_warmup_search_keywords(values, limit=max(24, int(limit) * 3))
    kept: list[str] = []
    rejected = payload.setdefault("_warmup_rejected_generic_keywords", [])
    if not isinstance(rejected, list):
        rejected = []
        payload["_warmup_rejected_generic_keywords"] = rejected
    rejected_keys = {
        _normalize_warmup_text(item).replace(" ", "")
        for item in rejected
    }
    for candidate in candidates:
        normalized = _normalize_warmup_text(candidate).replace(" ", "")
        if _is_generic_warmup_search_keyword(candidate):
            if normalized not in rejected_keys:
                rejected.append(candidate)
                rejected_keys.add(normalized)
            continue
        kept.append(candidate)
        if len(kept) >= max(1, int(limit)):
            break
    return kept


def _warmup_keyword_similarity(left: Any, right: Any) -> float:
    left_text = _normalize_warmup_text(left).replace(" ", "")
    right_text = _normalize_warmup_text(right).replace(" ", "")
    if not left_text or not right_text:
        return 0.0
    if left_text == right_text:
        return 1.0
    if min(len(left_text), len(right_text)) >= 4 and (
        left_text in right_text or right_text in left_text
    ):
        return 0.9

    def grams(value: str) -> set[str]:
        if len(value) < 2:
            return {value}
        return {value[index:index + 2] for index in range(len(value) - 1)}

    left_grams = grams(left_text)
    right_grams = grams(right_text)
    return len(left_grams & right_grams) / max(1, len(left_grams | right_grams))


def _select_diverse_warmup_keywords(
    values: Iterable[Any],
    *,
    recent: Iterable[Any] = (),
    limit: int = 8,
) -> list[str]:
    candidates = _sanitize_warmup_search_keywords(values, limit=max(24, int(limit) * 3))
    recent_terms = _sanitize_warmup_search_keywords(recent, limit=40)
    selected: list[str] = []
    for candidate in candidates:
        if any(_warmup_keyword_similarity(candidate, old) >= 0.72 for old in recent_terms):
            continue
        if any(_warmup_keyword_similarity(candidate, chosen) >= 0.72 for chosen in selected):
            continue
        selected.append(candidate)
        if len(selected) >= max(1, int(limit)):
            break
    return selected


def _warmup_ai_settings() -> tuple[str, str, list[str]]:
    try:
        from runtime_config_bootstrap import load_runtime_config

        runtime = load_runtime_config()
        host = str(runtime.get("llm_base_url") or "").strip()
        api_key = str(
            runtime.get("llm_api_key_gpt")
            or runtime.get("llm_api_key")
            or runtime.get("llm_api_key_gemini")
            or ""
        ).strip()
        model_order = str(
            runtime.get("llm_model_priority_order")
            or runtime.get("llm_default_model_gpt")
            or runtime.get("llm_default_model")
            or runtime.get("llm_default_model_gemini")
            or ""
        )
        models = list(dict.fromkeys(item.strip() for item in model_order.split(",") if item.strip()))
        return host, api_key, models
    except Exception:
        return "", "", []


def _warmup_model_timeout_seconds(payload: dict[str, Any]) -> int:
    return _payload_int(
        payload,
        ("warmup_model_timeout_seconds",),
        30,
        3,
        30,
    )


def _generate_warmup_search_keywords_with_ai(payload: dict[str, Any]) -> list[str]:
    """Generate reusable persona search queries exclusively through the model."""
    recent_keywords = _sanitize_warmup_search_keywords(
        payload.get("_warmup_recent_search_keywords") or [],
        limit=30,
    )
    cached = payload.get("_warmup_generated_search_keywords")
    if isinstance(cached, list):
        payload.setdefault("_warmup_search_keyword_source", "cache")
        return _select_diverse_warmup_keywords(
            _keep_specific_warmup_search_keywords(payload, cached, limit=8),
            limit=8,
        )

    host, api_key, models = _warmup_ai_settings()
    if not host or not api_key or not models:
        payload["_warmup_generated_search_keywords"] = []
        payload["_warmup_search_keyword_source"] = "model_unavailable"
        return []

    persona_name = str(payload.get("persona_name") or "当前人设").strip()
    persona_context = str(payload.get("persona_context") or "").strip()[:900]
    explicit_keywords = [
        str(item or "").strip()
        for item in (payload.get("persona_topics") or [])
        if str(item or "").strip()
    ]
    persona_topics = "、".join(
        explicit_keywords
    )[:300]
    persona_text = "\n".join(
        item
        for item in (
            f"名称：{persona_name}" if persona_name else "",
            f"背景：{persona_context}" if persona_context else "",
            f"关注主题：{persona_topics}" if persona_topics else "",
        )
        if item
    )
    request_kwargs = {
        "user_input": (
            "根据这个社交平台养号人设，生成 6-8 个最适合搜索相关内容的短关键词。\n"
            "要求：\n"
            "- 先在内部判断这个账号唯一的主要内容主轴，再生成关键词；优先级依次为明确身份/业务定位、长期内容领域、次要兴趣与性格描述。\n"
            "- 每个关键词单独拿出来时，都必须能明确关联到该主要内容主轴；不要抽取年龄、语言、语气、人格描述，也不要抽取泛生活描述。\n"
            "- 不要求每个关键词机械重复职业名称或人设名称；关键词自身已有明确的领域动作、对象、工具或场景时可以直接使用。不得为了多样化而删除必要的领域限定词；手艺、作品、问题、心得、建议、展示、聊天、日常等宽泛子主题必须带有明确的主轴限定词。允许多个关键词重复同一主轴限定词，搜索意图通过具体子主题区分。\n"
            "- 围绕同一主要内容主轴，从知识技能、具体场景、常见问题、工具对象、成果案例、行业见闻等不同子主题扩展，并覆盖不同搜索意图。\n"
            "- 至少 70% 必须属于主要内容主轴：分别生成 6 个主要内容主轴关键词和最多 2 个明确兴趣关键词；兴趣最多占 20%-30%，不足时宁可少给，不得用泛化内容补齐。\n"
            "- 兴趣扩展必须来自资料中明确、稳定的真实兴趣，并保持具体；不要把泛生活、泛作品或性格词当作兴趣关键词。\n"
            "- 不得把“手工、手艺、创作”等泛兴趣自行具体化为资料中未明确出现的门类、材料、对象或技法；资料没有写木雕、皮具、编织等具体方向时，不得猜测或新增。\n"
            "- 各关键词必须覆盖不同搜索意图，禁止同义改写或只换无信息量前后缀；可能产生歧义时必须共享同一主轴限定词。\n"
            "- 优先可在 Threads 或 Instagram 搜索命中的自然短语。\n"
            "- 与“近期已用关键词”保持低重复；除非完全没有替代词，否则不得再次生成其中的词或近义改写。\n"
            "- 必须全部是中文关键词，禁止英文、拼音、数字年龄、语言风格词。\n"
            '- 只返回 JSON：{"primary":["..."],"interests":["..."]}\n\n'
            f"人设：{persona_text}\n"
            f"显式关键词：{', '.join(explicit_keywords)}\n"
            f"近期已用关键词（优先避开）：{', '.join(recent_keywords) or '无'}"
        ),
        "host": host,
        "api_key": api_key,
        "retry_count": 1,
        "request_timeout_seconds": _warmup_model_timeout_seconds(payload),
        "temperature": 0.65,
        "max_output_tokens": 240,
        "system_prompt": (
            "根据给定人设的完整资料识别唯一主要内容主轴，并主要围绕该主轴生成中文搜索关键词；"
            "每个关键词脱离上下文后仍须能明确关联到主要主轴。"
            "不要求机械重复职业或人设名称；关键词自身已有明确领域语义时可直接使用。"
            "不得为追求表面多样性而省略必要的领域限定词；宽泛子主题必须保留主轴限定词，"
            "允许不同搜索意图重复同一主轴限定词。"
            "不要依赖固定职业表或硬编码模板。允许少量明确兴趣扩展，但主要主轴必须占至少七成，"
            "兴趣扩展不得超过三成，泛化描述不得成为搜索方向。"
            "各搜索意图彼此不同、低重复，避开近期已用词，并严格返回指定 JSON。"
        ),
    }
    try:
        import get_gemini

        for model in models:
            try:
                result = get_gemini.request_gemini3_pro_raw_text(**request_kwargs, model=model)
            except Exception:
                continue
            if not isinstance(result, dict) or result.get("ok") is not True:
                continue
            raw = str(result.get("raw_text") or "").strip()
            parsed: list[Any] = []
            with contextlib.suppress(Exception):
                object_start = raw.find("{")
                object_end = raw.rfind("}")
                candidate = (
                    json.loads(raw[object_start:object_end + 1])
                    if object_start >= 0 and object_end > object_start
                    else None
                )
                if isinstance(candidate, dict):
                    primary = _select_diverse_warmup_keywords(
                        candidate.get("primary") or [],
                        limit=6,
                    )
                    interests = _select_diverse_warmup_keywords(
                        candidate.get("interests") or [],
                        recent=primary,
                        limit=min(2, max(0, len(primary) * 3 // 7)),
                    )
                    if primary:
                        parsed = [*primary, *interests]
                    elif isinstance(candidate.get("keywords"), list):
                        parsed = candidate["keywords"]
            if not parsed:
                candidate = None
                with contextlib.suppress(Exception):
                    candidate = json.loads(raw[raw.find("["): raw.rfind("]") + 1])
                if isinstance(candidate, list):
                    parsed = candidate
            if not parsed:
                parsed = re.split(r"[\n,，、;；]+", raw)
            generated = _select_diverse_warmup_keywords(
                _keep_specific_warmup_search_keywords(payload, parsed, limit=8),
                limit=8,
            )
            if generated:
                payload["_warmup_generated_search_keywords"] = list(generated)
                payload["_warmup_search_keyword_source"] = f"model:{model}"
                return generated
    except Exception:
        pass

    payload["_warmup_generated_search_keywords"] = []
    payload["_warmup_search_keyword_source"] = "model_failed"
    return []


def _score_warmup_post_relevance(
    payload: dict[str, Any],
    target_text: Any,
    *,
    keywords: Iterable[Any] | None = None,
) -> dict[str, Any]:
    target = _normalize_warmup_text(target_text).replace(" ", "")
    core_terms = _warmup_persona_core_terms(payload, limit=8)
    core_keys = {
        _normalize_warmup_text(item).replace(" ", "")
        for item in core_terms
    }
    generic_single_chars = {
        "人", "生", "活", "日", "常", "家", "居", "工", "作", "好", "用",
        "方", "法", "技", "巧", "分", "享", "文", "化", "慢", "老", "退",
    }
    core_char_counts: dict[str, int] = {}
    for core_key in core_keys:
        for char in set(core_key):
            if re.fullmatch(r"[\u3400-\u9fff]", char):
                core_char_counts[char] = core_char_counts.get(char, 0) + 1
    salient_core_chars = {
        char
        for char, count in core_char_counts.items()
        if count >= 2 and char not in generic_single_chars
    }
    generated_keywords = _sanitize_warmup_search_keywords(keywords or [], limit=24)
    aligned_keywords = [
        keyword
        for keyword in generated_keywords
        if any(
            core_key
            and (
                core_key in _normalize_warmup_text(keyword).replace(" ", "")
                or _normalize_warmup_text(keyword).replace(" ", "") in core_key
            )
            for core_key in core_keys
        )
        or any(char in _normalize_warmup_text(keyword).replace(" ", "") for char in salient_core_chars)
    ]
    anchored_fragments: list[str] = []
    for keyword in aligned_keywords:
        normalized_keyword = _normalize_warmup_text(keyword).replace(" ", "")
        for size in range(2, min(4, len(normalized_keyword)) + 1):
            for index in range(0, len(normalized_keyword) - size + 1):
                fragment = normalized_keyword[index:index + size]
                if any(
                    core_key
                    and (core_key in fragment or fragment in core_key)
                    for core_key in core_keys
                ) or any(char in fragment for char in salient_core_chars):
                    anchored_fragments.append(fragment)
    cleaned_keywords = list(
        dict.fromkeys([*core_terms, *aligned_keywords, *anchored_fragments])
    )
    matched: list[str] = []
    score = 0
    if target and not _is_warmup_test_content(target_text):
        for keyword in cleaned_keywords:
            normalized = _normalize_warmup_text(keyword).replace(" ", "")
            if normalized and normalized in target:
                matched.append(keyword)
                score += 5 if len(normalized) >= 4 else 4
    return {
        "relevant": score >= 4,
        "score": score,
        "matched": matched[:8],
        "keywords": cleaned_keywords,
        "core_terms": core_terms,
    }


def _assess_warmup_post_relevance(
    payload: dict[str, Any],
    target_text: Any,
    *,
    keywords: Iterable[Any],
) -> dict[str, Any]:
    """Use an LLM when available; on failure, never weaken the lexical safety gate."""
    lexical = _score_warmup_post_relevance(payload, target_text, keywords=keywords)
    clean_target = " ".join(str(target_text or "").split())[:1200]
    if not clean_target or _is_warmup_test_content(clean_target):
        return lexical
    # A concrete persona/topic phrase has already passed the same lexical gate
    # as TG warmup.  Do not let an LLM's one-shot false negative reject an
    # otherwise confirmed search result.  Risk/verification guards still run
    # before any action is taken.
    normalized_target = _normalize_warmup_text(clean_target).replace(" ", "")
    if lexical["relevant"] and not any(term in normalized_target for term in _WARMUP_RELEVANCE_BLOCKLIST):
        return {**lexical, "model_checked": False}
    cache = payload.setdefault("_warmup_relevance_cache", {})
    cache_key = hashlib.sha256(clean_target.encode("utf-8", "ignore")).hexdigest()
    cached = cache.get(cache_key) if isinstance(cache, dict) else None
    if isinstance(cached, bool):
        return {**lexical, "relevant": cached, "model_checked": True}

    host, api_key, models = _warmup_ai_settings()
    if not host or not api_key or not models:
        return {**lexical, "model_checked": False}
    try:
        import get_gemini

        for model in models:
            try:
                result = get_gemini.request_gemini3_pro_raw_text(
                    user_input=(
                        f"人设：{payload.get('persona_name') or '当前人设'}\n"
                        f"人设背景：{str(payload.get('persona_context') or '')[:700]}\n"
                        f"人设关键词：{'、'.join(str(item) for item in keywords)}\n"
                        f"帖子：{clean_target}\n"
                        "帖子是否与该人设的主要内容主轴直接相关，或与资料中明确、稳定的真实兴趣直接相关，适合自然浏览和互动？"
                        "判断语义而不是逐字匹配：该领域的行业惯用词、专业动作、工具、流程和成果，即使没有原样出现人设关键词，也可视为主要内容主轴的直接命中。"
                        "兴趣内容可以相关，但必须明确命中真实兴趣，不能只靠泛生活或泛作品描述。"
                        "只输出 JSON：{\"relevant\":true} 或 {\"relevant\":false}。"
                    ),
                    host=host,
                    api_key=api_key,
                    retry_count=1,
                    request_timeout_seconds=_warmup_model_timeout_seconds(payload),
                    system_prompt=(
                        "相关性审核必须保守，主要内容主轴优先；资料中明确、稳定的真实兴趣也可判为相关。"
                        "不要要求帖子逐字包含人设关键词；行业内自然同义表达、具体专业技术、工具和流程可证明主要主轴相关。"
                        "泛化的作品、工作、经验、日常、生活、顾客等词不能单独证明相关；"
                        "误入的影视、书籍、求职或其他行业内容一律 false。"
                        "模糊、无关、测试或风险内容也一律 false。"
                    ),
                    model=model,
                )
            except Exception:
                continue
            raw = str(result.get("raw_text") or "") if isinstance(result, dict) and result.get("ok") is True else ""
            match = re.search(r'"relevant"\s*:\s*(true|false)', raw, re.IGNORECASE)
            if not match:
                continue
            relevant = match.group(1).lower() == "true"
            if isinstance(cache, dict):
                cache[cache_key] = relevant
            return {
                **lexical,
                # A positive model decision can admit a semantically relevant
                # post even when its wording differs from the search keyword.
                # A negative model decision always rejects it.
                "relevant": relevant,
                "model_checked": True,
            }
    except Exception:
        pass
    return {**lexical, "model_checked": False}


def _ensure_warmup_relevant_surface(
    page,
    payload: dict[str, Any],
    logger: AutomationLogger,
    *,
    platform: str,
    phase: str = "initial",
    excluded_target_keys: set[str] | None = None,
) -> dict[str, Any] | None:
    """Locate a persona-relevant post, searching the platform only after feed probes miss."""
    require_relevance = bool(payload.get("require_persona_relevance", True))
    keywords = _generate_warmup_search_keywords_with_ai(payload)
    excluded = {
        str(item or "").strip()
        for item in (excluded_target_keys or set())
        if str(item or "").strip()
    }
    if require_relevance and not keywords:
        logger.log(
            "error",
            f"{platform}_warmup_relevance",
            "The model did not produce persona keywords; stopping instead of browsing an unfiltered feed.",
            {
                "keyword_generation_source": payload.get("_warmup_search_keyword_source") or "unknown",
            },
        )
        return None
    if not require_relevance:
        context = _decorate_warmup_post_context(
            page,
            _current_warmup_post_context(page, platform),
            platform,
        )
        if {
            str(context.get("target_key") or ""),
            str(context.get("target_fingerprint") or ""),
        } & excluded:
            return None
        return context

    stage = f"{platform}_warmup_relevance"
    force_keyword_rotation = _warmup_search_rotation_due(payload, phase=phase)

    def inspect(label: str) -> dict[str, Any] | None:
        contexts = _visible_warmup_post_contexts(page, platform, limit=12)
        previews: list[str] = []
        duplicate_count = 0
        for candidate_index, context in enumerate(contexts):
            context = _decorate_warmup_post_context(page, context, platform)
            target_key = str(context.get("target_key") or "")
            target_fingerprint = str(context.get("target_fingerprint") or "")
            if {target_key, target_fingerprint} & excluded:
                duplicate_count += 1
                continue
            candidate_text = str(context.get("text") or "")
            relevance = _assess_warmup_post_relevance(
                payload,
                candidate_text,
                keywords=keywords,
            )
            if relevance["relevant"]:
                context["relevance"] = relevance
                context["selection_reason"] = f"{label}:candidate_{candidate_index + 1}"
                active_keyword = str(payload.get("_warmup_active_search_keyword") or "").strip()
                current_url = str(getattr(page, "url", "") or "").lower()
                if active_keyword and (label.startswith("search:") or "/search" in current_url):
                    payload["_warmup_search_keyword_matches"] = (
                        int(payload.get("_warmup_search_keyword_matches") or 0) + 1
                    )
                logger.log(
                    "info",
                    stage,
                    "已定位人设相关内容。",
                    {
                        "surface": label,
                        "candidate_index": candidate_index + 1,
                        "matched": relevance["matched"],
                        "score": relevance["score"],
                        "target_key": target_key,
                        "target_url": context.get("target_url") or "",
                    },
                )
                return context
            if candidate_text:
                previews.append(candidate_text[:80])
        logger.log(
            "debug",
            stage,
            "当前内容与人设不匹配，继续寻找相关内容。",
            {
                "surface": label,
                "candidate_count": len(contexts),
                "previews": previews[:3],
                "keywords": keywords[:5],
                "duplicates_skipped": duplicate_count,
            },
        )
        return None

    probe_limit = 3 if phase == "initial" else 2
    if not force_keyword_rotation:
        for probe in range(probe_limit):
            context = inspect(f"feed_probe_{probe + 1}")
            if context:
                return context
            if probe < probe_limit - 1:
                _slow_human_scroll(page)
                _sleep_between(0.8, 1.6)
    else:
        logger.log(
            "info",
            stage,
            "当前关键词已完成本轮浏览，正在周期轮换下一个人设关键词。",
            {
                "previous_keyword": payload.get("_warmup_active_search_keyword") or "",
                "matched_posts": int(payload.get("_warmup_search_keyword_matches") or 0),
            },
        )

    search_keywords = _next_warmup_search_keywords(payload, keywords, limit=3)
    if not search_keywords:
        logger.log(
            "warn",
            stage,
            "All persona keywords have completed their allowed two search cycles; stopping to avoid repetitive browsing.",
            {
                "keyword_use_counts": payload.get("_warmup_search_keyword_use_counts") or {},
                "keywords": keywords[:8],
            },
        )
        return None
    for keyword in search_keywords:
        logger.log(
            "info",
            stage,
            "推荐流未命中或当前搜索周期已完成，切换到人设关键词搜索。",
            {"keyword": keyword},
        )
        try:
            search_driver = _search_warmup_interest_surface(page, platform, keyword, logger)
        except Exception as exc:
            _mark_warmup_search_keyword_used(payload, keyword)
            logger.log(
                "warn",
                f"{stage}_search_retry",
                "当前关键词的页面搜索未完成，继续尝试下一个低重复关键词。",
                {"keyword": keyword, "error": str(exc)[:500]},
            )
            continue
        _activate_warmup_search_keyword(payload, keyword)
        for scan in range(3):
            context = inspect(f"search:{keyword}:{scan + 1}")
            if context:
                context["search_keyword"] = keyword
                context["search_driver"] = search_driver
                return context
            if scan < 2:
                _slow_human_scroll(page)
                _sleep_between(0.8, 1.6)

    logger.log("warn", stage, "未找到与人设相关的内容，停止本次养号以避免无关互动。", {"keywords": keywords[:5]})
    return None


def _warmup_action_history_path(
    screenshot_dir: Path,
    task: dict[str, Any],
    platform: str,
) -> Path | None:
    account_id = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(task.get("account_id") or "").strip())
    if not account_id:
        return None
    root = Path(screenshot_dir).parent / "warmup_action_history"
    return root / f"{str(platform or '').strip().lower()}_{account_id}.json"


def _warmup_keyword_history_path(action_history_path: Path | None) -> Path | None:
    if action_history_path is None:
        return None
    path = Path(action_history_path)
    return path.with_name(f"{path.stem}_keywords.json")


def _load_warmup_keyword_history(path: Path | None, *, limit: int = 30) -> list[str]:
    if path is None or not Path(path).is_file():
        return []
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return []
    rows = raw if isinstance(raw, list) else []
    keywords: list[str] = []
    for row in reversed(rows):
        value = row.get("keyword") if isinstance(row, dict) else row
        keyword = " ".join(str(value or "").split())
        if keyword and keyword not in keywords:
            keywords.append(keyword)
        if len(keywords) >= max(1, int(limit)):
            break
    return keywords


def _record_warmup_keyword_history(path: Path | None, keyword: str) -> None:
    clean_keyword = " ".join(str(keyword or "").split())
    if path is None or not clean_keyword:
        return
    history_path = Path(path)
    with _WARMUP_ACTION_HISTORY_LOCK:
        rows: list[dict[str, Any]] = []
        if history_path.is_file():
            with contextlib.suppress(Exception):
                raw = json.loads(history_path.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    rows = [row for row in raw if isinstance(row, dict)]
        rows.append({"keyword": clean_keyword[:80], "usedAt": int(time.time())})
        rows = rows[-200:]
        history_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = history_path.with_suffix(f"{history_path.suffix}.tmp")
        temp_path.write_text(
            json.dumps(rows, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temp_path.replace(history_path)


def _load_warmup_action_history(path: Path | None) -> dict[str, dict[str, Any]]:
    empty: dict[str, dict[str, Any]] = {"browsed": {}, "liked": {}, "commented": {}}
    if path is None or not Path(path).is_file():
        return empty
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return empty
    if not isinstance(raw, dict):
        return empty
    return {
        action: dict(raw.get(action) or {}) if isinstance(raw.get(action), dict) else {}
        for action in ("browsed", "liked", "commented")
    }


def _warmup_history_identity_keys(rows: dict[str, Any]) -> set[str]:
    keys = {str(item or "").strip() for item in rows if str(item or "").strip()}
    for record in rows.values():
        if not isinstance(record, dict):
            continue
        fingerprint = str(record.get("targetFingerprint") or "").strip()
        if fingerprint:
            keys.add(fingerprint)
    return keys


def _record_warmup_action_history(
    path: Path | None,
    *,
    action: str,
    target: dict[str, Any],
    text: str = "",
    keyword: str = "",
) -> None:
    clean_action = str(action or "").strip().lower()
    bucket = {
        "browse": "browsed",
        "browsed": "browsed",
        "like": "liked",
        "liked": "liked",
        "comment": "commented",
        "commented": "commented",
    }.get(clean_action, "")
    target_key = str(target.get("target_key") or "").strip()
    if path is None or not bucket or not target_key:
        return
    history_path = Path(path)
    with _WARMUP_ACTION_HISTORY_LOCK:
        history = _load_warmup_action_history(history_path)
        rows = history[bucket]
        rows[target_key] = {
            "targetKey": target_key,
            "targetUrl": str(target.get("target_url") or ""),
            "targetFingerprint": str(target.get("target_fingerprint") or ""),
            "text": str(text or "")[:160],
            "keyword": str(keyword or "")[:80],
            "confirmedAt": int(time.time()),
        }
        # Keep the on-disk ledger bounded while preserving the most recent
        # confirmed interactions across task restarts.
        if len(rows) > 2000:
            ordered = sorted(
                rows.items(),
                key=lambda item: int((item[1] or {}).get("confirmedAt") or 0),
                reverse=True,
            )[:2000]
            history[bucket] = dict(ordered)
        history_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = history_path.with_suffix(f"{history_path.suffix}.tmp")
        temp_path.write_text(
            json.dumps(history, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temp_path.replace(history_path)


_WARMUP_MEDIA_GUARD_SCRIPT = r"""
(() => {
    if (window.__tgWarmupMediaGuardInstalled) return;

    const lightweightMode = () => Boolean(window.__tgWarmupLightweightMediaMode);
    const holdLightweightMedia = (media) => {
        media.__tgWarmupResumeWhenVisible = false;
        media.autoplay = false;
        media.preload = "none";
        if (typeof media.pause === "function" && !media.paused) {
            media.pause();
        }
    };

    const restoreReleasedMedia = (media) => {
        if (lightweightMode()) return;
        const released = media.__tgWarmupReleasedMedia;
        if (!released) return;
        media.__tgWarmupReleasedMedia = null;
        if (released.src !== null) {
            media.setAttribute("src", released.src);
        }
        for (const source of released.sources || []) {
            if (source.node && source.src !== null) {
                source.node.setAttribute("src", source.src);
            }
        }
        media.preload = "metadata";
        try {
            media.load();
        } catch (_error) {}
        if (Number.isFinite(released.currentTime) && released.currentTime > 0) {
            const restoreTime = () => {
                try {
                    media.currentTime = released.currentTime;
                } catch (_error) {}
            };
            if (media.readyState >= 1) restoreTime();
            else media.addEventListener("loadedmetadata", restoreTime, { once: true });
        }
        if (released.wasPlaying) {
            media.__tgWarmupResumeWhenVisible = true;
        }
    };

    const observed = new WeakSet();
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const media = entry.target;
            if (lightweightMode()) {
                holdLightweightMedia(media);
            } else if (!entry.isIntersecting && typeof media.pause === "function") {
                if (!media.paused) {
                    media.__tgWarmupResumeWhenVisible = true;
                    media.pause();
                }
            } else if (entry.isIntersecting) {
                restoreReleasedMedia(media);
                if (media.__tgWarmupResumeWhenVisible) {
                    media.__tgWarmupResumeWhenVisible = false;
                    if (media.preload === "none") media.preload = "metadata";
                    const resume = media.play();
                    if (resume && typeof resume.catch === "function") {
                        resume.catch(() => {});
                    }
                }
            }
        }
    }, { rootMargin: "300px 0px", threshold: 0.01 });

    const tune = (root) => {
        const videos = [];
        if (root instanceof HTMLVideoElement) videos.push(root);
        if (root && typeof root.querySelectorAll === "function") {
            videos.push(...root.querySelectorAll("video"));
        }
        for (const video of videos) {
            if (lightweightMode()) {
                holdLightweightMedia(video);
            } else if (!video.getAttribute("preload") || video.preload === "auto") {
                video.preload = "metadata";
            }
            if (!observed.has(video)) {
                observed.add(video);
                video.addEventListener("play", () => {
                    if (lightweightMode()) holdLightweightMedia(video);
                }, true);
                observer.observe(video);
            }
        }
    };

    tune(document);
    const observationRoot = document.documentElement || document;
    new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node && node.nodeType === Node.ELEMENT_NODE) tune(node);
            }
        }
    }).observe(observationRoot, { childList: true, subtree: true });
    window.__tgWarmupMediaGuardInstalled = true;
})();
"""


def _resource_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        value = int(default)
    return max(int(minimum), min(int(value), int(maximum)))


def _warmup_resource_pressure(
    context_control: dict[str, Any] | None,
) -> dict[str, Any]:
    normal = {
        "level": "normal",
        "container_memory_mb": 0,
        "memory_available_mb": 0,
        "should_compact": False,
    }
    if not isinstance(context_control, dict):
        return normal
    provider = context_control.get("resource_snapshot_provider")
    if not callable(provider):
        return normal
    try:
        raw = provider()
    except Exception:
        return normal
    if not isinstance(raw, dict):
        return normal

    container_mb = max(0, _safe_int(raw.get("container_memory_mb"), 0))
    available_mb = max(0, _safe_int(raw.get("memory_available_mb"), 0))
    available_known = bool(
        _safe_int(raw.get("memory_available_known"), 0)
        or available_mb > 0
    )
    soft_container_mb = _resource_env_int(
        "SOCIAL_AUTOMATION_BROWSER_SOFT_CONTAINER_MB",
        1280,
        512,
        16384,
    )
    hard_container_mb = _resource_env_int(
        "SOCIAL_AUTOMATION_BROWSER_HARD_CONTAINER_MB",
        1536,
        soft_container_mb,
        32768,
    )
    soft_available_mb = _resource_env_int(
        "SOCIAL_AUTOMATION_BROWSER_SOFT_AVAILABLE_MB",
        1024,
        256,
        16384,
    )
    hard_available_mb = _resource_env_int(
        "SOCIAL_AUTOMATION_BROWSER_HARD_AVAILABLE_MB",
        768,
        128,
        soft_available_mb,
    )
    emergency_available_mb = _resource_env_int(
        "SOCIAL_AUTOMATION_BROWSER_EMERGENCY_AVAILABLE_MB",
        448,
        128,
        hard_available_mb,
    )

    if available_known and available_mb <= emergency_available_mb:
        level = "emergency"
    elif container_mb >= hard_container_mb or (
        available_known and available_mb <= hard_available_mb
    ):
        level = "hard"
    elif container_mb >= soft_container_mb or (
        available_known and available_mb <= soft_available_mb
    ):
        level = "soft"
    else:
        level = "normal"

    lock = context_control.get("resource_metrics_lock")
    guard = lock if hasattr(lock, "__enter__") else contextlib.nullcontext()
    with guard:
        metrics = context_control.setdefault("_resource_metrics", {})
        if isinstance(metrics, dict):
            if container_mb > 0:
                metrics.setdefault("container_memory_start_mb", container_mb)
                metrics["container_memory_peak_mb"] = max(
                    _safe_int(metrics.get("container_memory_peak_mb"), 0),
                    container_mb,
                )
            if available_known:
                previous_known = bool(metrics.get("memory_available_min_known"))
                previous_min = _safe_int(metrics.get("memory_available_min_mb"), 0)
                metrics["memory_available_min_mb"] = (
                    available_mb
                    if not previous_known
                    else min(previous_min, available_mb)
                )
                metrics["memory_available_min_known"] = True
            metrics["last_pressure_level"] = level

    return {
        "level": level,
        "container_memory_mb": container_mb,
        "memory_available_mb": available_mb,
        "memory_available_known": available_known,
        "should_compact": level != "normal",
    }


def _warmup_media_guard_script(*, lightweight: bool) -> str:
    mode = "true" if lightweight else "false"
    return (
        f"window.__tgWarmupLightweightMediaMode = {mode};\n"
        + _WARMUP_MEDIA_GUARD_SCRIPT
    )


def _install_automation_media_guard(page) -> None:
    """Install the passive guard for login, publish, browse, and warmup pages."""
    if not _conservative_browser_resources_enabled():
        return
    _install_warmup_media_guard(page, lightweight=False)


def _install_warmup_media_guard(page, *, lightweight: bool = False) -> None:
    script = _warmup_media_guard_script(lightweight=lightweight)
    with contextlib.suppress(Exception):
        page.add_init_script(script)
    with contextlib.suppress(Exception):
        page.evaluate(script)


def _ensure_warmup_media_guard(page, *, lightweight: bool = False) -> None:
    """Verify the init script survived navigation and repair it in-place if needed."""
    installed = False
    with contextlib.suppress(Exception):
        installed = bool(
            page.evaluate("() => Boolean(window.__tgWarmupMediaGuardInstalled)")
        )
    if not installed:
        _install_warmup_media_guard(page, lightweight=lightweight)


def _compact_warmup_page_in_place(
    page,
    *,
    pressure_level: str = "soft",
) -> dict[str, int]:
    """Release off-screen media without navigating or replacing the visible tab."""
    clean_pressure_level = str(pressure_level or "soft").strip().lower()
    if clean_pressure_level not in {"soft", "hard", "emergency"}:
        clean_pressure_level = "soft"
    try:
        result = page.evaluate(
            """(pressureLevel) => {
                let paused = 0;
                let deferred = 0;
                let released = 0;
                const viewport = Math.max(window.innerHeight || 0, 640);
                const upperMargin = pressureLevel === "soft"
                    ? viewport
                    : pressureLevel === "hard"
                        ? viewport * 0.5
                        : 300;
                const lowerMargin = pressureLevel === "soft"
                    ? viewport * 2
                    : pressureLevel === "hard"
                        ? viewport * 1.5
                        : viewport + 300;
                for (const video of document.querySelectorAll("video")) {
                    const rect = video.getBoundingClientRect();
                    const nearViewport = (
                        rect.bottom >= -upperMargin
                        && rect.top <= lowerMargin
                    );
                    if (!nearViewport) {
                        if (!video.paused) {
                            video.__tgWarmupResumeWhenVisible = true;
                            video.pause();
                            paused += 1;
                        }
                        if (video.preload !== "none") {
                            video.preload = "none";
                            deferred += 1;
                        }
                        if (
                            !video.__tgWarmupReleasedMedia
                            && (
                                video.getAttribute("src") !== null
                                || Array.from(video.querySelectorAll("source")).some(
                                    (source) => source.getAttribute("src") !== null
                                )
                            )
                        ) {
                            video.__tgWarmupReleasedMedia = {
                                src: video.getAttribute("src"),
                                sources: Array.from(video.querySelectorAll("source")).map(
                                    (source) => ({
                                        node: source,
                                        src: source.getAttribute("src"),
                                    })
                                ),
                                currentTime: Number(video.currentTime || 0),
                                wasPlaying: Boolean(video.__tgWarmupResumeWhenVisible),
                            };
                            video.removeAttribute("src");
                            for (const source of video.querySelectorAll("source")) {
                                source.removeAttribute("src");
                            }
                            try {
                                video.load();
                            } catch (_error) {}
                            released += 1;
                        }
                    } else if (!video.getAttribute("preload") || video.preload === "auto") {
                        video.preload = "metadata";
                    }
                }
                return { paused, deferred, released };
            }""",
            clean_pressure_level,
        )
    except Exception:
        return {"paused": 0, "deferred": 0, "released": 0}
    return {
        "paused": max(0, _safe_int((result or {}).get("paused"), 0)),
        "deferred": max(0, _safe_int((result or {}).get("deferred"), 0)),
        "released": max(0, _safe_int((result or {}).get("released"), 0)),
    }


def _maybe_compact_warmup_page(
    page,
    logger: AutomationLogger,
    *,
    platform: str,
    context_control: dict[str, Any] | None,
    last_compaction_at: float,
    proactive: bool = False,
) -> dict[str, Any]:
    pressure = _warmup_resource_pressure(context_control)
    result = {
        "page": page,
        "pressure": pressure,
        "last_compaction_at": float(last_compaction_at),
        "deadline_extension_seconds": 0.0,
    }
    if not pressure["should_compact"] and not proactive:
        return result
    if proactive:
        cooldown = _resource_env_int(
            "SOCIAL_AUTOMATION_LIGHTWEIGHT_WARMUP_COMPACTION_COOLDOWN_SECONDS",
            DEFAULT_LIGHTWEIGHT_WARMUP_COMPACTION_COOLDOWN_SECONDS,
            15,
            300,
        )
    else:
        cooldown = _resource_env_int(
            "SOCIAL_AUTOMATION_WARMUP_RESOURCE_COMPACTION_COOLDOWN_SECONDS",
            DEFAULT_WARMUP_RESOURCE_COMPACTION_COOLDOWN_SECONDS,
            30,
            900,
        )
    started_at = time.monotonic()
    if last_compaction_at > 0 and started_at - last_compaction_at < cooldown:
        return result
    compacted = _compact_warmup_page_in_place(
        page,
        pressure_level=(
            pressure["level"] if pressure["level"] != "normal" else "soft"
        ),
    )
    lock = (
        context_control.get("resource_metrics_lock")
        if isinstance(context_control, dict)
        else None
    )
    guard = lock if hasattr(lock, "__enter__") else contextlib.nullcontext()
    with guard:
        metrics = (
            context_control.setdefault("_resource_metrics", {})
            if isinstance(context_control, dict)
            else {}
        )
        if isinstance(metrics, dict):
            metrics["inplace_compactions"] = (
                _safe_int(metrics.get("inplace_compactions"), 0) + 1
            )
            metrics["released_media_buffers"] = (
                _safe_int(metrics.get("released_media_buffers"), 0)
                + _safe_int(compacted.get("released"), 0)
            )
            metrics["last_compaction_pressure"] = (
                pressure["level"] if pressure["level"] != "normal" else "proactive"
            )
    logger.log(
        "warn" if pressure["level"] in {"hard", "emergency"} else "info",
        f"{platform}_warmup_resource_compaction",
        "已在当前画面内释放不可见媒体资源，任务继续执行。",
        {"pressure": pressure, "proactive": bool(proactive), **compacted},
    )
    result["last_compaction_at"] = started_at
    return result


def _public_warmup_resource_metrics(
    context_control: dict[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(context_control, dict):
        return {}
    lock = context_control.get("resource_metrics_lock")
    guard = lock if hasattr(lock, "__enter__") else contextlib.nullcontext()
    with guard:
        metrics = context_control.get("_resource_metrics")
        if not isinstance(metrics, dict):
            return {}
        return {
            "containerMemoryStartMb": _safe_int(
                metrics.get("container_memory_start_mb"),
                0,
            ),
            "containerMemoryPeakMb": _safe_int(
                metrics.get("container_memory_peak_mb"),
                0,
            ),
            "memoryAvailableMinMb": _safe_int(
                metrics.get("memory_available_min_mb"),
                0,
            ),
            "memoryAvailableMinKnown": bool(
                metrics.get("memory_available_min_known")
            ),
            "inplaceCompactions": _safe_int(metrics.get("inplace_compactions"), 0),
            "releasedMediaBuffers": _safe_int(
                metrics.get("released_media_buffers"),
                0,
            ),
            "lastPressureLevel": str(metrics.get("last_pressure_level") or "normal"),
        }


def _run_platform_warmup(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    clean_platform = str(platform or "").strip().lower()
    if clean_platform not in {"threads", "instagram"}:
        raise UnsupportedActionError(f"Unsupported warmup platform: {clean_platform}")

    stage = f"{clean_platform}_warmup"
    home_url = THREADS_HOME if clean_platform == "threads" else INSTAGRAM_HOME
    lightweight_media = _lightweight_threads_warmup_requested(
        task,
        payload,
        clean_platform,
    )
    _install_warmup_media_guard(page, lightweight=lightweight_media)
    _goto(page, home_url, logger, stage)
    _ensure_warmup_media_guard(page, lightweight=lightweight_media)
    _guard_warmup_risk(
        page,
        clean_platform,
        payload,
        logger,
        task=task,
        screenshot_dir=screenshot_dir,
        cancel_event=cancel_event,
        context_control=context_control,
    )
    if clean_platform == "instagram":
        _dismiss_instagram_interstitials(page, logger)

    browse_limit = _payload_int(
        payload,
        ("browse_limit", "browse_count", "scroll_times"),
        80,
        1,
        300,
    )
    like_limit = _payload_int(
        payload,
        ("like_limit",),
        0,
        0,
        MAX_WARMUP_LIKES,
    )
    like_chance = _payload_int(
        payload,
        ("like_chance",),
        100 if like_limit > 0 else 0,
        0,
        100,
    )
    max_comments = _payload_int(
        payload,
        ("max_comments",),
        0,
        0,
        MAX_WARMUP_COMMENTS,
    )
    comment_chance = _payload_int(payload, ("comment_chance",), 0, 0, 100)
    search_chance = _payload_int(payload, ("search_chance",), 0, 0, 100)
    session_seconds = _warmup_session_seconds(payload)
    remaining_session_seconds = _remaining_warmup_session_seconds(
        task,
        session_seconds,
    )
    deadline = time.monotonic() + remaining_session_seconds
    strategy_id = str(payload.get("strategy_id") or "tg_default")
    strategy_label = str(payload.get("strategy_label") or "default_warmup")
    (
        min_required_likes,
        min_required_comments,
        min_required_interactions,
    ) = _warmup_minimum_targets(
        payload,
        like_limit=like_limit,
        max_comments=max_comments,
    )

    history_path = _warmup_action_history_path(
        Path(screenshot_dir),
        task,
        clean_platform,
    )
    keyword_history_path = _warmup_keyword_history_path(history_path)
    payload["_warmup_keyword_history_path"] = (
        str(keyword_history_path) if keyword_history_path is not None else ""
    )
    payload["_warmup_recent_search_keywords"] = _load_warmup_keyword_history(
        keyword_history_path,
        limit=30,
    )
    persona_keywords = _generate_warmup_search_keywords_with_ai(payload)
    action_history = _load_warmup_action_history(history_path)
    historical_browsed_target_keys = _warmup_history_identity_keys(action_history["browsed"])
    liked_target_keys = _warmup_history_identity_keys(action_history["liked"])
    commented_target_keys = _warmup_history_identity_keys(action_history["commented"])
    historical_action_keys = liked_target_keys | commented_target_keys
    historical_seen_target_keys = historical_browsed_target_keys | historical_action_keys
    browsed_target_keys: set[str] = set()
    unique_browsed_target_keys: set[str] = set()
    opened_target_keys: set[str] = set()
    action_records: list[dict[str, Any]] = []

    logger.log(
        "info",
        stage,
        f"Starting {clean_platform} warmup with the shared strategy executor.",
        {
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "browse_limit": browse_limit,
            "session_seconds": session_seconds,
            "setup_elapsed_seconds": max(
                0,
                int(session_seconds - max(0.0, deadline - time.monotonic())),
            ),
            "remaining_session_seconds": max(
                0,
                int(deadline - time.monotonic()),
            ),
            "like_limit": like_limit,
            "like_chance": like_chance,
            "max_comments": max_comments,
            "comment_chance": comment_chance,
            "search_chance": search_chance,
            "persona_name": payload.get("persona_name") or "",
            "persona_keywords": persona_keywords[:8],
            "keyword_generation_source": payload.get("_warmup_search_keyword_source") or "unknown",
            "recent_search_keywords_avoided": payload.get("_warmup_recent_search_keywords") or [],
            "historical_browsed_targets": len(action_history["browsed"]),
            "historical_liked_targets": len(action_history["liked"]),
            "historical_commented_targets": len(action_history["commented"]),
        },
    )

    require_persona_relevance = bool(
        payload.get("require_persona_relevance", True)
    )

    initial_surface = _ensure_warmup_relevant_surface(
        page,
        payload,
        logger,
        platform=clean_platform,
        phase="initial",
        excluded_target_keys=historical_seen_target_keys,
    )
    if require_persona_relevance and persona_keywords and not initial_surface:
        raise RuntimeError("当前推荐流与人设关键词均未找到相关内容，已停止避免无关互动。")

    liked = 0
    commented = 0
    browsed = 0
    opened_posts = 0
    like_backfills = 0
    comment_backfills = 0
    like_screenshots: list[str] = []
    comment_screenshots: list[str] = []
    interaction_evidence: list[tuple[str, int, str]] = []
    used_comment_texts: set[str] = set()
    next_interaction_at = _next_warmup_interaction_at(0, payload)
    last_resource_compaction_at = 0.0

    while time.monotonic() < deadline and browsed < browse_limit:
        _raise_if_cancelled(cancel_event)
        resource_management = _maybe_compact_warmup_page(
            page,
            logger,
            platform=clean_platform,
            context_control=context_control,
            last_compaction_at=last_resource_compaction_at,
            proactive=lightweight_media,
        )
        page = resource_management["page"]
        last_resource_compaction_at = float(
            resource_management["last_compaction_at"]
        )
        deadline += float(resource_management["deadline_extension_seconds"])
        if clean_platform == "instagram":
            _dismiss_instagram_interstitials(page, logger)
        _guard_warmup_risk(
            page,
            clean_platform,
            payload,
            logger,
            task=task,
            screenshot_dir=screenshot_dir,
            cancel_event=cancel_event,
            context_control=context_control,
        )

        # A scroll can replace the viewport entirely. Re-establish a relevant
        # post before every browse, open, like, or comment action on both platforms.
        relevant_surface = _ensure_warmup_relevant_surface(
            page,
            payload,
            logger,
            platform=clean_platform,
            phase="browse",
            excluded_target_keys=browsed_target_keys | historical_seen_target_keys,
        )
        if require_persona_relevance and persona_keywords and not relevant_surface:
            completed_interactions = liked + commented
            requirements_met = (
                completed_interactions > 0
                and liked >= min_required_likes
                and commented >= min_required_comments
                and completed_interactions >= min_required_interactions
            )
            if requirements_met:
                logger.log(
                    "info",
                    f"{clean_platform}_warmup_relevance",
                    "当前任务已达到最低互动目标；相关内容已耗尽，安全结束并整理证据。",
                    {
                        "liked": liked,
                        "commented": commented,
                        "interactions": completed_interactions,
                    },
                )
                break
            raise RuntimeError("当前推荐流和搜索结果均未找到与人设相关的内容，已停止避免无关浏览或互动。")
        if time.monotonic() >= deadline:
            logger.log(
                "info",
                f"{clean_platform}_warmup_time_budget_complete",
                "养号时间已到，不再开始新的浏览或互动动作。",
                {
                    "liked": liked,
                    "commented": commented,
                    "minimum_likes": min_required_likes,
                    "minimum_comments": min_required_comments,
                    "minimum_interactions": min_required_interactions,
                },
            )
            break
        target = _decorate_warmup_post_context(
            page,
            relevant_surface or _current_warmup_post_context(page, clean_platform),
            clean_platform,
        )
        target_key = str(target.get("target_key") or "")
        target_fingerprint = str(target.get("target_fingerprint") or "")
        target_url = str(target.get("target_url") or "")
        browsed_target_keys.update(
            key for key in (target_key, target_fingerprint) if key
        )
        if target_key:
            unique_browsed_target_keys.add(target_key)
            _record_warmup_action_history(
                history_path,
                action="browse",
                target=target,
                keyword=str(
                    target.get("search_keyword")
                    or payload.get("_warmup_active_search_keyword")
                    or ""
                ),
            )
            logger.log(
                "info",
                f"{clean_platform}_warmup_browse_record",
                "已记录本次浏览帖子，后续任务将跳过同一内容。",
                {
                    "target_key": target_key,
                    "target_url": target_url,
                },
            )
        active_keyword = str(
            target.get("search_keyword")
            or payload.get("_warmup_active_search_keyword")
            or ""
        )

        elapsed_ratio = 1 - max(
            0,
            deadline - time.monotonic(),
        ) / max(1, session_seconds)
        # ``browsed`` is the number of posts fully completed before the current
        # candidate. Do not interact until the configured 2-3 completed-post
        # interval has actually elapsed.
        interaction_due = browsed >= next_interaction_at
        interacted = False
        both_minimum_actions_pending = (
            liked < min_required_likes
            and commented < min_required_comments
        )
        prefer_comment = (
            interaction_due
            and like_limit > liked
            and max_comments > commented
            and not both_minimum_actions_pending
            and random.random() < 0.5
        )
        should_backfill_interaction = (
            liked + commented < min_required_interactions
            and elapsed_ratio >= 0.35
        )
        should_backfill_like = liked < min_required_likes or should_backfill_interaction
        should_try_like = (
            should_backfill_like
            or random.randint(1, 100) <= like_chance
        )
        if (
            like_limit > liked
            and interaction_due
            and not prefer_comment
            and should_try_like
            and target_key not in liked_target_keys
        ):
            if clean_platform == "threads":
                clicked_likes = _click_some_threads_likes(
                    page,
                    logger,
                    1,
                    target_root=target.get("root"),
                )
            else:
                clicked_likes = _click_some_instagram_likes(
                    page,
                    logger,
                    1,
                    target_root=target.get("root"),
                )
                _dismiss_instagram_interstitials(page, logger)
            liked += clicked_likes
            interacted = clicked_likes > 0
            if clicked_likes:
                if target_key:
                    liked_target_keys.update(
                        key for key in (target_key, target_fingerprint) if key
                    )
                    historical_action_keys.update(liked_target_keys)
                action_record = {
                    "action": "like",
                    "targetKey": target_key,
                    "targetFingerprint": target_fingerprint,
                    "targetUrl": target_url,
                    "keyword": active_keyword,
                    "confirmedAt": int(time.time()),
                }
                action_records.append(action_record)
                _record_warmup_action_history(
                    history_path,
                    action="like",
                    target=target,
                    keyword=active_keyword,
                )
                logger.log(
                    "info",
                    f"{stage}_interaction_record",
                    "已记录确认成功的点赞目标。",
                    action_record,
                )
                shot_like = _screenshot(
                    page,
                    screenshot_dir,
                    task,
                    f"{stage}_like_{liked}",
                    logger,
                )
                if shot_like:
                    like_screenshots.append(shot_like)
                    interaction_evidence.append(("like", liked, shot_like))
            if not clicked_likes:
                like_backfills += 1
                logger.log(
                    "warn",
                    f"{stage}_like_backfill",
                    "Like action was not confirmed; continuing to another target.",
                    {
                        "attempts": like_backfills,
                        "liked": liked,
                        "target": min_required_likes,
                    },
                )

        should_backfill_comment = (
            commented < min_required_comments
            or should_backfill_interaction
        ) and elapsed_ratio >= 0.45
        should_chain_required_comment = (
            interacted
            and both_minimum_actions_pending
            and commented < min_required_comments
        )
        if (
            max_comments > commented
            and comment_chance > 0
            and interaction_due
            and (not interacted or should_chain_required_comment)
            and target_key not in commented_target_keys
            and (
                prefer_comment
                or should_chain_required_comment
                or should_backfill_comment
                or random.randint(1, 100) <= comment_chance
            )
        ):
            target_text = str(target.get("text") or "")
            target_relevance = _assess_warmup_post_relevance(
                payload,
                target_text,
                keywords=persona_keywords,
            )
            if bool(payload.get("require_persona_relevance", True)) and not target_relevance["relevant"]:
                logger.log(
                    "debug",
                    f"{stage}_comment_skip",
                    "打开的帖子与人设不匹配，跳过留言。",
                    {"preview": target_text[:80], "keywords": target_relevance["keywords"][:5]},
                )
            else:
                reply_text = _pick_warmup_persona_reply(
                    payload,
                    target_text,
                    keywords=persona_keywords,
                    previous_replies=used_comment_texts,
                )
                if not reply_text:
                    logger.log(
                        "debug",
                        f"{stage}_comment_skip",
                        "未生成符合人设的留言，跳过当前帖子。",
                        {"preview": target_text[:80]},
                    )
                else:
                    shot_comment = ""

                    def capture_comment_before_submit() -> str:
                        nonlocal shot_comment
                        if not shot_comment:
                            shot_comment = _screenshot(
                                page,
                                screenshot_dir,
                                task,
                                f"{stage}_comment_{commented + 1}",
                                logger,
                            )
                        return shot_comment

                    if clean_platform == "threads":
                        posted = _post_threads_warmup_comment(
                            page,
                            logger,
                            reply_text,
                            target_root=target.get("root"),
                            before_submit=capture_comment_before_submit,
                        )
                    else:
                        posted = _post_instagram_warmup_comment(
                            page,
                            logger,
                            reply_text,
                            target_root=target.get("root"),
                            before_submit=capture_comment_before_submit,
                        )
                    if posted:
                        commented += 1
                        used_comment_texts.add(reply_text)
                        interacted = True
                        if target_key:
                            commented_target_keys.update(
                                key for key in (target_key, target_fingerprint) if key
                            )
                            historical_action_keys.update(commented_target_keys)
                        action_record = {
                            "action": "comment",
                            "targetKey": target_key,
                            "targetFingerprint": target_fingerprint,
                            "targetUrl": target_url,
                            "keyword": active_keyword,
                            "text": reply_text,
                            "confirmedAt": int(time.time()),
                        }
                        action_records.append(action_record)
                        _record_warmup_action_history(
                            history_path,
                            action="comment",
                            target=target,
                            text=reply_text,
                            keyword=active_keyword,
                        )
                        logger.log(
                            "info",
                            f"{stage}_interaction_record",
                            "已记录确认成功的评论目标。",
                            action_record,
                        )
                        if not shot_comment:
                            shot_comment = _screenshot(
                                page,
                                screenshot_dir,
                                task,
                                f"{stage}_comment_{commented}",
                                logger,
                            )
                        if shot_comment:
                            comment_screenshots.append(shot_comment)
                            interaction_evidence.append(("comment", commented, shot_comment))
                    else:
                        comment_backfills += 1
                        logger.log(
                            "warn",
                            f"{stage}_comment_backfill",
                            "No confirmed comment target was available; continuing.",
                            {
                                "attempts": comment_backfills,
                                "commented": commented,
                                "target": min_required_comments,
                                "has_reply_text": True,
                            },
                        )

        # Opening a detail page invalidates locators from the search/feed card.
        # Perform any scoped like/comment first, then browse that exact target.
        should_open_post = browsed > 0 and (
            random.random() < 0.12
            or (opened_posts == 0 and elapsed_ratio >= 0.3)
        )
        if (
            should_open_post
            and not interacted
            and (not target_key or target_key not in opened_target_keys)
            and _open_random_platform_post(
                page,
                logger,
                platform=clean_platform,
                cancel_event=cancel_event,
                target_root=target.get("root"),
            )
        ):
            opened_posts += 1
            if target_key:
                opened_target_keys.add(target_key)

        if interacted:
            next_interaction_at = _next_warmup_interaction_at(browsed, payload)
        _guard_warmup_risk(
            page,
            clean_platform,
            payload,
            logger,
            task=task,
            screenshot_dir=screenshot_dir,
            cancel_event=cancel_event,
            context_control=context_control,
        )
        scroll = _slow_human_scroll(page)
        browsed += 1
        remaining_seconds = max(0, int(deadline - time.monotonic()))
        logger.log(
            "debug",
            stage,
            f"Browsed {clean_platform} feed.",
            {
                "index": browsed,
                "browse_limit": browse_limit,
                "liked": liked,
                "commented": commented,
                "opened_posts": opened_posts,
                "remaining_seconds": remaining_seconds,
                **scroll,
            },
        )
        if remaining_seconds <= 0:
            break
        # Keep the declared session length authoritative.  A human-like idle
        # pause must never carry a small validation run far past its deadline.
        _wait_for_cancellation(
            min(random.uniform(20.0, 45.0), max(0.0, deadline - time.monotonic())),
            cancel_event,
        )

    if clean_platform == "instagram":
        _dismiss_instagram_interstitials(page, logger)
    _guard_warmup_risk(
        page,
        clean_platform,
        payload,
        logger,
        task=task,
        screenshot_dir=screenshot_dir,
        cancel_event=cancel_event,
        context_control=context_control,
    )
    _validate_warmup_completion(
        clean_platform,
        liked=liked,
        commented=commented,
        min_required_likes=min_required_likes,
        min_required_comments=min_required_comments,
        min_required_interactions=min_required_interactions,
    )
    evidence_sheet = _compose_warmup_evidence_sheet(
        interaction_evidence,
        screenshot_dir,
        task,
        logger,
    )
    final_evidence_screenshots = (
        [evidence_sheet]
        if evidence_sheet
        else [
            path
            for _, _, path in interaction_evidence
            if Path(path).is_file()
        ]
    )
    logger.log(
        "info",
        "completion_node",
        f"{clean_platform} warmup completion was confirmed.",
        {
            "url": str(page.url or ""),
            "liked": liked,
            "commented": commented,
            "scrolled": browsed,
            "opened_posts": opened_posts,
            "like_backfills": like_backfills,
            "comment_backfills": comment_backfills,
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "evidence_count": len(interaction_evidence),
            "unique_browsed_targets": len(unique_browsed_target_keys),
            "confirmed_action_records": len(action_records),
        },
    )
    return {
        "ok": True,
        "url": page.url,
        "liked": liked,
        "commented": commented,
        "scrolled": browsed,
        "browse_limit": browse_limit,
        "opened_posts": opened_posts,
        "target_seconds": session_seconds,
        "likeBackfills": like_backfills,
        "commentBackfills": comment_backfills,
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "likeScreenshots": [] if evidence_sheet else like_screenshots,
        "commentScreenshots": [] if evidence_sheet else comment_screenshots,
        "evidenceScreenshots": final_evidence_screenshots,
        "evidenceSheet": evidence_sheet,
        "screenshot_path": evidence_sheet,
        "uniqueBrowsedTargets": len(unique_browsed_target_keys),
        "likedTargetKeys": sorted(
            record["targetKey"]
            for record in action_records
            if record["action"] == "like" and record.get("targetKey")
        ),
        "commentedTargetKeys": sorted(
            record["targetKey"]
            for record in action_records
            if record["action"] == "comment" and record.get("targetKey")
        ),
        "interactionRecords": action_records,
        "resourceManagement": _public_warmup_resource_metrics(context_control),
    }


def _run_threads_warmup(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _run_platform_warmup(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="threads",
        cancel_event=cancel_event,
        context_control=context_control,
    )
def _threads_reply_button(page, root=None):
    scope = root if root is not None else page
    selectors = [
        '[role="button"]:has([aria-label="Reply"])',
        '[role="button"]:has([aria-label*="回复"])',
        '[role="button"]:has([aria-label*="回覆"])',
        'button:has([aria-label="Reply"])',
        '[aria-label="Reply"]',
        '[aria-label*="Reply" i]',
        '[aria-label*="回复"]',
        '[aria-label*="回覆"]',
        'button:has-text("Reply")',
    ]
    for selector in selectors:
        try:
            loc = scope.locator(selector).first
            if loc.count() and loc.is_visible(timeout=1500):
                return loc
        except Exception:
            continue
    return None


def _threads_text_box(page):
    selectors = [
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        'div[aria-label*="Reply" i]',
        'div[aria-label*="鍥炲"]',
        'div[aria-label*="鍥炶"]',
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector).last
            if loc.count() and loc.is_visible(timeout=2500):
                return loc
        except Exception:
            continue
    return None


def _pick_persona_reply(
    payload: dict[str, Any],
    target_text: str = "",
    *,
    previous_replies: Iterable[str] = (),
) -> str:
    reply_text = str(payload.get("reply_text") or "").strip()
    if reply_text:
        return reply_text[:220]
    clean_target = " ".join(str(target_text or "").split())
    if bool(payload.get("require_persona_relevance", False)) and not _target_matches_persona(
        payload,
        clean_target,
    ):
        return ""
    if not clean_target:
        return ""
    return _generate_persona_reply_with_ai(
        payload,
        clean_target,
        limit=220,
        previous_replies=previous_replies,
    )


def _persona_reply_generation_applicable(
    payload: dict[str, Any],
    target_text: str,
) -> bool:
    if str(payload.get("reply_text") or "").strip():
        return True
    clean_target = " ".join(str(target_text or "").split())
    if not clean_target:
        return False
    if bool(payload.get("require_persona_relevance", False)):
        return _target_matches_persona(payload, clean_target)
    return True


def _generate_persona_reply_with_ai(
    payload: dict[str, Any],
    target_text: str,
    *,
    limit: int,
    previous_replies: Iterable[str] = (),
) -> str:
    clean_target = " ".join(str(target_text or "").split())[:1800]
    if not clean_target:
        return ""
    try:
        import get_gemini
        from runtime_config_bootstrap import load_runtime_config

        runtime = load_runtime_config()
        host = str(runtime.get("llm_base_url") or "").strip()
        api_key = str(
            runtime.get("llm_api_key_gpt")
            or runtime.get("llm_api_key")
            or runtime.get("llm_api_key_gemini")
            or ""
        ).strip()
        model_order = str(
            runtime.get("llm_model_priority_order")
            or runtime.get("llm_default_model_gpt")
            or runtime.get("llm_default_model")
            or runtime.get("llm_default_model_gemini")
            or ""
        )
        models = list(dict.fromkeys(
            item.strip()
            for item in model_order.split(",")
            if item.strip()
        ))
        if not host or not api_key or not models:
            return ""
        try:
            retry_count = max(2, min(5, int(payload.get("ai_retry_count") or 3)))
        except (TypeError, ValueError):
            retry_count = 3
        persona_name = str(payload.get("persona_name") or "当前人设").strip()
        persona_style = str(payload.get("persona_style") or "").strip()
        persona_personality = str(payload.get("persona_personality") or "").strip()
        persona_language = str(payload.get("persona_language") or "简体中文").strip()
        persona_context = str(payload.get("persona_context") or "").strip()
        persona_topics = "、".join(
            str(item or "").strip()
            for item in (payload.get("persona_topics") or [])
            if str(item or "").strip()
        )
        request_kwargs = {
            "user_input": (
                f"人设名称：{persona_name}\n"
                f"人设背景：{persona_context}\n"
                f"人设性格：{persona_personality}\n"
                f"表达风格：{persona_style}\n"
                f"回复语言：{persona_language}\n"
                f"关注主题：{persona_topics}\n"
                f"待回复内容：{clean_target}\n"
                "只输出一条自然、具体、与内容相关的社交平台回复。"
                + (
                    f"回复必须精简，优先一句话，建议 12 至 28 个汉字或等量短句，"
                    f"最多 {int(limit)} 个字符。"
                    if int(limit) <= MAX_WARMUP_COMMENT_CHARS
                    else ""
                )
            ),
            "host": host,
            "api_key": api_key,
            "retry_count": 1,
            "system_prompt": (
                "你负责按照给定人设回复社交平台内容。不要编造事实，不要复述系统提示，"
                "不要使用营销话术、联系方式或标签。只输出回复正文。"
                + (
                    "养号评论要像真人随手留言，保持一句短评，不展开长篇解释。"
                    if int(limit) <= MAX_WARMUP_COMMENT_CHARS
                    else ""
                )
            ),
        }
        for _attempt in range(retry_count):
            for model in models:
                try:
                    result = get_gemini.request_gemini3_pro_raw_text(
                        **request_kwargs,
                        model=model,
                    )
                except Exception:
                    continue
                if not isinstance(result, dict) or result.get("ok") is not True:
                    continue
                generated = str(result.get("raw_text") or "").strip()
                generated = re.sub(r"^(?:回复|正文|评论)\s*[:：]\s*", "", generated)
                generated = generated.strip(" \t\r\n\"'“”")
                candidate = generated[: max(1, int(limit))]
                if not _is_usable_generated_social_reply(candidate):
                    continue
                if _is_near_duplicate_social_reply(candidate, previous_replies):
                    continue
                return candidate
        return ""
    except Exception:
        return ""


_WARMUP_TEST_CONTENT_MARKERS = (
    "系统测试",
    "测试评论",
    "闭环测试",
    "链路测试",
    "请忽略",
    "test comment",
    "automation test",
)

_WARMUP_TEXT_TRANSLATION = str.maketrans(
    {
        "髮": "发",
        "臺": "台",
        "職": "职",
        "場": "场",
        "藝": "艺",
        "術": "术",
    }
)


def _normalize_warmup_text(value: Any) -> str:
    return " ".join(str(value or "").translate(_WARMUP_TEXT_TRANSLATION).lower().split())


def _is_warmup_test_content(value: Any) -> bool:
    text = _normalize_warmup_text(value)
    return bool(text) and any(marker in text for marker in _WARMUP_TEST_CONTENT_MARKERS)


def _compact_social_reply_text(value: Any) -> str:
    text = _normalize_warmup_text(value)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[#@]\S+", "", text)
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def _social_reply_similarity(left: Any, right: Any) -> float:
    clean_left = _compact_social_reply_text(left)
    clean_right = _compact_social_reply_text(right)
    if not clean_left or not clean_right:
        return 0.0
    if clean_left == clean_right:
        return 1.0
    if clean_left in clean_right or clean_right in clean_left:
        return min(len(clean_left), len(clean_right)) / max(len(clean_left), len(clean_right))

    def bigrams(value: str) -> set[str]:
        if len(value) < 2:
            return {value}
        return {value[index : index + 2] for index in range(len(value) - 1)}

    left_grams = bigrams(clean_left)
    right_grams = bigrams(clean_right)
    return len(left_grams & right_grams) / max(len(left_grams), len(right_grams))


def _is_near_duplicate_social_reply(
    reply_text: Any,
    previous_replies: Iterable[str],
) -> bool:
    current = _compact_social_reply_text(reply_text)
    if not current:
        return True
    return any(
        _social_reply_similarity(current, previous) >= 0.72
        for previous in previous_replies
        if str(previous or "").strip()
    )


def _is_usable_generated_social_reply(value: Any) -> bool:
    text = " ".join(str(value or "").split()).strip()
    compact = _compact_social_reply_text(text)
    if len(compact) < 4 or len(compact) > 220:
        return False
    if _is_warmup_test_content(text):
        return False
    if re.search(r"https?://|(?:^|\s)[#@]\S+", text, flags=re.IGNORECASE):
        return False
    if re.search(
        r"(?:system prompt|assistant|作为\s*ai|作為\s*ai|系统提示|系統提示)",
        text,
        flags=re.IGNORECASE,
    ):
        return False
    if compact in {
        "不错",
        "不錯",
        "支持",
        "好看",
        "有意思",
        "认同",
        "認同",
        "学到了",
        "學到了",
        "值得看",
        "期待后续",
        "期待後續",
    }:
        return False
    for unit_length in range(3, len(compact) // 2 + 1):
        unit = compact[:unit_length]
        repeated = (unit * ((len(compact) // unit_length) + 1))[: len(compact)]
        if compact == repeated:
            return False
    return True


def _matched_warmup_persona_topic(payload: dict[str, Any], target_text: str) -> str:
    relevance = _score_warmup_post_relevance(payload, target_text)
    matched = relevance.get("matched") if isinstance(relevance.get("matched"), list) else []
    return str(matched[0] or "") if matched else ""


def _pick_warmup_persona_reply(
    payload: dict[str, Any],
    target_text: str,
    *,
    keywords: Iterable[str] = (),
    previous_replies: Iterable[str] = (),
) -> str:
    if _is_warmup_test_content(target_text):
        return ""
    require_relevance = bool(payload.get("require_persona_relevance", True))
    if require_relevance and not _assess_warmup_post_relevance(
        payload,
        target_text,
        keywords=keywords,
    )["relevant"]:
        return ""
    if not str(target_text or "").strip():
        return ""
    return _generate_persona_reply_with_ai(
        payload,
        target_text,
        limit=MAX_WARMUP_COMMENT_CHARS,
        previous_replies=previous_replies,
    )


def _canonical_warmup_post_url(value: Any, platform: str) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    absolute = urljoin(
        THREADS_HOME if str(platform or "").lower() == "threads" else INSTAGRAM_HOME,
        raw_url,
    )
    parsed = urlparse(absolute)
    path = re.sub(r"/+", "/", parsed.path or "").rstrip("/")
    clean_platform = str(platform or "").strip().lower()
    if clean_platform == "threads" and "/post/" not in path.lower():
        return ""
    if clean_platform == "instagram":
        match = re.search(r"/(?:p|reel|tv)/([^/]+)", path, flags=re.IGNORECASE)
        if not match:
            return ""
        # Instagram exposes the same media through several equivalent routes:
        # /p/<shortcode>, /reel/<shortcode>, profile-prefixed reel links, and
        # comment/deep-link suffixes.  The shortcode is the stable media
        # identity, so normalize every variant before hashing or persistence.
        path = f"/p/{match.group(1)}"
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{path}"


def _warmup_post_url_from_root(root: Any, platform: str, page_url: Any = "") -> str:
    selectors = (
        ('a[href*="/post/"]',)
        if str(platform or "").strip().lower() == "threads"
        else ('a[href*="/p/"]', 'a[href*="/reel/"]', 'a[href*="/tv/"]')
    )
    for selector in selectors:
        with contextlib.suppress(Exception):
            group = root.locator(selector)
            for index in range(min(int(group.count()), 20)):
                href = str(group.nth(index).get_attribute("href") or "")
                canonical = _canonical_warmup_post_url(href, platform)
                if canonical:
                    return canonical
    return _canonical_warmup_post_url(page_url, platform)


def _warmup_post_target(
    context: dict[str, Any] | None,
    platform: str,
    *,
    page_url: Any = "",
) -> dict[str, str]:
    source = context if isinstance(context, dict) else {}
    existing_key = str(source.get("target_key") or "").strip()
    normalized_text = " ".join(str(source.get("text") or "").lower().split())[:1600]
    fingerprint_key = (
        hashlib.sha256(
            f"{str(platform or '').strip().lower()}\ntext\n{normalized_text}".encode("utf-8"),
        ).hexdigest()
        if normalized_text
        else ""
    )
    existing_url = _canonical_warmup_post_url(
        source.get("target_url") or "",
        platform,
    )
    if existing_key:
        return {
            "target_key": existing_key,
            "target_url": existing_url,
            "target_fingerprint": str(source.get("target_fingerprint") or fingerprint_key),
        }
    root = source.get("root")
    target_url = existing_url
    if not target_url and root is not None:
        target_url = _warmup_post_url_from_root(root, platform, page_url)
    if target_url:
        identity = f"{str(platform or '').strip().lower()}\n{target_url.lower()}"
    else:
        if not normalized_text:
            return {"target_key": "", "target_url": "", "target_fingerprint": ""}
        identity = f"{str(platform or '').strip().lower()}\ntext\n{normalized_text}"
    return {
        "target_key": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
        "target_url": target_url,
        "target_fingerprint": fingerprint_key,
    }


def _decorate_warmup_post_context(
    page: Any,
    context: dict[str, Any] | None,
    platform: str,
) -> dict[str, Any]:
    decorated = dict(context or {})
    decorated.update(
        _warmup_post_target(
            decorated,
            platform,
            page_url=getattr(page, "url", ""),
        ),
    )
    return decorated


def _visible_warmup_post_contexts(page, platform: str, *, limit: int = 12) -> list[dict[str, Any]]:
    """Return visible post cards in visual order for relevance selection.

    Search pages commonly show several candidate posts at once.  Selecting only
    the center card can miss a relevant recent result that is already visible,
    then incorrectly exhaust the search and stop the warmup.
    """
    platform_name = str(platform or "").strip().lower()
    selectors = ("article",) if platform_name == "instagram" else ("article", "[data-pressable-container='true']")
    viewport_height = 800.0
    with contextlib.suppress(Exception):
        viewport_height = float(page.evaluate("() => Math.max(1, window.innerHeight)") or viewport_height)
    candidates: list[tuple[float, Any, str]] = []
    for selector in selectors:
        with contextlib.suppress(Exception):
            group = page.locator(selector)
            count = min(int(group.count()), 40)
            if selector == "article" and count:
                selectors = (selector,)
            for index in range(count):
                root = group.nth(index)
                if not root.is_visible(timeout=500):
                    continue
                box = root.bounding_box(timeout=1000)
                text = str(root.inner_text(timeout=1500) or "").strip()
                if not box or len(text) < 8 or len(text) > 4000:
                    continue
                top = float(box.get("y") or 0)
                height = float(box.get("height") or 0)
                width = float(box.get("width") or 0)
                if width <= 180 or height <= 80 or top + height <= 80 or top >= viewport_height - 40:
                    continue
                # Top-to-bottom is the platform's result/feed order; evaluating
                # all visible cards lets us choose the first relevant candidate.
                candidates.append((top, root, text[:1600]))
        if candidates and selector == "article":
            break
    if not candidates:
        return []
    return [
        _decorate_warmup_post_context(
            page,
            {"text": text, "root": root, "viewport_top": top},
            platform_name,
        )
        for top, root, text in sorted(candidates, key=lambda item: item[0])[:max(1, int(limit))]
    ]


def _current_warmup_post_context(page, platform: str) -> dict[str, Any]:
    contexts = _visible_warmup_post_contexts(page, platform, limit=1)
    return contexts[0] if contexts else {"text": "", "root": None}


def _current_warmup_post_text(page, platform: str) -> str:
    return str(_current_warmup_post_context(page, platform).get("text") or "")


_THREADS_COMMENT_BLOCKLIST = (
    "加微信",
    "加v",
    "vx",
    "whatsapp",
    "telegram",
    "点击链接",
    "私信领取",
    "免费领取",
    "赚钱教程",
    "代购",
    "推广",
    "傻逼",
    "垃圾骗子",
    "操你",
    "去死",
)

_THREADS_COMMON_TOKENS = {
    "这个",
    "那个",
    "今天",
    "真的",
    "一个",
    "怎么",
    "什么",
    "还是",
    "觉得",
    "分享",
    "可以",
    "就是",
    "非常",
}


def _threads_semantic_tokens(value: Any) -> set[str]:
    text = " ".join(str(value or "").lower().split())
    tokens = {
        token
        for token in re.findall(r"[a-z0-9_]{3,}", text)
        if token not in _THREADS_COMMON_TOKENS
    }
    for segment in re.findall(r"[\u3400-\u9fff]{2,}", text):
        for index in range(len(segment) - 1):
            token = segment[index:index + 2]
            if token not in _THREADS_COMMON_TOKENS:
                tokens.add(token)
    return tokens


def _target_matches_persona(payload: dict[str, Any], target_text: Any) -> bool:
    clean_target = " ".join(str(target_text or "").split())
    if not clean_target:
        return False
    if _matched_warmup_persona_topic(payload, clean_target):
        return True
    topics = payload.get("persona_topics") if isinstance(payload.get("persona_topics"), list) else []
    persona_reference = " ".join(
        (
            str(payload.get("persona_context") or ""),
            str(payload.get("persona_style") or ""),
            " ".join(str(item or "") for item in topics),
        )
    )
    return bool(
        _threads_semantic_tokens(clean_target)
        & _threads_semantic_tokens(persona_reference)
    )


def _is_replyable_social_comment(
    text: Any,
    author: Any,
    payload: dict[str, Any],
    post_text: str,
) -> bool:
    clean_text = " ".join(str(text or "").split())
    if len(clean_text) < 4 or len(clean_text) > 1200:
        return False
    semantic_chars = re.findall(r"[A-Za-z0-9\u3400-\u9fff]", clean_text)
    if len(semantic_chars) < 3:
        return False
    lowered = clean_text.lower()
    if "http://" in lowered or "https://" in lowered or any(marker in lowered for marker in _THREADS_COMMENT_BLOCKLIST):
        return False
    clean_author = str(author or "").strip().lower().lstrip("@")
    own_handle = str(
        payload.get("account_handle")
        or payload.get("threads_handle")
        or payload.get("instagram_handle")
        or ""
    ).strip().lower().lstrip("@")
    if clean_author and own_handle and clean_author == own_handle:
        return False
    if not bool(payload.get("require_persona_relevance", True)):
        return True
    return _target_matches_persona(
        payload,
        f"{post_text}\n{clean_text}",
    )


def _threads_comment_candidates(page) -> list[dict[str, Any]]:
    script = """
    () => {
      const articleCount = document.querySelectorAll("article").length;
      const selector = articleCount > 1 ? "article" : "[data-pressable-container='true']";
      const nodes = Array.from(document.querySelectorAll(selector));
      return nodes.slice(1).map((node, offset) => {
        const text = String(node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim();
        const authorLink = node.querySelector('a[href^="/@"]');
        const href = String(authorLink?.getAttribute("href") || "");
        const authorMatch = href.match(/^\\/@([^/?#]+)/);
        const hasReply = Array.from(node.querySelectorAll('button, [role="button"], [aria-label]')).some((button) => {
          const label = String(button.getAttribute("aria-label") || button.textContent || "").trim().toLowerCase();
          return label === "reply" || label.includes("回复") || label.includes("回覆");
        });
        return {
          root_selector: selector,
          dom_index: offset + 1,
          text: text.slice(0, 1200),
          author: authorMatch ? authorMatch[1] : "",
          has_reply: hasReply,
        };
      }).filter((item) => item.text && item.has_reply);
    }
    """
    try:
        rows = page.evaluate(script)
    except Exception:
        return []
    return [dict(item) for item in rows if isinstance(item, dict)]


def _threads_comment_reply_button(page, candidate: dict[str, Any]):
    selector = str(candidate.get("root_selector") or "").strip()
    try:
        index = int(candidate.get("dom_index"))
    except (TypeError, ValueError):
        return None
    if not selector or index < 0:
        return None
    expected_text = " ".join(str(candidate.get("text") or "").split())
    expected_author = str(candidate.get("author") or "").strip().lower()
    roots = []
    with contextlib.suppress(Exception):
        group = page.locator(selector)
        if 0 <= index < int(group.count()):
            roots.append(group.nth(index))
        roots.extend(group.nth(item_index) for item_index in range(min(int(group.count()), 80)))
    root = None
    seen_indexes: set[int] = set()
    for candidate_root in roots:
        identity = id(candidate_root)
        if identity in seen_indexes:
            continue
        seen_indexes.add(identity)
        try:
            current_text = " ".join(str(candidate_root.inner_text(timeout=1200) or "").split())
            if expected_text and not (
                expected_text[:240] in current_text
                or current_text[:240] in expected_text
            ):
                continue
            if expected_author:
                href = str(
                    candidate_root.locator('a[href^="/@"]').first.get_attribute("href", timeout=1000)
                    or ""
                )
                match = re.match(r"^/@([^/?#]+)", href)
                if not match or match.group(1).strip().lower() != expected_author:
                    continue
            root = candidate_root
            break
        except Exception:
            continue
    if root is None:
        return None
    for button_selector in (
        '[aria-label="Reply"]',
        '[aria-label*="Reply" i]',
        '[aria-label*="回复"]',
        '[aria-label*="回覆"]',
        'button:has-text("Reply")',
        '[role="button"]:has-text("回复")',
        '[role="button"]:has-text("回覆")',
    ):
        try:
            button = root.locator(button_selector).first
            if button.count() and button.is_visible(timeout=1200):
                return button
        except Exception:
            continue
    return None


def _threads_primary_post_context(page) -> dict[str, Any]:
    for selector in ("article", "[data-pressable-container='true']"):
        with contextlib.suppress(Exception):
            group = page.locator(selector)
            for index in range(min(int(group.count()), 12)):
                root = group.nth(index)
                if root.is_visible(timeout=1200):
                    text = str(root.inner_text(timeout=2000) or "").strip()[:1600]
                    if text:
                        return {"text": text, "root": root}
    return {"text": "", "root": None}


def _threads_post_text(page) -> str:
    return str(_threads_primary_post_context(page).get("text") or "")


def _threads_published_reply_count(page, text: str) -> int:
    clean_text = " ".join(str(text or "").split())
    if not clean_text:
        return 0
    script = """
    target => {
      const normalize = value => String(value || "").replace(/\\s+/g, " ").trim();
      const articles = Array.from(document.querySelectorAll("article"));
      const selector = articles.length > 1 ? "article" : "[data-pressable-container='true']";
      return Array.from(document.querySelectorAll(selector)).filter(root => {
        if (root.closest("textarea, [contenteditable='true'], [role='textbox']")) return false;
        if (root.querySelector("textarea, [contenteditable='true'], [role='textbox']")) return false;
        const rect = root.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const lines = String(root.innerText || root.textContent || "")
          .split(/\\n+/)
          .map(normalize)
          .filter(Boolean);
        return lines.includes(target);
      }).length;
    }
    """
    with contextlib.suppress(Exception):
        return int(page.evaluate(script, clean_text) or 0)
    return 0


def _threads_exact_text_count(page, text: str) -> int:
    return _threads_published_reply_count(page, text)


def _wait_for_threads_reply_echo(page, text: str, previous_count: int, timeout_seconds: float = 12.0) -> bool:
    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    while time.monotonic() < deadline:
        with contextlib.suppress(Exception):
            if _threads_published_reply_count(page, text) > int(previous_count):
                return True
        time.sleep(0.5)
    return False


def _click_threads_reply_submit(
    page,
    box,
    logger: AutomationLogger,
    stage: str,
) -> bool:
    labels = ("Post", "Reply", "\u53d1\u5e03", "\u56de\u8986", "\u56de\u590d")
    scopes = []
    for xpath in (
        "xpath=ancestor::*[@role='dialog'][1]",
        "xpath=ancestor::form[1]",
        (
            "xpath=ancestor::*[.//*[self::button or @role='button']"
            "[normalize-space()='Post' or normalize-space()='Reply' or "
            "normalize-space()='发布' or normalize-space()='回覆' or normalize-space()='回复']][1]"
        ),
    ):
        with contextlib.suppress(Exception):
            scope = box.locator(xpath)
            if scope.count():
                scopes.append(scope)
    for scope in scopes:
        for label in labels:
            locators = (
                scope.get_by_role("button", name=label).last,
                scope.locator(f'button:has-text("{label}")').last,
                scope.locator(f'[role="button"]:has-text("{label}")').last,
                scope.locator(f'[aria-label="{label}"]').last,
            )
            for locator in locators:
                with contextlib.suppress(Exception):
                    if locator.count() and locator.is_visible(timeout=1200):
                        return bool(_human_click(page, locator, logger, stage))
    logger.log(
        "warn",
        f"{stage}_missing",
        "未在当前回复编辑器内找到提交按钮，本次不执行页面级兜底点击。",
    )
    return False


def _submit_threads_reply(
    page,
    button,
    reply_text: str,
    logger: AutomationLogger,
    stage_prefix: str,
) -> bool:
    previous_count = _threads_published_reply_count(page, reply_text)
    _human_click(page, button, logger, f"{stage_prefix}_button")
    _sleep_between(1.0, 2.5)
    box = _threads_text_box(page)
    if box is None:
        return False
    _human_click(page, box, logger, f"{stage_prefix}_focus")
    _human_type(page, reply_text, min_delay=0.10, max_delay=0.22)
    if not _click_threads_reply_submit(page, box, logger, f"{stage_prefix}_submit"):
        return False
    if _wait_for_threads_reply_echo(page, reply_text, previous_count):
        return True
    logger.log(
        "warn",
        f"{stage_prefix}_unconfirmed",
        "Threads 回复提交后未检测到内容回显，本次不计入成功数。",
        {"text": reply_text[:80]},
    )
    return False


def _target_summary_by_url(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    rows = payload.get("target_summaries") if isinstance(payload.get("target_summaries"), list) else []
    for item in rows:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").split("?", 1)[0].rstrip("/")
        if url:
            result[url] = item
    return result


def _social_comment_target_key(
    platform: str,
    post_url: Any,
    author: Any,
    comment_text: Any,
) -> str:
    clean_platform = str(platform or "").strip().lower()
    clean_url = str(post_url or "").split("?", 1)[0].rstrip("/").lower()
    clean_author = str(author or "").strip().lower().lstrip("@")
    clean_comment = " ".join(str(comment_text or "").split()).lower()
    identity = "\n".join(
        (clean_platform, clean_url, clean_author, clean_comment),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _social_comment_identity_key(
    platform: str,
    author: Any,
    comment_text: Any,
) -> str:
    clean_platform = str(platform or "").strip().lower()
    clean_author = str(author or "").strip().lower().lstrip("@")
    clean_comment = " ".join(str(comment_text or "").split()).lower()
    identity = "\n".join((clean_platform, clean_author, clean_comment))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _social_comment_text_key(platform: str, comment_text: Any) -> str:
    clean_platform = str(platform or "").strip().lower()
    clean_comment = " ".join(str(comment_text or "").split()).lower()
    identity = "\n".join((clean_platform, clean_comment))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _discover_owned_post_targets(
    page,
    platform: str,
    account: dict[str, Any] | None,
    payload: dict[str, Any],
    logger: AutomationLogger,
    *,
    limit: int,
    cancel_event: Any | None = None,
) -> list[str]:
    _raise_if_cancelled(cancel_event)
    clean_platform = str(platform or "").strip().lower()
    if clean_platform == "threads":
        profile_url = _threads_profile_url(account)
        normalize_post = _normalize_threads_post_permalink
        find_posts = _find_threads_post_permalinks
        owns_post = lambda url: _threads_permalink_belongs_to_profile(url, profile_url)
    elif clean_platform == "instagram":
        profile_url = _instagram_profile_url(account)
        normalize_post = _normalize_instagram_post_permalink
        find_posts = _find_instagram_post_permalinks
        owns_post = lambda _url: True
    else:
        return []
    if not profile_url:
        return []

    _goto(page, profile_url, logger, f"{clean_platform}_owned_posts")
    _wait_for_cancellation(random.uniform(1.0, 2.0), cancel_event)
    discovered = [
        normalized
        for value in (find_posts(page) or [])
        if (normalized := normalize_post(value)) and owns_post(normalized)
    ]
    requested_values = payload.get("target_urls")
    if not isinstance(requested_values, list):
        requested_values = []
    requested = {
        normalized
        for value in requested_values
        if (normalized := normalize_post(value))
    }
    selected: list[str] = []
    for url in discovered:
        if requested and url not in requested:
            continue
        if url not in selected:
            selected.append(url)
        if len(selected) >= max(1, limit):
            break
    logger.log(
        "info",
        f"{clean_platform}_owned_posts",
        f"已从 {_platform_name(clean_platform)} 绑定账号主页确认自有帖子目标。",
        {
            "profile_url": profile_url,
            "discovered": len(discovered),
            "selected": len(selected),
        },
    )
    return selected


def _instagram_primary_post_context(page) -> dict[str, Any]:
    with contextlib.suppress(Exception):
        articles = page.locator("article")
        for index in range(min(int(articles.count()), 12)):
            root = articles.nth(index)
            if not root.is_visible(timeout=1200):
                continue
            text = str(root.inner_text(timeout=2000) or "").strip()[:1600]
            if text:
                return {"text": text, "root": root}
    return {"text": "", "root": None}


def _instagram_comment_candidates(page) -> list[dict[str, Any]]:
    script = """
    () => {
      document.querySelectorAll("[data-vecto-comment-candidate]").forEach((node) => {
        node.removeAttribute("data-vecto-comment-candidate");
      });
      const controls = Array.from(document.querySelectorAll("button, [role='button']"));
      const rows = [];
      for (const control of controls) {
        const label = String(
          control.innerText || control.textContent || control.getAttribute("aria-label") || ""
        ).replace(/\\s+/g, " ").trim().toLowerCase();
        if (!(label === "reply" || label.includes("回复") || label.includes("回覆"))) continue;
        const root = control.closest("li, article") || control.parentElement;
        if (!root || root.hasAttribute("data-vecto-comment-candidate")) continue;
        const text = String(root.innerText || root.textContent || "").replace(/\\s+/g, " ").trim();
        if (!text) continue;
        const authorLink = root.querySelector('a[href^="/"]');
        const authorPath = String(authorLink?.getAttribute("href") || "");
        const authorMatch = authorPath.match(/^\\/([A-Za-z0-9._]+)\\/?$/);
        const key = String(rows.length);
        root.setAttribute("data-vecto-comment-candidate", key);
        rows.push({
          candidate_key: key,
          text: text.slice(0, 1200),
          author: authorMatch ? authorMatch[1] : "",
        });
      }
      return rows;
    }
    """
    with contextlib.suppress(Exception):
        rows = page.evaluate(script)
        return [dict(item) for item in rows if isinstance(item, dict)]
    return []


def _instagram_comment_reply_button(page, candidate: dict[str, Any]):
    candidate_key = str(candidate.get("candidate_key") or "").strip()
    if not candidate_key:
        return None
    with contextlib.suppress(Exception):
        root = page.locator(
            f'[data-vecto-comment-candidate="{candidate_key}"]'
        ).first
        if not root.count():
            return None
        for selector in (
            'button:has-text("Reply")',
            '[role="button"]:has-text("Reply")',
            '[aria-label*="Reply" i]',
            'button:has-text("回复")',
            '[role="button"]:has-text("回复")',
            'button:has-text("回覆")',
        ):
            button = root.locator(selector).first
            if button.count() and button.is_visible(timeout=1200):
                return button
    return None


def _submit_instagram_comment_reply(
    page,
    button,
    reply_text: str,
    logger: AutomationLogger,
    stage_prefix: str,
) -> bool:
    clean_text = str(reply_text or "").strip()
    if not clean_text:
        return False
    previous_count = _instagram_exact_text_count(page, clean_text)
    if not _human_click(page, button, logger, f"{stage_prefix}_button"):
        return False
    _sleep_between(0.6, 1.2)
    box = _instagram_warmup_comment_box(page)
    if box is None:
        return False
    _human_click(page, box, logger, f"{stage_prefix}_focus")
    _human_type(page, clean_text, min_delay=0.08, max_delay=0.18)
    if not _click_text_button(
        page,
        logger,
        ["Post", "发布"],
        f"{stage_prefix}_submit",
    ):
        return False
    return _wait_for_instagram_comment_echo(page, clean_text, previous_count)


def _platform_primary_post_context(page, platform: str) -> dict[str, Any]:
    if platform == "instagram":
        return _instagram_primary_post_context(page)
    return _threads_primary_post_context(page)


def _platform_post_text(page, platform: str) -> str:
    return str(_platform_primary_post_context(page, platform).get("text") or "")


def _platform_comment_candidates(page, platform: str) -> list[dict[str, Any]]:
    if platform == "instagram":
        return _instagram_comment_candidates(page)
    return _threads_comment_candidates(page)


def _platform_comment_reply_button(
    page,
    platform: str,
    candidate: dict[str, Any],
):
    if platform == "instagram":
        return _instagram_comment_reply_button(page, candidate)
    return _threads_comment_reply_button(page, candidate)


def _platform_primary_reply_target(
    page,
    platform: str,
    primary_post: dict[str, Any],
):
    if platform == "instagram":
        return primary_post.get("root")
    return _threads_reply_button(page, root=primary_post.get("root"))


def _submit_platform_reply(
    page,
    platform: str,
    target,
    reply_text: str,
    logger: AutomationLogger,
    stage_prefix: str,
    *,
    comment_reply: bool,
) -> bool:
    if platform == "instagram":
        if comment_reply:
            return _submit_instagram_comment_reply(
                page,
                target,
                reply_text,
                logger,
                stage_prefix,
            )
        return _post_instagram_warmup_comment(
            page,
            logger,
            reply_text,
            target_root=target,
        )
    return _submit_threads_reply(
        page,
        target,
        reply_text,
        logger,
        stage_prefix,
    )


def _run_platform_hot_post_auto_reply(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _raise_if_cancelled(cancel_event)
    max_posts = max(1, min(int(payload.get("max_posts") or 5), 20))
    max_replies = max(1, min(int(payload.get("max_replies") or 3), 10))
    strategy_id = str(payload.get("strategy_id") or "hot_posts")
    strategy_label = str(payload.get("strategy_label") or "\u81ea\u52a8\u56de\u590d\u70ed\u70b9\u63a8\u6587")
    raw_targets = payload.get("target_urls") or []
    if not isinstance(raw_targets, list):
        raw_targets = []
    target_urls = [str(item or "").strip() for item in raw_targets if str(item or "").strip()]
    platform_name = _platform_name(platform)
    logger.log("info", f"{platform}_hot_post_auto_reply", f"开始执行 {platform_name} 热点帖子自动回复。", {
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "target_count": len(target_urls),
        "max_posts": max_posts,
        "max_replies": max_replies,
        "persona_name": payload.get("persona_name") or "",
    })
    if not target_urls:
        shot = _screenshot(page, screenshot_dir, task, f"{platform}_auto_reply_done", logger)
        logger.log("warn", "completion_node", f"没有可用的 {platform_name} 热点帖子目标。", {
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
        }, shot)
        return {
            "ok": True,
            "noTarget": True,
            "url": str(page.url or (INSTAGRAM_HOME if platform == "instagram" else THREADS_HOME)),
            "scannedPosts": 0,
            "scannedComments": 0,
            "replied": 0,
            "skipped": 0,
            "replyBackfills": 0,
            "completionReason": "no_hot_post_targets",
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "replyScreenshots": [],
            "repliedUrls": [],
            "repliedComments": [],
            "screenshot_path": shot,
        }

    replied = 0
    scanned = 0
    attempted_submissions = 0
    reply_candidates = 0
    operational_failures = 0
    reply_backfills = 0
    reply_screenshots: list[str] = []
    replied_urls: list[str] = []
    replied_comments: list[dict[str, Any]] = []
    used_reply_texts: set[str] = set()
    summaries = _target_summary_by_url(payload)
    completion_reason = "max_posts_scanned"
    for url in target_urls[:max_posts]:
        _raise_if_cancelled(cancel_event)
        scanned += 1
        _goto(page, url, logger, f"{platform}_hot_post_open")
        _sleep_between(1.5, 3.0)
        summary = summaries.get(url.split("?", 1)[0].rstrip("/"), {})
        primary_post = _platform_primary_post_context(page, platform)
        post_text = str(
            summary.get("expected_text")
            or summary.get("expectedText")
            or summary.get("label")
            or primary_post.get("text")
            or ""
        ).strip()
        button = _platform_primary_reply_target(page, platform, primary_post)
        generation_applicable = _persona_reply_generation_applicable(payload, post_text)
        reply_text = _pick_persona_reply(
            payload,
            post_text,
            previous_replies=used_reply_texts,
        )
        if not str(reply_text or "").strip():
            reply_backfills += 1
            if generation_applicable:
                reply_candidates += 1
                operational_failures += 1
                completion_reason = "reply_generation_failed"
                logger.log("error", f"{platform}_reply_generation_failed", "模型多次重试后仍未生成可用回复，本目标已跳过。", {"url": url})
            else:
                completion_reason = "no_persona_relevant_reply"
                logger.log("warn", f"{platform}_hot_post_reply_skip", "没有可用的人设相关回复候选内容。", {"url": url})
            continue
        reply_candidates += 1
        if button is None:
            reply_backfills += 1
            operational_failures += 1
            completion_reason = "reply_target_missing"
            logger.log("warn", f"{platform}_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "url": url})
            continue
        attempted_submissions += 1
        posted = _run_billing_commit_action(
            context_control,
            cancel_event,
            lambda: _submit_platform_reply(
                page,
                platform,
                button,
                reply_text,
                logger,
                f"{platform}_hot_post_reply",
                comment_reply=False,
            ),
        )
        if posted:
            replied += 1
            used_reply_texts.add(reply_text)
            replied_urls.append(url)
            replied_comments.append({
                "url": url,
                "replyText": reply_text,
                "scope": "hot_posts",
            })
            _sleep_between(2.0, 4.0)
            shot = _screenshot(page, screenshot_dir, task, f"{platform}_reply_{replied}", logger)
            if shot:
                reply_screenshots.append(shot)
            logger.log("info", f"{platform}_hot_post_auto_reply", f"已回复 {platform_name} 热点帖子。", {"reply_index": replied, "url": url, "text": reply_text[:80]})
            if replied >= max_replies:
                completion_reason = "target_replies_reached"
                break
        else:
            reply_backfills += 1
            operational_failures += 1
            completion_reason = "reply_submission_unconfirmed"
            logger.log("warn", f"{platform}_auto_reply_backfill", "回复补量失败，正在切换目标。", {"attempts": reply_backfills, "url": url})
    shot = _screenshot(page, screenshot_dir, task, f"{platform}_auto_reply_done", logger)
    ok = replied > 0 or (reply_candidates == 0 and operational_failures == 0)
    logger.log(
        "info" if ok else "error",
        "completion_node",
        f"{platform_name} 热点帖子自动回复完成节点已确认。",
        {"url": str(page.url or ""), "scannedPosts": scanned, "replied": replied, "reply_backfills": reply_backfills, "completionReason": completion_reason, "strategy_id": strategy_id, "strategy_label": strategy_label},
        shot,
    )
    return {
        "ok": ok,
        "noTarget": reply_candidates == 0,
        "url": page.url,
        "scannedPosts": scanned,
        "scannedComments": 0,
        "replied": replied,
        "skipped": max(0, scanned - replied),
        "replyBackfills": reply_backfills,
        "completionReason": completion_reason,
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "replyScreenshots": reply_screenshots,
        "repliedUrls": replied_urls,
        "repliedComments": replied_comments,
        "screenshot_path": shot,
    }


def _run_threads_hot_post_auto_reply(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    return _run_platform_hot_post_auto_reply(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="threads",
        cancel_event=cancel_event,
    )


def _run_platform_auto_reply(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str,
    cancel_event: Any | None = None,
    account: dict[str, Any] | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _raise_if_cancelled(cancel_event)
    if str(payload.get("reply_scope") or "comments") == "hot_posts":
        return _run_platform_hot_post_auto_reply(
            page,
            task,
            payload,
            screenshot_dir,
            logger,
            platform=platform,
            cancel_event=cancel_event,
            context_control=context_control,
        )
    max_posts = max(1, min(int(payload.get("max_posts") or 5), 20))
    max_replies = max(1, min(int(payload.get("max_replies") or 3), 10))
    strategy_id = str(payload.get("strategy_id") or "tg_default")
    strategy_label = str(payload.get("strategy_label") or "\u81ea\u52a8\u56de\u590d\u8bc4\u8bba\uff1a\u6700\u8fd1 2 \u5929")
    require_persona_relevance = bool(payload.get("require_persona_relevance", True))
    raw_targets = payload.get("target_urls")
    targets_were_provided = isinstance(raw_targets, list)
    if not targets_were_provided:
        raw_targets = []
    target_urls = [str(item or "").strip() for item in raw_targets if str(item or "").strip()]
    if account is not None and (not targets_were_provided or target_urls):
        target_urls = _discover_owned_post_targets(
            page,
            platform,
            account,
            payload,
            logger,
            limit=max_posts,
            cancel_event=cancel_event,
        )
    replied = 0
    scanned_posts = 0
    scanned_comments = 0
    skipped = 0
    attempted_submissions = 0
    replyable_candidates = 0
    operational_failures = 0
    reply_backfills = 0
    reply_screenshots: list[str] = []
    replied_urls: list[str] = []
    replied_comments: list[dict[str, Any]] = []
    used_reply_texts: set[str] = set()
    replied_comment_keys = {
        str(item or "").strip()
        for item in (
            payload.get("replied_comment_keys")
            if isinstance(payload.get("replied_comment_keys"), list)
            else []
        )
        if str(item or "").strip()
    }
    replied_comment_history = (
        payload.get("replied_comment_history")
        if isinstance(payload.get("replied_comment_history"), list)
        else []
    )
    replied_comment_identity_keys = {
        _social_comment_identity_key(
            platform,
            item.get("author"),
            item.get("comment"),
        )
        for item in replied_comment_history
        if isinstance(item, dict) and str(item.get("comment") or "").strip()
    }
    replied_comment_text_keys = {
        _social_comment_text_key(platform, item.get("comment"))
        for item in replied_comment_history
        if isinstance(item, dict) and str(item.get("comment") or "").strip()
    }
    summaries = _target_summary_by_url(payload)
    logger.log("info", f"{platform}_auto_reply", f"开始执行人设驱动的 {_platform_name(platform)} 自动回复。", {
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "max_posts": max_posts,
        "max_replies": max_replies,
        "require_persona_relevance": require_persona_relevance,
        "persona_name": payload.get("persona_name") or "",
        "account_handle": payload.get(f"{platform}_handle") or "",
        "target_count": len(target_urls),
    })
    completion_reason = "max_posts_scanned"
    if not target_urls:
        shot = _screenshot(page, screenshot_dir, task, f"{platform}_auto_reply_done", logger)
        return {
            "ok": True,
            "noTarget": True,
            "url": str(page.url or (INSTAGRAM_HOME if platform == "instagram" else THREADS_HOME)),
            "scannedPosts": 0,
            "scannedComments": 0,
            "replied": 0,
            "skipped": 0,
            "replyBackfills": 0,
            "completionReason": "no_owned_post_targets",
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "replyScreenshots": [],
            "repliedUrls": [],
            "repliedComments": [],
            "screenshot_path": shot,
        }
    if target_urls:
        for url in target_urls[:max_posts]:
            _raise_if_cancelled(cancel_event)
            scanned_posts += 1
            _goto(page, url, logger, f"{platform}_comment_reply_open")
            _sleep_between(1.5, 3.0)
            summary = summaries.get(url.split("?", 1)[0].rstrip("/"), {})
            post_text = str(
                summary.get("expected_text")
                or summary.get("expectedText")
                or summary.get("label")
                or _platform_post_text(page, platform)
                or ""
            ).strip()
            candidates = _platform_comment_candidates(page, platform)
            scanned_comments += len(candidates)
            for candidate in candidates:
                _raise_if_cancelled(cancel_event)
                comment_text = str(candidate.get("text") or "").strip()
                author = str(candidate.get("author") or "").strip()
                target_key = _social_comment_target_key(
                    platform,
                    url,
                    author,
                    comment_text,
                )
                identity_key = _social_comment_identity_key(
                    platform,
                    author,
                    comment_text,
                )
                text_key = _social_comment_text_key(platform, comment_text)
                if (
                    target_key in replied_comment_keys
                    or identity_key in replied_comment_identity_keys
                    or text_key in replied_comment_text_keys
                ):
                    skipped += 1
                    continue
                if not _is_replyable_social_comment(comment_text, author, payload, post_text):
                    skipped += 1
                    continue
                reply_text = _pick_persona_reply(
                    payload,
                    f"{post_text}\n评论：{comment_text}",
                    previous_replies=used_reply_texts,
                )
                if require_persona_relevance and not str(reply_text or "").strip():
                    skipped += 1
                    target_text = f"{post_text}\n评论：{comment_text}"
                    if _persona_reply_generation_applicable(payload, target_text):
                        replyable_candidates += 1
                        operational_failures += 1
                        completion_reason = "reply_generation_failed"
                        logger.log("error", f"{platform}_reply_generation_failed", "模型多次重试后仍未生成可用回复，本评论已跳过。", {"url": url, "author": author})
                    continue
                if not str(reply_text or "").strip():
                    skipped += 1
                    target_text = f"{post_text}\n评论：{comment_text}"
                    if _persona_reply_generation_applicable(payload, target_text):
                        replyable_candidates += 1
                        operational_failures += 1
                        completion_reason = "reply_generation_failed"
                        logger.log("error", f"{platform}_reply_generation_failed", "模型多次重试后仍未生成可用回复，本评论已跳过。", {"url": url, "author": author})
                    continue
                replyable_candidates += 1
                button = _platform_comment_reply_button(
                    page,
                    platform,
                    candidate,
                )
                if button is None:
                    reply_backfills += 1
                    operational_failures += 1
                    completion_reason = "reply_target_missing"
                    continue
                attempted_submissions += 1
                posted = _run_billing_commit_action(
                    context_control,
                    cancel_event,
                    lambda: _submit_platform_reply(
                        page,
                        platform,
                        button,
                        reply_text,
                        logger,
                        f"{platform}_comment_reply",
                        comment_reply=True,
                    ),
                )
                if not posted:
                    reply_backfills += 1
                    operational_failures += 1
                    completion_reason = "reply_submission_unconfirmed"
                    continue
                replied += 1
                used_reply_texts.add(reply_text)
                if url not in replied_urls:
                    replied_urls.append(url)
                replied_comments.append({
                    "url": url,
                    "author": author,
                    "comment": comment_text,
                    "replyText": reply_text,
                    "scope": "comments",
                    "targetKey": target_key,
                })
                replied_comment_keys.add(target_key)
                replied_comment_identity_keys.add(identity_key)
                replied_comment_text_keys.add(text_key)
                _sleep_between(2.0, 4.0)
                shot = _screenshot(page, screenshot_dir, task, f"{platform}_reply_{replied}", logger)
                if shot:
                    reply_screenshots.append(shot)
                logger.log("info", f"{platform}_auto_reply", "已使用人设文案完成回复。", {"reply_index": replied, "url": url, "text": reply_text[:80]})
                if replied >= max_replies:
                    completion_reason = "target_replies_reached"
                    break
            if replied >= max_replies:
                break
        if scanned_comments == 0:
            completion_reason = "no_comment_targets"
        elif replyable_candidates == 0 and attempted_submissions == 0 and replied == 0:
            completion_reason = "no_replyable_comments"
        shot = _screenshot(page, screenshot_dir, task, f"{platform}_auto_reply_done", logger)
        ok = replied > 0 or (replyable_candidates == 0 and operational_failures == 0)
        logger.log(
            "info" if ok else "error",
            "completion_node",
            f"{_platform_name(platform)} 自有帖子评论自动回复执行结束。",
            {"url": str(page.url or ""), "scannedPosts": scanned_posts, "scannedComments": scanned_comments, "replied": replied, "reply_backfills": reply_backfills, "completionReason": completion_reason, "strategy_id": strategy_id, "strategy_label": strategy_label, "target_count": len(target_urls)},
            shot,
        )
        return {
            "ok": ok,
            "noTarget": replyable_candidates == 0,
            "url": page.url,
            "scannedPosts": scanned_posts,
            "scannedComments": scanned_comments,
            "replied": replied,
            "skipped": skipped,
            "replyBackfills": reply_backfills,
            "completionReason": completion_reason,
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "replyScreenshots": reply_screenshots,
            "repliedUrls": replied_urls,
            "repliedComments": replied_comments,
            "screenshot_path": shot,
        }


def _run_threads_auto_reply(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    account: dict[str, Any] | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _run_platform_auto_reply(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="threads",
        cancel_event=cancel_event,
        account=account,
        context_control=context_control,
    )


def _run_instagram_auto_reply(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    account: dict[str, Any] | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _run_platform_auto_reply(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="instagram",
        cancel_event=cancel_event,
        account=account,
        context_control=context_control,
    )


def _run_browse_profile(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str = "instagram",
) -> dict[str, Any]:
    target_url = str(payload.get("target_url") or "").strip()
    username = _collection_username(payload.get("username"))
    if not target_url and username:
        target_url = (
            f"https://www.threads.net/@{quote(username, safe='._')}"
            if platform == "threads"
            else f"{INSTAGRAM_HOME}{quote(username, safe='._')}/"
        )
    if not target_url:
        raise ValueError("浏览主页任务需要 target_url 或 username。")
    _goto(page, target_url, logger, "browse_profile")
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    limit = max(1, min(int(payload.get("limit") or 50), 200))
    collection = _extract_visible_collection_items(
        page,
        platform=platform,
        surface="profile",
        limit=limit,
    )
    shot = _screenshot(page, screenshot_dir, task, "browse_profile", logger)
    return {
        "ok": True,
        "url": _safe_navigation_url(page.url),
        "platform": platform,
        "screenshot_path": shot,
        **collection,
    }


def _relationship_username(value: Any) -> str:
    username = str(value or "").strip().lstrip("@").lower()
    if not username or len(username) > 80:
        return ""
    if any(character not in "abcdefghijklmnopqrstuvwxyz0123456789._" for character in username):
        return ""
    return username


def _inspect_instagram_relationship_page(page) -> dict[str, Any]:
    """Read explicit follow markers without inferring from an incomplete page."""

    inspected = page.evaluate(
        r"""
        () => {
          const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const bodyText = compact(document.body && document.body.innerText);
          const controls = [...document.querySelectorAll('button, [role="button"]')]
            .map((node) => compact(node.textContent || node.getAttribute('aria-label') || ''))
            .filter(Boolean)
            .slice(0, 500);
          const exact = (patterns) => controls.find((text) => patterns.some((pattern) => pattern.test(text))) || '';
          const followingText = exact([
            /^Following$/i, /^Following\s*v$/i, /^\u6b63\u5728\u95dc\u6ce8$/, /^\u6b63\u5728\u5173\u6ce8$/,
            /^\u5df2\u95dc\u6ce8$/, /^\u5df2\u5173\u6ce8$/, /^\u8ffd\u8e64\u4e2d$/
          ]);
          const requestedText = exact([/^Requested$/i, /^\u5df2\u8acb\u6c42$/, /^\u5df2\u8bf7\u6c42$/]);
          const followText = exact([/^Follow$/i, /^\u95dc\u6ce8$/, /^\u5173\u6ce8$/, /^\u8ffd\u8e64$/]);
          const followsYouMatch = bodyText.match(/(?:^|\s)(Follows you|\u95dc\u6ce8\u4e86\u4f60|\u5173\u6ce8\u4e86\u4f60|\u8ffd\u8e64\u4f60)(?:\s|$)/i);
          const unavailable = /Sorry, this page isn't available|Page isn't available|User not found|\u627e\u4e0d\u5230\u9801\u9762|\u627e\u4e0d\u5230\u9875\u9762|\u7528\u6236\u4e0d\u5b58\u5728|\u7528\u6237\u4e0d\u5b58\u5728/i.test(bodyText);
          const loginWall = /\/accounts\/login/i.test(location.pathname) ||
            (/Log in|\u767b\u5165|\u767b\u5f55/i.test(bodyText) && /Sign up|\u8a3b\u518a|\u6ce8\u518c/i.test(bodyText));
          const profileSurface = Boolean(document.querySelector('header')) &&
            (/followers|following|\u7c89\u7d72|\u7c89\u4e1d|\u95dc\u6ce8|\u5173\u6ce8/i.test(bodyText) || Boolean(followingText || requestedText || followText));
          return {
            senderFollowing: Boolean(followingText),
            senderRequested: Boolean(requestedText),
            senderNotFollowing: Boolean(followText),
            followsSender: Boolean(followsYouMatch),
            followingEvidence: followingText,
            requestedEvidence: requestedText,
            notFollowingEvidence: followText,
            followsSenderEvidence: followsYouMatch ? followsYouMatch[1] : '',
            unavailable,
            loginWall,
            profileSurface,
          };
        }
        """
    )
    return dict(inspected) if isinstance(inspected, dict) else {}


def _run_instagram_relationship_verify(
    page,
    task,
    account,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    expected_username = _relationship_username(
        payload.get("expected_username") or payload.get("expectedUsername") or account.get("username")
    )
    account_username = _relationship_username(account.get("username"))
    if not expected_username or expected_username != account_username:
        raise ValueError("Instagram relationship verification sender does not match the selected account.")
    raw_targets = payload.get("target_usernames")
    if raw_targets is None:
        raw_targets = payload.get("targetUsernames")
    if not isinstance(raw_targets, list):
        raise ValueError("Instagram relationship verification requires target_usernames.")
    targets: list[str] = []
    for value in raw_targets:
        username = _relationship_username(value)
        if username and username not in targets:
            targets.append(username)
    if not targets or len(targets) > 20 or len(targets) != len(raw_targets):
        raise ValueError("Instagram relationship verification requires 1 to 20 unique valid usernames.")

    results: list[dict[str, Any]] = []
    last_screenshot = ""
    for index, target_username in enumerate(targets, start=1):
        _raise_if_cancelled(cancel_event)
        profile_url = f"{INSTAGRAM_HOME}{quote(target_username, safe='._')}/"
        try:
            _goto(page, profile_url, logger, f"instagram_relationship_open_{index}")
            time.sleep(1.0)
            inspected = _inspect_instagram_relationship_page(page)
            last_screenshot = _screenshot(
                page,
                screenshot_dir,
                task,
                f"instagram_relationship_{index}_{target_username}",
                logger,
            )
            inspected_url = str(page.url or "")
            if inspected.get("loginWall"):
                raise NeedManualError(
                    "Instagram login expired while verifying relationships.",
                    "cookie_expired",
                    last_screenshot,
                )
            parsed_url = urlparse(inspected_url)
            inspected_profile = _relationship_username(
                (parsed_url.path or "").strip("/").split("/", 1)[0]
            )
            navigation_matches = (
                parsed_url.scheme == "https"
                and (parsed_url.hostname or "").lower() in {"instagram.com", "www.instagram.com"}
                and inspected_profile == target_username
            )
            if not navigation_matches:
                result = {
                    "target_username": target_username,
                    "profile_found": None,
                    "sender_follows": None,
                    "follows_sender": None,
                    "status": "unknown",
                    "reason_code": "profile_navigation_mismatch",
                    "inspected_url": inspected_url,
                    "screenshot_path": last_screenshot,
                }
            elif inspected.get("unavailable"):
                result = {
                    "target_username": target_username,
                    "profile_found": False,
                    "sender_follows": None,
                    "follows_sender": None,
                    "status": "unknown",
                    "reason_code": "profile_unavailable",
                    "inspected_url": inspected_url,
                    "screenshot_path": last_screenshot,
                }
            elif not inspected.get("profileSurface"):
                result = {
                    "target_username": target_username,
                    "profile_found": None,
                    "sender_follows": None,
                    "follows_sender": None,
                    "status": "unknown",
                    "reason_code": "profile_evidence_incomplete",
                    "inspected_url": inspected_url,
                    "screenshot_path": last_screenshot,
                }
            elif inspected.get("senderRequested"):
                result = {
                    "target_username": target_username,
                    "profile_found": True,
                    "sender_follows": None,
                    "follows_sender": bool(inspected.get("followsSender")),
                    "status": "unknown",
                    "reason_code": "follow_request_pending",
                    "inspected_url": inspected_url,
                    "screenshot_path": last_screenshot,
                    "evidence": {
                        "requested": str(inspected.get("requestedEvidence") or ""),
                        "follows_sender": str(inspected.get("followsSenderEvidence") or ""),
                    },
                }
            else:
                sender_follows: bool | None
                if inspected.get("senderFollowing"):
                    sender_follows = True
                elif inspected.get("senderNotFollowing"):
                    sender_follows = False
                else:
                    sender_follows = None
                follows_sender = bool(inspected.get("followsSender"))
                if sender_follows is None:
                    status = "unknown"
                    reason_code = "sender_follow_evidence_incomplete"
                elif sender_follows and follows_sender:
                    status = "mutual"
                    reason_code = ""
                elif sender_follows:
                    status = "sender_follows"
                    reason_code = ""
                elif follows_sender:
                    status = "follows_sender"
                    reason_code = ""
                else:
                    status = "none"
                    reason_code = ""
                result = {
                    "target_username": target_username,
                    "profile_found": True,
                    "sender_follows": sender_follows,
                    "follows_sender": follows_sender,
                    "status": status,
                    "reason_code": reason_code,
                    "inspected_url": inspected_url,
                    "screenshot_path": last_screenshot,
                    "evidence": {
                        "sender_follows": str(inspected.get("followingEvidence") or inspected.get("notFollowingEvidence") or ""),
                        "follows_sender": str(inspected.get("followsSenderEvidence") or ""),
                    },
                }
            results.append(result)
            logger.log(
                "info" if result["status"] != "unknown" else "warn",
                "instagram_relationship_evidence",
                "Instagram relationship evidence inspected.",
                {
                    "target_username": target_username,
                    "status": result["status"],
                    "reason_code": result.get("reason_code") or "",
                    "inspected_url": inspected_url,
                },
                last_screenshot,
            )
        except NeedManualError:
            raise
        except Exception as exc:
            last_screenshot = _screenshot(
                page,
                screenshot_dir,
                task,
                f"instagram_relationship_unknown_{index}_{target_username}",
                logger,
            )
            results.append(
                {
                    "target_username": target_username,
                    "profile_found": None,
                    "sender_follows": None,
                    "follows_sender": None,
                    "status": "unknown",
                    "reason_code": "inspection_failed",
                    "error": str(exc)[:500],
                    "inspected_url": str(page.url or ""),
                    "screenshot_path": last_screenshot,
                }
            )
            logger.log(
                "warn",
                "instagram_relationship_unknown",
                "Instagram relationship could not be proved; the target remains unknown.",
                {"target_username": target_username, "error": str(exc)[:500]},
                last_screenshot,
            )

    verified_count = sum(1 for item in results if item["status"] != "unknown")
    unknown_count = len(results) - verified_count
    return {
        "ok": True,
        "read_only": True,
        "expected_username": expected_username,
        "total": len(results),
        "verified_count": verified_count,
        "unknown_count": unknown_count,
        "results": results,
        "retryable": False,
        "screenshot_path": last_screenshot,
    }


def _click_text_button(
    page,
    logger: AutomationLogger,
    names: list[str],
    stage: str,
    *,
    abort_if: Callable[[], bool] | None = None,
):
    for name in names:
        if abort_if is not None and abort_if():
            return False
        locators = [
            page.get_by_role("button", name=name).first,
            page.get_by_text(name, exact=True).first,
            page.locator(f'button:has-text("{name}")').first,
            page.locator(f'a:has-text("{name}")').first,
            page.locator(f'[role="button"]:has-text("{name}")').first,
            page.locator(f'[aria-label="{name}"]').first,
        ]
        for loc in locators:
            if abort_if is not None and abort_if():
                return False
            try:
                if loc.count() and loc.is_visible(timeout=2500):
                    if abort_if is not None and abort_if():
                        return False
                    action_page = getattr(page, "page", None)
                    if callable(action_page):
                        action_page = action_page()
                    if action_page is None:
                        action_page = page
                    if _human_click(action_page, loc, logger, stage, abort_if=abort_if):
                        return True
            except Exception:
                continue
        if abort_if is not None and abort_if():
            return False
        try:
            clicked = page.evaluate(
                """label => {
                    const wanted = String(label || '').trim().toLowerCase();
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                    for (const node of candidates) {
                        const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                        if (!text || text !== wanted) continue;
                        const rect = node.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) continue;
                        const style = window.getComputedStyle(node);
                        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
                        node.scrollIntoView({block: 'center', inline: 'center'});
                        node.click();
                        return true;
                    }
                    return false;
                }""",
                name,
            )
            if clicked:
                logger.log("debug", stage, "Clicked text target with DOM fallback.", {"label": name})
                return True
        except Exception:
            pass
    return False


def _visible_first(page, selectors: list[str], timeout_ms: int = 1200):
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=timeout_ms):
                return loc
        except Exception:
            continue
    return None


def _find_threads_login_card_anchor(
    page,
    *,
    abort_if: Callable[[], bool] | None = None,
):
    """Return the visible primary control anchoring a Threads login card."""
    try:
        candidates = page.locator('button:has(svg), a:has(svg), [role="button"]:has(svg), button:has(img), a:has(img), [role="button"]:has(img)')
        best = None
        best_score = -1.0
        for index in range(min(int(candidates.count()), 120)):
            if abort_if is not None and abort_if():
                return None
            candidate = candidates.nth(index)
            if not candidate.is_visible(timeout=300):
                continue
            box = candidate.bounding_box()
            if not isinstance(box, dict):
                continue
            width = float(box.get("width") or 0)
            height = float(box.get("height") or 0)
            if width < 160 or height < 40 or height > 140:
                continue
            if not str(candidate.inner_text(timeout=300) or "").strip():
                continue
            branded = candidate.locator(
                '[aria-label*="instagram" i], [title*="instagram" i], img[alt*="instagram" i], img[src*="instagram" i]'
            ).count() > 0
            if not branded:
                continue
            score = width
            if score > best_score:
                best = candidate
                best_score = score
        return best
    except Exception:
        return None


def _threads_login_surface_visible(page) -> bool:
    """Recognize the Threads login card/form by structure, independent of page language."""
    if _find_threads_login_card_anchor(page) is not None:
        return True
    return _visible_first(
        page,
        [
            'input[name="username"]',
            'input[autocomplete="username"]',
            'input[type="password"]',
            'input[autocomplete="current-password"]',
        ],
        timeout_ms=400,
    ) is not None


def _click_login_submit_by_structure(
    page,
    logger: AutomationLogger,
    password_input,
    *,
    abort_if: Callable[[], bool] | None = None,
) -> bool:
    """Click the primary submit control in the same login form as the password field."""
    if abort_if is not None and abort_if():
        return False
    if password_input is None:
        return False
    try:
        marked = password_input.evaluate(
            r"""input => {
                const marker = 'data-vecto-login-submit';
                document.querySelectorAll(`[${marker}]`).forEach((node) => node.removeAttribute(marker));
                const isVisible = (node) => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 24 && rect.height > 16
                        && style.visibility !== 'hidden'
                        && style.display !== 'none'
                        && style.pointerEvents !== 'none';
                };
                const form = input.form || input.closest('form') || input.parentElement;
                if (!form) return false;
                const typed = form.querySelector('button[type="submit"], input[type="submit"], [type="submit"]');
                if (typed && isVisible(typed)) {
                    typed.setAttribute(marker, '1');
                    typed.scrollIntoView({block: 'center', inline: 'center'});
                    return true;
                }
                const inputRect = input.getBoundingClientRect();
                let best = null;
                let bestScore = Number.POSITIVE_INFINITY;
                const controls = form.querySelectorAll('button, [role="button"]');
                for (const node of controls) {
                    if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
                    if (!isVisible(node)) continue;
                    const rect = node.getBoundingClientRect();
                    if (rect.width < 72 || rect.height > 90) continue;
                    const gap = rect.top - inputRect.bottom;
                    if (gap < -8 || gap > 180) continue;
                    const score = gap * 4 + Math.abs(rect.left - inputRect.left);
                    if (score < bestScore) {
                        best = node;
                        bestScore = score;
                    }
                }
                if (!best) return false;
                best.setAttribute(marker, '1');
                best.scrollIntoView({block: 'center', inline: 'center'});
                return true;
            }"""
        )
        if not marked:
            return False
        target = page.locator('[data-vecto-login-submit="1"]').first
        if not _human_click(page, target, logger, "auto_login_submit_structure", abort_if=abort_if):
            return False
        logger.log(
            "info",
            "auto_login_submit_structure",
            "登录提交按钮已通过表单结构识别。",
            {"evidence": "visual_structure", "url": _safe_navigation_url(page.url)},
        )
        return True
    except Exception:
        return False


def _click_threads_username_entry_by_structure(
    page,
    logger: AutomationLogger,
    *,
    abort_if: Callable[[], bool] | None = None,
) -> bool:
    """Click the secondary username login control within the Threads login card."""
    if abort_if is not None and abort_if():
        return False
    try:
        login_link = page.locator(
            'a[href^="/login"][href*="show_choice_screen=false"]'
        ).first
        if login_link.count() and login_link.is_visible(timeout=800):
            href = str(login_link.get_attribute("href") or "").strip()
            if href:
                _goto(
                    page,
                    urljoin(str(page.url or THREADS_HOME), href),
                    logger,
                    "threads_login_username_structure",
                    timeout_ms=15000,
                )
                logger.log(
                    "info",
                    "threads_login_username_structure",
                    "Threads 用户名登录入口已通过官方登录链接结构识别。",
                    {"evidence": "official_login_href", "url": _safe_navigation_url(page.url)},
                )
                return True
    except Exception:
        pass
    anchor = _find_threads_login_card_anchor(page, abort_if=abort_if)
    if anchor is None:
        return False
    try:
        marked = anchor.evaluate(
            r"""anchor => {
                const marker = 'data-vecto-threads-username-entry';
                document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));
                const anchorRect = anchor.getBoundingClientRect();
                if (anchorRect.width <= 0 || anchorRect.height <= 0) return false;
                const isVisible = (node, rect) => {
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0
                        && style.visibility !== 'hidden'
                        && style.display !== 'none'
                        && style.pointerEvents !== 'none';
                };
                const isInstagramBranded = (node) => Boolean(node.querySelector(
                    '[aria-label*="instagram" i], [title*="instagram" i], img[alt*="instagram" i], img[src*="instagram" i]'
                ));
                let scope = anchor.parentElement;
                let best = null;
                let bestScore = Number.POSITIVE_INFINITY;
                for (let depth = 0; scope && depth < 7; depth += 1, scope = scope.parentElement) {
                    const controls = scope.querySelectorAll('button, a, [role="button"], [tabindex="0"]');
                    for (const node of controls) {
                        if (node === anchor || node.contains(anchor) || anchor.contains(node)) continue;
                        if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
                        if (isInstagramBranded(node)) continue;
                        const rect = node.getBoundingClientRect();
                        if (!isVisible(node, rect)) continue;
                        if (rect.width < 40 || rect.height < 16 || rect.height > 90) continue;
                        const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!text) continue;
                        const gap = rect.top - anchorRect.bottom;
                        if (gap < -2 || gap > 150) continue;
                        const overlap = Math.max(0, Math.min(rect.right, anchorRect.right) - Math.max(rect.left, anchorRect.left));
                        const overlapRatio = overlap / Math.max(1, Math.min(rect.width, anchorRect.width));
                        const centerDelta = Math.abs((rect.left + rect.right - anchorRect.left - anchorRect.right) / 2);
                        if (overlapRatio < 0.35 && centerDelta > Math.max(120, anchorRect.width * 0.45)) continue;
                        const score = gap * 5 + centerDelta + depth * 3 + Math.abs(rect.width - anchorRect.width) * 0.05;
                        if (score < bestScore) {
                            best = node;
                            bestScore = score;
                        }
                    }
                    if (best) break;
                }
                if (!best) return false;
                best.scrollIntoView({block: 'center', inline: 'center'});
                best.setAttribute(marker, '1');
                return true;
            }"""
        )
        if not marked:
            return False
        target = page.locator('[data-vecto-threads-username-entry="1"]').first
        if not _human_click(
            page,
            target,
            logger,
            "threads_login_username_structure",
            abort_if=abort_if,
        ):
            return False
        logger.log(
            "info",
            "threads_login_username_structure",
            "Threads 用户名登录入口已通过登录卡结构和相对位置识别。",
            {"evidence": "visual_structure", "url": _safe_navigation_url(page.url)},
        )
        return True
    except Exception:
        return False


def _visible_last(page, selectors: list[str], timeout_ms: int = 1200):
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = locator.count()
            for index in range(count - 1, -1, -1):
                loc = locator.nth(index)
                if loc.is_visible(timeout=timeout_ms):
                    return loc
        except Exception:
            continue
    return None


def _page_body_text_lower(page, timeout_ms: int = 3000) -> str:
    try:
        return str(page.locator("body").inner_text(timeout=timeout_ms) or "").lower()
    except Exception:
        return ""


def _safe_navigation_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        if not parsed.scheme or not parsed.netloc:
            return parsed.path or ""
        return parsed._replace(params="", query="", fragment="").geturl()
    except Exception:
        return raw.split("?", 1)[0].split("#", 1)[0]


def _safe_login_status(status: dict[str, Any] | None) -> dict[str, Any]:
    result = dict(status or {})
    if "url" in result:
        result["url"] = _safe_navigation_url(result.get("url"))
    return result


def _login_input_attribute(locator, name: str) -> str:
    with contextlib.suppress(Exception):
        getter = getattr(locator, "get_attribute", None)
        if callable(getter):
            value = getter(name)
            if isinstance(value, str):
                return value
    with contextlib.suppress(Exception):
        evaluate = getattr(locator, "evaluate", None)
        if callable(evaluate):
            value = evaluate("(el, attr) => String(el.getAttribute(attr) || '')", name)
            if isinstance(value, str):
                return value
    return ""


def _is_login_identifier_input(locator) -> bool:
    blob = " ".join(
        _login_input_attribute(locator, name)
        for name in ("name", "type", "autocomplete", "aria-label", "placeholder", "id", "inputmode")
    ).lower()
    if not blob.strip():
        return False
    if any(
        token in blob
        for token in (
            "verification",
            "security code",
            "one-time",
            "otp",
            "approvals_code",
            "code",
            "验证码",
            "驗證碼",
            "安全码",
            "安全碼",
        )
    ):
        return False
    return any(
        token in blob
        for token in (
            "username",
            "user name",
            "password",
            "passwd",
            "email",
            "e-mail",
            "phone number",
            "mobile number",
            "用户名",
            "用戶名",
            "帐号",
            "账号",
            "帳號",
            "密码",
            "密碼",
            "邮箱",
            "郵箱",
            "信箱",
            "手机号",
            "手機號",
            "手机号码",
            "手機號碼",
        )
    )


def _verification_code_input(page):
    for selector in (
        'input[autocomplete="one-time-code"]',
        'input[name="approvals_code"]',
        'input[name*="security_code" i]',
        'input[name*="verification_code" i]',
        'input[name*="code" i]',
        'input[name*="otp" i]',
        'input[id*="otp" i]',
        'input[aria-label*="otp" i]',
        'input[placeholder*="otp" i]',
        'input[aria-label*="code" i]',
        'input[placeholder*="code" i]',
        'input[aria-label*="验证码"]',
        'input[placeholder*="验证码"]',
        'input[aria-label*="驗證碼"]',
        'input[placeholder*="驗證碼"]',
        'input[maxlength="6"]',
        'input[inputmode="numeric"]',
        'input[type="tel"]',
        GENERIC_VERIFICATION_CODE_INPUT_SELECTOR,
    ):
        locator = _visible_first(page, [selector], timeout_ms=500)
        if locator is None or _is_login_identifier_input(locator):
            continue
        return locator
    return None


def _has_large_verification_illustration(page) -> bool:
    """Detect stable verification artwork without depending on page language."""
    try:
        images = page.locator('img, [role="img"]')
        count = min(int(images.count()), 12)
    except Exception:
        return False
    for index in range(count):
        try:
            image = images.nth(index)
            if not image.is_visible():
                continue
            box = image.bounding_box()
            if not isinstance(box, dict):
                continue
            if float(box.get("width") or 0) >= 240 and float(box.get("height") or 0) >= 120:
                return True
        except Exception:
            continue
    return False


def _classify_verification_challenge(page) -> dict[str, Any]:
    url = str(page.url or "")
    text = _page_body_text_lower(page)
    mapped = None
    with contextlib.suppress(Exception):
        mapped = _mapped_login_verification_code(page)
    code_input = mapped[2] if mapped else _verification_code_input(page)
    if mapped is not None:
        action_page, surface, _code = mapped
        extra_text = _page_body_text_lower(surface)
        if extra_text and extra_text not in text:
            text = f"{text} {extra_text}".strip()
        surface_url = str(getattr(action_page, "url", "") or getattr(surface, "url", "") or "")
        if surface_url:
            url = surface_url
    has_code_input = code_input is not None
    has_visual_illustration = _has_large_verification_illustration(page)

    authenticator_markers = (
        "go to your authentication app",
        "authentication app",
        "authenticator app",
        "authenticator code",
        "code generator",
        "認証アプリ",
        "認証コード",
        "6桁のコード",
        "二段階認証",
        "二要素認証",
        "驗證應用程式",
        "驗證器應用程式",
        "前往你的驗證應用程式",
        "身份验证应用",
        "身份验证器",
        "验证应用",
        "验证器应用",
        "前往你的身份验证",
        "验证器应用",
        "身份验证器",
        "认证应用",
    )
    sms_markers = (
        "text message",
        "via sms",
        "sent a code to your phone",
        "code to your phone",
        "sms code",
        "短信验证码",
        "手机短信",
        "手機簡訊",
        "短信",
        "简讯",
        "簡訊",
    )
    email_markers = (
        "sent a code to your email",
        "code to your email",
        "sent to your email",
        "to your email",
        "check your email",
        "your email address",
        "邮箱验证码",
        "电子邮件验证码",
        "電子郵件驗證碼",
        "检查你的邮箱",
        "檢查你的郵箱",
    )
    identity_markers = (
        "upload a verification selfie",
        "verification selfie",
        "video selfie",
        "take a selfie video",
        "identity confirmation",
        "your email may not be secure",
        "update your email address",
        "confirm your identity",
        "身份确认",
        "验证自拍",
    )
    method_markers = (
        "choose a way to confirm",
        "choose how to verify",
        "select a verification method",
        "try another way",
        "选择验证方式",
        "选择确认方式",
    )
    generic_markers = tuple(_verification_text_markers()) + (
        "enter your login code",
        "enter a 6-digit code",
        "コードを入力",
        "ログインコード",
        "セキュリティコード",
        "请输入验证码",
    )

    challenge_type = "none"
    evidence = ""
    if any(marker in text for marker in identity_markers):
        challenge_type = "identity_challenge"
    elif any(marker in text for marker in method_markers) and not has_code_input:
        challenge_type = "method_selection"
    elif has_code_input and any(marker in text for marker in sms_markers):
        challenge_type = "sms_code"
    elif has_code_input and any(marker in text for marker in email_markers):
        challenge_type = "email_code"
    elif has_code_input and has_visual_illustration and _is_verification_url(url):
        challenge_type = "authenticator_totp"
        evidence = "visual_structure"
    elif has_code_input and any(marker in text for marker in authenticator_markers):
        challenge_type = "authenticator_totp"
    elif has_code_input and (
        _is_verification_url(url)
        or any(marker in text for marker in generic_markers)
    ):
        challenge_type = "unknown_code"
    elif _is_verification_url(url) or any(marker in text for marker in generic_markers):
        challenge_type = "unknown_challenge"
    return {
        "type": challenge_type,
        "url": _safe_navigation_url(url),
        "has_code_input": has_code_input,
        "code_input": code_input,
        "evidence": evidence or "text_or_url",
    }


def _wait_for_verification_challenge_ready(
    page,
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
) -> dict[str, Any]:
    challenge = _classify_verification_challenge(page)
    challenge_type = str(challenge.get("type") or "")
    terminal_types = {
        "authenticator_totp",
        "sms_code",
        "email_code",
        "identity_challenge",
        "method_selection",
    }
    if challenge_type in terminal_types:
        _publish_login_assistance_state(
            page,
            context_control,
            {"status": "need_verification", "challenge_type": challenge_type, "reason": "检测到平台验证码页面。"},
        )
        return challenge
    if not _is_verification_url(str(page.url or "")) and challenge_type not in {
        "unknown_challenge",
        "unknown_code",
    }:
        return challenge

    _publish_login_assistance_state(
        page,
        context_control,
        {"status": "need_verification", "challenge_type": challenge_type or "unknown_code", "reason": "正在确认验证码页面。"},
    )
    deadline = time.monotonic() + AUTO_TOTP_CHALLENGE_READY_WAIT_SECONDS
    while time.monotonic() < deadline:
        if not _wait_interruptibly(0.25, cancel_event, context_control):
            return challenge
        challenge = _classify_verification_challenge(page)
        challenge_type = str(challenge.get("type") or "")
        if challenge_type in terminal_types:
            return challenge
    return challenge


def _totp_provider(context_control: dict[str, Any] | None) -> Callable[[], dict[str, Any]] | None:
    if not isinstance(context_control, dict):
        return None
    provider = context_control.get("totp_code_provider")
    return provider if callable(provider) else None


def _report_totp_outcome(context_control: dict[str, Any] | None, outcome: str) -> None:
    if not isinstance(context_control, dict):
        return
    clean_outcome = str(outcome or "failed")
    if clean_outcome in {
        "verified",
        "rejected",
        "invalid",
        "unavailable",
        "failed",
        "inconclusive",
    }:
        context_control.pop("_totp_verification_pending", None)
    callback = context_control.get("totp_outcome_callback")
    if callable(callback):
        with contextlib.suppress(Exception):
            callback(clean_outcome)


def _mark_totp_verification_pending(context_control: dict[str, Any] | None) -> None:
    if isinstance(context_control, dict):
        context_control["_totp_verification_pending"] = True


def _complete_pending_totp_verification(context_control: dict[str, Any] | None) -> None:
    if not isinstance(context_control, dict):
        return
    context_control.pop("login_submission_started", None)
    if context_control.get("_totp_verification_pending"):
        _report_totp_outcome(context_control, "verified")


def _clear_verification_code(page, code_input) -> None:
    if code_input is None:
        return
    with contextlib.suppress(Exception):
        code_input.evaluate(
            """element => {
                element.focus();
                if (typeof element.select === 'function') element.select();
            }"""
        )
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")


def _wait_interruptibly(
    seconds: float,
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
) -> bool:
    remaining = max(0.0, float(seconds))
    while remaining > 0:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            return False
        interval = min(0.25, remaining)
        time.sleep(interval)
        remaining -= interval
    return not _manual_takeover_requested(context_control)


def _wait_for_cancellation(seconds: float, cancel_event: Any | None) -> None:
    if cancel_event is None:
        _sleep_between(seconds, seconds)
        return
    _raise_if_cancelled(cancel_event)
    wait = getattr(cancel_event, "wait", None)
    if callable(wait):
        if wait(max(0.0, float(seconds))):
            _raise_if_cancelled(cancel_event)
    else:
        time.sleep(max(0.0, float(seconds)))
    _raise_if_cancelled(cancel_event)


def _try_auto_totp_challenge(
    page,
    task: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    platform: str,
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
) -> dict[str, Any] | None:
    challenge = _wait_for_verification_challenge_ready(
        page,
        cancel_event,
        context_control,
    )
    if str(challenge.get("type") or "") != "authenticator_totp":
        logger.log(
            "debug",
            "auto_totp_not_applicable",
            "当前验证页不是身份验证器验证码，已保留页面供后续验证流程处理。",
            {
                "challenge_type": str(challenge.get("type") or "none"),
                "has_code_input": bool(challenge.get("has_code_input")),
                "url": _safe_navigation_url(page.url),
            },
        )
        return None
    provider = _totp_provider(context_control)
    if provider is None:
        return {
            "status": "need_verification",
            "reason": "检测到身份验证器验证码，但该账号尚未配置 2FA 密钥。",
            "challenge_type": "authenticator_totp",
            "url": _safe_navigation_url(page.url),
        }

    logger.log(
        "info",
        "auto_totp_detected",
        "检测到身份验证器验证码，正在自动完成验证。",
        {"challenge_type": "authenticator_totp", "url": _safe_navigation_url(page.url)},
    )
    attempt = 0
    deadline = time.monotonic() + 70.0
    while attempt < MAX_AUTO_TOTP_ATTEMPTS and time.monotonic() < deadline:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            return {
                "status": "need_verification",
                "reason": "用户已切换为人工接管，自动验证码输入已停止。",
                "challenge_type": "authenticator_totp",
            }
        challenge = _classify_verification_challenge(page)
        challenge_type = str(challenge.get("type") or "")
        challenge_text = _page_body_text_lower(page, timeout_ms=1000)
        continuing_expired_totp = bool(
            attempt > 0
            and challenge.get("code_input") is not None
            and any(marker in challenge_text for marker in (
                "code has expired",
                "code expired",
                "expired code",
                "验证码已过期",
            ))
        )
        if continuing_expired_totp:
            challenge_type = "authenticator_totp"
        if challenge_type != "authenticator_totp":
            current = _detect_platform_login_state(page, platform)
            if platform == "threads":
                current = _restore_threads_after_instagram_login(page, current, logger)
            if str(current.get("status") or "") == "ready":
                stable = _confirm_platform_ready(page, platform, logger, cancel_event)
                if str(stable.get("status") or "") == "ready":
                    _report_totp_outcome(context_control, "verified")
                    return _safe_login_status(stable)
            if challenge_type in {"sms_code", "email_code", "identity_challenge", "method_selection"}:
                _report_totp_outcome(context_control, "inconclusive")
                return {
                    "status": "need_verification",
                    "reason": "验证流程已切换为短信、邮箱或身份确认，需要人工处理。",
                    "challenge_type": challenge_type,
                    "url": _safe_navigation_url(page.url),
                }
            current_status = str(current.get("status") or "")
            if challenge_type != "none" or current_status in {"need_verification", "invalid_credentials"}:
                _report_totp_outcome(context_control, "failed")
                return {
                    "status": "need_verification",
                    "reason": str(current.get("reason") or "2FA 验证尚未完成，需要人工处理。"),
                    "challenge_type": challenge_type,
                }
            _mark_totp_verification_pending(context_control)
            return {
                **_safe_login_status(current),
                "status": "totp_submitted",
                "challenge_type": challenge_type,
            }

        code_input = challenge.get("code_input")
        if code_input is None:
            return {
                "status": "need_verification",
                "reason": "检测到身份验证器验证，但验证码输入框尚不可用。",
                "challenge_type": "authenticator_totp",
            }
        try:
            reservation = provider()
        except Exception:
            reservation = {"available": False, "reason": "provider_failed"}
        if not bool(reservation.get("available")):
            reason = str(reservation.get("reason") or "unavailable")
            if reason in {"period_ending", "counter_already_used"}:
                wait_seconds = max(1, min(int(reservation.get("wait_seconds") or 1), 31))
                if not _wait_interruptibly(wait_seconds, cancel_event, context_control):
                    return {
                        "status": "need_verification",
                        "reason": "用户已切换为人工接管，自动验证码输入已停止。",
                        "challenge_type": "authenticator_totp",
                    }
                continue
            _report_totp_outcome(context_control, "unavailable")
            return {
                "status": "need_verification",
                "reason": "该账号的 2FA 密钥不可用，请人工完成验证或重新配置。",
                "challenge_type": "authenticator_totp",
                "totp_reason": reason,
            }

        code = str(reservation.get("code") or "").strip()
        if not re.fullmatch(r"\d{6}", code):
            _report_totp_outcome(context_control, "failed")
            return {
                "status": "need_verification",
                "reason": "无法生成有效的 2FA 验证码，请人工处理。",
                "challenge_type": "authenticator_totp",
            }
        expires_at = float(reservation.get("expires_at") or 0)

        def code_window_closing() -> bool:
            return bool(
                expires_at > 0
                and expires_at - time.time() < AUTO_TOTP_MIN_SUBMIT_REMAINING_SECONDS
            )

        def totp_input_aborted() -> bool:
            return _manual_takeover_requested(context_control) or code_window_closing()

        try:
            _clear_and_type(
                page,
                code_input,
                code,
                mode="type",
                logger=logger,
                stage="auto_totp_input",
                abort_if=totp_input_aborted,
            )
            if _manual_takeover_requested(context_control):
                _clear_verification_code(page, code_input)
                return {
                    "status": "need_verification",
                    "reason": "用户已切换为人工接管，自动验证码输入已停止。",
                    "challenge_type": "authenticator_totp",
                }
            if code_window_closing():
                _clear_verification_code(page, code_input)
                remaining = max(0.0, expires_at - time.time())
                logger.log(
                    "info",
                    "auto_totp_period_rollover",
                    "当前 2FA 验证码临近刷新，已停止提交并等待下一组验证码。",
                    {
                        "remaining_seconds": round(remaining, 3),
                        "minimum_submit_seconds": AUTO_TOTP_MIN_SUBMIT_REMAINING_SECONDS,
                    },
                )
                if not _wait_interruptibly(
                    min(31.0, remaining + 1.0),
                    cancel_event,
                    context_control,
                ):
                    return {
                        "status": "need_verification",
                        "reason": "用户已切换为人工接管，自动验证码输入已停止。",
                        "challenge_type": "authenticator_totp",
                    }
                continue
            clicked = _click_text_button(
                page,
                logger,
                ["Continue", "Confirm", "Verify", "Submit", "Next", "继续", "确认", "验证", "提交", "下一步"],
                "auto_totp_submit",
                abort_if=totp_input_aborted,
            )
            if not clicked and code_window_closing():
                _clear_verification_code(page, code_input)
                remaining = max(0.0, expires_at - time.time())
                logger.log(
                    "info",
                    "auto_totp_period_rollover",
                    "提交按钮等待期间验证码已临近刷新，已放弃旧码并等待下一组验证码。",
                    {
                        "remaining_seconds": round(remaining, 3),
                        "minimum_submit_seconds": AUTO_TOTP_MIN_SUBMIT_REMAINING_SECONDS,
                    },
                )
                if not _wait_interruptibly(
                    min(31.0, remaining + 1.0),
                    cancel_event,
                    context_control,
                ):
                    return {
                        "status": "need_verification",
                        "reason": "用户已切换为人工接管，自动验证码输入已停止。",
                        "challenge_type": "authenticator_totp",
                    }
                continue
            if not clicked and not _manual_takeover_requested(context_control):
                page.keyboard.press("Enter")
        except Exception:
            _report_totp_outcome(context_control, "failed")
            _clear_verification_code(page, code_input)
            return {
                "status": "need_verification",
                "reason": "自动填写 2FA 验证码失败，请人工处理。",
                "challenge_type": "authenticator_totp",
            }
        attempt += 1
        logger.log(
            "info",
            "auto_totp_submitted",
            "2FA 验证码已自动提交，正在确认登录结果。",
            {"attempt": attempt, "url": _safe_navigation_url(page.url)},
        )

        max_result_checks = max(1, int(AUTO_TOTP_RESULT_WAIT_SECONDS / 0.5))
        for _ in range(max_result_checks):
            if not _wait_interruptibly(0.5, cancel_event, context_control):
                _clear_verification_code(page, code_input)
                _mark_totp_verification_pending(context_control)
                return {
                    "status": "need_verification",
                    "reason": "用户已切换为人工接管，自动验证码确认已停止。",
                    "challenge_type": "authenticator_totp",
                }
            detected = _detect_platform_login_state(page, platform)
            if platform == "threads":
                detected = _restore_threads_after_instagram_login(page, detected, logger)
            if str(detected.get("status") or "") == "ready":
                stable = _confirm_platform_ready(page, platform, logger, cancel_event)
                if str(stable.get("status") or "") == "ready":
                    _report_totp_outcome(context_control, "verified")
                    return _safe_login_status(stable)
            current_challenge = _classify_verification_challenge(page)
            current_type = str(current_challenge.get("type") or "")
            text = _page_body_text_lower(page, timeout_ms=1000)
            if any(marker in text for marker in (
                "incorrect code",
                "code you entered is incorrect",
                "invalid code",
                "code isn't valid",
                "验证码不正确",
                "验证码无效",
            )):
                _report_totp_outcome(context_control, "rejected")
                _clear_verification_code(page, code_input)
                return {
                    "status": "need_verification",
                    "reason": "身份验证器验证码被拒绝，已停止自动重试，请检查 2FA 密钥。",
                    "challenge_type": "authenticator_totp",
                }
            if any(marker in text for marker in (
                "code has expired",
                "code expired",
                "expired code",
                "验证码已过期",
            )):
                _report_totp_outcome(context_control, "expired")
                _clear_verification_code(page, code_input)
                break
            if current_type != "authenticator_totp":
                current = detected
                if str(current.get("status") or "") == "ready":
                    stable = _confirm_platform_ready(page, platform, logger, cancel_event)
                    if str(stable.get("status") or "") == "ready":
                        _report_totp_outcome(context_control, "verified")
                        return stable
                if current_type in {"sms_code", "email_code", "identity_challenge", "method_selection"}:
                    _report_totp_outcome(context_control, "inconclusive")
                    _clear_verification_code(page, code_input)
                    return {
                        "status": "need_verification",
                        "reason": "验证流程已切换为短信、邮箱或身份确认，需要人工处理。",
                        "challenge_type": current_type,
                    }
                current_status = str(current.get("status") or "")
                if current_status == "need_verification" and current_type == "none":
                    # Meta can replace the TOTP form before its login-state text
                    # settles. Keep polling instead of treating that brief
                    # cross-page state as a rejected code.
                    continue
                if current_type != "none" or current_status == "invalid_credentials":
                    _report_totp_outcome(context_control, "failed")
                    _clear_verification_code(page, code_input)
                    return {
                        "status": "need_verification",
                        "reason": str(current.get("reason") or "2FA 验证尚未完成，需要人工处理。"),
                        "challenge_type": current_type,
                    }
                _mark_totp_verification_pending(context_control)
                return {
                    **_safe_login_status(current),
                    "status": "totp_submitted",
                    "challenge_type": current_type,
                }
        else:
            _report_totp_outcome(context_control, "failed")
            _clear_verification_code(page, code_input)
            return {
                "status": "need_verification",
                "reason": "2FA 验证结果超时，已停止自动重试，请人工确认。",
                "challenge_type": "authenticator_totp",
            }

    _clear_verification_code(page, challenge.get("code_input") if isinstance(challenge, dict) else None)
    return {
        "status": "need_verification",
        "reason": "2FA 自动验证未成功，已达到 2 次尝试上限，请人工处理。",
        "challenge_type": "authenticator_totp",
    }


def _clear_and_type(
    page,
    locator,
    text: str,
    *,
    mode: str = "paste",
    logger: AutomationLogger | None = None,
    stage: str = "text_input",
    abort_if: Callable[[], bool] | None = None,
) -> None:
    if abort_if is not None and abort_if():
        return
    locator.wait_for(state="visible", timeout=10000)
    if abort_if is not None and abort_if():
        return
    locator.evaluate(
        """element => {
            element.focus();
            if (typeof element.select === 'function') element.select();
            else if (element.isContentEditable) document.getSelection().selectAllChildren(element);
        }""",
        timeout=10000,
    )
    if abort_if is not None and abort_if():
        return
    page.keyboard.press("Control+A")
    if abort_if is not None and abort_if():
        return
    page.keyboard.press("Backspace")
    _type_text(
        page,
        text,
        min_delay=0.07,
        max_delay=0.16,
        mode=mode,
        logger=logger,
        stage=stage,
        abort_if=abort_if,
    )


def _auto_submit_login_form(
    page,
    platform: str,
    payload: dict[str, Any],
    logger: AutomationLogger,
    task: dict[str, Any],
    screenshot_dir: Path,
    context_control: dict[str, Any] | None = None,
) -> bool:
    username = str(payload.get("login_username") or payload.get("username") or "").strip()
    password = str(payload.get("login_password") or payload.get("password") or "").strip()
    if not username or not password:
        return False
    if _manual_takeover_requested(context_control):
        return False
    takeover_requested = lambda: _manual_takeover_requested(context_control)
    start_shot = _screenshot(page, screenshot_dir, task, "auto_login_start", logger)
    logger.log("info", "auto_login_start", f"开始自动填写 {_platform_name(platform)} 登录凭据。", {"username": username, "url": _safe_navigation_url(page.url)}, start_shot)

    if platform == "threads" and "/threads/sso/" in str(page.url or "").lower() and not payload.get("_threads_sso_blank_reload_attempted"):
        payload["_threads_sso_blank_reload_attempted"] = True
        logger.log(
            "warn",
            "threads_sso_blank_reload",
            "Threads Instagram SSO handoff landed on the SSO bridge page; refreshing once before resolving login inputs.",
            {"url": _safe_navigation_url(page.url)},
        )
        with contextlib.suppress(Exception):
            page.reload(wait_until="domcontentloaded", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=8000)
        _sleep_between(1.0, 2.0)
    if platform == "threads" and "/threads/sso/" in str(page.url or "").lower() and not payload.get("_threads_sso_login_fallback_attempted"):
        payload["_threads_sso_login_fallback_attempted"] = True
        logger.log(
            "warn",
            "threads_sso_login_fallback",
            "Threads Instagram SSO bridge still has no login form; opening the standard Instagram login page.",
            {"url": _safe_navigation_url(page.url)},
        )
        with contextlib.suppress(Exception):
            page.evaluate("(url) => window.location.replace(url)", INSTAGRAM_LOGIN)
            page.wait_for_load_state("domcontentloaded", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=8000)
        if "/threads/sso/" in str(page.url or "").lower():
            with contextlib.suppress(Exception):
                _goto(page, INSTAGRAM_LOGIN, logger, "threads_sso_login_fallback")
        _sleep_between(1.0, 2.0)

    if platform == "instagram":
        body_text = _page_body_text_lower(page, timeout_ms=1200)
        normalized_username = username.lower().lstrip("@")
        remembered_profile = bool(
            normalized_username
            and normalized_username in body_text
            and "continue" in body_text
            and any(
                marker in body_text
                for marker in (
                    "use another profile",
                    "switch accounts",
                    "使用其他个人资料",
                    "使用其他帐号",
                    "使用其他账号",
                )
            )
        )
        if remembered_profile:
            continue_attempted = bool(
                payload.get("_instagram_remembered_profile_continue_attempted")
            )
            if not continue_attempted:
                logger.log(
                    "info",
                    "instagram_remembered_profile",
                    "检测到 Instagram 已记住当前账号，正在继续使用该账号登录。",
                    {"username": username, "url": _safe_navigation_url(page.url)},
                )
                payload["_instagram_remembered_profile_continue_attempted"] = True
                clicked = _click_text_button(
                    page,
                    logger,
                    ["Continue", "继续"],
                    "instagram_remembered_profile_continue",
                    abort_if=takeover_requested,
                )
                if clicked:
                    _sleep_between(2.0, 4.0)
                    return True
            logger.log(
                "warn",
                "instagram_remembered_profile_fallback",
                "Instagram 已记住账号的继续登录未生效，正在切换到账号密码登录。",
                {"username": username, "url": _safe_navigation_url(page.url)},
            )
            switched = _click_text_button(
                page,
                logger,
                ["Use another profile", "Switch accounts", "使用其他个人资料", "使用其他帐号", "使用其他账号"],
                "instagram_remembered_profile_switch",
                abort_if=takeover_requested,
            )
            if not switched:
                return False
            _sleep_between(1.5, 3.0)

    continue_clicked = False
    current_hostname = str(urlparse(str(page.url or "")).hostname or "").lower()
    on_threads_host = current_hostname in {"threads.net", "threads.com"} or current_hostname.endswith(
        (".threads.net", ".threads.com")
    )
    if platform == "threads" and on_threads_host:
        native_username_selectors = ['input[name="username"]', 'input[autocomplete="username"]', 'input[type="text"]']
        native_password_selectors = ['input[type="password"]', 'input[autocomplete="current-password"]']
        if _visible_first(page, native_username_selectors, 700) and _visible_first(page, native_password_selectors, 700):
            continue_clicked = True
            logger.log(
                "info",
                "threads_login_native_form_ready",
                "Threads username/password inputs are already visible; filling them without opening another login route.",
                {"url": _safe_navigation_url(page.url)},
            )
        else:
            for username_entry_attempt in range(1, 4):
                if _manual_takeover_requested(context_control):
                    return False
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass
                username_entry_clicked = _click_threads_username_entry_by_structure(
                    page,
                    logger,
                    abort_if=takeover_requested,
                )
                if not username_entry_clicked:
                    username_entry_clicked = _click_text_button(
                        page,
                        logger,
                        [
                            "Log in with username instead",
                            "Log in with username",
                            "Use username instead",
                            "代わりにユーザーネームでログイン",
                            "ユーザーネームでログイン",
                            "改用用户名登录",
                            "使用用户名登录",
                            "改用用戶名稱登入",
                            "使用用戶名稱登入",
                        ],
                        "threads_login_username_instead",
                        abort_if=takeover_requested,
                    )
                if not username_entry_clicked:
                    continue
                _sleep_between(1.2, 2.2)
                if _visible_first(page, native_username_selectors, 700) and _visible_first(page, native_password_selectors, 700):
                    logger.log("info", "threads_login_username_instead", "Threads username/password login entry was opened.", {"attempt": username_entry_attempt, "url": _safe_navigation_url(page.url)})
                    continue_clicked = True
                    break
                logger.log("warn", "threads_login_username_instead", "Threads username login entry click did not expose inputs yet; retrying.", {"attempt": username_entry_attempt, "url": _safe_navigation_url(page.url)})
        if not continue_clicked:
            if _manual_takeover_requested(context_control):
                return False
            logger.log(
                "warn",
                "threads_login_native_form_missing",
                "Threads-native username/password form is not available yet; keeping recovery on threads.com.",
                {"url": _safe_navigation_url(page.url)},
            )

    logger.log("info", "auto_login_find_inputs", "正在查找用户名和密码输入框。", {"url": _safe_navigation_url(page.url)})
    username_selectors = [
        'input[name="username"]',
        'input[autocomplete="username"]',
        'input[type="text"]',
        'input[aria-label*="username" i]',
        'input[aria-label*="phone" i]',
        'input[aria-label*="email" i]',
        'input[placeholder*="username" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="email" i]',
    ]
    password_selectors = [
        'input[name="password"]',
        'input[autocomplete="current-password"]',
        'input[type="password"]',
        'input[aria-label*="password" i]',
        'input[placeholder*="password" i]',
    ]
    username_input = None
    password_input = None
    input_deadline = time.monotonic() + LOGIN_FORM_WAIT_SECONDS
    while time.monotonic() < input_deadline:
        if _manual_takeover_requested(context_control):
            return False
        username_input = _visible_first(page, username_selectors, 400)
        password_input = _visible_first(page, password_selectors, 400)
        if username_input is not None and password_input is not None:
            break
        time.sleep(0.5)
    if username_input is None or password_input is None:
        shot = _screenshot(page, screenshot_dir, task, "auto_login_inputs_missing", logger)
        logger.log("warn", "auto_login_inputs_missing", "未找到可见的登录输入框，无法自动填写凭据。", {"continued": continue_clicked, "url": _safe_navigation_url(page.url)}, shot)
        return False

    try:
        logger.log("info", "auto_login_type_username", "正在填写登录用户名。", {"username": username})
        if _manual_takeover_requested(context_control):
            return False
        _clear_and_type(
            page,
            username_input,
            username,
            mode="type",
            logger=logger,
            stage="auto_login_type_username",
            abort_if=takeover_requested,
        )
        _sleep_between(0.4, 0.9)
        if _manual_takeover_requested(context_control):
            return False
        logger.log("info", "auto_login_type_password", "正在填写登录密码。", {"password": "***"})
        _clear_and_type(
            page,
            password_input,
            password,
            mode="type",
            logger=logger,
            stage="auto_login_type_password",
            abort_if=takeover_requested,
        )
        _sleep_between(0.4, 0.9)
    except Exception as exc:
        shot = _screenshot(page, screenshot_dir, task, "auto_login_type_failed", logger)
        logger.log("warn", "auto_login_type_failed", "自动填写登录凭据失败。", {"error": str(exc), "url": _safe_navigation_url(page.url)}, shot)
        return False
    filled_shot = _screenshot(page, screenshot_dir, task, "auto_login_form_filled", logger)
    logger.log("info", "auto_login_form_filled", "登录表单已填写完成。", {"username": username, "password": "***"}, filled_shot)
    if _manual_takeover_requested(context_control):
        return False
    clicked = _click_login_submit_by_structure(
        page,
        logger,
        password_input,
        abort_if=takeover_requested,
    )
    if not clicked:
        clicked = _click_text_button(
            page,
            logger,
            ["Log in", "Log In", "Login", "Continue", "ログイン", "\u767b\u5f55", "\u767b\u5165", "\u7ee7\u7eed"],
            "auto_login_submit",
            abort_if=takeover_requested,
        )
    if not clicked:
        if takeover_requested():
            return False
        page.keyboard.press("Enter")
    if isinstance(context_control, dict):
        context_control["login_submission_started"] = True
        context_control["login_submission_monotonic"] = time.monotonic()
    submit_shot = _screenshot(page, screenshot_dir, task, "auto_login_submitted", logger)
    logger.log("info", "auto_login_submit", "登录表单已提交，正在等待账号就绪或验证提示。", {"clicked_submit_button": clicked, "url": _safe_navigation_url(page.url)}, submit_shot)
    if platform == "threads":
        _sleep_between(6.0, 6.0)
    else:
        _sleep_between(4.0, 7.0)
    return True


def _verification_visible(page) -> bool:
    return str(_classify_verification_challenge(page).get("type") or "none") != "none"


def _threads_compose_box(page):
    dialog_box = _threads_dialog_compose_box(page)
    if dialog_box is not None:
        return dialog_box
    return _threads_inline_compose_box(page)


def _threads_inline_compose_box(page):
    return _visible_first(page, [
        'textarea[placeholder*="thread" i]',
        'textarea[aria-label*="thread" i]',
        '[contenteditable="true"][aria-label*="thread" i]',
        '[role="textbox"][aria-label*="thread" i]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ], timeout_ms=1800)


def _threads_inline_compose_opener(page):
    return _visible_first(page, [
        '[contenteditable="true"][aria-placeholder*="What" i]',
        '[contenteditable="true"][aria-label*="What" i]',
        '[role="textbox"][aria-placeholder*="What" i]',
        '[role="textbox"][aria-label*="What" i]',
        '[contenteditable="true"][aria-placeholder*="新鮮事" i]',
        '[contenteditable="true"][aria-label*="新鮮事" i]',
        '[role="textbox"][aria-placeholder*="新鮮事" i]',
        '[role="textbox"][aria-label*="新鮮事" i]',
        '[contenteditable="true"][aria-label*="撰寫" i]',
        '[role="textbox"][aria-label*="撰寫" i]',
        '[contenteditable="true"][aria-label*="新貼文" i]',
        '[role="textbox"][aria-label*="新貼文" i]',
        '[contenteditable="true"][aria-label*="新帖子" i]',
        '[role="textbox"][aria-label*="新帖子" i]',
    ], timeout_ms=900)


def _threads_post_button(page):
    selectors = [
        '[role="dialog"] button:has-text("Post")',
        '[role="dialog"] [role="button"]:has-text("Post")',
        '[role="dialog"] button:has-text("发布")',
        '[role="dialog"] [role="button"]:has-text("发布")',
        '[role="dialog"] button:has-text("發佈")',
        '[role="dialog"] [role="button"]:has-text("發佈")',
        'button:has-text("Post")',
        '[role="button"]:has-text("Post")',
        'button:has-text("发布")',
        '[role="button"]:has-text("发布")',
        'button:has-text("發佈")',
        '[role="button"]:has-text("發佈")',
    ]
    return _visible_first(page, selectors, timeout_ms=1800)


def _threads_dialog_compose_box(page):
    return _visible_last(page, [
        '[role="dialog"] textarea',
        '[role="dialog"] [contenteditable="true"]',
        '[role="dialog"] [role="textbox"]',
    ], timeout_ms=800)


def _threads_dialog_post_button(page):
    return _visible_last(page, [
        '[role="dialog"] button:has-text("Post")',
        '[role="dialog"] [role="button"]:has-text("Post")',
        '[role="dialog"] button:has-text("发布")',
        '[role="dialog"] [role="button"]:has-text("发布")',
        '[role="dialog"] button:has-text("發佈")',
        '[role="dialog"] [role="button"]:has-text("發佈")',
    ], timeout_ms=800)


def _click_threads_compose_opener(page, locator, logger: AutomationLogger) -> bool:
    if _human_click(page, locator, logger, "threads_publish_open"):
        return True
    if _threads_dialog_compose_box(page) is not None:
        logger.log("debug", "threads_publish_open", "Threads 编辑器已在点击超时后正常打开，未重复触发入口。", {})
        return True
    try:
        locator.evaluate("node => node.click()")
        _sleep_between(0.8, 1.4)
        if _threads_dialog_compose_box(page) is not None:
            logger.log(
                "info",
                "threads_publish_open_dom_fallback",
                "The validated Threads sidebar composer entry opened through its DOM click fallback.",
                {},
            )
            return True
    except Exception:
        pass
    return False


def _threads_media_input(page):
    try:
        marked = page.evaluate(
            r"""() => {
                const marker = 'data-vecto-threads-media-input';
                document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));
                const isVisible = node => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);
                dialogs.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    const ac = Math.abs((ar.left + ar.right) / 2 - window.innerWidth / 2)
                        + Math.abs((ar.top + ar.bottom) / 2 - window.innerHeight / 2);
                    const bc = Math.abs((br.left + br.right) / 2 - window.innerWidth / 2)
                        + Math.abs((br.top + br.bottom) / 2 - window.innerHeight / 2);
                    return ac - bc;
                });
                const mediaInput = inputs => {
                    const candidates = Array.from(inputs).filter(node => {
                        const accept = String(node.getAttribute('accept') || '').toLowerCase();
                        return !accept || accept.includes('image') || accept.includes('video');
                    });
                    return candidates[candidates.length - 1] || null;
                };
                let target = dialogs.length
                    ? mediaInput(dialogs[0].querySelectorAll('input[type="file"]'))
                    : null;
                if (!target) {
                    target = mediaInput(document.querySelectorAll('input[type="file"]'));
                }
                if (!target) return false;
                target.setAttribute(marker, '1');
                return true;
            }"""
        )
    except Exception:
        marked = False
    if not marked:
        return None
    try:
        locator = page.locator('[data-vecto-threads-media-input="1"]').last
        return locator if locator.count() else None
    except Exception:
        return None


def _threads_attachment_snapshot(page) -> dict[str, int]:
    empty = {"preview_count": 0, "remove_control_count": 0, "selected_file_count": 0}
    try:
        result = page.evaluate(
            r"""() => {
                const isVisible = node => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);
                dialogs.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    const ac = Math.abs((ar.left + ar.right) / 2 - window.innerWidth / 2)
                        + Math.abs((ar.top + ar.bottom) / 2 - window.innerHeight / 2);
                    const bc = Math.abs((br.left + br.right) / 2 - window.innerWidth / 2)
                        + Math.abs((br.top + br.bottom) / 2 - window.innerHeight / 2);
                    return ac - bc;
                });
                const root = dialogs[0] || document.body;
                const previews = Array.from(root.querySelectorAll('img, video')).filter(node => {
                    if (!isVisible(node)) return false;
                    const rect = node.getBoundingClientRect();
                    const src = String(node.currentSrc || node.src || '').toLowerCase();
                    if (node.tagName === 'VIDEO' || src.startsWith('blob:')) return rect.width >= 72 && rect.height >= 72;
                    return rect.width >= 96 && rect.height >= 96;
                });
                const removePattern = /(remove|delete|discard).*(photo|image|video|media|attachment)|(photo|image|video|media|attachment).*(remove|delete|discard)/i;
                const removeControls = Array.from(root.querySelectorAll('button, [role="button"]')).filter(node => {
                    if (!isVisible(node)) return false;
                    const label = [
                        node.getAttribute('aria-label'),
                        node.getAttribute('title'),
                        node.innerText,
                        node.textContent,
                    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
                    return removePattern.test(label);
                });
                const selectedFileCount = Array.from(root.querySelectorAll('input[type="file"]'))
                    .reduce((total, node) => total + Number(node.files?.length || 0), 0);
                return {
                    preview_count: previews.length,
                    remove_control_count: removeControls.length,
                    selected_file_count: selectedFileCount,
                };
            }"""
        )
    except Exception:
        return empty
    if not isinstance(result, dict):
        return empty
    return {
        "preview_count": max(0, _safe_int(result.get("preview_count"), 0)),
        "remove_control_count": max(0, _safe_int(result.get("remove_control_count"), 0)),
        "selected_file_count": max(0, _safe_int(result.get("selected_file_count"), 0)),
    }


def _wait_for_threads_media_ready(
    page,
    logger: AutomationLogger,
    *,
    expected_files: int,
    baseline: dict[str, int] | None = None,
    timeout_seconds: float = 30.0,
) -> dict[str, int]:
    before = baseline or {}
    baseline_evidence = max(
        _safe_int(before.get("preview_count"), 0),
        _safe_int(before.get("remove_control_count"), 0),
    )
    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    last_snapshot = _threads_attachment_snapshot(page)
    while True:
        rendered_evidence = max(
            _safe_int(last_snapshot.get("preview_count"), 0),
            _safe_int(last_snapshot.get("remove_control_count"), 0),
        )
        if rendered_evidence > baseline_evidence:
            logger.log(
                "info",
                "threads_publish_upload_ready",
                "Threads media attachment preview is ready.",
                {"expected_files": expected_files, **last_snapshot},
            )
            return last_snapshot
        if time.monotonic() >= deadline:
            break
        _sleep_between(0.35, 0.55)
        last_snapshot = _threads_attachment_snapshot(page)
    logger.log(
        "error",
        "threads_publish_upload_not_ready",
        "Threads did not render the media attachment preview; publish was stopped before submit.",
        {"expected_files": expected_files, **last_snapshot},
    )
    raise RuntimeError("Threads media attachment preview did not become ready; publish was stopped before submit.")


def _dismiss_threads_compose_dialogs(page, logger: AutomationLogger) -> None:
    for attempt in range(5):
        try:
            visible_count = page.locator('[role="dialog"]').evaluate_all(
                """nodes => nodes.filter((node) => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                }).length"""
            )
            if not visible_count:
                return
        except Exception:
            return
        logger.log("debug", "threads_publish_cleanup", "正在清理残留 Threads 发帖弹窗。", {"attempt": attempt + 1, "dialogs": visible_count})
        with contextlib.suppress(Exception):
            page.evaluate(
                r"""() => {
                    const labels = ['Discard', 'Cancel', 'Close', '取消', '关闭'];
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).reverse();
                    for (const dialog of dialogs) {
                        const controls = Array.from(dialog.querySelectorAll('button, [role="button"], a, div, span')).reverse();
                        const target = controls.find((node) => {
                            const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                            return labels.some((label) => text.includes(label));
                        });
                        if (target) {
                            const clickable = target.closest('button, [role="button"], a') || target;
                            clickable.click();
                        }
                    }
                }"""
            )
        with contextlib.suppress(Exception):
            page.keyboard.press("Escape")
        _sleep_between(0.5, 0.9)


def _threads_compose_href_kind(href: str, page_url: str) -> str:
    raw = str(href or "").strip()
    if not raw:
        return "unknown"
    parsed = urlparse(urljoin(str(page_url or THREADS_HOME), raw))
    host = str(parsed.hostname or "").lower()
    if host not in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
        return "reject"
    path = str(parsed.path or "").rstrip("/").lower()
    query = str(parsed.query or "").lower()
    if path in {"/new", "/compose", "/intent/post"} or path.endswith("/new") or path.endswith("/compose"):
        return "compose"
    if "composer" in query or "compose" in query:
        return "compose"
    if path in {"", "/"} or path.startswith("/search") or path.startswith("/@") or path in {
        "/activity",
        "/notifications",
        "/login",
        "/explore",
    }:
        return "reject"
    return "unknown"


def _threads_sidebar_compose_opener(page):
    structured = _threads_compose_opener_by_structure(page)
    if structured is not None:
        return structured
    selectors = [
        'a[href]',
    ]
    try:
        viewport_width = float(page.evaluate("() => window.innerWidth") or 1920)
    except Exception:
        viewport_width = 1920.0
    left_edge_limit = max(320.0, viewport_width * 0.35)
    page_url = str(getattr(page, "url", "") or THREADS_HOME)
    best = None
    best_center_x = float("inf")
    for selector in selectors:
        try:
            group = page.locator(selector)
            total = min(int(group.count()), 128 if selector == 'a[href]' else 16)
        except Exception:
            continue
        for index in range(total):
            try:
                locator = group.nth(index)
                if not locator.is_visible(timeout=0):
                    continue
                href = str(locator.get_attribute("href", timeout=0) or "").strip()
                if not href:
                    clickable = locator.locator(
                        "xpath=ancestor-or-self::*[self::a or self::button or @role='button' or @role='link' or @tabindex='0'][1]"
                    )
                    if clickable.count() and clickable.is_visible(timeout=0):
                        locator = clickable
                        href = str(locator.get_attribute("href", timeout=0) or "").strip()
                href_kind = _threads_compose_href_kind(href, page_url)
                if href_kind == "reject":
                    continue
                if href and href_kind != "compose":
                    continue
                box = locator.bounding_box()
                if not box:
                    continue
                center_x = float(box.get("x") or 0) + float(box.get("width") or 0) / 2
                if href_kind != "compose" and (center_x > left_edge_limit or center_x >= best_center_x):
                    continue
                if href_kind == "compose" and best is not None and center_x >= best_center_x:
                    continue
                best = locator
                best_center_x = center_x
            except Exception:
                continue
    return best


def _threads_compose_opener_by_structure(page):
    try:
        marked = page.evaluate(
            """() => {
                document.querySelectorAll('[data-vecto-compose-opener]').forEach(node => node.removeAttribute('data-vecto-compose-opener'));
                const width = window.innerWidth || 0;
                const height = window.innerHeight || 0;
                const visible = node => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 16 && rect.height > 16
                        && style.visibility !== 'hidden'
                        && style.display !== 'none'
                        && style.pointerEvents !== 'none';
                };
                const hrefOf = node => String(node.getAttribute('href') || node.closest('a')?.getAttribute('href') || '');
                const pathOf = href => {
                    try {
                        return new URL(href, window.location.href).pathname.replace(/\\/+$/, '').toLowerCase();
                    } catch (error) {
                        return '';
                    }
                };
                const isSearchHref = href => {
                    const path = pathOf(href);
                    return path.startsWith('/search') || path === '/explore';
                };
                const leadingSvg = node => {
                    const rect = node.getBoundingClientRect();
                    const svgs = Array.from(node.querySelectorAll('svg')).filter(svg => {
                        const box = svg.getBoundingClientRect();
                        return box.width >= 10 && box.height >= 10 && box.left <= rect.left + 56;
                    });
                    return svgs[0] || null;
                };
                const svgPath = svg => Array.from(svg.querySelectorAll('path')).map(item => item.getAttribute('d') || '').join(' ');
                const isSearchIcon = svg => {
                    if (!svg) return false;
                    if (svg.querySelector('circle')) return true;
                    const d = svgPath(svg);
                    return /[aA]\\s*\\d{2,}/.test(d);
                };
                const isPlusIcon = svg => {
                    if (!svg || isSearchIcon(svg)) return false;
                    const lines = Array.from(svg.querySelectorAll('line'));
                    const horiz = lines.some(line => Math.abs(Number(line.getAttribute('y1')) - Number(line.getAttribute('y2'))) <= 1);
                    const vert = lines.some(line => Math.abs(Number(line.getAttribute('x1')) - Number(line.getAttribute('x2'))) <= 1);
                    if (horiz && vert) return true;
                    const d = svgPath(svg);
                    const hasH = /[hH]/.test(d);
                    const hasV = /[vV]/.test(d);
                    const hasCrossBars = hasH && hasV;
                    const simple = d.length > 0 && d.length < 280;
                    return simple && hasCrossBars;
                };
                const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [tabindex="0"]')).filter(visible);
                const leftRows = [];
                for (const node of nodes) {
                    const rect = node.getBoundingClientRect();
                    if (rect.left > Math.min(280, width * 0.24) || rect.top < 84 || rect.top > height * 0.70) continue;
                    if (rect.height < 32 || rect.height > 58 || rect.width < 32 || rect.width > 360) continue;
                    if (isSearchHref(hrefOf(node))) continue;
                    const last = leftRows[leftRows.length - 1];
                    if (last && Math.abs(last.y - rect.top) < 12) {
                        if (rect.width > last.rect.width) {
                            last.node = node;
                            last.rect = rect;
                            last.y = rect.top;
                        }
                        continue;
                    }
                    leftRows.push({ node, rect, y: rect.top });
                }
                leftRows.sort((a, b) => a.y - b.y);
                if (leftRows.length < 3) return '';
                const composeRow = leftRows[1];
                const composeSvg = leadingSvg(composeRow.node);
                if (isSearchIcon(composeSvg)) return '';
                const clickTarget = composeSvg || composeRow.node;
                clickTarget.setAttribute('data-vecto-compose-opener', '1');
                return 'left-rail-2';
            }"""
        )
    except Exception:
        marked = ""
    if not marked:
        return None
    try:
        group = page.locator('[data-vecto-compose-opener="1"]')
        if not group.count():
            return None
        locator = group.first
        return locator if locator.is_visible(timeout=800) else None
    except Exception:
        return None


def _ensure_threads_compose_ready(
    page,
    logger: AutomationLogger,
    *,
    _home_recovery_attempted: bool = False,
):
    compose = _threads_dialog_compose_box(page)
    if compose is not None:
        return compose
    sidebar_opener = _threads_sidebar_compose_opener(page)
    if sidebar_opener is not None:
        box = None
        with contextlib.suppress(Exception):
            box = sidebar_opener.bounding_box()
        logger.log(
            "info",
            "threads_publish_open_target",
            "将点击左侧栏第 2 项发帖加号。",
            {
                "x": None if not box else round(float(box.get("x") or 0) + float(box.get("width") or 0) / 2, 1),
                "y": None if not box else round(float(box.get("y") or 0) + float(box.get("height") or 0) / 2, 1),
            },
        )
        _click_threads_compose_opener(page, sidebar_opener, logger)
        _sleep_between(0.8, 1.6)
        compose = _threads_dialog_compose_box(page)
        if compose is not None:
            return compose
        logger.log(
            "warn",
            "threads_publish_open_no_dialog",
            "已点击识别到的发帖入口，但编辑框未出现，不再刷新页面。",
            {"url": _safe_navigation_url(getattr(page, "url", ""))},
        )
        raise RuntimeError("已点击发帖入口，但未打开输入框。")
    if not _home_recovery_attempted:
        logger.log(
            "warn",
            "threads_publish_open_retry",
            "尚未识别到左侧加号发帖图标，等待页面稳定后只再识别一次，不会刷新主页。",
            {"url": _safe_navigation_url(getattr(page, "url", ""))},
        )
        _sleep_between(0.8, 1.2)
        return _ensure_threads_compose_ready(
            page,
            logger,
            _home_recovery_attempted=True,
        )
    raise RuntimeError("无法点击打开 Threads 发帖输入框。")


def _focus_threads_compose(page, compose, logger: AutomationLogger):
    current = compose
    last_error = ""
    for attempt in range(2):
        try:
            if _human_click(page, current, logger, "threads_publish_focus"):
                return current
            last_error = "compose click was not actionable"
        except Exception as exc:
            last_error = str(exc)
        if attempt == 0:
            logger.log(
                "warn",
                "threads_publish_focus_retry",
                "Threads composer changed during page rendering; reacquiring the active dialog input once.",
                {"error": last_error[:500]},
            )
            _sleep_between(0.35, 0.65)
            current = _threads_dialog_compose_box(page)
            if current is None:
                current = _ensure_threads_compose_ready(page, logger)
    raise RuntimeError(f"Threads 发帖输入框无法稳定聚焦：{last_error}")


def _normalize_threads_post_permalink(value: Any) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    parsed = urlparse(urljoin(THREADS_HOME, raw_url))
    host = str(parsed.hostname or "").lower()
    if host not in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
        return ""
    path = str(parsed.path or "").rstrip("/")
    if re.fullmatch(r"/t/[^/\s]+", path, flags=re.IGNORECASE):
        return f"https://www.threads.net{path}"
    if not re.fullmatch(r"/@[^/\s]+/(?:post|thread)/[^/\s]+", path, flags=re.IGNORECASE):
        return ""
    return f"https://www.threads.net{path}"


def _is_threads_short_permalink(value: Any) -> bool:
    path = str(urlparse(_normalize_threads_post_permalink(value)).path or "")
    return bool(re.fullmatch(r"/t/[^/\s]+", path, flags=re.IGNORECASE))


def _threads_post_identity(value: Any) -> str:
    path = str(urlparse(_normalize_threads_post_permalink(value)).path or "").rstrip("/")
    parts = [part for part in path.split("/") if part]
    if len(parts) >= 2 and parts[0].lower() == "t":
        return parts[1].lower()
    if len(parts) >= 3 and parts[1].lower() in {"post", "thread"}:
        return parts[2].lower()
    return ""


def _dedupe_threads_permalinks(values: Iterable[Any]) -> list[str]:
    chosen: dict[str, str] = {}
    order: list[str] = []
    for value in values:
        permalink = _normalize_threads_post_permalink(value)
        ident = _threads_post_identity(permalink)
        if not permalink or not ident:
            continue
        existing = chosen.get(ident)
        if existing is None:
            chosen[ident] = permalink
            order.append(ident)
            continue
        if _is_threads_short_permalink(existing) and not _is_threads_short_permalink(permalink):
            chosen[ident] = permalink
    return [chosen[ident] for ident in order]


def _threads_permalink_in_baseline(permalink: str, baseline_permalinks: set[str]) -> bool:
    ident = _threads_post_identity(permalink)
    if ident and any(_threads_post_identity(item) == ident for item in baseline_permalinks):
        return True
    return _normalize_threads_post_permalink(permalink) in baseline_permalinks


def _threads_publish_session_permalinks(context_control: dict[str, Any] | None) -> set[str]:
    if not isinstance(context_control, dict):
        return set()
    values = context_control.get("threads_publish_session_permalinks")
    if not isinstance(values, (set, list, tuple)):
        return set()
    return {
        permalink
        for value in values
        if (permalink := _normalize_threads_post_permalink(value))
    }


def _remember_threads_publish_permalink(context_control: dict[str, Any] | None, value: Any) -> None:
    if not isinstance(context_control, dict):
        return
    permalink = _normalize_threads_post_permalink(value)
    if not permalink:
        return
    known = _threads_publish_session_permalinks(context_control)
    known.add(permalink)
    context_control["threads_publish_session_permalinks"] = known


def _find_threads_post_permalink(page, caption: str) -> str:
    current_url = _normalize_threads_post_permalink(getattr(page, "url", ""))
    if current_url:
        return current_url
    normalized_caption = " ".join(str(caption or "").split())
    if not normalized_caption:
        return ""
    try:
        candidate = page.evaluate(
            r"""caption => {
                const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
                const compact = value => normalize(value).replace(/\s+/g, '');
                const isPostHref = href => /\/@[^/]+\/(?:post|thread)\/[^/?#]+/i.test(href) || /\/t\/[^/?#]+/i.test(href);
                const hrefOf = node => node.href || node.getAttribute('href') || '';
                const normalizedCaption = normalize(caption);
                const compactCaption = compact(caption);
                const firstLine = normalizedCaption.split('\n')[0] || '';
                const probes = [
                    firstLine.slice(0, 48),
                    normalizedCaption.slice(0, 48),
                    compactCaption.slice(0, 32),
                    firstLine.slice(0, 24),
                    normalizedCaption.slice(0, 24),
                ].filter(value => value.length >= 8);
                const containsCaption = value => {
                    const normalizedValue = normalize(value);
                    const compactValue = compact(value);
                    return Boolean(normalizedCaption) && (
                        normalizedValue.includes(normalizedCaption)
                        || probes.some(probe => normalizedValue.includes(probe) || compactValue.includes(probe))
                    );
                };
                const postLinks = Array.from(document.querySelectorAll('a[href]')).filter(link => isPostHref(hrefOf(link)));
                for (const postLink of postLinks) {
                    let root = postLink;
                    for (let depth = 0; root && root !== document.body && depth < 12; depth += 1, root = root.parentElement) {
                        const localLinks = Array.from(root.querySelectorAll('a[href]')).filter(link => isPostHref(hrefOf(link)));
                        const uniqueLocalLinks = new Set(localLinks.map(hrefOf));
                        if (uniqueLocalLinks.size === 1 && containsCaption(root.innerText || root.textContent)) {
                            return hrefOf(postLink);
                        }
                    }
                }
                return '';
            }""",
            normalized_caption,
        )
    except Exception:
        return ""
    return _normalize_threads_post_permalink(candidate)


def _find_latest_threads_post_permalink(page) -> str:
    permalinks = _find_threads_post_permalinks(page)
    return permalinks[0] if permalinks else ""


def _find_threads_post_permalinks(page) -> list[str] | None:
    current_url = _normalize_threads_post_permalink(getattr(page, "url", ""))
    if current_url:
        return [current_url]
    try:
        candidates = page.evaluate(
            r"""() => {
                const isPostHref = href => /\/@[^/]+\/(?:post|thread)\/[^/?#]+/i.test(href) || /\/t\/[^/?#]+/i.test(href);
                const hrefOf = node => node.href || node.getAttribute('href') || '';
                const found = [];
                const push = href => {
                    if (href && isPostHref(href) && !found.includes(href)) found.push(href);
                };
                const cards = Array.from(document.querySelectorAll('article, [role="article"]'));
                for (const card of cards) {
                    const timeLink = card.querySelector('time')?.closest('a[href], [role="link"][href]');
                    if (timeLink) push(hrefOf(timeLink));
                    Array.from(card.querySelectorAll('a[href]')).forEach(link => push(hrefOf(link)));
                }
                Array.from(document.querySelectorAll('time')).forEach((node) => {
                    const link = node.closest('a[href], [role="link"][href]');
                    if (link) push(hrefOf(link));
                });
                Array.from(document.querySelectorAll('a[href]')).forEach(link => push(hrefOf(link)));
                return found;
            }"""
        )
    except Exception:
        return None
    permalinks: list[str] = []
    for candidate in candidates if isinstance(candidates, list) else []:
        permalink = _normalize_threads_post_permalink(candidate)
        if permalink and permalink not in permalinks:
            permalinks.append(permalink)
    return permalinks


def _click_newest_unconfirmed_profile_post(
    page,
    logger: AutomationLogger,
    profile_url: str,
    baseline_permalinks: set[str],
) -> bool:
    baseline_ids = [
        ident
        for ident in (_threads_post_identity(item) for item in baseline_permalinks)
        if ident
    ]
    try:
        marked = page.evaluate(
            r"""baselineIds => {
                document.querySelectorAll('[data-vecto-confirm-target]').forEach((node) => node.removeAttribute('data-vecto-confirm-target'));
                const known = new Set((baselineIds || []).map((value) => String(value || '').toLowerCase()).filter(Boolean));
                const isPostHref = href => /\/@[^/]+\/(?:post|thread)\/[^/?#]+/i.test(href) || /\/t\/[^/?#]+/i.test(href);
                const hrefOf = node => node.href || node.getAttribute('href') || '';
                const identOf = href => {
                    const match = String(href || '').match(/\/(?:post|thread|t)\/([^/?#]+)/i);
                    return match ? String(match[1] || '').toLowerCase() : '';
                };
                const cards = Array.from(document.querySelectorAll('article, [role="article"]'));
                for (const card of cards) {
                    const timeNode = card.querySelector('time');
                    if (!timeNode) continue;
                    const hrefs = Array.from(card.querySelectorAll('a[href]')).map(hrefOf).filter(isPostHref);
                    if (hrefs.some((href) => known.has(identOf(href)))) continue;
                    const clickable = timeNode.closest('a, [role="link"], button')
                        || card.querySelector('header a[href], header [role="link"], a[href]')
                        || timeNode;
                    const style = window.getComputedStyle(clickable);
                    const rect = clickable.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
                    clickable.scrollIntoView({block: 'center', inline: 'center'});
                    clickable.setAttribute('data-vecto-confirm-target', '1');
                    return true;
                }
                return false;
            }""",
            baseline_ids,
        )
    except Exception as exc:
        logger.log("debug", "threads_publish_confirm_card", "无法按结构定位新帖卡片。", {"error": str(exc)[:300]})
        return False
    if marked is not True:
        return False
    try:
        target = page.locator('[data-vecto-confirm-target="1"]').first
        return bool(_human_click(page, target, logger, "threads_publish_confirm_card"))
    except Exception:
        return False


def _threads_permalink_belongs_to_profile(permalink: str, profile_url: str, *, current_url: str = "") -> bool:
    post = urlparse(_normalize_threads_post_permalink(permalink))
    profile = urlparse(_normalize_threads_profile_url(profile_url))
    post_path = str(post.path or "")
    if re.fullmatch(r"/t/[^/\s]+", post_path, flags=re.IGNORECASE):
        current_profile = _normalize_threads_profile_url(current_url)
        expected_profile = _normalize_threads_profile_url(profile_url)
        return bool(current_profile and expected_profile and current_profile == expected_profile)
    post_match = re.match(r"^/(@[^/]+)/", post_path, flags=re.IGNORECASE)
    profile_match = re.match(r"^/(@[^/]+)$", str(profile.path or ""), flags=re.IGNORECASE)
    return bool(post_match and profile_match and post_match.group(1).lower() == profile_match.group(1).lower())


def _wait_for_threads_publish_success(
    page,
    logger: AutomationLogger,
    *,
    caption: str = "",
    profile_url: str = "",
    previous_permalinks: set[str] | None = None,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started_at = time.time()
    deadline = started_at + 90
    saw_dialog = False
    dialog_closed_at: float | None = None
    baseline = {
        normalized
        for value in (previous_permalinks or set())
        if (normalized := _normalize_threads_post_permalink(value))
    }
    baseline_known = previous_permalinks is not None
    while time.time() < deadline:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            _set_manual_takeover_waiting_for(context_control, "threads_confirmation")
        try:
            permalink = _normalize_threads_post_permalink(page.url)
            own_permalink = bool(permalink) and (
                not profile_url
                or _is_threads_short_permalink(permalink)
                or _threads_permalink_belongs_to_profile(permalink, profile_url, current_url=str(getattr(page, "url", "") or ""))
            )
            if own_permalink and (not baseline_known or permalink not in baseline):
                return {"confirmed": True, "submitted": True, "reason": "已检测到 Threads 帖子链接。", "url": permalink}
        except Exception:
            pass
        dialog_compose = _threads_dialog_compose_box(page)
        dialog_post_button = _threads_dialog_post_button(page)
        if dialog_compose is not None or dialog_post_button is not None:
            saw_dialog = True
            dialog_closed_at = None
        elif saw_dialog and dialog_closed_at is None:
            dialog_closed_at = time.time()
        watch_started_at = dialog_closed_at if dialog_closed_at is not None else (started_at if not saw_dialog else None)
        if watch_started_at is not None and time.time() >= watch_started_at + THREADS_POST_SUBMIT_WATCH_SECONDS:
            return {"confirmed": False, "submitted": True, "reason": "Threads 编辑器已关闭，仍需帖子链接确认。", "url": ""}
        _wait_for_cancellation(random.uniform(1.4, 2.2), cancel_event)
    logger.log("warn", "threads_publish_confirm", "等待 Threads 发布确认超时。", {"url": str(page.url or "")})
    return {"confirmed": False, "submitted": False, "reason": "等待 Threads 发布确认超时。", "url": ""}


def _threads_active_dialog_text(page) -> str:
    try:
        return str(
            page.locator('[role="dialog"]').evaluate_all(
                """nodes => {
                    const visible = nodes.filter((node) => {
                        const rect = node.getBoundingClientRect();
                        const style = window.getComputedStyle(node);
                        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                    });
                    if (!visible.length) return '';
                    visible.sort((a, b) => {
                        const ar = a.getBoundingClientRect();
                        const br = b.getBoundingClientRect();
                        const ac = Math.abs((ar.left + ar.right) / 2 - window.innerWidth / 2) + Math.abs((ar.top + ar.bottom) / 2 - window.innerHeight / 2);
                        const bc = Math.abs((br.left + br.right) / 2 - window.innerWidth / 2) + Math.abs((br.top + br.bottom) / 2 - window.innerHeight / 2);
                        return ac - bc;
                    });
                    return visible[0].innerText || visible[0].textContent || '';
                }"""
            )
            or ""
        )
    except Exception:
        return ""


def _click_threads_active_dialog_post(page, logger: AutomationLogger, before_click: Callable[[], None] | None = None) -> bool:
    try:
        submit_labels = [
            "Post",
            "发布",
            "發佈",
            "发帖",
            "發文",
            "分享",
        ]
        marked = page.evaluate(
            r"""labels => {
                document.querySelectorAll('[data-vecto-publish-target]').forEach(node => node.removeAttribute('data-vecto-publish-target'));
                const normalizedLabels = new Set((labels || []).map(label => String(label || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
                const visible = Array.from(document.querySelectorAll('[role="dialog"]')).filter((node) => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                });
                if (!visible.length) return false;
                visible.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    const ac = Math.abs((ar.left + ar.right) / 2 - window.innerWidth / 2) + Math.abs((ar.top + ar.bottom) / 2 - window.innerHeight / 2);
                    const bc = Math.abs((br.left + br.right) / 2 - window.innerWidth / 2) + Math.abs((br.top + br.bottom) / 2 - window.innerHeight / 2);
                    return ac - bc;
                });
                const dialog = visible[0];
                const dialogRect = dialog.getBoundingClientRect();
                const controls = Array.from(dialog.querySelectorAll('button, [role="button"], div, span')).reverse();
                let geometricFallback = null;
                for (const node of controls) {
                    const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                    const clickable = node.closest('button, [role="button"]') || node;
                    const style = window.getComputedStyle(clickable);
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') continue;
                    const rect = clickable.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    if (normalizedLabels.has(text)) {
                        clickable.scrollIntoView({block: 'center', inline: 'center'});
                        clickable.setAttribute('data-vecto-publish-target', '1');
                        return true;
                    }
                    const lowerHalf = rect.top >= dialogRect.top + dialogRect.height * 0.45;
                    const rightSide = rect.left >= dialogRect.left + dialogRect.width * 0.45;
                    const hasActionSize = rect.width >= 44 && rect.height >= 28;
                    const looksLikeSubmit = lowerHalf && rightSide && hasActionSize && text && !/[×x]|close|cancel|取消/i.test(text);
                    if (!geometricFallback && looksLikeSubmit) {
                        geometricFallback = clickable;
                    }
                }
                if (geometricFallback) {
                    geometricFallback.scrollIntoView({block: 'center', inline: 'center'});
                    geometricFallback.setAttribute('data-vecto-publish-target', '1');
                    geometricFallback.setAttribute('data-vecto-publish-target-source', 'geometry');
                    return true;
                }
                for (const node of controls) {
                    const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                    const clickable = node.closest('button, [role="button"]') || node;
                    const style = window.getComputedStyle(clickable);
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') continue;
                    const rect = clickable.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    const lowerHalf = rect.top >= dialogRect.top + dialogRect.height * 0.45;
                    const rightSide = rect.left >= dialogRect.left + dialogRect.width * 0.45;
                    const iconSubmit = lowerHalf && rightSide && rect.width >= 28 && rect.height >= 28 && !text;
                    if (!iconSubmit) continue;
                    clickable.scrollIntoView({block: 'center', inline: 'center'});
                    clickable.setAttribute('data-vecto-publish-target', '1');
                    clickable.setAttribute('data-vecto-publish-target-source', 'icon-geometry');
                    return true;
                }
                return false;
            }""",
            submit_labels,
        )
    except Exception as exc:
        logger.log("warn", "threads_publish_submit_dom_failed", "无法定位当前弹窗的发布按钮，尚未执行点击。", {"error": str(exc)[:500]})
        raise RuntimeError("Unable to locate the active Threads publish button before submit.") from exc
    if not marked:
        return False
    if callable(before_click):
        before_click()
    try:
        target = page.locator('[data-vecto-publish-target="1"]').first
        if not _human_click(page, target, logger, "threads_publish_submit"):
            return False
        logger.log("debug", "threads_publish_submit", "已点击当前 Threads 弹窗内的发布按钮。", {})
        return True
    except Exception as exc:
        logger.log("warn", "threads_publish_submit_click_uncertain", "发布按钮点击期间页面已变化，将仅检查发布结果。", {"error": str(exc)[:500]})
        raise PublishClickUncertainError("Threads publish click may have completed while the page was navigating.") from exc


def _threads_profile_url(account: dict[str, Any] | None) -> str:
    username = str((account or {}).get("username") or (account or {}).get("login_username") or "").strip().lstrip("@")
    return f"https://www.threads.net/@{username}" if username else THREADS_HOME


def _normalize_threads_profile_url(value: Any) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    parsed = urlparse(urljoin(THREADS_HOME, raw_url))
    host = str(parsed.hostname or "").lower()
    path = str(parsed.path or "").rstrip("/")
    if host not in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
        return ""
    if not re.fullmatch(r"/@[^/\s]+", path):
        return ""
    return f"https://www.threads.net{path}"


def _resolve_threads_profile_url(page, account: dict[str, Any] | None = None) -> str:
    try:
        candidate = page.evaluate(
            r"""() => {
                const links = Array.from(document.querySelectorAll('a[href]'));
                const profileLabels = /^(profile|个人资料|個人檔案|个人主页|個人主頁)$/i;
                const hrefOf = link => link.href || link.getAttribute('href') || '';
                const isProfileHref = link => /\/@[^/?#]+\/?(?:[?#].*)?$/i.test(hrefOf(link));
                const labelled = links.find(link => {
                    const label = String(link.getAttribute('aria-label') || link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim();
                    return profileLabels.test(label) && isProfileHref(link);
                });
                if (labelled) return hrefOf(labelled);
                const navigationLinks = links.filter(link => link.closest('nav, [role="navigation"]'));
                return hrefOf(navigationLinks.find(isProfileHref) || links.find(isProfileHref));
            }"""
        )
        resolved = _normalize_threads_profile_url(candidate)
        if resolved:
            return resolved
    except Exception:
        pass
    return _threads_profile_url(account)


def _wait_for_threads_own_post(
    page,
    caption: str,
    logger: AutomationLogger,
    account: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    previous_permalink: str = "",
    profile_url: str = "",
    previous_permalinks: set[str] | None = None,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _raise_if_cancelled(cancel_event)
    if _manual_takeover_requested(context_control):
        _set_manual_takeover_waiting_for(context_control, "threads_confirmation")
    _dismiss_threads_compose_dialogs(page, logger)
    target_url = _normalize_threads_profile_url(profile_url) or _resolve_threads_profile_url(page, account)
    # Threads can render a just-submitted media post on the profile noticeably later
    # than a text-only post. Keep polling long enough to observe the permalink before
    # ending automatic confirmation, without retrying the publish action.
    confirm_seconds = _safe_int((payload or {}).get("profile_confirm_seconds") or os.getenv("SOCIAL_AUTOMATION_THREADS_PROFILE_CONFIRM_SECONDS"), 150)
    confirm_seconds = max(30, min(confirm_seconds, 300))
    nav_timeout_ms = max(5000, min(confirm_seconds * 1000, 20000))
    refresh_limit = _safe_int((payload or {}).get("profile_confirm_refreshes") or os.getenv("SOCIAL_AUTOMATION_THREADS_PROFILE_CONFIRM_REFRESHES"), 2)
    refresh_limit = max(0, min(refresh_limit, 3))
    normalized_previous = _normalize_threads_post_permalink(previous_permalink)
    baseline_known = previous_permalinks is not None or bool(normalized_previous)
    baseline_permalinks = {
        normalized
        for value in (previous_permalinks or set()) | ({previous_permalink} if previous_permalink else set())
        if (normalized := _normalize_threads_post_permalink(value))
    }
    _set_task_assistance(
        context_control,
        title="正在校验发布结果",
        message="帖子已提交，正在确认链接并保存截图。",
        content=caption,
    )
    current_permalink = _normalize_threads_post_permalink(getattr(page, "url", ""))
    if (
        baseline_known
        and current_permalink
        and current_permalink not in baseline_permalinks
        and (
            _is_threads_short_permalink(current_permalink)
            or _threads_permalink_belongs_to_profile(current_permalink, target_url)
        )
    ):
        return {"confirmed": True, "reason": "提交后当前页已是本次发布帖子。", "url": current_permalink}
    try:
        _raise_if_cancelled(cancel_event)
        _goto(page, target_url, logger, "threads_publish_profile", timeout_ms=nav_timeout_ms, networkidle_ms=2500)
    except Exception as exc:
        _raise_if_cancelled(cancel_event)
        logger.log("warn", "threads_publish_profile_open_slow", "提交后打开账号主页超时，将继续轮询确认发布结果。", {"error": str(exc)[:500], "timeout_ms": nav_timeout_ms})
    started_at = time.monotonic()
    deadline = started_at + confirm_seconds
    attempt = 0
    refresh_count = 0
    current_page_url = str(getattr(page, "url", "") or "")
    while True:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            _set_manual_takeover_waiting_for(context_control, "threads_confirmation")
        now = time.monotonic()
        if now >= deadline:
            break
        attempt += 1
        current_page_url = str(getattr(page, "url", "") or current_page_url)
        current_permalinks = _dedupe_threads_permalinks(_find_threads_post_permalinks(page) or [])
        new_own_permalinks = [
            candidate
            for candidate in current_permalinks
            if not _threads_permalink_in_baseline(candidate, baseline_permalinks)
            and _threads_permalink_belongs_to_profile(candidate, target_url, current_url=current_page_url)
        ]
        permalink = new_own_permalinks[0] if new_own_permalinks else ""
        if not permalink and baseline_known and _click_newest_unconfirmed_profile_post(
            page, logger, target_url, baseline_permalinks
        ):
            _wait_for_cancellation(0.8, cancel_event)
            opened = _normalize_threads_post_permalink(getattr(page, "url", ""))
            if (
                opened
                and not _threads_permalink_in_baseline(opened, baseline_permalinks)
                and (
                    _is_threads_short_permalink(opened)
                    or _threads_permalink_belongs_to_profile(opened, target_url)
                )
            ):
                permalink = opened
                logger.log(
                    "info",
                    "threads_publish_confirm_card",
                    "已按帖子卡片结构打开本次新帖。",
                    {"url": permalink, "attempt": attempt},
                )
            else:
                current_permalinks = _dedupe_threads_permalinks(_find_threads_post_permalinks(page) or [])
                new_own_permalinks = [
                    candidate
                    for candidate in current_permalinks
                    if not _threads_permalink_in_baseline(candidate, baseline_permalinks)
                    and _threads_permalink_belongs_to_profile(candidate, target_url, current_url=str(getattr(page, "url", "") or current_page_url))
                ]
                permalink = new_own_permalinks[0] if new_own_permalinks else ""
        if attempt == 1 or attempt % 5 == 0:
            _set_task_assistance(
                context_control,
                title="正在校验发布结果",
                message=f"帖子已提交，正在确认链接并保存截图（第 {attempt} 次检查）。",
                content=caption,
            )
            logger.log(
                "info",
                "threads_publish_confirm_progress",
                "正在校验发布结果。",
                {
                    "attempt": attempt,
                    "new_permalinks": len(new_own_permalinks),
                    "known_permalinks": len(current_permalinks),
                    "urls": new_own_permalinks[:4],
                },
            )
        if baseline_known and permalink:
            return {"confirmed": True, "reason": "已在账号主页定位到本次发布帖子的链接。", "url": permalink}
        refresh_due = refresh_count < refresh_limit and (
            refresh_count == 0
            or now - started_at >= ((refresh_count + 1) * confirm_seconds / (refresh_limit + 1))
        )
        if refresh_due:
            refresh_count += 1
            logger.log(
                "info",
                "threads_publish_profile_refresh",
                "账号主页尚未看到新帖，正在刷新一次。",
                {"attempt": attempt, "refresh": refresh_count},
            )
            try:
                _raise_if_cancelled(cancel_event)
                page.reload(wait_until="commit", timeout=min(nav_timeout_ms, 5000))
            except Exception as exc:
                _raise_if_cancelled(cancel_event)
                logger.log("debug", "threads_publish_profile_refresh", "账号主页刷新未完成，将继续确认发布结果。", {"error": str(exc)[:500]})
            continue
        _wait_for_cancellation(random.uniform(1.8, 2.6), cancel_event)
    return {"confirmed": False, "reason": "发布已提交，但账号主页未看到本次发布内容。", "url": str(page.url or target_url)}


def _dismiss_threads_cookie_consent(page, logger: AutomationLogger) -> bool:
    marker = "allow the use of cookies from threads"
    if marker not in _page_body_text_lower(page, timeout_ms=1500):
        return True
    for _attempt in range(2):
        clicked = _click_text_button(
            page,
            logger,
            ["Decline optional cookies", "Allow all cookies"],
            "threads_cookie_consent",
        )
        if not clicked:
            break
        _sleep_between(0.5, 0.9)
        if marker not in _page_body_text_lower(page, timeout_ms=1500):
            return True
    return marker not in _page_body_text_lower(page, timeout_ms=1500)


def _threads_publish_evidence_url_matches(page, permalink: str) -> bool:
    expected_url = _normalize_threads_post_permalink(permalink)
    raw_url = str(getattr(page, "url", "") or "")
    current_url = _normalize_threads_post_permalink(raw_url)
    if not expected_url:
        return False
    if current_url == expected_url:
        return True
    if current_url and _threads_post_identity(current_url) == _threads_post_identity(expected_url):
        return True
    if _is_threads_short_permalink(expected_url) and current_url and not _is_threads_short_permalink(current_url):
        return True
    post_id = _threads_post_identity(expected_url)
    lowered = raw_url.lower()
    return bool(post_id and post_id.lower() in lowered and re.search(r"/(?:post|thread|t)/", lowered))


def _threads_publish_evidence_overlay_ready(page, permalink: str) -> bool:
    post_id = _threads_post_identity(permalink)
    if not post_id:
        return False
    try:
        return bool(
            page.evaluate(
                """postId => {
                    const needle = String(postId || '').toLowerCase();
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((node) => {
                        const rect = node.getBoundingClientRect();
                        const style = window.getComputedStyle(node);
                        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                    });
                    return dialogs.some((dialog) => {
                        const hrefs = Array.from(dialog.querySelectorAll('a[href]')).map((link) => String(link.href || '').toLowerCase());
                        return hrefs.some((href) => href.includes(needle) && /\\/(?:post|thread|t)\\//.test(href));
                    });
                }""",
                post_id,
            )
        )
    except Exception:
        return False


def _click_threads_confirmed_post(page, permalink: str, logger: AutomationLogger) -> bool:
    post_id = _threads_post_identity(permalink)
    if not post_id:
        return False
    try:
        marked = page.evaluate(
            """postId => {
                document.querySelectorAll('[data-vecto-evidence-target]').forEach((node) => node.removeAttribute('data-vecto-evidence-target'));
                const needle = String(postId || '').toLowerCase();
                const links = Array.from(document.querySelectorAll('a[href]'));
                const hit = links.find((link) => {
                    const href = String(link.href || link.getAttribute('href') || '').toLowerCase();
                    return href.includes(needle) && /\\/(?:post|thread|t)\\//.test(href);
                });
                if (!hit) return false;
                const clickable = hit.closest('a, [role="link"]') || hit;
                clickable.scrollIntoView({block: 'center', inline: 'center'});
                clickable.setAttribute('data-vecto-evidence-target', '1');
                return true;
            }""",
            post_id,
        )
    except Exception as exc:
        logger.log("debug", "threads_publish_result_open", "无法在当前页定位已确认的帖子链接。", {"error": str(exc)[:300]})
        return False
    if marked is not True:
        return False
    try:
        target = page.locator('[data-vecto-evidence-target="1"]').first
        return bool(_human_click(page, target, logger, "threads_publish_result_open"))
    except Exception:
        return False


def _threads_publish_evidence_page_ready(page, permalink: str) -> bool:
    expected_url = _normalize_threads_post_permalink(permalink)
    if not expected_url:
        return False
    url_matches = _threads_publish_evidence_url_matches(page, permalink)
    overlay_ready = False if url_matches else _threads_publish_evidence_overlay_ready(page, permalink)
    if not url_matches and not overlay_ready:
        return False
    try:
        body_text = " ".join(str(page.locator("body").inner_text(timeout=1500) or "").lower().split())
    except Exception:
        return False
    if not body_text:
        return False
    blocked_markers = (
        "allow the use of cookies from threads",
        "log in or sign up for threads",
        "continue with instagram",
        "page isn't available",
        "this content isn't available",
    )
    return not any(marker in body_text for marker in blocked_markers)


def _capture_threads_publish_evidence(page, permalink: str, caption: str, screenshot_dir: Path, task: dict[str, Any], logger: AutomationLogger) -> str:
    last_error = ""

    def take_ready_screenshot() -> str:
        if not _dismiss_threads_cookie_consent(page, logger):
            return ""
        if not _threads_publish_evidence_page_ready(page, permalink):
            return ""
        _sleep_between(0.3, 0.6)
        return _screenshot(page, screenshot_dir, task, "publish_done", logger)

    screenshot = take_ready_screenshot()
    if screenshot:
        return screenshot
    if _click_threads_confirmed_post(page, permalink, logger):
        _sleep_between(0.5, 0.8)
        screenshot = take_ready_screenshot()
        if screenshot:
            return screenshot
    try:
        _goto(page, permalink, logger, "threads_publish_result", timeout_ms=12000, networkidle_ms=1500)
        _sleep_between(0.4, 0.7)
        if _click_threads_confirmed_post(page, permalink, logger):
            _sleep_between(0.5, 0.8)
        screenshot = take_ready_screenshot()
        if screenshot:
            return screenshot
        last_error = "Threads did not remain on the confirmed published-post page."
    except Exception as exc:
        last_error = str(exc)
    logger.log(
        "warn",
        "publish_evidence_not_ready",
        "发布已确认，但帖子页未稳定，未保存首页或异常页截图。",
        {
            "url": permalink,
            "current_url": str(getattr(page, "url", "") or ""),
            "error": last_error[:500],
        },
    )
    return ""


def _capture_threads_profile_baseline(
    page,
    profile_url: str,
    logger: AutomationLogger,
    *,
    skip: bool = False,
) -> set[str] | None:
    if skip:
        logger.log(
            "debug",
            "threads_publish_preview_baseline_skipped",
            "Preview-only publish test skipped permalink baseline because submit is disabled.",
            {},
        )
        return set()
    if not profile_url:
        return None
    last_error = ""
    last_permalinks: list[str] | None = None
    last_login_status = ""
    observed_permalinks: set[str] = set()
    successful_reads = 0
    for attempt in range(3):
        try:
            _goto(page, profile_url, logger, "threads_publish_baseline", timeout_ms=12000, networkidle_ms=1500)
        except Exception as exc:
            last_error = str(exc)
        try:
            expected_profile = _normalize_threads_profile_url(profile_url)
            current_profile = _normalize_threads_profile_url(getattr(page, "url", ""))
            if not expected_profile or current_profile != expected_profile:
                raise RuntimeError(last_error or "Threads profile navigation did not reach the expected account.")
            permalinks = _find_threads_post_permalinks(page)
            last_permalinks = permalinks
            if permalinks is not None:
                successful_reads += 1
            if permalinks:
                observed_permalinks.update(permalinks)
                if successful_reads >= 2:
                    return observed_permalinks
            if permalinks == [] and _threads_profile_is_stably_empty(page, profile_url):
                return set()
            if permalinks == [] and not last_error:
                last_error = "Threads profile post-link scan returned no posts, but the page was not a ready own-profile."
        except Exception as exc:
            last_error = str(exc)
        if attempt < 2:
            _sleep_between(0.8, 1.2)
    if observed_permalinks:
        return observed_permalinks
    try:
        last_login_status = str((_detect_threads_login_state(page) or {}).get("status") or "")
    except Exception:
        last_login_status = ""
    logger.log(
        "warn",
        "threads_publish_baseline_failed",
        "发布前多次无法读取账号主页基线，任务不会点击发布。",
        {
            "error": last_error[:500],
            "url": str(getattr(page, "url", "") or ""),
            "permalink_count": None if last_permalinks is None else len(last_permalinks),
            "login_status": last_login_status,
            "evidence": "post_link_structure",
        },
    )
    return None


def _threads_profile_is_stably_empty(page, profile_url: str) -> bool:
    """Empty own-profile is a ready profile whose existing post-link scan returned no posts."""
    expected = _normalize_threads_profile_url(profile_url)
    current = _normalize_threads_profile_url(getattr(page, "url", ""))
    if not expected or current != expected:
        return False
    if _browser_navigation_error_visible(page):
        return False
    if not _has_threads_session_cookie(page):
        return False
    if _visible_first(
        page,
        [
            'input[name="username"]',
            'input[type="password"]',
            'input[autocomplete="username"]',
            'input[autocomplete="current-password"]',
        ],
        timeout_ms=0,
    ) is not None:
        return False
    try:
        snippet = str(page.locator("body").inner_text(timeout=800) or "").lower()
    except Exception:
        snippet = ""
    if any(
        marker in snippet
        for marker in (
            "something went wrong",
            "please try again later",
            "unable to load",
            "couldn't refresh",
        )
    ):
        return False
    return True


def _wait_for_manual_threads_publish_completion(
    page,
    task: dict[str, Any],
    payload: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    account: dict[str, Any] | None,
    profile_url: str,
    previous_permalinks: set[str],
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
) -> dict[str, Any]:
    timeout_seconds = _safe_int(
        payload.get("manual_publish_timeout_seconds")
        or os.getenv("SOCIAL_AUTOMATION_MANUAL_PUBLISH_TIMEOUT_SECONDS"),
        DEFAULT_MANUAL_LOGIN_TIMEOUT_SECONDS,
    )
    timeout_seconds = max(
        MIN_MANUAL_LOGIN_TIMEOUT_SECONDS,
        min(timeout_seconds, MAX_MANUAL_LOGIN_TIMEOUT_SECONDS),
    )
    shot = _screenshot(page, screenshot_dir, task, "manual_publish_takeover", logger)
    _set_task_assistance(
        context_control,
        phase="attention",
        kind="takeover",
        title="需要人工接管发布",
        message="自动发布遇到需要人工处理的步骤。点击接受后将打开实时浏览器，由你继续操作。超时后会自动关闭浏览器。",
        content=_task_assistance_caption(task, payload),
        screenshot_path=shot,
        submit_label="接受并接管",
        expires_at=int(time.time()) + timeout_seconds,
    )
    logger.log(
        "warn",
        "manual_publish_takeover",
        "已停止自动发布操作，当前浏览器已切换为人工接管；系统会自动识别发布完成。",
        {"profile_url": profile_url, "timeout_seconds": timeout_seconds},
        shot,
    )
    detection_payload = dict(payload)
    detection_payload["profile_confirm_seconds"] = 30
    detection_payload["profile_confirm_refreshes"] = 1
    deadline = time.monotonic() + timeout_seconds
    last_reason = ""
    caption = str(
        payload.get("caption")
        or payload.get("content")
        or payload.get("text")
        or ""
    ).strip()
    while time.monotonic() < deadline:
        _raise_if_cancelled(cancel_event)
        with _temporary_background_page(page, logger, "threads_manual_publish_detection") as verification_page:
            result = _wait_for_threads_own_post(
                verification_page,
                caption,
                logger,
                account,
                detection_payload,
                profile_url=profile_url,
                previous_permalinks=previous_permalinks,
                cancel_event=cancel_event,
                context_control=context_control,
            )
            permalink = (
                _normalize_threads_post_permalink(result.get("url"))
                if result.get("confirmed")
                else ""
            )
            if permalink:
                final_shot = _capture_threads_publish_evidence(
                    verification_page,
                    permalink,
                    caption,
                    screenshot_dir,
                    task,
                    logger,
                )
                _resume_after_manual_takeover(context_control)
                logger.log(
                    "info",
                    "manual_publish_complete",
                    "已自动识别到人工发布完成。",
                    {"url": permalink},
                    final_shot,
                )
                return {
                    "ok": True,
                    "published": {
                        **result,
                        "confirmed": True,
                        "submitted": True,
                        "manual_completion": True,
                        "url": permalink,
                        "permalink": permalink,
                        "profile_confirmed": True,
                        "confirmation_source": "manual_profile_permalink",
                    },
                    "url": permalink,
                    "screenshot_path": final_shot,
                }
            last_reason = str(result.get("reason") or "")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        wait_seconds = min(3.0, remaining)
        wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
        if callable(wait):
            if wait(wait_seconds):
                _raise_if_cancelled(cancel_event)
        else:
            time.sleep(wait_seconds)
    timeout_shot = _screenshot(page, screenshot_dir, task, "manual_publish_timeout", logger)
    message = (
        f"人工发布接管已超过 {timeout_seconds // 60} 分钟，"
        f"系统仍未识别到新的帖子链接。{last_reason}"
    )
    _set_task_assistance(
        context_control,
        phase="error",
        kind="error",
        title="发布处理超时",
        message=message,
        screenshot_path=timeout_shot,
        content=_task_assistance_caption(task, payload),
    )
    raise ManualTimeoutError(
        message,
        "manual_publish_timeout",
        timeout_shot,
        account_status="ready",
    )


def _offer_manual_threads_publish_takeover(
    page,
    task: dict[str, Any],
    payload: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    account: dict[str, Any] | None,
    profile_url: str,
    previous_permalinks: set[str],
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
    reason: str,
) -> dict[str, Any]:
    logger.log(
        "warn",
        "publish_needs_takeover",
        reason,
        {"profile_url": profile_url},
    )
    return _wait_for_manual_threads_publish_completion(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        account,
        profile_url,
        previous_permalinks,
        cancel_event,
        context_control,
    )


def _pause_for_requested_threads_publish_takeover(
    page,
    task: dict[str, Any],
    payload: dict[str, Any],
    screenshot_dir: Path,
    logger: AutomationLogger,
    account: dict[str, Any] | None,
    profile_url: str,
    previous_permalinks: set[str],
    cancel_event: Any | None,
    context_control: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not _manual_takeover_requested(context_control):
        return None
    return _wait_for_manual_threads_publish_completion(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        account,
        profile_url,
        previous_permalinks,
        cancel_event,
        context_control,
    )


def _run_threads_publish_post(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    account: dict[str, Any] | None = None,
    context_control: dict[str, Any] | None = None,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    _set_manual_takeover_waiting_for(context_control, "threads_home_ready")
    confirmation_state = payload.get("_publish_confirmation")
    if isinstance(confirmation_state, dict) and confirmation_state.get("phase") == "confirm_only":
        _raise_if_cancelled(cancel_event)
        _set_task_assistance(
            context_control,
            title="正在校验发布结果",
            message="帖子已提交，正在确认链接并保存截图。",
            content=str(confirmation_state.get("caption") or payload.get("caption") or payload.get("content") or payload.get("text") or "").strip(),
        )
        if _manual_takeover_requested(context_control):
            _set_manual_takeover_waiting_for(context_control, "threads_confirmation")
        caption = str(confirmation_state.get("caption") or payload.get("caption") or payload.get("content") or payload.get("text") or "").strip()
        profile_url = _normalize_threads_profile_url(confirmation_state.get("profile_url"))
        raw_baseline = confirmation_state.get("baseline_permalinks")
        if not profile_url or not isinstance(raw_baseline, list):
            raise RuntimeError("Threads publish confirmation context is incomplete; refusing to publish again.")
        previous_permalinks = {
            permalink
            for value in raw_baseline
            if (permalink := _normalize_threads_post_permalink(value))
        }
        previous_permalinks.update(_threads_publish_session_permalinks(context_control))
        profile_confirmation = _wait_for_threads_own_post(
            page,
            caption,
            logger,
            account,
            payload,
            profile_url=profile_url,
            previous_permalinks=previous_permalinks,
            cancel_event=cancel_event,
            context_control=context_control,
        )
        permalink = _normalize_threads_post_permalink(profile_confirmation.get("url")) if profile_confirmation.get("confirmed") else ""
        shot = _capture_threads_publish_evidence(page, permalink, caption, screenshot_dir, task, logger) if permalink else ""
        if permalink:
            resolved = _normalize_threads_post_permalink(getattr(page, "url", ""))
            if resolved and not _is_threads_short_permalink(resolved):
                permalink = resolved
        if not permalink:
            reason = str(profile_confirmation.get("reason") or "Threads publish is still awaiting permalink confirmation.")
            shot = ""
            logger.log(
                "warn",
                "threads_publish_confirmation_pending",
                reason,
                {"profile": profile_confirmation, "confirm_only": True},
                shot,
            )
            raise PublishConfirmationPendingError(reason, shot, confirmation_state)
        published = {
            **profile_confirmation,
            "confirmed": True,
            "submitted": True,
            "url": permalink,
            "permalink": permalink,
            "profile_confirmed": True,
            "confirmation_source": "profile_caption_permalink",
        }
        _remember_threads_publish_permalink(context_control, permalink)
        _resolve_completed_manual_takeover(context_control)
        return {"ok": True, "published": published, "url": permalink, "screenshot_path": shot}

    media_paths = [str(p) for p in (payload.get("media_paths") or []) if str(p or "").strip()]
    caption = str(payload.get("caption") or payload.get("content") or payload.get("text") or "").strip()
    _set_task_assistance(
        context_control,
        title="正在撰写发布内容",
        message="正在打开 Threads 发布页并填写内容。",
        content=caption,
    )
    if not caption and not media_paths:
        raise ValueError("Threads 发布任务需要正文或媒体文件。")
    missing = [p for p in media_paths if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"媒体文件不存在：{missing[0]}")
    _dismiss_threads_compose_dialogs(page, logger)
    _ensure_threads_home_for_publish(page, logger)
    _dismiss_threads_compose_dialogs(page, logger)
    profile_url = _resolve_threads_profile_url(page, account)
    if payload.get("stop_before_publish_click") is True:
        baseline_used_primary_page = False
        previous_permalinks = _capture_threads_profile_baseline(
            page,
            profile_url,
            logger,
            skip=True,
        )
    else:
        def capture_profile_baseline() -> tuple[bool, set[str] | None]:
            with _temporary_background_page(
                page,
                logger,
                "threads_publish_baseline_background",
                block_heavy_assets=False,
            ) as full_page:
                full_baseline = _capture_threads_profile_baseline(
                    full_page,
                    profile_url,
                    logger,
                )
                if full_baseline == set():
                    logger.log(
                        "info",
                        "threads_publish_baseline_empty",
                        "账号主页没有已有帖子，将按空基线继续点击左侧发帖加号。",
                        {"known_permalinks": 0},
                    )
                return full_page is page, full_baseline

        baseline_used_primary_page, previous_permalinks = _run_matrix_resource_phase(
            context_control,
            cancel_event,
            "threads_profile_baseline",
            capture_profile_baseline,
        )
    session_permalinks = _threads_publish_session_permalinks(context_control)
    if previous_permalinks is None:
        if not session_permalinks:
            raise RuntimeError("发布前无法读取 Threads 账号主页基线，已停止任务且未点击发布按钮。")
        previous_permalinks = set(session_permalinks)
        logger.log(
            "warn",
            "threads_publish_baseline_reused",
            "账号主页本次加载超时，已复用同一批次内已确认的 Threads 帖子基线。",
            {"known_permalinks": len(previous_permalinks)},
        )
    else:
        previous_permalinks.update(session_permalinks)
        for known_permalink in previous_permalinks:
            _remember_threads_publish_permalink(context_control, known_permalink)
    if baseline_used_primary_page:
        _ensure_threads_home_for_publish(page, logger)
    _dismiss_threads_compose_dialogs(page, logger)
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    _set_manual_takeover_waiting_for(context_control, "threads_composer_ready")
    try:
        compose = _ensure_threads_compose_ready(page, logger)
    except Exception as exc:
        shot = _screenshot(page, screenshot_dir, task, "failed", logger)
        logger.log(
            "error",
            "threads_publish_compose_failed",
            "Threads composer remained unavailable after the one-time home recovery.",
            {"error": str(exc)[:500], "url": _safe_navigation_url(getattr(page, "url", ""))},
            shot,
        )
        return _offer_manual_threads_publish_takeover(
            page, task, payload, screenshot_dir, logger, account, profile_url,
            previous_permalinks, cancel_event, context_control,
            f"自动打开发布页失败，请在实时浏览器中继续。{str(exc)[:180]}",
        )
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    _set_manual_takeover_waiting_for(context_control, "threads_text_ready")
    compose = _focus_threads_compose(page, compose, logger)
    if caption:
        text_input_mode = _normalize_text_input_mode(payload.get("text_input_mode") or os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste"))
        logger.log("info", "threads_publish_text_input", "正在填写 Threads 帖子正文。", {"mode": text_input_mode, "chars": len(caption)})
        _clear_and_type(page, compose, caption, mode=text_input_mode, logger=logger, stage="threads_publish_text_input")
        _sleep_between(0.8, 1.4)
        dialog_text = _threads_active_dialog_text(page)
        if caption not in dialog_text:
            compose = _threads_dialog_compose_box(page) or compose
            retry_input_mode = "type" if text_input_mode == "paste" else text_input_mode
            _clear_and_type(page, compose, caption, mode=retry_input_mode, logger=logger, stage="threads_publish_text_input_retry")
            _sleep_between(0.8, 1.4)
            dialog_text = _threads_active_dialog_text(page)
        if caption not in dialog_text:
            return _offer_manual_threads_publish_takeover(
                page, task, payload, screenshot_dir, logger, account, profile_url,
                previous_permalinks, cancel_event, context_control,
                "自动填写正文失败，请在实时浏览器中继续完成发布。",
            )
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    _set_manual_takeover_waiting_for(context_control, "threads_media_ready")
    if media_paths:
        attachment_baseline = _threads_attachment_snapshot(page)
        file_input = _threads_media_input(page)
        if file_input is None:
            trigger = _visible_first(page, [
                '[role="dialog"] [aria-label*="photo" i]',
                '[role="dialog"] [aria-label*="video" i]',
                '[role="dialog"] button:has-text("Add photo")',
                '[role="dialog"] button:has-text("Add media")',
                '[aria-label*="photo" i]',
                '[aria-label*="video" i]',
            ], timeout_ms=1500)
            if trigger is not None:
                _human_click(page, trigger, logger, "threads_publish_media_picker")
                _sleep_between(0.8, 1.4)
                file_input = _threads_media_input(page)
        if file_input is None:
            return _offer_manual_threads_publish_takeover(
                page, task, payload, screenshot_dir, logger, account, profile_url,
                previous_permalinks, cancel_event, context_control,
                "自动找不到媒体上传入口，请在实时浏览器中继续完成发布。",
            )
        file_input.wait_for(state="attached", timeout=30000)
        logger.log("info", "threads_publish_upload", "正在上传 Threads 媒体文件。", {"count": len(media_paths)})
        file_input.set_input_files(media_paths)
        _wait_for_threads_media_ready(
            page,
            logger,
            expected_files=len(media_paths),
            baseline=attachment_baseline,
        )
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    _set_manual_takeover_waiting_for(context_control, "threads_before_submit")
    if payload.get("stop_before_publish_click") is True:
        post_button = _threads_dialog_post_button(page) or _threads_post_button(page)
        if post_button is None:
            raise RuntimeError("Threads publish preview did not reach the final publish button.")
        try:
            if not post_button.is_visible() or (
                hasattr(post_button, "is_enabled") and not post_button.is_enabled()
            ):
                raise RuntimeError("Threads final publish button is not actionable.")
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError("Unable to verify the final Threads publish button.") from exc
        shot = _screenshot(page, screenshot_dir, task, "publish_ready_no_submit", logger)
        logger.log(
            "info",
            "threads_publish_ready_no_submit",
            "Threads composer reached the final publish button; submit was intentionally skipped.",
            {"submitted": False, "ready_to_submit": True, "screenshot_path": shot},
            shot,
        )
        return {
            "ok": True,
            "preview_only": True,
            "submitted": False,
            "ready_to_submit": True,
            "url": str(page.url or ""),
            "screenshot_path": shot,
        }
    confirmation_state = {
        "phase": "confirm_only",
        "profile_url": profile_url,
        "baseline_permalinks": sorted(previous_permalinks),
        "caption": caption,
        "media_count": len(media_paths),
        "submitted_at": int(time.time()),
    }
    confirmation_persisted = False

    def persist_confirmation_before_click() -> None:
        nonlocal confirmation_persisted
        if confirmation_persisted:
            return
        _persist_publish_confirmation_context(context_control, confirmation_state, logger)
        confirmation_persisted = True

    click_uncertain = False
    _set_task_assistance(
        context_control,
        title="正在发布",
        message="内容已填好，正在提交发布。",
        content=caption,
    )
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    try:
        post_clicked = _run_publish_submit_action(
            context_control,
            cancel_event,
            lambda: _click_threads_active_dialog_post(
                page,
                logger,
                before_click=persist_confirmation_before_click,
            ),
        )
    except PublishClickUncertainError:
        post_clicked = True
        click_uncertain = True
    post_button = None if post_clicked else (_threads_dialog_post_button(page) or _threads_post_button(page))
    if not post_clicked and post_button is None:
        return _offer_manual_threads_publish_takeover(
            page, task, payload, screenshot_dir, logger, account, profile_url,
            previous_permalinks, cancel_event, context_control,
            "自动找不到发布按钮，请在实时浏览器中继续完成发布。",
        )
    if not post_clicked:
        def submit_fallback() -> None:
            persist_confirmation_before_click()
            _human_click(page, post_button, logger, "threads_publish_submit")

        _run_publish_submit_action(context_control, cancel_event, submit_fallback)
    _set_manual_takeover_waiting_for(context_control, "threads_after_submit")
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    success = _wait_for_threads_publish_success(
        page,
        logger,
        caption=caption,
        profile_url=profile_url,
        previous_permalinks=previous_permalinks,
        cancel_event=cancel_event,
        context_control=context_control,
    )
    if click_uncertain:
        success["submitted"] = True
        if not str(success.get("reason") or "").strip():
            success["reason"] = "Threads publish click was submitted while the page was navigating; checking the profile only."
    _set_task_assistance(
        context_control,
        title="正在校验发布结果",
        message="帖子已提交，正在确认链接并保存截图。",
        content=caption,
    )
    permalink = _normalize_threads_post_permalink(success.get("url")) if success.get("confirmed") else ""
    profile_confirmation: dict[str, Any] = {}
    if not permalink:
        profile_confirmation = _wait_for_threads_own_post(
            page,
            caption,
            logger,
            account,
            payload,
            profile_url=profile_url,
            previous_permalinks=previous_permalinks,
            cancel_event=cancel_event,
            context_control=context_control,
        )
        if profile_confirmation.get("confirmed"):
            permalink = _normalize_threads_post_permalink(profile_confirmation.get("url"))
    if not permalink:
        reason = str(profile_confirmation.get("reason") or success.get("reason") or "Threads 已提交，但尚未确认发布结果。")
        message = f"{reason} 自动确认窗口已结束；为避免重复发布，任务不会自动重发。"
        shot = _screenshot(page, screenshot_dir, task, "publish_submitted_unconfirmed", logger)
        logger.log("warn", "threads_publish_confirmation_pending", message, {"submit": success, "profile": profile_confirmation}, shot)
        raise PublishConfirmationPendingError(message, shot, confirmation_state)
    shot = _capture_threads_publish_evidence(page, permalink, caption, screenshot_dir, task, logger)
    resolved = _normalize_threads_post_permalink(getattr(page, "url", ""))
    if resolved and not _is_threads_short_permalink(resolved):
        permalink = resolved
    published = {
        **success,
        **profile_confirmation,
        "confirmed": True,
        "url": permalink,
        "permalink": permalink,
        "confirmation_source": "profile_caption_permalink" if profile_confirmation else "direct_permalink",
    }
    if profile_confirmation:
        published["profile_confirmed"] = True
    _remember_threads_publish_permalink(context_control, permalink)
    _resolve_completed_manual_takeover(context_control)
    return {"ok": True, "published": published, "url": permalink, "screenshot_path": shot}


def _normalize_instagram_post_permalink(value: Any) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    parsed = urlparse(urljoin(INSTAGRAM_HOME, raw_url))
    host = str(parsed.hostname or "").lower()
    if host not in {"instagram.com", "www.instagram.com"}:
        return ""
    path = str(parsed.path or "").rstrip("/")
    match = re.fullmatch(
        r"/(?:[A-Za-z0-9._]+/)?(p|reel)/([^/\s]+)",
        path,
        flags=re.IGNORECASE,
    )
    if not match:
        return ""
    return f"https://www.instagram.com/{match.group(1).lower()}/{match.group(2)}/"


def _normalize_instagram_profile_url(value: Any) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    parsed = urlparse(urljoin(INSTAGRAM_HOME, raw_url))
    host = str(parsed.hostname or "").lower()
    path = str(parsed.path or "").strip("/")
    if host not in {"instagram.com", "www.instagram.com"}:
        return ""
    if not re.fullmatch(r"[A-Za-z0-9._]+", path):
        return ""
    return f"https://www.instagram.com/{path}/"


def _instagram_profile_url(account: dict[str, Any] | None) -> str:
    username = str((account or {}).get("username") or (account or {}).get("login_username") or "").strip().lstrip("@")
    return _normalize_instagram_profile_url(f"https://www.instagram.com/{username}/")


def _find_instagram_post_permalinks(page) -> list[str] | None:
    current_url = _normalize_instagram_post_permalink(getattr(page, "url", ""))
    if current_url:
        return [current_url]
    try:
        candidates = page.evaluate(
            r"""() => Array.from(document.querySelectorAll('a[href]'))
                .map(link => link.href || link.getAttribute('href') || '')
                .filter(href => /\/(?:[A-Za-z0-9._]+\/)?(?:p|reel)\/[^/?#]+/i.test(href))"""
        )
    except Exception:
        return None
    permalinks: list[str] = []
    for candidate in candidates if isinstance(candidates, list) else []:
        permalink = _normalize_instagram_post_permalink(candidate)
        if permalink and permalink not in permalinks:
            permalinks.append(permalink)
    return permalinks


def _instagram_profile_page_ready(page, profile_url: str) -> bool:
    expected_url = _normalize_instagram_profile_url(profile_url)
    current_url = _normalize_instagram_profile_url(getattr(page, "url", ""))
    if not expected_url or current_url != expected_url:
        return False
    state = _detect_instagram_login_state(page)
    if str(state.get("status") or "") != "ready":
        return False
    if _browser_navigation_error_visible(page):
        return False
    body_text = " ".join(_page_body_text_lower(page, timeout_ms=5000).split())
    if not body_text:
        return False
    blocked_markers = (
        "something went wrong",
        "please try again later",
        "try again",
        "unable to load",
        "couldn't refresh",
        "log in to instagram",
        "log into instagram",
        "forgot password",
        "create new account",
        "sign up to see photos",
        "challenge",
        "verification",
        "sorry, this page isn't available",
        "page isn't available",
    )
    if any(marker in body_text for marker in blocked_markers):
        return False
    empty_markers = (
        "no posts yet",
        "hasn't posted yet",
        "has not posted yet",
        "尚未发布",
        "尚未發佈",
        "尚未發表",
    )
    if any(marker in body_text for marker in empty_markers):
        return True
    profile_path = str(urlparse(expected_url).path or "").strip("/")
    return bool(profile_path and profile_path.lower() in body_text)


def _capture_instagram_profile_baseline(
    page,
    profile_url: str,
    logger: AutomationLogger,
) -> set[str] | None:
    if not profile_url:
        return None
    last_error = ""
    empty_ready_observations = 0
    for attempt in range(4):
        try:
            _goto(
                page,
                profile_url,
                logger,
                "instagram_publish_baseline",
                timeout_ms=20000,
                networkidle_ms=2500,
            )
            permalinks = _find_instagram_post_permalinks(page)
            if permalinks:
                return set(permalinks)
            if permalinks == [] and _instagram_profile_page_ready(page, profile_url):
                empty_ready_observations += 1
                if empty_ready_observations >= 2:
                    return set()
                last_error = "Instagram profile is reachable but has no stable post links yet."
            else:
                empty_ready_observations = 0
                last_error = "Instagram profile did not expose a stable post grid."
        except Exception as exc:
            empty_ready_observations = 0
            last_error = str(exc)
        if attempt + 1 < 4:
            _sleep_between(0.8, 1.2)
    logger.log(
        "warn",
        "instagram_publish_baseline_failed",
        "发布前无法读取 Instagram 账号主页基线。",
        {"profile_url": profile_url, "error": last_error[:500]},
    )
    return None


def _wait_for_instagram_own_post(
    page,
    logger: AutomationLogger,
    *,
    profile_url: str,
    previous_permalinks: set[str],
    payload: dict[str, Any] | None = None,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    target_url = _normalize_instagram_profile_url(profile_url)
    if not target_url:
        return {"confirmed": False, "reason": "Instagram 账号主页地址无效。", "url": ""}
    confirm_seconds = _safe_int(
        (payload or {}).get("profile_confirm_seconds")
        or os.getenv("SOCIAL_AUTOMATION_INSTAGRAM_PROFILE_CONFIRM_SECONDS"),
        120,
    )
    confirm_seconds = max(30, min(confirm_seconds, 300))
    refresh_limit = _safe_int(
        (payload or {}).get("profile_confirm_refreshes")
        or os.getenv("SOCIAL_AUTOMATION_INSTAGRAM_PROFILE_CONFIRM_REFRESHES"),
        2,
    )
    refresh_limit = max(0, min(refresh_limit, 3))
    baseline = {
        permalink
        for value in previous_permalinks
        if (permalink := _normalize_instagram_post_permalink(value))
    }
    try:
        _goto(
            page,
            target_url,
            logger,
            "instagram_publish_profile",
            timeout_ms=20000,
            networkidle_ms=2500,
        )
    except Exception as exc:
        _raise_if_cancelled(cancel_event)
        logger.log(
            "warn",
            "instagram_publish_profile_open_slow",
            "提交后打开 Instagram 账号主页超时，将继续轮询发布结果。",
            {"profile_url": target_url, "error": str(exc)[:500]},
        )
    started_at = time.monotonic()
    deadline = started_at + confirm_seconds
    refresh_count = 0
    while time.monotonic() < deadline:
        _raise_if_cancelled(cancel_event)
        current_permalinks = _find_instagram_post_permalinks(page)
        if current_permalinks is not None:
            new_permalinks = [
                permalink
                for permalink in current_permalinks
                if permalink not in baseline
            ]
            if new_permalinks:
                return {
                    "confirmed": True,
                    "reason": "已在 Instagram 账号主页定位到本次发布帖子的链接。",
                    "url": new_permalinks[0],
                }
        now = time.monotonic()
        refresh_due = (
            refresh_count < refresh_limit
            and now - started_at >= ((refresh_count + 1) * confirm_seconds / (refresh_limit + 1))
        )
        if refresh_due:
            refresh_count += 1
            try:
                page.reload(wait_until="commit", timeout=10000)
            except Exception as exc:
                _raise_if_cancelled(cancel_event)
                logger.log(
                    "debug",
                    "instagram_publish_profile_refresh",
                    "Instagram 账号主页刷新未完成，将继续确认发布结果。",
                    {"error": str(exc)[:500]},
                )
        _wait_for_cancellation(random.uniform(1.8, 2.6), cancel_event)
    return {
        "confirmed": False,
        "reason": "发布已提交，但 Instagram 账号主页未看到本次发布内容。",
        "url": str(getattr(page, "url", "") or target_url),
    }


def _instagram_publish_evidence_page_ready(page, permalink: str, caption: str) -> bool:
    expected_url = _normalize_instagram_post_permalink(permalink)
    current_url = _normalize_instagram_post_permalink(getattr(page, "url", ""))
    if not expected_url or current_url != expected_url:
        return False
    try:
        body_text = " ".join(str(page.locator("body").inner_text(timeout=3500) or "").lower().split())
    except Exception:
        return False
    if not body_text:
        return False
    blocked_markers = (
        "log in to instagram",
        "sign up to see photos",
        "sorry, this page isn't available",
        "page isn't available",
    )
    if any(marker in body_text for marker in blocked_markers):
        return False
    normalized_caption = " ".join(str(caption or "").lower().split())
    return not normalized_caption or normalized_caption in body_text


def _capture_instagram_publish_evidence(
    page,
    permalink: str,
    caption: str,
    screenshot_dir: Path,
    task: dict[str, Any],
    logger: AutomationLogger,
) -> str:
    max_attempts = 3
    last_error = ""
    for attempt in range(1, max_attempts + 1):
        try:
            _goto(
                page,
                permalink,
                logger,
                "instagram_publish_result",
                timeout_ms=20000,
                networkidle_ms=3500,
            )
            if not _instagram_publish_evidence_page_ready(page, permalink, caption):
                raise RuntimeError("Instagram did not render the confirmed post and caption.")
            _sleep_between(1.0, 1.6)
            screenshot = _screenshot(page, screenshot_dir, task, "publish_done", logger)
            if not screenshot:
                raise RuntimeError("The validated Instagram publish evidence screenshot could not be saved.")
            return screenshot
        except Exception as exc:
            last_error = str(exc)
            if attempt < max_attempts:
                logger.log(
                    "warn",
                    "instagram_publish_evidence_retry",
                    "Instagram 发布凭证页面尚未稳定，正在重新打开帖子页面后重试。",
                    {
                        "url": permalink,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "error": last_error[:500],
                    },
                )
                _sleep_between(0.8, 1.2)
    logger.log(
        "warn",
        "instagram_publish_evidence_not_ready",
        "Instagram 发布已确认，但最终帖子页面连续重试后仍未稳定。",
        {"url": permalink, "attempts": max_attempts, "error": last_error[:500]},
    )
    return ""


def _run_publish_post(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    platform: str = "instagram",
    account: dict[str, Any] | None = None,
    context_control: dict[str, Any] | None = None,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    if platform == "threads":
        return _run_threads_publish_post(
            page,
            task,
            payload,
            screenshot_dir,
            logger,
            account,
            context_control,
            cancel_event,
        )
    confirmation_state = payload.get("_publish_confirmation")
    if isinstance(confirmation_state, dict) and confirmation_state.get("phase") == "confirm_only":
        caption = str(confirmation_state.get("caption") or payload.get("caption") or "").strip()
        profile_url = _normalize_instagram_profile_url(confirmation_state.get("profile_url"))
        raw_baseline = confirmation_state.get("baseline_permalinks")
        if not profile_url or not isinstance(raw_baseline, list):
            raise RuntimeError("Instagram publish confirmation context is incomplete; refusing to publish again.")
        previous_permalinks = {
            permalink
            for value in raw_baseline
            if (permalink := _normalize_instagram_post_permalink(value))
        }
        with _temporary_background_page(page, logger, "instagram_publish_confirmation_background") as verification_page:
            profile_confirmation = _wait_for_instagram_own_post(
                verification_page,
                logger,
                profile_url=profile_url,
                previous_permalinks=previous_permalinks,
                payload=payload,
                cancel_event=cancel_event,
            )
            permalink = (
                _normalize_instagram_post_permalink(profile_confirmation.get("url"))
                if profile_confirmation.get("confirmed")
                else ""
            )
            shot = (
                _capture_instagram_publish_evidence(
                    verification_page,
                    permalink,
                    caption,
                    screenshot_dir,
                    task,
                    logger,
                )
                if permalink
                else ""
            )
        if not permalink or not shot:
            reason = str(
                profile_confirmation.get("reason")
                or "Instagram publish is still awaiting permalink evidence."
            )
            raise PublishConfirmationPendingError(reason, "", confirmation_state)
        published = {
            **profile_confirmation,
            "confirmed": True,
            "submitted": True,
            "url": permalink,
            "permalink": permalink,
            "profile_confirmed": True,
            "confirmation_source": "profile_permalink",
        }
        return {"ok": True, "published": published, "url": permalink, "screenshot_path": shot}

    media_paths = [str(p) for p in (payload.get("media_paths") or []) if str(p or "").strip()]
    caption = str(payload.get("caption") or "").strip()
    if not media_paths:
        raise ValueError("发布任务需要媒体文件。")
    missing = [p for p in media_paths if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"媒体文件不存在：{missing[0]}")
    _set_task_assistance(
        context_control,
        title="正在撰写发布内容",
        message="正在打开 Instagram 发布页并填写内容。",
        content=caption,
    )
    _goto(page, INSTAGRAM_HOME, logger, "publish_open")
    profile_url = _instagram_profile_url(account)
    if not profile_url:
        raise RuntimeError("无法从 Instagram 账号信息确定主页地址。")
    with _temporary_background_page(page, logger, "instagram_publish_baseline_background") as verification_page:
        baseline_used_primary_page = verification_page is page
        previous_permalinks = _capture_instagram_profile_baseline(
            verification_page,
            profile_url,
            logger,
        )
    if previous_permalinks is None:
        raise RuntimeError("发布前无法读取 Instagram 账号主页基线，已停止任务且未点击发布按钮。")
    if baseline_used_primary_page:
        _goto(page, INSTAGRAM_HOME, logger, "publish_open")
    _dismiss_instagram_interstitials(page, logger)
    if bool(payload.get("warmup", False)):
        _warmup_scroll(page, logger, 1)
    if not _click_text_button(page, logger, ["Create", "New post", "Create new post"], "publish_create"):
        reason = "未找到 Instagram 创建/新建帖子按钮。"
        _set_task_assistance(
            context_control,
            phase="error",
            kind="error",
            title="发布未完成",
            message=reason,
            content=caption,
        )
        raise RuntimeError(reason)
    file_input = page.locator('input[type="file"]').first
    file_input.wait_for(state="attached", timeout=30000)
    logger.log("info", "publish_upload", "正在上传媒体文件。", {"count": len(media_paths)})
    file_input.set_input_files(media_paths)
    for stage in ("publish_next_1", "publish_next_2"):
        _sleep_between(1.0, 2.0)
        if not _click_text_button(page, logger, ["Next"], stage):
            logger.log("debug", stage, "未找到下一步按钮，继续执行。")
            break
    if caption:
        caption_box = page.locator('textarea, [contenteditable="true"]').last
        caption_box.wait_for(state="visible", timeout=30000)
        _human_click(page, caption_box, logger, "publish_caption_focus")
        text_input_mode = _normalize_text_input_mode(payload.get("text_input_mode") or os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste"))
        logger.log("info", "publish_text_input", "正在填写 Instagram 帖子正文。", {"mode": text_input_mode, "chars": len(caption)})
        _type_text(page, caption, mode=text_input_mode, logger=logger, stage="publish_text_input")
    confirmation_state = {
        "phase": "confirm_only",
        "platform": "instagram",
        "profile_url": profile_url,
        "baseline_permalinks": sorted(previous_permalinks),
        "caption": caption,
        "media_count": len(media_paths),
        "submitted_at": int(time.time()),
    }

    def submit_instagram() -> None:
        if not _click_text_button(page, logger, ["Share"], "publish_share"):
            reason = "未找到 Instagram 分享按钮。"
            _set_task_assistance(
                context_control,
                phase="error",
                kind="error",
                title="发布未完成",
                message=reason,
                content=caption,
            )
            raise RuntimeError(reason)

    _set_task_assistance(
        context_control,
        title="正在发布",
        message="内容已填好，正在提交发布。",
        content=caption,
    )
    _run_publish_submit_action(context_control, cancel_event, submit_instagram)
    success = _wait_for_publish_success(page, logger, cancel_event=cancel_event)
    if not success.get("confirmed"):
        reason = str(success.get("reason") or "Instagram publish was submitted but could not be confirmed.")
        shot = _screenshot(page, screenshot_dir, task, "publish_submitted_unconfirmed", logger)
        logger.log(
            "error",
            "instagram_publish_outcome_unknown",
            reason,
            {
                "published": success,
                "publish_submitted": True,
                "publish_outcome_unknown": True,
                "retryable": False,
            },
            shot,
        )
        raise PublishOutcomeUnknownError(reason, shot)
    with _temporary_background_page(page, logger, "instagram_publish_evidence_background") as verification_page:
        profile_confirmation = _wait_for_instagram_own_post(
            verification_page,
            logger,
            profile_url=profile_url,
            previous_permalinks=previous_permalinks,
            payload=payload,
            cancel_event=cancel_event,
        )
        permalink = (
            _normalize_instagram_post_permalink(profile_confirmation.get("url"))
            if profile_confirmation.get("confirmed")
            else ""
        )
        shot = (
            _capture_instagram_publish_evidence(
                verification_page,
                permalink,
                caption,
                screenshot_dir,
                task,
                logger,
            )
            if permalink
            else ""
        )
    if not permalink or not shot:
        reason = str(
            profile_confirmation.get("reason")
            or "Instagram 发布已提交，但尚未取得具体帖子页面截图。"
        )
        message = f"{reason} 为避免重复发布，任务只会继续确认，不会再次点击发布。"
        logger.log(
            "warn",
            "instagram_publish_confirmation_pending",
            message,
            {"submit": success, "profile": profile_confirmation},
        )
        raise PublishConfirmationPendingError(message, "", confirmation_state)
    published = {
        **success,
        **profile_confirmation,
        "confirmed": True,
        "url": permalink,
        "permalink": permalink,
        "profile_confirmed": True,
        "confirmation_source": "profile_permalink",
    }
    return {"ok": True, "published": published, "url": permalink, "screenshot_path": shot}


def _wait_for_publish_success(
    page,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    deadline = time.time() + 90
    markers = ["Your post has been shared.", "Post shared", "Your reel has been shared."]
    while time.time() < deadline:
        _raise_if_cancelled(cancel_event)
        try:
            body = page.locator("body").inner_text(timeout=3000)
            if any(marker.lower() in body.lower() for marker in markers):
                return {"confirmed": True, "reason": "已检测到发布成功文案。"}
        except Exception:
            pass
        current_url = str(page.url or "")
        if re.search(r"/(?:p|reel)/[^/?#]+", urlparse(current_url).path or "", flags=re.IGNORECASE):
            return {"confirmed": True, "reason": "分享后页面已跳转。"}
        _wait_for_cancellation(2, cancel_event)
    logger.log("warn", "publish_confirm", "等待发布确认超时。", {"url": page.url})
    return {"confirmed": False, "reason": "等待发布确认超时。"}


def _target_url(payload: dict[str, Any]) -> str:
    url = str(payload.get("target_url") or payload.get("post_url") or "").strip()
    if not url:
        raise ValueError("需要提供 target_url。")
    return url


def _public_action_platform(page) -> str:
    host = str(urlparse(str(getattr(page, "url", "") or "")).hostname or "").lower()
    return "threads" if host.endswith(("threads.net", "threads.com")) else "instagram"


def _public_exact_text_count(page, text: str) -> int:
    """Count exact, visible platform text while excluding open composers."""

    return _threads_exact_text_count(page, text)


def _verify_public_text_after_reload(
    page,
    task,
    *,
    target_url: str,
    text: str,
    screenshot_dir,
    logger,
    stage: str,
    cancel_event: Any | None,
) -> dict[str, Any]:
    _raise_if_cancelled(cancel_event)
    # A composer echo is useful diagnostic evidence, but only an exact match
    # after a fresh navigation is authoritative enough to settle CRM billing.
    echoed_before_reload = _public_exact_text_count(page, text) > 0
    _goto(page, target_url, logger, f"{stage}_verify_reload")
    _warmup_scroll(page, logger, 1)
    _raise_if_cancelled(cancel_event)
    visible_count = _public_exact_text_count(page, text)
    shot = _screenshot(page, screenshot_dir, task, f"{stage}_verified" if visible_count else f"{stage}_unknown", logger)
    evidence = {
        "submitted": True,
        "verified": visible_count > 0,
        "platform_visible": visible_count > 0,
        "confirmation_source": "exact_text_after_reload" if visible_count else "",
        "verified_after_reload": True,
        "echoed_before_reload": echoed_before_reload,
        "visible_match_count": visible_count,
        "content_hash": hashlib.sha256(str(text).encode("utf-8")).hexdigest(),
        "inspected_url": str(getattr(page, "url", "") or target_url),
        "screenshot_path": shot,
    }
    if visible_count <= 0:
        raise ActionOutcomeUnknownError(
            "The public interaction was submitted but its exact text was not visible after reload; automatic retry is disabled.",
            shot,
        )
    return evidence


def _visible_action_state(page, labels: Iterable[str]) -> bool:
    for label in labels:
        for selector in (
            f'[aria-label="{label}"]',
            f'[aria-label*="{label}" i]',
            f'button:has-text("{label}")',
            f'[role="button"]:has-text("{label}")',
        ):
            with contextlib.suppress(Exception):
                locator = page.locator(selector).first
                if locator.count() and locator.is_visible(timeout=1200):
                    return True
    return False


def _verify_toggle_after_reload(
    page,
    task,
    *,
    target_url: str,
    labels: Iterable[str],
    screenshot_dir,
    logger,
    stage: str,
    cancel_event: Any | None,
) -> dict[str, Any]:
    _raise_if_cancelled(cancel_event)
    _goto(page, target_url, logger, f"{stage}_verify_reload")
    _raise_if_cancelled(cancel_event)
    visible = _visible_action_state(page, labels)
    shot = _screenshot(page, screenshot_dir, task, f"{stage}_verified" if visible else f"{stage}_unknown", logger)
    if not visible:
        raise ActionOutcomeUnknownError(
            f"The {stage.replace('_', ' ')} action was submitted but its platform state was not confirmed after reload.",
            shot,
        )
    return {
        "submitted": True,
        "verified": True,
        "platform_visible": True,
        "confirmation_source": "platform_toggle_after_reload",
        "inspected_url": str(getattr(page, "url", "") or target_url),
        "screenshot_path": shot,
    }


def _run_comment_post(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    comment = str(payload.get("comment") or payload.get("text") or "").strip()
    if not comment:
        raise ValueError("评论任务需要填写评论内容。")
    target_url = _target_url(payload)
    _goto(page, target_url, logger, "comment_open")
    box = page.locator('textarea[aria-label*="Add a comment"], textarea, [contenteditable="true"]').last
    box.wait_for(state="visible", timeout=30000)
    _human_click(page, box, logger, "comment_focus")
    _human_type(page, comment)
    platform = _public_action_platform(page)
    submitted = _run_billing_commit_action(
        context_control,
        cancel_event,
        lambda: (
            _click_threads_reply_submit(page, box, logger, "comment_submit")
            if platform == "threads"
            else _click_text_button(page, logger, ["Post", "发布", "發佈"], "comment_submit")
        ),
    )
    if not submitted:
        raise RuntimeError("未找到评论发布按钮。")
    _sleep_between(2.0, 4.0)
    evidence = _verify_public_text_after_reload(
        page, task, target_url=target_url, text=comment, screenshot_dir=screenshot_dir,
        logger=logger, stage="comment", cancel_event=cancel_event,
    )
    return {"ok": True, "url": page.url, **evidence}


def _run_reply_comment(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reply = str(payload.get("reply") or payload.get("comment") or payload.get("text") or "").strip()
    target_text = str(payload.get("target_text") or "").strip()
    if not reply:
        raise ValueError("回复任务需要填写回复/评论内容。")
    target_url = _target_url(payload)
    _goto(page, target_url, logger, "reply_open")
    _warmup_scroll(page, logger, 1)
    if target_text:
        try:
            page.get_by_text(target_text, exact=False).first.scroll_into_view_if_needed(timeout=8000)
        except Exception:
            logger.log("warn", "reply_target", "回复前未找到目标评论文本。", {"target_text": target_text[:80]})
    if not _click_text_button(page, logger, ["Reply"], "reply_button"):
        raise RuntimeError("未找到回复按钮。")
    box = page.locator('textarea, [contenteditable="true"]').last
    box.wait_for(state="visible", timeout=30000)
    _human_click(page, box, logger, "reply_focus")
    _human_type(page, reply)
    platform = _public_action_platform(page)
    submitted = _run_billing_commit_action(
        context_control,
        cancel_event,
        lambda: (
            _click_threads_reply_submit(page, box, logger, "reply_submit")
            if platform == "threads"
            else _click_text_button(page, logger, ["Post", "发布", "發佈"], "reply_submit")
        ),
    )
    if not submitted:
        raise RuntimeError("未找到回复发布按钮。")
    _sleep_between(2.0, 4.0)
    evidence = _verify_public_text_after_reload(
        page, task, target_url=target_url, text=reply, screenshot_dir=screenshot_dir,
        logger=logger, stage="reply", cancel_event=cancel_event,
    )
    return {"ok": True, "url": page.url, **evidence}


_DIRECT_MESSAGE_COMPOSER_SELECTORS = (
    '[data-lexical-editor="true"][role="textbox"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"][aria-placeholder*="Message" i]',
    '[role="textbox"][contenteditable="true"][aria-label*="Message" i]',
    '[role="textbox"][contenteditable="true"][aria-placeholder*="訊息"]',
    '[role="textbox"][contenteditable="true"][aria-placeholder*="消息"]',
    'textarea[placeholder*="Message" i]',
    'textarea[aria-label*="Message" i]',
    'textarea[placeholder*="訊息"]',
    'textarea[placeholder*="消息"]',
    'textarea[aria-label*="訊息"]',
    'textarea[aria-label*="消息"]',
    'div[role="textbox"][contenteditable="true"]',
)


def _direct_message_recipient(payload: dict[str, Any]) -> str:
    candidate = str(
        payload.get("recipient_username")
        or payload.get("target_username")
        or payload.get("username")
        or ""
    ).strip()
    if not candidate:
        raw_target = str(payload.get("target_url") or "").strip()
        try:
            parsed = urlparse(raw_target)
            segments = [segment for segment in parsed.path.split("/") if segment]
            hostname = str(parsed.hostname or "").lower()
            if parsed.netloc:
                if (hostname == "instagram.com" or hostname.endswith(".instagram.com")) and segments:
                    candidate = segments[0]
                elif (hostname in {"threads.net", "threads.com"} or hostname.endswith((".threads.net", ".threads.com"))) and segments:
                    candidate = segments[0].lstrip("@")
                else:
                    candidate = ""
            elif segments:
                candidate = segments[0].lstrip("@")
            elif raw_target and ":" in raw_target and "://" not in raw_target:
                candidate = raw_target.rsplit(":", 1)[-1]
            else:
                candidate = raw_target
        except Exception:
            candidate = raw_target
    candidate = candidate.strip().strip("/@")
    if not re.fullmatch(r"[A-Za-z0-9._]{1,64}", candidate):
        raise ValueError("Direct-message recipient username is invalid.")
    return candidate


def _direct_message_composer(page, timeout_ms: int = 1200):
    for selector in _DIRECT_MESSAGE_COMPOSER_SELECTORS:
        try:
            locator = page.locator(selector).last
            if locator.count() and locator.is_visible(timeout=timeout_ms):
                return locator
        except Exception:
            continue
    return None


def _direct_message_normalized(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").replace("\u00a0", " ")).lower()


def _direct_message_logged_in_username(page, platform: str, expected_username: str) -> str:
    expected = str(expected_username or "").strip().lstrip("@").lower()
    if not expected:
        return ""
    expected_path = f"/@{expected}" if platform == "threads" else f"/{expected}/"
    try:
        verified = page.evaluate(
            r"""({ expectedPath, platform }) => {
                const normalizePath = (value) => {
                    try { return new URL(value, window.location.origin).pathname.toLowerCase(); }
                    catch { return String(value || '').toLowerCase(); }
                };
                const candidates = Array.from(document.querySelectorAll(
                    'nav a[href], header a[href], a[aria-label*="Profile" i][href], a[aria-label*="個人檔案"][href], a[aria-label*="个人资料"][href]'
                ));
                return candidates.some((node) => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
                    const path = normalizePath(node.getAttribute('href'));
                    return platform === 'threads'
                        ? path === expectedPath || path === `${expectedPath}/`
                        : path === expectedPath;
                });
            }""",
            {"expectedPath": expected_path, "platform": platform},
        )
    except Exception:
        verified = False
    return expected if verified is True else ""


def _direct_message_conversation_evidence(
    page,
    message: str,
    recipient: str,
) -> dict[str, Any]:
    needle = _direct_message_normalized(message)[:96]
    if len(needle) < 6:
        return {
            "message_visible": False,
            "delivered": False,
            "read": False,
            "replied": False,
            "attachment_visible": False,
            "status_text": "",
        }
    try:
        raw = page.evaluate(
            r"""({ needle, recipient }) => {
                const normalize = (value) => String(value || '')
                    .toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, '');
                const visible = (node) => {
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0
                        && style.display !== 'none' && style.visibility !== 'hidden';
                };
                const candidates = Array.from(document.querySelectorAll('div, span, p'))
                    .filter(visible)
                    .filter((node) => !node.closest('[contenteditable="true"], textarea, [role="textbox"]'))
                    .filter((node) => {
                        const text = normalize(node.textContent);
                        return text.includes(needle) && text.length <= Math.max(needle.length * 5, 800);
                    })
                    .sort((left, right) => String(left.textContent || '').length - String(right.textContent || '').length);
                const messageNode = candidates[0];
                if (!messageNode) return {
                    message_visible: false, delivered: false, read: false,
                    replied: false, attachment_visible: false, status_text: '',
                    recipient_visible: false, outgoing_hint: false,
                };
                let scope = messageNode;
                let statusText = String(messageNode.textContent || '');
                let attachmentVisible = false;
                for (let depth = 0; depth < 7 && scope.parentElement; depth += 1) {
                    const parent = scope.parentElement;
                    const parentText = String(parent.innerText || parent.textContent || '');
                    if (parentText.length > 2400) break;
                    scope = parent;
                    statusText = parentText;
                    attachmentVisible = attachmentVisible || Array.from(scope.querySelectorAll('img, video'))
                        .some((media) => {
                            const rect = media.getBoundingClientRect();
                            const style = window.getComputedStyle(media);
                            return rect.width >= 60 && rect.height >= 40
                                && style.display !== 'none' && style.visibility !== 'hidden';
                        });
                }
                const compact = statusText.replace(/\s+/g, ' ').trim().slice(0, 700);
                const lowered = compact.toLowerCase();
                const rect = messageNode.getBoundingClientRect();
                const outgoingHint = rect.left + rect.width / 2 >= window.innerWidth * 0.45
                    || /(?:sent|you:|you sent|已傳送|已发送|你傳送|你发送)/i.test(compact);
                const target = normalize(recipient).replace(/^@/, '');
                const pageText = normalize(document.body && document.body.innerText);
                return {
                    message_visible: true,
                    delivered: /(?:delivered|已送達|已送达)/i.test(lowered),
                    read: /(?:seen|read|已讀|已读|看過|看过)/i.test(lowered),
                    replied: false,
                    attachment_visible: attachmentVisible,
                    status_text: compact,
                    recipient_visible: Boolean(target && pageText.includes(target)),
                    outgoing_hint: outgoingHint,
                };
            }""",
            {"needle": needle, "recipient": recipient},
        )
    except Exception:
        raw = {}
    evidence = dict(raw) if isinstance(raw, dict) else {}
    return {
        "message_visible": evidence.get("message_visible") is True,
        "delivered": evidence.get("delivered") is True,
        "read": evidence.get("read") is True,
        "replied": evidence.get("replied") is True,
        "attachment_visible": evidence.get("attachment_visible") is True,
        "recipient_visible": evidence.get("recipient_visible") is True,
        "outgoing_hint": evidence.get("outgoing_hint") is True,
        "status_text": str(evidence.get("status_text") or "")[:700],
        "checked_at": int(time.time()),
    }


def _fill_direct_message_composer(
    page,
    message: str,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> bool:
    composer = _direct_message_composer(page, timeout_ms=2500)
    if composer is None:
        return False
    _raise_if_cancelled(cancel_event)
    if not _human_click(
        page,
        composer,
        logger,
        "direct_message_focus",
        abort_if=lambda: _manual_takeover_requested(context_control),
    ):
        return False
    try:
        composer.fill(message, timeout=5000)
    except Exception:
        with contextlib.suppress(Exception):
            page.keyboard.press("Control+A")
        _type_text(
            page,
            message,
            min_delay=0.02,
            max_delay=0.06,
            logger=logger,
            stage="direct_message_text",
            abort_if=lambda: _manual_takeover_requested(context_control),
        )
    return _direct_message_composer(page, timeout_ms=800) is not None


def _attach_direct_message_media(page, media_path: str) -> bool:
    clean_path = str(media_path or "").strip()
    if not clean_path:
        return True
    source = Path(clean_path).resolve()
    if not source.is_file():
        return False
    for selector in ('input[type="file"][accept*="image" i]', 'input[type="file"]'):
        try:
            inputs = page.locator(selector)
            for index in range(min(int(inputs.count()), 12) - 1, -1, -1):
                try:
                    inputs.nth(index).set_input_files(str(source), timeout=10000)
                    return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def _open_direct_message_conversation(
    page,
    platform: str,
    recipient: str,
    logger: AutomationLogger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    profile_url = (
        f"https://www.instagram.com/{quote(recipient)}/"
        if platform == "instagram"
        else f"https://www.threads.net/@{quote(recipient)}"
    )
    _goto(page, profile_url, logger, "direct_message_profile")
    _raise_if_cancelled(cancel_event)
    clicked = _click_text_button(
        page,
        logger,
        ["Message", "Send message", "訊息", "私訊", "消息", "发消息", "傳送訊息"],
        "direct_message_open",
        abort_if=lambda: _manual_takeover_requested(context_control),
    )
    if clicked and _wait_interruptibly(1.5, cancel_event, context_control):
        if _direct_message_composer(page, timeout_ms=3000) is not None:
            return {"opened": True, "recipient_verified": True, "method": "profile", "profile_url": profile_url}

    inbox_url = (
        "https://www.instagram.com/direct/inbox/"
        if platform == "instagram"
        else "https://www.threads.net/messages"
    )
    _goto(page, inbox_url, logger, "direct_message_inbox")
    opened_new = _click_text_button(
        page,
        logger,
        ["New message", "Compose", "新訊息", "新增訊息", "新消息", "撰寫"],
        "direct_message_new",
        abort_if=lambda: _manual_takeover_requested(context_control),
    )
    if not opened_new or not _wait_interruptibly(0.8, cancel_event, context_control):
        return {"opened": False, "recipient_verified": False, "method": "", "profile_url": profile_url}
    search = _visible_first(
        page,
        [
            'input[placeholder*="Search" i]',
            'input[aria-label*="Search" i]',
            'input[placeholder*="搜尋"]',
            'input[placeholder*="搜索"]',
            'input[type="text"]',
        ],
        timeout_ms=3000,
    )
    if search is None:
        return {"opened": False, "recipient_verified": False, "method": "", "profile_url": profile_url}
    _human_click(page, search, logger, "direct_message_recipient_search")
    try:
        search.fill(recipient, timeout=5000)
    except Exception:
        _type_text(page, recipient, min_delay=0.03, max_delay=0.07)
    if not _wait_interruptibly(1.2, cancel_event, context_control):
        return {"opened": False, "recipient_verified": False, "method": "", "profile_url": profile_url}
    target = None
    for locator in (
        page.get_by_text(recipient, exact=True).first,
        page.get_by_text(f"@{recipient}", exact=True).first,
        page.locator(f'[role="option"]:has-text("{recipient}")').first,
        page.locator(f'[role="button"]:has-text("{recipient}")').first,
    ):
        try:
            if locator.count() and locator.is_visible(timeout=1200):
                target = locator
                break
        except Exception:
            continue
    if target is None or not _human_click(page, target, logger, "direct_message_recipient_select"):
        return {"opened": False, "recipient_verified": False, "method": "", "profile_url": profile_url}
    _click_text_button(
        page,
        logger,
        ["Next", "Chat", "下一步", "聊天", "完成"],
        "direct_message_recipient_next",
        abort_if=lambda: _manual_takeover_requested(context_control),
    )
    if not _wait_interruptibly(1.5, cancel_event, context_control):
        return {"opened": False, "recipient_verified": False, "method": "", "profile_url": profile_url}
    return {
        "opened": _direct_message_composer(page, timeout_ms=3000) is not None,
        "recipient_verified": True,
        "method": "inbox_search",
        "profile_url": profile_url,
    }


def _run_direct_message(
    page,
    task,
    account,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message = str(payload.get("content") or payload.get("message") or payload.get("text") or "").strip()
    if len(_direct_message_normalized(message)) < 6 or len(message) > 5000:
        raise ValueError("Direct-message content must contain 6 to 5000 characters.")
    recipient = _direct_message_recipient(payload)
    sender = str(account.get("username") or "").strip().lstrip("@").lower()
    if sender and recipient.lower() == sender:
        raise ValueError("Direct-message recipient cannot be the sender account.")
    media_paths = [
        str(item or "").strip()
        for item in (payload.get("media_paths") or [])
        if str(item or "").strip()
    ]
    if len(media_paths) > 1:
        raise ValueError("Direct-message tasks currently support at most one media attachment.")
    logged_in_username = _direct_message_logged_in_username(page, platform, sender)

    opened = _open_direct_message_conversation(
        page,
        platform,
        recipient,
        logger,
        cancel_event=cancel_event,
        context_control=context_control,
    )
    if not opened.get("opened") or not opened.get("recipient_verified"):
        shot = _screenshot(page, screenshot_dir, task, "direct_message_recipient_unavailable", logger)
        return {
            "ok": False,
            "sent": False,
            "status": "recipient_unavailable",
            "warning": "The target account could not be opened in a verified message conversation.",
            "recipient_username": recipient,
            "logged_in_username": logged_in_username,
            "inspected_url": str(page.url or ""),
            "screenshot_path": shot,
        }
    if media_paths and not _attach_direct_message_media(page, media_paths[0]):
        shot = _screenshot(page, screenshot_dir, task, "direct_message_media_unavailable", logger)
        raise RuntimeError(f"The CRM media attachment could not be added before submission. Evidence: {shot}")
    if not _fill_direct_message_composer(
        page,
        message,
        logger,
        cancel_event=cancel_event,
        context_control=context_control,
    ):
        shot = _screenshot(page, screenshot_dir, task, "direct_message_composer_unavailable", logger)
        return {
            "ok": False,
            "sent": False,
            "status": "composer_unavailable",
            "warning": "The verified conversation did not expose a usable message composer.",
            "recipient_username": recipient,
            "logged_in_username": logged_in_username,
            "inspected_url": str(page.url or ""),
            "screenshot_path": shot,
        }

    def submit() -> bool:
        if _click_text_button(
            page,
            logger,
            ["Send", "傳送", "发送", "發送", "送出"],
            "direct_message_submit",
            abort_if=lambda: _manual_takeover_requested(context_control),
        ):
            return True
        page.keyboard.press("Enter")
        return True

    _run_billing_commit_action(context_control, cancel_event, submit)
    evidence: dict[str, Any] = {}
    for attempt in range(8):
        if not _wait_interruptibly(0.6 if attempt == 0 else 0.9, cancel_event, context_control):
            break
        evidence = _direct_message_conversation_evidence(page, message, recipient)
        attachment_confirmed = not media_paths or evidence.get("attachment_visible") is True
        if evidence.get("message_visible") is True and attachment_confirmed:
            shot = _screenshot(page, screenshot_dir, task, "direct_message_confirmed", logger)
            return {
                "ok": True,
                "sent": True,
                "submitted": True,
                "verified": True,
                "recipient_username": recipient,
                "logged_in_username": logged_in_username,
                "platform": platform,
                "conversation_url": str(page.url or ""),
                "open_method": str(opened.get("method") or ""),
                "delivery_evidence": evidence,
                "screenshot_path": shot,
            }
    shot = _screenshot(page, screenshot_dir, task, "direct_message_submitted_unconfirmed", logger)
    logger.log(
        "warn",
        "direct_message_submitted_unconfirmed",
        "The private message was submitted but no matching outgoing bubble was confirmed; automatic resend is disabled.",
        {"recipient_username": recipient, "platform": platform, "evidence": evidence},
        shot,
    )
    raise ActionOutcomeUnknownError(
        "Private-message submission is unconfirmed; review platform evidence before any retry.",
        shot,
    )


def _run_like_post(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    target_url = _target_url(payload)
    _goto(page, target_url, logger, "like_open")
    unlike = page.locator('[aria-label="Unlike"]').first
    try:
        if unlike.count() and unlike.is_visible(timeout=3000):
            shot = _screenshot(page, screenshot_dir, task, "already_liked", logger)
            return {
                "ok": True, "already_liked": True, "submitted": False, "verified": True,
                "platform_visible": True, "confirmation_source": "platform_toggle_existing",
                "url": page.url, "inspected_url": page.url, "screenshot_path": shot,
            }
    except Exception:
        pass
    like = page.locator('[aria-label="Like"]').first
    if not like.count():
        raise RuntimeError("未找到点赞按钮。")
    _run_billing_commit_action(
        context_control,
        cancel_event,
        lambda: _human_click(page, like, logger, "like_click"),
    )
    _sleep_between(1.0, 2.0)
    evidence = _verify_toggle_after_reload(
        page, task, target_url=target_url,
        labels=("Unlike", "Remove like", "取消赞", "取消讚"),
        screenshot_dir=screenshot_dir, logger=logger, stage="like",
        cancel_event=cancel_event,
    )
    return {"ok": True, "liked": True, "url": page.url, **evidence}


def _run_share_post_legacy(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _goto(page, _target_url(payload), logger, "share_open")
    opened = _click_text_button(page, logger, ["Share", "Send"], "share_button")
    if not opened:
        raise RuntimeError("未找到分享/发送按钮。")
    _sleep_between(1.0, 2.0)
    copied = _run_billing_commit_action(
        context_control,
        cancel_event,
        lambda: _click_text_button(page, logger, ["Copy link"], "share_copy_link"),
    )
    shot = _screenshot(page, screenshot_dir, task, "share_done", logger)
    return {"ok": True, "copied_link": copied, "url": page.url, "screenshot_path": shot}


def _run_share_post(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raise UnsupportedActionError(
        "CRM share requires an explicit platform destination; Copy link is not a share write and cannot be billed as confirmed."
    )


def _run_repost_post(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
    context_control: dict[str, Any] | None = None,
) -> dict[str, Any]:
    target_url = _target_url(payload)
    _goto(page, target_url, logger, "repost_open")
    if _visible_action_state(page, ("Undo repost", "Remove repost", "取消转发", "取消轉發")):
        shot = _screenshot(page, screenshot_dir, task, "repost_existing", logger)
        return {
            "ok": True, "already_reposted": True, "submitted": False, "verified": True,
            "platform_visible": True, "confirmation_source": "platform_toggle_existing",
            "url": page.url, "inspected_url": page.url, "screenshot_path": shot,
        }

    def submit_repost() -> bool:
        opened = _click_text_button(page, logger, ["Repost", "转发", "轉發"], "repost_open_menu")
        if not opened:
            return False
        _sleep_between(0.3, 0.7)
        menu = page.locator(
            '[role="menuitem"]:has-text("Repost"), [role="menu"] [role="button"]:has-text("Repost"), '
            '[role="menuitem"]:has-text("转发"), [role="menuitem"]:has-text("轉發")'
        ).first
        with contextlib.suppress(Exception):
            if menu.count() and menu.is_visible(timeout=1500):
                return bool(_human_click(page, menu, logger, "repost_submit"))
        # Some Threads builds perform the repost on the first, guarded click.
        return True

    submitted = bool(_run_billing_commit_action(context_control, cancel_event, submit_repost))
    if not submitted:
        raise RuntimeError("The Threads repost control was not available.")
    _sleep_between(1.0, 2.0)
    evidence = _verify_toggle_after_reload(
        page, task, target_url=target_url,
        labels=("Undo repost", "Remove repost", "取消转发", "取消轉發"),
        screenshot_dir=screenshot_dir, logger=logger, stage="repost",
        cancel_event=cancel_event,
    )
    return {"ok": True, "reposted": True, "url": page.url, **evidence}
