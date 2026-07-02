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

function normalizeKuaishouUrl(value = "") {
  const raw = cleanText(value, 1600);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "kuaishou.com") return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "fid", "cc", "timestamp", "share_id", "shareToken", "share_token", "shareObjectId", "shareMethod", "from", "source"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeKuaishouDedupeUrl(value = "") {
  const normalized = normalizeKuaishouUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "fid", "cc", "timestamp", "share_id", "shareToken", "share_token", "shareObjectId", "shareMethod", "from", "source"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function kuaishouSearchDedupeKey(item = {}) {
  return normalizeKuaishouDedupeUrl(item?.url || "");
}

function normalizeKuaishouKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function kuaishouKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeKuaishouKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function kuaishouValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeKuaishouKeywordText(value);
  return kuaishouKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeKuaishouKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function kuaishouKeywordMatchSource(item = {}, keyword = "") {
  if (!kuaishouKeywordNeedles(keyword).length) return "";
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["kuaishou_evidence_kind", metrics.kuaishou_evidence_kind],
    ["public_search_engine", metrics.public_search_engine],
  ];
  const match = fields.find(([, value]) => kuaishouValueMatchesKeyword(value, keyword));
  return match ? match[0] : "";
}

function kuaishouKeywordDiagnostics(item = {}, keyword = "") {
  return {
    kuaishou_matched_keyword: cleanText(keyword, 160),
    kuaishou_keyword_match_source: kuaishouKeywordMatchSource(item, keyword),
  };
}

function kuaishouVideoSpreadBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function kuaishouTermMatches(value = "", terms = []) {
  const text = cleanText(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function kuaishouVideoReference(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "short-video") {
      return {
        videoId: /^[A-Za-z0-9_-]{6,}$/.test(segments[1] || "") ? segments[1] : "",
      };
    }
  } catch {
    return { videoId: "" };
  }
  return { videoId: "" };
}

function kuaishouVideoSpreadSignals(item = {}, keyword = "") {
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
  const responseTerms = kuaishouTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "客服回應", "客服回应", "公開回應", "公开回应",
    "道歉", "澄清", "後續", "后续", "處理結果", "处理结果", "退款處理", "退款处理",
    "official response", "official statement", "public response", "customer support response",
    "support response", "apology", "clarification", "follow-up", "resolved", "refund processed",
  ]);
  const rawResultCount = Math.max(0, Number(metrics.kuaishou_search_raw_result_count || 0));
  const isVideo = metrics.kuaishou_evidence_kind === "video" || kuaishouEvidenceKind(item.url) === "video";
  const reference = kuaishouVideoReference(item.url || "");
  const hasVideoId = Boolean(metrics.kuaishou_video_id || reference.videoId);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = kuaishouKeywordMatchSource(item, keyword) === "title";
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
    kuaishou_video_concrete_signal: isVideo ? 1 : 0,
    kuaishou_video_id: metrics.kuaishou_video_id || reference.videoId,
    kuaishou_video_id_signal: hasVideoId ? 1 : 0,
    kuaishou_video_crisis_language_signal: crisisTerms.length ? 1 : 0,
    kuaishou_video_amplification_signal: amplificationTerms.length ? 1 : 0,
    kuaishou_video_engagement_signal: engagementTerms.length ? 1 : 0,
    kuaishou_video_evidence_signal: evidenceTerms.length ? 1 : 0,
    kuaishou_video_response_signal: responseTerms.length ? 1 : 0,
    kuaishou_video_semantic_signal_count: semanticSignalCount,
    kuaishou_video_complete_crisis_narrative_signal: semanticSignalCount >= 4 ? 1 : 0,
    kuaishou_video_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    kuaishou_video_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    kuaishou_video_engagement_terms: [...new Set(engagementTerms)].slice(0, 12),
    kuaishou_video_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    kuaishou_video_response_terms: [...new Set(responseTerms)].slice(0, 12),
    kuaishou_video_deep_evidence_signal: enriched ? 1 : 0,
    kuaishou_video_spread_score: score,
    kuaishou_video_spread_bucket: kuaishouVideoSpreadBucket(score),
    kuaishou_video_spread_signal_count: [...new Set(reasons)].length,
    kuaishou_video_spread_reasons: [...new Set(reasons)],
  };
}

function isConcreteKuaishouVideoUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "kuaishou.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|profile|user|u|live|new-reco|hot|hashtag|tag|download)$/i.test(segments[0])) return false;
    if (segments[0] === "short-video") return /^[A-Za-z0-9_-]{6,}$/.test(segments[1] || "");
    return false;
  } catch {
    return false;
  }
}

function kuaishouEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (first === "short-video") return "video";
  } catch {
    return "";
  }
  return "";
}

export function parseKuaishouSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "kuaishou",
  }).map(item => {
    const url = normalizeKuaishouUrl(item.url);
    if (!url || !isConcreteKuaishouVideoUrl(url)) return null;
    const result = {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "快手公開搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_kuaishou",
        source_kind: "kuaishou_public_video_search",
        kuaishou_evidence_kind: kuaishouEvidenceKind(url),
        kuaishou_video_id: kuaishouVideoReference(url).videoId,
        collection_mode: "site_kuaishou_public_search",
      },
    };
    result.metrics = {
      ...(result.metrics || {}),
      ...kuaishouVideoSpreadSignals(result, keyword),
    };
    return result;
  }).filter(Boolean);
}

async function insertKuaishouItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = kuaishouSearchDedupeKey(item);
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
      ...kuaishouVideoSpreadSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "kuaishou",
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
        evidence_type: enriched.evidence?.evidence_type || "kuaishou_public_video_search_result",
        metrics: {
          ...finalMetrics,
          ...kuaishouKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          kuaishou_canonical_dedupe_url: dedupeKey,
          kuaishou_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeKuaishouSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
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
      const query = `site:kuaishou.com/short-video ${keyword}`;
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
        const items = parseKuaishouSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            kuaishou_search_page: page + 1,
            kuaishou_search_offset: page * 10,
            kuaishou_search_raw_result_count: rawResultCount,
          },
        })).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            ...kuaishouVideoSpreadSignals(item, keyword),
          },
        }));
        const count = await insertKuaishouItems(items, {
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
        console.warn(`[Sentiment/Kuaishou] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteKuaishouVideoUrl,
  kuaishouSearchDedupeKey,
  kuaishouEvidenceKind,
  normalizeBudget,
  normalizeKuaishouDedupeUrl,
  normalizeKuaishouUrl,
  normalizeKuaishouKeywordText,
  kuaishouValueMatchesKeyword,
  kuaishouKeywordMatchSource,
  kuaishouKeywordDiagnostics,
  kuaishouVideoSpreadBucket,
  kuaishouTermMatches,
  kuaishouVideoSpreadSignals,
  kuaishouVideoReference,
  parseKuaishouSearchResults,
};
