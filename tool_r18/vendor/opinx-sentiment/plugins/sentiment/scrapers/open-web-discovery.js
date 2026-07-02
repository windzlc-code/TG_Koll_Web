import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem, recordSentimentSourceQualitySample } from "../sentiment-store.js";
import { gunzipSync } from "node:zlib";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const QUERY_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const OPEN_WEB_SEARCH_ENGINES = ["duckduckgo", "bing_rss", "mojeek", "wiby"];
const DIRECT_SITEMAP_PROFILES = new Set(["official", "regulatory", "consumer-protection", "press-release", "newsletter"]);
const DIRECT_SITEMAP_CANDIDATE_TYPES = new Set(["sitemap", "rss-priority-site-gap", "rss-native-entry-discovery", "source-discovery-sitemap"]);
const DIRECT_SITEMAP_SOURCE_TIERS = new Set(["official", "regulatory", "official-consumer-protection", "press-release-wire"]);
const DIRECT_SITEMAP_MAX_INDEX_DEPTH = 2;
const DIRECT_FEED_PROFILES = new Set(["official", "regulatory", "consumer-protection", "press-release", "newsletter"]);
const DIRECT_FEED_SOURCE_TIERS = new Set(["official", "regulatory", "official-consumer-protection", "press-release-wire"]);
const DIRECT_OPENSEARCH_PROFILES = new Set(["official", "regulatory", "consumer-protection", "press-release", "newsletter", "site-search-or-topic"]);
const DIRECT_OPENSEARCH_SOURCE_TIERS = new Set(["official", "regulatory", "official-consumer-protection", "press-release-wire"]);
const DIRECT_WORDPRESS_REST_PROFILES = new Set(["official", "press-release", "newsletter", "blog"]);
const DIRECT_WORDPRESS_REST_SOURCE_TIERS = new Set(["official", "press-release-wire", "media", "blog", "independent-publishing"]);
const DIRECT_WORDPRESS_REST_CANDIDATE_TYPES = new Set(["wordpress-rest", "rss-priority-site-gap", "source-discovery-rest", "source-discovery-wordpress-rest"]);
const DIRECT_BLOGGER_FEED_CANDIDATE_TYPES = new Set(["blogger-feed", "blogspot-feed", "source-discovery-blogger-feed"]);
const DIRECT_DISCOURSE_SEARCH_CANDIDATE_TYPES = new Set(["discourse-search", "discourse-forum", "community-forum", "source-discovery-discourse"]);
const DIRECT_MEDIAWIKI_SEARCH_CANDIDATE_TYPES = new Set(["mediawiki-search", "wiki-search", "fandom-search", "source-discovery-mediawiki"]);
const DIRECT_URL_EXCLUDED_HOST_PATTERNS = [
  /(?:^|\.)google\./i,
  /(?:^|\.)bing\.com$/i,
  /(?:^|\.)duckduckgo\.com$/i,
  /(?:^|\.)baidu\.com$/i,
  /(?:^|\.)sogou\.com$/i,
  /(?:^|\.)so\.com$/i,
  /(?:^|\.)yandex\./i,
  /(?:^|\.)facebook\.com$/i,
  /(?:^|\.)instagram\.com$/i,
  /(?:^|\.)threads\.net$/i,
  /(?:^|\.)x\.com$/i,
  /(?:^|\.)twitter\.com$/i,
  /(?:^|\.)reddit\.com$/i,
  /(?:^|\.)dcard\.tw$/i,
  /(?:^|\.)ptt\.cc$/i,
  /(?:^|\.)youtube\.com$/i,
  /(?:^|\.)youtu\.be$/i,
  /(?:^|\.)bilibili\.com$/i,
  /(?:^|\.)tiktok\.com$/i,
  /(?:^|\.)douyin\.com$/i,
];

