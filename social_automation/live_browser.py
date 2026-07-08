from __future__ import annotations

import atexit
import contextlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


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
    standby_started_at: int = 0
    close_at: int = 0
    processes: list[subprocess.Popen] = field(default_factory=list, repr=False)
    temp_dir: str = ""


_SESSIONS: dict[str, LiveBrowserSession] = {}
_CLOSE_CALLBACKS: dict[str, Callable[[], None]] = {}
_LOCK = threading.Lock()
_ORPHAN_CLEANUP_DONE = False


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

    _cleanup_orphaned_live_browser_processes(logger)

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

    width = _safe_int(os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_WIDTH"), 1600)
    height = _safe_int(os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_HEIGHT"), 900)
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
        _save_session_registry(session)
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
        if session is not None:
            _SESSIONS.pop(str(session_id), None)
        callback = _CLOSE_CALLBACKS.pop(str(session_id), None)
    if callback is not None:
        with contextlib.suppress(Exception):
            callback()
    if not target:
        _remove_session_registry(str(session_id))
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
    _remove_session_registry(target.id)


def mark_live_browser_session_standby(session_id: str, *, close_at: int = 0) -> None:
    clean_id = str(session_id or "")
    if not clean_id:
        return
    now = int(time.time())
    with _LOCK:
        session = _SESSIONS.get(clean_id)
        if session is not None:
            session.status = "standby"
            session.standby_started_at = now
            session.close_at = max(0, int(close_at or 0))
            _save_session_registry(session)
            return
    sessions = _read_registry()
    row = sessions.get(clean_id)
    if not row:
        return
    row["status"] = "standby"
    row["standby_started_at"] = now
    row["close_at"] = max(0, int(close_at or 0))
    sessions[clean_id] = row
    _write_registry(sessions)


def register_live_browser_close_callback(session_id: str, callback: Callable[[], None]) -> None:
    clean_id = str(session_id or "")
    if not clean_id:
        return
    with _LOCK:
        _CLOSE_CALLBACKS[clean_id] = callback


def list_live_browser_sessions() -> list[dict[str, Any]]:
    with _LOCK:
        sessions = list(_SESSIONS.values())
    registry_sessions = _load_registry_sessions()
    known_ids = {session.id for session in sessions}
    sessions.extend(session for session in registry_sessions if session.id not in known_ids)
    rows: list[dict[str, Any]] = []
    now = int(time.time())
    for session in sessions:
        alive = _session_processes_alive(session)
        if not alive:
            stop_live_browser_session(session.id)
            continue
        if session.status == "standby" and session.close_at and session.close_at <= now:
            stop_live_browser_session(session.id)
            continue
        rows.append(_session_public(session))
    return rows


def get_live_browser_session(session_id: str) -> LiveBrowserSession | None:
    with _LOCK:
        session = _SESSIONS.get(str(session_id))
    if not session:
        session = _load_registry_session(str(session_id))
    if not session:
        return None
    if not _session_processes_alive(session):
        stop_live_browser_session(session.id)
        return None
    if session.status == "standby" and session.close_at and session.close_at <= int(time.time()):
        stop_live_browser_session(session.id)
        return None
    return session


def _session_public(session: LiveBrowserSession) -> dict[str, Any]:
    ws_path = f"api/persona_dashboard/automation/browser_sessions/{session.id}/ws"
    kasm_path = f"/api/persona_dashboard/automation/browser_sessions/{session.id}/kasm/vnc.html?autoconnect=1&resize=scale&reconnect=1&path={ws_path}"
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
        "view_path": kasm_path,
        "novnc_path": kasm_path,
        "kasm_path": kasm_path,
        "password": "",
        "started_at": session.started_at,
        "status": session.status,
        "error": session.error,
        "standby_started_at": session.standby_started_at,
        "close_at": session.close_at,
    }


def _registry_path() -> Path:
    default_root = Path(__file__).resolve().parent.parent / "webapp_data"
    data_root = Path(os.getenv("WEBAPP_DATA_DIR", str(default_root))).resolve()
    return data_root / "social_automation" / "live_browser_sessions.json"


def _read_registry() -> dict[str, dict[str, Any]]:
    path = _registry_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    sessions = data.get("sessions", data)
    if not isinstance(sessions, dict):
        return {}
    return {str(key): value for key, value in sessions.items() if isinstance(value, dict)}


def _write_registry(sessions: dict[str, dict[str, Any]]) -> None:
    path = _registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"sessions": sessions}, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _save_session_registry(session: LiveBrowserSession) -> None:
    sessions = _read_registry()
    sessions[session.id] = _session_public(session)
    _write_registry(sessions)


