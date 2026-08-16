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


INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize"
INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token"
INSTAGRAM_GRAPH_ORIGIN = "https://graph.instagram.com"
INSTAGRAM_DEFAULT_SCOPES = (
    "instagram_business_basic",
)


class InstagramApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class InstagramApiSettings:
    app_id: str
    app_secret: str
    redirect_uri: str
    scopes: tuple[str, ...]


def settings() -> InstagramApiSettings:
    app_id = str(os.getenv("INSTAGRAM_APP_ID") or "").strip()
    app_secret = str(os.getenv("INSTAGRAM_APP_SECRET") or "").strip()
    redirect_uri = str(os.getenv("INSTAGRAM_REDIRECT_URI") or "").strip()
    if not redirect_uri:
        origin = str(os.getenv("HTTPS_CANONICAL_ORIGIN") or "").strip().rstrip("/")
        if origin:
            redirect_uri = f"{origin}/api/instagram/oauth/callback"
    scopes = tuple(
        item.strip()
        for item in str(os.getenv("INSTAGRAM_OAUTH_SCOPES") or ",".join(INSTAGRAM_DEFAULT_SCOPES)).split(",")
        if item.strip()
    )
    if not app_id or not app_secret or not redirect_uri:
        raise InstagramApiError(
            "Instagram API 尚未配置，请设置 INSTAGRAM_APP_ID、INSTAGRAM_APP_SECRET 和 HTTPS_CANONICAL_ORIGIN。"
        )
    parsed = urlparse(redirect_uri)
    if parsed.scheme != "https" or not parsed.netloc:
        raise InstagramApiError("Instagram OAuth 回调地址必须是有效的 HTTPS 地址。")
    return InstagramApiSettings(app_id, app_secret, redirect_uri, scopes)


def authorization_url(state: str) -> str:
    config = settings()
    query = urlencode({
        "client_id": config.app_id,
        "redirect_uri": config.redirect_uri,
        "scope": ",".join(config.scopes),
        "response_type": "code",
        "state": state,
    })
    return f"{INSTAGRAM_AUTHORIZE_URL}?{query}"


def _request_json(method: str, url: str, **kwargs: Any) -> dict[str, Any]:
    try:
        response = requests.request(method, url, timeout=30, **kwargs)
    except requests.RequestException as exc:
        raise InstagramApiError("Instagram API 暂时无法连接。") from exc
    try:
        payload = response.json()
    except ValueError as exc:
        raise InstagramApiError(f"Instagram API 返回了无效响应（HTTP {response.status_code}）。") from exc
    if response.status_code >= 400 or not isinstance(payload, dict) or payload.get("error"):
        error = payload.get("error") if isinstance(payload, dict) else {}
        message = str(
            (error.get("message") if isinstance(error, dict) else "")
            or payload.get("error_message")
            or payload.get("message")
            or ""
        ).strip()
        raise InstagramApiError(message or f"Instagram API 请求失败（HTTP {response.status_code}）。")
    return payload


def exchange_code(code: str) -> dict[str, Any]:
    config = settings()
    short_lived = _request_json(
        "POST",
        INSTAGRAM_TOKEN_URL,
        data={
            "client_id": config.app_id,
            "client_secret": config.app_secret,
            "grant_type": "authorization_code",
            "redirect_uri": config.redirect_uri,
            "code": str(code or "").strip().removesuffix("#_"),
        },
    )
    token = str(short_lived.get("access_token") or "").strip()
    if not token:
        raise InstagramApiError("Instagram 授权未返回访问令牌。")
    long_lived = _request_json(
        "GET",
        f"{INSTAGRAM_GRAPH_ORIGIN}/access_token",
        params={
            "grant_type": "ig_exchange_token",
            "client_secret": config.app_secret,
            "access_token": token,
        },
    )
    if not str(long_lived.get("access_token") or "").strip():
        raise InstagramApiError("Instagram 长期访问令牌交换失败。")
    long_lived.setdefault("user_id", short_lived.get("user_id"))
    return long_lived


