import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_SEARCH_URL = "https://tw.search.yahoo.com/search";
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
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

function isSubstackHost(hostname = "") {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  return host === "substack.com" || host.endsWith(".substack.com");
}

function normalizeSubstackUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!isSubstackHost(url.hostname)) return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "r", "s", "token", "showWelcome", "publication_id", "post_id"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeSubstackDedupeUrl(value = "") {
  const normalized = normalizeSubstackUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "r",
      "s",
      "token",
      "showWelcome",
      "publication_id",
      "post_id",
      "source",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function substackSearchDedupeKey(item = {}) {
  return normalizeSubstackDedupeUrl(item?.url || "");
}

function normalizeSubstackKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function substackKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeSubstackKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function substackValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeSubstackKeywordText(value);
  return substackKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeSubstackKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function substackKeywordMatchSource(item = {}, keyword = "") {
  if (!substackKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["substack_evidence_kind", item.metrics?.substack_evidence_kind],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (substackValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function substackKeywordDiagnostics(item = {}, keyword = "") {
  return {
    substack_matched_keyword: stripTags(keyword, 160),
    substack_keyword_match_source: substackKeywordMatchSource(item, keyword),
  };
}

function isConcreteSubstackUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!isSubstackHost(parsed.hostname)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(home|browse|inbox|publish|account|sign-in|signin|login|subscribe|search|about|people|settings|privacy|terms|api|embed)$/i.test(segments[0])) return false;
    const postIndex = segments.findIndex(segment => segment.toLowerCase() === "p");
    if (postIndex >= 0) return Boolean(segments[postIndex + 1] && segments[postIndex + 1].length >= 2);
    if (segments[0].startsWith("@") && segments.length >= 2) return true;
    return false;
  } catch {
    return false;
  }
}

function substackEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).map(segment => segment.toLowerCase());
    if (segments.includes("p")) return "post";
    if (segments.includes("notes")) return "note";
    if ((segments[0] || "").startsWith("@")) return "author-post";
    return "newsletter-post";
  } catch {
    return "";
  }
}

function substackArticleRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function substackArticleRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "complaint", "complaints", "refund", "chargeback", "dispute", "customer support",
    "support delay", "scam", "fraud", "boycott", "crisis", "apology", "lawsuit",
    "whistleblower", "backlash",
    "投訴", "投诉", "退款", "客服", "維權", "维权", "爭議", "争议", "危機", "危机",
  ].filter(term => text.includes(term.toLowerCase()));
  const investigationTerms = [
    "investigation", "investigates", "deep dive", "analysis", "report", "newsletter",
    "exclusive", "leak", "leaked", "whistleblower", "case study", "timeline",
    "调查", "調查", "深度", "分析", "报道", "報道", "爆料", "时间线", "時間線",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline", "contract",
    "chat log", "order", "invoice", "documentation", "documents", "emails",
    "截图", "截圖", "证据", "證據", "合同", "聊天记录", "聊天紀錄", "订单", "訂單",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "shared", "subscriber", "subscribers", "paid subscribers", "viral", "spreading",
    "trending", "public backlash", "widely circulated", "media attention", "repost",
    "热议", "熱議", "扩散", "擴散", "发酵", "發酵", "传播", "傳播", "转发", "轉發",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = [
    "brand response", "official response", "company response", "crisis response", "crisis communications",
    "apology", "statement", "customer support response", "corrective action", "remediation", "follow-up",
    "官方回应", "官方回應", "品牌回应", "品牌回應", "声明", "聲明", "道歉", "致歉", "澄清", "整改", "后续", "後續",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.substack_search_raw_result_count || 0));
  const evidenceKind = metrics.substack_evidence_kind || substackEvidenceKind(item.url);
  const isPost = ["post", "newsletter-post", "author-post"].includes(evidenceKind);
  const isNote = evidenceKind === "note";
  const isConcrete = Boolean(evidenceKind);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = substackKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isConcrete) reasons.push("concrete-substack-url");
  if (isPost) reasons.push("newsletter-post-url");
  if (isNote) reasons.push("substack-note-url");
  if (complaintTerms.length) reasons.push("complaint-language");
  if (investigationTerms.length) reasons.push("investigation-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (amplificationTerms.length) reasons.push("amplification-language");
  if (responseTerms.length) reasons.push("response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");
  const semanticSignalCount = [
    complaintTerms.length,
    investigationTerms.length,
    evidenceTerms.length,
    amplificationTerms.length,
    responseTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = complaintTerms.length > 0
    && investigationTerms.length > 0
    && evidenceTerms.length > 0
    && amplificationTerms.length > 0
    && responseTerms.length > 0
    && semanticSignalCount >= 5;
  if (completeNarrative) reasons.push("substack-complete-newsletter-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (isConcrete ? 12 : 0)
    + (isPost ? 10 : 0)
    + (isNote ? 6 : 0)
    + (complaintTerms.length ? 24 : 0)
    + (investigationTerms.length ? 14 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (amplificationTerms.length ? 14 : 0)
    + (responseTerms.length ? 10 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0)
  ));

  return {
    substack_article_concrete_signal: isConcrete ? 1 : 0,
    substack_article_post_signal: isPost ? 1 : 0,
    substack_article_note_signal: isNote ? 1 : 0,
    substack_article_complaint_signal: complaintTerms.length ? 1 : 0,
    substack_article_investigation_signal: investigationTerms.length ? 1 : 0,
    substack_article_evidence_signal: evidenceTerms.length ? 1 : 0,
    substack_article_amplification_signal: amplificationTerms.length ? 1 : 0,
    substack_article_response_signal: responseTerms.length ? 1 : 0,
    substack_article_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    substack_article_investigation_terms: [...new Set(investigationTerms)].slice(0, 12),
    substack_article_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    substack_article_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    substack_article_response_terms: [...new Set(responseTerms)].slice(0, 12),
    substack_article_semantic_signal_count: semanticSignalCount,
    substack_article_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    substack_article_deep_evidence_signal: enriched ? 1 : 0,
    substack_article_risk_score: score,
    substack_article_risk_bucket: substackArticleRiskBucket(score),
    substack_article_risk_signal_count: [...new Set(reasons)].length,
    substack_article_risk_reasons: [...new Set(reasons)],
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

function countSubstackRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeSubstackUrl(match[1]);
    if (url && isConcreteSubstackUrl(url)) count += 1;
  }
  return count;
}

export function parseSubstackSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeSubstackUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteSubstackUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!substackValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
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
      author: "Substack 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_site_substack",
        source_kind: "substack_public_search",
        substack_evidence_kind: substackEvidenceKind(url),
        collection_mode: "site_substack_public_search",
      },
    });
    out[out.length - 1].metrics = {
      ...(out[out.length - 1].metrics || {}),
      ...substackArticleRiskSignals(out[out.length - 1], keyword),
    };
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertSubstackItems(items, {
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
    const dedupeKey = substackSearchDedupeKey(item);
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
    const finalMetrics = {
      ...evidenceMetrics,
      ...substackArticleRiskSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const result = insertSentimentItem({
      platform: "substack",
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
        evidence_type: enriched.evidence?.evidence_type || "substack_public_search_result",
        metrics: {
          ...finalMetrics,
          ...substackKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          substack_canonical_dedupe_url: dedupeKey,
          substack_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeSubstackSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
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
      const query = `${keyword} site:substack.com`;
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
        const rawResultCount = countSubstackRawResults(html);
        const items = parseSubstackSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            substack_search_page: page + 1,
            substack_search_start: start,
            substack_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...substackArticleRiskSignals(item, keyword),
          },
        }));
        const count = await insertSubstackItems(items, {
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
        console.warn(`[Sentiment/Substack] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteSubstackUrl,
  normalizeBudget,
  normalizeSubstackDedupeUrl,
  normalizeSubstackUrl,
  normalizeSubstackKeywordText,
  substackKeywordNeedles,
  substackValueMatchesKeyword,
  parseSubstackSearchResults,
  countSubstackRawResults,
  substackSearchDedupeKey,
  substackEvidenceKind,
  substackKeywordMatchSource,
  substackKeywordDiagnostics,
  substackArticleRiskBucket,
  substackArticleRiskSignals,
};
