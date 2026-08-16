from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlparse

import requests

from .db import db
from .password_vault import PasswordVaultError, decrypt_secret, encrypt_secret


THREADS_GRAPH_ORIGIN = "https://graph.threads.net"
THREADS_AUTHORIZE_URL = "https://threads.net/oauth/authorize"
THREADS_DEFAULT_SCOPES = (
    "threads_basic",
    "threads_content_publish",
    "threads_read_replies",
    "threads_manage_replies",
    "threads_manage_insights",
    "threads_keyword_search",
    "threads_manage_mentions",
    "threads_profile_discovery",
)
THREAD_FIELDS = (
    "id,media_product_type,media_type,media_url,permalink,owner,username,text,"
    "timestamp,shortcode,thumbnail_url,children,is_quote_post,quoted_post,"
    "reposted_post,has_replies,alt_text,link_attachment_url"
)
REPLY_FIELDS = (
    "id,media_product_type,media_type,media_url,permalink,username,text,timestamp,"
    "shortcode,thumbnail_url,is_quote_post,has_replies,is_reply,is_reply_owned_by_me,"
    "root_post,replied_to"
)


class ThreadsApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class ThreadsApiSettings:
    app_id: str
    app_secret: str
    redirect_uri: str
    scopes: tuple[str, ...]


def settings() -> ThreadsApiSettings:
    app_id = str(os.getenv("THREADS_APP_ID") or "").strip()
    app_secret = str(os.getenv("THREADS_APP_SECRET") or "").strip()
    redirect_uri = str(os.getenv("THREADS_REDIRECT_URI") or "").strip()
    if not redirect_uri:
        origin = str(os.getenv("HTTPS_CANONICAL_ORIGIN") or "").strip().rstrip("/")
        if origin:
            redirect_uri = f"{origin}/api/threads/oauth/callback"
    scopes = tuple(
        item.strip()
        for item in str(os.getenv("THREADS_OAUTH_SCOPES") or ",".join(THREADS_DEFAULT_SCOPES)).split(",")
        if item.strip()
    )
    if not app_id or not app_secret or not redirect_uri:
        raise ThreadsApiError("Threads API 尚未配置，请设置 THREADS_APP_ID、THREADS_APP_SECRET 和 HTTPS_CANONICAL_ORIGIN。")
    parsed = urlparse(redirect_uri)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ThreadsApiError("Threads OAuth 回调地址必须是有效的 HTTPS 地址。")
    return ThreadsApiSettings(app_id, app_secret, redirect_uri, scopes)


def authorization_url(state: str) -> str:
    config = settings()
    query = urlencode({
        "client_id": config.app_id,
        "redirect_uri": config.redirect_uri,
        "scope": ",".join(config.scopes),
        "response_type": "code",
        "state": state,
    })
    return f"{THREADS_AUTHORIZE_URL}?{query}"


def _request_json(method: str, url: str, **kwargs: Any) -> dict[str, Any]:
    try:
        response = requests.request(method, url, timeout=30, **kwargs)
    except requests.RequestException as exc:
        raise ThreadsApiError("Threads API 暂时无法连接。") from exc
    try:
        payload = response.json()
    except ValueError as exc:
        raise ThreadsApiError(f"Threads API 返回了无效响应（HTTP {response.status_code}）。") from exc
    if response.status_code >= 400 or not isinstance(payload, dict) or payload.get("error"):
        error = payload.get("error") if isinstance(payload, dict) else {}
        error_message = error.get("message") if isinstance(error, dict) else ""
        message = str(error_message or (payload.get("error_message") if isinstance(payload, dict) else "") or "").strip()
        raise ThreadsApiError(message or f"Threads API 请求失败（HTTP {response.status_code}）。")
    return payload


def exchange_code(code: str) -> dict[str, Any]:
    config = settings()
    short_lived = _request_json(
        "POST",
        f"{THREADS_GRAPH_ORIGIN}/oauth/access_token",
        data={
            "client_id": config.app_id,
            "client_secret": config.app_secret,
            "grant_type": "authorization_code",
            "redirect_uri": config.redirect_uri,
            "code": str(code or "").strip(),
        },
    )
    token = str(short_lived.get("access_token") or "").strip()
    if not token:
        raise ThreadsApiError("Threads 授权未返回访问令牌。")
    long_lived = _request_json(
        "GET",
        f"{THREADS_GRAPH_ORIGIN}/access_token",
        params={
            "grant_type": "th_exchange_token",
            "client_secret": config.app_secret,
            "access_token": token,
        },
    )
    if not str(long_lived.get("access_token") or "").strip():
        raise ThreadsApiError("Threads 长期访问令牌交换失败。")
    long_lived.setdefault("user_id", short_lived.get("user_id"))
    return long_lived


