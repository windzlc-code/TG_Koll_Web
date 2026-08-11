from __future__ import annotations

import contextlib
import ipaddress
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .remote_fetch_protocol import canonical_json_bytes, signed_headers, validate_idempotency_key


def _container_default_gateway_ipv4() -> str:
    """Return the Linux container's actual default IPv4 gateway, if available."""
    try:
        lines = Path("/proc/net/route").read_text(encoding="ascii").splitlines()[1:]
    except OSError:
        return ""
    for line in lines:
        fields = line.split()
        if len(fields) < 4 or fields[1] != "00000000":
            continue
        try:
            flags = int(fields[3], 16)
            raw_gateway = bytes.fromhex(fields[2])
            gateway = str(ipaddress.IPv4Address(raw_gateway[::-1]))
        except (ValueError, IndexError):
            continue
        if flags & 0x2:
            return gateway
    return ""


def _remote_fetch_config() -> dict[str, Any]:
    path = Path(
        os.getenv(
            "TG_REMOTE_FETCH_CONFIG_FILE",
            "/data/internal/remote-fetch-config.json",
        )
    ).resolve()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:
        raise RemoteFetchError(
            "unable to read remote fetch config file",
            status_code=500,
            retryable=False,
        ) from exc
    if not isinstance(value, dict):
        raise RemoteFetchError(
            "remote fetch config file must contain an object",
            status_code=500,
            retryable=False,
        )
    return value


def configured_mode() -> str:
    config = _remote_fetch_config()
    return str(os.getenv("TG_REMOTE_FETCH_MODE") or config.get("mode") or "local").strip().lower()


class RemoteFetchError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 503, retryable: bool = True):
        super().__init__(str(message or "remote fetch failed"))
        self.status_code = int(status_code)
        self.retryable = bool(retryable)


@dataclass(frozen=True)
class RemoteFetchSettings:
    base_url: str
    key_id: str
    secret: str
    connect_timeout_seconds: float = 5.0
    poll_seconds: float = 1.0

    @classmethod
    def from_environment(cls) -> "RemoteFetchSettings | None":
        config = _remote_fetch_config()
        base_url = str(os.getenv("TG_REMOTE_FETCH_BASE_URL") or config.get("base_url") or "").strip().rstrip("/")
        if not base_url:
            return None
        parsed = urllib.parse.urlsplit(base_url)
        allowed_hosts = {"127.0.0.1", "localhost"}
        container_gateway = _container_default_gateway_ipv4()
        if container_gateway:
            allowed_hosts.add(container_gateway)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in allowed_hosts
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise RemoteFetchError(
                "remote fetch endpoint must use the HTTP SSH tunnel on loopback or the current container gateway",
                status_code=500,
                retryable=False,
            )
        key_id = validate_idempotency_key(
            str(os.getenv("TG_REMOTE_FETCH_KEY_ID") or config.get("key_id") or "capture-v1")
        )
        keys_path = Path(
            os.getenv(
                "TG_REMOTE_FETCH_KEYS_FILE",
                str(config.get("keys_file") or "/data/internal/remote-fetch-keys.json"),
            )
        ).resolve()
        try:
            keys = json.loads(keys_path.read_text(encoding="utf-8"))
            secret = str(dict(keys or {}).get(key_id) or "").strip()
        except Exception as exc:
            raise RemoteFetchError(
                "unable to read remote fetch key file",
                status_code=500,
                retryable=False,
            ) from exc
        if len(secret) < 32:
            raise RemoteFetchError(
                "remote fetch key is unavailable",
                status_code=500,
                retryable=False,
            )
        return cls(
            base_url=base_url,
            key_id=key_id,
            secret=secret,
            connect_timeout_seconds=max(
                1.0,
                min(float(os.getenv("TG_REMOTE_FETCH_CONNECT_TIMEOUT_SECONDS") or config.get("connect_timeout_seconds") or 5), 20.0),
            ),
            poll_seconds=max(
                0.25,
                min(float(os.getenv("TG_REMOTE_FETCH_POLL_SECONDS") or config.get("poll_seconds") or 1), 5.0),
            ),
        )


