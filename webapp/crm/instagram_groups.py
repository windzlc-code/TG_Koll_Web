from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


INSTAGRAM_INBOX_URL = "https://www.instagram.com/direct/inbox/"
READ_TASK_TYPES = {
    "instagram_group_candidates_inspect",
    "instagram_recent_conversations_inspect",
    "instagram_conversation_controls_inspect",
    "instagram_group_members_inspect",
    "instagram_group_status_inspect",
}
WRITE_TASK_TYPES = {
    "instagram_group_create",
    "instagram_group_post",
    "instagram_group_settings_update",
    "instagram_group_members_add",
}
SUPPORTED_TASK_TYPES = READ_TASK_TYPES | WRITE_TASK_TYPES


def _with_legacy_aliases(result: dict[str, Any], aliases: Mapping[str, str]) -> dict[str, Any]:
    """Keep the old Node/camelCase contract during the native migration."""

    for canonical, legacy in aliases.items():
        if canonical in result:
            result[legacy] = result[canonical]
    return result


def clean_username(value: Any) -> str:
    username = str(value or "").strip().lstrip("@").lower()
    if not username or len(username) > 80 or not re.fullmatch(r"[a-z0-9._]+", username):
        return ""
    return username


def unique_usernames(values: Iterable[Any], *, limit: int) -> list[str]:
    result: list[str] = []
    for value in values:
        username = clean_username(value)
        if username and username not in result:
            result.append(username)
        if len(result) >= limit:
            break
    return result


def normalize_conversation_url(value: Any) -> str:
    raw = str(value or "").strip()
    try:
        parsed = urlparse(raw)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower()
    match = re.match(r"^/direct/t/([^/?#]+)/?", parsed.path or "", re.I)
    if parsed.scheme != "https" or host not in {"instagram.com", "www.instagram.com"} or not match:
        return ""
    thread_id = quote(match.group(1), safe="-_.")
    return f"https://www.instagram.com/direct/t/{thread_id}/"


def operation_contract(task_type: str) -> dict[str, Any]:
    clean = str(task_type or "").strip()
    if clean not in SUPPORTED_TASK_TYPES:
        raise ValueError(f"Unsupported Instagram group task type: {clean or 'unknown'}")
    return {
        "task_type": clean,
        "platform": "instagram",
        "write": clean in WRITE_TASK_TYPES,
        "max_retries": 0 if clean in WRITE_TASK_TYPES else 0,
        "requires_confirmation": clean in WRITE_TASK_TYPES,
    }


