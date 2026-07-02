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

function normalizeTiebaUrl(value = "") {
  const raw = cleanText(value, 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "tieba.baidu.com" && host !== "tiebac.baidu.com") return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "fr", "from", "red_tag"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeTiebaDedupeUrl(value = "") {
  const normalized = normalizeTiebaUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "fr", "from", "red_tag"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function tiebaSearchDedupeKey(item = {}) {
  return normalizeTiebaDedupeUrl(item?.url || "");
}

function normalizeTiebaKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function tiebaKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeTiebaKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function tiebaValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeTiebaKeywordText(value);
  return tiebaKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeTiebaKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function tiebaKeywordMatchSource(item = {}, keyword = "") {
  if (!tiebaKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["tieba_evidence_kind", item.metrics?.tieba_evidence_kind],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (tiebaValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function tiebaKeywordDiagnostics(item = {}, keyword = "") {
  return {
    tieba_matched_keyword: cleanText(keyword, 160),
    tieba_keyword_match_source: tiebaKeywordMatchSource(item, keyword),
  };
}

function isConcreteTiebaUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "tieba.baidu.com" && host !== "tiebac.baidu.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(f|index|home|search|mo|p\/good|p\/vote)$/i.test(segments.join("/"))) return false;
    if (segments[0] === "p") return /^\d{4,}$/.test(segments[1] || "");
    return false;
  } catch {
    return false;
  }
}

function tiebaEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (first === "p") return "thread";
  } catch {
    return "";
  }
  return "";
}

function tiebaThreadRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function tiebaTermMatches(value = "", terms = []) {
  const text = cleanText(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function tiebaThreadRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "投訴", "投诉", "客訴", "退款", "退货", "退貨", "售后", "售後", "客服",
    "維權", "维权", "爭議", "争议", "避雷", "踩雷", "翻车", "翻車", "爆料",
    "complaint", "refund", "chargeback", "dispute", "support", "boycott", "crisis",
  ].filter(term => text.includes(term.toLowerCase()));
  const discussionTerms = [
    "跟帖", "回帖", "回复", "回覆", "楼主", "樓主", "吧友", "热帖", "熱帖",
    "集中讨论", "集中討論", "讨论帖", "討論帖", "经验", "經驗", "后续", "後續",
    "thread", "reply", "replies", "discussion", "forum", "follow-up", "followup",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "截图", "截圖", "凭证", "憑證", "证据", "證據", "聊天记录", "聊天紀錄",
    "订单", "訂單", "小票", "录屏", "錄屏", "整理", "汇总", "匯總",
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "转发", "轉發", "扩散", "擴散", "热议", "熱議", "发酵", "發酵",
    "刷屏", "曝光", "置顶", "置頂", "顶帖", "頂帖", "repost", "reposts",
    "shared", "viral", "spread", "spreading", "amplify", "amplified",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = tiebaTermMatches(text, [
    "官方回应", "官方回應", "官方声明", "官方聲明", "客服回应", "客服回應", "公开回应", "公開回應",
    "道歉", "澄清", "后续", "後續", "处理结果", "處理結果", "处理进度", "處理進度", "回应", "回應", "回复", "回覆",
    "official response", "official statement", "public response", "customer support response",
    "support response", "apology", "clarification", "follow-up", "resolved",
  ]);
  const rawResultCount = Math.max(0, Number(metrics.tieba_search_raw_result_count || 0));
  const isThread = metrics.tieba_evidence_kind === "thread" || tiebaEvidenceKind(item.url) === "thread";
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = tiebaKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isThread) reasons.push("concrete-thread-url");
  if (complaintTerms.length) reasons.push("complaint-language");
  if (discussionTerms.length) reasons.push("reply-discussion-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (amplificationTerms.length) reasons.push("amplification-language");
  if (responseTerms.length) reasons.push("response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");
  const semanticSignalCount = [
    complaintTerms.length,
    discussionTerms.length,
    evidenceTerms.length,
    amplificationTerms.length,
    responseTerms.length,
  ].filter(Boolean).length;
  if (semanticSignalCount >= 4) reasons.push("complete-thread-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (isThread ? 18 : 0)
    + (complaintTerms.length ? 24 : 0)
    + (discussionTerms.length ? 16 : 0)
    + (evidenceTerms.length ? 14 : 0)
    + (amplificationTerms.length ? 16 : 0)
    + (responseTerms.length ? 12 : 0)
    + (semanticSignalCount >= 4 ? 10 : semanticSignalCount >= 3 ? 5 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (enriched ? 12 : 0)
    + (titleMatch ? 10 : 0)
  ));

  return {
    tieba_thread_concrete_signal: isThread ? 1 : 0,
    tieba_thread_complaint_signal: complaintTerms.length ? 1 : 0,
    tieba_thread_reply_discussion_signal: discussionTerms.length ? 1 : 0,
    tieba_thread_evidence_signal: evidenceTerms.length ? 1 : 0,
    tieba_thread_amplification_signal: amplificationTerms.length ? 1 : 0,
    tieba_thread_response_signal: responseTerms.length ? 1 : 0,
    tieba_thread_semantic_signal_count: semanticSignalCount,
    tieba_thread_complete_crisis_narrative_signal: semanticSignalCount >= 4 ? 1 : 0,
    tieba_thread_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    tieba_thread_reply_discussion_terms: [...new Set(discussionTerms)].slice(0, 12),
    tieba_thread_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    tieba_thread_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    tieba_thread_response_terms: [...new Set(responseTerms)].slice(0, 12),
    tieba_thread_deep_evidence_signal: enriched ? 1 : 0,
    tieba_thread_risk_score: score,
    tieba_thread_risk_bucket: tiebaThreadRiskBucket(score),
    tieba_thread_risk_signal_count: reasons.length,
    tieba_thread_risk_reasons: reasons,
  };
}

export function parseTiebaSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "tieba",
  }).map(item => {
    const url = normalizeTiebaUrl(item.url);
    if (!url || !isConcreteTiebaUrl(url)) return null;
    const result = {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "百度貼吧公開搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_tieba",
        source_kind: "tieba_public_search",
        tieba_evidence_kind: tiebaEvidenceKind(url),
        collection_mode: "site_tieba_public_search",
      },
    };
    result.metrics = {
      ...(result.metrics || {}),
      ...tiebaThreadRiskSignals(result, keyword),
    };
    return result;
  }).filter(Boolean);
}

