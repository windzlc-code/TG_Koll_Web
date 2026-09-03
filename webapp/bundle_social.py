from __future__ import annotations

import mimetypes
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urlparse

import requests


PLATFORM_TYPES = {
    "threads": "THREADS",
    "instagram": "INSTAGRAM",
}


class BundleSocialError(RuntimeError):
    pass


def platform_type(platform: Any) -> str:
    normalized = str(platform or "").strip().lower()
    try:
        return PLATFORM_TYPES[normalized]
    except KeyError as exc:
        raise BundleSocialError(f"平台授权不支持：{normalized or '-'}") from exc


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, dict):
        for key in ("data", "result"):
            value = payload.get(key)
            if value is not None:
                return value
    return payload


def _first_mapping(payload: Any) -> dict[str, Any]:
    value = _unwrap(payload)
    if isinstance(value, dict):
        items = value.get("items")
        if isinstance(items, list):
            value = items
        else:
            return value
    if isinstance(value, list):
        return next((dict(item) for item in value if isinstance(item, dict)), {})
    return {}


class BundleSocialClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        api_base: str | None = None,
        timeout_seconds: float = 30,
        session: requests.Session | None = None,
    ) -> None:
        configured: dict[str, Any] = {}
        if api_key is None or api_base is None:
            try:
                from .bundle_social_config import resolve_configuration
                from .db import db

                with db() as conn:
                    configured = resolve_configuration(conn)
            except Exception as exc:
                if api_key is None:
                    raise BundleSocialError("平台授权配置暂时不可用，请联系管理员") from exc
        self.api_key = str(api_key if api_key is not None else configured.get("api_key") or os.getenv("BUNDLE_SOCIAL_API_KEY") or "").strip()
        if not self.api_key:
            raise BundleSocialError("平台授权服务尚未配置")
        self.api_base = str(
            api_base if api_base is not None else configured.get("api_base_url") or os.getenv("BUNDLE_SOCIAL_API_BASE") or "https://api.bundle.social/api/v1"
        ).strip().rstrip("/")
        self.timeout_seconds = max(3.0, float(timeout_seconds))
        self.session = session or requests.Session()

    def list_teams(self, *, limit: int = 1) -> dict[str, Any]:
        safe_limit = min(100, max(1, int(limit)))
        payload = _unwrap(self._request("GET", f"team/?limit={safe_limit}&offset=0"))
        if isinstance(payload, list):
            return {"items": payload, "count": len(payload)}
        if isinstance(payload, dict):
            items = payload.get("items") if isinstance(payload.get("items"), list) else []
            total = payload.get("total")
            return {
                "items": items,
                "count": int(total) if isinstance(total, (int, float)) else len(items),
            }
        return {"items": [], "count": 0}

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
    ) -> Any:
        try:
            response = self.session.request(
                method,
                f"{self.api_base}/{str(path or '').lstrip('/')}",
                headers={"x-api-key": self.api_key, "Accept": "application/json"},
                json=json_body,
                files=files,
                data=data,
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as exc:
            raise BundleSocialError("平台授权服务请求失败，请稍后重试") from exc
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not response.ok:
            detail = ""
            if isinstance(payload, dict):
                detail = str(payload.get("message") or payload.get("detail") or payload.get("error") or "").strip()
            if self.api_key and detail:
                detail = detail.replace(self.api_key, "***")
            if "social sets limit reached" in detail.casefold():
                limit_match = re.search(r"limit\s+is\s+(\d+)", detail, flags=re.IGNORECASE)
                limit_text = f"（最多 {limit_match.group(1)} 个）" if limit_match else ""
                detail = f"平台授权账号集合已达上限{limit_text}，请完成已有授权后再试"
            raise BundleSocialError(detail or f"平台授权服务请求失败（HTTP {response.status_code}）")
        return payload

    def create_team(self, name: str) -> str:
        item = _first_mapping(self._request("POST", "team/", json_body={"name": str(name)[:80]}))
        team_id = str(item.get("id") or item.get("teamId") or "").strip()
        if not team_id:
            raise BundleSocialError("平台授权服务未返回工作区编号")
        return team_id

    def create_connect_link(self, *, team_id: str, platform: str, redirect_url: str) -> str:
        provider_type = platform_type(platform)
        body: dict[str, Any] = {
            "type": provider_type,
            "teamId": str(team_id),
            "redirectUrl": str(redirect_url),
            "disableAutoLogin": True,
        }
        if provider_type == "INSTAGRAM":
            body["instagramConnectionMethod"] = "INSTAGRAM"
            body["forceBrowserOAuth"] = True
        item = _first_mapping(self._request("POST", "social-account/connect", json_body=body))
        url = str(item.get("url") or "").strip()
        if not url:
            raise BundleSocialError("平台授权服务未返回授权地址")
        return url

    def disconnect_social_account(self, *, team_id: str, platform: str) -> None:
        self._request(
            "DELETE",
            "social-account/disconnect",
            json_body={"type": platform_type(platform), "teamId": str(team_id)},
        )

    def find_social_account(self, *, team_id: str, platform: str) -> dict[str, Any]:
        provider_type = platform_type(platform)
        payload = self._request(
            "GET",
            f"social-account/by-type?type={provider_type}&teamId={str(team_id)}",
        )
        value = _unwrap(payload)
        if isinstance(value, dict) and isinstance(value.get("items"), list):
            value = value["items"]
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            if str(candidate.get("type") or "").upper() != provider_type:
                continue
            if str(candidate.get("teamId") or candidate.get("team_id") or "") != str(team_id):
                continue
            return dict(candidate)
        raise BundleSocialError("尚未检测到本次平台授权，请完成授权后重试")

    def upload_file(self, *, team_id: str, path: str | Path) -> str:
        file_path = Path(path).resolve()
        if not file_path.is_file():
            raise BundleSocialError(f"媒体文件不存在：{file_path.name}")
        mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        with file_path.open("rb") as handle:
            item = _first_mapping(
                self._request(
                    "POST",
                    "upload/",
                    files={"file": (file_path.name, handle, mime)},
                    data={"teamId": str(team_id)},
                )
            )
        upload_id = str(item.get("id") or item.get("uploadId") or "").strip()
        if not upload_id:
            raise BundleSocialError("平台授权服务未返回媒体编号")
        return upload_id

    def create_post(
        self,
        *,
        team_id: str,
        platform: str,
        text: str,
        upload_ids: list[str],
        reference_key: str,
    ) -> dict[str, Any]:
        provider_type = platform_type(platform)
        content: dict[str, Any] = {"text": str(text), "uploadIds": list(upload_ids)}
        if provider_type == "INSTAGRAM":
            content.update({"type": "POST", "autoFitImage": True})
        body = {
            "teamId": str(team_id),
            "title": str(text or "Vecto publish")[:120],
            "postDate": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": "SCHEDULED",
            "referenceKey": str(reference_key)[:128],
            "socialAccountTypes": [provider_type],
            "data": {provider_type: content},
        }
        return _first_mapping(self._request("POST", "post/", json_body=body))

    def create_comment(
        self,
        *,
        team_id: str,
        platform: str,
        text: str,
        internal_post_id: str = "",
        imported_post_id: str = "",
        internal_parent_comment_id: str = "",
        fetched_parent_comment_id: str = "",
    ) -> dict[str, Any]:
        provider_type = platform_type(platform)
        if fetched_parent_comment_id:
            return _first_mapping(
                self._request(
                    "POST",
                    "comment/",
                    json_body={
                        "teamId": str(team_id),
                        "fetchedParentCommentId": str(fetched_parent_comment_id),
                        "text": str(text),
                    },
                )
            )
        body: dict[str, Any] = {
            "teamId": str(team_id),
            "title": str(text or "Vecto comment")[:120],
            "postDate": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": "SCHEDULED",
            "socialAccountTypes": [provider_type],
            "text": str(text),
            "data": {provider_type: {"text": str(text)}},
        }
        if internal_post_id:
            body["internalPostId"] = str(internal_post_id)
        elif imported_post_id:
            body["importedPostId"] = str(imported_post_id)
        else:
            raise BundleSocialError("评论任务缺少 Bundle 帖子编号")
        if internal_parent_comment_id:
            body["internalParentCommentId"] = str(internal_parent_comment_id)
        return _first_mapping(self._request("POST", "comment/", json_body=body))

    def resolve_fetched_comment_id(
        self,
        *,
        team_id: str,
        social_account_id: str,
        platform: str,
        imported_post_id: str,
        target_text: str,
        cancel_event: Any | None = None,
    ) -> str:
        expected = " ".join(str(target_text or "").split()).casefold()
        if not expected:
            raise BundleSocialError("回复任务缺少目标评论内容")
        body = {
            "teamId": str(team_id),
            "importedPostId": str(imported_post_id),
            "socialAccountType": platform_type(platform),
        }
        started = _first_mapping(self._request("POST", "comment/import", json_body=body))
        import_id = str(started.get("id") or started.get("importId") or "").strip()
        if not import_id:
            raise BundleSocialError("平台未返回评论同步任务编号")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if cancel_event is not None and callable(getattr(cancel_event, "is_set", None)) and cancel_event.is_set():
                raise BundleSocialError("任务已取消")
            state = _first_mapping(self._request("GET", f"comment/import/{import_id}"))
            status = str(state.get("status") or "").upper()
            if status == "COMPLETED":
                break
            if status in {"FAILED", "SKIPPED"}:
                raise BundleSocialError(str(state.get("error") or "平台评论同步失败"))
            wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
            if callable(wait):
                wait(2.0)
            else:
                time.sleep(2.0)
        else:
            raise BundleSocialError("等待平台评论同步超时")
        query = urlencode(
            {
                "teamId": str(team_id),
                "importedPostId": str(imported_post_id),
                "platform": platform_type(platform),
                "socialAccountId": str(social_account_id),
                "limit": 200,
                "offset": 0,
            }
        )
        payload = _unwrap(self._request("GET", f"comment/import/comments?{query}"))
        items = payload.get("items") if isinstance(payload, dict) else []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            actual = " ".join(str(item.get("text") or "").split()).casefold()
            if actual == expected or (len(expected) >= 12 and expected in actual):
                fetched_id = str(item.get("id") or "").strip()
                if fetched_id:
                    return fetched_id
        raise BundleSocialError("未在当前授权账号的帖子中找到目标评论")

    def _imported_posts(self, *, team_id: str, platform: str) -> list[dict[str, Any]]:
        query = urlencode(
            {
                "teamId": str(team_id),
                "socialAccountType": platform_type(platform),
                "limit": 100,
                "offset": 0,
            }
        )
        payload = _unwrap(self._request("GET", f"post-history-import/posts?{query}"))
        rows = payload.get("posts") if isinstance(payload, dict) else []
        return [dict(item) for item in rows if isinstance(item, dict)]

    @staticmethod
    def _normalized_permalink(value: Any) -> str:
        parsed = urlparse(str(value or "").strip())
        host = parsed.netloc.lower().removeprefix("www.")
        path = parsed.path.rstrip("/")
        return f"{host}{path}" if host and path else ""

    def resolve_imported_post_id(
        self,
        *,
        team_id: str,
        social_account_id: str,
        platform: str,
        target_url: str,
        cancel_event: Any | None = None,
    ) -> str:
        target = self._normalized_permalink(target_url)
        if not target:
            raise BundleSocialError("评论目标链接无效")

        def find() -> str:
            for item in self._imported_posts(team_id=team_id, platform=platform):
                if str(item.get("socialAccountId") or "") != str(social_account_id):
                    continue
                if self._normalized_permalink(item.get("permalink")) == target:
                    return str(item.get("id") or "").strip()
            return ""

        imported_id = find()
        if imported_id:
            return imported_id
        started = _first_mapping(
            self._request(
                "POST",
                "post-history-import/",
                json_body={
                    "teamId": str(team_id),
                    "socialAccountType": platform_type(platform),
                    "count": 100,
                    "withAnalytics": False,
                    "importCarousels": True,
                    "surface": "ALL",
                },
            )
        )
        import_id = str(started.get("id") or "").strip()
        if not import_id:
            raise BundleSocialError("平台未返回帖子同步任务编号")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if cancel_event is not None and callable(getattr(cancel_event, "is_set", None)) and cancel_event.is_set():
                raise BundleSocialError("任务已取消")
            state = _first_mapping(self._request("GET", f"post-history-import/{import_id}"))
            status = str(state.get("status") or "").upper()
            if status == "COMPLETED":
                imported_id = find()
                if imported_id:
                    return imported_id
                break
            if status in {"FAILED", "RATE_LIMITED"}:
                raise BundleSocialError(str(state.get("error") or "平台帖子同步失败"))
            wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
            if callable(wait):
                wait(2.0)
            else:
                time.sleep(2.0)
        raise BundleSocialError("目标帖子不属于当前授权账号，或尚未被平台同步")

    def wait_for_result(
        self,
        *,
        resource: str,
        resource_id: str,
        cancel_event: Any | None = None,
        timeout_seconds: int = 90,
        on_poll: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + max(5, int(timeout_seconds))
        last: dict[str, Any] = {}
        while time.monotonic() < deadline:
            if cancel_event is not None and callable(getattr(cancel_event, "is_set", None)) and cancel_event.is_set():
                raise BundleSocialError("任务已取消")
            last = _first_mapping(self._request("GET", f"{resource}/{resource_id}"))
            if callable(on_poll):
                on_poll(last)
            status = str(last.get("status") or "").strip().upper()
            if status in {"POSTED", "PUBLISHED", "SUCCESS", "COMPLETED"}:
                return last
            if status in {"ERROR", "FAILED", "CANCELLED", "REJECTED"}:
                raise BundleSocialError(str(last.get("error") or last.get("message") or "平台操作失败"))
            wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
            if callable(wait):
                wait(2.0)
            else:
                time.sleep(2.0)
        raise BundleSocialError("平台已接收任务，但在等待结果时超时")


def _result_url(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("permalink", "url", "postUrl"):
            value = str(item.get(key) or "").strip()
            if value.startswith(("http://", "https://")):
                return value
        for key in ("externalData", "data", "result"):
            value = _result_url(item.get(key))
            if value:
                return value
        for value in item.values():
            nested = _result_url(value)
            if nested:
                return nested
    if isinstance(item, list):
        for value in item:
            nested = _result_url(value)
            if nested:
                return nested
    return ""


def run_bundle_social_task(
    *,
    task: dict[str, Any],
    account: dict[str, Any],
    logger: Any,
    cancel_event: Any | None = None,
) -> dict[str, Any]:
    task_type = str(task.get("task_type") or "").strip()
    platform = str(task.get("platform") or account.get("platform") or "").strip().lower()
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    team_id = str(account.get("external_team_id") or "").strip()
    social_account_id = str(account.get("external_account_id") or "").strip()
    if not team_id or not social_account_id:
        raise BundleSocialError("账号授权信息不完整，请重新授权")
    if task_type not in {"publish_post", "comment_post", "reply_comment"}:
        raise BundleSocialError("该操作尚未接入官方 API，已阻止回退到指纹浏览器")
    client = BundleSocialClient()
    task_id = str(task.get("id") or "")
    text = str(
        payload.get("caption")
        or payload.get("content")
        or payload.get("comment")
        or payload.get("reply")
        or payload.get("text")
        or ""
    ).strip()
    if task_type == "publish_post":
        media_paths = [str(value) for value in (payload.get("media_paths") or []) if str(value or "").strip()]
        if platform == "instagram" and not media_paths:
            raise BundleSocialError("Instagram 发布至少需要一份媒体素材")
        if not text and not media_paths:
            raise BundleSocialError("发布任务需要正文或媒体文件")
        upload_ids: list[str] = []
        for path in media_paths:
            if cancel_event is not None and callable(getattr(cancel_event, "is_set", None)) and cancel_event.is_set():
                raise BundleSocialError("任务已取消")
            upload_ids.append(client.upload_file(team_id=team_id, path=path))
        logger.log("info", "bundle_publish_submit", "正在通过平台授权接口提交发布内容。", {"upload_count": len(upload_ids)})
        created = client.create_post(
            team_id=team_id,
            platform=platform,
            text=text,
            upload_ids=upload_ids,
            reference_key=task_id,
        )
        resource_id = str(created.get("id") or created.get("postId") or "").strip()
        if not resource_id:
            raise BundleSocialError("平台接口未返回发布任务编号")
        completed = client.wait_for_result(
            resource="post",
            resource_id=resource_id,
            cancel_event=cancel_event,
            on_poll=lambda item: logger.log(
                "info",
                "bundle_publish_status",
                "正在确认平台发布结果。",
                {"status": str(item.get("status") or "")},
            ),
        )
        url = _result_url(completed) or _result_url(created)
        return {
            "ok": True,
            "provider": "bundle",
            "bundle_post_id": resource_id,
            "published": completed,
            "url": url,
        }

    internal_post_id = str(payload.get("bundle_post_id") or payload.get("internal_post_id") or "").strip()
    imported_post_id = str(payload.get("bundle_imported_post_id") or payload.get("imported_post_id") or "").strip()
    internal_parent_comment_id = str(payload.get("bundle_internal_parent_comment_id") or "").strip()
    fetched_parent_comment_id = str(payload.get("bundle_fetched_parent_comment_id") or "").strip()
    if not text:
        raise BundleSocialError("评论内容不能为空")
    if not internal_post_id and not imported_post_id:
        imported_post_id = client.resolve_imported_post_id(
            team_id=team_id,
            social_account_id=social_account_id,
            platform=platform,
            target_url=str(payload.get("target_url") or payload.get("post_url") or ""),
            cancel_event=cancel_event,
        )
    if task_type == "reply_comment" and not internal_parent_comment_id and not fetched_parent_comment_id:
        if not imported_post_id:
            raise BundleSocialError("回复历史评论需要先同步目标帖子")
        fetched_parent_comment_id = client.resolve_fetched_comment_id(
            team_id=team_id,
            social_account_id=social_account_id,
            platform=platform,
            imported_post_id=imported_post_id,
            target_text=str(payload.get("target_text") or ""),
            cancel_event=cancel_event,
        )
    logger.log("info", "bundle_comment_submit", "正在通过平台授权接口提交评论。", {})
    created = client.create_comment(
        team_id=team_id,
        platform=platform,
        text=text,
        internal_post_id=internal_post_id,
        imported_post_id=imported_post_id,
        internal_parent_comment_id=internal_parent_comment_id if task_type == "reply_comment" else "",
        fetched_parent_comment_id=fetched_parent_comment_id if task_type == "reply_comment" else "",
    )
    resource_id = str(created.get("id") or created.get("commentId") or "").strip()
    if not resource_id:
        raise BundleSocialError("平台接口未返回评论任务编号")
    completed = client.wait_for_result(
        resource="comment",
        resource_id=resource_id,
        cancel_event=cancel_event,
    )
    return {
        "ok": True,
        "provider": "bundle",
        "bundle_comment_id": resource_id,
        "comment": completed,
        "url": _result_url(completed) or _result_url(created),
    }
