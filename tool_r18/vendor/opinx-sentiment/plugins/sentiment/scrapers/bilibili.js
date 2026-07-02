import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const BILIBILI_RISK_TERMS = [
  "投訴", "投诉", "客訴", "退款", "爭議", "争议", "道歉", "抵制", "詐騙", "诈骗",
  "維權", "维权", "爆料", "翻車", "翻车", "危機", "危机",
  "complaint", "refund", "dispute", "scam", "fraud", "boycott", "apology", "crisis",
];
const BILIBILI_EVIDENCE_TERMS = [
  "截圖", "截图", "錄屏", "录屏", "证据", "證據", "凭证", "憑證", "聊天记录", "聊天紀錄",
  "訂單", "订单", "合同", "發票", "发票", "時間線", "时间线", "整理", "复盘", "復盤",
  "screenshot", "screen recording", "evidence", "proof", "receipt", "chat log", "timeline",
  "documentation", "documents", "invoice",
];
const BILIBILI_RESPONSE_TERMS = [
  "官方回應", "官方回应", "官方聲明", "官方声明", "客服回應", "客服回应", "道歉", "澄清",
  "後續", "后续", "處理結果", "处理结果", "public response", "official response",
  "official statement", "apology", "clarification", "follow-up", "customer support response",
];
const BILIBILI_PROPAGATION_TERMS = [
  "熱議", "热议", "擴散", "扩散", "發酵", "发酵", "轉發", "转发", "轉載", "转载",
  "破圈", "上熱搜", "上热搜", "出圈", "跟進", "跟进", "後續", "后续", "連載", "连载",
  "彈幕", "弹幕", "評論", "评论", "討論", "讨论", "回應", "回应",
  "viral", "spreading", "amplified", "repost", "reposted", "reaction", "response video",
  "follow-up", "discussion", "comments", "debate",
];

