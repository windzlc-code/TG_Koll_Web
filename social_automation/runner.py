from __future__ import annotations

import contextlib
import os
import random
import re
import threading
import time
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote, quote_plus, urljoin, urlparse


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

_CAMOUFOX_LAUNCH_LOCK = threading.Lock()


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


class AutoLoginFailedError(RuntimeError):
    def __init__(self, message: str, status: str = "cookie_expired", screenshot_path: str = ""):
        super().__init__(message)
        self.status = status
        self.screenshot_path = str(screenshot_path or "")


class UnsupportedActionError(RuntimeError):
    pass


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
) -> dict[str, Any]:
    if str(task.get("task_type") or "") != "publish_post":
        return initial_status
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
        _self_heal_login_page(page, platform, logger, task, screenshot_dir, str(initial_status.get("reason") or "publish_login_not_ready"), attempt, cancel_event)
        current = _detect_platform_login_state(page, platform)
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
        result = _run_open_login(page, task, account, repair_payload, screenshot_dir, logger, platform, cancel_event)
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
            login = _attempt_publish_login_repair(page, task, account, payload, screenshot_dir, logger, platform, cancel_event, login)
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
            return _run_publish_post(page, task, payload, screenshot_dir, logger, platform, account=account)
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
            safe_error = _redact_proxy_error(exc, proxy_config)
            self._stop_live_browser_session()
            raise RuntimeError(
                "Camoufox 浏览器启动失败。请在 Windows 执行 `py -3 -m camoufox fetch`，"
                "或在 Linux/macOS 执行 `python -m camoufox fetch` 下载浏览器构建。"
                f"原始错误：{safe_error}"
            ) from None
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


