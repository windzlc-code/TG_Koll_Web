from __future__ import annotations

import atexit
import contextlib
import json
import os
import signal
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlencode
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
    browser_ready_at: int = 0
    error: str = ""
    standby_started_at: int = 0
    close_at: int = 0
    process_pids: list[int] = field(default_factory=list)
    process_identities: list[dict[str, Any]] = field(default_factory=list)
    processes: list[subprocess.Popen] = field(default_factory=list, repr=False)
    temp_dir: str = ""


_SESSIONS: dict[str, LiveBrowserSession] = {}
_CLOSE_CALLBACKS: dict[str, Callable[[], None]] = {}
_LOCK = threading.Lock()
_ORPHAN_CLEANUP_DONE = False
_SIGKILL = getattr(signal, "SIGKILL", 9)


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

    _stop_standby_sessions_for_account(str(account.get("id") or ""), logger)
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
        _capture_session_process_identities(session)
        with _LOCK:
            _SESSIONS[session.id] = session
        _save_session_registry(session)
        _wait_for_live_browser_ready(session)
        session.status = "running"
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


def _stop_standby_sessions_for_account(account_id: str, logger: Any | None = None) -> None:
    clean_account_id = str(account_id or "").strip()
    if not clean_account_id:
        return
    with _LOCK:
        targets = {
            session.id
            for session in _SESSIONS.values()
            if session.account_id == clean_account_id and session.status == "standby"
        }
    for session_id, row in _read_registry().items():
        if str(row.get("account_id") or "") == clean_account_id and str(row.get("status") or "") == "standby":
            targets.add(str(session_id))
    for session_id in targets:
        stop_live_browser_session(session_id)
    released = sorted(targets)
    if released:
        _log(
            logger,
            "info",
            "live_browser_standby_released",
            "已关闭同账号待机浏览器，准备执行新的自动化任务。",
            {"account_id": clean_account_id, "sessions": released},
        )


def stop_live_browser_session(
    session_id: str,
    *,
    session: LiveBrowserSession | None = None,
    timeout_seconds: float = 3.0,
) -> None:
    deadline = time.monotonic() + max(0.1, float(timeout_seconds))
    clean_id = str(session_id)
    with _LOCK:
        target = session or _SESSIONS.pop(clean_id, None)
        if session is not None:
            _SESSIONS.pop(clean_id, None)
        callback = _CLOSE_CALLBACKS.pop(clean_id, None)
    if callback is not None:
        with contextlib.suppress(Exception):
            callback()
    if not target:
        target = _load_registry_session(clean_id)
    if not target:
        _remove_session_registry(clean_id)
        return
    active_processes = [process for process in reversed(target.processes) if process.poll() is None]
    for action in ("terminate", "wait", "kill", "wait"):
        for process in active_processes:
            if process.poll() is None:
                with contextlib.suppress(Exception):
                    if action == "wait":
                        process.wait(timeout=max(0.0, deadline - time.monotonic()))
                    else:
                        getattr(process, action)()
    if not target.processes:
        _terminate_registry_session_processes(target)
    if target.temp_dir:
        shutil.rmtree(target.temp_dir, ignore_errors=True)
    _remove_session_registry(target.id)


def stop_live_browser_sessions_for_task(task_id: str, *, timeout_seconds: float = 3.0) -> None:
    clean_task_id = str(task_id or "").strip()
    if not clean_task_id:
        return
    with _LOCK:
        session_ids = {session.id for session in _SESSIONS.values() if session.task_id == clean_task_id}
    for session_id, row in _read_registry().items():
        if str(row.get("task_id") or "") == clean_task_id:
            session_ids.add(str(session_id))
    session_ids.add(f"live_{clean_task_id}")
    _stop_live_browser_session_ids(session_ids, timeout_seconds)


def stop_all_live_browser_sessions(*, timeout_seconds: float = 5.0) -> None:
    with _LOCK:
        session_ids = set(_SESSIONS.keys())
    session_ids.update(session.id for session in _load_registry_sessions())
    _stop_live_browser_session_ids(session_ids, timeout_seconds)


def _stop_live_browser_session_ids(session_ids: set[str], timeout_seconds: float) -> None:
    deadline = time.monotonic() + max(0.1, float(timeout_seconds))
    for session_id in session_ids:
        with contextlib.suppress(Exception):
            stop_live_browser_session(
                session_id,
                timeout_seconds=max(0.1, deadline - time.monotonic()),
            )


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


