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


def test_post_image_render_styles_are_grouped_before_generation_and_keep_original_pipeline_as_default():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.add_script_tag(path=str(CONSOLE_JS))

        result = page.evaluate(
            """() => {
              const mediaForm = {};
              normalizePersonaMediaGenerationForm(mediaForm);
              const host = document.createElement("div");
              host.innerHTML = renderPersonaPostImageRenderStylePicker(mediaForm);
              document.body.append(host);
              const initial = {
                count: host.querySelectorAll("[data-persona-image-render-style]").length,
                groupCount: host.querySelectorAll(".persona-post-image-render-style-group").length,
                radioGroupCount: host.querySelectorAll('[role="radiogroup"]').length,
                semanticGroupCount: host.querySelectorAll('.persona-post-image-render-style-group[role="group"]').length,
                checked: host.querySelector('[data-persona-image-render-style][aria-checked="true"]')?.dataset.personaImageRenderStyle || "",
                labels: Array.from(host.querySelectorAll("[data-persona-image-render-style] strong"), (node) => node.textContent.trim()),
              };
              const selected = selectPersonaPostImageRenderStyle(mediaForm, "cinematic_cg");
              const rejected = selectPersonaPostImageRenderStyle(mediaForm, "../../custom-prompt");
              host.innerHTML = renderPersonaPostImageRenderStylePicker(mediaForm);
              return {
                initial,
                selected,
                rejected,
                value: mediaForm.imageRenderStyle,
                checked: host.querySelector('[data-persona-image-render-style][aria-checked="true"]')?.dataset.personaImageRenderStyle || "",
                checkedCount: host.querySelectorAll('[data-persona-image-render-style][aria-checked="true"]').length,
              };
            }"""
        )

        assert result["initial"]["count"] == 14
        assert result["initial"]["groupCount"] == 4
        assert result["initial"]["radioGroupCount"] == 1
        assert result["initial"]["semanticGroupCount"] == 4
        assert result["initial"]["checked"] == "original"
        assert "原有风格（默认）" in result["initial"]["labels"]
        assert "赛璐璐" in result["initial"]["labels"]
        assert "影视 CG" in result["initial"]["labels"]
        assert "3 渲 2" in result["initial"]["labels"]
        assert "美式卡通" in result["initial"]["labels"]
        assert result["selected"] is True
        assert result["rejected"] is False
        assert result["value"] == "cinematic_cg"
        assert result["checked"] == "cinematic_cg"
        assert result["checkedCount"] == 1
        browser.close()


def test_stale_composition_direction_is_cleared_when_post_content_changes():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.add_script_tag(path=str(CONSOLE_JS))

        result = page.evaluate(
            """() => {
              const form = { imageStylesByPost: {} };
              personaFormState = () => form;
              const post = { id: "post-1", title: "旧标题", content: "旧正文" };
              const oldFingerprint = personaImageStyleSourceFingerprint(post);
              const styleState = personaImageStyleState("persona-1", post.id);
              styleState.styles = [{ kind: "scene", label: "旧场景", kind_label: "场景" }];
              styleState.selectedKey = personaImageStyleKey(styleState.styles[0]);
              styleState.sourceFingerprint = oldFingerprint;
              const nextPost = { ...post, title: "新标题", content: "新正文" };
              const rows = personaImageStylesForPost("persona-1", post.id, personaImageStyleSourceFingerprint(nextPost));
              const refreshedState = personaImageStyleState("persona-1", post.id);
              return { count: rows.length, selectedKey: refreshedState.selectedKey, sourceFingerprint: refreshedState.sourceFingerprint };
            }"""
        )

        assert result == {"count": 0, "selectedKey": "", "sourceFingerprint": ""}
        browser.close()


