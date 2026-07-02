from __future__ import annotations

import contextlib
import os
import random
import time
from pathlib import Path
from typing import Any, Protocol


INSTAGRAM_HOME = "https://www.instagram.com/"
THREADS_HOME = "https://www.threads.net/"
SUPPORTED_TASK_TYPES = {
    "check_login",
    "open_login",
    "browse_feed",
    "browse_profile",
    "threads_warmup",
    "threads_auto_reply",
    "publish_post",
    "comment_post",
    "reply_comment",
    "like_post",
    "share_post",
    "repost_post",
}


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
    def __init__(self, message: str, status: str = "need_verification"):
        super().__init__(message)
        self.status = status


class UnsupportedActionError(RuntimeError):
    pass


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
        raise UnsupportedActionError(f"Unsupported social automation task_type: {task_type}")
    platform = str(task.get("platform") or account.get("platform") or "").strip().lower()
    if platform not in {"instagram", "threads"}:
        raise UnsupportedActionError(f"Unsupported platform: {platform}")
    if platform == "instagram" and task_type in {"threads_warmup", "threads_auto_reply"}:
        raise UnsupportedActionError(f"{task_type} requires a Threads account")
    if platform == "threads" and task_type not in {"open_login", "check_login", "browse_feed", "threads_warmup", "threads_auto_reply"}:
        raise UnsupportedActionError(f"{task_type} is not implemented for Threads web automation")
    if platform == "instagram" and task_type == "repost_post":
        raise UnsupportedActionError("Instagram Web does not provide a real repost action. Use share_post/copy link instead.")

    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    data_root = Path(data_dir).resolve()
    screenshot_dir = data_root / "social_automation" / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)

    logger.log("info", "prepare", "Starting social automation task", {"task_type": task_type, "platform": platform})
    _raise_if_cancelled(cancel_event)
    with _open_camoufox_context(account=account, proxy=proxy, logger=logger, context_control=context_control) as context:
        page = _first_page(context)
        page.set_default_timeout(int(os.getenv("SOCIAL_AUTOMATION_DEFAULT_TIMEOUT_MS", "30000")))
        if task_type == "open_login":
            return _run_open_login(page, task, account, payload, screenshot_dir, logger, platform, cancel_event)
        if task_type == "check_login":
            return _run_check_login(page, task, account, payload, screenshot_dir, logger, platform)

        _raise_if_cancelled(cancel_event)
        login = _check_platform_login(page, platform, logger)
        if login.get("status") != "ready":
            raise NeedManualError(
                str(login.get("reason") or f"{platform} account requires manual login or verification"),
                str(login.get("status") or "need_verification"),
            )

        if task_type == "browse_feed":
            _raise_if_cancelled(cancel_event)
            if platform == "threads":
                return _run_threads_warmup(page, task, payload, screenshot_dir, logger)
            return _run_browse_feed(page, task, payload, screenshot_dir, logger)
        if task_type == "threads_warmup":
            _raise_if_cancelled(cancel_event)
            return _run_threads_warmup(page, task, payload, screenshot_dir, logger)
        if task_type == "threads_auto_reply":
            _raise_if_cancelled(cancel_event)
            return _run_threads_auto_reply(page, task, payload, screenshot_dir, logger)
        if task_type == "browse_profile":
            _raise_if_cancelled(cancel_event)
            return _run_browse_profile(page, task, payload, screenshot_dir, logger)
        if task_type == "publish_post":
            _raise_if_cancelled(cancel_event)
            return _run_publish_post(page, task, payload, screenshot_dir, logger)
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
    raise UnsupportedActionError(f"Unhandled social automation task_type: {task_type}")


