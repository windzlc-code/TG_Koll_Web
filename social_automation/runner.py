from __future__ import annotations

import contextlib
import os
import random
import re
import threading
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
    def __init__(self, message: str, status: str = "need_verification", screenshot_path: str = ""):
        super().__init__(message)
        self.status = status
        self.screenshot_path = str(screenshot_path or "")


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
        raise UnsupportedActionError(f"不支持的社交自动化任务类型：{task_type}")
    platform = str(task.get("platform") or account.get("platform") or "").strip().lower()
    if platform not in {"instagram", "threads"}:
        raise UnsupportedActionError(f"不支持的平台：{platform}")
    if platform == "instagram" and task_type in {"threads_warmup", "threads_auto_reply"}:
        raise UnsupportedActionError(f"{task_type} 需要使用 Threads 账号。")
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
            return _run_open_login(page, task, account, payload, screenshot_dir, logger, platform, cancel_event)
        if task_type == "check_login":
            return _run_check_login(page, task, account, payload, screenshot_dir, logger, platform)

        _raise_if_cancelled(cancel_event)
        login = _check_platform_login(page, platform, logger)
        if login.get("status") != "ready":
            shot = _screenshot(page, screenshot_dir, task, "login_not_ready", logger)
            logger.log("warn", "need_manual", str(login.get("reason") or f"{_platform_name(platform)} 账号需要人工登录或验证。"), {"details": login}, shot)
            raise NeedManualError(
                str(login.get("reason") or f"{_platform_name(platform)} 账号需要人工登录或验证。"),
                str(login.get("status") or "need_verification"),
                shot,
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
            return _run_publish_post(page, task, payload, screenshot_dir, logger, platform)
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
        try:
            from camoufox.sync_api import Camoufox
        except Exception as exc:
            raise RuntimeError(
                "Camoufox 未安装，请先安装依赖：pip install camoufox playwright"
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
        if proxy_config:
            kwargs["proxy"] = proxy_config
            kwargs["geoip"] = True
        self.logger.log(
            "info",
            "browser_launch",
            "正在启动 Camoufox 指纹浏览器环境。",
            {"profile_dir": str(profile_dir), "proxy": _masked_proxy(proxy_config), "headless": headless},
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
            self._stop_live_browser_session()
            raise RuntimeError(
                "Camoufox 浏览器启动失败。请在 Windows 执行 `py -3 -m camoufox fetch`，"
                "或在 Linux/macOS 执行 `python -m camoufox fetch` 下载浏览器构建。"
                f"原始错误：{exc}"
            ) from exc
        return self.context

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None and self._detach_live_browser_for_standby():
            return None
        if self.context_control is not None:
            self.context_control["context"] = None
            self.context_control["manager"] = None
            self.context_control["live_browser_session_id"] = ""
        if self.cm:
            result = self.cm.__exit__(exc_type, exc, tb)
            self._stop_live_browser_session()
            return result
        self._stop_live_browser_session()
        return None

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
    return "timeout" in text and "launch_persistent_context" in text


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
    if masked.get("password"):
        masked["password"] = "***"
    return masked


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
    viewport = {
        "width": max(1024, width),
        "height": max(640, height - 90),
    }
    try:
        page.set_viewport_size(viewport)
        logger.log("info", "live_browser_viewport", "已同步实时监控窗口尺寸。", viewport)
    except Exception as exc:
        logger.log("warn", "live_browser_viewport_failed", "实时监控窗口尺寸同步失败，任务继续执行。", {"error": str(exc), "viewport": viewport})


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


def _human_type(page, text: str, min_delay: float = 0.08, max_delay: float = 0.18) -> None:
    for ch in str(text or ""):
        page.keyboard.type(ch)
        time.sleep(random.uniform(min_delay, max_delay))


def _human_click(page, locator, logger: AutomationLogger, stage: str = "click") -> None:
    locator.wait_for(state="visible", timeout=30000)
    try:
        locator.scroll_into_view_if_needed(timeout=5000)
        _sleep_between(0.2, 0.5)
    except Exception:
        pass
    box = locator.bounding_box()
    if not box:
        locator.click(timeout=10000)
        return
    viewport = page.viewport_size or {"width": 1280, "height": 720}
    if box["y"] < 0 or box["y"] + box["height"] > viewport["height"] or box["x"] < 0 or box["x"] + box["width"] > viewport["width"]:
        locator.scroll_into_view_if_needed(timeout=5000)
        _sleep_between(0.2, 0.5)
        box = locator.bounding_box()
        if not box:
            locator.click(timeout=10000)
            return
    rel_x = random.uniform(box["width"] * 0.25, box["width"] * 0.75)
    rel_y = random.uniform(box["height"] * 0.25, box["height"] * 0.75)
    logger.log("debug", stage, "正在点击目标元素。", {"x": round(box["x"] + rel_x, 1), "y": round(box["y"] + rel_y, 1)})
    locator.click(position={"x": rel_x, "y": rel_y}, timeout=10000)


def _screenshot(page, screenshot_dir: Path, task: dict[str, Any], stage: str, logger: AutomationLogger) -> str:
    if not _should_capture_screenshot(stage):
        return ""
    path = screenshot_dir / f"{str(task.get('id') or 'task')}_{stage}_{int(time.time())}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        logger.log("info", stage, "已保存截图。", {"path": str(path)}, str(path))
        return str(path)
    except Exception as exc:
        logger.log("warn", stage, f"截图失败：{exc}")
        return ""


def _should_capture_screenshot(stage: str) -> bool:
    mode = str(os.getenv("SOCIAL_AUTOMATION_SCREENSHOT_MODE") or "checkpoint").strip().lower()
    if mode in {"debug", "all", "full"}:
        return True
    return str(stage or "") in {
        "auto_login_start",
        "auto_login_form_filled",
        "login_verification_required",
        "login_invalid_credentials",
        "login_wait_timeout",
        "login_complete",
        "check_login",
        "browse_feed",
        "threads_warmup",
        "threads_auto_reply_done",
        "publish_done",
        "comment_done",
        "reply_done",
        "like_done",
        "already_liked",
        "share_done",
        "failed",
    }


def _goto(page, url: str, logger: AutomationLogger, stage: str) -> None:
    logger.log("info", stage, f"正在打开页面：{url}")
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
        return {"status": "need_verification", "reason": "Instagram 需要输入验证码。", "url": url}
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
        return {"status": "invalid_credentials", "reason": "Instagram 提示保存的登录信息不正确。", "url": url}
    login_markers = ["log into instagram", "log in with facebook", "forgot password", "create new account"]
    if any(marker in body_text for marker in login_markers):
        return {"status": "cookie_expired", "reason": "检测到 Instagram 登录页面文案。"}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        return {"status": "need_verification", "reason": "检测到验证或安全挑战文案。"}
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
    return {"status": "ready", "reason": "未检测到登录或验证界面。", "url": url}


def _detect_threads_login_state(page) -> dict[str, Any]:
    url = str(page.url or "")
    if _is_verification_url(url):
        return {"status": "need_verification", "reason": "Threads/Instagram 需要输入验证码。", "url": url}
    if "/login" in url:
        return {"status": "cookie_expired", "reason": "检测到 Threads 登录页面。", "url": url}
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
        return {"status": "invalid_credentials", "reason": "Instagram/Threads 提示保存的登录信息不正确。", "url": url}
    login_markers = ["log in", "login", "continue with instagram", "forgot password", "sign up"]
    if any(marker in body_text for marker in login_markers) and any(marker in body_text for marker in ["threads", "instagram"]):
        return {"status": "cookie_expired", "reason": "检测到 Threads 登录页面文案。", "url": url}
    challenge_markers = _verification_text_markers()
    if any(marker in body_text for marker in challenge_markers):
        return {"status": "need_verification", "reason": "检测到验证或安全挑战文案。"}

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
    wait_seconds = int(payload.get("login_wait_seconds") or os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "3600"))
    wait_seconds = max(30, min(wait_seconds, 3600))
    auto_submit = bool(payload.get("auto_submit") or payload.get("login_password") or payload.get("password"))
    logger.log("info", "open_login", "浏览器登录窗口已打开。", {"wait_seconds": wait_seconds, "auto_submit": auto_submit})
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
                        f"{_platform_name(platform)} 登录成功节点已确认。",
                        {"url": str(page.url or ""), "details": stable_status},
                        shot,
                    )
                    return {"ok": True, "status": "ready", "screenshot_path": shot, "details": stable_status}
                last_status = stable_status
            if last_status.get("status") == "invalid_credentials":
                shot = _screenshot(page, screenshot_dir, task, "login_invalid_credentials", logger)
                return _wait_for_manual_login_completion(
                    page,
                    task,
                    screenshot_dir,
                    logger,
                    platform,
                    cancel_event,
                    f"{_platform_name(platform)} 保存的账号密码被拒绝，请在打开的浏览器中手动修正并继续。",
                    "cookie_expired",
                    shot,
                    last_status,
                )
            if last_status.get("status") == "need_verification":
                shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
                logger.log(
                    "warn",
                    "login_verification_required",
                    f"{_platform_name(platform)} 需要输入验证码。",
                    {"url": str(page.url or ""), "screenshot_path": shot, "details": last_status},
                    shot,
                )
                return _wait_for_manual_login_completion(
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
                        "检测到验证码或安全挑战，正在等待人工在浏览器中处理。",
                        {"url": str(page.url or ""), "screenshot_path": shot},
                        shot,
                    )
                    verification_logged = True
                return _wait_for_manual_login_completion(
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
                )
        except NeedManualError:
            raise
        except Exception as exc:
            message = str(exc)
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                raise NeedManualError(f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新打开登录窗口并保持到账号就绪。", "cookie_expired") from exc
            logger.log("warn", "open_login_poll", f"登录窗口状态检查失败：{exc}")
        time.sleep(3 if auto_submit else 10)
    shot = _screenshot(page, screenshot_dir, task, "login_wait_timeout", logger)
    return _wait_for_manual_login_completion(
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
) -> dict[str, Any]:
    logger.log(
        "warn",
        "need_manual",
        reason,
        {"status": status, "screenshot_path": screenshot_path, "details": last_status or {}},
        screenshot_path,
    )
    last_seen_status = str(status or "")
    while True:
        _raise_if_cancelled(cancel_event)
        try:
            page.title(timeout=1000)
        except Exception as exc:
            message = str(exc)
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                raise NeedManualError(f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新启动登录任务。", status) from exc
        current_status = _detect_platform_login_state(page, platform)
        current_code = str(current_status.get("status") or "").strip()
        if current_code == "ready":
            stable_status = _confirm_platform_ready(page, platform, logger, cancel_event)
            if stable_status.get("status") == "ready":
                shot = _screenshot(page, screenshot_dir, task, "login_complete", logger)
                logger.log(
                    "info",
                    "completion_node",
                    f"{_platform_name(platform)} 登录成功节点已确认。",
                    {"url": str(page.url or ""), "details": stable_status, "manual_completion": True},
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
        time.sleep(5)


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
    shot = _screenshot(page, screenshot_dir, task, "check_login", logger)
    if status.get("status") != "ready":
        logger.log("warn", "need_manual", str(status.get("reason") or f"{_platform_name(platform)} 账号未就绪。"), {"details": status}, shot)
        raise NeedManualError(str(status.get("reason") or f"{_platform_name(platform)} 账号未就绪。"), str(status.get("status") or "need_verification"), shot)
    logger.log("info", "completion_node", f"{_platform_name(platform)} 登录检查完成节点已确认。", {"details": status}, shot)
    return {"ok": True, "status": "ready", "screenshot_path": shot, "details": status}


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


def _warmup_session_seconds(payload: dict[str, Any], default_seconds: int = 8 * 60) -> int:
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
    return default_seconds


def _payload_int(payload: dict[str, Any], keys: tuple[str, ...], default: int, min_value: int, max_value: int) -> int:
    for key in keys:
        value = payload.get(key)
        if value is None or value == "":
            continue
        with contextlib.suppress(Exception):
            parsed = int(float(value))
            return max(min_value, min(max_value, parsed))
    return max(min_value, min(max_value, int(default)))


def _run_browse_feed(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, INSTAGRAM_HOME, logger, "browse_feed")
    _warmup_scroll(page, logger, int(payload.get("scroll_times") or 2))
    shot = _screenshot(page, screenshot_dir, task, "browse_feed", logger)
    return {"ok": True, "url": page.url, "screenshot_path": shot}


def _threads_like_buttons(page):
    selectors = [
        '[aria-label="Like"]',
        '[aria-label*="\u8d5e"]',
    ]
    locators = []
    for selector in selectors:
        try:
            locators.append(page.locator(selector))
        except Exception:
            continue
    return locators


def _is_threads_like_candidate(locator) -> bool:
    label = ""
    text = ""
    with contextlib.suppress(Exception):
        label = str(locator.get_attribute("aria-label") or "")
    with contextlib.suppress(Exception):
        text = str(locator.inner_text(timeout=500) or "")
    probe = f"{label} {text}".strip().lower()
    if not probe:
        return False
    blocked = ("unlike", "liked", "\u53d6\u6d88", "\u5df2\u8d5e", "\u5df2\u6309\u8d5e", "\u6536\u56de")
    if any(item in probe for item in blocked):
        return False
    return "like" in probe or "\u8d5e" in probe


def _click_some_threads_likes(page, logger: AutomationLogger, limit: int) -> int:
    clicked = 0
    if limit <= 0:
        return clicked
    for group in _threads_like_buttons(page):
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
                    _human_click(page, loc, logger, "threads_like")
                    clicked += 1
                    _sleep_between(1.0, 2.5)
                    if clicked >= limit:
                        return clicked
            except Exception:
                continue
    return clicked


def _open_random_threads_post(page, logger: AutomationLogger) -> bool:
    candidates = page.locator('a[href*="/post/"]')
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
                _sleep_between(2.0, 4.0)
                after_url = str(page.url or "")
                opened = after_url != before_url or "/post/" in after_url
                if not opened:
                    continue
                logger.log("info", "threads_open_post", "已打开一条 Threads 帖子进行浏览。", {"url": after_url})
                _sleep_between(6.0, 12.0)
                if random.random() < 0.55:
                    detail_scroll = _slow_human_scroll(page)
                    logger.log("debug", "threads_read_post", "已在打开的 Threads 帖子内浏览。", detail_scroll)
                    _sleep_between(4.0, 9.0)
                _return_threads_feed_after_post(page, logger)
                return True
            except Exception:
                continue
    return False


def _return_threads_feed_after_post(page, logger: AutomationLogger) -> None:
    for _ in range(2):
        url = str(page.url or "").lower()
        if "/post/" not in url and "/media" not in url:
            break
        with contextlib.suppress(Exception):
            page.keyboard.press("Escape")
            _sleep_between(0.8, 1.8)
        try:
            page.go_back(wait_until="domcontentloaded", timeout=12000)
        except Exception:
            with contextlib.suppress(Exception):
                page.keyboard.press("Alt+Left")
        _sleep_between(2.5, 5.5)
    final_url = str(page.url or "")
    if "/post/" in final_url.lower() or "/media" in final_url.lower():
        _goto(page, THREADS_HOME, logger, "threads_return_feed")
        final_url = str(page.url or "")
    logger.log("info", "threads_return_feed", "已从打开的 Threads 帖子返回信息流。", {"url": final_url})


def _run_threads_warmup(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    _goto(page, THREADS_HOME, logger, "threads_warmup")
    browse_limit = _payload_int(payload, ("browse_limit", "browse_count", "scroll_times"), 30, 1, 300)
    like_limit = _payload_int(payload, ("like_limit",), 0, 0, 100)
    max_comments = _payload_int(payload, ("max_comments",), 0, 0, 50)
    comment_chance = _payload_int(payload, ("comment_chance",), 0, 0, 100)
    session_seconds = _warmup_session_seconds(payload)
    strategy_id = str(payload.get("strategy_id") or "tg_default")
    strategy_label = str(payload.get("strategy_label") or "\u9ed8\u8ba4\u517b\u53f7\uff1a\u6ed1\u52a8 + \u968f\u673a\u70b9\u8d5e")
    logger.log("info", "threads_warmup", "开始按人设自动化设置执行 Threads 养号。", {
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "browse_limit": browse_limit,
        "session_seconds": session_seconds,
        "like_limit": like_limit,
        "max_comments": max_comments,
        "comment_chance": comment_chance,
        "persona_name": payload.get("persona_name") or "",
    })
    liked = 0
    commented = 0
    browsed = 0
    opened_posts = 0
    like_backfills = 0
    comment_backfills = 0
    min_required_likes = _payload_int(payload, ("min_required_likes",), 1 if like_limit > 0 else 0, 0, like_limit or 0)
    min_required_comments = _payload_int(payload, ("min_required_comments",), 1 if max_comments > 0 and comment_chance > 0 else 0, 0, max_comments or 0)
    comment_screenshots: list[str] = []
    deadline = time.monotonic() + session_seconds
    while time.monotonic() < deadline and browsed < browse_limit:
        elapsed_ratio = 1 - max(0, deadline - time.monotonic()) / max(1, session_seconds)
        should_backfill_like = liked < min_required_likes and elapsed_ratio >= 0.35
        should_try_like = random.random() < 0.28 or should_backfill_like or (liked == 0 and elapsed_ratio >= 0.45 and random.random() < 0.75)
        if like_limit > liked and browsed > 0 and should_try_like:
            clicked_likes = _click_some_threads_likes(page, logger, like_limit - liked)
            if clicked_likes:
                liked += clicked_likes
            else:
                like_backfills += 1
                logger.log("warn", "threads_warmup_backfill", "点赞补量失败，正在切换目标。", {"attempts": like_backfills, "liked": liked, "target": min_required_likes})
        should_open_post = browsed > 0 and (random.random() < 0.12 or (opened_posts == 0 and elapsed_ratio >= 0.3))
        if should_open_post and _open_random_threads_post(page, logger):
            opened_posts += 1
        should_backfill_comment = commented < min_required_comments and elapsed_ratio >= 0.45
        if max_comments > commented and comment_chance > 0 and browsed > 0 and (should_backfill_comment or random.randint(1, 100) <= comment_chance):
            button = _threads_reply_button(page)
            reply_text = _pick_persona_reply(payload)
            if button is not None and str(reply_text or "").strip():
                _human_click(page, button, logger, "threads_warmup_reply_button")
                _sleep_between(1.0, 2.5)
                box = _threads_text_box(page)
                if box is not None:
                    _human_click(page, box, logger, "threads_warmup_reply_focus")
                    _human_type(page, reply_text, min_delay=0.10, max_delay=0.22)
                    posted = _click_text_button(page, logger, ["Post", "Reply", "\u53d1\u5e03", "\u56de\u8986", "\u56de\u590d"], "threads_warmup_reply_submit")
                    if posted:
                        commented += 1
                        shot_reply = _screenshot(page, screenshot_dir, task, f"threads_warmup_comment_{commented}", logger)
                        if shot_reply:
                            comment_screenshots.append(shot_reply)
                        logger.log("info", "threads_warmup_comment", "Threads 养号过程中已评论。", {"commented": commented, "text": reply_text[:80]})
                    else:
                        comment_backfills += 1
                        logger.log("warn", "threads_warmup_backfill", "评论补量失败，正在切换目标。", {"attempts": comment_backfills, "commented": commented, "target": min_required_comments})
                else:
                    comment_backfills += 1
                    logger.log("warn", "threads_warmup_backfill", "未找到可评论目标，继续浏览。", {"attempts": comment_backfills, "commented": commented, "target": min_required_comments})
            elif max_comments > commented:
                comment_backfills += 1
                logger.log("warn", "threads_warmup_backfill", "未找到可评论目标，继续浏览。", {"attempts": comment_backfills, "commented": commented, "target": min_required_comments, "has_reply_text": bool(str(reply_text or "").strip())})
        scroll = _slow_human_scroll(page)
        browsed += 1
        remaining_seconds = max(0, int(deadline - time.monotonic()))
        logger.log("debug", "threads_warmup", "已平滑浏览 Threads 信息流。", {"index": browsed, "browse_limit": browse_limit, **scroll, "liked": liked, "commented": commented, "opened_posts": opened_posts, "remaining_seconds": remaining_seconds})
        if remaining_seconds <= 0:
            break
        _sleep_between(8.0, 16.0)
    shot = _screenshot(page, screenshot_dir, task, "threads_warmup", logger)
    logger.log(
        "info",
        "completion_node",
        "Threads 养号完成节点已确认。",
        {"url": str(page.url or ""), "liked": liked, "commented": commented, "scrolled": browsed, "browse_limit": browse_limit, "opened_posts": opened_posts, "target_seconds": session_seconds, "like_backfills": like_backfills, "comment_backfills": comment_backfills, "strategy_id": strategy_id, "strategy_label": strategy_label},
        shot,
    )
    return {"ok": True, "url": page.url, "liked": liked, "commented": commented, "scrolled": browsed, "browse_limit": browse_limit, "opened_posts": opened_posts, "target_seconds": session_seconds, "likeBackfills": like_backfills, "commentBackfills": comment_backfills, "strategy_id": strategy_id, "strategy_label": strategy_label, "commentScreenshots": comment_screenshots, "screenshot_path": shot}


def _threads_reply_button(page):
    selectors = [
        '[aria-label="Reply"]',
        '[aria-label*="Reply" i]',
        '[aria-label*="鍥炲"]',
        '[aria-label*="鍥炶"]',
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


def _pick_persona_reply(payload: dict[str, Any]) -> str:
    reply_text = str(payload.get("reply_text") or "").strip()
    if reply_text:
        return reply_text[:180]
    templates = [str(item or "").strip() for item in (payload.get("reply_templates") or []) if str(item or "").strip()]
    if templates:
        return random.choice(templates)[:180]
    if bool(payload.get("require_persona_relevance", False)):
        return ""
    persona_name = str(payload.get("persona_name") or "").strip()
    if persona_name:
        return f"\u8fd9\u4e2a\u89d2\u5ea6\u633a\u9002\u5408 {persona_name} \u7ee7\u7eed\u89c2\u5bdf\u3002"
    return "\u8fd9\u4e2a\u89d2\u5ea6\u503c\u5f97\u7ee7\u7eed\u89c2\u5bdf\u3002"


def _run_threads_hot_post_auto_reply(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    max_posts = max(1, min(int(payload.get("max_posts") or 5), 20))
    max_replies = max(1, min(int(payload.get("max_replies") or 3), 10))
    strategy_id = str(payload.get("strategy_id") or "hot_posts")
    strategy_label = str(payload.get("strategy_label") or "\u81ea\u52a8\u56de\u590d\u70ed\u70b9\u63a8\u6587")
    raw_targets = payload.get("target_urls") or []
    if not isinstance(raw_targets, list):
        raw_targets = []
    target_urls = [str(item or "").strip() for item in raw_targets if str(item or "").strip()]
    logger.log("info", "threads_hot_post_auto_reply", "开始执行 Threads 热点帖子自动回复。", {
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "target_count": len(target_urls),
        "max_posts": max_posts,
        "max_replies": max_replies,
        "persona_name": payload.get("persona_name") or "",
    })
    if not target_urls:
        shot = _screenshot(page, screenshot_dir, task, "threads_auto_reply_done", logger)
        logger.log("warn", "completion_node", "没有可用的 Threads 热点帖子目标。", {
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
        }, shot)
        return {
            "ok": True,
            "url": str(page.url or THREADS_HOME),
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
            "screenshot_path": shot,
        }

    replied = 0
    scanned = 0
    reply_backfills = 0
    reply_screenshots: list[str] = []
    replied_urls: list[str] = []
    completion_reason = "max_posts_scanned"
    for url in target_urls[:max_posts]:
        scanned += 1
        _goto(page, url, logger, "threads_hot_post_open")
        _sleep_between(1.5, 3.0)
        button = _threads_reply_button(page)
        reply_text = _pick_persona_reply(payload)
        if not str(reply_text or "").strip():
            completion_reason = "no_persona_relevant_reply"
            logger.log("warn", "threads_hot_post_reply_skip", "没有可用的人设相关回复候选内容。", {"url": url})
            break
        if button is None:
            reply_backfills += 1
            logger.log("warn", "threads_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "url": url})
            continue
        _human_click(page, button, logger, "threads_hot_post_reply_button")
        _sleep_between(1.0, 2.5)
        box = _threads_text_box(page)
        if box is None:
            reply_backfills += 1
            logger.log("warn", "threads_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "url": url})
            continue
        _human_click(page, box, logger, "threads_hot_post_reply_focus")
        _human_type(page, reply_text, min_delay=0.10, max_delay=0.22)
        posted = _click_text_button(page, logger, ["Post", "Reply", "\u53d1\u5e03", "\u56de\u8986", "\u56de\u590d"], "threads_hot_post_reply_submit")
        if posted:
            replied += 1
            replied_urls.append(url)
            _sleep_between(2.0, 4.0)
            shot = _screenshot(page, screenshot_dir, task, f"threads_reply_{replied}", logger)
            if shot:
                reply_screenshots.append(shot)
            logger.log("info", "threads_hot_post_auto_reply", "已回复 Threads 热点帖子。", {"reply_index": replied, "url": url, "text": reply_text[:80]})
            if replied >= max_replies:
                completion_reason = "target_replies_reached"
                break
        else:
            reply_backfills += 1
            logger.log("warn", "threads_auto_reply_backfill", "回复补量失败，正在切换目标。", {"attempts": reply_backfills, "url": url})
    shot = _screenshot(page, screenshot_dir, task, "threads_auto_reply_done", logger)
    logger.log(
        "info",
        "completion_node",
        "Threads 热点帖子自动回复完成节点已确认。",
        {"url": str(page.url or ""), "scannedPosts": scanned, "replied": replied, "reply_backfills": reply_backfills, "completionReason": completion_reason, "strategy_id": strategy_id, "strategy_label": strategy_label},
        shot,
    )
    return {
        "ok": True,
        "url": page.url,
        "scannedPosts": scanned,
        "scannedComments": scanned,
        "replied": replied,
        "skipped": max(0, scanned - replied),
        "replyBackfills": reply_backfills,
        "completionReason": completion_reason,
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "replyScreenshots": reply_screenshots,
        "repliedUrls": replied_urls,
        "screenshot_path": shot,
    }


def _run_threads_auto_reply(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    if str(payload.get("reply_scope") or "comments") == "hot_posts":
        return _run_threads_hot_post_auto_reply(page, task, payload, screenshot_dir, logger)
    max_posts = max(1, min(int(payload.get("max_posts") or 5), 20))
    max_replies = max(1, min(int(payload.get("max_replies") or 3), 10))
    strategy_id = str(payload.get("strategy_id") or "tg_default")
    strategy_label = str(payload.get("strategy_label") or "\u81ea\u52a8\u56de\u590d\u8bc4\u8bba\uff1a\u6700\u8fd1 2 \u5929")
    require_persona_relevance = bool(payload.get("require_persona_relevance", True))
    raw_targets = payload.get("target_urls") or []
    if not isinstance(raw_targets, list):
        raw_targets = []
    target_urls = [str(item or "").strip() for item in raw_targets if str(item or "").strip()]
    replied = 0
    scanned = 0
    reply_backfills = 0
    reply_screenshots: list[str] = []
    replied_urls: list[str] = []
    logger.log("info", "threads_auto_reply", "开始执行人设驱动的 Threads 自动回复。", {
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "max_posts": max_posts,
        "max_replies": max_replies,
        "require_persona_relevance": require_persona_relevance,
        "persona_name": payload.get("persona_name") or "",
        "threads_handle": payload.get("threads_handle") or "",
        "target_count": len(target_urls),
    })
    completion_reason = "max_posts_scanned"
    if target_urls:
        for url in target_urls[:max_posts]:
            scanned += 1
            _goto(page, url, logger, "threads_comment_reply_open")
            _sleep_between(1.5, 3.0)
            button = _threads_reply_button(page)
            reply_text = _pick_persona_reply(payload)
            if require_persona_relevance and not str(reply_text or "").strip():
                logger.log("warn", "threads_auto_reply_skip", "没有可用的人设相关回复候选内容。", {"strategy_id": strategy_id, "strategy_label": strategy_label, "url": url})
                completion_reason = "no_persona_relevant_reply"
                break
            if button is None:
                reply_backfills += 1
                logger.log("warn", "threads_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "url": url})
                continue
            _human_click(page, button, logger, "threads_reply_button")
            _sleep_between(1.0, 2.5)
            box = _threads_text_box(page)
            if box is None:
                reply_backfills += 1
                logger.log("warn", "threads_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "url": url})
                continue
            _human_click(page, box, logger, "threads_reply_focus")
            _human_type(page, reply_text, min_delay=0.10, max_delay=0.22)
            posted = _click_text_button(page, logger, ["Post", "Reply", "\u53d1\u5e03", "\u56de\u8986", "\u56de\u590d"], "threads_reply_submit")
            if posted:
                replied += 1
                replied_urls.append(url)
                _sleep_between(2.0, 4.0)
                shot = _screenshot(page, screenshot_dir, task, f"threads_reply_{replied}", logger)
                if shot:
                    reply_screenshots.append(shot)
                logger.log("info", "threads_auto_reply", "已使用人设文案完成回复。", {"reply_index": replied, "url": url, "text": reply_text[:80]})
                if replied >= max_replies:
                    completion_reason = "target_replies_reached"
                    break
            else:
                reply_backfills += 1
                logger.log("warn", "threads_auto_reply_backfill", "回复补量失败，正在切换目标。", {"attempts": reply_backfills, "url": url})
        shot = _screenshot(page, screenshot_dir, task, "threads_auto_reply_done", logger)
        logger.log(
            "info",
            "completion_node",
            "Threads 自动回复完成节点已确认。",
            {"url": str(page.url or ""), "scannedPosts": scanned, "replied": replied, "reply_backfills": reply_backfills, "completionReason": completion_reason, "strategy_id": strategy_id, "strategy_label": strategy_label, "target_count": len(target_urls)},
            shot,
        )
        return {
            "ok": True,
            "url": page.url,
            "scannedPosts": scanned,
            "scannedComments": scanned,
            "replied": replied,
            "skipped": max(0, scanned - replied),
            "replyBackfills": reply_backfills,
            "completionReason": completion_reason,
            "strategy_id": strategy_id,
            "strategy_label": strategy_label,
            "replyScreenshots": reply_screenshots,
            "repliedUrls": replied_urls,
            "screenshot_path": shot,
        }
    _goto(page, THREADS_HOME, logger, "threads_auto_reply_open")
    for index in range(max_posts):
        scanned += 1
        button = _threads_reply_button(page)
        if button is not None:
            reply_text = _pick_persona_reply(payload)
            if require_persona_relevance and not str(reply_text or "").strip():
                logger.log("warn", "threads_auto_reply_skip", "没有可用的人设相关回复候选内容。", {"strategy_id": strategy_id, "strategy_label": strategy_label})
                completion_reason = "no_persona_relevant_reply"
                break
            _human_click(page, button, logger, "threads_reply_button")
            _sleep_between(1.0, 2.5)
            box = _threads_text_box(page)
            if box is None:
                reply_backfills += 1
                logger.log("warn", "threads_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "index": index + 1})
            else:
                _human_click(page, box, logger, "threads_reply_focus")
                _human_type(page, reply_text, min_delay=0.10, max_delay=0.22)
                posted = _click_text_button(page, logger, ["Post", "Reply", "\u53d1\u5e03", "\u56de\u8986", "\u56de\u590d"], "threads_reply_submit")
                if posted:
                    replied += 1
                    _sleep_between(2.0, 4.0)
                    shot = _screenshot(page, screenshot_dir, task, f"threads_reply_{replied}", logger)
                    if shot:
                        reply_screenshots.append(shot)
                    logger.log("info", "threads_auto_reply", "已使用人设文案完成回复。", {"reply_index": replied, "text": reply_text[:80]})
                    if replied >= max_replies:
                        completion_reason = "target_replies_reached"
                        break
                else:
                    reply_backfills += 1
                    logger.log("warn", "threads_auto_reply_backfill", "回复补量失败，正在切换目标。", {"attempts": reply_backfills, "index": index + 1})
        else:
            reply_backfills += 1
            logger.log("warn", "threads_auto_reply_backfill", "未找到可回复目标，正在切换目标。", {"attempts": reply_backfills, "index": index + 1})
        page.mouse.wheel(0, random.randint(550, 950))
        _sleep_between(2.0, 5.0)
    shot = _screenshot(page, screenshot_dir, task, "threads_auto_reply_done", logger)
    logger.log(
        "info",
        "completion_node",
        "Threads 自动回复完成节点已确认。",
        {"url": str(page.url or ""), "scannedPosts": scanned, "replied": replied, "reply_backfills": reply_backfills, "completionReason": completion_reason, "strategy_id": strategy_id, "strategy_label": strategy_label},
        shot,
    )
    return {
        "ok": True,
        "url": page.url,
        "scannedPosts": scanned,
        "scannedComments": scanned,
        "replied": replied,
        "skipped": max(0, scanned - replied),
        "replyBackfills": reply_backfills,
        "completionReason": completion_reason,
        "strategy_id": strategy_id,
        "strategy_label": strategy_label,
        "replyScreenshots": reply_screenshots,
        "repliedUrls": replied_urls,
        "screenshot_path": shot,
    }


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
    logger.log("info", "auto_login_start", f"开始自动填写 {_platform_name(platform)} 登录凭据。", {"username": username, "url": str(page.url or "")}, start_shot)

    continue_clicked = False
    if platform == "threads":
        logger.log("info", "auto_login_continue", "正在查找 Threads 的 Instagram 登录按钮。", {"url": str(page.url or "")})
        continue_clicked = _click_text_button(
            page,
            logger,
            ["Continue with Instagram", "Log in with Instagram", "缁х画浣跨敤 Instagram", "浣跨敤 Instagram 缁х画"],
            "threads_continue_instagram",
        )
        logger.log("info" if continue_clicked else "warn", "auto_login_continue", "Threads 的 Instagram 登录按钮已处理。", {"clicked": continue_clicked, "url": str(page.url or "")})
        if continue_clicked:
            _sleep_between(2.0, 4.0)

    logger.log("info", "auto_login_find_inputs", "正在查找用户名和密码输入框。", {"url": str(page.url or "")})
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
        logger.log("warn", "auto_login_inputs_missing", "未找到可见的登录输入框，无法自动填写凭据。", {"continued": continue_clicked, "url": str(page.url or "")}, shot)
        return False

    try:
        logger.log("info", "auto_login_type_username", "正在填写登录用户名。", {"username": username})
        _clear_and_type(page, username_input, username)
        _sleep_between(0.4, 0.9)
        logger.log("info", "auto_login_type_password", "正在填写登录密码。", {"password": "***"})
        _clear_and_type(page, password_input, password)
        _sleep_between(0.4, 0.9)
    except Exception as exc:
        shot = _screenshot(page, screenshot_dir, task, "auto_login_type_failed", logger)
        logger.log("warn", "auto_login_type_failed", "自动填写登录凭据失败。", {"error": str(exc), "url": str(page.url or "")}, shot)
        return False
    filled_shot = _screenshot(page, screenshot_dir, task, "auto_login_form_filled", logger)
    logger.log("info", "auto_login_form_filled", "登录表单已填写完成。", {"username": username, "password": "***"}, filled_shot)
    clicked = _click_text_button(
        page,
        logger,
        ["Log in", "Log In", "Login", "Continue", "\u767b\u5f55", "\u767b\u5165", "\u7ee7\u7eed"],
        "auto_login_submit",
    )
    if not clicked:
        page.keyboard.press("Enter")
    submit_shot = _screenshot(page, screenshot_dir, task, "auto_login_submitted", logger)
    logger.log("info", "auto_login_submit", "登录表单已提交，正在等待账号就绪或验证提示。", {"clicked_submit_button": clicked, "url": str(page.url or "")}, submit_shot)
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
        "验证提示",
        "安全码",
        "安全提示",
    ]
    try:
        text = page.locator("body").inner_text(timeout=3000).lower()
    except Exception:
        text = ""
    return any(marker in text for marker in markers)


def _threads_compose_box(page):
    return _visible_first(page, [
        '[role="dialog"] textarea',
        '[role="dialog"] [contenteditable="true"]',
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
    return _visible_first(page, [
        '[role="dialog"] textarea',
        '[role="dialog"] [contenteditable="true"]',
        '[role="dialog"] [role="textbox"]',
    ], timeout_ms=800)


def _threads_dialog_post_button(page):
    return _visible_first(page, [
        '[role="dialog"] button:has-text("Post")',
        '[role="dialog"] [role="button"]:has-text("Post")',
    ], timeout_ms=800)


def _ensure_threads_compose_ready(page, logger: AutomationLogger):
    compose = _threads_compose_box(page)
    if compose is not None:
        return compose
    openers = [
        '[aria-label*="New thread" i]',
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
                compose = _threads_compose_box(page)
                if compose is not None:
                    return compose
        except Exception:
            continue
    raise RuntimeError("无法打开 Threads 发帖输入框。")


def _wait_for_threads_publish_success(page, logger: AutomationLogger) -> dict[str, Any]:
    deadline = time.time() + 90
    saw_dialog = False
    while time.time() < deadline:
        try:
            url = str(page.url or "")
            if re.search(r"/@[^/]+/(post|thread)/", url) or re.search(r"/post/", url):
                return {"confirmed": True, "reason": "已检测到 Threads 帖子链接。", "url": url}
        except Exception:
            pass
        dialog_compose = _threads_dialog_compose_box(page)
        dialog_post_button = _threads_dialog_post_button(page)
        if dialog_compose is not None or dialog_post_button is not None:
            saw_dialog = True
        elif saw_dialog:
            return {"confirmed": True, "reason": "Threads 发布后编辑器已关闭。", "url": str(page.url or "")}
        elif time.time() > deadline - 84:
            return {"confirmed": True, "reason": "Threads 提交后已返回信息流。", "url": str(page.url or "")}
        _sleep_between(1.4, 2.2)
    logger.log("warn", "threads_publish_confirm", "等待 Threads 发布确认超时。", {"url": str(page.url or "")})
    return {"confirmed": False, "reason": "等待 Threads 发布确认超时。", "url": str(page.url or "")}


def _run_threads_publish_post(page, task, payload, screenshot_dir, logger) -> dict[str, Any]:
    media_paths = [str(p) for p in (payload.get("media_paths") or []) if str(p or "").strip()]
    caption = str(payload.get("caption") or payload.get("content") or payload.get("text") or "").strip()
    if not caption and not media_paths:
        raise ValueError("Threads 发布任务需要正文或媒体文件。")
    missing = [p for p in media_paths if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"媒体文件不存在：{missing[0]}")
    _goto(page, THREADS_HOME, logger, "threads_publish_open")
    compose = _ensure_threads_compose_ready(page, logger)
    _human_click(page, compose, logger, "threads_publish_focus")
    if caption:
        _clear_and_type(page, compose, caption)
    if media_paths:
        file_input = page.locator('input[type="file"]').first
        if not file_input.count():
            trigger = _visible_first(page, [
                '[aria-label*="photo" i]',
                '[aria-label*="video" i]',
                'button:has-text("Add photo")',
                'button:has-text("Add media")',
            ], timeout_ms=1500)
            if trigger is not None:
                _human_click(page, trigger, logger, "threads_publish_media_picker")
                _sleep_between(0.8, 1.4)
                file_input = page.locator('input[type="file"]').first
        file_input.wait_for(state="attached", timeout=30000)
        logger.log("info", "threads_publish_upload", "正在上传 Threads 媒体文件。", {"count": len(media_paths)})
        file_input.set_input_files(media_paths)
        _sleep_between(1.0, 2.2)
    post_button = _threads_post_button(page)
    if post_button is None:
        raise RuntimeError("未找到 Threads 发布按钮。")
    _human_click(page, post_button, logger, "threads_publish_submit")
    success = _wait_for_threads_publish_success(page, logger)
    shot = _screenshot(page, screenshot_dir, task, "publish_done", logger)
    return {"ok": True, "published": success, "url": str(success.get("url") or page.url or ""), "screenshot_path": shot}


def _run_publish_post(page, task, payload, screenshot_dir, logger, platform: str = "instagram") -> dict[str, Any]:
    if platform == "threads":
        return _run_threads_publish_post(page, task, payload, screenshot_dir, logger)
    media_paths = [str(p) for p in (payload.get("media_paths") or []) if str(p or "").strip()]
    caption = str(payload.get("caption") or "").strip()
    if not media_paths:
        raise ValueError("发布任务需要媒体文件。")
    missing = [p for p in media_paths if not Path(p).exists()]
    if missing:
        raise FileNotFoundError(f"媒体文件不存在：{missing[0]}")
    _goto(page, INSTAGRAM_HOME, logger, "publish_open")
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
        _human_type(page, caption)
    if not _click_text_button(page, logger, ["Share"], "publish_share"):
        raise RuntimeError("未找到 Instagram 分享按钮。")
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
                return {"confirmed": True, "reason": "已检测到发布成功文案。"}
        except Exception:
            pass
        if "/p/" in str(page.url or "") or str(page.url or "").rstrip("/") == INSTAGRAM_HOME.rstrip("/"):
            return {"confirmed": True, "reason": "分享后页面已跳转。"}
        time.sleep(2)
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