def validate_task_payload(task_type: str, payload: Mapping[str, Any], account: Mapping[str, Any]) -> dict[str, Any]:
    contract = operation_contract(task_type)
    expected_username = clean_username(
        payload.get("expected_username")
        or payload.get("expectedUsername")
        or account.get("username")
    )
    account_username = clean_username(account.get("username"))
    if not expected_username or expected_username != account_username:
        raise ValueError("Instagram group sender does not match the selected account.")
    if contract["requires_confirmation"] and payload.get("confirmed") is not True:
        raise ValueError("Explicit Instagram group action confirmation is required.")
    clean: dict[str, Any] = {
        "expected_username": expected_username,
        "confirmed": bool(payload.get("confirmed") is True),
    }
    if task_type in {
        "instagram_group_create",
        "instagram_group_candidates_inspect",
        "instagram_group_members_add",
        "instagram_group_members_inspect",
    }:
        source = payload.get("expected_members") if task_type == "instagram_group_members_inspect" else payload.get("members")
        if source is None and task_type == "instagram_group_members_inspect":
            source = payload.get("expectedMembers") or payload.get("members")
        if not isinstance(source, list):
            raise ValueError("Instagram group members must be a list.")
        limit = 20 if task_type == "instagram_group_members_inspect" else 10
        members = unique_usernames(source, limit=limit)
        if len(members) != len(source) or not members:
            raise ValueError("Instagram group members must be unique valid usernames.")
        if expected_username in members:
            raise ValueError("Instagram group members cannot include the sender account.")
        if task_type == "instagram_group_create" and len(members) < 2:
            raise ValueError("Instagram group creation requires at least two other members.")
        if task_type == "instagram_group_members_add" and len(members) > 3:
            raise ValueError("Instagram adds at most three members per approved batch.")
        clean["expected_members" if task_type == "instagram_group_members_inspect" else "members"] = members
        if task_type == "instagram_group_create" and payload.get("approved_members") is not None:
            approved_source = payload.get("approved_members")
            if not isinstance(approved_source, list) or not 2 <= len(approved_source) <= 10:
                raise ValueError("Instagram group approved members must contain two to ten usernames.")
            approved_members = unique_usernames(approved_source, limit=10)
            if len(approved_members) != len(approved_source) or expected_username in approved_members:
                raise ValueError("Instagram group approved members must be unique valid usernames and exclude the sender.")
            if approved_members[: len(members)] != members:
                raise ValueError("Instagram group initial members must match the approved member order.")
            clean["approved_members"] = approved_members
    if task_type in {
        "instagram_conversation_controls_inspect",
        "instagram_group_settings_update",
        "instagram_group_post",
        "instagram_group_members_add",
        "instagram_group_members_inspect",
        "instagram_group_status_inspect",
    }:
        target_url = normalize_conversation_url(payload.get("target_url") or payload.get("targetUrl"))
        if not target_url:
            raise ValueError("A valid Instagram Direct conversation URL is required.")
        clean["target_url"] = target_url
    if task_type == "instagram_group_create":
        message = str(payload.get("message") or payload.get("text") or "").strip()
        clean["message"] = message[:5000]
        media_paths = payload.get("media_paths") or ([] if not payload.get("mediaPath") else [payload.get("mediaPath")])
        if media_paths:
            if not isinstance(media_paths, list) or len(media_paths) > 1:
                raise ValueError("Instagram group creation accepts at most one media attachment.")
            clean["media_paths"] = [str(media_paths[0] or "").strip()]
    if task_type == "instagram_group_post":
        message = str(payload.get("message") or payload.get("text") or "").strip()
        clean["message"] = message[:5000]
        media_paths = payload.get("media_paths") or ([] if not payload.get("mediaPath") else [payload.get("mediaPath")])
        if media_paths:
            if not isinstance(media_paths, list) or len(media_paths) > 1:
                raise ValueError("Instagram group posts accept at most one media attachment.")
            clean["media_paths"] = [str(media_paths[0] or "").strip()]
        if not clean["message"] and not clean.get("media_paths"):
            raise ValueError("Instagram group post content is required.")
    if task_type == "instagram_group_settings_update":
        group_name = str(payload.get("group_name") or payload.get("groupName") or "").strip()
        if not group_name or len(group_name) > 100:
            raise ValueError("Instagram group name must contain 1 to 100 characters.")
        clean["group_name"] = group_name
        clean["photo_requested"] = bool(payload.get("photo_requested") or payload.get("photoRequested"))
    if task_type == "instagram_conversation_controls_inspect":
        clean["open_details"] = bool(payload.get("open_details") or payload.get("openDetails"))
        clean["open_name_editor"] = bool(payload.get("open_name_editor") or payload.get("openNameEditor"))
        clean["probe_draft"] = False
    if task_type == "instagram_group_status_inspect":
        clean["message"] = str(payload.get("message") or payload.get("text") or "").strip()[:5000]
    return clean


def _wait(page, milliseconds: int) -> None:
    try:
        page.wait_for_timeout(milliseconds)
    except Exception:
        time.sleep(max(milliseconds, 0) / 1000)


def _locator_visible(locator, timeout: int = 1000) -> bool:
    try:
        return bool(locator.is_visible(timeout=timeout))
    except Exception:
        return False


def _type_locator_text(page, locator, value: Any) -> None:
    locator.click(timeout=5000)
    page.keyboard.press("Control+A")
    page.keyboard.press("Backspace")
    for character in str(value or ""):
        page.keyboard.type(character)
        time.sleep(0.025)


