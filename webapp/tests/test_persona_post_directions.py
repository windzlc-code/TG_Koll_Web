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
    assert "previousImageStyles" not in captured
    assert captured["interfaceLanguage"] == "zh-Hant"
    assert captured["timeout_seconds"] == 90
    assert "image_styles" not in result


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

    assert captured["trendTopicContext"].pop("writingLocale") == "zh-TW"
    assert captured["trendTopicContext"] == {
        "userInput": "第一次剪短发怎么沟通",
        "selectedDirections": ["夏季短发沟通", "发型护理"],
        "selectedMemorySummaries": ["客人上次剪了层次短发"],
    }


def test_generate_posts_includes_rewrite_source_in_trend_topic_context(monkeypatch):
    captured = {}
    monkeypatch.setattr(server, "_list_persona_archive_posts", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(
        server,
        "_run_persona_workflow_cli",
        lambda payload: captured.update(payload) or {"postIds": [], "posts": []},
    )

    server._generate_persona_archive_posts(
        "persona-1",
        server.PersonaDashboardGeneratePostsPayload(
            rewrite_source_title="雨天剪髮",
            rewrite_source_content="客人擔心雨天剪短髮會毛躁",
            writing_locale="zh-TW",
        ),
    )

    assert captured["trendTopicContext"]["userInput"] == "雨天剪髮\n客人擔心雨天剪短髮會毛躁"


def test_console_uses_two_stage_direction_picker_for_normal_and_batch_posts():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    styles = CONSOLE_CSS.read_text(encoding="utf-8")

    assert "postDirectionsByMode" in script
    assert 'tweet: defaultPersonaPostDirectionState()' in script
    assert 'tweet_media: defaultPersonaPostDirectionState()' in script
    assert "/post_directions" in script
    assert "selected_directions" in script
    assert "data-persona-post-direction-keyword" in script
    assert "data-persona-image-style-index" in script
    assert "data-persona-generate-image-styles" in script
    assert "function renderPersonaImageStylePicker" in script
    assert "/image_styles" in script
    assert "选择配图风格" in script
    assert "image_mode" in script
    assert "image_style_label" in script
    assert "选择配图风格（可选）" in script
    assert "可直接按推文生成生活化人物自拍" in script
    assert '?.kind || "person"' in script
    assert "请先生成并选择一种配图风格" not in script
    assert 'targetState.selectedKey = ""' in script
    assert 'styleState.selectedKey === styleKey ? "" : styleKey' in script
    assert "160000" in script
    assert "换一批" in script
    assert "handlePersonaGeneratePrimaryAction" in script
    assert 'prompt: [String(draft.title || "").trim(), String(draft.content || "").trim()]' in script
    assert ".persona-post-direction-panel" in styles
    assert ".persona-post-direction-tag.is-selected" in styles
    assert ".persona-image-style-tag" in styles
    assert ".persona-image-style-action" in styles
    assert "grid-template-columns: repeat(2, minmax(0, 1fr))" in styles
    assert ".persona-post-direction-tools > .bulk-selection-icon-button" in styles


def test_mobile_direction_picker_keeps_actions_aligned_and_reuses_selection_icons():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    styles = CONSOLE_CSS.read_text(encoding="utf-8")

    picker = script.split("function renderPersonaPostDirectionPicker", 1)[1].split(
        "function renderPersonaImageStylePicker", 1
    )[0]
    style_picker = script.split("function renderPersonaImageStylePicker", 1)[1].split(
        "function persistPersonaHotImports", 1
    )[0]
    assert "选择配图风格" not in picker
    assert "data-persona-generate-image-styles" in style_picker
    assert "选择配图风格" in style_picker
    assert "data-persona-image-style-index" in style_picker
    assert "persona-image-style-action" in style_picker
    assert "personaImageStyleCaption" in script
    assert "persona-post-direction-tools" not in style_picker
    assert "data-persona-image-style-key" not in style_picker

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
    assert "POST_IMAGE_STYLE_COUNT = 6" in source
    assert 'action: "suggest-post-directions"' in source
    assert 'action: "suggest-image-styles"' in source
    assert "主题、对象、场景、痛点、立场和预期结果" in source
    assert "不要输出近义改写或上下位重复" in source
    assert "尽量避开上一批关键词及其近义表达" in source
    assert "image_styles" in source
    assert "third_person" in source
    assert "不能六条都是人物半身自拍" in source
    assert "interfaceLanguage" in source
    assert "統一輸出繁體中文" in source
    directions_fn = source.split("async function derivePostDirectionKeywordsWithCodex", 1)[1].split(
        "async function derivePostImageStylesWithCodex", 1
    )[0]
    assert "image_styles" not in directions_fn
    assert "runCodexJsonInstruction" in directions_fn
    assert "runTextModelJsonInstruction" not in directions_fn


def test_image_style_helper_requires_tweet_content(monkeypatch):
    archive = {
        "id": "persona-1",
        "name": "加班观察者",
        "content": "记录加班后的便利店瞬间",
        "setup": {},
        "posts": [{"id": "post-1", "title": "", "content": ""}],
    }
    monkeypatch.setattr(server, "_persona_archive_source_for_write", lambda _archive_id: (Path("unused"), {}, [archive]))

    with pytest.raises(server.HTTPException) as error:
        server._persona_dashboard_suggest_image_styles(
            "persona-1",
            server.PersonaDashboardImageStylesPayload(post_id="post-1"),
        )

    assert error.value.status_code == 400
    assert "正文" in str(error.value.detail)


def test_fallback_image_styles_cover_scene_object_and_person_for_convenience_store_tweet():
    styles = server._persona_fallback_image_styles(
        "今天路过便利店，买了杯冰美式，突然想起上次加班到很晚的那天",
        "那天加班到很晚，路过便利店买了杯冰美式。便利店的灯很亮，冰美式的苦味让人清醒。",
        interface_language="zh-Hans",
    )

    kinds = [item["kind"] for item in styles]
    labels = [item["label"] for item in styles]
    assert len(styles) == 6
    assert kinds.count("person") == 1
    assert kinds[0] == "person"
    assert "scene" in kinds
    assert "object" in kinds
    assert "pov" in kinds
    assert "third_person" in kinds
    assert any("便利店" in label for label in labels)
    assert any("冰美式" in label for label in labels)
    assert all("空镜" not in label and "无人" not in label for label in labels)


def test_fallback_image_styles_follow_luxury_home_tweet():
    styles = server._persona_fallback_image_styles(
        "台籍专属融资只做东京大阪顶级豪宅",
        "你以为在捡便宜，其实是买到无法脱手的资产。我们只做东京、大阪的顶级豪宅。",
        interface_language="zh-Hans",
    )
    labels = [item["label"] for item in styles]
    assert any("豪宅" in label or "东京" in label or "大阪" in label for label in labels)
    assert styles[0]["kind"] == "person"


def test_image_style_helper_prefers_model_labels_from_tweet(monkeypatch):
    archive = {
        "id": "persona-1",
        "name": "加班观察者",
        "content": "记录加班后的便利店瞬间",
        "setup": {"personaDescription": "都市上班族"},
        "posts": [{"id": "post-1", "title": "便利店冰美式", "content": "加班后买了杯冰美式"}],
    }
    captured = {}
    monkeypatch.setattr(server, "_persona_archive_source_for_write", lambda _archive_id: (Path("unused"), {}, [archive]))

    def fake_cli(payload, timeout_seconds=0):
        captured.update(payload)
        captured["timeout_seconds"] = timeout_seconds
        return {
            "image_styles": [
                {"kind": "person", "label": "加班后自拍"},
                {"kind": "scene", "label": "便利店街景"},
                {"kind": "object", "label": "冰美式特写"},
                {"kind": "pov", "label": "手拿冰美式"},
                {"kind": "third_person", "label": "路过便利店"},
                {"kind": "scene", "label": "便利店灯箱"},
            ],
        }

    monkeypatch.setattr(server, "_run_persona_create_cli", fake_cli)
    result = server._persona_dashboard_suggest_image_styles(
        "persona-1",
        server.PersonaDashboardImageStylesPayload(
            post_id="post-1",
            input_title="便利店冰美式",
            input_content="加班后买了杯冰美式",
        ),
    )

    assert captured["action"] == "suggest-image-styles"
    assert captured["timeout_seconds"] == 35
    kinds = [item["kind"] for item in result["image_styles"]]
    labels = [item["label"] for item in result["image_styles"]]
    assert kinds.count("person") == 1
    assert kinds[0] == "person"
    assert "便利店街景" in labels
    assert result["image_styles"][0]["kind_label"] == "人物"
    scene = next(item for item in result["image_styles"] if item["kind"] == "scene")
    assert scene["kind_label"] == "场景"
    assert "空镜" not in scene["label"]


def test_post_image_runner_passes_selected_image_style_mode(monkeypatch, tmp_path):
    archive = {
        "id": "persona-1",
        "name": "加班观察者",
        "content": "记录加班后的便利店瞬间",
        "setup": {},
        "personaReferenceSheet": "/data/persona/current.png",
        "personaImageLibrary": [{
            "id": "image-1",
            "imageUrl": "/data/persona/current.png",
            "prompt": "中国地区特征，18至22岁的成年女性，马尾，真实自然",
        }],
        "posts": [{"id": "post-1", "content": "路过便利店买了杯冰美式"}],
    }
    monkeypatch.setattr(server, "_persona_archive_source_for_write", lambda _archive_id: (tmp_path / "unused.json", {}, [archive]))
    monkeypatch.setattr(server, "_sync_tool_r18_api_config_for_persona_workflow", lambda: None)
    monkeypatch.setattr(server, "_persona_reference_image_input_for_cli", lambda _archive: None)
    monkeypatch.setattr(server, "_persist_generated_image_for_task", lambda *_args, **_kwargs: str(tmp_path / "out.png"))
    monkeypatch.setattr(server, "_resolve_persona_post_image_aspect_ratio", lambda *_args, **_kwargs: ("1:1", {"mode": "manual"}))
    monkeypatch.setattr(server, "_persist_persona_post_image_aspect_ratio", lambda *_args, **_kwargs: None)
    captured = {}

    def fake_run(command, **_kwargs):
        captured["payload"] = __import__("json").loads(command[-1])
        captured.setdefault("payloads", []).append(captured["payload"])
        return type("Completed", (), {"returncode": 0, "stdout": '{"ok": true, "imageResult": {"url": "data:image/png;base64,ZmFrZQ=="}}', "stderr": ""})()

    monkeypatch.setattr(server.subprocess, "run", fake_run)
    result = server._run_persona_post_image_task("task-1", {
        "related_persona_id": "persona-1",
        "related_post_id": "post-1",
        "image_mode": "scene",
        "image_style_label": "便利店夜景",
        "image_count": 1,
    })

    assert result["ok"] is True
    assert captured["payload"]["mode"] == "scene"
    assert captured["payload"]["styleHint"] == "便利店夜景"
    assert captured["payload"]["variationKey"] == "task-1:1:1"
    assert captured["payload"]["setup"]["personaReferenceIdentity"] == "中国地区特征，18至22岁的成年女性"

    default_result = server._run_persona_post_image_task("task-2", {
        "related_persona_id": "persona-1",
        "related_post_id": "post-1",
        "image_count": 1,
    })

    assert default_result["ok"] is True
    assert captured["payload"]["mode"] == "person"
    assert captured["payload"]["styleHint"] is None

    captured["payloads"].clear()
    multi_result = server._run_persona_post_image_task("task-3", {
        "related_persona_id": "persona-1",
        "related_post_id": "post-1",
        "image_count": 2,
    })

    assert multi_result["ok"] is True
    assert {payload["variationKey"] for payload in captured["payloads"]} == {
        "task-3:1:2",
        "task-3:2:2",
    }
