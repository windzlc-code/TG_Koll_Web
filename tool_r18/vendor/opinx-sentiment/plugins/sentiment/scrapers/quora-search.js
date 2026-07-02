import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_SEARCH_URL = "https://tw.search.yahoo.com/search";
const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ensp;|&#8194;/gi, " ")
    .replace(/&emsp;|&#8195;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html, max = 1200) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
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

function normalizeYahooRedirectUrl(rawUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded) return "";
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
    if (/r\.search\.yahoo\.com$/i.test(url.hostname)) {
      const ru = /\/RU=([^/]+)/.exec(url.pathname);
      if (ru?.[1]) return normalizeYahooRedirectUrl(decodeURIComponent(ru[1]));
      const direct = url.searchParams.get("u") || url.searchParams.get("url");
      if (direct) return normalizeYahooRedirectUrl(decodeURIComponent(direct));
    }
    url.hash = "";
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeQuoraUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "quora.com") return "";
    url.hash = "";
    for (const key of ["share", "utm_source", "utm_medium", "utm_campaign", "utm_content", "ch", "oid", "srid", "target_type"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeQuoraDedupeUrl(value = "") {
  const normalized = normalizeQuoraUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["share", "utm_source", "utm_medium", "utm_campaign", "utm_content", "ch", "oid", "srid", "target_type", "source"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeQuoraDirectUrls(values = [], limit = 20) {
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeQuoraUrl(value);
    if (!normalized || !isConcreteQuoraUrl(normalized)) continue;
    const dedupe = normalizeQuoraDedupeUrl(normalized);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
    if (out.length >= Math.max(1, Math.min(80, Number(limit) || 20))) break;
  }
  return out;
}

function quoraSearchDedupeKey(item = {}) {
  return normalizeQuoraDedupeUrl(item?.url || "");
}

function normalizeQuoraKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function quoraKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeQuoraKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function quoraValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeQuoraKeywordText(value);
  return quoraKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeQuoraKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function quoraKeywordMatchSource(item = {}, keyword = "") {
  if (!quoraKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["quora_evidence_kind", item.metrics?.quora_evidence_kind],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (quoraValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function quoraKeywordDiagnostics(item = {}, keyword = "") {
  return {
    quora_matched_keyword: stripTags(keyword, 160),
    quora_keyword_match_source: quoraKeywordMatchSource(item, keyword),
  };
}

function isConcreteQuoraUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "quora.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|profile|topic|about|login|signup|spaces|notifications|answer)$/i.test(segments[0])) return false;
    if (segments[0] === "q") return segments.length >= 2;
    return segments[0].length >= 8;
  } catch {
    return false;
  }
}

function quoraEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (first === "q") return "space-post";
    if (parsed.pathname.includes("/answer/")) return "answer";
    return "question";
  } catch {
    return "";
  }
}

function quoraTitleFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug = segments[0] === "q" ? segments[1] || "" : segments[0] || "";
    const title = stripTags(String(slug || "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(), 260);
    return title || "Quora discussion";
  } catch {
    return "Quora discussion";
  }
}

function quoraTitleFromHtml(html = "", fallback = "") {
  const source = String(html || "");
  const candidates = [
    (source.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) || [])[1],
    (source.match(/<meta\b[^>]*(?:property|name)=["']twitter:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) || [])[1],
    (source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1],
    (source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1],
    fallback,
  ];
  return stripTags(candidates.find(Boolean) || fallback || "", 300);
}

function quoraDiscussionRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function quoraTermMatches(value = "", terms = []) {
  const text = stripTags(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function quoraDiscussionRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "complaint", "complaints", "refund", "chargeback", "dispute", "support delay",
    "customer support", "scam", "fraud", "boycott", "crisis", "apology", "lawsuit",
    "投訴", "投诉", "退款", "客服", "維權", "维权", "爭議", "争议",
  ].filter(term => text.includes(term.toLowerCase()));
  const discussionTerms = [
    "answer", "answers", "question", "quora answer", "quora users", "discussion",
    "comment", "comments", "reply", "replies", "experience", "how should",
    "how can", "what should", "timeline",
    "回答", "问题", "問題", "讨论", "討論", "经验", "經驗",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline", "contract",
    "chat log", "order", "invoice", "documentation", "case details",
    "截图", "截圖", "证据", "證據", "合同", "聊天记录", "聊天紀錄", "订单", "訂單",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "viral", "spreading", "trending", "shared", "repost", "amplified", "widely discussed",
    "public backlash", "brand response", "media attention",
    "热议", "熱議", "扩散", "擴散", "发酵", "發酵", "传播", "傳播", "转发", "轉發",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = quoraTermMatches(text, [
    "brand response", "official response", "official statement", "public response", "customer support response",
    "support response", "apology", "clarification", "follow-up", "resolved", "refund processed",
    "官方回应", "官方回應", "官方声明", "官方聲明", "客服回应", "客服回應", "公开回应", "公開回應",
    "道歉", "澄清", "后续", "後續", "处理结果", "處理結果", "回应", "回應",
  ]);
  const rawResultCount = Math.max(0, Number(metrics.quora_search_raw_result_count || 0));
  const evidenceKind = metrics.quora_evidence_kind || quoraEvidenceKind(item.url);
  const isQuestionOrAnswer = evidenceKind === "question" || evidenceKind === "answer";
  const isSpacePost = evidenceKind === "space-post";
  const isConcrete = Boolean(evidenceKind);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.article_body_text_length || metrics.raw_html_length);
  const titleMatch = quoraKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isConcrete) reasons.push("concrete-quora-url");
  if (isQuestionOrAnswer) reasons.push("qa-discussion-url");
  if (isSpacePost) reasons.push("space-post-url");
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
    + (isSpacePost ? 8 : 0)
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
    quora_discussion_concrete_signal: isConcrete ? 1 : 0,
    quora_discussion_qa_signal: isQuestionOrAnswer ? 1 : 0,
    quora_discussion_space_signal: isSpacePost ? 1 : 0,
    quora_discussion_complaint_signal: complaintTerms.length ? 1 : 0,
    quora_discussion_qa_language_signal: discussionTerms.length ? 1 : 0,
    quora_discussion_evidence_signal: evidenceTerms.length ? 1 : 0,
    quora_discussion_amplification_signal: amplificationTerms.length ? 1 : 0,
    quora_discussion_response_signal: responseTerms.length ? 1 : 0,
    quora_discussion_semantic_signal_count: semanticSignalCount,
    quora_discussion_complete_crisis_narrative_signal: semanticSignalCount >= 4 ? 1 : 0,
    quora_discussion_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    quora_discussion_qa_terms: [...new Set(discussionTerms)].slice(0, 12),
    quora_discussion_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    quora_discussion_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    quora_discussion_response_terms: [...new Set(responseTerms)].slice(0, 12),
    quora_discussion_deep_evidence_signal: enriched ? 1 : 0,
    quora_discussion_risk_score: score,
    quora_discussion_risk_bucket: quoraDiscussionRiskBucket(score),
    quora_discussion_risk_signal_count: [...new Set(reasons)].length,
    quora_discussion_risk_reasons: [...new Set(reasons)],
  };
}

function parseSearchDate(text = "", now = new Date()) {
  const source = String(text || "");
  const absolute = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(source);
  if (absolute) return new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), 12, 0, 0);
  const relative = /(\d+)\s*(分鐘|分钟|小時|小时|天|日)前/.exec(source);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isFinite(amount)) return null;
    if (/分鐘|分钟/.test(relative[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/小時|小时/.test(relative[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  return null;
}

function countQuoraRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeQuoraUrl(match[1]);
    if (url && isConcreteQuoraUrl(url)) count += 1;
  }
  return count;
}

export function parseQuoraSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeQuoraUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteQuoraUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 900);
    if (!quoraValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseSearchDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: "Quora 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_site_quora",
        source_kind: "quora_public_search",
        quora_evidence_kind: quoraEvidenceKind(url),
        collection_mode: "site_quora_public_search",
      },
    });
    out[out.length - 1].metrics = {
      ...(out[out.length - 1].metrics || {}),
      ...quoraDiscussionRiskSignals(out[out.length - 1], keyword),
    };
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertQuoraItems(items, {
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
    const dedupeKey = quoraSearchDedupeKey(item);
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
    const title = quoraTitleFromHtml(enriched.raw_html || "", item.title) || item.title;
    const sentiment = analyzeSentiment(`${title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const finalMetrics = {
      ...evidenceMetrics,
      ...quoraDiscussionRiskSignals({
        ...item,
        title,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
      source_key: "quoraSearch",
      source_family: "knowledge",
    };
    const result = insertSentimentItem({
      platform: "quora",
      url: item.url,
      title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title, content, sentiment }),
      keyword,
      keywords: [keyword, ...quoraKeywordNeedles(keyword)],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: item.evidenceType || enriched.evidence?.evidence_type || "quora_public_search_result",
        source_key: "quoraSearch",
        metrics: {
          ...finalMetrics,
          ...quoraKeywordDiagnostics({
            ...item,
            title,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          quora_canonical_dedupe_url: dedupeKey,
          quora_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeQuoraSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeQuoraDirectUrls(directUrls, 20);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  if (normalizedDirectUrls.length) {
    const directKeyword = normalizedKeywords[0] || "quora-direct-url";
    const directItems = normalizedDirectUrls.map(url => ({
      url,
      title: quoraTitleFromUrl(url),
      content: "",
      author: "Quora 直達問答",
      publishedAt: new Date().toISOString(),
      evidenceType: "quora_direct_discussion",
      metrics: {
        source_key: "quoraSearch",
        source_family: "knowledge",
        source_kind: "quora_direct_url",
        collection_mode: "quora_direct_url",
        deep_collector: "quora-direct-url",
        source: "quora_direct_discussion",
        direct_url: url,
        quora_direct_url: url,
        quora_evidence_kind: quoraEvidenceKind(url),
      },
    }));
    try {
      inserted += await insertQuoraItems(directItems, {
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
      failures.push({ keyword: directKeyword, target: "quora-direct-url", message });
      console.warn(`[Sentiment/Quora] 直達問答抓取失敗 keyword=${directKeyword}: ${message}`);
    }
  }

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `${keyword} site:quora.com`;
      const start = page * 10 + 1;
      const url = `${YAHOO_SEARCH_URL}?p=${encodeURIComponent(query)}&fr=yfp-search-sb&fr2=time&ei=UTF-8&b=${start}`;
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const rawResultCount = countQuoraRawResults(html);
        const items = parseQuoraSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            quora_search_page: page + 1,
            quora_search_start: start,
            quora_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...quoraDiscussionRiskSignals(item, keyword),
          },
        }));
        const count = await insertQuoraItems(items, {
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
        console.warn(`[Sentiment/Quora] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteQuoraUrl,
  normalizeBudget,
  normalizeQuoraDedupeUrl,
  normalizeQuoraUrl,
  normalizeQuoraKeywordText,
  normalizeQuoraDirectUrls,
  quoraTitleFromHtml,
  quoraTitleFromUrl,
  quoraKeywordNeedles,
  quoraValueMatchesKeyword,
  parseQuoraSearchResults,
  countQuoraRawResults,
  quoraSearchDedupeKey,
  quoraEvidenceKind,
  quoraKeywordMatchSource,
  quoraKeywordDiagnostics,
  quoraDiscussionRiskBucket,
  quoraTermMatches,
  quoraDiscussionRiskSignals,
};
