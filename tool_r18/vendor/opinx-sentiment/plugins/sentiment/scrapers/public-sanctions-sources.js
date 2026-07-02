/**
 * scrapers/public-sanctions-sources.js — public sanctions and watchlist discovery
 *
 * Uses no-key public sanctions files to collect high-trust compliance risk
 * signals, starting with OFAC SDN and Consolidated Non-SDN CSV exports.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const OFAC_SDN_CSV_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const OFAC_CONSOLIDATED_CSV_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV";
const UK_SANCTIONS_LIST_CSV_URL = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv";
const EU_CONSOLIDATED_FINANCIAL_SANCTIONS_XML_URL = "https://webgate.ec.europa.eu/europeaid/fsd/fsf/public/files/xmlFullSanctionsList/content?token=dG9rZW4tMjAxNw";
const UN_SECURITY_COUNCIL_CONSOLIDATED_XML_URL = "https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidatedLegacyByNAME.xml";
const DEFAULT_SANCTIONS_TARGETS = [
  { key: "ofac_sdn", name: "OFAC SDN List", url: OFAC_SDN_CSV_URL, listType: "sdn" },
  { key: "ofac_consolidated", name: "OFAC Consolidated Non-SDN List", url: OFAC_CONSOLIDATED_CSV_URL, listType: "consolidated" },
  { key: "uk_sanctions_list", name: "UK Sanctions List", url: UK_SANCTIONS_LIST_CSV_URL, listType: "uk-sanctions-list", kind: "uk_sanctions_csv" },
  { key: "eu_consolidated_financial_sanctions", name: "EU Consolidated Financial Sanctions List", url: EU_CONSOLIDATED_FINANCIAL_SANCTIONS_XML_URL, listType: "eu-consolidated-financial-sanctions", kind: "eu_sanctions_xml" },
  { key: "un_security_council_consolidated", name: "UN Security Council Consolidated List", url: UN_SECURITY_COUNCIL_CONSOLIDATED_XML_URL, listType: "un-security-council-consolidated", kind: "un_sanctions_xml" },
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
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(50, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function csvRows(text = "") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(item => item.some(cellValue => cleanText(cellValue, 20)));
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeSanctionsKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeSanctionsKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeSanctionsKeywordText(text);
  return keywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeSanctionsKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function sanctionsRiskLevel({ listType = "", remarks = "", programs = "" } = {}) {
  const text = `${listType} ${remarks} ${programs}`.toLowerCase();
  if (/sdn|uk-sanctions-list|eu-consolidated-financial-sanctions|un-security-council-consolidated|asset freeze|funds freeze|freezing of funds|travel ban|trust services|un list|al-qaida|isil|terror|narcotics|wmd|cyber|ransomware|blocked|制裁|恐怖|毒品|勒索/i.test(text)) return "high";
  return "medium";
}

function normalizeSanctionsEntityToken(value = "") {
  return cleanText(value, 260).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function sanctionsDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const source = cleanText(metrics.source || metrics.sanctions_record_source || "public-sanctions", 140).toLowerCase();
  const entityId = cleanText(metrics.sanctions_entity_id || "", 180);
  if (entityId) return `${source}:id:${entityId}`.toLowerCase();
  const unReference = cleanText(metrics.sanctions_un_reference || metrics.sanctions_reference_number || "", 180);
  if (unReference) return `${source}:un:${unReference}`.toLowerCase();
  const name = normalizeSanctionsEntityToken(metrics.sanctions_entity_name || item.title || "");
  const entityType = normalizeSanctionsEntityToken(metrics.sanctions_entity_type || "");
  const programs = normalizeSanctionsEntityToken(metrics.sanctions_programs || "");
  return [source, name, entityType, programs].filter(Boolean).join(":").toLowerCase();
}

function sanctionsKeywordMatchSource(item = {}, keyword = "") {
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["record_source", item.metrics?.sanctions_record_source],
    ["entity_name", item.metrics?.sanctions_entity_name],
    ["entity_id", item.metrics?.sanctions_entity_id],
    ["programs", item.metrics?.sanctions_programs],
    ["remarks", item.metrics?.sanctions_remarks],
    ["reference", item.metrics?.sanctions_un_reference || item.metrics?.sanctions_reference_number],
    ["vessel_owner", item.metrics?.vessel_owner],
  ];
  return fields.find(([, value]) => textMatchesKeyword(value, keyword))?.[0] || "search_query";
}

function sanctionsKeywordDiagnostics(item = {}, keyword = "") {
  return {
    sanctions_matched_keyword: cleanText(keyword, 160),
    sanctions_keyword_match_source: sanctionsKeywordMatchSource(item, keyword),
  };
}

function sanctionsRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = cleanText([
    item.title,
    item.content,
    item.author,
    metrics.source,
    metrics.source_family,
    metrics.source_kind,
    metrics.sanctions_record_source,
    metrics.sanctions_list_type,
    metrics.sanctions_entity_id,
    metrics.sanctions_entity_name,
    metrics.sanctions_entity_type,
    metrics.sanctions_ofsi_group_id,
    metrics.sanctions_un_reference,
    metrics.sanctions_reference_number,
    metrics.sanctions_programs,
    metrics.sanctions_title,
    metrics.sanctions_remarks,
    metrics.sanctions_imposed,
    metrics.sanctions_measures,
    metrics.sanctions_regulation,
    metrics.sanctions_designation_source,
    metrics.sanctions_designation_date,
    metrics.sanctions_listed_on,
    metrics.sanctions_address_country,
    metrics.sanctions_nationality,
    metrics.sanctions_birth_date,
    metrics.vessel_flag,
    metrics.vessel_owner,
    metrics.sanctions_interpol_link,
    metrics.source_weight_tier,
  ].filter(Boolean).join(" "), 9000).toLowerCase();
  const reasons = [];
  let score = /public-sanctions-watchlist|compliance/i.test(String(metrics.source_weight_tier || metrics.source_family || "")) ? 18 : 10;
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

  addSignal("sanctions_watchlist_signal", "public sanctions or watchlist entry", /sanctions|watchlist|ofac|sdn|consolidated|security council|asset freeze|funds freeze|制裁|清單|清单/i.test(text), 10);
  addSignal("sanctions_blocking_freeze_signal", "asset, funds, or economic-resource freeze", /asset freeze|funds freeze|freezing of funds|economic resources|blocked|blocking|凍結資產|冻结资产|資金凍結|资金冻结/i.test(text), 14);
  addSignal("sanctions_sdn_signal", "OFAC SDN or specially designated listing", /\bsdn\b|specially designated|ofac sdn|blocked persons|特別指定|特别指定/i.test(text), 12);
  addSignal("sanctions_terrorism_signal", "terrorism, ISIL, Al-Qaida, or SDGT program", /terror|terrorism|sdgt|isil|isis|daesh|al-qaida|al qaida|taliban|hamas|hezbollah|恐怖/i.test(text), 18);
  addSignal("sanctions_cyber_ransomware_signal", "cyber, ransomware, or malicious activity sanctions", /cyber|ransomware|malicious cyber|hacking|勒索|網絡|网络|駭客|黑客/i.test(text), 16);
  addSignal("sanctions_wmd_military_signal", "WMD, military, defense, or proliferation sanctions", /wmd|weapons of mass destruction|proliferation|military|defense|defence|arms|missile|nuclear|軍事|军事|武器|導彈|导弹|核/i.test(text), 16);
  addSignal("sanctions_narcotics_signal", "narcotics or trafficking sanctions", /narcotics|drug trafficking|trafficker|cartel|毒品|販毒|贩毒/i.test(text), 12);
  addSignal("sanctions_evasion_procurement_signal", "sanctions evasion, procurement, or restricted network support", /evasion|sanctions evasion|procurement|restricted procurement|support network|destabilising|destabilizing|circumvent|規避|规避|採購|采购|供應網絡|供应网络/i.test(text), 16);
  addSignal("sanctions_vessel_shipping_signal", "vessel, shipping, owner, operator, or IMO signal", /vessel|ship|shipping|imo|flag of ship|owner\/operator|maritime|船|航運|航运|船東|船东/i.test(text), 12);
  addSignal("sanctions_multijurisdiction_signal", "major sanctions jurisdiction source", /ofac|treasury|uk sanctions|fcdo|ofsi|european union|eu consolidated|un security council|un list|美國|美国|英國|英国|歐盟|欧盟|聯合國|联合国/i.test(text), 8);

  const evidenceTerms = termMatches([
    "ofac sdn list",
    "ofac consolidated",
    "uk sanctions list",
    "eu consolidated financial sanctions list",
    "un security council consolidated list",
    "sanctions entity id",
    "reference number",
    "un reference",
    "ofsi group id",
    "logicalid",
    "dataid",
    "interpol link",
    "imo number",
    "regulation",
    "designation source",
    "public sanctions",
    "watchlist",
    "制裁名單",
    "制裁名单",
    "參考編號",
    "参考编号",
  ]);
  const jurisdictionTerms = termMatches([
    "ofac",
    "u.s. treasury",
    "treasury",
    "uk sanctions",
    "fcdo",
    "ofsi",
    "european union",
    "eu consolidated",
    "council regulation",
    "un security council",
    "un list",
    "united nations",
    "美國",
    "美国",
    "英國",
    "英国",
    "歐盟",
    "欧盟",
    "聯合國",
    "联合国",
  ]);
  const measureTerms = termMatches([
    "asset freeze",
    "funds freeze",
    "freezing of funds",
    "economic resources",
    "blocked",
    "blocking",
    "travel ban",
    "trust services",
    "financial sanctions",
    "sanctions imposed",
    "凍結資產",
    "冻结资产",
    "資金凍結",
    "资金冻结",
    "旅行禁令",
  ]);
  const networkTerms = termMatches([
    "sanctions evasion",
    "procurement network",
    "restricted procurement",
    "support network",
    "destabilising",
    "destabilizing",
    "circumvent",
    "vessel owner",
    "owner/operator",
    "shipping",
    "facilitator",
    "procurement",
    "供應網絡",
    "供应网络",
    "規避",
    "规避",
    "採購",
    "采购",
  ]);
  const timelineTerms = termMatches([
    "listed on",
    "designation date",
    "date designated",
    "last updated",
    "report date",
    "generationdate",
    "pending",
    "imposed",
    "designated",
    "列名",
    "指定日期",
    "更新",
  ]);

  addSignal("sanctions_evidence_language_signal", "sanctions record contains list, ID, reference, regulation, or notice evidence", evidenceTerms.length > 0, 10);
  addSignal("sanctions_jurisdiction_language_signal", "sanctions record identifies issuing jurisdiction or authority", jurisdictionTerms.length > 0, 8);
  addSignal("sanctions_measure_language_signal", "sanctions record identifies freeze, blocking, travel-ban, or service-restriction measures", measureTerms.length > 0, 10);
  addSignal("sanctions_network_role_signal", "sanctions record describes evasion, procurement, vessel, facilitator, or support-network role", networkTerms.length > 0, 10);
  addSignal("sanctions_timeline_language_signal", "sanctions record includes listed, designation, update, imposed, or pending timeline language", timelineTerms.length > 0, 6);

  const semanticSignalCount = [
    out.sanctions_watchlist_signal,
    out.sanctions_blocking_freeze_signal,
    out.sanctions_sdn_signal,
    out.sanctions_terrorism_signal,
    out.sanctions_cyber_ransomware_signal,
    out.sanctions_wmd_military_signal,
    out.sanctions_narcotics_signal,
    out.sanctions_evasion_procurement_signal,
    out.sanctions_vessel_shipping_signal,
    out.sanctions_multijurisdiction_signal,
    out.sanctions_evidence_language_signal,
    out.sanctions_jurisdiction_language_signal,
    out.sanctions_measure_language_signal,
    out.sanctions_network_role_signal,
    out.sanctions_timeline_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "sanctions_complete_compliance_narrative_signal",
    "complete sanctions narrative with public list evidence, issuing authority, measures, network or program risk, and timeline or reference context",
    semanticSignalCount >= 7
      && out.sanctions_watchlist_signal
      && out.sanctions_evidence_language_signal
      && out.sanctions_jurisdiction_language_signal
      && out.sanctions_measure_language_signal
      && (
        out.sanctions_sdn_signal
        || out.sanctions_terrorism_signal
        || out.sanctions_cyber_ransomware_signal
        || out.sanctions_wmd_military_signal
        || out.sanctions_narcotics_signal
        || out.sanctions_evasion_procurement_signal
        || out.sanctions_network_role_signal
      )
      && (out.sanctions_timeline_language_signal || out.sanctions_multijurisdiction_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    sanctions_risk_score: boundedScore,
    sanctions_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    sanctions_signal_count: signalFields.length,
    sanctions_semantic_signal_count: semanticSignalCount,
    sanctions_evidence_terms: evidenceTerms,
    sanctions_jurisdiction_terms: jurisdictionTerms,
    sanctions_measure_terms: measureTerms,
    sanctions_network_terms: networkTerms,
    sanctions_timeline_terms: timelineTerms,
    sanctions_signal_reasons: [...new Set(reasons)].slice(0, 12),
  };
}

function normalizeOfacRow(row = [], target = {}) {
  const [
    uid,
    name,
    type,
    programs,
    title,
    callSign,
    vesselType,
    tonnage,
    grt,
    vesselFlag,
    vesselOwner,
    remarks,
  ] = row;
  const entityName = cleanText(name, 260);
  if (!entityName || /^sdn_name$/i.test(entityName) || /^name$/i.test(entityName)) return null;
  const listType = cleanText(target.listType || "", 80);
  const sourceName = cleanText(target.name || "OFAC sanctions list", 160);
  const sourceKey = cleanText(target.key || "", 80);
  const entityId = cleanText(uid, 80);
  const entityType = cleanText(type, 80);
  const programText = cleanText(programs, 300);
  const remarksText = cleanText(remarks, 600);
  return {
    entityId,
    entityName,
    entityType,
    programs: programText,
    title: cleanText(title, 200),
    callSign: cleanText(callSign, 120),
    vesselType: cleanText(vesselType, 120),
    tonnage: cleanText(tonnage, 80),
    grt: cleanText(grt, 80),
    vesselFlag: cleanText(vesselFlag, 120),
    vesselOwner: cleanText(vesselOwner, 220),
    remarks: remarksText,
    listType,
    sourceName,
    sourceKey,
    sourceUrl: target.url || "",
  };
}

export function parseOfacCsvResults(csvText = "", keyword = "", { target = DEFAULT_SANCTIONS_TARGETS[0], limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  const publishedAt = normalizeDate(target.publishedAt || target.updatedAt || "") || new Date().toISOString();
  if (!isAfterSince(publishedAt, since)) return out;
  for (const row of csvRows(csvText)) {
    const item = normalizeOfacRow(row, target);
    if (!item) continue;
    const searchable = [
      item.entityId,
      item.entityName,
      item.entityType,
      item.programs,
      item.title,
      item.remarks,
      item.vesselFlag,
      item.vesselOwner,
      item.sourceName,
    ].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const dedupeKey = `${item.sourceKey}:${item.entityId || item.entityName}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const url = item.sourceUrl || "https://sanctionslist.ofac.treas.gov/";
    const title = `${item.sourceName}: ${item.entityName}`;
    const content = [
      `${item.entityName} appears on ${item.sourceName}.`,
      item.entityType ? `Type: ${item.entityType}.` : "",
      item.programs ? `Programs: ${item.programs}.` : "",
      item.remarks ? `Remarks: ${item.remarks}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url,
      title,
      content,
      author: "U.S. Treasury OFAC",
      publishedAt,
      riskLevel: sanctionsRiskLevel({ listType: item.listType, remarks: item.remarks, programs: item.programs }),
      metrics: {
        source: item.sourceKey || "ofac_sanctions_csv",
        source_family: "compliance",
        source_kind: "public_sanctions_watchlist",
        collection_mode: "ofac_public_csv",
        sanctions_record_source: item.sourceName,
        sanctions_list_type: item.listType,
        sanctions_entity_id: item.entityId,
        sanctions_entity_name: item.entityName,
        sanctions_entity_type: item.entityType,
        sanctions_programs: item.programs,
        sanctions_title: item.title,
        sanctions_remarks: item.remarks,
        vessel_flag: item.vesselFlag,
        vessel_owner: item.vesselOwner,
        source_weight_tier: "public-sanctions-watchlist",
      },
    });
    if (out.length >= Math.max(1, Math.min(50, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function reportDateFromUkCsv(csvText = "") {
  const firstLine = String(csvText || "").split(/\r?\n/, 1)[0] || "";
  const value = cleanText(firstLine.replace(/^Report Date:\s*/i, ""), 80);
  return normalizeDate(value);
}