def _type_text(page, text: str, min_delay: float = 0.08, max_delay: float = 0.18, *, mode: str = "paste", logger: AutomationLogger | None = None, stage: str = "text_input") -> None:
    clean_text = str(text or "")
    input_mode = _normalize_text_input_mode(mode or os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste"))
    if input_mode == "type":
        if logger is not None:
            logger.log("info", stage, "正在使用逐字输入方式填写内容。", {"mode": "type", "chars": len(clean_text)})
        _human_type(page, clean_text, min_delay=min_delay, max_delay=max_delay)
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
    _human_type(page, clean_text, min_delay=min_delay, max_delay=max_delay)


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
    abs_x = box["x"] + rel_x
    abs_y = box["y"] + rel_y
    try:
        locator.click(position={"x": rel_x, "y": rel_y}, timeout=5000)
        return
    except Exception as exc:
        logger.log("warn", f"{stage}_locator_click_failed", "目标元素常规点击超时，改用坐标点击兜底。", {"error": str(exc)[:500]})
    try:
        page.mouse.click(abs_x, abs_y, delay=random.randint(60, 180))
        return
    except Exception as exc:
        logger.log("warn", f"{stage}_mouse_click_failed", "目标元素坐标点击失败，改用 DOM 点击兜底。", {"error": str(exc)[:500]})
    locator.evaluate("(node) => node.click()")


def _screenshot(page, screenshot_dir: Path, task: dict[str, Any], stage: str, logger: AutomationLogger) -> str:
    if str(task.get("task_type") or "").strip().lower() == "publish_post" and str(stage or "") not in {
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
    return str(stage or "") in {
        "login_verification_required",
        "login_invalid_credentials",
        "login_wait_timeout",
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
    body_text = ""
    try:
        body_text = page.locator("body").inner_text(timeout=5000).lower()
    except Exception:
        pass
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


def _int_payload_or_env(payload: dict[str, Any], key: str, env_key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(payload.get(key) or os.getenv(env_key, str(default)))
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
) -> None:
    _raise_if_cancelled(cancel_event)
    shot = _screenshot(page, screenshot_dir, task, f"login_self_heal_{attempt}", logger)
    logger.log(
        "warn",
        "login_self_heal",
        f"{_platform_name(platform)} login is unstable; running automatic recovery attempt {attempt}.",
        {"attempt": attempt, "reason": reason, "url": str(page.url or "")},
        shot,
    )
    with contextlib.suppress(Exception):
        page.keyboard.press("Escape")
    action = attempt % 4
    if action == 1:
        with contextlib.suppress(Exception):
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
            {"clicked": retried, "url": str(page.url or "")},
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
        {"clicked": continued, "url": str(page.url or "")},
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
        {"url": str(page.url or "")},
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
) -> dict[str, Any]:
    if wait_for_manual and (not manual_only_on_verification or status == "need_verification"):
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
        )
    logger.log(
        "error",
        "auto_login_failed",
        reason,
        {"status": status, "screenshot_path": screenshot_path, "details": last_status or {}},
        screenshot_path,
    )
    raise AutoLoginFailedError(reason, status, screenshot_path)


def _run_open_login(page, task, account, payload, screenshot_dir, logger, platform: str = "instagram", cancel_event: Any | None = None) -> dict[str, Any]:
    _goto(page, _platform_home(platform), logger, "open_login")
    wait_seconds = int(payload.get("login_wait_seconds") or os.getenv("SOCIAL_AUTOMATION_LOGIN_WAIT_SECONDS", "3600"))
    wait_seconds = max(30, min(wait_seconds, 3600))
    auto_submit = bool(payload.get("auto_submit") or payload.get("login_password") or payload.get("password"))
    max_login_attempts = _int_payload_or_env(payload, "max_login_attempts", "SOCIAL_AUTOMATION_LOGIN_MAX_ATTEMPTS", 4, 1, 8)
    max_self_heal_attempts = _int_payload_or_env(payload, "max_self_heal_attempts", "SOCIAL_AUTOMATION_LOGIN_SELF_HEAL_ATTEMPTS", 5, 0, 12)
    verification_confirmations = _int_payload_or_env(payload, "verification_confirmations", "SOCIAL_AUTOMATION_VERIFICATION_CONFIRMATIONS", 3, 1, 6)
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
    invalid_hits = 0
    verification_logged = False
    while time.time() < deadline:
        _raise_if_cancelled(cancel_event)
        try:
            last_status = _detect_platform_login_state(page, platform)
            if platform == "threads" and not auto_submit:
                last_status = _restore_threads_after_instagram_login(page, last_status, logger)
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
                invalid_hits += 1
                if auto_submit and invalid_hits < 2 and self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, str(last_status.get("reason") or "invalid_credentials"), self_heal_attempts, cancel_event)
                    continue
                shot = _screenshot(page, screenshot_dir, task, "login_invalid_credentials", logger)
                return _wait_or_raise_manual(
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
                    wait_for_manual,
                    manual_only_on_verification,
                )
            if last_status.get("status") == "need_verification":
                shot = _screenshot(page, screenshot_dir, task, "login_verification_required", logger)
                verification_hits += 1
                logger.log(
                    "warn",
                    "login_verification_required",
                    f"{_platform_name(platform)} 需要输入验证码。",
                    {"url": str(page.url or ""), "screenshot_path": shot, "details": last_status},
                    shot,
                )
                if auto_submit and verification_hits < verification_confirmations and self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, str(last_status.get("reason") or "need_verification"), self_heal_attempts, cancel_event)
                    continue
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
                )
            if last_status.get("status") == "transient_error":
                shot = _screenshot(page, screenshot_dir, task, "login_transient_error", logger)
                logger.log(
                    "warn",
                    "login_transient_error",
                    f"{_platform_name(platform)} returned a temporary error page; leaving the browser untouched.",
                    {"url": str(page.url or ""), "screenshot_path": shot, "details": last_status},
                    shot,
                )
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
                )
            if auto_submit and login_attempts < max_login_attempts and str(last_status.get("status") or "") != "need_verification":
                if _auto_submit_login_form(page, platform, payload, logger, task, screenshot_dir):
                    login_attempts += 1
                    time.sleep(3)
                    continue
                elif self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, "auto_login_form_not_ready", self_heal_attempts, cancel_event)
                    continue
            if _verification_visible(page):
                verification_hits += 1
                if auto_submit and verification_hits < verification_confirmations and self_heal_attempts < max_self_heal_attempts:
                    self_heal_attempts += 1
                    _self_heal_login_page(page, platform, logger, task, screenshot_dir, "verification_visible", self_heal_attempts, cancel_event)
                    continue
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
                )
        except NeedManualError:
            raise
        except Exception as exc:
            message = str(exc)
            if "Target page, context or browser has been closed" in message or "has been closed" in message:
                raise NeedManualError(f"{_platform_name(platform)} 登录确认前浏览器窗口已关闭，请重新打开登录窗口并保持到账号就绪。", "cookie_expired") from exc
            logger.log("warn", "open_login_poll", f"登录窗口状态检查失败：{exc}")
        # A manual login session belongs to the user.  Do not press Escape,
        # reload, or navigate away from the page they are actively handling.
        if auto_submit and self_heal_attempts < max_self_heal_attempts:
            self_heal_attempts += 1
            _self_heal_login_page(page, platform, logger, task, screenshot_dir, "login_state_not_ready", self_heal_attempts, cancel_event)
            continue
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
            page.get_by_text(name, exact=False).first,
            page.locator(f'button:has-text("{name}")').first,
            page.locator(f'a:has-text("{name}")').first,
            page.locator(f'[role="button"]:has-text("{name}")').first,
            page.locator(f'div:has-text("{name}")').filter(has=page.locator("img, svg, [aria-label], span")).first,
            page.locator(f'[aria-label="{name}"]').first,
        ]
        for loc in locators:
            try:
                if loc.count() and loc.is_visible(timeout=2500):
                    _human_click(page, loc, logger, stage)
                    return True
            except Exception:
                continue
        try:
            clicked = page.evaluate(
                """label => {
                    const wanted = String(label || '').trim().toLowerCase();
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
                    for (const node of candidates) {
                        const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                        if (!text || !text.includes(wanted)) continue;
                        const rect = node.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) continue;
                        const style = window.getComputedStyle(node);
                        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
                        const clickable = node.closest('button, a, [role="button"]') || node;
                        clickable.scrollIntoView({block: 'center', inline: 'center'});
                        clickable.click();
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


def _clear_and_type(page, locator, text: str, *, mode: str = "paste", logger: AutomationLogger | None = None, stage: str = "text_input") -> None:
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
    _type_text(page, text, min_delay=0.07, max_delay=0.16, mode=mode, logger=logger, stage=stage)


def _auto_submit_login_form(page, platform: str, payload: dict[str, Any], logger: AutomationLogger, task: dict[str, Any], screenshot_dir: Path) -> bool:
    username = str(payload.get("login_username") or payload.get("username") or "").strip()
    password = str(payload.get("login_password") or payload.get("password") or "").strip()
    if not username or not password:
        return False
    start_shot = _screenshot(page, screenshot_dir, task, "auto_login_start", logger)
    logger.log("info", "auto_login_start", f"开始自动填写 {_platform_name(platform)} 登录凭据。", {"username": username, "url": str(page.url or "")}, start_shot)

    continue_clicked = False
    if platform == "threads":
        username_entry_clicked = False
        for username_entry_attempt in range(1, 4):
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass
            if not _click_text_button(
                page,
                logger,
                ["Log in with username instead", "Log in with username", "Use username instead"],
                "threads_login_username_instead",
            ):
                continue
            username_entry_clicked = True
            _sleep_between(1.2, 2.2)
            if _visible_first(page, ['input[name="username"]', 'input[autocomplete="username"]', 'input[type="text"]'], 700) and _visible_first(page, ['input[type="password"]', 'input[autocomplete="current-password"]'], 700):
                logger.log("info", "threads_login_username_instead", "Threads username/password login entry was opened.", {"attempt": username_entry_attempt, "url": str(page.url or "")})
                continue_clicked = True
                break
            logger.log("warn", "threads_login_username_instead", "Threads username login entry click did not expose inputs yet; retrying.", {"attempt": username_entry_attempt, "url": str(page.url or "")})
        if not continue_clicked:
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
        _clear_and_type(page, username_input, username, mode="type", logger=logger, stage="auto_login_type_username")
        _sleep_between(0.4, 0.9)
        logger.log("info", "auto_login_type_password", "正在填写登录密码。", {"password": "***"})
        _clear_and_type(page, password_input, password, mode="type", logger=logger, stage="auto_login_type_password")
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
    return f"https://{host}{path}"


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


def _wait_for_threads_publish_success(page, logger: AutomationLogger) -> dict[str, Any]:
    deadline = time.time() + 90
    saw_dialog = False
    while time.time() < deadline:
        try:
            permalink = _normalize_threads_post_permalink(page.url)
            if permalink:
                return {"confirmed": True, "submitted": True, "reason": "已检测到 Threads 帖子链接。", "url": permalink}
        except Exception:
            pass
        dialog_compose = _threads_dialog_compose_box(page)
        dialog_post_button = _threads_dialog_post_button(page)
        if dialog_compose is not None or dialog_post_button is not None:
            saw_dialog = True
        elif saw_dialog:
            return {"confirmed": False, "submitted": True, "reason": "Threads 编辑器已关闭，仍需帖子链接确认。", "url": ""}
        elif time.time() > deadline - 84:
            return {"confirmed": False, "submitted": True, "reason": "Threads 已返回信息流，仍需帖子链接确认。", "url": ""}
        _sleep_between(1.4, 2.2)
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


def _click_threads_active_dialog_post(page, logger: AutomationLogger) -> bool:
    try:
        clicked = page.evaluate(
            r"""() => {
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
                    clickable.click();
                    return true;
                }
                return false;
            }"""
        )
        if clicked:
            logger.log("debug", "threads_publish_submit", "已点击当前 Threads 弹窗内的发布按钮。", {})
            return True
    except Exception as exc:
        logger.log("warn", "threads_publish_submit_dom_failed", "当前弹窗的发布按钮点击失败。", {"error": str(exc)[:500]})
    return False


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
    return f"https://{host}{path}"


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


def _wait_for_threads_own_post(page, caption: str, logger: AutomationLogger, account: dict[str, Any] | None = None, payload: dict[str, Any] | None = None, previous_permalink: str = "", profile_url: str = "", previous_permalinks: set[str] | None = None) -> dict[str, Any]:
    _dismiss_threads_compose_dialogs(page, logger)
    target_url = _normalize_threads_profile_url(profile_url) or _resolve_threads_profile_url(page, account)
    # Threads can render a just-submitted media post on the profile noticeably later
    # than a text-only post. Keep polling long enough to observe the permalink before
    # falling back to manual confirmation, without retrying the publish action.
    confirm_seconds = _safe_int((payload or {}).get("profile_confirm_seconds") or os.getenv("SOCIAL_AUTOMATION_THREADS_PROFILE_CONFIRM_SECONDS"), 90)
    confirm_seconds = max(15, min(confirm_seconds, 120))
    nav_timeout_ms = max(3000, min(confirm_seconds * 1000, 12000))
    normalized_previous = _normalize_threads_post_permalink(previous_permalink)
    baseline_known = previous_permalinks is not None or bool(normalized_previous)
    baseline_permalinks = {
        normalized
        for value in (previous_permalinks or set()) | ({previous_permalink} if previous_permalink else set())
        if (normalized := _normalize_threads_post_permalink(value))
    }
    try:
        _goto(page, target_url, logger, "threads_publish_profile", timeout_ms=nav_timeout_ms, networkidle_ms=2500)
    except Exception as exc:
        logger.log("warn", "threads_publish_profile_open_slow", "提交后打开账号主页超时，将继续轮询确认发布结果。", {"error": str(exc)[:500], "timeout_ms": nav_timeout_ms})
    deadline = time.time() + confirm_seconds
    attempt = 0
    while True:
        now = time.time()
        if now >= deadline:
            break
        attempt += 1
        latest_permalink = _find_latest_threads_post_permalink(page)
        permalink = _find_threads_post_permalink(page, caption) if str(caption or "").strip() else latest_permalink
        is_latest_caption_match = not str(caption or "").strip() or permalink == latest_permalink
        if baseline_known and permalink and permalink not in baseline_permalinks and is_latest_caption_match:
            return {"confirmed": True, "reason": "已在账号主页定位到本次发布帖子的链接。", "url": permalink}
        _sleep_between(1.8, 2.6)
        if attempt % 3 == 0:
            try:
                page.reload(wait_until="domcontentloaded", timeout=nav_timeout_ms)
            except Exception as exc:
                logger.log("debug", "threads_publish_profile_refresh", "账号主页刷新未完成，将继续确认发布结果。", {"error": str(exc)[:500]})
    return {"confirmed": False, "reason": "发布已提交，但账号主页未看到本次发布内容。", "url": str(page.url or target_url)}


def _capture_threads_publish_evidence(page, permalink: str, caption: str, screenshot_dir: Path, task: dict[str, Any], logger: AutomationLogger) -> str:
    try:
        _goto(page, permalink, logger, "threads_publish_result", timeout_ms=20000, networkidle_ms=3500)
        if caption:
            page.get_by_text(caption, exact=False).first.wait_for(state="visible", timeout=15000)
        else:
            page.locator('a[href*="/post/"]').first.wait_for(state="visible", timeout=15000)
        _sleep_between(1.0, 1.6)
    except Exception as exc:
        logger.log("warn", "publish_evidence_not_ready", "发布已确认，但最终帖子页面尚未稳定，未保存异常加载页截图。", {"url": permalink, "error": str(exc)[:500]})
        return ""
    return _screenshot(page, screenshot_dir, task, "publish_done", logger)


def _capture_threads_profile_baseline(page, profile_url: str, logger: AutomationLogger) -> set[str] | None:
    if not profile_url:
        return None
    try:
        _goto(page, profile_url, logger, "threads_publish_baseline", timeout_ms=12000, networkidle_ms=2500)
        permalinks = _find_threads_post_permalinks(page)
        return set(permalinks) if permalinks is not None else None
    except Exception as exc:
        logger.log("debug", "threads_publish_baseline", "发布前未能读取账号主页最新帖子，将继续使用正文确认。", {"error": str(exc)[:500]})
        return None


def _run_threads_publish_post(page, task, payload, screenshot_dir, logger, account: dict[str, Any] | None = None) -> dict[str, Any]:
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
    previous_permalinks = _capture_threads_profile_baseline(page, profile_url, logger)
    _goto(page, THREADS_HOME, logger, "threads_publish_open")
    _dismiss_threads_compose_dialogs(page, logger)
    try:
        compose = _ensure_threads_compose_ready(page, logger)
    except Exception:
        raise
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
    post_clicked = _click_threads_active_dialog_post(page, logger)
    post_button = None if post_clicked else (_threads_dialog_post_button(page) or _threads_post_button(page))
    if not post_clicked and post_button is None:
        raise RuntimeError("未找到 Threads 发布按钮。")
    if not post_clicked:
        _human_click(page, post_button, logger, "threads_publish_submit")
    success = _wait_for_threads_publish_success(page, logger)
    permalink = _normalize_threads_post_permalink(success.get("url")) if success.get("confirmed") else ""
    profile_confirmation: dict[str, Any] = {}
    if not permalink:
        profile_confirmation = _wait_for_threads_own_post(page, caption, logger, account, payload, profile_url=profile_url, previous_permalinks=previous_permalinks)
        if profile_confirmation.get("confirmed"):
            permalink = _normalize_threads_post_permalink(profile_confirmation.get("url"))
    if not permalink:
        reason = str(profile_confirmation.get("reason") or success.get("reason") or "Threads 已提交，但尚未确认发布结果。")
        message = f"{reason} 为避免重复发布，任务已停止自动重试，请人工核对账号主页。"
        shot = _screenshot(page, screenshot_dir, task, "publish_submitted_unconfirmed", logger)
        logger.log("warn", "threads_publish_unconfirmed", message, {"submit": success, "profile": profile_confirmation, "retryable": False}, shot)
        raise NeedManualError(message, "publish_submitted_unconfirmed", shot)
    shot = _capture_threads_publish_evidence(page, permalink, caption, screenshot_dir, task, logger)
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
    return {"ok": True, "published": published, "url": permalink, "screenshot_path": shot}


def _run_publish_post(page, task, payload, screenshot_dir, logger, platform: str = "instagram", account: dict[str, Any] | None = None) -> dict[str, Any]:
    if platform == "threads":
        return _run_threads_publish_post(page, task, payload, screenshot_dir, logger, account)
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
        text_input_mode = _normalize_text_input_mode(payload.get("text_input_mode") or os.getenv("SOCIAL_AUTOMATION_TEXT_INPUT_MODE", "paste"))
        logger.log("info", "publish_text_input", "正在填写 Instagram 帖子正文。", {"mode": text_input_mode, "chars": len(caption)})
        _type_text(page, caption, mode=text_input_mode, logger=logger, stage="publish_text_input")
    if not _click_text_button(page, logger, ["Share"], "publish_share"):
        raise RuntimeError("未找到 Instagram 分享按钮。")
    success = _wait_for_publish_success(page, logger)
    time.sleep(5)
    shot = _screenshot(page, screenshot_dir, task, "publish_done", logger)
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
