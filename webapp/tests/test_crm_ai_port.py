from __future__ import annotations

import json

import pytest

from webapp.crm.ai_port import (
    analyze_demand,
    generate_public_comment_drafts,
    generate_targeted_comment_followup,
)
from webapp.crm.errors import CRMError
from webapp.crm.legacy_operations import TenantContext


def _keywords(prefix: str) -> list[str]:
    return [f"{prefix}{index}" for index in range(1, 13)]


def _pool(*leads, pool_id: str = "pool-one", category: str = "general"):
    return {
        "id": pool_id,
        "name": "核心客户池",
        "businessCategory": category,
        "leads": list(leads),
    }


def _lead(lead_id: str, username: str, source_url: str, text: str, **extra):
    return {
        "id": lead_id,
        "username": username,
        "platform": "threads",
        "sourceUrl": source_url,
        "text": text,
        "tags": ["高意向", "近期互动"],
        **extra,
    }


def test_demand_analysis_preserves_legacy_fields_and_uses_tenant_provider_without_secrets():
    observed = []

    def provider(tenant, request):
        observed.append((tenant, request))
        return {
            "title": "正在寻找自动化获客的品牌经营者",
            "intent": "高",
            "need": "稳定获得潜在客户",
            "pain": "社群运营人力不足",
            "signal": "主动询问获客工具",
            "channel": "Threads＋Instagram",
            "segments": ["电商品牌主", "社群运营负责人"],
            "scenarios": ["寻找自动化工具", "比较获客方案"],
            "keywordGroups": [{"name": "角色", "keywords": _keywords("角色")[:4]}],
            "keywords": _keywords("关键词"),
            "model": "configured-model",
        }

    result = analyze_demand(
        TenantContext(user_id=7, locale="zh-Hans", request_id="req-one"),
        {"text": "电商品牌希望通过 Threads 自动获客", "locale": "zh-Hans"},
        llm_provider=provider,
    )

    assert set(result) == {
        "title", "intent", "need", "pain", "signal", "channel", "segments",
        "scenarios", "keywordGroups", "keywords", "engine", "model", "fallback",
        "fallbackReason", "estimatedSearches",
    }
    assert result["title"] == "正在寻找自动化获客的品牌经营者"
    assert result["engine"] == "AI 分析"
    assert result["fallback"] is False
    assert result["estimatedSearches"] == 16
    assert observed[0][0].user_id == 7
    assert observed[0][1]["operation"] == "crm_demand_analysis"
    assert observed[0][1]["locale"] == "zh-Hans"
    serialized = json.dumps(observed[0][1], ensure_ascii=False).lower()
    assert "api_key" not in serialized
    assert "password" not in serialized
    assert "secret" not in serialized


@pytest.mark.parametrize(
    ("locale", "text", "expected_engine", "expected_title_fragment"),
    [
        ("zh-Hans", "电商品牌缺少营销人力，需要自动获客", "本地 AI 回退", "品牌经营者"),
        ("zh-Hant", "電商品牌缺少行銷人力，需要自動獲客", "本機 AI 備援", "品牌經營者"),
    ],
)
def test_demand_analysis_has_deterministic_simplified_and_traditional_fallbacks(
    locale, text, expected_engine, expected_title_fragment
):
    result = analyze_demand(
        TenantContext(user_id=3, locale=locale),
        {"text": text},
        llm_provider=lambda _tenant, _request: {"keywords": ["太少"]},
    )
    assert result["fallback"] is True
    assert result["engine"] == expected_engine
    assert expected_title_fragment in result["title"]
    assert 12 <= len(result["keywords"]) <= 24
    assert result["fallbackReason"] == "provider_failed_or_invalid"
    assert "�" not in json.dumps(result, ensure_ascii=False)


def test_public_comment_drafts_keep_progress_order_apply_partial_ai_and_local_fallback():
    first = _lead(
        "lead-one", "alice", "https://www.threads.net/@alice/post/one",
        "最近在比较品牌获客工具，团队人力很有限。",
    )
    second = _lead(
        "lead-two", "bob", "https://www.threads.net/@bob/post/two",
        "想了解 Threads 内容运营怎样提高互动。",
    )
    processed = _lead(
        "lead-old", "old", "https://www.threads.net/@old/post/done", "已经处理",
    )
    pool = _pool(first, second, processed)
    tasks = [{
        "type": "comment",
        "poolId": "pool-one",
        "result": {"results": [{"sourcePostUrl": processed["sourceUrl"], "published": True}]},
    }]
    observed_targets = []

    def provider(_tenant, request):
        assert request["operation"] == "crm_public_comment_drafts"
        observed_targets.extend(request["targets"])
        return {
            "drafts": [{
                "id": request["targets"][0]["id"],
                "comment": "你提到团队人力有限，这确实是自动化工具最需要解决的具体问题。",
            }],
            "model": "configured-model",
        }

    result = generate_public_comment_drafts(
        TenantContext(user_id=9, locale="zh-Hans"),
        {
            "poolId": "pool-one",
            "selectedLeadIds": ["lead-one", "lead-two", "lead-old"],
            "limit": 20,
            "replyStrategy": "question_hook",
            "mentionSourceAuthor": True,
        },
        pool=pool,
        tasks=tasks,
        llm_provider=provider,
        id_factory=lambda prefix: f"{prefix}-fixed",
    )

    assert result["engine"] == "AI 分析"
    assert result["warning"] == "1 则使用本地回退草稿"
    assert result["progress"]["processedLeadIds"] == ["lead-old"]
    assert result["progress"]["remainingLeadIds"] == ["lead-one", "lead-two"]
    assert [draft["leadId"] for draft in result["data"]] == ["lead-one", "lead-two"]
    assert observed_targets[0]["post"].startswith("最近在比较")
    assert result["data"][0]["comment"].startswith("@alice ")
    assert result["data"][0]["comment"].endswith("？")
    assert result["data"][1]["selected"] is True
    assert result["data"][1]["comment"].startswith("@bob ")


