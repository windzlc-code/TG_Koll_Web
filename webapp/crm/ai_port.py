from __future__ import annotations

import inspect
import json
import re
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from urllib.parse import unquote, urlparse

from .errors import CRMError
from .legacy_operations import Provider, TenantContext, normalize_locale

JsonDict = dict[str, Any]
IdFactory = Callable[[str], str]

DEMAND_SCHEMA = "crm.ai-demand.v1"
COMMENT_DRAFT_SCHEMA = "crm.ai-comment-drafts.v1"
COMMENT_FOLLOWUP_SCHEMA = "crm.ai-comment-followup.v1"

_CONTACT_RE = re.compile(r"\b(?:LINE|WhatsApp|Telegram)\s*[:：@]\s*\S+", re.I)
_URL_RE = re.compile(r"https?://\S+", re.I)
_LONG_NUMBER_RE = re.compile(r"\b\d{8,}\b")
_PROMISE_RE = re.compile(r"(?:保证过件|保证核准|一定核准|百分之百核准|稳赚|保證過件|保證核准|穩賺)", re.I)
_PRIVATE_INVITE_RE = re.compile(r"(?:请私信|请私讯|私信我|私訊我|联系我|聯絡我|加我|欢迎加入|歡迎加入)", re.I)


_DEMAND_COPY: dict[str, dict[str, dict[str, Any]]] = {
    "zh-Hans": {
        "finance": {
            "title": "正在比较资金与贷款方案的决策者",
            "need": "取得合适额度并降低还款压力",
            "pain": "月付压力、申请条件与可贷额度不确定",
            "segments": ["有月付压力的贷款户", "需要营运周转的中小企业主", "比较转贷方案的房贷户", "近期咨询额度的资金需求者"],
            "scenarios": ["主动咨询贷款方案", "比较利率与申请条件", "分享还款压力", "寻找资金周转建议"],
            "keywords": ["房贷需求", "资金周转", "降低月付", "额度评估", "贷款比较", "整合负债", "月付压力", "银行贷款条件", "急需资金", "贷款咨询", "信用条件", "房贷转增贷", "负债整合建议", "贷款利率比较", "资金缺口", "企业周转金", "房贷月付太高", "如何提高额度", "贷款方案推荐", "近期想贷款", "首购房贷", "转贷条件", "房贷银行推荐", "贷款总成本"],
        },
        "business": {
            "title": "寻找增长与自动化方案的品牌经营者",
            "need": "快速找到可信且符合条件的增长方案",
            "pain": "资讯分散、方案难比较、日常运营耗时",
            "segments": ["成长期电商品牌主", "人力不足的社群运营者", "寻找 AI 工具的营销主管", "需要稳定获客的中小企业主"],
            "scenarios": ["寻找自动化工具", "抱怨营销人力不足", "咨询社群增长方法", "比较获客方案"],
            "keywords": ["品牌增长", "电商经营", "AI 自动化", "运营效率", "社群营销", "营销自动化", "电商老板", "品牌主理人", "获客工具", "私域流量", "内容营销", "社群运营", "营销人力不足", "企业增长", "客户开发", "AI 营销工具", "Threads 营销", "Instagram 获客", "社群没流量", "如何找客户", "营销工具推荐", "自动开发客户", "电商转化率", "品牌曝光不足"],
        },
        "general": {
            "title": "主动寻找解决方案的潜在客户",
            "need": "快速找到可信且符合条件的解决方案",
            "pain": "资讯分散、方案难比较、选择成本高",
            "segments": ["主动比较方案者", "问题急迫的需求者", "寻找工具与服务者", "近期有相关互动者"],
            "scenarios": ["主动咨询方案", "比较价格与条件", "分享使用痛点", "寻求同业推荐"],
            "keywords": ["高意向需求", "近期咨询", "方案比较", "立即咨询", "寻找推荐", "使用心得", "解决方法", "价格比较", "专业服务", "实际案例", "工具推荐", "改善效率", "哪个方案好", "有没有人推荐", "正在找服务", "遇到问题", "如何改善", "需要协助", "预算比较", "近期规划", "专家建议", "同业经验", "踩雷心得", "产品评估"],
        },
    },
    "zh-Hant": {
        "finance": {
            "title": "正在比較資金與貸款方案的決策者",
            "need": "取得合適額度並降低還款壓力",
            "pain": "月付壓力、申請條件與可貸額度不確定",
            "segments": ["有月付壓力的貸款戶", "需要營運週轉的中小企業主", "比較轉貸方案的房貸戶", "近期諮詢額度的資金需求者"],
            "scenarios": ["主動諮詢貸款方案", "比較利率與申請條件", "分享還款壓力", "尋找資金週轉建議"],
            "keywords": ["房貸需求", "資金週轉", "降低月付", "額度評估", "貸款比較", "整合負債", "月付壓力", "銀行貸款條件", "急需資金", "貸款諮詢", "信用條件", "房貸轉增貸", "負債整合建議", "貸款利率比較", "資金缺口", "企業週轉金", "房貸月付太高", "如何提高額度", "貸款方案推薦", "近期想貸款", "首購房貸", "轉貸條件", "房貸銀行推薦", "貸款總成本"],
        },
        "business": {
            "title": "尋找成長與自動化方案的品牌經營者",
            "need": "快速找到可信且符合條件的成長方案",
            "pain": "資訊分散、方案難比較、日常營運耗時",
            "segments": ["成長期電商品牌主", "人力不足的社群經營者", "尋找 AI 工具的行銷主管", "需要穩定獲客的中小企業主"],
            "scenarios": ["尋找自動化工具", "抱怨行銷人力不足", "諮詢社群成長方法", "比較獲客方案"],
            "keywords": ["品牌成長", "電商經營", "AI 自動化", "營運效率", "社群行銷", "行銷自動化", "電商老闆", "品牌主理人", "獲客工具", "私域流量", "內容行銷", "社群營運", "行銷人力不足", "企業成長", "客戶開發", "AI 行銷工具", "Threads 行銷", "Instagram 獲客", "社群沒流量", "如何找客戶", "行銷工具推薦", "自動開發客戶", "電商轉化率", "品牌曝光不足"],
        },
        "general": {
            "title": "主動尋找解決方案的潛在客戶",
            "need": "快速找到可信且符合條件的解決方案",
            "pain": "資訊分散、方案難比較、選擇成本高",
            "segments": ["主動比較方案者", "問題急迫的需求者", "尋找工具與服務者", "近期有相關互動者"],
            "scenarios": ["主動諮詢方案", "比較價格與條件", "分享使用痛點", "尋求同業推薦"],
            "keywords": ["高意向需求", "近期諮詢", "方案比較", "立即諮詢", "尋找推薦", "使用心得", "解決方法", "價格比較", "專業服務", "實際案例", "工具推薦", "改善效率", "哪個方案好", "有沒有人推薦", "正在找服務", "遇到問題", "如何改善", "需要協助", "預算比較", "近期規劃", "專家建議", "同業經驗", "踩雷心得", "產品評估"],
        },
    },
}


