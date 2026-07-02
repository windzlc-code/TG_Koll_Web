import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { countBaiduRawResults, parseBaiduSearchResults } from "./baidu-search.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function deepPagesPerKeyword(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") return 0;
  const value = Math.round(Number(deepBudget.maxPagesPerKeyword ?? deepBudget.max_pages_per_keyword ?? 0));
  return Math.max(0, Math.min(3, Number.isFinite(value) ? value : 0));
}

function normalizeWechatUrl(value = "") {
  const raw = cleanText(value, 1600);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "mp.weixin.qq.com") return "";
    url.hash = "";
    for (const key of ["scene", "subscene", "clicktime", "enterid", "ascene", "devicetype", "version", "nettype", "exportkey", "pass_ticket", "wx_header", "from"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeWechatDedupeUrl(value = "") {
  const normalized = normalizeWechatUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of [
      "scene",
      "subscene",
      "clicktime",
      "enterid",
      "ascene",
      "devicetype",
      "version",
      "nettype",
      "exportkey",
      "pass_ticket",
      "wx_header",
      "from",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function wechatSearchDedupeKey(item = {}) {
  return normalizeWechatDedupeUrl(item?.url || "");
}

function normalizeWechatKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function wechatKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeWechatKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function wechatValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeWechatKeywordText(value);
  return wechatKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeWechatKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function wechatKeywordMatchSource(item = {}, keyword = "") {
  if (!wechatKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["wechat_evidence_kind", item.metrics?.wechat_evidence_kind],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (wechatValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function wechatKeywordDiagnostics(item = {}, keyword = "") {
  return {
    wechat_matched_keyword: cleanText(keyword, 160),
    wechat_keyword_match_source: wechatKeywordMatchSource(item, keyword),
  };
}

function wechatTermMatches(text = "", terms = []) {
  const source = normalizeWechatKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeWechatKeywordText(term);
    return needle && source.includes(needle);
  });
}

function wechatArticleNarrativeSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = [
    item.title,
    item.content,
    item.author,
    metrics.article_body_excerpt,
    metrics.description,
    metrics.keywords,
    metrics.og_title,
    metrics.og_description,
  ].filter(Boolean).join(" ");
  const evidenceTerms = wechatTermMatches(text, [
    "截图", "截圖", "证据", "證據", "凭证", "憑證", "收据", "收據", "发票", "發票", "订单", "訂單", "工单", "工單",
    "时间线", "時間線", "聊天记录", "聊天紀錄", "录音", "錄音", "文件", "实测", "實測", "proof", "evidence", "screenshot", "receipt", "timeline",
  ]);
  const impactTerms = wechatTermMatches(text, [
    "消费者", "消費者", "用户", "用戶", "客户", "客戶", "退款", "延迟", "延遲", "损失", "損失", "隐私", "隱私", "个人信息",
    "個資", "数据泄露", "資料外洩", "安全", "无法使用", "服務中斷", "服务中断", "customer", "user", "consumer", "refund", "delay", "privacy", "security",
  ]);
  const responseTerms = wechatTermMatches(text, [
    "官方回应", "官方回應", "官方声明", "官方聲明", "声明", "聲明", "回应", "回應", "道歉", "致歉", "澄清", "说明", "說明",
    "客服回应", "客服回應", "监管", "監管", "处理方案", "處理方案", "official response", "official statement", "apology", "support", "regulator",
  ]);
  const propagationTerms = wechatTermMatches(text, [
    "扩散", "擴散", "热议", "熱議", "发酵", "發酵", "转发", "轉發", "刷屏", "社群", "朋友圈", "公众号", "媒体报道", "媒體報導",
    "后续", "後續", "跟进", "跟進", "viral", "spread", "spreading", "shared", "media coverage", "follow-up",
  ]);
  const crisisTerms = wechatTermMatches(text, [
    "投诉", "投訴", "争议", "爭議", "纠纷", "糾紛", "诈骗", "詐騙", "欺诈", "詐欺", "诉讼", "訴訟", "调查", "調查",
    "危机", "危機", "舆情", "輿情", "风波", "風波", "爆料", "维权", "維權", "complaint", "dispute", "scam", "fraud", "lawsuit", "investigation", "crisis",
  ]);
  const semanticSignals = [
    evidenceTerms.length,
    impactTerms.length,
    responseTerms.length,
    propagationTerms.length,
    crisisTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  const reasons = [];
  if (evidenceTerms.length) reasons.push("wechat-article-evidence-language");
  if (impactTerms.length) reasons.push("wechat-article-impact-language");
  if (responseTerms.length) reasons.push("wechat-article-official-response-language");
  if (propagationTerms.length) reasons.push("wechat-article-propagation-language");
  if (crisisTerms.length) reasons.push("wechat-article-crisis-language");
  if (completeNarrative) reasons.push("wechat-complete-public-article-crisis-narrative");
  return {
    wechat_article_evidence_signal: evidenceTerms.length ? 1 : 0,
    wechat_article_impact_signal: impactTerms.length ? 1 : 0,
    wechat_article_official_response_signal: responseTerms.length ? 1 : 0,
    wechat_article_propagation_signal: propagationTerms.length ? 1 : 0,
    wechat_article_crisis_signal: crisisTerms.length ? 1 : 0,
    wechat_article_semantic_signal_count: semanticSignals,
    wechat_article_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    wechat_article_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    wechat_article_impact_terms: [...new Set(impactTerms)].slice(0, 12),
    wechat_article_response_terms: [...new Set(responseTerms)].slice(0, 12),
    wechat_article_propagation_terms: [...new Set(propagationTerms)].slice(0, 12),
    wechat_article_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    wechat_article_narrative_reasons: reasons,
  };
}

function isConcreteWechatArticleUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "mp.weixin.qq.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(profile|cgi-bin|mp|debug|search)$/i.test(segments[0])) return false;
    if (segments[0] !== "s") return false;
    if (segments[1] && /^[A-Za-z0-9_-]{8,}$/.test(segments[1])) return true;
    const biz = parsed.searchParams.get("__biz") || "";
    const mid = parsed.searchParams.get("mid") || "";
    const sn = parsed.searchParams.get("sn") || "";
    return /^M/.test(biz) && /^\d{4,}$/.test(mid) && /^[A-Za-z0-9_-]{8,}$/.test(sn);
  } catch {
    return false;
  }
}

function wechatEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (first === "s") return "article";
  } catch {
    return "";
  }
  return "";
}

export function parseWechatPublicSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "wechat_public",
  }).map(item => {
    const url = normalizeWechatUrl(item.url);
    if (!url || !isConcreteWechatArticleUrl(url)) return null;
    return {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "微信公開文章搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_mp_weixin",
        source_kind: "wechat_public_article_search",
        wechat_evidence_kind: wechatEvidenceKind(url),
        collection_mode: "site_mp_weixin_public_search",
        ...wechatArticleNarrativeSignals({ ...item, url, author: item.author && !/百度/.test(item.author) ? item.author : "微信公開文章搜索" }),
      },
    };
  }).filter(Boolean);
}