def mark_live_browser_session_ready(session_id: str) -> None:
    clean_id = str(session_id or "")
    if not clean_id:
        return
    ready_at = int(time.time())
    with _LOCK:
        session = _SESSIONS.get(clean_id)
        if session is not None:
            session.browser_ready_at = ready_at
            _save_session_registry(session)
            return
    sessions = _read_registry()
    row = sessions.get(clean_id)
    if not row:
        return
    row["browser_ready_at"] = ready_at
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
    params = urlencode(
        {
            "autoconnect": 1,
            "resize": "scale",
            "reconnect": 1,
            "quality": 5,
            "dynamic_quality_min": 3,
            "dynamic_quality_max": 7,
            "jpeg_video_quality": 5,
            "webp_video_quality": 4,
            "video_quality": 1,
            "video_time": 1,
            "video_out_time": 1,
            "video_scaling": 1,
            "max_video_resolution_x": 960,
            "max_video_resolution_y": 540,
            "framerate": 24,
            "compression": 2,
            "enable_webp": 1,
            "enable_webrtc": 0,
            "enable_threading": 1,
            "path": ws_path,
        }
    )
    kasm_path = f"/api/persona_dashboard/automation/browser_sessions/{session.id}/kasm/vnc.html?{params}"
    live_pids = [int(process.pid) for process in session.processes if getattr(process, "pid", None)]
    process_pids = sorted({*session.process_pids, *live_pids})
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
        "browser_ready": session.browser_ready_at > 0,
        "browser_ready_at": session.browser_ready_at,
        "error": session.error,
        "standby_started_at": session.standby_started_at,
        "close_at": session.close_at,
        "process_pids": process_pids,
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
    sessions[session.id] = _session_registry_row(session)
    _write_registry(sessions)


def _session_registry_row(session: LiveBrowserSession) -> dict[str, Any]:
    row = _session_public(session)
    row["process_identities"] = [dict(identity) for identity in session.process_identities]
    return row


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
        browser_ready_at=_safe_int(row.get("browser_ready_at"), 0),
        error=str(row.get("error") or ""),
        standby_started_at=_safe_int(row.get("standby_started_at"), 0),
        close_at=_safe_int(row.get("close_at"), 0),
        process_pids=[_safe_int(pid, 0) for pid in row.get("process_pids", []) if _safe_int(pid, 0) > 0] if isinstance(row.get("process_pids"), list) else [],
        process_identities=[dict(identity) for identity in row.get("process_identities", []) if isinstance(identity, dict)]
        if isinstance(row.get("process_identities"), list)
        else [],
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


def _terminate_registry_session_processes(session: LiveBrowserSession) -> int:
    terminated = 0
    seen_pids: set[int] = set()
    for recorded in session.process_identities:
        pid = _safe_int(recorded.get("pid"), 0)
        if pid <= 1 or pid in seen_pids:
            continue
        seen_pids.add(pid)
        pidfd = _open_process_pidfd(pid)
        try:
            if not _registry_process_identity_matches(session, recorded, pid):
                continue
            try:
                _send_process_signal(pid, signal.SIGTERM, pidfd)
            except OSError:
                continue
            terminated += 1
            time.sleep(0.4)
            if not _registry_process_identity_matches(session, recorded, pid):
                continue
            with contextlib.suppress(OSError):
                _send_process_signal(pid, _SIGKILL, pidfd)
        finally:
            if pidfd is not None:
                with contextlib.suppress(OSError):
                    os.close(pidfd)
    return terminated


def _capture_session_process_identities(session: LiveBrowserSession) -> None:
    process_pids: list[int] = []
    identities: list[dict[str, Any]] = []
    for process in session.processes:
        pid = _safe_int(getattr(process, "pid", 0), 0)
        if pid <= 1:
            continue
        process_pids.append(pid)
        current = _read_process_identity(pid)
        if not _is_expected_xvnc_process(current, session.display):
            continue
        identities.append(
            {
                "pid": pid,
                "boot_id": str(current["boot_id"]),
                "start_ticks": str(current["start_ticks"]),
                "executable": str(current["executable"]),
                "argv0": str(current["argv0"]),
                "display": session.display,
            }
        )
    session.process_pids = process_pids
    session.process_identities = identities