def _clean(value: Any, maximum: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:maximum]


def _string_list(value: Any, maximum: int, item_maximum: int = 120) -> list[str]:
    items = value if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)) else []
    output: list[str] = []
    seen: set[str] = set()
    for raw in items:
        item = _clean(raw, item_maximum)
        key = item.casefold()
        if len(item) < 2 or key in seen:
            continue
        seen.add(key)
        output.append(item)
        if len(output) >= maximum:
            break
    return output


def _integer(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _extract_json(value: Any) -> JsonDict:
    if isinstance(value, Mapping):
        return dict(value)
    text = _clean(value, 30_000)
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"```\s*$", "", text, flags=re.I).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("missing_json_object")
    parsed = json.loads(text[start:end + 1])
    if not isinstance(parsed, Mapping):
        raise ValueError("json_not_object")
    return dict(parsed)


def _provider_payload(raw: Mapping[str, Any]) -> JsonDict:
    for key in ("parsed", "analysis", "data"):
        if isinstance(raw.get(key), Mapping):
            return dict(raw[key])
    if isinstance(raw.get("content"), str):
        return _extract_json(raw["content"])
    choices = raw.get("choices")
    if isinstance(choices, Sequence) and choices and isinstance(choices[0], Mapping):
        message = choices[0].get("message")
        if isinstance(message, Mapping):
            return _extract_json(message.get("content"))
    candidates = raw.get("candidates")
    if isinstance(candidates, Sequence) and candidates and isinstance(candidates[0], Mapping):
        content = candidates[0].get("content")
        if isinstance(content, Mapping):
            parts = content.get("parts")
            if isinstance(parts, Sequence) and parts and isinstance(parts[0], Mapping):
                return _extract_json(parts[0].get("text"))
    return dict(raw)


def _call_provider(provider: Provider, tenant: TenantContext, request: JsonDict) -> tuple[JsonDict, str]:
    raw = provider(tenant, request)
    if inspect.isawaitable(raw):
        raise TypeError("async_provider_not_supported")
    if not isinstance(raw, Mapping):
        raise TypeError("provider_result_not_mapping")
    payload = _provider_payload(raw)
    model = _clean(raw.get("model") or payload.get("model"), 100) or "configured-llm"
    return payload, model


def _demand_category(text: str) -> str:
    if re.search(r"房贷|房貸|贷款|貸款|额度|額度|资金|資金|月付|利率|银行|銀行", text, re.I):
        return "finance"
    if re.search(r"企业|企業|公司|老板|老闆|创业|創業|商家|品牌|电商|電商|营销|行銷", text, re.I):
        return "business"
    return "general"


