/**
 * scrapers/public-advertising-rulings-sources.js — public advertising ruling discovery
 *
 * Uses no-key public advertising regulator pages to collect misleading
 * advertising, influencer disclosure, greenwashing, health-claim, and
 * consumer-protection marketing risk signals.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const ASA_RULINGS_URL = "https://www.asa.org.uk/codes-and-rulings/rulings.html";
const NZ_ASA_DECISIONS_API_URL = "https://asa.co.nz/wp-json/wp/v2/decision";
const CANADA_AD_STANDARDS_COUNCIL_DECISIONS_URL = "https://adstandards.ca/complaints/complaints-reporting/case-summaries/";
const DEFAULT_ADVERTISING_RULING_TARGETS = [
  { key: "uk_asa_rulings", name: "UK ASA rulings", url: ASA_RULINGS_URL, kind: "asa_rulings_html" },
  { key: "new_zealand_asa_decisions", name: "New Zealand ASA Decisions", url: NZ_ASA_DECISIONS_API_URL, kind: "new_zealand_asa_decisions_wp_json" },
  { key: "canada_ad_standards_council_decisions", name: "Ad Standards Canada Council Decisions", url: CANADA_AD_STANDARDS_COUNCIL_DECISIONS_URL, kind: "canada_ad_standards_council_decisions_html" },
];

function decodeHtml(text = "") {
  return String(text || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(value = "", max = 1200) {
  return decodeHtml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(40, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeTargets(targets = DEFAULT_ADVERTISING_RULING_TARGETS) {
  const requested = Array.isArray(targets) && targets.length ? targets : DEFAULT_ADVERTISING_RULING_TARGETS;
  const byKey = new Map(DEFAULT_ADVERTISING_RULING_TARGETS.map(target => [target.key, target]));
  return requested
    .map(target => {
      if (typeof target === "string") return byKey.get(target) || { key: target, name: target, url: target, kind: "custom" };
      return target;
    })
    .filter(target => target?.url);
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeAdvertisingRulingKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeAdvertisingRulingKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeAdvertisingRulingKeywordText(text);
  return keywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeAdvertisingRulingKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function asaRulingsSearchUrl(keyword = "") {
  const params = new URLSearchParams({ q: cleanText(keyword, 120) });
  return `${ASA_RULINGS_URL}?${params.toString()}`;
}

function nzAsaDecisionSearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    search: cleanText(keyword, 120),
    per_page: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    orderby: "date",
    order: "desc",
    _embed: "1",
  });
  return `${NZ_ASA_DECISIONS_API_URL}?${params.toString()}`;
}

function canadaAdStandardsDecisionSearchUrl(keyword = "") {
  const params = new URLSearchParams({
    advertiser: cleanText(keyword, 120),
    keyword: cleanText(keyword, 120),
  });
  return `${CANADA_AD_STANDARDS_COUNCIL_DECISIONS_URL}?${params.toString()}`;
}

function advertisingRulingRiskLevel({ status = "", title = "", content = "" } = {}) {
  const text = `${status} ${title} ${content}`.toLowerCase();
  if (/upheld|settled|ad\s+(?:removed|amended|withdrawn)|breach|misleading|irresponsible|harmful|offensive|unsubstantiated|greenwash|environmental|health claim|financial|children|alcohol|gambling|crypto|banned|withdraw|safety|therapeutic|substantiation|違規|违规|誤導|误导|虛假|虚假|處罰|处罚/i.test(text)) return "high";
  if (/informally resolved|resolved|complaint|ad|advertising|marketing|influencer|social media|paid ad|投訴|投诉|廣告|广告|行銷|营销/i.test(text)) return "medium";
  return "low";
}

function absoluteAsaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.asa.org.uk/${value.replace(/^\/+/, "")}`;
}

function absoluteNzAsaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://asa.co.nz/${value.replace(/^\/+/, "")}`;
}

function absoluteCanadaAdStandardsUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://adstandards.ca/${value.replace(/^\/+/, "")}`;
}

function normalizeAdvertisingRulingDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeAdvertisingRulingDedupeUrl(embedded);
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
    ]) {
      url.searchParams.delete(param);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function advertisingRulingDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const source = cleanText(metrics.source || metrics.advertising_record_source || "advertising-ruling", 140).toLowerCase();
  const urlKey = normalizeAdvertisingRulingDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  const decisionNumber = cleanText(metrics.decision_number || "", 120);
  if (decisionNumber) return `${source}:decision:${decisionNumber}`.toLowerCase();
  return [
    source,
    cleanText(item.title || "", 260),
    cleanText(item.publishedAt || "", 80),
  ].filter(Boolean).join(":").toLowerCase();
}

function advertisingRulingKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["advertising_record_source", metrics.advertising_record_source],
    ["advertising_record_type", metrics.advertising_record_type],
    ["decision_number", metrics.decision_number],
    ["advertiser", metrics.advertiser],
    ["advertisement", metrics.advertisement],
    ["ruling_status", metrics.ruling_status],
    ["ad_medium", metrics.ad_medium],
    ["product_category", metrics.product_category],
    ["complaint_summary", metrics.complaint_summary],
    ["decision_summary", metrics.decision_summary],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword(value || "", keyword));
  return match ? match[0] : "";
}

function advertisingRulingKeywordDiagnostics(item = {}, keyword = "") {
  return {
    advertising_ruling_matched_keyword: cleanText(keyword, 160),
    advertising_ruling_keyword_match_source: advertisingRulingKeywordMatchSource(item, keyword),
  };
}

function advertisingRulingRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = cleanText([
    item.title,
    item.content,
    item.author,
    metrics.advertising_record_source,
    metrics.advertising_record_type,
    metrics.ruling_status,
    metrics.ad_medium,
    metrics.product_category,
    metrics.advertising_codes,
    metrics.complaint_summary,
    metrics.decision_summary,
    metrics.advertiser,
    metrics.advertisement,
  ].filter(Boolean).join(" "), 7000).toLowerCase();
  const reasons = [];
  let score = /advertising-regulator-ruling|official/i.test(String(metrics.source_weight_tier || metrics.source_family || "")) ? 16 : 10;
  const out = {};
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };
  const termMatches = (terms = []) => terms
    .map(term => cleanText(term, 120).toLowerCase())
    .filter(term => term && text.includes(term));

  addSignal("advertising_ruling_upheld_signal", "upheld, settled, non-compliant, or breach outcome", /upheld|settled|non-?compliant|breach|complaint upheld|code breach|違規|违规|成立/i.test(text), 16);
  addSignal("advertising_ruling_misleading_claim_signal", "misleading, false, deceptive, or unsupported representation", /misleading|false|deceptive|unsubstantiated|unsupported|truthful presentation|representation|誤導|误导|虛假|虚假|不實|不实/i.test(text), 16);
  addSignal("advertising_ruling_health_therapeutic_signal", "health, therapeutic, nutrition, cosmetic, or supplement claim", /health|therapeutic|medical|medicine|drug|nutrition|supplement|cosmetic|weight loss|beauty|療效|疗效|健康|藥|药|保健|減重|减重/i.test(text), 12);
  addSignal("advertising_ruling_environmental_greenwashing_signal", "environmental or greenwashing claim", /greenwash|environmental|sustainable|carbon|recycl|eco|climate|環保|环保|永續|可持續|碳/i.test(text), 10);
  addSignal("advertising_ruling_influencer_disclosure_signal", "influencer, social, paid ad, or disclosure concern", /influencer|social media|paid ad|sponsored|affiliate|endorsement|disclosure|native advertising|網紅|网红|社群|社交媒體|付費|付费|贊助|赞助/i.test(text), 10);
  addSignal("advertising_ruling_financial_crypto_signal", "financial, investment, credit, gambling, or crypto advertising", /financial|investment|credit|loan|debt|gambling|betting|crypto|token|trading|金融|投資|投资|貸款|贷款|博彩|加密/i.test(text), 12);
  addSignal("advertising_ruling_vulnerable_audience_signal", "children or vulnerable audience concern", /children|child|teen|minor|vulnerable|elderly|pregnan|兒童|儿童|未成年|青少年|老人|孕/i.test(text), 10);
  addSignal("advertising_ruling_substantiation_signal", "substantiation or evidence concern", /substantiation|evidence|prove|clinical|scientific|qualified claim|證據|证据|證明|证明|臨床|临床|科學|科学/i.test(text), 8);
  addSignal("advertising_ruling_ad_removed_amended_signal", "ad removed, amended, withdrawn, or banned", /removed|amended|withdrawn|banned|cease|stop|corrective|下架|修改|撤回|禁止|整改/i.test(text), 10);
  addSignal("advertising_ruling_regulator_signal", "public advertising regulator source", /advertising|ruling|decision|standards|authority|council|regulator|asa|廣告|广告|裁定|監管|监管/i.test(text), 6);

  const evidenceTerms = termMatches([
    "complaint number",
    "case number",
    "ruling decision",
    "complaint upheld",
    "advertising codes",
    "ad copy",
    "screenshots",
    "substantiation",
    "scientific evidence",
    "clinical evidence",
    "regulator decision",
    "evidence",
    "證據",
    "证据",
    "投訴編號",
    "投诉编号",
    "裁定",
  ]);
  const audienceChannelTerms = termMatches([
    "social media",
    "paid ad",
    "influencer",
    "sponsored",
    "native advertising",
    "children",
    "teen",
    "minor",
    "elderly",
    "vulnerable",
    "consumer",
    "instagram",
    "tiktok",
    "youtube",
    "網紅",
    "网红",
    "未成年",
    "社群",
  ]);
  const remediationTerms = termMatches([
    "removed",
    "amended",
    "withdrawn",
    "banned",
    "cease",
    "corrective",
    "must not appear again",
    "undertaking",
    "compliance",
    "下架",
    "修改",
    "撤回",
    "禁止",
    "整改",
  ]);
  const spreadTerms = termMatches([
    "media coverage",
    "viral",
    "social media",
    "news",
    "public warning",
    "complaint volume",
    "consumer complaints",
    "influencer",
    "tiktok",
    "instagram",
    "youtube",
    "新聞",
    "新闻",
    "擴散",
    "扩散",
  ]);

  addSignal("advertising_ruling_evidence_language_signal", "ruling includes case, complaint, evidence, code, or ad-copy details", evidenceTerms.length > 0, 10);
  addSignal("advertising_ruling_audience_channel_signal", "audience, vulnerable group, influencer, or channel context", audienceChannelTerms.length > 0, 8);
  addSignal("advertising_ruling_remediation_language_signal", "removal, amendment, ban, corrective, or compliance action", remediationTerms.length > 0, 10);
  addSignal("advertising_ruling_spread_language_signal", "social, news, complaint-volume, or public-warning spread context", spreadTerms.length > 0, 8);

  const semanticSignalCount = [
    out.advertising_ruling_upheld_signal,
    out.advertising_ruling_misleading_claim_signal,
    out.advertising_ruling_health_therapeutic_signal,
    out.advertising_ruling_environmental_greenwashing_signal,
    out.advertising_ruling_influencer_disclosure_signal,
    out.advertising_ruling_financial_crypto_signal,
    out.advertising_ruling_vulnerable_audience_signal,
    out.advertising_ruling_substantiation_signal,
    out.advertising_ruling_ad_removed_amended_signal,
    out.advertising_ruling_regulator_signal,
    out.advertising_ruling_evidence_language_signal,
    out.advertising_ruling_audience_channel_signal,
    out.advertising_ruling_remediation_language_signal,
    out.advertising_ruling_spread_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "advertising_ruling_complete_compliance_narrative_signal",
    "complete advertising compliance narrative with regulator outcome, issue, evidence, audience/channel, and remediation or spread",
    semanticSignalCount >= 7
      && out.advertising_ruling_regulator_signal
      && out.advertising_ruling_upheld_signal
      && (
        out.advertising_ruling_misleading_claim_signal
        || out.advertising_ruling_health_therapeutic_signal
        || out.advertising_ruling_environmental_greenwashing_signal
        || out.advertising_ruling_financial_crypto_signal
        || out.advertising_ruling_vulnerable_audience_signal
      )
      && (out.advertising_ruling_substantiation_signal || out.advertising_ruling_evidence_language_signal)
      && out.advertising_ruling_audience_channel_signal
      && (out.advertising_ruling_remediation_language_signal || out.advertising_ruling_spread_language_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    advertising_ruling_risk_score: boundedScore,
    advertising_ruling_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    advertising_ruling_signal_count: signalFields.length,
    advertising_ruling_semantic_signal_count: semanticSignalCount,
    advertising_ruling_evidence_terms: evidenceTerms,
    advertising_ruling_audience_channel_terms: audienceChannelTerms,
    advertising_ruling_remediation_terms: remediationTerms,
    advertising_ruling_spread_terms: spreadTerms,
    advertising_ruling_signal_reasons: [...new Set(reasons)].slice(0, 12),
  };
}

function renderedText(value = "", max = 5000) {
  if (typeof value === "string") return cleanText(value, max);
  if (value?.rendered) return cleanText(value.rendered, max);
  return cleanText(value || "", max);
}

function nzAsaTaxonomyNames(record = {}, taxonomy = "") {
  const terms = record?._embedded?.["wp:term"];
  if (!Array.isArray(terms)) return [];
  return terms
    .flatMap(group => Array.isArray(group) ? group : [])
    .filter(term => !taxonomy || term?.taxonomy === taxonomy)
    .map(term => cleanText(term?.name || "", 160))
    .filter(Boolean);
}

function extractNzAsaDecisionField(text = "", label = "") {
  const labels = [
    "Complaint number",
    "Complaint Number",
    "Advertiser",
    "Advertisement",
    "Date of Decision",
    "Outcome",
    "Complaint",
    "Relevant Codes",
    "Decision",
  ];
  const labelPattern = labels
    .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
  const escaped = label.toLowerCase() === "complaint"
    ? "Complaint(?!\\s+number)"
    : label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const match = String(text || "").match(new RegExp(`${escaped}\\s*:?\\s*([\\s\\S]*?)(?=\\s*(?:${labelPattern})\\s*:?|$)`, "i"));
  return cleanText(match?.[1] || "", 500);
}

function parseAsaRulingResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const itemRegex = /<li[^>]+class=["'][^"']*icon-listing-item[^"']*["'][^>]*>([\s\S]*?)(?=<li[^>]+class=["'][^"']*icon-listing-item|\s*<\/ul>)/gi;
  let match;
  while ((match = itemRegex.exec(source)) !== null) {
    const block = match[1] || "";
    const itemContext = source.slice(match.index, Math.min(source.length, match.index + 3000));
    const titleMatch = block.match(/<h4[^>]*class=["'][^"']*heading[^"']*["'][^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href=["']([^"']*\/rulings\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const url = absoluteAsaUrl(titleMatch?.[1] || "");
    const title = cleanText(titleMatch?.[2] || "", 320);
    const captions = [...block.matchAll(/<span[^>]+class=["'][^"']*caption[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
      .map(item => cleanText(item[1], 160))
      .filter(Boolean);
    const summary = cleanText(
      (block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || itemContext.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "",
      1000,
    );
    const status = captions[0] || "";
    const medium = captions[1] || "";
    const publishedAt = normalizeDate(captions[2]) || new Date().toISOString();
    const searchable = [title, status, medium, summary].join(" ");
    if (!url || !title || !textMatchesKeyword(searchable, keyword)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: `ASA advertising ruling: ${title}`,
      content: [status ? `Ruling status: ${status}.` : "", medium ? `Media: ${medium}.` : "", summary].filter(Boolean).join(" "),
      author: "UK Advertising Standards Authority",
      publishedAt,
      riskLevel: advertisingRulingRiskLevel({ status, title, content: summary }),
      metrics: {
        source: "uk_asa_rulings",
        source_family: "official",
        source_kind: "public_advertising_ruling",
        collection_mode: "asa_public_rulings_html",
        advertising_record_source: "UK ASA rulings",
        advertising_record_type: "advertising-ruling",
        ruling_status: status,
        ad_medium: medium,
        source_weight_tier: "advertising-regulator-ruling",
      },
    });
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function parseNzAsaDecisionResults(payload = [], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const records = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const record of records) {
    const url = absoluteNzAsaUrl(record?.link || record?.guid?.rendered || "");
    const title = renderedText(record?.title, 320);
    const body = renderedText(record?.content, 5000);
    const excerpt = renderedText(record?.excerpt, 1200);
    const content = body || excerpt;
    const outcomeTerms = nzAsaTaxonomyNames(record, "outcome");
    const mediumTerms = nzAsaTaxonomyNames(record, "medium");
    const productTerms = nzAsaTaxonomyNames(record, "product");
    const codeTerms = nzAsaTaxonomyNames(record, "code");
    const complaintNumber = extractNzAsaDecisionField(content, "Complaint number") || extractNzAsaDecisionField(content, "Complaint Number");
    const advertiser = extractNzAsaDecisionField(content, "Advertiser");
    const advertisement = extractNzAsaDecisionField(content, "Advertisement");
    const decisionDate = normalizeDate(extractNzAsaDecisionField(content, "Date of Decision"));
    const outcome = outcomeTerms[0] || extractNzAsaDecisionField(content, "Outcome");
    const complaint = extractNzAsaDecisionField(content, "Complaint");
    const decision = extractNzAsaDecisionField(content, "Decision");
    const publishedAt = decisionDate || normalizeDate(record?.date_gmt || record?.date) || new Date().toISOString();
    const searchable = [title, content, outcome, advertiser, advertisement, mediumTerms.join(" "), productTerms.join(" "), codeTerms.join(" ")].join(" ");
    if (!url || !title || !textMatchesKeyword(searchable, keyword)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const summary = [
      outcome ? `Outcome: ${outcome}.` : "",
      advertiser ? `Advertiser: ${advertiser}.` : "",
      advertisement ? `Advertisement: ${advertisement}.` : "",
      mediumTerms.length ? `Medium: ${mediumTerms.join(", ")}.` : "",
      productTerms.length ? `Product category: ${productTerms.join(", ")}.` : "",
      complaint ? `Complaint: ${complaint}` : "",
      decision ? `Decision: ${decision}` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url,
      title: `New Zealand ASA advertising decision: ${title}`,
      content: cleanText(summary || content, 1600),
      author: "New Zealand Advertising Standards Authority",
      publishedAt,
      riskLevel: advertisingRulingRiskLevel({ status: outcome, title, content }),
      metrics: {
        source: "new_zealand_asa_decisions",
        source_family: "official",
        source_kind: "public_advertising_ruling",
        collection_mode: "new_zealand_asa_public_decisions_wp_json",
        advertising_record_source: "New Zealand ASA Decisions",
        advertising_record_type: "advertising-decision",
        decision_number: complaintNumber,
        advertiser,
        advertisement,
        ruling_status: outcome,
        ad_medium: mediumTerms.join(", "),
        product_category: productTerms.join(", "),
        advertising_codes: codeTerms.join(", "),
        complaint_summary: complaint,
        decision_summary: decision,
        source_weight_tier: "advertising-regulator-ruling",
      },
    });
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function parseCanadaAdStandardsDecisionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const linkRegex = /<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const rawUrl = match[1] || "";
    const title = cleanText(match[2] || "", 320);
    const url = absoluteCanadaAdStandardsUrl(rawUrl);
    if (!url || !title) continue;
    if (!/adstandards\.ca\/(?:complaints\/complaints-reporting\/case-summaries|wp-content\/uploads\/)/i.test(url)) continue;
    const context = cleanText(source.slice(Math.max(0, match.index - 700), Math.min(source.length, linkRegex.lastIndex + 700)), 1600);
    const searchable = [title, url, context].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const publishedAt = normalizeDate((title.match(/\b(20\d{2}|19\d{2})\b/) || [])[1] || "") || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const dedupe = normalizeAdvertisingRulingDedupeUrl(url);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    const status = /non-?compliant|upheld|breach/i.test(context)
      ? "Non-Compliant"
      : /compliant|not upheld|dismissed/i.test(context)
        ? "Compliant"
        : "";
    out.push({
      url,
      title: `Ad Standards Canada council decision: ${title}`,
      content: cleanText([
        status ? `Ruling status: ${status}.` : "",
        context,
      ].filter(Boolean).join(" "), 1600),
      author: "Ad Standards Canada",
      publishedAt,
      riskLevel: advertisingRulingRiskLevel({ status, title, content: context }),
      metrics: {
        source: "canada_ad_standards_council_decisions",
        source_family: "official",
        source_kind: "public_advertising_ruling",
        collection_mode: "canada_ad_standards_public_council_decisions_html",
        advertising_record_source: "Ad Standards Canada Council Decisions",
        advertising_record_type: /\.pdf(?:$|\?)/i.test(url) ? "advertising-decision-archive-pdf" : "advertising-decision",
        ruling_status: status,
        source_weight_tier: "advertising-regulator-ruling",
      },
    });
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertAdvertisingRulingItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = advertisingRulingDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "public_advertising_rulings_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment: sentiment === "positive" ? "neutral" : sentiment,
      risk_level: item.riskLevel || "medium",
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "publicAdvertisingRulingsSources",
      evidence: {
        evidence_type: "public_advertising_regulator_ruling",
        metrics: {
          ...(item.metrics || {}),
          ...advertisingRulingRiskSignals(item),
          ...advertisingRulingKeywordDiagnostics(item, keyword),
          advertising_ruling_canonical_dedupe_key: dedupeKey,
          advertising_ruling_search_scan_dedupe_key: dedupeKey,
          ...(attribution.length ? {
            failover_attribution: attribution,
            failover_from_sources: failoverFromSources,
          } : {}),
        },
      },
      source_type: "scraper",
      allow_external_risk_level: true,
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapePublicAdvertisingRulingsSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = DEFAULT_ADVERTISING_RULING_TARGETS, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedTargets = normalizeTargets(targets);
  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of normalizedTargets) tasks.push({ keyword, target });
  }
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    const failures = [];
    let inserted = 0;
    try {
      const url = target.kind === "asa_rulings_html" || target.key === "uk_asa_rulings"
        ? asaRulingsSearchUrl(keyword)
        : target.kind === "new_zealand_asa_decisions_wp_json" || target.key === "new_zealand_asa_decisions"
          ? nzAsaDecisionSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword })
          : target.kind === "canada_ad_standards_council_decisions_html" || target.key === "canada_ad_standards_council_decisions"
            ? canadaAdStandardsDecisionSearchUrl(keyword)
            : target.url;
      const res = await fetchPublicSource(url, {
        headers: { "User-Agent": USER_AGENT, "Accept": target.kind === "new_zealand_asa_decisions_wp_json" ? "application/json,text/plain,*/*" : "text/html,application/xhtml+xml,*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
      } else {
        let items;
        if (target.kind === "new_zealand_asa_decisions_wp_json" || target.key === "new_zealand_asa_decisions") {
          items = parseNzAsaDecisionResults(await res.json(), keyword, {
            limit: normalizedBudget.maxItemsPerKeyword,
            since,
          });
        } else {
          const text = await res.text();
          items = target.kind === "canada_ad_standards_council_decisions_html" || target.key === "canada_ad_standards_council_decisions"
            ? parseCanadaAdStandardsDecisionResults(text, keyword, {
              limit: normalizedBudget.maxItemsPerKeyword,
              since,
            })
            : parseAsaRulingResults(text, keyword, {
              limit: normalizedBudget.maxItemsPerKeyword,
              since,
            });
        }
        inserted += await insertAdvertisingRulingItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target?.key || "public-advertising-rulings", message });
      console.warn(`[CRM/PublicAdvertisingRulings] 抓取失敗 target=${target?.key || "unknown"} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  ASA_RULINGS_URL,
  NZ_ASA_DECISIONS_API_URL,
  CANADA_AD_STANDARDS_COUNCIL_DECISIONS_URL,
  DEFAULT_ADVERTISING_RULING_TARGETS,
  normalizeBudget,
  normalizeTargets,
  normalizeAdvertisingRulingKeywordText,
  textMatchesKeyword,
  asaRulingsSearchUrl,
  nzAsaDecisionSearchUrl,
  canadaAdStandardsDecisionSearchUrl,
  normalizeAdvertisingRulingDedupeUrl,
  advertisingRulingDedupeKey,
  advertisingRulingKeywordMatchSource,
  advertisingRulingKeywordDiagnostics,
  advertisingRulingRiskSignals,
  advertisingRulingRiskLevel,
  parseAsaRulingResults,
  parseNzAsaDecisionResults,
  parseCanadaAdStandardsDecisionResults,
};
