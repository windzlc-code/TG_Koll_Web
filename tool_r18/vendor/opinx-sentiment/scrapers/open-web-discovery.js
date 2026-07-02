import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem, recordSentimentSourceQualitySample } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const QUERY_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const OPEN_WEB_SEARCH_ENGINES = ["duckduckgo", "bing_rss"];

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
  if (/knowledge|question|zhihu|知乎/.test(raw) || /zhihu\.com/i.test(lowerDomain)) return "knowledge";
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
    || (normalizedProfile === "knowledge" && /(zhihu\.com\/(?:question|pin|zvideo|search)|quora\.com\/(?:[^/]+\/)?(?:answer|questions?)|questions?\/|answers?\/|如何看待)/.test(lowerUrl))
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
  if (/\/(?:rss|atom)(?:\.xml|\.json|\/|$)|\/feed(?:\.xml|\.json|\/?$)|\/index\.json\b|feedburner|rss|atom|json feed|訂閱|订阅/.test(text)) return "rss-feed";
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

function openWebDeepCrawlTargets(entrypoints = [], platformRelations = []) {
  const seen = new Set();
  const pushTarget = (out, item = {}, sourceCandidateType = "open-web-entrypoint") => {
    const url = item.url || "";
    const dedupe = normalizeOpenWebDedupeUrl(url);
    if (!dedupe || seen.has(dedupe)) return;
    seen.add(dedupe);
    const isRelation = sourceCandidateType === "open-web-platform-relation";
    const targetType = isRelation ? openWebRelationTargetType(item.kind || "") : openWebEntrypointTargetType(item.kind || "");
    out.push({
      url,
      label: item.label || url,
      kind: item.kind || "",
      target_type: targetType,
      source_candidate_type: sourceCandidateType,
      score: Math.max(0, Math.min(100, Math.round(Number(item.score || 0)))),
      priority_reasons: openWebTargetReasons(isRelation ? "open-web-platform-relation" : "open-web-entrypoint", item),
      same_host: Boolean(item.same_host),
      source: item.source || "",
    });
  };
  const out = [];
  const orderedEntrypoints = [...entrypoints].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const orderedRelations = [...platformRelations].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  for (const item of orderedEntrypoints) pushTarget(out, item, "open-web-entrypoint");
  for (const item of orderedRelations) pushTarget(out, item, "open-web-platform-relation");
  return out.slice(0, 24);
}