def _local_demand(text: str, locale: str, reason: str) -> JsonDict:
    category = _demand_category(text)
    copy = _DEMAND_COPY[locale][category]
    tokens = [
        token.strip()
        for token in re.split(r"[\s,，。；;、｜|/]+", text)
        if 2 <= len(token.strip()) <= 40
    ][:10]
    keywords = _string_list([*tokens, *copy["keywords"]], 24)
    group_names = ["角色", "痛点", "场景", "意图"] if locale == "zh-Hans" else ["角色", "痛點", "場景", "意圖"]
    groups = [
        {"name": name, "keywords": keywords[index::4][:8]}
        for index, name in enumerate(group_names)
    ]
    urgent = bool(re.search(r"急|立即|马上|馬上|现在|現在|压力|壓力", text))
    return {
        "title": copy["title"],
        "intent": "高" if urgent else "中高",
        "need": copy["need"],
        "pain": copy["pain"],
        "signal": "主动咨询／比较方案" if locale == "zh-Hans" else "主動諮詢／比較方案",
        "channel": "Threads＋Instagram",
        "segments": list(copy["segments"]),
        "scenarios": list(copy["scenarios"]),
        "keywordGroups": groups,
        "keywords": keywords,
        "engine": "本地 AI 回退" if locale == "zh-Hans" else "本機 AI 備援",
        "model": "local-demand-fission-v2",
        "fallback": True,
        "fallbackReason": reason,
        "estimatedSearches": len(keywords),
    }


def _normalize_demand(raw: Mapping[str, Any], model: str, locale: str) -> JsonDict:
    raw_groups = raw.get("keywordGroups") or raw.get("keyword_groups") or []
    groups: list[JsonDict] = []
    if isinstance(raw_groups, Sequence) and not isinstance(raw_groups, (str, bytes, bytearray)):
        for group in raw_groups[:8]:
            if not isinstance(group, Mapping):
                continue
            name = _clean(group.get("name"), 40)
            keywords = _string_list(group.get("keywords"), 8)
            if name and keywords:
                groups.append({"name": name, "keywords": keywords})
    keywords = _string_list([
        *(raw.get("keywords") if isinstance(raw.get("keywords"), Sequence) and not isinstance(raw.get("keywords"), (str, bytes, bytearray)) else []),
        *(keyword for group in groups for keyword in group["keywords"]),
    ], 24)
    segments = _string_list(raw.get("segments"), 6, 160)
    scenarios = _string_list(raw.get("scenarios"), 8, 160)
    if len(keywords) < 12 or not segments or not scenarios:
        raise ValueError("invalid_demand_shape")
    return {
        "title": _clean(raw.get("title"), 160) or (
            "AI 裂变目标用户" if locale == "zh-Hans" else "AI 裂變目標用戶"
        ),
        "intent": _clean(raw.get("intent"), 30) or "中高",
        "need": _clean(raw.get("need"), 300),
        "pain": _clean(raw.get("pain"), 300),
        "signal": _clean(raw.get("signal"), 300),
        "channel": _clean(raw.get("channel"), 80) or "Threads＋Instagram",
        "segments": segments,
        "scenarios": scenarios,
        "keywordGroups": groups,
        "keywords": keywords,
        "engine": "AI 分析",
        "model": model,
        "fallback": False,
        "fallbackReason": "",
        "estimatedSearches": len(keywords),
    }


def analyze_demand(
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    llm_provider: Provider | None = None,
) -> JsonDict:
    text = _clean(payload.get("text"), 4_000)
    if not text:
        raise CRMError("crm_invalid_demand", "crm.errors.invalidDemand", status_code=400)
    locale = normalize_locale(payload.get("locale") or tenant.locale)
    if llm_provider is None:
        return _local_demand(text, locale, "provider_unconfigured")
    system_prompt = (
        "你是简体中文社群潜客研究专家。只输出有效 JSON，不编造平台数据。"
        if locale == "zh-Hans"
        else "你是繁體中文社群潛客研究專家。只輸出有效 JSON，不捏造平台數據。"
    )
    user_prompt = (
        "分析目标用户需求与方案，提炼可采集用户画像，并生成 Threads/Instagram "
        "公开内容搜索关键词。返回 title、intent、need、pain、signal、channel、segments、"
        "scenarios、keywordGroups、keywords；关键词必须有 12 至 24 个。\n目标需求与方案："
        if locale == "zh-Hans"
        else "分析目標用戶需求與方案，提煉可採集用戶畫像，並生成 Threads/Instagram "
        "公開內容搜尋關鍵詞。返回 title、intent、need、pain、signal、channel、segments、"
        "scenarios、keywordGroups、keywords；關鍵詞必須有 12 至 24 個。\n目標需求與方案："
    )
    request = {
        "operation": "crm_demand_analysis",
        "schemaVersion": DEMAND_SCHEMA,
        "locale": locale,
        "text": text,
        "temperature": 0.45,
        "systemPrompt": system_prompt,
        "userPrompt": f"{user_prompt}{text}",
    }
    try:
        raw, model = _call_provider(llm_provider, tenant, request)
        return _normalize_demand(raw, model, locale)
    except CRMError:
        raise
    except Exception:
        return _local_demand(text, locale, "provider_failed_or_invalid")