function decodeHtml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(value, max = 1200) {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function bilibiliTermMatches(value = "", terms = []) {
  const text = cleanText(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function perThousand(numerator = 0, denominator = 0) {
  const num = Math.max(0, Number(numerator || 0));
  const den = Math.max(0, Number(denominator || 0));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return Math.round((num / den) * 10000) / 10;
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_RESULTS));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(50, maxItems)) : DEFAULT_MAX_RESULTS,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function parseMetricCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const text = String(value || "").trim();
  if (!text || text === "--") return 0;
  const number = Number(text.replace(/[,，]/g, "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number)) return 0;
  if (/亿|億/i.test(text)) return Math.round(number * 100000000);
  if (/万|萬/i.test(text)) return Math.round(number * 10000);
  if (/k/i.test(text)) return Math.round(number * 1000);
  if (/m/i.test(text)) return Math.round(number * 1000000);
  return Math.round(number);
}

function normalizeBilibiliUrl(value = "", bvid = "") {
  const raw = cleanText(value, 1000);
  if (raw.startsWith("//")) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return bvid ? `https://www.bilibili.com/video/${encodeURIComponent(bvid)}` : "";
}

function extractBilibiliBvidFromUrl(value = "") {
  try {
    const url = new URL(normalizeBilibiliUrl(value));
    const segments = url.pathname.split("/").filter(Boolean);
    const videoIndex = segments.findIndex(segment => segment.toLowerCase() === "video");
    if (videoIndex >= 0 && segments[videoIndex + 1]) return cleanText(segments[videoIndex + 1], 120);
    const bvid = url.searchParams.get("bvid");
    return bvid ? cleanText(bvid, 120) : "";
  } catch {
    const match = /\b(BV[A-Za-z0-9]+)\b/.exec(String(value || ""));
    return match?.[1] || "";
  }
}

function normalizeBilibiliDedupeUrl(value = "", bvid = "") {
  const videoId = cleanText(bvid || extractBilibiliBvidFromUrl(value), 120);
  if (videoId) return `https://www.bilibili.com/video/${encodeURIComponent(videoId)}`;
  const normalized = normalizeBilibiliUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["spm_id_from", "vd_source", "share_source", "share_medium", "share_plat", "share_session_id", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeBilibiliDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeBilibiliUrl(value);
    if (!normalized) continue;
    let url;
    try {
      url = new URL(normalized);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.endsWith("bilibili.com") && host !== "b23.tv") continue;
    url.hash = "";
    for (const key of ["spm_id_from", "vd_source", "share_source", "share_medium", "share_plat", "share_session_id", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      url.searchParams.delete(key);
    }
    const bvid = extractBilibiliBvidFromUrl(url.toString());
    const canonicalUrl = bvid ? normalizeBilibiliDedupeUrl(url.toString(), bvid) : url.toString();
    const dedupeKey = bvid ? `bilibili:${bvid}` : `bilibili:${canonicalUrl}`;
    if (!canonicalUrl || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      url: canonicalUrl,
      originalUrl: normalized,
      bvid,
      dedupeKey,
    });
    if (out.length >= Math.max(1, Number(limit) || 20)) break;
  }
  return out;
}

function bilibiliSearchDedupeKey(item = {}) {
  const bvid = cleanText(item?.bvid || item?.metrics?.bvid || "", 120);
  if (bvid) return `bilibili:${bvid}`;
  const url = normalizeBilibiliDedupeUrl(item?.url || "");
  return url ? `bilibili:${url}` : "";
}

function normalizeBilibiliKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function bilibiliKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeBilibiliKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function bilibiliValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeBilibiliKeywordText(value);
  return bilibiliKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeBilibiliKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function bilibiliKeywordMatchSource(item = {}, keyword = "") {
  if (!bilibiliKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["tags", item.metrics?.tags],
    ["bvid", item.bvid || item.metrics?.bvid],
    ["source_url", item.metrics?.source_url],
  ];
  for (const [field, value] of fields) {
    if (bilibiliValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function bilibiliKeywordDiagnostics(item = {}, keyword = "") {
  return {
    bilibili_matched_keyword: cleanText(keyword, 160),
    bilibili_keyword_match_source: bilibiliKeywordMatchSource(item, keyword),
  };
}

function bilibiliVideoSpreadBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function bilibiliVideoSpreadSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const playCount = Math.max(0, Number(metrics.play_count || 0));
  const danmakuCount = Math.max(0, Number(metrics.danmaku_count || 0));
  const favoriteCount = Math.max(0, Number(metrics.favorite_count || 0));
  const commentCount = Math.max(0, Number(metrics.comment_count || 0));
  const rawResultCount = Math.max(0, Number(metrics.bilibili_search_raw_result_count || 0));
  const interactionTotal = danmakuCount + favoriteCount + commentCount;
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${metrics.tags || ""} ${keyword || ""}`.toLowerCase();
  const crisisTerms = bilibiliTermMatches(text, BILIBILI_RISK_TERMS);
  const evidenceTerms = bilibiliTermMatches(text, BILIBILI_EVIDENCE_TERMS);
  const responseTerms = bilibiliTermMatches(text, BILIBILI_RESPONSE_TERMS);
  const propagationTerms = bilibiliTermMatches(text, BILIBILI_PROPAGATION_TERMS);
  const danmakuPerThousandPlays = perThousand(danmakuCount, playCount);
  const commentPerThousandPlays = perThousand(commentCount, playCount);
  const favoritePerThousandPlays = perThousand(favoriteCount, playCount);
  const interactionPerThousandPlays = perThousand(interactionTotal, playCount);
  const danmakuPressure = danmakuCount >= 50 || danmakuPerThousandPlays >= 20;
  const commentPressure = commentCount >= 20 || commentPerThousandPlays >= 3;
  const favoritePressure = favoriteCount >= 100 || favoritePerThousandPlays >= 8;
  const denseInteraction = interactionPerThousandPlays >= 35 || interactionTotal >= 500;
  const uploaderSignal = Boolean(cleanText(item.author || "", 160));
  const videoIdSignal = Boolean(cleanText(item.bvid || metrics.bvid || "", 120));
  const reasons = [];
  if (videoIdSignal) reasons.push("bvid-present");
  if (uploaderSignal) reasons.push("uploader-present");
  if (playCount >= 100000) reasons.push("high-play-count");
  else if (playCount >= 10000) reasons.push("elevated-play-count");
  if (danmakuCount >= 500) reasons.push("high-danmaku-volume");
  else if (danmakuCount >= 50) reasons.push("danmaku-discussion");
  if (commentCount >= 100) reasons.push("high-comment-volume");
  else if (commentCount > 0) reasons.push("comment-evidence");
  if (favoriteCount >= 1000) reasons.push("high-favorite-volume");
  else if (favoriteCount > 0) reasons.push("favorite-evidence");
  if (crisisTerms.length) reasons.push("video-crisis-language");
  if (evidenceTerms.length) reasons.push("video-evidence-language");
  if (responseTerms.length) reasons.push("official-response-language");
  if (propagationTerms.length) reasons.push("video-propagation-language");
  if (danmakuPressure) reasons.push("danmaku-pressure");
  if (commentPressure) reasons.push("comment-pressure");
  if (favoritePressure) reasons.push("favorite-pressure");
  if (denseInteraction) reasons.push("high-interaction-density");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  const semanticSignalCount = [
    crisisTerms.length,
    evidenceTerms.length,
    responseTerms.length,
    propagationTerms.length,
    danmakuPressure || commentPressure || favoritePressure || denseInteraction || rawResultCount > 1,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5
    && crisisTerms.length > 0
    && evidenceTerms.length > 0
    && responseTerms.length > 0
    && propagationTerms.length > 0
    && (danmakuPressure || commentPressure || favoritePressure || denseInteraction || rawResultCount > 1);
  if (completeNarrative) reasons.push("bilibili-complete-video-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (videoIdSignal ? 4 : 0)
    + (uploaderSignal ? 4 : 0)
    + (playCount >= 100000 ? 24 : playCount >= 10000 ? 14 : playCount >= 1000 ? 6 : 0)
    + (danmakuCount >= 500 ? 18 : danmakuCount >= 50 ? 10 : danmakuCount > 0 ? 4 : 0)
    + (commentCount >= 100 ? 18 : commentCount > 0 ? 8 : 0)
    + (favoriteCount >= 1000 ? 12 : favoriteCount > 0 ? 5 : 0)
    + (crisisTerms.length ? 18 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (responseTerms.length ? 10 : 0)
    + (propagationTerms.length ? 10 : 0)
    + (danmakuPressure ? 8 : 0)
    + (commentPressure ? 8 : 0)
    + (favoritePressure ? 6 : 0)
    + (denseInteraction ? 8 : 0)
    + (rawResultCount > 1 ? 8 : 0)
  ));

  return {
    bilibili_video_id_signal: videoIdSignal ? 1 : 0,
    bilibili_video_uploader_signal: uploaderSignal ? 1 : 0,
    bilibili_video_play_count_signal: playCount >= 1000 ? 1 : 0,
    bilibili_video_danmaku_signal: danmakuCount > 0 ? 1 : 0,
    bilibili_video_comment_signal: commentCount > 0 ? 1 : 0,
    bilibili_video_favorite_signal: favoriteCount > 0 ? 1 : 0,
    bilibili_video_interaction_total: interactionTotal,
    bilibili_video_interaction_per_1k_plays: interactionPerThousandPlays,
    bilibili_video_danmaku_per_1k_plays: danmakuPerThousandPlays,
    bilibili_video_comment_per_1k_plays: commentPerThousandPlays,
    bilibili_video_favorite_per_1k_plays: favoritePerThousandPlays,
    bilibili_video_danmaku_pressure_signal: danmakuPressure ? 1 : 0,
    bilibili_video_comment_pressure_signal: commentPressure ? 1 : 0,
    bilibili_video_favorite_pressure_signal: favoritePressure ? 1 : 0,
    bilibili_video_interaction_density_signal: denseInteraction ? 1 : 0,
    bilibili_video_crisis_language_signal: crisisTerms.length ? 1 : 0,
    bilibili_video_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    bilibili_video_response_language_signal: responseTerms.length ? 1 : 0,
    bilibili_video_propagation_language_signal: propagationTerms.length ? 1 : 0,
    bilibili_video_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    bilibili_video_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    bilibili_video_response_terms: [...new Set(responseTerms)].slice(0, 12),
    bilibili_video_propagation_terms: [...new Set(propagationTerms)].slice(0, 12),
    bilibili_video_semantic_signal_count: semanticSignalCount,
    bilibili_video_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    bilibili_video_spread_score: score,
    bilibili_video_spread_bucket: bilibiliVideoSpreadBucket(score),
    bilibili_video_spread_signal_count: [...new Set(reasons)].length,
    bilibili_video_spread_reasons: [...new Set(reasons)],
  };
}

function normalizePublishedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1000000000) return new Date(numeric * 1000).toISOString();
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function textMatchesKeyword(item, keyword) {
  if (!bilibiliKeywordNeedles(keyword).length) return true;
  return bilibiliValueMatchesKeyword(`${item.title || ""} ${item.content || ""} ${item.author || ""}`, keyword);
}

function extractMetaContent(html = "", names = []) {
  const text = String(html || "");
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const match = pattern.exec(text);
    if (match?.[1]) return cleanText(match[1], 1200);
    const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
    const reverseMatch = reversePattern.exec(text);
    if (reverseMatch?.[1]) return cleanText(reverseMatch[1], 1200);
  }
  return "";
}

function extractBilibiliInitialState(html = "") {
  const match = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*\(function|\b__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i.exec(String(html || ""));
  const raw = match?.[1] || match?.[2] || "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseBilibiliDirectVideoPage(html = "", direct = {}, keyword = "") {
  const state = extractBilibiliInitialState(html) || {};
  const videoData = state.videoData || state.videoInfo || {};
  const stat = videoData.stat || state?.reduxAsyncConnect?.videoData?.stat || {};
  const owner = videoData.owner || state?.upData || {};
  const bvid = cleanText(
    direct.bvid
      || videoData.bvid
      || state.bvid
      || extractBilibiliBvidFromUrl(direct.url || direct.originalUrl || ""),
    120,
  );
  const canonicalUrl = normalizeBilibiliDedupeUrl(direct.url || direct.originalUrl || "", bvid);
  const title = cleanText(
    videoData.title
      || extractMetaContent(html, ["og:title", "twitter:title"])
      || cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""))?.[1] || "", 240).replace(/_哔哩哔哩.*$/i, ""),
    240,
  );
  const description = cleanText(
    videoData.desc
      || extractMetaContent(html, ["description", "og:description", "twitter:description"])
      || html,
    1600,
  );
  const author = cleanText(owner.name || extractMetaContent(html, ["author"]), 160) || "Bilibili";
  const publishedAt = normalizePublishedAt(videoData.pubdate || videoData.ctime || extractMetaContent(html, ["article:published_time"]));
  const item = {
    title: title || `Bilibili 视频 ${bvid || canonicalUrl}`,
    url: canonicalUrl,
    content: description || `${keyword || ""} Bilibili 直达视频 ${bvid || canonicalUrl}`,
    author,
    publishedAt,
    bvid,
    metrics: {
      bvid,
      aid: cleanText(videoData.aid || stat.aid || "", 120),
      mid: cleanText(owner.mid || "", 120),
      duration: cleanText(videoData.duration || "", 80),
      tags: Array.isArray(videoData.tags) ? cleanText(videoData.tags.map(tag => tag?.tag_name || tag?.name || tag).join(" "), 400) : "",
      play_count: parseMetricCount(stat.view || stat.play),
      danmaku_count: parseMetricCount(stat.danmaku),
      favorite_count: parseMetricCount(stat.favorite),
      comment_count: parseMetricCount(stat.reply),
      coin_count: parseMetricCount(stat.coin),
      share_count: parseMetricCount(stat.share),
      like_count: parseMetricCount(stat.like),
      source_kind: "bilibili_direct_url",
      collection_mode: "bilibili_direct_url",
      deep_collector: "bilibili-direct-url",
      direct_url: canonicalUrl,
      bilibili_direct_url: canonicalUrl,
      bilibili_original_direct_url: direct.originalUrl || direct.url || canonicalUrl,
      bilibili_direct_url_signal: 1,
      disableContentFingerprintDedupe: true,
      source_url: canonicalUrl,
    },
    visualAssets: [],
  };
  item.metrics = {
    ...(item.metrics || {}),
    ...bilibiliVideoSpreadSignals(item, keyword),
  };
  return item.url && item.title ? item : null;
}

export function parseBilibiliSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_RESULTS, since = "" } = {}) {
  const rawItems = Array.isArray(payload?.data?.result)
    ? payload.data.result
    : Array.isArray(payload?.result)
      ? payload.result
      : [];
  const out = [];
  const seen = new Set();
  for (const raw of rawItems) {
    const bvid = cleanText(raw.bvid || raw.id || "", 120);
    const url = normalizeBilibiliDedupeUrl(raw.arcurl || raw.url || raw.link, bvid);
    const key = bvid || url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const title = cleanText(raw.title || raw.name || "", 240);
    const content = cleanText(raw.description || raw.desc || raw.tag || raw.tags || "", 1200);
    const author = cleanText(raw.author || raw.uname || raw.owner?.name || "Bilibili", 160);
    const publishedAt = normalizePublishedAt(raw.pubdate || raw.created_at || raw.created || raw.senddate || raw.pubtime);
    if (!title || !url) continue;
    const item = {
      title,
      url,
      content,
      author,
      publishedAt,
      bvid,
      metrics: {
        bvid,
        aid: cleanText(raw.aid || raw.id || "", 120),
        mid: cleanText(raw.mid || raw.owner?.mid || "", 120),
        duration: cleanText(raw.duration || "", 80),
        tags: cleanText(raw.tag || raw.tags || "", 400),
        play_count: parseMetricCount(raw.play || raw.play_count || raw.view || raw.stat?.view),
        danmaku_count: parseMetricCount(raw.video_review || raw.danmaku || raw.stat?.danmaku),
        favorite_count: parseMetricCount(raw.favorites || raw.favorite || raw.stat?.favorite),
        comment_count: parseMetricCount(raw.review || raw.reply || raw.stat?.reply),
        collection_mode: "public_web_search",
        source_url: "https://api.bilibili.com/x/web-interface/search/type",
      },
      visualAssets: raw.pic ? [{
        url: normalizeBilibiliUrl(raw.pic),
        type: "thumbnail",
        source: "bilibili_search",
        title,
      }] : [],
    };
    item.metrics = {
      ...(item.metrics || {}),
      ...bilibiliVideoSpreadSignals(item, keyword),
    };
    if (!textMatchesKeyword(item, keyword)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push(item);
    if (out.length >= Math.max(1, Math.min(50, Number(limit) || DEFAULT_MAX_RESULTS))) break;
  }
  return out;
}

function insertBilibiliVideo(item, { keyword, rawJson = null, rawHtml = "", domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  const dedupeKey = bilibiliSearchDedupeKey(item);
  if (!dedupeKey) return 0;
  if (seenItemUrls?.has(dedupeKey)) return 0;
  seenItemUrls?.add(dedupeKey);
  const canonicalDedupeUrl = normalizeBilibiliDedupeUrl(item.url, item.bvid || item.metrics?.bvid || "");
  const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
  const result = insertSentimentItem({
    platform: "bilibili",
    url: item.url,
    title: item.title,
    content: item.content,
    author: item.author,
    sentiment,
    risk_level: assessRiskLevel({ title: item.title, content: item.content, sentiment }),
    keyword,
    keywords: [keyword],
    published_at: item.publishedAt,
    raw_html: rawHtml ? String(rawHtml).slice(0, 20000) : rawJson ? JSON.stringify(rawJson).slice(0, 20000) : "",
    ai_summary: item.content,
    evidence: {
      evidence_type: item.metrics?.collection_mode === "bilibili_direct_url" ? "bilibili_direct_video" : "bilibili_video_search_result",
      metrics: {
        ...(item.metrics || {}),
        ...bilibiliKeywordDiagnostics(item, keyword),
        bilibili_canonical_dedupe_url: canonicalDedupeUrl,
        bilibili_search_scan_dedupe_key: dedupeKey,
      },
    },
    visual_assets: item.visualAssets,
    source_type: "scraper",
    domainControls,
    contentControls,
  });
  return result.inserted ? 1 : 0;
}

export async function scrapeBilibiliSearch(keywords, { proxyUrl = "", budget = {}, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeBilibiliDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
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
            "Referer": "https://www.bilibili.com/",
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res), url: direct.url });
          continue;
        }
        const html = await res.text();
        const item = parseBilibiliDirectVideoPage(html, direct, keyword);
        if (!item || !isAfterSince(item.publishedAt, since)) continue;
        const count = insertBilibiliVideo(item, { keyword, rawHtml: html, domainControls, contentControls, seenItemUrls });
        inserted += count;
        keywordInserted += count;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, message, url: direct.url });
        console.warn(`[Sentiment/Bilibili] 直达视频抓取失敗 url=${direct.url}: ${message}`);
      }
    }
    for (let page = 1; page <= maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      try {
        const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&order=pubdate`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Referer": `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const payload = await res.json();
        const rawResultCount = Array.isArray(payload?.data?.result)
          ? payload.data.result.length
          : Array.isArray(payload?.result)
            ? payload.result.length
            : 0;
	        for (const item of parseBilibiliSearchResults(payload, keyword, { limit: remaining, since }).map(result => ({
	          ...result,
	          metrics: {
	            ...(result.metrics || {}),
	            bilibili_search_page: page,
	            bilibili_search_raw_result_count: rawResultCount,
	          },
	        })).map(result => ({
	          ...result,
	          metrics: {
	            ...(result.metrics || {}),
	            ...bilibiliVideoSpreadSignals(result, keyword),
	          },
	        }))) {
          const count = insertBilibiliVideo(item, { keyword, rawJson: payload, domainControls, contentControls, seenItemUrls });
          inserted += count;
          keywordInserted += count;
        }
        if (!rawResultCount) break;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, message });
        console.warn(`[Sentiment/Bilibili] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  bilibiliSearchDedupeKey,
  cleanText,
  extractBilibiliBvidFromUrl,
  normalizeBilibiliDirectUrls,
  normalizeBilibiliDedupeUrl,
  normalizeBudget,
  normalizeBilibiliUrl,
  parseMetricCount,
  parseBilibiliDirectVideoPage,
  parseBilibiliSearchResults,
  normalizeBilibiliKeywordText,
	  bilibiliTermMatches,
	  bilibiliValueMatchesKeyword,
	  bilibiliKeywordMatchSource,
	  bilibiliKeywordDiagnostics,
	  bilibiliVideoSpreadBucket,
	  bilibiliVideoSpreadSignals,
	};
