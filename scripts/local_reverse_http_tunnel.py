from __future__ import annotations

import os
import select
import socket
import sys
import threading
import time
from contextlib import suppress

import paramiko


SSH_HOST = os.getenv("REVERSE_TUNNEL_SSH_HOST", "47.250.188.76")
SSH_USER = os.getenv("REVERSE_TUNNEL_SSH_USER", "root")
SSH_PASSWORD = os.getenv("REVERSE_TUNNEL_SSH_PASSWORD", "")
REMOTE_HOST = os.getenv("REVERSE_TUNNEL_REMOTE_HOST", "0.0.0.0")
REMOTE_PORT = int(os.getenv("REVERSE_TUNNEL_REMOTE_PORT", "19198"))
LOCAL_HOST = os.getenv("REVERSE_TUNNEL_LOCAL_HOST", "127.0.0.1")
LOCAL_PORT = int(os.getenv("REVERSE_TUNNEL_LOCAL_PORT", "8098"))
CONNECT_TIMEOUT = float(os.getenv("REVERSE_TUNNEL_CONNECT_TIMEOUT", "20"))
LOCK_FILE = os.getenv(
    "REVERSE_TUNNEL_LOCK_FILE",
    os.path.join(os.getcwd(), ".runtime", "public-upload-tunnel", "local_reverse_http_tunnel.lock"),
)
LOCK_HOST = os.getenv("REVERSE_TUNNEL_LOCK_HOST", "127.0.0.1")
LOCK_PORT = int(os.getenv("REVERSE_TUNNEL_LOCK_PORT", "19197"))
BUFFER_SIZE = 64 * 1024


def _pipe(channel: paramiko.Channel, sock: socket.socket) -> None:
    try:
        while True:
            readable, _, _ = select.select([channel, sock], [], [], 1.0)
            if channel in readable:
                data = channel.recv(BUFFER_SIZE)
                if not data:
                    break
                sock.sendall(data)
            if sock in readable:
                data = sock.recv(BUFFER_SIZE)
                if not data:
                    break
                channel.sendall(data)
    finally:
        with suppress(Exception):
            channel.close()
        with suppress(Exception):
            sock.close()


def _handle_channel(channel: paramiko.Channel) -> None:
    try:
        sock = socket.create_connection((LOCAL_HOST, LOCAL_PORT), timeout=CONNECT_TIMEOUT)
    except Exception as exc:
        print(f"local connect failed: {LOCAL_HOST}:{LOCAL_PORT}: {exc}", file=sys.stderr, flush=True)
        with suppress(Exception):
            channel.close()
        return
    _pipe(channel, sock)


def _connect() -> paramiko.SSHClient:
    if not SSH_PASSWORD:
        raise RuntimeError("REVERSE_TUNNEL_SSH_PASSWORD is empty")
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
    transport = client.get_transport()
    if not transport:
        client.close()
        raise RuntimeError("SSH transport is unavailable")
    transport.set_keepalive(30)
    transport.request_port_forward(REMOTE_HOST, REMOTE_PORT)
    return client


def _acquire_lock():
    lock_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock_socket.bind((LOCK_HOST, LOCK_PORT))
        lock_socket.listen(1)
    except OSError:
        print("another reverse tunnel instance is already running", flush=True)
        lock_socket.close()
        return None

    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    lock = open(LOCK_FILE, "a+b")
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another reverse tunnel instance is already running", flush=True)
        lock_socket.close()
        lock.close()
        return None
    lock.seek(0)
    lock.truncate()
    lock.write(str(os.getpid()).encode("ascii", errors="ignore"))
    lock.flush()
    return (lock, lock_socket)


def main() -> int:
    lock = _acquire_lock()
    if lock is None:
        return 0
    while True:
        client: paramiko.SSHClient | None = None
        try:
            client = _connect()
            transport = client.get_transport()
            if not transport:
                raise RuntimeError("SSH transport is unavailable after connect")
            print(
                f"reverse tunnel {SSH_HOST}:{REMOTE_PORT} -> {LOCAL_HOST}:{LOCAL_PORT} is running",
                flush=True,
            )
            while transport.is_active():
                channel = transport.accept(5)
                if channel is None:
                    continue
                threading.Thread(target=_handle_channel, args=(channel,), daemon=True).start()
        except KeyboardInterrupt:
            return 130
        except Exception as exc:
            print(f"reverse tunnel error: {exc}", file=sys.stderr, flush=True)
            time.sleep(5)
        finally:
            if client is not None:
                with suppress(Exception):
                    client.close()


if __name__ == "__main__":
    raise SystemExit(main())