async function insertTiebaItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = tiebaSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls?.has(dedupeKey)) continue;
    seenItemUrls?.add(dedupeKey);
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
    const finalMetrics = {
      ...evidenceMetrics,
      ...tiebaThreadRiskSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const result = insertSentimentItem({
      platform: "tieba",
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
        evidence_type: enriched.evidence?.evidence_type || "tieba_public_search_result",
        metrics: {
          ...finalMetrics,
          ...tiebaKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          tieba_canonical_dedupe_url: dedupeKey,
          tieba_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeTiebaSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `site:tieba.baidu.com/p ${keyword}`;
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
        const items = parseTiebaSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            tieba_search_page: page + 1,
            tieba_search_offset: page * 10,
            tieba_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...tiebaThreadRiskSignals(item, keyword),
          },
        }));
        const count = await insertTiebaItems(items, {
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
        console.warn(`[Sentiment/Tieba] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteTiebaUrl,
  normalizeBudget,
  normalizeTiebaDedupeUrl,
  normalizeTiebaUrl,
  parseTiebaSearchResults,
  tiebaSearchDedupeKey,
  tiebaEvidenceKind,
  normalizeTiebaKeywordText,
  tiebaValueMatchesKeyword,
  tiebaKeywordMatchSource,
  tiebaKeywordDiagnostics,
  tiebaThreadRiskBucket,
  tiebaTermMatches,
  tiebaThreadRiskSignals,
};
