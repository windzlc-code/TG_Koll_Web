/**
 * scrapers/security-advisory-sources.js — public vulnerability advisory discovery
 *
 * Uses no-key public authority sources for security incident early warning:
 * CISA Known Exploited Vulnerabilities, CISA advisory RSS, NVD CVE API 2.0,
 * and public data breach catalogs.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const CISA_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const CISA_ADVISORIES_RSS_URL = "https://www.cisa.gov/cybersecurity-advisories/all.xml";
const CISA_ICS_ADVISORIES_RSS_URL = "https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml";
const HIBP_BREACHES_URL = "https://haveibeenpwned.com/api/v3/breaches";

function cleanText(value = "", max = 1200) {
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
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeSecurityAdvisoryKeywordText(raw);
  const cves = [...raw.matchAll(/CVE-\d{4}-\d{4,}/gi)].map(match => match[0].toUpperCase());
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...cves, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeSecurityAdvisoryKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeSecurityAdvisoryKeywordText(text);
  return keywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeSecurityAdvisoryKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function keywordMatchSource(fields = [], keyword = "") {
  const needles = keywordNeedles(keyword);
  if (!needles.length) return "";
  for (const field of fields) {
    if (textMatchesKeyword(field?.value || "", keyword)) return field.name || "text";
  }
  return "source_search";
}

function nvdCveSearchUrl(keyword = "", { startIndex = 0, resultsPerPage = 20 } = {}) {
  const params = new URLSearchParams({
    keywordSearch: cleanText(keyword, 120),
    startIndex: String(Math.max(0, Number(startIndex) || 0)),
    resultsPerPage: String(Math.max(1, Math.min(50, Number(resultsPerPage) || 20))),
  });
  return `https://services.nvd.nist.gov/rest/json/cves/2.0?${params.toString()}`;
}

function bestCvssMetric(cve = {}) {
  const metrics = cve.metrics || {};
  const groups = [
    ...(metrics.cvssMetricV40 || []),
    ...(metrics.cvssMetricV31 || []),
    ...(metrics.cvssMetricV30 || []),
    ...(metrics.cvssMetricV2 || []),
  ];
  const scored = groups
    .map(item => ({
      version: cleanText(item.cvssData?.version || "", 20),
      score: Number(item.cvssData?.baseScore),
      severity: cleanText(item.cvssData?.baseSeverity || item.baseSeverity || "", 40).toUpperCase(),
      vector: cleanText(item.cvssData?.vectorString || "", 160),
      source: cleanText(item.source || "", 120),
    }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);
  return scored[0] || { version: "", score: 0, severity: "", vector: "", source: "" };
}

function cveRiskLevel({ kev = false, cvssScore = 0, severity = "" } = {}) {
  if (kev) return "high";
  if (Number(cvssScore) >= 9) return "high";
  if (/CRITICAL/i.test(severity)) return "high";
  if (Number(cvssScore) >= 7) return "medium";
  if (/HIGH/i.test(severity)) return "medium";
  return "low";
}

function advisoryRiskLevel({ title = "", content = "" } = {}) {
  const text = `${title} ${content}`.toLowerCase();
  if (/known exploited|active exploitation|exploited in the wild|emergency directive|ransomware|critical vulnerability|critical severity|remote code execution|zero-?day|actively exploited|kev catalog|malware|勒索|已利用|零日|遠端代碼|远程代码/i.test(text)) return "high";
  if (/cve-\d{4}-\d{4,}|vulnerability|security update|patch|advisory|alert|incident|threat actor|exploitation|phishing|漏洞|安全公告|補丁|补丁|威脅|威胁/i.test(text)) return "medium";
  return "low";
}

function cveDescription(cve = {}) {
  const descriptions = Array.isArray(cve.descriptions) ? cve.descriptions : [];
  return cleanText(
    descriptions.find(item => item.lang === "en")?.value || descriptions[0]?.value || "",
    1000,
  );
}

function cveWeaknesses(cve = {}) {
  return (Array.isArray(cve.weaknesses) ? cve.weaknesses : [])
    .flatMap(item => Array.isArray(item.description) ? item.description : [])
    .map(item => cleanText(item.value || "", 80))
    .filter(Boolean)
    .slice(0, 12);
}

function cveReferences(cve = {}) {
  return (Array.isArray(cve.references?.referenceData) ? cve.references.referenceData : cve.references || [])
    .map(item => cleanText(item.url || "", 500))
    .filter(Boolean)
    .slice(0, 8);
}

function cvssVectorContext(vector = "") {
  const raw = cleanText(vector, 220).toUpperCase();
  const entries = Object.fromEntries(raw.split("/").map(part => {
    const [key, value] = part.split(":");
    return key && value ? [key, value] : null;
  }).filter(Boolean));
  return {
    security_attack_vector: entries.AV || "",
    security_attack_complexity: entries.AC || "",
    security_privileges_required: entries.PR || "",
    security_user_interaction: entries.UI || "",
    security_confidentiality_impact: entries.C || "",
    security_integrity_impact: entries.I || "",
    security_availability_impact: entries.A || "",
    security_network_exploitable_signal: entries.AV === "N" ? 1 : 0,
    security_low_complexity_signal: entries.AC === "L" ? 1 : 0,
    security_no_privileges_required_signal: entries.PR === "N" ? 1 : 0,
    security_no_user_interaction_signal: entries.UI === "N" ? 1 : 0,
  };
}

function securityAdvisorySignals({
  title = "",
  content = "",
  cvssVector = "",
  cvssScore = 0,
  kev = false,
  ransomwareUse = "",
  cisaDueDate = "",
  dataClasses = [],
  pwnCount = 0,
  verified = false,
  sensitive = false,
  malware = false,
  stealerLog = false,
  ot = false,
} = {}) {
  const vector = cvssVectorContext(cvssVector);
  const dataClassText = Array.isArray(dataClasses) ? dataClasses.join(" ") : String(dataClasses || "");
  const text = cleanText(`${title} ${content} ${ransomwareUse} ${dataClassText}`, 2600).toLowerCase();
  const knownExploited = kev || /known exploited|active exploitation|actively exploited|exploited in the wild|kev catalog|已利用|在野利用/.test(text);
  const ransomware = /ransomware|勒索/.test(text) || /^known$/i.test(cleanText(ransomwareUse, 80));
  const remoteExploit = vector.security_network_exploitable_signal === 1 || /remote code execution|rce|network exploitable|pre-auth|远程代码|遠端代碼|远程执行|遠端執行/.test(text);
  const noAuth = vector.security_no_privileges_required_signal === 1 || /unauthenticated|pre-auth|no authentication|无需认证|無需認證/.test(text);
  const noUserInteraction = vector.security_no_user_interaction_signal === 1 || /no user interaction|without user interaction|无需用户交互|無需使用者互動/.test(text);
  const dataExposure = sensitive || /breach|leak|data exposure|exfiltration|customer data|personal data|外洩|泄露|数据泄露|資料外洩/.test(text);
  const credentialExposure = stealerLog || /password|credential|token|secret|api key|session|cookie|密碼|密码|憑證|凭证|令牌/.test(text);
  const patchDeadline = Boolean(normalizeDate(cisaDueDate));
  const largeBreach = Number(pwnCount || 0) >= 1000000 && verified;
  const malwareStealer = malware || stealerLog || /malware|stealer|trojan|backdoor|木马|木馬|后门|後門/.test(text);
  const otIcs = ot || /ics|industrial control|scada|operational technology|factory|plc|工控|工业控制|工業控制/.test(text);
  const criticalCvss = Number(cvssScore || 0) >= 9;
  const publicPoc = /proof of concept|proof-of-concept|\bpoc\b|exploit code|metasploit|github exploit|packet storm|公開poc|公开poc|漏洞利用代碼|漏洞利用代码|利用脚本|利用腳本/.test(text);
  const patchAvailable = /patch available|patched|security update|fixed version|vendor fix|hotfix|update available|補丁|补丁|修補|修复|已修復|已修复|安全更新/.test(text);
  const mitigation = /mitigation|workaround|disable|block|isolate|apply update|configuration change|緩解|缓解|暫時措施|临时措施|停用|封鎖|隔離|配置變更|配置变更/.test(text);
  const vendorAdvisory = /vendor advisory|vendor bulletin|security bulletin|manufacturer advisory|cisco advisory|microsoft advisory|oracle advisory|apache advisory|供應商公告|供应商公告|安全公告|廠商公告|厂商公告/.test(text);
  const assetExposure = /internet-facing|publicly exposed|edge device|vpn|firewall|router|gateway|cloud|saas|exposed server|外網|公网|公開暴露|公开暴露|邊界設備|边界设备|防火牆|防火墙|路由器|網關|网关/.test(text);
  const incidentResponse = /incident response|compromise|breach response|forensic|containment|ioc|indicator of compromise|入侵|攻擊事件|攻击事件|鑑識|取證|取证|遏制|入侵指標|入侵指标/.test(text);
  const reasons = [];
  if (knownExploited) reasons.push("known-exploited");
  if (ransomware) reasons.push("ransomware-risk");
  if (remoteExploit) reasons.push("remote-exploitability");
  if (noAuth) reasons.push("no-auth-required");
  if (noUserInteraction) reasons.push("no-user-interaction");
  if (dataExposure) reasons.push("data-exposure");
  if (credentialExposure) reasons.push("credential-exposure");
  if (patchDeadline) reasons.push("patch-deadline");
  if (largeBreach) reasons.push("large-verified-breach");
  if (malwareStealer) reasons.push("malware-stealer");
  if (otIcs) reasons.push("ot-ics-context");
  if (criticalCvss) reasons.push("critical-cvss");
  if (publicPoc) reasons.push("public-poc-or-exploit-code");
  if (patchAvailable) reasons.push("patch-available");
  if (mitigation) reasons.push("mitigation-guidance");
  if (vendorAdvisory) reasons.push("vendor-advisory");
  if (assetExposure) reasons.push("internet-facing-asset");
  if (incidentResponse) reasons.push("incident-response-context");
  const exploitabilityScore = Math.min(100, Math.max(0,
    (knownExploited ? 35 : 0)
    + (ransomware ? 18 : 0)
    + (remoteExploit ? 14 : 0)
    + (noAuth ? 10 : 0)
    + (noUserInteraction ? 8 : 0)
    + (dataExposure ? 10 : 0)
    + (credentialExposure ? 10 : 0)
    + (patchDeadline ? 5 : 0)
    + (largeBreach ? 18 : 0)
    + (malwareStealer ? 16 : 0)
    + (otIcs ? 8 : 0)
    + (criticalCvss ? 12 : 0)
    + (publicPoc ? 14 : 0)
    + (patchAvailable ? 4 : 0)
    + (mitigation ? 4 : 0)
    + (vendorAdvisory ? 4 : 0)
    + (assetExposure ? 12 : 0)
    + (incidentResponse ? 10 : 0)
  ));
  const riskBucket = exploitabilityScore >= 70 ? "high" : exploitabilityScore >= 35 ? "medium" : "low";
  const authorityContext = Boolean(
    kev
    || normalizeDate(cisaDueDate)
    || Number(cvssScore || 0) > 0
    || verified
    || (Array.isArray(dataClasses) && dataClasses.length > 0)
    || /cisa|nvd|cve-|hibp|have i been pwned|vendor advisory|security advisory|security bulletin|安全公告/i.test(text)
  );
  const semanticSignalCount = [
    knownExploited || ransomware || criticalCvss || largeBreach || malwareStealer,
    remoteExploit || noAuth || noUserInteraction || publicPoc || assetExposure,
    dataExposure || credentialExposure || otIcs || ransomware || Number(pwnCount || 0) > 0,
    patchDeadline || patchAvailable || mitigation || vendorAdvisory || incidentResponse,
    authorityContext,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5;
  if (completeNarrative) reasons.push("security-complete-incident-narrative");
  return {
    ...vector,
    security_known_exploited_signal: knownExploited ? 1 : 0,
    security_ransomware_signal: ransomware ? 1 : 0,
    security_remote_exploit_signal: remoteExploit ? 1 : 0,
    security_no_auth_signal: noAuth ? 1 : 0,
    security_data_exposure_signal: dataExposure ? 1 : 0,
    security_credential_exposure_signal: credentialExposure ? 1 : 0,
    security_patch_deadline_signal: patchDeadline ? 1 : 0,
    security_large_breach_signal: largeBreach ? 1 : 0,
    security_malware_stealer_signal: malwareStealer ? 1 : 0,
    security_ot_ics_signal: otIcs ? 1 : 0,
    security_critical_cvss_signal: criticalCvss ? 1 : 0,
    security_public_poc_signal: publicPoc ? 1 : 0,
    security_patch_available_signal: patchAvailable ? 1 : 0,
    security_mitigation_guidance_signal: mitigation ? 1 : 0,
    security_vendor_advisory_signal: vendorAdvisory ? 1 : 0,
    security_internet_facing_asset_signal: assetExposure ? 1 : 0,
    security_incident_response_signal: incidentResponse ? 1 : 0,
    security_exploitability_score: exploitabilityScore,
    security_risk_bucket: riskBucket,
    security_semantic_signal_count: semanticSignalCount,
    security_complete_incident_narrative_signal: completeNarrative ? 1 : 0,
    security_signal_count: reasons.length,
    security_signal_reasons: reasons,
  };
}

function dataBreachRiskLevel({ pwnCount = 0, verified = false, sensitive = false, fabricated = false, malware = false, stealerLog = false, dataClasses = [] } = {}) {
  const classes = Array.isArray(dataClasses) ? dataClasses.join(" ").toLowerCase() : "";
  if (fabricated) return "medium";
  if (stealerLog || malware || sensitive) return "high";
  if (Number(pwnCount) >= 1000000 && verified) return "high";
  if (/password|credential|token|secret|social security|government id|passport|credit card|bank|financial|medical|health|phone|physical address/i.test(classes)) return "high";
  if (Number(pwnCount) >= 100000) return "medium";
  return "low";
}

function rssItems(xml = "") {
  const source = String(xml || "");
  const out = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(source)) !== null) {
    const block = match[1] || "";
    const read = (tag, max = 600) => cleanText((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")) || [])[1] || "", max);
    out.push({
      title: read("title", 360),
      link: read("link", 900),
      description: read("description", 1800),
      pubDate: read("pubDate", 120) || read("dc:date", 120),
      creator: read("dc:creator", 120),
      guid: read("guid", 220),
    });
  }
  return out;
}

function countSecurityRssRawItems(xml = "") {
  return rssItems(xml).length;
}

function cveIdsFromText(text = "") {
  return [...new Set([...String(text || "").matchAll(/CVE-\d{4}-\d{4,}/gi)].map(match => match[0].toUpperCase()))].slice(0, 20);
}

function normalizeSecurityAdvisoryDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeSecurityAdvisoryDedupeUrl(embedded);
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

function securityAdvisoryDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const breachName = cleanText(metrics.breach_name || "", 120).toLowerCase();
  if (breachName) return `hibp-breach:${breachName}`;
  const cveId = cleanText(metrics.cve_id || "", 40).toUpperCase();
  if (cveId) return `cve:${cveId}`;
  const cveIds = Array.isArray(metrics.cve_ids) ? metrics.cve_ids.map(value => cleanText(value, 40).toUpperCase()).filter(Boolean) : [];
  if (cveIds.length) return `cve:${cveIds[0]}`;
  return normalizeSecurityAdvisoryDedupeUrl(item.url || metrics.advisory_url || "");
}

export function parseHibpBreaches(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const rawResultCount = rows.length;
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const name = cleanText(row.Name || row.name || "", 120);
    const title = cleanText(row.Title || row.title || name, 260);
    const domain = cleanText(row.Domain || row.domain || "", 220);
    const description = cleanText(row.Description || row.description || "", 1800);
    const breachDate = normalizeDate(row.BreachDate || row.breachDate || "");
    const addedDate = normalizeDate(row.AddedDate || row.addedDate || "");
    const modifiedDate = normalizeDate(row.ModifiedDate || row.modifiedDate || "");
    const publishedAt = addedDate || modifiedDate || breachDate || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const dataClasses = (Array.isArray(row.DataClasses) ? row.DataClasses : Array.isArray(row.dataClasses) ? row.dataClasses : [])
      .map(item => cleanText(item, 120))
      .filter(Boolean)
      .slice(0, 40);
    const haystack = [
      name,
      title,
      domain,
      description,
      dataClasses.join(" "),
      row.DisclosureUrl || row.disclosureUrl || "",
      row.LogoPath || row.logoPath || "",
    ].join(" ");
    if (!textMatchesKeyword(haystack, keyword)) continue;
    const dedupeKey = name || domain || title;
    if (!dedupeKey || seen.has(dedupeKey.toLowerCase())) continue;
    seen.add(dedupeKey.toLowerCase());
    const pwnCount = Number(row.PwnCount ?? row.pwnCount ?? 0);
    const verified = Boolean(row.IsVerified ?? row.isVerified);
    const fabricated = Boolean(row.IsFabricated ?? row.isFabricated);
    const sensitive = Boolean(row.IsSensitive ?? row.isSensitive);
    const malware = Boolean(row.IsMalware ?? row.isMalware);
    const stealerLog = Boolean(row.IsStealerLog ?? row.isStealerLog);
    const riskLevel = dataBreachRiskLevel({ pwnCount, verified, sensitive, fabricated, malware, stealerLog, dataClasses });
    const content = [
      description,
      domain ? `Domain: ${domain}.` : "",
      breachDate ? `Breach date: ${breachDate.slice(0, 10)}.` : "",
      Number.isFinite(pwnCount) && pwnCount > 0 ? `Impacted accounts: ${pwnCount}.` : "",
      dataClasses.length ? `Data classes: ${dataClasses.join(", ")}.` : "",
      fabricated ? "HIBP flags this breach as fabricated." : "",
      sensitive ? "HIBP flags this breach as sensitive." : "",
      malware ? "HIBP flags this breach as malware-related." : "",
      stealerLog ? "HIBP flags this breach as stealer-log related." : "",
    ].filter(Boolean).join(" ");
    out.push({
      url: name ? `https://haveibeenpwned.com/PwnedWebsites#${encodeURIComponent(name)}` : "https://haveibeenpwned.com/PwnedWebsites",
      title: `HIBP data breach catalog: ${title || name || domain || keyword}`,
      content,
      author: "Have I Been Pwned",
      publishedAt,
      riskLevel,
      evidenceType: "public_data_breach_catalog",
      metrics: {
        source: "have_i_been_pwned_breach_catalog",
        source_family: "security",
        source_kind: "public_data_breach_catalog",
        collection_mode: "hibp_public_breaches_json",
        hibp_search_raw_breach_count: rawResultCount,
        security_advisory_matched_keyword: keyword,
        security_advisory_keyword_match_source: keywordMatchSource([
          { name: "breach_name", value: name },
          { name: "breach_title", value: title },
          { name: "breach_domain", value: domain },
          { name: "description", value: description },
          { name: "data_classes", value: dataClasses.join(" ") },
        ], keyword),
        breach_record_source: "Have I Been Pwned Breach Catalog",
        breach_name: name,
        breach_title: title,
        breach_domain: domain,
        breach_date: breachDate,
        breach_added_date: addedDate,
        breach_modified_date: modifiedDate,
        breach_pwn_count: Number.isFinite(pwnCount) ? pwnCount : 0,
        breach_data_classes: dataClasses,
        breach_is_verified: verified,
        breach_is_fabricated: fabricated,
        breach_is_sensitive: sensitive,
        breach_is_retired: Boolean(row.IsRetired ?? row.isRetired),
        breach_is_spam_list: Boolean(row.IsSpamList ?? row.isSpamList),
        breach_is_malware: malware,
        breach_is_subscription_free: Boolean(row.IsSubscriptionFree ?? row.isSubscriptionFree),
        breach_is_stealer_log: stealerLog,
        breach_disclosure_url: cleanText(row.DisclosureUrl || row.disclosureUrl || "", 900),
        source_weight_tier: "public-data-breach-catalog",
        ...securityAdvisorySignals({
          title,
          content,
          dataClasses,
          pwnCount,
          verified,
          sensitive,
          malware,
          stealerLog,
        }),
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseCisaAdvisoryRss(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  const rawItems = rssItems(xml);
  const rawResultCount = rawItems.length;
  for (const item of rawItems) {
    const title = cleanText(item.title, 360);
    const content = cleanText(item.description, 1800);
    const publishedAt = normalizeDate(item.pubDate) || new Date().toISOString();
    if (!title || !isAfterSince(publishedAt, since)) continue;
    const haystack = [title, content, item.link, item.guid].join(" ");
    if (!textMatchesKeyword(haystack, keyword)) continue;
    const dedupeKey = item.link || item.guid || `${title}:${publishedAt}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const cveIds = cveIdsFromText(haystack);
    const riskLevel = advisoryRiskLevel({ title, content });
    const signals = securityAdvisorySignals({
      title,
      content,
      kev: riskLevel === "high",
    });
    out.push({
      url: item.link || CISA_ADVISORIES_RSS_URL,
      title: `CISA security advisory: ${title}`,
      content,
      author: cleanText(item.creator || "CISA", 120),
      publishedAt,
      riskLevel,
      metrics: {
        source: "cisa_cybersecurity_advisories",
        source_family: "security",
        source_kind: "public_security_advisory",
        collection_mode: "cisa_advisory_public_rss",
        cisa_advisory_rss_raw_item_count: rawResultCount,
        security_advisory_matched_keyword: keyword,
        security_advisory_keyword_match_source: keywordMatchSource([
          { name: "title", value: title },
          { name: "description", value: content },
          { name: "url", value: item.link },
          { name: "guid", value: item.guid },
        ], keyword),
        advisory_record_source: "CISA Cybersecurity Advisories",
        advisory_title: title,
        advisory_url: item.link || "",
        cve_ids: cveIds,
        advisory_risk_level: riskLevel,
        source_weight_tier: riskLevel === "high" ? "known-exploited-vulnerability" : "security-advisory",
        ...signals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseCisaIcsAdvisoryRss(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  const rawItems = rssItems(xml);
  const rawResultCount = rawItems.length;
  for (const item of rawItems) {
    const title = cleanText(item.title, 360);
    const content = cleanText(item.description, 2200);
    const publishedAt = normalizeDate(item.pubDate) || new Date().toISOString();
    if (!title || !isAfterSince(publishedAt, since)) continue;
    const haystack = [title, content, item.link, item.guid].join(" ");
    if (!textMatchesKeyword(haystack, keyword)) continue;
    const dedupeKey = item.link || item.guid || `cisa-ics:${title}:${publishedAt}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const cveIds = cveIdsFromText(haystack);
    const riskLevel = advisoryRiskLevel({ title, content });
    const signals = securityAdvisorySignals({
      title,
      content,
      kev: riskLevel === "high",
      ot: true,
    });
    out.push({
      url: item.link || CISA_ICS_ADVISORIES_RSS_URL,
      title: `CISA ICS security advisory: ${title}`,
      content,
      author: cleanText(item.creator || "CISA ICS", 120),
      publishedAt,
      riskLevel,
      metrics: {
        source: "cisa_ics_advisories",
        source_family: "security",
        source_kind: "ot_ics_security_advisory",
        collection_mode: "cisa_ics_advisory_public_rss",
        cisa_ics_advisory_rss_raw_item_count: rawResultCount,
        security_advisory_matched_keyword: keyword,
        security_advisory_keyword_match_source: keywordMatchSource([
          { name: "title", value: title },
          { name: "description", value: content },
          { name: "url", value: item.link },
          { name: "guid", value: item.guid },
        ], keyword),
        advisory_record_source: "CISA ICS Advisories",
        advisory_title: title,
        advisory_url: item.link || "",
        cve_ids: cveIds,
        advisory_risk_level: riskLevel,
        ot_security_context: true,
        source_weight_tier: "ot-security-advisory",
        ...signals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseCisaKevCatalog(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.vulnerabilities) ? payload.vulnerabilities : [];
  const rawResultCount = rows.length;
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    const cveId = cleanText(item.cveID || item.cveId || item.cve || "", 40).toUpperCase();
    const vendor = cleanText(item.vendorProject || item.vendor || "", 160);
    const product = cleanText(item.product || "", 160);
    const name = cleanText(item.vulnerabilityName || item.name || "", 260);
    const description = cleanText(item.shortDescription || item.description || "", 900);
    const dateAdded = normalizeDate(item.dateAdded || item.date_added || item.published);
    if (!isAfterSince(dateAdded || new Date().toISOString(), since)) continue;
    const haystack = [cveId, vendor, product, name, description].join(" ");
    if (!textMatchesKeyword(haystack, keyword)) continue;
    const dedupeKey = cveId || `${vendor}:${product}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const ransomwareUse = cleanText(item.knownRansomwareCampaignUse || item.known_ransomware_campaign_use || "", 80);
    const title = `CISA KEV exploited vulnerability: ${cveId || name}`;
    const content = [
      `${vendor} ${product} ${name}`.trim(),
      description,
      ransomwareUse ? `Known ransomware campaign use: ${ransomwareUse}.` : "",
      item.requiredAction ? `Required action: ${cleanText(item.requiredAction, 400)}.` : "",
    ].filter(Boolean).join(" ");
    const dueDate = normalizeDate(item.dueDate || item.due_date);
    const signals = securityAdvisorySignals({
      title,
      content,
      kev: true,
      ransomwareUse,
      cisaDueDate: dueDate,
    });
    out.push({
      url: cveId ? `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}` : CISA_KEV_URL,
      title,
      content,
      author: "CISA Known Exploited Vulnerabilities Catalog",
      publishedAt: dateAdded || new Date().toISOString(),
      riskLevel: "high",
      metrics: {
        source: "cisa_known_exploited_vulnerabilities",
        source_family: "security",
        source_kind: "known_exploited_vulnerability",
        collection_mode: "cisa_kev_public_json",
        cisa_kev_raw_vulnerability_count: rawResultCount,
        security_advisory_matched_keyword: keyword,
        security_advisory_keyword_match_source: keywordMatchSource([
          { name: "cve_id", value: cveId },
          { name: "vendor", value: vendor },
          { name: "product", value: product },
          { name: "vulnerability_name", value: name },
          { name: "description", value: description },
        ], keyword),
        cve_id: cveId,
        vendor,
        product,
        vulnerability_name: name,
        cisa_date_added: dateAdded,
        cisa_due_date: dueDate,
        cisa_required_action: cleanText(item.requiredAction || "", 500),
        known_ransomware_campaign_use: ransomwareUse,
        cwes: Array.isArray(item.cwes) ? item.cwes.slice(0, 12) : [],
        source_weight_tier: "known-exploited-vulnerability",
        ...signals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseNvdCveResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.vulnerabilities) ? payload.vulnerabilities : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const cve = row.cve || row;
    const cveId = cleanText(cve.id || cve.cveId || "", 40).toUpperCase();
    const description = cveDescription(cve);
    const publishedAt = normalizeDate(cve.published || cve.publishedDate || cve.lastModified);
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const cisaName = cleanText(cve.cisaVulnerabilityName || "", 260);
    const haystack = [cveId, description, cisaName].join(" ");
    if (!textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(cveId)) continue;
    seen.add(cveId);
    const cvss = bestCvssMetric(cve);
    const kev = Boolean(cve.cisaExploitAdd || cve.cisaRequiredAction || cisaName);
    const riskLevel = cveRiskLevel({ kev, cvssScore: cvss.score, severity: cvss.severity });
    const title = `NVD vulnerability advisory: ${cveId}`;
    const content = [
      description,
      cisaName ? `CISA vulnerability name: ${cisaName}.` : "",
      cvss.score ? `CVSS ${cvss.version || ""} score ${cvss.score} ${cvss.severity}`.trim() + "." : "",
    ].filter(Boolean).join(" ");
    const cisaActionDue = normalizeDate(cve.cisaActionDue || "");
    const signals = securityAdvisorySignals({
      title,
      content,
      cvssVector: cvss.vector,
      cvssScore: cvss.score,
      kev,
      cisaDueDate: cisaActionDue,
    });
    out.push({
      url: cveId ? `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}` : "https://nvd.nist.gov/vuln/search",
      title,
      content,
      author: "National Vulnerability Database",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      metrics: {
        source: "nvd_cve_api",
        source_family: "security",
        source_kind: "public_vulnerability_advisory",
        collection_mode: "nvd_cve_api_2_0",
        cve_id: cveId,
        cvss_score: cvss.score,
        cvss_severity: cvss.severity,
        cvss_version: cvss.version,
        cvss_vector: cvss.vector,
        weakness_ids: cveWeaknesses(cve),
        reference_urls: cveReferences(cve),
        cisa_exploit_added: normalizeDate(cve.cisaExploitAdd || ""),
        cisa_action_due: cisaActionDue,
        cisa_required_action: cleanText(cve.cisaRequiredAction || "", 500),
        cisa_vulnerability_name: cisaName,
        advisory_risk_level: riskLevel,
        source_weight_tier: kev ? "known-exploited-vulnerability" : "nvd-cve",
        ...signals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertSecurityAdvisoryItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = securityAdvisoryDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = item.riskLevel || assessRiskLevel({ title: item.title, content: item.content, sentiment });
    const result = insertSentimentItem({
      platform: "security_advisory_sources",
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
      source_key: "securityAdvisorySources",
      evidence: {
        evidence_type: item.evidenceType || "security_advisory_vulnerability",
        metrics: {
          ...(item.metrics || {}),
          security_advisory_canonical_dedupe_key: dedupeKey,
          security_advisory_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeSecurityAdvisorySources(keywords, { proxyUrl = "", budget = {}, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const cisaRes = await fetchPublicSource(CISA_KEV_URL, {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (cisaRes.ok) {
        const cisaItems = parseCisaKevCatalog(await cisaRes.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        inserted += await insertSecurityAdvisoryItems(cisaItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      } else {
        failures.push({ keyword, target: "cisa-kev", message: httpFailure(cisaRes) });
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const cisaAdvisoryRes = await fetchPublicSource(CISA_ADVISORIES_RSS_URL, {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml,application/xml,text/xml,text/plain,*/*" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (cisaAdvisoryRes.ok) {
          const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
          const cisaAdvisoryItems = parseCisaAdvisoryRss(await cisaAdvisoryRes.text(), keyword, { limit: remaining, since });
          inserted += await insertSecurityAdvisoryItems(cisaAdvisoryItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "cisa-advisories-rss", message: httpFailure(cisaAdvisoryRes) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const cisaIcsAdvisoryRes = await fetchPublicSource(CISA_ICS_ADVISORIES_RSS_URL, {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml,application/xml,text/xml,text/plain,*/*" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (cisaIcsAdvisoryRes.ok) {
          const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
          const cisaIcsAdvisoryItems = parseCisaIcsAdvisoryRss(await cisaIcsAdvisoryRes.text(), keyword, { limit: remaining, since });
          inserted += await insertSecurityAdvisoryItems(cisaIcsAdvisoryItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "cisa-ics-advisories-rss", message: httpFailure(cisaIcsAdvisoryRes) });
        }
      }
      for (let page = 0; page < normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        const res = await fetchPublicSource(nvdCveSearchUrl(keyword, { startIndex: page * 20, resultsPerPage: Math.min(20, remaining) }), {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `nvd-cve:page:${page + 1}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawVulnerabilityCount = Array.isArray(payload?.vulnerabilities) ? payload.vulnerabilities.length : 0;
        const startIndex = page * 20;
        const items = parseNvdCveResults(payload, keyword, { limit: remaining, since }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            nvd_search_page: page + 1,
            nvd_search_start_index: startIndex,
            nvd_search_raw_vulnerability_count: rawVulnerabilityCount,
            nvd_search_total_results: Number(payload?.totalResults || 0),
          },
        }));
        inserted += await insertSecurityAdvisoryItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        if (!rawVulnerabilityCount) break;
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        const hibpRes = await fetchPublicSource(HIBP_BREACHES_URL, {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (hibpRes.ok) {
          const hibpItems = parseHibpBreaches(await hibpRes.json(), keyword, { limit: remaining, since });
          inserted += await insertSecurityAdvisoryItems(hibpItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "hibp-breaches", message: httpFailure(hibpRes) });
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "security-advisory", message });
      console.warn(`[CRM/SecurityAdvisory] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  CISA_KEV_URL,
  CISA_ADVISORIES_RSS_URL,
  CISA_ICS_ADVISORIES_RSS_URL,
  HIBP_BREACHES_URL,
  normalizeBudget,
  normalizeSecurityAdvisoryKeywordText,
  textMatchesKeyword,
  nvdCveSearchUrl,
  advisoryRiskLevel,
  cveRiskLevel,
  cvssVectorContext,
  securityAdvisorySignals,
  dataBreachRiskLevel,
  countSecurityRssRawItems,
  keywordMatchSource,
  normalizeSecurityAdvisoryDedupeUrl,
  securityAdvisoryDedupeKey,
  parseCisaAdvisoryRss,
  parseCisaIcsAdvisoryRss,
  parseCisaKevCatalog,
  parseNvdCveResults,
  parseHibpBreaches,
};