def api_get(path: str, token: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    clean_path = str(path or "").strip()
    url = clean_path if clean_path.startswith("https://") else f"{INSTAGRAM_GRAPH_ORIGIN}/{clean_path.lstrip('/')}"
    if urlparse(url).netloc != urlparse(INSTAGRAM_GRAPH_ORIGIN).netloc:
        raise InstagramApiError("Instagram API 分页地址无效。")
    request_params = dict(params or {})
    request_params["access_token"] = token
    return _request_json("GET", url, params=request_params)


def fetch_profile(token: str) -> dict[str, Any]:
    return api_get(
        "/me",
        token,
        {
            "fields": (
                "id,user_id,username,name,account_type,profile_picture_url,"
                "followers_count,follows_count,media_count"
            )
        },
    )


def _paginated_media(token: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    path = "/me/media"
    params: dict[str, Any] = {
        "fields": (
            "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,"
            "username,comments_count,like_count,children{id,media_type,media_url,thumbnail_url}"
        ),
        "limit": 100,
    }
    for _ in range(100):
        payload = api_get(path, token, params)
        items.extend(item for item in payload.get("data", []) if isinstance(item, dict))
        path = str((payload.get("paging") or {}).get("next") or "").strip()
        params = {}
        if not path:
            return items
    raise InstagramApiError("Instagram API 分页超过安全上限，请缩小同步范围后重试。")


def collect_account_data(token: str) -> dict[str, Any]:
    profile = fetch_profile(token)
    media = _paginated_media(token)
    post_metrics = [
        {
            "id": str(item.get("id") or ""),
            "platform": "instagram",
            "username": str(item.get("username") or profile.get("username") or ""),
            "content": str(item.get("caption") or ""),
            "sourceUrl": str(item.get("permalink") or ""),
            "publishedAt": str(item.get("timestamp") or ""),
            "likeCount": int(item.get("like_count") or 0),
            "commentCount": int(item.get("comments_count") or 0),
            "mediaType": str(item.get("media_type") or ""),
            "mediaUrl": str(item.get("media_url") or ""),
            "thumbnailUrl": str(item.get("thumbnail_url") or ""),
        }
        for item in media
    ]
    refreshed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "profile": profile,
        "media": media,
        "normalized": {
            "platform": "instagram",
            "username": str(profile.get("username") or ""),
            "method": "instagram_api",
            "followers": int(profile.get("followers_count") or 0),
            "following": int(profile.get("follows_count") or 0),
            "posts": int(profile.get("media_count") or len(media)),
            "likes": sum(int(item.get("likeCount") or 0) for item in post_metrics),
            "comments": sum(int(item.get("commentCount") or 0) for item in post_metrics),
            "postMetrics": post_metrics,
            "scannedPosts": len(post_metrics),
            "scope": "official_api",
            "complete": True,
            "refreshedAt": refreshed_at,
        },
    }


def _token_purpose(account_id: str) -> str:
    return f"social-account-api:instagram:{str(account_id or '').strip()}"


def save_credential(
    *, account_id: str, user_id: int, platform_user_id: str, access_token: str,
    scopes: tuple[str, ...], expires_in: int,
) -> None:
    now = int(time.time())
    try:
        ciphertext = encrypt_secret(user_id, _token_purpose(account_id), access_token)
    except PasswordVaultError as exc:
        raise InstagramApiError("密码保险库不可用，无法安全保存 Instagram 授权。") from exc
    with db() as conn:
        conn.execute(
            "DELETE FROM social_account_api_credentials "
            "WHERE user_id = ? AND platform = 'instagram' AND platform_user_id = ? AND account_id <> ?",
            (user_id, platform_user_id, account_id),
        )
        conn.execute(
            """
            INSERT INTO social_account_api_credentials(
              account_id, user_id, platform, platform_user_id, access_token_ciphertext,
              token_type, scope_json, expires_at, status, last_sync_at, last_error,
              created_at, updated_at
            ) VALUES (?, ?, 'instagram', ?, ?, 'bearer', ?, ?, 'active', 0, '', ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
              user_id=excluded.user_id, platform='instagram', platform_user_id=excluded.platform_user_id,
              access_token_ciphertext=excluded.access_token_ciphertext, token_type=excluded.token_type,
              scope_json=excluded.scope_json, expires_at=excluded.expires_at,
              status='active', last_error='', updated_at=excluded.updated_at
            """,
            (
                account_id, user_id, platform_user_id, ciphertext, json.dumps(scopes),
                now + max(0, int(expires_in or 0)), now, now,
            ),
        )


def sync_account(account_id: str, user_id: int) -> dict[str, Any]:
    with db() as conn:
        credential = conn.execute(
            "SELECT * FROM social_account_api_credentials "
            "WHERE account_id = ? AND user_id = ? AND platform = 'instagram'",
            (account_id, user_id),
        ).fetchone()
    if not credential or str(credential["status"] or "") != "active":
        raise InstagramApiError("该 Instagram 账号尚未完成 API 授权。")
    try:
        token = decrypt_secret(user_id, _token_purpose(account_id), str(credential["access_token_ciphertext"] or ""))
        data = collect_account_data(token)
    except (PasswordVaultError, InstagramApiError) as exc:
        with db() as conn:
            conn.execute(
                "UPDATE social_account_api_credentials SET last_error = ?, updated_at = ? WHERE account_id = ?",
                (str(exc)[:1000], int(time.time()), account_id),
            )
        raise InstagramApiError(str(exc)) from exc
    data["normalized"]["accountId"] = account_id
    data["normalized"]["platformUserId"] = str(credential["platform_user_id"] or "")
    now = int(time.time())
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_api_snapshots(account_id, user_id, platform, data_json, refreshed_at, created_at, updated_at)
            VALUES (?, ?, 'instagram', ?, ?, ?, ?)
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
