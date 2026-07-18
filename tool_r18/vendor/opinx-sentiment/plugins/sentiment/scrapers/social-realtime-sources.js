import { mapWithConcurrency } from "./concurrency.js";
import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const DEFAULT_TELEGRAM_CHANNELS = [];
const TELEGRAM_PUBLIC_NETWORK_COLLECTION_ENABLED = false;
const DEFAULT_MASTODON_INSTANCES = [
  "https://mastodon.social",
  "https://mstdn.social",
  "https://mastodon.world",
  "https://mas.to",
  "https://fosstodon.org",
  "https://hachyderm.io",
  "https://infosec.exchange",
  "https://techhub.social",
  "https://newsie.social",
  "https://mozilla.social",
];
const BLUESKY_PUBLIC_APPVIEW = "https://public.api.bsky.app";

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function decodeHtmlAttribute(value = "") {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.min(50, Math.max(1, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.min(5, Math.max(1, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function normalizeDeepBudget(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") return { captureQuotedContext: true };
  return {
    captureQuotedContext: deepBudget.captureQuotedContext ?? deepBudget.capture_quoted_context ?? true ? true : false,
  };
}

function normalizeIsoDate(value) {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function normalizeSocialRealtimeDedupeUrl(rawUrl = "") {
  const cleaned = cleanText(rawUrl, 1200);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeSocialRealtimeDedupeUrl(embedded);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ref",
      "ref_src",
      "source",
      "context",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^mobile\./, "")
      .replace(/^m\./, "");
    if (url.hostname === "telegram.me") url.hostname = "t.me";
    if (url.hostname === "t.me" && url.pathname.startsWith("/s/")) {
      url.pathname = url.pathname.replace(/^\/s\//, "/");
    }
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return cleaned.toLowerCase();
  }
}

function socialRealtimeDedupeKey(item = {}) {
  const uri = cleanText(item?.metrics?.uri || "", 800);
  if (uri && /^at:\/\//i.test(uri)) return uri;
  return normalizeSocialRealtimeDedupeUrl(item?.url || "");
}

function normalizeSiteUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function normalizeInstances(instances = DEFAULT_MASTODON_INSTANCES) {
  const raw = Array.isArray(instances)
    ? instances
    : typeof instances === "string"
      ? instances.split(/[,\n，、;；]+/)
      : DEFAULT_MASTODON_INSTANCES;
  const out = [];
  for (const instance of raw) {
    const normalized = normalizeSiteUrl(instance);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= 20) break;
  }
  return out.length ? out : [...DEFAULT_MASTODON_INSTANCES];
}

function normalizeMastodonDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeSocialRealtimeDedupeUrl(value);
    if (!normalized) continue;
    try {
      const url = new URL(normalized);
      const segments = url.pathname.split("/").filter(Boolean);
      let statusId = "";
      if (segments[0]?.startsWith("@") && segments[1]) {
        statusId = segments[1];
      } else if (segments[0] === "users" && segments[2] === "statuses" && segments[3]) {
        statusId = segments[3];
      }
      if (!/^[A-Za-z0-9_-]+$/.test(statusId)) continue;
      const instanceUrl = `${url.protocol}//${url.host}`;
      const canonicalUrl = normalizeSocialRealtimeDedupeUrl(`${instanceUrl}${url.pathname}`);
      const statusKey = `${instanceUrl}:${statusId}`;
      if (!canonicalUrl || seen.has(statusKey)) continue;
      seen.add(statusKey);
      out.push({
        url: canonicalUrl,
        originalUrl: normalizeSocialRealtimeDedupeUrl(value) || canonicalUrl,
        instanceUrl,
        statusId,
        apiUrl: `${instanceUrl}/api/v1/statuses/${encodeURIComponent(statusId)}`,
      });
      if (out.length >= Math.max(1, Number(limit) || 20)) break;
    } catch {
      continue;
    }
  }
  return out;
}

function normalizeBlueskyDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeSocialRealtimeDedupeUrl(value);
    if (!normalized) continue;
    try {
      const url = new URL(normalized);
      const host = url.hostname.replace(/^www\./i, "").toLowerCase();
      if (host !== "bsky.app") continue;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] !== "profile" || segments[2] !== "post" || !segments[1] || !segments[3]) continue;
      const actor = decodeURIComponent(segments[1]);
      const rkey = decodeURIComponent(segments[3]);
      if (!actor || !rkey) continue;
      const canonicalUrl = `https://bsky.app/profile/${encodeURIComponent(actor)}/post/${encodeURIComponent(rkey)}`;
      if (seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      out.push({
        url: canonicalUrl,
        originalUrl: normalized,
        actor,
        rkey,
      });
      if (out.length >= Math.max(1, Number(limit) || 20)) break;
    } catch {
      continue;
    }
  }
  return out;
}

function normalizeHashtag(keyword) {
  return String(keyword || "")
    .replace(/^#+/g, "")
    .replace(/[^\p{L}\p{N}_]+/gu, "")
    .trim()
    .slice(0, 80);
}

function normalizeTelegramChannels(channels = DEFAULT_TELEGRAM_CHANNELS) {
  const raw = Array.isArray(channels)
    ? channels
    : typeof channels === "string"
      ? channels.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const direct = cleanText(item, 200);
    if (!direct) continue;
    let channel = direct;
    try {
      const parsed = new URL(direct);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== "t.me" && host !== "telegram.me") continue;
      const segments = parsed.pathname.split("/").filter(Boolean);
      channel = (segments[0] || "").toLowerCase() === "s" ? segments[1] || "" : segments[0] || "";
    } catch {
      channel = direct;
    }
    channel = channel
      .replace(/^https?:\/\/(?:www\.)?(?:t|telegram)\.me\//i, "")
      .replace(/^s\//i, "")
      .replace(/^@/, "")
      .replace(/\/.*$/g, "")
      .replace(/[^\w-]/g, "")
      .slice(0, 80);
    const key = channel.toLowerCase();
    if (!/^[A-Za-z0-9_][\w-]{2,}$/.test(channel) || seen.has(key)) continue;
    seen.add(key);
    out.push(channel);
    if (out.length >= 100) break;
  }
  return out;
}

function normalizeTelegramDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeSocialRealtimeDedupeUrl(value);
    if (!normalized) continue;
    try {
      const url = new URL(normalized);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== "t.me") continue;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length < 2) continue;
      if ((segments[0] || "").toLowerCase() === "c") continue;
      const channel = cleanText(segments[0] || "", 120).replace(/^@/, "");
      const messageId = Number(segments[1]);
      if (!/^[A-Za-z0-9_][\w-]{2,}$/.test(channel) || !Number.isFinite(messageId) || messageId <= 0) continue;
      const canonicalUrl = `https://t.me/${channel}/${Math.round(messageId)}`;
      const key = `${channel.toLowerCase()}:${Math.round(messageId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url: canonicalUrl,
        originalUrl: normalized,
        channel,
        messageId: Math.round(messageId),
        publicUrls: [
          `https://t.me/s/${encodeURIComponent(channel)}/${Math.round(messageId)}`,
          `https://t.me/s/${encodeURIComponent(channel)}?before=${Math.round(messageId) + 1}`,
        ],
      });
      if (out.length >= Math.max(1, Number(limit) || 20)) break;
    } catch {
      continue;
    }
  }
  return out;
}

function normalizeTelegramHref(href = "", pageUrl = "", channel = "") {
  const raw = decodeHtmlAttribute(href || "").trim();
  if (!raw || /^javascript:|^mailto:|^tel:/i.test(raw)) return "";
  try {
    const base = pageUrl || (channel ? `https://t.me/s/${channel}` : "https://t.me/");
    const parsed = new URL(raw, base);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    return normalizeSocialRealtimeDedupeUrl(parsed.toString());
  } catch {
    return "";
  }
}