class _BrowserContextManager:
    def __init__(self, account: dict[str, Any], proxy: dict[str, Any] | None, logger: AutomationLogger, context_control: dict[str, Any] | None = None):
        self.account = account
        self.proxy = proxy
        self.logger = logger
        self.context_control = context_control
        self.cm = None
        self.context = None

    def __enter__(self):
        try:
            from camoufox.sync_api import Camoufox
        except Exception as exc:
            raise RuntimeError(
                "Camoufox is not installed. Install dependencies with: pip install camoufox playwright"
            ) from exc

        profile_dir = Path(str(self.account.get("profile_dir") or "")).expanduser().resolve()
        profile_dir.mkdir(parents=True, exist_ok=True)
        _cleanup_stale_profile_locks(profile_dir, self.logger)
        proxy_config = _proxy_config(self.proxy)
        headless: bool | str = False
        if os.name != "nt" and str(os.getenv("SOCIAL_AUTOMATION_HEADLESS") or "").strip().lower() == "virtual":
            headless = "virtual"
        kwargs: dict[str, Any] = {
            "persistent_context": True,
            "user_data_dir": str(profile_dir),
            "headless": headless,
            "humanize": float(os.getenv("SOCIAL_AUTOMATION_HUMANIZE_MAX_SECONDS", "0.5")),
        }
        if proxy_config:
            kwargs["proxy"] = proxy_config
            kwargs["geoip"] = True
        self.logger.log(
            "info",
            "browser_launch",
            "Launching Camoufox persistent profile",
            {"profile_dir": str(profile_dir), "proxy": _masked_proxy(proxy_config), "headless": headless},
        )
        self.cm = Camoufox(**kwargs)
        try:
            self.context = self.cm.__enter__()
            if self.context_control is not None:
                self.context_control["context"] = self.context
                self.context_control["manager"] = self.cm
        except Exception as exc:
            with contextlib.suppress(Exception):
                self.cm.__exit__(type(exc), exc, getattr(exc, "__traceback__", None))
            if _should_rebuild_profile_after_launch_error(exc):
                backup_dir = _quarantine_profile_dir(profile_dir, self.logger)
                if backup_dir:
                    profile_dir.mkdir(parents=True, exist_ok=True)
                    self.logger.log(
                        "warn",
                        "profile_rebuild_retry",
                        "Browser profile failed to launch; backed up stale profile and retrying with a clean profile",
                        {"backup_dir": str(backup_dir), "profile_dir": str(profile_dir)},
                    )
                    self.cm = Camoufox(**kwargs)
                    try:
                        self.context = self.cm.__enter__()
                        if self.context_control is not None:
                            self.context_control["context"] = self.context
                            self.context_control["manager"] = self.cm
                        return self.context
                    except Exception as retry_exc:
                        with contextlib.suppress(Exception):
                            self.cm.__exit__(type(retry_exc), retry_exc, getattr(retry_exc, "__traceback__", None))
                        exc = retry_exc
            raise RuntimeError(
                "Camoufox browser failed to launch. Run `py -3 -m camoufox fetch` on Windows "
                "or `python -m camoufox fetch` on Linux/macOS to download the Camoufox browser build. "
                f"Original error: {exc}"
            ) from exc
        return self.context

    def __exit__(self, exc_type, exc, tb):
        if self.context_control is not None:
            self.context_control["context"] = None
            self.context_control["manager"] = None
        if self.cm:
            return self.cm.__exit__(exc_type, exc, tb)
        return None


def _open_camoufox_context(account: dict[str, Any], proxy: dict[str, Any] | None, logger: AutomationLogger, context_control: dict[str, Any] | None = None):
    return _BrowserContextManager(account, proxy, logger, context_control)


def _cleanup_stale_profile_locks(profile_dir: Path, logger: AutomationLogger) -> None:
    removed: list[str] = []
    for name in ("parent.lock", ".parentlock", "lock", ".startup-incomplete"):
        path = profile_dir / name
        if not path.exists():
            continue
        try:
            path.unlink()
            removed.append(name)
        except PermissionError:
            logger.log("warn", "profile_lock_active", "Profile lock is active; another browser may still be open", {"path": str(path)})
        except Exception as exc:
            logger.log("warn", "profile_lock_cleanup_failed", "Failed to clean stale profile lock", {"path": str(path), "error": str(exc)})
    if removed:
        logger.log("info", "profile_lock_cleanup", "Cleaned stale browser profile lock files", {"files": removed})


def _should_rebuild_profile_after_launch_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "timeout" in text and "launch_persistent_context" in text


def _quarantine_profile_dir(profile_dir: Path, logger: AutomationLogger) -> Path | None:
    if not profile_dir.exists():
        return None
    backup = profile_dir.with_name(f"{profile_dir.name}.broken_{int(time.time())}")
    try:
        profile_dir.rename(backup)
        return backup
    except Exception as exc:
        logger.log("warn", "profile_rebuild_failed", "Failed to back up stale browser profile", {"profile_dir": str(profile_dir), "error": str(exc)})
        return None


def _raise_if_cancelled(cancel_event: Any | None) -> None:
    if cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)():
        raise RuntimeError("Social automation task was cancelled")


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
    if masked.get("password"):
        masked["password"] = "***"
    return masked


def _first_page(context):
    pages = getattr(context, "pages", None) or []
    if pages:
        return pages[0]
    return context.new_page()


def _sleep_between(min_s: float, max_s: float) -> None:
    time.sleep(random.uniform(min_s, max_s))


