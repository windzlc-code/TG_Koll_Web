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

function isWordPressHost(hostname = "") {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  return host === "wordpress.com" || host.endsWith(".wordpress.com");
}

function normalizeWordPressUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!isWordPressHost(url.hostname)) return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "share", "like_comment", "replytocom", "wref", "ref"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeWordPressDedupeUrl(value = "") {
  const normalized = normalizeWordPressUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "share", "like_comment", "replytocom", "wref", "ref", "source"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeWordPressDirectUrls(values = [], limit = 20) {
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeWordPressUrl(value);
    if (!normalized || !isConcreteWordPressUrl(normalized)) continue;
    const dedupe = normalizeWordPressDedupeUrl(normalized);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
    if (out.length >= Math.max(1, Math.min(80, Number(limit) || 20))) break;
  }
  return out;
}

function wordpressSearchDedupeKey(item = {}) {
  return normalizeWordPressDedupeUrl(item?.url || "");
}

function normalizeWordPressKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function wordpressKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeWordPressKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function wordpressValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeWordPressKeywordText(value);
  return wordpressKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeWordPressKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function wordpressKeywordMatchSource(item = {}, keyword = "") {
  if (!wordpressKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["wordpress_evidence_kind", item.metrics?.wordpress_evidence_kind],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (wordpressValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function wordpressKeywordDiagnostics(item = {}, keyword = "") {
  return {
    wordpress_matched_keyword: stripTags(keyword, 160),
    wordpress_keyword_match_source: wordpressKeywordMatchSource(item, keyword),
  };
}

function isConcreteWordPressUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!isWordPressHost(parsed.hostname)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(wp-admin|wp-login|wp-json|xmlrpc\.php|tag|tags|category|categories|author|about|contact|privacy|terms|feed|search|read|discover|themes|plugins|support|pricing|start|go)$/i.test(segments[0])) return false;
    if (/^\d{4}$/.test(segments[0]) && /^\d{1,2}$/.test(segments[1] || "") && /^\d{1,2}$/.test(segments[2] || "")) {
      return Boolean(segments[3] && segments[3].length >= 2);
    }
    return segments.length >= 2 && segments[segments.length - 1].length >= 4;
  } catch {
    return false;
  }
}

function wordpressEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (/^\d{4}$/.test(segments[0] || "")) return "dated-post";
    return "blog-post";
  } catch {
    return "";
  }
}

function wordpressTitleFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug = segments[segments.length - 1] || "";
    const title = stripTags(String(slug || "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(), 240);
    return title || "WordPress blog post";
  } catch {
    return "WordPress blog post";
  }
}

