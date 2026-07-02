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

function isTikTokHost(hostname = "") {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

function normalizeTikTokUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!isTikTokHost(url.hostname)) return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "is_from_webapp", "sender_device", "web_id", "share_app_id", "share_item_id", "share_link_id", "referer_url", "referer_video_id", "lang", "tt_from"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeTikTokDedupeUrl(value = "") {
  const normalized = normalizeTikTokUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "is_from_webapp", "sender_device", "web_id", "share_app_id", "share_item_id", "share_link_id", "referer_url", "referer_video_id", "lang", "tt_from"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeTikTokDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const url = normalizeTikTokDedupeUrl(value);
    if (!url || !isConcreteTikTokUrl(url)) continue;
    const reference = tiktokVideoReference(url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      originalUrl: normalizeTikTokUrl(value) || url,
      creatorHandle: reference.creatorHandle,
      videoId: reference.videoId,
      dedupeKey: url,
    });
    if (out.length >= Math.max(1, Number(limit) || 20)) break;
  }
  return out;
}

function tiktokSearchDedupeKey(item = {}) {
  return normalizeTikTokDedupeUrl(item?.url || "");
}

function normalizeTikTokKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function tiktokKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeTikTokKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function tiktokValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeTikTokKeywordText(value);
  return tiktokKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeTikTokKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function tiktokKeywordMatchSource(item = {}, keyword = "") {
  if (!tiktokKeywordNeedles(keyword).length) return "";
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["tiktok_evidence_kind", metrics.tiktok_evidence_kind],
    ["public_search_engine", metrics.public_search_engine],
  ];
  const match = fields.find(([, value]) => tiktokValueMatchesKeyword(value, keyword));
  return match ? match[0] : "";
}

function tiktokKeywordDiagnostics(item = {}, keyword = "") {
  return {
    tiktok_matched_keyword: stripTags(keyword, 160),
    tiktok_keyword_match_source: tiktokKeywordMatchSource(item, keyword),
  };
}

function tiktokVideoSpreadBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function tiktokTermMatches(value = "", terms = []) {
  const text = stripTags(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function tiktokVideoReference(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (/^@[^/]{2,}$/.test(segments[0] || "") && segments[1] === "video") {
      return {
        creatorHandle: segments[0].replace(/^@/, ""),
        videoId: /^\d{6,}$/.test(segments[2] || "") ? segments[2] : "",
      };
    }
    if (/^(v|video)$/i.test(segments[0] || "")) {
      return {
        creatorHandle: "",
        videoId: /^\d{6,}$/.test(segments[1] || "") ? segments[1] : "",
      };
    }
  } catch {
    return { creatorHandle: "", videoId: "" };
  }
  return { creatorHandle: "", videoId: "" };
}

function extractMetaContent(html = "", names = []) {
  const text = String(html || "");
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const match = pattern.exec(text);
    if (match?.[1]) return stripTags(match[1], 1200);
    const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
    const reverseMatch = reversePattern.exec(text);
    if (reverseMatch?.[1]) return stripTags(reverseMatch[1], 1200);
  }
  return "";
}

function parseTikTokDirectVideoPage(html = "", direct = {}, keyword = "") {
  const url = normalizeTikTokDedupeUrl(direct.url || direct.originalUrl || "");
  if (!url || !isConcreteTikTokUrl(url)) return null;
  const reference = tiktokVideoReference(url);
  const rawTitle = extractMetaContent(html, ["og:title", "twitter:title"])
    || stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""))?.[1] || "", 240);
  const title = rawTitle
    .replace(/\s*[-|]\s*TikTok.*$/i, "")
    .trim()
    || `TikTok video ${reference.videoId || url}`;
  const content = extractMetaContent(html, ["description", "og:description", "twitter:description"])
    || stripTags(html, 1600)
    || `${keyword || ""} TikTok direct video ${reference.videoId || url}`;
  const author = extractMetaContent(html, ["author"])
    || (reference.creatorHandle ? `@${reference.creatorHandle}` : "TikTok direct video");
  const item = {
    url,
    title,
    content,
    author,
    publishedAt: new Date().toISOString(),
    rawHtml: html,
    metrics: {
      source_kind: "tiktok_direct_url",
      collection_mode: "tiktok_direct_url",
      deep_collector: "tiktok-direct-url",
      direct_url: url,
      tiktok_direct_url: url,
      tiktok_original_direct_url: direct.originalUrl || direct.url || url,
      tiktok_direct_url_signal: 1,
      tiktok_evidence_kind: "video",
      tiktok_creator_handle: reference.creatorHandle,
      tiktok_video_id: reference.videoId,
      disableContentFingerprintDedupe: true,
    },
  };
  item.metrics = {
    ...(item.metrics || {}),
    ...tiktokVideoSpreadSignals(item, keyword),
  };
  return item;
}

function tiktokVideoSpreadSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const crisisTerms = [
    "投訴", "投诉", "客訴", "退款", "爭議", "争议", "道歉", "抵制", "詐騙", "诈骗",
    "維權", "维权", "爆料", "危機", "危机",
    "complaint", "refund", "dispute", "scam", "fraud", "boycott", "apology", "crisis",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "轉發", "转发", "擴散", "扩散", "熱議", "热议", "爆紅", "爆红", "瘋傳", "疯传",
    "repost", "reposts", "reshare", "shared", "viral", "spread", "amplify", "amplified",
  ].filter(term => text.includes(term.toLowerCase()));
  const engagementTerms = [
    "comment", "comments", "reply", "replies", "duet", "duets", "stitch", "stitched",
    "reaction", "responses", "discussion", "short-video discussion",
    "評論", "评论", "留言", "回复", "回覆", "合拍", "拼接", "二創", "二创", "討論", "讨论",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "timeline", "chat log", "order",
    "invoice", "documentation", "documents", "emails", "screen recording",
    "截图", "截圖", "证据", "證據", "凭证", "憑證", "聊天记录", "聊天紀錄", "订单", "訂單", "录屏", "錄屏",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = tiktokTermMatches(text, [
    "official response", "official statement", "public response", "customer support response",
    "support response", "apology", "clarification", "follow-up", "resolved", "refund processed",
    "官方回應", "官方回应", "官方聲明", "官方声明", "客服回應", "客服回应", "公開回應", "公开回应",
    "道歉", "澄清", "後續", "后续", "處理結果", "处理结果", "退款處理", "退款处理",
  ]);
  const rawResultCount = Math.max(0, Number(metrics.tiktok_search_raw_result_count || 0));
  const isVideo = metrics.tiktok_evidence_kind === "video" || tiktokEvidenceKind(item.url) === "video";
  const reference = tiktokVideoReference(item.url || "");
  const hasCreator = Boolean(metrics.tiktok_creator_handle || reference.creatorHandle);
  const hasVideoId = Boolean(metrics.tiktok_video_id || reference.videoId);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const reasons = [];
  if (isVideo) reasons.push("concrete-video-url");
  if (hasCreator) reasons.push("creator-handle-present");
  if (hasVideoId) reasons.push("video-id-present");
  if (crisisTerms.length) reasons.push("short-video-crisis-language");
  if (amplificationTerms.length) reasons.push("short-video-amplification-language");
  if (engagementTerms.length) reasons.push("short-video-engagement-language");
  if (evidenceTerms.length) reasons.push("short-video-evidence-language");
  if (responseTerms.length) reasons.push("short-video-response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (tiktokKeywordMatchSource(item, keyword) === "title") reasons.push("keyword-title-match");
  const semanticSignalCount = [
    crisisTerms.length,
    amplificationTerms.length,
    engagementTerms.length,
    evidenceTerms.length,
    responseTerms.length,
  ].filter(Boolean).length;
  if (semanticSignalCount >= 4) reasons.push("complete-short-video-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (isVideo ? 18 : 0)
    + (hasCreator ? 6 : 0)
    + (hasVideoId ? 4 : 0)
    + (crisisTerms.length ? 24 : 0)
    + (amplificationTerms.length ? 20 : 0)
    + (engagementTerms.length ? 12 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (responseTerms.length ? 12 : 0)
    + (semanticSignalCount >= 4 ? 10 : semanticSignalCount >= 3 ? 5 : 0)
    + (rawResultCount > 1 ? 12 : 0)
    + (enriched ? 14 : 0)
    + (tiktokKeywordMatchSource(item, keyword) === "title" ? 12 : 0)
  ));

  return {
    tiktok_video_concrete_signal: isVideo ? 1 : 0,
    tiktok_video_creator_handle: metrics.tiktok_creator_handle || reference.creatorHandle,
    tiktok_video_id: metrics.tiktok_video_id || reference.videoId,
    tiktok_video_creator_signal: hasCreator ? 1 : 0,
    tiktok_video_id_signal: hasVideoId ? 1 : 0,
    tiktok_video_crisis_language_signal: crisisTerms.length ? 1 : 0,
    tiktok_video_amplification_signal: amplificationTerms.length ? 1 : 0,
    tiktok_video_engagement_signal: engagementTerms.length ? 1 : 0,
    tiktok_video_evidence_signal: evidenceTerms.length ? 1 : 0,
    tiktok_video_response_signal: responseTerms.length ? 1 : 0,
    tiktok_video_semantic_signal_count: semanticSignalCount,
    tiktok_video_complete_crisis_narrative_signal: semanticSignalCount >= 4 ? 1 : 0,
    tiktok_video_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    tiktok_video_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    tiktok_video_engagement_terms: [...new Set(engagementTerms)].slice(0, 12),
    tiktok_video_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    tiktok_video_response_terms: [...new Set(responseTerms)].slice(0, 12),
    tiktok_video_deep_evidence_signal: enriched ? 1 : 0,
    tiktok_video_spread_score: score,
    tiktok_video_spread_bucket: tiktokVideoSpreadBucket(score),
    tiktok_video_spread_signal_count: [...new Set(reasons)].length,
    tiktok_video_spread_reasons: [...new Set(reasons)],
  };
}

function isConcreteTikTokUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!isTikTokHost(parsed.hostname)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|tag|tags|discover|music|channel|live|login|signup|legal|privacy|about|business|download|explore|foryou)$/i.test(segments[0])) return false;
    if (/^@[^/]{2,}$/.test(segments[0] || "") && segments[1] === "video" && /^\d{6,}$/.test(segments[2] || "")) return true;
    if (/^(v|video)$/i.test(segments[0] || "") && /^\d{6,}$/.test(segments[1] || "")) return true;
    return false;
  } catch {
    return false;
  }
}

function tiktokEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[1] === "video" || /^(v|video)$/i.test(segments[0] || "")) return "video";
    return "public-page";
  } catch {
    return "";
  }
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

function countTikTokRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeTikTokUrl(match[1]);
    if (url && isConcreteTikTokUrl(url)) count += 1;
  }
  return count;
}

export function parseTikTokSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeTikTokUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteTikTokUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!tiktokValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseSearchDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    const videoRef = tiktokVideoReference(url);
    out.push({
      url,
      title,
      content,
      author: "TikTok 公開視頻搜索",
      publishedAt,
	      metrics: {
	        public_search_engine: "yahoo_site_tiktok",
	        source_kind: "tiktok_public_video_search",
	        tiktok_evidence_kind: tiktokEvidenceKind(url),
	        tiktok_creator_handle: videoRef.creatorHandle,
	        tiktok_video_id: videoRef.videoId,
	        collection_mode: "site_tiktok_public_search",
	      },
	    });
	    out[out.length - 1].metrics = {
	      ...(out[out.length - 1].metrics || {}),
	      ...tiktokVideoSpreadSignals(out[out.length - 1], keyword),
	    };
	    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
	  }
	  return out;
}

async function insertTikTokItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = tiktokSearchDedupeKey(item);
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
	      ...tiktokVideoSpreadSignals({
	        ...item,
	        content,
	        author: enriched.author || item.author,
	        metrics: evidenceMetrics,
	      }, keyword),
	    };
	    const sentiment = analyzeSentiment(`${item.title} ${content}`);
	    const result = insertSentimentItem({
      platform: "tiktok",
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
      raw_html: enriched.raw_html || item.rawHtml || "",
      evidence: {
        ...(enriched.evidence || {}),
	        evidence_type: enriched.evidence?.evidence_type || (item.metrics?.collection_mode === "tiktok_direct_url" ? "tiktok_direct_video" : "tiktok_public_video_search_result"),
	        metrics: {
	          ...finalMetrics,
	          ...tiktokKeywordDiagnostics({
	            ...item,
	            content,
	            author: enriched.author || item.author,
	            metrics: finalMetrics,
	          }, keyword),
	          tiktok_canonical_dedupe_url: dedupeKey,
          tiktok_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeTikTokSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeTikTokDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords.length ? normalizedKeywords : [""]) {
    let keywordInserted = 0;
    for (const direct of normalizedDirectUrls) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      try {
        const res = await fetchPublicSource(direct.url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, url: direct.url, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const item = parseTikTokDirectVideoPage(html, direct, keyword);
        if (!item || !isAfterSince(item.publishedAt, since)) continue;
        const count = await insertTikTokItems([item], {
          keyword,
          proxyUrl,
          enrich: false,
          maxDeepPages: 0,
          domainControls,
          contentControls,
          seenItemUrls,
        });
        inserted += count;
        keywordInserted += count;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, url: direct.url, message });
        console.warn(`[Sentiment/TikTok] 直达视频抓取失敗 url=${direct.url}: ${message}`);
      }
    }
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `${keyword} site:tiktok.com`;
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
        const rawResultCount = countTikTokRawResults(html);
	        const items = parseTikTokSearchResults(html, keyword, {
	          limit: remaining,
	          since,
	        }).map(item => ({
	          ...item,
	          metrics: {
	            ...(item.metrics || {}),
	            tiktok_search_page: page + 1,
	            tiktok_search_start: start,
	            tiktok_search_raw_result_count: rawResultCount,
	          },
	        })).map(item => ({
	          ...item,
	          metrics: {
	            ...(item.metrics || {}),
	            ...tiktokVideoSpreadSignals(item, keyword),
	          },
	        }));
        const count = await insertTikTokItems(items, {
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
        console.warn(`[Sentiment/TikTok] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteTikTokUrl,
  normalizeTikTokDirectUrls,
  normalizeTikTokDedupeUrl,
  normalizeTikTokUrl,
  normalizeBudget,
  parseTikTokSearchResults,
  countTikTokRawResults,
  tiktokSearchDedupeKey,
  normalizeTikTokKeywordText,
	  tiktokValueMatchesKeyword,
	  tiktokKeywordMatchSource,
	  tiktokKeywordDiagnostics,
  tiktokVideoSpreadBucket,
	  tiktokTermMatches,
	  tiktokVideoSpreadSignals,
	  tiktokVideoReference,
	  tiktokEvidenceKind,
  parseTikTokDirectVideoPage,
	};