def _human_type(page, text: str, min_delay: float = 0.08, max_delay: float = 0.18) -> None:
    for ch in str(text or ""):
        page.keyboard.type(ch)
        time.sleep(random.uniform(min_delay, max_delay))


def _human_click(page, locator, logger: AutomationLogger, stage: str = "click") -> None:
    locator.wait_for(state="visible", timeout=30000)
    box = locator.bounding_box()
    if not box:
        locator.click(timeout=10000)
        return
    rel_x = random.uniform(box["width"] * 0.25, box["width"] * 0.75)
    rel_y = random.uniform(box["height"] * 0.25, box["height"] * 0.75)
    logger.log("debug", stage, "Clicking target", {"x": round(box["x"] + rel_x, 1), "y": round(box["y"] + rel_y, 1)})
    locator.click(position={"x": rel_x, "y": rel_y}, timeout=10000)


def _screenshot(page, screenshot_dir: Path, task: dict[str, Any], stage: str, logger: AutomationLogger) -> str:
    path = screenshot_dir / f"{str(task.get('id') or 'task')}_{stage}_{int(time.time())}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        logger.log("info", stage, "Screenshot captured", {"path": str(path)}, str(path))
        return str(path)
    except Exception as exc:
        logger.log("warn", stage, f"Screenshot failed: {exc}")
        return ""


def _goto(page, url: str, logger: AutomationLogger, stage: str) -> None:
    logger.log("info", stage, f"Opening {url}")
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
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


def _detect_instagram_login_state(page) -> dict[str, Any]:
    url = str(page.url or "")
    if _is_verification_url(url):
        return {"status": "need_verification", "reason": "Instagram requires a verification code", "url": url}
    if "/accounts/login" in url:
        return {"status": "cookie_expired", "reason": "Instagram login page is visible", "url": url}
    login_inputs = page.locator(
        'input[name="username"], input[name="password"], '
        'input[aria-label*="username" i], input[aria-label*="email" i], input[aria-label*="password" i], '
        'input[placeholder*="username" i], input[placeholder*="email" i], input[placeholder*="password" i]'
    )
    try:
        if login_inputs.count() > 0 and login_inputs.first.is_visible():
            return {"status": "cookie_expired", "reason": "Login form is visible"}
    except Exception:
        pass
    body_text = ""
    try:
        body_text = page.locator("body").inner_text(timeout=5000).lower()
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
        return {"status": "invalid_credentials", "reason": "Instagram says the saved login information is incorrect", "url": url}
    login_markers = ["log into instagram", "log in with facebook", "forgot password", "create new account"]
    if any(marker in body_text for marker in login_markers):
        return {"status": "cookie_expired", "reason": "Instagram login page text is visible"}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        return {"status": "need_verification", "reason": "Verification or challenge text is visible"}
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
                return {"status": "ready", "reason": "Instagram home UI is visible", "url": url}
        except Exception:
            continue
    return {"status": "ready", "reason": "No login or verification UI detected", "url": url}


def _detect_threads_login_state(page) -> dict[str, Any]:
    url = str(page.url or "")
    if _is_verification_url(url):
        return {"status": "need_verification", "reason": "Threads/Instagram requires a verification code", "url": url}
    if "/login" in url:
        return {"status": "cookie_expired", "reason": "Threads login page is visible", "url": url}
    login_prompt_selectors = [
        'text="Log in or sign up for Threads"',
        'text="Continue with Instagram"',
        'text="Log in with username instead"',
        'text="Say more with Threads"',
        '[role="dialog"] >> text="Continue with Instagram"',
        'button:has-text("Continue with Instagram")',
        'a:has-text("Continue with Instagram")',
    ]
    for selector in login_prompt_selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=1500):
                return {"status": "cookie_expired", "reason": "Threads login prompt is visible", "url": url}
        except Exception:
            continue
    login_inputs = page.locator(
        'input[name="username"], input[name="password"], '
        'input[autocomplete="username"], input[autocomplete="current-password"], '
        'input[placeholder*="username" i], input[placeholder*="phone" i], input[placeholder*="email" i], input[placeholder*="password" i]'
    )
    try:
        if login_inputs.count() > 0 and login_inputs.first.is_visible():
            return {"status": "cookie_expired", "reason": "Threads login form is visible"}
    except Exception:
        pass
    body_text = ""
    try:
        body_text = page.locator("body").inner_text(timeout=5000).lower()
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
        return {"status": "invalid_credentials", "reason": "Instagram/Threads says the saved login information is incorrect", "url": url}
    login_markers = ["log in", "login", "continue with instagram", "forgot password", "sign up"]
    if any(marker in body_text for marker in login_markers) and any(marker in body_text for marker in ["threads", "instagram"]):
        return {"status": "cookie_expired", "reason": "Threads login page text is visible", "url": url}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        return {"status": "need_verification", "reason": "Verification or challenge text is visible"}

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
        return {"status": "ready", "reason": "Threads authenticated UI is visible", "url": url, "matched_markers": matched}

    if any(marker in body_text for marker in ("log in", "continue with instagram", "continue with facebook", "sign up")):
        return {"status": "cookie_expired", "reason": "Threads login prompt is visible", "url": url}
    return {"status": "cookie_expired", "reason": "Threads authenticated UI was not detected yet", "url": url, "matched_markers": matched}