def _click_first(locators: Iterable[Any], *, timeout: int = 3000) -> bool:
    for group in locators:
        try:
            count = min(int(group.count()), 20)
        except Exception:
            count = 1
        for index in range(count):
            try:
                target = group.nth(index) if count > 1 else group
                if not _locator_visible(target, timeout=700):
                    continue
                target.click(timeout=timeout)
                return True
            except Exception:
                continue
    return False


def _login_wall(page) -> bool:
    try:
        return bool(
            page.evaluate(
                r"""
                () => /\/accounts\/login/i.test(location.pathname) ||
                  (/Log in|\u767b\u5165|\u767b\u5f55/i.test(document.body?.innerText || '') &&
                   /Sign up|\u8a3b\u518a|\u6ce8\u518c/i.test(document.body?.innerText || ''))
                """
            )
        )
    except Exception:
        return False


def _open_new_message(page) -> bool:
    pattern = re.compile(r"New message|Compose|新訊息|新增訊息|撰寫|建立", re.I)
    return _click_first(
        [
            page.get_by_role("button", name=pattern),
            page.get_by_role("link", name=pattern),
            page.locator('[aria-label*="New message" i]'),
            page.locator('[aria-label*="新訊息"]'),
        ]
    )


def _open_details(page) -> bool:
    pattern = re.compile(r"Open the details pane of the chat|Chat information|對話資料|聊天資訊", re.I)
    return _click_first(
        [
            page.get_by_role("button", name=pattern),
            page.locator('[aria-label="Open the details pane of the chat"]'),
        ]
    )


def _recipient_search(page):
    selectors = (
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[placeholder*="搜尋"]',
        'input[placeholder*="搜索"]',
        'input[type="text"]',
    )
    for selector in selectors:
        try:
            group = page.locator(selector)
            for index in reversed(range(min(int(group.count()), 20))):
                target = group.nth(index)
                if _locator_visible(target, timeout=600):
                    return target
        except Exception:
            continue
    return None


def _candidate_evidence(page, username: str) -> dict[str, Any]:
    try:
        value = page.evaluate(
            r"""
            (candidate) => {
              const key = String(candidate || '').toLowerCase().replace(/^@/, '');
              const visible = (node) => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
              };
              const texts = [...document.querySelectorAll('[role="option"], [role="button"], label, a')]
                .filter(visible)
                .map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
              const matchedTexts = texts.filter((text) => text.toLowerCase().replace(/^@/, '').includes(key)).slice(0, 12);
              return {matchedTexts, sample: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900)};
            }
            """,
            username,
        )
        return dict(value) if isinstance(value, dict) else {"matchedTexts": [], "sample": ""}
    except Exception:
        return {"matchedTexts": [], "sample": ""}


def _select_recipient(page, username: str) -> bool:
    pattern = re.compile(rf"@?{re.escape(username)}", re.I)
    dialog = page.locator('[role="dialog"]').last
    scope = dialog if _locator_visible(dialog, timeout=500) else page
    selected = _click_first(
        [
            scope.get_by_role("option", name=pattern),
            scope.locator('div[role="option"]').filter(has_text=pattern),
            scope.get_by_role("checkbox", name=pattern),
            scope.get_by_text(username, exact=True),
        ],
        timeout=5000,
    )
    if not selected:
        return False
    _wait(page, 350)
    return True


