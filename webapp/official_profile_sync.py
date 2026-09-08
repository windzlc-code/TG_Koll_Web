from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any

from .bundle_social import (
    BundleSocialClient,
    BundleSocialError,
    _localize_bundle_error,
    is_bundle_reauth_required,
    platform_type,
    verify_webhook_signature,
)
from .bundle_social_config import (
    configuration_status,
    official_webhook_public_url,
    record_homepage_sync,
    record_webhook_delivery,
    remember_webhook_event,
    resolve_configuration,
)
from .db import db


logger = logging.getLogger(__name__)

_HOMEPAGE_MONITOR_LOCK = threading.Lock()
_HOMEPAGE_MONITOR_STARTED = False
_DISCONNECT_CODES = {
    "REMOTE_DISCONNECT_DELETION_SCHEDULED",
    "REMOTE_DISCONNECT_UNAUTHORIZED_WARNING",
    "REMOTE_DISCONNECT_REAUTH_REQUIRED",
}


def _persona_write(operation):
    from . import server
    return server._persona_archive_write_locked(operation)


def official_homepage_overlay_enabled() -> bool:
    try:
        with db() as conn:
            status = configuration_status(conn)
    except Exception:
        return False
    return bool(status.get("configured")) and bool(status.get("homepage_overlay_enabled"))


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _latest_analytics_snapshot(payload: dict[str, Any]) -> dict[str, Any] | None:
    rows = payload.get("items") if isinstance(payload.get("items"), list) else []
    snapshots = [
        item for item in rows
        if isinstance(item, dict) and not str(item.get("deletedAt") or item.get("deleted_at") or "").strip()
    ]
    snapshots.sort(
        key=lambda item: str(item.get("updatedAt") or item.get("updated_at") or item.get("createdAt") or item.get("created_at") or ""),
        reverse=True,
    )
    return snapshots[0] if snapshots else None


def _official_homepage_accounts(
    *,
    user_id: int = 0,
    archive_id: str = "",
    archive_ids: list[str] | None = None,
    platform: str = "",
) -> list[dict[str, str]]:
    clauses = [
        "lower(account.auth_provider) = 'bundle'",
        "trim(account.external_team_id) <> ''",
        "trim(account.persona_id) <> ''",
        "trim(account.username) <> ''",
        "lower(account.platform) IN ('threads', 'instagram')",
        "lower(account.status) NOT IN ('banned', 'disabled')",
    ]
    params: list[Any] = []
    owner_user_id = max(0, int(user_id or 0))
    clean_archive_id = str(archive_id or "").strip()
    clean_platform = str(platform or "").strip().lower()
    clean_archive_ids = list(dict.fromkeys(
        str(item or "").strip() for item in (archive_ids or []) if str(item or "").strip()
    ))
    if owner_user_id:
        clauses.append("account.user_id = ?")
        params.append(owner_user_id)
    if clean_platform in {"threads", "instagram"}:
        clauses.append("lower(account.platform) = ?")
        params.append(clean_platform)
    if clean_archive_id:
        clauses.append("account.persona_id = ?")
        params.append(clean_archive_id)
    elif archive_ids is not None:
        if not clean_archive_ids:
            return []
        clauses.append(f"account.persona_id IN ({','.join('?' for _ in clean_archive_ids)})")
        params.extend(clean_archive_ids)
    query = f"""
        SELECT account.id, account.user_id, account.persona_id, account.platform,
               account.username, account.external_team_id, account.external_account_id
        FROM social_accounts AS account
        WHERE {' AND '.join(clauses)}
        ORDER BY account.updated_at DESC, account.created_at DESC
    """
    accounts: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    with db() as conn:
        for row in conn.execute(query, params).fetchall():
            platform_name = str(row["platform"] or "").strip().lower()
            persona_id = str(row["persona_id"] or "").strip()
            key = (persona_id, platform_name)
            if key in seen:
                continue
            seen.add(key)
            accounts.append({
                "id": str(row["id"] or "").strip(),
                "user_id": str(row["user_id"] or "0"),
                "persona_id": persona_id,
                "platform": platform_name,
                "username": str(row["username"] or "").strip().lstrip("@"),
                "external_team_id": str(row["external_team_id"] or "").strip(),
                "external_account_id": str(row["external_account_id"] or "").strip(),
            })
    return accounts