def _platform_home(platform: str) -> str:
    return THREADS_HOME if platform == "threads" else INSTAGRAM_HOME


def _platform_name(platform: str) -> str:
    return "Threads" if platform == "threads" else "Instagram"


def _is_verification_url(url: str) -> bool:
    return any(
        part in url
        for part in (
            "/challenge",
            "/checkpoint",
            "/two_step_verification",
            "two_factor_login",
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
        "suspicious",
        "challenge",
        "verify your account",
        "help us confirm",
        "验证码",
        "两步验证",
        "双重验证",
        "安全码",
    ]


def _detect_platform_login_state(page, platform: str) -> dict[str, Any]:
    if platform == "threads":
        return _detect_threads_login_state(page)
    return _detect_instagram_login_state(page)


def _run_open_login(page, task, account, payload, screenshot_dir, logger, platform: str = "instagram", cancel_event: Any | None = None) -> dict[str, Any]:
    _goto(page, _platform_home(platform), logger, "open_login")
    wait_seconds = int(payload.get("login_wait_seconds") or os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "600"))
    wait_seconds = max(30, min(wait_seconds, 3600))
    auto_submit = bool(payload.get("auto_submit") or payload.get("login_password") or payload.get("password"))
    logger.log("info", "open_login", "Browser is open for login", {"wait_seconds": wait_seconds, "auto_submit": auto_submit})
    deadline = time.time() + wait_seconds
    last_status: dict[str, Any] = {}
    login_attempts = 0
    verification_logged = False
    while time.time() < deadline:
        _raise_if_cancelled(cancel_event)
        try:
            last_status = _detect_platform_login_state(page, platform)
            if last_status.get("status") == "ready":
                stable_status = _confirm_platform_ready(page, platform, logger, cancel_event)
                if stable_status.get("status") == "ready":
                    shot = _screenshot(page, screenshot_dir, task, "login_complete", logger)
                    logger.log(
                        "info",
                        "completion_node",
                        f"{_platform_name(platform)} login completion node detected",
                        {"url": str(page.url or ""), "details": stable_status},
                        shot,
                    )
                    return {"ok": True, "status": "ready", "screenshot_path": shot, "details": stable_status}
                last_status = stable_status
            if last_status.get("status") == "invalid_credentials":
                shot = _screenshot(page, screenshot_dir, task, "login_invalid_credentials", logger)
                raise NeedManualError(
                    f"{_platform_name(platform)} 保存的登录资料被平台判定不正确，请在网页端更新保存的账号/密码后重试；screenshot={shot}",
                    "cookie_expired",
                )
            if last_status.get("status") == "need_verification":
                shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
                logger.log(
                    "warn",
                    "login_verification_required",
                    f"{_platform_name(platform)} requires a verification code",
                    {"url": str(page.url or ""), "screenshot_path": shot, "details": last_status},
                    shot,
                )
                raise NeedManualError(
                    f"{_platform_name(platform)} 需要人工输入验证码或完成二次验证；screenshot={shot}",
                    "need_verification",
                )
            if auto_submit and login_attempts < 2 and str(last_status.get("status") or "") != "need_verification":
                if _auto_submit_login_form(page, platform, payload, logger, task, screenshot_dir):
                    login_attempts += 1
            if _verification_visible(page):
                if not verification_logged:
                    shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
                    logger.log(
                        "warn",
                        "login_verification_required",
                        "Verification or security challenge is visible; waiting for manual intervention in the open browser",
                        {"url": str(page.url or ""), "screenshot_path": shot},
                        shot,
                    )
                    verification_logged = True
                raise NeedManualError(
                    f"{_platform_name(platform)} 需要人工输入验证码或完成二次验证；screenshot={shot}",
                    "need_verification",
                )
        except NeedManualError:
            raise
        except Exception as exc:
            message = str(exc)
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                raise NeedManualError(f"{_platform_name(platform)} 登录窗口已关闭，未检测到登录成功。请重新点击“打开登录窗口”并保持窗口打开直到账号状态变为可执行。", "cookie_expired") from exc
            logger.log("warn", "open_login_poll", f"Login window status check failed: {exc}")
        time.sleep(3 if auto_submit else 10)
    shot = _screenshot(page, screenshot_dir, task, "login_wait_timeout", logger)
    raise NeedManualError(
        f"Manual login window timed out: {last_status.get('reason') or 'not ready'}; screenshot={shot}",
        str(last_status.get("status") or "need_verification"),
    )


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
            logger.log("debug", "login_ready_confirm", "Ready state was not stable yet", {"index": index + 1, "status": last_status})
    return last_status or {"status": "cookie_expired", "reason": "Ready state was not stable"}


