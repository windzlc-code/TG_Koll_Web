from __future__ import annotations

import base64
import hashlib
import hmac
import mimetypes
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urlparse

import requests
from PIL import Image, ImageOps


PLATFORM_TYPES = {
    "threads": "THREADS",
    "instagram": "INSTAGRAM",
}

_OAUTH_ACCOUNT_SWITCH_PLATFORMS = frozenset({"instagram"})


def platform_supports_oauth_account_switch(platform: Any) -> bool:
    return str(platform or "").strip().lower() in _OAUTH_ACCOUNT_SWITCH_PLATFORMS


def platform_label(platform: Any) -> str:
    normalized = str(platform or "").strip().lower()
    return {"threads": "Threads", "instagram": "Instagram"}.get(normalized, normalized or "平台")

_VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}
_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
_IMAGE_LIMITS = {
    "threads": {
        "min_width": 320,
        "max_width": 1440,
        "max_bytes": 8 * 1024 * 1024,
        "min_aspect": 0.01,
        "max_aspect": 10.0,
    },
    "instagram": {
        "min_width": 0,
        "max_width": 1920,
        "max_bytes": 8 * 1024 * 1024,
        "min_aspect": 0.8,
        "max_aspect": 1.91,
    },
}
_TEXT_LIMITS = {
    "threads": 500,
    "instagram": 2200,
}
_REAUTH_MARKERS = (
    "error validating access token",
    "session has expired",
    "the session is invalid",
    "token expired",
    "token has expired",
    "access token has expired",
    "invalid oauth access token",
    "invalid access token",
    "cannot parse access token",
    "please reconnect",
    "reconnect your",
    "reconnect the account",
    "account is disconnected",
    "authorization has been revoked",
    "user has not authorized",
    "oauthexception",
    "requires re-authorization",
    "need to re-authenticate",
    "not authorized this application",
    "has not authorized application",
)


class BundleSocialError(RuntimeError):
    """A user-facing provider error with safe, persisted diagnostics."""

    def __init__(
        self,
        message: str,
        *,
        provider_http_status: int = 0,
        provider_error_code: str = "",
        provider_error_detail: str = "",
    ) -> None:
        super().__init__(message)
        self.provider_http_status = max(0, int(provider_http_status or 0))
        self.provider_error_code = str(provider_error_code or "").strip()[:120]
        self.provider_error_detail = str(provider_error_detail or "").strip()[:500]


class BundleReauthRequiredError(BundleSocialError):
    pass


def is_bundle_reauth_required(detail: Any, *, status_code: int = 0) -> bool:
    text = str(detail or "").casefold()
    if not text:
        return False
    return any(marker in text for marker in _REAUTH_MARKERS)


def _has_chinese(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in str(text or ""))


def _is_already_connected_error(detail: Any) -> bool:
    text = str(detail or "")
    folded = text.casefold()
    return (
        ("already has" in folded and "connected" in folded)
        or "please disconnect it first" in folded
        or ("已连接" in text and "账号" in text)
    )


def _localize_bundle_error(detail: str, *, status_code: int = 0) -> str:
    text = str(detail or "").strip()
    if _has_chinese(text):
        return text
    folded = text.casefold()
    connected = re.search(r"already has an?\s+([a-z0-9_]+)\s+account connected", folded)
    if connected or "please disconnect it first" in folded:
        raw_platform = str(connected.group(1) if connected else "").strip().lower()
        platform_name = {"threads": "Threads", "instagram": "Instagram"}.get(raw_platform, "该平台")
        return f"该授权工作区已连接 {platform_name} 账号，正在重新连接"
    if "social sets limit reached" in folded:
        limit_match = re.search(r"limit\s+is\s+(\d+)", text, flags=re.IGNORECASE)
        limit_text = f"（最多 {limit_match.group(1)} 个）" if limit_match else ""
        return f"平台授权账号集合已达上限{limit_text}，请完成已有授权后再试"
    if "unauthorized" in folded or "invalid api key" in folded or "invalid x-api-key" in folded:
        return "平台授权服务验证失败，请联系管理员"
    if "team not found" in folded:
        return "授权工作区不存在，请重新添加账号"
    if "not found" in folded:
        return "平台授权记录不存在，请重新授权"
    if "rate limit" in folded or "too many requests" in folded:
        return "平台授权请求过于频繁，请稍后再试"
    if "500" in folded and any(marker in folded for marker in ("character", "caption", "text", "limit")):
        return "Threads 正文不能超过 500 字，请缩短后再发。"
    if "2200" in folded and any(marker in folded for marker in ("character", "caption", "text", "limit")):
        return "Instagram 正文不能超过 2200 字，请缩短后再发。"
    media_error = _localize_media_limit_error(folded)
    if media_error:
        return media_error
    if folded in {"", "error", "failed", "bad request"}:
        return f"平台授权服务请求失败（HTTP {status_code}）" if status_code else "平台授权服务请求失败"
    if re.search(r"[A-Za-z]{4,}", text):
        return "平台未接受本次请求，请稍后重试"
    return text or (f"平台授权服务请求失败（HTTP {status_code}）" if status_code else "平台授权服务请求失败")


