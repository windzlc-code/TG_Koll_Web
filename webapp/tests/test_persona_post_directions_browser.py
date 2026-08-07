import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = ROOT / "webapp" / "static" / "assets" / "console.js"


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
