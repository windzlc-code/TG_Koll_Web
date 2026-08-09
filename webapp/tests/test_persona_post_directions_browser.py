import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = ROOT / "webapp" / "static" / "assets" / "console.js"
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"


def _launch_browser(playwright):
    explicit = os.getenv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "").strip()
    candidates = [
        explicit,
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return playwright.chromium.launch(headless=True, executable_path=candidate)
    try:
        return playwright.chromium.launch(headless=True)
    except Exception as error:  # pragma: no cover - depends on CI browser installation
        pytest.skip(f"Chromium is not installed: {error}")


def test_two_stage_action_and_stale_response_behavior_in_browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page()
        page.route(
            "http://post-direction.test/",
            lambda route: route.fulfill(
                status=200,
                content_type="text/html",
                body='<!doctype html><html><body><div id="commandMsg"></div></body></html>',
            ),
        )
        page.goto("http://post-direction.test/")
        page.add_script_tag(path=str(CONSOLE_JS))

        action_calls = page.evaluate(
            """async () => {
              const calls = [];
              selectedPersona = () => ({ id: "persona-1" });
              personaFormState = () => ({ draft: { editingPostId: "" }, generate: { composeMode: "tweet" } });
              storedPersonaPostGenerationTask = () => null;
              personaPostDirectionState = () => ({ selectedKeywords: [] });
              preparePersonaPostDirections = async () => calls.push("directions");
              generatePersonaDraftPosts = async () => calls.push("generate");
              await handlePersonaGeneratePrimaryAction();
              personaPostDirectionState = () => ({ selectedKeywords: ["剪发前沟通"] });
              await handlePersonaGeneratePrimaryAction();
              return calls;
            }"""
        )
        assert action_calls == ["directions", "generate"]

        page.reload()
        page.add_script_tag(path=str(CONSOLE_JS))
        stale_result = page.evaluate(
            """async () => {
              const form = {
                draft: { title: "旧标题", content: "旧正文" },
                generate: {
                  composeMode: "tweet",
                  writingLocale: "zh-TW",
                  postDirectionsByMode: {
                    tweet: defaultPersonaPostDirectionState(),
                    tweet_media: defaultPersonaPostDirectionState(),
                  },
                },
              };
              selectedPersona = () => ({ id: "persona-1" });
              personaFormState = () => form;
              snapshotPersonaCurrentForm = () => {};
              personaContentPlatform = () => "threads";
              currentLanguage = () => "zh-Hant";
              isActionLocked = () => false;
              setActionLocked = () => {};
              clearMsg = () => {};
              renderPersonaDetail = () => {};
              personaStepOperationKey = () => "operation-1";
              clearPersonaStepOperationKey = () => {};
              personaStepErrorKeepsOperationKey = () => false;
              withBillingChargeMessage = (message) => message;
              showMsg = (_target, message, ok) => { globalThis.__directionMessage = { message, ok }; };
              apiWithTimeout = async () => {
                form.draft.content = "用户等待时输入的新正文";
                return { keywords: Array.from({ length: 10 }, (_, index) => `方向${index + 1}`) };
              };
              await preparePersonaPostDirections();
              return {
                keywords: personaPostDirectionState("persona-1", "tweet").keywords,
                message: globalThis.__directionMessage,
              };
            }"""
        )
        assert stale_result["keywords"] == []
        assert "内容已变化" in stale_result["message"]["message"]
        assert stale_result["message"]["ok"] is False
        browser.close()


def test_direction_picker_switches_one_bulk_button_by_selection_state():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.add_script_tag(path=str(CONSOLE_JS))

        picker_state = page.evaluate(
            """() => {
              const state = { keywords: ["方向一", "方向二"], selectedKeywords: [] };
              personaPostDirectionState = () => state;
              const read = () => {
                const host = document.createElement("div");
                host.innerHTML = renderPersonaPostDirectionPicker({ id: "persona-1" }, { composeMode: "tweet" });
                const button = host.querySelector("[data-persona-post-direction-selection]");
                return {
                  count: host.querySelectorAll("[data-persona-post-direction-selection]").length,
                  action: button?.dataset.personaPostDirectionSelection || "",
                  label: button?.getAttribute("aria-label") || "",
                };
              };
              const empty = read();
              state.selectedKeywords = state.keywords.slice();
              return { empty, full: read() };
            }"""
        )
        assert picker_state == {
            "empty": {"count": 1, "action": "all", "label": "全选"},
            "full": {"count": 1, "action": "clear", "label": "清空选择"},
        }
        browser.close()


def test_generated_selection_actions_are_one_row_and_discard_is_right_aligned_on_mobile():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.set_content(
            '''<!doctype html><html><body class="console-page">
            <div class="console-modal" data-modal-key="persona-generated-selection">
              <div class="console-modal-dialog">
                <div class="console-modal-actions">
                  <button type="button" class="primary" data-console-modal-value="media">生成配图</button>
                  <button type="button" data-console-modal-value="save">保存草稿</button>
                  <button type="button" class="danger" data-console-modal-value="discard">放弃本次结果</button>
                </div>
              </div>
            </div></body></html>'''
        )
        page.add_style_tag(path=str(CONSOLE_CSS))

        boxes = page.locator(".console-modal-actions > button").evaluate_all(
            "buttons => buttons.map(button => ({ value: button.dataset.consoleModalValue, ...button.getBoundingClientRect().toJSON() }))"
        )
        by_value = {box["value"]: box for box in boxes}

        assert max(box["top"] for box in boxes) - min(box["top"] for box in boxes) <= 1
        assert by_value["discard"]["left"] - (by_value["save"]["left"] + by_value["save"]["width"]) >= 12
        assert abs((by_value["discard"]["left"] + by_value["discard"]["width"]) - 372) <= 8
        browser.close()