def _remove_session_registry(session_id: str) -> None:
    sessions = _read_registry()
    if sessions.pop(str(session_id), None) is not None:
        _write_registry(sessions)


def _load_registry_sessions() -> list[LiveBrowserSession]:
    return [session for session in (_session_from_registry(row) for row in _read_registry().values()) if session is not None]


def _load_registry_session(session_id: str) -> LiveBrowserSession | None:
    row = _read_registry().get(str(session_id))
    if not row:
        return None
    return _session_from_registry(row)


def _session_from_registry(row: dict[str, Any]) -> LiveBrowserSession | None:
    session_id = str(row.get("id") or "").strip()
    if not session_id:
        return None
    return LiveBrowserSession(
        id=session_id,
        task_id=str(row.get("task_id") or ""),
        account_id=str(row.get("account_id") or ""),
        account_username=str(row.get("account_username") or row.get("account_id") or ""),
        platform=str(row.get("platform") or ""),
        task_type=str(row.get("task_type") or ""),
        display=str(row.get("display") or ""),
        width=_safe_int(row.get("width"), 1600),
        height=_safe_int(row.get("height"), 900),
        vnc_port=_safe_int(row.get("web_port") or row.get("vnc_port"), 0),
        web_port=_safe_int(row.get("web_port") or row.get("vnc_port"), 0),
        started_at=_safe_int(row.get("started_at"), int(time.time())),
        backend=str(row.get("backend") or "kasmvnc"),
        status=str(row.get("status") or "running"),
        error=str(row.get("error") or ""),
        standby_started_at=_safe_int(row.get("standby_started_at"), 0),
        close_at=_safe_int(row.get("close_at"), 0),
    )


def _session_processes_alive(session: LiveBrowserSession) -> bool:
    if session.processes:
        return all(process.poll() is None for process in session.processes)
    return _tcp_port_open(session.web_port)


def _tcp_port_open(port: int) -> bool:
    if not port:
        return False
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.35):
            return True
    except OSError:
        return False


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


def _cleanup_orphaned_live_browser_processes(logger: Any | None = None) -> None:
    global _ORPHAN_CLEANUP_DONE
    with _LOCK:
        if _ORPHAN_CLEANUP_DONE or _SESSIONS:
            return
        _ORPHAN_CLEANUP_DONE = True
    if str(os.getenv("SOCIAL_AUTOMATION_LIVE_BROWSER_CLEAN_ORPHANS", "1")).strip().lower() in {"0", "false", "no", "off"}:
        return

    patterns = [
        r"Xvnc :9[0-9]\b",
        r"Xvnc :1[0-3][0-9]\b",
        r"camoufox-bin .*social_automation/profiles/",
    ]
    stopped = 0
    for pattern in patterns:
        try:
            result = subprocess.run(["pgrep", "-f", pattern], check=False, capture_output=True, text=True, timeout=3)
        except Exception:
            continue
        pids = [pid.strip() for pid in (result.stdout or "").splitlines() if pid.strip().isdigit()]
        for pid in pids:
            try:
                subprocess.run(["kill", "-TERM", pid], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
                stopped += 1
            except Exception:
                continue
    if stopped:
        _log(logger, "info", "live_browser_orphan_cleanup", "已清理上次遗留的实时浏览器进程", {"count": stopped})


def _wait_for_live_browser_ready(session: LiveBrowserSession, *, timeout_seconds: float = 8.0) -> None:
    deadline = time.time() + timeout_seconds
    last_error = "KasmVNC 未在限定时间内就绪"
    while time.time() < deadline:
        if not all(process.poll() is None for process in session.processes):
            codes = [process.poll() for process in session.processes]
            raise RuntimeError(f"KasmVNC 就绪前退出：{codes}")
        try:
            with socket.create_connection(("127.0.0.1", int(session.web_port)), timeout=0.35):
                return
        except OSError as exc:
            last_error = str(exc)
            time.sleep(0.15)
    raise RuntimeError(f"KasmVNC 端口 {session.web_port} 未就绪：{last_error}")


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
