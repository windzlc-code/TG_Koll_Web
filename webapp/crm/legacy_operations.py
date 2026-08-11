from __future__ import annotations

import hashlib
import inspect
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlparse

from .errors import CRMError
from .repository import create_resource, dumps, new_id, now_ts, row_public


JsonDict = dict[str, Any]
Provider = Callable[["TenantContext", JsonDict], Mapping[str, Any]]

DEMAND_SCHEMA = "crm.demand-analysis.v1"
HOTSPOT_SCHEMA = "crm.hotspot-search.v1"
OPC_QUERY_SCHEMA = "crm.opc-history-query.v1"
OPC_IMPORT_SCHEMA = "crm.opc-history-import.v1"

MAX_DEMAND_TEXT = 4_000
MAX_HOTSPOT_QUERY = 300
MAX_HOTSPOT_RESULTS = 200
MAX_OPC_QUERY_RESULTS = 500
MAX_OPC_IMPORT_RESULTS = 2_000
MAX_OPC_SCAN_ROWS = 50_000


@dataclass(frozen=True)
class TenantContext:
    """Explicit tenant boundary required by every migrated operation."""

    user_id: int
    locale: str = "zh-Hans"
    request_id: str = ""

    def __post_init__(self) -> None:
        try:
            user_id = int(self.user_id)
        except (TypeError, ValueError) as exc:
            raise CRMError(
                "crm_invalid_workspace",
                "crm.errors.invalidWorkspace",
                status_code=401,
            ) from exc
        if user_id <= 0:
            raise CRMError(
                "crm_invalid_workspace",
                "crm.errors.invalidWorkspace",
                status_code=401,
            )
        object.__setattr__(self, "user_id", user_id)
        object.__setattr__(self, "locale", normalize_locale(self.locale))
        object.__setattr__(self, "request_id", _clean(self.request_id, 128))