function wordpressTitleFromHtml(html = "", fallback = "") {
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

function wordpressBlogRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function wordpressBlogRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "complaint", "complaints", "refund", "chargeback", "dispute", "customer support",
    "support delay", "scam", "fraud", "boycott", "crisis", "apology", "lawsuit",
    "backlash", "local crisis",
    "投訴", "投诉", "退款", "客服", "維權", "维权", "爭議", "争议", "危機", "危机",
  ].filter(term => text.includes(term.toLowerCase()));
  const analysisTerms = [
    "analysis", "blog post", "public blog", "case study", "investigation", "report",
    "timeline", "local discussion", "community discussion", "review", "breakdown",
    "分析", "博客", "部落格", "调查", "調查", "报道", "報道", "时间线", "時間線", "复盘", "復盤",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline", "contract",
    "chat log", "order", "invoice", "documentation", "documents", "emails",
    "截图", "截圖", "证据", "證據", "合同", "聊天记录", "聊天紀錄", "订单", "訂單",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "shared", "viral", "spreading", "trending", "public backlash", "widely circulated",
    "media attention", "repost", "comments", "local crisis discussion",
    "热议", "熱議", "扩散", "擴散", "发酵", "發酵", "传播", "傳播", "转发", "轉發",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = [
    "brand response", "official response", "company response", "owner response", "manager response",
    "apology", "statement", "customer support response", "corrective action", "remediation", "follow-up",
    "官方回应", "官方回應", "品牌回应", "品牌回應", "声明", "聲明", "道歉", "致歉", "澄清", "整改", "后续", "後續",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.wordpress_search_raw_result_count || 0));
  const evidenceKind = metrics.wordpress_evidence_kind || wordpressEvidenceKind(item.url);
  const isDatedPost = evidenceKind === "dated-post";
  const isBlogPost = evidenceKind === "blog-post" || isDatedPost;
  const isConcrete = Boolean(evidenceKind);
  const enriched = Boolean(
    metrics.enriched
    || metrics.content_enriched
    || metrics.article_body_length
    || metrics.article_body_text_length
    || metrics.raw_html_length
  );
  const titleMatch = wordpressKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isConcrete) reasons.push("concrete-wordpress-url");
  if (isBlogPost) reasons.push("wordpress-blog-post-url");
  if (isDatedPost) reasons.push("dated-post-url");
  if (complaintTerms.length) reasons.push("complaint-language");
  if (analysisTerms.length) reasons.push("analysis-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (amplificationTerms.length) reasons.push("amplification-language");
  if (responseTerms.length) reasons.push("response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");
  const semanticSignalCount = [
    complaintTerms.length,
    analysisTerms.length,
    evidenceTerms.length,
    amplificationTerms.length,
    responseTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = complaintTerms.length > 0
    && analysisTerms.length > 0
    && evidenceTerms.length > 0
    && amplificationTerms.length > 0
    && responseTerms.length > 0
    && semanticSignalCount >= 5;
  if (completeNarrative) reasons.push("wordpress-complete-blog-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (isConcrete ? 12 : 0)
    + (isBlogPost ? 10 : 0)
    + (isDatedPost ? 6 : 0)
    + (complaintTerms.length ? 24 : 0)
    + (analysisTerms.length ? 14 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (amplificationTerms.length ? 14 : 0)
    + (responseTerms.length ? 10 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0)
  ));

  return {
    wordpress_blog_concrete_signal: isConcrete ? 1 : 0,
    wordpress_blog_post_signal: isBlogPost ? 1 : 0,
    wordpress_blog_dated_post_signal: isDatedPost ? 1 : 0,
    wordpress_blog_complaint_signal: complaintTerms.length ? 1 : 0,
    wordpress_blog_analysis_signal: analysisTerms.length ? 1 : 0,
    wordpress_blog_evidence_signal: evidenceTerms.length ? 1 : 0,
    wordpress_blog_amplification_signal: amplificationTerms.length ? 1 : 0,
    wordpress_blog_response_signal: responseTerms.length ? 1 : 0,
    wordpress_blog_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    wordpress_blog_analysis_terms: [...new Set(analysisTerms)].slice(0, 12),
    wordpress_blog_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    wordpress_blog_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    wordpress_blog_response_terms: [...new Set(responseTerms)].slice(0, 12),
    wordpress_blog_semantic_signal_count: semanticSignalCount,
    wordpress_blog_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    wordpress_blog_deep_evidence_signal: enriched ? 1 : 0,
    wordpress_blog_risk_score: score,
    wordpress_blog_risk_bucket: wordpressBlogRiskBucket(score),
    wordpress_blog_risk_signal_count: [...new Set(reasons)].length,
    wordpress_blog_risk_reasons: [...new Set(reasons)],
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

function countWordPressRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeWordPressUrl(match[1]);
    if (url && isConcreteWordPressUrl(url)) count += 1;
  }
  return count;
}

export function parseWordPressSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeWordPressUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteWordPressUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!wordpressValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
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
      author: "WordPress 公開博客搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_site_wordpress",
        source_key: "wordpressSearch",
        source_family: "knowledge",
        source_kind: "wordpress_public_blog_search",
        wordpress_evidence_kind: wordpressEvidenceKind(url),
        collection_mode: "site_wordpress_public_search",
      },
    });
    out[out.length - 1].metrics = {
      ...(out[out.length - 1].metrics || {}),
      ...wordpressBlogRiskSignals(out[out.length - 1], keyword),
    };
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertWordPressItems(items, {
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
    const dedupeKey = wordpressSearchDedupeKey(item);
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
    const title = wordpressTitleFromHtml(enriched.raw_html || "", item.title) || item.title;
    const sentiment = analyzeSentiment(`${title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const finalMetrics = {
      source_key: "wordpressSearch",
      source_family: "knowledge",
      ...evidenceMetrics,
      ...wordpressBlogRiskSignals({
        ...item,
        title,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const directCollector = /direct/i.test(String(item.evidenceType || ""))
      || /direct-url/i.test(String(finalMetrics.deep_collector || ""));
    const result = insertSentimentItem({
      platform: "wordpress",
      url: item.url,
      title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title, content, sentiment }),
      keyword,
      keywords: [...new Set([keyword, ...wordpressKeywordNeedles(keyword)])],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      evidence: {
        ...(enriched.evidence || {}),
        source_key: "wordpressSearch",
        evidence_type: item.evidenceType || enriched.evidence?.evidence_type || "wordpress_public_blog_search_result",
        metrics: {
          ...finalMetrics,
          ...wordpressKeywordDiagnostics({
            ...item,
            title,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          wordpress_canonical_dedupe_url: dedupeKey,
          wordpress_search_scan_dedupe_key: dedupeKey,
        },
      },
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      disableContentFingerprintDedupe: directCollector,
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeWordPressSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeWordPressDirectUrls(directUrls, 20);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  if (normalizedDirectUrls.length) {
    const directKeyword = normalizedKeywords[0] || "wordpress-direct-url";
    const directItems = normalizedDirectUrls.map((url) => ({
      url,
      title: wordpressTitleFromUrl(url),
      content: "",
      author: "WordPress 直達文章",
      publishedAt: new Date().toISOString(),
      evidenceType: "wordpress_direct_blog_post",
      metrics: {
        source_key: "wordpressSearch",
        source_family: "knowledge",
        source_kind: "wordpress_direct_url",
        collection_mode: "wordpress_direct_url",
        deep_collector: "wordpress-direct-url",
        source: "wordpress_direct_blog_post",
        direct_url: url,
        wordpress_direct_url: url,
        wordpress_evidence_kind: wordpressEvidenceKind(url),
      },
    }));
    try {
      inserted += await insertWordPressItems(directItems, {
        keyword: directKeyword,
        proxyUrl,
        enrich: true,
        maxDeepPages: normalizedDirectUrls.length,
        domainControls,
        contentControls,
        seenItemUrls,
      });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword: directKeyword, target: "wordpress-direct-url", message });
      console.warn(`[Sentiment/WordPress] 直抓失敗 keyword=${directKeyword}: ${message}`);
    }
  }

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `${keyword} site:wordpress.com`;
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
        const rawResultCount = countWordPressRawResults(html);
        const items = parseWordPressSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            wordpress_search_page: page + 1,
            wordpress_search_start: start,
            wordpress_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...wordpressBlogRiskSignals(item, keyword),
          },
        }));
        const count = await insertWordPressItems(items, {
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
        console.warn(`[Sentiment/WordPress] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteWordPressUrl,
  normalizeWordPressDirectUrls,
  normalizeBudget,
  normalizeWordPressDedupeUrl,
  normalizeWordPressUrl,
  wordpressTitleFromHtml,
  wordpressTitleFromUrl,
  normalizeWordPressKeywordText,
  wordpressKeywordNeedles,
  wordpressValueMatchesKeyword,
  parseWordPressSearchResults,
  countWordPressRawResults,
  wordpressSearchDedupeKey,
  wordpressEvidenceKind,
  wordpressKeywordMatchSource,
  wordpressKeywordDiagnostics,
  wordpressBlogRiskBucket,
  wordpressBlogRiskSignals,
};