def _registry_process_identity_matches(
    session: LiveBrowserSession,
    recorded: dict[str, Any],
    pid: int,
) -> bool:
    expected = {
        "pid": str(pid),
        "boot_id": str(recorded.get("boot_id") or ""),
        "start_ticks": str(recorded.get("start_ticks") or ""),
        "executable": str(recorded.get("executable") or ""),
        "argv0": str(recorded.get("argv0") or ""),
        "display": str(recorded.get("display") or ""),
    }
    if not all(expected.values()) or expected["display"] != session.display:
        return False
    if Path(expected["argv0"]).name.lower() != "xvnc":
        return False
    current = _read_process_identity(pid)
    if not _is_expected_xvnc_process(current, session.display):
        return False
    return (
        str(current.get("pid")) == expected["pid"]
        and str(current.get("boot_id")) == expected["boot_id"]
        and str(current.get("start_ticks")) == expected["start_ticks"]
        and str(current.get("executable")) == expected["executable"]
    )


def _is_expected_xvnc_process(identity: dict[str, Any] | None, display: str) -> bool:
    if not identity or not display:
        return False
    argv0 = Path(str(identity.get("argv0") or "")).name.lower()
    args = identity.get("args")
    return argv0 == "xvnc" and isinstance(args, list) and display in args and bool(identity.get("executable"))


def _read_process_identity(pid: int, proc_root: Path = Path("/proc")) -> dict[str, Any] | None:
    process_root = proc_root / str(pid)
    try:
        stat = (process_root / "stat").read_text(encoding="utf-8")
        command_end = stat.rfind(")")
        stat_fields = stat[command_end + 2 :].split()
        if command_end < 0 or len(stat_fields) <= 19:
            return None
        args = [part.decode("utf-8", errors="replace") for part in (process_root / "cmdline").read_bytes().split(b"\0") if part]
        executable = os.readlink(process_root / "exe")
        boot_id = (proc_root / "sys" / "kernel" / "random" / "boot_id").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return None
    if not args or not boot_id:
        return None
    return {
        "pid": pid,
        "boot_id": boot_id,
        "start_ticks": stat_fields[19],
        "executable": executable,
        "argv0": args[0],
        "args": args,
    }


def _open_process_pidfd(pid: int) -> int | None:
    pidfd_open = getattr(os, "pidfd_open", None)
    pidfd_send_signal = getattr(signal, "pidfd_send_signal", None)
    if not callable(pidfd_open) or not callable(pidfd_send_signal):
        return None
    try:
        return int(pidfd_open(pid, 0))
    except OSError:
        return None


def _send_process_signal(pid: int, signum: int, pidfd: int | None) -> None:
    if pidfd is not None:
        signal.pidfd_send_signal(pidfd, signum, None, 0)
        return
    os.kill(pid, signum)


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

    stopped = 0
    for session in _load_registry_sessions():
        stopped += _terminate_registry_session_processes(session)
        _remove_session_registry(session.id)
    if stopped:
        _log(logger, "info", "live_browser_orphan_cleanup", "已清理上次遗留的实时浏览器进程", {"count": stopped})


def _wait_for_live_browser_ready(session: LiveBrowserSession, *, timeout_seconds: float = 8.0) -> None:
    deadline = time.time() + timeout_seconds
    last_error = "KasmVNC 未在限定时间内就绪"
    display_num = str(session.display or "").lstrip(":")
    x_socket = Path(f"/tmp/.X11-unix/X{display_num}") if display_num.isdigit() else None
    while time.time() < deadline:
        if not all(process.poll() is None for process in session.processes):
            codes = [process.poll() for process in session.processes]
            raise RuntimeError(f"KasmVNC 就绪前退出：{codes}")
        try:
            with socket.create_connection(("127.0.0.1", int(session.web_port)), timeout=0.35):
                if _x_display_ready(session.display, x_socket):
                    return
                last_error = f"X11 display {session.display} 尚未就绪"
        except OSError as exc:
            last_error = str(exc)
        time.sleep(0.2)
    raise RuntimeError(f"KasmVNC 端口或 X11 显示未就绪：{last_error}")


def _x_display_ready(display: str, x_socket: Path | None) -> bool:
    if x_socket is not None and not x_socket.exists():
        return False
    if shutil.which("xdpyinfo"):
        try:
            result = subprocess.run(
                ["xdpyinfo", "-display", str(display)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=1,
            )
            return result.returncode == 0
        except Exception:
            return False
    return x_socket is None or x_socket.exists()


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
    stop_all_live_browser_sessions()