def test_mobile_composition_cards_keep_kind_and_description_visible_and_task_preview_is_eager():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.set_content('<!doctype html><html><body class="console-page"><div id="host"></div></body></html>')
        page.add_script_tag(path=str(CONSOLE_JS))
        page.add_style_tag(path=str(CONSOLE_CSS))
        result = page.evaluate(
            """() => {
              const form = { media: { imageStylesByPost: {} } };
              personaFormState = () => form;
              currentLanguage = () => "zh-Hans";
              isActionLocked = () => false;
              const post = { id: "post-1", title: "健身", content: "记录训练动作" };
              const styleState = personaImageStyleState("persona-1", post.id);
              styleState.styles = [
                { kind: "person", label: "人物自拍", kind_label: "人物" },
                { kind: "third_person", label: "群像互动", kind_label: "群像" },
                { kind: "third_person", label: "第三人称纪实", kind_label: "第三人称" },
                { kind: "pov", label: "第一人称视角", kind_label: "第一人称" },
                { kind: "scene", label: "环境场景", kind_label: "场景" },
                { kind: "object", label: "物件特写", kind_label: "事物" },
              ];
              styleState.sourceFingerprint = personaImageStyleSourceFingerprint(post);
              const host = document.querySelector("#host");
              host.innerHTML = renderPersonaImageCompositionPicker({ id: "persona-1" }, post);
              const cards = Array.from(host.querySelectorAll(".persona-image-composition-tag"));
              return {
                count: cards.length,
                kind: cards[2].querySelector(".persona-image-composition-tag-kind")?.textContent.trim(),
                label: cards[2].querySelector(".persona-image-composition-tag-label")?.textContent.trim(),
                whiteSpace: getComputedStyle(cards[2]).whiteSpace,
                overflow: getComputedStyle(cards[2]).overflow,
                minHeight: parseFloat(getComputedStyle(cards[2]).minHeight),
                clientHeight: cards[2].clientHeight,
                scrollHeight: cards[2].scrollHeight,
              };
            }"""
        )
        assert result["count"] == 6
        assert result["kind"] == "第三人称"
        assert result["label"] == "第三人称纪实"
        assert result["whiteSpace"] == "normal"
        assert result["overflow"] == "visible"
        assert result["minHeight"] >= 50
        assert result["scrollHeight"] <= result["clientHeight"] + 1
        browser.close()


def test_composition_picker_spacing_and_nested_scroll_are_preserved_on_rerender():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page(viewport={"width": 1024, "height": 844})
        page.set_content(
            '''<!doctype html><html><body class="console-page">
              <main id="moduleBody"><section data-persona-image-composition-post="post-1">
                <div class="persona-picker-list" style="height:140px">
                  <button class="persona-picker-option"><strong>群像</strong><small>群像互动</small></button>
                  <button class="persona-picker-option"><strong>场景</strong><small>环境场景</small></button>
                  <button class="persona-picker-option"><strong>物件</strong><small>物件特写</small></button>
                </div>
              </section></main>
            </body></html>'''
        )
        page.add_style_tag(path=str(CONSOLE_CSS))
        page.add_script_tag(path=str(CONSOLE_JS))
        result = page.evaluate(
            """async () => {
              const list = document.querySelector('.persona-picker-list');
              list.scrollTop = 37;
              const snapshot = snapshotConsoleScrollState();
              document.querySelector('#moduleBody').innerHTML = `<section data-persona-image-composition-post="post-1">
                <div class="persona-picker-list" style="height:140px">
                  <button class="persona-picker-option"><strong>群像</strong><small>群像互动</small></button>
                  <button class="persona-picker-option"><strong>场景</strong><small>环境场景</small></button>
                  <button class="persona-picker-option"><strong>物件</strong><small>物件特写</small></button>
                </div>
              </section>`;
              restoreConsoleScrollState(snapshot);
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const next = document.querySelector('.persona-picker-list');
              const option = document.querySelector('.persona-picker-option');
              const style = getComputedStyle(option);
              return {
                scrollTop: next.scrollTop,
                minHeight: parseFloat(style.minHeight),
                paddingTop: parseFloat(style.paddingTop),
                paddingLeft: parseFloat(style.paddingLeft),
              };
            }"""
        )
        assert result["scrollTop"] == 37
        assert result["minHeight"] >= 64
        assert result["paddingTop"] >= 10
        assert result["paddingLeft"] >= 12
        browser.close()


