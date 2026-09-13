from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


def make_sample_video(target: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for the video editor browser smoke test")
    completed = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=480x270:rate=24:duration=1.2",
            "-f", "lavfi", "-i", "sine=frequency=523:duration=1.2", "-shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(target),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Real browser closed-loop smoke test for the video editor.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8778")
    parser.add_argument("--screenshot-dir", default="")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    screenshot_dir = Path(args.screenshot_dir).resolve() if args.screenshot_dir else None
    if screenshot_dir:
        screenshot_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as temp_dir:
        sample = Path(temp_dir) / "browser-sample.mp4"
        make_sample_video(sample)
        with sync_playwright() as playwright:
            chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            browser = playwright.chromium.launch(headless=True, executable_path=str(chrome) if chrome.exists() else None)
            context = browser.new_context(viewport={"width": 1680, "height": 1050})
            page = context.new_page()
            page_errors: list[str] = []
            native_dialogs: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("dialog", lambda dialog: (native_dialogs.append(dialog.type), dialog.dismiss()))

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

            page.goto(f"{base_url}/admin-video.html?video_module=video_editor", wait_until="networkidle")
            page.locator("#videoEditorRoot .video-editor-app").wait_for(state="visible")
            announcement = page.locator("[data-site-notification-broadcast]")
            if announcement.count() and announcement.first.is_visible():
                announcement.locator(".site-notification-broadcast-confirm").click()
            assert page.locator("#videoGenerationPanel").is_hidden()
            assert page.locator('[data-video-module="video_editor"]').get_attribute("aria-current") == "page"
            assert page.locator('[data-studio-tab="editor"]').get_attribute("aria-selected") == "true"

            toolbar_box = page.locator("#videoStudioToolbar").bounding_box()
            tabs_box = page.locator("#videoStudioTabs").bounding_box()
            heading_box = page.locator("#videoStudioHeadingHost .video-editor-heading").bounding_box()
            assert toolbar_box and tabs_box and heading_box
            assert heading_box["x"] >= tabs_box["x"] + tabs_box["width"]
            assert abs((tabs_box["y"] + tabs_box["height"] / 2) - (heading_box["y"] + heading_box["height"] / 2)) < 10

            page.locator("[data-project-new]").click()
            page.locator(".site-auth-feedback [data-video-action-form]").wait_for(state="visible")
            assert page.locator(".site-auth-feedback [data-video-dialog-input]").input_value().startswith("剪辑项目")
            page.locator(".site-auth-feedback [data-video-action-cancel]").click()
            page.locator(".site-auth-feedback").wait_for(state="detached")
            page.locator("[data-project-rename]").click()
            page.locator(".site-auth-feedback [data-video-dialog-input]").wait_for(state="visible")
            page.locator(".site-auth-feedback [data-video-action-cancel]").click()
            page.locator("[data-project-delete]").click()
            page.locator(".site-auth-feedback [data-video-action-confirm]").wait_for(state="visible")
            assert page.locator(".site-auth-feedback [data-video-dialog-input]").count() == 0
            page.locator(".site-auth-feedback [data-video-action-cancel]").click()
            assert not native_dialogs

            assert page.locator("[data-editor-drop-zone] [data-editor-upload]").count() == 1
            with page.expect_file_chooser() as chooser_info:
                page.locator("[data-editor-drop-zone]").click()
            chooser_info.value.set_files(str(sample))
            page.locator(".video-asset-card").wait_for(state="visible", timeout=30_000)
            page.get_by_text("browser-sample", exact=False).first.wait_for(state="visible")
            assert page.locator(".video-asset-card").count() == 1, page.locator(".video-asset-card").count()
            page.locator("[data-asset-delete]").click()
            page.locator(".site-auth-feedback [data-video-action-confirm]").wait_for(state="visible")
            page.locator(".site-auth-feedback [data-video-action-cancel]").click()
            assert page.locator(".video-asset-card").count() == 1
            assert not native_dialogs
            page.wait_for_function(
                "document.querySelector('.video-asset-card img')?.complete && document.querySelector('.video-asset-card img')?.naturalWidth > 0"
            )
            assert page.locator(".video-asset-visual [data-asset-preview]").count() == 0
            assert page.locator(".video-asset-visual[data-asset-preview] .video-asset-play svg").count() == 1
            assert page.locator(".video-asset-actions [data-asset-preview]").count() == 0
            page.locator(".video-asset-visual[data-asset-preview]").click()
            page.locator(".video-preview-modal").wait_for(state="visible")
            page.locator("[data-preview-close]").click()

            page.locator("[data-asset-add]").click()
            page.locator(".video-timeline-clip").wait_for(state="visible")
            assert page.locator(".video-timeline-clip").count() == 1
            preview_before = float(page.locator("[data-preview-scrubber]").input_value())
            page.locator("[data-preview-toggle]").click()
            page.wait_for_timeout(800)
            preview_after = float(page.locator("[data-preview-scrubber]").input_value())
            assert preview_after > preview_before + 0.15, (preview_before, preview_after)
            page.locator("[data-preview-toggle]").click()
            page.locator("[data-clip-end]").fill("0.65")
            page.locator("[data-clip-volume]").fill("0.75")
            trim_handle = page.locator(".video-timeline-clip.is-selected .video-trim-handle.is-right")
            trim_handle.scroll_into_view_if_needed()
            trim_box = trim_handle.bounding_box()
            assert trim_box
            page.mouse.move(trim_box["x"] + trim_box["width"] / 2, trim_box["y"] + trim_box["height"] / 2)
            page.mouse.down()
            page.mouse.move(trim_box["x"] - 10, trim_box["y"] + trim_box["height"] / 2, steps=4)
            page.mouse.up()
            assert float(page.locator("[data-clip-end]").input_value()) < 0.65
            page.wait_for_function("document.querySelector('[data-editor-save-state]')?.dataset.state === 'saved'", timeout=10_000)

            page.locator("[data-preview-scrubber]").evaluate(
                "node => { node.value = '0.20'; node.dispatchEvent(new Event('input', { bubbles: true })); }"
            )
            page.locator(".video-timeline-toolbar [data-clip-split]").click()
            assert page.locator(".video-timeline-clip").count() == 2
            page.locator("[data-timeline-undo]").click()
            assert page.locator(".video-timeline-clip").count() == 1
            page.locator("[data-timeline-redo]").click()
            assert page.locator(".video-timeline-clip").count() == 2
            zoom_before = int(page.locator("[data-timeline-zoom]").input_value())
            page.locator("[data-timeline-zoom-in]").click()
            assert int(page.locator("[data-timeline-zoom]").input_value()) > zoom_before
            assert page.locator("[data-timeline-playhead]").is_visible()
            assert page.locator("[data-trim-handle]").count() == 4
            assert page.locator(".video-track-row").count() == 3
            assert page.locator(".video-editor-inspector [data-clip-move], .video-editor-inspector [data-clip-duplicate], .video-editor-inspector [data-clip-remove]").count() == 0
            assert page.locator(".video-timeline-toolbar [data-clip-duplicate]").count() == 1

            page.locator("[data-asset-add]").click()
            page.locator("[data-clip-track]").select_option("1")
            page.locator("[data-clip-timeline-start]").fill("0.05")
            page.locator("[data-clip-timeline-start]").press("Enter")
            page.locator("[data-clip-scale]").fill("0.45")
            page.locator("[data-preview-scrubber]").evaluate(
                "node => { node.value = '0.10'; node.dispatchEvent(new Event('input', { bubbles: true })); }"
            )
            assert page.locator('[data-track-row="1"] .video-timeline-clip').count() == 1
            assert page.locator('[data-track-row="0"] .video-timeline-clip').count() == 2
            assert page.locator("[data-editor-preview]").count() == 2
            page.wait_for_function("document.querySelector('[data-editor-save-state]')?.dataset.state === 'saved'", timeout=10_000)

            page.locator("[data-project-export]").click()
            page.get_by_text("正在导出", exact=False).or_(page.get_by_text("等待导出", exact=False)).first.wait_for(state="visible", timeout=10_000)
            page.get_by_text("最近成品已导出", exact=True).wait_for(state="visible", timeout=60_000)
            assert page.locator(".video-asset-card").count() == 2
            assert page.locator("[data-export-preview]").is_visible()
            assert page.locator("[data-project-export]").is_enabled()

            page.locator('[data-studio-tab="records"]').click()
            page.locator("#videoRecordsRoot .video-records-app").wait_for(state="visible")
            assert page.locator("#videoEditorPage").is_hidden()
            assert page.locator('[data-studio-tab="records"]').get_attribute("aria-selected") == "true"
            assert page.locator('[data-video-module="video_editor"]').get_attribute("aria-current") == "page"
            page.locator("[data-record-filter]").select_option("export")
            page.locator(".video-record-card").wait_for(state="visible")
            assert page.locator(".video-record-card").count() == 1
            card_box = page.locator(".video-record-card").bounding_box()
            visual_box = page.locator(".video-record-visual").bounding_box()
            panel_box = page.locator(".video-records-panel").bounding_box()
            assert card_box and visual_box and panel_box
            assert card_box["width"] / panel_box["width"] < 0.28
            assert abs(visual_box["width"] / visual_box["height"] - 4 / 3) < 0.08
            assert visual_box["height"] / card_box["height"] >= 0.68
            assert page.locator("[data-record-menu-toggle] svg.video-icon").count() == 1
            assert page.locator("[data-record-share-toggle] svg.video-icon").count() == 1
            page.locator("[data-record-share-toggle]").click()
            page.locator(".video-share-dialog").wait_for(state="visible")
            assert page.locator('[data-share-platform-group="domestic"] [data-share-platform]').count() == 7
            assert page.locator('[data-share-platform-group="international"] [data-share-platform]').count() == 9
            assert page.locator(".video-share-platform-grid .video-brand-icon").count() == 16
            assert page.locator(".video-share-platform-grid .video-icon").count() == 0
            assert page.locator('[data-share-platform="wechat"] [data-brand-logo="wechat"] path').first.get_attribute("fill") == "#07c160"
            assert page.locator('[data-share-platform="channels"] [data-brand-logo="channels"] path').first.get_attribute("fill") == "#fa9d3b"
            assert page.locator('[data-share-platform="facebook"] [data-brand-logo="facebook"] circle').first.get_attribute("fill") == "#0866ff"
            assert page.locator('[data-share-platform="youtube"] [data-brand-logo="youtube"] path').first.get_attribute("fill") == "#ff0000"
            assert page.locator('[data-share-platform="tiktok"] [data-brand-logo="tiktok"] path').count() == 3
            assert "admin_workspace_user_id" not in page.locator(".video-share-dialog").inner_text()
            page.locator("[data-share-native]").wait_for(state="visible")
            page.wait_for_function("!document.querySelector('[data-share-native]')?.disabled", timeout=10_000)
            page.evaluate("Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });")
            with page.expect_download():
                page.locator("[data-share-native]").click()
            page.get_by_text("当前浏览器不支持文件分享，已改为下载视频。", exact=True).wait_for(state="visible")
            if screenshot_dir:
                page.screenshot(path=str(screenshot_dir / "video-record-share-desktop.png"), full_page=True)
            page.locator("[data-share-close]").click()
            assert page.locator(".video-share-modal").count() == 0
            page.locator("[data-record-menu-toggle]").click()
            assert page.locator(".video-record-action-menu:not([hidden])").is_visible()
            assert page.locator(".video-record-action-menu:not([hidden]) svg.video-icon").count() == 3
            if screenshot_dir:
                page.evaluate("window.scrollTo(0, 0)")
                page.screenshot(path=str(screenshot_dir / "video-records-desktop.png"), full_page=True)
            page.locator("[data-record-edit]").click()
            page.locator("#videoEditorRoot .video-editor-app").wait_for(state="visible")
            assert page.locator('[data-studio-tab="editor"]').get_attribute("aria-selected") == "true"
            page.wait_for_function("document.querySelectorAll('.video-timeline-clip').length === 4", timeout=10_000)
            page.wait_for_function("document.querySelector('[data-editor-save-state]')?.dataset.state === 'saved'", timeout=10_000)
            if screenshot_dir:
                page.evaluate("window.scrollTo(0, 0)")
                page.screenshot(path=str(screenshot_dir / "video-editor-desktop.png"), full_page=True)

            page.set_viewport_size({"width": 390, "height": 844})
            page.reload(wait_until="networkidle")
            page.locator("#videoEditorRoot .video-editor-app").wait_for(state="visible")
            announcement = page.locator("[data-site-notification-broadcast]")
            if announcement.count() and announcement.first.is_visible():
                announcement.locator(".site-notification-broadcast-confirm").click()
                page.wait_for_timeout(500)
            assert page.locator(".video-editor-library").is_visible()
            assert page.locator(".video-editor-stage").is_visible()
            assert page.locator(".video-editor-timeline").is_visible()
            assert page.locator(".video-editor-inspector").is_visible()
            mobile_toolbar = page.locator("#videoStudioToolbar").bounding_box()
            mobile_tabs = page.locator("#videoStudioTabs").bounding_box()
            mobile_heading = page.locator("#videoStudioHeadingHost .video-editor-heading").bounding_box()
            assert mobile_toolbar and mobile_toolbar["x"] >= 0 and mobile_toolbar["x"] + mobile_toolbar["width"] <= 390
            assert mobile_tabs and mobile_heading and mobile_heading["x"] >= mobile_tabs["x"] + mobile_tabs["width"]
            assert abs(mobile_tabs["y"] - mobile_heading["y"]) < 10
            assert page.locator("[data-editor-drop-zone]").bounding_box()["width"] <= page.locator(".video-editor-library").bounding_box()["width"]
            page.locator("[data-project-rename]").click()
            page.locator(".site-auth-feedback [data-video-dialog-input]").wait_for(state="visible")
            action_box = page.locator(".site-auth-feedback-dialog").bounding_box()
            assert action_box and action_box["x"] >= 0 and action_box["x"] + action_box["width"] <= 390
            page.locator(".site-auth-feedback [data-video-action-cancel]").click()
            if screenshot_dir:
                page.screenshot(path=str(screenshot_dir / "video-editor-mobile.png"), full_page=True)

            page.locator('[data-studio-tab="records"]').click()
            page.locator("#videoRecordsRoot .video-records-app").wait_for(state="visible")
            page.locator("[data-record-filter]").select_option("export")
            page.locator(".video-record-card").wait_for(state="visible")
            page.locator("[data-record-share-toggle]").click()
            page.locator(".video-share-dialog").wait_for(state="visible")
            share_box = page.locator(".video-share-dialog").bounding_box()
            platform_box = page.locator("[data-share-platform]").first.bounding_box()
            assert share_box and share_box["x"] >= 0 and share_box["x"] + share_box["width"] <= 390
            assert share_box["y"] >= 0 and share_box["y"] + share_box["height"] <= 844
            assert platform_box and platform_box["height"] >= 40
            if screenshot_dir:
                page.screenshot(path=str(screenshot_dir / "video-record-share-mobile.png"))
            page.locator("[data-share-close]").click()

            assert not page_errors, f"uncaught page errors: {page_errors}"
            browser.close()

    print("video editor browser smoke: passed (upload -> trim/split -> save -> export -> asset library)")


if __name__ == "__main__":
    main()
