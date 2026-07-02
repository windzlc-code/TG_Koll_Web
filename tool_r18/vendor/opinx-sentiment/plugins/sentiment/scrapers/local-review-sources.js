import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_TARGET = 4;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 8;
const DEFAULT_MAX_PAGES_PER_TARGET = 3;

export const LOCAL_REVIEW_TARGETS = [
  {
    key: "yelp",
    name: "Yelp",
    siteQuery: "site:yelp.com/biz reviews",
    hostPattern: /(^|\.)yelp\.com$/i,
    tags: ["local", "service", "review", "rating", "restaurant", "retail"],
    profiles: ["global", "us", "local", "service", "restaurant", "retail", "review"],
    tier: "local-review-platform",
    signalKind: "local-business-review",
  },
  {
    key: "tripadvisor",
    name: "Tripadvisor",
    siteQuery: "site:tripadvisor.com reviews",
    hostPattern: /(^|\.)tripadvisor\.[a-z.]+$/i,
    tags: ["local", "travel", "hospitality", "review", "rating"],
    profiles: ["global", "travel", "hotel", "restaurant", "local", "review"],
    tier: "travel-review-platform",
    signalKind: "travel-hospitality-review",
  },
  {
    key: "googleMaps",
    name: "Google Maps Public Business Profiles",
    siteQuery: "site:google.com/maps/place reviews",
    hostPattern: /(^|\.)google\.[a-z.]+$/i,
    tags: ["local", "maps", "business-profile", "review", "rating"],
    profiles: ["global", "local", "maps", "service", "retail", "review"],
    tier: "local-business-profile",
    signalKind: "local-business-profile",
  },
  {
    key: "foursquare",
    name: "Foursquare",
    siteQuery: "site:foursquare.com/v reviews tips",
    hostPattern: /(^|\.)foursquare\.com$/i,
    tags: ["local", "venue", "tips", "review", "rating"],
    profiles: ["global", "local", "venue", "restaurant", "retail", "review"],
    tier: "local-review-platform",
    signalKind: "local-venue-tip-review",
  },
  {
    key: "opentable",
    name: "OpenTable",
    siteQuery: "site:opentable.com/r reviews",
    hostPattern: /(^|\.)opentable\.com$/i,
    tags: ["local", "restaurant", "hospitality", "review", "rating"],
    profiles: ["global", "restaurant", "hospitality", "local", "review"],
    tier: "hospitality-review-platform",
    signalKind: "restaurant-review",
  },
  {
    key: "trustanalytica",
    name: "TrustAnalytica Local Reviews",
    siteQuery: "site:trustanalytica.com/reviews",
    hostPattern: /(^|\.)trustanalytica\.com$/i,
    tags: ["local", "service", "review", "rating", "complaint"],
    profiles: ["global", "local", "service", "professional-services", "review", "complaint"],
    tier: "local-review-platform",
    signalKind: "local-service-review",
  },
  {
    key: "yellowPages",
    name: "Yellow Pages Reviews",
    siteQuery: "site:yellowpages.com reviews",
    hostPattern: /(^|\.)yellowpages\.com$/i,
    tags: ["local", "business-directory", "review", "rating"],
    profiles: ["us", "local", "service", "business-directory", "review"],
    tier: "local-business-directory",
    signalKind: "local-directory-review",
  },
  {
    key: "restaurantGuru",
    name: "Restaurant Guru",
    siteQuery: "site:restaurantguru.com reviews",
    hostPattern: /(^|\.)restaurantguru\.com$/i,
    tags: ["local", "restaurant", "hospitality", "review", "rating"],
    profiles: ["global", "restaurant", "hospitality", "local", "review"],
    tier: "hospitality-review-platform",
    signalKind: "restaurant-review",
  },
];

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(value, max = 1200) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeUrl(rawUrl) {
  const decoded = decodeHtml(rawUrl || "");
  try {
    const url = new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return normalizeUrl(decodeURIComponent(uddg));
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeLocalReviewDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeLocalReviewDedupeUrl(embedded);
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
    url.hostname = url.hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return String(normalized || "").toLowerCase();
  }
}