def _sanitize_text(value: Any, maximum: int = 300) -> str:
    text = _clean(value, maximum)
    text = _URL_RE.sub("", text)
    text = _CONTACT_RE.sub("", text)
    text = _LONG_NUMBER_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_hook(value: Any) -> str:
    text = _sanitize_text(value, 800)
    text = _PRIVATE_INVITE_RE.sub("", text)
    text = _PROMISE_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()[:500]
    if re.search(r"\d+(?:\.\d+)?\s*%", text) and not re.search(r"起|最低|依.*条件|依.*條件|审核|審核", text):
        text = re.sub(r"[。！？!?]+$", "", text)
        text = f"{text} 起，实际仍依个人条件与银行审核。"[:500]
    return text


def _normalize_comment(value: Any) -> str:
    return _sanitize_text(value, 300)[:180]


def _reply_strategy(value: Any) -> str:
    strategy = _clean(value, 40)
    return strategy if strategy in {"offer_hook", "direct_contact", "group_invite"} else "question_hook"


def _strategy_message(value: Any, strategy: str) -> str:
    if strategy == "question_hook":
        return ""
    return _PROMISE_RE.sub("", _sanitize_text(value, 300)).strip()[:180]


def _source_post_url(lead: Mapping[str, Any]) -> str:
    values = list(lead.get("sourceUrls") or []) if isinstance(lead.get("sourceUrls"), list) else []
    values.append(lead.get("sourceUrl"))
    seen: set[str] = set()
    for raw in values:
        url = _clean(raw, 1_200)
        if not url or url in seen:
            continue
        seen.add(url)
        parsed = urlparse(url)
        host = str(parsed.hostname or "").lower()
        if parsed.scheme.lower() != "https":
            continue
        if host in {"instagram.com", "www.instagram.com"} and re.match(r"^/(?:p|reel|reels)/", parsed.path, re.I):
            return url
        if host in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"} and re.match(r"^/@[^/]+/post/", parsed.path, re.I):
            return url
    return ""


def _source_author(source_url: Any) -> str:
    parsed = urlparse(_clean(source_url, 1_200))
    if str(parsed.hostname or "").lower() not in {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}:
        return ""
    match = re.match(r"^/@([^/]+)/post/", parsed.path, re.I)
    if not match:
        return ""
    return re.sub(r"[^A-Za-z0-9._]", "", unquote(match.group(1)).lstrip("@"))[:80]


def _add_mention(comment: str, source_url: str, enabled: bool) -> str:
    normalized = _normalize_comment(comment)
    if not enabled:
        return normalized
    author = _source_author(source_url)
    if not author or re.match(rf"^@{re.escape(author)}\b", normalized, re.I):
        return normalized
    return _normalize_comment(f"@{author} {normalized}")


def _mortgage_source(lead: Mapping[str, Any]) -> str:
    return _clean(f"{lead.get('text') or ''} {lead.get('evidenceText') or ''}", 4_000)


def _mortgage_eligibility(lead: Mapping[str, Any]) -> tuple[bool, str]:
    source = _mortgage_source(lead)
    if re.search(r"诈骗|詐騙|假账号|假帳號|盗图|盜圖|冒用|钓鱼|釣魚|红酒|紅酒|股票|台股|ETF|虚拟币|虛擬幣", source, re.I):
        return False, "非房贷主题"
    if re.search(r"不要推销|不要推銷|拒绝推销|拒絕推銷|别再留言|別再留言", source, re.I):
        return False, "明确拒绝推广"
    if not re.search(r"房贷|房貸|贷款|貸款|银行|銀行|利率|首购|首購|转贷|轉貸|增贷|增貸|额度|額度|月付", source, re.I):
        return False, "问题不明确"
    return True, ""


def _published_evidence(item: Mapping[str, Any]) -> bool:
    return any(item.get(key) is True for key in ("published", "replied", "verifiedVisible", "platformVisible"))


