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
        task_state = {
            "submitted": False,
            "polls": 0,
            "task_post_count": 0,
            "finalize_submitted": False,
            "finalize_count": 0,
            "final_polls": 0,
        }
        prompt_state = {"count": 0}
        record_asset_requests: list[str] = []
        record_state = {"polls": 0}

        def fulfill_json(route, payload, status=200):
            route.fulfill(status=status, content_type="application/json", body=json.dumps(payload, ensure_ascii=False))

        def handle_video_tasks(route):
            if route.request.method == "POST":
                task_state["task_post_count"] += 1
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
                if task_state["finalize_submitted"]:
                    task_state["final_polls"] += 1
                    if task_state["final_polls"] >= 2:
                        fulfill_json(route, {"tasks": [{"id": "browser-feedback-final-task", "type": "create_video", "status": "success", "title": "浏览器最终视频", "has_download": True, "has_video_output": True}]})
                    else:
                        fulfill_json(route, {"tasks": [{"id": "browser-feedback-final-task", "type": "create_video", "status": "queued", "title": "浏览器最终视频"}]})
                    return
                task_state["polls"] += 1
                if task_state["polls"] >= 4:
                    review = task_mode["value"] == "review"
                    fulfill_json(route, {"tasks": [{"id": "browser-feedback-task", "type": "create_video", "status": "success", "title": "浏览器反馈验证任务", "has_download": True, "has_video_output": not review, "video_stage": "visual_review" if review else ""}]})
                    return
                fulfill_json(route, {"tasks": [{"id": "browser-feedback-task", "type": "create_video", "status": "running", "title": "浏览器反馈验证任务", "video_stage": "digital_human_image_fusion", "progress": 30}]})
                return
            fulfill_json(route, {"tasks": []})

        def handle_video_finalize(route):
            task_state["finalize_count"] += 1
            task_state["finalize_submitted"] = True
            task_state["final_polls"] = 0
            fulfill_json(route, {"id": "browser-feedback-final-task", "task_type": "create_video", "status": "queued", "source_task_id": "browser-feedback-task"})

        page.route("**/api/video/tasks", handle_video_tasks)
        page.route("**/api/video/tasks/browser-feedback-task/digital-human/finalize", handle_video_finalize)
        page.route("**/api/tasks", lambda route: fulfill_json(route, {"tasks": []}))
        def handle_record_assets(route):
            record_asset_requests.append(route.request.url)
            record_state["polls"] += 1
            if record_state["polls"] < 2:
                fulfill_json(route, {"items": [], "total": 0, "total_pages": 0})
                return
            source_task_id = "browser-feedback-final-task" if task_state["finalize_submitted"] else "browser-feedback-task"
            fulfill_json(route, {"items": [{"id": "browser-record", "source_task_id": source_task_id, "source_type": "generated", "name": "浏览器反馈视频", "media_url": "/api/video/editor/assets/browser-record/media", "download_url": "/api/video/editor/assets/browser-record/download"}], "total": 1, "total_pages": 1})

        page.route("**/api/video/editor/assets**", handle_record_assets)
        def handle_prompt_preview(route):
            prompt_state["count"] += 1
            speech = "验证口播文案" if prompt_state["count"] == 1 else f"刷新口播文案 {prompt_state['count']}"
            fulfill_json(route, {"speech_text": speech, "prompt_text": "验证画面提示词"})

        page.route("**/api/video/prompt-preview", handle_prompt_preview)
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
        page.evaluate(
            """() => {
              window.__videoInfoExpiryHandle = window.VectoPublicPrompt.showInfo({
                key: "browser-info-expiry",
                title: "临时提示",
                message: "这条提示应自动消失",
                status: "progress",
                busy: true,
                persistent: false,
              });
            }"""
        )
        expiry_toast = page.locator('[data-vecto-public-info-toast="true"][data-toast-key="browser-info-expiry"]')
        expiry_toast.wait_for(state="visible")
        assert expiry_toast.get_attribute("data-toast-persistent") == "false"
        page.wait_for_timeout(5200)
        assert expiry_toast.count() == 0
        page.evaluate(
            """() => window.__videoInfoExpiryHandle.update({
              title: "临时提示已恢复",
              message: "更新后仍可继续显示",
              status: "success",
              busy: false,
            })"""
        )
        page.locator('[data-vecto-public-info-toast="true"][data-toast-key="browser-info-expiry"]').wait_for(state="visible")
        page.evaluate("() => window.__videoInfoExpiryHandle.close()")

        def set_file(field: str, filename: str, mime: str) -> None:
            page.locator(f'[data-video-file-field="{field}"] input[type="file"]').set_input_files({"name": filename, "mimeType": mime, "buffer": PNG_1X1})

        def upload_video_sources() -> None:
            set_file("model", "presenter.png", "image/png")
            set_file("product", "product.png", "image/png")
            set_file("audio", "voice.wav", "audio/wav")

        def next_expected_speech() -> str:
            return "验证口播文案" if prompt_state["count"] == 0 else f"刷新口播文案 {prompt_state['count'] + 1}"

        def generate_copy_only() -> str:
            posts_before = task_state["task_post_count"]
            expected_speech = next_expected_speech()
            page.locator("#videoWorkbenchRoot button[type='submit']").click()
            info = page.locator('[data-vecto-public-info-toast="true"][data-toast-key="video-workbench:prompt-generation"]')
            info.wait_for(state="visible")
            assert "正在生成提示词 / 文案" in info.inner_text()
            assert info.get_attribute("data-toast-persistent") == "false"
            prompt_button = page.locator("[data-video-generate-prompt]")
            prompt_button.wait_for(state="visible")
            assert prompt_button.is_disabled()
            spinner = prompt_button.locator(".video-button-spinner")
            assert spinner.count() == 1
            assert spinner.evaluate("node => getComputedStyle(node).animationName") == "video-spin"
            assert spinner.evaluate("node => getComputedStyle(node).borderTopColor") != "rgb(255, 255, 255)"
            prompt_field = page.locator(".video-form-field--generating .video-form-input-shell")
            prompt_field.wait_for(state="visible")
            assert prompt_field.count() == 1
            assert prompt_field.evaluate("node => getComputedStyle(node, '::before').animationName") == "videoPromptBorderFlow"
            assert prompt_field.evaluate("node => getComputedStyle(node, '::before').backgroundImage") != "none"
            page.locator('[data-video-field="speech_text"]').wait_for(state="visible")
            page.wait_for_function(
                """expected => String(document.querySelector('[data-video-field="speech_text"]')?.value || '').trim() === expected""",
                arg=expected_speech,
            )
            assert page.locator(".video-speech-modal").count() == 0
            assert page.locator("[data-video-prompt-preview-prompt]").count() == 0
            page.wait_for_function("() => document.querySelectorAll('.vecto-public-prompt').length === 0")
            assert task_state["task_post_count"] == posts_before, task_state

            return expected_speech

        def generate_copy_then_submit() -> None:
            generate_copy_only()
            page.locator("#videoWorkbenchRoot button[type='submit']").click()

        upload_video_sources()
        first_speech = generate_copy_only()
        refreshed_speech = next_expected_speech()
        page.locator("[data-video-generate-prompt]").click()
        page.locator("[data-video-generate-prompt] .video-button-spinner").wait_for(state="visible")
        page.wait_for_function(
            """expected => String(document.querySelector('[data-video-field="speech_text"]')?.value || '').trim() === expected""",
            arg=refreshed_speech,
        )
        assert refreshed_speech != first_speech
        page.wait_for_function("() => document.querySelectorAll('.vecto-public-prompt').length === 0")
        page.locator("#videoWorkbenchRoot button[type='submit']").click()
        busy = page.locator('.vecto-public-prompt[data-public-prompt-busy="true"]')
        busy.wait_for(state="visible")
        assert busy.locator("[data-public-prompt-step]").count() == 6
        generation_image = busy.locator('[data-public-prompt-step="generation-image"][data-public-prompt-step-status="active"]')
        generation_image.wait_for(state="visible")
        assert generation_image.count() == 1
        assert "1/3" in busy.locator('[data-public-prompt-step="generation-image"]').inner_text()
        assert busy.locator('[data-public-prompt-step-status="active"]').count() >= 1
        first_progress = busy.locator("[data-public-prompt-message]").inner_text()
        page.wait_for_timeout(1700)
        second_progress = busy.locator("[data-public-prompt-message]").inner_text()
        assert first_progress == second_progress, (first_progress, second_progress)
        assert busy.locator(".vecto-public-prompt-dialog").evaluate("(node) => getComputedStyle(node).animationName === 'none'")
        busy = page.locator('.vecto-public-prompt[data-public-prompt-busy="true"]')
        assert busy.locator("[data-public-prompt-step]").count() == 6
        busy.locator("[data-public-prompt-minimize]").click()
        assert page.locator('.vecto-public-prompt[data-public-prompt-minimized="true"] [data-public-prompt-restore]').is_visible()
        page.wait_for_timeout(2500)
        assert task_state["task_post_count"] >= 1, task_state
        assert page.locator(".vecto-public-prompt").count() == 1
        assert not page.locator('.vecto-public-prompt[data-public-prompt-minimized="true"] .vecto-public-prompt-dialog').is_visible()
        assert page.locator('.vecto-public-prompt[data-public-prompt-minimized="true"] .vecto-public-prompt-dialog').get_attribute("hidden") == ""
        assert page.locator('.vecto-public-prompt[data-public-prompt-minimized="true"] [data-public-prompt-restore]').is_visible()
        page.locator('.vecto-public-prompt[data-public-prompt-minimized="true"] [data-public-prompt-restore]').click()
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        assert "生成完成" in page.locator(".vecto-public-prompt").inner_text()
        assert "同步到视频记录" in page.locator(".vecto-public-prompt").inner_text()
        assert page.locator('.vecto-public-prompt [data-public-prompt-step-status="complete"]').count() == 6
        assert page.locator('.vecto-public-prompt [data-public-prompt-step-status="complete"] .vecto-public-prompt-step-mark').first.evaluate("node => getComputedStyle(node).animationName") == "none"
        assert record_state["polls"] >= 2, record_state
        assert "继续生成视频" not in page.locator(".vecto-public-prompt").inner_text()
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()
        record_asset_requests.clear()
        page.locator('[data-video-module="video_editor"]').click(force=True)
        page.locator("#videoRecordsRoot .video-records-panel").wait_for(state="visible")
        assert any("sync_generated=true" in url for url in record_asset_requests), record_asset_requests
        page.goto(f"{args.base_url.rstrip('/')}/admin-video.html?video_module=digital_human_video", wait_until="networkidle")
        page.locator('#videoWorkbenchRoot .video-workbench-shell').wait_for(state="visible")
        page.wait_for_timeout(500)

        task_mode["value"] = "review"
        task_state["finalize_submitted"] = False
        task_state["finalize_count"] = 0
        upload_video_sources()
        generate_copy_then_submit()
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        review_text = page.locator(".vecto-public-prompt").inner_text()
        assert task_state["finalize_submitted"] is True and task_state["finalize_count"] == 1, task_state
        assert "尚未合成最终视频" not in review_text and "查看任务并确认" not in review_text
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()

        task_mode["value"] = "balance"
        upload_video_sources()
        generate_copy_then_submit()
        page.locator('.vecto-public-prompt[data-public-prompt-status="error"]').wait_for(state="visible")
        balance_text = page.locator(".vecto-public-prompt").inner_text()
        assert "算力点余额不足" in balance_text and "购买算力" in balance_text
        assert "insufficient" not in balance_text.lower()
        page.locator('.vecto-public-prompt button[data-public-prompt-cancel]').click()

        task_mode["value"] = "server_error"
        upload_video_sources()
        generate_copy_then_submit()
        page.locator('.vecto-public-prompt[data-public-prompt-status="error"]').wait_for(state="visible")
        error_text = page.locator(".vecto-public-prompt").inner_text()
        assert "服务器处理失败" in error_text
        assert "Internal Server Error" not in error_text
        page.locator(".vecto-public-prompt [data-public-prompt-close]").click()

        task_mode["value"] = "success"
        task_state["submitted"] = False
        task_state["polls"] = 0
        task_state["finalize_submitted"] = False
        task_state["finalize_count"] = 0
        task_state["final_polls"] = 0
        upload_video_sources()
        direct_speech = "用户已填写的口播文案应直接提交"
        page.locator('[data-video-field="speech_text"]').fill(direct_speech)
        prompt_posts_before = prompt_state["count"]
        task_posts_before = task_state["task_post_count"]
        page.locator("#videoWorkbenchRoot button[type='submit']").click()
        direct_busy = page.locator('.vecto-public-prompt[data-public-prompt-busy="true"]')
        direct_busy.wait_for(state="visible")
        assert prompt_state["count"] == prompt_posts_before, prompt_state
        page.locator('.vecto-public-prompt[data-public-prompt-status="success"]').wait_for(state="visible")
        assert task_state["task_post_count"] > task_posts_before, task_state
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
