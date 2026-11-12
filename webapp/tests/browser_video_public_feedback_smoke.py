from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify public feedback modals on the video workbench.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "").strip()
        if not browser_path:
            chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            browser_path = str(chrome) if chrome.exists() else ""
        browser = playwright.chromium.launch(headless=True, executable_path=browser_path or None)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        native_dialogs: list[str] = []
        page.on("dialog", lambda dialog: (native_dialogs.append(dialog.message), dialog.dismiss()))
        task_mode = {"value": "success"}
        task_state = {"submitted": False, "polls": 0}
        record_asset_requests: list[str] = []

        def fulfill_json(route, payload, status=200):
            route.fulfill(status=status, content_type="application/json", body=json.dumps(payload, ensure_ascii=False))

        def handle_video_tasks(route):
            if route.request.method == "POST":
                if task_mode["value"] == "balance":
                    fulfill_json(route, {"detail": {"code": "INSUFFICIENT_POINTS", "message": "insufficient points"}}, 402)
                elif task_mode["value"] == "server_error":
                    fulfill_json(route, {"detail": "Internal Server Error"}, 500)
                else:
                    task_state["submitted"] = True
                    task_state["polls"] = 0
                    fulfill_json(route, {"task": {"id": "browser-feedback-task", "type": "create_video", "status": "queued", "title": "浏览器反馈验证任务"}})
                return
            if task_state["submitted"]:
                task_state["polls"] += 1
                if task_state["polls"] >= 2:
                    review = task_mode["value"] == "review"
                    fulfill_json(route, {"tasks": [{"id": "browser-feedback-task", "type": "create_video", "status": "success", "title": "浏览器反馈验证任务", "has_download": True, "has_video_output": not review, "video_stage": "visual_review" if review else ""}]})
                    return
                fulfill_json(route, {"tasks": [{"id": "browser-feedback-task", "type": "create_video", "status": "queued", "title": "浏览器反馈验证任务"}]})
                return
            fulfill_json(route, {"tasks": []})

        page.route("**/api/video/tasks", handle_video_tasks)
        page.route("**/api/tasks", lambda route: fulfill_json(route, {"tasks": []}))
        def handle_record_assets(route):
            record_asset_requests.append(route.request.url)
            fulfill_json(route, {"items": [{"id": "browser-record", "source_task_id": "browser-feedback-task", "source_type": "generated", "name": "浏览器反馈视频", "media_url": "/api/video/editor/assets/browser-record/media", "download_url": "/api/video/editor/assets/browser-record/download"}], "total": 1, "total_pages": 1})

        page.route("**/api/video/editor/assets**", handle_record_assets)
        page.route(
            "**/api/video/prompt-preview",
            lambda route: fulfill_json(route, {"speech_text": "验证口播文案", "prompt_text": "验证画面提示词"}),
        )
        page.route("**/api/video/voice-presets", lambda route: fulfill_json(route, {"items": []}))
        page.add_init_script(
            """
            (() => {
              const originalFetch = window.fetch.bind(window);
              window.fetch = async function(input, init) {
                const url = String(typeof input === "string" ? input : (input?.url || ""));
                const method = String(init?.method || input?.method || "GET").toUpperCase();
                const response = await originalFetch(input, init);
                const shouldDelay = url.includes("/api/video/prompt-preview")
                  || (url.includes("/api/video/tasks") && method === "POST");
                if (shouldDelay) await new Promise((resolve) => window.setTimeout(resolve, 2200));
                return response;
              };
            })();
            """
        )

        login = context.request.post(
            f"{args.base_url.rstrip('/')}/api/auth/portal-login",
            data={"username": "browseradmin", "password": "BrowserSmoke-2026!", "remember_me": False, "force_takeover": True},
        )
        assert login.ok, f"admin login failed: {login.status} {login.text()}"
        page.goto(f"{args.base_url.rstrip('/')}/admin-video.html?video_module=digital_human_video", wait_until="networkidle")
        page.locator("#videoWorkbenchRoot .video-workbench-shell").wait_for(state="visible")
        announcement = page.locator("[data-site-notification-broadcast]")
        if announcement.count() and announcement.first.is_visible():
            announcement.locator(".site-notification-broadcast-confirm").click()

        def set_file(field: str, filename: str, mime: str) -> None:
            page.locator(f'[data-video-file-field="{field}"] input[type="file"]').set_input_files({"name": filename, "mimeType": mime, "buffer": PNG_1X1})

        def upload_video_sources() -> None:
            set_file("model", "presenter.png", "image/png")
            set_file("product", "product.png", "image/png")
            set_file("audio", "voice.wav", "audio/wav")

        upload_video_sources()

        page.locator("[data-video-generate-prompt]").click()
        busy = page.locator('.vecto-public-prompt[data-public-prompt-busy="true"]')
        busy.wait_for(state="visible")
        first_progress = busy.locator("[data-public-prompt-message]").inner_text()
        page.wait_for_timeout(1700)
        second_progress = busy.locator("[data-public-prompt-message]").inner_text()
        assert first_progress != second_progress, (first_progress, second_progress)
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        assert "提示词和文案已生成" in page.locator(".vecto-public-prompt").inner_text()
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()

        page.locator('#videoWorkbenchRoot button[type="submit"]').click()
        submit_busy = page.locator('.vecto-public-prompt[data-public-prompt-busy="true"]')
        submit_busy.wait_for(state="visible")
        submit_first = submit_busy.locator("[data-public-prompt-message]").inner_text()
        page.wait_for_timeout(1700)
        submit_second = submit_busy.locator("[data-public-prompt-message]").inner_text()
        assert submit_first != submit_second, (submit_first, submit_second)
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        assert "生成完成" in page.locator(".vecto-public-prompt").inner_text()
        assert "同步到视频记录" in page.locator(".vecto-public-prompt").inner_text()
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()
        record_asset_requests.clear()
        page.locator('[data-video-module="video_editor"]').click(force=True)
        page.locator("#videoRecordsRoot .video-records-panel").wait_for(state="visible")
        assert any("sync_generated=true" in url for url in record_asset_requests), record_asset_requests
        page.locator('[data-video-module="digital_human_video"]').click(force=True)
        page.locator('#videoWorkbenchRoot .video-workbench-shell').wait_for(state="visible")

        task_mode["value"] = "review"
        upload_video_sources()
        page.locator("[data-video-generate-prompt]").click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()
        page.locator('#videoWorkbenchRoot button[type="submit"]').click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="info"]').wait_for(state="visible")
        review_text = page.locator(".vecto-public-prompt").inner_text()
        assert "尚未合成最终视频" in review_text and "查看任务并确认" in review_text
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()

        task_mode["value"] = "balance"
        upload_video_sources()
        page.locator("[data-video-generate-prompt]").click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()
        page.locator('#videoWorkbenchRoot button[type="submit"]').click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="error"]').wait_for(state="visible")
        balance_text = page.locator(".vecto-public-prompt").inner_text()
        assert "算力点余额不足" in balance_text and "购买算力" in balance_text
        assert "insufficient" not in balance_text.lower()
        page.locator('.vecto-public-prompt button[data-public-prompt-cancel]').click()

        task_mode["value"] = "server_error"
        upload_video_sources()
        page.locator("[data-video-generate-prompt]").click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()
        page.locator('#videoWorkbenchRoot button[type="submit"]').click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="error"]').wait_for(state="visible")
        error_text = page.locator(".vecto-public-prompt").inner_text()
        assert "服务器处理失败" in error_text
        assert "Internal Server Error" not in error_text
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()

        page.locator('[data-video-module="subject_generate"]').click(force=True)
        page.locator('form[data-video-module-form="subject_generate"]').wait_for(state="visible")
        page.locator('#videoWorkbenchRoot button[type="submit"]').click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="info"]').wait_for(state="visible")
        assert "确认" in page.locator(".vecto-public-prompt").inner_text()
        page.locator(".vecto-public-prompt button[data-public-prompt-cancel]").click()

        assert not native_dialogs, f"native browser dialogs were shown: {native_dialogs}"

        console_page = context.new_page()
        console_page.goto(f"{args.base_url.rstrip('/')}/console.html", wait_until="domcontentloaded")
        console_page.wait_for_function("() => Boolean(window.VectoPublicPrompt)")
        console_page.evaluate("window.dispatchEvent(new CustomEvent('vecto:billing-insufficient'))")
        console_page.locator('.vecto-public-prompt[data-public-prompt-status="error"]').wait_for(state="visible")
        assert console_page.locator(".vecto-public-prompt").count() == 1
        assert console_page.locator("#consoleModal").count() == 0
        assert "购买算力" in console_page.locator(".vecto-public-prompt").inner_text()
        console_page.locator(".vecto-public-prompt button[data-public-prompt-cancel]").click()
        console_page.close()

        print("video public feedback browser smoke: ok")
        browser.close()


if __name__ == "__main__":
    main()
