from pathlib import Path

import pytest

from webapp import server


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = ROOT / "webapp" / "static" / "assets" / "console.js"
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"
PERSONA_WORKFLOW = ROOT / "tool_r18" / "scripts" / "skills" / "persona-create-workflow.ts"


def test_post_direction_helper_uses_persona_input_and_previous_batch(monkeypatch):
    captured = {}
    generated = ["理发沟通", "发型误区", "染发维护", "客诉复盘", "工具选择", "脸型判断", "造型教学", "行业观察", "门店故事", "季节护理"]
    archive = {
        "id": "persona-1",
        "name": "理发师",
        "content": "专注真实理发现场和发型建议",
        "setup": {
            "personaDescription": "社区理发师",
            "personaPersonality": "直接、耐心",
            "personaStyle": "日常口吻",
            "contentTheme": "发型护理",
            "interests": ["剪发", "染发"],
        },
    }

    monkeypatch.setattr(server, "_persona_archive_source_for_write", lambda _archive_id: (Path("unused"), {}, [archive]))

    def fake_cli(payload, timeout_seconds=0):
        captured.update(payload)
        captured["timeout_seconds"] = timeout_seconds
        return {"keywords": generated}

    monkeypatch.setattr(server, "_run_persona_create_cli", fake_cli)
    payload = server.PersonaDashboardPostDirectionsPayload(
        input_title="夏季短发",
        input_content="想写给第一次剪短发的客人",
        interface_language="zh-Hant",
        previous_keywords=["旧方向"],
    )

    result = server._persona_dashboard_suggest_post_directions("persona-1", payload)

    assert result["keywords"] == generated
    assert result["source"] == "content"
    assert captured["action"] == "suggest-post-directions"
    assert "理发师" in captured["personaCore"]
    assert "夏季短发" in captured["userContent"]
    assert captured["previousKeywords"] == ["旧方向"]
    assert captured["interfaceLanguage"] == "zh-Hant"
    assert captured["timeout_seconds"] == 90


def test_post_direction_helper_rejects_a_replayed_previous_batch(monkeypatch):
    previous = [f"方向{i}" for i in range(1, 11)]
    archive = {
        "id": "persona-1",
        "name": "理发师",
        "content": "专注真实理发现场和发型建议",
        "setup": {},
    }
    monkeypatch.setattr(server, "_persona_archive_source_for_write", lambda _archive_id: (Path("unused"), {}, [archive]))
    monkeypatch.setattr(server, "_run_persona_create_cli", lambda _payload, timeout_seconds=0: {"keywords": previous})

    with pytest.raises(server.HTTPException) as error:
        server._persona_dashboard_suggest_post_directions(
            "persona-1",
            server.PersonaDashboardPostDirectionsPayload(previous_keywords=previous),
        )

    assert error.value.status_code == 502
    assert "上一批" in str(error.value.detail)


def test_selected_directions_are_highest_topic_priority_without_losing_locale():
    instruction = server._build_persona_generate_instruction(
        server.PersonaDashboardGeneratePostsPayload(
            writing_locale="ja-JP",
            selected_directions=["客人常见误区", "剪发前沟通"],
            selected_memory_summaries=["记忆内容"],
        )
    )

    assert "Target writing locale: ja-JP" in instruction
    assert "User-selected post directions (highest topic priority): 客人常见误区 / 剪发前沟通" in instruction
    assert "Do not merely list or explain the keywords" in instruction


def test_generate_posts_passes_clean_trend_topic_context_to_the_node_workflow(monkeypatch):
    captured = {}
    monkeypatch.setattr(server, "_list_persona_archive_posts", lambda *_args, **_kwargs: [])

    def fake_workflow(payload):
        captured.update(payload)
        return {"postIds": [], "posts": []}

    monkeypatch.setattr(server, "_run_persona_workflow_cli", fake_workflow)
    payload = server.PersonaDashboardGeneratePostsPayload(
        prompt="第一次剪短发怎么沟通",
        selected_directions=["夏季短发沟通", "发型护理"],
        selected_memory_summaries=["客人上次剪了层次短发"],
    )

    server._generate_persona_archive_posts("persona-1", payload)

    assert captured["trendTopicContext"] == {
        "userInput": "第一次剪短发怎么沟通",
        "selectedDirections": ["夏季短发沟通", "发型护理"],
        "selectedMemorySummaries": ["客人上次剪了层次短发"],
    }