def _overlay_persona_homepage_metrics(
    archive_id: str,
    platform: str,
    username: str,
    account_id: str,
    snapshot: dict[str, Any],
) -> bool:
    from . import server

    clean_id = str(archive_id or "").strip()
    clean_platform = str(platform or "").strip().lower()
    clean_username = str(username or "").strip().lstrip("@")
    if not clean_id or clean_platform not in {"threads", "instagram"} or not clean_username:
        return False

    def _number(value: Any) -> int | None:
        try:
            if value is None or value is False:
                return None
            number = int(float(value))
        except (TypeError, ValueError):
            return None
        return max(0, number)

    followers = _number(snapshot.get("followers"))
    views = _number(snapshot.get("views") or snapshot.get("viewsUnique"))
    likes = _number(snapshot.get("likes"))
    comments = _number(snapshot.get("comments"))
    if followers is None and views is None and likes is None and comments is None:
        return False
    refreshed_at = str(snapshot.get("updatedAt") or snapshot.get("updated_at") or snapshot.get("createdAt") or "").strip() or _iso_now()

    @_persona_write
    def write() -> bool:
        path, raw, archives = server._persona_archive_source_for_write(clean_id)
        archive = server._find_persona_archive(archives, clean_id)
        if not isinstance(archive, dict):
            return False
        setup = archive.get("setup") if isinstance(archive.get("setup"), dict) else {}
        hot_metrics = dict(setup.get("hotMetrics") if isinstance(setup.get("hotMetrics"), dict) else {})
        metric_key = f"{clean_platform}:{clean_username.lower()}"
        current = None
        for key, value in hot_metrics.items():
            if not isinstance(value, dict):
                continue
            platform_name = str(value.get("platform") or str(key).split(":", 1)[0] or "").strip().lower()
            metric_username = str(value.get("username") or "").strip().lstrip("@")
            metric_account_id = str(value.get("accountId") or value.get("account_id") or "").strip()
            if platform_name != clean_platform:
                continue
            if metric_username and metric_username.lower() == clean_username.lower():
                current = value
                metric_key = key
                break
            if account_id and metric_account_id and metric_account_id == account_id:
                current = value
                metric_key = key
                break
        next_metric = dict(current or {})
        next_metric["platform"] = clean_platform
        next_metric["username"] = clean_username
        if account_id:
            next_metric["accountId"] = account_id
        if followers is not None:
            next_metric["followers"] = followers
        if views is not None:
            next_metric["recentViews"] = views
        if likes is not None:
            next_metric["likes"] = likes
        if comments is not None:
            next_metric["comments"] = comments
        next_metric["homepageSource"] = "official_profile"
        next_metric["homepageRefreshedAt"] = refreshed_at
        if not str(next_metric.get("method") or "").strip():
            next_metric["method"] = "official_profile"
        if "postMetrics" not in next_metric:
            next_metric["postMetrics"] = list(current.get("postMetrics") or []) if isinstance(current, dict) else []
        if not str(next_metric.get("scope") or "").strip():
            next_metric["scope"] = "official_profile_snapshot"
        hot_metrics[metric_key] = next_metric
        archive["setup"] = {**setup, "hotMetrics": hot_metrics}
        archive["updatedAt"] = _iso_now()
        server._write_persona_archives_preserving_shape(path, raw, archives)
        return True

    return bool(write())


def sync_official_homepage_metrics(
    *,
    user_id: int = 0,
    archive_id: str = "",
    archive_ids: list[str] | None = None,
    platform: str = "",
) -> dict[str, int]:
    result = {"attempted": 0, "updated": 0, "failed": 0}
    if not official_homepage_overlay_enabled():
        return result
    accounts = _official_homepage_accounts(
        user_id=user_id,
        archive_id=archive_id,
        archive_ids=archive_ids,
        platform=platform,
    )
    if not accounts:
        return result
    try:
        client = BundleSocialClient(timeout_seconds=20)
    except BundleSocialError:
        return result
    for account in accounts:
        result["attempted"] += 1
        try:
            payload = client.get_social_account_analytics(
                team_id=account["external_team_id"],
                platform=account["platform"],
            )
            snapshot = _latest_analytics_snapshot(payload)
            if not snapshot:
                result["failed"] += 1
                continue
            if _overlay_persona_homepage_metrics(
                account["persona_id"],
                account["platform"],
                account["username"],
                account["id"],
                snapshot,
            ):
                result["updated"] += 1
            else:
                result["failed"] += 1
        except Exception as exc:
            result["failed"] += 1
            logger.warning(
                "official homepage metrics read failed: persona=%s platform=%s error=%s",
                account.get("persona_id"),
                account.get("platform"),
                exc,
            )
    try:
        with db() as conn:
            record_homepage_sync(
                conn,
                f"已读取 {result['updated']} 个账号主页数据"
                + (f"，{result['failed']} 个未更新" if result["failed"] else "")
                + "。",
            )
    except Exception:
        pass
    return result


