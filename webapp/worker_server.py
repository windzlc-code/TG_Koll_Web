from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import signal
import sqlite3
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .remote_fetch_protocol import (
    IDEMPOTENCY_HEADER,
    ProtocolError,
    canonical_json_bytes,
    request_hash,
    validate_idempotency_key,
    verify_request,
)
from .collector_accounts import CollectorAccountPool, NoCollectorAccountAvailableError
from .collector_db import get_collector_db_path
from .collector_vault import CollectorVault


ROOT_DIR = Path(__file__).resolve().parents[1]
ALLOWED_CAPABILITIES = {
    "crm.threads_live_search.v1": "fetch-hot-candidates",
    "persona.hot_candidates.v1": "fetch-hot-candidates",
    "persona.hot_post_metrics.v1": "refresh-hot-post",
}
TERMINAL_STATES = {"success", "failed", "cancelled"}
_SAFE_JOB_ID = re.compile(r"job_[0-9a-f]{24}")


def _truthy_environment(name: str) -> bool:
    return str(os.getenv(name, "") or "").strip().lower() in {"1", "true", "yes", "on"}


def _collector_platform(payload: Mapping[str, Any]) -> str:
    explicit = str(payload.get("platform") or "").strip().lower()
    if explicit in {"threads", "instagram"}:
        return explicit
    post_snapshot = payload.get("postSnapshot")
    source_meta = post_snapshot.get("sourceMeta") if isinstance(post_snapshot, Mapping) else None
    nested = str(source_meta.get("platform") or "").strip().lower() if isinstance(source_meta, Mapping) else ""
    return nested if nested in {"threads", "instagram"} else "threads"


def _configured_collector_pool() -> CollectorAccountPool | None:
    configured_path = str(os.getenv("COLLECTOR_DB_PATH", "") or "").strip()
    required = _truthy_environment("TG_COLLECTOR_POOL_REQUIRED")
    if not configured_path and not required:
        return None
    vault = CollectorVault()
    return CollectorAccountPool(configured_path or get_collector_db_path(), vault)