export const OPEN_WEB_DISCOVERY_TARGETS = [
  { profile: "official", domain: "gov", querySuffix: "official statement OR warning OR notice OR response" },
  { profile: "official", domain: "org", querySuffix: "statement OR response OR notice OR report" },
  { profile: "regulatory", domain: "consumer.ftc.gov", querySuffix: "scam OR refund OR complaint OR alert", sourceWeightTier: "regulatory-alert" },
  { profile: "regulatory", domain: "reportfraud.ftc.gov", querySuffix: "fraud OR scam OR complaint", sourceWeightTier: "regulatory-alert" },
  { profile: "regulatory", domain: "cpsc.gov", querySuffix: "recall OR safety alert OR warning", sourceWeightTier: "regulatory-alert" },
  { profile: "regulatory", domain: "ec.europa.eu/safety-gate-alerts", querySuffix: "recall OR dangerous product OR safety alert", sourceWeightTier: "regulatory-alert" },
  { profile: "regulatory", domain: "gov.uk/product-safety-alerts-reports-recalls", querySuffix: "recall OR product safety OR alert", sourceWeightTier: "regulatory-alert" },
  { profile: "consumer-protection", domain: "cpc.ey.gov.tw", querySuffix: "消費 OR 爭議 OR 投訴 OR 退款", sourceWeightTier: "official-consumer-protection" },
  { profile: "consumer-protection", domain: "consumer.org.hk", querySuffix: "complaint OR alert OR consumer", sourceWeightTier: "official-consumer-protection" },
  { profile: "consumer-protection", domain: "case.org.sg", querySuffix: "complaint OR consumer OR dispute", sourceWeightTier: "consumer-advocacy" },
  { profile: "consumer-complaint", domain: "complaintsboard.com", querySuffix: "complaint OR refund OR scam" },
  { profile: "consumer-complaint", domain: "trustpilot.com", querySuffix: "review OR complaint" },
  { profile: "consumer-complaint", domain: "bbb.org", querySuffix: "complaint OR review OR customer" },
  { profile: "consumer-complaint", domain: "pissedconsumer.com", querySuffix: "complaint OR refund OR customer service" },
  { profile: "review", domain: "consumeraffairs.com", querySuffix: "review OR complaint OR rating" },
  { profile: "consumer-complaint", domain: "sitejabber.com", querySuffix: "review OR complaint" },
  { profile: "review", domain: "reviews.io/company-reviews", querySuffix: "review OR rating OR complaint" },
  { profile: "review", domain: "yelp.com/biz", querySuffix: "review OR complaint OR customer service" },
  { profile: "review", domain: "tripadvisor.com", querySuffix: "review OR complaint OR experience" },
  { profile: "review", domain: "glassdoor.com/Reviews", querySuffix: "review OR complaint OR culture OR layoffs" },
  { profile: "review", domain: "indeed.com/cmp", querySuffix: "review OR complaint OR employee" },
  { profile: "review", domain: "mouthshut.com/review", querySuffix: "review OR complaint OR refund" },
  { profile: "review", domain: "hellopeter.com/reviews", querySuffix: "review OR complaint OR customer service" },
  { profile: "b2b-review", domain: "g2.com/products", querySuffix: "review OR rating OR alternatives" },
  { profile: "b2b-review", domain: "capterra.com", querySuffix: "review OR rating OR software" },
  { profile: "b2b-review", domain: "trustradius.com/products", querySuffix: "review OR rating OR pros cons" },
  { profile: "b2b-review", domain: "getapp.com", querySuffix: "review OR rating OR software" },
  { profile: "b2b-review", domain: "producthunt.com/products", querySuffix: "review OR launch OR alternatives OR discussion" },
  { profile: "app-marketplace", domain: "apps.apple.com", querySuffix: "reviews OR rating OR app" },
  { profile: "app-marketplace", domain: "play.google.com/store/apps", querySuffix: "reviews OR rating OR Android" },
  { profile: "app-marketplace", domain: "chromewebstore.google.com/detail", querySuffix: "reviews OR extension OR rating" },
  { profile: "marketplace-review", domain: "amazon.com", querySuffix: "review OR rating OR complaint" },
  { profile: "marketplace-review", domain: "walmart.com", querySuffix: "review OR rating OR complaint" },
  { profile: "marketplace-review", domain: "rakuten.co.jp", querySuffix: "レビュー OR 評価 OR 苦情" },
  { profile: "marketplace-review", domain: "shopee.tw", querySuffix: "評價 OR 評分 OR 投訴" },
  { profile: "marketplace-review", domain: "steamcommunity.com/app", querySuffix: "review OR negative OR complaint OR refund" },
  { profile: "discussion", domain: "reddit.com", querySuffix: "complaint OR review OR boycott" },
  { profile: "discussion", domain: "ptt.cc/bbs", querySuffix: "爆料 OR 投訴 OR 避雷 OR 炎上" },
  { profile: "discussion", domain: "dcard.tw/f", querySuffix: "心得 OR 投訴 OR 避雷 OR 爆料" },
  { profile: "discussion", domain: "lihkg.com/thread", querySuffix: "投訴 OR 爆料 OR 苦主 OR 炎上" },
  { profile: "discussion", domain: "mobile01.com/topicdetail.php", querySuffix: "心得 OR 投訴 OR 評價 OR 災情" },
  { profile: "discussion", domain: "medium.com", querySuffix: "review OR incident OR statement" },
  { profile: "newsletter", domain: "substack.com", querySuffix: "incident OR review OR analysis OR statement" },
  { profile: "newsletter", domain: "wordpress.com", querySuffix: "review OR complaint OR statement OR incident" },
  { profile: "press-release", domain: "prnewswire.com/news-releases", querySuffix: "statement OR announces OR investigation OR incident OR response", sourceWeightTier: "press-release-wire" },
  { profile: "press-release", domain: "globenewswire.com/news-release", querySuffix: "announces OR statement OR investor OR incident OR response", sourceWeightTier: "press-release-wire" },
  { profile: "discussion", domain: "news.ycombinator.com", querySuffix: "discussion OR incident OR review" },
  { profile: "discussion", domain: "quora.com", querySuffix: "review OR complaint OR experience" },
  { profile: "knowledge", domain: "zhihu.com", querySuffix: "如何看待 OR 投訴 OR 投诉 OR 爆料 OR 評價" },
  { profile: "social-public", domain: "weibo.com", querySuffix: "投訴 OR 投诉 OR 爆料 OR 回應 OR 回应" },
  { profile: "social-public", domain: "m.weibo.cn", querySuffix: "投訴 OR 投诉 OR 爆料 OR 回應 OR 回应" },
  { profile: "social-public", domain: "xiaohongshu.com/explore", querySuffix: "避雷 OR 投訴 OR 投诉 OR 評價 OR 體驗" },
  { profile: "social-public", domain: "xiaohongshu.com/discovery/item", querySuffix: "避雷 OR 投訴 OR 投诉 OR 評價 OR 體驗" },
  { profile: "social-public", domain: "m.xiaohongshu.com/discovery/item", querySuffix: "避雷 OR 投訴 OR 投诉 OR 評價 OR 體驗" },
  { profile: "social-public", domain: "x.com", querySuffix: "complaint OR boycott OR scam OR statement OR refund" },
  { profile: "social-public", domain: "twitter.com", querySuffix: "complaint OR boycott OR scam OR statement OR refund" },
  { profile: "social-public", domain: "threads.net", querySuffix: "complaint OR review OR boycott OR statement" },
  { profile: "social-public", domain: "instagram.com/p", querySuffix: "complaint OR review OR boycott OR statement" },
  { profile: "social-public", domain: "facebook.com", querySuffix: "review OR complaint OR statement OR boycott" },
  { profile: "social-public", domain: "linkedin.com/posts", querySuffix: "incident OR statement OR complaint OR review" },
  { profile: "social-public", domain: "t.me/s", querySuffix: "scam OR complaint OR refund OR statement" },
  { profile: "video", domain: "youtube.com", querySuffix: "review OR complaint OR scam" },
  { profile: "short-video", domain: "tiktok.com", querySuffix: "review OR complaint OR scam OR boycott" },
  { profile: "short-video", domain: "douyin.com/video", querySuffix: "避雷 OR 投訴 OR 投诉 OR 爆料 OR 詐騙" },
  { profile: "video", domain: "bilibili.com/video", querySuffix: "避雷 OR 投訴 OR 投诉 OR 評測 OR 爆料" },
  { profile: "video", domain: "bilibili.com/read", querySuffix: "避雷 OR 投訴 OR 投诉 OR 評測 OR 爆料" },
  { profile: "developer", domain: "github.com", querySuffix: "issue OR bug OR security" },
  { profile: "developer", domain: "gitlab.com", querySuffix: "issue OR bug OR security" },
  { profile: "developer", domain: "stackoverflow.com/questions", querySuffix: "issue OR error OR bug" },
];
const PROFILE_QUERY_SUFFIXES = new Map([
  ["official", "official statement OR response OR notice"],
  ["regulatory", "warning OR recall OR enforcement OR investigation"],
  ["consumer-protection", "complaint OR refund OR dispute OR alert"],
  ["consumer-complaint", "complaint OR refund OR scam OR fraud"],
  ["review", "review OR complaint OR rating"],
  ["b2b-review", "review OR rating OR alternatives OR pros cons"],
  ["app-marketplace", "review OR rating OR app OR extension"],
  ["marketplace-review", "review OR rating OR refund OR delivery"],
  ["discussion", "discussion OR complaint OR boycott"],
  ["knowledge", "experience OR complaint OR review OR 如何看待"],
  ["social-public", "complaint OR review OR boycott OR statement"],
  ["short-video", "review OR complaint OR scam OR boycott"],
  ["newsletter", "incident OR review OR analysis OR statement"],
  ["press-release", "statement OR announces OR response OR investor OR incident"],
  ["video", "review OR complaint OR scam"],
  ["developer", "issue OR bug OR security OR outage"],
  ["open-web", "complaint OR review OR statement"],
]);
const PROFILE_SOURCE_TIERS = new Map([
  ["official", "official"],
  ["regulatory", "regulatory"],
  ["consumer-protection", "official-consumer-protection"],
  ["consumer-complaint", "complaint-board"],
  ["review", "review-platform"],
  ["b2b-review", "b2b-review-platform"],
  ["app-marketplace", "app-marketplace"],
  ["marketplace-review", "marketplace-review"],
  ["discussion", "community-discussion"],
  ["knowledge", "knowledge-community"],
  ["social-public", "public-social-index"],
  ["short-video", "short-video-platform"],
  ["newsletter", "independent-publishing"],
  ["press-release", "press-release-wire"],
  ["video", "video-platform"],
  ["developer", "product-community"],
]);
const PROFILE_INTENT_TERMS = new Map([
  ["official", ["official", "statement", "response", "notice", "公告", "聲明", "声明", "回應", "回应"]],
  ["regulatory", ["warning", "recall", "enforcement", "investigation", "safety", "alert", "通報", "召回", "警示", "調查", "调查", "裁罰", "处罚"]],
  ["consumer-protection", ["consumer", "complaint", "refund", "dispute", "alert", "消費", "消保", "投訴", "投诉", "爭議", "争议", "退款", "警示"]],
  ["consumer-complaint", ["complaint", "refund", "scam", "fraud", "review", "投訴", "投诉", "客訴", "客诉", "退款", "詐騙", "诈骗", "負評", "差評"]],
  ["review", ["review", "rating", "complaint", "refund", "評價", "评价", "評論", "评论", "評分", "負評"]],
  ["b2b-review", ["review", "rating", "alternative", "pros", "cons", "software", "評價", "评分", "替代", "缺點", "优缺点"]],
  ["app-marketplace", ["review", "rating", "app", "extension", "android", "ios", "評論", "评论", "評分", "應用", "扩展"]],
  ["marketplace-review", ["review", "rating", "refund", "delivery", "return", "seller", "評價", "评价", "退貨", "退款", "物流", "賣家"]],
  ["discussion", ["discussion", "complaint", "boycott", "thread", "討論", "讨论", "爆料", "抵制", "炎上", "投訴"]],
  ["knowledge", ["experience", "complaint", "review", "question", "如何看待", "投訴", "投诉", "爆料", "評價", "评价", "避雷"]],
  ["social-public", ["complaint", "review", "boycott", "statement", "scam", "投訴", "投诉", "爆料", "避雷", "回應", "回应", "炎上", "抵制"]],
  ["short-video", ["review", "complaint", "scam", "boycott", "explained", "評測", "测评", "投訴", "投诉", "爆料", "避雷", "詐騙"]],
  ["newsletter", ["incident", "review", "analysis", "statement", "complaint", "investigation", "分析", "聲明", "声明", "調查", "调查", "投訴"]],
  ["press-release", ["press release", "news release", "announces", "statement", "response", "investor", "company", "公告", "聲明", "声明", "回應", "回应", "宣布"]],
  ["video", ["review", "complaint", "scam", "explained", "評論", "評測", "投訴", "爆料", "詐騙"]],
  ["developer", ["issue", "bug", "security", "outage", "incident", "漏洞", "故障", "資安", "安全", "問題"]],
  ["open-web", ["complaint", "review", "statement", "refund", "投訴", "評論", "聲明", "退款"]],
]);
const GENERIC_OPEN_WEB_TERMS = [
  "homepage", "home page", "login", "sign in", "privacy policy", "terms of service", "cookie policy",
  "about us", "contact us", "careers", "jobs", "press kit", "sitemap",
  "首頁", "登录", "登入", "隱私權", "隐私政策", "服務條款", "服务条款", "關於我們", "关于我们", "聯絡我們", "联系我们", "徵才",
];

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function decodeXml(text = "") {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function absoluteUrl(rawUrl = "", baseUrl = "") {
  const cleaned = String(rawUrl || "").trim();
  if (!cleaned || /^(?:javascript|mailto|tel):/i.test(cleaned)) return "";
  try {
    const url = new URL(cleaned, baseUrl || undefined);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.min(60, Math.max(1, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.min(4, Math.max(1, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function normalizeUrl(rawUrl) {
  const decoded = cleanText(rawUrl, 1200);
  try {
    const url = new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return normalizeUrl(decodeURIComponent(uddg));
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeOpenWebDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ocid",
      "cid",
      "ref",
      "ref_src",
      "source",
      "mc_cid",
      "mc_eid",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/amp\/?$/i, "").replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function openWebDedupeKey(item = {}) {
  return normalizeOpenWebDedupeUrl(item?.url || "");
}

function directOpenWebUrlTarget(rawUrl = "") {
  const normalized = normalizeOpenWebDedupeUrl(rawUrl);
  if (!/^https?:\/\//i.test(normalized)) return null;
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const path = url.pathname || "/";
    if (!host || DIRECT_URL_EXCLUDED_HOST_PATTERNS.some(pattern => pattern.test(host))) return null;
    if (isLowSignalListingUrl(normalized)) return null;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi|doc|docx|xls|xlsx|ppt|pptx)(?:$|[?#])/i.test(path)) return null;
    const profile = inferTargetProfile({ domain: host, candidateType: "evidence-pivot-direct-url" });
    return {
      url: normalized,
      domain: host,
      siteScope: host,
      profile,
      sourceWeightTier: sourceTierForProfile(profile) || "open-web-direct-url",
      querySuffix: PROFILE_QUERY_SUFFIXES.get(profile) || PROFILE_QUERY_SUFFIXES.get("open-web"),
      candidateType: "evidence-pivot-direct-url",
      discoverySource: "evidence-pivot-direct-url",
      discoveryReason: "first-pass-evidence-linked-public-page",
      directUrl: true,
    };
  } catch {
    return null;
  }
}

function normalizeDirectOpenWebUrls(directUrls = []) {
  const raw = Array.isArray(directUrls)
    ? directUrls
    : typeof directUrls === "string"
      ? directUrls.split(/[\n,，]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const target = directOpenWebUrlTarget(value);
    if (!target) continue;
    const dedupe = normalizeOpenWebDedupeUrl(target.url);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(target);
    if (out.length >= 40) break;
  }
  return out;
}

function mergeOpenWebTargetText(...values) {
  const out = [];
  for (const value of values) {
    for (const part of String(value || "").split(/\s*\|\s*|\s*,\s*/)) {
      const cleaned = cleanText(part, 220);
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
  }
  return out.slice(0, 6).join(" | ");
}

function mergeOpenWebTargetTerms(...values) {
  const out = [];
  for (const value of values) {
    for (const part of String(value || "").split(/\s+OR\s+/i)) {
      const cleaned = cleanText(part, 120);
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
  }
  return out.slice(0, 12).join(" OR ");
}

function mergeOpenWebSuggestedSources(...lists) {
  const out = [];
  for (const list of lists) {
    const values = Array.isArray(list) ? list : [];
    for (const value of values) {
      const cleaned = cleanText(value, 120);
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
  }
  return out.slice(0, 12);
}

function normalizeOpenWebKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function openWebKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeOpenWebKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function openWebValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeOpenWebKeywordText(value);
  return openWebKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeOpenWebKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function openWebValueMatchesTerm(value = "", term = "") {
  const raw = cleanText(term, 180).toLowerCase();
  const compactNeedle = normalizeOpenWebKeywordText(raw);
  if (raw.length < 2 && compactNeedle.length < 2) return false;
  const lower = String(value || "").toLowerCase();
  const compact = normalizeOpenWebKeywordText(value);
  return (
    (raw.length >= 2 && lower.includes(raw))
    || (compactNeedle.length >= 2 && compact.includes(compactNeedle))
  );
}

function openWebKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  if (!openWebKeywordNeedles(keyword).length) return "";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["discovery_target", metrics.discovery_target],
    ["discovery_site_scope", metrics.discovery_site_scope],
    ["discovery_query_suffix", metrics.discovery_query_suffix],
    ["discovery_intent_hits", Array.isArray(metrics.discovery_intent_hits) ? metrics.discovery_intent_hits.join(" ") : metrics.discovery_intent_hits],
    ["open_web_deep_crawl_targets", Array.isArray(metrics.open_web_deep_crawl_targets)
      ? metrics.open_web_deep_crawl_targets.map(target => `${target?.url || ""} ${target?.target_type || ""}`).join(" ")
      : ""],
  ];
  const match = fields.find(([, value]) => openWebValueMatchesKeyword(value, keyword));
  return match ? match[0] : "";
}

function openWebKeywordDiagnostics(item = {}, keyword = "") {
  return {
    open_web_matched_keyword: cleanText(keyword, 160),
    open_web_keyword_match_source: openWebKeywordMatchSource(item, keyword),
  };
}

function tagValue(block = "", tag = "") {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(decodeXml(match[1]), 1200) : "";
}

function tagValues(block = "", tag = "", limit = 12) {
  const out = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match;
  while ((match = pattern.exec(String(block || ""))) !== null) {
    const value = cleanText(decodeXml(match[1]), 1200);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function xmlAttributeValues(block = "", tag = "", attr = "", limit = 12) {
  const out = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  let match;
  while ((match = pattern.exec(String(block || ""))) !== null) {
    const attrs = match[1] || "";
    const raw = (attrs.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i")) || [])[1] || "";
    const value = cleanText(decodeXml(raw), 300);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function xmlContentParts(block = "", tags = [], limit = 6) {
  const out = [];
  for (const tag of tags) {
    for (const value of tagValues(block, tag, limit)) {
      if (value && !out.includes(value)) out.push(value);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function rssCategoryTerms(block = "", limit = 8) {
  const paired = tagValues(block, "category", limit);
  const termAttrs = xmlAttributeValues(block, "category", "term", limit);
  const labelAttrs = xmlAttributeValues(block, "category", "label", limit);
  return [...new Set([...paired, ...termAttrs, ...labelAttrs].map(item => cleanText(item, 120)).filter(Boolean))].slice(0, limit);
}

function atomAuthorName(block = "") {
  const authorBlock = (String(block || "").match(/<author(?:\s[^>]*)?>[\s\S]*?<\/author>/i) || [])[0] || "";
  return tagValue(authorBlock, "name") || tagValue(block, "dc:creator") || tagValue(block, "creator") || tagValue(block, "author");
}

function normalizePublishedAt(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function inferTargetProfile({ domain = "", profile = "", candidateType = "", reasons = [] } = {}) {
  const lowerDomain = String(domain || "").toLowerCase();
  const raw = `${profile} ${candidateType} ${(Array.isArray(reasons) ? reasons : []).join(" ")}`.toLowerCase();
  if (/\b(regulatory-alert|recall|safety|enforcement)\b/.test(raw)) return "regulatory";
  if (/consumer-protection|consumer protection|消保|消費|consumer council/.test(raw) || /consumer\.ftc\.gov|reportfraud\.ftc\.gov|cpc\.ey\.gov\.tw|consumer\.org\.hk|case\.org\.sg/i.test(lowerDomain)) return "consumer-protection";
  if (/\b(regulatory|recall|safety|enforcement)\b/.test(raw)) return "regulatory";
  if (/\b(official|government|statement)\b/.test(raw) || lowerDomain === "gov" || lowerDomain.endsWith(".gov") || lowerDomain.includes(".gov.")) return "official";
  if (/complaint|consumer|bbb|trustpilot|sitejabber|complaintsboard|pissedconsumer/.test(raw) || /trustpilot|sitejabber|complaintsboard|pissedconsumer|bbb\.org/i.test(lowerDomain)) return "consumer-complaint";
  if (/b2b|saas|software/.test(raw) || /g2\.com|capterra|trustradius|getapp|softwareadvice/i.test(lowerDomain)) return "b2b-review";
  if (/app|extension|marketplace/.test(raw) || /apps\.apple\.com|play\.google\.com|chromewebstore\.google\.com|microsoft\.com\/store/i.test(lowerDomain)) return "app-marketplace";
  if (/marketplace|ecommerce|seller|delivery/.test(raw) || /amazon\.|walmart\.com|shopee\.|rakuten|lazada|tokopedia|aliexpress/i.test(lowerDomain)) return "marketplace-review";
  if (/review|rating|store|marketplace/.test(raw)) return "review";
  if (/knowledge|question|zhihu|知乎|wiki|mediawiki|fandom/.test(raw) || /zhihu\.com|(?:^|\.)fandom\.com|(?:^|\.)wikia\.org|(?:^|\.)wiki(?:a)?\./i.test(lowerDomain) || /(?:^|\.)wiki$/i.test(lowerDomain)) return "knowledge";
  if (/short-video|tiktok|抖音|short video/.test(raw) || /tiktok\.com|douyin\.com/i.test(lowerDomain)) return "short-video";
  if (/press-release|press release|news release|newswire|company news/.test(raw) || /prnewswire\.com|globenewswire\.com/i.test(lowerDomain)) return "press-release";
  if (
    /social|weibo|xiaohongshu|facebook|linkedin|telegram|threads|instagram|twitter|小红书|小紅書|微博/.test(raw)
    || /(?:^|\.)weibo\.(?:com|cn)|(?:^|\.)xiaohongshu\.com|(?:^|\.)facebook\.com|(?:^|\.)linkedin\.com|(?:^|\.)t\.me|(?:^|\.)x\.com|(?:^|\.)twitter\.com|(?:^|\.)threads\.net|(?:^|\.)instagram\.com/i.test(lowerDomain)
  ) return "social-public";
  if (/newsletter|substack|wordpress|blog/.test(raw) || /substack\.com|wordpress\.com|blogspot\.com/i.test(lowerDomain)) return "newsletter";
  if (/youtube|video|bilibili/.test(raw) || /youtube\.com|youtu\.be|bilibili\.com/i.test(lowerDomain)) return "video";
  if (/github|gitlab|developer|issue|bug/.test(raw) || /github\.com|gitlab\.com/i.test(lowerDomain)) return "developer";
  if (/reddit|forum|discussion|community|medium/.test(raw) || /reddit\.com|medium\.com|news\.ycombinator\.com/i.test(lowerDomain)) return "discussion";
  return cleanText(profile || "open-web", 80);
}

function sourceTierForProfile(profile = "") {
  return PROFILE_SOURCE_TIERS.get(String(profile || "").toLowerCase()) || "";
}

function querySuffixForTarget(item = {}, inferredProfile = "open-web") {
  const configured = cleanText(item.querySuffix || item.query_suffix || "", 180);
  if (configured) return configured;
  const keywordHints = Array.isArray(item.keywords_checked)
    ? item.keywords_checked
    : Array.isArray(item.keywords)
      ? item.keywords
      : Array.isArray(item.example_titles)
        ? item.example_titles
        : [];
  const hintSuffix = keywordHints.map(value => cleanText(value, 60)).filter(Boolean).slice(0, 3).join(" OR ");
  if (hintSuffix) return hintSuffix;
  return PROFILE_QUERY_SUFFIXES.get(String(inferredProfile || "").toLowerCase()) || PROFILE_QUERY_SUFFIXES.get("open-web");
}

function isLowSignalListingUrl(url = "") {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (/[?&](q|query|keyword|search|s)=/i.test(parsed.search)) return true;
    if (/\/(?:search|tag|tags|category|categories|archive|archives|topics?|hashtags?|keywords?)(?:[/.?]|$)/i.test(path)) return true;
    if (/\/(?:author|authors|profile|profiles|user|users|member|members|people|person|channel|channels|creator|creators)(?:[/.?]|$)/i.test(path)) return true;
    if (/\/(?:login|signin|sign-in|signup|sign-up|register|privacy|terms|terms-of-service|cookie|cookies|about|contact|careers|jobs|help|support|cart|checkout)(?:[/.?]|$)/i.test(path)) return true;
    if (/\/(?:page|p)\/\d+\/?$/i.test(path) && !/(?:\/posts?\/|\/articles?\/|\/review\/|\/reviews\/|\/question\/|\/answers?\/|\/thread\/|\/video\/)/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function termHits(text = "", terms = []) {
  return terms.filter(term => term && openWebValueMatchesTerm(text, term));
}

function profilePrecisionScore({ profile = "open-web", sourceWeightTier = "", url = "", intentHits = [], genericHits = [] } = {}) {
  const normalizedProfile = String(profile || "open-web").toLowerCase();
  const tier = String(sourceWeightTier || "").toLowerCase();
  const lowerUrl = String(url || "").toLowerCase();
  const reasons = [];
  let score = 45;
  if (intentHits.length) {
    score += Math.min(24, intentHits.length * 8);
    reasons.push("profile-intent-hit");
  }
  const expectedTier = sourceTierForProfile(normalizedProfile);
  if (expectedTier && tier === expectedTier) {
    score += 18;
    reasons.push("source-tier-profile-match");
  } else if (tier && expectedTier && tier !== expectedTier) {
    score -= 28;
    reasons.push("source-tier-profile-mismatch");
  }
  const domainProfileMatch = (
    (normalizedProfile === "consumer-protection" && /(consumer|cpc\.ey\.gov|case\.org|consumer\.org\.hk|ftc\.gov)/.test(lowerUrl))
    || (normalizedProfile === "consumer-complaint" && /(complaint|trustpilot|bbb\.org|sitejabber|pissedconsumer)/.test(lowerUrl))
    || (normalizedProfile === "review" && /(review|rating|reviews\.io|consumeraffairs|mouthshut|hellopeter|yelp\.com\/biz|tripadvisor|glassdoor\.com\/reviews|indeed\.com\/cmp)/.test(lowerUrl))
    || (normalizedProfile === "b2b-review" && /(g2\.com|capterra|trustradius|getapp|softwareadvice|producthunt\.com\/products|products?|reviews?)/.test(lowerUrl))
    || (normalizedProfile === "app-marketplace" && /(apps\.apple|play\.google|chromewebstore|store\/apps|extension)/.test(lowerUrl))
    || (normalizedProfile === "marketplace-review" && /(amazon|walmart|shopee|rakuten|steamcommunity\.com\/app|review|rating|product)/.test(lowerUrl))
    || (normalizedProfile === "discussion" && /(reddit|ptt\.cc\/bbs|dcard\.tw\/f|lihkg\.com\/thread|mobile01\.com\/topicdetail|forum|discussion|news\.ycombinator|quora|thread|topicdetail)/.test(lowerUrl))
    || (normalizedProfile === "knowledge" && /(zhihu\.com\/(?:question|pin|zvideo|search)|quora\.com\/(?:[^/]+\/)?(?:answer|questions?)|questions?\/|answers?\/|\/wiki\/|(?:^|\.)fandom\.com|(?:^|\.)wikia\.org|mediawiki|如何看待)/.test(lowerUrl))
    || (normalizedProfile === "social-public" && /(weibo\.com\/(?:\d+|[^/]+\/[A-Za-z0-9]+)|m\.weibo\.cn\/(?:detail|status)\/[A-Za-z0-9_-]+|xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+|(?:x|twitter)\.com\/[^/?#]+\/status\/\d+|threads\.net\/@[^/]+\/post\/[A-Za-z0-9_-]+|instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+|facebook\.com\/(?:[^/]+\/posts|story\.php|permalink\.php|share\/)|linkedin\.com\/(?:posts\/|feed\/update\/urn:li:(?:activity|share):)|t\.me\/(?:s\/)?[^/?#]+\/\d+)/.test(lowerUrl))
    || (normalizedProfile === "short-video" && /(tiktok\.com\/@[^/]+\/video\/\d+|tiktok\.com\/t\/|douyin\.com\/video\/|\/shorts\/|\/video\/|bilibili\.com\/video\/(?:BV|av))/i.test(lowerUrl))
    || (normalizedProfile === "newsletter" && /(substack\.com\/p\/|\.substack\.com\/p\/|wordpress\.com\/\d{4}\/\d{2}\/|blogspot\.com\/\d{4}\/\d{2}\/|\/(?:posts?|articles?)\/)/.test(lowerUrl))
    || (normalizedProfile === "press-release" && /(prnewswire\.com\/news-releases|globenewswire\.com\/news-release|press-release|news-release|company-news|investor-relations)/.test(lowerUrl))
    || (normalizedProfile === "developer" && /(github|gitlab|stackoverflow|issues?|questions?)/.test(lowerUrl))
    || (normalizedProfile === "video" && /(youtube|youtu\.be|bilibili|watch|video)/.test(lowerUrl))
    || (["official", "regulatory"].includes(normalizedProfile) && /(gov|official|notice|recall|alert|safety|statement)/.test(lowerUrl))
  );
  if (domainProfileMatch) {
    score += 12;
    reasons.push("url-profile-match");
  }
  if (genericHits.length) {
    score -= 18;
    reasons.push("generic-page-signal");
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
  };
}

function scoreOpenWebDiscoveryCandidate({ title = "", content = "", url = "", keyword = "", target = {} } = {}) {
  const text = `${title} ${content} ${url}`;
  const profile = String(target.profile || "open-web").toLowerCase();
  const profileTerms = PROFILE_INTENT_TERMS.get(profile) || PROFILE_INTENT_TERMS.get("open-web");
  const keywordHit = termHits(text, [keyword]).length > 0;
  const intentHits = termHits(text, profileTerms);
  const genericHits = termHits(text, GENERIC_OPEN_WEB_TERMS);
  const trusted = ["official", "regulatory"].includes(profile);
  const precision = profilePrecisionScore({
    profile,
    sourceWeightTier: target.sourceWeightTier,
    url,
    intentHits,
    genericHits,
  });
  const requiresUrlProfile = ["knowledge", "social-public", "short-video", "newsletter"].includes(profile);
  const hasUrlProfileMatch = precision.reasons.includes("url-profile-match");
  const contentLength = cleanText(content, 5000).length;
  let relevanceScore = keywordHit ? 45 : 0;
  relevanceScore += Math.min(35, intentHits.length * 12);
  if (openWebValueMatchesKeyword(title, keyword)) relevanceScore += 12;
  if (trusted) relevanceScore += 8;
  if (contentLength >= 80) relevanceScore += 5;
  if (genericHits.length) relevanceScore -= 20;
  let qualityScore = 45;
  if (contentLength >= 80) qualityScore += 12;
  if (contentLength >= 240) qualityScore += 8;
  if (/^https?:\/\//i.test(url)) qualityScore += 8;
  if (target.sourceWeightTier) qualityScore += 8;
  if (trusted) qualityScore += 8;
  if (genericHits.length) qualityScore -= 18;
  const requiresIntent = !trusted;
  const accepted = keywordHit
    && (!requiresIntent || intentHits.length > 0)
    && relevanceScore >= (trusted ? 48 : 55)
    && qualityScore >= 35
    && precision.score >= 55
    && (!requiresUrlProfile || hasUrlProfileMatch);
  return {
    accepted,
    relevanceScore: Math.max(0, Math.min(100, Math.round(relevanceScore))),
    qualityScore: Math.max(0, Math.min(100, Math.round(qualityScore))),
    profilePrecisionScore: precision.score,
    profilePrecisionReasons: precision.reasons,
    intentHits,
    genericHits,
    reason: accepted
      ? "open-web-intent-match"
      : !keywordHit
        ? "missing-keyword"
        : requiresIntent && !intentHits.length
          ? "missing-open-web-intent"
          : precision.score < 55
            ? "low-profile-precision"
            : requiresUrlProfile && !hasUrlProfileMatch
              ? "missing-platform-url-signal"
          : genericHits.length
            ? "generic-open-web-result"
            : "low-open-web-score",
  };
}

function parseDirectOpenWebArticle(enriched = {}, keyword = "", target = {}, { since = "" } = {}) {
  const metrics = enriched.evidence?.metrics || {};
  const canonicalUrl = normalizeOpenWebDedupeUrl(metrics.canonical_url || enriched.url || target.url || "");
  const title = cleanText(enriched.title || metrics.og_title || metrics.twitter_title || `Open web article: ${keyword}`, 240);
  const content = cleanText(enriched.content || enriched.ai_summary || metrics.description || "", 5000);
  const publishedAt = normalizePublishedAt(enriched.published_at || metrics.published_time || "");
  if (since && new Date(publishedAt).getTime() < new Date(since).getTime()) return null;
  const profile = target.profile || inferTargetProfile({ domain: target.domain || "", candidateType: target.candidateType || "" });
  const score = scoreOpenWebDiscoveryCandidate({
    title,
    content,
    url: canonicalUrl || target.url,
    keyword,
    target: {
      ...target,
      profile,
      sourceWeightTier: target.sourceWeightTier || sourceTierForProfile(profile) || "open-web-direct-url",
    },
  });
  if (!score.accepted) return null;
  const textLength = Number(metrics.article_body_text_length || content.length || 0);
  const paragraphCount = Number(metrics.article_body_paragraph_count || 0);
  return {
    url: canonicalUrl || target.url,
    title,
    content,
    author: cleanText(enriched.author || metrics.author || metrics.site_name || target.domain || "Open web", 160),
    publishedAt,
    raw_html: enriched.raw_html || "",
    metrics: {
      source: "open_web_direct_url",
      source_family: "search",
      source_kind: "public_open_web_article",
      collection_mode: "evidence_pivot_direct_url",
      discovery_search_engine: "evidence_pivot_direct_url",
      discovery_target: target.domain || "",
      discovery_site_scope: target.siteScope || target.domain || "",
      discovery_profile: profile,
      discovery_query_profile: profile,
      discovery_query_suffix: target.querySuffix || "",
      discovery_source_url: target.url || "",
      discovery_candidate_type: target.candidateType || "evidence-pivot-direct-url",
      discovery_source: target.discoverySource || "evidence-pivot-direct-url",
      discovery_reason: target.discoveryReason || "first-pass-evidence-linked-public-page",
      discovery_intent_hits: score.intentHits || [],
      discovery_generic_hits: score.genericHits || [],
      open_web_direct_url: target.url || "",
      open_web_direct_url_recovery: 1,
      open_web_direct_url_host: target.domain || "",
      open_web_relevance_score: score.relevanceScore || 0,
      open_web_quality_score: score.qualityScore || 0,
      open_web_profile_precision_score: score.profilePrecisionScore || 0,
      discovery_profile_precision_reasons: score.profilePrecisionReasons || [],
      relevance_score: score.relevanceScore || 0,
      quality_score: score.qualityScore || 0,
      open_web_filter_reason: score.reason || "",
      article_body_quality_score: Number(metrics.article_body_quality_score || 0),
      article_body_text_length: textLength,
      article_body_paragraph_count: paragraphCount,
      article_body_excerpt: metrics.article_body_excerpt || content.slice(0, 500),
      canonical_url: canonicalUrl || "",
      source_weight_tier: target.sourceWeightTier || sourceTierForProfile(profile) || "open-web-direct-url",
      ...openWebDiscoveryPriorityMetrics(score),
    },
  };
}

function openWebDiscoveryPriorityBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 75) return "high";
  if (numeric >= 60) return "medium";
  return "low";
}

function openWebDiscoveryPriorityMetrics(score = {}) {
  const relevance = Number(score.relevanceScore || 0);
  const quality = Number(score.qualityScore || 0);
  const precision = Number(score.profilePrecisionScore || 0);
  const priorityScore = Math.max(0, Math.min(100, Math.round(
    relevance * 0.45
    + quality * 0.25
    + precision * 0.30
  )));
  return {
    open_web_discovery_priority_score: priorityScore,
    open_web_discovery_priority_bucket: openWebDiscoveryPriorityBucket(priorityScore),
  };
}

function matchedOpenWebTerms(text = "", terms = [], limit = 10) {
  const out = [];
  for (const term of terms) {
    const raw = cleanText(term, 120);
    if (!raw) continue;
    if (openWebValueMatchesTerm(text, raw) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function openWebEvidenceDepthBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 75) return "strong";
  if (numeric >= 45) return "usable";
  return "thin";
}

function openWebPublishedAgeDays(value = "", now = Date.now()) {
  const published = new Date(value || "").getTime();
  const current = new Date(now || Date.now()).getTime();
  if (!Number.isFinite(published) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.round((current - published) / (24 * 60 * 60 * 1000)));
}

function openWebEvidenceDepthSignals({ title = "", content = "", metrics = {}, publishedAt = "" } = {}) {
  const text = [
    title,
    content,
    metrics.article_body_excerpt,
    metrics.social_text,
    metrics.review_text,
    metrics.keywords,
    metrics.discovery_query_suffix,
    ...(Array.isArray(metrics.discovery_intent_hits) ? metrics.discovery_intent_hits : []),
  ].filter(Boolean).join(" ");
  const riskTerms = matchedOpenWebTerms(text, [
    "complaint", "refund", "dispute", "scam", "fraud", "lawsuit", "investigation", "recall", "outage", "breach", "boycott", "crisis",
    "投訴", "投诉", "退款", "爭議", "争议", "詐騙", "诈骗", "訴訟", "诉讼", "調查", "调查", "召回", "外洩", "泄露", "抵制", "危機", "危机",
  ]);
  const evidenceTerms = matchedOpenWebTerms(text, [
    "screenshot", "receipt", "invoice", "order id", "case number", "ticket", "timeline", "recording", "document", "proof", "evidence",
    "截圖", "截图", "收據", "收据", "訂單", "订单", "工單", "工单", "時間線", "时间线", "錄音", "录音", "文件", "證據", "证据",
  ]);
  const officialTerms = matchedOpenWebTerms(text, [
    "official", "statement", "response", "apology", "notice", "press release", "regulator", "support", "customer service",
    "官方", "聲明", "声明", "回應", "回应", "道歉", "公告", "監管", "监管", "客服",
  ]);
  const propagationTerms = matchedOpenWebTerms(text, [
    "viral", "spreading", "amplified", "trending", "shared", "forwarded", "reposted", "thread", "media coverage", "cross-platform",
    "擴散", "扩散", "熱議", "热议", "轉發", "转发", "串文", "媒體報導", "媒体报道", "跨平台",
  ]);
  const bodyLength = Number(metrics.article_body_text_length || 0);
  const bodyQuality = Number(metrics.article_body_quality_score || 0);
  const jsonLdTypes = Array.isArray(metrics.jsonld_types) ? metrics.jsonld_types : [];
  const deepTargets = Array.isArray(metrics.open_web_deep_crawl_targets) ? metrics.open_web_deep_crawl_targets : [];
  const followupLinks = Array.isArray(metrics.propagation_followup_links) ? metrics.propagation_followup_links : [];
  const sourceTier = String(metrics.source_weight_tier || "").toLowerCase();
  const published = metrics.published_time || publishedAt;
  const ageDays = openWebPublishedAgeDays(published);
  const bodyDepth = bodyLength >= 800 || bodyQuality >= 65;
  const structured = jsonLdTypes.length > 0
    || Number(metrics.jsonld_blocks || 0) > 0
    || Boolean(metrics.has_review_structured_data)
    || Number(metrics.jsonld_review_count || 0) > 0
    || Number(metrics.jsonld_aggregate_rating_count || 0) > 0;
  const attribution = Boolean(metrics.author || metrics.social_author || metrics.review_author);
  const timely = ageDays !== null && ageDays <= 30;
  const engagement = Boolean(metrics.has_engagement_signal)
    || Number(metrics.engagement_comment_count || 0) > 0
    || Number(metrics.engagement_share_count || 0) > 0
    || Number(metrics.engagement_like_count || 0) > 0
    || Number(metrics.engagement_view_count || 0) > 0;
  const review = Boolean(metrics.has_review_structured_data)
    || Number(metrics.review_rating || 0) > 0
    || Number(metrics.review_count || 0) > 0
    || Number(metrics.review_followup_link_count || 0) > 0;
  const propagation = followupLinks.length > 0 || Number(metrics.propagation_followup_link_count || 0) > 0;
  const deepCrawl = deepTargets.length > 0 || Number(metrics.open_web_deep_crawl_target_count || 0) > 0;
  const commentThread = Number(metrics.open_web_comment_thread_candidates?.length || 0) > 0
    || deepTargets.some(target => target?.kind === "comment-thread" || target?.target_type === "deep-crawl-review-comments");
  const officialResponse = Number(metrics.open_web_official_response_candidates?.length || 0) > 0
    || deepTargets.some(target => target?.kind === "official-response");
  const originalSource = Number(metrics.open_web_original_source_candidates?.length || 0) > 0
    || deepTargets.some(target => target?.kind === "original-source");
  const trustedTier = /official|regulatory|consumer-protection|press-release|complaint-board|review-platform|public-social-index|phishing-url-intelligence|malware-url-intelligence/.test(sourceTier);
  const reasons = [];
  if (bodyDepth) reasons.push("substantial-article-body");
  if (structured) reasons.push("structured-page-metadata");
  if (attribution) reasons.push("author-attribution");
  if (timely) reasons.push("recent-published-time");
  if (engagement) reasons.push("engagement-metrics");
  if (review) reasons.push("review-structured-evidence");
  if (propagation) reasons.push("propagation-followup-links");
  if (deepCrawl) reasons.push("deep-crawl-entrypoints");
  if (commentThread) reasons.push("comment-thread-entrypoint");
  if (officialResponse) reasons.push("official-response-entrypoint");
  if (originalSource) reasons.push("original-source-entrypoint");
  if (trustedTier) reasons.push("trusted-source-tier");
  if (riskTerms.length) reasons.push("risk-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (officialTerms.length) reasons.push("official-response-language");
  if (propagationTerms.length) reasons.push("propagation-language");
  const contextDepth = bodyDepth || structured || deepCrawl || trustedTier || originalSource || commentThread || review;
  const semanticSignalCount = [
    riskTerms.length,
    evidenceTerms.length,
    officialTerms.length || officialResponse,
    propagationTerms.length || propagation,
    contextDepth,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5
    && riskTerms.length > 0
    && evidenceTerms.length > 0
    && (officialTerms.length > 0 || officialResponse)
    && (propagationTerms.length > 0 || propagation)
    && contextDepth;
  if (completeNarrative) reasons.push("open-web-complete-crisis-narrative");
  const score = Math.min(100, Math.max(0,
    (bodyDepth ? 14 : 0)
    + (structured ? 10 : 0)
    + (attribution ? 8 : 0)
    + (timely ? 8 : 0)
    + (engagement ? 8 : 0)
    + (review ? 8 : 0)
    + (propagation ? 8 : 0)
    + (deepCrawl ? 8 : 0)
    + (commentThread ? 6 : 0)
    + (officialResponse ? 8 : 0)
    + (originalSource ? 8 : 0)
    + (trustedTier ? 8 : 0)
    + (riskTerms.length ? 6 : 0)
    + (evidenceTerms.length ? 6 : 0)
    + (officialTerms.length ? 5 : 0)
    + (propagationTerms.length ? 5 : 0)
  ));
  return {
    open_web_evidence_body_depth_signal: bodyDepth ? 1 : 0,
    open_web_evidence_structured_data_signal: structured ? 1 : 0,
    open_web_evidence_attribution_signal: attribution ? 1 : 0,
    open_web_evidence_recent_signal: timely ? 1 : 0,
    open_web_evidence_engagement_signal: engagement ? 1 : 0,
    open_web_evidence_review_signal: review ? 1 : 0,
    open_web_evidence_propagation_signal: propagation ? 1 : 0,
    open_web_evidence_deep_crawl_signal: deepCrawl ? 1 : 0,
    open_web_evidence_comment_thread_signal: commentThread ? 1 : 0,
    open_web_evidence_official_response_signal: officialResponse ? 1 : 0,
    open_web_evidence_original_source_signal: originalSource ? 1 : 0,
    open_web_evidence_trusted_tier_signal: trustedTier ? 1 : 0,
    open_web_evidence_risk_language_signal: riskTerms.length ? 1 : 0,
    open_web_evidence_proof_language_signal: evidenceTerms.length ? 1 : 0,
    open_web_evidence_official_language_signal: officialTerms.length ? 1 : 0,
    open_web_evidence_propagation_language_signal: propagationTerms.length ? 1 : 0,
    open_web_evidence_published_age_days: ageDays,
    open_web_evidence_risk_terms: riskTerms,
    open_web_evidence_proof_terms: evidenceTerms,
    open_web_evidence_official_terms: officialTerms,
    open_web_evidence_propagation_terms: propagationTerms,
    open_web_evidence_semantic_signal_count: semanticSignalCount,
    open_web_evidence_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    open_web_evidence_depth_score: score,
    open_web_evidence_depth_bucket: openWebEvidenceDepthBucket(score),
    open_web_evidence_depth_signal_count: reasons.length,
    open_web_evidence_depth_reasons: reasons,
  };
}

function openWebLinkKind(url = "", label = "") {
  const text = `${url} ${label}`.toLowerCase();
  if (/(?:x|twitter)\.com\/[^/?#]+\/status\/\d+|threads\.net\/@[^/]+\/post\/[A-Za-z0-9_-]+|linkedin\.com\/(?:posts\/|feed\/update\/urn:li:(?:activity|share):)|t\.me\/(?:s\/)?[^/?#]+\/\d+|m\.weibo\.cn\/(?:detail|status)\/[A-Za-z0-9_-]+|weibo\.com\/(?:\d+|[^/]+\/[A-Za-z0-9]+)|xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+|instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+|facebook\.com\/(?:[^/]+\/posts|story\.php|permalink\.php|share\/)/i.test(text)) return "";
  if (/\/(?:rss|atom|opml)(?:\.xml|\.json|\/|$)|\/feed(?:\.xml|\.json|\/?$)|\/index\.json\b|feedburner|rss|atom|opml|json feed|訂閱|订阅/.test(text)) return "rss-feed";
  if (/sitemap.*\.xml|\/sitemap\.xml|sitemap/.test(text)) return "sitemap";
  if (/\/(author|authors|profile|user|users|member|members|channel|creator)\b|作者|頻道|频道|profile/.test(text)) return "author-profile";
  if (/\/(search|topic|topics|tag|tags|category|categories)\b|opensearch|site search|topic|專題|专题|話題|话题/.test(text)) return "site-search-or-topic";
  if (/comment|comments|reply|replies|discussion|forum|qa|questions|answers|留言|評論|评论|回覆|回复|討論|讨论/.test(text)) return "comment-thread";
  if (/official|statement|response|notice|公告|聲明|声明|回應|回应/.test(text)) return "official-response";
  if (/follow-?up|timeline|update|latest|more|next|延伸|後續|后续|更多|下一頁|下一页/.test(text)) return "article-followup";
  return "";
}

function openWebPlatformRelationKind(url = "", label = "") {
  const text = `${url} ${label}`.toLowerCase();
  if (/(?:^|\/)@[\w.-]+|\/(?:user|users|profile|people|in|channel|space|u|member)\b|作者|博主|頻道|频道|主页|主頁/.test(text)) return "author-profile";
  if (/\/(?:tag|tags|topic|topics|hashtag|keyword|search)\b|[#＃]|話題|话题|標籤|标签|hashtag/.test(text)) return "topic";
  if (/quote|quoted|引用|轉發|转发|轉載|转载|repost|reshare/.test(text)) return "quoted-or-repost";
  if (/original|source|via|原文|來源|来源|出處|出处/.test(text)) return "original-source";
  if (/(?:x|twitter)\.com\/[^/?#]+\/status\/\d+|threads\.net\/@[^/]+\/post\/[A-Za-z0-9_-]+|linkedin\.com\/(?:posts\/|feed\/update\/urn:li:(?:activity|share):)|t\.me\/(?:s\/)?[^/?#]+\/\d+|m\.weibo\.cn\/(?:detail|status)\/[A-Za-z0-9_-]+|weibo\.com\/(?:\d+|[^/]+\/[A-Za-z0-9]+)|xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+|instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+|facebook\.com\/(?:[^/]+\/posts|story\.php|permalink\.php|share\/)/i.test(text)) return "related-social-post";
  if (/playlist|series|合集|系列/.test(text)) return "video-series";
  if (/\/(?:video|watch|shorts|bv|av)\b|video|視頻|视频|影片/.test(text)) return "related-video";
  return "";
}

function extractOpenWebPlatformRelations(html = "", baseUrl = "", maxLinks = 16) {
  const source = String(html || "");
  const seen = new Set();
  const out = [];
  const push = (rawUrl, label = "", sourceType = "html-anchor") => {
    const url = absoluteUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) return;
    let parsed;
    let base;
    try {
      parsed = new URL(url);
      base = baseUrl ? new URL(baseUrl) : null;
    } catch {
      return;
    }
    if (base && parsed.href.replace(/#.*$/, "") === base.href.replace(/#.*$/, "")) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
    const kind = openWebPlatformRelationKind(url, label);
    if (!kind) return;
    const sameHost = base?.hostname && parsed.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    let score = sameHost ? 44 : 34;
    if (["quoted-or-repost", "original-source"].includes(kind)) score += 18;
    if (["author-profile", "related-video"].includes(kind)) score += 12;
    if (kind === "topic") score += 8;
    seen.add(url);
    out.push({
      url,
      label: cleanText(label || url, 180),
      kind,
      score: Math.max(0, Math.min(100, Math.round(score))),
      same_host: Boolean(sameHost),
      source: sourceType,
    });
  };
  const metaRegex = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRegex.exec(source)) !== null) {
    const tag = match[0];
    const property = (tag.match(/\b(?:property|name)=["']([^"']+)["']/i) || [])[1] || "";
    const content = (tag.match(/\bcontent=["']([^"']+)["']/i) || [])[1] || "";
    if (/article:author|twitter:creator|profile:username/i.test(property) && content) push(content, property, "html-meta");
  }
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(source)) !== null) {
    push(match[1] || "", cleanText(match[2] || "", 180), "html-anchor");
    if (out.length >= maxLinks) break;
  }
  return out.slice(0, Math.max(1, Math.min(50, Number(maxLinks) || 16)));
}

function parseOpenWebJsonLdNodes(html = "") {
  const source = String(html || "");
  const nodes = [];
  const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    nodes.push(value);
    if (Array.isArray(value["@graph"])) visit(value["@graph"]);
    if (Array.isArray(value.itemListElement)) visit(value.itemListElement);
    if (Array.isArray(value.hasPart)) visit(value.hasPart);
  };
  while ((match = scriptRegex.exec(source)) !== null) {
    try {
      visit(JSON.parse(decodeXml(match[1] || "")));
    } catch {
      // Ignore malformed structured data blocks.
    }
  }
  return nodes.slice(0, 80);
}

function openWebStructuredFollowupKind(url = "", label = "", source = "") {
  const text = `${url} ${label} ${source}`.toLowerCase();
  if (/\/(?:rss|atom|opml)(?:\.xml|\.json|\/|$)|\/feed(?:\.xml|\.json|\/?$)|feed\+json|rss|atom|opml/.test(text)) return "feed-followup";
  if (/amphtml|\/amp\/|[?&]output=amp\b|\/amp(?:[/?#]|$)|shortlink|canonical|alternate/.test(text)) return "alternate-page";
  if (/(?:x|twitter)\.com\/[^/?#]+\/status\/\d+|threads\.net\/@[^/]+\/post\/|linkedin\.com\/(?:posts\/|feed\/update\/)|t\.me\/(?:s\/)?[^/?#]+\/\d+|weibo\.com\/|m\.weibo\.cn\/|xiaohongshu\.com\/(?:explore|discovery\/item)\/|instagram\.com\/(?:p|reel)\/|facebook\.com\/(?:[^/]+\/posts|story\.php|permalink\.php|share\/)|reddit\.com\/r\/[^/]+\/comments\//i.test(text)) return "social-amplification";
  if (/correction|correctionnotice|clarification|update|timeline|follow-?up|後續|后续|更正|澄清/.test(text)) return "timeline-followup";
  if (/official|statement|response|notice|公告|聲明|声明|回應|回应/.test(text)) return "source-reference";
  if (/citation|cites|isbasedon|source|original|via|原文|來源|来源|出處|出处/.test(text)) return "source-reference";
  return "";
}

function openWebStructuredTargetType(kind = "") {
  const normalized = String(kind || "").toLowerCase();
  if (normalized === "feed-followup") return "rss-feed";
  if (normalized === "discussion") return "deep-crawl-review-comments";
  return "deep-crawl-article-outlink";
}

function openWebJsonLdUrlRecords(value, baseUrl = "", source = "jsonld") {
  const out = [];
  const seen = new Set();
  const add = (rawUrl = "", label = "", itemSource = source) => {
    const url = absoluteUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: cleanText(label || url, 180), source: itemSource });
  };
  const visit = (item, itemSource = source) => {
    if (!item) return;
    if (typeof item === "string") {
      add(item, itemSource, itemSource);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, itemSource);
      return;
    }
    if (typeof item !== "object") return;
    add(item.url || item["@id"] || item.sameAs || item.contentUrl || item.embedUrl || "", item.name || item.headline || itemSource, itemSource);
  };
  visit(value, source);
  return out;
}

function extractOpenWebStructuredFollowupLinks(html = "", baseUrl = "", maxLinks = 18) {
  const source = String(html || "");
  const seen = new Set();
  const out = [];
  const baseHost = (() => {
    try {
      return new URL(baseUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const push = (rawUrl, label = "", sourceType = "structured", forcedKind = "") => {
    const url = absoluteUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (baseUrl && normalizeOpenWebDedupeUrl(url) === normalizeOpenWebDedupeUrl(baseUrl)) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
    const kind = forcedKind || openWebStructuredFollowupKind(url, label, sourceType);
    if (!kind) return;
    const sameHost = Boolean(baseHost && parsed.hostname.replace(/^www\./, "") === baseHost);
    let score = sameHost ? 54 : 44;
    if (kind === "source-reference") score += 16;
    if (kind === "timeline-followup") score += 14;
    if (kind === "social-amplification") score += 12;
    if (kind === "feed-followup") score += 10;
    if (/jsonld/i.test(sourceType)) score += 6;
    if (/canonical|amphtml|shortlink/i.test(sourceType)) score += 4;
    seen.add(url);
    out.push({
      url,
      label: cleanText(label || url, 180),
      propagation_followup_kind: kind,
      score: Math.max(0, Math.min(100, Math.round(score))),
      source: sourceType,
      reasons: [...new Set([kind, sameHost ? "same-host" : "cross-host", sourceType].filter(Boolean))],
      same_host: sameHost,
    });
  };

  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const tag = match[0];
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const type = (tag.match(/\btype=["']([^"']+)["']/i) || [])[1] || "";
    const title = (tag.match(/\btitle=["']([^"']+)["']/i) || [])[1] || rel || type;
    if (/canonical|amphtml|shortlink|alternate/i.test(rel) && /canonical|amphtml|shortlink|rss|atom|feed\+json|json|xml/i.test(`${rel} ${type} ${href}`)) {
      push(href, title, `link-rel:${rel}`);
    }
  }

  const nodes = parseOpenWebJsonLdNodes(source);
  for (const node of nodes) {
    for (const key of ["citation", "cites", "isBasedOn", "isBasedOnUrl", "correction", "correctionNotice", "archivedAt", "sameAs", "url", "mainEntityOfPage"]) {
      for (const record of openWebJsonLdUrlRecords(node?.[key], baseUrl, `jsonld:${key}`)) {
        push(record.url, record.label || key, record.source, key === "sameAs" ? "" : "");
      }
    }
  }

  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(source)) !== null) {
    const label = cleanText(match[2] || "", 180);
    if (/official|statement|response|source|original|via|follow-?up|timeline|update|correction|聲明|声明|回應|回应|來源|来源|原文|後續|后续|更正|澄清/i.test(label)) {
      push(match[1] || "", label, "html-anchor");
    }
    if (out.length >= maxLinks) break;
  }

  return out.slice(0, Math.max(1, Math.min(40, Number(maxLinks) || 18)));
}

function extractOpenWebEntrypoints(html = "", baseUrl = "", maxLinks = 20) {
  const source = String(html || "");
  const seen = new Set();
  const out = [];
  const push = (rawUrl, label = "", sourceType = "html-link") => {
    const url = absoluteUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) return;
    let parsed;
    let base;
    try {
      parsed = new URL(url);
      base = baseUrl ? new URL(baseUrl) : null;
    } catch {
      return;
    }
    if (base && parsed.href.replace(/#.*$/, "") === base.href.replace(/#.*$/, "")) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
    if (/\/(?:login|signup|register|privacy|terms|cookie|cart|checkout)(?:\/|$)/i.test(parsed.pathname)) return;
    const kind = openWebLinkKind(url, label);
    if (!kind) return;
    const sameHost = base?.hostname && parsed.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    let score = sameHost ? 45 : 32;
    if (["rss-feed", "sitemap"].includes(kind)) score += 18;
    if (["comment-thread", "official-response"].includes(kind)) score += 16;
    if (kind === "article-followup") score += 10;
    if (sourceType === "derived-common-endpoint") score -= 12;
    seen.add(url);
    out.push({
      url,
      label: cleanText(label || url, 180),
      kind,
      score: Math.max(0, Math.min(100, Math.round(score))),
      same_host: Boolean(sameHost),
      source: sourceType,
    });
  };
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const tag = match[0];
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const type = (tag.match(/\btype=["']([^"']+)["']/i) || [])[1] || "";
    const title = (tag.match(/\btitle=["']([^"']+)["']/i) || [])[1] || "";
    if (/alternate/i.test(rel) && /(rss|atom|feed\+json|feed|json|xml)/i.test(`${type} ${href}`)) push(href, title || rel, "html-alternate");
    if (/search/i.test(rel) && /opensearch|xml/i.test(`${type} ${href}`)) push(href, title || rel, "html-search");
    if (/next|prev/i.test(rel)) push(href, title || rel, `html-${rel}`);
  }
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(source)) !== null) {
    push(match[1] || "", cleanText(match[2] || "", 180), "html-anchor");
    if (out.length >= maxLinks) break;
  }
  if (baseUrl && out.length < maxLinks) {
    try {
      const base = new URL(baseUrl);
      for (const suffix of ["/feed", "/rss", "/feed.json", "/atom.xml", "/rss.xml", "/sitemap.xml"]) {
        if (out.length >= maxLinks) break;
        push(`${base.origin}${suffix}`, suffix.replace(/^\//, ""), "derived-common-endpoint");
      }
    } catch {
      // Ignore malformed base URLs.
    }
  }
  return out.slice(0, maxLinks);
}

function openWebEntrypointTargetType(kind = "") {
  const normalized = String(kind || "").toLowerCase();
  if (normalized === "rss-feed") return "rss-feed";
  if (normalized === "sitemap") return "sitemap";
  if (normalized === "comment-thread") return "deep-crawl-review-comments";
  if (normalized === "author-profile") return "profile-recent-link";
  if (normalized === "site-search-or-topic") return "deep-crawl-outlink";
  if (["official-response", "article-followup"].includes(normalized)) return "deep-crawl-article-outlink";
  return "deep-crawl-outlink";
}

function openWebRelationTargetType(kind = "") {
  const normalized = String(kind || "").toLowerCase();
  if (normalized === "author-profile") return "profile-recent-link";
  if (normalized === "topic") return "deep-crawl-outlink";
  if (normalized === "related-social-post") return "deep-crawl-article-outlink";
  return "deep-crawl-article-outlink";
}

function openWebTargetReasons(prefix = "", item = {}) {
  return [...new Set([
    prefix,
    item.kind || "",
    item.source || "",
    item.same_host ? "same-host" : "cross-host",
  ].filter(Boolean))].slice(0, 8);
}

function openWebDeepCrawlTargets(entrypoints = [], platformRelations = [], structuredFollowups = []) {
  const seen = new Set();
  const pushTarget = (out, item = {}, sourceCandidateType = "open-web-entrypoint") => {
    const url = item.url || "";
    const dedupe = normalizeOpenWebDedupeUrl(url);
    if (!dedupe || seen.has(dedupe)) return;
    seen.add(dedupe);
    const isRelation = sourceCandidateType === "open-web-platform-relation";
    const isStructured = sourceCandidateType === "open-web-structured-followup";
    const targetType = isStructured
      ? openWebStructuredTargetType(item.propagation_followup_kind || item.kind || "")
      : isRelation
        ? openWebRelationTargetType(item.kind || "")
        : openWebEntrypointTargetType(item.kind || "");
    out.push({
      url,
      label: item.label || url,
      kind: item.kind || item.propagation_followup_kind || "",
      target_type: targetType,
      source_candidate_type: sourceCandidateType,
      score: Math.max(0, Math.min(100, Math.round(Number(item.score || 0)))),
      priority_reasons: openWebTargetReasons(
        isStructured ? "open-web-structured-followup" : isRelation ? "open-web-platform-relation" : "open-web-entrypoint",
        {
          ...item,
          kind: item.kind || item.propagation_followup_kind || "",
        },
      ),
      same_host: Boolean(item.same_host),
      source: item.source || "",
      ...(isStructured ? { propagation_followup_kind: item.propagation_followup_kind || item.kind || "" } : {}),
    });
  };
  const out = [];
  const orderedEntrypoints = [...entrypoints].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const orderedRelations = [...platformRelations].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const orderedStructured = [...structuredFollowups].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  for (const item of orderedEntrypoints) pushTarget(out, item, "open-web-entrypoint");
  for (const item of orderedRelations) pushTarget(out, item, "open-web-platform-relation");
  for (const item of orderedStructured) pushTarget(out, item, "open-web-structured-followup");
  return out.slice(0, 24);
}

function openWebEntrypointMetrics(html = "", baseUrl = "") {
  const entrypoints = extractOpenWebEntrypoints(html, baseUrl);
  const platformRelations = extractOpenWebPlatformRelations(html, baseUrl);
  const structuredFollowups = extractOpenWebStructuredFollowupLinks(html, baseUrl);
  const byKind = (kind) => entrypoints.filter(item => item.kind === kind);
  const relationsByKind = (kind) => platformRelations.filter(item => item.kind === kind);
  const followupsByKind = (kind) => structuredFollowups.filter(item => item.propagation_followup_kind === kind);
  const deepCrawlTargets = openWebDeepCrawlTargets(entrypoints, platformRelations, structuredFollowups);
  return {
    open_web_entrypoint_count: entrypoints.length,
    open_web_entrypoints: entrypoints,
    open_web_platform_relation_count: platformRelations.length,
    open_web_platform_relations: platformRelations,
    structured_followup_link_count: structuredFollowups.length,
    structured_followup_links: structuredFollowups,
    open_web_deep_crawl_target_count: deepCrawlTargets.length,
    open_web_deep_crawl_targets: deepCrawlTargets,
    open_web_author_relation_candidates: relationsByKind("author-profile").slice(0, 8),
    open_web_topic_relation_candidates: relationsByKind("topic").slice(0, 8),
    open_web_quote_relation_candidates: relationsByKind("quoted-or-repost").slice(0, 8),
    open_web_original_source_candidates: relationsByKind("original-source").slice(0, 8),
    open_web_related_social_post_candidates: relationsByKind("related-social-post").slice(0, 8),
    open_web_related_video_candidates: relationsByKind("related-video").slice(0, 8),
    deep_crawl_feed_candidates: byKind("rss-feed").slice(0, 8),
    deep_crawl_feed_candidate_count: byKind("rss-feed").length,
    deep_crawl_sitemap_candidates: byKind("sitemap").slice(0, 8),
    deep_crawl_sitemap_candidate_count: byKind("sitemap").length,
    open_web_author_profile_candidates: byKind("author-profile").slice(0, 8),
    open_web_topic_candidates: byKind("site-search-or-topic").slice(0, 8),
    open_web_comment_thread_candidates: byKind("comment-thread").slice(0, 8),
    open_web_official_response_candidates: byKind("official-response").slice(0, 8),
    open_web_followup_candidates: byKind("article-followup").slice(0, 8),
    open_web_structured_source_reference_candidates: followupsByKind("source-reference").slice(0, 8),
    open_web_structured_timeline_followup_candidates: followupsByKind("timeline-followup").slice(0, 8),
    open_web_structured_social_amplification_candidates: followupsByKind("social-amplification").slice(0, 8),
    open_web_structured_alternate_page_candidates: followupsByKind("alternate-page").slice(0, 8),
  };
}

function normalizeTargets(targets = OPEN_WEB_DISCOVERY_TARGETS) {
  const raw = Array.isArray(targets) && targets.length ? targets : OPEN_WEB_DISCOVERY_TARGETS;
  const seen = new Set();
  const byScope = new Map();
  const out = [];
  for (const target of raw) {
    const item = typeof target === "string" ? { domain: target } : target || {};
    const scope = cleanText(
      item.site_scope || item.siteScope || item.domain || item.host || item.site || item.url || "",
      300,
    ).replace(/^https?:\/\//i, "").replace(/[?#].*$/g, "").replace(/\/+$/g, "");
    const domain = scope.replace(/\/.*$/g, "");
    const scopeKey = scope.toLowerCase();
    if (!scope || !domain) continue;
    const inferredProfile = inferTargetProfile({
      domain,
      profile: item.profile || item.candidate_type || item.discovery_source || "",
      candidateType: item.candidate_type || "",
      reasons: item.reasons || [],
    });
    const sourceWeightTier = cleanText(item.source_weight_tier || item.sourceWeightTier || sourceTierForProfile(inferredProfile), 120);
    const directSitemapDisabled = item.direct_sitemap === false || item.directSitemap === false;
    const candidateType = cleanText(item.candidate_type || item.candidateType || "", 140);
    const directFeedDisabled = item.direct_feed_discovery === false || item.directFeedDiscovery === false;
    const directOpenSearchDisabled = item.direct_opensearch_discovery === false || item.directOpenSearchDiscovery === false;
    const directWordPressRestDisabled = item.direct_wordpress_rest === false || item.directWordPressRest === false;
    const directBloggerFeedDisabled = item.direct_blogger_feed === false || item.directBloggerFeed === false;
    const directDiscourseSearchDisabled = item.direct_discourse_search === false || item.directDiscourseSearch === false;
    const directMediaWikiSearchDisabled = item.direct_mediawiki_search === false || item.directMediaWikiSearch === false;
    const isBloggerScope = /(?:^|\.)blogspot\.com$|(?:^|\.)blogger\.com$/i.test(domain);
    const isForumScope = /(?:^|\b)(forum|forums|community|discuss|discussion|support|answers|help)\b/i.test(domain);
    const isWikiScope = /(?:^|\.)fandom\.com$|(?:^|\.)wikia\.org$|(?:^|\.)wiki(?:a)?\.|(?:^|\.)wiki$/i.test(domain) || /\bwiki\b/i.test(domain);
    const normalized = {
      domain,
      siteScope: scope,
      profile: inferredProfile,
      candidateType,
      discoverySource: cleanText(item.discovery_source || item.discoverySource || "", 140),
      discoveryReason: cleanText(item.reason || item.discovery_reason || item.discoveryReason || "", 220),
      targetKeyword: cleanText(item.keyword || item.target_keyword || item.targetKeyword || "", 180),
      sourceFamily: cleanText(item.source_family || item.sourceFamily || "", 120),
      suggestedSources: Array.isArray(item.suggested_sources)
        ? item.suggested_sources.map(source => cleanText(source, 120)).filter(Boolean).slice(0, 12)
        : Array.isArray(item.suggestedSources)
          ? item.suggestedSources.map(source => cleanText(source, 120)).filter(Boolean).slice(0, 12)
          : [],
      querySuffix: querySuffixForTarget(item, inferredProfile),
      searchTemplates: Array.isArray(item.search_templates)
        ? item.search_templates.slice(0, 4)
        : Array.isArray(item.searchTemplates)
          ? item.searchTemplates.slice(0, 4)
          : [],
      sourceUrl: cleanText(item.url || item.source_url || item.sourceUrl || "", 500),
      score: Number(item.score || 0),
      sourceWeightTier,
      directSitemap: !directSitemapDisabled && (
        item.direct_sitemap === true
        || item.directSitemap === true
        || DIRECT_SITEMAP_PROFILES.has(inferredProfile)
        || DIRECT_SITEMAP_SOURCE_TIERS.has(sourceWeightTier)
        || DIRECT_SITEMAP_CANDIDATE_TYPES.has(candidateType)
      ),
      directFeedDiscovery: !directFeedDisabled && (
        item.direct_feed_discovery === true
        || item.directFeedDiscovery === true
        || DIRECT_FEED_PROFILES.has(inferredProfile)
        || DIRECT_FEED_SOURCE_TIERS.has(sourceWeightTier)
      ),
      directOpenSearchDiscovery: !directOpenSearchDisabled && (
        item.direct_opensearch_discovery === true
        || item.directOpenSearchDiscovery === true
        || DIRECT_OPENSEARCH_PROFILES.has(inferredProfile)
        || DIRECT_OPENSEARCH_SOURCE_TIERS.has(sourceWeightTier)
      ),
      directWordPressRest: !directWordPressRestDisabled && (
        item.direct_wordpress_rest === true
        || item.directWordPressRest === true
        || DIRECT_WORDPRESS_REST_PROFILES.has(inferredProfile)
        || DIRECT_WORDPRESS_REST_SOURCE_TIERS.has(sourceWeightTier)
        || DIRECT_WORDPRESS_REST_CANDIDATE_TYPES.has(candidateType)
      ),
      directBloggerFeed: !directBloggerFeedDisabled && (
        item.direct_blogger_feed === true
        || item.directBloggerFeed === true
        || isBloggerScope
        || DIRECT_BLOGGER_FEED_CANDIDATE_TYPES.has(candidateType)
      ),
      directDiscourseSearch: !directDiscourseSearchDisabled && (
        item.direct_discourse_search === true
        || item.directDiscourseSearch === true
        || DIRECT_DISCOURSE_SEARCH_CANDIDATE_TYPES.has(candidateType)
        || (isForumScope && ["discussion", "open-web", "site-search-or-topic"].includes(inferredProfile))
      ),
      directMediaWikiSearch: !directMediaWikiSearchDisabled && (
        item.direct_mediawiki_search === true
        || item.directMediaWikiSearch === true
        || DIRECT_MEDIAWIKI_SEARCH_CANDIDATE_TYPES.has(candidateType)
        || isWikiScope
      ),
    };
    const existingIndex = byScope.get(scopeKey);
    if (existingIndex !== undefined) {
      const previous = out[existingIndex];
      const keepPreviousProfile = previous.profile && previous.profile !== "open-web";
      out[existingIndex] = {
        ...previous,
        profile: keepPreviousProfile ? previous.profile : normalized.profile,
        candidateType: mergeOpenWebTargetText(previous.candidateType, normalized.candidateType),
        discoverySource: mergeOpenWebTargetText(previous.discoverySource, normalized.discoverySource),
        discoveryReason: mergeOpenWebTargetText(previous.discoveryReason, normalized.discoveryReason),
        targetKeyword: mergeOpenWebTargetText(previous.targetKeyword, normalized.targetKeyword),
        sourceFamily: mergeOpenWebTargetText(previous.sourceFamily, normalized.sourceFamily),
        suggestedSources: mergeOpenWebSuggestedSources(previous.suggestedSources, normalized.suggestedSources),
        querySuffix: mergeOpenWebTargetTerms(previous.querySuffix, normalized.querySuffix),
        searchTemplates: [...previous.searchTemplates, ...normalized.searchTemplates].slice(0, 4),
        sourceUrl: previous.sourceUrl || normalized.sourceUrl,
        score: Math.max(Number(previous.score || 0), Number(normalized.score || 0)),
        sourceWeightTier: previous.sourceWeightTier || normalized.sourceWeightTier,
        directSitemap: previous.directSitemap || normalized.directSitemap,
        directFeedDiscovery: previous.directFeedDiscovery || normalized.directFeedDiscovery,
        directOpenSearchDiscovery: previous.directOpenSearchDiscovery || normalized.directOpenSearchDiscovery,
        directWordPressRest: previous.directWordPressRest || normalized.directWordPressRest,
        directBloggerFeed: previous.directBloggerFeed || normalized.directBloggerFeed,
        directDiscourseSearch: previous.directDiscourseSearch || normalized.directDiscourseSearch,
        directMediaWikiSearch: previous.directMediaWikiSearch || normalized.directMediaWikiSearch,
      };
      continue;
    }
    seen.add(scopeKey);
    byScope.set(scopeKey, out.length);
    out.push(normalized);
    if (out.length >= 80) break;
  }
  return out.length ? out : OPEN_WEB_DISCOVERY_TARGETS;
}

function openWebTargetAttributionMetrics(target = {}) {
  const candidateType = target.candidateType || target.candidate_type || "";
  const discoverySource = target.discoverySource || target.discovery_source || "";
  const discoveryReason = target.discoveryReason || target.discovery_reason || target.reason || "";
  const targetKeyword = target.targetKeyword || target.target_keyword || target.keyword || "";
  const sourceFamily = target.sourceFamily || target.source_family || "";
  const suggestedSources = Array.isArray(target.suggestedSources)
    ? target.suggestedSources
    : Array.isArray(target.suggested_sources)
      ? target.suggested_sources
      : [];
  return {
    ...(candidateType ? { discovery_candidate_type: candidateType } : {}),
    ...(discoverySource ? { discovery_source: discoverySource } : {}),
    ...(discoveryReason ? { discovery_reason: discoveryReason } : {}),
    ...(targetKeyword ? { discovery_target_keyword: targetKeyword } : {}),
    ...(sourceFamily ? { discovery_source_family: sourceFamily } : {}),
    ...(suggestedSources.length ? { discovery_suggested_sources: suggestedSources } : {}),
  };
}

function buildOpenWebQueries(keyword, targets = OPEN_WEB_DISCOVERY_TARGETS) {
  const term = cleanText(keyword, 160);
  if (!term) return [];
  return normalizeTargets(targets).map(target => ({
    target,
    query: [`"${term}"`, `site:${target.siteScope || target.domain}`, target.querySuffix].filter(Boolean).join(" "),
  }));
}

function normalizeOpenSearchTemplate(template = {}) {
  if (typeof template === "string") {
    return {
      template: cleanText(template, 1000),
      type: "",
    };
  }
  return {
    template: cleanText(template?.template || template?.url || "", 1000),
    type: cleanText(template?.type || "", 120).toLowerCase(),
  };
}

function openSearchTemplateUrl(template = {}, keyword = "", { page = 0, pageSize = 20 } = {}) {
  const normalized = normalizeOpenSearchTemplate(template);
  const raw = normalized.template;
  const term = cleanText(keyword, 160);
  if (!raw || !term) return "";
  const encoded = encodeURIComponent(term);
  const safePage = Math.max(0, Math.min(20, Number(page) || 0));
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const startIndex = String(safePage * safePageSize);
  const startPage = String(safePage + 1);
  const hasPagePlaceholder = /\{(?:startIndex|startPage)\??\}/i.test(raw);
  const replaced = raw
    .replace(/\{searchTerms\??\}/gi, encoded)
    .replace(/\{count\??\}/gi, String(safePageSize))
    .replace(/\{startIndex\??\}/gi, startIndex)
    .replace(/\{startPage\??\}/gi, startPage)
    .replace(/\{language\??\}/gi, "zh-TW")
    .replace(/\{inputEncoding\??\}/gi, "UTF-8")
    .replace(/\{outputEncoding\??\}/gi, "UTF-8");
  try {
    const url = new URL(replaced);
    if (safePage > 0 && !hasPagePlaceholder) {
      const pageParam = ["page", "p"].find(name => url.searchParams.has(name));
      const offsetParam = ["offset", "start", "from"].find(name => url.searchParams.has(name));
      if (offsetParam) {
        url.searchParams.set(offsetParam, startIndex);
      } else if (pageParam) {
        url.searchParams.set(pageParam, startPage);
      } else {
        url.searchParams.set("page", startPage);
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}

function openSearchNextPageUrls(html = "", baseUrl = "", currentUrl = "", limit = 2) {
  const source = String(html || "");
  const safeLimit = Math.max(1, Math.min(5, Number(limit) || 2));
  const seen = new Set();
  const out = [];
  let base = null;
  let current = null;
  try {
    base = baseUrl ? new URL(baseUrl) : null;
  } catch {
    base = null;
  }
  try {
    current = currentUrl ? new URL(currentUrl) : base;
  } catch {
    current = base;
  }
  const push = (rawUrl = "", label = "", sourceType = "html-anchor") => {
    const url = absoluteUrl(decodeXml(rawUrl || ""), baseUrl || currentUrl);
    if (!url) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const reference = current || base;
    if (reference && parsed.hostname.replace(/^www\./, "") !== reference.hostname.replace(/^www\./, "")) return;
    const normalized = parsed.href.replace(/#.*$/, "");
    const currentNormalized = reference?.href?.replace(/#.*$/, "") || "";
    if (!normalized || normalized === currentNormalized || seen.has(normalized)) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
    if (/\/(?:login|signup|register|privacy|terms|cookie|cart|checkout)(?:\/|$)/i.test(parsed.pathname)) return;
    const text = `${label} ${sourceType} ${url}`;
    if (!/next|older|more|下一[頁页]|下一|下页|下頁|更多|後一頁|后一页/i.test(text)) return;
    seen.add(normalized);
    out.push({
      url: normalized,
      label: cleanText(label || url, 160),
      source: sourceType,
    });
  };
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null && out.length < safeLimit) {
    const tag = match[0];
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const title = (tag.match(/\btitle=["']([^"']+)["']/i) || [])[1] || "";
    if (/\bnext\b/i.test(rel)) push(href, title || rel, "html-link-next");
  }
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(source)) !== null && out.length < safeLimit) {
    const attrs = match[1] || "";
    const href = (attrs.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    const rel = (attrs.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const aria = (attrs.match(/\baria-label=["']([^"']+)["']/i) || [])[1] || "";
    const label = cleanText(`${match[2] || ""} ${aria} ${rel}`, 180);
    if (/\bnext\b/i.test(rel) || /next|older|more|下一[頁页]|下一|下页|下頁|更多|後一頁|后一页/i.test(label)) {
      push(href, label, /\bnext\b/i.test(rel) ? "html-anchor-next-rel" : "html-anchor-next-label");
    }
  }
  return out.slice(0, safeLimit);
}

function openSearchResultMetrics({ target = {}, template = {}, score = {}, engine = "opensearch_direct" } = {}) {
  return {
    discovery_search_engine: engine,
    discovery_canonical_dedupe_url: "",
    discovery_target: target.domain || "",
    discovery_site_scope: target.siteScope || target.domain || "",
    discovery_profile: target.profile || "open-web",
    discovery_source_url: target.sourceUrl || "",
    discovery_score: Number(target.score || 0),
    discovery_query_profile: target.profile || "open-web",
    discovery_query_suffix: target.querySuffix || "",
    discovery_opensearch_template: normalizeOpenSearchTemplate(template).template,
    discovery_intent_hits: score.intentHits || [],
    discovery_generic_hits: score.genericHits || [],
    open_web_relevance_score: score.relevanceScore || 0,
    open_web_quality_score: score.qualityScore || 0,
    open_web_profile_precision_score: score.profilePrecisionScore || 0,
    discovery_profile_precision_reasons: score.profilePrecisionReasons || [],
    relevance_score: score.relevanceScore || 0,
    quality_score: score.qualityScore || 0,
    open_web_filter_reason: score.reason || "",
    ...openWebDiscoveryPriorityMetrics(score),
    ...openWebTargetAttributionMetrics(target),
    ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
  };
}

function openWebRejectionDiagnostic({ url = "", title = "", content = "", keyword = "", target = {}, engine = "", score = null, reason = "" } = {}) {
  const attribution = openWebTargetAttributionMetrics(target);
  return {
    url,
    title,
    content,
    keyword,
    engine,
    target: target.domain || "",
    site_scope: target.siteScope || target.domain || "",
    profile: target.profile || "open-web",
    candidate_type: attribution.discovery_candidate_type || "",
    discovery_source: attribution.discovery_source || "",
    discovery_reason: attribution.discovery_reason || "",
    target_keyword: attribution.discovery_target_keyword || "",
    source_family: attribution.discovery_source_family || "",
    suggested_sources: attribution.discovery_suggested_sources || [],
    source_weight_tier: target.sourceWeightTier || "",
    reason: reason || score?.reason || "open-web-rejected",
    relevance_score: Number(score?.relevanceScore || 0),
    quality_score: Number(score?.qualityScore || 0),
    profile_precision_score: Number(score?.profilePrecisionScore || 0),
    profile_precision_reasons: score?.profilePrecisionReasons || [],
    intent_hits: score?.intentHits || [],
    generic_hits: score?.genericHits || [],
  };
}

function recordOpenWebRejectionDiagnostics(diagnostics = []) {
  for (const item of diagnostics) {
    if (!item?.url) continue;
    recordSentimentSourceQualitySample({
      sourceKey: "openWebDiscovery",
      platform: "open_web",
      url: item.url,
      title: item.title || item.url,
      reason: item.reason || "open-web-rejected",
      relevanceScore: item.relevance_score || 0,
      qualityScore: item.quality_score || item.profile_precision_score || 0,
      accepted: false,
      metadata: {
        engine: item.engine,
        target: item.target,
        site_scope: item.site_scope,
        profile: item.profile,
        candidate_type: item.candidate_type,
        discovery_source: item.discovery_source,
        discovery_reason: item.discovery_reason,
        target_keyword: item.target_keyword,
        source_family: item.source_family,
        suggested_sources: item.suggested_sources,
        source_weight_tier: item.source_weight_tier,
        profile_precision_score: item.profile_precision_score,
        profile_precision_reasons: item.profile_precision_reasons,
        intent_hits: item.intent_hits,
        generic_hits: item.generic_hits,
      },
    });
  }
}

function countDuckDuckGoDiscoveryRawResults(html = "") {
  return [...String(html || "").matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href=/gi)].length;
}

function countBingRssDiscoveryRawResults(xml = "") {
  return [...String(xml || "").matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].length;
}

function countMojeekDiscoveryRawResults(html = "") {
  return [...String(html || "").matchAll(/<!--rs-->[\s\S]*?<li[^>]+class="[^"]*r\d+[^"]*"[\s\S]*?<!--re-->/gi)].length;
}

function countWibyDiscoveryRawResults(html = "") {
  return [...String(html || "").matchAll(/<blockquote\b[\s\S]*?<a[^>]+class=["']tlink["'][^>]+href=/gi)].length;
}

function countOpenSearchDirectRawResults(text = "") {
  const source = String(text || "");
  const rssItems = [...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].length;
  const atomEntries = [...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)].length;
  const anchors = [...source.matchAll(/<a\b[^>]*href=["'][^"']+["'][^>]*>/gi)]
    .filter(match => !/\brel=["'][^"']*\b(?:next|prev|previous)\b[^"']*["']/i.test(match[0]))
    .length;
  let jsonItems = 0;
  if (/^\s*[\[{]/.test(source)) {
    try {
      jsonItems = extractOpenSearchJsonItems(JSON.parse(source)).length;
    } catch {
      jsonItems = 0;
    }
  } else {
    jsonItems = extractOpenSearchScriptJsonItems(source).length;
  }
  return rssItems + atomEntries + anchors + jsonItems;
}

function targetSitemapCandidateUrls(target = {}) {
  const scope = String(target.siteScope || target.domain || "").replace(/^https?:\/\//i, "").replace(/[?#].*$/g, "").replace(/\/+$/g, "");
  if (!scope) return [];
  const out = [];
  const push = (url = "") => {
    const normalized = absoluteUrl(url);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };
  try {
    const parsed = new URL(`https://${scope}`);
    const origin = parsed.origin;
    push(`${origin}/sitemap.xml`);
    push(`${origin}/sitemap.xml.gz`);
    push(`${origin}/sitemap_index.xml`);
    push(`${origin}/sitemap_index.xml.gz`);
    push(`${origin}/sitemap-news.xml`);
    push(`${origin}/sitemap-news.xml.gz`);
    push(`${origin}/news-sitemap.xml`);
    push(`${origin}/news-sitemap.xml.gz`);
    push(`${origin}/post-sitemap.xml`);
    push(`${origin}/posts-sitemap.xml`);
    push(`${origin}/article-sitemap.xml`);
    push(`${origin}/articles-sitemap.xml`);
    if (parsed.pathname && parsed.pathname !== "/") {
      const path = parsed.pathname.replace(/\/+$/g, "");
      push(`${origin}${path}/sitemap.xml`);
      push(`${origin}${path}/sitemap.xml.gz`);
      push(`${origin}${path}/sitemap_index.xml`);
      push(`${origin}${path}/sitemap_index.xml.gz`);
    }
  } catch {
    return [];
  }
  return out.slice(0, 16);
}

function targetRobotsUrl(target = {}) {
  const scope = String(target.siteScope || target.domain || "").replace(/^https?:\/\//i, "").replace(/[?#].*$/g, "").replace(/\/+$/g, "");
  if (!scope) return "";
  try {
    const parsed = new URL(`https://${scope}`);
    return `${parsed.origin}/robots.txt`;
  } catch {
    return "";
  }
}

function parseRobotsSitemapUrls(text = "", baseUrl = "", limit = 30) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 30));
  const out = [];
  const source = String(text || "");
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    const url = absoluteUrl(match[1], baseUrl);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= safeLimit) break;
  }
  return out;
}

async function targetRobotsSitemapUrls(target = {}, proxyUrl = "") {
  const robotsUrl = targetRobotsUrl(target);
  if (!robotsUrl) return [];
  const res = await fetchPublicSource(robotsUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/plain,*/*;q=0.5",
      "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl).catch(() => null);
  if (!res?.ok) return [];
  return parseRobotsSitemapUrls(await res.text(), robotsUrl);
}

function parseSitemapXmlEntries(xml = "") {
  const source = String(xml || "");
  const urlBlocks = [...source.matchAll(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi)].map(match => match[0]);
  const sitemapBlocks = [...source.matchAll(/<sitemap(?:\s[^>]*)?>[\s\S]*?<\/sitemap>/gi)].map(match => match[0]);
  return {
    urls: urlBlocks.map(block => {
      const imageTitles = tagValues(block, "image:title", 6);
      const imageCaptions = tagValues(block, "image:caption", 6);
      const imageLocs = tagValues(block, "image:loc", 6);
      return {
        loc: tagValue(block, "loc"),
        lastmod: tagValue(block, "lastmod"),
        publicationDate: tagValue(block, "news:publication_date") || tagValue(block, "publication_date"),
        title: tagValue(block, "news:title") || tagValue(block, "title") || imageTitles[0] || imageCaptions[0] || "",
        publicationName: tagValue(block, "news:name"),
        newsKeywords: tagValues(block, "news:keywords", 6)
          .flatMap(value => value.split(/\s*,\s*/))
          .map(value => cleanText(value, 160))
          .filter(Boolean),
        imageTitles,
        imageCaptions,
        imageLocs,
      };
    }).filter(item => item.loc),
    sitemaps: sitemapBlocks.map(block => ({
      loc: tagValue(block, "loc"),
      lastmod: tagValue(block, "lastmod"),
    })).filter(item => item.loc),
  };
}

function sitemapLastmodTime(value = "") {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function sitemapPathDatePriority(path = "", nowMs = Date.now()) {
  const text = String(path || "").toLowerCase();
  const matches = [
    ...text.matchAll(/(?:^|[^\d])((?:20)\d{2})[\/._-](0?[1-9]|1[0-2])(?:[\/._-](0?[1-9]|[12]\d|3[01]))?/g),
    ...text.matchAll(/(?:^|[^\d])((?:20)\d{2})(0[1-9]|1[0-2])(?:([0-2]\d|3[01]))?(?:[^\d]|$)/g),
  ];
  let best = 0;
  for (const match of matches) {
    const year = Number(match[1] || 0);
    const month = Number(match[2] || 1);
    const day = Number(match[3] || 1) || 1;
    if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const dateMs = Date.UTC(year, month - 1, Math.min(day, 28));
    const ageDays = (Number(nowMs || Date.now()) - dateMs) / (24 * 60 * 60 * 1000);
    let score = 0;
    if (ageDays >= -31 && ageDays <= 45) score = 28;
    else if (ageDays > 45 && ageDays <= 120) score = 22;
    else if (ageDays > 120 && ageDays <= 370) score = 14;
    else if (ageDays > 370 && ageDays <= 740) score = 6;
    if (score > best) best = score;
  }
  if (best && /(?:^|[\/._-])(?:daily|monthly|yearly|posts?|articles?|sitemap)(?:[\/._-]|$)/i.test(text)) best += 4;
  return best;
}

function sitemapChildPriorityScore(item = {}, { parentUrl = "", target = {} } = {}) {
  const loc = normalizeUrl(item.loc || "");
  if (!loc) return { url: "", score: -Infinity, sameHost: false, lastmodTime: 0 };
  let score = 0;
  let sameHost = false;
  try {
    const child = new URL(loc);
    const parent = parentUrl ? new URL(parentUrl) : null;
    const targetScope = String(target.siteScope || target.domain || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    const childHost = child.hostname.toLowerCase().replace(/^www\./, "");
    const parentHost = parent?.hostname?.toLowerCase?.().replace(/^www\./, "") || "";
    sameHost = Boolean((parentHost && childHost === parentHost) || (targetScope && childHost === targetScope.replace(/^www\./, "")));
    if (sameHost) score += 80;
    else score -= 120;
    const path = `${child.pathname} ${child.search}`.toLowerCase();
    if (/news|article|post|story|press|release|review|blog|feed|latest|today|daily|sitemap[-_]?news/.test(path)) score += 30;
    score += sitemapPathDatePriority(path);
    if (/tag|category|author|image|video|product|static|page\/\d+|archive/.test(path)) score -= 10;
    if (/\.xml\.gz(?:$|[?#])/.test(child.pathname)) score += 4;
    if (/\b(?:202[4-9]|20[3-9]\d)\b/.test(path)) score += 6;
  } catch {
    return { url: loc, score: -Infinity, sameHost: false, lastmodTime: 0 };
  }
  const lastmodTime = sitemapLastmodTime(item.lastmod);
  if (lastmodTime) score += Math.min(30, Math.max(0, (lastmodTime - Date.UTC(2020, 0, 1)) / (365 * 24 * 60 * 60 * 1000)));
  return { url: loc, score, sameHost, lastmodTime };
}

function selectDirectSitemapChildren(sitemaps = [], { parentUrl = "", target = {}, limit = 5 } = {}) {
  const safeLimit = Math.max(1, Math.min(8, Number(limit) || 5));
  const seen = new Set();
  const candidates = (Array.isArray(sitemaps) ? sitemaps : [])
    .map((item, index) => ({
      ...item,
      index,
      ...sitemapChildPriorityScore(item, { parentUrl, target }),
    }))
    .filter(item => {
      if (!item.url || !Number.isFinite(item.score) || item.score <= -Infinity || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((a, b) => b.score - a.score || b.lastmodTime - a.lastmodTime || Number(b.sameHost) - Number(a.sameHost) || a.index - b.index);
  const sameHostCandidates = candidates.filter(item => item.sameHost);
  return (sameHostCandidates.length ? sameHostCandidates : candidates).slice(0, safeLimit);
}

function selectDirectSitemapSeedUrls(urls = [], { target = {}, parentUrl = "", limit = 12 } = {}) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 12));
  return selectDirectSitemapChildren(
    (Array.isArray(urls) ? urls : []).map(loc => ({ loc })),
    { parentUrl: parentUrl || targetRobotsUrl(target), target, limit: safeLimit },
  ).map(item => item.url || item.loc).filter(Boolean);
}

async function readSitemapResponseText(res, sitemapUrl = "") {
  const headers = res?.headers;
  const type = String(headers?.get?.("content-type") || "");
  const encoding = String(headers?.get?.("content-encoding") || "");
  const urlLooksGzip = /\.gz(?:$|[?#])/i.test(String(sitemapUrl || ""));
  const headerLooksGzip = /gzip|application\/x-gzip|application\/gzip/i.test(`${type} ${encoding}`);
  if (!urlLooksGzip && !headerLooksGzip) return res.text();
  const bytes = new Uint8Array(await res.arrayBuffer());
  const hasGzipMagic = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (hasGzipMagic || urlLooksGzip || headerLooksGzip) {
    try {
      return gunzipSync(bytes).toString("utf8");
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function sitemapTitleFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname)
      .replace(/\.(?:html?|aspx?|php)$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleanText(slug || parsed.hostname, 260);
  } catch {
    return cleanText(url, 260);
  }
}

function parseSitemapDiscoveryResults(xml = "", keyword = "", { target = {}, sitemapUrl = "", limit = 10, diagnostics = null } = {}) {
  const entries = parseSitemapXmlEntries(xml).urls;
  const results = [];
  for (const entry of entries) {
    const url = normalizeUrl(entry.loc);
    const title = cleanText(entry.title || sitemapTitleFromUrl(url), 300);
    const content = cleanText([
      entry.publicationName,
      ...(Array.isArray(entry.newsKeywords) ? entry.newsKeywords : []),
      ...(Array.isArray(entry.imageTitles) ? entry.imageTitles : []),
      ...(Array.isArray(entry.imageCaptions) ? entry.imageCaptions : []),
      entry.publicationDate ? `Published ${entry.publicationDate}` : "",
      entry.lastmod ? `Last modified ${entry.lastmod}` : "",
      url,
    ].filter(Boolean).join(" "), 1200);
    if (!url || !title || !openWebValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (isLowSignalListingUrl(url)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "sitemap_direct", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title, content, url, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "sitemap_direct", score }));
      continue;
    }
    results.push({
      url,
      title,
      content,
      author: target.domain || "Sitemap",
      publishedAt: normalizePublishedAt(entry.publicationDate || entry.lastmod),
      metrics: {
        discovery_search_engine: "sitemap_direct",
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(url),
        discovery_target: target.domain || "",
        discovery_site_scope: target.siteScope || target.domain || "",
        discovery_profile: target.profile || "open-web",
        discovery_source_url: target.sourceUrl || "",
        discovery_score: Number(target.score || 0),
        discovery_query_profile: target.profile || "open-web",
        discovery_query_suffix: target.querySuffix || "",
        discovery_sitemap_url: sitemapUrl,
        discovery_sitemap_lastmod: entry.lastmod || "",
        discovery_sitemap_publication_date: entry.publicationDate || "",
        discovery_sitemap_publication_name: entry.publicationName || "",
        discovery_sitemap_news_keywords: Array.isArray(entry.newsKeywords) ? entry.newsKeywords.slice(0, 12) : [],
        discovery_sitemap_image_titles: Array.isArray(entry.imageTitles) ? entry.imageTitles.slice(0, 6) : [],
        discovery_sitemap_image_captions: Array.isArray(entry.imageCaptions) ? entry.imageCaptions.slice(0, 6) : [],
        discovery_sitemap_image_urls: Array.isArray(entry.imageLocs) ? entry.imageLocs.slice(0, 6) : [],
        discovery_intent_hits: score.intentHits,
        discovery_generic_hits: score.genericHits,
        open_web_relevance_score: score.relevanceScore,
        open_web_quality_score: score.qualityScore,
        open_web_profile_precision_score: score.profilePrecisionScore,
        discovery_profile_precision_reasons: score.profilePrecisionReasons,
        relevance_score: score.relevanceScore,
        quality_score: score.qualityScore,
        open_web_filter_reason: score.reason,
        ...openWebDiscoveryPriorityMetrics(score),
        ...openWebTargetAttributionMetrics(target),
        ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function sitemapEntryMetadataText(entry = {}, url = "") {
  return cleanText([
    entry.title,
    entry.publicationName,
    ...(Array.isArray(entry.newsKeywords) ? entry.newsKeywords : []),
    ...(Array.isArray(entry.imageTitles) ? entry.imageTitles : []),
    ...(Array.isArray(entry.imageCaptions) ? entry.imageCaptions : []),
    entry.publicationDate ? `Published ${entry.publicationDate}` : "",
    entry.lastmod ? `Last modified ${entry.lastmod}` : "",
    url,
  ].filter(Boolean).join(" "), 1600);
}

function sitemapBodyProbePriority(entry = {}, { target = {}, sitemapUrl = "" } = {}) {
  const url = normalizeUrl(entry.loc || "");
  if (!url || isLowSignalListingUrl(url)) return { url, score: -Infinity, sameHost: false, reason: "low-signal-sitemap-url" };
  try {
    const parsed = new URL(url);
    const targetHost = String(target.siteScope || target.domain || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase().replace(/^www\./, "");
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const sameHost = Boolean(targetHost && host === targetHost);
    if (!sameHost) return { url, score: -Infinity, sameHost: false, reason: "cross-host-sitemap-url" };
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi|doc|docx|xls|xlsx|ppt|pptx)(?:$|[?#])/i.test(parsed.pathname)) {
      return { url, score: -Infinity, sameHost: true, reason: "static-asset-sitemap-url" };
    }
    let score = 40;
    const path = `${parsed.pathname} ${parsed.search}`.toLowerCase();
    const sitemapPath = String(sitemapUrl || "").toLowerCase();
    if (/news|article|story|post|press|release|statement|notice|blog|review|complaint|incident/.test(path)) score += 28;
    if (/\/(?:20[2-9]\d|19\d\d)[/-](?:0?[1-9]|1[0-2])(?:[/-](?:0?[1-9]|[12]\d|3[01]))?/.test(path)) score += 20;
    if (/\/(?:a|p|n|news|article|story)\/(?:20[2-9]\d|19\d\d)\//.test(path)) score += 14;
    if (/news|sitemap[-_]?news|latest|press|release/.test(sitemapPath)) score += 16;
    if (entry.publicationDate) score += 16;
    if (entry.lastmod) score += 10;
    const lastmodTime = sitemapLastmodTime(entry.publicationDate || entry.lastmod);
    if (lastmodTime) score += Math.min(18, Math.max(0, (lastmodTime - Date.UTC(2024, 0, 1)) / (90 * 24 * 60 * 60 * 1000)));
    if (/tag|category|author|image|video|archive|page\/\d+|search/.test(path)) score -= 24;
    return { url, score, sameHost: true, reason: "sitemap-body-probe-candidate", lastmodTime };
  } catch {
    return { url, score: -Infinity, sameHost: false, reason: "invalid-sitemap-url" };
  }
}

function selectSitemapBodyProbeCandidates(entries = [], keyword = "", { target = {}, sitemapUrl = "", existingUrls = [], limit = 3 } = {}) {
  const safeLimit = Math.max(0, Math.min(5, Number(limit) || 0));
  if (!safeLimit) return [];
  const seen = new Set((Array.isArray(existingUrls) ? existingUrls : []).map(normalizeOpenWebDedupeUrl).filter(Boolean));
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const priority = sitemapBodyProbePriority(entry, { target, sitemapUrl });
      const metadata = sitemapEntryMetadataText(entry, priority.url);
      return { ...entry, index, ...priority, metadata };
    })
    .filter(item => {
      const dedupe = normalizeOpenWebDedupeUrl(item.url);
      if (!item.url || !Number.isFinite(item.score) || item.score <= -Infinity || seen.has(dedupe)) return false;
      seen.add(dedupe);
      return !openWebValueMatchesKeyword(item.metadata, keyword);
    })
    .sort((a, b) => b.score - a.score || Number(b.lastmodTime || 0) - Number(a.lastmodTime || 0) || a.index - b.index)
    .slice(0, safeLimit);
}

function parseSitemapBodyProbeArticle(enriched = {}, keyword = "", target = {}, { entry = {}, sitemapUrl = "" } = {}) {
  const metrics = enriched.evidence?.metrics || {};
  const canonicalUrl = normalizeOpenWebDedupeUrl(metrics.canonical_url || enriched.url || entry.loc || "");
  const title = cleanText(enriched.title || metrics.og_title || metrics.twitter_title || entry.title || sitemapTitleFromUrl(canonicalUrl), 260);
  const content = cleanText(enriched.content || enriched.ai_summary || metrics.article_body_excerpt || sitemapEntryMetadataText(entry, canonicalUrl), 5000);
  if (!canonicalUrl || !title || !openWebValueMatchesKeyword(`${title} ${content}`, keyword)) return null;
  if (isLowSignalListingUrl(canonicalUrl)) return null;
  const publishedAt = normalizePublishedAt(enriched.published_at || metrics.published_time || entry.publicationDate || entry.lastmod);
  const score = scoreOpenWebDiscoveryCandidate({ title, content, url: canonicalUrl, keyword, target });
  if (!score.accepted) return null;
  return {
    url: canonicalUrl,
    title,
    content,
    author: cleanText(enriched.author || metrics.author || metrics.site_name || entry.publicationName || target.domain || "Sitemap", 160),
    publishedAt,
    raw_html: enriched.raw_html || "",
    metrics: {
      source: "open_web_sitemap_body_probe",
      source_family: "search",
      source_kind: "public_open_web_article",
      collection_mode: "sitemap_body_probe",
      discovery_search_engine: "sitemap_body_probe",
      discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(canonicalUrl),
      discovery_target: target.domain || "",
      discovery_site_scope: target.siteScope || target.domain || "",
      discovery_profile: target.profile || "open-web",
      discovery_source_url: target.sourceUrl || "",
      discovery_score: Number(target.score || 0),
      discovery_query_profile: target.profile || "open-web",
      discovery_query_suffix: target.querySuffix || "",
      discovery_sitemap_url: sitemapUrl,
      discovery_sitemap_lastmod: entry.lastmod || "",
      discovery_sitemap_publication_date: entry.publicationDate || "",
      discovery_sitemap_publication_name: entry.publicationName || "",
      discovery_sitemap_news_keywords: Array.isArray(entry.newsKeywords) ? entry.newsKeywords.slice(0, 12) : [],
      open_web_sitemap_body_probe: 1,
      open_web_sitemap_body_probe_url: entry.loc || canonicalUrl,
      article_body_quality_score: Number(metrics.article_body_quality_score || 0),
      article_body_text_length: Number(metrics.article_body_text_length || content.length || 0),
      article_body_paragraph_count: Number(metrics.article_body_paragraph_count || 0),
      article_body_excerpt: metrics.article_body_excerpt || content.slice(0, 500),
      canonical_url: canonicalUrl,
      discovery_intent_hits: score.intentHits || [],
      discovery_generic_hits: score.genericHits || [],
      open_web_relevance_score: score.relevanceScore || 0,
      open_web_quality_score: score.qualityScore || 0,
      open_web_profile_precision_score: score.profilePrecisionScore || 0,
      discovery_profile_precision_reasons: score.profilePrecisionReasons || [],
      relevance_score: score.relevanceScore || 0,
      quality_score: score.qualityScore || 0,
      open_web_filter_reason: score.reason || "",
      ...openWebDiscoveryPriorityMetrics(score),
      ...openWebTargetAttributionMetrics(target),
      ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
    },
  };
}

async function collectSitemapBodyProbeResults(entries = [], keyword = "", { target = {}, sitemapUrl = "", proxyUrl = "", limit = 3, existingUrls = [] } = {}) {
  const candidates = selectSitemapBodyProbeCandidates(entries, keyword, { target, sitemapUrl, existingUrls, limit });
  const items = [];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const enriched = await enrichSearchResultSummary({
        url: candidate.url,
        title: sitemapTitleFromUrl(candidate.url),
        content: candidate.metadata || keyword,
      }, { proxyUrl });
      const item = parseSitemapBodyProbeArticle(enriched, keyword, target, { entry: candidate, sitemapUrl });
      if (item) items.push(item);
      if (items.length >= limit) break;
    } catch (err) {
      failures.push({ keyword, target: `sitemap-body-probe:${candidate.url}`, message: formatSourceError(err, proxyUrl) });
    }
  }
  return { items, failures, checked: candidates.length };
}

async function collectDirectSitemapDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, diagnostics = null } = {}) {
  if (!target.directSitemap) return { items: [], rawCount: 0, checked: 0 };
  const robotsSitemapUrls = selectDirectSitemapSeedUrls(
    await targetRobotsSitemapUrls(target, proxyUrl),
    { target, limit: 12 },
  );
  const sitemapUrls = [
    ...robotsSitemapUrls,
    ...targetSitemapCandidateUrls(target),
  ].filter((url, index, list) => url && list.indexOf(url) === index);
  const items = [];
  const failures = [];
  const bodyProbeSeenUrls = new Set();
  let rawCount = 0;
  let checked = 0;
  let bodyProbeChecked = 0;
  let maxDepthReached = 0;
  const seenSitemaps = new Set();
  const fetchAndParse = async (url = "", depth = 0) => {
    const sitemapUrl = normalizeUrl(url);
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl) || checked >= 12 || items.length >= limit) return;
    seenSitemaps.add(sitemapUrl);
    checked += 1;
    maxDepthReached = Math.max(maxDepthReached, depth);
    const res = await fetchPublicSource(sitemapUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/xml,text/xml,application/rss+xml,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl).catch(() => null);
    if (!res?.ok) return;
    const xml = await readSitemapResponseText(res, sitemapUrl);
    const parsed = parseSitemapXmlEntries(xml);
    rawCount += parsed.urls.length;
    const pageItems = parseSitemapDiscoveryResults(xml, keyword, {
      target,
      sitemapUrl,
      limit: limit - items.length,
      diagnostics,
    });
    items.push(...pageItems);
    for (const item of pageItems) bodyProbeSeenUrls.add(openWebDedupeKey(item));
    if (items.length < limit && parsed.urls.length) {
      const bodyProbe = await collectSitemapBodyProbeResults(parsed.urls, keyword, {
        target,
        sitemapUrl,
        proxyUrl,
        limit: Math.min(3, limit - items.length),
        existingUrls: [...bodyProbeSeenUrls],
      });
      bodyProbeChecked += bodyProbe.checked;
      failures.push(...bodyProbe.failures);
      for (const item of bodyProbe.items) {
        const normalized = openWebDedupeKey(item);
        if (!normalized || bodyProbeSeenUrls.has(normalized)) continue;
        bodyProbeSeenUrls.add(normalized);
        items.push(item);
        if (items.length >= limit) break;
      }
    }
    if (depth < DIRECT_SITEMAP_MAX_INDEX_DEPTH && items.length < limit) {
      for (const child of selectDirectSitemapChildren(parsed.sitemaps, { parentUrl: sitemapUrl, target, limit: 5 })) {
        if (items.length >= limit) break;
        await fetchAndParse(child.url || child.loc, depth + 1);
      }
    }
  };
  for (const url of sitemapUrls) {
    if (items.length >= limit) break;
    await fetchAndParse(url, 0);
  }
  return { items, rawCount, checked, bodyProbeChecked, maxDepthReached, failures };
}

function parseDuckDuckGoDiscoveryResults(html, keyword, { target = {}, limit = 10, diagnostics = null } = {}) {
  const source = String(html || "");
  const results = [];
  const blockRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const url = normalizeUrl(match[1]);
    const title = cleanText(match[2], 300);
    const content = cleanText((match[3].match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || match[3].match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || [])[1] || "", 1200);
    if (!url || !title || !openWebValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (isLowSignalListingUrl(url)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "duckduckgo", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title, content, url, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "duckduckgo", score }));
      continue;
    }
    results.push({
      url,
      title,
      content,
      author: target.domain || "Open Web",
      publishedAt: new Date().toISOString(),
      metrics: {
        discovery_search_engine: "duckduckgo",
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(url),
        discovery_target: target.domain || "",
        discovery_site_scope: target.siteScope || target.domain || "",
        discovery_profile: target.profile || "open-web",
        discovery_source_url: target.sourceUrl || "",
        discovery_score: Number(target.score || 0),
        discovery_query_profile: target.profile || "open-web",
        discovery_query_suffix: target.querySuffix || "",
        discovery_intent_hits: score.intentHits,
        discovery_generic_hits: score.genericHits,
        open_web_relevance_score: score.relevanceScore,
        open_web_quality_score: score.qualityScore,
        open_web_profile_precision_score: score.profilePrecisionScore,
        discovery_profile_precision_reasons: score.profilePrecisionReasons,
        relevance_score: score.relevanceScore,
        quality_score: score.qualityScore,
        open_web_filter_reason: score.reason,
        ...openWebDiscoveryPriorityMetrics(score),
        ...openWebTargetAttributionMetrics(target),
        ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseBingRssDiscoveryResults(xml, keyword, { target = {}, limit = 10, diagnostics = null } = {}) {
  const source = String(xml || "");
  const blocks = [...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].map(match => match[0]);
  const results = [];
  for (const block of blocks) {
    const rawUrl = tagValue(block, "link");
    const url = normalizeUrl(rawUrl);
    const title = tagValue(block, "title");
    const content = tagValue(block, "description");
    if (!url || !title || !openWebValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (isLowSignalListingUrl(url)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "bing_rss", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title, content, url, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "bing_rss", score }));
      continue;
    }
    results.push({
      url,
      title,
      content,
      author: target.domain || "Bing RSS",
      publishedAt: normalizePublishedAt(tagValue(block, "pubDate")),
      metrics: {
        discovery_search_engine: "bing_rss",
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(url),
        discovery_target: target.domain || "",
        discovery_site_scope: target.siteScope || target.domain || "",
        discovery_profile: target.profile || "open-web",
        discovery_source_url: target.sourceUrl || "",
        discovery_score: Number(target.score || 0),
        discovery_query_profile: target.profile || "open-web",
        discovery_query_suffix: target.querySuffix || "",
        discovery_intent_hits: score.intentHits,
        discovery_generic_hits: score.genericHits,
        open_web_relevance_score: score.relevanceScore,
        open_web_quality_score: score.qualityScore,
        open_web_profile_precision_score: score.profilePrecisionScore,
        discovery_profile_precision_reasons: score.profilePrecisionReasons,
        relevance_score: score.relevanceScore,
        quality_score: score.qualityScore,
        open_web_filter_reason: score.reason,
        ...openWebDiscoveryPriorityMetrics(score),
        ...openWebTargetAttributionMetrics(target),
        ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseMojeekDiscoveryResults(html, keyword, { target = {}, query = "", limit = 10, diagnostics = null } = {}) {
  const source = String(html || "");
  const blocks = [...source.matchAll(/<!--rs-->([\s\S]*?)<!--re-->/gi)].map(match => match[1]);
  const results = [];
  for (const block of blocks) {
    const titleLink = block.match(/<h2>\s*<a[^>]+class="[^"]*title[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
      || block.match(/<a[^>]+class="[^"]*title[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const url = normalizeUrl(titleLink?.[1] || (block.match(/<a[^>]+class="[^"]*ob[^"]*"[^>]+href="([^"]+)"/i) || [])[1] || "");
    const title = cleanText(titleLink?.[2] || "", 300);
    const content = cleanText((block.match(/<p[^>]+class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "", 1200);
    if (!url || !title || !openWebValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (isLowSignalListingUrl(url)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "mojeek", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title, content, url, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "mojeek", score }));
      continue;
    }
    results.push({
      url,
      title,
      content,
      author: target.domain || "Mojeek",
      publishedAt: new Date().toISOString(),
      metrics: {
        discovery_search_engine: "mojeek",
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(url),
        discovery_target: target.domain || "",
        discovery_site_scope: target.siteScope || target.domain || "",
        discovery_profile: target.profile || "open-web",
        discovery_source_url: target.sourceUrl || "",
        discovery_score: Number(target.score || 0),
        discovery_query_profile: target.profile || "open-web",
        discovery_query_suffix: target.querySuffix || "",
        discovery_query: query,
        discovery_intent_hits: score.intentHits,
        discovery_generic_hits: score.genericHits,
        open_web_relevance_score: score.relevanceScore,
        open_web_quality_score: score.qualityScore,
        open_web_profile_precision_score: score.profilePrecisionScore,
        discovery_profile_precision_reasons: score.profilePrecisionReasons,
        relevance_score: score.relevanceScore,
        quality_score: score.qualityScore,
        open_web_filter_reason: score.reason,
        ...openWebDiscoveryPriorityMetrics(score),
        ...openWebTargetAttributionMetrics(target),
        ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseWibyDiscoveryResults(html, keyword, { target = {}, query = "", limit = 10, diagnostics = null } = {}) {
  const source = String(html || "");
  const blocks = [...source.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi)].map(match => match[1]);
  const results = [];
  for (const block of blocks) {
    const titleLink = block.match(/<a[^>]+class=["']tlink["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const url = normalizeUrl(titleLink?.[1] || "");
    const title = cleanText(titleLink?.[2] || "", 300);
    const urlText = cleanText((block.match(/<p[^>]+class=["']url["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "", 300);
    const content = cleanText(block
      .replace(/<a[^>]+class=["']tlink["'][\s\S]*?<\/a>/i, " ")
      .replace(/<p[^>]+class=["']url["'][\s\S]*?<\/p>/i, " "), 1200);
    if (!url || !title || !openWebValueMatchesKeyword(`${title} ${content} ${urlText}`, keyword)) continue;
    if (isLowSignalListingUrl(url)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "wiby", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title, content, url, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url, title, content, keyword, target, engine: "wiby", score }));
      continue;
    }
    results.push({
      url,
      title,
      content,
      author: target.domain || "Wiby",
      publishedAt: new Date().toISOString(),
      metrics: {
        discovery_search_engine: "wiby",
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(url),
        discovery_target: target.domain || "",
        discovery_site_scope: target.siteScope || target.domain || "",
        discovery_profile: target.profile || "open-web",
        discovery_source_url: target.sourceUrl || "",
        discovery_score: Number(target.score || 0),
        discovery_query_profile: target.profile || "open-web",
        discovery_query_suffix: target.querySuffix || "",
        discovery_query: query,
        discovery_intent_hits: score.intentHits,
        discovery_generic_hits: score.genericHits,
        open_web_relevance_score: score.relevanceScore,
        open_web_quality_score: score.qualityScore,
        open_web_profile_precision_score: score.profilePrecisionScore,
        discovery_profile_precision_reasons: score.profilePrecisionReasons,
        relevance_score: score.relevanceScore,
        quality_score: score.qualityScore,
        open_web_filter_reason: score.reason,
        ...openWebDiscoveryPriorityMetrics(score),
        ...openWebTargetAttributionMetrics(target),
        ...(target.sourceWeightTier ? { source_weight_tier: target.sourceWeightTier } : {}),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function extractOpenSearchJsonItems(value, limit = 80) {
  const out = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || out.length >= limit) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    if (node.node && typeof node.node === "object") {
      visit(node.node);
      return;
    }
    if (node.item && typeof node.item === "object") {
      visit({
        ...node.item,
        position: node.position ?? node.item.position,
        list_item_name: node.name || node.title || "",
      });
      return;
    }
    const candidates = [
      node.items,
      node.results,
      node.entries,
      node.articles,
      node.posts,
      node.hits,
      node.edges,
      node.nodes,
      node.documents,
      node.records,
      node.resources,
      node.searchResults,
      node.search_results,
      node.initialResults,
      node.initial_results,
      node.itemListElement,
      node["@graph"],
      node.data?.items,
      node.data?.results,
      node.data?.hits,
      node.data?.edges,
      node.data?.nodes,
      node.data?.documents,
      node.data?.records,
      node.feed?.items,
      node.props?.pageProps?.items,
      node.props?.pageProps?.results,
      node.props?.pageProps?.articles,
      node.props?.pageProps?.posts,
      node.props?.pageProps?.searchResults,
      node.pageProps?.items,
      node.pageProps?.results,
      node.pageProps?.articles,
      node.pageProps?.posts,
      node.pageProps?.searchResults,
    ].filter(Boolean);
    if (candidates.length) {
      for (const candidate of candidates) visit(candidate);
      return;
    }
    const nestedItemUrl = typeof node.item === "string" ? node.item : "";
    const url = node.url || node.external_url || node.externalUrl || node.link || node.href || node.id || node.guid || node["@id"] || node.mainEntityOfPage?.["@id"] || node.mainEntityOfPage?.url || nestedItemUrl || "";
    const title = node.title || node.name || node.headline || node.summary || node.list_item_name || "";
    const content = node.content_text || node.contentText || node.content_html || node.contentHtml || node.description || node.summary || node.snippet || node.excerpt || node.text || "";
    if (!url || (!title && !content)) return;
    const dedupe = normalizeOpenWebDedupeUrl(url);
    if (!dedupe || seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push(node);
  };
  visit(value);
  return out.slice(0, Math.max(1, Math.min(120, Number(limit) || 80)));
}

function extractBalancedJsonLiteral(source = "", startIndex = 0) {
  const text = String(source || "");
  let start = Math.max(0, Number(startIndex) || 0);
  while (start < text.length && /\s/.test(text[start])) start += 1;
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === opener) depth += 1;
    if (ch === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function extractOpenSearchScriptJsonPayloads(body = "", attrs = "", limit = 8) {
  const text = decodeXml(body || "").trim();
  const out = [];
  const pushLiteral = (literal = "") => {
    if (!literal || out.length >= limit) return;
    try {
      out.push(JSON.parse(literal));
    } catch {
      // Ignore malformed or non-JSON JavaScript literals.
    }
  };
  if (/^\s*[\[{]/.test(text)) {
    pushLiteral(text);
    return out;
  }
  const id = (String(attrs || "").match(/\bid=["']([^"']+)["']/i) || [])[1] || "";
  const knownStatePattern = /(?:window\.|self\.|globalThis\.)?(?:__INITIAL_STATE__|__NUXT__|__APOLLO_STATE__|__NEXT_DATA__|__RELAY_STORE__|__PRELOADED_STATE__|INITIAL_STATE|NUXT_DATA|APOLLO_STATE)\s*=\s*/gi;
  let match;
  while ((match = knownStatePattern.exec(text)) !== null && out.length < limit) {
    pushLiteral(extractBalancedJsonLiteral(text, match.index + match[0].length));
  }
  if (id === "__NEXT_DATA__" && !out.length) pushLiteral(text);
  return out.slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

function extractOpenSearchScriptJsonItems(html = "", limit = 80) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const pushItems = (items = []) => {
    for (const item of items) {
      const url = item?.url || item?.external_url || item?.externalUrl || item?.link || item?.href || item?.id || item?.guid || item?.["@id"] || item?.mainEntityOfPage?.["@id"] || item?.mainEntityOfPage?.url || "";
      const dedupe = normalizeOpenWebDedupeUrl(url);
      if (!dedupe || seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(item);
      if (out.length >= limit) break;
    }
  };
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(source)) !== null && out.length < limit) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    if (!String(body || "").trim()) continue;
    const type = (attrs.match(/\btype=["']([^"']+)["']/i) || [])[1] || "";
    const id = (attrs.match(/\bid=["']([^"']+)["']/i) || [])[1] || "";
    const scriptText = String(body || "");
    const hasKnownState = /(?:__INITIAL_STATE__|__NUXT__|__APOLLO_STATE__|__NEXT_DATA__|__RELAY_STORE__|__PRELOADED_STATE__|INITIAL_STATE|NUXT_DATA|APOLLO_STATE)\s*=/i.test(scriptText);
    if (type && !/(application\/ld\+json|application\/json|application\/x-json|text\/json)/i.test(type) && id !== "__NEXT_DATA__" && !hasKnownState) continue;
    for (const payload of extractOpenSearchScriptJsonPayloads(body, attrs, 6)) {
      pushItems(extractOpenSearchJsonItems(payload, limit - out.length));
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, Math.max(1, Math.min(120, Number(limit) || 80)));
}

function jsonOpenSearchAuthorName(item = {}) {
  const author = item.author || item.authors?.[0] || item.creator || item.byline || "";
  if (typeof author === "string") return cleanText(author, 160);
  return cleanText(author?.name || author?.url || "", 160);
}

function jsonOpenSearchItemToResult(item = {}) {
  const url = item.url || item.external_url || item.externalUrl || item.link || item.href || item.id || item.guid || item["@id"] || item.mainEntityOfPage?.["@id"] || item.mainEntityOfPage?.url || "";
  const title = item.title || item.name || item.headline || item.list_item_name || "";
  const content = item.content_text || item.contentText || item.content_html || item.contentHtml || item.description || item.summary || item.snippet || item.excerpt || item.text || "";
  const publishedAt = item.date_published || item.datePublished || item.published_at || item.publishedAt || item.pubDate || item.updated_at || item.updatedAt || item.date_modified || item.dateModified || "";
  return {
    url,
    title: title || cleanText(content, 100),
    content,
    author: jsonOpenSearchAuthorName(item),
    publishedAt,
  };
}

function parseOpenSearchDirectResults(text = "", keyword = "", { target = {}, template = {}, limit = 10, diagnostics = null } = {}) {
  const source = String(text || "");
  const results = [];
  const push = ({ url = "", title = "", content = "", publishedAt = "", author = "" } = {}) => {
    const normalized = normalizeUrl(url);
    const safeTitle = cleanText(title, 300);
    const safeContent = cleanText(content, 1200);
    if (!normalized || !safeTitle || !openWebValueMatchesKeyword(`${safeTitle} ${safeContent}`, keyword)) return;
    if (isLowSignalListingUrl(normalized)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "opensearch_direct", reason: "low-signal-listing-url" }));
      return;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title: safeTitle, content: safeContent, url: normalized, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "opensearch_direct", score }));
      return;
    }
    results.push({
      url: normalized,
      title: safeTitle,
      content: safeContent,
      author: cleanText(author, 160) || target.domain || "OpenSearch",
      publishedAt: normalizePublishedAt(publishedAt),
      metrics: {
        ...openSearchResultMetrics({ target, template, score }),
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(normalized),
      },
    });
  };
  if (/^\s*[\[{]/.test(source)) {
    try {
      for (const item of extractOpenSearchJsonItems(JSON.parse(source))) {
        push(jsonOpenSearchItemToResult(item));
        if (results.length >= limit) return results.slice(0, limit);
      }
    } catch {
      // Not JSON; continue with XML/HTML parsers.
    }
  }
  if (!results.length) {
    for (const item of extractOpenSearchScriptJsonItems(source, limit)) {
      push(jsonOpenSearchItemToResult(item));
      if (results.length >= limit) return results.slice(0, limit);
    }
  }
  const rssBlocks = [...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].map(match => match[0]);
  for (const block of rssBlocks) {
    const categories = rssCategoryTerms(block);
    const content = [
      ...xmlContentParts(block, ["description", "content:encoded", "summary", "media:description", "itunes:summary"], 8),
      ...categories,
    ].join(" ");
    push({
      url: tagValue(block, "link") || tagValue(block, "guid"),
      title: tagValue(block, "title"),
      content,
      publishedAt: tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated") || tagValue(block, "dc:date"),
      author: tagValue(block, "dc:creator") || tagValue(block, "creator") || tagValue(block, "author"),
    });
    if (results.length >= limit) return results.slice(0, limit);
  }
  const atomBlocks = [...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)].map(match => match[0]);
  for (const block of atomBlocks) {
    const linkTag = (block.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i) || block.match(/<link\b[^>]*>/i) || [])[0] || "";
    const categories = rssCategoryTerms(block);
    const content = [
      ...xmlContentParts(block, ["summary", "content", "media:description"], 8),
      ...categories,
    ].join(" ");
    push({
      url: tagValue(block, "link") || cleanText((linkTag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "", 1000),
      title: tagValue(block, "title"),
      content,
      publishedAt: tagValue(block, "published") || tagValue(block, "updated"),
      author: atomAuthorName(block),
    });
    if (results.length >= limit) return results.slice(0, limit);
  }
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b|$)/gi;
  let match;
  while ((match = anchorRegex.exec(source)) !== null) {
    push({
      url: match[1] || "",
      title: cleanText(match[2] || "", 300),
      content: cleanText(match[3] || "", 1200),
    });
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

function targetWordPressRestCandidateUrls(target = {}, keyword = "", limit = 4) {
  const term = cleanText(keyword, 180);
  if (!term) return [];
  const out = [];
  const seen = new Set();
  const pushOrigin = (raw = "") => {
    const source = String(raw || "").trim();
    if (!source) return;
    let parsed = null;
    try {
      parsed = new URL(source.startsWith("http") ? source : `https://${source.replace(/^\/+/, "")}`);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    const origin = parsed.origin;
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    out.push(`${origin}/wp-json/wp/v2/search?search=${encodeURIComponent(term)}&per_page=10&subtype=post`);
    out.push(`${origin}/wp-json/wp/v2/posts?search=${encodeURIComponent(term)}&per_page=10&_embed=1`);
  };
  pushOrigin(target.sourceUrl);
  pushOrigin(target.siteScope || target.domain);
  const safeLimit = Math.max(1, Math.min(8, Number(limit) || 4));
  return [...new Set(out)].slice(0, safeLimit);
}

function wordpressRestPageUrl(restUrl = "", page = 0) {
  const safePage = Math.max(0, Math.round(Number(page) || 0));
  if (safePage <= 0) return restUrl;
  try {
    const url = new URL(restUrl);
    url.searchParams.set("page", String(safePage + 1));
    return url.toString();
  } catch {
    return "";
  }
}

function wordpressRestEndpointKind(restUrl = "") {
  try {
    const path = new URL(restUrl).pathname.toLowerCase();
    if (/\/wp-json\/wp\/v2\/posts\b/.test(path)) return "posts";
    if (/\/wp-json\/wp\/v2\/search\b/.test(path)) return "search";
  } catch {
    // Ignore malformed URLs.
  }
  return "";
}

function wordpressRestRawItems(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.posts)) return payload.posts;
  return [];
}

function wordpressRestRendered(value = "") {
  if (typeof value === "string") return decodeXml(value);
  if (value && typeof value === "object") return decodeXml(value.rendered || value.raw || value.value || "");
  return "";
}

function wordpressRestAuthor(item = {}) {
  const embeddedAuthor = item?._embedded?.author?.[0];
  return cleanText(
    embeddedAuthor?.name
    || item.author_name
    || item.authorName
    || item.author
    || "",
    160,
  );
}

function wordpressRestItemToResult(item = {}, { endpoint = "", restUrl = "" } = {}) {
  const endpointKind = endpoint || wordpressRestEndpointKind(restUrl);
  const url = item.url || item.link || item.guid?.rendered || item.guid || item.href || "";
  const title = wordpressRestRendered(item.title || item.name || item.headline || "");
  const excerpt = wordpressRestRendered(item.excerpt || item.description || item.summary || item.content_text || item.contentText || "");
  const content = wordpressRestRendered(item.content || item.content_html || item.contentHtml || "");
  const typeText = cleanText([item.type, item.subtype, endpointKind].filter(Boolean).join(" "), 120);
  return {
    url,
    title: title || cleanText(excerpt || content || url, 240),
    content: cleanText([excerpt, content, typeText].filter(Boolean).join(" "), 1600),
    author: wordpressRestAuthor(item),
    publishedAt: item.date_gmt || item.date || item.modified_gmt || item.modified || item.date_published || item.datePublished || "",
  };
}

function parseWordPressRestResults(payload = {}, keyword = "", { target = {}, restUrl = "", limit = 10, diagnostics = null } = {}) {
  const endpoint = wordpressRestEndpointKind(restUrl);
  const rawItems = wordpressRestRawItems(payload);
  const results = [];
  for (const rawItem of rawItems) {
    const item = wordpressRestItemToResult(rawItem, { endpoint, restUrl });
    const normalized = normalizeUrl(item.url);
    const safeTitle = cleanText(item.title, 300);
    const safeContent = cleanText(item.content, 1200);
    if (!normalized || !safeTitle || !openWebValueMatchesKeyword(`${safeTitle} ${safeContent}`, keyword)) continue;
    if (isLowSignalListingUrl(normalized)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "wordpress_rest_direct", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title: safeTitle, content: safeContent, url: normalized, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "wordpress_rest_direct", score }));
      continue;
    }
    results.push({
      url: normalized,
      title: safeTitle,
      content: safeContent,
      author: cleanText(item.author, 160) || target.domain || "WordPress",
      publishedAt: normalizePublishedAt(item.publishedAt),
      metrics: {
        ...openSearchResultMetrics({ target, template: { template: restUrl, type: "wordpress-rest" }, score, engine: "wordpress_rest_direct" }),
        discovery_wordpress_rest_url: restUrl,
        discovery_wordpress_rest_endpoint: endpoint,
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(normalized),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function collectTargetWordPressRestDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directWordPressRest) return { items: [], rawCount: 0, checked: 0, failures: [] };
  const urls = targetWordPressRestCandidateUrls(target, keyword, 4);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  const failures = [];
  let rawCount = 0;
  let checked = 0;
  for (const restUrl of urls) {
    if (items.length >= limit) break;
    for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
      const pageUrl = wordpressRestPageUrl(restUrl, page);
      if (!pageUrl) break;
      checked += 1;
      const res = await fetchPublicSource(pageUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,application/wp-json,text/json,*/*;q=0.5",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(err => {
        failures.push({ keyword, target: `wordpress-rest:${pageUrl}`, message: formatSourceError(err, proxyUrl) });
        return null;
      });
      if (!res?.ok) break;
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        if (!/^\s*</.test(text)) {
          failures.push({ keyword, target: `wordpress-rest:${pageUrl}`, message: `invalid JSON: ${err?.message || err}` });
        }
        break;
      }
      const endpointRawCount = wordpressRestRawItems(payload).length;
      rawCount += endpointRawCount;
      const pageItems = parseWordPressRestResults(payload, keyword, {
        target,
        restUrl: pageUrl,
        limit: limit - items.length,
        diagnostics,
      });
      for (const item of pageItems) {
        items.push({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            discovery_wordpress_rest_raw_result_count: endpointRawCount,
            discovery_wordpress_rest_checked_count: checked,
            discovery_wordpress_rest_page: page + 1,
            discovery_wordpress_rest_base_url: restUrl,
            discovery_wordpress_rest_page_url_source: page > 0 ? "page-parameter" : "base-endpoint",
          },
        });
        if (items.length >= limit) break;
      }
      if (endpointRawCount <= 0) break;
    }
  }
  return { items, rawCount, checked, failures };
}

function targetBloggerFeedCandidateUrls(target = {}, keyword = "", limit = 3) {
  const term = cleanText(keyword, 180);
  if (!term) return [];
  const out = [];
  const seen = new Set();
  const pushOrigin = (raw = "") => {
    const source = String(raw || "").trim();
    if (!source) return;
    let parsed = null;
    try {
      parsed = new URL(source.startsWith("http") ? source : `https://${source.replace(/^\/+/, "")}`);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!/(?:^|\.)blogspot\.com$|(?:^|\.)blogger\.com$/.test(host)) return;
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    const origin = parsed.origin;
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    out.push(`${origin}/feeds/posts/default?q=${encodeURIComponent(term)}&alt=json&max-results=10`);
    out.push(`${origin}/feeds/posts/default?alt=json&max-results=10`);
  };
  pushOrigin(target.sourceUrl);
  pushOrigin(target.siteScope || target.domain);
  const safeLimit = Math.max(1, Math.min(5, Number(limit) || 3));
  return [...new Set(out)].slice(0, safeLimit);
}

function bloggerFeedPageUrl(feedUrl = "", page = 0) {
  const safePage = Math.max(0, Math.round(Number(page) || 0));
  if (safePage <= 0) return feedUrl;
  try {
    const url = new URL(feedUrl);
    const maxResults = Math.max(1, Math.min(50, Number(url.searchParams.get("max-results")) || 10));
    url.searchParams.set("start-index", String(safePage * maxResults + 1));
    return url.toString();
  } catch {
    return "";
  }
}

function bloggerFeedNextUrl(payload = {}, feedUrl = "") {
  const links = Array.isArray(payload?.feed?.link)
    ? payload.feed.link
    : Array.isArray(payload?.link)
      ? payload.link
      : Array.isArray(payload?.links)
        ? payload.links
        : [];
  const next = links.find(link => String(link?.rel || "").toLowerCase() === "next" && link?.href)
    || links.find(link => /next/i.test(String(link?.rel || link?.title || "")) && link?.href);
  const nextUrl = next?.href || payload?.next_url || payload?.nextUrl || "";
  if (!nextUrl) return "";
  try {
    const parsed = new URL(nextUrl, feedUrl);
    const current = new URL(feedUrl);
    if (parsed.hostname.replace(/^www\./, "") !== current.hostname.replace(/^www\./, "")) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function bloggerFeedRawEntries(payload = {}) {
  if (Array.isArray(payload?.feed?.entry)) return payload.feed.entry;
  if (Array.isArray(payload?.entry)) return payload.entry;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function bloggerFeedText(value = "") {
  if (typeof value === "string") return decodeXml(value);
  if (value && typeof value === "object") return decodeXml(value.$t || value.rendered || value.value || "");
  return "";
}

function bloggerFeedEntryUrl(entry = {}) {
  const links = Array.isArray(entry.link) ? entry.link : Array.isArray(entry.links) ? entry.links : [];
  const alternate = links.find(link => String(link?.rel || "").toLowerCase() === "alternate" && link?.href)
    || links.find(link => link?.href);
  return alternate?.href || entry.url || entry.link || entry.id?.$t || entry.id || "";
}

function bloggerFeedEntryAuthor(entry = {}) {
  const author = Array.isArray(entry.author) ? entry.author[0] : entry.author;
  return cleanText(
    bloggerFeedText(author?.name)
    || bloggerFeedText(author)
    || entry.author_name
    || entry.authorName
    || "",
    160,
  );
}

function bloggerFeedEntryToResult(entry = {}) {
  const labels = Array.isArray(entry.category)
    ? entry.category.map(item => cleanText(item?.term || item?.label || "", 80)).filter(Boolean).slice(0, 8)
    : [];
  const title = bloggerFeedText(entry.title || entry.name || "");
  const content = cleanText([
    bloggerFeedText(entry.summary || entry.description || ""),
    bloggerFeedText(entry.content || entry.content_text || entry.contentText || ""),
    labels.join(" "),
  ].filter(Boolean).join(" "), 1600);
  return {
    url: bloggerFeedEntryUrl(entry),
    title: title || cleanText(content, 240),
    content,
    author: bloggerFeedEntryAuthor(entry),
    publishedAt: bloggerFeedText(entry.published || entry.updated || entry.date_published || entry.datePublished || ""),
  };
}

function parseBloggerFeedResults(payload = {}, keyword = "", { target = {}, feedUrl = "", limit = 10, diagnostics = null } = {}) {
  const rawEntries = bloggerFeedRawEntries(payload);
  const results = [];
  for (const entry of rawEntries) {
    const item = bloggerFeedEntryToResult(entry);
    const normalized = normalizeUrl(item.url);
    const safeTitle = cleanText(item.title, 300);
    const safeContent = cleanText(item.content, 1200);
    if (!normalized || !safeTitle || !openWebValueMatchesKeyword(`${safeTitle} ${safeContent}`, keyword)) continue;
    if (isLowSignalListingUrl(normalized)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "blogger_feed_direct", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title: safeTitle, content: safeContent, url: normalized, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "blogger_feed_direct", score }));
      continue;
    }
    results.push({
      url: normalized,
      title: safeTitle,
      content: safeContent,
      author: cleanText(item.author, 160) || target.domain || "Blogger",
      publishedAt: normalizePublishedAt(item.publishedAt),
      metrics: {
        ...openSearchResultMetrics({ target, template: { template: feedUrl, type: "blogger-feed-json" }, score, engine: "blogger_feed_direct" }),
        discovery_blogger_feed_url: feedUrl,
        discovery_blogger_feed_format: "json",
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(normalized),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function collectTargetBloggerFeedDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directBloggerFeed) return { items: [], rawCount: 0, checked: 0, failures: [] };
  const urls = targetBloggerFeedCandidateUrls(target, keyword, 3);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  const failures = [];
  let rawCount = 0;
  let checked = 0;
  for (const feedUrl of urls) {
    if (items.length >= limit) break;
    let nextUrl = "";
    let nextUrlSource = "";
    for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
      const pageUrl = page > 0 && nextUrl ? nextUrl : bloggerFeedPageUrl(feedUrl, page);
      if (!pageUrl) break;
      checked += 1;
      const res = await fetchPublicSource(pageUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/json,*/*;q=0.5",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(err => {
        failures.push({ keyword, target: `blogger-feed:${pageUrl}`, message: formatSourceError(err, proxyUrl) });
        return null;
      });
      if (!res?.ok) break;
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text.replace(/^\s*var\s+\w+\s*=\s*/i, "").replace(/;\s*$/g, ""));
      } catch (err) {
        if (!/^\s*</.test(text)) {
          failures.push({ keyword, target: `blogger-feed:${pageUrl}`, message: `invalid JSON: ${err?.message || err}` });
        }
        break;
      }
      const endpointRawCount = bloggerFeedRawEntries(payload).length;
      rawCount += endpointRawCount;
      const discoveredNextUrl = bloggerFeedNextUrl(payload, pageUrl);
      const usedNextSource = nextUrlSource;
      const pageItems = parseBloggerFeedResults(payload, keyword, {
        target,
        feedUrl: pageUrl,
        limit: limit - items.length,
        diagnostics,
      });
      for (const item of pageItems) {
        items.push({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            discovery_blogger_feed_raw_result_count: endpointRawCount,
            discovery_blogger_feed_checked_count: checked,
            discovery_blogger_feed_page: page + 1,
            discovery_blogger_feed_base_url: feedUrl,
            discovery_blogger_feed_page_url_source: page > 0 ? usedNextSource || "start-index-parameter" : "base-endpoint",
            discovery_blogger_feed_next_page_url: discoveredNextUrl,
            discovery_blogger_feed_next_page_source: discoveredNextUrl ? "feed-link-next" : "",
          },
        });
        if (items.length >= limit) break;
      }
      if (endpointRawCount <= 0) break;
      nextUrl = discoveredNextUrl;
      nextUrlSource = discoveredNextUrl ? "feed-link-next" : "";
    }
  }
  return { items, rawCount, checked, failures };
}

function targetDiscourseSearchCandidateUrls(target = {}, keyword = "", limit = 2) {
  const term = cleanText(keyword, 180);
  if (!term) return [];
  const out = [];
  const seen = new Set();
  const pushOrigin = (raw = "") => {
    const source = String(raw || "").trim();
    if (!source) return;
    let parsed = null;
    try {
      parsed = new URL(source.startsWith("http") ? source : `https://${source.replace(/^\/+/, "")}`);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    const origin = parsed.origin;
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    const params = new URLSearchParams({ q: term, page: "0" });
    out.push(`${origin}/search.json?${params.toString()}`);
  };
  pushOrigin(target.sourceUrl);
  pushOrigin(target.siteScope || target.domain);
  const safeLimit = Math.max(1, Math.min(4, Number(limit) || 2));
  return [...new Set(out)].slice(0, safeLimit);
}

function discourseSearchPageUrl(searchUrl = "", page = 0) {
  const safePage = Math.max(0, Math.round(Number(page) || 0));
  try {
    const url = new URL(searchUrl);
    url.searchParams.set("page", String(safePage));
    return url.toString();
  } catch {
    return "";
  }
}

function discourseRawResults(payload = {}) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  return posts.length || topics.length ? { posts, topics } : { posts: [], topics: [] };
}

function discourseTopicUrl(origin = "", topic = {}, post = {}) {
  const id = topic.id || post.topic_id || post.topicId || "";
  if (!id) return "";
  const slug = cleanText(topic.slug || post.topic_slug || post.topicSlug || topic.title || "", 180)
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "topic";
  return `${origin.replace(/\/+$/g, "")}/t/${slug}/${id}`;
}

function discoursePostToResult(post = {}, topic = {}, searchUrl = "") {
  let origin = "";
  try {
    origin = new URL(searchUrl).origin;
  } catch {
    origin = "";
  }
  const title = cleanText(topic.title || post.topic_title || post.title || post.blurb || "", 300);
  const content = cleanText([
    post.blurb,
    post.cooked,
    post.excerpt,
    topic.excerpt,
    topic.posts_count ? `${topic.posts_count} posts` : "",
    topic.views ? `${topic.views} views` : "",
  ].filter(Boolean).join(" "), 1600);
  return {
    url: post.url || discourseTopicUrl(origin, topic, post),
    title,
    content,
    author: cleanText(post.username || post.name || topic.last_poster_username || "", 160),
    publishedAt: post.created_at || topic.created_at || topic.bumped_at || topic.last_posted_at || "",
  };
}

function parseDiscourseSearchResults(payload = {}, keyword = "", { target = {}, searchUrl = "", limit = 10, diagnostics = null } = {}) {
  const { posts, topics } = discourseRawResults(payload);
  const topicById = new Map(topics.map(topic => [String(topic.id || ""), topic]));
  const fallbackPosts = posts.length ? posts : topics.map(topic => ({ topic_id: topic.id, title: topic.title, blurb: topic.excerpt, created_at: topic.created_at }));
  const results = [];
  for (const post of fallbackPosts) {
    const topic = topicById.get(String(post.topic_id || post.topicId || post.id || "")) || topics.find(item => String(item.id || "") === String(post.id || "")) || {};
    const item = discoursePostToResult(post, topic, searchUrl);
    const normalized = normalizeUrl(item.url);
    const safeTitle = cleanText(item.title, 300);
    const safeContent = cleanText(item.content, 1200);
    if (!normalized || !safeTitle || !openWebValueMatchesKeyword(`${safeTitle} ${safeContent}`, keyword)) continue;
    if (isLowSignalListingUrl(normalized)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "discourse_search_direct", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title: safeTitle, content: safeContent, url: normalized, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "discourse_search_direct", score }));
      continue;
    }
    results.push({
      url: normalized,
      title: safeTitle,
      content: safeContent,
      author: cleanText(item.author, 160) || target.domain || "Discourse",
      publishedAt: normalizePublishedAt(item.publishedAt),
      metrics: {
        ...openSearchResultMetrics({ target, template: { template: searchUrl, type: "discourse-search-json" }, score, engine: "discourse_search_direct" }),
        discovery_discourse_search_url: searchUrl,
        discovery_discourse_topic_id: topic.id || post.topic_id || "",
        discovery_discourse_posts_count: Number(topic.posts_count || 0) || 0,
        discovery_discourse_views: Number(topic.views || 0) || 0,
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(normalized),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function collectTargetDiscourseSearchDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directDiscourseSearch) return { items: [], rawCount: 0, checked: 0, failures: [] };
  const urls = targetDiscourseSearchCandidateUrls(target, keyword, 2);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  const failures = [];
  let rawCount = 0;
  let checked = 0;
  for (const searchUrl of urls) {
    if (items.length >= limit) break;
    for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
      const pageUrl = discourseSearchPageUrl(searchUrl, page);
      if (!pageUrl) break;
      checked += 1;
      const res = await fetchPublicSource(pageUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/json,*/*;q=0.5",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(err => {
        failures.push({ keyword, target: `discourse-search:${pageUrl}`, message: formatSourceError(err, proxyUrl) });
        return null;
      });
      if (!res?.ok) break;
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        if (!/^\s*</.test(text)) {
          failures.push({ keyword, target: `discourse-search:${pageUrl}`, message: `invalid JSON: ${err?.message || err}` });
        }
        break;
      }
      const raw = discourseRawResults(payload);
      const endpointRawCount = raw.posts.length || raw.topics.length;
      rawCount += endpointRawCount;
      const pageItems = parseDiscourseSearchResults(payload, keyword, {
        target,
        searchUrl: pageUrl,
        limit: limit - items.length,
        diagnostics,
      });
      for (const item of pageItems) {
        items.push({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            discovery_discourse_search_raw_result_count: endpointRawCount,
            discovery_discourse_search_checked_count: checked,
            discovery_discourse_search_page: page,
            discovery_discourse_search_base_url: searchUrl,
            discovery_discourse_search_page_url_source: page > 0 ? "page-parameter" : "base-endpoint",
          },
        });
        if (items.length >= limit) break;
      }
      if (endpointRawCount <= 0) break;
    }
  }
  return { items, rawCount, checked, failures };
}

function targetMediaWikiSearchCandidateUrls(target = {}, keyword = "", limit = 2) {
  const term = cleanText(keyword, 180);
  if (!term) return [];
  const out = [];
  const seen = new Set();
  const pushOrigin = (raw = "") => {
    const source = String(raw || "").trim();
    if (!source) return;
    let parsed = null;
    try {
      parsed = new URL(source.startsWith("http") ? source : `https://${source.replace(/^\/+/, "")}`);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    const origin = parsed.origin;
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: term,
      format: "json",
      srlimit: "10",
      utf8: "1",
    });
    out.push(`${origin}/api.php?${params.toString()}`);
  };
  pushOrigin(target.sourceUrl);
  pushOrigin(target.siteScope || target.domain);
  const safeLimit = Math.max(1, Math.min(4, Number(limit) || 2));
  return [...new Set(out)].slice(0, safeLimit);
}

function mediaWikiSearchPageUrl(apiUrl = "", continuation = {}) {
  try {
    const url = new URL(apiUrl);
    const next = continuation && typeof continuation === "object" ? continuation : {};
    if (next.sroffset !== undefined && next.sroffset !== null && next.sroffset !== "") {
      url.searchParams.set("sroffset", String(next.sroffset));
    }
    if (next.continue !== undefined && next.continue !== null && next.continue !== "") {
      url.searchParams.set("continue", String(next.continue));
    }
    return url.toString();
  } catch {
    return "";
  }
}

function mediaWikiRawResults(payload = {}) {
  if (Array.isArray(payload?.query?.search)) return payload.query.search;
  if (Array.isArray(payload?.search)) return payload.search;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function mediaWikiArticleUrl(apiUrl = "", result = {}) {
  let origin = "";
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    origin = "";
  }
  const title = cleanText(result.title || result.name || "", 240);
  if (!origin || !title) return result.url || result.link || "";
  return `${origin}/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function mediaWikiResultToItem(result = {}, apiUrl = "") {
  const title = cleanText(result.title || result.name || "", 300);
  const snippet = cleanText(decodeXml(result.snippet || result.excerpt || result.description || ""), 1200);
  return {
    url: result.url || result.link || mediaWikiArticleUrl(apiUrl, result),
    title,
    content: snippet,
    author: cleanText(result.author || result.user || "", 160),
    publishedAt: result.timestamp || result.date || result.updated || "",
    pageId: result.pageid || result.pageId || result.id || "",
    wordCount: Number(result.wordcount || result.wordCount || 0) || 0,
    size: Number(result.size || 0) || 0,
  };
}

function parseMediaWikiSearchResults(payload = {}, keyword = "", { target = {}, apiUrl = "", limit = 10, diagnostics = null } = {}) {
  const rawResults = mediaWikiRawResults(payload);
  const results = [];
  for (const raw of rawResults) {
    const item = mediaWikiResultToItem(raw, apiUrl);
    const normalized = normalizeUrl(item.url);
    const safeTitle = cleanText(item.title, 300);
    const safeContent = cleanText(item.content, 1200);
    if (!normalized || !safeTitle || !openWebValueMatchesKeyword(`${safeTitle} ${safeContent}`, keyword)) continue;
    if (isLowSignalListingUrl(normalized)) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "mediawiki_search_direct", reason: "low-signal-listing-url" }));
      continue;
    }
    const score = scoreOpenWebDiscoveryCandidate({ title: safeTitle, content: safeContent, url: normalized, keyword, target });
    if (!score.accepted) {
      if (Array.isArray(diagnostics)) diagnostics.push(openWebRejectionDiagnostic({ url: normalized, title: safeTitle, content: safeContent, keyword, target, engine: "mediawiki_search_direct", score }));
      continue;
    }
    results.push({
      url: normalized,
      title: safeTitle,
      content: safeContent,
      author: cleanText(item.author, 160) || target.domain || "MediaWiki",
      publishedAt: normalizePublishedAt(item.publishedAt),
      metrics: {
        ...openSearchResultMetrics({ target, template: { template: apiUrl, type: "mediawiki-search-json" }, score, engine: "mediawiki_search_direct" }),
        discovery_mediawiki_api_url: apiUrl,
        discovery_mediawiki_page_id: item.pageId,
        discovery_mediawiki_word_count: item.wordCount,
        discovery_mediawiki_page_size: item.size,
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(normalized),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function collectTargetMediaWikiSearchDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directMediaWikiSearch) return { items: [], rawCount: 0, checked: 0, failures: [] };
  const urls = targetMediaWikiSearchCandidateUrls(target, keyword, 2);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  const failures = [];
  let rawCount = 0;
  let checked = 0;
  for (const apiUrl of urls) {
    if (items.length >= limit) break;
    let continuation = {};
    for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
      const pageUrl = page > 0 ? mediaWikiSearchPageUrl(apiUrl, continuation) : apiUrl;
      if (!pageUrl) break;
      checked += 1;
      const res = await fetchPublicSource(pageUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/json,*/*;q=0.5",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(err => {
        failures.push({ keyword, target: `mediawiki-search:${pageUrl}`, message: formatSourceError(err, proxyUrl) });
        return null;
      });
      if (!res?.ok) break;
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        if (!/^\s*</.test(text)) {
          failures.push({ keyword, target: `mediawiki-search:${pageUrl}`, message: `invalid JSON: ${err?.message || err}` });
        }
        break;
      }
      const endpointRawCount = mediaWikiRawResults(payload).length;
      rawCount += endpointRawCount;
      const pageItems = parseMediaWikiSearchResults(payload, keyword, {
        target,
        apiUrl: pageUrl,
        limit: limit - items.length,
        diagnostics,
      });
      for (const item of pageItems) {
        items.push({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            discovery_mediawiki_raw_result_count: endpointRawCount,
            discovery_mediawiki_checked_count: checked,
            discovery_mediawiki_page: page + 1,
            discovery_mediawiki_base_url: apiUrl,
            discovery_mediawiki_page_url_source: page > 0 ? "continue-parameter" : "base-endpoint",
            discovery_mediawiki_continue_sroffset: payload?.continue?.sroffset ?? "",
            discovery_mediawiki_continue_token: payload?.continue?.continue ?? "",
          },
        });
        if (items.length >= limit) break;
      }
      if (endpointRawCount <= 0 || !payload?.continue?.sroffset) break;
      continuation = payload.continue;
    }
  }
  return { items, rawCount, checked, failures };
}

function targetFeedDiscoverySeedUrls(target = {}) {
  const out = [];
  const push = (rawUrl = "") => {
    const url = absoluteUrl(rawUrl);
    if (url && !out.includes(url)) out.push(url);
  };
  if (target.sourceUrl) push(target.sourceUrl);
  const scope = String(target.siteScope || target.domain || "").replace(/^https?:\/\//i, "").replace(/[?#].*$/g, "").replace(/\/+$/g, "");
  if (scope) {
    try {
      push(new URL(`https://${scope}`).toString());
    } catch {
      // Ignore malformed target scope.
    }
  }
  return out.slice(0, 2);
}

function targetCommonFeedCandidateUrls(target = {}, limit = 8) {
  const origins = [];
  const paths = [];
  const seenOrigins = new Set();
  const pushOrigin = (rawUrl = "") => {
    const raw = String(rawUrl || "").trim();
    if (!raw) return;
    let parsed;
    try {
      parsed = new URL(raw.startsWith("http") ? raw : `https://${raw.replace(/^\/+/, "")}`);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    const origin = parsed.origin;
    if (!origin || seenOrigins.has(origin)) return;
    seenOrigins.add(origin);
    origins.push(origin);
    const path = parsed.pathname.replace(/\/+$/g, "");
    if (path && path !== "/" && !paths.includes(path)) paths.push(path);
  };
  pushOrigin(target.sourceUrl);
  pushOrigin(target.siteScope || target.domain);
  const suffixes = ["/feed.xml", "/feed", "/rss.xml", "/rss", "/atom.xml", "/index.xml", "/feed.json", "/index.json", "/opml.xml", "/feeds.opml", "/subscriptions.opml"];
  const pathSuffixes = ["/feed.xml", "/feed", "/rss.xml"];
  const out = [];
  const seen = new Set();
  const push = (url = "") => {
    const normalized = normalizeOpenWebDedupeUrl(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(url);
  };
  for (const origin of origins) {
    for (const suffix of suffixes) push(`${origin}${suffix}`);
    for (const path of paths) {
      for (const suffix of pathSuffixes) push(`${origin}${path}${suffix}`);
    }
  }
  return out.slice(0, Math.max(1, Math.min(12, Number(limit) || 8)));
}

function selectOpenWebFeedEntrypoints(html = "", baseUrl = "", limit = 4) {
  const safeLimit = Math.max(1, Math.min(6, Number(limit) || 4));
  return extractOpenWebEntrypoints(html, baseUrl, 20)
    .filter(item => item.kind === "rss-feed" && item.same_host)
    .sort((a, b) => {
      const explicitDelta = Number(b.source !== "derived-common-endpoint") - Number(a.source !== "derived-common-endpoint");
      return explicitDelta || Number(b.score || 0) - Number(a.score || 0) || a.url.localeCompare(b.url);
    })
    .slice(0, safeLimit);
}

function selectOpenWebSearchEntrypoints(html = "", baseUrl = "", limit = 3) {
  const safeLimit = Math.max(1, Math.min(5, Number(limit) || 3));
  return extractOpenWebEntrypoints(html, baseUrl, 20)
    .filter(item => item.kind === "site-search-or-topic" && item.same_host && /opensearch|xml|search/i.test(`${item.url} ${item.label} ${item.source}`))
    .sort((a, b) => {
      const explicitDelta = Number(b.source === "html-search") - Number(a.source === "html-search");
      return explicitDelta || Number(b.score || 0) - Number(a.score || 0) || a.url.localeCompare(b.url);
    })
    .slice(0, safeLimit);
}

function parseOpenSearchDescriptionTemplates(xml = "", baseUrl = "", limit = 4) {
  const source = String(xml || "");
  const templates = [];
  const seen = new Set();
  for (const match of source.matchAll(/<Url\b[^>]*>/gi)) {
    const tag = match[0];
    const type = cleanText((tag.match(/\btype=["']([^"']+)["']/i) || [])[1] || "", 120).toLowerCase();
    const rawTemplate = decodeXml((tag.match(/\btemplate=["']([^"']+)["']/i) || [])[1] || "").trim();
    if (!rawTemplate) continue;
    if (type && !/(html|application\/xhtml|text\/html|rss|atom|xml|json)/i.test(type)) continue;
    const absoluteTemplate = rawTemplate.startsWith("http")
      ? rawTemplate
      : absoluteUrl(rawTemplate.replace(/\{searchTerms\??\}/gi, "__OPINX_SEARCH_TERMS__"), baseUrl).replace("__OPINX_SEARCH_TERMS__", "{searchTerms}");
    if (!absoluteTemplate || seen.has(absoluteTemplate)) continue;
    seen.add(absoluteTemplate);
    templates.push({
      template: absoluteTemplate,
      type,
    });
    if (templates.length >= limit) break;
  }
  return templates;
}

async function collectTargetOpenSearchDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directOpenSearchDiscovery) return { items: [], rawCount: 0, checked: 0, templatesChecked: 0, sourcePagesChecked: 0, failures: [] };
  const seeds = targetFeedDiscoverySeedUrls(target);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  const failures = [];
  const seenDescriptions = new Set();
  const seenTemplates = new Set();
  let rawCount = 0;
  let checked = 0;
  let sourcePagesChecked = 0;
  let templatesChecked = 0;
  for (const seedUrl of seeds) {
    if (items.length >= limit) break;
    const pageRes = await fetchPublicSource(seedUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.6",
        "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl).catch(err => {
      failures.push({ keyword, target: `opensearch-discovery-source:${seedUrl}`, message: formatSourceError(err, proxyUrl) });
      return null;
    });
    if (!pageRes?.ok) continue;
    sourcePagesChecked += 1;
    const html = await pageRes.text();
    const descriptions = selectOpenWebSearchEntrypoints(html, seedUrl, 3);
    for (const description of descriptions) {
      if (items.length >= limit) break;
      const descriptionUrl = normalizeOpenWebDedupeUrl(description.url);
      if (!descriptionUrl || seenDescriptions.has(descriptionUrl)) continue;
      seenDescriptions.add(descriptionUrl);
      checked += 1;
      const descriptionRes = await fetchPublicSource(description.url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/opensearchdescription+xml,application/xml,text/xml,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(err => {
        failures.push({ keyword, target: `opensearch-description:${description.url}`, message: formatSourceError(err, proxyUrl) });
        return null;
      });
      if (!descriptionRes?.ok) continue;
      const templates = parseOpenSearchDescriptionTemplates(await descriptionRes.text(), description.url, 4);
      for (const template of templates) {
        if (items.length >= limit) break;
        let discoveredNextPageUrl = "";
        let discoveredNextPageSource = "";
        for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
          const usedDiscoveredNextPage = page > 0 && discoveredNextPageUrl;
          const pageUrlSource = usedDiscoveredNextPage ? discoveredNextPageSource || "html-next" : "template-page-parameter";
          const templateUrl = usedDiscoveredNextPage
            ? discoveredNextPageUrl
            : openSearchTemplateUrl(template, keyword, { page });
          if (!templateUrl || seenTemplates.has(templateUrl)) continue;
          seenTemplates.add(templateUrl);
          templatesChecked += 1;
          const searchRes = await fetchPublicSource(templateUrl, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl).catch(err => {
            failures.push({ keyword, target: `opensearch-direct:${templateUrl}`, message: formatSourceError(err, proxyUrl) });
            return null;
          });
          if (!searchRes?.ok) continue;
          const text = await searchRes.text();
          const nextPage = openSearchNextPageUrls(text, templateUrl, templateUrl, 1)[0] || null;
          discoveredNextPageUrl = nextPage?.url || "";
          discoveredNextPageSource = nextPage?.source || "";
          const resultRawCount = countOpenSearchDirectRawResults(text);
          rawCount += resultRawCount;
          const pageItems = parseOpenSearchDirectResults(text, keyword, {
            target,
            template,
            limit: limit - items.length,
            diagnostics,
          });
          for (const item of pageItems) {
            items.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_engine: "html_opensearch_discovery",
                discovery_search_page: page + 1,
                discovery_opensearch_description_url: description.url,
                discovery_opensearch_source_url: seedUrl,
                discovery_opensearch_candidate_label: description.label || "",
                discovery_opensearch_candidate_source: description.source || "",
                discovery_opensearch_candidate_score: Number(description.score || 0),
                discovery_opensearch_template_url: templateUrl,
                discovery_opensearch_page_url_source: pageUrlSource,
                discovery_opensearch_next_page_url: discoveredNextPageUrl,
                discovery_opensearch_next_page_source: discoveredNextPageSource,
                discovery_opensearch_raw_result_count: resultRawCount,
              },
            });
            if (items.length >= limit) break;
          }
        }
      }
    }
  }
  return { items, rawCount, checked, templatesChecked, sourcePagesChecked, failures };
}

function targetCommonSearchCandidateTemplates(target = {}, limit = 6) {
  const origins = [];
  const seenOrigins = new Set();
  const pushOrigin = (raw = "") => {
    const value = String(raw || "").trim();
    if (!value) return;
    let parsed;
    try {
      parsed = new URL(value.startsWith("http") ? value : `https://${value.replace(/^\/+/, "")}`);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    if (!parsed.origin || seenOrigins.has(parsed.origin)) return;
    seenOrigins.add(parsed.origin);
    origins.push(parsed.origin);
  };
  pushOrigin(target.sourceUrl);
  pushOrigin(target.siteScope || target.domain);
  const out = [];
  const seen = new Set();
  const push = (template = "", type = "text/html") => {
    const normalized = normalizeOpenSearchTemplate({ template, type }).template;
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ template: normalized, type, source: "derived-common-site-search" });
  };
  for (const origin of origins) {
    push(`${origin}/search?q={searchTerms}`);
    push(`${origin}/search?query={searchTerms}`);
    push(`${origin}/search?keyword={searchTerms}`);
    push(`${origin}/?s={searchTerms}`);
    push(`${origin}/?q={searchTerms}`);
    push(`${origin}/search/{searchTerms}`);
  }
  return out.slice(0, Math.max(1, Math.min(10, Number(limit) || 6)));
}

function feedNextPageUrls(text = "", feedUrl = "", limit = 2) {
  const source = String(text || "");
  const safeLimit = Math.max(1, Math.min(5, Number(limit) || 2));
  const out = [];
  const seen = new Set();
  const push = (rawUrl = "", sourceType = "feed-next") => {
    const url = absoluteUrl(rawUrl, feedUrl);
    if (!url) return;
    let parsed;
    let current;
    try {
      parsed = new URL(url);
      current = new URL(feedUrl);
    } catch {
      return;
    }
    if (parsed.hostname.replace(/^www\./, "") !== current.hostname.replace(/^www\./, "")) return;
    const normalized = parsed.href.replace(/#.*$/, "");
    const currentNormalized = current.href.replace(/#.*$/, "");
    if (!normalized || normalized === currentNormalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({
      url: normalized,
      label: normalized,
      source: sourceType,
    });
  };
  for (const next of openSearchNextPageUrls(source, feedUrl, feedUrl, safeLimit)) {
    push(next.url, next.source === "html-link-next" ? "feed-link-next" : next.source || "feed-next-link");
    if (out.length >= safeLimit) return out.slice(0, safeLimit);
  }
  const linkRegex = /<(?:[a-z0-9_-]+:)?link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null && out.length < safeLimit) {
    const tag = match[0];
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    if (/\bnext\b/i.test(rel)) push(href, "feed-link-next");
  }
  if (out.length >= safeLimit) return out.slice(0, safeLimit);
  if (/^\s*[\[{]/.test(source)) {
    try {
      const payload = JSON.parse(source);
      const candidates = [
        payload.next_url,
        payload.nextUrl,
        payload.next,
        payload.next_page_url,
        payload.nextPageUrl,
        payload.links?.next,
        payload.feed?.next_url,
        payload.feed?.nextUrl,
        payload.feed?.next,
      ].filter(Boolean);
      for (const candidate of candidates) {
        if (typeof candidate === "string") {
          push(candidate, "json-feed-next");
        } else if (typeof candidate === "object") {
          push(candidate.url || candidate.href || "", "json-feed-next");
        }
        if (out.length >= safeLimit) break;
      }
    } catch {
      // Non-JSON feeds are handled by XML/HTML next-link parsing above.
    }
  }
  return out.slice(0, safeLimit);
}

function parseOpmlFeedEntrypoints(text = "", baseUrl = "", limit = 16) {
  const source = String(text || "");
  if (!/<opml[\s>]/i.test(source) && !/<outline\b/i.test(source)) return [];
  const safeLimit = Math.max(1, Math.min(40, Number(limit) || 16));
  const out = [];
  const seen = new Set();
  const push = (rawUrl = "", label = "", sourceType = "opml-outline") => {
    const url = absoluteUrl(decodeXml(rawUrl || ""), baseUrl);
    if (!url || seen.has(url)) return;
    try {
      const parsed = new URL(url);
      const base = baseUrl ? new URL(baseUrl) : null;
      if (!["http:", "https:"].includes(parsed.protocol)) return;
      if (base && parsed.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return;
    } catch {
      return;
    }
    seen.add(url);
    out.push({
      url,
      label: cleanText(label || url, 180),
      source: sourceType,
    });
  };
  const outlineRegex = /<outline\b[^>]*>/gi;
  let match;
  while ((match = outlineRegex.exec(source)) !== null && out.length < safeLimit) {
    const tag = match[0];
    const xmlUrl = (tag.match(/\bxmlUrl=["']([^"']+)["']/i) || [])[1] || "";
    const htmlUrl = (tag.match(/\bhtmlUrl=["']([^"']+)["']/i) || [])[1] || "";
    const url = (tag.match(/\burl=["']([^"']+)["']/i) || [])[1] || "";
    const title = (tag.match(/\btitle=["']([^"']+)["']/i) || [])[1]
      || (tag.match(/\btext=["']([^"']+)["']/i) || [])[1]
      || "";
    push(xmlUrl || url || htmlUrl, title, xmlUrl ? "opml-outline-xmlurl" : url ? "opml-outline-url" : "opml-outline-htmlurl");
  }
  return out.slice(0, safeLimit);
}

async function collectTargetCommonSearchDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directOpenSearchDiscovery) return { items: [], rawCount: 0, checked: 0, failures: [] };
  const templates = targetCommonSearchCandidateTemplates(target, 6);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  let rawCount = 0;
  let checked = 0;
  for (const template of templates) {
    if (items.length >= limit) break;
    let nextPageUrl = "";
    let nextPageSource = "";
    for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
      const usedNext = page > 0 && nextPageUrl;
      const usedNextSource = nextPageSource;
      const searchUrl = usedNext ? nextPageUrl : openSearchTemplateUrl(template, keyword, { page });
      if (!searchUrl) continue;
      checked += 1;
      const res = await fetchPublicSource(searchUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/json,application/xml,text/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(() => null);
      if (!res?.ok) continue;
      const text = await res.text();
      const discoveredNext = openSearchNextPageUrls(text, searchUrl, searchUrl, 1)[0] || null;
      nextPageUrl = discoveredNext?.url || "";
      nextPageSource = discoveredNext?.source || "";
      const resultRawCount = countOpenSearchDirectRawResults(text);
      rawCount += resultRawCount;
      const pageItems = parseOpenSearchDirectResults(text, keyword, {
        target,
        template,
        limit: limit - items.length,
        diagnostics,
      });
      for (const item of pageItems) {
        items.push({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            discovery_search_engine: "common_site_search_direct",
            discovery_common_search_template: template.template,
            discovery_common_search_url: searchUrl,
            discovery_common_search_candidate_source: template.source || "derived-common-site-search",
            discovery_common_search_page: page + 1,
            discovery_common_search_page_url_source: usedNext ? usedNextSource || "html-next" : "template-page-parameter",
            discovery_common_search_next_page_url: nextPageUrl,
            discovery_common_search_next_page_source: nextPageSource,
            discovery_common_search_raw_result_count: resultRawCount,
            discovery_common_search_checked_count: checked,
          },
        });
        if (items.length >= limit) break;
      }
    }
  }
  return { items, rawCount, checked, failures: [] };
}

async function collectTargetFeedDiscoveryResults({ keyword = "", target = {}, proxyUrl = "", limit = 10, maxPages = 1, diagnostics = null } = {}) {
  if (!target.directFeedDiscovery) return { items: [], rawCount: 0, checked: 0, sourcePagesChecked: 0, failures: [] };
  const seeds = targetFeedDiscoverySeedUrls(target);
  const safeMaxPages = Math.max(1, Math.min(5, Number(maxPages) || 1));
  const items = [];
  const failures = [];
  const seenFeeds = new Set();
  let rawCount = 0;
  let checked = 0;
  let sourcePagesChecked = 0;
  const fetchFeedPages = async ({
    initialFeedUrl = "",
    seedUrl = "",
    label = "",
    candidateSource = "",
    candidateScore = 0,
    searchEngine = "html_feed_discovery",
    commonFeedDirect = false,
    opmlDepth = 0,
  } = {}) => {
    let currentFeedUrl = initialFeedUrl;
    let currentSource = candidateSource || "";
    for (let page = 0; page < safeMaxPages && items.length < limit; page += 1) {
      const normalizedFeedUrl = normalizeOpenWebDedupeUrl(currentFeedUrl);
      if (!normalizedFeedUrl || seenFeeds.has(normalizedFeedUrl)) break;
      seenFeeds.add(normalizedFeedUrl);
      checked += 1;
      const feedRes = await fetchPublicSource(currentFeedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/rss+xml,application/atom+xml,application/feed+json,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl).catch(err => {
        failures.push({ keyword, target: `${commonFeedDirect ? "common-feed-direct" : "feed-discovery"}:${currentFeedUrl}`, message: formatSourceError(err, proxyUrl) });
        return null;
      });
      if (!feedRes?.ok) break;
      const text = await feedRes.text();
      const opmlFeeds = opmlDepth < 1 ? parseOpmlFeedEntrypoints(text, currentFeedUrl, 16) : [];
      if (opmlFeeds.length) {
        rawCount += opmlFeeds.length;
        for (const feed of opmlFeeds) {
          if (items.length >= limit) break;
          await fetchFeedPages({
            initialFeedUrl: feed.url,
            seedUrl: seedUrl || currentFeedUrl,
            label: feed.label || label || feed.url,
            candidateSource: feed.source || "opml-outline",
            candidateScore: Math.max(55, Number(candidateScore || 0)),
            searchEngine: "opml_feed_discovery",
            commonFeedDirect,
            opmlDepth: opmlDepth + 1,
          });
        }
        break;
      }
      const discoveredNext = feedNextPageUrls(text, currentFeedUrl, 1)[0] || null;
      const feedRawCount = countOpenSearchDirectRawResults(text);
      rawCount += feedRawCount;
      const pageItems = parseOpenSearchDirectResults(text, keyword, {
        target,
        template: { template: currentFeedUrl, type: commonFeedDirect ? "common-feed-direct" : "feed-discovery" },
        limit: limit - items.length,
        diagnostics,
      });
      for (const item of pageItems) {
        items.push({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            discovery_search_engine: searchEngine,
            discovery_feed_url: currentFeedUrl,
            ...(seedUrl ? { discovery_feed_source_url: seedUrl } : {}),
            discovery_feed_candidate_label: label || currentFeedUrl,
            discovery_feed_candidate_source: candidateSource || (commonFeedDirect ? "derived-common-feed-endpoint" : ""),
            discovery_feed_candidate_score: Number(candidateScore || 0),
            discovery_feed_raw_result_count: feedRawCount,
            discovery_feed_page: page + 1,
            discovery_feed_page_url_source: page > 0 ? currentSource || "feed-next" : candidateSource || (commonFeedDirect ? "derived-common-feed-endpoint" : "feed-entrypoint"),
            discovery_feed_next_page_url: discoveredNext?.url || "",
            discovery_feed_next_page_source: discoveredNext?.source || "",
            ...(commonFeedDirect ? {
              discovery_common_feed_direct: 1,
              discovery_common_feed_raw_result_count: feedRawCount,
              discovery_common_feed_checked_count: checked,
            } : {}),
          },
        });
        if (items.length >= limit) break;
      }
      if (!discoveredNext?.url) break;
      currentFeedUrl = discoveredNext.url;
      currentSource = discoveredNext.source || "feed-next";
    }
  };
  for (const seedUrl of seeds) {
    if (items.length >= limit) break;
    const pageRes = await fetchPublicSource(seedUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.6",
        "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl).catch(err => {
      failures.push({ keyword, target: `feed-discovery-source:${seedUrl}`, message: formatSourceError(err, proxyUrl) });
      return null;
    });
    if (!pageRes?.ok) continue;
    sourcePagesChecked += 1;
    const html = await pageRes.text();
    const feeds = selectOpenWebFeedEntrypoints(html, seedUrl, 4);
    for (const feed of feeds) {
      if (items.length >= limit) break;
      await fetchFeedPages({
        initialFeedUrl: feed.url,
        seedUrl,
        label: feed.label || "",
        candidateSource: feed.source || "",
        candidateScore: Number(feed.score || 0),
        searchEngine: "html_feed_discovery",
      });
    }
  }
  if (items.length < limit) {
    const commonFeeds = targetCommonFeedCandidateUrls(target, 8);
    for (const feedUrl of commonFeeds) {
      if (items.length >= limit) break;
      await fetchFeedPages({
        initialFeedUrl: feedUrl,
        label: feedUrl,
        candidateSource: "derived-common-feed-endpoint",
        candidateScore: 51,
        searchEngine: "common_feed_direct",
        commonFeedDirect: true,
      });
    }
  }
  return { items, rawCount, checked, sourcePagesChecked, failures };
}

function evidenceWithFailover(evidence = {}, item = {}, failoverAttribution = []) {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  return {
    ...(evidence || {}),
    evidence_type: "open_web_discovery",
    metrics: {
      ...(evidence?.metrics || {}),
      ...(item.metrics || {}),
      failover_attribution: attribution,
      failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
    },
  };
}

async function insertOpenWebItem(item, {
  keyword,
  proxyUrl,
  enrich = true,
  domainControls = {},
  contentControls = {},
  failoverAttribution = [],
  seenItemUrls = null,
}) {
  const dedupeKey = openWebDedupeKey(item);
  if (!dedupeKey) return 0;
  if (seenItemUrls instanceof Set) {
    if (seenItemUrls.has(dedupeKey)) return 0;
  }
  const fallback = item.content || "";
  const enriched = enrich
    ? await enrichSearchResultSummary(item, { proxyUrl })
    : {
      content: fallback,
      ai_summary: fallback,
      author: item.author || "",
      raw_html: item.raw_html || item.rawHtml || "",
      evidence: { metrics: item.metrics || {} },
      enriched: false,
    };
  const content = enriched.content || fallback;
  const baseUrl = enriched.evidence?.metrics?.canonical_url || enriched.evidence?.canonical_url || enriched.evidence?.metrics?.og_url || item.url;
  const entrypointMetrics = openWebEntrypointMetrics(enriched.raw_html || "", baseUrl);
  const evidenceDepthMetrics = openWebEvidenceDepthSignals({
    title: item.title,
    content,
    publishedAt: enriched.published_at || item.publishedAt,
    metrics: {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
      ...entrypointMetrics,
    },
  });
  const sentiment = analyzeSentiment(`${item.title} ${content}`);
  const result = insertSentimentItem({
    platform: "open_web",
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
    evidence: evidenceWithFailover({
      ...(enriched.evidence || {}),
      metrics: {
        ...(enriched.evidence?.metrics || {}),
        ...entrypointMetrics,
        ...evidenceDepthMetrics,
        open_web_scan_dedupe_key: dedupeKey,
      },
    }, {
      ...item,
      content,
      author: enriched.author || item.author,
      metrics: {
        ...(item.metrics || {}),
        ...entrypointMetrics,
        ...openWebKeywordDiagnostics({
          ...item,
          content,
          author: enriched.author || item.author,
          metrics: {
            ...(item.metrics || {}),
            ...entrypointMetrics,
            ...evidenceDepthMetrics,
          },
        }, keyword),
        ...evidenceDepthMetrics,
      },
    }, failoverAttribution),
    visual_assets: enriched.visual_assets || [],
    source_type: "scraper",
    domainControls,
    contentControls,
    failoverAttribution,
  });
  if (result.inserted || result.updated) {
    if (seenItemUrls instanceof Set) seenItemUrls.add(dedupeKey);
    return result.inserted ? 1 : 0;
  }
  return 0;
}

export async function scrapeOpenWebDiscovery(keywords, {
  proxyUrl = "",
  enrich = true,
  budget = {},
  targets = OPEN_WEB_DISCOVERY_TARGETS,
  searchEngines = OPEN_WEB_SEARCH_ENGINES,
  domainControls = {},
  contentControls = {},
  failoverAttribution = [],
  directUrls = [],
  since = "",
} = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const requestedEngines = Array.isArray(searchEngines) ? searchEngines : OPEN_WEB_SEARCH_ENGINES;
  const engines = requestedEngines
    .map(engine => String(engine || "").trim())
    .filter(engine => OPEN_WEB_SEARCH_ENGINES.includes(engine));
  const directTargets = normalizeDirectOpenWebUrls(directUrls);
  const queries = normalizedKeywords.flatMap(keyword => buildOpenWebQueries(keyword, targets).map(query => ({ keyword, ...query })));
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(queries, QUERY_CONCURRENCY, async ({ keyword, query, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      const found = [];
      const seenUrls = new Set();
      const configuredTemplateNextPages = new Map();
      for (let page = 0; page < normalizedBudget.maxPagesPerKeyword && found.length < normalizedBudget.maxItemsPerKeyword; page += 1) {
        let pageFound = 0;
        let rawPageFound = 0;
        let directOpenSearchRecovered = false;
        const diagnostics = [];
        if (Array.isArray(target.searchTemplates) && target.searchTemplates.length && found.length < normalizedBudget.maxItemsPerKeyword) {
          for (const template of target.searchTemplates.slice(0, 3)) {
            const templateKey = normalizeOpenSearchTemplate(template).template;
            const nextPage = configuredTemplateNextPages.get(templateKey) || null;
            const url = page > 0 && nextPage?.url
              ? nextPage.url
              : openSearchTemplateUrl(template, keyword, { page });
            if (!url) continue;
            const res = await fetchPublicSource(url, {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!res.ok) {
              failures.push({ keyword, target: target.domain, engine: "opensearch_direct", message: httpFailure(res) });
              continue;
            }
            const text = await res.text();
            const discoveredNextPage = openSearchNextPageUrls(text, url, url, 1)[0] || null;
            if (discoveredNextPage?.url) {
              configuredTemplateNextPages.set(templateKey, discoveredNextPage);
            } else {
              configuredTemplateNextPages.delete(templateKey);
            }
            const rawCount = countOpenSearchDirectRawResults(text);
            rawPageFound += rawCount;
            const pageItems = parseOpenSearchDirectResults(text, keyword, {
              target,
              template,
              limit: normalizedBudget.maxItemsPerKeyword - found.length,
              diagnostics,
            });
            for (const item of pageItems) {
              const normalized = openWebDedupeKey(item);
              if (!normalized || seenUrls.has(normalized)) continue;
              seenUrls.add(normalized);
              found.push({
                ...item,
                metrics: {
                  ...(item.metrics || {}),
                  discovery_search_page: page + 1,
                  discovery_search_raw_result_count: rawCount,
                  discovery_opensearch_template_url: url,
                  discovery_opensearch_page_url_source: page > 0 && nextPage?.url ? nextPage.source || "html-next" : "template-page-parameter",
                  discovery_opensearch_next_page_url: discoveredNextPage?.url || "",
                  discovery_opensearch_next_page_source: discoveredNextPage?.source || "",
                },
              });
              pageFound += 1;
            }
            if (found.length >= normalizedBudget.maxItemsPerKeyword) break;
          }
        }
        if (page === 0 && target.directFeedDiscovery && found.length < normalizedBudget.maxItemsPerKeyword) {
          const feedResult = await collectTargetFeedDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(feedResult.failures || []));
          rawPageFound += feedResult.rawCount;
          for (const item of feedResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: feedResult.rawCount,
                discovery_feed_checked_count: feedResult.checked || 0,
                discovery_feed_source_page_checked_count: feedResult.sourcePagesChecked || 0,
              },
            });
            pageFound += 1;
          }
        }
        if (page === 0 && target.directSitemap && found.length < normalizedBudget.maxItemsPerKeyword) {
          const sitemapResult = await collectDirectSitemapDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(sitemapResult.failures || []));
          rawPageFound += sitemapResult.rawCount;
          for (const item of sitemapResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                  ...(item.metrics || {}),
                  discovery_search_page: page + 1,
                  discovery_search_raw_result_count: sitemapResult.rawCount,
                  discovery_sitemap_checked_count: sitemapResult.checked,
                  discovery_sitemap_body_probe_checked_count: sitemapResult.bodyProbeChecked || 0,
                  discovery_sitemap_max_index_depth: sitemapResult.maxDepthReached || 0,
                },
              });
            pageFound += 1;
          }
        }
        if (page === 0 && found.length < normalizedBudget.maxItemsPerKeyword) {
          const openSearchResult = await collectTargetOpenSearchDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(openSearchResult.failures || []));
          rawPageFound += openSearchResult.rawCount;
          for (const item of openSearchResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: openSearchResult.rawCount,
                discovery_opensearch_description_checked_count: openSearchResult.checked || 0,
                discovery_opensearch_template_checked_count: openSearchResult.templatesChecked || 0,
                discovery_opensearch_source_page_checked_count: openSearchResult.sourcePagesChecked || 0,
              },
            });
            directOpenSearchRecovered = true;
            pageFound += 1;
          }
        }
        if (page === 0 && target.directOpenSearchDiscovery && !directOpenSearchRecovered && found.length < normalizedBudget.maxItemsPerKeyword) {
          const commonSearchResult = await collectTargetCommonSearchDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(commonSearchResult.failures || []));
          rawPageFound += commonSearchResult.rawCount;
          for (const item of commonSearchResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: commonSearchResult.rawCount,
                discovery_common_search_checked_count: commonSearchResult.checked || 0,
              },
            });
            pageFound += 1;
          }
        }
        if (page === 0 && target.directWordPressRest && found.length < normalizedBudget.maxItemsPerKeyword) {
          const wordpressRestResult = await collectTargetWordPressRestDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(wordpressRestResult.failures || []));
          rawPageFound += wordpressRestResult.rawCount;
          for (const item of wordpressRestResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: wordpressRestResult.rawCount,
                discovery_wordpress_rest_checked_count: wordpressRestResult.checked || 0,
              },
            });
            pageFound += 1;
          }
        }
        if (page === 0 && target.directBloggerFeed && found.length < normalizedBudget.maxItemsPerKeyword) {
          const bloggerFeedResult = await collectTargetBloggerFeedDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(bloggerFeedResult.failures || []));
          rawPageFound += bloggerFeedResult.rawCount;
          for (const item of bloggerFeedResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: bloggerFeedResult.rawCount,
                discovery_blogger_feed_checked_count: bloggerFeedResult.checked || 0,
              },
            });
            pageFound += 1;
          }
        }
        if (page === 0 && target.directDiscourseSearch && found.length < normalizedBudget.maxItemsPerKeyword) {
          const discourseSearchResult = await collectTargetDiscourseSearchDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(discourseSearchResult.failures || []));
          rawPageFound += discourseSearchResult.rawCount;
          for (const item of discourseSearchResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: discourseSearchResult.rawCount,
                discovery_discourse_search_checked_count: discourseSearchResult.checked || 0,
              },
            });
            pageFound += 1;
          }
        }
        if (page === 0 && target.directMediaWikiSearch && found.length < normalizedBudget.maxItemsPerKeyword) {
          const mediaWikiSearchResult = await collectTargetMediaWikiSearchDiscoveryResults({
            keyword,
            target,
            proxyUrl,
            limit: normalizedBudget.maxItemsPerKeyword - found.length,
            maxPages: normalizedBudget.maxPagesPerKeyword,
            diagnostics,
          });
          failures.push(...(mediaWikiSearchResult.failures || []));
          rawPageFound += mediaWikiSearchResult.rawCount;
          for (const item of mediaWikiSearchResult.items) {
            const normalized = openWebDedupeKey(item);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            found.push({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                discovery_search_page: page + 1,
                discovery_search_raw_result_count: mediaWikiSearchResult.rawCount,
                discovery_mediawiki_checked_count: mediaWikiSearchResult.checked || 0,
              },
            });
            pageFound += 1;
          }
        }
        if (engines.includes("duckduckgo")) {
          const params = new URLSearchParams({ q: query, kl: "wt-wt" });
          if (page > 0) params.set("s", String(page * 30));
          const url = `https://duckduckgo.com/html/?${params.toString()}`;
          const res = await fetchPublicSource(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, target: target.domain, engine: "duckduckgo", message: httpFailure(res) });
          } else {
            const html = await res.text();
            const rawCount = countDuckDuckGoDiscoveryRawResults(html);
            rawPageFound += rawCount;
            const pageItems = parseDuckDuckGoDiscoveryResults(html, keyword, {
              target,
              limit: normalizedBudget.maxItemsPerKeyword - found.length,
              diagnostics,
            });
            for (const item of pageItems) {
              const normalized = openWebDedupeKey(item);
              if (!normalized || seenUrls.has(normalized)) continue;
              seenUrls.add(normalized);
              found.push({
                ...item,
                metrics: {
                  ...(item.metrics || {}),
                  discovery_search_page: page + 1,
                  discovery_search_raw_result_count: rawCount,
                },
              });
              pageFound += 1;
            }
          }
        }
        if (page === 0 && engines.includes("bing_rss") && found.length < normalizedBudget.maxItemsPerKeyword) {
          const params = new URLSearchParams({ q: query, format: "rss" });
          const url = `https://www.bing.com/search?${params.toString()}`;
          const res = await fetchPublicSource(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
              "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, target: target.domain, engine: "bing_rss", message: httpFailure(res) });
          } else {
            const xml = await res.text();
            const rawCount = countBingRssDiscoveryRawResults(xml);
            rawPageFound += rawCount;
            const pageItems = parseBingRssDiscoveryResults(xml, keyword, {
              target,
              limit: normalizedBudget.maxItemsPerKeyword - found.length,
              diagnostics,
            });
            for (const item of pageItems) {
              const normalized = openWebDedupeKey(item);
              if (!normalized || seenUrls.has(normalized)) continue;
              seenUrls.add(normalized);
              found.push({
                ...item,
                metrics: {
                  ...(item.metrics || {}),
                  discovery_search_page: page + 1,
                  discovery_search_raw_result_count: rawCount,
                },
              });
              pageFound += 1;
            }
          }
        }
        if (engines.includes("mojeek") && found.length < normalizedBudget.maxItemsPerKeyword) {
          const params = new URLSearchParams({ q: query });
          if (page > 0) params.set("s", String(page * 10 + 1));
          const url = `https://www.mojeek.com/search?${params.toString()}`;
          const res = await fetchPublicSource(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "text/html,application/xhtml+xml",
              "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, target: target.domain, engine: "mojeek", message: httpFailure(res) });
          } else {
            const html = await res.text();
            const rawCount = countMojeekDiscoveryRawResults(html);
            rawPageFound += rawCount;
            const pageItems = parseMojeekDiscoveryResults(html, keyword, {
              target,
              query,
              limit: normalizedBudget.maxItemsPerKeyword - found.length,
              diagnostics,
            });
            for (const item of pageItems) {
              const normalized = openWebDedupeKey(item);
              if (!normalized || seenUrls.has(normalized)) continue;
              seenUrls.add(normalized);
              found.push({
                ...item,
                metrics: {
                  ...(item.metrics || {}),
                  discovery_search_page: page + 1,
                  discovery_search_raw_result_count: rawCount,
                },
              });
              pageFound += 1;
            }
          }
        }
        if (engines.includes("wiby") && found.length < normalizedBudget.maxItemsPerKeyword) {
          const params = new URLSearchParams({ q: query });
          if (page > 0) params.set("p", String(page + 1));
          const url = `https://wiby.me/?${params.toString()}`;
          const res = await fetchPublicSource(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "text/html,application/xhtml+xml",
              "Accept-Language": "zh-TW,zh-Hant,zh-CN,en;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, target: target.domain, engine: "wiby", message: httpFailure(res) });
          } else {
            const html = await res.text();
            const rawCount = countWibyDiscoveryRawResults(html);
            rawPageFound += rawCount;
            const pageItems = parseWibyDiscoveryResults(html, keyword, {
              target,
              query,
              limit: normalizedBudget.maxItemsPerKeyword - found.length,
              diagnostics,
            });
            for (const item of pageItems) {
              const normalized = openWebDedupeKey(item);
              if (!normalized || seenUrls.has(normalized)) continue;
              seenUrls.add(normalized);
              found.push({
                ...item,
                metrics: {
                  ...(item.metrics || {}),
                  discovery_search_page: page + 1,
                  discovery_search_raw_result_count: rawCount,
                },
              });
              pageFound += 1;
            }
          }
        }
        if (diagnostics.length) recordOpenWebRejectionDiagnostics(diagnostics.slice(0, 20));
        if (!pageFound && !rawPageFound) break;
      }
      for (const item of found) {
        inserted += await insertOpenWebItem(item, { keyword, proxyUrl, enrich, domainControls, contentControls, failoverAttribution, seenItemUrls });
        if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.domain, message });
      console.warn(`[CRM/OpenWebDiscovery] 抓取失敗 target=${target.domain} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  const directResults = directTargets.length
    ? await mapWithConcurrency(normalizedKeywords, QUERY_CONCURRENCY, async (keyword) => {
      let inserted = 0;
      const failures = [];
      for (const target of directTargets.slice(0, normalizedBudget.maxItemsPerKeyword)) {
        try {
          const enriched = await enrichSearchResultSummary({
            url: target.url,
            title: `Open web article: ${keyword}`,
            content: keyword,
          }, { proxyUrl });
          const item = parseDirectOpenWebArticle(enriched, keyword, target, { since });
          if (!item) continue;
          inserted += await insertOpenWebItem(item, {
            keyword,
            proxyUrl,
            enrich: false,
            domainControls,
            contentControls,
            failoverAttribution,
            seenItemUrls,
          });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        } catch (err) {
          failures.push({ keyword, target: `open-web-direct:${target.url}`, message: formatSourceError(err, proxyUrl) });
        }
      }
      return { inserted, failures };
    })
    : [];

  return scraperResult(
    [...results, ...directResults].reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...results, ...directResults].flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  OPEN_WEB_DISCOVERY_TARGETS,
  buildOpenWebQueries,
  inferTargetProfile,
  extractOpenWebEntrypoints,
  extractOpenWebStructuredFollowupLinks,
  extractOpenWebPlatformRelations,
  isLowSignalListingUrl,
  normalizeBudget,
  normalizeOpenWebDedupeUrl,
  directOpenWebUrlTarget,
  normalizeDirectOpenWebUrls,
  openWebDedupeKey,
  normalizeOpenWebKeywordText,
  openWebKeywordNeedles,
  openWebValueMatchesKeyword,
  openWebKeywordMatchSource,
  openWebKeywordDiagnostics,
  openWebDiscoveryPriorityBucket,
  openWebDiscoveryPriorityMetrics,
  matchedOpenWebTerms,
  openWebEvidenceDepthBucket,
  openWebPublishedAgeDays,
  openWebEvidenceDepthSignals,
  parseDirectOpenWebArticle,
  openWebDeepCrawlTargets,
  normalizeTargets,
  openSearchTemplateUrl,
  openWebEntrypointMetrics,
  parseOpenSearchDirectResults,
  parseOpenSearchDescriptionTemplates,
  openSearchNextPageUrls,
  collectTargetOpenSearchDiscoveryResults,
  targetCommonSearchCandidateTemplates,
  collectTargetCommonSearchDiscoveryResults,
  targetWordPressRestCandidateUrls,
  wordpressRestPageUrl,
  parseWordPressRestResults,
  collectTargetWordPressRestDiscoveryResults,
  targetBloggerFeedCandidateUrls,
  bloggerFeedPageUrl,
  bloggerFeedNextUrl,
  parseBloggerFeedResults,
  collectTargetBloggerFeedDiscoveryResults,
  targetDiscourseSearchCandidateUrls,
  discourseSearchPageUrl,
  parseDiscourseSearchResults,
  collectTargetDiscourseSearchDiscoveryResults,
  targetMediaWikiSearchCandidateUrls,
  mediaWikiSearchPageUrl,
  parseMediaWikiSearchResults,
  collectTargetMediaWikiSearchDiscoveryResults,
  targetSitemapCandidateUrls,
  targetRobotsUrl,
  parseRobotsSitemapUrls,
  parseSitemapXmlEntries,
  sitemapPathDatePriority,
  selectDirectSitemapChildren,
  selectDirectSitemapSeedUrls,
  sitemapEntryMetadataText,
  sitemapBodyProbePriority,
  selectSitemapBodyProbeCandidates,
  parseSitemapBodyProbeArticle,
  readSitemapResponseText,
  parseSitemapDiscoveryResults,
  collectTargetFeedDiscoveryResults,
  feedNextPageUrls,
  parseOpmlFeedEntrypoints,
  targetFeedDiscoverySeedUrls,
  targetCommonFeedCandidateUrls,
  selectOpenWebFeedEntrypoints,
  selectOpenWebSearchEntrypoints,
  parseMojeekDiscoveryResults,
  parseWibyDiscoveryResults,
  parseBingRssDiscoveryResults,
  parseDuckDuckGoDiscoveryResults,
  countBingRssDiscoveryRawResults,
  countMojeekDiscoveryRawResults,
  countWibyDiscoveryRawResults,
  countDuckDuckGoDiscoveryRawResults,
  countOpenSearchDirectRawResults,
  querySuffixForTarget,
  scoreOpenWebDiscoveryCandidate,
};
