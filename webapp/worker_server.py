from __future__ import annotations

import contextlib
import hashlib
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
from datetime import datetime, timezone
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
    "persona.hot_keywords.v1": "prepare-hot-keywords",
    "persona.hot_post_metrics.v1": "refresh-hot-post",
}
TERMINAL_STATES = {"success", "failed", "cancelled"}
PERSONA_HOT_KEYWORD_STRATEGY_VERSION = 54
_SAFE_JOB_ID = re.compile(r"job_[0-9a-f]{24}")
_PERSONA_ARCHIVE_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def _truthy_environment(name: str) -> bool:
    return str(os.getenv(name, "") or "").strip().lower() in {"1", "true", "yes", "on"}


def _hot_public_probe_enabled() -> bool:
    if _truthy_environment("TG_HOT_PUBLIC_PROBE"):
        return True
    return Path("/data/hot-public-probe").is_file()


_PERSONA_HOT_SNAPSHOT_SETUP_FIELDS = (
    "genres",
    "interests",
    "trendTopics",
    "personaType",
    "personality",
    "personaPersonality",
    "personaStyle",
    "contentTheme",
    "customTopic",
    "tweetStyleProfile",
    "tweetStyleSample",
    "chineseScript",
    "script",
    "locale",
    "targetMarket",
    "market",
    "region",
    "personaDescription",
    "personaName",
)