def _localize_media_limit_error(folded: str) -> str:
    text = str(folded or "")
    if not text:
        return ""
    looks_media = any(
        marker in text
        for marker in (
            "width",
            "height",
            "aspect",
            "ratio",
            "dimension",
            "resolution",
            "pixel",
            "image",
            "media",
            "jpeg",
            "jpg",
            "png",
            "webp",
            "video",
            "bitrate",
            "duration",
            "file size",
            "filesize",
            "too large",
            "too small",
            "8mb",
            "8 mb",
            "1440",
            "1920",
            "upload",
        )
    )
    if not looks_media:
        return ""
    if "1440" in text or ("width" in text and ("320" in text or "threads" in text)):
        return "图片宽度超出 Threads 限制（需 320-1440px），已阻止提交以免浪费额度。"
    if "1920" in text and ("width" in text or "instagram" in text):
        return "图片宽度超出 Instagram 限制（需不超过 1920px），已阻止提交以免浪费额度。"
    if "aspect" in text or "ratio" in text:
        return "图片比例不符合平台限制，已阻止提交以免浪费额度。"
    if any(marker in text for marker in ("too large", "file size", "filesize", "8mb", "8 mb", "25mb")):
        return "图片文件过大（需不超过 8MB），已阻止提交以免浪费额度。"
    if "duration" in text or "bitrate" in text:
        return "视频不符合平台限制，已阻止提交以免浪费额度。"
    return "图片或视频不符合平台限制，已阻止提交以免浪费额度。"


def _sanitize_bundle_provider_detail(detail: Any, *, api_key: str = "") -> str:
    text = str(detail or "").strip()
    if api_key:
        text = text.replace(str(api_key), "***")
    text = re.sub(
        r"(?i)\b(authorization|bearer|token|api[_-]?key)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=***",
        text,
    )
    return re.sub(r"\s+", " ", text).strip()[:500]


