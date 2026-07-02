/**
 * scrapers/brand-impersonation-sources.js — public brand impersonation discovery
 *
 * Uses no-key public certificate transparency search to discover suspicious
 * brand-like domains and public malware URL intelligence that can become
 * phishing, scam, or trust-safety crises.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 2;
const DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD = 3;
const DEFAULT_MAX_AGE_DAYS = 90;
const URLHAUS_RECENT_URLS_JSON_URL = "https://urlhaus.abuse.ch/downloads/json_recent/";
const OPENPHISH_PUBLIC_FEED_URL = "https://openphish.com/feed.txt";
const PHISHING_DATABASE_ACTIVE_URL = "https://phish.co.za/latest/phishing-links-ACTIVE.txt";
const SUSPICIOUS_DOMAIN_TERMS = [
  "login",
  "signin",
  "verify",
  "secure",
  "security",
  "account",
  "support",
  "help",
  "refund",
  "claim",
  "gift",
  "bonus",
  "promo",
  "coupon",
  "wallet",
  "payment",
  "pay",
  "auth",
  "service",
  "app",
  "download",
  "customer",
  "complaint",
  "official",
];
const GENERIC_KEYWORDS = new Set([
  "app",
  "shop",
  "store",
  "support",
  "service",
  "official",
  "login",
  "account",
  "refund",
  "payment",
  "customer",
  "company",
  "brand",
  "news",
  "media",
]);

function cleanText(value = "", max = 1000) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  const maxTypoVariants = Math.round(Number(budget.maxTypoVariantsPerKeyword || budget.max_typo_variants_per_keyword || DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(2, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
    maxTypoVariantsPerKeyword: Number.isFinite(maxTypoVariants) ? Math.max(0, Math.min(8, maxTypoVariants)) : DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function recentEnough(iso = "", { now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const time = new Date(iso || "").getTime();
  if (Number.isNaN(time)) return true;
  const cutoff = now.getTime() - Math.max(1, Math.min(365, Number(maxAgeDays) || DEFAULT_MAX_AGE_DAYS)) * 24 * 60 * 60 * 1000;
  return time >= cutoff && time <= now.getTime() + 24 * 60 * 60 * 1000;
}

function hostnameFromCertificateName(value = "") {
  const cleaned = cleanText(value, 300)
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) return "";
  return cleaned;
}

function hostnameFromUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function certificateHostnames(item = {}) {
  const values = [
    item.name_value,
    item.common_name,
    item.commonName,
    item.subject,
  ].filter(Boolean).flatMap(value => String(value).split(/\n|,|;/));
  const out = [];
  for (const value of values) {
    const host = hostnameFromCertificateName(value);
    if (host && !out.includes(host)) out.push(host);
  }
  return out.slice(0, 40);
}

function keywordTokens(keyword = "") {
  const raw = cleanText(keyword, 160).toLowerCase();
  const withoutProtocol = raw.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  const labels = withoutProtocol.split(/[.\s_-]+/).filter(Boolean);
  const compact = raw.replace(/[^a-z0-9]/g, "");
  const tokens = [
    compact,
    ...labels.map(label => label.replace(/[^a-z0-9]/g, "")),
  ].filter(token => token.length >= 4 && !GENERIC_KEYWORDS.has(token));
  return [...new Set(tokens)].slice(0, 4);
}

function typoVariantTokens(token = "") {
  const value = cleanText(token, 80).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value.length < 5 || value.length > 40) return [];
  const out = new Set();
  const substitutions = new Map([
    ["o", "0"],
    ["i", "1"],
    ["l", "1"],
    ["e", "3"],
    ["a", "4"],
    ["s", "5"],
  ]);
  for (const [from, to] of substitutions.entries()) {
    if (value.includes(from)) out.add(value.replace(from, to));
  }
  for (let index = 1; index < value.length - 1 && out.size < 12; index += 1) {
    const removed = `${value.slice(0, index)}${value.slice(index + 1)}`;
    if (removed.length >= 5) out.add(removed);
  }
  if (value.length >= 6) {
    out.add(`${value.slice(0, Math.ceil(value.length / 2))}-${value.slice(Math.ceil(value.length / 2))}`);
  }
  return [...out].filter(item => item && item !== value && item.length >= 5).slice(0, 12);
}

function brandSearchTokens(keyword = "", { maxTypoVariants = DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD } = {}) {
  const baseTokens = keywordTokens(keyword);
  const variantLimit = Math.max(0, Math.min(8, Number(maxTypoVariants) || 0));
  const out = baseTokens.map(token => ({ token, canonicalToken: token, matchType: "exact" }));
  if (!variantLimit) return out;
  const seen = new Set(out.map(item => item.token));
  for (const baseToken of baseTokens) {
    for (const variant of typoVariantTokens(baseToken)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      out.push({ token: variant, canonicalToken: baseToken, matchType: "typo-variant" });
      if (out.filter(item => item.matchType === "typo-variant").length >= variantLimit) return out;
    }
  }
  return out;
}

function domainLabels(hostname = "") {
  return String(hostname || "")
    .toLowerCase()
    .split(".")
    .filter(Boolean);
}

function suspiciousDomainScore(hostname = "", token = "") {
  const host = String(hostname || "").toLowerCase();
  const labels = domainLabels(host);
  const joined = labels.join("-");
  let score = 0;
  if (host.includes(token)) score += 30;
  if (labels.some(label => label === token)) score += 15;
  if (labels.some(label => label.startsWith(token) && label !== token)) score += 12;
  if (labels.some(label => label.endsWith(token) && label !== token)) score += 10;
  if (labels.some(label => label.includes(token) && label !== token)) score += 10;
  if (SUSPICIOUS_DOMAIN_TERMS.some(term => joined.includes(term))) score += 22;
  if (host.includes("-")) score += 8;
  if (labels.length >= 4) score += 8;
  if (!host.endsWith(".com") && !host.endsWith(".com.tw") && !host.endsWith(".tw")) score += 6;
  return Math.max(0, Math.min(100, score));
}

function riskLabel(score = 0) {
  if (score >= 72) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function crtShSearchUrl(token = "", { page = 1 } = {}) {
  const params = new URLSearchParams({
    q: `%${token}%`,
    output: "json",
  });
  if (Number(page) > 1) params.set("exclude", "expired");
  return `https://crt.sh/?${params.toString()}`;
}

function findBrandTokenMatch(hostname = "", tokenEntries = []) {
  const host = String(hostname || "").toLowerCase();
  return tokenEntries.find(entry => entry?.token && host.includes(entry.token)) || null;
}

function normalizeBrandImpersonationDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeBrandImpersonationDedupeUrl(embedded);
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
    const q = url.searchParams.get("q");
    if (/(^|\.)crt\.sh$/i.test(url.hostname) && q) {
      const host = hostnameFromCertificateName(q);
      if (host) return `https://crt.sh/?q=${encodeURIComponent(host)}`;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function brandImpersonationDedupeKey(item = {}) {
  const maliciousUrlId = cleanText(item.metrics?.malicious_url_id || "", 80);
  if (maliciousUrlId) return `urlhaus:${maliciousUrlId}`;
  const phishingFeedUrl = normalizeBrandImpersonationDedupeUrl(item.metrics?.phishing_feed_url || "");
  if (phishingFeedUrl) return phishingFeedUrl;
  const maliciousUrl = normalizeBrandImpersonationDedupeUrl(item.metrics?.malicious_url || "");
  if (maliciousUrl) return maliciousUrl;
  const host = hostnameFromCertificateName(item.metrics?.certificate_hostname || item.hostname || "");
  if (host) return `https://crt.sh/?q=${encodeURIComponent(host)}`;
  return normalizeBrandImpersonationDedupeUrl(item.url || "");
}

function brandImpersonationKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  if (metrics.brand_token_match_type === "typo-variant") return "typo_variant_brand_token";
  if (metrics.matched_brand_token) return "matched_brand_token";
  const tokenEntries = brandSearchTokens(keyword, { maxTypoVariants: 0 });
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["url", item.url],
    ["certificate_hostname", metrics.certificate_hostname],
    ["malicious_url", metrics.malicious_url],
    ["malicious_url_hostname", metrics.malicious_url_hostname],
    ["phishing_feed_url", metrics.phishing_feed_url],
    ["phishing_feed_hostname", metrics.phishing_feed_hostname],
    ["author", item.author],
  ];
  const match = fields.find(([, value]) => tokenEntries.some(entry => entry.token && String(value || "").toLowerCase().includes(entry.token)));
  return match ? match[0] : "";
}

function brandImpersonationKeywordDiagnostics(item = {}, keyword = "") {
  return {
    brand_impersonation_matched_keyword: cleanText(keyword, 160),
    brand_impersonation_keyword_match_source: brandImpersonationKeywordMatchSource(item, keyword),
  };
}

function daysBetweenIso(start = "", end = "") {
  const startTime = new Date(start || "").getTime();
  const endTime = new Date(end || "").getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.round((endTime - startTime) / (24 * 60 * 60 * 1000));
}

function urlPathLureTerms(rawUrl = "") {
  let path = "";
  try {
    const parsed = new URL(String(rawUrl || ""));
    path = `${parsed.pathname} ${parsed.search}`;
  } catch {
    path = String(rawUrl || "");
  }
  return SUSPICIOUS_DOMAIN_TERMS.filter(term => path.toLowerCase().includes(term)).slice(0, 8);
}

function hostnameTld(hostname = "") {
  const labels = domainLabels(hostname);
  return labels.length ? labels[labels.length - 1] : "";
}

function brandTokenPosition(hostname = "", token = "") {
  const labels = domainLabels(hostname);
  const value = String(token || "").toLowerCase();
  if (!labels.length || !value) return "";
  const index = labels.findIndex(label => label.includes(value));
  if (index < 0) return "";
  if (index === 0) return "primary-label";
  if (index === labels.length - 2) return "registered-domain";
  return "subdomain";
}

function brandImpersonationDepthSignals(item = {}) {
  const metrics = item.metrics || {};
  const hostname = hostnameFromCertificateName(metrics.certificate_hostname || metrics.malicious_url_hostname || metrics.phishing_feed_hostname || item.hostname || hostnameFromUrl(item.url || ""));
  const token = cleanText(metrics.matched_brand_token || metrics.canonical_brand_token || "", 120).toLowerCase();
  const notBefore = normalizeDate(metrics.certificate_not_before || "");
  const notAfter = normalizeDate(metrics.certificate_not_after || "");
  const certLifetimeDays = daysBetweenIso(notBefore, notAfter);
  const certificateAgeDays = notBefore ? daysBetweenIso(notBefore, new Date().toISOString()) : null;
  const shortLivedCert = certLifetimeDays !== null && certLifetimeDays <= 120;
  const newCertificate = certificateAgeDays !== null && certificateAgeDays <= 14;
  const tld = hostnameTld(hostname);
  const suspiciousTld = /^(top|xyz|icu|click|shop|site|online|live|quest|bond|cyou|monster|sbs|cam|buzz|work|support|help|app|zip|mov)$/i.test(tld);
  const labels = domainLabels(hostname);
  const excessiveSubdomains = labels.length >= 4;
  const hyphenatedBrand = Boolean(token && labels.some(label => label.includes(token) && label.includes("-")));
  const position = brandTokenPosition(hostname, token);
  const pathTerms = urlPathLureTerms(metrics.malicious_url || metrics.phishing_feed_url || item.url || "");
  const externalIntel = /urlhaus|openphish|phishing database|public_phishing_feed|public_malicious_url_intelligence/i.test([
    metrics.impersonation_source,
    metrics.source,
    metrics.source_kind,
    metrics.collection_mode,
  ].join(" "));
  const activeThreat = /online|active|last online/i.test([
    metrics.malicious_url_status,
    metrics.malicious_url_last_online,
    item.content,
  ].join(" "));
  const confirmedMalwareOrPhish = /phish|credential|malware|trojan|stealer|ransom|clearfake|loader|botnet|dropper/i.test([
    metrics.malicious_url_threat,
    ...(Array.isArray(metrics.malicious_url_tags) ? metrics.malicious_url_tags : []),
    metrics.impersonation_signal_type,
    item.content,
  ].join(" "));
  const reasons = [];
  if (newCertificate) reasons.push("new-certificate");
  if (shortLivedCert) reasons.push("short-lived-certificate");
  if (suspiciousTld) reasons.push("suspicious-tld");
  if (excessiveSubdomains) reasons.push("excessive-subdomains");
  if (hyphenatedBrand) reasons.push("hyphenated-brand-label");
  if (position) reasons.push(`brand-token-${position}`);
  if (pathTerms.length) reasons.push("url-path-lure-terms");
  if (externalIntel) reasons.push("external-threat-intel");
  if (activeThreat) reasons.push("active-threat-observed");
  if (confirmedMalwareOrPhish) reasons.push("confirmed-malware-or-phishing");
  const score = Math.min(100, Math.max(0,
    (newCertificate ? 12 : 0)
    + (shortLivedCert ? 8 : 0)
    + (suspiciousTld ? 10 : 0)
    + (excessiveSubdomains ? 8 : 0)
    + (hyphenatedBrand ? 8 : 0)
    + (position === "primary-label" ? 12 : position === "subdomain" ? 8 : position ? 6 : 0)
    + (pathTerms.length ? 10 : 0)
    + (externalIntel ? 12 : 0)
    + (activeThreat ? 10 : 0)
    + (confirmedMalwareOrPhish ? 14 : 0)
  ));
  return {
    brand_impersonation_new_certificate_signal: newCertificate ? true : false,
    brand_impersonation_short_lived_certificate_signal: shortLivedCert ? true : false,
    brand_impersonation_suspicious_tld_signal: suspiciousTld ? true : false,
    brand_impersonation_excessive_subdomain_signal: excessiveSubdomains ? true : false,
    brand_impersonation_hyphenated_brand_signal: hyphenatedBrand ? true : false,
    brand_impersonation_url_path_lure_signal: pathTerms.length ? true : false,
    brand_impersonation_external_intel_confirmed_signal: externalIntel ? true : false,
    brand_impersonation_active_threat_observed_signal: activeThreat ? true : false,
    brand_impersonation_confirmed_malware_phish_signal: confirmedMalwareOrPhish ? true : false,
    brand_impersonation_brand_token_position: position,
    brand_impersonation_hostname_tld: tld,
    brand_impersonation_certificate_lifetime_days: certLifetimeDays,
    brand_impersonation_certificate_age_days: certificateAgeDays,
    brand_impersonation_url_path_lure_terms: pathTerms,
    brand_impersonation_depth_score: score,
    brand_impersonation_depth_signal_count: reasons.length,
    brand_impersonation_depth_reasons: reasons,
  };
}

function brandImpersonationRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const suspiciousTerms = Array.isArray(metrics.suspicious_terms)
    ? metrics.suspicious_terms.map(term => cleanText(term, 80)).filter(Boolean)
    : [];
  const tags = Array.isArray(metrics.malicious_url_tags)
    ? metrics.malicious_url_tags.map(tag => cleanText(tag, 80)).filter(Boolean)
    : [];
  const text = [
    item.title,
    item.content,
    item.author,
    item.evidenceType,
    metrics.source,
    metrics.source_family,
    metrics.source_kind,
    metrics.collection_mode,
    metrics.impersonation_source,
    metrics.impersonation_signal_type,
    metrics.source_weight_tier,
    metrics.certificate_hostname,
    metrics.certificate_common_name,
    metrics.malicious_url,
    metrics.malicious_url_hostname,
    metrics.malicious_url_status,
    metrics.malicious_url_threat,
    metrics.phishing_feed_name,
    metrics.phishing_feed_url,
    metrics.phishing_feed_hostname,
    metrics.brand_token_match_type,
    metrics.impersonation_risk_level,
    suspiciousTerms.join(" "),
    tags.join(" "),
  ].map(value => cleanText(value, 1800)).join(" ").toLowerCase();

  const has = pattern => pattern.test(text);
  const signals = {};
  const reasons = [];
  let score = metrics.source_family === "security" ? 12 : 0;
  const add = (field, points, reason) => {
    signals[field] = true;
    score += points;
    reasons.push(reason);
  };

  if (has(/certificate[-_\s]?transparency|crt\.sh|certificate_hostname|certificate_common_name|certificate issued|not before/i)) {
    add("brand_impersonation_certificate_signal", 8, "certificate_transparency_domain");
  }
  if (has(/phish|credential|fake login|account verification|public_phishing_feed|phishing[-_\s]?feed|openphish|phishing database/i)) {
    add("brand_impersonation_phishing_signal", 16, "phishing_or_credential_abuse");
  }
  if (has(/malware|urlhaus|trojan|botnet|loader|stealer|ransom|clearfake|dropper|malware_download|exploit/i)) {
    add("brand_impersonation_malware_signal", 18, "malware_url_intelligence");
  }
  if (metrics.brand_token_match_type === "typo-variant" || has(/typo[-_\s]?variant|typosquat|homograph|lookalike/i)) {
    add("brand_impersonation_typosquat_signal", 14, "typo_variant_brand_token");
  }
  if (has(/login|signin|verify|secure|security|account|wallet|payment|pay|refund|support|auth|claim|gift|bonus|promo|coupon|customer/i)) {
    add("brand_impersonation_login_payment_signal", 12, "login_payment_or_account_lure");
  }
  if (has(/\bonline\b|\bactive\b|last online|url_status online|malicious_url_status online/i)) {
    add("brand_impersonation_active_online_signal", 10, "active_or_online_threat");
  }
  if (suspiciousTerms.length || SUSPICIOUS_DOMAIN_TERMS.some(term => text.includes(term))) {
    add("brand_impersonation_suspicious_terms_signal", 10, "suspicious_domain_terms");
  }
  if (has(/malware-url-intelligence|phishing-url-intelligence|public_malicious_url_intelligence|public_phishing_url_intelligence|urlhaus|openphish|phishing database/i)) {
    add("brand_impersonation_external_intel_signal", 12, "external_security_intelligence");
  }
  const depthSignals = brandImpersonationDepthSignals(item);
  if (depthSignals.brand_impersonation_new_certificate_signal) {
    add("brand_impersonation_new_certificate_signal", 8, "new_certificate_window");
  }
  if (depthSignals.brand_impersonation_short_lived_certificate_signal) {
    add("brand_impersonation_short_lived_certificate_signal", 6, "short_lived_certificate");
  }
  if (depthSignals.brand_impersonation_suspicious_tld_signal) {
    add("brand_impersonation_suspicious_tld_signal", 6, "suspicious_tld");
  }
  if (depthSignals.brand_impersonation_url_path_lure_signal) {
    add("brand_impersonation_url_path_lure_signal", 8, "url_path_lure_terms");
  }
  if (depthSignals.brand_impersonation_confirmed_malware_phish_signal) {
    add("brand_impersonation_confirmed_malware_phish_signal", 10, "confirmed_malware_or_phishing");
  }
  if (Number(metrics.impersonation_score || 0) >= 80 || metrics.impersonation_risk_level === "high") {
    add("brand_impersonation_high_confidence_signal", 12, "high_confidence_impersonation");
  }

  const cappedScore = Math.max(0, Math.min(100, score));
  const brandMatchEvidence = Boolean(metrics.matched_brand_token || metrics.canonical_brand_token || metrics.brand_token_match_type);
  const lureOrAbuseEvidence = Boolean(
    signals.brand_impersonation_phishing_signal
    || signals.brand_impersonation_login_payment_signal
    || signals.brand_impersonation_suspicious_terms_signal
    || depthSignals.brand_impersonation_url_path_lure_signal
  );
  const publicEvidence = Boolean(
    signals.brand_impersonation_certificate_signal
    || signals.brand_impersonation_external_intel_signal
    || depthSignals.brand_impersonation_external_intel_confirmed_signal
    || metrics.certificate_hostname
    || metrics.malicious_url
    || metrics.phishing_feed_url
  );
  const activeOrFreshEvidence = Boolean(
    signals.brand_impersonation_active_online_signal
    || depthSignals.brand_impersonation_active_threat_observed_signal
    || depthSignals.brand_impersonation_new_certificate_signal
    || depthSignals.brand_impersonation_short_lived_certificate_signal
    || metrics.source_kind === "public_phishing_url_intelligence"
    || metrics.collection_mode === "openphish_public_feed_text"
    || metrics.collection_mode === "phishing_database_active_text"
  );
  const confirmedOrHighRiskEvidence = Boolean(
    signals.brand_impersonation_high_confidence_signal
    || signals.brand_impersonation_malware_signal
    || depthSignals.brand_impersonation_confirmed_malware_phish_signal
    || cappedScore >= 70
  );
  const semanticSignalCount = [
    brandMatchEvidence,
    lureOrAbuseEvidence,
    publicEvidence,
    activeOrFreshEvidence,
    confirmedOrHighRiskEvidence,
  ].filter(Boolean).length;
  const completeThreatNarrative = semanticSignalCount >= 5;
  if (completeThreatNarrative) reasons.push("brand-impersonation-complete-threat-narrative");

  return {
    ...signals,
    ...depthSignals,
    brand_impersonation_risk_score: cappedScore,
    brand_impersonation_risk_bucket: cappedScore >= 70 ? "high" : cappedScore >= 40 ? "medium" : "low",
    brand_impersonation_semantic_signal_count: semanticSignalCount,
    brand_impersonation_complete_threat_narrative_signal: completeThreatNarrative ? true : false,
    brand_impersonation_signal_count: reasons.length,
    brand_impersonation_signal_reasons: reasons,
  };
}

function normalizeUrlhausDate(value = "") {
  const raw = cleanText(value, 80).replace(/\s+UTC$/i, "Z").replace(" ", "T");
  return normalizeDate(raw) || normalizeDate(value);
}

function flattenUrlhausRows(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  return Object.entries(payload).flatMap(([id, value]) => {
    const rows = Array.isArray(value) ? value : value ? [value] : [];
    return rows.map(row => ({ id, ...(row || {}) }));
  });
}

function urlhausRiskLevel({ status = "", threat = "", tags = [] } = {}) {
  const text = `${status} ${threat} ${(Array.isArray(tags) ? tags : []).join(" ")}`.toLowerCase();
  if (/online|phish|credential|banker|stealer|ransom|loader|malware|trojan|botnet|clearfake|fake/i.test(text)) return "high";
  if (/offline|malware_download|suspicious|exploit|dropper/i.test(text)) return "medium";
  return "low";
}

function phishingFeedRiskLevel({ feedName = "", url = "", hostname = "", tokenMatch = null } = {}) {
  const text = `${feedName} ${url} ${hostname}`.toLowerCase();
  if (tokenMatch?.matchType === "typo-variant") return "high";
  if (/login|signin|verify|secure|account|wallet|payment|refund|support|claim|gift|bonus|promo|coupon|auth|customer/i.test(text)) return "high";
  return "medium";
}

function parsePublicPhishingFeedText(text = "", keyword = "", {
  limit = DEFAULT_MAX_ITEMS_PER_KEYWORD,
  since = "",
  maxTypoVariants = DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD,
  tokenEntries = null,
  feedName = "Public phishing feed",
  feedUrl = "",
  collectionMode = "public_phishing_feed_text",
} = {}) {
  const searchTokenEntries = Array.isArray(tokenEntries) && tokenEntries.length
    ? tokenEntries
    : brandSearchTokens(keyword, { maxTypoVariants });
  if (!searchTokenEntries.length) return [];
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const rawUrl = cleanText(line, 1600);
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const normalizedUrl = normalizeBrandImpersonationDedupeUrl(rawUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    const hostname = hostnameFromUrl(normalizedUrl);
    const haystack = `${normalizedUrl} ${hostname}`.toLowerCase();
    const tokenMatch = searchTokenEntries.find(entry => entry?.token && haystack.includes(entry.token));
    if (!tokenMatch) continue;
    const risk = phishingFeedRiskLevel({ feedName, url: normalizedUrl, hostname, tokenMatch });
    seen.add(normalizedUrl);
    out.push({
      url: normalizedUrl,
      title: `${feedName} phishing URL signal: ${hostname || normalizedUrl}`,
      content: [
        `${feedName} lists a brand-matching phishing URL for ${keyword}: ${normalizedUrl}.`,
        `Risk indicators include phishing, credential theft, account verification abuse, fake login, and brand impersonation monitoring.`,
      ].join(" "),
      author: feedName,
      publishedAt: new Date().toISOString(),
      evidenceType: "brand_impersonation_phishing_url",
      metrics: {
        source: "public_phishing_feed",
        source_family: "security",
        source_kind: "public_phishing_url_intelligence",
        collection_mode: collectionMode,
        impersonation_source: feedName,
        impersonation_signal_type: "phishing-feed-brand-match",
        phishing_feed_name: feedName,
        phishing_feed_url: normalizedUrl,
        phishing_feed_hostname: hostname,
        phishing_feed_source_url: feedUrl,
        matched_brand_token: tokenMatch.token,
        canonical_brand_token: tokenMatch.canonicalToken,
        brand_token_match_type: tokenMatch.matchType,
        impersonation_score: risk === "high" ? 84 : 62,
        impersonation_risk_level: risk,
        source_weight_tier: "phishing-url-intelligence",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out.filter(item => isAfterSince(item.publishedAt, since));
}

export function parseUrlhausRecentUrls(payload = {}, keyword = "", {
  limit = DEFAULT_MAX_ITEMS_PER_KEYWORD,
  since = "",
  maxTypoVariants = DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD,
  tokenEntries = null,
} = {}) {
  const rows = flattenUrlhausRows(payload);
  const searchTokenEntries = Array.isArray(tokenEntries) && tokenEntries.length
    ? tokenEntries
    : brandSearchTokens(keyword, { maxTypoVariants });
  if (!rows.length || !searchTokenEntries.length) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const maliciousUrl = cleanText(row.url || row.URL || "", 1200);
    const hostname = hostnameFromUrl(maliciousUrl);
    const tags = (Array.isArray(row.tags) ? row.tags : [])
      .map(tag => cleanText(tag, 80))
      .filter(Boolean)
      .slice(0, 30);
    const haystack = [maliciousUrl, hostname, row.threat, row.url_status, row.reporter, tags.join(" ")].join(" ").toLowerCase();
    const tokenMatch = searchTokenEntries.find(entry => entry?.token && haystack.includes(entry.token));
    if (!maliciousUrl || !tokenMatch) continue;
    const dateAdded = normalizeUrlhausDate(row.dateadded || row.dateAdded || "");
    if (dateAdded && !isAfterSince(dateAdded, since)) continue;
    const id = cleanText(row.id || row.urlhaus_id || row.url_id || "", 80);
    const dedupeKey = id || maliciousUrl;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const status = cleanText(row.url_status || row.urlStatus || "", 80);
    const threat = cleanText(row.threat || "", 120);
    const lastOnline = normalizeUrlhausDate(row.last_online || row.lastOnline || "");
    const risk = urlhausRiskLevel({ status, threat, tags });
    const urlhausLink = cleanText(row.urlhaus_link || row.urlhausLink || "", 900);
    out.push({
      url: urlhausLink || maliciousUrl,
      title: `URLhaus malicious URL signal: ${hostname || maliciousUrl}`,
      content: [
        `URLhaus lists a brand-matching malicious URL for ${keyword}: ${maliciousUrl}.`,
        threat ? `Threat: ${threat}.` : "",
        status ? `URL status: ${status}.` : "",
        tags.length ? `Tags: ${tags.join(", ")}.` : "",
        lastOnline ? `Last online: ${lastOnline}.` : "",
      ].filter(Boolean).join(" "),
      author: cleanText(row.reporter || "URLhaus", 120),
      publishedAt: dateAdded || lastOnline || new Date().toISOString(),
      evidenceType: "brand_impersonation_malicious_url",
      metrics: {
        source: "urlhaus_recent_malicious_urls",
        source_family: "security",
        source_kind: "public_malicious_url_intelligence",
        collection_mode: "urlhaus_recent_public_json",
        impersonation_source: "URLhaus",
        impersonation_signal_type: "malicious-url-brand-match",
        malicious_url_id: id,
        malicious_url: maliciousUrl,
        malicious_url_hostname: hostname,
        malicious_url_status: status,
        malicious_url_threat: threat,
        malicious_url_tags: tags,
        malicious_url_last_online: lastOnline,
        malicious_urlhaus_link: urlhausLink,
        malicious_url_reporter: cleanText(row.reporter || "", 120),
        matched_brand_token: tokenMatch.token,
        canonical_brand_token: tokenMatch.canonicalToken,
        brand_token_match_type: tokenMatch.matchType,
        impersonation_score: risk === "high" ? 86 : risk === "medium" ? 64 : 38,
        impersonation_risk_level: risk,
        source_weight_tier: "malware-url-intelligence",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseCrtShCertificateResults(payload, keyword = "", {
  limit = DEFAULT_MAX_ITEMS_PER_KEYWORD,
  since = "",
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  now = new Date(),
  maxTypoVariants = DEFAULT_MAX_TYPO_VARIANTS_PER_KEYWORD,
  tokenEntries = null,
} = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const searchTokenEntries = Array.isArray(tokenEntries) && tokenEntries.length
    ? tokenEntries
    : brandSearchTokens(keyword, { maxTypoVariants });
  if (!searchTokenEntries.length) return [];
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    const notBefore = normalizeDate(item.not_before || item.notBefore || item.entry_timestamp || item.entryTimestamp);
    const discoveredAt = normalizeDate(item.entry_timestamp || item.entryTimestamp || item.not_before || item.notBefore) || new Date(now).toISOString();
    if (notBefore && !recentEnough(notBefore, { now, maxAgeDays })) continue;
    if (!isAfterSince(discoveredAt, since) && !isAfterSince(notBefore, since)) continue;
    for (const hostname of certificateHostnames(item)) {
      const tokenMatch = findBrandTokenMatch(hostname, searchTokenEntries);
      if (!tokenMatch) continue;
      const score = suspiciousDomainScore(hostname, tokenMatch.token);
      if (score < 50) continue;
      const dedupeKey = `${hostname}:${item.serial_number || item.min_cert_id || item.id || ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const issuer = cleanText(item.issuer_name || item.issuerName || "crt.sh certificate transparency", 220);
      const notAfter = normalizeDate(item.not_after || item.notAfter);
      const title = `Potential brand impersonation certificate: ${hostname}`;
      const content = [
        `Certificate transparency discovered a brand-like domain for ${keyword}: ${hostname}.`,
        `Risk indicators include phishing, scam, impersonation, suspicious domain, and brand safety monitoring.`,
        `Issuer: ${issuer}.`,
        notBefore ? `Not before: ${notBefore}.` : "",
        notAfter ? `Not after: ${notAfter}.` : "",
      ].filter(Boolean).join(" ");
      out.push({
        url: `https://crt.sh/?q=${encodeURIComponent(hostname)}`,
        title,
        content,
        author: issuer,
        publishedAt: discoveredAt || notBefore || new Date(now).toISOString(),
        metrics: {
          source: "crtsh_certificate_transparency",
          source_family: "security",
          source_kind: "certificate_transparency_public_search",
          collection_mode: "crtsh_public_json",
          impersonation_source: "crt.sh",
          impersonation_signal_type: "certificate-transparency-domain-match",
          certificate_hostname: hostname,
          certificate_common_name: cleanText(item.common_name || item.commonName || "", 220),
          certificate_issuer: issuer,
          certificate_not_before: notBefore,
          certificate_not_after: notAfter,
          certificate_serial_number: cleanText(item.serial_number || "", 160),
          certificate_id: cleanText(item.min_cert_id || item.id || "", 80),
          matched_brand_token: tokenMatch.token,
          canonical_brand_token: tokenMatch.canonicalToken,
          brand_token_match_type: tokenMatch.matchType,
          impersonation_score: score,
          impersonation_risk_level: riskLabel(score),
          suspicious_terms: SUSPICIOUS_DOMAIN_TERMS.filter(term => hostname.includes(term)).slice(0, 8),
          source_weight_tier: "certificate-transparency",
        },
      });
      if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) return out;
    }
  }
  return out;
}

async function insertImpersonationItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = brandImpersonationDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = item.metrics?.impersonation_risk_level === "high"
      ? "high"
      : item.metrics?.impersonation_risk_level === "medium"
        ? "medium"
        : assessRiskLevel({ title: item.title, content: item.content, sentiment });
    const result = insertSentimentItem({
      platform: "brand_impersonation_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment: sentiment === "positive" ? "neutral" : sentiment,
      risk_level: risk,
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "brandImpersonationSources",
      evidence: {
        evidence_type: item.evidenceType || "brand_impersonation_certificate",
        metrics: {
          ...(item.metrics || {}),
          ...brandImpersonationRiskSignals(item),
          ...brandImpersonationKeywordDiagnostics(item, keyword),
          brand_impersonation_canonical_dedupe_url: dedupeKey,
          brand_impersonation_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeBrandImpersonationSources(keywords, { proxyUrl = "", budget = {}, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedBudget = normalizeBudget(budget);
  const tasks = normalizedKeywords.flatMap(keyword => brandSearchTokens(keyword, {
    maxTypoVariants: normalizedBudget.maxTypoVariantsPerKeyword,
  }).map(entry => ({ keyword, token: entry.token, tokenEntry: entry })));
  if (!tasks.length) return scraperResult(0);
  const seenItemUrls = new Set();
  let urlhausPayloadPromise = null;
  const loadUrlhausPayload = async () => {
    if (!urlhausPayloadPromise) {
      urlhausPayloadPromise = (async () => {
        const res = await fetchPublicSource(URLHAUS_RECENT_URLS_JSON_URL, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) throw new Error(httpFailure(res));
        return res.json();
      })();
    }
    return urlhausPayloadPromise;
  };
  const urlhausResults = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const items = parseUrlhausRecentUrls(await loadUrlhausPayload(), keyword, {
        limit: normalizedBudget.maxItemsPerKeyword,
        since,
        maxTypoVariants: normalizedBudget.maxTypoVariantsPerKeyword,
      });
      inserted += await insertImpersonationItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "urlhaus:recent", message });
      console.warn(`[CRM/BrandImpersonation] URLhaus 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });
  const publicPhishingFeeds = [
    {
      name: "OpenPhish",
      url: OPENPHISH_PUBLIC_FEED_URL,
      collectionMode: "openphish_public_feed_text",
    },
    {
      name: "Phishing Database",
      url: PHISHING_DATABASE_ACTIVE_URL,
      collectionMode: "phishing_database_active_text",
    },
  ];
  let phishingFeedPayloadsPromise = null;
  const loadPhishingFeedPayloads = async () => {
    if (!phishingFeedPayloadsPromise) {
      phishingFeedPayloadsPromise = Promise.all(publicPhishingFeeds.map(async (feed) => {
        try {
          const res = await fetchPublicSource(feed.url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "text/plain,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) return { ...feed, text: "", failure: httpFailure(res) };
          return { ...feed, text: await res.text(), failure: "" };
        } catch (err) {
          return { ...feed, text: "", failure: formatSourceError(err, proxyUrl) };
        }
      }));
    }
    return phishingFeedPayloadsPromise;
  };
  const phishingFeedResults = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const feeds = await loadPhishingFeedPayloads();
      for (const feed of feeds) {
        if (feed.failure) {
          failures.push({ keyword, target: `phishing-feed:${feed.name}`, message: feed.failure });
          continue;
        }
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        if (remaining <= 0) break;
        const items = parsePublicPhishingFeedText(feed.text, keyword, {
          limit: remaining,
          since,
          maxTypoVariants: normalizedBudget.maxTypoVariantsPerKeyword,
          feedName: feed.name,
          feedUrl: feed.url,
          collectionMode: feed.collectionMode,
        });
        inserted += await insertImpersonationItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "public-phishing-feeds", message });
      console.warn(`[CRM/BrandImpersonation] 公開釣魚 feed 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });
  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, token, tokenEntry }) => {
    let inserted = 0;
    const failures = [];
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const res = await fetchPublicSource(crtShSearchUrl(token, { page }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `crtsh:${token}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        const payload = await res.json();
        const rawCertificateCount = Array.isArray(payload) ? payload.length : 0;
        const items = parseCrtShCertificateResults(payload, keyword, {
          limit: remaining,
          since,
          tokenEntries: [tokenEntry],
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            crtsh_search_page: page,
            crtsh_search_raw_certificate_count: rawCertificateCount,
            crtsh_search_token: token,
          },
        }));
        const count = await insertImpersonationItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        inserted += count;
        if (!rawCertificateCount) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: `crtsh:${token}`, message });
      console.warn(`[CRM/BrandImpersonation] 抓取失敗 keyword=${keyword} token=${token}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    urlhausResults.reduce((sum, result) => sum + Number(result?.inserted || 0), 0)
      + phishingFeedResults.reduce((sum, result) => sum + Number(result?.inserted || 0), 0)
      + results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [
      ...urlhausResults.flatMap(result => result?.failures || []),
      ...phishingFeedResults.flatMap(result => result?.failures || []),
      ...results.flatMap(result => result?.failures || []),
    ],
  );
}

export const __test__ = {
  SUSPICIOUS_DOMAIN_TERMS,
  URLHAUS_RECENT_URLS_JSON_URL,
  OPENPHISH_PUBLIC_FEED_URL,
  PHISHING_DATABASE_ACTIVE_URL,
  crtShSearchUrl,
  normalizeBudget,
  keywordTokens,
  typoVariantTokens,
  brandSearchTokens,
  suspiciousDomainScore,
  urlhausRiskLevel,
  normalizeBrandImpersonationDedupeUrl,
  brandImpersonationDedupeKey,
  brandImpersonationKeywordMatchSource,
  brandImpersonationKeywordDiagnostics,
  daysBetweenIso,
  urlPathLureTerms,
  brandTokenPosition,
  brandImpersonationDepthSignals,
  brandImpersonationRiskSignals,
  phishingFeedRiskLevel,
  parseCrtShCertificateResults,
  parseUrlhausRecentUrls,
  parsePublicPhishingFeedText,
};
