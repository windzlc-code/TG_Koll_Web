import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_TARGET = 4;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 12;
const DEFAULT_MAX_PAGES_PER_TARGET = 3;

export const PUBLIC_REVIEW_SITE_TARGETS = [
  {
    key: "trustpilot",
    name: "Trustpilot",
    siteQuery: "site:trustpilot.com/review",
    hostPattern: /(^|\.)trustpilot\.com$/i,
    tags: ["review", "rating", "complaint", "customer-experience"],
    profiles: ["global", "consumer", "review"],
    tier: "review-platform",
  },
  {
    key: "bbb",
    name: "BBB Customer Reviews and Complaints",
    siteQuery: "site:bbb.org/us",
    hostPattern: /(^|\.)bbb\.org$/i,
    tags: ["complaint", "review", "business-profile", "consumer"],
    profiles: ["us", "consumer", "complaint", "trusted"],
    tier: "consumer-complaint",
  },
  {
    key: "sitejabber",
    name: "Sitejabber",
    siteQuery: "site:sitejabber.com/reviews",
    hostPattern: /(^|\.)sitejabber\.com$/i,
    tags: ["review", "rating", "complaint"],
    profiles: ["global", "consumer", "review"],
    tier: "review-platform",
  },
  {
    key: "complaintsboard",
    name: "ComplaintsBoard",
    siteQuery: "site:complaintsboard.com",
    hostPattern: /(^|\.)complaintsboard\.com$/i,
    tags: ["complaint", "consumer", "review"],
    profiles: ["global", "consumer", "complaint"],
    tier: "complaint-board",
  },
  {
    key: "pissedconsumer",
    name: "PissedConsumer",
    siteQuery: "site:pissedconsumer.com",
    hostPattern: /(^|\.)pissedconsumer\.com$/i,
    tags: ["complaint", "consumer", "review"],
    profiles: ["us", "consumer", "complaint"],
    tier: "complaint-board",
  },
  {
    key: "productreview",
    name: "ProductReview",
    siteQuery: "site:productreview.com.au",
    hostPattern: /(^|\.)productreview\.com\.au$/i,
    tags: ["review", "rating", "consumer"],
    profiles: ["australia", "consumer", "review"],
    tier: "review-platform",
  },
  {
    key: "consumerAffairs",
    name: "ConsumerAffairs",
    siteQuery: "site:consumeraffairs.com",
    hostPattern: /(^|\.)consumeraffairs\.com$/i,
    tags: ["review", "rating", "complaint", "consumer"],
    profiles: ["us", "consumer", "review", "complaint"],
    tier: "review-platform",
  },
  {
    key: "reviewsIo",
    name: "Reviews.io",
    siteQuery: "site:reviews.io/company-reviews",
    hostPattern: /(^|\.)reviews\.io$/i,
    tags: ["review", "rating", "customer-experience"],
    profiles: ["global", "consumer", "review", "ecommerce"],
    tier: "review-platform",
  },
  {
    key: "mouthShut",
    name: "MouthShut",
    siteQuery: "site:mouthshut.com/review",
    hostPattern: /(^|\.)mouthshut\.com$/i,
    tags: ["review", "rating", "complaint", "consumer"],
    profiles: ["india", "consumer", "review", "complaint"],
    tier: "review-platform",
  },
  {
    key: "hellopeter",
    name: "Hellopeter",
    siteQuery: "site:hellopeter.com/reviews",
    hostPattern: /(^|\.)hellopeter\.com$/i,
    tags: ["review", "complaint", "consumer", "customer-experience"],
    profiles: ["south-africa", "consumer", "review", "complaint"],
    tier: "review-platform",
  },
  {
    key: "reclameAqui",
    name: "Reclame Aqui",
    siteQuery: "site:reclameaqui.com.br complaint review consumidor",
    hostPattern: /(^|\.)reclameaqui\.com\.br$/i,
    tags: ["brazil", "latin-america", "complaint", "consumer", "review"],
    profiles: ["brazil", "latin-america", "consumer", "complaint", "review"],
    tier: "regional-consumer-review",
  },
  {
    key: "apestan",
    name: "Apestan",
    siteQuery: "site:apestan.com complaint opinion consumidor",
    hostPattern: /(^|\.)apestan\.com$/i,
    tags: ["latin-america", "spanish", "complaint", "consumer", "review"],
    profiles: ["latin-america", "spanish", "consumer", "complaint", "review"],
    tier: "regional-consumer-review",
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
    if (uddg) return decodeURIComponent(uddg);
    url.hash = "";
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizePublicReviewDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizePublicReviewDedupeUrl(embedded);
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

function publicReviewDedupeKey(item = {}) {
  return normalizePublicReviewDedupeUrl(item?.url || "");
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
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(PUBLIC_REVIEW_SITE_TARGETS.length, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
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
  const candidates = PUBLIC_REVIEW_SITE_TARGETS.filter(target => targetMatchesProfiles(target, targetProfiles));
  if (!configured.length) return candidates.length ? candidates : PUBLIC_REVIEW_SITE_TARGETS;
  const wanted = new Set(configured.map(item => item.toLowerCase()));
  const selected = candidates.filter(target => wanted.has(target.key.toLowerCase()) || wanted.has(target.name.toLowerCase()));
  return selected.length ? selected : (candidates.length ? candidates : PUBLIC_REVIEW_SITE_TARGETS);
}

function normalizeDirectUrls(directUrls = []) {
  return [...new Set((Array.isArray(directUrls) ? directUrls : [])
    .map(url => normalizePublicReviewDedupeUrl(url))
    .filter(url => /^https?:\/\//i.test(url)))].slice(0, 40);
}

function directPublicReviewTargets(directUrls = [], selectedTargets = []) {
  const targets = Array.isArray(selectedTargets) && selectedTargets.length ? selectedTargets : PUBLIC_REVIEW_SITE_TARGETS;
  const out = [];
  const seen = new Set();
  for (const url of normalizeDirectUrls(directUrls)) {
    const target = targets.find(candidate => hostMatches(url, candidate.hostPattern));
    if (!target) continue;
    const dedupeKey = `${target.key}:${normalizePublicReviewDedupeUrl(url)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ url, target });
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

function normalizePublicReviewKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function publicReviewKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizePublicReviewKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function publicReviewValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizePublicReviewKeywordText(value);
  return publicReviewKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizePublicReviewKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function parsePublicReviewSearchResults(html, keyword, target, limit = DEFAULT_MAX_ITEMS_PER_TARGET) {
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
    if (!hostMatches(url, target.hostPattern)) continue;
    if (!publicReviewValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    results.push({
      url,
      title,
      content,
      author: target.name,
      publishedAt: new Date().toISOString(),
      targetKey: target.key,
      targetName: target.name,
      targetTags: target.tags,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function publicReviewKeywordMatchSource(item = {}, keyword = "", target = {}) {
  if (!publicReviewKeywordNeedles(keyword).length) return "";
  if (publicReviewValueMatchesKeyword(item.title, keyword)) return "title";
  if (publicReviewValueMatchesKeyword(item.content, keyword)) return "snippet";
  if (publicReviewValueMatchesKeyword(item.url, keyword)) return "url";
  const targetText = [
    target.name,
    target.key,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  if (publicReviewValueMatchesKeyword(targetText, keyword)) return "target_metadata";
  return "search_query";
}

function directPublicReviewItem(url = "", keyword = "", target = {}) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return target.name || "public review site";
    }
  })();
  return {
    url,
    title: `${cleanText(keyword, 120)} ${target.name || host} public review`.trim(),
    content: `${cleanText(keyword, 120)} public review complaint evidence from ${target.name || host}`,
    author: target.name || host,
    publishedAt: new Date().toISOString(),
    targetKey: target.key,
    targetName: target.name,
    targetTags: target.tags,
    matchedKeyword: keyword,
    searchPage: 0,
    searchRawResultCount: 1,
    directUrl: true,
  };
}

function publicReviewTermMatches(text = "", terms = []) {
  const source = normalizePublicReviewKeywordText(text);
  return terms.filter(term => {
    const needle = normalizePublicReviewKeywordText(term);
    return needle && source.includes(needle);
  });
}

function publicReviewCrisisSignals({ item = {}, target = {}, content = "", metrics = {} } = {}) {
  const metricText = Object.values(metrics)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => cleanText(value, 400))
    .filter(Boolean)
    .join(" ");
  const targetText = [
    target.name,
    target.key,
    target.tier,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  const text = cleanText(`${item.title || ""} ${item.content || ""} ${content || ""} ${targetText} ${metricText}`, 7000).toLowerCase();
  const rating = Number(metrics.review_rating ?? metrics.rating_value ?? metrics.aggregate_rating_value ?? metrics.review_average_rating);
  const bestRating = Number(metrics.review_best_rating || metrics.best_rating || 5);
  const ratingCount = Number(metrics.review_rating_count || metrics.review_count || metrics.aggregate_rating_count || 0);
  const normalizedRating = Number.isFinite(rating) && rating > 0 && Number.isFinite(bestRating) && bestRating > 0
    ? (rating / bestRating) * 5
    : 0;
  const reasons = [];
  let score = target.tier === "consumer-complaint" || target.tier === "complaint-board" ? 18 : 10;
  const out = {};
  const evidenceTerms = publicReviewTermMatches(text, [
    "screenshot", "screen recording", "proof", "receipt", "invoice", "order number", "case number", "ticket", "chat log", "timeline", "documents",
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "收據", "收据", "發票", "发票", "訂單", "订单", "案件編號", "案件编号",
    "工單", "工单", "聊天紀錄", "聊天记录", "時間線", "时间线", "文件",
  ]);
  const responseTerms = publicReviewTermMatches(text, [
    "business response", "company response", "official response", "resolved", "unresolved", "reply from", "customer service replied", "apology", "clarification",
    "商家回應", "商家回应", "企業回應", "企业回应", "官方回應", "官方回应", "客服回應", "客服回应", "已解決", "已解决",
    "未解決", "未解决", "道歉", "致歉", "澄清",
  ]);
  const escalationTerms = publicReviewTermMatches(text, [
    "regulator", "consumer protection", "bbb complaint", "attorney general", "lawsuit", "legal action", "class action", "media", "press", "chargeback",
    "監管", "监管", "消保", "消費者保護", "消费者保护", "主管機關", "投诉平台", "投訴平台", "法律", "提告", "集體訴訟",
    "集体诉讼", "媒體", "媒体", "退刷", "拒付",
  ]);
  const spreadTerms = publicReviewTermMatches(text, [
    "viral", "shared", "social media", "reddit", "facebook", "twitter", "x post", "tiktok", "youtube", "news coverage",
    "轉發", "转发", "轉傳", "转传", "瘋傳", "疯传", "社群", "社媒", "微博", "抖音", "小紅書", "小红书", "新聞", "新闻",
  ]);
  const consumerImpactTerms = publicReviewTermMatches(text, [
    "refund", "chargeback", "money back", "billing dispute", "unauthorized charge", "not delivered", "lost package", "unsafe", "injury", "data breach", "account hacked", "class action",
    "退款", "退費", "退费", "拒付", "扣款", "未送達", "未送达", "丟件", "丢件", "不安全", "受傷", "受伤", "資料外洩", "数据泄露", "帳號被盜", "账号被盗", "集體訴訟", "集体诉讼",
  ]);
  const resolutionTerms = publicReviewTermMatches(text, [
    "resolved", "unresolved", "refund issued", "replacement sent", "case closed", "investigation", "apology", "corrective action", "business response", "company response", "customer service replied",
    "已解決", "已解决", "未解決", "未解决", "已退款", "已補發", "已补发", "結案", "结案", "調查", "调查", "道歉", "致歉", "整改", "商家回應", "商家回应",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("public_review_complaint_signal", "complaint or dispute language", /complaint|complaints|dispute|grievance|issue|problem|escalation|unresolved|投訴|投诉|客訴|客诉|爭議|争议|維權|维权/i.test(text), 12);
  addSignal("public_review_refund_signal", "refund, chargeback, or money-back issue", /refund|chargeback|money back|billing dispute|overcharge|unauthorized charge|退款|退費|扣款|拒退|退货|退貨/i.test(text), 14);
  addSignal("public_review_customer_service_signal", "customer support failure", /customer service|customer support|support ticket|no response|ignored|unanswered|silence|客服|售後|售后|不回覆|不回复|無回應|无回应/i.test(text), 12);
  addSignal("public_review_fraud_scam_signal", "fraud, scam, or deceptive practice allegation", /fraud|scam|deceptive|misleading|fake|bait and switch|ripoff|phishing|詐騙|诈骗|欺诈|欺詐|騙局|骗局|虛假|虚假/i.test(text), 16);
  addSignal("public_review_safety_signal", "safety, injury, or dangerous product issue", /safety|unsafe|dangerous|injury|injured|fire|burn|electric shock|hazard|recall|defect|安全|危險|危险|受傷|受伤|召回|缺陷/i.test(text), 16);
  addSignal("public_review_privacy_signal", "privacy, data, or account security issue", /privacy|data breach|personal data|account hacked|hacked|security|leak|個資|个人信息|個人資料|資料外洩|数据泄露|隱私|隐私|帳號被盜|账号被盗/i.test(text), 14);
  addSignal("public_review_quality_signal", "poor product or service quality", /poor quality|bad quality|defective|broken|does not work|not working|failed|buggy|品質差|质量差|故障|不能用|壞了|坏了/i.test(text), 10);
  addSignal("public_review_delivery_signal", "delivery, shipping, or fulfillment failure", /delivery|shipping|shipment|late arrival|not delivered|lost package|fulfillment|物流|配送|未送達|未送达|延遲|延迟/i.test(text), 8);
  addSignal("public_review_subscription_billing_signal", "subscription cancellation or billing issue", /subscription|cancel|cancellation|auto-renew|recurring charge|billing|invoice|trial|訂閱|订阅|取消|自動續費|自动续费|账单|帳單/i.test(text), 10);
  addSignal("public_review_account_access_signal", "account lockout or access issue", /account locked|locked out|login|cannot access|disabled account|suspended account|帳號|账号|登入|登录|封號|封号|凍結|冻结/i.test(text), 8);
  addSignal("public_review_low_rating_signal", "low public rating", normalizedRating > 0 && normalizedRating <= 2, 18);
  addSignal("public_review_review_volume_signal", "material review volume", Number.isFinite(ratingCount) && ratingCount >= 20, ratingCount >= 100 ? 10 : 6);
  addSignal("public_review_evidence_language_signal", "review contains evidence language", evidenceTerms.length > 0, 12);
  addSignal("public_review_response_language_signal", "business response or unresolved response language", responseTerms.length > 0, 10);
  addSignal("public_review_escalation_language_signal", "regulatory, legal, or chargeback escalation language", escalationTerms.length > 0, 14);
  addSignal("public_review_spread_language_signal", "cross-platform or media spread language", spreadTerms.length > 0, 10);
  addSignal("public_review_consumer_impact_signal", "consumer impact involving refund, chargeback, delivery, safety, privacy, account, or legal harm", consumerImpactTerms.length > 0, 10);
  addSignal("public_review_resolution_language_signal", "resolution, refund, replacement, investigation, apology, or corrective action language", resolutionTerms.length > 0, 8);

  const semanticSignals = [
    out.public_review_complaint_signal,
    out.public_review_refund_signal,
    out.public_review_customer_service_signal,
    out.public_review_fraud_scam_signal,
    out.public_review_safety_signal,
    out.public_review_privacy_signal,
    out.public_review_quality_signal,
    out.public_review_delivery_signal,
    out.public_review_subscription_billing_signal,
    out.public_review_account_access_signal,
    out.public_review_low_rating_signal,
    out.public_review_review_volume_signal,
    out.public_review_evidence_language_signal,
    out.public_review_response_language_signal,
    out.public_review_escalation_language_signal,
    out.public_review_spread_language_signal,
    out.public_review_consumer_impact_signal,
    out.public_review_resolution_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "public_review_complete_consumer_crisis_narrative_signal",
    "complete consumer crisis narrative with complaint, consumer impact, evidence, response or escalation, and spread or material rating context",
    semanticSignals >= 8
      && out.public_review_complaint_signal
      && out.public_review_consumer_impact_signal
      && out.public_review_evidence_language_signal
      && (out.public_review_response_language_signal || out.public_review_resolution_language_signal || out.public_review_escalation_language_signal)
      && (out.public_review_spread_language_signal || out.public_review_review_volume_signal || out.public_review_low_rating_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    public_review_crisis_score: boundedScore,
    public_review_crisis_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    public_review_signal_count: signalFields.length,
    public_review_semantic_signal_count: semanticSignals,
    public_review_signal_reasons: [...new Set(reasons)].slice(0, 16),
    public_review_evidence_terms: evidenceTerms,
    public_review_response_terms: responseTerms,
    public_review_escalation_terms: escalationTerms,
    public_review_spread_terms: spreadTerms,
    public_review_consumer_impact_terms: consumerImpactTerms,
    public_review_resolution_terms: resolutionTerms,
    ...(normalizedRating > 0 ? { public_review_normalized_rating: Number(normalizedRating.toFixed(2)) } : {}),
  };
}

function evidenceWithReviewMetadata(evidence = {}, item = {}, target = {}, failoverAttribution = [], content = "") {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const evidenceMetrics = evidence?.metrics || {};
  return {
    ...(evidence || {}),
    source_key: "publicReviewSites",
    evidence_type: "public_review_site_result",
    metrics: {
      ...evidenceMetrics,
      ...publicReviewCrisisSignals({ item, target, content, metrics: evidenceMetrics }),
      source: "public_review_site_search",
      review_site: target.name || item.targetName || "",
      review_site_key: target.key || item.targetKey || "",
      site_tags: Array.isArray(target.tags) ? target.tags : item.targetTags || [],
      target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
      source_weight_tier: target.tier || "",
      source_family: "review",
      public_review_canonical_dedupe_url: publicReviewDedupeKey(item),
      public_review_search_scan_dedupe_key: publicReviewDedupeKey(item),
      public_review_search_page: Math.max(1, Number(item.searchPage) || 1),
      public_review_search_raw_result_count: Math.max(0, Number(item.searchRawResultCount) || 0),
      public_review_matched_keyword: item.matchedKeyword || "",
      public_review_keyword_match_source: publicReviewKeywordMatchSource(item, item.matchedKeyword || "", target),
      ...(item.directUrl ? {
        source: "public_review_site_direct_url",
        collection_mode: "public_review_direct_url",
        public_review_direct_url: normalizePublicReviewDedupeUrl(item.url),
      } : {}),
      ...(attribution.length ? {
        failover_attribution: attribution,
        failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
      } : {}),
    },
  };
}

async function insertReviewItems(items, { keyword, proxyUrl, enrich, target, seenItemUrls = null, domainControls = {}, contentControls = {}, failoverAttribution = [] }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = publicReviewDedupeKey(item);
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
      platform: "public_review_sites",
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
      evidence: evidenceWithReviewMetadata(enriched.evidence || {}, item, target, failoverAttribution, content),
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

export async function scrapePublicReviewSites(keywords, { proxyUrl = "", enrich = true, budget = {}, targets = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const selectedTargets = normalizeTargets(targets, targetProfiles).slice(0, normalizedBudget.maxTargetsPerKeyword);
  const tasks = normalizedKeywords.flatMap(keyword => selectedTargets.map(target => ({ keyword, target })));
  const seenItemUrls = new Set();
  const directTargets = directPublicReviewTargets(directUrls, selectedTargets);

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    const query = `${keyword} complaint review rating ${target.siteQuery}`;
    try {
      const directItems = directTargets
        .filter(item => item.target.key === target.key)
        .slice(0, normalizedBudget.maxItemsPerTarget)
        .map(item => directPublicReviewItem(item.url, keyword, target));
      inserted += await insertReviewItems(directItems, { keyword, proxyUrl, enrich: true, target, seenItemUrls, domainControls, contentControls, failoverAttribution });
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
        const items = parsePublicReviewSearchResults(html, keyword, target, normalizedBudget.maxItemsPerTarget - found.length);
        let pageFound = 0;
        for (const item of items) {
          const dedupeKey = publicReviewDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          found.push({ ...item, searchPage: page + 1, searchRawResultCount: rawCount, matchedKeyword: keyword });
          pageFound += 1;
          if (found.length >= normalizedBudget.maxItemsPerTarget) break;
        }
        if (!pageFound && !rawCount) break;
      }
      inserted += await insertReviewItems(found, { keyword, proxyUrl, enrich, target, seenItemUrls, domainControls, contentControls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.name, message });
      console.warn(`[CRM/PublicReviewSites] 抓取失敗 keyword=${keyword} target=${target.name}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  normalizeBudget,
  normalizeTargets,
  normalizeProfileValues,
  targetMatchesProfiles,
  normalizeDirectUrls,
  directPublicReviewTargets,
  directPublicReviewItem,
  normalizePublicReviewDedupeUrl,
  publicReviewDedupeKey,
  countDuckDuckGoRawResults,
  parsePublicReviewSearchResults,
  normalizePublicReviewKeywordText,
  publicReviewValueMatchesKeyword,
  publicReviewKeywordMatchSource,
  publicReviewCrisisSignals,
  PUBLIC_REVIEW_SITE_TARGETS,
};