async function insertWechatItems(items, {
  keyword,
  proxyUrl = "",
  enrich = true,
  maxDeepPages = 0,
  domainControls = {},
  contentControls = {},
  seenItemUrls = null,
}) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = wechatSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const shouldEnrich = enrich && deepPagesUsed < maxDeepPages;
    const enriched = shouldEnrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: item.content, ai_summary: item.content, enriched: false };
    if (shouldEnrich) deepPagesUsed += 1;
    const content = enriched.content || item.content || "";
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const narrativeMetrics = wechatArticleNarrativeSignals({
      ...item,
      content,
      author: enriched.author || item.author,
      metrics: evidenceMetrics,
    });
    const result = insertSentimentItem({
      platform: "wechat_public",
      url: item.url,
      title: item.title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
      keyword,
      keywords: [keyword],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: enriched.evidence?.evidence_type || "wechat_public_article_search_result",
        metrics: {
          ...evidenceMetrics,
          ...narrativeMetrics,
          ...wechatKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: evidenceMetrics,
          }, keyword),
          wechat_canonical_dedupe_url: dedupeKey,
          wechat_search_scan_dedupe_key: dedupeKey,
        },
      },
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeWechatPublicSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `site:mp.weixin.qq.com/s ${keyword}`;
      const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${page * 10}&ie=utf-8`;
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const rawResultCount = countBaiduRawResults(html);
        const items = parseWechatPublicSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            wechat_search_page: page + 1,
            wechat_search_offset: page * 10,
            wechat_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertWechatItems(items, {
          keyword,
          proxyUrl,
          enrich,
          maxDeepPages,
          domainControls,
          contentControls,
          seenItemUrls,
        });
        inserted += count;
        keywordInserted += count;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, message });
        console.warn(`[Sentiment/WechatPublic] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteWechatArticleUrl,
  normalizeBudget,
  normalizeWechatUrl,
  normalizeWechatDedupeUrl,
  normalizeWechatKeywordText,
  wechatKeywordNeedles,
  wechatValueMatchesKeyword,
  parseWechatPublicSearchResults,
  wechatSearchDedupeKey,
  wechatEvidenceKind,
  wechatKeywordMatchSource,
  wechatKeywordDiagnostics,
  wechatArticleNarrativeSignals,
};
