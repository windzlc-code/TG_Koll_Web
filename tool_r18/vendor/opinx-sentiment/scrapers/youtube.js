import { isAfterSince, isRecentDate, isTaiwanRelatedText } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_YOUTUBE_COMMENTS = 20;
const MAX_RELATED_VIDEOS = 8;
const YOUTUBE_RISK_TERMS = [
  "投訴", "投诉", "客訴", "退款", "爭議", "争议", "道歉", "抵制", "詐騙", "诈骗",
  "complaint", "refund", "dispute", "scam", "fraud", "boycott", "apology", "crisis",
];
const YOUTUBE_EVIDENCE_TERMS = [
  "screenshot", "screen recording", "evidence", "proof", "receipt", "chat log", "timeline",
  "documentation", "documents", "invoice", "recording",
  "截圖", "截图", "錄屏", "录屏", "证据", "證據", "凭证", "憑證", "聊天记录", "聊天紀錄",
  "時間線", "时间线", "整理", "复盘", "復盤", "訂單", "订单", "發票", "发票",
];
const YOUTUBE_RESPONSE_TERMS = [
  "official response", "official statement", "public response", "customer support response",
  "apology", "clarification", "follow-up", "response video",
  "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回應", "客服回应",
  "道歉", "澄清", "後續", "后续", "回應影片", "回应影片",
];
const YOUTUBE_PROPAGATION_TERMS = [
  "viral", "spreading", "shared", "repost", "reposted", "reaction", "response video", "follow-up",
  "thread", "discussion", "comments", "debate", "picked up", "amplified",
  "擴散", "扩散", "發酵", "发酵", "轉傳", "转传", "轉載", "转载", "熱議", "热议",
  "跟進", "跟进", "後續", "后续", "討論", "讨论", "留言", "評論", "评论", "回應影片", "回应影片",
];

function decodeHtml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value, max = 1200) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function tagValue(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1], 1200) : "";
}