def _comment_progress(pool: Mapping[str, Any], tasks: Sequence[Mapping[str, Any]]) -> JsonDict:
    leads = pool.get("leads") if isinstance(pool.get("leads"), list) else []
    if not leads:
        raise CRMError("crm_pool_empty", "crm.errors.poolEmpty", status_code=400)
    eligible: list[tuple[str, str]] = []
    seen_urls: set[str] = set()
    exclusion_reasons: dict[str, int] = {}
    missing_source = 0
    duplicate_source = 0
    mortgage = _clean(pool.get("businessCategory"), 40) == "mortgage"
    for raw_lead in leads:
        if not isinstance(raw_lead, Mapping):
            continue
        source_url = _source_post_url(raw_lead)
        if not source_url:
            missing_source += 1
            continue
        if source_url in seen_urls:
            duplicate_source += 1
            continue
        seen_urls.add(source_url)
        if mortgage:
            allowed, reason = _mortgage_eligibility(raw_lead)
            if not allowed:
                exclusion_reasons[reason] = exclusion_reasons.get(reason, 0) + 1
                continue
        eligible.append((_clean(raw_lead.get("id"), 180), source_url))
    processed_urls: set[str] = set()
    pool_id = _clean(pool.get("id"), 180)
    for task in tasks:
        if _clean(task.get("type"), 40) != "comment" or _clean(task.get("poolId"), 180) != pool_id:
            continue
        result = task.get("result") if isinstance(task.get("result"), Mapping) else {}
        rows = result.get("results") if isinstance(result.get("results"), list) else []
        for row in rows:
            if isinstance(row, Mapping) and _published_evidence(row):
                source_url = _clean(row.get("sourcePostUrl"), 1_200)
                if source_url in seen_urls:
                    processed_urls.add(source_url)
    processed_ids = [lead_id for lead_id, url in eligible if url in processed_urls]
    remaining_ids = [lead_id for lead_id, url in eligible if url not in processed_urls]
    return {
        "poolId": pool_id,
        "total": len(eligible),
        "processed": len(processed_ids),
        "remaining": len(remaining_ids),
        "batchLimit": 20,
        "batchSize": min(20, len(remaining_ids)),
        "processedLeadIds": processed_ids,
        "remainingLeadIds": remaining_ids,
        "nextLeadIds": remaining_ids[:20],
        "eligibility": {
            "poolLeads": len(leads),
            "uniqueSourcePosts": len(seen_urls),
            "eligible": len(eligible),
            "excluded": max(0, len(seen_urls) - len(eligible)),
            "missingSourcePost": missing_source,
            "duplicateSourcePost": duplicate_source,
            "exclusionReasons": exclusion_reasons,
        },
        "updatedAt": _clean(pool.get("updatedAt"), 80) or int(time.time()),
    }


def _localized(locale: str, simplified: str, traditional: str) -> str:
    return simplified if locale == "zh-Hans" else traditional


def _fallback_comment(pool: Mapping[str, Any], lead: Mapping[str, Any], locale: str) -> str:
    source = _mortgage_source(lead)
    category = _clean(pool.get("businessCategory"), 40)
    if category == "mortgage" or re.search(r"房贷|房貸|贷款|貸款|首购|首購|转贷|轉貸|增贷|增貸", source):
        return _localized(
            locale,
            "看到你提到房贷条件，实际利率与额度确实要一起比较。",
            "看到你提到房貸條件，實際利率與額度確實要一起比較。",
        )
    if category == "stocks" or re.search(r"台股|股票|投资|投資|ETF|持股|波段", source, re.I):
        return _localized(
            locale,
            "看到你分享投资上的想法，进出节奏与风险配置确实值得多交流。",
            "看到你分享投資上的想法，進出節奏與風險配置確實值得多交流。",
        )
    return _localized(
        locale,
        "看到你的分享，这个问题确实很值得进一步交流。",
        "看到你的分享，這個問題確實很值得進一步交流。",
    )


def _first_contact_comment(
    value: Any,
    pool: Mapping[str, Any],
    lead: Mapping[str, Any],
    locale: str,
    hook: str,
    strategy: str,
    strategy_message: str,
) -> str:
    normalized = _normalize_comment(value)
    promotional = re.compile(r"私信|私訊|联系我|聯絡我|加我|欢迎|歡迎|名额|名額|LINE|WhatsApp|Telegram", re.I)
    sentences = re.findall(r"[^。！？!?]+[。！？!?]?", normalized)
    result = "".join(sentence for sentence in sentences if not promotional.search(sentence))[:260].strip()
    if not result:
        result = _fallback_comment(pool, lead, locale)
    if hook and hook not in result:
        result = f"{re.sub(r'[。！？!?]+$', '', hook)}。{result}"
    source = _mortgage_source(lead)
    mortgage = _clean(pool.get("businessCategory"), 40) == "mortgage" or bool(re.search(r"房贷|房貸|贷款|貸款|利率", source))
    stocks = _clean(pool.get("businessCategory"), 40) == "stocks" or bool(re.search(r"股票|台股|投资|投資|ETF", source, re.I))
    if strategy == "question_hook" and not re.search(r"[？?]$", result):
        if mortgage:
            question = _localized(locale, "你目前最想先厘清的是利率、额度，还是每月还款压力？", "你目前最想先釐清的是利率、額度，還是每月還款壓力？")
        elif stocks:
            question = _localized(locale, "你目前比较关注进场时机，还是风险控制？", "你目前比較關注進場時機，還是風險控制？")
        else:
            question = _localized(locale, "你目前最想先厘清哪一个部分？", "你目前最想先釐清哪一個部分？")
        result = f"{result}{question}"
    if strategy_message and strategy_message not in result:
        result = f"{result}{'' if re.search(r'[。！？!?]$', result) else '。'}{strategy_message}"
    return _clean(re.sub(r"\s+", " ", result), 260)


