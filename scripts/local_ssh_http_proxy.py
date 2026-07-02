from __future__ import annotations

import os
import socket
import socketserver
import sys
import threading
import time
from contextlib import suppress

import paramiko


LISTEN_HOST = os.getenv("SSH_HTTP_PROXY_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.getenv("SSH_HTTP_PROXY_LISTEN_PORT", "9974"))
SSH_HOST = os.getenv("SSH_HTTP_PROXY_SSH_HOST", "47.250.188.76")
SSH_USER = os.getenv("SSH_HTTP_PROXY_SSH_USER", "root")
SSH_PASSWORD = os.getenv("SSH_HTTP_PROXY_SSH_PASSWORD", "")
CONNECT_TIMEOUT = float(os.getenv("SSH_HTTP_PROXY_CONNECT_TIMEOUT", "20"))
BUFFER_SIZE = 64 * 1024

_ssh_lock = threading.Lock()
_ssh_client: paramiko.SSHClient | None = None


def _close_ssh() -> None:
    global _ssh_client
    with _ssh_lock:
        if _ssh_client is not None:
            with suppress(Exception):
                _ssh_client.close()
        _ssh_client = None


def _get_ssh() -> paramiko.SSHClient:
    global _ssh_client
    if not SSH_PASSWORD:
        raise RuntimeError("SSH_HTTP_PROXY_SSH_PASSWORD is empty")
    with _ssh_lock:
        if _ssh_client is not None:
            transport = _ssh_client.get_transport()
            if transport and transport.is_active():
                return _ssh_client

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            SSH_HOST,
            username=SSH_USER,
            password=SSH_PASSWORD,
            timeout=CONNECT_TIMEOUT,
            banner_timeout=CONNECT_TIMEOUT,
            auth_timeout=CONNECT_TIMEOUT,
            look_for_keys=False,
            allow_agent=False,
        )
        _ssh_client = client
        return client


def _open_remote_channel(host: str, port: int):
    try:
        ssh = _get_ssh()
        transport = ssh.get_transport()
        if not transport or not transport.is_active():
            raise RuntimeError("inactive SSH transport")
        return transport.open_channel(
            "direct-tcpip",
            (host, port),
            ("127.0.0.1", 0),
            timeout=CONNECT_TIMEOUT,
        )
    except Exception:
        _close_ssh()
        ssh = _get_ssh()
        transport = ssh.get_transport()
        if not transport or not transport.is_active():
            raise RuntimeError("inactive SSH transport after reconnect")
        return transport.open_channel(
            "direct-tcpip",
            (host, port),
            ("127.0.0.1", 0),
            timeout=CONNECT_TIMEOUT,
        )


def _pipe(src, dst, close_event: threading.Event) -> None:
    try:
        while not close_event.is_set():
            data = src.recv(BUFFER_SIZE)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        close_event.set()
        with suppress(Exception):
            dst.shutdown(socket.SHUT_WR)


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(CONNECT_TIMEOUT)
        raw = b""
        while b"\r\n\r\n" not in raw and len(raw) < 8192:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            raw += chunk

        header = raw.decode("iso-8859-1", errors="replace")
        first = header.split("\r\n", 1)[0]
        parts = first.split()
        if len(parts) < 3 or parts[0].upper() != "CONNECT" or ":" not in parts[1]:
            self.request.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return

        host, port_text = parts[1].rsplit(":", 1)
        try:
            port = int(port_text)
        except ValueError:
            self.request.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return

        try:
            channel = _open_remote_channel(host, port)
        except Exception as exc:
            message = f"HTTP/1.1 502 Bad Gateway\r\nX-Error: {str(exc)[:200]}\r\n\r\n"
            self.request.sendall(message.encode("utf-8", errors="ignore"))
            return

        self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        close_event = threading.Event()
        t1 = threading.Thread(target=_pipe, args=(self.request, channel, close_event), daemon=True)
        t2 = threading.Thread(target=_pipe, args=(channel, self.request, close_event), daemon=True)
        t1.start()
        t2.start()
        while not close_event.is_set():
            time.sleep(0.05)
        with suppress(Exception):
            channel.close()


class ThreadingServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    server = ThreadingServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    print(f"SSH HTTP CONNECT proxy listening on http://{LISTEN_HOST}:{LISTEN_PORT} via {SSH_USER}@{SSH_HOST}", flush=True)
    try:
        server.serve_forever()
    finally:
        _close_ssh()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
