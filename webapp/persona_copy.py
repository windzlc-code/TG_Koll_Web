"""Public profile extraction helpers for the persona copy-create flow.

This module deliberately uses anonymous HTTP only.  It does not read browser
profiles, cookies, session ids, or any of the social account bindings used by
the publishing flows.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit

import requests


ALLOWED_HOSTS = {
    "instagram.com",
    "threads.com",
    "threads.net",
    "www.instagram.com",
    "www.threads.com",
    "www.threads.net",
}
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_POSTS = 12
MAX_TEXT_LENGTH = 2_000
MAX_REDIRECTS = 3


class PublicPersonaProfileError(Exception):
    """A safe, user-facing error while reading a public profile page."""

    def __init__(self, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class _PublicPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.meta: dict[str, str] = {}
        self.script_parts: list[tuple[str, str]] = []
        self._in_title = False
        self._in_script = False
        self._script_type = ""
        self._script_name = ""
        self._script_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {str(key).lower(): str(value or "") for key, value in attrs}
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = attrs_map.get("property") or attrs_map.get("name")
            content = attrs_map.get("content")
            if key and content:
                self.meta[key.strip().lower()] = content.strip()
        elif tag == "script":
            self._in_script = True
            self._script_type = attrs_map.get("type", "").lower()
            self._script_name = attrs_map.get("id", "").lower()
            self._script_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        elif tag == "script":
            if self._in_script:
                script = "".join(self._script_parts).strip()
                if script:
                    self.script_parts.append((self._script_type or self._script_name, script))
            self._in_script = False
            self._script_type = ""
            self._script_name = ""
            self._script_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        if self._in_script:
            self._script_parts.append(data)


def _clean_text(value: object, *, limit: int = MAX_TEXT_LENGTH) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _host_allowed(host: str) -> bool:
    return str(host or "").strip().lower().rstrip(".") in ALLOWED_HOSTS


def _validate_public_url(value: object) -> str:
    raw = str(value or "").strip()
    if len(raw) > 2_000:
        raise PublicPersonaProfileError("链接过长，请填写 Threads 或 Instagram 的公开用户主页链接。")
    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        raise PublicPersonaProfileError("用户链接格式不正确，请填写完整的公开主页 URL。") from exc
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise PublicPersonaProfileError("请填写以 http:// 或 https:// 开头的公开主页链接。")
    if parts.username or parts.password:
        raise PublicPersonaProfileError("用户链接不能包含账号密码信息。")
    try:
        port = parts.port
    except ValueError as exc:
        raise PublicPersonaProfileError("用户链接端口不受支持。") from exc
    if port not in {None, 80, 443} or not _host_allowed(parts.hostname):
        raise PublicPersonaProfileError("当前仅支持 Threads 和 Instagram 的公开用户主页链接。")
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.hostname.lower(), path, parts.query, ""))


def normalize_public_persona_url(value: object) -> str:
    """Return the canonical URL accepted by the anonymous public fetcher."""

    return _validate_public_url(value)


def _redirect_url(response: object) -> str:
    headers = getattr(response, "headers", {}) or {}
    location = str(headers.get("Location") or headers.get("location") or "").strip()
    return location


def _fetch_html(url: str) -> tuple[str, str]:
    current = _validate_public_url(url)
    for _ in range(MAX_REDIRECTS + 1):
        try:
            response = requests.get(
                current,
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "User-Agent": "Mozilla/5.0 (compatible; VectoPublicPersona/1.0)",
                },
                timeout=(8, 20),
                allow_redirects=False,
                stream=True,
            )
        except requests.RequestException as exc:
            raise PublicPersonaProfileError("公开页面暂时无法访问，请检查链接后重试。", status_code=502) from exc
        try:
            status_code = int(getattr(response, "status_code", 0) or 0)
            if status_code in {301, 302, 303, 307, 308}:
                location = _redirect_url(response)
                if not location:
                    raise PublicPersonaProfileError("公开页面返回了无效的跳转地址。", status_code=502)
                from urllib.parse import urljoin

                current = _validate_public_url(urljoin(current, location))
                continue
            if status_code in {401, 403, 429}:
                raise PublicPersonaProfileError(
                    "该公开页面暂时拒绝自动访问，请稍后重试或换用可公开访问的主页链接。",
                    status_code=502,
                )
            if status_code < 200 or status_code >= 300:
                raise PublicPersonaProfileError(
                    f"公开页面返回 HTTP {status_code or '错误'}，请检查链接后重试。",
                    status_code=502,
                )
            content_type = str((getattr(response, "headers", {}) or {}).get("Content-Type") or "").lower()
            if content_type and "html" not in content_type and "text/" not in content_type:
                raise PublicPersonaProfileError("该链接不是可分析的公开网页。")
            chunks: list[bytes] = []
            total = 0
            iterator = getattr(response, "iter_content", None)
            if callable(iterator):
                for chunk in iterator(65_536):
                    if not chunk:
                        continue
                    chunk_bytes = bytes(chunk)
                    total += len(chunk_bytes)
                    if total > MAX_PAGE_BYTES:
                        raise PublicPersonaProfileError("公开页面过大，暂时无法分析。")
                    chunks.append(chunk_bytes)
            else:
                content = bytes(getattr(response, "content", b"") or b"")
                if len(content) > MAX_PAGE_BYTES:
                    raise PublicPersonaProfileError("公开页面过大，暂时无法分析。")
                chunks.append(content)
            encoding = str(getattr(response, "encoding", "") or "utf-8")
            try:
                html = b"".join(chunks).decode(encoding, errors="replace")
            except LookupError:
                html = b"".join(chunks).decode("utf-8", errors="replace")
            return html, current
        except requests.RequestException as exc:
            raise PublicPersonaProfileError("公开页面暂时无法访问，请检查链接后重试。", status_code=502) from exc
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
    raise PublicPersonaProfileError("公开页面跳转次数过多，请直接填写用户主页链接。", status_code=502)


def _json_candidates(raw: str) -> list[object]:
    text = str(raw or "").strip()
    if not text:
        return []
    candidates: list[object] = []
    try:
        candidates.append(json.loads(text))
        return candidates
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    decoder = json.JSONDecoder()
    attempts = 0
    for match in re.finditer(r"[\[{]", text):
        if attempts >= 20:
            break
        attempts += 1
        try:
            value, _ = decoder.raw_decode(text[match.start():])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        candidates.append(value)
    return candidates


def _walk_json(value: object, *, max_nodes: int = 4_000) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    pending: list[object] = [value]
    visited = 0
    while pending and visited < max_nodes:
        current = pending.pop()
        visited += 1
        if isinstance(current, dict):
            found.append(current)
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current[:200])
        elif isinstance(current, str) and len(current) <= 200_000:
            for candidate in _json_candidates(current)[:20]:
                if isinstance(candidate, (dict, list)):
                    pending.append(candidate)
    return found


def _first_value(node: dict[str, object], keys: tuple[str, ...]) -> object:
    lowered = {str(key).lower(): value for key, value in node.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None and (not isinstance(value, str) or value.strip()):
            return value
    return ""


def _nested_count(value: object) -> object:
    if isinstance(value, dict):
        return _first_value(value, ("count", "value", "total"))
    return value


def _metric(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = _clean_text(value, limit=64).replace(",", "").replace(" ", "")
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)([KMB万亿]?)", text, re.I)
    if not match:
        return None
    try:
        number = float(match.group(1))
    except ValueError:
        return None
    multiplier = match.group(2).lower()
    factor = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000, "万": 10_000, "亿": 100_000_000}.get(multiplier, 1)
    return max(0, int(number * factor))


def _profile_candidate(node: dict[str, object]) -> dict[str, object] | None:
    username = _clean_text(_first_value(node, ("username", "user_name", "screen_name", "handle")), limit=120)
    display_name = _clean_text(_first_value(node, ("full_name", "fullName", "display_name", "displayName", "name")), limit=160)
    bio = _clean_text(_first_value(node, ("biography", "bio", "description", "about", "headline")))
    followers = _metric(_nested_count(_first_value(node, ("followers", "follower_count", "followersCount", "edge_followed_by"))))
    following = _metric(_nested_count(_first_value(node, ("following", "following_count", "followingCount", "edge_follow"))))
    if not (username or display_name or bio or followers is not None or following is not None):
        return None
    score = int(bool(username)) * 3 + int(bool(bio)) * 4 + int(followers is not None) * 2 + int(following is not None)
    return {
        "score": score,
        "username": username,
        "display_name": display_name,
        "bio": bio,
        "followers": followers,
        "following": following,
    }


def _text_from_node(node: dict[str, object]) -> str:
    caption = _first_value(node, ("caption", "text", "content", "share_text", "title"))
    if isinstance(caption, dict):
        caption = _first_value(caption, ("text", "content", "body"))
    if isinstance(caption, list):
        caption = " ".join(_clean_text(item) for item in caption)
    if not isinstance(caption, (str, int, float)):
        nested = node.get("edge_media_to_caption")
        if isinstance(nested, dict):
            edges = nested.get("edges")
            if isinstance(edges, list) and edges and isinstance(edges[0], dict):
                nested_node = edges[0].get("node")
                if isinstance(nested_node, dict):
                    caption = _first_value(nested_node, ("text", "content"))
    return _clean_text(caption)


def _post_from_node(node: dict[str, object], username: str, platform: str) -> dict[str, object] | None:
    content = _text_from_node(node)
    url = _clean_text(_first_value(node, ("permalink", "permalink_url", "canonical_url", "url", "web_url")), limit=500)
    shortcode = _clean_text(_first_value(node, ("shortcode", "shortCode", "code", "pk")), limit=120)
    timestamp = _clean_text(_first_value(node, ("taken_at", "taken_at_timestamp", "created_at", "createdAt", "timestamp")), limit=80)
    if not content or not (url or shortcode or timestamp):
        return None
    if url and not re.match(r"^https?://", url, re.I):
        url = ""
    if not url and shortcode and platform == "instagram":
        url = f"https://www.instagram.com/p/{shortcode}/"
    if not url and shortcode and platform == "threads" and username:
        url = f"https://www.threads.com/@{username}/post/{shortcode}"
    return {"content": content, "url": url, "published_at": timestamp}


def _published_at_sort_value(value: object) -> float | None:
    """Return a sortable public post timestamp without guessing a missing date."""
    text = _clean_text(value, limit=80)
    if not text:
        return None
    try:
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            timestamp = float(text)
            # Platforms sometimes serialize Unix milliseconds instead of seconds.
            return timestamp / 1_000 if timestamp >= 10_000_000_000 else timestamp
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed.replace(tzinfo=timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def _extract_page_data(html: str, url: str) -> dict[str, object]:
    parser = _PublicPageParser()
    try:
        parser.feed(html)
    except Exception:
        # A partially rendered public page can still expose useful meta tags.
        pass
    host = str(urlsplit(url).hostname or "").lower()
    platform = "instagram" if "instagram" in host else "threads"
    json_nodes: list[dict[str, object]] = []
    for _script_type, script in parser.script_parts:
        for candidate in _json_candidates(script):
            json_nodes.extend(_walk_json(candidate))
    profiles = [candidate for node in json_nodes if (candidate := _profile_candidate(node))]
    profile = max(profiles, key=lambda item: int(item.get("score") or 0), default={})
    path_parts = [part for part in urlsplit(url).path.split("/") if part]
    path_username = ""
    for part in path_parts:
        if part.startswith("@"):
            path_username = part[1:]
            break
    if not path_username and path_parts:
        path_username = path_parts[0]
    username = str(profile.get("username") or path_username or "").strip().lstrip("@")
    meta = parser.meta
    display_name = str(profile.get("display_name") or "").strip()
    title = _clean_text("".join(parser.title_parts), limit=240)
    if not display_name:
        display_name = _clean_text(meta.get("og:title") or title, limit=160)
        display_name = re.sub(r"\s*[|·-]\s*(Threads|Instagram)\s*$", "", display_name, flags=re.I).strip()
    bio = str(profile.get("bio") or "").strip()
    if not bio:
        bio = _clean_text(meta.get("description") or meta.get("og:description"), limit=MAX_TEXT_LENGTH)
    posts: list[dict[str, object]] = []
    seen_posts: set[str] = set()
    for node in json_nodes:
        post = _post_from_node(node, username, platform)
        if not post:
            continue
        key = re.sub(r"\s+", " ", str(post.get("content") or "")).strip().lower()
        if key in seen_posts:
            continue
        seen_posts.add(key)
        posts.append(post)
    # The platform's JSON traversal order is not a chronology guarantee.  Sort
    # only after de-duplication, then apply the public sample cap so users see
    # the newest available samples rather than an arbitrary older subset.
    posts.sort(
        key=lambda post: (
            _published_at_sort_value(post.get("published_at")) is None,
            -(_published_at_sort_value(post.get("published_at")) or 0),
        )
    )
    posts = posts[:MAX_POSTS]
    if not (username or display_name or bio or posts):
        raise PublicPersonaProfileError("页面未提供可分析的公开简介或公开内容，请换用用户主页链接。")
    warnings: list[str] = []
    if not bio:
        warnings.append("页面未公开可识别的简介")
    if not posts:
        warnings.append("页面未公开可识别的近期文字内容")
    return {
        "platform": platform,
        "url": url,
        "username": username,
        "display_name": display_name or username,
        "bio": bio,
        "followers": profile.get("followers"),
        "following": profile.get("following"),
        "posts": posts,
        # The public page is progressively rendered by the platform.  Keep the
        # actual count beside the extraction cap so callers never mistake a
        # short anonymous response for a deliberate four-post analysis limit.
        "sample_count": len(posts),
        "sample_limit": MAX_POSTS,
        "source": "public_http",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "warnings": warnings,
    }


def fetch_public_persona_profile(url: str) -> dict[str, object]:
    """Fetch and normalize public profile text without authentication."""

    html, final_url = _fetch_html(url)
    return _extract_page_data(html, final_url)


def build_persona_copy_prompt(source: dict[str, object], requested_name: str = "") -> str:
    """Build a bounded prompt for the existing persona profile generator."""

    platform = _clean_text(source.get("platform"), limit=32)
    display_name = _clean_text(source.get("display_name"), limit=160)
    username = _clean_text(source.get("username"), limit=120)
    bio = _clean_text(source.get("bio"), limit=MAX_TEXT_LENGTH)
    posts = source.get("posts") if isinstance(source.get("posts"), list) else []
    sample_count = sum(1 for post in posts if isinstance(post, dict) and _clean_text(post.get("content"), limit=MAX_TEXT_LENGTH))
    lines = [
        "请根据下面从公开网页匿名抓取的资料，生成一个可编辑、可执行的中文社媒人设档案。",
        "资料只代表公开页面当时可见内容，不要声称这是原用户本人，也不要补写未提供的私人事实。",
        "请综合判断身份定位、受众、核心兴趣、内容支柱、表达语气、叙事视角、常用结构、边界和可持续选题。",
        "输出应详细、具体、适合后续生成社媒内容；优先使用事实可支持的结论，并把不确定处写成待确认项。",
        (
            f"本次匿名公开页面实际只提供 {sample_count} 条文字样本（系统上限 {MAX_POSTS} 条），"
            "这不是账号完整历史。样本不足时不得把推断写成已证实的个人事实。"
        ),
        f"目标人设名称：{_clean_text(requested_name, limit=160) or display_name or username or '复制创建人设'}",
        f"来源平台：{platform}",
        f"来源用户名：@{username}" if username else "来源用户名：未识别",
        f"来源公开链接：{_clean_text(source.get('url'), limit=500)}",
        f"公开显示名：{display_name or '未识别'}",
        f"公开简介：{bio or '未识别'}",
        f"公开粉丝数：{source.get('followers') if source.get('followers') is not None else '未识别'}",
        f"公开关注数：{source.get('following') if source.get('following') is not None else '未识别'}",
        "公开文字内容样本：",
    ]
    for index, post in enumerate(posts[:MAX_POSTS], start=1):
        if not isinstance(post, dict):
            continue
        content = _clean_text(post.get("content"), limit=MAX_TEXT_LENGTH)
        if content:
            lines.append(f"{index}. {content}")
    if not posts:
        lines.append("暂无可识别的公开文字内容。")
    return "\n".join(lines)[:24_000]