def test_console_uses_two_stage_direction_picker_for_normal_and_batch_posts():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    styles = CONSOLE_CSS.read_text(encoding="utf-8")

    assert "postDirectionsByMode" in script
    assert 'tweet: defaultPersonaPostDirectionState()' in script
    assert 'tweet_media: defaultPersonaPostDirectionState()' in script
    assert "/post_directions" in script
    assert "selected_directions" in script
    assert "data-persona-post-direction-keyword" in script
    assert "换一批" in script
    assert "handlePersonaGeneratePrimaryAction" in script
    assert ".persona-post-direction-panel" in styles
    assert ".persona-post-direction-tag.is-selected" in styles


def test_mobile_direction_picker_keeps_actions_aligned_and_reuses_selection_icons():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    styles = CONSOLE_CSS.read_text(encoding="utf-8")

    picker = script.split("function renderPersonaPostDirectionPicker", 1)[1].split(
        "function persistPersonaHotImports", 1
    )[0]

    assert picker.count("data-persona-post-direction-selection=") == 1
    assert 'data-persona-post-direction-selection="${allSelected ? "clear" : "all"}"' in picker
    assert "renderSelectAllIcon()" in picker
    assert "renderClearSelectionIcon()" in picker
    assert "[data-persona-post-direction-selection]" in script
    assert ".persona-post-direction-tools" in styles
    assert ".persona-generate-ai-action .ui-refresh-icon" in styles
    assert "stroke: currentColor" in styles
    assert ".persona-generate-ai-action .task-button-busy > span" in styles


def test_generated_post_media_action_scrolls_to_the_media_composer():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    resolver = script.split("async function resolvePersonaOrdinaryGeneratedCandidates", 1)[1].split(
        "function personaPostGenerationTaskStorageKey", 1
    )[0]
    generator = script.split("async function generatePersonaDraftPosts", 1)[1].split(
        "async function completePersonaPostGenerationTask", 1
    )[0]

    assert 'selection.action === "media"' in resolver
    assert "scrollPersonaMediaComposerIntoView" not in resolver
    scroller = script.split("function scrollPersonaMediaComposerIntoView", 1)[1].split(
        "async function resolvePersonaOrdinaryGeneratedCandidates", 1
    )[0]
    assert scroller.count("pendingPersonaMediaScrollId") >= 3
    assert "selectedPersona()?.id" in scroller
    assert scroller.index("selectedPersona()?.id") < scroller.index('document.querySelector("[data-persona-run-media-task]")')
    finalizer = generator.split("} finally {", 1)[1]
    assert finalizer.index("cancelScheduledPersonaDetailRender();") < finalizer.index("renderPersonaDetail();")
    assert finalizer.index("renderPersonaDetail();") < finalizer.index("scrollPersonaMediaComposerIntoView")
    assert "scroll-margin-top: calc(var(--site-header-height) + 59px);" in CONSOLE_CSS.read_text(encoding="utf-8")


def test_generated_selection_mobile_actions_stay_on_one_row_with_discard_at_right():
    styles = CONSOLE_CSS.read_text(encoding="utf-8")
    mobile_block = styles.split(
        '.console-modal[data-modal-key="persona-generated-selection"] .console-modal-actions {',
        1,
    )[1].split(".persona-generated-selection-card {", 1)[0]

    assert "display: flex;" in mobile_block
    assert "flex-wrap: nowrap;" in mobile_block
    assert '[data-console-modal-value="discard"]' in mobile_block
    assert "margin-left: auto;" in mobile_block
    assert "grid-template-columns: repeat(2" not in mobile_block


def test_model_prompt_requires_ten_distinct_directions_and_input_decomposition():
    source = PERSONA_WORKFLOW.read_text(encoding="utf-8")

    assert "POST_DIRECTION_KEYWORD_COUNT = 10" in source
    assert 'action: "suggest-post-directions"' in source
    assert "主题、对象、场景、痛点、立场和预期结果" in source
    assert "不要输出近义改写或上下位重复" in source
    assert "尽量避开上一批关键词及其近义表达" in source
    assert "interfaceLanguage" in source
    assert "統一輸出繁體中文" in source
