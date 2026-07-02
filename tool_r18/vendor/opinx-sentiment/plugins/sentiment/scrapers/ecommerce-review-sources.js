import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_TARGET = 4;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 15;
const DEFAULT_MAX_PAGES_PER_TARGET = 3;

export const ECOMMERCE_REVIEW_TARGETS = [
  {
    key: "amazon",
    name: "Amazon Reviews",
    siteQuery: "site:amazon.com product reviews",
    hostPattern: /(^|\.)amazon\.com$/i,
    tags: ["marketplace", "review", "rating", "ecommerce"],
    profiles: ["us", "global", "marketplace", "ecommerce", "retail"],
    tier: "major-marketplace",
  },
  {
    key: "ebay",
    name: "eBay Listings and Reviews",
    siteQuery: "site:ebay.com/itm",
    hostPattern: /(^|\.)ebay\.com$/i,
    tags: ["marketplace", "seller", "review", "ecommerce"],
    profiles: ["us", "global", "marketplace", "seller", "ecommerce"],
    tier: "major-marketplace",
  },
  {
    key: "etsy",
    name: "Etsy Listings and Reviews",
    siteQuery: "site:etsy.com/listing",
    hostPattern: /(^|\.)etsy\.com$/i,
    tags: ["marketplace", "seller", "review", "ecommerce"],
    profiles: ["us", "global", "marketplace", "seller", "ecommerce"],
    tier: "marketplace",
  },
  {
    key: "walmart",
    name: "Walmart Reviews",
    siteQuery: "site:walmart.com/ip reviews",
    hostPattern: /(^|\.)walmart\.com$/i,
    tags: ["retail", "review", "rating", "ecommerce"],
    profiles: ["us", "retail", "ecommerce", "review"],
    tier: "major-retail",
  },
  {
    key: "bestBuy",
    name: "Best Buy Reviews",
    siteQuery: "site:bestbuy.com/site reviews",
    hostPattern: /(^|\.)bestbuy\.com$/i,
    tags: ["retail", "electronics", "review", "rating"],
    profiles: ["us", "retail", "electronics", "review"],
    tier: "major-retail",
  },
  {
    key: "target",
    name: "Target Reviews",
    siteQuery: "site:target.com/p reviews",
    hostPattern: /(^|\.)target\.com$/i,
    tags: ["retail", "review", "rating", "ecommerce"],
    profiles: ["us", "retail", "ecommerce", "review"],
    tier: "major-retail",
  },
  {
    key: "costco",
    name: "Costco Reviews",
    siteQuery: "site:costco.com reviews",
    hostPattern: /(^|\.)costco\.com$/i,
    tags: ["retail", "review", "rating", "ecommerce"],
    profiles: ["us", "retail", "ecommerce", "review"],
    tier: "major-retail",
  },
  {
    key: "newegg",
    name: "Newegg Reviews",
    siteQuery: "site:newegg.com/p reviews",
    hostPattern: /(^|\.)newegg\.com$/i,
    tags: ["retail", "electronics", "review", "rating"],
    profiles: ["us", "retail", "electronics", "ecommerce", "review"],
    tier: "major-retail",
  },
  {
    key: "aliexpress",
    name: "AliExpress Reviews",
    siteQuery: "site:aliexpress.com/item reviews",
    hostPattern: /(^|\.)aliexpress\.com$/i,
    tags: ["marketplace", "cross-border", "seller", "review", "ecommerce"],
    profiles: ["global", "marketplace", "cross-border", "seller", "ecommerce", "review"],
    tier: "marketplace",
  },
  {
    key: "shopeeTaiwan",
    name: "Shopee Taiwan",
    siteQuery: "site:shopee.tw",
    hostPattern: /(^|\.)shopee\.tw$/i,
    tags: ["taiwan", "marketplace", "review", "rating"],
    profiles: ["taiwan", "marketplace", "ecommerce", "review"],
    tier: "regional-marketplace",
  },
  {
    key: "pchome",
    name: "PChome 24h",
    siteQuery: "site:24h.pchome.com.tw/prod",
    hostPattern: /(^|\.)24h\.pchome\.com\.tw$/i,
    tags: ["taiwan", "retail", "review", "ecommerce"],
    profiles: ["taiwan", "retail", "ecommerce", "review"],
    tier: "regional-retail",
  },
  {
    key: "momo",
    name: "momo Shopping",
    siteQuery: "site:momoshop.com.tw/goods",
    hostPattern: /(^|\.)momoshop\.com\.tw$/i,
    tags: ["taiwan", "retail", "review", "ecommerce"],
    profiles: ["taiwan", "retail", "ecommerce", "review"],
    tier: "regional-retail",
  },
  {
    key: "lazada",
    name: "Lazada",
    siteQuery: "site:lazada.sg/products reviews",
    hostPattern: /(^|\.)lazada\.(sg|com\.my|co\.th|co\.id|com\.ph|vn)$/i,
    tags: ["asia", "marketplace", "review", "rating", "ecommerce"],
    profiles: ["asia", "southeast-asia", "marketplace", "ecommerce", "review"],
    tier: "regional-marketplace",
  },
  {
    key: "tokopedia",
    name: "Tokopedia",
    siteQuery: "site:tokopedia.com",
    hostPattern: /(^|\.)tokopedia\.com$/i,
    tags: ["indonesia", "marketplace", "review", "ecommerce"],
    profiles: ["indonesia", "southeast-asia", "marketplace", "ecommerce", "review"],
    tier: "regional-marketplace",
  },
  {
    key: "rakutenJapan",
    name: "Rakuten Japan",
    siteQuery: "site:rakuten.co.jp review",
    hostPattern: /(^|\.)rakuten\.co\.jp$/i,
    tags: ["japan", "marketplace", "review", "rating", "ecommerce"],
    profiles: ["japan", "marketplace", "ecommerce", "review"],
    tier: "regional-marketplace",
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

function normalizeEcommerceReviewDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  try {
    const url = new URL(normalized);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeEcommerceReviewDedupeUrl(embedded);
    }
    url.hash = "";
    for (const param of [
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
      url.searchParams.delete(param);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return String(normalized || "").split("#")[0].trim();
  }
}

function ecommerceReviewDedupeKey(item = {}) {
  return normalizeEcommerceReviewDedupeUrl(item.url || item.link || "");
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
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(ECOMMERCE_REVIEW_TARGETS.length, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
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
  const candidates = ECOMMERCE_REVIEW_TARGETS.filter(target => targetMatchesProfiles(target, targetProfiles));
  if (!configured.length) return candidates.length ? candidates : ECOMMERCE_REVIEW_TARGETS;
  const wanted = new Set(configured.map(item => item.toLowerCase()));
  const selected = candidates.filter(target => wanted.has(target.key.toLowerCase()) || wanted.has(target.name.toLowerCase()));
  return selected.length ? selected : (candidates.length ? candidates : ECOMMERCE_REVIEW_TARGETS);
}

function normalizeDirectUrls(directUrls = []) {
  return [...new Set((Array.isArray(directUrls) ? directUrls : [])
    .map(url => normalizeEcommerceReviewDedupeUrl(url))
    .filter(url => /^https?:\/\//i.test(url)))].slice(0, 50);
}

function directEcommerceReviewTargets(directUrls = [], selectedTargets = []) {
  const targets = Array.isArray(selectedTargets) && selectedTargets.length ? selectedTargets : ECOMMERCE_REVIEW_TARGETS;
  const seen = new Set();
  const out = [];
  for (const url of normalizeDirectUrls(directUrls)) {
    const target = targets.find(candidate => hostMatches(url, candidate.hostPattern));
    if (!target) continue;
    const dedupeKey = `${target.key}:${normalizeEcommerceReviewDedupeUrl(url)}`;
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

function normalizeEcommerceReviewKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function ecommerceReviewKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeEcommerceReviewKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function ecommerceReviewValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeEcommerceReviewKeywordText(value);
  return ecommerceReviewKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeEcommerceReviewKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function parseEcommerceReviewSearchResults(html, keyword, target, limit = DEFAULT_MAX_ITEMS_PER_TARGET) {
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
    if (!ecommerceReviewValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
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

function ecommerceReviewKeywordMatchSource(item = {}, keyword = "", target = {}) {
  if (!ecommerceReviewKeywordNeedles(keyword).length) return "";
  if (ecommerceReviewValueMatchesKeyword(item.title, keyword)) return "title";
  if (ecommerceReviewValueMatchesKeyword(item.content, keyword)) return "snippet";
  if (ecommerceReviewValueMatchesKeyword(item.url, keyword)) return "url";
  const targetText = [
    target.name,
    target.key,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  if (ecommerceReviewValueMatchesKeyword(targetText, keyword)) return "target_metadata";
  return "search_query";
}

function directEcommerceReviewItem(url = "", keyword = "", target = {}) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return target.name || "ecommerce review source";
    }
  })();
  return {
    url,
    title: `${cleanText(keyword, 120)} ${target.name || host} marketplace review`.trim(),
    content: `${cleanText(keyword, 120)} ecommerce marketplace review and fulfillment evidence from ${target.name || host}`,
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

function ecommerceReviewTermMatches(text = "", terms = []) {
  const source = normalizeEcommerceReviewKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeEcommerceReviewKeywordText(term);
    return needle && source.includes(needle);
  });
}

function ecommerceFulfillmentRiskSignals({ item = {}, target = {}, content = "", metrics = {} } = {}) {
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
  const reasons = [];
  let score = /major-marketplace|major-retail|regional-marketplace|regional-retail/i.test(String(target.tier || "")) ? 14 : 10;
  const out = {};
  const evidenceTerms = ecommerceReviewTermMatches(text, [
    "order number", "tracking number", "receipt", "invoice", "photo", "video", "screenshot", "proof", "unboxing", "chat log", "ticket",
    "訂單編號", "订单编号", "物流單號", "物流单号", "追蹤號碼", "追踪号码", "收據", "收据", "發票", "发票", "照片", "影片",
    "開箱", "开箱", "截圖", "截图", "證據", "证据", "聊天紀錄", "聊天记录", "工單", "工单",
  ]);
  const platformInterventionTerms = ecommerceReviewTermMatches(text, [
    "marketplace claim", "a-to-z claim", "platform dispute", "seller dispute", "case opened", "buyer protection", "platform support",
    "平台介入", "平台申訴", "平台申诉", "賣家糾紛", "卖家纠纷", "買家保障", "买家保障", "客服介入", "申訴", "申诉",
  ]);
  const fulfillmentTraceTerms = ecommerceReviewTermMatches(text, [
    "tracking", "warehouse", "carrier", "customs", "last mile", "delivered but missing", "lost package", "delayed shipment",
    "物流", "倉庫", "仓库", "快遞", "快递", "海關", "海关", "已送達但未收到", "已送达但未收到", "丟件", "丢件", "延遲出貨", "延迟发货",
  ]);
  const spreadTerms = ecommerceReviewTermMatches(text, [
    "mass complaints", "many buyers", "viral", "social media", "facebook group", "reddit", "tiktok", "youtube", "news",
    "大量投訴", "大量投诉", "很多買家", "很多买家", "集體", "集体", "社群", "社媒", "轉發", "转发", "新聞", "新闻",
  ]);
  const responseTerms = ecommerceReviewTermMatches(text, [
    "seller replied", "merchant replied", "platform replied", "official response", "refund issued", "resolved", "replacement sent",
    "apology", "case resolved", "dispute resolved", "buyer protection approved", "claim approved",
    "賣家回覆", "卖家回复", "商家回覆", "商家回复", "平台回覆", "平台回复", "官方回應", "官方回应",
    "已退款", "退款完成", "已解決", "已解决", "補寄", "补寄", "道歉", "糾紛已處理", "纠纷已处理", "申訴成立", "申诉成立",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("ecommerce_refund_signal", "refund or chargeback issue", /refund|chargeback|return denied|no refund|money back|退款|退貨|退货|拒退|退費|退费/i.test(text), 14);
  addSignal("ecommerce_delivery_signal", "delivery or fulfillment failure", /delivery|shipping|shipment|late arrival|not delivered|lost package|tracking|物流|配送|延遲|延迟|未送達|未送达|丟件|丢件/i.test(text), 12);
  addSignal("ecommerce_quality_defect_signal", "product quality or defect issue", /defect|defective|broken|does not work|not working|poor quality|damaged|faulty|品質|质量|缺陷|瑕疵|壞了|坏了|故障/i.test(text), 12);
  addSignal("ecommerce_seller_service_signal", "seller or customer service issue", /seller|merchant|customer service|support|no response|ignored|售後|售后|客服|賣家|卖家|商家|不回覆|不回复/i.test(text), 10);
  addSignal("ecommerce_counterfeit_signal", "counterfeit or fake goods allegation", /counterfeit|fake|knockoff|inauthentic|not genuine|pirated|假貨|假货|仿冒|山寨|盗版|盜版/i.test(text), 16);
  addSignal("ecommerce_safety_signal", "unsafe product or recall issue", /unsafe|safety|dangerous|injury|fire|burn|electric shock|recall|hazard|安全|危險|危险|受傷|受伤|召回|起火|觸電|触电/i.test(text), 16);
  addSignal("ecommerce_payment_billing_signal", "payment or billing issue", /payment|billing|overcharge|unauthorized charge|card charged|扣款|支付|付款|帳單|账单|超收|盜刷|盗刷/i.test(text), 12);
  addSignal("ecommerce_low_rating_signal", "low marketplace rating language", /low rating|one star|1 star|bad rating|negative rating|差評|差评|一星|低評分|低评分/i.test(text), 12);
  addSignal("ecommerce_marketplace_signal", "marketplace or retail review source", /marketplace|retail|ecommerce|seller|review|rating|電商|电商|賣場|卖场|商城|評價|评价/i.test(targetText), 6);
  addSignal("ecommerce_evidence_language_signal", "order, receipt, photo, or chat evidence language", evidenceTerms.length > 0, 12);
  addSignal("ecommerce_platform_intervention_signal", "marketplace dispute or buyer protection language", platformInterventionTerms.length > 0, 12);
  addSignal("ecommerce_fulfillment_trace_signal", "tracking, carrier, warehouse, or customs language", fulfillmentTraceTerms.length > 0, 10);
  addSignal("ecommerce_spread_language_signal", "mass buyer complaint or social spread language", spreadTerms.length > 0, 10);
  addSignal("ecommerce_response_language_signal", "seller, merchant, or platform response language", responseTerms.length > 0, 10);

  const semanticSignals = [
    out.ecommerce_refund_signal,
    out.ecommerce_delivery_signal,
    out.ecommerce_quality_defect_signal,
    out.ecommerce_seller_service_signal,
    out.ecommerce_counterfeit_signal,
    out.ecommerce_safety_signal,
    out.ecommerce_payment_billing_signal,
    out.ecommerce_low_rating_signal,
    out.ecommerce_evidence_language_signal,
    out.ecommerce_platform_intervention_signal,
    out.ecommerce_fulfillment_trace_signal,
    out.ecommerce_spread_language_signal,
    out.ecommerce_response_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "ecommerce_complete_crisis_narrative_signal",
    "complete ecommerce crisis narrative",
    semanticSignals >= 6
      && (out.ecommerce_refund_signal || out.ecommerce_payment_billing_signal || out.ecommerce_safety_signal || out.ecommerce_counterfeit_signal)
      && (out.ecommerce_evidence_language_signal || out.ecommerce_fulfillment_trace_signal)
      && (out.ecommerce_platform_intervention_signal || out.ecommerce_response_language_signal || out.ecommerce_spread_language_signal),
    10,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    ecommerce_fulfillment_risk_score: boundedScore,
    ecommerce_fulfillment_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    ecommerce_signal_count: signalFields.length,
    ecommerce_semantic_signal_count: semanticSignals,
    ecommerce_signal_reasons: [...new Set(reasons)].slice(0, 16),
    ecommerce_evidence_terms: evidenceTerms,
    ecommerce_platform_intervention_terms: platformInterventionTerms,
    ecommerce_fulfillment_trace_terms: fulfillmentTraceTerms,
    ecommerce_spread_terms: spreadTerms,
    ecommerce_response_terms: responseTerms,
  };
}

function evidenceWithEcommerceMetadata(evidence = {}, item = {}, target = {}, failoverAttribution = [], content = "") {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const evidenceMetrics = evidence?.metrics || {};
  return {
    ...(evidence || {}),
    source_key: "ecommerceReviewSources",
    evidence_type: "ecommerce_review_source_result",
    metrics: {
      ...evidenceMetrics,
      ...ecommerceFulfillmentRiskSignals({ item, target, content, metrics: evidenceMetrics }),
      source: "ecommerce_review_source_search",
      marketplace: target.name || item.targetName || "",
      marketplace_key: target.key || item.targetKey || "",
      site_tags: Array.isArray(target.tags) ? target.tags : item.targetTags || [],
      target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
      source_weight_tier: target.tier || "",
      source_family: "review",
      ecommerce_review_canonical_dedupe_url: ecommerceReviewDedupeKey(item),
      ecommerce_review_search_scan_dedupe_key: ecommerceReviewDedupeKey(item),
      ecommerce_review_search_page: Math.max(1, Number(item.searchPage) || 1),
      ecommerce_review_search_raw_result_count: Math.max(0, Number(item.searchRawResultCount) || 0),
      ecommerce_review_matched_keyword: item.matchedKeyword || "",
      ecommerce_review_keyword_match_source: ecommerceReviewKeywordMatchSource(item, item.matchedKeyword || "", target),
      ...(item.directUrl ? {
        source: "ecommerce_review_source_direct_url",
        collection_mode: "ecommerce_review_direct_url",
        ecommerce_review_direct_url: normalizeEcommerceReviewDedupeUrl(item.url),
      } : {}),
      ...(attribution.length ? {
        failover_attribution: attribution,
        failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
      } : {}),
    },
  };
}

async function insertEcommerceItems(items, { keyword, proxyUrl, enrich, target, domainControls = {}, contentControls = {}, failoverAttribution = [], seenItemUrls = null }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = ecommerceReviewDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const fallback = item.content || "";
    const enriched = enrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: fallback, ai_summary: fallback, enriched: false };
    const directExcerpt = item.directUrl ? cleanText(enriched.evidence?.metrics?.article_body_excerpt || "", 2400) : "";
    const content = directExcerpt || enriched.content || fallback;
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "ecommerce_review_sources",
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
      evidence: evidenceWithEcommerceMetadata(enriched.evidence || {}, item, target, failoverAttribution, content),
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

export async function scrapeEcommerceReviewSources(keywords, { proxyUrl = "", enrich = true, budget = {}, targets = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const selectedTargets = normalizeTargets(targets, targetProfiles).slice(0, normalizedBudget.maxTargetsPerKeyword);
  const tasks = normalizedKeywords.flatMap(keyword => selectedTargets.map(target => ({ keyword, target })));
  const seenItemUrls = new Set();
  const directTargets = directEcommerceReviewTargets(directUrls, selectedTargets);

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    const query = `${keyword} product review rating refund delivery customer service ${target.siteQuery}`;
    try {
      const directItems = directTargets
        .filter(item => item.target.key === target.key)
        .slice(0, normalizedBudget.maxItemsPerTarget)
        .map(item => directEcommerceReviewItem(item.url, keyword, target));
      inserted += await insertEcommerceItems(directItems, { keyword, proxyUrl, enrich: true, target, domainControls, contentControls, failoverAttribution, seenItemUrls });
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
        const items = parseEcommerceReviewSearchResults(html, keyword, target, normalizedBudget.maxItemsPerTarget - found.length);
        let pageFound = 0;
        for (const item of items) {
          const dedupeKey = ecommerceReviewDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          found.push({ ...item, searchPage: page + 1, searchRawResultCount: rawCount, matchedKeyword: keyword });
          pageFound += 1;
          if (found.length >= normalizedBudget.maxItemsPerTarget) break;
        }
        if (!pageFound && !rawCount) break;
      }
      inserted += await insertEcommerceItems(found, { keyword, proxyUrl, enrich, target, domainControls, contentControls, failoverAttribution, seenItemUrls });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.name, message });
      console.warn(`[CRM/EcommerceReviewSources] 抓取失敗 keyword=${keyword} target=${target.name}: ${message}`);
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
  directEcommerceReviewTargets,
  directEcommerceReviewItem,
  normalizeEcommerceReviewDedupeUrl,
  ecommerceReviewDedupeKey,
  countDuckDuckGoRawResults,
  parseEcommerceReviewSearchResults,
  normalizeEcommerceReviewKeywordText,
  ecommerceReviewValueMatchesKeyword,
  ecommerceReviewKeywordMatchSource,
  ecommerceFulfillmentRiskSignals,
  ECOMMERCE_REVIEW_TARGETS,
};