function extractTelegramMessageLinks(block = "", { pageUrl = "", channel = "", postUrl = "" } = {}) {
  const links = [];
  const seen = new Set();
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(String(block || ""))) !== null) {
    const url = normalizeTelegramHref(match[1] || "", pageUrl, channel);
    if (!url || url === postUrl || seen.has(url)) continue;
    seen.add(url);
    const text = cleanText(match[2] || "", 240);
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    links.push({
      url,
      text,
      host,
      is_telegram: host === "t.me" || host === "telegram.me",
    });
    if (links.length >= 20) break;
  }
  return links;
}

function extractTelegramStyleImageUrl(style = "", pageUrl = "", channel = "") {
  const raw = decodeHtmlAttribute((String(style || "").match(/url\((['"]?)(.*?)\1\)/i) || [])[2] || "");
  return normalizeTelegramHref(raw, pageUrl, channel);
}

function extractTelegramMessageMedia(block = "", { pageUrl = "", channel = "" } = {}) {
  const source = String(block || "");
  const assets = [];
  const seen = new Set();
  const pushAsset = (imageUrl, thumbnailUrl, sceneTags = [], metrics = {}) => {
    const normalized = normalizeTelegramHref(imageUrl || thumbnailUrl || "", pageUrl, channel);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    assets.push({
      image_url: normalized,
      thumbnail_url: normalizeTelegramHref(thumbnailUrl || imageUrl || "", pageUrl, channel),
      scene_tags: ["telegram-public-message", ...sceneTags].filter(Boolean),
      metrics: {
        source: "telegram_public_channel",
        ...metrics,
      },
    });
  };

  const imageRegex = /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let imageMatch;
  while ((imageMatch = imageRegex.exec(source)) !== null) {
    pushAsset(imageMatch[1] || "", imageMatch[1] || "", ["inline-image"], { media_kind: "img" });
  }

  const styleRegex = /<[^>]+style=["']([^"']*background-image\s*:\s*url\([^)]+\)[^"']*)["'][^>]*>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(source)) !== null) {
    const imageUrl = extractTelegramStyleImageUrl(styleMatch[1] || "", pageUrl, channel);
    const tag = /tgme_widget_message_video/i.test(styleMatch[0] || "") ? "video-preview" : "photo-preview";
    pushAsset(imageUrl, imageUrl, [tag], { media_kind: tag });
  }

  return assets.slice(0, 10);
}

function extractTelegramForwardedFrom(block = "") {
  const forwarded = (String(block || "").match(/<div\b[^>]*class="[^"]*\btgme_widget_message_forwarded_from\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
  if (!forwarded) return null;
  const href = decodeHtmlAttribute((forwarded.match(/<a\b[^>]*href=["']([^"']+)["']/i) || [])[1] || "");
  return {
    author: cleanText(forwarded, 160),
    url: normalizeTelegramHref(href),
  };
}

function extractTelegramLinkPreview(block = "", { pageUrl = "", channel = "" } = {}) {
  const preview = (String(block || "").match(/<a\b[^>]*class="[^"]*\btgme_widget_message_link_preview\b[^"]*"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) || []);
  if (!preview.length) return null;
  return {
    url: normalizeTelegramHref(preview[1] || "", pageUrl, channel),
    title: cleanText((preview[2] || "").match(/<div\b[^>]*class="[^"]*\blink_preview_title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "", 240),
    description: cleanText((preview[2] || "").match(/<div\b[^>]*class="[^"]*\blink_preview_description\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "", 500),
    siteName: cleanText((preview[2] || "").match(/<div\b[^>]*class="[^"]*\blink_preview_site_name\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "", 160),
  };
}

function telegramMessageIdFromPostId(postId = "", channel = "") {
  const normalizedChannel = cleanText(channel, 120).toLowerCase();
  const parts = cleanText(postId, 180).split("/");
  if (parts.length < 2) return 0;
  const postChannel = parts[0].toLowerCase();
  const id = Number(parts[1]);
  if (normalizedChannel && postChannel !== normalizedChannel) return 0;
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function telegramBeforeCursorFromHtml(html = "", channel = "") {
  const source = String(html || "");
  const candidates = [];
  const beforeRegex = /[?&]before=(\d+)/gi;
  let beforeMatch;
  while ((beforeMatch = beforeRegex.exec(source)) !== null) {
    const value = Number(beforeMatch[1]);
    if (Number.isFinite(value) && value > 0) candidates.push(value);
  }
  const postRegex = /\bdata-post=["']([^"']+)["']/gi;
  let postMatch;
  while ((postMatch = postRegex.exec(source)) !== null) {
    const value = telegramMessageIdFromPostId(decodeHtmlAttribute(postMatch[1] || ""), channel);
    if (value > 0) candidates.push(value);
  }
  if (!candidates.length) return "";
  return String(Math.min(...candidates));
}

function normalizeKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function socialRealtimeKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts].filter(Boolean).map(part => String(part).toLowerCase()))].slice(0, 12);
}

function valueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeKeywordText(value);
  return socialRealtimeKeywordNeedles(keyword).some(needle => {
    const normalizedNeedle = normalizeKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function textMatchesKeyword(item, keyword) {
  return valueMatchesKeyword(`${item.title || ""} ${item.content || ""}`, keyword);
}

function socialRealtimeDirectAnchorKeyword(keyword = "") {
  const parts = cleanText(keyword, 240)
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const blocked = new Set([
    "mastodon",
    "bluesky",
    "fediverse",
    "boost",
    "repost",
    "reply",
    "replies",
    "quote",
    "post",
    "comments",
  ]);
  const anchor = parts.find(part => !/^site:/i.test(part) && !blocked.has(part.toLowerCase())) || parts.find(part => !/^site:/i.test(part)) || cleanText(keyword, 160);
  return cleanText(anchor || keyword, 160);
}

function socialRealtimeMatchEvidence(item = {}, keyword = "") {
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
  ];
  const matchedFields = keyword
    ? fields.filter(([, value]) => valueMatchesKeyword(value || "", keyword)).map(([field]) => field)
    : [];
  let score = 35;
  if (matchedFields.includes("title")) score += 24;
  if (matchedFields.includes("content")) score += 26;
  if (matchedFields.includes("author")) score += 8;
  if (matchedFields.includes("url")) score += 6;
  const engagement = Number(item.metrics?.replies || 0)
    + Number(item.metrics?.reblogs || 0)
    + Number(item.metrics?.favourites || 0)
    + Number(item.metrics?.reposts || 0)
    + Number(item.metrics?.likes || 0)
    + Number(item.metrics?.quotes || 0);
  if (engagement > 0) score += Math.min(12, Math.ceil(engagement / 3));
  return {
    matchedFields,
    score: Math.max(0, Math.min(100, Math.round(score))),
  };
}

function socialRealtimeKeywordMatchSource(item = {}, keyword = "") {
  const evidence = socialRealtimeMatchEvidence(item, keyword);
  return evidence.matchedFields[0] || "search_query";
}

function socialRealtimeSpreadBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function matchedSocialRealtimeTerms(text = "", terms = [], limit = 10) {
  const lower = String(text || "").toLowerCase();
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    if (!raw) continue;
    if (lower.includes(raw.toLowerCase()) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function socialRealtimeAgeMinutes(publishedAt = "", now = Date.now()) {
  const created = new Date(publishedAt || "").getTime();
  const current = new Date(now || Date.now()).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.round((current - created) / 60000));
}

function socialRealtimeSpreadSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = [
    item.title,
    item.content,
    item.author,
    metrics.card_title,
    metrics.card_description,
    metrics.external_embed_title,
    metrics.external_embed_description,
    metrics.link_preview_title,
    metrics.link_preview_site_name,
    metrics.forwarded_from_author,
    ...(Array.isArray(metrics.outbound_link_hosts) ? metrics.outbound_link_hosts : []),
    ...(Array.isArray(item.comments) ? item.comments.map(comment => `${comment?.author || ""} ${comment?.content || ""}`) : []),
    ...(Array.isArray(item.visualAssets) ? item.visualAssets.map(asset => `${asset?.ocr_text || ""} ${(asset?.scene_tags || []).join(" ")}`) : []),
  ].filter(Boolean).join(" ");
  const riskTerms = matchedSocialRealtimeTerms(text, [
    "complaint", "refund", "dispute", "scam", "fraud", "lawsuit", "investigation", "recall", "outage", "breach", "boycott", "crisis",
    "投訴", "投诉", "退款", "爭議", "争议", "詐騙", "诈骗", "訴訟", "诉讼", "調查", "调查", "召回", "外洩", "泄露", "抵制", "危機", "危机",
  ]);
  const evidenceTerms = matchedSocialRealtimeTerms(text, [
    "screenshot", "receipt", "invoice", "order id", "case number", "ticket", "record", "records", "timeline", "recording", "video", "photo", "leaked", "document", "proof", "evidence",
    "截圖", "截图", "收據", "收据", "訂單", "订单", "工單", "工单", "紀錄", "记录", "時間線", "时间线", "錄音", "录音", "影片", "視頻", "视频", "照片", "外流", "泄露", "證據", "证据",
  ]);
  const officialTerms = matchedSocialRealtimeTerms(text, [
    "official", "statement", "response", "apology", "notice", "press release", "regulator", "support", "customer service", "hotline",
    "官方", "聲明", "声明", "回應", "回应", "道歉", "公告", "監管", "监管", "客服", "熱線", "热线",
  ]);
  const propagationTerms = matchedSocialRealtimeTerms(text, [
    "viral", "spreading", "amplified", "trending", "shared", "forwarded", "reposted", "quoted", "thread", "public channel", "cross-platform", "media coverage",
    "擴散", "扩散", "熱議", "热议", "轉發", "转发", "引用", "串文", "公開頻道", "公开频道", "跨平台", "媒體報導", "媒体报道",
  ]);
  const ageMinutes = socialRealtimeAgeMinutes(item.publishedAt);
  const freshPost = ageMinutes !== null && ageMinutes <= 180;
  const engagement = [
    metrics.replies,
    metrics.reblogs,
    metrics.favourites,
    metrics.reposts,
    metrics.likes,
    metrics.quotes,
    metrics.views,
  ].reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  const outboundCount = Math.max(
    Number(metrics.outbound_link_count || 0),
    Array.isArray(metrics.outbound_links) ? metrics.outbound_links.length : 0,
  );
  const externalCount = Math.max(
    Number(metrics.external_outbound_link_count || 0),
    Array.isArray(metrics.external_outbound_links) ? metrics.external_outbound_links.length : 0,
  );
  const mediaCount = Math.max(Number(metrics.media_asset_count || 0), Array.isArray(item.visualAssets) ? item.visualAssets.length : 0);
  const hasCard = Boolean(metrics.has_card_preview || metrics.has_external_embed || metrics.link_preview_url || metrics.card_url || metrics.external_embed_url);
  const hasRepost = Boolean(metrics.repost || metrics.quoted || metrics.forwarded_context);
  const hasReply = Boolean(metrics.reply || metrics.reply_to_uri || metrics.reply_to_status_id || metrics.reply_root_uri);
  const reasons = [];
  if (engagement >= 10) reasons.push("engagement-threshold");
  if (hasRepost) reasons.push("repost-quote-forward-context");
  if (hasReply) reasons.push("reply-thread-context");
  if (outboundCount > 0) reasons.push("outbound-link-evidence");
  if (externalCount > 0 || hasCard) reasons.push("external-source-preview");
  if (mediaCount > 0) reasons.push("visual-evidence");
  if (Number(metrics.realtime_match_score || 0) >= 70) reasons.push("strong-keyword-match");
  if (riskTerms.length) reasons.push("risk-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (officialTerms.length) reasons.push("official-response-language");
  if (propagationTerms.length) reasons.push("propagation-language");
  if (freshPost) reasons.push("fresh-realtime-post");
  const realtimeContext = freshPost || engagement >= 10 || hasRepost || hasReply || outboundCount > 0 || externalCount > 0 || hasCard || mediaCount > 0;
  const semanticSignalCount = [
    riskTerms.length,
    evidenceTerms.length,
    officialTerms.length,
    propagationTerms.length || hasRepost || externalCount > 0,
    realtimeContext,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5
    && riskTerms.length > 0
    && evidenceTerms.length > 0
    && officialTerms.length > 0
    && (propagationTerms.length > 0 || hasRepost || externalCount > 0)
    && realtimeContext;
  if (completeNarrative) reasons.push("social-realtime-complete-crisis-narrative");
  const score = Math.min(100, Math.max(0,
    Math.min(28, Math.ceil(engagement / 2))
    + (hasRepost ? 18 : 0)
    + (hasReply ? 12 : 0)
    + (outboundCount > 0 ? 10 : 0)
    + (externalCount > 0 || hasCard ? 14 : 0)
    + (mediaCount > 0 ? 8 : 0)
    + Math.min(10, Math.floor(Number(metrics.realtime_match_score || 0) / 10))
    + (riskTerms.length ? 8 : 0)
    + (evidenceTerms.length ? 8 : 0)
    + (officialTerms.length ? 6 : 0)
    + (propagationTerms.length ? 8 : 0)
    + (freshPost ? 8 : 0)
  ));
  return {
    social_realtime_engagement_total: engagement,
    social_realtime_outbound_link_signal: outboundCount > 0 ? 1 : 0,
    social_realtime_external_preview_signal: externalCount > 0 || hasCard ? 1 : 0,
    social_realtime_media_signal: mediaCount > 0 ? 1 : 0,
    social_realtime_repost_quote_signal: hasRepost ? 1 : 0,
    social_realtime_reply_thread_signal: hasReply ? 1 : 0,
    social_realtime_risk_language_signal: riskTerms.length ? 1 : 0,
    social_realtime_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    social_realtime_official_response_signal: officialTerms.length ? 1 : 0,
    social_realtime_propagation_language_signal: propagationTerms.length ? 1 : 0,
    social_realtime_fresh_post_signal: freshPost ? 1 : 0,
    social_realtime_post_age_minutes: ageMinutes,
    social_realtime_risk_terms: riskTerms,
    social_realtime_evidence_terms: evidenceTerms,
    social_realtime_official_response_terms: officialTerms,
    social_realtime_propagation_terms: propagationTerms,
    social_realtime_semantic_signal_count: semanticSignalCount,
    social_realtime_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    social_realtime_spread_score: score,
    social_realtime_spread_bucket: socialRealtimeSpreadBucket(score),
    social_realtime_spread_signal_count: reasons.length,
    social_realtime_spread_reasons: reasons,
  };
}

function withSocialRealtimeKeywordDiagnostics(item = {}, keyword = "") {
  const evidence = socialRealtimeMatchEvidence(item, keyword);
  item.metrics = {
    ...(item.metrics || {}),
    realtime_match_score: item.metrics?.realtime_match_score ?? evidence.score,
    realtime_matched_fields: item.metrics?.realtime_matched_fields ?? evidence.matchedFields,
    social_realtime_matched_keyword: cleanText(keyword, 160),
    social_realtime_keyword_match_source: evidence.matchedFields[0] || "search_query",
  };
  item.metrics = {
    ...(item.metrics || {}),
    ...socialRealtimeSpreadSignals(item),
  };
  return item;
}

function blueskyPostUrl(post = {}) {
  const handle = cleanText(post.author?.handle || post.author?.did || "", 160);
  const uri = String(post.uri || "");
  const rkey = uri.split("/").pop();
  return handle && rkey ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}` : "";
}

function blueskyReplyReference(view = {}) {
  const record = view?.record || view?.value || {};
  const text = cleanText(record.text || "", 1200);
  const author = cleanText(view?.author?.handle || view?.author?.displayName || view?.author?.did || "", 160);
  return {
    uri: cleanText(view?.uri || record.uri || "", 500),
    cid: cleanText(view?.cid || "", 120),
    author,
    content: text,
    publishedAt: normalizeIsoDate(record.createdAt || view?.indexedAt),
  };
}

function normalizeOutboundUrl(value = "") {
  try {
    return normalizeSocialRealtimeDedupeUrl(new URL(String(value || "").trim()).toString());
  } catch {
    return "";
  }
}

function blueskyFacetLinks(record = {}) {
  const links = [];
  const seen = new Set();
  const facets = Array.isArray(record.facets) ? record.facets : [];
  for (const facet of facets) {
    const features = Array.isArray(facet?.features) ? facet.features : [];
    for (const feature of features) {
      const uri = normalizeOutboundUrl(feature?.uri || "");
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      let host = "";
      try {
        host = new URL(uri).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        host = "";
      }
      links.push({ url: uri, host });
      if (links.length >= 30) break;
    }
    if (links.length >= 30) break;
  }
  return links;
}

function blueskyExternalEmbed(embed = {}) {
  const external = embed?.external || embed?.record?.external || null;
  if (!external || typeof external !== "object") return null;
  const url = normalizeOutboundUrl(external.uri || external.url || "");
  if (!url) return null;
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    host = "";
  }
  return {
    url,
    host,
    title: cleanText(external.title || "", 300),
    description: cleanText(external.description || "", 700),
    thumb: cleanText(external.thumb || external.thumbnail || "", 1000),
  };
}

function mastodonStatusReference(status = {}) {
  const url = cleanText(status.url || status.uri || "", 800);
  const uri = cleanText(status.uri || "", 800);
  const author = cleanText(status.account?.acct || status.account?.username || status.account?.display_name || "Mastodon", 160);
  const content = cleanText(`${status.spoiler_text || ""} ${status.content || ""}`, 1200);
  return {
    url,
    uri,
    id: cleanText(status.id || "", 120),
    author,
    content,
    publishedAt: normalizeIsoDate(status.created_at),
    replies: Number(status.replies_count || 0),
    reblogs: Number(status.reblogs_count || 0),
    favourites: Number(status.favourites_count || 0),
  };
}

function extractLinksFromHtml(html = "", baseUrl = "") {
  const links = [];
  const seen = new Set();
  const source = String(html || "");
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const raw = decodeHtmlAttribute(match[1] || "").trim();
    if (!raw || /^javascript:|^mailto:|^tel:/i.test(raw)) continue;
    try {
      const parsed = new URL(raw, baseUrl || undefined);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      const url = normalizeSocialRealtimeDedupeUrl(parsed.toString());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({
        url,
        text: cleanText(match[2] || "", 240),
        host: parsed.hostname.replace(/^www\./, "").toLowerCase(),
      });
      if (links.length >= 30) break;
    } catch {
      continue;
    }
  }
  return links;
}

function mastodonCardEvidence(card = {}) {
  if (!card || typeof card !== "object") return null;
  const url = normalizeSocialRealtimeDedupeUrl(card.url || "");
  if (!url) return null;
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    host = "";
  }
  return {
    url,
    host,
    title: cleanText(card.title || "", 300),
    description: cleanText(card.description || "", 700),
    providerName: cleanText(card.provider_name || card.providerName || "", 180),
    type: cleanText(card.type || "", 80),
    image: cleanText(card.image || card.embed_url || "", 1000),
  };
}

function mastodonNextPageUrl(linkHeader = "", instanceUrl = "") {
  const normalizedInstance = normalizeSiteUrl(instanceUrl);
  const links = String(linkHeader || "").split(/,\s*</).map((part, index) => index === 0 ? part : `<${part}`);
  for (const link of links) {
    if (!/rel="?next"?/i.test(link)) continue;
    const href = (link.match(/<([^>]+)>/) || [])[1] || "";
    if (!href) continue;
    try {
      const url = new URL(href, normalizedInstance || undefined);
      if (normalizedInstance && `${url.protocol}//${url.host}` !== normalizedInstance) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return "";
}

function insertSocialRealtimeItem(item, {
  platform,
  keyword,
  domainControls = {},
  contentControls = {},
  seenItemUrls = null,
  failoverAttribution = [],
}) {
  const dedupeKey = socialRealtimeDedupeKey(item);
  if (!dedupeKey) return 0;
  if (seenItemUrls instanceof Set) {
    if (seenItemUrls.has(dedupeKey)) return 0;
    seenItemUrls.add(dedupeKey);
  }
  const content = cleanText(item.content || "", 1200);
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  const sentiment = analyzeSentiment(`${item.title} ${content}`);
  const result = insertSentimentItem({
    platform,
    url: item.url,
    title: item.title,
    content,
    author: item.author,
    sentiment,
    risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
    keyword,
    keywords: [keyword],
    published_at: item.publishedAt,
    ai_summary: content,
    evidence: {
      evidence_type: item.evidenceType || "social_realtime_post",
      metrics: {
        ...(item.metrics || {}),
        social_realtime_canonical_dedupe_url: socialRealtimeDedupeKey(item),
        social_realtime_scan_dedupe_key: dedupeKey,
        ...(attribution.length ? {
          failover_attribution: attribution,
          failover_from_sources: failoverFromSources,
        } : {}),
      },
    },
    comments: Array.isArray(item.comments) ? item.comments : [],
    visual_assets: item.visualAssets || [],
    source_type: "scraper",
    domainControls,
    contentControls,
  });
  return result.inserted ? 1 : 0;
}

function parseMastodonStatuses(payload, keyword, { instanceUrl = "", limit = 10, since = "", collectionMode = "tag_timeline", page = 1, rawResultCount = 0, requireKeyword = true } = {}) {
  const statuses = Array.isArray(payload) ? payload : [];
  const normalizedInstance = normalizeSiteUrl(instanceUrl);
  return statuses.map(status => {
    const statusRef = mastodonStatusReference(status);
    const reblogRef = status.reblog && typeof status.reblog === "object" ? mastodonStatusReference(status.reblog) : null;
    const content = reblogRef?.content
      ? cleanText(statusRef.content ? `${statusRef.content}\n轉發內容：${reblogRef.content}` : reblogRef.content, 1200)
      : statusRef.content;
    const author = statusRef.author;
    const media = Array.isArray(status.media_attachments) ? status.media_attachments : [];
    const outboundLinks = extractLinksFromHtml(`${status.content || ""} ${status.spoiler_text || ""}`, statusRef.url || normalizedInstance);
    const reblogLinks = status.reblog && typeof status.reblog === "object"
      ? extractLinksFromHtml(`${status.reblog.content || ""} ${status.reblog.spoiler_text || ""}`, reblogRef?.url || normalizedInstance)
      : [];
    const allOutboundLinks = [];
    const seenOutboundLinks = new Set();
    for (const link of [...outboundLinks, ...reblogLinks]) {
      if (!link.url || seenOutboundLinks.has(link.url)) continue;
      seenOutboundLinks.add(link.url);
      allOutboundLinks.push(link);
    }
    const card = mastodonCardEvidence(status.card || status.reblog?.card || {});
    const comments = reblogRef?.content ? [{
      external_id: reblogRef.uri || reblogRef.url || `reblog:${reblogRef.id}`,
      author: reblogRef.author,
      content: reblogRef.content,
      published_at: reblogRef.publishedAt,
      metrics: {
        source: "mastodon_reblog_original",
        uri: reblogRef.uri,
        url: reblogRef.url,
        original_uri: reblogRef.uri,
        original_url: reblogRef.url,
        status_id: reblogRef.id,
      },
    }] : [];
    if (card?.url) {
      comments.push({
        external_id: `${statusRef.uri || statusRef.url || statusRef.id}:card`,
        author: card.providerName || card.host || "Mastodon link preview",
        content: cleanText([card.title, card.description].filter(Boolean).join(" "), 1000),
        published_at: statusRef.publishedAt,
        metrics: {
          source: "mastodon_card_preview",
          url: card.url,
          source_url: card.url,
          host: card.host,
          card_type: card.type,
        },
      });
    }
    const item = {
      url: statusRef.url || reblogRef?.url || reblogRef?.uri || "",
      title: cleanText(content || `Mastodon post by ${author}`, 300),
      content,
      author,
      publishedAt: statusRef.publishedAt,
      evidenceType: "mastodon_status",
      comments,
      visualAssets: [
        ...media.map(asset => ({
          image_url: asset.url || asset.preview_url || "",
          thumbnail_url: asset.preview_url || asset.url || "",
          scene_tags: [asset.type || "media"].filter(Boolean),
          metrics: {
            source: "mastodon",
            attachment_id: asset.id || "",
          },
        })).filter(asset => asset.image_url),
        ...(card?.image ? [{
          image_url: card.image,
          thumbnail_url: card.image,
          scene_tags: ["mastodon-card-preview"],
          metrics: {
            source: "mastodon_card_preview",
            url: card.url,
            host: card.host,
          },
        }] : []),
      ],
      metrics: {
        source: "mastodon",
        source_family: "social",
        source_kind: "public_realtime_social_post",
        instance: normalizedInstance,
        collection_mode: collectionMode,
        social_realtime_search_page: Math.max(1, Number(page) || 1),
        social_realtime_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
        source_weight_tier: "realtime-social",
        status_id: statusRef.id,
        uri: statusRef.uri,
        outbound_link_count: allOutboundLinks.length,
        outbound_links: allOutboundLinks.map(link => link.url),
        outbound_link_hosts: [...new Set(allOutboundLinks.map(link => link.host).filter(Boolean))],
        card_url: card?.url || "",
        card_title: card?.title || "",
        card_description: card?.description || "",
        card_provider_name: card?.providerName || "",
        card_type: card?.type || "",
        card_host: card?.host || "",
        card_image_url: card?.image || "",
        has_card_preview: card?.url ? 1 : 0,
        replies: statusRef.replies,
        reblogs: statusRef.reblogs,
        favourites: statusRef.favourites,
        language: cleanText(status.language || "", 20),
        visibility: cleanText(status.visibility || "", 40),
        reply_to_status_id: cleanText(status.in_reply_to_id || "", 120),
        reply_to_account_id: cleanText(status.in_reply_to_account_id || "", 120),
      },
    };
    if (reblogRef?.url || reblogRef?.uri || reblogRef?.id) {
      Object.assign(item.metrics, {
        repost: 1,
        original_url: reblogRef.url,
        original_uri: reblogRef.uri,
        original_post_url: reblogRef.url,
        repost_of_url: reblogRef.url,
        repost_of_uri: reblogRef.uri,
        repost_of_status_id: reblogRef.id,
        repost_of_author: reblogRef.author,
        repost_of_created_at: reblogRef.publishedAt,
        original_replies: reblogRef.replies,
        original_reblogs: reblogRef.reblogs,
        original_favourites: reblogRef.favourites,
      });
    }
    return withSocialRealtimeKeywordDiagnostics(item, keyword);
  }).filter(item => item.url && item.content && (!requireKeyword || textMatchesKeyword(item, keyword)) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseMastodonSearchResults(payload, keyword, { instanceUrl = "", limit = 10, since = "" } = {}) {
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
  return parseMastodonStatuses(statuses, keyword, {
    instanceUrl,
    limit,
    since,
    collectionMode: "public_search",
    page: 1,
    rawResultCount: statuses.length,
  });
}

function parseBlueskyPosts(payload, keyword, { limit = 10, since = "", deepBudget = null, page = 1, rawResultCount = 0, requireKeyword = true } = {}) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  return posts.map(post => {
    const record = post.record || {};
    const content = cleanText(record.text || "", 1200);
    const author = cleanText(post.author?.handle || post.author?.displayName || post.author?.did || "Bluesky", 160);
    const embedImages = Array.isArray(post.embed?.images) ? post.embed.images : [];
    const outboundLinks = blueskyFacetLinks(record);
    const externalEmbed = blueskyExternalEmbed(post.embed || {});
    const allOutboundLinks = [];
    const seenOutboundLinks = new Set();
    for (const link of [...outboundLinks, ...(externalEmbed?.url ? [{ url: externalEmbed.url, host: externalEmbed.host }] : [])]) {
      if (!link.url || seenOutboundLinks.has(link.url)) continue;
      seenOutboundLinks.add(link.url);
      allOutboundLinks.push(link);
    }
    const quotedRecord = normalizedDeepBudget.captureQuotedContext
      ? post.embed?.record?.value || post.embed?.record?.record?.value || post.embed?.record?.record || null
      : null;
    const quotedAuthor = post.embed?.record?.author?.handle
      || post.embed?.record?.record?.author?.handle
      || post.embed?.record?.author?.displayName
      || "";
    const quotedText = cleanText(quotedRecord?.text || "", 1200);
    const quotedUri = cleanText(post.embed?.record?.uri || post.embed?.record?.record?.uri || "", 500);
    const replyParent = normalizedDeepBudget.captureQuotedContext ? blueskyReplyReference(post.reply?.parent) : null;
    const replyRoot = normalizedDeepBudget.captureQuotedContext ? blueskyReplyReference(post.reply?.root) : null;
    const comments = quotedText ? [{
      external_id: quotedUri || `quote:${cleanText(post.uri || "", 180)}`,
      author: cleanText(quotedAuthor || "Bluesky quoted post", 160),
      content: quotedText,
      published_at: normalizeIsoDate(quotedRecord?.createdAt || post.indexedAt),
      metrics: {
        source: "bluesky_quote",
        uri: quotedUri,
      },
    }] : [];
    if (replyParent?.content || replyParent?.uri) {
      comments.push({
        external_id: replyParent.uri || `reply-parent:${cleanText(post.uri || "", 180)}`,
        author: replyParent.author || "Bluesky reply parent",
        content: replyParent.content || "Bluesky reply parent context",
        published_at: replyParent.publishedAt,
        metrics: {
          source: "bluesky_reply_parent",
          uri: replyParent.uri,
          cid: replyParent.cid,
        },
      });
    }
    if (replyRoot?.uri && replyRoot.uri !== replyParent?.uri) {
      comments.push({
        external_id: replyRoot.uri,
        author: replyRoot.author || "Bluesky reply root",
        content: replyRoot.content || "Bluesky reply root context",
        published_at: replyRoot.publishedAt,
        metrics: {
          source: "bluesky_reply_root",
          uri: replyRoot.uri,
          cid: replyRoot.cid,
        },
      });
    }
    if (externalEmbed?.url) {
      comments.push({
        external_id: `${cleanText(post.uri || "", 180)}:external`,
        author: externalEmbed.host || "Bluesky external embed",
        content: cleanText([externalEmbed.title, externalEmbed.description].filter(Boolean).join(" "), 1000),
        published_at: normalizeIsoDate(record.createdAt || post.indexedAt),
        metrics: {
          source: "bluesky_external_embed",
          url: externalEmbed.url,
          source_url: externalEmbed.url,
          host: externalEmbed.host,
          card_type: "external",
        },
      });
    }
    const item = {
      url: blueskyPostUrl(post),
      title: cleanText(content || `Bluesky post by ${author}`, 300),
      content: cleanText([
        content,
        quotedText ? `引用內容：${quotedText}` : "",
        replyParent?.content ? `回覆上文：${replyParent.content}` : "",
      ].filter(Boolean).join("\n"), 1200),
      author,
      publishedAt: normalizeIsoDate(record.createdAt || post.indexedAt),
      evidenceType: "bluesky_post",
      comments,
      visualAssets: [
        ...embedImages.map(image => ({
          image_url: image.fullsize || image.thumb || "",
          thumbnail_url: image.thumb || image.fullsize || "",
          ocr_text: cleanText(image.alt || "", 500),
          metrics: {
            source: "bluesky",
          },
        })).filter(asset => asset.image_url),
        ...(externalEmbed?.thumb ? [{
          image_url: externalEmbed.thumb,
          thumbnail_url: externalEmbed.thumb,
          scene_tags: ["bluesky-external-preview"],
          metrics: {
            source: "bluesky_external_embed",
            url: externalEmbed.url,
            host: externalEmbed.host,
          },
        }] : []),
      ],
      metrics: {
        source: "bluesky_search",
        source_family: "social",
        source_kind: "public_realtime_social_post",
        collection_mode: "bluesky_public_appview_search",
        social_realtime_search_page: Math.max(1, Number(page) || 1),
        social_realtime_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
        source_weight_tier: "realtime-social",
        uri: cleanText(post.uri || "", 500),
        cid: cleanText(post.cid || "", 120),
        did: cleanText(post.author?.did || "", 200),
        outbound_link_count: allOutboundLinks.length,
        outbound_links: allOutboundLinks.map(link => link.url),
        outbound_link_hosts: [...new Set(allOutboundLinks.map(link => link.host).filter(Boolean))],
        external_embed_url: externalEmbed?.url || "",
        external_embed_title: externalEmbed?.title || "",
        external_embed_description: externalEmbed?.description || "",
        external_embed_host: externalEmbed?.host || "",
        external_embed_thumb: externalEmbed?.thumb || "",
        has_external_embed: externalEmbed?.url ? 1 : 0,
        replies: Number(post.replyCount || 0),
        reposts: Number(post.repostCount || 0),
        likes: Number(post.likeCount || 0),
        quotes: Number(post.quoteCount || 0),
        quoted: quotedText ? 1 : 0,
        reply: replyParent?.uri ? 1 : 0,
        reply_to_uri: replyParent?.uri || "",
        reply_to_cid: replyParent?.cid || "",
        reply_root_uri: replyRoot?.uri || "",
        reply_root_cid: replyRoot?.cid || "",
        reply_parent_author: replyParent?.author || "",
        reply_root_author: replyRoot?.author || "",
        language: Array.isArray(record.langs) ? record.langs.join(",") : "",
      },
    };
    return withSocialRealtimeKeywordDiagnostics(item, keyword);
  }).filter(item => item.url && item.content && (!requireKeyword || textMatchesKeyword(item, keyword)) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseTelegramPublicChannel(html = "", keyword = "", { channel = "", limit = 10, since = "", pageUrl = "", pageBefore = "", page = 1, rawResultCount = 0 } = {}) {
  const source = String(html || "");
  const items = [];
  const messageRegex = /<div\b[^>]*class="[^"]*\btgme_widget_message\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*class="[^"]*\btgme_widget_message\b|<\/section>|$)/gi;
  let match;
  while ((match = messageRegex.exec(source)) !== null) {
    const block = match[0] || match[1] || "";
    const postId = decodeHtmlAttribute((block.match(/\bdata-post=["']([^"']+)["']/i) || [])[1] || "");
    const textBlock = (block.match(/<div\b[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
    const content = cleanText(textBlock, 1800);
    const author = cleanText((block.match(/<div\b[^>]*class="[^"]*\btgme_widget_message_author\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || channel || "Telegram", 160);
    const dateRaw = decodeHtmlAttribute((block.match(/<time\b[^>]*datetime=["']([^"']+)["']/i) || [])[1] || "");
    const url = postId ? `https://t.me/${postId}` : "";
    const viewsRaw = cleanText((block.match(/<span\b[^>]*class="[^"]*\btgme_widget_message_views\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "", 40);
    const repliesRaw = cleanText((block.match(/<span\b[^>]*class="[^"]*\btgme_widget_message_replies\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "", 40);
    const links = extractTelegramMessageLinks(block, { pageUrl, channel, postUrl: url });
    const externalLinks = links.filter(link => !link.is_telegram);
    const linkPreview = extractTelegramLinkPreview(block, { pageUrl, channel });
    const forwardedFrom = extractTelegramForwardedFrom(block);
    const visualAssets = extractTelegramMessageMedia(block, { pageUrl, channel });
    const comments = [];
    if (forwardedFrom?.author || forwardedFrom?.url) {
      comments.push({
        external_id: `${postId || url}:forwarded-from`,
        author: forwardedFrom.author || "Telegram forwarded source",
        content: cleanText(forwardedFrom.author || forwardedFrom.url || "Telegram forwarded source", 500),
        published_at: normalizeIsoDate(dateRaw || Date.now()),
        metrics: {
          source: "telegram_forwarded_from",
          url: forwardedFrom.url || "",
        },
      });
    }
    const item = {
      url,
      title: cleanText(content || `Telegram ${channel} message`, 300),
      content,
      author,
      publishedAt: normalizeIsoDate(dateRaw || Date.now()),
      evidenceType: "telegram_public_message",
      comments,
      visualAssets,
      metrics: {
        source: "telegram_public_channel",
        source_family: "social",
        source_kind: "public_realtime_social_post",
        source_weight_tier: "realtime-social",
        channel,
        post_id: postId,
        message_id: telegramMessageIdFromPostId(postId, channel),
        source_url: pageUrl || (channel ? `https://t.me/s/${channel}` : ""),
        channel_url: channel ? `https://t.me/s/${channel}` : "",
        page_before: cleanText(pageBefore || "", 40),
        social_realtime_search_page: Math.max(1, Number(page) || 1),
        social_realtime_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
        views: parseCompactCount(viewsRaw),
        replies: parseCompactCount(repliesRaw),
        collection_mode: "public_channel_page",
        outbound_link_count: links.length,
        external_outbound_link_count: externalLinks.length,
        telegram_internal_link_count: links.length - externalLinks.length,
        outbound_links: links.map(link => link.url),
        outbound_link_hosts: [...new Set(externalLinks.map(link => link.host).filter(Boolean))],
        external_outbound_links: externalLinks.map(link => link.url),
        link_preview_url: linkPreview?.url || "",
        link_preview_title: linkPreview?.title || "",
        link_preview_site_name: linkPreview?.siteName || "",
        has_link_preview: linkPreview?.url ? 1 : 0,
        media_asset_count: visualAssets.length,
        forwarded_from_author: forwardedFrom?.author || "",
        forwarded_from_url: forwardedFrom?.url || "",
        forwarded_context: forwardedFrom?.author || forwardedFrom?.url ? 1 : 0,
      },
    };
    withSocialRealtimeKeywordDiagnostics(item, keyword);
    if (item.url && item.content && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)) {
      items.push(item);
      if (items.length >= limit) break;
    }
  }
  return items;
}

function parseCompactCount(value = "") {
  const text = String(value || "").replace(/,/g, "").trim().toLowerCase();
  const match = text.match(/(\d+(?:\.\d+)?)\s*([km萬万])?/i);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  const unit = match[2] || "";
  if (unit === "k") return Math.round(number * 1000);
  if (unit === "m") return Math.round(number * 1000000);
  if (unit === "萬" || unit === "万") return Math.round(number * 10000);
  return Math.round(number);
}

async function scrapeTelegramDirectUrlsForKeyword(keyword, directUrls = [], {
  proxyUrl = "",
  budget = {},
  since = "",
  domainControls = {},
  contentControls = {},
  seenItemUrls = null,
  failoverAttribution = [],
} = {}) {
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDirectUrls = Array.isArray(directUrls) && directUrls.some(item => item?.channel && item?.messageId)
    ? directUrls.slice(0, Math.max(1, normalizedBudget.maxItemsPerKeyword))
    : normalizeTelegramDirectUrls(directUrls, Math.max(1, normalizedBudget.maxItemsPerKeyword));
  if (!normalizedDirectUrls.length) return { inserted: 0, failures: [] };
  const insertKeyword = socialRealtimeDirectAnchorKeyword(keyword);
  let inserted = 0;
  const failures = [];
  for (const direct of normalizedDirectUrls) {
    let recovered = false;
    let lastFailure = "";
    for (const pageUrl of direct.publicUrls || []) {
      if (!pageUrl) continue;
      try {
        const res = await fetchPublicSource(pageUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          lastFailure = httpFailure(res);
          continue;
        }
        const html = await res.text();
        const rawMessageCount = (html.match(/\btgme_widget_message\b/g) || []).length;
        const items = parseTelegramPublicChannel(html, keyword, {
          channel: direct.channel,
          limit: normalizedBudget.maxItemsPerKeyword,
          since,
          pageUrl,
          page: 1,
          rawResultCount: rawMessageCount,
        }).filter(item => {
          const messageId = Number(item?.metrics?.message_id || 0);
          const normalizedUrl = normalizeSocialRealtimeDedupeUrl(item?.url || "");
          return messageId === direct.messageId || normalizedUrl === direct.url;
        });
        for (const item of items) {
          item.evidenceType = "telegram_direct_message";
          item.metrics = {
            ...(item.metrics || {}),
            source: "telegram_direct_url",
            source_kind: "telegram_direct_message",
            collection_mode: "telegram_direct_url",
            deep_collector: "telegram-direct-url",
            telegram_direct_url: direct.url,
            telegram_original_direct_url: direct.originalUrl || direct.url,
            telegram_direct_channel: direct.channel,
            telegram_direct_message_id: direct.messageId,
            telegram_direct_url_signal: 1,
            direct_original_source_recovery: 1,
            direct_original_source_context_keyword: cleanText(keyword, 180),
          };
          inserted += insertSocialRealtimeItem(item, {
            platform: "telegram",
            keyword: insertKeyword,
            domainControls,
            contentControls,
            seenItemUrls,
            failoverAttribution,
          });
          recovered = true;
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
        if (recovered || inserted >= normalizedBudget.maxItemsPerKeyword) break;
        lastFailure = rawMessageCount
          ? `Telegram direct page loaded but message ${direct.messageId} was not found`
          : "Telegram direct page did not expose public messages";
      } catch (err) {
        lastFailure = formatSourceError(err, proxyUrl);
      }
    }
    if (!recovered) {
      failures.push({
        keyword,
        target: direct.url,
        message: lastFailure || "Telegram direct message unavailable",
      });
    }
    if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
  }
  return { inserted, failures };
}

export async function scrapeTelegramPublicChannels(keywords, { proxyUrl = "", budget = {}, since = "", channels = DEFAULT_TELEGRAM_CHANNELS, domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  if (!TELEGRAM_PUBLIC_NETWORK_COLLECTION_ENABLED) return scraperResult(0);
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const telegramChannels = normalizeTelegramChannels(channels);
  const telegramDirectUrls = normalizeTelegramDirectUrls(directUrls);
  if (!normalizedKeywords.length || (!telegramChannels.length && !telegramDirectUrls.length)) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();
  const directResults = telegramDirectUrls.length
    ? await mapWithConcurrency(normalizedKeywords, KEYWORD_CONCURRENCY, keyword => scrapeTelegramDirectUrlsForKeyword(keyword, telegramDirectUrls, {
      proxyUrl,
      budget,
      since,
      domainControls,
      contentControls,
      seenItemUrls,
      failoverAttribution,
    }))
    : [];
  if (!telegramChannels.length) {
    return scraperResult(
      directResults.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
      directResults.flatMap(result => result?.failures || []),
    );
  }
  const tasks = [];
  for (const channel of telegramChannels) {
    for (const keyword of normalizedKeywords) tasks.push({ channel, keyword });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ channel, keyword }) => {
    let inserted = 0;
    const failures = [];
    const seenUrls = new Set();
    const seenBeforeCursors = new Set();
    let beforeCursor = "";
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const url = beforeCursor
          ? `https://t.me/s/${encodeURIComponent(channel)}?before=${encodeURIComponent(beforeCursor)}`
          : `https://t.me/s/${encodeURIComponent(channel)}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) return { inserted, failures: [{ keyword, target: channel, message: httpFailure(res) }] };
        const html = await res.text();
        const rawMessageCount = (html.match(/\btgme_widget_message\b/g) || []).length;
        const nextBeforeCursor = telegramBeforeCursorFromHtml(html, channel);
        const items = parseTelegramPublicChannel(html, keyword, {
          channel,
          limit: normalizedBudget.maxItemsPerKeyword - inserted,
          since,
          pageUrl: url,
          pageBefore: beforeCursor,
          page,
          rawResultCount: rawMessageCount,
        });
        if (!items.length && (!nextBeforeCursor || !rawMessageCount)) break;
        for (const item of items) {
          const dedupeKey = socialRealtimeDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          inserted += insertSocialRealtimeItem(item, { platform: "telegram", keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
        if (!nextBeforeCursor || seenBeforeCursors.has(nextBeforeCursor)) break;
        seenBeforeCursors.add(nextBeforeCursor);
        beforeCursor = nextBeforeCursor;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: channel, message });
      console.warn(`[CRM/Telegram] 抓取失敗 channel=${channel} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    [...directResults, ...results].reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directResults, ...results].flatMap(result => result?.failures || []),
  );
}

async function scrapeMastodonDirectUrlsForKeyword(keyword, directUrls = [], {
  proxyUrl = "",
  budget = {},
  since = "",
  domainControls = {},
  contentControls = {},
  failoverAttribution = [],
  seenItemUrls = null,
} = {}) {
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDirectUrls = Array.isArray(directUrls) && directUrls.some(item => item?.apiUrl)
    ? directUrls.slice(0, Math.max(1, normalizedBudget.maxItemsPerKeyword))
    : normalizeMastodonDirectUrls(directUrls, Math.max(1, normalizedBudget.maxItemsPerKeyword));
  if (!normalizedDirectUrls.length) return { inserted: 0, failures: [] };
  let inserted = 0;
  const failures = [];
  const seenUrls = new Set();
  const insertKeyword = socialRealtimeDirectAnchorKeyword(keyword);
  for (const direct of normalizedDirectUrls) {
    if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
    try {
      const res = await fetchPublicSource(direct.apiUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: direct.url, message: httpFailure(res) });
        continue;
      }
      const status = await res.json();
      const items = parseMastodonStatuses([status], keyword, {
        instanceUrl: direct.instanceUrl,
        limit: normalizedBudget.maxItemsPerKeyword - inserted,
        since,
        collectionMode: "mastodon_direct_url",
        page: 1,
        rawResultCount: 1,
        requireKeyword: false,
      }).map(item => ({
        ...item,
        metrics: {
          ...(item.metrics || {}),
          source_kind: "mastodon_direct_url",
          collection_mode: "mastodon_direct_url",
          deep_collector: "mastodon-direct-url",
          mastodon_direct_url: direct.url,
          mastodon_original_direct_url: direct.originalUrl || direct.url,
          mastodon_direct_status_id: direct.statusId,
          mastodon_direct_url_signal: 1,
          direct_original_source_recovery: 1,
          direct_original_source_context_keyword: cleanText(keyword, 180),
        },
      }));
      for (const item of items) {
        const dedupeKey = socialRealtimeDedupeKey(item);
        if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
        seenUrls.add(dedupeKey);
        inserted += insertSocialRealtimeItem(item, { platform: "mastodon", keyword: insertKeyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: direct.url, message });
      console.warn(`[CRM/Mastodon] 直鏈回抓失敗 url=${direct.url} keyword=${keyword}: ${message}`);
    }
  }
  return { inserted, failures };
}

async function resolveBlueskyActorDid(actor = "", { proxyUrl = "" } = {}) {
  const normalizedActor = cleanText(actor, 240);
  if (!normalizedActor) return "";
  if (/^did:/i.test(normalizedActor)) return normalizedActor;
  const params = new URLSearchParams({ handle: normalizedActor });
  const url = `${BLUESKY_PUBLIC_APPVIEW}/xrpc/com.atproto.identity.resolveHandle?${params.toString()}`;
  const res = await fetchPublicSource(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl);
  if (!res.ok) throw new Error(httpFailure(res));
  const payload = await res.json();
  return cleanText(payload?.did || "", 240);
}

async function scrapeBlueskyDirectUrlsForKeyword(keyword, directUrls = [], {
  proxyUrl = "",
  budget = {},
  deepBudget = null,
  since = "",
  domainControls = {},
  contentControls = {},
  failoverAttribution = [],
  seenItemUrls = null,
} = {}) {
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDirectUrls = Array.isArray(directUrls) && directUrls.some(item => item?.actor && item?.rkey)
    ? directUrls.slice(0, Math.max(1, normalizedBudget.maxItemsPerKeyword))
    : normalizeBlueskyDirectUrls(directUrls, Math.max(1, normalizedBudget.maxItemsPerKeyword));
  if (!normalizedDirectUrls.length) return { inserted: 0, failures: [] };
  let inserted = 0;
  const failures = [];
  const seenUrls = new Set();
  const insertKeyword = socialRealtimeDirectAnchorKeyword(keyword);
  for (const direct of normalizedDirectUrls) {
    if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
    try {
      const did = await resolveBlueskyActorDid(direct.actor, { proxyUrl });
      if (!did) {
        failures.push({ keyword, target: direct.url, message: "Unable to resolve Bluesky actor DID" });
        continue;
      }
      const uri = `at://${did}/app.bsky.feed.post/${direct.rkey}`;
      const params = new URLSearchParams({ uris: uri });
      const url = `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getPosts?${params.toString()}`;
      const res = await fetchPublicSource(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: direct.url, message: httpFailure(res) });
        continue;
      }
      const payload = await res.json();
      const rawPosts = Array.isArray(payload?.posts) ? payload.posts : [];
      const items = parseBlueskyPosts(payload, keyword, {
        limit: normalizedBudget.maxItemsPerKeyword - inserted,
        since,
        deepBudget,
        page: 1,
        rawResultCount: rawPosts.length,
        requireKeyword: false,
      }).map(item => ({
        ...item,
        metrics: {
          ...(item.metrics || {}),
          source: "bluesky_direct_url",
          source_kind: "bluesky_direct_url",
          collection_mode: "bluesky_direct_url",
          deep_collector: "bluesky-direct-url",
          bluesky_direct_url: direct.url,
          bluesky_original_direct_url: direct.originalUrl || direct.url,
          bluesky_direct_actor: direct.actor,
          bluesky_direct_rkey: direct.rkey,
          bluesky_direct_uri: uri,
          bluesky_direct_url_signal: 1,
          direct_original_source_recovery: 1,
          direct_original_source_context_keyword: cleanText(keyword, 180),
        },
      }));
      for (const item of items) {
        const dedupeKey = socialRealtimeDedupeKey(item);
        if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
        seenUrls.add(dedupeKey);
        inserted += insertSocialRealtimeItem(item, { platform: "bluesky", keyword: insertKeyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: direct.url, message });
      console.warn(`[CRM/Bluesky] 直鏈回抓失敗 url=${direct.url} keyword=${keyword}: ${message}`);
    }
  }
  return { inserted, failures };
}

export async function scrapeMastodonTags(keywords, { proxyUrl = "", budget = {}, since = "", instances = DEFAULT_MASTODON_INSTANCES, domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const mastodonDirectUrls = normalizeMastodonDirectUrls(directUrls);
  if (!normalizedKeywords.length && !mastodonDirectUrls.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const mastodonInstances = normalizeInstances(instances);
  const seenItemUrls = new Set();

  const directResults = await mapWithConcurrency(normalizedKeywords, KEYWORD_CONCURRENCY, async (keyword) =>
    scrapeMastodonDirectUrlsForKeyword(keyword, mastodonDirectUrls, {
      proxyUrl,
      budget,
      since,
      domainControls,
      contentControls,
      failoverAttribution,
      seenItemUrls,
    })
  );

  const tasks = [];
  for (const instanceUrl of mastodonInstances) {
    for (const keyword of normalizedKeywords) {
      const hashtag = normalizeHashtag(keyword);
      if (hashtag) tasks.push({ instanceUrl, keyword, hashtag });
    }
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ instanceUrl, keyword, hashtag }) => {
    let inserted = 0;
    const failures = [];
    const seenUrls = new Set();
    try {
      const initialParams = new URLSearchParams({
        limit: String(Math.min(40, normalizedBudget.maxItemsPerKeyword)),
      });
      let nextTagUrl = `${instanceUrl}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?${initialParams.toString()}`;
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const res = await fetchPublicSource(nextTagUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${instanceUrl}:tag:${hashtag}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawStatuses = Array.isArray(payload) ? payload : [];
        nextTagUrl = mastodonNextPageUrl(res.headers.get("link") || "", instanceUrl);
        const items = parseMastodonStatuses(payload, keyword, {
          instanceUrl,
          limit: normalizedBudget.maxItemsPerKeyword - inserted,
          since,
          collectionMode: "tag_timeline",
          page,
          rawResultCount: rawStatuses.length,
        });
        if (!items.length && (!nextTagUrl || !rawStatuses.length)) break;
        for (const item of items) {
          const dedupeKey = socialRealtimeDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          inserted += insertSocialRealtimeItem(item, { platform: "mastodon", keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
        if (!nextTagUrl) break;
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const params = new URLSearchParams({
          q: keyword,
          type: "statuses",
          resolve: "false",
          limit: String(Math.min(40, normalizedBudget.maxItemsPerKeyword - inserted)),
        });
        const url = `${instanceUrl}/api/v2/search?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${instanceUrl}:search`, message: httpFailure(res) });
        } else {
          const items = parseMastodonSearchResults(await res.json(), keyword, {
            instanceUrl,
            limit: normalizedBudget.maxItemsPerKeyword,
            since,
          });
          for (const item of items) {
            const dedupeKey = socialRealtimeDedupeKey(item);
            if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
            seenUrls.add(dedupeKey);
            inserted += insertSocialRealtimeItem(item, { platform: "mastodon", keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
            if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
          }
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: instanceUrl, message });
      console.warn(`[CRM/Mastodon] 抓取失敗 instance=${instanceUrl} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    [...directResults, ...results].reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directResults, ...results].flatMap(result => result?.failures || []),
  );
}

export async function scrapeBlueskySearch(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const blueskyDirectUrls = normalizeBlueskyDirectUrls(directUrls);
  if (!normalizedKeywords.length && !blueskyDirectUrls.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();

  const directResults = await mapWithConcurrency(normalizedKeywords, KEYWORD_CONCURRENCY, async (keyword) =>
    scrapeBlueskyDirectUrlsForKeyword(keyword, blueskyDirectUrls, {
      proxyUrl,
      budget,
      deepBudget,
      since,
      domainControls,
      contentControls,
      failoverAttribution,
      seenItemUrls,
    })
  );

  const results = await mapWithConcurrency(normalizedKeywords, KEYWORD_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    const seenUrls = new Set();
    let cursor = "";
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const params = new URLSearchParams({
          q: keyword,
          sort: "latest",
          limit: String(Math.min(100, normalizedBudget.maxItemsPerKeyword - inserted)),
        });
        if (since) params.set("since", since);
        if (cursor) params.set("cursor", cursor);
        const url = `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.searchPosts?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `page:${page}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawPosts = Array.isArray(payload?.posts) ? payload.posts : [];
        const items = parseBlueskyPosts(payload, keyword, {
          limit: normalizedBudget.maxItemsPerKeyword - inserted,
          since,
          deepBudget,
          page,
          rawResultCount: rawPosts.length,
        });
        cursor = cleanText(payload?.cursor || "", 500);
        if (!items.length && (!cursor || !rawPosts.length)) break;
        for (const item of items) {
          const dedupeKey = socialRealtimeDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          inserted += insertSocialRealtimeItem(item, { platform: "bluesky", keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
        if (!cursor) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/Bluesky] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    [...directResults, ...results].reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directResults, ...results].flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  BLUESKY_PUBLIC_APPVIEW,
  DEFAULT_MASTODON_INSTANCES,
  normalizeBudget,
  normalizeKeywordText,
  socialRealtimeKeywordNeedles,
  valueMatchesKeyword,
  normalizeHashtag,
  normalizeSocialRealtimeDedupeUrl,
  normalizeMastodonDirectUrls,
  normalizeBlueskyDirectUrls,
  normalizeTelegramDirectUrls,
  socialRealtimeDedupeKey,
  mastodonNextPageUrl,
  telegramMessageIdFromPostId,
  telegramBeforeCursorFromHtml,
  normalizeTelegramChannels,
  normalizeInstances,
  normalizeDeepBudget,
  parseCompactCount,
  parseTelegramPublicChannel,
  parseMastodonStatuses,
  parseMastodonSearchResults,
  parseBlueskyPosts,
  textMatchesKeyword,
  socialRealtimeMatchEvidence,
  socialRealtimeKeywordMatchSource,
  socialRealtimeSpreadBucket,
  matchedSocialRealtimeTerms,
  socialRealtimeAgeMinutes,
  socialRealtimeSpreadSignals,
  withSocialRealtimeKeywordDiagnostics,
};
