/**
 * scrapers/public-product-recall-sources.js — public product recall discovery
 *
 * Uses no-key official public recall APIs to collect high-trust product,
 * food, drug, and device safety signals.
 */

import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { promisify } from "node:util";
import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, insertSentimentItem } from "../sentiment-store.js";

const execFileAsync = promisify(execFile);
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_OPENFDA_PAGES = 3;
const DEFAULT_MAX_EU_SAFETY_GATE_PAGES = 3;
const DEFAULT_MAX_NHTSA_RECALL_PAGES = 3;
const DEFAULT_MAX_UK_FSA_FOOD_ALERT_PAGES = 4;
const DEFAULT_MAX_THAILAND_FDA_RECALL_PAGES = 3;
const DEFAULT_MAX_KOREA_FOOD_SAFETY_RECALL_PAGES = 3;
const CPSC_RECALLS_API_URL = "https://www.saferproducts.gov/RestWebServices/Recall";
const OPENFDA_FOOD_ENFORCEMENT_URL = "https://api.fda.gov/food/enforcement.json";
const OPENFDA_DRUG_ENFORCEMENT_URL = "https://api.fda.gov/drug/enforcement.json";
const OPENFDA_DEVICE_ENFORCEMENT_URL = "https://api.fda.gov/device/enforcement.json";
const OPENFDA_DRUG_EVENT_URL = "https://api.fda.gov/drug/event.json";
const OPENFDA_DEVICE_EVENT_URL = "https://api.fda.gov/device/event.json";
const OPENFDA_TOBACCO_PROBLEM_URL = "https://api.fda.gov/tobacco/problem.json";
const EU_SAFETY_GATE_RAPEX_URL = "https://public.opendatasoft.com/api/records/1.0/search/";
const NHTSA_RECALLS_BY_MANUFACTURER_URL = "https://data.transportation.gov/resource/6axg-epim.json";
const NHTSA_VEHICLE_COMPLAINTS_URL = "https://api.nhtsa.gov/complaints/complaintsByVehicle";
const FDA_IMPORT_REFUSALS_ZIP_URL = "https://www.accessdata.fda.gov/scripts/importrefusals/downloads/Import_Refusal_2024-present.zip";
const CDC_FOOD_SAFETY_RSS_URL = "https://www2c.cdc.gov/podcasts/createrss.asp?c=146";
const FDA_RECALLS_MARKET_WITHDRAWALS_URL = "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts";
const PRODUCT_SAFETY_AUSTRALIA_RECALLS_RSS_URL = "https://www.productsafety.gov.au/rss/recalls.xml";
const UK_PRODUCT_SAFETY_ALERTS_ATOM_URL = "https://www.gov.uk/product-safety-alerts-reports-recalls.atom";
const UK_FSA_FOOD_ALERTS_SEARCH_API_URL = "https://www.food.gov.uk/search-api";
const CANADA_CONSUMER_PRODUCT_RECALLS_RSS_URL = "https://recalls-rappels.canada.ca/en/feed/consumer-products-alerts-recalls";
const CANADA_HEALTH_PRODUCT_RECALLS_RSS_URL = "https://recalls-rappels.canada.ca/en/feed/health-products-alerts-recalls";
const CANADA_MEDICAL_DEVICE_RECALLS_RSS_URL = "https://recalls-rappels.canada.ca/en/feed/medical-devices-alerts-recalls";
const CANADA_FOOD_RECALLS_RSS_URL = "https://recalls-rappels.canada.ca/en/feed/cfia-alerts-recalls";
const FSSAI_ADVISORIES_URL = "https://www.fssai.gov.in/advisories.php";
const HK_CFS_FOOD_ALERTS_RSS_URL = "https://www.cfs.gov.hk/filemanager/foodalert/english/foodalert_datagovhk.xml";
const TAIWAN_FDA_DRUG_RECALLS_JSON_URL = "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=34&logType=5";
const TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_JSON_URL = "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=52&logType=5";
const NEW_ZEALAND_PRODUCT_SAFETY_RECALLS_URL = "https://www.productsafety.govt.nz/recalls";
const NEW_ZEALAND_MEDSAFE_MORD_URL = "https://www.medsafe.govt.nz/hot/recalls/RecallSearch.asp";
const FSANZ_FOOD_RECALLS_RSS_URL = "https://www.foodstandards.gov.au/food-recalls-rss.xml";
const EU_RASFF_CONSUMER_RSS_URL = "https://webgate.ec.europa.eu/rasff-window/backend/public/consumer/rss/all/en/";
const JAPAN_CAA_RECALLS_URL = "https://www.recall.caa.go.jp/result/index.php?screenkbn=03";
const KOREA_SAFETY_RECALLS_URL = "https://www.safetykorea.kr/recall/recallBoard";
const KOREA_FOOD_SAFETY_RECALLS_URL = "https://www.foodsafetykorea.go.kr/portalmobile/safeRecall.do";
const SINGAPORE_SFA_FOOD_ALERTS_RSS_URL = "https://www.sfa.gov.sg/rss/annual-listing-food-alerts";
const MALAYSIA_NPRA_PRODUCT_RECALLS_URL = "https://www.npra.gov.my/index.php/en/consumers/safety-information/product-recall.html";
const MALAYSIA_MDA_DEVICE_RECALLS_RSS_URL = "https://portal.mda.gov.my/index.php/recall?format=feed&type=rss";
const THAILAND_FDA_PRODUCT_RECALLS_RSS_URL = "https://safetyalert.fda.moph.go.th/rss/?content=product-recall&sort=date_manage&ord=desc&p=1&ppp=10";
const OPENFDA_TARGETS = [
  { key: "openfda_food", name: "openFDA Food Enforcement", url: OPENFDA_FOOD_ENFORCEMENT_URL, category: "food" },
  { key: "openfda_drug", name: "openFDA Drug Enforcement", url: OPENFDA_DRUG_ENFORCEMENT_URL, category: "drug" },
  { key: "openfda_device", name: "openFDA Device Enforcement", url: OPENFDA_DEVICE_ENFORCEMENT_URL, category: "device" },
];
const OPENFDA_ADVERSE_EVENT_TARGETS = [
  { key: "openfda_drug_adverse_events", name: "openFDA Drug Adverse Events", url: OPENFDA_DRUG_EVENT_URL, category: "drug_adverse_event", kind: "openfda_drug_adverse_events" },
  { key: "openfda_device_adverse_events", name: "openFDA Device Adverse Events", url: OPENFDA_DEVICE_EVENT_URL, category: "device_adverse_event", kind: "openfda_device_adverse_events" },
  { key: "openfda_tobacco_problem_reports", name: "openFDA Tobacco Problem Reports", url: OPENFDA_TOBACCO_PROBLEM_URL, category: "tobacco_problem_report", kind: "openfda_tobacco_problem_reports" },
];
const EU_SAFETY_GATE_TARGET = { key: "eu_safety_gate_rapex", name: "EU Safety Gate RAPEX", url: EU_SAFETY_GATE_RAPEX_URL, category: "non_food_product", kind: "eu_safety_gate_rapex" };
const NHTSA_RECALLS_TARGET = { key: "nhtsa_recalls_by_manufacturer", name: "NHTSA Recalls by Manufacturer", url: NHTSA_RECALLS_BY_MANUFACTURER_URL, category: "vehicle", kind: "nhtsa_recalls_by_manufacturer" };
const NHTSA_VEHICLE_COMPLAINTS_TARGET = { key: "nhtsa_vehicle_complaints", name: "NHTSA Vehicle Complaints", url: NHTSA_VEHICLE_COMPLAINTS_URL, category: "vehicle_complaint", kind: "nhtsa_vehicle_complaints" };
const FDA_IMPORT_REFUSALS_TARGET = { key: "fda_import_refusals", name: "FDA Import Refusals", url: FDA_IMPORT_REFUSALS_ZIP_URL, category: "import_refusal", kind: "fda_import_refusals_zip" };
const CDC_FOOD_SAFETY_TARGET = { key: "cdc_food_safety_rss", name: "CDC Food Safety Alerts", url: CDC_FOOD_SAFETY_RSS_URL, category: "food_safety", kind: "cdc_food_safety_rss" };
const FDA_RECALLS_MARKET_WITHDRAWALS_TARGET = { key: "fda_recalls_market_withdrawals", name: "FDA Recalls, Market Withdrawals & Safety Alerts", url: FDA_RECALLS_MARKET_WITHDRAWALS_URL, category: "fda_recall_alert", kind: "fda_recalls_market_withdrawals_html" };
const PRODUCT_SAFETY_AUSTRALIA_TARGET = { key: "product_safety_australia_recalls", name: "Product Safety Australia Recalls", url: PRODUCT_SAFETY_AUSTRALIA_RECALLS_RSS_URL, category: "consumer_product", kind: "product_safety_australia_rss" };
const UK_PRODUCT_SAFETY_TARGET = { key: "uk_product_safety_alerts", name: "UK Product Safety Alerts, Reports and Recalls", url: UK_PRODUCT_SAFETY_ALERTS_ATOM_URL, category: "consumer_product", kind: "uk_product_safety_atom" };
const UK_FSA_FOOD_ALERTS_TARGET = { key: "uk_fsa_food_alerts", name: "UK FSA Food Alerts and Allergy Alerts", url: UK_FSA_FOOD_ALERTS_SEARCH_API_URL, category: "food_safety", kind: "uk_fsa_food_alerts_search_api" };
const CANADA_CONSUMER_PRODUCT_RECALLS_TARGET = { key: "canada_consumer_product_recalls", name: "Canada Consumer Product Recalls", url: CANADA_CONSUMER_PRODUCT_RECALLS_RSS_URL, category: "consumer_product", kind: "canada_recalls_rss", label: "consumer product" };
const CANADA_HEALTH_PRODUCT_RECALLS_TARGET = { key: "canada_health_product_recalls", name: "Canada Health Product Recalls", url: CANADA_HEALTH_PRODUCT_RECALLS_RSS_URL, category: "health_product", kind: "canada_recalls_rss", label: "health product" };
const CANADA_MEDICAL_DEVICE_RECALLS_TARGET = { key: "canada_medical_device_recalls", name: "Canada Medical Device Recalls", url: CANADA_MEDICAL_DEVICE_RECALLS_RSS_URL, category: "medical_device", kind: "canada_recalls_rss", label: "medical device" };
const CANADA_FOOD_RECALLS_TARGET = { key: "canada_food_recalls", name: "Canada Food Recalls", url: CANADA_FOOD_RECALLS_RSS_URL, category: "food_safety", kind: "canada_recalls_rss", label: "food" };
const FSSAI_ADVISORIES_TARGET = { key: "fssai_food_safety_advisories", name: "FSSAI Food Safety Advisories", url: FSSAI_ADVISORIES_URL, category: "food_safety", kind: "fssai_food_safety_advisories_html" };
const HK_CFS_FOOD_ALERTS_TARGET = { key: "hk_cfs_food_alerts", name: "Hong Kong CFS Food Alert / Allergy Alerts", url: HK_CFS_FOOD_ALERTS_RSS_URL, category: "food_safety", kind: "hk_cfs_food_alerts_rss" };
const TAIWAN_FDA_DRUG_RECALLS_TARGET = { key: "taiwan_fda_drug_recalls", name: "Taiwan FDA Drug Recalls", url: TAIWAN_FDA_DRUG_RECALLS_JSON_URL, category: "drug", kind: "taiwan_fda_drug_recalls_json" };
const TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_TARGET = { key: "taiwan_fda_noncompliant_food_imports", name: "Taiwan FDA Non-compliant Food Imports", url: TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_JSON_URL, category: "food_safety", kind: "taiwan_fda_noncompliant_food_imports_json" };
const NEW_ZEALAND_PRODUCT_SAFETY_RECALLS_TARGET = { key: "new_zealand_product_safety_recalls", name: "New Zealand Product Safety Recalls", url: NEW_ZEALAND_PRODUCT_SAFETY_RECALLS_URL, category: "consumer_product", kind: "new_zealand_product_safety_recalls_html" };
const NEW_ZEALAND_MEDSAFE_MORD_TARGET = { key: "new_zealand_medsafe_mord", name: "New Zealand Medsafe Online Recalls Database", url: NEW_ZEALAND_MEDSAFE_MORD_URL, category: "health_product", kind: "new_zealand_medsafe_mord_html" };
const FSANZ_FOOD_RECALLS_TARGET = { key: "fsanz_food_recalls", name: "FSANZ Food Recalls", url: FSANZ_FOOD_RECALLS_RSS_URL, category: "food_safety", kind: "fsanz_food_recalls_rss" };
const EU_RASFF_CONSUMER_TARGET = { key: "eu_rasff_consumer_notifications", name: "EU RASFF Consumer Notifications", url: EU_RASFF_CONSUMER_RSS_URL, category: "food_safety", kind: "eu_rasff_consumer_rss" };
const JAPAN_CAA_RECALLS_TARGET = { key: "japan_caa_recalls", name: "Japan CAA Recall Information", url: JAPAN_CAA_RECALLS_URL, category: "consumer_product", kind: "japan_caa_recalls_html" };
const KOREA_SAFETY_RECALLS_TARGET = { key: "korea_safety_recalls", name: "Korea SafetyKorea Product Recalls", url: KOREA_SAFETY_RECALLS_URL, category: "consumer_product", kind: "korea_safety_recalls_html" };
const KOREA_FOOD_SAFETY_RECALLS_TARGET = { key: "korea_food_safety_recalls", name: "Korea Food Safety Recall/Sale Suspension", url: KOREA_FOOD_SAFETY_RECALLS_URL, category: "food_safety", kind: "korea_food_safety_recalls_json" };
const SINGAPORE_SFA_FOOD_ALERTS_TARGET = { key: "singapore_sfa_food_alerts", name: "Singapore SFA Food Alerts and Recalls", url: SINGAPORE_SFA_FOOD_ALERTS_RSS_URL, category: "food_safety", kind: "singapore_sfa_food_alerts_rss" };
const MALAYSIA_NPRA_PRODUCT_RECALLS_TARGET = { key: "malaysia_npra_product_recalls", name: "Malaysia NPRA Product Recalls", url: MALAYSIA_NPRA_PRODUCT_RECALLS_URL, category: "health_product", kind: "malaysia_npra_product_recalls_html" };
const MALAYSIA_MDA_DEVICE_RECALLS_TARGET = { key: "malaysia_mda_device_recalls", name: "Malaysia MDA Medical Device Recalls", url: MALAYSIA_MDA_DEVICE_RECALLS_RSS_URL, category: "medical_device", kind: "malaysia_mda_device_recalls_rss" };
const THAILAND_FDA_PRODUCT_RECALLS_TARGET = { key: "thailand_fda_product_recalls", name: "Thailand FDA Safety Alert Product Recalls", url: THAILAND_FDA_PRODUCT_RECALLS_RSS_URL, category: "health_product", kind: "thailand_fda_product_recalls_rss" };
const DEFAULT_PRODUCT_RECALL_TARGETS = [...OPENFDA_TARGETS, ...OPENFDA_ADVERSE_EVENT_TARGETS, EU_SAFETY_GATE_TARGET, NHTSA_RECALLS_TARGET, NHTSA_VEHICLE_COMPLAINTS_TARGET, FDA_IMPORT_REFUSALS_TARGET, CDC_FOOD_SAFETY_TARGET, FDA_RECALLS_MARKET_WITHDRAWALS_TARGET, PRODUCT_SAFETY_AUSTRALIA_TARGET, UK_PRODUCT_SAFETY_TARGET, UK_FSA_FOOD_ALERTS_TARGET, CANADA_CONSUMER_PRODUCT_RECALLS_TARGET, CANADA_HEALTH_PRODUCT_RECALLS_TARGET, CANADA_MEDICAL_DEVICE_RECALLS_TARGET, CANADA_FOOD_RECALLS_TARGET, FSSAI_ADVISORIES_TARGET, HK_CFS_FOOD_ALERTS_TARGET, TAIWAN_FDA_DRUG_RECALLS_TARGET, TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_TARGET, NEW_ZEALAND_PRODUCT_SAFETY_RECALLS_TARGET, NEW_ZEALAND_MEDSAFE_MORD_TARGET, FSANZ_FOOD_RECALLS_TARGET, EU_RASFF_CONSUMER_TARGET, JAPAN_CAA_RECALLS_TARGET, KOREA_SAFETY_RECALLS_TARGET, KOREA_FOOD_SAFETY_RECALLS_TARGET, SINGAPORE_SFA_FOOD_ALERTS_TARGET, MALAYSIA_NPRA_PRODUCT_RECALLS_TARGET, MALAYSIA_MDA_DEVICE_RECALLS_TARGET, THAILAND_FDA_PRODUCT_RECALLS_TARGET];
const fdaImportRefusalArchiveCache = new Map();

function clearFdaImportRefusalArchiveCache() {
  fdaImportRefusalArchiveCache.clear();
}

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
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

function normalizeOpenFdaPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxOpenFdaPagesPerKeyword || budget.max_openfda_pages_per_keyword || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_OPENFDA_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_OPENFDA_PAGES;
}

function normalizeEuSafetyGatePageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxEuSafetyGatePagesPerKeyword || budget.max_eu_safety_gate_pages_per_keyword || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_EU_SAFETY_GATE_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_EU_SAFETY_GATE_PAGES;
}

function normalizeNhtsaRecallPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxNhtsaRecallPagesPerKeyword || budget.max_nhtsa_recall_pages_per_keyword || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_NHTSA_RECALL_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_NHTSA_RECALL_PAGES;
}

function normalizeUkFsaFoodAlertPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxUkFsaFoodAlertPagesPerKeyword || budget.max_uk_fsa_food_alert_pages_per_keyword || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_UK_FSA_FOOD_ALERT_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(4, maxPages)) : DEFAULT_MAX_UK_FSA_FOOD_ALERT_PAGES;
}

function normalizeThailandFdaProductRecallPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxThailandFdaProductRecallPagesPerKeyword || budget.max_thailand_fda_product_recall_pages_per_keyword || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_THAILAND_FDA_RECALL_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_THAILAND_FDA_RECALL_PAGES;
}

function normalizeKoreaFoodSafetyRecallPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxKoreaFoodSafetyRecallPagesPerKeyword || budget.max_korea_food_safety_recall_pages_per_keyword || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_KOREA_FOOD_SAFETY_RECALL_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_KOREA_FOOD_SAFETY_RECALL_PAGES;
}

