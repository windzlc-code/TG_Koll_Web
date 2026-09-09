from __future__ import annotations

import atexit
import os
import sys
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from webapp.auth import ADMIN_SESSION_COOKIE, SESSION_COOKIE, create_session, session_storage_token
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
test_username = f"tg_ui_{uuid.uuid4().hex[:10]}"

with db() as conn:
    admin = conn.execute("SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1").fetchone()
    if not admin:
        raise RuntimeError("UI verification requires the seeded admin")
    admin_token = create_session(conn, int(admin["id"]), is_admin_session=True)
    inserted = conn.execute(
        "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) "
        "VALUES (?,'x',0,0,'approved',1,1)",
        (test_username,),
    )
    user_id = int(inserted.lastrowid)
    user_token = create_session(conn, user_id)


def cleanup_test_identity() -> None:
    with db() as conn:
        conn.execute(
            "UPDATE sessions SET revoked_at = ?, revoke_reason = 'tg_ui_test_cleanup' WHERE token IN (?, ?)",
            (int(__import__("time").time()), session_storage_token(admin_token), session_storage_token(user_token)),
        )
        conn.execute("DELETE FROM users WHERE username = ?", (test_username,))


atexit.register(cleanup_test_identity)

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

    context.clear_cookies()
    context.add_cookies([{"name": SESSION_COOKIE, "value": user_token, "url": base_url}])
    page.goto(f"{base_url}/console.html?view=workspace&module=tweet_generation")
    page.wait_for_load_state("networkidle")
    active = page.locator('.mobile-task-dock-button[data-module="tweet_generation"]')
    active.wait_for(state="visible")
    assert "is-active" in str(active.get_attribute("class") or "")
    assert "module=" not in page.url
    page.screenshot(path=str(screenshot_dir / "telegram-tweet-console-deeplink-mobile.png"), full_page=True)
    browser.close()

if page_errors:
    raise RuntimeError("Browser JavaScript errors: " + " | ".join(page_errors))

print("Telegram tweet admin panel and console deep links passed at 390x844")
