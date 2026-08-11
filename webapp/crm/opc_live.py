from __future__ import annotations

"""Native CRM adapters for OPC history and the existing TG live-search lane.

This module deliberately does not start a service or a Node process.  The live
search executor is injected by the FastAPI integration layer so CRM can share
TG's existing browser lease, authenticated persona search and cancellation
machinery.  A live result is accepted only when that executor explicitly
attests that cache/history fallbacks were disabled.
"""

import hashlib
import inspect
import sqlite3
import time
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote_plus, urlparse

from .errors import CRMError
from .legacy_operations import (
    HOTSPOT_SCHEMA,
    MAX_HOTSPOT_RESULTS,
    MAX_OPC_IMPORT_RESULTS,
    OPC_QUERY_SCHEMA,
    TenantContext,
    query_opc_history,
    search_hotspots,
)


THREADS_SEARCH_SCHEMA = "crm.threads-live-search.v1"
LIVE_SOURCE_KIND = "live_platform"
HISTORY_SOURCE_KIND = "tenant_database_history"

LiveSearchExecutor = Callable[[dict[str, Any]], Mapping[str, Any]]


def _clean(value: Any, maximum: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:maximum]


def _integer(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    return max(minimum, min(maximum, parsed))


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _threads_url(value: Any) -> str:
    url = _clean(value, 1_200)
    parsed = urlparse(url)
    if parsed.scheme.lower() != "https":
        return ""
    if str(parsed.hostname or "").lower() not in {
        "threads.net",
        "www.threads.net",
        "threads.com",
        "www.threads.com",
    }:
        return ""
    return url


def _metric(row: Mapping[str, Any], *names: str) -> int:
    sources = [row]
    for key in ("engagement", "metrics"):
        value = row.get(key)
        if isinstance(value, Mapping):
            sources.append(value)
    for source in sources:
        for name in names:
            if name not in source:
                continue
            try:
                return max(0, int(float(source.get(name) or 0)))
            except (TypeError, ValueError):
                continue
    return 0


def _tenant_threads_account(
    conn: sqlite3.Connection,
    tenant: TenantContext,
    requested_account_id: Any,
) -> dict[str, Any]:
    account_id = _clean(requested_account_id, 160)
    if account_id:
        row = conn.execute(
            "SELECT * FROM social_accounts WHERE id=? AND user_id=? AND lower(platform)='threads'",
            (account_id, tenant.user_id),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT * FROM social_accounts
            WHERE user_id=? AND lower(platform)='threads'
            ORDER BY
              CASE lower(status) WHEN 'ready' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
              updated_at DESC,id ASC
            LIMIT 1
            """,
            (tenant.user_id,),
        ).fetchone()
    if row is None:
        raise CRMError(
            "crm_threads_account_required",
            "crm.errors.threadsAccountRequired",
            status_code=409,
        )
    account = dict(row)
    status = _clean(account.get("status"), 40).lower()
    health = _clean(account.get("health_status"), 40).lower()
    if status == "disabled" or health == "banned":
        raise CRMError(
            "crm_account_unavailable",
            "crm.errors.accountUnavailable",
            status_code=409,
            details={"account_id": str(account["id"]), "status": status, "health_status": health},
        )
    if status in {"pending_login", "needs_login", "cookie_expired", "need_verification"} or health in {
        "needs_login",
        "cookie_expired",
        "need_verification",
    }:
        raise CRMError(
            "crm_account_needs_login",
            "crm.errors.accountNeedsLogin",
            status_code=409,
            details={"account_id": str(account["id"])},
        )
    if not _clean(account.get("persona_id"), 160):
        raise CRMError(
            "crm_account_persona_required",
            "crm.errors.accountPersonaRequired",
            status_code=409,
            details={"account_id": str(account["id"])},
        )
    return account


def _normalize_live_row(row: Mapping[str, Any], *, query: str) -> dict[str, Any] | None:
    source_url = _threads_url(
        row.get("sourceUrl")
        or row.get("source_url")
        or row.get("permalink")
        or row.get("url")
    )
    if not source_url:
        return None
    username = _clean(
        row.get("username") or row.get("author") or row.get("handle"),
        120,
    ).lstrip("@")
    text = _clean(row.get("text") or row.get("content") or row.get("full_content"), 3_000)
    likes = _metric(row, "likeCount", "like_count", "likes", "like")
    replies = _metric(row, "replyCount", "reply_count", "replies", "comments", "commentCount")
    reposts = _metric(row, "repostCount", "repost_count", "reposts", "shares", "shareCount")
    row_id = _clean(row.get("id") or row.get("candidate_id"), 160)
    if not row_id:
        row_id = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:24]
    captured_at = _clean(row.get("capturedAt") or row.get("captured_at"), 40) or _iso_now()
    published_at = _clean(row.get("publishedAt") or row.get("published_at"), 40)
    return {
        "id": row_id,
        "username": username,
        "text": text,
        "permalink": source_url,
        "sourceUrl": source_url,
        "profileUrl": f"https://www.threads.com/@{username}" if username else "",
        "keyword": query,
        "likeCount": likes,
        "replyCount": replies,
        "repostCount": reposts,
        "engagement": likes + replies * 2 + reposts * 3,
        "platform": "threads",
        "publishedAt": published_at,
        "collectedAt": captured_at,
        "live": True,
        "sourceKind": LIVE_SOURCE_KIND,
    }


def _executor_rows(raw: Mapping[str, Any]) -> tuple[list[Any], str]:
    candidates = raw.get("candidates")
    if isinstance(candidates, (list, tuple)):
        return list(candidates), "tg_sentiment_hot"
    data = raw.get("data")
    if isinstance(data, (list, tuple)):
        return list(data), _clean(raw.get("provider") or "tg_threads_browser", 80)
    return [], ""


def _row_declares_nonlive_source(row: Mapping[str, Any]) -> bool:
    if row.get("fallback") is True or row.get("historyFallback") is True or row.get("simulated") is True:
        return True
    candidates: list[Any] = [row.get("sourceKind"), row.get("source_kind"), row.get("source")]
    metrics = row.get("metrics")
    if isinstance(metrics, Mapping):
        candidates.extend((metrics.get("sourceKind"), metrics.get("source_kind"), metrics.get("source")))
    for value in candidates:
        if isinstance(value, Mapping):
            value = value.get("kind") or value.get("type")
        marker = _clean(value, 80).lower().replace("-", "_")
        if marker in {"cache", "history", "fixture", "mock", "simulated", "history_fallback", "cache_fallback"}:
            return True
    return False


def _assert_live_result(raw: Mapping[str, Any]) -> str:
    if raw.get("ok") is False:
        raise CRMError(
            "crm_threads_search_unavailable",
            "crm.errors.threadsSearchUnavailable",
            status_code=503,
            retryable=True,
            details={"reason": _clean(raw.get("error") or "executor_failed", 300)},
        )
    fallback = raw.get("fallback") is True or raw.get("historyFallback") is True
    source_kind = _clean(raw.get("sourceKind") or raw.get("source_kind"), 80).lower()
    forbidden_source = source_kind in {"cache", "history", "fixture", "mock", "simulated"}
    # TG's sentiment-hot executor guarantees this when invoked with
    # recordShown=false and liveOnly=true.  A Python browser executor may use
    # the generic live/sourceKind attestation instead.
    attested = raw.get("liveOnly") is True or (
        raw.get("live") is True and source_kind == LIVE_SOURCE_KIND
    )
    if not attested or fallback or forbidden_source:
        raise CRMError(
            "crm_threads_live_evidence_required",
            "crm.errors.threadsLiveEvidenceRequired",
            status_code=503,
            retryable=True,
            details={"reason": "executor_did_not_attest_live_only"},
        )
    return "tg_sentiment_hot" if raw.get("liveOnly") is True else _clean(raw.get("provider"), 80) or "tg_threads_browser"


def search_threads_live(
    conn: sqlite3.Connection,
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    executor: LiveSearchExecutor | None,
) -> dict[str, Any]:
    """Run a tenant-scoped Threads query through TG's existing live executor.

    The function never returns cached OPC history as a live result.  An empty
    attested live search is returned as an empty list rather than fabricated or
    history-backed posts.
    """

    query = _clean(payload.get("query") or payload.get("search"), 300)
    if len(query) < 2:
        raise CRMError("crm_invalid_hotspot_query", "crm.errors.invalidHotspotQuery", status_code=400)
    if executor is None:
        raise CRMError(
            "crm_threads_search_blocked",
            "crm.errors.threadsSearchBlocked",
            status_code=409,
            details={"reason": "live_executor_unconfigured"},
        )
    account = _tenant_threads_account(
        conn,
        tenant,
        payload.get("accountId") or payload.get("account_id"),
    )
    limit = _integer(payload.get("limit"), default=30, minimum=3, maximum=MAX_HOTSPOT_RESULTS)
    scroll_rounds = _integer(
        payload.get("scrollRounds") or payload.get("scroll_rounds"),
        default=max(4, (limit + 7) // 8),
        minimum=1,
        maximum=30,
    )
    delay_ms = _integer(
        payload.get("delayMs") or payload.get("delay_ms"),
        default=650,
        minimum=500,
        maximum=2_000,
    )
    request = {
        "action": "fetch-hot-candidates",
        "operation": "crm_threads_live_search",
        "schemaVersion": THREADS_SEARCH_SCHEMA,
        "archiveId": _clean(account.get("persona_id"), 160),
        "accountId": str(account["id"]),
        "senderUsername": _clean(account.get("username"), 120).lstrip("@"),
        "query": query,
        "prompt": query,
        "keywords": [query],
        "platform": "threads",
        "limit": limit,
        "scrollRounds": scroll_rounds,
        "delayMs": delay_ms,
        "browserMode": "persistent",
        "searchMode": "normal" if payload.get("searchMode") == "normal" else "strict",
        "freshnessDays": _integer(payload.get("freshnessDays"), default=7, minimum=1, maximum=30),
        "freshnessPolicy": "strict",
        "refresh": True,
        "recordShown": False,
        "liveOnly": True,
        "requestId": tenant.request_id,
    }
    try:
        raw = executor(dict(request))
        if inspect.isawaitable(raw):
            raise TypeError("async_executor_not_supported")
        if not isinstance(raw, Mapping):
            raise TypeError("executor_result_not_mapping")
        provider = _assert_live_result(raw)
    except CRMError:
        raise
    except Exception as exc:
        raise CRMError(
            "crm_threads_search_unavailable",
            "crm.errors.threadsSearchUnavailable",
            status_code=503,
            retryable=True,
            details={"reason": type(exc).__name__},
        ) from exc

    raw_rows, detected_provider = _executor_rows(raw)
    provider = detected_provider or provider
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for item in raw_rows:
        if not isinstance(item, Mapping):
            continue
        if _row_declares_nonlive_source(item):
            raise CRMError(
                "crm_threads_live_evidence_required",
                "crm.errors.threadsLiveEvidenceRequired",
                status_code=503,
                retryable=True,
                details={"reason": "row_declared_nonlive_source"},
            )
        item_platform = _clean(item.get("platform") or "threads", 20).lower()
        if item_platform != "threads":
            continue
        normalized = _normalize_live_row(item, query=query)
        if normalized is None or normalized["sourceUrl"] in seen:
            continue
        seen.add(normalized["sourceUrl"])
        rows.append(normalized)
        if len(rows) >= limit:
            break

    warnings = raw.get("warnings") if isinstance(raw.get("warnings"), (list, tuple)) else []
    warning_items = [_clean(item, 300) for item in warnings if _clean(item, 300)]
    single_warning = _clean(raw.get("warning"), 300)
    if single_warning and single_warning not in warning_items:
        warning_items.append(single_warning)
    executor_max_results = 20 if provider == "tg_sentiment_hot" else limit
    if provider == "tg_sentiment_hot" and limit > executor_max_results:
        capacity_warning = (
            "TG live search currently returns at most 20 results per execution; "
            "no cache or OPC history rows were added to fill the requested limit."
        )
        if capacity_warning not in warning_items:
            warning_items.append(capacity_warning)
    search_url = f"https://www.threads.com/search?q={quote_plus(query)}"
    executed_at = _iso_now()
    return {
        "schemaVersion": THREADS_SEARCH_SCHEMA,
        "query": query,
        "platform": "threads",
        "accountId": str(account["id"]),
        "senderUsername": request["senderUsername"],
        "data": rows,
        "count": len(rows),
        "limit": limit,
        "truncated": len(raw_rows) > len(rows) or (provider == "tg_sentiment_hot" and limit > executor_max_results),
        "warning": "；".join(warning_items),
        "warnings": warning_items,
        "sourceUrl": search_url,
        "source": {
            "kind": LIVE_SOURCE_KIND,
            "livePlatform": True,
            "historyFallback": False,
            "provider": provider,
            "executorMaxResults": executor_max_results,
            "executedAt": executed_at,
            "accountId": str(account["id"]),
        },
        "request": {
            "scrollRounds": scroll_rounds,
            "delayMs": delay_ms,
            "browserMode": "persistent",
            "liveOnly": True,
            "recordShown": False,
        },
    }


def search_hotspots_live(
    conn: sqlite3.Connection,
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    executor: LiveSearchExecutor | None,
) -> dict[str, Any]:
    """Preserve the legacy hotspot response while using only live Threads rows."""

    captured: dict[str, Any] = {}

    def provider(_tenant: TenantContext, request: dict[str, Any]) -> Mapping[str, Any]:
        merged = {**dict(payload), **request}
        # Account selection is a trusted tenant-scoped field and is not part of
        # the old provider request built by legacy_operations.search_hotspots.
        for key in ("accountId", "account_id", "delayMs", "searchMode", "freshnessDays"):
            if key in payload:
                merged[key] = payload[key]
        result = search_threads_live(conn, tenant, merged, executor=executor)
        captured.update(result)
        return result

    result = search_hotspots(tenant, payload, search_provider=provider)
    return {
        **result,
        "schemaVersion": HOTSPOT_SCHEMA,
        "source": dict(captured.get("source") or {}),
        "livePlatform": True,
        "historyFallback": False,
    }


def query_opc_history_realtime(
    conn: sqlite3.Connection,
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    maximum: int = MAX_OPC_IMPORT_RESULTS,
) -> dict[str, Any]:
    """Query the current tenant DB state and label it accurately as history.

    ``realtime`` describes execution against current ``app.db`` state; it does
    not claim that these rows were fetched from Threads during this request.
    """

    started = time.time()
    maximum = max(1, min(int(maximum), MAX_OPC_IMPORT_RESULTS))
    requested_limit = _integer(
        payload.get("limit"),
        default=min(300, maximum),
        minimum=1,
        maximum=maximum,
    )
    requested_contact = _clean(payload.get("contact"), 20).lower()
    if requested_contact == "contacted":
        # Old opc-adapter.mjs defines contacted as every previously contacted
        # row, including a later failed delivery.  The base Python query uses
        # literal equality, so query the bounded tenant history first and then
        # restore the old semantic here.
        base_payload = {**dict(payload), "contact": "", "limit": maximum}
        result = query_opc_history(conn, tenant, base_payload, maximum=maximum)
        matched = [
            row
            for row in result.get("data", [])
            if isinstance(row, Mapping) and row.get("contactStatus") != "new"
        ]
        filters = dict(result.get("filters") or {})
        filters["contact"] = "contacted"
        result = {
            **result,
            "total": len(matched),
            "data": matched[:requested_limit],
            "limit": requested_limit,
            "truncated": len(matched) > requested_limit,
            "filters": filters,
        }
    else:
        result = query_opc_history(conn, tenant, payload, maximum=maximum)
    executed_at = _iso_now()
    return {
        **result,
        "schemaVersion": OPC_QUERY_SCHEMA,
        "queryMode": "realtime_database",
        "source": {
            "kind": HISTORY_SOURCE_KIND,
            "livePlatform": False,
            "history": True,
            "tenantScoped": True,
            "executedAt": executed_at,
            "durationMs": max(0, int((time.time() - started) * 1_000)),
        },
    }


__all__ = [
    "HISTORY_SOURCE_KIND",
    "LIVE_SOURCE_KIND",
    "THREADS_SEARCH_SCHEMA",
    "LiveSearchExecutor",
    "query_opc_history_realtime",
    "search_hotspots_live",
    "search_threads_live",
]
