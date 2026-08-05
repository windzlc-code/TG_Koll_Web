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
        assert page.locator('#videoWorkbenchRoot input[type="file"][required]').count() == 0
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

        whole_card_choosers = []
        page.on("filechooser", lambda chooser: whole_card_choosers.append(chooser))
        page.locator('[data-video-file-field="product"] .video-file-field-copy').click()
        page.wait_for_timeout(150)
        assert not whole_card_choosers, "clicking the upload card body opened the file picker"

        product_slots = page.locator('[data-video-file-field="product"] [data-video-file-slot]')
        assert product_slots.count() == 3
        resting_style = product_slots.nth(0).evaluate(
            "node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow, transform: style.transform }; }"
        )
        product_slots.nth(0).hover()
        hovered_style = product_slots.nth(0).evaluate(
            "node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow, transform: style.transform }; }"
        )
        assert hovered_style == resting_style, f"empty upload slot gained a false selected highlight: {resting_style} -> {hovered_style}"
        with page.expect_file_chooser() as chooser_info:
            product_slots.nth(1).click()
        chooser_info.value.set_files({"name": "slot-2.png", "mimeType": "image/png", "buffer": b"slot-2"})
        product_slots = page.locator('[data-video-file-field="product"] [data-video-file-slot]')
        assert product_slots.nth(0).get_attribute("data-video-file-filled") == "false"
        assert product_slots.nth(1).get_attribute("data-video-file-filled") == "true"
        assert "slot-2.png" in product_slots.nth(1).inner_text()

        with page.expect_file_chooser() as chooser_info:
            product_slots.nth(0).click()
        chooser_info.value.set_files({"name": "slot-1.png", "mimeType": "image/png", "buffer": b"slot-1"})
        product_slots = page.locator('[data-video-file-field="product"] [data-video-file-slot]')
        assert "slot-1.png" in product_slots.nth(0).inner_text()
        assert "slot-2.png" in product_slots.nth(1).inner_text()

        with page.expect_file_chooser() as chooser_info:
            product_slots.nth(1).click()
        chooser_info.value.set_files({"name": "slot-2-replaced.png", "mimeType": "image/png", "buffer": b"slot-2-new"})
        product_slots = page.locator('[data-video-file-field="product"] [data-video-file-slot]')
        assert "slot-1.png" in product_slots.nth(0).inner_text()
        assert "slot-2-replaced.png" in product_slots.nth(1).inner_text()
        if screenshot_dir:
            page.screenshot(path=str(screenshot_dir / "video-workbench-independent-slots.png"), full_page=False)

        shell_handle = page.locator("#videoWorkbenchRoot .video-workbench-shell").element_handle()
        form_panel_handle = page.locator("#videoWorkbenchRoot .video-form-panel").element_handle()
        task_panel_handle = page.locator("#videoWorkbenchRoot .video-task-panel").element_handle()
        switch_task_requests: list[str] = []
        page.on(
            "request",
            lambda request: switch_task_requests.append(urlparse(request.url).path)
            if urlparse(request.url).path in {"/api/video/tasks", "/api/tasks"}
            else None,
        )
        page.locator('#videoModuleMenu [data-video-module="ecommerce_short_video"]').click(force=True)
        page.locator('form[data-video-module-form="ecommerce_short_video"]').wait_for(state="visible")
        assert page.evaluate(
            "shell => shell === document.querySelector('#videoWorkbenchRoot .video-workbench-shell')",
            shell_handle,
        ), "sidebar module navigation replaced the whole workbench and causes visible flicker"
        assert page.evaluate(
            "panel => panel === document.querySelector('#videoWorkbenchRoot .video-form-panel')",
            form_panel_handle,
        ), "sidebar module navigation replaced the form panel container"
        assert page.evaluate(
            "panel => panel === document.querySelector('#videoWorkbenchRoot .video-task-panel')",
            task_panel_handle,
        ), "sidebar module navigation replaced the task panel instead of only the active operation"
        assert not switch_task_requests, f"module switch unexpectedly reloaded tasks: {switch_task_requests}"
        assert page.locator("#videoWorkbenchRoot .video-module-switcher").count() == 0

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
        assert page.locator('.video-voice-studio').count() == 0
        voice_source = page.locator('[data-video-file-field="audio"]')
        assert voice_source.count() == 1
        assert "参考音频/声音" in voice_source.inner_text()
        assert voice_source.locator('[data-video-open-voice]').count() == 1
        assert page.locator('[data-video-voice-modal]').count() == 0
        voice_source.locator('[data-video-open-voice]').click()
        page.locator('[data-video-voice-modal]').wait_for(state="visible")
        assert page.locator('[data-video-voice-modal] [data-video-field="target_language"]').count() == 1
        assert page.locator('.video-settings-panel [data-video-field="target_language"]').count() == 0
        if screenshot_dir:
            page.screenshot(path=str(screenshot_dir / "video-workbench-voice-modal.png"), full_page=False)
        page.locator('[data-video-voice-modal] [data-video-voice-close]').last.click()
        assert page.locator('[data-video-voice-modal]').count() == 0
        page.locator('[data-video-choice-field="digital_human_content_mode"][data-video-choice-value="oral_broadcast"]').click()
        assert page.locator('[data-video-field="oral_target_duration_seconds"]').count() == 1
        assert page.locator('[data-video-field="digital_human_short_mode"]').count() == 0
        assert "场景图" in page.locator('[data-video-file-field="product"]').inner_text()
        page.set_viewport_size({"width": 1920, "height": 1080})
        desktop_columns = page.locator(".video-original-layout").evaluate(
            "node => getComputedStyle(node).gridTemplateColumns.split(' ').length"
        )
        assert desktop_columns == 2, desktop_columns
        desktop_tracks = page.locator(".video-original-layout").evaluate(
            "node => getComputedStyle(node).gridTemplateColumns.split(' ').map(parseFloat)"
        )
        desktop_ratio = desktop_tracks[0] / sum(desktop_tracks)
        assert 0.44 <= desktop_ratio <= 0.46, desktop_tracks
        upload_slot = page.locator(".video-upload-panel .video-upload-slots [data-video-file-slot]").first.bounding_box()
        assert upload_slot, "missing upload preview slot"
        assert round(upload_slot["width"]) == 132, upload_slot
        assert round(upload_slot["height"]) == 132, upload_slot

        page.set_viewport_size({"width": 1440, "height": 1000})
        compact_columns = page.locator(".video-original-layout").evaluate(
            "node => getComputedStyle(node).gridTemplateColumns.split(' ').length"
        )
        assert compact_columns == 1, compact_columns

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
        mobile_shell_handle = page.locator("#videoWorkbenchRoot .video-workbench-shell").element_handle()
        page.locator("#mobileNavToggle").click()
        assert page.locator("body").evaluate("node => node.classList.contains('mobile-nav-open')")
        page.locator('#videoModuleMenu [data-video-module="ecommerce_short_video"]').evaluate("node => node.click()")
        page.locator('form[data-video-module-form="ecommerce_short_video"]').wait_for(state="visible")
        page.wait_for_function("!document.body.classList.contains('mobile-nav-open')")
        mobile_audio_picker = page.locator('[data-video-file-field="audio"] [data-video-file-pick]')
        assert mobile_audio_picker.is_visible(), "mobile audio upload lost its only file picker"
        with page.expect_file_chooser():
            mobile_audio_picker.click()
        assert page.evaluate(
            "shell => shell === document.querySelector('#videoWorkbenchRoot .video-workbench-shell')",
            mobile_shell_handle,
        ), "mobile sidebar module navigation replaced the whole workbench"
        mobile_columns = page.locator(".video-original-layout").evaluate("node => getComputedStyle(node).gridTemplateColumns.split(' ').length")
        assert mobile_columns == 1, mobile_columns
        if screenshot_dir:
            page.screenshot(path=str(screenshot_dir / "video-workbench-mobile.png"), full_page=True)

        assert not page_errors, f"uncaught page errors: {page_errors}"
        browser.close()

    print("video workbench browser smoke: passed (desktop + mobile, 8 modules, no task submission)")


if __name__ == "__main__":
    main()
