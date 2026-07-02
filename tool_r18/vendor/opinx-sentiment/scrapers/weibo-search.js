import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { countBaiduRawResults, parseBaiduSearchResults } from "./baidu-search.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const SITE_SCOPES = ["weibo.com", "m.weibo.cn"];

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

function normalizeWeiboUrl(value = "") {
  const raw = cleanText(value, 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!/(^|\.)weibo\.(com|cn)$/.test(host)) return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "from", "refer_flag"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeWeiboDedupeUrl(value = "") {
  const normalized = normalizeWeiboUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "from", "refer_flag"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function weiboSearchDedupeKey(item = {}) {
  return normalizeWeiboDedupeUrl(item?.url || "");
}

function normalizeWeiboKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function weiboKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeWeiboKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function weiboValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeWeiboKeywordText(value);
  return weiboKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeWeiboKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function weiboKeywordMatchSource(item = {}, keyword = "") {
  if (!weiboKeywordNeedles(keyword).length) return "";
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["search_scope", metrics.search_scope],
    ["public_search_engine", metrics.public_search_engine],
  ];
  const match = fields.find(([, value]) => weiboValueMatchesKeyword(value, keyword));
  return match ? match[0] : "";
}

function weiboKeywordDiagnostics(item = {}, keyword = "") {
  return {
    weibo_matched_keyword: cleanText(keyword, 160),
    weibo_keyword_match_source: weiboKeywordMatchSource(item, keyword),
  };
}

function isConcreteWeiboUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (!/(^|\.)weibo\.(com|cn)$/.test(host)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|login|signup|tv|u|p|profile)$/i.test(segments[0])) return false;
    if (host === "m.weibo.cn") return segments.length >= 2 && /^(detail|status|profile|u)$/i.test(segments[0]);
    return segments.length >= 2 || /^[A-Za-z0-9_%-]{4,}$/.test(segments[0]);
  } catch {
    return false;
  }
}

function weiboStatusReference(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (host === "m.weibo.cn" && /^(detail|status)$/i.test(segments[0] || "")) {
      return { author: "", statusId: segments[1] || "" };
    }
    if (segments.length >= 2) {
      return {
        author: decodeURIComponent(segments[0] || "").replace(/^@/, ""),
        statusId: segments[1] || "",
      };
    }
    return { author: "", statusId: segments[0] || "" };
  } catch {
    return { author: "", statusId: "" };
  }
}

function weiboPropagationSignals(text = "") {
  const source = cleanText(text, 1800).toLowerCase();
  const repost = /转发|轉發|转推|轉推|转贴|轉貼|转载|轉載|\brepost|retweeted|retweet|reshare|shared\b/.test(source);
  const comment = /评论|評論|评论区|評論區|留言|回复|回覆|\bcomment|reply|replies\b/.test(source);
  const viral = /扩散|擴散|热议|熱議|发酵|發酵|刷屏|大量转发|大量轉發|传播|傳播|\bviral|spreading|trending|amplified\b/.test(source);
  const screenshot = /截图|截圖|晒图|曬圖|凭证|憑證|证据|證據|\bscreenshot|evidence\b/.test(source);
  const reasons = [];
  if (repost) reasons.push("repost-language");
  if (comment) reasons.push("comment-language");
  if (viral) reasons.push("amplification-language");
  if (screenshot) reasons.push("screenshot-evidence-language");
  return {
    weibo_repost_signal: repost ? 1 : 0,
    weibo_comment_signal: comment ? 1 : 0,
    weibo_amplification_signal: viral ? 1 : 0,
    weibo_screenshot_evidence_signal: screenshot ? 1 : 0,
    weibo_propagation_signal_count: reasons.length,
    weibo_propagation_reasons: reasons,
  };
}

function weiboSpreadRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function weiboSpreadRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const propagationSignals = weiboPropagationSignals(`${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`);
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const crisisTerms = [
    "投訴", "投诉", "客訴", "退款", "退货", "退貨", "售后", "售後", "客服",
    "維權", "维权", "爭議", "争议", "避雷", "踩雷", "翻车", "翻車",
    "抵制", "道歉", "危機", "危机", "爆料", "曝光",
    "complaint", "refund", "chargeback", "dispute", "support", "boycott",
    "apology", "crisis", "scam", "fraud",
  ].filter(term => text.includes(term.toLowerCase()));
  const impactTerms = [
    "退款", "退货", "退貨", "拒退", "客服", "售后", "售後", "维权", "維權",
    "翻车", "翻車", "避雷", "踩雷", "詐騙", "诈骗", "抵制", "危機", "危机",
    "refund", "chargeback", "customer support", "support delay", "dispute", "scam", "fraud", "boycott", "crisis",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = [
    "官方回应", "官方回應", "官方说明", "官方說明", "官方声明", "官方聲明",
    "公开回应", "公開回應", "客服回应", "客服回應", "道歉", "致歉", "澄清", "后续", "後續", "说明", "說明",
    "official response", "public response", "crisis response", "official statement", "customer support response", "apology", "clarification", "follow-up",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.weibo_search_raw_result_count || 0));
  const statusRef = weiboStatusReference(item.url || "");
  const hasStatus = Boolean(metrics.weibo_status_id || statusRef.statusId);
  const hasAuthor = Boolean(metrics.weibo_author_handle || statusRef.author);
  const mobileScope = metrics.search_scope === "m.weibo.cn" || /\/\/m\.weibo\.cn\//i.test(item.url || "");
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = weiboKeywordMatchSource(item, keyword) === "title";
  const reasons = [...(propagationSignals.weibo_propagation_reasons || [])];
  if (crisisTerms.length) reasons.push("crisis-language");
  if (hasStatus) reasons.push("concrete-status-url");
  if (hasAuthor) reasons.push("author-handle-present");
  if (mobileScope) reasons.push("mobile-indexed-status");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");
  if (impactTerms.length) reasons.push("impact-language");
  if (responseTerms.length) reasons.push("response-language");

  const semanticSignalCount = [
    propagationSignals.weibo_repost_signal,
    propagationSignals.weibo_comment_signal,
    propagationSignals.weibo_amplification_signal,
    propagationSignals.weibo_screenshot_evidence_signal,
    crisisTerms.length,
    impactTerms.length,
    responseTerms.length,
    hasStatus,
    hasAuthor,
    mobileScope,
    rawResultCount > 1,
    enriched,
    titleMatch,
  ].filter(Boolean).length;
  const completeNarrative = hasStatus
    && crisisTerms.length > 0
    && impactTerms.length > 0
    && propagationSignals.weibo_screenshot_evidence_signal
    && (propagationSignals.weibo_repost_signal || propagationSignals.weibo_comment_signal)
    && propagationSignals.weibo_amplification_signal
    && semanticSignalCount >= 7;

  const score = Math.min(100, Math.max(0,
    (hasStatus ? 14 : 0)
    + (hasAuthor ? 6 : 0)
    + (crisisTerms.length ? 22 : 0)
    + (impactTerms.length ? 10 : 0)
    + (responseTerms.length ? 8 : 0)
    + (completeNarrative ? 12 : 0)
    + (propagationSignals.weibo_repost_signal ? 14 : 0)
    + (propagationSignals.weibo_comment_signal ? 10 : 0)
    + (propagationSignals.weibo_amplification_signal ? 18 : 0)
    + (propagationSignals.weibo_screenshot_evidence_signal ? 14 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (mobileScope ? 4 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0)
  ));

  return {
    ...propagationSignals,
    weibo_crisis_language_signal: crisisTerms.length ? 1 : 0,
    weibo_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    weibo_impact_language_signal: impactTerms.length ? 1 : 0,
    weibo_response_language_signal: responseTerms.length ? 1 : 0,
    weibo_complete_propagation_narrative_signal: completeNarrative ? 1 : 0,
    weibo_impact_terms: [...new Set(impactTerms)].slice(0, 12),
    weibo_response_terms: [...new Set(responseTerms)].slice(0, 12),
    weibo_status_concrete_signal: hasStatus ? 1 : 0,
    weibo_author_handle_signal: hasAuthor ? 1 : 0,
    weibo_mobile_scope_signal: mobileScope ? 1 : 0,
    weibo_deep_evidence_signal: enriched ? 1 : 0,
    weibo_semantic_signal_count: semanticSignalCount,
    weibo_spread_risk_score: score,
    weibo_spread_risk_bucket: weiboSpreadRiskBucket(score),
    weibo_spread_risk_signal_count: [...new Set(reasons)].length,
    weibo_spread_risk_reasons: [...new Set(reasons)],
  };
}