def _run_check_login(page, task, account, payload, screenshot_dir, logger, platform: str = "instagram") -> dict[str, Any]:
    status = _check_platform_login(page, platform, logger)
    shot = _screenshot(page, screenshot_dir, task, "check_login", logger)
    if status.get("status") != "ready":
        raise NeedManualError(str(status.get("reason") or f"{_platform_name(platform)} is not ready"), str(status.get("status") or "need_verification"))
    logger.log("info", "completion_node", f"{_platform_name(platform)} check-login completion node detected", {"details": status}, shot)
    return {"ok": True, "status": "ready", "screenshot_path": shot, "details": status}


def _warmup_scroll(page, logger: AutomationLogger, times: int = 2) -> None:
    for index in range(max(1, times)):
        delta = random.randint(450, 900)
        page.mouse.wheel(0, delta)
        logger.log("debug", "warmup", "Scrolled feed", {"index": index + 1, "delta": delta})
        _sleep_between(2.0, 5.0)


def _run_browse_feed(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, INSTAGRAM_HOME, logger, "browse_feed")
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    shot = _screenshot(page, screenshot_dir, task, "browse_feed", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


def _threads_like_buttons(page):
    selectors = [
        '[aria-label="Like"]',
        '[aria-label*="Like" i]',
        '[aria-label*="赞"]',
        'button:has-text("Like")',
    ]
    locators = []
    for selector in selectors:
        try:
            locators.append(page.locator(selector))
        except Exception:
            continue
    return locators


def _click_some_threads_likes(page, logger: AutomationLogger, limit: int) -> int:
    clicked = 0
    if limit <= 0:
        return clicked
    for group in _threads_like_buttons(page):
        try:
            count = min(group.count(), limit - clicked)
        except Exception:
            continue
        for index in range(count):
            try:
                loc = group.nth(index)
                if loc.is_visible(timeout=1000):
                    _human_click(page, loc, logger, "threads_like")
                    clicked += 1
                    _sleep_between(1.0, 2.5)
                    if clicked >= limit:
                        return clicked
            except Exception:
                continue
    return clicked


def _run_threads_warmup(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, THREADS_HOME, logger, "threads_warmup")
    scroll_times = int(payload.get("scroll_times") or payload.get("browse_count") or 6)
    like_limit = int(payload.get("like_limit") or 0)
    logger.log("info", "threads_warmup", "Starting Threads warmup from persona automation settings", {
        "scroll_times": scroll_times,
        "like_limit": like_limit,
        "persona_name": payload.get("persona_name") or "",
    })
    liked = 0
    for index in range(max(1, scroll_times)):
        if like_limit > liked and index % 2 == 1:
            liked += _click_some_threads_likes(page, logger, like_limit - liked)
        delta = random.randint(500, 950)
        page.mouse.wheel(0, delta)
        logger.log("debug", "threads_warmup", "Scrolled Threads feed", {"index": index + 1, "delta": delta})
        _sleep_between(2.0, 5.0)
    shot = _screenshot(page, screenshot_dir, task, "threads_warmup", logger)
    logger.log(
        "info",
        "completion_node",
        "Threads warmup completion node detected",
        {"url": str(page.url or ""), "liked": liked, "scrolled": scroll_times},
        shot,
    )
    return {"ok": True, "url": page.url, "liked": liked, "scrolled": scroll_times, "screenshot_path": shot}


def _threads_reply_button(page):
    selectors = [
        '[aria-label="Reply"]',
        '[aria-label*="Reply" i]',
        '[aria-label*="回复"]',
        '[aria-label*="回覆"]',
        'button:has-text("Reply")',
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector).first
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
        'div[aria-label*="回复"]',
        'div[aria-label*="回覆"]',
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector).last
            if loc.count() and loc.is_visible(timeout=2500):
                return loc
        except Exception:
            continue
    return None