function normalizeDate(value = "") {
  const raw = String(value || "").trim();
  if (/^\d{8}$/.test(raw)) {
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`;
    const time = new Date(formatted).getTime();
    return Number.isNaN(time) ? "" : new Date(time).toISOString();
  }
  const time = new Date(raw || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeDmyDate(value = "") {
  const raw = cleanText(value, 80);
  const match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return normalizeDate(raw);
  const formatted = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}T00:00:00.000Z`;
  const time = new Date(formatted).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeMdyDate(value = "") {
  const raw = cleanText(value, 80);
  const match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return normalizeDate(raw);
  const formatted = `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}T00:00:00.000Z`;
  const time = new Date(formatted).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeYmdSlashDate(value = "") {
  const raw = cleanText(value, 80);
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return normalizeDate(raw);
  const formatted = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T00:00:00.000Z`;
  const time = new Date(formatted).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeEnglishMonthDate(value = "") {
  const raw = cleanText(value, 100);
  const match = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return normalizeDate(raw);
  const months = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  const month = months[match[2].toLowerCase()];
  if (!month) return normalizeDate(raw);
  const formatted = `${match[3]}-${month}-${match[1].padStart(2, "0")}T00:00:00.000Z`;
  const time = new Date(formatted).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function isCanadaRecallTarget(target = {}) {
  return target.kind === "canada_recalls_rss"
    || target.kind === "canada_consumer_product_recalls_rss"
    || /^canada_(?:consumer_product|health_product|medical_device|food)_recalls$/.test(String(target.key || ""));
}

function absoluteFssaiUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.fssai.gov.in/${value.replace(/^\/+/, "")}`;
}

async function fetchTextWithCurlFallback(url = "", { accept = "application/rss+xml,application/xml,text/xml,text/html,*/*", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const safeUrl = String(url || "").trim();
  if (!/^https:\/\//i.test(safeUrl)) throw new Error("curl fallback only supports HTTPS public sources");
  const maxSeconds = String(Math.max(1, Math.ceil(Number(timeoutMs || REQUEST_TIMEOUT_MS) / 1000)));
  const { stdout } = await execFileAsync("curl", [
    "-fsSL",
    "--max-time", maxSeconds,
    "-H", `User-Agent: ${BROWSER_USER_AGENT}`,
    "-H", `Accept: ${accept}`,
    safeUrl,
  ], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: Number(timeoutMs || REQUEST_TIMEOUT_MS) + 2000,
  });
  return String(stdout || "");
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeProductRecallKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeProductRecallKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeProductRecallKeywordText(text);
  return keywordNeedles(keyword).some(needle => {
    const normalizedNeedle = normalizeProductRecallKeywordText(needle);
    if (needle.length < 2) return false;
    return lower.includes(needle) || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle));
  });
}

function cpscRecallSearchUrl(keyword = "") {
  const params = new URLSearchParams({
    format: "json",
    RecallTitle: cleanText(keyword, 120),
  });
  return `${CPSC_RECALLS_API_URL}?${params.toString()}`;
}

function openFdaSearchUrl(target = OPENFDA_TARGETS[0], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, skip = 0 } = {}) {
  const term = cleanText(keyword, 120).replace(/"/g, "\\\"");
  const search = [
    `recalling_firm:"${term}"`,
    `product_description:"${term}"`,
    `reason_for_recall:"${term}"`,
    `code_info:"${term}"`,
  ].join("+OR+");
  const params = new URLSearchParams({
    search,
    limit: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  const normalizedSkip = Math.max(0, Number(skip) || 0);
  if (normalizedSkip > 0) params.set("skip", String(normalizedSkip));
  return `${target.url}?${params.toString()}`;
}

function openFdaAdverseEventSearchUrl(target = OPENFDA_ADVERSE_EVENT_TARGETS[0], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, skip = 0 } = {}) {
  const term = cleanText(keyword, 120).replace(/"/g, "\\\"");
  const isTobacco = target.kind === "openfda_tobacco_problem_reports" || target.key === "openfda_tobacco_problem_reports";
  const normalizedSkip = Math.max(0, Number(skip) || 0);
  if (isTobacco) {
    const tobaccoSearch = [
      `tobacco_products:"${term}"`,
      `reported_health_problems:"${term}"`,
      `reported_product_problems:"${term}"`,
      `report_id:"${term}"`,
    ].join("+OR+");
    const params = new URLSearchParams({
      search: tobaccoSearch,
      limit: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    });
    if (normalizedSkip > 0) params.set("skip", String(normalizedSkip));
    return `${target.url}?${params.toString()}`;
  }
  const drugSearch = [
    `patient.drug.openfda.brand_name:"${term}"`,
    `patient.drug.openfda.generic_name:"${term}"`,
    `patient.drug.openfda.manufacturer_name:"${term}"`,
    `patient.drug.medicinalproduct:"${term}"`,
    `companynumb:"${term}"`,
  ].join("+OR+");
  const deviceSearch = [
    `device.brand_name:"${term}"`,
    `device.generic_name:"${term}"`,
    `device.manufacturer_d_name:"${term}"`,
    `device.openfda.device_name:"${term}"`,
    `manufacturer_g1_name:"${term}"`,
    `report_number:"${term}"`,
  ].join("+OR+");
  const params = new URLSearchParams({
    search: target.kind === "openfda_device_adverse_events" || target.key === "openfda_device_adverse_events" ? deviceSearch : drugSearch,
    limit: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  if (normalizedSkip > 0) params.set("skip", String(normalizedSkip));
  return `${target.url}?${params.toString()}`;
}

function euSafetyGateSearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, start = 0 } = {}) {
  const params = new URLSearchParams({
    dataset: "healthref-europe-rapex-en",
    q: cleanText(keyword, 120),
    rows: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    sort: "alert_date",
  });
  const normalizedStart = Math.max(0, Number(start) || 0);
  if (normalizedStart > 0) params.set("start", String(normalizedStart));
  return `${EU_SAFETY_GATE_RAPEX_URL}?${params.toString()}`;
}

function socrataLikeLiteral(value = "") {
  return String(value || "").replace(/'/g, "''").toUpperCase();
}

function nhtsaRecallSearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, offset = 0 } = {}) {
  const term = socrataLikeLiteral(cleanText(keyword, 120));
  const params = new URLSearchParams({
    "$limit": String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    "$order": "report_received_date DESC",
    "$where": [
      `upper(manufacturer) like '%${term}%'`,
      `upper(subject) like '%${term}%'`,
      `upper(defect_summary) like '%${term}%'`,
      `upper(consequence_summary) like '%${term}%'`,
    ].join(" OR "),
  });
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  if (normalizedOffset > 0) params.set("$offset", String(normalizedOffset));
  return `${NHTSA_RECALLS_BY_MANUFACTURER_URL}?${params.toString()}`;
}

function vehicleComplaintCandidatesFromKeyword(keyword = "") {
  const raw = cleanText(keyword, 160);
  const yearMatch = raw.match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  if (!yearMatch) return [];
  const modelYear = yearMatch[1];
  const beforeYear = raw.slice(0, yearMatch.index).trim();
  const afterYear = raw.slice((yearMatch.index || 0) + modelYear.length).trim();
  const candidateText = (beforeYear || afterYear || raw.replace(modelYear, " ")).replace(/\b(vehicle|car|auto|recall|complaint|safety|defect)\b/gi, " ").trim();
  const parts = candidateText.split(/\s+/).map(part => cleanText(part, 80)).filter(Boolean);
  if (parts.length < 2) return [];
  const make = parts[0];
  const model = parts.slice(1).join(" ");
  return [{ make, model, modelYear }];
}

function nhtsaComplaintSearchUrl(candidate = {}) {
  const params = new URLSearchParams({
    make: cleanText(candidate.make, 80),
    model: cleanText(candidate.model, 120),
    modelYear: cleanText(candidate.modelYear, 10),
  });
  return `${NHTSA_VEHICLE_COMPLAINTS_URL}?${params.toString()}`;
}

function absoluteFdaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.fda.gov/${value.replace(/^\/+/, "")}`;
}

function fdaRecallAlertsSearchUrl(keyword = "") {
  const params = new URLSearchParams({ search_api_fulltext: cleanText(keyword, 120) });
  return `${FDA_RECALLS_MARKET_WITHDRAWALS_URL}?${params.toString()}`;
}

function ukFsaFoodAlertsSearchUrl(keyword = "", { page = 1 } = {}) {
  const params = new URLSearchParams({
    keywords: cleanText(keyword, 120),
    sort: "created",
    page: String(Math.max(1, Number(page) || 1)),
  });
  params.append("filter_type[Food alert]", "Food alert");
  params.append("filter_type[Allergy alert]", "Allergy alert");
  return `${UK_FSA_FOOD_ALERTS_SEARCH_API_URL}?${params.toString()}`;
}

function thailandFdaProductRecallRssUrl({ page = 1, perPage = 10 } = {}) {
  const url = new URL(THAILAND_FDA_PRODUCT_RECALLS_RSS_URL);
  url.searchParams.set("p", String(Math.max(1, Number(page) || 1)));
  url.searchParams.set("ppp", String(Math.max(1, Math.min(40, Number(perPage) || 10))));
  return url.toString();
}

function decodeXmlText(value = "", max = 1200) {
  return cleanText(String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1"), max);
}

function cleanDecodedHtml(value = "", max = 1800) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function textSectionBetween(text = "", label = "", nextLabels = []) {
  const source = String(text || "");
  const lower = source.toLowerCase();
  const start = lower.indexOf(String(label || "").toLowerCase());
  if (start < 0) return "";
  let end = source.length;
  for (const next of nextLabels) {
    const index = lower.indexOf(String(next || "").toLowerCase(), start + label.length);
    if (index >= 0 && index < end) end = index;
  }
  return cleanText(source.slice(start + label.length, end), 1200);
}

function rssTagValue(block = "", tag = "", max = 1200) {
  const match = String(block || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXmlText(match?.[1] || "", max);
}

function rssTagHtmlValue(block = "", tag = "", max = 20000) {
  const match = String(block || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return String(match?.[1] || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .slice(0, max);
}

function rssItems(xml = "") {
  const source = String(xml || "");
  const out = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(source)) !== null) {
    const block = match[1] || "";
    out.push({
      title: rssTagValue(block, "title", 420),
      link: rssTagValue(block, "link", 900),
      guid: rssTagValue(block, "guid", 900),
      description: rssTagValue(block, "description", 20000),
      descriptionHtml: rssTagHtmlValue(block, "description", 20000),
      pubDate: rssTagValue(block, "pubDate", 160) || rssTagValue(block, "dc:date", 160),
      category: rssTagValue(block, "category", 220),
      creator: rssTagValue(block, "dc:creator", 220),
      imageUrl: rssTagValue(block.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i)?.[1] || "", "url", 900),
      imageTitle: rssTagValue(block.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i)?.[1] || "", "title", 220),
    });
  }
  return out;
}

function atomItems(xml = "") {
  const source = String(xml || "");
  const out = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(source)) !== null) {
    const block = match[1] || "";
    const link = (block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
      || block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i)
      || [])[1] || "";
    out.push({
      title: rssTagValue(block, "title", 520),
      link: cleanText(link, 900),
      id: rssTagValue(block, "id", 900),
      updated: rssTagValue(block, "updated", 160),
      summary: rssTagValue(block, "summary", 1800),
    });
  }
  return out;
}

function extractHtmlTableCells(rowHtml = "") {
  return [...String(rowHtml || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1] || "");
}

function extractHtmlDate(cellHtml = "") {
  const datetime = (String(cellHtml || "").match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1] || "";
  return normalizeDate(datetime) || normalizeDate(cleanText(cellHtml, 80));
}

function recallRiskLevel({ classification = "", hazard = "", reason = "", injuries = "" } = {}) {
  const text = `${classification} ${hazard} ${reason} ${injuries}`.toLowerCase();
  if (/class i|death|fatal|serious injury|injur|fire|burn|choking|laceration|poison|allergen|salmonella|listeria|e\.? coli|undeclared|contamination|microbiolog|aspergillus|mold|yeast|pathogen|shock|suffocation|asphyxiation|死亡|重傷|受傷|火災|燒傷|窒息|污染|過敏/i.test(text)) return "high";
  if (/class ii|recall|hazard|risk|violation|defect|mislabel|foreign material|召回|風險|风险|缺陷|警示/i.test(text)) return "medium";
  return "low";
}

function valuesFromArray(rows = [], field = "", maxItems = 8) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => cleanText(row?.[field], 220))
    .filter(Boolean)
    .slice(0, maxItems);
}

function firstOpenFdaValue(value) {
  if (Array.isArray(value)) return cleanText(value[0], 220);
  return cleanText(value, 220);
}

function normalizeCpscRecall(row = {}, keyword = "") {
  const recallNumber = cleanText(row.RecallNumber || row.recall_number || row.recallNumber, 80);
  const title = cleanText(row.RecallTitle || row.title || row.Name, 360);
  const products = Array.isArray(row.Products) ? row.Products : [];
  const productNames = products.map(product => cleanText(product?.Name || product?.ProductName || product?.Description, 220)).filter(Boolean);
  const hazard = cleanText(row.Hazards?.[0]?.Name || row.Hazard || row.hazard, 500);
  const remedy = cleanText(row.Remedies?.[0]?.Name || row.Remedy || row.remedy, 500);
  const incidents = cleanText(row.Injuries || row.Incidents || row.incidents, 600);
  const manufacturers = Array.isArray(row.Manufacturers) ? row.Manufacturers : [];
  const firm = cleanText(manufacturers[0]?.Name || row.Manufacturer || row.FirmName, 220);
  const description = cleanText(row.Description || row.ConsumerContact || row.Summary, 900);
  const searchable = [recallNumber, title, productNames.join(" "), hazard, remedy, incidents, firm, description].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.RecallDate || row.Date || row.date) || new Date().toISOString();
  return {
    url: row.URL || row.Url || row.url || (recallNumber ? `https://www.cpsc.gov/Recalls?search_api_fulltext=${encodeURIComponent(recallNumber)}` : "https://www.cpsc.gov/Recalls"),
    title: `CPSC product recall: ${title || productNames[0] || recallNumber || keyword}`,
    content: [
      title ? `${title}.` : "",
      productNames.length ? `Products: ${productNames.join(", ")}.` : "",
      firm ? `Firm: ${firm}.` : "",
      hazard ? `Hazard: ${hazard}.` : "",
      remedy ? `Remedy: ${remedy}.` : "",
      incidents ? `Incidents/Injuries: ${incidents}.` : "",
      description,
    ].filter(Boolean).join(" "),
    author: "U.S. Consumer Product Safety Commission",
    publishedAt,
    riskLevel: recallRiskLevel({ hazard, reason: description, injuries: incidents }),
    metrics: {
      source: "cpsc_recalls_api",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "cpsc_public_recall_json",
      recall_record_source: "CPSC Recalls",
      recall_category: "consumer_product",
      recall_number: recallNumber,
      recall_title: title,
      recall_firm: firm,
      recall_products: productNames,
      recall_hazard: hazard,
      recall_remedy: remedy,
      recall_incidents: incidents,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseCpscRecallResults(payload = [], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.Recalls) ? payload.Recalls : Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeCpscRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.recall_number || `${item.title}:${item.publishedAt}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeOpenFdaRecall(row = {}, keyword = "", target = OPENFDA_TARGETS[0]) {
  const recallNumber = cleanText(row.recall_number || row.event_id, 100);
  const product = cleanText(row.product_description || row.product_quantity || row.code_info, 520);
  const firm = cleanText(row.recalling_firm, 240);
  const reason = cleanText(row.reason_for_recall, 900);
  const status = cleanText(row.status, 80);
  const classification = cleanText(row.classification, 80);
  const distribution = cleanText(row.distribution_pattern, 500);
  const codeInfo = cleanText(row.code_info, 500);
  const searchable = [recallNumber, product, firm, reason, status, classification, distribution, codeInfo].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.recall_initiation_date || row.report_date || row.center_classification_date) || new Date().toISOString();
  return {
    url: recallNumber
      ? `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Product=${encodeURIComponent(recallNumber)}`
      : "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
    title: `openFDA ${target.category} recall: ${firm || product || recallNumber || keyword}`,
    content: [
      product ? `Product: ${product}.` : "",
      firm ? `Recalling firm: ${firm}.` : "",
      classification ? `Classification: ${classification}.` : "",
      status ? `Status: ${status}.` : "",
      reason ? `Reason: ${reason}.` : "",
      distribution ? `Distribution: ${distribution}.` : "",
      codeInfo ? `Code info: ${codeInfo}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Food and Drug Administration",
    publishedAt,
    riskLevel: recallRiskLevel({ classification, reason }),
    metrics: {
      source: target.key,
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "openfda_public_enforcement_json",
      recall_record_source: target.name,
      recall_category: target.category,
      recall_number: recallNumber,
      recall_firm: firm,
      recall_product: product,
      recall_reason: reason,
      recall_classification: classification,
      recall_status: status,
      recall_distribution: distribution,
      recall_code_info: codeInfo,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseOpenFdaRecallResults(payload = {}, keyword = "", { target = OPENFDA_TARGETS[0], limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeOpenFdaRecall(row, keyword, target);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `${item.metrics.source}:${item.metrics.recall_number || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countOpenFdaRawResults(payload = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  return rows.length;
}

function countEuSafetyGateRawResults(payload = {}) {
  const rows = Array.isArray(payload?.records) ? payload.records : Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  return rows.length;
}

function countNhtsaRecallRawResults(payload = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return rows.length;
}

function countUkFsaFoodAlertRawResults(payload = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.["#data"]?.items) ? payload["#data"].items : [];
  return rows.length;
}

function countRssItems(xml = "") {
  return rssItems(xml).length;
}

function unzipTextFiles(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const signature = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    if (signature !== 0x04034b50) break;
    const flags = bytes[offset + 6] | (bytes[offset + 7] << 8);
    const method = bytes[offset + 8] | (bytes[offset + 9] << 8);
    const compressedSize = bytes[offset + 18] | (bytes[offset + 19] << 8) | (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24);
    const fileNameLength = bytes[offset + 26] | (bytes[offset + 27] << 8);
    const extraLength = bytes[offset + 28] | (bytes[offset + 29] << 8);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    if ((flags & 0x08) || compressedSize < 0 || dataStart + compressedSize > bytes.length) break;
    const fileName = new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength));
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let data = compressed;
    if (method === 8) data = inflateRawSync(compressed);
    else if (method !== 0) {
      offset = dataStart + compressedSize;
      continue;
    }
    files.set(fileName, new TextDecoder("utf-8").decode(data));
    offset = dataStart + compressedSize;
  }
  return files;
}

function parseCsvRows(csv = "") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const text = String(csv || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === "\"" && next === "\"") {
        field += "\"";
        i += 1;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(value => String(value || "").trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some(value => String(value || "").trim())) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map(header => cleanText(header, 120));
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, cleanText(values[index] || "", 2000)])));
}

function parseFdaImportRefusalArchive(buffer) {
  const files = unzipTextFiles(buffer);
  const refusalCsv = [...files.entries()].find(([name]) => /REFUSAL_ENTRY/i.test(name))?.[1] || "";
  const chargesCsv = [...files.entries()].find(([name]) => /ACT_SECTION_CHARGES/i.test(name))?.[1] || "";
  const chargeRows = parseCsvRows(chargesCsv);
  const chargeMap = new Map();
  for (const row of chargeRows) {
    const ascId = cleanText(row.ASC_ID, 80);
    const chrgCode = cleanText(row.CHRG_CODE, 120);
    const statement = cleanText(row.CHRG_STMNT_TEXT, 1000);
    const section = cleanText(row.SCTN_NAME, 360);
    for (const key of [ascId, chrgCode]) {
      if (key) chargeMap.set(key.toUpperCase(), { ascId, chrgCode, statement, section });
    }
  }
  return {
    refusals: parseCsvRows(refusalCsv),
    charges: chargeMap,
    files: [...files.keys()],
  };
}

function fdaImportRefusalRiskLevel({ charges = "", chargeStatements = "", productDescription = "", sampleAnalysis = "" } = {}) {
  const text = `${charges} ${chargeStatements} ${productDescription} ${sampleAnalysis}`.toLowerCase();
  if (/salmonella|listeria|e\.? coli|poison|deleterious|filthy|pesticide|unsafe|adulterat|new drug|unapproved|pathogen|lead|aflatoxin|heavy metal|injurious|toxic|disease|contaminat|unsafe food additive|poisonous|有毒|污染|未批准|摻假|掺假/i.test(text)) return "high";
  if (/misbrand|label|false|misleading|registration|listing|refusal|801\(a\)|import|sample analysis|detain|違規|违规|標示|标示/i.test(text)) return "medium";
  return "low";
}

function normalizeFdaImportRefusal(row = {}, keyword = "", chargeMap = new Map()) {
  const fei = cleanText(row.MFG_FIRM_FEI_NUM, 80);
  const firm = cleanText(row.LGL_NAME, 260);
  const address = [row.LINE1_ADRS, row.LINE2_ADRS].map(part => cleanText(part, 220)).filter(Boolean).join(", ");
  const city = cleanText(row.CITY_NAME, 120);
  const province = cleanText(row.PROVINCE_STATE, 120);
  const country = cleanText(row.ISO_CNTRY_CODE, 40);
  const productCode = cleanText(row.PRODUCT_CODE, 80);
  const refusalDate = cleanText(row.REFUSAL_DATE, 80);
  const district = cleanText(row.DISTRICT, 80);
  const entryNumber = cleanText(row.ENTRY_NUM, 120);
  const referenceDocId = cleanText(row.RFRNC_DOC_ID, 120);
  const lineNumber = cleanText(row.LINE_NUM, 80);
  const lineSuffix = cleanText(row.LINE_SFX_ID, 80);
  const sampleAnalysis = cleanText(row.FDA_SAMPLE_ANALYSIS, 80);
  const privateLabAnalysis = cleanText(row.PRIVATE_LAB_ANALYSIS, 80);
  const refusalCharges = cleanText(row.REFUSAL_CHARGES, 260);
  const productDescription = cleanText(row.PRDCT_CODE_DESC_TEXT, 520);
  const chargeDetails = refusalCharges
    .split(/[,;|]+/)
    .map(code => cleanText(code, 80).toUpperCase())
    .filter(Boolean)
    .map(code => chargeMap.get(code) || { ascId: code, chrgCode: code, statement: "", section: "" })
    .slice(0, 12);
  const chargeStatements = chargeDetails.map(charge => [charge.chrgCode, charge.section, charge.statement].filter(Boolean).join(": ")).filter(Boolean);
  const searchable = [fei, firm, address, city, province, country, productCode, district, entryNumber, referenceDocId, productDescription, refusalCharges, chargeStatements.join(" ")].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(refusalDate) || new Date().toISOString();
  const location = [address, city, province, country].filter(Boolean).join(", ");
  return {
    url: entryNumber
      ? `https://www.accessdata.fda.gov/scripts/importrefusals/index.cfm#${encodeURIComponent(entryNumber)}`
      : "https://www.accessdata.fda.gov/scripts/importrefusals/",
    title: `FDA import refusal: ${firm || keyword}${productDescription ? ` - ${productDescription}` : ""}`,
    content: [
      firm ? `Manufacturer: ${firm}.` : "",
      fei ? `Manufacturer FEI: ${fei}.` : "",
      location ? `Location: ${location}.` : "",
      productCode ? `Product code: ${productCode}.` : "",
      productDescription ? `Product: ${productDescription}.` : "",
      refusalDate ? `Refusal date: ${refusalDate}.` : "",
      district ? `FDA district: ${district}.` : "",
      entryNumber ? `Entry number: ${entryNumber}.` : "",
      referenceDocId ? `Reference document: ${referenceDocId}.` : "",
      [lineNumber, lineSuffix].filter(Boolean).length ? `Line/suffix: ${[lineNumber, lineSuffix].filter(Boolean).join("/")}.` : "",
      refusalCharges ? `Refusal charges: ${refusalCharges}.` : "",
      chargeStatements.length ? `Charge statements: ${chargeStatements.join(" | ")}.` : "",
      sampleAnalysis ? `FDA sample analysis: ${sampleAnalysis}.` : "",
      privateLabAnalysis ? `Private lab analysis: ${privateLabAnalysis}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Food and Drug Administration",
    publishedAt,
    riskLevel: fdaImportRefusalRiskLevel({ charges: refusalCharges, chargeStatements: chargeStatements.join(" "), productDescription, sampleAnalysis }),
    evidenceType: "public_product_import_refusal",
    metrics: {
      source: "fda_import_refusals",
      source_family: "official",
      source_kind: "public_product_import_refusal",
      collection_mode: "fda_public_import_refusals_zip_csv",
      import_refusal_record_source: "FDA Import Refusals",
      import_refusal_category: "food_drug_cosmetic_device_import",
      import_refusal_manufacturer_fei: fei,
      import_refusal_manufacturer: firm,
      import_refusal_address: address,
      import_refusal_city: city,
      import_refusal_province_state: province,
      import_refusal_country: country,
      import_refusal_product_code: productCode,
      import_refusal_product_description: productDescription,
      import_refusal_date: refusalDate,
      import_refusal_district: district,
      import_refusal_entry_number: entryNumber,
      import_refusal_reference_doc_id: referenceDocId,
      import_refusal_line_number: lineNumber,
      import_refusal_line_suffix_id: lineSuffix,
      import_refusal_fda_sample_analysis: sampleAnalysis,
      import_refusal_private_lab_analysis: privateLabAnalysis,
      import_refusal_charges: refusalCharges,
      import_refusal_charge_codes: chargeDetails.map(charge => charge.chrgCode || charge.ascId).filter(Boolean),
      import_refusal_charge_sections: chargeDetails.map(charge => charge.section).filter(Boolean),
      import_refusal_charge_statements: chargeDetails.map(charge => charge.statement).filter(Boolean),
      source_weight_tier: "regulatory-import-refusal",
    },
  };
}

function parseFdaImportRefusalResults(archive = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const refusals = Array.isArray(archive?.refusals) ? archive.refusals : [];
  const chargeMap = archive?.charges instanceof Map ? archive.charges : new Map();
  const out = [];
  const seen = new Set();
  for (const row of refusals) {
    const item = normalizeFdaImportRefusal(row, keyword, chargeMap);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = [
      item.metrics.import_refusal_entry_number,
      item.metrics.import_refusal_reference_doc_id,
      item.metrics.import_refusal_line_number,
      item.metrics.import_refusal_line_suffix_id,
      item.metrics.import_refusal_charges,
    ].filter(Boolean).join(":") || item.url || item.title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeCdcFoodSafetyAlert(row = {}, keyword = "") {
  const title = cleanText(row.title, 420);
  const description = cleanText(row.description, 1800);
  const category = cleanText(row.category || "Food Safety", 220);
  const guid = cleanText(row.guid, 900);
  const url = guid && /^https?:\/\//i.test(guid) ? guid : cleanText(row.link, 900) || CDC_FOOD_SAFETY_RSS_URL;
  const searchable = [title, description, category, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  const riskLevel = recallRiskLevel({
    classification: category,
    hazard: `${title} ${description}`,
    reason: `${title} ${description}`,
  });
  return {
    url,
    title: `CDC food safety alert: ${title}`,
    content: [
      title ? `${title}.` : "",
      description,
      category ? `Category: ${category}.` : "",
      guid && guid !== url ? `Original guid: ${guid}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Centers for Disease Control and Prevention",
    publishedAt,
    riskLevel,
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "cdc_food_safety_rss",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "cdc_public_food_safety_rss",
      recall_record_source: "CDC Food Safety Alerts",
      recall_category: "food_safety",
      recall_product: title,
      recall_reason: description,
      recall_classification: category,
      recall_status: "",
      recall_hazard: description,
      recall_source_guid: guid,
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseCdcFoodSafetyAlertResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeCdcFoodSafetyAlert(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `cdc-food-safety:${item.metrics.recall_source_guid || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeFdaRecallAlertRow(cells = [], keyword = "") {
  if (!Array.isArray(cells) || cells.length < 6) return null;
  const publishedAt = extractHtmlDate(cells[0]) || new Date().toISOString();
  const brandCell = cells[1] || "";
  const brandLink = brandCell.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const url = absoluteFdaUrl(brandLink?.[1] || "");
  const brand = cleanText(brandLink?.[2] || brandCell, 260);
  const productDescription = cleanText(cells[2], 520);
  const productType = cleanText(cells[3], 180);
  const reason = cleanText(cells[4], 900);
  const company = cleanText(cells[5], 260);
  const terminated = cleanText(cells[6], 120);
  const excerpt = cleanText(cells[7], 1400);
  const searchable = [brand, productDescription, productType, reason, company, terminated, excerpt].join(" ");
  if (!brand || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url: url || FDA_RECALLS_MARKET_WITHDRAWALS_URL,
    title: `FDA recall/safety alert: ${brand}${productDescription ? ` - ${productDescription}` : ""}`,
    content: [
      brand ? `Brand: ${brand}.` : "",
      company ? `Company: ${company}.` : "",
      productDescription ? `Product: ${productDescription}.` : "",
      productType ? `Product type: ${productType}.` : "",
      reason ? `Recall reason: ${reason}.` : "",
      terminated ? `Terminated recall: ${terminated}.` : "",
      excerpt,
    ].filter(Boolean).join(" "),
    author: "U.S. Food and Drug Administration",
    publishedAt,
    riskLevel: recallRiskLevel({ classification: productType, hazard: reason, reason: `${reason} ${excerpt}` }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "fda_recalls_market_withdrawals",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "fda_public_recalls_market_withdrawals_html",
      recall_record_source: "FDA Recalls, Market Withdrawals & Safety Alerts",
      recall_category: "fda_regulated_product",
      recall_number: "",
      recall_firm: company || brand,
      recall_brand: brand,
      recall_product: productDescription,
      recall_reason: reason || excerpt,
      recall_classification: productType,
      recall_status: terminated,
      recall_hazard: reason,
      recall_product_category: productType,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseFdaRecallAlertResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const cells = extractHtmlTableCells(match[1]);
    const item = normalizeFdaRecallAlertRow(cells, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `fda-recall-alert:${item.url || `${item.metrics.recall_brand}:${item.metrics.recall_product}:${item.publishedAt}`}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeProductSafetyAustraliaRecall(row = {}, keyword = "") {
  const title = cleanText(row.title, 420);
  const url = cleanText(row.link, 900) || PRODUCT_SAFETY_AUSTRALIA_RECALLS_RSS_URL;
  const category = cleanText(row.category, 220);
  const descriptionText = cleanDecodedHtml(row.description, 2400);
  const productDescription = textSectionBetween(descriptionText, "Product description", [
    "Reason the product is recalled",
    "The hazards to consumers",
    "What consumers should do",
  ]) || title;
  const reason = textSectionBetween(descriptionText, "Reason the product is recalled", [
    "The hazards to consumers",
    "What consumers should do",
    "Supplier",
    "Traders who sold this product",
  ]);
  const hazards = textSectionBetween(descriptionText, "The hazards to consumers", [
    "What consumers should do",
    "Supplier",
    "Traders who sold this product",
  ]);
  const consumerAction = textSectionBetween(descriptionText, "What consumers should do", [
    "Supplier",
    "Traders who sold this product",
    "Where the product was sold",
  ]);
  const searchable = [title, url, category, productDescription, reason, hazards, consumerAction, descriptionText].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  return {
    url,
    title: `Product Safety Australia recall: ${title}`,
    content: [
      productDescription ? `Product: ${productDescription}.` : "",
      category ? `Category: ${category}.` : "",
      reason ? `Recall reason: ${reason}.` : "",
      hazards ? `Hazards: ${hazards}.` : "",
      consumerAction ? `Consumer action: ${consumerAction}.` : "",
      !reason && !hazards ? descriptionText : "",
    ].filter(Boolean).join(" "),
    author: "Product Safety Australia",
    publishedAt,
    riskLevel: recallRiskLevel({ classification: category, hazard: hazards, reason: `${reason} ${descriptionText}` }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "product_safety_australia_recalls",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "product_safety_australia_public_rss",
      recall_record_source: "Product Safety Australia Recalls",
      recall_category: "consumer_product",
      recall_number: cleanText(row.guid, 120),
      recall_title: title,
      recall_product: productDescription,
      recall_product_category: category,
      recall_reason: reason || descriptionText,
      recall_hazard: hazards,
      recall_status: consumerAction,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseProductSafetyAustraliaRecallResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeProductSafetyAustraliaRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `product-safety-australia:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function ukProductSafetyRecordType(title = "") {
  const prefix = cleanText(title, 180).split(":")[0].trim();
  if (/product recall/i.test(prefix)) return "product-recall";
  if (/product safety report/i.test(prefix)) return "product-safety-report";
  if (/product safety alert/i.test(prefix)) return "product-safety-alert";
  return prefix ? prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "product-safety-record";
}

function normalizeUkProductSafetyAlert(row = {}, keyword = "") {
  const title = cleanText(row.title, 520);
  const url = cleanText(row.link, 900) || UK_PRODUCT_SAFETY_ALERTS_ATOM_URL;
  const summary = cleanText(row.summary, 1200);
  const recordId = cleanText((title.match(/\(([^()]*\d{2,}[^()]*)\)\s*$/) || [])[1] || row.id, 180);
  const recordType = ukProductSafetyRecordType(title);
  const product = cleanText(title.replace(/^Product\s+(?:Recall|Safety Report|Safety Alert)\s*:\s*/i, "").replace(/\s*\([^()]*\d{2,}[^()]*\)\s*$/, ""), 360);
  const channel = cleanText((product.match(/\bsold via\s+(.+)$/i) || product.match(/\bsold at\s+(.+)$/i) || [])[1] || "", 180);
  const searchable = [title, product, channel, recordId, summary, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.updated) || new Date().toISOString();
  return {
    url,
    title: `UK product safety ${recordType.replace(/^product-/, "").replace(/-/g, " ")}: ${product || title}`,
    content: [
      product ? `Product: ${product}.` : "",
      recordType ? `Record type: ${recordType}.` : "",
      recordId ? `Record ID: ${recordId}.` : "",
      channel ? `Sales channel: ${channel}.` : "",
      summary,
    ].filter(Boolean).join(" "),
    author: "UK Office for Product Safety and Standards",
    publishedAt,
    riskLevel: recallRiskLevel({ classification: recordType, hazard: title, reason: `${title} ${summary}` }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "uk_product_safety_alerts",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "uk_gov_public_product_safety_atom",
      recall_record_source: "UK Product Safety Alerts, Reports and Recalls",
      recall_category: "consumer_product",
      recall_number: recordId,
      recall_title: title,
      recall_product: product,
      recall_product_category: "consumer_product",
      recall_reason: summary || title,
      recall_hazard: title,
      recall_status: recordType,
      recall_distribution: channel,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseUkProductSafetyAlertResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of atomItems(xml)) {
    const item = normalizeUkProductSafetyAlert(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `uk-product-safety:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function ukFsaMarkupText(value = "", max = 1200) {
  if (value && typeof value === "object") return cleanText(value["#markup"] || value.markup || "", max);
  return cleanText(value, max);
}

function normalizeUkFsaDate(value = "") {
  const raw = cleanText(value, 80);
  const isoNoZone = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$/);
  if (isoNoZone) {
    const time = new Date(`${isoNoZone[1]}T${isoNoZone[2]}.000Z`).getTime();
    return Number.isNaN(time) ? "" : new Date(time).toISOString();
  }
  return normalizeDate(raw);
}

function ukFsaFoodAlertRiskLevel({ title = "", body = "", allergens = [] } = {}) {
  const text = `${title} ${body} ${allergens.join(" ")}`.toLowerCase();
  if (/food alert\s*"?for action"?|do not eat|do not consume|not consumed|unsafe to eat|withdrawn from the market|recalled from consumers|clostridium|botulinum|cereulide|toxin|listeria|salmonella|e\.?\s*coli|stec|norovirus|hepatitis|mould|mold|mouse|pest|contaminat|undeclared|not declared|not mentioned|allergen|milk|gluten|wheat|barley|egg|peanut|nuts|hazelnut|sesame|soya|mustard|celery|fish|crustacean|mollusc|sulphur dioxide|sulphites|foreign matter|metal|glass|plastic|sharp edges|injury|infant|baby|formula/i.test(text)) return "high";
  if (/recall|allergy alert|food alert|incorrect|use-by|best before|label|batch|product|risk|safety concern|precautionary/i.test(text)) return "medium";
  return "low";
}

function ukFsaFoodAlertStatus({ title = "", contentType = "" } = {}) {
  const text = `${title} ${contentType}`.toLowerCase();
  if (/food alert\s*"?for action"?|fafa/.test(text)) return "food-alert-for-action";
  if (/allergy alert/.test(text)) return "allergy-alert";
  if (/recall/.test(text)) return "product-recall";
  if (/food alert/.test(text)) return "food-alert";
  return "food-safety-alert";
}

function normalizeUkFsaFoodAlert(row = {}, keyword = "") {
  if (!row || typeof row !== "object") return null;
  const title = ukFsaMarkupText(row.name, 700);
  const intro = ukFsaMarkupText(row.intro, 1200);
  const body = ukFsaMarkupText(row.body, 2200) || intro;
  const url = cleanText(row.url, 900) || UK_FSA_FOOD_ALERTS_SEARCH_API_URL;
  const recordId = cleanText(row.id || (url.match(/\/alert\/([^/?#]+)/i) || [])[1] || "", 160);
  const alertCode = cleanText((url.match(/\/alert\/([^/?#]+)/i) || [])[1] || "", 160);
  const contentType = cleanText(row.content_type || row.filter_type, 160);
  const allergens = Array.isArray(row.allergens_list)
    ? row.allergens_list.map(item => cleanText(item?.label || item?.name || item, 120)).filter(Boolean)
    : [];
  const nations = Array.isArray(row.nation)
    ? row.nation.map(item => cleanText(item?.label || item?.name || item, 120)).filter(Boolean)
    : [];
  const firm = cleanText((title.match(/^(?:Updated:\s*)?(.+?)\s+(?:is\s+|are\s+)?recall(?:s|ing)?\b/i) || [])[1] || "", 260);
  const product = cleanText(
    (title.match(/recalls?\s+(.+?)\s+because\b/i)
      || title.match(/recalling\s+(.+?)\s+because\b/i)
      || title.match(/recalls?\s+(.+?)\s+due to\b/i)
      || title.match(/recalls?\s+(.+?)\s+as (?:it|they)\s+may\b/i)
      || title.match(/Food Alert\s+"?For Action"?[\s\S]*?products supplied by\s+(.+)$/i)
      || [])[1] || title,
    620,
  );
  const reason = cleanText(
    (title.match(/\bbecause\s+(.+)$/i)
      || title.match(/\bdue to\s+(.+)$/i)
      || body.match(/\bbecause\s+(.+?)(?:\.|$)/i)
      || body.match(/\bdue to\s+(.+?)(?:\.|$)/i)
      || [])[1] || body || title,
    900,
  ).replace(/^of\s+/i, "");
  const searchable = [title, intro, body, url, recordId, alertCode, contentType, product, firm, reason, allergens.join(" "), nations.join(" ")].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeUkFsaDate(row.created) || normalizeEnglishMonthDate(row.created_formatted) || normalizeUkFsaDate(row.updated) || new Date().toISOString();
  const updatedAt = normalizeUkFsaDate(row.updated) || normalizeEnglishMonthDate(row.updated_formatted);
  const status = ukFsaFoodAlertStatus({ title, contentType });
  return {
    url,
    title: `UK FSA food alert: ${title}`,
    content: [
      product ? `Product: ${product}.` : "",
      firm ? `Firm: ${firm}.` : "",
      contentType ? `Alert type: ${contentType}.` : "",
      allergens.length ? `Allergens: ${allergens.join(", ")}.` : "",
      nations.length ? `Nations: ${nations.join(", ")}.` : "",
      reason ? `Reason: ${reason}.` : "",
      body && body !== reason ? `Summary: ${body}.` : "",
      alertCode ? `Alert code: ${alertCode}.` : "",
    ].filter(Boolean).join(" "),
    author: "UK Food Standards Agency",
    publishedAt,
    riskLevel: ukFsaFoodAlertRiskLevel({ title, body, allergens }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "uk_fsa_food_alerts",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "uk_fsa_public_food_alerts_search_api",
      recall_record_source: "UK FSA Food Alerts and Allergy Alerts",
      recall_category: "food_safety",
      recall_number: alertCode || recordId,
      recall_title: title,
      recall_firm: firm,
      recall_product: product,
      recall_product_category: "food_safety",
      recall_reason: reason,
      recall_hazard: reason,
      recall_status: status,
      recall_alert_type: contentType,
      recall_allergens: allergens,
      recall_distribution: nations.join(", "),
      recall_created_at: publishedAt,
      recall_updated_at: updatedAt,
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseUkFsaFoodAlertResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.["#data"]?.items) ? payload["#data"].items : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeUkFsaFoodAlert(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `uk-fsa-food-alert:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function canadaRecallCollectionMode(target = CANADA_CONSUMER_PRODUCT_RECALLS_TARGET) {
  const key = cleanText(target?.key || "canada_consumer_product_recalls", 120)
    .replace(/^canada_/i, "")
    .replace(/[^a-z0-9_]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `canada_public_${key}_rss`;
}

function normalizeCanadaRecall(row = {}, keyword = "", target = CANADA_CONSUMER_PRODUCT_RECALLS_TARGET) {
  const title = cleanText(row.title, 520);
  const url = cleanText(row.link, 900) || target.url || CANADA_CONSUMER_PRODUCT_RECALLS_RSS_URL;
  const description = cleanDecodedHtml(row.description, 1800);
  const category = cleanText(row.creator || row.category || target.category || "Consumer product", 220);
  const recordId = cleanText(row.guid, 180);
  const label = cleanText(target.label || target.category || "recall", 120).replace(/_/g, " ");
  const sourceKey = cleanText(target.key || "canada_consumer_product_recalls", 160);
  const sourceName = cleanText(target.name || "Canada Consumer Product Recalls", 220);
  const searchable = [title, description, category, recordId, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  return {
    url,
    title: `Canada ${label} recall: ${title}`,
    content: [
      title ? `Title: ${title}.` : "",
      category ? `Category: ${category}.` : "",
      recordId ? `Record ID: ${recordId}.` : "",
      description ? `Summary: ${description}.` : "",
    ].filter(Boolean).join(" "),
    author: "Health Canada",
    publishedAt,
    riskLevel: recallRiskLevel({ classification: category, hazard: description, reason: `${title} ${description}` }),
    evidenceType: "public_product_recall",
    metrics: {
      source: sourceKey,
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: canadaRecallCollectionMode(target),
      recall_record_source: sourceName,
      recall_category: cleanText(target.category || "consumer_product", 120),
      recall_number: recordId,
      recall_title: title,
      recall_product: title,
      recall_product_category: category,
      recall_reason: description,
      recall_hazard: description,
      recall_status: "consumer-product-recall",
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseCanadaRecallResults(xml = "", keyword = "", { target = CANADA_CONSUMER_PRODUCT_RECALLS_TARGET, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeCanadaRecall(row, keyword, target);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `${target.key || "canada-recall"}:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function parseCanadaConsumerProductRecallResults(xml = "", keyword = "", options = {}) {
  return parseCanadaRecallResults(xml, keyword, { ...options, target: options.target || CANADA_CONSUMER_PRODUCT_RECALLS_TARGET });
}

function fssaiAdvisoryRiskLevel({ title = "" } = {}) {
  const text = cleanText(title, 800).toLowerCase();
  if (/immediate|discontinuation|recall|unsafe|risk|hazard|metallic|pins|wires|contamination|adulterat|misbrand|allergen|toxic|poison|prohibit|withdraw|public health|serious|injury|food safety|召回|污染|過敏|过敏|有毒|危害/i.test(text)) return "high";
  if (/advisory|order|direction|compliance|standard|packaging|labelling|labeling|guidance|notice|circular/i.test(text)) return "medium";
  return "low";
}

function normalizeFssaiAdvisoryRow(cells = [], keyword = "") {
  if (cells.length < 4) return null;
  const serial = cleanText(cells[0], 40);
  const title = cleanText(cells[1], 520);
  const publishedAt = normalizeDmyDate(cells[2]) || new Date().toISOString();
  const linkMatch = String(cells[3] || "").match(/<a[^>]+href=["']([^"']+)["']/i);
  const pdfUrl = absoluteFssaiUrl(linkMatch?.[1] || "");
  const pdfSize = cleanText((String(cells[3] || "").match(/\[([^\]]+)\]/) || [])[1] || "", 80);
  const searchable = [serial, title, pdfUrl, pdfSize].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url: pdfUrl || FSSAI_ADVISORIES_URL,
    title: `FSSAI food safety advisory: ${title}`,
    content: [
      `Title: ${title}.`,
      serial ? `Serial: ${serial}.` : "",
      publishedAt ? `Publish date: ${publishedAt}.` : "",
      pdfSize ? `PDF size: ${pdfSize}.` : "",
    ].filter(Boolean).join(" "),
    author: "Food Safety and Standards Authority of India",
    publishedAt,
    riskLevel: fssaiAdvisoryRiskLevel({ title }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "fssai_food_safety_advisories",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "fssai_public_food_safety_advisories_html",
      recall_record_source: "FSSAI Food Safety Advisories",
      recall_category: "food_safety",
      recall_number: serial,
      recall_title: title,
      recall_product: title,
      recall_product_category: "food_safety",
      recall_reason: title,
      recall_hazard: title,
      recall_status: "food-safety-advisory",
      recall_pdf_size: pdfSize,
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseFssaiAdvisoryResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const cells = extractHtmlTableCells(match[1]);
    const item = normalizeFssaiAdvisoryRow(cells, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `fssai-advisory:${item.url || `${item.metrics.recall_number}:${item.title}:${item.publishedAt}`}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function adverseEventRiskLevel({ serious = "", death = "", hospitalization = "", disability = "", lifeThreatening = "", eventType = "", reactions = "", productProblems = "" } = {}) {
  const text = `${serious} ${death} ${hospitalization} ${disability} ${lifeThreatening} ${eventType} ${reactions} ${productProblems}`.toLowerCase();
  if ([serious, death, hospitalization, disability, lifeThreatening].some(value => String(value || "").trim() === "1")) return "high";
  if (/death|fatal|life.threat|hospital|disab|serious|injury|malfunction|overdose|cardiac|anaphyl|seizure|死亡|住院|重傷|严重|嚴重/i.test(text)) return "high";
  if (/adverse|reaction|problem|complaint|event|pain|rash|nausea|device|drug ineffective|不良|投訴|投诉/i.test(text)) return "medium";
  return "low";
}

function normalizeOpenFdaDrugAdverseEvent(row = {}, keyword = "", target = OPENFDA_ADVERSE_EVENT_TARGETS[0]) {
  const reportId = cleanText(row.safetyreportid || row.companynumb, 120);
  const country = cleanText(row.occurcountry || row.primarysourcecountry, 60);
  const serious = cleanText(row.serious, 20);
  const seriousnessDeath = cleanText(row.seriousnessdeath, 20);
  const seriousnessHospitalization = cleanText(row.seriousnesshospitalization, 20);
  const seriousnessDisabling = cleanText(row.seriousnessdisabling, 20);
  const seriousnessLifeThreatening = cleanText(row.seriousnesslifethreatening, 20);
  const patient = row.patient || {};
  const reactions = valuesFromArray(patient.reaction, "reactionmeddrapt", 12);
  const drugs = Array.isArray(patient.drug) ? patient.drug : [];
  const drugNames = drugs.map(drug => cleanText(drug.medicinalproduct, 220)).filter(Boolean).slice(0, 8);
  const manufacturers = drugs.flatMap(drug => {
    const openfda = drug?.openfda || {};
    return [
      ...((Array.isArray(openfda.manufacturer_name) ? openfda.manufacturer_name : []).map(item => cleanText(item, 220))),
      cleanText(row.reportduplicate?.duplicatesource, 220),
    ].filter(Boolean);
  }).slice(0, 8);
  const brandNames = drugs.flatMap(drug => Array.isArray(drug?.openfda?.brand_name) ? drug.openfda.brand_name.map(item => cleanText(item, 220)).filter(Boolean) : []).slice(0, 8);
  const genericNames = drugs.flatMap(drug => Array.isArray(drug?.openfda?.generic_name) ? drug.openfda.generic_name.map(item => cleanText(item, 220)).filter(Boolean) : []).slice(0, 8);
  const searchable = [reportId, country, row.companynumb, reactions.join(" "), drugNames.join(" "), brandNames.join(" "), genericNames.join(" "), manufacturers.join(" ")].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.receivedate || row.receiptdate || row.transmissiondate) || new Date().toISOString();
  const riskLevel = adverseEventRiskLevel({
    serious,
    death: seriousnessDeath,
    hospitalization: seriousnessHospitalization,
    disability: seriousnessDisabling,
    lifeThreatening: seriousnessLifeThreatening,
    reactions: reactions.join(" "),
  });
  const product = brandNames[0] || drugNames[0] || genericNames[0] || keyword;
  return {
    url: reportId ? `https://api.fda.gov/drug/event.json?search=safetyreportid:${encodeURIComponent(reportId)}` : "https://open.fda.gov/apis/drug/event/",
    title: `openFDA drug adverse event: ${product}`,
    content: [
      reportId ? `Safety report ID: ${reportId}.` : "",
      manufacturers.length ? `Manufacturer: ${[...new Set(manufacturers)].join(", ")}.` : "",
      brandNames.length ? `Brand: ${[...new Set(brandNames)].join(", ")}.` : "",
      genericNames.length ? `Generic: ${[...new Set(genericNames)].join(", ")}.` : "",
      drugNames.length ? `Medicinal product: ${[...new Set(drugNames)].join(", ")}.` : "",
      reactions.length ? `Reported reactions: ${[...new Set(reactions)].join(", ")}.` : "",
      serious ? `Serious: ${serious}.` : "",
      seriousnessDeath ? `Death: ${seriousnessDeath}.` : "",
      seriousnessHospitalization ? `Hospitalization: ${seriousnessHospitalization}.` : "",
      country ? `Country: ${country}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Food and Drug Administration",
    publishedAt,
    riskLevel,
    evidenceType: "public_product_safety_adverse_event",
    metrics: {
      source: target.key,
      source_family: "official",
      source_kind: "public_product_safety_adverse_event",
      collection_mode: "openfda_public_drug_adverse_event_json",
      adverse_event_record_source: target.name,
      adverse_event_category: target.category,
      adverse_event_id: reportId,
      adverse_event_product: product,
      adverse_event_brand_names: [...new Set(brandNames)],
      adverse_event_generic_names: [...new Set(genericNames)],
      adverse_event_manufacturers: [...new Set(manufacturers)],
      adverse_event_reactions: [...new Set(reactions)],
      adverse_event_country: country,
      adverse_event_serious: serious,
      adverse_event_death: seriousnessDeath,
      adverse_event_hospitalization: seriousnessHospitalization,
      adverse_event_disabling: seriousnessDisabling,
      adverse_event_life_threatening: seriousnessLifeThreatening,
      source_weight_tier: "regulatory-adverse-event",
    },
  };
}

function normalizeOpenFdaDeviceAdverseEvent(row = {}, keyword = "", target = OPENFDA_ADVERSE_EVENT_TARGETS[1]) {
  const reportNumber = cleanText(row.report_number || row.mdr_report_key, 120);
  const eventType = cleanText(row.event_type, 120);
  const reportSource = Array.isArray(row.source_type) ? row.source_type.map(item => cleanText(item, 120)).filter(Boolean).join(", ") : cleanText(row.source_type, 120);
  const devices = Array.isArray(row.device) ? row.device : [];
  const firstDevice = devices[0] || {};
  const brandNames = valuesFromArray(devices, "brand_name", 8);
  const genericNames = valuesFromArray(devices, "generic_name", 8);
  const manufacturers = valuesFromArray(devices, "manufacturer_d_name", 8);
  const deviceNames = devices.map(device => firstOpenFdaValue(device?.openfda?.device_name)).filter(Boolean).slice(0, 8);
  const modelNumbers = valuesFromArray(devices, "model_number", 8);
  const productProblems = Array.isArray(row.product_problems) ? row.product_problems.map(item => cleanText(item, 220)).filter(Boolean).slice(0, 12) : [];
  const patientProblems = (Array.isArray(row.patient) ? row.patient : [])
    .flatMap(patient => Array.isArray(patient.sequence_number_outcome) ? patient.sequence_number_outcome : [])
    .map(item => cleanText(item, 220))
    .filter(Boolean)
    .slice(0, 8);
  const searchable = [reportNumber, eventType, reportSource, brandNames.join(" "), genericNames.join(" "), manufacturers.join(" "), deviceNames.join(" "), modelNumbers.join(" "), productProblems.join(" "), patientProblems.join(" ")].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.date_received || row.date_of_event || row.date_added || firstDevice.date_received) || new Date().toISOString();
  const riskLevel = adverseEventRiskLevel({
    eventType,
    productProblems: productProblems.join(" "),
    reactions: patientProblems.join(" "),
  });
  const product = brandNames[0] || deviceNames[0] || genericNames[0] || keyword;
  return {
    url: reportNumber ? `https://api.fda.gov/device/event.json?search=report_number:${encodeURIComponent(reportNumber)}` : "https://open.fda.gov/apis/device/event/",
    title: `openFDA device adverse event: ${product}`,
    content: [
      reportNumber ? `Report number: ${reportNumber}.` : "",
      eventType ? `Event type: ${eventType}.` : "",
      manufacturers.length ? `Manufacturer: ${[...new Set(manufacturers)].join(", ")}.` : "",
      brandNames.length ? `Brand: ${[...new Set(brandNames)].join(", ")}.` : "",
      deviceNames.length ? `Device: ${[...new Set(deviceNames)].join(", ")}.` : "",
      genericNames.length ? `Generic: ${[...new Set(genericNames)].join(", ")}.` : "",
      modelNumbers.length ? `Model: ${[...new Set(modelNumbers)].join(", ")}.` : "",
      productProblems.length ? `Product problems: ${[...new Set(productProblems)].join(", ")}.` : "",
      patientProblems.length ? `Patient outcomes: ${[...new Set(patientProblems)].join(", ")}.` : "",
      reportSource ? `Source type: ${reportSource}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Food and Drug Administration",
    publishedAt,
    riskLevel,
    evidenceType: "public_product_safety_adverse_event",
    metrics: {
      source: target.key,
      source_family: "official",
      source_kind: "public_product_safety_adverse_event",
      collection_mode: "openfda_public_device_adverse_event_json",
      adverse_event_record_source: target.name,
      adverse_event_category: target.category,
      adverse_event_id: reportNumber,
      adverse_event_product: product,
      adverse_event_brand_names: [...new Set(brandNames)],
      adverse_event_generic_names: [...new Set(genericNames)],
      adverse_event_manufacturers: [...new Set(manufacturers)],
      adverse_event_device_names: [...new Set(deviceNames)],
      adverse_event_model_numbers: [...new Set(modelNumbers)],
      adverse_event_product_problems: [...new Set(productProblems)],
      adverse_event_patient_outcomes: [...new Set(patientProblems)],
      adverse_event_type: eventType,
      adverse_event_source_type: reportSource,
      source_weight_tier: "regulatory-adverse-event",
    },
  };
}

function normalizeOpenFdaTobaccoProblemReport(row = {}, keyword = "", target = OPENFDA_ADVERSE_EVENT_TARGETS[2]) {
  const reportId = cleanText(row.report_id || row.reportId || "", 120);
  const dateSubmitted = cleanText(row.date_submitted || row.dateSubmitted || "", 80);
  const tobaccoProducts = Array.isArray(row.tobacco_products) ? row.tobacco_products.map(item => cleanText(item, 260)).filter(Boolean).slice(0, 10) : [];
  const healthProblems = Array.isArray(row.reported_health_problems) ? row.reported_health_problems.map(item => cleanText(item, 220)).filter(Boolean).slice(0, 12) : [];
  const productProblems = Array.isArray(row.reported_product_problems) ? row.reported_product_problems.map(item => cleanText(item, 220)).filter(Boolean).slice(0, 12) : [];
  const nonuserAffected = cleanText(row.nonuser_affected || "", 60);
  const numberHealthProblems = Number(row.number_health_problems || healthProblems.length || 0);
  const numberProductProblems = Number(row.number_product_problems || productProblems.length || 0);
  const numberTobaccoProducts = Number(row.number_tobacco_products || tobaccoProducts.length || 0);
  const searchable = [reportId, dateSubmitted, tobaccoProducts.join(" "), healthProblems.join(" "), productProblems.join(" "), nonuserAffected].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeMdyDate(dateSubmitted) || normalizeDate(dateSubmitted) || new Date().toISOString();
  const riskLevel = adverseEventRiskLevel({
    reactions: healthProblems.join(" "),
    productProblems: productProblems.join(" "),
  });
  const product = tobaccoProducts[0] || keyword;
  return {
    url: reportId ? `https://api.fda.gov/tobacco/problem.json?search=report_id:${encodeURIComponent(reportId)}` : "https://open.fda.gov/apis/tobacco/problem/",
    title: `openFDA tobacco problem report: ${product}`,
    content: [
      reportId ? `Report ID: ${reportId}.` : "",
      dateSubmitted ? `Date submitted: ${dateSubmitted}.` : "",
      tobaccoProducts.length ? `Tobacco product: ${[...new Set(tobaccoProducts)].join(", ")}.` : "",
      healthProblems.length ? `Reported health problems: ${[...new Set(healthProblems)].join(", ")}.` : "",
      productProblems.length ? `Reported product problems: ${[...new Set(productProblems)].join(", ")}.` : "",
      nonuserAffected ? `Non-user affected: ${nonuserAffected}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Food and Drug Administration",
    publishedAt,
    riskLevel,
    evidenceType: "public_product_safety_adverse_event",
    metrics: {
      source: target.key,
      source_family: "official",
      source_kind: "public_product_safety_adverse_event",
      collection_mode: "openfda_public_tobacco_problem_report_json",
      adverse_event_record_source: target.name,
      adverse_event_category: target.category,
      adverse_event_id: reportId,
      adverse_event_product: product,
      adverse_event_tobacco_products: [...new Set(tobaccoProducts)],
      adverse_event_health_problems: [...new Set(healthProblems)],
      adverse_event_product_problems: [...new Set(productProblems)],
      adverse_event_nonuser_affected: nonuserAffected,
      adverse_event_health_problem_count: Number.isFinite(numberHealthProblems) ? numberHealthProblems : healthProblems.length,
      adverse_event_product_problem_count: Number.isFinite(numberProductProblems) ? numberProductProblems : productProblems.length,
      adverse_event_tobacco_product_count: Number.isFinite(numberTobaccoProducts) ? numberTobaccoProducts : tobaccoProducts.length,
      source_weight_tier: "regulatory-adverse-event",
    },
  };
}

function parseOpenFdaAdverseEventResults(payload = {}, keyword = "", { target = OPENFDA_ADVERSE_EVENT_TARGETS[0], limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  const isDevice = target.kind === "openfda_device_adverse_events" || target.key === "openfda_device_adverse_events";
  const isTobacco = target.kind === "openfda_tobacco_problem_reports" || target.key === "openfda_tobacco_problem_reports";
  for (const row of rows) {
    const item = isTobacco
      ? normalizeOpenFdaTobaccoProblemReport(row, keyword, target)
      : isDevice
        ? normalizeOpenFdaDeviceAdverseEvent(row, keyword, target)
        : normalizeOpenFdaDrugAdverseEvent(row, keyword, target);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `${item.metrics.source}:${item.metrics.adverse_event_id || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeEuSafetyGateRecall(row = {}, keyword = "") {
  const fields = row?.fields || row || {};
  const alertNumber = cleanText(fields.alert_number || row.recordid, 100);
  const brand = cleanText(fields.product_brand, 220);
  const productName = cleanText(fields.product_name, 260);
  const productType = cleanText(fields.product_type, 260);
  const category = cleanText(fields.product_category || fields.oecd_portal_category, 260);
  const alertLevel = cleanText(fields.alert_level, 120);
  const alertCountry = cleanText(fields.alert_country, 120);
  const productCountry = cleanText(fields.product_country, 160);
  const riskType = Array.isArray(fields.alert_type) ? fields.alert_type.map(item => cleanText(item, 120)).filter(Boolean).join(", ") : cleanText(fields.alert_type, 260);
  const description = cleanText(fields.alert_description || fields.product_description, 1000);
  const legalProvision = cleanText(fields.risk_legal_provision, 1000);
  const measures = cleanText(fields.measures_country || fields.measures || fields.compulsory_measures || fields.voluntary_measures, 800);
  const batch = cleanText(fields.product_batch_number || fields.batch_number, 180);
  const searchable = [alertNumber, brand, productName, productType, category, alertLevel, alertCountry, productCountry, riskType, description, legalProvision, measures, batch].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(fields.alert_date || row.record_timestamp) || new Date().toISOString();
  return {
    url: fields.rapex_url || (alertNumber ? `https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/${encodeURIComponent(alertNumber)}` : "https://ec.europa.eu/safety-gate-alerts/screen/search"),
    title: `EU Safety Gate recall: ${brand || productName || productType || alertNumber || keyword}`,
    content: [
      productName ? `Product: ${productName}.` : "",
      productType ? `Product type: ${productType}.` : "",
      category ? `Category: ${category}.` : "",
      brand ? `Brand: ${brand}.` : "",
      alertLevel ? `Alert level: ${alertLevel}.` : "",
      riskType ? `Risk type: ${riskType}.` : "",
      alertCountry ? `Alert country: ${alertCountry}.` : "",
      productCountry ? `Country of origin: ${productCountry}.` : "",
      description,
      legalProvision ? `Legal/risk provision: ${legalProvision}.` : "",
      measures ? `Measures: ${measures}.` : "",
      batch ? `Batch/model: ${batch}.` : "",
    ].filter(Boolean).join(" "),
    author: "European Commission Safety Gate",
    publishedAt,
    riskLevel: recallRiskLevel({ classification: alertLevel, hazard: riskType, reason: `${description} ${legalProvision} ${measures}` }),
    metrics: {
      source: "eu_safety_gate_rapex",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "eu_safety_gate_public_opendata_json",
      recall_record_source: "EU Safety Gate RAPEX",
      recall_category: "non_food_product",
      recall_number: alertNumber,
      recall_firm: brand,
      recall_product: productName || productType,
      recall_reason: legalProvision || description,
      recall_classification: alertLevel,
      recall_status: measures,
      recall_distribution: alertCountry,
      recall_hazard: riskType,
      recall_country_of_origin: productCountry,
      recall_product_category: category,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseEuSafetyGateRecallResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.records) ? payload.records : Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeEuSafetyGateRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `eu_safety_gate:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeNhtsaRecall(row = {}, keyword = "") {
  const nhtsaId = cleanText(row.nhtsa_id, 80);
  const manufacturer = cleanText(row.manufacturer, 260);
  const subject = cleanText(row.subject, 360);
  const component = cleanText(row.component, 220);
  const campaignNumber = cleanText(row.mfr_campaign_number, 120);
  const recallType = cleanText(row.recall_type, 120);
  const affected = cleanText(row.potentially_affected, 80);
  const defect = cleanText(row.defect_summary, 1200);
  const consequence = cleanText(row.consequence_summary, 1200);
  const correctiveAction = cleanText(row.corrective_action, 1000);
  const fireRisk = cleanText(row.fire_risk_when_parked, 40);
  const doNotDrive = cleanText(row.do_not_drive, 40);
  const searchable = [nhtsaId, manufacturer, subject, component, campaignNumber, recallType, affected, defect, consequence, correctiveAction, fireRisk, doNotDrive].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.report_received_date) || new Date().toISOString();
  const recallUrl = row.recall_link?.url || (nhtsaId ? `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(nhtsaId)}` : "https://www.nhtsa.gov/recalls");
  return {
    url: recallUrl,
    title: `NHTSA vehicle recall: ${manufacturer || keyword}${subject ? ` - ${subject}` : ""}`,
    content: [
      nhtsaId ? `NHTSA ID: ${nhtsaId}.` : "",
      component ? `Component: ${component}.` : "",
      recallType ? `Recall type: ${recallType}.` : "",
      affected ? `Potentially affected: ${affected}.` : "",
      defect ? `Defect: ${defect}.` : "",
      consequence ? `Consequence: ${consequence}.` : "",
      correctiveAction ? `Corrective action: ${correctiveAction}.` : "",
      fireRisk ? `Fire risk when parked: ${fireRisk}.` : "",
      doNotDrive ? `Do not drive: ${doNotDrive}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. National Highway Traffic Safety Administration",
    publishedAt,
    riskLevel: recallRiskLevel({
      classification: recallType,
      hazard: `${component} ${fireRisk === "Yes" ? "fire" : ""} ${doNotDrive === "Yes" ? "do not drive" : ""}`,
      reason: `${defect} ${consequence} ${correctiveAction}`,
      injuries: consequence,
    }),
    metrics: {
      source: "nhtsa_recalls_by_manufacturer",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "nhtsa_public_recalls_socrata_json",
      recall_record_source: "NHTSA Recalls by Manufacturer",
      recall_category: "vehicle",
      recall_number: nhtsaId,
      recall_firm: manufacturer,
      recall_product: subject,
      recall_reason: defect,
      recall_classification: recallType,
      recall_status: correctiveAction,
      recall_hazard: consequence || component,
      recall_component: component,
      recall_campaign_number: campaignNumber,
      recall_potentially_affected: affected,
      recall_fire_risk_when_parked: fireRisk,
      recall_do_not_drive: doNotDrive,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseNhtsaRecallResults(payload = [], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeNhtsaRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `nhtsa:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeNhtsaComplaint(row = {}, keyword = "") {
  const odiNumber = cleanText(row.odiNumber || row.odi_number, 80);
  const manufacturer = cleanText(row.manufacturer, 260);
  const components = cleanText(row.components, 360);
  const summary = cleanText(row.summary, 1800);
  const dateFiled = cleanText(row.dateComplaintFiled || row.date_complaint_filed, 80);
  const dateIncident = cleanText(row.dateOfIncident || row.date_of_incident, 80);
  const vin = cleanText(row.vin, 80);
  const crash = Boolean(row.crash === true || String(row.crash).toLowerCase() === "true");
  const fire = Boolean(row.fire === true || String(row.fire).toLowerCase() === "true");
  const injuries = cleanText(row.numberOfInjuries ?? row.number_of_injuries ?? "", 40);
  const deaths = cleanText(row.numberOfDeaths ?? row.number_of_deaths ?? "", 40);
  const products = Array.isArray(row.products) ? row.products : [];
  const product = products[0] || {};
  const productYear = cleanText(product.productYear || product.product_year, 20);
  const productMake = cleanText(product.productMake || product.product_make, 120);
  const productModel = cleanText(product.productModel || product.product_model, 160);
  const searchable = [odiNumber, manufacturer, components, summary, vin, productYear, productMake, productModel].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(dateFiled || dateIncident) || new Date().toISOString();
  const riskLevel = recallRiskLevel({
    classification: crash ? "crash" : "",
    hazard: `${components} ${fire ? "fire" : ""}`,
    reason: summary,
    injuries: `${injuries} ${deaths}`,
  });
  return {
    url: odiNumber ? `https://www.nhtsa.gov/?nhtsaId=${encodeURIComponent(odiNumber)}` : "https://www.nhtsa.gov/report-a-safety-problem",
    title: `NHTSA vehicle complaint: ${productMake || manufacturer || keyword} ${productModel || ""}${productYear ? ` ${productYear}` : ""}`.replace(/\s+/g, " ").trim(),
    content: [
      odiNumber ? `ODI number: ${odiNumber}.` : "",
      components ? `Components: ${components}.` : "",
      summary,
      crash ? "Crash reported: yes." : "",
      fire ? "Fire reported: yes." : "",
      injuries ? `Number of injuries: ${injuries}.` : "",
      deaths ? `Number of deaths: ${deaths}.` : "",
      dateIncident ? `Date of incident: ${dateIncident}.` : "",
      vin ? `VIN prefix: ${vin}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. National Highway Traffic Safety Administration",
    publishedAt,
    riskLevel,
    evidenceType: "public_product_safety_complaint",
    metrics: {
      source: "nhtsa_vehicle_complaints",
      source_family: "official",
      source_kind: "public_product_safety_complaint",
      collection_mode: "nhtsa_public_complaints_api",
      complaint_record_source: "NHTSA Vehicle Complaints",
      complaint_category: "vehicle",
      complaint_id: odiNumber,
      complaint_manufacturer: manufacturer,
      complaint_components: components,
      complaint_crash: crash,
      complaint_fire: fire,
      complaint_injuries: injuries,
      complaint_deaths: deaths,
      complaint_product_year: productYear,
      complaint_product_make: productMake,
      complaint_product_model: productModel,
      complaint_date_incident: dateIncident,
      complaint_date_filed: dateFiled,
      source_weight_tier: "regulatory-complaint",
    },
  };
}

function parseNhtsaComplaintResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeNhtsaComplaint(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `nhtsa-complaint:${item.metrics.complaint_id || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function textLabelValue(text = "", labels = [], allLabels = []) {
  const source = cleanText(text, 2200);
  const escapedLabels = allLabels
    .map(label => String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  for (const label of labels) {
    const escaped = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nextPattern = escapedLabels.length ? `(?=\\s+(?:${escapedLabels.join("|")})\\s*:)` : "$";
    const match = source.match(new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)(?:${nextPattern}|$)`, "i"));
    if (match?.[1]) return cleanText(match[1], 420);
  }
  return "";
}

function hkCfsFoodAlertRiskLevel({ title = "", description = "" } = {}) {
  const text = `${title} ${description}`.toLowerCase();
  if (/not to consume|do not consume|allergen|undeclared|gluten|glass|plastic|fragment|cadmium|patulin|listeria|salmonella|e\.? coli|bacillus|excessive|contaminat|pesticide|formula|infant|poison|toxic|recall|injur|serious|過敏|过敏|玻璃|塑膠|塑料|鎘|镉|污染|召回|有毒/i.test(text)) return "high";
  if (/food alert|allergy alert|suspected|batch|best-before|importer|retailer|public/i.test(text)) return "medium";
  return "low";
}

function normalizeHkCfsFoodAlert(row = {}, keyword = "") {
  const title = cleanText(row.title, 520);
  const description = cleanDecodedHtml(row.description, 2200);
  const url = cleanText(row.link, 900) || HK_CFS_FOOD_ALERTS_RSS_URL;
  const labels = [
    "Product name",
    "Produce name",
    "Brand",
    "Place of origin",
    "Pack size",
    "Net weight",
    "Volume",
    "Importer",
    "Retailer",
    "Distributor",
    "Batch Number",
    "Batch number",
    "Batch numbers/use-by dates",
    "JAN code",
    "Manufacture date",
    "Best-before date",
    "Use-by date",
    "Quantity imported",
  ];
  const product = textLabelValue(description, ["Product name", "Produce name"], labels);
  const brand = textLabelValue(description, ["Brand"], labels);
  const origin = textLabelValue(description, ["Place of origin"], labels);
  const packSize = textLabelValue(description, ["Pack size", "Net weight", "Volume"], labels);
  const importer = textLabelValue(description, ["Importer"], labels);
  const retailer = textLabelValue(description, ["Retailer"], labels);
  const distributor = textLabelValue(description, ["Distributor"], labels);
  const batch = textLabelValue(description, ["Batch Number", "Batch number", "Batch numbers/use-by dates"], labels);
  const manufactureDate = textLabelValue(description, ["Manufacture date"], labels);
  const bestBefore = textLabelValue(description, ["Best-before date", "Use-by date"], labels);
  const searchable = [title, description, product, brand, origin, importer, retailer, distributor, batch, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  const firm = [importer, distributor, retailer].filter(Boolean).join("; ");
  return {
    url,
    title: `Hong Kong CFS food alert: ${title}`,
    content: [
      product ? `Product: ${product}.` : "",
      brand ? `Brand: ${brand}.` : "",
      origin ? `Place of origin: ${origin}.` : "",
      packSize ? `Pack size: ${packSize}.` : "",
      batch ? `Batch: ${batch}.` : "",
      manufactureDate ? `Manufacture date: ${manufactureDate}.` : "",
      bestBefore ? `Best-before/use-by date: ${bestBefore}.` : "",
      importer ? `Importer: ${importer}.` : "",
      distributor ? `Distributor: ${distributor}.` : "",
      retailer ? `Retailer: ${retailer}.` : "",
      description,
    ].filter(Boolean).join(" "),
    author: "Hong Kong Centre for Food Safety",
    publishedAt,
    riskLevel: hkCfsFoodAlertRiskLevel({ title, description }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "hk_cfs_food_alerts",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "hong_kong_cfs_public_food_alerts_rss",
      recall_record_source: "Hong Kong CFS Food Alert / Allergy Alerts",
      recall_category: "food_safety",
      recall_number: cleanText(row.guid, 160),
      recall_title: title,
      recall_firm: firm,
      recall_product: product || title,
      recall_product_category: "food_safety",
      recall_brand: brand,
      recall_country_of_origin: origin,
      recall_importer: importer,
      recall_distributor: distributor,
      recall_retailer: retailer,
      recall_pack_size: packSize,
      recall_batch: batch,
      recall_manufacture_date: manufactureDate,
      recall_best_before: bestBefore,
      recall_reason: title,
      recall_hazard: `${title} ${description}`,
      recall_status: "food-alert-or-allergy-alert",
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseHkCfsFoodAlertResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeHkCfsFoodAlert(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `hk-cfs-food-alert:${item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function taiwanFdaDate(value = "") {
  const raw = cleanText(value, 80);
  const match = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return normalizeDate(raw);
  const formatted = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T00:00:00.000Z`;
  const time = new Date(formatted).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function taiwanFdaDrugRecallRiskLevel({ recallClass = "", reason = "", product = "" } = {}) {
  const text = `${recallClass} ${reason} ${product}`.toLowerCase();
  if (/一級|第.?一級|class\s*i|污染|塑化劑|塑化剂|封膜|含量|效價|品質|质量|無菌|无菌|異物|异物|不純物|不纯物|gmp|紀錄填寫不實|伪造|偽造|停止生產|不得販賣|回收|用藥安全|安全/i.test(text)) return "high";
  if (/二級|第.?二級|2|第二級|標示|标签|包裝|包装|批號|批号|規格|规格|第三級|3/i.test(text)) return "medium";
  return "low";
}

function normalizeTaiwanFdaDrugRecall(row = {}, keyword = "") {
  const recallClass = cleanText(row["回收分級"], 120);
  const documentNumber = cleanText(row["文號"], 260);
  const date = cleanText(row["日期"], 80);
  const product = cleanText(row["產品"], 520);
  const licenseNumber = cleanText(row["許可證字號"], 160);
  const batch = cleanText(row["批號"], 520);
  const holder = cleanText(row["許可證持有者"], 260);
  const reason = cleanText(row["原因"], 1200);
  const searchable = [recallClass, documentNumber, date, product, licenseNumber, batch, holder, reason].join(" ");
  if (!product || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = taiwanFdaDate(date) || new Date().toISOString();
  return {
    url: TAIWAN_FDA_DRUG_RECALLS_JSON_URL,
    title: `Taiwan FDA drug recall: ${product}`,
    content: [
      recallClass ? `Recall class: ${recallClass}.` : "",
      documentNumber ? `Document number: ${documentNumber}.` : "",
      date ? `Date: ${date}.` : "",
      product ? `Product: ${product}.` : "",
      licenseNumber ? `License number: ${licenseNumber}.` : "",
      batch ? `Batch: ${batch}.` : "",
      holder ? `License holder: ${holder}.` : "",
      reason ? `Reason: ${reason}.` : "",
    ].filter(Boolean).join(" "),
    author: "Taiwan Food and Drug Administration",
    publishedAt,
    riskLevel: taiwanFdaDrugRecallRiskLevel({ recallClass, reason, product }),
    evidenceType: "public_product_drug_recall",
    metrics: {
      source: "taiwan_fda_drug_recalls",
      source_family: "official",
      source_kind: "public_product_drug_recall",
      collection_mode: "taiwan_fda_public_drug_recalls_json",
      recall_record_source: "Taiwan FDA Drug Recalls",
      recall_category: "drug",
      recall_number: documentNumber,
      recall_title: product,
      recall_firm: holder,
      recall_product: product,
      recall_product_category: "drug",
      recall_license_number: licenseNumber,
      recall_batch: batch,
      recall_reason: reason,
      recall_hazard: reason,
      recall_classification: recallClass,
      recall_status: "drug-recall",
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseTaiwanFdaDrugRecallResults(payload = [], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeTaiwanFdaDrugRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `taiwan-fda-drug-recall:${item.metrics.recall_number}:${item.metrics.recall_product}:${item.metrics.recall_batch}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function taiwanFdaFoodImportRiskLevel({ subject = "", reason = "", detail = "", standard = "" } = {}) {
  const text = `${subject} ${reason} ${detail} ${standard}`.toLowerCase();
  if (/不符規定|不符合|農藥殘留|農药残留|重金屬|重金属|鎘|镉|鉛|铅|汞|黃麴毒素|黄曲霉|aflatoxin|農藥|pesticide|溶出試驗|蒸發殘渣|防腐劑|二氧化硫|甜味劑|色素|微生物|大腸桿菌|沙門氏菌|salmonella|e\.? coli|listeria|退運|銷毀|销毁|第15條|第17條|污染|有毒|容器具/i.test(text)) return "high";
  if (/標示|標籤|标签|檢驗|限量|報驗|進口|抽驗|查驗|處置/i.test(text)) return "medium";
  return "low";
}

function normalizeTaiwanFdaNoncompliantFoodImport(row = {}, keyword = "") {
  const origin = cleanText(row["產地"], 160);
  const subject = cleanText(row["主旨"], 420);
  const reason = cleanText(row["原因"], 420);
  const importer = cleanText(row["進口商名稱"], 260);
  const importerAddress = cleanText(row["進口商地址"], 420);
  const commodityCode = cleanText(row["貨品分類號列"], 120);
  const testMethod = cleanText(row["檢驗方法"], 900);
  const detail = cleanText(row["不合格原因暨檢出量詳細說明"], 1200);
  const standard = cleanText(row["法規限量標準"], 1200);
  const manufacturer = cleanText(row["製造廠或出口商名稱"], 420);
  const manufacturerCode = cleanText(row["製造商代碼"], 160);
  const brand = cleanText(row["牌名"], 260);
  const weight = cleanText(row["重量"], 160);
  const disposition = cleanText(row["處置情形"], 520);
  const publishDate = cleanText(row["發布日期"], 80);
  const acceptedDate = cleanText(row["報驗受理日期"], 80);
  const imageUrl = cleanText(row["附圖"], 900);
  const searchable = [origin, subject, reason, importer, importerAddress, commodityCode, detail, standard, manufacturer, manufacturerCode, brand, weight, disposition, publishDate, acceptedDate, imageUrl].join(" ");
  if (!subject || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = taiwanFdaDate(publishDate) || taiwanFdaDate(acceptedDate) || new Date().toISOString();
  return {
    url: imageUrl || TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_JSON_URL,
    title: `Taiwan FDA non-compliant food import: ${subject}`,
    content: [
      subject ? `Subject: ${subject}.` : "",
      reason ? `Reason: ${reason}.` : "",
      origin ? `Place of origin: ${origin}.` : "",
      brand ? `Brand: ${brand}.` : "",
      importer ? `Importer: ${importer}.` : "",
      importerAddress ? `Importer address: ${importerAddress}.` : "",
      manufacturer ? `Manufacturer/exporter: ${manufacturer}.` : "",
      commodityCode ? `Commodity code: ${commodityCode}.` : "",
      weight ? `Weight: ${weight}.` : "",
      publishDate ? `Publish date: ${publishDate}.` : "",
      acceptedDate ? `Inspection accepted date: ${acceptedDate}.` : "",
      detail ? `Non-compliance detail: ${detail}.` : "",
      standard ? `Legal standard: ${standard}.` : "",
      disposition ? `Disposition: ${disposition}.` : "",
      testMethod ? `Test method: ${testMethod}.` : "",
    ].filter(Boolean).join(" "),
    author: "Taiwan Food and Drug Administration",
    publishedAt,
    riskLevel: taiwanFdaFoodImportRiskLevel({ subject, reason, detail, standard }),
    evidenceType: "public_product_import_refusal",
    metrics: {
      source: "taiwan_fda_noncompliant_food_imports",
      source_family: "official",
      source_kind: "public_product_import_refusal",
      collection_mode: "taiwan_fda_public_noncompliant_food_imports_json",
      import_refusal_record_source: "Taiwan FDA Non-compliant Food Imports",
      import_refusal_category: "food_import_noncompliance",
      import_refusal_product_description: subject,
      import_refusal_brand: brand,
      import_refusal_reason: reason,
      import_refusal_noncompliance_detail: detail,
      import_refusal_legal_standard: standard,
      import_refusal_importer: importer,
      import_refusal_importer_address: importerAddress,
      import_refusal_manufacturer: manufacturer,
      import_refusal_manufacturer_code: manufacturerCode,
      import_refusal_country: origin,
      import_refusal_product_code: commodityCode,
      import_refusal_weight: weight,
      import_refusal_disposition: disposition,
      import_refusal_date: publishDate,
      import_refusal_entry_date: acceptedDate,
      import_refusal_image_url: imageUrl,
      source_weight_tier: "regulatory-import-refusal",
    },
  };
}

function parseTaiwanFdaNoncompliantFoodImportResults(payload = [], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeTaiwanFdaNoncompliantFoodImport(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = [
      item.metrics.import_refusal_date,
      item.metrics.import_refusal_importer,
      item.metrics.import_refusal_product_description,
      item.metrics.import_refusal_noncompliance_detail,
    ].filter(Boolean).join(":") || item.url || item.title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function absoluteNewZealandProductSafetyUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.productsafety.govt.nz/${value.replace(/^\/+/, "")}`;
}

function newZealandProductSafetyRiskLevel({ title = "", categories = [] } = {}) {
  const text = `${title} ${(Array.isArray(categories) ? categories : []).join(" ")}`.toLowerCase();
  if (/fire|burn|overheat|electric shock|shock|choking|strangulation|suffocation|asphyxiation|laceration|injury|poison|toxic|chemical|lead|button battery|lithium|fall hazard|children|baby|infant|toy|cosmetic|health product|gas product|electric/i.test(text)) return "high";
  if (/recall|appliance|electronics|home|lifestyle|clothing|building|tool|equipment|machinery|sand product|sport|recreation/i.test(text)) return "medium";
  return "low";
}

function normalizeNewZealandProductSafetyRecallBlock(block = "", keyword = "") {
  const href = (String(block || "").match(/<a\b[^>]*href=["']([^"']*\/recalls\/[^"']+)["'][^>]*class=["'][^"']*recall__image-link/i)
    || String(block || "").match(/<a\b[^>]*class=["'][^"']*recall__image-link[^"']*["'][^>]*href=["']([^"']*\/recalls\/[^"']+)["']/i)
    || [])[1] || "";
  const url = absoluteNewZealandProductSafetyUrl(href);
  const dateText = cleanText((String(block || "").match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i) || [])[1] || "", 120)
    || cleanText((String(block || "").match(/<time\b[^>]*class=["'][^"']*recall__date[^"']*["'][^>]*>([\s\S]*?)<\/time>/i) || [])[1] || "", 120);
  const title = cleanText((String(block || "").match(/<h1\b[^>]*class=["'][^"']*recall__title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "", 520);
  const categories = [...String(block || "").matchAll(/<li\b[^>]*class=["'][^"']*recall__category[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi)]
    .map(match => cleanText(match[1], 180))
    .filter(Boolean);
  const imageUrl = absoluteNewZealandProductSafetyUrl((String(block || "").match(/\bdata-src=["']([^"']+)["']/i) || [])[1] || "");
  const searchable = [title, categories.join(" "), url].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(dateText) || new Date().toISOString();
  return {
    url,
    title: `New Zealand product safety recall: ${title}`,
    content: [
      title ? `Product: ${title}.` : "",
      categories.length ? `Categories: ${categories.join(", ")}.` : "",
      imageUrl ? `Image: ${imageUrl}.` : "",
    ].filter(Boolean).join(" "),
    author: "Product Safety New Zealand",
    publishedAt,
    riskLevel: newZealandProductSafetyRiskLevel({ title, categories }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "new_zealand_product_safety_recalls",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "new_zealand_product_safety_public_recalls_html",
      recall_record_source: "New Zealand Product Safety Recalls",
      recall_category: "consumer_product",
      recall_number: cleanText(url.split("/").filter(Boolean).pop(), 180),
      recall_title: title,
      recall_product: title,
      recall_product_category: categories.join(", "),
      recall_reason: title,
      recall_hazard: `${title} ${categories.join(" ")}`,
      recall_status: "product-safety-recall",
      recall_image_url: imageUrl,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseNewZealandProductSafetyRecallResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const blockRegex = /<article\b[^>]*class=["'][^"']*\brecall\b[^"']*["'][^>]*>[\s\S]*?<\/article>/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const item = normalizeNewZealandProductSafetyRecallBlock(match[0], keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `new-zealand-product-safety:${item.url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function absoluteMedsafeMordUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.medsafe.govt.nz/hot/recalls/${value.replace(/^\/+/, "")}`;
}

function medsafeMordFormDate(value = "") {
  const normalized = normalizeDate(value);
  if (!normalized) return "1 Jul 2012";
  const date = new Date(normalized);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function medsafeMordSearchBody(keyword = "", { since = "" } = {}) {
  const body = new URLSearchParams();
  body.set("optType", "All");
  body.set("txtName", cleanText(keyword, 160));
  body.set("Ingredients", "");
  body.set("txtDateFrom", medsafeMordFormDate(since));
  body.set("txtDateTo", "");
  body.set("cmdSearch", "Search");
  return body.toString();
}

function medsafeMordRiskLevel({ product = "", action = "", issue = "", actionType = "", productType = "", models = "", affected = "" } = {}) {
  const text = `${product} ${action} ${issue} ${actionType} ${productType} ${models} ${affected}`.toLowerCase();
  if (/recall|returned|return to supplier|destroy|exchange|replace|modify|modified|correct|defib|ventilator|infusion|pump|catheter|heart valve|implant|sterile|sterility|contamination|infection|serious|death|patient|software/i.test(text)) return "high";
  if (/advice|instructions|ifu|upgrade|medical|device|medicine|pharma|use updated|supplier/i.test(text)) return "medium";
  return "low";
}

function medsafeMordProductCategory({ product = "", action = "", productType = "", models = "" } = {}) {
  const text = `${product} ${action} ${productType} ${models}`.toLowerCase();
  if (/\bmedicine\b|medicinal|drug|pharma/i.test(productType)) return "medicine";
  if (/\bdevice\b|medical device/i.test(productType)) return "medical_device";
  if (/device|system|pump|catheter|defib|x-ray|xray|implant|valve|dressing|software|monitor|syringe|tube|stent|scanner|analyser|analyzer|ventilator|medical/i.test(text)) return "medical_device";
  if (/tablet|capsule|injection|infusion|vaccine|syrup|suspension|medicine|drug|pharma|mg|ml/i.test(text)) return "medicine";
  return "health_product";
}

function medsafeDetailFieldKey(label = "") {
  const normalized = cleanText(label, 120).replace(/:$/, "").toLowerCase();
  const aliases = {
    "type of product": "productType",
    "medsafe reference": "medsafeReference",
    "brand name": "brandNames",
    "model": "models",
    "affected": "affected",
    "software version": "softwareVersions",
    "recalling organisation": "recallingOrganisations",
    "contact information": "contactInformation",
    "manufacturer": "manufacturers",
    "issue": "issue",
    "recall action type": "recallActionType",
    "recall action": "recallAction",
    "level of recall": "levelOfRecall",
    "date commenced": "dateCommenced",
  };
  return aliases[normalized] || "";
}

function uniqueMedsafeValues(values = [], maxItems = 12) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const cleaned = cleanText(value, 700);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseMedsafeMordDetail(html = "") {
  const fields = {};
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(String(html || ""))) !== null) {
    const rowHtml = match[1] || "";
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)(?:<\/td>|<\/th>)/gi)].map(cellMatch => cellMatch[1] || "");
    if (cells.length < 2) continue;
    const key = medsafeDetailFieldKey(cells[0]);
    if (!key) continue;
    const value = cleanText(cells[1], 900);
    if (!value) continue;
    if (!fields[key]) fields[key] = [];
    fields[key].push(value);
  }
  const getOne = key => uniqueMedsafeValues(fields[key] || [], 1)[0] || "";
  const getMany = key => uniqueMedsafeValues(fields[key] || []);
  return {
    productType: getOne("productType"),
    medsafeReference: getOne("medsafeReference"),
    brandNames: getMany("brandNames"),
    models: getMany("models"),
    affected: getMany("affected"),
    softwareVersions: getMany("softwareVersions"),
    recallingOrganisations: getMany("recallingOrganisations"),
    contactInformation: getMany("contactInformation"),
    manufacturers: getMany("manufacturers"),
    issue: getOne("issue"),
    recallActionType: getOne("recallActionType"),
    recallAction: getOne("recallAction"),
    levelOfRecall: getOne("levelOfRecall"),
    dateCommenced: getOne("dateCommenced"),
  };
}

function mergeMedsafeMordDetail(item = {}, detail = {}) {
  if (!item || !detail || !Object.values(detail).some(value => Array.isArray(value) ? value.length : value)) return item;
  const product = cleanText(item.metrics?.recall_product || item.title, 520);
  const models = detail.models.join("; ");
  const affected = detail.affected.join("; ");
  const action = detail.recallAction || item.metrics?.recall_status || item.metrics?.recall_reason || "";
  const issue = detail.issue || item.metrics?.recall_reason || "";
  const category = medsafeMordProductCategory({
    product,
    action,
    productType: detail.productType,
    models,
  });
  const contentParts = [
    item.content,
    detail.productType ? `Type of product: ${detail.productType}.` : "",
    detail.brandNames.length ? `Brand names: ${detail.brandNames.join("; ")}.` : "",
    models ? `Models: ${models}.` : "",
    affected ? `Affected: ${affected}.` : "",
    detail.softwareVersions.length ? `Software versions: ${detail.softwareVersions.join("; ")}.` : "",
    detail.recallingOrganisations.length ? `Recalling organisation: ${detail.recallingOrganisations.join("; ")}.` : "",
    detail.manufacturers.length ? `Manufacturer: ${detail.manufacturers.join("; ")}.` : "",
    issue ? `Issue: ${issue}.` : "",
    detail.recallActionType ? `Recall action type: ${detail.recallActionType}.` : "",
    detail.levelOfRecall ? `Level of recall: ${detail.levelOfRecall}.` : "",
    detail.contactInformation.length ? `Contact: ${detail.contactInformation.join("; ")}.` : "",
  ].filter(Boolean);
  return {
    ...item,
    content: contentParts.join(" "),
    publishedAt: normalizeDmyDate(detail.dateCommenced) || item.publishedAt,
    riskLevel: medsafeMordRiskLevel({
      product,
      action,
      issue,
      actionType: detail.recallActionType,
      productType: detail.productType,
      models,
      affected,
    }),
    metrics: {
      ...item.metrics,
      recall_category: category,
      recall_number: detail.medsafeReference || item.metrics?.recall_number,
      recall_product_category: category,
      recall_product_type: detail.productType,
      recall_brand_names: detail.brandNames,
      recall_models: detail.models,
      recall_affected: detail.affected,
      recall_software_versions: detail.softwareVersions,
      recall_firm: detail.recallingOrganisations.join("; ") || item.metrics?.recall_firm,
      recall_contact: detail.contactInformation.join("; "),
      recall_manufacturer: detail.manufacturers.join("; "),
      recall_issue: detail.issue,
      recall_reason: detail.issue || item.metrics?.recall_reason,
      recall_hazard: detail.issue || item.metrics?.recall_hazard,
      recall_action_type: detail.recallActionType,
      recall_status: detail.recallAction || item.metrics?.recall_status,
      recall_level: detail.levelOfRecall,
      recall_date: detail.dateCommenced || item.metrics?.recall_date,
    },
  };
}

function normalizeMedsafeMordRow(cells = [], rowHtml = "", keyword = "") {
  if (!Array.isArray(cells) || cells.length < 3) return null;
  const commencementDate = cleanText(cells[0], 80);
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(commencementDate)) return null;
  const productCell = String(cells[1] || "");
  const linkMatch = productCell.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const url = absoluteMedsafeMordUrl(linkMatch?.[1] || "");
  const product = cleanText(linkMatch?.[2] || cells[1], 520);
  const action = cleanText(cells[2], 520);
  const recordId = cleanText((url.match(/[?&]ID=([^&]+)/i) || [])[1] || "", 80);
  const searchable = [commencementDate, product, action, recordId, url].join(" ");
  if (!product || !url || !textMatchesKeyword(searchable, keyword)) return null;
  const category = medsafeMordProductCategory({ product, action });
  return {
    url,
    title: `New Zealand Medsafe recall action: ${product}`,
    content: [
      product ? `Product: ${product}.` : "",
      action ? `Recall action: ${action}.` : "",
      recordId ? `Medsafe reference: ${recordId}.` : "",
      commencementDate ? `Date commenced: ${commencementDate}.` : "",
    ].filter(Boolean).join(" "),
    author: "Medsafe New Zealand",
    publishedAt: normalizeDmyDate(commencementDate) || new Date().toISOString(),
    riskLevel: medsafeMordRiskLevel({ product, action }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "new_zealand_medsafe_mord",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "new_zealand_medsafe_mord_html",
      recall_record_source: "New Zealand Medsafe Online Recalls Database",
      recall_category: category,
      recall_number: recordId,
      recall_title: product,
      recall_product: product,
      recall_product_category: category,
      recall_reason: action,
      recall_hazard: action,
      recall_status: action,
      recall_date: commencementDate,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseMedsafeMordResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const rowHtml = match[1] || "";
    const item = normalizeMedsafeMordRow(extractHtmlTableCells(rowHtml), rowHtml, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `new-zealand-medsafe-mord:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function enrichMedsafeMordItems(items = [], { proxyUrl = "", failures = [], keyword = "" } = {}) {
  const out = [];
  for (const item of items) {
    if (!item?.url) {
      out.push(item);
      continue;
    }
    try {
      const res = await fetchPublicSource(item.url, {
        headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: "new_zealand_medsafe_mord_detail", message: httpFailure(res) });
        out.push(item);
        continue;
      }
      out.push(mergeMedsafeMordDetail(item, parseMedsafeMordDetail(await res.text())));
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "new_zealand_medsafe_mord_detail", message });
      console.warn(`[CRM/PublicProductRecall] Medsafe MORD 詳情抓取失敗 keyword=${keyword}: ${message}`);
      out.push(item);
    }
  }
  return out;
}

function absoluteFsanzUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.foodstandards.gov.au/${value.replace(/^\/+/, "")}`;
}

function fsanzFoodRecallRiskLevel({ title = "", problem = "", hazard = "", action = "" } = {}) {
  const text = `${title} ${problem} ${hazard} ${action}`.toLowerCase();
  if (/not eat|not drink|not consume|do not eat|do not drink|dispose|return the product|illness|injury|listeria|salmonella|e\.?\s*coli|stec|botulinum|norovirus|hepatitis|microbial|contaminat|undeclared allergen|allergen|peanut|milk|gluten|soy|egg|tree nut|sesame|sulphite|shellfish|foreign matter|plastic|glass|metal|shell fragment|chemical|nitrofurazone|excess alcohol|carbonation|mould|toxin|poison|召回|污染|過敏|过敏|有毒/i.test(text)) return "high";
  if (/recall|date marking|batch|best before|available for sale|retailer|refund|food safety|hazard|problem/i.test(text)) return "medium";
  return "low";
}

function fsanzDescriptionSection(descriptionText = "", labels = [], nextLabels = []) {
  for (const label of labels) {
    const value = textSectionBetween(descriptionText, label, nextLabels);
    if (value) return value.replace(/^[:\s]+/, "");
  }
  return "";
}

function normalizeFsanzFoodRecall(row = {}, keyword = "") {
  const title = cleanText(row.title, 520);
  const url = absoluteFsanzUrl(row.link) || FSANZ_FOOD_RECALLS_RSS_URL;
  const rawDescription = String(row.description || "");
  const descriptionText = cleanDecodedHtml(rawDescription, 5000);
  const labels = [
    "Date Marking",
    "Date marking",
    "Batch",
    "Problem",
    "Food safety hazard",
    "What to do",
    "For further information please contact",
    "Related Links",
    "Related links",
    "Page last updated",
  ];
  const salesScope = cleanText((descriptionText.match(/The products? (?:has|have) been available for sale[^.]*\./i) || descriptionText.match(/The products? (?:has|have) been sold[^.]*\./i) || [])[0] || "", 700);
  const dateMarking = fsanzDescriptionSection(descriptionText, ["Date Marking", "Date marking"], labels);
  const batch = fsanzDescriptionSection(descriptionText, ["Batch"], labels);
  const problem = fsanzDescriptionSection(descriptionText, ["Problem"], labels);
  const hazard = fsanzDescriptionSection(descriptionText, ["Food safety hazard"], labels);
  const action = fsanzDescriptionSection(descriptionText, ["What to do"], labels);
  const contact = fsanzDescriptionSection(descriptionText, ["For further information please contact"], labels);
  const imageUrl = absoluteFsanzUrl((rawDescription.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i) || rawDescription.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*photoswipe/i) || [])[1] || "");
  const pdfUrl = absoluteFsanzUrl((rawDescription.match(/<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i) || [])[1] || "");
  const searchable = [title, descriptionText, salesScope, dateMarking, batch, problem, hazard, action, contact, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  const firm = cleanText((title.match(/^(.+?)\s+-\s+/) || [])[1] || "", 260);
  const product = cleanText(title.replace(/^.+?\s+-\s+/, ""), 420) || title;
  return {
    url,
    title: `FSANZ food recall: ${title}`,
    content: [
      firm ? `Firm: ${firm}.` : "",
      product ? `Product: ${product}.` : "",
      salesScope ? `Sales scope: ${salesScope}.` : "",
      dateMarking ? `Date marking: ${dateMarking}.` : "",
      batch ? `Batch: ${batch}.` : "",
      problem ? `Problem: ${problem}.` : "",
      hazard ? `Food safety hazard: ${hazard}.` : "",
      action ? `Consumer action: ${action}.` : "",
      contact ? `Contact: ${contact}.` : "",
      pdfUrl ? `Recall notice PDF: ${pdfUrl}.` : "",
    ].filter(Boolean).join(" "),
    author: "Food Standards Australia New Zealand",
    publishedAt,
    riskLevel: fsanzFoodRecallRiskLevel({ title, problem, hazard, action }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "fsanz_food_recalls",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "fsanz_public_food_recalls_rss",
      recall_record_source: "FSANZ Food Recalls",
      recall_category: "food_safety",
      recall_number: cleanText(row.guid, 180),
      recall_title: title,
      recall_firm: firm,
      recall_product: product,
      recall_product_category: "food_safety",
      recall_distribution: salesScope,
      recall_date_marking: dateMarking,
      recall_batch: batch,
      recall_reason: problem || descriptionText,
      recall_hazard: hazard || problem,
      recall_status: action,
      recall_contact: contact,
      recall_image_url: imageUrl,
      recall_pdf_url: pdfUrl,
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseFsanzFoodRecallResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeFsanzFoodRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `fsanz-food-recall:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function euRasffConsumerRiskLevel({ subject = "", description = "" } = {}) {
  const text = `${subject} ${description}`.toLowerCase();
  if (/recall|listeria|salmonella|e\.?\s*coli|stec|vtec|verotoxin|shigatoxin|norovirus|hepatitis|botulinum|microbial|enterotoxin|toxin|aflatoxin|ochratoxin|pahs|mercury|lead|cadmium|arsenic|pesticide|chlorpyrifos|ethylene oxide|hydrocyanic|sildenafil|pharmacologically active|unauthori[sz]ed|undeclared|allergen|soya|soy|peanut|milk|casein|gluten|sulphite|wheat|almond|fish|foreign bod|foreign object|plastic|glass|metal|contaminat|mould|spoilage|serious|illness|injury|召回|沙門氏菌|李斯特|大腸桿菌|污染|過敏|重金屬|农药|農藥/i.test(text)) return "high";
  if (/incorrect|label|labelling|date|minimum durability|notified|food|feed|consumer|migration|additive|residue|mrl/i.test(text)) return "medium";
  return "low";
}

function normalizeEuRasffConsumerNotification(row = {}, keyword = "") {
  const title = cleanText(row.title, 700);
  const description = cleanText(row.description, 420);
  const match = title.match(/^([0-9]{4}\.[0-9]+)\s*-\s*(.+)$/);
  const notificationNumber = cleanText(match?.[1] || "", 80);
  const subject = cleanText(match?.[2] || title, 620);
  const id = cleanText(row.link, 120);
  const notified = description.match(/Notified by\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const notifyingCountry = cleanText(notified?.[1] || "", 120);
  const notifiedDate = cleanText(notified?.[2] || "", 80);
  const searchable = [title, subject, description, notificationNumber, id, notifyingCountry].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDmyDate(notifiedDate) || normalizeDate(row.pubDate) || new Date().toISOString();
  const detailUrl = id
    ? `https://webgate.ec.europa.eu/rasff-window/screen/notification/${encodeURIComponent(id)}`
    : "https://webgate.ec.europa.eu/rasff-window/screen/consumers";
  const origin = cleanText((subject.match(/\bfrom\s+([^,;]+?)(?:\s+via\b|$)/i) || subject.match(/\borigin(?:ating)?\s+from\s+([^,;]+?)(?:\s+via\b|$)/i) || [])[1] || "", 180);
  const via = cleanText((subject.match(/\bvia\s+([^,;]+)$/i) || [])[1] || "", 180);
  return {
    url: detailUrl,
    title: `EU RASFF consumer notification: ${subject}`,
    content: [
      notificationNumber ? `Notification: ${notificationNumber}.` : "",
      subject ? `Subject: ${subject}.` : "",
      notifyingCountry ? `Notifying country: ${notifyingCountry}.` : "",
      origin ? `Origin: ${origin}.` : "",
      via ? `Via: ${via}.` : "",
      description ? `${description}.` : "",
    ].filter(Boolean).join(" "),
    author: "European Commission RASFF",
    publishedAt,
    riskLevel: euRasffConsumerRiskLevel({ subject, description }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "eu_rasff_consumer_notifications",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "eu_rasff_public_consumer_rss",
      recall_record_source: "EU RASFF Consumer Notifications",
      recall_category: "food_safety",
      recall_number: notificationNumber || id,
      recall_title: title,
      recall_product: subject,
      recall_product_category: "food_safety",
      recall_reason: subject,
      recall_hazard: subject,
      recall_status: "rasff-consumer-notification",
      recall_notifying_country: notifyingCountry,
      recall_country_of_origin: origin,
      recall_distribution: via,
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseEuRasffConsumerResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeEuRasffConsumerNotification(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `eu-rasff-consumer:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function absoluteJapanCaaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.recall.caa.go.jp/${value.replace(/^\/+/, "")}`;
}

function japanCaaRecallRiskLevel({ title = "", category = "" } = {}) {
  const text = `${title} ${category}`.toLowerCase();
  if (/火災|発火|爆発|感電|やけど|火傷|けが|怪我|死亡|重傷|窒息|誤飲|破損|転倒|事故|リチウム|電池|バッテリー|回収命令|食品|食料品|保健衛生品|車両|乗り物|修理|交換|回収|返金|recall|fire|burn|injury|battery|lithium|food|health|vehicle/i.test(text)) return "high";
  if (/注意喚起|お知らせ|無償|対応|部品|品質|不具合|欠陥|商品/i.test(text)) return "medium";
  return "low";
}

function normalizeJapanCaaRecallRow(cells = [], keyword = "") {
  if (!Array.isArray(cells) || cells.length < 5) return null;
  const category = cleanText(cells[0], 160);
  const imageUrl = absoluteJapanCaaUrl((String(cells[1] || "").match(/<img\b[^>]*src=["']([^"']+)["']/i) || String(cells[1] || "").match(/<a\b[^>]*href=["']([^"']+)["']/i) || [])[1] || "");
  const linkMatch = String(cells[2] || "").match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const url = absoluteJapanCaaUrl(linkMatch?.[1] || "");
  const title = cleanText(linkMatch?.[2] || cells[2], 700);
  const publishedAt = normalizeYmdSlashDate(cleanText(cells[3], 80)) || new Date().toISOString();
  const actionStartDate = cleanText(cells[4], 80);
  const recordId = cleanText((url.match(/[?&]rcl=([^&]+)/) || [])[1] || "", 120);
  const action = cleanText((title.match(/\s+-\s+(.+)$/) || [])[1] || "", 160);
  const product = cleanText(title.replace(/\s+-\s+.+$/, ""), 520) || title;
  const searchable = [title, product, category, action, recordId, url].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url,
    title: `Japan CAA recall: ${title}`,
    content: [
      product ? `Product: ${product}.` : "",
      category ? `Category: ${category}.` : "",
      action ? `Action: ${action}.` : "",
      recordId ? `Record ID: ${recordId}.` : "",
      actionStartDate ? `Action start date: ${actionStartDate}.` : "",
      imageUrl ? `Image: ${imageUrl}.` : "",
    ].filter(Boolean).join(" "),
    author: "Consumer Affairs Agency Japan",
    publishedAt,
    riskLevel: japanCaaRecallRiskLevel({ title, category }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "japan_caa_recalls",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "japan_caa_public_recalls_html",
      recall_record_source: "Japan CAA Recall Information",
      recall_category: cleanText(category || "consumer_product", 160),
      recall_number: recordId,
      recall_title: title,
      recall_product: product,
      recall_product_category: category,
      recall_reason: title,
      recall_hazard: title,
      recall_status: action,
      recall_action_start_date: actionStartDate,
      recall_image_url: imageUrl,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseJapanCaaRecallResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const cells = extractHtmlTableCells(match[1]);
    const item = normalizeJapanCaaRecallRow(cells, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `japan-caa-recall:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function absoluteKoreaSafetyUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.safetykorea.kr/${value.replace(/^\/+/, "")}`;
}

function koreaSafetyRecallRiskLevel({ product = "", model = "", company = "", recallType = "" } = {}) {
  const text = `${product} ${model} ${company} ${recallType}`.toLowerCase();
  if (/명령|리콜|회수|결함|불량|위해|위험|사고|화재|발화|폭발|감전|화상|부상|상해|질식|삼킴|중독|납|카드뮴|프탈레이트|전기|배터리|리튬|어린이|유아|아동|완구|recall|defect|hazard|fire|burn|injury|choking|electric|battery|lithium|children|baby|toy/i.test(text)) return "high";
  if (/자발|주의|안전|품질|수리|교환|환불|제품|model|barcode/i.test(text)) return "medium";
  return "low";
}

function normalizeKoreaSafetyRecallRow(cells = [], rowHtml = "", keyword = "") {
  if (!Array.isArray(cells) || cells.length < 8) return null;
  const rawRow = String(rowHtml || "");
  const recallUid = cleanText(
    (rawRow.match(/goDetail\(['"]([^'"]+)['"]\)/i)
      || rawRow.match(/name=["']recallUid["'][^>]*value=["']([^"']+)["']/i)
      || [])[1] || "",
    120,
  );
  if (!recallUid) return null;
  const sequenceNumber = cleanText(cells[0], 80);
  const imageUrl = absoluteKoreaSafetyUrl((String(cells[1] || "").match(/<img\b[^>]*src=["']([^"']+)["']/i) || [])[1] || "");
  const product = cleanText(cells[2], 520);
  const model = cleanText(cells[3], 520);
  const company = cleanText(cells[4], 240);
  const recallType = cleanText(cells[5], 160);
  const barcode = cleanText(cells[6], 160);
  const publishedAt = normalizeYmdSlashDate(cleanText(cells[7], 80)) || new Date().toISOString();
  const detailUrl = `https://www.safetykorea.kr/recall/ajax/recallBoard?recallUid=${encodeURIComponent(recallUid)}`;
  const searchable = [product, model, company, recallType, barcode, sequenceNumber, recallUid].join(" ");
  if (!product || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url: detailUrl,
    title: `Korea SafetyKorea recall: ${product}`,
    content: [
      product ? `Product: ${product}.` : "",
      model ? `Model: ${model}.` : "",
      company ? `Company: ${company}.` : "",
      recallType ? `Recall type: ${recallType}.` : "",
      barcode && barcode !== "-" ? `Barcode: ${barcode}.` : "",
      recallUid ? `Recall UID: ${recallUid}.` : "",
      imageUrl ? `Image: ${imageUrl}.` : "",
    ].filter(Boolean).join(" "),
    author: "Korea Product Safety Information Center",
    publishedAt,
    riskLevel: koreaSafetyRecallRiskLevel({ product, model, company, recallType }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "korea_safety_recalls",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "korea_safetykorea_public_recalls_html",
      recall_record_source: "Korea SafetyKorea Product Recalls",
      recall_category: "consumer_product",
      recall_number: recallUid,
      recall_sequence_number: sequenceNumber,
      recall_title: product,
      recall_product: product,
      recall_model: model,
      recall_firm: company,
      recall_product_category: "consumer_product",
      recall_reason: recallType,
      recall_hazard: recallType,
      recall_status: recallType,
      recall_barcode: barcode,
      recall_image_url: imageUrl,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseKoreaSafetyRecallResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const rowHtml = match[0];
    const cells = extractHtmlTableCells(match[1]);
    const item = normalizeKoreaSafetyRecallRow(cells, rowHtml, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `korea-safety-recall:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function koreaFoodSafetyRecallSearchBody(keyword = "", { searchType = "01", limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, startIndex = 1 } = {}) {
  return new URLSearchParams({
    show_cnt: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    start_idx: String(Math.max(1, Number(startIndex) || 1)),
    search_type: String(searchType || "01"),
    search_keyword: cleanText(keyword, 120),
  }).toString();
}

function koreaFoodSafetyRecallRiskLevel({ product = "", reason = "", foodType = "" } = {}) {
  const text = `${product} ${reason} ${foodType}`.toLowerCase();
  if (/대장균|살모넬라|리스테리아|노로|황색포도상구균|세균|미생물|곰팡이|부적합|검출|초과|기준|규격|회수|판매중지|식중독|알레르기|알러지|이물|금속|유리|플라스틱|카드뮴|납|수은|비소|농약|잔류|사카린|첨가물|독소|아플라톡신|e\\.?\\s*coli|salmonella|listeria|allergen|foreign|metal|glass|plastic|cadmium|lead|mercury|pesticide|toxin|recall/i.test(text)) return "high";
  if (/식품|가공식품|주류|제조|유통|소비기한|판매|위생|품질|회수사유/i.test(text)) return "medium";
  return "low";
}

function normalizeKoreaFoodSafetyRecallRow(row = {}, keyword = "") {
  if (!row || typeof row !== "object") return null;
  const recordId = cleanText(row.rtrvldsuse_seq, 120);
  const product = cleanText(row.prdtnm || row.prdlst_nm || row.product_name, 700);
  const company = cleanText(row.bsshnm || row.bsns_nm || row.company_name, 240);
  const reason = cleanText(row.rtrvlprvns || row.recall_reason, 700);
  const foodType = cleanText(row.food_type_nm || row.prdlst_report_ledg_no || "", 180);
  const manufactureDate = cleanText(row.mnfdt || row.mnf_dt || "", 120);
  const distributionLimit = cleanText(row.distbtmlmt || row.distb_tmlmt || "", 220);
  const address = cleanText(row.addr || row.adres || "", 260);
  const attachmentId = cleanText(row.atch_file_seq || "", 120);
  const commandDate = cleanText(row.rtrvl_cmmnddtm || row.hmpgpblict_prcsdtm || row.rtrvlconsd_dcsndtm || row.cret_dtm, 80);
  const publishedAt = normalizeDate(commandDate) || new Date().toISOString();
  const url = recordId
    ? `https://www.foodsafetykorea.go.kr/portalmobile/safeRecallView.do?rtrvldsuse_seq=${encodeURIComponent(recordId)}`
    : "https://www.foodsafetykorea.go.kr/portalmobile/safeRecallList.do";
  const searchable = [product, company, reason, foodType, manufactureDate, distributionLimit, address, recordId].join(" ");
  if (!product || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url,
    title: `Korea Food Safety recall/sale suspension: ${product}`,
    content: [
      product ? `Product: ${product}.` : "",
      company ? `Company: ${company}.` : "",
      reason ? `Reason: ${reason}.` : "",
      foodType ? `Food type: ${foodType}.` : "",
      manufactureDate ? `Manufacture date: ${manufactureDate}.` : "",
      distributionLimit ? `Distribution/use-by: ${distributionLimit}.` : "",
      address ? `Address: ${address}.` : "",
      recordId ? `Record ID: ${recordId}.` : "",
    ].filter(Boolean).join(" "),
    author: "Korea Food Safety",
    publishedAt,
    riskLevel: koreaFoodSafetyRecallRiskLevel({ product, reason, foodType }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "korea_food_safety_recalls",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "korea_food_safety_public_recalls_json",
      recall_record_source: "Korea Food Safety Recall/Sale Suspension",
      recall_category: "food_safety",
      recall_number: recordId,
      recall_title: product,
      recall_product: product,
      recall_product_category: foodType || "food_safety",
      recall_firm: company,
      recall_reason: reason,
      recall_hazard: reason,
      recall_status: "recall-sale-suspension",
      recall_manufacture_date: manufactureDate,
      recall_distribution: distributionLimit,
      recall_firm_address: address,
      recall_attachment_id: attachmentId,
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseKoreaFoodSafetyRecallResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.list) ? payload.list : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeKoreaFoodSafetyRecallRow(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `korea-food-safety-recall:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countKoreaFoodSafetyRecallRawResults(payload = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.list) ? payload.list : [];
  return rows.length;
}

function singaporeSfaFoodAlertRiskLevel({ title = "", description = "" } = {}) {
  const text = `${title} ${description}`.toLowerCase();
  if (/recall|cereulide|toxin|poison|listeria|salmonella|e\.?\s*coli|shigatoxin|bacillus|b\.?\s*cereus|mould|mold|spoilage|undeclared|allergen|milk|gluten|wheat|egg|sulphur dioxide|sulfur dioxide|foreign matter|glass|metal|plastic|rubber|rust|adulterated|tadalafil|not permitted|cyclamate|saccharin|exceeding|contamination|choking hazard|infant|baby|formula/i.test(text)) return "high";
  if (/food|alert|advisory|product|batch|expiry|origin|consumer/i.test(text)) return "medium";
  return "low";
}

function normalizeSingaporeSfaFoodAlert(row = {}, keyword = "") {
  const title = cleanText(row.title, 700);
  const description = cleanText(row.description, 1200);
  const guid = cleanText(row.guid, 160);
  const url = cleanText(row.link, 900);
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  const product = cleanText(
    (title.match(/^Recall of\s+(.+?)\s+due to\b/i)
      || title.match(/^Additional recall of\s+(.+?)\s+due to\b/i)
      || title.match(/^Recall of\s+(.+?)$/i)
      || [])[1] || title,
    520,
  );
  const reason = cleanText(
    (title.match(/\bdue to\s+(.+)$/i)
      || description.match(/\bdue to\s+(.+)$/i)
      || [])[1] || description || title,
    700,
  );
  const searchable = [title, description, product, reason, guid, url].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url,
    title: `Singapore SFA food alert/recall: ${title}`,
    content: [
      product ? `Product: ${product}.` : "",
      reason ? `Reason: ${reason}.` : "",
      description && description !== title ? `${description}.` : "",
      guid ? `Record ID: ${guid}.` : "",
    ].filter(Boolean).join(" "),
    author: "Singapore Food Agency",
    publishedAt,
    riskLevel: singaporeSfaFoodAlertRiskLevel({ title, description }),
    evidenceType: "public_product_food_safety_alert",
    metrics: {
      source: "singapore_sfa_food_alerts",
      source_family: "official",
      source_kind: "public_product_food_safety_alert",
      collection_mode: "singapore_sfa_public_food_alerts_rss",
      recall_record_source: "Singapore SFA Food Alerts and Recalls",
      recall_category: "food_safety",
      recall_number: guid,
      recall_title: title,
      recall_product: product,
      recall_product_category: "food_safety",
      recall_reason: reason,
      recall_hazard: reason,
      recall_status: /recall/i.test(title) ? "recall" : "food-alert",
      source_weight_tier: "public-health-alert",
    },
  };
}

function parseSingaporeSfaFoodAlertResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeSingaporeSfaFoodAlert(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `singapore-sfa-food-alert:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function absoluteNpraUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.npra.gov.my/${value.replace(/^\/+/, "")}`;
}

function malaysiaNpraProductCategory({ registrationNumber = "", activeIngredients = "", product = "" } = {}) {
  const text = `${registrationNumber} ${activeIngredients} ${product}`.toLowerCase();
  if (/\bmal\d+[a-z]*t[c]?\b|herb|radix|natural|traditional|complementary/i.test(text)) return "natural_product";
  if (/cosmetic|notified cosmetic/i.test(text)) return "cosmetic";
  if (/vaccine|plasma|biologic|serum|injection|tablet|capsule|syrup|suspension|cream|lotion|drops|pharmaceutical|mg|ml|w\/v/i.test(text)) return "drug";
  return "health_product";
}

function malaysiaNpraProductRecallRiskLevel({ degreeLevel = "", reason = "", activeIngredients = "" } = {}) {
  const text = `${degreeLevel} ${reason} ${activeIngredients}`.toLowerCase();
  if (/degree\s*i|serious|death|anaphylaxis|nitroso|nnort|cadmium|lead|microbial|mould|yeast|bile-tolerant|contamination|above allowable|impurit|failed|out[-\s]?of[-\s]?specification|dissolution|assay|stability|incorrect|mislabel|recall/i.test(text)) return "high";
  if (/degree\s*ii|voluntary|quality|defect|specification|point of sales|wholesaler|sub-distributor/i.test(text)) return "medium";
  return "low";
}

function normalizeMalaysiaNpraProductRecallRow(cells = [], rowHtml = "", keyword = "") {
  if (!Array.isArray(cells) || cells.length < 9) return null;
  const sequenceNumber = cleanText(cells[0], 80).replace(/\.$/, "");
  if (!/^\d+$/.test(sequenceNumber)) return null;
  const productCell = String(cells[1] || "");
  const documentUrl = absoluteNpraUrl((productCell.match(/<a\b[^>]*href=["']([^"']+)["']/i) || [])[1] || "");
  const product = cleanText(productCell, 520);
  const registrationNumber = cleanText(cells[2], 180);
  const activeIngredients = cleanText(cells[3], 520);
  const batchNumber = cleanText(cells[4], 520);
  const reason = cleanText(cells[5], 1000);
  const degreeLevel = cleanText(cells[6], 360);
  const registrationHolder = cleanText(cells[7], 300);
  const dateOfRecall = cleanText(cells[8], 120);
  const publishedAt = normalizeEnglishMonthDate(dateOfRecall) || new Date().toISOString();
  const searchable = [product, registrationNumber, activeIngredients, batchNumber, reason, degreeLevel, registrationHolder, dateOfRecall].join(" ");
  if (!product || !textMatchesKeyword(searchable, keyword)) return null;
  const category = malaysiaNpraProductCategory({ registrationNumber, activeIngredients, product });
  const url = documentUrl || MALAYSIA_NPRA_PRODUCT_RECALLS_URL;
  return {
    url,
    title: `Malaysia NPRA product recall: ${product}`,
    content: [
      product ? `Product: ${product}.` : "",
      registrationNumber ? `Registration number: ${registrationNumber}.` : "",
      activeIngredients ? `Active ingredients: ${activeIngredients}.` : "",
      batchNumber ? `Batch number: ${batchNumber}.` : "",
      reason ? `Reason: ${reason}.` : "",
      degreeLevel ? `Degree/level: ${degreeLevel}.` : "",
      registrationHolder ? `Registration holder: ${registrationHolder}.` : "",
      dateOfRecall ? `Date of recall: ${dateOfRecall}.` : "",
    ].filter(Boolean).join(" "),
    author: "Malaysia National Pharmaceutical Regulatory Agency",
    publishedAt,
    riskLevel: malaysiaNpraProductRecallRiskLevel({ degreeLevel, reason, activeIngredients }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "malaysia_npra_product_recalls",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "malaysia_npra_public_product_recalls_html",
      recall_record_source: "Malaysia NPRA Product Recalls",
      recall_category: category,
      recall_number: registrationNumber || `${sequenceNumber}:${product}`,
      recall_sequence_number: sequenceNumber,
      recall_title: product,
      recall_product: product,
      recall_product_category: category,
      recall_product_registration_number: registrationNumber,
      recall_active_ingredients: activeIngredients,
      recall_batch_number: batchNumber,
      recall_reason: reason,
      recall_hazard: reason,
      recall_status: degreeLevel,
      recall_class: degreeLevel,
      recall_firm: registrationHolder,
      recall_date: dateOfRecall,
      recall_document_url: documentUrl,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseMalaysiaNpraProductRecallResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  const source = String(html || "");
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const rowHtml = match[1] || "";
    const item = normalizeMalaysiaNpraProductRecallRow(extractHtmlTableCells(rowHtml), rowHtml, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `malaysia-npra-product-recall:${item.metrics.recall_number || item.url || item.title}:${item.metrics.recall_batch_number}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function absoluteMalaysiaMdaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value.replace("https://portal.mda.gov.my//", "https://portal.mda.gov.my/");
  return `https://portal.mda.gov.my/${value.replace(/^\/+/, "")}`;
}

function malaysiaMdaDeviceRecallRiskLevel({ recallClass = "", reason = "", product = "" } = {}) {
  const text = `${recallClass} ${reason} ${product}`.toLowerCase();
  if (/class\s*i|high risk|patient device interaction|death|serious|injury|malfunction|mechanical|material integrity|output problem|software|sterility|infection|contamination|labelling|instructions|recall/i.test(text)) return "high";
  if (/class\s*ii|moderate risk|manufacturing|packaging|shipping|voluntary|field safety|device|medical/i.test(text)) return "medium";
  return "low";
}

function normalizeMalaysiaMdaDeviceRecallRow(cells = [], feedItem = {}, keyword = "") {
  if (!Array.isArray(cells) || cells.length < 10) return null;
  const sequenceNumber = cleanText(cells[0], 80).replace(/\.$/, "");
  if (!/^\d+$/.test(sequenceNumber)) return null;
  const dateReceived = cleanText(cells[1], 80);
  const referenceCell = String(cells[2] || "");
  const referenceMatch = referenceCell.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const documentUrl = absoluteMalaysiaMdaUrl(referenceMatch?.[1] || "");
  const referenceNumber = cleanText(referenceMatch?.[2] || cells[2], 180);
  const recallType = cleanText(cells[3], 180);
  const product = cleanText(cells[4], 520);
  const registrationNumber = cleanText(cells[5], 180);
  const recallClass = cleanText(cells[6], 180);
  const reason = cleanText(cells[7], 520);
  const establishment = cleanText(cells[8], 260);
  const establishmentLicense = cleanText(cells[9], 180);
  const publishedAt = normalizeDmyDate(dateReceived) || normalizeDate(feedItem.pubDate) || new Date().toISOString();
  const url = documentUrl || cleanText(feedItem.link, 900);
  const searchable = [product, referenceNumber, registrationNumber, recallClass, reason, establishment, establishmentLicense, recallType, feedItem.title].join(" ");
  if (!product || !url || !textMatchesKeyword(searchable, keyword)) return null;
  return {
    url,
    title: `Malaysia MDA medical device recall: ${product}`,
    content: [
      product ? `Product: ${product}.` : "",
      referenceNumber ? `Reference: ${referenceNumber}.` : "",
      registrationNumber ? `Registration number: ${registrationNumber}.` : "",
      recallClass ? `Recall class: ${recallClass}.` : "",
      recallType ? `Recall type: ${recallType}.` : "",
      reason ? `Reason: ${reason}.` : "",
      establishment ? `Recalling establishment: ${establishment}.` : "",
      establishmentLicense ? `Establishment license: ${establishmentLicense}.` : "",
      feedItem.title ? `Listing: ${cleanText(feedItem.title, 220)}.` : "",
    ].filter(Boolean).join(" "),
    author: "Malaysia Medical Device Authority",
    publishedAt,
    riskLevel: malaysiaMdaDeviceRecallRiskLevel({ recallClass, reason, product }),
    evidenceType: "public_product_device_recall",
    metrics: {
      source: "malaysia_mda_device_recalls",
      source_family: "official",
      source_kind: "public_product_device_recall",
      collection_mode: "malaysia_mda_public_device_recalls_rss",
      recall_record_source: "Malaysia MDA Medical Device Recalls",
      recall_category: "medical_device",
      recall_number: referenceNumber,
      recall_sequence_number: sequenceNumber,
      recall_title: product,
      recall_product: product,
      recall_product_category: "medical_device",
      recall_product_registration_number: registrationNumber,
      recall_reason: reason,
      recall_hazard: reason,
      recall_status: recallType,
      recall_class: recallClass,
      recall_firm: establishment,
      recall_firm_license: establishmentLicense,
      recall_listing_title: cleanText(feedItem.title, 220),
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseMalaysiaMdaDeviceRecallResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const feedItem of rssItems(xml)) {
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(String(feedItem.descriptionHtml || feedItem.description || ""))) !== null) {
      const item = normalizeMalaysiaMdaDeviceRecallRow(extractHtmlTableCells(match[1]), feedItem, keyword);
      if (!item || !isAfterSince(item.publishedAt, since)) continue;
      const dedupeKey = `malaysia-mda-device-recall:${item.metrics.recall_number || item.url || item.title}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(item);
      if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) return out;
    }
  }
  return out;
}

function thailandFdaProductRecallRiskLevel({ title = "", description = "" } = {}) {
  const text = `${title} ${description}`.toLowerCase();
  if (/urgent|เร่งด่วน|เรียกคืน|เรียกเก็บคืน|ระงับการผลิต|ระงับการขาย|ปนเปื้อน|ปลอม|ไม่ได้รับอนุญาต|อันตราย|serious|injury|contamination|adulterated|unregistered|illegal|recall|withdraw/i.test(text)) return "high";
  if (/ยา|สมุนไพร|อาหาร|เครื่องสำอาง|medical|device|drug|herbal|food|cosmetic|product/i.test(text)) return "medium";
  return "low";
}

function thaiProductCategory(text = "") {
  const value = String(text || "");
  if (/สมุนไพร|herbal/i.test(value)) return "herbal_product";
  if (/ยา|drug|medicine/i.test(value)) return "drug";
  if (/อาหาร|food/i.test(value)) return "food_safety";
  if (/เครื่องสำอาง|cosmetic/i.test(value)) return "cosmetic";
  if (/medical|device|เครื่องมือแพทย์/i.test(value)) return "medical_device";
  return "health_product";
}

function extractThailandFdaProduct(text = "") {
  const source = cleanText(text, 1200);
  const parenMatch = source.match(/[（(]([^()（）]{2,180})[）)]/);
  if (parenMatch) return cleanText(parenMatch[1], 220);
  return source
    .replace(/แจ้งเตือนภัยเร่งด่วนการ/gi, " ")
    .replace(/แจ้งเตือนการ/gi, " ")
    .replace(/เรียกเก็บคืน|เรียกคืน|ระงับการผลิต|ระงับการขาย|ผลิตภัณฑ์/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function normalizeThailandFdaProductRecall(row = {}, keyword = "") {
  const title = cleanText(row.title, 520);
  const description = cleanText(row.description, 2000);
  const url = cleanText(row.link || row.guid, 900);
  const imageTitle = cleanText(row.imageTitle, 220);
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  const searchable = [title, description, url, imageTitle].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  const product = extractThailandFdaProduct(`${description || title} ${imageTitle}`);
  const category = thaiProductCategory(`${title} ${description} ${imageTitle}`);
  return {
    url,
    title: `Thailand FDA product recall: ${title}`,
    content: [
      description && description !== title ? `${description}.` : "",
      product ? `Product: ${product}.` : "",
      imageTitle ? `Attachment/image title: ${imageTitle}.` : "",
    ].filter(Boolean).join(" "),
    author: "Thailand FDA Safety Alert",
    publishedAt,
    riskLevel: thailandFdaProductRecallRiskLevel({ title, description }),
    evidenceType: "public_product_recall",
    metrics: {
      source: "thailand_fda_product_recalls",
      source_family: "official",
      source_kind: "public_product_recall",
      collection_mode: "thailand_fda_safety_alert_product_recalls_rss",
      recall_record_source: "Thailand FDA Safety Alert Product Recalls",
      recall_category: category,
      recall_number: cleanText(row.guid || url, 900),
      recall_title: title,
      recall_product: product,
      recall_product_category: category,
      recall_reason: description,
      recall_hazard: description,
      recall_status: /เรียกคืน|เรียกเก็บคืน|recall|withdraw/i.test(`${title} ${description}`) ? "recall" : "safety-alert",
      recall_attachment_title: imageTitle,
      source_weight_tier: "regulatory-alert",
    },
  };
}

function parseThailandFdaProductRecallResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeThailandFdaProductRecall(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `thailand-fda-product-recall:${item.metrics.recall_number || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeProductRecallDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeProductRecallDedupeUrl(embedded);
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

function productRecallDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const recallNumber = cleanText(metrics.recall_number || "", 260);
  if (recallNumber) return `recall:${recallNumber}`.toLowerCase();
  const source = cleanText(metrics.source || metrics.recall_record_source || "product-recall", 140).toLowerCase();
  const ids = [
    metrics.recall_source_guid,
    metrics.recall_sequence_number,
    metrics.recall_attachment_id,
    metrics.recall_product_registration_number && [metrics.recall_product_registration_number, metrics.recall_batch_number].filter(Boolean).join(":"),
    metrics.recall_event_id,
    metrics.recall_report_number,
    metrics.adverse_event_id,
    metrics.import_refusal_entry_id,
    metrics.nhtsa_campaign_number,
    metrics.nhtsa_complaint_id,
  ].map(value => cleanText(value || "", 260)).filter(Boolean);
  if (ids.length) return `${source}:${ids[0]}`.toLowerCase();
  const urlKey = normalizeProductRecallDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  return [source, cleanText(item.title || "", 260), cleanText(item.publishedAt || "", 80)].filter(Boolean).join(":").toLowerCase();
}

function productRecallKeywordMatchSource(item = {}, keyword = "") {
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["record_source", item.metrics?.recall_record_source],
    ["product", item.metrics?.recall_product || item.metrics?.recall_products],
    ["firm", item.metrics?.recall_firm],
    ["reason", item.metrics?.recall_reason || item.metrics?.recall_hazard],
    ["number", item.metrics?.recall_number],
  ];
  return fields.find(([, value]) => textMatchesKeyword(Array.isArray(value) ? value.join(" ") : value, keyword))?.[0] || "search_query";
}

function productRecallKeywordDiagnostics(item = {}, keyword = "") {
  return {
    product_recall_matched_keyword: cleanText(keyword, 160),
    product_recall_keyword_match_source: productRecallKeywordMatchSource(item, keyword),
  };
}

function productRecallRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const arrayText = value => Array.isArray(value) ? value.join(" ") : value;
  const text = cleanText([
    item.title,
    item.content,
    item.author,
    item.evidenceType,
    metrics.source,
    metrics.source_family,
    metrics.source_kind,
    metrics.recall_record_source,
    metrics.recall_category,
    metrics.recall_classification,
    metrics.recall_number,
    metrics.recall_title,
    metrics.recall_product,
    arrayText(metrics.recall_products),
    metrics.recall_firm,
    metrics.recall_reason,
    metrics.recall_hazard,
    metrics.recall_remedy,
    metrics.recall_incidents,
    metrics.recall_status,
    metrics.recall_distribution,
    metrics.recall_code_info,
    metrics.recall_batch,
    metrics.recall_batch_number,
    metrics.recall_action_type,
    metrics.recall_action,
    metrics.recall_problem,
    metrics.recall_hazard_type,
    metrics.adverse_event_type,
    metrics.adverse_event_reactions,
    metrics.adverse_event_product_problems,
    metrics.import_refusal_charges,
    metrics.import_refusal_charge_statements,
    metrics.source_weight_tier,
  ].filter(Boolean).join(" "), 10000).toLowerCase();
  const reasons = [];
  let score = /regulatory-alert|official/i.test(String(metrics.source_weight_tier || metrics.source_family || "")) ? 14 : 8;
  const out = {};
  const termMatches = (terms = []) => {
    const source = normalizeProductRecallKeywordText(text);
    return terms.filter(term => {
      const needle = normalizeProductRecallKeywordText(term);
      return needle && source.includes(needle);
    });
  };
  const evidenceTerms = termMatches([
    "recall number", "reference number", "lot", "batch", "code info", "model number", "serial number", "incident reports", "injury reports",
    "召回編號", "召回编号", "參考編號", "参考编号", "批號", "批号", "批次", "型號", "型号", "序號", "序号", "事故報告", "事故报告", "受傷報告", "受伤报告",
  ]);
  const scopeTerms = termMatches([
    "nationwide", "distributed nationwide", "distribution", "sold at", "units", "lots", "all consumers", "global", "international", "multiple countries",
    "全國", "全国", "全境", "銷售範圍", "销售范围", "流通", "販售", "销售", "批次", "所有消費者", "所有消费者", "全球", "國際", "国际", "多國", "多国",
  ]);
  const remedyTerms = termMatches([
    "refund", "repair", "replacement", "replace", "stop use", "do not use", "return", "destroy", "corrective action", "market withdrawal", "withdrawal",
    "退款", "退費", "退费", "維修", "维修", "更換", "更换", "停止使用", "請勿使用", "请勿使用", "退回", "銷毀", "销毁", "改善措施", "下架", "回收",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("product_recall_official_signal", "official recall or safety source", /recall|safety alert|market withdrawal|enforcement|cpsc|fda|nhtsa|safety gate|rasff|food standards|medsafe|official|召回|安全警示|官方/i.test(text), 6);
  addSignal("product_recall_recall_signal", "recall, withdrawal, removal, or stop-use action", /recall|withdrawal|market withdrawal|withdrawn|remove|stop use|returned to supplier|sale suspension|停止販售|停售|下架|召回|回收/i.test(text), 12);
  addSignal("product_recall_class_i_signal", "Class I, serious risk, or urgent recall", /class i|serious risk|urgent|high risk|level 1|degree i|第一級|一级|嚴重風險|严重风险/i.test(text), 16);
  addSignal("product_recall_injury_death_signal", "injury, death, hospitalization, or serious adverse event", /death|fatal|serious injury|injur|hospitali[sz]ation|life-threatening|disability|adverse event|serious adverse|死亡|重傷|重伤|受傷|受伤|住院|不良反應|不良反应/i.test(text), 18);
  addSignal("product_recall_food_allergen_pathogen_signal", "food allergen, pathogen, or contamination", /allergen|undeclared|salmonella|listeria|e\.? coli|pathogen|microbiolog|mold|mould|yeast|contamination|foreign material|glass shards|milk|peanut|sulphur dioxide|過敏|过敏|污染|沙門氏菌|沙门氏菌|李斯特|大腸桿菌|大肠杆菌|異物|异物/i.test(text), 16);
  addSignal("product_recall_fire_burn_choking_signal", "fire, burn, choking, suffocation, or laceration hazard", /fire|burn|choking|suffocation|asphyxiation|laceration|electric shock|shock|overheat|magnet|火災|火灾|燒傷|烧伤|窒息|割傷|割伤|觸電|触电|過熱|过热/i.test(text), 14);
  addSignal("product_recall_drug_device_signal", "drug, medical device, or health product context", /drug|medicine|medical device|health product|tablet|capsule|injection|sterile|vaccine|藥|药|醫療器械|医疗器械|醫療設備|医疗设备|健康產品|健康产品/i.test(text), 12);
  addSignal("product_recall_vehicle_signal", "vehicle or transport safety context", /vehicle|car|truck|model year|nhtsa|airbag|brake|steering|engine|車輛|车辆|汽車|汽车|剎車|刹车|安全氣囊|安全气囊/i.test(text), 10);
  addSignal("product_recall_import_refusal_signal", "import refusal or border detention", /import refusal|refused|detention|detained|entry refused|adulterated|misbranded|進口不合格|进口不合格|拒絕入境|拒绝入境|邊境|边境/i.test(text), 12);
  addSignal("product_recall_global_regulator_signal", "global or regional regulator coverage", /united states|canada|european union|eu|uk|australia|taiwan|japan|korea|singapore|malaysia|thailand|new zealand|fda|cpsc|nhtsa|safety gate|rasff|美國|美国|加拿大|歐盟|欧盟|英國|英国|澳洲|台灣|台湾|日本|韓國|韩国|新加坡/i.test(text), 8);
  addSignal("product_recall_evidence_language_signal", "recall number, lot, model, incident, or injury evidence language", evidenceTerms.length > 0, 10);
  addSignal("product_recall_scope_language_signal", "distribution, unit, lot, or geographic scope language", scopeTerms.length > 0, 10);
  addSignal("product_recall_remedy_language_signal", "refund, repair, return, stop-use, or withdrawal remedy language", remedyTerms.length > 0, 10);

  const semanticSignals = [
    out.product_recall_official_signal,
    out.product_recall_recall_signal,
    out.product_recall_class_i_signal,
    out.product_recall_injury_death_signal,
    out.product_recall_food_allergen_pathogen_signal,
    out.product_recall_fire_burn_choking_signal,
    out.product_recall_drug_device_signal,
    out.product_recall_vehicle_signal,
    out.product_recall_import_refusal_signal,
    out.product_recall_global_regulator_signal,
    out.product_recall_evidence_language_signal,
    out.product_recall_scope_language_signal,
    out.product_recall_remedy_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "product_recall_complete_safety_narrative_signal",
    "complete product safety recall narrative",
    semanticSignals >= 5
      && out.product_recall_recall_signal
      && (out.product_recall_injury_death_signal || out.product_recall_food_allergen_pathogen_signal || out.product_recall_fire_burn_choking_signal || out.product_recall_drug_device_signal || out.product_recall_vehicle_signal)
      && (out.product_recall_evidence_language_signal || out.product_recall_scope_language_signal)
      && out.product_recall_remedy_language_signal,
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    product_recall_risk_score: boundedScore,
    product_recall_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    product_recall_signal_count: signalFields.length,
    product_recall_semantic_signal_count: semanticSignals,
    product_recall_signal_reasons: [...new Set(reasons)].slice(0, 12),
    product_recall_evidence_terms: evidenceTerms,
    product_recall_scope_terms: scopeTerms,
    product_recall_remedy_terms: remedyTerms,
  };
}

async function insertRecallItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = productRecallDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "public_product_recall_sources",
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
      source_key: "publicProductRecallSources",
      evidence: {
        evidence_type: item.evidenceType || "public_product_recall",
        metrics: {
          ...(item.metrics || {}),
          ...productRecallRiskSignals(item),
          ...productRecallKeywordDiagnostics(item, keyword),
          product_recall_canonical_dedupe_key: dedupeKey,
          product_recall_search_scan_dedupe_key: dedupeKey,
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

export async function scrapePublicProductRecallSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = DEFAULT_PRODUCT_RECALL_TARGETS, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const maxOpenFdaPages = normalizeOpenFdaPageBudget(budget);
  const maxEuSafetyGatePages = normalizeEuSafetyGatePageBudget(budget);
  const maxNhtsaRecallPages = normalizeNhtsaRecallPageBudget(budget);
  const maxUkFsaFoodAlertPages = normalizeUkFsaFoodAlertPageBudget(budget);
  const maxThailandFdaProductRecallPages = normalizeThailandFdaProductRecallPageBudget(budget);
  const maxKoreaFoodSafetyRecallPages = normalizeKoreaFoodSafetyRecallPageBudget(budget);
  const normalizedTargets = (Array.isArray(targets) && targets.length ? targets : DEFAULT_PRODUCT_RECALL_TARGETS)
    .map(target => typeof target === "string" ? { key: target, name: target, url: target, category: "custom" } : target)
    .filter(target => target?.url);
  const tasks = normalizedKeywords.map(keyword => ({ keyword }));
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword }) => {
    let inserted = 0;
    const failures = [];
    try {
      const cpscRes = await fetchPublicSource(cpscRecallSearchUrl(keyword), {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json,text/plain,*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!cpscRes.ok) {
        failures.push({ keyword, target: "cpsc-recalls", message: httpFailure(cpscRes) });
      } else {
        const cpscItems = parseCpscRecallResults(await cpscRes.json(), keyword, {
          limit: normalizedBudget.maxItemsPerKeyword,
          since,
        });
        inserted += await insertRecallItems(cpscItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "cpsc-recalls", message });
      console.warn(`[CRM/PublicProductRecall] CPSC 抓取失敗 keyword=${keyword}: ${message}`);
    }

    for (const target of normalizedTargets) {
      try {
        const isOpenFdaAdverseTarget = target.kind === "openfda_drug_adverse_events" || target.kind === "openfda_device_adverse_events" || target.kind === "openfda_tobacco_problem_reports" || target.key === "openfda_drug_adverse_events" || target.key === "openfda_device_adverse_events" || target.key === "openfda_tobacco_problem_reports";
        const isOpenFdaRecallTarget = OPENFDA_TARGETS.some(item => item.key === target.key) || target.url === OPENFDA_FOOD_ENFORCEMENT_URL || target.url === OPENFDA_DRUG_ENFORCEMENT_URL || target.url === OPENFDA_DEVICE_ENFORCEMENT_URL;
        const isEuSafetyGateTarget = target.kind === "eu_safety_gate_rapex" || target.key === "eu_safety_gate_rapex";
        const isNhtsaRecallTarget = target.kind === "nhtsa_recalls_by_manufacturer" || target.key === "nhtsa_recalls_by_manufacturer";
        const isUkFsaFoodAlertTarget = target.kind === "uk_fsa_food_alerts_search_api" || target.key === "uk_fsa_food_alerts";
        const isThailandFdaProductRecallTarget = target.kind === "thailand_fda_product_recalls_rss" || target.key === "thailand_fda_product_recalls";
        const isKoreaFoodSafetyRecallTarget = target.kind === "korea_food_safety_recalls_json" || target.key === "korea_food_safety_recalls";
        const complaintCandidates = target.kind === "nhtsa_vehicle_complaints" || target.key === "nhtsa_vehicle_complaints"
          ? vehicleComplaintCandidatesFromKeyword(keyword)
          : [];
        const urls = target.kind === "nhtsa_vehicle_complaints" || target.key === "nhtsa_vehicle_complaints"
          ? complaintCandidates.map(candidate => ({ url: nhtsaComplaintSearchUrl(candidate), candidate }))
          : isOpenFdaAdverseTarget
            ? Array.from({ length: maxOpenFdaPages }, (_, page) => {
              const skip = page * normalizedBudget.maxItemsPerKeyword;
              return {
                url: openFdaAdverseEventSearchUrl(target, keyword, { limit: normalizedBudget.maxItemsPerKeyword, skip }),
                candidate: { page: page + 1, skip, openFda: true },
              };
            })
          : isOpenFdaRecallTarget
            ? Array.from({ length: maxOpenFdaPages }, (_, page) => {
              const skip = page * normalizedBudget.maxItemsPerKeyword;
              return {
                url: openFdaSearchUrl(target, keyword, { limit: normalizedBudget.maxItemsPerKeyword, skip }),
                candidate: { page: page + 1, skip, openFda: true },
              };
            })
          : isEuSafetyGateTarget
            ? Array.from({ length: maxEuSafetyGatePages }, (_, page) => {
              const start = page * normalizedBudget.maxItemsPerKeyword;
              return {
                url: euSafetyGateSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, start }),
                candidate: { page: page + 1, start, euSafetyGate: true },
              };
            })
          : isNhtsaRecallTarget
            ? Array.from({ length: maxNhtsaRecallPages }, (_, page) => {
              const offset = page * normalizedBudget.maxItemsPerKeyword;
              return {
                url: nhtsaRecallSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, offset }),
                candidate: { page: page + 1, offset, nhtsaRecall: true },
              };
            })
          : isKoreaFoodSafetyRecallTarget
            ? ["01", "02", "03"].flatMap(searchType => Array.from({ length: maxKoreaFoodSafetyRecallPages }, (_, page) => {
              const startIndex = page * normalizedBudget.maxItemsPerKeyword + 1;
              return {
                url: target.url,
                candidate: { page: page + 1, searchType, startIndex, koreaFoodSafetyRecall: true },
                method: "POST",
                body: koreaFoodSafetyRecallSearchBody(keyword, {
                  searchType,
                  limit: normalizedBudget.maxItemsPerKeyword,
                  startIndex,
                }),
              };
            }))
          : target.kind === "new_zealand_medsafe_mord_html" || target.key === "new_zealand_medsafe_mord"
            ? [{
              url: target.url,
              candidate: null,
              method: "POST",
              body: medsafeMordSearchBody(keyword, { since }),
              skipAjaxHeader: true,
            }]
          : isUkFsaFoodAlertTarget
            ? Array.from({ length: maxUkFsaFoodAlertPages }, (_, index) => ({
              url: ukFsaFoodAlertsSearchUrl(keyword, { page: index + 1 }),
              candidate: { page: index + 1, ukFsaFoodAlert: true },
            }))
          : isThailandFdaProductRecallTarget
            ? Array.from({ length: maxThailandFdaProductRecallPages }, (_, index) => ({
              url: thailandFdaProductRecallRssUrl({ page: index + 1, perPage: normalizedBudget.maxItemsPerKeyword }),
              candidate: { page: index + 1, thailandFdaProductRecall: true },
            }))
          : [{
            url: target.kind === "eu_safety_gate_rapex" || target.key === "eu_safety_gate_rapex"
              ? euSafetyGateSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword })
                : target.kind === "nhtsa_recalls_by_manufacturer" || target.key === "nhtsa_recalls_by_manufacturer"
                  ? nhtsaRecallSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword })
                : target.kind === "fda_import_refusals_zip" || target.key === "fda_import_refusals"
                  ? target.url
                : target.kind === "cdc_food_safety_rss" || target.key === "cdc_food_safety_rss"
                  ? target.url
                : target.kind === "fda_recalls_market_withdrawals_html" || target.key === "fda_recalls_market_withdrawals"
                  ? fdaRecallAlertsSearchUrl(keyword)
                : target.kind === "product_safety_australia_rss" || target.key === "product_safety_australia_recalls"
                  ? target.url
                : target.kind === "uk_product_safety_atom" || target.key === "uk_product_safety_alerts"
                  ? target.url
                : target.kind === "uk_fsa_food_alerts_search_api" || target.key === "uk_fsa_food_alerts"
                  ? ukFsaFoodAlertsSearchUrl(keyword)
                : isCanadaRecallTarget(target)
                  ? target.url
                : target.kind === "fssai_food_safety_advisories_html" || target.key === "fssai_food_safety_advisories"
                  ? target.url
                : target.kind === "hk_cfs_food_alerts_rss" || target.key === "hk_cfs_food_alerts"
                  ? target.url
                : target.kind === "taiwan_fda_drug_recalls_json" || target.key === "taiwan_fda_drug_recalls"
                  ? target.url
                : target.kind === "taiwan_fda_noncompliant_food_imports_json" || target.key === "taiwan_fda_noncompliant_food_imports"
                  ? target.url
                : target.kind === "new_zealand_product_safety_recalls_html" || target.key === "new_zealand_product_safety_recalls"
                  ? target.url
                : target.kind === "new_zealand_medsafe_mord_html" || target.key === "new_zealand_medsafe_mord"
                  ? target.url
                : target.kind === "fsanz_food_recalls_rss" || target.key === "fsanz_food_recalls"
                  ? target.url
                : target.kind === "eu_rasff_consumer_rss" || target.key === "eu_rasff_consumer_notifications"
                  ? target.url
                : target.kind === "japan_caa_recalls_html" || target.key === "japan_caa_recalls"
                  ? target.url
                : target.kind === "korea_safety_recalls_html" || target.key === "korea_safety_recalls"
                  ? target.url
                : isKoreaFoodSafetyRecallTarget
                  ? target.url
                : target.kind === "singapore_sfa_food_alerts_rss" || target.key === "singapore_sfa_food_alerts"
                  ? target.url
                : target.kind === "malaysia_npra_product_recalls_html" || target.key === "malaysia_npra_product_recalls"
                  ? target.url
                : target.kind === "malaysia_mda_device_recalls_rss" || target.key === "malaysia_mda_device_recalls"
                  ? target.url
                : isThailandFdaProductRecallTarget
                  ? target.url
                : isOpenFdaAdverseTarget
                  ? openFdaAdverseEventSearchUrl(target, keyword, { limit: normalizedBudget.maxItemsPerKeyword })
                  : openFdaSearchUrl(target, keyword, { limit: normalizedBudget.maxItemsPerKeyword }),
            candidate: null,
        }];
        if (!urls.length) continue;
        for (const request of urls) {
          const accept = target.kind === "fda_import_refusals_zip" || target.key === "fda_import_refusals"
            ? "application/zip,application/octet-stream,text/plain,*/*"
            : target.kind === "cdc_food_safety_rss" || target.key === "cdc_food_safety_rss" || target.kind === "product_safety_australia_rss" || target.key === "product_safety_australia_recalls" || target.kind === "uk_product_safety_atom" || target.key === "uk_product_safety_alerts" || isCanadaRecallTarget(target) || target.kind === "hk_cfs_food_alerts_rss" || target.key === "hk_cfs_food_alerts" || target.kind === "fsanz_food_recalls_rss" || target.key === "fsanz_food_recalls" || target.kind === "eu_rasff_consumer_rss" || target.key === "eu_rasff_consumer_notifications" || target.kind === "singapore_sfa_food_alerts_rss" || target.key === "singapore_sfa_food_alerts" || target.kind === "malaysia_mda_device_recalls_rss" || target.key === "malaysia_mda_device_recalls" || target.kind === "thailand_fda_product_recalls_rss" || target.key === "thailand_fda_product_recalls"
              ? "application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain,*/*"
            : target.kind === "fda_recalls_market_withdrawals_html" || target.key === "fda_recalls_market_withdrawals" || target.kind === "fssai_food_safety_advisories_html" || target.key === "fssai_food_safety_advisories" || target.kind === "new_zealand_product_safety_recalls_html" || target.key === "new_zealand_product_safety_recalls" || target.kind === "new_zealand_medsafe_mord_html" || target.key === "new_zealand_medsafe_mord" || target.kind === "japan_caa_recalls_html" || target.key === "japan_caa_recalls" || target.kind === "korea_safety_recalls_html" || target.key === "korea_safety_recalls" || target.kind === "malaysia_npra_product_recalls_html" || target.key === "malaysia_npra_product_recalls"
                ? "text/html,application/xhtml+xml,*/*"
                : "application/json,text/plain,*/*";
          const headers = { "User-Agent": USER_AGENT, "Accept": accept };
          if (request.method === "POST") {
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
            if (!request.skipAjaxHeader) headers["X-Requested-With"] = "XMLHttpRequest";
          }
          const res = await fetchPublicSource(request.url, {
            method: request.method || "GET",
            headers,
            body: request.body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          let fallbackText = "";
          if (!res.ok) {
            if (isCanadaRecallTarget(target) && !proxyUrl && [403, 406].includes(Number(res.status))) {
              try {
                fallbackText = await fetchTextWithCurlFallback(request.url);
              } catch (fallbackErr) {
                failures.push({ keyword, target: target.key || target.url, message: `${httpFailure(res)}; curl fallback failed: ${formatSourceError(fallbackErr, proxyUrl)}` });
                continue;
              }
            } else {
              failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
              continue;
            }
          }
          let payload;
          if (target.kind === "fda_import_refusals_zip" || target.key === "fda_import_refusals") {
            if (fdaImportRefusalArchiveCache.has(request.url)) payload = fdaImportRefusalArchiveCache.get(request.url);
            else {
              payload = parseFdaImportRefusalArchive(await res.arrayBuffer());
              fdaImportRefusalArchiveCache.set(request.url, payload);
            }
          } else if (target.kind === "cdc_food_safety_rss" || target.key === "cdc_food_safety_rss") {
            payload = await res.text();
          } else if (target.kind === "fda_recalls_market_withdrawals_html" || target.key === "fda_recalls_market_withdrawals") {
            payload = await res.text();
          } else if (target.kind === "product_safety_australia_rss" || target.key === "product_safety_australia_recalls") {
            payload = await res.text();
          } else if (target.kind === "uk_product_safety_atom" || target.key === "uk_product_safety_alerts") {
            payload = await res.text();
          } else if (target.kind === "uk_fsa_food_alerts_search_api" || target.key === "uk_fsa_food_alerts") {
            payload = await res.json();
          } else if (isCanadaRecallTarget(target)) {
            payload = fallbackText || await res.text();
          } else if (target.kind === "fssai_food_safety_advisories_html" || target.key === "fssai_food_safety_advisories") {
            payload = await res.text();
          } else if (target.kind === "hk_cfs_food_alerts_rss" || target.key === "hk_cfs_food_alerts") {
            payload = await res.text();
          } else if (target.kind === "new_zealand_product_safety_recalls_html" || target.key === "new_zealand_product_safety_recalls") {
            payload = await res.text();
          } else if (target.kind === "new_zealand_medsafe_mord_html" || target.key === "new_zealand_medsafe_mord") {
            payload = await res.text();
          } else if (target.kind === "fsanz_food_recalls_rss" || target.key === "fsanz_food_recalls") {
            payload = await res.text();
          } else if (target.kind === "eu_rasff_consumer_rss" || target.key === "eu_rasff_consumer_notifications") {
            payload = await res.text();
          } else if (target.kind === "japan_caa_recalls_html" || target.key === "japan_caa_recalls") {
            payload = await res.text();
          } else if (target.kind === "korea_safety_recalls_html" || target.key === "korea_safety_recalls") {
            payload = await res.text();
          } else if (target.kind === "korea_food_safety_recalls_json" || target.key === "korea_food_safety_recalls") {
            payload = await res.json();
          } else if (target.kind === "singapore_sfa_food_alerts_rss" || target.key === "singapore_sfa_food_alerts") {
            payload = await res.text();
          } else if (target.kind === "malaysia_npra_product_recalls_html" || target.key === "malaysia_npra_product_recalls") {
            payload = await res.text();
          } else if (target.kind === "malaysia_mda_device_recalls_rss" || target.key === "malaysia_mda_device_recalls") {
            payload = await res.text();
          } else if (target.kind === "thailand_fda_product_recalls_rss" || target.key === "thailand_fda_product_recalls") {
            payload = await res.text();
          } else {
            payload = await res.json();
          }
          const openFdaRawResultCount = request.candidate?.openFda ? countOpenFdaRawResults(payload) : 0;
          const euSafetyGateRawResultCount = request.candidate?.euSafetyGate ? countEuSafetyGateRawResults(payload) : 0;
          const nhtsaRecallRawResultCount = request.candidate?.nhtsaRecall ? countNhtsaRecallRawResults(payload) : 0;
          const ukFsaFoodAlertRawResultCount = request.candidate?.ukFsaFoodAlert ? countUkFsaFoodAlertRawResults(payload) : 0;
          const thailandFdaProductRecallRawResultCount = request.candidate?.thailandFdaProductRecall ? countRssItems(payload) : 0;
          const koreaFoodSafetyRecallRawResultCount = request.candidate?.koreaFoodSafetyRecall ? countKoreaFoodSafetyRecallRawResults(payload) : 0;
          let items = isEuSafetyGateTarget
            ? parseEuSafetyGateRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
            : isNhtsaRecallTarget
              ? parseNhtsaRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
              : target.kind === "nhtsa_vehicle_complaints" || target.key === "nhtsa_vehicle_complaints"
                ? parseNhtsaComplaintResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "fda_import_refusals_zip" || target.key === "fda_import_refusals"
                  ? parseFdaImportRefusalResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "cdc_food_safety_rss" || target.key === "cdc_food_safety_rss"
                  ? parseCdcFoodSafetyAlertResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "fda_recalls_market_withdrawals_html" || target.key === "fda_recalls_market_withdrawals"
                  ? parseFdaRecallAlertResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "product_safety_australia_rss" || target.key === "product_safety_australia_recalls"
                  ? parseProductSafetyAustraliaRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "uk_product_safety_atom" || target.key === "uk_product_safety_alerts"
                  ? parseUkProductSafetyAlertResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : isUkFsaFoodAlertTarget
                  ? parseUkFsaFoodAlertResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : isCanadaRecallTarget(target)
                  ? parseCanadaRecallResults(payload, keyword, { target, limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "fssai_food_safety_advisories_html" || target.key === "fssai_food_safety_advisories"
                  ? parseFssaiAdvisoryResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "hk_cfs_food_alerts_rss" || target.key === "hk_cfs_food_alerts"
                  ? parseHkCfsFoodAlertResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "taiwan_fda_drug_recalls_json" || target.key === "taiwan_fda_drug_recalls"
                  ? parseTaiwanFdaDrugRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "taiwan_fda_noncompliant_food_imports_json" || target.key === "taiwan_fda_noncompliant_food_imports"
                  ? parseTaiwanFdaNoncompliantFoodImportResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "new_zealand_product_safety_recalls_html" || target.key === "new_zealand_product_safety_recalls"
                  ? parseNewZealandProductSafetyRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "new_zealand_medsafe_mord_html" || target.key === "new_zealand_medsafe_mord"
                  ? parseMedsafeMordResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "fsanz_food_recalls_rss" || target.key === "fsanz_food_recalls"
                  ? parseFsanzFoodRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "eu_rasff_consumer_rss" || target.key === "eu_rasff_consumer_notifications"
                  ? parseEuRasffConsumerResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "japan_caa_recalls_html" || target.key === "japan_caa_recalls"
                  ? parseJapanCaaRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "korea_safety_recalls_html" || target.key === "korea_safety_recalls"
                  ? parseKoreaSafetyRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : isKoreaFoodSafetyRecallTarget
                  ? parseKoreaFoodSafetyRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "singapore_sfa_food_alerts_rss" || target.key === "singapore_sfa_food_alerts"
                  ? parseSingaporeSfaFoodAlertResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "malaysia_npra_product_recalls_html" || target.key === "malaysia_npra_product_recalls"
                  ? parseMalaysiaNpraProductRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : target.kind === "malaysia_mda_device_recalls_rss" || target.key === "malaysia_mda_device_recalls"
                  ? parseMalaysiaMdaDeviceRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : isThailandFdaProductRecallTarget
                  ? parseThailandFdaProductRecallResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since })
                : isOpenFdaAdverseTarget
                  ? parseOpenFdaAdverseEventResults(payload, keyword, { target, limit: normalizedBudget.maxItemsPerKeyword, since })
                  : parseOpenFdaRecallResults(payload, keyword, { target, limit: normalizedBudget.maxItemsPerKeyword, since });
          if (request.candidate?.openFda) {
            items = items.map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                openfda_search_page: request.candidate.page,
                openfda_search_skip: request.candidate.skip,
                openfda_search_raw_result_count: openFdaRawResultCount,
              },
            }));
          }
          if (request.candidate?.euSafetyGate) {
            items = items.map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                eu_safety_gate_search_page: request.candidate.page,
                eu_safety_gate_search_start: request.candidate.start,
                eu_safety_gate_search_raw_result_count: euSafetyGateRawResultCount,
              },
            }));
          }
          if (request.candidate?.nhtsaRecall) {
            items = items.map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                nhtsa_recall_search_page: request.candidate.page,
                nhtsa_recall_search_offset: request.candidate.offset,
                nhtsa_recall_search_raw_result_count: nhtsaRecallRawResultCount,
              },
            }));
          }
          if (request.candidate?.ukFsaFoodAlert) {
            items = items.map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                uk_fsa_food_alert_search_page: request.candidate.page,
                uk_fsa_food_alert_search_raw_result_count: ukFsaFoodAlertRawResultCount,
              },
            }));
          }
          if (request.candidate?.thailandFdaProductRecall) {
            items = items.map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                thailand_fda_recall_search_page: request.candidate.page,
                thailand_fda_recall_search_raw_result_count: thailandFdaProductRecallRawResultCount,
              },
            }));
          }
          if (request.candidate?.koreaFoodSafetyRecall) {
            items = items.map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                korea_food_safety_search_type: request.candidate.searchType,
                korea_food_safety_search_page: request.candidate.page,
                korea_food_safety_search_start_index: request.candidate.startIndex,
                korea_food_safety_search_raw_result_count: koreaFoodSafetyRecallRawResultCount,
              },
            }));
          }
          if (target.kind === "new_zealand_medsafe_mord_html" || target.key === "new_zealand_medsafe_mord") {
            items = await enrichMedsafeMordItems(items, { proxyUrl, failures, keyword });
          }
          inserted += await insertRecallItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (request.candidate?.openFda && openFdaRawResultCount < normalizedBudget.maxItemsPerKeyword) break;
          if (request.candidate?.euSafetyGate && euSafetyGateRawResultCount < normalizedBudget.maxItemsPerKeyword) break;
          if (request.candidate?.nhtsaRecall && nhtsaRecallRawResultCount < normalizedBudget.maxItemsPerKeyword) break;
          if (request.candidate?.ukFsaFoodAlert && ukFsaFoodAlertRawResultCount < normalizedBudget.maxItemsPerKeyword) break;
          if (request.candidate?.thailandFdaProductRecall && thailandFdaProductRecallRawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, target: target?.key || "openfda", message });
        console.warn(`[CRM/PublicProductRecall] openFDA 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  CPSC_RECALLS_API_URL,
  OPENFDA_FOOD_ENFORCEMENT_URL,
  OPENFDA_DRUG_ENFORCEMENT_URL,
  OPENFDA_DEVICE_ENFORCEMENT_URL,
  OPENFDA_DRUG_EVENT_URL,
  OPENFDA_DEVICE_EVENT_URL,
  OPENFDA_TOBACCO_PROBLEM_URL,
  NHTSA_RECALLS_BY_MANUFACTURER_URL,
  NHTSA_VEHICLE_COMPLAINTS_URL,
  FDA_IMPORT_REFUSALS_ZIP_URL,
  CDC_FOOD_SAFETY_RSS_URL,
  FDA_RECALLS_MARKET_WITHDRAWALS_URL,
  PRODUCT_SAFETY_AUSTRALIA_RECALLS_RSS_URL,
  UK_PRODUCT_SAFETY_ALERTS_ATOM_URL,
  UK_FSA_FOOD_ALERTS_SEARCH_API_URL,
  CANADA_CONSUMER_PRODUCT_RECALLS_RSS_URL,
  CANADA_HEALTH_PRODUCT_RECALLS_RSS_URL,
  CANADA_MEDICAL_DEVICE_RECALLS_RSS_URL,
  CANADA_FOOD_RECALLS_RSS_URL,
  FSSAI_ADVISORIES_URL,
  HK_CFS_FOOD_ALERTS_RSS_URL,
  TAIWAN_FDA_DRUG_RECALLS_JSON_URL,
  TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_JSON_URL,
  NEW_ZEALAND_PRODUCT_SAFETY_RECALLS_URL,
  NEW_ZEALAND_MEDSAFE_MORD_URL,
  FSANZ_FOOD_RECALLS_RSS_URL,
  EU_RASFF_CONSUMER_RSS_URL,
  JAPAN_CAA_RECALLS_URL,
  KOREA_SAFETY_RECALLS_URL,
  KOREA_FOOD_SAFETY_RECALLS_URL,
  SINGAPORE_SFA_FOOD_ALERTS_RSS_URL,
  MALAYSIA_NPRA_PRODUCT_RECALLS_URL,
  MALAYSIA_MDA_DEVICE_RECALLS_RSS_URL,
  THAILAND_FDA_PRODUCT_RECALLS_RSS_URL,
  DEFAULT_MAX_EU_SAFETY_GATE_PAGES,
  DEFAULT_MAX_NHTSA_RECALL_PAGES,
  DEFAULT_MAX_UK_FSA_FOOD_ALERT_PAGES,
  DEFAULT_MAX_THAILAND_FDA_RECALL_PAGES,
  DEFAULT_MAX_KOREA_FOOD_SAFETY_RECALL_PAGES,
  OPENFDA_TARGETS,
  OPENFDA_ADVERSE_EVENT_TARGETS,
  EU_SAFETY_GATE_RAPEX_URL,
  EU_SAFETY_GATE_TARGET,
  NHTSA_RECALLS_TARGET,
  NHTSA_VEHICLE_COMPLAINTS_TARGET,
  FDA_IMPORT_REFUSALS_TARGET,
  CDC_FOOD_SAFETY_TARGET,
  FDA_RECALLS_MARKET_WITHDRAWALS_TARGET,
  PRODUCT_SAFETY_AUSTRALIA_TARGET,
  UK_PRODUCT_SAFETY_TARGET,
  UK_FSA_FOOD_ALERTS_TARGET,
  CANADA_CONSUMER_PRODUCT_RECALLS_TARGET,
  CANADA_HEALTH_PRODUCT_RECALLS_TARGET,
  CANADA_MEDICAL_DEVICE_RECALLS_TARGET,
  CANADA_FOOD_RECALLS_TARGET,
  FSSAI_ADVISORIES_TARGET,
  HK_CFS_FOOD_ALERTS_TARGET,
  TAIWAN_FDA_DRUG_RECALLS_TARGET,
  TAIWAN_FDA_NONCOMPLIANT_FOOD_IMPORTS_TARGET,
  NEW_ZEALAND_PRODUCT_SAFETY_RECALLS_TARGET,
  NEW_ZEALAND_MEDSAFE_MORD_TARGET,
  FSANZ_FOOD_RECALLS_TARGET,
  EU_RASFF_CONSUMER_TARGET,
  JAPAN_CAA_RECALLS_TARGET,
  KOREA_SAFETY_RECALLS_TARGET,
  KOREA_FOOD_SAFETY_RECALLS_TARGET,
  SINGAPORE_SFA_FOOD_ALERTS_TARGET,
  MALAYSIA_NPRA_PRODUCT_RECALLS_TARGET,
  MALAYSIA_MDA_DEVICE_RECALLS_TARGET,
  THAILAND_FDA_PRODUCT_RECALLS_TARGET,
  DEFAULT_PRODUCT_RECALL_TARGETS,
  normalizeProductRecallKeywordText,
  textMatchesKeyword,
  normalizeBudget,
  normalizeOpenFdaPageBudget,
  normalizeEuSafetyGatePageBudget,
  normalizeNhtsaRecallPageBudget,
  normalizeUkFsaFoodAlertPageBudget,
  normalizeThailandFdaProductRecallPageBudget,
  normalizeKoreaFoodSafetyRecallPageBudget,
  normalizeMdyDate,
  normalizeProductRecallDedupeUrl,
  productRecallDedupeKey,
  productRecallKeywordMatchSource,
  productRecallKeywordDiagnostics,
  productRecallRiskSignals,
  cpscRecallSearchUrl,
  openFdaSearchUrl,
  openFdaAdverseEventSearchUrl,
  euSafetyGateSearchUrl,
  nhtsaRecallSearchUrl,
  vehicleComplaintCandidatesFromKeyword,
  nhtsaComplaintSearchUrl,
  fdaRecallAlertsSearchUrl,
  ukFsaFoodAlertsSearchUrl,
  thailandFdaProductRecallRssUrl,
  recallRiskLevel,
  fdaImportRefusalRiskLevel,
  adverseEventRiskLevel,
  unzipTextFiles,
  parseCsvRows,
  parseFdaImportRefusalArchive,
  parseFdaImportRefusalResults,
  rssItems,
  parseCdcFoodSafetyAlertResults,
  parseFdaRecallAlertResults,
  parseProductSafetyAustraliaRecallResults,
  atomItems,
  parseUkProductSafetyAlertResults,
  ukFsaFoodAlertRiskLevel,
  parseUkFsaFoodAlertResults,
  parseCanadaRecallResults,
  parseCanadaConsumerProductRecallResults,
  fssaiAdvisoryRiskLevel,
  parseFssaiAdvisoryResults,
  hkCfsFoodAlertRiskLevel,
  parseHkCfsFoodAlertResults,
  taiwanFdaDrugRecallRiskLevel,
  taiwanFdaFoodImportRiskLevel,
  parseTaiwanFdaDrugRecallResults,
  parseTaiwanFdaNoncompliantFoodImportResults,
  newZealandProductSafetyRiskLevel,
  parseNewZealandProductSafetyRecallResults,
  medsafeMordSearchBody,
  medsafeMordRiskLevel,
  parseMedsafeMordDetail,
  parseMedsafeMordResults,
  fsanzFoodRecallRiskLevel,
  parseFsanzFoodRecallResults,
  euRasffConsumerRiskLevel,
  parseEuRasffConsumerResults,
  japanCaaRecallRiskLevel,
  parseJapanCaaRecallResults,
  koreaSafetyRecallRiskLevel,
  parseKoreaSafetyRecallResults,
  koreaFoodSafetyRecallSearchBody,
  koreaFoodSafetyRecallRiskLevel,
  parseKoreaFoodSafetyRecallResults,
  singaporeSfaFoodAlertRiskLevel,
  parseSingaporeSfaFoodAlertResults,
  malaysiaNpraProductRecallRiskLevel,
  parseMalaysiaNpraProductRecallResults,
  malaysiaMdaDeviceRecallRiskLevel,
  parseMalaysiaMdaDeviceRecallResults,
  thailandFdaProductRecallRiskLevel,
  parseThailandFdaProductRecallResults,
  clearFdaImportRefusalArchiveCache,
  parseCpscRecallResults,
  countOpenFdaRawResults,
  countEuSafetyGateRawResults,
  countNhtsaRecallRawResults,
  countUkFsaFoodAlertRawResults,
  countRssItems,
  countKoreaFoodSafetyRecallRawResults,
  parseOpenFdaRecallResults,
  parseOpenFdaAdverseEventResults,
  parseEuSafetyGateRecallResults,
  parseNhtsaRecallResults,
  parseNhtsaComplaintResults,
};
