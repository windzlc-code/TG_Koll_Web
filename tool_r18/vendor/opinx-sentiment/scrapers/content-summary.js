import { fetchPublicSource } from "./http.js";

const REQUEST_TIMEOUT_MS = 6500;
const MIN_USEFUL_TEXT_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 360;
const MAX_BODY_EXCERPT_LENGTH = 2400;
const MAX_RAW_HTML_LENGTH = 180000;
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ensp;|&#8194;/g, " ")
    .replace(/&emsp;|&#8195;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaDescription(html) {
  const source = String(html || "");
  const meta = source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i);
  return stripTags(meta?.[1] || "");
}

function extractMetaContent(html, names = []) {
  const source = String(html || "");
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = source.match(new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"))
      || source.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"));
    if (direct?.[1]) return decodeHtml(direct[1]).trim();
  }
  return "";
}

function extractLinkHref(html, relNames = []) {
  const source = String(html || "");
  for (const rel of relNames) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = source.match(new RegExp(`<link[^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`, "i"))
      || source.match(new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]*>`, "i"));
    if (direct?.[1]) return decodeHtml(direct[1]).trim();
  }
  return "";
}

function absoluteUrl(rawUrl = "", baseUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded || /^(?:javascript|mailto|tel):/i.test(decoded)) return "";
  try {
    return new URL(decoded, baseUrl || undefined).toString();
  } catch {
    return "";
  }
}

function extractArticleMetadata(html, pageUrl = "") {
  const canonicalUrl = extractLinkHref(html, ["canonical"]);
  const ogUrl = extractMetaContent(html, ["og:url"]);
  const imageUrl = extractMetaContent(html, ["og:image", "twitter:image"]);
  const siteName = extractMetaContent(html, ["og:site_name", "application-name"]);
  const social = extractSocialMetadata(html);
  const review = extractReviewMetadata(html);
  const mainContent = extractMainContent(html);
  const engagement = extractEngagementMetrics(html);
  const author = extractMetaContent(html, ["author", "article:author", "twitter:creator", "profile:username"]) || social.author;
  const publishedTime = extractMetaContent(html, [
    "article:published_time",
    "article:modified_time",
    "pubdate",
    "date",
    "datePublished",
  ]) || social.publishedTime;
  const keywords = extractMetaContent(html, ["keywords", "news_keywords"]);
  const baseUrl = canonicalUrl || ogUrl || pageUrl || "";
  const reviewFollowupLinks = shouldExtractReviewFollowups(baseUrl, review)
    ? extractReviewFollowupLinks(html, baseUrl)
    : [];
  const propagationFollowupLinks = extractPropagationFollowupLinks(html, baseUrl);
  const structuredTypes = flattenJsonLdNodes(parseJsonLdBlocks(html))
    .flatMap(node => jsonLdTypes(node))
    .filter(Boolean);
  return {
    canonicalUrl,
    ogUrl,
    imageUrl,
    siteName,
    author,
    publishedTime,
    keywords,
    social,
    review,
    mainContent,
    engagement,
    propagationFollowupLinks,
    reviewFollowupLinks,
    jsonLdTypes: [...new Set(structuredTypes)].slice(0, 20),
  };
}

function parseJsonLdBlocks(html) {
  const source = String(html || "");
  return [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => {
      try {
        return JSON.parse(decodeHtml(match[1]).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function flattenJsonLdNodes(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLdNodes(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  out.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLdNodes(value["@graph"], out);
  for (const key of ["review", "reviews", "aggregateRating", "itemReviewed", "mainEntity", "author", "publisher"]) {
    if (value[key]) flattenJsonLdNodes(value[key], out);
  }
  return out;
}

function firstJsonLdValue(node, keys = []) {
  if (!node || typeof node !== "object") return "";
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = firstJsonLdValue(value, ["name", "alternateName", "username", "text"]);
      if (nested) return nested;
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const nested = firstJsonLdValue(item, keys);
      if (nested) return nested;
    }
  }
  return "";
}

function jsonLdTypes(node = {}) {
  const raw = node?.["@type"] || node?.type || [];
  return (Array.isArray(raw) ? raw : [raw]).map(item => String(item || "").trim()).filter(Boolean);
}

function numberFromValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function firstNumericJsonLdValue(node, keys = []) {
  if (!node || typeof node !== "object") return 0;
  for (const key of keys) {
    const value = node[key];
    const numeric = numberFromValue(value);
    if (numeric) return numeric;
    if (value && typeof value === "object") {
      const nested = firstNumericJsonLdValue(value, ["ratingValue", "ratingCount", "reviewCount", "bestRating", "worstRating", "value"]);
      if (nested) return nested;
    }
  }
  return 0;
}

function extractReviewMetadata(html) {
  const blocks = parseJsonLdBlocks(html);
  const nodes = flattenJsonLdNodes(blocks);
  const reviewNodes = nodes.filter(node => jsonLdTypes(node).some(type => /Review|UserReview/i.test(type)));
  const aggregateNodes = nodes.filter(node => jsonLdTypes(node).some(type => /AggregateRating/i.test(type)));
  const review = reviewNodes[0] || {};
  const aggregate = aggregateNodes[0] || {};
  const reviewRating = review.reviewRating || review.rating || {};
  const aggregateRating = aggregate.ratingValue ? aggregate : (review.aggregateRating || {});
  const rating = firstNumericJsonLdValue(reviewRating, ["ratingValue", "value"])
    || firstNumericJsonLdValue(review, ["ratingValue", "rating"])
    || firstNumericJsonLdValue(aggregateRating, ["ratingValue", "value"]);
  const text = firstJsonLdValue(review, ["reviewBody", "description", "text"]);
  return {
    hasReview: reviewNodes.length > 0 || Boolean(rating || aggregateRating.ratingCount || aggregateRating.reviewCount),
    rating,
    bestRating: firstNumericJsonLdValue(reviewRating, ["bestRating"]) || firstNumericJsonLdValue(aggregateRating, ["bestRating"]),
    worstRating: firstNumericJsonLdValue(reviewRating, ["worstRating"]) || firstNumericJsonLdValue(aggregateRating, ["worstRating"]),
    ratingCount: firstNumericJsonLdValue(aggregateRating, ["ratingCount"]),
    reviewCount: firstNumericJsonLdValue(aggregateRating, ["reviewCount"]),
    text,
    author: firstJsonLdValue(review, ["author", "creator", "name"]),
    publishedTime: firstJsonLdValue(review, ["datePublished", "dateCreated", "dateModified"]),
    itemReviewed: firstJsonLdValue(review.itemReviewed || {}, ["name", "alternateName"])
      || firstJsonLdValue(nodes.find(node => jsonLdTypes(node).some(type => /Product|SoftwareApplication|Organization|LocalBusiness/i.test(type))) || {}, ["name", "headline"]),
    jsonLdReviewCount: reviewNodes.length,
    jsonLdAggregateRatingCount: aggregateNodes.length,
  };
}

function shouldExtractReviewFollowups(baseUrl = "", review = {}) {
  if (review?.hasReview) return true;
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/(trustpilot|bbb\.org|sitejabber|complaintsboard|pissedconsumer|productreview|consumeraffairs|reviews\.io|mouthshut|hellopeter|reclameaqui|apestan|consumidor\.gov\.br|signal\.conso\.gouv\.fr|verbraucherzentrale|ocu\.org|g2\.com|capterra|trustradius|getapp|softwareadvice|sourceforge|alternativeto|appsumo|glassdoor|indeed|kununu|comparably|ambitionbox|teamblind|yelp|tripadvisor|google|foursquare|opentable|trustanalytica|yellowpages|restaurantguru)/i.test(host)) return true;
    return /\/(?:review|reviews|ratings?|complaints?|testimonials?)\b/i.test(path);
  } catch {
    return false;
  }
}

function reviewFollowupKind(url = "", label = "") {
  const text = `${url} ${label}`.toLowerCase();
  if (/page=\d+|p=\d+|sort=|filter=|pagination|next|下一頁|下一页/.test(text)) return "review-pagination";
  if (/comment|comments|discussion|reply|replies|qa|questions|answers|留言|評論|评论|回覆|回复/.test(text)) return "review-comments";
  if (/review|reviews|rating|ratings|testimonial|complaint|complaints|評價|评价|投訴|投诉/.test(text)) return "review-page";
  if (/product|company|business|store|seller|profile|brand|產品|产品|商家|店家|品牌/.test(text)) return "review-profile";
  return "";
}

function extractReviewFollowupLinks(html = "", baseUrl = "", maxLinks = 12) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const push = (url, label = "", source = "html-link") => {
    const absolute = absoluteUrl(url, baseUrl);
    if (!absolute || seen.has(absolute)) return;
    let parsed;
    let base;
    try {
      parsed = new URL(absolute);
      base = baseUrl ? new URL(baseUrl) : null;
    } catch {
      return;
    }
    if (base && absolute.replace(/#.*$/, "") === base.toString().replace(/#.*$/, "")) return;
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
    if (/\/(?:login|signup|register|privacy|terms|cookie|cart|checkout)(?:\/|$)/i.test(parsed.pathname)) return;
    const sameHost = base?.hostname && parsed.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    const kind = reviewFollowupKind(absolute, label);
    if (!kind && !sameHost) return;
    let score = sameHost ? 42 : 30;
    const reasons = [];
    if (sameHost) reasons.push("same-review-host");
    if (kind) {
      reasons.push(kind);
      score += kind === "review-comments" ? 18 : kind === "review-page" ? 16 : kind === "review-pagination" ? 12 : 10;
    }
    if (/next|more|all|see|read|全部|更多|下一頁|下一页/i.test(label)) {
      reasons.push("review-navigation");
      score += 8;
    }
    seen.add(absolute);
    out.push({
      url: absolute,
      label: stripTags(label || absolute).slice(0, 180),
      kind: "article-followup",
      review_followup_kind: kind || "same-host-related",
      score: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
      same_host: Boolean(sameHost),
    });
  };
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const tag = match[0];
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    if (/next|prev|canonical/i.test(rel)) push(href, rel, `rel-${rel}`);
  }
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(source)) !== null) {
    push(match[1] || "", match[2] || "", "anchor");
  }
  return out
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.same_host) - Number(a.same_host) || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(30, Number(maxLinks) || 12)));
}

function extractSocialMetadata(html) {
  const ogTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
  const ogDescription = extractMetaContent(html, ["og:description", "twitter:description"]);
  const creator = extractMetaContent(html, ["twitter:creator", "profile:username", "instapp:owner_user_id"]);
  const jsonLd = parseJsonLdBlocks(html);
  const author = creator || firstJsonLdValue(jsonLd, ["author", "creator", "accountablePerson", "name"]);
  const text = firstJsonLdValue(jsonLd, ["articleBody", "caption", "text", "description"]) || ogDescription;
  const publishedTime = firstJsonLdValue(jsonLd, ["datePublished", "uploadDate", "dateCreated"]);
  return {
    title: ogTitle,
    description: ogDescription,
    author,
    text,
    publishedTime,
    jsonLdCount: jsonLd.length,
  };
}

function extractParagraphText(html) {
  const source = String(html || "")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  const paragraphs = [...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => stripTags(match[1]))
    .filter(text => text.length >= 18);
  if (paragraphs.length) return paragraphs.slice(0, 4).join(" ");
  return stripTags(source).slice(0, 1000);
}

function extractBlockCandidates(html = "") {
  const source = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  const candidates = [];
  const pushMatches = (regex, selector) => {
    let match;
    while ((match = regex.exec(source)) !== null) {
      candidates.push({ selector, html: match[0], inner: match[1] || match[0] });
    }
  };
  pushMatches(/<article\b[^>]*>([\s\S]*?)<\/article>/gi, "article");
  pushMatches(/<main\b[^>]*>([\s\S]*?)<\/main>/gi, "main");
  pushMatches(/<section\b[^>]*(?:article|content|post|story|entry|正文|內容|内容)[^>]*>([\s\S]*?)<\/section>/gi, "section-content");
  pushMatches(/<div\b[^>]*(?:article|content|post|story|entry|body|正文|內容|内容)[^>]*>([\s\S]*?)<\/div>/gi, "div-content");
  if (!candidates.length) candidates.push({ selector: "body", html: source, inner: source });
  return candidates;
}

function extractMainContent(html = "") {
  const candidates = extractBlockCandidates(html).map(candidate => {
    const paragraphs = [...String(candidate.inner || "").matchAll(/<(?:p|li|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|li|blockquote)>/gi)]
      .map(match => stripTags(match[1]))
      .filter(text => text.length >= 12 && !/cookie|privacy policy|版权所有|版權所有|登录|註冊|注册/i.test(text));
    const headingText = [...String(candidate.inner || "").matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .map(match => stripTags(match[1]))
      .filter(text => text.length >= 4)
      .slice(0, 3);
    const text = [...headingText, ...paragraphs].join(" ").replace(/\s+/g, " ").trim() || stripTags(candidate.inner);
    const linkCount = (String(candidate.inner || "").match(/<a\b/gi) || []).length;
    const paragraphCount = paragraphs.length;
    const score = Math.min(70, Math.floor(text.length / 30))
      + Math.min(18, paragraphCount * 3)
      + (/article|main/.test(candidate.selector) ? 12 : 0)
      - Math.min(20, linkCount);
    return {
      selector: candidate.selector,
      text,
      paragraphs: paragraphs.slice(0, 12),
      paragraphCount,
      linkCount,
      score: Math.max(0, Math.min(100, score)),
    };
  }).filter(candidate => candidate.text.length >= 40);
  const best = candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
  if (!best) return {
    text: extractParagraphText(html),
    excerpt: compactText(extractParagraphText(html), MAX_BODY_EXCERPT_LENGTH),
    selector: "",
    paragraphCount: 0,
    linkCount: 0,
    qualityScore: 0,
  };
  return {
    text: best.text,
    excerpt: compactText(best.text, MAX_BODY_EXCERPT_LENGTH),
    selector: best.selector,
    paragraphCount: best.paragraphCount,
    linkCount: best.linkCount,
    qualityScore: best.score,
  };
}

function parseCompactNumber(value = "") {
  const source = decodeHtml(String(value || "")).replace(/,/g, "").trim();
  const match = source.match(/(\d+(?:\.\d+)?)\s*(萬|万|億|亿|k|m)?/i);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = String(match[2] || "").toLowerCase();
  if (unit === "萬" || unit === "万") return Math.round(base * 10000);
  if (unit === "億" || unit === "亿") return Math.round(base * 100000000);
  if (unit === "k") return Math.round(base * 1000);
  if (unit === "m") return Math.round(base * 1000000);
  return Math.round(base);
}

function maxMetricValue(text = "", patterns = []) {
  let max = 0;
  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    while ((match = regex.exec(text)) !== null) {
      max = Math.max(max, parseCompactNumber(match[1] || match[2] || ""));
    }
  }
  return max;
}

function extractEngagementMetrics(html = "") {
  const text = stripTags(html);
  const raw = decodeHtml(String(html || ""));
  const combined = `${raw} ${text}`;
  const metrics = {
    comment_count: maxMetricValue(combined, [
      /(?:commentCount|comments?|評論|评论|留言|跟帖)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)\s*(?:comments?|評論|评论|留言|跟帖)/gi,
    ]),
    share_count: maxMetricValue(combined, [
      /(?:shareCount|shares?|reposts?|转发|轉發|分享)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)\s*(?:shares?|reposts?|转发|轉發|分享)/gi,
    ]),
    like_count: maxMetricValue(combined, [
      /(?:likeCount|likes?|点赞|點讚|赞|讚)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:k|m)?)\s*likes?/gi,
    ]),
    view_count: maxMetricValue(combined, [
      /(?:viewCount|views?|阅读|閱讀|浏览|瀏覽|播放)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)\s*(?:views?|阅读|閱讀|浏览|瀏覽|播放)/gi,
    ]),
  };
  return {
    ...metrics,
    has_engagement_signal: Object.values(metrics).some(value => Number(value || 0) > 0),
  };
}

function propagationFollowupKind(url = "", label = "") {
  const text = `${url} ${stripTags(label)}`.toLowerCase();
  if (/(weibo|xhslink|xiaohongshu|douyin|kuaishou|bilibili|youtube|twitter|x\.com|threads|reddit|facebook|instagram|telegram|t\.me|ptt|dcard|tieba|zhihu)|\/(?:post|posts|status|statuses|video|watch|thread)\b/i.test(text)) return "social-amplification";
  if (/comment|comments|discussion|reply|replies|留言|評論|评论|回覆|回复|跟帖/.test(text)) return "discussion";
  if (/source|original|原文|來源|来源|首发|首發|引用|quote|via|转载|轉載/.test(text)) return "source-reference";
  if (/timeline|update|followup|follow-up|後續|后续|進展|进展|回应|回應|声明|聲明/.test(text)) return "timeline-followup";
  return "";
}

function extractPropagationFollowupLinks(html = "", baseUrl = "", maxLinks = 12) {
  if (!baseUrl) return [];
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(source)) !== null) {
    const absolute = absoluteUrl(match[1] || "", baseUrl);
    if (!absolute || seen.has(absolute)) continue;
    let parsed;
    let base;
    try {
      parsed = new URL(absolute);
      base = new URL(baseUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) continue;
    if (absolute.replace(/#.*$/, "") === base.toString().replace(/#.*$/, "")) continue;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) continue;
    const label = stripTags(match[2] || absolute).slice(0, 180);
    const kind = propagationFollowupKind(absolute, label);
    if (!kind) continue;
    const sameHost = parsed.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    const score = Math.max(0, Math.min(100, (sameHost ? 45 : 34)
      + (kind === "social-amplification" ? 22 : kind === "source-reference" ? 18 : kind === "timeline-followup" ? 16 : 12)));
    seen.add(absolute);
    out.push({
      url: absolute,
      label,
      kind: "propagation-followup",
      propagation_followup_kind: kind,
      score,
      same_host: sameHost,
      reasons: [kind, sameHost ? "same-host" : "cross-host"],
    });
  }
  return out
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(30, Number(maxLinks) || 12)));
}

function compactText(text, max = MAX_SUMMARY_LENGTH) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function chooseSummary({ title = "", currentContent = "", html = "" }) {
  const meta = extractMetaDescription(html);
  const article = extractMainContent(html).text || extractParagraphText(html);
  const social = extractSocialMetadata(html);
  const review = extractReviewMetadata(html);
  const candidates = [review.text, article, social.text, meta, social.title, currentContent, title].filter(Boolean);
  const selected = candidates.find(text => text.length >= MIN_USEFUL_TEXT_LENGTH) || candidates[0] || "";
  return compactText(selected);
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function enrichSearchResultSummary(item, { proxyUrl = "", conditionalHeaders = {} } = {}) {
  const fallback = compactText(item?.content || item?.description || item?.summary || item?.title || "");
  if (!isHttpUrl(item?.url)) {
    return { content: fallback, ai_summary: fallback, enriched: false };
  }

  try {
    const safeConditionalHeaders = {};
    if (conditionalHeaders?.["If-None-Match"]) safeConditionalHeaders["If-None-Match"] = conditionalHeaders["If-None-Match"];
    if (conditionalHeaders?.["If-Modified-Since"]) safeConditionalHeaders["If-Modified-Since"] = conditionalHeaders["If-Modified-Since"];
    const res = await fetchPublicSource(item.url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
        ...safeConditionalHeaders,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    const etag = res.headers?.get?.("etag") || "";
    const lastModified = res.headers?.get?.("last-modified") || "";
    if (res.status === 304) {
      return {
        content: fallback,
        ai_summary: fallback,
        enriched: false,
        not_modified: true,
        http: {
          status: 304,
          etag,
          last_modified: lastModified,
        },
      };
    }
    if (!res.ok) {
      return {
        content: fallback,
        ai_summary: fallback,
        enriched: false,
        http: {
          status: res.status,
          etag,
          last_modified: lastModified,
        },
      };
    }
    const type = String(res.headers?.get?.("content-type") || "");
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
      return {
        content: fallback,
        ai_summary: fallback,
        enriched: false,
        http: {
          status: res.status,
          etag,
          last_modified: lastModified,
        },
      };
    }
    const html = await res.text();
    const summary = chooseSummary({ title: item.title, currentContent: fallback, html });
    const metadata = extractArticleMetadata(html, item.url);
    return {
      content: summary || fallback,
      ai_summary: summary || fallback,
      author: metadata.author,
      published_at: metadata.publishedTime,
      enriched: !!summary && summary !== fallback,
      http: {
        status: res.status,
        etag,
        last_modified: lastModified,
      },
      raw_html: html.slice(0, MAX_RAW_HTML_LENGTH),
      evidence: {
        evidence_type: "article",
        image_url: metadata.imageUrl,
        site_name: metadata.siteName,
        canonical_url: metadata.canonicalUrl,
        og_url: metadata.ogUrl,
        author: metadata.author,
        published_time: metadata.publishedTime,
        keywords: metadata.keywords,
        metrics: {
          site_name: metadata.siteName,
          canonical_url: metadata.canonicalUrl,
          og_url: metadata.ogUrl,
          author: metadata.author,
          published_time: metadata.publishedTime,
          keywords: metadata.keywords,
          social_author: metadata.social?.author || "",
          social_text: metadata.social?.text || "",
          jsonld_blocks: metadata.social?.jsonLdCount || 0,
          jsonld_types: metadata.jsonLdTypes || [],
          article_body_quality_score: metadata.mainContent?.qualityScore || 0,
          article_body_text_length: metadata.mainContent?.text?.length || 0,
          article_body_paragraph_count: metadata.mainContent?.paragraphCount || 0,
          article_body_link_count: metadata.mainContent?.linkCount || 0,
          article_body_selector: metadata.mainContent?.selector || "",
          article_body_excerpt: metadata.mainContent?.excerpt || "",
          engagement_comment_count: metadata.engagement?.comment_count || 0,
          engagement_share_count: metadata.engagement?.share_count || 0,
          engagement_like_count: metadata.engagement?.like_count || 0,
          engagement_view_count: metadata.engagement?.view_count || 0,
          has_engagement_signal: Boolean(metadata.engagement?.has_engagement_signal),
          propagation_followup_link_count: metadata.propagationFollowupLinks?.length || 0,
          propagation_followup_links: metadata.propagationFollowupLinks || [],
          jsonld_review_count: metadata.review?.jsonLdReviewCount || 0,
          jsonld_aggregate_rating_count: metadata.review?.jsonLdAggregateRatingCount || 0,
          review_rating: metadata.review?.rating || 0,
          review_best_rating: metadata.review?.bestRating || 0,
          review_worst_rating: metadata.review?.worstRating || 0,
          review_rating_count: metadata.review?.ratingCount || 0,
          review_count: metadata.review?.reviewCount || 0,
          review_author: metadata.review?.author || "",
          review_published_time: metadata.review?.publishedTime || "",
          review_item: metadata.review?.itemReviewed || "",
          review_text: metadata.review?.text || "",
          has_review_structured_data: Boolean(metadata.review?.hasReview),
          review_followup_link_count: metadata.reviewFollowupLinks?.length || 0,
          review_followup_links: metadata.reviewFollowupLinks || [],
          has_image: Boolean(metadata.imageUrl),
        },
      },
      visual_assets: metadata.imageUrl ? [{
        image_url: metadata.imageUrl,
        asset_type: "article_image",
        scene_tags: metadata.siteName ? [metadata.siteName] : [],
      }] : [],
    };
  } catch {
    return { content: fallback, ai_summary: fallback, enriched: false };
  }
}

export const __test__ = {
  chooseSummary,
  extractMetaContent,
  extractArticleMetadata,
  extractEngagementMetrics,
  extractLinkHref,
  extractMainContent,
  extractPropagationFollowupLinks,
  extractReviewFollowupLinks,
  extractReviewMetadata,
  shouldExtractReviewFollowups,
  extractSocialMetadata,
};
