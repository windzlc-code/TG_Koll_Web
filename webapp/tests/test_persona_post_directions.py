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


def test_model_prompt_requires_ten_distinct_directions_and_input_decomposition():
    source = PERSONA_WORKFLOW.read_text(encoding="utf-8")

    assert "POST_DIRECTION_KEYWORD_COUNT = 10" in source
    assert 'action: "suggest-post-directions"' in source
    assert "主题、对象、场景、痛点、立场和预期结果" in source
    assert "不要输出近义改写或上下位重复" in source
    assert "尽量避开上一批关键词及其近义表达" in source
    assert "interfaceLanguage" in source
    assert "統一輸出繁體中文" in source
