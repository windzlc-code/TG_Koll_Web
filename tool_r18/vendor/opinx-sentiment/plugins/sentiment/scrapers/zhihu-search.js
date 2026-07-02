import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { countBaiduRawResults, parseBaiduSearchResults } from "./baidu-search.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
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

function normalizeZhihuUrl(value = "") {
  const raw = cleanText(value, 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "zhihu.com" && host !== "zhuanlan.zhihu.com") return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_id", "from"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeZhihuDedupeUrl(value = "") {
  const normalized = normalizeZhihuUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_id", "from", "source"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeZhihuDirectUrls(values = [], limit = 20) {
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeZhihuUrl(value);
    if (!normalized || !isConcreteZhihuUrl(normalized)) continue;
    const dedupe = normalizeZhihuDedupeUrl(normalized);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
    if (out.length >= Math.max(1, Math.min(80, Number(limit) || 20))) break;
  }
  return out;
}

function zhihuSearchDedupeKey(item = {}) {
  return normalizeZhihuDedupeUrl(item?.url || "");
}

function normalizeZhihuKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function zhihuKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeZhihuKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function zhihuValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeZhihuKeywordText(value);
  return zhihuKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeZhihuKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function zhihuKeywordMatchSource(item = {}, keyword = "") {
  if (!zhihuKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["zhihu_evidence_kind", item.metrics?.zhihu_evidence_kind],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (zhihuValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function zhihuKeywordDiagnostics(item = {}, keyword = "") {
  return {
    zhihu_matched_keyword: cleanText(keyword, 160),
    zhihu_keyword_match_source: zhihuKeywordMatchSource(item, keyword),
  };
}

function isConcreteZhihuUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (host === "zhuanlan.zhihu.com") return segments[0] === "p" && /^\d{4,}$/.test(segments[1] || "");
    if (host !== "zhihu.com") return false;
    if (!segments.length) return false;
    if (/^(search|signin|signup|people|org|topic|hot|explore)$/i.test(segments[0])) return false;
    if (segments[0] === "question") return /^\d{4,}$/.test(segments[1] || "");
    if (segments[0] === "answer") return /^\d{4,}$/.test(segments[1] || "");
    if (segments[0] === "pin") return /^\d{4,}$/.test(segments[1] || "");
    if (segments[0] === "zvideo") return /^\d{4,}$/.test(segments[1] || "");
    return false;
  } catch {
    return false;
  }
}

function zhihuEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (host === "zhuanlan.zhihu.com") return "article";
    if (first === "question") return "question";
    if (first === "answer") return "answer";
    if (first === "pin") return "pin";
    if (first === "zvideo") return "video";
  } catch {
    return "";
  }
  return "";
}

function zhihuTitleFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const kind = zhihuEvidenceKind(url);
    if (kind === "question" && segments[1]) return `知乎问题 ${segments[1]}`;
    if (kind === "answer" && segments[1]) return `知乎回答 ${segments[1]}`;
    if (kind === "article" && segments[1]) return `知乎专栏文章 ${segments[1]}`;
    if (kind === "pin" && segments[1]) return `知乎想法 ${segments[1]}`;
    if (kind === "video" && segments[1]) return `知乎视频 ${segments[1]}`;
  } catch {
    // fall through
  }
  return "知乎原帖";
}

function zhihuTitleFromHtml(html = "", fallback = "") {
  const source = String(html || "");
  const candidates = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const regex of candidates) {
    const match = regex.exec(source);
    const title = cleanText(match?.[1] || "", 260)
      .replace(/\s*-\s*知乎\s*$/i, "")
      .replace(/\s*-\s*知乎专栏\s*$/i, "");
    if (title) return title;
  }
  return cleanText(fallback, 260);
}

function zhihuDiscussionRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function zhihuTermMatches(value = "", terms = []) {
  const text = cleanText(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function zhihuDiscussionRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "投訴", "投诉", "客訴", "退款", "退货", "退貨", "售后", "售後", "客服",
    "維權", "维权", "爭議", "争议", "避雷", "踩雷", "翻车", "翻車",
    "合同", "合約", "纠纷", "糾紛", "索赔", "索賠",
    "complaint", "refund", "chargeback", "dispute", "support", "boycott", "crisis",
  ].filter(term => text.includes(term.toLowerCase()));
  const discussionTerms = [
    "如何看待", "怎么看", "怎麼看", "回答", "答案", "问题", "問題", "提问", "提問",
    "关注", "關注", "收藏", "评论", "評論", "讨论", "討論", "经验", "經驗",
    "question", "answer", "answers", "discussion", "comment", "comments", "follow",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "截图", "截圖", "凭证", "憑證", "证据", "證據", "聊天记录", "聊天紀錄",
    "订单", "訂單", "合同", "合約", "时间线", "時間線", "整理", "汇总", "匯總",
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "热议", "熱議", "扩散", "擴散", "发酵", "發酵", "传播", "傳播",
    "转载", "轉載", "转发", "轉發", "围观", "圍觀", "高赞", "高讚",
    "viral", "spreading", "trending", "shared", "repost", "amplified",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = zhihuTermMatches(text, [
    "官方回应", "官方回應", "官方声明", "官方聲明", "客服回应", "客服回應", "公开回应", "公開回應",
    "道歉", "澄清", "后续", "後續", "处理结果", "處理結果", "回应", "回應", "回复", "回覆",
    "official response", "official statement", "public response", "customer support response",
    "support response", "apology", "clarification", "follow-up", "resolved",
  ]);
  const rawResultCount = Math.max(0, Number(metrics.zhihu_search_raw_result_count || 0));
  const evidenceKind = metrics.zhihu_evidence_kind || zhihuEvidenceKind(item.url);
  const isQuestionOrAnswer = evidenceKind === "question" || evidenceKind === "answer";
  const isLongform = evidenceKind === "article";
  const isConcrete = Boolean(evidenceKind);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.article_body_text_length || metrics.raw_html_length);
  const titleMatch = zhihuKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isConcrete) reasons.push("concrete-zhihu-url");
  if (isQuestionOrAnswer) reasons.push("qa-discussion-url");
  if (isLongform) reasons.push("zhihu-article-url");
  if (complaintTerms.length) reasons.push("complaint-language");
  if (discussionTerms.length) reasons.push("qa-discussion-language");
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
  if (semanticSignalCount >= 4) reasons.push("complete-discussion-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (isConcrete ? 12 : 0)
    + (isQuestionOrAnswer ? 10 : 0)
    + (isLongform ? 8 : 0)
    + (complaintTerms.length ? 24 : 0)
    + (discussionTerms.length ? 14 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (amplificationTerms.length ? 14 : 0)
    + (responseTerms.length ? 12 : 0)
    + (semanticSignalCount >= 4 ? 10 : semanticSignalCount >= 3 ? 5 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0)
  ));

  return {
    zhihu_discussion_concrete_signal: isConcrete ? 1 : 0,
    zhihu_discussion_qa_signal: isQuestionOrAnswer ? 1 : 0,
    zhihu_discussion_article_signal: isLongform ? 1 : 0,
    zhihu_discussion_complaint_signal: complaintTerms.length ? 1 : 0,
    zhihu_discussion_qa_language_signal: discussionTerms.length ? 1 : 0,
    zhihu_discussion_evidence_signal: evidenceTerms.length ? 1 : 0,
    zhihu_discussion_amplification_signal: amplificationTerms.length ? 1 : 0,
    zhihu_discussion_response_signal: responseTerms.length ? 1 : 0,
    zhihu_discussion_semantic_signal_count: semanticSignalCount,
    zhihu_discussion_complete_crisis_narrative_signal: semanticSignalCount >= 4 ? 1 : 0,
    zhihu_discussion_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    zhihu_discussion_qa_terms: [...new Set(discussionTerms)].slice(0, 12),
    zhihu_discussion_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    zhihu_discussion_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    zhihu_discussion_response_terms: [...new Set(responseTerms)].slice(0, 12),
    zhihu_discussion_deep_evidence_signal: enriched ? 1 : 0,
    zhihu_discussion_risk_score: score,
    zhihu_discussion_risk_bucket: zhihuDiscussionRiskBucket(score),
    zhihu_discussion_risk_signal_count: [...new Set(reasons)].length,
    zhihu_discussion_risk_reasons: [...new Set(reasons)],
  };
}

