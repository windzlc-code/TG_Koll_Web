from __future__ import annotations

import atexit
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class LiveBrowserSession:
    id: str
    task_id: str
    account_id: str
    account_username: str
    platform: str
    task_type: str
    display: str
    width: int
    height: int
    vnc_port: int
    web_port: int
    started_at: int
    backend: str = "kasmvnc"
    status: str = "starting"
    error: str = ""
    processes: list[subprocess.Popen] = field(default_factory=list, repr=False)
    temp_dir: str = ""


_SESSIONS: dict[str, LiveBrowserSession] = {}
_LOCK = threading.Lock()


def live_browser_enabled() -> bool:
    if os.name == "nt":
        return False
    return str(os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_ENABLED", "1")).strip().lower() not in {"0", "false", "no", "off"}


def start_live_browser_session(
    *,
    task: dict[str, Any],
    account: dict[str, Any],
    logger: Any | None = None,
) -> LiveBrowserSession | None:
    if not live_browser_enabled():
        return None

    missing = [name for name in ("Xvnc",) if not shutil.which(name)]
    kasm_www_dir = Path(os.getenv("SOCIAL_AUTOMATION_KASMVNC_WWW_DIR", "/usr/share/kasmvnc/www"))
    if missing or not kasm_www_dir.exists():
        _log(
            logger,
            "warn",
            "live_browser_unavailable",
            "KasmVNC 监控依赖未安装，已回退到普通浏览器执行",
            {"missing": missing, "kasm_www_dir": str(kasm_www_dir)},
        )
        return None

    width = _safe_int(os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_WIDTH"), 720)
    height = _safe_int(os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_HEIGHT"), 1280)
    task_id = str(task.get("id") or f"task_{int(time.time())}")
    account_id = str(account.get("id") or "")
    session_id = f"live_{task_id}"

    with _LOCK:
        if session_id in _SESSIONS:
            return _SESSIONS[session_id]
        display_num = _allocate_display_number()
        web_port = _allocate_tcp_port()
        vnc_port = web_port

    temp_dir = tempfile.mkdtemp(prefix="wk_live_browser_")

    session = LiveBrowserSession(
        id=session_id,
        task_id=task_id,
        account_id=account_id,
        account_username=str(account.get("username") or account.get("display_name") or account_id),
        platform=str(task.get("platform") or account.get("platform") or ""),
        task_type=str(task.get("task_type") or ""),
        display=f":{display_num}",
        width=width,
        height=height,
        vnc_port=vnc_port,
        web_port=web_port,
        started_at=int(time.time()),
        temp_dir=temp_dir,
    )

    try:
        session.processes.append(
            subprocess.Popen(
                [
                    "Xvnc",
                    session.display,
                    "-geometry",
                    f"{width}x{height}",
                    "-depth",
                    "24",
                    "-ac",
                    "-interface",
                    "127.0.0.1",
                    "-websocketPort",
                    str(web_port),
                    "-SecurityTypes",
                    "None",
                    "-DisableBasicAuth=1",
                    "-sslOnly=0",
                    "-httpd",
                    str(kasm_www_dir),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
        _wait_for_live_browser_ready(session)
        session.status = "running"
        with _LOCK:
            _SESSIONS[session.id] = session
        _log(
            logger,
            "info",
            "live_browser_ready",
            "KasmVNC 实时浏览器监控已启动",
            {"display": session.display, "web_port": web_port, "resolution": f"{width}x{height}"},
        )
        return session
    except Exception as exc:
        session.status = "failed"
        session.error = str(exc)
        stop_live_browser_session(session.id, session=session)
        _log(logger, "warn", "live_browser_failed", "实时浏览器监控启动失败，已回退到普通浏览器执行", {"error": str(exc)})
        return None


def stop_live_browser_session(session_id: str, *, session: LiveBrowserSession | None = None) -> None:
    with _LOCK:
        target = session or _SESSIONS.pop(str(session_id), None)
    if not target:
        return
    for process in reversed(target.processes):
        if process.poll() is not None:
            continue
        try:
            process.terminate()
            process.wait(timeout=3)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
    if target.temp_dir:
        shutil.rmtree(target.temp_dir, ignore_errors=True)


def list_live_browser_sessions() -> list[dict[str, Any]]:
    with _LOCK:
        sessions = list(_SESSIONS.values())
    rows: list[dict[str, Any]] = []
    for session in sessions:
        alive = all(process.poll() is None for process in session.processes)
        if not alive:
            stop_live_browser_session(session.id)
            continue
        rows.append(_session_public(session))
    return rows


def get_live_browser_session(session_id: str) -> LiveBrowserSession | None:
    with _LOCK:
        session = _SESSIONS.get(str(session_id))
    if not session:
        return None
    if not all(process.poll() is None for process in session.processes):
        stop_live_browser_session(session.id)
        return None
    return session


def _session_public(session: LiveBrowserSession) -> dict[str, Any]:
    ws_path = f"api/persona_dashboard/automation/browser_sessions/{session.id}/ws"
    view_path = f"/api/persona_dashboard/automation/browser_sessions/{session.id}/kasm/vnc.html?autoconnect=1&resize=scale&reconnect=1&path={ws_path}"
    return {
        "id": session.id,
        "task_id": session.task_id,
        "account_id": session.account_id,
        "account_username": session.account_username,
        "platform": session.platform,
        "task_type": session.task_type,
        "display": session.display,
        "width": session.width,
        "height": session.height,
        "web_port": session.web_port,
        "backend": session.backend,
        "ws_path": ws_path,
        "view_path": view_path,
        "novnc_path": view_path,
        "password": "",
        "started_at": session.started_at,
        "status": session.status,
        "error": session.error,
    }


def _allocate_display_number() -> int:
    used = {int(session.display.lstrip(":")) for session in _SESSIONS.values() if session.display.lstrip(":").isdigit()}
    running = _running_xvnc_displays()
    for display in range(90, 140):
        socket_path = Path(f"/tmp/.X11-unix/X{display}")
        if display not in used and socket_path.exists() and display not in running:
            with contextlib.suppress(Exception):
                socket_path.unlink()
        if display not in used and display not in running and not socket_path.exists():
            return display
    raise RuntimeError("没有可用的 KasmVNC display")


def _running_xvnc_displays() -> set[int]:
    try:
        result = subprocess.run(["pgrep", "-af", "Xvnc"], check=False, capture_output=True, text=True, timeout=2)
    except Exception:
        return set()
    displays: set[int] = set()
    for line in (result.stdout or "").splitlines():
        parts = line.split()
        for part in parts:
            if part.startswith(":") and part[1:].isdigit():
                displays.add(int(part[1:]))
                break
    return displays


def _allocate_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_live_browser_ready(session: LiveBrowserSession, *, timeout_seconds: float = 8.0) -> None:
    deadline = time.time() + timeout_seconds
    last_error = "KasmVNC did not become ready"
    while time.time() < deadline:
        if not all(process.poll() is None for process in session.processes):
            codes = [process.poll() for process in session.processes]
            raise RuntimeError(f"KasmVNC exited before ready: {codes}")
        try:
            with socket.create_connection(("127.0.0.1", int(session.web_port)), timeout=0.35):
                return
        except OSError as exc:
            last_error = str(exc)
            time.sleep(0.15)
    raise RuntimeError(f"KasmVNC port {session.web_port} is not ready: {last_error}")


def _safe_int(value: Any, fallback: int) -> int:
    try:
        number = int(value)
        return number if number > 0 else fallback
    except Exception:
        return fallback


def _log(logger: Any | None, level: str, stage: str, message: str, data: dict[str, Any] | None = None) -> None:
    if logger is None:
        return
    try:
        logger.log(level, stage, message, data or {})
    except Exception:
        pass


@atexit.register
def _cleanup_all_sessions() -> None:
    with _LOCK:
        ids = list(_SESSIONS.keys())
    for session_id in ids:
        stop_live_browser_session(session_id)
