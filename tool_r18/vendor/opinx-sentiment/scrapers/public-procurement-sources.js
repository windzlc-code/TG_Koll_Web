/**
 * scrapers/public-procurement-sources.js — public procurement and contract award discovery
 *
 * Uses no-key public procurement data to collect supplier, customer, and
 * government-contract signals that can become brand or operational risk.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const USASPENDING_AWARD_SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const USASPENDING_CONTRACT_AWARD_TYPES = ["A", "B", "C", "D"];
const UK_CONTRACTS_FINDER_OCDS_SEARCH_URL = "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search";
const DEFAULT_PROCUREMENT_TARGETS = ["usaspending", "ukContractsFinder"];
const PROCUREMENT_CONTEXT_TERMS = [
  "contract",
  "award",
  "procurement",
  "vendor",
  "supplier",
  "grant",
  "agency",
  "modification",
  "solicitation",
  "政府採購",
  "政府采购",
  "招標",
  "招标",
  "投標",
  "投标",
  "中標",
  "中标",
  "合約",
  "合同",
  "供應商",
  "供应商",
];

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
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(5, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeAmount(value) {
  const numeric = Number(String(value ?? "").replace(/[$,£€]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeTargets(targets = DEFAULT_PROCUREMENT_TARGETS) {
  const raw = Array.isArray(targets) ? targets : DEFAULT_PROCUREMENT_TARGETS;
  const normalized = raw
    .map(item => cleanText(item, 80))
    .map(item => {
      const lower = item.toLowerCase().replace(/[_\s-]+/g, "");
      if (lower === "uk" || lower === "contractsfinder" || lower === "ukcontractsfinder") return "ukContractsFinder";
      if (lower === "us" || lower === "usa" || lower === "usaspending" || lower === "usaspendinggov") return "usaspending";
      return "";
    })
    .filter(Boolean);
  return [...new Set(normalized)].length ? [...new Set(normalized)] : DEFAULT_PROCUREMENT_TARGETS;
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeProcurementKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeProcurementKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeProcurementKeywordText(text);
  return keywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeProcurementKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function usaspendingAwardSearchBody(keyword = "", { page = 1, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  return {
    filters: {
      keywords: [cleanText(keyword, 160)],
      award_type_codes: USASPENDING_CONTRACT_AWARD_TYPES,
    },
    fields: [
      "Award ID",
      "Recipient Name",
      "Award Amount",
      "Start Date",
      "End Date",
      "Awarding Agency",
      "Awarding Sub Agency",
      "Description",
      "Award Type",
    ],
    page: Math.max(1, Number(page) || 1),
    limit: Math.max(1, Math.min(100, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD)),
    sort: "Start Date",
    order: "desc",
    subawards: false,
  };
}

function usaspendingAwardUrl(item = {}) {
  const id = cleanText(item.generated_internal_id || item["generated_internal_id"] || item["Award ID"] || item.award_id || "", 180);
  return id
    ? `https://www.usaspending.gov/award/${encodeURIComponent(id)}`
    : "https://www.usaspending.gov/search";
}

function ukContractsFinderSearchUrl(keyword = "", { page = 1, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const url = new URL(UK_CONTRACTS_FINDER_OCDS_SEARCH_URL);
  url.searchParams.set("searchTerm", cleanText(keyword, 160));
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))));
  url.searchParams.set("orderBy", "publishedDate");
  url.searchParams.set("stages", "tender,award");
  const publishedFrom = normalizeDate(since) || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  url.searchParams.set("publishedFrom", publishedFrom.slice(0, 10));
  return url.toString();
}

function normalizeProcurementDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeProcurementDedupeUrl(embedded);
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

function procurementDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const awardId = cleanText(metrics.award_id || "", 180);
  const recipient = cleanText(metrics.recipient_name || "", 220).toLowerCase();
  const startDate = cleanText(metrics.start_date || item.publishedAt || "", 80);
  const source = cleanText(metrics.source || "procurement", 120).toLowerCase();
  const urlKey = normalizeProcurementDedupeUrl(item.url || "");
  if (urlKey && !/\/search$/i.test(urlKey)) return urlKey;
  if (awardId && recipient && startDate) return `${source}:${awardId}:${recipient}:${startDate}`.toLowerCase();
  if (awardId) return `${source}:${awardId}`.toLowerCase();
  return [source, recipient, startDate].filter(Boolean).join(":").toLowerCase();
}

function procurementKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["procurement_record_source", metrics.procurement_record_source],
    ["procurement_record_type", metrics.procurement_record_type],
    ["award_id", metrics.award_id],
    ["recipient_name", metrics.recipient_name],
    ["awarding_agency", metrics.awarding_agency],
    ["awarding_sub_agency", metrics.awarding_sub_agency],
    ["award_type", metrics.award_type],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword(value || "", keyword));
  return match ? match[0] : "";
}

function procurementKeywordDiagnostics(item = {}, keyword = "") {
  return {
    procurement_matched_keyword: cleanText(keyword, 160),
    procurement_keyword_match_source: procurementKeywordMatchSource(item, keyword),
  };
}

function procurementRiskLevel({ amount = 0, text = "", sentiment = "neutral" } = {}) {
  const lower = String(text || "").toLowerCase();
  if (/terminated|suspended|debarred|fraud|investigation|protest|cancelled|canceled|breach|違約|调查|調查|詐騙|诈骗|停權|停权|取消/i.test(lower)) return "high";
  if (Number(amount) >= 10000000 || sentiment === "negative") return "medium";
  return "low";
}

function procurementRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const amount = normalizeAmount(item.amount || metrics.award_amount || 0);
  const text = cleanText([
    item.title,
    item.content,
    item.author,
    metrics.source,
    metrics.source_family,
    metrics.source_kind,
    metrics.procurement_record_source,
    metrics.procurement_record_type,
    metrics.award_id,
    metrics.award_type,
    metrics.recipient_name,
    metrics.awarding_agency,
    metrics.awarding_sub_agency,
    metrics.award_amount,
    metrics.start_date,
    metrics.end_date,
    metrics.procurement_context_terms,
    metrics.source_weight_tier,
  ].filter(Boolean).join(" "), 8000).toLowerCase();
  const reasons = [];
  let score = /public-procurement-record|procurement/i.test(String(metrics.source_weight_tier || metrics.source_family || "")) ? 12 : 8;
  const out = {};
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };
  const termMatches = (terms = []) => terms
    .map(term => cleanText(term, 140).toLowerCase())
    .filter(term => term && text.includes(term));

  addSignal("procurement_public_record_signal", "public procurement or contract record", /procurement|contract|award|tender|solicitation|vendor|supplier|government|usaspending|contracts finder|政府採購|政府采购|招標|招标|投標|投标|中標|中标|合約|合同/i.test(text), 6);
  addSignal("procurement_large_award_signal", "large contract value", amount >= 10000000, 16);
  addSignal("procurement_very_large_award_signal", "very large contract value", amount >= 50000000, 10);
  addSignal("procurement_sensitive_agency_signal", "defense, health, security, or critical public-sector buyer", /defense|defence|dod|military|homeland security|intelligence|justice|police|health|hospital|nhs|veterans|energy|transport|critical|國防|国防|軍事|军事|安全|醫療|医疗|司法|警察|能源|交通/i.test(text), 10);
  addSignal("procurement_single_source_signal", "single-source, sole-source, emergency, or direct award", /sole source|single source|non-competitive|direct award|emergency|urgent|limited competition|single supplier|單一來源|单一来源|緊急|紧急|直接授予/i.test(text), 12);
  addSignal("procurement_supplier_risk_signal", "supplier performance, breach, or operational concern", /breach|default|late delivery|non-performance|poor performance|quality issue|failed to deliver|違約|违约|延誤|延误|履約不良|履约不良|品質問題|质量问题/i.test(text), 14);
  addSignal("procurement_termination_cancellation_signal", "termination, cancellation, or suspension of contract", /terminated|termination|cancelled|canceled|rescinded|suspended contract|contract suspension|終止|终止|取消|暫停|暂停/i.test(text), 14);
  addSignal("procurement_fraud_investigation_signal", "fraud, corruption, investigation, debarment, or suspension", /fraud|corruption|bribery|investigation|debarred|suspended|excluded supplier|false claims|whistleblower|詐騙|诈骗|貪腐|贪腐|賄賂|贿赂|調查|调查|停權|停权|除名/i.test(text), 18);
  addSignal("procurement_protest_dispute_signal", "bid protest, procurement challenge, or dispute", /protest|bid protest|challenge|appeal|dispute|complaint|procurement review|投訴|投诉|申訴|申诉|異議|异议|爭議|争议/i.test(text), 10);
  addSignal("procurement_cross_border_signal", "US or UK public procurement source", /usaspending|usa spending|united states|federal|uk contracts finder|united kingdom|英國|英国|美國|美国|聯邦|联邦/i.test(text), 6);

  const evidenceTerms = termMatches([
    "award id",
    "award amount",
    "contract number",
    "solicitation",
    "notice id",
    "ocds id",
    "recipient",
    "awarding agency",
    "procurement record",
    "usaspending",
    "contracts finder",
    "award type",
    "採購記錄",
    "采购记录",
    "合約編號",
    "合同编号",
  ]);
  const stageTerms = termMatches([
    "contract award",
    "award type",
    "start date",
    "end date",
    "tender",
    "solicitation",
    "modification",
    "renewal",
    "cancellation",
    "termination",
    "bid protest",
    "investigation",
    "招標",
    "招标",
    "中標",
    "中标",
    "終止",
    "终止",
  ]);
  const performanceRemedyTerms = termMatches([
    "late delivery",
    "breach",
    "default",
    "non-performance",
    "failed delivery",
    "corrective action",
    "cure notice",
    "termination",
    "suspension",
    "debarment",
    "remediation",
    "違約",
    "违约",
    "整改",
    "補救",
    "补救",
  ]);
  const integrityTerms = termMatches([
    "fraud",
    "corruption",
    "bribery",
    "false claims",
    "investigation",
    "debarment",
    "debarred",
    "suspended",
    "whistleblower",
    "excluded supplier",
    "詐騙",
    "诈骗",
    "貪腐",
    "贪腐",
    "調查",
    "调查",
    "停權",
    "停权",
  ]);

  addSignal("procurement_evidence_language_signal", "contract record includes award, amount, agency, recipient, notice, or record identifiers", evidenceTerms.length > 0, 8);
  addSignal("procurement_stage_language_signal", "procurement stage, award, tender, modification, termination, protest, or investigation context", stageTerms.length > 0, 8);
  addSignal("procurement_performance_remedy_signal", "supplier performance, breach, cure, corrective, suspension, or debarment remedy context", performanceRemedyTerms.length > 0, 10);
  addSignal("procurement_integrity_language_signal", "integrity, fraud, corruption, false-claims, suspension, or debarment context", integrityTerms.length > 0, 10);

  const semanticSignalCount = [
    out.procurement_public_record_signal,
    out.procurement_large_award_signal,
    out.procurement_very_large_award_signal,
    out.procurement_sensitive_agency_signal,
    out.procurement_single_source_signal,
    out.procurement_supplier_risk_signal,
    out.procurement_termination_cancellation_signal,
    out.procurement_fraud_investigation_signal,
    out.procurement_protest_dispute_signal,
    out.procurement_cross_border_signal,
    out.procurement_evidence_language_signal,
    out.procurement_stage_language_signal,
    out.procurement_performance_remedy_signal,
    out.procurement_integrity_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "procurement_complete_contract_risk_narrative_signal",
    "complete procurement narrative with public record, materiality or sensitive buyer, stage evidence, and performance or integrity risk",
    semanticSignalCount >= 7
      && out.procurement_public_record_signal
      && (out.procurement_large_award_signal || out.procurement_sensitive_agency_signal || out.procurement_single_source_signal)
      && (out.procurement_supplier_risk_signal || out.procurement_fraud_investigation_signal || out.procurement_protest_dispute_signal || out.procurement_termination_cancellation_signal)
      && (out.procurement_evidence_language_signal || out.procurement_stage_language_signal)
      && (out.procurement_performance_remedy_signal || out.procurement_integrity_language_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    procurement_risk_score: boundedScore,
    procurement_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    procurement_signal_count: signalFields.length,
    procurement_semantic_signal_count: semanticSignalCount,
    procurement_evidence_terms: evidenceTerms,
    procurement_stage_terms: stageTerms,
    procurement_performance_remedy_terms: performanceRemedyTerms,
    procurement_integrity_terms: integrityTerms,
    procurement_signal_reasons: [...new Set(reasons)].slice(0, 12),
  };
}

function usaspendingAwardRows(payload = {}) {
  const results = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.results?.results)
      ? payload.results.results
      : [];
  return results;
}

function countUsaspendingAwardRawResults(payload = {}) {
  return usaspendingAwardRows(payload).length;
}

export function parseUsaspendingAwardResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "", page = 1, rawResultCount = 0 } = {}) {
  const results = usaspendingAwardRows(payload);
  const out = [];
  const seen = new Set();
  for (const item of results) {
    const awardId = cleanText(item["Award ID"] || item.award_id || item.awardId || "", 180);
    const recipient = cleanText(item["Recipient Name"] || item.recipient_name || item.recipientName || "", 220);
    const description = cleanText(item.Description || item.description || "", 1200);
    const awardingAgency = cleanText(item["Awarding Agency"] || item.awarding_agency || item.awardingAgency || "", 220);
    const awardingSubAgency = cleanText(item["Awarding Sub Agency"] || item.awarding_sub_agency || item.awardingSubAgency || "", 220);
    const awardType = cleanText(item["Award Type"] || item.award_type || item.awardType || "", 160);
    const publishedAt = normalizeDate(item["Start Date"] || item.start_date || item.startDate || item.date_signed || item.last_modified_date) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const searchable = [awardId, recipient, description, awardingAgency, awardingSubAgency, awardType].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const url = usaspendingAwardUrl(item);
    const dedupeKey = url || `${awardId}:${recipient}:${publishedAt}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const amount = normalizeAmount(item["Award Amount"] ?? item.award_amount ?? item.awardAmount);
    const endDate = normalizeDate(item["End Date"] || item.end_date || item.endDate || "");
    const title = `USAspending procurement award: ${recipient || keyword}`;
    const content = [
      description || `Public procurement award involving ${recipient || keyword}.`,
      awardingAgency ? `Awarding agency: ${awardingAgency}.` : "",
      awardType ? `Award type: ${awardType}.` : "",
      amount ? `Award amount: ${amount}.` : "",
      awardId ? `Award ID: ${awardId}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url,
      title,
      content,
      author: awardingAgency || "USAspending.gov",
      publishedAt,
      amount,
      riskLevel: procurementRiskLevel({ amount, text: content, sentiment: analyzeSentiment(`${title} ${content}`) }),
      metrics: {
        source: "usaspending_award_search",
        source_family: "procurement",
        source_kind: "public_procurement_award",
        collection_mode: "usaspending_public_api",
        procurement_record_source: "USAspending.gov",
        procurement_record_type: "federal-award",
        award_id: awardId,
        award_type: awardType,
        recipient_name: recipient,
        awarding_agency: awardingAgency,
        awarding_sub_agency: awardingSubAgency,
        award_amount: amount,
        start_date: publishedAt,
        end_date: endDate,
        procurement_search_page: Math.max(1, Number(page) || 1),
        procurement_search_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
        procurement_context_terms: PROCUREMENT_CONTEXT_TERMS.slice(0, 12),
        source_weight_tier: "public-procurement-record",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstPartyName(release = {}, role = "") {
  const party = asArray(release.parties).find(item => asArray(item.roles).includes(role));
  return cleanText(party?.name || "", 220);
}

function releaseUrl(release = {}) {
  const links = release.links || {};
  const tenderDocs = asArray(release.tender?.documents);
  const awardDocs = asArray(release.awards).flatMap(award => asArray(award.documents));
  return cleanText(
    links.self
      || links.web
      || links.alternate
      || tenderDocs.find(doc => doc?.url)?.url
      || awardDocs.find(doc => doc?.url)?.url
      || "",
    900,
  );
}

function releaseValue(release = {}) {
  const tenderValue = normalizeAmount(release.tender?.value?.amount);
  if (tenderValue) return tenderValue;
  for (const award of asArray(release.awards)) {
    const awardValue = normalizeAmount(award?.value?.amount);
    if (awardValue) return awardValue;
  }
  return 0;
}

function contractsFinderReleases(payload = {}) {
  if (Array.isArray(payload?.releases)) return payload.releases;
  if (Array.isArray(payload?.results)) {
    return payload.results.flatMap(item => {
      if (Array.isArray(item?.releases)) return item.releases;
      if (item?.compiledRelease) return [item.compiledRelease];
      return item?.ocid || item?.tender || item?.awards ? [item] : [];
    });
  }
  if (Array.isArray(payload?.packages)) return payload.packages.flatMap(item => asArray(item.releases));
  if (Array.isArray(payload?.records)) return payload.records.flatMap(item => item?.compiledRelease ? [item.compiledRelease] : asArray(item.releases));
  return [];
}

function countContractsFinderRawResults(payload = {}) {
  return contractsFinderReleases(payload).length;
}

export function parseContractsFinderNoticeResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "", page = 1, rawResultCount = 0 } = {}) {
  const releases = contractsFinderReleases(payload);
  const out = [];
  const seen = new Set();
  for (const release of releases) {
    const tender = release.tender || {};
    const awards = asArray(release.awards);
    const award = awards[0] || {};
    const awardSuppliers = awards.flatMap(item => asArray(item.suppliers).map(supplier => cleanText(supplier?.name || "", 220))).filter(Boolean);
    const buyer = cleanText(release.buyer?.name || tender.procuringEntity?.name || firstPartyName(release, "buyer"), 220);
    const recipient = cleanText(awardSuppliers[0] || firstPartyName(release, "supplier") || "", 220);
    const title = cleanText(tender.title || award.title || release.title || `UK Contracts Finder notice: ${recipient || buyer || keyword}`, 260);
    const description = cleanText(tender.description || award.description || release.description || "", 1800);
    const publishedAt = normalizeDate(release.date || award.date || tender.datePublished || tender.tenderPeriod?.startDate || release.publishedDate) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const searchable = [
      release.ocid,
      release.id,
      title,
      description,
      buyer,
      recipient,
      awardSuppliers.join(" "),
      tender.procurementMethodDetails,
      tender.status,
      award.status,
    ].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const noticeUrl = releaseUrl(release) || (release.ocid ? `https://www.contractsfinder.service.gov.uk/Notice/${encodeURIComponent(release.ocid)}` : "https://www.contractsfinder.service.gov.uk/Search");
    const dedupeKey = normalizeProcurementDedupeUrl(noticeUrl) || cleanText(release.ocid || release.id || title, 240);
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const amount = releaseValue(release);
    const content = [
      description || `UK public procurement notice involving ${recipient || buyer || keyword}.`,
      buyer ? `Buyer: ${buyer}.` : "",
      recipient ? `Supplier: ${recipient}.` : "",
      tender.procurementMethodDetails ? `Procurement method: ${cleanText(tender.procurementMethodDetails, 180)}.` : "",
      amount ? `Value: ${amount}.` : "",
      release.ocid ? `OCDS ID: ${cleanText(release.ocid, 180)}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url: noticeUrl,
      title: `UK Contracts Finder notice: ${title}`,
      content,
      author: buyer || "UK Contracts Finder",
      publishedAt,
      amount,
      riskLevel: procurementRiskLevel({ amount, text: content, sentiment: analyzeSentiment(`${title} ${content}`) }),
      metrics: {
        source: "uk_contracts_finder_ocds_search",
        source_family: "procurement",
        source_kind: "public_procurement_notice",
        collection_mode: "uk_contracts_finder_public_ocds_search",
        procurement_record_source: "UK Contracts Finder",
        procurement_record_type: "uk-contracts-finder-notice",
        award_id: cleanText(release.ocid || release.id || award.id || tender.id || "", 180),
        award_type: cleanText(asArray(release.tag).join(",") || tender.status || award.status || "", 160),
        recipient_name: recipient,
        awarding_agency: buyer,
        awarding_sub_agency: "",
        award_amount: amount,
        start_date: publishedAt,
        end_date: normalizeDate(tender.tenderPeriod?.endDate || tender.contractPeriod?.endDate || ""),
        procurement_search_page: Math.max(1, Number(page) || 1),
        procurement_search_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
        procurement_context_terms: PROCUREMENT_CONTEXT_TERMS.slice(0, 12),
        source_weight_tier: "public-procurement-record",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertProcurementItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = procurementDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = item.riskLevel || assessRiskLevel({ title: item.title, content: item.content, sentiment });
    const result = insertSentimentItem({
      platform: "public_procurement_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment,
      risk_level: risk,
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "publicProcurementSources",
      evidence: {
        evidence_type: "public_procurement_award",
        metrics: {
          ...(item.metrics || {}),
          ...procurementRiskSignals(item),
          ...procurementKeywordDiagnostics(item, keyword),
          procurement_canonical_dedupe_key: dedupeKey,
          procurement_search_scan_dedupe_key: dedupeKey,
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

export async function scrapePublicProcurementSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = DEFAULT_PROCUREMENT_TARGETS, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedTargets = normalizeTargets(targets);
  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of normalizedTargets) {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword; page += 1) tasks.push({ keyword, page, target });
    }
  }
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, page, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      const isUk = target === "ukContractsFinder";
      const res = isUk
        ? await fetchPublicSource(ukContractsFinderSearchUrl(keyword, { page, limit: normalizedBudget.maxItemsPerKeyword, since }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl)
        : await fetchPublicSource(USASPENDING_AWARD_SEARCH_URL, {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(usaspendingAwardSearchBody(keyword, { page, limit: normalizedBudget.maxItemsPerKeyword })),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: `${target}:page:${page}`, message: httpFailure(res) });
        return { inserted, failures };
      }
      const payload = await res.json();
      const rawResultCount = isUk
        ? countContractsFinderRawResults(payload)
        : countUsaspendingAwardRawResults(payload);
      const items = isUk ? parseContractsFinderNoticeResults(payload, keyword, {
        limit: normalizedBudget.maxItemsPerKeyword,
        since,
        page,
        rawResultCount,
      }) : parseUsaspendingAwardResults(payload, keyword, {
        limit: normalizedBudget.maxItemsPerKeyword,
        since,
        page,
        rawResultCount,
      });
      inserted += await insertProcurementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target, message });
      console.warn(`[CRM/PublicProcurement] 抓取失敗 target=${target} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  USASPENDING_AWARD_SEARCH_URL,
  USASPENDING_CONTRACT_AWARD_TYPES,
  UK_CONTRACTS_FINDER_OCDS_SEARCH_URL,
  DEFAULT_PROCUREMENT_TARGETS,
  PROCUREMENT_CONTEXT_TERMS,
  normalizeBudget,
  normalizeTargets,
  normalizeProcurementKeywordText,
  textMatchesKeyword,
  countUsaspendingAwardRawResults,
  countContractsFinderRawResults,
  usaspendingAwardSearchBody,
  usaspendingAwardUrl,
  ukContractsFinderSearchUrl,
  normalizeProcurementDedupeUrl,
  procurementDedupeKey,
  procurementKeywordMatchSource,
  procurementKeywordDiagnostics,
  procurementRiskLevel,
  procurementRiskSignals,
  parseUsaspendingAwardResults,
  parseContractsFinderNoticeResults,
};