def _find_account_by_external_id(external_account_id: str, platform: str = "") -> dict[str, str] | None:
    clean_id = str(external_account_id or "").strip()
    if not clean_id:
        return None
    clauses = ["lower(auth_provider) = 'bundle'", "external_account_id = ?"]
    params: list[Any] = [clean_id]
    clean_platform = str(platform or "").strip().lower()
    if clean_platform in {"threads", "instagram"}:
        clauses.append("lower(platform) = ?")
        params.append(clean_platform)
    with db() as conn:
        row = conn.execute(
            f"""
            SELECT id, persona_id, platform, username, user_id, external_team_id, external_account_id
            FROM social_accounts
            WHERE {' AND '.join(clauses)}
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            params,
        ).fetchone()
    if not row:
        return None
    return {
        "id": str(row["id"] or "").strip(),
        "persona_id": str(row["persona_id"] or "").strip(),
        "platform": str(row["platform"] or "").strip().lower(),
        "username": str(row["username"] or "").strip().lstrip("@"),
        "user_id": str(row["user_id"] or "0"),
        "external_team_id": str(row["external_team_id"] or "").strip(),
        "external_account_id": str(row["external_account_id"] or "").strip(),
    }


def _mark_account_needs_reauth(external_account_id: str, detail: str) -> None:
    clean_id = str(external_account_id or "").strip()
    if not clean_id:
        return
    now = int(time.time())
    with db() as conn:
        conn.execute(
            """
            UPDATE social_accounts
            SET status = CASE WHEN lower(status) IN ('banned', 'disabled') THEN status ELSE 'cookie_expired' END,
                last_error = ?,
                updated_at = ?
            WHERE lower(auth_provider) = 'bundle' AND external_account_id = ?
            """,
            (str(detail or "账号授权已失效，请重新授权。")[:300], now, clean_id),
        )


def _permalink_from_post_payload(data: dict[str, Any]) -> tuple[str, str]:
    external = data.get("externalData") if isinstance(data.get("externalData"), dict) else {}
    for platform in ("threads", "instagram"):
        key = platform_type(platform)
        item = external.get(key) if isinstance(external.get(key), dict) else {}
        url = str(item.get("permalink") or item.get("url") or item.get("publishedUrl") or "").strip()
        if url:
            return platform, url
    return "", ""


def _raw_post_error(data: dict[str, Any]) -> str:
    verbose = data.get("errorsVerbose")
    if isinstance(verbose, dict):
        parts: list[str] = []
        for item in verbose.values():
            if not isinstance(item, dict):
                continue
            text = str(item.get("userFacingMessage") or item.get("errorMessage") or "").strip()
            if text:
                parts.append(text)
        if parts:
            return "；".join(parts)
    for key in ("error", "message"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            text = str(value.get("userFacingMessage") or value.get("message") or value.get("error") or "").strip()
            if text:
                return text
    errors = data.get("errors")
    if isinstance(errors, str) and errors.strip():
        return errors.strip()
    return ""


def _task_bundle_post_id(result: dict[str, Any]) -> str:
    published = result.get("published") if isinstance(result.get("published"), dict) else {}
    return str(result.get("bundle_post_id") or published.get("bundle_post_id") or "").strip()


def _task_has_published_url(result: dict[str, Any]) -> bool:
    published = result.get("published") if isinstance(result.get("published"), dict) else {}
    for value in (result.get("published_url"), result.get("url"), published.get("permalink"), published.get("url")):
        if str(value or "").strip().startswith(("http://", "https://")):
            return True
    return False


def _record_publish_failure(data: dict[str, Any]) -> None:
    post_id = str(data.get("id") or "").strip()
    reference_key = str(data.get("referenceKey") or data.get("reference_key") or "").strip()
    raw_detail = _raw_post_error(data)
    message = _localize_bundle_error(raw_detail) if raw_detail else "发布失败，平台未接受该条内容。"
    message = str(message or "发布失败，平台未接受该条内容。")[:500]
    social_accounts = data.get("socialAccounts") if isinstance(data.get("socialAccounts"), list) else []
    external_account_id = ""
    platform = ""
    for item in social_accounts:
        nested = item.get("socialAccount") if isinstance(item, dict) and isinstance(item.get("socialAccount"), dict) else item
        if not isinstance(nested, dict):
            continue
        nested_type = str(nested.get("type") or "").strip().upper()
        if nested_type in {"THREADS", "INSTAGRAM"}:
            platform = nested_type.lower()
        external_account_id = str(nested.get("id") or "").strip()
        if external_account_id:
            break
    account = _find_account_by_external_id(external_account_id, platform)
    if is_bundle_reauth_required(raw_detail) and external_account_id:
        _mark_account_needs_reauth(external_account_id, message)
    now = int(time.time())
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, result_json, account_id, updated_at
            FROM social_automation_tasks
            WHERE task_type = 'publish_post' AND status = 'failed'
            ORDER BY updated_at DESC
            LIMIT 80
            """
        ).fetchall()
        matched: list[Any] = []
        for row in rows:
            if reference_key and str(row["id"] or "") == reference_key:
                matched.append(row)
                continue
            try:
                result = json.loads(str(row["result_json"] or "{}") or "{}")
            except Exception:
                result = {}
            if not isinstance(result, dict):
                continue
            if post_id and _task_bundle_post_id(result) == post_id:
                matched.append(row)
        if not matched and account:
            recent = [
                row for row in rows
                if str(row["account_id"] or "") == account["id"]
                and int(row["updated_at"] or 0) >= now - 2 * 3600
            ]
            unique: list[Any] = []
            for row in recent:
                try:
                    result = json.loads(str(row["result_json"] or "{}") or "{}")
                except Exception:
                    result = {}
                if isinstance(result, dict) and not _task_has_published_url(result):
                    unique.append(row)
            if len(unique) == 1:
                matched = unique
        for row in matched[:5]:
            try:
                result = json.loads(str(row["result_json"] or "{}") or "{}")
            except Exception:
                result = {}
            if not isinstance(result, dict):
                result = {}
            result["official_publish_error"] = message
            if post_id and not _task_bundle_post_id(result):
                result["bundle_post_id"] = post_id
            conn.execute(
                """
                UPDATE social_automation_tasks
                SET error = ?, result_json = ?, updated_at = ?
                WHERE id = ? AND status = 'failed'
                """,
                (message, json.dumps(result, ensure_ascii=False), now, row["id"]),
            )