class RemoteFetchClient:
    def __init__(self, settings: RemoteFetchSettings):
        self.settings = settings

    def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        idempotency_key: str = "",
        transient_attempts: int = 2,
    ) -> dict[str, Any]:
        body = canonical_json_bytes(payload) if payload is not None else b""
        clean_path = "/" + str(path or "").lstrip("/")
        attempts = max(1, min(int(transient_attempts), 3))
        last_error: Exception | None = None
        for attempt in range(attempts):
            timestamp = int(time.time())
            nonce = secrets.token_urlsafe(24)
            headers = signed_headers(
                secret=self.settings.secret,
                key_id=self.settings.key_id,
                method=method,
                path=clean_path,
                body=body,
                timestamp=timestamp,
                nonce=nonce,
                idempotency_key=idempotency_key,
            )
            if body:
                headers["content-type"] = "application/json"
            request = urllib.request.Request(
                self.settings.base_url + clean_path,
                data=body if method.upper() not in {"GET", "HEAD"} else None,
                headers=headers,
                method=method.upper(),
            )
            try:
                with urllib.request.urlopen(
                    request,
                    timeout=self.settings.connect_timeout_seconds,
                ) as response:
                    parsed = json.loads(response.read().decode("utf-8"))
                    if not isinstance(parsed, dict):
                        raise RemoteFetchError("remote fetch returned invalid JSON")
                    return parsed
            except urllib.error.HTTPError as exc:
                try:
                    detail = json.loads(exc.read().decode("utf-8")).get("detail")
                except Exception:
                    detail = ""
                retryable = int(exc.code) in {408, 425, 429, 502, 503, 504}
                last_error = RemoteFetchError(
                    str(detail or f"remote fetch HTTP {exc.code}"),
                    status_code=int(exc.code),
                    retryable=retryable,
                )
                if not retryable:
                    raise last_error
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
                last_error = RemoteFetchError(
                    f"remote fetch transport failed: {type(exc).__name__}",
                    status_code=503,
                    retryable=True,
                )
            if attempt + 1 < attempts:
                time.sleep(0.25 * (attempt + 1))
        if isinstance(last_error, Exception):
            raise last_error
        raise RemoteFetchError("remote fetch request failed")

    def execute(
        self,
        *,
        capability: str,
        unit_id: str,
        payload: dict[str, Any],
        idempotency_key: str,
        timeout_seconds: int,
        on_job_created: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        clean_key = validate_idempotency_key(idempotency_key)
        response = self._request(
            "POST",
            "/internal/worker/v1/jobs",
            payload={
                "capability": str(capability or "").strip(),
                "unit_id": validate_idempotency_key(unit_id),
                "payload": dict(payload),
            },
            idempotency_key=clean_key,
        )
        job = response.get("job")
        if not isinstance(job, dict) or not str(job.get("id") or ""):
            raise RemoteFetchError("remote fetch did not return a job id")
        job_id = str(job["id"])
        if on_job_created is not None:
            on_job_created(job_id)
        deadline = time.monotonic() + max(30, min(int(timeout_seconds), 240))
        while time.monotonic() < deadline:
            state = self._request(
                "GET",
                f"/internal/worker/v1/jobs/{urllib.parse.quote(job_id, safe='')}",
            ).get("job")
            if not isinstance(state, dict):
                raise RemoteFetchError("remote fetch returned invalid job state")
            status = str(state.get("status") or "")
            if status == "success":
                result = state.get("result")
                if not isinstance(result, dict):
                    raise RemoteFetchError("remote fetch job returned no result")
                return result
            if status in {"failed", "cancelled"}:
                error = state.get("error") if isinstance(state.get("error"), dict) else {}
                raise RemoteFetchError(
                    str(error.get("detail") or f"remote fetch job {status}"),
                    status_code=503,
                    retryable=bool(error.get("retryable", status == "failed")),
                )
            time.sleep(self.settings.poll_seconds)
        with contextlib.suppress(Exception):
            self.cancel(job_id)
        raise RemoteFetchError("remote fetch job timed out", status_code=504, retryable=True)

    def cancel(self, job_id: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/internal/worker/v1/jobs/{urllib.parse.quote(str(job_id), safe='')}/cancel",
            payload={},
            transient_attempts=1,
        )


def configured_client() -> RemoteFetchClient | None:
    settings = RemoteFetchSettings.from_environment()
    return RemoteFetchClient(settings) if settings is not None else None
