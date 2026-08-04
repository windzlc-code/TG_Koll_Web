from __future__ import annotations

import argparse
import os
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
        browser_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "").strip()
        if not browser_path:
            chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            browser_path = str(chrome) if chrome.exists() else ""
        browser = playwright.chromium.launch(headless=True, executable_path=browser_path or None)
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
                "force_takeover": True,
            },
        )
        assert login.ok, f"admin login failed: {login.status} {login.text()}"

        page.goto(
            f"{base_url}/admin-console.html?view=video_workspace&video_module=digital_human_video",
            wait_until="networkidle",
        )
        page.locator("#videoWorkbenchRoot .video-workbench-shell").wait_for(state="visible")
        assert page.locator('[data-view="video_workspace"]').count() == 1
        form_handle = page.locator("#videoWorkbenchForm").element_handle()
        page.wait_for_timeout(5_500)
        assert page.evaluate(
            "form => form === document.querySelector('#videoWorkbenchForm')",
            form_handle,
        ), "quiet task polling replaced the entire video form and causes visible flicker"
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
        assert page.locator('[data-video-field="replace_mode"]').count() == 1
        page.locator('[data-video-choice-field="replace_mode"][data-video-choice-value="product"]').click()
        assert page.locator('[data-video-field="replace_mode"]').input_value() == "product"
        assert "目标商品图" in page.locator('[data-video-file-field="image"]').inner_text()

        page.locator('[data-video-module="subject_generate"]').first.click(force=True)
        assert page.locator('[data-video-field="subject_generate_mode"]').count() == 1
        page.locator('[data-video-choice-field="subject_generate_mode"][data-video-choice-value="product"]').click()
        assert page.locator('[data-video-field="subject_generate_mode"]').input_value() == "product"
        assert page.locator('[data-video-file-field="product"]').count() == 1
        assert page.locator('[data-video-field="character_gender"]').count() == 0

        page.locator('[data-video-module="ecommerce_short_video"]').first.click(force=True)
        assert page.locator('[data-video-field="ecommerce_video_mode"]').input_value() == "ad_video"
        assert page.locator('[data-video-field="ecommerce_ad_style"]').count() == 1
        page.locator('[data-video-choice-field="ecommerce_video_mode"][data-video-choice-value="seeding_video"]').click()
        assert page.locator('[data-video-field="ecommerce_video_mode"]').input_value() == "seeding_video"
        assert page.locator('[data-video-field="ecommerce_seeding_template"]').count() == 1
        assert page.locator('[data-video-file-field="video"]').count() == 1
        assert page.locator('[data-video-field="ecommerce_ad_style"]').count() == 0
        assert page.locator('button[type="submit"]').inner_text() == "生成种草视频"

        for module_id in ("digital_human_video", "ecommerce_short_video", "video_language_replace"):
            page.locator(f'[data-video-module="{module_id}"]').first.click(force=True)
            assert page.locator('[data-video-field="subtitles_enabled"]').count() == 0
            assert page.locator('[data-video-field="subtitle_template"]').count() == 0

        page.locator('[data-video-module="digital_human_video"]').first.click(force=True)
        assert page.locator('.video-voice-studio [data-video-field="target_language"]').count() == 1
        assert page.locator('.video-settings-panel [data-video-field="target_language"]').count() == 0
        page.locator('[data-video-choice-field="digital_human_content_mode"][data-video-choice-value="oral_broadcast"]').click()
        assert page.locator('[data-video-field="oral_target_duration_seconds"]').count() == 1
        assert page.locator('[data-video-field="digital_human_short_mode"]').count() == 0
        assert "场景图" in page.locator('[data-video-file-field="product"]').inner_text()
        layout_columns = page.locator(".video-original-layout").evaluate("node => getComputedStyle(node).gridTemplateColumns.split(' ').length")
        assert layout_columns == 2, layout_columns

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
        mobile_columns = page.locator(".video-original-layout").evaluate("node => getComputedStyle(node).gridTemplateColumns.split(' ').length")
        assert mobile_columns == 1, mobile_columns
        if screenshot_dir:
            page.screenshot(path=str(screenshot_dir / "video-workbench-mobile.png"), full_page=True)

        assert not page_errors, f"uncaught page errors: {page_errors}"
        browser.close()

    print("video workbench browser smoke: passed (desktop + mobile, 8 modules, no task submission)")


if __name__ == "__main__":
    main()
