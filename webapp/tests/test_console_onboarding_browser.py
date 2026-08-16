import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
ONBOARDING_SCRIPT = (ROOT / "webapp" / "static" / "assets" / "console-onboarding.js").read_text(encoding="utf-8")
STORAGE_KEY = "vecto-console-onboarding:2026.08:7"
STEP_IDS = ("personas", "accounts", "tweet_generation", "publishing", "persona_dashboard")

PAGE_HTML = """<!doctype html>
<html><body class="is-console-ready">
  <div id="personaDashboardToolbarActions"><button id="btnPersonaDashboardSync">同步</button></div>
  <nav>
    <button data-module="personas">我的人设</button>
    <button data-workspace-module="accounts">账号管理</button>
    <button data-module="tweet_generation">推文生成</button>
    <button data-module="publishing">任务</button>
    <button data-view="persona_dashboard">人设看板</button>
  </nav>
  <div><button data-persona-open-create>创建人设</button></div>
  <div><button data-account-pool-add><strong>添加账号</strong></button></div>
  <div><button data-persona-generate-posts>AI 生成</button></div>
  <div><button data-persona-publish-submit>执行任务</button></div>
</body></html>"""

STEP_CASES = (
    (0, "先建立你的人设", "/api/persona_dashboard/personas", "POST", {"id": "persona-new"}, "添加并检查平台账号"),
    (1, "添加并检查平台账号", "/api/persona_dashboard/automation/accounts", "POST", {"account": {"id": "account-new"}}, "生成第一批推文"),
    (2, "生成第一批推文", "/api/persona_dashboard/personas/p1/generate_posts/tasks/t1", "GET", {"task": {"status": "success"}}, "把内容交给任务流程"),
    (3, "把内容交给任务流程", "/api/persona_dashboard/personas/p1/posts/post1/publish", "POST", {"task": {"id": "publish-new"}}, "回到看板查看结果"),
    (4, "回到看板查看结果", "/api/persona_dashboard/refresh/refresh1", "GET", {"status": "success"}, "已完成全部提示"),
)


def _launch_browser(playwright):
    candidates = (
        Path.home() / "AppData/Local/ms-playwright/chromium-1194/chrome-win/chrome.exe",
        Path.home() / "AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe",
    )
    for candidate in candidates:
        if candidate.exists():
            return playwright.chromium.launch(headless=True, executable_path=str(candidate))
    return playwright.chromium.launch(headless=True)


@pytest.mark.parametrize("step_index,title,url,method,payload,next_title", STEP_CASES)
def test_each_business_success_advances_without_reopening_old_prompt(
    step_index, title, url, method, payload, next_title
):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page(viewport={"width": 390, "height": 844})

        def route_request(route):
            request_url = route.request.url
            if request_url == "http://onboarding.test/":
                route.fulfill(status=200, content_type="text/html", body=PAGE_HTML)
                return
            if request_url.endswith("/api/me"):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"id": 7, "is_admin": False, "acting_admin": False}))
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

        page.route("**/*", route_request)
        page.add_init_script(
            f"localStorage.setItem({json.dumps(STORAGE_KEY)}, {json.dumps(json.dumps({'version': '2026.08', 'status': 'active', 'step': step_index, 'completedSteps': []}))});"
        )
        page.goto("http://onboarding.test/")
        page.add_script_tag(content=ONBOARDING_SCRIPT)

        page.locator(".console-onboarding-beacon").wait_for()
        assert page.locator(".console-onboarding-beacon").count() == 1
        page.locator(".console-onboarding-beacon").click()
        card = page.locator(".console-onboarding-card")
        assert card.locator("h2").inner_text() == title
        assert card.locator("[data-onboarding-start]").count() == 0
        assert card.locator("[data-onboarding-jump]").count() == 0
        assert card.locator("[data-onboarding-next], [data-onboarding-complete]").count() == 1

        targets = (
            "[data-persona-open-create]",
            "[data-account-pool-add]",
            "[data-persona-generate-posts]",
            "[data-persona-publish-submit]",
            "#btnPersonaDashboardSync",
        )
        page.locator(targets[step_index]).click()
        page.evaluate(
            "([requestUrl, requestMethod]) => fetch(requestUrl, { method: requestMethod }).then((response) => response.json())",
            [url, method],
        )
        page.locator(".console-onboarding-card h2").filter(has_text=next_title).wait_for(timeout=4000)

        if step_index < 4:
            assert page.locator(".console-onboarding-beacon").count() == 1
            assert page.locator(f'.console-onboarding-beacon[data-target-id="{STEP_IDS[step_index + 1]}"]').count() == 1
            assert page.locator(f'.console-onboarding-beacon[data-target-id="{STEP_IDS[step_index]}"]').count() == 0
            stored = json.loads(page.evaluate(f"localStorage.getItem({json.dumps(STORAGE_KEY)})"))
            assert stored["step"] == step_index + 1
            assert STEP_IDS[step_index] in stored["completedSteps"]
        else:
            assert page.locator(".console-onboarding-beacon").count() == 0
            stored = json.loads(page.evaluate(f"localStorage.getItem({json.dumps(STORAGE_KEY)})"))
            assert stored["status"] == "completed"
            assert STEP_IDS[step_index] in stored["completedSteps"]
        browser.close()
