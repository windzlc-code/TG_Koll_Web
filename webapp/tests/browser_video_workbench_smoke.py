from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


MODULES = [
    "digital_human_video",
    "ecommerce_short_video",
    "video_language_replace",
    "video_subject_replace",
    "ecommerce_image",
    "subject_replace",
    "poster_translate",
    "subject_generate",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Browser smoke test for the integrated video workbench.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--screenshot-dir", default="")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    screenshot_dir = Path(args.screenshot_dir).resolve() if args.screenshot_dir else None
    if screenshot_dir:
        screenshot_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        login = context.request.post(
            f"{base_url}/api/auth/portal-login",
            data={
                "username": "browseradmin",
                "password": "BrowserSmoke-2026!",
                "remember_me": False,
                "force_takeover": False,
            },
        )
        assert login.ok, f"admin login failed: {login.status} {login.text()}"

        page.goto(
            f"{base_url}/admin-console.html?view=video_workspace&video_module=digital_human_video",
            wait_until="networkidle",
        )
        page.locator("#videoWorkbenchRoot .video-workbench-shell").wait_for(state="visible")
        assert page.locator('[data-view="video_workspace"]').count() == 1
        announcement = page.locator("[data-site-notification-broadcast]")
        if announcement.count() and announcement.first.is_visible():
            announcement.locator(".site-notification-broadcast-confirm").click()
        if screenshot_dir:
            page.screenshot(path=str(screenshot_dir / "video-workbench-desktop.png"), full_page=True)

        discovered = page.locator("[data-video-module]").evaluate_all(
            "nodes => [...new Set(nodes.map(node => node.dataset.videoModule))]"
        )
        assert discovered == MODULES, f"unexpected module navigation: {discovered}"
        sidebar_boxes = page.locator("#videoModuleMenu [data-video-module]").evaluate_all(
            "nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width }; })"
        )
        assert len(sidebar_boxes) == 8
        assert max(abs(box["x"] - sidebar_boxes[0]["x"]) for box in sidebar_boxes) < 2, sidebar_boxes
        assert min(box["width"] for box in sidebar_boxes) > 140, sidebar_boxes
        assert all(sidebar_boxes[index]["y"] < sidebar_boxes[index + 1]["y"] for index in range(7)), sidebar_boxes

        for module_id in MODULES:
            page.locator(f'[data-video-module="{module_id}"]').first.click(force=True)
            page.locator(f'form[data-video-module-form="{module_id}"]').wait_for(state="visible")
            query = parse_qs(urlparse(page.url).query)
            assert query.get("view") == ["video_workspace"]
            assert query.get("video_module") == [module_id]

        page.locator('[data-video-module="video_subject_replace"]').first.click(force=True)
        assert page.locator('[data-video-field="subject_kind"]').count() == 1
        page.locator('[data-video-field="subject_kind"]').select_option("product")
        assert page.locator('[data-video-field="subject_kind"]').input_value() == "product"

        page.locator('[data-video-module="subject_generate"]').first.click(force=True)
        assert page.locator('[data-video-field="mode"]').count() == 1
        page.locator('[data-video-choice-field="mode"][data-video-choice-value="three_view"]').click()
        assert page.locator('[data-video-field="mode"]').input_value() == "three_view"
        assert page.locator('[data-video-choice-field="mode"][data-video-choice-value="three_view"]').get_attribute("aria-checked") == "true"

        page.locator('[data-video-module="ecommerce_short_video"]').first.click(force=True)
        page.locator('[data-video-choice-field="content_mode"][data-video-choice-value="advertising"]').click()
        assert page.locator('[data-video-field="content_mode"]').input_value() == "advertising"
        assert page.locator("[data-video-storyboard]").count() == 0
        page.locator('[data-video-choice-field="content_mode"][data-video-choice-value="planting"]').click()
        assert page.locator('[data-video-field="content_mode"]').input_value() == "planting"
        assert page.locator("[data-video-storyboard]").count() == 1

        for module_id in ("digital_human_video", "ecommerce_short_video", "video_language_replace"):
            page.locator(f'[data-video-module="{module_id}"]').first.click(force=True)
            assert page.locator('[data-video-field="subtitles_enabled"]').count() == 1
            templates = page.locator('[data-video-field="subtitle_template"] option').count()
            assert templates == 4, f"{module_id} subtitle templates: {templates}"

        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(
            f"{base_url}/admin-console.html?view=video_workspace&video_module=digital_human_video",
            wait_until="networkidle",
        )
        page.locator("#videoWorkbenchRoot .video-workbench-shell").wait_for(state="visible")
        announcement = page.locator("[data-site-notification-broadcast]")
        if announcement.count() and announcement.first.is_visible():
            announcement.locator(".site-notification-broadcast-confirm").click()
        assert page.locator('[data-panel="video_workspace"]').is_visible()
        assert page.locator('#mobileTaskDock [data-workspace-view="video_workspace"]').count() == 1
        assert page.locator("#videoModuleMenu [data-video-module]").count() == 8
        if screenshot_dir:
            page.screenshot(path=str(screenshot_dir / "video-workbench-mobile.png"), full_page=True)

        assert not page_errors, f"uncaught page errors: {page_errors}"
        browser.close()

    print("video workbench browser smoke: passed (desktop + mobile, 8 modules, no task submission)")


if __name__ == "__main__":
    main()