def _pick_persona_reply(payload: dict[str, Any]) -> str:
    templates = [str(item or "").strip() for item in (payload.get("reply_templates") or []) if str(item or "").strip()]
    if templates:
        return random.choice(templates)[:180]
    persona_name = str(payload.get("persona_name") or "").strip()
    if persona_name:
        return f"这个角度挺适合 {persona_name} 继续观察。"
    return "这个角度值得继续观察。"


def _run_threads_auto_reply(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, THREADS_HOME, logger, "threads_auto_reply_open")
    max_posts = max(1, min(int(payload.get("max_posts") or 5), 20))
    max_replies = max(1, min(int(payload.get("max_replies") or 3), 10))
    replied = 0
    scanned = 0
    reply_screenshots: list[str] = []
    logger.log("info", "threads_auto_reply", "Starting persona-driven Threads auto reply", {
        "max_posts": max_posts,
        "max_replies": max_replies,
        "persona_name": payload.get("persona_name") or "",
        "threads_handle": payload.get("threads_handle") or "",
    })
    completion_reason = "max_posts_scanned"
    for index in range(max_posts):
        scanned += 1
        button = _threads_reply_button(page)
        if button is not None:
            reply_text = _pick_persona_reply(payload)
            _human_click(page, button, logger, "threads_reply_button")
            _sleep_between(1.0, 2.5)
            box = _threads_text_box(page)
            if box is None:
                logger.log("warn", "threads_reply_box", "Reply textbox was not visible after clicking reply")
            else:
                _human_click(page, box, logger, "threads_reply_focus")
                _human_type(page, reply_text, min_delay=0.10, max_delay=0.22)
                posted = _click_text_button(page, logger, ["Post", "Reply", "发布", "回覆", "回复"], "threads_reply_submit")
                if posted:
                    replied += 1
                    _sleep_between(2.0, 4.0)
                    shot = _screenshot(page, screenshot_dir, task, f"threads_reply_{replied}", logger)
                    if shot:
                        reply_screenshots.append(shot)
                    logger.log("info", "threads_auto_reply", "Replied with persona text", {"reply_index": replied, "text": reply_text[:80]})
                    if replied >= max_replies:
                        completion_reason = "target_replies_reached"
                        break
                else:
                    logger.log("warn", "threads_reply_submit", "Could not find Threads post/reply submit button")
        page.mouse.wheel(0, random.randint(550, 950))
        _sleep_between(2.0, 5.0)
    shot = _screenshot(page, screenshot_dir, task, "threads_auto_reply_done", logger)
    logger.log(
        "info",
        "completion_node",
        "Threads auto-reply completion node detected",
        {"url": str(page.url or ""), "scannedPosts": scanned, "replied": replied, "completionReason": completion_reason},
        shot,
    )
    return {
        "ok": True,
        "url": page.url,
        "scannedPosts": scanned,
        "scannedComments": scanned,
        "replied": replied,
        "skipped": max(0, scanned - replied),
        "completionReason": completion_reason,
        "replyScreenshots": reply_screenshots,
        "screenshot_path": shot,
    }


