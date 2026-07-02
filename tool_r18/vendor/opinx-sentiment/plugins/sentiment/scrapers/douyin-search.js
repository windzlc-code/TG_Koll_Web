import { isAfterSince } from "./filters.js";
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

function normalizeDouyinUrl(value = "") {
  const raw = cleanText(value, 1600);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "douyin.com") return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "previous_page", "enter_from", "from", "source", "share_token", "share_sign", "share_version", "iid", "device_id"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeDouyinDedupeUrl(value = "") {
  const normalized = normalizeDouyinUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "previous_page", "enter_from", "from", "source", "share_token", "share_sign", "share_version", "iid", "device_id"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeDouyinDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const url = normalizeDouyinDedupeUrl(value);
    if (!url || !isConcreteDouyinVideoUrl(url)) continue;
    const reference = douyinVideoReference(url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      originalUrl: normalizeDouyinUrl(value) || url,
      videoId: reference.videoId,
      dedupeKey: url,
    });
    if (out.length >= Math.max(1, Number(limit) || 20)) break;
  }
  return out;
}

function douyinSearchDedupeKey(item = {}) {
  return normalizeDouyinDedupeUrl(item?.url || "");
}

function normalizeDouyinKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function douyinKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeDouyinKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function douyinValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeDouyinKeywordText(value);
  return douyinKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeDouyinKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function douyinKeywordMatchSource(item = {}, keyword = "") {
  if (!douyinKeywordNeedles(keyword).length) return "";
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["douyin_evidence_kind", metrics.douyin_evidence_kind],
    ["public_search_engine", metrics.public_search_engine],
  ];
  const match = fields.find(([, value]) => douyinValueMatchesKeyword(value, keyword));
  return match ? match[0] : "";
}

function douyinKeywordDiagnostics(item = {}, keyword = "") {
  return {
    douyin_matched_keyword: cleanText(keyword, 160),
    douyin_keyword_match_source: douyinKeywordMatchSource(item, keyword),
  };
}

function douyinVideoSpreadBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function douyinTermMatches(value = "", terms = []) {
  const text = cleanText(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function douyinVideoReference(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "video") {
      return {
        videoId: /^[A-Za-z0-9_-]{6,}$/.test(segments[1] || "") ? segments[1] : "",
      };
    }
  } catch {
    return { videoId: "" };
  }
  return { videoId: "" };
}

function stripHtml(value = "", max = 1200) {
  return cleanText(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">"), max);
}

function extractMetaContent(html = "", names = []) {
  const text = String(html || "");
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const match = pattern.exec(text);
    if (match?.[1]) return stripHtml(match[1], 1200);
    const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
    const reverseMatch = reversePattern.exec(text);
    if (reverseMatch?.[1]) return stripHtml(reverseMatch[1], 1200);
  }
  return "";
}

function parseDouyinDirectVideoPage(html = "", direct = {}, keyword = "") {
  const url = normalizeDouyinDedupeUrl(direct.url || direct.originalUrl || "");
  if (!url || !isConcreteDouyinVideoUrl(url)) return null;
  const reference = douyinVideoReference(url);
  const rawTitle = extractMetaContent(html, ["og:title", "twitter:title"])
    || stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""))?.[1] || "", 240);
  const title = rawTitle
    .replace(/\s*[-_]\s*抖音.*$/i, "")
    .trim()
    || `抖音视频 ${reference.videoId || url}`;
  const content = extractMetaContent(html, ["description", "og:description", "twitter:description"])
    || stripHtml(html, 1600)
    || `${keyword || ""} 抖音直达视频 ${reference.videoId || url}`;
  const item = {
    url,
    title,
    content,
    author: extractMetaContent(html, ["author"]) || "抖音直达视频",
    publishedAt: new Date().toISOString(),
    rawHtml: html,
    metrics: {
      source_kind: "douyin_direct_url",
      collection_mode: "douyin_direct_url",
      deep_collector: "douyin-direct-url",
      direct_url: url,
      douyin_direct_url: url,
      douyin_original_direct_url: direct.originalUrl || direct.url || url,
      douyin_direct_url_signal: 1,
      douyin_evidence_kind: "video",
      douyin_video_id: reference.videoId,
      disableContentFingerprintDedupe: true,
    },
  };
  item.metrics = {
    ...(item.metrics || {}),
    ...douyinVideoSpreadSignals(item, keyword),
  };
  return item;
}

