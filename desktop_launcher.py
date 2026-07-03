from __future__ import annotations

import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from runtime_config_bootstrap import bundled_root, ensure_runtime_config_file


APP_NAME = "WorkflowDesktop"
DISPLAY_NAME = "Web 素材生成平台"
WINDOW_TITLE = f"{DISPLAY_NAME} - 桌面版"


def _desktop_icon_path() -> Path:
    for candidate in (
        bundled_root() / "desktop_assets" / "desktop-icon.ico",
        Path(__file__).resolve().parent / "desktop_assets" / "desktop-icon.ico",
    ):
        if candidate.exists():
            return candidate.resolve()
    return Path("")


def _default_data_root() -> Path:
    override = str(os.getenv("WORKFLOW_DESKTOP_DATA_DIR", "") or "").strip()
    if override:
        return Path(override).expanduser().resolve()

    if sys.platform == "win32":
        base = os.getenv("LOCALAPPDATA")
        return Path(base).expanduser().resolve() / APP_NAME if base else Path.home() / "AppData" / "Local" / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.getenv("XDG_DATA_HOME")
    return Path(base).expanduser().resolve() / APP_NAME if base else Path.home() / ".local" / "share" / APP_NAME


def _prepare_runtime() -> Path:
    data_root = _default_data_root()
    webapp_data = data_root / "webapp_data"
    webapp_data.mkdir(parents=True, exist_ok=True)
    ensure_runtime_config_file(webapp_data / "runtime_config.json")

    os.environ.setdefault("WEBAPP_DATA_DIR", str(webapp_data))
    os.environ.setdefault("APP_DB_PATH", str(webapp_data / "app.db"))
    os.environ.setdefault("APP_RUNTIME_CONFIG_PATH", str(webapp_data / "runtime_config.json"))

    bin_dir = bundled_root() / "bin"
    if bin_dir.exists():
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")

    data_root.mkdir(parents=True, exist_ok=True)
    os.chdir(data_root)
    return data_root


def _startup_log_path(data_root: Path | None = None) -> Path:
    base = data_root if data_root is not None else Path(__file__).resolve().parent
    return base / "startup-error.log"


def _write_startup_error(exc: BaseException, data_root: Path | None = None) -> Path:
    log_path = _startup_log_path(data_root)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    message = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    log_path.write_text(message, encoding="utf-8")
    return log_path


def _show_error_dialog(message: str) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, WINDOW_TITLE, 0x10)
    except Exception:
        pass


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_until_ready(url: str, timeout_seconds: float = 60.0) -> None:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as response:
                if 200 <= int(response.status) < 500:
                    return
        except Exception as exc:
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"Local server did not start in time: {last_error}")


def _start_server(port: int) -> tuple[uvicorn.Server, threading.Thread]:
    from webapp.server import app

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        log_config=None,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="workflow-uvicorn", daemon=True)
    thread.start()
    return server, thread


def _open_window(url: str) -> None:
    try:
        import webview
    except Exception:
        webbrowser.open(url)
        while True:
            time.sleep(1)
    icon_path = _desktop_icon_path()
    try:
        webview.create_window(
            WINDOW_TITLE,
            url,
            width=1280,
            height=860,
            min_size=(1024, 700),
            background_color="#F5F7FA",
        )
        webview.start(icon=str(icon_path) if icon_path else None)
    except Exception:
        # Fallback to the system browser when the desktop shell cannot start
        # (for example missing WebView runtime or local pywebview backend issues).
        webbrowser.open(url)
        while True:
            time.sleep(1)


def main() -> int:
    data_root: Path | None = None
    server: uvicorn.Server | None = None
    thread: threading.Thread | None = None
    try:
        data_root = _prepare_runtime()
        port = _find_free_port()
        url = f"http://127.0.0.1:{port}/"
        server, thread = _start_server(port)
        _wait_until_ready(url)
        _open_window(url)
    except Exception as exc:
        log_path = _write_startup_error(exc, data_root)
        print(f"{WINDOW_TITLE} startup failed. See: {log_path}", file=sys.stderr)
        _show_error_dialog(f"启动失败，请查看日志：\n{log_path}")
        return 1
    finally:
        if server is not None:
            server.should_exit = True
        if thread is not None:
            thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