def _run_browse_profile(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    target_url = str(payload.get("target_url") or "").strip()
    username = str(payload.get("username") or "").strip().strip("/")
    if not target_url and username:
        target_url = f"{INSTAGRAM_HOME}{username}/"
    if not target_url:
        raise ValueError("browse_profile requires target_url or username")
    _goto(page, target_url, logger, "browse_profile")
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    shot = _screenshot(page, screenshot_dir, task, "browse_profile", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


def _click_text_button(page, logger: AutomationLogger, names: list[str], stage: str):
    for name in names:
        locators = [
            page.get_by_role("button", name=name).first,
            page.get_by_text(name, exact=True).first,
            page.locator(f'[aria-label="{name}"]').first,
        ]
        for loc in locators:
            try:
                if loc.count() and loc.is_visible(timeout=2500):
                    _human_click(page, loc, logger, stage)
                    return True
            except Exception:
                continue
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


def _clear_and_type(page, locator, text: str) -> None:
    locator.wait_for(state="visible", timeout=10000)
    locator.evaluate(
        """element => {
            element.focus();
            if (typeof element.select === 'function') element.select();
            else if (element.isContentEditable) document.getSelection().selectAllChildren(element);
        }""",
        timeout=10000,
    )
    page.keyboard.press("Control+A")
    page.keyboard.press("Backspace")
    _human_type(page, text, min_delay=0.07, max_delay=0.16)


def _auto_submit_login_form(page, platform: str, payload: dict[str, Any], logger: AutomationLogger, task: dict[str, Any], screenshot_dir: Path) -> bool:
    username = str(payload.get("login_username") or payload.get("username") or "").strip()
    password = str(payload.get("login_password") or payload.get("password") or "").strip()
    if not username or not password:
        return False
    start_shot = _screenshot(page, screenshot_dir, task, "auto_login_start", logger)
    logger.log("info", "auto_login_start", f"Starting {_platform_name(platform)} automatic credential input", {"username": username, "url": str(page.url or "")}, start_shot)

    continue_clicked = False
    if platform == "threads":
        logger.log("info", "auto_login_continue", "Looking for Threads Instagram login button", {"url": str(page.url or "")})
        continue_clicked = _click_text_button(
            page,
            logger,
            ["Continue with Instagram", "Log in with Instagram", "继续使用 Instagram", "使用 Instagram 继续"],
            "threads_continue_instagram",
        )
        logger.log("info" if continue_clicked else "warn", "auto_login_continue", "Threads Instagram login button processed", {"clicked": continue_clicked, "url": str(page.url or "")})
        if continue_clicked:
            _sleep_between(2.0, 4.0)

    logger.log("info", "auto_login_find_inputs", "Looking for username and password inputs", {"url": str(page.url or "")})
    username_input = _visible_first(page, [
        'input[name="username"]',
        'input[autocomplete="username"]',
        'input[type="text"]',
        'input[aria-label*="username" i]',
        'input[aria-label*="phone" i]',
        'input[aria-label*="email" i]',
        'input[placeholder*="username" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="email" i]',
    ])
    password_input = _visible_first(page, [
        'input[name="password"]',
        'input[autocomplete="current-password"]',
        'input[type="password"]',
        'input[aria-label*="password" i]',
        'input[placeholder*="password" i]',
    ])
    if username_input is None or password_input is None:
        shot = _screenshot(page, screenshot_dir, task, "auto_login_inputs_missing", logger)
        logger.log("warn", "auto_login_inputs_missing", "Login inputs were not visible for automatic credential input", {"continued": continue_clicked, "url": str(page.url or "")}, shot)
        return False

    try:
        logger.log("info", "auto_login_type_username", "Typing username into login form", {"username": username})
        _clear_and_type(page, username_input, username)
        _sleep_between(0.4, 0.9)
        logger.log("info", "auto_login_type_password", "Typing password into login form", {"password": "***"})
        _clear_and_type(page, password_input, password)
        _sleep_between(0.4, 0.9)
    except Exception as exc:
        shot = _screenshot(page, screenshot_dir, task, "auto_login_type_failed", logger)
        logger.log("warn", "auto_login_type_failed", "Automatic credential typing failed", {"error": str(exc), "url": str(page.url or "")}, shot)
        return False
    filled_shot = _screenshot(page, screenshot_dir, task, "auto_login_form_filled", logger)
    logger.log("info", "auto_login_form_filled", "Login form has been filled", {"username": username, "password": "***"}, filled_shot)
    clicked = _click_text_button(
        page,
        logger,
        ["Log in", "Log In", "Login", "Continue", "登录", "登入", "继续"],
        "auto_login_submit",
    )
    if not clicked:
        page.keyboard.press("Enter")
    submit_shot = _screenshot(page, screenshot_dir, task, "auto_login_submitted", logger)
    logger.log("info", "auto_login_submit", "Login form submitted; waiting for ready state or verification", {"clicked_submit_button": clicked, "url": str(page.url or "")}, submit_shot)
    _sleep_between(4.0, 7.0)
    return True


def _verification_visible(page) -> bool:
    url = str(page.url or "")
    if _is_verification_url(url):
        return True
    markers = [
        "verification code",
        "enter the code",
        "security code",
        "two-factor",
        "two factor",
        "confirm it's you",
        "suspicious",
        "challenge",
        "verify your account",
        "help us confirm",
        "验证码",
        "驗證碼",
        "安全码",
        "安全碼",
    ]
    try:
        text = page.locator("body").inner_text(timeout=3000).lower()
    except Exception:
        text = ""
    return any(marker in text for marker in markers)


def _run_publish_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    media_paths = [str(p) for p in (payload.get("media_paths") or []) if str(p or "").strip()]
    caption = str(payload.get("caption") or "").strip()
    if not media_paths:
        raise ValueError("publish_post requires media_paths")
    missing = [p for p in media_paths if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"Media file not found: {missing[0]}")
    _goto(page, INSTAGRAM_HOME, logger, "publish_open")
    if payload.get("warmup", True):
        _warmup_scroll(page, logger, 1)
    if not _click_text_button(page, logger, ["Create", "New post", "Create new post"], "publish_create"):
        raise RuntimeError("Could not find Instagram create/new post button")
    file_input = page.locator('input[type="file"]').first
    file_input.wait_for(state="attached", timeout=30000)
    logger.log("info", "publish_upload", "Uploading media", {"count": len(media_paths)})
    file_input.set_input_files(media_paths)
    for stage in ("publish_next_1", "publish_next_2"):
        _sleep_between(1.0, 2.0)
        if not _click_text_button(page, logger, ["Next"], stage):
            logger.log("debug", stage, "Next button not found; continuing")
            break
    if caption:
        caption_box = page.locator('textarea, [contenteditable="true"]').last
        caption_box.wait_for(state="visible", timeout=30000)
        _human_click(page, caption_box, logger, "publish_caption_focus")
        _human_type(page, caption)
    if not _click_text_button(page, logger, ["Share"], "publish_share"):
        raise RuntimeError("Could not find Instagram Share button")
    success = _wait_for_publish_success(page, logger)
    shot = _screenshot(page, screenshot_dir, task, "publish_done", logger)
    time.sleep(5)
    return {"ok": True, "published": success, "url": page.url, "screenshot_path": shot}


def _wait_for_publish_success(page, logger: AutomationLogger) -> dict[str, Any]:
    deadline = time.time() + 90
    markers = ["Your post has been shared.", "Post shared", "Your reel has been shared."]
    while time.time() < deadline:
        try:
            body = page.locator("body").inner_text(timeout=3000)
            if any(marker.lower() in body.lower() for marker in markers):
                return {"confirmed": True, "reason": "success text visible"}
        except Exception:
            pass
        if "/p/" in str(page.url or "") or str(page.url or "").rstrip("/") == INSTAGRAM_HOME.rstrip("/"):
            return {"confirmed": True, "reason": "page redirected after share"}
        time.sleep(2)
    logger.log("warn", "publish_confirm", "Publish confirmation timed out", {"url": page.url})
    return {"confirmed": False, "reason": "timeout waiting for confirmation"}


def _target_url(payload: dict[str, Any]) -> str:
    url = str(payload.get("target_url") or payload.get("post_url") or "").strip()
    if not url:
        raise ValueError("target_url is required")
    return url


def _run_comment_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    comment = str(payload.get("comment") or payload.get("text") or "").strip()
    if not comment:
        raise ValueError("comment_post requires comment")
    _goto(page, _target_url(payload), logger, "comment_open")
    box = page.locator('textarea[aria-label*="Add a comment"], textarea, [contenteditable="true"]').last
    box.wait_for(state="visible", timeout=30000)
    _human_click(page, box, logger, "comment_focus")
    _human_type(page, comment)
    if not _click_text_button(page, logger, ["Post"], "comment_submit"):
        raise RuntimeError("Could not find comment Post button")
    _sleep_between(2.0, 4.0)
    shot = _screenshot(page, screenshot_dir, task, "comment_done", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


def _run_reply_comment(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    reply = str(payload.get("reply") or payload.get("comment") or payload.get("text") or "").strip()
    target_text = str(payload.get("target_text") or "").strip()
    if not reply:
        raise ValueError("reply_comment requires reply/comment text")
    _goto(page, _target_url(payload), logger, "reply_open")
    _warmup_scroll(page, logger, 1)
    if target_text:
        try:
            page.get_by_text(target_text, exact=False).first.scroll_into_view_if_needed(timeout=8000)
        except Exception:
            logger.log("warn", "reply_target", "Target comment text was not found before replying", {"target_text": target_text[:80]})
    if not _click_text_button(page, logger, ["Reply"], "reply_button"):
        raise RuntimeError("Could not find Reply button")
    box = page.locator('textarea, [contenteditable="true"]').last
    box.wait_for(state="visible", timeout=30000)
    _human_click(page, box, logger, "reply_focus")
    _human_type(page, reply)
    if not _click_text_button(page, logger, ["Post"], "reply_submit"):
        raise RuntimeError("Could not find reply Post button")
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
        raise RuntimeError("Could not find Like button")
    _human_click(page, like, logger, "like_click")
    _sleep_between(1.0, 2.0)
    shot = _screenshot(page, screenshot_dir, task, "like_done", logger)
    return {"ok": True, "liked": True, "url": page.url, "screenshot_path": shot}


def _run_share_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, _target_url(payload), logger, "share_open")
    if not _click_text_button(page, logger, ["Share", "Send"], "share_button"):
        raise RuntimeError("Could not find Share/Send button")
    _sleep_between(1.0, 2.0)
    copied = _click_text_button(page, logger, ["Copy link"], "share_copy_link")
    shot = _screenshot(page, screenshot_dir, task, "share_done", logger)
    return {"ok": True, "copied_link": copied, "url": page.url, "screenshot_path": shot}