def _provider_error_code(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    nested_error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    for source in (payload, nested_error):
        for key in ("code", "errorCode", "error_code", "type"):
            value = str(source.get(key) or "").strip()
            if value:
                return value[:120]
    return ""


def _raise_bundle_error(
    detail: str,
    *,
    status_code: int = 0,
    provider_error_code: str = "",
) -> None:
    raw = _sanitize_bundle_provider_detail(detail)
    message = _localize_bundle_error(raw, status_code=status_code)
    diagnostic = {
        "provider_http_status": status_code,
        "provider_error_code": provider_error_code,
        "provider_error_detail": raw,
    }
    if is_bundle_reauth_required(raw, status_code=status_code):
        raise BundleReauthRequiredError(message, **diagnostic)
    raise BundleSocialError(message, **diagnostic)


def _is_image_path(path: str | Path) -> bool:
    return Path(path).suffix.lower() in _IMAGE_SUFFIXES


def _is_video_path(path: str | Path) -> bool:
    return Path(path).suffix.lower() in _VIDEO_SUFFIXES


def _image_limits_for(platform: str) -> dict[str, float]:
    return dict(_IMAGE_LIMITS.get(str(platform or "").strip().lower()) or {})


def _text_limit_for(platform: str) -> int:
    return int(_TEXT_LIMITS.get(str(platform or "").strip().lower()) or 0)


def _save_jpeg(image: Image.Image, dest: Path, max_bytes: int) -> None:
    rgb = image.convert("RGB")
    dest.parent.mkdir(parents=True, exist_ok=True)
    quality = 90
    limit = max(1, int(max_bytes or 0) or 8 * 1024 * 1024)
    while quality >= 40:
        rgb.save(dest, format="JPEG", quality=quality, optimize=True)
        if dest.stat().st_size <= limit:
            return
        quality -= 10
    rgb.save(dest, format="JPEG", quality=35, optimize=True)


def _geometry_meets_limits(width: int, height: int, limits: dict[str, float]) -> bool:
    if width <= 0 or height <= 0:
        return False
    min_width = int(limits.get("min_width") or 0)
    max_width = int(limits.get("max_width") or 0)
    if max_width and width > max_width:
        return False
    if min_width and width < min_width:
        return False
    aspect = width / float(height)
    min_aspect = float(limits.get("min_aspect") or 0)
    max_aspect = float(limits.get("max_aspect") or 0)
    if max_aspect and aspect > max_aspect + 1e-6:
        return False
    if min_aspect and aspect < min_aspect - 1e-6:
        return False
    return True


def _fit_image_to_limits(image: Image.Image, limits: dict[str, float]) -> Image.Image:
    fitted = ImageOps.exif_transpose(image)
    min_width = int(limits.get("min_width") or 0)
    max_width = int(limits.get("max_width") or 0)
    min_aspect = float(limits.get("min_aspect") or 0)
    max_aspect = float(limits.get("max_aspect") or 0)
    width, height = fitted.size
    if width <= 0 or height <= 0:
        raise BundleSocialError("图片损坏，无法发布")
    if max_width and width > max_width:
        ratio = max_width / float(width)
        fitted = fitted.resize((max_width, max(1, int(round(height * ratio)))), Image.Resampling.LANCZOS)
        width, height = fitted.size
    if min_width and width < min_width:
        ratio = min_width / float(width)
        fitted = fitted.resize((min_width, max(1, int(round(height * ratio)))), Image.Resampling.LANCZOS)
        width, height = fitted.size
    aspect = width / float(height)
    if max_aspect and aspect > max_aspect + 1e-6:
        target_height = max(1, int(round(width / max_aspect)))
        canvas = Image.new("RGB", (width, target_height), (255, 255, 255))
        canvas.paste(fitted.convert("RGB"), (0, max(0, (target_height - height) // 2)))
        fitted = canvas
        width, height = fitted.size
        aspect = width / float(height)
    if min_aspect and aspect < min_aspect - 1e-6:
        target_width = max(min_width or 1, int(round(height * min_aspect)))
        if max_width and target_width > max_width:
            scale = max_width / float(target_width)
            new_height = max(1, int(round(height * scale)))
            fitted = fitted.resize((max(1, int(round(width * scale))), new_height), Image.Resampling.LANCZOS)
            width, height = fitted.size
            target_width = max_width
        canvas = Image.new("RGB", (target_width, height), (255, 255, 255))
        canvas.paste(fitted.convert("RGB"), (max(0, (target_width - width) // 2), 0))
        fitted = canvas
    return fitted


def _image_needs_prepare(path: Path, limits: dict[str, float]) -> bool:
    max_bytes = int(limits.get("max_bytes") or 0)
    if max_bytes and path.stat().st_size > max_bytes:
        return True
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        width, height = image.size
    return not _geometry_meets_limits(width, height, limits)


def _write_compliant_jpeg(image: Image.Image, dest: Path, limits: dict[str, float]) -> None:
    max_bytes = int(limits.get("max_bytes") or 8 * 1024 * 1024)
    min_width = int(limits.get("min_width") or 0)
    max_width = int(limits.get("max_width") or 0)
    fitted = _fit_image_to_limits(image, limits).convert("RGB")
    floor_width = min_width or 320
    for _ in range(8):
        _save_jpeg(fitted, dest, max_bytes)
        if not dest.is_file():
            break
        with Image.open(dest) as saved:
            width, height = saved.size
        size_ok = dest.stat().st_size <= max_bytes
        geometry_ok = _geometry_meets_limits(width, height, limits)
        if size_ok and geometry_ok:
            return
        current_width, current_height = fitted.size
        next_width = max(floor_width, int(current_width * 0.85))
        if max_width:
            next_width = min(next_width, max_width)
        if next_width >= current_width:
            break
        ratio = next_width / float(current_width)
        fitted = fitted.resize(
            (next_width, max(1, int(round(current_height * ratio)))),
            Image.Resampling.LANCZOS,
        )
        fitted = _fit_image_to_limits(fitted, limits).convert("RGB")
    if dest.is_file():
        with Image.open(dest) as saved:
            width, height = saved.size
        if dest.stat().st_size <= max_bytes and _geometry_meets_limits(width, height, limits):
            return
    raise BundleSocialError("图片无法处理成平台要求的尺寸，请更换较小的图片后再发。")


def prepare_publish_media_paths(
    platform: str,
    media_paths: list[str] | None,
    *,
    logger: Any | None = None,
) -> list[str]:
    limits = _image_limits_for(platform)
    prepared: list[str] = []
    changed = 0
    for raw in media_paths or []:
        source = Path(str(raw or "")).expanduser()
        if not str(source):
            continue
        if _is_video_path(source) or not _is_image_path(source) or not limits:
            prepared.append(str(source))
            continue
        if not source.is_file():
            raise BundleSocialError(f"媒体文件不存在：{source.name}")
        try:
            needs_prepare = _image_needs_prepare(source, limits)
        except Exception as exc:
            raise BundleSocialError("图片无法读取，请更换文件后再发。") from exc
        if not needs_prepare:
            prepared.append(str(source))
            continue
        dest = source.with_name(f"{source.stem}.prepared-{str(platform or '').strip().lower() or 'media'}.jpg")
        try:
            with Image.open(source) as original:
                _write_compliant_jpeg(original, dest, limits)
        except BundleSocialError:
            raise
        except Exception as exc:
            raise BundleSocialError("图片无法按平台限制处理，请更换较小的图片后再发。") from exc
        with Image.open(dest) as saved:
            width, height = saved.size
        if not _geometry_meets_limits(width, height, limits):
            raise BundleSocialError("图片无法处理成平台要求的尺寸，请更换较小的图片后再发。")
        if int(limits.get("max_bytes") or 0) and dest.stat().st_size > int(limits["max_bytes"]):
            raise BundleSocialError("图片文件过大（需不超过 8MB），已阻止提交以免浪费额度。")
        prepared.append(str(dest))
        changed += 1
        if logger is not None:
            logger.log(
                "info",
                "bundle_publish_media_prepared",
                "已把图片处理成平台要求的尺寸，再提交发布。",
                {"source": source.name, "prepared": dest.name},
            )
    if changed and logger is not None:
        logger.log(
            "info",
            "bundle_publish_media_prepared",
            f"已处理 {changed} 张图片为平台规范尺寸，未提交原图。",
            {"changed": changed},
        )
    return prepared


def _instagram_post_content(*, text: str, upload_ids: list[str], media_paths: list[str] | None = None) -> dict[str, Any]:
    content: dict[str, Any] = {"text": str(text), "uploadIds": list(upload_ids)}
    paths = [str(path) for path in (media_paths or []) if str(path or "").strip()]
    video_count = sum(1 for path in paths if Path(path).suffix.lower() in _VIDEO_SUFFIXES)
    image_count = max(0, len(paths) - video_count)
    if len(upload_ids) == 1 and video_count == 1 and image_count == 0:
        content.update({"type": "REEL", "shareToFeed": True})
        return content
    content.update({"type": "POST", "autoFitImage": True})
    return content


def platform_type(platform: Any) -> str:
    normalized = str(platform or "").strip().lower()
    try:
        return PLATFORM_TYPES[normalized]
    except KeyError as exc:
        raise BundleSocialError(f"平台授权不支持：{normalized or '-'}") from exc


_RESOURCE_ID_KEYS = ("id", "postId", "commentId", "uploadId", "teamId", "importId")


def _signature_matches(left: str, right: str) -> bool:
    if not left or not right or len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


def verify_webhook_signature(*, raw_body: bytes, signature_header: str, secret: str) -> bool:
    secret_text = str(secret or "").strip()
    received = str(signature_header or "").strip()
    if not secret_text or not received or not raw_body:
        return False
    if received.lower().startswith("sha256="):
        received = received.split("=", 1)[1].strip()
    digest = hmac.new(secret_text.encode("utf-8"), raw_body, hashlib.sha256)
    hex_digest = digest.hexdigest()
    b64_digest = base64.b64encode(digest.digest()).decode("ascii")
    return (
        _signature_matches(received.lower(), hex_digest.lower())
        or _signature_matches(received, b64_digest)
    )


def _resource_id(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    for key in _RESOURCE_ID_KEYS:
        value = str(item.get(key) or "").strip()
        if value:
            return value
    return ""


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, dict) and not _resource_id(payload):
        for key in ("data", "result"):
            value = payload.get(key)
            if value is not None:
                return value
    return payload


def _connection_status_from_payload(payload: Any) -> bool | None:
    mapping = _first_mapping(payload)
    data = payload if isinstance(payload, dict) else mapping
    if not isinstance(data, dict):
        data = mapping
    for key in ("ok", "valid", "connected", "isConnected", "healthy"):
        if key in mapping:
            return bool(mapping.get(key))
        if key in data:
            return bool(data.get(key))
    status = str(mapping.get("status") or data.get("status") or "").strip().lower()
    if status in {"ok", "valid", "connected", "healthy", "active", "success", "ready"}:
        return True
    if status in {"expired", "disconnected", "invalid", "error", "failed", "revoked", "unauthorized"}:
        return False
    if mapping.get("deletedAt") or mapping.get("deleted_at") or data.get("deletedAt") or data.get("deleted_at"):
        return False
    if _resource_id(mapping) or str(mapping.get("username") or "").strip():
        return True
    return None


def _first_mapping(payload: Any) -> dict[str, Any]:
    value = _unwrap(payload)
    if isinstance(value, dict):
        if _resource_id(value):
            return value
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
            detail = _sanitize_bundle_provider_detail(detail, api_key=self.api_key)
            _raise_bundle_error(
                detail,
                status_code=int(response.status_code or 0),
                provider_error_code=_provider_error_code(payload),
            )
        return payload

    def get_social_account_analytics(self, *, team_id: str, platform: str) -> dict[str, Any]:
        payload = _unwrap(self._request(
            "GET",
            f"analytics/social-account?teamId={str(team_id)}&platformType={platform_type(platform)}",
        ))
        return payload if isinstance(payload, dict) else {}

    def create_team(self, name: str) -> str:
        item = _first_mapping(self._request("POST", "team/", json_body={"name": str(name)[:80]}))
        team_id = str(item.get("id") or item.get("teamId") or "").strip()
        if not team_id:
            raise BundleSocialError("平台授权服务未返回工作区编号")
        return team_id

    def _issue_connect_link(
        self,
        *,
        team_id: str,
        platform: str,
        redirect_url: str,
        disable_auto_login: bool = False,
        force_browser_oauth: bool | None = None,
    ) -> str:
        provider_type = platform_type(platform)
        body: dict[str, Any] = {
            "type": provider_type,
            "teamId": str(team_id),
            "redirectUrl": str(redirect_url),
        }
        if provider_type == "INSTAGRAM":
            body["instagramConnectionMethod"] = "INSTAGRAM"
            body["forceBrowserOAuth"] = True if force_browser_oauth is None else bool(force_browser_oauth)
        if disable_auto_login:
            body["disableAutoLogin"] = True
        item = _first_mapping(self._request("POST", "social-account/connect", json_body=body))
        url = str(item.get("url") or "").strip()
        if not url:
            raise BundleSocialError("平台授权服务未返回授权地址")
        return url

    def create_connect_link(
        self,
        *,
        team_id: str,
        platform: str,
        redirect_url: str,
        disable_auto_login: bool = False,
        force_browser_oauth: bool | None = None,
    ) -> str:
        try:
            return self._issue_connect_link(
                team_id=team_id,
                platform=platform,
                redirect_url=redirect_url,
                disable_auto_login=disable_auto_login,
                force_browser_oauth=force_browser_oauth,
            )
        except BundleSocialError as exc:
            if not _is_already_connected_error(exc):
                raise
            try:
                self.disconnect_social_account(team_id=team_id, platform=platform)
            except BundleSocialError:
                pass
            return self._issue_connect_link(
                team_id=team_id,
                platform=platform,
                redirect_url=redirect_url,
                disable_auto_login=disable_auto_login,
                force_browser_oauth=force_browser_oauth,
            )

    def inspect_social_account(self, *, team_id: str, platform: str) -> dict[str, Any]:
        try:
            account = self.find_social_account(team_id=team_id, platform=platform)
        except BundleSocialError:
            return {"valid": False, "reason": "missing"}
        if account.get("deletedAt") or account.get("deleted_at"):
            return {"valid": False, "reason": "disconnected", "account": account}
        live = self._probe_live_connection(team_id=team_id, platform=platform)
        if live is False:
            return {"valid": False, "reason": "expired", "account": account}
        return {"valid": True, "reason": "active" if live is True else "connected", "account": account}

    def _probe_live_connection(self, *, team_id: str, platform: str) -> bool | None:
        body = {"type": platform_type(platform), "teamId": str(team_id)}
        for path in ("social-account/connection-check", "social-account/refresh-profile"):
            try:
                payload = self._request("POST", path, json_body=body)
            except BundleReauthRequiredError:
                return False
            except BundleSocialError:
                continue
            status = _connection_status_from_payload(payload)
            if status is False:
                return False
            if status is True:
                return True
        return None

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
        media_paths: list[str] | None = None,
    ) -> dict[str, Any]:
        provider_type = platform_type(platform)
        content: dict[str, Any] = {"text": str(text), "uploadIds": list(upload_ids)}
        if provider_type == "INSTAGRAM":
            content = _instagram_post_content(text=text, upload_ids=upload_ids, media_paths=media_paths)
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
                if resource != "post" or _result_url(last):
                    return last
            if status in {"ERROR", "FAILED", "CANCELLED", "REJECTED", "DELETED"}:
                detail = str(last.get("error") or last.get("message") or "").strip()
                verbose = last.get("errorsVerbose")
                if isinstance(verbose, dict):
                    parts = [
                        str((item or {}).get("userFacingMessage") or (item or {}).get("errorMessage") or "").strip()
                        for item in verbose.values()
                        if isinstance(item, dict)
                    ]
                    detail = "；".join(part for part in parts if part) or detail
                _raise_bundle_error(detail or "平台操作失败")
            wait = getattr(cancel_event, "wait", None) if cancel_event is not None else None
            if callable(wait):
                wait(2.0)
            else:
                time.sleep(2.0)
        raise BundleSocialError("平台已接收任务，但在等待结果时超时")


def _result_thumbnail(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("thumbnail", "thumbnailUrl", "thumbnail_url", "previewUrl", "preview_url", "imageUrl", "image_url"):
            value = str(item.get(key) or "").strip()
            if value.startswith(("http://", "https://")):
                return value
        external = item.get("externalData")
        if isinstance(external, dict):
            for value in external.values():
                nested = _result_thumbnail(value)
                if nested:
                    return nested
        upload = item.get("upload")
        if isinstance(upload, dict):
            nested = _result_thumbnail(upload)
            if nested:
                return nested
        for key in ("data", "result", "published"):
            nested = _result_thumbnail(item.get(key))
            if nested:
                return nested
    if isinstance(item, list):
        for value in item:
            nested = _result_thumbnail(value)
            if nested:
                return nested
    return ""


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


def _set_bundle_assistance(
    context_control: Any,
    title: str,
    message: str,
    *,
    phase: str = "running",
    kind: str = "progress",
) -> None:
    if not isinstance(context_control, dict):
        return
    context_control["login_assistance_state"] = {
        "phase": str(phase or "running"),
        "kind": str(kind or "progress"),
        "title": str(title),
        "message": str(message),
        "updated_at": int(time.time()),
    }


def run_bundle_social_task(
    *,
    task: dict[str, Any],
    account: dict[str, Any],
    logger: Any,
    cancel_event: Any | None = None,
    context_control: Any | None = None,
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
        text_limit = _text_limit_for(platform)
        if text_limit and len(text) > text_limit:
            raise BundleSocialError(
                f"{platform_label(platform)} 正文不能超过 {text_limit} 字，当前 {len(text)} 字。请缩短后再发。"
            )
        upload_ids: list[str] = []
        try:
            resource_id = ""
            if media_paths:
                _set_bundle_assistance(context_control, "正在处理图片", "正在把图片处理成平台要求的尺寸，避免超限提交。")
                media_paths = prepare_publish_media_paths(platform, media_paths, logger=logger)
            for path in media_paths:
                if cancel_event is not None and callable(getattr(cancel_event, "is_set", None)) and cancel_event.is_set():
                    raise BundleSocialError("任务已取消")
                upload_ids.append(client.upload_file(team_id=team_id, path=path))
            logger.log("info", "bundle_publish_submit", "正在通过平台授权接口提交发布内容。", {"upload_count": len(upload_ids)})
            _set_bundle_assistance(context_control, "正在发布", "正在通过平台授权接口提交内容。")
            created = client.create_post(
                team_id=team_id,
                platform=platform,
                text=text,
                upload_ids=upload_ids,
                reference_key=task_id,
                media_paths=media_paths,
            )
            resource_id = _resource_id(created)
            if not resource_id:
                raise BundleSocialError("平台接口未返回发布任务编号")
            def _on_publish_poll(item: dict[str, Any]) -> None:
                _set_bundle_assistance(context_control, "正在发布", "正在确认平台发布结果。")
                logger.log(
                    "info",
                    "bundle_publish_status",
                    "正在确认平台发布结果。",
                    {"status": str(item.get("status") or "")},
                )

            completed = client.wait_for_result(
                resource="post",
                resource_id=resource_id,
                cancel_event=cancel_event,
                timeout_seconds=180,
                on_poll=_on_publish_poll,
            )
            url = _result_url(completed) or _result_url(created)
            thumbnail = _result_thumbnail(completed) or _result_thumbnail(created)
            proof_status = str(completed.get("status") or created.get("status") or "").strip().upper()
            if not url:
                raise BundleSocialError("平台已发布，但未返回可查询的帖子链接")
        except BundleSocialError as exc:
            logger.log(
                "error",
                "bundle_publish_error",
                "平台授权接口未接受发布请求。",
                {
                    "phase": "confirmation" if resource_id else "submit",
                    "upload_count": len(upload_ids),
                    "provider_http_status": int(getattr(exc, "provider_http_status", 0) or 0),
                    "provider_error_code": str(getattr(exc, "provider_error_code", "") or ""),
                    "provider_error_detail": str(getattr(exc, "provider_error_detail", "") or ""),
                },
            )
            _set_bundle_assistance(
                context_control,
                "发布未完成",
                str(exc),
                phase="error",
                kind="error",
            )
            raise
        logger.log(
            "info",
            "bundle_publish_complete",
            "平台授权发布已完成。",
            {
                "bundle_post_id": resource_id,
                "status": proof_status,
                "url": url,
                "thumbnail": thumbnail,
            },
        )
        if isinstance(context_control, dict) and thumbnail:
            context_control["login_assistance_state"] = {
                **(context_control.get("login_assistance_state") if isinstance(context_control.get("login_assistance_state"), dict) else {}),
                "screenshot_url": thumbnail,
                "permalink": url,
            }
        return {
            "ok": True,
            "provider": "bundle",
            "bundle_post_id": resource_id,
            "status": proof_status,
            "published_url": url,
            "url": url,
            "screenshot_url": thumbnail,
            "published": {
                "confirmed": True,
                "permalink": url,
                "url": url,
                "thumbnail": thumbnail,
                "screenshot_url": thumbnail,
                "bundle_post_id": resource_id,
                "status": proof_status,
                "raw": completed,
            },
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
    resource_id = _resource_id(created)
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