function douyinVideoSpreadSignals(item = {}, keyword = "") {
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
    "評論", "评论", "留言", "回复", "回覆", "合拍", "二創", "二创", "跟拍", "翻拍",
    "討論", "讨论", "comment", "comments", "reply", "replies", "duet", "reaction", "responses",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "截圖", "截图", "錄屏", "录屏", "证据", "證據", "凭证", "憑證", "聊天记录", "聊天紀錄",
    "訂單", "订单", "合同", "發票", "发票", "screenshot", "screen recording", "evidence", "proof",
    "receipt", "chat log", "order", "invoice", "documentation",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = douyinTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "客服回應", "客服回应", "公開回應", "公开回应",
    "道歉", "澄清", "後續", "后续", "處理結果", "处理结果", "退款處理", "退款处理",
    "official response", "official statement", "public response", "customer support response",
    "support response", "apology", "clarification", "follow-up", "resolved", "refund processed",
  ]);
  const rawResultCount = Math.max(0, Number(metrics.douyin_search_raw_result_count || 0));
  const isVideo = metrics.douyin_evidence_kind === "video" || douyinEvidenceKind(item.url) === "video";
  const reference = douyinVideoReference(item.url || "");
  const hasVideoId = Boolean(metrics.douyin_video_id || reference.videoId);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = douyinKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isVideo) reasons.push("concrete-video-url");
  if (hasVideoId) reasons.push("video-id-present");
  if (crisisTerms.length) reasons.push("short-video-crisis-language");
  if (amplificationTerms.length) reasons.push("short-video-amplification-language");
  if (engagementTerms.length) reasons.push("short-video-engagement-language");
  if (evidenceTerms.length) reasons.push("short-video-evidence-language");
  if (responseTerms.length) reasons.push("short-video-response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");
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
    + (hasVideoId ? 6 : 0)
    + (crisisTerms.length ? 24 : 0)
    + (amplificationTerms.length ? 20 : 0)
    + (engagementTerms.length ? 12 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (responseTerms.length ? 12 : 0)
    + (semanticSignalCount >= 4 ? 10 : semanticSignalCount >= 3 ? 5 : 0)
    + (rawResultCount > 1 ? 12 : 0)
    + (enriched ? 14 : 0)
    + (titleMatch ? 12 : 0)
  ));

  return {
    douyin_video_concrete_signal: isVideo ? 1 : 0,
    douyin_video_id: metrics.douyin_video_id || reference.videoId,
    douyin_video_id_signal: hasVideoId ? 1 : 0,
    douyin_video_crisis_language_signal: crisisTerms.length ? 1 : 0,
    douyin_video_amplification_signal: amplificationTerms.length ? 1 : 0,
    douyin_video_engagement_signal: engagementTerms.length ? 1 : 0,
    douyin_video_evidence_signal: evidenceTerms.length ? 1 : 0,
    douyin_video_response_signal: responseTerms.length ? 1 : 0,
    douyin_video_semantic_signal_count: semanticSignalCount,
    douyin_video_complete_crisis_narrative_signal: semanticSignalCount >= 4 ? 1 : 0,
    douyin_video_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    douyin_video_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    douyin_video_engagement_terms: [...new Set(engagementTerms)].slice(0, 12),
    douyin_video_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    douyin_video_response_terms: [...new Set(responseTerms)].slice(0, 12),
    douyin_video_deep_evidence_signal: enriched ? 1 : 0,
    douyin_video_spread_score: score,
    douyin_video_spread_bucket: douyinVideoSpreadBucket(score),
    douyin_video_spread_signal_count: [...new Set(reasons)].length,
    douyin_video_spread_reasons: [...new Set(reasons)],
  };
}

function isConcreteDouyinVideoUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "douyin.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|user|discover|channel|live|hot|topic|follow|friends|download)$/i.test(segments[0])) return false;
    if (segments[0] === "video") return /^[A-Za-z0-9_-]{6,}$/.test(segments[1] || "");
    return false;
  } catch {
    return false;
  }
}

function douyinEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (first === "video") return "video";
  } catch {
    return "";
  }
  return "";
}

export function parseDouyinSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "douyin",
  }).map(item => {
    const url = normalizeDouyinUrl(item.url);
    if (!url || !isConcreteDouyinVideoUrl(url)) return null;
    const result = {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "抖音公開搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_douyin",
        source_kind: "douyin_public_video_search",
        douyin_evidence_kind: douyinEvidenceKind(url),
        douyin_video_id: douyinVideoReference(url).videoId,
        collection_mode: "site_douyin_public_search",
      },
    };
    result.metrics = {
      ...(result.metrics || {}),
      ...douyinVideoSpreadSignals(result, keyword),
    };
    return result;
  }).filter(Boolean);
}

async function insertDouyinItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = douyinSearchDedupeKey(item);
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
      ...douyinVideoSpreadSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "douyin",
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
        evidence_type: enriched.evidence?.evidence_type || (item.metrics?.collection_mode === "douyin_direct_url" ? "douyin_direct_video" : "douyin_public_video_search_result"),
        metrics: {
          ...finalMetrics,
          ...douyinKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          douyin_canonical_dedupe_url: dedupeKey,
          douyin_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeDouyinSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeDouyinDirectUrls(directUrls);
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
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, url: direct.url, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const item = parseDouyinDirectVideoPage(html, direct, keyword);
        if (!item || !isAfterSince(item.publishedAt, since)) continue;
        const count = await insertDouyinItems([item], {
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
        console.warn(`[Sentiment/Douyin] 直达视频抓取失敗 url=${direct.url}: ${message}`);
      }
    }
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `site:douyin.com/video ${keyword}`;
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
        const items = parseDouyinSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            douyin_search_page: page + 1,
            douyin_search_offset: page * 10,
            douyin_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...douyinVideoSpreadSignals(item, keyword),
          },
        }));
        const count = await insertDouyinItems(items, {
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
        console.warn(`[Sentiment/Douyin] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  douyinSearchDedupeKey,
  douyinEvidenceKind,
  isConcreteDouyinVideoUrl,
  normalizeBudget,
  normalizeDouyinDirectUrls,
  normalizeDouyinDedupeUrl,
  normalizeDouyinUrl,
  normalizeDouyinKeywordText,
  douyinValueMatchesKeyword,
  douyinKeywordMatchSource,
  douyinKeywordDiagnostics,
  douyinVideoSpreadBucket,
  douyinTermMatches,
  douyinVideoSpreadSignals,
  douyinVideoReference,
  parseDouyinDirectVideoPage,
  parseDouyinSearchResults,
};