function localReviewDedupeKey(item = {}) {
  return normalizeLocalReviewDedupeUrl(item?.url || "");
}

function countDuckDuckGoRawResults(html = "") {
  return [...String(html || "").matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href=/gi)].length;
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerTarget || budget.max_items_per_target || budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_TARGET));
  const maxTargets = Math.round(Number(budget.maxTargetsPerKeyword || budget.max_targets_per_keyword || DEFAULT_MAX_TARGETS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerTarget || budget.max_pages_per_target || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_TARGET));
  return {
    maxItemsPerTarget: Number.isFinite(maxItems) ? Math.max(1, Math.min(12, maxItems)) : DEFAULT_MAX_ITEMS_PER_TARGET,
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(LOCAL_REVIEW_TARGETS.length, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
    maxPagesPerTarget: Number.isFinite(maxPages) ? Math.max(1, Math.min(5, maxPages)) : DEFAULT_MAX_PAGES_PER_TARGET,
  };
}

function normalizeProfileValues(values = []) {
  if (!values) return [];
  const raw = Array.isArray(values) ? values : String(values).split(/[,\s，、;；]+/);
  return raw.map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function targetMatchesProfiles(target = {}, targetProfiles = []) {
  const profiles = normalizeProfileValues(targetProfiles);
  if (!profiles.length) return true;
  const values = new Set([
    ...(target.profiles || []),
    ...(target.tags || []),
    target.tier,
    target.key,
    target.name,
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  return profiles.some(profile => values.has(profile));
}

function normalizeTargets(targets = [], targetProfiles = []) {
  const configured = Array.isArray(targets) ? targets.map(item => String(item || "").trim()).filter(Boolean) : [];
  const candidates = LOCAL_REVIEW_TARGETS.filter(target => targetMatchesProfiles(target, targetProfiles));
  if (!configured.length) return candidates.length ? candidates : LOCAL_REVIEW_TARGETS;
  const wanted = new Set(configured.map(item => item.toLowerCase()));
  const selected = candidates.filter(target => wanted.has(target.key.toLowerCase()) || wanted.has(target.name.toLowerCase()));
  return selected.length ? selected : (candidates.length ? candidates : LOCAL_REVIEW_TARGETS);
}

function normalizeDirectUrls(directUrls = []) {
  const raw = Array.isArray(directUrls)
    ? directUrls
    : typeof directUrls === "string"
      ? directUrls.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeUrl(value);
    const dedupe = normalizeLocalReviewDedupeUrl(normalized);
    if (!normalized || !dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
  }
  return out;
}

function hostMatches(url, pattern) {
  try {
    return pattern.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isConcreteLocalReviewUrl(url = "", target = {}) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (!hostMatches(url, target.hostPattern)) return false;
    if (target.key === "yelp") return path.includes("/biz/");
    if (target.key === "tripadvisor") return /\/(?:hotel_review|restaurant_review|attraction_review|showuserreviews)-/i.test(path) || /reviews/i.test(path);
    if (target.key === "googleMaps") return path.includes("/maps/place") || path.includes("/maps/");
    if (target.key === "foursquare") return path.includes("/v/") || path.includes("/venue/");
    if (target.key === "opentable") return path.includes("/r/");
    if (target.key === "trustanalytica") return path.includes("/reviews");
    if (target.key === "yellowPages") return path.includes("/mip/") || path.includes("/reviews");
    if (target.key === "restaurantGuru") return path.length > 1;
    return true;
  } catch {
    return false;
  }
}

function directLocalReviewTargets(directUrls = [], selectedTargets = []) {
  const targets = Array.isArray(selectedTargets) && selectedTargets.length ? selectedTargets : LOCAL_REVIEW_TARGETS;
  const out = [];
  const seen = new Set();
  for (const url of normalizeDirectUrls(directUrls)) {
    for (const target of targets) {
      if (!isConcreteLocalReviewUrl(url, target)) continue;
      const dedupe = `${target.key}|${normalizeLocalReviewDedupeUrl(url)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ url, target });
      break;
    }
  }
  return out;
}

function directLocalReviewItem(url = "", keyword = "", target = {}) {
  const cleanedUrl = normalizeUrl(url);
  if (!cleanedUrl || !isConcreteLocalReviewUrl(cleanedUrl, target)) return null;
  let title = `${keyword || ""} ${target.name || "local review"}`.replace(/\s+/g, " ").trim();
  try {
    const parsed = new URL(cleanedUrl);
    const slug = decodeURIComponent(parsed.pathname || "")
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join(" ")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (slug) title = `${keyword || ""} ${target.name || ""} ${slug}`.replace(/\s+/g, " ").trim();
  } catch {
    // Keep fallback title.
  }
  return {
    url: cleanedUrl,
    title,
    content: "",
    author: target.name,
    publishedAt: new Date().toISOString(),
    targetKey: target.key,
    targetName: target.name,
    targetTags: target.tags,
    signalKind: target.signalKind || "local-service-review",
    directUrl: true,
    matchedKeyword: keyword,
    searchPage: 0,
    searchRawResultCount: 1,
  };
}

function normalizeLocalReviewKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function localReviewKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeLocalReviewKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function localReviewValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeLocalReviewKeywordText(value);
  return localReviewKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeLocalReviewKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function parseLocalReviewSearchResults(html, keyword, target, limit = DEFAULT_MAX_ITEMS_PER_TARGET) {
  const source = String(html || "");
  const results = [];
  const blockRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const url = normalizeUrl(match[1]);
    const title = cleanText(match[2], 240);
    const content = cleanText((match[3].match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || match[3].match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || [])[1] || "", 1000);
    if (!url || !title) continue;
    if (!isConcreteLocalReviewUrl(url, target)) continue;
    if (!localReviewValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    results.push({
      url,
      title,
      content,
      author: target.name,
      publishedAt: new Date().toISOString(),
      targetKey: target.key,
      targetName: target.name,
      targetTags: target.tags,
      signalKind: target.signalKind || "local-service-review",
    });
    if (results.length >= limit) break;
  }
  return results;
}

function localReviewKeywordMatchSource(item = {}, keyword = "", target = {}) {
  if (!localReviewKeywordNeedles(keyword).length) return "";
  if (localReviewValueMatchesKeyword(item.title, keyword)) return "title";
  if (localReviewValueMatchesKeyword(item.content, keyword)) return "snippet";
  if (localReviewValueMatchesKeyword(item.url, keyword)) return "url";
  const targetText = [
    target.name,
    target.key,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  if (localReviewValueMatchesKeyword(targetText, keyword)) return "target_metadata";
  return "search_query";
}

function localReviewTermMatches(text = "", terms = []) {
  const source = normalizeLocalReviewKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeLocalReviewKeywordText(term);
    return needle && source.includes(needle);
  });
}

function localServiceRiskSignals({ item = {}, target = {}, content = "", metrics = {} } = {}) {
  const metricText = Object.values(metrics)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => cleanText(value, 400))
    .filter(Boolean)
    .join(" ");
  const targetText = [
    target.name,
    target.key,
    target.tier,
    target.signalKind,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  const text = cleanText(`${item.title || ""} ${item.content || ""} ${content || ""} ${targetText} ${metricText}`, 7000).toLowerCase();
  const reasons = [];
  let score = /local|hospitality|travel|restaurant|review/i.test(String(target.tier || target.signalKind || "")) ? 12 : 8;
  const out = {};
  const evidenceTerms = localReviewTermMatches(text, [
    "photo", "photos", "video", "receipt", "invoice", "booking number", "reservation number", "order number", "screenshot", "proof", "timeline",
    "照片", "相片", "影片", "視頻", "视频", "收據", "收据", "發票", "发票", "預約編號", "预约编号", "訂單", "订单", "截圖", "截图", "證據", "证据",
  ]);
  const responseTerms = localReviewTermMatches(text, [
    "owner response", "manager response", "business response", "staff replied", "apology", "resolved", "unresolved", "refund issued", "follow up",
    "店家回應", "店家回应", "商家回應", "商家回应", "經理回應", "经理回应", "道歉", "致歉", "已解決", "已解决", "未解決", "未解决", "後續", "后续",
  ]);
  const escalationTerms = localReviewTermMatches(text, [
    "health department", "food safety", "police", "lawsuit", "insurance claim", "consumer protection", "chargeback", "local news", "media",
    "衛生局", "卫生局", "食安", "食品安全", "報警", "报警", "警察", "提告", "保險", "保险", "消保", "媒體", "媒体", "新聞", "新闻",
  ]);
  const spreadTerms = localReviewTermMatches(text, [
    "viral", "shared", "social media", "facebook", "instagram", "tiktok", "youtube", "reddit", "google reviews", "yelp reviews",
    "轉發", "转发", "轉傳", "转传", "瘋傳", "疯传", "社群", "社媒", "抖音", "小紅書", "小红书", "新聞", "新闻",
  ]);
  const incidentImpactTerms = localReviewTermMatches(text, [
    "bad experience", "poor experience", "in-store experience", "long wait", "missed reservation", "refund", "chargeback", "food poisoning", "injury", "unsafe", "dirty", "health department", "local news",
    "糟糕體驗", "糟糕体验", "門店體驗", "门店体验", "等很久", "未保留訂位", "未保留订位", "退款", "退費", "退费", "食物中毒", "受傷", "受伤", "不安全", "衛生局", "卫生局", "新聞", "新闻",
  ]);
  const businessActionTerms = localReviewTermMatches(text, [
    "owner response", "manager response", "business response", "apology", "refund issued", "resolved", "unresolved", "follow up", "investigation", "corrective action", "reopened",
    "店家回應", "店家回应", "商家回應", "商家回应", "經理回應", "经理回应", "道歉", "致歉", "已退款", "已解決", "已解决", "未解決", "未解决", "調查", "调查", "整改",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("local_review_complaint_signal", "complaint or dispute language", /complaint|dispute|bad experience|poor experience|投訴|投诉|抱怨|糾紛|纠纷|差評|差评/i.test(text), 14);
  addSignal("local_review_refund_signal", "refund, chargeback, or payment dispute", /refund|chargeback|overcharge|wrong charge|退費|退费|退款|扣款|多收|亂收費|乱收费/i.test(text), 12);
  addSignal("local_review_staff_service_signal", "staff or customer service concern", /rude staff|staff|service|customer service|front desk|客服|員工|员工|態度|态度|服務|服务|櫃檯|柜台/i.test(text), 10);
  addSignal("local_review_wait_reservation_signal", "wait, queue, booking, or appointment concern", /wait|waiting|queue|reservation|booking|appointment|no-show|排隊|排队|等很久|預約|预约|訂位|订位/i.test(text), 8);
  addSignal("local_review_cleanliness_safety_signal", "cleanliness, hygiene, or physical safety concern", /dirty|cleanliness|sanitary|unsafe|injury|food poisoning|hygiene|衛生|卫生|髒|脏|安全|受傷|受伤|食物中毒/i.test(text), 16);
  addSignal("local_review_pricing_signal", "pricing or hidden fee concern", /overpriced|price|hidden fee|expensive|charge|價格|价格|收費|收费|昂貴|昂贵|亂收費|乱收费/i.test(text), 8);
  addSignal("local_review_food_hospitality_signal", "food, restaurant, hotel, or hospitality context", /food|meal|restaurant|hotel|room|hospitality|餐|餐廳|餐厅|飯店|酒店|旅館|房間/i.test(text), 6);
  addSignal("local_review_accessibility_signal", "location, parking, or accessibility concern", /parking|location|accessibility|wheelchair|hard to find|停車|停车|位置|無障礙|无障碍|輪椅|轮椅/i.test(text), 6);
  addSignal("local_review_low_rating_signal", "low rating or one-star language", /low rating|bad rating|negative review|one star|1 star|差評|差评|低評分|低评分|一星/i.test(text), 10);
  addSignal("local_review_local_service_signal", "local business or service review source", /local|service|restaurant|hospitality|travel|review|rating|venue|business|maps|本地|商家|服務|服务|評價|评价/i.test(targetText), 6);
  addSignal("local_review_evidence_language_signal", "local review contains evidence language", evidenceTerms.length > 0, 12);
  addSignal("local_review_response_language_signal", "owner or manager response language", responseTerms.length > 0, 10);
  addSignal("local_review_escalation_language_signal", "health, legal, police, or media escalation language", escalationTerms.length > 0, 14);
  addSignal("local_review_spread_language_signal", "cross-platform or media spread language", spreadTerms.length > 0, 10);
  addSignal("local_review_incident_impact_signal", "customer incident impact, in-store failure, refund, safety, health, or media impact language", incidentImpactTerms.length > 0, 10);
  addSignal("local_review_business_action_signal", "owner, manager, refund, investigation, corrective, or resolution action language", businessActionTerms.length > 0, 8);

  const semanticSignals = [
    out.local_review_complaint_signal,
    out.local_review_refund_signal,
    out.local_review_staff_service_signal,
    out.local_review_wait_reservation_signal,
    out.local_review_cleanliness_safety_signal,
    out.local_review_pricing_signal,
    out.local_review_food_hospitality_signal,
    out.local_review_accessibility_signal,
    out.local_review_low_rating_signal,
    out.local_review_local_service_signal,
    out.local_review_evidence_language_signal,
    out.local_review_response_language_signal,
    out.local_review_escalation_language_signal,
    out.local_review_spread_language_signal,
    out.local_review_incident_impact_signal,
    out.local_review_business_action_signal,
  ].filter(Boolean).length;
  addSignal(
    "local_review_complete_service_crisis_narrative_signal",
    "complete local service crisis narrative with complaint, incident impact, evidence, business response or escalation, and spread context",
    semanticSignals >= 7
      && out.local_review_complaint_signal
      && out.local_review_incident_impact_signal
      && out.local_review_evidence_language_signal
      && (out.local_review_response_language_signal || out.local_review_business_action_signal || out.local_review_escalation_language_signal)
      && out.local_review_spread_language_signal,
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    local_review_service_risk_score: boundedScore,
    local_review_service_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    local_review_signal_count: signalFields.length,
    local_review_semantic_signal_count: semanticSignals,
    local_review_signal_reasons: [...new Set(reasons)].slice(0, 16),
    local_review_evidence_terms: evidenceTerms,
    local_review_response_terms: responseTerms,
    local_review_escalation_terms: escalationTerms,
    local_review_spread_terms: spreadTerms,
    local_review_incident_impact_terms: incidentImpactTerms,
    local_review_business_action_terms: businessActionTerms,
  };
}

function evidenceWithLocalReviewMetadata(evidence = {}, item = {}, target = {}, failoverAttribution = [], content = "") {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const evidenceMetrics = evidence?.metrics || {};
  return {
    ...(evidence || {}),
    source_key: "localReviewSources",
    evidence_type: "local_review_source_result",
    metrics: {
      ...evidenceMetrics,
      ...localServiceRiskSignals({ item, target, content, metrics: evidenceMetrics }),
      source: "local_review_source_search",
      local_review_site: target.name || item.targetName || "",
      local_review_site_key: target.key || item.targetKey || "",
      local_signal_kind: target.signalKind || item.signalKind || "local-service-review",
      site_tags: Array.isArray(target.tags) ? target.tags : item.targetTags || [],
      target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
      source_weight_tier: target.tier || "",
      source_family: "review",
      reputation_axis: "local-service-experience",
      local_review_canonical_dedupe_url: localReviewDedupeKey(item),
      local_review_search_scan_dedupe_key: localReviewDedupeKey(item),
      local_review_search_page: Math.max(1, Number(item.searchPage) || 1),
      local_review_search_raw_result_count: Math.max(0, Number(item.searchRawResultCount) || 0),
      local_review_matched_keyword: item.matchedKeyword || "",
      local_review_keyword_match_source: localReviewKeywordMatchSource(item, item.matchedKeyword || "", target),
      local_review_direct_url: item.directUrl ? item.url : "",
      local_review_direct_url_recovery: Boolean(item.directUrl),
      local_review_collection_mode: item.directUrl ? "direct-url" : "search",
      ...(attribution.length ? {
        failover_attribution: attribution,
        failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
      } : {}),
    },
  };
}

async function insertLocalReviewItems(items, { keyword, proxyUrl, enrich, target, seenItemUrls = null, domainControls = {}, contentControls = {}, failoverAttribution = [] }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = localReviewDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const fallback = item.content || "";
    const enriched = enrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: fallback, ai_summary: fallback, enriched: false };
    const content = enriched.content || fallback;
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "local_review_sources",
      url: item.url,
      title: item.title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
      keyword,
      keywords: [keyword, ...(Array.isArray(target.tags) ? target.tags : [])].filter(Boolean),
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary,
      raw_html: enriched.raw_html || "",
      evidence: evidenceWithLocalReviewMetadata(enriched.evidence || {}, item, target, failoverAttribution, content),
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      domainControls,
      contentControls,
      failoverAttribution,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeLocalReviewSources(keywords, { proxyUrl = "", enrich = true, budget = {}, targets = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const selectedTargets = normalizeTargets(targets, targetProfiles).slice(0, normalizedBudget.maxTargetsPerKeyword);
  const seenItemUrls = new Set();
  let directInserted = 0;
  const directFailures = [];
  const directKeyword = normalizedKeywords[0] || "local-review-direct-url";
  for (const { url, target } of directLocalReviewTargets(normalizedDirectUrls, selectedTargets)) {
    try {
      const item = directLocalReviewItem(url, directKeyword, target);
      if (!item) continue;
      directInserted += await insertLocalReviewItems([item], {
        keyword: directKeyword,
        proxyUrl,
        enrich: true,
        target,
        seenItemUrls,
        domainControls,
        contentControls,
        failoverAttribution,
      });
    } catch (err) {
      directFailures.push({ keyword: directKeyword, target: url, message: formatSourceError(err, proxyUrl) });
    }
  }
  if (!normalizedKeywords.length) return scraperResult(directInserted, directFailures);
  const tasks = normalizedKeywords.flatMap(keyword => selectedTargets.map(target => ({ keyword, target })));

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    const query = `${keyword} local review rating complaint service experience ${target.siteQuery}`;
    try {
      const found = [];
      const seenUrls = new Set();
      for (let page = 0; page < normalizedBudget.maxPagesPerTarget && found.length < normalizedBudget.maxItemsPerTarget; page += 1) {
        const params = new URLSearchParams({ q: query, kl: "us-en" });
        if (page > 0) params.set("s", String(page * 30));
        const url = `https://duckduckgo.com/html/?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: target.name, page: page + 1, message: httpFailure(res) });
          break;
        }
        const html = await res.text();
        const rawCount = countDuckDuckGoRawResults(html);
        const items = parseLocalReviewSearchResults(html, keyword, target, normalizedBudget.maxItemsPerTarget - found.length);
        let pageFound = 0;
        for (const item of items) {
          const dedupeKey = localReviewDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          found.push({ ...item, searchPage: page + 1, searchRawResultCount: rawCount, matchedKeyword: keyword });
          pageFound += 1;
          if (found.length >= normalizedBudget.maxItemsPerTarget) break;
        }
        if (!pageFound && !rawCount) break;
      }
      inserted += await insertLocalReviewItems(found, { keyword, proxyUrl, enrich, target, seenItemUrls, domainControls, contentControls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.name, message });
      console.warn(`[CRM/LocalReviewSources] 抓取失敗 keyword=${keyword} target=${target.name}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    directInserted + results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directFailures, ...results.flatMap(result => result?.failures || [])],
  );
}

export const __test__ = {
  isConcreteLocalReviewUrl,
  normalizeBudget,
  normalizeDirectUrls,
  directLocalReviewTargets,
  directLocalReviewItem,
  normalizeTargets,
  normalizeProfileValues,
  targetMatchesProfiles,
  normalizeLocalReviewKeywordText,
  localReviewValueMatchesKeyword,
  normalizeLocalReviewDedupeUrl,
  localReviewDedupeKey,
  countDuckDuckGoRawResults,
  parseLocalReviewSearchResults,
  localReviewKeywordMatchSource,
  localServiceRiskSignals,
  LOCAL_REVIEW_TARGETS,
};