def _ingest_published_post(data: dict[str, Any]) -> None:
    from . import server

    status = str(data.get("status") or "").strip().upper()
    if status == "ERROR":
        _record_publish_failure(data)
        return
    if status != "POSTED":
        return
    platform, permalink = _permalink_from_post_payload(data)
    social_accounts = data.get("socialAccounts") if isinstance(data.get("socialAccounts"), list) else []
    external_account_id = ""
    for item in social_accounts:
        nested = item.get("socialAccount") if isinstance(item, dict) and isinstance(item.get("socialAccount"), dict) else item
        if not isinstance(nested, dict):
            continue
        nested_type = str(nested.get("type") or "").strip().upper()
        if platform and nested_type and nested_type != platform_type(platform):
            continue
        external_account_id = str(nested.get("id") or "").strip()
        if not platform and nested_type in {"THREADS", "INSTAGRAM"}:
            platform = nested_type.lower()
        if external_account_id:
            break
    account = _find_account_by_external_id(external_account_id, platform)
    if not account or not account.get("persona_id") or not permalink:
        return
    identity = {"account_id": account["id"], "username": account["username"]}
    content = ""
    payload_data = data.get("data") if isinstance(data.get("data"), dict) else {}
    platform_payload = payload_data.get(platform_type(account["platform"])) if isinstance(payload_data, dict) else {}
    if isinstance(platform_payload, dict):
        content = str(platform_payload.get("text") or "").strip()

    @_persona_write
    def write() -> None:
        path, raw, archives = server._persona_archive_source_for_write(account["persona_id"])
        archive = server._find_persona_archive(archives, account["persona_id"])
        if not isinstance(archive, dict):
            return
        history = archive.get("publishHistory") if isinstance(archive.get("publishHistory"), list) else []
        normalized = server._normalized_dashboard_post_url(permalink)
        for item in history:
            if not isinstance(item, dict):
                continue
            existing = server._normalized_dashboard_post_url(server._confirmed_archive_publish_url(item))
            if existing and normalized and existing == normalized:
                return
        record = server._publish_record_from_profile_post(
            account["platform"],
            permalink,
            content or "已发布推文",
            identity,
            {"sourceUrl": permalink, "content": content},
        )
        record["sourceMeta"] = {
            **(record.get("sourceMeta") if isinstance(record.get("sourceMeta"), dict) else {}),
            "source": "official_publish_webhook",
        }
        archive["publishHistory"] = [record, *history]
        archive["updatedAt"] = _iso_now()
        server._write_persona_archives_preserving_shape(path, raw, archives)

    write()
    if account.get("external_team_id"):
        try:
            sync_official_homepage_metrics(
                archive_id=account["persona_id"],
                platform=account["platform"],
            )
        except Exception:
            logger.warning("homepage overlay after publish webhook failed: persona=%s", account.get("persona_id"))