def _mortgage_comment_matches(comment: str, lead: Mapping[str, Any]) -> bool:
    allowed, _ = _mortgage_eligibility(lead)
    return allowed and len(_normalize_comment(comment)) >= 12 and bool(
        re.search(r"房贷|房貸|贷款|貸款|利率|额度|額度|首购|首購|转贷|轉貸|增贷|增貸|月付", comment)
    )


def generate_public_comment_drafts(
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    pool: Mapping[str, Any],
    tasks: Sequence[Mapping[str, Any]] = (),
    llm_provider: Provider | None = None,
    id_factory: IdFactory | None = None,
) -> JsonDict:
    pool_id = _clean(pool.get("id"), 180)
    if not pool_id or pool_id != _clean(payload.get("poolId"), 180):
        raise CRMError("crm_pool_not_found", "crm.errors.poolNotFound", status_code=404)
    leads = pool.get("leads") if isinstance(pool.get("leads"), list) else []
    if not leads:
        raise CRMError("crm_pool_empty", "crm.errors.poolEmpty", status_code=400)
    locale = normalize_locale(payload.get("locale") or tenant.locale)
    progress = _comment_progress(pool, tasks)
    remaining_ids = set(progress["remainingLeadIds"])
    selected_ids = set(_string_list(payload.get("selectedLeadIds"), 200, 180))
    limit = _integer(payload.get("limit"), 20, 1, 20)
    seen_urls: set[str] = set()
    candidates: list[tuple[Mapping[str, Any], str]] = []
    for raw_lead in leads:
        if not isinstance(raw_lead, Mapping):
            continue
        lead_id = _clean(raw_lead.get("id"), 180)
        if lead_id not in remaining_ids or (selected_ids and lead_id not in selected_ids):
            continue
        source_url = _source_post_url(raw_lead)
        if not source_url or source_url in seen_urls:
            continue
        seen_urls.add(source_url)
        candidates.append((raw_lead, source_url))
        if len(candidates) >= limit:
            break
    if not candidates:
        raise CRMError("crm_comment_source_unavailable", "crm.errors.commentSourceUnavailable", status_code=400)

    strategy = _reply_strategy(payload.get("replyStrategy"))
    hook = _normalize_hook(payload.get("hookInstruction"))
    strategy_message = _strategy_message(payload.get("strategyMessage"), strategy)
    contact_instruction = _normalize_comment(payload.get("contactInstruction"))
    make_id = id_factory or (lambda prefix: f"{prefix}_{uuid.uuid4().hex[:20]}")
    drafts: list[JsonDict] = []
    mortgage = _clean(pool.get("businessCategory"), 40) == "mortgage"
    for index, (lead, source_url) in enumerate(candidates, 1):
        fallback = _fallback_comment(pool, lead, locale)
        fallback = _first_contact_comment(fallback, pool, lead, locale, hook, strategy, strategy_message)
        drafts.append({
            "id": f"comment_draft_{index}_{make_id('item')}",
            "leadId": _clean(lead.get("id"), 180),
            "username": _clean(lead.get("username"), 120),
            "platform": "instagram" if _clean(lead.get("platform"), 20) == "instagram" else "threads",
            "sourcePostUrl": source_url,
            "sourceText": _clean(lead.get("text") or lead.get("evidenceText"), 500),
            "comment": fallback,
            "mentionUsername": _source_author(source_url) if payload.get("mentionSourceAuthor") is True else "",
            "selected": True,
        })

    engine = _localized(locale, "本地 AI 回退", "本機 AI 備援")
    warning = ""
    if llm_provider is not None:
        targets = []
        lead_by_id = {_clean(lead.get("id"), 180): lead for lead, _url in candidates}
        for draft in drafts:
            lead = lead_by_id[draft["leadId"]]
            targets.append({
                "id": draft["id"],
                "username": draft["username"],
                "platform": draft["platform"],
                "post": draft["sourceText"][:260],
                "category": _clean(pool.get("businessCategory"), 80),
                "tags": _string_list(lead.get("tags"), 12, 80),
            })
        request = {
            "operation": "crm_public_comment_drafts",
            "schemaVersion": COMMENT_DRAFT_SCHEMA,
            "locale": locale,
            "temperature": 0.65,
            "replyStrategy": strategy,
            "hookInstruction": hook,
            "contactInstruction": contact_instruction,
            "strategyMessage": strategy_message,
            "targets": targets,
            "systemPrompt": _localized(
                locale,
                "你是社群品牌互动编辑。留言必须具体、克制、不重复，不可编造平台信息。",
                "你是社群品牌互動編輯。留言必須具體、克制、不重複，不可捏造平台資訊。",
            ),
            "userPrompt": _localized(
                locale,
                "按目标帖子顺序生成留言，只返回 drafts JSON。每则先回应原文；不得承诺结果、导流或编造联系信息。",
                "按目標貼文順序生成留言，只返回 drafts JSON。每則先回應原文；不得承諾結果、導流或捏造聯絡資訊。",
            ),
        }
        try:
            raw, _model = _call_provider(llm_provider, tenant, request)
            raw_drafts = raw.get("drafts") if isinstance(raw.get("drafts"), list) else []
            ai_map = {
                _clean(item.get("id"), 180): _normalize_comment(item.get("comment"))
                for item in raw_drafts
                if isinstance(item, Mapping)
            }
            applied = 0
            for draft in drafts:
                generated = ai_map.get(draft["id"], "")
                lead = lead_by_id[draft["leadId"]]
                if len(generated) >= 12 and (not mortgage or _mortgage_comment_matches(generated, lead)):
                    draft["comment"] = _first_contact_comment(
                        generated, pool, lead, locale, hook, strategy, strategy_message,
                    )
                    applied += 1
            if not applied:
                raise ValueError("provider_returned_no_valid_drafts")
            engine = "AI 分析"
            if applied < len(drafts):
                count = len(drafts) - applied
                warning = _localized(locale, f"{count} 则使用本地回退草稿", f"{count} 則使用本機備援草稿")
        except CRMError:
            raise
        except Exception:
            warning = "provider_failed_or_invalid"

    for draft in drafts:
        lead = next(lead for lead, _url in candidates if _clean(lead.get("id"), 180) == draft["leadId"])
        if mortgage and not _mortgage_comment_matches(draft["comment"], lead):
            draft["comment"] = _first_contact_comment(
                _fallback_comment(pool, lead, locale), pool, lead, locale, hook, strategy, strategy_message,
            )
        if mortgage and not _mortgage_comment_matches(draft["comment"], lead):
            draft["selected"] = False
            draft["blockedReason"] = _localized(locale, "留言未匹配原帖的房贷问题", "留言未匹配原貼文的房貸問題")
            continue
        draft["comment"] = _add_mention(
            _PROMISE_RE.sub("", draft["comment"]),
            draft["sourcePostUrl"],
            payload.get("mentionSourceAuthor") is True,
        )
        draft["mentionUsername"] = _source_author(draft["sourcePostUrl"]) if payload.get("mentionSourceAuthor") is True else ""
    return {"data": drafts, "engine": engine, "warning": warning, "progress": progress}


