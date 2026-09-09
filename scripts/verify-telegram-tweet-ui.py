from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from webapp.auth import ADMIN_SESSION_COOKIE, create_session, session_storage_token
from webapp.db import db


if os.getenv("TG_TWEET_UI_ALLOW_DB_MUTATION") != "1":
    raise RuntimeError("Set TG_TWEET_UI_ALLOW_DB_MUTATION=1 and use an isolated temporary database")
db_path = Path(os.getenv("APP_DB_PATH", "")).resolve()
temporary_root = Path(tempfile.gettempdir()).resolve()
if temporary_root not in db_path.parents:
    raise RuntimeError(f"Refusing to run UI verification outside the temporary directory: {db_path}")

base_url = os.getenv("TG_TWEET_UI_BASE_URL", "http://127.0.0.1:8877").rstrip("/")
screenshot_dir = Path(os.getenv("TG_TWEET_UI_SCREENSHOT_DIR", Path.cwd() / "artifacts"))
screenshot_dir.mkdir(parents=True, exist_ok=True)
with db() as conn:
    admin = conn.execute("SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1").fetchone()
    if not admin:
        raise RuntimeError("UI verification requires the seeded admin")
    conn.execute(
        "UPDATE users SET must_change_password = 0, password_expires_at = 0 WHERE id = ?",
        (int(admin["id"]),),
    )
    admin_token = create_session(conn, int(admin["id"]), is_admin_session=True)

page_errors: list[str] = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for viewport, suffix in [({"width": 1440, "height": 1000}, "desktop"), ({"width": 390, "height": 844}, "mobile")]:
        context = browser.new_context(viewport=viewport)
        context.add_cookies([
            {"name": ADMIN_SESSION_COOKIE, "value": admin_token, "url": base_url},
        ])
        auth_probe = context.request.get(f"{base_url}/api/admin/tg_settings")
        if auth_probe.status != 200:
            raise RuntimeError(
                f"Injected temporary admin session was rejected: HTTP {auth_probe.status} "
                f"{auth_probe.text()[:300]}"
            )
        page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        response = page.goto(f"{base_url}/admin.html#admin-telegram", wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=5_000)
        except PlaywrightTimeoutError:
            # The admin shell continuously polls notifications and may never
            # reach a global network-idle window. The panel readiness checks
            # below remain the authoritative render boundary.
            pass
        announcement = page.locator(".site-notification-broadcast-confirm")
        if announcement.count() and announcement.first.is_visible():
            announcement.first.click()

        video_tab = page.locator('[data-tg-workbench-tab="video"]')
        tweet_tab = page.locator('[data-tg-workbench-tab="console"]')
        if video_tab.count() != 1 or tweet_tab.count() != 1:
            request = response.request if response is not None else None
            redirects: list[str] = []
            while request is not None:
                redirects.append(request.url)
                request = request.redirected_from
            cookie_names = sorted(str(item.get("name") or "") for item in context.cookies())
            raise RuntimeError(
                f"Telegram workbench tabs missing at {page.url}; title={page.title()!r}; "
                f"status={response.status if response is not None else 'none'}; redirects={redirects}; cookies={cookie_names}"
            )
        video_tab.click()
        video_panel = page.locator('[data-tg-workbench-panel="video"]')
        video_panel.locator("#tgBotToken").wait_for(state="visible")
        video_headings = video_panel.locator(".admin-config-card-title").all_text_contents()
        video_headers = video_panel.locator("thead th").all_text_contents()
        video_actions = video_panel.locator(".admin-tg-inline-actions button").all_text_contents()
        video_panel.screenshot(path=str(screenshot_dir / f"telegram-video-admin-{suffix}.png"))

        tweet_tab.click()
        panel = page.locator('[data-tg-workbench-panel="console"]')
        panel.locator("#tgTweetBotToken").wait_for(state="visible")
        assert panel.locator("#tgTweetChatId").is_visible()
        assert panel.locator("#tgTweetContentSettingsEnabled").count() == 0
        assert panel.locator("#tgTweetWebUser").count() == 0
        assert panel.locator("#tgTweetPublicBaseUrl").count() == 0
        assert panel.locator("#btnClearTgTweetToken").count() == 0
        assert panel.locator(".admin-config-card-title").all_text_contents() == video_headings
        assert panel.locator("thead th").all_text_contents() == video_headers
        assert panel.locator(".admin-tg-inline-actions button").all_text_contents() == video_actions
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        panel.screenshot(path=str(screenshot_dir / f"telegram-tweet-admin-{suffix}.png"))
        context.close()

    with db() as conn:
        conn.execute(
            "UPDATE sessions SET revoked_at = ?, revoke_reason = 'tg_ui_test_cleanup' WHERE token = ?",
            (int(__import__("time").time()), session_storage_token(admin_token)),
        )
    browser.close()

if page_errors:
    raise RuntimeError("Browser JavaScript errors: " + " | ".join(page_errors))

print("Telegram tweet/video admin structures match at 1440x1000 and 390x844")