function headerIndexMap(header = []) {
  const out = new Map();
  header.forEach((name, index) => out.set(cleanText(name, 120).toLowerCase(), index));
  return out;
}

function csvField(row = [], headerMap = new Map(), name = "", max = 1200) {
  const index = headerMap.get(String(name || "").toLowerCase());
  return index == null ? "" : cleanText(row[index], max);
}

function joinFields(values = [], separator = " ") {
  return [...new Set(values.map(value => cleanText(value, 260)).filter(Boolean))].join(separator);
}

function normalizeUkSanctionsRow(row = [], headerMap = new Map(), target = {}, publishedAt = "") {
  const uniqueId = csvField(row, headerMap, "Unique ID", 80);
  const ofsiGroupId = csvField(row, headerMap, "OFSI Group ID", 80);
  const unReference = csvField(row, headerMap, "UN Reference Number", 120);
  const names = joinFields([
    csvField(row, headerMap, "Name 6", 160),
    csvField(row, headerMap, "Name 1", 160),
    csvField(row, headerMap, "Name 2", 160),
    csvField(row, headerMap, "Name 3", 160),
    csvField(row, headerMap, "Name 4", 160),
    csvField(row, headerMap, "Name 5", 160),
  ]);
  if (!names || /^name 6$/i.test(names)) return null;
  const regime = csvField(row, headerMap, "Regime Name", 260);
  const designationType = csvField(row, headerMap, "Designation Type", 120);
  const designationSource = csvField(row, headerMap, "Designation source", 120);
  const sanctionsImposed = csvField(row, headerMap, "Sanctions Imposed", 420);
  const otherInformation = csvField(row, headerMap, "Other Information", 900);
  const reason = csvField(row, headerMap, "UK Statement of Reasons", 1200);
  const addressCountry = csvField(row, headerMap, "Address Country", 180);
  const nationality = csvField(row, headerMap, "Nationality(/ies)", 220);
  const position = csvField(row, headerMap, "Position", 220);
  const typeOfEntity = csvField(row, headerMap, "Type of entity", 180);
  const imoNumber = csvField(row, headerMap, "IMO number", 120);
  const currentOwner = csvField(row, headerMap, "Current owner/operator (s)", 240);
  const currentFlag = csvField(row, headerMap, "Current believed flag of ship", 160);
  return {
    entityId: uniqueId || ofsiGroupId || unReference,
    entityName: names,
    entityType: typeOfEntity || designationType,
    programs: regime,
    title: csvField(row, headerMap, "Title", 180),
    remarks: joinFields([sanctionsImposed, otherInformation, reason], " | "),
    listType: target.listType || "uk-sanctions-list",
    sourceName: target.name || "UK Sanctions List",
    sourceKey: target.key || "uk_sanctions_list",
    sourceUrl: target.url || UK_SANCTIONS_LIST_CSV_URL,
    ofsiGroupId,
    unReference,
    designationType,
    designationSource,
    sanctionsImposed,
    addressCountry,
    nationality,
    position,
    imoNumber,
    vesselOwner: currentOwner,
    vesselFlag: currentFlag,
    publishedAt,
  };
}