def test_post_image_render_style_selection_is_locked_immediately_during_submission():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.add_script_tag(path=str(CONSOLE_JS))
        result = page.evaluate(
            """() => {
              const mediaForm = { imageRenderStyle: "cel_shading" };
              document.body.innerHTML = renderPersonaPostImageRenderStylePicker(mediaForm);
              setPersonaPostImageRenderStyleInteractionLocked(true);
              const locked = Array.from(document.querySelectorAll("[data-persona-image-render-style]"), (button) => button.disabled);
              const selectedWhileLocked = document.querySelector('[data-persona-image-render-style="cel_shading"]')?.getAttribute("aria-checked");
              const lockedCopy = renderPersonaPostImageRenderStylePicker(mediaForm, true);
              setPersonaPostImageRenderStyleInteractionLocked(false);
              const unlocked = Array.from(document.querySelectorAll("[data-persona-image-render-style]"), (button) => button.disabled);
              return { locked, unlocked, selectedWhileLocked, lockedCopy };
            }"""
        )
        assert all(result["locked"])
        assert not any(result["unlocked"])
        assert result["selectedWhileLocked"] == "true"
        assert "配图生成期间已锁定，完成后可重新选择" in result["lockedCopy"]
        assert 'data-persona-image-render-style="cel_shading"' in result["lockedCopy"]
        browser.close()


def test_mobile_stop_task_button_matches_running_button_width_and_height():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.set_content(
            '''<!doctype html><html><body class="console-page">
            <div class="persona-media-task-actions">
              <button type="button" class="primary" data-persona-run-media-task disabled>
                <span class="task-button-busy"><svg class="task-button-spinner" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle></svg><span>配图任务执行中</span><time>00:07</time></span>
              </button>
              <button type="button" class="danger" data-persona-cancel-media-task="task-1">停止任务</button>
            </div></body></html>'''
        )
        page.add_style_tag(path=str(CONSOLE_CSS))
        boxes = page.locator(".persona-media-task-actions > button").evaluate_all(
            "buttons => buttons.map(button => button.getBoundingClientRect().toJSON())"
        )
        assert len(boxes) == 2
        assert abs(boxes[0]["width"] - boxes[1]["width"]) <= 1
        assert abs(boxes[0]["height"] - boxes[1]["height"]) <= 1
        browser.close()


def test_post_and_image_sections_use_responsive_dividers_without_mobile_overflow():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.set_content('''<!doctype html><html><body class="console-page">
          <main class="persona-compose-workspace has-media">
            <section class="persona-compose-copy">生成推文</section>
            <section class="persona-compose-media-stack" id="mediaStack"></section>
          </main>
        </body></html>''')
        page.add_script_tag(path=str(CONSOLE_JS))
        page.add_style_tag(path=str(CONSOLE_CSS))
        page.evaluate(
            """() => {
              document.querySelector('#mediaStack').innerHTML = `${renderPersonaPostImageRenderStylePicker({})}
                <div class="persona-post-image-settings-divider"><span>构图方向</span></div>`;
            }"""
        )

        desktop = page.locator(".persona-compose-media-stack").evaluate(
            """node => ({
              left: getComputedStyle(node).borderLeftWidth,
              top: getComputedStyle(node).borderTopWidth,
              panel: getComputedStyle(node.querySelector(".persona-post-image-render-style-panel")).borderTopWidth,
              divider: getComputedStyle(node.querySelector(".persona-post-image-settings-divider"), "::before").backgroundColor,
              groups: node.querySelectorAll(".persona-post-image-render-style-group").length,
              options: node.querySelectorAll("[data-persona-image-render-style]").length,
            })"""
        )
        assert desktop["left"] == "1px"
        assert desktop["top"] == "0px"
        assert desktop["panel"] == "1px"
        assert desktop["divider"] != "rgba(0, 0, 0, 0)"
        assert desktop["groups"] == 4
        assert desktop["options"] == 14

        for width in (390, 320):
            page.set_viewport_size({"width": width, "height": 844})
            mobile = page.evaluate(
                """() => {
                  const node = document.querySelector(".persona-compose-media-stack");
                  const panel = document.querySelector(".persona-post-image-render-style-panel").getBoundingClientRect();
                  const optionRects = Array.from(document.querySelectorAll("[data-persona-image-render-style]"), (button) => button.getBoundingClientRect());
                  const style = getComputedStyle(node);
                  return {
                    left: style.borderLeftWidth,
                    top: style.borderTopWidth,
                    overflow: document.documentElement.scrollWidth > window.innerWidth,
                    columns: getComputedStyle(document.querySelector(".persona-post-image-render-style-grid")).gridTemplateColumns.split(" ").length,
                    optionsInside: optionRects.every((rect) => rect.left >= panel.left - 1 && rect.right <= panel.right + 1),
                  };
                }"""
            )
            assert mobile == {"left": "0px", "top": "1px", "overflow": False, "columns": 2, "optionsInside": True}
        browser.close()