export function parseZhihuSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "zhihu",
  }).map(item => {
    const url = normalizeZhihuUrl(item.url);
    if (!url || !isConcreteZhihuUrl(url)) return null;
    const evidenceKind = zhihuEvidenceKind(url);
    const result = {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "知乎公開搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_zhihu",
        source_kind: "zhihu_public_search",
        zhihu_evidence_kind: evidenceKind,
        collection_mode: "site_zhihu_public_search",
      },
    };
    result.metrics = {
      ...(result.metrics || {}),
      ...zhihuDiscussionRiskSignals(result, keyword),
    };
    return result;
  }).filter(Boolean);
}

async function insertZhihuItems(items, {
  keyword,
  proxyUrl = "",
  enrich = true,
  maxDeepPages = 0,
  domainControls = {},
  contentControls = {},
  seenItemUrls = null,
  directCollector = false,
}) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = zhihuSearchDedupeKey(item);
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
    const title = zhihuTitleFromHtml(enriched.raw_html || "", item.title) || item.title;
    const sentiment = analyzeSentiment(`${title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const finalMetrics = {
      ...evidenceMetrics,
      ...zhihuDiscussionRiskSignals({
        ...item,
        title,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
      source_key: "zhihuSearch",
      source_family: "knowledge",
    };
    const result = insertSentimentItem({
      platform: "zhihu",
      url: item.url,
      title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title, content, sentiment }),
      keyword,
      keywords: [keyword, ...zhihuKeywordNeedles(keyword)],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: item.evidenceType || enriched.evidence?.evidence_type || "zhihu_public_search_result",
        source_key: "zhihuSearch",
        metrics: {
          ...finalMetrics,
          ...zhihuKeywordDiagnostics({
            ...item,
            title,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          zhihu_canonical_dedupe_url: dedupeKey,
          zhihu_search_scan_dedupe_key: dedupeKey,
        },
      },
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      domainControls,
      contentControls,
      disableContentFingerprintDedupe: directCollector,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeZhihuSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeZhihuDirectUrls(directUrls, 20);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  if (normalizedDirectUrls.length) {
    const directKeyword = normalizedKeywords[0] || "zhihu-direct-url";
    const directItems = normalizedDirectUrls.map(url => ({
      url,
      title: zhihuTitleFromUrl(url),
      content: "",
      author: "知乎直達原帖",
      publishedAt: new Date().toISOString(),
      evidenceType: "zhihu_direct_discussion",
      metrics: {
        source_key: "zhihuSearch",
        source_family: "knowledge",
        source_kind: "zhihu_direct_url",
        collection_mode: "zhihu_direct_url",
        deep_collector: "zhihu-direct-url",
        source: "zhihu_direct_discussion",
        direct_url: url,
        zhihu_direct_url: url,
        zhihu_evidence_kind: zhihuEvidenceKind(url),
      },
    }));
    try {
      inserted += await insertZhihuItems(directItems, {
        keyword: directKeyword,
        proxyUrl,
        enrich: true,
        maxDeepPages: normalizedDirectUrls.length,
        domainControls,
        contentControls,
        seenItemUrls,
        directCollector: true,
      });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword: directKeyword, target: "zhihu-direct-url", message });
      console.warn(`[Sentiment/Zhihu] 直達原帖抓取失敗 keyword=${directKeyword}: ${message}`);
    }
  }

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `site:zhihu.com ${keyword}`;
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
        const items = parseZhihuSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            zhihu_search_page: page + 1,
            zhihu_search_offset: page * 10,
            zhihu_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...zhihuDiscussionRiskSignals(item, keyword),
          },
        }));
        const count = await insertZhihuItems(items, {
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
        console.warn(`[Sentiment/Zhihu] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteZhihuUrl,
  normalizeBudget,
  normalizeZhihuDirectUrls,
  normalizeZhihuDedupeUrl,
  normalizeZhihuUrl,
  zhihuTitleFromHtml,
  zhihuTitleFromUrl,
  normalizeZhihuKeywordText,
  zhihuKeywordNeedles,
  zhihuValueMatchesKeyword,
  parseZhihuSearchResults,
  zhihuSearchDedupeKey,
  zhihuEvidenceKind,
  zhihuKeywordMatchSource,
  zhihuKeywordDiagnostics,
  zhihuDiscussionRiskBucket,
  zhihuTermMatches,
  zhihuDiscussionRiskSignals,
};
