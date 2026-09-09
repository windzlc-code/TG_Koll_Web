from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

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
    admin_token = create_session(conn, int(admin["id"]), is_admin_session=True)

page_errors: list[str] = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844})
    context.add_cookies([
        {"name": ADMIN_SESSION_COOKIE, "value": admin_token, "url": base_url},
    ])
    page = context.new_page()
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(f"{base_url}/admin.html#admin-telegram")
    page.wait_for_load_state("networkidle")
    announcement = page.locator(".site-notification-broadcast-confirm")
    if announcement.count() and announcement.first.is_visible():
        announcement.first.click()
    page.locator('[data-tg-workbench-tab="console"]').click()
    panel = page.locator('[data-tg-workbench-panel="console"]')
    panel.locator("#tgTweetBotToken").wait_for(state="visible")
    assert panel.locator("#tgTweetContentSettingsEnabled").is_visible()
    assert panel.locator("#tgTweetWebUser").is_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.screenshot(path=str(screenshot_dir / "telegram-tweet-admin-mobile.png"), full_page=True)

    with db() as conn:
        conn.execute(
            "UPDATE sessions SET revoked_at = ?, revoke_reason = 'tg_ui_test_cleanup' WHERE token = ?",
            (int(__import__("time").time()), session_storage_token(admin_token)),
        )
    browser.close()

if page_errors:
    raise RuntimeError("Browser JavaScript errors: " + " | ".join(page_errors))

print("Telegram native tweet Bot admin panel passed at 390x844")
