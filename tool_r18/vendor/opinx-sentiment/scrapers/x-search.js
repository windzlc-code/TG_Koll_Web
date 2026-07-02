import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_SEARCH_URL = "https://tw.search.yahoo.com/search";
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const SITE_SCOPES = ["x.com", "twitter.com"];

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

function isXHost(hostname = "") {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  return host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com";
}

function normalizeXUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!isXHost(url.hostname)) return "";
    url.hostname = "x.com";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "s", "t", "ref_src", "ref_url", "twclid", "lang", "mx"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeXDedupeUrl(value = "") {
  const normalized = normalizeXUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "s", "t", "ref_src", "ref_url", "twclid", "lang", "mx"]) {
      url.searchParams.delete(key);
    }
    url.hostname = "x.com";
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function xSearchDedupeKey(item = {}) {
  return normalizeXDedupeUrl(item?.url || "");
}

function normalizeXKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function xKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeXKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function xValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeXKeywordText(value);
  return xKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeXKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function xKeywordMatchSource(item = {}, keyword = "") {
  if (!xKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["x_evidence_kind", item.metrics?.x_evidence_kind],
    ["search_scope", item.metrics?.search_scope],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (xValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function xKeywordDiagnostics(item = {}, keyword = "") {
  return {
    x_matched_keyword: stripTags(keyword, 160),
    x_keyword_match_source: xKeywordMatchSource(item, keyword),
  };
}

function isConcreteXUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!isXHost(parsed.hostname)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|hashtag|home|explore|i|intent|share|privacy|tos|settings|login|signup|download|notifications|messages|compose)$/i.test(segments[0])) {
      return segments[0] === "i" && segments[1] === "web" && segments[2] === "status" && /^\d{6,}$/.test(segments[3] || "");
    }
    if (segments.length >= 3 && /^status(es)?$/i.test(segments[1]) && /^\d{6,}$/.test(segments[2])) return true;
    return false;
  } catch {
    return false;
  }
}

function xEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.includes("status") || segments.includes("statuses")) return "status";
    return "public-page";
  } catch {
    return "";
  }
}

function xStatusReference(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const statusIndex = segments.findIndex(segment => /^status(es)?$/i.test(segment));
    const statusId = statusIndex >= 0 ? segments[statusIndex + 1] || "" : "";
    const author = statusIndex > 0 ? segments[statusIndex - 1] || "" : "";
    return {
      author: author.replace(/^@/, ""),
      statusId: /^\d{6,}$/.test(statusId) ? statusId : "",
    };
  } catch {
    return { author: "", statusId: "" };
  }
}

function xPropagationSignals(text = "") {
  const source = stripTags(text, 1800).toLowerCase();
  const repost = /\b(rt|retweet|retweeted|repost|reposts|reposted|reshare|reshares|shared)\b|轉發|转发|轉推|转推|轉貼|转贴|轉載|转载/.test(source);
  const quote = /\bquote|quoted|quote tweet|quoted tweet\b|引用|引述|轉述|转述/.test(source);
  const reply = /\breply|replies|replied|responding to|in response to\b|回覆|回复|留言/.test(source);
  const viral = /\bviral|spreading|amplified|amplifying|trending|reposts?|shares?\b|擴散|扩散|大量轉發|大量转发|熱議|热议/.test(source);
  const reasons = [];
  if (repost) reasons.push("repost-language");
  if (quote) reasons.push("quote-language");
  if (reply) reasons.push("reply-language");
  if (viral) reasons.push("amplification-language");
  return {
    x_repost_signal: repost ? 1 : 0,
    x_quote_signal: quote ? 1 : 0,
    x_reply_signal: reply ? 1 : 0,
    x_amplification_signal: viral ? 1 : 0,
    x_propagation_signal_count: reasons.length,
    x_propagation_reasons: reasons,
  };
}

function xStatusRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function xStatusRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const propagationSignals = xPropagationSignals(`${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`);
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const crisisTerms = [
    "complaint", "complaints", "refund", "chargeback", "dispute", "customer support",
    "support delay", "scam", "fraud", "boycott", "crisis", "apology", "backlash",
    "cancel", "investigation", "lawsuit", "exposed",
    "投訴", "投诉", "退款", "客服", "維權", "维权", "爭議", "争议", "危機", "危机",
    "道歉", "抵制", "爆料", "曝光",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "archive", "thread", "timeline",
    "contract", "chat log", "order", "invoice", "documentation", "documents", "emails",
    "截图", "截圖", "证据", "證據", "凭证", "憑證", "合同", "聊天记录", "聊天紀錄", "订单", "訂單",
  ].filter(term => text.includes(term.toLowerCase()));
  const conversationTerms = [
    "reply", "replies", "quote", "quoted", "quote tweet", "thread", "community note",
    "comments", "discussion", "response", "responses",
    "回覆", "回复", "引用", "引述", "转述", "轉述", "讨论", "討論", "评论", "評論", "社群筆記", "社群笔记",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.x_search_raw_result_count || 0));
  const statusRef = xStatusReference(item.url || "");
  const hasStatus = Boolean(metrics.x_status_id || statusRef.statusId);
  const hasAuthor = Boolean(metrics.x_author_handle || statusRef.author);
  const xScope = metrics.search_scope === "x.com";
  const twitterScope = metrics.search_scope === "twitter.com" || /\/\/twitter\.com\//i.test(item.url || "");
  const publicSearchContext = Boolean(metrics.public_search_engine || metrics.source_kind || metrics.collection_mode);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = xKeywordMatchSource(item, keyword) === "title";
  const reasons = [...(propagationSignals.x_propagation_reasons || [])];
  if (crisisTerms.length) reasons.push("crisis-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (conversationTerms.length) reasons.push("conversation-language");
  if (hasStatus) reasons.push("concrete-status-url");
  if (hasAuthor) reasons.push("author-handle-present");
  if (xScope) reasons.push("x-indexed-status");
  if (twitterScope) reasons.push("twitter-indexed-status");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");

  const score = Math.min(100, Math.max(0,
    (hasStatus ? 14 : 0)
    + (hasAuthor ? 6 : 0)
    + (crisisTerms.length ? 24 : 0)
    + (propagationSignals.x_repost_signal ? 12 : 0)
    + (propagationSignals.x_quote_signal ? 12 : 0)
    + (propagationSignals.x_reply_signal ? 10 : 0)
    + (propagationSignals.x_amplification_signal ? 18 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (conversationTerms.length ? 8 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (xScope || twitterScope ? 4 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0)
  ));
  const semanticSignalCount = [
    hasStatus,
    crisisTerms.length,
    evidenceTerms.length || conversationTerms.length,
    propagationSignals.x_propagation_signal_count > 0,
    xScope || twitterScope || rawResultCount > 0 || enriched || publicSearchContext,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5;
  if (completeNarrative) reasons.push("x-complete-social-crisis-narrative");

  return {
    ...propagationSignals,
    x_status_concrete_signal: hasStatus ? 1 : 0,
    x_author_handle_signal: hasAuthor ? 1 : 0,
    x_crisis_language_signal: crisisTerms.length ? 1 : 0,
    x_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    x_conversation_language_signal: conversationTerms.length ? 1 : 0,
    x_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    x_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    x_conversation_terms: [...new Set(conversationTerms)].slice(0, 12),
    x_index_scope_signal: xScope || twitterScope ? 1 : 0,
    x_deep_evidence_signal: enriched ? 1 : 0,
    x_status_risk_score: score,
    x_status_risk_bucket: xStatusRiskBucket(score),
    x_semantic_signal_count: semanticSignalCount,
    x_complete_social_crisis_narrative_signal: completeNarrative ? 1 : 0,
    x_status_risk_signal_count: [...new Set(reasons)].length,
    x_status_risk_reasons: [...new Set(reasons)],
  };
}

function parseSearchDate(text = "", now = new Date()) {
  const source = String(text || "");
  const absoluteZh = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(source);
  if (absoluteZh) return new Date(Number(absoluteZh[1]), Number(absoluteZh[2]) - 1, Number(absoluteZh[3]), 12, 0, 0);
  const absoluteEn = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(source);
  if (absoluteEn) return new Date(`${absoluteEn[1]} ${absoluteEn[2]}, ${absoluteEn[3]} 12:00:00`);
  const relativeZh = /(\d+)\s*(分鐘|分钟|小時|小时|天|日)前/.exec(source);
  if (relativeZh) {
    const amount = Number(relativeZh[1]);
    if (!Number.isFinite(amount)) return null;
    if (/分鐘|分钟/.test(relativeZh[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/小時|小时/.test(relativeZh[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  const relativeEn = /(\d+)\s*(minute|minutes|hour|hours|day|days)\s+ago/i.exec(source);
  if (relativeEn) {
    const amount = Number(relativeEn[1]);
    if (!Number.isFinite(amount)) return null;
    if (/minute/i.test(relativeEn[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/hour/i.test(relativeEn[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  return null;
}

function countXRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeXUrl(match[1]);
    if (url && isConcreteXUrl(url)) count += 1;
  }
  return count;
}

export function parseXSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeXUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteXUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!xValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseSearchDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    const statusRef = xStatusReference(url);
    const propagationSignals = xPropagationSignals(`${title} ${content}`);
    out.push({
      url,
      title,
      content,
      author: "X/Twitter 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_site_x_twitter",
        source_kind: "x_twitter_public_search",
        x_evidence_kind: xEvidenceKind(url),
        x_author_handle: statusRef.author,
        x_status_id: statusRef.statusId,
        ...propagationSignals,
        collection_mode: "site_x_twitter_public_search",
      },
    });
    out[out.length - 1].metrics = {
      ...(out[out.length - 1].metrics || {}),
      ...xStatusRiskSignals(out[out.length - 1], keyword),
    };
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertXItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = xSearchDedupeKey(item);
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
      ...xStatusRiskSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const result = insertSentimentItem({
      platform: "x",
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
        evidence_type: enriched.evidence?.evidence_type || "x_twitter_public_search_result",
        metrics: {
          ...finalMetrics,
          ...xKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          x_canonical_dedupe_url: dedupeKey,
          x_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeXSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
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
        const query = `${keyword} site:${scope}`;
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
            failures.push({ keyword, scope, message: httpFailure(res) });
            continue;
          }
          const html = await res.text();
          const rawResultCount = countXRawResults(html);
          const items = parseXSearchResults(html, keyword, {
            limit: remaining,
            since,
          }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              search_scope: scope,
              x_search_page: page + 1,
              x_search_start: start,
              x_search_raw_result_count: rawResultCount,
            },
          })).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ...xStatusRiskSignals(item, keyword),
            },
          }));
          const count = await insertXItems(items, {
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
          console.warn(`[Sentiment/X] 抓取失敗 keyword=${keyword} scope=${scope}: ${message}`);
        }
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteXUrl,
  normalizeBudget,
  normalizeXDedupeUrl,
  normalizeXUrl,
  parseXSearchResults,
  countXRawResults,
  xSearchDedupeKey,
  xEvidenceKind,
  xStatusReference,
  xPropagationSignals,
  normalizeXKeywordText,
  xValueMatchesKeyword,
  xKeywordMatchSource,
  xKeywordDiagnostics,
  xStatusRiskBucket,
  xStatusRiskSignals,
};