def test_public_comment_local_fallback_filters_duplicate_urls_and_contact_data():
    lead = _lead(
        "lead-one", "alice", "https://www.threads.com/@alice/post/one",
        "首购房贷正在比较利率和额度。",
    )
    duplicate = _lead(
        "lead-two", "duplicate", lead["sourceUrl"], "重复来源",
    )
    result = generate_public_comment_drafts(
        TenantContext(user_id=9, locale="zh-Hant"),
        {
            "poolId": "pool-one",
            "contactInstruction": "LINE: abc https://bad.example 0912345678",
            "hookInstruction": "保證核准，利率 1.8%",
            "replyStrategy": "question_hook",
        },
        pool=_pool(lead, duplicate, category="mortgage"),
        tasks=[],
        llm_provider=lambda _tenant, _request: (_ for _ in ()).throw(RuntimeError("offline")),
        id_factory=lambda prefix: f"{prefix}-fixed",
    )
    assert result["engine"] == "本機 AI 備援"
    assert len(result["data"]) == 1
    assert result["progress"]["eligibility"]["duplicateSourcePost"] == 1
    comment = result["data"][0]["comment"]
    assert "http" not in comment
    assert "LINE" not in comment
    assert "0912345678" not in comment
    assert "保證核准" not in comment
    assert "房貸" in comment


def test_targeted_followup_requires_verified_visible_comment():
    task = {
        "id": "task-one",
        "type": "comment",
        "poolId": "pool-one",
        "items": [{
            "id": "item-one", "leadId": "lead-one", "username": "alice",
            "platform": "threads", "sourcePostUrl": "https://www.threads.net/@alice/post/one",
            "comment": "原留言内容",
        }],
        "result": {"results": [{"id": "item-one", "published": False}]},
    }
    with pytest.raises(CRMError) as blocked:
        generate_targeted_comment_followup(
            TenantContext(user_id=9, locale="zh-Hans"),
            {"taskId": "task-one", "itemId": "item-one"},
            task=task,
            pool=_pool(_lead("lead-one", "alice", "https://www.threads.net/@alice/post/one", "原文")),
        )
    assert blocked.value.code == "crm_followup_evidence_required"


def test_targeted_followup_uses_reply_context_sanitizes_ai_and_preserves_legacy_shape():
    lead = _lead(
        "lead-one", "alice", "https://www.threads.net/@alice/post/one",
        "我们正在比较自动化获客工具。",
    )
    task = {
        "id": "task-one",
        "type": "comment",
        "poolId": "pool-one",
        "items": [{
            "id": "item-one", "leadId": "lead-one", "username": "alice",
            "platform": "threads", "sourcePostUrl": lead["sourceUrl"],
            "comment": "团队规模不同，适合的工具也不一样。",
        }],
        "result": {"results": [{
            "id": "item-one", "published": True,
            "comment": "团队规模不同，适合的工具也不一样。",
            "replyEvidence": "我们团队只有两个人",
        }]},
    }
    observed = {}

    def provider(_tenant, request):
        observed.update(request)
        return {
            "comment": "你提到团队只有两个人，可以先比较日常维护时间。LINE: spam https://bad.example 你最想减少哪一步？",
            "model": "configured-model",
        }

    result = generate_targeted_comment_followup(
        TenantContext(user_id=9, locale="zh-Hans"),
        {
            "taskId": "task-one", "itemId": "item-one",
            "instruction": "补充维护成本", "mentionSourceAuthor": True,
        },
        task=task,
        pool=_pool(lead),
        llm_provider=provider,
    )
    assert set(result) == {"draft", "engine", "warning"}
    assert result["engine"] == "AI 分析"
    assert result["warning"] == ""
    assert result["draft"]["taskId"] == "task-one"
    assert result["draft"]["itemId"] == "item-one"
    assert result["draft"]["replyEvidence"] == "我们团队只有两个人"
    assert result["draft"]["comment"].startswith("@alice ")
    assert "LINE" not in result["draft"]["comment"]
    assert "http" not in result["draft"]["comment"]
    assert observed["operation"] == "crm_targeted_comment_followup"
    assert observed["replyEvidence"] == "我们团队只有两个人"


def test_targeted_followup_uses_locale_fallback_when_provider_repeats_original():
    lead = _lead(
        "lead-one", "alice", "https://www.threads.net/@alice/post/one",
        "房貸除了利率还要比较额度。",
    )
    previous = "房貸利率與額度要一起比較。"
    task = {
        "id": "task-one",
        "type": "comment",
        "poolId": "pool-one",
        "items": [{
            "id": "item-one", "leadId": "lead-one", "username": "alice",
            "platform": "threads", "sourcePostUrl": lead["sourceUrl"], "comment": previous,
        }],
        "result": {"results": [{"id": "item-one", "published": True, "comment": previous}]},
    }
    result = generate_targeted_comment_followup(
        TenantContext(user_id=9, locale="zh-Hant"),
        {"taskId": "task-one", "itemId": "item-one", "mentionSourceAuthor": False},
        task=task,
        pool=_pool(lead, category="mortgage"),
        llm_provider=lambda _tenant, _request: {"comment": previous},
    )
    assert result["engine"] == "本機 AI 備援"
    assert result["warning"] == "provider_failed_or_invalid"
    assert result["draft"]["comment"] != previous
    assert "房貸" in result["draft"]["comment"]