def refresh_long_lived_token(token: str) -> dict[str, Any]:
    return _request_json(
        "GET",
        f"{THREADS_GRAPH_ORIGIN}/refresh_access_token",
        params={"grant_type": "th_refresh_token", "access_token": str(token or "").strip()},
    )


def api_get(path: str, token: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    clean_path = str(path or "").strip()
    url = clean_path if clean_path.startswith("https://") else f"{THREADS_GRAPH_ORIGIN}/{clean_path.lstrip('/')}"
    if urlparse(url).netloc != urlparse(THREADS_GRAPH_ORIGIN).netloc:
        raise ThreadsApiError("Threads API 分页地址无效。")
    request_params = dict(params or {})
    request_params["access_token"] = token
    return _request_json("GET", url, params=request_params)


def paginated_get(path: str, token: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    next_url = ""
    for page_index in range(100):
        payload = api_get(next_url or path, token, {} if next_url else params)
        items.extend(item for item in payload.get("data", []) if isinstance(item, dict))
        next_url = str((payload.get("paging") or {}).get("next") or "").strip()
        if not next_url:
            return items
    raise ThreadsApiError("Threads API 分页超过安全上限，请缩小同步范围后重试。")


def fetch_profile(token: str) -> dict[str, Any]:
    return api_get(
        "/me",
        token,
        {"fields": "id,username,name,is_verified,threads_profile_picture_url,threads_biography,recently_searched_keywords"},
    )


def _insight_values(payload: dict[str, Any]) -> dict[str, int]:
    result: dict[str, int] = {}
    for metric in payload.get("data", []):
        if not isinstance(metric, dict):
            continue
        name = str(metric.get("name") or "").strip()
        total_value = metric.get("total_value") if isinstance(metric.get("total_value"), dict) else {}
        values = metric.get("values") if isinstance(metric.get("values"), list) else []
        raw_value = total_value.get("value")
        if raw_value is None and values and isinstance(values[-1], dict):
            raw_value = values[-1].get("value")
        try:
            result[name] = int(float(raw_value or 0))
        except (TypeError, ValueError):
            result[name] = 0
    return result


def _optional_get(path: str, token: str, params: dict[str, Any]) -> tuple[dict[str, Any], str]:
    try:
        return api_get(path, token, params), ""
    except ThreadsApiError as exc:
        return {}, str(exc)


def collect_account_data(token: str) -> dict[str, Any]:
    profile = fetch_profile(token)
    threads = paginated_get("/me/threads", token, {"fields": THREAD_FIELDS, "limit": 100})
    replies_error = ""
    mentions_error = ""
    try:
        replies = paginated_get("/me/replies", token, {"fields": REPLY_FIELDS, "limit": 100})
    except ThreadsApiError as exc:
        replies, replies_error = [], str(exc)
    try:
        mentions = paginated_get("/me/mentions", token, {"fields": THREAD_FIELDS, "limit": 100})
    except ThreadsApiError as exc:
        mentions, mentions_error = [], str(exc)
    account_insights_raw, account_insights_error = _optional_get(
        "/me/threads_insights",
        token,
        {"metric": "views,likes,replies,reposts,quotes,clicks,followers_count"},
    )
    follower_demographics: dict[str, Any] = {}
    follower_demographics_errors: dict[str, str] = {}
    for breakdown in ("country", "city", "age", "gender"):
        demographic_data, demographic_error = _optional_get(
            "/me/threads_insights",
            token,
            {"metric": "follower_demographics", "breakdown": breakdown},
        )
        follower_demographics[breakdown] = demographic_data
        if demographic_error:
            follower_demographics_errors[breakdown] = demographic_error
    publishing_limit, publishing_limit_error = _optional_get(
        "/me/threads_publishing_limit",
        token,
        {"fields": "quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config,location_search_quota_usage,location_search_config"},
    )
    account_insights = _insight_values(account_insights_raw)
    post_metrics: list[dict[str, Any]] = []
    post_insight_errors = 0
    for post in threads:
        post_id = str(post.get("id") or "").strip()
        if not post_id:
            continue
        try:
            insight = _insight_values(api_get(
                f"/{post_id}/insights",
                token,
                {"metric": "views,likes,replies,reposts,quotes,shares"},
            ))
        except ThreadsApiError:
            insight = {}
            post_insight_errors += 1
        post_metrics.append({
            "id": post_id,
            "platform": "threads",
            "username": str(post.get("username") or profile.get("username") or ""),
            "content": str(post.get("text") or ""),
            "sourceUrl": str(post.get("permalink") or ""),
            "publishedAt": str(post.get("timestamp") or ""),
            "likeCount": insight.get("likes", 0),
            "commentCount": insight.get("replies", 0),
            "repostCount": insight.get("reposts", 0),
            "shareCount": insight.get("shares", 0),
            "quoteCount": insight.get("quotes", 0),
            "viewCount": insight.get("views", 0),
            "viewAvailable": "views" in insight,
            "mediaType": str(post.get("media_type") or ""),
            "mediaUrl": str(post.get("media_url") or ""),
            "thumbnailUrl": str(post.get("thumbnail_url") or ""),
        })
    totals = {
        "likes": sum(int(item.get("likeCount") or 0) for item in post_metrics),
        "comments": sum(int(item.get("commentCount") or 0) for item in post_metrics),
        "reposts": sum(int(item.get("repostCount") or 0) for item in post_metrics),
        "shares": sum(int(item.get("shareCount") or 0) for item in post_metrics),
        "views": sum(int(item.get("viewCount") or 0) for item in post_metrics),
    }
    refreshed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "profile": profile,
        "threads": threads,
        "replies": replies,
        "mentions": mentions,
        "account_insights": account_insights,
        "account_insights_raw": account_insights_raw,
        "follower_demographics": follower_demographics,
        "publishing_limit": publishing_limit,
        "errors": {
            "account_insights": account_insights_error,
            "publishing_limit": publishing_limit_error,
            "replies": replies_error,
            "mentions": mentions_error,
            "follower_demographics": follower_demographics_errors,
            "post_insights_failed": post_insight_errors,
        },
        "normalized": {
            "platform": "threads",
            "username": str(profile.get("username") or ""),
            "method": "threads_api",
            "followers": account_insights.get("followers_count", 0),
            "following": 0,
            "recentViews": account_insights.get("views", 0),
            "clicks": account_insights.get("clicks", 0),
            "posts": len(threads),
            **totals,
            "scannedPosts": len(post_metrics),
            "viewResolvedPosts": sum(1 for item in post_metrics if item.get("viewAvailable")),
            "viewMissingPosts": sum(1 for item in post_metrics if not item.get("viewAvailable")),
            "postMetrics": post_metrics,
            "complete": not any((account_insights_error, replies_error, mentions_error, follower_demographics_errors, post_insight_errors)),
            "scope": "official_api",
            "refreshedAt": refreshed_at,
            "snapshots": [{"refreshedAt": refreshed_at, "followers": account_insights.get("followers_count", 0), **totals}],
        },
    }


def token_purpose(account_id: str) -> str:
    return f"social-account-api:threads:{str(account_id or '').strip()}"


def save_credential(
    *, account_id: str, user_id: int, platform_user_id: str, access_token: str,
    scopes: tuple[str, ...], expires_in: int,
) -> None:
    now = int(time.time())
    try:
        ciphertext = encrypt_secret(user_id, token_purpose(account_id), access_token)
    except PasswordVaultError as exc:
        raise ThreadsApiError("密码保险库不可用，无法安全保存 Threads 授权。") from exc
    with db() as conn:
        conn.execute(
            """
            DELETE FROM social_account_api_credentials
            WHERE user_id = ? AND platform = 'threads' AND platform_user_id = ? AND account_id <> ?
            """,
            (user_id, platform_user_id, account_id),
        )
        conn.execute(
            """
            INSERT INTO social_account_api_credentials(
              account_id, user_id, platform, platform_user_id, access_token_ciphertext,
              token_type, scope_json, expires_at, status, last_sync_at, last_error,
              created_at, updated_at
            ) VALUES (?, ?, 'threads', ?, ?, 'bearer', ?, ?, 'active', 0, '', ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
              user_id=excluded.user_id, platform_user_id=excluded.platform_user_id,
              access_token_ciphertext=excluded.access_token_ciphertext,
              token_type=excluded.token_type, scope_json=excluded.scope_json,
              expires_at=excluded.expires_at, status='active', last_error='', updated_at=excluded.updated_at
            """,
            (account_id, user_id, platform_user_id, ciphertext, json.dumps(scopes), now + max(0, int(expires_in or 0)), now, now),
        )


def sync_account(account_id: str, user_id: int) -> dict[str, Any]:
    with db() as conn:
        credential = conn.execute(
            "SELECT * FROM social_account_api_credentials WHERE account_id = ? AND user_id = ? AND platform = 'threads'",
            (account_id, user_id),
        ).fetchone()
    if not credential or str(credential["status"] or "") != "active":
        raise ThreadsApiError("该 Threads 账号尚未完成 API 授权。")
    try:
        token = decrypt_secret(user_id, token_purpose(account_id), str(credential["access_token_ciphertext"] or ""))
        expires_at = int(credential["expires_at"] or 0)
        if expires_at and expires_at <= int(time.time()) + 7 * 86400:
            try:
                refreshed = refresh_long_lived_token(token)
            except ThreadsApiError:
                if expires_at <= int(time.time()):
                    raise
            else:
                refreshed_token = str(refreshed.get("access_token") or "").strip()
                if refreshed_token:
                    token = refreshed_token
                    refreshed_expires_at = int(time.time()) + max(0, int(refreshed.get("expires_in") or 0))
                    refreshed_ciphertext = encrypt_secret(user_id, token_purpose(account_id), token)
                    with db() as conn:
                        conn.execute(
                            """
                            UPDATE social_account_api_credentials
                            SET access_token_ciphertext = ?, expires_at = ?, updated_at = ?
                            WHERE account_id = ? AND user_id = ?
                            """,
                            (refreshed_ciphertext, refreshed_expires_at, int(time.time()), account_id, user_id),
                        )
        data = collect_account_data(token)
    except (PasswordVaultError, ThreadsApiError) as exc:
        with db() as conn:
            conn.execute(
                "UPDATE social_account_api_credentials SET last_error = ?, updated_at = ? WHERE account_id = ?",
                (str(exc)[:1000], int(time.time()), account_id),
            )
        raise ThreadsApiError(str(exc)) from exc
    normalized = dict(data["normalized"])
    normalized["accountId"] = account_id
    normalized["platformUserId"] = str(credential["platform_user_id"] or "")
    data["normalized"] = normalized
    now = int(time.time())
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_api_snapshots(account_id, user_id, platform, data_json, refreshed_at, created_at, updated_at)
            VALUES (?, ?, 'threads', ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET data_json=excluded.data_json,
              refreshed_at=excluded.refreshed_at, updated_at=excluded.updated_at
            """,
            (account_id, user_id, json.dumps(data, ensure_ascii=False), now, now, now),
        )
        conn.execute(
            "UPDATE social_account_api_credentials SET last_sync_at = ?, last_error = '', updated_at = ? WHERE account_id = ?",
            (now, now, account_id),
        )
    return data


def sync_accounts(user_id: int, archive_ids: list[str] | None = None) -> dict[str, Any]:
    clauses = ["account.user_id = ?", "account.platform = 'threads'", "credential.status = 'active'"]
    params: list[Any] = [user_id]
    clean_archive_ids = [str(item or "").strip() for item in (archive_ids or []) if str(item or "").strip()]
    if clean_archive_ids:
        clauses.append(f"account.persona_id IN ({','.join('?' for _ in clean_archive_ids)})")
        params.extend(clean_archive_ids)
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT account.id FROM social_accounts account
            JOIN social_account_api_credentials credential ON credential.account_id = account.id
            WHERE {' AND '.join(clauses)} ORDER BY account.updated_at DESC
            """,
            tuple(params),
        ).fetchall()
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for row in rows:
        account_id = str(row["id"] or "")
        try:
            results.append({"account_id": account_id, "data": sync_account(account_id, user_id)})
        except ThreadsApiError as exc:
            errors.append({"account_id": account_id, "error": str(exc)})
    return {"synced": results, "errors": errors, "account_ids": [str(row["id"] or "") for row in rows]}


def account_api_public_rows(conn: Any, account_ids: set[str]) -> dict[str, dict[str, Any]]:
    if not account_ids:
        return {}
    rows = conn.execute(
        f"SELECT * FROM social_account_api_credentials WHERE account_id IN ({','.join('?' for _ in account_ids)})",
        tuple(account_ids),
    ).fetchall()
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        scopes = []
        try:
            scopes = json.loads(str(row["scope_json"] or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
        result[str(row["account_id"] or "")] = {
            "api_connected": str(row["status"] or "") == "active",
            "api_status": str(row["status"] or ""),
            "api_scopes": scopes if isinstance(scopes, list) else [],
            "api_expires_at": int(row["expires_at"] or 0),
            "api_last_sync_at": int(row["last_sync_at"] or 0),
            "api_last_error": str(row["last_error"] or ""),
        }
    return result