def _target_context(
    payload: Mapping[str, Any],
    task: Mapping[str, Any],
    pool: Mapping[str, Any] | None,
) -> JsonDict:
    if _clean(task.get("type"), 40) != "comment" or _clean(task.get("id"), 180) != _clean(payload.get("taskId"), 180):
        raise CRMError("crm_comment_task_not_found", "crm.errors.commentTaskNotFound", status_code=404)
    item_id = _clean(payload.get("itemId"), 180)
    items = task.get("items") if isinstance(task.get("items"), list) else []
    result = task.get("result") if isinstance(task.get("result"), Mapping) else {}
    rows = result.get("results") if isinstance(result.get("results"), list) else []
    item = next((row for row in items if isinstance(row, Mapping) and _clean(row.get("id") or row.get("leadId"), 180) == item_id), None)
    row = next((entry for entry in rows if isinstance(entry, Mapping) and _clean(entry.get("id") or entry.get("leadId"), 180) == item_id), None)
    if item is None or row is None:
        raise CRMError("crm_comment_item_not_found", "crm.errors.commentItemNotFound", status_code=404)
    verifications = task.get("commentVerification") if isinstance(task.get("commentVerification"), Mapping) else {}
    verification_rows = verifications.get("results") if isinstance(verifications.get("results"), list) else []
    verification = next((entry for entry in verification_rows if isinstance(entry, Mapping) and _clean(entry.get("id") or entry.get("leadId"), 180) == item_id), None)
    evidence = {**row, **verification} if isinstance(verification, Mapping) else dict(row)
    if not _published_evidence(evidence):
        raise CRMError("crm_followup_evidence_required", "crm.errors.followupEvidenceRequired", status_code=409)
    leads = pool.get("leads") if isinstance(pool, Mapping) and isinstance(pool.get("leads"), list) else []
    lead = next((entry for entry in leads if isinstance(entry, Mapping) and _clean(entry.get("id"), 180) == _clean(item.get("leadId"), 180)), {})
    return {
        "item": item,
        "itemId": item_id,
        "lead": lead,
        "sourceText": _clean(lead.get("text") or lead.get("evidenceText") or item.get("sourceText"), 800),
        "previousComment": _clean(evidence.get("comment") or item.get("comment"), 300),
        "replyEvidence": _clean(evidence.get("replyEvidence") or evidence.get("matchedText"), 500),
    }