def _sanitize_persona_hot_archive_snapshot(value: Any, archive_id: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    clean_id = str(archive_id or "").strip()
    if not clean_id or str(value.get("id") or "").strip() != clean_id:
        return None
    raw_setup = value.get("setup") if isinstance(value.get("setup"), dict) else {}
    safe_setup: dict[str, Any] = {}
    for key in _PERSONA_HOT_SNAPSHOT_SETUP_FIELDS:
        item = raw_setup.get(key)
        if item is None or isinstance(item, (str, bool, int, float)):
            if item is not None:
                safe_setup[key] = item
        elif isinstance(item, list) and all(isinstance(part, str) for part in item):
            safe_setup[key] = list(item)
    return {
        "id": clean_id,
        "name": str(value.get("name") or "")[:200],
        "content": str(value.get("content") or "")[:4_000],
        "setup": safe_setup,
        "posts": [],
    }


def _collector_platform(payload: Mapping[str, Any]) -> str:
    explicit = str(payload.get("platform") or "").strip().lower()
    if explicit in {"threads", "instagram"}:
        return explicit
    post_snapshot = payload.get("postSnapshot")
    source_meta = post_snapshot.get("sourceMeta") if isinstance(post_snapshot, Mapping) else None
    nested = str(source_meta.get("platform") or "").strip().lower() if isinstance(source_meta, Mapping) else ""
    return nested if nested in {"threads", "instagram"} else "threads"


def _clean_hot_keywords(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in value:
        keyword = str(item or "").strip()
        if not keyword or keyword in seen:
            continue
        seen.add(keyword)
        cleaned.append(keyword)
        if len(cleaned) >= 32:
            break
    return cleaned


def _hot_keyword_digest(keywords: list[str]) -> str:
    body = json.dumps(keywords, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _has_current_hot_keyword_strategy(payload: Mapping[str, Any]) -> bool:
    keywords = _clean_hot_keywords(payload.get("keywords"))
    return (
        bool(keywords)
        and int(payload.get("keywordStrategyVersion") or 0) == PERSONA_HOT_KEYWORD_STRATEGY_VERSION
        and str(payload.get("keywordDigest") or "").strip().lower() == _hot_keyword_digest(keywords)
    )


def _local_persona_archive_names(runtime_dir: Path) -> dict[str, str]:
    path = Path(runtime_dir) / "persona_archives.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    rows = raw if isinstance(raw, list) else (raw.get("archives") if isinstance(raw, dict) else None)
    if not isinstance(rows, list):
        return {}
    names: dict[str, str] = {}
    for item in rows:
        if not isinstance(item, dict):
            continue
        archive_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if archive_id and name:
            names[archive_id] = name
    return names


def _candidate_identity(value: Mapping[str, Any]) -> str:
    candidate_id = str(value.get("id") or "").strip()
    if candidate_id:
        return f"id:{candidate_id}"
    source_url = str(
        value.get("sourceUrl")
        or value.get("source_url")
        or value.get("url")
        or ""
    ).strip()
    if source_url:
        return f"url:{source_url}"
    content = str(value.get("content") or value.get("text") or "").strip()
    return f"content:{hashlib.sha256(content.encode('utf-8')).hexdigest()}" if content else ""


def _candidate_is_fresh(value: Mapping[str, Any], *, now: int, freshness_days: int) -> bool:
    raw = str(value.get("publishedAt") or value.get("published_at") or "").strip()
    if not raw:
        return True
    try:
        published = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        return published.timestamp() >= now - max(1, freshness_days) * 86400
    except (TypeError, ValueError, OverflowError):
        return False


def _persona_available_candidate_count(runtime_dir: Path, archive_id: str, *, now: int) -> int:
    """Count fresh, useful and not-yet-shown candidates for one persona only."""

    blocked_ids: set[str] = set()
    store_path = runtime_dir / "sentiment_hot_candidates.json"
    try:
        store = json.loads(store_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        store = {}
    if isinstance(store, dict):
        for section in ("shown", "selected", "imported"):
            rows = store.get(section)
            archive_rows = rows.get(archive_id) if isinstance(rows, dict) else None
            if isinstance(archive_rows, list):
                for row in archive_rows:
                    if not isinstance(row, dict):
                        continue
                    for key, prefix in (("id", "id:"), ("urlKey", "url:"), ("contentKey", "content:")):
                        token = str(row.get(key) or "").strip()
                        if token:
                            blocked_ids.add(f"{prefix}{token}")

    freshness_days = max(1, min(int(os.getenv("TG_HOT_POOL_FRESHNESS_DAYS", "30") or 30), 30))
    identities: set[str] = set()
    cache_dir = runtime_dir / "sentiment_threads_search_cache"
    try:
        cache_files = list(cache_dir.iterdir())
    except OSError:
        cache_files = []
    prefix = f"{archive_id}-"
    for cache_file in cache_files:
        if not cache_file.is_file() or not cache_file.name.startswith(prefix) or cache_file.suffix != ".json":
            continue
        try:
            cache = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(cache, dict):
            continue
        for bucket in cache.values():
            candidates = bucket.get("candidates") if isinstance(bucket, dict) else None
            if not isinstance(candidates, list):
                continue
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                content = str(candidate.get("content") or candidate.get("text") or "").strip()
                if len(content) < 60 or not _candidate_is_fresh(candidate, now=now, freshness_days=freshness_days):
                    continue
                identity = _candidate_identity(candidate)
                if identity and identity not in blocked_ids:
                    identities.add(identity)
    return len(identities)


def _global_available_candidate_count(runtime_dir: Path, *, now: int) -> int:
    cutoff_ms = (now - 30 * 86400) * 1000
    database_path = runtime_dir / "sentiment_hot_global_pool.sqlite3"
    try:
        connection = sqlite3.connect(str(database_path))
        try:
            rows = connection.execute(
                "SELECT candidate_json,content_at_ms FROM sentiment_hot_global_candidates WHERE content_at_ms >= ?",
                (cutoff_ms,),
            ).fetchall()
        finally:
            connection.close()
        return sum(
            1
            for raw, _content_at_ms in rows
            if len(str(json.loads(str(raw or "{}")).get("content") or "").strip()) >= 60
        )
    except (OSError, sqlite3.Error, json.JSONDecodeError):
        pass
    try:
        value = json.loads((runtime_dir / "sentiment_hot_global_pool.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    candidates = value.get("candidates") if isinstance(value, dict) else None
    if not isinstance(candidates, list):
        return 0
    return sum(
        1
        for candidate in candidates
        if isinstance(candidate, dict)
        and len(str(candidate.get("content") or "").strip()) >= 60
        and _candidate_is_fresh(candidate, now=now, freshness_days=30)
    )


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
        runtime_dir: Path | None = None,
    ):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.terminal_retention_seconds = max(60, int(terminal_retention_seconds))
        self.minimum_terminal_jobs = max(0, min(int(minimum_terminal_jobs), 10_000))
        self.runtime_dir = Path(
            runtime_dir
            or os.getenv("TOOL_R18_RUNTIME_DIR", "")
            or ROOT_DIR / "tool_r18" / ".runtime" / "automatic-script"
        ).resolve()
        self._dataset_overview_published_at = 0.0
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
                CREATE TABLE IF NOT EXISTS fetch_pool_targets (
                  archive_id TEXT PRIMARY KEY,
                  payload_json TEXT NOT NULL,
                  next_run_at INTEGER NOT NULL,
                  last_run_at INTEGER NOT NULL DEFAULT 0,
                  last_user_fetch_at INTEGER NOT NULL DEFAULT 0,
                  active_until INTEGER NOT NULL DEFAULT 0,
                  low_watermark INTEGER NOT NULL DEFAULT 50,
                  target_watermark INTEGER NOT NULL DEFAULT 100,
                  last_available_count INTEGER NOT NULL DEFAULT 0,
                  updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_fetch_pool_targets_due
                  ON fetch_pool_targets(next_run_at, archive_id);
                CREATE TABLE IF NOT EXISTS hot_dataset_snapshots (
                  dataset_id TEXT PRIMARY KEY,
                  dataset_name TEXT NOT NULL,
                  candidate_count INTEGER NOT NULL,
                  observed_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS hot_dataset_change_events (
                  id TEXT PRIMARY KEY,
                  dataset_id TEXT NOT NULL,
                  dataset_name TEXT NOT NULL,
                  delta INTEGER NOT NULL,
                  count_before INTEGER NOT NULL,
                  count_after INTEGER NOT NULL,
                  reason TEXT NOT NULL,
                  source TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_hot_dataset_change_events_created
                  ON hot_dataset_change_events(created_at DESC, id DESC);
                """
            )
            existing_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(fetch_pool_targets)")
            }
            for name, definition in (
                ("last_user_fetch_at", "INTEGER NOT NULL DEFAULT 0"),
                ("active_until", "INTEGER NOT NULL DEFAULT 0"),
                ("low_watermark", "INTEGER NOT NULL DEFAULT 50"),
                ("target_watermark", "INTEGER NOT NULL DEFAULT 100"),
                ("last_available_count", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if name not in existing_columns:
                    connection.execute(f"ALTER TABLE fetch_pool_targets ADD COLUMN {name} {definition}")
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
            if (
                capability == "persona.hot_candidates.v1"
                and payload.get("userInitiated") is True
                and not payload.get("_poolRefill")
            ):
                archive_id = str(payload.get("archiveId") or "").strip()
                if archive_id:
                    low_watermark = max(1, min(int(os.getenv("TG_HOT_POOL_LOW_WATERMARK", "50") or 50), 1000))
                    target_watermark = max(
                        low_watermark,
                        min(int(os.getenv("TG_HOT_POOL_TARGET_WATERMARK", "100") or 100), 2000),
                    )
                    active_seconds = max(3600, int(os.getenv("TG_HOT_POOL_ACTIVE_SECONDS", "604800") or 604800))
                    initial_delay = max(10, int(os.getenv("TG_HOT_POOL_INITIAL_DELAY_SECONDS", "60") or 60))
                    refill_payload = dict(payload)
                    refill_payload["userInitiated"] = False
                    refill_payload["_poolRefill"] = True
                    refill_payload["recordShown"] = False
                    refill_payload["liveOnly"] = False
                    refill_payload["refresh"] = True
                    connection.execute(
                        """
                        INSERT INTO fetch_pool_targets(
                          archive_id,payload_json,next_run_at,last_run_at,last_user_fetch_at,
                          active_until,low_watermark,target_watermark,last_available_count,updated_at
                        ) VALUES(?,?,?,0,?,?,?,?,0,?)
                        ON CONFLICT(archive_id) DO UPDATE SET
                          payload_json=excluded.payload_json,
                          next_run_at=MIN(fetch_pool_targets.next_run_at,excluded.next_run_at),
                          last_run_at=0,
                          last_user_fetch_at=excluded.last_user_fetch_at,
                          active_until=excluded.active_until,
                          low_watermark=excluded.low_watermark,
                          target_watermark=excluded.target_watermark,
                          updated_at=excluded.updated_at
                        """,
                        (
                            archive_id,
                            json.dumps(refill_payload, ensure_ascii=False, separators=(",", ":")),
                            now + initial_delay,
                            now,
                            now + active_seconds,
                            low_watermark,
                            target_watermark,
                            now,
                        ),
                    )
            row = connection.execute("SELECT * FROM fetch_jobs WHERE id=?", (job_id,)).fetchone()
            return self.public(row), True

    def enqueue_due_pool_refill(self, *, now: int | None = None) -> bool:
        timestamp = int(now or time.time())
        interval = max(300, int(os.getenv("TG_HOT_POOL_REFILL_SECONDS", "600") or 600))
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM fetch_pool_targets WHERE active_until <= ?", (timestamp,))
            target = connection.execute(
                "SELECT * FROM fetch_pool_targets WHERE active_until > ? AND next_run_at <= ? ORDER BY next_run_at,archive_id LIMIT 1",
                (timestamp, timestamp),
            ).fetchone()
            if target is None:
                return False
            archive_id = str(target["archive_id"])
            available_count = _persona_available_candidate_count(self.runtime_dir, archive_id, now=timestamp)
            next_run = timestamp + interval
            connection.execute(
                "UPDATE fetch_pool_targets SET next_run_at=?,last_available_count=?,updated_at=? WHERE archive_id=?",
                (next_run, available_count, timestamp, archive_id),
            )
            low_watermark = max(1, int(target["low_watermark"] or 50))
            target_watermark = max(low_watermark, int(target["target_watermark"] or 100))
            refilling = int(target["last_run_at"] or 0) >= int(target["last_user_fetch_at"] or 0) > 0
            if available_count >= target_watermark:
                connection.execute(
                    "UPDATE fetch_pool_targets SET last_run_at=0,updated_at=? WHERE archive_id=?",
                    (timestamp, archive_id),
                )
                return False
            if not refilling and available_count >= low_watermark:
                return False
            payload = json.loads(str(target["payload_json"] or "{}"))
            if not str(payload.get("archiveId") or "").strip():
                connection.execute("DELETE FROM fetch_pool_targets WHERE archive_id=?", (archive_id,))
                return False
            active_rows = connection.execute(
                "SELECT payload_json FROM fetch_jobs WHERE capability='persona.hot_candidates.v1' AND status IN ('queued','running')"
            ).fetchall()
            active_payloads = [json.loads(str(row["payload_json"] or "{}")) for row in active_rows]
            same_archive_active = any(
                str(item.get("archiveId") or "").strip() == archive_id
                for item in active_payloads
            )
            interactive_active = any(not item.get("_poolRefill") for item in active_payloads)
            if same_archive_active or interactive_active:
                connection.execute(
                    "UPDATE fetch_pool_targets SET next_run_at=?,updated_at=? WHERE archive_id=?",
                    (timestamp + 60, timestamp, archive_id),
                )
                return False
            payload["limit"] = min(20, max(1, target_watermark - available_count))
            connection.execute(
                "UPDATE fetch_pool_targets SET last_run_at=?,updated_at=? WHERE archive_id=?",
                (timestamp, timestamp, archive_id),
            )
            unit_id = f"pool_{hashlib.sha256(archive_id.encode('utf-8')).hexdigest()[:24]}"
            idempotency_key = f"pool:{hashlib.sha256(f'{archive_id}:{timestamp // interval}'.encode('utf-8')).hexdigest()[:24]}"
            job_id = f"job_{uuid.uuid4().hex[:24]}"
            try:
                connection.execute(
                    """
                    INSERT INTO fetch_jobs(
                      id,idempotency_key,request_hash,capability,unit_id,payload_json,
                      status,created_at,updated_at
                    ) VALUES(?,?,?,?,?,?,'queued',?,?)
                    """,
                    (
                        job_id,
                        idempotency_key,
                        request_hash(canonical_json_bytes(payload)),
                        "persona.hot_candidates.v1",
                        unit_id,
                        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                        timestamp,
                        timestamp,
                    ),
                )
            except sqlite3.IntegrityError:
                return False
            return True

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM fetch_jobs WHERE id=?", (job_id,)).fetchone()
            return self.public(row) if row is not None else None

    def claim_next(self) -> tuple[dict[str, Any], dict[str, Any]] | None:
        now = int(time.time())
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            queued = connection.execute(
                """
                SELECT * FROM fetch_jobs
                WHERE status='queued' AND cancel_requested=0
                ORDER BY created_at,id
                """
            ).fetchall()
            row = None
            for candidate in queued:
                payload = json.loads(str(candidate["payload_json"] or "{}"))
                if not payload.get("_poolRefill"):
                    row = candidate
                    break
            if row is None and queued:
                row = queued[0]
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

    def preempt_background_refills(self) -> list[str]:
        """Stop queued/running pool jobs so an interactive button fetch can start."""
        now = int(time.time())
        running_ids: list[str] = []
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT id, payload_json, status FROM fetch_jobs
                WHERE capability='persona.hot_candidates.v1'
                  AND status IN ('queued','running')
                """
            ).fetchall()
            for row in rows:
                payload = json.loads(str(row["payload_json"] or "{}"))
                if not payload.get("_poolRefill"):
                    continue
                job_id = str(row["id"])
                if str(row["status"]) == "queued":
                    connection.execute(
                        """
                        UPDATE fetch_jobs
                        SET cancel_requested=1, status='cancelled', finished_at=?, updated_at=?
                        WHERE id=? AND status='queued'
                        """,
                        (now, now, job_id),
                    )
                else:
                    connection.execute(
                        "UPDATE fetch_jobs SET cancel_requested=1, updated_at=? WHERE id=? AND status='running'",
                        (now, job_id),
                    )
                    running_ids.append(job_id)
        return running_ids

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

    def dataset_overview(self, *, now: int | None = None) -> dict[str, Any]:
        timestamp = int(now or time.time())
        archive_ids: set[str] = set()
        names: dict[str, str] = {}
        targets: dict[str, sqlite3.Row] = {}
        local_names = _local_persona_archive_names(self.runtime_dir)
        for archive_id, name in local_names.items():
            if _PERSONA_ARCHIVE_ID.fullmatch(archive_id):
                archive_ids.add(archive_id)
                names[archive_id] = name
        cache_dir = self.runtime_dir / "sentiment_threads_search_cache"
        with contextlib.suppress(OSError):
            for path in cache_dir.iterdir():
                archive_id = path.name[:36]
                if path.is_file() and _PERSONA_ARCHIVE_ID.fullmatch(archive_id):
                    archive_ids.add(archive_id)
        try:
            shown_store = json.loads((self.runtime_dir / "sentiment_hot_candidates.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            shown_store = {}
        shown = shown_store.get("shown") if isinstance(shown_store, dict) else None
        if isinstance(shown, dict):
            archive_ids.update(key for key in shown if _PERSONA_ARCHIVE_ID.fullmatch(str(key)))
        with self._connection() as connection:
            for row in connection.execute("SELECT * FROM fetch_pool_targets"):
                archive_id = str(row["archive_id"] or "")
                if not _PERSONA_ARCHIVE_ID.fullmatch(archive_id):
                    continue
                archive_ids.add(archive_id)
                targets[archive_id] = row
                with contextlib.suppress(json.JSONDecodeError):
                    payload = json.loads(str(row["payload_json"] or "{}"))
                    snapshot_name = str((payload.get("archiveSnapshot") or {}).get("name") or "").strip()
                    if snapshot_name:
                        names[archive_id] = snapshot_name
            job_rows = connection.execute(
                "SELECT payload_json FROM fetch_jobs WHERE capability='persona.hot_candidates.v1' ORDER BY created_at DESC LIMIT 1000"
            ).fetchall()
        for row in job_rows:
            with contextlib.suppress(json.JSONDecodeError):
                payload = json.loads(str(row["payload_json"] or "{}"))
                archive_id = str(payload.get("archiveId") or "")
                if archive_id in archive_ids and not names.get(archive_id):
                    snapshot_name = str((payload.get("archiveSnapshot") or {}).get("name") or "").strip()
                    if snapshot_name:
                        names[archive_id] = snapshot_name
        personas: list[dict[str, Any]] = []
        for archive_id in archive_ids:
            target = targets.get(archive_id)
            capacity = max(1, int(target["target_watermark"] or 100)) if target is not None else 100
            count = _persona_available_candidate_count(self.runtime_dir, archive_id, now=timestamp)
            last_run_at = int(target["last_run_at"] or 0) if target is not None else 0
            last_user_fetch_at = int(target["last_user_fetch_at"] or 0) if target is not None else 0
            personas.append({
                "archive_id": archive_id,
                "name": names.get(archive_id) or f"人设 {archive_id[:8]}",
                "count": count,
                "capacity": capacity,
                "active": bool(target is not None and int(target["active_until"] or 0) > timestamp),
                "refilling": bool(last_run_at >= last_user_fetch_at > 0 and count < capacity),
            })
        personas.sort(key=lambda item: (str(item["name"]).casefold(), str(item["archive_id"])))
        return {
            "generated_at": timestamp,
            "global": {
                "name": "全局数据集",
                "count": _global_available_candidate_count(self.runtime_dir, now=timestamp),
                "capacity": max(1, int(os.getenv("TG_HOT_GLOBAL_POOL_CAPACITY", "100000") or 100000)),
            },
            "personas": personas,
        }

    @staticmethod
    def _dataset_overview_rows(overview: Mapping[str, Any]) -> list[tuple[str, str, int]]:
        rows: list[tuple[str, str, int]] = []
        global_dataset = overview.get("global")
        if isinstance(global_dataset, Mapping):
            rows.append(("global", str(global_dataset.get("name") or "全局数据集"), max(0, int(global_dataset.get("count") or 0))))
        personas = overview.get("personas")
        if isinstance(personas, list):
            for persona in personas:
                if not isinstance(persona, Mapping):
                    continue
                dataset_id = str(persona.get("archive_id") or "").strip().lower()
                if not _PERSONA_ARCHIVE_ID.fullmatch(dataset_id):
                    continue
                rows.append((dataset_id, str(persona.get("name") or f"人设 {dataset_id[:8]}"), max(0, int(persona.get("count") or 0))))
        return rows

    def _record_dataset_overview_changes(
        self,
        overview: Mapping[str, Any],
        *,
        reason: str,
        source: str,
    ) -> None:
        observed_at = max(1, int(overview.get("generated_at") or time.time()))
        with self._connection() as connection:
            for dataset_id, dataset_name, candidate_count in self._dataset_overview_rows(overview):
                previous = connection.execute(
                    "SELECT candidate_count FROM hot_dataset_snapshots WHERE dataset_id=?",
                    (dataset_id,),
                ).fetchone()
                if previous is not None:
                    count_before = max(0, int(previous["candidate_count"] or 0))
                    delta = candidate_count - count_before
                    if delta:
                        connection.execute(
                            """
                            INSERT INTO hot_dataset_change_events(
                              id,dataset_id,dataset_name,delta,count_before,count_after,reason,source,created_at
                            ) VALUES(?,?,?,?,?,?,?,?,?)
                            """,
                            (
                                uuid.uuid4().hex,
                                dataset_id,
                                dataset_name,
                                delta,
                                count_before,
                                candidate_count,
                                str(reason or "worker_sync")[:40],
                                str(source or "worker")[:40],
                                observed_at,
                            ),
                        )
                connection.execute(
                    """
                    INSERT INTO hot_dataset_snapshots(dataset_id,dataset_name,candidate_count,observed_at)
                    VALUES(?,?,?,?)
                    ON CONFLICT(dataset_id) DO UPDATE SET
                      dataset_name=excluded.dataset_name,
                      candidate_count=excluded.candidate_count,
                      observed_at=excluded.observed_at
                    """,
                    (dataset_id, dataset_name, candidate_count, observed_at),
                )
            connection.execute(
                """
                DELETE FROM hot_dataset_change_events
                WHERE id NOT IN (
                  SELECT id FROM hot_dataset_change_events
                  ORDER BY created_at DESC, id DESC
                  LIMIT 2000
                )
                """
            )

    def list_hot_dataset_events(self, *, limit: int = 200) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit or 200), 500))
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT id,dataset_id,dataset_name,delta,count_before,count_after,reason,source,created_at
                FROM hot_dataset_change_events
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_hot_dataset_event(self, event_id: str) -> bool:
        clean_id = str(event_id or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", clean_id):
            raise ValueError("invalid hot dataset event id")
        with self._connection() as connection:
            cursor = connection.execute("DELETE FROM hot_dataset_change_events WHERE id=?", (clean_id,))
            return bool(cursor.rowcount)

    def publish_dataset_overview(
        self,
        *,
        force: bool = False,
        reason: str = "worker_sync",
        source: str = "worker",
    ) -> None:
        monotonic_now = time.monotonic()
        if not force and monotonic_now - self._dataset_overview_published_at < 30:
            return
        self._dataset_overview_published_at = monotonic_now
        path = Path(os.getenv("TG_HOT_DATASET_OVERVIEW_PATH", "/collector-proxy/hot-dataset-overview.json"))
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            overview = self.dataset_overview()
            self._record_dataset_overview_changes(overview, reason=reason, source=source)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(overview, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            with contextlib.suppress(OSError):
                temporary.unlink()

    def clear_hot_dataset(self, dataset_id: str) -> dict[str, Any]:
        clean_id = str(dataset_id or "").strip()
        if clean_id != "global" and not _PERSONA_ARCHIVE_ID.fullmatch(clean_id):
            raise ValueError("invalid hot dataset id")
        self.publish_dataset_overview(force=True)
        count_before = (
            _global_available_candidate_count(self.runtime_dir, now=int(time.time()))
            if clean_id == "global"
            else _persona_available_candidate_count(self.runtime_dir, clean_id, now=int(time.time()))
        )
        with self._lock:
            if clean_id == "global":
                database_path = self.runtime_dir / "sentiment_hot_global_pool.sqlite3"
                if database_path.exists():
                    connection = sqlite3.connect(str(database_path), timeout=15)
                    try:
                        with contextlib.suppress(sqlite3.OperationalError):
                            connection.execute("DELETE FROM sentiment_hot_global_candidates")
                            connection.commit()
                    finally:
                        connection.close()
                pool_path = self.runtime_dir / "sentiment_hot_global_pool.json"
                pool_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = pool_path.with_name(f".{pool_path.name}.{os.getpid()}.tmp")
                temporary.write_text(
                    json.dumps({"version": 1, "updatedAt": int(time.time() * 1000), "candidates": []}, separators=(",", ":")),
                    encoding="utf-8",
                )
                os.replace(temporary, pool_path)
            else:
                cache_dir = self.runtime_dir / "sentiment_threads_search_cache"
                with contextlib.suppress(OSError):
                    for cache_path in cache_dir.iterdir():
                        if not cache_path.is_file() or not cache_path.name.startswith(f"{clean_id}-") or cache_path.suffix != ".json":
                            continue
                        try:
                            cache = json.loads(cache_path.read_text(encoding="utf-8"))
                        except (OSError, json.JSONDecodeError):
                            continue
                        if not isinstance(cache, dict):
                            continue
                        for bucket in cache.values():
                            if isinstance(bucket, dict) and isinstance(bucket.get("candidates"), list):
                                bucket["candidates"] = []
                        temporary = cache_path.with_name(f".{cache_path.name}.{os.getpid()}.tmp")
                        temporary.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                        os.replace(temporary, cache_path)
        self.publish_dataset_overview(force=True, reason="manual_delete", source="admin")
        return {"dataset_id": clean_id, "deleted_count": count_before, "overview": self.dataset_overview()}


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


def _apply_hot_reader_execution_profile(
    runtime_environment: dict[str, str],
    *,
    background_refill: bool,
) -> None:
    runtime_environment["SENTIMENT_HOT_READER_CONCURRENCY"] = "4" if background_refill else "24"
    runtime_environment["SENTIMENT_HOT_READER_SERIAL_PLATFORMS"] = "1" if background_refill else "0"
    # Interactive public search must finish inside the 30s button budget.
    # Background refill may wait longer for the shared anonymous window.
    runtime_environment["SENTIMENT_HOT_READER_TOTAL_TIMEOUT_MS"] = "55000" if background_refill else "30000"
    runtime_environment["SENTIMENT_HOT_READER_JITTER_MAX_MS"] = "5000" if background_refill else "200"
    runtime_environment["SENTIMENT_HOT_READER_MAX_ATTEMPTS"] = "2" if background_refill else "1"
    # Instagram public pages currently return a login wall and steal Spider
    # slots from concurrent Threads keyword searches. Keep them on refill only.
    runtime_environment["TG_HOT_READER_INCLUDE_INSTAGRAM"] = "1" if background_refill else "0"


def _run_tool_r18_job_once(
    payload: dict[str, Any],
    cancel_event: threading.Event,
    *,
    timeout_seconds: int = 120,
    use_collector_profile: bool = True,
) -> dict[str, Any]:
    runtime_payload = dict(payload)
    capability = str(runtime_payload.pop("_workerCapability", "") or "").strip()
    background_refill = bool(runtime_payload.pop("_poolRefill", False))
    runtime_payload.pop("userInitiated", None)
    if capability in {"persona.hot_candidates.v1", "persona.hot_keywords.v1"}:
        runtime_payload["keywords"] = _clean_hot_keywords(runtime_payload.get("keywords"))
        if capability == "persona.hot_candidates.v1" and not _has_current_hot_keyword_strategy(runtime_payload):
            raise RuntimeError("persona hot keywords must use the current new-host strategy")
    for private_field in (
        "accountId", "account_id", "senderUsername", "sender_username",
        "userId", "user_id", "loginUsername", "login_username",
        "loginPassword", "login_password", "cookies", "password",
        "access_token", "totp", "profileDir", "profile_dir", "proxyId", "proxy_id",
    ):
        runtime_payload.pop(private_field, None)
    collector_pool = _configured_collector_pool()
    if use_collector_profile and _truthy_environment("TG_COLLECTOR_POOL_REQUIRED") and collector_pool is None:
        raise RuntimeError("collector account pool is required but unavailable")
    holder = f"runtime_{uuid.uuid4().hex}"
    lease: dict[str, Any] | None = None
    runtime_environment = os.environ.copy()
    if capability == "persona.hot_candidates.v1":
        _apply_hot_reader_execution_profile(
            runtime_environment,
            background_refill=background_refill,
        )
    if collector_pool is not None and use_collector_profile:
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
    release_error_code = "worker_execution_failed"
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
        deadline = time.monotonic() + max(10, min(int(timeout_seconds), 180))
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
        candidate_rows = parsed.get("candidates") if isinstance(parsed.get("candidates"), list) else []
        requested_limit = max(1, min(int(runtime_payload.get("limit") or 10), 20))
        sparse_collector_result = (
            capability in {"persona.hot_candidates.v1", "crm.threads_live_search.v1"}
            and len(candidate_rows) < min(requested_limit, 3)
        )
        succeeded = not sparse_collector_result
        if sparse_collector_result:
            release_error_code = "collector_sparse_result"
        return parsed
    finally:
        if collector_pool is not None and lease is not None:
            with contextlib.suppress(Exception):
                collector_pool.release(
                    str(lease["lease_id"]),
                    holder=holder,
                    succeeded=succeeded,
                    error_code=release_error_code,
                    success_cooldown_seconds=1800 if background_refill else 2,
                    failure_cooldown_seconds=(600 if background_refill else 2) if release_error_code == "collector_sparse_result" else 30,
                    failure_threshold=100 if release_error_code == "collector_sparse_result" else 3,
                    circuit_seconds=0 if release_error_code == "collector_sparse_result" else 300,
                )


def run_tool_r18_job(
    payload: dict[str, Any],
    cancel_event: threading.Event,
    *,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    capability = str(payload.get("_workerCapability") or "").strip()
    if capability == "persona.hot_keywords.v1":
        return _run_tool_r18_job_once(
            payload,
            cancel_event,
            timeout_seconds=timeout_seconds,
            use_collector_profile=False,
        )
    if capability not in {"persona.hot_candidates.v1", "crm.threads_live_search.v1"}:
        return _run_tool_r18_job_once(payload, cancel_event, timeout_seconds=timeout_seconds)

    # Persona hotspot discovery always uses the public Reader. Authenticated
    # accounts remain reserved for CRM/full-data refresh capabilities.
    if capability == "persona.hot_candidates.v1":
        background_refill = bool(payload.get("_poolRefill"))
        result = _run_tool_r18_job_once(
            {
                **payload,
                "sourcePolicy": "reader_only",
                "refresh": True,
                "recordShown": not background_refill,
            },
            cancel_event,
            timeout_seconds=timeout_seconds,
            use_collector_profile=False,
        )
        warnings = result.setdefault("warnings", [])
        if isinstance(warnings, list):
            warnings.append(
                "Background HTTP-only Spider refill completed without leasing an authenticated account."
                if background_refill
                else "Interactive hot fetch used the public HTTP-only Spider reader without leasing an authenticated account."
            )
        return result

    authenticated_payload = {
        **payload,
        "sourcePolicy": "authenticated_only",
    }
    # Two complete 30-second account windows fit the new-host 65-second RPC
    # budget. Three 20-second windows repeatedly expired while the search UI
    # was still loading and never executed the supplied keyword batch.
    attempt_limit = max(1, min(int(os.getenv("TG_AUTH_ACCOUNT_ATTEMPTS", "2") or 2), 3))
    per_account_timeout = max(15, min(int(os.getenv("TG_AUTH_ACCOUNT_TIMEOUT_SECONDS", "30") or 30), int(timeout_seconds)))
    requested_limit = max(1, min(int(payload.get("limit") or 10), 20))
    sufficient_count = min(requested_limit, 3)
    best_result: dict[str, Any] | None = None
    last_error: Exception | None = None
    for attempt in range(attempt_limit):
        try:
            result = _run_tool_r18_job_once(
                authenticated_payload,
                cancel_event,
                timeout_seconds=per_account_timeout,
                use_collector_profile=True,
            )
            if best_result is None or len(result.get("candidates") or []) > len(best_result.get("candidates") or []):
                best_result = result
            if len(result.get("candidates") or []) >= sufficient_count or cancel_event.is_set():
                return result
        except Exception as exc:
            last_error = exc
            if cancel_event.is_set() or (attempt + 1 >= attempt_limit and best_result is None):
                raise
            if attempt + 1 >= attempt_limit:
                break
    if best_result is not None:
        return best_result
    raise RuntimeError("authenticated account-pool fetch failed") from last_error


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
        self.store.publish_dataset_overview(force=True)
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
            self.store.publish_dataset_overview()
            with contextlib.suppress(Exception):
                self.store.enqueue_due_pool_refill()
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
        if normalized.get("recordShown") is not False:
            raise ProtocolError("remote fetch must set recordShown=false")
        if capability == "persona.hot_candidates.v1" and normalized.get("liveOnly") is not False:
            if not (normalized.get("liveOnly") is True and _hot_public_probe_enabled()):
                raise ProtocolError("persona hot fetch must use the old-host candidate pool")
        if capability == "persona.hot_candidates.v1":
            if normalized.get("_poolRefill"):
                raise ProtocolError("background pool refill cannot be submitted externally")
            normalized["keywords"] = _clean_hot_keywords(normalized.get("keywords"))
            if not _has_current_hot_keyword_strategy(normalized):
                raise ProtocolError("persona hot keywords must use the current new-host strategy")
        if capability == "crm.threads_live_search.v1" and normalized.get("liveOnly") is not True:
            raise ProtocolError("CRM live search must remain live-only")
        normalized.pop("sourcePolicy", None)
    if capability == "crm.threads_live_search.v1":
        archive_snapshot = normalized.get("archiveSnapshot")
        archive_id = str(normalized.get("archiveId") or "").strip()
        if not isinstance(archive_snapshot, dict) or str(archive_snapshot.get("id") or "").strip() != archive_id:
            raise ProtocolError("current persona archive snapshot is required")
    if capability in {
        "persona.hot_candidates.v1",
        "persona.hot_keywords.v1",
    }:
        archive_id = str(normalized.get("archiveId") or "").strip()
        if not archive_id:
            raise ProtocolError("persona archive id is required")
        normalized["archiveId"] = archive_id
        snapshot = _sanitize_persona_hot_archive_snapshot(normalized.get("archiveSnapshot"), archive_id)
        if snapshot is not None:
            normalized["archiveSnapshot"] = snapshot
        elif "archiveSnapshot" in normalized:
            raise ProtocolError("archiveSnapshot does not match archiveId")
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
    store = JobStore(resolved.database_path, runtime_dir=resolved.runtime_dir)
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

    @app.post("/internal/worker/v1/hot-datasets/refresh")
    async def refresh_hot_datasets(request: Request) -> dict[str, Any]:
        body = await request.body()
        await authenticate(request, body)
        store.publish_dataset_overview(force=True, reason="manual_refresh", source="admin")
        return {"ok": True, "overview": store.dataset_overview()}

    @app.get("/internal/worker/v1/hot-datasets/events")
    async def get_hot_dataset_events(request: Request) -> dict[str, Any]:
        body = await request.body()
        await authenticate(request, body)
        return {"ok": True, "events": store.list_hot_dataset_events()}

    @app.delete("/internal/worker/v1/hot-datasets/events/{event_id}")
    async def delete_hot_dataset_event(event_id: str, request: Request) -> dict[str, Any]:
        body = await request.body()
        await authenticate(request, body)
        try:
            deleted = store.delete_hot_dataset_event(event_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not deleted:
            raise HTTPException(status_code=404, detail="hot dataset event not found")
        return {"ok": True, "deleted": True}

    @app.delete("/internal/worker/v1/hot-datasets/{dataset_id}")
    async def delete_hot_dataset(dataset_id: str, request: Request) -> dict[str, Any]:
        body = await request.body()
        await authenticate(request, body)
        try:
            result = store.clear_hot_dataset(dataset_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, **result}

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
        if (
            created
            and capability == "persona.hot_candidates.v1"
            and not payload.get("_poolRefill")
        ):
            for refill_job_id in store.preempt_background_refills():
                runtime.cancel(refill_job_id)
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