@dataclass(frozen=True)
class WorkerSettings:
    keys: Mapping[str, str]
    database_path: Path
    runtime_dir: Path
    maximum_body_bytes: int = 128 * 1024
    signature_skew_seconds: int = 60

    @classmethod
    def from_environment(cls) -> "WorkerSettings":
        keys_path = Path(
            os.getenv(
                "TG_FETCH_WORKER_KEYS_FILE",
                "/data/internal/remote-fetch-keys.json",
            )
        ).resolve()
        try:
            raw_keys = json.loads(keys_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RuntimeError(f"unable to read worker keys file: {keys_path}") from exc
        keys = {
            validate_idempotency_key(str(key)): str(value).strip()
            for key, value in dict(raw_keys or {}).items()
            if str(value or "").strip()
        }
        if not keys or any(len(value) < 32 for value in keys.values()):
            raise RuntimeError("worker keys file must contain at least one 32-character secret")
        return cls(
            keys=keys,
            database_path=Path(
                os.getenv(
                    "TG_FETCH_WORKER_DB",
                    "/data/remote_fetch_worker/jobs.db",
                )
            ).resolve(),
            runtime_dir=Path(
                os.getenv(
                    "TOOL_R18_RUNTIME_DIR",
                    str(ROOT_DIR / "tool_r18" / ".runtime" / "automatic-script"),
                )
            ).resolve(),
        )


class JobStore:
    def __init__(
        self,
        path: Path,
        *,
        terminal_retention_seconds: int = 72 * 60 * 60,
        minimum_terminal_jobs: int = 200,
    ):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.terminal_retention_seconds = max(60, int(terminal_retention_seconds))
        self.minimum_terminal_jobs = max(0, min(int(minimum_terminal_jobs), 10_000))
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.path), timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=15000")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS fetch_jobs (
                  id TEXT PRIMARY KEY,
                  idempotency_key TEXT NOT NULL UNIQUE,
                  request_hash TEXT NOT NULL,
                  capability TEXT NOT NULL,
                  unit_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  status TEXT NOT NULL,
                  attempt INTEGER NOT NULL DEFAULT 0,
                  result_json TEXT NOT NULL DEFAULT '',
                  error_json TEXT NOT NULL DEFAULT '',
                  cancel_requested INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  started_at INTEGER NOT NULL DEFAULT 0,
                  finished_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_fetch_jobs_queue
                  ON fetch_jobs(status, created_at, id);
                CREATE TABLE IF NOT EXISTS fetch_nonces (
                  key_id TEXT NOT NULL,
                  nonce TEXT NOT NULL,
                  expires_at INTEGER NOT NULL,
                  PRIMARY KEY(key_id, nonce)
                );
                CREATE INDEX IF NOT EXISTS idx_fetch_nonces_expiry
                  ON fetch_nonces(expires_at);
                """
            )
            connection.execute(
                """
                UPDATE fetch_jobs
                SET status='queued', started_at=0, updated_at=?
                WHERE status='running'
                """,
                (int(time.time()),),
            )
            self._prune(connection, now=int(time.time()))

    def _prune(self, connection: sqlite3.Connection, *, now: int) -> None:
        cutoff = int(now) - self.terminal_retention_seconds
        connection.execute("DELETE FROM fetch_nonces WHERE expires_at < ?", (int(now),))
        connection.execute(
            """
            DELETE FROM fetch_jobs
            WHERE status IN ('success','failed','cancelled')
              AND finished_at > 0
              AND finished_at < ?
              AND id NOT IN (
                SELECT id
                FROM fetch_jobs
                WHERE status IN ('success','failed','cancelled')
                ORDER BY finished_at DESC, updated_at DESC, id DESC
                LIMIT ?
              )
            """,
            (cutoff, self.minimum_terminal_jobs),
        )

    def prune(self, *, now: int | None = None) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._prune(connection, now=int(now or time.time()))

    def use_nonce(self, key_id: str, nonce: str, *, now: int, ttl_seconds: int) -> None:
        expires_at = int(now) + max(60, min(int(ttl_seconds), 600))
        with self._connection() as connection:
            connection.execute("DELETE FROM fetch_nonces WHERE expires_at < ?", (int(now),))
            try:
                connection.execute(
                    "INSERT INTO fetch_nonces(key_id,nonce,expires_at) VALUES(?,?,?)",
                    (str(key_id), str(nonce), expires_at),
                )
            except sqlite3.IntegrityError as exc:
                raise ProtocolError("worker nonce replayed") from exc

    @staticmethod
    def public(row: sqlite3.Row | Mapping[str, Any]) -> dict[str, Any]:
        value = dict(row)
        result = json.loads(value.get("result_json") or "null")
        error = json.loads(value.get("error_json") or "null")
        return {
            "id": str(value.get("id") or ""),
            "idempotency_key": str(value.get("idempotency_key") or ""),
            "capability": str(value.get("capability") or ""),
            "unit_id": str(value.get("unit_id") or ""),
            "status": str(value.get("status") or ""),
            "attempt": int(value.get("attempt") or 0),
            "result": result if isinstance(result, dict) else None,
            "error": error if isinstance(error, dict) else None,
            "created_at": int(value.get("created_at") or 0),
            "updated_at": int(value.get("updated_at") or 0),
            "started_at": int(value.get("started_at") or 0),
            "finished_at": int(value.get("finished_at") or 0),
        }

    def submit(
        self,
        *,
        idempotency_key: str,
        request_digest: str,
        capability: str,
        unit_id: str,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        now = int(time.time())
        clean_key = validate_idempotency_key(idempotency_key)
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._prune(connection, now=now)
            existing = connection.execute(
                "SELECT * FROM fetch_jobs WHERE idempotency_key=?",
                (clean_key,),
            ).fetchone()
            if existing is not None:
                if str(existing["request_hash"]) != request_digest:
                    raise ProtocolError("idempotency key conflicts with another payload")
                return self.public(existing), False
            job_id = f"job_{uuid.uuid4().hex[:24]}"
            connection.execute(
                """
                INSERT INTO fetch_jobs(
                  id,idempotency_key,request_hash,capability,unit_id,payload_json,
                  status,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,'queued',?,?)
                """,
                (
                    job_id,
                    clean_key,
                    request_digest,
                    capability,
                    unit_id,
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                ),
            )
            row = connection.execute("SELECT * FROM fetch_jobs WHERE id=?", (job_id,)).fetchone()
            return self.public(row), True

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM fetch_jobs WHERE id=?", (job_id,)).fetchone()
            return self.public(row) if row is not None else None

    def claim_next(self) -> tuple[dict[str, Any], dict[str, Any]] | None:
        now = int(time.time())
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM fetch_jobs
                WHERE status='queued' AND cancel_requested=0
                ORDER BY created_at,id LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            updated = connection.execute(
                """
                UPDATE fetch_jobs
                SET status='running',attempt=attempt+1,started_at=?,updated_at=?
                WHERE id=? AND status='queued'
                """,
                (now, now, str(row["id"])),
            ).rowcount
            if not updated:
                return None
            claimed = connection.execute(
                "SELECT * FROM fetch_jobs WHERE id=?", (str(row["id"]),)
            ).fetchone()
            payload = json.loads(str(claimed["payload_json"] or "{}"))
            return self.public(claimed), payload

    def finish(
        self,
        job_id: str,
        *,
        status: str,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        if status not in TERMINAL_STATES:
            raise ValueError("invalid terminal job status")
        now = int(time.time())
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE fetch_jobs
                SET status=?,result_json=?,error_json=?,finished_at=?,updated_at=?
                WHERE id=? AND status='running'
                """,
                (
                    status,
                    json.dumps(result or {}, ensure_ascii=False, separators=(",", ":"))
                    if result is not None
                    else "",
                    json.dumps(error or {}, ensure_ascii=False, separators=(",", ":"))
                    if error is not None
                    else "",
                    now,
                    now,
                    job_id,
                ),
            )

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        now = int(time.time())
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE fetch_jobs
                SET cancel_requested=1,
                    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
                    finished_at=CASE WHEN status='queued' THEN ? ELSE finished_at END,
                    updated_at=?
                WHERE id=? AND status IN ('queued','running')
                """,
                (now, now, job_id),
            )
            row = connection.execute("SELECT * FROM fetch_jobs WHERE id=?", (job_id,)).fetchone()
            return self.public(row) if row is not None else None

    def retry(self, job_id: str, *, idempotency_key: str) -> tuple[dict[str, Any], bool]:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM fetch_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(job_id)
            if str(row["status"]) not in {"failed", "cancelled"}:
                raise ProtocolError("only failed or cancelled units can be retried")
            payload = json.loads(str(row["payload_json"] or "{}"))
            return self.submit(
                idempotency_key=idempotency_key,
                request_digest=str(row["request_hash"]),
                capability=str(row["capability"]),
                unit_id=str(row["unit_id"]),
                payload=payload,
            )


def _parse_json_output(stdout: str) -> dict[str, Any] | None:
    text = str(stdout or "").strip()
    if not text:
        return None
    with contextlib.suppress(Exception):
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    lines = text.splitlines()
    for start in range(len(lines) - 1, -1, -1):
        candidate = "\n".join(lines[start:]).strip()
        if not candidate.startswith("{"):
            continue
        with contextlib.suppress(Exception):
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
    return None


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        with contextlib.suppress(Exception):
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                timeout=5,
                check=False,
            )
    else:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
    with contextlib.suppress(Exception):
        process.wait(timeout=2)
    if process.poll() is None:
        with contextlib.suppress(Exception):
            process.kill()


def run_tool_r18_job(
    payload: dict[str, Any],
    cancel_event: threading.Event,
    *,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    runtime_payload = dict(payload)
    capability = str(runtime_payload.pop("_workerCapability", "") or "").strip()
    for private_field in (
        "accountId", "account_id", "senderUsername", "sender_username",
        "userId", "user_id", "loginUsername", "login_username",
        "loginPassword", "login_password", "cookies", "password",
        "access_token", "totp", "profileDir", "profile_dir", "proxyId", "proxy_id",
    ):
        runtime_payload.pop(private_field, None)
    collector_pool = _configured_collector_pool()
    if _truthy_environment("TG_COLLECTOR_POOL_REQUIRED") and collector_pool is None:
        raise RuntimeError("collector account pool is required but unavailable")
    holder = f"runtime_{uuid.uuid4().hex}"
    lease: dict[str, Any] | None = None
    runtime_environment = os.environ.copy()
    if collector_pool is not None:
        if not capability:
            raise RuntimeError("collector capability is missing")
        try:
            lease = collector_pool.acquire(
                capability=capability,
                platform=_collector_platform(runtime_payload),
                holder=holder,
                lease_seconds=max(60, min(int(timeout_seconds) + 30, 3600)),
            )
        except NoCollectorAccountAvailableError as exc:
            raise RuntimeError("no healthy collector account is currently available") from exc

        def apply_profile(runtime_profile: dict[str, str]) -> None:
            profile_dir = str(runtime_profile["profile_dir"])
            platform = str(runtime_profile["platform"])
            if platform == "instagram":
                runtime_environment["PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR"] = profile_dir
                runtime_environment["INSTAGRAM_AUTH_PROFILE_DIR"] = profile_dir
            else:
                runtime_environment["PERSONA_DASHBOARD_THREADS_PROFILE_DIR"] = profile_dir
                runtime_environment["THREADS_AUTH_PROFILE_DIR"] = profile_dir
            runtime_environment["TG_COLLECTOR_PROFILE_REQUIRED"] = "1"

        try:
            collector_pool.use_runtime_profile(
                str(lease["lease_id"]),
                holder=holder,
                consumer=apply_profile,
            )
        except Exception:
            with contextlib.suppress(Exception):
                collector_pool.release(
                    str(lease["lease_id"]),
                    holder=holder,
                    succeeded=False,
                    error_code="collector_profile_unavailable",
                )
            raise

    command = [
        "node",
        "--import",
        "tsx",
        "scripts/skills/persona-hot-workflow.ts",
        json.dumps(runtime_payload, ensure_ascii=True),
    ]
    succeeded = False
    try:
        process = subprocess.Popen(
            command,
            cwd=str(ROOT_DIR / "tool_r18"),
            env=runtime_environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        deadline = time.monotonic() + max(30, min(int(timeout_seconds), 180))
        while process.poll() is None:
            if cancel_event.wait(0.2):
                _terminate_process(process)
                raise RuntimeError("worker job cancelled")
            if time.monotonic() >= deadline:
                _terminate_process(process)
                raise TimeoutError("worker job timed out")
        stdout, stderr = process.communicate()
        parsed = _parse_json_output(stdout)
        if process.returncode != 0:
            detail = str((parsed or {}).get("error") or stderr or stdout or "worker failed").strip()
            raise RuntimeError(detail[:1000])
        if not isinstance(parsed, dict):
            raise RuntimeError("worker returned invalid JSON")
        if parsed.get("ok") is False:
            raise RuntimeError(str(parsed.get("error") or "worker failed")[:1000])
        succeeded = True
        return parsed
    finally:
        if collector_pool is not None and lease is not None:
            with contextlib.suppress(Exception):
                collector_pool.release(
                    str(lease["lease_id"]),
                    holder=holder,
                    succeeded=succeeded,
                    error_code="worker_execution_failed",
                    success_cooldown_seconds=2,
                    failure_cooldown_seconds=30,
                    failure_threshold=3,
                    circuit_seconds=300,
                )


class WorkerRuntime:
    def __init__(
        self,
        store: JobStore,
        runner: Callable[[dict[str, Any], threading.Event], dict[str, Any]],
    ):
        self.store = store
        self.runner = runner
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.thread: threading.Thread | None = None
        self._active_lock = threading.Lock()
        self._active_job_id = ""
        self._active_cancel_event: threading.Event | None = None

    def start(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(
            target=self._loop,
            name="tg-fetch-worker",
            daemon=True,
        )
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        with self._active_lock:
            if self._active_cancel_event is not None:
                self._active_cancel_event.set()
        if self.thread is not None:
            self.thread.join(timeout=8)

    def wake(self) -> None:
        self.wake_event.set()

    def cancel(self, job_id: str) -> None:
        with self._active_lock:
            if self._active_job_id == job_id and self._active_cancel_event is not None:
                self._active_cancel_event.set()
        self.wake()

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            claimed = self.store.claim_next()
            if claimed is None:
                self.wake_event.wait(1.0)
                self.wake_event.clear()
                continue
            job, payload = claimed
            job_id = str(job["id"])
            cancel_event = threading.Event()
            with self._active_lock:
                self._active_job_id = job_id
                self._active_cancel_event = cancel_event
            try:
                result = self.runner(payload, cancel_event)
                if cancel_event.is_set():
                    self.store.finish(job_id, status="cancelled", error={"code": "cancelled"})
                else:
                    self.store.finish(job_id, status="success", result=result)
            except Exception as exc:
                status = "cancelled" if cancel_event.is_set() else "failed"
                self.store.finish(
                    job_id,
                    status=status,
                    error={
                        "code": "cancelled" if status == "cancelled" else "worker_execution_failed",
                        "detail": str(exc or "worker execution failed")[:1000],
                        "retryable": status == "failed",
                    },
                )
            finally:
                with self._active_lock:
                    self._active_job_id = ""
                    self._active_cancel_event = None


def _validate_envelope(value: Any) -> tuple[str, str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise ProtocolError("worker job envelope must be an object")
    capability = str(value.get("capability") or "").strip()
    action = ALLOWED_CAPABILITIES.get(capability)
    if not action:
        raise ProtocolError("worker capability is not allowed")
    unit_id = validate_idempotency_key(str(value.get("unit_id") or ""))
    payload = value.get("payload")
    if not isinstance(payload, dict):
        raise ProtocolError("worker payload must be an object")
    normalized = dict(payload)
    supplied_action = str(normalized.get("action") or "").strip()
    if supplied_action and supplied_action != action:
        raise ProtocolError("worker action does not match capability")
    normalized["action"] = action
    if action == "fetch-hot-candidates":
        if normalized.get("liveOnly") is not True or normalized.get("recordShown") is not False:
            raise ProtocolError("live fetch must set liveOnly=true and recordShown=false")
    if capability in {
        "crm.threads_live_search.v1",
        "persona.hot_candidates.v1",
    }:
        archive_snapshot = normalized.get("archiveSnapshot")
        archive_id = str(normalized.get("archiveId") or "").strip()
        if not isinstance(archive_snapshot, dict) or str(archive_snapshot.get("id") or "").strip() != archive_id:
            raise ProtocolError("current persona archive snapshot is required")
    if capability == "persona.hot_post_metrics.v1":
        post_snapshot = normalized.get("postSnapshot")
        post_id = str(normalized.get("postId") or "").strip()
        if normalized.get("outputOnly") is not True:
            raise ProtocolError("post metric refresh must be output-only")
        if not isinstance(post_snapshot, dict) or str(post_snapshot.get("id") or "").strip() != post_id:
            raise ProtocolError("current persona post snapshot is required")
    for private_field in (
        "accountId",
        "account_id",
        "senderUsername",
        "sender_username",
        "userId",
        "user_id",
        "loginUsername",
        "login_username",
        "loginPassword",
        "login_password",
        "cookies",
        "password",
        "access_token",
        "totp",
        "profileDir",
        "profile_dir",
        "proxyId",
        "proxy_id",
    ):
        normalized.pop(private_field, None)
    normalized["_workerCapability"] = capability
    return capability, unit_id, normalized


def create_worker_app(
    settings: WorkerSettings | None = None,
    *,
    runner: Callable[[dict[str, Any], threading.Event], dict[str, Any]] = run_tool_r18_job,
) -> FastAPI:
    resolved = settings or WorkerSettings.from_environment()
    store = JobStore(resolved.database_path)
    runtime = WorkerRuntime(store, runner)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        runtime.start()
        try:
            yield
        finally:
            runtime.stop()

    app = FastAPI(
        title="TG Koll Fetch Worker",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.store = store
    app.state.runtime = runtime

    async def authenticate(request: Request, body: bytes) -> None:
        if len(body) > resolved.maximum_body_bytes:
            raise HTTPException(status_code=413, detail="worker request body too large")
        try:
            key_id, nonce, timestamp = verify_request(
                secrets_by_key_id=resolved.keys,
                method=request.method,
                path=request.url.path,
                body=body,
                headers=request.headers,
                maximum_skew_seconds=resolved.signature_skew_seconds,
            )
            store.use_nonce(
                key_id,
                nonce,
                now=int(time.time()),
                ttl_seconds=max(120, resolved.signature_skew_seconds * 2),
            )
        except ProtocolError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "tg-koll-fetch-worker", "version": 1}

    @app.get("/internal/worker/v1/health")
    def internal_health() -> dict[str, Any]:
        return health()

    @app.get("/internal/worker/v1/capabilities")
    async def capabilities(request: Request) -> dict[str, Any]:
        await authenticate(request, b"")
        return {
            "ok": True,
            "capabilities": sorted(ALLOWED_CAPABILITIES),
            "concurrency": 1,
        }

    @app.post("/internal/worker/v1/jobs", status_code=202)
    async def submit_job(request: Request) -> JSONResponse:
        body = await request.body()
        await authenticate(request, body)
        try:
            envelope = json.loads(body.decode("utf-8"))
            capability, unit_id, payload = _validate_envelope(envelope)
            idempotency_key = validate_idempotency_key(
                request.headers.get(IDEMPOTENCY_HEADER, "")
            )
            job, created = store.submit(
                idempotency_key=idempotency_key,
                request_digest=request_hash(canonical_json_bytes(envelope)),
                capability=capability,
                unit_id=unit_id,
                payload=payload,
            )
        except (ProtocolError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            status = 409 if "conflicts" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        runtime.wake()
        return JSONResponse(
            status_code=202,
            content={"ok": True, "created": created, "job": job},
        )

    @app.get("/internal/worker/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request) -> dict[str, Any]:
        await authenticate(request, b"")
        if not _SAFE_JOB_ID.fullmatch(job_id):
            raise HTTPException(status_code=404, detail="worker job not found")
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="worker job not found")
        return {"ok": True, "job": job}

    @app.post("/internal/worker/v1/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str, request: Request) -> dict[str, Any]:
        body = await request.body()
        await authenticate(request, body)
        job = store.cancel(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="worker job not found")
        runtime.cancel(job_id)
        return {"ok": True, "job": job}

    @app.post("/internal/worker/v1/jobs/{job_id}/retry", status_code=202)
    async def retry_job(job_id: str, request: Request) -> JSONResponse:
        body = await request.body()
        await authenticate(request, body)
        try:
            idempotency_key = validate_idempotency_key(
                request.headers.get(IDEMPOTENCY_HEADER, "")
            )
            job, created = store.retry(job_id, idempotency_key=idempotency_key)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="worker job not found") from exc
        except ProtocolError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        runtime.wake()
        return JSONResponse(
            status_code=202,
            content={"ok": True, "created": created, "job": job},
        )

    return app


app = create_worker_app() if os.getenv("TG_FETCH_WORKER_AUTOCREATE", "0") == "1" else FastAPI()