def _event_key(event_type: str, data: dict[str, Any], raw_body: bytes) -> str:
    data_id = str(data.get("id") or "").strip()
    status = str(data.get("status") or "").strip()
    updated = str(data.get("updatedAt") or data.get("postedDate") or "").strip()
    seed = f"{event_type}|{data_id}|{status}|{updated}"
    if seed.strip("|") == event_type:
        return hashlib.sha256(raw_body).hexdigest()
    return seed[:180]


def handle_official_auth_webhook(*, raw_body: bytes, signature_header: str) -> dict[str, Any]:
    with db() as conn:
        configured = resolve_configuration(conn)
    secret = str(configured.get("webhook_secret") or "").strip()
    if not secret:
        return {"ok": False, "status_code": 404, "detail": "未配置回调签名密钥"}
    if not verify_webhook_signature(raw_body=raw_body, signature_header=signature_header, secret=secret):
        return {"ok": False, "status_code": 401, "detail": "回调签名无效"}
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        return {"ok": False, "status_code": 400, "detail": "回调内容无效"}
    if not isinstance(payload, dict):
        return {"ok": False, "status_code": 400, "detail": "回调内容无效"}
    event_type = str(payload.get("type") or "").strip()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    key = _event_key(event_type, data, raw_body)
    with db() as conn:
        already = conn.execute(
            "SELECT event_key FROM bundle_social_webhook_events WHERE event_key = ?",
            (key,),
        ).fetchone()
    if already:
        return {"ok": True, "duplicate": True}
    delivery_type = event_type
    if event_type == "post.published":
        status = str(data.get("status") or "").strip().upper()
        if status:
            delivery_type = f"{event_type}:{status}"
    try:
        if event_type == "post.published":
            _ingest_published_post(data)
        elif event_type in {"social-account.updated", "social-account.deleted"}:
            external_id = str(data.get("id") or "").strip()
            action = data.get("socialAction") if isinstance(data.get("socialAction"), dict) else {}
            details = action.get("details") if isinstance(action.get("details"), dict) else {}
            code = str(details.get("code") or "").strip()
            if event_type == "social-account.deleted" or code in _DISCONNECT_CODES:
                _mark_account_needs_reauth(external_id, str(details.get("message") or "账号授权已失效，请重新授权。"))
        with db() as conn:
            remember_webhook_event(conn, key, event_type)
            record_webhook_delivery(conn, event_type=delivery_type)
    except Exception as exc:
        logger.warning("official auth webhook handler failed: type=%s error=%s", event_type, exc)
        with db() as conn:
            record_webhook_delivery(conn, event_type=event_type, error=str(exc)[:300])
        return {"ok": False, "status_code": 500, "detail": "回调处理失败"}
    return {"ok": True, "duplicate": False}


def _homepage_monitor_loop() -> None:
    while True:
        delay = DEFAULT_SLEEP = 12 * 3600
        try:
            with db() as conn:
                status = configuration_status(conn)
            delay = max(6 * 3600, int(status.get("homepage_read_interval_hours") or 12) * 3600)
            offset = max(8 * 3600, int(status.get("collect_offset_hours") or 12) * 3600)
            if official_homepage_overlay_enabled():
                from . import server
                monitor = dict(getattr(server, "PERSONA_DASHBOARD_MONITOR_STATE", {}) or {})
                last_started = str(monitor.get("last_started_at") or "")
                running = str(monitor.get("status") or "") in {"running", "starting"}
                if running:
                    delay = min(delay, 600)
                else:
                    last_ts = 0.0
                    if last_started:
                        last_ts = server._persona_dashboard_refresh_timestamp(last_started)
                    if last_ts and (time.time() - last_ts) < offset:
                        delay = int(offset - (time.time() - last_ts))
                    else:
                        sync_official_homepage_metrics()
        except Exception as exc:
            logger.warning("official homepage monitor failed: %s", exc)
            delay = 1800
        time.sleep(max(300, int(delay)))


def ensure_official_homepage_monitor_started() -> None:
    global _HOMEPAGE_MONITOR_STARTED
    with _HOMEPAGE_MONITOR_LOCK:
        if _HOMEPAGE_MONITOR_STARTED:
            return
        _HOMEPAGE_MONITOR_STARTED = True
    thread = threading.Thread(target=_homepage_monitor_loop, name="official-homepage-metrics-monitor", daemon=True)
    thread.start()


def official_webhook_url() -> str:
    return official_webhook_public_url()