def _conversation_links(page) -> list[dict[str, Any]]:
    try:
        value = page.evaluate(
            r"""
            () => {
              const result = [];
              const seen = new Set();
              for (const anchor of document.querySelectorAll('a[href*="/direct/t/"]')) {
                const url = anchor.href || anchor.getAttribute('href') || '';
                if (!url || seen.has(url)) continue;
                seen.add(url);
                let container = anchor;
                for (let depth = 0; depth < 5 && container?.parentElement; depth += 1) container = container.parentElement;
                const text = String(container?.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
                result.push({url, text, unread: /unread|new message|\u672a\u8b80|\u65b0\u8a0a\u606f/i.test(text)});
              }
              return result.slice(0, 20);
            }
            """
        )
    except Exception:
        value = []
    result: list[dict[str, Any]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        url = normalize_conversation_url(item.get("url"))
        if url:
            result.append({"url": url, "text": str(item.get("text") or "")[:500], "unread": bool(item.get("unread"))})
    return result


def _message_visible(page, message: str) -> bool:
    needle = re.sub(r"\s+", "", str(message or "").lower())[:96]
    if not needle:
        return True
    try:
        text = str(page.locator("body").inner_text(timeout=2000) or "")
    except Exception:
        return False
    return needle in re.sub(r"\s+", "", text.lower())


def _send_message(page, message: str, *, force_submit: bool = False) -> bool:
    if not message and not force_submit:
        return True
    composer = None
    if message:
        for selector in (
            'textarea[placeholder*="Message" i]',
            '[role="textbox"][contenteditable="true"]',
            'textarea',
        ):
            try:
                candidate = page.locator(selector).last
                if _locator_visible(candidate, timeout=900):
                    composer = candidate
                    break
            except Exception:
                continue
        if composer is None:
            return False
        try:
            _type_locator_text(page, composer, message)
        except Exception:
            return False
    if _click_first([page.get_by_role("button", name=re.compile(r"^(Send|傳送|发送|送出)$", re.I))]):
        return True
    if composer is None:
        return False
    try:
        composer.press("Enter")
        return True
    except Exception:
        return False


def _attach_media(page, media_path: str) -> bool:
    source = Path(str(media_path or "").strip()).resolve()
    if not source.is_file():
        return False
    for selector in ('input[type="file"][accept*="image" i]', 'input[type="file"]'):
        try:
            inputs = page.locator(selector)
            for index in range(min(int(inputs.count()), 12) - 1, -1, -1):
                try:
                    inputs.nth(index).set_input_files(str(source), timeout=10000)
                    return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def _visible_conversation_media_count(page) -> int:
    try:
        return max(
            int(
                page.evaluate(
                    r"""
                    () => [...document.querySelectorAll('main img, main video')].filter((node) => {
                      const rect = node.getBoundingClientRect();
                      const style = getComputedStyle(node);
                      const alt = String(node.getAttribute('alt') || '');
                      return rect.width >= 72 && rect.height >= 72 && style.display !== 'none' &&
                        style.visibility !== 'hidden' && !/profile picture|大頭貼照|头像/i.test(alt);
                    }).length
                    """
                )
            ),
            0,
        )
    except Exception:
        return 0


def _read_conversation_controls(page) -> dict[str, Any]:
    try:
        value = page.evaluate(
            r"""
            () => {
              const visible = (node) => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
              };
              const describe = (node) => ({
                tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || '',
                ariaLabel: node.getAttribute('aria-label') || '', placeholder: node.getAttribute('placeholder') || '',
                text: String(('value' in node ? node.value : node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 300),
                disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true'
              });
              const composers = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable="true"]')].filter(visible).map(describe).slice(0, 40);
              const controls = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible).map(describe).slice(0, 100);
              return {bodySample: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500), composers, controls};
            }
            """
        )
        return dict(value) if isinstance(value, dict) else {}
    except Exception:
        return {}


def _read_member_evidence(page, expected_username: str, expected_members: list[str]) -> dict[str, Any]:
    try:
        value = page.evaluate(
            r"""
            ({sender, expected}) => {
              const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
              const normalized = text.toLowerCase();
              const acceptedMembers = [];
              const acceptanceEvidence = [];
              for (const username of expected) {
                const key = String(username).toLowerCase().replace(/^@/, '');
                const patterns = [`${key} joined the chat`, `${key} accepted the invitation`, `${key} joined`, `${key} \u5df2\u52a0\u5165\u804a\u5929`, `${key} \u5df2\u63a5\u53d7\u9080\u8acb`];
                const matched = patterns.find((pattern) => normalized.includes(pattern));
                if (matched) { acceptedMembers.push(username); acceptanceEvidence.push({username, matchedText: matched}); }
              }
              const memberUsernames = new Set([String(sender).toLowerCase().replace(/^@/, '')]);
              for (const node of document.querySelectorAll('img[alt], a[href^="/"]')) {
                const textValue = `${node.getAttribute('alt') || ''} ${node.innerText || node.textContent || ''}`;
                for (const token of textValue.split(/\s+/)) {
                  const clean = token.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._]/g, '');
                  if (/^[a-z0-9._]{2,30}$/.test(clean)) memberUsernames.add(clean);
                }
              }
              return {memberUsernames: [...memberUsernames], acceptedMembers, acceptanceEvidence, sample: text.slice(-1200)};
            }
            """,
            {"sender": expected_username, "expected": expected_members},
        )
        return dict(value) if isinstance(value, dict) else {}
    except Exception:
        return {}


def run_instagram_group_task(
    *,
    page: Any,
    task: Mapping[str, Any],
    account: Mapping[str, Any],
    payload: Mapping[str, Any],
    screenshot_dir: str | Path,
    logger: Any,
    navigate: Callable[[Any, str, Any, str], Any],
    screenshot: Callable[..., str],
    submission_guard: Callable[[Callable[[], Any]], Any],
    unknown_error_factory: Callable[[str, str], Exception],
    manual_error_factory: Callable[[str, str, str], Exception],
    cancel_check: Callable[[], Any],
) -> dict[str, Any]:
    task_type = str(task.get("task_type") or "").strip()
    clean = validate_task_payload(task_type, payload, account)
    cancel_check()

    def shot(stage: str) -> str:
        return str(screenshot(page, Path(screenshot_dir), dict(task), stage, logger) or "")

    def go(url: str, stage: str) -> None:
        navigate(page, url, logger, stage)
        _wait(page, 1200)
        if _login_wall(page):
            evidence = shot(f"{stage}_login_expired")
            raise manual_error_factory(
                "Instagram login expired while operating Direct groups.",
                "cookie_expired",
                evidence,
            )

    if task_type == "instagram_recent_conversations_inspect":
        go(INSTAGRAM_INBOX_URL, "instagram_group_recent_inbox")
        conversations = _conversation_links(page)
        evidence = shot("instagram_group_recent_conversations")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "conversations": conversations, "count": len(conversations), "inspected_url": str(page.url or ""), "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "inspected_url": "inspectedUrl", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_candidates_inspect":
        go(INSTAGRAM_INBOX_URL, "instagram_group_candidates_inbox")
        if not _open_new_message(page):
            evidence = shot("instagram_group_new_message_unavailable")
            return {"ok": True, "results": [], "status": "unknown", "reason_code": "new_message_control_unavailable", "screenshot_path": evidence, "retryable": False}
        _wait(page, 700)
        results = []
        for username in clean["members"]:
            cancel_check()
            search = _recipient_search(page)
            if search is None:
                results.append({"username": username, "visible_match": None, "status": "unknown", "reason_code": "recipient_search_unavailable", "matched_texts": []})
                continue
            _type_locator_text(page, search, username)
            _wait(page, 900)
            evidence = _candidate_evidence(page, username)
            matched = [str(value)[:300] for value in evidence.get("matchedTexts", [])]
            results.append(_with_legacy_aliases(
                {"username": username, "visible_match": bool(matched), "status": "verified" if matched else "not_selectable", "matched_texts": matched, "sample": str(evidence.get("sample") or "")[:900]},
                {"visible_match": "visibleMatch", "matched_texts": "matchedTexts"},
            ))
            try:
                _type_locator_text(page, search, "")
            except Exception:
                pass
        evidence_path = shot("instagram_group_candidates_inspected")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "results": results, "inspected_url": str(page.url or ""), "screenshot_path": evidence_path, "retryable": False},
            {"expected_username": "expectedUsername", "inspected_url": "inspectedUrl", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_conversation_controls_inspect":
        go(clean["target_url"], "instagram_group_controls_open")
        if clean.get("open_details"):
            _open_details(page)
            _wait(page, 500)
        if clean.get("open_name_editor"):
            _click_first([page.get_by_role("button", name=re.compile(r"Change group name|更改群組名稱|更改群组名称", re.I))])
            _wait(page, 400)
        controls = _read_conversation_controls(page)
        evidence = shot("instagram_group_controls_inspected")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "target_url": clean["target_url"], "inspected_url": str(page.url or ""), "probe_filled": False, "probe_cleared": True, **controls, "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "target_url": "targetUrl", "inspected_url": "inspectedUrl", "probe_filled": "probeFilled", "probe_cleared": "probeCleared", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_create":
        go(INSTAGRAM_INBOX_URL, "instagram_group_create_inbox")
        before_urls = {item["url"] for item in _conversation_links(page)}
        if not _open_new_message(page):
            raise RuntimeError("Instagram new-message control was not available.")
        _wait(page, 700)
        initial_members = clean["members"][:3]
        deferred = [{"username": item, "reason": "deferred_after_initial_group_validation"} for item in clean["members"][3:]]
        selected: list[str] = []
        skipped: list[dict[str, str]] = []
        for username in initial_members:
            search = _recipient_search(page)
            if search is None:
                skipped.append({"username": username, "reason": "recipient_search_unavailable"})
                continue
            _type_locator_text(page, search, username)
            _wait(page, 900)
            if _select_recipient(page, username):
                selected.append(username)
            else:
                skipped.append({"username": username, "reason": "not_selectable"})
            try:
                _type_locator_text(page, search, "")
            except Exception:
                pass
        if len(selected) < 2:
            raise RuntimeError("Instagram group requires at least two selectable members.")
        create_controls = [
            page.get_by_role("button", name=re.compile(r"^(Chat|Next|Create|聊天|下一步|建立|完成)$", re.I)),
            page.locator('[role="button"]').filter(has_text=re.compile(r"^(Chat|Next|Create|聊天|下一步|建立|完成)$", re.I)),
        ]

        def create_click() -> bool:
            return _click_first(create_controls, timeout=5000)

        created = bool(submission_guard(create_click))
        if not created:
            raise RuntimeError("Instagram group creation control was not available.")
        _wait(page, 1500)
        target_url = normalize_conversation_url(str(page.url or ""))
        if not target_url:
            candidates = [item["url"] for item in _conversation_links(page) if item["url"] not in before_urls]
            target_url = candidates[0] if len(candidates) == 1 else ""
        if not target_url:
            evidence = shot("instagram_group_create_unknown")
            raise unknown_error_factory("Instagram group creation was submitted but no unique Direct conversation URL was proved.", evidence)
        message = str(clean.get("message") or "")
        media_paths = [str(item or "").strip() for item in clean.get("media_paths", []) if str(item or "").strip()]
        media_attached = False
        media_count_before = _visible_conversation_media_count(page)
        if media_paths:
            media_attached = _attach_media(page, media_paths[0])
            if not media_attached:
                raise RuntimeError("Instagram group initial media could not be attached.")
            _wait(page, 700)
        if message or media_attached:
            submitted = bool(submission_guard(lambda: _send_message(page, message, force_submit=media_attached)))
            _wait(page, 900)
            message_verified = _message_visible(page, message) if message else True
            media_verified = _visible_conversation_media_count(page) > media_count_before if media_attached else True
            if not submitted or not message_verified or not media_verified:
                evidence = shot("instagram_group_initial_message_unknown")
                raise unknown_error_factory("Instagram group was created but its initial post was not visibly confirmed.", evidence)
        evidence = shot("instagram_group_created")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "group_created": True, "expected_username": clean["expected_username"], "members": selected, "skipped_members": skipped, "deferred_members": deferred, "target_url": target_url, "inspected_url": str(page.url or ""), "media_attached": media_attached, "submitted": True, "verified": True, "screenshot_path": evidence, "retryable": False},
            {"group_created": "groupCreated", "expected_username": "expectedUsername", "skipped_members": "skippedMembers", "deferred_members": "deferredMembers", "target_url": "targetUrl", "inspected_url": "inspectedUrl", "media_attached": "mediaAttached", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_post":
        go(clean["target_url"], "instagram_group_post_open")
        message = str(clean.get("message") or "")
        media_paths = [str(item or "").strip() for item in clean.get("media_paths", []) if str(item or "").strip()]
        media_count_before = _visible_conversation_media_count(page)
        media_attached = False
        if media_paths:
            media_attached = _attach_media(page, media_paths[0])
            if not media_attached:
                raise RuntimeError("Instagram group post media could not be attached.")
            _wait(page, 700)
        submitted = bool(
            submission_guard(lambda: _send_message(page, message, force_submit=media_attached))
        )
        _wait(page, 900)
        message_verified = _message_visible(page, message) if message else True
        media_verified = _visible_conversation_media_count(page) > media_count_before if media_attached else True
        if not submitted or not message_verified or not media_verified:
            evidence = shot("instagram_group_post_unknown")
            raise unknown_error_factory(
                "Instagram group post was submitted but not visibly confirmed.",
                evidence,
            )
        evidence = shot("instagram_group_post_confirmed")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "target_url": clean["target_url"], "inspected_url": str(page.url or ""), "sent": True, "submitted": True, "verified": True, "media_attached": media_attached, "submit_evidence": "message_visible", "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "target_url": "targetUrl", "inspected_url": "inspectedUrl", "media_attached": "mediaAttached", "submit_evidence": "submitEvidence", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_settings_update":
        go(clean["target_url"], "instagram_group_settings_open")
        if not _open_details(page):
            raise RuntimeError("Instagram chat details were not available.")
        _wait(page, 500)
        if not _click_first([page.get_by_role("button", name=re.compile(r"Change group name|更改群組名稱|更改群组名称", re.I))]):
            raise RuntimeError("Instagram group-name editor was not available.")
        _wait(page, 400)
        name_input = page.locator('input[name="change-group-name"], input[aria-label="Group name"], input[aria-label="群組名稱"], input[aria-label="群组名称"]').last
        if not _locator_visible(name_input, timeout=1500):
            raise RuntimeError("Instagram group-name input was not visible.")
        _type_locator_text(page, name_input, clean["group_name"])

        def save_click() -> bool:
            return _click_first([page.get_by_role("button", name=re.compile(r"^(Save|儲存|保存)$", re.I))])

        submitted = bool(submission_guard(save_click))
        if not submitted:
            raise RuntimeError("Instagram group-name Save control was not available.")
        _wait(page, 900)
        visible = _message_visible(page, clean["group_name"])
        if not visible:
            evidence = shot("instagram_group_settings_unknown")
            raise unknown_error_factory("Instagram group-name update was submitted but not visibly confirmed.", evidence)
        evidence = shot("instagram_group_settings_updated")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "target_url": clean["target_url"], "group_name": clean["group_name"], "name_updated": True, "photo_update_supported": False, "photo_update_status": "not_available_on_instagram_computer_ui" if clean.get("photo_requested") else "not_requested", "inspected_url": str(page.url or ""), "submitted": True, "verified": True, "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "target_url": "targetUrl", "group_name": "groupName", "name_updated": "nameUpdated", "photo_update_supported": "photoUpdateSupported", "photo_update_status": "photoUpdateStatus", "inspected_url": "inspectedUrl", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_members_add":
        go(clean["target_url"], "instagram_group_members_add_open")
        if not _open_details(page):
            raise RuntimeError("Instagram chat details were not available.")
        _wait(page, 500)
        added: list[str] = []
        skipped: list[dict[str, str]] = []
        for username in clean["members"]:
            cancel_check()
            if not _click_first([page.get_by_role("button", name=re.compile(r"Add people|Add members|新增用戶|新增成员", re.I))]):
                raise RuntimeError("Instagram Add people control was not available.")
            _wait(page, 500)
            search = _recipient_search(page)
            if search is None:
                skipped.append({"username": username, "reason": "recipient_search_unavailable"})
                continue
            _type_locator_text(page, search, username)
            _wait(page, 800)
            if not _select_recipient(page, username):
                skipped.append({"username": username, "reason": "not_selectable"})
                continue

            def add_click() -> bool:
                return _click_first([page.get_by_role("button", name=re.compile(r"^(Next|Add|Done|下一步|新增|完成)$", re.I))])

            submitted = bool(submission_guard(add_click))
            if not submitted:
                raise RuntimeError("Instagram member Add control was not available.")
            _wait(page, 900)
            members = _read_member_evidence(page, clean["expected_username"], [username]).get("memberUsernames", [])
            if username not in {clean_username(item) for item in members}:
                evidence = shot(f"instagram_group_member_{username}_unknown")
                raise unknown_error_factory(f"Instagram member @{username} was submitted but is not visible in chat details.", evidence)
            added.append(username)
        evidence = shot("instagram_group_members_added")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "target_url": clean["target_url"], "added_members": added, "skipped_members": skipped, "warning": "" if added else "This member batch contained no selectable Instagram accounts", "inspected_url": str(page.url or ""), "submitted": bool(added), "verified": True, "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "target_url": "targetUrl", "added_members": "addedMembers", "skipped_members": "skippedMembers", "inspected_url": "inspectedUrl", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_members_inspect":
        go(clean["target_url"], "instagram_group_members_inspect_open")
        conversation_evidence = _read_member_evidence(page, clean["expected_username"], clean["expected_members"])
        details_opened = _open_details(page)
        _wait(page, 500)
        details_evidence = _read_member_evidence(page, clean["expected_username"], clean["expected_members"]) if details_opened else {}
        members = unique_usernames(details_evidence.get("memberUsernames", []), limit=50)
        accepted = unique_usernames(conversation_evidence.get("acceptedMembers", []), limit=20)
        evidence = shot("instagram_group_members_inspected")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "target_url": clean["target_url"], "member_usernames": members, "member_count": len(members), "accepted_members": accepted, "acceptance_evidence": conversation_evidence.get("acceptanceEvidence", []), "details_available": details_opened, "inspected_url": str(page.url or ""), "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "target_url": "targetUrl", "member_usernames": "memberUsernames", "member_count": "memberCount", "accepted_members": "acceptedMembers", "acceptance_evidence": "acceptanceEvidence", "details_available": "detailsAvailable", "inspected_url": "inspectedUrl", "screenshot_path": "screenshotPath"},
        )

    if task_type == "instagram_group_status_inspect":
        go(clean["target_url"], "instagram_group_status_open")
        controls = _read_conversation_controls(page)
        message = str(clean.get("message") or "")
        delivery_confirmed = _message_visible(page, message) if message else None
        sample = str(controls.get("bodySample") or "")
        read_confirmed = bool(re.search(r"(?:^|\s)(Seen|已讀|看過)(?:\s|$)", sample, re.I))
        evidence = shot("instagram_group_status_inspected")
        return _with_legacy_aliases(
            {"ok": True, "platform": "instagram", "expected_username": clean["expected_username"], "target_url": clean["target_url"], "delivery_confirmed": delivery_confirmed, "read_available": True, "read_confirmed": read_confirmed, "read_status": "viewed" if read_confirmed else "not_viewed", "inspected_url": str(page.url or ""), "sample": sample[:800], "screenshot_path": evidence, "retryable": False},
            {"expected_username": "expectedUsername", "target_url": "targetUrl", "delivery_confirmed": "deliveryConfirmed", "read_available": "readAvailable", "read_confirmed": "readConfirmed", "read_status": "readStatus", "inspected_url": "inspectedUrl", "screenshot_path": "screenshotPath"},
        )

    raise ValueError(f"Unhandled Instagram group task type: {task_type}")