function attrValue(block, tag, attr) {
  const match = String(block || "").match(new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return match ? decodeHtml(match[1]).trim() : "";
}

function normalizeVideoUrl(block) {
  const direct = tagValue(block, "link");
  if (direct) return direct;
  const href = attrValue(block, "link", "href");
  if (href) return href;
  const videoId = tagValue(block, "yt:videoId");
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : "";
}

function extractVideoIdFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (/youtu\.be$/i.test(parsed.hostname)) return parsed.pathname.split("/").filter(Boolean)[0] || "";
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live"].includes(segments[0])) return segments[1] || "";
    return parsed.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function normalizeYouTubeDedupeUrl(value = "") {
  const videoId = extractVideoIdFromUrl(value);
  if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    for (const key of ["feature", "si", "pp", "ab_channel", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function youtubeVideoDedupeKey(item = {}) {
  const videoId = item?.videoId || item?.evidence?.metrics?.video_id || extractVideoIdFromUrl(item?.url || "");
  if (videoId) return `youtube:${videoId}`;
  const url = normalizeYouTubeDedupeUrl(item?.url || "");
  return url ? `youtube:${url}` : "";
}

function channelIdFromText(value = "") {
  const text = String(value || "");
  const direct = /(?:channel_id=|channel\/)(UC[A-Za-z0-9_-]{8,})/i.exec(text);
  if (direct?.[1]) return direct[1];
  const channelId = /\b(UC[A-Za-z0-9_-]{8,})\b/.exec(text);
  return channelId?.[1] || "";
}

function extractChannelId(block) {
  return tagValue(block, "yt:channelId")
    || channelIdFromText(tagValue(block, "uri"))
    || channelIdFromText(attrValue(block, "link", "href"));
}

function normalizePublishedAt(value) {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function extractBalancedJson(source = "", marker = "") {
  const text = String(source || "");
  const markerIndex = marker ? text.indexOf(marker) : 0;
  const startSearch = markerIndex >= 0 ? markerIndex + marker.length : 0;
  const start = text.indexOf("{", startSearch);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function textFromRuns(value = {}) {
  if (typeof value?.simpleText === "string") return stripTags(value.simpleText, 1200);
  if (Array.isArray(value?.runs)) {
    return stripTags(value.runs.map(run => run.text || "").join(""), 1200);
  }
  return "";
}

function youtubeTermMatches(value = "", terms = []) {
  const text = stripTags(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function collectYouTubeCommentRenderers(node, out = []) {
  if (!node || typeof node !== "object" || out.length >= MAX_YOUTUBE_COMMENTS) return out;
  if (node.commentRenderer) out.push(node.commentRenderer);
  for (const value of Object.values(node)) {
    if (out.length >= MAX_YOUTUBE_COMMENTS) break;
    if (Array.isArray(value)) {
      for (const item of value) {
        collectYouTubeCommentRenderers(item, out);
        if (out.length >= MAX_YOUTUBE_COMMENTS) break;
      }
    } else if (value && typeof value === "object") {
      collectYouTubeCommentRenderers(value, out);
    }
  }
  return out;
}

function collectYouTubeVideoRenderers(node, out = []) {
  if (!node || typeof node !== "object" || out.length >= 80) return out;
  const renderer = node.compactVideoRenderer || node.videoRenderer || node.gridVideoRenderer || node.reelItemRenderer;
  if (renderer) out.push(renderer);
  for (const value of Object.values(node)) {
    if (out.length >= 80) break;
    if (Array.isArray(value)) {
      for (const item of value) {
        collectYouTubeVideoRenderers(item, out);
        if (out.length >= 80) break;
      }
    } else if (value && typeof value === "object") {
      collectYouTubeVideoRenderers(value, out);
    }
  }
  return out;
}

export function parseYouTubeWatchComments(html, limit = MAX_YOUTUBE_COMMENTS) {
  const initialData = extractBalancedJson(html, "ytInitialData") || extractBalancedJson(html, "var ytInitialData");
  const renderers = collectYouTubeCommentRenderers(initialData, []).slice(0, Math.max(1, Math.min(MAX_YOUTUBE_COMMENTS, Number(limit) || MAX_YOUTUBE_COMMENTS)));
  const seen = new Set();
  return renderers.map(renderer => {
    const content = textFromRuns(renderer.contentText);
    const externalId = stripTags(renderer.commentId || renderer.commentIdToken || "", 160) || String(content).slice(0, 80);
    if (!content || seen.has(externalId)) return null;
    seen.add(externalId);
    return {
      external_id: externalId,
      author: textFromRuns(renderer.authorText) || "YouTube",
      content,
      published_at: normalizePublishedAt(textFromRuns(renderer.publishedTimeText) || new Date().toISOString()),
      metrics: {
        like_count: Number(String(renderer.voteCount?.simpleText || renderer.voteCount?.accessibility?.accessibilityData?.label || "0").replace(/[^\d]/g, "")) || 0,
        source: "youtube_watch_page",
      },
    };
  }).filter(Boolean);
}

export function parseYouTubeRelatedVideos(html, keyword = "", { maxItems = MAX_RELATED_VIDEOS, since = "", sourceUrl = "" } = {}) {
  const initialData = extractBalancedJson(html, "ytInitialData") || extractBalancedJson(html, "var ytInitialData");
  const renderers = collectYouTubeVideoRenderers(initialData, []);
  const seen = new Set();
  const out = [];
  for (const renderer of renderers) {
    const videoId = stripTags(renderer.videoId || renderer.videoIdText?.simpleText || "", 120);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    if (sourceUrl && url === sourceUrl) continue;
    const title = textFromRuns(renderer.title || renderer.headline);
    const content = textFromRuns(renderer.descriptionSnippet)
      || textFromRuns(renderer.detailedMetadataSnippets?.[0]?.snippetText)
      || textFromRuns(renderer.shortViewCountText)
      || textFromRuns(renderer.lengthText);
    const author = textFromRuns(renderer.longBylineText)
      || textFromRuns(renderer.shortBylineText)
      || textFromRuns(renderer.ownerText)
      || textFromRuns(renderer.channelName)
      || "YouTube";
    const publishedAt = normalizePublishedAt(textFromRuns(renderer.publishedTimeText) || new Date().toISOString());
    const text = `${title} ${content}`;
    if (!title) continue;
    if (keyword && !youtubeValueMatchesKeyword(text, keyword)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    if (!isTaiwanRelatedText(title, content, url, author)) continue;
    out.push({
      title,
      url,
      content,
      author,
      publishedAt,
      evidence: {
        evidence_type: "youtube_related_video",
        metrics: {
          source: "youtube_watch_related",
          related_to: sourceUrl,
          video_id: videoId,
          view_count_text: textFromRuns(renderer.shortViewCountText),
          length_text: textFromRuns(renderer.lengthText),
        },
      },
    });
    if (out.length >= Math.max(1, Math.min(MAX_RELATED_VIDEOS, Number(maxItems) || MAX_RELATED_VIDEOS))) break;
  }
  return out;
}

function parseYouTubeWatchContext(html, item, { keyword = "", maxComments = MAX_YOUTUBE_COMMENTS, maxRelated = MAX_RELATED_VIDEOS, since = "" } = {}) {
  return {
    comments: maxComments > 0 ? parseYouTubeWatchComments(html, maxComments) : [],
    relatedVideos: maxRelated > 0 ? parseYouTubeRelatedVideos(html, keyword, {
      maxItems: maxRelated,
      since,
      sourceUrl: item?.url || "",
    }) : [],
  };
}

async function fetchYouTubeWatchContext(item, { proxyUrl = "", keyword = "", maxComments = MAX_YOUTUBE_COMMENTS, maxRelated = MAX_RELATED_VIDEOS, since = "" } = {}) {
  if (!item?.url || (maxComments <= 0 && maxRelated <= 0)) return { comments: [], relatedVideos: [] };
  try {
    const res = await fetchPublicSource(item.url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return { comments: [], relatedVideos: [] };
    return parseYouTubeWatchContext(await res.text(), item, { keyword, maxComments, maxRelated, since });
  } catch {
    return { comments: [], relatedVideos: [] };
  }
}

async function fetchYouTubeWatchComments(item, { proxyUrl = "", limit = MAX_YOUTUBE_COMMENTS } = {}) {
  return (await fetchYouTubeWatchContext(item, { proxyUrl, maxComments: limit, maxRelated: 0 })).comments;
}

function budgetItemsPerKeyword(budget = {}) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_RESULTS));
  return Math.max(1, Math.min(50, Number.isFinite(value) ? value : DEFAULT_MAX_RESULTS));
}

function normalizeDeepBudget(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") {
    return { maxPagesPerKeyword: 1, maxCommentsPerItem: MAX_YOUTUBE_COMMENTS };
  }
  const pages = Math.round(Number(deepBudget.maxPagesPerKeyword ?? deepBudget.max_pages_per_keyword ?? 1));
  const comments = Math.round(Number(deepBudget.maxCommentsPerItem ?? deepBudget.max_comments_per_item ?? deepBudget.maxComments ?? deepBudget.max_comments ?? MAX_YOUTUBE_COMMENTS));
  return {
    maxPagesPerKeyword: Math.max(0, Math.min(5, Number.isFinite(pages) ? pages : 1)),
    maxCommentsPerItem: Math.max(0, Math.min(100, Number.isFinite(comments) ? comments : MAX_YOUTUBE_COMMENTS)),
  };
}

function normalizeYouTubeKeywordText(value = "") {
  return stripTags(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function youtubeKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeYouTubeKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function youtubeValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeYouTubeKeywordText(value);
  return youtubeKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeYouTubeKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

export function parseYouTubeFeedItems(xml, keyword = "", { since = "", maxItems = DEFAULT_MAX_RESULTS } = {}) {
  const source = String(xml || "");
  const blocks = [...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)].map(match => match[0]);
  const items = [];
  for (const block of blocks) {
    const title = tagValue(block, "title");
    const url = normalizeVideoUrl(block);
    const content = tagValue(block, "media:description") || tagValue(block, "summary") || tagValue(block, "content");
    const author = tagValue(block, "name") || tagValue(block, "author");
    const channelId = extractChannelId(block);
    const videoId = tagValue(block, "yt:videoId") || extractVideoIdFromUrl(url);
    const publishedAt = normalizePublishedAt(tagValue(block, "published") || tagValue(block, "updated"));
    const text = `${title} ${content}`;
    if (!title || !url) continue;
    if (keyword && !youtubeValueMatchesKeyword(text, keyword)) continue;
    if (!isRecentDate(publishedAt)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    if (!isTaiwanRelatedText(title, content, url, author)) continue;
    items.push({ title, url, content, author, channelId, videoId, publishedAt });
    if (items.length >= maxItems) break;
  }
  return items;
}

export function countYouTubeFeedRawEntries(xml) {
  return [...String(xml || "").matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)].length;
}

function youtubeKeywordMatchSource(item = {}, keyword = "") {
  if (!youtubeKeywordNeedles(keyword).length) return "";
  if (youtubeValueMatchesKeyword(item.title, keyword)) return "title";
  if (youtubeValueMatchesKeyword(item.content, keyword)) return "description";
  return "feed_search";
}

function youtubeKeywordDiagnostics(item = {}, keyword = "") {
  return {
    youtube_matched_keyword: String(keyword || "").trim().slice(0, 160),
    youtube_keyword_match_source: youtubeKeywordMatchSource(item, keyword),
  };
}

function parseYouTubeMetricCount(value = "") {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const text = stripTags(value, 120).toLowerCase();
  if (!text) return 0;
  const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  if (/億|亿/.test(text)) return Math.round(number * 100000000);
  if (/萬|万/.test(text)) return Math.round(number * 10000);
  if (/[0-9]\s*m\b|million/.test(text)) return Math.round(number * 1000000);
  if (/[0-9]\s*k\b|thousand/.test(text)) return Math.round(number * 1000);
  return Math.round(number);
}

function youtubeVideoSpreadBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function youtubeVideoSpreadSignals(item = {}, {
  comments = [],
  relatedVideos = [],
  channelVideos = [],
  rawFeedEntryCount = 0,
  keyword = "",
} = {}) {
  const metrics = item.evidence?.metrics || item.metrics || {};
  const commentRows = Array.isArray(comments) ? comments : [];
  const relatedRows = Array.isArray(relatedVideos) ? relatedVideos : [];
  const channelRows = Array.isArray(channelVideos) ? channelVideos : [];
  const commentCount = Math.max(commentRows.length, Number(metrics.comment_count || 0));
  const relatedCount = Math.max(relatedRows.length, Number(metrics.related_video_count || 0));
  const channelCount = Math.max(channelRows.length, Number(metrics.channel_video_count || 0));
  const commentLikeTotal = commentRows.reduce((sum, comment) => sum + Math.max(0, Number(comment?.metrics?.like_count || 0)), 0);
  const highLikeCommentCount = commentRows.filter(comment => Number(comment?.metrics?.like_count || 0) >= 5).length;
  const viewCount = Math.max(
    parseYouTubeMetricCount(metrics.view_count_text),
    parseYouTubeMetricCount(metrics.short_view_count_text),
    parseYouTubeMetricCount(item.viewCountText),
  );
  const relationSource = String(metrics.source || "");
  const text = `${item.title || ""} ${item.content || ""} ${keyword || ""}`.toLowerCase();
  const commentText = commentRows.map(comment => `${comment?.author || ""} ${comment?.content || ""}`).join(" ");
  const relatedText = relatedRows.map(row => `${row?.title || ""} ${row?.content || ""}`).join(" ");
  const channelText = channelRows.map(row => `${row?.title || ""} ${row?.content || ""}`).join(" ");
  const crisisTerms = youtubeTermMatches(text, YOUTUBE_RISK_TERMS);
  const evidenceTerms = youtubeTermMatches(text, YOUTUBE_EVIDENCE_TERMS);
  const responseTerms = youtubeTermMatches(text, YOUTUBE_RESPONSE_TERMS);
  const propagationTerms = youtubeTermMatches(text, YOUTUBE_PROPAGATION_TERMS);
  const commentRiskTerms = youtubeTermMatches(commentText, YOUTUBE_RISK_TERMS);
  const commentEvidenceTerms = youtubeTermMatches(commentText, YOUTUBE_EVIDENCE_TERMS);
  const commentResponseTerms = youtubeTermMatches(commentText, YOUTUBE_RESPONSE_TERMS);
  const commentPropagationTerms = youtubeTermMatches(commentText, YOUTUBE_PROPAGATION_TERMS);
  const relatedRiskTerms = youtubeTermMatches(`${relatedText} ${channelText}`, YOUTUBE_RISK_TERMS);
  const relatedPropagationTerms = youtubeTermMatches(`${relatedText} ${channelText}`, YOUTUBE_PROPAGATION_TERMS);
  const relatedKeywordMatchCount = [...relatedRows, ...channelRows]
    .filter(row => keyword && youtubeValueMatchesKeyword(`${row?.title || ""} ${row?.content || ""}`, keyword))
    .length;
  const hasVideoId = Boolean(item.videoId || metrics.video_id || extractVideoIdFromUrl(item.url || ""));
  const hasChannelId = Boolean(item.channelId || metrics.channel_id);
  const reasons = [];
  if (hasVideoId) reasons.push("video-id-present");
  if (hasChannelId) reasons.push("channel-id-present");
  if (commentCount > 0) reasons.push("watch-comment-evidence");
  if (commentLikeTotal >= 5) reasons.push("liked-comment-evidence");
  if (relatedCount > 0) reasons.push("watch-related-video-followup");
  if (channelCount > 0) reasons.push("same-channel-followup");
  if (relationSource === "youtube_watch_related") reasons.push("related-video-amplifier");
  if (relationSource === "youtube_channel_feed") reasons.push("channel-video-amplifier");
  if (viewCount >= 10000) reasons.push("high-view-count");
  else if (viewCount >= 1000) reasons.push("elevated-view-count");
  if (crisisTerms.length) reasons.push("video-crisis-language");
  if (evidenceTerms.length) reasons.push("video-evidence-language");
  if (responseTerms.length) reasons.push("official-response-language");
  if (propagationTerms.length) reasons.push("video-propagation-language");
  if (commentRiskTerms.length) reasons.push("comment-risk-language");
  if (commentEvidenceTerms.length) reasons.push("comment-evidence-language");
  if (commentResponseTerms.length) reasons.push("comment-official-response-language");
  if (commentPropagationTerms.length) reasons.push("comment-propagation-language");
  if (relatedKeywordMatchCount > 0) reasons.push("followup-keyword-match");
  if (relatedRiskTerms.length) reasons.push("followup-risk-language");
  if (relatedPropagationTerms.length) reasons.push("followup-propagation-language");
  if (Number(rawFeedEntryCount || metrics.youtube_search_raw_feed_entry_count || metrics.youtube_channel_raw_feed_entry_count || 0) > 1) reasons.push("multi-result-feed-context");
  const semanticSignalCount = [
    crisisTerms.length || commentRiskTerms.length || relatedRiskTerms.length,
    evidenceTerms.length || commentEvidenceTerms.length,
    responseTerms.length || commentResponseTerms.length,
    propagationTerms.length || commentPropagationTerms.length || relatedPropagationTerms.length,
    commentCount > 0 || relatedCount > 0 || channelCount > 0 || relationSource === "youtube_watch_related" || relationSource === "youtube_channel_feed",
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5
    && (crisisTerms.length > 0 || commentRiskTerms.length > 0 || relatedRiskTerms.length > 0)
    && (evidenceTerms.length > 0 || commentEvidenceTerms.length > 0)
    && (responseTerms.length > 0 || commentResponseTerms.length > 0)
    && (propagationTerms.length > 0 || commentPropagationTerms.length > 0 || relatedPropagationTerms.length > 0)
    && (commentCount > 0 || relatedCount > 0 || channelCount > 0 || relationSource === "youtube_watch_related" || relationSource === "youtube_channel_feed");
  if (completeNarrative) reasons.push("youtube-complete-video-crisis-narrative");

  const score = Math.min(100, Math.max(0,
    (hasVideoId ? 4 : 0)
    + (hasChannelId ? 4 : 0)
    + Math.min(18, commentCount * 10)
    + Math.min(12, Math.floor(commentLikeTotal / 2))
    + Math.min(8, highLikeCommentCount * 4)
    + Math.min(18, relatedCount * 12)
    + Math.min(16, channelCount * 12)
    + (relationSource === "youtube_watch_related" ? 14 : 0)
    + (relationSource === "youtube_channel_feed" ? 12 : 0)
    + (viewCount >= 10000 ? 18 : viewCount >= 1000 ? 10 : 0)
    + (crisisTerms.length ? 14 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (responseTerms.length ? 10 : 0)
    + (propagationTerms.length ? 8 : 0)
    + (commentRiskTerms.length ? 10 : 0)
    + (commentEvidenceTerms.length ? 12 : 0)
    + (commentResponseTerms.length ? 10 : 0)
    + (commentPropagationTerms.length ? 10 : 0)
    + Math.min(12, relatedKeywordMatchCount * 6)
    + (relatedRiskTerms.length ? 8 : 0)
    + (relatedPropagationTerms.length ? 8 : 0)
    + (Number(rawFeedEntryCount || metrics.youtube_search_raw_feed_entry_count || metrics.youtube_channel_raw_feed_entry_count || 0) > 1 ? 8 : 0)
  ));

  return {
    youtube_video_id_signal: hasVideoId ? 1 : 0,
    youtube_video_channel_signal: hasChannelId ? 1 : 0,
    youtube_video_comment_count_signal: commentCount > 0 ? 1 : 0,
    youtube_video_comment_like_total: commentLikeTotal,
    youtube_video_high_like_comment_count: highLikeCommentCount,
    youtube_video_related_signal: relatedCount > 0 || relationSource === "youtube_watch_related" ? 1 : 0,
    youtube_video_channel_followup_signal: channelCount > 0 || relationSource === "youtube_channel_feed" ? 1 : 0,
    youtube_video_view_count: viewCount,
    youtube_video_crisis_language_signal: crisisTerms.length ? 1 : 0,
    youtube_video_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    youtube_video_response_language_signal: responseTerms.length ? 1 : 0,
    youtube_video_propagation_language_signal: propagationTerms.length ? 1 : 0,
    youtube_video_comment_risk_language_signal: commentRiskTerms.length ? 1 : 0,
    youtube_video_comment_evidence_language_signal: commentEvidenceTerms.length ? 1 : 0,
    youtube_video_comment_response_language_signal: commentResponseTerms.length ? 1 : 0,
    youtube_video_comment_propagation_language_signal: commentPropagationTerms.length ? 1 : 0,
    youtube_video_followup_keyword_match_count: relatedKeywordMatchCount,
    youtube_video_followup_risk_language_signal: relatedRiskTerms.length ? 1 : 0,
    youtube_video_followup_propagation_language_signal: relatedPropagationTerms.length ? 1 : 0,
    youtube_video_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    youtube_video_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    youtube_video_response_terms: [...new Set(responseTerms)].slice(0, 12),
    youtube_video_propagation_terms: [...new Set(propagationTerms)].slice(0, 12),
    youtube_video_comment_risk_terms: [...new Set(commentRiskTerms)].slice(0, 12),
    youtube_video_comment_evidence_terms: [...new Set(commentEvidenceTerms)].slice(0, 12),
    youtube_video_comment_response_terms: [...new Set(commentResponseTerms)].slice(0, 12),
    youtube_video_comment_propagation_terms: [...new Set(commentPropagationTerms)].slice(0, 12),
    youtube_video_followup_risk_terms: [...new Set(relatedRiskTerms)].slice(0, 12),
    youtube_video_followup_propagation_terms: [...new Set(relatedPropagationTerms)].slice(0, 12),
    youtube_video_semantic_signal_count: semanticSignalCount,
    youtube_video_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    youtube_video_spread_score: score,
    youtube_video_spread_bucket: youtubeVideoSpreadBucket(score),
    youtube_video_spread_signal_count: [...new Set(reasons)].length,
    youtube_video_spread_reasons: [...new Set(reasons)],
  };
}

function parseYouTubeChannelFeedItems(xml, keyword = "", { since = "", maxItems = DEFAULT_MAX_RESULTS, sourceUrl = "" } = {}) {
  return parseYouTubeFeedItems(xml, keyword, { since, maxItems: Math.max(1, Math.min(DEFAULT_MAX_RESULTS, Number(maxItems) || DEFAULT_MAX_RESULTS)) })
    .filter(item => !sourceUrl || item.url !== sourceUrl)
    .map(item => ({
      ...item,
      evidence: {
        evidence_type: "youtube_channel_video",
        metrics: {
          source: "youtube_channel_feed",
          related_to: sourceUrl,
          channel_id: item.channelId || "",
          video_id: item.videoId || extractVideoIdFromUrl(item.url),
        },
      },
    }));
}

async function fetchYouTubeChannelVideos(item, { proxyUrl = "", keyword = "", maxItems = 0, since = "" } = {}) {
  const limit = Math.max(0, Math.min(MAX_RELATED_VIDEOS, Number(maxItems || 0)));
  if (!limit || !item?.channelId) return [];
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(item.channelId)}`;
    const res = await fetchPublicSource(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    const xml = await res.text();
    const rawEntryCount = countYouTubeFeedRawEntries(xml);
    return parseYouTubeChannelFeedItems(xml, keyword, {
      since,
      maxItems: limit,
      sourceUrl: item.url,
    }).map(channelItem => ({
      ...channelItem,
      evidence: {
        ...(channelItem.evidence || {}),
        metrics: {
          ...(channelItem.evidence?.metrics || {}),
          youtube_channel_raw_feed_entry_count: rawEntryCount,
          ...youtubeKeywordDiagnostics(channelItem, keyword),
        },
      },
    }));
  } catch {
    return [];
  }
}

export async function scrapeYouTube(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const maxItems = budgetItemsPerKeyword(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);

  let inserted = 0;
  const failures = [];
  const seenVideoKeys = new Set();
  for (const keyword of normalizedKeywords) {
    try {
      const query = `${keyword} 台灣`;
      const url = `https://www.youtube.com/feeds/videos.xml?search_query=${encodeURIComponent(query)}`;
      const res = await fetchPublicSource(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, message: httpFailure(res) });
        continue;
      }
      const xml = await res.text();
      const rawFeedEntryCount = countYouTubeFeedRawEntries(xml);
      let deepPagesUsed = 0;
      for (const item of parseYouTubeFeedItems(xml, keyword, { since, maxItems })) {
        const dedupeKey = youtubeVideoDedupeKey(item);
        if (!dedupeKey) continue;
        if (seenVideoKeys.has(dedupeKey)) continue;
        seenVideoKeys.add(dedupeKey);
        const canonicalDedupeUrl = normalizeYouTubeDedupeUrl(item.url);
        const remainingItems = Math.max(0, maxItems - inserted - 1);
        const shouldFetchContext = normalizedDeepBudget.maxPagesPerKeyword > deepPagesUsed
          && (normalizedDeepBudget.maxCommentsPerItem > 0 || remainingItems > 0);
        const context = shouldFetchContext
          ? await fetchYouTubeWatchContext(item, {
            proxyUrl,
            keyword,
            maxComments: normalizedDeepBudget.maxCommentsPerItem,
            maxRelated: remainingItems,
            since,
          })
          : { comments: [], relatedVideos: [] };
        const channelVideos = shouldFetchContext && item.channelId
          ? await fetchYouTubeChannelVideos(item, {
            proxyUrl,
            keyword,
            maxItems: Math.max(0, remainingItems - context.relatedVideos.length),
            since,
          })
          : [];
        if (shouldFetchContext) deepPagesUsed += 1;
        const comments = context.comments;
        const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
        const result = insertSentimentItem({
          platform: "youtube",
          url: item.url,
          title: item.title,
          content: item.content,
          author: item.author,
          sentiment,
          risk_level: assessRiskLevel({ title: item.title, content: item.content, sentiment }),
          keyword,
          keywords: [keyword],
          published_at: item.publishedAt,
          raw_xml: xml,
          comments,
          evidence: {
            evidence_type: "youtube_video",
            metrics: {
              comment_count: comments.length,
              related_video_count: context.relatedVideos.length,
              channel_video_count: channelVideos.length,
              deep_collector: comments.length || context.relatedVideos.length || channelVideos.length ? "watch-page-context" : "",
              channel_id: item.channelId || "",
              video_id: item.videoId || extractVideoIdFromUrl(item.url),
              youtube_canonical_dedupe_url: canonicalDedupeUrl,
              youtube_scan_dedupe_key: dedupeKey,
              youtube_search_query: query,
              youtube_search_raw_feed_entry_count: rawFeedEntryCount,
              ...youtubeKeywordDiagnostics(item, keyword),
              ...youtubeVideoSpreadSignals(item, {
                comments,
                relatedVideos: context.relatedVideos,
                channelVideos,
                rawFeedEntryCount,
                keyword,
              }),
            },
          },
          source_type: "scraper",
          domainControls,
          contentControls,
        });
        if (result.inserted) inserted++;
        for (const related of [...context.relatedVideos, ...channelVideos]) {
          if (inserted >= maxItems) break;
          const relatedDedupeKey = youtubeVideoDedupeKey(related);
          if (!relatedDedupeKey) continue;
          if (seenVideoKeys.has(relatedDedupeKey)) continue;
          seenVideoKeys.add(relatedDedupeKey);
          const relatedCanonicalDedupeUrl = normalizeYouTubeDedupeUrl(related.url);
          const relatedSentiment = analyzeSentiment(`${related.title} ${related.content}`);
          const relatedResult = insertSentimentItem({
            platform: "youtube",
            url: related.url,
            title: related.title,
            content: related.content,
            author: related.author,
            sentiment: relatedSentiment,
            risk_level: assessRiskLevel({ title: related.title, content: related.content, sentiment: relatedSentiment }),
            keyword,
            keywords: [keyword],
            published_at: related.publishedAt,
            raw_xml: xml,
            evidence: {
              ...(related.evidence || {}),
              metrics: {
                ...(related.evidence?.metrics || {}),
                ...youtubeKeywordDiagnostics(related, keyword),
                youtube_canonical_dedupe_url: relatedCanonicalDedupeUrl,
                youtube_scan_dedupe_key: relatedDedupeKey,
                ...youtubeVideoSpreadSignals(related, {
                  rawFeedEntryCount,
                  keyword,
                }),
              },
            },
            source_type: "scraper",
            domainControls,
            contentControls,
          });
          if (relatedResult.inserted) inserted++;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[Sentiment/YouTube] 抓取失敗 keyword=${keyword}: ${message}`);
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  extractVideoIdFromUrl,
  normalizeYouTubeDedupeUrl,
  parseYouTubeFeedItems,
  parseYouTubeWatchComments,
  parseYouTubeRelatedVideos,
  parseYouTubeChannelFeedItems,
  parseYouTubeWatchContext,
  countYouTubeFeedRawEntries,
  normalizeYouTubeKeywordText,
  youtubeTermMatches,
  youtubeValueMatchesKeyword,
  youtubeKeywordMatchSource,
  youtubeKeywordDiagnostics,
  parseYouTubeMetricCount,
  youtubeVideoSpreadBucket,
  youtubeVideoSpreadSignals,
  youtubeVideoDedupeKey,
  budgetItemsPerKeyword,
  normalizeDeepBudget,
};