export function parseWeiboSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "weibo",
  }).map(item => {
    const url = normalizeWeiboUrl(item.url);
    if (!url || !isConcreteWeiboUrl(url)) return null;
    const statusRef = weiboStatusReference(url);
    const result = {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "微博公開搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_weibo",
        source_kind: "weibo_public_search",
        weibo_author_handle: statusRef.author,
        weibo_status_id: statusRef.statusId,
        collection_mode: "site_weibo_public_search",
      },
    };
    result.metrics = {
      ...(result.metrics || {}),
      ...weiboSpreadRiskSignals(result, keyword),
    };
    return result;
  }).filter(Boolean);
}

async function insertWeiboItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = weiboSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls?.has(dedupeKey)) continue;
    seenItemUrls?.add(dedupeKey);
    const shouldEnrich = enrich && deepPagesUsed < maxDeepPages;
    const enriched = shouldEnrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: item.content, ai_summary: item.content, enriched: false };
    if (shouldEnrich) deepPagesUsed += 1;
    const content = enriched.content || item.content || "";
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const finalMetrics = {
      ...evidenceMetrics,
      ...weiboSpreadRiskSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "weibo",
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
        evidence_type: enriched.evidence?.evidence_type || "weibo_public_search_result",
        metrics: {
          ...finalMetrics,
          ...weiboKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          weibo_canonical_dedupe_url: dedupeKey,
          weibo_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeWeiboSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (const scope of SITE_SCOPES) {
      if (keywordInserted >= maxItemsPerKeyword) break;
      for (let page = 0; page < maxPagesPerKeyword; page += 1) {
        const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
        if (remaining <= 0) break;
        const query = `site:${scope} ${keyword}`;
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
            failures.push({ keyword, scope, message: httpFailure(res) });
            continue;
          }
          const html = await res.text();
          const rawResultCount = countBaiduRawResults(html);
          const items = parseWeiboSearchResults(html, keyword, {
            limit: remaining,
            since,
          }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              search_scope: scope,
              weibo_search_page: page + 1,
              weibo_search_offset: page * 10,
              weibo_search_raw_result_count: rawResultCount,
            },
          })).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ...weiboSpreadRiskSignals(item, keyword),
            },
          }));
          const count = await insertWeiboItems(items, {
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
          failures.push({ keyword, scope, message });
          console.warn(`[Sentiment/Weibo] 抓取失敗 keyword=${keyword} scope=${scope}: ${message}`);
        }
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteWeiboUrl,
  normalizeBudget,
  normalizeWeiboDedupeUrl,
  normalizeWeiboUrl,
  normalizeWeiboKeywordText,
  weiboKeywordNeedles,
  weiboValueMatchesKeyword,
  parseWeiboSearchResults,
  weiboStatusReference,
  weiboPropagationSignals,
  weiboSpreadRiskBucket,
  weiboSpreadRiskSignals,
  weiboSearchDedupeKey,
  weiboKeywordMatchSource,
  weiboKeywordDiagnostics,
};
