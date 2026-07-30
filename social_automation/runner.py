from __future__ import annotations

import contextlib
import hashlib
import json
import os
import random
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol
from urllib.parse import quote, quote_plus, urljoin, urlparse


INSTAGRAM_HOME = "https://www.instagram.com/"
INSTAGRAM_LOGIN = "https://www.instagram.com/accounts/login/"
THREADS_HOME = "https://www.threads.net/"
DEFAULT_LOGIN_SELF_HEAL_ATTEMPTS = 4
LOGIN_FORM_WAIT_SECONDS = 12
DEFAULT_MANUAL_LOGIN_TIMEOUT_SECONDS = 900
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
    ':not([autocomplete="current-password"])'
)
MAX_WARMUP_LIKES = 16
MAX_WARMUP_COMMENTS = 6
SUPPORTED_TASK_TYPES = {
    "check_login",
    "open_login",
    "browse_feed",
    "browse_profile",
    "instagram_warmup",
    "instagram_auto_reply",
    "threads_warmup",
    "threads_auto_reply",
    "publish_post",
    "comment_post",
    "reply_comment",
    "like_post",
    "share_post",
    "repost_post",
}

_CAMOUFOX_LAUNCH_LOCK = threading.Lock()
_DEFAULT_LIVE_BROWSER_CHROME_HEIGHT = 61


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
    def __init__(self, message: str, status: str = "cookie_expired", screenshot_path: str = ""):
        super().__init__(message)
        self.status = status
        self.screenshot_path = str(screenshot_path or "")


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
    width = max(1024, _safe_int(getattr(session, "width", 1600), 1600))
    height = max(640, _safe_int(getattr(session, "height", 900), 900))
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
    confirmation_clicked = False
    while time.monotonic() < deadline:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            return {
                "status": "need_verification",
                "reason": "用户已切换为人工接管，自动验证确认已停止。",
            }
        if (
            str(current.get("status") or "") == "account_confirmation_required"
            and not confirmation_clicked
        ):
            confirmation_clicked = _click_text_button(
                page,
                logger,
                ["Continue with Instagram", "Log in with Instagram", "继续使用 Instagram", "使用 Instagram 继续"],
                "threads_account_confirmation",
                abort_if=lambda: _manual_takeover_requested(context_control),
            )
        current = _detect_platform_login_state(page, platform)
        if platform == "threads":
            current = _restore_threads_after_instagram_login(page, current, logger)
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
    if str(task.get("task_type") or "") != "publish_post":
        return initial_status
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
        if str(totp_result.get("status") or "") in {
            "account_confirmation_required",
            "totp_submitted",
        }:
            return totp_result
    max_repair_attempts = _int_payload_or_env(payload, "publish_login_repair_attempts", "SOCIAL_AUTOMATION_PUBLISH_LOGIN_REPAIR_ATTEMPTS", 3, 0, 8)
    if max_repair_attempts <= 0:
        return initial_status
    logger.log(
        "warn",
        "publish_login_repair",
        f"{_platform_name(platform)} login check failed before publishing; trying automatic recovery before manual handoff.",
        {"status": initial_status, "attempts": max_repair_attempts},
    )
    for attempt in range(1, max_repair_attempts + 1):
        _self_heal_login_page(
            page,
            platform,
            logger,
            task,
            screenshot_dir,
            str(initial_status.get("reason") or "publish_login_not_ready"),
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
    saved_password = str(account.get("login_password") or "")
    if not saved_password:
        return initial_status
    repair_payload = dict(payload or {})
    repair_payload.setdefault("auto_submit", True)
    repair_payload.setdefault("login_username", str(account.get("login_username") or account.get("username") or "").strip())
    repair_payload.setdefault("login_password", saved_password)
    repair_payload.setdefault("login_wait_seconds", 120)
    repair_payload.setdefault("wait_for_manual", False)
    repair_payload.setdefault("max_self_heal_attempts", max_repair_attempts)
    repair_payload.setdefault("max_login_attempts", 2)
    try:
        result = _run_open_login(
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
    if result.get("status") == "ready":
        return result
    return initial_status


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
    if platform == "threads" and task_type in {"instagram_warmup", "instagram_auto_reply"}:
        raise UnsupportedActionError(f"{task_type} 需要使用 Instagram 账号。")
    if platform == "threads" and task_type not in {"open_login", "check_login", "browse_feed", "threads_warmup", "threads_auto_reply", "publish_post"}:
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
        _import_initial_cookies(context, payload.get("initial_cookies"), platform, logger)
        page = _first_page(context)
        _sync_live_browser_viewport(page, context_control, logger)
        page.set_default_timeout(int(os.getenv("SOCIAL_AUTOMATION_DEFAULT_TIMEOUT_MS", "30000")))
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
        if task_type == "publish_post":
            login = _check_platform_login_without_disrupting(page, platform, logger)
            if login.get("status") != "ready":
                # Recovery and manual takeover must remain visible on the primary page.
                login = _check_platform_login(page, platform, logger)
        else:
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
        if task_type == "publish_post" and login.get("status") in {
            "totp_submitted",
            "account_confirmation_required",
        }:
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
        if task_type == "publish_post" and login.get("status") in {"need_verification", "invalid_credentials"}:
            detected_status = str(login.get("status") or "need_verification")
            account_status = "need_verification" if detected_status == "need_verification" else "cookie_expired"
            _report_account_login_status(context_control, account_status, logger)
            _request_manual_takeover(context_control)
            shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
            logger.log(
                "warn",
                "publish_login_manual_takeover",
                str(login.get("reason") or f"{_platform_name(platform)} 发布前需要人工完成登录验证。"),
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
                f"{_platform_name(platform)} 发布前需要人工验证，完成后系统会继续发布。",
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
            return _run_instagram_warmup(page, task, payload, screenshot_dir, logger, cancel_event=cancel_event)
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
            )
        if task_type == "browse_profile":
            _raise_if_cancelled(cancel_event)
            return _run_browse_profile(page, task, payload, screenshot_dir, logger)
        if task_type == "publish_post":
            _raise_if_cancelled(cancel_event)
            return _run_publish_post(
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
        if task_type == "comment_post":
            _raise_if_cancelled(cancel_event)
            return _run_comment_post(page, task, payload, screenshot_dir, logger)
        if task_type == "reply_comment":
            _raise_if_cancelled(cancel_event)
            return _run_reply_comment(page, task, payload, screenshot_dir, logger)
        if task_type == "like_post":
            _raise_if_cancelled(cancel_event)
            return _run_like_post(page, task, payload, screenshot_dir, logger)
        if task_type == "share_post":
            _raise_if_cancelled(cancel_event)
            return _run_share_post(page, task, payload, screenshot_dir, logger)
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
    with _open_camoufox_context(
        account=account,
        proxy=proxy,
        logger=loggers[0],
        context_control=context_control,
    ) as context:
        _import_initial_cookies(context, first_payload.get("initial_cookies"), platform, loggers[0])
        page = _first_page(context)
        _sync_live_browser_viewport(page, context_control, loggers[0])
        page.set_default_timeout(int(os.getenv("SOCIAL_AUTOMATION_DEFAULT_TIMEOUT_MS", "30000")))
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
    if verify_login:
        login = _check_platform_login_without_disrupting(page, platform, logger)
        if login.get("status") != "ready":
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
        if login.get("status") in {"totp_submitted", "account_confirmation_required"}:
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
            raise NeedManualError(
                str(login.get("reason") or f"{_platform_name(platform)} requires login verification."),
                str(login.get("status") or "need_verification"),
                shot,
            )
        _report_account_login_status(context_control, "ready", logger)

    _raise_if_cancelled(cancel_event)
    return _run_publish_post(
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
        callback(str(status or "").strip())
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

    def __enter__(self):
        from .browser_runtime import verify_pinned_browser_runtime

        runtime_versions = verify_pinned_browser_runtime()
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
        self.live_session = self._start_live_browser_session()
        headless: bool | str = False
        if self.live_session is None and os.name != "nt" and str(os.getenv("SOCIAL_AUTOMATION_HEADLESS") or "").strip().lower() == "virtual":
            headless = "virtual"
        kwargs: dict[str, Any] = {
            "persistent_context": True,
            "user_data_dir": str(profile_dir),
            "headless": headless,
            "humanize": float(os.getenv("SOCIAL_AUTOMATION_HUMANIZE_MAX_SECONDS", "0.5")),
        }
        if self.live_session is not None:
            geometry_config = _live_browser_geometry_config(self.live_session)
            # Camoufox beta.28 randomizes both its screen fingerprint and inner
            # viewport. Pin both to the real Xvnc framebuffer so the current
            # build retains the same 1600x839 content area as beta.24.
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
            if self.context_control is not None:
                self.context_control["live_browser_window_width"] = geometry_config["window.outerWidth"]
                self.context_control["live_browser_window_height"] = geometry_config["window.outerHeight"]
                self.context_control["live_browser_chrome_reserve_height"] = (
                    geometry_config["window.outerHeight"] - geometry_config["window.innerHeight"]
                )
        if proxy_config:
            kwargs["proxy"] = proxy_config
            kwargs["geoip"] = True
        self.logger.log(
            "info",
            "browser_launch",
            "正在启动 Camoufox 指纹浏览器环境。",
            {
                "profile_dir": str(profile_dir),
                "proxy": _masked_proxy(proxy_config),
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
        with _CAMOUFOX_LAUNCH_LOCK:
            old_display = os.environ.get("DISPLAY")
            if self.live_session is not None:
                os.environ["DISPLAY"] = str(self.live_session.display)
            try:
                self.cm = Camoufox(**kwargs)
                self.context = self.cm.__enter__()
            finally:
                if self.live_session is not None:
                    if old_display is None:
                        os.environ.pop("DISPLAY", None)
                    else:
                        os.environ["DISPLAY"] = old_display
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

            task = {}
            if self.context_control is not None and isinstance(self.context_control.get("task"), dict):
                task = dict(self.context_control.get("task") or {})
            session = start_live_browser_session(task=task, account=self.account, logger=self.logger)
            if session is not None and self.context_control is not None:
                self.context_control["live_browser_session_id"] = str(session.id)
                self.context_control["live_browser_width"] = int(getattr(session, "width", 0) or 0)
                self.context_control["live_browser_height"] = int(getattr(session, "height", 0) or 0)
            return session
        except Exception as exc:
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
    config = {"server": f"{proxy_type}://{host}:{port}"}
    username = str(proxy.get("username") or "").strip()
    password = str(proxy.get("password") or "").strip()
    if username:
        config["username"] = username
        config["password"] = password
    return config


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
    width = _safe_int(context_control.get("live_browser_width"), 1600)
    height = _safe_int(context_control.get("live_browser_height"), 900)
    expected = {"width": max(1024, width), "height": max(640, height)}
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
    if normalized_stage.startswith("instagram_warmup"):
        return True
    return normalized_stage in {
        "login_verification_required",
        "login_invalid_credentials",
        "login_wait_timeout",
        "manual_login_timeout",
        "login_complete",
        "publish_done",
        "publish_submitted_unconfirmed",
        "failed",
    }


def _goto(page, url: str, logger: AutomationLogger, stage: str, *, timeout_ms: int = 60000, networkidle_ms: int = 15000) -> None:
    logger.log("info", stage, f"正在打开页面：{url}")
    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    try:
        page.wait_for_load_state("networkidle", timeout=networkidle_ms)
    except Exception:
        pass


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
def _temporary_background_page(page, logger: AutomationLogger, stage: str):
    background = page
    try:
        browser_context = getattr(page, "context", None)
        new_page = getattr(browser_context, "new_page", None)
        if callable(new_page):
            candidate = new_page()
            if candidate is not None and candidate is not page:
                background = candidate
                with contextlib.suppress(Exception):
                    page.bring_to_front()
                logger.log("debug", stage, "Background browser page opened for a non-disruptive check.", {})
    except Exception as exc:
        background = page
        logger.log("debug", stage, "Background page unavailable; using the primary page.", {"error": str(exc)[:500]})
    try:
        yield background
    finally:
        if background is not page:
            with contextlib.suppress(Exception):
                background.close()
            with contextlib.suppress(Exception):
                page.bring_to_front()


def _check_platform_login_without_disrupting(page, platform: str, logger: AutomationLogger) -> dict[str, Any]:
    with _temporary_background_page(page, logger, "publish_login_probe") as probe:
        return _check_platform_login(probe, platform, logger)


def _detect_platform_account_restriction(url: str, body_text: str, platform: str) -> dict[str, Any] | None:
    clean_url = str(url or "").lower()
    clean_text = str(body_text or "").lower()
    url_markers = (
        "/disabled/",
        "/suspended/",
        "/checkpoint/disabled",
        "/accounts/disabled",
    )
    text_markers = (
        "your account has been disabled",
        "your account was disabled",
        "we disabled your account",
        "your account has been suspended",
        "your account was suspended",
        "we suspended your account",
        "account has been deactivated",
        "account is disabled",
    )
    if not any(marker in clean_url for marker in url_markers) and not any(
        marker in clean_text for marker in text_markers
    ):
        return None
    platform_name = _platform_name(platform)
    return {
        "status": "cookie_expired",
        "health_status": "banned",
        "reason": f"{platform_name} account appears disabled or suspended.",
        "url": str(url or ""),
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
    body_text = ""
    try:
        body_text = str(page.locator("body").inner_text(timeout=5000) or "").lower()
    except Exception:
        pass
    restriction = _detect_platform_account_restriction(url, body_text, "instagram")
    if restriction is not None:
        return restriction
    if _is_verification_url(url):
        return {"status": "need_verification", "reason": "Instagram 需要输入验证码。", "url": url}
    invalid_markers = [
        "login information you entered is incorrect",
        "your password was incorrect",
        "incorrect password",
        "wrong password",
        "we couldn't find an account",
    ]
    if any(marker in body_text for marker in invalid_markers):
        return {"status": "invalid_credentials", "reason": "Instagram 提示保存的登录信息不正确。", "url": url}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        return {"status": "need_verification", "reason": "检测到验证或安全挑战文案。"}
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


def _detect_threads_login_state(page) -> dict[str, Any]:
    url = str(page.url or "")
    body_text = ""
    try:
        body_text = str(page.locator("body").inner_text(timeout=5000) or "").lower()
    except Exception:
        pass
    restriction = _detect_platform_account_restriction(url, body_text, "threads")
    if restriction is not None:
        return restriction
    if _is_verification_url(url):
        return {"status": "need_verification", "reason": "Threads/Instagram 需要输入验证码。", "url": url}
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
    if any(marker in body_text for marker in ("say more with threads", "continue with instagram")):
        return {
            "status": "account_confirmation_required",
            "reason": "Threads 已识别关联账号，等待确认继续使用该账号。",
            "url": url,
        }
    if "/login" in url:
        return {"status": "cookie_expired", "reason": "检测到 Threads 登录页面。", "url": url}
    account_confirmation_selectors = [
        'text="Continue with Instagram"',
        'text="Say more with Threads"',
        '[role="dialog"] >> text="Continue with Instagram"',
        'button:has-text("Continue with Instagram")',
        'a:has-text("Continue with Instagram")',
    ]
    for selector in account_confirmation_selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=1500):
                return {
                    "status": "account_confirmation_required",
                    "reason": "Threads 已识别关联账号，等待确认继续使用该账号。",
                    "url": url,
                }
        except Exception:
            continue
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
            return {"status": "cookie_expired", "reason": "检测到 Threads 登录表单。"}
    except Exception:
        pass
    body_text = ""
    try:
        body_text = str(page.locator("body").inner_text(timeout=5000) or "").lower()
    except Exception:
        pass
    invalid_markers = [
        "login information you entered is incorrect",
        "your password was incorrect",
        "incorrect password",
        "wrong password",
        "we couldn't find an account",
    ]
    if any(marker in body_text for marker in invalid_markers):
        return {"status": "invalid_credentials", "reason": "Instagram/Threads 提示保存的登录信息不正确。", "url": url}
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
            return _detect_instagram_login_state(page)
        return _detect_threads_login_state(page)
    return _detect_instagram_login_state(page)


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
        if attempt % 2:
            with contextlib.suppress(Exception):
                page.reload(wait_until="domcontentloaded", timeout=30000)
                page.wait_for_load_state("networkidle", timeout=8000)
        else:
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
        clicked = _click_text_button(
            page,
            logger,
            ["Continue with Instagram", "Log in with Instagram", "继续使用 Instagram", "使用 Instagram 继续"],
            "login_self_heal_continue",
        )
        if not clicked:
            _goto(page, THREADS_HOME, logger, "login_self_heal_threads")
    else:
        _goto(page, "https://www.instagram.com/accounts/login/", logger, "login_self_heal_instagram_login")
    _sleep_between(1.5, 3.0)


def _prepare_manual_threads_login_page(page, logger: AutomationLogger) -> None:
    """Normalize the one-time Threads-to-Instagram handoff for manual login."""
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
    continued = _click_text_button(
        page,
        logger,
        ["Continue with Instagram", "Log in with Instagram", "继续使用 Instagram", "使用 Instagram 继续"],
        "manual_login_continue_instagram",
    )
    logger.log(
        "info" if continued else "warn",
        "manual_login_continue_instagram",
        "Threads manual login handoff was handled.",
        {"clicked": continued, "url": _safe_navigation_url(page.url)},
    )
    if continued:
        _sleep_between(2.0, 4.0)
        with contextlib.suppress(Exception):
            page.wait_for_load_state("domcontentloaded", timeout=15000)
        return

    _goto(
        page,
        "https://www.instagram.com/accounts/login/",
        logger,
        "manual_login_instagram_fallback",
    )


def _restore_threads_after_instagram_login(page, status: dict[str, Any], logger: AutomationLogger) -> dict[str, Any]:
    if status.get("status") != "ready" or "instagram.com" not in str(page.url or "").lower():
        return status
    logger.log(
        "info",
        "manual_login_return_threads",
        "Instagram login completed; returning to Threads for final session confirmation.",
        {"url": _safe_navigation_url(page.url)},
    )
    _goto(page, THREADS_HOME, logger, "manual_login_return_threads")
    return _detect_threads_login_state(page)


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
    raise AutoLoginFailedError(reason, status, screenshot_path)


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
    # Detect the persistent Threads/Instagram session before navigating to any
    # login URL. This preserves a valid session and lets account-confirmation
    # prompts continue without clearing or retyping credentials.
    _goto(page, _platform_home(platform), logger, "open_login")
    wait_seconds = int(payload.get("login_wait_seconds") or os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "3600"))
    wait_seconds = max(30, min(wait_seconds, 3600))
    max_login_attempts = _int_payload_or_env(payload, "max_login_attempts", "SOCIAL_AUTOMATION_LOGIN_MAX_ATTEMPTS", 2, 1, 8)
    max_self_heal_attempts = _int_payload_or_env(
        payload,
        "max_self_heal_attempts",
        "SOCIAL_AUTOMATION_LOGIN_SELF_HEAL_ATTEMPTS",
        DEFAULT_LOGIN_SELF_HEAL_ATTEMPTS,
        0,
        12,
    )
    submit_grace_seconds = _int_payload_or_env(payload, "submit_grace_seconds", "SOCIAL_AUTOMATION_LOGIN_SUBMIT_GRACE_SECONDS", 30, 5, 120)
    wait_for_manual = bool(payload.get("wait_for_manual", True))
    manual_only_on_verification = bool(payload.get("manual_only_on_verification", False))
    if platform == "threads" and not auto_submit:
        _prepare_manual_threads_login_page(page, logger)
    logger.log("info", "open_login", "浏览器登录窗口已打开。", {"wait_seconds": wait_seconds, "auto_submit": auto_submit})
    deadline = time.time() + wait_seconds
    last_status: dict[str, Any] = {}
    login_attempts = 0
    self_heal_attempts = 0
    verification_hits = 0
    verification_logged = False
    last_submit_monotonic: float | None = None
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
            last_status = _detect_platform_login_state(page, platform)
            if platform == "threads":
                last_status = _restore_threads_after_instagram_login(page, last_status, logger)
            if last_status.get("status") == "ready":
                stable_status = _confirm_platform_ready(page, platform, logger, cancel_event)
                if stable_status.get("status") == "ready":
                    _complete_pending_totp_verification(context_control)
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
            if platform == "threads" and last_status.get("status") == "account_confirmation_required":
                continued = _click_text_button(
                    page,
                    logger,
                    ["Continue with Instagram", "Log in with Instagram", "继续使用 Instagram", "使用 Instagram 继续"],
                    "threads_account_confirmation",
                    abort_if=lambda: _manual_takeover_requested(context_control),
                )
                logger.log(
                    "info" if continued else "warn",
                    "threads_account_confirmation",
                    "Threads 关联账号确认流程已处理。" if continued else "Threads 关联账号确认按钮尚不可用，页面保持原状。",
                    {"clicked": continued, "url": _safe_navigation_url(page.url)},
                )
                if continued:
                    _sleep_between(1.5, 3.0)
                    continue
            if _verification_visible(page):
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
                    if str(totp_result.get("status") or "") in {
                        "ready",
                        "account_confirmation_required",
                        "totp_submitted",
                    }:
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
                _request_manual_takeover(context_control)
                shot = _screenshot(page, screenshot_dir, task, "login_invalid_credentials", logger)
                return _wait_for_manual_login_completion(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    f"{_platform_name(platform)} 保存的账号密码被拒绝，请在打开的浏览器中手动修正并继续。",
                    "invalid_credentials",
                    shot,
                    last_status,
                    context_control,
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
                    f"{_platform_name(platform)} returned a temporary error page; leaving the browser untouched.",
                    {"url": _safe_navigation_url(page.url), "screenshot_path": shot, "details": _safe_login_status(last_status)},
                    shot,
                )
                if auto_submit and post_submit_waiting:
                    time.sleep(3)
                    continue
                if auto_submit:
                    raise AutoLoginFailedError(
                        f"{_platform_name(platform)} returned a temporary error page; open a manual login session and try again.",
                        "transient_error",
                        shot,
                    )
                return _wait_or_raise_manual(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    f"{_platform_name(platform)} returned a temporary error page. The manual login browser remains open without reloads.",
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
                    continue
                elif _manual_takeover_requested(context_control):
                    continue
                elif self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, "auto_login_form_not_ready", self_heal_attempts, cancel_event, context_control)
                    continue
        except NeedManualError:
            raise
        except Exception as exc:
            message = str(exc)
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                raise NeedManualError(f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新打开登录窗口并保持到账号就绪。", "cookie_expired") from exc
            logger.log("warn", "open_login_poll", f"登录窗口状态检查失败：{exc}")
        # A manual login session belongs to the user.  Do not press Escape,
        # reload, or navigate away from the page they are actively handling.
        if auto_submit and post_submit_waiting:
            time.sleep(3)
            continue
        if post_submit_grace_expired:
            last_submit_monotonic = None
        if auto_submit:
            if self_heal_attempts < max_self_heal_attempts:
                self_heal_attempts += 1
                _self_heal_login_page(page, platform, logger, task, screenshot_dir, "login_state_not_ready", self_heal_attempts, cancel_event, context_control)
                continue
            _request_manual_takeover(context_control)
            shot = _screenshot(page, screenshot_dir, task, "login_recovery_exhausted", logger)
            reason = f"{_platform_name(platform)} 自动恢复已达到上限，请在已打开的浏览器中人工继续。"
            logger.log(
                "warn",
                "login_recovery_exhausted",
                reason,
                {"status": str(last_status.get("status") or "need_manual"), "details": last_status},
                shot,
            )
            return _wait_for_manual_login_completion(
                page,
                task,
                screenshot_dir,
                logger,
                platform,
                cancel_event,
                reason,
                str(last_status.get("status") or "need_manual"),
                shot,
                last_status,
                context_control,
            )
        time.sleep(3 if auto_submit else 10)
    shot = _screenshot(page, screenshot_dir, task, "login_wait_timeout", logger)
    return _wait_or_raise_manual(
        page,
        task,
        screenshot_dir,
        logger,
        platform,
        cancel_event,
        f"自动登录流程暂未确认完成：{last_status.get('reason') or '账号未就绪'}。浏览器会保持打开，等待人工处理或取消任务。",
        str(last_status.get("status") or "need_verification"),
        shot,
        last_status,
        wait_for_manual,
        manual_only_on_verification,
        context_control,
    )


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
    logger.log(
        "warn",
        "need_manual",
        reason,
        {"status": status, "screenshot_path": screenshot_path, "details": last_status or {}},
        screenshot_path,
    )
    last_seen_status = str(status or "")

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
        raise ManualTimeoutError(
            message,
            "manual_login_timeout",
            shot,
            account_status="cookie_expired",
        )

    while True:
        _raise_if_cancelled(cancel_event)
        if time.monotonic() >= deadline:
            raise_manual_login_timeout()
        try:
            page.title(timeout=1000)
        except Exception as exc:
            message = str(exc)
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                raise AutoLoginFailedError(
                    f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新启动登录任务。",
                    "cookie_expired",
                    screenshot_path,
                ) from exc
        if time.monotonic() >= deadline:
            raise_manual_login_timeout()
        current_status = _detect_platform_login_state(page, platform)
        if time.monotonic() >= deadline:
            raise_manual_login_timeout()
        current_code = str(current_status.get("status") or "").strip()
        if current_code == "ready":
            stable_status = _confirm_platform_ready(page, platform, logger, cancel_event)
            if time.monotonic() >= deadline:
                raise_manual_login_timeout()
            if stable_status.get("status") == "ready":
                _complete_pending_totp_verification(context_control)
                shot = _screenshot(page, screenshot_dir, task, "login_complete", logger)
                logger.log(
                    "info",
                    "completion_node",
                    f"{_platform_name(platform)} 登录成功节点已确认。",
                    {"url": _safe_navigation_url(page.url), "details": _safe_login_status(stable_status), "manual_completion": True},
                    shot,
                )
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
        wait_seconds = min(5.0, remaining_seconds)
        wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
        if callable(wait):
            if wait(wait_seconds):
                _raise_if_cancelled(cancel_event)
        else:
            time.sleep(wait_seconds)


def _confirm_platform_ready(page, platform: str, logger: AutomationLogger, cancel_event: Any | None = None) -> dict[str, Any]:
    last_status: dict[str, Any] = {}
    ready_hits = 0
    for index in range(4):
        _raise_if_cancelled(cancel_event)
        _sleep_between(0.8, 1.4)
        last_status = _detect_platform_login_state(page, platform)
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
    while remaining > 0:
        step = min(remaining, random.randint(35, 125))
        page.mouse.wheel(0, direction * step)
        remaining -= step
        segments += 1
        if direction > 0 and remaining > 0 and random.random() < 0.16:
            back_step = random.randint(25, 95)
            page.mouse.wheel(0, -back_step)
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
    restriction = _detect_platform_account_restriction(url, body_text, platform)
    if restriction is not None:
        return {
            "status": str(restriction.get("status") or "cookie_expired"),
            "health_status": str(restriction.get("health_status") or ""),
            "reason": str(restriction.get("reason") or "账号已被限制。"),
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
    if (
        _is_verification_url(url)
        or has_verification_input
        or any(marker in notice_text for marker in _verification_text_markers())
    ):
        return {
            "status": "need_verification",
            "reason": f"{_platform_name(platform)} 触发了安全验证，养号任务已停止。",
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
    if any(marker in notice_text for marker in risk_markers):
        return {
            "status": "need_verification",
            "reason": f"{_platform_name(platform)} 触发了频率或风控限制，养号任务已停止。",
        }
    return None


def _guard_warmup_risk(page, platform: str, payload: dict[str, Any], logger: AutomationLogger) -> None:
    if not bool(payload.get("stop_on_risk_limit", False)):
        return
    risk = _warmup_risk_state(page, platform)
    if risk is None:
        return
    logger.log("warn", f"{platform}_warmup_risk_limit", risk["reason"], {"status": risk["status"]})
    raise NeedManualError(
        risk["reason"],
        risk["status"],
        health_status=risk.get("health_status", ""),
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
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    shot = _screenshot(page, screenshot_dir, task, "browse_feed", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


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
            "instagram_warmup_dismiss",
        ):
            break
        dismissed = True
        logger.log("info", "instagram_warmup_dismiss", "已关闭 Instagram 平台提示弹窗。")
        _sleep_between(0.5, 1.0)
    return dismissed


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
                if not _click_text_button(page, logger, ["Post", "发布"], "instagram_warmup_comment_submit"):
                    continue
                if _wait_for_instagram_comment_echo(page, clean_text, previous_count):
                    logger.log(
                        "info",
                        "instagram_warmup_comment_confirmed",
                        "Instagram 评论内容已在页面回显。",
                        {"text": clean_text[:80]},
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
) -> dict[str, Any]:
    return _run_platform_warmup(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="instagram",
        cancel_event=cancel_event,
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
    for _ in range(2):
        url = str(page.url or "").lower()
        if "/post/" not in url and "/media" not in url:
            break
        with contextlib.suppress(Exception):
            page.keyboard.press("Escape")
        _wait_for_cancellation(random.uniform(0.8, 1.8), cancel_event)
        try:
            page.go_back(wait_until="domcontentloaded", timeout=12000)
        except Exception:
            with contextlib.suppress(Exception):
                page.keyboard.press("Alt+Left")
        _wait_for_cancellation(random.uniform(2.5, 5.5), cancel_event)
    final_url = str(page.url or "")
    if "/post/" in final_url.lower() or "/media" in final_url.lower():
        _goto(page, THREADS_HOME, logger, "threads_return_feed")
        final_url = str(page.url or "")
    logger.log("info", "threads_return_feed", "已从打开的 Threads 帖子返回信息流。", {"url": final_url})


def _post_threads_warmup_comment(
    page,
    logger: AutomationLogger,
    text: str,
    *,
    target_root=None,
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
    if not _click_threads_reply_submit(
        page,
        box,
        logger,
        "threads_warmup_reply_submit",
    ):
        return False
    if _wait_for_threads_reply_echo(page, clean_text, previous_count):
        logger.log(
            "info",
            "threads_warmup_comment_confirmed",
            "Threads 评论内容已在页面回显。",
            {"text": clean_text[:80]},
        )
        return True
    logger.log(
        "warn",
        "threads_warmup_comment_unconfirmed",
        "Threads 评论提交后未检测到内容回显，本次不计入成功数。",
        {"text": clean_text[:80]},
    )
    return False


def _warmup_interest_search_url(platform: str, topic: str) -> str:
    query = quote_plus(" ".join(str(topic or "").split()))
    if platform == "threads":
        return f"https://www.threads.net/search?q={query}"
    if platform == "instagram":
        return f"https://www.instagram.com/explore/search/keyword/?q={query}"
    raise UnsupportedActionError(f"Unsupported warmup platform: {platform}")


_WARMUP_RELEVANCE_IGNORED_TERMS = {
    "人设", "人格", "风格", "語氣", "语气", "自然", "真实", "真實",
    "中文", "简体中文", "簡體中文", "繁体中文", "繁體中文", "内容", "內容",
    "分享", "日常", "生活", "资深", "資深", "专业", "專業", "关注", "關注",
    "博主", "达人", "達人", "老师", "老師",
    "搞笑", "生活日常", "生活方式", "职场趣事", "職場趣事", "日常吐槽",
}

_WARMUP_RELEVANCE_BLOCKLIST = (
    "点击链接",
    "私信领取",
    "免费领取",
    "抽奖",
    "推广",
    "代购",
    "赚钱教程",
)


def _warmup_persona_keyword_candidates(payload: dict[str, Any], limit: int = 12) -> list[str]:
    # Prefer the explicit role/name. Topic lists can still contain useful
    # concrete terms (for example "男士短发"), but broad entries are removed
    # below before we fall back to the free-form persona context.
    sources: list[Any] = [payload.get("persona_name")]
    topics = payload.get("persona_topics")
    if isinstance(topics, list):
        sources.extend(topics)
    sources.append(payload.get("persona_context"))
    candidates: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        raw = " ".join(str(value or "").split())[:80]
        normalized = _normalize_warmup_text(raw).replace(" ", "")
        if (
            len(normalized) < 2
            or len(normalized) > 16
            or normalized in _WARMUP_RELEVANCE_IGNORED_TERMS
            # Do not turn an ignored broad phrase into a seemingly valid
            # fragment such as "生活日" or "职场" during n-gram fallback.
            or any(normalized in term for term in _WARMUP_RELEVANCE_IGNORED_TERMS if len(term) > len(normalized))
            or _is_warmup_test_content(raw)
            or normalized in seen
        ):
            return
        seen.add(normalized)
        candidates.append(raw)

    for source in sources:
        text = " ".join(str(source or "").split())
        if not text:
            continue
        for piece in re.split(r"[，,。.!！？?、；;：:/|｜\n]+", text):
            add(piece)
            for marker in ("关注", "關注", "专注", "專注", "擅长", "擅長", "围绕", "圍繞"):
                if marker in piece:
                    add(piece.split(marker, 1)[1])
        for match in re.findall(r"[\u3400-\u9fff]{2,12}", text):
            add(match)
            for size in range(2, min(4, len(match)) + 1):
                for index in range(0, len(match) - size + 1):
                    add(match[index:index + size])
        if len(candidates) >= limit:
            break
    return candidates[:limit]


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


def _warmup_relevance_keyword_set(
    payload: dict[str, Any],
    keywords: Iterable[Any] | None = None,
    *,
    limit: int = 24,
) -> list[str]:
    """Build the same concrete-term bank used by the TG warmup flow.

    Search queries can be specific phrases, while a post often only contains
    a stable two-to-four-character topic fragment (for example, ``理发店``
    from ``油头复古理发店``).  Preserve those fragments for *relevance*
    matching only; the actual search query remains the full, model-produced
    phrase.
    """
    sources: list[Any] = []
    if keywords is not None:
        sources.extend(keywords)
    sources.extend(_warmup_persona_keyword_candidates(payload, limit=24))
    expanded: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        raw = " ".join(str(value or "").split()).strip()
        normalized = _normalize_warmup_text(raw).replace(" ", "")
        if (
            len(normalized) < 2
            or len(normalized) > 16
            or normalized in _WARMUP_RELEVANCE_IGNORED_TERMS
            or _is_warmup_test_content(raw)
            or normalized in seen
        ):
            return
        seen.add(normalized)
        expanded.append(raw[:32])

    for source in sources:
        raw = " ".join(str(source or "").split())
        add(raw)
        for token in re.findall(r"[\u3400-\u9fff]{2,16}", raw):
            add(token)
            for size in range(2, min(4, len(token)) + 1):
                for index in range(0, len(token) - size + 1):
                    add(token[index:index + size])
    return expanded[:limit]


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
        12,
        3,
        30,
    )


def _generate_warmup_search_keywords_with_ai(payload: dict[str, Any]) -> list[str]:
    """Generate TG-style persona queries while retaining concrete local fallbacks."""
    fallback = _warmup_persona_keyword_candidates(payload, limit=5)
    cached = payload.get("_warmup_generated_search_keywords")
    if isinstance(cached, list):
        payload.setdefault("_warmup_search_keyword_source", "cache")
        return _sanitize_warmup_search_keywords(cached, limit=5) or fallback

    host, api_key, models = _warmup_ai_settings()
    if not host or not api_key or not models:
        payload["_warmup_generated_search_keywords"] = list(fallback)
        payload["_warmup_search_keyword_source"] = "fallback:model_unavailable"
        return fallback

    persona_name = str(payload.get("persona_name") or "当前人设").strip()
    persona_context = str(payload.get("persona_context") or "").strip()[:900]
    persona_topics = "、".join(
        str(item or "").strip() for item in (payload.get("persona_topics") or []) if str(item or "").strip()
    )[:300]
    request_kwargs = {
        "user_input": (
            f"人设名称：{persona_name}\n人设背景：{persona_context}\n关注主题：{persona_topics}\n"
            "为社交平台养号生成 3 到 5 个可直接搜索的中文短关键词。"
            "每个词必须包含具体职业、工具、作品或场景，不得只输出性格、情绪或泛生活词。"
            "只输出 JSON 数组，例如 [\"男士短发\",\"发型打理\"]；不得输出解释、测试词、营销词、链接或泛词。"
        ),
        "host": host,
        "api_key": api_key,
        "retry_count": 1,
        "request_timeout_seconds": _warmup_model_timeout_seconds(payload),
        "system_prompt": "你只负责从给定人设提炼真实、具体、适合内容搜索的关键词。",
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
                candidate = json.loads(raw[raw.find("["): raw.rfind("]") + 1])
                if isinstance(candidate, list):
                    parsed = candidate
            if not parsed:
                parsed = re.split(r"[\n,，、;；]+", raw)
            generated = _sanitize_warmup_search_keywords(parsed, limit=5)
            if generated:
                # TG's path never lets an LLM answer erase the locally derived
                # persona terms.  Keep model queries first for search quality,
                # then merge the deterministic candidates for recovery.
                merged = _sanitize_warmup_search_keywords([*generated, *fallback], limit=5)
                payload["_warmup_generated_search_keywords"] = list(merged)
                payload["_warmup_search_keyword_source"] = f"model:{model}"
                return merged
    except Exception:
        pass

    payload["_warmup_generated_search_keywords"] = list(fallback)
    payload["_warmup_search_keyword_source"] = "fallback:model_failed"
    return fallback


def _score_warmup_post_relevance(
    payload: dict[str, Any],
    target_text: Any,
    *,
    keywords: Iterable[Any] | None = None,
) -> dict[str, Any]:
    target = _normalize_warmup_text(target_text).replace(" ", "")
    cleaned_keywords = _warmup_relevance_keyword_set(payload, keywords, limit=24)
    matched: list[str] = []
    score = 0
    if target and not _is_warmup_test_content(target_text):
        for keyword in cleaned_keywords:
            normalized = _normalize_warmup_text(keyword).replace(" ", "")
            if normalized and normalized in target:
                matched.append(keyword)
                score += 5 if len(normalized) >= 4 else 3
    return {
        "relevant": score >= 3,
        "score": score,
        "matched": matched[:8],
        "keywords": cleaned_keywords,
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
                        "帖子是否明确适合该人设自然浏览和互动？只输出 JSON：{\"relevant\":true} 或 {\"relevant\":false}。"
                    ),
                    host=host,
                    api_key=api_key,
                    retry_count=1,
                    request_timeout_seconds=_warmup_model_timeout_seconds(payload),
                    system_prompt="相关性审核必须保守；模糊、无关、测试或风险内容一律 false。",
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
) -> dict[str, Any] | None:
    """Locate a persona-relevant post, searching the platform only after feed probes miss."""
    require_relevance = bool(payload.get("require_persona_relevance", True))
    keywords = _generate_warmup_search_keywords_with_ai(payload)
    if not require_relevance or not keywords:
        return _current_warmup_post_context(page, platform)

    stage = f"{platform}_warmup_relevance"

    def inspect(label: str) -> dict[str, Any] | None:
        contexts = _visible_warmup_post_contexts(page, platform, limit=12)
        previews: list[str] = []
        for candidate_index, context in enumerate(contexts):
            candidate_text = str(context.get("text") or "")
            relevance = _assess_warmup_post_relevance(
                payload,
                candidate_text,
                keywords=keywords,
            )
            if relevance["relevant"]:
                context["relevance"] = relevance
                context["selection_reason"] = f"{label}:candidate_{candidate_index + 1}"
                logger.log(
                    "info",
                    stage,
                    "已定位人设相关内容。",
                    {
                        "surface": label,
                        "candidate_index": candidate_index + 1,
                        "matched": relevance["matched"],
                        "score": relevance["score"],
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
            },
        )
        return None

    probe_limit = 3 if phase == "initial" else 2
    for probe in range(probe_limit):
        context = inspect(f"feed_probe_{probe + 1}")
        if context:
            return context
        if probe < probe_limit - 1:
            _slow_human_scroll(page)
            _sleep_between(0.8, 1.6)

    # Model output is ranked. Preserve its order so a useful primary term is
    # never skipped merely because the random sample chose weaker fallbacks.
    for keyword in keywords[:3]:
        logger.log("info", stage, "推荐流未命中人设内容，切换到人设关键词搜索。", {"keyword": keyword})
        _goto(page, _warmup_interest_search_url(platform, keyword), logger, f"{stage}_search")
        for scan in range(3):
            context = inspect(f"search:{keyword}:{scan + 1}")
            if context:
                return context
            if scan < 2:
                _slow_human_scroll(page)
                _sleep_between(0.8, 1.6)

    logger.log("warn", stage, "未找到与人设相关的内容，停止本次养号以避免无关互动。", {"keywords": keywords[:5]})
    return None


def _run_platform_warmup(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    platform: str,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    clean_platform = str(platform or "").strip().lower()
    if clean_platform not in {"threads", "instagram"}:
        raise UnsupportedActionError(f"Unsupported warmup platform: {clean_platform}")

    stage = f"{clean_platform}_warmup"
    home_url = THREADS_HOME if clean_platform == "threads" else INSTAGRAM_HOME
    _goto(page, home_url, logger, stage)
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

    persona_keywords = _generate_warmup_search_keywords_with_ai(payload)

    logger.log(
        "info",
        stage,
        f"Starting {clean_platform} warmup with the shared strategy executor.",
        {
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "browse_limit": browse_limit,
            "session_seconds": session_seconds,
            "like_limit": like_limit,
            "like_chance": like_chance,
            "max_comments": max_comments,
            "comment_chance": comment_chance,
            "search_chance": search_chance,
            "persona_name": payload.get("persona_name") or "",
            "persona_keywords": persona_keywords[:8],
            "keyword_generation_source": payload.get("_warmup_search_keyword_source") or "unknown",
        },
    )

    initial_surface = _ensure_warmup_relevant_surface(
        page,
        payload,
        logger,
        platform=clean_platform,
        phase="initial",
    )
    if bool(payload.get("require_persona_relevance", True)) and persona_keywords and not initial_surface:
        raise RuntimeError("当前推荐流与人设关键词均未找到相关内容，已停止避免无关互动。")

    liked = 0
    commented = 0
    browsed = 0
    opened_posts = 0
    like_backfills = 0
    comment_backfills = 0
    comment_screenshots: list[str] = []
    used_comment_texts: set[str] = set()
    deadline = time.monotonic() + session_seconds
    next_interaction_at = _next_warmup_interaction_at(0, payload)

    while time.monotonic() < deadline and browsed < browse_limit:
        _raise_if_cancelled(cancel_event)
        if clean_platform == "instagram":
            _dismiss_instagram_interstitials(page, logger)
        _guard_warmup_risk(page, clean_platform, payload, logger)

        # A scroll can replace the viewport entirely. Re-establish a relevant
        # post before every browse, open, like, or comment action on both platforms.
        relevant_surface = _ensure_warmup_relevant_surface(
            page,
            payload,
            logger,
            platform=clean_platform,
            phase="browse",
        )
        if bool(payload.get("require_persona_relevance", True)) and persona_keywords and not relevant_surface:
            raise RuntimeError("当前推荐流和搜索结果均未找到与人设相关的内容，已停止避免无关浏览或互动。")

        elapsed_ratio = 1 - max(
            0,
            deadline - time.monotonic(),
        ) / max(1, session_seconds)
        # ``browsed`` is the number of posts completed before the current
        # candidate.  Schedule against the 1-based candidate position so an
        # "every 1 post" strategy can interact with its very first post.
        interaction_due = (browsed + 1) >= next_interaction_at
        interacted = False
        prefer_comment = (
            interaction_due
            and like_limit > liked
            and max_comments > commented
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
        ):
            if clean_platform == "threads":
                clicked_likes = _click_some_threads_likes(
                    page,
                    logger,
                    1,
                    target_root=relevant_surface.get("root") if relevant_surface else None,
                )
            else:
                clicked_likes = _click_some_instagram_likes(
                    page,
                    logger,
                    1,
                    target_root=relevant_surface.get("root") if relevant_surface else None,
                )
                _dismiss_instagram_interstitials(page, logger)
            liked += clicked_likes
            interacted = clicked_likes > 0
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

        should_open_post = browsed > 0 and (
            random.random() < 0.12
            or (opened_posts == 0 and elapsed_ratio >= 0.3)
        )
        if should_open_post and _open_random_platform_post(
                page,
                logger,
                platform=clean_platform,
                cancel_event=cancel_event,
                target_root=relevant_surface.get("root") if relevant_surface else None,
        ):
            opened_posts += 1

        should_backfill_comment = (
            commented < min_required_comments
            or should_backfill_interaction
        ) and elapsed_ratio >= 0.45
        if (
            max_comments > commented
            and comment_chance > 0
            and interaction_due
            and not interacted
            and (
                prefer_comment
                or should_backfill_comment
                or random.randint(1, 100) <= comment_chance
            )
        ):
            target = relevant_surface or _current_warmup_post_context(page, clean_platform)
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
                    if clean_platform == "threads":
                        posted = _post_threads_warmup_comment(
                            page,
                            logger,
                            reply_text,
                            target_root=target.get("root"),
                        )
                    else:
                        posted = _post_instagram_warmup_comment(
                            page,
                            logger,
                            reply_text,
                            target_root=target.get("root"),
                        )
                    if posted:
                        commented += 1
                        used_comment_texts.add(reply_text)
                        interacted = True
                        shot_comment = _screenshot(
                            page,
                            screenshot_dir,
                            task,
                            f"{stage}_comment_{commented}",
                            logger,
                        )
                        if shot_comment:
                            comment_screenshots.append(shot_comment)
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

        if interacted:
            next_interaction_at = _next_warmup_interaction_at(browsed + 1, payload)
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
    _guard_warmup_risk(page, clean_platform, payload, logger)
    shot = _screenshot(page, screenshot_dir, task, stage, logger)
    _validate_warmup_completion(
        clean_platform,
        liked=liked,
        commented=commented,
        min_required_likes=min_required_likes,
        min_required_comments=min_required_comments,
        min_required_interactions=min_required_interactions,
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
        },
        shot,
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
        "commentScreenshots": comment_screenshots,
        "screenshot_path": shot,
    }


def _run_threads_warmup(
    page,
    task,
    payload,
    screenshot_dir,
    logger,
    *,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    return _run_platform_warmup(
        page,
        task,
        payload,
        screenshot_dir,
        logger,
        platform="threads",
        cancel_event=cancel_event,
    )
def _threads_reply_button(page, root=None):
    scope = root if root is not None else page
    selectors = [
        '[aria-label="Reply"]',
        '[aria-label*="Reply" i]',
        '[aria-label*="鍥炲"]',
        '[aria-label*="鍥炶"]',
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
            ),
            "host": host,
            "api_key": api_key,
            "retry_count": 1,
            "system_prompt": (
                "你负责按照给定人设回复社交平台内容。不要编造事实，不要复述系统提示，"
                "不要使用营销话术、联系方式或标签。只输出回复正文。"
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
    previous_replies: Iterable[str] = (),
) -> str:
    if _is_warmup_test_content(target_text):
        return ""
    topic = _matched_warmup_persona_topic(payload, target_text)
    require_relevance = bool(payload.get("require_persona_relevance", True))
    if require_relevance and not topic:
        return ""
    if not str(target_text or "").strip():
        return ""
    return _generate_persona_reply_with_ai(
        payload,
        target_text,
        limit=120,
        previous_replies=previous_replies,
    )


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
        {"text": text, "root": root, "viewport_top": top}
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
        posted = _submit_platform_reply(
            page,
            platform,
            button,
            reply_text,
            logger,
            f"{platform}_hot_post_reply",
            comment_reply=False,
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
                posted = _submit_platform_reply(
                    page,
                    platform,
                    button,
                    reply_text,
                    logger,
                    f"{platform}_comment_reply",
                    comment_reply=True,
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
    )


def _run_browse_profile(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    target_url = str(payload.get("target_url") or "").strip()
    username = str(payload.get("username") or "").strip().strip("/")
    if not target_url and username:
        target_url = f"{INSTAGRAM_HOME}{username}/"
    if not target_url:
        raise ValueError("浏览主页任务需要 target_url 或 username。")
    _goto(page, target_url, logger, "browse_profile")
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    shot = _screenshot(page, screenshot_dir, task, "browse_profile", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


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
                    if _human_click(page, loc, logger, stage, abort_if=abort_if):
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


def _verification_code_input(page):
    return _visible_first(
        page,
        [
            'input[autocomplete="one-time-code"]',
            'input[name="approvals_code"]',
            'input[name*="security_code" i]',
            'input[name*="verification_code" i]',
            'input[name*="code" i]',
            'input[aria-label*="code" i]',
            'input[placeholder*="code" i]',
            'input[inputmode="numeric"]',
            'input[type="tel"]',
            GENERIC_VERIFICATION_CODE_INPUT_SELECTOR,
        ],
        timeout_ms=500,
    )


def _classify_verification_challenge(page) -> dict[str, Any]:
    url = str(page.url or "")
    text = _page_body_text_lower(page)
    code_input = _verification_code_input(page)
    has_code_input = code_input is not None

    authenticator_markers = (
        "go to your authentication app",
        "authentication app",
        "authenticator app",
        "authenticator code",
        "code generator",
        "验证器应用",
        "身份验证器",
        "认证应用",
    )
    sms_markers = (
        "text message",
        "via sms",
        "sent a code to your phone",
        "code to your phone",
        "手机短信",
        "短信验证码",
    )
    email_markers = (
        "sent a code to your email",
        "code to your email",
        "check your email",
        "email address",
        "邮箱验证码",
        "电子邮件验证码",
        "检查你的邮箱",
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
        "请输入验证码",
    )

    challenge_type = "none"
    if any(marker in text for marker in identity_markers):
        challenge_type = "identity_challenge"
    elif any(marker in text for marker in method_markers) and not has_code_input:
        challenge_type = "method_selection"
    elif has_code_input and any(marker in text for marker in sms_markers):
        challenge_type = "sms_code"
    elif has_code_input and any(marker in text for marker in email_markers):
        challenge_type = "email_code"
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
        return challenge
    if not _is_verification_url(str(page.url or "")) and challenge_type not in {
        "unknown_challenge",
        "unknown_code",
    }:
        return challenge

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
    if isinstance(context_control, dict) and context_control.get("_totp_verification_pending"):
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
            if current_status == "account_confirmation_required":
                _report_totp_outcome(context_control, "verified")
                return {**_safe_login_status(current), "challenge_type": challenge_type}
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
                if current_status == "account_confirmation_required":
                    _report_totp_outcome(context_control, "verified")
                    return {**_safe_login_status(current), "challenge_type": current_type}
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
            logger.log(
                "info",
                "instagram_remembered_profile",
                "检测到 Instagram 已记住当前账号，正在继续使用该账号登录。",
                {"username": username, "url": _safe_navigation_url(page.url)},
            )
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

    continue_clicked = False
    if platform == "threads":
        username_entry_clicked = False
        for username_entry_attempt in range(1, 4):
            if _manual_takeover_requested(context_control):
                return False
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass
            if not _click_text_button(
                page,
                logger,
                ["Log in with username instead", "Log in with username", "Use username instead"],
                "threads_login_username_instead",
                abort_if=takeover_requested,
            ):
                continue
            username_entry_clicked = True
            _sleep_between(1.2, 2.2)
            if _visible_first(page, ['input[name="username"]', 'input[autocomplete="username"]', 'input[type="text"]'], 700) and _visible_first(page, ['input[type="password"]', 'input[autocomplete="current-password"]'], 700):
                logger.log("info", "threads_login_username_instead", "Threads username/password login entry was opened.", {"attempt": username_entry_attempt, "url": _safe_navigation_url(page.url)})
                continue_clicked = True
                break
            logger.log("warn", "threads_login_username_instead", "Threads username login entry click did not expose inputs yet; retrying.", {"attempt": username_entry_attempt, "url": _safe_navigation_url(page.url)})
        if not continue_clicked:
            if _manual_takeover_requested(context_control):
                return False
            logger.log("info", "auto_login_continue", "正在查找 Threads 的 Instagram 登录按钮。", {"url": _safe_navigation_url(page.url)})
            continue_clicked = _click_text_button(
                page,
                logger,
                ["Continue with Instagram", "Log in with Instagram", "缁х画浣跨敤 Instagram", "浣跨敤 Instagram 缁х画"],
                "threads_continue_instagram",
                abort_if=takeover_requested,
            )
            logger.log("info" if continue_clicked else "warn", "auto_login_continue", "Threads 的 Instagram 登录按钮已处理。", {"clicked": continue_clicked, "url": _safe_navigation_url(page.url)})
            if continue_clicked:
                _sleep_between(2.0, 4.0)

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
    clicked = _click_text_button(
        page,
        logger,
        ["Log in", "Log In", "Login", "Continue", "\u767b\u5f55", "\u767b\u5165", "\u7ee7\u7eed"],
        "auto_login_submit",
        abort_if=takeover_requested,
    )
    if not clicked:
        if takeover_requested():
            return False
        page.keyboard.press("Enter")
    submit_shot = _screenshot(page, screenshot_dir, task, "auto_login_submitted", logger)
    logger.log("info", "auto_login_submit", "登录表单已提交，正在等待账号就绪或验证提示。", {"clicked_submit_button": clicked, "url": _safe_navigation_url(page.url)}, submit_shot)
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


def _threads_post_button(page):
    selectors = [
        '[role="dialog"] button:has-text("Post")',
        '[role="dialog"] [role="button"]:has-text("Post")',
        'button:has-text("Post")',
        '[role="button"]:has-text("Post")',
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
    ], timeout_ms=800)


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


def _ensure_threads_compose_ready(page, logger: AutomationLogger):
    compose = _threads_dialog_compose_box(page)
    if compose is not None:
        return compose
    openers = [
        '[aria-label*="New thread" i]',
        '[aria-label*="Create" i]',
        '[aria-label*="Compose" i]',
        'button:has-text("Start a thread")',
        '[role="button"]:has-text("Start a thread")',
        'text="Start a thread"',
        'text="New thread"',
    ]
    for selector in openers:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=2000):
                _human_click(page, loc, logger, "threads_publish_open")
                _sleep_between(0.8, 1.6)
                compose = _threads_dialog_compose_box(page)
                if compose is not None:
                    return compose
        except Exception:
            continue
    inline_compose = _threads_inline_compose_box(page)
    if inline_compose is not None:
        _human_click(page, inline_compose, logger, "threads_publish_open")
        _sleep_between(0.8, 1.6)
        compose = _threads_dialog_compose_box(page)
        if compose is not None:
            return compose
    raise RuntimeError("无法打开 Threads 发帖输入框。")


def _normalize_threads_post_permalink(value: Any) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    parsed = urlparse(urljoin(THREADS_HOME, raw_url))
    host = str(parsed.hostname or "").lower()
    if host not in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
        return ""
    path = str(parsed.path or "").rstrip("/")
    if not re.fullmatch(r"/@[^/\s]+/(?:post|thread)/[^/\s]+", path, flags=re.IGNORECASE):
        return ""
    return f"https://www.threads.net{path}"


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
                const matches = Array.from(document.querySelectorAll('div, span, p')).filter(
                    node => normalize(node.innerText || node.textContent) === caption
                );
                for (const match of matches) {
                    let root = match;
                    for (let depth = 0; root && root !== document.body && depth < 12; depth += 1, root = root.parentElement) {
                        const links = root.matches?.('a[href]') ? [root] : Array.from(root.querySelectorAll('a[href]'));
                        const postLink = links.find(link => /\/@[^/]+\/(?:post|thread)\/[^/?#]+/i.test(link.href || link.getAttribute('href') || ''));
                        if (postLink) return postLink.href || postLink.getAttribute('href') || '';
                    }
                }
                const postLinks = Array.from(document.querySelectorAll('a[href]')).filter(
                    link => /\/@[^/]+\/(?:post|thread)\/[^/?#]+/i.test(link.href || link.getAttribute('href') || '')
                );
                for (const postLink of postLinks) {
                    let root = postLink;
                    for (let depth = 0; root && root !== document.body && depth < 12; depth += 1, root = root.parentElement) {
                        if (normalize(root.innerText || root.textContent).includes(caption)) {
                            return postLink.href || postLink.getAttribute('href') || '';
                        }
                    }
                }
                const profileMatch = String(window.location.pathname || '').match(/^\/(\@[^/]+)/);
                const pageText = normalize(document.body?.innerText || document.body?.textContent);
                if (profileMatch && pageText.includes(caption)) {
                    const ownPrefix = `/${profileMatch[1]}/`;
                    const ownPost = postLinks.find(link => {
                        try {
                            const path = new URL(link.href || link.getAttribute('href') || '', window.location.href).pathname;
                            return path.startsWith(ownPrefix) && /\/(?:post|thread)\//i.test(path);
                        } catch (_) {
                            return false;
                        }
                    });
                    if (ownPost) return ownPost.href || ownPost.getAttribute('href') || '';
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
            r"""() => Array.from(document.querySelectorAll('a[href]'))
                .map(link => link.href || link.getAttribute('href') || '')
                .filter(href => /\/@[^/]+\/(?:post|thread)\/[^/?#]+/i.test(href))"""
        )
    except Exception:
        return None
    permalinks: list[str] = []
    for candidate in candidates if isinstance(candidates, list) else []:
        permalink = _normalize_threads_post_permalink(candidate)
        if permalink and permalink not in permalinks:
            permalinks.append(permalink)
    return permalinks


def _threads_permalink_belongs_to_profile(permalink: str, profile_url: str) -> bool:
    post = urlparse(_normalize_threads_post_permalink(permalink))
    profile = urlparse(_normalize_threads_profile_url(profile_url))
    post_match = re.match(r"^/(@[^/]+)/", str(post.path or ""), flags=re.IGNORECASE)
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
    deadline = time.time() + 90
    saw_dialog = False
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
            if permalink and (
                not profile_url
                or (_threads_permalink_belongs_to_profile(permalink, profile_url) and (not baseline_known or permalink not in baseline))
            ):
                return {"confirmed": True, "submitted": True, "reason": "已检测到 Threads 帖子链接。", "url": permalink}
        except Exception:
            pass
        if baseline_known and caption and profile_url:
            candidate = _find_threads_post_permalink(page, caption)
            if candidate and candidate not in baseline and _threads_permalink_belongs_to_profile(candidate, profile_url):
                return {
                    "confirmed": True,
                    "submitted": True,
                    "reason": "已在提交后的页面识别到本账号新帖链接。",
                    "url": candidate,
                }
        dialog_compose = _threads_dialog_compose_box(page)
        dialog_post_button = _threads_dialog_post_button(page)
        if dialog_compose is not None or dialog_post_button is not None:
            saw_dialog = True
        elif saw_dialog:
            return {"confirmed": False, "submitted": True, "reason": "Threads 编辑器已关闭，仍需帖子链接确认。", "url": ""}
        elif time.time() > deadline - 84:
            return {"confirmed": False, "submitted": True, "reason": "Threads 已返回信息流，仍需帖子链接确认。", "url": ""}
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
        marked = page.evaluate(
            r"""() => {
                document.querySelectorAll('[data-vecto-publish-target]').forEach(node => node.removeAttribute('data-vecto-publish-target'));
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
                const controls = Array.from(dialog.querySelectorAll('button, [role="button"], div, span')).reverse();
                for (const node of controls) {
                    const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                    if (text !== 'Post') continue;
                    const clickable = node.closest('button, [role="button"]') || node;
                    const style = window.getComputedStyle(clickable);
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') continue;
                    clickable.scrollIntoView({block: 'center', inline: 'center'});
                    clickable.setAttribute('data-vecto-publish-target', '1');
                    return true;
                }
                return false;
            }"""
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
        _human_click(page, target, logger, "threads_publish_submit")
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
    while True:
        _raise_if_cancelled(cancel_event)
        if _manual_takeover_requested(context_control):
            _set_manual_takeover_waiting_for(context_control, "threads_confirmation")
        now = time.monotonic()
        if now >= deadline:
            break
        attempt += 1
        current_permalinks = _find_threads_post_permalinks(page) or []
        new_own_permalinks = [
            candidate
            for candidate in current_permalinks
            if candidate not in baseline_permalinks and _threads_permalink_belongs_to_profile(candidate, target_url)
        ]
        if str(caption or "").strip():
            matched_permalink = _find_threads_post_permalink(page, caption)
            if matched_permalink in new_own_permalinks:
                permalink = matched_permalink
            else:
                # Threads may split the post body across deeply nested nodes even
                # though the timestamp permalink is already present. The profile
                # baseline is captured immediately before submit and tasks for one
                # account are serialized, so one newly added own permalink is
                # sufficient confirmation without risking an old-post match.
                permalink = new_own_permalinks[0] if len(new_own_permalinks) == 1 else ""
        else:
            permalink = new_own_permalinks[0] if len(new_own_permalinks) == 1 else ""
        if baseline_known and permalink:
            return {"confirmed": True, "reason": "已在账号主页定位到本次发布帖子的链接。", "url": permalink}
        _wait_for_cancellation(random.uniform(1.8, 2.6), cancel_event)
        refresh_due = refresh_count < refresh_limit and now - started_at >= ((refresh_count + 1) * confirm_seconds / (refresh_limit + 1))
        if refresh_due:
            refresh_count += 1
            try:
                _raise_if_cancelled(cancel_event)
                page.reload(wait_until="commit", timeout=min(nav_timeout_ms, 5000))
            except Exception as exc:
                _raise_if_cancelled(cancel_event)
                logger.log("debug", "threads_publish_profile_refresh", "账号主页刷新未完成，将继续确认发布结果。", {"error": str(exc)[:500]})
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


def _threads_publish_evidence_page_ready(page, permalink: str) -> bool:
    expected_url = _normalize_threads_post_permalink(permalink)
    current_url = _normalize_threads_post_permalink(getattr(page, "url", ""))
    if not expected_url or current_url != expected_url:
        return False
    try:
        body_text = " ".join(str(page.locator("body").inner_text(timeout=3500) or "").lower().split())
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
    max_attempts = 3
    last_error = ""
    for attempt in range(1, max_attempts + 1):
        try:
            _goto(page, permalink, logger, "threads_publish_result", timeout_ms=20000, networkidle_ms=3500)
            if not _dismiss_threads_cookie_consent(page, logger):
                raise RuntimeError("Threads cookie consent dialog is still covering the published post.")
            if not _threads_publish_evidence_page_ready(page, permalink):
                raise RuntimeError("Threads did not remain on the confirmed published-post page.")
            _sleep_between(1.0, 1.6)
            screenshot = _screenshot(page, screenshot_dir, task, "publish_done", logger)
            if not screenshot:
                raise RuntimeError("The validated Threads publish evidence screenshot could not be saved.")
            return screenshot
        except Exception as exc:
            last_error = str(exc)
            if attempt < max_attempts:
                logger.log(
                    "warn",
                    "publish_evidence_retry",
                    "发布凭证页面尚未稳定，正在重新打开帖子页面后重试。",
                    {"url": permalink, "attempt": attempt, "max_attempts": max_attempts, "error": last_error[:500]},
                )
                _sleep_between(0.8, 1.2)
    logger.log(
        "warn",
        "publish_evidence_not_ready",
        "发布已确认，但最终帖子页面连续重试后仍未稳定，未保存异常加载页截图。",
        {"url": permalink, "attempts": max_attempts, "error": last_error[:500]},
    )
    return ""


def _capture_threads_profile_baseline(page, profile_url: str, logger: AutomationLogger) -> set[str] | None:
    if not profile_url:
        return None
    last_error = ""
    stable_empty_count = 0
    for attempt in range(2):
        try:
            _goto(page, profile_url, logger, "threads_publish_baseline", timeout_ms=5000, networkidle_ms=1500)
            permalinks = _find_threads_post_permalinks(page)
            if permalinks:
                return set(permalinks)
            if permalinks == [] and _threads_profile_is_stably_empty(page, profile_url):
                stable_empty_count += 1
                if stable_empty_count >= 2:
                    return set()
            else:
                stable_empty_count = 0
        except Exception as exc:
            last_error = str(exc)
        if attempt == 0:
            _sleep_between(0.8, 1.2)
    logger.log("warn", "threads_publish_baseline_failed", "发布前连续两次无法读取账号主页基线，任务不会点击发布。", {"error": last_error[:500]})
    return None


def _threads_profile_is_stably_empty(page, profile_url: str) -> bool:
    expected = _normalize_threads_profile_url(profile_url)
    current = _normalize_threads_profile_url(getattr(page, "url", ""))
    if not expected or current != expected:
        return False
    state = _detect_threads_login_state(page)
    if str(state.get("status") or "") != "ready":
        return False
    try:
        body_text = " ".join(str(page.locator("body").inner_text(timeout=5000) or "").lower().split())
    except Exception:
        return False
    blocked_markers = (
        "something went wrong",
        "please try again later",
        "try again",
        "unable to load",
        "couldn't refresh",
        "log in",
        "continue with instagram",
        "challenge",
        "verification",
    )
    if any(marker in body_text for marker in blocked_markers):
        return False
    empty_markers = (
        "no threads yet",
        "no posts yet",
        "hasn't posted yet",
        "has not posted yet",
        "尚未发布任何内容",
        "還沒有任何串文",
        "尚未發佈任何內容",
    )
    return any(marker in body_text for marker in empty_markers)


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
    raise ManualTimeoutError(
        message,
        "manual_publish_timeout",
        timeout_shot,
        account_status="ready",
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
        with _temporary_background_page(page, logger, "threads_publish_confirmation_background") as verification_page:
            profile_confirmation = _wait_for_threads_own_post(
                verification_page,
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
            shot = _capture_threads_publish_evidence(verification_page, permalink, caption, screenshot_dir, task, logger) if permalink else ""
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
        _resolve_completed_manual_takeover(context_control)
        return {"ok": True, "published": published, "url": permalink, "screenshot_path": shot}

    media_paths = [str(p) for p in (payload.get("media_paths") or []) if str(p or "").strip()]
    caption = str(payload.get("caption") or payload.get("content") or payload.get("text") or "").strip()
    if not caption and not media_paths:
        raise ValueError("Threads 发布任务需要正文或媒体文件。")
    missing = [p for p in media_paths if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"媒体文件不存在：{missing[0]}")
    _dismiss_threads_compose_dialogs(page, logger)
    _goto(page, THREADS_HOME, logger, "threads_publish_open")
    _dismiss_threads_compose_dialogs(page, logger)
    profile_url = _resolve_threads_profile_url(page, account)
    with _temporary_background_page(page, logger, "threads_publish_baseline_background") as verification_page:
        baseline_used_primary_page = verification_page is page
        previous_permalinks = _capture_threads_profile_baseline(verification_page, profile_url, logger)
    if previous_permalinks is None:
        raise RuntimeError("发布前无法读取 Threads 账号主页基线，已停止任务且未点击发布按钮。")
    if baseline_used_primary_page:
        _goto(page, THREADS_HOME, logger, "threads_publish_open")
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
    except Exception:
        raise
    manual_result = _pause_for_requested_threads_publish_takeover(
        page, task, payload, screenshot_dir, logger, account, profile_url,
        previous_permalinks, cancel_event, context_control,
    )
    if manual_result is not None:
        return manual_result
    _set_manual_takeover_waiting_for(context_control, "threads_text_ready")
    _human_click(page, compose, logger, "threads_publish_focus")
    if caption:
        text_input_mode = _normalize_text_input_mode(payload.get("text_input_mode") or os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste"))
        logger.log("info", "threads_publish_text_input", "正在填写 Threads 帖子正文。", {"mode": text_input_mode, "chars": len(caption)})
        _clear_and_type(page, compose, caption, mode=text_input_mode, logger=logger, stage="threads_publish_text_input")
        _sleep_between(0.8, 1.4)
        dialog_text = _threads_active_dialog_text(page)
        if caption not in dialog_text:
            compose = _threads_dialog_compose_box(page) or compose
            _clear_and_type(page, compose, caption, mode=text_input_mode, logger=logger, stage="threads_publish_text_input_retry")
            _sleep_between(0.8, 1.4)
            dialog_text = _threads_active_dialog_text(page)
        if caption not in dialog_text:
            raise RuntimeError("Threads 发帖内容没有写入当前弹窗。")
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
            raise RuntimeError("Unable to locate the media input in the active Threads composer.")
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
        raise RuntimeError("未找到 Threads 发布按钮。")
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
    permalink = _normalize_threads_post_permalink(success.get("url")) if success.get("confirmed") else ""
    profile_confirmation: dict[str, Any] = {}
    if not permalink:
        with _temporary_background_page(page, logger, "threads_publish_confirmation_background") as verification_page:
            profile_confirmation = _wait_for_threads_own_post(
                verification_page,
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
    with _temporary_background_page(page, logger, "threads_publish_evidence_background") as verification_page:
        shot = _capture_threads_publish_evidence(verification_page, permalink, caption, screenshot_dir, task, logger)
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
    body_text = _page_body_text_lower(page, timeout_ms=3500)
    if not body_text:
        return False
    blocked_markers = (
        "log in to instagram",
        "sign up to see photos",
        "sorry, this page isn't available",
        "page isn't available",
    )
    return not any(marker in body_text for marker in blocked_markers)


def _capture_instagram_profile_baseline(
    page,
    profile_url: str,
    logger: AutomationLogger,
) -> set[str] | None:
    if not profile_url:
        return None
    last_error = ""
    for attempt in range(2):
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
                return set()
            last_error = "Instagram profile did not expose a stable post grid."
        except Exception as exc:
            last_error = str(exc)
        if attempt == 0:
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
    if payload.get("warmup", True):
        _warmup_scroll(page, logger, 1)
    if not _click_text_button(page, logger, ["Create", "New post", "Create new post"], "publish_create"):
        raise RuntimeError("未找到 Instagram 创建/新建帖子按钮。")
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
            raise RuntimeError("未找到 Instagram 分享按钮。")

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


def _run_comment_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    comment = str(payload.get("comment") or payload.get("text") or "").strip()
    if not comment:
        raise ValueError("评论任务需要填写评论内容。")
    _goto(page, _target_url(payload), logger, "comment_open")
    box = page.locator('textarea[aria-label*="Add a comment"], textarea, [contenteditable="true"]').last
    box.wait_for(state="visible", timeout=30000)
    _human_click(page, box, logger, "comment_focus")
    _human_type(page, comment)
    if not _click_text_button(page, logger, ["Post"], "comment_submit"):
        raise RuntimeError("未找到评论发布按钮。")
    _sleep_between(2.0, 4.0)
    shot = _screenshot(page, screenshot_dir, task, "comment_done", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


def _run_reply_comment(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    reply = str(payload.get("reply") or payload.get("comment") or payload.get("text") or "").strip()
    target_text = str(payload.get("target_text") or "").strip()
    if not reply:
        raise ValueError("回复任务需要填写回复/评论内容。")
    _goto(page, _target_url(payload), logger, "reply_open")
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
    if not _click_text_button(page, logger, ["Post"], "reply_submit"):
        raise RuntimeError("未找到回复发布按钮。")
    _sleep_between(2.0, 4.0)
    shot = _screenshot(page, screenshot_dir, task, "reply_done", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


def _run_like_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, _target_url(payload), logger, "like_open")
    unlike = page.locator('[aria-label="Unlike"]').first
    try:
        if unlike.count() and unlike.is_visible(timeout=3000):
            shot = _screenshot(page, screenshot_dir, task, "already_liked", logger)
            return {"ok": True, "already_liked": True, "url": page.url, "screenshot_path": shot}
    except Exception:
        pass
    like = page.locator('[aria-label="Like"]').first
    if not like.count():
        raise RuntimeError("未找到点赞按钮。")
    _human_click(page, like, logger, "like_click")
    _sleep_between(1.0, 2.0)
    shot = _screenshot(page, screenshot_dir, task, "like_done", logger)
    return {"ok": True, "liked": True, "url": page.url, "screenshot_path": shot}


def _run_share_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, _target_url(payload), logger, "share_open")
    if not _click_text_button(page, logger, ["Share", "Send"], "share_button"):
        raise RuntimeError("未找到分享/发送按钮。")
    _sleep_between(1.0, 2.0)
    copied = _click_text_button(page, logger, ["Copy link"], "share_copy_link")
    shot = _screenshot(page, screenshot_dir, task, "share_done", logger)
    return {"ok": True, "copied_link": copied, "url": page.url, "screenshot_path": shot}
