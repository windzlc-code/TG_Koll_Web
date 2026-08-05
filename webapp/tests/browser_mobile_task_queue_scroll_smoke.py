from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


def task_rows(count: int = 50) -> list[dict[str, object]]:
    created_at = datetime.now(timezone.utc).isoformat()
    return [
        {
            "id": f"task_scroll_probe_{index:03d}",
            "type": "persona_post_image" if index % 2 == 0 else "persona_post_generation",
            "workflow_name": "persona_post_image" if index % 2 == 0 else "persona_post_generation",
            "status": "success",
            "created_at": created_at,
            "has_download": index % 2 == 0,
        }
        for index in range(count)
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Mobile task queue scroll and incremental-load smoke test.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8766")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    tasks = task_rows()

    with sync_playwright() as playwright:
        browser_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "").strip()
        if not browser_path:
            chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            browser_path = str(chrome) if chrome.exists() else ""
        browser = playwright.chromium.launch(headless=True, executable_path=browser_path or None)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            has_touch=True,
            is_mobile=True,
        )
        login = context.request.post(
            f"{base_url}/api/auth/portal-login",
            data={
                "username": "browseradmin",
                "password": "BrowserSmoke-2026!",
                "remember_me": False,
                "force_takeover": True,
            },
        )
        assert login.ok, f"admin login failed: {login.status} {login.text()}"
        context.route(
            "**/api/tasks*",
            lambda route: route.fulfill(status=200, content_type="application/json", json={"items": tasks}),
        )

        page = context.new_page()
        page.goto(f"{base_url}/admin-console.html?view=tasks", wait_until="domcontentloaded")
        page.locator('[data-task-queue-panel="regular"]').wait_for(state="visible")
        announcement = page.locator("[data-site-notification-broadcast]")
        if announcement.count() and announcement.first.is_visible():
            announcement.locator(".site-notification-broadcast-confirm").click()
        page.locator('[data-task-queue-panel="regular"]').click(force=True)
        page.locator(".task-table-inner--regular .task-row").first.wait_for(state="visible")

        queue = page.locator(".task-table-inner--regular")
        metrics = queue.evaluate(
            """node => {
              const style = getComputedStyle(node);
              return {
                overflowX: style.overflowX,
                overflowY: style.overflowY,
                maxHeight: style.maxHeight,
                clientHeight: node.clientHeight,
                scrollHeight: node.scrollHeight,
              };
            }"""
        )
        assert metrics["overflowX"] == "clip", metrics
        assert metrics["overflowY"] == "visible", metrics
        assert metrics["maxHeight"] == "none", metrics
        assert abs(metrics["scrollHeight"] - metrics["clientHeight"]) <= 1, metrics

        row = page.locator(".task-table-inner--regular .task-row").nth(2)
        box = row.bounding_box()
        assert box, "missing task row geometry"
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        before = page.evaluate("window.scrollY")
        page.mouse.wheel(0, 500)
        page.wait_for_function("before => window.scrollY > before", arg=before)

        page.evaluate("window.scrollTo(0, document.scrollingElement.scrollHeight)")
        page.wait_for_function("document.querySelectorAll('.task-table-inner--regular .task-row').length >= 40")
        page.evaluate("window.scrollTo(0, document.scrollingElement.scrollHeight)")
        page.wait_for_function("document.querySelectorAll('.task-table-inner--regular .task-row').length === 50")
        assert page.locator(".mobile-tweet-stream-footer.is-complete").count() == 1
        assert "50 / 共 50 条" in page.locator(".mobile-tweet-stream-footer").inner_text()

        browser.close()

    print("mobile task queue scroll smoke: passed (page scroll + 20/40/50 incremental load)")


if __name__ == "__main__":
    main()