export function parseUkSanctionsCsvResults(csvText = "", keyword = "", { target = DEFAULT_SANCTIONS_TARGETS[2], limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = csvRows(csvText);
  const headerIndex = rows.findIndex(row => row.some(cell => /^unique id$/i.test(cleanText(cell, 40))));
  if (headerIndex < 0) return [];
  const headerMap = headerIndexMap(rows[headerIndex]);
  const publishedAt = normalizeDate(target.publishedAt || target.updatedAt || "") || reportDateFromUkCsv(csvText) || new Date().toISOString();
  if (!isAfterSince(publishedAt, since)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows.slice(headerIndex + 1)) {
    const item = normalizeUkSanctionsRow(row, headerMap, target, publishedAt);
    if (!item) continue;
    const searchable = [
      item.entityId,
      item.entityName,
      item.entityType,
      item.programs,
      item.title,
      item.remarks,
      item.ofsiGroupId,
      item.unReference,
      item.designationSource,
      item.sanctionsImposed,
      item.addressCountry,
      item.nationality,
      item.position,
      item.imoNumber,
      item.vesselFlag,
      item.vesselOwner,
      item.sourceName,
    ].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const dedupeKey = `${item.sourceKey}:${item.entityId || item.entityName}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const content = [
      `${item.entityName} appears on ${item.sourceName}.`,
      item.entityType ? `Type: ${item.entityType}.` : "",
      item.programs ? `Regime: ${item.programs}.` : "",
      item.sanctionsImposed ? `Sanctions imposed: ${item.sanctionsImposed}.` : "",
      item.remarks ? `Details: ${item.remarks}.` : "",
      item.addressCountry ? `Address country: ${item.addressCountry}.` : "",
      item.nationality ? `Nationality: ${item.nationality}.` : "",
      item.imoNumber ? `IMO number: ${item.imoNumber}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url: item.sourceUrl,
      title: `${item.sourceName}: ${item.entityName}`,
      content,
      author: "UK Foreign, Commonwealth & Development Office",
      publishedAt,
      riskLevel: sanctionsRiskLevel({ listType: item.listType, remarks: item.remarks, programs: item.programs }),
      metrics: {
        source: item.sourceKey,
        source_family: "compliance",
        source_kind: "public_sanctions_watchlist",
        collection_mode: "uk_sanctions_public_csv",
        sanctions_record_source: item.sourceName,
        sanctions_list_type: item.listType,
        sanctions_entity_id: item.entityId,
        sanctions_entity_name: item.entityName,
        sanctions_entity_type: item.entityType,
        sanctions_programs: item.programs,
        sanctions_title: item.title,
        sanctions_remarks: item.remarks,
        sanctions_ofsi_group_id: item.ofsiGroupId,
        sanctions_un_reference: item.unReference,
        sanctions_designation_source: item.designationSource,
        sanctions_imposed: item.sanctionsImposed,
        sanctions_address_country: item.addressCountry,
        sanctions_nationality: item.nationality,
        vessel_flag: item.vesselFlag,
        vessel_owner: item.vesselOwner,
        source_weight_tier: "public-sanctions-watchlist",
      },
    });
    if (out.length >= Math.max(1, Math.min(50, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function xmlBlocks(xmlText = "", tagName = "") {
  const blocks = [];
  const re = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi");
  let match;
  while ((match = re.exec(String(xmlText || "")))) blocks.push(match[0]);
  return blocks;
}

function xmlAttribute(xmlText = "", name = "", max = 1200) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = String(xmlText || "").match(re);
  return cleanText(match?.[1] || match?.[2] || "", max);
}

function xmlTagAttributeValues(xmlText = "", tagName = "", attrName = "", max = 260) {
  const out = [];
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  let match;
  while ((match = tagRe.exec(String(xmlText || "")))) {
    const value = xmlAttribute(match[0], attrName, max);
    if (value) out.push(value);
  }
  return [...new Set(out)];
}

function xmlTagTextValues(xmlText = "", tagName = "", max = 260) {
  const out = [];
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match;
  while ((match = tagRe.exec(String(xmlText || "")))) {
    const value = cleanText(match[1], max);
    if (value) out.push(value);
  }
  return [...new Set(out)];
}

function euSanctionsPublishedAt(xmlText = "", target = {}) {
  const targetDate = normalizeDate(target.publishedAt || target.updatedAt || "");
  if (targetDate) return targetDate;
  const candidate = xmlAttribute(xmlText.slice(0, 4000), "generationDate", 80)
    || xmlAttribute(xmlText.slice(0, 4000), "exportDate", 80)
    || xmlAttribute(xmlText.slice(0, 4000), "lastUpdated", 80);
  return normalizeDate(candidate) || new Date().toISOString();
}

function normalizeEuSanctionsEntity(block = "", target = {}, publishedAt = "") {
  const entityId = xmlAttribute(block, "logicalId", 80)
    || xmlAttribute(block, "euReferenceNumber", 120)
    || xmlAttribute(block, "unitedNationId", 120);
  const aliases = joinFields([
    ...xmlTagAttributeValues(block, "nameAlias", "wholeName", 260),
    ...xmlTagTextValues(block, "wholeName", 260),
    ...xmlTagTextValues(block, "nameAlias", 260),
  ]);
  const entityName = aliases || entityId;
  if (!entityName) return null;
  const entityType = xmlAttribute(block, "subjectType", 120)
    || joinFields(xmlTagAttributeValues(block, "subjectType", "code", 120))
    || joinFields(xmlTagAttributeValues(block, "subjectType", "classificationCode", 120));
  const programs = joinFields([
    ...xmlTagAttributeValues(block, "programme", "name", 260),
    ...xmlTagAttributeValues(block, "programme", "code", 120),
    ...xmlTagTextValues(block, "programme", 260),
  ], " | ");
  const regulations = joinFields([
    ...xmlTagAttributeValues(block, "regulation", "numberTitle", 300),
    ...xmlTagAttributeValues(block, "regulation", "programme", 180),
    ...xmlTagTextValues(block, "regulation", 300),
  ], " | ");
  const measures = joinFields([
    ...xmlTagAttributeValues(block, "sanctionMeasure", "measure", 220),
    ...xmlTagAttributeValues(block, "sanctionMeasure", "code", 120),
    ...xmlTagTextValues(block, "sanctionMeasure", 220),
  ], " | ");
  const remarks = joinFields([
    ...xmlTagTextValues(block, "remark", 900),
    ...xmlTagTextValues(block, "remarkText", 900),
    ...xmlTagAttributeValues(block, "remark", "text", 900),
  ], " | ");
  const nationality = joinFields([
    ...xmlTagAttributeValues(block, "citizenship", "countryDescription", 180),
    ...xmlTagAttributeValues(block, "citizenship", "countryIso2Code", 80),
  ], " | ");
  const addressCountry = joinFields([
    ...xmlTagAttributeValues(block, "address", "countryDescription", 180),
    ...xmlTagAttributeValues(block, "address", "countryIso2Code", 80),
  ], " | ");
  const birthDate = joinFields([
    ...xmlTagAttributeValues(block, "birthdate", "birthdate", 120),
    ...xmlTagAttributeValues(block, "birthdate", "year", 80),
  ], " | ");
  return {
    entityId,
    entityName,
    entityType,
    programs,
    remarks: joinFields([remarks, regulations, measures], " | "),
    listType: target.listType || "eu-consolidated-financial-sanctions",
    sourceName: target.name || "EU Consolidated Financial Sanctions List",
    sourceKey: target.key || "eu_consolidated_financial_sanctions",
    sourceUrl: target.url || EU_CONSOLIDATED_FINANCIAL_SANCTIONS_XML_URL,
    regulations,
    measures,
    nationality,
    addressCountry,
    birthDate,
    designationDate: xmlAttribute(block, "designationDate", 120),
    publishedAt,
  };
}

export function parseEuSanctionsXmlResults(xmlText = "", keyword = "", { target = DEFAULT_SANCTIONS_TARGETS[3], limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const publishedAt = euSanctionsPublishedAt(xmlText, target);
  if (!isAfterSince(publishedAt, since)) return [];
  const out = [];
  const seen = new Set();
  for (const block of xmlBlocks(xmlText, "sanctionEntity")) {
    const item = normalizeEuSanctionsEntity(block, target, publishedAt);
    if (!item) continue;
    const searchable = [
      item.entityId,
      item.entityName,
      item.entityType,
      item.programs,
      item.remarks,
      item.regulations,
      item.measures,
      item.nationality,
      item.addressCountry,
      item.birthDate,
      item.sourceName,
    ].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const dedupeKey = `${item.sourceKey}:${item.entityId || item.entityName}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const content = [
      `${item.entityName} appears on ${item.sourceName}.`,
      item.entityType ? `Type: ${item.entityType}.` : "",
      item.programs ? `Programme: ${item.programs}.` : "",
      item.measures ? `Measures: ${item.measures}.` : "",
      item.regulations ? `Regulation: ${item.regulations}.` : "",
      item.remarks ? `Details: ${item.remarks}.` : "",
      item.addressCountry ? `Address country: ${item.addressCountry}.` : "",
      item.nationality ? `Nationality: ${item.nationality}.` : "",
      item.birthDate ? `Birth date: ${item.birthDate}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url: item.sourceUrl,
      title: `${item.sourceName}: ${item.entityName}`,
      content,
      author: "European Union",
      publishedAt,
      riskLevel: sanctionsRiskLevel({ listType: item.listType, remarks: item.remarks, programs: item.programs }),
      metrics: {
        source: item.sourceKey,
        source_family: "compliance",
        source_kind: "public_sanctions_watchlist",
        collection_mode: "eu_consolidated_financial_sanctions_xml",
        sanctions_record_source: item.sourceName,
        sanctions_list_type: item.listType,
        sanctions_entity_id: item.entityId,
        sanctions_entity_name: item.entityName,
        sanctions_entity_type: item.entityType,
        sanctions_programs: item.programs,
        sanctions_remarks: item.remarks,
        sanctions_regulation: item.regulations,
        sanctions_measures: item.measures,
        sanctions_address_country: item.addressCountry,
        sanctions_nationality: item.nationality,
        sanctions_birth_date: item.birthDate,
        sanctions_designation_date: item.designationDate,
        source_weight_tier: "public-sanctions-watchlist",
      },
    });
    if (out.length >= Math.max(1, Math.min(50, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function unSanctionsPublishedAt(xmlText = "", target = {}) {
  const targetDate = normalizeDate(target.publishedAt || target.updatedAt || "");
  if (targetDate) return targetDate;
  const candidate = xmlAttribute(xmlText.slice(0, 4000), "dateGenerated", 120);
  return normalizeDate(candidate) || new Date().toISOString();
}

function unSanctionsEntityBlocks(xmlText = "") {
  return [
    ...xmlBlocks(xmlText, "INDIVIDUAL").map(block => ({ block, type: "individual" })),
    ...xmlBlocks(xmlText, "ENTITY").map(block => ({ block, type: "entity" })),
  ];
}

function normalizeUnSanctionsEntity(block = "", entityType = "entity", target = {}, publishedAt = "") {
  const nameParts = [
    ...xmlTagTextValues(block, "FIRST_NAME", 180),
    ...xmlTagTextValues(block, "SECOND_NAME", 180),
    ...xmlTagTextValues(block, "THIRD_NAME", 180),
    ...xmlTagTextValues(block, "FOURTH_NAME", 180),
  ];
  const aliases = xmlTagTextValues(block, "ALIAS_NAME", 220);
  const entityName = joinFields(nameParts, " ") || aliases[0] || "";
  if (!entityName) return null;
  const programs = joinFields(xmlTagTextValues(block, "UN_LIST_TYPE", 220), " | ");
  const listTypes = joinFields(xmlTagTextValues(block, "VALUE", 220).filter(value => /^UN List$/i.test(value)), " | ");
  const remarks = joinFields([
    ...xmlTagTextValues(block, "COMMENTS1", 1200),
    ...xmlTagTextValues(block, "DESIGNATION", 500),
    ...aliases.map(alias => `Alias: ${alias}`),
  ], " | ");
  const nationality = entityType === "individual"
    ? joinFields(xmlBlocks(block, "NATIONALITY").flatMap(part => xmlTagTextValues(part, "VALUE", 180)), " | ")
    : "";
  const addressCountry = joinFields([
    ...xmlBlocks(block, "INDIVIDUAL_ADDRESS").flatMap(part => xmlTagTextValues(part, "COUNTRY", 180)),
    ...xmlBlocks(block, "ENTITY_ADDRESS").flatMap(part => xmlTagTextValues(part, "COUNTRY", 180)),
  ], " | ");
  const birthDate = joinFields(xmlBlocks(block, "INDIVIDUAL_DATE_OF_BIRTH").flatMap(part => [
    ...xmlTagTextValues(part, "DATE", 120),
    ...xmlTagTextValues(part, "YEAR", 80),
  ]), " | ");
  return {
    entityId: xmlTagTextValues(block, "DATAID", 80)[0] || xmlTagTextValues(block, "REFERENCE_NUMBER", 120)[0] || "",
    referenceNumber: xmlTagTextValues(block, "REFERENCE_NUMBER", 120)[0] || "",
    entityName,
    entityType,
    programs,
    remarks,
    listType: target.listType || "un-security-council-consolidated",
    listTypes,
    sourceName: target.name || "UN Security Council Consolidated List",
    sourceKey: target.key || "un_security_council_consolidated",
    sourceUrl: target.url || UN_SECURITY_COUNCIL_CONSOLIDATED_XML_URL,
    nationality,
    addressCountry,
    birthDate,
    listedOn: xmlTagTextValues(block, "LISTED_ON", 120)[0] || "",
    interpolLink: xmlTagTextValues(block, "INTERPOL_LINK", 500)[0] || "",
    publishedAt,
  };
}

export function parseUnSanctionsXmlResults(xmlText = "", keyword = "", { target = DEFAULT_SANCTIONS_TARGETS[4], limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const publishedAt = unSanctionsPublishedAt(xmlText, target);
  if (!isAfterSince(publishedAt, since)) return [];
  const out = [];
  const seen = new Set();
  for (const { block, type } of unSanctionsEntityBlocks(xmlText)) {
    const item = normalizeUnSanctionsEntity(block, type, target, publishedAt);
    if (!item) continue;
    const searchable = [
      item.entityId,
      item.referenceNumber,
      item.entityName,
      item.entityType,
      item.programs,
      item.remarks,
      item.nationality,
      item.addressCountry,
      item.birthDate,
      item.sourceName,
    ].join(" ");
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const dedupeKey = `${item.sourceKey}:${item.entityId || item.referenceNumber || item.entityName}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const content = [
      `${item.entityName} appears on ${item.sourceName}.`,
      item.referenceNumber ? `Reference number: ${item.referenceNumber}.` : "",
      item.entityType ? `Type: ${item.entityType}.` : "",
      item.programs ? `UN list type: ${item.programs}.` : "",
      item.listedOn ? `Listed on: ${item.listedOn}.` : "",
      item.remarks ? `Details: ${item.remarks}.` : "",
      item.addressCountry ? `Address country: ${item.addressCountry}.` : "",
      item.nationality ? `Nationality: ${item.nationality}.` : "",
      item.birthDate ? `Birth date: ${item.birthDate}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url: item.interpolLink || item.sourceUrl,
      title: `${item.sourceName}: ${item.entityName}`,
      content,
      author: "United Nations Security Council",
      publishedAt,
      riskLevel: sanctionsRiskLevel({ listType: item.listType, remarks: item.remarks, programs: item.programs }),
      metrics: {
        source: item.sourceKey,
        source_family: "compliance",
        source_kind: "public_sanctions_watchlist",
        collection_mode: "un_security_council_consolidated_xml",
        sanctions_record_source: item.sourceName,
        sanctions_list_type: item.listType,
        sanctions_entity_id: item.entityId,
        sanctions_reference_number: item.referenceNumber,
        sanctions_entity_name: item.entityName,
        sanctions_entity_type: item.entityType,
        sanctions_programs: item.programs,
        sanctions_remarks: item.remarks,
        sanctions_address_country: item.addressCountry,
        sanctions_nationality: item.nationality,
        sanctions_birth_date: item.birthDate,
        sanctions_listed_on: item.listedOn,
        sanctions_interpol_link: item.interpolLink,
        source_weight_tier: "public-sanctions-watchlist",
      },
    });
    if (out.length >= Math.max(1, Math.min(50, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertSanctionsItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = sanctionsDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "public_sanctions_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment: sentiment === "positive" ? "neutral" : sentiment,
      risk_level: item.riskLevel || "high",
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "publicSanctionsSources",
      evidence: {
        evidence_type: "public_sanctions_watchlist_entry",
        metrics: {
          ...(item.metrics || {}),
          ...sanctionsRiskSignals(item),
          ...sanctionsKeywordDiagnostics(item, keyword),
          sanctions_canonical_dedupe_key: dedupeKey,
          sanctions_search_scan_dedupe_key: dedupeKey,
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

export async function scrapePublicSanctionsSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = DEFAULT_SANCTIONS_TARGETS, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedTargets = (Array.isArray(targets) && targets.length ? targets : DEFAULT_SANCTIONS_TARGETS)
    .map(target => typeof target === "string" ? { key: target, name: target, url: target, listType: "custom" } : target)
    .filter(target => target?.url);
  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of normalizedTargets) tasks.push({ keyword, target });
  }
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      const res = await fetchPublicSource(target.url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/csv,application/xml,text/xml,text/plain,*/*",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
        return { inserted, failures };
      }
      const text = await res.text();
      const items = target.kind === "eu_sanctions_xml" || target.key === "eu_consolidated_financial_sanctions"
        ? parseEuSanctionsXmlResults(text, keyword, {
          target,
          limit: normalizedBudget.maxItemsPerKeyword,
          since,
        })
        : target.kind === "un_sanctions_xml" || target.key === "un_security_council_consolidated"
          ? parseUnSanctionsXmlResults(text, keyword, {
            target,
            limit: normalizedBudget.maxItemsPerKeyword,
            since,
          })
        : target.kind === "uk_sanctions_csv" || target.key === "uk_sanctions_list"
          ? parseUkSanctionsCsvResults(text, keyword, {
            target,
            limit: normalizedBudget.maxItemsPerKeyword,
            since,
          })
          : parseOfacCsvResults(text, keyword, {
            target,
            limit: normalizedBudget.maxItemsPerKeyword,
            since,
          });
      inserted += await insertSanctionsItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target?.key || "public-sanctions", message });
      console.warn(`[CRM/PublicSanctions] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  OFAC_SDN_CSV_URL,
  OFAC_CONSOLIDATED_CSV_URL,
  UK_SANCTIONS_LIST_CSV_URL,
  EU_CONSOLIDATED_FINANCIAL_SANCTIONS_XML_URL,
  UN_SECURITY_COUNCIL_CONSOLIDATED_XML_URL,
  DEFAULT_SANCTIONS_TARGETS,
  normalizeBudget,
  normalizeSanctionsKeywordText,
  textMatchesKeyword,
  csvRows,
  sanctionsRiskLevel,
  normalizeSanctionsEntityToken,
  sanctionsDedupeKey,
  sanctionsKeywordMatchSource,
  sanctionsKeywordDiagnostics,
  sanctionsRiskSignals,
  parseOfacCsvResults,
  parseUkSanctionsCsvResults,
  parseEuSanctionsXmlResults,
  parseUnSanctionsXmlResults,
};