function openWebEntrypointMetrics(html = "", baseUrl = "") {
  const entrypoints = extractOpenWebEntrypoints(html, baseUrl);
  const platformRelations = extractOpenWebPlatformRelations(html, baseUrl);
  const byKind = (kind) => entrypoints.filter(item => item.kind === kind);
  const relationsByKind = (kind) => platformRelations.filter(item => item.kind === kind);
  const deepCrawlTargets = openWebDeepCrawlTargets(entrypoints, platformRelations);
  return {
    open_web_entrypoint_count: entrypoints.length,
    open_web_entrypoints: entrypoints,
    open_web_platform_relation_count: platformRelations.length,
    open_web_platform_relations: platformRelations,
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
    const normalized = {
      domain,
      siteScope: scope,
      profile: inferredProfile,
      candidateType: cleanText(item.candidate_type || item.candidateType || "", 140),
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
      sourceUrl: cleanText(item.url || "", 500),
      score: Number(item.score || 0),
      sourceWeightTier,
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

function openSearchTemplateUrl(template = {}, keyword = "") {
  const normalized = normalizeOpenSearchTemplate(template);
  const raw = normalized.template;
  const term = cleanText(keyword, 160);
  if (!raw || !term) return "";
  const encoded = encodeURIComponent(term);
  const replaced = raw
    .replace(/\{searchTerms\??\}/gi, encoded)
    .replace(/\{count\??\}/gi, "20")
    .replace(/\{startIndex\??\}/gi, "0")
    .replace(/\{startPage\??\}/gi, "1")
    .replace(/\{language\??\}/gi, "zh-TW")
    .replace(/\{inputEncoding\??\}/gi, "UTF-8")
    .replace(/\{outputEncoding\??\}/gi, "UTF-8");
  try {
    return new URL(replaced).toString();
  } catch {
    return "";
  }
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

function countOpenSearchDirectRawResults(text = "") {
  const source = String(text || "");
  const rssItems = [...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].length;
  const atomEntries = [...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)].length;
  const anchors = [...source.matchAll(/<a\b[^>]*href=["'][^"']+["'][^>]*>/gi)].length;
  return rssItems + atomEntries + anchors;
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

function parseOpenSearchDirectResults(text = "", keyword = "", { target = {}, template = {}, limit = 10, diagnostics = null } = {}) {
  const source = String(text || "");
  const results = [];
  const push = ({ url = "", title = "", content = "", publishedAt = "" } = {}) => {
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
      author: target.domain || "OpenSearch",
      publishedAt: normalizePublishedAt(publishedAt),
      metrics: {
        ...openSearchResultMetrics({ target, template, score }),
        discovery_canonical_dedupe_url: normalizeOpenWebDedupeUrl(normalized),
      },
    });
  };
  const rssBlocks = [...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].map(match => match[0]);
  for (const block of rssBlocks) {
    push({
      url: tagValue(block, "link") || tagValue(block, "guid"),
      title: tagValue(block, "title"),
      content: tagValue(block, "description"),
      publishedAt: tagValue(block, "pubDate"),
    });
    if (results.length >= limit) return results.slice(0, limit);
  }
  const atomBlocks = [...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)].map(match => match[0]);
  for (const block of atomBlocks) {
    const linkTag = (block.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i) || block.match(/<link\b[^>]*>/i) || [])[0] || "";
    push({
      url: tagValue(block, "link") || cleanText((linkTag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "", 1000),
      title: tagValue(block, "title"),
      content: tagValue(block, "summary") || tagValue(block, "content"),
      publishedAt: tagValue(block, "published") || tagValue(block, "updated"),
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
    seenItemUrls.add(dedupeKey);
  }
  const fallback = item.content || "";
  const enriched = enrich
    ? await enrichSearchResultSummary(item, { proxyUrl })
    : { content: fallback, ai_summary: fallback, enriched: false };
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
  return result.inserted ? 1 : 0;
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
} = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const engines = (Array.isArray(searchEngines) && searchEngines.length ? searchEngines : OPEN_WEB_SEARCH_ENGINES)
    .map(engine => String(engine || "").trim())
    .filter(engine => OPEN_WEB_SEARCH_ENGINES.includes(engine));
  const queries = normalizedKeywords.flatMap(keyword => buildOpenWebQueries(keyword, targets).map(query => ({ keyword, ...query })));
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(queries, QUERY_CONCURRENCY, async ({ keyword, query, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      const found = [];
      const seenUrls = new Set();
      for (let page = 0; page < normalizedBudget.maxPagesPerKeyword && found.length < normalizedBudget.maxItemsPerKeyword; page += 1) {
        let pageFound = 0;
        let rawPageFound = 0;
        const diagnostics = [];
        if (page === 0 && Array.isArray(target.searchTemplates) && target.searchTemplates.length && found.length < normalizedBudget.maxItemsPerKeyword) {
          for (const template of target.searchTemplates.slice(0, 3)) {
            const url = openSearchTemplateUrl(template, keyword);
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
                },
              });
              pageFound += 1;
            }
            if (found.length >= normalizedBudget.maxItemsPerKeyword) break;
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

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  OPEN_WEB_DISCOVERY_TARGETS,
  buildOpenWebQueries,
  inferTargetProfile,
  extractOpenWebEntrypoints,
  extractOpenWebPlatformRelations,
  isLowSignalListingUrl,
  normalizeBudget,
  normalizeOpenWebDedupeUrl,
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
  openWebDeepCrawlTargets,
  normalizeTargets,
  openSearchTemplateUrl,
  openWebEntrypointMetrics,
  parseOpenSearchDirectResults,
  parseBingRssDiscoveryResults,
  parseDuckDuckGoDiscoveryResults,
  countBingRssDiscoveryRawResults,
  countDuckDuckGoDiscoveryRawResults,
  countOpenSearchDirectRawResults,
  querySuffixForTarget,
  scoreOpenWebDiscoveryCandidate,
};