def normalize_locale(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("_", "-")
    if normalized in {"zh-hant", "zh-tw", "zh-hk", "traditional"}:
        return "zh-Hant"
    return "zh-Hans"


def _clean(value: Any, maximum: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:maximum]


def _integer(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    return max(minimum, min(maximum, parsed))


def _string_list(value: Any, *, maximum: int, item_maximum: int = 120) -> list[str]:
    items = value if isinstance(value, (list, tuple)) else []
    output: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = _clean(item, item_maximum)
        key = text.casefold()
        if len(text) < 2 or key in seen:
            continue
        seen.add(key)
        output.append(text)
        if len(output) >= maximum:
            break
    return output


def _json_object(value: Any) -> JsonDict:
    if isinstance(value, Mapping):
        return dict(value)
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return dict(parsed) if isinstance(parsed, Mapping) else {}


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return list(parsed) if isinstance(parsed, list) else []


_FALLBACKS: dict[str, dict[str, dict[str, Any]]] = {
    "zh-Hans": {
        "finance": {
            "title": "正在比较资金与贷款方案的决策者",
            "need": "取得合适额度并降低还款压力",
            "pain": "月付压力、申请条件与可贷额度不确定",
            "segments": ["有月付压力的贷款户", "需要营运周转的中小企业主", "比较转贷方案的房贷户", "近期咨询额度的资金需求者"],
            "scenarios": ["主动咨询贷款方案", "比较利率与申请条件", "分享还款压力", "寻找资金周转建议"],
            "keywords": ["房贷需求", "资金周转", "降低月付", "额度评估", "贷款比较", "整合负债", "月付压力", "银行贷款条件", "急需资金", "贷款咨询", "信用条件", "房贷转增贷", "负债整合建议", "贷款利率比较", "资金缺口", "企业周转金", "房贷月付太高", "如何提高额度", "贷款方案推荐", "近期想贷款"],
        },
        "business": {
            "title": "寻找增长与自动化方案的品牌经营者",
            "need": "快速找到可信且符合条件的增长方案",
            "pain": "资讯分散、方案难比较、日常营运耗时",
            "segments": ["成长期电商品牌主", "人力不足的社群经营者", "寻找 AI 工具的营销主管", "需要稳定获客的中小企业主"],
            "scenarios": ["寻找自动化工具", "抱怨营销人力不足", "咨询社群增长方法", "比较获客方案"],
            "keywords": ["品牌增长", "电商经营", "AI 自动化", "营运效率", "社群营销", "营销自动化", "电商老板", "品牌主理人", "获客工具", "私域流量", "内容营销", "社群经营", "营销人力不足", "企业增长", "客户开发", "AI 营销工具", "Threads 营销", "Instagram 获客", "社群没流量", "如何找客户", "营销工具推荐", "自动开发客户", "电商转化率", "品牌曝光不足"],
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
            "keywords": ["房貸需求", "資金週轉", "降低月付", "額度評估", "貸款比較", "整合負債", "月付壓力", "銀行貸款條件", "急需資金", "貸款諮詢", "信用條件", "房貸轉增貸", "負債整合建議", "貸款利率比較", "資金缺口", "企業週轉金", "房貸月付太高", "如何提高額度", "貸款方案推薦", "近期想貸款"],
        },
        "business": {
            "title": "尋找成長與自動化方案的品牌經營者",
            "need": "快速找到可信且符合條件的成長方案",
            "pain": "資訊分散、方案難比較、日常營運耗時",
            "segments": ["成長期電商品牌主", "人力不足的社群經營者", "尋找 AI 工具的行銷主管", "需要穩定獲客的中小企業主"],
            "scenarios": ["尋找自動化工具", "抱怨行銷人力不足", "諮詢社群成長方法", "比較獲客方案"],
            "keywords": ["品牌成長", "電商經營", "AI 自動化", "營運效率", "社群行銷", "行銷自動化", "電商老闆", "品牌主理人", "獲客工具", "私域流量", "內容行銷", "社群經營", "行銷人力不足", "企業成長", "客戶開發", "AI 行銷工具", "Threads 行銷", "Instagram 獲客", "社群沒流量", "如何找客戶", "行銷工具推薦", "自動開發客戶", "電商轉化率", "品牌曝光不足"],
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


def _demand_category(text: str) -> str:
    if re.search(r"房贷|房貸|贷款|貸款|资金|資金|月付|额度|額度|利率|负债|負債", text, re.I):
        return "finance"
    if re.search(r"企业|企業|公司|老板|老闆|创业|創業|商家|品牌|电商|電商|营销|行銷", text, re.I):
        return "business"
    return "general"


def _fallback_demand(text: str, locale: str, reason_code: str) -> JsonDict:
    category = _demand_category(text)
    copy = _FALLBACKS[locale][category]
    tokens = [
        token for token in re.split(r"[\s,，。；;、｜|/]+", text)
        if 2 <= len(token.strip()) <= 40
    ][:8]
    keywords = _string_list([*tokens, *copy["keywords"]], maximum=24)
    group_names = ["角色", "痛点", "场景", "意向"] if locale == "zh-Hans" else ["角色", "痛點", "場景", "意向"]
    groups = [
        {"name": name, "keywords": keywords[index::4][:6]}
        for index, name in enumerate(group_names)
    ]
    urgent = bool(re.search(r"急|立即|马上|馬上|现在|現在|压力|壓力", text))
    return {
        "schemaVersion": DEMAND_SCHEMA,
        "locale": locale,
        "title": copy["title"],
        "intent": "高" if urgent else "中高",
        "need": copy["need"],
        "pain": copy["pain"],
        "signal": "主动咨询或比较方案" if locale == "zh-Hans" else "主動諮詢或比較方案",
        "channel": "Threads＋Instagram",
        "segments": list(copy["segments"]),
        "scenarios": list(copy["scenarios"]),
        "keywordGroups": groups,
        "keywords": keywords,
        "engine": "本地智能回退" if locale == "zh-Hans" else "本機智能回退",
        "model": "local-demand-fission-v3",
        "fallback": True,
        "fallbackReason": reason_code,
        "estimatedSearches": len(keywords),
    }


def _normalize_ai_demand(raw: Mapping[str, Any], locale: str) -> JsonDict:
    source = dict(raw.get("analysis") or {}) if isinstance(raw.get("analysis"), Mapping) else dict(raw)
    raw_groups = source.get("keywordGroups") or source.get("keyword_groups") or []
    groups: list[JsonDict] = []
    if isinstance(raw_groups, (list, tuple)):
        for item in raw_groups[:6]:
            if not isinstance(item, Mapping):
                continue
            name = _clean(item.get("name"), 40)
            keywords = _string_list(item.get("keywords"), maximum=8)
            if name and keywords:
                groups.append({"name": name, "keywords": keywords})
    keywords = _string_list(
        [
            *(source.get("keywords") if isinstance(source.get("keywords"), (list, tuple)) else []),
            *(keyword for group in groups for keyword in group["keywords"]),
        ],
        maximum=24,
    )
    if len(keywords) < 12:
        raise ValueError("too_few_keywords")
    segments = _string_list(source.get("segments"), maximum=6, item_maximum=160)
    scenarios = _string_list(source.get("scenarios"), maximum=8, item_maximum=160)
    if not segments or not scenarios:
        raise ValueError("missing_segments_or_scenarios")
    return {
        "schemaVersion": DEMAND_SCHEMA,
        "locale": locale,
        "title": _clean(source.get("title"), 160),
        "intent": _clean(source.get("intent"), 30) or "中高",
        "need": _clean(source.get("need"), 300),
        "pain": _clean(source.get("pain"), 300),
        "signal": _clean(source.get("signal"), 300),
        "channel": _clean(source.get("channel"), 80) or "Threads＋Instagram",
        "segments": segments,
        "scenarios": scenarios,
        "keywordGroups": groups,
        "keywords": keywords,
        "engine": "AI 分析",
        "model": _clean(raw.get("model") or source.get("model"), 100) or "configured-llm",
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
    """Analyze demand with the configured TG LLM, then a deterministic local fallback.

    The provider receives a tenant-scoped request but never an API key. Router
    integration should wrap TG_Koll_Web's existing LLM resolver instead of
    loading legacy CRM configuration or invoking the old Node service.
    """

    text = _clean(payload.get("text"), MAX_DEMAND_TEXT)
    if len(text) < 2:
        raise CRMError("crm_invalid_demand", "crm.errors.invalidDemand", status_code=400)
    locale = normalize_locale(payload.get("locale") or tenant.locale)
    if llm_provider is None:
        return _fallback_demand(text, locale, "provider_unconfigured")
    request = {
        "operation": "crm_demand_analysis",
        "schemaVersion": DEMAND_SCHEMA,
        "locale": locale,
        "text": text,
        "maximumKeywords": 24,
        "instructions": (
            "仅返回符合 schema 的简体中文 JSON；不得编造平台数据。"
            if locale == "zh-Hans"
            else "僅返回符合 schema 的繁體中文 JSON；不得捏造平台資料。"
        ),
    }
    try:
        raw = llm_provider(tenant, request)
        if inspect.isawaitable(raw):
            raise TypeError("async_provider_not_supported")
        if not isinstance(raw, Mapping):
            raise TypeError("provider_result_not_mapping")
        return _normalize_ai_demand(raw, locale)
    except CRMError:
        raise
    except Exception:
        return _fallback_demand(text, locale, "provider_failed_or_invalid")


def _https_threads_url(value: Any) -> str:
    url = _clean(value, 1_200)
    parsed = urlparse(url)
    host = str(parsed.hostname or "").lower()
    if parsed.scheme.lower() != "https" or host not in {
        "threads.net", "www.threads.net", "threads.com", "www.threads.com"
    }:
        return ""
    return url


def search_hotspots(
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    search_provider: Provider | None = None,
) -> JsonDict:
    """Normalize a real tenant-scoped Threads search; never fabricate posts."""

    query = _clean(payload.get("query"), MAX_HOTSPOT_QUERY)
    if len(query) < 2:
        raise CRMError("crm_invalid_hotspot_query", "crm.errors.invalidHotspotQuery", status_code=400)
    platform = _clean(payload.get("platform") or "threads", 20).lower()
    if platform != "threads":
        raise CRMError(
            "crm_hotspot_platform_blocked",
            "crm.errors.hotspotPlatformBlocked",
            status_code=409,
            details={"platform": platform},
        )
    limit = _integer(payload.get("limit"), default=30, minimum=3, maximum=MAX_HOTSPOT_RESULTS)
    scroll_rounds = _integer(payload.get("scrollRounds"), default=max(4, (limit + 7) // 8), minimum=4, maximum=30)
    if search_provider is None:
        raise CRMError(
            "crm_hotspot_search_blocked",
            "crm.errors.hotspotSearchBlocked",
            status_code=409,
            details={"reason": "provider_unconfigured"},
        )
    request = {
        "operation": "crm_hotspot_search",
        "schemaVersion": HOTSPOT_SCHEMA,
        "query": query,
        "platform": "threads",
        "limit": limit,
        "scrollRounds": scroll_rounds,
    }
    try:
        raw = search_provider(tenant, request)
        if inspect.isawaitable(raw):
            raise TypeError("async_provider_not_supported")
        if not isinstance(raw, Mapping):
            raise TypeError("provider_result_not_mapping")
    except CRMError:
        raise
    except Exception as exc:
        raise CRMError(
            "crm_hotspot_search_unavailable",
            "crm.errors.hotspotSearchUnavailable",
            status_code=503,
            retryable=True,
        ) from exc
    raw_rows = raw.get("data") if isinstance(raw.get("data"), (list, tuple)) else []
    captured_at = int(time.time())
    posts: list[JsonDict] = []
    seen_urls: set[str] = set()
    for row in raw_rows:
        if not isinstance(row, Mapping):
            continue
        source_url = _https_threads_url(row.get("sourceUrl") or row.get("permalink") or row.get("url"))
        if not source_url or source_url in seen_urls:
            continue
        seen_urls.add(source_url)
        likes = _integer(row.get("likeCount"), default=0, minimum=0, maximum=2_147_483_647)
        replies = _integer(row.get("replyCount"), default=0, minimum=0, maximum=2_147_483_647)
        reposts = _integer(row.get("repostCount"), default=0, minimum=0, maximum=2_147_483_647)
        posts.append({
            "id": _clean(row.get("id"), 160) or hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:24],
            "username": _clean(row.get("username"), 120).lstrip("@"),
            "text": _clean(row.get("text") or row.get("content"), 1_000),
            "sourceUrl": source_url,
            "likeCount": likes,
            "replyCount": replies,
            "repostCount": reposts,
            "engagement": likes + replies * 2 + reposts * 3,
            "platform": "threads",
            "query": query,
            "collectedAt": captured_at,
        })
        if len(posts) >= MAX_HOTSPOT_RESULTS * 5:
            break
    posts.sort(key=lambda item: (-int(item["engagement"]), str(item["sourceUrl"])))
    posts = posts[:limit]
    return {
        "schemaVersion": HOTSPOT_SCHEMA,
        "query": query,
        "platform": "threads",
        "data": posts,
        "count": len(posts),
        "warning": _clean(raw.get("warning"), 300),
        "sourceUrl": _https_threads_url(raw.get("sourceUrl")),
    }


def _opc_rows(conn: sqlite3.Connection, tenant: TenantContext) -> list[sqlite3.Row]:
    try:
        cursor = conn.execute(
            """
            SELECT l.id,l.platform,l.platform_user_key,l.username,l.display_name,l.stage,l.score,
                   l.tags_json,l.profile_json,l.import_batch_id,l.created_at,l.updated_at,
                   GROUP_CONCAT(CASE WHEN pm.active=1 THEN pm.pool_id ELSE NULL END) AS pool_ids
              FROM crm_leads AS l
              LEFT JOIN crm_pool_members AS pm
                ON pm.lead_id=l.id AND pm.user_id=l.user_id
             WHERE l.user_id=? AND l.active=1 AND l.import_batch_id<>''
             GROUP BY l.id
             ORDER BY l.updated_at DESC,l.id DESC
             LIMIT ?
            """,
            (tenant.user_id, MAX_OPC_SCAN_ROWS + 1),
        )
        rows = cursor.fetchall()
    except sqlite3.Error as exc:
        raise CRMError(
            "crm_opc_history_blocked",
            "crm.errors.opcHistoryBlocked",
            status_code=409,
            details={"reason": "crm_history_store_unavailable"},
        ) from exc
    if len(rows) > MAX_OPC_SCAN_ROWS:
        raise CRMError(
            "crm_opc_history_capacity_exceeded",
            "crm.errors.opcHistoryCapacityExceeded",
            status_code=413,
            details={"maximum": MAX_OPC_SCAN_ROWS},
        )
    return rows


def _lead_from_row(row: sqlite3.Row) -> JsonDict:
    profile = _json_object(row["profile_json"])
    raw_tags = _json_list(row["tags_json"])
    tags = _string_list(raw_tags, maximum=100, item_maximum=120)
    platform = _clean(row["platform"], 20).lower()
    if platform not in {"threads", "instagram"}:
        platform = "threads"
    username = _clean(row["username"], 120).lstrip("@")
    keyword = _clean(profile.get("keyword"), 120)
    if not keyword:
        for tag in tags:
            if tag.startswith(("关键词:", "關鍵詞:", "關鍵字:")):
                keyword = tag.split(":", 1)[1]
                break
    status = _clean(profile.get("contactStatus") or profile.get("contact_status") or row["stage"], 30).lower()
    if status not in {"new", "contacted", "failed"}:
        status = "contacted" if status in {"sent", "delivered", "replied", "converted"} else "new"
    source_url = _clean(
        profile.get("sourceUrl") or profile.get("source_url") or profile.get("permalink"),
        1_200,
    )
    profile_url = _clean(profile.get("profileUrl") or profile.get("profile_url"), 1_200)
    if not profile_url and username:
        profile_url = (
            f"https://www.instagram.com/{username}/"
            if platform == "instagram"
            else f"https://www.threads.com/@{username}"
        )
    pool_ids = sorted({item for item in str(row["pool_ids"] or "").split(",") if item})
    return {
        "id": str(row["id"]),
        "username": username,
        "displayName": _clean(row["display_name"], 160),
        "platform": platform,
        "profileUrl": profile_url,
        "sourceUrl": source_url,
        "text": _clean(profile.get("text") or profile.get("evidenceText") or profile.get("profileBio"), 3_000),
        "keyword": keyword,
        "likeCount": _integer(profile.get("likeCount"), default=0, minimum=0, maximum=2_147_483_647),
        "replyCount": _integer(profile.get("replyCount"), default=0, minimum=0, maximum=2_147_483_647),
        "repostCount": _integer(profile.get("repostCount"), default=0, minimum=0, maximum=2_147_483_647),
        "tags": tags,
        "contactStatus": status,
        "lastContactAt": _clean(profile.get("lastContactAt") or profile.get("last_contact_at"), 40),
        "collectedAt": _clean(profile.get("collectedAt") or profile.get("collected_at"), 40),
        "runId": _clean(profile.get("runId") or profile.get("run_id"), 160),
        "poolIds": pool_ids,
    }


def _opc_filters(payload: Mapping[str, Any]) -> JsonDict:
    platform = _clean(payload.get("platform"), 20).lower()
    contact = _clean(payload.get("contact"), 20).lower()
    return {
        "platform": platform if platform in {"threads", "instagram"} else "",
        "contact": contact if contact in {"new", "contacted", "failed"} else "",
        "keywords": _string_list(payload.get("keywords"), maximum=30),
        "keywordMode": "all" if payload.get("keywordMode") == "all" else "any",
        "excludeKeywords": _string_list(payload.get("excludeKeywords"), maximum=30),
        "search": _clean(payload.get("search"), 200),
        "runIds": _string_list(payload.get("runIds"), maximum=100, item_maximum=160),
    }


def query_opc_history(
    conn: sqlite3.Connection,
    tenant: TenantContext,
    payload: Mapping[str, Any],
    *,
    maximum: int = MAX_OPC_QUERY_RESULTS,
) -> JsonDict:
    """Query only activated legacy rows owned by ``tenant.user_id``."""

    maximum = max(1, min(int(maximum), MAX_OPC_IMPORT_RESULTS))
    limit = _integer(payload.get("limit"), default=min(300, maximum), minimum=1, maximum=maximum)
    filters = _opc_filters(payload)
    required = [item.casefold() for item in filters["keywords"]]
    excluded = [item.casefold() for item in filters["excludeKeywords"]]
    selected_runs = set(filters["runIds"])
    search = str(filters["search"]).casefold()
    matches: list[JsonDict] = []
    for row in _opc_rows(conn, tenant):
        lead = _lead_from_row(row)
        if filters["platform"] and lead["platform"] != filters["platform"]:
            continue
        if filters["contact"] and lead["contactStatus"] != filters["contact"]:
            continue
        if selected_runs and lead["runId"] not in selected_runs:
            continue
        haystack = " ".join([
            lead["username"], lead["displayName"], lead["keyword"], lead["text"], *lead["tags"]
        ]).casefold()
        keyword_match = lambda item: item in haystack
        if required and filters["keywordMode"] == "all" and not all(map(keyword_match, required)):
            continue
        if required and filters["keywordMode"] == "any" and not any(map(keyword_match, required)):
            continue
        if excluded and any(map(keyword_match, excluded)):
            continue
        if search and search not in haystack:
            continue
        matches.append(lead)
    unique = list({(lead["platform"], lead["username"].casefold()): lead for lead in matches}.values())
    return {
        "schemaVersion": OPC_QUERY_SCHEMA,
        "total": len(unique),
        "data": unique[:limit],
        "limit": limit,
        "truncated": len(unique) > limit,
        "filters": filters,
    }


def _load_workflow_result(conn: sqlite3.Connection, tenant: TenantContext, workflow_id: str) -> JsonDict:
    row = conn.execute(
        "SELECT * FROM crm_workflows WHERE id=? AND user_id=? AND active=1",
        (workflow_id, tenant.user_id),
    ).fetchone()
    if row is None:
        return {}
    workflow = row_public(row) or {}
    result = workflow.get("result") if isinstance(workflow.get("result"), dict) else {}
    return dict(result)


def import_opc_history(
    conn: sqlite3.Connection,
    tenant: TenantContext,
    payload: Mapping[str, Any],
) -> JsonDict:
    """Create a real CRM pool from tenant-owned OPC history in one savepoint."""

    idempotency_key = _clean(payload.get("idempotencyKey") or payload.get("idempotency_key"), 128)
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", idempotency_key):
        raise CRMError(
            "crm_idempotency_key_required",
            "crm.errors.idempotencyKeyRequired",
            status_code=400,
        )
    try:
        replay = conn.execute(
            "SELECT id FROM crm_workflows WHERE user_id=? AND workflow_type='opc_history_import' "
            "AND idempotency_key=? AND active=1 LIMIT 1",
            (tenant.user_id, idempotency_key),
        ).fetchone()
    except sqlite3.Error as exc:
        raise CRMError(
            "crm_opc_history_blocked",
            "crm.errors.opcHistoryBlocked",
            status_code=409,
            details={"reason": "crm_history_store_unavailable"},
        ) from exc
    if replay is not None:
        result = _load_workflow_result(conn, tenant, str(replay["id"]))
        return {**result, "replayed": True}

    query = query_opc_history(conn, tenant, payload, maximum=MAX_OPC_IMPORT_RESULTS)
    leads = list(query["data"])
    if not leads:
        raise CRMError("crm_opc_history_empty", "crm.errors.opcHistoryEmpty", status_code=409)
    exclude_existing = payload.get("excludeExisting") is True
    exclude_interacted = payload.get("excludeInteracted") is True
    lead_ids = [str(item["id"]) for item in leads]
    placeholders = ",".join("?" for _ in lead_ids)
    existing_ids: set[str] = set()
    interacted_ids: set[str] = set()
    if exclude_existing:
        existing_ids = {
            str(row["lead_id"])
            for row in conn.execute(
                f"SELECT DISTINCT lead_id FROM crm_pool_members WHERE user_id=? AND active=1 AND lead_id IN ({placeholders})",
                (tenant.user_id, *lead_ids),
            ).fetchall()
        }
    if exclude_interacted:
        interacted_ids = {
            str(row["lead_id"])
            for row in conn.execute(
                f"SELECT DISTINCT lead_id FROM crm_events WHERE user_id=? AND active=1 AND lead_id IN ({placeholders}) "
                "AND (lower(event_type) GLOB '*sent*' OR lower(event_type) GLOB '*reply*' "
                "OR lower(event_type) GLOB '*comment*' OR lower(event_type) GLOB '*message*')",
                (tenant.user_id, *lead_ids),
            ).fetchall()
        }
    selected = [lead for lead in leads if lead["id"] not in existing_ids and lead["id"] not in interacted_ids]
    if not selected:
        raise CRMError("crm_opc_history_empty", "crm.errors.opcHistoryEmpty", status_code=409)

    category = _clean(payload.get("category"), 120) or (
        "OPC 历史客户池" if tenant.locale == "zh-Hans" else "OPC 歷史客戶池"
    )
    custom_tags = _string_list(payload.get("tags"), maximum=30, item_maximum=63)
    created = now_ts()
    workflow_id = new_id("crm")
    savepoint = "crm_opc_import"
    conn.execute(f"SAVEPOINT {savepoint}")
    try:
        pool = create_resource(
            conn,
            "pools",
            user_id=tenant.user_id,
            payload={
                "name": category,
                "description": "OPC historical import",
                "tags": custom_tags,
                "snapshot": {
                    "source": "opc_history_import",
                    "filters": query["filters"],
                    "matched": query["total"],
                    "selected": len(selected),
                },
            },
        )
        for lead in selected:
            conn.execute(
                "INSERT OR IGNORE INTO crm_pool_members(user_id,pool_id,lead_id,status,source,import_batch_id,active,created_at,updated_at) "
                "VALUES (?,?,?,'active','opc_history','',1,?,?)",
                (tenant.user_id, str(pool["id"]), str(lead["id"]), created, created),
            )
            if custom_tags:
                current = conn.execute(
                    "SELECT tags_json FROM crm_leads WHERE id=? AND user_id=? AND active=1",
                    (str(lead["id"]), tenant.user_id),
                ).fetchone()
                current_tags = _json_list(current["tags_json"]) if current else []
                merged_tags = _string_list([*current_tags, *custom_tags], maximum=100)
                conn.execute(
                    "UPDATE crm_leads SET tags_json=?,updated_at=? WHERE id=? AND user_id=?",
                    (dumps(merged_tags), created, str(lead["id"]), tenant.user_id),
                )
        result = {
            "schemaVersion": OPC_IMPORT_SCHEMA,
            "task": {
                "id": workflow_id,
                "type": "opc_history_import",
                "status": "completed",
                "createdAt": created,
                "finishedAt": created,
            },
            "pool": {
                "id": str(pool["id"]),
                "name": category,
                "leadCount": len(selected),
                "tags": custom_tags,
            },
            "totalMatched": int(query["total"]),
            "importedCount": len(selected),
            "existingRemoved": len(existing_ids),
            "interactedRemoved": len(interacted_ids - existing_ids),
            "replayed": False,
        }
        conn.execute(
            """
            INSERT INTO crm_workflows(
              id,user_id,workflow_type,title,status,input_json,result_json,confirmation_json,
              error_code,error_detail,billing_reservation_id,idempotency_key,scheduled_at,
              started_at,finished_at,import_batch_id,active,legacy_id,legacy_payload_json,
              schema_version,created_at,updated_at
            ) VALUES (?,?,? ,?,'completed',?,?,'{}','','','',?,0,?,?,'',1,'','{}',1,?,?)
            """,
            (
                workflow_id, tenant.user_id, "opc_history_import", category,
                dumps({"filters": query["filters"], "limit": query["limit"]}),
                dumps(result), idempotency_key, created, created, created, created,
            ),
        )
        conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        return result
    except Exception:
        conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
        conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        raise


__all__ = [
    "DEMAND_SCHEMA",
    "HOTSPOT_SCHEMA",
    "OPC_IMPORT_SCHEMA",
    "OPC_QUERY_SCHEMA",
    "TenantContext",
    "analyze_demand",
    "import_opc_history",
    "normalize_locale",
    "query_opc_history",
    "search_hotspots",
]