def _fallback_followup(context: Mapping[str, Any], locale: str) -> str:
    source = f"{context.get('sourceText') or ''} {context.get('previousComment') or ''}"
    replied = bool(context.get("replyEvidence"))
    if re.search(r"房贷|房貸|贷款|貸款|银行|銀行|利率|首购|首購|转贷|轉貸|增贷|增貸", source):
        return _localized(
            locale,
            "谢谢你补充，实际还要把利率、额度与每月还款一起比较。你目前最想先厘清哪一项？" if replied else "再补充一点，房贷不能只看最低利率，也要一起确认额度与总成本。你目前最在意哪一项？",
            "謝謝你補充，實際還要把利率、額度與每月還款一起比較。你目前最想先釐清哪一項？" if replied else "再補充一點，房貸不能只看最低利率，也要一起確認額度與總成本。你目前最在意哪一項？",
        )
    if re.search(r"台股|股票|投资|投資|ETF|持股|波段", source, re.I):
        return _localized(
            locale,
            "谢谢你补充，进场节奏与能承受的波动最好一起评估。你目前比较想先谈风险还是时机？" if replied else "再补充一点，策略也要配合持有周期与可承受波动。你目前偏短波段还是中期配置？",
            "謝謝你補充，進場節奏與能承受的波動最好一起評估。你目前比較想先談風險還是時機？" if replied else "再補充一點，策略也要配合持有週期與可承受波動。你目前偏短波段還是中期配置？",
        )
    return _localized(
        locale,
        "谢谢你补充，这个情况确实值得再拆开看。你目前最希望先解决哪一个部分？" if replied else "再补充一个实际面向：可以先把条件与优先顺序分开比较。你目前最在意哪一点？",
        "謝謝你補充，這個情況確實值得再拆開看。你目前最希望先解決哪一個部分？" if replied else "再補充一個實際面向：可以先把條件與優先順序分開比較。你目前最在意哪一點？",
    )


def _normalize_followup(value: Any, previous_comment: str) -> str:
    comment = _PRIVATE_INVITE_RE.sub("", _normalize_comment(value))
    comment = re.sub(r"\s+", " ", comment).strip()[:180]
    if len(comment) < 8 or comment == _normalize_comment(previous_comment):
        raise ValueError("invalid_followup")
    return comment


def generate_targeted_comment_followup(
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    task: Mapping[str, Any],
    pool: Mapping[str, Any] | None = None,
    llm_provider: Provider | None = None,
) -> JsonDict:
    locale = normalize_locale(payload.get("locale") or tenant.locale)
    context = _target_context(payload, task, pool)
    instruction = _normalize_hook(payload.get("instruction"))
    fallback = _normalize_followup(_fallback_followup(context, locale), context["previousComment"])
    comment = fallback
    engine = _localized(locale, "本地 AI 回退", "本機 AI 備援")
    warning = ""
    if llm_provider is not None:
        request = {
            "operation": "crm_targeted_comment_followup",
            "schemaVersion": COMMENT_FOLLOWUP_SCHEMA,
            "locale": locale,
            "temperature": 0.55,
            "instruction": instruction,
            "sourceText": context["sourceText"],
            "previousComment": context["previousComment"],
            "replyEvidence": context["replyEvidence"],
            "systemPrompt": _localized(
                locale,
                "你是社群互动编辑，必须延续真实上下文，补充内容具体且不制造垃圾信息。",
                "你是社群互動編輯，必須延續真實上下文，補充內容具體且不製造垃圾訊息。",
            ),
            "userPrompt": _localized(
                locale,
                "生成一则新的针对性补充留言，只返回 comment JSON；不得重复原留言、承诺结果、导流或编造联系信息。",
                "生成一則新的針對性補充留言，只返回 comment JSON；不得重複原留言、承諾結果、導流或捏造聯絡資訊。",
            ),
        }
        try:
            raw, _model = _call_provider(llm_provider, tenant, request)
            comment = _normalize_followup(raw.get("comment"), context["previousComment"])
            engine = "AI 分析"
        except CRMError:
            raise
        except Exception:
            comment = fallback
            warning = "provider_failed_or_invalid"
    item = context["item"]
    source_url = _clean(item.get("sourcePostUrl"), 1_200)
    comment = _add_mention(comment, source_url, payload.get("mentionSourceAuthor") is not False)
    return {
        "draft": {
            "taskId": _clean(task.get("id"), 180),
            "itemId": context["itemId"],
            "leadId": _clean(item.get("leadId"), 180),
            "username": _clean(item.get("username"), 120),
            "platform": "instagram" if _clean(item.get("platform"), 20) == "instagram" else "threads",
            "sourcePostUrl": source_url,
            "sourceText": context["sourceText"],
            "previousComment": context["previousComment"],
            "replyEvidence": context["replyEvidence"],
            "comment": comment,
            "mentionUsername": _source_author(source_url),
        },
        "engine": engine,
        "warning": warning,
    }


__all__ = [
    "COMMENT_DRAFT_SCHEMA",
    "COMMENT_FOLLOWUP_SCHEMA",
    "DEMAND_SCHEMA",
    "analyze_demand",
    "generate_public_comment_drafts",
    "generate_targeted_comment_followup",
]
